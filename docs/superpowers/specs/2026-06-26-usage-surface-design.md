# Usage Surface — Design

**Date:** 2026-06-26
**Status:** Draft (awaiting review)
**Design source of truth:** `wave-handoff/wave/project/Wave-cockpit-live.dc.html` — the `isUsage` surface (~L809-850), the side-panel Usage summary (~L422-441), and the `providers()` data model (~L2006-2013).

## 1. Overview

Implement the cockpit's **Usage** NavRail surface, today a "Coming soon" `PlaceholderSurface`. It reports real usage for the **external Claude Code agents** the cockpit observes — not Wave's built-in AI panel (`pkg/aiusechat`), which is slated for its own separate removal. The surface deliberately does **not** depend on `pkg/aiusechat`.

It is the larger, account/provider-level counterpart to the side-panel Usage summary already built in `cockpitsurface.tsx`: account-wide rate-limit windows, token spend, and a per-model breakdown — versus the per-agent context/cost bars that live in the focus view.

## 2. Goals / Non-goals

**Goals**
- A real Usage surface matching the handoff layout: top stat cards, per-provider 5-hour + weekly gauges, and a per-model breakdown.
- Drive every number from real external-agent data — no fabricated telemetry for the substance.
- **Zero new Go.** Reuse the Activity surface's transcript discovery + read path; parse and aggregate in the frontend.
- Reuse the existing usage helpers (`providerPlanUsage`, `usageLevel`, `projectsFromAgents`, `formatTokens`, `formatReset`, `PLAN_BAR`/`PLAN_TXT`) so the surface and the side-panel summary stay consistent.

**Non-goals**
- No new wshrpc command, no `task generate`, no backend token aggregator (frontend mirrors Activity; a Go aggregator is a future optimization only if the FE scan proves slow — YAGNI now).
- No dependency on `pkg/aiusechat` / `RateLimitInfo` / `AIUsage` (that subsystem is being removed).
- No removal of the Wave AI panel here — tracked as its own teardown.
- No rate-limit **token caps** or **plan-tier** labels (no faithful source — see §8).
- Codex/OpenAI token breakdown deferred (different transcript format; §8).

## 3. Architecture

Two independent data paths, composed in one surface. This split is intrinsic: window gauges are **live & pushed**; token/spend is **historical & pulled**.

### 3.1 Live path — rate-limit windows (already flowing)
Per-provider 5-hour / weekly **% + reset** come from the statusLine bridge → `AgentUsage` (`fivehourpct`, `fivehourreset`, `weekpct`, `weekreset`), already populated per block via `getAgentUsageAtom` and shaped by the existing pure helper `providerPlanUsage([...asking, ...working, ...idle])` (`agentsviewmodel.ts`). No new wiring. Subscriber-only (absent for API-key sessions) by design.

### 3.2 Historical path — tokens & spend (new, frontend-only)
Mirror the Activity surface exactly (`activitydiscovery.ts` + `activitystore.ts`), which reads transcripts with **zero new Go**:

1. **Discover:** reuse `discoverSessions()` (`activitydiscovery.ts`) — lists `~/.claude/projects/**/*.jsonl` (and `~/.codex/...`) via `FileListCommand`. Already exported.
2. **Read:** reuse `RpcApi.GetAgentTranscriptCommand(TabRpcClient, { path, maxlines })` (the existing command backed by `transcript.go:readTranscriptTail`). For accurate windowed totals, pass a large `maxlines` (e.g. `100000`) so the whole file is returned (the backend reads the full file then tails — a large cap ≈ "all"). Bound the scan to sessions whose `modtime` is within the window.
3. **Parse (new, pure):** `extractUsage(lines)` — sibling of `extractEvents`. For each `assistant` line, read `timestamp`, `message.model`, and `message.usage` (`input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`) into `UsageRecord[]`.
4. **Aggregate (new, pure):** fold records into `UsageStats` (§5) — today / trailing-week totals, per-provider per-model token sums + pct, and spend via the pricing table (§6).

### 3.3 Roster path — stat cards
Active-agents and Projects come from the live roster the surface already has: `groupAgents(agents).working.length` and `projectsFromAgents(agents).length`.

## 4. File inventory

**New (frontend)**
- `frontend/app/view/agents/usagesurface.tsx` — the surface component.
- `frontend/app/view/agents/usagestats.ts` (+ `usagestats.test.ts`) — pure: `extractUsage`, aggregation, pricing/spend, today/week filtering, per-model pct.
- `frontend/app/view/agents/usagestore.ts` — impure loader `loadUsage(model)` (mirrors `activitystore.ts`: discover → read → parse → aggregate → set atom), `usageStatsAtom`.

**Edited**
- `frontend/app/view/agents/cockpitshell.tsx` — add the `surface === "usage"` branch rendering `<UsageSurface/>`.
- `frontend/app/view/agents/placeholdersurface.tsx` — remove `usage` from `TITLES` (no longer a placeholder).
- `docs/deferred.md` — note the deferred items (§8).

**Reused (unchanged)**
- `activitydiscovery.ts` (`discoverSessions`), `GetAgentTranscriptCommand`, `providerPlanUsage`, `usageLevel`, `projectsFromAgents`, `formatTokens`, `formatReset`, `PLAN_BAR`/`PLAN_TXT`, `groupAgents`.

## 5. Data model (frontend types, in `usagestats.ts`)

```ts
interface UsageRecord {           // one assistant message
  ts: number;                     // epoch ms (Date.parse(timestamp))
  provider: string;               // "claude" | "codex" (from agent identity / model id)
  model: string;                  // raw model id
  inputTokens; outputTokens; cacheReadTokens; cacheCreateTokens: number;
}

interface ModelUsage { model: string; tokens: number; pct: number; spendUsd: number; }
interface ProviderUsage { provider: string; tokensWeek: number; models: ModelUsage[]; } // models desc by tokens
interface UsageStats {
  totals: { tokensToday: number; tokensWeek: number; spendTodayUsd: number; spendWeekUsd: number };
  providers: ProviderUsage[];     // ordered via existing PROVIDER_RANK
}
```

- `tokens` = input + output + cache (cache-read + cache-create) for the breakdown; spend weights each token class by its own price.
- **today** = since local midnight; **week** = trailing `USAGE_WINDOW_DAYS` (7, matching `ACTIVITY_WINDOW_DAYS`). Per-model `pct` = `model.tokens / provider.tokensWeek * 100`.
- Provider display label follows the cockpit convention (`claude`/`codex` identity), not the handoff's company names ("Anthropic"/"OpenAI") — flagged in §10.

## 6. Pricing table & spend

A frontend constant (single source) mapping model id → `{ input, output, cacheRead, cacheWrite }` in **$ per million tokens**. `spendUsd = Σ (tokens_class × price_class) / 1e6`. Documented as a **client-side estimate** (like Claude Code's own `cost.total_cost_usd`), with a comment to refresh prices as plans change. Unknown models price at 0 and are still counted in token totals (spend under-reports rather than guesses).

## 7. Rendering (handoff layout, reusing helpers)

Surface scaffold matches the handoff `isUsage` block (`max-width:920px` centered, scroll), built in Tailwind `@theme` tokens (no raw hex, no SCSS):
- **Header:** "Usage" + subtitle.
- **Stat cards (4):** Active agents, Projects, Tokens today, Spend today. (Handoff's "Spend today / Tokens today" now real; "Active agents" = working count; "Projects" = distinct project count.)
- **Per provider** (`providerPlanUsage` ∪ `usageStats.providers`): 5-hour gauge + weekly gauge (donut: `usageLevel` color, `% used`, reset countdown via `formatReset`), then a **By model · this week** bar list (per-model bar width = `pct`, label + pct, reusing `PLAN_BAR`).
- Donuts render the handoff's conic-gradient ring; the `% + reset` are real, the token **cap denominator is dropped** (§8).

## 8. Deviations from the handoff (no faithful source)

- **Rate-limit token cap** (`/ 2.2M tok`): Anthropic doesn't expose the subscription window's absolute cap, and transcript token sums are a *different* accounting than the rate-limit %. Drop the cap denominator; show window **% + reset** only. Real token totals live in the stat cards + per-model section. (Supersedes `FAKE_TOKEN_LIMIT` in the side-panel summary — that fabrication can be revisited separately.)
- **Plan-tier badge** (`Max 20×`, `Tier 4`): not carried by the statusLine → show the provider label only, no tier badge.
- **OpenAI/Codex section:** Claude only for v1. Codex token parsing (different JSONL shape) and the absence of an OpenAI 5h/weekly window are deferred; logged in `docs/deferred.md`. A Codex provider row appears only if real data exists for it.

## 9. States, loading, refresh

- **Load:** `loadUsage(model)` on surface mount (mirrors `activitysurface.tsx` → `loadActivity`), guarded by a module `loading` flag.
- **Refresh:** window gauges update live via atoms; the historical scan re-runs on an interval while the surface is mounted (e.g. 60s) and on mount. Cheap enough at the Activity scan's scale.
- **Empty:** no transcripts and no live usage → "No usage yet — start an agent." Window gauges hidden when no subscriber data. The historical token section can populate from disk even with **no live agents** (transcripts persist).

## 10. Error handling

- Discovery / read failures per file are swallowed per-file (skip that transcript), exactly as `loadActivity` does — one bad file never blanks the surface.
- Malformed JSONL lines are skipped in `extractUsage` (tolerant parse; the projection already assumes occasional bad lines).
- Missing `usage`/`model`/`timestamp` on a line → that line contributes nothing (not a zero-token record).

## 11. Testing

- **FE unit (vitest, following `agentsviewmodel.test.ts` / `activitystore.test.ts`):**
  - `extractUsage`: assistant line with full `usage` → record; missing fields skipped; malformed line skipped; non-assistant lines ignored.
  - aggregation: today vs trailing-week boundaries; per-model sums + pct; provider grouping + ordering.
  - spend: pricing × per-class tokens; unknown model → 0 spend but counted tokens.
  - empty input → zeroed `UsageStats`.
- **Visual (dev):** CDP screenshot (`scripts/cdp-shot.mjs`, `:9222`) of the surface with live agents; verify gauges + stat cards + per-model bars against the handoff.

## 12. Open questions

None outstanding. Resolved during brainstorming: external-agent scope (not Wave AI); zero-new-Go via reuse of Activity's discovery + `GetAgentTranscriptCommand`; caps/tier dropped as unbacked; Codex deferred; ship as one build.
