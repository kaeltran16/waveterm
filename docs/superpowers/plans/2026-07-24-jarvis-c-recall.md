# Jarvis sub-project C — Recall engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace F's SQLite recall shim with real recall over the Wave Vault graph, and wire a thin dispatch→dossier writer so the swap is live.

**Architecture:** A new tiny writer package (`pkg/jarviscapture`) creates a dossier at Run dispatch. The existing reader package (`pkg/jarvisrecall`) is rewritten: its retrieval moves from scanning SQLite objects to traversing the vault via A's `Retriever` (deterministic query analysis → layer-1 `Query` + layer-2 `Search` → top-k seeds → bounded `Expand`), resolving referenced Runs live from `wstore`. `Converse`'s signature and stream shape are unchanged, so F's Go/FE code is untouched.

**Tech Stack:** Go 1.x, `pkg/wavevault` (A), `pkg/jarvisdossier` (B), `pkg/wstore`, `consult.Run` (headless `claude`). No new WaveObj type, no migration, no `task generate` (no wire type changes).

## Global Constraints

- **Recall is a pure reader.** `pkg/jarvisrecall` never writes the vault. All vault writes live in `pkg/jarviscapture`.
- **The graph is vault-only; leaf/attached values resolve live.** Runs/Radar are not first-class retrieval sources. A Run enters a recall only via a vault `[[run-<oid>]]` reference or an explicit attachment, then resolves from `wstore` at synthesis time.
- **Determinism boundary = cost boundary.** Retrieval (query analysis, `Query`/`Search`/`Expand`, run-ref resolution) is deterministic and free. The only model call is the one synthesis in `Converse` (mocked in tests via `SetSynthesizeForTest`).
- **No copying Run evidence into Markdown.** Dossiers reference Runs; they never embed Run transcripts/diffs.
- **PLACEHOLDER tuning** (recorded in `docs/deferred.md`): `seedTopK = 6`, `expandDepth = 2`, `expandFanout = 8`, `maxCandidates = 12` (existing), one-dossier-per-Run capture grouping.
- **Windows env; Go tests** via `go test ./pkg/<pkg>/`. Single test: `go test ./pkg/<pkg>/ -run TestName -v`.
- **Git workflow (user override):** do NOT commit without explicit approval. Each task ends by **staging** its files; a single feature commit (including the spec + `docs/deferred.md`) is made at the end on approval. Do not add a co-author.

---

### Task 1: `pkg/jarviscapture` — dispatch→dossier writer + wshserver hook

**Files:**
- Create: `pkg/jarviscapture/capture.go`
- Create: `pkg/jarviscapture/capture_test.go`
- Modify: `pkg/wshrpc/wshserver/wshserver_runs.go` (add import; one non-fatal call in `CreateRunCommand` after `AppendRun`, ~line 218)

**Interfaces:**
- Consumes: `wavevault.OpenVault(ctx) (*wavevault.Vault, error)`, `wavevault.OpenVaultAtForTest(ctx, root) (*wavevault.Vault, error)`, `(*wavevault.Vault).Commit(ctx, label) error`, `(*wavevault.Vault).Retriever(scope) *Retriever`, `wavevault.AllScope()`, `wavevault.Filter{HasLink,FrontmatterEquals}`, `jarvisdossier.CreateDossier(v, DossierFacts) (id, hash string, err error)`, `jarvisdossier.SetRefs(v, id, refs []string, baseHash) (*WriteResult, error)`, `waveobj.Run{OID, Goal string}`.
- Produces: `jarviscapture.CaptureRunDispatch(ctx context.Context, run *waveobj.Run) error` (called by wshserver), and unexported `captureRunDossier(ctx, v *wavevault.Vault, run *waveobj.Run) (string, error)` + `extractTicket(goal string) string`.

- [ ] **Step 1: Write the failing test**

Create `pkg/jarviscapture/capture_test.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarviscapture

import (
	"context"
	"os/exec"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/wavevault"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func TestExtractTicket(t *testing.T) {
	cases := map[string]string{
		"fix ABC-123 login bug":   "ABC-123",
		"no ticket here":          "",
		"lowercase abc-1 ignored": "",
		"WAVE-9 and JIRA-42":      "WAVE-9",
	}
	for goal, want := range cases {
		if got := extractTicket(goal); got != want {
			t.Errorf("extractTicket(%q)=%q want %q", goal, got, want)
		}
	}
}

func TestCaptureRunDossierLinksRunAndCommits(t *testing.T) {
	ctx := context.Background()
	v, err := wavevault.OpenVaultAtForTest(ctx, t.TempDir())
	if err != nil {
		t.Fatalf("open vault: %v", err)
	}
	oid := "aaaaaaaa-0000-0000-0000-000000000001"
	run := &waveobj.Run{OID: oid, Goal: "ship ABC-7 the widget"}

	if _, err := captureRunDossier(ctx, v, run); err != nil {
		t.Fatalf("captureRunDossier: %v", err)
	}

	// the dossier links the run and carries the extracted ticket
	r := v.Retriever(wavevault.AllScope())
	linked, err := r.Query(wavevault.Filter{HasLink: "run-" + oid})
	if err != nil || len(linked) != 1 {
		t.Fatalf("HasLink query: err=%v hits=%d (want 1)", err, len(linked))
	}
	ticketed, _ := v.Retriever(wavevault.AllScope()).Query(wavevault.Filter{FrontmatterEquals: map[string]string{"ticket": "ABC-7"}})
	if len(ticketed) != 1 {
		t.Fatalf("ticket query hits=%d want 1", len(ticketed))
	}

	// the write landed in a commit (working tree clean)
	out, err := exec.CommandContext(ctx, "git", "-C", v.Root, "status", "--porcelain").Output()
	if err != nil {
		t.Fatalf("git status: %v", err)
	}
	if len(out) != 0 {
		t.Fatalf("working tree not clean after capture:\n%s", out)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./pkg/jarviscapture/ -v`
Expected: FAIL — package/undefined `captureRunDossier`, `extractTicket`.

- [ ] **Step 3: Write minimal implementation**

Create `pkg/jarviscapture/capture.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Package jarviscapture is the thin dispatch->dossier writer for the Jarvis second brain.
// It creates a real dossier when a Run is dispatched so recall (sub-project C) has vault nodes
// to traverse. Deliberately separate from pkg/jarvisrecall, which stays a pure reader.
package jarviscapture

import (
	"context"
	"regexp"

	"github.com/wavetermdev/waveterm/pkg/jarvisdossier"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wavevault"
)

// ticketRe matches an uppercase ticket identifier like ABC-123 (project key + number).
var ticketRe = regexp.MustCompile(`[A-Z][A-Z0-9]+-\d+`)

// extractTicket returns the first ticket id in a run goal, or "" if none.
func extractTicket(goal string) string {
	return ticketRe.FindString(goal)
}

// CaptureRunDispatch creates a dossier for a freshly dispatched run in the default vault. Non-fatal:
// the caller logs and continues on error (dispatch must not fail because capture did).
func CaptureRunDispatch(ctx context.Context, run *waveobj.Run) error {
	v, err := wavevault.OpenVault(ctx)
	if err != nil {
		return err
	}
	_, err = captureRunDossier(ctx, v, run)
	return err
}

// captureRunDossier creates the dossier, references the run, and commits. Returns the dossier id.
// Takes an explicit vault so tests exercise it against a fixture vault.
func captureRunDossier(ctx context.Context, v *wavevault.Vault, run *waveobj.Run) (string, error) {
	id, hash, err := jarvisdossier.CreateDossier(v, jarvisdossier.DossierFacts{
		Ticket:    extractTicket(run.Goal),
		Objective: run.Goal,
		Confidence: "med",
	})
	if err != nil {
		return "", err
	}
	if _, err := jarvisdossier.SetRefs(v, id, []string{"run-" + run.OID}, hash); err != nil {
		return id, err
	}
	if err := v.Commit(ctx, "jarvis: capture dossier for run "+run.OID); err != nil {
		return id, err
	}
	return id, nil
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./pkg/jarviscapture/ -v`
Expected: PASS (`TestExtractTicket`, `TestCaptureRunDossierLinksRunAndCommits`).

- [ ] **Step 5: Wire the non-fatal hook into `CreateRunCommand`**

In `pkg/wshrpc/wshserver/wshserver_runs.go`, add the import (alphabetical, with the other `pkg/...` imports):

```go
	"github.com/wavetermdev/waveterm/pkg/jarviscapture"
```

Then in `CreateRunCommand`, immediately after the `if run.RadarOrigin != nil { ... }` block and before `spawnRunWorkers` (currently ~line 226), add:

```go
	if err := jarviscapture.CaptureRunDispatch(ctx, &run); err != nil {
		log.Printf("CreateRun: capturing dossier failed (non-fatal): %v", err)
	}
```

- [ ] **Step 6: Verify the build compiles**

Run: `go build ./pkg/wshrpc/wshserver/ ./pkg/jarviscapture/`
Expected: no output (exit 0).

- [ ] **Step 7: Stage (commit deferred to approval)**

```bash
git add pkg/jarviscapture/ pkg/wshrpc/wshserver/wshserver_runs.go
```

---

### Task 2: `pkg/jarvisrecall/retrieve.go` — deterministic vault retrieval pipeline

Adds the pure, fixture-testable retrieval pipeline. It is **not yet wired** into `Converse` (Task 3 does that), so the build stays green and the shim keeps working.

**Files:**
- Create: `pkg/jarvisrecall/retrieve.go`
- Create: `pkg/jarvisrecall/retrieve_test.go`

**Interfaces:**
- Consumes: `(*wavevault.Retriever).Query(Filter) ([]Node, error)`, `.Search(query) ([]Hit, error)`, `.Expand(seeds []string, ExpandOpts{Depth,Fanout}) (*Subgraph, error)`, `.Read(id) (*NodeWithBody, error)`; `wavevault.Node{ID, Frontmatter map[string]any, Links []string, Collection string, UpdatedTs int64}`; `wavevault.CollTasks`, `wavevault.CollDecisions`; the existing `candidate` struct (`cards.go`: fields `sourceType,title,project,ts,freshness,navTarget,snippet`).
- Produces: `analyzeQuery(q string) (tickets []string, keywords []string)`, `selectSeeds(r *wavevault.Retriever, q string) ([]string, error)`, `nodeCandidate(n wavevault.Node, body string) candidate`, and consts `seedTopK=6`, `expandDepth=2`, `expandFanout=8`. A shared test helper `seedVault(t) (*wavevault.Vault, string)` (returns vault + dossier id).

- [ ] **Step 1: Write the failing test**

Create `pkg/jarvisrecall/retrieve_test.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvisrecall

import (
	"context"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/jarvisdossier"
	"github.com/wavetermdev/waveterm/pkg/wavevault"
)

// seedRunOID is the run a seeded dossier references. Tests insert a matching wstore Run when they
// need it resolved.
const seedRunOID = "dddddddd-0000-0000-0000-000000000001"

// seedVault builds a fixture vault: a dossier (ticket ABC-123) that references seedRunOID and a
// decision whose rationale body mentions "widget". Returns the vault and the dossier id.
func seedVault(t *testing.T) (*wavevault.Vault, string) {
	t.Helper()
	ctx := context.Background()
	v, err := wavevault.OpenVaultAtForTest(ctx, t.TempDir())
	if err != nil {
		t.Fatalf("open vault: %v", err)
	}
	id, hash, err := jarvisdossier.CreateDossier(v, jarvisdossier.DossierFacts{
		Ticket: "ABC-123", Objective: "ship the thing", Confidence: "med",
	})
	if err != nil {
		t.Fatalf("create dossier: %v", err)
	}
	if _, err := jarvisdossier.SetRefs(v, id, []string{"run-" + seedRunOID}, hash); err != nil {
		t.Fatalf("set refs: %v", err)
	}
	if _, err := jarvisdossier.AppendDecision(v, jarvisdossier.DecisionFacts{
		TaskID: id, Actor: "jarvis", Provenance: "test",
		Summary: "widget approach", Rationale: "we chose the widget approach because it is simplest",
	}); err != nil {
		t.Fatalf("append decision: %v", err)
	}
	return v, id
}

func TestAnalyzeQuery(t *testing.T) {
	tickets, keywords := analyzeQuery("Why the WIDGET approach for ABC-123?")
	if len(tickets) != 1 || tickets[0] != "ABC-123" {
		t.Fatalf("tickets=%v want [ABC-123]", tickets)
	}
	has := func(w string) bool {
		for _, k := range keywords {
			if k == w {
				return true
			}
		}
		return false
	}
	if !has("widget") || !has("approach") {
		t.Fatalf("keywords=%v want widget+approach", keywords)
	}
	if has("the") || has("for") {
		t.Fatalf("short stopwords not dropped: %v", keywords)
	}
}

func TestSelectSeedsRanksStructuredFirst(t *testing.T) {
	v, dossierID := seedVault(t)
	r := v.Retriever(wavevault.AllScope())
	seeds, err := selectSeeds(r, "why the widget approach for ABC-123")
	if err != nil {
		t.Fatalf("selectSeeds: %v", err)
	}
	if len(seeds) < 2 {
		t.Fatalf("expected dossier + decision seeds, got %v", seeds)
	}
	if seeds[0] != dossierID {
		t.Fatalf("structured (ticket) hit should rank first, got %v", seeds)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./pkg/jarvisrecall/ -run 'TestAnalyzeQuery|TestSelectSeeds' -v`
Expected: FAIL — undefined `analyzeQuery`, `selectSeeds`.

- [ ] **Step 3: Write minimal implementation**

Create `pkg/jarvisrecall/retrieve.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvisrecall

import (
	"fmt"
	"regexp"
	"sort"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/wavevault"
)

// Deterministic retrieval bounds (PLACEHOLDER — tune against a populated vault; see docs/deferred.md).
const (
	seedTopK     = 6
	expandDepth  = 2
	expandFanout = 8
)

var (
	queryTicketRe = regexp.MustCompile(`[A-Z][A-Z0-9]+-\d+`)
	queryTokenRe  = regexp.MustCompile(`[a-z0-9]+`)
)

// analyzeQuery pulls structured ticket ids and lowercase keyword tokens (len>=4) from a question.
// This is the deterministic stand-in for model-driven intent classification (deferred with tiering).
func analyzeQuery(q string) (tickets []string, keywords []string) {
	tickets = dedupe(queryTicketRe.FindAllString(q, -1))
	var toks []string
	for _, tok := range queryTokenRe.FindAllString(strings.ToLower(q), -1) {
		if len(tok) >= 4 {
			toks = append(toks, tok)
		}
	}
	return tickets, dedupe(toks)
}

func dedupe(in []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, s := range in {
		if !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	return out
}

// selectSeeds runs layer-1 (structured ticket Query) + layer-2 (full-text Search per keyword),
// merges/dedupes, ranks structured hits first then by recency, and returns the top-k node ids.
func selectSeeds(r *wavevault.Retriever, q string) ([]string, error) {
	tickets, keywords := analyzeQuery(q)
	type hit struct {
		id         string
		structured bool
		ts         int64
	}
	seen := map[string]hit{}
	order := []string{}
	add := func(id string, structured bool, ts int64) {
		if _, ok := seen[id]; ok {
			return
		}
		seen[id] = hit{id, structured, ts}
		order = append(order, id)
	}
	for _, tk := range tickets {
		nodes, err := r.Query(wavevault.Filter{FrontmatterEquals: map[string]string{"ticket": tk}})
		if err != nil {
			return nil, err
		}
		for _, n := range nodes {
			add(n.ID, true, n.UpdatedTs)
		}
	}
	for _, kw := range keywords {
		hits, err := r.Search(kw)
		if err != nil {
			return nil, err
		}
		for _, h := range hits {
			add(h.Node.ID, false, h.Node.UpdatedTs)
		}
	}
	hits := make([]hit, 0, len(order))
	for _, id := range order {
		hits = append(hits, seen[id])
	}
	sort.SliceStable(hits, func(i, j int) bool {
		if hits[i].structured != hits[j].structured {
			return hits[i].structured
		}
		return hits[i].ts > hits[j].ts
	})
	if len(hits) > seedTopK {
		hits = hits[:seedTopK]
	}
	ids := make([]string, len(hits))
	for i, h := range hits {
		ids[i] = h.id
	}
	return ids, nil
}

// nodeCandidate maps a vault node + its body into a grounding candidate. Vault nodes are the
// canonical source, so freshness is always "fresh"; nav is a best-effort vault: target (G tolerates
// non-ORef nav targets, same as memory:).
func nodeCandidate(n wavevault.Node, body string) candidate {
	st := "memory"
	switch n.Collection {
	case wavevault.CollTasks:
		st = "dossier"
	case wavevault.CollDecisions:
		st = "decision"
	}
	return candidate{
		sourceType: st,
		title:      nodeTitle(n),
		ts:         n.UpdatedTs,
		freshness:  "fresh",
		navTarget:  "vault:" + n.ID,
		snippet:    truncate(strings.TrimSpace(body), 240),
	}
}

func nodeTitle(n wavevault.Node) string {
	if v, ok := n.Frontmatter["objective"]; ok {
		if s := fmt.Sprintf("%v", v); s != "" && s != "<nil>" {
			return s
		}
	}
	return n.ID
}

func truncate(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max]
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./pkg/jarvisrecall/ -run 'TestAnalyzeQuery|TestSelectSeeds' -v`
Expected: PASS.

- [ ] **Step 5: Verify the whole package still builds and existing tests pass**

Run: `go test ./pkg/jarvisrecall/`
Expected: PASS (the shim's existing tests are untouched; `retrieve.go` is unused so far).

- [ ] **Step 6: Stage (commit deferred to approval)**

```bash
git add pkg/jarvisrecall/retrieve.go pkg/jarvisrecall/retrieve_test.go
```

---

### Task 3: Wire the vault pipeline into `Converse`; resolve run-refs; remove the SQLite scan

Swaps `retrieve()` to traverse the vault and resolve referenced Runs from `wstore`, behind the unchanged `Converse` signature. Deletes the shim's SQLite-scan retrieval.

**Files:**
- Modify: `pkg/jarvisrecall/recall.go` (rewrite `retrieve`; add `assembleSlice`, `resolveRunRef`, `unavailableRunCandidate`, `scopeToVault`, `openVault` seam + `SetOpenVaultForTest`; delete `retrieveScoped` and `scopeProject`; update the `Converse` call site to pass `prompt`)
- Modify: `pkg/jarvisrecall/converse_test.go` (add vault-backed recall tests)

**Interfaces:**
- Consumes (Task 2): `selectSeeds`, `nodeCandidate`, `expandDepth`, `expandFanout`. Existing (`recall.go`/`cards.go`): `resolveAttached`, `assembleCandidates`, `sortByRecency`, `inScope`, `runCandidate`, `maxCandidates`, `candidate`. From A: `wavevault.OpenVault`, `wavevault.AllScope`, `(*Vault).Retriever`, `(*Retriever).Expand/.Read`. From wstore: `DBMustGet[*waveobj.Run]`.
- Produces: `retrieve(ctx, scope ScopeArgs, query string) ([]candidate, error)` (rewritten), `assembleSlice(ctx, r *wavevault.Retriever, scope ScopeArgs, query string) ([]candidate, error)`, `SetOpenVaultForTest(fn) (old func)`, `resolveRunRef(ctx, ref string, scope ScopeArgs) []candidate`, `unavailableRunCandidate(oid string) candidate`, `scopeToVault(scope ScopeArgs) wavevault.Scope`.

- [ ] **Step 1: Write the failing tests**

Append to `pkg/jarvisrecall/converse_test.go`:

```go
func TestRetrieveTraversesVaultAndResolvesRun(t *testing.T) {
	ctx := context.Background()
	v, _ := seedVault(t)
	restore := SetOpenVaultForTest(func(context.Context) (*wavevault.Vault, error) { return v, nil })
	defer SetOpenVaultForTest(restore)

	// the referenced run exists in wstore -> resolved live
	run := &waveobj.Run{OID: seedRunOID, ID: seedRunOID, Goal: "ship the thing", Status: "done", ProjectPath: `C:\src\demo`, Meta: make(waveobj.MetaMapType)}
	if err := wstore.DBInsert(ctx, run); err != nil {
		t.Fatalf("insert run: %v", err)
	}
	t.Cleanup(func() { _ = wstore.DBDelete(ctx, waveobj.OType_Run, seedRunOID) })

	cands, err := retrieve(ctx, ScopeArgs{Mode: "all"}, "why the widget approach for ABC-123")
	if err != nil {
		t.Fatalf("retrieve: %v", err)
	}
	var sawDossier, sawDecision, sawRun bool
	for _, c := range cands {
		switch c.sourceType {
		case "dossier":
			sawDossier = true
		case "decision":
			sawDecision = true
		case "run":
			sawRun = true
			if c.freshness != "fresh" {
				t.Errorf("resolved run freshness=%q want fresh", c.freshness)
			}
		}
	}
	if !sawDossier || !sawDecision || !sawRun {
		t.Fatalf("missing sources: dossier=%v decision=%v run=%v", sawDossier, sawDecision, sawRun)
	}
}

func TestRetrieveSurfacesUnavailableRun(t *testing.T) {
	ctx := context.Background()
	v, _ := seedVault(t) // references seedRunOID, which is NOT inserted into wstore here
	restore := SetOpenVaultForTest(func(context.Context) (*wavevault.Vault, error) { return v, nil })
	defer SetOpenVaultForTest(restore)

	cands, err := retrieve(ctx, ScopeArgs{Mode: "all"}, "ABC-123")
	if err != nil {
		t.Fatalf("retrieve: %v", err)
	}
	var unavailable bool
	for _, c := range cands {
		if c.sourceType == "run" && c.freshness == "unavailable" {
			unavailable = true
		}
	}
	if !unavailable {
		t.Fatalf("deleted run should surface as unavailable, got %+v", cands)
	}
}

func TestWorkerScopeCannotSeeTasks(t *testing.T) {
	v, dossierID := seedVault(t)
	// AllScope sees the dossier...
	if _, err := v.Retriever(wavevault.AllScope()).Read(dossierID); err != nil {
		t.Fatalf("AllScope should see the dossier: %v", err)
	}
	// ...WorkerScope (memory+decisions) physically cannot.
	if _, err := v.Retriever(wavevault.WorkerScope()).Read(dossierID); err == nil {
		t.Fatalf("WorkerScope must not see tasks/ dossiers")
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./pkg/jarvisrecall/ -run 'TestRetrieveTraverses|TestRetrieveSurfaces|TestWorkerScope' -v`
Expected: FAIL — `retrieve` takes 2 args / `SetOpenVaultForTest` undefined.

- [ ] **Step 3: Rewrite `retrieve` and add the vault helpers**

In `pkg/jarvisrecall/recall.go`, replace the `retrieve` and `retrieveScoped` functions (currently lines ~90–131) with:

```go
// openVault is a seam so tests point recall at a fixture vault.
var openVault = wavevault.OpenVault

// SetOpenVaultForTest swaps the vault opener; returns the previous value for restore.
func SetOpenVaultForTest(fn func(context.Context) (*wavevault.Vault, error)) func(context.Context) (*wavevault.Vault, error) {
	old := openVault
	openVault = fn
	return old
}

// scopeToVault maps a caller scope to a vault collection scope. Interactive callers (F) see
// everything; the worker path (WorkerScope) is exposed by A but has no wired consumer in v1.
func scopeToVault(scope ScopeArgs) wavevault.Scope {
	return wavevault.AllScope()
}

// retrieve assembles the grounded slice: attached objects pinned live, plus a vault traversal
// (deterministic seeds -> Expand) with referenced Runs resolved live from wstore.
func retrieve(ctx context.Context, scope ScopeArgs, query string) ([]candidate, error) {
	pinned := resolveAttached(ctx, scope.AttachedORefs)
	v, err := openVault(ctx)
	if err != nil {
		return nil, err
	}
	r := v.Retriever(scopeToVault(scope))
	slice, err := assembleSlice(ctx, r, scope, query)
	if err != nil {
		return nil, err
	}
	sortByRecency(slice)
	return assembleCandidates(pinned, slice, maxCandidates), nil
}

// assembleSlice walks the vault from ranked seeds and turns the neighborhood into candidates,
// resolving each [[run-<oid>]] reference live from wstore (or surfacing it as unavailable).
func assembleSlice(ctx context.Context, r *wavevault.Retriever, scope ScopeArgs, query string) ([]candidate, error) {
	seeds, err := selectSeeds(r, query)
	if err != nil {
		return nil, err
	}
	sg, err := r.Expand(seeds, wavevault.ExpandOpts{Depth: expandDepth, Fanout: expandFanout})
	if err != nil {
		return nil, err
	}
	var cands []candidate
	seenRun := map[string]bool{}
	var runRefs []string
	for _, n := range sg.Nodes {
		body := ""
		if nb, rerr := r.Read(n.ID); rerr == nil {
			body = nb.Body
		}
		cands = append(cands, nodeCandidate(n, body))
		for _, l := range n.Links {
			if strings.HasPrefix(l, "run-") && !seenRun[l] {
				seenRun[l] = true
				runRefs = append(runRefs, l)
			}
		}
	}
	for _, ref := range runRefs {
		cands = append(cands, resolveRunRef(ctx, ref, scope)...)
	}
	return cands, nil
}

// resolveRunRef resolves a "run-<oid>" reference to a live candidate. A missing run is surfaced as
// unavailable (invariant 7 — surfaced, not hidden). Project scope drops out-of-project runs.
func resolveRunRef(ctx context.Context, ref string, scope ScopeArgs) []candidate {
	oid := strings.TrimPrefix(ref, "run-")
	run, err := wstore.DBMustGet[*waveobj.Run](ctx, oid)
	if err != nil {
		return []candidate{unavailableRunCandidate(oid)}
	}
	if !inScope(scope, "run", run.ProjectPath) {
		return nil
	}
	return []candidate{runCandidate(run)}
}

func unavailableRunCandidate(oid string) candidate {
	return candidate{
		sourceType: "run",
		title:      "Run " + oid + " (unavailable)",
		freshness:  "unavailable",
		navTarget:  "run:" + oid,
	}
}
```

Then delete the now-unused `scopeProject` function (it was only used by the removed `retrieveScoped`).

Add `"strings"` to `recall.go`'s imports if not already present (it is used by the new helpers). The `wavevault` import is new to `recall.go` — add `"github.com/wavetermdev/waveterm/pkg/wavevault"`.

- [ ] **Step 4: Update the `Converse` call site to pass the query**

In `Converse` (`recall.go` ~line 49), change:

```go
	cands, err := retrieve(ctx, scope)
```

to:

```go
	cands, err := retrieve(ctx, scope, prompt)
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `go test ./pkg/jarvisrecall/ -v`
Expected: PASS — new vault tests pass; existing `TestConverse*` still pass (the attached-run test inserts its own run, resolved via `resolveAttached`, which is unchanged; note the fixture vault opened by the default `openVault` in those tests is the real default vault, which is empty, so only the pinned/attached candidates appear — the assertions only check the attached run + prior context, so they still hold).

If `TestConverseThreadsPriorContextAndTerminal` (no attached run, empty vault) now yields `notfound`: that is correct behavior with an empty default vault. Verify the test only asserts "exactly one terminal" (it does), so it still passes. If it fails because it opened the real vault and errored, wrap the default `openVault` call — but `OpenVault` creates the vault if absent, so an empty vault returns zero candidates, not an error.

- [ ] **Step 6: Verify no dead-code / unused imports across the package**

Run: `go vet ./pkg/jarvisrecall/`
Expected: no output (exit 0). If `go vet` or the build reports an unused import (e.g. `memvault` or `wstore`) after deleting `retrieveScoped`, confirm the import is still used by `resolveAttached`; both `memvault.ScanVault` and `wstore.GetRadarReports`/`DBMustGet` remain used there, so no import removal is expected.

- [ ] **Step 7: Stage (commit deferred to approval)**

```bash
git add pkg/jarvisrecall/recall.go pkg/jarvisrecall/converse_test.go
```

---

### Task 4: CDP scenario — live vault recall + dispatch capture

Adds a repeatable live-app check. Requires the dev app running (`task dev`), per the repo's CDP verification flow; this task is verified manually, not in CI.

**Files:**
- Modify: `scripts/cdp/scenarios.mjs` (add a `jarvis-vault-recall` scenario)

**Interfaces:**
- Consumes: the shared CDP attach/arrange/assert helpers in `scripts/cdp/` (follow the existing scenario objects in `scenarios.mjs`).
- Produces: a named scenario runnable via `task verify:ui -- jarvis-vault-recall`.

- [ ] **Step 1: Read the existing scenario structure**

Read `scripts/cdp/scenarios.mjs` and pick the closest existing Jarvis/recall scenario as a template (arrange → goto → shot → assert → teardown). Note the `.mjs` formatting rule: **hand-format 4-space; never run `prettier --write` on `scripts/*.mjs`** (see project memory).

- [ ] **Step 2: Add the `jarvis-vault-recall` scenario**

Following the existing scenario shape in that file, add a scenario that:
1. **arrange:** seeds the vault by dispatching a Run via the real `CreateRunCommand` (reuse the existing run-dispatch arrange used by the `runs` scenarios), which now creates a dossier through the Task 1 hook; OR injects a seeded vault fixture if an inject helper exists.
2. **goto:** the Jarvis surface; ask a question that matches the dispatched Run's goal / ticket.
3. **assert:** the answer stream produces at least one grounding card whose `sourceType` is `dossier` or `run` (not the empty-vault `notfound` state).
4. **teardown:** cancel/clean the dispatched Run as the `runs` scenarios do.

Match the surrounding code's 4-space indentation exactly.

- [ ] **Step 3: Run the scenario against the dev app**

Prereq: `task dev` running (WebView2 CDP on `:9222`, per `CLAUDE.md` visual-verification notes).
Run: `task verify:ui -- jarvis-vault-recall`
Expected: PASS row in the printed table; a grounding card appears (not `notfound`). If the dev app is not running, this step is deferred to a manual pass — note it in the PR/checkpoint rather than marking it green.

- [ ] **Step 4: Stage (commit deferred to approval)**

```bash
git add scripts/cdp/scenarios.mjs
```

---

## Final: single feature commit (on approval)

- [ ] **Confirm the full suite is green**

Run: `go test ./pkg/jarviscapture/ ./pkg/jarvisrecall/`
Expected: PASS.

- [ ] **Get explicit approval to commit, then commit once**

Per the user's git workflow, batch everything into one feature commit — including the spec and the `docs/deferred.md` entry (spec/plan docs fold into the feature commit they describe; no separate docs commit). Also add the meta-spec tracking-table C-row link at this point.

```bash
git add docs/superpowers/specs/2026-07-24-jarvis-c-recall-design.md \
        docs/superpowers/plans/2026-07-24-jarvis-c-recall.md \
        docs/deferred.md \
        docs/superpowers/specs/2026-07-23-jarvis-second-brain-meta-spec.md
git commit -F <commit message file>
```

---

## Self-Review

**1. Spec coverage:**
- Recall pipeline (query analysis → L1/L2 → seeds → Expand → run-ref resolution → synthesis) → Tasks 2 (pipeline) + 3 (wiring + resolution). ✓
- Grounding cards / freshness / terminals → Task 3 (`nodeCandidate`, `resolveRunRef`, `unavailableRunCandidate`); terminals reuse existing `selectTerminal` (already tested in `cards_test.go`). ✓
- Scope enforcement (interactive AllScope; worker WorkerScope cannot see tasks; project filters runs) → Task 3 (`scopeToVault`, `inScope` reuse, `TestWorkerScopeCannotSeeTasks`). ✓
- Thin dispatch→dossier capture → Task 1. ✓
- F swap behind unchanged protocol → Task 3 (signature/stream unchanged; only `retrieve` internals + call site). ✓
- CDP scenario → Task 4. ✓
- Deferred items recorded → `docs/deferred.md` (done during spec write). ✓

**2. Placeholder scan:** No "TBD"/"implement later"/"add error handling" — all steps show concrete code or exact commands. The PLACEHOLDER *tuning constants* are intentional, named, and recorded in `docs/deferred.md`. ✓

**3. Type consistency:** `retrieve(ctx, scope, query)` matches the Task 3 call-site change; `assembleSlice`/`selectSeeds`/`nodeCandidate` signatures match between Task 2 (produced) and Task 3 (consumed); `candidate` fields (`sourceType,title,project,ts,freshness,navTarget,snippet`) match `cards.go`; `SetOpenVaultForTest` signature matches its test use; `seedVault`/`seedRunOID` defined in Task 2, reused in Task 3 (same package). ✓
