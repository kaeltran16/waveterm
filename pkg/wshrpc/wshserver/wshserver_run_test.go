// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"testing"

	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

func bptr(b bool) *bool { return &b }

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
