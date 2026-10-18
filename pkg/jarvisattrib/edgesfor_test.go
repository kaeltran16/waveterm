// pkg/jarvisattrib/edgesfor_test.go
package jarvisattrib

import (
	"context"
	"os/exec"
	"reflect"
	"slices"
	"strings"
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
	// the ticket in Goal drives the layer-2 hit
	run := &waveobj.Run{OID: runID, ID: runID, ChannelOID: chID, Goal: "PROJ-142 pkce flow",
		ProjectPath: "/repo/app", Status: "done", CreatedTs: nowFn() - 2000, CompletedTs: nowFn() - 1000,
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

	// 1) inferred layer-2 edge, informing
	edges, err := EdgesFor(ctx, v, id)
	if err != nil {
		t.Fatalf("EdgesFor: %v", err)
	}
	got := findEdge(edges, "run:"+runID)
	if got == nil || got.State != StateInforming || !slices.Contains(got.Layers, 2) || got.Confidence != weightLayer2 {
		t.Fatalf("expected informing layer-2 edge, got %+v (all=%+v)", got, edges)
	}

	// 2) Detach suppresses it
	if err := Detach(ctx, v, id, "run:"+runID); err != nil {
		t.Fatalf("Detach: %v", err)
	}
	edges, _ = EdgesFor(ctx, v, id)
	if findEdge(edges, "run:"+runID) != nil {
		t.Fatalf("detached edge still present: %+v", edges)
	}
}

func insertObjs(t *testing.T, objs ...waveobj.WaveObj) {
	t.Helper()
	ctx := context.Background()
	for _, o := range objs {
		if err := wstore.DBInsert(ctx, o); err != nil {
			t.Fatalf("insert %s: %v", o.GetOType(), err)
		}
		t.Cleanup(func() { _ = wstore.DBDelete(ctx, o.GetOType(), waveobj.GetOID(o)) })
	}
}

func ticketEdge(dossierID, runOID string) AttributedEdge {
	return AttributedEdge{DossierID: dossierID, RunORef: "run:" + runOID, Layers: []int{2}, Provenance: provTicket,
		Confidence: weightLayer2, State: StateInforming}
}

// a ticket in the run's channel name attributes the run; a run whose channel is gone has no name to match
func TestEdgesForReadsTheChannelName(t *testing.T) {
	ctx := context.Background()
	v := testVault(t)
	chID := "aaaaaaaa-0000-0000-0000-000000000021"
	named := "bbbbbbbb-0000-0000-0000-000000000021"
	orphan := "bbbbbbbb-0000-0000-0000-000000000022"
	mk := func(oid, channel string) *waveobj.Run {
		return &waveobj.Run{OID: oid, ID: oid, ChannelOID: channel, Goal: "rollout", Status: "done",
			CreatedTs: nowFn() - 2000, CompletedTs: nowFn() - 1000, Meta: make(waveobj.MetaMapType)}
	}
	insertObjs(t,
		&waveobj.Channel{OID: chID, Name: "PROJ-311 rollout", Meta: make(waveobj.MetaMapType)},
		mk(named, chID),
		mk(orphan, "cccccccc-0000-0000-0000-000000000021"),
	)
	id, _, err := jarvisdossier.CreateDossier(v, jarvisdossier.DossierFacts{Ticket: "PROJ-311", Objective: "rollout"})
	if err != nil {
		t.Fatalf("CreateDossier: %v", err)
	}
	edges, err := EdgesFor(ctx, v, id)
	if err != nil {
		t.Fatalf("EdgesFor: %v", err)
	}
	if want := []AttributedEdge{ticketEdge(id, named)}; !reflect.DeepEqual(edges, want) {
		t.Fatalf("edges = %+v, want %+v", edges, want)
	}
}

// commit subjects are read only for a run with a project and both ends of its range
func TestEdgesForReadsCommitSubjectsOfAFullRange(t *testing.T) {
	ctx := context.Background()
	v := testVault(t)
	repo := t.TempDir()
	gitIn := func(args ...string) string {
		t.Helper()
		out, err := exec.Command("git", append([]string{"-C", repo, "-c", "user.name=t", "-c", "user.email=t@t"}, args...)...).CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
		return strings.TrimSpace(string(out))
	}
	// main: base -> onMain (HEAD); side: base -> onSide. Each of the ticket commits is outside the other branch.
	gitIn("init", "-q", "-b", "main")
	gitIn("commit", "-q", "--allow-empty", "-m", "base")
	base := gitIn("rev-parse", "HEAD")
	gitIn("checkout", "-q", "-b", "side")
	gitIn("commit", "-q", "--allow-empty", "-m", "PROJ-412 on side")
	onSide := gitIn("rev-parse", "HEAD")
	gitIn("checkout", "-q", "main")
	gitIn("commit", "-q", "--allow-empty", "-m", "PROJ-412 on main")
	onMain := gitIn("rev-parse", "HEAD")

	full := "bbbbbbbb-0000-0000-0000-000000000031"
	mk := func(oid, base, end string) *waveobj.Run {
		return &waveobj.Run{OID: oid, ID: oid, Goal: "work", ProjectPath: repo, BaseCommit: base, EndCommit: end,
			Status: "done", CreatedTs: nowFn() - 2000, CompletedTs: nowFn() - 1000, Meta: make(waveobj.MetaMapType)}
	}
	insertObjs(t,
		mk(full, base, onMain),
		mk("bbbbbbbb-0000-0000-0000-000000000032", "", onSide), // read as HEAD..onSide it would match
		mk("bbbbbbbb-0000-0000-0000-000000000033", base, ""),   // read as base..HEAD it would match
	)
	id, _, err := jarvisdossier.CreateDossier(v, jarvisdossier.DossierFacts{Ticket: "PROJ-412", Objective: "work"})
	if err != nil {
		t.Fatalf("CreateDossier: %v", err)
	}
	edges, err := EdgesFor(ctx, v, id)
	if err != nil {
		t.Fatalf("EdgesFor: %v", err)
	}
	if want := []AttributedEdge{ticketEdge(id, full)}; !reflect.DeepEqual(edges, want) {
		t.Fatalf("edges = %+v, want %+v", edges, want)
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
