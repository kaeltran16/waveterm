// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvisembed

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/wavevault"
)

func allScopeForTest() wavevault.Scope { return wavevault.AllScope() }

// fakeEmbedder returns deterministic vectors: a keyword->basis-vector map so KNN
// ordering is assertable. Unknown text embeds to a small uniform vector.
type fakeEmbedder struct {
	dims     int
	calls    int // texts embedded
	requests int // Embed invocations — batching is about this, not calls
}

func (f *fakeEmbedder) Model() string { return "fake-model" }
func (f *fakeEmbedder) Embed(ctx context.Context, texts []string) ([][]float32, error) {
	// real providers reject an empty input: OpenAI-compatible endpoints answer 200 with an empty data
	// array, which surfaces as "embedded 0 of N inputs" and kills the whole request. Mirroring that here
	// is what makes an empty chunk a test failure rather than a silent pass.
	for _, tx := range texts {
		if tx == "" {
			return nil, errors.New("fakeEmbedder: empty input rejected")
		}
	}
	f.calls += len(texts)
	f.requests++
	out := make([][]float32, len(texts))
	for i, tx := range texts {
		v := make([]float32, f.dims)
		switch {
		case containsFold(tx, "alpha"):
			v[0] = 1
		case containsFold(tx, "beta"):
			v[1] = 1
		default:
			for j := range v {
				v[j] = 0.01
			}
		}
		out[i] = v
	}
	return out, nil
}

func containsFold(s, sub string) bool {
	return strings.Contains(strings.ToLower(s), strings.ToLower(sub))
}

func TestOpenIndexDisabledIsUnavailable(t *testing.T) {
	ix := newTestIndex(t, nil) // nil embedder => unavailable
	if ix.Available() {
		t.Fatal("expected unavailable index")
	}
	_, err := ix.Query(context.Background(), nil, "anything", 5, allScopeForTest())
	if !errors.Is(err, ErrEmbeddingsDisabled) {
		t.Fatalf("Query err = %v, want ErrEmbeddingsDisabled", err)
	}
}

func TestOpenIndexEnabledCreatesSchema(t *testing.T) {
	ix := newTestIndex(t, &fakeEmbedder{dims: 3})
	if !ix.Available() {
		t.Fatal("expected available index")
	}
	var n int
	if err := ix.db.QueryRow(`select count(*) from sqlite_master where name in ('chunks','meta')`).Scan(&n); err != nil {
		t.Fatalf("schema query: %v", err)
	}
	if n != 2 {
		t.Fatalf("expected chunks+meta tables, got %d", n)
	}
}

func TestQueryKNNAndScope(t *testing.T) {
	v := seedVault(t) // memory/one.md ("alpha"), tasks/active/two.md ("beta")
	ix := newTestIndex(t, &fakeEmbedder{dims: 3})

	// AllScope: "alpha" nearest is node one.
	got, err := ix.Query(context.Background(), v, "alpha please", 5, wavevault.AllScope())
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	if len(got) == 0 || got[0].NodeID != "one" {
		t.Fatalf("want top hit 'one', got %+v", got)
	}
	// Identical query/section vectors -> cosine similarity ~1 (guards Score direction + metric).
	if got[0].Score < 0.9 {
		t.Fatalf("want top hit Score ~1.0 (cosine), got %v", got[0].Score)
	}

	// WorkerScope excludes tasks/: a "beta" query must not return node two.
	got, err = ix.Query(context.Background(), v, "beta please", 5, wavevault.WorkerScope())
	if err != nil {
		t.Fatalf("query worker: %v", err)
	}
	for _, c := range got {
		if c.Collection == wavevault.CollTasks || c.NodeID == "two" {
			t.Fatalf("worker scope leaked a tasks/ chunk: %+v", c)
		}
	}
}

// gradedEmbedder scores by keyword so ranking *within* and *across* collections is assertable:
// "alpha" is an exact match for an "alpha" query, "near" is a close-but-lower match, everything
// else is orthogonal. fakeEmbedder's basis vectors can only express match/no-match, which cannot
// express one collection outranking another.
type gradedEmbedder struct{ requests int }

func (g *gradedEmbedder) Model() string { return "graded-fake" }
func (g *gradedEmbedder) Embed(ctx context.Context, texts []string) ([][]float32, error) {
	g.requests++
	out := make([][]float32, len(texts))
	for i, tx := range texts {
		switch {
		case containsFold(tx, "alpha"):
			out[i] = []float32{1, 0, 0}
		case containsFold(tx, "near"):
			out[i] = []float32{0.8, 0.6, 0}
		default:
			out[i] = []float32{0, 0, 1}
		}
	}
	return out, nil
}

// crowdedVault mirrors the real corpus shape: one collection holds many close matches and the
// others hold few. A global top-k smaller than the memory count cannot reach tasks/ or decisions/.
func crowdedVault(t *testing.T) *wavevault.Vault {
	t.Helper()
	v, err := wavevault.OpenVaultAtForTest(context.Background(), t.TempDir())
	if err != nil {
		t.Fatalf("OpenVaultAtForTest: %v", err)
	}
	writeNode(t, v, "memory/m1.md", "---\nid: m1\n---\n## A\nalpha one\n")
	writeNode(t, v, "memory/m2.md", "---\nid: m2\n---\n## A\nalpha two\n")
	writeNode(t, v, "memory/m3.md", "---\nid: m3\n---\n## A\nalpha three\n")
	writeNode(t, v, "tasks/active/t1.md", "---\nid: t1\n---\n## B\nnear match dossier\n")
	writeNode(t, v, "decisions/d1.md", "---\nid: d1\n---\n## C\nnear match decision\n")
	return v
}

func TestQueryPerCollectionReachesCrowdedOutCollections(t *testing.T) {
	v := crowdedVault(t)
	ix := newTestIndex(t, &gradedEmbedder{})
	ctx := context.Background()

	// Baseline: the global window is entirely memory, so tasks/ and decisions/ are unreachable.
	global, err := ix.Query(ctx, v, "alpha", 3, wavevault.AllScope())
	if err != nil {
		t.Fatalf("Query: %v", err)
	}
	for _, c := range global {
		if c.Collection != wavevault.CollMemory {
			t.Fatalf("premise broken: global top-3 should be all memory, got %s in %s", c.NodeID, c.Collection)
		}
	}

	got, err := ix.QueryPerCollection(ctx, v, "alpha", 3, wavevault.AllScope())
	if err != nil {
		t.Fatalf("QueryPerCollection: %v", err)
	}
	byColl := map[string]int{}
	for _, c := range got {
		byColl[c.Collection]++
	}
	for _, coll := range []string{wavevault.CollMemory, wavevault.CollTasks, wavevault.CollDecisions} {
		if byColl[coll] == 0 {
			t.Errorf("collection %q contributed nothing: %v", coll, byColl)
		}
	}
	for i := 1; i < len(got); i++ {
		if got[i].Score > got[i-1].Score {
			t.Fatalf("results not score-descending at %d: %v > %v", i, got[i].Score, got[i-1].Score)
		}
	}
}

func TestQueryPerCollectionCapsEachCollection(t *testing.T) {
	v := crowdedVault(t)
	ix := newTestIndex(t, &gradedEmbedder{})

	got, err := ix.QueryPerCollection(context.Background(), v, "alpha", 2, wavevault.AllScope())
	if err != nil {
		t.Fatalf("QueryPerCollection: %v", err)
	}
	byColl := map[string]int{}
	for _, c := range got {
		byColl[c.Collection]++
	}
	if byColl[wavevault.CollMemory] != 2 {
		t.Errorf("memory should be capped at k=2, got %d", byColl[wavevault.CollMemory])
	}
}

// The whole reason a per-collection fan-out is affordable is that the query embeds once and each
// KNN is a local indexed lookup. Embedding per collection would multiply the network cost by the
// collection count on every recall.
func TestQueryPerCollectionEmbedsQueryOnce(t *testing.T) {
	v := crowdedVault(t)
	ge := &gradedEmbedder{}
	ix := newTestIndex(t, ge)
	ctx := context.Background()

	if _, err := ix.Query(ctx, v, "alpha", 1, wavevault.AllScope()); err != nil {
		t.Fatalf("warm reconcile: %v", err)
	}
	ge.requests = 0 // reconcile is done; count only the query path

	if _, err := ix.QueryPerCollection(ctx, v, "alpha", 3, wavevault.AllScope()); err != nil {
		t.Fatalf("QueryPerCollection: %v", err)
	}
	if ge.requests != 1 {
		t.Fatalf("embed requests = %d, want 1 across all collections", ge.requests)
	}
}

func TestQueryPerCollectionHonorsScope(t *testing.T) {
	v := crowdedVault(t)
	ix := newTestIndex(t, &gradedEmbedder{})

	got, err := ix.QueryPerCollection(context.Background(), v, "alpha", 3, wavevault.WorkerScope())
	if err != nil {
		t.Fatalf("QueryPerCollection: %v", err)
	}
	for _, c := range got {
		if c.Collection == wavevault.CollTasks {
			t.Fatalf("worker scope leaked a tasks/ chunk: %+v", c)
		}
	}
}

func TestQueryPerCollectionDisabledIsTyped(t *testing.T) {
	ix := newTestIndex(t, nil)
	_, err := ix.QueryPerCollection(context.Background(), nil, "anything", 3, allScopeForTest())
	if !errors.Is(err, ErrEmbeddingsDisabled) {
		t.Fatalf("err = %v, want ErrEmbeddingsDisabled", err)
	}
}

func TestQueryDisabledNoNetwork(t *testing.T) {
	fe := &fakeEmbedder{dims: 3}
	restore := SetEmbedderForTest(nil)
	defer restore()
	ix := newTestIndex(t, nil)
	_, err := ix.Query(context.Background(), nil, "x", 3, wavevault.AllScope())
	if err == nil {
		t.Fatal("want ErrEmbeddingsDisabled")
	}
	if fe.calls != 0 {
		t.Fatal("disabled path should not embed")
	}
}
