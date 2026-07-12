/**
 * Cross-node aggregation for provider usage.
 *
 * Each connected environment reports usage per provider instance. A user may
 * run several T3 Code nodes against the *same* provider account (e.g. one Max
 * subscription on a VPS and a laptop), so identical accounts are collapsed into
 * a single card that lists its source nodes — rather than showing N duplicate
 * Claude cards. Dedupe is by account identity when the driver exposes one;
 * otherwise each instance stays distinct (per environment).
 *
 * The aggregation is a pure function so it can be unit-tested without the atom
 * runtime; the screen feeds it the per-environment query results.
 *
 * @module state/providerUsage
 */
import type {
  ProviderUsageCredits,
  ProviderUsageSnapshot,
  ProviderUsageWindow,
} from "@t3tools/contracts";

/** One environment's usage query result, as surfaced by `useEnvironmentQuery`. */
export interface EnvironmentUsageInput {
  readonly environmentId: string;
  readonly environmentLabel: string;
  /** `null` until the first snapshot list arrives (loading/error). */
  readonly snapshots: ReadonlyArray<ProviderUsageSnapshot> | null;
  readonly isPending: boolean;
  readonly error: string | null;
}

/** A provider account card, possibly merged across several nodes. */
export interface ProviderUsageCard {
  /** Dedupe key — stable across renders for React keys. */
  readonly key: string;
  readonly driver: ProviderUsageSnapshot["driver"];
  readonly displayName: string;
  readonly account: string | undefined;
  readonly planLabel: string | undefined;
  readonly status: ProviderUsageSnapshot["status"];
  readonly windows: ReadonlyArray<ProviderUsageWindow>;
  readonly credits: ProviderUsageCredits | undefined;
  readonly message: string | undefined;
  /** Node labels this account was reported from (deduped, sorted). */
  readonly sourceNodes: ReadonlyArray<string>;
  readonly fetchedAt: string;
}

export interface NodeStatus {
  readonly environmentId: string;
  readonly environmentLabel: string;
  readonly error?: string;
}

export interface AggregatedProviderUsage {
  readonly cards: ReadonlyArray<ProviderUsageCard>;
  /** Nodes still loading their first result. */
  readonly pendingNodes: ReadonlyArray<NodeStatus>;
  /** Nodes that errored before returning any usage. */
  readonly failedNodes: ReadonlyArray<NodeStatus>;
}

const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  claudeAgent: "Claude",
  codex: "Codex",
  cursor: "Cursor",
  opencode: "OpenCode",
  grok: "Grok",
};

export function providerDisplayName(driver: string, snapshotName?: string): string {
  if (snapshotName && snapshotName.length > 0) return snapshotName;
  return PROVIDER_DISPLAY_NAMES[driver] ?? driver;
}

const dedupeKey = (environmentId: string, snapshot: ProviderUsageSnapshot): string =>
  snapshot.account
    ? `account:${snapshot.driver}:${snapshot.account.toLowerCase()}`
    : `instance:${environmentId}:${snapshot.instanceId}`;

/**
 * Merge every node's snapshots into deduped cards plus pending/failed node
 * lists. When the same account appears on multiple nodes the freshest snapshot
 * (by `fetchedAt`) wins for the displayed values, and every reporting node is
 * listed under `sourceNodes`.
 */
export function aggregateProviderUsage(
  inputs: ReadonlyArray<EnvironmentUsageInput>,
): AggregatedProviderUsage {
  const cards = new Map<string, { card: ProviderUsageCard; nodes: Set<string> }>();
  const pendingNodes: NodeStatus[] = [];
  const failedNodes: NodeStatus[] = [];

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
        displayName: providerDisplayName(snapshot.driver, snapshot.displayName),
        account: snapshot.account,
        planLabel: snapshot.planLabel,
        status: snapshot.status,
        windows: snapshot.windows,
        credits: snapshot.credits,
        message: snapshot.message,
        sourceNodes: [input.environmentLabel],
        fetchedAt: snapshot.fetchedAt,
      };

      if (!existing) {
        cards.set(key, { card: nextCard, nodes: new Set([input.environmentLabel]) });
        continue;
      }

      existing.nodes.add(input.environmentLabel);
      // Freshest snapshot supplies the displayed values; older duplicates only
      // contribute their node label.
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

/** `100 - usedPercent`, clamped — the "% left" the meters render. */
export function percentLeft(usedPercent: number): number {
  return Math.max(0, Math.min(100, 100 - usedPercent));
}

/**
 * "Resets in 3h 48m" / "Resets in 12m" / "Resets in 2d 4h". Pure so the screen
 * can pass a stable `nowMs`. Returns null for absent/past/invalid timestamps —
 * callers omit the line rather than showing a stale countdown.
 */
export function formatResetsIn(resetsAtIso: string | undefined, nowMs: number): string | null {
  if (!resetsAtIso) return null;
  const resetMs = Date.parse(resetsAtIso);
  if (Number.isNaN(resetMs)) return null;
  const diffMs = resetMs - nowMs;
  if (diffMs <= 0) return null;

  const totalMinutes = Math.floor(diffMs / 60_000);
  const minutes = totalMinutes % 60;
  const totalHours = Math.floor(totalMinutes / 60);
  const hours = totalHours % 24;
  const days = Math.floor(totalHours / 24);

  if (days > 0) return `Resets in ${days}d ${hours}h`;
  if (totalHours > 0)
    return minutes > 0 ? `Resets in ${hours}h ${minutes}m` : `Resets in ${hours}h`;
  return `Resets in ${Math.max(1, minutes)}m`;
}

/** "$89.09 left · $200 limit" style credit summary, or a preformatted balance. */
export function formatCredits(credits: ProviderUsageCredits): string | null {
  if (credits.unlimited) return "Unlimited";
  if (credits.usedCredits !== undefined && credits.monthlyLimit !== undefined) {
    const left = Math.max(0, credits.monthlyLimit - credits.usedCredits);
    return `${formatDollars(left)} left · ${formatDollars(credits.monthlyLimit)} limit`;
  }
  if (credits.balance) return credits.balance;
  return null;
}

function formatDollars(amount: number): string {
  return `$${amount.toFixed(2)}`;
}
