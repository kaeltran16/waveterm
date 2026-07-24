# Jarvis B — Dossier & structured records Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `pkg/jarvisdossier` — the typed task-dossier and decision-record layer over the Wave Vault (sub-project A), plus the one `Vault.Create` primitive A lacks — so C/E/F can create, read, and machine-update dossiers and append immutable decision records with region-safe write-ownership.

**Architecture:** B is *policy* on A's *mechanism*. B owns the dossier/decision schemas expressed as `wavevault.RegionSpec`s; A enforces them via its region-aware splice. Decisions are separate files in `decisions/` (per-file field ownership maps 1:1 onto A); blockers are a machine-owned block in the dossier. All reference wikilinks live in **body** machine-blocks because A extracts links from the body only. B calls no model — it records deterministic facts and renders Markdown.

**Tech Stack:** Go (stdlib only — `strings`, `strconv`, `regexp`, `fmt`, `time`, `crypto/rand`, `encoding/hex`); the `wavevault` package (A); `go test` with a temp vault + real `git` (matching `pkg/wavevault`'s and `pkg/gitinfo`'s pattern). No frontend, no wshrpc/waveobj types, no `task generate`.

## Global Constraints

Every task's requirements implicitly include these. Values copied verbatim from the spec, A's implemented interface, and CLAUDE.md.

- **B calls no model** (invariant 1). B records facts and renders Markdown; the state-summary *content* and a decision's rationale *draft* come from callers (E/F), never from B.
- **Machine frontmatter values are single-line.** A's `setFrontmatterKey` writes `key: value` on one line. Lists MUST be flow-style YAML (`["a", "b"]`); free-text scalars MUST be YAML-safe (quoted when they contain `:`, `#`, quotes, leading/trailing space, etc.). A multi-line value silently breaks A's splice + diff-validate.
- **Reference wikilinks live in body machine-blocks, not frontmatter.** A's `parseNode` extracts `[[links]]` from the post-frontmatter body only; `Node.Links` (which drives `Expand`, edges, and `HasLink`) never sees frontmatter links. The dossier `refs` block and the decision `links` block are the traversable-edge carriers.
- **Bounded slug for every generated filename** (`maxSlugLen = 48`), reproducing memvault's discipline — unbounded slugs overran Windows MAX_PATH and `os.WriteFile` failed silently. The stable link target is the node **id**, not the filename.
- **Tolerant parsing, no migrations.** Missing keys default; unknown keys are ignored; an "old" record missing a newer field loads without error.
- **A's link-extraction and per-file ownership are fixed** — do not modify `parse.go`, `region.go`, or `read.go` in `pkg/wavevault`. The only A change is the additive `Create` in Task 1.
- **Node id resolution** (A's `parseNode`): frontmatter `id`, else `name`, else filename stem. Dossiers use the **filename stem** as id (no `id` key); decisions use an explicit `id: dec-<8hex>` key (their filenames are date-slugged).
- **Tests: Go only.** `go test ./pkg/jarvisdossier/` and `go test ./pkg/wavevault/`. Single test: `go test ./pkg/jarvisdossier/ -run TestName -v`. Temp vault via `wavevault` test seams where available; B tests use the exported API + a real vault at `t.TempDir()`. No jsdom / render tests.
- **File header** on every new Go file:
  ```go
  // Copyright 2026, Command Line Inc.
  // SPDX-License-Identifier: Apache-2.0
  ```
- **Git (per CLAUDE.md):** commits need explicit human approval and are batched — do NOT auto-commit or push. Each task's final step is **"stage + checkpoint for review"** (`git add`, no commit). The spec, this plan, and all B code fold into B's **single feature commit** at the end (Task 6), on approval. The meta-spec tracking-table B-row link is added at that feature-commit time.

---

### Task 1: A's `Create` primitive (`pkg/wavevault`)

A has no file-creation path (`Write` requires an existing file; `setBlock` requires existing markers), and a file B writes directly would land in A's *user* commit, not the `Jarvis` commit. Add one additive method that writes a new file and records it in the machine-authored ledger.

**Files:**
- Modify: `pkg/wavevault/write.go` (add `Create`)
- Test: `pkg/wavevault/write_test.go` (add two tests; reuse existing `mustRead`, `lastAuthor`, `commitCount` helpers)

**Interfaces:**
- Consumes: `Vault{Root, mu, machineFiles}`, `WriteResult`, `ContentHash`, `Commit` (all existing in `pkg/wavevault`).
- Produces: `func (v *Vault) Create(collection, filename, content string) (*WriteResult, error)` — writes `<Root>/<collection>/<filename>`, records it in `machineFiles`, returns the content hash; errors if the file already exists.

- [ ] **Step 1: Write the failing tests**

Add to `pkg/wavevault/write_test.go`:

```go
func TestCreateTracksAsMachineAndCommitsAsJarvis(t *testing.T) {
	v, err := openVaultAt(context.Background(), t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	res, err := v.Create("decisions", "d-1.md", "---\nid: d-1\n---\n\nbody\n")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	p := filepath.Join(v.Root, "decisions", "d-1.md")
	if len(mustRead(t, p)) == 0 {
		t.Fatal("Create did not write the file")
	}
	v.mu.Lock()
	h, ok := v.machineFiles[p]
	v.mu.Unlock()
	if !ok || h != res.Hash {
		t.Fatalf("machineFiles[%s]=%q,%v; want %q", p, h, ok, res.Hash)
	}
	if err := v.Commit(context.Background(), "add d-1"); err != nil {
		t.Fatal(err)
	}
	if got := lastAuthor(t, v.Root); got != "Jarvis" {
		t.Fatalf("created file author = %q, want Jarvis", got)
	}
}

func TestCreateRejectsExistingFile(t *testing.T) {
	v, err := openVaultAt(context.Background(), t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := v.Create("decisions", "d-1.md", "one"); err != nil {
		t.Fatal(err)
	}
	if _, err := v.Create("decisions", "d-1.md", "two"); err == nil {
		t.Fatal("Create must reject an already-existing file")
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./pkg/wavevault/ -run TestCreate -v`
Expected: FAIL — `v.Create undefined`.

- [ ] **Step 3: Implement `Create`**

Add to `pkg/wavevault/write.go` (imports `os`, `path/filepath`, `fmt` are already present):

```go
// Create writes a new file into a collection and records it as machine-authored so Commit attributes
// it to Jarvis. It errors if the file already exists — create is not overwrite; use Write to edit an
// existing node. B uses this to scaffold dossiers and decision records (A itself never creates files).
func (v *Vault) Create(collection, filename, content string) (*WriteResult, error) {
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
	h := ContentHash([]byte(content))
	v.mu.Lock()
	v.machineFiles[path] = h
	v.mu.Unlock()
	return &WriteResult{Hash: h}, nil
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./pkg/wavevault/ -v`
Expected: PASS (the new tests plus all existing `wavevault` tests).

- [ ] **Step 5: Stage + checkpoint for review**

```bash
git add pkg/wavevault/write.go pkg/wavevault/write_test.go
```
Do not commit. Report the diff for review.

---

### Task 2: Dossier model — scaffold, load, shared parse helpers

Create the B package with the shared parse/render helpers and the dossier create/load path.

**Files:**
- Create: `pkg/jarvisdossier/parse.go` (shared helpers)
- Create: `pkg/jarvisdossier/dossier.go` (`Dossier`, `DossierFacts`, `DossierSpec`, `CreateDossier`, `LoadDossier`, `renderDossier`)
- Test: `pkg/jarvisdossier/dossier_test.go`

**Interfaces:**
- Consumes: `wavevault.Vault.Create`, `wavevault.Vault.Retriever`, `wavevault.Retriever.Read`, `wavevault.AllScope`, `wavevault.Node`, `wavevault.NodeWithBody`, `wavevault.RegionSpec`.
- Produces:
  - `type Dossier struct { ID, Status, Ticket, Objective string; Acceptance []string; Confidence string; Created, Updated int64; State string; Refs, Blockers []string; Hash string }`
  - `type DossierFacts struct { Ticket, Objective string; Acceptance []string; Confidence string }`
  - `func DossierSpec() wavevault.RegionSpec`
  - `func CreateDossier(v *wavevault.Vault, f DossierFacts) (id, hash string, err error)`
  - `func LoadDossier(r *wavevault.Retriever, id string) (*Dossier, error)`
  - Helpers (parse.go): `nowFn`, `boundedSlug`, `extractBlock`, `fmString`, `fmStrings`, `fmInt`, `parseLinks`, `splitLines`, `flowList`, `yamlScalar`, `emptyBlock`.

- [ ] **Step 1: Write the failing test**

Create `pkg/jarvisdossier/dossier_test.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvisdossier

import (
	"context"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/wavevault"
)

// fixedNow pins nowFn for deterministic timestamps/filenames within a test.
func fixedNow(t *testing.T, ms int64) {
	t.Helper()
	prev := nowFn
	nowFn = func() int64 { return ms }
	t.Cleanup(func() { nowFn = prev })
}

func newVault(t *testing.T) *wavevault.Vault {
	t.Helper()
	v, err := wavevault.OpenVaultAtForTest(context.Background(), t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return v
}

func TestCreateAndLoadDossierRoundTrips(t *testing.T) {
	fixedNow(t, 1753324800000)
	v := newVault(t)
	id, hash, err := CreateDossier(v, DossierFacts{
		Ticket:     "PROJ-142",
		Objective:  "add OAuth: PKCE flow", // contains a colon — must be YAML-safe
		Acceptance: []string{"tokens rotate", "no long-lived refresh"},
	})
	if err != nil {
		t.Fatalf("CreateDossier: %v", err)
	}
	if id == "" || hash == "" {
		t.Fatal("CreateDossier must return an id and hash")
	}
	d, err := LoadDossier(v.Retriever(wavevault.AllScope()), id)
	if err != nil {
		t.Fatalf("LoadDossier: %v", err)
	}
	if d.Status != "active" || d.Ticket != "PROJ-142" || d.Objective != "add OAuth: PKCE flow" {
		t.Fatalf("scalar round-trip failed: %+v", d)
	}
	if len(d.Acceptance) != 2 || d.Acceptance[0] != "tokens rotate" {
		t.Fatalf("acceptance flow-list round-trip failed: %+v", d.Acceptance)
	}
	if d.Confidence != "med" {
		t.Fatalf("confidence default = %q, want med", d.Confidence)
	}
	if d.Created != 1753324800000 || d.Updated != 1753324800000 {
		t.Fatalf("timestamps = %d/%d", d.Created, d.Updated)
	}
}

func TestLoadDossierTolerantOfMissingKeys(t *testing.T) {
	v := newVault(t)
	// a minimal, hand-written dossier missing acceptance/confidence/timestamps
	if _, err := v.Create("tasks/active", "bare.md",
		"---\nstatus: active\n---\n<!-- jarvis:begin state -->\n<!-- jarvis:end state -->\n"); err != nil {
		t.Fatal(err)
	}
	d, err := LoadDossier(v.Retriever(wavevault.AllScope()), "bare")
	if err != nil {
		t.Fatalf("tolerant load must not error: %v", err)
	}
	if d.Status != "active" || d.Confidence != "" || len(d.Acceptance) != 0 {
		t.Fatalf("tolerant load projection wrong: %+v", d)
	}
}
```

Note: this test calls `wavevault.OpenVaultAtForTest` — a thin exported test seam over the existing unexported `openVaultAt`. Add it in Step 3.

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./pkg/jarvisdossier/ -v`
Expected: FAIL — package `jarvisdossier` does not exist / undefined symbols.

- [ ] **Step 3: Add the `wavevault` test seam, then implement `parse.go` and `dossier.go`**

Add to `pkg/wavevault/vault.go` (exports the existing unexported seam so sibling packages can open a temp vault):

```go
// OpenVaultAtForTest opens a vault at an explicit root. Exported for sibling-package tests
// (jarvisdossier); production code uses OpenVault.
func OpenVaultAtForTest(ctx context.Context, root string) (*Vault, error) {
	return openVaultAt(ctx, root)
}
```

Create `pkg/jarvisdossier/parse.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Package jarvisdossier is the typed task-dossier and decision-record layer over the Wave Vault
// (pkg/wavevault). It owns the dossier/decision schemas as wavevault.RegionSpecs, renders the
// Markdown A can splice, and exposes typed create/load/update operations. It calls no model.
package jarvisdossier

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// nowFn returns the current time in Unix millis. A package var so tests can pin it.
var nowFn = func() int64 { return time.Now().UnixMilli() }

var slugRe = regexp.MustCompile(`[^a-z0-9]+`)
var linkRe = regexp.MustCompile(`\[\[([^\]]+)\]\]`)

const maxSlugLen = 48

// boundedSlug lowercases s, replaces runs of non-alphanumerics with '-', trims, substitutes fallback
// when empty, and caps length so a generated filename never overruns Windows MAX_PATH.
func boundedSlug(s, fallback string) string {
	slug := strings.Trim(slugRe.ReplaceAllString(strings.ToLower(strings.TrimSpace(s)), "-"), "-")
	if slug == "" {
		return fallback
	}
	if len(slug) > maxSlugLen {
		slug = strings.Trim(slug[:maxSlugLen], "-")
	}
	return slug
}

// emptyBlock renders an empty machine block with begin/end markers on their own lines. A's setBlock
// requires the markers to pre-exist, so every scaffold lays them down.
func emptyBlock(name string) string {
	return "<!-- jarvis:begin " + name + " -->\n<!-- jarvis:end " + name + " -->\n"
}

// extractBlock returns the trimmed text between a block's begin/end markers, or "" if absent.
func extractBlock(body, name string) string {
	begin := "<!-- jarvis:begin " + name + " -->"
	end := "<!-- jarvis:end " + name + " -->"
	bi := strings.Index(body, begin)
	if bi < 0 {
		return ""
	}
	after := bi + len(begin)
	rel := strings.Index(body[after:], end)
	if rel < 0 {
		return ""
	}
	return strings.TrimSpace(body[after : after+rel])
}

func fmString(fm map[string]any, key string) string {
	if v, ok := fm[key]; ok {
		return strings.TrimSpace(fmt.Sprintf("%v", v))
	}
	return ""
}

func fmStrings(fm map[string]any, key string) []string {
	raw, ok := fm[key].([]any)
	if !ok {
		return nil
	}
	out := make([]string, 0, len(raw))
	for _, e := range raw {
		out = append(out, strings.TrimSpace(fmt.Sprintf("%v", e)))
	}
	return out
}

func fmInt(fm map[string]any, key string) int64 {
	switch v := fm[key].(type) {
	case int:
		return int64(v)
	case int64:
		return v
	case float64:
		return int64(v)
	case string:
		n, _ := strconv.ParseInt(strings.TrimSpace(v), 10, 64)
		return n
	}
	return 0
}

// parseLinks returns the [[targets]] found in s, in order.
func parseLinks(s string) []string {
	var out []string
	for _, m := range linkRe.FindAllStringSubmatch(s, -1) {
		if t := strings.TrimSpace(m[1]); t != "" {
			out = append(out, t)
		}
	}
	return out
}

// splitLines returns the non-empty lines of s, stripping a leading "- " list marker.
func splitLines(s string) []string {
	var out []string
	for _, ln := range strings.Split(s, "\n") {
		ln = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(ln), "- "))
		if ln != "" {
			out = append(out, ln)
		}
	}
	return out
}

// flowList renders a []string as a single-line YAML flow sequence, each element double-quoted.
// Single-line is mandatory — A splices frontmatter values one physical line at a time.
func flowList(items []string) string {
	if len(items) == 0 {
		return "[]"
	}
	qs := make([]string, len(items))
	for i, it := range items {
		qs[i] = strconv.Quote(it)
	}
	return "[" + strings.Join(qs, ", ") + "]"
}

// yamlScalar returns s as a bare scalar when safe, else double-quoted, so free-text values never
// break single-line frontmatter (a colon, hash, quote, or edge whitespace would).
func yamlScalar(s string) string {
	if s == "" {
		return `""`
	}
	if s != strings.TrimSpace(s) || strings.ContainsAny(s, ":#\"'{}[]&*!|>%@`\n") || strings.HasPrefix(s, "- ") {
		return strconv.Quote(s)
	}
	return s
}
```

Create `pkg/jarvisdossier/dossier.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvisdossier

import (
	"strconv"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/wavevault"
)

// Dossier is the typed projection of a task dossier file. Machine-owned fields are set by B/E/F;
// Hash is the content hash callers pass back as baseHash on a subsequent machine write.
type Dossier struct {
	ID         string
	Status     string
	Ticket     string
	Objective  string
	Acceptance []string
	Confidence string
	Created    int64
	Updated    int64
	State      string
	Refs       []string
	Blockers   []string
	Hash       string
}

// DossierFacts are the deterministic inputs code captures at task dispatch — never model output.
type DossierFacts struct {
	Ticket     string
	Objective  string
	Acceptance []string
	Confidence string // defaults to "med"
}

// DossierSpec is the region-ownership contract A enforces for a dossier: the machine frontmatter keys
// and the machine body blocks. Everything else (## Notes prose, non-reserved keys) is human-owned.
func DossierSpec() wavevault.RegionSpec {
	return wavevault.RegionSpec{
		MachineKeys: []string{"status", "ticket", "objective", "acceptance", "confidence", "created", "updated"},
		Blocks:      []string{"state", "refs", "blockers"},
	}
}

// CreateDossier scaffolds a new dossier in tasks/active (frontmatter + empty state/refs/blockers
// blocks + a human ## Notes placeholder) and returns the node id (the filename stem) and content
// hash. The file is machine-authored (via A's Create) so it commits as Jarvis.
func CreateDossier(v *wavevault.Vault, f DossierFacts) (string, string, error) {
	conf := f.Confidence
	if conf == "" {
		conf = "med"
	}
	id := boundedSlug(f.Ticket+" "+f.Objective, "task")
	res, err := v.Create("tasks/active", id+".md", renderDossier(f, conf))
	if err != nil {
		return "", "", err
	}
	return id, res.Hash, nil
}

func renderDossier(f DossierFacts, conf string) string {
	now := strconv.FormatInt(nowFn(), 10)
	var b strings.Builder
	b.WriteString("---\n")
	b.WriteString("status: active\n")
	b.WriteString("ticket: " + yamlScalar(f.Ticket) + "\n")
	b.WriteString("objective: " + yamlScalar(f.Objective) + "\n")
	b.WriteString("acceptance: " + flowList(f.Acceptance) + "\n")
	b.WriteString("confidence: " + conf + "\n")
	b.WriteString("created: " + now + "\n")
	b.WriteString("updated: " + now + "\n")
	b.WriteString("---\n")
	b.WriteString(emptyBlock("state"))
	b.WriteString(emptyBlock("refs"))
	b.WriteString(emptyBlock("blockers"))
	b.WriteString("\n## Notes\n\n")
	return b.String()
}

// LoadDossier reads a dossier by id through a scoped retriever and projects it into the typed model.
// Tolerant: missing keys default, unknown keys are ignored, no error.
func LoadDossier(r *wavevault.Retriever, id string) (*Dossier, error) {
	nb, err := r.Read(id)
	if err != nil {
		return nil, err
	}
	fm := nb.Node.Frontmatter
	return &Dossier{
		ID:         nb.Node.ID,
		Status:     fmString(fm, "status"),
		Ticket:     fmString(fm, "ticket"),
		Objective:  fmString(fm, "objective"),
		Acceptance: fmStrings(fm, "acceptance"),
		Confidence: fmString(fm, "confidence"),
		Created:    fmInt(fm, "created"),
		Updated:    fmInt(fm, "updated"),
		State:      extractBlock(nb.Body, "state"),
		Refs:       parseLinks(extractBlock(nb.Body, "refs")),
		Blockers:   splitLines(extractBlock(nb.Body, "blockers")),
		Hash:       nb.Node.ContentHash,
	}, nil
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./pkg/jarvisdossier/ -v && go test ./pkg/wavevault/ -run TestCreate -v`
Expected: PASS.

- [ ] **Step 5: Stage + checkpoint for review**

```bash
git add pkg/jarvisdossier/parse.go pkg/jarvisdossier/dossier.go pkg/jarvisdossier/dossier_test.go pkg/wavevault/vault.go
```
Do not commit.

---

### Task 3: Dossier machine setters

The machine-region updates E/F call, each also refreshing `updated` in the same splice.

**Files:**
- Modify: `pkg/jarvisdossier/dossier.go` (add setters + `renderRefs`)
- Test: `pkg/jarvisdossier/dossier_test.go` (add tests)

**Interfaces:**
- Consumes: `wavevault.Vault.Write`, `wavevault.RegionEdit`, `wavevault.Block`, `wavevault.FrontmatterKey`, `wavevault.WriteResult`; `DossierSpec`, `nowFn`.
- Produces:
  - `func SetState(v *wavevault.Vault, id, summary, baseHash string) (*wavevault.WriteResult, error)`
  - `func SetStatus(v *wavevault.Vault, id, status, baseHash string) (*wavevault.WriteResult, error)`
  - `func SetBlockers(v *wavevault.Vault, id string, blockers []string, baseHash string) (*wavevault.WriteResult, error)`
  - `func SetRefs(v *wavevault.Vault, id string, refs []string, baseHash string) (*wavevault.WriteResult, error)`
  - `func renderRefs(targets []string) string` (renders `[[t]]` joined by spaces)

- [ ] **Step 1: Write the failing test**

Add to `pkg/jarvisdossier/dossier_test.go`:

```go
func TestSettersUpdateMachineRegionsAndBumpUpdated(t *testing.T) {
	fixedNow(t, 1753324800000)
	v := newVault(t)
	id, hash, err := CreateDossier(v, DossierFacts{Ticket: "PROJ-1", Objective: "do a thing"})
	if err != nil {
		t.Fatal(err)
	}

	fixedNow(t, 1753324899999) // time advances before the update
	res, err := SetStatus(v, id, "paused", hash)
	if err != nil {
		t.Fatalf("SetStatus: %v", err)
	}
	if res.Conflict {
		t.Fatal("no concurrent edit — Conflict must be false")
	}

	d, err := LoadDossier(v.Retriever(wavevault.AllScope()), id)
	if err != nil {
		t.Fatal(err)
	}
	if d.Status != "paused" {
		t.Fatalf("status = %q, want paused", d.Status)
	}
	if d.Updated != 1753324899999 {
		t.Fatalf("updated not bumped: %d", d.Updated)
	}
	if d.Created != 1753324800000 {
		t.Fatalf("created must not change: %d", d.Created)
	}
	if d.Objective != "do a thing" {
		t.Fatalf("other machine fields must survive: %+v", d)
	}
}

func TestSetStateBlockersRefsPreserveHumanProse(t *testing.T) {
	v := newVault(t)
	id, hash, err := CreateDossier(v, DossierFacts{Ticket: "PROJ-2", Objective: "x"})
	if err != nil {
		t.Fatal(err)
	}
	r1, err := SetState(v, id, "worker paused mid-migration, 3 of 8 files done", hash)
	if err != nil {
		t.Fatalf("SetState: %v", err)
	}
	r2, err := SetBlockers(v, id, []string{"waiting on infra key rotation"}, r1.Hash)
	if err != nil {
		t.Fatalf("SetBlockers: %v", err)
	}
	if _, err := SetRefs(v, id, []string{"run-abc"}, r2.Hash); err != nil {
		t.Fatalf("SetRefs: %v", err)
	}
	d, err := LoadDossier(v.Retriever(wavevault.AllScope()), id)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(d.State, "3 of 8") {
		t.Fatalf("state = %q", d.State)
	}
	if len(d.Blockers) != 1 || d.Blockers[0] != "waiting on infra key rotation" {
		t.Fatalf("blockers = %+v", d.Blockers)
	}
	if len(d.Refs) != 1 || d.Refs[0] != "run-abc" {
		t.Fatalf("refs = %+v", d.Refs)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./pkg/jarvisdossier/ -run 'TestSetters|TestSetState' -v`
Expected: FAIL — `SetStatus`/`SetState`/`SetBlockers`/`SetRefs` undefined.

- [ ] **Step 3: Implement the setters**

Add to `pkg/jarvisdossier/dossier.go`:

```go
// updatedEdit is the timestamp bump every machine setter includes so freshness never lags a write.
func updatedEdit() wavevault.RegionEdit {
	return wavevault.RegionEdit{Kind: wavevault.FrontmatterKey, Name: "updated", Value: strconv.FormatInt(nowFn(), 10)}
}

// SetState writes the narrative state-summary block (content supplied by E/F).
func SetState(v *wavevault.Vault, id, summary, baseHash string) (*wavevault.WriteResult, error) {
	return v.Write(id, DossierSpec(), []wavevault.RegionEdit{
		{Kind: wavevault.Block, Name: "state", Value: summary},
		updatedEdit(),
	}, baseHash)
}

// SetStatus sets the dossier status (active | paused | completed | archived).
func SetStatus(v *wavevault.Vault, id, status, baseHash string) (*wavevault.WriteResult, error) {
	return v.Write(id, DossierSpec(), []wavevault.RegionEdit{
		{Kind: wavevault.FrontmatterKey, Name: "status", Value: status},
		updatedEdit(),
	}, baseHash)
}

// SetBlockers replaces the machine-owned blockers block with one "- item" line per blocker.
func SetBlockers(v *wavevault.Vault, id string, blockers []string, baseHash string) (*wavevault.WriteResult, error) {
	lines := make([]string, len(blockers))
	for i, b := range blockers {
		lines[i] = "- " + b
	}
	return v.Write(id, DossierSpec(), []wavevault.RegionEdit{
		{Kind: wavevault.Block, Name: "blockers", Value: strings.Join(lines, "\n")},
		updatedEdit(),
	}, baseHash)
}

// SetRefs replaces the refs block with the full [[target]] set (the traversable-edge carrier). refs
// lists node ids of linked decisions/runs; callers pass the complete desired set.
func SetRefs(v *wavevault.Vault, id string, refs []string, baseHash string) (*wavevault.WriteResult, error) {
	return v.Write(id, DossierSpec(), []wavevault.RegionEdit{
		{Kind: wavevault.Block, Name: "refs", Value: renderRefs(refs)},
		updatedEdit(),
	}, baseHash)
}

func renderRefs(targets []string) string {
	parts := make([]string, len(targets))
	for i, t := range targets {
		parts[i] = "[[" + t + "]]"
	}
	return strings.Join(parts, " ")
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./pkg/jarvisdossier/ -v`
Expected: PASS.

- [ ] **Step 5: Stage + checkpoint for review**

```bash
git add pkg/jarvisdossier/dossier.go pkg/jarvisdossier/dossier_test.go
```
Do not commit.

---

### Task 4: Decision records — model + append + link

Decisions as separate files in `decisions/`, linked into the dossier's `refs` block. This is where the traversable-edge design is proven end to end.

**Files:**
- Create: `pkg/jarvisdossier/decision.go` (`Decision`, `DecisionFacts`, `newDecisionID`, `AppendDecision`, `renderDecision`)
- Test: `pkg/jarvisdossier/decision_test.go`

**Interfaces:**
- Consumes: `wavevault.Vault.Create`, `wavevault.Vault.Retriever`, `wavevault.AllScope`, `wavevault.Retriever.Expand`, `wavevault.ExpandOpts`; `LoadDossier`, `SetRefs`, `renderRefs`, `yamlScalar`, `boundedSlug`, `nowFn`.
- Produces:
  - `type Decision struct { ID string; Created int64; Actor, Provenance, Status string; Links []string; Rationale, Hash string }`
  - `type DecisionFacts struct { TaskID, Actor, Provenance string; Links []string; Rationale, Summary string }`
  - `func AppendDecision(v *wavevault.Vault, f DecisionFacts) (string, error)` — creates the decision file, then links its id into the dossier's refs; returns the decision id.
  - `func renderDecision(id string, now int64, f DecisionFacts, links []string) string`

- [ ] **Step 1: Write the failing test**

Create `pkg/jarvisdossier/decision_test.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvisdossier

import (
	"context"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/wavevault"
)

func TestAppendDecisionLinksAndIsTraversable(t *testing.T) {
	fixedNow(t, 1753324800000)
	v := newVault(t)
	taskID, _, err := CreateDossier(v, DossierFacts{Ticket: "PROJ-9", Objective: "auth cleanup"})
	if err != nil {
		t.Fatal(err)
	}
	decID, err := AppendDecision(v, DecisionFacts{
		TaskID:     taskID,
		Actor:      "worker-3",
		Provenance: "worker-report",
		Links:      []string{"run-abc"},
		Rationale:  "dropped refresh tokens; mobile re-auths silently",
		Summary:    "drop refresh tokens",
	})
	if err != nil {
		t.Fatalf("AppendDecision: %v", err)
	}

	// the dossier's refs now link the decision
	d, err := LoadDossier(v.Retriever(wavevault.AllScope()), taskID)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, ref := range d.Refs {
		if ref == decID {
			found = true
		}
	}
	if !found {
		t.Fatalf("dossier refs %+v must contain decision id %q", d.Refs, decID)
	}

	// and the link is a REAL edge: Expand from the task reaches the decision node
	sg, err := v.Retriever(wavevault.AllScope()).Expand([]string{taskID}, wavevault.ExpandOpts{Depth: 1})
	if err != nil {
		t.Fatal(err)
	}
	reached := false
	for _, n := range sg.Nodes {
		if n.ID == decID {
			reached = true
		}
	}
	if !reached {
		t.Fatalf("Expand from %q did not reach decision %q — refs block is not a real edge", taskID, decID)
	}
}

func TestAppendDecisionCommitsAsJarvis(t *testing.T) {
	fixedNow(t, 1753324800000)
	v := newVault(t)
	taskID, _, err := CreateDossier(v, DossierFacts{Ticket: "PROJ-10", Objective: "x"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := AppendDecision(v, DecisionFacts{TaskID: taskID, Actor: "human", Provenance: "human-submit", Summary: "s"}); err != nil {
		t.Fatal(err)
	}
	if err := v.Commit(context.Background(), "decision"); err != nil {
		t.Fatal(err)
	}
	out, err := wavevault.HeadAuthorForTest(context.Background(), v.Root)
	if err != nil {
		t.Fatal(err)
	}
	if out != "Jarvis" {
		t.Fatalf("decision commit author = %q, want Jarvis", out)
	}
}
```

Note: `wavevault.HeadAuthorForTest` is a small exported helper mirroring the `lastAuthor` test helper (added in Step 3) so B tests can assert authorship without importing test-only code.

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./pkg/jarvisdossier/ -run TestAppendDecision -v`
Expected: FAIL — `AppendDecision` / `wavevault.HeadAuthorForTest` undefined.

- [ ] **Step 3: Add the `wavevault` author helper, then implement `decision.go`**

Add to `pkg/wavevault/git.go` (production helper, usable by sibling tests):

```go
// HeadAuthorForTest returns the author name of HEAD. A thin exported wrapper for sibling-package
// tests (jarvisdossier) that assert ownership-staged authorship.
func HeadAuthorForTest(ctx context.Context, root string) (string, error) {
	out, err := runGit(ctx, root, "log", "-1", "--format=%an")
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(out), nil
}
```

Ensure `pkg/wavevault/git.go` imports `context` and `strings` (add if missing).

Create `pkg/jarvisdossier/decision.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvisdossier

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/wavevault"
)

// Decision is the typed projection of one decision record. Rationale is the human-owned prose; every
// other field is machine-owned. Hash is the baseHash for a later SupersedeDecision.
type Decision struct {
	ID         string
	Created    int64
	Actor      string
	Provenance string
	Status     string
	Links      []string
	Rationale  string
	Hash       string
}

// DecisionFacts are the deterministic inputs code captures when a decision is submitted or a worker
// reports one. TaskID is the dossier this decision belongs to; it is auto-added to the links block
// and appended to the dossier's refs. Rationale is a seed draft (may be empty); the model/human owns
// the final prose. Summary feeds the filename slug only.
type DecisionFacts struct {
	TaskID     string
	Actor      string
	Provenance string
	Links      []string
	Rationale  string
	Summary    string
}

// newDecisionID mints an opaque stable id "dec-<8hex>". Callers link by this id, never the filename.
func newDecisionID() string {
	var b [4]byte
	_, _ = rand.Read(b[:])
	return "dec-" + hex.EncodeToString(b[:])
}

// AppendDecision creates a new immutable decision file in decisions/ (machine-authored) and links its
// id into the owning dossier's refs block. Append-only: it never rewrites an existing decision. It
// returns the decision id even if the dossier link step fails, so the record is never lost — the
// caller can retry the link. It reads the dossier through a fresh full-scope retriever to obtain the
// current baseHash (appends are coarse and rare, so a scan is acceptable).
func AppendDecision(v *wavevault.Vault, f DecisionFacts) (string, error) {
	id := newDecisionID()
	now := nowFn()
	date := time.UnixMilli(now).UTC().Format("2006-01-02")
	filename := date + "-" + boundedSlug(f.Summary, id) + ".md"
	links := append([]string{f.TaskID}, f.Links...)
	if _, err := v.Create("decisions", filename, renderDecision(id, now, f, links)); err != nil {
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

func renderDecision(id string, now int64, f DecisionFacts, links []string) string {
	var b strings.Builder
	b.WriteString("---\n")
	b.WriteString("id: " + id + "\n")
	b.WriteString("created: " + strconv.FormatInt(now, 10) + "\n")
	b.WriteString("actor: " + yamlScalar(f.Actor) + "\n")
	b.WriteString("provenance: " + yamlScalar(f.Provenance) + "\n")
	b.WriteString("status: active\n")
	b.WriteString("---\n")
	b.WriteString("<!-- jarvis:begin links -->\n" + renderRefs(links) + "\n<!-- jarvis:end links -->\n\n")
	b.WriteString(f.Rationale + "\n")
	return b.String()
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./pkg/jarvisdossier/ -v && go test ./pkg/wavevault/ -v`
Expected: PASS.

- [ ] **Step 5: Stage + checkpoint for review**

```bash
git add pkg/jarvisdossier/decision.go pkg/jarvisdossier/decision_test.go pkg/wavevault/git.go
```
Do not commit.

---

### Task 5: Decision load + supersede

Typed decision read and the one mutate-in-place (status), proving the human rationale survives a machine status change.

**Files:**
- Modify: `pkg/jarvisdossier/decision.go` (add `DecisionSpec`, `LoadDecision`, `SupersedeDecision`)
- Modify: `pkg/jarvisdossier/parse.go` (add `stripBlocks`)
- Test: `pkg/jarvisdossier/decision_test.go` (add tests)

**Interfaces:**
- Consumes: `wavevault.Vault.Write`, `wavevault.Retriever.Read`, `wavevault.RegionEdit`, `wavevault.FrontmatterKey`; `extractBlock`, `parseLinks`, `fmString`, `fmInt`.
- Produces:
  - `func DecisionSpec() wavevault.RegionSpec`
  - `func LoadDecision(r *wavevault.Retriever, id string) (*Decision, error)`
  - `func SupersedeDecision(v *wavevault.Vault, decID, status, baseHash string) (*wavevault.WriteResult, error)`
  - `func stripBlocks(body string, names ...string) string` (parse.go)

- [ ] **Step 1: Write the failing test**

Add to `pkg/jarvisdossier/decision_test.go`:

```go
func TestSupersedeDecisionPreservesRationale(t *testing.T) {
	fixedNow(t, 1753324800000)
	v := newVault(t)
	taskID, _, err := CreateDossier(v, DossierFacts{Ticket: "PROJ-11", Objective: "y"})
	if err != nil {
		t.Fatal(err)
	}
	decID, err := AppendDecision(v, DecisionFacts{
		TaskID: taskID, Actor: "worker-1", Provenance: "worker-report",
		Rationale: "chose approach A because it needs no migration", Summary: "approach a",
	})
	if err != nil {
		t.Fatal(err)
	}
	r := v.Retriever(wavevault.AllScope())
	before, err := LoadDecision(r, decID)
	if err != nil {
		t.Fatalf("LoadDecision: %v", err)
	}
	if before.Status != "active" {
		t.Fatalf("initial status = %q", before.Status)
	}
	res, err := SupersedeDecision(v, decID, "superseded", before.Hash)
	if err != nil {
		t.Fatalf("SupersedeDecision: %v", err)
	}
	if res.Conflict {
		t.Fatal("no concurrent edit — Conflict must be false")
	}
	after, err := LoadDecision(v.Retriever(wavevault.AllScope()), decID)
	if err != nil {
		t.Fatal(err)
	}
	if after.Status != "superseded" {
		t.Fatalf("status = %q, want superseded", after.Status)
	}
	if after.Rationale != before.Rationale {
		t.Fatalf("rationale changed across a status mutation: %q -> %q", before.Rationale, after.Rationale)
	}
}

func TestLoadDecisionTolerantOfMissingProvenance(t *testing.T) {
	v := newVault(t)
	// an "old" decision missing provenance and the links block
	if _, err := v.Create("decisions", "old.md",
		"---\nid: dec-old\ncreated: 1753000000000\nactor: human\nstatus: active\n---\n\nlegacy rationale\n"); err != nil {
		t.Fatal(err)
	}
	d, err := LoadDecision(v.Retriever(wavevault.AllScope()), "dec-old")
	if err != nil {
		t.Fatalf("tolerant load must not error: %v", err)
	}
	if d.Provenance != "" || len(d.Links) != 0 {
		t.Fatalf("tolerant projection wrong: %+v", d)
	}
	if d.Rationale != "legacy rationale" {
		t.Fatalf("rationale = %q", d.Rationale)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./pkg/jarvisdossier/ -run 'TestSupersede|TestLoadDecision' -v`
Expected: FAIL — `LoadDecision` / `SupersedeDecision` / `stripBlocks` undefined.

- [ ] **Step 3: Implement `stripBlocks`, `DecisionSpec`, `LoadDecision`, `SupersedeDecision`**

Add to `pkg/jarvisdossier/parse.go`:

```go
// stripBlocks removes the named machine blocks (markers included) from body, leaving the human prose.
func stripBlocks(body string, names ...string) string {
	out := body
	for _, name := range names {
		begin := "<!-- jarvis:begin " + name + " -->"
		end := "<!-- jarvis:end " + name + " -->"
		for {
			bi := strings.Index(out, begin)
			if bi < 0 {
				break
			}
			rel := strings.Index(out[bi:], end)
			if rel < 0 {
				break
			}
			out = out[:bi] + out[bi+rel+len(end):]
		}
	}
	return out
}
```

Add to `pkg/jarvisdossier/decision.go`:

```go
// DecisionSpec is the region-ownership contract for a decision file: machine frontmatter keys plus
// the machine links block. The rationale body is human-owned (a human edit locks the seed draft).
func DecisionSpec() wavevault.RegionSpec {
	return wavevault.RegionSpec{
		MachineKeys: []string{"id", "created", "actor", "provenance", "status"},
		Blocks:      []string{"links"},
	}
}

// LoadDecision reads a decision by id and projects it, tolerant of missing fields. Rationale is the
// body with the machine links block stripped.
func LoadDecision(r *wavevault.Retriever, id string) (*Decision, error) {
	nb, err := r.Read(id)
	if err != nil {
		return nil, err
	}
	fm := nb.Node.Frontmatter
	return &Decision{
		ID:         nb.Node.ID,
		Created:    fmInt(fm, "created"),
		Actor:      fmString(fm, "actor"),
		Provenance: fmString(fm, "provenance"),
		Status:     fmString(fm, "status"),
		Links:      parseLinks(extractBlock(nb.Body, "links")),
		Rationale:  strings.TrimSpace(stripBlocks(nb.Body, "links")),
		Hash:       nb.Node.ContentHash,
	}, nil
}

// SupersedeDecision mutates only the decision's status (active | superseded | reverted) — the single
// case B rewrites an existing record. The diff-validator guarantees the human rationale is untouched.
func SupersedeDecision(v *wavevault.Vault, decID, status, baseHash string) (*wavevault.WriteResult, error) {
	return v.Write(decID, DecisionSpec(), []wavevault.RegionEdit{
		{Kind: wavevault.FrontmatterKey, Name: "status", Value: status},
	}, baseHash)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./pkg/jarvisdossier/ -v`
Expected: PASS (all B tests).

- [ ] **Step 5: Stage + checkpoint for review**

```bash
git add pkg/jarvisdossier/decision.go pkg/jarvisdossier/parse.go pkg/jarvisdossier/decision_test.go
```
Do not commit.

---

### Task 6: Full verification + feature commit

**Files:** none new — verification + the meta-spec tracking-table update + the single feature commit.

- [ ] **Step 1: Full backend test + vet**

Run:
```bash
go test ./pkg/jarvisdossier/ ./pkg/wavevault/
go vet ./pkg/jarvisdossier/ ./pkg/wavevault/
go build ./...
```
Expected: all PASS, `go build` clean. (No `task generate` — B adds no wire/waveobj types.)

- [ ] **Step 2: Update the meta-spec tracking table B-row**

Edit `docs/superpowers/specs/2026-07-23-jarvis-second-brain-meta-spec.md`, the B row of the tracking table:

```markdown
| B | Dossier & structured records | [spec](2026-07-24-jarvis-b-dossier-design.md) | [plan](../plans/2026-07-24-jarvis-b-dossier.md) | Built — typed Dossier + separate-file decision records over A (`pkg/jarvisdossier`); region-safe machine setters + append-only decisions + `wavevault.Create` |
```

- [ ] **Step 3: Feature commit (requires explicit human approval)**

Stage everything from Tasks 1–5, the spec, the plan, and the meta-spec edit into one commit:

```bash
git add pkg/jarvisdossier/ pkg/wavevault/write.go pkg/wavevault/write_test.go pkg/wavevault/vault.go pkg/wavevault/git.go \
  docs/superpowers/specs/2026-07-24-jarvis-b-dossier-design.md \
  docs/superpowers/plans/2026-07-24-jarvis-b-dossier.md \
  docs/superpowers/specs/2026-07-23-jarvis-second-brain-meta-spec.md
git commit -F <commit message file>
```
Commit message (subject + body): `feat(jarvis): dossier & structured records over the Wave Vault (sub-project B)`. Do NOT run this step without explicit approval.

---

## Self-Review

**1. Spec coverage** (each spec section → task):
- Dossier schema + `DossierSpec` → Task 2 ✓
- The A `Create` addition (§2) → Task 1 ✓
- Decision schema + `DecisionSpec` (§3) → Task 4 (render) + Task 5 (spec/load) ✓
- Typed models + tolerant parse (§3) → Task 2 (dossier) + Task 5 (decision), tolerant tests in both ✓
- Record ops API (§4): create/load/set/append/supersede → Tasks 2–5 ✓; `updated` bump + `confidence` default → Task 2/3 ✓
- Ownership mapping (§5): machine-only writes, human prose preserved → Task 3 + Task 5 diff-validator tests ✓
- Seams (§6): consumes A's Create/Write/Retriever; exposes typed models — all via public funcs ✓
- Testing (§7): scaffold round-trip, create attribution (Jarvis-authored), append+link edge reachability, status-mutate preserves rationale, tolerant parse, blockers replace → Tasks 1–5 ✓
- Open risks: single-line frontmatter (`flowList`/`yamlScalar`, asserted by the colon-in-objective test), body-block links (Expand-reachability test in Task 4), bounded slug (`boundedSlug`) → covered ✓

**2. Placeholder scan:** No TBD/TODO. All code steps show complete, compilable code; no "add error handling"/"similar to Task N" hand-waves.

**3. Type consistency:** `DossierSpec`/`DecisionSpec` blocks (`state`/`refs`/`blockers`, `links`) match the render scaffolds and setters. `nowFn`, `boundedSlug`, `renderRefs`, `extractBlock`, `stripBlocks`, `parseLinks` signatures consistent across tasks. `AppendDecision(v, f)` / `SetRefs(v, id, refs, baseHash)` / `SupersedeDecision(v, decID, status, baseHash)` signatures match their Interfaces blocks and call sites. `wavevault.Create`, `OpenVaultAtForTest`, `HeadAuthorForTest` are defined (Tasks 1/2/4) before use.

## Execution Handoff

(Deferred to the skill's offer after this plan is reviewed.)
