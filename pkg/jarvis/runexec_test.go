// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvis

import (
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/wps"
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

func TestInitialWorkerStatusEvent(t *testing.T) {
	ev := initialWorkerStatusEvent("abc", 1717000000000)
	if ev.Event != wps.Event_AgentStatus {
		t.Fatalf("event = %q, want %q", ev.Event, wps.Event_AgentStatus)
	}
	// Persist:1 so a late-subscribing frontend replays it and the worker still shows.
	if ev.Persist != 1 {
		t.Errorf("persist = %d, want 1", ev.Persist)
	}
	if len(ev.Scopes) != 1 || ev.Scopes[0] != "block:abc" {
		t.Errorf("scopes = %v, want [block:abc]", ev.Scopes)
	}
	data, ok := ev.Data.(baseds.AgentStatusData)
	if !ok {
		t.Fatalf("data type = %T, want baseds.AgentStatusData", ev.Data)
	}
	if data.State != baseds.AgentState_Working || data.ORef != "block:abc" || data.Agent != "claude" {
		t.Errorf("data = %#v, want working/block:abc/claude", data)
	}
}
