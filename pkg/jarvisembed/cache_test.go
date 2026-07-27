// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvisembed

import (
	"context"
	"errors"
	"testing"
)

func TestEmbedCachedHitAndMiss(t *testing.T) {
	fe := &fakeEmbedder{dims: 3}
	ix := newTestIndex(t, fe)
	ctx := context.Background()

	v1, err := ix.EmbedCached(ctx, "run:r1", "hash-a", "alpha work")
	if err != nil {
		t.Fatalf("first EmbedCached: %v", err)
	}
	if len(v1) != 3 || v1[0] != 1 {
		t.Fatalf("unexpected vector: %+v", v1)
	}
	after := fe.calls

	// Same key + same content hash => cache hit, no new embed call.
	v2, err := ix.EmbedCached(ctx, "run:r1", "hash-a", "alpha work")
	if err != nil {
		t.Fatalf("second EmbedCached: %v", err)
	}
	if fe.calls != after {
		t.Fatalf("cache miss on identical call: calls went %d -> %d", after, fe.calls)
	}
	if v2[0] != v1[0] {
		t.Fatalf("cached vector differs: %+v vs %+v", v2, v1)
	}

	// Changed content hash => re-embed.
	if _, err := ix.EmbedCached(ctx, "run:r1", "hash-b", "beta work"); err != nil {
		t.Fatalf("third EmbedCached: %v", err)
	}
	if fe.calls != after+1 {
		t.Fatalf("changed content hash did not re-embed: calls=%d", fe.calls)
	}
}

func TestEmbedCachedModelChangeReembeds(t *testing.T) {
	fe := &fakeEmbedder{dims: 3}
	ix := newTestIndex(t, fe)
	ctx := context.Background()
	if _, err := ix.EmbedCached(ctx, "run:r1", "hash-a", "alpha"); err != nil {
		t.Fatalf("seed: %v", err)
	}
	_ = fe.calls
	// Swap the model tag: same key+hash, but the stored vector is now stale-space. The re-embed runs
	// on the NEW embedder (renamedFakeEmbedder), so we assert via the row's updated model tag rather
	// than fe.calls (a separate instance).
	ix.emb = &renamedFakeEmbedder{fakeEmbedder{dims: 3}}
	if _, err := ix.EmbedCached(ctx, "run:r1", "hash-a", "alpha"); err != nil {
		t.Fatalf("post-model-change: %v", err)
	}
	var model string
	if err := ix.db.QueryRow(`select model from attrib_vectors where key='run:r1'`).Scan(&model); err != nil {
		t.Fatalf("read back: %v", err)
	}
	if model != "other-model" {
		t.Fatalf("model tag not updated after re-embed: %q", model)
	}
}

func TestEmbedCachedDisabled(t *testing.T) {
	ix := newTestIndex(t, nil)
	if _, err := ix.EmbedCached(context.Background(), "k", "h", "t"); !errors.Is(err, ErrEmbeddingsDisabled) {
		t.Fatalf("EmbedCached err = %v, want ErrEmbeddingsDisabled", err)
	}
}
