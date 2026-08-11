// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"testing"

	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wps"
)

func TestBuildAgentStatusEvent(t *testing.T) {
	oref := &waveobj.ORef{OType: waveobj.OType_Block, OID: "abc"}
	data := baseds.AgentStatusData{ORef: oref.String(), State: baseds.AgentState_Working}

	ev := buildAgentStatusEvent(oref, data, 1)

	if ev.Event != wps.Event_AgentStatus {
		t.Fatalf("event type = %q, want %q", ev.Event, wps.Event_AgentStatus)
	}
	if ev.Persist != 1 {
		t.Fatalf("persist = %d, want 1", ev.Persist)
	}
	if len(ev.Scopes) != 1 || ev.Scopes[0] != "block:abc" {
		t.Fatalf("scopes = %v, want [block:abc]", ev.Scopes)
	}
	if got, ok := ev.Data.(baseds.AgentStatusData); !ok || got.State != baseds.AgentState_Working {
		t.Fatalf("data = %#v, want AgentStatusData{State:working}", ev.Data)
	}
}

func TestValidAgentState(t *testing.T) {
	for _, s := range []string{"working", "waiting", "idle"} {
		if !validAgentState(s) {
			t.Fatalf("validAgentState(%q) = false, want true", s)
		}
	}
	for _, s := range []string{"", "asking", "running", "done"} {
		if validAgentState(s) {
			t.Fatalf("validAgentState(%q) = true, want false", s)
		}
	}
}

func TestBuildAgentStatusData_piPayload(t *testing.T) {
	oref := &waveobj.ORef{OType: waveobj.OType_Block, OID: "abc"}
	transcript := `C:\Users\Jane Doe\.pi\agent\sessions\s.jsonl`
	data := buildAgentStatusData(oref, "working", "running a tool", "pi",
		`C:\Users\Jane Doe\proj`, transcript, "session-1", "fix the bug", "openai-codex", "gpt-5.5", 12345)

	if data.ORef != "block:abc" {
		t.Fatalf("ORef = %q, want block:abc", data.ORef)
	}
	if data.State != "working" {
		t.Fatalf("State = %q, want working", data.State)
	}
	if data.Detail != "running a tool" {
		t.Fatalf("Detail = %q, want running a tool", data.Detail)
	}
	if data.Agent != "pi" {
		t.Fatalf("Agent = %q, want pi", data.Agent)
	}
	if data.Cwd != `C:\Users\Jane Doe\proj` {
		t.Fatalf("Cwd = %q, want the project path unmodified", data.Cwd)
	}
	// the Windows session file path must survive as one string, never split on '\'
	if data.TranscriptPath != transcript {
		t.Fatalf("TranscriptPath = %q, want %q (preserved as one string)", data.TranscriptPath, transcript)
	}
	if data.SessionID != "session-1" {
		t.Fatalf("SessionID = %q, want session-1", data.SessionID)
	}
	if data.Title != "fix the bug" {
		t.Fatalf("Title = %q, want fix the bug", data.Title)
	}
	if data.Provider != "openai-codex" {
		t.Fatalf("Provider = %q, want openai-codex", data.Provider)
	}
	if data.Model != "gpt-5.5" {
		t.Fatalf("Model = %q, want gpt-5.5", data.Model)
	}
	if data.Ts != 12345 {
		t.Fatalf("Ts = %d, want 12345", data.Ts)
	}
	if data.Usage != nil {
		t.Fatalf("Usage = %#v, want nil", data.Usage)
	}
}
