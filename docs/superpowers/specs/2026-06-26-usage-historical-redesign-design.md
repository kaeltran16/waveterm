# Usage Tab Redesign — Historical Block + Live-Limits Wiring

**Date:** 2026-06-26
**Status:** approved design, ready for plan
**Scope:** non-trivial. FE-only — no new Go, no new RPC (the backend usage scan and
`GetUsageStatsCommand` already landed). Implements the redesigned Usage tab from the handoff
mockup (`wave-handoff/wave/project/Wave-cockpit-live.dc.html`, `isUsage` block).

Two companion docs:
- [Usage redesign data brief](./2026-06-26-usage-redesign-data-brief.md) — the data menu (what's
  real vs fabricated). This spec designs only against §1–§4 (real data).
- [Rate-limit donut persistence](./2026-06-26-ratelimit-donut-persistence-design.md) — the full
  spec for the **live-limits** half. This doc reuses it verbatim; it is not re-specified here.

## 1. Problem

The current Usage surface (`usagesurface.tsx`) shows a single rolling-7-day view: 4 stat cards,
then per-provider rate-limit donuts + a flat by-model bar list. It collapses two distinct things
that the data actually supports separately:

- It hides the **token-class split** even though every `UsageBucket` carries
  `input/output/cacheread/cachecreate`. ~94% of Claude's token count is cache reads, so a single
  "tokens" headline misleads, and the token bar vs the spend bar tell different stories.
- It hides the **daily series** even though buckets carry `day`.
- The by-model breakdown is hard-scoped to a rolling 7 days with no all-time view.
- The donuts vanish the moment no Claude agent is running (live `AgentUsage` only exists during
  an active session), even though 5h/weekly quota is slow-moving and a last-known reading is
  still useful.

## 2. Locked decisions

1. **One feature, both blocks** — historical redesign + live-limits persistence land together.
2. **The 7-days / All-time toggle re-scopes the whole historical section** — the token-class
   split, the daily chart, and the by-model breakdown all reflect the selected window. It drives
   `loadUsage(windowDays)` with `7` or `0` (all-time); the 60s refresh uses the current window.
   The "Tokens/Spend · today" and "· 7 days" total cards are **fixed reference figures**, always
   derived from the loaded buckets regardless of window.
3. **The token-class split covers all providers combined** — so the "% are cache reads" insight
   line is **computed live** from the real buckets (it blends Claude + Codex), never hardcoded.
4. **Reload-on-toggle**, not load-all-once-and-slice. Matches the existing `loadUsage(windowDays)`
   loader; avoids re-scanning every transcript every 60s while on the 7-day view. The atom keeps
   last-good stats across the reload so the surface never blanks.
5. **All-time daily chart caps at the last 30 days**, labeled when truncated (no silent cap).
6. **Chart colors are `@theme` tokens**, not raw hex (project convention — no hardcoded colors).

## 3. Data layer

### 3.1 `usagepricing.ts` — per-class spend

`spendOf(r)` returns a single total; the split's spend bar needs per-class dollars. Add:

```ts
export interface SpendBreakdown { input: number; output: number; cacheRead: number; cacheWrite: number; }
export function spendBreakdown(r: UsageRecord): SpendBreakdown;  // $ per class (1h+5m cache writes folded into cacheWrite)
```

Refactor `spendOf` to `sum(spendBreakdown(r))` so the rate table is used in one place (DRY). The
1h vs 5m cache-write split stays internal to `spendBreakdown` (folded into `cacheWrite`). Unknown
model → all-zero breakdown (matches today's spend-0 behavior).

### 3.2 `usagestats.ts` — new shapes + restructured fold

```ts
export type TokenClass = "input" | "output" | "cacheRead" | "cacheWrite";
export interface ClassUsage { cls: TokenClass; label: string; tokens: number; spendUsd: number; }
export interface DailyUsage {
    day: string;            // "YYYY-MM-DD"
    claudeTokens: number; codexTokens: number;
    claudeSpendUsd: number; codexSpendUsd: number;
}
export interface ModelUsage { model: string; tokens: number; pct: number; spendUsd: number; } // unchanged
export interface ProviderUsage { provider: string; tokens: number; models: ModelUsage[]; }     // tokensWeek -> tokens (window-scoped)
export interface UsageStats {
    totals: { tokensToday: number; tokensWeek: number; spendTodayUsd: number; spendWeekUsd: number }; // unchanged
    split: ClassUsage[];        // all providers, the window, fixed order [cacheRead, output, cacheWrite, input]
    daily: DailyUsage[];        // ascending by day; zero-filled idle days; capped to last 30 in range
    dailyTruncated: boolean;    // true when the range exceeded 30 days (drives a label)
    providers: ProviderUsage[]; // window-scoped by-model, claude-first
}
```

`aggregateBuckets(buckets, now)` restructure — the input `buckets` is the already-loaded window:
- **Window-wide folds (always, no date filter):** accumulate per-class tokens+spend (→ `split`),
  per-day claude/codex tokens+spend (→ `daily`), per-provider per-model tokens+spend (→
  `providers`). `bucketTokens` (input+output+cacheread+cachecreate) and `spendBreakdown` per
  bucket.
- **Totals (date-filtered, as today):** `tokensWeek`/`spendWeekUsd` for `day >= weekStart`
  (rolling 7); `tokensToday`/`spendTodayUsd` for `day === today`. These keep working whether the
  window is 7d or all-time.
- **Daily zero-fill + cap:** enumerate every local day from `rangeStart` to `today`
  (`rangeStart = min bucket day`, clamped so the count ≤ 30; set `dailyTruncated` when clamped),
  filling absent days with zeros so idle days render as thin-line bars. `daily` is ascending.
- **Provider/day mapping:** `claude*` fields ← `provider === "claude"`, `codex*` ←
  `provider === "codex"`. (Only these two providers exist in practice; an unknown provider counts
  in `split`/`totals`/`providers` but not in a daily series bar — acceptable edge.)
- `providers[].models[].pct` = share of that provider's **window** tokens (was week). Claude-first.

`usagestore.ts`: `loadUsage(windowDays = 7)` is already parameterized; no change beyond the
surface passing `0` for all-time. `EMPTY` gains `split: []`, `daily: []`, `dailyTruncated: false`.

## 4. Live-limits persistence

Implemented exactly per [the donut-persistence spec](./2026-06-26-ratelimit-donut-persistence-design.md):
`ratelimitstore.ts` (new — `SavedSnapshot`, `savedRateLimitsAtom` seeded from
`localStorage["wave:ratelimits"]`, `recordRateLimit`, pure `mergeRateLimitWindows`), one capture
call in `agentstatusstore.ts`, and `usagesurface.tsx` consuming `mergeRateLimitWindows`. No
deviations. The surface renders each merged `ProviderDonuts` in the new compact card with a
state label (`live` / `as of {age} ago` / idle) and the live/stale/idle legend.

## 5. Surface layout (`usagesurface.tsx`)

Rewritten to the mockup's structure (max-width ~1060px):

1. **Header row** — title + subtitle ("Durable history… Spend is an ≈ API-equivalent estimate…")
   and a right-aligned **7 days / All time** segmented toggle (drives the reload).
2. **Live limits** card — uppercase "LIVE LIMITS" label + pulsing green dot + "ephemeral · known
   only while a Claude agent runs"; a live/as-of/idle legend; a 2-col grid of provider donut
   cards (two 40px donuts each: 5-hour, Weekly, with sub-labels + state). Caption beneath about
   per-provider snapshot persistence and Codex not yet wired.
3. **Historical** section header ("durable · every transcript in window").
4. **Totals** — 4 stat cards: Tokens·today, Spend·today, Tokens·7 days, Spend·7 days, each with a
   sub-line (e.g. "claude … · codex …", "API-equivalent", "{n}% are cache reads").
5. **"Where it goes"** card — the token-class split: a Tokens bar and a Spend bar (4 segments
   each, fixed class colors) + a 4-col legend (`tokens {str} · {pct}` / `spend {str} · {pct}` per
   class). Intro line computes the cache-read share live.
6. **Daily** card — Tokens/Spend metric toggle + claude/codex legend; a y-axis (top/mid/0) and
   per-day stacked bars (codex stacked on claude), idle days as a thin line. Label reflects window
   (and "last 30 days" when truncated).
7. **By model** — 2-col grid, one card per provider (provider title + window total + per-model
   bars showing `{tokStr} · {pct}`).

State: two local atoms or `useState` on the surface — `usageWindow: "7d" | "all"` and
`usageMetric: "tokens" | "spend"` (the daily metric toggle is pure client-side; the window toggle
triggers a reload). Number/USD/pct formatting reuses `formatTokens` where it fits; a local `usd`
and a tighter token formatter (B/M/K) match the mockup's denser cards.

## 6. Theme tokens

Add to the Tailwind `@theme` token file (where the existing `--color-*` tokens live): chart
colors for `claude` (blue), `codex` (green — may alias the existing accent/success), `cache-read`
(slate), `cache-write` (amber — may alias warning), with `input`/`output` reusing
accent/claude-blue. Use the generated utilities / `var(--color-*)`; no raw hex in markup.

## 7. Error handling

- Usage RPC failure → keep last-good `usageStatsAtom`, set `usageErrorAtom` (unchanged subtle
  banner).
- All `localStorage` access best-effort (donut spec §7): read/parse fail → `{}`; write fail
  swallowed; malformed per-provider entry ignored. Nothing throws into render.
- Empty state: when no buckets and no live/saved limits, the existing "No usage yet" message.

## 8. Testing

- **`spendBreakdown`** — per-class dollars for opus/codex/unknown; `spendOf` still equals the sum
  (regression lock).
- **`aggregateBuckets`** — split totals + class order; daily zero-fill of idle days; 30-day cap
  sets `dailyTruncated`; window-scoped by-model `pct`; `totals.today/week` correct and unaffected
  by an all-time bucket set; claude-first ordering.
- **`mergeRateLimitWindows` + `recordRateLimit`** — per donut spec §8 (live-preferred / saved sets
  stale / per-window rollover / union / claude-first / corrupt-localStorage → `{}` / non-window
  usage is a no-op), mocked `localStorage`.
- **No live regression** — with a live agent present, merged donut output equals today's.
- Visual: CDP screenshot of the dev app (no render-test harness for the cockpit).

## 9. Out of scope / non-goals

- Per-agent token/cost attribution and the agent-card diff/task/git placeholders (data brief §5).
- Cross-machine sync of saved rate limits (localStorage is per-origin, intended).
- Codex live donuts (reporter doesn't wire Codex `AgentUsage` through the live roster yet — the
  store persists whatever it gets; enablement is separate).
- Any new Go / RPC.

## 10. Self-review

- Placeholder scan: none — every rendered figure folds from real buckets (§3) or live/saved
  `AgentUsage` (§4); the "% cache reads" line is computed, not a literal.
- Consistency: shape names (`ClassUsage`/`DailyUsage`/`ProviderUsage`/`UsageStats`,
  `spendBreakdown`, `usageWindow`/`usageMetric`) used identically across §3, §5, §8.
  `tokensWeek` → window-scoped `tokens` rename called out once (§3.2) and reflected in `ProviderUsage`.
- Scope: one surface + two pure modules (pricing, stats) + one new store + one capture line; fits
  a single plan alongside the referenced donut spec.
- Ambiguity resolved: window re-scopes split/daily/by-model but NOT the today/7d total cards
  (§2.2); split is all-provider with a computed insight (§2.3); daily caps at 30 days (§2.5).
