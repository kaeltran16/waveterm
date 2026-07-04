// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvis

import (
	"testing"

	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func aQuestion() baseds.AgentAskQuestion {
	return baseds.AgentAskQuestion{
		Question: "Which migration?",
		Options:  []baseds.AgentAskOption{{Label: "Use existing"}, {Label: "Create new"}},
	}
}

func TestBuildClassifyPrompt_Contents(t *testing.T) {
	c := &waveobj.Channel{Name: "payments-api"}
	p := BuildClassifyPrompt(aQuestion(), "harden webhooks", c, "")
	for _, want := range []string{"Which migration?", "0", "Use existing", "1", "Create new", "harden webhooks", "JSON"} {
		if !contains(p, want) {
			t.Fatalf("prompt missing %q\n---\n%s", want, p)
		}
	}
}

func TestBuildClassifyPrompt_IncludesPrinciples(t *testing.T) {
	c := &waveobj.Channel{Name: "payments-api"}
	p := BuildClassifyPrompt(aQuestion(), "harden webhooks", c, "prefer the clean fix")
	if !contains(p, "prefer the clean fix") {
		t.Fatalf("prompt missing principles\n---\n%s", p)
	}
}

func TestBuildClassifyPrompt_OmitsEmptyPrinciples(t *testing.T) {
	c := &waveobj.Channel{Name: "payments-api"}
	p := BuildClassifyPrompt(aQuestion(), "harden webhooks", c, "")
	if contains(p, "principles") {
		t.Fatalf("empty principles should add no principles text\n---\n%s", p)
	}
}

func TestParseDecision_ValidAnswer(t *testing.T) {
	d := ParseDecision(`{"action":"answer","optionindex":0,"reason":"routine"}`)
	if d.Action != "answer" || d.OptionIndex == nil || *d.OptionIndex != 0 {
		t.Fatalf("want answer/0, got %+v", d)
	}
}

func TestParseDecision_FailsSafe(t *testing.T) {
	cases := []string{
		``,                                      // empty
		`not json at all`,                       // prose
		`{"action":"answer"}`,                    // missing optionindex
		`{"optionindex":0,"reason":"x"}`,         // missing action
		`{"action":"answer","optionindex":"a"}`,  // non-numeric index
		`{"action":"maybe","optionindex":0}`,     // unknown action
	}
	for _, in := range cases {
		if d := ParseDecision(in); d.Action != "escalate" {
			t.Fatalf("want escalate for %q, got %+v", in, d)
		}
	}
}

func TestParseDecision_ProseWrappedJSON(t *testing.T) {
	// the model sometimes wraps JSON in prose; we extract the object
	d := ParseDecision("Sure!\n```json\n{\"action\":\"escalate\",\"reason\":\"ambiguous\"}\n```")
	if d.Action != "escalate" {
		t.Fatalf("want escalate, got %+v", d)
	}
}

func contains(s, sub string) bool { return len(sub) == 0 || (len(s) >= len(sub) && indexOf(s, sub) >= 0) }
func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}
