// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvisrecall

import (
	"strconv"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/memvault"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func TestAssembleCandidatesPinsAttached(t *testing.T) {
	pinned := []candidate{{navTarget: "run:p1"}, {navTarget: "run:p2"}}
	scoped := make([]candidate, 20)
	for i := range scoped {
		scoped[i] = candidate{navTarget: "run:s" + strconv.Itoa(i)}
	}
	out := assembleCandidates(pinned, scoped, maxCandidates)
	if len(out) != maxCandidates {
		t.Fatalf("len = %d, want %d", len(out), maxCandidates)
	}
	if out[0].navTarget != "run:p1" || out[1].navTarget != "run:p2" {
		t.Fatalf("pinned not first: %v", out[0].navTarget)
	}
}

func TestAssembleCandidatesKeepsAllPinnedBeyondMax(t *testing.T) {
	pinned := make([]candidate, maxCandidates+3)
	for i := range pinned {
		pinned[i] = candidate{navTarget: "run:p" + strconv.Itoa(i)}
	}
	out := assembleCandidates(pinned, nil, maxCandidates)
	if len(out) != maxCandidates+3 {
		t.Fatalf("pinned truncated: len = %d, want %d", len(out), maxCandidates+3)
	}
}

func TestAssembleCandidatesDedupesByNavTarget(t *testing.T) {
	pinned := []candidate{{navTarget: "run:x"}}
	scoped := []candidate{{navTarget: "run:x"}, {navTarget: "run:y"}}
	out := assembleCandidates(pinned, scoped, maxCandidates)
	if len(out) != 2 {
		t.Fatalf("expected dedupe to 2, got %d", len(out))
	}
}

func TestPriorContextCapsAndFormats(t *testing.T) {
	if priorContext(nil, maxContextTurns) != "" {
		t.Fatalf("empty turns should yield empty context")
	}
	turns := make([]waveobj.JarvisConvoTurn, 0, 10)
	for i := 0; i < 10; i++ {
		turns = append(turns, waveobj.JarvisConvoTurn{Role: "user", Text: "q" + strconv.Itoa(i)})
	}
	got := priorContext(turns, 3)
	if strings.Contains(got, "q6") || !strings.Contains(got, "q7") || !strings.Contains(got, "q9") {
		t.Fatalf("expected only the last 3 turns (q7..q9), got:\n%s", got)
	}
}
func TestSelectTerminal(t *testing.T) {
	cases := []struct {
		cards, cites int
		want         string
	}{
		{0, 0, "notfound"},
		{3, 0, "weak"},
		{3, 2, "answered"},
		{1, 1, "answered"},
	}
	for _, c := range cases {
		if got := selectTerminal(c.cards, c.cites); got != c.want {
			t.Errorf("selectTerminal(%d,%d)=%q want %q", c.cards, c.cites, got, c.want)
		}
	}
}

func TestCountCitations(t *testing.T) {
	// distinct in-range refs only; [4] is out of range (2 cards), [0] invalid
	if got := countCitations("see [1] and [2] and again [1] plus [4] and [0]", 2); got != 2 {
		t.Errorf("countCitations=%d want 2", got)
	}
	if got := countCitations("no citations here", 3); got != 0 {
		t.Errorf("countCitations=%d want 0", got)
	}
}

func TestProjectLabel(t *testing.T) {
	if got := projectLabel(`C:\Users\me\IdeaProjects\waveterm`); got != "waveterm" {
		t.Errorf("projectLabel(win)=%q want waveterm", got)
	}
	if got := projectLabel("/home/me/src/waveterm/"); got != "waveterm" {
		t.Errorf("projectLabel(posix)=%q want waveterm", got)
	}
	if got := projectLabel(""); got != "" {
		t.Errorf("projectLabel(empty)=%q want empty", got)
	}
}

func TestRunCandidate(t *testing.T) {
	r := &waveobj.Run{OID: "11111111-1111-1111-1111-111111111111", Goal: "shard fan-out", ProjectPath: `C:\src\waveterm`, Status: "done", CreatedTs: 1000, CompletedTs: 2000}
	c := runCandidate(r)
	if c.sourceType != "run" || c.title != "shard fan-out" || c.project != "waveterm" {
		t.Errorf("runCandidate fields wrong: %+v", c)
	}
	if c.ts != 2000 {
		t.Errorf("runCandidate ts=%d want 2000 (CompletedTs)", c.ts)
	}
	if c.navTarget != "run:11111111-1111-1111-1111-111111111111" {
		t.Errorf("runCandidate navTarget=%q", c.navTarget)
	}
	if c.freshness != "fresh" {
		t.Errorf("runCandidate freshness=%q want fresh", c.freshness)
	}
}

func TestMemoryFreshness(t *testing.T) {
	if memoryFreshness(memvault.Note{}) != "fresh" {
		t.Error("clean note should be fresh")
	}
	if memoryFreshness(memvault.Note{GardenerFlag: "stale"}) != "stale" {
		t.Error("gardener-flagged note should be stale")
	}
	if memoryFreshness(memvault.Note{SupersededBy: "newer-note"}) != "stale" {
		t.Error("superseded note should be stale")
	}
}

func TestBuildCards(t *testing.T) {
	cands := []candidate{
		{sourceType: "run", title: "a", project: "p", ts: 500, freshness: "fresh", navTarget: "run:x"},
		{sourceType: "memory", title: "b", project: "q", ts: 900, freshness: "stale", navTarget: "memory:b"},
	}
	cards := buildCards(cands, 1000)
	if len(cards) != 2 || cards[0].N != 1 || cards[1].N != 2 {
		t.Fatalf("buildCards N wrong: %+v", cards)
	}
	if cards[0].AgeMs != 500 || cards[1].AgeMs != 100 {
		t.Errorf("buildCards AgeMs wrong: %+v", cards)
	}
	if cards[1].SourceType != "memory" || cards[1].Freshness != "stale" {
		t.Errorf("buildCards mapping wrong: %+v", cards[1])
	}
}

func TestInScope(t *testing.T) {
	all := ScopeArgs{Mode: "all"}
	if !inScope(all, "run", `C:\src\waveterm`) {
		t.Error("all scope should include everything")
	}
	// separator normalization: a forward-slash config path matches a backslash Run.ProjectPath (same root).
	proj := ScopeArgs{Mode: "project", ProjectPath: "C:/src/waveterm"}
	if !inScope(proj, "run", `C:\src\waveterm`) {
		t.Error("project scope should match normalized paths")
	}
	if inScope(proj, "run", "/src/other") {
		t.Error("project scope should exclude a different project")
	}
}
