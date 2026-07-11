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
	r := jarvis.NewRun("do X", "ws", "/p", "", jarvis.RunMode_Orchestrator, jarvis.DefaultOrchestratorPlaybook(false), 1)
	next, err := applyRunAction(r, wshrpc.CommandAdvanceRunData{Action: jarvis.RunAction_Triage, PhaseIdx: 0, Verdict: "quick", Note: "tiny fix"})
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

func TestApplyRunActionUnknown(t *testing.T) {
	r := jarvis.NewRun("g", "ws", "/p", "", jarvis.RunMode_Orchestrator, jarvis.DefaultOrchestratorPlaybook(false), 1)
	if _, err := applyRunAction(r, wshrpc.CommandAdvanceRunData{Action: "bogus"}); err == nil {
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
