import { describe, expect, it } from "@effect/vitest";

import { mapClaudeUsageResponse, parseClaudeOauthCredentials } from "./ClaudeUsage.ts";

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
          scopes: ["user:profile", "other:scope"],
        },
      }),
    ).toEqual({
      accessToken: "token",
      expiresAt: 1_700_000_000_000,
      subscriptionType: "max",
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
      scopes: undefined,
    });
    expect(
      parseClaudeOauthCredentials({
        claudeAiOauth: { accessToken: "token", scopes: ["user:profile", 42] },
      }),
    ).toMatchObject({ scopes: undefined });
  });
});
