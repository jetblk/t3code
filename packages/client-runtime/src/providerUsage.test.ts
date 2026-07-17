import { describe, expect, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderUsageSnapshot,
} from "@t3tools/contracts";

import {
  aggregateProviderUsage,
  formatProviderUsageCredits,
  formatProviderUsageReset,
  providerUsagePercentLeft,
} from "./providerUsage.ts";

const makeSnapshot = (overrides: Partial<ProviderUsageSnapshot> = {}): ProviderUsageSnapshot => ({
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  status: "ok",
  windows: [],
  fetchedAt: "2026-07-17T10:00:00.000Z",
  ...overrides,
});

describe("aggregateProviderUsage", () => {
  it("dedupes provider accounts across environments and keeps the freshest values", () => {
    const result = aggregateProviderUsage([
      {
        environmentId: "vps",
        environmentLabel: "VPS",
        snapshots: [
          makeSnapshot({
            account: "person@example.com",
            planLabel: "Older plan",
            fetchedAt: "2026-07-17T10:00:00.000Z",
          }),
        ],
        isPending: false,
        error: null,
      },
      {
        environmentId: "local",
        environmentLabel: "Local",
        snapshots: [
          makeSnapshot({
            account: "PERSON@example.com",
            planLabel: "Current plan",
            fetchedAt: "2026-07-17T11:00:00.000Z",
          }),
        ],
        isPending: false,
        error: null,
      },
    ]);

    expect(result.cards).toHaveLength(1);
    expect(result.cards[0]).toMatchObject({
      instanceId: "codex",
      planLabel: "Current plan",
      sourceNodes: ["Local", "VPS"],
    });
  });

  it("keeps account-less instances separate and preserves partial failures", () => {
    const result = aggregateProviderUsage([
      {
        environmentId: "local",
        environmentLabel: "Local",
        snapshots: [makeSnapshot()],
        isPending: false,
        error: null,
      },
      {
        environmentId: "vps",
        environmentLabel: "VPS",
        snapshots: [makeSnapshot()],
        isPending: false,
        error: null,
      },
      {
        environmentId: "offline",
        environmentLabel: "Offline",
        snapshots: null,
        isPending: false,
        error: "unreachable",
      },
    ]);

    expect(result.cards.map((card) => card.key).sort()).toEqual([
      "instance:local:codex",
      "instance:vps:codex",
    ]);
    expect(result.failedNodes).toEqual([
      { environmentId: "offline", environmentLabel: "Offline", error: "unreachable" },
    ]);
  });
});

describe("provider usage formatting", () => {
  const nowMs = Date.parse("2026-07-17T10:00:00.000Z");

  it("formats reset times, percentages, and credits", () => {
    expect(formatProviderUsageReset("2026-07-17T13:48:00.000Z", nowMs)).toBe("Resets in 3h 48m");
    expect(providerUsagePercentLeft(130)).toBe(0);
    expect(
      formatProviderUsageCredits({ label: "Credits", usedCredits: 57.5, monthlyLimit: 200 }),
    ).toBe("$142.50 left · $200.00 limit");
  });
});
