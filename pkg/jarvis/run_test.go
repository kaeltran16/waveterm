// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvis

import (
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

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

func TestNewRunStartsFirstPhaseRunning(t *testing.T) {
	r := NewRun("ship coupons", "ws1", "/repo", "", DefaultPlaybook(), 1717000000000)
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

func TestNewRunStoresPrinciples(t *testing.T) {
	r := NewRun("g", "ws", "/r", "prefer the clean fix", DefaultPlaybook(), 1)
	if r.Principles != "prefer the clean fix" {
		t.Fatalf("want principles stored, got %q", r.Principles)
	}
}

func TestNewRunCopiesPlaybook(t *testing.T) {
	pb := DefaultPlaybook()
	r := NewRun("g", "ws", "/r", "", pb, 1)
	r.Phases[0].State = PhaseState_Done
	if pb[0].State != PhaseState_Pending {
		t.Errorf("NewRun must not alias the caller's playbook slice")
	}
}

func TestCompletePhaseAdvancesLinear(t *testing.T) {
	r := NewRun("g", "ws", "/r", "", DefaultPlaybook(), 1)
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
	r := NewRun("g", "ws", "/r", "", DefaultPlaybook(), 1)
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
	r := NewRun("g", "ws", "/r", "", DefaultPlaybook(), 1)
	if _, err := CompletePhase(r, 1, nil); err == nil {
		t.Errorf("expected error completing a pending phase")
	}
	if _, err := CompletePhase(r, 9, nil); err == nil {
		t.Errorf("expected error for out-of-range index")
	}
}

func runAtGate(t *testing.T) waveobj.Run {
	t.Helper()
	r := NewRun("g", "ws", "/r", "", DefaultPlaybook(), 1)
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
	r := NewRun("g", "ws", "/r", "", DefaultPlaybook(), 1)
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

func TestCancelRunSkipsOpenPhases(t *testing.T) {
	r := NewRun("g", "ws", "/r", "", DefaultPlaybook(), 1)
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
	got := BuildPhasePrompt(p, "ship coupons", []string{"docs/spec.md"}, "")
	for _, want := range []string{"superpowers:writing-plans", "ship coupons", "docs/spec.md"} {
		if !strings.Contains(got, want) {
			t.Errorf("prompt missing %q: %s", want, got)
		}
	}
}

func TestBuildPhasePromptIncludesPrinciplesWhenPresent(t *testing.T) {
	p := waveobj.RunPhase{Kind: PhaseKind_Execute, Skill: "superpowers:executing-plans"}
	got := BuildPhasePrompt(p, "ship coupons", nil, "prefer the clean fix")
	if !strings.Contains(got, "prefer the clean fix") {
		t.Errorf("prompt missing principles: %s", got)
	}
}

func TestBuildPhasePromptOmitsPrinciplesWhenEmpty(t *testing.T) {
	p := waveobj.RunPhase{Kind: PhaseKind_Plan, Skill: "superpowers:writing-plans"}
	withEmpty := BuildPhasePrompt(p, "g", nil, "")
	if strings.Contains(withEmpty, "principles") {
		t.Errorf("empty principles should add no principles text: %s", withEmpty)
	}
}
