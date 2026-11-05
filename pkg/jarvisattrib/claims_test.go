package jarvisattrib

import (
	"context"
	"slices"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/jarvisdossier"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

const claimNow = int64(1_000_000_000_000)

// claimFixture: records A and B are active in one repo over one window; A refs run rA, B refs run rB, run rX is a
// lead run no record refs, and rW is a worker run. Every run of the repo is a layer-3 guess for both records
// unless a claim removes it.
func claimFixture() (a, b *jarvisdossier.Dossier, runs []*waveobj.Run) {
	mk := func(oid, taskID string) *waveobj.Run {
		return &waveobj.Run{OID: oid, ProjectPath: "/repo/app", TaskId: taskID, CreatedTs: claimNow - 3000, CompletedTs: claimNow - 2000}
	}
	a = &jarvisdossier.Dossier{ID: "task-a", Status: "active", Created: claimNow - 5000, Refs: []string{"run-rA"}}
	b = &jarvisdossier.Dossier{ID: "task-b", Status: "active", Created: claimNow - 5000, Refs: []string{"run-rB"}}
	return a, b, []*waveobj.Run{mk("rA", ""), mk("rB", ""), mk("rX", ""), mk("rW", "t-1")}
}

func claimEdges(d *jarvisdossier.Dossier, dossiers []*jarvisdossier.Dossier, runs []*waveobj.Run, ov map[string]string) []AttributedEdge {
	lk := edgeLookups{channelName: func(string) string { return "" }, commits: func(*waveobj.Run) []string { return nil }}
	return edgesForDossier(context.Background(), d, runs, lk, ov, claimedRuns(dossiers, runs, ov), claimNow)
}

func TestClaimedGuessDropped(t *testing.T) {
	a, b, runs := claimFixture()
	dossiers := []*jarvisdossier.Dossier{a, b}
	if e := findEdge(claimEdges(b, dossiers, runs, map[string]string{}), "run:rA"); e != nil {
		t.Fatalf("B guesses run rA, which A claims: %+v", e)
	}
	if e := findEdge(claimEdges(a, dossiers, runs, map[string]string{}), "run:rA"); e == nil || e.State != StateConfirmed {
		t.Fatalf("A's own edge to rA = %+v, want confirmed", e)
	}
}

func TestUnclaimedGuessKept(t *testing.T) {
	a, b, runs := claimFixture()
	e := findEdge(claimEdges(b, []*jarvisdossier.Dossier{a, b}, runs, map[string]string{}), "run:rX")
	if e == nil || e.State != StateInforming || !slices.Equal(e.Layers, []int{3}) {
		t.Fatalf("B's guess of unclaimed run rX = %+v, want an informing layer-3 edge", e)
	}
}

// the accept here is in the override log only (its ref hardening is best-effort), so B's edge to rA is a guess the
// log confirms: it must survive A's claim, and A's own edge stays.
func TestAcceptedOnTwoRecordsKept(t *testing.T) {
	a, b, runs := claimFixture()
	dossiers := []*jarvisdossier.Dossier{a, b}
	ov := map[string]string{"task-b|run:rA": "accept"}
	if e := findEdge(claimEdges(b, dossiers, runs, ov), "run:rA"); e == nil || e.State != StateConfirmed {
		t.Fatalf("B's accepted edge to rA = %+v, want confirmed", e)
	}
	if e := findEdge(claimEdges(a, dossiers, runs, ov), "run:rA"); e == nil || e.State != StateConfirmed {
		t.Fatalf("A's own edge to rA = %+v, want confirmed", e)
	}
	if claims := claimedRuns(dossiers, runs, ov)["run:rA"]; !claims["task-a"] || !claims["task-b"] {
		t.Fatalf("claims on rA = %v, want both records", claims)
	}
}

// the detach is in the override log while A still holds the ref (Detach strips it best-effort): the log wins.
func TestDetachReleasesClaim(t *testing.T) {
	a, b, runs := claimFixture()
	dossiers := []*jarvisdossier.Dossier{a, b}
	ov := map[string]string{"task-a|run:rA": "detach"}
	if claims, ok := claimedRuns(dossiers, runs, ov)["run:rA"]; ok {
		t.Fatalf("a detached ref still claims rA: %v", claims)
	}
	e := findEdge(claimEdges(b, dossiers, runs, ov), "run:rA")
	if e == nil || e.State != StateInforming || !slices.Equal(e.Layers, []int{3}) {
		t.Fatalf("B's guess of released run rA = %+v, want an informing layer-3 edge", e)
	}
}

func TestNonLeadRefClaimsNothing(t *testing.T) {
	a, b, runs := claimFixture()
	a.Refs = append(a.Refs, "run-rW")
	dossiers := []*jarvisdossier.Dossier{a, b}
	if claims, ok := claimedRuns(dossiers, runs, map[string]string{})["run:rW"]; ok {
		t.Fatalf("a ref to worker run rW claims it: %v", claims)
	}
	if e := findEdge(claimEdges(b, dossiers, runs, map[string]string{}), "run:rW"); e != nil {
		t.Fatalf("worker run rW is an edge of B: %+v", e)
	}
	// a ref to a run missing from the store is kept by assembleEdges, so it claims
	a.Refs = append(a.Refs, "run-gone")
	if claims := claimedRuns(dossiers, runs, map[string]string{})["run:gone"]; !claims["task-a"] {
		t.Fatalf("claims on missing run = %v, want task-a", claims)
	}
}

// the override log outlives a deleted record: its accept must not hide the run from the records that remain.
func TestAcceptFromMissingDossierClaimsNothing(t *testing.T) {
	a, b, runs := claimFixture()
	dossiers := []*jarvisdossier.Dossier{a, b}
	ov := map[string]string{"gone|run:rX": "accept"}
	if claims := claimedRuns(dossiers, runs, ov)["run:rX"]; len(claims) != 0 {
		t.Fatalf("an accept from deleted record gone claims rX: %v", claims)
	}
	e := findEdge(claimEdges(b, dossiers, runs, ov), "run:rX")
	if e == nil || e.State != StateInforming || !slices.Equal(e.Layers, []int{3}) {
		t.Fatalf("B's guess of rX = %+v, want an informing layer-3 edge", e)
	}
}

// EdgesFor and AllEdges both read every record's refs from the vault to build the claims.
func TestEdgesForDropsAGuessAnotherRecordClaims(t *testing.T) {
	ctx := context.Background()
	v := testVault(t)
	// still running, so each run's window reaches the records created below
	mk := func(oid string) *waveobj.Run {
		return &waveobj.Run{OID: oid, ID: oid, Goal: "work", ProjectPath: "/repo/claims", Status: "executing",
			CreatedTs: nowFn() - 2000, Meta: make(waveobj.MetaMapType)}
	}
	rA := "bbbbbbbb-0000-0000-0000-000000000041"
	rB := "bbbbbbbb-0000-0000-0000-000000000042"
	rX := "bbbbbbbb-0000-0000-0000-000000000043"
	insertObjs(t, mk(rA), mk(rB), mk(rX))
	mkDossier := func(objective, ref string) string {
		id, _, err := jarvisdossier.CreateDossier(v, jarvisdossier.DossierFacts{Objective: objective})
		if err != nil {
			t.Fatalf("CreateDossier: %v", err)
		}
		d, err := loadDossier(v, id)
		if err != nil {
			t.Fatalf("loadDossier: %v", err)
		}
		if _, err := jarvisdossier.SetRefs(v, id, []string{ref}, d.Hash); err != nil {
			t.Fatalf("SetRefs: %v", err)
		}
		return id
	}
	a := mkDossier("alpha", "run-"+rA)
	b := mkDossier("beta", "run-"+rB)

	edges, err := EdgesFor(ctx, v, b)
	if err != nil {
		t.Fatalf("EdgesFor: %v", err)
	}
	if findEdge(edges, "run:"+rA) != nil || findEdge(edges, "run:"+rX) == nil {
		t.Fatalf("EdgesFor(B) = %+v, want rX guessed and rA (claimed by A) absent", edges)
	}
	all, err := AllEdges(ctx, v)
	if err != nil {
		t.Fatalf("AllEdges: %v", err)
	}
	if findEdge(all[b], "run:"+rA) != nil || findEdge(all[b], "run:"+rX) == nil {
		t.Fatalf("AllEdges[B] = %+v, want rX guessed and rA (claimed by A) absent", all[b])
	}
	if e := findEdge(all[a], "run:"+rA); e == nil || e.State != StateConfirmed {
		t.Fatalf("AllEdges[A] edge to rA = %+v, want confirmed", e)
	}
}
