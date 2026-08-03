// pkg/jarvisattrib/lifecycle_test.go
package jarvisattrib

import (
	"context"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/jarvisdossier"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wavevault"
)

func TestHardenEdgeWritesCanonicalRefAndPreservesProse(t *testing.T) {
	v := testVault(t)
	id, _, err := jarvisdossier.CreateDossier(v, jarvisdossier.DossierFacts{Ticket: "PROJ-142", Objective: "oauth pkce"})
	if err != nil {
		t.Fatalf("CreateDossier: %v", err)
	}
	d, err := loadDossier(v, id)
	if err != nil {
		t.Fatalf("loadDossier: %v", err)
	}

	if err := hardenEdge(v, d, "run:r1"); err != nil {
		t.Fatalf("hardenEdge: %v", err)
	}

	// the run ref is now a real link on the dossier — reachable by A's HasLink filter
	nodes, err := v.Retriever(wavevault.AllScope()).Query(wavevault.Filter{HasLink: "run-r1"})
	if err != nil {
		t.Fatalf("Query: %v", err)
	}
	if len(nodes) != 1 || nodes[0].ID != id {
		t.Fatalf("HasLink(run-r1) did not find the dossier: %+v", nodes)
	}

	// hardening again is idempotent (no duplicate, no error)
	d2, _ := loadDossier(v, id)
	if err := hardenEdge(v, d2, "run:r1"); err != nil {
		t.Fatalf("idempotent harden: %v", err)
	}
	d3, _ := loadDossier(v, id)
	count := 0
	for _, r := range d3.Refs {
		if r == "run-r1" {
			count++
		}
	}
	if count != 1 {
		t.Fatalf("run-r1 appears %d times, want 1", count)
	}

	// the human ## Notes prose is untouched (B's diff-validator guards it)
	nb, _ := v.Retriever(wavevault.AllScope()).Read(id)
	if !contains(nb.Body, "## Notes") {
		t.Fatalf("human Notes section lost after harden: %q", nb.Body)
	}
}

func contains(s, sub string) bool { return len(s) >= len(sub) && (indexOf(s, sub) >= 0) }
func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}

func TestDetachSuppressesAndSurvivesRebuild(t *testing.T) {
	const now = int64(1_000_000_000_000)
	d := &jarvisdossier.Dossier{ID: "task-1", Ticket: "PROJ-142", Status: "active", Created: now - 9000}
	runs := []*waveobj.Run{{OID: "r1", ProjectPath: "/repo/app", Goal: "PROJ-142", CreatedTs: now - 5000}}
	lk := edgeLookups{channelName: func(string) string { return "" }, commits: func(*waveobj.Run) []string { return nil }}

	v := testVault(t)
	// before any override: the inferred edge is present
	edges := applyOverrides(assembleEdges(d, runs, lk, now), mustOverrides(t, v))
	if len(edges) != 1 {
		t.Fatalf("expected 1 inferred edge pre-detach, got %d", len(edges))
	}

	// user detaches it
	if err := Detach(context.Background(), v, "task-1", "run:r1"); err != nil {
		t.Fatalf("Detach: %v", err)
	}

	// a full rebuild (re-assemble + re-read overrides) still suppresses it
	edges = applyOverrides(assembleEdges(d, runs, lk, now), mustOverrides(t, v))
	if len(edges) != 0 {
		t.Fatalf("detached edge resurrected after rebuild: %+v", edges)
	}
}

func TestAcceptConfirms(t *testing.T) {
	const now = int64(1_000_000_000_000)
	edges := []AttributedEdge{{DossierID: "task-1", RunORef: "run:r1", Layers: []int{3}, Confidence: weightLayer3, State: StateInforming}}
	out := applyOverrides(edges, map[string]string{"task-1|run:r1": "accept"})
	if len(out) != 1 || out[0].State != StateConfirmed {
		t.Fatalf("accept should confirm the edge, got %+v", out)
	}
	_ = now
}

func TestDetachedEdgesListsASuppressedCanonicalRefAfterItsRefIsStripped(t *testing.T) {
	v := testVault(t)
	id, _, err := jarvisdossier.CreateDossier(v, jarvisdossier.DossierFacts{Ticket: "PROJ-1", Objective: "oauth pkce"})
	if err != nil {
		t.Fatalf("CreateDossier: %v", err)
	}
	d, _ := loadDossier(v, id)
	if err := hardenEdge(v, d, "run:r1"); err != nil {
		t.Fatalf("hardenEdge: %v", err)
	}
	if err := Detach(context.Background(), v, id, "run:r1"); err != nil {
		t.Fatalf("Detach: %v", err)
	}

	// Detach strips the canonical ref, so assembling alone can no longer see this edge. The override log
	// must still surface it, or the only row that can restore it is unreachable.
	got, err := DetachedEdges(context.Background(), v, id, "")
	if err != nil {
		t.Fatalf("DetachedEdges: %v", err)
	}
	if len(got) != 1 || got[0].RunORef != "run:r1" || got[0].State != StateDetached {
		t.Fatalf("want one detached run:r1, got %+v", got)
	}
}

func TestDetachedEdgesDropsARestoredEdge(t *testing.T) {
	v := testVault(t)
	id, _, _ := jarvisdossier.CreateDossier(v, jarvisdossier.DossierFacts{Ticket: "PROJ-2", Objective: "retries"})
	ctx := context.Background()
	if err := Detach(ctx, v, id, "run:r2"); err != nil {
		t.Fatalf("Detach: %v", err)
	}
	if err := Accept(ctx, v, id, "run:r2"); err != nil {
		t.Fatalf("Accept: %v", err)
	}
	got, err := DetachedEdges(ctx, v, id, "")
	if err != nil {
		t.Fatalf("DetachedEdges: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("a restored edge is still listed as detached: %+v", got)
	}
}

func TestDetachedEdgesFiltersByRunAcrossDossiers(t *testing.T) {
	v := testVault(t)
	ctx := context.Background()
	a, _, _ := jarvisdossier.CreateDossier(v, jarvisdossier.DossierFacts{Ticket: "PROJ-3", Objective: "alpha"})
	b, _, _ := jarvisdossier.CreateDossier(v, jarvisdossier.DossierFacts{Ticket: "PROJ-4", Objective: "beta"})
	if err := Detach(ctx, v, a, "run:shared"); err != nil {
		t.Fatalf("Detach a: %v", err)
	}
	if err := Detach(ctx, v, b, "run:other"); err != nil {
		t.Fatalf("Detach b: %v", err)
	}

	got, err := DetachedEdges(ctx, v, "", "run:shared")
	if err != nil {
		t.Fatalf("DetachedEdges: %v", err)
	}
	if len(got) != 1 || got[0].DossierID != a {
		t.Fatalf("want only dossier %s for run:shared, got %+v", a, got)
	}
}

func mustOverrides(t *testing.T, v *wavevault.Vault) map[string]string {
	t.Helper()
	ov, err := readOverrides(v)
	if err != nil {
		t.Fatalf("readOverrides: %v", err)
	}
	return ov
}
