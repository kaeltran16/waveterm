// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvis

import (
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/wavetermdev/waveterm/pkg/agentask"
	"github.com/wavetermdev/waveterm/pkg/baseds"
)

func askRowText(qs []baseds.AgentAskQuestion) string {
	in := AttentionInput{
		PendingAsks: map[string]agentask.PendingAsk{"block:a": {AskId: "1", Ts: 10, Questions: qs}},
	}
	for _, it := range BuildAttention(in) {
		if it.Kind == AttentionAsk {
			return it.Text
		}
	}
	return ""
}

func question(q string) []baseds.AgentAskQuestion {
	return []baseds.AgentAskQuestion{{Question: q}}
}

// the registry has carried the question all along; the row used to print a fixed literal, so a queue
// of three asks said the same thing three times.
func TestAskRowCarriesTheAgentsQuestion(t *testing.T) {
	got := askRowText(question("Drop the legacy column or keep a shim?"))
	if got != "Drop the legacy column or keep a shim?" {
		t.Fatalf("ask row does not carry the question: %q", got)
	}
}

func TestAskRowCollapsesAMultiLineQuestion(t *testing.T) {
	got := askRowText(question("Which branch?\n\n  - main\n  - release\t\t"))
	if got != "Which branch? - main - release" {
		t.Fatalf("question not collapsed to one line: %q", got)
	}
}

func TestAskRowTruncatesOnARuneBoundary(t *testing.T) {
	// every rune here is multi-byte, so a byte slice would cut one in half and emit invalid UTF-8.
	long := strings.Repeat("é", askQuestionMax+40)
	got := askRowText(question(long))
	if !strings.HasSuffix(got, "…") {
		t.Fatalf("long question was not truncated: %q", got)
	}
	if !utf8.ValidString(got) {
		t.Fatalf("truncation cut a multi-byte rune in half: %q", got)
	}
	if n := len([]rune(got)); n != askQuestionMax+1 {
		t.Fatalf("want %d runes plus the ellipsis, got %d", askQuestionMax, n)
	}
}

// a multi-question ask is one picker sequence; the row understates what answering costs if it shows
// only the first.
func TestAskRowSaysWhenThereIsMoreThanOneQuestion(t *testing.T) {
	got := askRowText([]baseds.AgentAskQuestion{
		{Question: "Runtime?"},
		{Question: "Tier?"},
		{Question: "Model?"},
	})
	if got != "Runtime? (+2 more)" {
		t.Fatalf("multi-question ask does not say so: %q", got)
	}
}

// a plan task's question goes to its lead first; it is the human's only once the lead forwards it or its
// deadline passes. Acceptance 4 listed a question the lead still held as waiting on the human.
func TestAQuestionTheLeadHoldsIsNotWaitingOnYou(t *testing.T) {
	in := AttentionInput{PendingAsks: map[string]agentask.PendingAsk{
		"block:held":      {AskId: "1", Ts: 10, Questions: question("held by the lead?"), Owner: agentask.AskOwner_Lead},
		"block:forwarded": {AskId: "2", Ts: 20, Questions: question("forwarded to you?"), Owner: agentask.AskOwner_User},
		"block:plain":     {AskId: "3", Ts: 30, Questions: question("a session's own question?")},
	}}
	var keys []string
	for _, it := range BuildAttention(in) {
		keys = append(keys, it.Key)
	}
	if strings.Join(keys, ",") != "ask:block:forwarded,ask:block:plain" {
		t.Fatalf("attention keys = %v, want the forwarded and the plain ask only", keys)
	}
}

func TestAskRowFallsBackWhenThereIsNoQuestionText(t *testing.T) {
	for name, qs := range map[string][]baseds.AgentAskQuestion{
		"no questions at all": nil,
		"empty question":      question(""),
		"whitespace only":     question("   \n\t "),
	} {
		if got := askRowText(qs); got != askFallbackText {
			t.Fatalf("%s: want the degraded reading %q, got %q", name, askFallbackText, got)
		}
	}
}
