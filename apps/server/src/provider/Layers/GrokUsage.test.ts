import { describe, expect, it } from "@effect/vitest";

import { mapGrokBillingResponse } from "./GrokUsage.ts";

describe("mapGrokBillingResponse", () => {
  it("maps Grok's weekly shared pool, plan, and pay-as-you-go cap", () => {
    const result = mapGrokBillingResponse({
      config: {
        creditUsagePercent: 42,
        currentPeriod: {
          type: "USAGE_PERIOD_TYPE_WEEKLY",
          start: "2026-07-14T12:00:00+00:00",
          end: "2026-07-21T12:00:00+00:00",
        },
        onDemandCap: { val: 2500 },
        subscription_tier: "supergrok_heavy",
      },
    });

    expect(result).toEqual({
      recognized: true,
      windows: [
        {
          id: "weekly",
          label: "Weekly",
          kind: "weekly",
          usedPercent: 42,
          resetsAt: "2026-07-21T12:00:00.000Z",
          windowMinutes: 10_080,
        },
      ],
      credits: { label: "Extra usage", balance: "2500 cap" },
      planLabel: "SuperGrok Heavy",
    });
  });

  it("treats omitted proto zero values as zero and does not mislabel monthly accounts", () => {
    expect(
      mapGrokBillingResponse({
        config: {
          currentPeriod: {
            type: "USAGE_PERIOD_TYPE_WEEKLY",
            start: "2026-07-14T12:00:00Z",
            end: "2026-07-21T12:00:00Z",
          },
        },
      }),
    ).toMatchObject({
      recognized: true,
      windows: [{ usedPercent: 0 }],
      credits: { balance: "Disabled" },
    });

    expect(
      mapGrokBillingResponse({
        config: {
          creditUsagePercent: 50,
          currentPeriod: {
            type: "USAGE_PERIOD_TYPE_MONTHLY",
            start: "2026-07-01T00:00:00Z",
            end: "2026-08-01T00:00:00Z",
          },
        },
      }).windows,
    ).toEqual([]);
  });

  it("rejects unrecognized and malformed payloads", () => {
    expect(mapGrokBillingResponse(null).recognized).toBe(false);
    expect(mapGrokBillingResponse({ config: { unrelated: true } }).recognized).toBe(false);
    expect(
      mapGrokBillingResponse({
        config: {
          creditUsagePercent: "bad",
          currentPeriod: {
            type: "USAGE_PERIOD_TYPE_WEEKLY",
            start: "bad",
            end: "also-bad",
          },
        },
      }).windows,
    ).toEqual([]);
  });
});
