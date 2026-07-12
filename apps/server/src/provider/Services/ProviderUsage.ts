/**
 * ProviderUsage — optional per-instance capability for account-level
 * subscription usage (rate-limit windows, credits).
 *
 * Drivers that can report usage attach a `ProviderUsageShape` to their
 * `ProviderInstance`; drivers that can't simply omit it and the aggregation
 * service synthesizes an `unsupported` snapshot. Kept as a captured closure
 * (not a Context tag) for the same reason as the other instance shapes —
 * many instances of one driver, each with independent credentials.
 *
 * @module provider/Services/ProviderUsage
 */
import type {
  ProviderInstanceId,
  ProviderUsageResult,
  ProviderUsageSnapshot,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export interface ProviderUsageShape {
  /**
   * Fetch the current usage snapshot for this instance. Never fails — every
   * failure mode (missing credentials, upstream errors, timeouts) is folded
   * into the snapshot's `status`/`message` so one broken provider cannot
   * fail an aggregate fetch.
   */
  readonly fetchUsage: Effect.Effect<ProviderUsageSnapshot>;
}

export interface ProviderUsageServiceShape {
  /**
   * Usage snapshots for every enabled instance (or just `instanceId` when
   * supplied). Instances without the usage capability are included as
   * `status: "unsupported"` so clients always see the full instance list.
   */
  readonly getUsage: (instanceId?: ProviderInstanceId) => Effect.Effect<ProviderUsageResult>;
}

export class ProviderUsageService extends Context.Service<
  ProviderUsageService,
  ProviderUsageServiceShape
>()("t3/provider/Services/ProviderUsage/ProviderUsageService") {}
