# Orchestrator — gap scan findings (2026-08-26)

> 2026-08-26. Read-only scan of the newly-shipped phase-2 machinery (`pkg/orchestrate`
> outcome/retry/mutation), the child-ask lifecycle (`pkg/agentask`, `pkg/wshrpc/wshserver/wshserver_ask.go`),
> the lead CLI (`cmd/wsh/cmd/wshcmd-jarvisdag.go`), and the DAG graph FE (`frontend/app/view/orchestrate/`).
> The 08-24 engine findings (O1–O8) and 08-25 reliability findings (R1–R5) are all closed; this brief
> records what remains. Sequencing is deliberately **not decided here** — this doc records problems
> only; each fix batch gets its own spec/plan against these findings.

## Provenance and confidence

- Findings marked **verified** were re-read in source by the scanning session, including the exact
  line cited.
- Nothing here was reproduced in a live run; treat "why it matters" as reasoned, not measured.
- The docs trail the code (see the final section); findings below are grounded in current source, not
  in the older scan briefs that may still describe pre-fix behavior.

## Engine

### G1. `wsh jarvis dag sendback` deadlocks the DAG — gate left `Running` with no child · verified · S

`SendBackGate` reopens a done gate by setting `State = TaskState_Running`, clearing `RunID`
(`pkg/orchestrate/scheduler.go:106-120`). But the scheduler never re-spawns a `Running` task:
`NextToSpawn` -> `ReadyTasks` returns only `Pending` tasks whose deps are terminal
(`pkg/orchestrate/scheduler.go:25-41`), and `NextToSpawn` counts `Running` toward the parallelism
budget (`scheduler.go:61-62`). So after sendback:

- the gate sits `running` forever with no child run, never respawned,
- it permanently occupies one parallelism slot,
- the DAG status recomputes to `running` (the gate is neither done, failed, nor gate-halted), so
  nothing surfaces — a silent deadlock,
- `DeriveTaskStates` only touches tasks with a `RunID` (`pkg/orchestrate/dag.go:266-282`), so nothing
  ever derives it back.

The engine's own test comment states the required invariant: *"a retried task must return to pending
so NextToSpawn picks it up again — 'running' with no runid would count against the parallelism budget
yet never spawn (deadlock)"* (`pkg/orchestrate/scheduler_test.go:125-127`) — and `RetryTask` correctly
returns to `Pending` (`scheduler.go:123-137`). `SendBackGate` is the one action that does not. The
unit test even **codifies the bad state**: it asserts the gate ends in `TaskState_Running`
(`pkg/orchestrate/scheduler_test.go:93-101`), so the deadlock passes CI.

**Direction:** mirror `RetryTask` — `SendBackGate` sets `State = TaskState_Pending` (fresh spawn into
a recycled worktree via `EnsureRunWorktree`), and the test asserts `Pending` instead of `Running`.

### G2. Auto-retried flake increments the DAG-wide failure streak · verified · S (policy question)

`HandleChildOutcome` increments `g.Failures++` before the retry decision, and the auto-retry path
never decrements it (`pkg/orchestrate/outcome.go:59-76`). One tool-error on task A that auto-retries
to a clean success still moves the circuit-break counter toward `MaxConsecutiveFailures = 3`
(`pkg/orchestrate/dag.go:70`). Two concurrent one-shot flakes plus one unrelated manual failure block
the whole DAG (`blocked`, "stop and ask") even though every failure auto-recovered. The retry tests
**assert this behavior deliberately** — "concurrent one-shot flakes trip the breaker though no task
stays failed" (`pkg/orchestrate/circuitbreak_test.go`) — so it is a policy decision, not an accident,
but it contradicts the phase-2 plan's framing of same-tier retry as a same-tier recovery rather than a
failure. A fresh success does clear the streak via the tick accounting (`pkg/orchestrate/engine.go:226-232`),
so the counter only lies transiently — but "transiently" is exactly when the breaker trips.

**Question for the lead/human:** should a flake that auto-retries and then succeeds count as a
consecutive failure, or should the retry decrement `g.Failures` when the replacement attempt succeeds?
(v1 answer implied by the test: it counts.)

## Worktree / merge

### G4. `MergeContinue` has zero callers — blocked-merge is a dead end in the UI · verified · M

`MergeContinue` exists (`pkg/orchestrate/merge.go:31`) but nothing calls it: no CLI
(`wsh jarvis dag merge --continue` is absent; `cmd/wsh/cmd/wshcmd-jarvisdag.go` has only the plain
`merge <task-id>` verb), no RPC, no FE path. Meanwhile the FE maps `blocked-merge` tasks to action
`["resolve"]` (`frontend/app/view/orchestrate/dagstore.ts:31`), and `runAction` dispatches it as
`action: "resolve"` (`frontend/app/view/orchestrate/daggraph.tsx:255-262`) — but `applyActionLocked`
has no `resolve` case, so the backend rejects it with `unknown dag action "resolve"`
(`pkg/orchestrate/mutation.go:118-177`).

Net effect: a squash-merge conflict (`ErrMergeConflict` -> `MarkBlockedMerge`,
`pkg/wshrpc/wshserver/wshserver_dag.go:270`) puts the task in `blocked-merge`, and the only UI button
on that task errors. The spec's "surfaced for manual resolution in the main tree, then
`merge --continue`" (`docs/superpowers/specs/2026-08-15-orchestrator-engine-design.md`) never landed
end-to-end. `escalate` accepts `BlockedMerge` state (`pkg/orchestrate/mutation.go:84`), so a merge
conflict's only exits today are escalate (re-queue on a higher tier — arguably wrong for a conflict)
or cancel the DAG.

**Direction:** wire the `merge --continue` verb (CLI + RPC, same shape as `DagMergeCommand` /
`MergeRunWorktree`), map the FE `resolve`/`blocked-merge` action to it, and decide whether a
conflicted task should be `retry`-able as an alternative.

### G5. Successful merge leaves no merged marker — Merge button persists forever · verified · S

`DagMergeCommand` seals evidence and stamps `EndCommit` on the **child run**
(`pkg/wshrpc/wshserver/wshserver_dag.go:278-283`) but never touches the task. The FE derives the merge
action as `state == "done" && !gate && !released` (`frontend/app/view/orchestrate/dagstore.ts:44`), and
`released` is gate-only — nothing sets it on merge. So:

- an already-merged task keeps showing a Merge button,
- clicking it re-runs `MergeRunWorktree`, which fails (worktree and branch already removed — the
  `finishMerge` cleanup), surfacing an error with no story,
- there is no persisted "merged" state anywhere (`TaskNode` has no merged flag;
  `pkg/waveobj/wtype.go`), so the FE merge queue can't be re-derived reliably after reload.

**Direction:** stamp a merged marker on the task (e.g. a `Merged` field or reuse `Released` for
non-gate done tasks) at successful merge, and have the FE key the merge action off it.

## Lead experience / CLI

### G6. Lead control notifications are fire-and-forget file writes, no delivery ack · verified · low

`NotifyLead` writes `<sessionId>.json` into the pi control dir and logs errors, nothing more
(`pkg/orchestrate/control.go:48-58`). The pi watcher consumes the file (`pi/extensions/waveterm-tools.ts`,
control watcher), but there is no ack: the engine cannot tell a live-but-wedged lead from a dead one,
and a missed `gate_open`/`dag_blocked` file is simply lost. The DAG still advances (engine-owned), and
the cockpit's WOS events persist for the human, so this is visibility-only — but the lead (by design
"woken by control events, never babysitting") can silently miss a gate. Low severity, confirmed as a
known best-effort contract.

### G7. `wsh jarvis dag status` dumps raw JSON — no per-task health/age/next-action · verified · low

The redesign's R4 wanted per-task `state + age + ask summary` in `dag status`
(`docs/orchestrator-redesign-flaws.md`), and the graph UI has it — but the lead's primary CLI surface
prints the marshaled group verbatim (`cmd/wsh/cmd/wshcmd-jarvisdag.go:96-100`). A lead triaging from a
PTY gets a JSON blob with no stall/ask/age signal and no "what to do next" hint, which is exactly the
F5 failure mode (lead cannot triage without transcript reads) resurfacing on the CLI path.

## Docs staleness (context, not a code finding)

`docs/open-issues.md` still lists the 08-16 redesign plan as "27 unchecked steps" and phase-2
retry/escalate as "not implemented anywhere in pkg/" — both are shipped (verified: `dag escalate`,
`RetryTask`, `Attempts`/`LastFailureKind` on `TaskNode`, `HeadlessContract`, child-ask forwarding,
`dag init/asks/answer` all present; design-flaws doc F1–F10 all marked resolved). The 08-24 scan brief's
"Also noted" line is likewise stale. Before the next planning cycle, reconcile `docs/open-issues.md`
against shipped code or the backlog will misdirect.

## Checked and healthy (no findings this pass)

- Child-ask lifecycle: ask registry claim/deliver atomicity (`pkg/agentask/deliver.go`), wait-mode
  resolution, `dag asks` / `dag answer` lead verbs, `child_ask` event + parent-run card mirroring.
- `ensureRunWorktree` reuse/rebuild discipline (clean at-head reuse, dirty -> recovery patch + rebuild),
  cancel-time worktree sweep with recovery dumps.
- Escalate path: one-escalation cap, tier validation, same/downward-tier rejection, run-cancel before
  re-queue.
- Circuit-break semantics in `RecomputeDagStatus` (blocked pits against `MaxConsecutiveFailures`,
  awaiting-review only for done-unreleased gates).

**Exclusions:** frontend a11y/keyboard findings excluded (not the scope of this pass); channel
data-model scaling and existing Jarvis holds remain tracked in their own docs.