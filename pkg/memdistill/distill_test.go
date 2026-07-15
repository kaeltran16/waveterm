// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package memdistill

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestBatchPromptStartsWithSentinel(t *testing.T) {
	if !strings.HasPrefix(batchDistillPrompt, DistillSentinel) {
		t.Fatalf("batchDistillPrompt must start with DistillSentinel so the Sessions filter matches")
	}
}

func TestReadTail_ReturnsLastBytes(t *testing.T) {
	path := filepath.Join(t.TempDir(), "t.jsonl")
	if err := os.WriteFile(path, []byte("0123456789"), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := readTail(path, 4); got != "6789" {
		t.Errorf("readTail = %q, want %q", got, "6789")
	}
	if got := readTail(path, 100); got != "0123456789" {
		t.Errorf("readTail (over-size) = %q, want whole file", got)
	}
}

func TestBuildCorpus_CapsPerSessionAndPicksModel(t *testing.T) {
	dir := t.TempDir()
	var sessions []pendingSession
	// two sessions, each larger than half the budget, so each gets truncated to budget/2
	big := strings.Repeat("x", combinedBudget)
	for i, name := range []string{"a.jsonl", "b.jsonl"} {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, []byte(big), 0o644); err != nil {
			t.Fatal(err)
		}
		sessions = append(sessions, pendingSession{TranscriptPath: p, EnqueuedAt: "2026-07-15T00:0" + string(rune('0'+i)) + ":00Z"})
	}
	corpus, model := buildCorpus(sessions)
	if len(corpus) > combinedBudget+512 { // +separators headroom
		t.Errorf("corpus length %d exceeds budget", len(corpus))
	}
	if model != "claude-sonnet-5" {
		t.Errorf("model = %q, want claude-sonnet-5 for a budget-filling corpus", model)
	}
}

func TestParseDistillOutput_TolerantAndMapped(t *testing.T) {
	raw := "here is your json:\n{\"candidates\":[{\"type\":\"feedback\",\"body\":\"b\",\"iscorrection\":true}],\"references\":[\"slug-1\"]}\nthanks"
	cands, refs, ok := parseDistillOutput(raw)
	if !ok || len(cands) != 1 || !cands[0].IsCorrection || cands[0].Body != "b" {
		t.Fatalf("parse failed: ok=%v cands=%+v", ok, cands)
	}
	if len(refs) != 1 || refs[0] != "slug-1" {
		t.Errorf("refs = %+v, want [slug-1]", refs)
	}
}

func TestParseDistillOutput_NoJSON(t *testing.T) {
	if _, _, ok := parseDistillOutput("no json here"); ok {
		t.Errorf("expected ok=false when there is no JSON object")
	}
}
