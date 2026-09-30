# Run recovery after an app restart: mark interrupted runs, stop silent relaunch, add Resume

**Verify:** `CGO_ENABLED=1 CC="zig cc -target x86_64-windows-gnu" node scripts/verify.mjs ./pkg/orchestrate/... ./pkg/jarvis/... ./pkg/wshrpc/... ./pkg/wstore/...`
**Check:** `CGO_ENABLED=1 CC="zig cc -target x86_64-windows-gnu" go vet ./pkg/orchestrate/... ./pkg/jarvis/... ./pkg/wshrpc/... ./pkg/wstore/... && CGO_ENABLED=1 CC="zig cc -target x86_64-windows-gnu" go build ./cmd/...`

**Goal:** A run whose worker died with the app says so, is never restarted behind the human's back, and can be
resumed in its own session with one click. Closes the two caveats on the F26 row of `docs/open-issues.md` (row
"A force-killed agent leaves its run `executing` forever"): nothing reconciles runs at boot, and a reopened tab
relaunches a failed worker.

## What is true today (verified 2026-09-30)

- Quit and crash leave the same state. `blockcontroller.StopAllBlockControllersForShutdown` sets `shuttingDown`,
  so `exitHook` returns nil and `orchestrate.HandleRunWorkerExit` never runs on quit; on a crash wavesrv is gone.
  Either way the run stays `executing` with a dead worker, and nothing at boot looks at it.
- A worker comes back only if its terminal mounts: `termwrap.resyncController` relaunches from the block's
  persisted `cmd:args`. `shouldRelaunchWorker` (`frontend/app/view/agents/session-models/agentresumestore.ts`)
  refuses only `done`, `failed` and `cancelled`, and no run ever has the status `failed`. A run blocked by
  `HandleRunWorkerExit` is `blocked`, so its dead worker relaunches on mount, and its eventual
  `wsh jarvis complete` errors because `CompletePhase` needs a running phase.
- A blocked non-dag run has no way forward except Cancel. `jarvis.FailPhase` has one caller
  (`HandleRunWorkerExit`), so a failed phase always means its worker exited. `BlockedCard` (`runcards.tsx`) shows
  only for a `blocked` phase or a running phase whose tab is gone (`phaseThread`, `runmodel.ts`), not for the
  `failed` phase `FailPhase` leaves. Check this live before building on it.
- `EnsureWorkers` (`pkg/jarvis/runexec.go`) launches every quick, pipeline and orchestrator-lead worker with
  `--session-id <uuid>` and records it on `Run.SessionId`. Both harnesses resume a session interactively and run
  a positional prompt as the first turn, in the same session file. Probed under ConPTY on 2026-09-30:
  `claude --resume <id> ... "<prompt>"` and `pi --session <path> ... "<prompt>"`.
- `blockcontroller.ResyncController(ctx, tabId, blockId, rtOpts, force=true)` destroys an existing or done
  controller and starts the block's command again, which is how `startWorkerController` launches a worker.

## Scope

- In: non-dag runs, meaning quick, pipeline, and an orchestrator lead before `dag submit` (`Run.DagORef == ""`).
- Out: dag runs (children and a lead after submit). The watchdog already schedules them at boot. Whether a dead
  child is ever noticed is unverified: claude children are exempt from the first-token deadline
  (`firstTokenRuntimes`, `liveness.go`). Record it in `docs/deferred.md` with a live repro as the revive step.
- Out: New Agent sessions (no `agent:runid`). A transcript scan on 2026-09-30 (798 claude and 353 pi sessions)
  found no session that replayed its launch prompt after a restart. Record the deferral with that evidence.

## Global Constraints

- Task 1 owns `pkg/orchestrate/interrupted.go` (new), `pkg/waveobj/runevent.go`, `pkg/wstore/wstore_channel.go`,
  `cmd/server/main-server.go` and their tests. Task 2 owns `pkg/jarvis/run.go`, `pkg/jarvis/runexec.go`,
  `pkg/wshrpc/wshserver/wshserver_runs.go` and their tests. Task 3 owns the frontend files it names. Task 4 owns
  the docs.
- No wire-type changes and no generated files: Resume is a new `AdvanceRunCommand` action string, and run event
  kinds are strings. If a task truly needs a wire change, edit the Go type, run `task generate`, and say why.
- Run only the focused tests that prove your change: `go test ./pkg/x -run '<names>'`, `npx vitest run <file>`.
  Go tests touching sqlite need `CGO_ENABLED=1 CC="zig cc -target x86_64-windows-gnu"`.
- `gofmt -l` and `npx prettier --check` only the files you touched; never `--write` the tree.
- Tests assert behavior, and each must fail if the behavior it names is removed.
- Colors come from existing `@theme` tokens; no new tokens.
- Commit messages: `type(scope): description`, with no attribution trailers.

### Task 1: At boot, a non-dag run whose worker died is marked interrupted
**Depends on:** none

Outcome:

- Before the watchdog starts (`orchestrate.StartWatchdog` in `cmd/server/main-server.go`), wavesrv takes every
  run with no `DagORef`, status `executing` or `planning`, and a running phase with at least one worker oref,
  and fails that phase with `jarvis.FailPhase`. At boot no worker process can be alive, so no liveness check is
  needed.
- Each such run gets a new run event `interrupted` (`RunEventKindInterrupted`, `pkg/waveobj/runevent.go`) with
  reason "the app stopped while the worker was running", and a `SendWaveObjUpdate` for the run and its channel,
  following `HandleRunWorkerExit`.
- Also add `RunEventKindWorkerResumed = "worker-resumed"` here for Task 2, documented in the same comment block.
- Untouched: dag runs, `awaiting-review`, `blocked`, terminal runs, and a running phase with no workers.
- Listing runs by status is a new `wstore` query, shaped like `GetRunsBySessionIds`.
- A failure to reconcile one run is logged with the run id and does not stop boot or the other runs.

Tests: an executing quick run with a worker becomes `blocked` with one `interrupted` event; the same run with a
`DagORef`, an `awaiting-review` run and a running phase with no workers are unchanged; a second boot pass is a
no-op.

### Task 2: Resume a blocked run's worker in its own session
**Depends on:** Task 1

Outcome:

- `AdvanceRunCommand` accepts action `resume` (`RunAction_Resume`, `pkg/jarvis/run.go`) with `PhaseIdx`. It is
  refused, with a message naming the reason, unless the run has no `DagORef`, the phase is `failed`, the run has
  a `SessionId`, the runtime is claude or pi, and the phase's worker tab still exists.
- A pure transition `jarvis.ResumePhase` moves the phase from `failed` to `running`, clears its `DoneTs` and
  recomputes the status, so the run reads `executing` again.
- The worker restarts in its existing tab, so the human keeps its scrollback, and in its existing session. Set
  the block's `cmd:args` to the runtime's resume form plus a nudge prompt, then
  `ResyncController(..., force=true)`. The resume form: claude `--resume <SessionId>`, pi `--session <SessionId>`,
  each followed by the block's `agent:baseargs`. Put the per-runtime form beside `RunWorkerSpecFor`, not in the
  frontend. Before relying on pi, confirm with one `pi -p --session <id> "..."` that a session id resolves the
  same way a path does (`pi --help`: `--session <path|id>`).
- Nudge prompt, one line: the app restarted or the worker's process stopped mid-task; check the working tree
  and the last steps, then continue the task. It must not restate the task: the session already has it.
- Append a `worker-resumed` run event and send the run and channel updates.
- A failed restart leaves the phase `failed` and returns the error. Write the state after the start succeeds,
  or roll it back.

Tests: `ResumePhase` on a failed phase and its refusal on every other phase state; the resume args for claude
and pi, with baseargs kept and the prompt last; `resume` refused for a dag run, a phase that is not failed, and a
run with no `SessionId`; a successful resume leaves the run `executing` with one `worker-resumed` event (stub
the controller start the way `startWorkerController` is stubbed).

### Task 3: The frontend stops relaunching and offers Resume
**Depends on:** none

Outcome:

- `shouldRelaunchWorker` also refuses a `blocked` run. `termwrap.resyncController`'s notice for that case says
  the worker stopped and can be resumed from its run, not that the run is over. A block with no `agent:runid`
  keeps relaunching as today.
- `phaseThread` shows the blocked card for a `failed` phase too. `BlockedCard` says the worker stopped (the app
  restarted, or its process exited) and adds **Resume** beside Cancel. Resume calls `AdvanceRunCommand` with
  `action: "resume"` and the phase index, shows the error text on refusal, and appears only when the run has a
  `sessionid` and its runtime is claude or pi.
- `runtimeline.ts` labels `interrupted` ("Interrupted by restart", warning tone) and `worker-resumed` ("Worker
  resumed"). Add them to the lists `lead-exited` and `worker-exited` appear in, including
  `frontend/app/view/orchestrate/timelinefilter.ts` if its list applies.

Tests: `shouldRelaunchWorker` for `blocked` versus `executing` with an `agent:runid`, and for a block without
one; `phaseThread` shows the blocked card for a failed phase; the Resume visibility rule.

### Task 4: Docs
**Depends on:** Task 2, Task 3

- `docs/open-issues.md`: close the two caveats on the F26 row, pointing at this plan's commits.
- `docs/orchestrator-guide.md`: update "What the backlog run left open" (the F26 bullet), and add a short
  "The app restarted mid-run" entry near "The lead is dead" that describes Interrupted, Resume and Cancel.
- `docs/deferred.md`: two entries, each with its revive trigger. First, dag runs after an app restart, revived
  by a live repro showing a dead child or lead is never noticed. Second, New Agent sessions replaying their
  launch prompt, revived when a session re-runs its prompt after a restart (evidence: the 2026-09-30 scan found
  none).
- `docs/keyboard-shortcuts.md` only if a binding was added.

## Live check (after merge, dev app)

Stop the dev app by PID only (AGENTS.md). Start a Quick run on a small goal and wait until its worker is
working, then kill the dev app's `wave-tauri.exe` PID and restart `task dev`. Expected:

1. The run reads Blocked with an "Interrupted by restart" row.
2. Opening the worker's tab does not start it.
3. Resume continues in the same session: the transcript file named by the run's `sessionid` grows, and the
   worker finishes and completes the run.

Repeat with the worker process killed alone (the F26 case): Blocked, "Worker exited", Resume works.
