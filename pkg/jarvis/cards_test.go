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

func sampleQuestions() []baseds.AgentAskQuestion { return []baseds.AgentAskQuestion{sampleQuestion()} }

func pick(idx ...int) baseds.AgentAnswerItem { return baseds.AgentAnswerItem{SelectedIndexes: idx} }

func TestBuildCardData_MultiQuestionKeepsLegacyFieldsFromQuestionZero(t *testing.T) {
	second := baseds.AgentAskQuestion{Question: "Regions?", MultiSelect: true, Options: []baseds.AgentAskOption{{Label: "eu"}, {Label: "us"}}}
	qs := []baseds.AgentAskQuestion{sampleQuestion(), second}
	cd := BuildCardData(qs, []baseds.AgentAnswerItem{pick(1), {Text: "both"}}, "r", "block:abc", "ask-1", "tab:xyz")
	if cd.Question != sampleQuestion().Question || len(cd.Options) != 2 || cd.Choice == nil || *cd.Choice != 1 {
		t.Fatalf("legacy fields not mirrored from question 0: %+v", cd)
	}
	if len(cd.Questions) != 2 || !cd.Questions[1].MultiSelect || len(cd.Questions[1].Options) != 2 {
		t.Fatalf("questions: %+v", cd.Questions)
	}
	if len(cd.Answers) != 2 || cd.Answers[0].Picks[0] != 1 || cd.Answers[1].Text != "both" {
		t.Fatalf("answers: %+v", cd.Answers)
	}
}

// a card persisted before Questions/Answers existed still reads as its single question
func TestJarvisCardData_LegacyCardStillParses(t *testing.T) {
	var cd JarvisCardData
	legacy := `{"askORef":"block:a","workerORef":"tab:b","question":"q","options":[{"label":"x"}],"choice":0}`
	if err := json.Unmarshal([]byte(legacy), &cd); err != nil {
		t.Fatal(err)
	}
	if cd.Question != "q" || len(cd.Options) != 1 || cd.Choice == nil || len(cd.Questions) != 0 || len(cd.Answers) != 0 {
		t.Fatalf("legacy card misread: %+v", cd)
	}
}

func TestBuildCardData_Answered(t *testing.T) {
	cd := BuildCardData(sampleQuestions(), []baseds.AgentAnswerItem{pick(0)}, "low-risk, reversible", "block:abc", "ask-1", "tab:xyz")
	if cd.AskORef != "block:abc" || cd.AskId != "ask-1" || cd.WorkerORef != "tab:xyz" {
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
	cd := BuildCardData(sampleQuestions(), nil, "real fork", "block:abc", "ask-1", "tab:xyz")
	if cd.Choice != nil {
		t.Fatalf("expected nil choice, got %+v", cd.Choice)
	}
}

func TestSetCardHumanPick_SetsPickAndPreservesFields(t *testing.T) {
	orig, err := json.Marshal(BuildCardData(sampleQuestions(), []baseds.AgentAnswerItem{pick(1)}, "reason", "block:abc", "ask-1", "tab:xyz"))
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
