// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvisrecall

import (
	"testing"

	"github.com/wavetermdev/waveterm/pkg/memvault"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

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
	all := wshrpc.CommandJarvisConverseData{ScopeMode: "all"}
	if !inScope(all, "run", `C:\src\waveterm`) {
		t.Error("all scope should include everything")
	}
	// separator normalization: a forward-slash config path matches a backslash Run.ProjectPath (same root).
	proj := wshrpc.CommandJarvisConverseData{ScopeMode: "project", ProjectPath: "C:/src/waveterm"}
	if !inScope(proj, "run", `C:\src\waveterm`) {
		t.Error("project scope should match normalized paths")
	}
	if inScope(proj, "run", "/src/other") {
		t.Error("project scope should exclude a different project")
	}
}
