# Orchestrator: task review and the lead-worker link

2026-09-23. Engine: `pkg/orchestrate`. Current behavior: `docs/orchestrator-guide.md`.
Plan: `docs/superpowers/plans/2026-09-23-orchestrator-review-and-lead-link.md`.

## Problem

The lead relies on worker competence. Tests are the only check on a worker's output, so the lead learns about a
task only when something fails: a failed task, a hung worker, a merge conflict, a failed Verify. Work that passes
its own tests but misses the task, contradicts the spec or cuts corners lands unseen.

Around that, the lead and its workers barely connect:

| Gap | Today |
|---|---|
| Worker → lead | The only channel is a worker's question. The closing note never reaches the lead: `DagTaskDigest` (`pkg/wshrpc/wshrpctypes_dag.go`) has no result field, so `dag status` shows a landed commit id and nothing else. |
| Landings | No `PostWake` fires on a landing. Between judgment wakes the lead knows nothing (the backlog run landed five lanes without it). |
| Lead → worker | `dag answer` works only on a pending question. Retry, escalate and skip replace the worker. The lead has no way to message a running worker or add a note to a task that hasn't started. |
| Discoveries | The rules say "never re-plan". If t-2 finds the plan wrong about something t-5 relies on, nothing carries that to t-5. |
| Worker's view | The contract says "the lead or the human answers". The worker doesn't know a lead reads its output, so its final message isn't written as a report. |
| Roster | An idle lead reads "working": `agentVMFromInput` folds `waiting` into `working`. |

## Design

### 1. The review loop

Every dag task whose worker finishes with a commit is reviewed before it counts as done. There is no opt-out.
Quick runs (no dag) are out of scope. A worker that finishes without a commit (`EndCommit` empty: no repo, or
nothing committed) skips review and goes straight to `done`, as today.

**States.** Two new task states:
- `reviewing`: the worker is done, and a reviewer is judging its commit. In flight: it holds its parallelism slot and
  its lane, and it blocks lane successors and the lane's merge because it isn't `done`.
- `review-failed`: review failed twice, or the reviewer couldn't do its job. It blocks the dag like `failed`, and the
  lead's `approve` / `sendback` apply to it.

`DeriveTaskStates` moves a task that was in flight (`running` / `stalled`) to `reviewing` when its worker run reaches
`done` with an `EndCommit`. On that transition it resets the round's reviewer bookkeeping. It never touches a task
already in `reviewing` or `review-failed`, and it doesn't re-derive a finished task. Tasks finished before this ships
stay `done`.

**The reviewer.** Each tick, `advanceReviews` (new, in `pkg/orchestrate/review.go`) spawns a reviewer for every
`reviewing` task with none, through the same `spawnWorker` path as a worker:
- cwd: the worker run's `ProjectPath`, which is the lane worktree;
- route: the lead's (`owner.Runtime` / `owner.Model`), not the workers';
- a child run (`childRunFromSpec`, based at the worker's `EndCommit`) linked as `TaskNode.ReviewRunID`, with the tab
  labelled `review t-N` and stamped with the task id;
- prompt (`reviewPrompt`): the task text as the worker got it (label, goal, description, plan header), the spec and
  plan paths, the worker's closing note, and `git diff <worker BaseCommit>..<worker EndCommit>`. It tells the reviewer
  to:
  - review the change against what the task asked for; Verify covers the tests, so don't run the full suite;
  - look for missing requirements, contradictions of the spec, cut corners (stubs, skipped cases, weakened or deleted
    tests, `TODO`s), and changes outside the task's scope;
  - read only: never edit, stage or commit, and never ask a question;
  - finish with exactly one verdict command.

**Verdict command.** `wsh jarvis dag review pass "<summary>" [--downstream "<what later tasks must know>"]` or
`wsh jarvis dag review fail "<findings>"`, run from the reviewer's terminal (the run is inferred, like other `dag`
commands). It records the verdict (`orchestrate.RecordReviewVerdict`), then completes the reviewer's run exactly as
`wsh jarvis complete` does, so its tab closes like a worker's. The server records the verdict under the dag lock and
starts the tick in the background: the tick can spawn a worker, which would outlast the reviewer's RPC budget. The
command is refused from any run that is not a `reviewing` task's current reviewer, for a task that already has a
verdict, and without a note.

Recorded on `TaskNode`: `ReviewRunID`, `ReviewSpawnedTs`, `ReviewRespawns`, `ReviewRound`, `ReviewVerdict`
(`pass` | `fail`), `ReviewNote` (summary, findings, or why the review failed), `ReviewDownstream`, `ReviewCommit`
(the worker commit the last verdict judged).

**Pass.** The task goes `done` and lands through today's lane and merge path. It posts a quiet line for the lead
(§2.3), plus a wake line if `--downstream` was given (§2.4).

**Fail, round 1.** The task goes `pending` with `RunID` cleared and `ReviewRound` = 1. The next dispatch reuses the
lane worktree (`EnsureRunWorktree` keeps a clean tree on its branch), so the new worker starts from the rejected
commit. `taskPrompt` adds: "A reviewer rejected the previous attempt (commit `<ReviewCommit>`): <findings>. Fix these
on top of that commit; don't restart." The task is reviewed again when that worker finishes.

**Fail, round 2** (`ReviewRound` reaches `MaxReviewRounds` = 2): `review-failed`, and the lead wakes with
`wake: review failed for task t-N. wsh jarvis dag status`.

**Guards, in code:**
- **No verdict.** The reviewer's run ends, its process is gone, or `ReviewTimeout` (20 min) passes, all without a
  verdict. The reviewer is stopped and re-spawned once (`MaxReviewRespawns` = 1). The next time it goes
  `review-failed` with the reason and the lead wakes. A reviewer that can't be spawned at all counts the same way.
  A reviewer's exit schedules the dag right away (`HandleChildOutcome`) instead of waiting for the watchdog.
- **Reviewer committed.** When a verdict is applied, the lane worktree's HEAD must still be the worker's `EndCommit`.
  If it moved, the verdict is discarded, the branch is reset to `EndCommit`, the task goes `review-failed` with
  "reviewer modified the worktree", and the lead wakes. Uncommitted edits aren't checked: a lane lands by squashing
  its branch, so they can't land, and the next dispatch rebuilds a dirty tree (`EnsureRunWorktree`).

**The dormant plan gate stays.** `TaskNode.Gate` / `Released` and `ApproveGate` / `SendBackGate` are unused since the
plan gate was removed, but deleting them reaches the Brief's attention rows and the DAG view. That's out of scope.
`approve` and `sendback` branch on the task's state: `review-failed` takes the review path, anything else the old gate
path.

### 2. The lead-worker link

**2.1 The worker writes for the lead.** `workerContract` replaces "the lead or the human answers" with a sentence
that names both readers: "A reviewer checks your commit against this task and the spec before it lands, and the lead
reads your final message: end with what you did, anything you did differently from the task and why, and anything a
later task must know."

**2.2 `dag status` shows results.** `DagTaskDigest` gains:
- `Result`: the worker run's `Evidence.Summary` through `truncateNote(…, handoffMaxSummaryLen)`;
- `ReviewVerdict`, `ReviewRound`, `ReviewNote`, `ReviewDownstream`.

`dag status` prints a `result:` line and a `review:` line under the table for each task that has one. `WaitReason`
gains `review` (for `reviewing` and `review-failed`). A `reviewing` task counts as running and busy, so a dag waiting
only on reviews reports `parallelism-wait` with those tasks as the blockers. `buildNext` names `review-failed` tasks
as a human action with `approve, sendback, retry, skip, escalate`, ranked right after questions for the human.

**2.3 Quiet lines.** The waker gains `runWake.quiet` and `PostQuiet(ctx, channelId, runId, line)`. Quiet lines never
start a wake of their own. When anything else goes out to the lead (a wake line, questions, a lead launch), the quiet
lines go first under "Since your last wake:" and are cleared. A pass posts `t-N passed review: <summary>`. The
run-finished wake carries whatever is still queued. A lead-free plan run still launches no lead when all it has is
quiet lines and "run finished". A dead lead's quiet lines are dropped, since its replacement reads `dag status`.

**2.4 Downstream wakes.** A pass with `--downstream` posts
`wake: task t-N passed review with a note for later tasks: <downstream>. wsh jarvis dag status`. It's a judgment
event, so on a plan run with no lead it launches one.

**2.5 Lead commands.**
- `dag amend <task> "<note>"`: appends to `TaskNode.LeadNotes` on a `pending` or `ready` task, and is refused in any
  other state. `taskPrompt` renders the notes after the task text as "The lead added after earlier tasks landed:"
  with one bullet per note. Timeline row `task-amended`.
- `dag tell <task> "<text>"`: types the text plus Enter into the running worker's block, or the reviewer's for a
  `reviewing` task, through the waker's `sendWakeFn`. It's refused unless the task is `running`, `stalled` or
  `reviewing`. The text is kept in `TaskNode.LeadTold` until the scan for what the human types
  (`toldSince`) sees it in the transcript and drops it, so the lead's words are never recorded as the human's.
  Timeline row `task-lead-told`.
- On a `review-failed` task:
  - `dag sendback <task> ["<guidance>"]` runs one more round. The task goes `pending` with the findings kept and the
    guidance in `TaskNode.LeadGuidance`; the next worker's prompt carries both. `ReviewRound` is not reset, so a
    further fail goes straight back to `review-failed`. The guidance is optional: the DAG view's button sends none.
  - `dag approve <task>` overrules the reviewer. The task goes `done` and lands. Timeline row `review-overruled`.
  - `retry` resets `ReviewRound` and re-dispatches with the findings still in the prompt. `skip`, `escalate` and
    `forward` accept `review-failed` like `failed`.

**2.6 Lead rules.** Two lines in `OrchestrationRules`:
- "- a task passed review with a note for later tasks: check the pending tasks it affects and add what they need with
  `wsh jarvis dag amend <task> \"<note>\"`; use `wsh jarvis dag tell <task> \"<text>\"` only for a running task the
  note changes. Amending is not re-planning: never add, remove or reorder tasks."
- "- review failed: the findings are in `wsh jarvis dag status`. `wsh jarvis dag sendback <task> \"<guidance>\"` if
  the fix is clear, `wsh jarvis dag approve <task>` if the reviewer is wrong, otherwise retry, escalate, skip or
  forward."

### 3. UI

- **Lead row.** On the Agent tree, a lead whose run's dag isn't finished and whose raw status is `waiting` or `idle`
  reads `standing by` in the idle tone, instead of `working`. The run subline under it already shows progress
  (`5/13 done`). Only lead rows change: the rule that folds `waiting` into `working` for plain agents stays.
  `AgentVM` gains `status` (the raw status) so the row can tell.
- **Lineage.** `runRoleOf` treats a task's reviewer run as that task's worker, so the reviewer nests under the lead.
- **Worker rows, DAG nodes, run sheet.** `reviewing` renders like running ("reviewer checking the commit", "review
  round 2"). `review-failed` renders like a failure, with the first line of `reviewnote`. A `review-failed` node
  offers `approve` / `sendback` / `retry` / `skip` / `escalate`. The DAG peek shows the review verdict and note.
- **Timeline.** New rows: `task-review-started`, `task-review-passed`, `task-review-failed`, `review-overruled`,
  `task-amended`, `task-lead-told`. `task-review-failed` is an attention kind.

### 4. Docs

`docs/orchestrator-guide.md`:
- describe the review loop, the new commands and the quiet lines;
- correct the "A worker sees only its own task" bullet (the plan header reaches every worker: `taskPrompt` writes
  `g.Preamble`);
- drop proposal #1 under "Two engine changes" (`complete --report` is live in the rules);
- update the "Between wakes the lead's conversation says nothing about the run" passage.

## Verify before building

- **pi and `dag tell` mid-turn.** Claude Code queues text typed mid-turn. Check that pi does the same, and doesn't
  garble or drop it. If pi corrupts it, `dag tell` refuses pi sessions with a clear error and the lead uses `amend` or
  forwards.

## Testing

Go unit tests in `pkg/orchestrate`, in the style of the existing `*_test.go`, over the real test store (`TestMain`):
- `DeriveTaskStates`: an in-flight task whose run is done with `EndCommit` goes `reviewing`; without one it goes
  `done`; `reviewing`, `review-failed` and an already-`done` task are left alone.
- scheduling: `reviewing` holds a slot and a lane; `review-failed` blocks the dag.
- review loop: a reviewer is spawned once with the lead's route and the diff; pass → `done` + quiet line; pass with
  downstream → wake line; fail r1 → `pending` with the findings in the next prompt; fail r2 → `review-failed` + wake;
  a verdict from a non-reviewer run is refused.
- guards: no verdict or a timeout re-spawns once, then `review-failed`; a moved HEAD discards the verdict.
- waker: quiet-only never flushes; quiet lines lead the next wake; a lead-free run launches nothing on quiet +
  run-finished.
- lead actions: `amend` outside pending/ready and `tell` outside running states are refused; `sendback`, `approve`
  and `retry` on `review-failed`; the told scan skips `LeadTold` text.
- digest: `Result` and the review fields, the `review` wait reason, the `review-failed` next step.
- `pkg/jarvis`: `OrchestrationRules` carries the two new lines.

Frontend: pure-function tests for the lead-row label and the lineage of a reviewer run. Live check: the
`orch-guide-demo` sandbox with one task written to pass its tests but miss its spec, which must be sent back and then
land.
