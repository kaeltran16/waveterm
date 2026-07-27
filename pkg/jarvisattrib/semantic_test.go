// pkg/jarvisattrib/semantic_test.go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvisattrib

import (
	"context"
	"path/filepath"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/jarvisdossier"
	"github.com/wavetermdev/waveterm/pkg/jarvisembed"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

func TestLayer4ConfidenceAndBucket(t *testing.T) {
	if got := confidenceFor([]int{4}); got != weightLayer4 {
		t.Fatalf("confidenceFor([4]) = %v, want %v", got, weightLayer4)
	}
	if got := Bucket(weightLayer4); got != "weak" {
		t.Fatalf("Bucket(weightLayer4) = %q, want weak", got)
	}
	if got := provenanceFor([]int{4}); got != provSemantic {
		t.Fatalf("provenanceFor([4]) = %q, want %q", got, provSemantic)
	}
}

func TestContradictsTicket(t *testing.T) {
	if !contradictsTicket("PROJ-1", []string{"fix PROJ-2 crash"}) {
		t.Fatal("a different concrete ticket should contradict")
	}
	if contradictsTicket("PROJ-1", []string{"work on PROJ-1", "more PROJ-1"}) {
		t.Fatal("the same ticket should not contradict")
	}
	if contradictsTicket("PROJ-1", []string{"no ticket here"}) {
		t.Fatal("no ticket token should not contradict")
	}
}

// attribFake maps text containing "oauth" to one basis vector, "billing" to another.
type attribFake struct{ dims, calls int }

func (f *attribFake) Model() string { return "attrib-fake" }
func (f *attribFake) Embed(ctx context.Context, texts []string) ([][]float32, error) {
	f.calls += len(texts)
	out := make([][]float32, len(texts))
	for i, tx := range texts {
		v := make([]float32, f.dims)
		low := strings.ToLower(tx)
		switch {
		case strings.Contains(low, "oauth"):
			v[0] = 1
		case strings.Contains(low, "billing"):
			v[1] = 1
		default:
			v[2] = 1
		}
		out[i] = v
	}
	return out, nil
}

func injectAttribIndex(t *testing.T, emb jarvisembed.Embedder) {
	t.Helper()
	// Capture the temp dir once so every openIndex call in a test shares one index.db (t.TempDir
	// returns a fresh dir per call) — the EmbedCached cache must persist across EdgesFor reads.
	dir := t.TempDir()
	restore := SetOpenIndexForTest(func(ctx context.Context) (*jarvisembed.Index, error) {
		return jarvisembed.OpenIndexAtForTest(ctx, filepath.Join(dir, "index.db"), emb)
	})
	t.Cleanup(func() { SetOpenIndexForTest(restore) })
}

func noCommits() edgeLookups {
	return edgeLookups{channelName: func(string) string { return "" }, commits: func(*waveobj.Run) []string { return nil }}
}

func TestProposeSemanticEdgesMatch(t *testing.T) {
	const now = int64(1_000_000_000_000)
	injectAttribIndex(t, &attribFake{dims: 3})
	d := &jarvisdossier.Dossier{ID: "task-1", Objective: "oauth pkce flow", Status: "active", Created: now - 9000, Hash: "h1"}
	runs := []*waveobj.Run{
		{OID: "r1", Goal: "implement oauth login", CreatedTs: now - 5000}, // matches
		{OID: "r2", Goal: "billing dashboard", CreatedTs: now - 5000},     // distractor
	}
	edges := proposeSemanticEdges(context.Background(), d, runs, noCommits(), now)
	if len(edges) != 1 || edges[0].RunORef != "run:r1" {
		t.Fatalf("want one semantic edge to run:r1, got %+v", edges)
	}
	e := edges[0]
	if e.State != StateInforming || e.Provenance != provSemantic || e.Confidence != weightLayer4 || !containsLayer(e.Layers, 4) {
		t.Fatalf("unexpected edge shape: %+v", e)
	}
}

func TestProposeSemanticEdgesContradictingTicketSkips(t *testing.T) {
	const now = int64(1_000_000_000_000)
	injectAttribIndex(t, &attribFake{dims: 3})
	d := &jarvisdossier.Dossier{ID: "task-1", Ticket: "PROJ-1", Objective: "oauth pkce", Status: "active", Created: now - 9000, Hash: "h1"}
	runs := []*waveobj.Run{{OID: "r1", Goal: "oauth login", CreatedTs: now - 5000}}
	lk := edgeLookups{channelName: func(string) string { return "" }, commits: func(*waveobj.Run) []string { return []string{"fix PROJ-2 bug"} }}
	if edges := proposeSemanticEdges(context.Background(), d, runs, lk, now); len(edges) != 0 {
		t.Fatalf("contradicting ticket should suppress, got %+v", edges)
	}
}

func TestProposeSemanticEdgesDisabled(t *testing.T) {
	const now = int64(1_000_000_000_000)
	injectAttribIndex(t, nil) // unavailable index
	d := &jarvisdossier.Dossier{ID: "task-1", Objective: "oauth", Status: "active", Created: now - 9000, Hash: "h1"}
	runs := []*waveobj.Run{{OID: "r1", Goal: "oauth login", CreatedTs: now - 5000}}
	if edges := proposeSemanticEdges(context.Background(), d, runs, noCommits(), now); edges != nil {
		t.Fatalf("disabled embeddings should yield nil, got %+v", edges)
	}
}

func TestCandidateRunsWindowAndCap(t *testing.T) {
	const now = int64(1_000_000_000_000)
	d := &jarvisdossier.Dossier{ID: "task-1", Status: "active", Created: now - 10_000}
	runs := []*waveobj.Run{
		{OID: "in", Goal: "x", CreatedTs: now - 5000},                             // overlaps
		{OID: "old", Goal: "y", CreatedTs: now - 100, CompletedTs: d_before(now)}, // outside window
	}
	got := candidateRuns(d, runs, now, 10)
	if len(got) != 1 || got[0].OID != "in" {
		t.Fatalf("want only the overlapping run, got %+v", got)
	}
}

// d_before returns a completion timestamp before the dossier's created window so the run cannot overlap.
func d_before(now int64) int64 { return now - 20_000 }

func TestEdgesForSemanticOnOrphan(t *testing.T) {
	ctx := context.Background()
	v := testVault(t)
	fe := &attribFake{dims: 3}
	injectAttribIndex(t, fe)

	runID := "cccccccc-0000-0000-0000-000000000001"
	// No ticket, no channel match, not in an anchor repo of any ref -> L1-3 all silent (orphan dossier).
	// CompletedTs 0 (still in flight): a freshly-created dossier is stamped created=now, so its active
	// window is [now, now]; an unfinished run extends to now (windowsOverlap) and thus overlaps it.
	run := &waveobj.Run{OID: runID, ID: runID, Goal: "implement oauth login", ProjectPath: "/repo/x",
		Status: "executing", CreatedTs: nowFn() - 5000, CompletedTs: 0, Meta: make(waveobj.MetaMapType)}
	if err := wstore.DBInsert(ctx, run); err != nil {
		t.Fatalf("insert run: %v", err)
	}
	t.Cleanup(func() { _ = wstore.DBDelete(ctx, waveobj.OType_Run, runID) })

	id, _, err := jarvisdossier.CreateDossier(v, jarvisdossier.DossierFacts{Objective: "oauth pkce flow"})
	if err != nil {
		t.Fatalf("CreateDossier: %v", err)
	}

	edges, err := EdgesFor(ctx, v, id)
	if err != nil {
		t.Fatalf("EdgesFor: %v", err)
	}
	got := findEdge(edges, "run:"+runID)
	if got == nil || got.State != StateInforming || got.Provenance != provSemantic {
		t.Fatalf("expected an informing semantic edge, got %+v (all=%+v)", got, edges)
	}

	// Cache: a second EdgesFor re-embeds zero runs (dossier + run fingerprints already cached).
	before := fe.calls
	if _, err := EdgesFor(ctx, v, id); err != nil {
		t.Fatalf("EdgesFor 2: %v", err)
	}
	if fe.calls != before {
		t.Fatalf("second EdgesFor re-embedded %d texts, want 0 (cache)", fe.calls-before)
	}

	// Detach suppresses the semantic edge durably.
	if err := Detach(ctx, v, id, "run:"+runID); err != nil {
		t.Fatalf("Detach: %v", err)
	}
	edges, _ = EdgesFor(ctx, v, id)
	if findEdge(edges, "run:"+runID) != nil {
		t.Fatalf("detached semantic edge still present: %+v", edges)
	}
}

func TestEdgesForNoSemanticWhenAttributed(t *testing.T) {
	ctx := context.Background()
	v := testVault(t)
	fe := &attribFake{dims: 3}
	injectAttribIndex(t, fe)

	runID := "dddddddd-0000-0000-0000-000000000001"
	run := &waveobj.Run{OID: runID, ID: runID, Goal: "PROJ-9 oauth", ProjectPath: "/repo/x",
		Status: "done", CreatedTs: nowFn() - 5000, CompletedTs: nowFn() - 1000, Meta: make(waveobj.MetaMapType)}
	if err := wstore.DBInsert(ctx, run); err != nil {
		t.Fatalf("insert run: %v", err)
	}
	t.Cleanup(func() { _ = wstore.DBDelete(ctx, waveobj.OType_Run, runID) })

	// Ticket in dossier + Goal -> a deterministic layer-2 edge exists, so semantic must not run.
	id, _, err := jarvisdossier.CreateDossier(v, jarvisdossier.DossierFacts{Ticket: "PROJ-9", Objective: "oauth"})
	if err != nil {
		t.Fatalf("CreateDossier: %v", err)
	}
	before := fe.calls
	edges, err := EdgesFor(ctx, v, id)
	if err != nil {
		t.Fatalf("EdgesFor: %v", err)
	}
	if fe.calls != before {
		t.Fatalf("semantic pass ran on an attributed dossier (embedded %d texts)", fe.calls-before)
	}
	got := findEdge(edges, "run:"+runID)
	if got == nil || got.Provenance == provSemantic {
		t.Fatalf("expected a deterministic (non-semantic) edge, got %+v", got)
	}
}
