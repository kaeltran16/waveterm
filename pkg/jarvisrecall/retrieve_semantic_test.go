// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvisrecall

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/jarvisembed"
	"github.com/wavetermdev/waveterm/pkg/wavevault"
)

// semFake maps text containing "solar" or "renewable" to one basis vector, and
// "budget" to another, so a paraphrase with no keyword overlap still matches.
type semFake struct{ dims int }

func (f *semFake) Model() string { return "sem-fake" }
func (f *semFake) Embed(ctx context.Context, texts []string) ([][]float32, error) {
	out := make([][]float32, len(texts))
	for i, tx := range texts {
		v := make([]float32, f.dims)
		low := strings.ToLower(tx)
		switch {
		case strings.Contains(low, "solar") || strings.Contains(low, "renewable"):
			v[0] = 1
		case strings.Contains(low, "budget"):
			v[1] = 1
		default:
			v[2] = 1
		}
		out[i] = v
	}
	return out, nil
}

func semVault(t *testing.T) *wavevault.Vault {
	t.Helper()
	v, err := wavevault.OpenVaultAtForTest(context.Background(), t.TempDir())
	if err != nil {
		t.Fatalf("OpenVaultAtForTest: %v", err)
	}
	write := func(rel, content string) {
		p := filepath.Join(v.Root, rel)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("memory/solar.md", "---\nid: solar\n---\n## S\nsolar panel deployment\n")
	write("memory/budget.md", "---\nid: budget\n---\n## B\nquarterly budget review\n")
	return v
}

func injectIndex(t *testing.T, emb jarvisembed.Embedder) {
	t.Helper()
	// Capture the temp dir once so every openIndex call in a test shares one index.db (t.TempDir
	// returns a fresh dir per call).
	dir := t.TempDir()
	restore := SetOpenIndexForTest(func(ctx context.Context) (*jarvisembed.Index, error) {
		return jarvisembed.OpenIndexAtForTest(ctx, filepath.Join(dir, "index.db"), emb)
	})
	t.Cleanup(func() { SetOpenIndexForTest(restore) })
}

func TestSelectSeedsSemanticSurfacesParaphrase(t *testing.T) {
	v := semVault(t)
	injectIndex(t, &semFake{dims: 3})
	r := v.Retriever(wavevault.AllScope())

	// Query shares no >=4-char keyword with "solar panel deployment", so L1/L2 find nothing;
	// only the semantic layer (both map to basis vec 0) can surface node "solar".
	seeds, err := selectSeeds(context.Background(), v, r, "renewable grid")
	if err != nil {
		t.Fatalf("selectSeeds: %v", err)
	}
	if !containsStr(seeds, "solar") {
		t.Fatalf("semantic seed 'solar' missing: %v", seeds)
	}
}

func TestSelectSeedsDegradesWhenDisabled(t *testing.T) {
	v := semVault(t)
	// Unavailable index (nil embedder): L3 contributes nothing.
	injectIndex(t, nil)
	r := v.Retriever(wavevault.AllScope())
	seeds, err := selectSeeds(context.Background(), v, r, "renewable grid")
	if err != nil {
		t.Fatalf("selectSeeds: %v", err)
	}
	if containsStr(seeds, "solar") {
		t.Fatalf("semantic seed leaked with embeddings off: %v", seeds)
	}
}

// gradedFake scores by keyword so a fixture can express "close" and "faint" rather than only
// match/no-match: a query about renewables is an exact match for solar notes, moderately close to
// "adjacent" ones and barely related to "faint" ones.
type gradedFake struct{}

func (gradedFake) Model() string { return "graded-fake" }
func (gradedFake) Embed(ctx context.Context, texts []string) ([][]float32, error) {
	out := make([][]float32, len(texts))
	for i, tx := range texts {
		low := strings.ToLower(tx)
		switch {
		case strings.Contains(low, "solar"), strings.Contains(low, "renewable"):
			out[i] = []float32{1, 0, 0}
		case strings.Contains(low, "adjacent"):
			out[i] = []float32{0.6, 0.8, 0} // cos 0.60 against a renewables query
		case strings.Contains(low, "faint"):
			out[i] = []float32{0.05, 1, 0} // cos ~0.05
		default:
			out[i] = []float32{0, 0, 1} // orthogonal
		}
	}
	return out, nil
}

// crowdedVault mirrors the real corpus ratio: memory holds many strong matches, tasks and decisions
// hold one apiece. Under a single global window the memory notes take every slot.
func crowdedVault(t *testing.T) *wavevault.Vault {
	t.Helper()
	v, err := wavevault.OpenVaultAtForTest(context.Background(), t.TempDir())
	if err != nil {
		t.Fatalf("OpenVaultAtForTest: %v", err)
	}
	write := func(rel, content string) {
		p := filepath.Join(v.Root, rel)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	for _, id := range []string{"m1", "m2", "m3", "m4", "m5", "m6", "m7", "m8"} {
		write("memory/"+id+".md", "---\nid: "+id+"\n---\n## M\nsolar panel deployment "+id+"\n")
	}
	write("tasks/active/dossier.md", "---\nid: dossier\n---\n## T\nadjacent programme of work\n")
	write("decisions/adjacentcall.md", "---\nid: adjacentcall\n---\n## D\nadjacent procedural ruling\n")
	write("decisions/faintcall.md", "---\nid: faintcall\n---\n## D\nfaint procedural ruling\n")
	return v
}

// guardFixtureBand fails loudly if a re-fit moves semSeedFloor outside the band this fixture's
// scores were chosen to straddle, so a future calibration gets a clear signal instead of a
// mystifying assertion failure.
func guardFixtureBand(t *testing.T) {
	t.Helper()
	if semSeedFloor <= 0.05 || semSeedFloor > 0.6 {
		t.Fatalf("fixture assumes semSeedFloor in (0.05, 0.6]; got %v — re-pick the fixture scores", semSeedFloor)
	}
}

// The J5 bug: with one global window and memory outnumbering tasks ~23:1 on the real corpus, a
// dossier that is correctly retrieved and correctly scored is still dropped before recall sees it.
func TestSelectSeedsReachesDossierUnderMemoryCrowding(t *testing.T) {
	guardFixtureBand(t)
	v := crowdedVault(t)
	injectIndex(t, gradedFake{})
	r := v.Retriever(wavevault.AllScope())

	seeds, err := selectSeeds(context.Background(), v, r, "renewable grid")
	if err != nil {
		t.Fatalf("selectSeeds: %v", err)
	}
	if !containsStr(seeds, "dossier") {
		t.Fatalf("dossier crowded out by memory notes: %v", seeds)
	}
}

func TestSelectSeedsDropsBelowFloor(t *testing.T) {
	guardFixtureBand(t)
	v := crowdedVault(t)
	injectIndex(t, gradedFake{})
	r := v.Retriever(wavevault.AllScope())

	seeds, err := selectSeeds(context.Background(), v, r, "renewable grid")
	if err != nil {
		t.Fatalf("selectSeeds: %v", err)
	}
	// faintcall is the nearest decision, so a per-collection window without a floor would admit it
	// purely for being its collection's best — which is what the floor exists to prevent.
	if containsStr(seeds, "faintcall") {
		t.Fatalf("below-floor seed admitted: %v", seeds)
	}
}

// Retrieving per collection is only half the job: merging those windows by raw score re-imposes a
// global ranking, and memory wins it. Measured on the real corpus — a decision that was #1 in its own
// collection landed past seed #12 behind higher-scoring memory notes and was cut by the downstream
// candidate cap. Each collection's best hit has to appear near the head of the seed list.
func TestSelectSeedsInterleavesCollections(t *testing.T) {
	guardFixtureBand(t)
	v := crowdedVault(t)
	injectIndex(t, gradedFake{})
	r := v.Retriever(wavevault.AllScope())

	seeds, err := selectSeeds(context.Background(), v, r, "renewable grid")
	if err != nil {
		t.Fatalf("selectSeeds: %v", err)
	}
	if len(seeds) < 3 {
		t.Fatalf("expected seeds from three collections, got %v", seeds)
	}
	head := seeds[:3]
	if !containsStr(head, "dossier") || !containsStr(head, "adjacentcall") {
		t.Fatalf("collections not interleaved — memory's depth buried the other two; first three seeds: %v (all: %v)", head, seeds)
	}
}

// The floor must not become a quota: a collection with nothing relevant contributes nothing rather
// than filling its slots with its least-bad node.
func TestSelectSeedsAdmitsNothingWhenNothingIsRelevant(t *testing.T) {
	guardFixtureBand(t)
	v := crowdedVault(t)
	injectIndex(t, gradedFake{})
	r := v.Retriever(wavevault.AllScope())

	seeds, err := selectSeeds(context.Background(), v, r, "zzzz qqqq")
	if err != nil {
		t.Fatalf("selectSeeds: %v", err)
	}
	if len(seeds) != 0 {
		t.Fatalf("orthogonal query should yield no seeds at all, got %v", seeds)
	}
}

func containsStr(ss []string, s string) bool {
	for _, x := range ss {
		if x == s {
			return true
		}
	}
	return false
}
