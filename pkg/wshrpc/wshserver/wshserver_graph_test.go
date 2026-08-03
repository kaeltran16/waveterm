// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/jarvisattrib"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wavevault"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

func seedGraphVault(t *testing.T) *wavevault.Vault {
	t.Helper()
	v, err := wavevault.OpenVaultAtForTest(context.Background(), t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	write := func(rel, content string) {
		if err := os.WriteFile(filepath.Join(v.Root, rel), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("tasks/active/t-1.md", "---\nid: t-1\nstatus: active\nobjective: drop worktrees\n---\n\nbody [[m-1]]\n")
	write("memory/m-1.md", "---\nid: m-1\n---\n\nWorktrees flaky.\n")
	write("decisions/d-1.md", "---\nid: d-1\nstatus: accepted\ntitle: worktree call\n---\n\nrationale\n")
	return v
}

func TestVaultGraphProjectsNodesAndWikilinks(t *testing.T) {
	v := seedGraphVault(t)
	rtn, err := vaultGraph(v)
	if err != nil {
		t.Fatalf("vaultGraph: %v", err)
	}
	if len(rtn.Nodes) != 3 {
		t.Fatalf("nodes = %d, want 3", len(rtn.Nodes))
	}
	byId := map[string]struct{ kind, label, status string }{}
	for _, n := range rtn.Nodes {
		byId[n.Id] = struct{ kind, label, status string }{n.Kind, n.Label, n.Status}
	}
	if byId["t-1"].kind != "task" || byId["t-1"].label != "drop worktrees" || byId["t-1"].status != "active" {
		t.Fatalf("t-1 = %+v, want kind=task label='drop worktrees' status=active", byId["t-1"])
	}
	if byId["d-1"].kind != "decision" || byId["d-1"].label != "worktree call" {
		t.Fatalf("d-1 = %+v, want kind=decision label='worktree call'", byId["d-1"])
	}
	if byId["m-1"].kind != "memory" || byId["m-1"].label != "m-1" { // no title frontmatter -> id fallback
		t.Fatalf("m-1 = %+v, want kind=memory label=m-1", byId["m-1"])
	}
	if len(rtn.Links) != 1 || rtn.Links[0].From != "t-1" || rtn.Links[0].To != "m-1" || rtn.Links[0].Kind != "wikilink" {
		t.Fatalf("links = %+v, want [t-1 -> m-1 wikilink]", rtn.Links)
	}
}

func TestBuildDossierGraphMapsRunsAndTypedEdges(t *testing.T) {
	// Layers is what the display bucket is read off, and mergeInto derives Confidence/Provenance from
	// it, so an edge without Layers is one the engine cannot produce. Set all three consistently.
	edges := []jarvisattrib.AttributedEdge{
		{DossierID: "task-1", RunORef: "run:r1", Layers: []int{1}, Provenance: "dispatch", Confidence: 1.0, State: jarvisattrib.StateConfirmed},
		{DossierID: "task-1", RunORef: "run:r2", Layers: []int{4}, Provenance: "semantic", Confidence: 0.2, State: jarvisattrib.StateInforming},
		{DossierID: "task-1", RunORef: "run:missing", Layers: []int{3}, Provenance: "structural", Confidence: 0.3, State: jarvisattrib.StateInforming},
	}
	byORef := map[string]*waveobj.Run{
		"run:r1": {OID: "r1", Goal: "add PKCE", Status: "done"},
		"run:r2": {OID: "r2", Goal: "refactor auth", Status: "executing"},
	}
	got := buildDossierGraph("task-1", edges, byORef)

	// two run nodes (missing run contributes an edge but no node).
	if len(got.Runs) != 2 {
		t.Fatalf("runs = %d, want 2 (r1,r2; missing skipped): %+v", len(got.Runs), got.Runs)
	}
	byId := map[string]wshrpc.GraphNode{}
	for _, n := range got.Runs {
		byId[n.Id] = n
	}
	if byId["run:r1"].Kind != "run" || byId["run:r1"].Label != "add PKCE" || byId["run:r1"].Status != "done" {
		t.Fatalf("run:r1 = %+v, want kind=run label='add PKCE' status=done", byId["run:r1"])
	}
	// three attribution edges (all edges surfaced, incl. the one to the missing run).
	if len(got.Links) != 3 {
		t.Fatalf("links = %d, want 3", len(got.Links))
	}
	byTo := map[string]wshrpc.GraphLink{}
	for _, l := range got.Links {
		if l.From != "task-1" || l.Kind != "attribution" {
			t.Fatalf("link from/kind = %+v, want from=task-1 kind=attribution", l)
		}
		byTo[l.To] = l
	}
	if byTo["run:r1"].Bucket != "strong" || byTo["run:r1"].State != "confirmed" || byTo["run:r1"].Provenance != "dispatch" {
		t.Fatalf("edge->r1 = %+v, want bucket=strong state=confirmed provenance=dispatch", byTo["run:r1"])
	}
	if byTo["run:r2"].Bucket != "weak" || byTo["run:r2"].State != "informing" || byTo["run:r2"].Provenance != "semantic" {
		t.Fatalf("edge->r2 = %+v, want bucket=weak state=informing provenance=semantic", byTo["run:r2"])
	}
}
