# Task-Routing Phase 2 — same-tier retry, typed blocked, explicit `escalate`

Status: approved design (2026-08-25). Phase 2 of `docs/lead-authored-task-routing-roadmap.md`.
Source of truth for the roadmap's §5 + Phase 2 section; the roadmap holds the "why".

## Grounding discovery

The roadmap assumed Phase 2 would "reuse the existing retry/sendback/blocked machinery". Grounding
(the 2026-08-24 scan's "Also noted" + engine trace) shows the failure-input path does not exist:

- `wsh jarvis complete` (`jarvisCompleteCmd` → `ReportRunPhaseData{Action: "complete"}` →
  `applyRunAction` → `jarvis.CompletePhase`) marks the child phase done **unconditionally** — no
  failure status.
- Nothing writes a child run's phase to `PhaseState_Blocked`/`PhaseState_Failed`; `RunStatus_Blocked`
  is only derived by `recomputeStatus` from those phases, so `DeriveTaskStates`'s
  `RunStatus_Blocked → TaskState_Failed` mapping has no producer.
- Today `TaskState_Failed` writers are only spawn-time: route resolution, harness validation,
  worktree ensure, spawn error (engine.go), and the partial-spawn cleanup cascade.

So Phase 2 must first build the failure input the retry policy runs on. The worker-outcome pipeline
is the right source: `OnWorkerExit` → `PostOutcome` already posts a per-worker channel message with
`OutcomeData{Status: done|failed|waiting, Summary, DurationMs, ExitCode}`.

## Decision

1. **Failure input = worker outcome.** The engine consumes `PostOutcome` and marks the owning task
   failed (with a classified kind). No `wsh jarvis complete` changes; no hook changes.
2. **Kind × attempts policy, no auto model hop.** `tool_call_error` on first failure auto-retries
   same tier once (prefix-cache hit, worktree reused); every other kind blocks immediately for a
   judged hop. `unknown` kinds block (conservative — the lead judges, matching the roadmap's
   no-auto-hop intent).
3. **`escalate` verb with a one-hop cap.** `wsh jarvis dag escalate <task> [--tier mid|capable]`
   patches `RunSpec.Tier`, re-queues, and marks the task escalated; a second `escalate` on the same
   task errors (terminal for the lead; human actions retry/skip/cancel remain). The global
   `MaxConsecutiveFailures(3)` DAG circuit-break is unchanged and counts every failure.

## Design

### D1. `TaskNode` engine fields (waveobj)

Add to `TaskNode` (`pkg/waveobj/wtype.go`):

- `Attempts int` — consecutive same-kind failure count backing the auto-retry budget.
- `LastFailureKind string` — the typed blocked surface (survives lead death, visible in the DAG).
- `Escalations int` — judged-hop count; `>= 1` makes `escalate` refuse.

All engine-owned, `omitempty`, **excluded from `SameDagProposal`** (it already compares only author
fields), and **rejected at author time** by `NewTaskGroup`'s non-default engine-field check
(mirrors `State`/`RunID`/`Released`/`LastActivity`). Reset on task success (engine tick's
Running→Done branch). Run `task generate`; typecheck via
`node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (the tsc stack gotcha).

### D2. Failure input — `HandleChildOutcome`

Injection: `jarvis` exposes a `ChildOutcomeHook` package var called at the end of `PostOutcome`
(omitted when unset); `orchestrate` registers it in a new `outcome.go` `init()`. Same idiom as
`blockcontroller.AgentOutcomeHook` — jarvis imports orchestrate neither direction; the hook var
breaks the would-be cycle (orchestrate already imports jarvis).

Hook flow (mirrors `OnWorkerExit` plumbing exactly):

1. Resolve worker block: `wstore.DBMustGet[*waveobj.Block]` by the oref (`OType_Tab` → first block).
2. Read the run oref stamped on the block at spawn (`stampSpawnedWorker` stored `runORef` +
   `channelORef` in block meta). Missing/dangling → log-and-skip (the outcome message still serves
   humans; an engine miss never fails the outcome post).
3. Load run → `run.DagORef` → DAG (a dag-orchestrated child is the only case we act on).
4. Under `withDagMutation(dagID)`: **re-read fresh**; locate the task by `task.RunID == childRunID`.
   **No-op unless the task is still `Running` and still owns that `RunID`** — a completion that won
   the race (phase → done before the outcome landed) must not retro-fail a done task.
5. Classify kind (`D4`), record `Attempts`/`LastFailureKind`, increment `g.Failures`, apply policy
   (`D3`), persist `TaskGroup`, `SendWaveObjUpdate`, then `Schedule(ctx, dagID)` so status
   transitions/events fire on the fresh state.

State guard semantics: the outcome may arrive after the child's own `wsh jarvis complete` (task
already `Done` with `RunID` cleared) — treat as a no-op. The outcome may also arrive for a worker of
an already-spawned child while the task shows `Running` — that is the primary case.

### D3. Retry policy (pure)

`func retryDecision(kind string, attempts int) bool` — retry only when
`kind == FailureKindToolError && attempts == 0`.

`classify` + policy together give the roadmap table, one row per kind:
`tool_call_error` 1st → auto-retry, 2nd consecutive → blocked; `stalled`/`timeout`/`context-window`/
`gate-sendback`/`test-failed`/`unknown` → blocked immediately.

Auto-retry sequence in the handler: mark task `Failed` (so `g.Failures` streak accounting sees it),
then `RetryTask` in the same locked section (State=Pending, RunID="", worktree key unchanged →
reused). Because the final state is `Pending` and `RecomputeDagStatus` runs afterward, a one-shot
flake never blocks the DAG and never wakes the lead; a second same-kind failure stays `Failed` →
DAG blocked → existing `DagEventBlocked` + `RunEventKindDagBlocked` + `notifyLeadBestEffort` fire
(no new wake machinery needed — confirmed present in `scheduleLocked`).

### D4. Kind classifier (pure)

`func classifyFailure(summary string, exitCode int) string` — lowercase keyword match over the
outcome summary (the `outcomeSummary` last-event text), else:

| Kind | Summary evidence |
|---|---|
| `context-window` | "context window", "context limit", "length of your submission exceeds" |
| `timeout` | "timeout", "timed out" |
| `gate-sendback` | "sendback", "too hard", "out of scope" (lead-demanded revisits) |
| `test-failed` | "test", "verify", "check failed", "not passing" |
| `tool_call_error` | "tool call", "function call", "tool errored", "mcp" + error phrasing |
| `unknown` | everything else (incl. empty summary + nonzero exit) |

Heuristic by design; the table is the v1 vocabulary and `unknown → block` keeps misclassification
conservative. Classifier and policy are separate pure functions so the table can change without
touching the engine.

### D5. `escalate` verb

Mutation: new `ApplyAction` case `"escalate"` in `applyActionLocked` (+ `CommandDagActionData.Tier`
field, wshrpc, `task generate`).

1. Validate state ∈ {`failed`, `stalled`, `blocked-merge`} (mirror `skip`'s allowed set minus
   `ready`; a never-started task has nothing to escalate).
2. Validate `Escalations == 0`, else error ("task already escalated; it is blocked for the human").
3. Tier: explicit `--tier` (validated via `runroute.Resolve` against the task's runtime pair) or
   empty → `nextTier(current)` (pure: cheap→mid→capable; no step above capable → error).
4. `cancelAndStopTaskRun` (defensive — worker normally already exited), patch `RunSpec.Tier`,
   reset `Attempts`/`LastFailureKind`, `Escalations=1`, `RetryTask` (State=Pending, RunID="" —
   this IS the roadmap's "MarkPending, reuses worktree"), `RecomputeDagStatus`, persist, update.

CLI: `wsh jarvis dag escalate <task> [--tier mid|capable]` via the existing `dagAction(action)`
factory plus a tier flag, wired into `wshclient.DagActionCommand`.

### D6. Failure-kind on the blocked wake (small)

The blocked wake keeps its existing shape (`failures` count in the detail). Add the blocking kind to
the run-event detail for the typed surface:
`appendRunEvent(..., DagBlocked, map[string]any{"failures": failures, "kind": kind})` when a single
task's failure caused the block.

## Data flow (one failure)

worker exits → `OnWorkerExit` → `PostOutcome` posts outcome message → `ChildOutcomeHook` →
`HandleChildOutcome` → block meta → run → DAG → lock → classify/record/count → policy →
`RetryTask` (flake) or stay `Failed` (blocked) → `Schedule` → RecomputeDagStatus/events/lead wake.

## Error handling

- Hook resolution failures (block/run/dag missing) log-and-skip; the outcome message is the
  durable record and is not affected by engine-side misses.
- Race guards: task-must-still-own-the-run (`D2.4`) prevents retro-failing done tasks; the
  mutation lock serializes against concurrent dag actions.
- `escalate` errors are user-facing mutex-guarded messages (invalid state, already escalated, bad
  tier, no step above capable) — no silent action.

## Testing (TDD)

Pure (no harness): `classifyFailure` table incl. unknown/empty-summary cases; `retryDecision`
boundaries (`tool_call_error` × 0/1 attempts; every other kind × any attempts); `nextTier`
(cheap/mid/capable + top).

Engine (`pkg/orchestrate`, mirroring `engine_test.go` style with a harnessed
`ChildOutcomeHook` + fake outcome):
- outcome(failed, tool kind) on a running child → task failed then auto-retried (Pending, RunID
  cleared, `Attempts=1`), DAG not blocked, no lead wake.
- second same-kind failure → task stays Failed, `Attempts=2`, DAG blocked, `DagEventBlocked` fires.
- non-retry kinds (timeout/unknown) block immediately on first failure.
- race: task already Done (child completed first) → outcome is a no-op, task stays Done.
- success after retry resets `Attempts`/`LastFailureKind` and clears `g.Failures` (tick accounting).
- `escalate`: patches tier + re-queues; second escalate errors; non-failed/stalled source errors;
  bad tier pair errors; `nextTier` default path works.
- global circuit-break unchanged: three distinct failing tasks still block the DAG.

Suites: `go test ./pkg/orchestrate/ ./pkg/jarvis/ ./pkg/wshserver/` (with the CGO_CFLAGS
incantation) + tsc on the generated TS.

## Out of scope (Phase 3)

Cockpit DAG graph route display; run-evidence route tags; Phase 4 measurement gate. No frontend
changes in this phase (the escalate verb is CLI-only; blocked DAGs already surface via attention's
`dag-blocked`).