import { describe, expect, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderUsageSnapshot,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import type { ProviderInstance } from "../ProviderDriver.ts";
import type { ProviderUsageShape } from "../Services/ProviderUsage.ts";
import { ProviderInstanceRegistry } from "../Services/ProviderInstanceRegistry.ts";
import { ProviderUsageService } from "../Services/ProviderUsage.ts";
import { ProviderUsageServiceLive } from "./ProviderUsageService.ts";

const makeUsageSnapshot = (
  instanceId: string,
  overrides: Partial<ProviderUsageSnapshot> = {},
): ProviderUsageSnapshot => ({
  instanceId: ProviderInstanceId.make(instanceId),
  driver: ProviderDriverKind.make("codex"),
  status: "ok",
  windows: [],
  fetchedAt: "2025-01-15T10:00:00.000Z",
  ...overrides,
});

const makeInstance = (input: {
  readonly instanceId: string;
  readonly enabled?: boolean;
  readonly displayName?: string;
  readonly accountEmail?: string;
  readonly usage?: ProviderUsageShape;
}): ProviderInstance => {
  const instanceId = ProviderInstanceId.make(input.instanceId);
  const driverKind = ProviderDriverKind.make("codex");
  return {
    instanceId,
    driverKind,
    continuationIdentity: {
      driverKind,
      continuationKey: `codex:instance:${instanceId}`,
    },
    displayName: input.displayName,
    enabled: input.enabled ?? true,
    snapshot: {
      getSnapshot: Effect.succeed({
        ...(input.accountEmail ? { auth: { email: input.accountEmail } } : {}),
      }),
      refresh: Effect.die("not used"),
      streamChanges: Stream.empty,
      maintenanceCapabilities: {},
    },
    usage: input.usage,
    adapter: {},
    textGeneration: {},
  } as unknown as ProviderInstance;
};

const makeUsageLayer = (instances: ReadonlyArray<ProviderInstance>) => {
  const instanceRegistry = Layer.succeed(
    ProviderInstanceRegistry,
    ProviderInstanceRegistry.of({
      getInstance: (instanceId) =>
        Effect.succeed(instances.find((instance) => instance.instanceId === instanceId)),
      listInstances: Effect.succeed(instances),
      listUnavailable: Effect.succeed([]),
      streamChanges: Stream.empty,
      subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), (pubsub) =>
        PubSub.subscribe(pubsub),
      ),
    }),
  );
  return ProviderUsageServiceLive.pipe(Layer.provide(instanceRegistry));
};

describe("ProviderUsageServiceLive", () => {
  it.effect("synthesizes unsupported snapshots for enabled instances without usage", () => {
    const instance = makeInstance({ instanceId: "cursor" });
    return Effect.gen(function* () {
      const service = yield* ProviderUsageService;

      const result = yield* service.getUsage();

      expect(result.usage).toHaveLength(1);
      expect(result.usage[0]).toMatchObject({
        instanceId: instance.instanceId,
        driver: "codex",
        status: "unsupported",
        windows: [],
      });
    }).pipe(Effect.provide(makeUsageLayer([instance])));
  });

  it.effect("fills missing account identities and preserves fetched identities", () => {
    const filled = makeInstance({
      instanceId: "codex_personal",
      accountEmail: "snapshot@example.com",
      usage: {
        fetchUsage: Effect.succeed(makeUsageSnapshot("codex_personal")),
      },
    });
    const preserved = makeInstance({
      instanceId: "codex_work",
      accountEmail: "snapshot@example.com",
      usage: {
        fetchUsage: Effect.succeed(
          makeUsageSnapshot("codex_work", { account: "fetcher@example.com" }),
        ),
      },
    });
    return Effect.gen(function* () {
      const service = yield* ProviderUsageService;

      const result = yield* service.getUsage();

      expect(
        result.usage.find((snapshot) => snapshot.instanceId === filled.instanceId)?.account,
      ).toBe("snapshot@example.com");
      expect(
        result.usage.find((snapshot) => snapshot.instanceId === preserved.instanceId)?.account,
      ).toBe("fetcher@example.com");
    }).pipe(Effect.provide(makeUsageLayer([filled, preserved])));
  });

  it.effect("caches only successful snapshots", () => {
    let okFetches = 0;
    let errorFetches = 0;
    const successful = makeInstance({
      instanceId: "codex_ok",
      usage: {
        fetchUsage: Effect.sync(() => {
          okFetches += 1;
          return makeUsageSnapshot("codex_ok");
        }),
      },
    });
    const failing = makeInstance({
      instanceId: "codex_error",
      usage: {
        fetchUsage: Effect.sync(() => {
          errorFetches += 1;
          return makeUsageSnapshot("codex_error", { status: "error" });
        }),
      },
    });
    return Effect.gen(function* () {
      const service = yield* ProviderUsageService;

      yield* service.getUsage(successful.instanceId);
      yield* service.getUsage(successful.instanceId);
      yield* service.getUsage(failing.instanceId);
      yield* service.getUsage(failing.instanceId);

      expect(okFetches).toBe(1);
      expect(errorFetches).toBe(2);
    }).pipe(Effect.provide(makeUsageLayer([successful, failing])));
  });

  it.effect("filters to the requested enabled instance and excludes disabled instances", () => {
    const requested = makeInstance({
      instanceId: "codex_personal",
      usage: { fetchUsage: Effect.succeed(makeUsageSnapshot("codex_personal")) },
    });
    const other = makeInstance({
      instanceId: "codex_work",
      usage: { fetchUsage: Effect.succeed(makeUsageSnapshot("codex_work")) },
    });
    const disabled = makeInstance({
      instanceId: "codex_disabled",
      enabled: false,
      usage: { fetchUsage: Effect.succeed(makeUsageSnapshot("codex_disabled")) },
    });
    return Effect.gen(function* () {
      const service = yield* ProviderUsageService;

      const filtered = yield* service.getUsage(requested.instanceId);
      const all = yield* service.getUsage();

      expect(filtered.usage.map((snapshot) => snapshot.instanceId)).toEqual([requested.instanceId]);
      expect(all.usage.map((snapshot) => snapshot.instanceId)).toEqual([
        requested.instanceId,
        other.instanceId,
      ]);
    }).pipe(Effect.provide(makeUsageLayer([requested, other, disabled])));
  });

  it.effect("isolates one provider usage error from healthy instances", () => {
    const broken = makeInstance({
      instanceId: "codex_broken",
      usage: {
        fetchUsage: Effect.succeed(
          makeUsageSnapshot("codex_broken", { status: "error", message: "upstream failed" }),
        ),
      },
    });
    const healthy = makeInstance({
      instanceId: "codex_healthy",
      usage: {
        fetchUsage: Effect.succeed(
          makeUsageSnapshot("codex_healthy", { account: "healthy@example.com" }),
        ),
      },
    });
    return Effect.gen(function* () {
      const service = yield* ProviderUsageService;

      const result = yield* service.getUsage();

      expect(result.usage).toHaveLength(2);
      expect(
        result.usage.find((snapshot) => snapshot.instanceId === broken.instanceId),
      ).toMatchObject({
        status: "error",
        message: "upstream failed",
      });
      expect(
        result.usage.find((snapshot) => snapshot.instanceId === healthy.instanceId),
      ).toMatchObject({
        status: "ok",
        account: "healthy@example.com",
      });
    }).pipe(Effect.provide(makeUsageLayer([broken, healthy])));
  });
});
