// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package agentobserve

import (
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/baseds"
)

func TestBuildRecordJoinsAllThreeTracks(t *testing.T) {
	now := time.Date(2026, 7, 12, 12, 0, 0, 0, time.UTC)
	proc := ProcInfo{Pid: 42, BlockID: "abc", Cwd: `C:\proj`, CreateMs: 1000}
	res := Resolution{Path: "t.jsonl", Method: "createtime", MatchCount: 3}
	tail := TailResult{Lines: []string{recAssistantToolUse}, ModTime: now.Add(-2 * time.Second)}
	hook := HookState{LastState: "idle", LastMs: 999, Count: 5}

	rec := BuildRecord(proc, res, tail, hook, RosterProbe{State: "idle", Checked: true}, now, 20*time.Second)

	if rec.Event != EventSweep || rec.Pid != 42 || rec.BlockID != "abc" {
		t.Fatalf("anchor fields wrong: %+v", rec)
	}
	if !rec.RosterChecked || rec.RosterState != "idle" {
		t.Fatalf("roster fields wrong: %+v", rec)
	}
	if rec.MatchCount != 3 || rec.ResolveMethod != "createtime" {
		t.Fatalf("discovery fields wrong: %+v", rec)
	}
	if rec.ObserverState != baseds.AgentState_Working { // mid-tool, fresh
		t.Fatalf("ObserverState = %q, want working", rec.ObserverState)
	}
	if rec.HookState != "idle" || rec.HookCount != 5 {
		t.Fatalf("hook fields wrong: %+v", rec)
	}
	// observer says working while hook says idle -> exactly the disagreement the analyzer adjudicates
	if rec.ObserverState == rec.HookState {
		t.Fatal("expected observer/hook disagreement in this fixture")
	}
}

func TestBuildRecordNoTranscriptLeavesObserverEmpty(t *testing.T) {
	now := time.Date(2026, 7, 12, 12, 0, 0, 0, time.UTC)
	rec := BuildRecord(ProcInfo{Pid: 1, BlockID: "x"}, Resolution{Method: "none"}, TailResult{}, HookState{}, RosterProbe{}, now, 20*time.Second)
	if rec.ObserverState != "" {
		t.Fatalf("ObserverState = %q, want empty when no transcript resolved", rec.ObserverState)
	}
	if rec.RosterChecked {
		t.Fatal("RosterChecked should be false when RPC was unavailable")
	}
	if rec.HookCount != 0 {
		t.Fatal("HookCount should be 0 (coverage gap) when hook never fired")
	}
}
