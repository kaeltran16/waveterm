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

// The memory collection outnumbers tasks and decisions by more than an order of magnitude on a real
// vault (measured 406 / 14 / 4), so taking candidates in raw score order lets memory's depth fill
// every shortlist slot and the model judge never sees a dossier or a decision. Emitting round-robin
// across collections is what makes the per-collection query in evaluate actually reach the judge.
func TestPrefilterRoundRobinsAcrossCollections(t *testing.T) {
	in := []jarvisembed.ScoredChunk{
		chunk("mem1", "memory", "Note 1", "cache note one", 0.99),
		chunk("mem2", "memory", "Note 2", "cache note two", 0.98),
		chunk("mem3", "memory", "Note 3", "cache note three", 0.97),
		chunk("mem4", "memory", "Note 4", "cache note four", 0.96),
		chunk("mem5", "memory", "Note 5", "cache note five", 0.95),
		chunk("mem6", "memory", "Note 6", "cache note six", 0.94),
		chunk("dos1", "tasks", "Cache dossier", "the prior cache task", 0.72),
		chunk("dec1", "decisions", "Cache decision", "the prior cache decision", 0.71),
	}
	got := prefilter(in, "")
	if len(got) != shortlistMax {
		t.Fatalf("want a full shortlist of %d, got %d: %+v", shortlistMax, len(got), got)
	}
	types := map[string]bool{}
	for _, c := range got {
		types[c.SourceType] = true
	}
	for _, want := range []string{"dossier", "decision"} {
		if !types[want] {
			t.Errorf("%q never reached the shortlist; got %v", want, shortlistFingerprint(got))
		}
	}
}

// shortlistFingerprint renders a shortlist compactly for failure messages.
func shortlistFingerprint(cands []candidate) []string {
	out := make([]string, 0, len(cands))
	for _, c := range cands {
		out = append(out, c.SourceType+":"+c.NodeID)
	}
	return out
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
