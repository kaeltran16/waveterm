# Channels tab: gone-worker outcome cards (deferred item B)

Date: 2026-07-12
Scope: single feature (backend trigger + resolution + post, plus FE rendering). Spec only — hands off to writing-plans.
Related: `docs/superpowers/specs/2026-07-10-channels-deferred-backlog-design.md` (where B was deferred), `docs/superpowers/specs/2026-07-12-channels-fleet-legibility-design.md` (the A/F/G batch, being implemented separately), `docs/agents/channels-flows.md`, `docs/superpowers/specs/2026-07-10-sessions-activity-merge-design.md` (`pkg/agentsessions`, whose extractor this reuses).

## Problem

When a worker dispatched from a channel finishes, the channel shows nothing about *what came of it*. `buildFleetSnapshot` marks a worker "gone" once its live roster row disappears and falls back to the dispatch name + task; the "Done · N" disclosure lists gone workers with no result. There is no persisted record of whether a dispatch succeeded, failed, or stalled — so an operator running a fleet can't answer "did that work?" without opening each worker's tab (which by then may be closed).

The deferred-backlog spec assumed capturing an outcome required editing the external `~/.claude` reporter (cross-repo, unverifiable). That assumption was wrong on two counts, discovered by a 2026-07-12 code scan:

- The worker-exit signal is **in-repo**: `emitAgentIdleOnExit(blockId)` (and `checkCloseOnExit(blockId, exitCode)`) already fire from the shell-proc wait loop in `pkg/blockcontroller/shellcontroller.go` when a dispatched worker's process exits — once, with the exit code in hand.
- The transcript status/summary machinery **already exists**: `pkg/agentsessions` folds a worker's transcript JSONL into a record with `Status` (`"done"` | `"failed"` | `"waiting"`), `Task`, timing, and an `Events` timeline (including a `finished` event text). The FE already matches a session's `TranscriptPath` against the live roster.

So B is wiring, not new parsing: trigger → resolve transcript → reuse the `agentsessions` extractor → resolve the dispatching channel → post a persisted outcome message → render it.

## Decisions (locked via brainstorming, 2026-07-12)

- **Content: summary + status.** Not files-changed, not a model classifier (both considered and dropped).
- **Storage: a persisted channel message**, `kind:"outcome"`, backend-posted — timeline-native, survives app restart, mirrors how Jarvis already posts `jarvis-answered`/`jarvis-escalation` cards via `postJarvisData`.
- **Trigger: worker process exit** (the `emitAgentIdleOnExit` call site), fires once. Not the per-turn `Stop` hook.
- **Status + summary: transcript heuristic via `pkg/agentsessions`.** Deterministic, no model call. Status buckets map straight from the extractor: `done`→succeeded, `failed`→failed, `waiting`→needs-review.
- **Channel resolution is NOT gatekeeper-gated.** A new `ResolveDispatchChannel` finds any channel with a `dispatch` message for the worker oref, so concierge-tier channels get outcomes too.
- **Transcript-path linkage: stamp it on durable block meta from the hook** (`agent:transcriptpath`), read at exit. *Refinement from the brainstorm:* I had leaned toward reading the path off the last retained `agent:status` event, but that event races with the exit's own idle `AgentStatusEvent` (which carries no `TranscriptPath`) and can be clobbered. A durable meta stamp is clobber-proof and is a one-line addition to the hook, which already holds the path. Absence of a stamped path is normal (skip the outcome, no error).
- **Idempotency:** post an outcome only if none newer than the worker's latest dispatch already exists for that oref. A re-dispatch (newer dispatch ts) supersedes an old outcome — identical to the shipped dismiss-ts rule.

## Non-goals

- Files-changed / diff stat on the card.
- A model-classifier status.
- Outcomes for non-agent plain terminals (`session:agent` meta absent), or for run-phase workers surfaced elsewhere — channel dispatches only, v1.
- Backfilling outcomes for workers that exited before this ships.
- Changing what "gone" means, or the "Done · N" collapse behavior.

---

## Backend

### Trigger — `emitAgentOutcome(blockId, exitCode)`

- In `pkg/blockcontroller/shellcontroller.go`, add `emitAgentOutcome(blockId, exitCode)` called from the same shell-proc exit path that already calls `emitAgentIdleOnExit` / `checkCloseOnExit`. Fire-and-forget (own goroutine + timeout ctx), like the neighbors.
- Guard to agent sessions: no-op unless the block's tab has `session:agent` meta (same gate `idleOnExitEvent` uses). Plain terminals produce no outcome.
- `exitCode` is passed for the record's data but is **not** the status source (interactive agents exit on terminal-close, not task completion — see the brainstorm caveat); status comes from the transcript.

### Transcript path — hook stamp

- In `cmd/wsh/cmd/wshcmd-agenthook.go`, when a status emission carries a transcript path (`ev.TranscriptPath != ""`), stamp it on the worker's block meta under a new key `agent:transcriptpath` (via the existing RPC/`SetMeta` path the hook already has a client for). Small, idempotent (overwrite with the latest).
- `MetaKey_AgentTranscriptPath = "agent:transcriptpath"` constant in `waveobj` meta keys, next to the other `agent:*` keys.
- At exit, `emitAgentOutcome` reads this meta off the block; empty → skip (normal for a non-agent or a worker whose hook never fired).

### Derive the outcome

- Add a single-transcript entry to `pkg/agentsessions` if one is not already exported (it extracts per-file internally today): `ExtractSession(path string) (*SessionInfo, error)` reading the file and returning the folded `SessionInfo` (reusing `extractClaudeSession` + the `events` derivation). Do not duplicate the parser.
- The outcome:
  - `status` = map `SessionInfo.Status`: `done`→`"done"`, `failed`→`"failed"`, `waiting`→`"waiting"` (pass through; the FE styles the pill).
  - `summary` = the `finished` event's text when present, else the last `SessionInfo.Events` text, trimmed to a sane cap (reuse `maxTaskLen`-style truncation). Empty transcript → skip (no useful outcome).
  - `durationMs` = `SessionInfo.DurationMs`.

### Resolve the channel — `ResolveDispatchChannel`

- New `ResolveDispatchChannel(channels []*waveobj.Channel, workerORef string) *waveobj.Channel` in `pkg/jarvis/resolve.go`, mirroring `ResolveGatekeeperChannel` but **without** the `MetaKey_GatekeeperEnabled` gate: first channel with a `dispatch` message whose `RefORef == workerORef` wins. Nil when none.

### Post — reuse `postJarvisData`

- Add `postOutcome(channelId, runtime, workerORef, summary string, status string, durationMs int64)`: builds the outcome message (`kind:"outcome"`, `author:runtime`, `text:summary`, `reforef:workerORef`, `data:` a JSON `{status, durationMs, exitCode}`), and reuses `postJarvisData`'s post + `SendWaveObjUpdate` mechanics (extract the shared post helper if `postJarvisData` is too jarvis-author-specific — the author here is the runtime, not "jarvis").
- **Idempotency guard:** before posting, load the channel and skip if an existing `outcome` message for `workerORef` has `ts` ≥ the latest `dispatch`/`directive` ts for that oref. This prevents a double-post on a re-exit/resync and lets a re-dispatch supersede.

### Backend testing

- `pkg/jarvis` Go unit: `ResolveDispatchChannel` finds a dispatch in a concierge (gatekeeper-off) channel; returns nil when no dispatch matches; picks the owning channel among several. Idempotency guard: no post when a fresh outcome exists; posts when the latest message for the oref is a dispatch.
- Outcome-derivation unit: a `SessionInfo{Status:"failed", Events:[…]}` → `{status:"failed", summary:<finished/last text>}`; a `done` session → `"done"`; empty events → skipped. Reuse `agentsessions`' existing extractor tests; do not retest the parser here.
- Do not assert on a live process exit in a unit test (that path is integration-only); the trigger wiring is verified visually.

## Frontend

### Snapshot fold — `WorkerState.outcome`

- `WorkerState` (`jarvisderive.ts`) gains `outcome?: { status: string; summary: string }`.
- In `buildFleetSnapshot`, collect the latest `outcome` message per oref (like `dismissTs`/`activeTs`), and attach it to the worker **only if** its ts > the latest dispatch/directive ts for that oref (a re-dispatch clears a stale outcome). Live workers may also carry an outcome (a worker can finish a turn and be posted an outcome while its terminal is still open) — the fold is independent of `gone`.

### Transcript — `OutcomeRow`

- New `OutcomeRow` in `channelssurface.tsx`, structured like `GatekeeperRow`: the runtime `Avatar`, author + an `outcome` tag + `timeLabel`, and a card with a **status pill** (`done`→success/green, `failed`→red/asking-tone, `waiting`→amber) and the summary text. No `open ↗` (worker gone). Wire `m.kind === "outcome"` into the transcript message map.

### Fleet panel — gone-worker status

- `WorkerRow` (`channelsprimitives.tsx`): when `w.outcome` is present, show a status glyph (✓ done / ✗ failed / ⏸ waiting) next to the name and render `w.outcome.summary` as the subline (in place of / above the task subline). Gone workers without an outcome render exactly as today.

### Frontend testing

- `jarvisderive.test.ts`: `buildFleetSnapshot` folds an `outcome` message onto its worker; ignores an outcome older than the latest dispatch (re-dispatched worker); leaves `outcome` undefined when no outcome message exists. (Vitest `toEqual` ignores `undefined`, so existing snapshot tests stay green.)
- Visual (CDP, best-effort): dispatch a worker that exits (harmless token-reply prompt under prompting perms); confirm an `OutcomeRow` appears with the correct pill and the "Done · N" row shows the glyph + summary. If a real exit + transcript can't be produced over CDP, mark unverified with the reason.

## File touch map (for plan sequencing)

**Backend (Go):**
- `pkg/blockcontroller/shellcontroller.go` — `emitAgentOutcome` + exit-path call.
- `cmd/wsh/cmd/wshcmd-agenthook.go` — stamp `agent:transcriptpath` on block meta.
- `pkg/waveobj/` (meta keys) — `MetaKey_AgentTranscriptPath`.
- `pkg/agentsessions/agentsessions.go` — export `ExtractSession(path)` if not already public.
- `pkg/jarvis/resolve.go` — `ResolveDispatchChannel`.
- `pkg/jarvis/watcher.go` (or a new `outcome.go`) — outcome derivation, `postOutcome`, idempotency guard.

**Frontend (TS/TSX):**
- `jarvisderive.ts` — `WorkerState.outcome` + fold.
- `channelssurface.tsx` — `OutcomeRow` + message-map wiring.
- `channelsprimitives.tsx` — gone `WorkerRow` status glyph + summary.

**No `task generate`** (the outcome is a channel message, not a new wshrpc command/type). `task build:backend` to compile the Go changes.

**Sequencing:** backend first (trigger → path → derive → resolve → post), then FE (fold → render). The FE fold can be built/tested against hand-authored `outcome` messages before the backend poster exists.

## Verification conventions

- Typecheck: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (baseline clean, exit 0; `npx tsc` stack-overflows here).
- FE unit: `npx vitest run frontend/app/view/agents/jarvisderive.test.ts`.
- Go unit: `go test ./pkg/jarvis/ ./pkg/agentsessions/` (sqlite-touching packages need `CGO_ENABLED=1 CC="zig cc -target x86_64-windows-gnu"` — see the memory note; `pkg/jarvis` resolver tests are pure and may not).
- Backend build: `task build:backend`.
- Visual: `tail -f /dev/null | task dev` running, capture via `node scripts/cdp-shot.mjs`; never `Page.reload`. Mark a step unverified with its reason rather than claiming a pass when the state can't be produced.
- Do not commit; the user batches commits and approves them.
