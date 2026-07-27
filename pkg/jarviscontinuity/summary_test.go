// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarviscontinuity

import (
	"strings"
	"testing"
)

func TestBuildSummaryPromptIncludesFactsAndGuardrails(t *testing.T) {
	f := SummaryFacts{
		Objective:  "ship the widget",
		RestReason: restBlocked,
		Blockers:   []string{"token refresh test failing"},
		Decisions:  []string{"chose middleware extraction because it isolates auth"},
		RunGoal:    "ship ABC-7 the widget",
		RunStatus:  "blocked",
	}
	p := buildSummaryPrompt(f)
	for _, want := range []string{
		"ship the widget", "blocked", "token refresh test failing",
		"middleware extraction", "Do not invent decisions",
	} {
		if !strings.Contains(p, want) {
			t.Errorf("prompt missing %q\n---\n%s", want, p)
		}
	}
}

func TestHasActivityAndTerseState(t *testing.T) {
	empty := SummaryFacts{RestReason: restBlocked}
	if empty.hasActivity() {
		t.Fatal("no blockers/decisions/endcommit -> no activity")
	}
	if got := terseState(empty); !strings.Contains(got, "no recorded progress") {
		t.Errorf("terse paused state = %q", got)
	}
	if got := terseState(SummaryFacts{RestReason: restCompleted}); !strings.Contains(got, "Completed") {
		t.Errorf("terse completed state = %q", got)
	}
	if !(SummaryFacts{RestReason: restBlocked, Blockers: []string{"x"}}).hasActivity() {
		t.Fatal("a blocker means there is activity to summarize")
	}
	if !(SummaryFacts{RestReason: restCompleted, HasEndCommit: true}).hasActivity() {
		t.Fatal("a completed run with an end commit has activity")
	}
}
