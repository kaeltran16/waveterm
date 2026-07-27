# Jarvis J6 — Memory Root Unification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Wave Vault's `memory/` collection the single durable-knowledge registry, and federate the agent-native memory directories into it as read-only mirrors, so Jarvis recall/embeddings/attribution actually traverse the ~363 notes they are blind to today.

**Architecture:** A new leaf package `pkg/memroots` owns every answer to "where does durable knowledge live" — vault root, memory root, external mirror roots, project-label and scope derivation, and the one-shot legacy-root migration. `pkg/memvault` and `pkg/wavevault` both import it and neither imports the other. `wavevault.Retriever.load()` additionally walks the mirrors when its scope includes `CollMemory`, tagging nodes with `Source`/`Scope`; mirrors are read-only by construction because `resolvePath` and `Commit` are `v.Root`-scoped.

**Tech Stack:** Go 1.x, standard library only (`os`, `path/filepath`, `strings`, `sync`), `gopkg.in/yaml.v3` (already vendored). Existing internal deps: `pkg/wavebase` (home dir), `pkg/wconfig` (settings + Projects registry).

**Spec:** [`docs/superpowers/specs/2026-07-27-jarvis-j6-memory-root-unification-design.md`](../specs/2026-07-27-jarvis-j6-memory-root-unification-design.md)

## Global Constraints

- **Never `git add -A` or `git add .`** — the working tree contains another session's uncommitted work (`frontend/app/view/agents/ambientcard.tsx`, plus modifications to `pkg/consult/`, `pkg/tasksharpen/`, `pkg/jarvis/`, `pkg/jarvisproactive/`, and several `frontend/app/view/agents/*.tsx`). Stage only the exact paths each task names.
- **One commit at the end, and only with explicit user approval.** The user's git rules say batch into a single commit and never commit without approval. Tasks therefore end with a *stage* step, not a commit. The single commit is Task 8, gated on the user saying yes. The spec and this plan fold into that same commit — never a docs-only commit.
- **Do not hand-edit generated files.** No `task generate` run is needed in this plan: `wavevault.Node` is not an RPC type (it is mapped to `wshrpc.GraphNode` by `vaultNodeToGraphNode`).
- **Comments are for "why", never "what". Lower case. Only when necessary.** Match the surrounding files.
- **Copyright header on every new Go file**, matching existing files verbatim:
  ```go
  // Copyright 2026, Command Line Inc.
  // SPDX-License-Identifier: Apache-2.0
  ```
- **Source tag vocabulary is exactly** `"vault"`, `"claude"`, `"codex"`.
- **Test commands:** single package `go test ./pkg/memroots/ -v`; single test `go test ./pkg/memroots/ -run TestMirrorsComposition -v`; full regression `go test ./pkg/...`.
- **Pure-core + wrapper pattern** for anything touching `wavebase.GetHomeDir()` or `wconfig`: a pure function taking explicit paths (unit-tested) plus a thin exported wrapper that resolves home/config (not unit-tested). This is the existing convention — see `memvault.buildRoots` vs `memvault.VaultRoots`.

---

### Task 1: `pkg/memroots` — the root registry

**Files:**
- Create: `pkg/memroots/memroots.go`
- Create: `pkg/memroots/memroots_test.go`

**Interfaces:**
- Consumes: nothing (leaf package; only `wavebase`, `wconfig`, stdlib).
- Produces:
  ```go
  type Mirror struct { Path, Source string }
  const IndexFile = "MEMORY.md"
  func VaultRoot() string
  func MemoryRoot() string
  func LegacyRoot() string
  func Mirrors() []Mirror                    // externals only
  func AllRoots() []Mirror                   // MemoryRoot tagged "vault", then Mirrors()
  func ProjectHash(cwd string) string
  func RegistryProjects() map[string]string
  func LabelFromHash(hash string, projects map[string]string) string
  func ScopeForHubDir(hubDir string) string
  func ScopeForPath(rootPath, source, filePath string) string
  ```

- [ ] **Step 1: Write the failing tests**

Create `pkg/memroots/memroots_test.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package memroots

import (
	"path/filepath"
	"reflect"
	"testing"
)

func TestBuildMirrorsExternalsOnly(t *testing.T) {
	got := buildMirrors("/home/u", "")
	want := []Mirror{
		{Path: filepath.Join("/home/u", ".claude", "projects"), Source: "claude"},
		{Path: filepath.Join("/home/u", ".codex", "memories"), Source: "codex"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("buildMirrors = %v, want %v", got, want)
	}
}

func TestBuildMirrorsKeepsCustomLegacyRoot(t *testing.T) {
	got := buildMirrors("/home/u", "/custom/notes")
	if len(got) != 3 {
		t.Fatalf("len = %d, want 3: %v", len(got), got)
	}
	last := got[len(got)-1]
	if last.Path != "/custom/notes" || last.Source != "vault" {
		t.Fatalf("custom legacy mirror = %+v, want {/custom/notes vault}", last)
	}
}

func TestBuildAllRootsPutsMemoryRootFirst(t *testing.T) {
	got := buildAllRoots("/home/u/.waveterm/vault/memory", buildMirrors("/home/u", ""))
	var sources []string
	for _, m := range got {
		sources = append(sources, m.Source)
	}
	want := []string{"vault", "claude", "codex"}
	if !reflect.DeepEqual(sources, want) {
		t.Fatalf("sources = %v, want %v", sources, want)
	}
	if got[0].Path != "/home/u/.waveterm/vault/memory" {
		t.Fatalf("memory root = %q", got[0].Path)
	}
}

func TestProjectHash(t *testing.T) {
	if got := ProjectHash(`C:\Users\kael02\IdeaProjects\waveterm`); got != "C--Users-kael02-IdeaProjects-waveterm" {
		t.Fatalf("ProjectHash(win) = %q", got)
	}
	if got := ProjectHash("/home/k/code/krypton"); got != "-home-k-code-krypton" {
		t.Fatalf("ProjectHash(posix) = %q", got)
	}
}

func TestLabelFromHash(t *testing.T) {
	projects := map[string]string{"Krypton API": `C:\Users\kael02\IdeaProjects\krypton`}
	if l := LabelFromHash("C--Users-kael02-IdeaProjects-krypton", projects); l != "Krypton API" {
		t.Fatalf("registry hit = %q, want Krypton API", l)
	}
	if l := LabelFromHash("C--Users-kael02-IdeaProjects-waveterm", projects); l != "waveterm" {
		t.Fatalf("fallback = %q, want waveterm", l)
	}
}

func TestScopeForPath(t *testing.T) {
	hubRoot := filepath.Join("/home/k", ".claude", "projects")
	notePath := filepath.Join(hubRoot, "C--Users-kael02-IdeaProjects-krypton", "memory", "n.md")
	if got := ScopeForPath(hubRoot, "claude", notePath); got != "krypton" {
		t.Fatalf("claude hub scope = %q, want krypton", got)
	}
	if got := ScopeForPath("/vault", "vault", "/vault/teamx/note.md"); got != "teamx" {
		t.Fatalf("subdir scope = %q, want teamx", got)
	}
	if got := ScopeForPath("/vault", "vault", "/vault/note.md"); got != "shared" {
		t.Fatalf("flat scope = %q, want shared", got)
	}
}

func TestIndexFileConst(t *testing.T) {
	if IndexFile != "MEMORY.md" {
		t.Fatalf("IndexFile = %q", IndexFile)
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./pkg/memroots/ -v`
Expected: FAIL — the package does not compile (`undefined: buildMirrors`, `undefined: Mirror`, etc.).

- [ ] **Step 3: Write the implementation**

Create `pkg/memroots/memroots.go`. `ProjectHash`, `LabelFromHash` and `RegistryProjects` are moved verbatim from `pkg/memvault/projection.go:22-57,175-184` (exported); `ScopeForPath` is `memvault.deriveScope`'s body (`pkg/memvault/memvault.go:177-193`) with the root passed explicitly.

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Package memroots is the single registry of durable-knowledge locations: the Wave Vault root, its
// memory collection (the one write target), the external agent-native memory dirs federated in as
// read-only mirrors, and the project-label/scope derivation both scanners share. Leaf package —
// pkg/memvault and pkg/wavevault both import it, neither imports the other.
package memroots

import (
	"path/filepath"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/wconfig"
)

// Mirror is one scan location and its provenance tag.
type Mirror struct {
	Path   string
	Source string // "vault" | "claude" | "codex"
}

// IndexFile is a per-hub table of contents, not knowledge — every scanner skips it. Its copies also
// carry no frontmatter name, so all of them would collide on the id "MEMORY".
const IndexFile = "MEMORY.md"

const (
	vaultSubpath  = ".waveterm/vault"
	legacySubpath = ".waveterm/memory"
	memoryColl    = "memory"
)

// VaultRoot resolves the Wave Vault root from config (jarvis:vaultpath) + home.
func VaultRoot() string {
	root := filepath.Join(wavebase.GetHomeDir(), vaultSubpath)
	if cfg := wconfig.GetWatcher().GetFullConfig(); cfg.Settings.JarvisVaultPath != "" {
		root = wavebase.ExpandHomeDirSafe(cfg.Settings.JarvisVaultPath)
	}
	return root
}

// MemoryRoot is the vault's memory collection — the single write target for durable notes.
func MemoryRoot() string {
	return filepath.Join(VaultRoot(), memoryColl)
}

// LegacyRoot is the pre-unification memory root that MigrateLegacyRoot retires.
func LegacyRoot() string {
	return filepath.Join(wavebase.GetHomeDir(), legacySubpath)
}

// customLegacyRoot is a memory:vaultpath override, or "" when unset/default. A user-chosen directory
// is never migrated — it stays a mirror and is read in place.
func customLegacyRoot() string {
	cfg := wconfig.GetWatcher().GetFullConfig()
	if cfg.Settings.MemoryVaultPath == "" {
		return ""
	}
	p := wavebase.ExpandHomeDirSafe(cfg.Settings.MemoryVaultPath)
	if filepath.Clean(p) == filepath.Clean(LegacyRoot()) {
		return "" // the default location; the migrator handles it
	}
	return p
}

// buildMirrors is the pure core of Mirrors: the external, read-only roots.
func buildMirrors(home, customLegacy string) []Mirror {
	out := []Mirror{
		{Path: filepath.Join(home, ".claude", "projects"), Source: "claude"},
		{Path: filepath.Join(home, ".codex", "memories"), Source: "codex"},
	}
	if customLegacy != "" {
		out = append(out, Mirror{Path: customLegacy, Source: "vault"})
	}
	return out
}

// Mirrors are the external roots federated into the memory collection. Excludes MemoryRoot so the
// vault's own walk of <root>/memory is not duplicated.
func Mirrors() []Mirror {
	return buildMirrors(wavebase.GetHomeDir(), customLegacyRoot())
}

func buildAllRoots(memoryRoot string, mirrors []Mirror) []Mirror {
	return append([]Mirror{{Path: memoryRoot, Source: "vault"}}, mirrors...)
}

// AllRoots is every durable-knowledge root, the vault's own memory collection first (it wins id
// conflicts). This is memvault's scan-root view.
func AllRoots() []Mirror {
	return buildAllRoots(MemoryRoot(), Mirrors())
}

// ProjectHash encodes a cwd the way Claude Code names its per-project dir: every path separator
// (both \ and /) and colon becomes '-'. e.g. C:\Users\k\p -> C--Users-k-p.
func ProjectHash(cwd string) string {
	r := strings.NewReplacer(`\`, "-", "/", "-", ":", "-")
	return r.Replace(cwd)
}

// RegistryProjects reads the Projects registry (name -> path) from live config.
func RegistryProjects() map[string]string {
	out := map[string]string{}
	cfg := wconfig.GetWatcher().GetFullConfig()
	for name, pk := range cfg.Projects {
		if pk.Path != "" {
			out[name] = pk.Path
		}
	}
	return out
}

// LabelFromHash resolves a readable label from an encoded hash dir name (reverse of ProjectHash,
// which is lossy). Tries a registry match by re-encoding each registered path; falls back to the
// last '-'-delimited segment (the leaf folder in the common case).
func LabelFromHash(hash string, projects map[string]string) string {
	for name, p := range projects {
		if ProjectHash(filepath.Clean(p)) == hash {
			return name
		}
	}
	parts := strings.Split(strings.TrimRight(hash, "-"), "-")
	if len(parts) == 0 {
		return hash
	}
	return parts[len(parts)-1]
}

// ScopeForHubDir labels a Claude per-project hub dir against the live Projects registry.
func ScopeForHubDir(hubDir string) string {
	return LabelFromHash(hubDir, RegistryProjects())
}

// ScopeForPath derives a note's cluster: the first path segment below rootPath (a Claude hub dir is
// label-resolved), else "shared" for a note sitting directly in the root.
func ScopeForPath(rootPath, source, filePath string) string {
	rel, err := filepath.Rel(rootPath, filePath)
	if err != nil {
		return "shared"
	}
	dir := filepath.Dir(rel)
	if dir == "." || dir == "" {
		return "shared"
	}
	first := strings.Split(filepath.ToSlash(dir), "/")[0]
	if source == "claude" {
		return ScopeForHubDir(first)
	}
	return first
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./pkg/memroots/ -v`
Expected: PASS — all 7 tests.

- [ ] **Step 5: Stage (do not commit)**

```bash
git add pkg/memroots/memroots.go pkg/memroots/memroots_test.go
```

---

### Task 2: `memroots` — legacy-root migration

**Files:**
- Create: `pkg/memroots/migrate.go`
- Create: `pkg/memroots/migrate_test.go`

**Interfaces:**
- Consumes: `LegacyRoot()`, `MemoryRoot()` from Task 1.
- Produces: `func MigrateLegacyRoot() (moved int, skipped []string, err error)` and its pure core `func migrateRoot(src, dst string) (int, []string, error)`. `MigrateLegacyRoot` is plainly idempotent — callable any number of times; the caller in Task 5 guards it with `sync.Once` only to avoid concurrent duplicate work.

- [ ] **Step 1: Write the failing tests**

Create `pkg/memroots/migrate_test.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package memroots

import (
	"os"
	"path/filepath"
	"testing"
)

func writeFile(t *testing.T, dir, name, body string) string {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestMigrateRootMovesNotesAndRemovesSource(t *testing.T) {
	base := t.TempDir()
	src := filepath.Join(base, "memory")
	dst := filepath.Join(base, "vault", "memory")
	writeFile(t, src, "one.md", "# one")
	writeFile(t, src, "two.md", "# two")

	moved, skipped, err := migrateRoot(src, dst)
	if err != nil {
		t.Fatalf("migrateRoot: %v", err)
	}
	if moved != 2 || len(skipped) != 0 {
		t.Fatalf("moved=%d skipped=%v, want 2 and none", moved, skipped)
	}
	for _, n := range []string{"one.md", "two.md"} {
		if _, err := os.Stat(filepath.Join(dst, n)); err != nil {
			t.Fatalf("%s not at destination: %v", n, err)
		}
	}
	if _, err := os.Stat(src); !os.IsNotExist(err) {
		t.Fatalf("source dir survived: %v", err)
	}
}

func TestMigrateRootSkipsCollisionWithoutOverwriting(t *testing.T) {
	base := t.TempDir()
	src := filepath.Join(base, "memory")
	dst := filepath.Join(base, "vault", "memory")
	writeFile(t, src, "dup.md", "SOURCE")
	writeFile(t, dst, "dup.md", "DESTINATION")

	moved, skipped, err := migrateRoot(src, dst)
	if err != nil {
		t.Fatalf("migrateRoot: %v", err)
	}
	if moved != 0 || len(skipped) != 1 {
		t.Fatalf("moved=%d skipped=%v, want 0 and 1", moved, skipped)
	}
	got, err := os.ReadFile(filepath.Join(dst, "dup.md"))
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "DESTINATION" {
		t.Fatalf("destination overwritten: %q", got)
	}
	// a skipped file stays put, so the source dir must survive
	if _, err := os.Stat(filepath.Join(src, "dup.md")); err != nil {
		t.Fatalf("skipped source removed: %v", err)
	}
}

func TestMigrateRootAbsentSourceIsNoop(t *testing.T) {
	base := t.TempDir()
	moved, skipped, err := migrateRoot(filepath.Join(base, "nope"), filepath.Join(base, "dst"))
	if err != nil || moved != 0 || len(skipped) != 0 {
		t.Fatalf("moved=%d skipped=%v err=%v, want zero-values", moved, skipped, err)
	}
}

func TestMigrateRootSecondRunIsNoop(t *testing.T) {
	base := t.TempDir()
	src := filepath.Join(base, "memory")
	dst := filepath.Join(base, "vault", "memory")
	writeFile(t, src, "one.md", "# one")

	if _, _, err := migrateRoot(src, dst); err != nil {
		t.Fatalf("first run: %v", err)
	}
	moved, skipped, err := migrateRoot(src, dst)
	if err != nil || moved != 0 || len(skipped) != 0 {
		t.Fatalf("second run moved=%d skipped=%v err=%v, want zero-values", moved, skipped, err)
	}
}

func TestMigrateRootIgnoresNonMarkdown(t *testing.T) {
	base := t.TempDir()
	src := filepath.Join(base, "memory")
	dst := filepath.Join(base, "vault", "memory")
	writeFile(t, src, "note.md", "# n")
	writeFile(t, src, "notes.txt", "plain")

	moved, _, err := migrateRoot(src, dst)
	if err != nil {
		t.Fatal(err)
	}
	if moved != 1 {
		t.Fatalf("moved=%d, want 1", moved)
	}
	// a leftover non-markdown file means the source dir must not be removed
	if _, err := os.Stat(filepath.Join(src, "notes.txt")); err != nil {
		t.Fatalf("non-markdown file lost: %v", err)
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./pkg/memroots/ -run TestMigrate -v`
Expected: FAIL — `undefined: migrateRoot`.

- [ ] **Step 3: Write the implementation**

Create `pkg/memroots/migrate.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package memroots

import (
	"log"
	"os"
	"path/filepath"
	"strings"
)

// MigrateLegacyRoot folds the pre-unification ~/.waveterm/memory root into the vault's memory
// collection. Idempotent: an absent source, or a second call, is a no-op. A custom memory:vaultpath
// is deliberately not migrated — it stays a mirror and is read in place.
func MigrateLegacyRoot() (int, []string, error) {
	return migrateRoot(LegacyRoot(), MemoryRoot())
}

// migrateRoot moves src's *.md into dst, skipping (never overwriting) name collisions, and removes
// src only once it is empty. Skips and leftovers are reported rather than forced.
func migrateRoot(src, dst string) (int, []string, error) {
	entries, err := os.ReadDir(src)
	if err != nil {
		if os.IsNotExist(err) {
			return 0, nil, nil
		}
		return 0, nil, err
	}
	var moved int
	var skipped []string
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".md") {
			continue
		}
		from := filepath.Join(src, e.Name())
		to := filepath.Join(dst, e.Name())
		if _, statErr := os.Stat(to); statErr == nil {
			skipped = append(skipped, from)
			log.Printf("memroots: migration skipped %s — %s already exists", from, to)
			continue
		}
		if mkErr := os.MkdirAll(dst, 0o755); mkErr != nil {
			return moved, skipped, mkErr
		}
		if renErr := os.Rename(from, to); renErr != nil {
			return moved, skipped, renErr
		}
		moved++
	}
	// Remove only succeeds on an empty dir, which is exactly the guard we want: anything left behind
	// (a skipped note, a non-markdown file, a subdir) keeps the source root alive.
	if err := os.Remove(src); err != nil && !os.IsNotExist(err) {
		log.Printf("memroots: legacy root %s kept — not empty after migration", src)
	}
	if moved > 0 {
		log.Printf("memroots: migrated %d note(s) from %s into %s", moved, src, dst)
	}
	return moved, skipped, nil
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./pkg/memroots/ -v`
Expected: PASS — all 12 tests (7 from Task 1 + 5 here).

- [ ] **Step 5: Stage (do not commit)**

```bash
git add pkg/memroots/migrate.go pkg/memroots/migrate_test.go
```

---

### Task 3: `wavevault` — federate mirrors into the memory collection

**Files:**
- Modify: `pkg/wavevault/parse.go:21-29` (add `Source` + `Scope` to `Node`)
- Modify: `pkg/wavevault/read.go:40-100` (`graph`, `load`, plus a test seam)
- Create: `pkg/wavevault/mirror_test.go`

**Interfaces:**
- Consumes: `memroots.Mirror`, `memroots.Mirrors()`, `memroots.ScopeForPath`, `memroots.IndexFile` (Task 1).
- Produces:
  - `wavevault.Node` gains `Source string` and `Scope string` (json tags `source`, `scope`).
  - `func SetMirrorsForTest(fn func() []memroots.Mirror) func() []memroots.Mirror` — swaps the mirror resolver, returns the previous value for restore (same shape as `jarvisrecall.SetOpenVaultForTest`).
- No changes to `Scope`, `AllScope`, `WorkerScope`, `Retriever`, or any consumer call site.

- [ ] **Step 1: Write the failing tests**

Create `pkg/wavevault/mirror_test.go`:

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

	"github.com/wavetermdev/waveterm/pkg/memroots"
)

// mirrorFixture builds a vault plus one claude-shaped and one codex-shaped mirror root, and points
// the package's mirror resolver at them for the duration of the test.
func mirrorFixture(t *testing.T) (*Vault, string) {
	t.Helper()
	base := t.TempDir()
	v, err := OpenVaultAtForTest(context.Background(), filepath.Join(base, "vault"))
	if err != nil {
		t.Fatalf("OpenVaultAtForTest: %v", err)
	}
	claudeRoot := filepath.Join(base, "claude", "projects")
	codexRoot := filepath.Join(base, "codex", "memories")
	restore := SetMirrorsForTest(func() []memroots.Mirror {
		return []memroots.Mirror{
			{Path: claudeRoot, Source: "claude"},
			{Path: codexRoot, Source: "codex"},
		}
	})
	t.Cleanup(func() { SetMirrorsForTest(restore) })
	return v, base
}

func writeNote(t *testing.T, dir, name, body string) string {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestMirroredNotesEnterMemoryCollection(t *testing.T) {
	v, base := mirrorFixture(t)
	hub := filepath.Join(base, "claude", "projects", "C--Users-k-krypton", "memory")
	writeNote(t, hub, "hub-note.md", "---\nname: hub-note\n---\n\n# Hub note\nbody\n")
	writeNote(t, filepath.Join(base, "codex", "memories"), "cx.md", "---\nname: cx\n---\n\n# Cx\nbody\n")

	nodes, err := v.Retriever(AllScope()).Query(Filter{})
	if err != nil {
		t.Fatalf("Query: %v", err)
	}
	byID := map[string]Node{}
	for _, n := range nodes {
		byID[n.ID] = n
	}
	hn, ok := byID["hub-note"]
	if !ok {
		t.Fatalf("hub-note absent; got %v", byID)
	}
	if hn.Collection != CollMemory {
		t.Errorf("hub-note Collection = %q, want %q", hn.Collection, CollMemory)
	}
	if hn.Source != "claude" {
		t.Errorf("hub-note Source = %q, want claude", hn.Source)
	}
	if hn.Scope != "krypton" {
		t.Errorf("hub-note Scope = %q, want krypton", hn.Scope)
	}
	if cx, ok := byID["cx"]; !ok || cx.Source != "codex" {
		t.Errorf("codex note = %+v, want Source codex", cx)
	}
}

func TestMirroredWikilinkResolvesAcrossRoots(t *testing.T) {
	v, base := mirrorFixture(t)
	if _, err := v.CreateHuman(CollMemory, "own.md", "---\nname: own\n---\n\n# Own\nsee [[hub-note]]\n"); err != nil {
		t.Fatalf("CreateHuman: %v", err)
	}
	hub := filepath.Join(base, "claude", "projects", "C--Users-k-krypton", "memory")
	writeNote(t, hub, "hub-note.md", "---\nname: hub-note\n---\n\n# Hub note\nbody\n")

	sg, err := v.Retriever(AllScope()).Graph()
	if err != nil {
		t.Fatalf("Graph: %v", err)
	}
	for _, e := range sg.Edges {
		if e.From == "own" && e.To == "hub-note" {
			return
		}
	}
	t.Fatalf("edge own->hub-note absent; edges = %v", sg.Edges)
}

func TestVaultOwnNoteWinsIDConflict(t *testing.T) {
	v, base := mirrorFixture(t)
	if _, err := v.CreateHuman(CollMemory, "dup.md", "---\nname: dup\n---\n\n# Dup\nVAULT COPY\n"); err != nil {
		t.Fatalf("CreateHuman: %v", err)
	}
	hub := filepath.Join(base, "claude", "projects", "C--Users-k-krypton", "memory")
	writeNote(t, hub, "dup.md", "---\nname: dup\n---\n\n# Dup\nMIRROR COPY\n")

	nb, err := v.Retriever(AllScope()).Read("dup")
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if !strings.Contains(nb.Body, "VAULT COPY") {
		t.Fatalf("mirror won the conflict; body = %q", nb.Body)
	}
	if nb.Node.Source != "vault" {
		t.Errorf("Source = %q, want vault", nb.Node.Source)
	}
}

func TestIndexFileExcludedFromGraph(t *testing.T) {
	_, base := mirrorFixture(t)
	hub := filepath.Join(base, "claude", "projects", "C--Users-k-krypton", "memory")
	writeNote(t, hub, memroots.IndexFile, "# Memory index\n- [x](x.md)\n")
	v, err := OpenVaultAtForTest(context.Background(), filepath.Join(base, "vault"))
	if err != nil {
		t.Fatal(err)
	}

	nodes, err := v.Retriever(AllScope()).Query(Filter{})
	if err != nil {
		t.Fatal(err)
	}
	for _, n := range nodes {
		if strings.TrimSuffix(memroots.IndexFile, ".md") == n.ID {
			t.Fatalf("index file entered the graph as %+v", n)
		}
	}
}

func TestMirroredFileIsNotWritable(t *testing.T) {
	v, base := mirrorFixture(t)
	hub := filepath.Join(base, "claude", "projects", "C--Users-k-krypton", "memory")
	writeNote(t, hub, "hub-note.md", "---\nname: hub-note\n---\n\n# Hub note\nbody\n")

	if _, err := v.resolvePath("hub-note"); err == nil {
		t.Fatal("resolvePath reached a mirrored file; mirrors must be read-only")
	}
}

func TestMirrorScanLeavesVaultGitClean(t *testing.T) {
	v, base := mirrorFixture(t)
	hub := filepath.Join(base, "claude", "projects", "C--Users-k-krypton", "memory")
	writeNote(t, hub, "hub-note.md", "---\nname: hub-note\n---\n\n# Hub note\nbody\n")
	if _, err := v.Retriever(AllScope()).Query(Filter{}); err != nil {
		t.Fatal(err)
	}

	out, err := runGit(context.Background(), v.Root, "status", "--porcelain")
	if err != nil {
		t.Fatalf("git status: %v", err)
	}
	if strings.TrimSpace(out) != "" {
		t.Fatalf("vault dirty after mirror scan: %q", out)
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./pkg/wavevault/ -run 'TestMirror|TestVaultOwn|TestIndexFile' -v`
Expected: FAIL — `undefined: SetMirrorsForTest`, and `Node` has no `Source`/`Scope` fields.

- [ ] **Step 3: Add the `Node` fields**

In `pkg/wavevault/parse.go`, extend the `Node` struct (keep existing fields and their order):

```go
type Node struct {
	ID          string         `json:"id"`
	Path        string         `json:"path"`
	Collection  string         `json:"collection"`
	Source      string         `json:"source"` // "vault" | "claude" | "codex" — which root it came from
	Scope       string         `json:"scope"`  // project label for a mirrored hub note, else "shared"
	Frontmatter map[string]any `json:"frontmatter"`
	Links       []string       `json:"links"`
	ContentHash string         `json:"contenthash"`
	UpdatedTs   int64          `json:"updatedts"`
}
```

Update the doc comment above `Node` — the existing one says "Collection and UpdatedTs are filled in by the scanner, not by parseNode"; make it "Collection, Source, Scope and UpdatedTs are filled in by the scanner, not by parseNode."

- [ ] **Step 4: Add the mirror walk, the test seam, and explicit precedence**

In `pkg/wavevault/read.go`, add the seam near the top of the file (after the imports):

```go
// mirrorsFn resolves the external read-only roots federated into the memory collection. A seam so
// tests point at fixture roots instead of the developer's real ~/.claude and ~/.codex.
var mirrorsFn = memroots.Mirrors

// SetMirrorsForTest swaps the mirror resolver; returns the previous value for restore.
func SetMirrorsForTest(fn func() []memroots.Mirror) func() []memroots.Mirror {
	old := mirrorsFn
	mirrorsFn = fn
	return old
}
```

Replace the body of `load` (currently `read.go:62-100`). Two changes: the per-file work becomes a shared closure with an explicit precedence rule, and the memory collection additionally walks the mirrors.

```go
// load walks the scope's collection directories — the physical collection boundary — plus, for the
// memory collection, the external mirror roots. Mirrors are read-only by construction: resolvePath
// and Commit are both v.Root-scoped, so nothing here can be written or committed.
func (r *Retriever) load() error {
	if r.loaded {
		return nil
	}
	g := &graph{byID: map[string]Node{}, bodies: map[string]string{}}

	// absorb applies one file. Precedence: the vault's own copy wins an id conflict, else first-seen
	// wins. (Before mirrors there was only one root, and this was last-seen-wins by accident.)
	absorb := func(root, coll, source, p string, d os.DirEntry) {
		if d.Name() == memroots.IndexFile {
			return // an index, not knowledge — and every copy collides on the id "MEMORY"
		}
		data, readErr := os.ReadFile(p)
		if readErr != nil {
			return // tolerant: skip unreadable files
		}
		n, body := parseNode(p, data)
		n.Collection = coll
		n.Source = source
		if s, ok := n.Frontmatter["scope"].(string); ok && s != "" {
			n.Scope = s
		} else {
			n.Scope = memroots.ScopeForPath(root, source, p)
		}
		if info, statErr := d.Info(); statErr == nil {
			n.UpdatedTs = info.ModTime().UnixMilli()
		}
		if existing, dup := g.byID[n.ID]; dup {
			if !(source == "vault" && existing.Source != "vault") {
				return // keep existing
			}
		} else {
			g.order = append(g.order, n.ID)
		}
		g.byID[n.ID] = n
		g.bodies[n.ID] = body
	}

	walk := func(root, coll, source string) {
		_ = filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error {
			if err != nil || d.IsDir() || !strings.HasSuffix(d.Name(), ".md") {
				return nil
			}
			absorb(root, coll, source, p, d)
			return nil
		})
	}

	for _, coll := range r.scope.Collections {
		walk(filepath.Join(r.v.Root, coll), coll, "vault")
		if coll == CollMemory {
			for _, m := range mirrorsFn() {
				walk(m.Path, CollMemory, m.Source)
			}
		}
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
```

Add `"github.com/wavetermdev/waveterm/pkg/memroots"` to `read.go`'s imports.

- [ ] **Step 5: Run tests to verify they pass**

Run: `go test ./pkg/wavevault/ -v`
Expected: PASS — the 6 new mirror tests plus every pre-existing `wavevault` test (`read_test.go`, `write_test.go`, `commit_test.go`, `region_test.go`, `parse_test.go`, `vault_test.go`). Pre-existing tests must not need edits; if one fails, the precedence change or the `Source` default is wrong.

- [ ] **Step 6: Stage (do not commit)**

```bash
git add pkg/wavevault/parse.go pkg/wavevault/read.go pkg/wavevault/mirror_test.go
```

---

### Task 4: `memvault` — derive its roots from `memroots`

**Files:**
- Modify: `pkg/memvault/memvault.go:121-125` (`Root` → alias), `:130-173` (`ScanVault` skips the index file), `:175-224` (`deriveScope`, `buildRoots`, `VaultRoots`, `DefaultVaultPath`)
- Modify: `pkg/memvault/projection.go:20-57` (delete `projectHash`, `labelFromHash`), `:174-184` (delete `registryProjects`), `:191`, `:201`, `:259` (call sites)
- Modify: `pkg/memvault/harvest.go:222` (call site)
- Modify: `pkg/memvault/memvault_test.go:104-117` (delete the `buildRoots` test), `:181-190` (`deriveScope` tests)
- Modify: `pkg/memvault/projection_test.go:24-56` (delete the moved `projectHash`/`labelFromHash` tests)

**Interfaces:**
- Consumes: everything Task 1 produced.
- Produces: `memvault.Root` is now `= memroots.Mirror` (alias, so `Root{Path:…, Source:…}` literals still compile). `VaultRoots()`, `DefaultVaultPath()`, `ScanVault()` signatures unchanged — this is what keeps `memdistill`, `memgarden`, `reporadar` and `wshserver_memory` untouched.

- [ ] **Step 1: Write the failing test**

Add to `pkg/memvault/memvault_test.go`:

```go
func TestScanVaultSkipsIndexFile(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, memroots.IndexFile), []byte("# Index\n- [a](a.md)\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "real.md"), []byte("---\nname: real\n---\n\n# Real\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	g, err := ScanVault([]Root{{Path: dir, Source: "vault"}})
	if err != nil {
		t.Fatal(err)
	}
	if len(g.Notes) != 1 || g.Notes[0].ID != "real" {
		t.Fatalf("notes = %+v, want only real", g.Notes)
	}
}
```

Add `"github.com/wavetermdev/waveterm/pkg/memroots"` to `memvault_test.go`'s imports.

Then replace the two `deriveScope` assertions at `memvault_test.go:181-190` with the delegating form (same expectations, so this is a behavior-preserving rewrite):

```go
func TestDeriveScope(t *testing.T) {
	r := Root{Path: filepath.Join(`/home/k`, ".claude", "projects"), Source: "claude"}
	path := filepath.Join(r.Path, "C--Users-kael02-IdeaProjects-krypton", "memory", "n.md")
	if got := deriveScope(r, path); got != "krypton" {
		t.Fatalf("claude scope = %q, want krypton", got)
	}
	rv := Root{Path: `/vault`, Source: "vault"}
	if got := deriveScope(rv, filepath.Join(`/vault`, "teamx", "note.md")); got != "teamx" {
		t.Fatalf("vault scope = %q, want teamx", got)
	}
}
```

- [ ] **Step 2: Run tests to verify the new one fails**

Run: `go test ./pkg/memvault/ -run TestScanVaultSkipsIndexFile -v`
Expected: FAIL — 2 notes returned instead of 1 (`MEMORY` enters the graph).

- [ ] **Step 3: Rewire `memvault.go`**

Replace `Root`'s declaration (`memvault.go:121-125`):

```go
// Root is one scan location and its provenance tag. An alias, not a new type: memroots owns the
// registry, and existing Root{...} literals in consumers keep compiling.
type Root = memroots.Mirror
```

In `ScanVault`'s `WalkDir` callback, skip the index file — change the guard at `memvault.go:135`:

```go
if err != nil || d.IsDir() || !strings.HasSuffix(d.Name(), ".md") || d.Name() == memroots.IndexFile {
	return nil
}
```

Replace `deriveScope`, `defaultVaultSubpath`, `buildRoots`, `VaultRoots` and `DefaultVaultPath` (`memvault.go:175-224`) with:

```go
// deriveScope defers to the shared registry so the Memory surface and the vault Retriever derive
// identical scopes from identical paths.
func deriveScope(r Root, path string) string {
	return memroots.ScopeForPath(r.Path, r.Source, path)
}

// VaultRoots is every durable-knowledge scan root, the vault's own memory collection first.
func VaultRoots() []Root {
	return memroots.AllRoots()
}

// DefaultVaultPath is the write target for cockpit-created notes.
func DefaultVaultPath() string {
	return memroots.MemoryRoot()
}
```

Fix imports in `memvault.go`: add `memroots`, and drop `wavebase` and `wconfig` if they are now unused (`go build ./pkg/memvault/` will say).

- [ ] **Step 4: Rewire `projection.go` and `harvest.go`**

Delete `projectHash` (`projection.go:20-25`), `labelFromHash` (`:43-57`) and `registryProjects` (`:174-184`) — they now live in `memroots`. Keep `projectLabel` (cwd-keyed, projection-only). Then update every call site:

- `projection.go:191` (`HubDirForCwd`): `projectHash(cwd)` → `memroots.ProjectHash(cwd)`
- `projection.go:201` (`Project`): `projectLabel(cwd, registryProjects())` → `projectLabel(cwd, memroots.RegistryProjects())`
- `projection.go:252` (`repoPathForHubDir` caller): `registryProjects()` → `memroots.RegistryProjects()`
- `projection.go:259` (inside `repoPathForHubDir`): `projectHash(...)` → `memroots.ProjectHash(...)`
- `harvest.go:222`: `projectHash(cwd)` → `memroots.ProjectHash(cwd)`

Add the `memroots` import to both files; drop `wconfig` from `projection.go` if now unused.

- [ ] **Step 5: Delete the moved tests**

- Delete `TestVaultRootsIncludesSources` (`memvault_test.go:104-117`) — `buildRoots` no longer exists and `memroots.TestBuildAllRootsPutsMemoryRootFirst` covers the composition.
- Delete the `projectHash` and `labelFromHash` assertions from `projection_test.go` (`:24-33` and `:47-55`) — covered by `memroots.TestProjectHash` / `TestLabelFromHash`. Keep the `projectLabel` assertions (`:40-45`) and the `HubDirForCwd` test at `:16`, updating the latter's `projectHash(repo)` call to `memroots.ProjectHash(repo)` and adding the import.

- [ ] **Step 6: Run the package tests**

Run: `go test ./pkg/memvault/ -v`
Expected: PASS, including the new `TestScanVaultSkipsIndexFile`.

- [ ] **Step 7: Verify the untouched consumers still build and pass**

Run: `go test ./pkg/memdistill/ ./pkg/memgarden/ ./pkg/reporadar/ ./pkg/jarvisrecall/ ./pkg/wshrpc/wshserver/`
Expected: PASS with **no source edits** to those packages. If any fails to compile, the `Root` alias or a signature changed when it should not have — fix `memvault`, not the consumer.

- [ ] **Step 8: Stage (do not commit)**

```bash
git add pkg/memvault/memvault.go pkg/memvault/projection.go pkg/memvault/harvest.go pkg/memvault/memvault_test.go pkg/memvault/projection_test.go
```

---

### Task 5: Run the migration at vault open

**Files:**
- Modify: `pkg/wavevault/vault.go:57-80` (`OpenVault` / `openVaultAt`)
- Modify: `pkg/wavevault/vault_test.go` (add the hermeticity test)

**Interfaces:**
- Consumes: `memroots.MigrateLegacyRoot` (Task 2).
- Produces: no new exports. `OpenVault` migrates once per process; `openVaultAt` / `OpenVaultAtForTest` never do.

- [ ] **Step 1: Write the failing test**

Add to `pkg/wavevault/vault_test.go`:

```go
// The migration must hang off OpenVault, never openVaultAt — otherwise every fixture vault in the
// suite would reach into the developer's real ~/.waveterm/memory.
func TestOpenVaultAtForTestDoesNotMigrate(t *testing.T) {
	base := t.TempDir()
	legacy := filepath.Join(base, "legacy")
	if err := os.MkdirAll(legacy, 0o755); err != nil {
		t.Fatal(err)
	}
	note := filepath.Join(legacy, "keep.md")
	if err := os.WriteFile(note, []byte("---\nname: keep\n---\n\n# Keep\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	if _, err := OpenVaultAtForTest(context.Background(), filepath.Join(base, "vault")); err != nil {
		t.Fatalf("OpenVaultAtForTest: %v", err)
	}
	if _, err := os.Stat(note); err != nil {
		t.Fatalf("fixture open touched a legacy root: %v", err)
	}
}
```

Ensure `vault_test.go` imports `context`, `os`, `path/filepath`, `testing`.

- [ ] **Step 2: Run it to confirm it passes for the right reason**

Run: `go test ./pkg/wavevault/ -run TestOpenVaultAtForTestDoesNotMigrate -v`
Expected: PASS already (nothing migrates yet). This test's job is to *stay* passing after Step 3 — it is the guard against wiring the migration into the wrong function. Note it passes now, then verify again after the change.

- [ ] **Step 3: Wire the migration into `OpenVault` only**

In `pkg/wavevault/vault.go`, add the guarded call:

```go
// migrateOnce guards the one-shot legacy-root fold. OpenVault is called from several packages per
// session; without this two concurrent opens would race on the same file moves.
var migrateOnce sync.Once

// OpenVault opens (creating + git-initializing if needed) the configured vault. On the first call of
// the process it also folds the legacy ~/.waveterm/memory root into the vault's memory collection.
func OpenVault(ctx context.Context) (*Vault, error) {
	v, err := openVaultAt(ctx, DefaultVaultRoot())
	if err != nil {
		return nil, err
	}
	migrateOnce.Do(func() {
		if _, _, mErr := memroots.MigrateLegacyRoot(); mErr != nil {
			log.Printf("wavevault: legacy memory migration failed: %v", mErr) // non-fatal: the legacy root stays a readable mirror
		}
	})
	return v, nil
}
```

Add `"log"`, `"sync"` and the `memroots` import to `vault.go`. Leave `openVaultAt` and `OpenVaultAtForTest` unchanged.

The migration runs *after* `openVaultAt` deliberately: `openVaultAt` scaffolds `<root>/memory`, which is the migration's destination.

- [ ] **Step 4: Run the package tests**

Run: `go test ./pkg/wavevault/ -v`
Expected: PASS, `TestOpenVaultAtForTestDoesNotMigrate` included.

- [ ] **Step 5: Point `DefaultVaultRoot` at the shared registry**

`wavevault.DefaultVaultRoot` (`vault.go:49-55`) and `memroots.VaultRoot` now duplicate the same config read — exactly the desync this slice exists to remove. Collapse it:

```go
// DefaultVaultRoot resolves the vault path from config (jarvis:vaultpath) + home.
func DefaultVaultRoot() string {
	return memroots.VaultRoot()
}
```

Delete the now-unused `defaultVaultSubpath` const from `vault.go` and drop `wavebase`/`wconfig` from its imports if unused (`go build ./pkg/wavevault/` will say).

- [ ] **Step 6: Run the package tests again**

Run: `go test ./pkg/wavevault/ -v`
Expected: PASS, unchanged.

- [ ] **Step 7: Stage (do not commit)**

```bash
git add pkg/wavevault/vault.go pkg/wavevault/vault_test.go
```

---

### Task 6: Vault citations name their project

**Files:**
- Modify: `pkg/jarvisrecall/retrieve.go:166-182` (`nodeCandidate`)
- Modify: `pkg/jarvisrecall/retrieve_test.go` (add the assertion)

**Interfaces:**
- Consumes: `wavevault.Node.Scope` (Task 3).
- Produces: nothing new — populates the existing `candidate.project` field, which `buildCards` already carries into the grounding card.

- [ ] **Step 1: Write the failing test**

Add to `pkg/jarvisrecall/retrieve_test.go`:

```go
func TestNodeCandidateCarriesScopeAsProject(t *testing.T) {
	n := wavevault.Node{
		ID:         "hub-note",
		Collection: wavevault.CollMemory,
		Source:     "claude",
		Scope:      "krypton",
	}
	got := nodeCandidate(n, "body text")
	if got.project != "krypton" {
		t.Fatalf("project = %q, want krypton", got.project)
	}
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `go test ./pkg/jarvisrecall/ -run TestNodeCandidateCarriesScopeAsProject -v`
Expected: FAIL — `project = "" , want krypton`.

- [ ] **Step 3: Populate the field**

In `pkg/jarvisrecall/retrieve.go`, add one line to `nodeCandidate`'s returned struct, after `title`:

```go
	return candidate{
		sourceType: st,
		title:      nodeTitle(n),
		project:    n.Scope, // a mirrored hub note is another project's — say so rather than imply it is this one's
		ts:         n.UpdatedTs,
		freshness:  "fresh",
		navTarget:  "vault:" + n.ID,
		snippet:    truncate(strings.TrimSpace(body), 240),
	}
```

- [ ] **Step 4: Run the package tests**

Run: `go test ./pkg/jarvisrecall/ -v`
Expected: PASS.

- [ ] **Step 5: Stage (do not commit)**

```bash
git add pkg/jarvisrecall/retrieve.go pkg/jarvisrecall/retrieve_test.go
```

---

### Task 7: Full regression, then verify against the real machine

**Files:**
- No source changes expected. If a fix is needed, it belongs in whichever package the failure names.

**Interfaces:**
- Consumes: Tasks 1-6.
- Produces: the evidence that the memory lane is no longer empty.

- [ ] **Step 1: Full Go regression**

Run: `go test ./pkg/...`
Expected: PASS. `pkg/jarvisembed` requires the sqlite-vec zig wiring (global `CGO_CFLAGS -I` for the vendored `csrc/sqlite3.h`, `-O2` preserved) — if it fails to build for that reason, that is a pre-existing environment issue, not this change; note it and move on.

- [ ] **Step 2: Vet and build the backend**

Run: `go vet ./pkg/memroots/ ./pkg/memvault/ ./pkg/wavevault/ ./pkg/jarvisrecall/`
Expected: clean.

Run: `task build:backend`
Expected: builds `wavesrv` + `wsh` into `dist/bin/`.

- [ ] **Step 3: Back up the real vault and memory roots before touching them**

The next step lets the app move files in the home directory. Snapshot first:

```bash
cp -r ~/.waveterm/memory ~/.waveterm/memory.j6-backup
cp -r ~/.waveterm/vault ~/.waveterm/vault.j6-backup
```

- [ ] **Step 4: Confirm the pre-state**

```bash
find ~/.waveterm/memory -name '*.md' | wc -l          # expect 1
find ~/.waveterm/vault/memory -name '*.md' | wc -l    # expect 0
```

- [ ] **Step 5: Start the dev app and let the migration run**

Run: `tail -f /dev/null | task dev`

(The `tail -f /dev/null` prefix is required — a headless `task dev` dies on stdin EOF. When stopping it, kill the `tail` half explicitly; it does not exit on its own if `task dev` crashes.)

Wait for the cockpit to render, then open the Memory surface once so `MemoryScanCommand` runs.

- [ ] **Step 6: Verify — one Wave-owned root on disk**

```bash
ls ~/.waveterm/memory 2>&1                            # expect: No such file or directory
find ~/.waveterm/vault/memory -name '*.md' | wc -l    # expect 1
```

Expected: the legacy dir is gone and `correction-one-def191f9.md` is under `~/.waveterm/vault/memory/`.

- [ ] **Step 7: Verify — the Memory surface still shows everything, minus the index rows**

In the running app's Memory surface, confirm the note count is ~363 (`1` migrated + `282` named hub notes + `76` codex, minus the `4` `MEMORY.md` rows that used to appear). The four `MEMORY` entries must be gone; every real note must still be listed with its project scope.

- [ ] **Step 8: Verify — the vault Retriever sees the same notes (the core assertion)**

This is the claim the whole slice rests on: a vault-scoped read now returns the federated notes. Ask Jarvis a question whose answer exists **only** in a Claude hub note — for example something recorded under `~/.claude/projects/*/memory/` for another project — **without attaching anything**, and confirm the grounding cards cite that note and name its project.

Expected: at least one grounding card of source type `memory`/`dossier` citing a hub note, labelled with its project. Before this change the same question returned `"Not found. No Wave source in scope references this."`

- [ ] **Step 9: Verify — the vault repo stayed clean**

```bash
git -C ~/.waveterm/vault status --porcelain
```

Expected: empty, or showing only the migrated note as an untracked/staged human file — **never** any path under `~/.claude` or `~/.codex`.

- [ ] **Step 10: Stop the dev app and remove the backups once satisfied**

Stop `task dev` and explicitly kill the `tail -f /dev/null` half. Then, only after Steps 6-9 all passed:

```bash
rm -rf ~/.waveterm/memory.j6-backup ~/.waveterm/vault.j6-backup
```

If any step failed, restore from the backups instead and report which one.

---

### Task 8: Update the tracking docs and commit

**Files:**
- Modify: `docs/jarvis-second-brain-open-issues.md:24` (the J6 table row) and its `## J6` section
- Modify: `docs/deferred.md:79-86` (the sub-project A entry)
- Commit: everything staged across Tasks 1-7, plus the spec and this plan

**Interfaces:**
- Consumes: the verification evidence from Task 7.
- Produces: the single commit.

- [ ] **Step 1: Update the J6 table row**

In `docs/jarvis-second-brain-open-issues.md`, change the J6 row's status from `🔲 Open` to `✅ Resolved 2026-07-27`.

- [ ] **Step 2: Rewrite the J6 section's status and correct its framing**

Add a `**Status:** ✅ Resolved 2026-07-27` line with a **What shipped** subsection recording: `pkg/memroots` as the single registry; mirrors federated into the vault's memory collection with `Source`/`Scope`; the legacy root migrated; `nodeCandidate` now naming its project.

Two corrections the section needs, both discovered while doing the work:

1. The claim *"this is a consolidation, not a capability change"* was **wrong** — `~/.waveterm/vault/memory/` had no writer, so every vault consumer traversed an empty collection and the memory lane was a no-op. Record that, since it is the reason the work mattered.
2. The verify line *"the Memory surface reads through the vault API"* was **deliberately not done** — amend it to "both APIs read the same bytes from the same roots", with the reason (memvault's typed projection drives the review/prune/archive UI; re-deriving it from `Node.Frontmatter` buys nothing across 17 files).

Also note in J5's entry that its "populate a real vault" precondition is now satisfied.

- [ ] **Step 3: Close the deferral in `docs/deferred.md`**

Mark the `## Jarvis sub-project A (Wave Vault) — memory vault coexists, unify later` entry resolved, dated 2026-07-27, pointing at the spec. Do not delete the entry — the file is the running log of *why* things were deferred.

- [ ] **Step 4: Self-review the diff**

Run: `git diff --cached` and review every hunk. Confirm: no commented-out code, no debug prints, no leftover `buildRoots`/`projectHash`/`labelFromHash`/`registryProjects` definitions in `memvault`, no `wavevault` file importing `memvault` (or vice versa), and nothing staged from the other session's work.

```bash
git status --short
```

Expected: the other session's files (`frontend/app/view/agents/ambientcard.tsx`, `pkg/consult/*`, `pkg/tasksharpen/*`, `pkg/jarvis/*`, `pkg/jarvisproactive/*`, and the modified `frontend/app/view/agents/*.tsx`) still show as unstaged/untracked. If any of them is staged, unstage it with `git restore --staged <path>`.

- [ ] **Step 5: Stage the docs, the spec, and this plan**

```bash
git add docs/jarvis-second-brain-open-issues.md docs/deferred.md \
  docs/superpowers/specs/2026-07-27-jarvis-j6-memory-root-unification-design.md \
  docs/superpowers/plans/2026-07-27-jarvis-j6-memory-root-unification.md
```

- [ ] **Step 6: Ask the user for commit approval**

**Stop here and ask.** The user's git rules are explicit: never commit without approval. Present the staged file list and the proposed message, then wait.

- [ ] **Step 7: Commit (only after approval)**

```bash
git commit -F - <<'EOF'
feat(jarvis): J6 unify durable-knowledge roots behind pkg/memroots

The vault's memory/ collection had no writer, so every vault-backed
consumer (recall seeds/Expand, embeddings, attribution, proactive gate)
traversed an empty collection while ~363 notes sat in roots only memvault
could see. The memory lane was a no-op, not merely a duplicate.

- pkg/memroots: the single registry of durable-knowledge locations —
  vault root, memory root, external mirrors, project-label and scope
  derivation, and the one-shot legacy-root migration. Leaf package;
  memvault and wavevault both import it, neither imports the other.
- wavevault: Retriever.load federates the agent-native memory dirs into
  the memory collection as read-only mirrors (resolvePath and Commit stay
  v.Root-scoped), tagging Source/Scope. Node id precedence is now explicit
  vault-wins instead of accidental last-seen-wins.
- memvault: roots, scope derivation and the hub-path helpers derive from
  memroots; per-hub MEMORY.md index files no longer enter the graph.
- Legacy ~/.waveterm/memory is migrated under the vault on first open;
  a custom memory:vaultpath is read in place, never moved.
- jarvisrecall: vault citations carry their project, as memvault ones do.

Deliberately not done: folding the Memory surface onto the vault read API
(memvault's typed projection drives the review/prune/archive UI).
Unblocks J5's populated-vault precondition.
EOF
```

- [ ] **Step 8: Confirm the commit is clean**

```bash
git show --stat HEAD
```

Expected: only `pkg/memroots/*`, `pkg/memvault/*`, `pkg/wavevault/*`, `pkg/jarvisrecall/retrieve*.go`, and the four docs files. **No** frontend files and none of the other session's Go files.

---

## Self-Review

**Spec coverage** — every spec section maps to a task:

| Spec section | Task |
|---|---|
| § Design 1 — `pkg/memroots` registry, moved helpers, `ScopeForPath` | 1 |
| § Design 4 — migration (default moved, custom mirrored, collisions skipped, idempotent) | 2 |
| § Design 2 — mirrors in `load`, `Node.Source`/`Scope`, read-only, explicit precedence | 3 |
| § Design 3 — memvault derives; `Root` alias; `IndexFile` skipped; create-fallback retargeted | 4 |
| § Design 4 — `sync.Once` at `OpenVault`, hermetic `openVaultAt` | 5 |
| § Decisions — cross-project notes tagged not filtered (citations name the project) | 6 |
| § Testing — regression across the untouched consumers | 4 step 7, 7 step 1 |
| § Verify — all 5 real-machine items | 7 steps 4-9 |
| § Decisions — amend the "Memory surface reads through the vault API" verify line | 8 |

Note: the spec's "`MemoryCreateCommand`'s fallback target moves to `<vault>/memory`" needs **no** task of its own — it falls out of Task 4's `DefaultVaultPath()` returning `memroots.MemoryRoot()`, since `wshserver_memory.go:61` already calls that function. Task 4 step 7 proves `wshserver` still compiles against it.

**Placeholder scan** — no TBD/TODO; every code step carries the actual code; no "similar to Task N"; no "add error handling" hand-waving.

**Type consistency** — `Mirror{Path, Source}` is used identically in Tasks 1, 3, 4. `memroots.ScopeForPath(rootPath, source, filePath)`'s three-arg order matches its two call sites (Task 3's `absorb`, Task 4's `deriveScope`). `SetMirrorsForTest` takes and returns `func() []memroots.Mirror` consistently in Task 3's fixture and its definition. `migrateRoot(src, dst) (int, []string, error)` matches `MigrateLegacyRoot`'s return and Task 5's `_, _, mErr :=`. `Node.Scope` (Task 3) is what Task 6 reads.

**Blast-radius check on the new `Node` fields:** Task 3's `absorb` sets `Source: "vault"` for everything under `v.Root`, including `tasks/` and `decisions/` nodes — correct (they are the vault's own), but it means `Node.Source`/`Scope` are non-empty where they used to be absent. Verified this breaks nothing: neither `pkg/wavevault/*_test.go` nor `pkg/jarvisrecall/*_test.go` contains a single `reflect.DeepEqual` or a whole-struct `Node{...}` assertion, so no existing test compares a zero-valued `Node`. Task 3 step 5 remains the backstop.
