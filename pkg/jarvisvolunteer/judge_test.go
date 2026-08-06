// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvisvolunteer

import (
	"context"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/consult"
)

func TestParseJudgeReply(t *testing.T) {
	cases := []struct {
		reply string
		n     int
		want  int
	}{
		{"1", 3, 0},
		{"3", 3, 2},
		{" 2 \n", 3, 1},
		{"none", 3, -1},
		{"NONE", 3, -1},
		{"", 3, -1},
		{"4", 3, -1},    // out of range
		{"0", 3, -1},    // one-indexed, so 0 is invalid
		{"nope", 3, -1}, // unparseable
		{"2.", 3, 1},    // a trailing period is still a pick
		{"-1", 3, -1},
	}
	for _, c := range cases {
		if got := parseJudgeReply(c.reply, c.n); got != c.want {
			t.Fatalf("parseJudgeReply(%q, %d) = %d, want %d", c.reply, c.n, got, c.want)
		}
	}
}

func TestBuildJudgePromptListsEveryCandidate(t *testing.T) {
	cands := []Candidate{
		{Class: ClassRecall, Title: "Drop-oldest on overflow", Snippet: "backpressure stalled the writer"},
		{Class: ClassLooseEnd, Title: "Finish the migration", Snippet: "untouched for 21 days"},
	}
	p := buildJudgePrompt(cands)
	for _, want := range []string{"1.", "2.", "Drop-oldest on overflow", "Finish the migration", "none"} {
		if !strings.Contains(p, want) {
			t.Fatalf("prompt missing %q:\n%s", want, p)
		}
	}
}

// The real judge body must select the cheap tier. Overriding judgeRun (the process seam) rather than
// judge (the whole call) is what makes the tier observable — see the same pattern in jarvisproactive.
func TestJudgeUsesCheapTier(t *testing.T) {
	var gotArgs []string
	old := judgeRun
	judgeRun = func(_ context.Context, spec consult.RuntimeSpec, _, _ string, _ func(string)) (string, error) {
		gotArgs = spec.BaseArgs
		return "none", nil
	}
	defer func() { judgeRun = old }()

	if _, err := judge(context.Background(), "", "prompt"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	joined := strings.Join(gotArgs, " ")
	if !strings.Contains(joined, "--model "+consult.CheapModel) {
		t.Fatalf("judge must run on the cheap tier; args were %q", joined)
	}
}
