# Jarvis U3 — Graph surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a new "Graph" cockpit surface rendering the Jarvis vault as a force-directed graph — the wikilink web (task↔decision↔memory) as the base map, with a task's typed attribution edges to its Run objects blooming in on focus.

**Architecture:** Two pure-read wshrpc commands (mirroring U1's cheap-list + lazy-resolve split): `VaultGraphCommand` returns the whole-vault wikilink graph from one `Retriever(AllScope())` scan; `ResolveDossierEdgesCommand` resolves one dossier's `EdgesFor` into Run nodes + typed edges on demand. The frontend is a fork of the existing memory graph (`memgraph.tsx`) — reusing its `react-force-graph-2d` patterns and the pure `memgraphlayout.ts` helpers — with a heterogeneous node model (Markdown nodes + Run nodes) and typed edge styling.

**Tech Stack:** Go (wavevault, jarvisattrib, wshrpc), `task generate` codegen (Go→TS bindings), React 19 + jotai + `react-force-graph-2d`, Tailwind 4 `@theme` tokens, vitest, CDP visual verification.

**Reference (read before starting):**
- Spec: `docs/superpowers/specs/2026-07-24-jarvis-u3-graph-surface-design.md` — the source of every decision here.
- Prior art to fork: `frontend/app/view/agents/memgraph.tsx` (renderer), `frontend/app/view/agents/memgraphlayout.ts` (pure helpers), `frontend/app/view/agents/memstore.ts` (loader pattern).
- U1 backend pattern to mirror: `pkg/wshrpc/wshserver/wshserver_jarvis.go` (`listDossiers`, `ResolveSpaceScopeCommand`, `buildSpaceScope`), `pkg/wshrpc/wshserver/wshserver_space_test.go`.

## Global Constraints

- **Git workflow (STRICT):** NEVER commit or push without explicit user approval. The per-task "Commit" steps below are logical checkpoints; batch them per the user's preference. The spec + this plan **fold into the feature commit** (no standalone docs commit). Do NOT add a Co-Authored-By trailer. On Windows, no PowerShell here-strings in the Bash tool — use `git commit -F` or multiple `-m`.
- **Shared working tree / concurrent U2 work:** `agents.tsx` (SurfaceKey/SURFACE_ORDER), `navrail.tsx`, and `cockpitshell.tsx` already carry **uncommitted U2 changes** (a `"tasks"` SurfaceKey + `TasksSurface`). Stage only your own hunks; re-check `git status`/branch before editing these three files ([[shared-tree-concurrent-edits]]).
- **Never hand-edit generated files:** `pkg/wshrpc/wshclient/wshclient.go`, `frontend/app/store/wshclientapi.ts`, `frontend/types/gotypes.d.ts`. Edit the Go interface + impl, then run `task generate`.
- **tsc gotcha:** typecheck with `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (bare `npx tsc` stack-overflows). Baseline is clean — any error it reports is yours.
- **Colors:** `@theme` tokens in `frontend/tailwindsetup.css` only — never raw hex/rgba in components ([[no-hardcoded-colors-use-theme-tokens]]).
- **No jsdom render tests** for surfaces (standing decision [[surface-render-tests-declined]]): pure logic → vitest; "does it render" → CDP screenshot of the live dev app.
- **Read-only surface:** no editing/detach/model-call/embedding anywhere in U3.

---

### Task 1: `Retriever.Graph()` — expose the whole-vault subgraph

**Files:**
- Modify: `pkg/wavevault/read.go` (add method after `Expand`, ~line 244)
- Test: `pkg/wavevault/read_test.go` (add test; reuse existing `seedVault` helper at line 14)

**Interfaces:**
- Consumes: existing `Retriever.load()`, `graph` (fields `byID`, `order`, `edges`), `Subgraph{Nodes []Node; Edges []Edge}`.
- Produces: `func (r *Retriever) Graph() (*Subgraph, error)` — every node in insertion order + every resolved wikilink edge for the retriever's scope.

- [ ] **Step 1: Write the failing test**

Add to `pkg/wavevault/read_test.go`:

```go
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
	// resolved edges: m-1->m-2 and t-1->m-1 (both endpoints in scope). t-1's other link resolves;
	// no dangling edge is emitted.
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
	sg, err := v.Retriever(WorkerScope()).Graph() // memory + decisions only
	if err != nil {
		t.Fatal(err)
	}
	for _, n := range sg.Nodes {
		if n.Collection == CollTasks {
			t.Fatalf("WorkerScope leaked a tasks node: %+v", n)
		}
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./pkg/wavevault/ -run TestGraph -v`
Expected: FAIL — `sg.Graph undefined (type *Retriever has no field or method Graph)`.

- [ ] **Step 3: Write minimal implementation**

Add to `pkg/wavevault/read.go` after `Expand`:

```go
// Graph returns the entire scope as a subgraph: every node (insertion order) and every resolved
// wikilink edge — the whole-vault read U3's graph surface renders. Same derived layer Expand walks,
// without a seed/BFS. Dangling links are already excluded (load resolves edges against the node set).
func (r *Retriever) Graph() (*Subgraph, error) {
	if err := r.load(); err != nil {
		return nil, err
	}
	sg := &Subgraph{}
	for _, id := range r.g.order {
		sg.Nodes = append(sg.Nodes, r.g.byID[id])
	}
	sg.Edges = append(sg.Edges, r.g.edges...)
	return sg, nil
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./pkg/wavevault/ -run TestGraph -v`
Expected: PASS (both tests).

- [ ] **Step 5: Run the full package to confirm no regression**

Run: `go test ./pkg/wavevault/`
Expected: `ok  github.com/wavetermdev/waveterm/pkg/wavevault`

- [ ] **Step 6: Commit**

```bash
git add pkg/wavevault/read.go pkg/wavevault/read_test.go
git commit -m "feat(jarvis): U3 wavevault Retriever.Graph (whole-scope subgraph)"
```

---

### Task 2: `VaultGraphCommand` — the base wikilink map

**Files:**
- Modify: `pkg/wshrpc/wshrpctypes_jarvis.go` (add `GraphNode`, `GraphLink`, `CommandVaultGraphRtnData` types + interface method)
- Modify: `pkg/wshrpc/wshserver/wshserver_jarvis.go` (add `VaultGraphCommand` + `vaultGraph` core + `nodeKind`/`nodeLabel`/`vaultNodeToGraphNode` helpers)
- Test: `pkg/wshrpc/wshserver/wshserver_graph_test.go` (create)
- Generated (via `task generate`, do not hand-edit): `wshclient.go`, `wshclientapi.ts`, `gotypes.d.ts`

**Interfaces:**
- Consumes: `wavevault.OpenVault`, `Retriever.Graph()` (Task 1), `wavevault.Node` (fields `ID`, `Collection`, `Frontmatter map[string]any`, `UpdatedTs`), `wavevault.AllScope()`, `CollTasks`/`CollDecisions`/`CollMemory`.
- Produces:
  - `type GraphNode struct { Id, Kind, Label, Status string; Updated int64 }`
  - `type GraphLink struct { From, To, Kind, Provenance, Bucket, State string }`
  - `type CommandVaultGraphRtnData struct { Nodes []GraphNode; Links []GraphLink }`
  - `VaultGraphCommand(ctx) (*CommandVaultGraphRtnData, error)`
  - unexported core `vaultGraph(v *wavevault.Vault) (*wshrpc.CommandVaultGraphRtnData, error)` and `vaultNodeToGraphNode(n wavevault.Node) wshrpc.GraphNode` (reused by Task 3's test expectations for node shape).

- [ ] **Step 1: Add the wire types**

In `pkg/wshrpc/wshrpctypes_jarvis.go`, after the `SpaceScope` struct (~line 139) add:

```go
// GraphNode is one node in the vault graph surface (U3). Kind: task|decision|memory|run.
// Status is frontmatter-derived (absent for memory notes and runs use their run status).
type GraphNode struct {
	Id      string `json:"id"`
	Kind    string `json:"kind"`
	Label   string `json:"label"`
	Status  string `json:"status,omitempty"`
	Updated int64  `json:"updated,omitempty"`
}

// GraphLink is one edge. Kind: wikilink|attribution. Provenance/Bucket/State are set only on
// attribution edges (dossier->run, from D's EdgesFor); wikilinks leave them empty.
type GraphLink struct {
	From       string `json:"from"`
	To         string `json:"to"`
	Kind       string `json:"kind"`
	Provenance string `json:"provenance,omitempty"`
	Bucket     string `json:"bucket,omitempty"`
	State      string `json:"state,omitempty"`
}

type CommandVaultGraphRtnData struct {
	Nodes []GraphNode `json:"nodes"`
	Links []GraphLink `json:"links"`
}
```

- [ ] **Step 2: Add the interface method**

In the `JarvisCommands interface` (~line 12), add after `ResolveSpaceScopeCommand`:

```go
	VaultGraphCommand(ctx context.Context) (*CommandVaultGraphRtnData, error) // whole-vault wikilink graph (U3 base canvas): all vault nodes + resolved [[links]], no runs/attribution
```

- [ ] **Step 3: Write the failing test**

Create `pkg/wshrpc/wshserver/wshserver_graph_test.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/wavevault"
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
```

- [ ] **Step 4: Run test to verify it fails**

Run: `go test ./pkg/wshrpc/wshserver/ -run TestVaultGraph -v`
Expected: FAIL — `undefined: vaultGraph`.

- [ ] **Step 5: Write the implementation**

In `pkg/wshrpc/wshserver/wshserver_jarvis.go`, after `ResolveSpaceScopeCommand`/`buildSpaceScope` (~line 404) add:

```go
func (ws *WshServer) VaultGraphCommand(ctx context.Context) (*wshrpc.CommandVaultGraphRtnData, error) {
	v, err := wavevault.OpenVault(ctx)
	if err != nil {
		return nil, fmt.Errorf("opening vault: %w", err)
	}
	return vaultGraph(v)
}

// vaultGraph is the vault-backed core (testable with an explicit vault): every vault node projected to
// a GraphNode plus the resolved wikilink edges. No runs, no attribution — those bloom via ResolveDossierEdges.
func vaultGraph(v *wavevault.Vault) (*wshrpc.CommandVaultGraphRtnData, error) {
	sg, err := v.Retriever(wavevault.AllScope()).Graph()
	if err != nil {
		return nil, fmt.Errorf("reading vault graph: %w", err)
	}
	out := &wshrpc.CommandVaultGraphRtnData{Nodes: []wshrpc.GraphNode{}, Links: []wshrpc.GraphLink{}}
	for _, n := range sg.Nodes {
		out.Nodes = append(out.Nodes, vaultNodeToGraphNode(n))
	}
	for _, e := range sg.Edges {
		out.Links = append(out.Links, wshrpc.GraphLink{From: e.From, To: e.To, Kind: "wikilink"})
	}
	return out, nil
}

func nodeKind(collection string) string {
	switch collection {
	case wavevault.CollTasks:
		return "task"
	case wavevault.CollDecisions:
		return "decision"
	default:
		return "memory"
	}
}

// nodeLabel is the human label: a task's objective, else a frontmatter title, else the id.
func nodeLabel(n wavevault.Node, kind string) string {
	if kind == "task" {
		if s, ok := n.Frontmatter["objective"].(string); ok && s != "" {
			return s
		}
	}
	if s, ok := n.Frontmatter["title"].(string); ok && s != "" {
		return s
	}
	return n.ID
}

func vaultNodeToGraphNode(n wavevault.Node) wshrpc.GraphNode {
	kind := nodeKind(n.Collection)
	gn := wshrpc.GraphNode{Id: n.ID, Kind: kind, Label: nodeLabel(n, kind), Updated: n.UpdatedTs}
	if s, ok := n.Frontmatter["status"].(string); ok {
		gn.Status = s
	}
	return gn
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `go test ./pkg/wshrpc/wshserver/ -run TestVaultGraph -v`
Expected: PASS.

- [ ] **Step 7: Regenerate bindings**

Run: `task generate`
Expected: exit 0; `git status` shows modified `wshclient.go`, `wshclientapi.ts`, `gotypes.d.ts`. Confirm `wshclientapi.ts` now has `VaultGraphCommand(client: WshClient, opts?: RpcOpts): Promise<CommandVaultGraphRtnData>` and `gotypes.d.ts` has `GraphNode`, `GraphLink`, `CommandVaultGraphRtnData`.

- [ ] **Step 8: Build the backend to confirm codegen is consistent**

Run: `go build ./pkg/...`
Expected: exit 0.

- [ ] **Step 9: Commit**

```bash
git add pkg/wshrpc/wshrpctypes_jarvis.go pkg/wshrpc/wshserver/wshserver_jarvis.go pkg/wshrpc/wshserver/wshserver_graph_test.go pkg/wshrpc/wshclient/wshclient.go frontend/app/store/wshclientapi.ts frontend/types/gotypes.d.ts
git commit -m "feat(jarvis): U3 VaultGraphCommand (whole-vault wikilink graph)"
```

---

### Task 3: `ResolveDossierEdgesCommand` — the focus bloom

**Files:**
- Modify: `pkg/wshrpc/wshrpctypes_jarvis.go` (add `CommandResolveDossierEdgesData`, `CommandResolveDossierEdgesRtnData` + interface method)
- Modify: `pkg/wshrpc/wshserver/wshserver_jarvis.go` (add `ResolveDossierEdgesCommand` + `buildDossierGraph` pure core)
- Test: `pkg/wshrpc/wshserver/wshserver_graph_test.go` (extend)
- Generated (via `task generate`): `wshclient.go`, `wshclientapi.ts`, `gotypes.d.ts`

**Interfaces:**
- Consumes: `jarvisattrib.EdgesFor(ctx, v, dossierId) ([]jarvisattrib.AttributedEdge, error)`; `jarvisattrib.AttributedEdge` (fields `RunORef string`, `Provenance string`, `Confidence float64`, `State jarvisattrib.EdgeState`); `jarvisattrib.Bucket(c float64) string`; `waveobj.Run` (fields `OID`, `Goal`, `Status`, `CreatedTs`); `wstore.DBGetAllObjsByType[*waveobj.Run]`; `GraphNode`/`GraphLink` (Task 2).
- Produces:
  - `type CommandResolveDossierEdgesData struct { DossierId string }`
  - `type CommandResolveDossierEdgesRtnData struct { Runs []GraphNode; Links []GraphLink }`
  - `ResolveDossierEdgesCommand(ctx, data) (*CommandResolveDossierEdgesRtnData, error)`
  - pure core `buildDossierGraph(dossierId string, edges []jarvisattrib.AttributedEdge, byORef map[string]*waveobj.Run) wshrpc.CommandResolveDossierEdgesRtnData`

- [ ] **Step 1: Add the wire types**

In `pkg/wshrpc/wshrpctypes_jarvis.go`, after `CommandVaultGraphRtnData`:

```go
type CommandResolveDossierEdgesData struct {
	DossierId string `json:"dossierid"`
}

type CommandResolveDossierEdgesRtnData struct {
	Runs  []GraphNode `json:"runs"`
	Links []GraphLink `json:"links"`
}
```

- [ ] **Step 2: Add the interface method**

In `JarvisCommands`, after `VaultGraphCommand`:

```go
	ResolveDossierEdgesCommand(ctx context.Context, data CommandResolveDossierEdgesData) (*CommandResolveDossierEdgesRtnData, error) // a dossier's attributed run nodes + typed attribution edges (U3 focus bloom)
```

- [ ] **Step 3: Write the failing test (pure core)**

Add to `pkg/wshrpc/wshserver/wshserver_graph_test.go`:

```go
func TestBuildDossierGraphMapsRunsAndTypedEdges(t *testing.T) {
	edges := []jarvisattrib.AttributedEdge{
		{DossierID: "task-1", RunORef: "run:r1", Provenance: "dispatch", Confidence: 1.0, State: jarvisattrib.StateConfirmed},
		{DossierID: "task-1", RunORef: "run:r2", Provenance: "semantic", Confidence: 0.2, State: jarvisattrib.StateInforming},
		{DossierID: "task-1", RunORef: "run:missing", Provenance: "structural", Confidence: 0.3, State: jarvisattrib.StateInforming},
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
```

Add `"github.com/wavetermdev/waveterm/pkg/jarvisattrib"`, `"github.com/wavetermdev/waveterm/pkg/waveobj"`, and `"github.com/wavetermdev/waveterm/pkg/wshrpc"` to the test file imports.

- [ ] **Step 4: Run test to verify it fails**

Run: `go test ./pkg/wshrpc/wshserver/ -run TestBuildDossierGraph -v`
Expected: FAIL — `undefined: buildDossierGraph`.

- [ ] **Step 5: Write the implementation**

In `pkg/wshrpc/wshserver/wshserver_jarvis.go`, after `vaultNodeToGraphNode`:

```go
func (ws *WshServer) ResolveDossierEdgesCommand(ctx context.Context, data wshrpc.CommandResolveDossierEdgesData) (*wshrpc.CommandResolveDossierEdgesRtnData, error) {
	if data.DossierId == "" {
		return nil, fmt.Errorf("dossierid is required")
	}
	v, err := wavevault.OpenVault(ctx)
	if err != nil {
		return nil, fmt.Errorf("opening vault: %w", err)
	}
	edges, err := jarvisattrib.EdgesFor(ctx, v, data.DossierId)
	if err != nil {
		return nil, fmt.Errorf("resolving edges: %w", err)
	}
	runs, err := wstore.DBGetAllObjsByType[*waveobj.Run](ctx, waveobj.OType_Run)
	if err != nil {
		return nil, fmt.Errorf("loading runs: %w", err)
	}
	byORef := make(map[string]*waveobj.Run, len(runs))
	for _, run := range runs {
		byORef["run:"+run.OID] = run
	}
	out := buildDossierGraph(data.DossierId, edges, byORef)
	return &out, nil
}

// buildDossierGraph is the pure edge->graph core: one run node per attributed run (skipping a run
// missing from byORef, but still surfacing its edge) and one typed attribution link per edge carrying
// provenance + confidence bucket + state. Order-stable by edge order; dedups run nodes by oref.
func buildDossierGraph(dossierID string, edges []jarvisattrib.AttributedEdge, byORef map[string]*waveobj.Run) wshrpc.CommandResolveDossierEdgesRtnData {
	out := wshrpc.CommandResolveDossierEdgesRtnData{Runs: []wshrpc.GraphNode{}, Links: []wshrpc.GraphLink{}}
	seenRun := map[string]bool{}
	for _, e := range edges {
		out.Links = append(out.Links, wshrpc.GraphLink{
			From:       dossierID,
			To:         e.RunORef,
			Kind:       "attribution",
			Provenance: e.Provenance,
			Bucket:     jarvisattrib.Bucket(e.Confidence),
			State:      string(e.State),
		})
		if seenRun[e.RunORef] {
			continue
		}
		seenRun[e.RunORef] = true
		run := byORef[e.RunORef]
		if run == nil {
			continue // missing run: edge surfaced, node skipped (mirrors buildSpaceScope)
		}
		out.Runs = append(out.Runs, wshrpc.GraphNode{
			Id:      e.RunORef,
			Kind:    "run",
			Label:   run.Goal,
			Status:  run.Status,
			Updated: run.CreatedTs,
		})
	}
	return out
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `go test ./pkg/wshrpc/wshserver/ -run TestBuildDossierGraph -v`
Expected: PASS.

- [ ] **Step 7: Regenerate bindings + build**

Run: `task generate && go build ./pkg/...`
Expected: exit 0; `wshclientapi.ts` now has `ResolveDossierEdgesCommand`; `gotypes.d.ts` has `CommandResolveDossierEdgesData`/`CommandResolveDossierEdgesRtnData`.

- [ ] **Step 8: Run the full server package**

Run: `go test ./pkg/wshrpc/wshserver/`
Expected: `ok`.

- [ ] **Step 9: Commit**

```bash
git add pkg/wshrpc/wshrpctypes_jarvis.go pkg/wshrpc/wshserver/wshserver_jarvis.go pkg/wshrpc/wshserver/wshserver_graph_test.go pkg/wshrpc/wshclient/wshclient.go frontend/app/store/wshclientapi.ts frontend/types/gotypes.d.ts
git commit -m "feat(jarvis): U3 ResolveDossierEdgesCommand (focus-bloom run nodes + typed edges)"
```

---

### Task 4: Frontend store + pure derive helpers

**Files:**
- Create: `frontend/app/view/jarvis/jarvisgraphstore.ts` (atoms + loaders)
- Create: `frontend/app/view/jarvis/jarvisgraphderive.ts` (pure: merge + edge style + render types)
- Test: `frontend/app/view/jarvis/jarvisgraphderive.test.ts`

**Interfaces:**
- Consumes: generated `GraphNode`, `GraphLink`, `CommandVaultGraphRtnData`, `CommandResolveDossierEdgesData`, `CommandResolveDossierEdgesRtnData` (from `gotypes.d.ts`, global); `RpcApi` (`@/app/store/wshclientapi`), `TabRpcClient` (`@/app/store/wshrpcutil`), `globalStore` (`@/app/store/jotaiStore`).
- Produces:
  - render types `GKind`, `GNode`, `GLink` (in `jarvisgraphderive.ts`)
  - `mergeGraph(base, blooms) → { nodes: GraphNode[]; links: GraphLink[] }`, `linkKey(l) → string`, `attributionStyle(l) → { dashed; opacity; width; semantic }`
  - store atoms `graphBaseAtom`, `graphLoadedAtom`, `graphErrorAtom`, `graphSelectedIdAtom`, `graphBloomAtom`; loaders `loadGraph()`, `focusDossier(id)`, `selectNode(id)`

- [ ] **Step 1: Write the failing tests**

Create `frontend/app/view/jarvis/jarvisgraphderive.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { attributionStyle, linkKey, mergeGraph } from "./jarvisgraphderive";

const base = {
    nodes: [
        { id: "t-1", kind: "task", label: "alpha" },
        { id: "m-1", kind: "memory", label: "m-1" },
    ] as GraphNode[],
    links: [{ from: "t-1", to: "m-1", kind: "wikilink" }] as GraphLink[],
};

describe("mergeGraph", () => {
    it("returns the base graph unchanged when no blooms", () => {
        const g = mergeGraph(base, new Map());
        expect(g.nodes.map((n) => n.id)).toEqual(["t-1", "m-1"]);
        expect(g.links).toHaveLength(1);
    });

    it("adds bloomed run nodes and attribution edges, deduping shared runs", () => {
        const blooms = new Map<string, { runs: GraphNode[]; links: GraphLink[] }>([
            ["t-1", { runs: [{ id: "run:r1", kind: "run", label: "g1" }] as GraphNode[], links: [{ from: "t-1", to: "run:r1", kind: "attribution", bucket: "strong", state: "confirmed" }] as GraphLink[] }],
            ["t-2", { runs: [{ id: "run:r1", kind: "run", label: "g1" }] as GraphNode[], links: [{ from: "t-2", to: "run:r1", kind: "attribution", bucket: "weak", state: "informing" }] as GraphLink[] }],
        ]);
        const g = mergeGraph(base, blooms);
        expect(g.nodes.filter((n) => n.id === "run:r1")).toHaveLength(1); // deduped
        expect(g.links).toHaveLength(3); // 1 wikilink + 2 attribution
    });

    it("dedups identical attribution edges by linkKey", () => {
        const l = { from: "t-1", to: "run:r1", kind: "attribution" } as GraphLink;
        const blooms = new Map([["t-1", { runs: [], links: [l, l] }]]);
        expect(mergeGraph({ nodes: [], links: [] }, blooms).links).toHaveLength(1);
    });
});

describe("attributionStyle", () => {
    it("informing -> dashed, confirmed -> solid", () => {
        expect(attributionStyle({ from: "a", to: "b", kind: "attribution", state: "informing" } as GraphLink).dashed).toBe(true);
        expect(attributionStyle({ from: "a", to: "b", kind: "attribution", state: "confirmed" } as GraphLink).dashed).toBe(false);
    });
    it("bucket drives opacity + width; semantic flagged", () => {
        const weakSem = attributionStyle({ from: "a", to: "b", kind: "attribution", bucket: "weak", provenance: "semantic" } as GraphLink);
        expect(weakSem.opacity).toBe(0.35);
        expect(weakSem.semantic).toBe(true);
        expect(attributionStyle({ from: "a", to: "b", kind: "attribution", bucket: "strong" } as GraphLink).opacity).toBe(1);
    });
});

describe("linkKey", () => {
    it("distinguishes wikilink from attribution on the same endpoints", () => {
        expect(linkKey({ from: "a", to: "b", kind: "wikilink" } as GraphLink)).not.toEqual(
            linkKey({ from: "a", to: "b", kind: "attribution" } as GraphLink)
        );
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run frontend/app/view/jarvis/jarvisgraphderive.test.ts`
Expected: FAIL — cannot resolve module `./jarvisgraphderive` (it does not exist yet).

- [ ] **Step 3: Write `jarvisgraphderive.ts` (pure)**

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pure derive for the Jarvis vault graph (U3): render types, the base+bloom merge, and the
// attribution-edge visual mapping. No jotai, no RPC — unit-tested directly.

export type GKind = "task" | "decision" | "memory" | "run";

// force-graph render node: kind + label + degree (drives sizing); x/y are owned by the sim.
export type GNode = { id: string; kind: GKind; label: string; status?: string; deg: number; x?: number; y?: number };

// force-graph render link: source/target are ids pre-sim, node objects post-sim.
export type GLink = {
    source: string | GNode;
    target: string | GNode;
    kind: "wikilink" | "attribution";
    provenance?: string;
    bucket?: string;
    state?: string;
};

// stable identity for an edge (endpoints + kind) — dedup key when merging base + blooms.
export const linkKey = (l: GraphLink) => `${l.from}>${l.to}:${l.kind}`;

// Merge the base wikilink graph with every bloomed dossier's runs+attribution edges. Run nodes dedup
// by id (the same run may attribute to two focused tasks); links dedup by linkKey. Base links keep
// their order; bloomed links append.
export function mergeGraph(
    base: { nodes: GraphNode[]; links: GraphLink[] },
    blooms: Map<string, { runs: GraphNode[]; links: GraphLink[] }>
): { nodes: GraphNode[]; links: GraphLink[] } {
    const nodes = new Map<string, GraphNode>();
    for (const n of base.nodes) nodes.set(n.id, n);
    const links: GraphLink[] = [...base.links];
    const seen = new Set(base.links.map(linkKey));
    for (const { runs, links: elinks } of blooms.values()) {
        for (const r of runs) if (!nodes.has(r.id)) nodes.set(r.id, r);
        for (const l of elinks) {
            const k = linkKey(l);
            if (!seen.has(k)) {
                seen.add(k);
                links.push(l);
            }
        }
    }
    return { nodes: [...nodes.values()], links };
}

// Visual props for an attribution edge: informing -> dashed (provisional), confirmed -> solid;
// bucket -> opacity + width; semantic provenance -> a distinct low-confidence hue (component picks it).
export function attributionStyle(l: GraphLink): { dashed: boolean; opacity: number; width: number; semantic: boolean } {
    const bucket = l.bucket ?? "weak";
    return {
        dashed: l.state === "informing",
        semantic: l.provenance === "semantic",
        opacity: bucket === "strong" ? 1 : bucket === "medium" ? 0.6 : 0.35,
        width: bucket === "strong" ? 1.4 : bucket === "medium" ? 1.0 : 0.7,
    };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run frontend/app/view/jarvis/jarvisgraphderive.test.ts`
Expected: PASS (all describe blocks).

- [ ] **Step 5: Write `jarvisgraphstore.ts`**

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Jarvis graph surface (U3) state + loaders. Module-scope jotai atoms written by async loaders via
// globalStore (mirrors memstore/spacestore), so state survives the nav-switch unmount. Snapshot
// semantics: the base graph loads once per open; a dossier's attribution blooms lazily on focus and
// is cached. No live push this cycle.

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { atom, type PrimitiveAtom } from "jotai";

// vault scan/read are local FS ops; bound them so a dead backend rejects instead of hanging on "Loading…".
const GRAPH_RPC_TIMEOUT_MS = 5000;

export const graphBaseAtom = atom<{ nodes: GraphNode[]; links: GraphLink[] } | null>(null) as PrimitiveAtom<{
    nodes: GraphNode[];
    links: GraphLink[];
} | null>;
export const graphLoadedAtom = atom(false) as PrimitiveAtom<boolean>;
export const graphErrorAtom = atom(false) as PrimitiveAtom<boolean>;
export const graphSelectedIdAtom = atom<string | null>(null) as PrimitiveAtom<string | null>;
export const graphBloomAtom = atom<Map<string, { runs: GraphNode[]; links: GraphLink[] }>>(new Map()) as PrimitiveAtom<
    Map<string, { runs: GraphNode[]; links: GraphLink[] }>
>;

export async function loadGraph(): Promise<void> {
    try {
        const g = await RpcApi.VaultGraphCommand(TabRpcClient, { timeout: GRAPH_RPC_TIMEOUT_MS });
        globalStore.set(graphBaseAtom, { nodes: g.nodes ?? [], links: g.links ?? [] });
        globalStore.set(graphErrorAtom, false);
        globalStore.set(graphLoadedAtom, true);
    } catch {
        globalStore.set(graphErrorAtom, true);
        globalStore.set(graphLoadedAtom, true);
    }
}

// Select a node. For a task, also resolve + cache its attribution bloom; other kinds just select.
export function selectNode(id: string | null): void {
    globalStore.set(graphSelectedIdAtom, id);
}

export async function focusDossier(dossierId: string): Promise<void> {
    globalStore.set(graphSelectedIdAtom, dossierId);
    const bloom = globalStore.get(graphBloomAtom);
    if (bloom.has(dossierId)) return; // cached
    try {
        const r = await RpcApi.ResolveDossierEdgesCommand(
            TabRpcClient,
            { dossierid: dossierId },
            { timeout: GRAPH_RPC_TIMEOUT_MS }
        );
        const next = new Map(bloom);
        next.set(dossierId, { runs: r.runs ?? [], links: r.links ?? [] });
        globalStore.set(graphBloomAtom, next);
    } catch {
        // leave the dossier selected with no bloom; failure is non-fatal (graceful degradation).
    }
}
```

- [ ] **Step 6: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0 (clean baseline). Fix any error in the new files.

- [ ] **Step 7: Commit**

```bash
git add frontend/app/view/jarvis/jarvisgraphstore.ts frontend/app/view/jarvis/jarvisgraphderive.ts frontend/app/view/jarvis/jarvisgraphderive.test.ts
git commit -m "feat(jarvis): U3 graph store + pure merge/edge-style derive"
```

---

### Task 5: Nav surface wiring + surface wrapper (loading/empty/error)

**Files:**
- Modify: `frontend/app/view/agents/agents.tsx:29` (`SurfaceKey` union) and `:43` (`SURFACE_ORDER`)
- Modify: `frontend/app/view/agents/navrail.tsx` (`ICON` map + `ITEMS`)
- Modify: `frontend/app/view/agents/cockpitshell.tsx` (import + render branch)
- Create: `frontend/app/view/jarvis/jarvisgraphsurface.tsx`
- Add theme tokens: `frontend/tailwindsetup.css` (near the `--color-mem-*` block, ~line 97)

**Interfaces:**
- Consumes: `graphBaseAtom`, `graphLoadedAtom`, `graphErrorAtom`, `loadGraph` (Task 4); `AgentsViewModel` (for the surface signature, though the graph reads only its own atoms).
- Produces: `SurfaceKey` gains `"graph"`; `JarvisGraphSurface` component (default export or named — match sibling surfaces, which are named exports).

> **Shared-tree caution:** these three `agents/` files carry uncommitted U2 (`"tasks"`) edits. Add `"graph"` alongside — do not remove/reorder `"tasks"`. Stage only your hunks.

> **Placement consequence (decide before Step 2):** the spec places Graph after Jarvis, so `SURFACE_ORDER` gains `"graph"` at index 2 — which shifts the `Ctrl+N` surface shortcut for every surface after it (Agent `Ctrl+3`→`Ctrl+4`, etc.). If that muscle-memory churn is unwanted, the alternative (matching how U2 appended `"tasks"`) is to place `"graph"` next to `"memory"` near the end of both `ITEMS` and `SURFACE_ORDER` — Graph sits by the other graph surface and only later numbers shift. The steps below follow the spec (after Jarvis); swap the insertion index if you prefer the append.

- [ ] **Step 1: Add theme tokens**

In `frontend/tailwindsetup.css`, after the `--color-mem-user` line (~100):

```css
    --color-graph-task: #8aa0ff; /* task/dossier — decision-blue */
    --color-graph-decision: #54c79a; /* decision node — fact-green */
    --color-graph-memory: #a78bfa; /* memory note — preference-purple */
    --color-graph-run: #e6b450; /* run evidence — amber */
    --color-graph-semantic: #d98cff; /* L4 semantic attribution edge hue */
```

- [ ] **Step 2: Extend `SurfaceKey` + `SURFACE_ORDER`**

In `frontend/app/view/agents/agents.tsx`, add `| "graph"` to the `SurfaceKey` union (after `"jarvis"`), and insert `"graph"` into `SURFACE_ORDER` right after `"jarvis"`:

```ts
export type SurfaceKey =
    | "cockpit"
    | "jarvis"
    | "graph"
    | "agent"
    // …rest unchanged (including U2's "tasks")
```

```ts
export const SURFACE_ORDER: SurfaceKey[] = [
    "cockpit",
    "jarvis",
    "graph",
    "agent",
    // …rest unchanged
];
```

- [ ] **Step 3: Add the nav-rail icon + item**

In `frontend/app/view/agents/navrail.tsx`: add `Waypoints` to the lucide import; add to `ICON` and `ITEMS`:

```ts
// import: add Waypoints to the existing lucide-react import list
graph: <Waypoints {...iconProps} />,   // in ICON, after `jarvis:`
```

```ts
{ key: "graph", label: "Graph" },   // in ITEMS, after the jarvis entry
```

- [ ] **Step 4: Write the surface wrapper**

Create `frontend/app/view/jarvis/jarvisgraphsurface.tsx`:

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect } from "react";
import { graphBaseAtom, graphErrorAtom, graphLoadedAtom, loadGraph } from "./jarvisgraphstore";

export function JarvisGraphSurface() {
    const base = useAtomValue(graphBaseAtom);
    const loaded = useAtomValue(graphLoadedAtom);
    const error = useAtomValue(graphErrorAtom);

    useEffect(() => {
        if (!loaded) fireAndForget(loadGraph);
    }, [loaded]);

    if (!loaded) {
        return <div className="flex h-full items-center justify-center text-[13px] text-ink-mid">Loading graph…</div>;
    }
    if (error) {
        return (
            <div className="flex h-full items-center justify-center text-[13px] text-ink-mid">
                Couldn’t read the vault.
            </div>
        );
    }
    if (!base || base.nodes.length === 0) {
        return (
            <div className="flex h-full flex-col items-center justify-center gap-[6px] text-ink-mid">
                <div className="text-[14px] font-semibold text-foreground">No vault yet</div>
                <div className="text-[12px]">Tasks, decisions, and memory appear here as they’re captured.</div>
            </div>
        );
    }
    // JarvisGraph canvas arrives in Task 6; until then render a placeholder count so the surface is wireable.
    return <div className="p-[28px] text-[13px] text-ink-mid">Graph: {base.nodes.length} nodes.</div>;
}
```

- [ ] **Step 5: Wire the render branch**

In `frontend/app/view/agents/cockpitshell.tsx`: add the import and a branch (place after the `jarvis` branch, ~line 105):

```tsx
import { JarvisGraphSurface } from "@/app/view/jarvis/jarvisgraphsurface";
```

```tsx
                        ) : surface === "graph" ? (
                            <JarvisGraphSurface />
```

- [ ] **Step 6: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 7: CDP smoke — the surface appears and loads**

With the dev app running (`task dev`), capture the Graph surface:

Run: `node scripts/cdp-shot.mjs cdp-shots/u3-nav.png` after clicking the Graph rail item (or navigate via `Ctrl+3` since it's third in `SURFACE_ORDER`).
Expected: the nav rail shows a **Graph** item (Waypoints icon) after Jarvis; selecting it shows either the node-count placeholder (vault populated) or the "No vault yet" empty state — never a blank/error frame.

- [ ] **Step 8: Commit**

```bash
git add frontend/app/view/agents/agents.tsx frontend/app/view/agents/navrail.tsx frontend/app/view/agents/cockpitshell.tsx frontend/app/view/jarvis/jarvisgraphsurface.tsx frontend/tailwindsetup.css
git commit -m "feat(jarvis): U3 Graph nav surface + wrapper states + theme tokens"
```

---

### Task 6: `jarvisgraph.tsx` — the base map canvas (fork of memgraph)

**Files:**
- Create: `frontend/app/view/jarvis/jarvisgraph.tsx` (fork of `frontend/app/view/agents/memgraph.tsx`)
- Modify: `frontend/app/view/agents/memgraphlayout.ts` (widen helper param types to a structural edge)
- Modify: `frontend/app/view/jarvis/jarvisgraphsurface.tsx` (mount the canvas)

**Interfaces:**
- Consumes: `memgraphlayout.ts` helpers (`degreeMap`, `degreeRank`, `graphSignature`, `labelBudget`, `labelZoomThreshold`, `seedPosition`, `truncateTitle`, `XY`); `mergeGraph`, `attributionStyle`, `GNode`, `GLink` (Task 4); `graphBaseAtom`, `graphBloomAtom`, `graphSelectedIdAtom`, `selectNode`, `focusDossier` (Task 4).
- Produces: `JarvisGraph` component rendering nodes (colored by kind, runs as squares) + wikilink edges. (Focus-bloom edge styling + selection card land in Task 7.)

- [ ] **Step 1: Widen the layout helpers to a structural edge type**

In `frontend/app/view/agents/memgraphlayout.ts`, replace the `MemEdge` import and the three edge params so both graphs can share them (behavior unchanged — `MemEdge` already has `from`/`to`):

```ts
// replace: import type { MemEdge } from "./memtypes";
type EdgeLike = { from: string; to: string };
```

Change the signatures: `degreeMap(edges: EdgeLike[])`, `seedPosition(id: string, edges: EdgeLike[], cache: Map<string, XY>)`, `graphSignature(nodeIds: string[], edges: EdgeLike[])`.

- [ ] **Step 2: Typecheck (memgraph still compiles against the widened helpers)**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 3: Create `jarvisgraph.tsx` by adapting `memgraph.tsx`**

Copy `frontend/app/view/agents/memgraph.tsx` to `frontend/app/view/jarvis/jarvisgraph.tsx` verbatim, then apply these exact changes:

1. **Header comment** — replace the memory-graph description with: `// Jarvis vault graph (U3): the wikilink web (task/decision/memory) as the base map, with a task's // attributed Run nodes + typed edges blooming in on focus. Forked from memgraph.tsx; shares memgraphlayout.ts.`
2. **Imports** — replace `import { memEdgesAtom, selectNote, selectPending } from "./memstore";` and `import type { MemNote } from "./memtypes";` with:

```ts
import { attributionStyle, mergeGraph, type GKind, type GLink, type GNode } from "./jarvisgraphderive";
import { focusDossier, graphBaseAtom, graphBloomAtom, graphSelectedIdAtom, selectNode } from "./jarvisgraphstore";
import { useAtomValue } from "jotai";
```

Keep the `memgraphlayout` import but add `labelZoomThreshold` if not already imported.

3. **Delete** the local `GNode`/`GLink` type declarations (now imported) and adjust: our `GNode` has `kind` (not `type`) and no `pending`. Our `GLink` carries `kind`/`provenance`/`bucket`/`state`.
4. **`useThemeColors`** — replace the `mem` map with graph-kind colors and add the semantic edge hue:

```ts
const kind: Record<string, string> = {
    task: c("--color-graph-task"),
    decision: c("--color-graph-decision"),
    memory: c("--color-graph-memory"),
    run: c("--color-graph-run"),
};
return {
    fill: (k: string) => kind[k] ?? c("--color-ink-mid"),
    label: c("--color-foreground"),
    labelSoft: c("--color-ink-mid"),
    chip: rgba(c("--color-background"), 0.72),
    chipStrong: rgba(c("--color-background"), 0.92),
    edge: c("--color-ink-faint"),
    edgeHot: c("--color-accent"),
    edgeSemantic: c("--color-graph-semantic"),
    ring: c("--color-foreground"),
    bg: c("--color-background"),
};
```

5. **Component signature + data source** — replace the props (`notes`/`pending`/`filteredIds`/`selectedId`) with atom reads:

```ts
export function JarvisGraph() {
    const base = useAtomValue(graphBaseAtom);
    const blooms = useAtomValue(graphBloomAtom);
    const selectedId = useAtomValue(graphSelectedIdAtom);
    const colors = useThemeColors();
    // …keep all the refs/state from memgraph…
```

6. **`data` memo** — replace the notes/pending build with the merged graph. Compute the signature from merged nodes+links:

```ts
const merged = useMemo(() => mergeGraph(base ?? { nodes: [], links: [] }, blooms), [base, blooms]);
const sig = graphSignature(merged.nodes.map((n) => n.id), merged.links);
const data = useMemo(() => {
    const deg = degreeMap(merged.links);
    const nodes: GNode[] = merged.nodes.map((n) => {
        const seed = seedPosition(n.id, merged.links, posCache);
        return { id: n.id, kind: n.kind as GKind, label: n.label, status: n.status, deg: deg.get(n.id) ?? 0, ...(seed ?? {}) };
    });
    const links: GLink[] = merged.links.map((e) => ({ source: e.from, target: e.to, kind: e.kind, provenance: e.provenance, bucket: e.bucket, state: e.state }));
    return { nodes, links, rank: degreeRank(nodes) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
}, [sig]);
```

7. **`paintNode`** — remove all `filteredIds`/search-dim and `pending` branches (U3 has no search yet). Use `node.kind` for the fill and `node.label` for the label (replace `node.title` → `node.label`, `node.type` → `node.kind`). Render **run nodes as a square** instead of a circle:

```ts
if (node.kind === "run") {
    const s = r * 1.6;
    ctx.fillStyle = colors.fill(node.kind);
    ctx.fillRect(node.x! - s, node.y! - s, s * 2, s * 2);
} else {
    ctx.beginPath();
    ctx.arc(node.x!, node.y!, r, 0, 2 * Math.PI);
    ctx.fillStyle = colors.fill(node.kind);
    ctx.fill();
}
```

Keep the selection ring + hover halo logic (they key off `selectedId`/`hoverIdRef`). Drop the `searchDim`/`inFocus` alpha term to just the hover/degree terms: `const targetA = focused ? (inFocus ? 1 : 0.12) : node.deg > 0 ? 1 : 0.55;`

8. **`linkColor`/`linkWidth`** — Task 6 keeps these as memgraph's plain wikilink styling (drop the `filteredIds` branch). Typed-edge styling comes in Task 7; for now every link renders with the base edge color.
9. **`onNodeClick`** — replace with:

```ts
onNodeClick={((node: GNode) => {
    if (node.kind === "task") fireAndForget(() => focusDossier(node.id));
    else selectNode(node.id);
}) as any}
```

10. **`paintPointerArea`** — drop the `filteredIds` guard (all nodes clickable).
11. **Legend overlay** — replace the memory legend with the node kinds:

```tsx
{(["task", "decision", "memory", "run"] as const).map((k) => (
    <div key={k} className="flex items-center gap-[6px]">
        <div className="h-[8px] w-[8px]" style={{ background: colors.fill(k), borderRadius: k === "run" ? 0 : 9999 }} />
        <span className="font-mono text-[10.5px] capitalize text-ink-mid">{k}</span>
    </div>
))}
```

Remove the `MemGraph` export name; export `JarvisGraph`. Remove `useSettle`/`settling` only if unused after edits (keep if retained).

- [ ] **Step 4: Mount the canvas in the surface**

In `frontend/app/view/jarvis/jarvisgraphsurface.tsx`, replace the Task-5 placeholder return with:

```tsx
import { JarvisGraph } from "./jarvisgraph";
// …
    return (
        <div className="relative h-full w-full">
            <JarvisGraph />
        </div>
    );
```

- [ ] **Step 5: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 6: CDP visual — base map renders**

With `task dev` running and a populated `~/.waveterm/vault`, navigate to the Graph surface and capture:

Run: `node scripts/cdp-shot.mjs cdp-shots/u3-basemap.png`
Expected: a force-directed graph of task/decision/memory nodes (three distinct colors, circles), wikilink edges between them, degree-ranked labels at fit zoom, the zoom controls + node-kind legend overlays. No Run nodes yet (bloom is Task 7). Camera frames the graph on load (calm settle, no explosion).

- [ ] **Step 7: Commit**

```bash
git add frontend/app/view/jarvis/jarvisgraph.tsx frontend/app/view/jarvis/jarvisgraphsurface.tsx frontend/app/view/agents/memgraphlayout.ts
git commit -m "feat(jarvis): U3 base map canvas (kinds + wikilinks, forked from memgraph)"
```

---

### Task 7: Focus-bloom edge styling + selection card

**Files:**
- Modify: `frontend/app/view/jarvis/jarvisgraph.tsx` (typed-edge rendering + selection card overlay)

**Interfaces:**
- Consumes: `attributionStyle` (Task 4); `graphBloomAtom`, `graphSelectedIdAtom` (already read in Task 6); `colors.edgeSemantic`.
- Produces: attribution edges rendered distinctly (dashed/solid, bucket opacity/width, semantic hue); a compact selection-card overlay.

- [ ] **Step 1: Style attribution edges**

In `jarvisgraph.tsx`, extend `linkColor`, `linkWidth`, and add a dashed accessor. `react-force-graph-2d` supports `linkLineDash` via a link accessor; set line dash per link kind/state:

```ts
const linkColor = useCallback(
    (l: GLink) => {
        if (l.kind === "attribution") {
            const s = attributionStyle({ from: idOf(l.source), to: idOf(l.target), kind: "attribution", provenance: l.provenance, bucket: l.bucket, state: l.state });
            const base = s.semantic ? colors.edgeSemantic : colors.edge;
            if (hover.links.has(l)) return colors.edgeHot;
            return rgba(base, hover.nodes.size > 0 ? 0.12 : s.opacity);
        }
        // wikilink (base map)
        if (hover.links.has(l)) return colors.edgeHot;
        const target = hover.nodes.size > 0 ? 0.12 : 1;
        const a = easeVal(linkAlpha.current.get(l), target);
        linkAlpha.current.set(l, a);
        return rgba(colors.edge, a);
    },
    [hover, colors]
);

const linkWidth = useCallback(
    (l: GLink) => {
        if (hover.links.has(l)) return 1.8;
        if (l.kind === "attribution") return attributionStyle({ from: idOf(l.source), to: idOf(l.target), kind: "attribution", bucket: l.bucket, state: l.state, provenance: l.provenance }).width;
        return 0.7;
    },
    [hover]
);

const linkDash = useCallback(
    (l: GLink) => (l.kind === "attribution" && l.state === "informing" ? [3, 3] : null),
    []
);
```

Add to the `<ForceGraph2D>` props: `linkLineDash={linkDash as any}`.

- [ ] **Step 2: Add the selection card overlay**

After the legend overlay in the returned JSX, add a compact card that reads the selected node + (for a task) its bloomed runs:

```tsx
{selectedId ? <SelectionCard nodes={data.nodes} links={data.links} selectedId={selectedId} colors={colors} /> : null}
```

And define the component in the same file:

```tsx
function SelectionCard({ nodes, links, selectedId, colors }: { nodes: GNode[]; links: GLink[]; selectedId: string; colors: ReturnType<typeof useThemeColors> }) {
    const node = nodes.find((n) => n.id === selectedId);
    if (!node) return null;
    const attributions = links.filter((l) => l.kind === "attribution" && idOf(l.source) === selectedId);
    return (
        <div className="absolute right-[12px] bottom-[12px] max-w-[280px] rounded-[9px] border border-edge-mid bg-surface/95 px-[13px] py-[10px]">
            <div className="flex items-center gap-[6px]">
                <div className="h-[8px] w-[8px]" style={{ background: colors.fill(node.kind), borderRadius: node.kind === "run" ? 0 : 9999 }} />
                <span className="font-mono text-[10px] uppercase text-ink-mid">{node.kind}</span>
                {node.status ? <span className="font-mono text-[10px] text-ink-mid">· {node.status}</span> : null}
            </div>
            <div className="mt-[4px] text-[13px] font-semibold text-foreground">{node.label}</div>
            {node.kind === "task" ? (
                <div className="mt-[6px] text-[11px] text-ink-mid">
                    {attributions.length === 0 ? (
                        "no attributed runs yet"
                    ) : (
                        <div className="flex flex-col gap-[3px]">
                            {attributions.map((l, i) => {
                                const run = nodes.find((n) => n.id === idOf(l.target));
                                return (
                                    <div key={i} className="flex items-center justify-between gap-[8px]">
                                        <span className="truncate">{run?.label ?? idOf(l.target)}</span>
                                        <span className="font-mono text-[9.5px] uppercase text-ink-faint">{l.bucket}</span>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>
            ) : null}
        </div>
    );
}
```

- [ ] **Step 3: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 4: CDP visual — bloom + card + edge styling**

With `task dev` running and a vault containing a task with attributed runs, select that task and capture:

Run: `node scripts/cdp-shot.mjs cdp-shots/u3-bloom.png`
Expected: clicking a task node blooms its Run nodes (amber squares) connected by attribution edges; a `dispatch`/`confirmed` edge is solid+bright, a `semantic`/`informing` edge is dashed+faint in the semantic hue; the bottom-right selection card shows the task label, status, and its runs with confidence-bucket tags. Selecting a memory/decision node shows the card with no run list.

- [ ] **Step 5: Full frontend regression**

Run: `npx vitest run` then `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: vitest all-pass; tsc exit 0.

- [ ] **Step 6: Commit**

```bash
git add frontend/app/view/jarvis/jarvisgraph.tsx
git commit -m "feat(jarvis): U3 focus-bloom typed edges + selection card"
```

---

## Post-implementation

- [ ] Update the v2 meta-spec tracking table (`docs/superpowers/specs/2026-07-24-jarvis-second-brain-v2-meta-spec.md`): U3 row → link the spec + plan, mark **Built** with a one-paragraph summary (mirror the S1/S2/U1 rows). This edit rides the final feature commit.
- [ ] Record any PLACEHOLDER tunables surfaced (e.g. bucket→opacity/width constants) in `docs/deferred.md` if they warrant later tuning.

## Self-Review notes (author)

- **Spec coverage:** scope model (whole-vault + focus-bloom) → Tasks 2/3 backend + 6/7 frontend; interaction (map + card, no rail) → Task 7; read-only → no write path anywhere; two commands + `Retriever.Graph()` → Tasks 1–3; renderer fork + reuse `memgraphlayout` → Task 6; node kinds/edge encoding (3 dims, provisional=informing) → Tasks 2/3/6/7; store/snapshot semantics → Task 4; nav surface → Task 5; graceful degradation → Task 4 loaders + Task 5 states; testing (Go/vitest/CDP) → per-task. Out-of-scope items (detach, read rail, cross-nav, live push, semantic dep) are absent by construction.
- **Type consistency:** `GraphNode`/`GraphLink` (Go/wire) vs `GNode`/`GLink` (render) kept distinct and named consistently across Tasks 2–7; `buildDossierGraph`/`vaultGraph`/`vaultNodeToGraphNode` signatures match their call sites; `attributionStyle`/`mergeGraph`/`linkKey` signatures match Task 4 defs and Task 6/7 uses.
