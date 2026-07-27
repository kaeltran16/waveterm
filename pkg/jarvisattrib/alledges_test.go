// pkg/jarvisattrib/alledges_test.go
package jarvisattrib

import (
	"context"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/jarvisdossier"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// AllEdges must agree with EdgesFor per dossier (it is the same core), cover every dossier in one pass,
// and omit dossiers that attribute nothing — the ambient layer renders no tag for an unattributed object.
func TestAllEdgesMatchesEdgesForAcrossDossiers(t *testing.T) {
	ctx := context.Background()
	v := testVault(t)

	chID := "aaaaaaaa-0000-0000-0000-000000000011"
	runA := "bbbbbbbb-0000-0000-0000-000000000011"
	runB := "bbbbbbbb-0000-0000-0000-000000000012"
	ch := &waveobj.Channel{OID: chID, Name: "auth channel", ProjectPath: "/repo/app", Meta: make(waveobj.MetaMapType)}
	mk := func(oid, goal string) *waveobj.Run {
		return &waveobj.Run{OID: oid, ID: oid, ChannelOID: chID, Goal: goal, ProjectPath: "/repo/app",
			Status: "done", CreatedTs: nowFn() - probationMs - 1000, CompletedTs: nowFn() - 1000,
			Meta: make(waveobj.MetaMapType)}
	}
	if err := wstore.DBInsert(ctx, ch); err != nil {
		t.Fatalf("insert channel: %v", err)
	}
	for _, r := range []*waveobj.Run{mk(runA, "ACME-1 add pkce"), mk(runB, "ACME-2 rotate keys")} {
		if err := wstore.DBInsert(ctx, r); err != nil {
			t.Fatalf("insert run: %v", err)
		}
	}
	t.Cleanup(func() {
		_ = wstore.DBDelete(ctx, waveobj.OType_Channel, chID)
		_ = wstore.DBDelete(ctx, waveobj.OType_Run, runA)
		_ = wstore.DBDelete(ctx, waveobj.OType_Run, runB)
	})

	id1, _, err := jarvisdossier.CreateDossier(v, jarvisdossier.DossierFacts{Ticket: "ACME-1", Objective: "pkce"})
	if err != nil {
		t.Fatalf("CreateDossier 1: %v", err)
	}
	id2, _, err := jarvisdossier.CreateDossier(v, jarvisdossier.DossierFacts{Ticket: "ACME-2", Objective: "keys"})
	if err != nil {
		t.Fatalf("CreateDossier 2: %v", err)
	}
	// no ticket anywhere in the run set and no anchor repo -> attributes nothing
	id3, _, err := jarvisdossier.CreateDossier(v, jarvisdossier.DossierFacts{Ticket: "ZZZZ-9", Objective: "orphan"})
	if err != nil {
		t.Fatalf("CreateDossier 3: %v", err)
	}

	all, err := AllEdges(ctx, v)
	if err != nil {
		t.Fatalf("AllEdges: %v", err)
	}
	if _, ok := all[id3]; ok {
		t.Fatalf("dossier with no attribution must be omitted, got %+v", all[id3])
	}
	for _, id := range []string{id1, id2} {
		want, err := EdgesFor(ctx, v, id)
		if err != nil {
			t.Fatalf("EdgesFor %s: %v", id, err)
		}
		got := all[id]
		if len(got) != len(want) || len(want) == 0 {
			t.Fatalf("%s: AllEdges=%+v EdgesFor=%+v", id, got, want)
		}
		for i := range want {
			if got[i].RunORef != want[i].RunORef || got[i].State != want[i].State || got[i].Confidence != want[i].Confidence {
				t.Fatalf("%s edge %d: AllEdges=%+v EdgesFor=%+v", id, i, got[i], want[i])
			}
		}
	}
	// each dossier's ticket matched exactly its own run
	if all[id1][0].RunORef != "run:"+runA || all[id2][0].RunORef != "run:"+runB {
		t.Fatalf("tickets attributed to the wrong runs: %+v / %+v", all[id1], all[id2])
	}
}

// AllEdges resolves each run's commit subjects once, not once per dossier — the git range-log is the
// expensive part of the sweep.
func TestAllEdgesMemoizesCommitsPerRun(t *testing.T) {
	calls := map[string]int{}
	lk := memoizeCommits(edgeLookups{
		channelName: func(string) string { return "" },
		commits: func(r *waveobj.Run) []string {
			calls[r.OID]++
			return nil // a nil result must still be cached
		},
	})
	run := &waveobj.Run{OID: "r1"}
	for i := 0; i < 3; i++ {
		lk.commits(run)
	}
	lk.commits(&waveobj.Run{OID: "r2"})
	if calls["r1"] != 1 || calls["r2"] != 1 {
		t.Fatalf("commit lookups = %+v, want one per run", calls)
	}
}
