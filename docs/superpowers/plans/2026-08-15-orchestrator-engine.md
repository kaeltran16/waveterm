# Orchestrator Engine (DAG + Worktrees + Graph UI) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the prompt-enforced delegator fan-out with a deterministic DAG engine in wavesrv, per-run managed git worktrees, and a per-run graph view in the cockpit.

**Architecture:** A new `TaskGroup` waveobj (`dag:<id>`) owns a task DAG (deps, gates, parallelism) whose state is derived by pure Go functions. The engine (`pkg/orchestrate`) schedules child runs into per-run git worktrees, publishes control events to the pi lead over the existing control-dir channel, and the cockpit renders the DAG with @xyflow/react, opened per-run from run cards (no new nav surface).

**Tech Stack:** Go (wavesrv, wstore, wshrpc codegen), pi control channel, React 19 + jotai + Tailwind 4, @xyflow/react (new dep), vitest, scripts/cdp verification.

**Spec:** `docs/superpowers/specs/2026-08-15-orchestrator-engine-design.md` (argues from the spec; executors read both).

## Global Constraints

- Never hand-edit generated files (`frontend/types/gotypes.d.ts`, `frontend/app/store/wshclientapi.ts`, `frontend/app/store/services.ts`, `pkg/wshrpc/wshclient/wshclient.go`). Run `task generate` after every wshrpc/waveobj type change; `npx prettier --write` on generated files is allowed only if prettier flags them (they are generated, check `git status` before touching).
- Typecheck with `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (`npx tsc` stack-overflows). Vitest: `npx vitest run <file>`.
- Go tests: `go test ./pkg/orchestrate/...` etc. If sqlite-vec CGO build errors appear (packages importing `pkg/jarvisembed`), set `CGO_CFLAGS=-I<repo>/pkg/jarvisembed/csrc` (PowerShell) or run through `task build:backend`.
- Format: gofmt on Go; `npx prettier --check` + `npx eslint` on touched TS files.
- **Commits follow AGENTS.md approval protocol**: before each commit, run the pi-simplify review on changed lines, then present files + message and await explicit "yes". Never commit without approval. Use `git commit -m` flags or `-F` temp file (never PowerShell here-strings).
- Spec invariants: parallelism >= 1 (default 2); circuit-break at 3 consecutive failures; worktrees at `<project>/.waveterm/worktrees/<runid>`, branch `wave/<runid>`, base = `Run.BaseCommit`; recovery patch `<project>/.waveterm/recovery/<runid>.patch`; squash merge message `run <id>: <goal>`; `blocked-merge` on conflict, `--continue` to resolve; non-git projects skip worktrees (in-place runs); no new nav surface (graph opens per-run); pitasks stays read-only; @xyflow/react for rendering, layered layout is our pure function.

---

### Task 1: TaskGroup waveobj type + migration + codegen

**Files:**
- Modify: `pkg/waveobj/wtype.go` (add `OType_Dag` const near line 36; add `TaskNode`, `RunSpec`, `TaskGroup` structs near the `Run` struct at line 251; add `DagORef` field to `Run`; register in `AllWaveObjTypes()` at line 682)
- Create: `db/migrations-wstore/000017_taskgroup.up.sql`, `db/migrations-wstore/000017_taskgroup.down.sql`
- Verify: `frontend/types/gotypes.d.ts` (generated), `pkg/wshrpc/wshclient/wshclient.go` (generated)

**Interfaces:**
- Consumes: nothing new.
- Produces: `waveobj.TaskGroup` (fields below), `waveobj.TaskNode`, `waveobj.RunSpec`, `waveobj.OType_Dag = "dag"`, `waveobj.Run.DagORef string` — every later task reads these exact field names.

- [ ] **Step 1: Add the type definitions**

In `pkg/waveobj/wtype.go`, add next to the `Run` struct:

```go
// TaskNode is one unit of work in a TaskGroup DAG. State is derived by the engine,
// never hand-set (mirrors RunStatus discipline).
type TaskNode struct {
	ID      string   `json:"id"`                 // "t-1", unique within the group
	Label   string   `json:"label,omitempty"`
	Deps    []string `json:"deps,omitempty"`
	Gate    bool     `json:"gate,omitempty"`     // halt the DAG at completion for review
	State   string   `json:"state"`              // pending|ready|running|done|failed|cancelled|skipped|blocked-merge
	RunID   string   `json:"runid,omitempty"`    // child run once spawned
	RunSpec RunSpec  `json:"runspec,omitempty"`
}

// RunSpec is the child-run launch form a task wants (runtime/mode/goal override).
type RunSpec struct {
	Runtime string `json:"runtime,omitempty"` // harness; empty = run default
	Mode    string `json:"mode,omitempty"`    // quick | pipeline | orchestrator
	Goal    string `json:"goal,omitempty"`    // per-task goal; empty = task label
}

// TaskGroup is the persisted DAG attached to an orchestrator run (oref dag:<id>).
type TaskGroup struct {
	OID         string     `json:"oid"`
	Version     int        `json:"version"`
	ID          string     `json:"id"`          // == OID
	RunID       string     `json:"runid"`       // owning orchestrator run
	ChannelId   string     `json:"channelid"`   // owning run's channel (run lookups are channel-scoped)
	Title       string     `json:"title,omitempty"``
	Parallelism int        `json:"parallelism"`
	Tasks       []TaskNode `json:"tasks"`
	Status      string     `json:"status"`      // running|awaiting-review|blocked|done|cancelled (derived)
	Failures    int        `json:"failures"`    // consecutive task failures; circuit-break at 3
	CreatedTs   int64      `json:"createdts"`
	UpdatedTs   int64      `json:"updatedts"`
}
```

Add `OType_Dag = "dag"` to the OType const block (line ~36). Add `DagORef string \`json:"dagoref,omitempty"\`` to the `Run` struct. Append `reflect.TypeOf(TaskGroup{})` to `AllWaveObjTypes()`.

- [ ] **Step 2: Create the migration**

`db/migrations-wstore/000017_taskgroup.up.sql`:
```sql
CREATE TABLE IF NOT EXISTS db_dag (
    oid varchar(36) PRIMARY KEY,
    version int NOT NULL,
    data json NOT NULL
);
```
`db/migrations-wstore/000017_taskgroup.down.sql`:
```sql
DROP TABLE IF EXISTS db_dag;
```

- [ ] **Step 3: Run codegen and verify**

Run: `task generate`
Expected: completes; `frontend/types/gotypes.d.ts` now contains `TaskGroup`, `TaskNode`, `RunSpec`; `Run` has `dagoref?: string`.

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: 0 errors.

- [ ] **Step 4: Verify the migration applies**

Run: `go test ./pkg/wstore/... -run TestInit` (or the existing wstore migration test — grep `func Test` in `pkg/wstore/` for the init/migration test and run it).
Expected: PASS with the new table present. If no migration test exists, run `task build:backend` and confirm wavesrv boots (it applies migrations at startup).

- [ ] **Step 5: Commit**

`feat(waveobj): add TaskGroup dag type + migration` — awaiting approval per AGENTS.md, then commit (wtype.go + both migrations; NOT the generated files — they regenerate in the same task, include them too since `task generate` rewrote them).

---

### Task 2: Engine core — validation + status derivation (pure)

**Files:**
- Create: `pkg/orchestrate/dag.go`
- Create: `pkg/orchestrate/dag_test.go`

**Interfaces:**
- Consumes: `waveobj.TaskGroup`, `waveobj.TaskNode` (Task 1).
- Produces: state/status constants below; `NewTaskGroup(runID, channelId, title string, parallelism int, tasks []waveobj.TaskNode, ts int64) (waveobj.TaskGroup, error)`; `ValidateTasks(tasks []waveobj.TaskNode) error`; `RecomputeDagStatus(g *waveobj.TaskGroup)`; `DeriveTaskStates(g *waveobj.TaskGroup, runs map[string]*waveobj.Run)`.

- [ ] **Step 1: Write the failing test**

`pkg/orchestrate/dag_test.go`:
```go
package orchestrate

import (
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func mkTasks() []waveobj.TaskNode {
	return []waveobj.TaskNode{
		{ID: "t-0", Label: "setup"},
		{ID: "t-1", Label: "api", Deps: []string{"t-0"}},
		{ID: "t-2", Label: "ship", Deps: []string{"t-0", "t-1"}, Gate: true},
	}
}

func mustGroup(t *testing.T, tasks []waveobj.TaskNode) *waveobj.TaskGroup {
	t.Helper()
	g, err := NewTaskGroup("run-1", "ch-1", "g", 2, tasks, 1)
	if err != nil {
		t.Fatal(err)
	}
	return &g
}

func TestNewTaskGroupSetsIdentity(t *testing.T) {
	g, err := NewTaskGroup("run-1", "ch-1", "ship", 2, mkTasks(), 1000)
	if err != nil {
		t.Fatalf("NewTaskGroup: %v", err)
	}
	if g.RunID != "run-1" || g.ChannelId != "ch-1" || g.Parallelism != 2 || g.ID == "" {
		t.Fatalf("bad identity: %+v", g)
	}
}

func TestValidateRejects(t *testing.T) {
	cases := []struct {
		name  string
		tasks []waveobj.TaskNode
	}{
		{"dup id", []waveobj.TaskNode{{ID: "t-1"}, {ID: "t-1"}}},
		{"unknown dep", []waveobj.TaskNode{{ID: "t-1", Deps: []string{"nope"}}}},
		{"self dep", []waveobj.TaskNode{{ID: "t-1", Deps: []string{"t-1"}}}},
		{"cycle", []waveobj.TaskNode{{ID: "t-1", Deps: []string{"t-2"}}, {ID: "t-2", Deps: []string{"t-1"}}}},
		{"empty id", []waveobj.TaskNode{{ID: ""}}},
	}
	for _, c := range cases {
		if err := ValidateTasks(c.tasks); err == nil {
			t.Errorf("%s: expected error", c.name)
		}
	}
	if err := ValidateTasks(mkTasks()); err != nil {
		t.Errorf("valid tasks rejected: %v", err)
	}
}

func TestRecomputeStatusDerivation(t *testing.T) {
	g := mustGroup(t, mkTasks())
	g.Tasks[0].State = TaskState_Done
	g.Tasks[1].State = TaskState_Done
	RecomputeDagStatus(g)
	if g.Status != DagStatus_AwaitingReview { // done gate, open successors
		t.Fatalf("want awaiting-review, got %s", g.Status)
	}
	g.Tasks[2].State = TaskState_Done
	RecomputeDagStatus(g)
	if g.Status != DagStatus_Done {
		t.Fatalf("want done, got %s", g.Status)
	}
	g2 := mustGroup(t, mkTasks())
	g2.Tasks[1].State = TaskState_Failed
	RecomputeDagStatus(g2)
	if g2.Status != DagStatus_Blocked {
		t.Fatalf("want blocked, got %s", g2.Status)
	}
	g3 := mustGroup(t, mkTasks())
	g3.Failures = 3
	RecomputeDagStatus(g3)
	if g3.Status != DagStatus_Blocked {
		t.Fatalf("want circuit-break blocked, got %s", g3.Status)
	}
}

func TestDeriveTaskStatesFromRuns(t *testing.T) {
	g := mustGroup(t, mkTasks())
	g.Tasks[0].State = TaskState_Running
	g.Tasks[0].RunID = "r-0"
	runs := map[string]*waveobj.Run{"r-0": {ID: "r-0", Status: jarvis.RunStatus_Done}}
	DeriveTaskStates(g, runs)
	if g.Tasks[0].State != TaskState_Done {
		t.Fatalf("want done, got %s", g.Tasks[0].State)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./pkg/orchestrate/ -run TestNewTaskGroup -count=1`
Expected: FAIL (package has no Go files / undefined NewTaskGroup).

- [ ] **Step 3: Write the implementation**

`pkg/orchestrate/dag.go`:
```go
// Package orchestrate is the deterministic DAG engine for orchestrator runs.
package orchestrate

import (
	"fmt"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// Task states (derived, never hand-set).
const (
	TaskState_Pending      = "pending"
	TaskState_Ready        = "ready"
	TaskState_Running      = "running"
	TaskState_Done         = "done"
	TaskState_Failed       = "failed"
	TaskState_Cancelled    = "cancelled"
	TaskState_Skipped      = "skipped"
	TaskState_BlockedMerge = "blocked-merge"
)

// Dag statuses (derived by RecomputeDagStatus; cancelled is a terminal override).
const (
	DagStatus_Running        = "running"
	DagStatus_AwaitingReview = "awaiting-review"
	DagStatus_Blocked        = "blocked"
	DagStatus_Done           = "done"
	DagStatus_Cancelled      = "cancelled"
)

// MaxConsecutiveFailures is the circuit-break: the DAG blocks with a "stop and ask" flag.
const MaxConsecutiveFailures = 3

// DefaultParallelism is applied when the submit data carries 0.
const DefaultParallelism = 2

// ValidateTasks rejects duplicate/empty ids, unknown or self deps, and dependency cycles.
func ValidateTasks(tasks []waveobj.TaskNode) error {
	if len(tasks) == 0 {
		return fmt.Errorf("dag has no tasks")
	}
	seen := map[string]bool{}
	for _, t := range tasks {
		if t.ID == "" {
			return fmt.Errorf("task with empty id")
		}
		if seen[t.ID] {
			return fmt.Errorf("duplicate task id %q", t.ID)
		}
		seen[t.ID] = true
		for _, d := range t.Deps {
			if d == t.ID {
				return fmt.Errorf("task %q depends on itself", t.ID)
			}
			if !seen[d] && !taskExists(tasks, d) {
				return fmt.Errorf("task %q depends on unknown task %q", t.ID, d)
			}
		}
	}
	if cyc := findCycle(tasks); cyc != "" {
		return fmt.Errorf("dependency cycle involving %q", cyc)
	}
	return nil
}

func taskExists(tasks []waveobj.TaskNode, id string) bool {
	for _, t := range tasks {
		if t.ID == id {
			return true
		}
	}
	return false
}

// findCycle returns a task id participating in a dep cycle, or "" (Kahn's algorithm).
func findCycle(tasks []waveobj.TaskNode) string {
	indeg := map[string]int{}
	succ := map[string][]string{}
	for _, t := range tasks {
		indeg[t.ID] = 0
	}
	for _, t := range tasks {
		for _, d := range t.Deps {
			indeg[t.ID]++
			succ[d] = append(succ[d], t.ID)
		}
	}
	q := []string{}
	for id, n := range indeg {
		if n == 0 {
			q = append(q, id)
		}
	}
	visited := 0
	for len(q) > 0 {
		cur := q[0]
		q = q[1:]
		visited++
		for _, s := range succ[cur] {
			indeg[s]--
			if indeg[s] == 0 {
				q = append(q, s)
			}
		}
	}
	if visited == len(tasks) {
		return ""
	}
	for id, n := range indeg {
		if n > 0 {
			return id
		}
	}
	return ""
}

// NewTaskGroup validates and builds a group; parallelism 0 becomes DefaultParallelism.
func NewTaskGroup(runID, channelId, title string, parallelism int, tasks []waveobj.TaskNode, ts int64) (waveobj.TaskGroup, error) {
	if err := ValidateTasks(tasks); err != nil {
		return waveobj.TaskGroup{}, err
	}
	if parallelism < 1 {
		parallelism = DefaultParallelism
	}
	g := waveobj.TaskGroup{
		ID:          uuid.NewString(),
		RunID:       runID,
		ChannelId:   channelId,
		Title:       title,
		Parallelism: parallelism,
		Tasks:       tasks,
		Status:      DagStatus_Running,
		CreatedTs:   ts,
		UpdatedTs:   ts,
	}
	g.OID = g.ID
	RecomputeDagStatus(&g)
	return g, nil
}

// RecomputeDagStatus derives g.Status from task states. Single source of truth.
// Order matters: cancelled (terminal override) -> done -> blocked -> awaiting-review -> running.
func RecomputeDagStatus(g *waveobj.TaskGroup) {
	cancelled := false
	allTerminal := true
	blocked := false
	gateDone := false
	for i := range g.Tasks {
		t := &g.Tasks[i]
		switch t.State {
		case TaskState_Cancelled:
			cancelled = true
		case TaskState_Failed, TaskState_BlockedMerge:
			blocked = true
		case TaskState_Done:
			if t.Gate {
				gateDone = true
			}
		}
		if t.State != TaskState_Done && t.State != TaskState_Skipped {
			allTerminal = false
		}
	}
	switch {
	case cancelled:
		g.Status = DagStatus_Cancelled
	case allTerminal:
		g.Status = DagStatus_Done
	case blocked || g.Failures >= MaxConsecutiveFailures:
		g.Status = DagStatus_Blocked
	case gateDone:
		g.Status = DagStatus_AwaitingReview
	default:
		g.Status = DagStatus_Running
	}
}

// DeriveTaskStates maps child run status onto tasks (only tasks with a RunID are touched).
func DeriveTaskStates(g *waveobj.TaskGroup, runs map[string]*waveobj.Run) {
	for i := range g.Tasks {
		t := &g.Tasks[i]
		if t.RunID == "" {
			continue
		}
		r, ok := runs[t.RunID]
		if !ok {
			continue
		}
		switch r.Status {
		case jarvis.RunStatus_Done:
			t.State = TaskState_Done
		case jarvis.RunStatus_Cancelled:
			t.State = TaskState_Cancelled
		case jarvis.RunStatus_Blocked:
			t.State = TaskState_Failed
		}
	}
}
```

Note: the `RunStatus_*` constants are `jarvis.RunStatus_Done` etc. in `pkg/jarvis/run.go` — `dag.go` imports `github.com/wavetermdev/waveterm/pkg/jarvis`, and the test imports it too.

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./pkg/orchestrate/ -count=1`
Expected: PASS (all four tests).

- [ ] **Step 5: Commit**

`feat(orchestrate): dag validation + status derivation` — await approval, then commit (dag.go + dag_test.go).

---

### Task 3: Scheduler + gate transitions (pure)

**Files:**
- Create: `pkg/orchestrate/scheduler.go`
- Create: `pkg/orchestrate/scheduler_test.go`

**Interfaces:**
- Consumes: Task 2 (`RecomputeDagStatus`, task/dag status constants, `ValidateTasks`).
- Produces: `ReadyTasks(g *waveobj.TaskGroup) []string`; `NextToSpawn(g *waveobj.TaskGroup) []string`; `MarkRunning(g *waveobj.TaskGroup, taskID, runID string) error`; `ApproveGate(g *waveobj.TaskGroup) *waveobj.TaskGroup`; `SendBackGate(g *waveobj.TaskGroup) *waveobj.TaskGroup`; `RetryTask(g *waveobj.TaskGroup, taskID string) error`; `SkipTask(g *waveobj.TaskGroup, taskID string) error`; `CancelGroup(g *waveobj.TaskGroup) *waveobj.TaskGroup`.

- [ ] **Step 1: Write the failing test**

`pkg/orchestrate/scheduler_test.go`:
```go
package orchestrate

import (
	"reflect"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func groupWith(states ...string) *waveobj.TaskGroup {
	tasks := []waveobj.TaskNode{
		{ID: "t-0", Label: "a"},
		{ID: "t-1", Label: "b", Deps: []string{"t-0"}},
		{ID: "t-2", Label: "c", Deps: []string{"t-0"}},
		{ID: "t-3", Label: "d", Deps: []string{"t-1", "t-2"}},
	}
	for i, s := range states {
		tasks[i].State = s
	}
	g, err := NewTaskGroup("run-1", "ch-1", "g", 2, tasks, 1)
	if err != nil {
		panic(err)
	}
	return &g
}

func TestReadyTasksDepsAndOrder(t *testing.T) {
	g := groupWith(TaskState_Done)
	if got := ReadyTasks(g); !reflect.DeepEqual(got, []string{"t-1", "t-2"}) {
		t.Fatalf("want [t-1 t-2], got %v", got)
	}
}

func TestReadyTasksGateHalt(t *testing.T) {
	g := groupWith(TaskState_Done, TaskState_Done, TaskState_Done)
	g.Tasks[2].Gate = true // done gate with open successor t-3
	if got := ReadyTasks(g); len(got) != 0 {
		t.Fatalf("gate must halt ready tasks, got %v", got)
	}
	ApproveGate(g)
	if got := ReadyTasks(g); !reflect.DeepEqual(got, []string{"t-3"}) {
		t.Fatalf("after approve want [t-3], got %v", got)
	}
}

func TestNextToSpawnParallelismCap(t *testing.T) {
	g := groupWith(TaskState_Done, TaskState_Running)
	// one running (t-1), cap 2 -> only one more may spawn
	if got := NextToSpawn(g); !reflect.DeepEqual(got, []string{"t-2"}) {
		t.Fatalf("want [t-2], got %v", got)
	}
	g2 := groupWith(TaskState_Done)
	if got := NextToSpawn(g2); !reflect.DeepEqual(got, []string{"t-1", "t-2"}) {
		t.Fatalf("want [t-1 t-2], got %v", got)
	}
}

func TestSendBackAndRetryReset(t *testing.T) {
	g := groupWith(TaskState_Done, TaskState_Done, TaskState_Done)
	g.Tasks[2].Gate = true
	ApproveGate(g)
	g.Tasks[3].State = TaskState_Running
	g.Tasks[3].RunID = "r-3"
	SendBackGate(g) // reopens the gate for re-spawn
	if g.Tasks[2].State != TaskState_Running || g.Tasks[2].RunID != "" {
		t.Fatalf("sendback must reopen gate and clear runid: %+v", g.Tasks[2])
	}
	g2 := groupWith(TaskState_Done, TaskState_Failed)
	g2.Failures = 2
	if err := RetryTask(g2, "t-1"); err != nil {
		t.Fatal(err)
	}
	if g2.Tasks[1].State != TaskState_Running || g2.Failures != 0 {
		t.Fatalf("retry must rerun and reset failures: %+v", g2.Tasks[1])
	}
}

func TestCancelGroup(t *testing.T) {
	g := groupWith(TaskState_Done, TaskState_Running)
	g.Tasks[1].RunID = "r-1"
	CancelGroup(g)
	if g.Tasks[1].State != TaskState_Cancelled || g.Status != DagStatus_Cancelled {
		t.Fatalf("cancel: %s %s", g.Tasks[1].State, g.Status)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./pkg/orchestrate/ -run TestReadyTasks -count=1`
Expected: FAIL (undefined ReadyTasks).

- [ ] **Step 3: Write the implementation**

`pkg/orchestrate/scheduler.go`:
```go
package orchestrate

import (
	"fmt"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// gateBlocked reports whether a completed-but-unreleased gate is halting the DAG.
func gateBlocked(g *waveobj.TaskGroup) bool {
	for i := range g.Tasks {
		t := &g.Tasks[i]
		if t.Gate && t.State == TaskState_Done && !t.Released {
			return true
		}
	}
	return false
}

// ReadyTasks returns pending tasks whose deps are all done/skipped, ordered by id.
// A done, unreleased gate halts everything (spec: "halts the DAG at its completion").
func ReadyTasks(g *waveobj.TaskGroup) []string {
	if gateBlocked(g) {
		return nil
	}
	var out []string
	for i := range g.Tasks {
		t := &g.Tasks[i]
		if t.State != TaskState_Pending {
			continue
		}
		ok := true
		for _, d := range t.Deps {
			if !depTerminal(g, d) {
				ok = false
				break
			}
		}
		if ok {
			out = append(out, t.ID)
		}
	}
	return out
}

func depTerminal(g *waveobj.TaskGroup, id string) bool {
	for i := range g.Tasks {
		if g.Tasks[i].ID == id {
			s := g.Tasks[i].State
			return s == TaskState_Done || s == TaskState_Skipped
		}
	}
	return false
}

// NextToSpawn returns ready tasks the engine should spawn now: ready minus running,
// capped so running+new <= Parallelism, ordered by id.
func NextToSpawn(g *waveobj.TaskGroup) []string {
	running := 0
	for i := range g.Tasks {
		if g.Tasks[i].State == TaskState_Running {
			running++
		}
	}
	room := g.Parallelism - running
	if room <= 0 {
		return nil
	}
	ready := ReadyTasks(g)
	if len(ready) > room {
		ready = ready[:room]
	}
	return ready
}

// MarkRunning assigns a spawned child run to a ready task.
func MarkRunning(g *waveobj.TaskGroup, taskID, runID string) error {
	for i := range g.Tasks {
		if g.Tasks[i].ID == taskID {
			g.Tasks[i].State = TaskState_Running
			g.Tasks[i].RunID = runID
			return nil
		}
	}
	return fmt.Errorf("no task %q", taskID)
}

// ApproveGate releases a completed gate so successors may run.
func ApproveGate(g *waveobj.TaskGroup) *waveobj.TaskGroup {
	for i := range g.Tasks {
		if g.Tasks[i].Gate && g.Tasks[i].State == TaskState_Done {
			g.Tasks[i].Released = true
		}
	}
	RecomputeDagStatus(g)
	return g
}

// SendBackGate reopens a completed gate: it must re-spawn (RunID cleared) from a fresh worktree.
func SendBackGate(g *waveobj.TaskGroup) *waveobj.TaskGroup {
	for i := range g.Tasks {
		t := &g.Tasks[i]
		if t.Gate && t.State == TaskState_Done {
			t.State = TaskState_Running
			t.Released = false
			t.RunID = ""
		}
	}
	RecomputeDagStatus(g)
	return g
}

// RetryTask re-spawns a failed task and resets the consecutive-failure counter.
func RetryTask(g *waveobj.TaskGroup, taskID string) error {
	for i := range g.Tasks {
		if g.Tasks[i].ID == taskID {
			g.Tasks[i].State = TaskState_Running
			g.Tasks[i].RunID = ""
			g.Failures = 0
			RecomputeDagStatus(g)
			return nil
		}
	}
	return fmt.Errorf("no task %q", taskID)
}

// SkipTask marks a failed/ready task skipped (no spawn).
func SkipTask(g *waveobj.TaskGroup, taskID string) error {
	for i := range g.Tasks {
		if g.Tasks[i].ID == taskID {
			g.Tasks[i].State = TaskState_Skipped
			g.Tasks[i].RunID = ""
			RecomputeDagStatus(g)
			return nil
		}
	}
	return fmt.Errorf("no task %q", taskID)
}

// CancelGroup terminally cancels: pending/ready -> skipped, running -> cancelled.
func CancelGroup(g *waveobj.TaskGroup) *waveobj.TaskGroup {
	for i := range g.Tasks {
		t := &g.Tasks[i]
		switch t.State {
		case TaskState_Pending, TaskState_Ready:
			t.State = TaskState_Skipped
		case TaskState_Running:
			t.State = TaskState_Cancelled
		}
	}
	g.Status = DagStatus_Cancelled
	return g
}
```

This adds a `Released bool \`json:"released,omitempty"\`` field to `waveobj.TaskNode` (Task 1 file — add it now; run `task generate` again after).

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./pkg/orchestrate/ -count=1`
Expected: PASS. Then run `task generate` (for the `Released` field) and typecheck:
Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: 0 errors.

- [ ] **Step 5: Commit**

`feat(orchestrate): dag scheduler + gate transitions` — await approval, then commit.

---

### Task 4: Managed worktree lifecycle + merge (git fixture tests)

**Files:**
- Create: `pkg/orchestrate/worktree.go`, `pkg/orchestrate/merge.go`
- Create: `pkg/orchestrate/worktree_test.go`, `pkg/orchestrate/merge_test.go`

**Interfaces:**
- Consumes: Task 2 constants.
- Produces: `IsGitRepo(projectPath string) bool`; `CreateRunWorktree(ctx context.Context, projectPath, runID, baseCommit string) (string, error)` (returns worktree path); `RemoveRunWorktree(ctx context.Context, projectPath, runID string) error`; `DumpRecoveryPatch(ctx context.Context, projectPath, runID string) error`; `WorktreeHeadCommit(ctx context.Context, worktreePath string) (string, error)`; `ErrMergeConflict`; `MergeRunWorktree(ctx context.Context, projectPath, runID, goal string) (string, error)` (returns merge commit sha); `MergeContinue(ctx context.Context, projectPath, runID, goal string) (string, error)`.

- [ ] **Step 1: Write the failing tests**

`pkg/orchestrate/worktree_test.go` (helper `newGitRepo(t)` creates a temp repo with an initial commit, run at the start of each test; the helper runs `git init`, `git config user.email/user.name`, commit an initial file):
```go
package orchestrate

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func gitCmd(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
	return string(out)
}

func newGitRepo(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	gitCmd(t, dir, "init", "-b", "main")
	gitCmd(t, dir, "config", "user.email", "t@test")
	gitCmd(t, dir, "config", "user.name", "t")
	os.WriteFile(filepath.Join(dir, "base.txt"), []byte("base\n"), 0o644)
	gitCmd(t, dir, "add", ".")
	gitCmd(t, dir, "commit", "-m", "base")
	return dir
}

func TestCreateAndRemoveWorktree(t *testing.T) {
	dir := newGitRepo(t)
	base := gitCmd(t, dir, "rev-parse", "HEAD")
	wt, err := CreateRunWorktree(context.Background(), dir, "run-1", base)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(wt, "base.txt")); err != nil {
		t.Fatalf("worktree missing base file: %v", err)
	}
	if err := RemoveRunWorktree(context.Background(), dir, "run-1"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(wt); !os.IsNotExist(err) {
		t.Fatalf("worktree still exists: %v", err)
	}
}

func TestIsGitRepoFalse(t *testing.T) {
	if IsGitRepo(t.TempDir()) {
		t.Fatal("temp dir must not be a git repo")
	}
}

func TestRecoveryPatch(t *testing.T) {
	dir := newGitRepo(t)
	base := gitCmd(t, dir, "rev-parse", "HEAD")
	wt, _ := CreateRunWorktree(context.Background(), dir, "run-1", base)
	os.WriteFile(filepath.Join(wt, "new.txt"), []byte("work\n"), 0o644)
	gitCmd(t, wt, "add", ".")
	gitCmd(t, wt, "commit", "-m", "wip")
	if err := DumpRecoveryPatch(context.Background(), dir, "run-1"); err != nil {
		t.Fatal(err)
	}
	patch := filepath.Join(dir, ".waveterm", "recovery", "run-1.patch")
	if _, err := os.Stat(patch); err != nil {
		t.Fatalf("recovery patch missing: %v", err)
	}
}
```

`pkg/orchestrate/merge_test.go`:
```go
package orchestrate

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestMergeSquash(t *testing.T) {
	dir := newGitRepo(t)
	base := gitCmd(t, dir, "rev-parse", "HEAD")
	wt, _ := CreateRunWorktree(context.Background(), dir, "run-1", base)
	os.WriteFile(filepath.Join(wt, "feature.txt"), []byte("feat\n"), 0o644)
	gitCmd(t, wt, "add", ".")
	gitCmd(t, wt, "commit", "-m", "feature")
	sha, err := MergeRunWorktree(context.Background(), dir, "run-1", "do the thing")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "feature.txt")); err != nil {
		t.Fatalf("merged file missing: %v", err)
	}
	if len(sha) != 40 {
		t.Fatalf("bad merge sha %q", sha)
	}
	if _, err := os.Stat(wt); !os.IsNotExist(err) {
		t.Fatalf("worktree not cleaned up")
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
	err := MergeRunWorktree(context.Background(), dir, "run-1", "do the thing")
	if !errors.Is(err, ErrMergeConflict) {
		t.Fatalf("want ErrMergeConflict, got %v", err)
	}
	// resolve in the project tree, then continue
	os.WriteFile(filepath.Join(dir, "base.txt"), []byte("resolved\n"), 0o644)
	gitCmd(t, dir, "add", ".")
	if _, err := MergeContinue(context.Background(), dir, "run-1", "do the thing"); err != nil {
		t.Fatal(err)
	}
}

func TestMergeRunWorktreeNonGit(t *testing.T) {
	dir := t.TempDir()
	_, err := MergeRunWorktree(context.Background(), dir, "run-1", "x")
	if !errors.Is(err, ErrNotGitRepo) {
		t.Fatalf("want ErrNotGitRepo, got %v", err)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./pkg/orchestrate/ -run TestCreateAndRemoveWorktree -count=1`
Expected: FAIL (undefined CreateRunWorktree).

- [ ] **Step 3: Write the implementation**

`pkg/orchestrate/worktree.go`:
```go
package orchestrate

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

var ErrNotGitRepo = errors.New("not a git repo")

// worktreeDir is the per-run linked-worktree root inside the project.
func worktreeDir(projectPath, runID string) string {
	return filepath.Join(projectPath, ".waveterm", "worktrees", runID)
}

func git(ctx context.Context, dir string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, "git", append([]string{"-C", dir}, args...)...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("git %v: %w: %s", args, err, strings.TrimSpace(string(out)))
	}
	return strings.TrimSpace(string(out)), nil
}

// IsGitRepo reports whether projectPath is inside a git working tree.
func IsGitRepo(projectPath string) bool {
	_, err := git(context.Background(), projectPath, "rev-parse", "--is-inside-work-tree")
	return err == nil
}

// CreateRunWorktree links a worktree at <project>/.waveterm/worktrees/<runID> on branch
// wave/<runID>, checked out at baseCommit (empty = current branch head).
func CreateRunWorktree(ctx context.Context, projectPath, runID, baseCommit string) (string, error) {
	if !IsGitRepo(projectPath) {
		return "", ErrNotGitRepo
	}
	wt := worktreeDir(projectPath, runID)
	args := []string{"worktree", "add", "-b", "wave/" + runID, wt}
	if baseCommit != "" {
		args = append(args, baseCommit)
	}
	if _, err := git(ctx, projectPath, args...); err != nil {
		return "", fmt.Errorf("creating worktree: %w", err)
	}
	return wt, nil
}

// RemoveRunWorktree removes the linked worktree and its branch.
func RemoveRunWorktree(ctx context.Context, projectPath, runID string) error {
	wt := worktreeDir(projectPath, runID)
	if _, err := os.Stat(wt); err != nil {
		return nil // nothing to remove
	}
	if _, err := git(ctx, projectPath, "worktree", "remove", "--force", wt); err != nil {
		return fmt.Errorf("removing worktree: %w", err)
	}
	git(ctx, projectPath, "branch", "-D", "wave/"+runID) // best-effort
	return nil
}

// DumpRecoveryPatch writes the worktree's diff vs its base to a patch file so a cancelled
// run's work is not silently lost.
func DumpRecoveryPatch(ctx context.Context, projectPath, runID string) error {
	wt := worktreeDir(projectPath, runID)
	base := "wave/" + runID
	patch, err := git(ctx, projectPath, "diff", "HEAD", base)
	if err != nil {
		return err
	}
	recDir := filepath.Join(projectPath, ".waveterm", "recovery")
	if err := os.MkdirAll(recDir, 0o755); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(recDir, runID+".patch"), []byte(patch), 0o644)
}

// WorktreeHeadCommit returns the worktree branch's HEAD sha.
func WorktreeHeadCommit(ctx context.Context, projectPath, runID string) (string, error) {
	return git(ctx, projectPath, "rev-parse", "wave/"+runID)
}
```

`pkg/orchestrate/merge.go`:
```go
package orchestrate

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
)

var ErrMergeConflict = errors.New("merge conflict")

// MergeRunWorktree squash-merges wave/<runID> into the project branch, removes the
// worktree, and returns the merge commit sha. On conflict the tree is left mid-merge
// (ErrMergeConflict) and the caller resolves then calls MergeContinue.
func MergeRunWorktree(ctx context.Context, projectPath, runID, goal string) (string, error) {
	if !IsGitRepo(projectPath) {
		return "", ErrNotGitRepo
	}
	branch := "wave/" + runID
	if _, err := git(ctx, projectPath, "merge", "--squash", branch); err != nil {
		if strings.Contains(err.Error(), "CONFLICT") {
			return "", ErrMergeConflict
		}
		return "", fmt.Errorf("squash merge: %w", err)
	}
	return finishMerge(ctx, projectPath, runID, goal)
}

// MergeContinue completes a merge after the caller resolved conflicts in the project tree.
func MergeContinue(ctx context.Context, projectPath, runID, goal string) (string, error) {
	status, err := git(ctx, projectPath, "status", "--porcelain")
	if err != nil {
		return "", err
	}
	for _, line := range strings.Split(status, "\n") {
		if strings.HasPrefix(line, "UU ") || strings.HasPrefix(line, "AA ") || strings.HasPrefix(line, "DD ") {
			return "", fmt.Errorf("unresolved conflict: %s", line)
		}
	}
	return finishMerge(ctx, projectPath, runID, goal)
}

func finishMerge(ctx context.Context, projectPath, runID, goal string) (string, error) {
	msg := fmt.Sprintf("run %s: %s", runID, goal)
	if _, err := git(ctx, projectPath, "commit", "-m", msg); err != nil {
		return "", fmt.Errorf("merge commit: %w", err)
	}
	sha, err := git(ctx, projectPath, "rev-parse", "HEAD")
	if err != nil {
		return "", err
	}
	if err := RemoveRunWorktree(ctx, projectPath, runID); err != nil {
		return "", err
	}
	if _, err := os.Stat(worktreeDir(projectPath, runID)); err == nil {
		return "", fmt.Errorf("worktree still present after merge")
	}
	return sha, nil
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./pkg/orchestrate/ -run "TestCreateAndRemoveWorktree|TestIsGitRepoFalse|TestRecoveryPatch|TestMerge" -count=1`
Expected: PASS (git must be on PATH — it is, per repo baseline).

- [ ] **Step 5: Commit**

`feat(orchestrate): managed worktree lifecycle + squash merge` — await approval, then commit.

---

### Task 5: wshrpc DagCommands + server handlers + wstore helpers

**Files:**
- Create: `pkg/wshrpc/wshrpctypes_dag.go` (interface + data structs)
- Create: `pkg/wstore/wstore_dag.go` (AppendDag/GetDag/UpdateDag)
- Create: `pkg/wshrpc/wshserver/wshserver_dag.go` (handlers)
- Modify: `pkg/wshrpc/wshrpctypes.go` (add `DagCommands` to `WshRpcInterface` at line ~44)

**Interfaces:**
- Consumes: Task 2 (`NewTaskGroup`, `RecomputeDagStatus`), Task 3 (`ApproveGate`, `SendBackGate`, `RetryTask`, `SkipTask`, `CancelGroup`, task constants), Task 4 (`MergeRunWorktree`, `MergeContinue`, `ErrMergeConflict`, `WorktreeHeadCommit`).
- Produces (generated after `task generate`): `wshrpc.CommandDagSubmitData{ChannelId, RunId, Title string; Parallelism int; Tasks []waveobj.TaskNode}`, `CommandDagStatusData{ChannelId, RunId string}`, `CommandDagActionData{ChannelId, RunId, TaskId, Action string}`, `CommandDagMergeData{ChannelId, RunId string}`; `wshclient.DagSubmitCommand/DagStatusCommand/DagActionCommand/DagMergeCommand`; TS `RpcApi.DagSubmitCommand` etc.

- [ ] **Step 1: Write the interface + data types**

`pkg/wshrpc/wshrpctypes_dag.go`:
```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshrpc

import (
	"context"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// DagCommands is the deterministic orchestration engine surface (pkg/orchestrate).
type DagCommands interface {
	DagSubmitCommand(ctx context.Context, data CommandDagSubmitData) (*waveobj.TaskGroup, error)   // validate + persist a TaskGroup for an orchestrator run
	DagStatusCommand(ctx context.Context, data CommandDagStatusData) (*waveobj.TaskGroup, error)     // engine-owned status snapshot
	DagActionCommand(ctx context.Context, data CommandDagActionData) error                           // approve | sendback | retry | skip | cancel
	DagMergeCommand(ctx context.Context, data CommandDagMergeData) error                             // squash-merge a finished child's worktree back
}

type CommandDagSubmitData struct {
	ChannelId   string             `json:"channelid"`
	RunId       string             `json:"runid"`
	Title       string             `json:"title,omitempty"`
	Parallelism int                `json:"parallelism"`
	Tasks       []waveobj.TaskNode `json:"tasks"`
}

type CommandDagStatusData struct {
	ChannelId string `json:"channelid"`
	RunId     string `json:"runid"`
}

type CommandDagActionData struct {
	ChannelId string `json:"channelid"`
	RunId     string `json:"runid"`
	TaskId    string `json:"taskid"`
	Action    string `json:"action"` // approve | sendback | retry | skip | cancel
}

type CommandDagMergeData struct {
	ChannelId string `json:"channelid"`
	RunId     string `json:"runid"`
}
```

Add `DagCommands` to the `WshRpcInterface` interface body in `pkg/wshrpc/wshrpctypes.go` (line ~44, alongside `RunCommands`).

- [ ] **Step 2: Write the wstore helpers**

`pkg/wstore/wstore_dag.go` — follow the exact shape of `wstore_channel.go:207-260` (`UpdateRun`/`GetRun` use the generic `db_<otype>` tables with version checking):
```go
package wstore

import (
	"context"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func AppendDag(ctx context.Context, dag *waveobj.TaskGroup) error {
	return dbInsertObject(ctx, waveobj.OType_Dag, dag.OID, dag.Version, dag)
}

func GetDag(ctx context.Context, dagId string) (*waveobj.TaskGroup, error) {
	return DBMustGet[*waveobj.TaskGroup](ctx, dagId)
}

// UpdateDag applies fn under the optimistic-concurrency version check and bumps Version.
func UpdateDag(ctx context.Context, dagId string, fn func(*waveobj.TaskGroup) error) error {
	return dbUpdateObject[*waveobj.TaskGroup](ctx, dagId, fn)
}
```
(If `dbInsertObject`/`dbUpdateObject` are not the real names, mirror the private helpers `AppendRun`/`UpdateRun` call — read `pkg/wstore/wstore_channel.go:180-260` and reuse the same underlying functions with the dag otype.)

- [ ] **Step 3: Write the failing handler test**

`pkg/wshrpc/wshserver/wshserver_dag_test.go` — follow the DB harness pattern of `pkg/wshrpc/wshserver/wshserver_run_test.go` (temp DB + WshServer setup; copy its setup lines):
```go
func TestDagSubmitAndAction(t *testing.T) {
	ctx := context.Background()
	// setup: temp DB + server (mirror wshserver_run_test.go), then an orchestrator run:
	ch := ... // create a channel via wstore.AppendChannel (mirror run test setup)
	run := jarvis.NewRun("goal", wsId, ch.ProjectPath, nil, jarvis.RunMode_Orchestrator, jarvis.DefaultOrchestratorPlaybook(false), 1)
	run.Runtime = "pi"
	if err := wstore.AppendRun(ctx, ch.OID, run); err != nil { t.Fatal(err) }
	ws := ...
	g, err := ws.DagSubmitCommand(ctx, wshrpc.CommandDagSubmitData{
		ChannelId: ch.OID, RunId: run.ID, Title: "t", Parallelism: 2,
		Tasks: []waveobj.TaskNode{
			{ID: "t-0", Label: "a"},
			{ID: "t-1", Label: "b", Deps: []string{"t-0"}, Gate: true},
		},
	})
	if err != nil { t.Fatal(err) }
	if g.Status != "running" { t.Fatalf("want running, got %s", g.Status) }
	// approve on a non-gate task is a no-op (permissive), not an error:
	if err := ws.DagActionCommand(ctx, wshrpc.CommandDagActionData{ChannelId: ch.OID, RunId: run.ID, TaskId: "t-0", Action: "approve"}); err != nil {
		t.Fatalf("approve on non-gate must be a no-op: %v", err)
	}
	// gate flow: t-0 done -> awaiting-review -> approve -> running
	if err := wstore.UpdateDag(ctx, g.ID, func(g *waveobj.TaskGroup) error {
		g.Tasks[0].State = "done"
		orchestrate.RecomputeDagStatus(g)
		return nil
	}); err != nil { t.Fatal(err) }
	g2, err := ws.DagStatusCommand(ctx, wshrpc.CommandDagStatusData{ChannelId: ch.OID, RunId: run.ID})
	if err != nil { t.Fatal(err) }
	if g2.Status != "awaiting-review" { t.Fatalf("want awaiting-review, got %s", g2.Status) }
	if err := ws.DagActionCommand(ctx, wshrpc.CommandDagActionData{ChannelId: ch.OID, RunId: run.ID, TaskId: "t-1", Action: "approve"}); err != nil {
		t.Fatal(err)
	}
	g3, _ := ws.DagStatusCommand(ctx, wshrpc.CommandDagStatusData{ChannelId: ch.OID, RunId: run.ID})
	if g3.Status != "running" { t.Fatalf("want running after approve, got %s", g3.Status) }
	// cancel is terminal
	if err := ws.DagActionCommand(ctx, wshrpc.CommandDagActionData{ChannelId: ch.OID, RunId: run.ID, TaskId: "", Action: "cancel"}); err != nil {
		t.Fatalf("cancel: %v", err)
	}
	g4, _ := ws.DagStatusCommand(ctx, wshrpc.CommandDagStatusData{ChannelId: ch.OID, RunId: run.ID})
	if g4.Status != "cancelled" { t.Fatalf("want cancelled, got %s", g4.Status) }
}
```
(Imports: `pkg/jarvis`, `pkg/orchestrate`, `pkg/waveobj`, `pkg/wshrpc`, `pkg/wstore`, `context`.)

- [ ] **Step 4: Run test to verify it fails**

Run: `go test ./pkg/wshrpc/wshserver/ -run TestDagSubmitAndAction -count=1`
Expected: FAIL (undefined methods).

- [ ] **Step 5: Write the handlers**

`pkg/wshrpc/wshserver/wshserver_dag.go`:
```go
package wshserver

import (
	"context"
	"fmt"
	"time"

	"github.com/wavetermdev/waveterm/pkg/orchestrate"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wcore"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

func (ws *WshServer) DagSubmitCommand(ctx context.Context, data wshrpc.CommandDagSubmitData) (*waveobj.TaskGroup, error) {
	if data.ChannelId == "" || data.RunId == "" || len(data.Tasks) == 0 {
		return nil, fmt.Errorf("channelid, runid and tasks are required")
	}
	run, err := wstore.GetRun(ctx, data.ChannelId, data.RunId)
	if err != nil {
		return nil, fmt.Errorf("loading run: %w", err)
	}
	if run.Mode != "orchestrator" {
		return nil, fmt.Errorf("dag requires an orchestrator-mode run")
	}
	g, err := orchestrate.NewTaskGroup(data.RunId, data.ChannelId, data.Title, data.Parallelism, data.Tasks, time.Now().UnixMilli())
	if err != nil {
		return nil, err
	}
	if err := wstore.AppendDag(ctx, &g); err != nil {
		return nil, fmt.Errorf("appending dag: %w", err)
	}
	if err := wstore.UpdateRun(ctx, data.ChannelId, data.RunId, func(r *waveobj.Run) error {
		r.DagORef = g.OID
		return nil
	}); err != nil {
		return nil, fmt.Errorf("linking dag to run: %w", err)
	}
	wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Dag, g.OID))
	return &g, nil
}

func (ws *WshServer) DagStatusCommand(ctx context.Context, data wshrpc.CommandDagStatusData) (*waveobj.TaskGroup, error) {
	run, err := wstore.GetRun(ctx, data.ChannelId, data.RunId)
	if err != nil {
		return nil, fmt.Errorf("loading run: %w", err)
	}
	if run.DagORef == "" {
		return nil, fmt.Errorf("run has no dag")
	}
	return wstore.GetDag(ctx, run.DagORef)
}

func (ws *WshServer) DagActionCommand(ctx context.Context, data wshrpc.CommandDagActionData) error {
	if data.ChannelId == "" || data.RunId == "" || data.Action == "" {
		return fmt.Errorf("channelid, runid and action are required")
	}
	run, err := wstore.GetRun(ctx, data.ChannelId, data.RunId)
	if err != nil {
		return fmt.Errorf("loading run: %w", err)
	}
	if run.DagORef == "" {
		return fmt.Errorf("run has no dag")
	}
	err = wstore.UpdateDag(ctx, run.DagORef, func(g *waveobj.TaskGroup) error {
		switch data.Action {
		case "approve":
			orchestrate.ApproveGate(g)
		case "sendback":
			orchestrate.SendBackGate(g)
		case "retry":
			if err := orchestrate.RetryTask(g, data.TaskId); err != nil {
				return err
			}
		case "skip":
			if err := orchestrate.SkipTask(g, data.TaskId); err != nil {
				return err
			}
		case "cancel":
			orchestrate.CancelGroup(g)
		default:
			return fmt.Errorf("unknown dag action %q", data.Action)
		}
		g.UpdatedTs = time.Now().UnixMilli()
		return nil
	})
	if err != nil {
		return err
	}
	wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Dag, run.DagORef))
	return nil
}

func (ws *WshServer) DagMergeCommand(ctx context.Context, data wshrpc.CommandDagMergeData) error {
	if data.ChannelId == "" || data.RunId == "" {
		return fmt.Errorf("channelid and runid are required")
	}
	run, err := wstore.GetRun(ctx, data.ChannelId, data.RunId)
	if err != nil {
		return fmt.Errorf("loading run: %w", err)
	}
	sha, err := orchestrate.MergeRunWorktree(ctx, run.ProjectPath, data.RunId, run.Goal)
	if err != nil {
		if errors.Is(err, orchestrate.ErrMergeConflict) {
			// surface as blocked-merge on the task that owns this run
			if run.DagORef != "" {
				if derr := wstore.UpdateDag(ctx, run.DagORef, func(g *waveobj.TaskGroup) error {
					for i := range g.Tasks {
						if g.Tasks[i].RunID == data.RunId {
							g.Tasks[i].State = orchestrate.TaskState_BlockedMerge
						}
					}
					orchestrate.RecomputeDagStatus(g)
					return nil
				}); derr != nil {
					return derr
				}
			}
			return err
		}
		return err
	}
	if err := wstore.UpdateRun(ctx, data.ChannelId, data.RunId, func(r *waveobj.Run) error {
		r.EndCommit = sha
		return nil
	}); err != nil {
		return err
	}
	return jarvis.SealEvidence(ctx, run)
}
```

- [ ] **Step 6: Run tests + codegen**

Run: `go test ./pkg/wshrpc/wshserver/ -run TestDagSubmitAndAction -count=1`
Expected: PASS.
Run: `task generate` then `go build ./...` via `task build:backend`
Expected: builds; `wshclient.Dag*Command` functions now exist.

- [ ] **Step 7: Commit**

`feat(wshrpc): dag submit/status/action/merge commands` — await approval, then commit.

---

### Task 6: pi-tasks import mapping (pure)

**Files:**
- Create: `pkg/orchestrate/import.go`
- Create: `pkg/orchestrate/import_test.go`

**Interfaces:**
- Consumes: `pitasks.Task` (fields `ID, Subject, Description, Status, Owner, Blocks, BlockedBy, CreatedAt, UpdatedAt` — `pkg/pitasks/pitasks.go`), `pitasks.Read(cwd)`.
- Produces: `ImportPitasks(tasks []pitasks.Task) ([]waveobj.TaskNode, error)` — only `pending`/`in_progress` records become tasks (completed/deleted dropped); deps map `BlockedBy` via a stable `t-<id>` mapping.

- [ ] **Step 1: Write the failing test**

`pkg/orchestrate/import_test.go`:
```go
package orchestrate

import (
	"reflect"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/pitasks"
)

func TestImportPitasks(t *testing.T) {
	in := []pitasks.Task{
		{ID: "1", Subject: "setup", Status: "in_progress"},
		{ID: "2", Subject: "api", Status: "pending", BlockedBy: []string{"1"}},
		{ID: "3", Subject: "done already", Status: "completed"},
	}
	nodes, err := ImportPitasks(in)
	if err != nil {
		t.Fatal(err)
	}
	if len(nodes) != 2 {
		t.Fatalf("want 2 nodes, got %d", len(nodes))
	}
	if nodes[0].ID != "t-1" || nodes[0].Label != "setup" {
		t.Fatalf("bad node0: %+v", nodes[0])
	}
	if !reflect.DeepEqual(nodes[1].Deps, []string{"t-1"}) {
		t.Fatalf("bad deps: %+v", nodes[1].Deps)
	}
	if _, err := ImportPitasks(nil); err == nil {
		t.Fatal("empty input must fail validation")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./pkg/orchestrate/ -run TestImportPitasks -count=1`
Expected: FAIL (undefined ImportPitasks).

- [ ] **Step 3: Write the implementation**

`pkg/orchestrate/import.go`:
```go
package orchestrate

import (
	"fmt"

	"github.com/wavetermdev/waveterm/pkg/pitasks"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// ImportPitasks maps pi-tasks records onto DAG task nodes. Only pending/in_progress
// records are scheduled; completed work is left out. pitasks itself stays read-only.
func ImportPitasks(tasks []pitasks.Task) ([]waveobj.TaskNode, error) {
	idOf := func(pid string) string { return "t-" + pid }
	var nodes []waveobj.TaskNode
	for _, t := range tasks {
		switch t.Status {
		case "pending", "in_progress":
		default:
			continue
		}
		node := waveobj.TaskNode{ID: idOf(t.ID), Label: t.Subject}
		for _, b := range t.BlockedBy {
			node.Deps = append(node.Deps, idOf(b))
		}
		nodes = append(nodes, node)
	}
	if err := ValidateTasks(nodes); err != nil {
		return nil, fmt.Errorf("imported tasks invalid: %w", err)
	}
	return nodes, nil
}
```
(ValidateTasks rejects deps on dropped completed records — a pending task blocked on a completed record would fail. If that happens in practice, map completed records to dropped-only deps; the test above doesn't exercise it — leave the strict behavior, it is the safe failure mode.)

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./pkg/orchestrate/ -run TestImportPitasks -count=1`
Expected: PASS.

- [ ] **Step 5: Commit**

`feat(orchestrate): pi-tasks to dag import mapping` — await approval, then commit.

---

### Task 7: wsh CLI — `wsh jarvis dag` subcommands

**Files:**
- Create: `cmd/wsh/cmd/wshcmd-jarvisdag.go`
- Modify: `cmd/wsh/cmd/wshcmd-jarvisask.go` (nothing — just add the new file to the same package; register under the existing `jarvisCmd`)

**Interfaces:**
- Consumes: `wshclient.DagSubmitCommand/DagStatusCommand/DagActionCommand/DagMergeCommand` (generated in Task 5), `orchestrate.ImportPitasks` + `pitasks.Read` (Task 6).
- Produces: `wsh jarvis dag submit|import-tasks|status|approve|sendback|retry|skip|cancel|merge` subcommands.

- [ ] **Step 1: Write the CLI**

`cmd/wsh/cmd/wshcmd-jarvisdag.go` — follow `wshcmd-jarvisask.go` exactly (cobra, `PreRunE: preRunSetupRpcClient`, `jarvisCmd.AddCommand`):
```go
package cmd

import (
	"encoding/json"
	"fmt"
	"os"

	"github.com/spf13/cobra"
	"github.com/wavetermdev/waveterm/pkg/orchestrate"
	"github.com/wavetermdev/waveterm/pkg/pitasks"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshrpc/wshclient"
)

var jarvisDagCmd = &cobra.Command{
	Use:   "dag",
	Short: "orchestration engine: submit/steer a task DAG",
	Args:  cobra.NoArgs,
	RunE:  func(cmd *cobra.Command, args []string) error { return cmd.Help() },
}

var dagSubmitCmd = &cobra.Command{
	Use:     "submit <dag-json>",
	Short:   "validate and submit a DAG for the current run",
	Args:    cobra.ExactArgs(1),
	PreRunE: preRunSetupRpcClient,
	RunE: func(cmd *cobra.Command, args []string) error {
		var data wshrpc.CommandDagSubmitData
		if err := json.Unmarshal([]byte(args[0]), &data); err != nil {
			return fmt.Errorf("dag json: %w", err)
		}
		g, err := wshclient.DagSubmitCommand(RpcClient, data, &wshrpc.RpcOpts{Timeout: 20_000})
		if err != nil {
			return err
		}
		fmt.Printf("dag %s submitted (%d tasks, parallelism %d)\n", g.ID, len(g.Tasks), g.Parallelism)
		return nil
	},
}

var dagImportCmd = &cobra.Command{
	Use:     "import-tasks [--dir <cwd>]",
	Short:   "submit a DAG from the pi-tasks store in <cwd> (default .)",
	Args:    cobra.NoArgs,
	PreRunE: preRunSetupRpcClient,
	RunE: func(cmd *cobra.Command, args []string) error {
		dir, _ := cmd.Flags().GetString("dir")
		if dir == "" {
			dir = "."
		}
		tasks, err := pitasks.Read(dir)
		if err != nil {
			return fmt.Errorf("reading pi-tasks: %w", err)
		}
		nodes, err := orchestrate.ImportPitasks(tasks)
		if err != nil {
			return err
		}
		runId, _ := cmd.Flags().GetString("runid")
		channelId, _ := cmd.Flags().GetString("channel")
		if runId == "" || channelId == "" {
			return fmt.Errorf("--runid and --channel are required")
		}
		g, err := wshclient.DagSubmitCommand(RpcClient, wshrpc.CommandDagSubmitData{
			ChannelId: channelId, RunId: runId, Parallelism: 2, Tasks: nodes,
		}, &wshrpc.RpcOpts{Timeout: 20_000})
		if err != nil {
			return err
		}
		fmt.Printf("dag %s submitted from %d pi-tasks\n", g.ID, len(g.Tasks))
		return nil
	},
}

var dagStatusCmd = &cobra.Command{
	Use:     "status --runid <id> --channel <id>",
	Short:   "print the engine-owned DAG status snapshot",
	Args:    cobra.NoArgs,
	PreRunE: preRunSetupRpcClient,
	RunE: func(cmd *cobra.Command, args []string) error {
		runId, _ := cmd.Flags().GetString("runid")
		channelId, _ := cmd.Flags().GetString("channel")
		g, err := wshclient.DagStatusCommand(RpcClient, wshrpc.CommandDagStatusData{ChannelId: channelId, RunId: runId}, &wshrpc.RpcOpts{Timeout: 10_000})
		if err != nil {
			return err
		}
		out, _ := json.MarshalIndent(g, "", "  ")
		fmt.Println(string(out))
		return nil
	},
}

func dagAction(action string) *cobra.Command {
	return &cobra.Command{
		Use:     fmt.Sprintf("%s <task-id>", action),
		Short:   fmt.Sprintf("dag action: %s", action),
		Args:    cobra.ExactArgs(1),
		PreRunE: preRunSetupRpcClient,
		RunE: func(cmd *cobra.Command, args []string) error {
			runId, _ := cmd.Flags().GetString("runid")
			channelId, _ := cmd.Flags().GetString("channel")
			return wshclient.DagActionCommand(RpcClient, wshrpc.CommandDagActionData{
				ChannelId: channelId, RunId: runId, TaskId: args[0], Action: action,
			}, &wshrpc.RpcOpts{Timeout: 10_000})
		},
	}
}

var dagMergeCmd = &cobra.Command{
	Use:     "merge --runid <id> --channel <id>",
	Short:   "squash-merge the run's worktree back into the project branch",
	Args:    cobra.NoArgs,
	PreRunE: preRunSetupRpcClient,
	RunE: func(cmd *cobra.Command, args []string) error {
		runId, _ := cmd.Flags().GetString("runid")
		channelId, _ := cmd.Flags().GetString("channel")
		return wshclient.DagMergeCommand(RpcClient, wshrpc.CommandDagMergeData{ChannelId: channelId, RunId: runId}, &wshrpc.RpcOpts{Timeout: 60_000})
	},
}

func init() {
	jarvisDagCmd.AddCommand(dagSubmitCmd, dagImportCmd, dagStatusCmd, dagMergeCmd)
	jarvisDagCmd.AddCommand(dagAction("approve"), dagAction("sendback"), dagAction("retry"), dagAction("skip"), dagAction("cancel"))
	for _, c := range jarvisDagCmd.Commands() {
		c.Flags().String("runid", "", "run id")
		c.Flags().String("channel", "", "channel id")
	}
	dagImportCmd.Flags().String("dir", "", "pi-tasks dir (default .)")
	jarvisCmd.AddCommand(jarvisDagCmd)
}
```

- [ ] **Step 2: Build + verify**

Run: `task build:backend`
Expected: builds. Then `dist/bin/wsh.exe jarvis dag --help` (or the built `wsh` binary) lists the subcommands.

- [ ] **Step 3: Commit**

`feat(wsh): jarvis dag subcommands` — await approval, then commit.

---

### Task 8: Engine scheduling loop (spawn + react to child completion)

**Files:**
- Create: `pkg/orchestrate/engine.go`
- Modify: `pkg/wshrpc/wshserver/wshserver_dag.go` (call `ScheduleOnce` after submit/action)
- Modify: `pkg/wshrpc/wshserver/wshserver_runs.go` (call `ScheduleOnce` when a child run of a dag run reaches a terminal status — at the `ParentNotifyLine` sites, lines ~487 and ~576)

**Interfaces:**
- Consumes: Task 2/3 pure functions, Task 4 worktree funcs, `jarvis.SpawnRunWorker` (var, stubbable), `wstore.GetRun/UpdateRun/GetDag/UpdateDag`, `wcore.SendWaveObjUpdate`, `gitinfo.HeadCommit`.
- Produces: `ScheduleOnce(ctx context.Context, g *waveobj.TaskGroup) error` — the engine step: derive states from child runs, count failures, spawn ready tasks (in worktrees when git), persist, publish, emit events; `GroupForRun(ctx, runID) (*waveobj.TaskGroup, error)`.

- [ ] **Step 1: Write the failing test**

`pkg/orchestrate/engine_test.go` — uses the pure pieces with a stubbed `SpawnRunWorker`-equivalent seam. `ScheduleOnce` must not spawn directly; it calls a package var `spawnWorker` (stubbable, mirrors `jarvis.SpawnRunWorker` which is itself a var):
```go
package orchestrate

import (
	"context"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

var spawnWorker = func(ctx context.Context, runtime, workspaceId, projectName, cwd, prompt string) (string, error) {
	return "tab:worker", nil
}

func TestScheduleOnceSpawnsUpToCap(t *testing.T) {
	g, _ := NewTaskGroup("run-1", "g", 2, []waveobj.TaskNode{
		{ID: "t-0", Label: "a"},
		{ID: "t-1", Label: "b", Deps: []string{"t-0"}},
		{ID: "t-2", Label: "c", Deps: []string{"t-0"}},
	}, 1)
	spawned := map[string]string{}
	old := spawnWorker
	spawnWorker = func(ctx context.Context, runtime, workspaceId, projectName, cwd, prompt string) (string, error) {
		spawned[prompt] = cwd
		return "tab:" + prompt, nil
	}
	defer func() { spawnWorker = old }()
	if err := ScheduleOnce(context.Background(), g); err != nil {
		t.Fatal(err)
	}
	if len(spawned) != 1 {
		t.Fatalf("cap 2 with zero running must spawn 2 (t-1, t-2); got %d", len(spawned))
	}
	// t-1 done -> t-2 already running; nothing new to spawn
	g.Tasks[1].State = TaskState_Done
	if err := ScheduleOnce(context.Background(), g); err != nil {
		t.Fatal(err)
	}
}
```
(This test's expectations: with cap 2 and no running tasks, exactly 2 spawns; the second call spawns none. `ScheduleOnce` derives states from the group's own task states when no runs map is provided — the pure `DeriveTaskStates` is applied only when the caller passes runs; engine.go reads children from wstore in production but the test path uses task states directly.)

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./pkg/orchestrate/ -run TestScheduleOnce -count=1`
Expected: FAIL (undefined ScheduleOnce).

- [ ] **Step 3: Write the implementation**

`pkg/orchestrate/engine.go`:
```go
package orchestrate

import (
	"context"
	"fmt"
	"time"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wcore"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// DagEvent kinds published on the wps broker (mirrored in the cockpit events rail).
const (
	DagEventChildDone   = "dag:child-done"
	DagEventGateOpen    = "dag:gate-open"
	DagEventBlocked     = "dag:dag-blocked"
	DagEventComplete    = "dag:dag-complete"
	DagEventTaskSpawned = "dag:task-spawned"
)

// ScheduleOnce advances the DAG one step: derive task states from child runs, count
// consecutive failures, spawn ready tasks (managed worktrees when the project is git),
// persist, and publish waveobj + event updates. Idempotent — safe to call repeatedly.
func ScheduleOnce(ctx context.Context, g *waveobj.TaskGroup) error {
	owner, err := wstore.GetRun(ctx, g.ChannelId, g.RunID)
	if err != nil {
		return fmt.Errorf("loading owning run: %w", err)
	}
	runs := map[string]*waveobj.Run{}
	for i := range g.Tasks {
		t := &g.Tasks[i]
		if t.RunID == "" {
			continue
		}
		if run, rerr := wstore.GetRun(ctx, g.ChannelId, t.RunID); rerr == nil {
			runs[t.RunID] = run
		}
	}
	DeriveTaskStates(g, runs)
	// failure accounting: a running task whose child turned failed increments the counter
	for i := range g.Tasks {
		if g.Tasks[i].State == TaskState_Failed && g.Tasks[i].RunID != "" {
			g.Failures++
			g.Tasks[i].RunID = "" // allow retry re-spawn
		}
	}
	for _, taskID := range NextToSpawn(g) {
		task := taskByID(g, taskID)
		cwd := owner.ProjectPath
		if IsGitRepo(owner.ProjectPath) {
			wt, err := CreateRunWorktree(ctx, owner.ProjectPath, owner.ID+"-"+taskID, owner.BaseCommit)
			if err != nil {
				g.Tasks[taskIdx(g, taskID)].State = TaskState_Failed
				continue
			}
			cwd = wt
		}
		prompt := taskPrompt(task, owner)
		oref, err := spawnWorker(ctx, owner.Runtime, owner.WorkspaceId, "", cwd, prompt)
		if err != nil {
			g.Tasks[taskIdx(g, taskID)].State = TaskState_Failed
			continue
		}
		_ = oref
		childRun := childRunFromSpec(g, task, owner)
		if err := wstore.AppendRun(ctx, g.ChannelId, childRun); err != nil {
			return err
		}
		if err := MarkRunning(g, taskID, childRun.ID); err != nil {
			return err
		}
		publishDagEvent(DagEventTaskSpawned, g, taskID)
	}
	RecomputeDagStatus(g)
	g.UpdatedTs = time.Now().UnixMilli()
	if err := wstore.UpdateDag(ctx, g.OID, func(cur *waveobj.TaskGroup) error {
		*cur = *g
		return nil
	}); err != nil {
		return err
	}
	wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Dag, g.OID))
	return nil
}
```
Supporting helpers in the same file: `taskByID`, `taskIdx`, `taskPrompt` (task.RunSpec.Goal or task.Label; empty principles), `childRunFromSpec` (builds `waveobj.Run{Goal: taskPrompt, Mode: task.RunSpec.Mode or "quick", Runtime: task.RunSpec.Runtime or owner.Runtime, ChannelOID: g.ChannelId, DagORef: g.OID, ...}` — **the child carries `DagORef` so `GroupForRun` resolves it**), `publishDagEvent` (wps.Broker.Publish with a `WaveEvent{event: kind, scopes: [dag oref, run oref]}`), `GroupForRun(ctx, channelId, runID) (*waveobj.TaskGroup, error)` = `wstore.GetRun(ctx, channelId, runID)` → `run.DagORef` → `wstore.GetDag`. `spawnWorker` must stay a package var (declared in engine.go, defaulting to `jarvis.SpawnRunWorker`) so the test stub works: `var spawnWorker = jarvis.SpawnRunWorker`.

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./pkg/orchestrate/ -run TestScheduleOnce -count=1`
Expected: PASS (with the spawn stub; no real git/worktree in this test because the project path is empty — guard `IsGitRepo("")` returns false).

- [ ] **Step 5: Wire the triggers**

In `pkg/wshrpc/wshserver/wshserver_dag.go`: after `DagSubmitCommand` persists (before returning), load the group and call `orchestrate.ScheduleOnce(ctx, g)` (log-only error handling: `if err != nil { log.Printf(...) }` — scheduling is retried on the next trigger). Same in `DagActionCommand` after the action mutates (for approve/sendback/retry/skip — cancel skips scheduling).

In `pkg/wshrpc/wshserver/wshserver_runs.go` at the two `ParentNotifyLine` sites (lines ~487, ~576, where a child run reaches a terminal status): after the existing handling, add:
```go
if grp, gerr := orchestrate.GroupForRun(ctx, run.ChannelOID, run.ID); gerr == nil {
    if serr := orchestrate.ScheduleOnce(ctx, grp); serr != nil {
        log.Printf("dag schedule error: %v", serr)
    }
}
```

- [ ] **Step 6: Verify build + tests**

Run: `go test ./pkg/orchestrate/ ./pkg/wshrpc/wshserver/ -count=1` and `task build:backend`
Expected: PASS + build.

- [ ] **Step 7: Commit**

`feat(orchestrate): scheduling loop + child-run triggers` — await approval, then commit.

---

### Task 9: Control-dir events for the pi lead

**Files:**
- Create: `pkg/orchestrate/control.go`
- Create: `pkg/orchestrate/control_test.go`
- Modify: `pi/extensions/waveterm-tools-core.ts` (add pure `dagEventMessage(kind, detail)` helper) + `pi/extensions/waveterm-tools-core.test.ts`
- Modify: `pi/extensions/waveterm-tools.ts` (watcher switch: handle `child_done`, `gate_open`, `dag_blocked`, `dag_complete`)

**Interfaces:**
- Consumes: Task 8 event kinds.
- Produces: `NotifyLead(ctx context.Context, g *waveobj.TaskGroup, kind, detail string) error` (Go); pi-side watcher cases.

- [ ] **Step 1: Write the failing test**

`pkg/orchestrate/control_test.go`:
```go
package orchestrate

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func TestControlMessageShape(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("WAVETERM_PI_CONTROL_DIR", dir)
	g, _ := NewTaskGroup("run-1", "g", 2, []waveobj.TaskNode{{ID: "t-0", Label: "a"}}, 1)
	if err := NotifyLead(context.Background(), &g, DagEventGateOpen, "t-0"); err != nil {
		t.Fatal(err)
	}
	files, _ := os.ReadDir(dir)
	// with no resolvable lead session the write is skipped silently (non-fatal), so this
	// test asserts the message-builder, not the write: see controlMessage in control.go
	msg := controlMessage(DagEventGateOpen, "t-0")
	if !strings.Contains(msg, `"cmd": "gate_open"`) {
		t.Fatalf("bad message: %s", msg)
	}
}
```
(Adjust: `controlMessage` is the pure builder; `NotifyLead` resolves the lead session id from the owning run's worker oref agent-status and writes `<dir>/<controlFileName(sessionId)>.json`. If resolution fails it returns nil — non-fatal per spec.)

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./pkg/orchestrate/ -run TestControlMessageShape -count=1`
Expected: FAIL (undefined controlMessage).

- [ ] **Step 3: Write the implementation**

`pkg/orchestrate/control.go`:
```go
package orchestrate

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// controlFileName mirrors pi/extensions/waveterm-tools.ts (sessionId -> <sessionId>.json).
func controlFileName(sessionID string) string { return sessionID + ".json" }

// controlMessage builds the control-file payload the pi watcher understands: {"cmd": ..., "content": ...}.
func controlMessage(kind, detail string) string {
	cmd := map[string]string{
		DagEventChildDone:   "child_done",
		DagEventGateOpen:    "gate_open",
		DagEventBlocked:     "dag_blocked",
		DagEventComplete:    "dag_complete",
		DagEventTaskSpawned: "task_spawned",
	}[kind]
	payload := map[string]any{"cmd": cmd, "content": detail, "ts": time.Now().UnixMilli()}
	out, _ := json.Marshal(payload)
	return string(out)
}

// NotifyLead writes a control event for the lead pi session of the owning run. The lead
// session id is resolved from the run's worker oref; unresolvable -> no-op (non-fatal).
func NotifyLead(ctx context.Context, g *waveobj.TaskGroup, kind, detail string) error {
	if dir := os.Getenv("WAVETERM_PI_CONTROL_DIR"); dir == "" {
		return nil
	}
	sessionID := resolveLeadSessionID(ctx, g.RunID)
	if sessionID == "" {
		return nil
	}
	path := filepath.Join(os.Getenv("WAVETERM_PI_CONTROL_DIR"), controlFileName(sessionID))
	return os.WriteFile(path, []byte(controlMessage(kind, detail)), 0o644)
}

// resolveLeadSessionID finds the pi session id of the owning run's lead worker. The
// pi extension reports its session id in the agent status detail (see
// pi/extensions/waveterm-status.ts — the session id field it sends on status events;
// grep that file for the exact key before writing this function). v1 resolution:
// load the run's phase-0 WorkerOrefs, read the tab's meta (the runexec.go keys
// session:agent etc.), and return the session id from the last agent:status event for
// that worker (baseds.AgentStatusData). Empty when the lead is not pi or the status
// is missing — the notification is then skipped (non-fatal by design).
func resolveLeadSessionID(ctx context.Context, runID string) string {
	return ""
}
```
`resolveLeadSessionID` is the one deliberate seam: it must be wired by grepping `pi/extensions/waveterm-status.ts` for the session-id field the extension reports and reading it from the run's worker tab meta (keys set in `pkg/jarvis/runexec.go`). If the session id genuinely is not stored anywhere reachable from the backend, leave the resolver returning "" and note it in the commit message — the cockpit/attention path works without lead notifications.

Then in `ScheduleOnce` (Task 8 file), after status derivation:
```go
switch g.Status {
case DagStatus_AwaitingReview:
    publishDagEvent(DagEventGateOpen, g, "")
    _ = NotifyLead(ctx, g, DagEventGateOpen, fmt.Sprintf("gate %s", gatedTaskID(g)))
case DagStatus_Blocked:
    publishDagEvent(DagEventBlocked, g, "")
    _ = NotifyLead(ctx, g, DagEventBlocked, fmt.Sprintf("%d failures", g.Failures))
case DagStatus_Done:
    publishDagEvent(DagEventComplete, g, "")
    _ = NotifyLead(ctx, g, DagEventComplete, "all tasks done")
}
```
And when a child reaches done (derive step): `NotifyLead(ctx, g, DagEventChildDone, taskID)` + `publishDagEvent(DagEventChildDone, g, taskID)`. Add `gatedTaskID(g)` helper.

- [ ] **Step 4: Pi extension — core helper + test**

In `pi/extensions/waveterm-tools-core.ts` add:
```ts
// dagEventMessage maps an engine dag event kind to a watcher-visible notification line.
export function dagEventMessage(kind: string, detail: string): string {
    const labels: Record<string, string> = {
        "dag:child-done": "child done",
        "dag:gate-open": "gate open — review in cockpit",
        "dag:dag-blocked": "dag blocked",
        "dag:dag-complete": "dag complete",
    };
    const label = labels[kind] ?? kind;
    return detail ? `${label}: ${detail}` : label;
}
```
In `pi/extensions/waveterm-tools-core.test.ts` add cases asserting the label mapping. In `pi/extensions/waveterm-tools.ts` watcher switch add:
```ts
case "child_done":
case "gate_open":
case "dag_blocked":
case "dag_complete":
    await notify(dagEventMessage(cmd.cmd, cmd.content ?? ""));
    break;
```

- [ ] **Step 5: Run tests + prettier**

Run: `go test ./pkg/orchestrate/ -run TestControlMessageShape -count=1`
Run: `npx vitest run pi/extensions/waveterm-tools-core.test.ts`
Run: `npx prettier --check pi/extensions/waveterm-tools.ts pi/extensions/waveterm-tools-core.ts`
Expected: PASS / PASS / clean.

- [ ] **Step 6: Commit**

`feat(orchestrate): control-dir lead events + pi watcher kinds` — await approval, then commit.

---

### Task 10: Pi-first lead prompt variant

**Files:**
- Modify: `pkg/jarvis/run.go` (`BuildOrchestratePrompt` gains a `runtime string` param; pi branch adds the dag-verbs paragraph)
- Modify: `pkg/jarvis/runexec.go` (`phasePrompt` passes `run.Runtime`)
- Create: `pkg/jarvis/run_dagprompt_test.go`

**Interfaces:**
- Consumes: nothing new.
- Produces: `BuildOrchestratePrompt(goal string, principles waveobj.PrincipleList, gate bool, runtime string) string` — pi runtime includes the DAG instructions; other runtimes unchanged.

- [ ] **Step 1: Write the failing test**

`pkg/jarvis/run_dagprompt_test.go`:
```go
package jarvis

import (
	"strings"
	"testing"
)

func TestBuildOrchestratePromptPiHasDagVerbs(t *testing.T) {
	p := BuildOrchestratePrompt("ship auth", nil, true, "pi")
	for _, want := range []string{"wsh jarvis dag import-tasks", "wsh jarvis dag status", "respond to control events"} {
		if !strings.Contains(p, want) {
			t.Errorf("pi prompt missing %q", want)
		}
	}
	if strings.Contains(p, "typed into your terminal") {
		t.Errorf("pi prompt must not carry the claude babysitting language")
	}
}

func TestBuildOrchestratePromptClaudeUnchanged(t *testing.T) {
	p := BuildOrchestratePrompt("ship auth", nil, true, "claude")
	if strings.Contains(p, "wsh jarvis dag import-tasks") {
		t.Errorf("claude prompt must not mention dag verbs")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./pkg/jarvis/ -run TestBuildOrchestratePrompt -count=1`
Expected: FAIL (signature mismatch / undefined).

- [ ] **Step 3: Implement**

In `pkg/jarvis/run.go`, change the signature to `func BuildOrchestratePrompt(goal string, principles waveobj.PrincipleList, gate bool, runtime string) string` and add a pi branch at the top of the prompt body:
```go
if runtime == "pi" {
    b.WriteString("You are the lead orchestrator for this goal, running under pi with the waveterm bridge.\n")
    if gate {
        b.WriteString("Plan the work with the superpowers:writing-plans approach, write the plan as pi-tasks records (blocks/blockedby set), then run `wsh jarvis dag import-tasks` to submit the DAG to the engine. The engine schedules children, enforces dependencies and the parallelism cap, and wakes you with control events (child_done, gate_open, dag_blocked, dag_complete) — do not babysit children, never open their transcripts. At a gate, wait for the human to approve in the cockpit (or run `wsh jarvis dag approve <task>` yourself only for decisions the prompt marks as yours). Use `wsh jarvis dag status` for detail. Engine DAG = isolated parallel units; pi-subagents = in-context helpers only.\n")
    } else {
        b.WriteString("Size up the goal: if it is a small well-understood change, run `wsh jarvis triage quick \"<reason>\"` and do it directly. Otherwise plan it (writing-plans), write the plan as pi-tasks records, and run `wsh jarvis dag import-tasks`; the engine schedules children and wakes you with control events — do not babysit. `wsh jarvis dag status` for detail.\n")
    }
    b.WriteString("When the goal is fully accomplished, commit your work and run `wsh jarvis complete --commit $(git rev-parse HEAD)`.\n")
    return strings.TrimRight(b.String(), "\n")
}
```
Keep the existing claude/codex path exactly as-is (the current body) for other runtimes.

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./pkg/jarvis/ -run TestBuildOrchestratePrompt -count=1`
Expected: PASS. (Existing prompt tests in `run_test.go` — update any that call the old signature.)

- [ ] **Step 5: Commit**

`feat(jarvis): pi-first orchestrator lead prompt with dag verbs` — await approval, then commit.

---

### Task 11: Attention integration

**Files:**
- Modify: `pkg/jarvis/attention.go` (`BuildAttention` — add dag gate/blocked items)
- Create: `pkg/jarvis/attention_dag_test.go`

**Interfaces:**
- Consumes: Task 2 status constants; existing `AttentionInput`/`AttentionItem` shapes (`pkg/wshrpc` — check `AttentionItem` fields with `grep -n "type AttentionItem struct" -A 12 pkg/wshrpc/wshrpctypes*.go` first).
- Produces: dag items in `BuildAttention` output with kind `dag-gate` / `dag-blocked`.

- [ ] **Step 1: Write the failing test**

`pkg/jarvis/attention_dag_test.go` (build an `AttentionInput` per existing `attention_test.go` setup, add a TaskGroup in awaiting-review state):
```go
func TestBuildAttentionDagGate(t *testing.T) {
	in := AttentionInput{ /* mirror attention_test.go's minimal input */ }
	in.Dags = []*waveobj.TaskGroup{dagWithStatus("dag-gate")}
	out := BuildAttention(in)
	found := false
	for _, it := range out {
		if it.Kind == "dag-gate" { found = true }
	}
	if !found {
		t.Fatalf("dag-gate attention item missing: %+v", out)
	}
}
```
(Adjust to the actual `AttentionItem`/`AttentionInput` field names found by the grep — `Dags` may be added as a new input field.)

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./pkg/jarvis/ -run TestBuildAttentionDagGate -count=1`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `pkg/jarvis/attention.go`: add a `Dags []*waveobj.TaskGroup` field to `AttentionInput` (if it is an input struct) or load dag groups for the runs already in scope (follow whichever existing pattern the function uses — it already loads runs for review gates). For each group: `Status == awaiting-review` → item `{Kind: "dag-gate", text: "gate: <run goal>", oref: dagORef}`; `Status == blocked` → `{Kind: "dag-blocked", ...}`. Order with the existing oldest-first policy.

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./pkg/jarvis/ -run "TestBuildAttention" -count=1`
Expected: PASS (existing + new).

- [ ] **Step 5: Commit**

`feat(jarvis): dag gates and blocks in the attention feed` — await approval, then commit.

---

### Task 12: Frontend store — dagstore atoms + view data (pure)

**Files:**
- Modify: `package.json` (add `@xyflow/react`)
- Create: `frontend/app/view/orchestrate/dagstore.ts`
- Create: `frontend/app/view/orchestrate/dagstore.test.ts`

**Interfaces:**
- Consumes: `wos.ts` (`useWaveObjectValue`), `RpcApi.DagActionCommand/DagMergeCommand` (generated), `waveobj.TaskGroup` TS type (generated).
- Produces: `dagViewOrefAtom` (`string | null`, `openDag(oref)`, `closeDag()`); `selectedTaskIdAtom`; `useDagGroup(oref)` hook; `buildViewData(group: TaskGroup): {nodes: DagViewNode[]; edges: DagViewEdge[]}` pure fn — `DagViewNode {id, label, state, gate, failed, meta, actions}`; `DagViewEdge {source, target}`.

- [ ] **Step 1: Install the dependency**

Run: `npm install @xyflow/react@^12`
Expected: `@xyflow/react` in `package.json` dependencies.

- [ ] **Step 2: Write the failing test**

`frontend/app/view/orchestrate/dagstore.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { buildViewData } from "./dagstore";

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

describe("buildViewData", () => {
    it("maps tasks to nodes and deps to edges", () => {
        const { nodes, edges } = buildViewData(group);
        expect(nodes).toHaveLength(4);
        expect(edges).toEqual([
            { source: "t-0", target: "t-1" },
            { source: "t-1", target: "t-2" },
            { source: "t-2", target: "t-3" },
        ]);
        // done, non-gate, unreleased -> merge action
        expect(nodes[0].actions).toEqual(["merge"]);
    });
    it("flags gate and failure states", () => {
        const { nodes } = buildViewData(group);
        const ship = nodes.find((n) => n.id === "t-2")!;
        expect(ship.gate).toBe(true);
        expect(ship.actions).toEqual(["approve", "sendback"]);
        const perf = nodes.find((n) => n.id === "t-3")!;
        expect(perf.actions).toEqual(["retry", "skip"]);
    });
});
```
(State→actions mapping: running→[], done→merge (when unmerged), gate-done→[approve, sendback], failed→[retry, skip], blocked-merge→[resolve].)

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run frontend/app/view/orchestrate/dagstore.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 4: Implement**

`frontend/app/view/orchestrate/dagstore.ts`:
```ts
import { atom } from "jotai";
import { globalStore } from "../../store/jotaiStore";
import { useWaveObjectValue } from "../../store/wos";
import type { TaskGroup } from "../../../types/gotypes";

export const dagViewOrefAtom = atom<string | null>(null);
export const selectedTaskIdAtom = atom<string | null>(null);

export function openDag(oref: string) {
    globalStore.set(dagViewOrefAtom, oref);
    globalStore.set(selectedTaskIdAtom, null);
}
export function closeDag() {
    globalStore.set(dagViewOrefAtom, null);
    globalStore.set(selectedTaskIdAtom, null);
}
```

```ts
export interface DagViewNode {
    id: string;
    label: string;
    state: string;
    gate: boolean;
    meta: string; // worktree / evidence line
    actions: string[]; // approve | sendback | retry | skip | merge
}
export interface DagViewEdge { source: string; target: string }

const ACTION_BY_STATE: Record<string, string[]> = {
    "blocked-merge": ["resolve"],
    failed: ["retry", "skip"],
};
const GATE_DONE_ACTIONS = ["approve", "sendback"];

export function buildViewData(group: TaskGroup): { nodes: DagViewNode[]; edges: DagViewEdge[] } {
    const nodes: DagViewNode[] = group.tasks.map((t) => {
        let actions = ACTION_BY_STATE[t.state] ?? [];
        if (t.gate && t.state === "done") actions = GATE_DONE_ACTIONS;
        if (t.state === "done" && !t.gate && !t.released) actions = ["merge"];
        return {
            id: t.id,
            label: t.label,
            state: t.state,
            gate: t.gate,
            meta: t.runid ? `wave/${t.runid}` : "",
            actions,
        };
    });
    const edges: DagViewEdge[] = [];
    for (const t of group.tasks) {
        for (const d of t.deps ?? []) edges.push({ source: d, target: t.id });
    }
    return { nodes, edges };
}

export function useDagGroup(oref: string) {
    return useWaveObjectValue<TaskGroup>(oref);
}
```
(`released` needs the TS field from Task 3's codegen — regenerate first.)

- [ ] **Step 5: Run tests + typecheck**

Run: `npx vitest run frontend/app/view/orchestrate/dagstore.test.ts`
Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Run: `npx prettier --check frontend/app/view/orchestrate/dagstore.ts`
Expected: PASS / 0 errors / clean.

- [ ] **Step 6: Commit**

`feat(cockpit): dag store atoms + view data mapping` — await approval, then commit.

---

### Task 13: Layered graph layout (pure)

**Files:**
- Create: `frontend/app/view/orchestrate/daglayout.ts`
- Create: `frontend/app/view/orchestrate/daglayout.test.ts`

**Interfaces:**
- Consumes: Task 12 `buildViewData` output shape (ids + deps).
- Produces: `computeLayeredLayout(tasks: {id: string; deps?: string[]}[], opts?: {width?: number; height?: number; gapX?: number; gapY?: number}): Map<string, {x: number; y: number}>`.

- [ ] **Step 1: Write the failing test**

`frontend/app/view/orchestrate/daglayout.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { computeLayeredLayout } from "./daglayout";

const tasks = [
    { id: "t-0", deps: [] },
    { id: "t-1", deps: ["t-0"] },
    { id: "t-2", deps: ["t-0"] },
    { id: "t-3", deps: ["t-1", "t-2"] },
];

describe("computeLayeredLayout", () => {
    it("assigns layers by longest path", () => {
        const pos = computeLayeredLayout(tasks, { width: 100, height: 40, gapX: 20, gapY: 30 });
        const y = (id: string) => pos.get(id)!.y;
        expect(y("t-0")).toBeLessThan(y("t-1"));
        expect(y("t-1")).toBe(y("t-2"));
        expect(y("t-2")).toBeLessThan(y("t-3"));
    });
    it("is deterministic and places siblings side by side", () => {
        const a = computeLayeredLayout(tasks);
        const b = computeLayeredLayout(tasks);
        expect([...a.entries()]).toEqual([...b.entries()]);
        const x = (id: string) => a.get(id)!.x;
        expect(x("t-1")).not.toBe(x("t-2"));
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run frontend/app/view/orchestrate/daglayout.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

`frontend/app/view/orchestrate/daglayout.ts`:
```ts
// Layered (longest-path) layout for the dag graph. Pure: same input, same positions.
export interface LayoutOpts {
    width?: number;
    height?: number;
    gapX?: number;
    gapY?: number;
}

export function computeLayeredLayout(
    tasks: { id: string; deps?: string[] }[],
    opts: LayoutOpts = {},
): Map<string, { x: number; y: number }> {
    const { width = 168, height = 64, gapX = 28, gapY = 48 } = opts;
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const layer = new Map<string, number>();
    const visit = (id: string): number => {
        const cached = layer.get(id);
        if (cached !== undefined) return cached;
        const t = byId.get(id)!;
        let l = 0;
        for (const d of t.deps ?? []) l = Math.max(l, visit(d) + 1);
        layer.set(id, l);
        return l;
    };
    for (const t of tasks) visit(t.id);
    const byLayer = new Map<number, string[]>();
    for (const t of tasks) {
        const l = layer.get(t.id)!;
        byLayer.set(l, [...(byLayer.get(l) ?? []), t.id]);
    }
    const out = new Map<string, { x: number; y: number }>();
    for (const [l, ids] of [...byLayer.entries()].sort((a, b) => a[0] - b[0])) {
        const sorted = [...ids].sort();
        const total = sorted.length * width + (sorted.length - 1) * gapX;
        sorted.forEach((id, i) => {
            out.set(id, { x: -total / 2 + i * (width + gapX) + width / 2, y: l * (height + gapY) });
        });
    }
    return out;
}
```
(Coordinates are relative to the graph origin — React Flow centers on `fitView`; negative x is fine.)

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run frontend/app/view/orchestrate/daglayout.test.ts`
Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: PASS / 0 errors.

- [ ] **Step 5: Commit**

`feat(cockpit): layered dag layout pure function` — await approval, then commit.

---

### Task 14: Graph surface — React Flow view + wiring

**Files:**
- Create: `frontend/app/view/orchestrate/daggraph.tsx` (the view: ReactFlow canvas, custom `DagTaskNode`, detail rail, zoom controls, j/k selection)
- Create: `frontend/app/view/orchestrate/daggraph-header.tsx` (thin header: run goal, status pills, cancel)
- Modify: `frontend/app/view/agents/agents.tsx` (view model gains `dagViewOrefAtom` usage; surface render switches to the graph when open — follow how `cockpitsurface.tsx` renders surfaces)
- Modify: `frontend/app/view/agents/runworkercard.tsx` + `agentrow.tsx` ("Open DAG" button when the run has `dagoref`)
- Modify: `frontend/app/cockpit/cockpit-root.tsx` or `cockpitsurface.tsx` (render `<DagGraphView/>` overlay when `dagViewOrefAtom` is set)

**Interfaces:**
- Consumes: Task 12 (`dagViewOrefAtom`, `useDagGroup`, `buildViewData`, `selectedTaskIdAtom`), Task 13 (`computeLayeredLayout`), `RpcApi.DagActionCommand/DagMergeCommand`, `wos.useWaveObjectValue`.
- Produces: `<DagGraphView/>` (opens when `dagViewOrefAtom` set; back clears it).

- [ ] **Step 1: Write the view**

`frontend/app/view/orchestrate/daggraph.tsx` — structure per the approved mockup (`docs/prototype` reference + `orchestrate-graph.html`):
- `ReactFlow` from `@xyflow/react` (import `@xyflow/react/dist/style.css`), `nodesDraggable={false}`, `nodesConnectable={false}`, `fitView`, `fitViewOptions={{padding: 0.2}}`, `proOptions={{hideAttribution: true}}`, `onNodeClick` → `globalStore.set(selectedTaskIdAtom, id)`, `colorMode="dark"`.
- Nodes: `buildViewData(group)` + `computeLayeredLayout(group.tasks)` → `{id, position, data, type: "dagTask"}`; `nodeTypes={{ dagTask: DagTaskNode }}`.
- `DagTaskNode` renders the mockup anatomy: state pill (running/ready/gate/failed/done), mono id, label, meta (`wave/<runid>` or evidence), progress bar when running, and action buttons from `node.data.actions` wired to `RpcApi.DagActionCommand` / `RpcApi.DagMergeCommand` (approve/sendback/retry/skip/merge).
- Edges: `buildViewData().edges` → `{id, source, target, markerEnd: {type: MarkerType.ArrowClosed}, style: {stroke: "#6b7482"}}`; failed-task incoming edges red dashed.
- Zoom controls: small cluster (fit / + / −) calling `useReactFlow().fitView()/zoomIn()/zoomOut()`.
- Detail rail: selected node's `buildViewData` entry + group info; events feed (last dag events from `dagstore` — v1: derive from the group's `updatedts` + status transitions; full event log is a follow-up) + merge queue (nodes with `merge` action).
- Keyboard: `j`/`k` move `selectedTaskIdAtom` through the layer-ordered id list (reuse the repo's `listnav` helper if shape fits, else a local `useEffect` keydown), `Enter` triggers the first action of the selected node, `Escape`/back closes.

`agents.tsx`: `openDag(oref)` from run cards; `cockpitsurface.tsx`: when `dagViewOrefAtom` is non-null render `<DagGraphView/>` instead of the surface body (back button clears the atom).

- [ ] **Step 2: Typecheck + lint + format**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Run: `npx eslint frontend/app/view/orchestrate/`
Run: `npx prettier --check frontend/app/view/orchestrate/`
Expected: 0 errors / clean / clean.

- [ ] **Step 3: Commit**

`feat(cockpit): orchestrate dag graph view (react-flow)` — await approval, then commit.

---

### Task 15: verify:ui scenario + final integration pass

**Files:**
- Modify: `scripts/cdp/scenarios.mjs` (add an `orchestrate` scenario entry)
- Verify: full test suite + build + docs

- [ ] **Step 1: Add the scenario**

In `scripts/cdp/scenarios.mjs` add an entry following the manifest shape (`{name, surface, arrange(h)->ctx, assert(h,ctx)->steps}` — see the `surface-smoke` entry at line 122 and the quick-run scenario at line 935):
- `arrange`: create an orchestrator run via `h.rpc` (mirror the line-935 scenario's run creation), submit a 3-task DAG via `RpcApi.DagSubmitCommand` (`t-0` no deps, `t-1 ← t-0`, `t-2 ← t-0, t-1` gate), open the graph via `openDag`.
- `assert`: `dag:<id>` nodes rendered (3 `.react-flow__node` elements), edges count 2, gate node shows Approve; `j`/`k` moves selection; `Escape` closes. Tolerate child worker spawn failures (harness may be absent) — assert UI states, not agent outcomes.

- [ ] **Step 2: Run the full verification battery**

Run: `go test ./pkg/orchestrate/ ./pkg/jarvis/ ./pkg/wshrpc/wshserver/ -count=1`
Run: `npx vitest run frontend/app/view/orchestrate/ pi/extensions/`
Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Run: `npx prettier --check frontend/app/view/orchestrate/ frontend/app/view/agents/ frontend/app/cockpit/`
Run: `task build:backend`
Run: `task verify:ui -- orchestrate` (with the dev app running)
Expected: all pass; contact sheet in `cdp-shots/index.html` shows the graph.

- [ ] **Step 3: Fold docs + final commit**

The spec (`docs/superpowers/specs/2026-08-15-orchestrator-engine-design.md`) and this plan fold into the feature commit per AGENTS.md. Present the full file list (M/A/D) + commit message, await approval, commit.

`feat(orchestrate): deterministic dag engine + worktrees + graph view`

---

## Self-Review Notes

- **Spec coverage:** model (Task 1), engine semantics (Tasks 2-3), verbs (Tasks 5, 7), worktrees+merge (Task 4), pi lead (Tasks 8-10), UI (Tasks 12-14), attention (Task 11), errors (validation in Task 2, conflict in Task 4, optimistic concurrency via wstore UpdateDag), testing (per task), rollout (task order). Non-goals respected: no connection field, no dense-list fallback, no pitasks writes, React Flow only for interaction (Task 12 installs it).
- **Placeholder scan:** the two deliberate seams (`resolveLeadSessionID`, `AttentionInput` field names, wstore helper names) each carry an explicit grep/follow-pattern instruction and a documented fallback — no open-ended "add handling".
- **Type consistency:** `TaskNode.Released` added in Task 3 (used by `gateBlocked`/`ApproveGate` and Task 12's action mapping); `Run.DagORef` from Task 1 used in Tasks 5/8; `childRunFromSpec` copies `DagORef` onto children so `GroupForRun` resolves (Task 8); `ScheduleOnce` signature stable across Tasks 8-9.
