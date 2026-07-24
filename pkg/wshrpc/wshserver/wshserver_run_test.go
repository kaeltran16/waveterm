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

func bptr(b bool) *bool { return &b }

// A run reaching done must persist the phase transition synchronously (the ack `wsh jarvis complete`
// waits on) while the slow evidence seal (a git diff) is dispatched off the RPC budget. Sealing inline
// blocked the handler past the 5s client budget, surfacing as EC-TIME even though the completion had
// already registered. We prove the decoupling deterministically via the sealAsync seam: capture the seal
// instead of running it, then confirm the run is already done with evidence still unsealed.
func TestCompleteDefersEvidenceSeal(t *testing.T) {
	ctx := context.Background()
	ch, err := wstore.CreateChannel(ctx, "defer-seal", t.TempDir())
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	run := jarvis.NewRun("finish it", "ws-1", ch.ProjectPath, nil, jarvis.RunMode_Quick, jarvis.QuickPlaybook(), 1)
	if err := wstore.AppendRun(ctx, ch.OID, run); err != nil {
		t.Fatalf("AppendRun: %v", err)
	}

	var captured func()
	origAsync := sealAsync
	sealAsync = func(fn func()) { captured = fn }
	defer func() { sealAsync = origAsync }()

	// a done quick run spawns no next worker; guard against a real subprocess if that assumption breaks
	origSpawn := jarvis.SpawnClaudeWorker
	jarvis.SpawnClaudeWorker = func(_ context.Context, _, _, _, _ string) (string, error) {
		return waveobj.MakeORef(waveobj.OType_Tab, "x").String(), nil
	}
	defer func() { jarvis.SpawnClaudeWorker = origSpawn }()

	ws := &WshServer{}
	if err := ws.AdvanceRunCommand(ctx, wshrpc.CommandAdvanceRunData{
		ChannelId: ch.OID, RunId: run.ID, PhaseIdx: 0, Action: jarvis.RunAction_Complete,
	}); err != nil {
		t.Fatalf("AdvanceRunCommand: %v", err)
	}

	done, err := wstore.GetRun(ctx, ch.OID, run.ID)
	if err != nil {
		t.Fatalf("GetRun: %v", err)
	}
	if done.Status != jarvis.RunStatus_Done {
		t.Fatalf("run status = %q, want done (the transition must persist synchronously)", done.Status)
	}
	if done.Evidence != nil {
		t.Fatal("evidence sealed inline; the slow seal must be deferred off the RPC budget")
	}
	if captured == nil {
		t.Fatal("seal was not dispatched to sealAsync")
	}

	captured() // running the deferred seal then persists the snapshot (idempotent; backfilled otherwise)
	sealed, err := wstore.GetRun(ctx, ch.OID, run.ID)
	if err != nil {
		t.Fatalf("GetRun: %v", err)
	}
	if sealed.Evidence == nil {
		t.Fatal("deferred seal did not persist evidence")
	}
}

// A run entering a rest state must dispatch the continuity boundary summary off the RPC budget (it is a
// model call). We prove the decoupling via the captureAsync seam: capture the dispatched func instead of
// running it, and confirm a ->done transition dispatched exactly one capture.
func TestAdvanceRunDispatchesContinuityCapture(t *testing.T) {
	ctx := context.Background()
	ch, err := wstore.CreateChannel(ctx, "continuity-dispatch", t.TempDir())
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	run := jarvis.NewRun("finish it", "ws-1", ch.ProjectPath, nil, jarvis.RunMode_Quick, jarvis.QuickPlaybook(), 1)
	if err := wstore.AppendRun(ctx, ch.OID, run); err != nil {
		t.Fatalf("AppendRun: %v", err)
	}

	var capturedContinuity func()
	origCap := captureAsync
	captureAsync = func(fn func()) { capturedContinuity = fn }
	defer func() { captureAsync = origCap }()

	// keep the evidence seal off a real goroutine / git diff for this test
	origSeal := sealAsync
	sealAsync = func(fn func()) {}
	defer func() { sealAsync = origSeal }()

	origSpawn := jarvis.SpawnClaudeWorker
	jarvis.SpawnClaudeWorker = func(_ context.Context, _, _, _, _ string) (string, error) {
		return waveobj.MakeORef(waveobj.OType_Tab, "x").String(), nil
	}
	defer func() { jarvis.SpawnClaudeWorker = origSpawn }()

	ws := &WshServer{}
	if err := ws.AdvanceRunCommand(ctx, wshrpc.CommandAdvanceRunData{
		ChannelId: ch.OID, RunId: run.ID, PhaseIdx: 0, Action: jarvis.RunAction_Complete,
	}); err != nil {
		t.Fatalf("AdvanceRunCommand: %v", err)
	}

	if capturedContinuity == nil {
		t.Fatal("continuity capture was not dispatched on the ->done rest transition")
	}
}

func TestApplyRunActionTriage(t *testing.T) {
	r := jarvis.NewRun("do X", "ws", "/p", nil, jarvis.RunMode_Orchestrator, jarvis.DefaultOrchestratorPlaybook(false), 1)
	next, err := applyRunAction(r, wshrpc.CommandAdvanceRunData{Action: jarvis.RunAction_Triage, PhaseIdx: 0, Verdict: "quick", Note: "tiny fix"}, 0)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if next.Phases[0].Triage == nil || next.Phases[0].Triage.Verdict != "quick" || next.Phases[0].Triage.Note != "tiny fix" {
		t.Errorf("triage not recorded: %+v", next.Phases[0].Triage)
	}
	if next.Status != jarvis.RunStatus_Executing {
		t.Errorf("triage must leave the run executing, got %q", next.Status)
	}
}

func TestApplyRunActionCompleteStoresEndCommit(t *testing.T) {
	r := jarvis.NewRun("do X", "ws", "/p", nil, jarvis.RunMode_Quick, jarvis.QuickPlaybook(), 1)
	// complete with a reported commit -> stored on the run as EndCommit (scopes the sealed evidence diff)
	next, err := applyRunAction(r, wshrpc.CommandAdvanceRunData{Action: jarvis.RunAction_Complete, PhaseIdx: 0, Commit: "abc123"}, 2)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if next.EndCommit != "abc123" {
		t.Errorf("EndCommit = %q, want abc123", next.EndCommit)
	}
	// a non-complete action must never set EndCommit even if a commit is (spuriously) supplied
	r2 := jarvis.NewRun("do Y", "ws", "/p", nil, jarvis.RunMode_Orchestrator, jarvis.DefaultOrchestratorPlaybook(false), 1)
	next2, err := applyRunAction(r2, wshrpc.CommandAdvanceRunData{Action: jarvis.RunAction_Triage, PhaseIdx: 0, Verdict: "quick", Commit: "deadbeef"}, 0)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if next2.EndCommit != "" {
		t.Errorf("triage must not set EndCommit, got %q", next2.EndCommit)
	}
}

func TestApplyRunActionUnknown(t *testing.T) {
	r := jarvis.NewRun("g", "ws", "/p", nil, jarvis.RunMode_Orchestrator, jarvis.DefaultOrchestratorPlaybook(false), 1)
	if _, err := applyRunAction(r, wshrpc.CommandAdvanceRunData{Action: "bogus"}, 0); err == nil {
		t.Error("expected error for unknown action")
	}
}

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
