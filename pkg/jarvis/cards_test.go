// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvis

import (
	"encoding/json"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/baseds"
)

func sampleQuestion() baseds.AgentAskQuestion {
	return baseds.AgentAskQuestion{
		Question: "Session cache TTL — 24h or 7d?",
		Options: []baseds.AgentAskOption{
			{Label: "24 hours", Description: "matches access-token lifetime"},
			{Label: "7 days", Description: "fewer re-auths"},
		},
	}
}

func TestBuildCardData_Answered(t *testing.T) {
	choice := 0
	cd := BuildCardData(sampleQuestion(), &choice, "low-risk, reversible", "block:abc", "tab:xyz")
	if cd.AskORef != "block:abc" || cd.WorkerORef != "tab:xyz" {
		t.Fatalf("orefs: %+v", cd)
	}
	if cd.Question != "Session cache TTL — 24h or 7d?" {
		t.Fatalf("question: %q", cd.Question)
	}
	if len(cd.Options) != 2 || cd.Options[0].Label != "24 hours" || cd.Options[0].Sub != "matches access-token lifetime" {
		t.Fatalf("options: %+v", cd.Options)
	}
	if cd.Choice == nil || *cd.Choice != 0 {
		t.Fatalf("choice: %+v", cd.Choice)
	}
	if cd.Reason != "low-risk, reversible" {
		t.Fatalf("reason: %q", cd.Reason)
	}
	// round-trips as JSON
	if _, err := json.Marshal(cd); err != nil {
		t.Fatalf("marshal: %v", err)
	}
}

func TestBuildCardData_Escalation_NoChoice(t *testing.T) {
	cd := BuildCardData(sampleQuestion(), nil, "real fork", "block:abc", "tab:xyz")
	if cd.Choice != nil {
		t.Fatalf("expected nil choice, got %+v", cd.Choice)
	}
}
