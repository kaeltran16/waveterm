// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package blockcontroller

import (
	"testing"

	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wps"
)

func TestAgentStatusEvent(t *testing.T) {
	ev := AgentStatusEvent("abc", baseds.AgentState_Idle, "codex", 1717000000000)
	if ev.Event != wps.Event_AgentStatus {
		t.Fatalf("event = %q, want %q", ev.Event, wps.Event_AgentStatus)
	}
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
	if data.State != baseds.AgentState_Idle || data.ORef != "block:abc" || data.Agent != "codex" || data.Ts != 1717000000000 {
		t.Errorf("data = %#v, want idle/block:abc/codex/ts", data)
	}
}

func TestIdleOnExitEvent(t *testing.T) {
	// agent session -> idle event carrying the runtime as agent
	meta := waveobj.MetaMapType{"session:agent": "claude"}
	ev := idleOnExitEvent("blk1", meta, 42)
	if ev == nil {
		t.Fatal("agent session should produce an idle event, got nil")
	}
	data := ev.Data.(baseds.AgentStatusData)
	if data.State != baseds.AgentState_Idle || data.ORef != "block:blk1" || data.Agent != "claude" {
		t.Errorf("data = %#v, want idle/block:blk1/claude", data)
	}

	// codex runtime preserved
	if ev := idleOnExitEvent("blk1", waveobj.MetaMapType{"session:agent": "codex"}, 42); ev == nil || ev.Data.(baseds.AgentStatusData).Agent != "codex" {
		t.Errorf("codex runtime not preserved: %#v", ev)
	}

	// plain terminal (no session:agent) -> no emit
	if ev := idleOnExitEvent("blk1", waveobj.MetaMapType{}, 42); ev != nil {
		t.Errorf("non-agent block should emit nothing, got %#v", ev)
	}
}
