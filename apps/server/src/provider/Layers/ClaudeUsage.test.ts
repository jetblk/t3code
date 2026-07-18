import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Path from "effect/Path";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import {
  claudeRetryAfterMillis,
  claudeUsagePlanLabel,
  makeClaudeUsage,
  mapClaudeUsageResponse,
  parseClaudeOauthCredentials,
} from "./ClaudeUsage.ts";

describe("mapClaudeUsageResponse", () => {
  it("maps all supported windows and enabled extra usage", () => {
    const result = mapClaudeUsageResponse({
      five_hour: { utilization: 25, resets_at: "2025-01-15T12:00:00.000Z" },
      seven_day: { utilization: 50, resets_at: "2025-01-20T12:00:00.000Z" },
      seven_day_sonnet: { utilization: 75, resets_at: "2025-01-20T12:00:00.000Z" },
      limits: [
        {
          scope: { model: { display_name: "Haiku" } },
          percent: 40,
          resets_at: "2025-01-20T12:00:00.000Z",
        },
        {
          scope: { model: { display_name: "Haiku" } },
          percent: 99,
          resets_at: "2025-01-21T12:00:00.000Z",
        },
      ],
      extra_usage: {
        is_enabled: true,
        used_credits: 1_234,
        monthly_limit: 5_000,
      },
    });

    expect(result.windows).toEqual([
      {
        id: "five_hour",
        label: "Session",
        kind: "session",
        usedPercent: 25,
        resetsAt: "2025-01-15T12:00:00.000Z",
        windowMinutes: 300,
      },
      {
        id: "seven_day",
        label: "Weekly",
        kind: "weekly",
        usedPercent: 50,
        resetsAt: "2025-01-20T12:00:00.000Z",
        windowMinutes: 10_080,
      },
      {
        id: "model:sonnet",
        label: "Sonnet",
        kind: "model",
        usedPercent: 75,
        resetsAt: "2025-01-20T12:00:00.000Z",
        windowMinutes: 10_080,
      },
      {
        id: "model:haiku",
        label: "Haiku",
        kind: "model",
        usedPercent: 40,
        resetsAt: "2025-01-20T12:00:00.000Z",
        windowMinutes: 10_080,
      },
    ]);
    expect(result.credits).toEqual({
      label: "Extra usage",
      usedCredits: 12.34,
      monthlyLimit: 50,
    });
  });

  it("derives model labels from dynamic response values", () => {
    const result = mapClaudeUsageResponse({
      seven_day_fable: { utilization: 20 },
      limits: [
        {
          scope: { model: { display_name: "SomeNewModel" } },
          percent: 30,
        },
      ],
    });

    expect(result.windows).toEqual([
      {
        id: "model:fable",
        label: "Fable",
        kind: "model",
        usedPercent: 20,
        windowMinutes: 10_080,
      },
      {
        id: "model:somenewmodel",
        label: "SomeNewModel",
        kind: "model",
        usedPercent: 30,
        windowMinutes: 10_080,
      },
    ]);
  });

  it("returns only session and weekly windows when no model windows are present", () => {
    const result = mapClaudeUsageResponse({
      five_hour: { utilization: 20 },
      seven_day: { utilization: 30 },
    });

    expect(result.windows.map((window) => window.id)).toEqual(["five_hour", "seven_day"]);
  });

  it("omits credits when extra usage is disabled or absent", () => {
    expect(mapClaudeUsageResponse({ extra_usage: { is_enabled: false } }).credits).toBeUndefined();
    expect(mapClaudeUsageResponse({}).credits).toBeUndefined();
  });

  it("clamps utilization to a valid percentage", () => {
    const result = mapClaudeUsageResponse({ five_hour: { utilization: 130 } });

    expect(result.windows[0]?.usedPercent).toBe(100);
  });

  it("returns an empty result for non-record and empty inputs", () => {
    expect(mapClaudeUsageResponse(null)).toEqual({ windows: [], credits: undefined });
    expect(mapClaudeUsageResponse([])).toEqual({ windows: [], credits: undefined });
    expect(mapClaudeUsageResponse({})).toEqual({ windows: [], credits: undefined });
  });
});

describe("parseClaudeOauthCredentials", () => {
  it("parses valid Claude OAuth credentials", () => {
    expect(
      parseClaudeOauthCredentials({
        claudeAiOauth: {
          accessToken: "token",
          expiresAt: 1_700_000_000_000,
          subscriptionType: "max",
          rateLimitTier: "default_claude_max_20x",
          scopes: ["user:profile", "other:scope"],
        },
      }),
    ).toEqual({
      accessToken: "token",
      expiresAt: 1_700_000_000_000,
      subscriptionType: "max",
      rateLimitTier: "default_claude_max_20x",
      scopes: ["user:profile", "other:scope"],
    });
  });

  it("rejects missing OAuth envelopes and access tokens", () => {
    expect(parseClaudeOauthCredentials({})).toBeUndefined();
    expect(parseClaudeOauthCredentials({ claudeAiOauth: {} })).toBeUndefined();
  });

  it("drops invalid scopes while preserving the valid credentials", () => {
    expect(
      parseClaudeOauthCredentials({
        claudeAiOauth: { accessToken: "token", scopes: "user:profile" },
      }),
    ).toEqual({
      accessToken: "token",
      expiresAt: undefined,
      subscriptionType: undefined,
      rateLimitTier: undefined,
      scopes: undefined,
    });
    expect(
      parseClaudeOauthCredentials({
        claudeAiOauth: { accessToken: "token", scopes: ["user:profile", 42] },
      }),
    ).toMatchObject({ scopes: undefined });
  });
});

describe("Claude usage metadata", () => {
  it("adds a rate-limit multiplier without duplicating one already in the plan", () => {
    expect(claudeUsagePlanLabel("max", "default_claude_max_20x")).toBe("Max 20x");
    expect(claudeUsagePlanLabel("claude_max_5x_subscription", "default_claude_max_5x")).toBe(
      "Max 5x",
    );
    expect(claudeUsagePlanLabel("pro", undefined)).toBe("Pro");
  });

  it("parses Retry-After seconds and dates with a five-minute fallback", () => {
    const now = Date.parse("2026-07-18T10:00:00.000Z");
    expect(claudeRetryAfterMillis("90", now)).toBe(now + 90_000);
    expect(claudeRetryAfterMillis("Sat, 18 Jul 2026 10:02:00 GMT", now)).toBe(now + 120_000);
    expect(claudeRetryAfterMillis("invalid", now)).toBe(now + 5 * 60_000);
  });
});

const makeTestClaudeUsage = Effect.fn("makeTestClaudeUsage")(function* (
  httpClient: HttpClient.HttpClient,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const configDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-usage-" });
  yield* fs.writeFileString(
    path.join(configDir, ".credentials.json"),
    '{"claudeAiOauth":{"accessToken":"test-token","subscriptionType":"pro","scopes":["user:profile"]}}',
  );
  return yield* makeClaudeUsage(
    { homePath: configDir },
    {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      driverKind: ProviderDriverKind.make("claudeAgent"),
      displayName: undefined,
    },
  ).pipe(Effect.provideService(HttpClient.HttpClient, httpClient));
});

it.layer(NodeServices.layer)("Claude usage cooldown", (it) => {
  it.effect("serves the last good snapshot and avoids repeated requests during a 429", () =>
    Effect.gen(function* () {
      let requestCount = 0;
      const httpClient = HttpClient.make((request) =>
        Effect.sync(() => {
          requestCount += 1;
          const response =
            requestCount === 1
              ? Response.json({ five_hour: { utilization: 25 } })
              : new Response(null, { status: 429, headers: { "retry-after": "300" } });
          return HttpClientResponse.fromWeb(request, response);
        }),
      );
      const usage = yield* makeTestClaudeUsage(httpClient);

      const fresh = yield* usage.fetchUsage;
      const throttled = yield* usage.fetchUsage;
      const duringCooldown = yield* usage.fetchUsage;

      expect(requestCount).toBe(2);
      expect(fresh.status).toBe("ok");
      expect(throttled).toMatchObject({
        status: "ok",
        windows: fresh.windows,
        freshness: { state: "stale" },
      });
      expect(duringCooldown).toMatchObject({
        status: "ok",
        windows: fresh.windows,
        freshness: { state: "stale" },
      });
      expect(throttled.freshness?.retryAt).toBe(duringCooldown.freshness?.retryAt);
    }).pipe(Effect.scoped),
  );

  it.effect("preserves a concurrent cooldown when an older successful request finishes", () =>
    Effect.gen(function* () {
      const firstRequestStarted = yield* Deferred.make<void>();
      const releaseFirstResponse = yield* Deferred.make<void>();
      let requestCount = 0;
      const httpClient = HttpClient.make((request) =>
        Effect.gen(function* () {
          requestCount += 1;
          if (requestCount === 1) {
            yield* Deferred.succeed(firstRequestStarted, undefined);
            yield* Deferred.await(releaseFirstResponse);
            return HttpClientResponse.fromWeb(
              request,
              Response.json({ five_hour: { utilization: 25 } }),
            );
          }
          return HttpClientResponse.fromWeb(
            request,
            new Response(null, { status: 429, headers: { "retry-after": "300" } }),
          );
        }),
      );
      const usage = yield* makeTestClaudeUsage(httpClient);

      const successfulRequest = yield* usage.fetchUsage.pipe(Effect.forkScoped);
      yield* Deferred.await(firstRequestStarted);
      const throttled = yield* usage.fetchUsage;
      yield* Deferred.succeed(releaseFirstResponse, undefined);
      const fresh = yield* Fiber.join(successfulRequest);
      const duringCooldown = yield* usage.fetchUsage;

      expect(requestCount).toBe(2);
      expect(throttled).toMatchObject({ status: "error", freshness: { state: "stale" } });
      expect(fresh.status).toBe("ok");
      expect(duringCooldown).toMatchObject({
        status: "ok",
        windows: fresh.windows,
        freshness: { state: "stale" },
      });
    }).pipe(Effect.scoped),
  );

  it.effect("preserves a concurrent successful snapshot when an older request is throttled", () =>
    Effect.gen(function* () {
      const firstRequestStarted = yield* Deferred.make<void>();
      const releaseFirstResponse = yield* Deferred.make<void>();
      let requestCount = 0;
      const httpClient = HttpClient.make((request) =>
        Effect.gen(function* () {
          requestCount += 1;
          if (requestCount === 1) {
            yield* Deferred.succeed(firstRequestStarted, undefined);
            yield* Deferred.await(releaseFirstResponse);
            return HttpClientResponse.fromWeb(
              request,
              new Response(null, { status: 429, headers: { "retry-after": "300" } }),
            );
          }
          return HttpClientResponse.fromWeb(
            request,
            Response.json({ five_hour: { utilization: 25 } }),
          );
        }),
      );
      const usage = yield* makeTestClaudeUsage(httpClient);

      const throttledRequest = yield* usage.fetchUsage.pipe(Effect.forkScoped);
      yield* Deferred.await(firstRequestStarted);
      const fresh = yield* usage.fetchUsage;
      yield* Deferred.succeed(releaseFirstResponse, undefined);
      const throttled = yield* Fiber.join(throttledRequest);
      const duringCooldown = yield* usage.fetchUsage;

      expect(requestCount).toBe(2);
      expect(fresh.status).toBe("ok");
      expect(throttled).toMatchObject({
        status: "ok",
        windows: fresh.windows,
        freshness: { state: "stale" },
      });
      expect(duringCooldown).toMatchObject({
        status: "ok",
        windows: fresh.windows,
        freshness: { state: "stale" },
      });
    }).pipe(Effect.scoped),
  );
});
