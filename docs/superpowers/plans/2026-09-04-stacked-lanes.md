# Stacked Lanes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a chain of dependent DAG tasks run on one git branch and land with one squash merge, instead of costing one worktree, one merge and one lead wake per step.

**Architecture:** At spawn time the engine derives — from the already-declared deps — whether a task is a pure chain step; if so it cuts the task's worktree from its predecessor's *branch tip* instead of project HEAD and records `TaskNode.StackedOn`. A chain of such tasks is a **lane**: one branch, merged once at its **tip**. `depSatisfied` becomes dependent-aware so a stack link is satisfied on the predecessor's *done*, while forks and joins keep today's satisfied-on-*merged* rule. The merge handler refuses a non-tip and stamps the whole lane at once. The same change makes `buildNext` total (no bare `terminal` on a running DAG).

**Tech Stack:** Go 1.23+ (`pkg/orchestrate`, `pkg/wshrpc/wshserver`, `pkg/jarvis`, `cmd/wsh`), React 19 + TypeScript + vitest (`frontend/app/view/orchestrate`), git worktrees, SQLite-backed `waveobj` blobs.

**Spec:** `docs/superpowers/specs/2026-09-04-stacked-lanes-design.md` — read it before Task 1 and keep it open; every task below argues from it.

---

## Global Constraints

These apply to **every** task. Do not restate them per task; do not violate them silently.

- **Test commands (Go).** Plain `go test` fails on this repo. Always run Go tests from the repo root in PowerShell with:
  ```powershell
  $env:CGO_CFLAGS = "-O2 -g -I$((Get-Location).Path -replace '\\','/')/pkg/jarvisembed/csrc"
  $env:CGO_ENABLED = "1"
  $env:CC = "zig cc -target x86_64-windows-gnu"
  ```
  Set those once per shell, then `go test ./pkg/orchestrate/ -run TestName -count=1 -v`. Both env blocks are required for `./pkg/wshrpc/wshserver/`; `./pkg/orchestrate/` and `./pkg/jarvis/` need at least `CGO_ENABLED`/`CC`. Verified working before this plan was written.
- **Test commands (frontend).** `npx vitest run frontend/app/view/orchestrate/dagstore.test.ts`. Filter by name with `-t "..."`.
- **Typecheck.** `npx tsc` stack-overflows here. Use `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`. The baseline is clean (exit 0); any error it reports is yours.
- **Never hand-edit generated files.** `frontend/types/gotypes.d.ts` and `frontend/app/store/wshclientapi.ts` come from `task generate`. Go is the source of truth.
- **Field name is exactly `StackedOn` / json `stackedon`.** Same spelling in Go, generated TS, and every message.
- **`waitDecision` (`cmd/wsh/cmd/wshcmd-jarvisdag.go:150`) is NOT touched by this plan.** The spec is explicit; changing it alone makes a flat DAG report neither an action nor a terminal state, which is worse. Add tests against it; change no line of it.
- **`depSatisfied` signature after Task 2 is `depSatisfied(g *waveobj.TaskGroup, t *waveobj.TaskNode, depID string) bool`** — `t` is the *dependent*, `depID` is the dependency being checked.
- **Comment style:** comments explain *why*, never *what*; lower case; only where the reason is non-obvious. No emojis anywhere — code, tests, commit messages, docs.
- **Commit style:** conventional commits, `type(scope): description`, subject under 72 chars. Commit at the end of each task, after its tests pass. Do **not** add a Co-Authored-By trailer.
- **Engine-owned fields are never hand-set by a lead.** `StackedOn` joins `State`, `RunID`, `Released`, `Merged`, cleanup fields, `LastActivity`, `Attempts`, `LastFailureKind`, `Escalations` in the submit-time rejection list.
- **Non-git projects are unaffected.** `MergeRequired == false` means the stacking rule never fires and nothing in this change is reachable.

---

## File Structure

| File | Responsibility after this change |
|---|---|
| `pkg/waveobj/wtype.go` | `TaskNode.StackedOn` — the persisted record of a stacked spawn |
| `pkg/orchestrate/lane.go` **(new)** | The whole lane model: `taskIsLive`, `liveDependents`, `stackPredecessor`, `stackedSuccessor`, `isLaneTip`, `LaneTipFor`, `LaneTasks` |
| `pkg/orchestrate/lane_test.go` **(new)** | Table tests for the stacking rule, the `depSatisfied` stack link, tips and the lane walk |
| `pkg/orchestrate/scheduler.go` | `depSatisfied` takes the dependent and consults the stacking rule |
| `pkg/orchestrate/engine.go` | Per-task spawn base; records `StackedOn`; child `BaseCommit`; the stacked line in `taskPrompt` |
| `pkg/orchestrate/dag.go` | Rejects a submitted `StackedOn` |
| `pkg/orchestrate/digest.go` | Tips-only merge-ready; total `buildNext` with a `cleanup-wait` step; `stacked` merge state |
| `pkg/orchestrate/mutation.go` | Refuses retry of a task with a live stacked successor |
| `pkg/wshrpc/wshrpctypes_dag.go` | Enum comments for the new `cleanup-wait` kind and `stacked` merge state |
| `pkg/wshrpc/wshserver/wshserver_dag.go` | Non-tip merge refusal; lane commit message; lane-wide merged/cleanup stamping |
| `pkg/jarvis/run.go` | The lead's chain rule, in the digest's own vocabulary |
| `cmd/wsh/cmd/wshcmd-jarvisdag.go` | `stacked on t-3` in the status signal column |
| `frontend/app/view/orchestrate/dagstore.ts` | `merge` action only on a tip; `stacked on` in the node meta line |
| `frontend/app/view/orchestrate/dagdigest.ts` | `cleanup-wait` next-step text |
| docs | Observability spec amendment; issue trackers marked resolved |

**Why a new `lane.go` instead of putting the helpers in `scheduler.go` (which the spec's Files table names):** `pkg/orchestrate` is already file-per-concern (`cleanup.go`, `merge.go`, `worktree.go`, `retry.go`, `liveness.go`, `outcome.go`), each with a sibling `_test.go`. The lane model is a distinct concern with its own test surface, consumed by four other files. `depSatisfied` still changes in `scheduler.go` where it lives. This is a placement decision only — no behaviour differs from the spec.

---

### Task 1: Persist `StackedOn`

**Files:**
- Modify: `pkg/waveobj/wtype.go:305-330` (the `TaskNode` struct)
- Modify: `pkg/orchestrate/dag.go:154-183` (the engine-field rejection loop in `NewTaskGroup`)
- Test: `pkg/orchestrate/dag_test.go:39-70` (rejection table), `pkg/orchestrate/dag_test.go:95-118` (`SameDagProposal`)
- Generated: `frontend/types/gotypes.d.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `waveobj.TaskNode.StackedOn string` (json `stackedon,omitempty`), and the generated TS field `stackedon?: string` on `type TaskNode`. Every later task reads or writes this field.

- [ ] **Step 1: Write the failing tests**

In `pkg/orchestrate/dag_test.go`, add one row to the `cases` table inside `TestNewTaskGroupRejectsInvalidAuthoringAndEngineState` (after the `escalations` row, keeping the existing style):

```go
		{name: "stackedon", title: "g", parallelism: 1, tasks: []waveobj.TaskNode{{ID: "t", Label: "a", StackedOn: "t-0"}}},
```

In the same file, inside the `SameDagProposal` test that mutates `b.Tasks[0]` engine state (the block that sets `b.Tasks[0].Escalations = 1`), add one line immediately after it, before the `SameDagProposal(a, &b)` assertion:

```go
	b.Tasks[0].StackedOn = "t-0"
```

- [ ] **Step 2: Run the tests to verify they fail**

```powershell
go test ./pkg/orchestrate/ -run "TestNewTaskGroupRejects|TestSameDagProposal" -count=1
```
Expected: FAIL — compile error, `unknown field StackedOn in struct literal of type waveobj.TaskNode`.

- [ ] **Step 3: Add the field**

In `pkg/waveobj/wtype.go`, inside `TaskNode`, replace this line:

```go
	Merged      bool     `json:"merged,omitempty"`   // successful squash-merge back into the project branch
	RunSpec     RunSpec  `json:"runspec,omitempty"`
```

with:

```go
	Merged      bool     `json:"merged,omitempty"`   // successful squash-merge back into the project branch
	// StackedOn is the predecessor this task's worktree was cut from, recorded by the engine at spawn
	// when the task ran as a chain step. Empty for a task cut from project HEAD. Merge walks it to land
	// a lane as a unit; the digest and graph read it to tell a lane tip from a stacked step.
	StackedOn string  `json:"stackedon,omitempty"`
	RunSpec   RunSpec `json:"runspec,omitempty"`
```

- [ ] **Step 4: Reject it at submit**

In `pkg/orchestrate/dag.go`, inside the `for _, t := range tasks` rejection loop in `NewTaskGroup`, add immediately after the `t.Merged` check:

```go
		if t.StackedOn != "" {
			return waveobj.TaskGroup{}, fmt.Errorf("task %q stackedon must be empty", t.ID)
		}
```

- [ ] **Step 5: Run the tests to verify they pass**

```powershell
go test ./pkg/orchestrate/ -run "TestNewTaskGroupRejects|TestSameDagProposal" -count=1 -v
```
Expected: PASS, including the new `stackedon` subtest.

- [ ] **Step 6: Regenerate the TypeScript types**

```powershell
task generate
```
Then confirm the field landed:
```powershell
Select-String -Path frontend/types/gotypes.d.ts -Pattern "stackedon"
```
Expected: one hit, `stackedon?: string;` inside `type TaskNode`. If `task generate` produces unrelated churn, keep only the `gotypes.d.ts` TaskNode change and revert the rest.

- [ ] **Step 7: Commit**

```bash
git add pkg/waveobj/wtype.go pkg/orchestrate/dag.go pkg/orchestrate/dag_test.go frontend/types/gotypes.d.ts
git commit -m "feat(orchestrate): record the predecessor a task's worktree was cut from"
```

---

### Task 2: The lane model, and a dependent-aware `depSatisfied`

**Files:**
- Create: `pkg/orchestrate/lane.go`
- Create: `pkg/orchestrate/lane_test.go`
- Modify: `pkg/orchestrate/scheduler.go:25-62` (`ReadyTasks`, `depSatisfied`)
- Modify: `pkg/orchestrate/digest.go` — call sites at lines 213-220 (`hasUnsatDep`), 278-289 (`depChainReachesMergeReady`), 405-431 (`dependencyWait`), 502-522 (`taskReady`, `taskBlockingIds`)

**Interfaces:**
- Consumes: `waveobj.TaskNode.StackedOn` (Task 1).
- Produces:
  - `func stackPredecessor(g *waveobj.TaskGroup, t *waveobj.TaskNode) (*waveobj.TaskNode, bool)` — unexported; used by `depSatisfied` and the spawn loop (Task 3).
  - `func stackedSuccessor(g *waveobj.TaskGroup, t *waveobj.TaskNode) *waveobj.TaskNode` — unexported; used by the retry refusal (Task 4).
  - `func isLaneTip(g *waveobj.TaskGroup, t *waveobj.TaskNode) bool` — unexported; used by the digest (Task 5).
  - `func LaneTipFor(g *waveobj.TaskGroup, t *waveobj.TaskNode) *waveobj.TaskNode` — exported; used by the merge handler (Task 6).
  - `func LaneTasks(g *waveobj.TaskGroup, tip *waveobj.TaskNode) []*waveobj.TaskNode` — exported; lane order, first step first; used by the merge handler (Task 6).
  - `func depSatisfied(g *waveobj.TaskGroup, t *waveobj.TaskNode, depID string) bool` — new signature.

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

// markDone puts a task in the state a finished child leaves it in: done, with a child run (so its
// wave/<key> branch exists).
func markDone(g *waveobj.TaskGroup, id string) {
	task := taskByID(g, id)
	task.State = TaskState_Done
	task.RunID = "run-" + id
}

func TestStackPredecessorRule(t *testing.T) {
	chain := []waveobj.TaskNode{
		{ID: "t-0", Label: "a"},
		{ID: "t-1", Label: "b", Deps: []string{"t-0"}},
	}
	fork := []waveobj.TaskNode{
		{ID: "t-0", Label: "a"},
		{ID: "t-1", Label: "b", Deps: []string{"t-0"}},
		{ID: "t-2", Label: "c", Deps: []string{"t-0"}},
	}
	join := []waveobj.TaskNode{
		{ID: "t-0", Label: "a"},
		{ID: "t-2", Label: "c"},
		{ID: "t-1", Label: "b", Deps: []string{"t-0", "t-2"}},
	}
	cases := []struct {
		name          string
		mergeRequired bool
		tasks         []waveobj.TaskNode
		setup         func(g *waveobj.TaskGroup)
		want          bool
	}{
		{"single done dependency stacks", true, chain,
			func(g *waveobj.TaskGroup) { markDone(g, "t-0") }, true},
		{"fork does not stack", true, fork,
			func(g *waveobj.TaskGroup) { markDone(g, "t-0") }, false},
		{"skipped sibling leaves a chain", true, fork,
			func(g *waveobj.TaskGroup) { markDone(g, "t-0"); taskByID(g, "t-2").State = TaskState_Skipped }, true},
		{"join does not stack", true, join,
			func(g *waveobj.TaskGroup) { markDone(g, "t-0"); markDone(g, "t-2") }, false},
		{"released gate stacks", true, chain,
			func(g *waveobj.TaskGroup) {
				markDone(g, "t-0")
				taskByID(g, "t-0").Gate = true
				taskByID(g, "t-0").Released = true
			}, true},
		{"unreleased gate does not stack", true, chain,
			func(g *waveobj.TaskGroup) { markDone(g, "t-0"); taskByID(g, "t-0").Gate = true }, false},
		{"running dependency does not stack", true, chain,
			func(g *waveobj.TaskGroup) { taskByID(g, "t-0").State = TaskState_Running }, false},
		{"dependency without a child run does not stack", true, chain,
			func(g *waveobj.TaskGroup) { taskByID(g, "t-0").State = TaskState_Done }, false},
		{"non-git group does not stack", false, chain,
			func(g *waveobj.TaskGroup) { markDone(g, "t-0") }, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			g, err := NewTaskGroup("run-1", "ch-1", "g", 2, tc.mergeRequired, tc.tasks, 1000, nil)
			if err != nil {
				t.Fatal(err)
			}
			tc.setup(&g)
			pred, ok := stackPredecessor(&g, taskByID(&g, "t-1"))
			if ok != tc.want {
				t.Fatalf("stackPredecessor ok = %v, want %v", ok, tc.want)
			}
			if ok && pred.ID != "t-0" {
				t.Fatalf("stacked on %q, want t-0", pred.ID)
			}
		})
	}
}

func TestDepSatisfiedStackLinkAndJoin(t *testing.T) {
	g, err := NewTaskGroup("run-1", "ch-1", "g", 2, true, []waveobj.TaskNode{
		{ID: "t-0", Label: "a"},
		{ID: "t-1", Label: "b", Deps: []string{"t-0"}},
		{ID: "t-2", Label: "c", Deps: []string{"t-0"}},
	}, 1000, nil)
	if err != nil {
		t.Fatal(err)
	}
	markDone(&g, "t-0")
	// two live dependents: t-0 is a fork, so both successors wait for it to land on project HEAD
	if depSatisfied(&g, taskByID(&g, "t-1"), "t-0") {
		t.Fatal("a fork's successor must wait for its dependency to merge")
	}
	taskByID(&g, "t-2").State = TaskState_Skipped
	// t-1 is now t-0's only live dependent: the stack link is satisfied on done, before any merge
	if !depSatisfied(&g, taskByID(&g, "t-1"), "t-0") {
		t.Fatal("a stacked chain step must be satisfied on done")
	}
	// today's rules are untouched: merged satisfies every dependent, skipped never blocks
	taskByID(&g, "t-2").State = TaskState_Pending
	taskByID(&g, "t-0").Merged = true
	if !depSatisfied(&g, taskByID(&g, "t-1"), "t-0") {
		t.Fatal("a merged dependency satisfies every dependent")
	}
	taskByID(&g, "t-0").State = TaskState_Skipped
	if !depSatisfied(&g, taskByID(&g, "t-1"), "t-0") {
		t.Fatal("a skipped dependency never blocks")
	}
}

func TestLaneTipAndWalk(t *testing.T) {
	g, err := NewTaskGroup("run-1", "ch-1", "g", 2, true, []waveobj.TaskNode{
		{ID: "t-0", Label: "one"},
		{ID: "t-1", Label: "two", Deps: []string{"t-0"}},
		{ID: "t-2", Label: "three", Deps: []string{"t-1"}},
	}, 1000, nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"t-0", "t-1", "t-2"} {
		markDone(&g, id)
	}
	taskByID(&g, "t-1").StackedOn = "t-0"
	taskByID(&g, "t-2").StackedOn = "t-1"

	if isLaneTip(&g, taskByID(&g, "t-0")) || isLaneTip(&g, taskByID(&g, "t-1")) {
		t.Fatal("a step with a live stacked successor is not a tip")
	}
	if !isLaneTip(&g, taskByID(&g, "t-2")) {
		t.Fatal("the last live step of a lane is its tip")
	}
	if tip := LaneTipFor(&g, taskByID(&g, "t-0")); tip.ID != "t-2" {
		t.Fatalf("LaneTipFor(t-0) = %q, want t-2", tip.ID)
	}
	var ids []string
	for _, task := range LaneTasks(&g, taskByID(&g, "t-2")) {
		ids = append(ids, task.ID)
	}
	if !reflect.DeepEqual(ids, []string{"t-0", "t-1", "t-2"}) {
		t.Fatalf("lane walk = %v, want [t-0 t-1 t-2]", ids)
	}
	// a skipped last step hands the tip back to its predecessor
	taskByID(&g, "t-2").State = TaskState_Skipped
	if !isLaneTip(&g, taskByID(&g, "t-1")) {
		t.Fatal("a skipped last step must make its predecessor the tip")
	}
	// a failed successor is still live: the lane is not finished, so nothing in it may land
	taskByID(&g, "t-2").State = TaskState_Failed
	if isLaneTip(&g, taskByID(&g, "t-1")) {
		t.Fatal("a failed stacked successor must keep its predecessor off the tip list")
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

```powershell
go test ./pkg/orchestrate/ -run "TestStackPredecessorRule|TestDepSatisfiedStackLinkAndJoin|TestLaneTipAndWalk" -count=1
```
Expected: FAIL — `undefined: stackPredecessor`, `undefined: isLaneTip`, `undefined: LaneTipFor`, `undefined: LaneTasks`, and a wrong-argument-count error on `depSatisfied`.

- [ ] **Step 3: Create `pkg/orchestrate/lane.go`**

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package orchestrate

import "github.com/wavetermdev/waveterm/pkg/waveobj"

// The lane model. A lane is a chain of tasks whose worktrees were cut from one another rather than
// from project HEAD: one branch, one squash merge, landed at the lane's tip. Lanes are derived from
// declared deps at spawn time — never declared by the lead — and the engine records the link it took
// on TaskNode.StackedOn. Only chains stack: a fork or a join is where integration genuinely has to
// happen, and squash merge stays sound only while every squash brings commits main has not seen.

// taskIsLive reports whether a task still counts as a dependent. Skipped and cancelled work is
// abandoned, so it must not keep a predecessor off the tip list.
func taskIsLive(t *waveobj.TaskNode) bool {
	return t.State != TaskState_Skipped && t.State != TaskState_Cancelled
}

// liveDependents returns the ids of live tasks declaring id as a dependency, in dag order.
func liveDependents(g *waveobj.TaskGroup, id string) []string {
	var out []string
	for i := range g.Tasks {
		t := &g.Tasks[i]
		if !taskIsLive(t) {
			continue
		}
		for _, d := range t.Deps {
			if d == id {
				out = append(out, t.ID)
				break
			}
		}
	}
	return out
}

// stackPredecessor returns the predecessor t's worktree should be cut from, or false when t must
// start from integrated project HEAD. Single source of the stacking rule: depSatisfied and the spawn
// loop both call it, so they cannot disagree about what a chain step is.
func stackPredecessor(g *waveobj.TaskGroup, t *waveobj.TaskNode) (*waveobj.TaskNode, bool) {
	if !g.MergeRequired || t == nil || len(t.Deps) != 1 {
		return nil, false
	}
	pred := taskByID(g, t.Deps[0])
	if pred == nil || pred.State != TaskState_Done || pred.RunID == "" {
		return nil, false
	}
	if pred.Gate && !pred.Released {
		return nil, false
	}
	deps := liveDependents(g, pred.ID)
	if len(deps) != 1 || deps[0] != t.ID {
		return nil, false
	}
	return pred, true
}

// stackedSuccessor returns the live task the engine stacked directly on t, or nil. At most one can
// exist: the rule only fires for a predecessor with exactly one live dependent.
func stackedSuccessor(g *waveobj.TaskGroup, t *waveobj.TaskNode) *waveobj.TaskNode {
	for i := range g.Tasks {
		s := &g.Tasks[i]
		if s.StackedOn == t.ID && taskIsLive(s) {
			return s
		}
	}
	return nil
}

// isLaneTip reports whether t is the task that lands its lane: finished, unmerged, released when
// gated, in a merge-required group, with no live successor still stacked on it.
func isLaneTip(g *waveobj.TaskGroup, t *waveobj.TaskNode) bool {
	if !g.MergeRequired || t.State != TaskState_Done || t.Merged {
		return false
	}
	if t.Gate && !t.Released {
		return false
	}
	return stackedSuccessor(g, t) == nil
}

// LaneTipFor walks forward through live stacked successors and returns the last one — the id whose
// merge lands t's lane. Returns t when nothing is stacked on it. The result is not necessarily
// mergeable yet (a successor may still be running); it is the task the lead must name.
func LaneTipFor(g *waveobj.TaskGroup, t *waveobj.TaskNode) *waveobj.TaskNode {
	cur := t
	for {
		next := stackedSuccessor(g, cur)
		if next == nil {
			return cur
		}
		cur = next
	}
}

// LaneTasks returns the lane ending at tip, in lane order (the step cut from project HEAD first).
// Walking StackedOn back from a tip is the only lane enumeration in the system.
func LaneTasks(g *waveobj.TaskGroup, tip *waveobj.TaskNode) []*waveobj.TaskNode {
	var lane []*waveobj.TaskNode
	for cur := tip; cur != nil; cur = taskByID(g, cur.StackedOn) {
		lane = append(lane, cur)
	}
	for i, j := 0, len(lane)-1; i < j; i, j = i+1, j-1 {
		lane[i], lane[j] = lane[j], lane[i]
	}
	return lane
}
```

- [ ] **Step 4: Make `depSatisfied` dependent-aware**

In `pkg/orchestrate/scheduler.go`, replace the whole `depSatisfied` function with:

```go
// depSatisfied reports whether t's dependency depID is satisfied. A skipped dependency never blocks.
// Without merge, done is enough. When the stacking rule binds t to depID, done is also enough: t's
// worktree is cut from that branch, so the sequencing event is completion, not integration. Every
// other edge — a join, a fork's successors — still waits for the dependency to land on project HEAD.
func depSatisfied(g *waveobj.TaskGroup, t *waveobj.TaskNode, depID string) bool {
	dep := taskByID(g, depID)
	if dep == nil {
		return false
	}
	if dep.State == TaskState_Skipped {
		return true
	}
	if dep.State != TaskState_Done {
		return false
	}
	if !g.MergeRequired {
		return true
	}
	if pred, ok := stackPredecessor(g, t); ok && pred.ID == depID {
		return true
	}
	return dep.Merged && (!dep.Gate || dep.Released)
}
```

In the same file, in `ReadyTasks`, change the inner loop's call:

```go
		for _, d := range t.Deps {
			if !depSatisfied(g, t, d) {
```

- [ ] **Step 5: Update the four `digest.go` call sites**

In `pkg/orchestrate/digest.go`, pass the dependent at each call. All four already hold it:

- in `hasUnsatDep`: `if !depSatisfied(g, t, d) {`
- in `depChainReachesMergeReady`: `if dn != nil && !depSatisfied(g, t, d) && depChainReachesMergeReady(g, dn, mergeReady) {`
- in `dependencyWait`: `if !depSatisfied(g, t, d) {`
- in `taskReady`: `if !depSatisfied(g, t, d) {`
- in `taskBlockingIds`: `if !depSatisfied(g, t, d) {`

(`depChainReachesMergeReady` is deleted in Task 5; it must still compile here.)

- [ ] **Step 6: Run the tests to verify they pass**

```powershell
go test ./pkg/orchestrate/ -run "TestStackPredecessorRule|TestDepSatisfiedStackLinkAndJoin|TestLaneTipAndWalk" -count=1 -v
```
Expected: PASS, all subtests.

- [ ] **Step 7: Run the whole package — nothing else may regress**

```powershell
go test ./pkg/orchestrate/ -count=1
```
Expected: `ok github.com/wavetermdev/waveterm/pkg/orchestrate`.

- [ ] **Step 8: Commit**

```bash
git add pkg/orchestrate/lane.go pkg/orchestrate/lane_test.go pkg/orchestrate/scheduler.go pkg/orchestrate/digest.go
git commit -m "feat(orchestrate): derive lanes from deps and satisfy a stack link on done"
```

---

### Task 3: Spawn a chain step in its predecessor's tree

**Files:**
- Modify: `pkg/orchestrate/engine.go:287-357` (the spawn loop in `scheduleLocked`), `pkg/orchestrate/engine.go:469-485` (`taskPrompt`)
- Test: `pkg/orchestrate/engine_test.go` (three existing `taskPrompt` tests need the new argument; two new integration tests)

**Interfaces:**
- Consumes: `stackPredecessor` (Task 2), `WorktreeHeadCommit(ctx, projectPath, runID) (string, error)` and `TaskWorktreeKey(ownerRunID, taskID) string` (`pkg/orchestrate/worktree.go`), `FailureKindWorktree` (`pkg/orchestrate/retry.go`).
- Produces:
  - `func taskPrompt(g *waveobj.TaskGroup, task *waveobj.TaskNode, owner *waveobj.Run) string` — **signature changed**, the group is now the first parameter.
  - A spawned stacked task carries `StackedOn = <predecessor id>` and its child run's `BaseCommit` is the predecessor's branch tip.

- [ ] **Step 1: Write the failing tests**

Add to `pkg/orchestrate/engine_test.go`. Its import block needs `os` and `path/filepath` added.

```go
// TestScheduleStacksChainStepOnPredecessorTip: a single-dependency successor whose predecessor is
// done opens in a tree cut from the predecessor's branch tip, not from project HEAD — so it already
// holds the predecessor's commits, its evidence range covers only its own step, and the
// predecessor's branch survives for the lane merge.
func TestScheduleStacksChainStepOnPredecessorTip(t *testing.T) {
	allowWorkerHarnessForTest(t)
	ctx := context.Background()
	projectDir := newGitRepo(t)
	ch, err := wstore.CreateChannel(ctx, "stacked-lane", projectDir)
	if err != nil {
		t.Fatal(err)
	}
	owner := jarvis.NewRun("owner goal", "ws-1", ch.ProjectPath, nil, jarvis.RunMode_Orchestrator, jarvis.DefaultOrchestratorPlaybook(false), 1)
	owner.BaseCommit = gitCmd(t, projectDir, "rev-parse", "HEAD")
	if err := wstore.AppendRun(ctx, ch.OID, owner); err != nil {
		t.Fatal(err)
	}
	g, err := NewTaskGroup(owner.ID, ch.OID, "g", 2, true, []waveobj.TaskNode{
		{ID: "t-0", Label: "gitinfo core"},
		{ID: "t-1", Label: "gitinfo rpc", Deps: []string{"t-0"}},
	}, 1, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := wstore.AppendDag(ctx, &g); err != nil {
		t.Fatal(err)
	}
	var prompts []string
	old := spawnWorker
	spawnWorker = func(_ context.Context, _ runroute.Capability, _, _, _, prompt string, _ jarvis.RunWorkerOptions) (string, error) {
		prompts = append(prompts, prompt)
		return "tab:worker", nil
	}
	defer func() { spawnWorker = old }()

	if err := ScheduleOnce(ctx, &g); err != nil {
		t.Fatal(err)
	}
	key0 := TaskWorktreeKey(owner.ID, "t-0")
	wt0 := filepath.Join(projectDir, ".waveterm", "worktrees", key0)
	if err := os.WriteFile(filepath.Join(wt0, "step0.txt"), []byte("one\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitCmd(t, wt0, "add", ".")
	gitCmd(t, wt0, "commit", "-m", "step 0")
	tip0 := gitCmd(t, projectDir, "rev-parse", "wave/"+key0)

	if err := wstore.UpdateRun(ctx, ch.OID, g.Tasks[0].RunID, func(r *waveobj.Run) error {
		r.Status = jarvis.RunStatus_Done
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if err := ScheduleOnce(ctx, &g); err != nil {
		t.Fatal(err)
	}

	if g.Tasks[1].State != TaskState_Running {
		t.Fatalf("successor must spawn on the predecessor's done, got %s", g.Tasks[1].State)
	}
	if g.Tasks[1].StackedOn != "t-0" {
		t.Fatalf("stackedon = %q, want t-0", g.Tasks[1].StackedOn)
	}
	key1 := TaskWorktreeKey(owner.ID, "t-1")
	wt1 := filepath.Join(projectDir, ".waveterm", "worktrees", key1)
	if _, err := os.Stat(filepath.Join(wt1, "step0.txt")); err != nil {
		t.Fatalf("stacked tree must already hold the predecessor's work: %v", err)
	}
	if base := gitCmd(t, projectDir, "rev-parse", "wave/"+key1); base != tip0 {
		t.Fatalf("stacked branch base = %s, want the predecessor tip %s", base, tip0)
	}
	if _, err := WorktreeHeadCommit(ctx, projectDir, key0); err != nil {
		t.Fatalf("predecessor branch must survive until the lane lands: %v", err)
	}
	child, err := wstore.GetRun(ctx, ch.OID, g.Tasks[1].RunID)
	if err != nil {
		t.Fatal(err)
	}
	if child.BaseCommit != tip0 {
		t.Fatalf("stacked child BaseCommit = %s, want %s so evidence covers only this step", child.BaseCommit, tip0)
	}
	if len(prompts) != 2 || !strings.Contains(prompts[1], "finished work of task t-0 (gitinfo core)") {
		t.Fatalf("stacked child's prompt must name the predecessor: %q", prompts[len(prompts)-1])
	}
}

// TestScheduleJoinWaitsForMergedDeps: a task with two dependencies is an integration point. Both
// children being done is not enough — it must not spawn until both have landed on project HEAD.
func TestScheduleJoinWaitsForMergedDeps(t *testing.T) {
	allowWorkerHarnessForTest(t)
	ctx := context.Background()
	projectDir := newGitRepo(t)
	ch, err := wstore.CreateChannel(ctx, "join-wait", projectDir)
	if err != nil {
		t.Fatal(err)
	}
	owner := jarvis.NewRun("owner goal", "ws-1", ch.ProjectPath, nil, jarvis.RunMode_Orchestrator, jarvis.DefaultOrchestratorPlaybook(false), 1)
	owner.BaseCommit = gitCmd(t, projectDir, "rev-parse", "HEAD")
	if err := wstore.AppendRun(ctx, ch.OID, owner); err != nil {
		t.Fatal(err)
	}
	g, err := NewTaskGroup(owner.ID, ch.OID, "g", 3, true, []waveobj.TaskNode{
		{ID: "t-0", Label: "a"},
		{ID: "t-1", Label: "b"},
		{ID: "t-2", Label: "verify", Deps: []string{"t-0", "t-1"}},
	}, 1, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := wstore.AppendDag(ctx, &g); err != nil {
		t.Fatal(err)
	}
	old := spawnWorker
	spawnWorker = func(context.Context, runroute.Capability, string, string, string, string, jarvis.RunWorkerOptions) (string, error) {
		return "tab:worker", nil
	}
	defer func() { spawnWorker = old }()

	if err := ScheduleOnce(ctx, &g); err != nil {
		t.Fatal(err)
	}
	for _, idx := range []int{0, 1} {
		if err := wstore.UpdateRun(ctx, ch.OID, g.Tasks[idx].RunID, func(r *waveobj.Run) error {
			r.Status = jarvis.RunStatus_Done
			return nil
		}); err != nil {
			t.Fatal(err)
		}
	}
	if err := ScheduleOnce(ctx, &g); err != nil {
		t.Fatal(err)
	}
	if g.Tasks[2].State != TaskState_Pending {
		t.Fatalf("a join must wait for its deps to merge, got %s", g.Tasks[2].State)
	}
	if err := wstore.UpdateDag(ctx, g.OID, func(cur *waveobj.TaskGroup) error {
		cur.Tasks[0].Merged = true
		cur.Tasks[1].Merged = true
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if err := ScheduleOnce(ctx, &g); err != nil {
		t.Fatal(err)
	}
	if g.Tasks[2].State != TaskState_Running {
		t.Fatalf("a join must spawn once both deps merged, got %s", g.Tasks[2].State)
	}
	if g.Tasks[2].StackedOn != "" {
		t.Fatalf("a join is cut from integrated HEAD, got stackedon %q", g.Tasks[2].StackedOn)
	}
}
```

Also update the three existing `taskPrompt` call sites in `engine_test.go` (`TestTaskPromptCarriesDescriptionAndContract`, `TestTaskPromptLabelOnlyStillHasContract`, `TestTaskPromptRunSpecGoalWins`) to pass a group first, e.g.:

```go
	g := &waveobj.TaskGroup{Tasks: []waveobj.TaskNode{{ID: "t-1", Label: "add fmtDate", Description: desc}}}
	p := taskPrompt(g, &g.Tasks[0], &owner)
```

Apply the same shape to the other two (their own task literals and assertions unchanged).

- [ ] **Step 2: Run the tests to verify they fail**

```powershell
go test ./pkg/orchestrate/ -run "TestScheduleStacksChainStep|TestScheduleJoinWaits|TestTaskPrompt" -count=1
```
Expected: FAIL — `not enough arguments in call to taskPrompt`, and (once that compiles) `stackedon = "" want t-0`.

- [ ] **Step 3: Cut the worktree from the predecessor's tip**

In `pkg/orchestrate/engine.go`, inside the `for _, taskID := range NextToSpawn(g)` loop, replace this block:

```go
		cwd := owner.ProjectPath
		if IsGitRepo(owner.ProjectPath) {
			wt, werr := EnsureRunWorktree(spawnCtx, owner.ProjectPath, TaskWorktreeKey(owner.ID, taskID), spawnBase)
			if werr != nil {
				failDispatch(ctx, g, taskID, FailureKindWorktree, werr, &afterCommit)
				continue
			}
			cwd = wt
		}
```

with:

```go
		base := spawnBase
		cwd := owner.ProjectPath
		if IsGitRepo(owner.ProjectPath) {
			// a chain step opens in its predecessor's tree, so the sequencing event is the
			// predecessor's completion rather than its integration. The record cannot go stale: a
			// done task carrying a live stacked successor can no longer be retried, skipped or
			// escalated, and a task's live dependents only ever shrink.
			if pred, ok := stackPredecessor(g, task); ok {
				tip, terr := WorktreeHeadCommit(spawnCtx, owner.ProjectPath, TaskWorktreeKey(owner.ID, pred.ID))
				if terr != nil {
					failDispatch(ctx, g, taskID, FailureKindWorktree, terr, &afterCommit)
					continue
				}
				base = tip
				task.StackedOn = pred.ID
			}
			wt, werr := EnsureRunWorktree(spawnCtx, owner.ProjectPath, TaskWorktreeKey(owner.ID, taskID), base)
			if werr != nil {
				failDispatch(ctx, g, taskID, FailureKindWorktree, werr, &afterCommit)
				continue
			}
			cwd = wt
		}
```

- [ ] **Step 4: Give the child the base it was actually cut from**

Still in the spawn loop, change the `taskPrompt` call and the `childRunFromSpec` call:

```go
		prompt := taskPrompt(g, task, owner) + "\n\n" + dagSessionMarker(g.OID, taskID)
```

```go
		childRun := childRunFromSpec(g, task, owner, pin, cwd, base, prompt)
```

(`childRunFromSpec` sets `run.BaseCommit`; evidence is sealed over `BaseCommit..EndCommit`, so a stacked child must carry its predecessor's tip or its evidence would claim the whole lane.)

- [ ] **Step 5: Tell the child what its tree already contains**

In `pkg/orchestrate/engine.go`, replace `taskPrompt` with:

```go
// taskPrompt is the child's goal: per-task RunSpec goal, else the task label, with the plan
// description (decision pins) and the headless contract appended so the child never re-asks what the
// plan already decided. A stacked child is told what its tree already holds, or it re-derives the
// predecessor's work it is sitting on.
func taskPrompt(g *waveobj.TaskGroup, task *waveobj.TaskNode, owner *waveobj.Run) string {
	var b strings.Builder
	if task.RunSpec.Goal != "" {
		b.WriteString(task.RunSpec.Goal)
	} else if task.Label != "" {
		b.WriteString(task.Label)
	} else {
		fmt.Fprintf(&b, "task %s of %q", task.ID, owner.Goal)
	}
	if task.Description != "" {
		b.WriteString("\n\n")
		b.WriteString(task.Description)
	}
	if task.StackedOn != "" {
		label := task.StackedOn
		if pred := taskByID(g, task.StackedOn); pred != nil && pred.Label != "" {
			label = pred.Label
		}
		fmt.Fprintf(&b, "\n\nThis working tree already contains the finished work of task %s (%s); build on it rather than re-deriving it.", task.StackedOn, label)
	}
	b.WriteString("\n\n")
	b.WriteString(HeadlessContract)
	return b.String()
}
```

- [ ] **Step 6: Run the tests to verify they pass**

```powershell
go test ./pkg/orchestrate/ -run "TestScheduleStacksChainStep|TestScheduleJoinWaits|TestTaskPrompt" -count=1 -v
```
Expected: PASS.

- [ ] **Step 7: Run the whole package**

```powershell
go test ./pkg/orchestrate/ -count=1
```
Expected: `ok`.

- [ ] **Step 8: Commit**

```bash
git add pkg/orchestrate/engine.go pkg/orchestrate/engine_test.go
git commit -m "feat(orchestrate): spawn a chain step from its predecessor's branch tip"
```

---

### Task 4: Refuse retry of a task with a live stacked successor

**Files:**
- Modify: `pkg/orchestrate/mutation.go:170-176` (the `"retry"` case in `applyActionLocked`)
- Test: `pkg/orchestrate/mutation_test.go`

**Interfaces:**
- Consumes: `stackedSuccessor` (Task 2), `taskByID` (`engine.go`), `RetryTask` (`scheduler.go`).
- Produces: no new symbols. `retry` on a task with a live stacked successor now returns an error naming the successor.

- [ ] **Step 1: Write the failing test**

Add to `pkg/orchestrate/mutation_test.go`:

```go
// TestRetryRefusedOnTaskWithStackedSuccessor: a stacked successor's branch was cut from this task's
// branch. Rebuilding this tree would strand it, so the successor is the one to retry (or skip first).
func TestRetryRefusedOnTaskWithStackedSuccessor(t *testing.T) {
	ctx := context.Background()
	ch, err := wstore.CreateChannel(ctx, "retry-stacked", t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	owner := jarvis.NewRun("owner goal", "ws-1", ch.ProjectPath, nil, jarvis.RunMode_Orchestrator, jarvis.DefaultOrchestratorPlaybook(false), 1)
	if err := wstore.AppendRun(ctx, ch.OID, owner); err != nil {
		t.Fatal(err)
	}
	g, err := NewTaskGroup(owner.ID, ch.OID, "g", 2, true, []waveobj.TaskNode{
		{ID: "t-0", Label: "a"},
		{ID: "t-1", Label: "b", Deps: []string{"t-0"}},
	}, 1, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := wstore.AppendDag(ctx, &g); err != nil {
		t.Fatal(err)
	}
	if err := wstore.UpdateDag(ctx, g.OID, func(cur *waveobj.TaskGroup) error {
		cur.Tasks[0].State = TaskState_Done
		cur.Tasks[0].RunID = "run-t-0"
		cur.Tasks[1].State = TaskState_Failed
		cur.Tasks[1].RunID = ""
		cur.Tasks[1].StackedOn = "t-0"
		RecomputeDagStatus(cur)
		return nil
	}); err != nil {
		t.Fatal(err)
	}

	err = ApplyAction(ctx, g.OID, "t-0", "retry", waveobj.RoutePin{})
	if err == nil || !strings.Contains(err.Error(), "stacked successor t-1") {
		t.Fatalf("retry error = %v, want a refusal naming t-1", err)
	}
	stored, gerr := wstore.GetDag(ctx, g.OID)
	if gerr != nil {
		t.Fatal(gerr)
	}
	if stored.Tasks[0].State != TaskState_Done {
		t.Fatalf("refused retry must not touch the task, got %s", stored.Tasks[0].State)
	}

	// skipping the successor releases the predecessor for retry
	if err := wstore.UpdateDag(ctx, g.OID, func(cur *waveobj.TaskGroup) error {
		cur.Tasks[1].State = TaskState_Skipped
		RecomputeDagStatus(cur)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	fresh, gerr := wstore.GetDag(ctx, g.OID)
	if gerr != nil {
		t.Fatal(gerr)
	}
	if succ := stackedSuccessor(fresh, taskByID(fresh, "t-0")); succ != nil {
		t.Fatalf("a skipped successor must not block retry, still saw %q", succ.ID)
	}
}

// TestRetryTaskPreservesStackedOn: a retried chain step is rebuilt from the same predecessor's tip,
// so the record it was spawned with has to survive the reset.
func TestRetryTaskPreservesStackedOn(t *testing.T) {
	g, err := NewTaskGroup("run-1", "ch-1", "g", 2, true, []waveobj.TaskNode{
		{ID: "t-0", Label: "a"},
		{ID: "t-1", Label: "b", Deps: []string{"t-0"}},
	}, 1000, nil)
	if err != nil {
		t.Fatal(err)
	}
	g.Tasks[1].State = TaskState_Failed
	g.Tasks[1].RunID = "run-t-1"
	g.Tasks[1].StackedOn = "t-0"
	if err := RetryTask(&g, "t-1"); err != nil {
		t.Fatal(err)
	}
	if g.Tasks[1].State != TaskState_Pending || g.Tasks[1].RunID != "" {
		t.Fatalf("retry must reopen the task for spawn: %+v", g.Tasks[1])
	}
	if g.Tasks[1].StackedOn != "t-0" {
		t.Fatalf("retry cleared stackedon: %q", g.Tasks[1].StackedOn)
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

```powershell
go test ./pkg/orchestrate/ -run "TestRetryRefusedOnTaskWithStackedSuccessor|TestRetryTaskPreservesStackedOn" -count=1
```
Expected: FAIL — `retry error = <nil>, want a refusal naming t-1`. (`TestRetryTaskPreservesStackedOn` should already pass; it is a regression net for a field `RetryTask` must not start clearing.)

- [ ] **Step 3: Add the refusal**

In `pkg/orchestrate/mutation.go`, replace the `"retry"` case in `applyActionLocked` with:

```go
	case "retry":
		task := taskByID(g, taskID)
		if task == nil {
			return fmt.Errorf("no task %q", taskID)
		}
		// a stacked successor's branch was cut from this task's branch; rebuilding this tree would
		// strand it, so the successor is the one to move.
		if succ := stackedSuccessor(g, task); succ != nil {
			return fmt.Errorf("task %s has stacked successor %s; retry %s, or skip it first", taskID, succ.ID, succ.ID)
		}
		if err := cancelAndStopTaskRun(ctx, g, taskID); err != nil {
			return err
		}
		if err := RetryTask(g, taskID); err != nil {
			return err
		}
```

- [ ] **Step 4: Run the tests to verify they pass**

```powershell
go test ./pkg/orchestrate/ -run "TestRetryRefusedOnTaskWithStackedSuccessor|TestRetryTaskPreservesStackedOn" -count=1 -v
```
Expected: PASS.

- [ ] **Step 5: Run the whole package**

```powershell
go test ./pkg/orchestrate/ -count=1
```
Expected: `ok`.

- [ ] **Step 6: Commit**

```bash
git add pkg/orchestrate/mutation.go pkg/orchestrate/mutation_test.go
git commit -m "fix(orchestrate): refuse retry of a task a live successor is stacked on"
```

---

### Task 5: Tips-only merge-ready, and a total `buildNext`

**Files:**
- Modify: `pkg/orchestrate/digest.go` — `buildCounts` (185-211), delete `mergeReadyBlocking` + `depChainReachesMergeReady` (251-289), `buildNext` (291-335), `mergeReadyIDs` (382-391), `taskHumanActions` (524-536), `taskMergeState` (538-552)
- Modify: `pkg/wshrpc/wshrpctypes_dag.go:121-141` (enum comments)
- Test: `pkg/orchestrate/digest_test.go`

**Interfaces:**
- Consumes: `isLaneTip` (Task 2).
- Produces:
  - `DagNextStep.Kind` gains `"cleanup-wait"` (TaskIds = the tasks owing worktree removal, no Actions).
  - `DagTaskDigest.MergeState` gains `"stacked"`.
  - `mergeReadyIDs(g)` now returns lane tips only; `DagStatusCounts.MergeReady` counts tips only.
  - Task 8 (CLI) and Task 9 (frontend) consume both new enum values.

- [ ] **Step 1: Write the failing tests**

In `pkg/orchestrate/digest_test.go`, **replace** `TestNextMergeReadyNoBlocker` — the behaviour it pins is the flat-DAG defect this task closes:

```go
// TestNextMergeReadyFlatDag: a finished task that blocks nobody is still the lead's move — landing
// it is what finishes the dag. Before this, buildNext fell through to a bare terminal on a running
// dag and `dag wait` printed the nonsense stop signal `terminal:healthy`.
func TestNextMergeReadyFlatDag(t *testing.T) {
	g := digestGroup(t, true, plainTasks()) // no deps: t-0 unmerged blocks nothing
	setTaskStates(g, map[string]string{"t-0": TaskState_Done})
	d := BuildDigest(digestSnapshot(g, nil, nil, nil, digestNow))
	if d.Next.Kind != "merge-ready" {
		t.Fatalf("a merge-ready task must be reported even when it blocks nobody, got %q", d.Next.Kind)
	}
	if !reflect.DeepEqual(d.Next.Actions, []string{"resolve-merge"}) {
		t.Fatalf("merge-ready must carry resolve-merge, got %+v", d.Next.Actions)
	}
}
```

And add:

```go
// TestNextMergeReadyIsTipsOnly: a lane lands as a unit at its tip, so only the tip is offered.
func TestNextMergeReadyIsTipsOnly(t *testing.T) {
	g := digestGroup(t, true, chainTasks())
	setTaskStates(g, map[string]string{"t-0": TaskState_Done, "t-1": TaskState_Done, "t-2": TaskState_Done})
	g.Tasks[1].StackedOn = "t-0"
	g.Tasks[2].StackedOn = "t-1"
	d := BuildDigest(digestSnapshot(g, nil, nil, nil, digestNow))
	if d.Next.Kind != "merge-ready" || !reflect.DeepEqual(d.Next.TaskIds, []string{"t-2"}) {
		t.Fatalf("merge-ready must name the lane tip only, got kind %q ids %+v", d.Next.Kind, d.Next.TaskIds)
	}
	if d.Counts.MergeReady != 1 {
		t.Fatalf("merge-ready count must be tips only, got %d", d.Counts.MergeReady)
	}
	if td := taskDigestByID(d, "t-1"); td.MergeState != "stacked" || len(td.HumanActions) != 0 {
		t.Fatalf("a stacked step is not independently mergeable: %+v", td)
	}
	if td := taskDigestByID(d, "t-2"); td.MergeState != "ready" || !reflect.DeepEqual(td.HumanActions, []string{"resolve-merge"}) {
		t.Fatalf("the tip must be the mergeable node: %+v", td)
	}
}

// TestNextCleanupWait: every task merged with worktree removal still owed is a running dag doing
// real work, not a terminal one. It must report that, and `dag wait` must keep blocking on it.
func TestNextCleanupWait(t *testing.T) {
	g := digestGroup(t, true, plainTasks())
	setTaskStates(g, map[string]string{"t-0": TaskState_Done, "t-1": TaskState_Done, "t-2": TaskState_Done})
	for i := range g.Tasks {
		g.Tasks[i].Merged = true
		g.Tasks[i].CleanupPending = true
	}
	RecomputeDagStatus(g)
	d := BuildDigest(digestSnapshot(g, nil, nil, nil, digestNow))
	if d.Next.Kind != "cleanup-wait" {
		t.Fatalf("cleanup debt on a running dag must report cleanup-wait, got %q", d.Next.Kind)
	}
	if len(d.Next.Actions) != 0 {
		t.Fatalf("cleanup-wait is engine work, not a human action: %+v", d.Next.Actions)
	}
	if !reflect.DeepEqual(d.Next.TaskIds, []string{"t-0", "t-1", "t-2"}) {
		t.Fatalf("cleanup-wait must name the tasks owing removal, got %+v", d.Next.TaskIds)
	}
}
```

Add this helper near the top of `digest_test.go` (after `chainTasks`):

```go
// taskDigestByID picks one task row out of a built digest.
func taskDigestByID(d wshrpc.DagStatusDigest, id string) wshrpc.DagTaskDigest {
	for _, td := range d.Tasks {
		if td.TaskId == id {
			return td
		}
	}
	return wshrpc.DagTaskDigest{}
}
```

Ensure `reflect` is imported in `digest_test.go`.

- [ ] **Step 2: Run the tests to verify they fail**

```powershell
go test ./pkg/orchestrate/ -run "TestNextMergeReadyFlatDag|TestNextMergeReadyIsTipsOnly|TestNextCleanupWait" -count=1
```
Expected: FAIL — `got "dispatch"` for the flat DAG, `got "terminal"` for cleanup-wait, and a merge-state mismatch on t-1.

- [ ] **Step 3: Make merge-ready mean lane tips**

In `pkg/orchestrate/digest.go`:

Replace `mergeReadyIDs`:

```go
// mergeReadyIDs returns the lane tips the lead can land, in dag order. A lane lands as a unit at its
// tip, so a stacked step is never offered on its own.
func mergeReadyIDs(g *waveobj.TaskGroup) []string {
	var ids []string
	for i := range g.Tasks {
		if isLaneTip(g, &g.Tasks[i]) {
			ids = append(ids, g.Tasks[i].ID)
		}
	}
	return ids
}
```

In `buildCounts`, inside `case TaskState_Done:`, replace:

```go
			if g.MergeRequired && !t.Merged && (!t.Gate || t.Released) {
				c.MergeReady++
			}
```

with:

```go
			if isLaneTip(g, t) {
				c.MergeReady++
			}
```

In `taskHumanActions`, replace the last case:

```go
	case t.State == TaskState_Done && g.MergeRequired && !t.Merged && (!t.Gate || t.Released):
		return digestActionResolveMerge
```

with:

```go
	case isLaneTip(g, t):
		return digestActionResolveMerge
```

Replace `taskMergeState`:

```go
func taskMergeState(g *waveobj.TaskGroup, t *waveobj.TaskNode) string {
	if !g.MergeRequired {
		return "not-required"
	}
	if t.Merged {
		return "merged"
	}
	if t.State == TaskState_BlockedMerge {
		return "blocked"
	}
	if t.State == TaskState_Done && (!t.Gate || t.Released) {
		if isLaneTip(g, t) {
			return "ready"
		}
		// finished, but its lane lands at a later step
		return "stacked"
	}
	return "waiting"
}
```

- [ ] **Step 4: Make `buildNext` total**

In `pkg/orchestrate/digest.go`, delete `mergeReadyBlocking` and `depChainReachesMergeReady` entirely (they are the flat-DAG defect, and a finished lane blocks nobody by design).

Replace step 2 of `buildNext`:

```go
	// 2. merge-ready work that blocks successors (merge-required dags only)
	if blocked := mergeReadyBlocking(g); len(blocked) > 0 {
		ids := mergeReadyIDs(g)
		return wshrpc.DagNextStep{Kind: "merge-ready", TaskIds: ids, Actions: digestActionResolveMerge}
	}
```

with:

```go
	// 2. merge-ready lane tips (merge-required dags only). Landing a finished lane is the lead's move
	// whether or not anything is waiting on it — on a flat dag it is what finishes the run.
	if ids := mergeReadyIDs(g); len(ids) > 0 {
		return wshrpc.DagNextStep{Kind: "merge-ready", TaskIds: ids, Actions: digestActionResolveMerge}
	}
```

Then insert a new step between the dependency-wait step and the terminal step:

```go
	// 6. cleanup wait: the content landed and worktree removal is still owed. Reaching here already
	// proves nothing needs attention, nothing can dispatch, nothing is busy and nothing waits on a
	// dependency (a cleanup error is attention and was caught at step 1) — so this is what the engine
	// is doing, and it is the last path by which a running dag could have reported a bare terminal.
	if ids := cleanupPendingIDs(g); len(ids) > 0 {
		return wshrpc.DagNextStep{Kind: "cleanup-wait", TaskIds: ids}
	}
	// 7. terminal
```

(renumber the existing `// 6. terminal` comment to `// 7. terminal`), and add the helper beside `failedCleanupIDs`:

```go
func cleanupPendingIDs(g *waveobj.TaskGroup) []string {
	var ids []string
	for i := range g.Tasks {
		if g.Tasks[i].CleanupPending {
			ids = append(ids, g.Tasks[i].ID)
		}
	}
	return ids
}
```

- [ ] **Step 5: Update the wire-type enum comments**

In `pkg/wshrpc/wshrpctypes_dag.go`:

```go
	Kind            string   `json:"kind"` // human-action | merge-ready | dispatch | parallelism-wait | dependency-wait | cleanup-wait | terminal
```

```go
	MergeState      string   `json:"mergestate"`   // not-required | waiting | stacked | ready | blocked | merged
```

- [ ] **Step 6: Run the tests to verify they pass**

```powershell
go test ./pkg/orchestrate/ -run "TestNextMergeReadyFlatDag|TestNextMergeReadyIsTipsOnly|TestNextCleanupWait" -count=1 -v
```
Expected: PASS.

- [ ] **Step 7: Run the whole package**

```powershell
go test ./pkg/orchestrate/ -count=1
```
Expected: `ok`. `TestNextMergeReady` (the chain case) still passes: t-0 done and unmerged with no `StackedOn` on t-1 is a tip.

- [ ] **Step 8: Commit**

```bash
git add pkg/orchestrate/digest.go pkg/orchestrate/digest_test.go pkg/wshrpc/wshrpctypes_dag.go
git commit -m "fix(orchestrate): report merge-ready lane tips and never a bare terminal"
```

---

### Task 6: Land a lane with one merge

**Files:**
- Modify: `pkg/wshrpc/wshserver/wshserver_dag.go` — `persistMergedTask` (290-315), `DagMergeCommand` (452-518), `DagMergeContinueCommand` (523-578)
- Test: `pkg/wshrpc/wshserver/wshserver_dag_test.go`

**Interfaces:**
- Consumes: `orchestrate.LaneTipFor`, `orchestrate.LaneTasks` (Task 2); the engine's stacked spawn (Task 3).
- Produces: `func laneMergeMessage(g *waveobj.TaskGroup, tip *waveobj.TaskNode) string` (unexported, this file). Merging a non-tip returns an error containing `is stacked under <tip-id>; merge <tip-id> to land the lane`.

- [ ] **Step 1: Write the failing tests**

Add to `pkg/wshrpc/wshserver/wshserver_dag_test.go`:

```go
// seedStackedLane drives the real engine to a two-step lane: t-0 done with a commit in its tree, t-1
// spawned stacked on it with a commit of its own. Returns the channel, the owning run, and the dag.
func seedStackedLane(t *testing.T) (context.Context, *waveobj.Channel, waveobj.Run, *waveobj.TaskGroup, string) {
	t.Helper()
	ctx := context.Background()
	projectDir := t.TempDir()
	git := func(dir string, args ...string) string {
		out, err := exec.Command("git", append([]string{"-C", dir}, args...)...).CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
		return strings.TrimSpace(string(out))
	}
	git(projectDir, "init", "-b", "main")
	git(projectDir, "config", "user.email", "t@test")
	git(projectDir, "config", "user.name", "t")
	if err := os.WriteFile(filepath.Join(projectDir, "base.txt"), []byte("base\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	git(projectDir, "add", ".")
	git(projectDir, "commit", "-m", "base")

	ch, err := wstore.CreateChannel(ctx, "dag-lane", projectDir)
	if err != nil {
		t.Fatal(err)
	}
	run := jarvis.NewRun("lane goal", "ws-1", ch.ProjectPath, nil, jarvis.RunMode_Orchestrator, jarvis.DefaultOrchestratorPlaybook(false), 1)
	run.Status = jarvis.RunStatus_Planning
	run.BaseCommit = git(projectDir, "rev-parse", "HEAD")
	if err := wstore.AppendRun(ctx, ch.OID, run); err != nil {
		t.Fatal(err)
	}
	oldSpawn := jarvis.SpawnRunWorker
	jarvis.SpawnRunWorker = func(context.Context, runroute.Capability, string, string, string, string, jarvis.RunWorkerOptions) (string, error) {
		tabId := uuid.NewString()
		blockId := uuid.NewString()
		_ = wstore.DBInsert(ctx, &waveobj.Tab{OID: tabId, BlockIds: []string{blockId}})
		_ = wstore.DBInsert(ctx, &waveobj.Block{OID: blockId, ParentORef: "tab:" + tabId})
		return "tab:" + tabId, nil
	}
	t.Cleanup(func() { jarvis.SpawnRunWorker = oldSpawn })

	ws := &WshServer{}
	g, err := ws.DagSubmitCommand(ctx, wshrpc.CommandDagSubmitData{
		ChannelId: ch.OID, RunId: run.ID, Title: "lane", Parallelism: 2,
		Tasks: []waveobj.TaskNode{
			{ID: "t-0", Label: "step one"},
			{ID: "t-1", Label: "step two", Deps: []string{"t-0"}},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	commitIn := func(taskID, file string) string {
		wt := filepath.Join(projectDir, ".waveterm", "worktrees", orchestrate.TaskWorktreeKey(run.ID, taskID))
		if err := os.WriteFile(filepath.Join(wt, file), []byte(file+"\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		git(wt, "add", ".")
		git(wt, "commit", "-m", file)
		return git(wt, "rev-parse", "HEAD")
	}
	end0 := commitIn("t-0", "one.txt")
	child0 := g.Tasks[0].RunID
	if err := wstore.UpdateRun(ctx, ch.OID, child0, func(r *waveobj.Run) error {
		r.Status = jarvis.RunStatus_Done
		r.EndCommit = end0
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if err := orchestrate.Schedule(ctx, g.OID); err != nil {
		t.Fatal(err)
	}
	fresh, err := wstore.GetDag(ctx, g.OID)
	if err != nil {
		t.Fatal(err)
	}
	if fresh.Tasks[1].StackedOn != "t-0" || fresh.Tasks[1].RunID == "" {
		t.Fatalf("engine must stack t-1 on t-0: %+v", fresh.Tasks[1])
	}
	commitIn("t-1", "two.txt")
	if err := wstore.UpdateRun(ctx, ch.OID, fresh.Tasks[1].RunID, func(r *waveobj.Run) error {
		r.Status = jarvis.RunStatus_Done
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if err := orchestrate.Schedule(ctx, g.OID); err != nil {
		t.Fatal(err)
	}
	final, err := wstore.GetDag(ctx, g.OID)
	if err != nil {
		t.Fatal(err)
	}
	return ctx, ch, run, final, projectDir
}

// TestDagMergeLandsWholeLane: one squash brings both steps onto the project branch, stamps every
// lane task merged with cleanup owed, and names both steps in the commit message.
func TestDagMergeLandsWholeLane(t *testing.T) {
	ctx, ch, run, g, projectDir := seedStackedLane(t)
	ws := &WshServer{}
	nonTipEnd := ""
	if child, err := wstore.GetRun(ctx, ch.OID, g.Tasks[0].RunID); err == nil {
		nonTipEnd = child.EndCommit
	}

	if err := ws.DagMergeCommand(ctx, wshrpc.CommandDagMergeData{ChannelId: ch.OID, RunId: run.ID, TaskId: "t-1"}); err != nil {
		t.Fatalf("merge: %v", err)
	}
	for _, f := range []string{"one.txt", "two.txt"} {
		if _, err := os.Stat(filepath.Join(projectDir, f)); err != nil {
			t.Fatalf("one squash must land the whole lane, %s missing: %v", f, err)
		}
	}
	merged, err := wstore.GetDag(ctx, g.OID)
	if err != nil {
		t.Fatal(err)
	}
	for i := range merged.Tasks {
		if !merged.Tasks[i].Merged {
			t.Fatalf("landing the tip must stamp every lane task merged, %s did not", merged.Tasks[i].ID)
		}
	}
	// the tip's tree is removed by the merge; the predecessor's is swept by a later tick
	if !merged.Tasks[0].CleanupPending {
		t.Fatal("a non-tip lane task must be left owing worktree removal")
	}
	msg := strings.TrimSpace(gitOut(t, projectDir, "log", "-1", "--pretty=%s"))
	if !strings.Contains(msg, "step one / step two") {
		t.Fatalf("lane commit message must list the steps in order, got %q", msg)
	}
	tipChild, err := wstore.GetRun(ctx, ch.OID, merged.Tasks[1].RunID)
	if err != nil {
		t.Fatal(err)
	}
	if len(tipChild.EndCommit) != 40 {
		t.Fatalf("the tip's child must record the squash sha, got %q", tipChild.EndCommit)
	}
	nonTipChild, err := wstore.GetRun(ctx, ch.OID, merged.Tasks[0].RunID)
	if err != nil {
		t.Fatal(err)
	}
	if nonTipChild.EndCommit != nonTipEnd {
		t.Fatalf("a non-tip child must keep the commit it reported at complete: %q, want %q", nonTipChild.EndCommit, nonTipEnd)
	}

	// the pending predecessor tree is removed by the next schedule tick
	if err := orchestrate.Schedule(ctx, g.OID); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"t-0", "t-1"} {
		wt := filepath.Join(projectDir, ".waveterm", "worktrees", orchestrate.TaskWorktreeKey(run.ID, id))
		if _, err := os.Stat(wt); !os.IsNotExist(err) {
			t.Fatalf("worktree for %s must be gone after the lane lands: %v", id, err)
		}
	}
}

// TestDagMergeRefusesNonTip: a stacked step is landed by its lane's tip, never on its own — and the
// refusal has to name the id the lead should use instead.
func TestDagMergeRefusesNonTip(t *testing.T) {
	ctx, ch, run, g, _ := seedStackedLane(t)
	ws := &WshServer{}
	err := ws.DagMergeCommand(ctx, wshrpc.CommandDagMergeData{ChannelId: ch.OID, RunId: run.ID, TaskId: "t-0"})
	if err == nil || !strings.Contains(err.Error(), "stacked under t-1") || !strings.Contains(err.Error(), "merge t-1") {
		t.Fatalf("non-tip merge error = %v, want a refusal naming t-1", err)
	}
	// skipping the last step hands the tip back to its predecessor
	if err := wstore.UpdateDag(ctx, g.OID, func(cur *waveobj.TaskGroup) error {
		cur.Tasks[1].State = orchestrate.TaskState_Skipped
		orchestrate.RecomputeDagStatus(cur)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if err := ws.DagMergeCommand(ctx, wshrpc.CommandDagMergeData{ChannelId: ch.OID, RunId: run.ID, TaskId: "t-0"}); err != nil {
		t.Fatalf("a skipped last step must make its predecessor mergeable: %v", err)
	}
}

// gitOut runs one git command in dir and returns its trimmed output.
func gitOut(t *testing.T, dir string, args ...string) string {
	t.Helper()
	out, err := exec.Command("git", append([]string{"-C", dir}, args...)...).CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
	return strings.TrimSpace(string(out))
}
```

- [ ] **Step 2: Run the tests to verify they fail**

```powershell
go test ./pkg/wshrpc/wshserver/ -run "TestDagMergeLandsWholeLane|TestDagMergeRefusesNonTip" -count=1
```
Expected: FAIL — the non-tip merge succeeds instead of being refused, and only `t-1` is stamped merged.

- [ ] **Step 3: Refuse a non-tip and build the lane message**

In `pkg/wshrpc/wshserver/wshserver_dag.go`, add beside `findTaskNode`:

```go
// laneMergeMessage joins the lane's labels in lane order. One squash lands the whole chain, so the
// message has to name every step it carries; finishMerge caps the result.
func laneMergeMessage(g *waveobj.TaskGroup, tip *waveobj.TaskNode) string {
	var parts []string
	for _, task := range orchestrate.LaneTasks(g, tip) {
		if task.Label != "" {
			parts = append(parts, task.Label)
		} else {
			parts = append(parts, task.ID)
		}
	}
	return strings.Join(parts, " / ")
}
```

In `DagMergeCommand`, after the `if task.RunID == ""` check and before loading the child, insert:

```go
	// a lane lands as a unit at its tip: the successor's branch descends from this one, so squashing
	// here would land work the successor's own squash would then re-land.
	if tip := orchestrate.LaneTipFor(g, task); tip.ID != task.ID {
		return fmt.Errorf("task %s is stacked under %s; merge %s to land the lane", data.TaskId, tip.ID, tip.ID)
	}
```

Then replace, in the same function:

```go
	// commit message should be the task label, not the full child goal
	// (which embeds plan description + headless contract).
	mergeMsg := task.Label
	if mergeMsg == "" {
		mergeMsg = task.ID
	}
```

with:

```go
	// commit message lists the lane's labels, not the full child goal (which embeds plan
	// description + headless contract).
	mergeMsg := laneMergeMessage(g, task)
```

- [ ] **Step 4: Mirror both changes in `DagMergeContinueCommand`**

In `DagMergeContinueCommand`, after its `if task.RunID == ""` check, insert the identical tip refusal:

```go
	if tip := orchestrate.LaneTipFor(g, task); tip.ID != task.ID {
		return fmt.Errorf("task %s is stacked under %s; merge %s to land the lane", data.TaskId, tip.ID, tip.ID)
	}
```

and replace its:

```go
	mergeMsg := task.Label
	if mergeMsg == "" {
		mergeMsg = task.ID
	}
```

with:

```go
	mergeMsg := laneMergeMessage(g, task)
```

- [ ] **Step 5: Stamp the whole lane in the one dag update**

In `persistMergedTask`, replace the `wstore.UpdateDag` mutator body:

```go
		return wstore.UpdateDag(txCtx, dagID, func(cur *waveobj.TaskGroup) error {
			tip := findTaskNode(cur, taskID)
			if tip == nil {
				return fmt.Errorf("no task %q", taskID)
			}
			// one merge lands the whole lane, so every step on the walk is merged and now owes its
			// worktree. Only the tip's tree is removed here; the rest are swept by the next tick's
			// RetryPendingCleanup.
			for _, task := range orchestrate.LaneTasks(cur, tip) {
				task.Merged = true
				task.CleanupPending = true
				task.CleanupError = ""
			}
			orchestrate.RecomputeDagStatus(cur)
			return nil
		})
```

- [ ] **Step 6: Run the tests to verify they pass**

```powershell
go test ./pkg/wshrpc/wshserver/ -run "TestDagMerge" -count=1 -v
```
Expected: PASS, including the pre-existing `TestDagMergeTargetsChildWorktree`, `TestDagMergeContinueFinishesBlockedMerge` and `TestDagMergeCleanupFailurePersistsDebt` (a lane of one still produces its own label as the message).

- [ ] **Step 7: Run both packages**

```powershell
go test ./pkg/wshrpc/wshserver/ ./pkg/orchestrate/ -count=1
```
Expected: `ok` for both.

- [ ] **Step 8: Commit**

```bash
git add pkg/wshrpc/wshserver/wshserver_dag.go pkg/wshrpc/wshserver/wshserver_dag_test.go
git commit -m "feat(dag): land a stacked lane as one squash at its tip"
```

---

### Task 7: Teach the lead the chain rule

**Files:**
- Modify: `pkg/jarvis/run.go` — `buildEngineOrchestratePrompt`, the line beginning "A Git-backed dependent task stays pending"
- Test: `pkg/jarvis/run_test.go` (`TestBuildOrchestratePromptEngine`, `TestBuildOrchestratePromptAdaptive`)

**Interfaces:**
- Consumes: the digest vocabulary fixed in Task 5 (`merge-ready`).
- Produces: no symbols. The engine prompt now states the chain rule and uses the digest's own words, closing tracker item F20.

- [ ] **Step 1: Write the failing tests**

In `pkg/jarvis/run_test.go`, extend the `want` list inside `TestBuildOrchestratePromptEngine` for the claude prompt with the new vocabulary:

```go
	claude := BuildOrchestratePrompt("do X", principles, "claude", Orchestration_Engine)
	for _, want := range []string{
		"do X", "be clean", "dag submit --file", "wsh jarvis dag wait", "terminal:",
		"wsh jarvis dag merge", "AskUserQuestion", "16 tasks", "one DAG", "wsh jarvis complete",
		"one chain in plan order", "merge-ready", "several dependencies",
	} {
```

and add, at the end of that same test:

```go
	// F20: the prompt must speak the digest's words, never a vocabulary of its own
	if strings.Contains(claude, "the digest reports `merge`,") {
		t.Fatalf("the prompt must use the digest's merge-ready vocabulary:\n%s", claude)
	}
	for _, want := range []string{"one chain in plan order", "merge-ready"} {
		if !strings.Contains(pi, want) {
			t.Fatalf("pi engine prompt missing %q:\n%s", want, pi)
		}
	}
```

In `TestBuildOrchestratePromptAdaptive`, add inside the loop, after the existing engine-leak guard:

```go
		if strings.Contains(p, "merge-ready") || strings.Contains(p, "dag merge") {
			t.Fatalf("orch=%q: adaptive prompt must not mention the merge gate:\n%s", orch, p)
		}
```

- [ ] **Step 2: Run the tests to verify they fail**

```powershell
go test ./pkg/jarvis/ -run TestBuildOrchestratePrompt -count=1
```
Expected: FAIL — `claude engine prompt missing "one chain in plan order"`.

- [ ] **Step 3: Replace the merge line**

In `pkg/jarvis/run.go`, inside `buildEngineOrchestratePrompt`, replace:

```go
	b.WriteString("A Git-backed dependent task stays pending until each predecessor is merged; when the digest reports `merge`, run `wsh jarvis dag merge <task-id>` with the reported id after reviewing that finished child, so its successors start from the integrated project HEAD.\n")
```

with:

```go
	b.WriteString("Tasks that edit a common file form one chain in plan order: each depends only on the task before it. The engine runs a chain stacked — every step starts in a tree that already holds the previous step's commits — and you merge only the chain's last task: when the digest reports `merge-ready`, run `wsh jarvis dag merge <task-id>` with the reported id, and the whole chain lands. A task with several dependencies waits until each of them is merged. Choose per chain: one node per step when the steps are substantial (each step is a fresh worker with fresh context), or one node for a whole chain of small steps, listing the steps in order in that node's description.\n")
```

- [ ] **Step 4: Run the tests to verify they pass**

```powershell
go test ./pkg/jarvis/ -run TestBuildOrchestratePrompt -count=1 -v
```
Expected: PASS, including the adaptive test (the line lives only in the engine branch, so the adaptive prompt is unchanged).

- [ ] **Step 5: Commit**

```bash
git add pkg/jarvis/run.go pkg/jarvis/run_test.go
git commit -m "docs(jarvis): state the chain rule in the lead's engine prompt"
```

---

### Task 8: Show a stacked step in `dag status`, and keep `dag wait` blocking on cleanup

**Files:**
- Modify: `cmd/wsh/cmd/wshcmd-jarvisdag.go:246-265` (`dagStatusLines`)
- Test: `cmd/wsh/cmd/wshcmd-jarvisdag_test.go`

**Interfaces:**
- Consumes: `waveobj.TaskNode.StackedOn` (Task 1), the `cleanup-wait` kind (Task 5).
- Produces: no symbols. `dag status` shows `stacked on t-3` in the signal column. `waitDecision` is unchanged — the new test only pins that it keeps blocking on `cleanup-wait`.

- [ ] **Step 1: Write the failing tests**

Add to `cmd/wsh/cmd/wshcmd-jarvisdag_test.go`:

```go
// TestDagStatusLinesShowsStackedOn: a finished chain step reports why it is not independently
// mergeable, so the lead can see the lane without reading the graph.
func TestDagStatusLinesShowsStackedOn(t *testing.T) {
	g := &waveobj.TaskGroup{
		ID: "dag-1", Status: "running", Parallelism: 2,
		Tasks: []waveobj.TaskNode{
			{ID: "t-0", Label: "a", State: "done"},
			{ID: "t-1", Label: "b", State: "done", StackedOn: "t-0"},
		},
	}
	rtn := &wshrpc.CommandDagStatusRtnData{
		Group: g,
		Digest: wshrpc.DagStatusDigest{
			Counts: wshrpc.DagStatusCounts{Total: 2, Done: 2},
			Tasks: []wshrpc.DagTaskDigest{
				{TaskId: "t-0", MergeState: "stacked"},
				{TaskId: "t-1", MergeState: "ready", HumanActions: []string{"resolve-merge"}},
			},
		},
	}
	joined := strings.Join(dagStatusLines(rtn, 10_000), "\n")
	if !strings.Contains(joined, "stacked on t-0") {
		t.Fatalf("a stacked step must say what it is stacked on, got:\n%s", joined)
	}
}
```

And add two rows to the `cases` table in `TestWaitDecision`:

```go
		{
			name:       "cleanup wait keeps blocking",
			digest:     wshrpc.DagStatusDigest{Health: "healthy", Next: wshrpc.DagNextStep{Kind: "cleanup-wait", TaskIds: []string{"t-0"}}},
			wantReturn: false,
		},
```

- [ ] **Step 2: Run the tests to verify they fail**

```powershell
go test ./cmd/wsh/cmd/ -run "TestDagStatusLinesShowsStackedOn|TestWaitDecision" -count=1
```
Expected: FAIL — `a stacked step must say what it is stacked on`. (The `TestWaitDecision` row should already pass; it is the regression net for the rule that `waitDecision` must not be "fixed" alone.)

- [ ] **Step 3: Add the signal**

In `cmd/wsh/cmd/wshcmd-jarvisdag.go`, inside `dagStatusLines`, extend the signal chain:

```go
		signal := ""
		if td.AskSummary != "" {
			signal = "ask: " + compactText(td.AskSummary, 60)
		} else if td.FreshnessTs > 0 && (t.State == orchestrate.TaskState_Running || t.State == orchestrate.TaskState_Stalled) {
			signal = "idle " + compactDur(now-td.FreshnessTs)
		} else if t.StackedOn != "" {
			signal = "stacked on " + t.StackedOn
		}
```

- [ ] **Step 4: Run the tests to verify they pass**

```powershell
go test ./cmd/wsh/cmd/ -run "TestDagStatusLines|TestWaitDecision" -count=1 -v
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cmd/wsh/cmd/wshcmd-jarvisdag.go cmd/wsh/cmd/wshcmd-jarvisdag_test.go
git commit -m "feat(wsh): show a task's lane position in dag status"
```

---

### Task 9: Offer merge only on a tip in the cockpit

**Files:**
- Modify: `frontend/app/view/orchestrate/dagstore.ts:41-72` (`buildViewData`)
- Modify: `frontend/app/view/orchestrate/dagdigest.ts:54-71` (`nextStepText`)
- Test: `frontend/app/view/orchestrate/dagstore.test.ts`, `frontend/app/view/orchestrate/dagdigest.test.ts`

**Interfaces:**
- Consumes: the generated `TaskNode.stackedon?: string` (Task 1), the `cleanup-wait` next-step kind (Task 5).
- Produces: no exported symbols beyond the existing `buildViewData` / `nextStepText`. `DagViewNode.actions` no longer contains `merge` for a stacked step; `DagViewNode.meta` may carry `stacked on <id>`.

- [ ] **Step 1: Write the failing tests**

Add to `frontend/app/view/orchestrate/dagstore.test.ts`:

```ts
describe("stacked lanes", () => {
    const lane = {
        id: "dag-1",
        runid: "run-1",
        parallelism: 2,
        tasks: [
            { id: "t-0", label: "one", state: "done", runid: "r-0" },
            { id: "t-1", label: "two", deps: ["t-0"], state: "done", runid: "r-1", stackedon: "t-0" },
        ],
    } as any;

    it("offers merge on the lane tip only", () => {
        const { nodes } = buildViewData(lane, owner, harnesses);
        expect(nodes.find((n) => n.id === "t-0")!.actions).toEqual([]);
        expect(nodes.find((n) => n.id === "t-1")!.actions).toEqual(["merge"]);
    });

    it("returns merge to the predecessor when the last step is skipped", () => {
        const skipped = {
            ...lane,
            tasks: [lane.tasks[0], { ...lane.tasks[1], state: "skipped" }],
        } as any;
        const { nodes } = buildViewData(skipped, owner, harnesses);
        expect(nodes.find((n) => n.id === "t-0")!.actions).toEqual(["merge"]);
    });

    it("names the predecessor in the node meta line", () => {
        const { nodes } = buildViewData(lane, owner, harnesses);
        expect(nodes.find((n) => n.id === "t-1")!.meta).toBe("wave/r-1 · stacked on t-0");
    });
});
```

Add to `frontend/app/view/orchestrate/dagdigest.test.ts`, inside the existing `nextStepText` "renders each typed next kind deterministically" test:

```ts
        expect(nextStepText({ kind: "cleanup-wait" })).toBe("removing finished worktrees");
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx vitest run frontend/app/view/orchestrate/dagstore.test.ts frontend/app/view/orchestrate/dagdigest.test.ts
```
Expected: FAIL — `t-0` offers `["merge"]` while stacked, and `cleanup-wait` renders `"refreshing status"`.

- [ ] **Step 3: Gate the merge action on the tip**

In `frontend/app/view/orchestrate/dagstore.ts`, add above `buildViewData`:

```ts
// a lane lands as a unit at its tip: a step something live is still stacked on is merged by that
// successor, never on its own. Skipped and cancelled successors are abandoned and do not count.
const ABANDONED_STATES = new Set(["skipped", "cancelled"]);

function hasLiveStackedSuccessor(group: TaskGroup, id: string): boolean {
    return group.tasks.some((s) => s.stackedon === id && !ABANDONED_STATES.has(s.state));
}
```

Inside `buildViewData`'s `map`, replace:

```ts
        if (t.state === "done" && !t.gate && !t.merged) actions = ["merge"];
```

with:

```ts
        if (t.state === "done" && !t.gate && !t.merged && !hasLiveStackedSuccessor(group, t.id)) actions = ["merge"];
```

And replace the `meta` field:

```ts
            meta: t.runid ? `wave/${t.runid}` : "",
```

with:

```ts
            meta: [t.runid ? `wave/${t.runid}` : "", t.stackedon ? `stacked on ${t.stackedon}` : ""]
                .filter(Boolean)
                .join(" · "),
```

- [ ] **Step 4: Render the cleanup-wait kind**

In `frontend/app/view/orchestrate/dagdigest.ts`, add a case to `nextStepText` between `dependency-wait` and `terminal`:

```ts
        case "cleanup-wait":
            return "removing finished worktrees";
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
npx vitest run frontend/app/view/orchestrate/dagstore.test.ts frontend/app/view/orchestrate/dagdigest.test.ts
```
Expected: PASS.

- [ ] **Step 6: Typecheck and run the full frontend suite**

```bash
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit
npx vitest run
```
Expected: exit 0 from tsc; all vitest suites pass.

- [ ] **Step 7: Commit**

```bash
git add frontend/app/view/orchestrate/dagstore.ts frontend/app/view/orchestrate/dagstore.test.ts frontend/app/view/orchestrate/dagdigest.ts frontend/app/view/orchestrate/dagdigest.test.ts
git commit -m "feat(orchestrate-ui): offer merge on the lane tip and name the stacked predecessor"
```

---

### Task 10: Amend the observability spec and close the trackers

**Files:**
- Modify: `docs/superpowers/specs/2026-08-28-orchestrator-full-observability-design.md` (§5.3 numbered list around line 189-199; the `MergeState` prose at line 172; the `DagNextStep`/`DagTaskDigest` code block at lines 123 and 140)
- Modify: `docs/open-issues.md` (the two rows at lines 106-107 and the flat-DAG note at line 112)
- Modify: `docs/orchestrator-redesign-flaws.md` (rows F19 and F20 at lines 133-134)

**Interfaces:**
- Consumes: the shipped behaviour of Tasks 5-9.
- Produces: documentation only.

- [ ] **Step 1: Amend §5.3 of the observability spec**

Replace the numbered list under "### 5.3 Next-step semantics" with:

```markdown
1. required human action, ordered as answer, approve/send back, resolve merge, retry cleanup, then retry/skip/escalate;
2. merge-ready lane tips when `MergeRequired` is true;
3. tasks the scheduler can dispatch now;
4. parallelism wait on active tasks;
5. dependency wait, including blocking task IDs;
6. cleanup wait on tasks whose content has landed but whose worktrees are still being removed;
7. terminal state.
```

Add one sentence after the paragraph beginning "Within one condition, task IDs use DAG order":

```markdown
Step 2 fires whenever any lane tip is merge-ready, not only when a successor is blocked, and step 6 makes the ordering total: a running DAG never reports a bare terminal step.
```

- [ ] **Step 2: Amend the `MergeState` prose and the two type comments**

In the same file, in the `DagNextStep` code block, change the `Kind` comment to:

```go
    Kind            string   `json:"kind"` // human-action | merge-ready | dispatch | parallelism-wait | dependency-wait | cleanup-wait | terminal
```

In the `DagTaskDigest` code block, change the `MergeState` comment to:

```go
    MergeState      string   `json:"mergestate"`   // not-required | waiting | stacked | ready | blocked | merged
```

And in the prose sentence beginning "`MergeState` is `not-required` for non-merge DAGs", insert `stacked` between `waiting` and `ready`:

```markdown
`MergeState` is `not-required` for non-merge DAGs, `waiting` before a task becomes mergeable, `stacked` for a finished chain step whose lane lands at a later task, `ready` for done and released-when-gated work that is its lane's tip, `blocked` for a merge conflict, and `merged` after content integration persists.
```

- [ ] **Step 3: Close the tracker rows**

In `docs/open-issues.md`, mark the two rows resolved. Change the third column (or append to the notes column, matching the file's existing convention for closed rows) so both read as resolved by `docs/superpowers/plans/2026-09-04-stacked-lanes.md`, and replace the standalone **Flat-DAG merge gate never opens (2026-09-04)** note's fix-direction paragraph with a one-line resolution stating that `buildNext` now reports `merge-ready` whenever `mergeReadyIDs(g)` is non-empty, that a `cleanup-wait` step closes the other bare-terminal path, and that `waitDecision` was deliberately left untouched.

In `docs/orchestrator-redesign-flaws.md`, change the final `open` column of rows **F19** and **F20** to `resolved (2026-09-04, stacked lanes)`.

- [ ] **Step 4: Verify nothing else references the deleted behaviour**

```powershell
Select-String -Path docs/*.md,docs/superpowers/specs/*.md -Pattern "mergeReadyBlocking|blocks successors"
```
Expected: no hit outside the two tracker files' historical descriptions. Update any live spec text that still claims merge-ready requires a blocked successor.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/2026-08-28-orchestrator-full-observability-design.md docs/open-issues.md docs/orchestrator-redesign-flaws.md
git commit -m "docs(orchestrate): record lane tips, cleanup-wait, and close F19/F20"
```

---

### Task 11: Prove the wake loop closes over a lane, live

Every test above stays green on a digest the lead never reads. This is the only check that the lead actually drives a lane end to end.

**Files:**
- Create: `docs/jarvis-stacked-lanes-e2e.md` (beside `docs/jarvis-claude-lead-e2e.md`, same conventions: real values only, screenshots in the gitignored `cdp-shots/`)

**Interfaces:**
- Consumes: everything from Tasks 1-10, running in a real `task dev` app.
- Produces: the capture document.

- [ ] **Step 1: Build the backend and start the dev app**

```powershell
task build:backend
task dev
```
(If a prior dev tree was killed, free port 5174 first — Vite's node process outlives it.)

- [ ] **Step 2: Create the scratch repo**

Create a throwaway git repo outside this project (e.g. `C:\Users\cktra\IdeaProjects\lane-e2e-scratch`) with an initial commit and one small source file. Nothing real may be at risk.

- [ ] **Step 3: Start an engine orchestrator run whose plan has all three shapes**

In the cockpit, create a run with `mode=orchestrator`, `orchestration=engine`, `runtime=claude`, project = the scratch repo, and a goal that forces:
- one three-step chain, every step editing the same file (so the lead declares `t-1 → t-2 → t-3`);
- one independent task touching a different file;
- one final verify-and-commit task depending on the chain's last step and on the independent task.

- [ ] **Step 4: Watch the run to completion without intervening**

Let the lead drive. Do not merge, retry or answer anything the lead can handle itself.

- [ ] **Step 5: Assert the five facts**

Read each from a real source, not from memory:

1. **One merge per lane.** `git log --oneline` on the scratch repo's `main` shows exactly three squash commits (chain, independent task, join), not six. The chain's commit message lists all three step labels joined with ` / `.
2. **The chain ran on one branch.** The lead's scrollback shows `wsh jarvis dag merge` called once with the chain's last id, and `dag status` showed `stacked on t-N` for the two earlier steps.
3. **The join started from integrated HEAD.** The join child's `BaseCommit` (via `wsh jarvis dag status` / the run card) equals the sha after the last lane merge; its `stackedon` is empty.
4. **The lead's wake log shows only `action:merge-ready` and `terminal:done`.** No `terminal:healthy` on a running DAG, no bare `terminal`.
5. **No worktrees survive.** `<scratch>/.waveterm/worktrees/` is empty and `git branch --list "wave/*"` is empty.

- [ ] **Step 6: Write the capture**

Write `docs/jarvis-stacked-lanes-e2e.md` following `docs/jarvis-claude-lead-e2e.md`'s structure: header block (channel, project, base commit, run id, lead model, DAG id, task count, parallelism, outcome), the goal verbatim, a section per asserted fact with the real command output, and a "what did not work" section if anything did. If any of the five facts fails, **stop** — record the failure and fix it before claiming the change is done.

- [ ] **Step 7: Commit**

```bash
git add docs/jarvis-stacked-lanes-e2e.md
git commit -m "docs(orchestrate): capture a live lead driving a stacked lane end to end"
```

---

## Self-Review

**Spec coverage.** Every section of the spec maps to a task:

| Spec section | Task |
|---|---|
| §1 lane model (stacking rule, tip, walk, non-git) | 2 |
| §2 data (`StackedOn`, submit rejection, `SameDagProposal`, `task generate`) | 1 |
| §3 scheduler (`depSatisfied`) and spawn (per-task base, child prompt) | 2, 3 |
| §4 merge (tip refusal, lane message, lane stamping, continue mirror), cleanup sweep | 6 |
| §5 digest (tips-only, total `buildNext`, `cleanup-wait`, `stacked`), observability amendment, CLI, prompt, frontend | 5, 7, 8, 9, 10 |
| §6 failure paths (retry refusal; skip/escalate/sendback/cancel unchanged) | 4 |
| Testing table rows: stacking rule, `depSatisfied`, engine real-repo, merge, cleanup, digest, mutation, submit, prompt, frontend, live | 2, 2, 3, 6, 6, 5, 4, 1, 7, 9, 11 |

Deliberate deviations from the spec, both flagged in place:
- The lane helpers live in a new `pkg/orchestrate/lane.go` rather than in `scheduler.go` (file-per-concern, matching the rest of the package). No behaviour differs.
- Task 3 Step 4 also passes the stacked `base` to `childRunFromSpec`. The spec's §4 relies on this (evidence is sealed over the child's own `BaseCommit..EndCommit`) but its code snippet does not show the call; without it a stacked child's evidence would claim the whole lane.

Out-of-scope items from the spec are not implemented anywhere in this plan: declared lanes, early removal of a landed step's worktree, auto-landing clean merges, per-task cost stamps, F18, `waitDecision` tightening, and attribution over a removed worktree.

**Type consistency.** `StackedOn` (Go) / `stackedon` (json, TS) throughout. `depSatisfied(g, t, depID)` is introduced in Task 2 and every later reference uses that arity. `taskPrompt(g, task, owner)` is changed once, in Task 3, and its three existing test call sites are updated in the same task. `isLaneTip`/`stackedSuccessor`/`stackPredecessor` stay unexported and are used only inside `pkg/orchestrate` (Tasks 2, 3, 4, 5); `LaneTipFor`/`LaneTasks` are exported and used only by `pkg/wshrpc/wshserver` (Task 6). The new digest values are `"cleanup-wait"` (kind) and `"stacked"` (merge state), spelled identically in Go, the wire-type comments, the CLI test, the frontend, and the spec amendment.
