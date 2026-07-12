# Provider Usage in the T3 Code Mobile App

## Context

T3 Code users have no way to see how much of their AI-provider subscription limits they've consumed (Claude 5-hour/weekly windows, ChatGPT/Codex session/weekly windows). The macOS app OpenUsage (github.com/robinebers/openusage) solves this well on desktop; this plan brings equivalent, minimal v1 functionality to the T3 Code mobile app.

**Decisions (confirmed with user):**

- Subscription rate-limit windows (not API $ spend) · fetched via the T3 Code server (which owns provider credentials) · a dedicated settings screen · minimal v1 (on-demand + pull-to-refresh; no history, no push). Claude + OpenAI/Codex first; schema is provider-agnostic so Cursor/OpenCode/Grok plug in later.
- **Multi-node:** the user runs several T3 Code nodes (Linux VPS + local). The client queries **all connected environments** and **dedupes identical provider accounts** (same driver + account identity) into one card that lists its source nodes — no N duplicate Claude cards when nodes share one Max account. _Rationale (alternatives considered):_ usage is account-scoped, so an "active node only/with fallback" design would be simpler and sufficient for single-account fleets — but T3 Code ships to users who may run different provider accounts on different nodes, and fan-out + dedupe is the only design that renders that topology correctly while collapsing to one card for the single-account case. Redundant fetches are bounded by the 60s server cache + 30s client stale-time.
- **Meter orientation:** "% left" like OpenUsage ("92% left · resets in 3h 48m"). No "~X% left at reset" pace projection in v1 (needs burn-rate history).
- **Linux-first:** Claude credentials are read from the credentials file only. No macOS Keychain assumption/fallback in v1 (the user's server nodes are Linux).

**Data sources (verified from OpenUsage source):**

- **Claude:** `GET https://api.anthropic.com/api/oauth/usage` with `Authorization: Bearer <accessToken>` + `anthropic-beta: oauth-2025-04-20` + a `claude-code/x.y` User-Agent. Token read from `${claudeHome}/.claude/.credentials.json` (needs `user:profile` scope — full `claude` login, not `setup-token`). Response: `five_hour` / `seven_day` each `{utilization, resets_at}`, model-scoped windows (`seven_day_sonnet` and/or `limits[]` entries with `scope.model.display_name` — e.g. currently "Fable"), `extra_usage` `{is_enabled, used_credits, monthly_limit}`. **Model-window labels must come from the response dynamically, never hardcoded** — Anthropic renames/reshuffles these (Sonnet → Fable already happened) and may drop them entirely.
- **Codex:** no HTTP needed — the vendored `packages/effect-codex-app-server` already exposes a typed `account/rateLimits/read` JSON-RPC request (`schema.gen.ts:29769`) returning `planType`, `primary`/`secondary` windows (`usedPercent`, `resetsAt`, `windowDurationMins`), `credits`. The codex CLI handles token refresh itself — avoids the token-rotation race entirely.

## Architecture

Effect RPC over WebSocket, following existing patterns end to end:
contract schema → standalone RPC → per-driver optional `usage` capability on `ProviderInstance` → aggregation service with 60s cache → shared client-runtime query atom per environment → mobile screen that merges all environments' results and dedupes by account.

Standalone request/response RPC (not extending `ServerProvider`): provider snapshots are broadcast/persisted on a 5-min refresh loop; volatile usage data fits pull-to-refresh request semantics instead.

## Phase 1 — Contracts (`packages/contracts`)

**New `packages/contracts/src/providerUsage.ts`** (export from `index.ts`), effect-Schema style matching `server.ts`:

- `ProviderUsageWindow`: `{ id, label, kind: "session"|"weekly"|"model"|"other", usedPercent (0–100, raw from API; clients render "left"), resetsAt?: IsoDateTime, windowMinutes? }`
- `ProviderUsageCredits`: `{ label, balance?, usedCredits?, monthlyLimit?, unlimited? }`
- `ProviderUsageSnapshot`: `{ instanceId: ProviderInstanceId, driver: ProviderDriverKind, displayName?, account?: TrimmedNonEmptyString, status: "ok"|"unauthenticated"|"unsupported"|"error", planLabel?, windows: Array<ProviderUsageWindow> (decoding default []), credits?, message?, fetchedAt: IsoDateTime }` — flat struct with a `status` discriminant, like `ServerProvider` folds availability/auth into one record. **`account`** is the cross-node dedupe identity (account email from the provider's auth snapshot when known).
- `ProviderUsageResult`: `{ usage: Array<ProviderUsageSnapshot> }`

**`packages/contracts/src/rpc.ts`:** add `serverGetProviderUsage: "server.getProviderUsage"` to `WS_METHODS`; add `WsServerGetProviderUsageRpc = Rpc.make(...)` with payload `{ instanceId?: ProviderInstanceId }`, success `ProviderUsageResult`, error `EnvironmentAuthorizationError` (pattern: `WsServerGetProcessResourceHistoryRpc`, rpc.ts:305); register in `WsRpcGroup`. Per-provider failures fold into snapshot `status`/`message` — one broken provider never blanks the screen.

## Phase 2 — Server (`apps/server`)

**Capability:** `apps/server/src/provider/Services/ProviderUsage.ts` — `interface ProviderUsageShape { readonly fetchUsage: Effect.Effect<ProviderUsageSnapshot> }` (never fails; failures folded into status). Add optional `readonly usage?: ProviderUsageShape` to `ProviderInstance` in `apps/server/src/provider/ProviderDriver.ts` (alongside `snapshot`/`adapter`/`textGeneration`, line 71). Drivers without it surface as `"unsupported"` with zero changes.

**`apps/server/src/provider/Layers/CodexUsage.ts`** — `makeCodexUsage(effectiveConfig, meta)`:

1. Spawn `codex app-server` with `CODEX_HOME` from the driver's resolved home layout; `initialize` (with `capabilities: { experimentalApi: true }`) → `client.request("account/rateLimits/read", {})` — mirror/extract the spawn+init flow of `probeCodexAppServerProvider` in `Layers/CodexProvider.ts` (~line 289).
2. Pure exported mapper `mapCodexRateLimitsSnapshot(response, now)`: `primary` → session window (label derived from `windowDurationMins`), `secondary` → weekly, `individualLimit` → "Spend limit" (`100 - remainingPercent`), `credits` → credits, `planType` → `planLabel` (title-case map like `codexAccountAuthLabel`, CodexProvider.ts:69). Verify `resetsAt` epoch unit (s vs ms) against a live response.
3. Auth errors → `"unauthenticated"` ("Run `codex login` on the server machine"); `Effect.timeout("15 seconds")` + catch-all → `"error"`.
4. Wire `usage:` into the `ProviderInstance` returned by `Drivers/CodexDriver.ts` `create` (~line 202).

**`apps/server/src/provider/Layers/ClaudeUsage.ts`** — `makeClaudeUsage(claudeSettings, meta)` using `FileSystem`/`Path`/`HttpClient` (already in `ClaudeDriverEnv`):

1. `resolveClaudeHomePath` (`Drivers/ClaudeHome.ts:9`) → read + schema-parse `${home}/.claude/.credentials.json` (`claudeAiOauth: { accessToken, expiresAt?, subscriptionType?, scopes? }`). **File-only in v1** — missing/unparseable → `"unauthenticated"` ("Sign in with the `claude` CLI on the server machine"). Do NOT add macOS Keychain fallback; if a Mac-hosted node lacks the file, the unauthenticated card + message is the correct v1 behavior (possible v2 nicety). `expiresAt < now` → `"unauthenticated"` ("token expired — refreshes next time Claude runs"). **No token refresh in v1** — writing rotated tokens races Claude Code's own refresh.
2. `GET https://api.anthropic.com/api/oauth/usage` via effect `HttpClient` with the headers above; parse with a _lenient_ all-optional schema so upstream drift degrades instead of erroring.
3. Pure exported mapper `mapClaudeUsageResponse(json, meta, now)`: `five_hour` → "Session", `seven_day` → "Weekly"; **model-scoped windows get their labels from the response** — `limits[]` entries use `scope.model.display_name` verbatim (e.g. "Fable"), and any `seven_day_<model>` key is labeled from the `<model>` suffix, title-cased, never a hardcoded model name; `extra_usage` → credits. `planLabel` from credentials `subscriptionType` — reuse/export `claudeSubscriptionLabel` from `Layers/ClaudeProvider.ts` (~line 444).
4. 401/403 → `"unauthenticated"` (403 ≈ missing `user:profile` scope → "re-login with a recent Claude Code version"); else `"error"`. Wire into `Drivers/ClaudeDriver.ts` `create`.

**`apps/server/src/provider/Layers/ProviderUsageService.ts`** — Context.Service over `ProviderInstanceRegistry`:

- `getUsage(instanceId?)`: list enabled instances (filtered by `instanceId` if given); no `usage` capability → synthesize `"unsupported"` snapshot; fetch capable ones concurrently.
- Populate `snapshot.account` from the instance's provider snapshot auth (`ServerProviderAuth.email`, falling back to its `label`) so clients can dedupe across nodes.
- 60s TTL cache (`Ref<Map<instanceId, {snapshot, fetchedAtMs}>>`); cache only `"ok"` results, always retry errors. Bounds pull-to-refresh hammering and Codex process spawns.
- Compose in `apps/server/src/server.ts` near `ProviderRegistryLive` (~line 297).

**`apps/server/src/ws.ts`:** add scope entry `[WS_METHODS.serverGetProviderUsage, AuthOrchestrationReadScope]` (~line 279); handler next to `serverRefreshProviders` (~line 1245) calling `providerUsage.getUsage(input.instanceId)` wrapped in `observeRpcEffect`. Update `server.test.ts` layer if the group addition makes handlers a compile error.

Leave the existing unconsumed `account.rate-limits.updated` event (`providerRuntime.ts`) as-is — it's the v2 hook for live-push updates into this same schema (note in a comment).

## Phase 3 — Shared client runtime (`packages/client-runtime`)

In `createServerEnvironmentAtoms` (`src/state/server.ts`, return object ~line 288), add alongside `traceDiagnostics`:

```ts
providerUsage: createEnvironmentRpcQueryAtomFamily(runtime, {
  label: "environment-data:server:provider-usage",
  tag: WS_METHODS.serverGetProviderUsage,
  staleTimeMs: 30_000,
  idleTtlMs: 5 * 60_000,
}),
```

No refresh command needed — refresh via `useAtomRefresh`; the server 60s cache dedupes. Mobile picks it up automatically through `apps/mobile/src/state/server.ts`.

## Phase 4 — Mobile UI (`apps/mobile`)

**Navigation:** add `"SettingsProviderUsage"` to the union in `src/features/settings/components/settings-sheet-targets.ts`; register in `Stack.tsx` `SettingsSheetStack` (after `SettingsClientStorage`, ~line 151) with `linking: "provider-usage"`, title "Usage & Limits"; add `<SettingsRow icon="gauge.with.needle" label="Usage & Limits" target="SettingsProviderUsage" />` in `SettingsRouteScreen.tsx` — **both return branches** (signed-out ~line 103 and signed-in ~line 451).

**New `src/features/settings/SettingsProviderUsageRouteScreen.tsx`** (uniwind classes, `AppText`, `AsyncResult` branches per `SettingsClientStorageRouteScreen.tsx`), **merged multi-node view**:

- **Aggregation (new mobile state, e.g. `src/state/providerUsage.ts`):** a derived atom (or `Atom.family` keyed by nothing/catalog) that reads the environment catalog (`environmentCatalog.catalogValueAtom`) and each environment's `serverEnvironment.providerUsage({ environmentId, input: {} })` atom, combining into:
  - `cards`: snapshots grouped by dedupe key — `"${driver}:${account}"` when `account` is present; otherwise no dedupe (key = `"${environmentId}:${instanceId}"`). Each card keeps the freshest snapshot (`fetchedAt`) plus the list of source node labels (from `useSavedRemoteConnections()` / catalog names).
  - `pendingEnvironments` / `failedEnvironments` for partial-state rendering.
    Deriving in an atom (atoms compose in `@effect/atom`) avoids hooks-in-loops over the environment list.
- **Screen rendering:** show cards as environments resolve; a slim inline row per still-loading node (`ActivityIndicator` + node name) and per unreachable node ("vps-2 unreachable"). One section "Providers"; a card's subtitle shows its account + source nodes (e.g. `nick@… · via vps-1, local`) when deduped from >1 node.
- **`ProviderUsageCard({ card })`:** header = existing `ProviderIcon` (`src/components/ProviderIcon.tsx`) + display name + `planLabel` pill (e.g. "Max 20x"). Body by `status`: `ok` → `UsageWindowRow` per window + credits line; `unauthenticated` → SF symbol + `message` (+ node name so the user knows which box to log in on); `unsupported` → muted note; `error` → danger-tinted `message`.
- **`UsageWindowRow` — "% left" orientation (OpenUsage-style):** label left; meter; below it left-aligned `"92% left"` (`100 - usedPercent`, `tabular-nums`) and right-aligned `"Resets in 3h 48m"` from a pure `formatResetsIn(resetsAtIso, now)` helper. No pace projection in v1. New ~20-line `UsageMeter` (no existing mobile progress bar — `LoadingStrip` is indeterminate): rounded track `View` + inner fill `View` at `width: ${clamped}%` of _used_, color stepping at 75% used (warning) / 95% used (danger) via `useThemeColor`.
- **Credits line** mirrors the same orientation: "$89.09 left · $200 limit" (`monthlyLimit - usedCredits`), with a small meter when `monthlyLimit` is set.
- **Pull-to-refresh:** screen-level `ScrollView refreshControl={<RefreshControl …>}` triggering `useAtomRefresh` on each environment's usage atom (iterate the same stable sorted environment list the aggregate atom uses).

## Phase 5 — Tests & verification

- **Mappers (main coverage):** `ClaudeUsage.test.ts` / `CodexUsage.test.ts` — fixture JSON → expected snapshot; cases: full response, model-scoped windows with dynamic display names (assert no hardcoded model labels — fixture uses an unseen name), missing model windows entirely, disabled `extra_usage`, Codex null `secondary`, unknown `planType`, expired/malformed/missing credentials file → `"unauthenticated"`.
- **Service:** `ProviderUsageService.test.ts` with stubbed `ProviderInstanceRegistry` (pattern: `ProviderInstanceRegistryLive.test.ts`): unsupported synthesis, `account` population from snapshot auth, cache TTL, instance filtering, one failing provider doesn't affect others.
- **Client aggregation:** unit-test the pure dedupe/merge function (same account on 2 nodes → 1 card with 2 node labels + freshest snapshot; missing `account` → separate cards; mixed ok/unreachable environments).
- **Contracts:** decode round-trip + `windows` default in `providerUsage.test.ts`.
- Run `pnpm --filter @t3tools/contracts test`, server package tests, repo typecheck/lint.
- **Manual E2E:** run ≥2 server nodes logged into the same Claude account → Expo app → Settings → Usage & Limits: one Claude card listing both nodes; "% left" values match OpenUsage/`claude /usage`; pull-to-refresh ≤1 upstream fetch per node per 60s (RPC trace spans); negative paths: rename `.credentials.json` on one node → unauthenticated card naming that node; empty Codex home → "Run codex login"; take one node offline → "unreachable" row while other cards remain.

## Sequencing

1. Contracts → 2. Claude/Codex usage implementations + mapper tests → 3. `ProviderUsageService` + `server.ts`/`ws.ts` wiring → 4. client-runtime atom → 5. mobile aggregation atom + screen + navigation → 6. manual E2E.

## Risks

- `api.anthropic.com/api/oauth/usage` is undocumented and can change/break silently (model windows already renamed Sonnet → Fable; could move to API-spend-only) — lenient schema + dynamic labels + `"error"` degradation contain it. Old tokens without `user:profile` → 403.
- No Claude token refresh in v1: expired token shows "unauthenticated" until the CLI next runs on that node (deliberate — avoids rotation races).
- Dedupe depends on `account` identity from provider auth snapshots; if a provider reports no email/label, cards fall back to per-node (duplicates possible but data still correct).
- Codex fetch spawns a short-lived `codex app-server` (~1–2s) — fine with the 60s cache; v2 can reuse the adapter's long-lived connection and the already-emitted `account/rateLimits/updated` events for live push.
- Older codex CLIs without `account/rateLimits/read` fold into `"error"` with the JSON-RPC message.
