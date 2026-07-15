# Batch memory distillation

**Date:** 2026-07-15
**Status:** Design approved, pending spec review

## Problem

The `SessionEnd` hook (`agent-memory-hook`) distills durable learnings on **every** session end: read the transcript tail, spawn a headless `claude -p` pass, route candidates into memory via `MemoryLearnCommand`. Two costs:

1. **One model call per session** — expensive and redundant; nothing dedups learnings across sessions before writing.
2. **Phantom sessions** — the headless `claude -p` pass writes its own transcript under `~/.claude/projects`, which the Sessions scanner (`pkg/agentsessions`) surfaces as a real session opening with the distill prompt ("You are distilling durable learnings…").

Additionally, the inline distill makes the hook block for up to its 110s timeout on the session's turn.

## Goals

- Fewer model calls (batch several sessions into one distill).
- Better distillation quality (model sees related sessions together and dedups).
- No per-turn latency (hook returns immediately).
- Remove the phantom session from the Sessions tab.

## Non-goals

- Changing the memory write/dedup/routing model (`memvault` note storage is untouched apart from one extracted helper).
- Changing what a "durable learning" is or the JSON contract the model returns.

## Architecture

Move distillation off the hook and into wavesrv. The hook becomes a cheap enqueue. wavesrv owns a **per-cwd** pending queue and runs one combined `claude -p` distill per bucket when the bucket trips a size threshold or a max-age backstop.

Routing is per-cwd today (`MemoryLearnCommand` → `HubDirForCwd(data.Cwd)`), and a batched distill returns one flat candidate list with no per-session attribution. Therefore the queue **buckets by cwd**: only same-project sessions batch together, so routing stays correct and cross-session dedup is meaningful (same repo).

### New package: `pkg/memdistill`

Owns the queue, triggers, and the claude spawn (moved out of `cmd/wsh/cmd/wshcmd-agent-memory-hook.go`). Depends on `memvault` for routing. Initialized by wavesrv at startup.

Responsibilities:
- Persistent per-cwd pending queue.
- Enqueue + dedup + trigger evaluation.
- Max-age ticker + startup drain pass.
- Combined-tail assembly, claude spawn, JSON parse.
- Route parsed candidates through `memvault.RouteLearnings`.

### Extracted helper: `memvault.RouteLearnings`

`func RouteLearnings(cwd string, candidates []LearnCandidate, references []string) (committed, queued int, err error)`

The body of the current `MemoryLearnCommand` handler (correction→hub auto-commit, non-correction→pending tray, supersedes, references touch) moves here. Both `MemoryLearnCommand` and `memdistill` flush call it — single source of truth, no duplication.

## Components & data flow

1. **SessionEnd hook** (`agent-memory-hook`): parse stdin (`transcript_path`, `cwd`), resolve the claude binary via `exec.LookPath("claude")` to capture a known-good absolute path from the session's environment, send the new wshrpc `MemoryEnqueueSessionCommand{cwd, transcriptPath, claudePath}`, return. No claude spawn. Keeps the `WAVETERM_MEMORY_DISTILL=1` guard so the batch's own headless sub-session no-ops its SessionEnd (does not re-enqueue itself). Hook timeout reduced from 120s to 10s to match the other managed hooks.

2. **New wshrpc `MemoryEnqueueSessionCommand`**: added to `wshrpctypes.go` (interface + `CommandMemoryEnqueueSessionData{Cwd, TranscriptPath, ClaudePath}`), implemented in `wshserver`, delegating to `memdistill.Enqueue(...)`. Returns immediately; any trigger runs in a goroutine. Requires `task generate`.

3. **Queue store** (`memdistill`): a JSON file in `WAVETERM_DATA_HOME` (wavesrv is the sole writer — no locking). Shape:
   ```
   {
     "claudePath": "<last-known-good absolute path>",
     "buckets": { "<cwd>": [ { "transcriptPath": "...", "enqueuedAt": "<RFC3339>" }, ... ] }
   }
   ```
   Deduped by `transcriptPath` within a bucket. Written temp-file + rename for atomicity. Survives restart.

4. **Trigger** (on enqueue): flush the cwd's bucket when `len(bucket) >= N` **or** `now - oldest.enqueuedAt >= maxAge`. Flush runs in a goroutine; single-flight per cwd (a cwd already flushing is skipped). A low-frequency ticker (hourly) plus a one-shot startup pass re-evaluate **both** trigger conditions across all buckets — this honors the max-age backstop for a sub-threshold trickle *and* retries any bucket whose flush previously failed (e.g. left at ≥ N after an error or shutdown).

5. **Flush(cwd)**:
   - Read a capped tail per session so the combined corpus stays within budget: `perSession = combinedBudget / len(bucket)`, tail = last `min(perSession, fileSize)` bytes of each transcript.
   - Choose model on combined size, mirroring the existing cutoff: the cheaper model (`claude-haiku-4-5`) in the common case, the 1M-context model (`claude-sonnet-5`) only when the combined corpus reaches `memoryTailBytes`. Because the corpus is capped at `combinedBudget`, this is normally the cheaper model.
   - One `claude -p --model <model> <batchPrompt>`, combined corpus on stdin, session separators/labels between transcripts; env carries `WAVETERM_MEMORY_DISTILL=1`; use the stored `claudePath` (fallback `"claude"` on PATH).
   - Parse the first `{...}` block as `{candidates, references}` (tolerant, as today).
   - `memvault.RouteLearnings(cwd, candidates, references)`.
   - Clear the bucket on success; on error leave it (retried next trigger).

6. **Batch-aware prompt** (`memdistill`): same JSON contract as the current `distillPrompt`, with wording that the corpus contains multiple sessions from one project separated by markers and that learnings should be deduped/merged across them.

7. **Phantom-session filter** (`pkg/agentsessions`): skip any session whose first user prompt starts with a stable sentinel prefix of the distill prompt. Removes the batch's headless transcript from the Sessions tab.

## Defaults

- `N` (bucket size threshold) = **8**
- `maxAge` = **24h**
- `combinedBudget` ≈ **400KB** (`memoryTailBytes`, ~150K tokens)
- Max-age ticker interval = **1h**

## Error handling / fail-safety

- The hook returns `nil` on any error (a hook must never break the agent's turn).
- `memdistill` enqueue/flush errors are logged and swallowed; worst case a bucket doesn't distill.
- **claude unresolvable on wavesrv's PATH** — mitigated by the hook passing the resolved absolute path; if still not found, flush no-ops (logged), bucket retried later.
- Flush timeout per claude call retained (~110s) via context.

## Known trade-offs

- **Combined-tail truncation**: batch sees only a capped tail of each session (smaller than the current per-session tail). Acceptable — recent tail carries the durable signal.
- **Per-cwd bucketing**: working across many repos means each bucket fills slowly and leans on the max-age backstop.
- **Phantom filter is prefix-coupled** to the prompt constant; a drift test ties them together.

## Testing

- `memdistill`: enqueue + path dedup; threshold trip at N; max-age flush; per-cwd isolation; single-flight (no double flush per cwd); tail-cap sizing; tolerant JSON parse; queue persistence round-trip.
- `memvault.RouteLearnings`: correction→hub auto-commit, non-correction→pending, supersedes marks + new-note slug, references touch, no-cwd fallback to default vault (port existing `MemoryLearnCommand` coverage).
- `agentsessions`: phantom distill session is filtered out; drift test asserts the filter sentinel matches the live prompt constant.

## Migration / rollout

- No DB migration (queue is a JSON file, not a waveobj type).
- `task generate` after adding the wshrpc command.
- `install-agent-hooks` re-registers the SessionEnd hook with the new 10s timeout; `isManagedCommand` already recognizes `agent-memory-hook`, so existing installs self-heal on next launch.
