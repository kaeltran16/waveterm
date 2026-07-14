// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvis

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func TestResolveGatekeeperPrinciplesFreshPerAsk(t *testing.T) {
	dir := t.TempDir()
	withConfigHome(t, dir)
	path := filepath.Join(dir, globalProfileFileName)
	write := func(text string) {
		t.Helper()
		body := `{"principles":[{"id":"live","text":"` + text + `"}]}`
		if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	write("first")
	if got := RenderPrinciples(resolveGatekeeperPrinciples(&waveobj.Channel{})); got != "- first" {
		t.Fatalf("first ask principles = %q", got)
	}
	write("second")
	if got := RenderPrinciples(resolveGatekeeperPrinciples(&waveobj.Channel{})); got != "- second" {
		t.Fatalf("second ask should resolve current principles, got %q", got)
	}
}

func aQuestion() baseds.AgentAskQuestion {
	return baseds.AgentAskQuestion{
		Question: "Which migration?",
		Options:  []baseds.AgentAskOption{{Label: "Use existing"}, {Label: "Create new"}},
	}
}

func TestBuildClassifyPrompt_Contents(t *testing.T) {
	c := &waveobj.Channel{Name: "payments-api"}
	p := BuildClassifyPrompt(aQuestion(), "harden webhooks", c, nil)
	for _, want := range []string{"Which migration?", "0", "Use existing", "1", "Create new", "harden webhooks", "JSON"} {
		if !contains(p, want) {
			t.Fatalf("prompt missing %q\n---\n%s", want, p)
		}
	}
}

func TestBuildClassifyPrompt_IncludesPrinciples(t *testing.T) {
	c := &waveobj.Channel{Name: "payments-api"}
	p := BuildClassifyPrompt(aQuestion(), "harden webhooks", c, waveobj.PrincipleList{{ID: "clean", Text: "prefer the clean fix"}})
	if !contains(p, "prefer the clean fix") {
		t.Fatalf("prompt missing principles\n---\n%s", p)
	}
}

func TestBuildClassifyPromptRendersEffectivePrinciplesOnly(t *testing.T) {
	c := &waveobj.Channel{Name: "payments-api"}
	resolved, _ := ResolvePrinciples(
		waveobj.PrincipleList{{ID: "simple", Text: "Prefer simple."}, {ID: "measure", Text: "Measure first."}},
		&waveobj.PrinciplePatch{
			Replacements: map[string]string{"simple": "Prefer direct fixes."},
			Disabled:     []string{"measure"},
			Additions:    waveobj.PrincipleList{{ID: "project", Text: "Preserve compatibility."}},
		},
	)
	p := BuildClassifyPrompt(aQuestion(), "harden webhooks", c, resolved)
	if contains(p, "Prefer simple.") || contains(p, "Measure first.") {
		t.Fatalf("prompt contains superseded principles\n---\n%s", p)
	}
	if !contains(p, "- Prefer direct fixes.\n- Preserve compatibility.") {
		t.Fatalf("prompt does not render effective principles in order\n---\n%s", p)
	}
}

func TestBuildClassifyPrompt_OmitsEmptyPrinciples(t *testing.T) {
	c := &waveobj.Channel{Name: "payments-api"}
	p := BuildClassifyPrompt(aQuestion(), "harden webhooks", c, nil)
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
		`{"action":"answer"}`,                   // missing optionindex
		`{"optionindex":0,"reason":"x"}`,        // missing action
		`{"action":"answer","optionindex":"a"}`, // non-numeric index
		`{"action":"maybe","optionindex":0}`,    // unknown action
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

func contains(s, sub string) bool {
	return len(sub) == 0 || (len(s) >= len(sub) && indexOf(s, sub) >= 0)
}
func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}
