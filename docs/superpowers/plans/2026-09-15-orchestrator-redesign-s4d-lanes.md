# Orchestrator Redesign Slice 4d: Lanes

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A chain of tasks runs as one lane: one worktree and one branch, each task a fresh worker committing on top of the task before it, and one squash merge (and one Verify) once the lane's last task is done. A task in another lane waits for that merge, and the dag's first squash commit also carries the spec and plan it was built from.

**Architecture:**
- Lanes are derived, never stored: `jarvis.Lanes(g.Tasks)` is called wherever a lane is needed (`pkg/orchestrate/lane.go`). A one-task lane behaves exactly as a task does today, so a dag without chains is unchanged, down to its worktree keys.
- Every task in a lane uses `LaneWorktreeKey`, which is the lane's first task's `TaskWorktreeKey`.
- `EnsureRunWorktree` continues an existing branch instead of discarding it. A clean tree on the branch is reused. A dirty tree has its uncommitted state dumped to a recovery patch, and a dirty or missing tree is checked out again from the branch. It returns the head commit the task starts from, and that head becomes the child run's `BaseCommit`.
- A Setup failure removes the worktree directory but keeps the branch, so a lane's earlier commits survive and the retry checks the branch out again.
- `depSatisfied(g, taskID, depID)`:
  - Same lane: the dependency only has to be done.
  - Another lane: the dependency's whole lane has to have landed, meaning each task is skipped, or done and merged.
- `NextToSpawn` runs one worker per lane.
- **Merge-ready:** a lane is merge-ready when every task in it is done or skipped.
- **The tip:** the merge is recorded on the lane's tip, its last task that was not skipped. The tip's child run gets the squash sha, and blocked-merge, verifying, verify-failed and cleanup belong to the tip. Every done task in the lane is stamped merged.
- **Manual merges:** `dag merge` on a task whose lane is not finished is refused.
- **G1 fold:**
  - `TaskGroup.PlanPath` and `SpecPath` are set by `wsh jarvis dag submit --plan P --spec S`.
  - The dag's first squash merge stages both paths after `git merge --squash` and before the commit, which is after the automatic path's clean-index check.
- **Digest:** it names only lane tips as merge-ready and lists one landed commit per lane. The DAG modal's node "merge" action reads the digest's `mergestate` instead of deriving it locally, because only the engine derives lanes.

Probed facts this plan relies on (2026-09-15, Git for Windows):
- After `git merge --squash <branch>`, a `git add -- <abs path>` of an untracked file in the project lands that file in the following commit together with the branch's changes.
- `git add` of an ignored path exits 1, and of a path outside the repository exits 128. Neither touches the index.
- `git worktree remove --force <tree>` keeps the tree's branch. `git worktree add <tree> <existing branch>` checks that branch out again.
- A worktree directory deleted without git still counts as registered: `git worktree add` refuses it until `git worktree prune` runs.

**Tech Stack:** Go (`pkg/orchestrate`, `pkg/waveobj`, `pkg/wshrpc`, codegen via `task generate`), cobra (`cmd/wsh`), React 19 + TypeScript, vitest.

**Spec:** `docs/superpowers/specs/2026-09-14-orchestrator-redesign-design.md`. This plan implements:
- §4 Engine: Lanes, Merges, and the in-lane `predecessorHandoff`.
- §2 The lead: "Where the lead works (G1)", plus the merge-conflict wake line under Judgment events.
- §12 Testing: Lane derivation and the G1 fold.
- §13 Delivery slices: slice 4d.

## Global Constraints

- **Wake line** (spec §2): `wake: merge conflict landing lane ending at task t-5. git status`.
- No new task states, run events, failure kinds or timeouts.
- A one-task lane keeps today's worktree key, merge message (the task label), stamps and dependency rule.
- No emojis. Comments are lower case and say why, never what.
- Never hand-edit generated files. Run `task generate` after changing a `waveobj` or `wshrpc` type.
- Go tests for `orchestrate` and `wshserver` need CGO flags. From PowerShell at the repo root:
  ```powershell
  $env:CGO_CFLAGS = "-O2 -g -I$((Get-Location).Path -replace '\\','/')/pkg/jarvisembed/csrc"
  ```
- Typecheck with `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (`npx tsc` overflows).
- HEAD is not formatter-clean. Never run `gofmt -w` or `prettier --write` over a whole file you did not already own. Check only the hunks you wrote: `gofmt -d <file>` and `npx prettier --check <file>`.
- The working tree holds another session's untracked `docs/prototype/jarvis-brief-live.dc.html`. Never stage it. Other sessions edit this tree too, so run `git status --short` again before staging.
- One commit for the whole slice, with this plan folded in. Commits for this effort need no approval; pushing does. No co-author trailer.
- The Write tool replaces an existing file. The new test files here (`lane_test.go`, `laneschedule_test.go`, `digestlane_test.go`) must not exist yet: check with `ls pkg/orchestrate` first. Add to existing test files with Edit.
- **Known limits, recorded in `docs/deferred.md` by Task 6:** a skipped task's commits land with its lane, and a retried task's evidence starts at the branch head.
- **Upgrade:** a dag dispatched before this slice gave each chained task its own `wave/<run>-<task>` branch. After this slice the lane merge looks for the lane's first task's branch, and `MergeRunWorktree` treats a missing branch as already landed, so such a task would be marked merged without landing. Before running a `wavesrv` built from this slice, finish or cancel every orchestrator dag still running. None were running when this plan was written (2026-09-15): the dev `wavesrv` had not been rebuilt since slice 4a.

## Task order

1. Lane helpers and lane-aware dependencies.
2. Worktrees that continue a lane, and dispatch into them.
3. The spec and plan: stored on the dag, staged by the squash merge.
4. Merge at the lane tip.
5. Digest and graph: a lane's tip is what merges.
6. Docs, full verification, commit.

---

### Task 1: Lane helpers and lane-aware dependencies

**Files:**
- Create: `pkg/orchestrate/lane.go`
- Create: `pkg/orchestrate/lane_test.go`
- Modify: `pkg/orchestrate/scheduler.go` (`ReadyTasks`, `depSatisfied`, `NextToSpawn`)
- Modify: `pkg/orchestrate/digest.go` (the five `depSatisfied` call sites)

**Interfaces:**
- Consumes: `jarvis.Lanes(tasks []waveobj.TaskNode) [][]string` (slice 4a), `taskByID`, `TaskWorktreeKey`.
- Produces:
  - `func laneOf(g *waveobj.TaskGroup, taskID string) []string`
  - `func LaneWorktreeKey(g *waveobj.TaskGroup, taskID string) string`
  - `func laneTip(g *waveobj.TaskGroup, lane []string) *waveobj.TaskNode`
  - `func laneMergeReady(g *waveobj.TaskGroup, lane []string) *waveobj.TaskNode`
  - `func mergeReadyTip(g *waveobj.TaskGroup, t *waveobj.TaskNode) bool`
  - `func laneLanded(g *waveobj.TaskGroup, lane []string) bool`
  - `func laneMergeMessage(g *waveobj.TaskGroup, lane []string) string`
  - `func depSatisfied(g *waveobj.TaskGroup, taskID, depID string) bool` (was `depSatisfied(g, id)`)

- [ ] **Step 1: Write the failing tests**

Create `pkg/orchestrate/lane_test.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package orchestrate

import (
	"reflect"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// laneGroup is the lane t-1 -> t-2 -> t-3, then t-4 and t-5, each depending on t-3 in a lane of its own.
func laneGroup(t *testing.T, mergeRequired bool, states map[string]string) *waveobj.TaskGroup {
	t.Helper()
	g, err := NewTaskGroup("run-1", "ch-1", "g", 2, mergeRequired, []waveobj.TaskNode{
		{ID: "t-1", Label: "schema"},
		{ID: "t-2", Label: "api", Deps: []string{"t-1"}},
		{ID: "t-3", Label: "ui", Deps: []string{"t-2"}},
		{ID: "t-4", Label: "docs", Deps: []string{"t-3"}},
		{ID: "t-5", Label: "e2e", Deps: []string{"t-3"}},
	}, 1, nil)
	if err != nil {
		t.Fatal(err)
	}
	for id, s := range states {
		task := taskByID(&g, id)
		task.State = s
		if s == TaskState_Done || s == TaskState_Running {
			task.RunID = "run-" + id
		}
	}
	RecomputeDagStatus(&g)
	return &g
}

func markMerged(g *waveobj.TaskGroup, ids ...string) {
	for _, id := range ids {
		taskByID(g, id).Merged = true
	}
}

func TestLaneWorktreeKeyIsSharedAlongALane(t *testing.T) {
	g := laneGroup(t, true, nil)
	if got := laneOf(g, "t-2"); !reflect.DeepEqual(got, []string{"t-1", "t-2", "t-3"}) {
		t.Fatalf("lane of t-2 = %v", got)
	}
	if got := laneOf(g, "t-9"); got != nil {
		t.Fatalf("an unknown task has no lane, got %v", got)
	}
	for _, id := range []string{"t-1", "t-2", "t-3"} {
		if got := LaneWorktreeKey(g, id); got != TaskWorktreeKey("run-1", "t-1") {
			t.Fatalf("%s: key = %s, want the lane's first task's", id, got)
		}
	}
	if got := LaneWorktreeKey(g, "t-4"); got != TaskWorktreeKey("run-1", "t-4") {
		t.Fatalf("a one-task lane keys as the task always did, got %s", got)
	}
}

func TestDepSatisfiedInLaneAndAcrossLanes(t *testing.T) {
	cases := []struct {
		name          string
		mergeRequired bool
		states        map[string]string
		merged        []string
		task, dep     string
		want          bool
	}{
		{"same lane: a done dependency is enough, its commits are in the tree", true,
			map[string]string{"t-1": TaskState_Done}, nil, "t-2", "t-1", true},
		{"same lane: a running dependency is not", true,
			map[string]string{"t-1": TaskState_Running}, nil, "t-2", "t-1", false},
		{"another lane: a done, unmerged dependency is not", true,
			map[string]string{"t-1": TaskState_Done, "t-2": TaskState_Done, "t-3": TaskState_Done}, nil, "t-4", "t-3", false},
		{"another lane: the whole lane merged is", true,
			map[string]string{"t-1": TaskState_Done, "t-2": TaskState_Done, "t-3": TaskState_Done}, []string{"t-1", "t-2", "t-3"}, "t-4", "t-3", true},
		{"another lane: a skipped dependency waits for the rest of its lane to land", true,
			map[string]string{"t-1": TaskState_Done, "t-2": TaskState_Done, "t-3": TaskState_Skipped}, nil, "t-4", "t-3", false},
		{"another lane: a skipped dependency once its lane landed", true,
			map[string]string{"t-1": TaskState_Done, "t-2": TaskState_Done, "t-3": TaskState_Skipped}, []string{"t-1", "t-2"}, "t-4", "t-3", true},
		{"another lane: a lane whose Verify is still running", true,
			map[string]string{"t-1": TaskState_Done, "t-2": TaskState_Done, "t-3": TaskState_Verifying}, []string{"t-1", "t-2", "t-3"}, "t-4", "t-3", false},
		{"no merges: a done dependency is enough anywhere", false,
			map[string]string{"t-1": TaskState_Done, "t-2": TaskState_Done, "t-3": TaskState_Done}, nil, "t-4", "t-3", true},
	}
	for _, c := range cases {
		g := laneGroup(t, c.mergeRequired, c.states)
		markMerged(g, c.merged...)
		if got := depSatisfied(g, c.task, c.dep); got != c.want {
			t.Fatalf("%s: depSatisfied(%s, %s) = %v, want %v", c.name, c.task, c.dep, got, c.want)
		}
	}
}

func TestReadyTasksStartsTheNextTaskInALaneBeforeAnyMerge(t *testing.T) {
	g := laneGroup(t, true, map[string]string{"t-1": TaskState_Done})
	if got := ReadyTasks(g); !reflect.DeepEqual(got, []string{"t-2"}) {
		t.Fatalf("want [t-2], got %v", got)
	}
	g = laneGroup(t, true, map[string]string{"t-1": TaskState_Done, "t-2": TaskState_Done, "t-3": TaskState_Done})
	if got := ReadyTasks(g); len(got) != 0 {
		t.Fatalf("tasks in another lane wait for the lane to merge, got %v", got)
	}
	markMerged(g, "t-1", "t-2", "t-3")
	if got := ReadyTasks(g); !reflect.DeepEqual(got, []string{"t-4", "t-5"}) {
		t.Fatalf("want [t-4 t-5] once the lane landed, got %v", got)
	}
}

// retrying an earlier task while a later one runs would put two workers in one tree
func TestNextToSpawnRunsOneWorkerPerLane(t *testing.T) {
	g := laneGroup(t, true, map[string]string{"t-1": TaskState_Pending, "t-2": TaskState_Running})
	if got := NextToSpawn(g); len(got) != 0 {
		t.Fatalf("a lane with a running worker dispatches nothing more, got %v", got)
	}
}

func TestLaneMergeReadyNamesTheTip(t *testing.T) {
	lane := []string{"t-1", "t-2", "t-3"}
	done := map[string]string{"t-1": TaskState_Done, "t-2": TaskState_Done, "t-3": TaskState_Done}
	cases := []struct {
		name   string
		states map[string]string
		merged []string
		gate   bool
		want   string
	}{
		{"a task still running", map[string]string{"t-1": TaskState_Done, "t-2": TaskState_Done, "t-3": TaskState_Running}, nil, false, ""},
		{"every task done", done, nil, false, "t-3"},
		{"the last task skipped", map[string]string{"t-1": TaskState_Done, "t-2": TaskState_Done, "t-3": TaskState_Skipped}, nil, false, "t-2"},
		{"every task skipped", map[string]string{"t-1": TaskState_Skipped, "t-2": TaskState_Skipped, "t-3": TaskState_Skipped}, nil, false, ""},
		{"already merged", done, []string{"t-1", "t-2", "t-3"}, false, ""},
		{"a done gate not released", done, nil, true, ""},
	}
	for _, c := range cases {
		g := laneGroup(t, true, c.states)
		markMerged(g, c.merged...)
		taskByID(g, "t-2").Gate = c.gate
		got := ""
		if tip := laneMergeReady(g, lane); tip != nil {
			got = tip.ID
		}
		if got != c.want {
			t.Fatalf("%s: tip = %q, want %q", c.name, got, c.want)
		}
	}
}

func TestLaneMergeMessageNamesEveryLandedTask(t *testing.T) {
	g := laneGroup(t, true, map[string]string{"t-1": TaskState_Done, "t-2": TaskState_Skipped, "t-3": TaskState_Done})
	if got := laneMergeMessage(g, []string{"t-1", "t-2", "t-3"}); got != "schema; ui" {
		t.Fatalf("message = %q", got)
	}
	if got := laneMergeMessage(g, []string{"t-4"}); got != "docs" {
		t.Fatalf("a one-task lane is its label, got %q", got)
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go test ./pkg/orchestrate -run 'TestLane|TestDepSatisfied|TestReadyTasksStartsTheNextTask|TestNextToSpawnRunsOneWorker' -count=1`
Expected: build failure naming `laneOf`, `LaneWorktreeKey`, `laneMergeReady`, `laneMergeMessage`, and too many arguments in the call to `depSatisfied`.

- [ ] **Step 3: Write the lane helpers**

Create `pkg/orchestrate/lane.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package orchestrate

import (
	"slices"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// laneOf returns the lane holding taskID, or nil for an unknown task. Lanes are derived from the
// dependencies on every call rather than stored, so dispatch, the merge path and the digest cannot disagree
// about them.
func laneOf(g *waveobj.TaskGroup, taskID string) []string {
	for _, lane := range jarvis.Lanes(g.Tasks) {
		if slices.Contains(lane, taskID) {
			return lane
		}
	}
	return nil
}

// LaneWorktreeKey is the worktree key every task in a lane shares: its first task's. A one-task lane keys
// exactly as a task always has, so dags without chains keep their trees.
func LaneWorktreeKey(g *waveobj.TaskGroup, taskID string) string {
	first := taskID
	if lane := laneOf(g, taskID); len(lane) > 0 {
		first = lane[0]
	}
	return TaskWorktreeKey(g.RunID, first)
}

// laneTip is the lane's last task that was not skipped: the squash merge, its conflict, its Verify and its
// cleanup are recorded there. Nil when every task in the lane was skipped.
func laneTip(g *waveobj.TaskGroup, lane []string) *waveobj.TaskNode {
	for i := len(lane) - 1; i >= 0; i-- {
		if t := taskByID(g, lane[i]); t != nil && t.State != TaskState_Skipped {
			return t
		}
	}
	return nil
}

// laneMergeReady returns the tip of a lane that is finished and not yet landed: every task done or skipped,
// and every done gate released. Nil otherwise.
func laneMergeReady(g *waveobj.TaskGroup, lane []string) *waveobj.TaskNode {
	tip := laneTip(g, lane)
	if tip == nil || tip.Merged || tip.RunID == "" {
		return nil
	}
	for _, id := range lane {
		t := taskByID(g, id)
		if t.State == TaskState_Skipped {
			continue
		}
		if t.State != TaskState_Done || (t.Gate && !t.Released) {
			return nil
		}
	}
	return tip
}

// mergeReadyTip reports whether t is the tip of a lane waiting to be landed, the one task a merge is
// offered on.
func mergeReadyTip(g *waveobj.TaskGroup, t *waveobj.TaskNode) bool {
	if !g.MergeRequired {
		return false
	}
	tip := laneMergeReady(g, laneOf(g, t.ID))
	return tip != nil && tip.ID == t.ID
}

// laneLanded reports whether a lane's work is on the project branch and verified: each task skipped, or
// done, merged and past its gate.
func laneLanded(g *waveobj.TaskGroup, lane []string) bool {
	for _, id := range lane {
		t := taskByID(g, id)
		if t == nil {
			return false
		}
		if t.State == TaskState_Skipped {
			continue
		}
		if t.State != TaskState_Done || !t.Merged || (t.Gate && !t.Released) {
			return false
		}
	}
	return true
}

// laneMergeMessage names every task the squash commit lands, in lane order.
func laneMergeMessage(g *waveobj.TaskGroup, lane []string) string {
	var labels []string
	for _, id := range lane {
		t := taskByID(g, id)
		if t == nil || t.State == TaskState_Skipped {
			continue
		}
		label := t.Label
		if label == "" {
			label = t.ID
		}
		labels = append(labels, label)
	}
	return strings.Join(labels, "; ")
}
```

- [ ] **Step 4: Make dependencies and dispatch lane-aware**

In `pkg/orchestrate/scheduler.go`, add `"slices"` to the import block:

```go
import (
	"fmt"
	"slices"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)
```

In `ReadyTasks`, replace:

```go
			if !depSatisfied(g, d) {
```

with:

```go
			if !depSatisfied(g, t.ID, d) {
```

Replace the whole `depSatisfied` function with:

```go
// depSatisfied reports whether dependency depID lets taskID start. Without merges, finishing is enough.
// With them, a dependency in the same lane only has to be done, because its commits are already in the tree
// the lane shares; one in another lane is satisfied once its whole lane has landed on the project branch.
func depSatisfied(g *waveobj.TaskGroup, taskID, depID string) bool {
	dep := taskByID(g, depID)
	if dep == nil {
		return false
	}
	if !g.MergeRequired {
		return dep.State == TaskState_Done || dep.State == TaskState_Skipped
	}
	lane := laneOf(g, depID)
	if slices.Contains(lane, taskID) {
		return dep.State == TaskState_Skipped || (dep.State == TaskState_Done && (!dep.Gate || dep.Released))
	}
	return laneLanded(g, lane)
}
```

At the end of `NextToSpawn`, replace:

```go
	ready := ReadyTasks(g)
	if len(ready) > room {
		ready = ready[:room]
	}
	return ready
}
```

with:

```go
	// one worker per lane: its tasks share a tree, and an earlier task that was retried must not start
	// beside a later one still running in it
	lanes := map[string]bool{}
	for i := range g.Tasks {
		if taskActive(g.Tasks[i].State) {
			lanes[LaneWorktreeKey(g, g.Tasks[i].ID)] = true
		}
	}
	var out []string
	for _, id := range ReadyTasks(g) {
		key := LaneWorktreeKey(g, id)
		if lanes[key] {
			continue
		}
		lanes[key] = true
		out = append(out, id)
		if len(out) == room {
			break
		}
	}
	return out
}
```

In `pkg/orchestrate/digest.go`, replace all five occurrences of `depSatisfied(g, d)` with `depSatisfied(g, t.ID, d)` (Edit with `replace_all`). Each enclosing function (`hasUnsatDep`, `depChainReachesMergeReady`, `dependencyWait`, `taskReady`, `taskBlockingIds`) names the dependent task `t`.

- [ ] **Step 5: Run the tests**

Run: `go test ./pkg/orchestrate -run 'TestLane|TestDepSatisfied|TestReadyTasks|TestNextToSpawn' -count=1`
Expected: PASS.

Run: `go test ./pkg/orchestrate -count=1`
Expected: PASS. Merges are still per task until Task 4, so the existing chain tests still merge a task before its dependent starts.

---

### Task 2: Worktrees that continue a lane, and dispatch into them

**Files:**
- Modify: `pkg/orchestrate/worktree.go` (`TaskWorktreeKey` comment, `RemoveRunWorktree`, new `removeWorktreeDir`, `EnsureRunWorktree`, new `worktreeOnBranch`)
- Modify: `pkg/orchestrate/worktree_test.go` (three call sites, four new tests)
- Modify: `pkg/orchestrate/mutation_test.go` (one call site in `TestCancelPersistsCleanupDebtAndRetry`)
- Modify: `pkg/orchestrate/engine.go` (dispatch in `scheduleLocked`, `predecessorHandoff` comment)

**Interfaces:**
- Consumes: `LaneWorktreeKey` (Task 1).
- Produces:
  - `func EnsureRunWorktree(ctx context.Context, projectPath, runID, baseCommit string) (string, string, bool, error)`, returning the tree, the head commit the next task starts at, and whether this call created the tree.
  - `func removeWorktreeDir(ctx context.Context, projectPath, wt string) error`, which removes the directory and keeps the branch.
  - A dispatched child run's `BaseCommit` is now its lane tree's head.

- [ ] **Step 1: Write the failing tests**

In `pkg/orchestrate/worktree_test.go`, update the three existing `EnsureRunWorktree` calls:

- `got, created, err := EnsureRunWorktree(context.Background(), dir, key, base)` becomes `got, _, created, err := EnsureRunWorktree(context.Background(), dir, key, base)`
- `got, _, err := EnsureRunWorktree(context.Background(), dir, key, newBase)` becomes `got, _, _, err := EnsureRunWorktree(context.Background(), dir, key, newBase)`
- `if _, created, err := EnsureRunWorktree(context.Background(), dir, key, base); err != nil || !created {` becomes `if _, _, created, err := EnsureRunWorktree(context.Background(), dir, key, base); err != nil || !created {`

In `pkg/orchestrate/mutation_test.go`, replace:

```go
	if _, _, err := EnsureRunWorktree(ctx, projectDir, TaskWorktreeKey(owner.ID, "t-0"), owner.BaseCommit); err != nil {
```

with:

```go
	if _, _, _, err := EnsureRunWorktree(ctx, projectDir, TaskWorktreeKey(owner.ID, "t-0"), owner.BaseCommit); err != nil {
```

Append to the end of `pkg/orchestrate/worktree_test.go`, after `newGitRepoAt`:

```go
func TestEnsureRunWorktreeReturnsTheCommitATaskStartsAt(t *testing.T) {
	dir := newGitRepo(t)
	base := gitCmd(t, dir, "rev-parse", "HEAD")
	key := TaskWorktreeKey("owner-1", "t-1")
	wt, head, created, err := EnsureRunWorktree(context.Background(), dir, key, base)
	if err != nil || !created || head != base {
		t.Fatalf("a new tree starts at the base: head %s created %v err %v", head, created, err)
	}
	os.WriteFile(filepath.Join(wt, "schema.txt"), []byte("schema\n"), 0o644)
	gitCmd(t, wt, "add", ".")
	gitCmd(t, wt, "commit", "-m", "schema")
	committed := gitCmd(t, wt, "rev-parse", "HEAD")

	got, head, created, err := EnsureRunWorktree(context.Background(), dir, key, base)
	if err != nil || created || got != wt || head != committed {
		t.Fatalf("the next task in the lane starts at the last commit: head %s created %v err %v", head, created, err)
	}
}

func TestEnsureRunWorktreeRebuildsADirtyTreeFromItsBranch(t *testing.T) {
	dir := newGitRepo(t)
	base := gitCmd(t, dir, "rev-parse", "HEAD")
	key := TaskWorktreeKey("owner-1", "t-1")
	wt, err := CreateRunWorktree(context.Background(), dir, key, base)
	if err != nil {
		t.Fatal(err)
	}
	os.WriteFile(filepath.Join(wt, "schema.txt"), []byte("schema\n"), 0o644)
	gitCmd(t, wt, "add", ".")
	gitCmd(t, wt, "commit", "-m", "schema")
	committed := gitCmd(t, wt, "rev-parse", "HEAD")
	os.WriteFile(filepath.Join(wt, "leftover.txt"), []byte("wip\n"), 0o644)

	_, head, created, err := EnsureRunWorktree(context.Background(), dir, key, base)
	if err != nil || !created || head != committed {
		t.Fatalf("a dirty tree is checked out again at its branch: head %s created %v err %v", head, created, err)
	}
	if _, err := os.Stat(filepath.Join(wt, "schema.txt")); err != nil {
		t.Fatalf("the lane's committed work must survive the rebuild: %v", err)
	}
	if _, err := os.Stat(filepath.Join(wt, "leftover.txt")); !os.IsNotExist(err) {
		t.Fatalf("uncommitted state must not survive the rebuild, stat err = %v", err)
	}
	patch, err := os.ReadFile(filepath.Join(dir, ".waveterm", "recovery", key+".patch"))
	if err != nil || !strings.Contains(string(patch), "leftover.txt") {
		t.Fatalf("the uncommitted state goes to a recovery patch, got %q err %v", patch, err)
	}
}

func TestEnsureRunWorktreeChecksOutAMissingTreeFromItsBranch(t *testing.T) {
	dir := newGitRepo(t)
	base := gitCmd(t, dir, "rev-parse", "HEAD")
	key := TaskWorktreeKey("owner-1", "t-1")
	wt, err := CreateRunWorktree(context.Background(), dir, key, base)
	if err != nil {
		t.Fatal(err)
	}
	os.WriteFile(filepath.Join(wt, "schema.txt"), []byte("schema\n"), 0o644)
	gitCmd(t, wt, "add", ".")
	gitCmd(t, wt, "commit", "-m", "schema")
	if err := os.RemoveAll(wt); err != nil {
		t.Fatal(err)
	}

	if _, _, created, err := EnsureRunWorktree(context.Background(), dir, key, base); err != nil || !created {
		t.Fatalf("a registered tree whose directory is gone is checked out again: created %v err %v", created, err)
	}
	if _, err := os.Stat(filepath.Join(wt, "schema.txt")); err != nil {
		t.Fatalf("the branch's work must be in the new tree: %v", err)
	}
}

// git run inside a directory that is no longer a worktree acts on the project checkout above it, so a
// recovery dump there would stage the project's own changes
func TestEnsureRunWorktreeLeavesTheProjectIndexAloneForAStrayDirectory(t *testing.T) {
	dir := newGitRepo(t)
	base := gitCmd(t, dir, "rev-parse", "HEAD")
	key := TaskWorktreeKey("owner-1", "t-1")
	wt, err := CreateRunWorktree(context.Background(), dir, key, base)
	if err != nil {
		t.Fatal(err)
	}
	gitCmd(t, dir, "worktree", "remove", "--force", wt)
	if err := os.MkdirAll(wt, 0o755); err != nil {
		t.Fatal(err)
	}
	os.WriteFile(filepath.Join(wt, "stray.txt"), []byte("stray\n"), 0o644)

	_, _, _, _ = EnsureRunWorktree(context.Background(), dir, key, base)
	if staged := gitCmd(t, dir, "diff", "--cached", "--name-only"); staged != "" {
		t.Fatalf("nothing may be staged in the project checkout, got %q", staged)
	}
}

func TestRemoveWorktreeDirKeepsTheBranch(t *testing.T) {
	dir := newGitRepo(t)
	base := gitCmd(t, dir, "rev-parse", "HEAD")
	wt, err := CreateRunWorktree(context.Background(), dir, "run-1", base)
	if err != nil {
		t.Fatal(err)
	}
	if err := removeWorktreeDir(context.Background(), dir, wt); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(wt); !os.IsNotExist(err) {
		t.Fatalf("the directory must go, stat err = %v", err)
	}
	if got := gitCmd(t, dir, "rev-parse", "wave/run-1"); got != base {
		t.Fatalf("the branch must stay, got %q", got)
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go test ./pkg/orchestrate -run 'TestEnsureRunWorktree|TestRemoveWorktreeDir' -count=1`
Expected: build failure, with an assignment mismatch on `EnsureRunWorktree` and `removeWorktreeDir` undefined.

- [ ] **Step 3: Rewrite the worktree functions**

In `pkg/orchestrate/worktree.go`, replace the comment above `TaskWorktreeKey`:

```go
// TaskWorktreeKey derives the per-task worktree key: <owner run ID>-<task ID>. Single source of
// truth for the key — engine spawn, merge, and cancel sweeps must all derive it identically.
```

with:

```go
// TaskWorktreeKey derives a worktree key from a task: <owner run ID>-<task ID>. Tasks share their lane's
// tree, so spawn, merge, cleanup and the cancel sweep all key through LaneWorktreeKey, which calls this
// with the lane's first task.
```

Replace the whole `RemoveRunWorktree` function (its doc comment through its closing brace) with:

```go
// RemoveRunWorktree removes the linked worktree and its branch.
func RemoveRunWorktree(ctx context.Context, projectPath, runID string) error {
	wt := worktreeDir(projectPath, runID)
	if _, err := os.Stat(wt); err != nil {
		return nil // nothing to remove
	}
	if err := removeWorktreeDir(ctx, projectPath, wt); err != nil {
		return err
	}
	git(ctx, projectPath, "branch", "-D", "wave/"+runID) // best-effort
	return nil
}

// removeWorktreeDir unregisters and deletes a linked worktree's directory and keeps its branch.
func removeWorktreeDir(ctx context.Context, projectPath, wt string) error {
	// before git sees the tree: its forced removal deletes through a junction into the target
	if err := unlinkReparsePoints(wt); err != nil {
		return fmt.Errorf("removing worktree: %w", err)
	}
	if _, err := git(ctx, projectPath, "worktree", "remove", "--force", wt); err != nil {
		// On Windows the dir can remain locked by an idle child shell or by
		// junctioned node_modules/src-tauri/target/dist/bin. If git no longer
		// lists the worktree, the registration is gone and the lingering dir
		// should be treated as already removed.
		if !isWorktreeRegistered(ctx, projectPath, wt) {
			return nil
		}
		return fmt.Errorf("removing worktree: %w", err)
	}
	return nil
}
```

Replace the whole `EnsureRunWorktree` function (its doc comment through its closing brace) with:

```go
// EnsureRunWorktree returns a usable linked worktree for runID, the commit its next task starts at, and
// whether this call created the tree, so one-time preparation runs only on a fresh tree. An existing branch
// is continued, never discarded: its commits are the finished tasks earlier in the lane, or an earlier
// attempt's work, which the next task builds on and the lane's merge lands. A clean tree on the branch is
// reused; a dirty one has its uncommitted state dumped to a recovery patch, and a dirty or missing one is
// checked out again from the branch. With no branch, the tree is created at baseCommit.
func EnsureRunWorktree(ctx context.Context, projectPath, runID, baseCommit string) (string, string, bool, error) {
	wt := worktreeDir(projectPath, runID)
	_, statErr := os.Stat(wt)
	head, headErr := WorktreeHeadCommit(ctx, projectPath, runID)
	if headErr != nil {
		if statErr == nil {
			DumpRecoveryPatch(ctx, projectPath, runID) // best effort; rebuild proceeds either way
			if err := RemoveRunWorktree(ctx, projectPath, runID); err != nil {
				return "", "", false, fmt.Errorf("recreating stale worktree: %w", err)
			}
		}
		if _, err := CreateRunWorktree(ctx, projectPath, runID, baseCommit); err != nil {
			return "", "", false, err
		}
		created, err := WorktreeHeadCommit(ctx, projectPath, runID)
		if err != nil {
			return "", "", false, fmt.Errorf("reading new worktree head: %w", err)
		}
		return wt, created, true, nil
	}
	if statErr == nil {
		if worktreeOnBranch(ctx, wt, runID) {
			status, err := git(ctx, wt, "status", "--porcelain")
			if err == nil && strings.TrimSpace(status) == "" {
				return wt, head, false, nil
			}
			DumpRecoveryPatch(ctx, projectPath, runID) // best effort; rebuild proceeds either way
		}
		if err := removeWorktreeDir(ctx, projectPath, wt); err != nil {
			return "", "", false, fmt.Errorf("recreating worktree: %w", err)
		}
	}
	// a registration whose directory is already gone makes the add refuse
	if _, err := git(ctx, projectPath, "worktree", "prune"); err != nil {
		return "", "", false, fmt.Errorf("pruning worktrees: %w", err)
	}
	if _, err := git(ctx, projectPath, "worktree", "add", wt, "wave/"+runID); err != nil {
		return "", "", false, fmt.Errorf("checking out worktree from wave/%s: %w", runID, err)
	}
	return wt, head, true, nil
}

// worktreeOnBranch reports whether wt is a checked-out tree of wave/<runID>. A directory whose registration
// git already dropped is not one, and git run inside it acts on the project checkout above it.
func worktreeOnBranch(ctx context.Context, wt, runID string) bool {
	branch, err := git(ctx, wt, "rev-parse", "--abbrev-ref", "HEAD")
	return err == nil && branch == "wave/"+runID
}
```

- [ ] **Step 4: Dispatch into the lane's tree**

In `pkg/orchestrate/engine.go` `scheduleLocked`, replace:

```go
		cwd := owner.ProjectPath
		var worktreeMs, setupMs int64
		if IsGitRepo(owner.ProjectPath) {
			key := TaskWorktreeKey(owner.ID, taskID)
			wtStart := time.Now()
			wt, created, werr := EnsureRunWorktree(spawnCtx, owner.ProjectPath, key, spawnBase)
			worktreeMs = time.Since(wtStart).Milliseconds()
			if werr != nil {
				failDispatch(ctx, g, taskID, FailureKindWorktree, werr, &afterCommit)
				continue
			}
			if created && g.Setup != "" {
				setupStart := time.Now()
				serr := runPlanCommand(context.WithoutCancel(ctx), wt, g.Setup, SetupTimeout)
				setupMs = time.Since(setupStart).Milliseconds()
				if serr != nil {
					// only a new tree is set up, so a retry would reuse this half-prepared one as-is
					if rerr := RemoveRunWorktree(context.WithoutCancel(ctx), owner.ProjectPath, key); rerr != nil {
						log.Printf("schedule dag %s task %s: removing worktree after setup failure: %v", g.OID, taskID, rerr)
					}
					failDispatch(ctx, g, taskID, FailureKindSetup, serr, &afterCommit)
					continue
				}
			}
			cwd = wt
		}
```

with:

```go
		cwd := owner.ProjectPath
		taskBase := spawnBase
		var worktreeMs, setupMs int64
		if IsGitRepo(owner.ProjectPath) {
			// a lane's tasks share one tree, so each starts from the commits of the task before it
			key := LaneWorktreeKey(g, taskID)
			wtStart := time.Now()
			wt, head, created, werr := EnsureRunWorktree(spawnCtx, owner.ProjectPath, key, spawnBase)
			worktreeMs = time.Since(wtStart).Milliseconds()
			if werr != nil {
				failDispatch(ctx, g, taskID, FailureKindWorktree, werr, &afterCommit)
				continue
			}
			if created && g.Setup != "" {
				setupStart := time.Now()
				serr := runPlanCommand(context.WithoutCancel(ctx), wt, g.Setup, SetupTimeout)
				setupMs = time.Since(setupStart).Milliseconds()
				if serr != nil {
					// only a new tree is set up, so a retry must not reuse this half-prepared one. The branch
					// stays: it holds the lane's earlier commits, and the retry checks it out again.
					if rerr := removeWorktreeDir(context.WithoutCancel(ctx), owner.ProjectPath, wt); rerr != nil {
						log.Printf("schedule dag %s task %s: removing worktree after setup failure: %v", g.OID, taskID, rerr)
					}
					failDispatch(ctx, g, taskID, FailureKindSetup, serr, &afterCommit)
					continue
				}
			}
			cwd = wt
			taskBase = head
		}
```

In the same function, replace:

```go
		childRun := childRunFromSpec(g, task, owner, pin, cwd, spawnBase, prompt)
```

with:

```go
		childRun := childRunFromSpec(g, task, owner, pin, cwd, taskBase, prompt)
```

In the `predecessorHandoff` doc comment, replace:

```go
// The commit is citable from the dependent's own tree: a dep is only satisfied once merged
// (depSatisfied), and that merge squashes onto the project branch its worktree branches from.
```

with:

```go
// The commit is citable from the dependent's own tree: a dependency in the same lane committed it in the
// tree the dependent now works in, and one in another lane is satisfied only once its lane merged onto the
// project branch the dependent's tree branches from (depSatisfied).
```

- [ ] **Step 5: Run the tests**

Run: `go test ./pkg/orchestrate -run 'TestEnsureRunWorktree|TestRemoveWorktreeDir|TestRemoveRunWorktree|TestCreateAndRemoveWorktree|TestRecoveryPatch|TestDispatchRunsSetup|TestSetupFailure|TestNoSetupLine|TestCancel' -count=1`
Expected: PASS.

Run: `go test ./pkg/orchestrate -count=1`
Expected: PASS.

---

### Task 3: The spec and plan, stored on the dag and staged by the squash merge

**Files:**
- Modify: `pkg/waveobj/wtype.go` (`TaskGroup.PlanPath`, `TaskGroup.SpecPath`)
- Modify: `pkg/wshrpc/wshrpctypes_dag.go` (`CommandDagSubmitData.SpecPath`)
- Modify: `pkg/wshrpc/wshserver/wshserver_dag.go` (`loadDagPlan`, `DagSubmitCommand`)
- Modify: `pkg/orchestrate/dag.go` (`SameDagProposal`)
- Modify: `pkg/orchestrate/merge.go` (a `fold` parameter)
- Modify: `pkg/orchestrate/mergetask.go` (the two seam calls pass `nil` until Task 4)
- Modify: `pkg/orchestrate/merge_test.go` (whole file)
- Modify: `pkg/orchestrate/mergetask_test.go` (`stubMerge`)
- Modify: `pkg/orchestrate/continue_test.go` (the `continueMerge` stub)
- Modify: `pkg/orchestrate/dag_test.go` (one new test)
- Modify: `pkg/wshrpc/wshserver/wshserver_dagplan_test.go`
- Modify: `cmd/wsh/cmd/wshcmd-jarvisdag.go` (`--spec`, `dagSpecPath`)
- Modify: `cmd/wsh/cmd/wshcmd-jarvisdag_test.go`
- Generated: `frontend/types/gotypes.d.ts`

**Interfaces:**
- Produces:
  - `TaskGroup.PlanPath string` (json `planpath`) and `TaskGroup.SpecPath string` (json `specpath`)
  - `CommandDagSubmitData.SpecPath string` (json `specpath`)
  - `func MergeRunWorktree(ctx context.Context, projectPath, runID, goal string, fold []string) (string, error)`
  - `func MergeContinue(ctx context.Context, projectPath, runID, goal string, fold []string) (string, error)`
  - `mergeWorktree` and `continueMerge` take the same five parameters.
  - `func dagSpecPath(planPath, spec string) (string, error)` in `cmd/wsh/cmd`

- [ ] **Step 1: Write the failing tests**

Replace the whole of `pkg/orchestrate/merge_test.go` with:

```go
package orchestrate

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestMergeSquash(t *testing.T) {
	dir := newGitRepo(t)
	base := gitCmd(t, dir, "rev-parse", "HEAD")
	wt, _ := CreateRunWorktree(context.Background(), dir, "run-1", base)
	os.WriteFile(filepath.Join(wt, "feature.txt"), []byte("feat\n"), 0o644)
	gitCmd(t, wt, "add", ".")
	gitCmd(t, wt, "commit", "-m", "feature")
	sha, err := MergeRunWorktree(context.Background(), dir, "run-1", "do the thing", nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "feature.txt")); err != nil {
		t.Fatalf("merged file missing: %v", err)
	}
	if len(sha) != 40 {
		t.Fatalf("bad merge sha %q", sha)
	}
	// integration is separate from resource cleanup: the worktree stays until the caller
	// runs CleanupTaskWorktree, so a cleanup failure can never obscure an already-landed merge.
	if _, err := os.Stat(wt); err != nil {
		t.Fatalf("worktree removal must be left to the cleanup helper: %v", err)
	}
}

func TestMergeConflictBlocked(t *testing.T) {
	dir := newGitRepo(t)
	base := gitCmd(t, dir, "rev-parse", "HEAD")
	wt, _ := CreateRunWorktree(context.Background(), dir, "run-1", base)
	os.WriteFile(filepath.Join(wt, "base.txt"), []byte("child change\n"), 0o644)
	gitCmd(t, wt, "add", ".")
	gitCmd(t, wt, "commit", "-m", "child")
	os.WriteFile(filepath.Join(dir, "base.txt"), []byte("parent change\n"), 0o644)
	gitCmd(t, dir, "add", ".")
	gitCmd(t, dir, "commit", "-m", "parent")
	_, err := MergeRunWorktree(context.Background(), dir, "run-1", "do the thing", nil)
	if !errors.Is(err, ErrMergeConflict) {
		t.Fatalf("want ErrMergeConflict, got %v", err)
	}
	// resolve in the project tree, then continue
	os.WriteFile(filepath.Join(dir, "base.txt"), []byte("resolved\n"), 0o644)
	gitCmd(t, dir, "add", ".")
	if _, err := MergeContinue(context.Background(), dir, "run-1", "do the thing", nil); err != nil {
		t.Fatal(err)
	}
}

func TestMergeRunWorktreeNonGit(t *testing.T) {
	dir := t.TempDir()
	_, err := MergeRunWorktree(context.Background(), dir, "run-1", "x", nil)
	if !errors.Is(err, ErrNotGitRepo) {
		t.Fatalf("want ErrNotGitRepo, got %v", err)
	}
}

// the run's spec and plan sit uncommitted in the project checkout until its first merge, which lands them
// with the work they describe
func TestMergeRunWorktreeFoldsDocsIntoTheSquashCommit(t *testing.T) {
	dir := newGitRepo(t)
	base := gitCmd(t, dir, "rev-parse", "HEAD")
	wt, _ := CreateRunWorktree(context.Background(), dir, "run-1", base)
	os.WriteFile(filepath.Join(wt, "feature.txt"), []byte("feat\n"), 0o644)
	gitCmd(t, wt, "add", ".")
	gitCmd(t, wt, "commit", "-m", "feature")
	spec := filepath.Join(dir, "spec.md")
	plan := filepath.Join(dir, "plan.md")
	os.WriteFile(spec, []byte("# spec\n"), 0o644)
	os.WriteFile(plan, []byte("# plan\n"), 0o644)
	outside := filepath.Join(t.TempDir(), "elsewhere.md")
	os.WriteFile(outside, []byte("# not in this repo\n"), 0o644)

	if _, err := MergeRunWorktree(context.Background(), dir, "run-1", "lane", []string{spec, plan, outside}); err != nil {
		t.Fatalf("a path git will not stage must not fail the merge: %v", err)
	}
	files := strings.Fields(gitCmd(t, dir, "show", "--name-only", "--format=", "HEAD"))
	if want := []string{"feature.txt", "plan.md", "spec.md"}; !reflect.DeepEqual(files, want) {
		t.Fatalf("squash commit files = %v, want %v", files, want)
	}
}
```

Read the last lines of `pkg/orchestrate/dag_test.go` and append after its final closing brace:

```go
func TestSameDagProposalComparesPlanAndSpecPaths(t *testing.T) {
	a, err := NewTaskGroup("run-1", "ch-1", "g", 1, true, []waveobj.TaskNode{{ID: "t-1", Label: "a"}}, 1, nil)
	if err != nil {
		t.Fatal(err)
	}
	a.PlanPath = "/docs/plan.md"
	b := a
	if !SameDagProposal(&a, &b) {
		t.Fatal("identical proposals must match")
	}
	b.SpecPath = "/docs/spec.md"
	if SameDagProposal(&a, &b) {
		t.Fatal("a resubmission naming a different spec is a different proposal")
	}
}
```

In `pkg/wshrpc/wshserver/wshserver_dagplan_test.go`, in the rejection table, replace:

```go
			{"unparseable plan", wshrpc.CommandDagSubmitData{PlanPath: writePlan(t, "prose.md", "just prose\n")}, "no tasks"},
```

with:

```go
			{"unparseable plan", wshrpc.CommandDagSubmitData{PlanPath: writePlan(t, "prose.md", "just prose\n")}, "no tasks"},
			{"spec without a plan", wshrpc.CommandDagSubmitData{SpecPath: writePlan(t, "spec.md", "# spec\n"), Tasks: []waveobj.TaskNode{{ID: "t-1", Label: "a"}}}, "needs planpath"},
			{"relative spec path", wshrpc.CommandDagSubmitData{PlanPath: writePlan(t, "plan.md", plan), SpecPath: "spec.md"}, "absolute"},
			{"missing spec file", wshrpc.CommandDagSubmitData{PlanPath: writePlan(t, "plan.md", plan), SpecPath: filepath.Join(dir, "missing-spec.md")}, "missing-spec.md"},
```

At the end of the same file, replace:

```go
		if g.Verify != "task test" || g.Setup != "task worktree:prepare" {
			t.Fatalf("verify %q, setup %q", g.Verify, g.Setup)
		}
	})
}
```

with:

```go
		if g.Verify != "task test" || g.Setup != "task worktree:prepare" {
			t.Fatalf("verify %q, setup %q", g.Verify, g.Setup)
		}
	})

	t.Run("the plan and spec paths are stored on the dag", func(t *testing.T) {
		channelId, runId := newRun(t)
		planPath, specPath := writePlan(t, "plan.md", plan), writePlan(t, "spec.md", "# spec\n")
		g, err := (&WshServer{}).DagSubmitCommand(ctx, wshrpc.CommandDagSubmitData{ChannelId: channelId, RunId: runId, PlanPath: planPath, SpecPath: specPath})
		if err != nil {
			t.Fatal(err)
		}
		if g.PlanPath != planPath || g.SpecPath != specPath {
			t.Fatalf("planpath %q, specpath %q", g.PlanPath, g.SpecPath)
		}
	})
}
```

In `cmd/wsh/cmd/wshcmd-jarvisdag_test.go`, add after `TestDagPlanPath`:

```go
func TestDagSpecPath(t *testing.T) {
	if dagSubmitCmd.Flags().Lookup("spec") == nil {
		t.Fatal("dag submit must expose --spec")
	}
	if got, err := dagSpecPath("", ""); err != nil || got != "" {
		t.Fatalf("no --spec = %q, %v", got, err)
	}
	if _, err := dagSpecPath("", "spec.md"); err == nil {
		t.Fatal("--spec without --plan must be rejected")
	}
	// wavesrv does not share the lead's cwd, so a relative --spec has to be resolved here
	got, err := dagSpecPath(filepath.Join(string(filepath.Separator), "plan.md"), filepath.Join("docs", "spec.md"))
	if err != nil || !filepath.IsAbs(got) || !strings.HasSuffix(got, filepath.Join("docs", "spec.md")) {
		t.Fatalf("relative --spec = %q, %v", got, err)
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go test ./pkg/orchestrate -run 'TestMerge|TestSameDagProposal' -count=1`
Expected: build failure (too many arguments in the calls to `MergeRunWorktree` and `MergeContinue`; `PlanPath` undefined).

Run: `go test ./cmd/wsh/cmd -run TestDagSpecPath -count=1`
Expected: build failure (`dagSpecPath` undefined).

- [ ] **Step 3: Add the fields and the submit path**

In `pkg/waveobj/wtype.go`, replace:

```go
	Verify string `json:"verify,omitempty"`
	Setup  string `json:"setup,omitempty"`
}
```

with:

```go
	Verify string `json:"verify,omitempty"`
	Setup  string `json:"setup,omitempty"`

	// PlanPath and SpecPath are the absolute paths of the plan a dag was submitted from and the spec it
	// implements. They stay uncommitted in the project checkout until the dag's first squash merge, which
	// stages both so the docs land with the work they describe. Empty for a dag submitted as JSON.
	PlanPath string `json:"planpath,omitempty"`
	SpecPath string `json:"specpath,omitempty"`
}
```

In `pkg/wshrpc/wshrpctypes_dag.go`, in `CommandDagSubmitData`, replace:

```go
	PlanPath    string             `json:"planpath,omitempty"`    // absolute path to a plan in jarvis.PlanFormat; replaces tasks
```

with:

```go
	PlanPath    string             `json:"planpath,omitempty"`    // absolute path to a plan in jarvis.PlanFormat; replaces tasks
	SpecPath    string             `json:"specpath,omitempty"`    // absolute path to the spec the plan implements; only with planpath
```

In `pkg/wshrpc/wshserver/wshserver_dag.go` `loadDagPlan`, replace:

```go
	if len(data.Tasks) > 0 {
		return jarvis.Plan{}, fmt.Errorf("pass tasks or planpath, not both")
	}
```

with:

```go
	if len(data.Tasks) > 0 {
		return jarvis.Plan{}, fmt.Errorf("pass tasks or planpath, not both")
	}
	if data.SpecPath != "" {
		if !filepath.IsAbs(data.SpecPath) {
			return jarvis.Plan{}, fmt.Errorf("specpath %q must be absolute", data.SpecPath)
		}
		// checked now: a mistyped path would otherwise surface only as a log line at the first merge
		if _, err := os.Stat(data.SpecPath); err != nil {
			return jarvis.Plan{}, fmt.Errorf("reading spec: %w", err)
		}
	}
```

In `DagSubmitCommand`, replace:

```go
	var plan jarvis.Plan
	if data.PlanPath != "" {
```

with:

```go
	var plan jarvis.Plan
	if data.SpecPath != "" && data.PlanPath == "" {
		return nil, fmt.Errorf("specpath needs planpath: the spec is committed with the plan it produced")
	}
	if data.PlanPath != "" {
```

and replace:

```go
	proposed.Verify, proposed.Setup = plan.Verify, plan.Setup
```

with:

```go
	proposed.Verify, proposed.Setup = plan.Verify, plan.Setup
	proposed.PlanPath, proposed.SpecPath = data.PlanPath, data.SpecPath
```

In `pkg/orchestrate/dag.go` `SameDagProposal`, replace:

```go
		a.Verify != b.Verify || a.Setup != b.Setup || len(a.Tasks) != len(b.Tasks) {
```

with:

```go
		a.Verify != b.Verify || a.Setup != b.Setup || a.PlanPath != b.PlanPath || a.SpecPath != b.SpecPath || len(a.Tasks) != len(b.Tasks) {
```

- [ ] **Step 4: Stage the fold inside the merge**

Replace the whole of `pkg/orchestrate/merge.go` with:

```go
package orchestrate

import (
	"context"
	"errors"
	"fmt"
	"log"
	"strings"
)

var ErrMergeConflict = errors.New("merge conflict")

// MergeRunWorktree squash-merges wave/<runID> into the project branch and returns the merge commit
// sha. fold names uncommitted files in the project checkout that belong in the same commit: the run's spec
// and plan, on its first merge. Worktree removal is the caller's step (CleanupTaskWorktree) so a cleanup
// failure can never obscure an already-landed merge. On conflict the tree is left mid-merge
// (ErrMergeConflict) and the caller resolves then calls MergeContinue.
func MergeRunWorktree(ctx context.Context, projectPath, runID, goal string, fold []string) (string, error) {
	if !IsGitRepo(projectPath) {
		return "", ErrNotGitRepo
	}
	branch := "wave/" + runID
	// Idempotency: if the branch is already gone, the squash commit landed on a
	// prior attempt that failed only on worktree cleanup. Return HEAD without
	// re-merging so the caller can still stamp Merged/EndCommit and clean up.
	if _, err := git(ctx, projectPath, "rev-parse", "--verify", branch); err != nil {
		if sha, gerr := git(ctx, projectPath, "rev-parse", "HEAD"); gerr == nil {
			return strings.TrimSpace(sha), nil
		}
		return "", fmt.Errorf("squash merge: %w", err)
	}
	if _, err := git(ctx, projectPath, "merge", "--squash", branch); err != nil {
		if strings.Contains(err.Error(), "CONFLICT") {
			return "", ErrMergeConflict
		}
		// Idempotent retry: prior squash already landed, merge reports
		// "Already up to date" and there is nothing to commit.
		if strings.Contains(err.Error(), "Already up to date") {
			if sha, gerr := git(ctx, projectPath, "rev-parse", "HEAD"); gerr == nil {
				return strings.TrimSpace(sha), nil
			}
		}
		return "", fmt.Errorf("squash merge: %w", err)
	}
	return finishMerge(ctx, projectPath, runID, goal, fold)
}

// MergeContinue completes a merge after the caller resolved conflicts in the project tree.
func MergeContinue(ctx context.Context, projectPath, runID, goal string, fold []string) (string, error) {
	status, err := git(ctx, projectPath, "status", "--porcelain")
	if err != nil {
		return "", err
	}
	for _, line := range strings.Split(status, "\n") {
		if strings.HasPrefix(line, "UU ") || strings.HasPrefix(line, "AA ") || strings.HasPrefix(line, "DD ") {
			return "", fmt.Errorf("unresolved conflict: %s", line)
		}
	}
	return finishMerge(ctx, projectPath, runID, goal, fold)
}

// finishMerge stages fold after the squash, where the automatic path's clean-index check is already behind
// it, then commits. A path git refuses to stage, because it is ignored or outside the repository, is logged
// and left out: the docs are not worth failing a merge over.
func finishMerge(ctx context.Context, projectPath, runID, goal string, fold []string) (string, error) {
	for _, path := range fold {
		if _, err := git(ctx, projectPath, "add", "--", path); err != nil {
			log.Printf("merge %s: not committing %s with the squash: %v", runID, path, err)
		}
	}
	msg := fmt.Sprintf("run %s: %s", runID, firstLine(goal))
	if _, err := git(ctx, projectPath, "commit", "-m", msg); err != nil {
		// Idempotent retry: the squash commit already landed but the prior
		// attempt failed on worktree cleanup, so git commit reports
		// "nothing to commit". Treat as already merged.
		if strings.Contains(err.Error(), "nothing to commit") || strings.Contains(err.Error(), "no changes added") || strings.Contains(err.Error(), "nothing added") {
			return git(ctx, projectPath, "rev-parse", "HEAD")
		}
		return "", fmt.Errorf("merge commit: %w", err)
	}
	return git(ctx, projectPath, "rev-parse", "HEAD")
}

func firstLine(s string) string {
	s = strings.TrimSpace(s)
	if idx := strings.Index(s, "\n"); idx >= 0 {
		s = s[:idx]
	}
	s = strings.TrimSpace(s)
	if len(s) > 200 {
		s = s[:200]
	}
	if s == "" {
		return "merge"
	}
	return s
}
```

In `pkg/orchestrate/mergetask.go`, replace:

```go
	sha, err := continueMerge(ctx, owner.ProjectPath, TaskWorktreeKey(owner.ID, task.ID), mergeMsg)
```

with:

```go
	sha, err := continueMerge(ctx, owner.ProjectPath, TaskWorktreeKey(owner.ID, task.ID), mergeMsg, nil)
```

and replace:

```go
	sha, err := mergeWorktree(ctx, owner.ProjectPath, TaskWorktreeKey(owner.ID, taskID), mergeMsg)
```

with:

```go
	sha, err := mergeWorktree(ctx, owner.ProjectPath, TaskWorktreeKey(owner.ID, taskID), mergeMsg, nil)
```

Task 4 replaces both lines with the lane key and the fold.

In `pkg/orchestrate/mergetask_test.go` `stubMerge`, replace:

```go
	mergeWorktree = func(ctx context.Context, projectPath, runID, goal string) (string, error) {
```

with:

```go
	mergeWorktree = func(ctx context.Context, projectPath, runID, goal string, _ []string) (string, error) {
```

In `pkg/orchestrate/continue_test.go`, replace:

```go
	continueMerge = func(context.Context, string, string, string) (string, error) { return "sha-2", nil }
```

with:

```go
	continueMerge = func(context.Context, string, string, string, []string) (string, error) { return "sha-2", nil }
```

- [ ] **Step 5: Add `--spec` to `dag submit`**

In `cmd/wsh/cmd/wshcmd-jarvisdag.go`, add after `dagPlanPath`:

```go
// dagSpecPath resolves --spec to an absolute path. A spec is committed with the plan it produced, so it is
// only accepted beside --plan.
func dagSpecPath(planPath, spec string) (string, error) {
	if spec == "" {
		return "", nil
	}
	if planPath == "" {
		return "", fmt.Errorf("pass --spec with --plan")
	}
	return filepath.Abs(spec)
}
```

In `dagSubmitCmd`'s `RunE`, replace:

```go
		file, _ := cmd.Flags().GetString("file")
		plan, _ := cmd.Flags().GetString("plan")
		planPath, err := dagPlanPath(args, file, plan)
		if err != nil {
			return err
		}
		var data wshrpc.CommandDagSubmitData
		if planPath != "" {
			data.PlanPath = planPath
		} else {
```

with:

```go
		file, _ := cmd.Flags().GetString("file")
		plan, _ := cmd.Flags().GetString("plan")
		spec, _ := cmd.Flags().GetString("spec")
		planPath, err := dagPlanPath(args, file, plan)
		if err != nil {
			return err
		}
		specPath, err := dagSpecPath(planPath, spec)
		if err != nil {
			return err
		}
		var data wshrpc.CommandDagSubmitData
		if planPath != "" {
			data.PlanPath, data.SpecPath = planPath, specPath
		} else {
```

In the flag registrations, replace:

```go
	dagSubmitCmd.Flags().String("plan", "", "submit a plan file in the plan format below; its tasks become the dag")
```

with:

```go
	dagSubmitCmd.Flags().String("plan", "", "submit a plan file in the plan format below; its tasks become the dag")
	dagSubmitCmd.Flags().String("spec", "", "the spec the plan implements; committed with the plan in the run's first merge")
```

- [ ] **Step 6: Regenerate and run the tests**

Run: `task generate`
Expected: `frontend/types/gotypes.d.ts` gains `planpath?: string` and `specpath?: string` on `TaskGroup`, and `specpath?: string` on `CommandDagSubmitData`. Check with `git diff frontend/types/gotypes.d.ts`.

Run: `go test ./pkg/orchestrate -count=1`
Expected: PASS.

Run: `go test ./pkg/wshrpc/wshserver -run 'TestDagSubmitFromPlanPath|TestDagMerge|TestDagSubmit' -count=1`
Expected: PASS.

Run: `go test ./cmd/wsh/cmd -run TestDag -count=1`
Expected: PASS.

---

### Task 4: Merge at the lane tip

**Files:**
- Modify: `pkg/orchestrate/lane.go` (`laneFold`)
- Modify: `pkg/orchestrate/lane_test.go` (one new test)
- Modify: `pkg/orchestrate/mergetask.go` (`MergeTask` and `AutoMergeReady` comments, `ContinueMerge`, `continueBlockedMerge`, `mergeTaskLocked`, `persistMergedTask`, `autoMergeable`, imports)
- Modify: `pkg/orchestrate/cleanup.go` (`CleanupTaskWorktree`)
- Modify: `pkg/orchestrate/mutation.go` (`cancelLocked` sweep)
- Modify: `pkg/orchestrate/queue.go` (`mergeConflictWake`)
- Modify: `pkg/orchestrate/queue_test.go` (`TestMergeConflictWakesLead`)
- Modify: `pkg/orchestrate/cleanup_test.go` (`newCleanupGroup`)
- Modify: `pkg/orchestrate/mergetask_test.go` (`TestScheduleMergesDoneTaskAndUnblocksDependent` fixture)
- Modify: `pkg/orchestrate/verify_test.go` (two fixtures)
- Create: `pkg/orchestrate/laneschedule_test.go`

**Interfaces:**
- Consumes: the Task 1 lane helpers, Task 2's `EnsureRunWorktree`, and Task 3's `fold` parameter and `TaskGroup.PlanPath`/`SpecPath`.
- Produces:
  - `func laneFold(g *waveobj.TaskGroup) []string`: the spec then the plan, while nothing in the dag has merged; nil otherwise.
  - `MergeTask`, `ContinueMerge` and `AutoMergeReady` operate on lanes and record on the tip.

- [ ] **Step 1: Write the failing tests**

Append to the end of `pkg/orchestrate/lane_test.go`:

```go
func TestLaneFoldIsTheSpecAndPlanUntilSomethingMerges(t *testing.T) {
	g := laneGroup(t, true, nil)
	if got := laneFold(g); got != nil {
		t.Fatalf("a dag submitted without docs folds nothing, got %v", got)
	}
	g.PlanPath, g.SpecPath = "/docs/plan.md", "/docs/spec.md"
	if got := laneFold(g); !reflect.DeepEqual(got, []string{"/docs/spec.md", "/docs/plan.md"}) {
		t.Fatalf("fold = %v", got)
	}
	markMerged(g, "t-4")
	if got := laneFold(g); got != nil {
		t.Fatalf("after the first merge nothing is folded, got %v", got)
	}
}
```

Create `pkg/orchestrate/laneschedule_test.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package orchestrate

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// oneLane is t-1, then t-2, which depends on it and on nothing else.
func oneLane() []waveobj.TaskNode {
	return []waveobj.TaskNode{{ID: "t-1", Label: "schema"}, {ID: "t-2", Label: "api", Deps: []string{"t-1"}}}
}

type mergeCall struct {
	runID, goal string
	fold        []string
}

// recordMerges stubs the squash merge with a fixed outcome and records every call.
func recordMerges(t *testing.T, sha string, err error) *[]mergeCall {
	t.Helper()
	var calls []mergeCall
	old := mergeWorktree
	mergeWorktree = func(_ context.Context, _, runID, goal string, fold []string) (string, error) {
		calls = append(calls, mergeCall{runID, goal, fold})
		return sha, err
	}
	t.Cleanup(func() { mergeWorktree = old })
	return &calls
}

// commitInTree commits one new file in a task's tree, as its worker would, and returns the commit.
func commitInTree(t *testing.T, wt, name string) string {
	t.Helper()
	if err := os.WriteFile(filepath.Join(wt, name), []byte(name+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitCmd(t, wt, "add", name)
	gitCmd(t, wt, "commit", "-m", name)
	return gitCmd(t, wt, "rev-parse", "HEAD")
}

// taskRun loads the child run the task currently points at.
func (f *mergeFixture) taskRun(t *testing.T, taskID string) *waveobj.Run {
	t.Helper()
	run, err := wstore.GetRun(f.ctx, f.channel, taskByID(f.dag(t), taskID).RunID)
	if err != nil {
		t.Fatal(err)
	}
	return run
}

func TestLaneTasksStackInOneWorktreeAndMergeOnce(t *testing.T) {
	f := newMergeFixture(t, oneLane())
	merges := recordMerges(t, "sha-lane", nil)
	var spawned []string
	stubSpawn(t, &spawned)

	if err := Schedule(f.ctx, f.dagID); err != nil {
		t.Fatal(err)
	}
	wt := worktreeDir(f.project, TaskWorktreeKey(f.ownerID, "t-1"))
	if got := f.taskRun(t, "t-1").ProjectPath; got != wt {
		t.Fatalf("t-1 works in the lane's tree, got %s", got)
	}
	schema := commitInTree(t, wt, "schema.txt")
	f.finish(t, "t-1")

	if err := Schedule(f.ctx, f.dagID); err != nil {
		t.Fatal(err)
	}
	if len(*merges) != 0 {
		t.Fatalf("a lane does not merge before its last task is done, got %+v", *merges)
	}
	second := f.taskRun(t, "t-2")
	if second.ProjectPath != wt || second.BaseCommit != schema {
		t.Fatalf("t-2 starts in the same tree at t-1's commit, got %s at %s", second.ProjectPath, second.BaseCommit)
	}
	f.finish(t, "t-2")

	if err := Schedule(f.ctx, f.dagID); err != nil {
		t.Fatal(err)
	}
	want := []mergeCall{{runID: TaskWorktreeKey(f.ownerID, "t-1"), goal: "schema; api"}}
	if !reflect.DeepEqual(*merges, want) {
		t.Fatalf("one squash merge of the lane's branch, got %+v", *merges)
	}
	g := f.dag(t)
	if !g.Tasks[0].Merged || !g.Tasks[1].Merged || g.Status != DagStatus_Done {
		t.Fatalf("the merge lands both tasks, got merged %v/%v, dag %s", g.Tasks[0].Merged, g.Tasks[1].Merged, g.Status)
	}
	if got := f.taskRun(t, "t-2").EndCommit; got != "sha-lane" {
		t.Fatalf("the squash is recorded on the lane's last task, got %q", got)
	}
}

func TestManualMergeRefusesALaneThatIsNotFinished(t *testing.T) {
	f := newMergeFixture(t, oneLane())
	f.finish(t, "t-1")
	merges := recordMerges(t, "sha-lane", nil)

	err := MergeTask(f.ctx, f.channel, f.ownerID, "t-1")
	if err == nil || !strings.Contains(err.Error(), "lane t-1, t-2") {
		t.Fatalf("merging part of a lane must be refused and name the lane, got %v", err)
	}
	if len(*merges) != 0 {
		t.Fatalf("nothing merges, got %+v", *merges)
	}
}

func TestLaneConflictBlocksItsLastTaskAndContinueLandsTheLane(t *testing.T) {
	lead := newFakeLead(t)
	f := newMergeFixture(t, oneLane())
	f.finish(t, "t-1")
	f.finish(t, "t-2")
	recordMerges(t, "", ErrMergeConflict)

	if err := Schedule(f.ctx, f.dagID); err != nil {
		t.Fatal(err)
	}
	g := f.dag(t)
	if g.Tasks[1].State != TaskState_BlockedMerge || g.Tasks[0].State != TaskState_Done || g.Tasks[0].Merged {
		t.Fatalf("the conflict belongs to the lane's last task, got %s / %s merged=%v", g.Tasks[0].State, g.Tasks[1].State, g.Tasks[0].Merged)
	}
	want := "wake: merge conflict landing lane ending at task t-2. git status"
	if len(lead.sends) != 1 || lead.sends[0] != want {
		t.Fatalf("want %q, got %q", want, lead.sends)
	}

	var continued []string
	orig := continueMerge
	continueMerge = func(_ context.Context, _, runID, _ string, _ []string) (string, error) {
		continued = append(continued, runID)
		return "sha-resolved", nil
	}
	t.Cleanup(func() { continueMerge = orig })
	if err := ContinueMerge(f.ctx, f.channel, f.ownerID, "t-2"); err != nil {
		t.Fatal(err)
	}
	g = f.dag(t)
	if !reflect.DeepEqual(continued, []string{TaskWorktreeKey(f.ownerID, "t-1")}) || !g.Tasks[0].Merged || !g.Tasks[1].Merged {
		t.Fatalf("continue lands the lane's branch and both tasks, got %v merged %v/%v", continued, g.Tasks[0].Merged, g.Tasks[1].Merged)
	}
}

func TestSetupFailureInALaneKeepsItsCommitsForTheRetry(t *testing.T) {
	newFakeLead(t)
	f := newMergeFixture(t, oneLane())
	f.setPlanCommands(t, "", setupCmd)
	var failSetup atomic.Bool
	stubPlanCommand(t, func(context.Context, string, string) error {
		if failSetup.Load() {
			return &planCommandError{exitCode: 1, output: "task: not found"}
		}
		return nil
	})
	var spawned []string
	stubSpawn(t, &spawned)

	if err := Schedule(f.ctx, f.dagID); err != nil {
		t.Fatal(err)
	}
	key := TaskWorktreeKey(f.ownerID, "t-1")
	wt := worktreeDir(f.project, key)
	schema := commitInTree(t, wt, "schema.txt")
	// a file the worker left uncommitted makes t-2's dispatch rebuild the tree, so Setup runs again
	if err := os.WriteFile(filepath.Join(wt, "leftover.txt"), []byte("wip\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	f.finish(t, "t-1")
	failSetup.Store(true)

	if err := Schedule(f.ctx, f.dagID); err != nil {
		t.Fatal(err)
	}
	if task := f.dag(t).Tasks[1]; task.State != TaskState_Failed || task.LastFailureKind != FailureKindSetup {
		t.Fatalf("want t-2 failed (setup), got %s (%s)", task.State, task.LastFailureKind)
	}
	if _, err := os.Stat(wt); !os.IsNotExist(err) {
		t.Fatalf("the half-prepared tree goes, stat err = %v", err)
	}
	if got := gitCmd(t, f.project, "rev-parse", "wave/"+key); got != schema {
		t.Fatalf("the lane's branch keeps t-1's commit, got %s", got)
	}

	failSetup.Store(false)
	if err := ApplyAction(f.ctx, f.dagID, "t-2", "retry", waveobj.RoutePin{}); err != nil {
		t.Fatal(err)
	}
	if got := f.taskRun(t, "t-2").BaseCommit; got != schema {
		t.Fatalf("the retry starts at t-1's commit, got %s", got)
	}
	if _, err := os.Stat(filepath.Join(wt, "schema.txt")); err != nil {
		t.Fatalf("the retried tree holds t-1's work: %v", err)
	}
}

func TestOnlyTheFirstMergeCarriesTheSpecAndPlan(t *testing.T) {
	f := newMergeFixture(t, []waveobj.TaskNode{{ID: "t-1", Label: "schema"}, {ID: "t-2", Label: "docs"}})
	spec, plan := filepath.Join(f.project, "spec.md"), filepath.Join(f.project, "plan.md")
	if err := wstore.UpdateDag(f.ctx, f.dagID, func(cur *waveobj.TaskGroup) error {
		cur.PlanPath, cur.SpecPath = plan, spec
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	f.finish(t, "t-1")
	f.finish(t, "t-2")
	merges := recordMerges(t, "sha-1", nil)

	if err := Schedule(f.ctx, f.dagID); err != nil {
		t.Fatal(err)
	}
	if len(*merges) != 2 {
		t.Fatalf("want both lanes merged, got %+v", *merges)
	}
	if got := (*merges)[0].fold; !reflect.DeepEqual(got, []string{spec, plan}) {
		t.Fatalf("the first merge stages the spec and plan, got %v", got)
	}
	if got := (*merges)[1].fold; got != nil {
		t.Fatalf("a later merge stages nothing extra, got %v", got)
	}
}
```

Update the fixtures whose chain now forms one lane. In `pkg/orchestrate/mergetask_test.go` `TestScheduleMergesDoneTaskAndUnblocksDependent`, replace:

```go
		{ID: "t-1", Label: "second", Deps: []string{"t-0"}},
	})
	child := f.finish(t, "t-0")
```

with:

```go
		{ID: "t-1", Label: "second", Deps: []string{"t-0"}},
		// a second dependent makes t-0 a lane of its own, so it lands before either starts
		{ID: "t-2", Label: "third", Deps: []string{"t-0"}},
	})
	child := f.finish(t, "t-0")
```

In `pkg/orchestrate/verify_test.go`, replace both occurrences (Edit with `replace_all`) of:

```go
		{ID: "t-1", Label: "second", Deps: []string{"t-0"}},
	})
```

with:

```go
		{ID: "t-1", Label: "second", Deps: []string{"t-0"}},
		// a second dependent makes t-0 a lane of its own, so it merges and verifies before either starts
		{ID: "t-2", Label: "third", Deps: []string{"t-0"}},
	})
```

In `pkg/orchestrate/cleanup_test.go` `newCleanupGroup`, replace:

```go
		{ID: "t-0", Label: "zero"},
		{ID: "t-1", Label: "one", Deps: []string{"t-0"}},
		{ID: "t-2", Label: "two", Deps: []string{"t-1"}},
		{ID: "t-3", Label: "three", Deps: []string{"t-2"}},
		{ID: "t-4", Label: "four", Deps: []string{"t-3"}},
```

with:

```go
		// independent tasks: each is a lane of its own, so each cleanup keys its own tree
		{ID: "t-0", Label: "zero"},
		{ID: "t-1", Label: "one"},
		{ID: "t-2", Label: "two"},
		{ID: "t-3", Label: "three"},
		{ID: "t-4", Label: "four"},
```

In `pkg/orchestrate/queue_test.go` `TestMergeConflictWakesLead`, replace:

```go
	want := "wake: merge conflict landing task t-0. git status"
```

with:

```go
	want := "wake: merge conflict landing lane ending at task t-0. git status"
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go test ./pkg/orchestrate -run 'TestLaneFold|TestLaneTasksStack|TestManualMergeRefusesALane|TestLaneConflict|TestSetupFailureInALane|TestOnlyTheFirstMerge|TestMergeConflictWakesLead|TestScheduleMergesDoneTask|TestVerifyPassAfterMerge|TestVerifyFailureBlocks|TestRetryPendingCleanup' -count=1`
Expected: build failure (`laneFold` undefined). Once Step 3 adds `laneFold` alone, the lane tests and `TestMergeConflictWakesLead` fail on their assertions.

- [ ] **Step 3: Land lanes at their tip**

Append to the end of `pkg/orchestrate/lane.go`:

```go
// laneFold lists the spec and plan to stage into the dag's first squash commit, so the docs land with the
// work they describe. Nil once anything has merged, and for a dag submitted without them.
func laneFold(g *waveobj.TaskGroup) []string {
	for i := range g.Tasks {
		if g.Tasks[i].Merged {
			return nil
		}
	}
	var paths []string
	for _, p := range []string{g.SpecPath, g.PlanPath} {
		if p != "" {
			paths = append(paths, p)
		}
	}
	return paths
}
```

In `pkg/orchestrate/mergetask.go`, add `"strings"` to the import block:

```go
import (
	"context"
	"errors"
	"fmt"
	"log"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wcore"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)
```

Replace the first two lines of `MergeTask`'s doc comment:

```go
// MergeTask lands one done task's worktree on the project branch, stamps the merge and removes the
// tree. It holds the dag mutation lock across reload -> merge -> stamp -> cleanup for two reasons:
```

with:

```go
// MergeTask lands the finished lane holding a task on the project branch, stamps the merge and removes the
// lane's tree. It holds the dag mutation lock across reload -> merge -> stamp -> cleanup for two reasons:
```

In `ContinueMerge`, replace:

```go
		return continueBlockedMerge(ctx, channelID, owner, task)
```

with:

```go
		return continueBlockedMerge(ctx, channelID, owner, g, task)
```

Replace the whole `continueBlockedMerge` function (its doc comment through its closing brace) with:

```go
// continueBlockedMerge commits the resolved project state of a conflicted squash merge, stamps it like
// any merge, and hands the checkout to Verify when the plan has one. The blocked task is its lane's tip.
func continueBlockedMerge(ctx context.Context, channelID string, owner *waveobj.Run, g *waveobj.TaskGroup, task *waveobj.TaskNode) error {
	if task.RunID == "" {
		return fmt.Errorf("task %s has no child run", task.ID)
	}
	l, err := claimProject(owner.ProjectPath, owner.DagORef, task.ID)
	if err != nil {
		return err
	}
	appendRunEvent(ctx, channelID, owner.ID, waveobj.RunEventKindTaskMergeContinued, nil, map[string]any{"taskid": task.ID})
	sha, err := continueMerge(ctx, owner.ProjectPath, LaneWorktreeKey(g, task.ID), laneMergeMessage(g, laneOf(g, task.ID)), laneFold(g))
	if err != nil {
		releaseProject(owner.ProjectPath, l)
		return err
	}
	var verify string
	// the stamp is a dag write, and the engine reverts any dag write made outside this lock
	err = withDagMutation(owner.DagORef, func() error {
		var ferr error
		verify, ferr = FinishMergedTask(ctx, channelID, owner.DagORef, task.RunID, task.ID, sha)
		return ferr
	})
	landAfterMerge(channelID, owner, task.ID, verify, l)
	return err
}
```

Replace the whole `mergeTaskLocked` function (its doc comment through its closing brace) with:

```go
// mergeTaskLocked lands the lane holding taskID and returns the plan's Verify command when the landed merge
// now waits on it. A lane lands as one squash commit recorded on its tip, whichever of its tasks was named,
// and only once every task in it is done or skipped.
func mergeTaskLocked(ctx context.Context, channelID string, owner *waveobj.Run, taskID string, requireCleanIndex bool) (string, error) {
	g, err := wstore.GetDag(ctx, owner.DagORef)
	if err != nil {
		return "", err
	}
	if taskByID(g, taskID) == nil {
		return "", fmt.Errorf("no task %q", taskID)
	}
	lane := laneOf(g, taskID)
	task := laneTip(g, lane)
	if task == nil {
		return "", fmt.Errorf("task %s: every task in lane %s was skipped, so there is nothing to merge", taskID, strings.Join(lane, ", "))
	}
	if task.Merged {
		if !task.CleanupPending && task.CleanupError == "" {
			return "", nil
		}
		return "", CleanupMergedTask(ctx, channelID, g, task.ID)
	}
	for _, id := range lane {
		t := taskByID(g, id)
		if t.State == TaskState_Done || t.State == TaskState_Skipped || (t.ID == task.ID && t.State == TaskState_BlockedMerge) {
			continue
		}
		return "", fmt.Errorf("task %s is %s, want done: lane %s lands as one merge once all of it is done", t.ID, t.State, strings.Join(lane, ", "))
	}
	if task.RunID == "" {
		return "", fmt.Errorf("task %s has no child run", task.ID)
	}
	if requireCleanIndex {
		// AutoMergeReady checks this from a read taken before the claim, which misses a Verify that failed
		// and released in between
		for _, state := range []string{TaskState_Verifying, TaskState_VerifyFailed} {
			if held := tasksInState(g, state); len(held) > 0 {
				return "", fmt.Errorf("%w: task %s is %s", errProjectBusy, held[0], state)
			}
		}
		clean, cerr := IndexClean(ctx, owner.ProjectPath)
		if cerr != nil {
			return "", cerr
		}
		if !clean {
			return "", errIndexNotClean
		}
	}
	childRunID := task.RunID
	// merge-started closes the digest's merge-wait window (task-done -> here): the interval a
	// finished task spent waiting to be landed. Emitted only once the attempt is going ahead, so a
	// refused automatic attempt never opens a window it did not start.
	appendRunEvent(ctx, channelID, owner.ID, waveobj.RunEventKindTaskMergeStarted, nil, map[string]any{"taskid": task.ID})
	sha, err := mergeWorktree(ctx, owner.ProjectPath, LaneWorktreeKey(g, task.ID), laneMergeMessage(g, lane), laneFold(g))
	if err != nil {
		if errors.Is(err, ErrMergeConflict) {
			appendRunEvent(ctx, channelID, owner.ID, waveobj.RunEventKindTaskMergeBlocked, nil, map[string]any{"taskid": task.ID})
			if derr := markBlockedMergeLocked(ctx, owner.DagORef, childRunID); derr != nil {
				return "", derr
			}
		}
		return "", err
	}
	return FinishMergedTask(ctx, channelID, owner.DagORef, childRunID, task.ID, sha)
}
```

In `persistMergedTask`, replace:

```go
			task := taskByID(cur, taskID)
			if task == nil {
				return fmt.Errorf("no task %q", taskID)
			}
			task.Merged = true
```

with:

```go
			task := taskByID(cur, taskID)
			if task == nil {
				return fmt.Errorf("no task %q", taskID)
			}
			// the squash landed every finished task in the lane; the commit, cleanup and Verify are the tip's
			for _, id := range laneOf(cur, taskID) {
				if t := taskByID(cur, id); t.State == TaskState_Done {
					t.Merged = true
				}
			}
			task.Merged = true
```

Replace the first two lines of `AutoMergeReady`'s doc comment:

```go
// AutoMergeReady lands every task whose work is finished and whose gate, if it has one, a human
// already released. Under MergeRequired the merge is what unblocks a dependent, so leaving it to the
```

with:

```go
// AutoMergeReady lands every lane whose work is finished and whose gates a human already released.
// Under MergeRequired the merge is what unblocks a dependent in another lane, so leaving it to the
```

Replace the whole `autoMergeable` function (its doc comment through its closing brace) with:

```go
// autoMergeable lists the lanes that can be landed without asking anyone, by their tip: every task
// finished or skipped, nothing merged yet, every gate released. blocked-merge is excluded — a conflicted
// tree is the human's.
func autoMergeable(g *waveobj.TaskGroup) []string {
	var out []string
	for _, lane := range jarvis.Lanes(g.Tasks) {
		if tip := laneMergeReady(g, lane); tip != nil {
			out = append(out, tip.ID)
		}
	}
	return out
}
```

In `pkg/orchestrate/cleanup.go` `CleanupTaskWorktree`, replace:

```go
	err = RemoveTaskWorktree(ctx, projectPath, TaskWorktreeKey(g.RunID, taskID))
```

with:

```go
	err = RemoveTaskWorktree(ctx, projectPath, LaneWorktreeKey(g, taskID))
```

In `pkg/orchestrate/mutation.go` `cancelLocked`, replace:

```go
			taskID := gCopy.Tasks[i].ID
			key := TaskWorktreeKey(gCopy.RunID, taskID)
```

with:

```go
			taskID := gCopy.Tasks[i].ID
			// a lane's tasks share one key: the first removes the tree, the rest find nothing left to do
			key := LaneWorktreeKey(gCopy, taskID)
```

In `pkg/orchestrate/queue.go` `mergeConflictWake`, replace:

```go
	return fmt.Sprintf("wake: merge conflict landing task %s. git status", taskID)
```

with:

```go
	return fmt.Sprintf("wake: merge conflict landing lane ending at task %s. git status", taskID)
```

- [ ] **Step 4: Run the tests**

Run: `go test ./pkg/orchestrate -count=1`
Expected: PASS.

Run: `go test ./pkg/wshrpc/wshserver -run TestDag -count=1`
Expected: PASS.

---

### Task 5: Digest and graph: a lane's tip is what merges

**Files:**
- Modify: `pkg/orchestrate/digest.go` (`buildCounts`, `mergeReadyBlocking`, `mergeReadyIDs`, `taskHumanActions`, `taskMergeState`, `buildReport`)
- Modify: `pkg/orchestrate/digest_test.go` (`TestNextMergeReady` fixture)
- Create: `pkg/orchestrate/digestlane_test.go`
- Modify: `frontend/app/view/orchestrate/dagstore.ts` (`buildViewData`, new `mergeReadyIds`)
- Modify: `frontend/app/view/orchestrate/dagstore.test.ts` (whole file)
- Modify: `frontend/app/view/orchestrate/daggraph.tsx` (`DagGraphInner`, imports)

**Interfaces:**
- Consumes: `mergeReadyTip`, `laneTip`, `laneOf` (Task 1).
- Produces:
  - A digest task row reads `mergestate: "ready"` and offers `resolve-merge` only on a merge-ready lane's tip. `counts.mergeready` counts lanes, and `report.commits` lists one commit per landed lane.
  - `export function mergeReadyIds(digest: DagStatusDigest | undefined, stale: boolean): Set<string>`
  - `export function buildViewData(group: TaskGroup, owner: Run, harnesses: HarnessInfo[], mergeReady: ReadonlySet<string>)`

- [ ] **Step 1: Write the failing tests**

Create `pkg/orchestrate/digestlane_test.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package orchestrate

import (
	"reflect"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

// chainTasks (digest_test.go) is one lane: t-0 -> t-1 -> t-2.

func TestDigestFinishedLaneIsMergedAtItsTip(t *testing.T) {
	g := digestGroup(t, true, chainTasks())
	setTaskStates(g, map[string]string{"t-0": TaskState_Done, "t-1": TaskState_Done, "t-2": TaskState_Done})
	d := BuildDigest(digestSnapshot(g, nil, nil, nil, digestNow))
	if d.Next.Kind != "merge-ready" || !reflect.DeepEqual(d.Next.TaskIds, []string{"t-2"}) {
		t.Fatalf("a finished lane is one merge, named by its last task, got %+v", d.Next)
	}
	if d.Counts.MergeReady != 1 {
		t.Fatalf("one lane is one merge, got %d", d.Counts.MergeReady)
	}
	for i, want := range []string{"waiting", "waiting", "ready"} {
		if d.Tasks[i].MergeState != want {
			t.Fatalf("task %s merge state = %q, want %q", g.Tasks[i].ID, d.Tasks[i].MergeState, want)
		}
	}
	if d.Tasks[0].HumanActions != nil || !reflect.DeepEqual(d.Tasks[2].HumanActions, []string{"resolve-merge"}) {
		t.Fatalf("only the tip offers the merge, got %v / %v", d.Tasks[0].HumanActions, d.Tasks[2].HumanActions)
	}
}

func TestDigestDoneTaskMidLaneDoesNotHoldItsSuccessor(t *testing.T) {
	g := digestGroup(t, true, chainTasks())
	setTaskStates(g, map[string]string{"t-0": TaskState_Done})
	d := BuildDigest(digestSnapshot(g, nil, nil, nil, digestNow))
	if d.Next.Kind != "dispatch" || !reflect.DeepEqual(d.Next.TaskIds, []string{"t-1"}) {
		t.Fatalf("the next task in the lane starts without a merge, got %+v", d.Next)
	}
	if d.Counts.MergeReady != 0 {
		t.Fatalf("a lane still running has nothing to merge, got %d", d.Counts.MergeReady)
	}
}

func TestDigestReportListsOneCommitPerLane(t *testing.T) {
	g := digestGroup(t, true, chainTasks())
	setTaskStates(g, map[string]string{"t-0": TaskState_Done, "t-1": TaskState_Done, "t-2": TaskState_Done})
	for i := range g.Tasks {
		g.Tasks[i].Merged = true
	}
	runs := []*waveobj.Run{
		childRun("run-t-0", []waveobj.RunPhase{phase("quick", 1000, 2000)}),
		childRun("run-t-1", []waveobj.RunPhase{phase("quick", 2000, 3000)}),
		childRun("run-t-2", []waveobj.RunPhase{phase("quick", 3000, 4000)}),
	}
	runs[0].EndCommit, runs[1].EndCommit, runs[2].EndCommit = "reported-0", "reported-1", "sha-lane"
	r := BuildDigest(digestSnapshot(g, runs, nil, nil, digestNow)).Report
	if want := []wshrpc.DagLandedCommit{{TaskId: "t-2", Commit: "sha-lane"}}; !reflect.DeepEqual(r.Commits, want) {
		t.Fatalf("a lane lands one commit, got %+v", r.Commits)
	}
}
```

In `pkg/orchestrate/digest_test.go` `TestNextMergeReady`, replace:

```go
	g := digestGroup(t, true, chainTasks())
	// t-0 done, unmerged, merge-required -> blocks t-1 (depSatisfied needs Merged)
	setTaskStates(g, map[string]string{"t-0": TaskState_Done})
```

with:

```go
	// t-0 has two dependents, so it is a lane of its own: done and unmerged, it blocks both
	g := digestGroup(t, true, []waveobj.TaskNode{
		{ID: "t-0", Label: "a"},
		{ID: "t-1", Label: "b", Deps: []string{"t-0"}},
		{ID: "t-2", Label: "c", Deps: []string{"t-0"}},
	})
	setTaskStates(g, map[string]string{"t-0": TaskState_Done})
```

Replace the whole of `frontend/app/view/orchestrate/dagstore.test.ts` with:

```ts
import { describe, expect, it } from "vitest";
import { buildViewData, mergeReadyIds } from "./dagstore";

const group = {
    id: "dag-1",
    runid: "run-1",
    parallelism: 2,
    tasks: [
        { id: "t-0", label: "setup", state: "done" },
        { id: "t-1", label: "api", deps: ["t-0"], state: "running", runid: "r-1" },
        { id: "t-2", label: "ship", deps: ["t-1"], gate: true, state: "done" },
        { id: "t-3", label: "perf", deps: ["t-2"], state: "failed" },
    ],
} as any;

const owner = { runtime: "claude", model: "sonnet" } as Run;
const harnesses = [
    { runtime: "claude", routecapabilities: [{ runtime: "claude", model: "sonnet", resolvedmodel: "claude-sonnet-4-6" }, { runtime: "claude", resolvedmodel: "operator default" }] },
    { runtime: "pi", routecapabilities: [{ runtime: "pi", resolvedmodel: "operator default" }] },
] as HarnessInfo[];
const none = new Set<string>();

describe("buildViewData", () => {
    it("maps tasks to nodes and deps to edges", () => {
        const { nodes, edges } = buildViewData(group, owner, harnesses, new Set(["t-0"]));
        expect(nodes).toHaveLength(4);
        expect(edges).toEqual([
            { source: "t-0", target: "t-1" },
            { source: "t-1", target: "t-2" },
            { source: "t-2", target: "t-3" },
        ]);
        // the digest says t-0 can merge -> merge action
        expect(nodes[0].actions).toEqual(["merge"]);
    });
    it("drops the merge action once a task is merged", () => {
        const mergedGroup = {
            ...group,
            tasks: [{ id: "t-0", label: "setup", state: "done", merged: true }],
        } as any;
        const { nodes } = buildViewData(mergedGroup, owner, harnesses, none);
        expect(nodes[0].actions).toEqual([]);
    });

    it("offers merge only where the digest says a lane is ready", () => {
        const lane = {
            ...group,
            tasks: [
                { id: "t-0", label: "schema", state: "done", runid: "r-0" },
                { id: "t-1", label: "api", deps: ["t-0"], state: "done", runid: "r-1" },
            ],
        } as any;
        const { nodes } = buildViewData(lane, owner, harnesses, new Set(["t-1"]));
        expect(nodes[0].actions).toEqual([]);
        expect(nodes[1].actions).toEqual(["merge"]);
    });

    it("flags gate and failure states", () => {
        const { nodes } = buildViewData(group, owner, harnesses, none);
        const ship = nodes.find((n) => n.id === "t-2")!;
        expect(ship.gate).toBe(true);
        expect(ship.actions).toEqual(["approve", "sendback"]);
        const perf = nodes.find((n) => n.id === "t-3")!;
        expect(perf.actions).toEqual(["retry", "skip", "escalate"]);
    });

    it("offers resolve on a failed Verify, which re-runs it through merge --continue", () => {
        const failed = {
            ...group,
            tasks: [{ id: "t-0", label: "setup", state: "verify-failed", merged: true }],
        } as any;
        expect(buildViewData(failed, owner, harnesses, none).nodes[0].actions).toEqual(["resolve"]);
    });

    it("projects pinned, inherited, runtime-default, and unavailable routes", () => {
        const routed = {
            ...group,
            tasks: [
                { id: "pinned", label: "Pinned", state: "running", runspec: { runtime: "claude", model: "sonnet" } },
                { id: "inherited", label: "Inherited", state: "running" },
                { id: "runtimeonly", label: "RuntimeOnly", state: "running", runspec: { runtime: "pi" } },
                { id: "missing", label: "Missing", state: "running", runspec: { runtime: "missing" } },
                { id: "modelonly", label: "ModelOnly", state: "running", runspec: { model: "sonnet" } },
            ],
        } as any;
        const { nodes } = buildViewData(routed, owner, harnesses, none);
        expect(nodes.find((n) => n.id === "pinned")!.route).toEqual({ source: "pinned", runtime: "claude", model: "sonnet", resolvedModel: "claude-sonnet-4-6" });
        expect(nodes.find((n) => n.id === "inherited")!.route).toEqual({ source: "inherited", runtime: "claude", model: "sonnet", resolvedModel: "claude-sonnet-4-6" });
        // a runtime-only pin is that runtime's default, never the owner's model
        expect(nodes.find((n) => n.id === "runtimeonly")!.route).toEqual({ source: "pinned", runtime: "pi", model: "", resolvedModel: "operator default" });
        expect(nodes.find((n) => n.id === "missing")!.route).toEqual({ source: "pinned", runtime: "missing", model: "", resolvedModel: "unavailable" });
        // a model-only pin inherits the owner's runtime
        expect(nodes.find((n) => n.id === "modelonly")!.route).toEqual({ source: "pinned", runtime: "claude", model: "sonnet", resolvedModel: "claude-sonnet-4-6" });
    });
});

describe("mergeReadyIds", () => {
    const digest = {
        tasks: [
            { taskid: "t-0", waitreason: "terminal", mergestate: "waiting", cleanupstate: "clear" },
            { taskid: "t-1", waitreason: "terminal", mergestate: "ready", cleanupstate: "clear" },
        ],
    } as DagStatusDigest;

    it("reads the rows the digest marks ready", () => {
        expect([...mergeReadyIds(digest, false)]).toEqual(["t-1"]);
    });

    it("offers nothing from a stale or missing digest", () => {
        expect(mergeReadyIds(digest, true).size).toBe(0);
        expect(mergeReadyIds(undefined, false).size).toBe(0);
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go test ./pkg/orchestrate -run 'TestDigestFinishedLane|TestDigestDoneTaskMidLane|TestDigestReportListsOneCommit|TestNextMergeReady' -count=1`
Expected: FAIL.
- `TestDigestFinishedLaneIsMergedAtItsTip` names three merge-ready tasks.
- `TestDigestDoneTaskMidLaneDoesNotHoldItsSuccessor` reads `merge-ready` where `dispatch` is expected.
- `TestDigestReportListsOneCommitPerLane` lists three commits.
- `TestNextMergeReady` passes both before and after: its new fixture is a fork.

Run: `npx vitest run frontend/app/view/orchestrate/dagstore.test.ts`
Expected: FAIL (`mergeReadyIds` is not exported).

- [ ] **Step 3: Make the digest lane-aware**

In `pkg/orchestrate/digest.go` `buildCounts`, replace:

```go
			if g.MergeRequired && !t.Merged && (!t.Gate || t.Released) {
				c.MergeReady++
			}
```

with:

```go
			if mergeReadyTip(g, t) {
				c.MergeReady++
			}
```

In `mergeReadyBlocking`, replace:

```go
	mergeReady := map[string]bool{}
	for i := range g.Tasks {
		t := &g.Tasks[i]
		if t.State == TaskState_Done && !t.Merged && (!t.Gate || t.Released) {
			mergeReady[t.ID] = true
		}
	}
```

with:

```go
	mergeReady := map[string]bool{}
	for _, id := range mergeReadyIDs(g) {
		mergeReady[id] = true
	}
```

In `mergeReadyIDs`, replace:

```go
		t := &g.Tasks[i]
		if g.MergeRequired && t.State == TaskState_Done && !t.Merged && (!t.Gate || t.Released) {
			ids = append(ids, t.ID)
		}
```

with:

```go
		if mergeReadyTip(g, &g.Tasks[i]) {
			ids = append(ids, g.Tasks[i].ID)
		}
```

In `taskHumanActions`, replace:

```go
	case t.State == TaskState_Done && g.MergeRequired && !t.Merged && (!t.Gate || t.Released):
```

with:

```go
	case mergeReadyTip(g, t):
```

In `taskMergeState`, replace:

```go
	if t.State == TaskState_Done && (!t.Gate || t.Released) {
		return "ready"
	}
```

with:

```go
	// a lane merges as one, so only its tip reads ready
	if mergeReadyTip(g, t) {
		return "ready"
	}
```

In `buildReport`, replace:

```go
		if c := endCommit[t.RunID]; t.Merged && c != "" {
```

with:

```go
		// a lane lands one squash commit, recorded on its tip; earlier tasks keep the commits they reported
		if c := endCommit[t.RunID]; t.Merged && c != "" && laneTip(g, laneOf(g, t.ID)).ID == t.ID {
```

- [ ] **Step 4: Take the graph's merge action from the digest**

In `frontend/app/view/orchestrate/dagstore.ts`, replace:

```ts
// buildViewData maps the persisted group onto graph nodes/edges plus the action set each
// node offers. Pure: the view renders exactly this.
export function buildViewData(group: TaskGroup, owner: Run, harnesses: HarnessInfo[]): { nodes: DagViewNode[]; edges: DagViewEdge[] } {
    const ownerPin = normalizeRunPin(owner);
    const nodes: DagViewNode[] = group.tasks.map((t) => {
        let actions = ACTION_BY_STATE[t.state] ?? [];
        if (t.gate && t.state === "done") actions = GATE_DONE_ACTIONS;
        if (t.state === "done" && !t.gate && !t.merged) actions = ["merge"];
```

with:

```ts
// mergeReadyIds is the set of tasks a merge can be started from now, read from the digest: a lane merges as
// one, at its tip, and only the engine derives lanes. Empty while the digest is missing or stale, because the
// engine lands merges on its own and a missing button costs nothing.
export function mergeReadyIds(digest: DagStatusDigest | undefined, stale: boolean): Set<string> {
    if (digest == null || stale) return new Set();
    return new Set((digest.tasks ?? []).filter((row) => row.mergestate === "ready").map((row) => row.taskid));
}

// buildViewData maps the persisted group onto graph nodes/edges plus the action set each
// node offers. Pure: the view renders exactly this. mergeReady comes from mergeReadyIds.
export function buildViewData(
    group: TaskGroup,
    owner: Run,
    harnesses: HarnessInfo[],
    mergeReady: ReadonlySet<string>
): { nodes: DagViewNode[]; edges: DagViewEdge[] } {
    const ownerPin = normalizeRunPin(owner);
    const nodes: DagViewNode[] = group.tasks.map((t) => {
        let actions = ACTION_BY_STATE[t.state] ?? [];
        if (t.gate && t.state === "done") actions = GATE_DONE_ACTIONS;
        if (mergeReady.has(t.id)) actions = ["merge"];
```

In `frontend/app/view/orchestrate/daggraph.tsx`, replace:

```tsx
import { buildViewData, selectedTaskIdAtom, useDagGroup, type DagViewNode } from "./dagstore";
```

with:

```tsx
import { useDagDigest } from "./dagdigest";
import { buildViewData, mergeReadyIds, selectedTaskIdAtom, useDagGroup, type DagViewNode } from "./dagstore";
```

In `DagGraphInner`, replace:

```tsx
    const [group, loading] = useDagGroup(oref);
    const selectedId = useAtomValue(selectedTaskIdAtom);
    const { fitView, zoomIn, zoomOut } = useReactFlow();

    const { nodes, edges, byId } = useMemo(() => {
        if (loading || !group)
            return { nodes: [] as Node[], edges: [] as Edge[], byId: new Map<string, DagViewNode>() };
        const { nodes: vnodes, edges: vedges } = buildViewData(group, owner, harnesses);
```

with:

```tsx
    const [group, loading] = useDagGroup(oref);
    const selectedId = useAtomValue(selectedTaskIdAtom);
    const { fitView, zoomIn, zoomOut } = useReactFlow();
    // owner is the dag's own run (LiveDagModal loads run:<runId>), so its ids address the digest
    const digestState = useDagDigest(owner.channeloid ?? "", owner.id, oref);
    const mergeReady = useMemo(
        () => mergeReadyIds(digestState.digest, digestState.stale),
        [digestState.digest, digestState.stale]
    );

    const { nodes, edges, byId } = useMemo(() => {
        if (loading || !group)
            return { nodes: [] as Node[], edges: [] as Edge[], byId: new Map<string, DagViewNode>() };
        const { nodes: vnodes, edges: vedges } = buildViewData(group, owner, harnesses, mergeReady);
```

and replace that `useMemo`'s dependency list:

```tsx
    }, [group, harnesses, loading, owner, selectedId]);
```

with:

```tsx
    }, [group, harnesses, loading, mergeReady, owner, selectedId]);
```

- [ ] **Step 5: Run the tests and the typecheck**

Run: `go test ./pkg/orchestrate -count=1`
Expected: PASS.

Run: `npx vitest run frontend/app/view/orchestrate`
Expected: PASS.

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

---

### Task 6: Docs, full verification, commit

**Files:**
- Modify: `docs/superpowers/specs/2026-09-14-orchestrator-redesign-design.md` (status line)
- Modify: `docs/orchestrator-howto.md` (the run's shape, Phase 0 worktrees, Setup)
- Modify: `docs/deferred.md` (new entry at the top)
- Modify: `docs/open-issues.md` (mirror row)

- [ ] **Step 1: Update the spec's status**

In `docs/superpowers/specs/2026-09-14-orchestrator-redesign-design.md`, replace:

```
**Status:** Design approved in conversation 2026-09-14. Slices 1-3 built (149be624, 680da968, 27228cb9). Slice 4 is split into 4a-4d (§13); 4a and 4b are built (f3b8de76, 48bd69df), and 4c is built from `docs/superpowers/plans/2026-09-15-orchestrator-redesign-s4c-setup-merge-verify.md`.
```

with:

```
**Status:** Design approved in conversation 2026-09-14. Slices 1-3 built (149be624, 680da968, 27228cb9). Slice 4 is split into 4a-4d (§13), all built: 4a and 4b (f3b8de76, 48bd69df), 4c (01ade5da) from `docs/superpowers/plans/2026-09-15-orchestrator-redesign-s4c-setup-merge-verify.md`, and 4d from `docs/superpowers/plans/2026-09-15-orchestrator-redesign-s4d-lanes.md`.
```

- [ ] **Step 2: Update the howto**

In `docs/orchestrator-howto.md`, replace:

```
spawns one child agent per ready task,
each in its own git worktree on its own branch. Children commit and report done, and the engine
squash-merges each finished branch back the moment it lands cleanly.
```

with:

```
spawns one child agent per ready task.
A chain of tasks, each the only one waiting on the task before it, is a lane: it shares one git worktree
and one branch, each child commits on top of the last, and the engine squash-merges the lane back once its
last task is done.
```

Replace:

```
The engine gives every child its own linked worktree under
`<project>/.waveterm/worktrees/<runID>-<taskID>` on a branch named `wave/<key>`
(`pkg/orchestrate/worktree.go`).
```

with:

```
The engine gives every lane one linked worktree under
`<project>/.waveterm/worktrees/<runID>-<taskID>`, keyed by the lane's first task, on a branch named
`wave/<key>` (`pkg/orchestrate/worktree.go`, `pkg/orchestrate/lane.go`).
```

Replace:

```
runs in every new task worktree before its worker starts, and
```

with:

```
runs in every new worktree before its worker starts, and
```

- [ ] **Step 3: Record the deferrals**

In `docs/deferred.md`, insert directly above `## Merge-point Verify: a timeout kills the shell only, and a failed Verify holds only its own run's merges (2026-09-15)`:

```markdown
## Lanes: a skipped task's commits land with its lane, and a retry's evidence starts at the branch head (2026-09-15)

Slice 4d of the orchestrator redesign (`docs/superpowers/plans/2026-09-15-orchestrator-redesign-s4d-lanes.md`)
runs a chain of tasks as one lane: one worktree and branch, and one squash merge once the last task is done.

- **What was deferred:**
  - Skipping a task never rewinds its lane's branch. Anything a failed attempt committed before the task was
    skipped lands with the lane's squash merge.
  - A retried task continues from the lane branch, including any commits its failed attempt made. Its child
    run's `BaseCommit` is the branch head at the retry, so its evidence leaves those commits out.
  - A lane's first task retried after a Setup failure keeps the base its branch was created at, even when
    other lanes have merged since.
- **Why:** workers commit once, at the end, so a failed attempt rarely leaves commits behind. Rewinding needs
  a hard reset inside a tree that `task worktree:prepare` junctions into, the class of operation 6179ac3d had
  to make safe for removal.
- **Where to pick it up:** in `applyActionLocked`'s `skip` case (`pkg/orchestrate/mutation.go`), reset the lane
  worktree to the last done task's reported commit (its child run's `EndCommit`) after `DumpRecoveryPatch`,
  unlinking junctions first as `removeWorktreeDir` does. For evidence, stamp the base on the task node at its
  first dispatch and reuse it on a retry.
```

In `docs/open-issues.md`, add a row directly after the row that starts `| A merge-point Verify timeout kills the shell but not its children,`:

```markdown
| A skipped task's commits land with its lane, and a retried task's evidence leaves out its failed attempt's commits | limitation | S | `docs/deferred.md` 2026-09-15 lanes entry, with where the fix plugs in. **Deferred 2026-09-15 by orchestrator redesign slice 4d**: workers commit only at the end, so a failed attempt rarely has commits |
```

- [ ] **Step 4: Verify everything**

From PowerShell at the repo root:

```powershell
$env:CGO_CFLAGS = "-O2 -g -I$((Get-Location).Path -replace '\\','/')/pkg/jarvisembed/csrc"
go test ./pkg/orchestrate/... ./pkg/wshrpc/... ./pkg/waveobj/... ./pkg/jarvis/... ./cmd/wsh/... -count=1
go vet ./pkg/orchestrate/... ./pkg/wshrpc/... ./cmd/wsh/...
gofmt -l pkg/orchestrate pkg/waveobj/wtype.go pkg/wshrpc/wshrpctypes_dag.go pkg/wshrpc/wshserver/wshserver_dag.go pkg/wshrpc/wshserver/wshserver_dagplan_test.go cmd/wsh/cmd/wshcmd-jarvisdag.go cmd/wsh/cmd/wshcmd-jarvisdag_test.go
task generate
git status --short
```

Expected:
- Every test PASSes, and `go vet` reports nothing new.
- `gofmt -l` lists no file this slice changed. If it lists one, run `gofmt -d` on it and fix only hunks this slice wrote.
- After `task generate`, `git status --short` shows no generated file changed beyond Task 3's `frontend/types/gotypes.d.ts`.

```bash
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit
npx vitest run
npx prettier --check frontend/app/view/orchestrate/dagstore.ts frontend/app/view/orchestrate/dagstore.test.ts frontend/app/view/orchestrate/daggraph.tsx
```

Expected:
- tsc exits 0.
- vitest passes every test in the files this slice touched. A failure in a file this slice did not touch is reported with the commit, not fixed here.
- prettier passes the three files. If it flags one, check whether HEAD's version is already flagged (`git show HEAD:<path> | npx prettier --stdin-filepath <path> --check`), and fix only this slice's hunks.

Not live-checked: the dev app's `wavesrv` and `wsh` are not rebuilt. A real lane run is the effort's Live acceptance chunk.

- [ ] **Step 5: Tick the effort chunk**

```bash
wsh effort chunk status aeabb4ad-a19c-4f5d-bba2-44586b73af16 "S4d lanes - lane worktrees, stacked in-lane commits, lane-tip merge, cross-lane waits, G1 fold (plan)" done --note "<commit sha and date>: lanes derived from deps; one worktree per lane with stacked commits (EnsureRunWorktree continues the branch, Setup failure keeps it); in-lane deps need done, cross-lane need the lane landed; one worker per lane; merge, conflict, Verify and cleanup at the lane tip; dag submit --spec, spec and plan staged into the first squash; digest and graph merge action per lane tip. Verified: <the test commands that passed>. Not live-checked."
```

- [ ] **Step 6: Commit**

Stage only this slice's files. Run `git status --short` first, and stage each path below that it lists as changed:

```bash
git add pkg/orchestrate/lane.go pkg/orchestrate/lane_test.go pkg/orchestrate/laneschedule_test.go pkg/orchestrate/digestlane_test.go \
  pkg/orchestrate/scheduler.go pkg/orchestrate/digest.go pkg/orchestrate/digest_test.go pkg/orchestrate/worktree.go pkg/orchestrate/worktree_test.go \
  pkg/orchestrate/engine.go pkg/orchestrate/merge.go pkg/orchestrate/merge_test.go pkg/orchestrate/mergetask.go pkg/orchestrate/mergetask_test.go \
  pkg/orchestrate/cleanup.go pkg/orchestrate/cleanup_test.go pkg/orchestrate/mutation.go pkg/orchestrate/mutation_test.go \
  pkg/orchestrate/queue.go pkg/orchestrate/queue_test.go pkg/orchestrate/verify_test.go pkg/orchestrate/continue_test.go \
  pkg/orchestrate/dag.go pkg/orchestrate/dag_test.go \
  pkg/waveobj/wtype.go pkg/wshrpc/wshrpctypes_dag.go pkg/wshrpc/wshserver/wshserver_dag.go pkg/wshrpc/wshserver/wshserver_dagplan_test.go \
  cmd/wsh/cmd/wshcmd-jarvisdag.go cmd/wsh/cmd/wshcmd-jarvisdag_test.go frontend/types/gotypes.d.ts \
  frontend/app/view/orchestrate/dagstore.ts frontend/app/view/orchestrate/dagstore.test.ts frontend/app/view/orchestrate/daggraph.tsx \
  docs/orchestrator-howto.md docs/deferred.md docs/open-issues.md \
  docs/superpowers/specs/2026-09-14-orchestrator-redesign-design.md \
  docs/superpowers/plans/2026-09-15-orchestrator-redesign-s4d-lanes.md
git diff --cached --stat
git commit -m "feat(orchestrate): run a chain of tasks as one lane that stacks its commits in one worktree and lands as one merge, so a serial plan pays for one Setup, one merge and one Verify"
```

`git diff --cached --stat` must not list `docs/prototype/jarvis-brief-live.dc.html` or any other file this slice did not change.

---

## Self-review notes

- **Spec coverage:**
  - §4 Lanes. The maximal-chain rule is `jarvis.Lanes` (slice 4a), used by Task 1. Fork, join and independent lanes each start from the project branch at dispatch (Task 2, where `EnsureRunWorktree` creates a missing branch at the project head).
  - §4 one worktree and branch per lane, keyed by its first task: Tasks 1 and 2.
  - §4 in-lane commits stack, and each task gets a fresh worker based on the previous task's commit: Task 2 (dispatch base is the tree head) and Task 4 (`TestLaneTasksStackInOneWorktreeAndMergeOnce`).
  - §4 one squash merge at the lane tip, with Verify after it: Task 4. Verify already follows every merge (slice 4c) and is recorded on the tip.
  - §4 Merges: a dependent in another lane waits for its dependency's lane to merge, and a dependent in the same lane does not. Task 1 (`depSatisfied`), tested at both the pure and the engine level.
  - §4 Merges: a conflict leaves the tip `blocked-merge`, and `dag merge <tip> --continue` finishes the lane (Task 4).
  - §2 wake line `merge conflict landing lane ending at task N`: Task 4.
  - §2 G1: the spec and plan stay uncommitted until the first lane merge, which stages exactly those two paths after the clean-index check. Tasks 3 and 4.
  - §12 lane derivation (chain, fork, join, independent) is tested in `pkg/jarvis/plan_test.go` (slice 4a). The G1 fold test is `TestOnlyTheFirstMergeCarriesTheSpecAndPlan` and `TestMergeRunWorktreeFoldsDocsIntoTheSquashCommit`.
- **Beyond the spec, and why:**
  - **One worker per lane** (`NextToSpawn`): retrying a done task while a later task in its lane runs would put two workers in one tree.
  - **`worktreeOnBranch`:** keeping branches past a directory removal makes a stray directory at a lane's path more likely. Git run inside such a directory acts on the project checkout, and a recovery dump would stage the project's own changes.
  - **Setup failure keeps the branch:** otherwise a Setup failure mid-lane deletes the earlier tasks' commits.
  - **The graph node's merge action comes from the digest:** only the engine derives lanes. Porting `jarvis.Lanes` to TypeScript would give the rule a second home.
  - **`dag submit` checks the spec path exists:** a mistyped path would otherwise surface only as a log line at the first merge.
- **Deferred:** a skipped task's commits land with its lane, and a retry's evidence base (Task 6, `docs/deferred.md`). The lead's launch prompt using `--spec` is slice 5.
