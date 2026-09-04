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

func TestBuildOrchestratePromptAdaptive(t *testing.T) {
	principles := waveobj.PrincipleList{{ID: "clean", Text: "be clean"}}
	// explicit adaptive, and the legacy empty-on-claude that must resolve to it
	for _, orch := range []string{Orchestration_Adaptive, ""} {
		p := BuildOrchestratePrompt("do X", principles, "claude", orch)
		for _, want := range []string{"do X", "be clean", "wsh jarvis triage", "wsh jarvis complete", "subagent", "AskUserQuestion", "prose"} {
			if !strings.Contains(p, want) {
				t.Fatalf("orch=%q prompt missing %q:\n%s", orch, want, p)
			}
		}
		if strings.Contains(p, "wsh jarvis hold") {
			t.Fatalf("orch=%q: orchestrator prompt must not tell the lead to hold", orch)
		}
		if strings.Contains(p, "dag submit") || strings.Contains(p, "import-tasks") {
			t.Fatalf("orch=%q: adaptive prompt must not mention the engine:\n%s", orch, p)
		}
	}
}

func TestBuildOrchestratePromptEngine(t *testing.T) {
	principles := waveobj.PrincipleList{{ID: "clean", Text: "be clean"}}

	claude := BuildOrchestratePrompt("do X", principles, "claude", Orchestration_Engine)
	for _, want := range []string{
		"do X", "be clean", "dag submit --file", "wsh jarvis dag wait", "terminal:",
		"wsh jarvis dag merge", "AskUserQuestion", "16 tasks", "one DAG", "wsh jarvis complete",
	} {
		if !strings.Contains(claude, want) {
			t.Fatalf("claude engine prompt missing %q:\n%s", want, claude)
		}
	}
	if strings.Contains(claude, "import-tasks") {
		t.Fatalf("claude engine prompt must not mention pi-tasks:\n%s", claude)
	}

	// pi keeps push delivery: control events, never the wait loop.
	pi := BuildOrchestratePrompt("do X", principles, "pi", Orchestration_Engine)
	for _, want := range []string{"import-tasks", "control events", "16 tasks", "wsh jarvis dag merge"} {
		if !strings.Contains(pi, want) {
			t.Fatalf("pi engine prompt missing %q:\n%s", want, pi)
		}
	}
	if strings.Contains(pi, "dag wait") || strings.Contains(pi, "--file") {
		t.Fatalf("pi engine prompt must not use the pull loop:\n%s", pi)
	}
}

// The prompt is load-bearing protocol: a lead that pattern-matches the literal word it was given
// never acts on the gate. The digest reports the kind `merge-ready` and the action `resolve-merge`,
// and never the bare word `merge`.
func TestBuildOrchestratePromptUsesDigestMergeVocabulary(t *testing.T) {
	for _, runtime := range []string{"claude", "pi"} {
		p := BuildOrchestratePrompt("do X", nil, runtime, Orchestration_Engine)
		for _, want := range []string{"`merge-ready`", "`resolve-merge`"} {
			if !strings.Contains(p, want) {
				t.Fatalf("%s engine prompt missing the digest's merge vocabulary %s:\n%s", runtime, want, p)
			}
		}
		if strings.Contains(p, "reports `merge`") {
			t.Fatalf("%s engine prompt names a digest kind that does not exist:\n%s", runtime, p)
		}
	}
}

func TestResolveOrchestrationLegacyFork(t *testing.T) {
	cases := []struct{ orch, runtime, want string }{
		{"", "pi", Orchestration_Engine},
		{"", "claude", Orchestration_Adaptive},
		{"", "codex", Orchestration_Adaptive},
		{"", "", Orchestration_Adaptive},
		{Orchestration_Engine, "claude", Orchestration_Engine},
		{Orchestration_Adaptive, "pi", Orchestration_Adaptive},
	}
	for _, c := range cases {
		if got := ResolveOrchestration(c.orch, c.runtime); got != c.want {
			t.Fatalf("ResolveOrchestration(%q, %q) = %q, want %q", c.orch, c.runtime, got, c.want)
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

// Nothing in the engine ever wrote PhaseState_Failed, which is why a lead whose process died kept
// reading "executing": status is derived from the phases, and no phase ever failed.
func TestFailPhaseDerivesBlocked(t *testing.T) {
	run := NewRun("goal", "ws-1", "/p", nil, RunMode_Orchestrator, DefaultOrchestratorPlaybook(false), 1000)
	if run.Status != RunStatus_Executing {
		t.Fatalf("fixture must start executing, got %q", run.Status)
	}
	idx := RunningPhaseIndex(run)
	if idx < 0 {
		t.Fatal("fixture must have a running phase")
	}
	failed, err := FailPhase(run, idx, 2000)
	if err != nil {
		t.Fatalf("FailPhase: %v", err)
	}
	if failed.Status != RunStatus_Blocked {
		t.Fatalf("a failed phase must derive blocked, got %q", failed.Status)
	}
	if failed.Phases[idx].State != PhaseState_Failed {
		t.Fatalf("phase must be failed, got %q", failed.Phases[idx].State)
	}
	// a duplicate exit report must not fail an already-failed phase again
	if _, err := FailPhase(failed, idx, 3000); err == nil {
		t.Fatal("failing a non-running phase must error rather than double-write")
	}
}
