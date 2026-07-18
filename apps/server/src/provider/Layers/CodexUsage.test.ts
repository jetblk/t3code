import { describe, expect, it } from "@effect/vitest";
import type * as CodexSchema from "effect-codex-app-server/schema";

import { codexEpochToIso, codexPlanLabel, mapCodexRateLimits } from "./CodexUsage.ts";

const makeRateLimitsResponse = (
  rateLimits: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
): CodexSchema.V2GetAccountRateLimitsResponse =>
  ({ rateLimits, ...overrides }) as unknown as CodexSchema.V2GetAccountRateLimitsResponse;

describe("mapCodexRateLimits", () => {
  it("maps primary, secondary, spend, credits, and plan usage", () => {
    const result = mapCodexRateLimits(
      makeRateLimitsResponse(
        {
          primary: { usedPercent: 20, resetsAt: 1_700_000_000, windowDurationMins: 300 },
          secondary: { usedPercent: 80, resetsAt: 1_700_000_000_000 },
          individualLimit: {
            remainingPercent: 60,
            resetsAt: 1_700_000_000,
            limit: "100",
            used: "40",
          },
          credits: { unlimited: true, hasCredits: false },
          planType: "pro",
        },
        {
          rateLimitResetCredits: {
            availableCount: 2,
            credits: [
              {
                id: "later",
                status: "available",
                resetType: "codexRateLimits",
                grantedAt: 1_700_000_000,
                expiresAt: 1_700_200_000,
                title: "Later reset",
              },
              {
                id: "used",
                status: "redeemed",
                resetType: "codexRateLimits",
                grantedAt: 1_700_000_000,
              },
              {
                id: "sooner",
                status: "available",
                resetType: "codexRateLimits",
                grantedAt: 1_700_000_000,
                expiresAt: 1_700_100_000,
                description: "Expires first",
              },
            ],
          },
        },
      ),
    );

    expect(result.windows).toEqual([
      {
        id: "primary",
        label: "Session",
        kind: "session",
        usedPercent: 20,
        resetsAt: "2023-11-14T22:13:20.000Z",
        windowMinutes: 300,
      },
      {
        id: "secondary",
        label: "Weekly",
        kind: "weekly",
        usedPercent: 80,
        resetsAt: "2023-11-14T22:13:20.000Z",
        windowMinutes: 10_080,
      },
      {
        id: "spend",
        label: "Spend limit",
        kind: "other",
        usedPercent: 40,
        resetsAt: "2023-11-14T22:13:20.000Z",
      },
    ]);
    expect(result.credits).toEqual({ label: "Credits", unlimited: true });
    expect(result.resetCredits).toEqual({
      availableCount: 2,
      credits: [
        {
          id: "sooner",
          description: "Expires first",
          expiresAt: "2023-11-16T02:00:00.000Z",
        },
        {
          id: "later",
          title: "Later reset",
          expiresAt: "2023-11-17T05:46:40.000Z",
        },
      ],
    });
    expect(result.planLabel).toBe("ChatGPT Pro 20x");
  });

  it("omits a null secondary window", () => {
    const result = mapCodexRateLimits(
      makeRateLimitsResponse({
        primary: { usedPercent: 10 },
        secondary: null,
      }),
    );

    expect(result.windows).toEqual([
      {
        id: "primary",
        label: "Session",
        kind: "session",
        usedPercent: 10,
        windowMinutes: 300,
      },
    ]);
  });

  it("classifies a sole weekly window by duration even when Codex puts it in primary", () => {
    const result = mapCodexRateLimits(
      makeRateLimitsResponse({
        primary: { usedPercent: 35, windowDurationMins: 10_080 },
        secondary: null,
      }),
    );

    expect(result.windows).toEqual([
      {
        id: "primary",
        label: "Weekly",
        kind: "weekly",
        usedPercent: 35,
        windowMinutes: 10_080,
      },
    ]);
  });

  it("maps additional limit buckets without hardcoding model names", () => {
    const result = mapCodexRateLimits(
      makeRateLimitsResponse(
        { limitId: "codex", planType: "plus" },
        {
          rateLimitsByLimitId: {
            codex: {
              limitId: "codex",
              primary: { usedPercent: 10, windowDurationMins: 300 },
              secondary: { usedPercent: 20, windowDurationMins: 10_080 },
            },
            "gpt-5.3-codex-spark": {
              limitId: "gpt-5.3-codex-spark",
              limitName: "GPT-5.3-Codex-Spark",
              primary: { usedPercent: 30, windowDurationMins: 300 },
              secondary: { usedPercent: 40, windowDurationMins: 10_080 },
            },
          },
        },
      ),
    );

    expect(result.windows).toEqual([
      {
        id: "primary",
        label: "Session",
        kind: "session",
        usedPercent: 10,
        windowMinutes: 300,
      },
      {
        id: "secondary",
        label: "Weekly",
        kind: "weekly",
        usedPercent: 20,
        windowMinutes: 10_080,
      },
      {
        id: "limit:gpt-5.3-codex-spark:session",
        label: "GPT-5.3-Codex-Spark",
        kind: "model",
        usedPercent: 30,
        windowMinutes: 300,
      },
      {
        id: "limit:gpt-5.3-codex-spark:weekly",
        label: "GPT-5.3-Codex-Spark Weekly",
        kind: "model",
        usedPercent: 40,
        windowMinutes: 10_080,
      },
    ]);
  });
});

describe("codexEpochToIso", () => {
  it("accepts seconds and millisecond epochs while rejecting invalid epochs", () => {
    expect(codexEpochToIso(1_700_000_000)).toBe("2023-11-14T22:13:20.000Z");
    expect(codexEpochToIso(1_700_000_000_000)).toBe("2023-11-14T22:13:20.000Z");
    expect(codexEpochToIso(0)).toBeUndefined();
    expect(codexEpochToIso(-1)).toBeUndefined();
    expect(codexEpochToIso(Number.NaN)).toBeUndefined();
    expect(codexEpochToIso(null)).toBeUndefined();
  });
});

describe("codexPlanLabel", () => {
  it("maps known plans and omits unmapped values", () => {
    expect(codexPlanLabel("pro")).toBe("ChatGPT Pro 20x");
    expect(codexPlanLabel("plus")).toBe("ChatGPT Plus");
    expect(codexPlanLabel("unknown")).toBe("ChatGPT");
    expect(
      codexPlanLabel(
        "not-a-plan" as unknown as CodexSchema.V2GetAccountRateLimitsResponse__PlanType,
      ),
    ).toBeUndefined();
    expect(codexPlanLabel(null)).toBeUndefined();
  });
});
