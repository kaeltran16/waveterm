# Channels Runs — Engine Backend (Piece 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the backend-owned Run engine: a deterministic phase state-machine, a claude worker-spawn helper, an orchestrator that spawns the worker for whichever phase is running, persistence, and the CreateRun/AdvanceRun/CancelRun wshrpc commands — proving a linear default playbook that spawns real workers, halts at a review gate, and advances when completion is reported in.

**Architecture:** A **Run** is embedded JSON on the `Channel` object (a `Runs []Run` slice, mirroring `Messages`). The engine (`pkg/jarvis/run.go`) is a set of **pure functions** over a `Run` value (build phases, complete a phase, approve/send-back a gate, cancel, derive status). A separate **impure orchestrator** (`pkg/jarvis/runexec.go`) spawns a claude worker for any phase that is `running` without a worker yet, using `wcore.CreateTab` + `wstore.UpdateObjectMeta` + `blockcontroller.ResyncController`. The three wshrpc commands apply a pure transition, persist it, then spawn-and-attach — never nesting tab-creation writes inside the channel update. Phase completion is **reported in** (a human action or the external `~/.claude` hook calls `AdvanceRun`), not auto-detected.

**Tech Stack:** Go (backend), the wshrpc codegen pipeline (`task generate`), SQLite-backed `wstore`/`wcore`, `pkg/blockcontroller`, `pkg/waveobj` object model.

## Global Constraints

- **No DB migration.** Runs live as a JSON `runs` array on the `Channel` object (same mechanism as `messages`). Spec decision 8.
- **Engine transitions are pure/deterministic; the model is not involved in routing.** Structure, gates, and state transitions are code. Spec decision 3.
- **Runs are claude-only.** Every phase worker is the `claude` CLI (spec: delegator dispatch is hard-coded to claude). The spawn helper therefore does NOT reimplement the multi-runtime `frontend/app/view/agents/launch.ts` — just a fixed claude `cmd` block.
- **Phase completion is reported-in, not auto-detected** (v1 decision). The engine advances when `AdvanceRunCommand{action:"complete"}` arrives (from the UI or the `~/.claude` hook). No worker-exit/artifact watcher in this piece.
- **No profile layering.** The default playbook is hardcoded here; the global-file + per-project-override profile is **Piece 3**. The resolved-principles injection into phase prompts is **Piece 4** — phase prompts here carry skill + goal + prior artifacts only.
- **Spawning must not nest inside a `DBUpdateFn` callback.** Tab creation itself writes to the DB; do the state-transition write first, then spawn, then a second write to attach worker orefs.
- **Never hand-edit generated files.** After changing Go types or wshrpc commands, run `task generate` (regenerates `frontend/app/store/wshclientapi.ts` and `frontend/types/gotypes.d.ts`).
- **tsc gotcha:** typecheck with `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (plain `npx tsc` stack-overflows).
- License header on every new Go file:
  ```go
  // Copyright 2026, Command Line Inc.
  // SPDX-License-Identifier: Apache-2.0
  ```

---

## File Structure

- **Create** `pkg/jarvis/run.go` — pure engine: phase/status/kind/action constants, `DefaultPlaybook`, `NewRun`, `CompletePhase`, `ApproveGate`, `SendBackGate`, `CancelRun`, `BuildPhasePrompt`, internal `recomputeStatus`/`gateIndex`. No DB, no RPC, no spawning.
- **Create** `pkg/jarvis/run_test.go` — unit tests for the pure engine + prompt builder.
- **Create** `pkg/jarvis/runexec.go` — impure orchestrator: `SpawnClaudeWorker` (CreateTab + meta + ResyncController) and `EnsureWorkers` (spawn for running phases, return idx→oref).
- **Modify** `pkg/waveobj/wtype.go` — add `RunPhase`, `Run` (incl. `WorkspaceId`, `ProjectPath`); add `Runs []Run` to `Channel`.
- **Modify** `pkg/wstore/wstore_channel.go` — `appendRunIn`/`AppendRun`, `updateRunIn`/`UpdateRun`, and `GetRun` (read-back helper).
- **Modify** `pkg/wstore/wstore_channel_test.go` — tests for the pure `appendRunIn`/`updateRunIn` helpers.
- **Modify** `pkg/wshrpc/wshrpctypes.go` — 3 interface methods + `Command…Data`/`…RtnData` structs.
- **Modify** `pkg/wshrpc/wshserver/wshserver.go` — implement `CreateRunCommand`, `AdvanceRunCommand`, `CancelRunCommand` (each: transition → persist → `EnsureWorkers` → attach).
- **Regenerate** `frontend/app/store/wshclientapi.ts`, `frontend/types/gotypes.d.ts` via `task generate`.

Data model (added to `pkg/waveobj/wtype.go`):

```go
type RunPhase struct {
	Kind        string   `json:"kind"`               // brainstorm | plan | execute | custom
	Skill       string   `json:"skill,omitempty"`    // e.g. "superpowers:writing-plans"
	State       string   `json:"state"`              // pending | running | blocked | done | failed | skipped
	Gate        bool     `json:"gate,omitempty"`     // halt for human review after this phase completes
	FreshCtx    bool     `json:"freshctx,omitempty"` // this phase runs in its own fresh worker (clear-context boundary)
	WorkerOrefs []string `json:"workerorefs,omitempty"`
	Artifacts   []string `json:"artifacts,omitempty"`
}

type Run struct {
	ID          string     `json:"id"`
	Goal        string     `json:"goal"`
	PlaybookId  string     `json:"playbookid,omitempty"`
	WorkspaceId string     `json:"workspaceid"` // where phase-worker tabs are created (frontend supplies at CreateRun)
	ProjectPath string     `json:"projectpath"` // worker cwd (copied from the channel)
	Status      string     `json:"status"`      // planning | awaiting-review | executing | blocked | done | cancelled
	Phases      []RunPhase `json:"phases"`
	CreatedTs   int64      `json:"createdts"`
}
```

On the existing `Channel` struct, add after `Messages`:

```go
	Runs        []Run            `json:"runs,omitempty"`
```

Engine surface (`pkg/jarvis/run.go`, pure):
- `DefaultPlaybook() []waveobj.RunPhase`
- `NewRun(goal, workspaceId, projectPath string, playbook []waveobj.RunPhase, ts int64) waveobj.Run`
- `CompletePhase(run waveobj.Run, phaseIdx int, artifacts []string) (waveobj.Run, error)`
- `ApproveGate(run waveobj.Run) (waveobj.Run, error)`
- `SendBackGate(run waveobj.Run) (waveobj.Run, error)`
- `CancelRun(run waveobj.Run) waveobj.Run`
- `BuildPhasePrompt(phase waveobj.RunPhase, goal string, priorArtifacts []string) string`

Orchestrator surface (`pkg/jarvis/runexec.go`, impure):
- `SpawnClaudeWorker(ctx context.Context, workspaceId, projectName, cwd, prompt string) (string, error)` → returns `tab:<id>`
- `EnsureWorkers(ctx context.Context, run *waveobj.Run, projectName string) (map[int]string, error)` → spawns for running/no-worker phases, returns idx→oref

> **Note (worker completion & coupling):** the phase worker's `tab:<id>` is recorded on the phase. Wiring the Gatekeeper to auto-answer/escalate a *run* worker's asks (matching phase `WorkerOrefs`) is **Piece 4**; the reported-in `AdvanceRun` is the only completion path in this piece.

---

### Task 1: Run data types + engine constants + default playbook

**Files:**
- Modify: `pkg/waveobj/wtype.go`
- Create: `pkg/jarvis/run.go`
- Test: `pkg/jarvis/run_test.go`

**Interfaces:**
- Produces: `waveobj.RunPhase` / `waveobj.Run` structs; the phase/status/kind/action constants; `jarvis.DefaultPlaybook() []waveobj.RunPhase`.

- [ ] **Step 1: Add the structs to `pkg/waveobj/wtype.go`**

Add the `Runs []Run` field to `Channel` (after `Messages`, ~line 220) and add the `RunPhase` and `Run` structs (exact definitions from the File Structure section) after the `ChannelMessage` struct.

- [ ] **Step 2: Write the failing test**

Create `pkg/jarvis/run_test.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvis

import "testing"

func TestDefaultPlaybookShape(t *testing.T) {
	pb := DefaultPlaybook()
	if len(pb) != 3 {
		t.Fatalf("want 3 phases, got %d", len(pb))
	}
	if pb[0].Kind != PhaseKind_Brainstorm || pb[1].Kind != PhaseKind_Plan || pb[2].Kind != PhaseKind_Execute {
		t.Fatalf("wrong kinds: %+v", pb)
	}
	if pb[0].Gate || !pb[1].Gate || pb[2].Gate {
		t.Errorf("only the plan phase should gate: %+v", pb)
	}
	if pb[0].FreshCtx || pb[1].FreshCtx || !pb[2].FreshCtx {
		t.Errorf("only the execute phase should be fresh-ctx: %+v", pb)
	}
	for i, p := range pb {
		if p.State != PhaseState_Pending {
			t.Errorf("phase %d should start pending, got %q", i, p.State)
		}
	}
}
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `go test ./pkg/jarvis/ -run TestDefaultPlaybookShape -v`
Expected: FAIL — undefined `DefaultPlaybook`, `PhaseKind_*`, `PhaseState_*`.

- [ ] **Step 4: Create `pkg/jarvis/run.go`**

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvis

import (
	"fmt"
	"strings"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// Run statuses.
const (
	RunStatus_Planning       = "planning"
	RunStatus_AwaitingReview = "awaiting-review"
	RunStatus_Executing      = "executing"
	RunStatus_Blocked        = "blocked"
	RunStatus_Done           = "done"
	RunStatus_Cancelled      = "cancelled"
)

// Phase states.
const (
	PhaseState_Pending = "pending"
	PhaseState_Running = "running"
	PhaseState_Blocked = "blocked"
	PhaseState_Done    = "done"
	PhaseState_Failed  = "failed"
	PhaseState_Skipped = "skipped"
)

// Phase kinds.
const (
	PhaseKind_Brainstorm = "brainstorm"
	PhaseKind_Plan       = "plan"
	PhaseKind_Execute    = "execute"
	PhaseKind_Custom     = "custom"
)

// AdvanceRun actions (carried on CommandAdvanceRunData.Action).
const (
	RunAction_Complete = "complete"
	RunAction_Approve  = "approve"
	RunAction_SendBack = "sendback"
)

// DefaultPlaybook is the hardcoded superpowers pipeline (spec §"default playbook"): brainstorm -> plan
// (gate) -> execute (fresh context). Piece 3 replaces this with the resolved Jarvis profile.
func DefaultPlaybook() []waveobj.RunPhase {
	return []waveobj.RunPhase{
		{Kind: PhaseKind_Brainstorm, Skill: "superpowers:brainstorming", State: PhaseState_Pending},
		{Kind: PhaseKind_Plan, Skill: "superpowers:writing-plans", State: PhaseState_Pending, Gate: true},
		{Kind: PhaseKind_Execute, Skill: "superpowers:executing-plans", State: PhaseState_Pending, FreshCtx: true},
	}
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `go test ./pkg/jarvis/ -run TestDefaultPlaybookShape -v`
Expected: PASS.

- [ ] **Step 6: Do NOT commit yet** — `run.go` imports `fmt`/`strings`/`uuid` used in Tasks 2–6. Proceed to Task 2 before the first commit, or the build will report unused imports.

---

### Task 2: NewRun + status derivation

**Files:**
- Modify: `pkg/jarvis/run.go`
- Test: `pkg/jarvis/run_test.go`

**Interfaces:**
- Consumes: `DefaultPlaybook`, constants (Task 1).
- Produces: `NewRun(goal, workspaceId, projectPath string, playbook []waveobj.RunPhase, ts int64) waveobj.Run`; internal `recomputeStatus(*waveobj.Run)`.

- [ ] **Step 1: Write the failing test**

Add to `pkg/jarvis/run_test.go`:

```go
func TestNewRunStartsFirstPhaseRunning(t *testing.T) {
	r := NewRun("ship coupons", "ws1", "/repo", DefaultPlaybook(), 1717000000000)
	if r.ID == "" {
		t.Fatalf("expected a generated ID")
	}
	if r.Goal != "ship coupons" || r.WorkspaceId != "ws1" || r.ProjectPath != "/repo" || r.CreatedTs != 1717000000000 {
		t.Errorf("unexpected run header: %+v", r)
	}
	if len(r.Phases) != 3 || r.Phases[0].State != PhaseState_Running {
		t.Errorf("phase 0 should be running: %+v", r.Phases)
	}
	if r.Phases[1].State != PhaseState_Pending || r.Phases[2].State != PhaseState_Pending {
		t.Errorf("later phases should be pending: %+v", r.Phases)
	}
	if r.Status != RunStatus_Planning {
		t.Errorf("want planning, got %q", r.Status)
	}
}

func TestNewRunCopiesPlaybook(t *testing.T) {
	pb := DefaultPlaybook()
	r := NewRun("g", "ws", "/r", pb, 1)
	r.Phases[0].State = PhaseState_Done
	if pb[0].State != PhaseState_Pending {
		t.Errorf("NewRun must not alias the caller's playbook slice")
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `go test ./pkg/jarvis/ -run TestNewRun -v`
Expected: FAIL — undefined `NewRun`.

- [ ] **Step 3: Implement `NewRun` and `recomputeStatus`**

Add to `pkg/jarvis/run.go`:

```go
// NewRun builds a run from a playbook: deep-copies the phases, marks the first phase running, derives
// status. ts is supplied by the caller (mirrors NewChannelMessage) for testability.
func NewRun(goal, workspaceId, projectPath string, playbook []waveobj.RunPhase, ts int64) waveobj.Run {
	phases := make([]waveobj.RunPhase, len(playbook))
	copy(phases, playbook)
	if len(phases) > 0 {
		phases[0].State = PhaseState_Running
	}
	r := waveobj.Run{
		ID:          uuid.NewString(),
		Goal:        goal,
		WorkspaceId: workspaceId,
		ProjectPath: projectPath,
		Status:      RunStatus_Planning,
		Phases:      phases,
		CreatedTs:   ts,
	}
	recomputeStatus(&r)
	return r
}

// recomputeStatus derives run.Status from phase states. Single source of truth: never set Status
// directly outside this function (except CancelRun, a terminal override).
func recomputeStatus(r *waveobj.Run) {
	firstOpen := -1
	for i, p := range r.Phases {
		if p.State != PhaseState_Done && p.State != PhaseState_Skipped {
			firstOpen = i
			break
		}
	}
	if firstOpen == -1 {
		r.Status = RunStatus_Done
		return
	}
	cur := r.Phases[firstOpen]
	if cur.State == PhaseState_Blocked || cur.State == PhaseState_Failed {
		r.Status = RunStatus_Blocked
		return
	}
	if cur.State == PhaseState_Pending && firstOpen > 0 &&
		r.Phases[firstOpen-1].Gate && r.Phases[firstOpen-1].State == PhaseState_Done {
		r.Status = RunStatus_AwaitingReview
		return
	}
	if cur.Kind == PhaseKind_Execute {
		r.Status = RunStatus_Executing
		return
	}
	r.Status = RunStatus_Planning
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `go test ./pkg/jarvis/ -run TestNewRun -v`
Expected: PASS (both).

- [ ] **Step 5: Commit**

```bash
git add pkg/waveobj/wtype.go pkg/jarvis/run.go pkg/jarvis/run_test.go
git commit -m "feat(runs): Run/RunPhase types, default playbook, NewRun + status"
```

---

### Task 3: CompletePhase — linear advance + gate halt

**Files:**
- Modify: `pkg/jarvis/run.go`
- Test: `pkg/jarvis/run_test.go`

**Interfaces:**
- Consumes: `NewRun`, `recomputeStatus`, constants.
- Produces: `CompletePhase(run waveobj.Run, phaseIdx int, artifacts []string) (waveobj.Run, error)` — marks the running phase done, records reported artifacts, auto-starts the next phase unless this phase gates, recomputes status. Errors on bad index or a phase that is not running. (Worker orefs are attached by the orchestrator at spawn, not here.)

- [ ] **Step 1: Write the failing tests**

Add to `pkg/jarvis/run_test.go`:

```go
func TestCompletePhaseAdvancesLinear(t *testing.T) {
	r := NewRun("g", "ws", "/r", DefaultPlaybook(), 1)
	r, err := CompletePhase(r, 0, []string{"docs/spec.md"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if r.Phases[0].State != PhaseState_Done || r.Phases[0].Artifacts[0] != "docs/spec.md" {
		t.Errorf("phase 0 not completed with artifact: %+v", r.Phases[0])
	}
	if r.Phases[1].State != PhaseState_Running {
		t.Errorf("phase 1 should auto-start, got %q", r.Phases[1].State)
	}
	if r.Status != RunStatus_Planning {
		t.Errorf("want planning, got %q", r.Status)
	}
}

func TestCompletePhaseHaltsAtGate(t *testing.T) {
	r := NewRun("g", "ws", "/r", DefaultPlaybook(), 1)
	r, _ = CompletePhase(r, 0, nil)
	r, err := CompletePhase(r, 1, []string{"docs/plan.md"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if r.Phases[1].State != PhaseState_Done {
		t.Errorf("plan should be done, got %q", r.Phases[1].State)
	}
	if r.Phases[2].State != PhaseState_Pending {
		t.Errorf("execute must NOT auto-start after a gate, got %q", r.Phases[2].State)
	}
	if r.Status != RunStatus_AwaitingReview {
		t.Errorf("want awaiting-review, got %q", r.Status)
	}
}

func TestCompletePhaseRejectsNonRunning(t *testing.T) {
	r := NewRun("g", "ws", "/r", DefaultPlaybook(), 1)
	if _, err := CompletePhase(r, 1, nil); err == nil {
		t.Errorf("expected error completing a pending phase")
	}
	if _, err := CompletePhase(r, 9, nil); err == nil {
		t.Errorf("expected error for out-of-range index")
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go test ./pkg/jarvis/ -run TestCompletePhase -v`
Expected: FAIL — undefined `CompletePhase`.

- [ ] **Step 3: Implement `CompletePhase`**

Add to `pkg/jarvis/run.go`:

```go
// CompletePhase marks phaseIdx done, records the reported artifacts, and advances: a non-gated phase
// auto-starts its successor; a gated phase halts (recomputeStatus derives awaiting-review). Completion
// is reported in by the caller (UI action or the ~/.claude hook) — the engine does not detect it.
func CompletePhase(run waveobj.Run, phaseIdx int, artifacts []string) (waveobj.Run, error) {
	if phaseIdx < 0 || phaseIdx >= len(run.Phases) {
		return run, fmt.Errorf("phase index %d out of range", phaseIdx)
	}
	if run.Phases[phaseIdx].State != PhaseState_Running {
		return run, fmt.Errorf("phase %d is %q, not running", phaseIdx, run.Phases[phaseIdx].State)
	}
	run.Phases[phaseIdx].State = PhaseState_Done
	run.Phases[phaseIdx].Artifacts = append(run.Phases[phaseIdx].Artifacts, artifacts...)
	if !run.Phases[phaseIdx].Gate && phaseIdx+1 < len(run.Phases) {
		run.Phases[phaseIdx+1].State = PhaseState_Running
	}
	recomputeStatus(&run)
	return run, nil
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `go test ./pkg/jarvis/ -run TestCompletePhase -v`
Expected: PASS (all three).

- [ ] **Step 5: Commit**

```bash
git add pkg/jarvis/run.go pkg/jarvis/run_test.go
git commit -m "feat(runs): CompletePhase with linear advance and gate halt"
```

---

### Task 4: ApproveGate + SendBackGate

**Files:**
- Modify: `pkg/jarvis/run.go`
- Test: `pkg/jarvis/run_test.go`

**Interfaces:**
- Consumes: `CompletePhase`, `recomputeStatus`, constants.
- Produces: `ApproveGate(run) (run, error)` (starts the phase after the completed gate); `SendBackGate(run) (run, error)` (re-runs the gate phase; successor stays pending); internal `gateIndex(run) int`. Both error unless the run is `awaiting-review`.

- [ ] **Step 1: Write the failing tests**

Add to `pkg/jarvis/run_test.go`:

```go
func runAtGate(t *testing.T) waveobj.Run {
	t.Helper()
	r := NewRun("g", "ws", "/r", DefaultPlaybook(), 1)
	r, _ = CompletePhase(r, 0, nil)
	r, _ = CompletePhase(r, 1, []string{"docs/plan.md"})
	if r.Status != RunStatus_AwaitingReview {
		t.Fatalf("setup: expected awaiting-review, got %q", r.Status)
	}
	return r
}

func TestApproveGateStartsExecute(t *testing.T) {
	r := runAtGate(t)
	r, err := ApproveGate(r)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if r.Phases[2].State != PhaseState_Running {
		t.Errorf("execute should be running, got %q", r.Phases[2].State)
	}
	if r.Status != RunStatus_Executing {
		t.Errorf("want executing, got %q", r.Status)
	}
}

func TestApproveGateRejectsWhenNotAwaiting(t *testing.T) {
	r := NewRun("g", "ws", "/r", DefaultPlaybook(), 1)
	if _, err := ApproveGate(r); err == nil {
		t.Errorf("expected error approving a run not awaiting-review")
	}
}

func TestSendBackReopensPlan(t *testing.T) {
	r := runAtGate(t)
	r, err := SendBackGate(r)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if r.Phases[1].State != PhaseState_Running {
		t.Errorf("plan should be running again, got %q", r.Phases[1].State)
	}
	if r.Phases[2].State != PhaseState_Pending {
		t.Errorf("execute should stay pending, got %q", r.Phases[2].State)
	}
	if r.Status != RunStatus_Planning {
		t.Errorf("want planning, got %q", r.Status)
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go test ./pkg/jarvis/ -run "TestApproveGate|TestSendBack" -v`
Expected: FAIL — undefined `ApproveGate`, `SendBackGate`.

- [ ] **Step 3: Implement the two functions**

Add to `pkg/jarvis/run.go`:

```go
// gateIndex returns the index of the completed gate a halted run is waiting on, or -1. It is the phase
// immediately before the first still-open phase, when that phase is a Done gate.
func gateIndex(run waveobj.Run) int {
	for i, p := range run.Phases {
		if p.State != PhaseState_Done && p.State != PhaseState_Skipped {
			if i > 0 && run.Phases[i-1].Gate && run.Phases[i-1].State == PhaseState_Done {
				return i - 1
			}
			return -1
		}
	}
	return -1
}

// ApproveGate releases a halted run: starts the phase after the completed gate.
func ApproveGate(run waveobj.Run) (waveobj.Run, error) {
	if run.Status != RunStatus_AwaitingReview {
		return run, fmt.Errorf("run is %q, not awaiting-review", run.Status)
	}
	gi := gateIndex(run)
	if gi < 0 || gi+1 >= len(run.Phases) {
		return run, fmt.Errorf("no phase to release after the gate")
	}
	run.Phases[gi+1].State = PhaseState_Running
	recomputeStatus(&run)
	return run, nil
}

// SendBackGate re-opens the gate phase so its work is redone (the successor stays pending).
func SendBackGate(run waveobj.Run) (waveobj.Run, error) {
	if run.Status != RunStatus_AwaitingReview {
		return run, fmt.Errorf("run is %q, not awaiting-review", run.Status)
	}
	gi := gateIndex(run)
	if gi < 0 {
		return run, fmt.Errorf("no completed gate to send back")
	}
	run.Phases[gi].State = PhaseState_Running
	recomputeStatus(&run)
	return run, nil
}
```

> **Note on send-back re-spawn:** re-opening the gate phase sets it `running` again. Because its `WorkerOrefs` is already populated from the first attempt, `EnsureWorkers` (Task 8) will NOT spawn a fresh worker. For this piece that is acceptable (send-back re-runs the existing worker via steering/reporting). Clearing/redispatching on send-back is a Piece 2 refinement — noted, not silently dropped.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `go test ./pkg/jarvis/ -run "TestApproveGate|TestSendBack" -v`
Expected: PASS (all three).

- [ ] **Step 5: Commit**

```bash
git add pkg/jarvis/run.go pkg/jarvis/run_test.go
git commit -m "feat(runs): ApproveGate and SendBackGate"
```

---

### Task 5: CancelRun + BuildPhasePrompt

**Files:**
- Modify: `pkg/jarvis/run.go`
- Test: `pkg/jarvis/run_test.go`

**Interfaces:**
- Consumes: constants.
- Produces:
  - `CancelRun(run waveobj.Run) waveobj.Run` — terminal: open phases (`pending`/`running`) → `skipped`, status `cancelled`.
  - `BuildPhasePrompt(phase waveobj.RunPhase, goal string, priorArtifacts []string) string` — the claude worker's initial prompt: instruct the phase's skill on the goal, referencing prior artifacts. Pure.

- [ ] **Step 1: Write the failing tests**

Add to `pkg/jarvis/run_test.go`:

```go
func TestCancelRunSkipsOpenPhases(t *testing.T) {
	r := NewRun("g", "ws", "/r", DefaultPlaybook(), 1)
	r, _ = CompletePhase(r, 0, nil)
	r = CancelRun(r)
	if r.Status != RunStatus_Cancelled {
		t.Errorf("want cancelled, got %q", r.Status)
	}
	if r.Phases[0].State != PhaseState_Done {
		t.Errorf("completed phase should stay done, got %q", r.Phases[0].State)
	}
	if r.Phases[1].State != PhaseState_Skipped || r.Phases[2].State != PhaseState_Skipped {
		t.Errorf("open phases should be skipped: %+v", r.Phases)
	}
}

func TestBuildPhasePromptMentionsSkillGoalAndArtifacts(t *testing.T) {
	p := waveobj.RunPhase{Kind: PhaseKind_Plan, Skill: "superpowers:writing-plans"}
	got := BuildPhasePrompt(p, "ship coupons", []string{"docs/spec.md"})
	for _, want := range []string{"superpowers:writing-plans", "ship coupons", "docs/spec.md"} {
		if !strings.Contains(got, want) {
			t.Errorf("prompt missing %q: %s", want, got)
		}
	}
}
```

Add `"strings"` and the `waveobj` import to the test file's imports:

```go
import (
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go test ./pkg/jarvis/ -run "TestCancelRun|TestBuildPhasePrompt" -v`
Expected: FAIL — undefined `CancelRun`, `BuildPhasePrompt`.

- [ ] **Step 3: Implement both**

Add to `pkg/jarvis/run.go`:

```go
// CancelRun terminally cancels a run: open phases become skipped, completed phases are preserved.
func CancelRun(run waveobj.Run) waveobj.Run {
	for i := range run.Phases {
		if run.Phases[i].State == PhaseState_Pending || run.Phases[i].State == PhaseState_Running {
			run.Phases[i].State = PhaseState_Skipped
		}
	}
	run.Status = RunStatus_Cancelled
	return run
}

// BuildPhasePrompt is the claude worker's initial prompt for a phase: run the phase's skill against the
// goal, using any artifacts prior phases produced. Piece 4 prepends the resolved Jarvis principles.
func BuildPhasePrompt(phase waveobj.RunPhase, goal string, priorArtifacts []string) string {
	var b strings.Builder
	fmt.Fprintf(&b, "Use the %s skill to work this goal, then stop when the phase's deliverable is written.\n", phase.Skill)
	fmt.Fprintf(&b, "Goal: %s\n", goal)
	if len(priorArtifacts) > 0 {
		fmt.Fprintf(&b, "Prior artifacts to build on: %s\n", strings.Join(priorArtifacts, ", "))
	}
	return strings.TrimRight(b.String(), "\n")
}
```

- [ ] **Step 4: Run the full engine suite**

Run: `go test ./pkg/jarvis/ -v`
Expected: PASS (all Run tests plus the pre-existing jarvis tests).

- [ ] **Step 5: Commit**

```bash
git add pkg/jarvis/run.go pkg/jarvis/run_test.go
git commit -m "feat(runs): CancelRun and phase-prompt builder"
```

---

### Task 6: Persistence — AppendRun / UpdateRun / GetRun

**Files:**
- Modify: `pkg/wstore/wstore_channel.go`
- Test: `pkg/wstore/wstore_channel_test.go`

**Interfaces:**
- Consumes: `waveobj.Run`, `waveobj.Channel.Runs`; `DBUpdateFnErr` (used at `wstore_channel.go:73`).
- Produces:
  - pure `appendRunIn(ch *waveobj.Channel, run waveobj.Run)`, `updateRunIn(ch *waveobj.Channel, runId string, fn func(*waveobj.Run) error) error`
  - DB wrappers `AppendRun(ctx, channelId string, run waveobj.Run) error`, `UpdateRun(ctx, channelId, runId string, fn func(*waveobj.Run) error) error`
  - `GetRun(ctx, channelId, runId string) (*waveobj.Run, error)` (read-back for the orchestrator step)

- [ ] **Step 1: Write the failing tests** (pure helpers, no DB — mirrors the existing message-helper tests)

Add to `pkg/wstore/wstore_channel_test.go`:

```go
func TestAppendRunInAppends(t *testing.T) {
	ch := &waveobj.Channel{OID: "c1"}
	appendRunIn(ch, waveobj.Run{ID: "r1", Goal: "a"})
	appendRunIn(ch, waveobj.Run{ID: "r2", Goal: "b"})
	if len(ch.Runs) != 2 || ch.Runs[0].ID != "r1" || ch.Runs[1].ID != "r2" {
		t.Fatalf("unexpected runs: %+v", ch.Runs)
	}
}

func TestUpdateRunInMutatesMatch(t *testing.T) {
	ch := &waveobj.Channel{OID: "c1", Runs: []waveobj.Run{{ID: "r1"}, {ID: "r2"}}}
	err := updateRunIn(ch, "r2", func(r *waveobj.Run) error {
		r.Status = "done"
		return nil
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if ch.Runs[1].Status != "done" || ch.Runs[0].Status != "" {
		t.Errorf("wrong run mutated: %+v", ch.Runs)
	}
}

func TestUpdateRunInErrorsWhenMissing(t *testing.T) {
	ch := &waveobj.Channel{OID: "c1", Runs: []waveobj.Run{{ID: "r1"}}}
	if err := updateRunIn(ch, "nope", func(*waveobj.Run) error { return nil }); err == nil {
		t.Fatalf("expected error for missing run id")
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go test ./pkg/wstore/ -run "TestAppendRunIn|TestUpdateRunIn" -v`
Expected: FAIL — undefined `appendRunIn`, `updateRunIn`.

- [ ] **Step 3: Implement the helpers and DB wrappers**

Add to `pkg/wstore/wstore_channel.go` (after `PostChannelMessage`):

```go
func appendRunIn(ch *waveobj.Channel, run waveobj.Run) {
	ch.Runs = append(ch.Runs, run)
}

// AppendRun appends a run to the channel and persists it.
func AppendRun(ctx context.Context, channelId string, run waveobj.Run) error {
	return DBUpdateFnErr(ctx, channelId, func(ch *waveobj.Channel) error {
		appendRunIn(ch, run)
		return nil
	})
}

// updateRunIn finds the run by id in ch and applies fn in place; errors if not found.
func updateRunIn(ch *waveobj.Channel, runId string, fn func(*waveobj.Run) error) error {
	for i := range ch.Runs {
		if ch.Runs[i].ID == runId {
			return fn(&ch.Runs[i])
		}
	}
	return fmt.Errorf("run %q not found in channel", runId)
}

// UpdateRun applies fn to the identified run and persists the channel.
func UpdateRun(ctx context.Context, channelId, runId string, fn func(*waveobj.Run) error) error {
	return DBUpdateFnErr(ctx, channelId, func(ch *waveobj.Channel) error {
		return updateRunIn(ch, runId, fn)
	})
}

// GetRun reads a single run by id (a copy), for the orchestrator's read-back-then-spawn step.
func GetRun(ctx context.Context, channelId, runId string) (*waveobj.Run, error) {
	ch, err := DBMustGet[*waveobj.Channel](ctx, channelId)
	if err != nil {
		return nil, err
	}
	for i := range ch.Runs {
		if ch.Runs[i].ID == runId {
			r := ch.Runs[i]
			return &r, nil
		}
	}
	return nil, fmt.Errorf("run %q not found in channel", runId)
}
```

(`DBMustGet` is already used across `wstore`; confirm it is in scope in this file — if the import/generic helper is elsewhere in the package it needs no new import.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `go test ./pkg/wstore/ -run "TestAppendRunIn|TestUpdateRunIn" -v`
Expected: PASS (all three). `go build ./...` to confirm `GetRun` compiles.

- [ ] **Step 5: Commit**

```bash
git add pkg/wstore/wstore_channel.go pkg/wstore/wstore_channel_test.go
git commit -m "feat(runs): channel Run persistence helpers"
```

---

### Task 7: Spawn helper — SpawnClaudeWorker

**Files:**
- Create: `pkg/jarvis/runexec.go`
- (No unit test — this is I/O wiring over `wcore`/`blockcontroller`; verified by `go build` here and the end-to-end manual check at the end. Its callers are exercised by Task 8/9.)

**Interfaces:**
- Consumes: `wcore.CreateTab`, `wstore.DBMustGet`/`UpdateObjectMeta`, `blockcontroller.ResyncController`, `waveobj` meta-key constants + `MakeORef`.
- Produces: `SpawnClaudeWorker(ctx context.Context, workspaceId, projectName, cwd, prompt string) (string, error)` — creates a tab, configures its block as a claude `cmd` worker, tags the tab for the roster, force-starts the controller, and returns `tab:<id>`.

Reference (the frontend flow this mirrors, claude-only): `frontend/app/cockpit/cockpit-actions.ts::launchAgent` + `buildLaunchMeta` in `launch.ts:117`. The block meta for a no-flags claude worker is exactly: `view=term`, `controller=cmd`, `cmd=claude`, `cmd:args=[prompt]`, `cmd:shell=false`, `cmd:jwt=true`, `cmd:cwd=<cwd>`. The tab meta `session:agent=claude` + `session:project=<name>` is what puts the worker in the roster and routes the external status reporter.

- [ ] **Step 1: Create `pkg/jarvis/runexec.go`**

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvis

import (
	"context"
	"fmt"

	"github.com/wavetermdev/waveterm/pkg/blockcontroller"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wcore"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// SpawnClaudeWorker creates a background tab running `claude <prompt>` in cwd and returns its tab oref
// ("tab:<id>"). Mirrors the frontend launchAgent path for the claude runtime (no flags): configure the
// new tab's default block as a cmd worker, tag the tab for the roster, and force-start the controller
// (controllers otherwise start lazily on a frontend terminal resync — force=true launches it headlessly).
func SpawnClaudeWorker(ctx context.Context, workspaceId, projectName, cwd, prompt string) (string, error) {
	if workspaceId == "" {
		return "", fmt.Errorf("workspaceId is required to spawn a worker")
	}
	tabId, err := wcore.CreateTab(ctx, workspaceId, projectName, false, false)
	if err != nil {
		return "", fmt.Errorf("creating worker tab: %w", err)
	}
	tab, err := wstore.DBMustGet[*waveobj.Tab](ctx, tabId)
	if err != nil {
		return "", fmt.Errorf("loading worker tab: %w", err)
	}
	if len(tab.BlockIds) == 0 {
		return "", fmt.Errorf("worker tab %s has no block", tabId)
	}
	blockId := tab.BlockIds[0]

	blockMeta := waveobj.MetaMapType{
		waveobj.MetaKey_View:       "term",
		waveobj.MetaKey_Controller: "cmd",
		waveobj.MetaKey_Cmd:        "claude",
		waveobj.MetaKey_CmdArgs:    []string{prompt},
		waveobj.MetaKey_CmdShell:   false,
		waveobj.MetaKey_CmdJwt:     true,
	}
	if cwd != "" {
		blockMeta[waveobj.MetaKey_CmdCwd] = cwd
	}
	if err := wstore.UpdateObjectMeta(ctx, waveobj.MakeORef(waveobj.OType_Block, blockId), blockMeta, false); err != nil {
		return "", fmt.Errorf("setting worker block meta: %w", err)
	}
	// Tab meta: put the worker in the agent roster (and route the external status reporter). These keys
	// have no generated constants; the literals match the frontend (see launchAgent).
	tabMeta := waveobj.MetaMapType{
		"session:agent":   "claude",
		"session:project": projectName,
	}
	if err := wstore.UpdateObjectMeta(ctx, waveobj.MakeORef(waveobj.OType_Tab, tabId), tabMeta, false); err != nil {
		return "", fmt.Errorf("setting worker tab meta: %w", err)
	}
	if err := blockcontroller.ResyncController(ctx, tabId, blockId, &waveobj.RuntimeOpts{}, true); err != nil {
		return "", fmt.Errorf("starting worker controller: %w", err)
	}
	return waveobj.MakeORef(waveobj.OType_Tab, tabId).String(), nil
}
```

- [ ] **Step 2: Build to confirm the wiring compiles**

Run: `go build ./...`
Expected: exit 0. If a `MetaKey_*` constant name is wrong, `grep -n "MetaKey_CmdArgs\|MetaKey_CmdJwt" pkg/waveobj/metaconsts.go` and reconcile. If `blockcontroller` import creates a cycle with `jarvis`, move `runexec.go` to a new leaf package `pkg/jarvis/runexec` importing `jarvis` — but `jarvis` does not currently import `blockcontroller`/`wcore`, so no cycle is expected.

- [ ] **Step 3: Commit**

```bash
git add pkg/jarvis/runexec.go
git commit -m "feat(runs): claude worker spawn helper"
```

---

### Task 8: Orchestrator — EnsureWorkers

**Files:**
- Modify: `pkg/jarvis/runexec.go`
- (Verified by `go build` + the end-to-end manual check; spawning is I/O.)

**Interfaces:**
- Consumes: `SpawnClaudeWorker`, `BuildPhasePrompt`, phase-state constants, `waveobj.Run`.
- Produces: `EnsureWorkers(ctx context.Context, run *waveobj.Run, projectName string) (map[int]string, error)` — for every phase that is `running` with no `WorkerOrefs`, build the prompt (skill + goal + prior artifacts), spawn a worker, and collect `phaseIdx → tab:<id>`. Does NOT persist — the caller attaches the returned orefs under a second `UpdateRun`.

- [ ] **Step 1: Add `EnsureWorkers` to `pkg/jarvis/runexec.go`**

```go
// priorArtifacts collects the artifacts of all phases before idx (in order).
func priorArtifacts(run *waveobj.Run, idx int) []string {
	var out []string
	for i := 0; i < idx && i < len(run.Phases); i++ {
		out = append(out, run.Phases[i].Artifacts...)
	}
	return out
}

// EnsureWorkers spawns a claude worker for each running phase that has none yet, returning the phase
// index -> tab oref it created. It does not mutate/persist the run; the caller attaches the orefs.
// On a spawn error it returns what it has so far plus the error (the caller still persists partial work).
func EnsureWorkers(ctx context.Context, run *waveobj.Run, projectName string) (map[int]string, error) {
	spawned := map[int]string{}
	for i := range run.Phases {
		p := run.Phases[i]
		if p.State != PhaseState_Running || len(p.WorkerOrefs) > 0 {
			continue
		}
		prompt := BuildPhasePrompt(p, run.Goal, priorArtifacts(run, i))
		oref, err := SpawnClaudeWorker(ctx, run.WorkspaceId, projectName, run.ProjectPath, prompt)
		if err != nil {
			return spawned, fmt.Errorf("spawning worker for phase %d: %w", i, err)
		}
		spawned[i] = oref
	}
	return spawned, nil
}
```

- [ ] **Step 2: Build**

Run: `go build ./...`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add pkg/jarvis/runexec.go
git commit -m "feat(runs): EnsureWorkers orchestrator"
```

---

### Task 9: wshrpc commands — CreateRun / AdvanceRun / CancelRun

**Files:**
- Modify: `pkg/wshrpc/wshrpctypes.go` (interface methods ~line 117; `Command…Data` structs ~line 755)
- Modify: `pkg/wshrpc/wshserver/wshserver.go` (after `SetChannelMessagePickCommand`, ~line 1730)
- Regenerate: `frontend/app/store/wshclientapi.ts`, `frontend/types/gotypes.d.ts`

**Interfaces:**
- Consumes: `jarvis.NewRun`/`DefaultPlaybook`/`CompletePhase`/`ApproveGate`/`SendBackGate`/`CancelRun`/`RunAction_*`/`EnsureWorkers` (Tasks 1–8); `wstore.AppendRun`/`UpdateRun`/`GetRun` (Task 6); `wcore.SendWaveObjUpdate`; the `SetChannelTierCommand` pattern (`wshserver.go:1682`).
- Produces: three RPC commands. Runs ride on the `Channel` object already returned by `GetChannelsCommand`, so no new read command is needed.

- [ ] **Step 1: Add the interface methods to `pkg/wshrpc/wshrpctypes.go`**

Alongside `SetChannelTierCommand` (~line 117):

```go
	CreateRunCommand(ctx context.Context, data CommandCreateRunData) (*CommandCreateRunRtnData, error)  // create + start a goal Run (spawns phase 1's worker)
	AdvanceRunCommand(ctx context.Context, data CommandAdvanceRunData) error                            // complete a phase / approve or send back a gate (spawns the next worker)
	CancelRunCommand(ctx context.Context, data CommandCancelRunData) error                              // cancel a Run
```

- [ ] **Step 2: Add the Data structs** (after `CommandJarvisDecomposeRtnData`, ~line 755)

```go
type CommandCreateRunData struct {
	ChannelId   string `json:"channelid"`
	WorkspaceId string `json:"workspaceid"` // where phase-worker tabs are created
	Goal        string `json:"goal"`
	PlaybookId  string `json:"playbookid,omitempty"`
}

type CommandCreateRunRtnData struct {
	Run *waveobj.Run `json:"run"`
}

type CommandAdvanceRunData struct {
	ChannelId string   `json:"channelid"`
	RunId     string   `json:"runid"`
	PhaseIdx  int      `json:"phaseidx"`            // the phase being completed (ignored for approve/sendback)
	Action    string   `json:"action"`             // complete | approve | sendback
	Artifacts []string `json:"artifacts,omitempty"` // artifacts to record on complete
}

type CommandCancelRunData struct {
	ChannelId string `json:"channelid"`
	RunId     string `json:"runid"`
}
```

- [ ] **Step 3: Implement the commands in `pkg/wshrpc/wshserver/wshserver.go`**

Add after `SetChannelMessagePickCommand` (`jarvis`, `wstore`, `wcore`, `waveobj`, `time`, `fmt` are already imported in this file):

```go
// spawnRunWorkers reads the run back, spawns workers for any newly-running phase, and persists the
// attached orefs — a second write, so tab-creation never nests inside the run's state-transition write.
func spawnRunWorkers(ctx context.Context, channelId, runId, projectName string) error {
	run, err := wstore.GetRun(ctx, channelId, runId)
	if err != nil {
		return err
	}
	spawned, spawnErr := jarvis.EnsureWorkers(ctx, run, projectName)
	if len(spawned) > 0 {
		if uerr := wstore.UpdateRun(ctx, channelId, runId, func(r *waveobj.Run) error {
			for idx, oref := range spawned {
				if idx >= 0 && idx < len(r.Phases) {
					r.Phases[idx].WorkerOrefs = append(r.Phases[idx].WorkerOrefs, oref)
				}
			}
			return nil
		}); uerr != nil {
			return uerr
		}
	}
	return spawnErr // surfaced but non-fatal to already-persisted state
}

func (ws *WshServer) CreateRunCommand(ctx context.Context, data wshrpc.CommandCreateRunData) (*wshrpc.CommandCreateRunRtnData, error) {
	if data.ChannelId == "" || data.WorkspaceId == "" || data.Goal == "" {
		return nil, fmt.Errorf("channelid, workspaceid and goal are required")
	}
	ch, err := wstore.DBMustGet[*waveobj.Channel](ctx, data.ChannelId)
	if err != nil {
		return nil, fmt.Errorf("loading channel: %w", err)
	}
	run := jarvis.NewRun(data.Goal, data.WorkspaceId, ch.ProjectPath, jarvis.DefaultPlaybook(), time.Now().UnixMilli())
	if err := wstore.AppendRun(ctx, data.ChannelId, run); err != nil {
		return nil, fmt.Errorf("appending run: %w", err)
	}
	if err := spawnRunWorkers(ctx, data.ChannelId, run.ID, ch.Name); err != nil {
		// the run is persisted; surface the spawn failure but return the run so the UI can show blocked/retry
		wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Channel, data.ChannelId))
		return nil, fmt.Errorf("spawning first worker: %w", err)
	}
	out, _ := wstore.GetRun(ctx, data.ChannelId, run.ID)
	wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Channel, data.ChannelId))
	return &wshrpc.CommandCreateRunRtnData{Run: out}, nil
}

func (ws *WshServer) AdvanceRunCommand(ctx context.Context, data wshrpc.CommandAdvanceRunData) error {
	if data.ChannelId == "" || data.RunId == "" {
		return fmt.Errorf("channelid and runid are required")
	}
	err := wstore.UpdateRun(ctx, data.ChannelId, data.RunId, func(r *waveobj.Run) error {
		var next waveobj.Run
		var e error
		switch data.Action {
		case jarvis.RunAction_Complete:
			next, e = jarvis.CompletePhase(*r, data.PhaseIdx, data.Artifacts)
		case jarvis.RunAction_Approve:
			next, e = jarvis.ApproveGate(*r)
		case jarvis.RunAction_SendBack:
			next, e = jarvis.SendBackGate(*r)
		default:
			e = fmt.Errorf("unknown run action %q", data.Action)
		}
		if e != nil {
			return e
		}
		*r = next
		return nil
	})
	if err != nil {
		return fmt.Errorf("advancing run: %w", err)
	}
	ch, err := wstore.DBMustGet[*waveobj.Channel](ctx, data.ChannelId)
	if err != nil {
		return fmt.Errorf("loading channel: %w", err)
	}
	if err := spawnRunWorkers(ctx, data.ChannelId, data.RunId, ch.Name); err != nil {
		wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Channel, data.ChannelId))
		return fmt.Errorf("spawning next worker: %w", err)
	}
	wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Channel, data.ChannelId))
	return nil
}

func (ws *WshServer) CancelRunCommand(ctx context.Context, data wshrpc.CommandCancelRunData) error {
	if data.ChannelId == "" || data.RunId == "" {
		return fmt.Errorf("channelid and runid are required")
	}
	err := wstore.UpdateRun(ctx, data.ChannelId, data.RunId, func(r *waveobj.Run) error {
		*r = jarvis.CancelRun(*r)
		return nil
	})
	if err != nil {
		return fmt.Errorf("cancelling run: %w", err)
	}
	wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Channel, data.ChannelId))
	return nil
}
```

- [ ] **Step 4: Build to confirm the interface is satisfied**

Run: `go build ./...`
Expected: exit 0. (If `WshServer` "does not implement" the interface, a signature drifted from Step 1 — reconcile.)

- [ ] **Step 5: Regenerate the TS bindings**

Run: `task generate`
Expected: `wshclientapi.ts` gains the 3 commands; `gotypes.d.ts` gains `Run`, `RunPhase`, and the new `Command*` types. Do not hand-edit.

- [ ] **Step 6: Typecheck the frontend (bindings must compile)**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0 (baseline is clean; no consumers yet).

- [ ] **Step 7: Run the touched backend suites**

Run: `go test ./pkg/jarvis/ ./pkg/wstore/ ./pkg/wshrpc/...`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add pkg/wshrpc/wshrpctypes.go pkg/wshrpc/wshserver/wshserver.go frontend/app/store/wshclientapi.ts frontend/types/gotypes.d.ts
git commit -m "feat(runs): CreateRun/AdvanceRun/CancelRun wshrpc commands"
```

---

## Manual verification (end-to-end against the live dev app)

Piece 1 ships no Run UI, so drive the commands from the dev app's devtools console (Vite on `:5174`) with `task dev` running and a channel created (note its `channelid` and the active workspace oid from `globalStore.get(atoms.workspace).oid`). This exercises real tab spawning.

1. `RpcApi.CreateRunCommand(TabRpcClient, { channelid, workspaceid, goal: "add a coupon field to checkout" })` → returns a `run` with 3 phases, phase 0 `running` with one `workerorefs` entry, status `planning`. **Confirm a new background tab appeared** and its `claude` process started (open the tab; it should be running claude with the brainstorm prompt).
2. Report phase 0 done: `RpcApi.AdvanceRunCommand(TabRpcClient, { channelid, runid, phaseidx: 0, action: "complete", artifacts: ["docs/spec.md"] })` → re-fetch via `RpcApi.GetChannelsCommand`; confirm phase 1 `running` with its own worker tab, status `planning`.
3. Complete phase 1: `{ phaseidx: 1, action: "complete", artifacts: ["docs/plan.md"] }` → status `awaiting-review`, phase 2 still `pending`, **no new worker spawned**.
4. `{ action: "approve" }` → phase 2 `running` with a worker, status `executing`.
5. `RpcApi.CancelRunCommand(...)` → status `cancelled`, phase 2 `skipped`.

Record the result (a short note in `docs/agents/`); this is the piece's acceptance check until Piece 2 renders it.

> If step 1 creates the tab but claude does not start, the controller did not force-start — verify the `ResyncController(..., force=true)` call and that the block meta has `controller=cmd` + `cmd=claude`.

---

## Self-Review

**Spec coverage (piece 1 scope):**
- Run/RunPhase types + `Channel.Runs`, JSON-embedded, no migration → Task 1. ✓
- Default playbook (superpowers pipeline; plan gates; execute fresh-ctx) → Task 1. ✓
- Pure state machine: create, complete/advance, gate halt, approve, send-back, cancel, status derivation → Tasks 2–5. ✓
- Phase prompt (skill + goal + prior artifacts; principles deferred to Piece 4) → Task 5. ✓
- Backend-owned execution: claude spawn helper + orchestrator (`wcore.CreateTab` + `UpdateObjectMeta` + `ResyncController` force-start), spawning kept out of the DB-update callback → Tasks 7–9. ✓
- Persistence mirroring the message helpers + read-back → Task 6. ✓
- CreateRun/AdvanceRun/CancelRun commands (workspaceId threaded; spawn-and-attach) + regenerated bindings → Task 9. ✓
- Reported-in completion (no auto-detect) → Global Constraints + `CompletePhase`/`AdvanceRun`. ✓
- Explicitly deferred (Global Constraints / notes): profile layering + principles injection → Piece 3/4; Gatekeeper coupling of run workers + escalation → Piece 4; blocked-state recovery + send-back re-dispatch + worktree fan-out for execute → Piece 2; Run UI → Piece 2.

**Placeholder scan:** No TBD/TODO; every code step shows complete code; every test step shows the assertion, the exact run command, and the expected result. The two I/O tasks (7, 8) are explicitly build-verified + covered by the end-to-end manual check, with the reason stated.

**Type consistency:** `NewRun(goal, workspaceId, projectPath, playbook, ts)`, `CompletePhase(run, phaseIdx, artifacts)`, `ApproveGate(run)`, `SendBackGate(run)`, `CancelRun(run)`, `BuildPhasePrompt(phase, goal, priorArtifacts)`, `SpawnClaudeWorker(ctx, workspaceId, projectName, cwd, prompt)`, `EnsureWorkers(ctx, *run, projectName)`, `GetRun(ctx, channelId, runId)` are used identically across engine, orchestrator, persistence, and commands. `AdvanceRunCommand.Action` matches `RunAction_Complete/Approve/SendBack`. Phase/status/kind constants are referenced by their exact identifiers throughout. `CommandAdvanceRunData` carries `Artifacts` (not worker orefs — orefs are attached at spawn), matching `CompletePhase`'s signature.
