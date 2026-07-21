# Backlog-driven Orchestration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an orchestrator-mode run lead drive a large backlog as one bounded child run per independent unit — instead of holding the whole backlog in one context — so its context stays thin.

**Architecture:** Additive to the existing `@run` → orchestrator path. The lead creates first-class child `Run`s via a new `wsh jarvis run` verb; each child inherits the parent's channel/workspace/project/principles, runs hands-off, seals normally, and on its terminal transition steers a one-line status back into the lead (reusing `steerRunLead`). One new `Run` field carries the parent pointer. No new `RunMode`, no new launch command, no DB migration, no frontend view changes.

**Tech Stack:** Go (`pkg/jarvis`, `pkg/wshrpc`, `pkg/waveobj`, `cmd/wsh`), cobra CLI, the wshrpc codegen (`task generate`), Go's `testing`.

## Global Constraints

- **Never hand-edit generated files.** `pkg/wshrpc/wshclient/wshclient.go`, `frontend/app/store/wshclientapi.ts`, and `frontend/types/gotypes.d.ts` are produced by `task generate` (Go is the source of truth). Change the Go interface/types, then regenerate.
- **Go test invocation:** `go test ./pkg/jarvis/` (single test: `go test ./pkg/jarvis/ -run TestName -v`). Full backend: `go test ./pkg/...`.
- **TS typecheck (tsc stack-overflow gotcha):** run `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` — never bare `npx tsc`. Baseline is clean (exit 0).
- **No new `RunMode`, no new launch command, no DB migration, no frontend view changes.** The only new persisted state is `Run.ParentLeadORef` (additive JSON).
- **No automatic `blocked`.** `PhaseState_Failed`/`Blocked` are never assigned in this backend; the only terminal transitions that notify the parent are **done** and **cancelled**. Do not invent a blocked path in this piece.
- **Git policy (repo rule, overrides the skill's frequent-commit default):** every commit requires explicit user approval. The per-task `git commit` steps below are the intended commit boundaries, but must be confirmed with the user; the spec (`docs/superpowers/specs/2026-07-21-backlog-driven-orchestration-design.md`) and this plan fold into the feature commit — never a separate docs-only commit. Do not add yourself as co-author.

---

### Task 1: `Run.ParentLeadORef` field + `StripPhaseGates` helper

**Files:**
- Modify: `pkg/waveobj/wtype.go` (the `Run` struct, ends at line 250)
- Modify: `pkg/jarvis/run.go` (add exported helper near the playbook builders, ~line 89)
- Test: `pkg/jarvis/run_test.go`

**Interfaces:**
- Produces: `waveobj.Run.ParentLeadORef string` (JSON `parentleadoref`); `jarvis.StripPhaseGates(phases []waveobj.RunPhase) []waveobj.RunPhase` — returns a copy with every `Gate` cleared, input unmutated.

- [ ] **Step 1: Write the failing test**

Add to `pkg/jarvis/run_test.go`:

```go
func TestStripPhaseGates(t *testing.T) {
	in := []waveobj.RunPhase{
		{Kind: PhaseKind_Brainstorm},
		{Kind: PhaseKind_Plan, Gate: true},
		{Kind: PhaseKind_Execute, FreshCtx: true},
	}
	out := StripPhaseGates(in)
	if len(out) != len(in) {
		t.Fatalf("len = %d, want %d", len(out), len(in))
	}
	for i, p := range out {
		if p.Gate {
			t.Errorf("out[%d].Gate = true, want false", i)
		}
	}
	if !in[1].Gate {
		t.Error("input was mutated: in[1].Gate cleared")
	}
	if out[2].Kind != PhaseKind_Execute || !out[2].FreshCtx {
		t.Error("non-Gate fields must be preserved")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./pkg/jarvis/ -run TestStripPhaseGates -v`
Expected: FAIL — `undefined: StripPhaseGates`.

- [ ] **Step 3: Add the `Run` field**

In `pkg/waveobj/wtype.go`, add the last field of `Run` (after the `Evidence` line):

```go
	Evidence    *RunEvidence    `json:"evidence,omitempty"`    // sealed once at completion; immutable
	// ParentLeadORef is the tab oref ("tab:<id>") of the orchestrator lead that spawned this child run
	// via `wsh jarvis run`. Empty for human-started runs. Drives the terminal-status notify-back.
	ParentLeadORef string `json:"parentleadoref,omitempty"`
}
```

- [ ] **Step 4: Add `StripPhaseGates`**

In `pkg/jarvis/run.go`, after `QuickPlaybook()` (ends ~line 89):

```go
// StripPhaseGates returns a copy of a playbook with every phase's Gate cleared, so a child run never halts
// for human review — the decomposition was already gated once at the parent lead's plan gate. The input
// slice is not mutated.
func StripPhaseGates(phases []waveobj.RunPhase) []waveobj.RunPhase {
	out := make([]waveobj.RunPhase, len(phases))
	copy(out, phases)
	for i := range out {
		out[i].Gate = false
	}
	return out
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `go test ./pkg/jarvis/ -run TestStripPhaseGates -v`
Expected: PASS. Also `go build ./...` — clean (the new struct field compiles).

- [ ] **Step 6: Commit** (on approval — see Global Constraints)

```bash
git add pkg/waveobj/wtype.go pkg/jarvis/run.go pkg/jarvis/run_test.go
git commit -m "feat(runs): add Run.ParentLeadORef + StripPhaseGates for child runs"
```

---

### Task 2: `ParentNotifyLine` — the pure notify decision + formatter

**Files:**
- Modify: `pkg/jarvis/run.go` (add after `StripPhaseGates`)
- Test: `pkg/jarvis/run_test.go`

**Interfaces:**
- Consumes: `waveobj.Run.ParentLeadORef` (Task 1); `waveobj.RunEvidence.{Files,AddTotal,DelTotal}`; `RunStatus_Done`, `RunStatus_Cancelled`.
- Produces: `jarvis.ParentNotifyLine(run *waveobj.Run) (line string, ok bool)` — `ok` iff the run has a parent and a terminal status (done|cancelled); `line` ends with `\r`.

- [ ] **Step 1: Write the failing test**

Add to `pkg/jarvis/run_test.go` (the file already imports `strings`, `testing`, and `waveobj`):

```go
func TestParentNotifyLine(t *testing.T) {
	// no parent -> not ok
	if _, ok := ParentNotifyLine(&waveobj.Run{ID: "c1", Status: RunStatus_Done}); ok {
		t.Error("want ok=false when ParentLeadORef is empty")
	}
	// has parent but non-terminal -> not ok
	if _, ok := ParentNotifyLine(&waveobj.Run{ID: "c1", Status: RunStatus_Executing, ParentLeadORef: "tab:lead"}); ok {
		t.Error("want ok=false for a non-terminal status")
	}
	// done with evidence
	line, ok := ParentNotifyLine(&waveobj.Run{
		ID: "c1", Goal: "fix 6a", Status: RunStatus_Done, ParentLeadORef: "tab:lead",
		Evidence: &waveobj.RunEvidence{Files: []waveobj.EvidenceFile{{}, {}}, AddTotal: 12, DelTotal: 3},
	})
	if !ok {
		t.Fatal("want ok=true for a done child with a parent")
	}
	for _, want := range []string{"child c1", "done", "2 files +12/-3"} {
		if !strings.Contains(line, want) {
			t.Errorf("line %q missing %q", line, want)
		}
	}
	if !strings.HasSuffix(line, "\r") {
		t.Errorf("line %q must end with CR so it submits as one PTY line", line)
	}
	// cancelled (no evidence)
	cl, ok := ParentNotifyLine(&waveobj.Run{ID: "c2", Goal: "x", Status: RunStatus_Cancelled, ParentLeadORef: "tab:lead"})
	if !ok || !strings.Contains(cl, "cancelled") {
		t.Errorf("cancelled: line=%q ok=%v", cl, ok)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./pkg/jarvis/ -run TestParentNotifyLine -v`
Expected: FAIL — `undefined: ParentNotifyLine`.

- [ ] **Step 3: Implement `ParentNotifyLine`**

In `pkg/jarvis/run.go`, after `StripPhaseGates` (the file already imports `fmt`):

```go
// ParentNotifyLine builds the single line a child run steers back into its parent orchestrator lead when the
// child reaches a terminal state. ok is false unless the run has a parent (ParentLeadORef) AND a terminal
// status — done or cancelled, the only two the backend produces (there is no automatic blocked). The line
// ends in \r so it submits as one input line into the lead's PTY. The lead reads ONLY this line, never the
// child's transcript/diff/evidence — that is what keeps the driver's context small.
func ParentNotifyLine(run *waveobj.Run) (string, bool) {
	if run == nil || run.ParentLeadORef == "" {
		return "", false
	}
	short := run.Goal
	if r := []rune(short); len(r) > 60 {
		short = string(r[:57]) + "..."
	}
	switch run.Status {
	case RunStatus_Done:
		summary := ""
		if run.Evidence != nil {
			summary = fmt.Sprintf(" (%d files +%d/-%d)", len(run.Evidence.Files), run.Evidence.AddTotal, run.Evidence.DelTotal)
		}
		return fmt.Sprintf("[jarvis] child %s %q -> done%s\r", run.ID, short, summary), true
	case RunStatus_Cancelled:
		return fmt.Sprintf("[jarvis] child %s %q -> cancelled\r", run.ID, short), true
	default:
		return "", false
	}
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./pkg/jarvis/ -run TestParentNotifyLine -v`
Expected: PASS.

- [ ] **Step 5: Commit** (on approval)

```bash
git add pkg/jarvis/run.go pkg/jarvis/run_test.go
git commit -m "feat(runs): ParentNotifyLine — terminal-status line for child->lead notify"
```

---

### Task 3: `CreateChildRunCommand` — RPC surface + server + codegen

**Files:**
- Modify: `pkg/wshrpc/wshrpctypes_runs.go` (the `RunCommands` interface + new data types)
- Modify: `pkg/wshrpc/wshserver/wshserver_runs.go` (new `childRunPlan` helper + `CreateChildRunCommand`)
- Create: `pkg/wshrpc/wshserver/wshserver_childrun_test.go`
- Regenerate: `pkg/wshrpc/wshclient/wshclient.go`, `frontend/app/store/wshclientapi.ts`, `frontend/types/gotypes.d.ts` (via `task generate` — do not hand-edit)

**Interfaces:**
- Consumes: `jarvis.StripPhaseGates` (Task 1); `Run.ParentLeadORef` (Task 1); existing `resolveRunPlan`, `jarvis.ResolveRunWorker`, `jarvis.NewRun`, `jarvis.LoadGlobalProfile`, `jarvis.ResolveProfile`, `jarvis.OverrideFromMeta`, `wstore.GetChannels`, `wstore.AppendRun`, `spawnRunWorkers`, `gitinfo.HeadCommit`.
- Produces: `wshrpc.CommandCreateChildRunData{ORef, Goal, Mode string}`; `wshrpc.CommandCreateChildRunRtnData{RunId string}`; `WshServer.CreateChildRunCommand(ctx, data) (*CommandCreateChildRunRtnData, error)`; generated `wshclient.CreateChildRunCommand(w, data, opts)`.

- [ ] **Step 1: Write the failing test**

Create `pkg/wshrpc/wshserver/wshserver_childrun_test.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

func TestCreateChildRunCommand_InheritsAndStampsParent(t *testing.T) {
	ctx := context.Background()
	ch, err := wstore.CreateChannel(ctx, "backlog", "/repo")
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	parent := jarvis.NewRun("work the backlog", "ws-1", "/repo",
		waveobj.PrincipleList{{ID: "clean", Text: "be clean"}},
		jarvis.RunMode_Orchestrator, jarvis.DefaultOrchestratorPlaybook(true), 1)
	leadORef := waveobj.MakeORef(waveobj.OType_Tab, "leadtab").String()
	parent.Phases[0].WorkerOrefs = []string{leadORef}
	if err := wstore.AppendRun(ctx, ch.OID, parent); err != nil {
		t.Fatalf("AppendRun: %v", err)
	}

	origSpawn := jarvis.SpawnClaudeWorker
	jarvis.SpawnClaudeWorker = func(_ context.Context, _, _, _, _ string) (string, error) {
		return waveobj.MakeORef(waveobj.OType_Tab, "childtab").String(), nil
	}
	defer func() { jarvis.SpawnClaudeWorker = origSpawn }()

	ws := &WshServer{}
	rtn, err := ws.CreateChildRunCommand(ctx, wshrpc.CommandCreateChildRunData{ORef: leadORef, Goal: "fix issue 6a"})
	if err != nil {
		t.Fatalf("CreateChildRunCommand: %v", err)
	}
	child, err := wstore.GetRun(ctx, ch.OID, rtn.RunId)
	if err != nil {
		t.Fatalf("GetRun(child): %v", err)
	}
	if child.ParentLeadORef != leadORef {
		t.Errorf("ParentLeadORef = %q, want %q", child.ParentLeadORef, leadORef)
	}
	if child.Goal != "fix issue 6a" {
		t.Errorf("Goal = %q", child.Goal)
	}
	if child.ProjectPath != "/repo" || child.WorkspaceId != "ws-1" {
		t.Errorf("child did not inherit project/workspace: proj=%q ws=%q", child.ProjectPath, child.WorkspaceId)
	}
	if len(child.Principles) != 1 {
		t.Errorf("child did not inherit principles: %+v", child.Principles)
	}
	if child.Mode != jarvis.RunMode_Orchestrator {
		t.Errorf("child Mode = %q, want inherited orchestrator", child.Mode)
	}
	for i, p := range child.Phases {
		if p.Gate {
			t.Errorf("child phase %d is gated; child runs must be hands-off", i)
		}
	}
}

func TestCreateChildRunCommand_UnresolvedOrefFails(t *testing.T) {
	ctx := context.Background()
	ws := &WshServer{}
	if _, err := ws.CreateChildRunCommand(ctx, wshrpc.CommandCreateChildRunData{ORef: "tab:nope", Goal: "x"}); err == nil {
		t.Fatal("want an error when the oref resolves to no run")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./pkg/wshrpc/wshserver/ -run TestCreateChildRunCommand -v`
Expected: FAIL — `ws.CreateChildRunCommand undefined` and `wshrpc.CommandCreateChildRunData` undefined.

- [ ] **Step 3: Add the RPC types + interface method**

In `pkg/wshrpc/wshrpctypes_runs.go`, add to the `RunCommands` interface (after `ReportRunPhaseCommand`):

```go
	CreateChildRunCommand(ctx context.Context, data CommandCreateChildRunData) (*CommandCreateChildRunRtnData, error) // orchestrator lead spawns a hands-off child run for one backlog unit; parent resolved from the caller's oref
```

And add the data types (after `CommandReportRunPhaseData`):

```go
type CommandCreateChildRunData struct {
	ORef string `json:"oref"`           // caller = the orchestrator lead's tab oref ("tab:<id>")
	Goal string `json:"goal"`           // the unit of work for the child run
	Mode string `json:"mode,omitempty"` // quick|pipeline|orchestrator; empty = inherit the parent run's mode
}

type CommandCreateChildRunRtnData struct {
	RunId string `json:"runid"`
}
```

- [ ] **Step 4: Implement `childRunPlan` + `CreateChildRunCommand`**

In `pkg/wshrpc/wshserver/wshserver_runs.go`, add the helper right after `resolveRunPlan` (ends line 125):

```go
// childRunPlan derives a hands-off playbook for a child run: resolve the plan for the requested (or inherited)
// mode with the plan gate off, then strip any phase-level gates. A child never halts for human review — the
// decomposition was already gated once at the parent lead's plan gate.
func childRunPlan(resolved waveobj.JarvisProfile, reqMode string) (string, []waveobj.RunPhase) {
	gateOff := false
	mode, pb := resolveRunPlan(resolved, reqMode, &gateOff)
	return mode, jarvis.StripPhaseGates(pb)
}
```

And add the command (e.g. after `CreateRunCommand`, before `steerRunLead`):

```go
func (ws *WshServer) CreateChildRunCommand(ctx context.Context, data wshrpc.CommandCreateChildRunData) (*wshrpc.CommandCreateChildRunRtnData, error) {
	if data.ORef == "" || data.Goal == "" {
		return nil, fmt.Errorf("oref and goal are required")
	}
	channels, err := wstore.GetChannels(ctx)
	if err != nil {
		return nil, fmt.Errorf("loading channels: %w", err)
	}
	m := jarvis.ResolveRunWorker(channels, data.ORef)
	if m == nil {
		return nil, fmt.Errorf("no run owns oref %q", data.ORef)
	}
	channelId := m.Channel.OID
	parent := m.Run
	mode := data.Mode
	if mode == "" {
		mode = parent.Mode // inherit the channel strategy the parent run was created with
	}
	resolved := jarvis.ResolveProfile(jarvis.LoadGlobalProfile(), jarvis.OverrideFromMeta(m.Channel))
	childMode, playbook := childRunPlan(resolved, mode)
	child := jarvis.NewRun(data.Goal, parent.WorkspaceId, parent.ProjectPath, parent.Principles, childMode, playbook, time.Now().UnixMilli())
	child.ParentLeadORef = data.ORef
	if head, herr := gitinfo.HeadCommit(ctx, parent.ProjectPath); herr == nil {
		child.BaseCommit = head
	}
	if err := wstore.AppendRun(ctx, channelId, child); err != nil {
		return nil, fmt.Errorf("appending child run: %w", err)
	}
	if err := spawnRunWorkers(ctx, channelId, child.ID, m.Channel.Name); err != nil {
		wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Channel, channelId))
		return nil, fmt.Errorf("spawning child worker: %w", err)
	}
	wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Channel, channelId))
	return &wshrpc.CommandCreateChildRunRtnData{RunId: child.ID}, nil
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `go test ./pkg/wshrpc/wshserver/ -run TestCreateChildRunCommand -v`
Expected: PASS (both cases).

- [ ] **Step 6: Regenerate bindings**

Run: `task generate`
Expected: exit 0; `git status` shows regenerated `pkg/wshrpc/wshclient/wshclient.go`, `frontend/app/store/wshclientapi.ts`, `frontend/types/gotypes.d.ts` now containing `CreateChildRunCommand` / `CommandCreateChildRunData`. Confirm no unrelated drift (the tsgen golden/coverage guards pass).

- [ ] **Step 7: Verify the frontend still typechecks**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0 (baseline clean).

- [ ] **Step 8: Commit** (on approval)

```bash
git add pkg/wshrpc/wshrpctypes_runs.go pkg/wshrpc/wshserver/wshserver_runs.go pkg/wshrpc/wshserver/wshserver_childrun_test.go pkg/wshrpc/wshclient/wshclient.go frontend/app/store/wshclientapi.ts frontend/types/gotypes.d.ts
git commit -m "feat(runs): CreateChildRunCommand — lead spawns a hands-off child run"
```

---

### Task 4: Notify the parent lead on a child's terminal transition

**Files:**
- Modify: `pkg/wshrpc/wshserver/wshserver_runs.go` (`steerRunLead` → var; call sites in `AdvanceRunCommand` + `CancelRunCommand`)
- Test: `pkg/wshrpc/wshserver/wshserver_childrun_test.go` (append)

**Interfaces:**
- Consumes: `jarvis.ParentNotifyLine` (Task 2); `Run.ParentLeadORef` (Task 1); existing `steerRunLead`.
- Produces: `steerRunLead` becomes a package-level `var` (stub-able in tests); parent-notify calls in the done-seal branch of `AdvanceRunCommand` and in `CancelRunCommand`.

- [ ] **Step 1: Write the failing test**

Add `"strings"` to the import block of `pkg/wshrpc/wshserver/wshserver_childrun_test.go` (created in Task 3 without it), then append these tests:

```go
func TestChildDoneNotifiesParentLead(t *testing.T) {
	ctx := context.Background()
	ch, err := wstore.CreateChannel(ctx, "notify-done", t.TempDir())
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	leadORef := waveobj.MakeORef(waveobj.OType_Tab, "leadtab").String()
	child := jarvis.NewRun("fix 6a", "ws-1", ch.ProjectPath, nil, jarvis.RunMode_Quick, jarvis.QuickPlaybook(), 1)
	child.ParentLeadORef = leadORef
	if err := wstore.AppendRun(ctx, ch.OID, child); err != nil {
		t.Fatalf("AppendRun: %v", err)
	}

	origSpawn := jarvis.SpawnClaudeWorker
	jarvis.SpawnClaudeWorker = func(_ context.Context, _, _, _, _ string) (string, error) {
		return waveobj.MakeORef(waveobj.OType_Tab, "x").String(), nil
	}
	defer func() { jarvis.SpawnClaudeWorker = origSpawn }()

	var gotORef, gotLine string
	origSteer := steerRunLead
	steerRunLead = func(_ context.Context, oref, text string) { gotORef, gotLine = oref, text }
	defer func() { steerRunLead = origSteer }()

	ws := &WshServer{}
	if err := ws.AdvanceRunCommand(ctx, wshrpc.CommandAdvanceRunData{
		ChannelId: ch.OID, RunId: child.ID, PhaseIdx: 0, Action: jarvis.RunAction_Complete,
	}); err != nil {
		t.Fatalf("AdvanceRunCommand: %v", err)
	}
	if gotORef != leadORef {
		t.Errorf("notified oref = %q, want %q", gotORef, leadORef)
	}
	if want := "-> done"; !strings.Contains(gotLine, want) {
		t.Errorf("notify line %q missing %q", gotLine, want)
	}
}

func TestChildCancelNotifiesParentLead(t *testing.T) {
	ctx := context.Background()
	ch, err := wstore.CreateChannel(ctx, "notify-cancel", t.TempDir())
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	leadORef := waveobj.MakeORef(waveobj.OType_Tab, "leadtab").String()
	child := jarvis.NewRun("fix 6b", "ws-1", ch.ProjectPath, nil, jarvis.RunMode_Quick, jarvis.QuickPlaybook(), 1)
	child.ParentLeadORef = leadORef
	if err := wstore.AppendRun(ctx, ch.OID, child); err != nil {
		t.Fatalf("AppendRun: %v", err)
	}

	var gotORef, gotLine string
	origSteer := steerRunLead
	steerRunLead = func(_ context.Context, oref, text string) { gotORef, gotLine = oref, text }
	defer func() { steerRunLead = origSteer }()

	ws := &WshServer{}
	if err := ws.CancelRunCommand(ctx, wshrpc.CommandCancelRunData{ChannelId: ch.OID, RunId: child.ID}); err != nil {
		t.Fatalf("CancelRunCommand: %v", err)
	}
	if gotORef != leadORef || !strings.Contains(gotLine, "-> cancelled") {
		t.Errorf("cancel notify: oref=%q line=%q", gotORef, gotLine)
	}
}

func TestParentlessRunDoesNotNotify(t *testing.T) {
	ctx := context.Background()
	ch, err := wstore.CreateChannel(ctx, "no-parent", t.TempDir())
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	run := jarvis.NewRun("solo", "ws-1", ch.ProjectPath, nil, jarvis.RunMode_Quick, jarvis.QuickPlaybook(), 1)
	if err := wstore.AppendRun(ctx, ch.OID, run); err != nil {
		t.Fatalf("AppendRun: %v", err)
	}
	origSpawn := jarvis.SpawnClaudeWorker
	jarvis.SpawnClaudeWorker = func(_ context.Context, _, _, _, _ string) (string, error) {
		return waveobj.MakeORef(waveobj.OType_Tab, "x").String(), nil
	}
	defer func() { jarvis.SpawnClaudeWorker = origSpawn }()

	called := false
	origSteer := steerRunLead
	steerRunLead = func(_ context.Context, _, _ string) { called = true }
	defer func() { steerRunLead = origSteer }()

	ws := &WshServer{}
	if err := ws.AdvanceRunCommand(ctx, wshrpc.CommandAdvanceRunData{
		ChannelId: ch.OID, RunId: run.ID, PhaseIdx: 0, Action: jarvis.RunAction_Complete,
	}); err != nil {
		t.Fatalf("AdvanceRunCommand: %v", err)
	}
	if called {
		t.Error("steerRunLead must not fire for a run with no ParentLeadORef")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./pkg/wshrpc/wshserver/ -run 'TestChild.*NotifiesParentLead|TestParentlessRun' -v`
Expected: FAIL — `cannot assign to steerRunLead` (it is a func, not a var) and the notify never fires.

- [ ] **Step 3: Make `steerRunLead` a stub-able var**

In `pkg/wshrpc/wshserver/wshserver_runs.go`, change the declaration at line 166 from `func steerRunLead(...)` to a var (body unchanged):

```go
// steerRunLead sends a line of input into the block of a run worker (tab oref "tab:<id>"), resuming a
// long-lived lead in place. Best-effort: resolution/send failures are logged, never fatal. It is a var so
// tests can observe the parent notify-back without a live PTY.
var steerRunLead = func(ctx context.Context, tabORef, text string) {
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

- [ ] **Step 4: Fire the notify on done**

In `AdvanceRunCommand`, replace the done-seal block (currently lines ~230-251, the `if run, gerr := wstore.GetRun(...); ... run.Status == Done && run.Evidence == nil { ... }`) with a version that keeps `run` in scope and notifies on done regardless of whether evidence sealed:

```go
	// seal the immutable evidence snapshot on the non-done -> done transition, then notify the parent lead
	// (if this is a child run). The notify is keyed on Done, not on evidence, so an empty-diff run still wakes
	// its parent. Reached once per run: applyRunAction errors on an already-done run.
	if run, gerr := wstore.GetRun(ctx, data.ChannelId, data.RunId); gerr == nil && run.Status == jarvis.RunStatus_Done {
		if run.Evidence == nil {
			if serr := jarvis.SealEvidence(ctx, run); serr == nil && run.Evidence != nil {
				ev := run.Evidence
				completedTs := run.CompletedTs
				if uerr := wstore.UpdateRun(ctx, data.ChannelId, data.RunId, func(r *waveobj.Run) error {
					if r.Evidence == nil { // idempotent under concurrent advances
						r.Evidence = ev
						r.CompletedTs = completedTs
					}
					return nil
				}); uerr != nil {
					log.Printf("AdvanceRun: persisting evidence for run %s failed: %v", data.RunId, uerr)
				}
				if run.RadarOrigin != nil {
					inv := reporadar.InvestigationFromRun(run, data.ChannelId, "done", run.CompletedTs)
					if rerr := reporadar.RecordInvestigation(ctx, run.ProjectPath, run.RadarOrigin.Fingerprint, inv); rerr != nil {
						log.Printf("AdvanceRun: recording radar investigation (done) failed: %v", rerr)
					}
				}
			}
		}
		if line, ok := jarvis.ParentNotifyLine(run); ok {
			steerRunLead(ctx, run.ParentLeadORef, line)
		}
	}
```

- [ ] **Step 5: Fire the notify on cancel**

In `CancelRunCommand`, inside the existing `if run, gerr := wstore.GetRun(...); gerr == nil {` block, add the notify right after `stopRunWorkers(ctx, run)`:

```go
	if run, gerr := wstore.GetRun(ctx, data.ChannelId, data.RunId); gerr == nil {
		stopRunWorkers(ctx, run)
		if line, ok := jarvis.ParentNotifyLine(run); ok {
			steerRunLead(ctx, run.ParentLeadORef, line)
		}
		if run.RadarOrigin != nil {
			inv := reporadar.InvestigationFromRun(run, data.ChannelId, "cancelled", time.Now().UnixMilli())
			if rerr := reporadar.RecordInvestigation(ctx, run.ProjectPath, run.RadarOrigin.Fingerprint, inv); rerr != nil {
				log.Printf("CancelRun: recording radar investigation (cancelled) failed: %v", rerr)
			}
		}
	} else {
		log.Printf("CancelRun: reload for worker stop failed: %v", gerr)
	}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `go test ./pkg/wshrpc/wshserver/ -run 'TestChild.*NotifiesParentLead|TestParentlessRun|TestCreateChildRunCommand' -v`
Expected: PASS (all). Then `go test ./pkg/wshrpc/wshserver/` — the existing suite (incl. `TestSpawnRunWorkers_ConcurrentSpawnsOnce`) stays green.

- [ ] **Step 7: Commit** (on approval)

```bash
git add pkg/wshrpc/wshserver/wshserver_runs.go pkg/wshrpc/wshserver/wshserver_childrun_test.go
git commit -m "feat(runs): notify parent lead on child run done/cancelled"
```

---

### Task 5: Teach the orchestrate prompt to decompose a backlog into child runs

**Files:**
- Modify: `pkg/jarvis/run.go` (`BuildOrchestratePrompt`, the `if gate` branch, ~lines 321-324)
- Test: `pkg/jarvis/run_test.go`

**Interfaces:**
- Consumes: existing `BuildOrchestratePrompt(goal string, principles waveobj.PrincipleList, gate bool) string`.
- Produces: a backlog-decomposition clause present in the **gated** prompt, absent from the non-gated prompt.

- [ ] **Step 1: Write the failing test**

Add to `pkg/jarvis/run_test.go`:

```go
func TestBuildOrchestratePromptBacklogClause(t *testing.T) {
	gated := BuildOrchestratePrompt("work docs/open-issues.md", nil, true)
	for _, want := range []string{"wsh jarvis run", "decomposition checklist", "never open a child"} {
		if !strings.Contains(gated, want) {
			t.Errorf("gated orchestrate prompt missing %q", want)
		}
	}
	if strings.Contains(BuildOrchestratePrompt("small fix", nil, false), "decomposition checklist") {
		t.Error("non-gated prompt must not carry the backlog clause")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./pkg/jarvis/ -run TestBuildOrchestratePromptBacklogClause -v`
Expected: FAIL — the substrings are absent.

- [ ] **Step 3: Add the clause to the gated branch**

In `pkg/jarvis/run.go`, inside `BuildOrchestratePrompt`'s `if gate {` branch, after the existing `wsh jarvis hold` instruction line (line 323), add:

```go
		b.WriteString("If this goal is actually a backlog of INDEPENDENT, individually substantial units (a list of issues, several unrelated features), do not execute them all in one context. Make your plan file a decomposition checklist: each unit, the `wsh jarvis run --mode <quick|pipeline|orchestrator>` you will use for it (map small->quick, medium->pipeline, large->orchestrator), and its dependency order; then `wsh jarvis hold <plan-file-path>` as above. After you are told to proceed, create ONE child run per ready unit with `wsh jarvis run \"<unit description + how to verify it>\"` — keep at most 2-3 in flight, and only start a unit whose dependencies have already reported done. You will be woken with a one-line `[jarvis] child <id> ... -> done|cancelled` status per unit; never open a child's transcript, diff, or evidence — that line is all you need. If a unit reports cancelled, use AskUserQuestion to ask whether to retry it or continue without it. When every unit has reported done (or you were told to skip it), run `wsh jarvis complete`. If instead this goal is a single cohesive task, ignore this paragraph and execute it yourself with in-process subagents.\n")
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./pkg/jarvis/ -run TestBuildOrchestratePromptBacklogClause -v`
Expected: PASS. Also re-run the existing orchestrate-prompt tests: `go test ./pkg/jarvis/ -run Orchestrate -v` — still green.

- [ ] **Step 5: Commit** (on approval)

```bash
git add pkg/jarvis/run.go pkg/jarvis/run_test.go
git commit -m "feat(runs): orchestrate prompt decomposes a backlog into child runs"
```

---

### Task 6: `wsh jarvis run` CLI verb

**Files:**
- Modify: `cmd/wsh/cmd/wshcmd-jarvis.go` (new `jarvisRunCmd` + register it; add `strings` import)
- Create: `cmd/wsh/cmd/wshcmd-jarvis_test.go`

**Interfaces:**
- Consumes: generated `wshclient.CreateChildRunCommand` (Task 3); existing `getTabIdFromEnv`, `preRunSetupRpcClient`, `RpcClient`.
- Produces: `wsh jarvis run <task> [--mode ...]` — prints the created child run id.

- [ ] **Step 1: Write the failing test**

Create `cmd/wsh/cmd/wshcmd-jarvis_test.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import "testing"

func TestJarvisRunSubcommandRegistered(t *testing.T) {
	var found bool
	for _, c := range jarvisCmd.Commands() {
		if c.Name() == "run" {
			found = true
		}
	}
	if !found {
		t.Fatal("`jarvis run` subcommand is not registered")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./cmd/wsh/cmd/ -run TestJarvisRunSubcommandRegistered -v`
Expected: FAIL — no `run` subcommand under `jarvis`.

- [ ] **Step 3: Add the subcommand**

In `cmd/wsh/cmd/wshcmd-jarvis.go`, add `"strings"` to the import block, then add the command and register it. Add after `jarvisTriageCmd`:

```go
var jarvisRunCmd = &cobra.Command{
	Use:   "run <task>",
	Short: "spawn a hands-off child run for one unit of work (used by an orchestrator lead)",
	Args:  cobra.MinimumNArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		tabId := getTabIdFromEnv()
		if tabId == "" {
			return fmt.Errorf("no WAVETERM_TABID env var set")
		}
		mode, _ := cmd.Flags().GetString("mode")
		rtn, err := wshclient.CreateChildRunCommand(RpcClient, wshrpc.CommandCreateChildRunData{
			ORef: waveobj.MakeORef(waveobj.OType_Tab, tabId).String(),
			Goal: strings.Join(args, " "),
			Mode: mode,
		}, nil)
		if err != nil {
			return err
		}
		fmt.Printf("%s\n", rtn.RunId)
		return nil
	},
	PreRunE: preRunSetupRpcClient,
}
```

Update the existing `init()` to register the flag and the command:

```go
func init() {
	jarvisRunCmd.Flags().String("mode", "", "child run mode: quick|pipeline|orchestrator (default: inherit the channel strategy)")
	jarvisCmd.AddCommand(jarvisHoldCmd)
	jarvisCmd.AddCommand(jarvisCompleteCmd)
	jarvisCmd.AddCommand(jarvisTriageCmd)
	jarvisCmd.AddCommand(jarvisRunCmd)
	rootCmd.AddCommand(jarvisCmd)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./cmd/wsh/cmd/ -run TestJarvisRunSubcommandRegistered -v`
Expected: PASS. Also `go build ./cmd/wsh/...` — clean.

- [ ] **Step 5: Commit** (on approval)

```bash
git add cmd/wsh/cmd/wshcmd-jarvis.go cmd/wsh/cmd/wshcmd-jarvis_test.go
git commit -m "feat(wsh): add `wsh jarvis run` to spawn a child run"
```

---

### Task 7: Full-suite + end-to-end verification

**Files:** none (verification only).

- [ ] **Step 1: Run the whole backend suite**

Run: `go test ./pkg/... ./cmd/...`
Expected: PASS (no regressions in `pkg/jarvis`, `pkg/wshrpc/wshserver`, `cmd/wsh`).

- [ ] **Step 2: Confirm bindings + TS are clean**

Run: `task generate` then `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: `task generate` leaves the tree unchanged (no drift after Task 3); tsc exit 0.

- [ ] **Step 3: Build the backend binaries**

Run: `task build:backend`
Expected: `wavesrv` + `wsh` build into `dist/bin/` (the new `wsh jarvis run` ships in `wsh`).

- [ ] **Step 4: End-to-end over CDP (live dev app)**

Bring up the dev app (`tail -f /dev/null | task dev`, per the dev-stdin gotcha). Then, against a channel whose ⚙ strategy is **orchestrator** with the plan gate on, in a project with a tiny 2-unit fixture backlog file:
1. `@run work <fixture-backlog>.md` — a single lead spawns.
2. Confirm the lead holds at the plan gate with a **decomposition checklist** (2 units) as the plan artifact.
3. Approve — confirm **two child runs** appear in the Runs list, each with its own worker, and each seals its own evidence card.
4. Confirm the lead reaches `done` (`wsh jarvis complete`) after both children report, and that the **lead's own transcript stayed short** — it never pasted a child's diff/transcript (the balloon proof).
5. Cancel one child mid-run in a second pass and confirm the lead is woken (asks retry-or-continue via an AskUserQuestion card).
6. Regression: `@run <single cohesive task>` on the same channel still runs one lead with in-process subagents (no child runs spawned).

Record the outcome (pass/fail per step). This step gates "done"; do not claim the feature works without it.

- [ ] **Step 5: Final commit** (on approval — folds spec + plan + code into one feature commit)

```bash
git add docs/superpowers/specs/2026-07-21-backlog-driven-orchestration-design.md docs/superpowers/plans/2026-07-21-backlog-driven-orchestration.md
git commit -m "feat(runs): backlog-driven orchestration via child runs

Design + plan for letting an orchestrator lead fan a backlog out into one
bounded child run per independent unit, keeping the lead's context thin."
```

*(If commits were made per task, this final commit carries only the spec + plan docs, folded per repo policy; otherwise stage everything from Tasks 1-6 here.)*
