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
	dims  int
	calls int
}

func (f *fakeEmbedder) Model() string { return "fake-model" }
func (f *fakeEmbedder) Embed(ctx context.Context, texts []string) ([][]float32, error) {
	f.calls += len(texts)
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
