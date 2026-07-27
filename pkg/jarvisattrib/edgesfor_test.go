// pkg/jarvisattrib/edgesfor_test.go
package jarvisattrib

import (
	"context"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/jarvisdossier"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

func TestEdgesForEndToEnd(t *testing.T) {
	ctx := context.Background()
	v := testVault(t)

	chID := "aaaaaaaa-0000-0000-0000-000000000001"
	runID := "bbbbbbbb-0000-0000-0000-000000000001"
	ch := &waveobj.Channel{OID: chID, Name: "oauth channel", ProjectPath: "/repo/app", Meta: make(waveobj.MetaMapType)}
	// CreatedTs old enough to be past probation immediately; ticket in Goal drives the layer-2 hit.
	run := &waveobj.Run{OID: runID, ID: runID, ChannelOID: chID, Goal: "PROJ-142 pkce flow",
		ProjectPath: "/repo/app", Status: "done", CreatedTs: nowFn() - probationMs - 1000, CompletedTs: nowFn() - 1000,
		Meta: make(waveobj.MetaMapType)}
	if err := wstore.DBInsert(ctx, ch); err != nil {
		t.Fatalf("insert channel: %v", err)
	}
	if err := wstore.DBInsert(ctx, run); err != nil {
		t.Fatalf("insert run: %v", err)
	}
	t.Cleanup(func() {
		_ = wstore.DBDelete(ctx, waveobj.OType_Channel, chID)
		_ = wstore.DBDelete(ctx, waveobj.OType_Run, runID)
	})

	id, _, err := jarvisdossier.CreateDossier(v, jarvisdossier.DossierFacts{Ticket: "PROJ-142", Objective: "oauth"})
	if err != nil {
		t.Fatalf("CreateDossier: %v", err)
	}

	// 1) inferred layer-2 edge, informing (not yet hardened)
	edges, err := EdgesFor(ctx, v, id)
	if err != nil {
		t.Fatalf("EdgesFor: %v", err)
	}
	got := findEdge(edges, "run:"+runID)
	if got == nil || got.State != StateInforming || !containsLayer(got.Layers, 2) || got.Confidence != weightLayer2 {
		t.Fatalf("expected informing layer-2 edge, got %+v (all=%+v)", got, edges)
	}

	// Backfill returns the same informing edge as a proposal
	proposals, err := Backfill(ctx, v, id)
	if err != nil || findEdge(proposals, "run:"+runID) == nil {
		t.Fatalf("Backfill missing the proposal: %+v err=%v", proposals, err)
	}

	// 2) Harden promotes the deterministic, past-probation edge into canonical refs
	if err := Harden(ctx, v, id); err != nil {
		t.Fatalf("Harden: %v", err)
	}
	edges, _ = EdgesFor(ctx, v, id)
	got = findEdge(edges, "run:"+runID)
	if got == nil || got.State != StateConfirmed || !containsLayer(got.Layers, 1) || got.Confidence != 1.0 {
		t.Fatalf("after harden expected confirmed layer-1 edge, got %+v", got)
	}

	// 3) Detach suppresses it
	if err := Detach(ctx, v, id, "run:"+runID); err != nil {
		t.Fatalf("Detach: %v", err)
	}
	edges, _ = EdgesFor(ctx, v, id)
	if findEdge(edges, "run:"+runID) != nil {
		t.Fatalf("detached edge still present: %+v", edges)
	}
}

func findEdge(edges []AttributedEdge, oref string) *AttributedEdge {
	for i := range edges {
		if edges[i].RunORef == oref {
			return &edges[i]
		}
	}
	return nil
}
