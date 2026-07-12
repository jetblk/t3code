import { describe, expect, it } from "@effect/vitest";
import type * as CodexSchema from "effect-codex-app-server/schema";

import { codexEpochToIso, codexPlanLabel, mapCodexRateLimits } from "./CodexUsage.ts";

const makeRateLimitsResponse = (
  rateLimits: Record<string, unknown>,
): CodexSchema.V2GetAccountRateLimitsResponse =>
  ({ rateLimits }) as unknown as CodexSchema.V2GetAccountRateLimitsResponse;

describe("mapCodexRateLimits", () => {
  it("maps primary, secondary, spend, credits, and plan usage", () => {
    const result = mapCodexRateLimits(
      makeRateLimitsResponse({
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
      }),
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
