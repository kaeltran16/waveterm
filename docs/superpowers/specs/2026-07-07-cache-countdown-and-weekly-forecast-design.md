# Cache-expiry countdown + rhythm-aware weekly forecast

## Motivation

Investigating [claude-code-usage-bar](https://github.com/leeguooooo/claude-code-usage-bar) (a `statusLine`-driven CLI status bar) surfaced two features Wave's Usage surface / agent cockpit doesn't have, built on data Wave's backend already parses but currently discards after aggregation:

1. **Prompt-cache expiry countdown** — how long until the active conversation's prompt cache goes cold.
2. **Rhythm-aware weekly quota forecast** — an early-warning projection of when the weekly rate-limit window will hit 100%, instead of naive linear extrapolation that over-reacts to a busy first day.

Both are additive, read-only surfaces. Neither changes how quota is computed or enforced — Anthropic's own `%`/reset values remain authoritative.

## Feature 1: Per-agent cache-expiry countdown

### Why per-agent, not provider-aggregate

The Usage surface's Live Limits section (`usagesurface.tsx`) is provider-level — it aggregates 5-hour/weekly quota across every agent of a provider, because that's how Anthropic's rate limits work. Prompt-cache TTL is different: it's a property of one transcript's cache lineage (the most recent message that wrote to the cache, and which TTL bucket it used). It has no meaningful provider-wide aggregate. It belongs next to the other per-agent facts already shown in `AgentDetailsRail` (Tokens, Cost), not in the Usage tab.

### Backend

`pkg/usagestats/usagestats.go` already parses `cache_creation.ephemeral_1h_input_tokens` per assistant message (`extractClaude`) to feed the historical token-class split, but discards the per-record timestamp after bucketing. Add:

```go
type CacheWrite struct {
    TS      time.Time
    OneHour bool // true if the last cache-write used the extended 1h TTL bucket
}

// LastCacheWrite finds the most recent assistant record with cache-write activity in the
// transcript at path, and reports whether it used the 1h extended-cache bucket (implying a
// 3600s TTL) or the default bucket (300s TTL). Returns nil if no cache-write record exists
// (fresh conversation, or a Codex transcript — extractClaude yields nothing for those).
func LastCacheWrite(path string) (*CacheWrite, error)
```

Implementation: reuse `extractClaude(readLines(path))`, scan for `CacheCreate > 0`, keep the record with the max `TS`. No dedup pass needed — duplicate streaming snapshots of the same message share the same (or near-identical) `TS`, so taking the max is dedup-safe for this purpose.

### Wire protocol

New command, shaped identically to the existing `GetTranscriptTokensCommand`/`SumTranscript` pair:

```go
GetCacheStatusCommand(ctx context.Context, data CommandGetCacheStatusData) (*CommandGetCacheStatusRtnData, error)

type CommandGetCacheStatusData struct {
    Path string `json:"path"`
}
type CommandGetCacheStatusRtnData struct {
    LastWriteTs int64 `json:"lastwritets,omitempty"` // epoch seconds; absent = no cache-write found
    OneHour     bool  `json:"onehour,omitempty"`
}
```

`task generate` regenerates `frontend/app/store/wshclientapi.ts` and `frontend/types/gotypes.d.ts`. Per project convention, these are never hand-edited.

### Frontend

New `frontend/app/view/agents/cachestatusstore.ts`, mirroring `tokenstore.ts`'s structure exactly (including its stale-load focus-race guard via a `current.id` marker):

```ts
export const agentCacheStatusAtom = atom<{ lastWriteTs: number; oneHour: boolean } | null>(null);

export async function loadCacheStatusForAgent(id: string, transcriptPath: string | undefined): Promise<void>;

// Pure, independently testable — no atom/RPC dependency.
export function formatCacheCountdown(
    status: { lastWriteTs: number; oneHour: boolean } | null,
    nowMs: number
): string;
// ttl = status.oneHour ? 3600 : 300 (seconds)
// remaining = ttl - (nowMs / 1000 - status.lastWriteTs)
// status == null -> "—"
// remaining <= 0  -> "expired"
// else            -> e.g. "3m left" ("<1m left" under a minute)
```

`agentdetailsrail.tsx` changes:
- Call `loadCacheStatusForAgent(agent.id, agent.transcriptPath)` in the same `useEffect` as the existing `loadTokensForAgent` call (same dependency array: `[agent.id, agent.transcriptPath, agent.blockId]`).
- Add `const now = useAtomValue(model.nowAtom)` — this is already ticked globally every second by `cockpitsurface.tsx` (the cockpit shell, always mounted), so this is a free subscription, not a new interval.
- Add one row, gated to Claude agents only (matching the existing `agent.agent || "claude"` fallback convention, and matching the Weekly donut's existing "Codex quota isn't wired through the live roster yet" constraint):
  ```tsx
  {(agent.agent || "claude") === "claude" && (
      <DetailRow label="Cache expires" value={formatCacheCountdown(cacheStatus, now)} />
  )}
  ```
  placed directly after the existing `Cost` row.

### Staleness (explicitly accepted, not a new gap)

Like `Tokens`/`Cost` today, this refreshes only on focus-change (mount / `transcriptPath` change), not on a periodic interval while the rail stays open on a busy agent. This matches existing behavior in this rail rather than introducing an inconsistent new refresh pattern.

## Feature 2: Rhythm-aware weekly forecast

### Scope

Claude's Weekly donut only. The 5-hour donut is unchanged (too short a window for day-of-week rhythm to matter, and it resets too often for a projection to add value over the raw countdown). Codex is unaffected — it isn't wired into live rate-limit donuts at all today.

### Why token-shape weighting, not a true %-time-series

Anthropic's `weekpct` is an opaque, cost-weighted rate-limit percentage — Wave has no exposed conversion between raw tokens and `%` of weekly quota. A "true" rhythm model (matching what claude-code-usage-bar's long-running daemon appears to do) would log `%` readings over time and fit a day-of-week consumption model directly in `%`-space. Wave doesn't currently persist any historical time series of rate-limit readings (`ratelimitstore.ts` keeps only the latest snapshot per provider), so building that from scratch means a multi-week cold start with no useful signal on any fresh install.

Instead: reuse `stats.daily` (already loaded, already has real history from transcripts sitting on disk — no cold start) as a **relative shape**, not an absolute measure. We don't need tokens to equal `%`; we only need the *ratio* between weekdays to carry over, e.g. "Tuesdays run 1.4× an average day." That ratio is used to distribute the remaining `%` budget non-uniformly across the remaining days in the window, instead of assuming a flat pace.

**Approximation accepted:** this assumes the current week's cost-mix (model choice, cache-hit ratio) roughly resembles the historical mix. Good enough for an early-warning signal; not a guarantee. If this proves inaccurate in practice, the "true %-time-series" alternative (rejected above for cold-start reasons) remains available as a future upgrade.

### Algorithm

New pure module `frontend/app/view/agents/weeklyforecast.ts`:

```ts
export function projectWeeklyExhaustion(
    daily: { day: string; tokens: number }[], // stats.daily, whatever window is currently loaded
    weekpct: number,
    weekreset: number, // epoch seconds
    now: number         // epoch ms
): number | null // epoch ms of projected exhaustion; null = no projection to show
```

1. **Shape.** Group `daily` by `Date.getDay()` (0–6). Average tokens per weekday bucket; normalize so the mean weight across sampled weekdays = 1. A weekday with zero samples falls back to weight 1 (uniform).
2. **Minimum history gate.** Require at least 4 distinct days in `daily`. Below that, return `null` — the shape would be noise from too few samples, and this is a nice-to-have signal, not core functionality that needs a degraded/error state.
3. **Calibrate observed pace.** Compute the weighted hours elapsed since window start (`weekreset - 7d`) to now, and derive `%`-per-weight-unit from `weekpct / elapsedWeight`. This anchors the projection to actual usage so far rather than an assumed rate.
4. **Forward walk.** Step forward hour-by-hour from `now` to `weekreset`, accumulating `weight × pctPerWeightUnit` per step until the accumulated projection reaches the remaining budget (`100 - weekpct`). Return the epoch-ms of that crossing.
5. **Reset-boundary check.** If the walk reaches `weekreset` without crossing 100%, return `null` — the window is on track to reset naturally; there's nothing to warn about.

### Display

In `usagesurface.tsx`, the `MiniDonut` rendered with `title="Weekly"` for the `claude` entry in `ProviderDonuts` gains a second sub-line below the existing `"resets " + formatReset(...)`:

```
~100% by Thu 3pm
```

using the same short/mono formatting convention already used for `formatReset`/`ageStr` in that file, colored with the warning token. When `projectWeeklyExhaustion` returns `null`, the line is simply omitted — no placeholder, no error state.

## Testing

- **Go:** `usagestats_test.go` — table-driven tests for `LastCacheWrite`: picks the latest cache-write record; correctly distinguishes the 1h bucket from the default bucket; returns `nil` for a transcript with no cache-write activity; returns `nil` for a Codex-shaped transcript; returns `nil` for a missing file.
- **TS — `cachestatusstore`:** unit tests for `formatCacheCountdown` covering `null` → `"—"`, expired → `"expired"`, `<1m` → `"<1m left"`, and a live countdown → e.g. `"3m left"`.
- **TS — `weeklyforecast`:** unit tests for `buildDayOfWeekShape` (insufficient history → `null`; normalization correctness) and `projectWeeklyExhaustion`: insufficient history → `null`; uniform history → matches naive linear pace (sanity check against the degenerate case); heavier near-term weekday shape → projects exhaustion no later than a lighter one; a pace that never crosses 100% before `weekreset` → `null`. Plus `formatProjectedDate` (weekday + 12-hour time, midnight/noon edge cases).

## Non-goals

- No 5-hour-window forecast.
- No true historical `%`-time-series logging (rejected for this pass; see rationale above).
- No changes to how Anthropic's own `%`/reset values are computed, sourced, or trusted — this is a derived, best-effort overlay only.
