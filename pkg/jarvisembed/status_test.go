// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvisembed

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/wavevault"
)

func TestClassifyIndexStateModelMismatchOutranksHashes(t *testing.T) {
	// a mismatched model tag invalidates every hash comparison, so it must win even when the hashes agree.
	state, reason := classifyIndexState("new-model", "old-model", 10, 10, 0)
	if state != IndexState_Stale || reason != IndexReason_ModelMismatch {
		t.Fatalf("state=%q reason=%q, want stale/model-mismatch", state, reason)
	}
}

func TestClassifyIndexState(t *testing.T) {
	tests := []struct {
		name                                 string
		configured, indexed                  string
		indexedNodes, vaultNodes, staleNodes int
		wantState, wantReason                string
	}{
		{"empty vault agrees with empty index", "m", "", 0, 0, 0, IndexState_OK, ""},
		{"nothing indexed yet", "m", "m", 0, 5, 5, IndexState_Stale, IndexReason_NotBuilt},
		{"one edited note", "m", "m", 5, 5, 1, IndexState_Stale, IndexReason_ContentDrift},
		{"fully reconciled", "m", "m", 5, 5, 0, IndexState_OK, ""},
		{"untagged index is not a mismatch", "m", "", 5, 5, 0, IndexState_OK, ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			state, reason := classifyIndexState(tt.configured, tt.indexed, tt.indexedNodes, tt.vaultNodes, tt.staleNodes)
			if state != tt.wantState || reason != tt.wantReason {
				t.Fatalf("state=%q reason=%q, want %q/%q", state, reason, tt.wantState, tt.wantReason)
			}
		})
	}
}

// indexedHashes is the read the drift check is built on: it must report exactly the hashes Reconcile wrote,
// one row per node, or every drift verdict is fiction.
func TestIndexedHashesMirrorsReconcile(t *testing.T) {
	v := seedVault(t) // memory/one.md, tasks/active/two.md
	ix := newTestIndex(t, &fakeEmbedder{dims: 3})
	ctx := context.Background()
	if _, err := ix.Reconcile(ctx, v); err != nil {
		t.Fatalf("reconcile: %v", err)
	}

	indexed, indexedModel, dims, err := ix.indexedHashes(ctx)
	if err != nil {
		t.Fatalf("indexedHashes: %v", err)
	}
	if indexedModel != "fake-model" {
		t.Fatalf("indexedModel = %q, want fake-model", indexedModel)
	}
	if dims != 3 {
		t.Fatalf("dims = %d, want 3", dims)
	}
	if len(indexed) != 2 {
		t.Fatalf("indexed nodes = %d, want 2 (%v)", len(indexed), indexed)
	}
	nodes, err := v.Retriever(allScopeForTest()).Query(wavevault.Filter{})
	if err != nil {
		t.Fatalf("vault query: %v", err)
	}
	for _, n := range nodes {
		if indexed[n.ID] != n.ContentHash {
			t.Fatalf("node %q indexed hash %q != vault hash %q", n.ID, indexed[n.ID], n.ContentHash)
		}
	}

	// an edit is what a drift check must catch: the vault hash moves, the index still holds the old one.
	writeNode(t, v, "memory/one.md", "---\nid: one\n---\n## A\nalpha content edited\n")
	fresh, err := v.Retriever(allScopeForTest()).Query(wavevault.Filter{})
	if err != nil {
		t.Fatalf("vault re-query: %v", err)
	}
	stale := 0
	for _, n := range fresh {
		if indexed[n.ID] != n.ContentHash {
			stale++
		}
	}
	if stale != 1 {
		t.Fatalf("stale nodes after one edit = %d, want 1", stale)
	}
}

// A configured endpoint that fails is the invisible degradation the status read exists for, so the record
// must survive the call and must not outlive the configuration it was observed against.
func TestProviderFailureIsRecordedAndScoped(t *testing.T) {
	t.Cleanup(func() { noteProviderResult("", "", nil) })
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer srv.Close()

	e := &openAICompatEmbedder{baseURL: srv.URL, model: "test-model", key: "bad-key", hc: http.DefaultClient}
	if _, err := e.Embed(context.Background(), []string{"a"}); err == nil {
		t.Fatal("expected a 401 to surface as an error")
	}
	got, ts := lastProviderError(srv.URL, "test-model")
	if got == "" {
		t.Fatal("a failed provider call was not recorded")
	}
	if ts == 0 {
		t.Fatal("recorded failure has no timestamp")
	}
	if other, _ := lastProviderError(srv.URL, "other-model"); other != "" {
		t.Fatalf("failure leaked to another model: %q", other)
	}
	if other, _ := lastProviderError("http://elsewhere", "test-model"); other != "" {
		t.Fatalf("failure leaked to another endpoint: %q", other)
	}
}

func TestProviderSuccessClearsFailure(t *testing.T) {
	t.Cleanup(func() { noteProviderResult("", "", nil) })
	noteProviderResult("http://x", "m", errors.New("boom"))
	if got, _ := lastProviderError("http://x", "m"); got == "" {
		t.Fatal("precondition: failure should be recorded")
	}
	noteProviderResult("http://x", "m", nil)
	if got, _ := lastProviderError("http://x", "m"); got != "" {
		t.Fatalf("success did not clear the failure: %q", got)
	}
}

// A cancelled reconcile is the caller giving up; recording it would make a timed-out build look like an
// unreachable endpoint and pin the creature to "cannot see" for the rest of the session.
func TestCancelledEmbedIsNotAProviderFailure(t *testing.T) {
	t.Cleanup(func() { noteProviderResult("", "", nil) })
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	defer srv.Close()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	e := &openAICompatEmbedder{baseURL: srv.URL, model: "test-model", key: "k", hc: http.DefaultClient}
	if _, err := e.Embed(ctx, []string{"a"}); err == nil {
		t.Fatal("expected a cancelled request to error")
	}
	if got, _ := lastProviderError(srv.URL, "test-model"); got != "" {
		t.Fatalf("cancellation recorded as a provider failure: %q", got)
	}
}
