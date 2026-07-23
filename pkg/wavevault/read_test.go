// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wavevault

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

// seedVault writes fixture files into a freshly opened vault and returns it.
func seedVault(t *testing.T) *Vault {
	t.Helper()
	v, err := openVaultAt(context.Background(), t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	write := func(rel, content string) {
		p := filepath.Join(v.Root, rel)
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("memory/m-1.md", "---\nid: m-1\n---\n\nWorktrees are flaky; prefer native isolation. [[m-2]]\n")
	write("memory/m-2.md", "---\nid: m-2\n---\n\nNative isolation note.\n")
	write("tasks/active/t-1.md", "---\nid: t-1\nstatus: active\n---\n\nDrop worktrees. [[m-1]]\n")
	write("decisions/d-1.md", "---\nid: d-1\nstatus: accepted\n---\n\nWe dropped worktrees.\n")
	return v
}

func TestQueryByFrontmatter(t *testing.T) {
	v := seedVault(t)
	got, err := v.Retriever(AllScope()).Query(Filter{FrontmatterEquals: map[string]string{"status": "active"}})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].ID != "t-1" {
		t.Fatalf("Query status=active = %v, want [t-1]", ids(got))
	}
}

func TestSearchFullText(t *testing.T) {
	v := seedVault(t)
	hits, err := v.Retriever(AllScope()).Search("flaky")
	if err != nil {
		t.Fatal(err)
	}
	if len(hits) != 1 || hits[0].Node.ID != "m-1" {
		t.Fatalf("Search flaky = %v, want [m-1]", hitIDs(hits))
	}
	if hits[0].Snippet == "" {
		t.Fatal("expected a non-empty snippet")
	}
}

func TestReadReturnsBody(t *testing.T) {
	v := seedVault(t)
	nb, err := v.Retriever(AllScope()).Read("d-1")
	if err != nil {
		t.Fatal(err)
	}
	if nb.Node.ID != "d-1" || nb.Body == "" {
		t.Fatalf("Read d-1 = %+v", nb)
	}
}

func TestWorkerScopeCannotSeeTasks(t *testing.T) {
	v := seedVault(t)
	// interactive scope sees the task...
	if _, err := v.Retriever(AllScope()).Read("t-1"); err != nil {
		t.Fatalf("AllScope should see t-1: %v", err)
	}
	// ...worker scope physically cannot.
	if _, err := v.Retriever(WorkerScope()).Read("t-1"); err == nil {
		t.Fatal("WorkerScope must NOT resolve a task node")
	}
	got, err := v.Retriever(WorkerScope()).Query(Filter{})
	if err != nil {
		t.Fatal(err)
	}
	for _, n := range got {
		if n.Collection == CollTasks {
			t.Fatalf("WorkerScope leaked a tasks node: %+v", n)
		}
	}
}

func TestExpandBoundedBFS(t *testing.T) {
	v := seedVault(t) // t-1 -> m-1 -> m-2 ; d-1 has no links
	sg, err := v.Retriever(AllScope()).Expand([]string{"t-1"}, ExpandOpts{Depth: 1, Fanout: 8})
	if err != nil {
		t.Fatal(err)
	}
	// depth 1 from t-1 reaches m-1 (t-1 itself + m-1), NOT m-2 (that is depth 2)
	if !hasNode(sg, "t-1") || !hasNode(sg, "m-1") {
		t.Fatalf("depth-1 should include t-1 and m-1: %v", nodeIDs(sg))
	}
	if hasNode(sg, "m-2") {
		t.Fatalf("m-2 is depth 2 and must be excluded at depth 1: %v", nodeIDs(sg))
	}
	// depth 2 now reaches m-2
	sg2, _ := v.Retriever(AllScope()).Expand([]string{"t-1"}, ExpandOpts{Depth: 2, Fanout: 8})
	if !hasNode(sg2, "m-2") {
		t.Fatalf("depth-2 should include m-2: %v", nodeIDs(sg2))
	}
}

func TestExpandUnknownSeedIsEmpty(t *testing.T) {
	v := seedVault(t)
	sg, err := v.Retriever(AllScope()).Expand([]string{"nope"}, ExpandOpts{Depth: 3})
	if err != nil {
		t.Fatal(err)
	}
	if len(sg.Nodes) != 0 {
		t.Fatalf("unknown seed should yield no nodes: %v", nodeIDs(sg))
	}
}

func hasNode(sg *Subgraph, id string) bool {
	for _, n := range sg.Nodes {
		if n.ID == id {
			return true
		}
	}
	return false
}
func nodeIDs(sg *Subgraph) []string {
	out := make([]string, len(sg.Nodes))
	for i, n := range sg.Nodes {
		out[i] = n.ID
	}
	return out
}

func ids(ns []Node) []string {
	out := make([]string, len(ns))
	for i, n := range ns {
		out[i] = n.ID
	}
	return out
}
func hitIDs(hs []Hit) []string {
	out := make([]string, len(hs))
	for i, h := range hs {
		out[i] = h.Node.ID
	}
	return out
}
