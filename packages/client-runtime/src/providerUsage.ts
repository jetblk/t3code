/**
 * Client-side aggregation and presentation helpers for provider usage.
 *
 * Provider limits are account-scoped, while T3 Code can connect to several
 * environments backed by the same account. These helpers collapse duplicate
 * account snapshots without coupling the logic to React or a platform UI.
 *
 * @module providerUsage
 */
import type {
  ProviderUsageCredits,
  ProviderUsageSnapshot,
  ProviderUsageWindow,
} from "@t3tools/contracts";

/** One environment's provider-usage query state. */
export interface EnvironmentUsageInput {
  readonly environmentId: string;
  readonly environmentLabel: string;
  /** `null` until the first snapshot list arrives (loading/error). */
  readonly snapshots: ReadonlyArray<ProviderUsageSnapshot> | null;
  readonly isPending: boolean;
  readonly error: string | null;
}

/** A provider account card, possibly merged across several environments. */
export interface ProviderUsageCard {
  /** Dedupe key, stable across renders. */
  readonly key: string;
  readonly driver: ProviderUsageSnapshot["driver"];
  readonly instanceId: ProviderUsageSnapshot["instanceId"];
  readonly displayName: string;
  readonly account: string | undefined;
  readonly planLabel: string | undefined;
  readonly status: ProviderUsageSnapshot["status"];
  readonly windows: ReadonlyArray<ProviderUsageWindow>;
  readonly credits: ProviderUsageCredits | undefined;
  readonly resetCredits: ProviderUsageSnapshot["resetCredits"];
  readonly freshness: ProviderUsageSnapshot["freshness"];
  readonly message: string | undefined;
  /** Environment labels that reported this account (deduped and sorted). */
  readonly sourceNodes: ReadonlyArray<string>;
  readonly fetchedAt: string;
}

export interface ProviderUsageNodeStatus {
  readonly environmentId: string;
  readonly environmentLabel: string;
  readonly error?: string;
}

export interface AggregatedProviderUsage {
  readonly cards: ReadonlyArray<ProviderUsageCard>;
  /** Environments still loading their first result. */
  readonly pendingNodes: ReadonlyArray<ProviderUsageNodeStatus>;
  /** Environments that errored before returning any usage. */
  readonly failedNodes: ReadonlyArray<ProviderUsageNodeStatus>;
}

/** Whether every currently active environment has reported its first query state. */
export function areProviderUsageResultsComplete(
  environmentIds: ReadonlyArray<string>,
  results: Readonly<Record<string, EnvironmentUsageInput>>,
): boolean {
  return environmentIds.every((environmentId) => results[environmentId] !== undefined);
}

const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  claudeAgent: "Claude",
  codex: "Codex",
  cursor: "Cursor",
  opencode: "OpenCode",
  grok: "Grok",
};

export function providerUsageDisplayName(driver: string, snapshotName?: string): string {
  if (snapshotName && snapshotName.length > 0) return snapshotName;
  return PROVIDER_DISPLAY_NAMES[driver] ?? driver;
}

const dedupeKey = (environmentId: string, snapshot: ProviderUsageSnapshot): string =>
  snapshot.account
    ? `account:${snapshot.driver}:${snapshot.account.toLowerCase()}`
    : `instance:${environmentId}:${snapshot.instanceId}`;

/**
 * Merge every environment's snapshots into deduped account cards plus
 * pending/failed environment lists. The freshest duplicate supplies displayed
 * values; every reporting environment remains visible in `sourceNodes`.
 */
export function aggregateProviderUsage(
  inputs: ReadonlyArray<EnvironmentUsageInput>,
): AggregatedProviderUsage {
  const cards = new Map<string, { card: ProviderUsageCard; nodes: Set<string> }>();
  const pendingNodes: ProviderUsageNodeStatus[] = [];
  const failedNodes: ProviderUsageNodeStatus[] = [];

  for (const input of inputs) {
    if (input.snapshots === null) {
      if (input.error !== null) {
        failedNodes.push({
          environmentId: input.environmentId,
          environmentLabel: input.environmentLabel,
          error: input.error,
        });
      } else if (input.isPending) {
        pendingNodes.push({
          environmentId: input.environmentId,
          environmentLabel: input.environmentLabel,
        });
      }
      continue;
    }

    for (const snapshot of input.snapshots) {
      const key = dedupeKey(input.environmentId, snapshot);
      const existing = cards.get(key);
      const nextCard: ProviderUsageCard = {
        key,
        driver: snapshot.driver,
        instanceId: snapshot.instanceId,
        displayName: providerUsageDisplayName(snapshot.driver, snapshot.displayName),
        account: snapshot.account,
        planLabel: snapshot.planLabel,
        status: snapshot.status,
        windows: snapshot.windows,
        credits: snapshot.credits,
        resetCredits: snapshot.resetCredits,
        freshness: snapshot.freshness,
        message: snapshot.message,
        sourceNodes: [input.environmentLabel],
        fetchedAt: snapshot.fetchedAt,
      };

      if (!existing) {
        cards.set(key, { card: nextCard, nodes: new Set([input.environmentLabel]) });
        continue;
      }

      existing.nodes.add(input.environmentLabel);
      const winner = snapshot.fetchedAt > existing.card.fetchedAt ? nextCard : existing.card;
      existing.card = { ...winner, key, sourceNodes: existing.card.sourceNodes };
    }
  }

  const finalized = [...cards.values()].map(({ card, nodes }) => ({
    ...card,
    sourceNodes: [...nodes].sort((a, b) => a.localeCompare(b)),
  }));

  finalized.sort(
    (a, b) => a.displayName.localeCompare(b.displayName) || a.key.localeCompare(b.key),
  );

  return { cards: finalized, pendingNodes, failedNodes };
}

/** `100 - usedPercent`, clamped to the range rendered by usage meters. */
export function providerUsagePercentLeft(usedPercent: number): number {
  return Math.max(0, Math.min(100, 100 - usedPercent));
}

function formatProviderUsageFutureTime(
  atIso: string | undefined,
  nowMs: number,
  prefix: "Resets" | "Expires" | "Retries",
): string | null {
  if (!atIso) return null;
  const atMs = Date.parse(atIso);
  if (Number.isNaN(atMs)) return null;
  const diffMs = atMs - nowMs;
  if (diffMs <= 0) return null;

  const totalMinutes = Math.floor(diffMs / 60_000);
  const minutes = totalMinutes % 60;
  const totalHours = Math.floor(totalMinutes / 60);
  const hours = totalHours % 24;
  const days = Math.floor(totalHours / 24);

  if (days > 0) return `${prefix} in ${days}d ${hours}h`;
  if (totalHours > 0) {
    return minutes > 0 ? `${prefix} in ${hours}h ${minutes}m` : `${prefix} in ${hours}h`;
  }
  return `${prefix} in ${Math.max(1, minutes)}m`;
}

/** Format a future reset timestamp as a compact relative duration. */
export function formatProviderUsageReset(
  resetsAtIso: string | undefined,
  nowMs: number,
): string | null {
  return formatProviderUsageFutureTime(resetsAtIso, nowMs, "Resets");
}

/** Format a future credit expiry as a compact relative duration. */
export function formatProviderUsageExpiry(
  expiresAtIso: string | undefined,
  nowMs: number,
): string | null {
  return formatProviderUsageFutureTime(expiresAtIso, nowMs, "Expires");
}

/** Format the retry time attached to a stale provider snapshot. */
export function formatProviderUsageRetry(
  retryAtIso: string | undefined,
  nowMs: number,
): string | null {
  return formatProviderUsageFutureTime(retryAtIso, nowMs, "Retries");
}

/** Format a credit balance, preferring numeric limit data when available. */
export function formatProviderUsageCredits(credits: ProviderUsageCredits): string | null {
  if (credits.unlimited) return "Unlimited";
  if (credits.usedCredits !== undefined && credits.monthlyLimit !== undefined) {
    const left = Math.max(0, credits.monthlyLimit - credits.usedCredits);
    return `${formatDollars(left)} left · ${formatDollars(credits.monthlyLimit)} limit`;
  }
  if (credits.balance) return credits.balance;
  return null;
}

/** Percentage consumed for a numeric credit limit. */
export function providerUsageCreditsUsedPercent(credits: ProviderUsageCredits): number {
  if (
    credits.usedCredits === undefined ||
    credits.monthlyLimit === undefined ||
    credits.monthlyLimit <= 0
  ) {
    return 0;
  }
  return Math.max(0, Math.min(100, (credits.usedCredits / credits.monthlyLimit) * 100));
}

/** Whether a credit balance has enough numeric data for a meaningful usage meter. */
export function providerUsageCreditsHaveMeter(credits: ProviderUsageCredits): boolean {
  return (
    credits.usedCredits !== undefined &&
    credits.monthlyLimit !== undefined &&
    credits.monthlyLimit > 0
  );
}

function formatDollars(amount: number): string {
  return `$${amount.toFixed(2)}`;
}
