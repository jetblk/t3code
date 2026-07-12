import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { ProviderUsageResult, ProviderUsageSnapshot } from "./providerUsage.ts";

const decodeProviderUsageSnapshot = Schema.decodeUnknownSync(ProviderUsageSnapshot);
const encodeProviderUsageSnapshot = Schema.encodeSync(ProviderUsageSnapshot);
const decodeProviderUsageResult = Schema.decodeUnknownSync(ProviderUsageResult);

describe("ProviderUsageSnapshot", () => {
  it("decodes and round-trips a complete usage snapshot", () => {
    const input = {
      instanceId: "claude_personal",
      driver: "claudeAgent",
      displayName: "Claude Personal",
      account: "person@example.com",
      status: "ok",
      planLabel: "Claude Max",
      windows: [
        {
          id: "five_hour",
          label: "Session",
          kind: "session",
          usedPercent: 42,
          resetsAt: "2025-01-15T12:00:00.000Z",
          windowMinutes: 300,
        },
      ],
      credits: {
        label: "Extra usage",
        usedCredits: 12.5,
        monthlyLimit: 100,
        unlimited: false,
      },
      message: "Usage refreshed successfully.",
      fetchedAt: "2025-01-15T10:00:00.000Z",
    };

    expect(encodeProviderUsageSnapshot(decodeProviderUsageSnapshot(input))).toEqual(input);
  });

  it("defaults omitted windows to an empty array", () => {
    const decoded = decodeProviderUsageSnapshot({
      instanceId: "codex",
      driver: "codex",
      status: "unsupported",
      fetchedAt: "2025-01-15T10:00:00.000Z",
    });

    expect(decoded.windows).toEqual([]);
  });
});

describe("ProviderUsageResult", () => {
  it("decodes a usage result", () => {
    const decoded = decodeProviderUsageResult({
      usage: [
        {
          instanceId: "codex",
          driver: "codex",
          status: "ok",
          windows: [],
          fetchedAt: "2025-01-15T10:00:00.000Z",
        },
      ],
    });

    expect(decoded.usage).toHaveLength(1);
    expect(decoded.usage[0]).toMatchObject({
      instanceId: "codex",
      driver: "codex",
      status: "ok",
    });
  });
});

describe("ProviderUsageSnapshot validation", () => {
  it("rejects invalid statuses and missing required identity fields", () => {
    expect(() =>
      decodeProviderUsageSnapshot({
        instanceId: "codex",
        driver: "codex",
        status: "pending",
        windows: [],
        fetchedAt: "2025-01-15T10:00:00.000Z",
      }),
    ).toThrow();
    expect(() =>
      decodeProviderUsageSnapshot({
        driver: "codex",
        status: "ok",
        windows: [],
        fetchedAt: "2025-01-15T10:00:00.000Z",
      }),
    ).toThrow();
    expect(() =>
      decodeProviderUsageSnapshot({
        instanceId: "codex",
        driver: "codex",
        status: "ok",
        windows: [],
      }),
    ).toThrow();
  });
});
