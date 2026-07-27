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

func containsStr(ss []string, s string) bool {
	for _, x := range ss {
		if x == s {
			return true
		}
	}
	return false
}
