# Usage Backend Scan — Design Spec

> Captured 2026-06-26. Reworks the data pipeline behind the **Usage** surface
> ([design](./2026-06-26-usage-surface-design.md)). Replaces the frontend transcript scan
> (`usagestore.ts` + `discoverSessions` + per-file `GetAgentTranscriptCommand`) with a single
> backend aggregate command. Mirrors the Files surface pattern (`pkg/gitinfo` + a git RPC).
>
> Motivated by measured gaps on real data (1,554 transcript files on disk): see §1.

## 1. Motivation (measured, not theoretical)

The current FE pipeline (`usagestore.ts`) scans only the **newest 150 of 1,554** transcript
files and enforces a **7-day window**, then reads each file's full contents over the
websocket. Measured against the user's real transcripts:

- **Coverage:** of 11,852 usage records in the last 7 days, **6,439 (54%) fall outside the
  newest-150 files** and are silently dropped. The by-model breakdown shows only
  `claude-opus-4-8` (+ a noise `<synthetic>` row) even though the data also contains
  `claude-sonnet-4-6`, `claude-haiku-4-5`, `claude-opus-4-7`, and several `gpt-*` models.
  Files-in-window: 7d ≈ 354, 30d ≈ 1,250, all-time ≈ 1,554.
- **Reliability:** the per-file read loop swallows errors (`catch { continue }`,
  `usagestore.ts:44`). When the websocket is transiently down (e.g. right after a reconnect),
  **all reads fail, `records` is `[]`, and `aggregateUsage([])` overwrites the atom with
  empty** — the surface shows "No usage yet — start an agent" despite billions of tokens on
  disk. Confirmed live: the surface flips between "314.8M tokens" and "0 / No usage yet" with
  no change in actual usage.
- **Tail loss:** `maxlines: 20000` returns only the file *tail*; models that appear early in
  large session files (e.g. haiku title-generation) are dropped even when the file is scanned.

These are pipeline limits, not data limits — every model and token is present on disk.
`ccusage` shows them because it scans every file with no cap, no window default, and no tail.

## 2. Goal

Move the scan to the backend so it can read **every in-window file** cheaply and return only
small aggregates. Concretely:

1. **Lift the 150-file cap** — scan all files whose modtime falls in the window (modtime is a
   reliable timestamp; verified by monotonic in-window counts).
2. **Parameterize the window** — `windowDays` argument; default 7 now, redesign can offer
   7 / 30 / all-time.
3. **Drop `<synthetic>`** — filtered during the scan so it never transfers.
4. **Harden reliability** — an RPC failure keeps the last-good data instead of clobbering it
   with empty.
5. **Read full files** — no tail; early-file models survive.

Non-goal: the visual redesign of the Usage surface (separate track). This spec only makes the
underlying data complete and reliable, and shapes the payload so the redesign can build daily
series / token-type views without re-scanning.

## 3. Governing principle: backend counts tokens, frontend prices and presents

A clean seam splits the work:

- **Backend** is a pure, deterministic token-counter: walk → prune by modtime → parse →
  dedup → bucket. It returns per-`(provider, model, day)` buckets with token-type splits. No
  pricing, no presentation, no window-relative math beyond the file prune.
- **Frontend** owns pricing (`usagepricing.ts` stays the single source of the LiteLLM/OpenAI
  table — not ported to Go) and all view aggregation (today / week / daily series /
  per-model), computed from the returned buckets.

Consequence: the backend has no opinion about "today" or cost; the volatile pricing table
lives in exactly one place; the redesign gets every view from one cheap call.

## 4. Backend: `pkg/usagestats` (new Go package)

Sibling to `pkg/gitinfo`. Pure, unit-tested, no wshrpc imports.

### 4.1 Entry point
```go
func ScanUsage(windowDays int) ([]UsageBucket, error)
```
Steps:
1. **Discover** files under `~/.claude/projects/**/*.jsonl` and
   `~/.codex/sessions/**/rollout-*.jsonl` (expand `~` via the same home resolution the
   transcript reader uses).
2. **Prune by modtime** — keep files with `modtime >= now - windowDays*24h` (minus a small
   margin to tolerate clock skew / late-written lines). `windowDays <= 0` means all-time (no
   prune).
3. **Parse** each kept file (ported from the TS extractors — see §4.3).
4. **Dedup** Claude records by `message.id:requestId`, keeping the max `output_tokens`
   snapshot (port of `dedupeUsage`). Codex yields one record per file (max cumulative).
5. **Drop** records whose model is `<synthetic>`.
6. **Bucket** by `(provider, model, localDay)` — `localDay` is the message timestamp rendered
   as `YYYY-MM-DD` in the server's local timezone (same machine as the FE in this desktop
   app) — summing the token-type splits and a message count.

### 4.2 Bucket shape
```go
type UsageBucket struct {
    Provider      string `json:"provider"`       // "claude" | "codex"
    Model         string `json:"model"`          // raw model id
    Day           string `json:"day"`            // "YYYY-MM-DD", local tz
    Input         int    `json:"input"`
    Output        int    `json:"output"`
    CacheRead     int    `json:"cacheread"`
    CacheCreate   int    `json:"cachecreate"`
    CacheCreate1h int    `json:"cachecreate1h"`  // subset of CacheCreate billed at the 1h rate
    Msgs          int    `json:"msgs"`
}
```

### 4.3 Parsing (ported from `usagestats.ts`, behavior-preserving)
- **Claude** (`extractUsage`): one record per `type:"assistant"` line with `message.usage` +
  `message.model` + parseable `timestamp`; capture input / output / cache_read /
  cache_creation / `cache_creation.ephemeral_1h_input_tokens`; dedup key
  `message.id:requestId` when both present.
- **Codex** (`extractCodexUsage`): walk `event_msg`/`token_count` lines, take the **max**
  cumulative `total_token_usage` (not the sum); model from the preceding `turn_context`;
  `cached_input_tokens` is a subset of `input_tokens`, so `input = input - cached`,
  `cacheRead = cached`. One record per file.

Malformed lines and missing fields are tolerated (skip the line), as today.

## 5. RPC (`pkg/wshrpc`)

Defined in `wshrpctypes.go`, implemented in `wshserver.go`, then regenerated with
`task generate` (produces `wshclient.go`, `wshclientapi.ts`, `gotypes.d.ts`).

```go
GetUsageStatsCommand(ctx, CommandGetUsageStatsData) (*CommandGetUsageStatsRtnData, error)

type CommandGetUsageStatsData struct {
    WindowDays int `json:"windowdays,omitempty"` // 0 = all-time
}
type CommandGetUsageStatsRtnData struct {
    Buckets []wshrpc.UsageBucket `json:"buckets"`
}
```
Implementation is a thin wrapper: `usagestats.ScanUsage(data.WindowDays)`. Errors propagate
(the FE decides how to degrade — §6).

## 6. Frontend (`usagestore.ts`, `usagestats.ts`)

### 6.1 `usagestore.ts`
- `loadUsage(windowDays = 7)` calls `RpcApi.GetUsageStatsCommand(TabRpcClient, { windowdays })`.
  Removes the `discoverSessions` import and the 150-file per-file read loop.
- On success: aggregate buckets → `UsageStats` (§6.2), set `usageStatsAtom`.
- **On error: keep the last-good atom** (do not set EMPTY). Set a separate
  `usageLoadErrorAtom` (or a `stale`/`error` flag on the stats) so the surface can show a
  subtle "couldn't refresh" indicator rather than wiping the numbers. The `loading` guard
  stays.

### 6.2 `usagestats.ts`
- Keep `UsageStats` / `ProviderUsage` / `ModelUsage`, `tokensOf`, pricing glue (`spendOf`).
- Replace the parse/dedup functions with a bucket aggregator:
  `aggregateBuckets(buckets: UsageBucket[], now): UsageStats` — **today** = buckets where
  `day === localToday(now)`; **week** = buckets where `day >= localDay(now - 6 days)` (always
  a rolling 7-day total, independent of `windowDays` — so a 30-day scan still reports a
  correct week). Group by provider→model for the bars; price each model's token split via
  `usagepricing.ts`.
- Expose the **daily series** (`{ day, provider, tokens, spendUsd }[]`) for the redesign;
  unused by the current surface but available from the same payload.
- `extractUsage` / `extractCodexUsage` / `dedupeUsage` are **removed** (logic now in Go).
  Their `usagestats.test.ts` cases port to Go (§7).

### 6.3 Untouched
`discoverSessions` / `activitydiscovery.ts` stay — the Activity surface still uses them. Only
the *usage* path moves to the backend.

## 7. Testing

- **Go (`pkg/usagestats`)**: table tests porting the existing `usagestats.test.ts` cases
  (Claude dedup keeps max output; Codex max-cumulative + cached-subset math; malformed-line
  tolerance) + new cases: `<synthetic>` filtered; a multi-model fixture proving haiku/sonnet
  survive alongside opus; modtime prune includes/excludes correctly; `windowDays=0` = all.
- **Frontend**: `aggregateBuckets` (today vs week split, per-model %, pricing) and the
  **keep-last-good-on-error** path in `loadUsage` (RPC throws → atom unchanged, error flag
  set). Mock `RpcApi.GetUsageStatsCommand`.

## 8. Migration / cleanup checklist

- Add `pkg/usagestats` + tests.
- Add the RPC type + server impl; `task generate`.
- Rewrite `usagestore.ts`; trim `usagestats.ts` (remove extractors/dedupe, add
  `aggregateBuckets` + daily series); port tests to Go; update FE tests.
- Verify the surface live (CDP): real multi-model bars, no `<synthetic>`, numbers survive a
  transient RPC failure.

## 9. Risks / open points

- **Scan latency at all-time** (1,554 files) is now a backend cost, not a transfer cost —
  acceptable for an on-demand/60s refresh, but if the redesign defaults to all-time we may
  later add a parsed-file cache keyed by `path+modtime`. Out of scope here (YAGNI).
- **Timezone**: `day` is server-local; FE and server share the machine, so "today" is
  consistent. Documented so a future remote-backend split revisits it.
- **`cacheCreate1h` pricing** already handled FE-side; the bucket split preserves the input.
