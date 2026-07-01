# Memory Tab — Viewer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the cockpit **Memory** surface — an Obsidian-style view over a multi-root markdown memory vault (List + force-directed Graph + detail rail, with full create/edit/delete) — replacing the `PlaceholderSurface` that renders behind the already-wired NavRail slot.

**Architecture:** Follows the established cockpit scan-surface pattern (Files/Sessions/Usage): a Go package (`pkg/memvault`) walks the vault roots, parses frontmatter + `[[wikilinks]]` into nodes + edges; a set of `wshrpc` commands expose scan/read/write/create/delete; a jotai store (`memstore.ts`) loads them; a surface component (`memorysurface.tsx`) renders the handoff layout. Graph layout is a dependency-free pure TS force simulation. Vault = a dedicated Wave vault (`memory:vaultpath`, default `~/.waveterm/memory`, the write target) plus Claude (`~/.claude/projects/*/memory`) and Codex (`~/.codex/memories`) dirs scanned read-in-place and source-tagged.

**Tech Stack:** Go (scan + RPC), TypeScript/React 19 + jotai + Tailwind v4 `@theme` tokens (FE), vitest (pure-logic tests), `go test` (backend). UI verified via `tsc` + CDP dev-app screenshot (repo convention — no jsdom render tests).

**Out of scope (separate follow-up plans):**
- **The cross-agent sync engine (goal 2 — project via steering files + harvest).** Design: `docs/superpowers/specs/2026-06-30-memory-tab-design.md` §"Target: one shared brain"; spike de-risked in `2026-06-30-memory-sync-spike.md`. This viewer is its Phase 1 read/write layer and ships independently.
- **Live fsnotify external-write watching.** This plan reloads on surface mount, after our own mutations, and guards writes with an mtime check. Live streaming of an agent appending mid-session needs the transcript fsnotify-stream pattern and is a deferred task (see "Deferred" at the end).

**Locked decisions (from brainstorming + `2026-07-01` clarifications):**
- Node type taxonomy = the **Claude memory schema** (`metadata.type` ∈ `user | feedback | project | reference`); the graph/list legend is relabeled to these four (not the handoff's Decision/Fact/Convention/Preference labels). The four handoff colors are reassigned to the four Claude types.
- Vault = **multi-root**, dedicated write vault + Claude/Codex read-in-place, source-tagged.
- Scope = **full viewer incl. graph**; dependency-free SVG force sim.
- Cluster/grouping signal (design open Q2) = **derived**: `Scope` = the note's project folder name for Claude project dirs, else a frontmatter `scope` field, else `"shared"`. Flagged; revisit if it proves wrong.

**Reference — handoff SoT markup:** `wave-handoff/wave/project/Wave-cockpit-live.dc.html`: NavRail memory button lines 116–120; Memory surface (header/graph/list/detail rail) lines 1061–1169; New-memory modal lines 1364–1402; view-model logic (`memoryNodes`/`memoryEdges`/`mMeta`/`memGroups`) lines 1650–1669 and 2597–2632.

**Pattern files to mirror:**
- Go scan pkg: `pkg/agentsessions/agentsessions.go` (walk + parse + typed structs, `wavebase.GetHomeDir()`).
- RPC types: `pkg/wshrpc/wshrpctypes.go` (interface line ~96–99; data structs ~651–717). Server impl: `pkg/wshrpc/wshserver/wshserver.go:1459–1505`.
- FE store: `frontend/app/view/agents/filesstore.ts` (module atoms + async loader via `RpcApi.XCommand(TabRpcClient, …)`).
- FE surface: `frontend/app/view/agents/filessurface.tsx`; routing: `cockpitshell.tsx:60–74`; `SurfaceKey`: `agents.tsx:25`.
- Tokens: `frontend/tailwindsetup.css` `@theme` block (line 8+). Config: `pkg/wconfig/settingsconfig.go` `SettingsType` (line 60+).

---

## File Structure

**New (backend):**
- `pkg/memvault/memvault.go` — vault roots, scan, note parse, read/write/create/delete.
- `pkg/memvault/memvault_test.go` — parse + scan + edge + mtime-guard tests.

**Modified (backend):**
- `pkg/wshrpc/wshrpctypes.go` — 5 command signatures + request/response structs + `MemoryNote`/`MemoryEdge`.
- `pkg/wshrpc/wshserver/wshserver.go` — 5 thin command impls calling `memvault`.
- `pkg/wconfig/settingsconfig.go` — `MemoryVaultPath string \`json:"memory:vaultpath,omitempty"\``.

**Generated (do not hand-edit; produced by `task generate`):**
- `frontend/app/store/wshclientapi.ts`, `frontend/app/store/wshserver-types.ts` (or equivalent generated TS types).

**New (frontend):**
- `frontend/app/view/agents/memtypes.ts` — `MemNote`, `MemEdge`, `MemType`, `TYPE_META` (label + token class). Pure.
- `frontend/app/view/agents/memtypes.test.ts`.
- `frontend/app/view/agents/memgraphlayout.ts` — pure deterministic force-directed layout. Pure.
- `frontend/app/view/agents/memgraphlayout.test.ts`.
- `frontend/app/view/agents/memstore.ts` — atoms + loaders (scan/select/save/create/delete).
- `frontend/app/view/agents/memorysurface.tsx` — the surface (header + Graph + List + detail rail).
- `frontend/app/view/agents/newmemorymodal.tsx` — the New-memory modal.

**Modified (frontend):**
- `frontend/tailwindsetup.css` — 4 `--color-mem-*` type tokens (+ soft bg).
- `frontend/app/view/agents/cockpitshell.tsx` — route `surface === "memory"` → `MemorySurface`.

---

## Phase A — Backend: config key + vault scan (read path)

### Task 1: Add the `memory:vaultpath` config setting

**Files:**
- Modify: `pkg/wconfig/settingsconfig.go:60+` (`SettingsType` struct)

- [ ] **Step 1: Add the field to `SettingsType`**

Insert after the `Term*` block (near line 114), following the existing `key:subkey` json-tag convention:

```go
	MemoryVaultPath string `json:"memory:vaultpath,omitempty"`
```

- [ ] **Step 2: Build to confirm the struct still compiles**

Run: `go build ./pkg/wconfig/`
Expected: no output, exit 0.

- [ ] **Step 3: Commit**

```bash
git add pkg/wconfig/settingsconfig.go
git commit -m "feat(memory): add memory:vaultpath setting"
```

---

### Task 2: `memvault` types + note parser (frontmatter + wikilinks)

**Files:**
- Create: `pkg/memvault/memvault.go`
- Test: `pkg/memvault/memvault_test.go`

- [ ] **Step 1: Write the failing test**

```go
// pkg/memvault/memvault_test.go
package memvault

import (
	"reflect"
	"testing"
)

func TestParseNote(t *testing.T) {
	raw := `---
name: prefer-postgres
description: Use Postgres before adding a new dependency
metadata:
  type: preference
  scope: shared
---

# Prefer Postgres
When a problem can be solved with the existing Postgres db, do that.
Related: [[conventional-commits]] and [[vitest-for-tests]].
`
	n, body := parseNote("/vault/prefer-postgres.md", []byte(raw), "vault")
	if n.ID != "prefer-postgres" {
		t.Fatalf("ID = %q, want prefer-postgres", n.ID)
	}
	if n.Type != "preference" { // note: preference is NOT a canonical Claude type; kept verbatim
		t.Fatalf("Type = %q", n.Type)
	}
	if n.Scope != "shared" {
		t.Fatalf("Scope = %q, want shared", n.Scope)
	}
	if n.Description != "Use Postgres before adding a new dependency" {
		t.Fatalf("Description = %q", n.Description)
	}
	if n.Source != "vault" {
		t.Fatalf("Source = %q, want vault", n.Source)
	}
	wantLinks := []string{"conventional-commits", "vitest-for-tests"}
	if !reflect.DeepEqual(n.Links, wantLinks) {
		t.Fatalf("Links = %v, want %v", n.Links, wantLinks)
	}
	if body == "" || body[0] != '#' {
		t.Fatalf("body should start after frontmatter, got %q", body[:min(20, len(body))])
	}
}

func TestParseNoteNoFrontmatter(t *testing.T) {
	n, _ := parseNote("/vault/loose-note.md", []byte("# Loose\nno frontmatter here [[x]]"), "claude")
	if n.ID != "loose-note" { // falls back to filename stem
		t.Fatalf("ID = %q, want loose-note", n.ID)
	}
	if len(n.Links) != 1 || n.Links[0] != "x" {
		t.Fatalf("Links = %v, want [x]", n.Links)
	}
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `go test ./pkg/memvault/`
Expected: FAIL — `undefined: parseNote` (package doesn't build yet).

- [ ] **Step 3: Write the minimal implementation**

```go
// pkg/memvault/memvault.go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Package memvault scans markdown memory vaults (a dedicated Wave vault plus each agent's
// native markdown memory dir) into a source-tagged node+edge graph, and reads/writes notes.
// Sibling to pkg/agentsessions. Notes use the Claude memory schema: frontmatter name +
// description + metadata.type + [[wikilinks]] in the body.
package memvault

import (
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"gopkg.in/yaml.v3"
)

// Note is one memory note. Body is populated only by ReadNote (Scan omits it to keep the payload small).
type Note struct {
	ID          string   `json:"id"`          // frontmatter name; falls back to filename stem
	Title       string   `json:"title"`       // first markdown heading, else ID
	Description string   `json:"description"`  // frontmatter description
	Type        string   `json:"type"`        // metadata.type (verbatim)
	Scope       string   `json:"scope"`       // cluster: metadata.scope, else project dir, else "shared"
	Source      string   `json:"source"`      // "vault" | "claude" | "codex"
	Path        string   `json:"path"`        // absolute file path
	Links       []string `json:"links"`       // [[targets]] from the body, in order, deduped
	UpdatedTs   int64    `json:"updatedts"`   // file mtime, UnixMilli
}

type Edge struct {
	From string `json:"from"`
	To   string `json:"to"`
}

type Graph struct {
	Notes []Note `json:"notes"`
	Edges []Edge `json:"edges"`
}

type frontmatter struct {
	Name        string `yaml:"name"`
	Description string `yaml:"description"`
	Metadata    struct {
		Type  string `yaml:"type"`
		Scope string `yaml:"scope"`
	} `yaml:"metadata"`
}

var (
	linkRe    = regexp.MustCompile(`\[\[([^\]]+)\]\]`)
	headingRe = regexp.MustCompile(`(?m)^#\s+(.+)$`)
)

// parseNote splits frontmatter from body, extracts metadata + links. scope defaults set by caller
// via defaultScope when frontmatter carries none. source is the root tag.
func parseNote(path string, data []byte, source string) (Note, string) {
	n := Note{Path: path, Source: source}
	body := string(data)
	if strings.HasPrefix(body, "---\n") {
		if end := strings.Index(body[4:], "\n---"); end >= 0 {
			fmText := body[4 : 4+end]
			rest := body[4+end+4:]
			rest = strings.TrimPrefix(rest, "\n")
			var fm frontmatter
			if err := yaml.Unmarshal([]byte(fmText), &fm); err == nil {
				n.ID = fm.Name
				n.Description = fm.Description
				n.Type = fm.Metadata.Type
				n.Scope = fm.Metadata.Scope
			}
			body = rest
		}
	}
	if n.ID == "" {
		n.ID = strings.TrimSuffix(filepath.Base(path), ".md")
	}
	if m := headingRe.FindStringSubmatch(body); m != nil {
		n.Title = strings.TrimSpace(m[1])
	} else {
		n.Title = n.ID
	}
	seen := map[string]bool{}
	for _, m := range linkRe.FindAllStringSubmatch(body, -1) {
		t := strings.TrimSpace(m[1])
		if t != "" && !seen[t] {
			seen[t] = true
			n.Links = append(n.Links, t)
		}
	}
	return n, body
}

// min is a local helper for the test file's slice bound (Go <1.21 safety; harmless if builtin exists).
func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

var _ = sort.Strings // keep sort imported for scan; referenced in Task 3
var _ = os.Stat       // referenced in Task 3/5
var _ = yaml.Marshal  // referenced in Task 6
```

> **Dependency note:** `gopkg.in/yaml.v3` — confirm it is already in `go.mod` before writing code: run `grep yaml.v3 go.mod`. It is a common transitive dep in this repo (wconfig/schema). If absent, run `go get gopkg.in/yaml.v3 && go mod tidy` as an added step and mention it in the commit. Do **not** add a heavier frontmatter library — a `yaml.Unmarshal` of the fenced block is sufficient (YAGNI).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `go test ./pkg/memvault/ -run TestParseNote -v`
Expected: PASS for `TestParseNote` and `TestParseNoteNoFrontmatter`.

- [ ] **Step 5: Commit**

```bash
git add pkg/memvault/memvault.go pkg/memvault/memvault_test.go go.mod go.sum
git commit -m "feat(memvault): note parser for frontmatter + wikilinks"
```

---

### Task 3: `memvault` multi-root scan + edge resolution

**Files:**
- Modify: `pkg/memvault/memvault.go`
- Test: `pkg/memvault/memvault_test.go`

- [ ] **Step 1: Write the failing test** (append to `memvault_test.go`)

```go
func TestScanVaultRoots(t *testing.T) {
	dir := t.TempDir()
	write := func(rel, content string) {
		p := filepath.Join(dir, rel)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("vault/a.md", "---\nname: a\nmetadata:\n  type: project\n---\n# A\nlinks [[b]] and [[ghost]]")
	write("claude/proj-x/b.md", "---\nname: b\nmetadata:\n  type: fact\n---\n# B")
	write("vault/notes.txt", "not markdown, ignored")

	roots := []Root{
		{Path: filepath.Join(dir, "vault"), Source: "vault"},
		{Path: filepath.Join(dir, "claude"), Source: "claude"},
	}
	g, err := ScanVault(roots)
	if err != nil {
		t.Fatal(err)
	}
	if len(g.Notes) != 2 {
		t.Fatalf("got %d notes, want 2 (.txt ignored)", len(g.Notes))
	}
	// scope of b derives from its containing folder (proj-x) since it has no metadata.scope
	var b *Note
	for i := range g.Notes {
		if g.Notes[i].ID == "b" {
			b = &g.Notes[i]
		}
	}
	if b == nil || b.Scope != "proj-x" {
		t.Fatalf("b.Scope = %v, want proj-x", b)
	}
	// only a->b resolves (ghost has no target note); a->ghost is dropped
	if len(g.Edges) != 1 || g.Edges[0].From != "a" || g.Edges[0].To != "b" {
		t.Fatalf("Edges = %v, want [a->b]", g.Edges)
	}
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `go test ./pkg/memvault/ -run TestScanVaultRoots`
Expected: FAIL — `undefined: Root`, `undefined: ScanVault`.

- [ ] **Step 3: Implement `Root`, `ScanVault`, scope derivation, edge resolution**

Replace the three `var _ = …` placeholder lines at the bottom of `memvault.go` with:

```go
// Root is one scan location and its provenance tag.
type Root struct {
	Path   string
	Source string // "vault" | "claude" | "codex"
}

// ScanVault walks each root for .md files, parses them, derives scope, and resolves [[links]]
// into edges (only links whose target ID exists become edges — dangling links are dropped).
// On duplicate IDs across roots, the dedicated "vault" source wins, else first-seen wins.
func ScanVault(roots []Root) (*Graph, error) {
	byID := map[string]Note{}
	var order []string
	for _, r := range roots {
		_ = filepath.WalkDir(r.Path, func(path string, d os.DirEntry, err error) error {
			if err != nil || d.IsDir() || !strings.HasSuffix(d.Name(), ".md") {
				return nil
			}
			data, readErr := os.ReadFile(path)
			if readErr != nil {
				return nil
			}
			n, _ := parseNote(path, data, r.Source)
			if n.Scope == "" {
				n.Scope = deriveScope(r, path)
			}
			if info, statErr := d.Info(); statErr == nil {
				n.UpdatedTs = info.ModTime().UnixMilli()
			}
			if existing, ok := byID[n.ID]; ok {
				if !(r.Source == "vault" && existing.Source != "vault") {
					return nil // keep existing
				}
			} else {
				order = append(order, n.ID)
			}
			byID[n.ID] = n
			return nil
		})
	}
	g := &Graph{}
	for _, id := range order {
		g.Notes = append(g.Notes, byID[id])
	}
	sort.Slice(g.Notes, func(i, j int) bool { return g.Notes[i].UpdatedTs > g.Notes[j].UpdatedTs })
	for _, n := range g.Notes {
		for _, l := range n.Links {
			if _, ok := byID[l]; ok {
				g.Edges = append(g.Edges, Edge{From: n.ID, To: l})
			}
		}
	}
	return g, nil
}

// deriveScope: the note's immediate parent folder name if it sits below the root
// (e.g. Claude's per-project dir), else "shared".
func deriveScope(r Root, path string) string {
	rel, err := filepath.Rel(r.Path, path)
	if err != nil {
		return "shared"
	}
	dir := filepath.Dir(rel)
	if dir == "." || dir == "" {
		return "shared"
	}
	parts := strings.Split(filepath.ToSlash(dir), "/")
	return parts[0]
}
```

Also delete the now-unused local `min` helper if the Go toolchain provides the builtin (Go 1.21+): run `go version`; if ≥1.21, remove `func min` and keep the test's `min` usage (builtin). If <1.21, keep it.

- [ ] **Step 4: Run tests**

Run: `go test ./pkg/memvault/ -v`
Expected: PASS (all three tests).

- [ ] **Step 5: Commit**

```bash
git add pkg/memvault/memvault.go pkg/memvault/memvault_test.go
git commit -m "feat(memvault): multi-root scan with scope + edge resolution"
```

---

### Task 4: `VaultRoots()` — assemble roots from config + home

**Files:**
- Modify: `pkg/memvault/memvault.go`
- Test: `pkg/memvault/memvault_test.go`

- [ ] **Step 1: Write the failing test**

```go
func TestVaultRootsIncludesSources(t *testing.T) {
	roots := buildRoots("/home/u", "/home/u/.waveterm/memory")
	var sources []string
	for _, r := range roots {
		sources = append(sources, r.Source)
	}
	want := []string{"vault", "claude", "codex"}
	if !reflect.DeepEqual(sources, want) {
		t.Fatalf("sources = %v, want %v", sources, want)
	}
	if roots[0].Path != "/home/u/.waveterm/memory" {
		t.Fatalf("vault root = %q", roots[0].Path)
	}
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `go test ./pkg/memvault/ -run TestVaultRoots`
Expected: FAIL — `undefined: buildRoots`.

- [ ] **Step 3: Implement `buildRoots` + exported `VaultRoots` + `DefaultVaultPath`**

Append to `memvault.go` (add `"github.com/wavetermdev/waveterm/pkg/wavebase"` and `"github.com/wavetermdev/waveterm/pkg/wconfig"` to imports):

```go
const defaultVaultSubpath = ".waveterm/memory"

// buildRoots is the pure core of VaultRoots (testable without config/home lookups).
func buildRoots(home, vaultPath string) []Root {
	return []Root{
		{Path: vaultPath, Source: "vault"},
		{Path: filepath.Join(home, ".claude", "projects"), Source: "claude"},
		{Path: filepath.Join(home, ".codex", "memories"), Source: "codex"},
	}
}

// VaultRoots resolves the scan roots from config (memory:vaultpath) + home.
func VaultRoots() []Root {
	home := wavebase.GetHomeDir()
	vaultPath := filepath.Join(home, defaultVaultSubpath)
	if cfg := wconfig.GetWatcher().GetFullConfig(); cfg.Settings.MemoryVaultPath != "" {
		vaultPath = wavebase.ExpandHomeDirSafe(cfg.Settings.MemoryVaultPath)
	}
	return buildRoots(home, vaultPath)
}

// DefaultVaultPath is the write target for cockpit-created notes.
func DefaultVaultPath() string {
	for _, r := range VaultRoots() {
		if r.Source == "vault" {
			return r.Path
		}
	}
	return filepath.Join(wavebase.GetHomeDir(), defaultVaultSubpath)
}
```

> **Verify before writing:** confirm the config accessor. Run `grep -rn "func GetWatcher\|GetFullConfig\|ExpandHomeDirSafe" pkg/wconfig pkg/wavebase`. If the accessor differs (e.g. `wconfig.GetFullConfig()` without a watcher, or `wavebase.ExpandHomeDir`), adapt these two lines to the real signature — the rest is unaffected.

- [ ] **Step 4: Run tests**

Run: `go test ./pkg/memvault/ -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add pkg/memvault/memvault.go pkg/memvault/memvault_test.go
git commit -m "feat(memvault): resolve scan roots from config + home"
```

---

### Task 5: `ReadNote` (body) + `WriteNote` (mtime guard) + `CreateNote` + `DeleteNote`

**Files:**
- Modify: `pkg/memvault/memvault.go`
- Test: `pkg/memvault/memvault_test.go`

- [ ] **Step 1: Write the failing tests**

```go
func TestReadNoteReturnsBody(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "n.md")
	os.WriteFile(p, []byte("---\nname: n\n---\n# N\nhello"), 0o644)
	nb, err := ReadNote(p, "vault")
	if err != nil {
		t.Fatal(err)
	}
	if nb.Note.ID != "n" || !strings.Contains(nb.Body, "hello") {
		t.Fatalf("got %+v", nb)
	}
}

func TestWriteNoteMtimeGuard(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "n.md")
	os.WriteFile(p, []byte("v1"), 0o644)
	info, _ := os.Stat(p)
	base := info.ModTime().UnixMilli()

	// stale base (older than on-disk) => conflict, no write
	res, err := WriteNote(p, "v2", base-10_000)
	if err != nil {
		t.Fatal(err)
	}
	if !res.Conflict {
		t.Fatal("expected conflict for stale base mtime")
	}
	got, _ := os.ReadFile(p)
	if string(got) != "v1" {
		t.Fatalf("file was clobbered on conflict: %q", got)
	}

	// matching base => write succeeds
	res, err = WriteNote(p, "v2", base)
	if err != nil || res.Conflict {
		t.Fatalf("expected clean write, got %+v err=%v", res, err)
	}
	got, _ = os.ReadFile(p)
	if string(got) != "v2" {
		t.Fatalf("write failed: %q", got)
	}
}

func TestCreateNoteWritesToVault(t *testing.T) {
	dir := t.TempDir()
	p, err := CreateNote(dir, "my-note", "project", "shared", "the body")
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Base(p) != "my-note.md" {
		t.Fatalf("path = %q", p)
	}
	data, _ := os.ReadFile(p)
	s := string(data)
	if !strings.Contains(s, "name: my-note") || !strings.Contains(s, "type: project") ||
		!strings.Contains(s, "scope: shared") || !strings.Contains(s, "the body") {
		t.Fatalf("frontmatter/body wrong:\n%s", s)
	}
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `go test ./pkg/memvault/ -run 'TestReadNote|TestWriteNote|TestCreateNote'`
Expected: FAIL — `undefined: ReadNote/WriteNote/CreateNote`.

- [ ] **Step 3: Implement**

```go
// NoteWithBody is a note plus its markdown body (ReadNote only).
type NoteWithBody struct {
	Note Note   `json:"note"`
	Body string `json:"body"`
}

type WriteResult struct {
	Mtime    int64 `json:"mtime"`
	Conflict bool  `json:"conflict"`
}

func ReadNote(path, source string) (*NoteWithBody, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	n, body := parseNote(path, data, source)
	if info, statErr := os.Stat(path); statErr == nil {
		n.UpdatedTs = info.ModTime().UnixMilli()
	}
	return &NoteWithBody{Note: n, Body: body}, nil
}

// WriteNote overwrites path with content unless the file changed since baseMtime (last-write with
// mtime guard). baseMtime<=0 skips the check (new-in-editor). Returns Conflict=true without writing
// when on-disk mtime is newer than baseMtime.
func WriteNote(path, content string, baseMtime int64) (*WriteResult, error) {
	if baseMtime > 0 {
		if info, err := os.Stat(path); err == nil {
			if info.ModTime().UnixMilli() > baseMtime {
				return &WriteResult{Mtime: info.ModTime().UnixMilli(), Conflict: true}, nil
			}
		}
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		return nil, err
	}
	info, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	return &WriteResult{Mtime: info.ModTime().UnixMilli()}, nil
}

// CreateNote writes a new note into vaultDir with a standard frontmatter block. name is slugified
// into the filename; a collision returns an error (no silent overwrite).
func CreateNote(vaultDir, name, noteType, scope, body string) (string, error) {
	slug := slugify(name)
	if slug == "" {
		slug = "note"
	}
	if err := os.MkdirAll(vaultDir, 0o755); err != nil {
		return "", err
	}
	path := filepath.Join(vaultDir, slug+".md")
	if _, err := os.Stat(path); err == nil {
		return "", os.ErrExist
	}
	var b strings.Builder
	b.WriteString("---\n")
	b.WriteString("name: " + slug + "\n")
	if noteType != "" {
		b.WriteString("metadata:\n  type: " + noteType + "\n")
		if scope != "" {
			b.WriteString("  scope: " + scope + "\n")
		}
	}
	b.WriteString("---\n\n")
	b.WriteString(body)
	if !strings.HasSuffix(body, "\n") {
		b.WriteString("\n")
	}
	if err := os.WriteFile(path, []byte(b.String()), 0o644); err != nil {
		return "", err
	}
	return path, nil
}

func DeleteNote(path string) error {
	return os.Remove(path)
}

var slugRe = regexp.MustCompile(`[^a-z0-9]+`)

func slugify(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	s = slugRe.ReplaceAllString(s, "-")
	return strings.Trim(s, "-")
}
```

- [ ] **Step 4: Run tests**

Run: `go test ./pkg/memvault/ -v`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add pkg/memvault/memvault.go pkg/memvault/memvault_test.go
git commit -m "feat(memvault): read/write(mtime-guarded)/create/delete notes"
```

---

## Phase B — Backend: wshrpc commands

### Task 6: RPC types + 5 command signatures + server impls + generate

**Files:**
- Modify: `pkg/wshrpc/wshrpctypes.go` (interface ~line 99; structs ~line 717)
- Modify: `pkg/wshrpc/wshserver/wshserver.go` (after line 1505)

- [ ] **Step 1: Add the 5 signatures to the `WshRpcInterface`** (after line 99, next to `GetRecentSessionsCommand`)

```go
	MemoryScanCommand(ctx context.Context) (*CommandMemoryScanRtnData, error)
	MemoryReadCommand(ctx context.Context, data CommandMemoryReadData) (*CommandMemoryReadRtnData, error)
	MemoryWriteCommand(ctx context.Context, data CommandMemoryWriteData) (*CommandMemoryWriteRtnData, error)
	MemoryCreateCommand(ctx context.Context, data CommandMemoryCreateData) (*CommandMemoryCreateRtnData, error)
	MemoryDeleteCommand(ctx context.Context, data CommandMemoryDeleteData) error
```

- [ ] **Step 2: Add the data/response structs** (near line 717, after `CommandGetRecentSessionsRtnData`)

```go
type MemoryNote struct {
	ID          string   `json:"id"`
	Title       string   `json:"title"`
	Description string   `json:"description"`
	Type        string   `json:"type"`
	Scope       string   `json:"scope"`
	Source      string   `json:"source"`
	Path        string   `json:"path"`
	Links       []string `json:"links"`
	UpdatedTs   int64    `json:"updatedts"`
}

type MemoryEdge struct {
	From string `json:"from"`
	To   string `json:"to"`
}

type CommandMemoryScanRtnData struct {
	Notes []MemoryNote `json:"notes"`
	Edges []MemoryEdge `json:"edges"`
}

type CommandMemoryReadData struct {
	Path   string `json:"path"`
	Source string `json:"source"`
}

type CommandMemoryReadRtnData struct {
	Note MemoryNote `json:"note"`
	Body string     `json:"body"`
}

type CommandMemoryWriteData struct {
	Path      string `json:"path"`
	Content   string `json:"content"`
	BaseMtime int64  `json:"basemtime,omitempty"`
}

type CommandMemoryWriteRtnData struct {
	Mtime    int64 `json:"mtime"`
	Conflict bool  `json:"conflict"`
}

type CommandMemoryCreateData struct {
	Name  string `json:"name"`
	Type  string `json:"type,omitempty"`
	Scope string `json:"scope,omitempty"`
	Body  string `json:"body,omitempty"`
}

type CommandMemoryCreateRtnData struct {
	Path string `json:"path"`
}

type CommandMemoryDeleteData struct {
	Path string `json:"path"`
}
```

- [ ] **Step 3: Add the server impls** (append after `GetRecentSessionsCommand`, line 1505; add `"github.com/wavetermdev/waveterm/pkg/memvault"` to imports)

```go
func (ws *WshServer) MemoryScanCommand(ctx context.Context) (*wshrpc.CommandMemoryScanRtnData, error) {
	g, err := memvault.ScanVault(memvault.VaultRoots())
	if err != nil {
		return nil, fmt.Errorf("scanning memory vault: %w", err)
	}
	notes := make([]wshrpc.MemoryNote, len(g.Notes))
	for i, n := range g.Notes {
		notes[i] = wshrpc.MemoryNote{
			ID: n.ID, Title: n.Title, Description: n.Description, Type: n.Type,
			Scope: n.Scope, Source: n.Source, Path: n.Path, Links: n.Links, UpdatedTs: n.UpdatedTs,
		}
	}
	edges := make([]wshrpc.MemoryEdge, len(g.Edges))
	for i, e := range g.Edges {
		edges[i] = wshrpc.MemoryEdge{From: e.From, To: e.To}
	}
	return &wshrpc.CommandMemoryScanRtnData{Notes: notes, Edges: edges}, nil
}

func (ws *WshServer) MemoryReadCommand(ctx context.Context, data wshrpc.CommandMemoryReadData) (*wshrpc.CommandMemoryReadRtnData, error) {
	nb, err := memvault.ReadNote(data.Path, data.Source)
	if err != nil {
		return nil, fmt.Errorf("reading note: %w", err)
	}
	n := nb.Note
	return &wshrpc.CommandMemoryReadRtnData{
		Note: wshrpc.MemoryNote{
			ID: n.ID, Title: n.Title, Description: n.Description, Type: n.Type,
			Scope: n.Scope, Source: n.Source, Path: n.Path, Links: n.Links, UpdatedTs: n.UpdatedTs,
		},
		Body: nb.Body,
	}, nil
}

func (ws *WshServer) MemoryWriteCommand(ctx context.Context, data wshrpc.CommandMemoryWriteData) (*wshrpc.CommandMemoryWriteRtnData, error) {
	res, err := memvault.WriteNote(data.Path, data.Content, data.BaseMtime)
	if err != nil {
		return nil, fmt.Errorf("writing note: %w", err)
	}
	return &wshrpc.CommandMemoryWriteRtnData{Mtime: res.Mtime, Conflict: res.Conflict}, nil
}

func (ws *WshServer) MemoryCreateCommand(ctx context.Context, data wshrpc.CommandMemoryCreateData) (*wshrpc.CommandMemoryCreateRtnData, error) {
	path, err := memvault.CreateNote(memvault.DefaultVaultPath(), data.Name, data.Type, data.Scope, data.Body)
	if err != nil {
		return nil, fmt.Errorf("creating note: %w", err)
	}
	return &wshrpc.CommandMemoryCreateRtnData{Path: path}, nil
}

func (ws *WshServer) MemoryDeleteCommand(ctx context.Context, data wshrpc.CommandMemoryDeleteData) error {
	if err := memvault.DeleteNote(data.Path); err != nil {
		return fmt.Errorf("deleting note: %w", err)
	}
	return nil
}
```

- [ ] **Step 4: Regenerate the TS bindings**

Run: `task generate`
Expected: `frontend/app/store/wshclientapi.ts` now contains `MemoryScanCommand`, `MemoryReadCommand`, `MemoryWriteCommand`, `MemoryCreateCommand`, `MemoryDeleteCommand`. Verify: `grep -c "MemoryScanCommand" frontend/app/store/wshclientapi.ts` → ≥1.

- [ ] **Step 5: Build the backend**

Run: `go build ./pkg/...`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add pkg/wshrpc/wshrpctypes.go pkg/wshrpc/wshserver/wshserver.go frontend/app/store/
git commit -m "feat(memory): wshrpc commands for vault scan/read/write/create/delete"
```

---

## Phase C — Frontend: tokens, types, store, List + detail

### Task 7: `@theme` type tokens

**Files:**
- Modify: `frontend/tailwindsetup.css` (`@theme` block, after the handoff card-body colors ~line 62)

- [ ] **Step 1: Add the four memory-type tokens**

The four Claude types map to the four handoff node colors (blue/green/amber/purple):

```css
    /* Memory note types (Claude schema; colors from handoff node legend Wave-cockpit-live.dc.html:1104-1107) */
    --color-mem-project: #8aa0ff; /* decision-blue */
    --color-mem-reference: #54c79a; /* fact-green */
    --color-mem-feedback: #e6b450; /* convention-amber */
    --color-mem-user: #a78bfa; /* preference-purple */
```

- [ ] **Step 2: Verify the utilities generate**

Run: `task dev` is not required; a Vite build resolves tokens. Confirm no typo by: `grep -c "color-mem-" frontend/tailwindsetup.css` → 4.

- [ ] **Step 3: Commit**

```bash
git add frontend/tailwindsetup.css
git commit -m "feat(memory): @theme tokens for the four note types"
```

---

### Task 8: `memtypes.ts` — types + type metadata map (pure, tested)

**Files:**
- Create: `frontend/app/view/agents/memtypes.ts`
- Test: `frontend/app/view/agents/memtypes.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// frontend/app/view/agents/memtypes.test.ts
import { describe, expect, it } from "vitest";
import { typeMeta, groupByScope, type MemNote } from "./memtypes";

const note = (over: Partial<MemNote>): MemNote => ({
    id: "x", title: "X", description: "", type: "project", scope: "shared",
    source: "vault", path: "/v/x.md", links: [], updatedts: 0, ...over,
});

describe("typeMeta", () => {
    it("labels and colors the four Claude types", () => {
        expect(typeMeta("project").label).toBe("Project");
        expect(typeMeta("project").dotClass).toBe("bg-mem-project");
        expect(typeMeta("user").label).toBe("User");
    });
    it("falls back for unknown/empty types", () => {
        expect(typeMeta("").label).toBe("Note");
        expect(typeMeta("weird").dotClass).toBe("bg-ink-mid");
    });
});

describe("groupByScope", () => {
    it("groups notes by scope, shared first, then alpha, with counts", () => {
        const groups = groupByScope([
            note({ id: "a", scope: "payments-api" }),
            note({ id: "b", scope: "shared" }),
            note({ id: "c", scope: "payments-api" }),
        ]);
        expect(groups.map((g) => g.name)).toEqual(["shared", "payments-api"]);
        expect(groups[1].count).toBe(2);
    });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run frontend/app/view/agents/memtypes.test.ts`
Expected: FAIL — cannot resolve `./memtypes`.

- [ ] **Step 3: Implement**

```ts
// frontend/app/view/agents/memtypes.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Memory-note types + type/scope presentation helpers. Mirrors the generated MemoryNote/MemoryEdge
// wire types but kept local + pure so the graph/list can be unit-tested in node env.

export type MemNote = {
    id: string;
    title: string;
    description: string;
    type: string; // Claude schema: user|feedback|project|reference (verbatim; may be "" or unknown)
    scope: string;
    source: string; // vault|claude|codex
    path: string;
    links: string[];
    updatedts: number;
};

export type MemEdge = { from: string; to: string };

export type TypeMeta = { label: string; dotClass: string; pillClass: string };

// The four Claude types → handoff colors (tokens from tailwindsetup.css). pillClass uses a soft bg
// via color-mix on the same token so we never introduce a second hardcoded color.
const META: Record<string, TypeMeta> = {
    project: { label: "Project", dotClass: "bg-mem-project", pillClass: "text-mem-project" },
    reference: { label: "Reference", dotClass: "bg-mem-reference", pillClass: "text-mem-reference" },
    feedback: { label: "Feedback", dotClass: "bg-mem-feedback", pillClass: "text-mem-feedback" },
    user: { label: "User", dotClass: "bg-mem-user", pillClass: "text-mem-user" },
};

const FALLBACK: TypeMeta = { label: "Note", dotClass: "bg-ink-mid", pillClass: "text-ink-mid" };

export function typeMeta(type: string): TypeMeta {
    return META[type] ?? FALLBACK;
}

export type ScopeGroup = { name: string; count: number; items: MemNote[] };

// Groups notes by scope: "shared" first, then remaining scopes alphabetically. Items keep input order.
export function groupByScope(notes: MemNote[]): ScopeGroup[] {
    const byScope = new Map<string, MemNote[]>();
    for (const n of notes) {
        const s = n.scope || "shared";
        (byScope.get(s) ?? byScope.set(s, []).get(s)!).push(n);
    }
    const names = [...byScope.keys()].sort((a, b) => {
        if (a === "shared") return -1;
        if (b === "shared") return 1;
        return a.localeCompare(b);
    });
    return names.map((name) => ({ name, count: byScope.get(name)!.length, items: byScope.get(name)! }));
}
```

> **Token note:** `bg-mem-project` etc. are the utilities Tailwind generates from the `--color-mem-*` tokens added in Task 7. Confirm they resolve during the surface's CDP check; if Tailwind v4 needs the tokens referenced to emit them, they are referenced here and in the surface, which is sufficient.

- [ ] **Step 4: Run tests**

Run: `npx vitest run frontend/app/view/agents/memtypes.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/app/view/agents/memtypes.ts frontend/app/view/agents/memtypes.test.ts
git commit -m "feat(memory): note type + scope-grouping helpers"
```

---

### Task 9: `memstore.ts` — atoms + scan/select loaders

**Files:**
- Create: `frontend/app/view/agents/memstore.ts`

(No unit test — this is IO glue over generated RPC, mirroring `filesstore.ts` which is likewise untested. Verified via the surface's CDP check.)

- [ ] **Step 1: Implement**

```ts
// frontend/app/view/agents/memstore.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Memory-surface state + loaders. Module-level jotai atoms written by async loaders via globalStore,
// mirroring filesstore.ts. Read path: loadMemory() scans the vault. Detail: selectNote() reads body.
// Mutations rescan so the graph/list stay consistent (no live fsnotify watch in this phase).

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { atom, type PrimitiveAtom } from "jotai";
import type { MemEdge, MemNote } from "./memtypes";

export type MemView = "graph" | "list";

export const memNotesAtom = atom<MemNote[]>([]) as PrimitiveAtom<MemNote[]>;
export const memEdgesAtom = atom<MemEdge[]>([]) as PrimitiveAtom<MemEdge[]>;
export const memLoadedAtom = atom<boolean>(false) as PrimitiveAtom<boolean>;
export const memViewAtom = atom<MemView>("list") as PrimitiveAtom<MemView>;
export const memSelectedIdAtom = atom<string | null>(null) as PrimitiveAtom<string | null>;
export const memBodyAtom = atom<{ body: string; mtime: number } | null>(null) as PrimitiveAtom<{
    body: string;
    mtime: number;
} | null>;
export const memSearchAtom = atom<string>("") as PrimitiveAtom<string>;

export async function loadMemory(): Promise<void> {
    try {
        const g = await RpcApi.MemoryScanCommand(TabRpcClient);
        globalStore.set(memNotesAtom, g.notes ?? []);
        globalStore.set(memEdgesAtom, g.edges ?? []);
        globalStore.set(memLoadedAtom, true);
        const sel = globalStore.get(memSelectedIdAtom);
        const notes = g.notes ?? [];
        if ((!sel || !notes.some((n) => n.id === sel)) && notes.length) {
            void selectNote(notes[0].id);
        }
    } catch {
        globalStore.set(memNotesAtom, []);
        globalStore.set(memEdgesAtom, []);
        globalStore.set(memLoadedAtom, true);
    }
}

function noteById(id: string): MemNote | undefined {
    return globalStore.get(memNotesAtom).find((n) => n.id === id);
}

export async function selectNote(id: string): Promise<void> {
    globalStore.set(memSelectedIdAtom, id);
    globalStore.set(memBodyAtom, null);
    const n = noteById(id);
    if (!n) return;
    try {
        const r = await RpcApi.MemoryReadCommand(TabRpcClient, { path: n.path, source: n.source });
        if (globalStore.get(memSelectedIdAtom) !== id) return; // selection moved on
        globalStore.set(memBodyAtom, { body: r.body, mtime: r.note.updatedts });
    } catch {
        if (globalStore.get(memSelectedIdAtom) === id) {
            globalStore.set(memBodyAtom, { body: "", mtime: 0 });
        }
    }
}

// Returns { conflict } so the caller can warn instead of clobbering.
export async function saveNote(path: string, content: string, baseMtime: number): Promise<{ conflict: boolean }> {
    const r = await RpcApi.MemoryWriteCommand(TabRpcClient, { path, content, basemtime: baseMtime });
    if (!r.conflict) {
        await loadMemory();
    }
    return { conflict: r.conflict };
}

export async function createNote(name: string, type: string, scope: string, body: string): Promise<void> {
    await RpcApi.MemoryCreateCommand(TabRpcClient, { name, type, scope, body });
    await loadMemory();
}

export async function deleteNote(path: string): Promise<void> {
    await RpcApi.MemoryDeleteCommand(TabRpcClient, { path });
    globalStore.set(memSelectedIdAtom, null);
    globalStore.set(memBodyAtom, null);
    await loadMemory();
}
```

> **Verify field casing:** after `task generate`, open `wshclientapi.ts` and confirm the generated arg/return field names (Go `json` tags are lowercased, e.g. `basemtime`, `updatedts`, `notes`, `edges`). Adjust the property names above to match exactly what was generated.

- [ ] **Step 2: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: no new errors beyond the ~3 pre-existing `api.test.ts` baseline.

- [ ] **Step 3: Commit**

```bash
git add frontend/app/view/agents/memstore.ts
git commit -m "feat(memory): jotai store + scan/read/save/create/delete loaders"
```

---

### Task 10: `MemorySurface` — header + List view + detail rail; route it

**Files:**
- Create: `frontend/app/view/agents/memorysurface.tsx`
- Modify: `frontend/app/view/agents/cockpitshell.tsx` (import + route)

Reproduces handoff markup: header lines 1063–1075; List lines 1116–1133; detail rail lines 1137–1166. Graph is added in Task 12 (this task renders the List by default and a "Graph — coming in this surface" placeholder for the graph toggle, replaced next task).

- [ ] **Step 1: Implement the surface (List + detail rail + header toggle)**

```tsx
// frontend/app/view/agents/memorysurface.tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Memory surface (Wave-cockpit-live.dc.html:1061-1169): header (count/search/Graph-List toggle/New),
// List (grouped by scope, type pills) + detail rail (content, meta, related/backlinks, Edit/Delete).
// Graph view added in a follow-up task; until then the toggle shows a calm placeholder.

import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect } from "react";
import type { AgentsViewModel } from "./agents";
import { groupByScope, typeMeta, type MemNote } from "./memtypes";
import {
    deleteNote,
    loadMemory,
    memBodyAtom,
    memEdgesAtom,
    memLoadedAtom,
    memNotesAtom,
    memSearchAtom,
    memSelectedIdAtom,
    memViewAtom,
    selectNote,
} from "./memstore";
import { globalStore } from "@/app/store/jotaiStore";

function Header({ count }: { count: number }) {
    const view = useAtomValue(memViewAtom);
    const search = useAtomValue(memSearchAtom);
    return (
        <div className="flex flex-none items-center gap-[14px] px-[28px] pb-[16px] pt-[24px]">
            <div>
                <h1 className="mb-[4px] text-[25px] font-bold tracking-[-0.02em]">Memory</h1>
                <p className="text-[13.5px] text-ink-mid">What your agents remember · {count} entries</p>
            </div>
            <div className="flex-1" />
            <input
                value={search}
                onChange={(e) => globalStore.set(memSearchAtom, e.target.value)}
                placeholder="Search memory…"
                className="w-[230px] rounded-[9px] border border-border bg-surface px-[12px] py-[8px] text-[13px] text-foreground outline-none placeholder:text-ink-mid"
            />
            <div className="flex rounded-[9px] border border-edge-mid bg-surface p-[3px]">
                <button
                    onClick={() => globalStore.set(memViewAtom, "graph")}
                    className={cn(
                        "rounded-[7px] px-[14px] py-[6px] text-[12px] font-semibold",
                        view === "graph" ? "bg-accentbg text-accent-soft" : "text-ink-mid"
                    )}
                >
                    Graph
                </button>
                <button
                    onClick={() => globalStore.set(memViewAtom, "list")}
                    className={cn(
                        "rounded-[7px] px-[14px] py-[6px] text-[12px] font-semibold",
                        view === "list" ? "bg-accentbg text-accent-soft" : "text-ink-mid"
                    )}
                >
                    List
                </button>
            </div>
        </div>
    );
}

function ListView({ notes, selectedId }: { notes: MemNote[]; selectedId: string | null }) {
    const groups = groupByScope(notes);
    return (
        <div className="mx-auto max-w-[780px] px-[28px] pb-[60px] pt-[10px]">
            {groups.map((g) => (
                <div key={g.name} className="mb-[26px]">
                    <div className="mb-[11px] flex items-center gap-[10px]">
                        <h2 className="font-mono text-[12px] font-semibold uppercase tracking-[0.08em] text-ink-mid">
                            {g.name}
                        </h2>
                        <span className="font-mono text-[11px] font-semibold text-ink-faint">{g.count}</span>
                        <div className="h-px flex-1 bg-gradient-to-r from-edge-faint to-transparent" />
                    </div>
                    <div className="flex flex-col gap-[8px]">
                        {g.items.map((n) => {
                            const m = typeMeta(n.type);
                            return (
                                <button
                                    key={n.id}
                                    onClick={() => fireAndForget(() => selectNote(n.id))}
                                    className={cn(
                                        "flex items-center gap-[13px] rounded-[11px] border px-[15px] py-[12px] text-left hover:border-edge-strong",
                                        n.id === selectedId ? "border-edge-strong bg-surface" : "border-edge-faint bg-background"
                                    )}
                                >
                                    <span
                                        className={cn(
                                            "min-w-[78px] flex-none rounded-[5px] px-[8px] py-[3px] text-center font-mono text-[9.5px] font-semibold uppercase tracking-[0.05em]",
                                            m.pillClass
                                        )}
                                        style={{ background: "rgba(255,255,255,0.05)" }}
                                    >
                                        {m.label}
                                    </span>
                                    <div className="min-w-0 flex-1">
                                        <div className="truncate font-mono text-[13px] font-semibold text-foreground">
                                            {n.title}
                                        </div>
                                        <div className="truncate text-[11.5px] text-ink-mid">{n.description}</div>
                                    </div>
                                </button>
                            );
                        })}
                    </div>
                </div>
            ))}
        </div>
    );
}

function DetailRail({ notes }: { notes: MemNote[] }) {
    const selectedId = useAtomValue(memSelectedIdAtom);
    const body = useAtomValue(memBodyAtom);
    const edges = useAtomValue(memEdgesAtom);
    const sel = notes.find((n) => n.id === selectedId);
    if (!sel) {
        return (
            <aside className="w-[330px] flex-none border-l border-edge-faint bg-surface p-[22px] text-[13px] text-ink-mid">
                Select a memory to see its content.
            </aside>
        );
    }
    const m = typeMeta(sel.type);
    const relatedIds = new Set<string>();
    for (const e of edges) {
        if (e.from === sel.id) relatedIds.add(e.to);
        if (e.to === sel.id) relatedIds.add(e.from);
    }
    const related = notes.filter((n) => relatedIds.has(n.id));
    return (
        <aside className="w-[330px] flex-none overflow-y-auto border-l border-edge-faint bg-surface px-[20px] pb-[40px] pt-[22px]">
            <div className="mb-[13px] flex items-center gap-[9px]">
                <span className={cn("rounded-[5px] px-[9px] py-[3px] font-mono text-[9.5px] font-semibold uppercase", m.pillClass)} style={{ background: "rgba(255,255,255,0.05)" }}>
                    {m.label}
                </span>
                <div className="flex-1" />
                <span className="font-mono text-[10.5px] text-ink-faint">{sel.scope}</span>
            </div>
            <h2 className="mb-[14px] text-[18px] font-bold leading-[1.3] text-foreground">{sel.title}</h2>
            <div className="mb-[8px] font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-mid">Content</div>
            <div className="mb-[10px] whitespace-pre-wrap rounded-[10px] border border-edge-faint bg-background px-[15px] py-[13px] text-[13.5px] leading-[1.6] text-ink-hi">
                {body == null ? "Loading…" : body.body || sel.description}
            </div>
            <div className="mb-[22px] flex gap-[8px]">
                <button
                    onClick={() => globalStore.set(memViewAtom, "list")}
                    className="flex-1 rounded-[8px] border border-edge-mid bg-surface py-[8px] text-[12px] text-ink-mid hover:border-edge-strong"
                >
                    Edit
                </button>
                <button
                    onClick={() => fireAndForget(() => deleteNote(sel.path))}
                    className="rounded-[8px] border border-error/30 px-[12px] py-[8px] text-[12px] text-error hover:bg-error/10"
                >
                    Delete
                </button>
            </div>
            <div className="mb-[22px] flex flex-col">
                <MetaRow label="Scope" value={sel.scope} border />
                <MetaRow label="Source" value={sel.source} border />
                <MetaRow label="Updated" value={new Date(sel.updatedts).toLocaleDateString()} />
            </div>
            {related.length > 0 && (
                <>
                    <div className="mb-[11px] font-mono text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-mid">
                        Related memory
                    </div>
                    <div className="flex flex-col gap-[7px]">
                        {related.map((r) => {
                            const rm = typeMeta(r.type);
                            return (
                                <button
                                    key={r.id}
                                    onClick={() => fireAndForget(() => selectNote(r.id))}
                                    className="flex items-center gap-[9px] rounded-[9px] border border-edge-faint bg-background px-[11px] py-[9px] hover:border-edge-strong"
                                >
                                    <div className={cn("h-[6px] w-[6px] flex-none rounded-full", rm.dotClass)} />
                                    <span className="min-w-0 flex-1 truncate text-left font-mono text-[11.5px] text-ink-hi">
                                        {r.title}
                                    </span>
                                    <span className="text-[10px] text-ink-faint">→</span>
                                </button>
                            );
                        })}
                    </div>
                </>
            )}
        </aside>
    );
}

function MetaRow({ label, value, border }: { label: string; value: string; border?: boolean }) {
    return (
        <div className={cn("flex justify-between py-[8px]", border && "border-b border-edge-faint")}>
            <span className="text-[12.5px] text-ink-mid">{label}</span>
            <span className="font-mono text-[12px] text-ink-hi">{value}</span>
        </div>
    );
}

export function MemorySurface({ model: _model }: { model: AgentsViewModel }) {
    const notes = useAtomValue(memNotesAtom);
    const loaded = useAtomValue(memLoadedAtom);
    const view = useAtomValue(memViewAtom);
    const selectedId = useAtomValue(memSelectedIdAtom);
    const search = useAtomValue(memSearchAtom);

    useEffect(() => {
        fireAndForget(() => loadMemory());
    }, []);

    const q = search.trim().toLowerCase();
    const filtered = q
        ? notes.filter((n) => (n.title + " " + n.description).toLowerCase().includes(q))
        : notes;

    return (
        <div className="absolute inset-0 flex flex-col">
            <Header count={notes.length} />
            <div className="flex min-h-0 flex-1">
                <div className="relative min-w-0 flex-1 overflow-auto">
                    {!loaded ? (
                        <div className="p-[28px] text-[13px] text-ink-mid">Loading memory…</div>
                    ) : notes.length === 0 ? (
                        <div className="p-[28px] text-[13px] text-ink-mid">
                            No memory yet. Create one with “New memory”, or point{" "}
                            <span className="font-mono">memory:vaultpath</span> at an existing vault.
                        </div>
                    ) : view === "list" ? (
                        <ListView notes={filtered} selectedId={selectedId} />
                    ) : (
                        <div className="flex h-full items-center justify-center text-[13px] text-ink-mid">
                            Graph view — coming in the next task
                        </div>
                    )}
                </div>
                <DetailRail notes={notes} />
            </div>
        </div>
    );
}
```

> **Verify token/util names before finalizing:** `text-ink-hi`, `text-ink-mid`, `text-ink-faint`, `border-edge-faint/mid/strong`, `bg-surface`, `bg-accentbg`, `text-accent-soft`, `bg-background` are used elsewhere in this dir (grep `filessurface.tsx`, `agentdetailsrail.tsx`). Confirm each exists in `tailwindsetup.css`; if a name differs, use the real one — do **not** invent a token or hardcode a hex (project rule: no raw colors, use `@theme` tokens).

- [ ] **Step 2: Route the surface** in `cockpitshell.tsx`

Add the import (after the `FilesSurface` import, line 14):

```tsx
import { MemorySurface } from "./memorysurface";
```

Add a branch in the surface switch (after the `files` branch, line 67):

```tsx
                        ) : surface === "memory" ? (
                            <MemorySurface model={model} />
```

- [ ] **Step 3: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: no new errors beyond baseline.

- [ ] **Step 4: Visual check (CDP dev app)**

Run the dev app (`tail -f /dev/null | task dev` — see the dev-stdin gotcha), then `node scripts/cdp-shot.mjs memory-list.png` after clicking the Memory rail item (or set the surface atom via CDP). Confirm: header + grouped list + detail rail render, a note selects and shows content + related.
Expected: layout matches the handoff (grouped rows, type pills, right rail).

- [ ] **Step 5: Commit**

```bash
git add frontend/app/view/agents/memorysurface.tsx frontend/app/view/agents/cockpitshell.tsx
git commit -m "feat(memory): List view + detail rail surface, routed in cockpit"
```

---

## Phase D — Frontend: graph

### Task 11: `memgraphlayout.ts` — dependency-free force layout (pure, tested)

**Files:**
- Create: `frontend/app/view/agents/memgraphlayout.ts`
- Test: `frontend/app/view/agents/memgraphlayout.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// frontend/app/view/agents/memgraphlayout.test.ts
import { describe, expect, it } from "vitest";
import { layoutGraph } from "./memgraphlayout";
import type { MemEdge, MemNote } from "./memtypes";

const note = (id: string, scope: string): MemNote => ({
    id, title: id, description: "", type: "project", scope,
    source: "vault", path: `/v/${id}.md`, links: [], updatedts: 0,
});

describe("layoutGraph", () => {
    it("returns a finite position for every node, within bounds", () => {
        const notes = [note("a", "shared"), note("b", "proj"), note("c", "proj")];
        const edges: MemEdge[] = [{ from: "a", to: "b" }, { from: "b", to: "c" }];
        const pos = layoutGraph(notes, edges, { width: 880, height: 560, iterations: 60 });
        for (const n of notes) {
            const p = pos.get(n.id)!;
            expect(Number.isFinite(p.x)).toBe(true);
            expect(Number.isFinite(p.y)).toBe(true);
            expect(p.x).toBeGreaterThanOrEqual(0);
            expect(p.x).toBeLessThanOrEqual(880);
            expect(p.y).toBeGreaterThanOrEqual(0);
            expect(p.y).toBeLessThanOrEqual(560);
        }
    });
    it("is deterministic (same input → same output)", () => {
        const notes = [note("a", "shared"), note("b", "proj")];
        const edges: MemEdge[] = [{ from: "a", to: "b" }];
        const opts = { width: 800, height: 500, iterations: 40 };
        const p1 = layoutGraph(notes, edges, opts);
        const p2 = layoutGraph(notes, edges, opts);
        expect(p1.get("a")).toEqual(p2.get("a"));
        expect(p1.get("b")).toEqual(p2.get("b"));
    });
    it("handles the empty and single-node cases", () => {
        expect(layoutGraph([], [], { width: 800, height: 500, iterations: 10 }).size).toBe(0);
        const one = layoutGraph([note("solo", "shared")], [], { width: 800, height: 500, iterations: 10 });
        expect(one.get("solo")).toBeDefined();
    });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run frontend/app/view/agents/memgraphlayout.test.ts`
Expected: FAIL — cannot resolve `./memgraphlayout`.

- [ ] **Step 3: Implement a deterministic Fruchterman–Reingold-style layout**

```ts
// frontend/app/view/agents/memgraphlayout.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Dependency-free force-directed layout (Fruchterman-Reingold with cluster seeding). Pure + deterministic:
// initial positions are seeded from a hash of the node id (no Math.random), so tests are stable and the
// graph doesn't jump between renders. We minimize deps per project convention — no d3-force.

import type { MemEdge, MemNote } from "./memtypes";

export type Point = { x: number; y: number };
export type LayoutOpts = { width: number; height: number; iterations: number };

// deterministic [0,1) from a string
function hash01(s: string): number {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return ((h >>> 0) % 100000) / 100000;
}

export function layoutGraph(notes: MemNote[], edges: MemEdge[], opts: LayoutOpts): Map<string, Point> {
    const { width, height, iterations } = opts;
    const pos = new Map<string, Point>();
    if (notes.length === 0) return pos;

    // seed: cluster by scope into rough columns, jitter deterministically by id hash
    const scopes = [...new Set(notes.map((n) => n.scope || "shared"))];
    const colOf = new Map(scopes.map((s, i) => [s, (i + 1) / (scopes.length + 1)]));
    for (const n of notes) {
        const cx = (colOf.get(n.scope || "shared") ?? 0.5) * width;
        pos.set(n.id, {
            x: cx + (hash01(n.id) - 0.5) * width * 0.25,
            y: (0.15 + 0.7 * hash01(n.id + "y")) * height,
        });
    }
    if (notes.length === 1) {
        pos.set(notes[0].id, { x: width / 2, y: height / 2 });
        return pos;
    }

    const area = width * height;
    const k = Math.sqrt(area / notes.length); // ideal edge length
    const ids = notes.map((n) => n.id);
    let temp = width / 10;
    const cool = temp / (iterations + 1);

    for (let it = 0; it < iterations; it++) {
        const disp = new Map<string, Point>(ids.map((id) => [id, { x: 0, y: 0 }]));
        // repulsion (all pairs)
        for (let i = 0; i < ids.length; i++) {
            for (let j = i + 1; j < ids.length; j++) {
                const a = pos.get(ids[i])!;
                const b = pos.get(ids[j])!;
                let dx = a.x - b.x;
                let dy = a.y - b.y;
                let dist = Math.hypot(dx, dy) || 0.01;
                const rep = (k * k) / dist;
                dx = (dx / dist) * rep;
                dy = (dy / dist) * rep;
                const da = disp.get(ids[i])!;
                const db = disp.get(ids[j])!;
                da.x += dx; da.y += dy;
                db.x -= dx; db.y -= dy;
            }
        }
        // attraction (edges)
        for (const e of edges) {
            const a = pos.get(e.from);
            const b = pos.get(e.to);
            if (!a || !b) continue;
            let dx = a.x - b.x;
            let dy = a.y - b.y;
            const dist = Math.hypot(dx, dy) || 0.01;
            const att = (dist * dist) / k;
            dx = (dx / dist) * att;
            dy = (dy / dist) * att;
            const da = disp.get(e.from)!;
            const db = disp.get(e.to)!;
            da.x -= dx; da.y -= dy;
            db.x += dx; db.y += dy;
        }
        // apply, capped by temperature, clamped to bounds
        for (const id of ids) {
            const d = disp.get(id)!;
            const p = pos.get(id)!;
            const len = Math.hypot(d.x, d.y) || 0.01;
            p.x += (d.x / len) * Math.min(len, temp);
            p.y += (d.y / len) * Math.min(len, temp);
            p.x = Math.max(20, Math.min(width - 20, p.x));
            p.y = Math.max(20, Math.min(height - 20, p.y));
        }
        temp -= cool;
    }
    return pos;
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run frontend/app/view/agents/memgraphlayout.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/app/view/agents/memgraphlayout.ts frontend/app/view/agents/memgraphlayout.test.ts
git commit -m "feat(memory): deterministic force-directed graph layout"
```

---

### Task 12: Graph view in the surface (SVG nodes/edges/legend)

**Files:**
- Modify: `frontend/app/view/agents/memorysurface.tsx`

Reproduces handoff graph markup lines 1080–1113 (cluster labels, edge lines, node pills, legend). Replaces the "coming next" placeholder.

- [ ] **Step 1: Add a `GraphView` component** (import `useMemo`, `layoutGraph`, `memEdgesAtom`)

Add imports at the top of `memorysurface.tsx`:

```tsx
import { useMemo } from "react";
import { layoutGraph } from "./memgraphlayout";
```

Add the component (above `MemorySurface`):

```tsx
const GRAPH_W = 880;
const GRAPH_H = 560;

function GraphView({ notes, selectedId }: { notes: MemNote[]; selectedId: string | null }) {
    const edges = useAtomValue(memEdgesAtom);
    const pos = useMemo(
        () => layoutGraph(notes, edges, { width: GRAPH_W, height: GRAPH_H, iterations: 120 }),
        [notes, edges]
    );
    const scopes = useMemo(() => [...new Set(notes.map((n) => n.scope || "shared"))], [notes]);
    return (
        <div className="relative mx-auto my-[6px]" style={{ width: GRAPH_W, height: GRAPH_H }}>
            <svg width={GRAPH_W} height={GRAPH_H} className="pointer-events-none absolute left-0 top-0">
                {edges.map((e, i) => {
                    const a = pos.get(e.from);
                    const b = pos.get(e.to);
                    if (!a || !b) return null;
                    const hot = e.from === selectedId || e.to === selectedId;
                    return (
                        <line
                            key={i}
                            x1={a.x}
                            y1={a.y}
                            x2={b.x}
                            y2={b.y}
                            stroke={hot ? "var(--color-accent-700)" : "var(--color-edge-faint)"}
                            strokeWidth={hot ? 1.7 : 1}
                        />
                    );
                })}
            </svg>
            {notes.map((n) => {
                const p = pos.get(n.id);
                if (!p) return null;
                const m = typeMeta(n.type);
                const sel = n.id === selectedId;
                return (
                    <button
                        key={n.id}
                        onClick={() => fireAndForget(() => selectNote(n.id))}
                        style={{ left: p.x, top: p.y, transform: "translate(-50%,-50%)" }}
                        className={cn(
                            "absolute flex cursor-pointer items-center gap-[7px] whitespace-nowrap rounded-[20px] border px-[12px] py-[6px] hover:border-edge-strong",
                            sel ? "border-accent bg-surface ring-2 ring-accent/20" : "border-edge-faint bg-background"
                        )}
                    >
                        <span className={cn("h-[7px] w-[7px] flex-none rounded-full", m.dotClass)} />
                        <span className={cn("font-mono text-[11.5px] font-semibold", sel ? "text-foreground" : "text-ink-hi")}>
                            {n.title}
                        </span>
                    </button>
                );
            })}
            {/* legend */}
            <div className="absolute bottom-[6px] left-[10px] flex gap-[15px] rounded-[9px] border border-edge-faint bg-surface/80 px-[13px] py-[8px]">
                {(["project", "reference", "feedback", "user"] as const).map((t) => {
                    const m = typeMeta(t);
                    return (
                        <div key={t} className="flex items-center gap-[6px]">
                            <div className={cn("h-[8px] w-[8px] rounded-full", m.dotClass)} />
                            <span className="font-mono text-[10.5px] text-ink-mid">{m.label}</span>
                        </div>
                    );
                })}
            </div>
            {/* cluster labels: one per scope, near its seed column */}
            {scopes.map((s, i) => (
                <div
                    key={s}
                    className="pointer-events-none absolute -translate-x-1/2 font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-faint"
                    style={{ left: ((i + 1) / (scopes.length + 1)) * GRAPH_W, top: 4 }}
                >
                    {s}
                </div>
            ))}
        </div>
    );
}
```

- [ ] **Step 2: Swap the placeholder** — replace the graph placeholder block in `MemorySurface` (the `<div>Graph view — coming in the next task</div>`) with:

```tsx
                    ) : (
                        <GraphView notes={filtered} selectedId={selectedId} />
                    )}
```

- [ ] **Step 3: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: no new errors.

- [ ] **Step 4: Visual check (CDP)** — toggle to Graph; confirm nodes cluster by scope, edges connect, selecting a node highlights its edges + updates the detail rail, legend shows the four types.

- [ ] **Step 5: Commit**

```bash
git add frontend/app/view/agents/memorysurface.tsx
git commit -m "feat(memory): force-directed graph view with legend + clusters"
```

---

## Phase E — Frontend: editing (create / edit / delete)

### Task 13: `NewMemoryModal` + wire "New memory"

**Files:**
- Create: `frontend/app/view/agents/newmemorymodal.tsx`
- Modify: `frontend/app/view/agents/memorysurface.tsx` (New-memory button + modal state)

Reproduces handoff modal lines 1364–1402 (type + scope + textarea + Save/Cancel; esc closes).

- [ ] **Step 1: Implement the modal**

```tsx
// frontend/app/view/agents/newmemorymodal.tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// New-memory modal (Wave-cockpit-live.dc.html:1364-1402): name + type + scope + body. Creates a note
// in the dedicated vault via memstore.createNote, then closes. Esc / backdrop click cancels.

import { cn, fireAndForget } from "@/util/util";
import { useEffect, useState } from "react";
import { createNote } from "./memstore";
import { typeMeta } from "./memtypes";

const TYPES = ["project", "reference", "feedback", "user"] as const;

export function NewMemoryModal({ onClose }: { onClose: () => void }) {
    const [name, setName] = useState("");
    const [type, setType] = useState<string>("project");
    const [scope, setScope] = useState("shared");
    const [body, setBody] = useState("");

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                e.preventDefault();
                onClose();
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [onClose]);

    const canSave = name.trim().length > 0 && body.trim().length > 0;
    const save = () => {
        if (!canSave) return;
        fireAndForget(async () => {
            await createNote(name.trim(), type, scope.trim(), body.trim());
            onClose();
        });
    };

    return (
        <div
            onClick={onClose}
            className="fixed inset-0 z-[75] flex items-start justify-center bg-black/60 pt-[12vh] backdrop-blur-[3px]"
        >
            <div
                onClick={(e) => e.stopPropagation()}
                className="w-[min(560px,93vw)] overflow-hidden rounded-[14px] border border-edge-mid bg-surface-raised shadow-2xl"
            >
                <div className="flex items-center gap-[11px] border-b border-edge-faint px-[18px] py-[15px]">
                    <span className="flex-1 text-[15px] font-semibold text-foreground">New memory</span>
                    <span className="rounded-[5px] border border-edge-mid px-[7px] py-[2px] font-mono text-[10.5px] text-ink-faint">
                        esc
                    </span>
                </div>
                <div className="flex flex-col gap-[15px] p-[18px]">
                    <input
                        autoFocus
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        placeholder="Memory name (becomes the id)"
                        className="w-full rounded-[10px] border border-border bg-background px-[13px] py-[11px] text-[13.5px] text-foreground outline-none placeholder:text-ink-mid"
                    />
                    <div>
                        <div className="mb-[9px] font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-ink-faint">
                            Type
                        </div>
                        <div className="flex flex-wrap gap-[7px]">
                            {TYPES.map((t) => {
                                const m = typeMeta(t);
                                return (
                                    <button
                                        key={t}
                                        onClick={() => setType(t)}
                                        className={cn(
                                            "flex items-center gap-[7px] rounded-[8px] border px-[11px] py-[7px] text-[12.5px]",
                                            type === t ? "border-accent text-foreground" : "border-border text-ink-mid"
                                        )}
                                    >
                                        <span className={cn("h-[7px] w-[7px] rounded-full", m.dotClass)} />
                                        {m.label}
                                    </button>
                                );
                            })}
                        </div>
                    </div>
                    <div>
                        <div className="mb-[9px] font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-ink-faint">
                            Scope
                        </div>
                        <input
                            value={scope}
                            onChange={(e) => setScope(e.target.value)}
                            placeholder="shared, or a project name"
                            className="w-full rounded-[8px] border border-border bg-background px-[12px] py-[9px] font-mono text-[12.5px] text-foreground outline-none placeholder:text-ink-mid"
                        />
                    </div>
                    <div>
                        <div className="mb-[9px] font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-ink-faint">
                            Memory
                        </div>
                        <textarea
                            value={body}
                            onChange={(e) => setBody(e.target.value)}
                            placeholder="What should every agent remember? e.g. Prefer Postgres over adding new dependencies."
                            className="h-[84px] w-full resize-none rounded-[10px] border border-border bg-background px-[13px] py-[11px] text-[13.5px] leading-[1.5] text-foreground outline-none placeholder:text-ink-mid"
                        />
                    </div>
                </div>
                <div className="flex items-center gap-[10px] border-t border-edge-faint px-[16px] py-[12px]">
                    <span className="font-mono text-[11px] text-ink-faint">
                        {typeMeta(type).label} · <span className="text-accent-soft">{scope || "shared"}</span>
                    </span>
                    <div className="flex-1" />
                    <button
                        onClick={onClose}
                        className="rounded-[8px] border border-border px-[15px] py-[8px] text-[12.5px] font-semibold text-ink-mid hover:text-foreground"
                    >
                        Cancel
                    </button>
                    <button
                        onClick={save}
                        disabled={!canSave}
                        className="rounded-[8px] bg-accent px-[16px] py-[8px] text-[12.5px] font-semibold text-background disabled:opacity-50"
                    >
                        Save memory
                    </button>
                </div>
            </div>
        </div>
    );
}
```

- [ ] **Step 2: Wire it into the surface** — in `memorysurface.tsx`, add `useState` to the imports from React, add the New-memory button in `Header`, and render the modal from `MemorySurface`.

In `Header`, add before the closing `</div>` (after the Graph/List toggle):

```tsx
            <button
                onClick={onNew}
                className="flex items-center gap-[6px] rounded-[8px] bg-accent px-[13px] py-[8px] text-[12.5px] font-semibold text-background hover:bg-accenthover"
            >
                <span className="-mt-px text-[15px] leading-none">+</span>New memory
            </button>
```

Change `Header`'s signature to `function Header({ count, onNew }: { count: number; onNew: () => void })`.

In `MemorySurface`, add state + render:

```tsx
    const [newOpen, setNewOpen] = useState(false);
```
Pass `onNew={() => setNewOpen(true)}` to `<Header>`, and before the final `</div>` of `MemorySurface`:
```tsx
            {newOpen && <NewMemoryModal onClose={() => setNewOpen(false)} />}
```
Add imports: `import { useEffect, useMemo, useState } from "react";` and `import { NewMemoryModal } from "./newmemorymodal";`.

- [ ] **Step 3: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: no new errors.

- [ ] **Step 4: Visual + functional check (CDP)** — click New memory, fill name+body, Save; confirm the note appears in the list/graph (scan reruns) and the modal closes.

- [ ] **Step 5: Commit**

```bash
git add frontend/app/view/agents/newmemorymodal.tsx frontend/app/view/agents/memorysurface.tsx
git commit -m "feat(memory): New-memory modal wired to vault create"
```

---

### Task 14: In-place note editing (Edit → textarea → save with mtime guard)

**Files:**
- Modify: `frontend/app/view/agents/memorysurface.tsx`

Rather than pull in monaco for a single small markdown box (YAGNI), the detail rail's "Edit" flips the content block into a `<textarea>` seeded with the note body; Save calls `saveNote` with the loaded mtime and warns on conflict.

- [ ] **Step 1: Add edit state to `DetailRail`**

Replace the `DetailRail` content block + Edit button with an editing-aware version:

```tsx
function DetailRail({ notes }: { notes: MemNote[] }) {
    const selectedId = useAtomValue(memSelectedIdAtom);
    const body = useAtomValue(memBodyAtom);
    const edges = useAtomValue(memEdgesAtom);
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState("");
    const [conflict, setConflict] = useState(false);
    const sel = notes.find((n) => n.id === selectedId);

    useEffect(() => {
        setEditing(false);
        setConflict(false);
    }, [selectedId]);

    if (!sel) {
        return (
            <aside className="w-[330px] flex-none border-l border-edge-faint bg-surface p-[22px] text-[13px] text-ink-mid">
                Select a memory to see its content.
            </aside>
        );
    }
    const m = typeMeta(sel.type);
    const relatedIds = new Set<string>();
    for (const e of edges) {
        if (e.from === sel.id) relatedIds.add(e.to);
        if (e.to === sel.id) relatedIds.add(e.from);
    }
    const related = notes.filter((n) => relatedIds.has(n.id));

    const startEdit = () => {
        setDraft(body?.body ?? "");
        setConflict(false);
        setEditing(true);
    };
    const doSave = () => {
        const baseMtime = body?.mtime ?? 0;
        fireAndForget(async () => {
            const r = await saveNote(sel.path, draft, baseMtime);
            if (r.conflict) {
                setConflict(true); // file changed on disk since open; reload to see it
            } else {
                setEditing(false);
            }
        });
    };

    return (
        <aside className="w-[330px] flex-none overflow-y-auto border-l border-edge-faint bg-surface px-[20px] pb-[40px] pt-[22px]">
            <div className="mb-[13px] flex items-center gap-[9px]">
                <span className={cn("rounded-[5px] px-[9px] py-[3px] font-mono text-[9.5px] font-semibold uppercase", m.pillClass)} style={{ background: "rgba(255,255,255,0.05)" }}>
                    {m.label}
                </span>
                <div className="flex-1" />
                <span className="font-mono text-[10.5px] text-ink-faint">{sel.scope}</span>
            </div>
            <h2 className="mb-[14px] text-[18px] font-bold leading-[1.3] text-foreground">{sel.title}</h2>
            <div className="mb-[8px] font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-mid">Content</div>
            {editing ? (
                <textarea
                    autoFocus
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    className="mb-[10px] h-[220px] w-full resize-none rounded-[10px] border border-accent/40 bg-background px-[15px] py-[13px] font-mono text-[12.5px] leading-[1.6] text-ink-hi outline-none"
                />
            ) : (
                <div className="mb-[10px] whitespace-pre-wrap rounded-[10px] border border-edge-faint bg-background px-[15px] py-[13px] text-[13.5px] leading-[1.6] text-ink-hi">
                    {body == null ? "Loading…" : body.body || sel.description}
                </div>
            )}
            {conflict && (
                <div className="mb-[10px] rounded-[8px] border border-warning/40 bg-warning/10 px-[11px] py-[8px] text-[12px] text-warning">
                    This note changed on disk since you opened it. Reload to see the latest before saving.
                </div>
            )}
            <div className="mb-[22px] flex gap-[8px]">
                {editing ? (
                    <>
                        <button onClick={doSave} className="flex-1 rounded-[8px] bg-accent py-[8px] text-[12px] font-semibold text-background hover:bg-accenthover">
                            Save
                        </button>
                        <button
                            onClick={() => {
                                setEditing(false);
                                setConflict(false);
                            }}
                            className="flex-1 rounded-[8px] border border-edge-mid bg-surface py-[8px] text-[12px] text-ink-mid hover:border-edge-strong"
                        >
                            Cancel
                        </button>
                        {conflict && (
                            <button
                                onClick={() => fireAndForget(() => selectNote(sel.id))}
                                className="rounded-[8px] border border-edge-mid px-[10px] py-[8px] text-[12px] text-ink-mid"
                            >
                                Reload
                            </button>
                        )}
                    </>
                ) : (
                    <>
                        <button onClick={startEdit} className="flex-1 rounded-[8px] border border-edge-mid bg-surface py-[8px] text-[12px] text-ink-mid hover:border-edge-strong">
                            Edit
                        </button>
                        <button
                            onClick={() => fireAndForget(() => deleteNote(sel.path))}
                            className="rounded-[8px] border border-error/30 px-[12px] py-[8px] text-[12px] text-error hover:bg-error/10"
                        >
                            Delete
                        </button>
                    </>
                )}
            </div>
            <div className="mb-[22px] flex flex-col">
                <MetaRow label="Scope" value={sel.scope} border />
                <MetaRow label="Source" value={sel.source} border />
                <MetaRow label="Updated" value={new Date(sel.updatedts).toLocaleDateString()} />
            </div>
            {related.length > 0 && (
                <>
                    <div className="mb-[11px] font-mono text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-mid">
                        Related memory
                    </div>
                    <div className="flex flex-col gap-[7px]">
                        {related.map((r) => {
                            const rm = typeMeta(r.type);
                            return (
                                <button
                                    key={r.id}
                                    onClick={() => fireAndForget(() => selectNote(r.id))}
                                    className="flex items-center gap-[9px] rounded-[9px] border border-edge-faint bg-background px-[11px] py-[9px] hover:border-edge-strong"
                                >
                                    <div className={cn("h-[6px] w-[6px] flex-none rounded-full", rm.dotClass)} />
                                    <span className="min-w-0 flex-1 truncate text-left font-mono text-[11.5px] text-ink-hi">
                                        {r.title}
                                    </span>
                                    <span className="text-[10px] text-ink-faint">→</span>
                                </button>
                            );
                        })}
                    </div>
                </>
            )}
        </aside>
    );
}
```

Add to the store import in `memorysurface.tsx`: `saveNote`.

- [ ] **Step 2: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: no new errors.

- [ ] **Step 3: Functional check (CDP)** — Edit a note, change text, Save; confirm the list/graph refresh and the content persists. To test the mtime guard: with the editor open, `echo "changed" >> <notepath>` on disk, then Save → the conflict warning appears and the file is not clobbered; Reload shows the disk content.

- [ ] **Step 4: Commit**

```bash
git add frontend/app/view/agents/memorysurface.tsx
git commit -m "feat(memory): in-place note editing with mtime conflict guard"
```

---

## Phase F — Wrap-up

### Task 15: Full-suite gates + fold specs into the feature

- [ ] **Step 1: Run all gates**

```bash
go test ./pkg/memvault/ -v
npx vitest run frontend/app/view/agents/memtypes.test.ts frontend/app/view/agents/memgraphlayout.test.ts
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit
go build ./...
```
Expected: Go tests PASS; vitest PASS; tsc shows only the ~3 baseline `api.test.ts` errors; go build exit 0.

- [ ] **Step 2: Final CDP walkthrough** — Memory rail item → List and Graph both render real vault data (Claude + Codex + dedicated), search filters, select updates detail + related, New/Edit/Delete round-trip, mtime guard warns. Capture `memory-final.png`.

- [ ] **Step 3: Stage the design + spike specs with the feature** (per the git rule: spec/plan docs fold into the feature commit, never a docs-only commit)

```bash
git add docs/superpowers/specs/2026-06-30-memory-tab-design.md \
        docs/superpowers/specs/2026-06-30-memory-sync-spike.md \
        docs/superpowers/plans/2026-07-01-memory-tab-viewer.md
git commit -m "docs(memory): fold viewer design + sync spike + plan into feature"
```

> Per the user's STRICT git workflow, do not push. Present the batched commits for approval at the end.

---

## Deferred (documented, not built in this plan)

Record these in `docs/deferred.md` (or the plan's tracking note) so the gaps are explicit, not silent:

1. **Live fsnotify external-write watch.** An agent appending to a note mid-session won't appear until the surface remounts or a mutation reruns the scan. Add a `MemoryWatchCommand` streaming RPC modeled on the live-transcript fsnotify watcher, pushing a wps event that triggers `loadMemory()`. (Design doc §Backend "Watch vault".)
2. **Codex `[[wikilinks]]` sparsity.** Codex markdown doesn't use wikilinks, so cross-source edges are Claude-dense. Expected per the design; revisit if harvest (goal 2) normalizes links.
3. **Scope-derivation heuristic.** `Scope` = parent folder / frontmatter `scope` / `"shared"`. If real vault layouts group differently (design open Q2), switch the signal in `deriveScope`.
4. **The sync engine (goal 2).** Separate plan: project memories to each agent's steering file (facts-to-know, not always-do directives — per the 2026-07-01 spike nuance), harvest native stores with hash dedup + provenance tags.
5. **Graph zoom/pan controls.** The handoff shows +/− zoom buttons (Wave-cockpit-live.dc.html:1109–1112); this plan renders a fixed-viewport graph. Add SVG viewBox zoom + drag-pan as a follow-up if the graph grows dense enough to need it.
6. **Header type/project filter chips.** The design doc §Views lists "type/project filters" in the header; the handoff SoT header (1063–1075) renders only search + Graph/List + New, which is what this plan builds. Add filter chips if triage over a large vault needs them (search already covers title/description).
