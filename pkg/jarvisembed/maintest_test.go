// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvisembed

import (
	"context"
	"path/filepath"
	"testing"
)

// newTestIndex opens an index at a temp DB with the given embedder (nil => unavailable).
func newTestIndex(t *testing.T, emb Embedder) *Index {
	t.Helper()
	ix, err := OpenIndexAtForTest(context.Background(), filepath.Join(t.TempDir(), "index.db"), emb)
	if err != nil {
		t.Fatalf("OpenIndexAtForTest: %v", err)
	}
	t.Cleanup(func() { ix.Close() })
	return ix
}
