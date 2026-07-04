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

func TestSetCardHumanPick_SetsPickAndPreservesFields(t *testing.T) {
	choice := 1
	orig, err := json.Marshal(BuildCardData(sampleQuestion(), &choice, "reason", "block:abc", "tab:xyz"))
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	patched, err := SetCardHumanPick(string(orig), 0)
	if err != nil {
		t.Fatalf("SetCardHumanPick: %v", err)
	}
	var cd JarvisCardData
	if err := json.Unmarshal([]byte(patched), &cd); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if cd.HumanPick == nil || *cd.HumanPick != 0 {
		t.Fatalf("humanPick: %+v", cd.HumanPick)
	}
	// original Jarvis choice + other fields survive the patch
	if cd.Choice == nil || *cd.Choice != 1 {
		t.Fatalf("choice clobbered: %+v", cd.Choice)
	}
	if cd.Question == "" || len(cd.Options) != 2 || cd.AskORef != "block:abc" {
		t.Fatalf("fields lost: %+v", cd)
	}
}

func TestSetCardHumanPick_RejectsMalformed(t *testing.T) {
	if _, err := SetCardHumanPick("{not json", 0); err == nil {
		t.Fatalf("expected error for malformed data")
	}
}
