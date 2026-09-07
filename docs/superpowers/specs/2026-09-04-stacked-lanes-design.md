# Stacked lanes: a dependency chain runs on one branch and lands once — design

**Date:** 2026-09-04
**Status:** approved in discussion, not yet implemented

## Problem

A superpowers plan is written as a numbered sequence, but its real structure is short chains bound
by shared files, a few singletons, and a final verify-and-commit join. In
`docs/superpowers/plans/2026-09-04-git-compare-viewer-parity.md` tasks 1–5 all edit
`pkg/gitinfo/gitinfo.go` and its test file; tasks 8–11 all edit `filessurface.tsx` and the keybindings
file. The other two most recent plans have the same shape on `projection.go` and on
`wshcmd-jarvisdag.go`. The plans even carry workaround lines ("add the field now to keep this task
independently green", "hardcode until Task 10 supplies it") that exist only because each task must
survive on its own.

The engine serves this shape worst. A dependency is satisfied only when the predecessor is **merged
into project HEAD** (`depSatisfied`, `pkg/orchestrate/scheduler.go:46`), and a successor's worktree is
cut from that HEAD (`spawnBase`, `engine.go:288`). A chain of N related tasks therefore costs N
worktrees, N squash merges and N lead wakes, and gains no parallelism. Declaring the tasks flat to get
parallelism instead branches them all from the same base onto the same files, and they collide at the
merge gate — which is what capture 2 in `docs/orchestrator-redesign-flaws.md` recorded: four sibling
gitinfo tasks done, four branches unmerged, nothing advancing.

The worktree is not the cost. Tying "dependency satisfied" to "landed on main" is: that is an
integration event, and a chain step needs a sequencing event.

## What already works

- Worktree creation takes an arbitrary base commit (`CreateRunWorktree`, `worktree.go:47`), and a
  branch tip is one (`WorktreeHeadCommit`, `worktree.go:146`).
- A child's `wsh jarvis complete` already triggers a schedule tick (`wshserver_runs.go:609`), so a
  successor whose dependency is satisfied on *done* spawns with no lead involvement.
- Evidence is sealed at `complete`, on the child's worktree, over the child's own
  `BaseCommit..EndCommit` range (`pkg/jarvis/evidence.go:327`). For a child cut from its predecessor's
  tip that range is exactly its own step.
- The squash merge and its idempotent retry paths (`merge.go`) work on one branch; a lane is one
  branch.
- Cleanup retry already sweeps every task carrying debt each tick (`RetryPendingCleanup`,
  `cleanup.go:96`), so stamping several tasks cleanup-pending at once needs no new sweep.

## Decisions

| # | Decision | Rationale |
|---|---|---|
| 1 | Lanes are derived from declared deps at spawn time, not declared by the lead | No new input vocabulary in prompt, CLI, import or UI. The lead already declares deps; the plan's **Files:** lists make the chain edges recoverable. A declared `lane` field would need the same chain validation and adds a way to be wrong. |
| 2 | The engine records `StackedOn` on the task node when it stacks a spawn | A record of what happened, like `RunID`, not a derived state. The merge handler walks it to stamp a lane; the digest and graph read it to tell a tip from a stacked step, without re-deriving engine rules from deps. |
| 3 | Only chains stack; forks and joins keep the merge-first rule | Squash merge stays sound only when every squash brings commits main has not seen. A chain guarantees that without a merge; a fork or join is where integration genuinely has to happen. |
| 4 | A lane lands as a unit at its tip | One merge per lane. Landing the tip stamps every lane task merged. Merging a non-tip is refused, naming the tip. |
| 5 | Predecessor worktrees stay until the lane lands | The successor's branch is cut from the predecessor's branch, which must exist. Removing a landed step's tree early while keeping its branch is a follow-up. Live worktrees are bounded by the tasks in unfinished lanes, at most `MaxDagTasks`. |
| 6 | The lead chooses per chain: one node per step, or one node for the whole chain | Both are legitimate; the difference is cold-start cost versus per-step retry, evidence and fresh context. The prompt states the trade so the lead sizes deliberately. |
| 7 | `buildNext` becomes total as part of this change | Stacking depends on merge-ready firing for a finished lane that blocks nobody, which is the flat-DAG defect in `docs/open-issues.md`. The other bare-terminal path (merged, cleanup pending) is closed in the same function with a `cleanup-wait` kind. `waitDecision` is not touched, per the ordering caveat recorded there. |

## Design

### 1. The lane model

**Stacking rule.** At spawn, a task `T` is stacked on its predecessor `P` when all of the following
hold:

- `len(T.Deps) == 1` and `P` is that dependency;
- `P.State == done`, `P.RunID != ""` (so `wave/<owner>-<P>` exists), and `!P.Gate || P.Released`;
- among tasks whose state is not `skipped` or `cancelled`, `P` has exactly one dependent, and it is
  `T`;
- `g.MergeRequired` is true.

When the rule holds the engine cuts `T`'s worktree from `P`'s branch tip and records
`T.StackedOn = P.ID`. When it does not, the spawn is exactly today's: base is project HEAD and
`StackedOn` stays empty.

A task with two or more dependencies is a **join**: every dependency must be merged (today's rule). A
task whose single dependency has other live dependents is downstream of a **fork**: the fork task is a
tip and must land before any of them spawns; each then starts from integrated HEAD.

**Lane tip.** A task is a lane tip when it is `done`, not `Merged`, released if a gate, the group is
merge-required, and no task with `StackedOn == its id` is live (state not `skipped`/`cancelled`). A
skipped last step makes the previous step the tip. A stacked successor that failed and sits waiting
for retry/skip keeps its predecessor off the tip list; the lane is not finished.

**Lane walk.** From a tip, following `StackedOn` until it is empty yields the lane in reverse order.
That walk is the only lane enumeration in the system.

**Non-git projects.** `MergeRequired` is false, the stacking rule never holds, and nothing changes.

Worked example, the parity plan with deps declared by the chain rule in §4:

```
t-1 → t-2 → t-3 → t-4 → t-5        gitinfo + RPC        lane, tip t-5
t-6 → t-7 → t-8 → t-9 → t-10 → t-11 frontend            lane, tip t-11
t-12                                 file tree            lane of one, tip t-12
t-13  deps [t-5, t-11, t-12]         verify + commit      join
```

Three merges, then t-13 spawns from integrated HEAD. Thirteen today.

### 2. Data

```go
// waveobj.TaskNode, beside RunID
// StackedOn is the predecessor this task's worktree was cut from, recorded by the engine at spawn
// when the task ran as a chain step. Empty for a task cut from project HEAD. Merge walks it to land
// a lane as a unit; the digest and graph read it to tell a lane tip from a stacked step.
StackedOn string `json:"stackedon,omitempty"`
```

Engine-owned: `NewTaskGroup` rejects a submitted task with a non-empty `StackedOn`, alongside the
other engine fields it already rejects (`dag.go:154-183`). `SameDagProposal` does not compare it.
`TaskGroup` is a waveobj blob, so no migration; `task generate` refreshes `gotypes.d.ts`.

### 3. Scheduler and spawn

**Dependency predicate.** `depSatisfied(g, t, depID)` takes the dependent. It returns true when the
dependency is `skipped`; when the group is not merge-required and the dependency is `done`; when the
stacking rule holds for `(t, dep)` and the dependency is `done`; otherwise only when the dependency
is `done && Merged && (!Gate || Released)`, as today. The pure stacking-rule function is shared by
the predicate and the spawn loop so they cannot disagree.

`ReadyTasks`, `hasUnsatDep`, `dependencyWait`, `taskBlockingIds` and `taskReady` already hold the
dependent and pass it through. `NextToSpawn`, parallelism accounting and gate halting are unchanged.

**Spawn loop** (`scheduleLocked`, `engine.go:295-357`). Per task, before `EnsureRunWorktree`:

```go
base := spawnBase
if pred, ok := stackPredecessor(g, task); ok {
    tip, err := WorktreeHeadCommit(spawnCtx, owner.ProjectPath, TaskWorktreeKey(owner.ID, pred.ID))
    if err != nil { failDispatch(..., FailureKindWorktree, err, ...); continue }
    base = tip
    task.StackedOn = pred.ID
}
```

`EnsureRunWorktree` is called with `base` and is otherwise unchanged. A retried stacked task reuses
`StackedOn`; its tree is rebuilt from the predecessor's tip by the existing rebuild-when-dirty path.

**Child prompt.** `taskPrompt` appends one line when `StackedOn` is set: *"This working tree already
contains the finished work of task `<id>` (`<label>`); build on it rather than re-deriving it."*

### 4. Merge and cleanup

**Merge handler** (`DagMergeCommand`, `wshserver_dag.go:452`):

1. After the existing state checks, refuse a non-tip: `task t-2 is stacked under t-4; merge t-4 to
   land the lane`.
2. Build the commit message from the lane's labels in lane order, joined with ` / `, through the
   existing `firstLine` cap. Today's message is one label.
3. On success, `finishMergedTask` stamps the whole lane in the single DAG update `persistMergedTask`
   already performs: every task on the walk gets `Merged = true`, `CleanupPending = true`,
   `CleanupError = ""`. The tip's child run gets `EndCommit = <squash sha>`, exactly as the merged
   task does today; non-tip children keep the commit they reported at `complete`.
4. `cleanupMergedTask` runs for the tip as today. The other lane trees are removed by the next tick's
   `RetryPendingCleanup`, which already sweeps every task with debt, and each removal deletes that
   task's branch through `RemoveRunWorktree`.

`DagMergeContinueCommand` mirrors steps 1–3; a lane is one branch, so conflict handling is unchanged.

**Cancel** is unchanged. `DumpRecoveryPatch` for a stacked task diffs `HEAD..wave/<key>`, which
includes the predecessors' commits because they are on the branch. That is acceptable for a
recovery artifact and is documented in the patch directory's purpose, not fixed here.

**`RecomputeDagStatus`** is unchanged: with every lane task stamped merged, a finished DAG derives
done as before.

### 5. Digest, CLI, prompt, frontend

**Digest** (`digest.go`):

- `mergeReadyIDs` returns lane tips only. `buildCounts.MergeReady`, `taskHumanActions`'s
  `resolve-merge` case and the merge-ready branch of `buildNext` all use it.
- `buildNext` step 2 fires whenever `mergeReadyIDs` is non-empty. `mergeReadyBlocking` and
  `depChainReachesMergeReady` are deleted; the "blocks a successor" condition is the flat-DAG defect
  and is meaningless once a finished lane blocks nobody by design.
- New step between dependency-wait and terminal: when some task has `CleanupPending`, return
  `{Kind: "cleanup-wait", TaskIds: <those>}` with no actions. Its position in the ordering already
  guarantees nothing needs attention, nothing can dispatch, nothing is busy and nothing waits on a
  dependency; a `CleanupError` is attention and was caught at step 1. `wait` keeps blocking on it.
  After this, a running DAG has no path to a bare `terminal`.
- `taskMergeState` gains `stacked`: `done`, not merged, released, and not a tip. Enum becomes
  `not-required | waiting | stacked | ready | blocked | merged`.
- `waitDecision` is not changed.

**Observability spec amendment** (`2026-08-28-orchestrator-full-observability-design.md`): §5.3 step 2
reads "merge-ready lane tips when `MergeRequired` is true"; a step 6 `cleanup-wait` is inserted
before terminal; `DagTaskDigest.MergeState` lists `stacked`.

**CLI** (`wshcmd-jarvisdag.go`): `dagStatusLines` shows `stacked on t-3` in the signal column for a
task with `StackedOn` set and no ask or idle signal. `dag merge` surfaces the handler's refusal as
is. `dag wait` needs no change.

**Prompt** (`buildEngineOrchestratePrompt`, `pkg/jarvis/run.go:413`). The line beginning "A Git-backed
dependent task stays pending until each predecessor is merged" is replaced by:

> Tasks that edit a common file form one chain in plan order: each depends only on the task before
> it. The engine runs a chain stacked — every step starts in a tree that already holds the previous
> step's commits — and you merge only the chain's last task: when the digest reports `merge-ready`,
> run `wsh jarvis dag merge <task-id>` with the reported id, and the whole chain lands. A task with
> several dependencies waits until each of them is merged. Choose per chain: one node per step when
> the steps are substantial (each step is a fresh worker with fresh context), or one node for a whole
> chain of small steps, listing the steps in order in that node's description.

This also closes F20: the prompt now uses the digest's words.

**Frontend**:

- `dagstore.ts:46` offers `merge` only on a tip: done, not gate, not merged, and no other node with
  `stackedon === t.id` in a live state. The node meta line appends `stacked on t-3` when set.
- `dagdigest.ts` `nextStepText` gains `case "cleanup-wait": return "removing finished worktrees"`, so
  the overview never falls through to "refreshing status" on a real kind.
- The overview's merge queue keys off merge state `ready` and is correct without change.

### 6. Failure paths

| Action | On a stacked task | On a task with a live stacked successor |
|---|---|---|
| retry / escalate | Rebuilds the tree from the predecessor's tip; `StackedOn` unchanged | retry refused: `t-1 has stacked successor t-2; retry t-2, or skip it first`. escalate needs no new check: it already refuses a done task |
| skip | Successor becomes terminal; predecessor becomes a tip if nothing else is stacked on it | Allowed as today |
| sendback | n/a (a gate halts the DAG before any successor spawns) | n/a |
| cancel | Unchanged; recovery patch includes predecessors' commits | Unchanged |

The retry refusal is the only new check in `applyActionLocked` (`mutation.go:170`); today `retry`
accepts any state.

## Testing

| Area | Test |
|---|---|
| Stacking rule | Table over single-dep-done (stacks), single-dep-done-but-fork (does not), two deps (does not), dep is a released gate (stacks), dep is an unreleased gate (not ready at all), non-git group (does not), sibling dependent skipped (stacks). |
| `depSatisfied` | Stack link satisfied on done; join waits for merged; existing merged/skipped cases unchanged. |
| Engine, real temp repo (`newGitRepo`, stubbed `spawnWorker`) | Commit a file in the predecessor's worktree, complete it, tick: the successor's worktree contains the file, its base is the predecessor's tip, `StackedOn` is recorded, and the predecessor's branch still exists. A join task does not spawn until both deps are merged. |
| Merge | Landing a tip stamps every lane task merged with cleanup pending; message lists the lane's labels in order; non-tip refused with the tip's id; a skipped last step makes the previous step mergeable; the tip's child run gets the squash sha and a non-tip child keeps its own end commit. |
| Cleanup | After landing, the next tick removes every lane tree and branch. |
| Digest | `mergeReadyIDs` is tips only; a flat DAG with every task done reports `merge-ready` with `resolve-merge`; merged-with-cleanup-pending reports `cleanup-wait` with no actions and `waitDecision` keeps blocking; `stacked` merge state on a done non-tip. |
| Mutation | Retry of a done task with a live stacked successor is refused; retry of a failed stacked task returns it to pending with `StackedOn` intact. |
| Submit | A task carrying `StackedOn` is rejected. |
| Prompt | The engine prompt contains the chain rule and the `merge-ready` vocabulary; the adaptive prompt is byte-identical to today. |
| Frontend | `dagstore.test.ts`: merge offered on a tip, not on a stacked step, offered again when the successor is skipped. |
| Live | A Claude lead on a scratch repo: one three-step chain, one independent task, one join. Assert one merge per lane, the join's worktree at integrated HEAD, and the lead's wake log showing `action:merge-ready` and `terminal:done` only. Recorded beside `docs/jarvis-claude-lead-e2e.md`. |

The live run is the only test that proves the wake loop closes over a lane; every unit test above
stays green on a digest the lead never reads.

## Files

| File | Change |
|---|---|
| `pkg/waveobj/wtype.go` | `TaskNode.StackedOn` |
| `pkg/orchestrate/scheduler.go` | `stackPredecessor`, `isLaneTip`, `liveDependents`; `depSatisfied` takes the dependent |
| `pkg/orchestrate/engine.go` | per-task base at spawn; record `StackedOn`; `taskPrompt` line |
| `pkg/orchestrate/dag.go` | reject non-empty `StackedOn` at submit |
| `pkg/orchestrate/digest.go` | tips-only merge-ready; `buildNext` step 2 and `cleanup-wait`; `stacked` merge state; delete `mergeReadyBlocking` |
| `pkg/orchestrate/mutation.go` | retry refusal |
| `pkg/wshrpc/wshserver/wshserver_dag.go` | tip check; lane stamping; lane commit message |
| `pkg/jarvis/run.go` | engine prompt chain rule |
| `cmd/wsh/cmd/wshcmd-jarvisdag.go` | status signal `stacked on` |
| `frontend/app/view/orchestrate/dagstore.ts` (+ test) | tip-only merge action; meta line |
| `frontend/app/view/orchestrate/dagdigest.ts` | `cleanup-wait` text |
| `docs/superpowers/specs/2026-08-28-orchestrator-full-observability-design.md` | §5.3 and `MergeState` amendment |
| `docs/open-issues.md`, `docs/orchestrator-redesign-flaws.md` | on shipping: flat-DAG note, F19 and F20 rows marked resolved by this change |
| generated | `task generate` after the waveobj change |

## Out of scope

- **Declared lanes.** Derivation covers every chain the plans produce; a declared field would need
  the same validation.
- **Early removal of a landed step's worktree** while keeping its branch. Bounded today by the task
  ceiling; revisit if a heavy-dependency repo shows the cost.
- **Auto-landing clean merges** with the lead reviewing only conflicts. A cost lever, tracked
  separately; this change makes it cheaper by reducing merges to one per lane first.
- **Per-task cost stamp** and **F18** (non-pi liveness). Both in the tracker; F18 is the more urgent
  fix and is independent of this change.
- **`waitDecision` tightening.** Left as is; once the live run confirms no bare terminal on a running
  DAG, the empty-status case can become an error in a follow-up.
- **Attribution over a removed worktree.** `jarvisattrib` range-logs `BaseCommit..EndCommit` on the
  child's `ProjectPath`, which is the worktree and is gone after cleanup. Pre-existing for every DAG
  child; unchanged here.
