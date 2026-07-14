# Per-session token-usage breakdown (focused-agent detail rail)

**Date:** 2026-07-14
**Status:** Design — pending review
**Visual reference:** `Wave-token-usage-rail.dc.html` in the "wave" Claude Design project
(`claude.ai/design/p/76055164-…`). Adapted, not ported — see "Adaptation decisions".

## Problem

The focused-agent detail rail (`frontend/app/view/agents/agentdetailsrail.tsx`) shows a session's
token use as a single number ("Tokens: 1.2M") plus a single "Cost" line. For these agents cache-read
tokens are routinely 80%+ of the count while costing a fraction of input — so one "tokens" number
hides both what happened and what it cost. Users want per-class (input / output / cache read / cache
write) and per-model visibility for the focused session, with an estimated spend.

The global **Usage** surface (`usagesurface.tsx`) already does this cross-session; this brings the same
vocabulary to a single session, in the rail.

## Scope

**In:** a new collapsible **"Token usage"** rail section for the focused agent, between "Context
window" and "Subagents". Per-class split (tokens + spend), per-model breakdown, headline totals, one
data-driven insight line. A backend command returning per-model buckets for one transcript, a loader
store, and a pure aggregator with unit tests.

**Out (explicitly not this change):**
- The mockup's Context-window redesign ("82K / 200K · 118K free"). We carry only `usage.contextpct`
  today; absolute used/window sizes aren't plumbed. Context window stays the existing % bar.
- The mockup's Details trim / new "Turns" row. Details keeps its existing rows **minus** the single
  "Tokens" and "Cost" rows, which move into the new section (no duplication).
- Codex quota / rate-limit windows (unchanged).

## Data

One session = one transcript file. The backend already parses everything needed
(`pkg/usagestats/usagestats.go`): `extractClaude` / `extractCodex` yield per-message records with
`model` + the four token classes (`Input`, `Output`, `CacheRead`, `CacheCreate`, plus the 1h subset);
`dedupe` collapses streaming snapshots; `bucket` groups by `(provider, model, day)`. Today
`SumTranscript` collapses all of this to one int — that's the only gap.

Realities the UI must handle:
- **Single dominant model is the common case** (often exactly one model row); occasionally 2–3.
- **Codex** produces one record with `CacheCreate = 0` (no cache-write class) and codex pricing.
- Subagents live in **separate** transcripts — not included here (the Subagents section covers them).

## Architecture

Four thin units, each independently testable:

### 1. Backend — per-file usage command (Go)
- `usagestats.TranscriptUsage(path string) ([]Bucket, error)`: read one file, `extractClaude`; if it
  yields nothing, `extractCodex`; `dedupe`; `bucket`. Returns the existing `Bucket` shape (per
  provider/model/day — for one session usually one day, folded by model on the frontend). Empty /
  unreadable / unknown-shape → empty slice, no error. Mirrors `SumTranscript`'s parser-fallback rule.
- `GetTranscriptUsageCommand(path) -> { buckets: []UsageBucket }` in `wshrpctypes.go` /
  `wshserver.go`, reusing the existing `UsageBucket` wire type. Then `task generate` regenerates
  `wshclientapi.ts` + `gotypes.d.ts` (never hand-edited).

### 2. Frontend — pure aggregator (`sessionusage.ts`)
`aggregateSessionUsage(buckets: UsageBucket[]): SessionUsage`, no React/runtime imports, unit-tested.
Produces:
- `totalTokens`, `totalSpendUsd`
- `classes: ClassUsage[]` — the four classes with `tokens`, `spendUsd`, token% and spend%, in the
  global surface's `CLASS_ORDER` ([cacheRead, output, cacheWrite, input]) for cross-surface consistency
- `models: SessionModelUsage[]` — per model: label-ready `model` id, total tokens + spend, and its own
  per-class split (for the mini stacked bar); sorted desc by tokens
- `insight: { readTokPct, readCostPct, topCostClass } | null` — derived, not hardcoded (see below)

Spend comes from `usagepricing.ts` (`spendBreakdown`) — the single price source. No embedded table.

### 3. Frontend — loader store (`transcriptusagestore.ts`)
Mirrors `tokenstore.ts`: an atom holding `SessionUsage | null`, a `loadSessionUsage(id, path)` with the
same stale-load guard (a slow load for a prior focus can't clobber a newer one). On failure keep null.

### 4. Frontend — view (`tokenusagesection.tsx`)
Extracted into its own component (keeps `agentdetailsrail.tsx` focused) and returned as a `RailSection`.
Renders, top to bottom:
- **Header row:** "Token usage" + total tokens on the right (matches the Context-window header pattern).
- **Headline pair:** total tokens (left) and ≈ total spend (right, `--color-success`, "≈ API-equivalent").
- **Tokens bar:** one stacked bar, segments by class token share.
- **Spend bar:** one stacked bar, segments by class spend share (this is the "cache-read is cheap" story).
- **Insight** (only when meaningful): factual, data-driven — e.g.
  "Cache reads are {readTokPct}% of tokens but {readCostPct}% of spend; {topCostClass} drives the cost."
  `topCostClass` is computed (largest spend share), never assumed.
- **Per-class table:** swatch · name · tokens · % · spend, four rows.
- **By model:** a labelled divider with the model count, then per-model rows (dot · `prettyModel(id)` ·
  tokens · spend · mini stacked class bar). **When exactly one model, collapse to a single label row
  (no bar)** — the bar would duplicate the Tokens bar above.
- **Footnote:** "Priced per class from a bundled table. Subagents run in separate transcripts."
- **States:** loading skeleton (mirrors the rail's async pattern), and an empty/"no usage yet" line for
  a transcript with no parseable records.

### Colors (theme tokens only — no hex)
`input → --color-success` (green), `output → --color-accent` (blue), `cacheWrite → --color-warning`
(amber), `cacheRead → --color-cacheread` (grey). This matches `usagesurface.tsx`'s `CLASS_COLOR` and
**flips the mockup's input/output** (mockup had input=blue, output=green) for consistency.

### Refresh
The rail's existing effect loads on focus change. Add a lightweight interval (~15s) while the section is
mounted to re-scan the one file, so a live agent's breakdown doesn't sit stale (the global surface uses
60s; a single file is cheap, so 15s is fine). Cleared on unmount / focus change.

### Details section change
Remove the single "Tokens" and "Cost" `DetailRow`s (now owned by the new section). Keep Runtime,
Project, Branch, Model, Running, and Cache-expires.

## Testing
- Go: `TranscriptUsage` on a Claude fixture (multi-model, dedup), a Codex rollout (no cache-write),
  and empty/unknown files.
- TS: `aggregateSessionUsage` — single model, multi-model, codex-only, empty; class ordering; spend via
  the shared pricing; insight `topCostClass` selection; % math with a zero total.

## Consequences
- New wire command + regenerated bindings (bindings are the only generated files touched).
- `agentdetailsrail.tsx` shrinks slightly (Tokens/Cost rows out, one section import in).
- Spend remains an estimate ("≈ API-equivalent"), consistent with the global surface's framing.
