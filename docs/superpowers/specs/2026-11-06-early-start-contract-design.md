# Early start on a contract

**Status:** Design approved in a brainstorm on 2026-11-06. The first deliverable is a hand-run trial; the engine change is
built only if the trial passes.

## Intent

Orchestrator runs with dependency chains should finish sooner. A dependent task waits today until its predecessor's
whole lane has merged, even when all it needs from the predecessor is an interface (a type, a prop, a function
signature) that the plan already pins. This design lets such a dependent start alongside its predecessor, work against
the pinned contract, and catch up mechanically when the predecessor merges.

A win is a shorter task phase on runs with chains. It must never cost quality: plan review, task review, the merge
Verify and the final stage stay as they are, and failed reviews, Verify failures and Final failures must not rise.
Rework when a contract moves has to stay small.

**Non-goals.** Same-file dependencies (tasks that share a file) keep waiting: early start on them saved only about 4%
in the replay and would turn the plan reviewer's no-overlap rule into merge conflicts. No live chat between workers:
the judge dropped it twice, since the lead's `dag tell` already passes a running worker the same kind of note, and it
can be added later if contract mismatches show up. Faster answers to worker questions are out too (about 1% of task
phase).

**Anti-goal.** A feature that adds machinery and saves nothing. If the trial misses its bar, the work stops there.

## Evidence

All numbers come from the packaged app's store (`%LOCALAPPDATA%\dev.arc.app\data\db\waveterm.db`, runs since
2026-09-18), replayed with each task's real work, review, merge and Verify durations at each run's own worker cap.
Scripts: `.superpowers/dag-measure/contractsim-split.mjs`, `contractsim-swap.mjs`, `contractnotes.mjs` (gitignored,
derived from `dagsim2.mjs`).

- **Upper bound, no catch-up cost** (109 runs with dependencies): dependents starting when their predecessor is 25-50%
  done save 16-18% of task phase over all edges, 10-12% over different-file edges only (539 of 741, 73%), about 4% over
  same-file edges (158, 21%). 44 edges had a task with no Files line.
- **With the catch-up modelled** (contract edges split into their own lanes, the dependent held until the predecessor
  merges, then a swap step on the chain): a 1-minute swap saves 10-11%, 2 minutes 7-8%, 4 minutes 1-2%, 7 minutes or
  more makes runs 8-19% slower. A 1-minute mechanical swap plus a 5-minute fixer on 31% of edges saves 5-6%. Runs
  average about 53 minutes of task phase, so every minute of swap on a chain edge counts. 24 of 872 simulated runs
  stalled on chained contract edges and are counted short, so these figures are slightly high.
- **How often contracts move**: of 624 different-file edges, 196 (31%) carried a "For later tasks" note from the
  predecessor (a new prop, wiring the dependent must do); 69% needed nothing beyond the plan. 81 notes reached workers
  already running, at a median 60% of the way through their task.
- **What a model swap would cost**: fresh workers fixing a task after a failed review took a median 4.3 minutes (8
  cases). Workers run on the 5-minute prompt cache (`ShortCache`), so resuming a held session after a longer wait
  re-writes its whole transcript (around 122k tokens late in a task against about 47k for a fresh first turn). Either
  way a model doing the swap on every edge erases the saving; only a model-free swap keeps it.
- **A real case**: run `5638249e` (15 tasks, cap 3). From +47 to +59 min only t-3 ran, two slots idle, while t-9 and
  t-10 waited for it; started at +47 they would have saved about 11 minutes of an 80-minute main round. Both edges
  there were same-file edges, which this design does not cover.

## How the engine works today

- `depSatisfied` in `pkg/orchestrate/scheduler.go` is the one place readiness is decided. With merges, a dependency in
  the same lane only has to be done (the lane shares one tree); one in another lane is satisfied once its whole lane has
  merged onto the run branch.
- Lanes come from `jarvis.Lanes`: a chain where each task has one dependency and one dependent shares a worktree.
  `scheduleLocked` (`engine.go`) takes `spawnBase = landingHead(owner)` and `dispatchTasks` creates each new lane's
  worktree from it with `EnsureRunWorktree`.
- `pkg/jarvis/plan.go`: a Depends line reads `**Depends on:** Task 1 (<what it uses from Task 1>)`, and
  `checkPlanDependsReasons` refuses an edge without a reason. `**Files:**` lines are parsed (`parsePlanFiles`); submit
  refuses two tasks that can run at once and list the same path. The plan reviewer judges each Depends reason
  (`planReviewDependsReasonItem`) and checks that no two tasks edit a file without a Depends between them.

## The design

### Contract edges, marked by the lead

The lead marks a Depends line as a contract edge with a marker inside the reason it already writes, naming the pinned
names and the one file they live in, e.g. `Task 3 (contract: PendingJump in frontend/app/view/code/codestore.ts)`.
An unmarked edge behaves exactly as today. The default stays safe for edges a stub cannot stand in for, such as a
migration a repo test runs or generated bindings their callers import.

The plan reviewer checks each marked edge: the contract is pinned in the predecessor's task text, the contract file is
one the predecessor lists in its Files line, and the two tasks' Files lines are otherwise disjoint. Its existing
interface-only item also flags different-file edges the lead could have marked but did not.

### The dependent starts with its predecessor and stubs the contract file

A contract edge is satisfied when the predecessor starts, and it splits the lane there, so the dependent gets its own
tree. The dependent writes stubs for only the pinned names, inside the contract file the plan names, and edits nothing
else in that file. It builds and tests against those stubs and commits.

### The engine swaps at the merge

A contract dependent that completes is held, unreviewed, and frees its worker slot. When its predecessor's lane merges,
the engine:

1. merges the landing head into the dependent's lane tree;
2. takes the landing head's version of the contract file, replacing the stubs with the real code;
3. runs the task's named tests (not the whole-project Check, which takes about 2 minutes here and would eat the gain);
4. on a failure, starts a fresh fixer worker in that tree; a fixer that fails goes to the lead as a failed task does
   today;
5. sends the result to task review once, on the real code.

The lane merge's Verify and the final stage are unchanged.

## Rollout: a hand-run trial first

Nothing in the engine is built until a trial on a real plan passes.

On the next real plan with a dependency chain, the lead marks contract edges: different-file edges whose contract fits
in one file the predecessor owns. For each, the dependent's Depends on the predecessor is dropped, and its task text
tells it to stub only the pinned names in that file and not otherwise edit it. The plan says so, so the plan reviewer
allows the shared path. When both lanes are done, the lead resolves the contract file by taking the predecessor's
version and runs the dependent's named tests, timing it.

**Success:** the task phase beats the same plan replayed with normal edges (the replay script over the trial's own task
durations) by at least 5%; the swaps take about a minute; reviews, Verify and Final fail no more than usual. The trial
also records how many different-file edges the lead could pin to one file. If it misses, the feature stops.

**How many runs** (owner's answer): trial on real plans until at least 5 contract edges have run, over at most 3 runs.
A run with no edge that can be pinned to one file is no trial, not a miss. The bars above are judged over all the trial
runs together.

**How the trial runs** (Agent's calls from the builder check):

- *Who and where.* An interactive session writes the trial plan with the owner and starts it from the plan file (Flow
  3), so no lead plans it and `PlanFormat` stays as it is. The owner picks the plan. The plan header records each
  dropped Depends edge (the counterfactual), because the stored DAG will not have it.
- *Getting past submit.* `checkPlanFileOwners` (`pkg/jarvis/plan.go`) refuses two tasks that can run at once and list
  the same path. The dependent's Files line leaves the contract file out; its task text names the file and the pinned
  names and says it is a contract-edge trial under this spec. If the plan reviewer flags the omitted path, the owner
  accepts the plan over that finding. No code changes before the trial.
- *Review and Verify on stubs* (owner's answer). The engine has no held state, so the dependent is reviewed on its
  stubs and its lane merges whenever it is ready. At whichever merge comes second, the contract file conflicts and the
  lead takes the predecessor's version. The quality bar is judged by that merge's Verify and the final stage; the trial
  says nothing about reviewing the dependent once on real code.
- *What the swap bar measures.* The ~1-minute bar covers the mechanical part only: taking the contract file and
  running the dependent's named tests. The 5% bar replays the trial run with an engine swap of that measured length.
  The lead's own wake-to-fix time is recorded separately, since the engine, not the lead, would do the swap.
- *Tooling.* The replay script gets a single-run mode (today it reads the whole store).

## Left to the builder (only after a passing trial)

- The marker's exact syntax inside the Depends reason and its parser in `pkg/jarvis/plan.go`, plus `PlanFormat` text
  telling leads when to mark.
- The plan reviewer checklist items above, in `pkg/orchestrate/planreview.go`.
- `depSatisfied` treating a contract edge as satisfied at the predecessor's spawn, and `jarvis.Lanes` splitting there.
- The dependent's prompt naming which names to stub and in which file.
- A held state that frees the worker slot, and how the cockpit shows it.
- The engine swap and the fixer, and their run events.
- A rule for a contract edge into a task that is itself a held contract dependent (the case that stalled 24 replayed
  runs).
