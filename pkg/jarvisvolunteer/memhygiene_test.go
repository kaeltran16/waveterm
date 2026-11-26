// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvisvolunteer

import (
	"context"
	"fmt"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/memhygiene"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

func hygieneProducer(ps []wshrpc.MemHygieneProject) *MemoryHygieneProducer {
	return &MemoryHygieneProducer{listProjects: func() ([]wshrpc.MemHygieneProject, error) { return ps, nil }}
}

func change(kind, status string) wshrpc.MemChange {
	return wshrpc.MemChange{Kind: kind, Status: status}
}

func TestMemoryHygieneWaitingAndProducerAgree(t *testing.T) {
	for _, tc := range []struct {
		name    string
		p       wshrpc.MemHygieneProject
		waiting int
	}{
		{"split", wshrpc.MemHygieneProject{Changes: []wshrpc.MemChange{change("move-here", "open"), change("copy-here", "kept"), change("settings", "open")}}, 1},
		{"kept sharing", wshrpc.MemHygieneProject{Changes: []wshrpc.MemChange{change("move-here", "open"), change("settings", "kept")}}, 0},
		{"cleanup", wshrpc.MemHygieneProject{Changes: []wshrpc.MemChange{change("remove-shared", "open"), change("remove-shared", "open"), change("remove-shared", "conflict")}}, 1},
		{"cleanup changed on disk", wshrpc.MemHygieneProject{Changes: []wshrpc.MemChange{change("remove-shared", "conflict"), change("remove-shared", "kept")}}, 0},
		{"doc", wshrpc.MemHygieneProject{Changes: []wshrpc.MemChange{change("move-to-doc", "open"), change("move-to-doc", "open"), change("move-to-doc", "applied")}}, 2},
		{"failed", wshrpc.MemHygieneProject{LastError: "Check interrupted by a restart"}, 1},
		{"only routine conflicts left", wshrpc.MemHygieneProject{Changes: []wshrpc.MemChange{change("trim", "conflict"), change("delete", "conflict"), change("merge", "applied")}}, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			tc.p.Project, tc.p.CheckedAt = "waveterm", 1000
			if got := memhygiene.Waiting(tc.p); got != tc.waiting {
				t.Fatalf("Waiting = %d, want %d", got, tc.waiting)
			}
			got, err := hygieneProducer([]wshrpc.MemHygieneProject{tc.p}).Candidates(context.Background(), &Trigger{Kind: TriggerSweep})
			if err != nil {
				t.Fatal(err)
			}
			if tc.waiting == 0 {
				if len(got) != 0 {
					t.Fatalf("nothing waits, but the volunteer emitted %+v", got)
				}
				return
			}
			if len(got) != 1 || got[0].Title != fmt.Sprintf("waveterm's memory has %d waiting for you", tc.waiting) {
				t.Fatalf("candidates = %+v, want one titled with %d", got, tc.waiting)
			}
		})
	}
}

func TestMemoryHygieneCandidate(t *testing.T) {
	ps := []wshrpc.MemHygieneProject{{
		Project:   "waveterm",
		CheckedAt: 1000,
		LastError: "Check interrupted by a restart",
		Index:     wshrpc.MemIndexStats{Exists: true, Lines: 6},
		Changes:   []wshrpc.MemChange{change("move-to-doc", "open"), change("settings", "open"), change("move-to-doc", "open")},
	}}
	got, err := hygieneProducer(ps).Candidates(context.Background(), &Trigger{Kind: TriggerSweep})
	if err != nil {
		t.Fatal(err)
	}
	want := Candidate{
		Class:      ClassMemoryHygiene,
		ID:         "memory-hygiene:waveterm:1000",
		At:         1000,
		Title:      "waveterm's memory has 4 waiting for you",
		Snippet:    "1 split, 2 doc moves, 1 failed check · MEMORY.md at 6 of 200 lines",
		SourceType: "memhygiene",
		SourceRef:  "memhygiene:waveterm",
	}
	if len(got) != 1 || got[0] != want {
		t.Fatalf("candidates = %+v, want %+v", got, want)
	}
}

func TestMemoryHygieneCandidateStampedFromCheck(t *testing.T) {
	ps := []wshrpc.MemHygieneProject{{Project: "waveterm", CheckedAt: 1000, Changes: []wshrpc.MemChange{change("move-to-doc", "open")}}}
	p := hygieneProducer(ps)
	first, _ := p.Candidates(context.Background(), &Trigger{Kind: TriggerSweep})
	second, _ := p.Candidates(context.Background(), &Trigger{Kind: TriggerSweep})
	if len(first) != 1 || len(second) != 1 {
		t.Fatalf("want one candidate per call, got %d and %d", len(first), len(second))
	}
	if first[0].ID != second[0].ID || first[0].At != second[0].At {
		t.Fatalf("unchanged state must re-emit the same pair: %s@%d vs %s@%d", first[0].ID, first[0].At, second[0].ID, second[0].At)
	}
	if first[0].At != 1000 {
		t.Fatalf("At = %d, want the check's time", first[0].At)
	}
}

func TestSweepIncludesMemoryHygieneProducer(t *testing.T) {
	for _, p := range producersFor(&Trigger{Kind: TriggerSweep}) {
		if p.Name() == ClassMemoryHygiene {
			return
		}
	}
	t.Fatal("sweep producers must include memory hygiene")
}
