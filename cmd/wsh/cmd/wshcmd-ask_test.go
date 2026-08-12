// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"testing"

	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

func TestParseAskQuestionsDirectShape(t *testing.T) {
	raw := []byte(`{"questions":[{"question":"Q1?","header":"H","multiSelect":true,"options":[{"label":"A","description":"da"},{"label":"B"}]}]}`)
	qs, err := parseAskQuestions(raw)
	if err != nil {
		t.Fatal(err)
	}
	if len(qs) != 1 || qs[0].Question != "Q1?" || qs[0].Header != "H" || !qs[0].MultiSelect {
		t.Fatalf("bad question: %#v", qs)
	}
	if len(qs[0].Options) != 2 || qs[0].Options[0].Label != "A" || qs[0].Options[0].Description != "da" {
		t.Fatalf("bad options: %#v", qs[0].Options)
	}
}

func TestParseAskQuestionsHookEnvelope(t *testing.T) {
	raw := []byte(`{"hook_event_name":"PreToolUse","tool_name":"AskUserQuestion","tool_input":{"questions":[{"question":"Q?","options":[{"label":"Yes"}]}]}}`)
	qs, err := parseAskQuestions(raw)
	if err != nil {
		t.Fatal(err)
	}
	if len(qs) != 1 || qs[0].Question != "Q?" || len(qs[0].Options) != 1 || qs[0].Options[0].Label != "Yes" {
		t.Fatalf("envelope not unwrapped: %#v", qs)
	}
}

func TestParseAskQuestionsEmpty(t *testing.T) {
	if _, err := parseAskQuestions([]byte(`{"questions":[]}`)); err == nil {
		t.Fatal("expected error for zero questions")
	}
	if _, err := parseAskQuestions([]byte(`not json`)); err == nil {
		t.Fatal("expected error for invalid json")
	}
}

func TestFormatAskResult(t *testing.T) {
	rtn := wshrpc.AskRtnData{AskId: "a1", Answers: []baseds.AgentAnswerItem{{SelectedIndexes: []int{1}}, {Text: "custom"}}}
	got, err := formatAskResult(rtn)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"answers":[{"selectedindexes":[1]},{"text":"custom"}],"cancelled":false}`
	if string(got) != want {
		t.Fatalf("want %s, got %s", want, got)
	}
	cancelled, _ := formatAskResult(wshrpc.AskRtnData{AskId: "a1", Cancelled: true})
	if string(cancelled) != `{"answers":null,"cancelled":true}` {
		t.Fatalf("cancelled shape: %s", cancelled)
	}
}

func TestParseAskQuestionsKeepsPreview(t *testing.T) {
	raw := []byte(`{"questions":[{"question":"Q?","options":[{"label":"A","preview":"mockup A"},{"label":"B"}]}]}`)
	qs, err := parseAskQuestions(raw)
	if err != nil {
		t.Fatal(err)
	}
	if qs[0].Options[0].Preview != "mockup A" || qs[0].Options[1].Preview != "" {
		t.Fatalf("preview not carried: %#v", qs[0].Options)
	}
}
