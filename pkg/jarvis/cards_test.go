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
	cd := BuildCardData([]baseds.AgentAskQuestion{sampleQuestion()}, pick(choice), "low-risk, reversible", "block:abc", "ask-1", "tab:xyz")
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

func pick(idx int) []baseds.AgentAnswerItem {
	return []baseds.AgentAnswerItem{{SelectedIndexes: []int{idx}}}
}

// A multi-question card keeps question 0 in the single-question fields every existing reader uses, and carries the
// whole ask and its answers beside them.
func TestBuildCardData_MultiQuestionKeepsQuestionZeroForExistingReaders(t *testing.T) {
	second := baseds.AgentAskQuestion{Question: "Which stores?", MultiSelect: true, Options: []baseds.AgentAskOption{{Label: "redis"}, {Label: "sqlite"}}}
	answers := []baseds.AgentAnswerItem{{Text: "12 hours"}, {SelectedIndexes: []int{0, 1}}}
	cd := BuildCardData([]baseds.AgentAskQuestion{sampleQuestion(), second}, answers, "routine", "block:abc", "ask-1", "tab:xyz")
	if cd.Question != "Session cache TTL — 24h or 7d?" || len(cd.Options) != 2 || cd.Options[1].Label != "7 days" {
		t.Fatalf("legacy fields should describe question 0: %+v", cd)
	}
	if len(cd.Questions) != 2 || cd.Questions[1].Question != "Which stores?" || !cd.Questions[1].MultiSelect || len(cd.Questions[1].Options) != 2 {
		t.Fatalf("questions: %+v", cd.Questions)
	}
	if len(cd.Answers) != 2 || cd.Answers[0].Text != "12 hours" {
		t.Fatalf("answers: %+v", cd.Answers)
	}
	if cd.Choice != nil {
		t.Fatalf("a text answer to question 0 has no choice, got %d", *cd.Choice)
	}
}

// A card persisted before asks could carry several questions still reads, and a human pick patched onto it keeps
// its fields.
func TestLegacyCardStillReads(t *testing.T) {
	legacy := `{"askORef":"block:abc","askId":"ask-1","workerORef":"tab:xyz","question":"ship?","options":[{"label":"yes"},{"label":"no"}],"choice":1,"reason":"routine"}`
	var cd JarvisCardData
	if err := json.Unmarshal([]byte(legacy), &cd); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if cd.Question != "ship?" || len(cd.Options) != 2 || cd.Choice == nil || *cd.Choice != 1 || cd.AskORef != "block:abc" {
		t.Fatalf("legacy card misread: %+v", cd)
	}
	patched, err := SetCardHumanPick(legacy, 0)
	if err != nil {
		t.Fatalf("SetCardHumanPick: %v", err)
	}
	var out map[string]any
	if err := json.Unmarshal([]byte(patched), &out); err != nil {
		t.Fatalf("unmarshal patched: %v", err)
	}
	if out["question"] != "ship?" || out["humanPick"] != float64(0) {
		t.Fatalf("patched legacy card: %s", patched)
	}
	if _, has := out["questions"]; has {
		t.Fatalf("a legacy card should not grow an empty questions list: %s", patched)
	}
}

func TestBuildCardData_Escalation_NoChoice(t *testing.T) {
	cd := BuildCardData([]baseds.AgentAskQuestion{sampleQuestion()}, nil, "real fork", "block:abc", "ask-1", "tab:xyz")
	if cd.Choice != nil {
		t.Fatalf("expected nil choice, got %+v", cd.Choice)
	}
}

func TestSetCardHumanPick_SetsPickAndPreservesFields(t *testing.T) {
	choice := 1
	orig, err := json.Marshal(BuildCardData([]baseds.AgentAskQuestion{sampleQuestion()}, pick(choice), "reason", "block:abc", "ask-1", "tab:xyz"))
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
