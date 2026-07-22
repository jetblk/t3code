/**
 * ProviderUsageServiceLive — aggregates per-instance usage capabilities into
 * the `server.getProviderUsage` RPC result.
 *
 * Fresh `ok` snapshots are cached for a short TTL keyed by instance id. The
 * cache exists to bound upstream traffic (Anthropic's usage endpoint, codex
 * app-server spawns) under client pull-to-refresh, not to serve stale data:
 * non-`ok` snapshots are never cached, so error/unauthenticated states are
 * re-probed on every request.
 *
 * @module provider/Layers/ProviderUsageService
 */
import type { ProviderUsageSnapshot } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import type { ProviderInstance } from "../ProviderDriver.ts";
import { ProviderInstanceRegistry } from "../Services/ProviderInstanceRegistry.ts";
import { ProviderUsageService } from "../Services/ProviderUsage.ts";

const USAGE_CACHE_TTL = Duration.seconds(60);

interface CacheEntry {
  readonly snapshot: ProviderUsageSnapshot;
  readonly expiresAtMillis: number;
}

const unsupportedSnapshot = (
  instance: ProviderInstance,
  fetchedAt: string,
): ProviderUsageSnapshot => ({
  instanceId: instance.instanceId,
  driver: instance.driverKind,
  ...(instance.displayName ? { displayName: instance.displayName } : {}),
  status: "unsupported",
  windows: [],
  fetchedAt,
});

/**
 * Fill `account` (the cross-node dedupe identity) from the instance's
 * provider snapshot when the fetcher didn't supply one. Only the auth email
 * qualifies — auth labels ("Claude Max Subscription") are plan names, not
 * account identities, and would wrongly merge different accounts on the
 * same plan.
 */
const withAccountIdentity = (
  instance: ProviderInstance,
  snapshot: ProviderUsageSnapshot,
): Effect.Effect<ProviderUsageSnapshot> => {
  if (snapshot.account !== undefined) return Effect.succeed(snapshot);
  return Effect.map(instance.snapshot.getSnapshot, (provider) => {
    const email = provider.auth?.email;
    return email ? { ...snapshot, account: email } : snapshot;
  });
};

export const ProviderUsageServiceLive = Layer.effect(
  ProviderUsageService,
  Effect.gen(function* () {
    const instanceRegistry = yield* ProviderInstanceRegistry;
    const cache = yield* Ref.make(new Map<ProviderUsageSnapshot["instanceId"], CacheEntry>());

    const fetchInstanceUsage = (instance: ProviderInstance) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const nowMillis = DateTime.toEpochMillis(now);
        if (!instance.usage) {
          return unsupportedSnapshot(instance, DateTime.formatIso(now));
        }
        const cached = (yield* Ref.get(cache)).get(instance.instanceId);
        if (cached && cached.expiresAtMillis > nowMillis) {
          // Re-resolve the identity rather than replaying it: a snapshot
          // cached before the provider status probe learned the account email
          // would otherwise stay un-deduped for the rest of the TTL.
          return yield* withAccountIdentity(instance, cached.snapshot);
        }
        const snapshot = yield* instance.usage.fetchUsage.pipe(
          Effect.flatMap((fetched) => withAccountIdentity(instance, fetched)),
        );
        if (snapshot.status === "ok") {
          yield* Ref.update(cache, (entries) => {
            const next = new Map(entries);
            next.set(instance.instanceId, {
              snapshot,
              expiresAtMillis: nowMillis + Duration.toMillis(USAGE_CACHE_TTL),
            });
            return next;
          });
        }
        return snapshot;
      });

    return {
      getUsage: (instanceId) =>
        Effect.gen(function* () {
          const instances = yield* instanceRegistry.listInstances;
          const targets = instances.filter(
            (instance) =>
              instance.enabled && (instanceId === undefined || instance.instanceId === instanceId),
          );
          const usage = yield* Effect.all(targets.map(fetchInstanceUsage), {
            concurrency: "unbounded",
          });
          return { usage };
        }),
    };
  }),
);
