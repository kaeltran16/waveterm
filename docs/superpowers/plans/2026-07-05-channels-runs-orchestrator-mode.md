# Channels Runs — Dual-Mode / Orchestrator Mode (Piece 5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a second run execution style — an orchestrator mode where one long-lived Claude Code lead plans a goal and spawns its own in-process subagents, with an optional pause-and-steer plan gate — selectable per run alongside the existing pipeline mode.

**Architecture:** A `Mode` field on `Run` picks the playbook shape at creation. Orchestrator runs get a single `orchestrate` phase; the lead is spawned by the existing per-phase worker path with an orchestrator-specific prompt. The plan gate is a runtime `Held` flag the lead sets via `wsh jarvis hold`; `recomputeStatus` (the single source of truth for run status) maps a held running phase to `awaiting-review`, and approve resumes the same lead in place by steering `ControllerInputCommand` into it. Everything else — persistence, escalation coupling, the phase rail — is reused.

**Tech Stack:** Go (`pkg/jarvis`, `pkg/wshrpc`, `pkg/waveobj`, `cmd/wsh`), React 19 + jotai + Tailwind (`frontend/app/view/agents/`), Task-orchestrated codegen (`task generate`), vitest, Go test.

## Global Constraints

- **Never hand-edit generated files.** After changing any Go wshrpc/waveobj type, run `task generate` to regenerate `frontend/app/store/wshclientapi.ts`, `frontend/types/gotypes.d.ts`, and the generated Go/TS files. Edit the Go source, then regenerate.
- **Typecheck command:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (plain `npx tsc` stack-overflows on this repo). Baseline is clean (exit 0).
- **Go source of truth for the wire protocol** — the four run commands and their request types live in `pkg/wshrpc/wshrpctypes.go`; the interface method list at the top of that file must gain any new command.
- **No DB migration.** All new persisted state is additive JSON on existing objects (`Run`, `RunPhase`, `JarvisProfile`, `ProfileOverride`).
- **`recomputeStatus` is the single source of truth for `Run.Status`** — never set `Status` directly outside it, except `CancelRun` (terminal override). New status behavior goes into `recomputeStatus`.
- **Frequent commits** — one commit per task, using conventional-commit `type(runs): …` messages matching the repo's history (`feat(runs):`, `fix(runs):`, `docs(runs):`).
- **Copy/naming:** run modes are the exact strings `pipeline` and `orchestrator`; the orchestrate phase kind is `orchestrate`; the new advance action is `hold`; the wsh command group is `wsh jarvis` with subcommands `hold` and `complete`.

**Design reference:** `docs/superpowers/specs/2026-07-05-channels-runs-orchestrator-mode-design.md`.

---

## Task 1: Data model + profile resolution

Adds the persisted fields and extends the pure profile merge. Ends by regenerating bindings so later tasks (and the frontend) see the new types.

**Files:**
- Modify: `pkg/waveobj/wtype.go:214-249` (`RunPhase`, `Run`, `JarvisProfile`, `ProfileOverride`)
- Modify: `pkg/jarvis/run.go:14-47` (constants)
- Modify: `pkg/jarvis/resolve.go:54-65` (`ResolveProfile`)
- Test: `pkg/jarvis/resolve_test.go`

**Interfaces:**
- Produces: `waveobj.Run.Mode string`; `waveobj.RunPhase.Held bool`; `waveobj.JarvisProfile.DefaultMode string`, `.DefaultPlanGate *bool`; `waveobj.ProfileOverride.DefaultMode *string`, `.DefaultPlanGate *bool`.
- Produces constants in `pkg/jarvis`: `RunMode_Pipeline = "pipeline"`, `RunMode_Orchestrator = "orchestrator"`, `PhaseKind_Orchestrate = "orchestrate"`, `RunAction_Hold = "hold"`.
- Produces: `ResolveProfile` merges the two new override sections.

- [ ] **Step 1: Add the model fields**

In `pkg/waveobj/wtype.go`, edit the four structs:

```go
type RunPhase struct {
	Kind        string   `json:"kind"`               // brainstorm | plan | execute | orchestrate | custom
	Skill       string   `json:"skill,omitempty"`    // e.g. "superpowers:writing-plans"
	State       string   `json:"state"`              // pending | running | blocked | done | failed | skipped
	Gate        bool     `json:"gate,omitempty"`     // pipeline: halt after this phase; orchestrator: the lead was told to hold
	FreshCtx    bool     `json:"freshctx,omitempty"` // this phase runs in its own fresh worker (clear-context boundary)
	Held        bool     `json:"held,omitempty"`     // orchestrator: the lead paused itself at the plan gate (runtime)
	WorkerOrefs []string `json:"workerorefs,omitempty"`
	Artifacts   []string `json:"artifacts,omitempty"`
}

type Run struct {
	ID          string     `json:"id"`
	Goal        string     `json:"goal"`
	PlaybookId  string     `json:"playbookid,omitempty"`
	Mode        string     `json:"mode,omitempty"` // pipeline | orchestrator (empty = pipeline, legacy-safe)
	WorkspaceId string     `json:"workspaceid"`
	ProjectPath string     `json:"projectpath"`
	Principles  string     `json:"principles,omitempty"`
	Status      string     `json:"status"`
	Phases      []RunPhase `json:"phases"`
	CreatedTs   int64      `json:"createdts"`
}

type JarvisProfile struct {
	Playbook        []RunPhase `json:"playbook"`
	Principles      string     `json:"principles,omitempty"`
	DefaultMode     string     `json:"defaultmode,omitempty"`     // pipeline | orchestrator (empty = pipeline)
	DefaultPlanGate *bool      `json:"defaultplangate,omitempty"` // nil = on
}

type ProfileOverride struct {
	Playbook        *[]RunPhase `json:"playbook,omitempty"`
	Principles      *string     `json:"principles,omitempty"`
	DefaultMode     *string     `json:"defaultmode,omitempty"`
	DefaultPlanGate *bool       `json:"defaultplangate,omitempty"`
}
```

- [ ] **Step 2: Add the jarvis constants**

In `pkg/jarvis/run.go`, add a run-mode block and one phase kind + one action constant:

```go
// Run modes.
const (
	RunMode_Pipeline     = "pipeline"
	RunMode_Orchestrator = "orchestrator"
)
```

Add `PhaseKind_Orchestrate = "orchestrate"` to the phase-kind `const` block (lines 35-40) and `RunAction_Hold = "hold"` to the actions `const` block (lines 43-47).

- [ ] **Step 3: Write the failing ResolveProfile test**

Append to `pkg/jarvis/resolve_test.go`:

```go
func boolPtr(b bool) *bool       { return &b }
func strPtr(s string) *string    { return &s }

func TestResolveProfile_DefaultModeAndGate(t *testing.T) {
	global := waveobj.JarvisProfile{DefaultMode: RunMode_Pipeline, DefaultPlanGate: boolPtr(true)}

	// nil override inherits global
	got := ResolveProfile(global, nil)
	if got.DefaultMode != RunMode_Pipeline || got.DefaultPlanGate == nil || *got.DefaultPlanGate != true {
		t.Fatalf("nil override: got mode=%q gate=%v", got.DefaultMode, got.DefaultPlanGate)
	}

	// override replaces both sections
	ov := &waveobj.ProfileOverride{DefaultMode: strPtr(RunMode_Orchestrator), DefaultPlanGate: boolPtr(false)}
	got = ResolveProfile(global, ov)
	if got.DefaultMode != RunMode_Orchestrator || got.DefaultPlanGate == nil || *got.DefaultPlanGate != false {
		t.Fatalf("override: got mode=%q gate=%v", got.DefaultMode, got.DefaultPlanGate)
	}
}
```

(If `boolPtr`/`strPtr` already exist in the test file, drop the duplicate helpers.)

- [ ] **Step 4: Run the test — expect FAIL**

Run: `go test ./pkg/jarvis/ -run TestResolveProfile_DefaultModeAndGate -v`
Expected: FAIL — `ResolveProfile` does not copy the new fields (override values are dropped).

- [ ] **Step 5: Extend ResolveProfile**

In `pkg/jarvis/resolve.go`, inside `ResolveProfile`'s `if override != nil` block, add after the `Principles` clause:

```go
		if override.DefaultMode != nil {
			out.DefaultMode = *override.DefaultMode
		}
		if override.DefaultPlanGate != nil {
			out.DefaultPlanGate = override.DefaultPlanGate
		}
```

- [ ] **Step 6: Run the test — expect PASS**

Run: `go test ./pkg/jarvis/ -run TestResolveProfile_DefaultModeAndGate -v`
Expected: PASS.

- [ ] **Step 7: Regenerate bindings**

Run: `task generate`
Expected: exit 0; `frontend/types/gotypes.d.ts` now shows `mode?`, `held?`, `defaultmode?`, `defaultplangate?` on the respective types. Do not hand-edit the generated output.

- [ ] **Step 8: Commit**

```bash
git add pkg/waveobj/wtype.go pkg/jarvis/run.go pkg/jarvis/resolve.go pkg/jarvis/resolve_test.go frontend/types/gotypes.d.ts frontend/app/store/wshclientapi.ts
git commit -m "feat(runs): add run Mode, phase Held, profile default-mode/gate + resolve"
```

---

## Task 2: Orchestrator engine pure functions

The heart of the feature: the orchestrator playbook, prompt, hold/approve state transitions, and the `recomputeStatus` held clause. All pure and unit-tested.

**Files:**
- Modify: `pkg/jarvis/run.go` (`NewRun`, `recomputeStatus`, `ApproveGate`; add `DefaultOrchestratorPlaybook`, `BuildOrchestratePrompt`, `HoldPhase`, `heldPhaseIndex`)
- Test: `pkg/jarvis/run_test.go`

**Interfaces:**
- Consumes (Task 1): `RunMode_*`, `PhaseKind_Orchestrate`, `waveobj.RunPhase.Held`, `waveobj.Run.Mode`.
- Produces:
  - `func DefaultOrchestratorPlaybook(gate bool) []waveobj.RunPhase`
  - `func BuildOrchestratePrompt(goal, principles string, gate bool) string`
  - `func HoldPhase(run waveobj.Run, phaseIdx int) (waveobj.Run, error)`
  - `func heldPhaseIndex(run waveobj.Run) int` (unexported)
  - `func NewRun(goal, workspaceId, projectPath, principles, mode string, playbook []waveobj.RunPhase, ts int64) waveobj.Run` — **signature gains `mode`** (positioned after `principles`).
  - `ApproveGate` now resumes a held phase in place.

- [ ] **Step 1: Write the failing tests**

Append to `pkg/jarvis/run_test.go`:

```go
func orchRun(gate bool) waveobj.Run {
	return NewRun("ship it", "ws1", "/p", "be clean", RunMode_Orchestrator, DefaultOrchestratorPlaybook(gate), 1)
}

func TestDefaultOrchestratorPlaybook(t *testing.T) {
	pb := DefaultOrchestratorPlaybook(true)
	if len(pb) != 1 || pb[0].Kind != PhaseKind_Orchestrate || !pb[0].Gate {
		t.Fatalf("gate playbook: %+v", pb)
	}
	if DefaultOrchestratorPlaybook(false)[0].Gate {
		t.Fatalf("no-gate playbook should not be gated")
	}
}

func TestHoldPhase_AwaitingReview(t *testing.T) {
	r := orchRun(true) // phase 0 running, gated
	r, err := HoldPhase(r, 0)
	if err != nil {
		t.Fatal(err)
	}
	if !r.Phases[0].Held || r.Status != RunStatus_AwaitingReview {
		t.Fatalf("held=%v status=%q", r.Phases[0].Held, r.Status)
	}
}

func TestHoldPhase_RejectsUngated(t *testing.T) {
	r := orchRun(false)
	if _, err := HoldPhase(r, 0); err == nil {
		t.Fatal("expected error holding an ungated phase")
	}
}

func TestApproveGate_ResumesHeldInPlace(t *testing.T) {
	r := orchRun(true)
	r, _ = HoldPhase(r, 0)
	r, err := ApproveGate(r)
	if err != nil {
		t.Fatal(err)
	}
	if r.Phases[0].Held {
		t.Fatal("approve should clear Held")
	}
	if r.Phases[0].State != PhaseState_Running || r.Status != RunStatus_Executing {
		t.Fatalf("after approve: state=%q status=%q", r.Phases[0].State, r.Status)
	}
}

func TestBuildOrchestratePrompt(t *testing.T) {
	p := BuildOrchestratePrompt("do X", "be clean", true)
	for _, want := range []string{"do X", "be clean", "wsh jarvis hold", "wsh jarvis complete", "subagent"} {
		if !strings.Contains(p, want) {
			t.Fatalf("prompt missing %q:\n%s", want, p)
		}
	}
	if strings.Contains(BuildOrchestratePrompt("do X", "", false), "wsh jarvis hold") {
		t.Fatal("no-gate prompt must not tell the lead to hold")
	}
}
```

(`strings` is already imported in `run.go`; add it to the test file's imports if missing.)

- [ ] **Step 2: Run the tests — expect FAIL**

Run: `go test ./pkg/jarvis/ -run 'TestDefaultOrchestratorPlaybook|TestHoldPhase|TestApproveGate_ResumesHeldInPlace|TestBuildOrchestratePrompt' -v`
Expected: FAIL — undefined `DefaultOrchestratorPlaybook`, `HoldPhase`, `BuildOrchestratePrompt`, and `NewRun` arity mismatch.

- [ ] **Step 3: Add the orchestrator playbook + prompt**

In `pkg/jarvis/run.go`, after `DefaultPlaybook` (line 57):

```go
// DefaultOrchestratorPlaybook is a single adaptive "orchestrate" phase. The lead plans and dispatches
// its own subagents; gate=true tells the lead (via BuildOrchestratePrompt) to hold for plan review.
func DefaultOrchestratorPlaybook(gate bool) []waveobj.RunPhase {
	return []waveobj.RunPhase{
		{Kind: PhaseKind_Orchestrate, Skill: "superpowers:subagent-driven-development", State: PhaseState_Pending, Gate: gate},
	}
}
```

After `BuildPhasePrompt` (line 198):

```go
// BuildOrchestratePrompt is the lead's initial prompt for an orchestrator run: plan, then execute
// adaptively by dispatching subagents, carrying the principles down to each. A gated run tells the lead
// to hold after planning; every run tells it to report completion. Self-report verbs are wsh commands.
func BuildOrchestratePrompt(goal, principles string, gate bool) string {
	var b strings.Builder
	if strings.TrimSpace(principles) != "" {
		fmt.Fprintf(&b, "Work by these principles, and propagate them into every subagent you dispatch:\n%s\n\n", principles)
	}
	b.WriteString("You are the lead orchestrator for this goal. Plan the work using the superpowers:writing-plans approach, then execute it adaptively by dispatching your own subagents (superpowers:subagent-driven-development / superpowers:dispatching-parallel-agents).\n")
	if gate {
		b.WriteString("First write the plan, then run `wsh jarvis hold` and wait — do not dispatch any subagents until you are told to proceed.\n")
	}
	fmt.Fprintf(&b, "Goal: %s\n", goal)
	b.WriteString("When the goal is fully accomplished, run `wsh jarvis complete`.\n")
	return strings.TrimRight(b.String(), "\n")
}
```

- [ ] **Step 4: Add HoldPhase + heldPhaseIndex**

In `pkg/jarvis/run.go`, after `CompletePhase` (line 129):

```go
// HoldPhase marks a gated running phase as held (the lead paused itself for plan review). recomputeStatus
// derives awaiting-review. Errors (out of range / not running / not gated) fail safe — the caller no-ops.
func HoldPhase(run waveobj.Run, phaseIdx int) (waveobj.Run, error) {
	if phaseIdx < 0 || phaseIdx >= len(run.Phases) {
		return run, fmt.Errorf("phase index %d out of range", phaseIdx)
	}
	if run.Phases[phaseIdx].State != PhaseState_Running {
		return run, fmt.Errorf("phase %d is %q, not running", phaseIdx, run.Phases[phaseIdx].State)
	}
	if !run.Phases[phaseIdx].Gate {
		return run, fmt.Errorf("phase %d is not gated; nothing to hold", phaseIdx)
	}
	run.Phases[phaseIdx].Held = true
	recomputeStatus(&run)
	return run, nil
}

// heldPhaseIndex returns the index of a held running phase (orchestrator plan gate), or -1.
func heldPhaseIndex(run waveobj.Run) int {
	for i := range run.Phases {
		if run.Phases[i].State == PhaseState_Running && run.Phases[i].Held {
			return i
		}
	}
	return -1
}
```

- [ ] **Step 5: Add the recomputeStatus held clause**

In `recomputeStatus` (line 83), right after `cur := r.Phases[firstOpen]` (line 95), insert:

```go
	if cur.State == PhaseState_Running && cur.Held {
		r.Status = RunStatus_AwaitingReview
		return
	}
```

- [ ] **Step 6: Teach ApproveGate the held case**

In `ApproveGate` (line 146), after the `awaiting-review` guard and before `gi := gateIndex(run)`:

```go
	// orchestrator: a held running phase resumes in place (no successor to start).
	if hi := heldPhaseIndex(run); hi >= 0 {
		run.Phases[hi].Held = false
		recomputeStatus(&run)
		return run, nil
	}
```

- [ ] **Step 7: Add the mode param to NewRun**

Change the `NewRun` signature (line 61) and set `Mode`:

```go
func NewRun(goal, workspaceId, projectPath, principles, mode string, playbook []waveobj.RunPhase, ts int64) waveobj.Run {
```

and add `Mode: mode,` to the `waveobj.Run{…}` literal (after `Goal`).

Update the existing caller in `pkg/wshrpc/wshserver/wshserver.go:1782` to pass a mode — for now pass `jarvis.RunMode_Pipeline` (Task 4 replaces it with the resolved mode):

```go
	run := jarvis.NewRun(data.Goal, data.WorkspaceId, ch.ProjectPath, resolved.Principles, jarvis.RunMode_Pipeline, playbook, time.Now().UnixMilli())
```

Fix any existing `NewRun(` calls in `pkg/jarvis/run_test.go` to add the `mode` argument (use `RunMode_Pipeline` where mode is irrelevant to the test).

- [ ] **Step 8: Run the tests — expect PASS (whole package)**

Run: `go test ./pkg/jarvis/ -v`
Expected: PASS, including the pre-existing pipeline tests (proves the held clause and ApproveGate branch didn't regress pipeline gating).

- [ ] **Step 9: Commit**

```bash
git add pkg/jarvis/run.go pkg/jarvis/run_test.go pkg/wshrpc/wshserver/wshserver.go
git commit -m "feat(runs): orchestrator playbook, prompt, hold + approve-in-place transitions"
```

---

## Task 3: Mode-aware worker prompt

Make `EnsureWorkers` build the orchestrator prompt for orchestrator runs. Extract the choice into a pure helper so it is unit-tested (the spawn itself is side-effectful and covered by the final CDP pass).

**Files:**
- Modify: `pkg/jarvis/runexec.go:78-93` (`EnsureWorkers`; add `phasePrompt`)
- Test: `pkg/jarvis/runexec_test.go` (create if absent)

**Interfaces:**
- Consumes (Task 2): `BuildOrchestratePrompt`, `RunMode_Orchestrator`.
- Produces: `func phasePrompt(run *waveobj.Run, idx int) string`.

- [ ] **Step 1: Write the failing test**

Create/append `pkg/jarvis/runexec_test.go`:

```go
package jarvis

import (
	"strings"
	"testing"
)

func TestPhasePrompt_ModeAware(t *testing.T) {
	orch := NewRun("do X", "ws", "/p", "be clean", RunMode_Orchestrator, DefaultOrchestratorPlaybook(true), 1)
	if p := phasePrompt(&orch, 0); !strings.Contains(p, "wsh jarvis hold") {
		t.Fatalf("orchestrator prompt should hold-gate:\n%s", p)
	}

	pipe := NewRun("do X", "ws", "/p", "be clean", RunMode_Pipeline, DefaultPlaybook(), 1)
	if p := phasePrompt(&pipe, 0); strings.Contains(p, "wsh jarvis") {
		t.Fatalf("pipeline prompt should not use orchestrate verbs:\n%s", p)
	}
}
```

- [ ] **Step 2: Run the test — expect FAIL**

Run: `go test ./pkg/jarvis/ -run TestPhasePrompt_ModeAware -v`
Expected: FAIL — undefined `phasePrompt`.

- [ ] **Step 3: Add phasePrompt and use it in EnsureWorkers**

In `pkg/jarvis/runexec.go`, add above `EnsureWorkers`:

```go
// phasePrompt builds the initial worker prompt for a phase, mode-aware: orchestrator runs get the
// adaptive lead prompt; pipeline runs get the per-phase skill prompt.
func phasePrompt(run *waveobj.Run, idx int) string {
	p := run.Phases[idx]
	if run.Mode == RunMode_Orchestrator {
		return BuildOrchestratePrompt(run.Goal, run.Principles, p.Gate)
	}
	return BuildPhasePrompt(p, run.Goal, priorArtifacts(run, idx), run.Principles)
}
```

In `EnsureWorkers`, replace the prompt line (currently line 85):

```go
		prompt := phasePrompt(run, i)
```

- [ ] **Step 4: Run the test — expect PASS**

Run: `go test ./pkg/jarvis/ -run TestPhasePrompt_ModeAware -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add pkg/jarvis/runexec.go pkg/jarvis/runexec_test.go
git commit -m "feat(runs): mode-aware worker prompt selection in EnsureWorkers"
```

---

## Task 4: CreateRun mode + plan-gate wiring

Accept a mode and plan-gate on `CreateRunCommand`, resolve the effective values against the profile, and build the right playbook. Extract the pure resolution into a helper for testing.

**Files:**
- Modify: `pkg/wshrpc/wshrpctypes.go:762-768` (`CommandCreateRunData`)
- Modify: `pkg/wshrpc/wshserver/wshserver.go:1768-1794` (`CreateRunCommand`; add `resolveRunPlan`)
- Test: `pkg/wshrpc/wshserver/wshserver_run_test.go` (create if absent)
- Regenerate: `task generate`

**Interfaces:**
- Consumes (Tasks 1-2): `RunMode_*`, `DefaultOrchestratorPlaybook`, `DefaultPlaybook`, `NewRun`, `waveobj.JarvisProfile.DefaultMode/DefaultPlanGate`.
- Produces: `CommandCreateRunData.Mode string`, `.PlanGate *bool`; `func resolveRunPlan(resolved waveobj.JarvisProfile, reqMode string, reqPlanGate *bool) (mode string, playbook []waveobj.RunPhase)`.

- [ ] **Step 1: Add the request fields**

In `pkg/wshrpc/wshrpctypes.go`, extend `CommandCreateRunData`:

```go
type CommandCreateRunData struct {
	ChannelId   string `json:"channelid"`
	WorkspaceId string `json:"workspaceid"` // where phase-worker tabs are created
	Goal        string `json:"goal"`
	PlaybookId  string `json:"playbookid,omitempty"`
	Mode        string `json:"mode,omitempty"`     // pipeline | orchestrator (empty = resolved profile default)
	PlanGate    *bool  `json:"plangate,omitempty"` // orchestrator plan gate; nil = resolved profile default
}
```

- [ ] **Step 2: Write the failing test for resolveRunPlan**

Create `pkg/wshrpc/wshserver/wshserver_run_test.go`:

```go
package wshserver

import (
	"testing"

	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func bptr(b bool) *bool { return &b }

func TestResolveRunPlan(t *testing.T) {
	pipe := jarvis.DefaultPlaybook()
	resolved := waveobj.JarvisProfile{Playbook: pipe, DefaultMode: jarvis.RunMode_Pipeline}

	// explicit orchestrator + gate on -> single gated orchestrate phase
	mode, pb := resolveRunPlan(resolved, jarvis.RunMode_Orchestrator, bptr(true))
	if mode != jarvis.RunMode_Orchestrator || len(pb) != 1 || pb[0].Kind != jarvis.PhaseKind_Orchestrate || !pb[0].Gate {
		t.Fatalf("orchestrator: mode=%q pb=%+v", mode, pb)
	}

	// empty request falls to the profile default (pipeline) with the profile playbook
	mode, pb = resolveRunPlan(resolved, "", nil)
	if mode != jarvis.RunMode_Pipeline || len(pb) != len(pipe) {
		t.Fatalf("default: mode=%q len=%d", mode, len(pb))
	}

	// orchestrator with no explicit gate + no profile default -> gate ON (safe default)
	_, pb = resolveRunPlan(waveobj.JarvisProfile{DefaultMode: jarvis.RunMode_Orchestrator}, "", nil)
	if len(pb) != 1 || !pb[0].Gate {
		t.Fatalf("gate default should be on: %+v", pb)
	}
}
```

- [ ] **Step 3: Run the test — expect FAIL**

Run: `go test ./pkg/wshrpc/wshserver/ -run TestResolveRunPlan -v`
Expected: FAIL — undefined `resolveRunPlan`.

- [ ] **Step 4: Add resolveRunPlan and use it in CreateRunCommand**

In `pkg/wshrpc/wshserver/wshserver.go`, add above `CreateRunCommand`:

```go
// resolveRunPlan derives the effective mode + playbook for a new run from the resolved profile and the
// request's optional overrides. Precedence: request > profile default > built-in (pipeline; gate on).
func resolveRunPlan(resolved waveobj.JarvisProfile, reqMode string, reqPlanGate *bool) (string, []waveobj.RunPhase) {
	mode := reqMode
	if mode == "" {
		mode = resolved.DefaultMode
	}
	if mode == "" {
		mode = jarvis.RunMode_Pipeline
	}
	if mode == jarvis.RunMode_Orchestrator {
		gate := true
		if reqPlanGate != nil {
			gate = *reqPlanGate
		} else if resolved.DefaultPlanGate != nil {
			gate = *resolved.DefaultPlanGate
		}
		return mode, jarvis.DefaultOrchestratorPlaybook(gate)
	}
	playbook := resolved.Playbook
	if len(playbook) == 0 {
		playbook = jarvis.DefaultPlaybook()
	}
	return mode, playbook
}
```

Replace the playbook/NewRun block in `CreateRunCommand` (lines 1778-1782) with:

```go
	mode, playbook := resolveRunPlan(resolved, data.Mode, data.PlanGate)
	run := jarvis.NewRun(data.Goal, data.WorkspaceId, ch.ProjectPath, resolved.Principles, mode, playbook, time.Now().UnixMilli())
```

- [ ] **Step 5: Run the test — expect PASS**

Run: `go test ./pkg/wshrpc/wshserver/ -run TestResolveRunPlan -v`
Expected: PASS.

- [ ] **Step 6: Regenerate bindings**

Run: `task generate`
Expected: exit 0; `CommandCreateRunData` in `frontend/types/gotypes.d.ts` now has `mode?` and `plangate?`.

- [ ] **Step 7: Commit**

```bash
git add pkg/wshrpc/wshrpctypes.go pkg/wshrpc/wshserver/wshserver.go pkg/wshrpc/wshserver/wshserver_run_test.go frontend/types/gotypes.d.ts frontend/app/store/wshclientapi.ts
git commit -m "feat(runs): CreateRun accepts mode + plan-gate, resolves against profile"
```

---

## Task 5: Server hold action + approve-in-place steer

Teach `AdvanceRunCommand` the `hold` action and make approve steer the held lead in place instead of only starting a successor.

**Files:**
- Modify: `pkg/wshrpc/wshserver/wshserver.go:1796-1832` (`AdvanceRunCommand`; add `steerRunLead`)

**Interfaces:**
- Consumes (Task 2): `jarvis.HoldPhase`, `jarvis.RunAction_Hold`; `blockcontroller.SendInput`, `blockcontroller.BlockInputUnion` (see `pkg/agentask/deliver.go:15` for the call shape).
- Produces: `AdvanceRunCommand` handles `hold`; approve on a held phase steers `"approved, proceed\r"` into the lead's block.

- [ ] **Step 1: Add the hold case**

In `AdvanceRunCommand`'s action switch (lines 1803-1812), add:

```go
		case jarvis.RunAction_Hold:
			next, e = jarvis.HoldPhase(*r, data.PhaseIdx)
```

- [ ] **Step 2: Add the steer helper**

Add near `spawnRunWorkers` in `wshserver.go` (import `github.com/wavetermdev/waveterm/pkg/blockcontroller` if not already imported by this file):

```go
// steerRunLead sends a line of input into the block of a run worker (tab oref "tab:<id>"), resuming a
// long-lived lead in place. Best-effort: resolution/send failures are logged, never fatal.
func steerRunLead(ctx context.Context, tabORef, text string) {
	oref, err := waveobj.ParseORef(tabORef)
	if err != nil || oref.OType != waveobj.OType_Tab {
		log.Printf("steerRunLead: bad oref %q: %v", tabORef, err)
		return
	}
	tab, err := wstore.DBMustGet[*waveobj.Tab](ctx, oref.OID)
	if err != nil || len(tab.BlockIds) == 0 {
		log.Printf("steerRunLead: no block for %q: %v", tabORef, err)
		return
	}
	if err := blockcontroller.SendInput(tab.BlockIds[0], &blockcontroller.BlockInputUnion{InputData: []byte(text)}); err != nil {
		log.Printf("steerRunLead: sending input to %q: %v", tabORef, err)
	}
}
```

(Confirm `log` and `waveobj` are imported in this file — they are used elsewhere in it.)

- [ ] **Step 3: Steer on approve-in-place**

In `AdvanceRunCommand`, capture the held lead before the update and steer after it. Immediately after the initial guard (`if data.ChannelId == "" …`), add:

```go
	// approve-in-place: an orchestrator lead held at the plan gate resumes via steer, not a fresh worker.
	leadToSteer := ""
	if data.Action == jarvis.RunAction_Approve {
		if pre, perr := wstore.GetRun(ctx, data.ChannelId, data.RunId); perr == nil {
			for i := range pre.Phases {
				if pre.Phases[i].State == jarvis.PhaseState_Running && pre.Phases[i].Held && len(pre.Phases[i].WorkerOrefs) > 0 {
					leadToSteer = pre.Phases[i].WorkerOrefs[0]
					break
				}
			}
		}
	}
```

Then after the `spawnRunWorkers` call succeeds and before the final `SendWaveObjUpdate` (line 1830), add:

```go
	if leadToSteer != "" {
		steerRunLead(ctx, leadToSteer, "approved, proceed\r")
	}
```

(Spawning a successor for a held orchestrator phase is a no-op: the single phase is still `running`, so `EnsureWorkers`' `len(WorkerOrefs) > 0` guard skips it.)

- [ ] **Step 4: Build the server**

Run: `go build ./pkg/wshrpc/wshserver/`
Expected: exit 0. (Behavior is exercised end-to-end in Task 10's CDP pass; the pure transitions it calls — `HoldPhase`, `ApproveGate` held branch — are already unit-tested in Task 2.)

- [ ] **Step 5: Commit**

```bash
git add pkg/wshrpc/wshserver/wshserver.go
git commit -m "feat(runs): AdvanceRun hold action + approve steers held lead in place"
```

---

## Task 6: Lead self-report — `wsh jarvis hold` / `complete`

The lead reports the plan gate and completion itself. A new command resolves the caller's run/phase from its tab oref server-side and delegates to `AdvanceRunCommand`.

**Files:**
- Modify: `pkg/wshrpc/wshrpctypes.go` (interface method list ~line 117-127; add request type near line 781)
- Modify: `pkg/wshrpc/wshserver/wshserver.go` (add `ReportRunPhaseCommand`)
- Create: `cmd/wsh/cmd/wshcmd-jarvis.go`
- Regenerate: `task generate`

**Interfaces:**
- Consumes: `wstore.GetChannels`, `jarvis.ResolveRunWorker`, `jarvis.RunAction_Hold`/`_Complete`, `ws.AdvanceRunCommand`; `getTabIdFromEnv()` (`cmd/wsh/cmd/wshcmd-root.go:212`), `wshclient.ReportRunPhaseCommand` (generated), `RpcClient`, `preRunSetupRpcClient`.
- Produces: `CommandReportRunPhaseData{ ORef, Action, Artifacts }`; `ReportRunPhaseCommand`; `wsh jarvis hold` / `wsh jarvis complete`.

- [ ] **Step 1: Declare the command**

In `pkg/wshrpc/wshrpctypes.go`, add to the wshrpc interface method list (with the other run commands, ~line 123-127):

```go
	ReportRunPhaseCommand(ctx context.Context, data CommandReportRunPhaseData) error // lead self-reports hold/complete; resolves run/phase from its own oref
```

and add the request type near `CommandAdvanceRunData` (line 773):

```go
type CommandReportRunPhaseData struct {
	ORef      string   `json:"oref"`                // caller's tab oref ("tab:<id>")
	Action    string   `json:"action"`              // hold | complete
	Artifacts []string `json:"artifacts,omitempty"` // recorded on complete
}
```

- [ ] **Step 2: Implement the server handler**

In `pkg/wshrpc/wshserver/wshserver.go`, add:

```go
func (ws *WshServer) ReportRunPhaseCommand(ctx context.Context, data wshrpc.CommandReportRunPhaseData) error {
	if data.ORef == "" {
		return fmt.Errorf("oref is required")
	}
	channels, err := wstore.GetChannels(ctx)
	if err != nil {
		return fmt.Errorf("loading channels: %w", err)
	}
	m := jarvis.ResolveRunWorker(channels, data.ORef)
	if m == nil {
		log.Printf("ReportRunPhase: no run owns oref %q (ignoring)", data.ORef)
		return nil // fail safe: a stray report is a no-op, not an error
	}
	return ws.AdvanceRunCommand(ctx, wshrpc.CommandAdvanceRunData{
		ChannelId: m.Channel.OID,
		RunId:     m.Run.ID,
		PhaseIdx:  m.PhaseIdx,
		Action:    data.Action,
		Artifacts: data.Artifacts,
	})
}
```

(Add `RunAction_Complete` usage is implicit — the lead passes `"complete"`, already a valid `AdvanceRun` action.)

- [ ] **Step 3: Add the wsh command group**

Create `cmd/wsh/cmd/wshcmd-jarvis.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"fmt"

	"github.com/spf13/cobra"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshrpc/wshclient"
)

var jarvisCmd = &cobra.Command{
	Use:   "jarvis",
	Short: "report run progress to Jarvis (used by an orchestrator lead)",
}

var jarvisHoldCmd = &cobra.Command{
	Use:     "hold",
	Short:   "pause the current run at its plan gate for review",
	RunE:    func(cmd *cobra.Command, args []string) error { return reportRunPhase("hold") },
	PreRunE: preRunSetupRpcClient,
}

var jarvisCompleteCmd = &cobra.Command{
	Use:     "complete",
	Short:   "mark the current run's phase complete",
	RunE:    func(cmd *cobra.Command, args []string) error { return reportRunPhase("complete") },
	PreRunE: preRunSetupRpcClient,
}

func init() {
	jarvisCmd.AddCommand(jarvisHoldCmd)
	jarvisCmd.AddCommand(jarvisCompleteCmd)
	rootCmd.AddCommand(jarvisCmd)
}

func reportRunPhase(action string) error {
	tabId := getTabIdFromEnv()
	if tabId == "" {
		return fmt.Errorf("no WAVETERM_TABID env var set")
	}
	oref := waveobj.MakeORef(waveobj.OType_Tab, tabId).String()
	return wshclient.ReportRunPhaseCommand(RpcClient, wshrpc.CommandReportRunPhaseData{ORef: oref, Action: action}, nil)
}
```

- [ ] **Step 4: Regenerate + build**

Run: `task generate && go build ./cmd/wsh/ ./pkg/wshrpc/...`
Expected: exit 0; `wshclient.ReportRunPhaseCommand` now exists.

- [ ] **Step 5: Smoke-check the command wiring**

Run: `go run ./cmd/wsh jarvis --help`
Expected: help text listing `hold` and `complete` subcommands (no RPC call is made by `--help`).

- [ ] **Step 6: Commit**

```bash
git add pkg/wshrpc/wshrpctypes.go pkg/wshrpc/wshserver/wshserver.go cmd/wsh/cmd/wshcmd-jarvis.go pkg/wshrpc/wshclient/wshclient.go frontend/app/store/wshclientapi.ts frontend/types/gotypes.d.ts
git commit -m "feat(runs): wsh jarvis hold/complete lead self-report + server resolver"
```

---

## Task 7: Frontend run-model derivations

Pure TS: recognize the held gate, the run mode, and the composer summary. No React.

**Files:**
- Modify: `frontend/app/view/agents/runmodel.ts` (`reviewGate`; add `isOrchestrator`, `composerSummary`)
- Test: `frontend/app/view/agents/runmodel.test.ts`

**Interfaces:**
- Consumes (Task 1 regen): `Run.mode`, `RunPhase.held`.
- Produces: `reviewGate` also matches a held running phase; `isOrchestrator(run: Run): boolean`; `composerSummary(mode: string, planGate: boolean): string`.

- [ ] **Step 1: Write the failing tests**

Append to `frontend/app/view/agents/runmodel.test.ts`:

```ts
import { composerSummary, isOrchestrator, reviewGate } from "./runmodel";

function orchHeldRun(): Run {
    return {
        id: "r1", goal: "g", mode: "orchestrator", status: "awaiting-review",
        phases: [{ kind: "orchestrate", state: "running", gate: true, held: true }],
        createdts: 1, workspaceid: "w", projectpath: "/p",
    } as unknown as Run;
}

test("reviewGate matches a held orchestrator phase", () => {
    expect(reviewGate(orchHeldRun())).toEqual({ phaseIdx: 0 });
});

test("isOrchestrator reads the mode", () => {
    expect(isOrchestrator(orchHeldRun())).toBe(true);
    expect(isOrchestrator({ mode: "pipeline" } as unknown as Run)).toBe(false);
    expect(isOrchestrator({} as unknown as Run)).toBe(false);
});

test("composerSummary describes mode + gate", () => {
    expect(composerSummary("orchestrator", true)).toBe("orchestrator · plan gate on");
    expect(composerSummary("orchestrator", false)).toBe("orchestrator · hands-off");
    expect(composerSummary("pipeline", true)).toBe("pipeline · Superpowers default");
});
```

- [ ] **Step 2: Run the tests — expect FAIL**

Run: `npx vitest run frontend/app/view/agents/runmodel.test.ts`
Expected: FAIL — `composerSummary`/`isOrchestrator` not exported; held gate not matched.

- [ ] **Step 3: Update reviewGate + add helpers**

In `frontend/app/view/agents/runmodel.ts`, replace `reviewGate` (lines 54-68) with:

```ts
export function reviewGate(run: Run): { phaseIdx: number } | null {
    if (run.status !== "awaiting-review") {
        return null;
    }
    const phases = run.phases ?? [];
    // orchestrator: a held running phase resumes in place
    for (let i = 0; i < phases.length; i++) {
        if (phases[i].state === "running" && phases[i].held) {
            return { phaseIdx: i };
        }
    }
    // pipeline: a completed gate whose successor is still pending (or absent)
    for (let i = 0; i < phases.length; i++) {
        if (phases[i].gate && phases[i].state === "done") {
            const next = phases[i + 1];
            if (!next || next.state === "pending") {
                return { phaseIdx: i };
            }
        }
    }
    return null;
}

export function isOrchestrator(run: Run): boolean {
    return run.mode === "orchestrator";
}

// One-line summary of what "Start run" will do, shown under the composer.
export function composerSummary(mode: string, planGate: boolean): string {
    if (mode === "orchestrator") {
        return planGate ? "orchestrator · plan gate on" : "orchestrator · hands-off";
    }
    return "pipeline · Superpowers default";
}
```

- [ ] **Step 4: Run the tests — expect PASS**

Run: `npx vitest run frontend/app/view/agents/runmodel.test.ts`
Expected: PASS (including the existing pipeline `reviewGate` cases).

- [ ] **Step 5: Commit**

```bash
git add frontend/app/view/agents/runmodel.ts frontend/app/view/agents/runmodel.test.ts
git commit -m "feat(runs): run-model helpers for held gate, mode, composer summary"
```

---

## Task 8: Header mode chips + plan-gate toggle, composer summary

Make the header autonomy slot view-aware (tiers in Chat, mode chips in Runs), thread the selected mode/gate into `RunsView.startRun`, and persist the default mode to the profile.

**Files:**
- Modify: `frontend/app/view/agents/runactions.ts:13-22` (`createRun` opts)
- Modify: `frontend/app/view/agents/channelssurface.tsx` (header slot ~984-1015, `ChannelsSurface` state ~849-871, `RunsView` render ~1018-1019)
- Modify: `frontend/app/view/agents/runssurface.tsx` (`RunsView` props/`startRun` 249-275, composer label line 390)

**Interfaces:**
- Consumes (Tasks 1,4,7): `CreateRunCommand` `mode`/`plangate`; `getJarvisProfile` resolved `defaultmode`/`defaultplangate`; `setChannelProfile`; `composerSummary`.
- Produces: `createRun(channelId, goal, opts?: { mode?: string; planGate?: boolean })`; `RunsView` accepts `runMode: string` and `planGate: boolean` props.

- [ ] **Step 1: Extend createRun**

Replace `createRun` in `frontend/app/view/agents/runactions.ts`:

```ts
export async function createRun(
    channelId: string,
    goal: string,
    opts?: { mode?: string; planGate?: boolean }
): Promise<Run> {
    const workspaceId = globalStore.get(atoms.workspaceId);
    const rtn = await RpcApi.CreateRunCommand(TabRpcClient, {
        channelid: channelId,
        workspaceid: workspaceId,
        goal,
        mode: opts?.mode,
        plangate: opts?.planGate,
    });
    return rtn.run;
}
```

- [ ] **Step 2: Thread mode/gate through RunsView**

In `frontend/app/view/agents/runssurface.tsx`, change the `RunsView` signature (line 249):

```ts
export function RunsView({
    model,
    channel,
    agents,
    runMode,
    planGate,
}: {
    model: AgentsViewModel;
    channel: Channel;
    agents: AgentVM[];
    runMode: string;
    planGate: boolean;
}) {
```

Update `startRun` (lines 265-275) to pass them:

```ts
    const startRun = () => {
        const goal = draft.trim();
        if (!goal) {
            return;
        }
        setDraft("");
        fireAndForget(async () => {
            const created = await createRun(channel.oid, goal, { mode: runMode, planGate });
            setActiveRunId(created.id);
        });
    };
```

Replace the static composer label (line 390) — first add `composerSummary` to the `runmodel` import block (lines 17-25), then:

```tsx
                        <span className="font-mono text-[11.5px] text-ink-mid">{composerSummary(runMode, planGate)}</span>
```

- [ ] **Step 3: Own mode/gate state in ChannelsSurface**

In `frontend/app/view/agents/channelssurface.tsx`, add state alongside the existing `view` state (after line 853) — and import `getJarvisProfile`, `setChannelProfile` from `./runactions` and `composerSummary` is not needed here:

```tsx
    const [runMode, setRunMode] = useState<string>("pipeline");
    const [planGate, setPlanGate] = useState<boolean>(true);
```

Load them from the resolved profile when the channel changes — add after the `setView(defaultView(active))` effect (line 871):

```tsx
    useEffect(() => {
        if (!activeId) {
            return;
        }
        fireAndForget(async () => {
            const p = await getJarvisProfile(activeId);
            setRunMode(p.resolved.defaultmode || "pipeline");
            setPlanGate(p.resolved.defaultplangate ?? true);
        });
    }, [activeId]);
```

- [ ] **Step 4: Make the header slot view-aware**

Replace the tier-selector block (lines 984-1015) so tiers show only in Chat and mode chips show in Runs:

```tsx
                            {active && view === "chat" ? (
                                <div
                                    className="flex flex-none items-center gap-0.5 rounded-[7px] border border-edge-mid p-0.5"
                                    title="Jarvis autonomy for this channel: Concierge observes; Gatekeeper auto-answers routine asks; Delegator spawns and runs workers toward a goal"
                                >
                                    {(["concierge", "gatekeeper", "delegator"] as const).map((t) => (
                                        <button
                                            key={t}
                                            type="button"
                                            onClick={() =>
                                                fireAndForget(() =>
                                                    RpcApi.SetChannelTierCommand(TabRpcClient, {
                                                        channelid: active.oid,
                                                        tier: t,
                                                        mode:
                                                            ((active.meta as Record<string, unknown> | undefined)?.[
                                                                "delegator:mode"
                                                            ] as string) ?? "report",
                                                    })
                                                )
                                            }
                                            className={
                                                tier === t
                                                    ? "rounded-[5px] border border-accent/50 bg-accentbg/40 px-2 py-0.5 font-mono text-[11px] text-accent-soft"
                                                    : "rounded-[5px] px-2 py-0.5 font-mono text-[11px] text-muted hover:text-secondary"
                                            }
                                        >
                                            {t}
                                        </button>
                                    ))}
                                </div>
                            ) : null}
                            {active && view === "runs" ? (
                                <div className="flex flex-none items-center gap-1.5">
                                    <div
                                        className="flex items-center gap-0.5 rounded-[7px] border border-edge-mid p-0.5"
                                        title="How Jarvis runs a goal: Pipeline uses fixed phases with a review gate; Orchestrator runs one adaptive lead that spawns its own subagents"
                                    >
                                        {(["pipeline", "orchestrator"] as const).map((mVal) => (
                                            <button
                                                key={mVal}
                                                type="button"
                                                onClick={() => {
                                                    setRunMode(mVal);
                                                    fireAndForget(() => setChannelProfile(active.oid, { defaultmode: mVal }));
                                                }}
                                                className={
                                                    runMode === mVal
                                                        ? "rounded-[5px] border border-accent/50 bg-accentbg/40 px-2 py-0.5 font-mono text-[11px] text-accent-soft"
                                                        : "rounded-[5px] px-2 py-0.5 font-mono text-[11px] text-muted hover:text-secondary"
                                                }
                                            >
                                                {mVal}
                                            </button>
                                        ))}
                                    </div>
                                    {runMode === "orchestrator" ? (
                                        <label className="flex cursor-pointer items-center gap-1 font-mono text-[11px] text-muted">
                                            <input
                                                type="checkbox"
                                                checked={planGate}
                                                onChange={(e) => setPlanGate(e.target.checked)}
                                            />
                                            plan gate
                                        </label>
                                    ) : null}
                                </div>
                            ) : null}
```

> Note: `setChannelProfile(active.oid, { defaultmode: mVal })` sends a partial override — merge behavior with existing overrides (playbook/principles) is handled server-side; if this clobbers other override sections in practice, the fix is to spread the current override first. Verify in Step 6.

- [ ] **Step 5: Pass the props to RunsView**

Replace the `RunsView` render (line 1019):

```tsx
                            <RunsView model={model} channel={active} agents={agents} runMode={runMode} planGate={planGate} />
```

- [ ] **Step 6: Typecheck + verify override merge**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

Then confirm the partial-override concern from Step 4: read `SetChannelProfileCommand` in `pkg/wshrpc/wshserver/wshserver.go` — if it replaces the whole `meta["jarvis:profile"]` blob, change the Step 4 `onClick` to spread the loaded override before setting `defaultmode` (load it via the same `getJarvisProfile` effect into state and merge). If it merges per-key, no change needed. Record which in the commit message.

- [ ] **Step 7: Commit**

```bash
git add frontend/app/view/agents/runactions.ts frontend/app/view/agents/channelssurface.tsx frontend/app/view/agents/runssurface.tsx
git commit -m "feat(runs): view-aware header mode chips + plan-gate toggle, composer summary"
```

---

## Task 9: Rail — lead + subagents, orchestrator gate copy

Show the lead's live subagents nested under it in the phase rail, and adapt the review-gate card copy for the orchestrator plan gate.

**Files:**
- Modify: `frontend/app/view/agents/runssurface.tsx` (`PhaseRail` workers block 225-231; `ReviewGateCard` 62-100)

**Interfaces:**
- Consumes: `getSubagentsAtom(oref)` (`session-models/agentstatusstore.ts:60`) → `SubagentVM[]` (`session-models/sessionviewmodel.ts:15`, fields `id`, `type`, `state`, `model?`); `isOrchestrator` (Task 7).
- Produces: a `SubagentRows` component; orchestrator-aware gate-card copy.

- [ ] **Step 1: Add a SubagentRows component**

In `frontend/app/view/agents/runssurface.tsx`, add imports at the top:

```tsx
import { useAtomValue } from "jotai";
import { getSubagentsAtom } from "./session-models/agentstatusstore";
```

Add the component above `PhaseRail`:

```tsx
// Live Task-tool subagents of an orchestrator lead, nested under its worker row. Read from the per-lead
// ephemeral atom the ~/.claude status reporter feeds; empty (and rendering nothing) until the lead spawns any.
function SubagentRows({ leadId }: { leadId: string }) {
    const subs = useAtomValue(getSubagentsAtom(`tab:${leadId}`));
    if (subs.length === 0) {
        return null;
    }
    return (
        <div className="ml-4 mt-1 flex flex-col gap-1 border-l border-edge-mid pl-3">
            {subs.map((s) => (
                <div key={s.id} className="flex items-center gap-2 text-[11px] text-secondary">
                    <span
                        className={
                            "h-[6px] w-[6px] flex-none rounded-full " +
                            (s.state === "failure" ? "bg-error" : s.state === "success" ? "bg-success" : "bg-asking")
                        }
                    />
                    <span className="font-semibold">{s.type}</span>
                    {s.model ? <span className="font-mono text-[9.5px] text-muted">{s.model}</span> : null}
                </div>
            ))}
        </div>
    );
}
```

- [ ] **Step 2: Render subagents under each lead in the rail**

In `PhaseRail`, replace the `thread.showWorkers` block (lines 225-231):

```tsx
                                {thread.showWorkers ? (
                                    <div className="mt-2.5 flex flex-col gap-1.5">
                                        {workers.map((w) => (
                                            <div key={w.id}>
                                                <WorkerRow model={model} w={toWorkerState(w)} />
                                                {isOrchestrator(run) ? <SubagentRows leadId={w.id} /> : null}
                                            </div>
                                        ))}
                                    </div>
                                ) : null}
```

Add `isOrchestrator` to the `runmodel` import block (lines 17-25).

- [ ] **Step 3: Orchestrator-aware gate-card copy**

In `ReviewGateCard` (lines 62-100), branch the two strings on the run mode. Replace the header explainer (line 70) and the approve button label (line 79):

```tsx
                <span className="flex-1 text-[11.5px] text-ink-mid">
                    {run.mode === "orchestrator" ? "plan ready — approve to let the lead proceed" : "approve before execution starts"}
                </span>
```

```tsx
                    {run.mode === "orchestrator" ? "Approve & proceed" : "Approve & execute"}
```

- [ ] **Step 4: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add frontend/app/view/agents/runssurface.tsx
git commit -m "feat(runs): rail shows lead + live subagents; orchestrator gate-card copy"
```

---

## Task 10: Profile panel — default mode + plan gate controls

Add the two new profile fields to the editor so the sticky defaults are editable where the rest of the profile is.

**Files:**
- Modify: `frontend/app/view/agents/profilepanel.tsx` (add a section; render in `ProfilePanel` body ~284-286)
- Modify: `frontend/app/view/agents/profilemodel.ts` (only if a helper is needed — likely not)

**Interfaces:**
- Consumes: `ProfileOverride.defaultmode`, `.defaultplangate`; `JarvisProfile.defaultmode`, `.defaultplangate` (Task 1 regen). Existing `draft`/`setDraft` `ProfileOverride` state, `omit`, `Badge`.
- Produces: a `DefaultsSection` rendered in the profile drawer.

- [ ] **Step 1: Add a DefaultsSection**

In `frontend/app/view/agents/profilepanel.tsx`, add above `ProfilePanel` (after `PrinciplesSection`):

```tsx
function DefaultsSection({
    global,
    draft,
    setDraft,
}: {
    global: JarvisProfile;
    draft: ProfileOverride;
    setDraft: React.Dispatch<React.SetStateAction<ProfileOverride>>;
}) {
    const mode = draft.defaultmode ?? global.defaultmode ?? "pipeline";
    const gate = draft.defaultplangate ?? global.defaultplangate ?? true;
    const overridden = draft.defaultmode != null || draft.defaultplangate != null;
    return (
        <div>
            <div className="mb-1.5 flex items-center gap-2">
                <span className="text-[12px] font-semibold text-primary">Run defaults</span>
                <Badge source={overridden ? "project" : "global"} />
                <div className="flex-1" />
                {overridden ? (
                    <button
                        type="button"
                        onClick={() => setDraft((d) => omit(omit(d, "defaultmode"), "defaultplangate"))}
                        className="text-[10px] text-muted hover:text-secondary"
                    >
                        reset to global
                    </button>
                ) : null}
            </div>
            <div className="flex items-center gap-2">
                <select
                    value={mode}
                    onChange={(e) => setDraft((d) => ({ ...d, defaultmode: e.target.value }))}
                    className="rounded-[6px] border border-edge-mid bg-background px-1.5 py-1 text-[11px] text-primary"
                >
                    <option value="pipeline">pipeline</option>
                    <option value="orchestrator">orchestrator</option>
                </select>
                {mode === "orchestrator" ? (
                    <label className="flex cursor-pointer items-center gap-1 text-[11px] text-secondary">
                        <input
                            type="checkbox"
                            checked={gate}
                            onChange={(e) => setDraft((d) => ({ ...d, defaultplangate: e.target.checked }))}
                        />
                        plan gate on by default
                    </label>
                ) : null}
            </div>
        </div>
    );
}
```

- [ ] **Step 2: Render it in the panel body**

In `ProfilePanel`'s body (lines 284-286), add after `<PrinciplesSection … />`:

```tsx
            <DefaultsSection global={loaded.global} draft={draft} setDraft={setDraft} />
```

- [ ] **Step 3: Cover the new keys in overrideIsEmpty**

Update `overrideIsEmpty` (line 39) so a save that only sets defaults still persists (and so a cleared override collapses correctly):

```tsx
function overrideIsEmpty(o: ProfileOverride): boolean {
    return o.playbook == null && o.principles == null && o.defaultmode == null && o.defaultplangate == null;
}
```

- [ ] **Step 4: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add frontend/app/view/agents/profilepanel.tsx
git commit -m "feat(runs): profile editor default-mode + plan-gate controls"
```

---

## Task 11: Full verification pass

No new code — prove the whole feature works together against the running app.

**Files:** none (verification only).

- [ ] **Step 1: Run all backend tests**

Run: `go test ./pkg/jarvis/ ./pkg/wshrpc/wshserver/`
Expected: PASS.

- [ ] **Step 2: Run frontend unit tests**

Run: `npx vitest run frontend/app/view/agents/runmodel.test.ts`
Expected: PASS.

- [ ] **Step 3: Typecheck the frontend**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0 (clean baseline).

- [ ] **Step 4: CDP visual check — orchestrator run with the plan gate**

Start the dev app (`tail -f /dev/null | task dev` per the repo memory note, or the user's usual launch), then use `node scripts/cdp-shot.mjs` and `node scripts/inject-live-agents.mjs` as needed. Verify, capturing a screenshot at each:
- The Runs-view header shows **pipeline / orchestrator** chips (not tier chips); Chat view still shows tier chips.
- Selecting Orchestrator reveals the **plan gate** toggle; the composer summary reads `orchestrator · plan gate on`.
- Starting a run spawns one lead; `wsh jarvis hold` (invoked by the lead, or manually from the lead's tab to simulate) flips the run to **awaiting review** with the gate card reading "plan ready — approve to let the lead proceed".
- **Approve & proceed** clears the gate (status → executing) without spawning a second worker.
- Subagents appear nested under the lead in the rail as the lead dispatches them.
- A gate-off orchestrator run never holds and reaches **done** on `wsh jarvis complete`.

- [ ] **Step 5: Record any gaps**

If any check fails, file the fix as a follow-up task rather than marking the plan complete. Note explicitly (per the spec's flagged assumption) whether subagent asks routed to the run correctly — if they did not, the descendant-predicate fallback in `ResolveRunWorker` is the follow-up.

---

## Self-Review

**Spec coverage:**
- `Mode` on Run, `Held` on phase, profile `DefaultMode`/`DefaultPlanGate` → Task 1. ✓
- Orchestrator playbook + fixed prompt + principles propagation → Task 2 (`DefaultOrchestratorPlaybook`, `BuildOrchestratePrompt`). ✓
- Pause-and-steer plan gate (`Held` runtime, `recomputeStatus` clause, approve-in-place) → Tasks 2 + 5. ✓
- `wsh jarvis hold`/`complete` self-report resolving from oref → Task 6. ✓
- CreateRun mode/gate resolution defaulting from profile (gate on) → Task 4. ✓
- View-aware header (tiers in Chat, mode in Runs), composer summary, per-run gate toggle → Tasks 7-8. ✓
- Rail lead + nested subagents; orchestrator gate copy → Task 9. ✓
- Profile editor defaults → Task 10. ✓
- No recursive coupling (asks already route to the lead) — nothing to build; the flagged assumption is verified in Task 11 with a named fallback. ✓
- Non-goals honored: no separate worker tabs, no Pause work, no migration. ✓

**Placeholder scan:** No TBD/TODO/"handle edge cases" — every code step shows real code; the two `> Note:` callouts (Task 8 override merge, Task 11 assumption) are explicit verify-steps with concrete resolutions, not deferred work.

**Type consistency:** `NewRun(... , mode, playbook, ts)` used identically in Tasks 2, 3, 4. `resolveRunPlan(resolved, reqMode, reqPlanGate) -> (mode, playbook)` matches its Task 4 caller. `HoldPhase(run, idx) -> (Run, error)` matches Tasks 2 (test), 5 (server), 6 (via AdvanceRun). `composerSummary(mode, planGate)` / `isOrchestrator(run)` match their Task 8/9 callers. `CommandReportRunPhaseData{ORef,Action,Artifacts}` matches the Task 6 client and server. Frontend generated fields (`mode`, `plangate`, `held`, `defaultmode`, `defaultplangate`) all originate from the Task 1/4 Go json tags.
