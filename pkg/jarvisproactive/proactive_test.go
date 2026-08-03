// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvisproactive

import (
	"context"
	"fmt"
	"os"
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
	if sug == nil || sug.Status != StatusHit {
		t.Fatalf("want a hit suggestion, got %+v", sug)
	}
	if !strings.Contains(strings.ToLower(sug.Title+" "+sug.Snippet), "rate limit") {
		t.Fatalf("suggestion should describe the matched node, got %+v", sug)
	}
	// Reason explains a none; a hit is the product answer and carries none
	if sug.Reason != "" {
		t.Fatalf("a hit must not carry a reason, got %q", sug.Reason)
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
	if sug == nil || sug.Status != StatusNone || sug.Reason != ReasonJudgeDeclined {
		t.Fatalf("want none/%s, got %+v", ReasonJudgeDeclined, sug)
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
	if sug == nil || sug.Status != StatusNone || sug.Reason != ReasonNoCandidates {
		t.Fatalf("empty shortlist should yield none/%s, got %+v", ReasonNoCandidates, sug)
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
	if sug == nil || sug.Status != StatusNone || sug.Reason != ReasonNoCandidates {
		t.Fatalf("the run's own dossier must be excluded → none/%s, got %+v", ReasonNoCandidates, sug)
	}
}

// Was TestEvaluateDisabledIndexIsNoop, which asserted nil. Embeddings-off now produces a persistable
// record — the deliberate break of invariant 10 — because a nil left "never ran" and "ran and found
// nothing" as the same absence, which is the state 18 of 19 measured dispatches were in. The judge
// still must not run.
func TestEvaluateDisabledIndexRecordsEmbeddingsOff(t *testing.T) {
	ctx := context.Background()
	v := newTestVault(t)
	called := false
	restore := SetJudgeForTest(func(_ context.Context, _, _ string) (string, error) { called = true; return "1", nil })
	defer restore()

	run := &waveobj.Run{OID: "run-off", Goal: "fix the rate limit bug", ProjectPath: t.TempDir()}
	sug, err := evaluate(ctx, newTestIndex(t, nil), v, run) // nil embedder → unavailable
	if err != nil {
		t.Fatalf("must not error: %v", err)
	}
	if sug == nil {
		t.Fatal("embeddings-off must produce a record, not a nil no-op")
	}
	if sug.Status != StatusNone || sug.Reason != ReasonEmbeddingsOff {
		t.Fatalf("want none/%s, got %+v", ReasonEmbeddingsOff, *sug)
	}
	if called {
		t.Fatal("model judge must not run when embeddings are off")
	}
}

// gradedEmbedder leans a text onto the query axis in proportion to how often it says "cache", so
// several nodes clear cosThreshold while still ranking in a controlled order. Cosine against a
// 3-mention query: 3 mentions ~1.00, 2 ~0.99, 1 ~0.89, 0 ~0.32 (below the 0.40 gate). mockEmbedder is
// binary and cannot express "retrieved but outranked", which is the state under test here.
type gradedEmbedder struct{}

func (gradedEmbedder) Model() string { return "graded-1" }
func (gradedEmbedder) Embed(_ context.Context, texts []string) ([][]float32, error) {
	out := make([][]float32, len(texts))
	for i, t := range texts {
		out[i] = []float32{float32(strings.Count(strings.ToLower(t), "cache")), 1, 0}
	}
	return out, nil
}

func newTestVaultAt(t *testing.T) (*wavevault.Vault, string) {
	t.Helper()
	dir := t.TempDir()
	v, err := wavevault.OpenVaultAtForTest(context.Background(), dir)
	if err != nil {
		t.Fatalf("open test vault: %v", err)
	}
	return v, dir
}

func writeMemoryNote(t *testing.T, dir, id, body string) {
	t.Helper()
	path := filepath.Join(dir, "memory", id+".md")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("mkdir memory: %v", err)
	}
	content := fmt.Sprintf("---\nid: %s\n---\n\n## Note\n\n%s\n", id, body)
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

// A global top-k window cannot see past a collection that outnumbers the others. Ten memory notes
// each mention "cache" three times and so score ~1.00; the dossier mentions it once and scores ~0.89.
// With one global window of 8 the dossier is never retrieved at all, so no amount of downstream
// reordering could surface it — which is why this asserts on what the judge was actually offered
// rather than on the final suggestion.
func TestEvaluateReachesDossierBehindCrowdedMemory(t *testing.T) {
	ctx := context.Background()
	v, dir := newTestVaultAt(t)
	for i := 0; i < 10; i++ {
		writeMemoryNote(t, dir, fmt.Sprintf("m%d", i), "cache cache cache eviction trivia")
	}
	if _, _, err := jarvisdossier.CreateDossier(v, jarvisdossier.DossierFacts{
		Objective: "fix the cache invalidation bug",
	}); err != nil {
		t.Fatalf("seed dossier: %v", err)
	}
	if err := v.Commit(ctx, "seed"); err != nil {
		t.Fatalf("commit: %v", err)
	}

	var judgePrompt string
	restore := SetJudgeForTest(func(_ context.Context, _, prompt string) (string, error) {
		judgePrompt = prompt
		return "none", nil
	})
	defer restore()

	run := &waveobj.Run{OID: "run-crowd", Goal: "cache cache cache invalidation", ProjectPath: t.TempDir()}
	sug, err := evaluate(ctx, newTestIndex(t, gradedEmbedder{}), v, run)
	if err != nil {
		t.Fatalf("evaluate: %v", err)
	}
	if sug == nil {
		t.Fatal("evaluate must always return a record")
	}
	if sug.Reason == ReasonNoCandidates {
		t.Fatal("nothing reached the judge: the semantic window was filled entirely by memory notes")
	}
	if !strings.Contains(judgePrompt, "[dossier]") {
		t.Fatalf("the dossier never reached the judge's shortlist; prompt was:\n%s", judgePrompt)
	}
}

// The reason vocabulary is a closed set: a status of none always says why, so no terminal path can
// silently rejoin the six-ways-to-vanish problem this change exists to remove.
func TestEveryNoneReasonIsDistinctAndNonEmpty(t *testing.T) {
	reasons := []string{
		ReasonNoCandidates, ReasonJudgeDeclined, ReasonJudgeError,
		ReasonEmbeddingsOff, ReasonIndexError, ReasonVaultError, ReasonQueryError,
	}
	seen := map[string]bool{}
	for _, r := range reasons {
		if r == "" {
			t.Fatal("a reason constant must not be empty — an empty reason reads as a hit")
		}
		if seen[r] {
			t.Fatalf("duplicate reason %q: two failure paths would be indistinguishable", r)
		}
		seen[r] = true
	}
}
