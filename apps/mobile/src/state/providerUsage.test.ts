import { describe, expect, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderUsageSnapshot,
} from "@t3tools/contracts";

import {
  aggregateProviderUsage,
  formatCredits,
  formatResetsIn,
  percentLeft,
  providerDisplayName,
  type EnvironmentUsageInput,
} from "./providerUsage.ts";

const makeSnapshot = (overrides: Partial<ProviderUsageSnapshot> = {}): ProviderUsageSnapshot => ({
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  status: "ok",
  windows: [],
  fetchedAt: "2025-01-15T10:00:00.000Z",
  ...overrides,
});

describe("aggregateProviderUsage", () => {
  it("dedupes accounts across nodes and keeps the freshest values", () => {
    const result = aggregateProviderUsage([
      {
        environmentId: "vps-1",
        environmentLabel: "vps-1",
        snapshots: [
          makeSnapshot({
            account: "person@example.com",
            planLabel: "Older plan",
            windows: [{ id: "primary", label: "Session", kind: "session", usedPercent: 20 }],
            fetchedAt: "2025-01-15T10:00:00.000Z",
          }),
        ],
        isPending: false,
        error: null,
      },
      {
        environmentId: "local",
        environmentLabel: "local",
        snapshots: [
          makeSnapshot({
            account: "person@example.com",
            planLabel: "Fresh plan",
            windows: [{ id: "primary", label: "Session", kind: "session", usedPercent: 80 }],
            fetchedAt: "2025-01-15T11:00:00.000Z",
          }),
        ],
        isPending: false,
        error: null,
      },
    ]);

    expect(result.cards).toHaveLength(1);
    expect(result.cards[0]).toMatchObject({
      key: "account:codex:person@example.com",
      planLabel: "Fresh plan",
      fetchedAt: "2025-01-15T11:00:00.000Z",
      sourceNodes: ["local", "vps-1"],
    });
    expect(result.cards[0]?.windows[0]?.usedPercent).toBe(80);
  });

  it("keeps account-less instances as separate cards", () => {
    const result = aggregateProviderUsage([
      {
        environmentId: "local",
        environmentLabel: "local",
        snapshots: [makeSnapshot()],
        isPending: false,
        error: null,
      },
      {
        environmentId: "vps-1",
        environmentLabel: "vps-1",
        snapshots: [makeSnapshot()],
        isPending: false,
        error: null,
      },
    ]);

    expect(result.cards.map((card) => card.key).sort()).toEqual([
      "instance:local:codex",
      "instance:vps-1:codex",
    ]);
  });

  it("separates pending and failed nodes from returned cards", () => {
    const inputs: ReadonlyArray<EnvironmentUsageInput> = [
      {
        environmentId: "loading",
        environmentLabel: "Loading node",
        snapshots: null,
        isPending: true,
        error: null,
      },
      {
        environmentId: "broken",
        environmentLabel: "Broken node",
        snapshots: null,
        isPending: false,
        error: "boom",
      },
      {
        environmentId: "healthy",
        environmentLabel: "Healthy node",
        snapshots: [makeSnapshot()],
        isPending: false,
        error: null,
      },
    ];

    expect(aggregateProviderUsage(inputs)).toMatchObject({
      cards: [{ key: "instance:healthy:codex" }],
      pendingNodes: [{ environmentId: "loading", environmentLabel: "Loading node" }],
      failedNodes: [{ environmentId: "broken", environmentLabel: "Broken node", error: "boom" }],
    });
  });
});

describe("usage presentation helpers", () => {
  const nowMs = Date.parse("2025-01-15T10:00:00.000Z");
  const isoIn = (milliseconds: number) => new Date(nowMs + milliseconds).toISOString();

  it("formats reset durations", () => {
    expect(formatResetsIn(undefined, nowMs)).toBeNull();
    expect(formatResetsIn(isoIn(0), nowMs)).toBeNull();
    expect(formatResetsIn("not-a-date", nowMs)).toBeNull();
    expect(formatResetsIn(isoIn(48 * 60_000), nowMs)).toBe("Resets in 48m");
    expect(formatResetsIn(isoIn((3 * 60 + 48) * 60_000), nowMs)).toBe("Resets in 3h 48m");
    expect(formatResetsIn(isoIn(3 * 60 * 60_000), nowMs)).toBe("Resets in 3h");
    expect(formatResetsIn(isoIn((2 * 24 + 4) * 60 * 60_000), nowMs)).toBe("Resets in 2d 4h");
  });

  it("formats credits", () => {
    expect(formatCredits({ label: "Credits", unlimited: true })).toBe("Unlimited");
    expect(formatCredits({ label: "Credits", usedCredits: 57.5, monthlyLimit: 200 })).toBe(
      "$142.50 left · $200.00 limit",
    );
    expect(formatCredits({ label: "Credits", balance: "42 credits" })).toBe("42 credits");
    expect(formatCredits({ label: "Credits" })).toBeNull();
  });

  it("calculates clamped percentage left", () => {
    expect(percentLeft(18)).toBe(82);
    expect(percentLeft(130)).toBe(0);
    expect(percentLeft(-5)).toBe(100);
  });

  it("uses known driver names unless a snapshot name is provided", () => {
    expect(providerDisplayName("claudeAgent")).toBe("Claude");
    expect(providerDisplayName("codex")).toBe("Codex");
    expect(providerDisplayName("cursor")).toBe("Cursor");
    expect(providerDisplayName("customDriver")).toBe("customDriver");
    expect(providerDisplayName("codex", "Work Codex")).toBe("Work Codex");
  });
});
