// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvisvolunteer

import (
	"context"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/jarvisattrib"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func connProducer(edges map[string][]jarvisattrib.AttributedEdge, run *waveobj.Run, title string) *ConnectionProducer {
	return &ConnectionProducer{
		allEdges:     func(context.Context) (map[string][]jarvisattrib.AttributedEdge, error) { return edges, nil },
		loadRun:      func(context.Context, string, string) (*waveobj.Run, error) { return run, nil },
		dossierTitle: func(context.Context, string) string { return title },
	}
}

func TestConnectionEmitsForEdgeOnThisRun(t *testing.T) {
	edges := map[string][]jarvisattrib.AttributedEdge{
		"task-tauri": {{
			DossierID: "task-tauri", RunORef: "run:run-9", Layers: []int{2},
			Provenance: "ticket-match", Confidence: 0.8, State: jarvisattrib.StateConfirmed,
		}},
	}
	run := &waveobj.Run{OID: "run-9", Goal: "port the titlebar", CompletedTs: 2500}
	got, err := connProducer(edges, run, "Tauri migration").
		Candidates(context.Background(), &Trigger{Kind: TriggerRunRest, ChannelID: "c1", RunID: "run-9"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("want 1 candidate, got %d", len(got))
	}
	c := got[0]
	if c.Class != ClassConnection {
		t.Fatalf("class = %q, want %q", c.Class, ClassConnection)
	}
	if c.At != 2500 {
		t.Fatalf("At = %d, want the run's CompletedTs 2500 - At must come from the fact", c.At)
	}
	if c.ID != "connection:task-tauri:run:run-9" {
		t.Fatalf("ID = %q, want a stable dossier+run key", c.ID)
	}
	if c.SourceRef != "task:task-tauri" {
		t.Fatalf("SourceRef = %q, want the dossier route", c.SourceRef)
	}
	if c.Title != "Tauri migration" {
		t.Fatalf("Title = %q, want the dossier's objective", c.Title)
	}
}

func TestConnectionIgnoresEdgesForOtherRuns(t *testing.T) {
	edges := map[string][]jarvisattrib.AttributedEdge{
		"task-other": {{DossierID: "task-other", RunORef: "run:run-1", State: jarvisattrib.StateConfirmed}},
	}
	run := &waveobj.Run{OID: "run-9", CompletedTs: 2500}
	got, _ := connProducer(edges, run, "Other").
		Candidates(context.Background(), &Trigger{Kind: TriggerRunRest, ChannelID: "c1", RunID: "run-9"})
	if len(got) != 0 {
		t.Fatalf("an edge on a different run must not fire, got %+v", got)
	}
}

func TestConnectionSkipsDetachedEdge(t *testing.T) {
	edges := map[string][]jarvisattrib.AttributedEdge{
		"task-x": {{DossierID: "task-x", RunORef: "run:run-9", State: jarvisattrib.StateDetached}},
	}
	run := &waveobj.Run{OID: "run-9", CompletedTs: 2500}
	got, _ := connProducer(edges, run, "X").
		Candidates(context.Background(), &Trigger{Kind: TriggerRunRest, ChannelID: "c1", RunID: "run-9"})
	if len(got) != 0 {
		t.Fatalf("a human-rejected edge is a correction and must never be volunteered, got %+v", got)
	}
}

func TestConnectionCarriesWeakBucket(t *testing.T) {
	edges := map[string][]jarvisattrib.AttributedEdge{
		"task-y": {{
			DossierID: "task-y", RunORef: "run:run-9", Layers: []int{4},
			Confidence: 0.2, State: jarvisattrib.StateInforming,
		}},
	}
	run := &waveobj.Run{OID: "run-9", CompletedTs: 2500}
	got, _ := connProducer(edges, run, "Y").
		Candidates(context.Background(), &Trigger{Kind: TriggerRunRest, ChannelID: "c1", RunID: "run-9"})
	if len(got) != 1 {
		t.Fatalf("a weak edge is still eligible, got %d", len(got))
	}
	want := jarvisattrib.BucketFor([]int{4})
	if want == "" {
		t.Fatalf("layer 4 must map to a named confidence bucket")
	}
	if !strings.Contains(got[0].Snippet, want) {
		t.Fatalf("snippet %q must carry the confidence bucket %q so the utterance can hedge", got[0].Snippet, want)
	}
}

func TestConnectionSkipsUnsealedRun(t *testing.T) {
	edges := map[string][]jarvisattrib.AttributedEdge{
		"task-z": {{DossierID: "task-z", RunORef: "run:run-9", State: jarvisattrib.StateConfirmed}},
	}
	run := &waveobj.Run{OID: "run-9", CompletedTs: 0}
	got, _ := connProducer(edges, run, "Z").
		Candidates(context.Background(), &Trigger{Kind: TriggerRunRest, ChannelID: "c1", RunID: "run-9"})
	if len(got) != 0 {
		t.Fatalf("a run that has not sealed cannot be stamped from the fact, got %+v", got)
	}
}

// AllEdges returns a map, whose iteration order Go randomises. Two dossiers attributing the same run
// must therefore produce a deterministic shortlist, or the judge sees a different prompt each time.
func TestConnectionOrderIsDeterministic(t *testing.T) {
	edges := map[string][]jarvisattrib.AttributedEdge{
		"task-b": {{DossierID: "task-b", RunORef: "run:run-9", State: jarvisattrib.StateConfirmed}},
		"task-a": {{DossierID: "task-a", RunORef: "run:run-9", State: jarvisattrib.StateConfirmed}},
		"task-c": {{DossierID: "task-c", RunORef: "run:run-9", State: jarvisattrib.StateConfirmed}},
	}
	run := &waveobj.Run{OID: "run-9", CompletedTs: 2500}
	for i := 0; i < 20; i++ {
		got, _ := connProducer(edges, run, "T").
			Candidates(context.Background(), &Trigger{Kind: TriggerRunRest, RunID: "run-9"})
		if len(got) != 3 {
			t.Fatalf("want 3 candidates, got %d", len(got))
		}
		if got[0].ID != "connection:task-a:run:run-9" || got[2].ID != "connection:task-c:run:run-9" {
			t.Fatalf("candidate order must be stable across map iterations, got %s..%s", got[0].ID, got[2].ID)
		}
	}
}
