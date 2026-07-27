// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvisembed

import (
	"context"
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
