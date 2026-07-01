# Memory Sync — Phase B (Codex harvest) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harvest Codex's curated `Reusable knowledge` facts into the focused project's Claude memory hub — deduped, source-tagged, reversible — and trigger it passively (on agent launch, chained before projection, plus a low-frequency background timer on the Memory surface).

**Architecture:** A pure Codex-`MEMORY.md` parser extracts `## Reusable knowledge` bullets from Task-Group blocks whose `applies_to: cwd=` matches the target project, strips `[Task N]` markers, content-hashes each bullet, and writes new ones into `HubDirForCwd(cwd)` as `source: codex` notes. A single `MemoryHarvestCommand(cwd)` RPC returns `{ingested, skipped}`. Phase A's launch hook is extended to chain harvest→project; the Memory-surface sync strip gains a status readout, a manual "Pull from agents" button, and a ~3-minute cadence timer. An mtime guard on `MEMORY.md` makes frequent calls free.

**Tech Stack:** Go (`pkg/memvault`, `pkg/wshrpc`), the wshrpc codegen pipeline (`task generate`), React 19 + jotai + Tailwind 4 frontend. Go tests via `go test`; frontend via `vitest`.

**Prerequisite:** **Phase A must be merged first.** This plan depends on Phase A's `pkg/memvault/projection.go` (`HubDirForCwd`, `projectHash`, `registryProjects`, `Project`, `MemoryProjectCommand`), the `frontend/app/view/agents/syncstrip.tsx` component, the `focusedCwd` state in `memorysurface.tsx`, and the `projectLabel` TS helper. If Phase A is not present, stop and merge it before starting.

**Context from the spec** (`docs/superpowers/specs/2026-07-01-memory-sync-phase-b-codex-harvest-design.md`):
- **Harvest unit:** each `- ` bullet under `## Reusable knowledge` in `MEMORY.md` → one hub note. `raw_memories.md` and the sqlite stores are NOT parsed.
- **Skip behavioral sections:** `## User preferences` and `## Failures…` are excluded (facts, not directives).
- **Per-focused-project:** only bullets whose Task-Group `cwd` maps to the focused project are harvested, into that project's hub.
- **Dedup:** `sha256` of the normalized bullet; skip if that hash already exists among the hub's notes (ingest-once).
- **Provenance:** `source: codex`, `source_hash`, `harvested_at` frontmatter → bulk-reversible.
- **Must-fix seam:** `parseNote` must read `metadata.source`/`metadata.source_hash` and let a frontmatter `source` override the root-derived source — this is what makes Phase A's echo rule fire AND gives dedup its existing-hash set.
- **agy harvest is OUT of scope** (Phase C).

**Key existing code (read before starting):**
- `pkg/memvault/memvault.go` — `Note` (line 23), `frontmatter` (line 45), `parseNote` (line 61), `ScanVault`, `slugify` (line 282). Phase B extends `frontmatter`/`Note`/`parseNote` and adds a sibling file `pkg/memvault/harvest.go`.
- `pkg/memvault/projection.go` (Phase A) — `HubDirForCwd(cwd)`, `projectHash(cwd)`, `registryProjects()`. Reused by `harvest.go` (same package, unexported access).
- `pkg/wshrpc/wshrpctypes.go:101-105` (Memory command interface) and `:729-785` (Memory types).
- `pkg/wshrpc/wshserver/wshserver.go:1558-1571` (`MemoryCreateCommand` / `MemoryDeleteCommand` — add the harvest handler after these).
- `frontend/app/view/agents/memstore.ts` (`createNote`, `loadMemory`) — add `harvestMemory`.
- `frontend/app/view/agents/syncstrip.tsx` (Phase A) — extend with harvest status + button + cadence.
- `frontend/app/cockpit/cockpit-actions.ts:46-58` (`launchAgent`) — Phase A inserts a `MemoryProjectCommand` block between the two `SetMetaCommand` calls; Phase B replaces it with a chained harvest→project block.

**Codegen note:** After editing `pkg/wshrpc/wshrpctypes.go` or adding a `WshServer` method, run `task generate` to regenerate `pkg/wshrpc/wshclient/wshclient.go`, `frontend/app/store/wshclientapi.ts`, and `frontend/types/gotypes.d.ts`. **Never hand-edit those three files.**

**Typecheck note:** `npx tsc` stack-overflows on this repo. Use:
`node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (baseline has ~3 pre-existing errors in `frontend/tauri/api.test.ts`).

---

## File structure

**Created:**
- `pkg/memvault/harvest.go` — Codex harvest core: cwd normalizer, `applies_to` cwd extractor, bullet cleaner, `parseCodexReusable` (pure parser), `factHash` (dedup key), `harvestSlug`, `existingHashes` (hub scan), `writeHarvestedNote`, `harvestInto` (state-free orchestrator), `Harvest(cwd)` (real-path + mtime-guard wrapper).
- `pkg/memvault/harvest_test.go` — unit tests for the pure helpers + a temp-dir `harvestInto` integration test.

**Modified:**
- `pkg/memvault/memvault.go` — extend `frontmatter` (`metadata.source`, `metadata.source_hash`); add `SourceHash` to `Note`; `parseNote` lets frontmatter `source` override the root source and captures `source_hash`.
- `pkg/memvault/memvault_test.go` — test the `parseNote` source/hash override.
- `pkg/wshrpc/wshrpctypes.go` — add `MemoryHarvestCommand` to the interface + `CommandMemoryHarvestData`/`CommandMemoryHarvestRtnData`.
- `pkg/wshrpc/wshserver/wshserver.go` — implement `MemoryHarvestCommand`.
- `frontend/app/view/agents/memstore.ts` — add `harvestMemory(cwd)`.
- `frontend/app/cockpit/cockpit-actions.ts` — chain harvest→project on launch (replace Phase A's projection-only block).
- `frontend/app/view/agents/syncstrip.tsx` — harvest status + "Pull from agents" button + cadence timer.

---

## Task 1: `parseNote` reads frontmatter source/hash (Go) — the Phase A↔B seam

`parseNote` currently sets `Source` from the root tag only. Harvested hub notes carry `metadata.source: codex` and `metadata.source_hash`; those must override the root-derived source and be surfaced on the `Note` so the echo rule fires and dedup can read existing hashes.

**Files:**
- Modify: `pkg/memvault/memvault.go` (`Note` ~line 23, `frontmatter` ~line 45, `parseNote` ~line 61)
- Modify: `pkg/memvault/memvault_test.go`

- [ ] **Step 1: Write the failing test**

Append to `pkg/memvault/memvault_test.go`:

```go
func TestParseNoteFrontmatterSourceOverride(t *testing.T) {
	// A note physically in the claude hub (root source "claude") but tagged source: codex
	// must report Source "codex" and expose its source_hash.
	data := []byte("---\nname: from-codex\ndescription: a codex fact\nmetadata:\n  type: reference\n  source: codex\n  source_hash: abc123\n---\n\nUse Postgres.\n")
	n, body := parseNote("/home/k/.claude/projects/x/memory/from-codex.md", data, "claude")
	if n.Source != "codex" {
		t.Fatalf("Source = %q, want codex (frontmatter overrides root)", n.Source)
	}
	if n.SourceHash != "abc123" {
		t.Fatalf("SourceHash = %q, want abc123", n.SourceHash)
	}
	if strings.TrimSpace(body) != "Use Postgres." {
		t.Fatalf("body = %q", body)
	}
	// A note with no frontmatter source keeps the root-derived source.
	plain := []byte("---\nname: plain\nmetadata:\n  type: project\n---\n\nx\n")
	p, _ := parseNote("/vault/plain.md", plain, "vault")
	if p.Source != "vault" {
		t.Fatalf("plain Source = %q, want vault", p.Source)
	}
	if p.SourceHash != "" {
		t.Fatalf("plain SourceHash = %q, want empty", p.SourceHash)
	}
}
```

If `memvault_test.go` does not already import `strings`, add it to that file's import block.

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./pkg/memvault/ -run TestParseNoteFrontmatterSourceOverride -v`
Expected: FAIL — `n.SourceHash` undefined (or Source == "claude").

- [ ] **Step 3: Write minimal implementation**

In `pkg/memvault/memvault.go`, add a field to the `Note` struct (after `Source` ~line 29):

```go
	Source      string   `json:"source"`     // "vault" | "claude" | "codex" (frontmatter overrides root)
	SourceHash  string   `json:"sourcehash"` // metadata.source_hash for harvested notes (dedup key)
```

Extend the `frontmatter` struct's `Metadata` (~line 48):

```go
	Metadata    struct {
		Type       string `yaml:"type"`
		Scope      string `yaml:"scope"`
		Source     string `yaml:"source"`
		SourceHash string `yaml:"source_hash"`
	} `yaml:"metadata"`
```

In `parseNote`, inside the `if err := yaml.Unmarshal(...)` block (after `n.Scope = fm.Metadata.Scope`, ~line 74), add:

```go
			n.SourceHash = fm.Metadata.SourceHash
			if fm.Metadata.Source != "" {
				n.Source = fm.Metadata.Source // frontmatter provenance overrides the root tag
			}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./pkg/memvault/ -run TestParseNoteFrontmatterSourceOverride -v`
Expected: PASS.

- [ ] **Step 5: Run the full memvault suite (no regressions)**

Run: `go test ./pkg/memvault/ -v`
Expected: PASS (all existing + Phase A tests still green).

- [ ] **Step 6: Commit**

```bash
git add pkg/memvault/memvault.go pkg/memvault/memvault_test.go
git commit -m "feat(memvault): parseNote honors frontmatter source/source_hash"
```

---

## Task 2: Codex `MEMORY.md` parser (Go, pure)

The parser walks `MEMORY.md`, tracks each `# Task Group:` block's `applies_to: cwd=`, and collects `## Reusable knowledge` bullets from blocks whose cwd matches the target — cleaning trailing `[Task N]` markers. Behavioral sections are skipped by construction (only `## Reusable knowledge` activates collection).

**Files:**
- Create: `pkg/memvault/harvest.go`
- Create: `pkg/memvault/harvest_test.go`

- [ ] **Step 1: Write the failing test**

Create `pkg/memvault/harvest_test.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package memvault

import (
	"strings"
	"testing"
)

const sampleMemoryMD = "# Task Group: auth boundary\n" +
	"scope: use for auth\n" +
	"applies_to: cwd=C:\\Users\\k\\IdeaProjects\\krypton; reuse_rule=safe\n" +
	"\n" +
	"## Task 1: do the thing, outcome success\n" +
	"### keywords\n- JWT\n" +
	"\n" +
	"## User preferences\n- when the user said X -> do Y [Task 1]\n" +
	"\n" +
	"## Reusable knowledge\n" +
	"- `src/main.py` is the auth-wiring seam [Task 1][Task 2]\n" +
	"- python-jose is required in the container\n" +
	"\n" +
	"## Failures and how to do differently\n- retried too late\n" +
	"\n" +
	"# Task Group: other project\n" +
	"applies_to: cwd=C:\\Users\\k\\IdeaProjects\\other; reuse_rule=safe\n" +
	"\n" +
	"## Reusable knowledge\n- unrelated fact for other\n"

func TestNormalizeCwd(t *testing.T) {
	cases := map[string]string{
		`\\?\C:\Users\k\krypton`: "c:/users/k/krypton",
		`C:\Users\k\krypton\`:    "c:/users/k/krypton",
		`/home/k/code/foo/`:      "/home/k/code/foo",
	}
	for in, want := range cases {
		if got := normalizeCwd(in); got != want {
			t.Fatalf("normalizeCwd(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestExtractCwd(t *testing.T) {
	line := `applies_to: cwd=C:\Users\k\krypton; reuse_rule=safe`
	if got := extractCwd(line); got != `C:\Users\k\krypton` {
		t.Fatalf("extractCwd = %q", got)
	}
	if got := extractCwd("scope: no cwd here"); got != "" {
		t.Fatalf("extractCwd(no cwd) = %q, want empty", got)
	}
}

func TestCleanBullet(t *testing.T) {
	if got := cleanBullet("- a fact [Task 1][Task 2]"); got != "a fact" {
		t.Fatalf("cleanBullet = %q", got)
	}
	if got := cleanBullet("-   spaced fact  "); got != "spaced fact" {
		t.Fatalf("cleanBullet spaced = %q", got)
	}
}

func TestParseCodexReusable(t *testing.T) {
	got := parseCodexReusable(sampleMemoryMD, `C:\Users\k\IdeaProjects\krypton`)
	want := []string{"`src/main.py` is the auth-wiring seam", "python-jose is required in the container"}
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("parseCodexReusable = %#v, want %#v", got, want)
	}
	// non-matching cwd -> no bullets
	if g := parseCodexReusable(sampleMemoryMD, `C:\Users\k\IdeaProjects\nope`); len(g) != 0 {
		t.Fatalf("expected no bullets for unmatched cwd, got %#v", g)
	}
	// the OTHER project's cwd -> only its bullet, never krypton's
	other := parseCodexReusable(sampleMemoryMD, `C:\Users\k\IdeaProjects\other`)
	if len(other) != 1 || other[0] != "unrelated fact for other" {
		t.Fatalf("other cwd bullets = %#v", other)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./pkg/memvault/ -run 'TestNormalizeCwd|TestExtractCwd|TestCleanBullet|TestParseCodexReusable' -v`
Expected: FAIL — `undefined: normalizeCwd` (etc.).

- [ ] **Step 3: Write minimal implementation**

Create `pkg/memvault/harvest.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Harvest extracts Codex's curated "Reusable knowledge" facts (from ~/.codex/memories/MEMORY.md)
// into the focused project's Claude memory hub — deduped by content hash, tagged source: codex,
// bulk-reversible. Pure helpers are unit-tested; Harvest() wires real paths + an mtime guard.
// See docs/superpowers/specs/2026-07-01-memory-sync-phase-b-codex-harvest-design.md.
package memvault

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/wavetermdev/waveterm/pkg/wavebase"
)

// normalizeCwd makes two cwd strings comparable: strip a Windows \\?\ long-path prefix, unify
// separators to /, drop a trailing separator, and case-fold. Codex records some cwds as \\?\C:\...
func normalizeCwd(p string) string {
	p = strings.TrimPrefix(p, `\\?\`)
	p = strings.ReplaceAll(p, `\`, "/")
	p = strings.TrimRight(p, "/")
	return strings.ToLower(p)
}

// extractCwd pulls the path out of a Codex `applies_to: cwd=<path>; reuse_rule=...` line.
func extractCwd(line string) string {
	i := strings.Index(line, "cwd=")
	if i < 0 {
		return ""
	}
	rest := line[i+len("cwd="):]
	if j := strings.Index(rest, ";"); j >= 0 {
		rest = rest[:j]
	}
	return strings.TrimSpace(rest)
}

var taskRefRe = regexp.MustCompile(`(\s*\[Task[^\]]*\])+\s*$`)

// cleanBullet strips the leading "- " and any trailing [Task N]… back-reference markers.
func cleanBullet(line string) string {
	s := strings.TrimSpace(line)
	s = strings.TrimPrefix(s, "- ")
	s = strings.TrimSpace(s)
	s = taskRefRe.ReplaceAllString(s, "")
	return strings.TrimSpace(s)
}

// parseCodexReusable returns the cleaned "## Reusable knowledge" bullets from every Task-Group
// block whose applies_to cwd matches targetCwd. User preferences / Failures sections are ignored.
func parseCodexReusable(md, targetCwd string) []string {
	target := normalizeCwd(targetCwd)
	var out []string
	matched := false
	inReusable := false
	for _, line := range strings.Split(md, "\n") {
		trimmed := strings.TrimSpace(line)
		switch {
		case strings.HasPrefix(line, "# Task Group:"):
			matched = false
			inReusable = false
		case strings.HasPrefix(trimmed, "applies_to:"):
			if cwd := extractCwd(trimmed); cwd != "" {
				matched = normalizeCwd(cwd) == target
			}
		case strings.HasPrefix(line, "## "):
			inReusable = matched && strings.HasPrefix(line, "## Reusable knowledge")
		case strings.HasPrefix(line, "# "):
			matched = false
			inReusable = false
		case inReusable && strings.HasPrefix(trimmed, "- "):
			if fact := cleanBullet(trimmed); fact != "" {
				out = append(out, fact)
			}
		}
	}
	return out
}
```

Note: `crypto/sha256`, `encoding/hex`, `fmt`, `os`, `filepath`, `sync`, `time`, and `wavebase` are imported now because Tasks 3–5 add code that uses them; if `go vet`/build complains about unused imports before Task 3, temporarily reference them or proceed directly to Task 3 (they are all used by the end of Task 5). To keep the build green after this task alone, add Tasks 3–5's functions in the same working session, or comment the not-yet-used imports until Task 3.

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./pkg/memvault/ -run 'TestNormalizeCwd|TestExtractCwd|TestCleanBullet|TestParseCodexReusable' -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add pkg/memvault/harvest.go pkg/memvault/harvest_test.go
git commit -m "feat(memvault): Codex MEMORY.md reusable-knowledge parser"
```

---

## Task 3: Dedup hash + harvest slug (Go, pure)

**Files:**
- Modify: `pkg/memvault/harvest.go`
- Modify: `pkg/memvault/harvest_test.go`

- [ ] **Step 1: Write the failing test**

Append to `pkg/memvault/harvest_test.go`:

```go
func TestFactHash(t *testing.T) {
	// whitespace-normalized: differing internal spacing hashes the same
	a := factHash("use   postgres  not sqlite")
	b := factHash("use postgres not sqlite")
	if a != b {
		t.Fatalf("whitespace should normalize: %s != %s", a, b)
	}
	if factHash("different fact") == a {
		t.Fatalf("distinct content must hash differently")
	}
	if len(a) != 64 {
		t.Fatalf("sha256 hex length = %d, want 64", len(a))
	}
}

func TestHarvestSlug(t *testing.T) {
	slug := harvestSlug("`src/main.py` is the auth-wiring seam for the repo really", "abcdef0123456789")
	// first ~8 words slugified, plus an 8-char hash suffix
	if !strings.HasPrefix(slug, "src-main-py-is-the-auth-wiring-seam") {
		t.Fatalf("slug prefix wrong: %q", slug)
	}
	if !strings.HasSuffix(slug, "-abcdef01") {
		t.Fatalf("slug hash suffix wrong: %q", slug)
	}
	// empty bullet still yields a usable slug
	if s := harvestSlug("", "abcdef0123456789"); s != "codex-fact-abcdef01" {
		t.Fatalf("empty-bullet slug = %q", s)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./pkg/memvault/ -run 'TestFactHash|TestHarvestSlug' -v`
Expected: FAIL — `undefined: factHash` / `harvestSlug`.

- [ ] **Step 3: Write minimal implementation**

Append to `pkg/memvault/harvest.go`:

```go
// factHash is the ingest-once dedup key: sha256 of the whitespace-normalized bullet.
func factHash(body string) string {
	norm := strings.Join(strings.Fields(body), " ")
	sum := sha256.Sum256([]byte(norm))
	return hex.EncodeToString(sum[:])
}

// harvestSlug builds a readable, collision-proof note filename stem: the bullet's first ~8 words
// slugified, plus the first 8 hex chars of its hash.
func harvestSlug(bullet, hash string) string {
	words := strings.Fields(bullet)
	if len(words) > 8 {
		words = words[:8]
	}
	base := slugify(strings.Join(words, " ")) // slugify lives in memvault.go
	if base == "" {
		base = "codex-fact"
	}
	short := hash
	if len(short) > 8 {
		short = short[:8]
	}
	return base + "-" + short
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./pkg/memvault/ -run 'TestFactHash|TestHarvestSlug' -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add pkg/memvault/harvest.go pkg/memvault/harvest_test.go
git commit -m "feat(memvault): harvest content-hash + slug helpers"
```

---

## Task 4: Note writer + `harvestInto` + `existingHashes` (Go, temp-dir integration)

`harvestInto` is the state-free core: parse → dedup against the hub's existing `source_hash` set → write new facts as provenance-tagged notes. Covered by a temp-dir test (touches the filesystem but no global state or real home dir).

**Files:**
- Modify: `pkg/memvault/harvest.go`
- Modify: `pkg/memvault/harvest_test.go`

- [ ] **Step 1: Write the failing test**

Append to `pkg/memvault/harvest_test.go` (add `"os"`, `"path/filepath"` to the test import block):

```go
func TestHarvestIntoDedupes(t *testing.T) {
	tmp := t.TempDir()
	hub := filepath.Join(tmp, "hub")

	ing, skip, err := harvestInto(sampleMemoryMD, `C:\Users\k\IdeaProjects\krypton`, hub)
	if err != nil {
		t.Fatalf("harvestInto: %v", err)
	}
	if ing != 2 || skip != 0 {
		t.Fatalf("first harvest ingested=%d skipped=%d, want 2/0", ing, skip)
	}
	// two notes written, each with codex provenance the scanner can read back
	files, _ := os.ReadDir(hub)
	if len(files) != 2 {
		t.Fatalf("wrote %d files, want 2", len(files))
	}
	one := filepath.Join(hub, files[0].Name())
	data, _ := os.ReadFile(one)
	if !strings.Contains(string(data), "source: codex") || !strings.Contains(string(data), "source_hash:") {
		t.Fatalf("note missing provenance:\n%s", data)
	}
	n, _ := parseNote(one, data, "claude")
	if n.Source != "codex" {
		t.Fatalf("written note Source = %q, want codex", n.Source)
	}

	// second harvest of the same content ingests nothing (all hashes already present)
	ing2, skip2, err := harvestInto(sampleMemoryMD, `C:\Users\k\IdeaProjects\krypton`, hub)
	if err != nil {
		t.Fatalf("second harvestInto: %v", err)
	}
	if ing2 != 0 || skip2 != 2 {
		t.Fatalf("second harvest ingested=%d skipped=%d, want 0/2", ing2, skip2)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./pkg/memvault/ -run TestHarvestIntoDedupes -v`
Expected: FAIL — `undefined: harvestInto`.

- [ ] **Step 3: Write minimal implementation**

Append to `pkg/memvault/harvest.go`:

```go
// existingHashes scans hubDir for notes carrying a source_hash, returning the set already ingested.
func existingHashes(hubDir string) map[string]bool {
	out := map[string]bool{}
	entries, err := os.ReadDir(hubDir)
	if err != nil {
		return out
	}
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".md") {
			continue
		}
		p := filepath.Join(hubDir, e.Name())
		data, readErr := os.ReadFile(p)
		if readErr != nil {
			continue
		}
		if n, _ := parseNote(p, data, "claude"); n.SourceHash != "" {
			out[n.SourceHash] = true
		}
	}
	return out
}

// yamlQuote makes an arbitrary single-line string safe as a double-quoted YAML scalar.
func yamlQuote(s string) string {
	s = strings.ReplaceAll(s, `\`, `\\`)
	s = strings.ReplaceAll(s, `"`, `\"`)
	return `"` + s + `"`
}

// writeHarvestedNote writes one bullet into hubDir as a source: codex note with provenance
// frontmatter. Skips silently if a same-slug file already exists (near-impossible; slug carries the
// hash). Returns whether a file was written.
func writeHarvestedNote(hubDir, bullet, hash string) (bool, error) {
	if err := os.MkdirAll(hubDir, 0o755); err != nil {
		return false, err
	}
	slug := harvestSlug(bullet, hash)
	path := filepath.Join(hubDir, slug+".md")
	if _, err := os.Stat(path); err == nil {
		return false, nil // already present (slug collision) — do not overwrite
	}
	var b strings.Builder
	b.WriteString("---\n")
	b.WriteString("name: " + slug + "\n")
	b.WriteString("description: " + yamlQuote(bullet) + "\n")
	b.WriteString("metadata:\n")
	b.WriteString("  type: reference\n")
	b.WriteString("  source: codex\n")
	b.WriteString("  source_hash: " + hash + "\n")
	b.WriteString("  harvested_at: " + time.Now().UTC().Format(time.RFC3339) + "\n")
	b.WriteString("---\n\n")
	b.WriteString(bullet + "\n")
	if err := os.WriteFile(path, []byte(b.String()), 0o644); err != nil {
		return false, err
	}
	return true, nil
}

// harvestInto parses codex memory content for cwd's facts, dedups against hubDir, and writes the
// new ones. State-free (no global mtime cache, no real-path lookups) so it is fully testable.
func harvestInto(memoryMD, cwd, hubDir string) (ingested, skipped int, err error) {
	bullets := parseCodexReusable(memoryMD, cwd)
	existing := existingHashes(hubDir)
	for _, bullet := range bullets {
		h := factHash(bullet)
		if existing[h] {
			skipped++
			continue
		}
		wrote, werr := writeHarvestedNote(hubDir, bullet, h)
		if werr != nil {
			return ingested, skipped, fmt.Errorf("writing harvested note: %w", werr)
		}
		existing[h] = true // guard against duplicate bullets within the same file
		if wrote {
			ingested++
		} else {
			skipped++
		}
	}
	return ingested, skipped, nil
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./pkg/memvault/ -run TestHarvestIntoDedupes -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add pkg/memvault/harvest.go pkg/memvault/harvest_test.go
git commit -m "feat(memvault): dedup-aware harvest writer (harvestInto)"
```

---

## Task 5: `Harvest(cwd)` — real-path wiring + mtime guard (Go)

`Harvest` locates the real `MEMORY.md`, short-circuits on an unchanged mtime (per project), and delegates to `harvestInto`. Process-local `lastHarvestMtime` keyed by `projectHash(cwd)` — a wavesrv restart just re-harvests once (safe, idempotent).

**Files:**
- Modify: `pkg/memvault/harvest.go`
- Modify: `pkg/memvault/harvest_test.go`

- [ ] **Step 1: Write the failing test**

Append to `pkg/memvault/harvest_test.go`:

```go
func TestCodexMemoryPath(t *testing.T) {
	p := codexMemoryPath()
	if !strings.HasSuffix(filepath.ToSlash(p), ".codex/memories/MEMORY.md") {
		t.Fatalf("codexMemoryPath = %q", p)
	}
}

func TestHarvestEmptyCwd(t *testing.T) {
	if _, _, err := Harvest(""); err == nil {
		t.Fatalf("Harvest(\"\") must error")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./pkg/memvault/ -run 'TestCodexMemoryPath|TestHarvestEmptyCwd' -v`
Expected: FAIL — `undefined: codexMemoryPath` / `Harvest`.

- [ ] **Step 3: Write minimal implementation**

Append to `pkg/memvault/harvest.go`:

```go
// codexMemoryPath is Codex's curated global memory file.
func codexMemoryPath() string {
	return filepath.Join(wavebase.GetHomeDir(), ".codex", "memories", "MEMORY.md")
}

var (
	lastHarvestMu    sync.Mutex
	lastHarvestMtime = map[string]int64{} // projectHash(cwd) -> MEMORY.md mtime at last harvest
)

// Harvest ingests cwd's Codex reusable-knowledge facts into that project's Claude hub. Returns
// (ingested, skipped). Missing MEMORY.md is a no-op, not an error. An unchanged MEMORY.md mtime
// since this project's last harvest short-circuits before parsing (cheap frequent calls). Public
// entry point for the MemoryHarvestCommand RPC (launch hook, cadence timer, manual button).
func Harvest(cwd string) (int, int, error) {
	if cwd == "" {
		return 0, 0, fmt.Errorf("cwd is required")
	}
	info, err := os.Stat(codexMemoryPath())
	if err != nil {
		return 0, 0, nil // no Codex memory file -> nothing to harvest
	}
	key := projectHash(cwd)
	mtime := info.ModTime().UnixMilli()
	lastHarvestMu.Lock()
	last, seen := lastHarvestMtime[key]
	lastHarvestMu.Unlock()
	if seen && last == mtime {
		return 0, 0, nil // unchanged since last harvest for this project
	}
	data, err := os.ReadFile(codexMemoryPath())
	if err != nil {
		return 0, 0, fmt.Errorf("reading codex memory: %w", err)
	}
	ingested, skipped, err := harvestInto(string(data), cwd, HubDirForCwd(cwd))
	if err != nil {
		return ingested, skipped, err
	}
	lastHarvestMu.Lock()
	lastHarvestMtime[key] = mtime
	lastHarvestMu.Unlock()
	return ingested, skipped, nil
}
```

- [ ] **Step 4: Run test to verify it passes + full package build**

Run: `go test ./pkg/memvault/ -v && go build ./pkg/memvault/`
Expected: PASS; no unused-import errors (all of `crypto/sha256`, `encoding/hex`, `fmt`, `os`, `filepath`, `regexp`, `strings`, `sync`, `time`, `wavebase` are now used).

- [ ] **Step 5: Commit**

```bash
git add pkg/memvault/harvest.go pkg/memvault/harvest_test.go
git commit -m "feat(memvault): Harvest(cwd) with per-project mtime guard"
```

---

## Task 6: `MemoryHarvestCommand` RPC (wshrpc)

**Files:**
- Modify: `pkg/wshrpc/wshrpctypes.go` (interface ~line 105; types near `:783`)
- Modify: `pkg/wshrpc/wshserver/wshserver.go` (after `MemoryDeleteCommand`, ~line 1571)
- Regenerated (do not hand-edit): `wshclient.go`, `wshclientapi.ts`, `gotypes.d.ts`

- [ ] **Step 1: Add the interface method**

In `pkg/wshrpc/wshrpctypes.go`, add to the command interface right after `MemoryDeleteCommand` (~line 105):

```go
	MemoryHarvestCommand(ctx context.Context, data CommandMemoryHarvestData) (*CommandMemoryHarvestRtnData, error)
```

- [ ] **Step 2: Add the data types**

In `pkg/wshrpc/wshrpctypes.go`, after `CommandMemoryDeleteData` (~line 785):

```go
type CommandMemoryHarvestData struct {
	Cwd string `json:"cwd"`
}

type CommandMemoryHarvestRtnData struct {
	Ingested int `json:"ingested"`
	Skipped  int `json:"skipped"`
}
```

- [ ] **Step 3: Implement the server handler**

In `pkg/wshrpc/wshserver/wshserver.go`, add after `MemoryDeleteCommand` (~line 1571):

```go
func (ws *WshServer) MemoryHarvestCommand(ctx context.Context, data wshrpc.CommandMemoryHarvestData) (*wshrpc.CommandMemoryHarvestRtnData, error) {
	ingested, skipped, err := memvault.Harvest(data.Cwd)
	if err != nil {
		return nil, fmt.Errorf("harvesting memory: %w", err)
	}
	return &wshrpc.CommandMemoryHarvestRtnData{Ingested: ingested, Skipped: skipped}, nil
}
```

- [ ] **Step 4: Regenerate bindings and build**

Run: `task generate && go build ./...`
Expected: no errors; `git status` shows regenerated `wshclient.go`, `wshclientapi.ts`, `gotypes.d.ts` alongside your edits.

- [ ] **Step 5: Verify the client binding typechecks**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: only the ~3 pre-existing `frontend/tauri/api.test.ts` baseline errors (confirms `RpcApi.MemoryHarvestCommand` exists and typechecks).

- [ ] **Step 6: Commit**

```bash
git add pkg/wshrpc/wshrpctypes.go pkg/wshrpc/wshserver/wshserver.go \
  pkg/wshrpc/wshclient/wshclient.go frontend/app/store/wshclientapi.ts frontend/types/gotypes.d.ts
git commit -m "feat(wshrpc): MemoryHarvest command"
```

---

## Task 7: `harvestMemory` frontend loader (TS)

Thin loader over the RPC that reloads the memory graph only when something new was ingested (the mtime-guarded no-op case must not churn the list).

**Files:**
- Modify: `frontend/app/view/agents/memstore.ts` (after `createNote`, ~line 77)

- [ ] **Step 1: Add the loader**

In `frontend/app/view/agents/memstore.ts`, append after `createNote`:

```ts
// Harvest Codex's reusable-knowledge facts for a project into its Claude hub. Reloads the graph only
// when new facts landed (the mtime-guarded no-op case returns 0/0 and must not trigger a rescan).
export async function harvestMemory(cwd: string): Promise<{ ingested: number; skipped: number }> {
    const r = await RpcApi.MemoryHarvestCommand(TabRpcClient, { cwd });
    const ingested = r.ingested ?? 0;
    const skipped = r.skipped ?? 0;
    if (ingested > 0) {
        await loadMemory();
    }
    return { ingested, skipped };
}
```

- [ ] **Step 2: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: only the ~3 baseline `api.test.ts` errors.

- [ ] **Step 3: Commit**

```bash
git add frontend/app/view/agents/memstore.ts
git commit -m "feat(agents): harvestMemory loader"
```

---

## Task 8: Chain harvest → project on launch (TS)

Phase A's launch hook fires `MemoryProjectCommand` for codex/antigravity launches. Phase B replaces that with a chained **harvest → project** so a freshly-harvested Codex fact flows outward in the same launch. The chain is one fire-and-forget wrapper; each step is independently `.catch`-guarded so a harvest failure never blocks projection or the launch.

**Files:**
- Modify: `frontend/app/cockpit/cockpit-actions.ts` (the Phase A projection block, between the two `SetMetaCommand` calls)

- [ ] **Step 1: Replace the Phase A projection block**

In `frontend/app/cockpit/cockpit-actions.ts`, locate the Phase A block inserted after the block-meta `SetMetaCommand` (it looks like this):

```ts
    if (opts.runtime === "codex" || opts.runtime === "antigravity") {
        void RpcApi.MemoryProjectCommand(TabRpcClient, { cwd }).catch(() => {});
    }
```

Replace it with the chained harvest → project version:

```ts
    // Sync the shared brain at launch: pull the launch project's Codex facts into the Claude hub,
    // THEN project the (now-updated) hub into the lackey steering files so the agent boots with the
    // current brain and any just-harvested facts also reach the other lackeys. One fire-and-forget
    // chain — never blocks the launch; each step is independently guarded. Terminals have no memory
    // and claude IS the hub, so neither is synced here.
    if (opts.runtime === "codex" || opts.runtime === "antigravity") {
        void (async () => {
            try {
                await RpcApi.MemoryHarvestCommand(TabRpcClient, { cwd });
            } catch {
                // harvest failure must not prevent projection
            }
            try {
                await RpcApi.MemoryProjectCommand(TabRpcClient, { cwd });
            } catch {
                // projection failure must not block the launch
            }
        })();
    }
```

(`cwd`, `RpcApi`, and `TabRpcClient` are already in scope in this file.)

- [ ] **Step 2: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: only the ~3 baseline `api.test.ts` errors.

- [ ] **Step 3: Commit**

```bash
git add frontend/app/cockpit/cockpit-actions.ts
git commit -m "feat(cockpit): chain Codex harvest before projection on launch"
```

---

## Task 9: Sync strip — harvest status + "Pull from agents" + cadence (TS)

Extend Phase A's `SyncStrip` (which already takes `focusedCwd`, shows projection status, and has a "Project now" button) with: a harvest status readout, a "Pull from agents" button that harvests the focused project, and a ~3-minute cadence timer that harvests the focused project while the Memory surface is mounted. The cadence is safe to run often because the backend mtime-guards `MEMORY.md`.

**Files:**
- Modify: `frontend/app/view/agents/syncstrip.tsx`

> **Read `syncstrip.tsx` at execution time** — it was authored in Phase A. Integrate the additions below into the existing component (keep its projection status + "Project now" button). The code blocks are complete; only their placement adapts to the Phase A layout.

- [ ] **Step 1: Add imports, cadence constant, and harvest state**

At the top of `frontend/app/view/agents/syncstrip.tsx`, add to the existing imports:

```tsx
import { harvestMemory } from "./memstore";
```

Above the `SyncStrip` component, add the cadence constant:

```tsx
// Codex rewrites MEMORY.md rarely (on session summarization); a low-frequency sweep with the
// backend mtime-guard means most ticks are no-ops. Frontend-hosted so it can scope to focusedCwd.
const HARVEST_CADENCE_MS = 3 * 60 * 1000;
```

Inside the `SyncStrip` component body (alongside the Phase A `status`/`busy` state), add harvest state:

```tsx
    const [harvest, setHarvest] = useState<{ ingested: number; skipped: number } | null>(null);
    const [pulling, setPulling] = useState(false);
```

- [ ] **Step 2: Add the harvest runner + cadence effect**

Inside the component body (after the Phase A `refresh`/`projectNow` definitions), add:

```tsx
    const pullNow = useCallback(
        (manual: boolean) => {
            if (!focusedCwd) return;
            if (manual) setPulling(true);
            fireAndForget(async () => {
                try {
                    const r = await harvestMemory(focusedCwd);
                    setHarvest(r);
                } finally {
                    if (manual) setPulling(false);
                }
            });
        },
        [focusedCwd]
    );

    // Cadence: harvest the focused project on mount and every HARVEST_CADENCE_MS while mounted.
    useEffect(() => {
        if (!focusedCwd) return;
        pullNow(false);
        const id = setInterval(() => pullNow(false), HARVEST_CADENCE_MS);
        return () => clearInterval(id);
    }, [focusedCwd, pullNow]);
```

Ensure `fireAndForget` is imported (Phase A already imports it from `@/util/util`) and `useCallback`/`useEffect`/`useState` are imported from `react`.

- [ ] **Step 3: Render the harvest status + button**

In the strip's returned JSX, after the Phase A projection status spans and before (or beside) the "Project now" button, add a harvest readout and a "Pull from agents" button:

```tsx
            {harvest ? (
                <span className="flex items-center gap-[6px] text-ink-mid">
                    <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-ink-faint">
                        Harvest
                    </span>
                    <span className="text-accent-soft">
                        +{harvest.ingested} new · {harvest.skipped} known
                    </span>
                </span>
            ) : null}
            <button
                onClick={() => pullNow(true)}
                disabled={!focusedCwd || pulling}
                title={focusedCwd ? "Pull Codex facts into this project's memory" : "Focus an agent to pull its Codex facts"}
                className="rounded-[7px] border border-border px-[11px] py-[5px] text-[11.5px] font-semibold text-ink-mid hover:text-foreground disabled:opacity-40"
            >
                {pulling ? "Pulling…" : "Pull from agents"}
            </button>
```

- [ ] **Step 4: Typecheck + tests**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: only the ~3 baseline `api.test.ts` errors.

Run: `npx vitest run frontend/app/view/agents/`
Expected: PASS (existing memory/agents tests still green).

- [ ] **Step 5: Commit**

```bash
git add frontend/app/view/agents/syncstrip.tsx
git commit -m "feat(agents): sync strip harvest status, Pull button, cadence"
```

---

## Task 10: Full-suite gate + manual verification

**Files:** none (verification only)

- [ ] **Step 1: Go tests**

Run: `go test ./pkg/memvault/ ./pkg/wshrpc/...`
Expected: PASS.

- [ ] **Step 2: Frontend tests**

Run: `npx vitest run`
Expected: PASS (baseline count; 1 known preview flake is acceptable).

- [ ] **Step 3: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: only the ~3 baseline `frontend/tauri/api.test.ts` errors.

- [ ] **Step 4: Backend build**

Run: `task build:backend`
Expected: builds `wavesrv` + `wsh` into `dist/bin/` with no errors.

- [ ] **Step 5: Live manual check (dev app + CDP)**

Per CLAUDE.md "Visual verification": run the dev app (`tail -f /dev/null | task dev` — see the stdin-EOF gotcha). In a project that has Codex `Reusable knowledge` facts under a matching `cwd` in `~/.codex/memories/MEMORY.md`:
- Launch a Codex agent in that project. Confirm new `source: codex` notes appear under `~/.claude/projects/<hash>/memory/` (readable slug + hash suffix, provenance frontmatter), and that they show in the Memory surface list/graph with the `codex` source tag.
- Confirm the launched agent's `~/.codex/AGENTS.md` (or `~/.gemini/GEMINI.md`) projection region now includes those harvested facts — but the harvested `source: codex` notes do NOT appear back in Codex's own steering region (echo rule), while they DO appear in agy's.
- Open the Memory surface: the Sync strip shows a harvest readout (`+N new · M known`); clicking "Pull from agents" re-runs and reports counts. Launch again with no new Codex memory → `+0 new` (mtime guard / dedup no-op).

This is a manual gate; note the result in the PR/summary. (Consistent with prior surfaces, automated gates are green before this check.)

---

## Self-Review

**1. Spec coverage:**
- Harvest unit = `Reusable knowledge` bullets from `MEMORY.md` → Task 2 (`parseCodexReusable`). ✅
- Skip `User preferences`/`Failures` → Task 2 (only `## Reusable knowledge` activates collection; verified in `TestParseCodexReusable`). ✅
- Per-focused-project scoping via cwd match + `HubDirForCwd` → Tasks 2 (cwd filter), 5 (`Harvest` → `HubDirForCwd`). ✅
- cwd normalization (`\\?\`, slashes, case) → Task 2 (`normalizeCwd`, verified). ✅
- Strip `[Task N]` markers → Task 2 (`cleanBullet`, verified). ✅
- Content-hash ingest-once dedup → Tasks 3 (`factHash`), 4 (`existingHashes`/`harvestInto`, verified re-harvest = 0 ingested). ✅
- Provenance frontmatter (`source`/`source_hash`/`harvested_at`, type reference) → Task 4 (`writeHarvestedNote`). ✅
- Must-fix `parseNote` source/hash override → Task 1 (verified). ✅
- Single `MemoryHarvestCommand` RPC returning `{ingested, skipped}` → Task 6. ✅
- On-launch harvest → project (chained, fire-and-forget) → Task 8. ✅
- ~3-min frontend cadence + mtime guard → Task 9 (cadence) + Task 5 (`Harvest` mtime guard). ✅
- Manual "Pull from agents" button + status → Task 9. ✅
- agy harvest OUT of scope → not planned. ✅
- Echo rule now fires for harvested notes → Task 1 makes `Note.Source == "codex"`; Phase A's `renderFacts` exclusion consumes it (verified live in Task 10). ✅

**2. Placeholder scan:** No TBD/TODO. Every code step shows complete code. The one execution-time dependency is Task 9's "integrate into the Phase A `SyncStrip`" — flagged explicitly because `syncstrip.tsx`'s Phase-A JSX/state names must be read on disk; the added code blocks are complete, only placement adapts. Task 8 similarly shows the exact Phase A block to locate and its full replacement.

**3. Type consistency:**
- Go: `Harvest(cwd) (int,int,error)`, `harvestInto(memoryMD,cwd,hubDir) (int,int,error)`, `parseCodexReusable(md,targetCwd) []string`, `normalizeCwd`, `extractCwd`, `cleanBullet`, `factHash(body) string`, `harvestSlug(bullet,hash) string`, `existingHashes(hubDir) map[string]bool`, `writeHarvestedNote(hubDir,bullet,hash) (bool,error)`, `codexMemoryPath() string` — names consistent across Tasks 2–5.
- Reused from Phase A (same package): `HubDirForCwd`, `projectHash`; from `memvault.go`: `slugify`, `parseNote`, `Note`, `frontmatter`. `Note.SourceHash` added in Task 1 and read by `existingHashes` (Task 4). ✅
- wshrpc: `CommandMemoryHarvestData{Cwd}` / `CommandMemoryHarvestRtnData{Ingested,Skipped}` consistent between type defs (Task 6) and the server handler (Task 6). ✅
- TS: `harvestMemory(cwd) → {ingested,skipped}` consistent between `memstore.ts` (Task 7), `cockpit-actions.ts` (Task 8 calls the RPC directly), and `syncstrip.tsx` (Task 9). Generated client `RpcApi.MemoryHarvestCommand({cwd})` matches the Task 6 codegen. ✅

**Runtime-string consistency note:** the launch guard and echo rule use `"codex"` and `"antigravity"` (matching Phase A and the `Runtime` union in `launch.ts`). Harvested notes are tagged `source: codex`, which matches the echo-rule runtime string so a Codex-harvested note is correctly withheld from Codex's own projection.

**Known limitation (documented, out of scope):** a launch with a worktree branch sets `cwd` to the worktree path, which won't match Codex memories tagged with the main-repo path; harvest for worktree launches may find nothing. Acceptable for v1 (matches Phase A's use of the post-worktree `cwd`); global fan-out / cwd-family matching is a future enhancement.
