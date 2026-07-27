# Jarvis U2 — Tasks Surface (Dossier Editor) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a first-class **Tasks** cockpit surface that renders a task dossier and its decision log, enforcing the write-ownership model's inside-Wave tier — machine regions read-only/distinct, human writes limited to appending a decision and changing status.

**Architecture:** A pure-UX-lane feature over the built v1 A (`pkg/wavevault`) and B (`pkg/jarvisdossier`). Backend adds one A primitive (`CreateHuman`, human-attributed create), one B op (`AppendHumanDecision`) + a `Notes` projection, and four read/write wshrpc commands. Frontend adds a nav surface under `frontend/app/view/jarvis/` with a module-atom store, wired into the shell render switch and deep-linked from the U1 app-bar Space chip. No model calls, no embeddings.

**Tech Stack:** Go (backend, wshrpc, `git` shell-out vault), React 19 + jotai + Tailwind 4 (frontend), vitest (FE unit), `go test` (backend), CDP surface-smoke (render verification).

**Spec:** `docs/superpowers/specs/2026-07-24-jarvis-u2-tasks-surface-design.md`

## Global Constraints

- **No model calls, no embeddings.** U2 is deterministic UX over A/B (v1 invariant 1, v2 invariant 10).
- **Go is the source of truth for wire types.** After any change to `pkg/wshrpc` command interfaces or types, run **`task generate`**; never hand-edit generated files (`frontend/app/store/wshclientapi.ts`, `pkg/wshrpc/wshclient/wshclient.go`, generated TS/Go type files).
- **Typecheck the frontend with** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` — bare `npx tsc` stack-overflows on this repo; baseline is clean (exit 0), so any error is yours.
- **Surface state in module-scope jotai atoms**, never component `useState` — the Tasks surface unmounts on nav-switch (only the agent surface stays mounted), so `useState` would be lost.
- **Import rule:** `view/agents` must NOT import the `view/jarvis` view; `view/jarvis` MAY import `view/agents`. The shell render switch (`cockpitshell.tsx`) is the sanctioned composition root that imports surface components.
- **Design language:** dark mode only; colors are `@theme` tokens in `tailwindsetup.css` (never raw hex/rgba); existing cockpit fonts; preserve the 46px app bar / 78px nav rail; restrained motion.
- **Git workflow (user's, STRICT):** do NOT commit without explicit approval. Each task ends with a **Checkpoint** (run its tests, confirm green) — not an autonomous commit. The whole feature commits once at the end after approval, with the spec doc (`docs/superpowers/specs/2026-07-24-jarvis-u2-tasks-surface-design.md`) folded into that feature commit and the v2 meta-spec tracking-table U2 row updated in the same commit.
- **Ownership rule (load-bearing):** machine-owned regions (frontmatter `status/ticket/objective/acceptance/confidence/created/updated`, blocks `state/refs/blockers`) render read-only; `## Notes` prose is human-owned (read-only THIS cycle — editing deferred); decisions are append-only.

---

## Task 1: A — `CreateHuman` primitive

The one new vault primitive: a human-authored create that stays out of `machineFiles`, so `Commit` attributes the file to the user (not Jarvis). Mirrors `Create` minus the ledger line.

**Files:**
- Modify: `pkg/wavevault/write.go` (add `CreateHuman` after `Create`, ~line 78)
- Test: `pkg/wavevault/write_test.go` (add one test + reuses existing `mustRead`, `lastAuthor`)

**Interfaces:**
- Consumes: existing `Vault.Create`, `Vault.Commit`, `ContentHash`, `v.machineFiles`, test helpers `openVaultAt`, `mustRead`, `lastAuthor`.
- Produces: `func (v *Vault) CreateHuman(collection, filename, content string) (*WriteResult, error)`.

- [ ] **Step 1: Write the failing test**

Add to `pkg/wavevault/write_test.go`:

```go
func TestCreateHumanCommitsAsUserNotJarvis(t *testing.T) {
	ctx := context.Background()
	v, err := openVaultAt(ctx, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	content := "---\nid: h-1\n---\n\nhuman-authored body\n"
	res, err := v.CreateHuman("decisions", "h-1.md", content)
	if err != nil {
		t.Fatalf("CreateHuman: %v", err)
	}
	p := filepath.Join(v.Root, "decisions", "h-1.md")
	if string(mustRead(t, p)) != content {
		t.Fatal("CreateHuman did not write the exact content")
	}
	if res.Hash != ContentHash([]byte(content)) {
		t.Fatal("WriteResult.Hash must equal the content hash")
	}
	// the key difference from Create: NOT tracked as machine-authored
	v.mu.Lock()
	_, tracked := v.machineFiles[p]
	v.mu.Unlock()
	if tracked {
		t.Fatal("CreateHuman must NOT record the file in machineFiles")
	}
	// so at commit time it lands in the user (add -A) commit, authored by the vault identity
	if err := v.Commit(ctx, "human decision"); err != nil {
		t.Fatal(err)
	}
	if got := lastAuthor(t, v.Root); got != "Wave User" {
		t.Fatalf("human-created file commit author = %q, want Wave User", got)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./pkg/wavevault/ -run TestCreateHumanCommitsAsUserNotJarvis`
Expected: FAIL — `v.CreateHuman undefined (type *Vault has no field or method CreateHuman)`.

- [ ] **Step 3: Write minimal implementation**

Add to `pkg/wavevault/write.go` immediately after `Create` (after line 78):

```go
// CreateHuman is Create's twin but does NOT record the file in machineFiles, so Commit's `add -A`
// stage attributes it to the user, not Jarvis. The one human-authored create path from inside Wave
// (the Tasks surface's append-decision). Errors if the file already exists.
func (v *Vault) CreateHuman(collection, filename, content string) (*WriteResult, error) {
	path := filepath.Join(v.Root, collection, filename)
	if _, err := os.Stat(path); err == nil {
		return nil, fmt.Errorf("wavevault: %s already exists", path)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, err
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		return nil, err
	}
	return &WriteResult{Hash: ContentHash([]byte(content))}, nil
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./pkg/wavevault/ -run TestCreateHumanCommitsAsUserNotJarvis`
Expected: PASS.

- [ ] **Step 5: Checkpoint**

Run: `go test ./pkg/wavevault/`
Expected: PASS (all wavevault tests, no regressions).

---

## Task 2: B — `AppendHumanDecision` + `Dossier.Notes`

Two `jarvisdossier` projections U2 needs: a human-attributed decision append (writes the decision file via `CreateHuman`, forces `actor=human`/`provenance=human-submit`; the refs-index link stays a machine write), and a `Notes` field on the typed `Dossier` (the human `## Notes` prose, blocks stripped) for the read RPC.

**Files:**
- Modify: `pkg/jarvisdossier/decision.go` (refactor `AppendDecision` to a shared core; add `AppendHumanDecision`)
- Modify: `pkg/jarvisdossier/dossier.go` (add `Notes` to `Dossier`; populate in `LoadDossier`)
- Test: `pkg/jarvisdossier/decision_test.go`, `pkg/jarvisdossier/dossier_test.go`

**Interfaces:**
- Consumes: `wavevault.Vault.Create`, `wavevault.Vault.CreateHuman` (Task 1), `SetRefs`, `LoadDossier`, `LoadDecision`, `renderDecision`, `newDecisionID`, `boundedSlug`, `stripBlocks`, test helpers `fixedNow`, `newVault`.
- Produces: `func AppendHumanDecision(v *wavevault.Vault, f DecisionFacts) (string, error)`; `Dossier.Notes string`.

- [ ] **Step 1: Write the failing test (human attribution)**

Add to `pkg/jarvisdossier/decision_test.go`:

```go
func TestAppendHumanDecisionAttributesToUser(t *testing.T) {
	fixedNow(t, 1753324800000)
	v := newVault(t)
	taskID, _, err := CreateDossier(v, DossierFacts{Ticket: "PROJ-20", Objective: "human owns this"})
	if err != nil {
		t.Fatal(err)
	}
	decID, err := AppendHumanDecision(v, DecisionFacts{
		TaskID: taskID, Rationale: "we chose X for durability", Summary: "chose x",
	})
	if err != nil {
		t.Fatalf("AppendHumanDecision: %v", err)
	}
	r := v.Retriever(wavevault.AllScope())
	dec, err := LoadDecision(r, decID)
	if err != nil {
		t.Fatal(err)
	}
	// frontmatter records human authorship regardless of what the caller passed
	if dec.Actor != "human" || dec.Provenance != "human-submit" {
		t.Fatalf("actor/provenance = %q/%q, want human/human-submit", dec.Actor, dec.Provenance)
	}
	if dec.Rationale != "we chose X for durability" {
		t.Fatalf("rationale = %q", dec.Rationale)
	}
	// the decision is linked into the dossier refs (index maintained)
	d, err := LoadDossier(r, taskID)
	if err != nil {
		t.Fatal(err)
	}
	linked := false
	for _, ref := range d.Refs {
		if ref == decID {
			linked = true
		}
	}
	if !linked {
		t.Fatalf("dossier refs %+v must link decision %q", d.Refs, decID)
	}
	// committed: the decision FILE is user-authored (HEAD is the user add -A commit)
	if err := v.Commit(context.Background(), "human decision"); err != nil {
		t.Fatal(err)
	}
	head, err := wavevault.HeadAuthorForTest(context.Background(), v.Root)
	if err != nil {
		t.Fatal(err)
	}
	if head != "Wave User" {
		t.Fatalf("decision-file commit author (HEAD) = %q, want Wave User", head)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./pkg/jarvisdossier/ -run TestAppendHumanDecisionAttributesToUser`
Expected: FAIL — `undefined: AppendHumanDecision`.

- [ ] **Step 3: Refactor `AppendDecision` to a shared core + add `AppendHumanDecision`**

In `pkg/jarvisdossier/decision.go`, replace the whole `AppendDecision` function (lines 50–73) with:

```go
// createFn is Vault.Create or Vault.CreateHuman — the ownership fork for the decision file.
type createFn func(collection, filename, content string) (*wavevault.WriteResult, error)

// AppendDecision creates a new immutable machine-authored decision file in decisions/ and links its
// id into the owning dossier's refs block. Append-only: it never rewrites an existing decision. It
// returns the decision id even if the dossier link step fails, so the record is never lost.
func AppendDecision(v *wavevault.Vault, f DecisionFacts) (string, error) {
	return appendDecision(v, f, v.Create)
}

// AppendHumanDecision is AppendDecision for a human-submitted decision: the decision file is written
// via CreateHuman (→ user commit, honest git blame) and actor/provenance are forced to human. The
// refs-index link stays a machine (SetRefs → Jarvis) write.
func AppendHumanDecision(v *wavevault.Vault, f DecisionFacts) (string, error) {
	f.Actor = "human"
	f.Provenance = "human-submit"
	return appendDecision(v, f, v.CreateHuman)
}

func appendDecision(v *wavevault.Vault, f DecisionFacts, create createFn) (string, error) {
	id := newDecisionID()
	now := nowFn()
	date := time.UnixMilli(now).UTC().Format("2006-01-02")
	filename := date + "-" + boundedSlug(f.Summary, id) + ".md"
	links := append([]string{f.TaskID}, f.Links...)
	if _, err := create("decisions", filename, renderDecision(id, now, f, links)); err != nil {
		return "", err
	}
	r := v.Retriever(wavevault.AllScope())
	d, err := LoadDossier(r, f.TaskID)
	if err != nil {
		return id, fmt.Errorf("jarvisdossier: decision %s created but dossier %s not found to link: %w", id, f.TaskID, err)
	}
	if _, err := SetRefs(v, f.TaskID, append(d.Refs, id), d.Hash); err != nil {
		return id, fmt.Errorf("jarvisdossier: decision %s created but linking to %s failed: %w", id, f.TaskID, err)
	}
	return id, nil
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./pkg/jarvisdossier/ -run TestAppendHumanDecisionAttributesToUser`
Expected: PASS. Also confirm the refactor didn't break the existing append tests:
Run: `go test ./pkg/jarvisdossier/ -run TestAppendDecision`
Expected: PASS (`TestAppendDecisionLinksAndIsTraversable`, `TestAppendDecisionCommitsAsJarvis`).

- [ ] **Step 5: Write the failing test (Notes projection)**

Add to `pkg/jarvisdossier/dossier_test.go`:

```go
func TestLoadDossierProjectsHumanNotes(t *testing.T) {
	v := newVault(t)
	// a dossier whose human ## Notes prose sits after the machine blocks
	content := "---\nstatus: active\nobjective: x\n---\n" +
		"<!-- jarvis:begin state -->\nrunning\n<!-- jarvis:end state -->\n" +
		"<!-- jarvis:begin refs -->\n<!-- jarvis:end refs -->\n" +
		"<!-- jarvis:begin blockers -->\n<!-- jarvis:end blockers -->\n\n" +
		"## Notes\n\nremember to rotate the infra key first\n"
	if _, err := v.Create("tasks/active", "noted.md", content); err != nil {
		t.Fatal(err)
	}
	d, err := LoadDossier(v.Retriever(wavevault.AllScope()), "noted")
	if err != nil {
		t.Fatalf("LoadDossier: %v", err)
	}
	if !strings.Contains(d.Notes, "rotate the infra key") {
		t.Fatalf("Notes did not capture the human prose: %q", d.Notes)
	}
	// the machine block content must NOT leak into Notes
	if strings.Contains(d.Notes, "running") || strings.Contains(d.Notes, "jarvis:begin") {
		t.Fatalf("Notes leaked machine-block content: %q", d.Notes)
	}
}
```

- [ ] **Step 6: Run test to verify it fails**

Run: `go test ./pkg/jarvisdossier/ -run TestLoadDossierProjectsHumanNotes`
Expected: FAIL — `d.Notes undefined (type *Dossier has no field or method Notes)`.

- [ ] **Step 7: Add the `Notes` field + populate it**

In `pkg/jarvisdossier/dossier.go`, add the field to the `Dossier` struct (after `Blockers []string`, ~line 26):

```go
	Blockers   []string
	Notes      string // the human ## Notes prose (machine blocks stripped); read-only, U2 display
	Hash       string
```

And in `LoadDossier` (in the returned `&Dossier{...}`, after the `Blockers:` line, ~line 101):

```go
		Blockers:   splitLines(extractBlock(nb.Body, "blockers")),
		Notes:      strings.TrimSpace(stripBlocks(nb.Body, "state", "refs", "blockers")),
		Hash:       nb.Node.ContentHash,
```

- [ ] **Step 8: Run test to verify it passes**

Run: `go test ./pkg/jarvisdossier/ -run TestLoadDossierProjectsHumanNotes`
Expected: PASS.

- [ ] **Step 9: Checkpoint**

Run: `go test ./pkg/jarvisdossier/ ./pkg/wavevault/`
Expected: PASS (both packages; the `AppendDecision` refactor and `Notes` addition regress nothing).

---

## Task 3: Backend — read RPCs (`GetDossier`, `ListTaskDossiers`) + wire types

Add the read view-model types and two read commands, refactoring U1's `listDossiers` to a shared status-filtered core. Then regenerate bindings.

**Files:**
- Modify: `pkg/wshrpc/wshrpctypes_jarvis.go` (add `DecisionCard`, `DossierDetail`, `CommandGetDossierData`, `CommandListTaskDossiersRtnData`; add 2 interface methods)
- Modify: `pkg/wshrpc/wshserver/wshserver_jarvis.go` (refactor `listDossiers`; add `collectDossiers`, `listTaskDossiers`, `getDossier`, `dossierDecisions`, and the two command methods)
- Test: `pkg/wshrpc/wshserver/wshserver_tasks_test.go` (new)
- Regenerated (do not hand-edit): `pkg/wshrpc/wshclient/wshclient.go`, `frontend/app/store/wshclientapi.ts`, generated type files

**Interfaces:**
- Consumes: `jarvisdossier.LoadDossier`, `jarvisdossier.LoadDecision`, `jarvisdossier.CreateDossier`/`SetStatus` (tests), `wavevault.OpenVaultAtForTest`, `wavevault.Scope`, `wavevault.Filter{HasLink}`, `wshrpc.SpaceSummary`.
- Produces: `GetDossierCommand(ctx, CommandGetDossierData) (*DossierDetail, error)`; `ListTaskDossiersCommand(ctx) (*CommandListTaskDossiersRtnData, error)`; cores `getDossier(v, id)`, `collectDossiers(v, keep)`, `listTaskDossiers(v)`.

- [ ] **Step 1: Add the wire types + interface methods**

In `pkg/wshrpc/wshrpctypes_jarvis.go`, add to the `JarvisCommands` interface (after the `ResolveSpaceScopeCommand` line, ~line 18):

```go
	GetDossierCommand(ctx context.Context, data CommandGetDossierData) (*DossierDetail, error)                              // read one task dossier + its decisions for the Tasks surface
	ListTaskDossiersCommand(ctx context.Context) (*CommandListTaskDossiersRtnData, error)                                  // list ALL task dossiers (any status) for the Tasks surface, newest-updated first
```

And add these types at the end of the file (after `SpaceScope`, ~line 139):

```go
// DecisionCard is one decision record projected for the Tasks surface. Rationale is human prose;
// every other field is machine-owned. Read-only in the UI (decisions are append-only).
type DecisionCard struct {
	Id         string   `json:"id"`
	Created    int64    `json:"created"`
	Actor      string   `json:"actor"`
	Provenance string   `json:"provenance"`
	Status     string   `json:"status"`
	Links      []string `json:"links"`
	Rationale  string   `json:"rationale"`
}

// DossierDetail is a task dossier projected for the Tasks surface. Every field renders read-only
// except via the write commands (append a decision, set status). Notes is the human ## Notes prose,
// read-only this cycle.
type DossierDetail struct {
	Id         string         `json:"id"`
	Ticket     string         `json:"ticket"`
	Objective  string         `json:"objective"`
	Acceptance []string       `json:"acceptance"`
	Confidence string         `json:"confidence"`
	Status     string         `json:"status"`
	Created    int64          `json:"created"`
	Updated    int64          `json:"updated"`
	State      string         `json:"state"`
	Blockers   []string       `json:"blockers"`
	Refs       []string       `json:"refs"`
	Notes      string         `json:"notes"`
	Decisions  []DecisionCard `json:"decisions"`
}

type CommandGetDossierData struct {
	DossierId string `json:"dossierid"`
}

type CommandListTaskDossiersRtnData struct {
	Dossiers []SpaceSummary `json:"dossiers"`
}
```

- [ ] **Step 2: Refactor `listDossiers` + add the read cores**

In `pkg/wshrpc/wshserver/wshserver_jarvis.go`, replace the existing `listDossiers` function (lines 322–341) with the shared-core version:

```go
// collectDossiers projects the tasks collection to SpaceSummaries, keeping those whose status passes
// keep, newest-updated first. The shared core behind ListDossiers (U1, active|paused) and
// ListTaskDossiers (U2, all statuses).
func collectDossiers(v *wavevault.Vault, keep func(status string) bool) ([]wshrpc.SpaceSummary, error) {
	r := v.Retriever(wavevault.Scope{Collections: []string{wavevault.CollTasks}})
	nodes, err := r.Query(wavevault.Filter{})
	if err != nil {
		return nil, fmt.Errorf("querying tasks: %w", err)
	}
	out := []wshrpc.SpaceSummary{}
	for _, n := range nodes {
		d, err := jarvisdossier.LoadDossier(r, n.ID)
		if err != nil {
			continue // tolerant: skip an unreadable/foreign node
		}
		if !keep(d.Status) {
			continue
		}
		out = append(out, wshrpc.SpaceSummary{Id: d.ID, Objective: d.Objective, Ticket: d.Ticket, Status: d.Status, Updated: d.Updated})
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Updated > out[j].Updated })
	return out, nil
}

// listDossiers is U1's focusable-task core (active|paused only), unchanged in behavior.
func listDossiers(v *wavevault.Vault) (*wshrpc.CommandListDossiersRtnData, error) {
	spaces, err := collectDossiers(v, func(s string) bool { return s == "active" || s == "paused" })
	if err != nil {
		return nil, err
	}
	return &wshrpc.CommandListDossiersRtnData{Spaces: spaces}, nil
}

// listTaskDossiers is U2's all-statuses core (the Tasks surface groups them Active/Paused/Done).
func listTaskDossiers(v *wavevault.Vault) (*wshrpc.CommandListTaskDossiersRtnData, error) {
	dossiers, err := collectDossiers(v, func(string) bool { return true })
	if err != nil {
		return nil, err
	}
	return &wshrpc.CommandListTaskDossiersRtnData{Dossiers: dossiers}, nil
}

// getDossier assembles a dossier's read view-model: its machine fields/blocks, the human ## Notes
// prose, and its decisions (resolved by the decisions that [[link]] back to it), newest-first.
func getDossier(v *wavevault.Vault, id string) (*wshrpc.DossierDetail, error) {
	r := v.Retriever(wavevault.AllScope())
	d, err := jarvisdossier.LoadDossier(r, id)
	if err != nil {
		return nil, fmt.Errorf("loading dossier: %w", err)
	}
	cards, err := dossierDecisions(v, id)
	if err != nil {
		return nil, err
	}
	return &wshrpc.DossierDetail{
		Id: d.ID, Ticket: d.Ticket, Objective: d.Objective, Acceptance: d.Acceptance,
		Confidence: d.Confidence, Status: d.Status, Created: d.Created, Updated: d.Updated,
		State: d.State, Blockers: d.Blockers, Refs: d.Refs, Notes: d.Notes, Decisions: cards,
	}, nil
}

// dossierDecisions resolves the decision records linking back to dossierID, projected to cards,
// newest-created first. A decisions-scoped HasLink query (robust vs. parsing the mixed refs block).
func dossierDecisions(v *wavevault.Vault, dossierID string) ([]wshrpc.DecisionCard, error) {
	r := v.Retriever(wavevault.Scope{Collections: []string{wavevault.CollDecisions}})
	nodes, err := r.Query(wavevault.Filter{HasLink: dossierID})
	if err != nil {
		return nil, fmt.Errorf("querying decisions: %w", err)
	}
	cards := []wshrpc.DecisionCard{}
	for _, n := range nodes {
		dec, err := jarvisdossier.LoadDecision(r, n.ID)
		if err != nil {
			continue
		}
		cards = append(cards, wshrpc.DecisionCard{
			Id: dec.ID, Created: dec.Created, Actor: dec.Actor, Provenance: dec.Provenance,
			Status: dec.Status, Links: dec.Links, Rationale: dec.Rationale,
		})
	}
	sort.SliceStable(cards, func(i, j int) bool { return cards[i].Created > cards[j].Created })
	return cards, nil
}
```

- [ ] **Step 3: Add the two command methods**

In `pkg/wshrpc/wshserver/wshserver_jarvis.go`, after `ResolveSpaceScopeCommand` (~line 365), add:

```go
func (ws *WshServer) GetDossierCommand(ctx context.Context, data wshrpc.CommandGetDossierData) (*wshrpc.DossierDetail, error) {
	if data.DossierId == "" {
		return nil, fmt.Errorf("dossierid is required")
	}
	v, err := wavevault.OpenVault(ctx)
	if err != nil {
		return nil, fmt.Errorf("opening vault: %w", err)
	}
	return getDossier(v, data.DossierId)
}

func (ws *WshServer) ListTaskDossiersCommand(ctx context.Context) (*wshrpc.CommandListTaskDossiersRtnData, error) {
	v, err := wavevault.OpenVault(ctx)
	if err != nil {
		return nil, fmt.Errorf("opening vault: %w", err)
	}
	return listTaskDossiers(v)
}
```

- [ ] **Step 4: Write the failing tests**

Create `pkg/wshrpc/wshserver/wshserver_tasks_test.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/jarvisdossier"
	"github.com/wavetermdev/waveterm/pkg/wavevault"
)

func TestListTaskDossiersReturnsAllStatuses(t *testing.T) {
	ctx := context.Background()
	v, err := wavevault.OpenVaultAtForTest(ctx, t.TempDir())
	if err != nil {
		t.Fatalf("open vault: %v", err)
	}
	_, _, _ = createStatused(t, v, "T-1", "alpha", "active")
	_, _, _ = createStatused(t, v, "T-2", "beta", "completed")
	_, _, _ = createStatused(t, v, "T-3", "gamma", "archived")

	rtn, err := listTaskDossiers(v)
	if err != nil {
		t.Fatalf("listTaskDossiers: %v", err)
	}
	if len(rtn.Dossiers) != 3 {
		t.Fatalf("want all 3 statuses returned, got %d: %+v", len(rtn.Dossiers), rtn.Dossiers)
	}
	// U1's focusable list is unaffected by the refactor (active only here, no paused)
	u1, err := listDossiers(v)
	if err != nil {
		t.Fatal(err)
	}
	if len(u1.Spaces) != 1 || u1.Spaces[0].Objective != "alpha" {
		t.Fatalf("listDossiers must still return active|paused only, got %+v", u1.Spaces)
	}
}

func TestGetDossierAssemblesDecisionsAndNotes(t *testing.T) {
	ctx := context.Background()
	v, err := wavevault.OpenVaultAtForTest(ctx, t.TempDir())
	if err != nil {
		t.Fatalf("open vault: %v", err)
	}
	taskID, _, err := jarvisdossier.CreateDossier(v, jarvisdossier.DossierFacts{Ticket: "T-9", Objective: "assemble me"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := jarvisdossier.AppendDecision(v, jarvisdossier.DecisionFacts{
		TaskID: taskID, Actor: "worker-1", Provenance: "worker-report",
		Rationale: "decision one", Summary: "one",
	}); err != nil {
		t.Fatal(err)
	}
	detail, err := getDossier(v, taskID)
	if err != nil {
		t.Fatalf("getDossier: %v", err)
	}
	if detail.Objective != "assemble me" || detail.Status != "active" {
		t.Fatalf("machine fields wrong: %+v", detail)
	}
	if len(detail.Decisions) != 1 || detail.Decisions[0].Rationale != "decision one" {
		t.Fatalf("decisions not assembled: %+v", detail.Decisions)
	}
}

// createStatused makes a dossier then forces its status, returning the id/hash for chaining.
func createStatused(t *testing.T, v *wavevault.Vault, ticket, objective, status string) (string, string, error) {
	t.Helper()
	id, hash, err := jarvisdossier.CreateDossier(v, jarvisdossier.DossierFacts{Ticket: ticket, Objective: objective})
	if err != nil {
		t.Fatal(err)
	}
	if status != "active" {
		res, err := jarvisdossier.SetStatus(v, id, status, hash)
		if err != nil {
			t.Fatal(err)
		}
		hash = res.Hash
	}
	return id, hash, nil
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `go test ./pkg/wshrpc/wshserver/ -run 'TestListTaskDossiers|TestGetDossier'`
Expected: PASS. Also confirm U1's test still passes: `go test ./pkg/wshrpc/wshserver/ -run TestListDossiersFiltersStatusAndSorts` → PASS.

- [ ] **Step 6: Regenerate bindings**

Run: `task generate`
Expected: exit 0; `git status` shows regenerated `pkg/wshrpc/wshclient/wshclient.go` and `frontend/app/store/wshclientapi.ts` now contain `GetDossierCommand` and `ListTaskDossiersCommand`. Verify:
Run: `grep -c "ListTaskDossiersCommand" frontend/app/store/wshclientapi.ts` → ≥ 1.

- [ ] **Step 7: Checkpoint**

Run: `go build ./... && go test ./pkg/wshrpc/... ./pkg/jarvisdossier/ ./pkg/wavevault/`
Expected: PASS.

---

## Task 4: Backend — write RPCs (`AppendDossierDecision`, `SetDossierStatus`)

The two human writes: append a decision (human-attributed, via Task 2), and change status (machine `SetStatus`, conflict-retried once). Both commit at the boundary.

**Files:**
- Modify: `pkg/wshrpc/wshrpctypes_jarvis.go` (add data/rtn types + 2 interface methods)
- Modify: `pkg/wshrpc/wshserver/wshserver_jarvis.go` (add `appendDossierDecision`, `setDossierStatus` cores + the two command methods)
- Test: `pkg/wshrpc/wshserver/wshserver_tasks_test.go` (extend)
- Regenerated (do not hand-edit): client bindings

**Interfaces:**
- Consumes: `jarvisdossier.AppendHumanDecision`, `jarvisdossier.SetStatus`, `jarvisdossier.LoadDossier`, `wavevault.WriteResult.Conflict`, `Vault.Commit`.
- Produces: `AppendDossierDecisionCommand(ctx, data) (*CommandAppendDossierDecisionRtnData, error)`; `SetDossierStatusCommand(ctx, data) error`; cores `appendDossierDecision(ctx, v, data)`, `setDossierStatus(ctx, v, id, status)`.

- [ ] **Step 1: Add the wire types + interface methods**

In `pkg/wshrpc/wshrpctypes_jarvis.go`, add to the `JarvisCommands` interface (after `ListTaskDossiersCommand`):

```go
	AppendDossierDecisionCommand(ctx context.Context, data CommandAppendDossierDecisionData) (*CommandAppendDossierDecisionRtnData, error) // human-append a decision to a dossier (user-attributed) + commit
	SetDossierStatusCommand(ctx context.Context, data CommandSetDossierStatusData) error                                                   // set a dossier's status (active|paused|completed|archived) + commit
```

And add the types (after `CommandListTaskDossiersRtnData`):

```go
type CommandAppendDossierDecisionData struct {
	DossierId string   `json:"dossierid"`
	Summary   string   `json:"summary"`
	Rationale string   `json:"rationale"`
	Links     []string `json:"links,omitempty"`
}

type CommandAppendDossierDecisionRtnData struct {
	DecisionId string `json:"decisionid"`
}

type CommandSetDossierStatusData struct {
	DossierId string `json:"dossierid"`
	Status    string `json:"status"`
}
```

- [ ] **Step 2: Add the write cores**

In `pkg/wshrpc/wshserver/wshserver_jarvis.go`, after `dossierDecisions` (from Task 3), add:

```go
var validDossierStatuses = map[string]bool{"active": true, "paused": true, "completed": true, "archived": true}

// appendDossierDecision writes a human-attributed decision and commits at the boundary. Returns the
// decision id even on a commit error so the caller can surface a partial success.
func appendDossierDecision(ctx context.Context, v *wavevault.Vault, data wshrpc.CommandAppendDossierDecisionData) (string, error) {
	decID, err := jarvisdossier.AppendHumanDecision(v, jarvisdossier.DecisionFacts{
		TaskID:    data.DossierId,
		Links:     data.Links,
		Rationale: data.Rationale,
		Summary:   data.Summary,
	})
	if err != nil {
		return "", fmt.Errorf("appending decision: %w", err)
	}
	if err := v.Commit(ctx, "human: decision added — "+data.DossierId); err != nil {
		return decID, fmt.Errorf("committing decision: %w", err)
	}
	return decID, nil
}

// setDossierStatus validates and writes the machine-owned status, retrying once on a concurrent
// external edit (baseHash mismatch), then commits.
func setDossierStatus(ctx context.Context, v *wavevault.Vault, id, status string) error {
	if !validDossierStatuses[status] {
		return fmt.Errorf("invalid status %q", status)
	}
	d, err := jarvisdossier.LoadDossier(v.Retriever(wavevault.AllScope()), id)
	if err != nil {
		return fmt.Errorf("loading dossier: %w", err)
	}
	res, err := jarvisdossier.SetStatus(v, id, status, d.Hash)
	if err != nil {
		return fmt.Errorf("setting status: %w", err)
	}
	if res.Conflict {
		d2, err := jarvisdossier.LoadDossier(v.Retriever(wavevault.AllScope()), id)
		if err != nil {
			return fmt.Errorf("reloading after conflict: %w", err)
		}
		if _, err := jarvisdossier.SetStatus(v, id, status, d2.Hash); err != nil {
			return fmt.Errorf("retry after conflict: %w", err)
		}
	}
	return v.Commit(ctx, id+" → "+status)
}
```

- [ ] **Step 3: Add the two command methods**

In `pkg/wshrpc/wshserver/wshserver_jarvis.go`, after `ListTaskDossiersCommand` (from Task 3), add:

```go
func (ws *WshServer) AppendDossierDecisionCommand(ctx context.Context, data wshrpc.CommandAppendDossierDecisionData) (*wshrpc.CommandAppendDossierDecisionRtnData, error) {
	if data.DossierId == "" {
		return nil, fmt.Errorf("dossierid is required")
	}
	if strings.TrimSpace(data.Rationale) == "" {
		return nil, fmt.Errorf("rationale is required")
	}
	v, err := wavevault.OpenVault(ctx)
	if err != nil {
		return nil, fmt.Errorf("opening vault: %w", err)
	}
	decID, err := appendDossierDecision(ctx, v, data)
	if err != nil {
		return nil, err
	}
	return &wshrpc.CommandAppendDossierDecisionRtnData{DecisionId: decID}, nil
}

func (ws *WshServer) SetDossierStatusCommand(ctx context.Context, data wshrpc.CommandSetDossierStatusData) error {
	if data.DossierId == "" {
		return fmt.Errorf("dossierid is required")
	}
	v, err := wavevault.OpenVault(ctx)
	if err != nil {
		return fmt.Errorf("opening vault: %w", err)
	}
	return setDossierStatus(ctx, v, data.DossierId, data.Status)
}
```

- [ ] **Step 4: Write the failing tests**

Add to `pkg/wshrpc/wshserver/wshserver_tasks_test.go`:

```go
func TestAppendDossierDecisionAndStatusRoundTrip(t *testing.T) {
	ctx := context.Background()
	v, err := wavevault.OpenVaultAtForTest(ctx, t.TempDir())
	if err != nil {
		t.Fatalf("open vault: %v", err)
	}
	taskID, _, err := jarvisdossier.CreateDossier(v, jarvisdossier.DossierFacts{Ticket: "T-30", Objective: "round trip"})
	if err != nil {
		t.Fatal(err)
	}
	decID, err := appendDossierDecision(ctx, v, wshrpc.CommandAppendDossierDecisionData{
		DossierId: taskID, Summary: "chose b", Rationale: "b needs no migration",
	})
	if err != nil {
		t.Fatalf("appendDossierDecision: %v", err)
	}
	detail, err := getDossier(v, taskID)
	if err != nil {
		t.Fatal(err)
	}
	if len(detail.Decisions) != 1 || detail.Decisions[0].Id != decID {
		t.Fatalf("decision not appended/read back: %+v", detail.Decisions)
	}
	if detail.Decisions[0].Actor != "human" || detail.Decisions[0].Provenance != "human-submit" {
		t.Fatalf("human decision attribution wrong: %+v", detail.Decisions[0])
	}
	// status transition
	if err := setDossierStatus(ctx, v, taskID, "completed"); err != nil {
		t.Fatalf("setDossierStatus: %v", err)
	}
	detail2, err := getDossier(v, taskID)
	if err != nil {
		t.Fatal(err)
	}
	if detail2.Status != "completed" {
		t.Fatalf("status = %q, want completed", detail2.Status)
	}
}

func TestSetDossierStatusRejectsInvalid(t *testing.T) {
	ctx := context.Background()
	v, err := wavevault.OpenVaultAtForTest(ctx, t.TempDir())
	if err != nil {
		t.Fatalf("open vault: %v", err)
	}
	taskID, _, err := jarvisdossier.CreateDossier(v, jarvisdossier.DossierFacts{Ticket: "T-31", Objective: "x"})
	if err != nil {
		t.Fatal(err)
	}
	if err := setDossierStatus(ctx, v, taskID, "banana"); err == nil {
		t.Fatal("an invalid status must be rejected")
	}
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `go test ./pkg/wshrpc/wshserver/ -run 'TestAppendDossierDecisionAndStatusRoundTrip|TestSetDossierStatusRejectsInvalid'`
Expected: PASS.

- [ ] **Step 6: Regenerate bindings**

Run: `task generate`
Expected: exit 0; verify the FE client now has the write commands:
Run: `grep -c "AppendDossierDecisionCommand\|SetDossierStatusCommand" frontend/app/store/wshclientapi.ts` → ≥ 2.

- [ ] **Step 7: Checkpoint**

Run: `go build ./... && go test ./pkg/wshrpc/...`
Expected: PASS.

---

## Task 5: Frontend — nav registration + store + surface shell (list)

Register the `tasks` nav surface, add the module-atom store, the grouping derive helper, and the surface shell rendering the dossier list + empty/selected states.

**Files:**
- Modify: `frontend/app/view/agents/agents.tsx` (add `"tasks"` to `SurfaceKey` + `SURFACE_ORDER`)
- Modify: `frontend/app/view/agents/navrail.tsx` (add `tasks` to `ICON` + `ITEMS`)
- Modify: `frontend/app/view/agents/cockpitshell.tsx` (import `TasksSurface`, add the `tasks` branch)
- Create: `frontend/app/view/jarvis/tasksstore.ts`
- Create: `frontend/app/view/jarvis/tasksderive.ts`
- Create: `frontend/app/view/jarvis/tasksderive.test.ts`
- Create: `frontend/app/view/jarvis/taskssurface.tsx`

**Interfaces:**
- Consumes generated globals `SpaceSummary`, `DossierDetail`; `RpcApi.{ListTaskDossiersCommand,GetDossierCommand,AppendDossierDecisionCommand,SetDossierStatusCommand}`; `TabRpcClient`; `globalStore`; `SurfaceHeader/SurfaceEmptyState/SurfaceError`.
- Produces: store atoms/mutators (`taskListAtom`, `selectedDossierIdAtom`, `dossierDetailAtom`, `tasksErrorAtom`, `loadTaskList`, `selectDossier`, `appendDecision`, `setDossierStatus`); `groupDossiers`; `<TasksSurface/>`.

- [ ] **Step 1: Register the nav surface**

In `frontend/app/view/agents/agents.tsx`, add `"tasks"` to the `SurfaceKey` union (between `"memory"` and `"usage"`, ~line 37):

```ts
    | "memory"
    | "tasks"
    | "usage"
    | "settings";
```

And to `SURFACE_ORDER` (between `"memory"` and `"usage"`, ~line 51):

```ts
    "memory",
    "tasks",
    "usage",
];
```

In `frontend/app/view/agents/navrail.tsx`, add the icon import (add `ListTodo` to the existing `lucide-react` import list, ~line 6) and register it. In the `ICON` record (after the `memory:` line, ~line 34):

```tsx
    memory: <Network {...iconProps} />,
    tasks: <ListTodo {...iconProps} />,
    usage: <Gauge {...iconProps} />,
```

In the `ITEMS` array (after the `memory` entry, ~line 47):

```tsx
    { key: "memory", label: "Memory" },
    { key: "tasks", label: "Tasks" },
    { key: "usage", label: "Usage" },
```

- [ ] **Step 2: Wire the render switch**

In `frontend/app/view/agents/cockpitshell.tsx`, add the import (after the `MemorySurface` import, ~line 16):

```tsx
import { TasksSurface } from "@/app/view/jarvis/taskssurface";
```

And add a branch in the surface switch (after the `memory` branch, ~line 116):

```tsx
                        ) : surface === "memory" ? (
                            <MemorySurface model={model} />
                        ) : surface === "tasks" ? (
                            <TasksSurface />
                        ) : surface === "settings" ? (
```

- [ ] **Step 3: Write the failing derive test**

Create `frontend/app/view/jarvis/tasksderive.test.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { groupDossiers } from "./tasksderive";

const mk = (id: string, status: string): SpaceSummary => ({
    id,
    objective: id,
    ticket: "",
    status,
    updated: 0,
});

describe("groupDossiers", () => {
    it("groups by Active / Paused / Done and omits empty groups", () => {
        const groups = groupDossiers([mk("a", "active"), mk("p", "paused"), mk("c", "completed"), mk("r", "archived")]);
        expect(groups.map((g) => g.key)).toEqual(["active", "paused", "done"]);
        expect(groups[2].items.map((d) => d.id)).toEqual(["c", "r"]); // completed + archived collapse into Done
    });

    it("omits a group with no members", () => {
        const groups = groupDossiers([mk("a", "active")]);
        expect(groups.map((g) => g.key)).toEqual(["active"]);
    });

    it("returns no groups for an empty list", () => {
        expect(groupDossiers([])).toEqual([]);
    });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npx vitest run frontend/app/view/jarvis/tasksderive.test.ts`
Expected: FAIL — cannot resolve `./tasksderive` / `groupDossiers` is not defined.

- [ ] **Step 5: Write the derive helper**

Create `frontend/app/view/jarvis/tasksderive.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pure derivation for the Tasks surface (U2). No React, no I/O — unit-tested directly.

export type DossierGroupKey = "active" | "paused" | "done";

export interface DossierGroup {
    key: DossierGroupKey;
    label: string;
    items: SpaceSummary[];
}

// groupDossiers buckets the flat dossier list into Active / Paused / Done (completed+archived),
// preserving the backend's newest-updated ordering within each group and omitting empty groups.
export function groupDossiers(list: SpaceSummary[]): DossierGroup[] {
    const active = list.filter((d) => d.status === "active");
    const paused = list.filter((d) => d.status === "paused");
    const done = list.filter((d) => d.status === "completed" || d.status === "archived");
    const groups: DossierGroup[] = [];
    if (active.length) groups.push({ key: "active", label: "Active", items: active });
    if (paused.length) groups.push({ key: "paused", label: "Paused", items: paused });
    if (done.length) groups.push({ key: "done", label: "Done", items: done });
    return groups;
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run frontend/app/view/jarvis/tasksderive.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 7: Write the store**

Create `frontend/app/view/jarvis/tasksstore.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Tasks surface (U2) state. Module-scope atoms so the selected dossier + loaded detail survive the
// surface unmount on nav-switch (only the agent surface stays mounted). Lives under view/jarvis/.

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { fireAndForget } from "@/util/util";
import { atom, type PrimitiveAtom } from "jotai";

export const taskListAtom = atom<SpaceSummary[]>([]) as PrimitiveAtom<SpaceSummary[]>;
export const selectedDossierIdAtom = atom<string | null>(null) as PrimitiveAtom<string | null>;
export const dossierDetailAtom = atom<DossierDetail | null>(null) as PrimitiveAtom<DossierDetail | null>;
export const tasksErrorAtom = atom<string | null>(null) as PrimitiveAtom<string | null>;

export function loadTaskList(): void {
    fireAndForget(async () => {
        try {
            const rtn = await RpcApi.ListTaskDossiersCommand(TabRpcClient);
            globalStore.set(taskListAtom, rtn?.dossiers ?? []);
        } catch (e) {
            globalStore.set(tasksErrorAtom, String(e));
        }
    });
}

export function selectDossier(id: string): void {
    globalStore.set(selectedDossierIdAtom, id);
    globalStore.set(dossierDetailAtom, null);
    void reloadDetail(id);
}

async function reloadDetail(id: string): Promise<void> {
    try {
        const detail = await RpcApi.GetDossierCommand(TabRpcClient, { dossierid: id });
        if (globalStore.get(selectedDossierIdAtom) === id) {
            globalStore.set(dossierDetailAtom, detail ?? null);
        }
    } catch (e) {
        globalStore.set(tasksErrorAtom, String(e));
    }
}

// appendDecision writes a human-authored decision, then reloads the open dossier detail so the new
// card appears. Errors surface into tasksErrorAtom (graceful degradation — never throws to the UI).
export function appendDecision(dossierId: string, summary: string, rationale: string, links: string[]): void {
    fireAndForget(async () => {
        try {
            await RpcApi.AppendDossierDecisionCommand(TabRpcClient, {
                dossierid: dossierId,
                summary,
                rationale,
                links,
            });
            await reloadDetail(dossierId);
        } catch (e) {
            globalStore.set(tasksErrorAtom, String(e));
        }
    });
}

// setDossierStatus transitions a dossier's status, then reloads detail + the list (the row may move
// group or drop out).
export function setDossierStatus(dossierId: string, status: string): void {
    fireAndForget(async () => {
        try {
            await RpcApi.SetDossierStatusCommand(TabRpcClient, { dossierid: dossierId, status });
            await reloadDetail(dossierId);
            loadTaskList();
        } catch (e) {
            globalStore.set(tasksErrorAtom, String(e));
        }
    });
}
```

- [ ] **Step 8: Write the surface shell**

Create `frontend/app/view/jarvis/taskssurface.tsx`:

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { activeSpaceAtom } from "@/app/view/agents/spacestore";
import { SurfaceEmptyState, SurfaceError, SurfaceHeader } from "@/app/view/agents/surfacescaffold";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect, useRef } from "react";
import { TaskDetail } from "./taskdetail";
import { groupDossiers } from "./tasksderive";
import {
    dossierDetailAtom,
    loadTaskList,
    selectDossier,
    selectedDossierIdAtom,
    taskListAtom,
    tasksErrorAtom,
} from "./tasksstore";

export function TasksSurface() {
    const list = useAtomValue(taskListAtom);
    const selectedId = useAtomValue(selectedDossierIdAtom);
    const detail = useAtomValue(dossierDetailAtom);
    const error = useAtomValue(tasksErrorAtom);
    const activeSpace = useAtomValue(activeSpaceAtom);
    const lastSpaceRef = useRef<string | null>(null);

    useEffect(() => {
        loadTaskList();
    }, []);

    // Deep-link from the app-bar Space chip: when the active Space changes (or is set on mount),
    // preselect its dossier. A manual in-surface selection (same Space) is preserved by the ref guard.
    useEffect(() => {
        const spaceId = activeSpace?.id ?? null;
        if (spaceId != null && spaceId !== lastSpaceRef.current) {
            lastSpaceRef.current = spaceId;
            selectDossier(spaceId);
        }
    }, [activeSpace]);

    const groups = groupDossiers(list);
    return (
        <div className="flex h-full w-full flex-col">
            <SurfaceHeader title="Tasks" subtitle="Task dossiers — machine-maintained, with human notes and decisions" />
            {error != null ? <SurfaceError message={error} /> : null}
            <div className="flex min-h-0 flex-1">
                <div className="flex w-[280px] flex-none flex-col overflow-y-auto border-r border-border py-2">
                    {list.length === 0 ? (
                        <div className="px-4 py-6 text-[13px] text-muted">No tasks yet.</div>
                    ) : (
                        groups.map((g) => (
                            <div key={g.key} className="mb-2">
                                <div className="px-4 py-1 font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-muted">
                                    {g.label}
                                </div>
                                {g.items.map((d) => (
                                    <button
                                        key={d.id}
                                        type="button"
                                        onClick={() => selectDossier(d.id)}
                                        className={cn(
                                            "flex w-full flex-col items-start gap-0.5 px-4 py-2 text-left hover:bg-surface-hover",
                                            selectedId === d.id && "bg-accent/10"
                                        )}
                                    >
                                        <span className="w-full truncate text-[13px] font-medium text-secondary">
                                            {d.objective}
                                        </span>
                                        {d.ticket ? <span className="font-mono text-[10px] text-muted">{d.ticket}</span> : null}
                                    </button>
                                ))}
                            </div>
                        ))
                    )}
                </div>
                <div className="min-w-0 flex-1 overflow-y-auto">
                    {detail != null ? (
                        <TaskDetail detail={detail} />
                    ) : selectedId != null ? (
                        <div className="p-8 text-[13px] text-muted">Loading…</div>
                    ) : (
                        <SurfaceEmptyState
                            title="Select a task"
                            body="Choose a dossier to view its machine-maintained state, your notes, and its decisions."
                        />
                    )}
                </div>
            </div>
        </div>
    );
}
```

Note: `TaskDetail` is created in Task 6. To let this task typecheck independently, create a one-line stub now and replace it in Task 6:

Create `frontend/app/view/jarvis/taskdetail.tsx` (temporary stub):

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

export function TaskDetail({ detail }: { detail: DossierDetail }) {
    return <div className="p-8 text-[13px] text-secondary">{detail.objective}</div>;
}
```

- [ ] **Step 9: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0 (clean baseline; no new errors).

- [ ] **Step 10: Checkpoint**

Run: `npx vitest run frontend/app/view/jarvis/tasksderive.test.ts`
Expected: PASS. The Tasks nav entry now renders an (empty or list) surface; detail is a stub until Task 6.

---

## Task 6: Frontend — dossier detail (machine read-only panel + notes + decisions log)

Replace the `TaskDetail` stub with the real detail: the objective/ticket header, the machine-maintained panel (acceptance, state, blockers, refs) rendered read-only with a lock affordance, the human `## Notes` read-only, and the decisions log (read-only cards). Write affordances come in Task 7.

**Files:**
- Modify: `frontend/app/view/jarvis/taskdetail.tsx` (replace the stub)
- Create: `frontend/app/view/jarvis/decisionlog.tsx`

**Interfaces:**
- Consumes: `DossierDetail`, `DecisionCard` (generated globals); `cn`.
- Produces: `<TaskDetail detail={detail}/>`; `<DecisionLog decisions={...} dossierId={...}/>`.

- [ ] **Step 1: Write the decisions log (read-only this task)**

Create `frontend/app/view/jarvis/decisionlog.tsx`:

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Decision log: read-only, newest-first cards. The "Add decision" affordance (append form) is wired
// in Task 7; this task renders the list + a placeholder button.

function fmtDate(ms: number): string {
    if (!ms) return "";
    return new Date(ms).toISOString().slice(0, 10);
}

function DecisionCardRow({ card }: { card: DecisionCard }) {
    return (
        <div className="rounded-lg border border-border bg-surface px-3.5 py-3">
            <div className="mb-1.5 flex items-center gap-2 text-[11px] text-muted">
                <span className="font-mono">{fmtDate(card.created)}</span>
                <span className="rounded bg-surface-hover px-1.5 py-0.5 font-mono">{card.actor}</span>
                {card.status !== "active" ? (
                    <span className="rounded bg-warning/12 px-1.5 py-0.5 font-mono text-warning">{card.status}</span>
                ) : null}
            </div>
            <div className="whitespace-pre-wrap text-[13px] leading-[1.55] text-secondary">{card.rationale}</div>
        </div>
    );
}

export function DecisionLog({ decisions }: { decisions: DecisionCard[]; dossierId: string }) {
    return (
        <div className="flex flex-col gap-2.5">
            {decisions.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border px-3.5 py-4 text-[12.5px] text-muted">
                    No decisions yet.
                </div>
            ) : (
                decisions.map((c) => <DecisionCardRow key={c.id} card={c} />)
            )}
        </div>
    );
}
```

- [ ] **Step 2: Write the detail (machine panel + notes + log)**

Replace the entire contents of `frontend/app/view/jarvis/taskdetail.tsx` with:

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { cn } from "@/util/util";
import { Lock } from "lucide-react";
import type { ReactNode } from "react";
import { DecisionLog } from "./decisionlog";

// A machine-maintained region: muted panel + a lock glyph, non-editable. The visible expression of
// the write-ownership model's inside-Wave tier (spec §4).
function MachineField({ label, children }: { label: string; children: ReactNode }) {
    return (
        <div className="mb-3">
            <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">
                <Lock size={10} strokeWidth={2} className="text-muted" />
                {label}
            </div>
            <div className="text-[13px] leading-[1.55] text-secondary">{children}</div>
        </div>
    );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
    return (
        <div className="mb-6">
            <h2 className="mb-2.5 text-[13px] font-bold uppercase tracking-[0.08em] text-primary">{title}</h2>
            {children}
        </div>
    );
}

export function TaskDetail({ detail }: { detail: DossierDetail }) {
    return (
        <div className="mx-auto max-w-[720px] px-8 py-6">
            <div className="mb-5">
                <div className="flex items-center gap-2.5">
                    <h1 className="text-[22px] font-bold tracking-[-0.02em] text-primary">{detail.objective}</h1>
                    {detail.ticket ? (
                        <span className="rounded bg-surface-hover px-2 py-0.5 font-mono text-[11px] text-muted">
                            {detail.ticket}
                        </span>
                    ) : null}
                </div>
                <div className="mt-1 flex items-center gap-2 text-[12px] text-muted">
                    <span
                        className={cn(
                            "rounded px-1.5 py-0.5 font-mono",
                            detail.status === "active" ? "bg-success/12 text-success" : "bg-surface-hover"
                        )}
                    >
                        {detail.status}
                    </span>
                    {detail.confidence ? <span>confidence: {detail.confidence}</span> : null}
                </div>
            </div>

            <Section title="Machine-maintained">
                <div className="rounded-xl border border-border bg-surface/50 px-4 py-3.5">
                    {detail.acceptance.length > 0 ? (
                        <MachineField label="Acceptance">
                            <ul className="list-inside list-disc">
                                {detail.acceptance.map((a, i) => (
                                    <li key={i}>{a}</li>
                                ))}
                            </ul>
                        </MachineField>
                    ) : null}
                    {detail.state ? (
                        <MachineField label="State">
                            <div className="whitespace-pre-wrap">{detail.state}</div>
                        </MachineField>
                    ) : null}
                    {detail.blockers.length > 0 ? (
                        <MachineField label="Blockers">
                            <ul className="list-inside list-disc">
                                {detail.blockers.map((b, i) => (
                                    <li key={i}>{b}</li>
                                ))}
                            </ul>
                        </MachineField>
                    ) : null}
                    {detail.refs.length > 0 ? (
                        <MachineField label="Refs">
                            <div className="flex flex-wrap gap-1.5 font-mono text-[11px]">
                                {detail.refs.map((r) => (
                                    <span key={r} className="rounded bg-surface-hover px-1.5 py-0.5">
                                        {r}
                                    </span>
                                ))}
                            </div>
                        </MachineField>
                    ) : null}
                </div>
            </Section>

            {detail.notes ? (
                <Section title="Notes">
                    <div className="whitespace-pre-wrap text-[13px] leading-[1.6] text-secondary">{detail.notes}</div>
                </Section>
            ) : null}

            <Section title="Decisions">
                <DecisionLog decisions={detail.decisions} dossierId={detail.id} />
            </Section>
        </div>
    );
}
```

- [ ] **Step 3: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 4: Verify render in the live dev app (CDP)**

With `task dev` running, open the Tasks surface (nav rail → Tasks) and select a dossier. Capture:
Run: `node scripts/cdp-shot.mjs cdp-shots/u2-detail.png`
Expected: the detail shows the objective/ticket/status header, a muted "Machine-maintained" panel with lock glyphs on acceptance/state/blockers/refs, read-only Notes, and the decisions log. (If the dev vault has no dossiers, dispatch a run first so `jarviscapture` writes one.)

- [ ] **Step 5: Checkpoint**

Run: `npx vitest run frontend/app/view/jarvis/tasksderive.test.ts`
Expected: PASS. Detail renders with correct read-only ownership treatment (verified via CDP in Step 4).

---

## Task 7: Frontend — write affordances (append decision + status control)

Add the two human writes: an "Add decision" form (summary + rationale + optional links) and a status control with a confirm on terminal transitions. Wire both to the store mutators (Task 5) and the RPCs (Task 4). Add the validation derive helpers.

**Files:**
- Modify: `frontend/app/view/jarvis/tasksderive.ts` (add `allowedTransitions`, `isTerminalTransition`, `validateDecisionDraft`)
- Modify: `frontend/app/view/jarvis/tasksderive.test.ts` (add tests)
- Modify: `frontend/app/view/jarvis/decisionlog.tsx` (add the append form)
- Modify: `frontend/app/view/jarvis/taskdetail.tsx` (add the status control)

**Interfaces:**
- Consumes: `appendDecision`, `setDossierStatus` (store, Task 5); `ConfirmDialog` (`@/app/modals/confirmdialog`); `DialogButton` if needed.
- Produces: `allowedTransitions(status)`, `isTerminalTransition(status)`, `validateDecisionDraft(summary, rationale)`.

- [ ] **Step 1: Write the failing derive tests**

Add to `frontend/app/view/jarvis/tasksderive.test.ts`:

```ts
import { allowedTransitions, isTerminalTransition, validateDecisionDraft } from "./tasksderive";

describe("status transitions", () => {
    it("offers the valid next statuses for active", () => {
        expect(allowedTransitions("active")).toEqual(["paused", "completed", "archived"]);
    });
    it("flags completed/archived as terminal (needs confirm)", () => {
        expect(isTerminalTransition("completed")).toBe(true);
        expect(isTerminalTransition("archived")).toBe(true);
        expect(isTerminalTransition("paused")).toBe(false);
    });
});

describe("validateDecisionDraft", () => {
    it("requires a non-empty rationale", () => {
        expect(validateDecisionDraft("summary", "  ")).toBe("Rationale is required.");
    });
    it("requires a non-empty summary", () => {
        expect(validateDecisionDraft("", "some rationale")).toBe("Summary is required.");
    });
    it("passes a complete draft", () => {
        expect(validateDecisionDraft("chose b", "b needs no migration")).toBeNull();
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run frontend/app/view/jarvis/tasksderive.test.ts`
Expected: FAIL — `allowedTransitions`/`isTerminalTransition`/`validateDecisionDraft` are not exported.

- [ ] **Step 3: Add the derive helpers**

Append to `frontend/app/view/jarvis/tasksderive.ts`:

```ts
// The valid status transitions offered in the UI for each current status.
const STATUS_TRANSITIONS: Record<string, string[]> = {
    active: ["paused", "completed", "archived"],
    paused: ["active", "completed", "archived"],
    completed: ["active", "archived"],
    archived: ["active"],
};

export function allowedTransitions(status: string): string[] {
    return STATUS_TRANSITIONS[status] ?? [];
}

// completed/archived are terminal — the UI confirms before applying them.
export function isTerminalTransition(status: string): boolean {
    return status === "completed" || status === "archived";
}

// validateDecisionDraft returns an error message, or null when the draft is submittable.
export function validateDecisionDraft(summary: string, rationale: string): string | null {
    if (rationale.trim() === "") return "Rationale is required.";
    if (summary.trim() === "") return "Summary is required.";
    return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run frontend/app/view/jarvis/tasksderive.test.ts`
Expected: PASS (all groupDossiers + transition + validation tests).

- [ ] **Step 5: Add the append-decision form to the decision log**

Replace the entire contents of `frontend/app/view/jarvis/decisionlog.tsx` with:

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { cn } from "@/util/util";
import { useState } from "react";
import { appendDecision } from "./tasksstore";
import { validateDecisionDraft } from "./tasksderive";

function fmtDate(ms: number): string {
    if (!ms) return "";
    return new Date(ms).toISOString().slice(0, 10);
}

function DecisionCardRow({ card }: { card: DecisionCard }) {
    return (
        <div className="rounded-lg border border-border bg-surface px-3.5 py-3">
            <div className="mb-1.5 flex items-center gap-2 text-[11px] text-muted">
                <span className="font-mono">{fmtDate(card.created)}</span>
                <span className="rounded bg-surface-hover px-1.5 py-0.5 font-mono">{card.actor}</span>
                {card.status !== "active" ? (
                    <span className="rounded bg-warning/12 px-1.5 py-0.5 font-mono text-warning">{card.status}</span>
                ) : null}
            </div>
            <div className="whitespace-pre-wrap text-[13px] leading-[1.55] text-secondary">{card.rationale}</div>
        </div>
    );
}

function AppendForm({ dossierId, onDone }: { dossierId: string; onDone: () => void }) {
    const [summary, setSummary] = useState("");
    const [rationale, setRationale] = useState("");
    const err = validateDecisionDraft(summary, rationale);
    const submit = () => {
        if (err != null) return;
        appendDecision(dossierId, summary.trim(), rationale.trim(), []);
        onDone();
    };
    return (
        <div className="rounded-lg border border-accent/30 bg-surface px-3.5 py-3">
            <input
                value={summary}
                onChange={(e) => setSummary(e.target.value)}
                placeholder="Short summary (filename)"
                className="mb-2 w-full rounded border border-border bg-background px-2.5 py-1.5 text-[13px] text-primary outline-none focus:border-accent"
            />
            <textarea
                value={rationale}
                onChange={(e) => setRationale(e.target.value)}
                placeholder="Rationale — why this decision was made"
                rows={4}
                className="mb-2 w-full resize-y rounded border border-border bg-background px-2.5 py-1.5 text-[13px] text-primary outline-none focus:border-accent"
            />
            <div className="flex items-center justify-end gap-2">
                <button
                    type="button"
                    onClick={onDone}
                    className="cursor-pointer rounded px-3 py-1.5 text-[12.5px] font-semibold text-muted hover:text-secondary"
                >
                    Cancel
                </button>
                <button
                    type="button"
                    onClick={submit}
                    disabled={err != null}
                    className={cn(
                        "cursor-pointer rounded bg-accent px-3 py-1.5 text-[12.5px] font-bold text-background hover:bg-accenthover",
                        err != null && "cursor-not-allowed opacity-50"
                    )}
                >
                    Add decision
                </button>
            </div>
        </div>
    );
}

export function DecisionLog({ decisions, dossierId }: { decisions: DecisionCard[]; dossierId: string }) {
    const [adding, setAdding] = useState(false);
    return (
        <div className="flex flex-col gap-2.5">
            {decisions.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border px-3.5 py-4 text-[12.5px] text-muted">
                    No decisions yet.
                </div>
            ) : (
                decisions.map((c) => <DecisionCardRow key={c.id} card={c} />)
            )}
            {adding ? (
                <AppendForm dossierId={dossierId} onDone={() => setAdding(false)} />
            ) : (
                <button
                    type="button"
                    onClick={() => setAdding(true)}
                    className="self-start rounded border border-border px-3 py-1.5 text-[12.5px] font-semibold text-secondary hover:bg-surface-hover"
                >
                    + Add decision
                </button>
            )}
        </div>
    );
}
```

Note: the `adding` toggle is local `useState` — acceptable here because it is transient draft state on a mounted child, not survive-the-unmount state (a nav-switch away discards an in-progress draft by design).

- [ ] **Step 6: Add the status control to the detail header**

In `frontend/app/view/jarvis/taskdetail.tsx`, add imports at the top (after the existing imports):

```tsx
import { ConfirmDialog } from "@/app/modals/confirmdialog";
import { useState } from "react";
import { allowedTransitions, isTerminalTransition } from "./tasksderive";
import { setDossierStatus } from "./tasksstore";
```

Add a `StatusControl` component (above `TaskDetail`):

```tsx
function StatusControl({ dossierId, status }: { dossierId: string; status: string }) {
    const [pending, setPending] = useState<string | null>(null);
    const apply = (next: string) => {
        if (isTerminalTransition(next)) {
            setPending(next);
        } else {
            setDossierStatus(dossierId, next);
        }
    };
    return (
        <>
            <div className="flex items-center gap-1.5">
                {allowedTransitions(status).map((next) => (
                    <button
                        key={next}
                        type="button"
                        onClick={() => apply(next)}
                        className="cursor-pointer rounded border border-border px-2 py-0.5 font-mono text-[11px] text-secondary hover:bg-surface-hover"
                    >
                        → {next}
                    </button>
                ))}
            </div>
            {pending != null ? (
                <ConfirmDialog
                    tone={pending === "archived" ? "danger" : "warning"}
                    title={`Mark this task ${pending}?`}
                    body={`This sets the dossier status to "${pending}". You can reactivate it later.`}
                    confirmLabel={`Yes, ${pending}`}
                    cancelLabel="Cancel"
                    onConfirm={() => {
                        setDossierStatus(dossierId, pending);
                        setPending(null);
                    }}
                    onClose={() => setPending(null)}
                />
            ) : null}
        </>
    );
}
```

Then render it in the header — replace the status/confidence line block (the `<div className="mt-1 flex items-center gap-2 ...">` block) with:

```tsx
                <div className="mt-1.5 flex items-center gap-3 text-[12px] text-muted">
                    <span
                        className={cn(
                            "rounded px-1.5 py-0.5 font-mono",
                            detail.status === "active" ? "bg-success/12 text-success" : "bg-surface-hover"
                        )}
                    >
                        {detail.status}
                    </span>
                    {detail.confidence ? <span>confidence: {detail.confidence}</span> : null}
                    <StatusControl dossierId={detail.id} status={detail.status} />
                </div>
```

- [ ] **Step 7: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 8: Verify writes in the live dev app (CDP / manual)**

With `task dev` running, on the Tasks surface: click "+ Add decision", enter a summary + rationale, submit → the new card appears (human/date badge). Click "→ completed" → a confirm dialog appears; confirm → the status chip updates and the row moves to Done. Capture `node scripts/cdp-shot.mjs cdp-shots/u2-write.png`.
Expected: both writes round-trip; the dossier is updated on disk (a `git log` in the vault shows a user-authored decision commit + a Jarvis refs commit, and a status commit).

- [ ] **Step 9: Checkpoint**

Run: `npx vitest run frontend/app/view/jarvis/tasksderive.test.ts`
Expected: PASS. Both write affordances work end-to-end (verified in Step 8).

---

## Task 8: Frontend — Spaces deep-link ("Open dossier" from the app-bar chip)

Add an "Open dossier" row to the U1 Space switcher that navigates to the Tasks surface; the preselect logic (reading `activeSpaceAtom`) already lives in `TasksSurface` (Task 5, Step 8).

**Files:**
- Modify: `frontend/app/view/agents/spaceswitcher.tsx` (accept `model`; add the "Open dossier" row)
- Modify: `frontend/app/cockpit/app-bar.tsx` (pass `model` to `<SpaceSwitcher/>`)

**Interfaces:**
- Consumes: `AgentsViewModel.surfaceAtom`; `globalStore`; `activeSpaceAtom` (already imported in the switcher).
- Produces: `<SpaceSwitcher model={model}/>` with an "Open dossier ↗" row.

- [ ] **Step 1: Pass the model to the switcher**

In `frontend/app/cockpit/app-bar.tsx`, change the render (line 58) from `<SpaceSwitcher />` to:

```tsx
                <SpaceSwitcher model={model} />
```

- [ ] **Step 2: Add the "Open dossier" row**

In `frontend/app/view/agents/spaceswitcher.tsx`, update the imports + signature and add the row. Replace the top of the file (imports + the `export function SpaceSwitcher()` line) with:

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { PopoverReveal } from "@/app/element/popoverreveal";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { useState } from "react";
import type { AgentsViewModel } from "./agents";
import { activeSpaceAtom, enterSpace, exitSpace, loadSpaces, spacesAtom } from "./spacestore";

// App-bar Space (Presence C) switcher: "◇ <objective> ▾" (or "Global"). Mirrors ProjectSwitcher's
// bar trigger + PopoverReveal dropdown. Selecting a task focuses it; "Global" returns to no-focus;
// "Open dossier" navigates to the Tasks surface (U2) for the active Space.
export function SpaceSwitcher({ model }: { model: AgentsViewModel }) {
```

Then, inside the dropdown, add the "Open dossier" row immediately after the `Global (no focus)` button and before the `{spaces.map(...)}` list (i.e., after the closing `</button>` of the Global row, ~line 60):

```tsx
                    {active != null ? (
                        <button
                            type="button"
                            onClick={() => {
                                globalStore.set(model.surfaceAtom, "tasks");
                                close();
                            }}
                            className="flex w-full cursor-pointer items-center gap-2.5 rounded px-2 py-2 text-left text-accent hover:bg-surface-hover"
                        >
                            <span className="flex-1 truncate text-[13px] font-medium">Open dossier ↗</span>
                        </button>
                    ) : null}
```

- [ ] **Step 3: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 4: Verify the deep-link in the live dev app (CDP / manual)**

With `task dev` running: open the app-bar Space chip, pick a task to focus it (a Space becomes active), reopen the chip → an "Open dossier ↗" row appears; click it → the Tasks surface opens with that dossier preselected in the detail pane. Capture `node scripts/cdp-shot.mjs cdp-shots/u2-deeplink.png`.
Expected: navigation + preselect works; switching to a different focused Space then re-opening the dossier shows the new one.

- [ ] **Step 5: Checkpoint**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit && npx vitest run frontend/app/view/jarvis/tasksderive.test.ts`
Expected: both clean/PASS.

---

## Final: Full verification + commit (with approval)

- [ ] **Step 1: Full backend test sweep**

Run: `go build ./... && go test ./pkg/wavevault/ ./pkg/jarvisdossier/ ./pkg/wshrpc/...`
Expected: PASS.

- [ ] **Step 2: Full frontend typecheck + Tasks unit tests**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit && npx vitest run frontend/app/view/jarvis/tasksderive.test.ts`
Expected: exit 0 / PASS.

- [ ] **Step 3: Regeneration is clean**

Run: `task generate` then `git status`
Expected: no unexpected diffs beyond the U2-added commands (generated files already committed in Tasks 3–4).

- [ ] **Step 4: Update the meta-spec tracking table**

In `docs/superpowers/specs/2026-07-24-jarvis-second-brain-v2-meta-spec.md`, fill the U2 row (spec + plan links + a one-line "Built — …" summary), matching the U1/S1 row style.

- [ ] **Step 5: Commit (only after explicit user approval)**

Per the user's git workflow, batch the whole feature into one commit with the spec doc folded in. Confirm approval first, then:

```bash
git add pkg/wavevault pkg/jarvisdossier pkg/wshrpc frontend/app/view/jarvis frontend/app/view/agents frontend/app/cockpit frontend/app/store/wshclientapi.ts docs/superpowers/specs/2026-07-24-jarvis-u2-tasks-surface-design.md docs/superpowers/specs/2026-07-24-jarvis-second-brain-v2-meta-spec.md docs/superpowers/plans/2026-07-24-jarvis-u2-tasks-surface.md
git commit -m "feat(jarvis): U2 Tasks surface — dossier editor (v2 UX lane)" -m "Read-only machine regions + human append-decision/status writes; CreateHuman attribution; new nav surface + Space deep-link."
```

---

## Self-Review notes

- **Spec coverage:** §2 A/B additions → Tasks 1–2; §2 RPCs → Tasks 3–4; §3 contract → Tasks 3–4 types; §4 nav/store/layout → Tasks 5–7; §5 Spaces deep-link → Task 8; §6 degradation → store try/catch + `SurfaceError` (Tasks 5–7) + status conflict-retry (Task 4); §7 testing → per-task Go/vitest + CDP steps.
- **Deferred (spec §9, intentionally no task):** in-Wave Notes editing, non-reserved frontmatter editing, editing existing decisions, manual dossier creation, semantic/probation edge rendering, the Graph surface, live push. Record the Notes-editing + completed/archived-browsing deferrals in `docs/deferred.md` during Task 6.
- **Type consistency:** `CommandListTaskDossiersRtnData.Dossiers` is `[]SpaceSummary` (reused), consumed on the FE as `rtn.dossiers`; `GetDossierCommand` returns `*DossierDetail` → FE `DossierDetail`; `AppendDossierDecisionCommand` data fields `dossierid/summary/rationale/links`; `SetDossierStatusCommand` data fields `dossierid/status`. Store mutator names (`loadTaskList`, `selectDossier`, `appendDecision`, `setDossierStatus`) are consistent across `tasksstore.ts`, `taskssurface.tsx`, `decisionlog.tsx`, `taskdetail.tsx`.
