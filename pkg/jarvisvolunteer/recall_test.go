// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvisvolunteer

import (
	"context"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/jarvisproactive"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func runWithSuggestion(oid string, createdTs int64, sug jarvisproactive.ProactiveSuggestion) *waveobj.Run {
	return &waveobj.Run{
		OID:       oid,
		Goal:      "migrate the auth module",
		CreatedTs: createdTs,
		Meta:      waveobj.MetaMapType{jarvisproactive.MetaKeyProactive: sug},
	}
}

func recallProducer(run *waveobj.Run) *RecallProducer {
	return &RecallProducer{loadRun: func(context.Context, string, string) (*waveobj.Run, error) {
		return run, nil
	}}
}

func TestRecallEmitsCandidateForHit(t *testing.T) {
	run := runWithSuggestion("run-1", 1700, jarvisproactive.ProactiveSuggestion{
		Status:     jarvisproactive.StatusHit,
		NodeID:     "dec-abc123",
		SourceType: "decision",
		Title:      "Drop-oldest on overflow",
		Snippet:    "we chose drop-oldest because backpressure stalled the writer",
	})
	p := recallProducer(run)
	p.parentRecord = func(context.Context, string) string { return "task-owner" }
	got, err := p.Candidates(context.Background(), &Trigger{Kind: TriggerRunCreated, ChannelID: "c1", RunID: "run-1"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("want 1 candidate, got %d", len(got))
	}
	c := got[0]
	if c.Class != ClassRecall {
		t.Fatalf("class = %q, want %q", c.Class, ClassRecall)
	}
	if c.At != 1700 {
		t.Fatalf("At = %d, want the run's CreatedTs 1700 - At must come from the fact", c.At)
	}
	if c.ID != "recall:run-1:dec-abc123" {
		t.Fatalf("ID = %q, want a stable run+node key", c.ID)
	}
	if c.SourceType != "decision" {
		t.Fatalf("SourceType = %q, want decision", c.SourceType)
	}
	// a decision has no surface of its own: it addresses its parent record and names itself as the anchor
	if c.SourceRef != "task:task-owner" {
		t.Fatalf("SourceRef = %q, want the parent record's route", c.SourceRef)
	}
	if c.Anchor != "dec-abc123" {
		t.Fatalf("Anchor = %q, want the decision id so decisionlog can scroll to the card", c.Anchor)
	}
}

func TestRecallRoutesEachSourceType(t *testing.T) {
	cases := []struct {
		sourceType string
		nodeID     string
		wantRef    string
	}{
		{"dossier", "task-a", "task:task-a"},
		{"memory", "mem-1", "memnote:mem-1"},
		{"decision", "dec-1", ""}, // no parent record resolvable in a stub; the ref is dropped, not faked
		{"mystery", "x", ""},
	}
	for _, tc := range cases {
		run := runWithSuggestion("run-r", 1700, jarvisproactive.ProactiveSuggestion{
			Status: jarvisproactive.StatusHit, NodeID: tc.nodeID, SourceType: tc.sourceType, Title: "t",
		})
		p := recallProducer(run)
		p.parentRecord = func(context.Context, string) string { return "" }
		got, err := p.Candidates(context.Background(), &Trigger{Kind: TriggerRunCreated, RunID: "run-r"})
		if err != nil {
			t.Fatalf("%s: unexpected error: %v", tc.sourceType, err)
		}
		if len(got) != 1 {
			t.Fatalf("%s: want 1 candidate, got %d", tc.sourceType, len(got))
		}
		if got[0].SourceRef != tc.wantRef {
			t.Fatalf("%s: SourceRef = %q, want %q", tc.sourceType, got[0].SourceRef, tc.wantRef)
		}
	}
}

func TestRecallResolvesDecisionToItsParentRecord(t *testing.T) {
	run := runWithSuggestion("run-d", 1700, jarvisproactive.ProactiveSuggestion{
		Status: jarvisproactive.StatusHit, NodeID: "dec-abc123", SourceType: "decision", Title: "t",
	})
	p := recallProducer(run)
	p.parentRecord = func(context.Context, string) string { return "task-parent" }
	got, _ := p.Candidates(context.Background(), &Trigger{Kind: TriggerRunCreated, RunID: "run-d"})
	if len(got) != 1 {
		t.Fatalf("want 1 candidate, got %d", len(got))
	}
	if got[0].SourceRef != "task:task-parent" {
		t.Fatalf("SourceRef = %q, want the parent record's route", got[0].SourceRef)
	}
	if got[0].Anchor != "dec-abc123" {
		t.Fatalf("Anchor = %q, want the decision id", got[0].Anchor)
	}
}

func TestRecallSkipsSentinel(t *testing.T) {
	run := runWithSuggestion("run-2", 1700, jarvisproactive.ProactiveSuggestion{
		Status: jarvisproactive.StatusNone,
		Reason: jarvisproactive.ReasonNoCandidates,
	})
	got, err := recallProducer(run).
		Candidates(context.Background(), &Trigger{Kind: TriggerRunCreated, ChannelID: "c1", RunID: "run-2"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("a persisted none-sentinel must yield nothing, got %+v", got)
	}
}

func TestRecallSkipsUndatedRun(t *testing.T) {
	run := runWithSuggestion("run-3", 0, jarvisproactive.ProactiveSuggestion{
		Status: jarvisproactive.StatusHit, NodeID: "n1", SourceType: "memory", Title: "note",
	})
	got, _ := recallProducer(run).
		Candidates(context.Background(), &Trigger{Kind: TriggerRunCreated, ChannelID: "c1", RunID: "run-3"})
	if len(got) != 0 {
		t.Fatalf("a run with no CreatedTs cannot be stamped from the fact and must be skipped, got %+v", got)
	}
}

func TestRecallIgnoresTriggerWithNoRun(t *testing.T) {
	got, err := recallProducer(nil).Candidates(context.Background(), &Trigger{Kind: TriggerSweep})
	if err != nil || len(got) != 0 {
		t.Fatalf("the sweep carries no run, so recall must contribute nothing: %+v %v", got, err)
	}
}
