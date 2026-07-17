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
	r := NewRun("ship coupons", "ws1", "/repo", nil, RunMode_Pipeline, DefaultPlaybook(), 1717000000000)
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

func TestNewRunSnapshotsPrinciples(t *testing.T) {
	source := waveobj.PrincipleList{{ID: "simple", Text: "Prefer simple solutions."}}
	r := NewRun("g", "ws", "/r", source, RunMode_Pipeline, DefaultPlaybook(), 1)
	source[0].Text = "changed later"
	if got := r.Principles[0].Text; got != "Prefer simple solutions." {
		t.Fatalf("want snapshotted principles, got %q", got)
	}
}

func TestNewRunCopiesPlaybook(t *testing.T) {
	pb := DefaultPlaybook()
	r := NewRun("g", "ws", "/r", nil, RunMode_Pipeline, pb, 1)
	r.Phases[0].State = PhaseState_Done
	if pb[0].State != PhaseState_Pending {
		t.Errorf("NewRun must not alias the caller's playbook slice")
	}
}

func TestCompletePhaseAdvancesLinear(t *testing.T) {
	r := NewRun("g", "ws", "/r", nil, RunMode_Pipeline, DefaultPlaybook(), 1)
	r, err := CompletePhase(r, 0, []string{"docs/spec.md"}, 0)
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

func TestCompletePhaseRecordsTimestamps(t *testing.T) {
	r := NewRun("g", "ws", "/p", nil, RunMode_Pipeline, DefaultPlaybook(), 1000)
	if r.Phases[0].StartedTs != 1000 {
		t.Fatalf("first phase StartedTs = %d, want 1000", r.Phases[0].StartedTs)
	}
	r, err := CompletePhase(r, 0, nil, 2000)
	if err != nil {
		t.Fatal(err)
	}
	if r.Phases[0].DoneTs != 2000 {
		t.Fatalf("phase0 DoneTs = %d, want 2000", r.Phases[0].DoneTs)
	}
	if r.Phases[1].StartedTs != 2000 {
		t.Fatalf("phase1 StartedTs = %d, want 2000 (successor start)", r.Phases[1].StartedTs)
	}
}

func TestCompletePhaseHaltsAtGate(t *testing.T) {
	r := NewRun("g", "ws", "/r", nil, RunMode_Pipeline, DefaultPlaybook(), 1)
	r, _ = CompletePhase(r, 0, nil, 0)
	r, err := CompletePhase(r, 1, []string{"docs/plan.md"}, 0)
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
	r := NewRun("g", "ws", "/r", nil, RunMode_Pipeline, DefaultPlaybook(), 1)
	if _, err := CompletePhase(r, 1, nil, 0); err == nil {
		t.Errorf("expected error completing a pending phase")
	}
	if _, err := CompletePhase(r, 9, nil, 0); err == nil {
		t.Errorf("expected error for out-of-range index")
	}
}

func runAtGate(t *testing.T) waveobj.Run {
	t.Helper()
	r := NewRun("g", "ws", "/r", nil, RunMode_Pipeline, DefaultPlaybook(), 1)
	r, _ = CompletePhase(r, 0, nil, 0)
	r, _ = CompletePhase(r, 1, []string{"docs/plan.md"}, 0)
	if r.Status != RunStatus_AwaitingReview {
		t.Fatalf("setup: expected awaiting-review, got %q", r.Status)
	}
	return r
}

func TestApproveGateStartsExecute(t *testing.T) {
	r := runAtGate(t)
	r, err := ApproveGate(r, 0)
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
	r := NewRun("g", "ws", "/r", nil, RunMode_Pipeline, DefaultPlaybook(), 1)
	if _, err := ApproveGate(r, 0); err == nil {
		t.Errorf("expected error approving a run not awaiting-review")
	}
}

func TestSendBackReopensPlan(t *testing.T) {
	r := runAtGate(t)
	r, err := SendBackGate(r, 0)
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
	r := NewRun("g", "ws", "/r", nil, RunMode_Pipeline, DefaultPlaybook(), 1)
	r, _ = CompletePhase(r, 0, nil, 0)
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
	got := BuildPhasePrompt(p, "ship coupons", []string{"docs/spec.md"}, nil)
	for _, want := range []string{"superpowers:writing-plans", "ship coupons", "docs/spec.md"} {
		if !strings.Contains(got, want) {
			t.Errorf("prompt missing %q: %s", want, got)
		}
	}
}

func TestBuildPhasePromptTellsWorkerToSelfServeAndEscalate(t *testing.T) {
	p := waveobj.RunPhase{Kind: PhaseKind_Brainstorm, Skill: "superpowers:brainstorming"}
	got := BuildPhasePrompt(p, "write a haiku", nil, nil)
	// headless workers must not stall on a skill's clarifying questions: proceed on assumptions,
	// escalate only hard calls via AskUserQuestion (routed to the cockpit).
	for _, want := range []string{"headless", "AskUserQuestion"} {
		if !strings.Contains(got, want) {
			t.Errorf("prompt missing autonomy guidance %q: %s", want, got)
		}
	}
}

func TestBuildPhasePromptTellsWorkerToSelfReportComplete(t *testing.T) {
	p := waveobj.RunPhase{Kind: PhaseKind_Brainstorm, Skill: "superpowers:brainstorming"}
	got := BuildPhasePrompt(p, "write a haiku", nil, nil)
	if !strings.Contains(got, "wsh jarvis complete") {
		t.Errorf("prompt missing self-report instruction: %s", got)
	}
}

func TestBuildPhasePromptIncludesPrinciplesWhenPresent(t *testing.T) {
	p := waveobj.RunPhase{Kind: PhaseKind_Execute, Skill: "superpowers:executing-plans"}
	got := BuildPhasePrompt(p, "ship coupons", nil, waveobj.PrincipleList{{ID: "clean", Text: "prefer the clean fix"}})
	if !strings.Contains(got, "prefer the clean fix") {
		t.Errorf("prompt missing principles: %s", got)
	}
}

func TestBuildPhasePromptRendersEffectivePrinciplesOnly(t *testing.T) {
	p := waveobj.RunPhase{Kind: PhaseKind_Execute, Skill: "superpowers:executing-plans"}
	global := waveobj.PrincipleList{
		{ID: "simple", Text: "Prefer simple solutions."},
		{ID: "measure", Text: "Measure first."},
	}
	resolved, _ := ResolvePrinciples(global, &waveobj.PrinciplePatch{
		Replacements: map[string]string{"simple": "Prefer the clean fix."},
		Disabled:     []string{"measure"},
		Additions:    waveobj.PrincipleList{{ID: "project", Text: "Keep project compatibility."}},
	})
	got := BuildPhasePrompt(p, "ship coupons", nil, resolved)
	if strings.Contains(got, "Prefer simple solutions.") || strings.Contains(got, "Measure first.") {
		t.Fatalf("prompt contains superseded principles:\n%s", got)
	}
	want := "- Prefer the clean fix.\n- Keep project compatibility."
	if !strings.Contains(got, want) {
		t.Fatalf("prompt does not preserve effective order %q:\n%s", want, got)
	}
}

func TestBuildPhasePromptPreservesLegacyText(t *testing.T) {
	p := waveobj.RunPhase{Kind: PhaseKind_Execute, Skill: "superpowers:executing-plans"}
	legacy := "first legacy line\nsecond legacy line"
	got := BuildPhasePrompt(p, "ship coupons", nil, waveobj.PrincipleList{{ID: waveobj.LegacyGlobalPrincipleID, Text: legacy}})
	if !strings.Contains(got, "Work by these principles:\n"+legacy+"\n\nUse the") {
		t.Fatalf("legacy principle text changed:\n%s", got)
	}
}

func TestBuildPhasePromptOmitsPrinciplesWhenEmpty(t *testing.T) {
	p := waveobj.RunPhase{Kind: PhaseKind_Plan, Skill: "superpowers:writing-plans"}
	withEmpty := BuildPhasePrompt(p, "g", nil, nil)
	if strings.Contains(withEmpty, "principles") {
		t.Errorf("empty principles should add no principles text: %s", withEmpty)
	}
}

func orchRun(gate bool) waveobj.Run {
	return NewRun("ship it", "ws1", "/p", waveobj.PrincipleList{{ID: "clean", Text: "be clean"}}, RunMode_Orchestrator, DefaultOrchestratorPlaybook(gate), 1)
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
	r, err := HoldPhase(r, 0, []string{"docs/plan.md"})
	if err != nil {
		t.Fatal(err)
	}
	if !r.Phases[0].Held || r.Status != RunStatus_AwaitingReview {
		t.Fatalf("held=%v status=%q", r.Phases[0].Held, r.Status)
	}
	if len(r.Phases[0].Artifacts) != 1 || r.Phases[0].Artifacts[0] != "docs/plan.md" {
		t.Fatalf("hold should record the plan artifact, got %v", r.Phases[0].Artifacts)
	}
}

func TestHoldPhase_RejectsUngated(t *testing.T) {
	r := orchRun(false)
	if _, err := HoldPhase(r, 0, nil); err == nil {
		t.Fatal("expected error holding an ungated phase")
	}
}

func TestApproveGate_ResumesHeldInPlace(t *testing.T) {
	r := orchRun(true)
	r, _ = HoldPhase(r, 0, nil)
	r, err := ApproveGate(r, 0)
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
	p := BuildOrchestratePrompt("do X", waveobj.PrincipleList{{ID: "clean", Text: "be clean"}}, true)
	for _, want := range []string{"do X", "be clean", "wsh jarvis hold <plan-file-path>", "wsh jarvis complete", "subagent"} {
		if !strings.Contains(p, want) {
			t.Fatalf("prompt missing %q:\n%s", want, p)
		}
	}
	if strings.Contains(BuildOrchestratePrompt("do X", nil, false), "wsh jarvis hold") {
		t.Fatal("no-gate prompt must not tell the lead to hold")
	}
}

func TestBuildOrchestratePromptGateOffTriages(t *testing.T) {
	// gate off = adaptive: the lead sizes up the goal and announces a verdict before proceeding.
	off := BuildOrchestratePrompt("do X", nil, false)
	for _, want := range []string{"wsh jarvis triage", "quick", "plan"} {
		if !strings.Contains(off, want) {
			t.Errorf("gate-off prompt missing triage guidance %q:\n%s", want, off)
		}
	}
	// gate on = always plan + hold; no triage choice to make.
	if strings.Contains(BuildOrchestratePrompt("do X", nil, true), "wsh jarvis triage") {
		t.Error("gate-on prompt must not offer a triage choice")
	}
}

func TestBuildOrchestratePromptTellsLeadToAskViaAskUserQuestion(t *testing.T) {
	// A lead that poses a question to the human in prose never renders as a question, so the run
	// proceeds without an answer. Both modes must steer the lead to the AskUserQuestion channel
	// (which renders + blocks) and warn against prose questions.
	for _, gate := range []bool{true, false} {
		got := BuildOrchestratePrompt("do X", nil, gate)
		for _, want := range []string{"AskUserQuestion", "prose"} {
			if !strings.Contains(got, want) {
				t.Errorf("gate=%v prompt missing ask guidance %q:\n%s", gate, want, got)
			}
		}
	}
}

func TestRecordTriageIsNonBlocking(t *testing.T) {
	r := orchRun(false) // phase 0 running, status executing
	if r.Status != RunStatus_Executing {
		t.Fatalf("setup: want executing, got %q", r.Status)
	}
	r, err := RecordTriage(r, 0, "quick", "one-line config change")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if r.Phases[0].Triage == nil || r.Phases[0].Triage.Verdict != "quick" || r.Phases[0].Triage.Note != "one-line config change" {
		t.Errorf("triage not recorded: %+v", r.Phases[0].Triage)
	}
	if r.Phases[0].State != PhaseState_Running || r.Status != RunStatus_Executing {
		t.Errorf("triage must not change progress: state=%q status=%q", r.Phases[0].State, r.Status)
	}
}

func TestRecordTriageRejectsOutOfRange(t *testing.T) {
	r := orchRun(false)
	if _, err := RecordTriage(r, 9, "quick", ""); err == nil {
		t.Error("expected error for out-of-range index")
	}
}

func TestQuickPlaybook(t *testing.T) {
	pb := QuickPlaybook()
	if len(pb) != 1 {
		t.Fatalf("QuickPlaybook: want 1 phase, got %d", len(pb))
	}
	p := pb[0]
	if p.Kind != PhaseKind_Execute {
		t.Errorf("phase kind = %q, want %q", p.Kind, PhaseKind_Execute)
	}
	if p.Gate {
		t.Errorf("quick phase must not gate")
	}
	if !p.FreshCtx {
		t.Errorf("quick phase should run in fresh context")
	}
	if p.Skill != "" {
		t.Errorf("quick phase must have no skill, got %q", p.Skill)
	}
}

func TestNewRunQuick(t *testing.T) {
	r := NewRun("fix the flake", "ws1", "/repo", nil, RunMode_Quick, QuickPlaybook(), 1000)
	if r.Mode != RunMode_Quick {
		t.Errorf("mode = %q, want quick", r.Mode)
	}
	if len(r.Phases) != 1 || r.Phases[0].State != PhaseState_Running {
		t.Fatalf("expected one running phase, got %+v", r.Phases)
	}
	if r.Status == RunStatus_AwaitingReview {
		t.Errorf("quick run must not await review")
	}
}

func TestBuildQuickPrompt(t *testing.T) {
	// a single legacy-ID principle renders as its bare text (see RenderPrinciples)
	principles := waveobj.PrincipleList{{ID: waveobj.LegacyGlobalPrincipleID, Text: "be tidy"}}
	p := BuildQuickPrompt("add a spinner", principles)
	for _, want := range []string{"add a spinner", "be tidy", "wsh jarvis complete"} {
		if !strings.Contains(p, want) {
			t.Errorf("prompt missing %q:\n%s", want, p)
		}
	}
	if strings.Contains(p, "skill to work this goal") {
		t.Errorf("quick prompt must not carry a skill directive:\n%s", p)
	}
}
