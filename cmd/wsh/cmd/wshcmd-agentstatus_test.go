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
