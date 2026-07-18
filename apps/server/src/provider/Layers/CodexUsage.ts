/**
 * CodexUsage — account-level subscription usage for the Codex driver.
 *
 * Spawns a short-lived `codex app-server` (the same probe pattern as
 * `CodexProvider`) and asks it for `account/rateLimits/read`. Auth and token
 * refresh stay entirely inside the codex CLI — this module never touches
 * `auth.json`, which avoids racing the CLI's own token rotation.
 *
 * @module provider/Layers/CodexUsage
 */
import type {
  CodexSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderUsageCredits,
  ProviderUsageResetCredits,
  ProviderUsageSnapshot,
  ProviderUsageWindow,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as CodexClient from "effect-codex-app-server/client";
import type * as CodexSchema from "effect-codex-app-server/schema";

import { resolveSpawnCommand } from "@t3tools/shared/shell";
import { expandHomePath } from "../../pathExpansion.ts";
import type { ProviderUsageShape } from "../Services/ProviderUsage.ts";
import { buildCodexInitializeParams } from "./CodexProvider.ts";

const CODEX_USAGE_TIMEOUT = Duration.seconds(15);
const CODEX_USAGE_FORCE_KILL_AFTER = "2 seconds" as const;
const WEEK_MINUTES = 7 * 24 * 60;
const SESSION_WINDOW_MINUTES = 5 * 60;

const LOGIN_MESSAGE = "Run `codex login` on the server machine.";

export interface CodexUsageMeta {
  readonly instanceId: ProviderInstanceId;
  readonly driverKind: ProviderDriverKind;
  readonly displayName: string | undefined;
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function toTitleCaseWords(value: string): string {
  return value
    .split(/[\s_-]+/g)
    .filter((part) => part.length > 0)
    .map((part) => part[0]!.toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

/**
 * `resetsAt` is an int64 epoch with an unspecified unit; treat values large
 * enough to only make sense as milliseconds as milliseconds and everything
 * else as seconds (10^12 ms ≈ 2001-09, far below any plausible reset time).
 */
export function codexEpochToIso(epoch: number | null | undefined): string | undefined {
  if (typeof epoch !== "number" || !Number.isFinite(epoch) || epoch <= 0) return undefined;
  const millis = epoch >= 1e12 ? epoch : epoch * 1000;
  return DateTime.formatIso(DateTime.makeUnsafe(millis));
}

export function codexPlanLabel(
  planType: CodexSchema.V2GetAccountRateLimitsResponse__PlanType | null | undefined,
): string | undefined {
  switch (planType) {
    case "free":
      return "ChatGPT Free";
    case "go":
      return "ChatGPT Go";
    case "plus":
      return "ChatGPT Plus";
    case "pro":
      return "ChatGPT Pro 20x";
    case "prolite":
      return "ChatGPT Pro 5x";
    case "team":
      return "ChatGPT Team";
    case "self_serve_business_usage_based":
    case "business":
      return "ChatGPT Business";
    case "enterprise_cbp_usage_based":
    case "enterprise":
      return "ChatGPT Enterprise";
    case "edu":
      return "ChatGPT Edu";
    case "unknown":
      return "ChatGPT";
    default:
      return undefined;
  }
}

type CodexRateLimitSnapshot = CodexSchema.V2GetAccountRateLimitsResponse["rateLimits"];
type ClassifiedWindowKind = "session" | "weekly";

function exactWindowKind(
  window: CodexSchema.V2GetAccountRateLimitsResponse__RateLimitWindow,
): ClassifiedWindowKind | undefined {
  if (window.windowDurationMins === SESSION_WINDOW_MINUTES) return "session";
  if (window.windowDurationMins === WEEK_MINUTES) return "weekly";
  return undefined;
}

function rateLimitWindow(input: {
  readonly window: CodexSchema.V2GetAccountRateLimitsResponse__RateLimitWindow;
  readonly id: string;
  readonly label: string;
  readonly kind: ProviderUsageWindow["kind"];
  readonly fallbackWindowMinutes: number;
}): ProviderUsageWindow {
  const resetsAt = codexEpochToIso(input.window.resetsAt);
  const windowMinutes = input.window.windowDurationMins ?? input.fallbackWindowMinutes;
  return {
    id: input.id,
    label: input.label,
    kind: input.kind,
    usedPercent: clampPercent(input.window.usedPercent),
    ...(resetsAt ? { resetsAt } : {}),
    windowMinutes,
  };
}

/**
 * Codex can move a temporarily sole weekly limit into the primary slot. Use
 * explicit duration first, then fall back to the historical slot meaning only
 * when duration is absent or unfamiliar.
 */
function classifiedRateLimitWindows(input: {
  readonly rateLimits: CodexRateLimitSnapshot;
  readonly idPrefix?: string;
  readonly modelLabel?: string;
}): ReadonlyArray<ProviderUsageWindow> {
  const candidates = [
    input.rateLimits.primary
      ? { window: input.rateLimits.primary, fallbackKind: "session" as const, slot: "primary" }
      : undefined,
    input.rateLimits.secondary
      ? { window: input.rateLimits.secondary, fallbackKind: "weekly" as const, slot: "secondary" }
      : undefined,
  ].filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== undefined);

  const result: Array<ProviderUsageWindow> = [];
  for (const kind of ["session", "weekly"] as const) {
    const candidate =
      candidates.find((entry) => exactWindowKind(entry.window) === kind) ??
      candidates.find(
        (entry) => exactWindowKind(entry.window) === undefined && entry.fallbackKind === kind,
      );
    if (!candidate) continue;
    const modelLabel = input.modelLabel;
    result.push(
      rateLimitWindow({
        window: candidate.window,
        id: input.idPrefix ? `${input.idPrefix}:${kind}` : candidate.slot,
        label:
          modelLabel !== undefined
            ? kind === "weekly"
              ? `${modelLabel} Weekly`
              : modelLabel
            : kind === "weekly"
              ? "Weekly"
              : "Session",
        kind: modelLabel !== undefined ? "model" : kind,
        fallbackWindowMinutes: kind === "weekly" ? WEEK_MINUTES : SESSION_WINDOW_MINUTES,
      }),
    );
  }
  return result;
}

function mapCodexResetCredits(
  summary: CodexSchema.V2GetAccountRateLimitsResponse["rateLimitResetCredits"],
): ProviderUsageResetCredits | undefined {
  if (!summary) return undefined;
  const credits = (summary.credits ?? []).flatMap((credit) => {
    if (credit.status !== "available" || credit.id.trim().length === 0) return [];
    const expiresAt = codexEpochToIso(credit.expiresAt);
    return [
      {
        id: credit.id,
        ...(credit.title?.trim() ? { title: credit.title.trim() } : {}),
        ...(credit.description?.trim() ? { description: credit.description.trim() } : {}),
        ...(expiresAt ? { expiresAt } : {}),
      },
    ];
  });
  credits.sort((a, b) => (a.expiresAt ?? "\uffff").localeCompare(b.expiresAt ?? "\uffff"));
  return {
    availableCount: Math.max(0, Math.floor(summary.availableCount)),
    credits,
  };
}

/**
 * Map `account/rateLimits/read` to normalized windows + credits + plan.
 * Exported for fixture-driven tests.
 */
export function mapCodexRateLimits(response: CodexSchema.V2GetAccountRateLimitsResponse): {
  readonly windows: ReadonlyArray<ProviderUsageWindow>;
  readonly credits: ProviderUsageCredits | undefined;
  readonly resetCredits: ProviderUsageResetCredits | undefined;
  readonly planLabel: string | undefined;
} {
  const rateLimits = response.rateLimits;
  const byLimitId = Object.entries(response.rateLimitsByLimitId ?? {});
  const coreEntry =
    (rateLimits.limitId
      ? byLimitId.find(([limitId]) => limitId === rateLimits.limitId)
      : undefined) ??
    byLimitId.find(([limitId]) => limitId.toLowerCase() === "codex") ??
    (byLimitId.length === 1 ? byLimitId[0] : undefined);
  const coreRateLimits = coreEntry?.[1] ?? rateLimits;
  const windows: Array<ProviderUsageWindow> = [
    ...classifiedRateLimitWindows({ rateLimits: coreRateLimits }),
  ];

  for (const [limitId, bucket] of byLimitId) {
    if (limitId === coreEntry?.[0]) continue;
    const label = bucket.limitName?.trim() || toTitleCaseWords(limitId);
    windows.push(
      ...classifiedRateLimitWindows({
        rateLimits: bucket,
        idPrefix: `limit:${limitId.toLowerCase()}`,
        modelLabel: label,
      }),
    );
  }

  const individualLimit = rateLimits.individualLimit;
  if (individualLimit) {
    const resetsAt = codexEpochToIso(individualLimit.resetsAt);
    windows.push({
      id: "spend",
      label: "Spend limit",
      kind: "other",
      usedPercent: clampPercent(100 - individualLimit.remainingPercent),
      ...(resetsAt ? { resetsAt } : {}),
    });
  }

  const rawCredits = rateLimits.credits;
  const credits: ProviderUsageCredits | undefined =
    rawCredits && (rawCredits.unlimited || rawCredits.hasCredits || rawCredits.balance)
      ? {
          label: "Credits",
          ...(rawCredits.balance ? { balance: rawCredits.balance } : {}),
          ...(rawCredits.unlimited ? { unlimited: true } : {}),
        }
      : undefined;

  return {
    windows,
    credits,
    resetCredits: mapCodexResetCredits(response.rateLimitResetCredits),
    planLabel: codexPlanLabel(rateLimits.planType ?? coreRateLimits.planType),
  };
}

function codexAccountEmail(
  account: CodexSchema.V2GetAccountResponse["account"],
): string | undefined {
  if (!account || account.type !== "chatgpt") return undefined;
  return account.email ?? undefined;
}

/**
 * Build the usage capability for one Codex instance. Captures the spawner at
 * create time so `fetchUsage` runs with `R = never`.
 */
export const makeCodexUsage = Effect.fn("makeCodexUsage")(function* (
  config: Pick<CodexSettings, "binaryPath" | "homePath">,
  meta: CodexUsageMeta,
  environment?: NodeJS.ProcessEnv,
): Effect.fn.Return<ProviderUsageShape, never, ChildProcessSpawner.ChildProcessSpawner> {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const resolvedEnvironment = environment ?? process.env;

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
      status: "unauthenticated" | "error",
      message: string,
    ): ProviderUsageSnapshot => ({ ...base, status, message });

    const result = yield* Effect.gen(function* () {
      const resolvedHomePath = config.homePath ? expandHomePath(config.homePath) : undefined;
      const spawnEnvironment = {
        ...resolvedEnvironment,
        ...(resolvedHomePath ? { CODEX_HOME: resolvedHomePath } : {}),
      };
      const spawnCommand = yield* resolveSpawnCommand(config.binaryPath, ["app-server"], {
        env: spawnEnvironment,
        extendEnv: true,
      });
      const child = yield* spawner.spawn(
        ChildProcess.make(spawnCommand.command, spawnCommand.args, {
          cwd: process.cwd(),
          env: spawnEnvironment,
          extendEnv: true,
          forceKillAfter: CODEX_USAGE_FORCE_KILL_AFTER,
          shell: spawnCommand.shell,
        }),
      );
      const clientContext = yield* Layer.build(CodexClient.layerChildProcess(child));
      const client = yield* Effect.service(CodexClient.CodexAppServerClient).pipe(
        Effect.provide(clientContext),
      );
      yield* client.request("initialize", buildCodexInitializeParams());
      yield* client.notify("initialized", undefined);

      const account = yield* client.request("account/read", {});
      if (!account.account && account.requiresOpenaiAuth) {
        return { unauthenticated: true as const };
      }
      const rateLimits = yield* client.request("account/rateLimits/read", undefined);
      return {
        unauthenticated: false as const,
        rateLimits,
        email: codexAccountEmail(account.account),
      };
    }).pipe(Effect.scoped, Effect.timeoutOption(CODEX_USAGE_TIMEOUT), Effect.result);

    if (Result.isFailure(result)) {
      const error = result.failure;
      const message = error instanceof Error ? error.message : String(error);
      return failed("error", `Codex usage probe failed: ${message}`);
    }
    if (Option.isNone(result.success)) {
      return failed("error", "Codex usage probe timed out.");
    }
    const probe = result.success.value;
    if (probe.unauthenticated) {
      return failed("unauthenticated", LOGIN_MESSAGE);
    }

    const { windows, credits, resetCredits, planLabel } = mapCodexRateLimits(probe.rateLimits);
    return {
      ...base,
      ...(probe.email ? { account: probe.email } : {}),
      status: "ok",
      ...(planLabel ? { planLabel } : {}),
      windows,
      ...(credits ? { credits } : {}),
      ...(resetCredits ? { resetCredits } : {}),
    } satisfies ProviderUsageSnapshot;
  }).pipe(
    Effect.catchDefect((defect: unknown) =>
      Effect.map(DateTime.now, (now) => ({
        instanceId: meta.instanceId,
        driver: meta.driverKind,
        ...(meta.displayName ? { displayName: meta.displayName } : {}),
        status: "error" as const,
        windows: [],
        message: `Codex usage fetch crashed: ${String(defect)}`,
        fetchedAt: DateTime.formatIso(now),
      })),
    ),
  );

  return { fetchUsage } satisfies ProviderUsageShape;
});
