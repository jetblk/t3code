/**
 * GrokUsage — account-level subscription usage through Grok Build's ACP
 * billing extension. Authentication and token refresh remain owned by the
 * Grok CLI; T3 never reads or writes `~/.grok/auth.json`.
 *
 * @module provider/Layers/GrokUsage
 */
import type {
  GrokSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderUsageCredits,
  ProviderUsageSnapshot,
  ProviderUsageWindow,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { makeGrokAcpRuntime } from "../acp/GrokAcpSupport.ts";
import type { ProviderUsageShape } from "../Services/ProviderUsage.ts";

const GROK_BILLING_METHOD = "x.ai/billing";
const GROK_USAGE_TIMEOUT = Duration.seconds(15);
const WEEK_MINUTES = 7 * 24 * 60;

export interface GrokUsageMeta {
  readonly instanceId: ProviderInstanceId;
  readonly driverKind: ProviderDriverKind;
  readonly displayName: string | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, ...keys: ReadonlyArray<string>) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (!isRecord(value)) return undefined;
  const nested = value["val"];
  return typeof nested === "number" && Number.isFinite(nested) ? nested : undefined;
}

function normalizedIso(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return DateTime.make(value).pipe(
    Option.match({
      onNone: () => undefined,
      onSome: DateTime.formatIso,
    }),
  );
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function formatOpaqueNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(2)));
}

function formatPlanLabel(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value
    .split(/[\s_-]+/g)
    .filter((part) => part.length > 0)
    .map((part) =>
      part.toLowerCase() === "supergrok"
        ? "SuperGrok"
        : part[0]!.toUpperCase() + part.slice(1).toLowerCase(),
    )
    .join(" ");
}

/** Map the proto-JSON payload returned by Grok's `x.ai/billing` extension. */
export function mapGrokBillingResponse(raw: unknown): {
  readonly recognized: boolean;
  readonly windows: ReadonlyArray<ProviderUsageWindow>;
  readonly credits: ProviderUsageCredits | undefined;
  readonly planLabel: string | undefined;
} {
  if (!isRecord(raw)) {
    return { recognized: false, windows: [], credits: undefined, planLabel: undefined };
  }
  const config = isRecord(raw["config"]) ? raw["config"] : raw;
  const recognized =
    "currentPeriod" in config ||
    "current_period" in config ||
    "creditUsagePercent" in config ||
    "credit_usage_percent" in config ||
    "onDemandCap" in config ||
    "on_demand_cap" in config;
  if (!recognized) {
    return { recognized: false, windows: [], credits: undefined, planLabel: undefined };
  }

  const windows: Array<ProviderUsageWindow> = [];
  const periodValue = config["currentPeriod"] ?? config["current_period"];
  const period = isRecord(periodValue) ? periodValue : undefined;
  const periodType = period ? stringField(period, "type") : undefined;
  const periodStart = period ? normalizedIso(period["start"]) : undefined;
  const periodEnd = period ? normalizedIso(period["end"]) : undefined;
  const percentValue = config["creditUsagePercent"] ?? config["credit_usage_percent"];
  const usedPercent = percentValue === undefined ? 0 : numberValue(percentValue);
  if (
    periodType === "USAGE_PERIOD_TYPE_WEEKLY" &&
    periodStart &&
    periodEnd &&
    Date.parse(periodEnd) > Date.parse(periodStart) &&
    usedPercent !== undefined
  ) {
    windows.push({
      id: "weekly",
      label: "Weekly",
      kind: "weekly",
      usedPercent: clampPercent(usedPercent),
      resetsAt: periodEnd,
      windowMinutes: WEEK_MINUTES,
    });
  }

  const cap = numberValue(config["onDemandCap"] ?? config["on_demand_cap"]) ?? 0;
  const credits: ProviderUsageCredits = {
    label: "Extra usage",
    balance: cap > 0 ? `${formatOpaqueNumber(cap)} cap` : "Disabled",
  };
  const planLabel = formatPlanLabel(
    stringField(config, "subscriptionTier", "subscription_tier", "planName", "plan_name") ??
      stringField(raw, "subscriptionTier", "subscription_tier", "planName", "plan_name"),
  );

  return { recognized: true, windows, credits, planLabel };
}

function grokFailureStatus(message: string): "unauthenticated" | "unsupported" | "error" {
  const normalized = message.toLowerCase();
  if (
    normalized.includes("authentication required") ||
    normalized.includes("unauthenticated") ||
    normalized.includes("not logged in") ||
    normalized.includes("grok login")
  ) {
    return "unauthenticated";
  }
  if (
    normalized.includes("method not found") ||
    normalized.includes("unknown method") ||
    normalized.includes("unsupported method")
  ) {
    return "unsupported";
  }
  return "error";
}

/** Build one Grok usage capability with all process services captured. */
export const makeGrokUsage = Effect.fn("makeGrokUsage")(function* (
  config: Pick<GrokSettings, "binaryPath">,
  meta: GrokUsageMeta,
  environment: NodeJS.ProcessEnv,
  cwd: string,
): Effect.fn.Return<
  ProviderUsageShape,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
> {
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const crypto = yield* Crypto.Crypto;

  const fetchUsage = Effect.gen(function* () {
    const fetchedAt = DateTime.formatIso(yield* DateTime.now);
    const base = {
      instanceId: meta.instanceId,
      driver: meta.driverKind,
      ...(meta.displayName ? { displayName: meta.displayName } : {}),
      windows: [],
      fetchedAt,
    } satisfies Partial<ProviderUsageSnapshot> & { windows: ReadonlyArray<ProviderUsageWindow> };
    const failed = (
      status: "unauthenticated" | "unsupported" | "error",
      message: string,
    ): ProviderUsageSnapshot => ({ ...base, status, message });

    const result = yield* Effect.gen(function* () {
      const acp = yield* makeGrokAcpRuntime({
        grokSettings: config,
        environment,
        childProcessSpawner,
        cwd,
        clientInfo: { name: "t3-code-usage", version: "0.0.0" },
      });
      yield* acp.start();
      return yield* acp.request(GROK_BILLING_METHOD, {});
    }).pipe(
      Effect.scoped,
      Effect.provideService(Crypto.Crypto, crypto),
      Effect.timeoutOption(GROK_USAGE_TIMEOUT),
      Effect.result,
    );

    if (Result.isFailure(result)) {
      const error = result.failure;
      const message = error instanceof Error ? error.message : String(error);
      const status = grokFailureStatus(message);
      return failed(
        status,
        status === "unauthenticated"
          ? "Run `grok login` on the server machine."
          : status === "unsupported"
            ? "This Grok CLI does not expose billing usage. Update Grok and try again."
            : `Grok usage probe failed: ${message}`,
      );
    }
    if (Option.isNone(result.success)) {
      return failed("error", "Grok usage probe timed out.");
    }

    const mapped = mapGrokBillingResponse(result.success.value);
    if (!mapped.recognized) {
      return failed("error", "Grok billing response changed or contained no usage data.");
    }
    return {
      ...base,
      status: "ok",
      ...(mapped.planLabel ? { planLabel: mapped.planLabel } : {}),
      windows: mapped.windows,
      ...(mapped.credits ? { credits: mapped.credits } : {}),
    } satisfies ProviderUsageSnapshot;
  }).pipe(
    Effect.catchDefect((defect: unknown) =>
      Effect.map(DateTime.now, (now) => ({
        instanceId: meta.instanceId,
        driver: meta.driverKind,
        ...(meta.displayName ? { displayName: meta.displayName } : {}),
        status: "error" as const,
        windows: [],
        message: `Grok usage fetch crashed: ${String(defect)}`,
        fetchedAt: DateTime.formatIso(now),
      })),
    ),
  );

  return { fetchUsage } satisfies ProviderUsageShape;
});
