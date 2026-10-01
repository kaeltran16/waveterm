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

func TestScopeWithoutTasksCannotSeeTasks(t *testing.T) {
	v := seedVault(t)
	noTasks := Scope{Collections: []string{CollMemory, CollDecisions}}
	// interactive scope sees the task...
	if _, err := v.Retriever(AllScope()).Read("t-1"); err != nil {
		t.Fatalf("AllScope should see t-1: %v", err)
	}
	// ...a scope without tasks physically cannot.
	if _, err := v.Retriever(noTasks).Read("t-1"); err == nil {
		t.Fatal("a scope without tasks must NOT resolve a task node")
	}
	got, err := v.Retriever(noTasks).Query(Filter{})
	if err != nil {
		t.Fatal(err)
	}
	for _, n := range got {
		if n.Collection == CollTasks {
			t.Fatalf("a scope without tasks leaked a tasks node: %+v", n)
		}
	}
}

func TestGraphReturnsAllNodesAndResolvedEdges(t *testing.T) {
	v := seedVault(t)
	sg, err := v.Retriever(AllScope()).Graph()
	if err != nil {
		t.Fatal(err)
	}
	// seedVault writes m-1, m-2, t-1, d-1 = 4 nodes across memory/tasks/decisions.
	if len(sg.Nodes) != 4 {
		t.Fatalf("Graph nodes = %v, want 4 (m-1,m-2,t-1,d-1)", ids(sg.Nodes))
	}
	// resolved edges: m-1->m-2 and t-1->m-1 (both endpoints in scope); no dangling edge is emitted.
	if len(sg.Edges) != 2 {
		t.Fatalf("Graph edges = %v, want 2 (m-1>m-2, t-1>m-1)", sg.Edges)
	}
	got := map[string]bool{}
	for _, e := range sg.Edges {
		got[e.From+">"+e.To] = true
	}
	if !got["m-1>m-2"] || !got["t-1>m-1"] {
		t.Fatalf("edges = %v, want m-1>m-2 and t-1>m-1", sg.Edges)
	}
}

func TestGraphScopeExcludesTasks(t *testing.T) {
	v := seedVault(t)
	sg, err := v.Retriever(Scope{Collections: []string{CollMemory, CollDecisions}}).Graph()
	if err != nil {
		t.Fatal(err)
	}
	for _, n := range sg.Nodes {
		if n.Collection == CollTasks {
			t.Fatalf("a scope without tasks leaked a tasks node: %+v", n)
		}
	}
}

func ids(ns []Node) []string {
	out := make([]string, len(ns))
	for i, n := range ns {
		out[i] = n.ID
	}
	return out
}
