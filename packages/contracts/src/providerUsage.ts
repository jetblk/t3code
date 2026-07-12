/**
 * Provider account-level usage contracts.
 *
 * Normalized subscription rate-limit usage (session/weekly windows, credits)
 * reported per provider instance. Providers whose drivers cannot report usage
 * surface as `status: "unsupported"` rather than being omitted, so clients can
 * render a complete picture of every configured instance.
 *
 * Snapshots are request/response data fetched on demand (not part of the
 * broadcast `ServerProvider` config stream) — usage changes continuously and
 * would churn the persisted config cache. The `account.rate-limits.updated`
 * runtime event remains the future hook for live-push updates into this same
 * shape.
 *
 * @module providerUsage
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

export const ProviderUsageWindowKind = Schema.Literals(["session", "weekly", "model", "other"]);
export type ProviderUsageWindowKind = typeof ProviderUsageWindowKind.Type;

/**
 * One rate-limit window (e.g. Claude's 5-hour session window). `usedPercent`
 * is the raw consumed percentage from the provider; clients decide the
 * presentation orientation ("92% left"). Labels for `kind: "model"` windows
 * come from the provider response verbatim — model names are never hardcoded
 * because providers rename them without notice.
 */
export const ProviderUsageWindow = Schema.Struct({
  /** Stable identifier within a snapshot, e.g. `five_hour`, `primary`, `model:opus`. */
  id: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  kind: ProviderUsageWindowKind,
  /** Consumed percentage of the window, clamped to 0–100 by producers. */
  usedPercent: Schema.Number,
  resetsAt: Schema.optional(IsoDateTime),
  windowMinutes: Schema.optional(Schema.Number),
});
export type ProviderUsageWindow = typeof ProviderUsageWindow.Type;

/** Overflow/credit balances (Claude "extra usage", Codex credits). */
export const ProviderUsageCredits = Schema.Struct({
  label: TrimmedNonEmptyString,
  /** Preformatted balance when the provider reports an opaque amount. */
  balance: Schema.optional(TrimmedNonEmptyString),
  /** Consumed amount in the account currency (dollars). */
  usedCredits: Schema.optional(Schema.Number),
  /** Cap in the account currency (dollars); absent means no configured cap. */
  monthlyLimit: Schema.optional(Schema.Number),
  unlimited: Schema.optional(Schema.Boolean),
});
export type ProviderUsageCredits = typeof ProviderUsageCredits.Type;

export const ProviderUsageStatus = Schema.Literals([
  "ok",
  "unauthenticated",
  "unsupported",
  "error",
]);
export type ProviderUsageStatus = typeof ProviderUsageStatus.Type;

/**
 * Usage for one provider instance. Flat struct with a `status` discriminant
 * (mirroring how `ServerProvider` folds availability/auth into one record):
 * per-instance failures become `unauthenticated`/`error` snapshots so a single
 * broken provider never fails the whole result.
 */
export const ProviderUsageSnapshot = Schema.Struct({
  instanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
  displayName: Schema.optional(TrimmedNonEmptyString),
  /**
   * Account identity (email or auth label) used by clients to dedupe the same
   * provider account reported by multiple server nodes. Absent when the
   * driver does not expose one — those snapshots are never deduped.
   */
  account: Schema.optional(TrimmedNonEmptyString),
  status: ProviderUsageStatus,
  /** Subscription tier, e.g. "Max 20x", "ChatGPT Pro". */
  planLabel: Schema.optional(TrimmedNonEmptyString),
  windows: Schema.Array(ProviderUsageWindow).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  credits: Schema.optional(ProviderUsageCredits),
  /** Human guidance for non-`ok` statuses ("Run `codex login` on the server machine"). */
  message: Schema.optional(TrimmedNonEmptyString),
  fetchedAt: IsoDateTime,
});
export type ProviderUsageSnapshot = typeof ProviderUsageSnapshot.Type;

export const ProviderUsageInput = Schema.Struct({
  instanceId: Schema.optional(ProviderInstanceId),
});
export type ProviderUsageInput = typeof ProviderUsageInput.Type;

export const ProviderUsageResult = Schema.Struct({
  usage: Schema.Array(ProviderUsageSnapshot),
});
export type ProviderUsageResult = typeof ProviderUsageResult.Type;
