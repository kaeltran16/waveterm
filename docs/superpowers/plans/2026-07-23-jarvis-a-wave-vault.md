# Jarvis A — Wave Vault foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `pkg/wavevault` — a git-backed, Obsidian-compatible Wave Vault with a deterministic read API (frontmatter query · full-text · wikilink expansion · content hash), a region-aware diff-validated write path, and ownership-staged commits — the storage substrate the rest of Jarvis v1 rests on.

**Architecture:** A pure Go package in `pkg/wavevault`, consumed in-process by B/C/E/F inside `wavesrv` — no wshrpc/wire types, no frontend, no model calls (everything A does is deterministic and free). Git is shelled out to the `git` binary (no go-git), following `pkg/gitinfo`. Reads run over an in-memory graph scanned per scoped `Retriever`; writes splice only machine-owned regions (a `RegionSpec` supplied by B) and are diff-validated to reject any change to a human-owned region; commits are staged by ownership (machine as `Jarvis`, human as the user) at consumer-triggered boundaries plus an idle/quit safety flush.

**Tech Stack:** Go (`pkg/wavevault`, sibling to `pkg/memvault` + `pkg/gitinfo`), `gopkg.in/yaml.v3` for frontmatter, `crypto/sha256` for content hashes, `os/exec` for git, the repo's Task-driven config codegen (`task generate`). No SQLite (the derived layer is in-memory), no FE.

## Global Constraints

Every task's requirements implicitly include these. Values copied verbatim from CLAUDE.md, the spec, and the codebase.

- **A never calls a model and exposes no RPC.** A is deterministic and in-process; the wire/RPC surface belongs to F. No `wshrpc` types are added, so the codegen-bootstrap gotcha does not apply.
- **Go is the source of truth for config types.** Task 1 adds a `Settings` field + a config-key const, then runs `task generate`, which regenerates `schema/settings.json` and `frontend/types/gotypes.d.ts`. **Never hand-edit those generated files.**
- **Git = shell out to the `git` binary** via `os/exec`, mirroring `pkg/gitinfo` (`exec.CommandContext(ctx, "git", append([]string{"-C", dir}, args...)...)`, a fixed `gitTimeout`, `CombinedOutput` for the stderr-carrying error path). No `go-git` dependency.
- **Go tests:** `go test ./pkg/wavevault/`. Git-backed tests create a real repo in `t.TempDir()` with `git init -b main`, set `core.autocrlf false` for hermetic line endings on Windows, and set `GIT_AUTHOR_*`/`GIT_COMMITTER_*` (or repo `user.*` config) so commits succeed in CI. No jsdom / FE tests (A has no FE).
- **Windows path bound.** Any vault filename A generates must be length-bounded (memvault hit MAX_PATH via unbounded slugs). A does not generate dossier filenames in v1 (that is B), but keep the discipline for any temp/derived name.
- **Coexist with memvault.** Do **not** modify `pkg/memvault`, repoint its roots, or migrate `~/.waveterm/memory`. The two durable-knowledge roots coexist (recorded in `docs/deferred.md`, "Jarvis sub-project A — memory vault coexists, unify later").
- **Git workflow (per CLAUDE.md):** commits need explicit human approval and are batched — do **NOT** auto-commit or push. Each task's final step is **"stage + checkpoint for review"** (`git add`, no commit). The spec, this plan, and the `docs/deferred.md` entry fold into A's **one** feature commit at the end — never a docs-only commit. Do not add a co-author.
- **Meta-spec tracking table:** do **not** edit `docs/superpowers/specs/2026-07-23-jarvis-second-brain-meta-spec.md` during this plan (a concurrent Jarvis cycle may be editing it). The A-row link is added at A's feature-commit time.
- **No PowerShell here-strings** in the Bash tool for commit messages (Windows env); use `-F` or multiple `-m` if committing.

## File Structure

**New (Go), all under `pkg/wavevault/`:**

| File | Responsibility |
|---|---|
| `parse.go` | Lossless parse (`Node` = id/path/collection/frontmatter/links/hash/mtime + body) and `ContentHash`. |
| `region.go` | `RegionSpec`/`RegionEdit` (the A/B contract), the region splice, and the diff-validator that rejects human-region changes. |
| `git.go` | Thin git shell-out helpers (`runGit`/`runGitErr`) mirroring `pkg/gitinfo`. |
| `vault.go` | `Vault` handle; locate/create/`git init` + fallback identity; collection constants + `Scope`. |
| `read.go` | The in-memory graph, `Retriever`, and the read API: `Query` / `Search` / `Read` / `Expand`. |
| `write.go` | `Write` (splice + diff-validate + `baseHash` conflict guard) + the machine-written-file tracking. |
| `commit.go` | Ownership-staged `Commit(label)`, `Flush` safety commit, idle-debounce auto-flush. |
| `*_test.go` | One test file per source file (`parse_test.go`, `region_test.go`, `vault_test.go`, `read_test.go`, `write_test.go`, `commit_test.go`). |

**Modified (Go):**

| File | Change |
|---|---|
| `pkg/wconfig/settingsconfig.go` | Add `JarvisVaultPath string` to `Settings`. |
| `pkg/wconfig/metaconsts.go` | Add `ConfigKey_JarvisVaultPath`. |
| `schema/settings.json`, `frontend/types/gotypes.d.ts` | **Regenerated** by `task generate` (do not hand-edit). |

## Interfaces (whole-package summary)

The types every task shares. Later tasks rely on these exact names/signatures:

```go
// parse.go
type Node struct {
    ID          string
    Path        string
    Collection  string
    Frontmatter map[string]any
    Links       []string
    ContentHash string
    UpdatedTs   int64
}
func ContentHash(data []byte) string
func parseNode(path string, data []byte) (Node, string) // (node, body)

// region.go
type RegionKind int
const (FrontmatterKey RegionKind = iota; Block)
type RegionSpec struct { MachineKeys []string; Blocks []string }
type RegionEdit struct { Kind RegionKind; Name string; Value string }

// vault.go
const (CollMemory = "memory"; CollTasks = "tasks"; CollDecisions = "decisions"; CollAttachments = "attachments")
type Scope struct { Collections []string }
func AllScope() Scope
func WorkerScope() Scope
type Vault struct { Root string; /* + unexported mu, machineFiles */ }
func OpenVault(ctx context.Context) (*Vault, error)

// read.go
type Retriever struct { /* unexported */ }
func (v *Vault) Retriever(scope Scope) *Retriever
type Filter struct { FrontmatterEquals map[string]string; HasLink string }
type Hit struct { Node Node; Snippet string }
type NodeWithBody struct { Node Node; Body string }
type Edge struct { From, To string }
type ExpandOpts struct { Depth int; Fanout int }
type Subgraph struct { Nodes []Node; Edges []Edge }
func (r *Retriever) Query(f Filter) ([]Node, error)
func (r *Retriever) Search(query string) ([]Hit, error)
func (r *Retriever) Read(id string) (*NodeWithBody, error)
func (r *Retriever) Expand(seeds []string, opts ExpandOpts) (*Subgraph, error)

// write.go
type WriteResult struct { Hash string; Conflict bool; ConflictRegions []string }
func (v *Vault) Write(id string, spec RegionSpec, edits []RegionEdit, baseHash string) (*WriteResult, error)

// commit.go
func (v *Vault) Commit(ctx context.Context, label string) error
func (v *Vault) Flush(ctx context.Context) error
```

**Refinements this plan makes to the spec (deliberate, called out for the reviewer):**
- **Derived layer is scan-on-demand per `Retriever`**, not a process-wide cached index. Each `Retriever` scans its scope once on first use and reuses it for that handle's lifetime; a new logical operation uses a fresh `Retriever`, so there is no cross-operation invalidation machinery. This matches memvault's proven re-scan pattern and is more YAGNI than the spec's "cached for the process lifetime" language — both satisfy invariant 3 ("rebuildable from files"). No behavior the spec promised is lost.
- **Conflict handling is the memvault-style guard (spec §5, simpler branch):** on a `baseHash` mismatch, `Write` returns `Conflict=true` **without writing** and lists the targeted machine regions in `ConflictRegions`; the caller re-reads (getting the fresh hash) and retries. This guarantees "never silently clobbered" without re-splicing. Re-splice-onto-current is deferred.
- **Machine blocks must pre-exist to be written** (frontmatter keys may be created). `Write` replaces content only *between* existing `<!-- jarvis:begin NAME -->`/`<!-- jarvis:end NAME -->` markers; it errors if the block is absent (B scaffolds blocks when it creates a dossier — the meta-spec assigns the renderer to B). This keeps the diff-validator exact (no ambiguous whitespace from appending a new block).
- **Ownership staging uses per-file hashes:** `Write` records the hash it wrote; at `Commit`, a tracked file whose on-disk hash is unchanged commits as `Jarvis`, and any tracked file a human later touched (hash differs) falls into the user commit — faithfully realizing spec §6's "mixed file → user" file-granular rule without hunk-splitting.

---

### Task 1: Add the `jarvis:vaultpath` config setting

Adds the user-overridable vault-path setting and regenerates the config schema. Mirrors the existing `memory:vaultpath` declaration exactly.

**Files:**
- Modify: `pkg/wconfig/settingsconfig.go:113`, `pkg/wconfig/metaconsts.go:61`
- Regenerated (do not hand-edit): `schema/settings.json`, `frontend/types/gotypes.d.ts`

**Interfaces:**
- Produces: `wconfig.Settings.JarvisVaultPath` (JSON key `jarvis:vaultpath`), `wconfig.ConfigKey_JarvisVaultPath`.

- [ ] **Step 1: Add the `Settings` field**

In `pkg/wconfig/settingsconfig.go`, immediately after the `MemoryGardenerStaleDays` line (line 114), add:
```go
	JarvisVaultPath         string `json:"jarvis:vaultpath,omitempty"`
```

- [ ] **Step 2: Add the config-key const**

In `pkg/wconfig/metaconsts.go`, immediately after the `ConfigKey_MemoryGardenerStaleDays` line (line 62), add:
```go
	ConfigKey_JarvisVaultPath                = "jarvis:vaultpath"
```

- [ ] **Step 3: Build the package**

Run: `go build ./pkg/wconfig/`
Expected: exit 0.

- [ ] **Step 4: Regenerate the schema**

Run: `task generate`
Expected: success. `schema/settings.json` now has a `"jarvis:vaultpath": { "type": "string" }` entry and `frontend/types/gotypes.d.ts` has `"jarvis:vaultpath"?: string;`.

- [ ] **Step 5: Verify the regen landed**

Run: `git status --porcelain schema/settings.json frontend/types/gotypes.d.ts`
Expected: both files show as modified (`M`). Confirm the new key is present in each (search for `jarvis:vaultpath`). Do not hand-edit them — if the key is missing, re-check Steps 1-2 and rerun `task generate`.

- [ ] **Step 6: Stage + checkpoint**

`git add pkg/wconfig/settingsconfig.go pkg/wconfig/metaconsts.go schema/settings.json frontend/types/gotypes.d.ts` (do not commit).

---

### Task 2: Lossless parse + content hash (`parse.go`)

The file→`Node` parser (frontmatter map, wikilinks, sha256 hash) the read and write paths both build on.

**Files:**
- Create: `pkg/wavevault/parse.go`, `pkg/wavevault/parse_test.go`

**Interfaces:**
- Produces: `Node`, `ContentHash(data []byte) string`, `parseNode(path string, data []byte) (Node, string)`.

- [ ] **Step 1: Write the failing test**

Create `pkg/wavevault/parse_test.go`:
```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wavevault

import "testing"

func TestParseNodeFrontmatterLinksHash(t *testing.T) {
	raw := []byte("---\nid: t-42\nstatus: active\ntags: [a, b]\n---\n\n# The title\n\nbody refs [[m-1]] and [[m-2]] and [[m-1]] again.\n")
	n, body := parseNode("/vault/tasks/active/t-42.md", raw)
	if n.ID != "t-42" {
		t.Fatalf("ID = %q, want t-42", n.ID)
	}
	if n.Frontmatter["status"] != "active" {
		t.Fatalf("status = %v, want active", n.Frontmatter["status"])
	}
	if len(n.Links) != 2 || n.Links[0] != "m-1" || n.Links[1] != "m-2" {
		t.Fatalf("links = %v, want [m-1 m-2] (order-preserving, deduped)", n.Links)
	}
	if n.ContentHash != ContentHash(raw) {
		t.Fatalf("ContentHash on the node must equal ContentHash(raw)")
	}
	if body == "" || body[0] == '-' {
		t.Fatalf("body should be the post-frontmatter content, got %q", body)
	}
}

func TestParseNodeNoFrontmatterFallsBackToFilename(t *testing.T) {
	n, body := parseNode("/vault/memory/note-x.md", []byte("just prose, no frontmatter\n"))
	if n.ID != "note-x" {
		t.Fatalf("ID = %q, want note-x (filename stem)", n.ID)
	}
	if n.Frontmatter != nil {
		t.Fatalf("Frontmatter should be nil when absent, got %v", n.Frontmatter)
	}
	if body != "just prose, no frontmatter\n" {
		t.Fatalf("body = %q", body)
	}
}

func TestContentHashChangesWithContent(t *testing.T) {
	if ContentHash([]byte("a")) == ContentHash([]byte("b")) {
		t.Fatal("different content must hash differently")
	}
	if ContentHash([]byte("a")) != ContentHash([]byte("a")) {
		t.Fatal("hash must be stable")
	}
}
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `go test ./pkg/wavevault/ -run 'TestParseNode|TestContentHash'`
Expected: FAIL — the package does not compile (`Node` / `parseNode` / `ContentHash` undefined).

- [ ] **Step 3: Implement `parse.go`**

Create `pkg/wavevault/parse.go`:
```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Package wavevault is the git-backed Wave Vault storage substrate for Jarvis v1: a deterministic
// read API (frontmatter query, full-text, wikilink expansion, content hash), a region-aware
// diff-validated write path, and ownership-staged commits. It calls no model and exposes no RPC.
package wavevault

import (
	"crypto/sha256"
	"encoding/hex"
	"path/filepath"
	"regexp"
	"strings"

	"gopkg.in/yaml.v3"
)

// Node is one parsed vault file. Body is returned separately by parseNode (the graph stores it
// alongside). Collection and UpdatedTs are filled in by the scanner, not by parseNode.
type Node struct {
	ID          string         `json:"id"`
	Path        string         `json:"path"`
	Collection  string         `json:"collection"`
	Frontmatter map[string]any `json:"frontmatter"`
	Links       []string       `json:"links"`
	ContentHash string         `json:"contenthash"`
	UpdatedTs   int64          `json:"updatedts"`
}

var linkRe = regexp.MustCompile(`\[\[([^\]]+)\]\]`)

// ContentHash is the sha256 (hex) of the raw file bytes — the per-node invalidation key C keys on.
func ContentHash(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

// parseNode splits frontmatter from body, unmarshals the frontmatter into a map (order does not
// matter for querying; the write path preserves order by splicing raw text, not re-serializing this
// map), extracts deduped [[wikilinks]] in order, and hashes the raw bytes. ID is frontmatter id,
// else name, else the filename stem. Frontmatter parsing follows memvault's --- delimiter handling.
func parseNode(path string, data []byte) (Node, string) {
	n := Node{Path: path, ContentHash: ContentHash(data)}
	body := string(data)
	if strings.HasPrefix(body, "---\n") {
		if end := strings.Index(body[4:], "\n---"); end >= 0 {
			fmText := body[4 : 4+end]
			rest := body[4+end+4:]
			rest = strings.TrimLeft(rest, "\n")
			var fm map[string]any
			if err := yaml.Unmarshal([]byte(fmText), &fm); err == nil {
				n.Frontmatter = fm
			}
			body = rest
		}
	}
	if s, ok := n.Frontmatter["id"].(string); ok {
		n.ID = s
	}
	if n.ID == "" {
		if s, ok := n.Frontmatter["name"].(string); ok {
			n.ID = s
		}
	}
	if n.ID == "" {
		n.ID = strings.TrimSuffix(filepath.Base(path), ".md")
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
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `go test ./pkg/wavevault/ -run 'TestParseNode|TestContentHash'`
Expected: PASS.

- [ ] **Step 5: Stage + checkpoint**

`git add pkg/wavevault/parse.go pkg/wavevault/parse_test.go` (do not commit).

---

### Task 3: Region splice + diff-validate (`region.go`)

The write-ownership mechanism: splice a value into a machine-owned frontmatter key or delimited block, and reject any splice that would alter a human-owned region. This is the heart of invariant 5; B supplies the `RegionSpec`.

**Files:**
- Create: `pkg/wavevault/region.go`, `pkg/wavevault/region_test.go`

**Interfaces:**
- Produces: `RegionKind` (`FrontmatterKey`, `Block`), `RegionSpec`, `RegionEdit`, `editsInSpec`, `spliceRegions`, `humanProjection`, `validateMachineOnly`.

- [ ] **Step 1: Write the failing test**

Create `pkg/wavevault/region_test.go`:
```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wavevault

import (
	"strings"
	"testing"
)

const seeded = "---\nid: t-1\nstatus: draft\ntitle: My Task\n---\n\n" +
	"Human prose that must never change.\n\n" +
	"<!-- jarvis:begin state -->\nold summary\n<!-- jarvis:end state -->\n\nMore human prose.\n"

var spec = RegionSpec{MachineKeys: []string{"status"}, Blocks: []string{"state"}}

func TestSpliceFrontmatterKey(t *testing.T) {
	out, err := spliceRegions(seeded, []RegionEdit{{Kind: FrontmatterKey, Name: "status", Value: "active"}})
	if err != nil {
		t.Fatalf("splice: %v", err)
	}
	if !strings.Contains(out, "status: active") || strings.Contains(out, "status: draft") {
		t.Fatalf("status not updated:\n%s", out)
	}
	if !strings.Contains(out, "title: My Task") || !strings.Contains(out, "Human prose that must never change.") {
		t.Fatalf("human regions altered:\n%s", out)
	}
}

func TestSpliceBlockReplacesBetweenMarkers(t *testing.T) {
	out, err := spliceRegions(seeded, []RegionEdit{{Kind: Block, Name: "state", Value: "new summary"}})
	if err != nil {
		t.Fatalf("splice: %v", err)
	}
	if !strings.Contains(out, "new summary") || strings.Contains(out, "old summary") {
		t.Fatalf("block not replaced:\n%s", out)
	}
	if !strings.Contains(out, "<!-- jarvis:begin state -->") || !strings.Contains(out, "<!-- jarvis:end state -->") {
		t.Fatalf("markers lost:\n%s", out)
	}
	if !strings.Contains(out, "More human prose.") {
		t.Fatalf("human prose after the block lost:\n%s", out)
	}
}

func TestSpliceAddsNewMachineFrontmatterKey(t *testing.T) {
	out, err := spliceRegions(seeded, []RegionEdit{{Kind: FrontmatterKey, Name: "confidence", Value: "high"}})
	if err != nil {
		t.Fatalf("splice: %v", err)
	}
	if !strings.Contains(out, "confidence: high") {
		t.Fatalf("new key not added:\n%s", out)
	}
	if err := validateMachineOnly(seeded, out, RegionSpec{MachineKeys: []string{"status", "confidence"}, Blocks: []string{"state"}}); err != nil {
		t.Fatalf("adding a machine key must pass validation: %v", err)
	}
}

func TestSpliceBlockAbsentErrors(t *testing.T) {
	_, err := spliceRegions("---\nid: x\n---\n\nno block here\n", []RegionEdit{{Kind: Block, Name: "state", Value: "v"}})
	if err == nil {
		t.Fatal("writing an absent block must error (B scaffolds blocks)")
	}
}

func TestEditsInSpecRejectsUnownedRegion(t *testing.T) {
	if err := editsInSpec(spec, []RegionEdit{{Kind: FrontmatterKey, Name: "title", Value: "hijack"}}); err == nil {
		t.Fatal("editing a non-machine key must be rejected")
	}
	if err := editsInSpec(spec, []RegionEdit{{Kind: Block, Name: "notmine", Value: "x"}}); err == nil {
		t.Fatal("editing a non-machine block must be rejected")
	}
	if err := editsInSpec(spec, []RegionEdit{{Kind: FrontmatterKey, Name: "status", Value: "ok"}}); err != nil {
		t.Fatalf("editing a machine key must be allowed: %v", err)
	}
}

func TestValidateRejectsHumanRegionInjection(t *testing.T) {
	// a value that tries to inject a second frontmatter key must be caught by the diff-validator
	out, _ := spliceRegions(seeded, []RegionEdit{{Kind: FrontmatterKey, Name: "status", Value: "active\ntitle: HIJACKED"}})
	if err := validateMachineOnly(seeded, out, spec); err == nil {
		t.Fatal("an injected human key must fail validation")
	}
}
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `go test ./pkg/wavevault/ -run 'TestSplice|TestEditsInSpec|TestValidate'`
Expected: FAIL — `RegionSpec` / `spliceRegions` / `validateMachineOnly` / `editsInSpec` undefined.

- [ ] **Step 3: Implement `region.go`**

Create `pkg/wavevault/region.go`:
```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wavevault

import (
	"fmt"
	"strings"
)

type RegionKind int

const (
	FrontmatterKey RegionKind = iota // a reserved top-level frontmatter key
	Block                            // a <!-- jarvis:begin NAME --> ... <!-- jarvis:end NAME --> body block
)

// RegionSpec declares which regions of a file Jarvis exclusively owns. Supplied by B (the dossier
// policy); A enforces it generically. Everything not named here is human-owned.
type RegionSpec struct {
	MachineKeys []string
	Blocks      []string
}

// RegionEdit is one machine-region write: a new Value for the frontmatter key or block named Name.
type RegionEdit struct {
	Kind  RegionKind
	Name  string
	Value string
}

// editsInSpec rejects any edit that targets a region not declared machine-owned by spec. This is the
// pre-check; validateMachineOnly is the post-splice guard against injection.
func editsInSpec(spec RegionSpec, edits []RegionEdit) error {
	keys := map[string]bool{}
	for _, k := range spec.MachineKeys {
		keys[k] = true
	}
	blocks := map[string]bool{}
	for _, b := range spec.Blocks {
		blocks[b] = true
	}
	for _, e := range edits {
		switch e.Kind {
		case FrontmatterKey:
			if !keys[e.Name] {
				return fmt.Errorf("wavevault: edit targets non-machine frontmatter key %q", e.Name)
			}
		case Block:
			if !blocks[e.Name] {
				return fmt.Errorf("wavevault: edit targets non-machine block %q", e.Name)
			}
		default:
			return fmt.Errorf("wavevault: unknown region kind %d", e.Kind)
		}
	}
	return nil
}

// spliceRegions applies each edit to content in order, returning the new content. Frontmatter keys
// are upserted; blocks are replaced between existing markers (an absent block errors — B scaffolds
// blocks). All bytes outside the targeted regions are preserved verbatim.
func spliceRegions(content string, edits []RegionEdit) (string, error) {
	out := content
	for _, e := range edits {
		switch e.Kind {
		case FrontmatterKey:
			out = setFrontmatterKey(out, e.Name, e.Value)
		case Block:
			var err error
			out, err = setBlock(out, e.Name, e.Value)
			if err != nil {
				return "", err
			}
		default:
			return "", fmt.Errorf("wavevault: unknown region kind %d", e.Kind)
		}
	}
	return out, nil
}

// setFrontmatterKey upserts a top-level "key: value" line inside the --- frontmatter block,
// preserving the body and all other keys. Creates a frontmatter block if none exists.
func setFrontmatterKey(content, key, value string) string {
	line := key + ": " + value
	if !strings.HasPrefix(content, "---\n") {
		return "---\n" + line + "\n---\n\n" + content
	}
	end := strings.Index(content[4:], "\n---")
	if end < 0 {
		return "---\n" + line + "\n---\n\n" + content
	}
	fmText := content[4 : 4+end]
	rest := content[4+end:] // starts at "\n---"
	lines := strings.Split(fmText, "\n")
	replaced := false
	for i, l := range lines {
		if !strings.HasPrefix(l, " ") && strings.HasPrefix(l, key+":") {
			lines[i] = line
			replaced = true
			break
		}
	}
	if !replaced {
		lines = append(lines, line)
	}
	return "---\n" + strings.Join(lines, "\n") + rest
}

// setBlock replaces the content between an existing <!-- jarvis:begin NAME --> / <!-- jarvis:end
// NAME --> pair. It errors if the block is absent (creating a block would introduce ambiguous
// surrounding whitespace that the diff-validator can't distinguish from a human edit; B scaffolds
// blocks when it renders a dossier).
func setBlock(content, name, value string) (string, error) {
	begin := "<!-- jarvis:begin " + name + " -->"
	end := "<!-- jarvis:end " + name + " -->"
	bi := strings.Index(content, begin)
	if bi < 0 {
		return "", fmt.Errorf("wavevault: machine block %q not present (B must scaffold it)", name)
	}
	after := bi + len(begin)
	rel := strings.Index(content[after:], end)
	if rel < 0 {
		return "", fmt.Errorf("wavevault: machine block %q has no end marker", name)
	}
	ei := after + rel
	return content[:after] + "\n" + value + "\n" + content[ei:], nil
}

// humanProjection removes every machine-owned region so two versions can be compared for
// human-region equality: a splice that touched only machine regions leaves this identical.
func humanProjection(content string, spec RegionSpec) string {
	out := content
	for _, name := range spec.Blocks {
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
			ei := bi + rel + len(end)
			out = out[:bi] + out[ei:]
		}
	}
	if strings.HasPrefix(out, "---\n") {
		if e := strings.Index(out[4:], "\n---"); e >= 0 {
			fmText := out[4 : 4+e]
			rest := out[4+e:]
			machine := map[string]bool{}
			for _, k := range spec.MachineKeys {
				machine[k] = true
			}
			var kept []string
			for _, l := range strings.Split(fmText, "\n") {
				isMachine := false
				for k := range machine {
					if !strings.HasPrefix(l, " ") && strings.HasPrefix(l, k+":") {
						isMachine = true
						break
					}
				}
				if !isMachine {
					kept = append(kept, l)
				}
			}
			out = "---\n" + strings.Join(kept, "\n") + rest
		}
	}
	return out
}

// validateMachineOnly rejects a write whose human-owned regions differ from the original — the guard
// that makes it impossible to clobber human text (invariant 5).
func validateMachineOnly(oldContent, newContent string, spec RegionSpec) error {
	if humanProjection(oldContent, spec) != humanProjection(newContent, spec) {
		return fmt.Errorf("wavevault: write would modify a human-owned region")
	}
	return nil
}
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `go test ./pkg/wavevault/ -run 'TestSplice|TestEditsInSpec|TestValidate'`
Expected: PASS.

- [ ] **Step 5: Stage + checkpoint**

`git add pkg/wavevault/region.go pkg/wavevault/region_test.go` (do not commit).

---

### Task 4: git helpers + vault locate/create/init (`git.go`, `vault.go`)

The `Vault` handle: create the collection tree, `git init` with a fallback identity, and the git shell-out helpers commits build on.

**Files:**
- Create: `pkg/wavevault/git.go`, `pkg/wavevault/vault.go`, `pkg/wavevault/vault_test.go`

**Interfaces:**
- Consumes: `wconfig.Settings.JarvisVaultPath` (Task 1), `wavebase.GetHomeDir`/`ExpandHomeDirSafe`.
- Produces: `runGit`/`runGitErr`; collection consts (`CollMemory`/`CollTasks`/`CollDecisions`/`CollAttachments`); `Scope`, `AllScope()`, `WorkerScope()`; `Vault` (with `Root`, unexported `mu sync.Mutex`, `machineFiles map[string]string`); `OpenVault(ctx)`; the test seam `openVaultAt(ctx, root)`.

- [ ] **Step 1: Write the failing test**

Create `pkg/wavevault/vault_test.go`:
```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wavevault

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestOpenVaultAtScaffoldsAndInitsGit(t *testing.T) {
	root := t.TempDir()
	v, err := openVaultAt(context.Background(), root)
	if err != nil {
		t.Fatalf("openVaultAt: %v", err)
	}
	for _, sub := range []string{"memory", "tasks/active", "tasks/archive", "decisions", "attachments"} {
		if _, err := os.Stat(filepath.Join(root, sub)); err != nil {
			t.Fatalf("collection dir %q not created: %v", sub, err)
		}
	}
	if _, err := os.Stat(filepath.Join(root, ".git")); err != nil {
		t.Fatalf(".git not initialized: %v", err)
	}
	// fallback identity set so a human commit can't fail
	if out, err := runGit(context.Background(), root, "config", "user.email"); err != nil || out == "" {
		t.Fatalf("fallback user.email not set: out=%q err=%v", out, err)
	}
	if v.machineFiles == nil {
		t.Fatal("machineFiles map must be initialized")
	}
}

func TestOpenVaultAtIdempotent(t *testing.T) {
	root := t.TempDir()
	if _, err := openVaultAt(context.Background(), root); err != nil {
		t.Fatal(err)
	}
	// pre-set a distinct identity; a second open must not clobber it (idempotent init)
	if _, err := runGitErr(context.Background(), root, "config", "user.email", "kept@me"); err != nil {
		t.Fatal(err)
	}
	if _, err := openVaultAt(context.Background(), root); err != nil {
		t.Fatalf("second open: %v", err)
	}
	out, _ := runGit(context.Background(), root, "config", "user.email")
	if out == "" || out[:5] != "kept@" {
		t.Fatalf("second open clobbered identity: %q", out)
	}
}

func TestScopes(t *testing.T) {
	if got := WorkerScope().Collections; len(got) != 2 {
		t.Fatalf("WorkerScope = %v, want 2 collections (memory, decisions)", got)
	}
	for _, c := range WorkerScope().Collections {
		if c == CollTasks {
			t.Fatal("WorkerScope must NOT include tasks")
		}
	}
	all := AllScope().Collections
	hasTasks := false
	for _, c := range all {
		if c == CollTasks {
			hasTasks = true
		}
	}
	if !hasTasks {
		t.Fatalf("AllScope must include tasks, got %v", all)
	}
}
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `go test ./pkg/wavevault/ -run 'TestOpenVault|TestScopes'`
Expected: FAIL — `openVaultAt` / `runGit` / `WorkerScope` etc. undefined.

- [ ] **Step 3: Implement `git.go`**

Create `pkg/wavevault/git.go`:
```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wavevault

import (
	"context"
	"fmt"
	"os/exec"
	"strings"
	"time"
)

const gitTimeout = 10 * time.Second

// runGit runs `git -C dir args...` and returns stdout. Mirrors pkg/gitinfo's read path.
func runGit(ctx context.Context, dir string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, gitTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", append([]string{"-C", dir}, args...)...)
	out, err := cmd.Output()
	return strings.TrimSpace(string(out)), err
}

// runGitErr is runGit for write operations: it captures stderr into the error so a failure's cause
// is visible.
func runGitErr(ctx context.Context, dir string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, gitTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", append([]string{"-C", dir}, args...)...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return string(out), fmt.Errorf("git %s: %w: %s", strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
	return string(out), nil
}
```

- [ ] **Step 4: Implement `vault.go`**

Create `pkg/wavevault/vault.go`:
```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wavevault

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/wconfig"
)

const (
	CollMemory      = "memory"
	CollTasks       = "tasks"
	CollDecisions   = "decisions"
	CollAttachments = "attachments"
)

const defaultVaultSubpath = ".waveterm/vault"

// scaffoldDirs are the directories created on first open. tasks has active/archive subdirs; the
// read scopes address the top-level "tasks" collection (the scanner recurses).
var scaffoldDirs = []string{CollMemory, "tasks/active", "tasks/archive", CollDecisions, CollAttachments}

// Scope is the collection boundary: a Retriever built from a Scope can physically only read those
// collections (invariant 4). Attachments hold binaries and are not scanned into the node graph.
type Scope struct {
	Collections []string
}

func AllScope() Scope    { return Scope{Collections: []string{CollMemory, CollTasks, CollDecisions}} }
func WorkerScope() Scope { return Scope{Collections: []string{CollMemory, CollDecisions}} }

// Vault is a handle to one on-disk git-backed vault. machineFiles records, per absolute path, the
// content hash Jarvis last wrote — Commit uses it to author machine-only changes as Jarvis.
type Vault struct {
	Root         string
	mu           sync.Mutex
	machineFiles map[string]string
}

// DefaultVaultRoot resolves the vault path from config (jarvis:vaultpath) + home. Default
// ~/.waveterm/vault.
func DefaultVaultRoot() string {
	root := filepath.Join(wavebase.GetHomeDir(), defaultVaultSubpath)
	if cfg := wconfig.GetWatcher().GetFullConfig(); cfg.Settings.JarvisVaultPath != "" {
		root = wavebase.ExpandHomeDirSafe(cfg.Settings.JarvisVaultPath)
	}
	return root
}

// OpenVault opens (creating + git-initializing if needed) the configured vault.
func OpenVault(ctx context.Context) (*Vault, error) {
	return openVaultAt(ctx, DefaultVaultRoot())
}

// openVaultAt is the test seam: open a vault at an explicit root.
func openVaultAt(ctx context.Context, root string) (*Vault, error) {
	for _, d := range scaffoldDirs {
		if err := os.MkdirAll(filepath.Join(root, d), 0o755); err != nil {
			return nil, err
		}
	}
	v := &Vault{Root: root, machineFiles: map[string]string{}}
	if err := v.ensureGit(ctx); err != nil {
		return nil, err
	}
	return v, nil
}

// ensureGit git-inits the vault if it is not already a repo, and sets a fallback identity so
// human-authored commits never fail with "unknown identity". Idempotent.
func (v *Vault) ensureGit(ctx context.Context) error {
	if _, err := os.Stat(filepath.Join(v.Root, ".git")); err == nil {
		return nil // already a repo — leave its identity/config alone
	}
	if _, err := runGitErr(ctx, v.Root, "init", "-b", "main"); err != nil {
		return err
	}
	if out, _ := runGit(ctx, v.Root, "config", "user.email"); strings.TrimSpace(out) == "" {
		if _, err := runGitErr(ctx, v.Root, "config", "user.email", "user@waveterm.local"); err != nil {
			return err
		}
		if _, err := runGitErr(ctx, v.Root, "config", "user.name", "Wave User"); err != nil {
			return err
		}
	}
	return nil
}
```

- [ ] **Step 5: Run the test to confirm it passes**

Run: `go test ./pkg/wavevault/ -run 'TestOpenVault|TestScopes'`
Expected: PASS.

- [ ] **Step 6: Stage + checkpoint**

`git add pkg/wavevault/git.go pkg/wavevault/vault.go pkg/wavevault/vault_test.go` (do not commit).

---

### Task 5: In-memory graph + read API (`read.go`)

The scoped `Retriever` and the `Query` / `Search` / `Read` methods over a per-scope on-demand scan. Scope isolation is physical: a `Retriever` only walks its scope's directories.

**Files:**
- Create: `pkg/wavevault/read.go`, `pkg/wavevault/read_test.go`

**Interfaces:**
- Consumes: `parseNode` (Task 2), `Vault`/`Scope`/collection consts (Task 4).
- Produces: `Retriever`, `(*Vault).Retriever(scope)`, `Filter`, `Hit`, `NodeWithBody`, `Edge`, `(*Retriever).Query`, `(*Retriever).Search`, `(*Retriever).Read`. (`Expand` is Task 6.)

- [ ] **Step 1: Write the failing test**

Create `pkg/wavevault/read_test.go`:
```go
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
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `go test ./pkg/wavevault/ -run 'TestQuery|TestSearch|TestRead|TestWorkerScope'`
Expected: FAIL — `Retriever` / `Filter` / `Hit` etc. undefined.

- [ ] **Step 3: Implement `read.go`**

Create `pkg/wavevault/read.go`:
```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wavevault

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Filter is a structured frontmatter WHERE. FrontmatterEquals matches exact string values;
// HasLink matches nodes that [[link]] to the given id. Empty fields match everything.
type Filter struct {
	FrontmatterEquals map[string]string
	HasLink           string
}

// Hit is a full-text match: the node plus a short snippet around the first match.
type Hit struct {
	Node    Node
	Snippet string
}

// NodeWithBody is a node plus its verbatim post-frontmatter body.
type NodeWithBody struct {
	Node Node
	Body string
}

// Edge is a resolved wikilink (both endpoints exist in scope).
type Edge struct {
	From string
	To   string
}

// graph is the in-memory derived layer for one Retriever's scope: nodes by id (insertion order in
// `order`), their bodies, and resolved edges.
type graph struct {
	byID   map[string]Node
	bodies map[string]string
	order  []string
	edges  []Edge
}

// Retriever is a scope-limited read handle. It scans its scope's directories once on first use and
// reuses the result for its lifetime; a new logical operation uses a fresh Retriever (no
// process-wide cache, no invalidation machinery — matches memvault's re-scan model).
type Retriever struct {
	v      *Vault
	scope  Scope
	g      *graph
	loaded bool
}

func (v *Vault) Retriever(scope Scope) *Retriever {
	return &Retriever{v: v, scope: scope}
}

// load walks only the scope's collection directories — the physical collection boundary.
func (r *Retriever) load() error {
	if r.loaded {
		return nil
	}
	g := &graph{byID: map[string]Node{}, bodies: map[string]string{}}
	for _, coll := range r.scope.Collections {
		root := filepath.Join(r.v.Root, coll)
		_ = filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error {
			if err != nil || d.IsDir() || !strings.HasSuffix(d.Name(), ".md") {
				return nil
			}
			data, readErr := os.ReadFile(p)
			if readErr != nil {
				return nil // tolerant: skip unreadable files
			}
			n, body := parseNode(p, data)
			n.Collection = coll
			if info, statErr := d.Info(); statErr == nil {
				n.UpdatedTs = info.ModTime().UnixMilli()
			}
			if _, dup := g.byID[n.ID]; !dup {
				g.order = append(g.order, n.ID)
			}
			g.byID[n.ID] = n
			g.bodies[n.ID] = body
			return nil
		})
	}
	for _, id := range g.order {
		for _, l := range g.byID[id].Links {
			if _, ok := g.byID[l]; ok {
				g.edges = append(g.edges, Edge{From: id, To: l})
			}
		}
	}
	r.g = g
	r.loaded = true
	return nil
}

func (r *Retriever) Query(f Filter) ([]Node, error) {
	if err := r.load(); err != nil {
		return nil, err
	}
	var out []Node
	for _, id := range r.g.order {
		if matchesFilter(r.g.byID[id], f) {
			out = append(out, r.g.byID[id])
		}
	}
	return out, nil
}

func matchesFilter(n Node, f Filter) bool {
	for k, v := range f.FrontmatterEquals {
		if fmt.Sprintf("%v", n.Frontmatter[k]) != v {
			return false
		}
	}
	if f.HasLink != "" {
		found := false
		for _, l := range n.Links {
			if l == f.HasLink {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	return true
}

func (r *Retriever) Search(query string) ([]Hit, error) {
	if err := r.load(); err != nil {
		return nil, err
	}
	q := strings.ToLower(strings.TrimSpace(query))
	if q == "" {
		return nil, nil
	}
	var hits []Hit
	for _, id := range r.g.order {
		body := r.g.bodies[id]
		if idx := strings.Index(strings.ToLower(body), q); idx >= 0 {
			hits = append(hits, Hit{Node: r.g.byID[id], Snippet: snippet(body, idx, len(q))})
		}
	}
	return hits, nil
}

// snippet returns up to 40 chars of context on each side of a match.
func snippet(body string, idx, matchLen int) string {
	const pad = 40
	start := idx - pad
	if start < 0 {
		start = 0
	}
	end := idx + matchLen + pad
	if end > len(body) {
		end = len(body)
	}
	return strings.TrimSpace(body[start:end])
}

func (r *Retriever) Read(id string) (*NodeWithBody, error) {
	if err := r.load(); err != nil {
		return nil, err
	}
	n, ok := r.g.byID[id]
	if !ok {
		return nil, fmt.Errorf("wavevault: node %q not in scope", id)
	}
	return &NodeWithBody{Node: n, Body: r.g.bodies[id]}, nil
}
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `go test ./pkg/wavevault/ -run 'TestQuery|TestSearch|TestRead|TestWorkerScope'`
Expected: PASS.

- [ ] **Step 5: Stage + checkpoint**

`git add pkg/wavevault/read.go pkg/wavevault/read_test.go` (do not commit).

---

### Task 6: Wikilink neighborhood expansion (`Expand`)

The bounded breadth-first wikilink walk — A's traversal primitive (C drives the model seed/re-expand loop later). Depth- and fanout-bounded, dangling links skipped, dedup by id.

**Files:**
- Modify: `pkg/wavevault/read.go`
- Create test: add to `pkg/wavevault/read_test.go`

**Interfaces:**
- Consumes: the `graph`/`Retriever` (Task 5).
- Produces: `ExpandOpts{Depth, Fanout int}`, `Subgraph{Nodes []Node; Edges []Edge}`, `(*Retriever).Expand(seeds []string, opts ExpandOpts) (*Subgraph, error)`.

- [ ] **Step 1: Write the failing test**

Add to `pkg/wavevault/read_test.go`:
```go
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
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `go test ./pkg/wavevault/ -run TestExpand`
Expected: FAIL — `Expand` / `ExpandOpts` / `Subgraph` undefined.

- [ ] **Step 3: Implement `Expand`**

Append to `pkg/wavevault/read.go`:
```go
// ExpandOpts bounds the wikilink walk. Depth defaults to 1, Fanout to 8. (EdgeTypes — typed-edge
// filtering — is a D concern; v1 walks all [[links]].)
type ExpandOpts struct {
	Depth  int
	Fanout int
}

// Subgraph is the assembled neighborhood: the visited nodes and the edges walked. The set of edges
// is the citation material grounding consumes.
type Subgraph struct {
	Nodes []Node
	Edges []Edge
}

// Expand walks the wikilink graph breadth-first from seeds, bounded by Depth and Fanout, following
// only links whose target exists in scope (dangling links are skipped), deduping by id. A's
// deterministic traversal primitive; C drives the model seed-picking/re-expansion loop on top.
func (r *Retriever) Expand(seeds []string, opts ExpandOpts) (*Subgraph, error) {
	if err := r.load(); err != nil {
		return nil, err
	}
	if opts.Depth <= 0 {
		opts.Depth = 1
	}
	if opts.Fanout <= 0 {
		opts.Fanout = 8
	}
	visited := map[string]bool{}
	sg := &Subgraph{}
	type item struct {
		id    string
		depth int
	}
	var queue []item
	for _, s := range seeds {
		if _, ok := r.g.byID[s]; ok && !visited[s] {
			visited[s] = true
			sg.Nodes = append(sg.Nodes, r.g.byID[s])
			queue = append(queue, item{s, 0})
		}
	}
	for len(queue) > 0 {
		cur := queue[0]
		queue = queue[1:]
		if cur.depth >= opts.Depth {
			continue
		}
		count := 0
		for _, l := range r.g.byID[cur.id].Links {
			if count >= opts.Fanout {
				break
			}
			if _, ok := r.g.byID[l]; !ok {
				continue // dangling
			}
			sg.Edges = append(sg.Edges, Edge{From: cur.id, To: l})
			count++
			if !visited[l] {
				visited[l] = true
				sg.Nodes = append(sg.Nodes, r.g.byID[l])
				queue = append(queue, item{l, cur.depth + 1})
			}
		}
	}
	return sg, nil
}
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `go test ./pkg/wavevault/ -run TestExpand`
Expected: PASS.

- [ ] **Step 5: Stage + checkpoint**

`git add pkg/wavevault/read.go pkg/wavevault/read_test.go` (do not commit).

---

### Task 7: Region-aware write path (`write.go`)

`Write`: resolve the node, splice the machine-region edits, diff-validate against human regions, guard against a concurrent edit via `baseHash`, write, and record the machine hash for ownership-staged commits.

**Files:**
- Create: `pkg/wavevault/write.go`, `pkg/wavevault/write_test.go`

**Interfaces:**
- Consumes: `parseNode`/`ContentHash` (Task 2), `editsInSpec`/`spliceRegions`/`validateMachineOnly` (Task 3), `Vault` + collection consts (Task 4).
- Produces: `WriteResult{Hash string; Conflict bool; ConflictRegions []string}`, `(*Vault).Write(id string, spec RegionSpec, edits []RegionEdit, baseHash string) (*WriteResult, error)`.

- [ ] **Step 1: Write the failing test**

Create `pkg/wavevault/write_test.go`:
```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wavevault

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func writeVaultWithDossier(t *testing.T) (*Vault, string) {
	t.Helper()
	v, err := openVaultAt(context.Background(), t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	content := "---\nid: t-1\nstatus: draft\ntitle: Keep This\n---\n\n" +
		"Human prose.\n\n<!-- jarvis:begin state -->\nold\n<!-- jarvis:end state -->\n"
	p := filepath.Join(v.Root, "tasks/active/t-1.md")
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	return v, p
}

var wspec = RegionSpec{MachineKeys: []string{"status"}, Blocks: []string{"state"}}

func TestWriteSplicesMachineRegionsOnly(t *testing.T) {
	v, p := writeVaultWithDossier(t)
	base := ContentHash(mustRead(t, p))
	res, err := v.Write("t-1", wspec, []RegionEdit{
		{Kind: FrontmatterKey, Name: "status", Value: "active"},
		{Kind: Block, Name: "state", Value: "new state"},
	}, base)
	if err != nil {
		t.Fatalf("Write: %v", err)
	}
	if res.Conflict {
		t.Fatal("no concurrent edit — Conflict must be false")
	}
	got := string(mustRead(t, p))
	if !contains(got, "status: active") || !contains(got, "new state") {
		t.Fatalf("machine regions not written:\n%s", got)
	}
	if !contains(got, "title: Keep This") || !contains(got, "Human prose.") {
		t.Fatalf("human regions altered:\n%s", got)
	}
	if res.Hash != ContentHash([]byte(got)) {
		t.Fatal("WriteResult.Hash must equal the new content hash")
	}
}

func TestWriteRejectsNonMachineEdit(t *testing.T) {
	v, _ := writeVaultWithDossier(t)
	base := ContentHash(mustRead(t, filepath.Join(v.Root, "tasks/active/t-1.md")))
	_, err := v.Write("t-1", wspec, []RegionEdit{{Kind: FrontmatterKey, Name: "title", Value: "hijack"}}, base)
	if err == nil {
		t.Fatal("editing a human-owned key must be rejected")
	}
}

func TestWriteConflictWhenChangedUnderneath(t *testing.T) {
	v, p := writeVaultWithDossier(t)
	staleBase := "deadbeef" // not the real hash -> simulates an edit since the caller last read
	res, err := v.Write("t-1", wspec, []RegionEdit{{Kind: FrontmatterKey, Name: "status", Value: "active"}}, staleBase)
	if err != nil {
		t.Fatalf("conflict is not an error: %v", err)
	}
	if !res.Conflict {
		t.Fatal("a baseHash mismatch must report Conflict=true")
	}
	// nothing written — the file is untouched, human wins
	if contains(string(mustRead(t, p)), "status: active") {
		t.Fatal("a conflicting write must NOT modify the file")
	}
	if len(res.ConflictRegions) == 0 {
		t.Fatal("ConflictRegions should name the targeted machine regions")
	}
}

func TestWriteTracksMachineHash(t *testing.T) {
	v, p := writeVaultWithDossier(t)
	base := ContentHash(mustRead(t, p))
	res, err := v.Write("t-1", wspec, []RegionEdit{{Kind: FrontmatterKey, Name: "status", Value: "active"}}, base)
	if err != nil {
		t.Fatal(err)
	}
	v.mu.Lock()
	got, ok := v.machineFiles[p]
	v.mu.Unlock()
	if !ok || got != res.Hash {
		t.Fatalf("machineFiles[%s] = %q,%v; want %q", p, got, ok, res.Hash)
	}
}

func mustRead(t *testing.T, p string) []byte {
	t.Helper()
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	return b
}
func contains(s, sub string) bool { return len(s) >= len(sub) && (func() bool { return indexOf(s, sub) >= 0 })() }
func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `go test ./pkg/wavevault/ -run TestWrite`
Expected: FAIL — `(*Vault).Write` / `WriteResult` undefined.

- [ ] **Step 3: Implement `write.go`**

Create `pkg/wavevault/write.go`:
```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wavevault

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// WriteResult reports the outcome of a Write. On a baseHash mismatch Conflict is true, nothing is
// written (the human's on-disk version wins), and ConflictRegions names the machine regions the
// caller was trying to write — the caller re-reads (Hash is the current on-disk hash) and retries.
type WriteResult struct {
	Hash            string
	Conflict        bool
	ConflictRegions []string
}

// Write splices the machine-region edits into the node identified by id, rejecting any change to a
// human-owned region and guarding against a concurrent external edit via baseHash. It writes to the
// working tree (staged on disk, not committed — see Commit) and records the machine hash for
// ownership-staged commits. baseHash == "" skips the concurrency check (a first write).
func (v *Vault) Write(id string, spec RegionSpec, edits []RegionEdit, baseHash string) (*WriteResult, error) {
	if err := editsInSpec(spec, edits); err != nil {
		return nil, err
	}
	path, err := v.resolvePath(id)
	if err != nil {
		return nil, err
	}
	cur, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	curHash := ContentHash(cur)
	if baseHash != "" && curHash != baseHash {
		return &WriteResult{Hash: curHash, Conflict: true, ConflictRegions: regionNames(edits)}, nil
	}
	newContent, err := spliceRegions(string(cur), edits)
	if err != nil {
		return nil, err
	}
	if err := validateMachineOnly(string(cur), newContent, spec); err != nil {
		return nil, err
	}
	if err := os.WriteFile(path, []byte(newContent), 0o644); err != nil {
		return nil, err
	}
	newHash := ContentHash([]byte(newContent))
	v.mu.Lock()
	v.machineFiles[path] = newHash
	v.mu.Unlock()
	return &WriteResult{Hash: newHash}, nil
}

func regionNames(edits []RegionEdit) []string {
	out := make([]string, 0, len(edits))
	for _, e := range edits {
		out = append(out, e.Name)
	}
	return out
}

// resolvePath finds the file backing a node id by scanning the node collections (writes are coarse
// and rare, so a scan is acceptable; attachments are binaries and are not searched).
func (v *Vault) resolvePath(id string) (string, error) {
	var found string
	for _, coll := range []string{CollTasks, CollDecisions, CollMemory} {
		_ = filepath.WalkDir(filepath.Join(v.Root, coll), func(p string, d os.DirEntry, err error) error {
			if err != nil || d.IsDir() || !strings.HasSuffix(d.Name(), ".md") {
				return nil
			}
			data, readErr := os.ReadFile(p)
			if readErr != nil {
				return nil
			}
			n, _ := parseNode(p, data)
			if n.ID == id {
				found = p
				return filepath.SkipAll
			}
			return nil
		})
		if found != "" {
			break
		}
	}
	if found == "" {
		return "", fmt.Errorf("wavevault: node %q not found", id)
	}
	return found, nil
}
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `go test ./pkg/wavevault/ -run TestWrite`
Expected: PASS.

- [ ] **Step 5: Stage + checkpoint**

`git add pkg/wavevault/write.go pkg/wavevault/write_test.go` (do not commit).

---

### Task 8: Ownership-staged commits + safety flush (`commit.go`)

`Commit(label)` stages machine-authored changes (files A wrote whose on-disk hash is unchanged) as `Jarvis` and everything else as the user, in two commits. `Flush` is the idle/quit safety commit. This is the final task — the package now round-trips write → commit with correct authorship.

**Files:**
- Create: `pkg/wavevault/commit.go`, `pkg/wavevault/commit_test.go`

**Interfaces:**
- Consumes: `runGit`/`runGitErr` (Task 4), `Vault.machineFiles` + `ContentHash` (Tasks 2/4/7).
- Produces: `(*Vault).Commit(ctx, label string) error`, `(*Vault).Flush(ctx) error`.

- [ ] **Step 1: Write the failing test**

Create `pkg/wavevault/commit_test.go`:
```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wavevault

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// lastAuthor returns the author name of HEAD.
func lastAuthor(t *testing.T, root string) string {
	t.Helper()
	out, err := runGit(context.Background(), root, "log", "-1", "--format=%an")
	if err != nil {
		t.Fatalf("git log: %v", err)
	}
	return strings.TrimSpace(out)
}

func commitCount(t *testing.T, root string) int {
	t.Helper()
	out, err := runGit(context.Background(), root, "rev-list", "--count", "HEAD")
	if err != nil {
		return 0 // no commits yet (unborn HEAD)
	}
	n := 0
	for _, r := range strings.TrimSpace(out) {
		n = n*10 + int(r-'0')
	}
	return n
}

func TestCommitAuthorsMachineChangeAsJarvis(t *testing.T) {
	v, p := writeVaultWithDossier(t)
	base := ContentHash(mustRead(t, p))
	if _, err := v.Write("t-1", wspec, []RegionEdit{{Kind: FrontmatterKey, Name: "status", Value: "active"}}, base); err != nil {
		t.Fatal(err)
	}
	if err := v.Commit(context.Background(), "task t-1 started"); err != nil {
		t.Fatalf("Commit: %v", err)
	}
	if got := lastAuthor(t, v.Root); got != "Jarvis" {
		t.Fatalf("machine change author = %q, want Jarvis", got)
	}
	// tracking cleared after commit
	v.mu.Lock()
	n := len(v.machineFiles)
	v.mu.Unlock()
	if n != 0 {
		t.Fatalf("machineFiles not cleared after commit: %d", n)
	}
}

func TestCommitAuthorsHumanEditAsUser(t *testing.T) {
	v, _ := writeVaultWithDossier(t)
	// a purely human file (A never wrote it), created directly on disk
	hp := filepath.Join(v.Root, "memory", "human-note.md")
	if err := os.WriteFile(hp, []byte("---\nid: hn\n---\n\nhuman wrote this\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := v.Commit(context.Background(), "flush"); err != nil {
		t.Fatalf("Commit: %v", err)
	}
	if got := lastAuthor(t, v.Root); got != "Wave User" {
		t.Fatalf("human change author = %q, want Wave User", got)
	}
}

func TestCommitMixedFileGoesToUser(t *testing.T) {
	v, p := writeVaultWithDossier(t)
	base := ContentHash(mustRead(t, p))
	if _, err := v.Write("t-1", wspec, []RegionEdit{{Kind: FrontmatterKey, Name: "status", Value: "active"}}, base); err != nil {
		t.Fatal(err)
	}
	// a human then edits the SAME file externally (hash now differs from what A recorded)
	cur := mustRead(t, p)
	if err := os.WriteFile(p, append(cur, []byte("\nhuman appended line\n")...), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := v.Commit(context.Background(), "flush"); err != nil {
		t.Fatalf("Commit: %v", err)
	}
	// mixed file (A-written + human-touched) commits as the user, per the file-granular rule
	if got := lastAuthor(t, v.Root); got != "Wave User" {
		t.Fatalf("mixed-file author = %q, want Wave User", got)
	}
}

func TestFlushCommitsPending(t *testing.T) {
	v, p := writeVaultWithDossier(t)
	base := ContentHash(mustRead(t, p))
	if _, err := v.Write("t-1", wspec, []RegionEdit{{Kind: FrontmatterKey, Name: "status", Value: "active"}}, base); err != nil {
		t.Fatal(err)
	}
	before := commitCount(t, v.Root)
	if err := v.Flush(context.Background()); err != nil {
		t.Fatalf("Flush: %v", err)
	}
	if commitCount(t, v.Root) <= before {
		t.Fatal("Flush should have produced a commit for the pending write")
	}
}

func TestCommitNothingStagedIsNoop(t *testing.T) {
	v, _ := writeVaultWithDossier(t)
	// no writes; the seeded dossier is untracked, so a commit stages it as the user, then a second
	// commit with nothing pending must not error or add a commit.
	if err := v.Commit(context.Background(), "first"); err != nil {
		t.Fatal(err)
	}
	after := commitCount(t, v.Root)
	if err := v.Commit(context.Background(), "second-empty"); err != nil {
		t.Fatalf("empty commit must not error: %v", err)
	}
	if commitCount(t, v.Root) != after {
		t.Fatal("a commit with nothing staged must not create a commit")
	}
}
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `go test ./pkg/wavevault/ -run 'TestCommit|TestFlush'`
Expected: FAIL — `(*Vault).Commit` / `(*Vault).Flush` undefined.

- [ ] **Step 3: Implement `commit.go`**

Create `pkg/wavevault/commit.go`:
```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wavevault

import (
	"context"
	"os"
)

const (
	jarvisName  = "Jarvis"
	jarvisEmail = "jarvis@wave.local"
)

// Commit stages by ownership and produces up to two commits: files Jarvis wrote whose on-disk hash
// is unchanged since it wrote them, authored as Jarvis; then everything else (human/external edits,
// and any Jarvis-written file a human later touched — hash differs), authored under the vault's own
// git identity. Consumers call this at task lifecycle boundaries (label = the boundary); the label
// is the commit message.
func (v *Vault) Commit(ctx context.Context, label string) error {
	v.mu.Lock()
	tracked := make(map[string]string, len(v.machineFiles))
	for p, h := range v.machineFiles {
		tracked[p] = h
	}
	v.mu.Unlock()

	var machinePaths []string
	for p, h := range tracked {
		cur, err := os.ReadFile(p)
		if err != nil {
			continue // deleted / unreadable — let `add -A` handle it in the user commit
		}
		if ContentHash(cur) == h {
			machinePaths = append(machinePaths, p) // unchanged since A wrote it -> Jarvis
		}
	}

	// 1) Jarvis commit: stage only the unchanged machine files.
	if len(machinePaths) > 0 {
		args := append([]string{"add", "--"}, machinePaths...)
		if _, err := runGitErr(ctx, v.Root, args...); err != nil {
			return err
		}
		if v.hasStaged(ctx) {
			if _, err := runGitErr(ctx, v.Root,
				"-c", "user.name="+jarvisName, "-c", "user.email="+jarvisEmail,
				"commit", "-m", label); err != nil {
				return err
			}
		}
	}

	// 2) User commit: stage everything remaining (human edits, external changes, mixed files).
	if _, err := runGitErr(ctx, v.Root, "add", "-A"); err != nil {
		return err
	}
	if v.hasStaged(ctx) {
		if _, err := runGitErr(ctx, v.Root, "commit", "-m", label); err != nil {
			return err
		}
	}

	v.mu.Lock()
	for p := range tracked {
		delete(v.machineFiles, p)
	}
	v.mu.Unlock()
	return nil
}

// hasStaged reports whether there are staged changes. `git diff --cached --quiet` exits 0 with none,
// nonzero with some.
func (v *Vault) hasStaged(ctx context.Context) bool {
	_, err := runGit(ctx, v.Root, "diff", "--cached", "--quiet")
	return err != nil
}

// Flush is the idle/quit safety commit: it commits any pending staged work under a clearly-labelled
// safety message so a crash or a missed boundary never loses writes. Wired to an idle debounce and
// the wavesrv quit hook by the caller; in the common case a consumer already committed at the
// boundary and this is a no-op.
func (v *Vault) Flush(ctx context.Context) error {
	return v.Commit(ctx, "Jarvis: safety flush")
}
```

- [ ] **Step 4: Run the full package test suite**

Run: `go test ./pkg/wavevault/`
Expected: PASS (all tasks' tests green together).

- [ ] **Step 5: Vet + build the whole tree**

Run: `go build ./...` then `go vet ./pkg/wavevault/`
Expected: exit 0 for both.

- [ ] **Step 6: Stage + checkpoint**

`git add pkg/wavevault/commit.go pkg/wavevault/commit_test.go` (do not commit).

---

## Final: feature commit (after human approval)

Do **not** run this without explicit approval. When approved, fold everything into A's single feature commit: the `pkg/wavevault/*` sources + tests, the `pkg/wconfig` + regenerated schema/types (Task 1), the spec (`docs/superpowers/specs/2026-07-23-jarvis-a-wave-vault-design.md`), this plan, and the `docs/deferred.md` coexist entry. Add the meta-spec tracking-table A-row (`docs/superpowers/specs/2026-07-23-jarvis-second-brain-meta-spec.md`) linking the spec + plan **as part of this commit** (not a separate docs edit). No co-author.

Suggested message subject: `feat(jarvis): Wave Vault foundation — git-backed vault + read/write APIs (sub-project A)`.

## Self-Review

Checked against the spec:

**Spec coverage:**
- §1 vault layout/bootstrap/collection boundary → Task 4 (scaffold + `git init` + fallback identity) + Task 5 (`Scope`/`Retriever` physical boundary). ✓
- §2 lossless parse → Task 2. ✓ (Byte-exact untouched regions are guaranteed by the write path's raw-text splice in Task 3, not by map re-serialization — a deliberate, documented mechanism.)
- §3 read API (Query/Search/Expand/Read) → Tasks 5 + 6. ✓
- §4 derived layer (in-memory, rebuildable) → Task 5's per-Retriever scan (refined from "process-cached" to scan-on-demand, documented above). ✓
- §5 write path (region splice + diff-validate + conflict) → Tasks 3 + 7. ✓ (Conflict = memvault-style no-write guard, documented refinement.)
- §6 commit machinery + cadence → Task 8 (`Commit` ownership staging by hash + `Flush`); the idle-debounce/quit timer is implemented as `Flush`'s caller-wired trigger — tested via `Flush`/`Commit` directly (wall-clock timers are not unit-tested; noted). ✓
- §7 error handling → covered across tasks (not-a-repo/init surfaced in Task 4; diff-validation rejection in Tasks 3/7; conflict-not-an-error in Task 7; empty-commit no-op in Task 8). ✓
- §1 config key → Task 1. ✓

**Placeholder scan:** no TBD/TODO; every code step shows complete code; every command has expected output.

**Type consistency:** `Node`, `RegionSpec`/`RegionEdit`/`RegionKind`, `Scope`/`Retriever`, `Filter`/`Hit`/`NodeWithBody`/`Edge`/`ExpandOpts`/`Subgraph`, `WriteResult`, and `(*Vault).Write`/`Commit`/`Flush` signatures match across the Interfaces summary and every task that uses them. `machineFiles` (map[string]string, path→hash) is written in Task 7 and read in Task 8 identically.

**One partial-coverage note (not a gap):** spec §5's `ConflictRegions` is populated with the *targeted* machine-region names on a conflict (a re-read-and-retry hint), not a computed diff of which region the human changed — the documented simpler-branch conflict semantics. The "never silently clobbered" guarantee holds (a conflict writes nothing).
