// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvisproactive

import (
	"context"
	"path/filepath"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/jarvisdossier"
	"github.com/wavetermdev/waveterm/pkg/jarvisembed"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wavevault"
)

// mockEmbedder returns a 3-dim canned vector keyed off a keyword so cosine is
// controllable: "rate limit" texts collapse onto one axis, everything else onto
// another. The query goal and a matching decision therefore score ~1.0.
type mockEmbedder struct{}

func (mockEmbedder) Model() string { return "mock-1" }
func (mockEmbedder) Embed(_ context.Context, texts []string) ([][]float32, error) {
	out := make([][]float32, len(texts))
	for i, t := range texts {
		if strings.Contains(strings.ToLower(t), "rate limit") {
			out[i] = []float32{1, 0, 0}
		} else {
			out[i] = []float32{0, 1, 0}
		}
	}
	return out, nil
}

func newTestIndex(t *testing.T, emb jarvisembed.Embedder) *jarvisembed.Index {
	t.Helper()
	ctx := context.Background()
	ix, err := jarvisembed.OpenIndexAtForTest(ctx, filepath.Join(t.TempDir(), "index.db"), emb)
	if err != nil {
		t.Fatalf("open test index: %v", err)
	}
	t.Cleanup(func() { ix.Close() })
	return ix
}

func newTestVault(t *testing.T) *wavevault.Vault {
	t.Helper()
	v, err := wavevault.OpenVaultAtForTest(context.Background(), t.TempDir())
	if err != nil {
		t.Fatalf("open test vault: %v", err)
	}
	return v
}

func TestEvaluateHit(t *testing.T) {
	ctx := context.Background()
	v := newTestVault(t)
	if _, _, err := jarvisdossier.CreateDossier(v, jarvisdossier.DossierFacts{
		Objective: "handle rate limit backoff on the API client",
	}); err != nil {
		t.Fatalf("seed dossier: %v", err)
	}
	if err := v.Commit(ctx, "seed"); err != nil {
		t.Fatalf("commit: %v", err)
	}
	restore := SetJudgeForTest(func(_ context.Context, _, _ string) (string, error) { return "1", nil })
	defer restore()

	run := &waveobj.Run{OID: "run-x", Goal: "fix the rate limit bug", ProjectPath: t.TempDir()}
	sug, err := evaluate(ctx, newTestIndex(t, mockEmbedder{}), v, run)
	if err != nil {
		t.Fatalf("evaluate: %v", err)
	}
	if sug == nil || sug.Status != "hit" {
		t.Fatalf("want a hit suggestion, got %+v", sug)
	}
	if !strings.Contains(strings.ToLower(sug.Title+" "+sug.Snippet), "rate limit") {
		t.Fatalf("suggestion should describe the matched node, got %+v", sug)
	}
}

func TestEvaluateJudgeSaysNone(t *testing.T) {
	ctx := context.Background()
	v := newTestVault(t)
	if _, _, err := jarvisdossier.CreateDossier(v, jarvisdossier.DossierFacts{
		Objective: "handle rate limit backoff on the API client",
	}); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if err := v.Commit(ctx, "seed"); err != nil {
		t.Fatalf("commit: %v", err)
	}
	restore := SetJudgeForTest(func(_ context.Context, _, _ string) (string, error) { return "none", nil })
	defer restore()

	run := &waveobj.Run{OID: "run-y", Goal: "fix the rate limit bug", ProjectPath: t.TempDir()}
	sug, err := evaluate(ctx, newTestIndex(t, mockEmbedder{}), v, run)
	if err != nil {
		t.Fatalf("evaluate: %v", err)
	}
	if sug == nil || sug.Status != "none" {
		t.Fatalf("want a none sentinel, got %+v", sug)
	}
}

func TestEvaluateBelowThresholdSkipsModel(t *testing.T) {
	ctx := context.Background()
	v := newTestVault(t)
	if _, _, err := jarvisdossier.CreateDossier(v, jarvisdossier.DossierFacts{
		Objective: "an entirely unrelated indexing task",
	}); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if err := v.Commit(ctx, "seed"); err != nil {
		t.Fatalf("commit: %v", err)
	}
	called := false
	restore := SetJudgeForTest(func(_ context.Context, _, _ string) (string, error) { called = true; return "1", nil })
	defer restore()

	run := &waveobj.Run{OID: "run-z", Goal: "fix the rate limit bug", ProjectPath: t.TempDir()}
	sug, err := evaluate(ctx, newTestIndex(t, mockEmbedder{}), v, run)
	if err != nil {
		t.Fatalf("evaluate: %v", err)
	}
	if called {
		t.Fatal("model judge must not run when the pre-filter is empty")
	}
	if sug == nil || sug.Status != "none" {
		t.Fatalf("empty shortlist should yield a none sentinel, got %+v", sug)
	}
}

func TestEvaluateSelfExclusion(t *testing.T) {
	ctx := context.Background()
	v := newTestVault(t)
	// The dossier C's capture just wrote for THIS run: it references run-run-self
	// and is textually a perfect match — it must be excluded, leaving nothing.
	id, hash, err := jarvisdossier.CreateDossier(v, jarvisdossier.DossierFacts{
		Objective: "fix the rate limit bug",
	})
	if err != nil {
		t.Fatalf("seed: %v", err)
	}
	if _, err := jarvisdossier.SetRefs(v, id, []string{"run-run-self"}, hash); err != nil {
		t.Fatalf("set refs: %v", err)
	}
	if err := v.Commit(ctx, "seed"); err != nil {
		t.Fatalf("commit: %v", err)
	}
	restore := SetJudgeForTest(func(_ context.Context, _, _ string) (string, error) { return "1", nil })
	defer restore()

	run := &waveobj.Run{OID: "run-self", Goal: "fix the rate limit bug", ProjectPath: t.TempDir()}
	sug, err := evaluate(ctx, newTestIndex(t, mockEmbedder{}), v, run)
	if err != nil {
		t.Fatalf("evaluate: %v", err)
	}
	if sug == nil || sug.Status != "none" {
		t.Fatalf("the run's own dossier must be excluded → none, got %+v", sug)
	}
}

func TestEvaluateDisabledIndexIsNoop(t *testing.T) {
	ctx := context.Background()
	v := newTestVault(t)
	called := false
	restore := SetJudgeForTest(func(_ context.Context, _, _ string) (string, error) { called = true; return "1", nil })
	defer restore()

	run := &waveobj.Run{OID: "run-off", Goal: "fix the rate limit bug", ProjectPath: t.TempDir()}
	sug, err := evaluate(ctx, newTestIndex(t, nil), v, run) // nil embedder → unavailable
	if err != nil {
		t.Fatalf("evaluate: %v", err)
	}
	if sug != nil {
		t.Fatalf("disabled index must be a total no-op (nil), got %+v", sug)
	}
	if called {
		t.Fatal("model judge must not run when embeddings are off")
	}
}
