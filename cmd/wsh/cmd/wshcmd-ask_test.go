// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import "testing"

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
