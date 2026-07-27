// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvisembed

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/wavevault"
)

func seedVault(t *testing.T) *wavevault.Vault {
	t.Helper()
	v, err := wavevault.OpenVaultAtForTest(context.Background(), t.TempDir())
	if err != nil {
		t.Fatalf("OpenVaultAtForTest: %v", err)
	}
	writeNode(t, v, "memory/one.md", "---\nid: one\n---\n## A\nalpha content\n")
	writeNode(t, v, "tasks/active/two.md", "---\nid: two\nticket: ABC-1\n---\n## B\nbeta content\n")
	return v
}

func writeNode(t *testing.T, v *wavevault.Vault, rel, content string) {
	t.Helper()
	p := filepath.Join(v.Root, rel)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestReconcileEmbedsOnlyChanged(t *testing.T) {
	v := seedVault(t)
	fe := &fakeEmbedder{dims: 3}
	ix := newTestIndex(t, fe)

	st, err := ix.Reconcile(context.Background(), v)
	if err != nil {
		t.Fatalf("reconcile 1: %v", err)
	}
	if st.Embedded == 0 {
		t.Fatal("first reconcile embedded nothing")
	}
	firstCalls := fe.calls

	// Unchanged reconcile embeds nothing.
	if _, err := ix.Reconcile(context.Background(), v); err != nil {
		t.Fatalf("reconcile 2: %v", err)
	}
	if fe.calls != firstCalls {
		t.Fatalf("unchanged reconcile embedded %d extra sections", fe.calls-firstCalls)
	}

	// Edit one node -> only its sections re-embed.
	writeNode(t, v, "memory/one.md", "---\nid: one\n---\n## A\nalpha content changed\n")
	before := fe.calls
	if _, err := ix.Reconcile(context.Background(), v); err != nil {
		t.Fatalf("reconcile 3: %v", err)
	}
	if fe.calls != before+1 {
		t.Fatalf("edit re-embedded %d sections, want 1", fe.calls-before)
	}
}

// A first build must not cost one round-trip per node: that is what made the real 373-note build take
// 5m17s and blow past the 90s budget jarvisproactive's dispatch eval runs under.
func TestReconcileBatchesAcrossNodes(t *testing.T) {
	v, err := wavevault.OpenVaultAtForTest(context.Background(), t.TempDir())
	if err != nil {
		t.Fatalf("OpenVaultAtForTest: %v", err)
	}
	const nodes = 30
	for i := range nodes {
		id := fmt.Sprintf("n%02d", i)
		writeNode(t, v, "memory/"+id+".md", "---\nid: "+id+"\n---\nalpha content "+id+"\n")
	}
	fe := &fakeEmbedder{dims: 3}
	ix := newTestIndex(t, fe)

	st, err := ix.Reconcile(context.Background(), v)
	if err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	if st.Embedded != nodes {
		t.Fatalf("embedded %d sections, want %d", st.Embedded, nodes)
	}
	// 30 small single-section nodes fit one batch; the pre-batching code issued 30 requests.
	if fe.requests != 1 {
		t.Fatalf("issued %d embed requests for %d nodes, want 1", fe.requests, nodes)
	}
	var chunks int
	if err := ix.db.QueryRow(`select count(*) from chunks`).Scan(&chunks); err != nil {
		t.Fatal(err)
	}
	if chunks != nodes {
		t.Fatalf("indexed %d chunks, want %d", chunks, nodes)
	}
}

// The chunk ceiling must actually split a batch, and every node still lands.
func TestReconcileSplitsOversizedBatch(t *testing.T) {
	v, err := wavevault.OpenVaultAtForTest(context.Background(), t.TempDir())
	if err != nil {
		t.Fatalf("OpenVaultAtForTest: %v", err)
	}
	const nodes = embedBatchChunks + 10
	for i := range nodes {
		id := fmt.Sprintf("n%03d", i)
		writeNode(t, v, "memory/"+id+".md", "---\nid: "+id+"\n---\nalpha content "+id+"\n")
	}
	fe := &fakeEmbedder{dims: 3}
	ix := newTestIndex(t, fe)

	st, err := ix.Reconcile(context.Background(), v)
	if err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	if st.Embedded != nodes {
		t.Fatalf("embedded %d sections, want %d", st.Embedded, nodes)
	}
	if fe.requests != 2 {
		t.Fatalf("issued %d embed requests, want 2 for %d chunks at a %d ceiling", fe.requests, nodes, embedBatchChunks)
	}
	if fe.calls != nodes {
		t.Fatalf("embedded %d texts, want %d — a split must not drop or duplicate", fe.calls, nodes)
	}
}

func TestReconcilePrunesRemoved(t *testing.T) {
	v := seedVault(t)
	ix := newTestIndex(t, &fakeEmbedder{dims: 3})
	if _, err := ix.Reconcile(context.Background(), v); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(v.Root, "memory/one.md")); err != nil {
		t.Fatal(err)
	}
	st, err := ix.Reconcile(context.Background(), v)
	if err != nil {
		t.Fatal(err)
	}
	if st.Pruned == 0 {
		t.Fatal("expected pruned chunks for removed node")
	}
	var n int
	ix.db.QueryRow(`select count(*) from chunks where node_id = 'one'`).Scan(&n)
	if n != 0 {
		t.Fatalf("node 'one' still has %d chunks", n)
	}
}

func TestReconcileModelChangeRebuilds(t *testing.T) {
	v := seedVault(t)
	ix := newTestIndex(t, &fakeEmbedder{dims: 3})
	if _, err := ix.Reconcile(context.Background(), v); err != nil {
		t.Fatal(err)
	}
	// Swap to a different model tag -> full rebuild.
	ix.emb = &renamedFakeEmbedder{fakeEmbedder{dims: 3}}
	st, err := ix.Reconcile(context.Background(), v)
	if err != nil {
		t.Fatal(err)
	}
	if !st.Rebuilt {
		t.Fatal("expected Rebuilt on model change")
	}
}

type renamedFakeEmbedder struct{ fakeEmbedder }

func (r *renamedFakeEmbedder) Model() string { return "other-model" }
