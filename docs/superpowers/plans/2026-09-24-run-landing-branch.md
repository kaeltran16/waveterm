# Run landing branch

An orchestrator run can land its lanes on a branch of its own, `wave/<runId>` in a worktree the engine
creates, instead of on whatever branch the project checkout has checked out. The human merges that branch
when they choose.

**Why.** Today every lane squash-merges into the project checkout (`owner.ProjectPath`), so a run lands on
`main` in the checkout the human is working in, and HMR reloads the dev app mid-run. The only way out is the
manual step in `docs/orchestrator-guide.md` §2 (register a worktree as the project). A "Use worktree"
principle in the profile does nothing: principles are prompt text, and the engine owns merges.

**Execute in a worktree.** Runs land in the main checkout, and other sessions commit there.

## Decisions

- Setting: `landing` on the Jarvis profile, `"checkout"` (default, today's behavior) or `"branch"`. The
  global profile holds it, and a project override can replace it, the same way `defaultmode` works. It is
  resolved at `CreateRun` and stored on the run, so changing the profile never moves a run already started.
- Only engine runs (orchestrator) read it. Quick runs are unchanged.
- The landing tree is `<project>/.waveterm/worktrees/<runId>` on `wave/<runId>`, created at `CreateRun` from
  `run.BaseCommit`, using the existing `CreateRunWorktree`. The lane trees are `<runId>-<taskId>`, so the
  names do not collide.
- The run lives in its landing tree. Its lead starts there (goal runs and the lead launched at the first
  judgment event), so the spec and plan a goal-run lead writes are already in the tree its lanes land in, and
  a conflict gets resolved where the lead is working.
- Setup runs once in the landing tree at `DagSubmit`, because that is where the plan's Setup line first
  becomes known. Verify then has what the lane trees have (for this repo, `task worktree:prepare`).
- The lane trees stay under `ProjectPath`, and everything that creates or removes them keeps `ProjectPath`.
  Only landing moves.
- The run's end changes nothing: the engine leaves `wave/<runId>` and its tree for the human to merge.
  Cancel keeps them too. There is no automatic cleanup yet (YAGNI). Removing them is `git worktree remove`
  plus `git branch -D`.

## Tasks

### Task 1: Profile setting and run fields

- `pkg/waveobj/wtype.go`: add `Landing string` (`json:"landing,omitempty"`) to `JarvisProfile`, add
  `Landing *string` to `ProfileOverride`, and add `LandPath string` (`json:"landpath,omitempty"`, the tree
  lanes land in; empty means `ProjectPath`) to `Run`.
- `pkg/jarvis/profile.go`: resolve `Landing` in `ResolveProfileWithDiagnostics`, include it in
  `ProfileOverrideIsEmpty`, and add constants `Landing_Checkout` / `Landing_Branch` with validation on save
  (anything else is refused).
- `pkg/wshrpc/wshserver/wshserver_runs.go` `CreateRunCommand`: on an engine launch with a resolved
  `Landing_Branch` and a git project, create the tree after `AppendRun` has minted the id, then stamp
  `LandPath`. A creation failure fails the launch: cancel the run, the same as a refused plan does.
- `task generate`.
- Tests: profile resolution and override (`pkg/jarvis`), and `CreateRun` stamping `LandPath` (follow the
  existing `CreateRun` tests).

### Task 2: Engine lands in `LandPath`

**Depends on:** Task 1

- Add one helper in `pkg/orchestrate`, `landPath(run *waveobj.Run) string`: `LandPath`, else `ProjectPath`.
- Switch the landing call sites to it: the spawn base when `MergeRequired` (`engine.go`, `ProjectHeadCommit`);
  every `claimProject`, `IndexClean`, `mergeWorktree`, `continueMerge` and `startVerify` in `mergetask.go`
  and `verify.go`; and `ProjectHeadCommit` in `leadclose.go` (the end commit). Leave lane-tree management on
  `ProjectPath`: `EnsureRunWorktree`, `removeWorktreeDir`, `cleanupProjectPath`, and the cancel sweep in
  `mutation.go`.
- `finishMerge` fold: a fold path outside the merge tree but inside the project (a plan-path run's
  untracked plan and spec in the main checkout) is copied to the same relative path in the tree before
  `git add`. Today it is logged and skipped, so those docs would never land.
- `DagSubmitCommand`: when the owner has a `LandPath` and the plan has Setup, run it there once
  (`runPlanCommand`, `SetupTimeout`). A failure refuses the submit.
- Tests with real git repos, following `merge_test.go` / `mergetask_test.go`: a lane lands on `wave/<runId>`
  while the project checkout's HEAD does not move; a dirty project checkout no longer holds merges; the fold
  copy; Setup runs in the landing tree at submit; an empty `LandPath` behaves as it does today.

### Task 3: Lead cwd and wording

**Depends on:** Task 2

- Start the lead in `landPath(run)`: `spawnRunWorkersWithPrompt` (goal runs) and the lead launched by
  `LaunchLeadHook` / `startLead`. Find the cwd each one passes by symbol.
- Name the tree wherever the text says "project checkout": the conflict next-step in
  `pkg/jarvis/attention.go` ("Resolve the conflict in <landPath>"), `mergeFailedWake` /
  `mergeConflictWake` in `queue.go` if they name a place, and the plan-lead prompt, if it tells the lead
  where merges land.
- Tests: the attention string with and without `LandPath`.

### Task 4: UI and docs

**Depends on:** Task 1

- Profile modal (`frontend/app/view/jarvis/briefprofileview.tsx`, `profilemodel.ts`): a "Runs land on"
  control (Project checkout | Own branch) with the same global/override/inherit handling as `defaultmode`.
  Add `landing` to `OVERRIDE_FIELDS` and `GlobalDefaultKey`, with model tests.
- Lead card meta line (`leadcardmodel.ts`): append `lands on wave/<first 8 of runId>` when the run has a
  `LandPath`, with a model test. `RunInfo` needs `landPath` from `runlineagestore.ts`.
- `docs/orchestrator-guide.md` §2: replace the manual-worktree recipe with the setting, and keep the recipe
  as the fallback for a run that should land on a named branch.

**Verify:** `go test ./pkg/jarvis/ ./pkg/orchestrate/ ./pkg/wshrpc/wshserver/` (CGO + zig for sqlite, see
memory), `npx vitest run frontend/app/view/jarvis frontend/app/view/agents`, and `task check:ts`.

## After landing

- Set the global profile's `landing` to `"branch"`, and delete the "Use worktree" custom principle it
  replaces. Both are user data, so ask first.
- Live check: start a small plan run with `landing: branch`, then confirm that `main` does not move, that
  `wave/<runId>` gets the squash commits, and that Verify runs in the landing tree.
