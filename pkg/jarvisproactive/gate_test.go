// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvisproactive

import (
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/jarvisembed"
)

func chunk(id, coll, heading, snippet string, score float32) jarvisembed.ScoredChunk {
	return jarvisembed.ScoredChunk{NodeID: id, Collection: coll, SectionHeading: heading, Snippet: snippet, Score: score}
}

func TestPrefilterThresholdAndCap(t *testing.T) {
	in := []jarvisembed.ScoredChunk{
		chunk("a", "decisions", "Rate limiting", "drop-oldest on overflow", 0.95),
		chunk("b", "tasks", "Channel scaling", "shard by workspace", 0.83),
		chunk("c", "memory", "Note", "irrelevant", 0.10), // below threshold, dropped
	}
	got := prefilter(in, "")
	if len(got) != 2 {
		t.Fatalf("want 2 above-threshold candidates, got %d", len(got))
	}
	if got[0].NodeID != "a" || got[0].SourceType != "decision" {
		t.Fatalf("first candidate mapping wrong: %+v", got[0])
	}
	if got[1].SourceType != "dossier" {
		t.Fatalf("tasks collection should map to dossier, got %q", got[1].SourceType)
	}
}

func TestPrefilterSelfExclusion(t *testing.T) {
	in := []jarvisembed.ScoredChunk{
		chunk("own-dossier", "tasks", "This run", "the run's own dossier", 0.99),
		chunk("other", "decisions", "Prior", "prior decision", 0.90),
	}
	got := prefilter(in, "own-dossier")
	if len(got) != 1 || got[0].NodeID != "other" {
		t.Fatalf("self node must be excluded, got %+v", got)
	}
}

func TestBuildJudgePromptContainsGoalCandidatesAndGuardrail(t *testing.T) {
	p := buildJudgePrompt("fix the rate limit bug", []candidate{
		{NodeID: "a", SourceType: "decision", Title: "Rate limiting", Snippet: "drop-oldest"},
	})
	for _, want := range []string{"fix the rate limit bug", "Rate limiting", "drop-oldest", "none"} {
		if !strings.Contains(p, want) {
			t.Fatalf("prompt missing %q:\n%s", want, p)
		}
	}
}

func TestParseJudgeReply(t *testing.T) {
	cases := []struct {
		reply string
		n     int
		want  int
	}{
		{"1", 3, 0},
		{"  2  ", 3, 1},
		{"best: 3", 3, 2},
		{"none", 3, -1},
		{"", 3, -1},
		{"4", 3, -1}, // out of range
		{"0", 3, -1}, // 1-based; 0 is invalid
		{"garbage", 3, -1},
	}
	for _, c := range cases {
		if got := parseJudgeReply(c.reply, c.n); got != c.want {
			t.Fatalf("parseJudgeReply(%q,%d) = %d, want %d", c.reply, c.n, got, c.want)
		}
	}
}
