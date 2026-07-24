// pkg/jarvisattrib/extract_test.go
package jarvisattrib

import (
	"testing"

	"github.com/wavetermdev/waveterm/pkg/jarvisdossier"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func TestLayer2MatchesTicket(t *testing.T) {
	d := &jarvisdossier.Dossier{ID: "task-1", Ticket: "PROJ-142"}

	// hit via Run.Goal
	e, ok := extractLayer2(d, &waveobj.Run{OID: "r1", Goal: "implement PROJ-142 pkce"}, "", nil)
	if !ok || e.RunORef != "run:r1" || e.Confidence != weightLayer2 || !containsLayer(e.Layers, 2) {
		t.Fatalf("goal match: %+v ok=%v", e, ok)
	}
	if e.Provenance != provTicket || e.State != StateInforming {
		t.Fatalf("goal match provenance/state: %+v", e)
	}

	// hit via commit subject
	if _, ok := extractLayer2(d, &waveobj.Run{OID: "r2"}, "", []string{"fix proj-142 rotation"}); !ok {
		t.Fatal("commit-subject match (case-insensitive) should hit")
	}
	// hit via channel name
	if _, ok := extractLayer2(d, &waveobj.Run{OID: "r3"}, "PROJ-142 oauth work", nil); !ok {
		t.Fatal("channel-name match should hit")
	}
	// no ticket on dossier → never hits
	if _, ok := extractLayer2(&jarvisdossier.Dossier{ID: "t"}, &waveobj.Run{OID: "r4", Goal: "PROJ-142"}, "", nil); ok {
		t.Fatal("ticketless dossier must not match")
	}
	// no match
	if _, ok := extractLayer2(d, &waveobj.Run{OID: "r5", Goal: "unrelated"}, "misc", []string{"chore"}); ok {
		t.Fatal("should not match unrelated run")
	}
}

func TestLayer3AnchoredCorrelation(t *testing.T) {
	const now = int64(1_000_000_000_000)
	d := &jarvisdossier.Dossier{ID: "task-1", Ticket: "PROJ-142", Status: "active", Created: now - 5000}
	anchor := map[string]bool{"/repo/app": true}

	run := &waveobj.Run{OID: "r1", ProjectPath: "/repo/app", CreatedTs: now - 3000, CompletedTs: now - 1000}

	// in anchor repo + overlapping window + no contradicting ticket → weak edge
	e, ok := extractLayer3(d, run, anchor, nil, now)
	if !ok || e.Confidence != weightLayer3 || e.Provenance != provStructural || !containsLayer(e.Layers, 3) {
		t.Fatalf("expected weak structural edge, got %+v ok=%v", e, ok)
	}

	// wrong repo → no edge
	if _, ok := extractLayer3(d, &waveobj.Run{OID: "r2", ProjectPath: "/other", CreatedTs: now - 3000}, anchor, nil, now); ok {
		t.Fatal("run outside anchor repo must not correlate")
	}
	// no anchors at all → no edge
	if _, ok := extractLayer3(d, run, map[string]bool{}, nil, now); ok {
		t.Fatal("no anchor => layer 3 cannot fire")
	}
	// self-correction: commit carries a DIFFERENT ticket → contradicted, no edge
	if _, ok := extractLayer3(d, run, anchor, []string{"OTHER-9 unrelated"}, now); ok {
		t.Fatal("a different concrete ticket must retract the weak edge")
	}
	// time-boxed: run finished long ago, never reinforced → decays
	old := &waveobj.Run{OID: "r3", ProjectPath: "/repo/app", CreatedTs: now - timeBoxMs - 5000, CompletedTs: now - timeBoxMs - 1000}
	if _, ok := extractLayer3(d, old, anchor, nil, now); ok {
		t.Fatal("a run completed beyond the time-box must decay")
	}
}

func TestPastProbation(t *testing.T) {
	const now = int64(2_000_000_000_000)
	if pastProbation(&waveobj.Run{CreatedTs: now - 1000}, now) {
		t.Fatal("a fresh run is within probation")
	}
	if !pastProbation(&waveobj.Run{CreatedTs: now - probationMs - 1}, now) {
		t.Fatal("a run older than the probation window is past probation")
	}
}

func TestAssembleMergesAndOrders(t *testing.T) {
	const now = int64(1_000_000_000_000)
	// dossier already has a canonical layer-1 ref to run r0, ticket matches r1, r2 is a weak same-repo prior.
	d := &jarvisdossier.Dossier{
		ID: "task-1", Ticket: "PROJ-142", Status: "active", Created: now - 10000,
		Refs: []string{"run-r0", "dec-abc"}, // dec- is a decision ref, ignored by run attribution
	}
	runs := []*waveobj.Run{
		{OID: "r0", ProjectPath: "/repo/app", CreatedTs: now - 9000, CompletedTs: now - 8000},
		{OID: "r1", ProjectPath: "/repo/app", Goal: "PROJ-142 flow", CreatedTs: now - 5000, CompletedTs: now - 4000},
		{OID: "r2", ProjectPath: "/repo/app", CreatedTs: now - 3000, CompletedTs: now - 2000},
	}
	lk := edgeLookups{
		channelName: func(string) string { return "" },
		commits:     func(*waveobj.Run) []string { return nil },
	}

	edges := assembleEdges(d, runs, lk, now)

	byORef := map[string]AttributedEdge{}
	for _, e := range edges {
		byORef[e.RunORef] = e
	}
	// r0: canonical (layer 1), confirmed, confidence 1.0
	if e := byORef["run:r0"]; e.State != StateConfirmed || e.Confidence != 1.0 || !containsLayer(e.Layers, 1) {
		t.Fatalf("r0 layer-1 edge wrong: %+v", e)
	}
	// r1: ticket match AND same-repo/window prior → layers {2,3}, confidence max = 0.8, provenance ticket
	if e := byORef["run:r1"]; !containsLayer(e.Layers, 2) || !containsLayer(e.Layers, 3) || e.Confidence != 0.8 || e.Provenance != provTicket {
		t.Fatalf("r1 merged edge wrong: %+v", e)
	}
	// r2: weak structural only
	if e := byORef["run:r2"]; e.Confidence != weightLayer3 || e.State != StateInforming {
		t.Fatalf("r2 weak edge wrong: %+v", e)
	}
	// ordering: confidence descending
	for i := 1; i < len(edges); i++ {
		if edges[i-1].Confidence < edges[i].Confidence {
			t.Fatalf("edges not confidence-descending: %+v", edges)
		}
	}
}
