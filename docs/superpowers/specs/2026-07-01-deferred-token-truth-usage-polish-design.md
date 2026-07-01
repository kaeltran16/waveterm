# Deferred cleanup: token truth + usage polish

**Date:** 2026-07-01
**Scope:** in-repo subset of `docs/deferred.md` — the two tranches the user selected
(Token truth, Usage polish). Files-completion and external-status-reporter gaps are
explicitly out of scope.

## Problem

`docs/deferred.md` records several gaps where the cockpit renders **fabricated or
proxy** token/pricing data because a real source was not wired:

- The Agent details rail "Tokens" row shows context-window *occupancy*
  (`contextpct% × contextmax`), not cumulative tokens spent (gaps #1 and the Tokens
  part of #6).
- The 5-hour / Weekly usage bars render `used / limit tok` where **both** numbers are
  fabricated from `pct% × FAKE_TOKEN_LIMIT` (gap #5).
- The Usage surface renders raw model ids (`claude-opus-4-20250514`) instead of a
  friendly label (gap #3 "model-id prettifying").
- The pricing table has no `fable` family, so `claude-fable-5` estimates $0 (gap #3
  "pricing table").

Two other #3 sub-gaps are **not code work** and are handled by rewriting deferred.md:

- **Scan bound** — already resolved. The scan moved to the Go backend
  (`GetUsageStatsCommand` walks every in-window transcript, no file cap;
  `usagestore.ts:5`). The deferred text describing a 150-session cap in `usagestore.ts`
  is stale.
- **Rate-limit window token cap** and **plan-tier badge** — genuinely unfixable. The
  5h/weekly percentage is Anthropic's opaque server-side number with no token
  equivalent, and the plan tier is not carried by the statusLine. Document as permanent
  limitations rather than leaving them as open TODOs.

## Findings that shape the design

- **Cumulative totals need a whole-file scan.** The live transcript stream is tail-only
  (`livetranscript.ts:17`, 300 lines), so summing client-side would undercount long
  sessions. Cumulative must come from a backend whole-file read.
- **A reusable parser already exists.** `pkg/usagestats/usagestats.go` parses transcript
  JSONL into `Record`s (per-message `TS`, four token classes) via `extractClaude` /
  `extractCodex`, with `dedupe` collapsing streaming snapshots by message id. Today the
  only exported entry point is `ScanUsage(windowDays)`, which aggregates to **daily**
  buckets — too coarse for a rolling 5h window, but the record-level machinery is
  directly reusable.
- **Rate-limit windows are Claude-only.** `AgentUsage`'s `FiveHourPct`/`WeekPct` come
  from `rate_limits`, which only exist for Claude.ai sessions. Window-used sums must be
  scoped to `Provider == "claude"`.
- `AgentUsage` already carries `CostUSD`, so the rail "Cost" row is already real; only
  "Tokens" is a proxy.

## Design

### Backend — `pkg/usagestats`

Add two exported functions that reuse the existing parser/dedupe (no new parsing):

```go
// SumTranscript reads one transcript file and returns its deduped cumulative token
// total (Input+Output+CacheRead+CacheCreate), matching the Usage surface's accounting.
// Empty/unreadable/unknown-shape files return 0.
func SumTranscript(path string) (int, error)

// WindowTokens sums Claude-only deduped token totals for records at/after each cutoff,
// across the Claude transcript root. cutoffs are returned positionally. Codex is
// excluded (rate-limit windows are Claude.ai-specific).
func WindowTokens(cutoffs []time.Time) ([]int, error)
```

`SumTranscript` runs `extractClaude` first and falls back to `extractCodex` only when
the Claude parse yields no records (a Codex rollout produces no Claude records and vice
versa, so this is unambiguous and needs no provider argument). Sum the four classes
after `dedupe`.

`WindowTokens` walks the Claude root (mirrors `scanRoots`' Claude branch), prunes files
by modtime against the earliest cutoff (with the existing 1-day margin), collects+dedups
records, then for each cutoff sums the four classes of records with `TS >= cutoff`.

### Backend — wshrpc commands

Two thin commands in `wshrpctypes.go` (+ `wshserver` impl, + `task generate`):

```go
GetTranscriptTokensCommand(ctx, {Path string}) -> {Tokens int}
GetWindowTokensCommand(ctx, {FiveHourCutoff int64, WeekCutoff int64}) -> {FiveHourTokens int, WeekTokens int}
```

`GetWindowTokensCommand` takes the two window-start cutoffs (epoch seconds) computed by
the frontend and returns the Claude-only token sum newer than each. The FE anchors each
window to its real reset: `windowStart = reset − duration` (5h / 7d), using
`AgentUsage.FiveHourReset` / `WeekReset`. When a reset is nil (API-key auth, or not yet
reported), the FE falls back to `now − duration` for that window. A zero/absent cutoff
means all-time for that window.

### Frontend — Token truth

- **Rail Tokens (A1):** add `loadTokensForAgent(id, transcriptPath)` to the rail's store
  (mirrors `loadRailForAgent`), calling `GetTranscriptTokensCommand`. Store the result in
  a per-agent atom; the rail renders `formatTokens(total)` or "—" when absent (no
  transcript yet, or 0). Fire it from the same `useEffect` that loads rail git, keyed on
  `agent.id` + `agent.transcriptPath`.
- **Usage bars (A2):** a small store computes the two window-start cutoffs from the live
  rate-limit resets (`reset − duration`, `now − duration` fallback when a reset is nil)
  and loads `GetWindowTokensCommand` (refreshed on the Usage/cockpit surface mount + the
  existing rate-limit refresh cadence). Delete `FAKE_TOKEN_LIMIT` from
  `cockpitsurface.tsx`; `UsageBar` takes an optional `used?: number` and renders
  `formatTokens(used)} tok` with **no denominator** when present, nothing when absent.
  `pct` + `reset` behavior is unchanged.

### Frontend — Usage polish

- **prettyModel (B1):** new pure helper (co-located with `usagepricing.ts` or a small
  `modellabel.ts`). Best-effort: match family word (`opus`/`sonnet`/`haiku`/`fable` →
  Title case; `gpt-5.5`/`gpt-5`/`codex` → "GPT-5.5"/"GPT-5"/"Codex"), append version
  digits when present (`claude-opus-4-8` → "Opus 4.8", `claude-sonnet-4-20250514` →
  "Sonnet 4"). Unknown → return the raw id unchanged. Use at `usagesurface.tsx:315` and
  the rail `Model` row (`agentdetailsrail.tsx:102`); keep the raw id as a `title`
  tooltip.
- **Pricing (B2):** verify current per-family numbers in `usagepricing.ts` against the
  authoritative Claude pricing reference (claude-api skill), and add a `fable` family +
  its `priceFor` substring match. Any model without an authoritative figure stays
  unknown (prices 0) with a code comment noting the gap.

### Docs

Rewrite the affected `deferred.md` entries:

- Mark #1 (rail Tokens) and #5 (usage-bar fabricated) **resolved**, pointing at this work.
- Fold the #3 "model-id prettifying" and "pricing table" items into a resolved note.
- Mark #3 "scan bound" **already resolved** (stale text; backend scan has no cap).
- Rewrite #3 "rate-limit window token cap" and "plan-tier badge" as **permanent
  limitations** (no honest source), so they read as closed-by-design, not open TODOs.
- Leave Files-completion, dev wsh-routing (#2), and the reporter-gated Model row (#6)
  as open, explicitly out-of-scope entries.

## Error handling

- Missing/unreadable/empty transcript → `SumTranscript` returns 0; rail shows "—".
- Missing transcript roots → `WindowTokens` returns zeros (mirrors `scanRoots`).
- RPC failure on either command → FE keeps last-good value / shows "—"; never blanks or
  throws (mirrors `usagestore.ts`'s last-good behavior).
- Unknown model in `prettyModel` / `priceFor` → raw id / 0, never an exception.

## Testing

- Go: `usagestats_test.go` — `SumTranscript` (Claude file, Codex file, empty, dedup of
  streaming snapshots) and `WindowTokens` (records straddling a cutoff, Codex excluded,
  empty root).
- Vitest: `prettyModel` (each family + version formats + unknown fallback); `priceFor`
  for the new `fable` family.
- No render-test harness exists for the cockpit; visual verification of the rail Tokens
  row and the usage bars is a CDP pass on the live dev app (per CLAUDE.md), deferred to
  after the code lands.

## Out of scope

Files-surface completion (Codex head-read RPC, remote-worktree git routing, project
picker), the dev `wsh`-routing handoff (#2), the plan-tier badge as a *feature*, and any
change to the external status reporter under `~/.claude`.

## Implementation note

Non-trivial (two new RPC commands + `task generate`, backend + frontend, ~6 files, new
Go + TS tests). Proceeds to a written implementation plan via writing-plans.
