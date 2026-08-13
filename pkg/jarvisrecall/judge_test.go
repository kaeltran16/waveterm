// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvisrecall

import (
	"context"
	"errors"
	"strings"
	"testing"
)

func TestParseJudgeReply(t *testing.T) {
	cases := []struct {
		reply string
		n     int
		want  []int // nil = keep-all (ambiguous)
	}{
		{"2, 4", 5, []int{1, 3}},
		{"none", 5, []int{}},
		{"", 5, []int{}},
		{"3", 2, nil},            // out of range: ambiguous, keep all
		{"keep them all", 5, nil}, // no digits and not "none": a lost judge keeps everything
		{"1, 1", 5, []int{0}},     // dedupe
		{"all", 3, nil},
	}
	for _, c := range cases {
		got := parseJudgeReply(c.reply, c.n)
		if len(got) != len(c.want) {
			t.Fatalf("parseJudgeReply(%q,%d) = %v, want %v", c.reply, c.n, got, c.want)
		}
		for i := range got {
			if got[i] != c.want[i] {
				t.Fatalf("parseJudgeReply(%q,%d) = %v, want %v", c.reply, c.n, got, c.want)
			}
		}
	}
}

func mkCands(n int) []candidate {
	out := make([]candidate, n)
	for i := range out {
		out[i] = candidate{sourceType: "memory", title: "c" + string(rune('a'+i)), navTarget: "memory:c" + string(rune('a'+i))}
	}
	return out
}

func TestJudgeCandidatesKeepsOnlyKept(t *testing.T) {
	restore := SetJudgeForTest(func(_ context.Context, _, _ string) (string, error) { return "2, 4", nil })
	defer restore()
	got := judgeCandidates(context.Background(), "/p", "q", mkCands(5))
	if len(got) != 2 || got[0].title != "cb" || got[1].title != "cd" {
		t.Fatalf("got=%+v want candidates 2 and 4 kept", got)
	}
}

func TestJudgeCandidatesNoneYieldsEmpty(t *testing.T) {
	restore := SetJudgeForTest(func(_ context.Context, _, _ string) (string, error) { return "none", nil })
	defer restore()
	got := judgeCandidates(context.Background(), "/p", "q", mkCands(3))
	if len(got) != 0 {
		t.Fatalf("got=%+v want none kept", got)
	}
}

func TestJudgeCandidatesKeepsAllOnError(t *testing.T) {
	restore := SetJudgeForTest(func(_ context.Context, _, _ string) (string, error) { return "", errors.New("model down") })
	defer restore()
	got := judgeCandidates(context.Background(), "/p", "q", mkCands(4))
	if len(got) != 4 {
		t.Fatalf("got=%+v want all kept on judge failure", got)
	}
}

func TestJudgeCandidatesKeepsAllOnGarbageReply(t *testing.T) {
	restore := SetJudgeForTest(func(_ context.Context, _, _ string) (string, error) { return "yep keep everything", nil })
	defer restore()
	got := judgeCandidates(context.Background(), "/p", "q", mkCands(3))
	if len(got) != 3 {
		t.Fatalf("got=%+v want all kept on unparseable reply", got)
	}
}

func TestJudgeCandidatesSkipsSingleton(t *testing.T) {
	// One candidate is already deterministic; the judge call is pure cost.
	called := false
	restore := SetJudgeForTest(func(_ context.Context, _, _ string) (string, error) { called = true; return "none", nil })
	defer restore()
	got := judgeCandidates(context.Background(), "/p", "q", mkCands(1))
	if len(got) != 1 || called {
		t.Fatalf("got=%+v called=%v want the single candidate untouched", got, called)
	}
}

func TestBuildJudgePromptNumbersCandidates(t *testing.T) {
	p := buildJudgePrompt("did the bridge ship?", mkCands(2))
	if p == "" || !hasSubstr(p, "1. [memory] ca") || !hasSubstr(p, "2. [memory] cb") || !hasSubstr(p, "Question: did the bridge ship?") {
		t.Fatalf("prompt malformed:\n%s", p)
	}
}

// hasSubstr is the string-contains assertion helper for judge prompt checks. (The package's
// existing containsStr helper takes a string slice — different shape.)
func hasSubstr(haystack, needle string) bool {
	return strings.Contains(haystack, needle)
}
