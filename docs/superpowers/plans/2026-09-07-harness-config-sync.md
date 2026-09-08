# Harness Config Sync Implementation Plan

> **Superseded 2026-09-08** by `2026-09-08-harness-steering-skills-rework-design.md`.
> Two premises here proved wrong in use: the steering UI showed only the generated region
> (so an unsynced harness read as empty), and directory junctions cannot express a
> per-harness variant, which blocked the one real skill collision on the tree. Kept for the
> drift measurements and the marker mechanics, both of which the rework reuses.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Wave Vault the single source of truth for agent steering files and skills, projected outward into every installed harness.

**Architecture:** A new leaf package `pkg/agentsync` owns two one-way projections — a delimited `ARC-STEERING` region written into each harness's home-level steering file, and one directory junction per canonical skill into each harness's skills directory. Per-harness filesystem locations move into `pkg/harness` (the existing catalog) so one place knows where each harness lives. A `wsh agent-sync` CLI carries the whole feature before any UI exists; the Settings section is a thin second layer over the same RPCs.

**Tech Stack:** Go (stdlib only, no new dependencies), wshrpc codegen, React 19 + jotai + Tailwind 4, vitest, CDP verification harness.

**Spec:** `docs/superpowers/specs/2026-09-07-harness-config-sync-design.md`

## Global Constraints

- **Never commit.** The user's git rules override the default per-task commit step: stage only (`git add`), batch into one commit at the end, and only after explicit approval. The spec and this plan fold into that same feature commit — never a docs-only commit.
- **No emojis** anywhere, including commit messages and UI copy.
- **Comments explain "why", never "what"**, lower case, only where a reader would otherwise be puzzled.
- **No hardcoded colors.** Use `@theme` tokens from `frontend/tailwindsetup.css` (`text-primary`, `text-muted`, `text-success`, `border-edge-faint`, ...). A raw hex or rgba silently opts out of every runtime theme.
- **No new SCSS.** Tailwind only.
- **Never hand-edit generated files.** After changing any `wshrpc` type, run `task generate`; it rewrites `pkg/wshrpc/wshclient/wshclient.go`, `frontend/app/store/wshclientapi.ts`, and `frontend/types/gotypes.d.ts`.
- **Appending to an existing Go test file: use `cat >> file <<'EOF'`, never the Write tool.** Write replaces the file and has silently destroyed test files in this repo before. "File created" in the tool result (rather than "has been updated") is the tell that you just clobbered something.
- **Go tests that pull in `pkg/wshrpc/wshserver` need CGO flags.** From PowerShell at the repo root:
  ```powershell
  $env:CGO_CFLAGS = "-O2 -g -I$((Get-Location).Path -replace '\\','/')/pkg/jarvisembed/csrc"
  ```
  `pkg/agentsync`, `pkg/harness`, and `pkg/memroots` have no cgo dependency and test fine without it.
- **Typecheck with** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`. Bare `npx tsc` stack-overflows on this repo. The baseline is clean apart from ~3 known `frontend/tauri/api.test.ts` errors.
- **Windows environment.** Use the Bash tool for POSIX-shaped commands and PowerShell for Windows path work. Never use PowerShell here-strings inside the Bash tool.
- **Home-level files only.** No task in this plan may write a git-tracked file in any repo.

---

### Task 1: Harness catalog learns where each harness stores config

**Files:**
- Modify: `pkg/harness/catalog.go` (Spec struct at :27-33, specs var at :35-40)
- Modify: `pkg/memvault/projection.go:100-113` (`steeringTargets` reads the catalog instead of hardcoding paths)
- Test: `pkg/harness/catalog_test.go` (append)

**Interfaces:**
- Consumes: nothing.
- Produces: `harness.Spec.SteeringRel []string`, `harness.Spec.SkillsRel []string`, and methods `SteeringPath(home string) string`, `SkillsPath(home string) string`, `ConfigRoot(home string) string`. `SkillsPath` returns `""` when the harness has no fixed skills directory. Every later task resolves harness locations through these and never hardcodes a path.

The `memvault` change is folded in here rather than split out: it is the reason the paths move into the catalog at all, and it is meaningless without the fields this task adds.

- [ ] **Step 1: Write the failing test**

Append to `pkg/harness/catalog_test.go` with a heredoc (never the Write tool):

```bash
cat >> pkg/harness/catalog_test.go <<'EOF'

func TestConfigSurfacePaths(t *testing.T) {
	home := filepath.Join("C:", "Users", "k")
	cases := []struct{ runtime, steering, skills string }{
		{"claude", filepath.Join(home, ".claude", "CLAUDE.md"), filepath.Join(home, ".claude", "skills")},
		{"codex", filepath.Join(home, ".codex", "AGENTS.md"), filepath.Join(home, ".codex", "skills")},
		{"opencode", filepath.Join(home, ".config", "opencode", "AGENTS.md"), filepath.Join(home, ".config", "opencode", "skills")},
		{"pi", filepath.Join(home, ".pi", "agent", "AGENTS.md"), ""},
	}
	for _, c := range cases {
		spec, ok := Lookup(c.runtime)
		if !ok {
			t.Fatalf("%s missing from catalog", c.runtime)
		}
		if got := spec.SteeringPath(home); got != c.steering {
			t.Errorf("%s SteeringPath = %q, want %q", c.runtime, got, c.steering)
		}
		if got := spec.SkillsPath(home); got != c.skills {
			t.Errorf("%s SkillsPath = %q, want %q", c.runtime, got, c.skills)
		}
	}
}

func TestConfigRootIsSteeringParent(t *testing.T) {
	home := filepath.Join("C:", "Users", "k")
	for _, c := range []struct{ runtime, want string }{
		{"pi", filepath.Join(home, ".pi", "agent")},
		{"claude", filepath.Join(home, ".claude")},
		{"opencode", filepath.Join(home, ".config", "opencode")},
	} {
		spec, _ := Lookup(c.runtime)
		if got := spec.ConfigRoot(home); got != c.want {
			t.Errorf("%s ConfigRoot = %q, want %q", c.runtime, got, c.want)
		}
	}
}
EOF
```

Then add `"path/filepath"` to the import block at the top of `pkg/harness/catalog_test.go` — appending a function does not add its imports, and the test will not compile without it.

- [ ] **Step 2: Run the test to verify it fails**

Run: `go test ./pkg/harness/ -run 'TestConfigSurfacePaths|TestConfigRootIsSteeringParent' -v`
Expected: FAIL to compile — `spec.SteeringPath undefined`.

- [ ] **Step 3: Implement**

In `pkg/harness/catalog.go`, add `"path/filepath"` to the imports, extend the struct, populate the specs, and add the three methods:

```go
type Spec struct {
	Runtime          string
	Bin              string
	Label            string
	ConsultCapable   bool
	RunWorkerCapable bool
	// SteeringRel is the home-relative path of the harness's home-level steering file.
	SteeringRel []string
	// SkillsRel is the home-relative path of the harness's skills directory. nil when the harness
	// has no fixed one: pi reads an explicit list of paths from its settings instead.
	SkillsRel []string
}

var specs = []Spec{
	{Runtime: "pi", Bin: "pi", Label: "Pi", ConsultCapable: true, RunWorkerCapable: true,
		SteeringRel: []string{".pi", "agent", "AGENTS.md"}},
	{Runtime: "claude", Bin: "claude", Label: "Claude Code", ConsultCapable: true, RunWorkerCapable: true,
		SteeringRel: []string{".claude", "CLAUDE.md"}, SkillsRel: []string{".claude", "skills"}},
	{Runtime: "codex", Bin: "codex", Label: "Codex", ConsultCapable: true, RunWorkerCapable: true,
		SteeringRel: []string{".codex", "AGENTS.md"}, SkillsRel: []string{".codex", "skills"}},
	{Runtime: "opencode", Bin: "opencode", Label: "OpenCode", ConsultCapable: true, RunWorkerCapable: true,
		SteeringRel: []string{".config", "opencode", "AGENTS.md"}, SkillsRel: []string{".config", "opencode", "skills"}},
}

// SteeringPath is the harness's home-level steering file under home.
func (s Spec) SteeringPath(home string) string {
	if len(s.SteeringRel) == 0 {
		return ""
	}
	return filepath.Join(append([]string{home}, s.SteeringRel...)...)
}

// SkillsPath is the harness's skills directory under home, or "" when it scans no fixed directory.
func (s Spec) SkillsPath(home string) string {
	if len(s.SkillsRel) == 0 {
		return ""
	}
	return filepath.Join(append([]string{home}, s.SkillsRel...)...)
}

// ConfigRoot must already exist for a harness to be synced; Arc never creates one, so a harness the
// user has never run is skipped rather than provisioned.
func (s Spec) ConfigRoot(home string) string {
	if len(s.SteeringRel) == 0 {
		return ""
	}
	return filepath.Dir(s.SteeringPath(home))
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `go test ./pkg/harness/ -v`
Expected: PASS, including the pre-existing `TestListExcludesAPIBackends`, `TestCatalogOrderAndPiCapabilities`, and `TestProbeAllBoundedConcurrency` — the struct grew but order and capabilities are unchanged.

- [ ] **Step 5: Point memvault at the catalog instead of its hardcoded paths**

`pkg/memvault/projection.go:100-113` hardcodes `~/.codex/AGENTS.md` and `~/.config/opencode/AGENTS.md`. Replace the body of `steeringTargets` so the catalog is the only place that knows them, keeping the same two runtimes and the same comment above it:

```go
func steeringTargets() []steeringTarget {
	home := wavebase.GetHomeDir()
	var out []steeringTarget
	for _, runtime := range []string{"codex", "opencode"} {
		spec, ok := harness.Lookup(runtime)
		if !ok {
			continue
		}
		out = append(out, steeringTarget{runtime: runtime, path: spec.SteeringPath(home)})
	}
	return out
}
```

Add `"github.com/wavetermdev/waveterm/pkg/harness"` to the imports. `wavebase` is already imported. `pkg/harness` imports only stdlib, so this introduces no cycle. This is a behavior-preserving substitution: the resolved paths are identical, and no existing test asserts them.

- [ ] **Step 6: Run memvault's tests to prove nothing moved**

Run: `go test ./pkg/memvault/ ./pkg/harness/ -v`
Expected: PASS, unchanged from before this task.

- [ ] **Step 7: Stage**

```bash
git add pkg/harness/catalog.go pkg/harness/catalog_test.go pkg/memvault/projection.go
```

---

### Task 2: Vault gains steering and skills collections

**Files:**
- Modify: `pkg/memroots/memroots.go` (const block at :29-33, package doc at :4-6)
- Test: `pkg/memroots/memroots_test.go` (append)

**Interfaces:**
- Consumes: `memroots.VaultRoot()` (existing).
- Produces: `memroots.SteeringDocPath() string` → `<vault>/steering/AGENTS.md`, `memroots.SkillsRoot() string` → `<vault>/skills`. Pure helpers `steeringDocIn(vaultRoot string)` and `skillsRootIn(vaultRoot string)` exist for tests, matching the existing `buildMirrors` / `buildAllRoots` pattern of testing pure helpers rather than the config-reading wrappers.

- [ ] **Step 1: Write the failing test**

```bash
cat >> pkg/memroots/memroots_test.go <<'EOF'

func TestVaultCollectionsAreSiblings(t *testing.T) {
	root := filepath.Join("/home/u", ".waveterm", "vault")
	if got, want := steeringDocIn(root), filepath.Join(root, "steering", "AGENTS.md"); got != want {
		t.Errorf("steeringDocIn = %q, want %q", got, want)
	}
	if got, want := skillsRootIn(root), filepath.Join(root, "skills"); got != want {
		t.Errorf("skillsRootIn = %q, want %q", got, want)
	}
	if skillsRootIn(root) == filepath.Join(root, memoryColl) {
		t.Error("skills collection must not alias the memory collection")
	}
}
EOF
```

`memroots_test.go` already imports `path/filepath` and `testing`, so no import edit is needed here.

- [ ] **Step 2: Run the test to verify it fails**

Run: `go test ./pkg/memroots/ -run TestVaultCollectionsAreSiblings -v`
Expected: FAIL to compile — `undefined: steeringDocIn`.

- [ ] **Step 3: Implement**

In `pkg/memroots/memroots.go`, extend the const block and add four functions below `MemoryRoot`:

```go
const (
	vaultSubpath  = ".waveterm/vault"
	legacySubpath = ".waveterm/memory"
	memoryColl    = "memory"
	steeringColl  = "steering"
	skillsColl    = "skills"
)

func steeringDocIn(vaultRoot string) string {
	return filepath.Join(vaultRoot, steeringColl, "AGENTS.md")
}

func skillsRootIn(vaultRoot string) string {
	return filepath.Join(vaultRoot, skillsColl)
}

// SteeringDocPath is the canonical steering document, projected into every harness's steering file.
func SteeringDocPath() string {
	return steeringDocIn(VaultRoot())
}

// SkillsRoot is the canonical skills collection; each subdirectory is one skill tree.
func SkillsRoot() string {
	return skillsRootIn(VaultRoot())
}
```

Widen the package doc's first line so the charter matches what the package now holds — change
"the single registry of durable-knowledge locations" to "the single registry of Wave Vault
locations", leaving the rest of the comment as it is.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `go test ./pkg/memroots/ -v`
Expected: PASS, all tests.

- [ ] **Step 5: Stage**

```bash
git add pkg/memroots/memroots.go pkg/memroots/memroots_test.go
```

---

### Task 3: Steering region placement (pure)

**Files:**
- Create: `pkg/agentsync/steering.go`
- Test: `pkg/agentsync/steering_test.go`

**Interfaces:**
- Consumes: nothing.
- Produces: `applyRegion(existing, body string) string` and the marker constants `steeringBegin`, `steeringEnd`, `memoryBeginMarker`. Task 4 and Task 8 both call `applyRegion`; Task 10 calls `blockBefore`.

Placement rules, in order: replace an existing `ARC-STEERING` region in place; else insert before an existing `ARC-MEMORY:BEGIN` marker; else append. The middle rule exists because codex's memory region is 438 lines and appending would bury the preferences below it.

- [ ] **Step 1: Write the failing test**

Create `pkg/agentsync/steering_test.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package agentsync

import (
	"strings"
	"testing"
)

func TestApplyRegionAppendsWhenAbsent(t *testing.T) {
	got := applyRegion("# Notes\n\nsome hand-written text\n", "canonical body")
	if !strings.HasPrefix(got, "# Notes\n\nsome hand-written text\n") {
		t.Fatalf("existing content not preserved: %q", got)
	}
	if !strings.Contains(got, steeringBegin) || !strings.Contains(got, "canonical body") {
		t.Fatalf("region not appended: %q", got)
	}
}

func TestApplyRegionInsertsBeforeMemoryRegion(t *testing.T) {
	existing := "# Prefs\n\n<!-- ARC-MEMORY:BEGIN project=waveterm -->\nfacts\n<!-- ARC-MEMORY:END -->\n"
	got := applyRegion(existing, "canonical body")
	steerAt := strings.Index(got, steeringBegin)
	memAt := strings.Index(got, memoryBeginMarker)
	if steerAt < 0 || memAt < 0 || steerAt > memAt {
		t.Fatalf("steering region must precede the memory region: steer=%d mem=%d\n%s", steerAt, memAt, got)
	}
	if !strings.Contains(got, "facts") {
		t.Fatal("memory region body was lost")
	}
}

func TestApplyRegionReplacesInPlaceAndIsIdempotent(t *testing.T) {
	existing := "# Prefs\n\n<!-- ARC-MEMORY:BEGIN project=waveterm -->\nfacts\n<!-- ARC-MEMORY:END -->\n"
	once := applyRegion(existing, "first")
	updated := applyRegion(once, "second")
	if strings.Contains(updated, "first") {
		t.Fatalf("stale body survived the replace: %q", updated)
	}
	if strings.Count(updated, steeringBegin) != 1 {
		t.Fatalf("region duplicated: %q", updated)
	}
	if again := applyRegion(updated, "second"); again != updated {
		t.Fatalf("not idempotent:\nfirst:  %q\nsecond: %q", updated, again)
	}
}

func TestBlockBeforeReturnsHandWrittenPrefix(t *testing.T) {
	existing := "# Prefs\nrule one\n\n<!-- ARC-MEMORY:BEGIN project=x -->\nfacts\n<!-- ARC-MEMORY:END -->\n"
	if got, want := blockBefore(existing), "# Prefs\nrule one\n"; strings.TrimSpace(got) != strings.TrimSpace(want) {
		t.Fatalf("blockBefore = %q, want %q", got, want)
	}
	if got := blockBefore("no markers here\n"); strings.TrimSpace(got) != "no markers here" {
		t.Fatalf("blockBefore without markers = %q", got)
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `go test ./pkg/agentsync/ -v`
Expected: FAIL — the package does not exist yet (`no Go files in ...`), or `undefined: applyRegion` once the file is created.

- [ ] **Step 3: Implement**

Create `pkg/agentsync/steering.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Package agentsync projects the Wave Vault's canonical steering document and skills into every
// installed harness: a delimited region in each harness's home-level steering file, and one
// directory junction per skill in each harness's skills directory. One direction only — nothing is
// harvested back, and no harness's own enable/disable state is ever written.
// See docs/superpowers/specs/2026-09-07-harness-config-sync-design.md.
package agentsync

import "strings"

const (
	steeringBegin     = "<!-- ARC-STEERING:BEGIN (generated — do not edit; managed by Arc) -->"
	steeringEnd       = "<!-- ARC-STEERING:END -->"
	memoryBeginMarker = "<!-- ARC-MEMORY:BEGIN"
)

func renderRegion(body string) string {
	return steeringBegin + "\n" + strings.TrimRight(body, "\n") + "\n" + steeringEnd + "\n"
}

// applyRegion returns existing with the ARC-STEERING region set to body. Content outside the markers
// is untouched. A fresh region is inserted BEFORE any ARC-MEMORY region rather than appended, so the
// preferences are not buried under a memory projection that can run to hundreds of lines.
func applyRegion(existing, body string) string {
	region := renderRegion(body)
	if start := strings.Index(existing, steeringBegin); start >= 0 {
		rest := existing[start:]
		if endIdx := strings.Index(rest, steeringEnd); endIdx >= 0 {
			tail := rest[endIdx+len(steeringEnd):]
			return existing[:start] + region + strings.TrimPrefix(tail, "\n")
		}
	}
	if mem := strings.Index(existing, memoryBeginMarker); mem >= 0 {
		return existing[:mem] + region + "\n" + existing[mem:]
	}
	if strings.TrimSpace(existing) == "" {
		return region
	}
	return strings.TrimRight(existing, "\n") + "\n\n" + region
}

// blockBefore is the hand-written content ahead of any managed region — what adoption folds into the
// canonical document and then replaces.
func blockBefore(existing string) string {
	cut := len(existing)
	for _, marker := range []string{steeringBegin, memoryBeginMarker} {
		if idx := strings.Index(existing, marker); idx >= 0 && idx < cut {
			cut = idx
		}
	}
	return existing[:cut]
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `go test ./pkg/agentsync/ -v`
Expected: PASS, 4 tests.

- [ ] **Step 5: Stage**

```bash
git add pkg/agentsync/steering.go pkg/agentsync/steering_test.go
```

---

### Task 4: Project the canonical steering doc onto disk

**Files:**
- Create: `pkg/agentsync/agentsync.go`
- Test: `pkg/agentsync/agentsync_test.go`

**Interfaces:**
- Consumes: `applyRegion` (Task 3), `harness.List()` / `Spec.SteeringPath` / `Spec.ConfigRoot` (Task 1), `memroots.SteeringDocPath()` / `SkillsRoot()` (Task 2).
- Produces: `type Paths struct { Home, SteeringDoc, SkillsRoot string }`, `func DefaultPaths() Paths`, `type Action struct { Kind, Runtime, Path, Detail string }` with kind constants `ActionSteeringWrite`, `ActionLinkCreate`, `ActionLinkRetarget`, `ActionLinkRemove`, `ActionSkillConflict`, and `func projectSteering(p Paths, dryRun bool) ([]Action, error)`. Every later filesystem task takes a `Paths` so tests can pass a temp home instead of stubbing globals.

- [ ] **Step 1: Write the failing test**

Create `pkg/agentsync/agentsync_test.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package agentsync

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// testPaths builds a temp home with a canonical steering doc and the given harness config roots.
func testPaths(t *testing.T, canonical string, configRoots ...string) Paths {
	t.Helper()
	home := t.TempDir()
	vault := filepath.Join(home, "vault")
	steeringDoc := filepath.Join(vault, "steering", "AGENTS.md")
	if err := os.MkdirAll(filepath.Dir(steeringDoc), 0o755); err != nil {
		t.Fatal(err)
	}
	if canonical != "" {
		if err := os.WriteFile(steeringDoc, []byte(canonical), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	for _, rel := range configRoots {
		if err := os.MkdirAll(filepath.Join(home, filepath.FromSlash(rel)), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	return Paths{Home: home, SteeringDoc: steeringDoc, SkillsRoot: filepath.Join(vault, "skills")}
}

func writeFile(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func readFile(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestProjectSteeringSkipsAbsentHarnesses(t *testing.T) {
	p := testPaths(t, "canonical rules\n", ".codex")
	actions, err := projectSteering(p, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(actions) != 1 || actions[0].Runtime != "codex" {
		t.Fatalf("actions = %+v, want one codex write", actions)
	}
	if _, err := os.Stat(filepath.Join(p.Home, ".pi")); !os.IsNotExist(err) {
		t.Fatal("a harness config root that did not exist must never be created")
	}
}

func TestProjectSteeringInsertsBeforeExistingMemoryRegion(t *testing.T) {
	p := testPaths(t, "canonical rules\n", ".codex")
	target := filepath.Join(p.Home, ".codex", "AGENTS.md")
	if err := os.WriteFile(target, []byte("# old prefs\n\n<!-- ARC-MEMORY:BEGIN project=x -->\nfacts\n<!-- ARC-MEMORY:END -->\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := projectSteering(p, false); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	body := string(got)
	if !strings.Contains(body, "# old prefs") || !strings.Contains(body, "facts") {
		t.Fatalf("existing content lost: %q", body)
	}
	if strings.Index(body, steeringBegin) > strings.Index(body, memoryBeginMarker) {
		t.Fatalf("steering region must come first: %q", body)
	}
}

func TestProjectSteeringIsIdempotentAndDryRunWritesNothing(t *testing.T) {
	p := testPaths(t, "canonical rules\n", ".codex")
	if _, err := projectSteering(p, false); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(p.Home, ".codex", "AGENTS.md")
	first := readFile(t, target)
	actions, err := projectSteering(p, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(actions) != 0 {
		t.Fatalf("second projection reported %+v, want no actions", actions)
	}
	if after := readFile(t, target); after != first {
		t.Fatal("an unchanged projection must not rewrite the file")
	}

	p2 := testPaths(t, "other rules\n", ".codex")
	dryActions, err := projectSteering(p2, true)
	if err != nil {
		t.Fatal(err)
	}
	if len(dryActions) != 1 {
		t.Fatalf("dry run actions = %+v, want one", dryActions)
	}
	if _, err := os.Stat(filepath.Join(p2.Home, ".codex", "AGENTS.md")); !os.IsNotExist(err) {
		t.Fatal("dry run must not write")
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `go test ./pkg/agentsync/ -run TestProjectSteering -v`
Expected: FAIL to compile — `undefined: Paths`, `undefined: projectSteering`.

- [ ] **Step 3: Implement**

Create `pkg/agentsync/agentsync.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package agentsync

import (
	"fmt"
	"os"

	"github.com/wavetermdev/waveterm/pkg/harness"
	"github.com/wavetermdev/waveterm/pkg/memroots"
	"github.com/wavetermdev/waveterm/pkg/wavebase"
)

// Paths are the locations one sync run reads and writes. Passed explicitly rather than read from
// globals so tests drive a temp home without stubbing package state.
type Paths struct {
	Home        string
	SteeringDoc string
	SkillsRoot  string
}

func DefaultPaths() Paths {
	return Paths{
		Home:        wavebase.GetHomeDir(),
		SteeringDoc: memroots.SteeringDocPath(),
		SkillsRoot:  memroots.SkillsRoot(),
	}
}

const (
	ActionSteeringWrite = "steering-write"
	ActionLinkCreate    = "link-create"
	ActionLinkRetarget  = "link-retarget"
	ActionLinkRemove    = "link-remove"
	ActionSkillConflict = "skill-conflict"
)

// Action is one change a sync run made, or would make under dryRun.
type Action struct {
	Kind    string `json:"kind"`
	Runtime string `json:"runtime"`
	Path    string `json:"path"`
	Detail  string `json:"detail,omitempty"`
}

// configRootExists gates every write: Arc syncs a harness only once the user has actually run it.
func configRootExists(spec harness.Spec, home string) bool {
	root := spec.ConfigRoot(home)
	if root == "" {
		return false
	}
	st, err := os.Stat(root)
	return err == nil && st.IsDir()
}

// projectSteering writes the canonical body into each present harness's steering region. A render
// identical to what is already on disk is not written, so mtimes stay meaningful for status.
func projectSteering(p Paths, dryRun bool) ([]Action, error) {
	body, err := os.ReadFile(p.SteeringDoc)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil // nothing canonical yet; adoption seeds it
		}
		return nil, fmt.Errorf("reading canonical steering doc: %w", err)
	}
	var actions []Action
	for _, spec := range harness.List() {
		if !configRootExists(spec, p.Home) {
			continue
		}
		target := spec.SteeringPath(p.Home)
		existing, readErr := os.ReadFile(target)
		if readErr != nil && !os.IsNotExist(readErr) {
			return actions, fmt.Errorf("reading %s: %w", target, readErr)
		}
		next := applyRegion(string(existing), string(body))
		if next == string(existing) {
			continue
		}
		actions = append(actions, Action{Kind: ActionSteeringWrite, Runtime: spec.Runtime, Path: target})
		if dryRun {
			continue
		}
		if err := os.WriteFile(target, []byte(next), 0o644); err != nil {
			return actions, fmt.Errorf("writing %s: %w", target, err)
		}
	}
	return actions, nil
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `go test ./pkg/agentsync/ -v`
Expected: PASS, 7 tests.

- [ ] **Step 5: Stage**

```bash
git add pkg/agentsync/agentsync.go pkg/agentsync/agentsync_test.go
```

---

### Task 5: Link primitives (junction on Windows, symlink elsewhere)

**Files:**
- Create: `pkg/agentsync/link.go`
- Create: `pkg/agentsync/link_windows.go`
- Create: `pkg/agentsync/link_other.go`
- Test: `pkg/agentsync/link_test.go`

**Interfaces:**
- Consumes: nothing.
- Produces: `createLink(link, target string) error`, `isLink(path string) bool`, `linkTarget(path string) (string, error)`, `removeLink(path string) error`, `normalizeTarget(p string) string`, `sameTarget(a, b string) bool`, `withinRoot(target, root string) bool`. Tasks 6-10 use these and never call `os.Symlink` or `os.RemoveAll` on a link directly.

Windows uses `mklink /J` because a junction needs no privilege, whereas `os.Symlink` requires Developer Mode or `SeCreateSymbolicLinkPrivilege`. `os.Readlink` returns a `\\?\`-prefixed target for a junction, which `normalizeTarget` strips.

- [ ] **Step 1: Write the failing test**

Create `pkg/agentsync/link_test.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package agentsync

import (
	"os"
	"path/filepath"
	"testing"
)

func TestCreateReadRemoveLink(t *testing.T) {
	root := t.TempDir()
	target := filepath.Join(root, "canonical")
	if err := os.MkdirAll(target, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(target, "SKILL.md"), []byte("body"), 0o644); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(root, "linked")
	if err := createLink(link, target); err != nil {
		t.Fatal(err)
	}
	if !isLink(link) {
		t.Fatal("createLink did not produce a link")
	}
	got, err := linkTarget(link)
	if err != nil {
		t.Fatal(err)
	}
	if !sameTarget(got, target) {
		t.Fatalf("linkTarget = %q, want %q", got, target)
	}
	// the link is traversable: this is the assumption the whole skills half rests on
	if _, err := os.ReadFile(filepath.Join(link, "SKILL.md")); err != nil {
		t.Fatalf("reading through the link: %v", err)
	}
	if err := removeLink(link); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(target, "SKILL.md")); err != nil {
		t.Fatalf("removing the link destroyed the target: %v", err)
	}
}

func TestRemoveLinkRefusesRealDirectory(t *testing.T) {
	root := t.TempDir()
	real := filepath.Join(root, "real")
	if err := os.MkdirAll(real, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := removeLink(real); err == nil {
		t.Fatal("removeLink must refuse a real directory")
	}
	if _, err := os.Stat(real); err != nil {
		t.Fatalf("the real directory was removed anyway: %v", err)
	}
}

func TestNormalizeAndWithinRoot(t *testing.T) {
	root := filepath.Join("C:", "vault", "skills")
	if !withinRoot(filepath.Join(root, "graphify"), root) {
		t.Error("a skill under the root must be within it")
	}
	if withinRoot(filepath.Join("C:", "elsewhere", "graphify"), root) {
		t.Error("a path outside the root must not be within it")
	}
	if !sameTarget(`\\?\C:\vault\skills\x`, `C:\vault\skills\x`) {
		t.Error("the \\\\?\\ prefix must not defeat comparison")
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `go test ./pkg/agentsync/ -run 'Link|WithinRoot' -v`
Expected: FAIL to compile — `undefined: createLink`.

- [ ] **Step 3: Implement**

Create `pkg/agentsync/link.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package agentsync

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// isLink reports whether path is a reparse point (junction or symlink), never following it.
func isLink(path string) bool {
	fi, err := os.Lstat(path)
	return err == nil && fi.Mode()&os.ModeSymlink != 0
}

// linkTarget resolves what a link points at. Windows junctions read back \\?\-prefixed.
func linkTarget(path string) (string, error) {
	t, err := os.Readlink(path)
	if err != nil {
		return "", err
	}
	return normalizeTarget(t), nil
}

func normalizeTarget(p string) string {
	return filepath.Clean(strings.TrimPrefix(p, `\\?\`))
}

// sameTarget compares two link targets case-insensitively: these paths live on Windows, where the
// filesystem is, and both sides are Arc-generated so the looseness costs nothing.
func sameTarget(a, b string) bool {
	return strings.EqualFold(normalizeTarget(a), normalizeTarget(b))
}

// withinRoot reports whether target lives under root — the test for "this junction is ours".
func withinRoot(target, root string) bool {
	rel, err := filepath.Rel(normalizeTarget(root), normalizeTarget(target))
	if err != nil {
		return false
	}
	return rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

// removeLink deletes the link itself and refuses anything that is not one. A recursive delete that
// follows a junction destroys the target's contents — the hazard documented in
// scripts/worktree-junctions.mjs. Never replace this with os.RemoveAll.
func removeLink(path string) error {
	if !isLink(path) {
		return fmt.Errorf("refusing to remove %q: not a link", path)
	}
	return os.Remove(path)
}
```

Create `pkg/agentsync/link_windows.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

//go:build windows

package agentsync

import (
	"fmt"
	"os/exec"
	"strings"
)

// createLink makes a directory junction. mklink /J needs no privilege, whereas os.Symlink requires
// Developer Mode or SeCreateSymbolicLinkPrivilege and would fail on a stock machine.
func createLink(link, target string) error {
	out, err := exec.Command("cmd", "/c", "mklink", "/J", link, target).CombinedOutput()
	if err != nil {
		return fmt.Errorf("mklink /J %q -> %q: %w (%s)", link, target, err, strings.TrimSpace(string(out)))
	}
	return nil
}
```

Create `pkg/agentsync/link_other.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

//go:build !windows

package agentsync

import "os"

func createLink(link, target string) error {
	return os.Symlink(target, link)
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `go test ./pkg/agentsync/ -v`
Expected: PASS. `TestCreateReadRemoveLink` reading `SKILL.md` through the link is the manual confirmation the spec's third risk asked for — junction traversal works.

- [ ] **Step 5: Stage**

```bash
git add pkg/agentsync/link.go pkg/agentsync/link_windows.go pkg/agentsync/link_other.go pkg/agentsync/link_test.go
```

---

### Task 6: Skills reconcile plan (pure)

**Files:**
- Create: `pkg/agentsync/skills.go`
- Test: `pkg/agentsync/skills_test.go`

**Interfaces:**
- Consumes: `sameTarget`, `withinRoot` (Task 5).
- Produces: `type ObservedEntry struct { Name string; IsLink bool; Target string }`, `type SkillAction struct { Kind, Name string }` with kinds `"create"`, `"retarget"`, `"remove"`, `"conflict"`, and `planSkills(canonical []string, observed []ObservedEntry, skillsRoot string) []SkillAction`. Task 7 executes this plan.

- [ ] **Step 1: Write the failing test**

Create `pkg/agentsync/skills_test.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package agentsync

import (
	"path/filepath"
	"testing"
)

func TestPlanSkillsCoversEveryObservedState(t *testing.T) {
	root := filepath.Join("C:", "vault", "skills")
	canonical := []string{"correct", "missing", "retarget-me", "occupied"}
	observed := []ObservedEntry{
		{Name: "correct", IsLink: true, Target: filepath.Join(root, "correct")},
		{Name: "retarget-me", IsLink: true, Target: filepath.Join("C:", "old", "retarget-me")},
		{Name: "occupied", IsLink: false},
		{Name: "orphan", IsLink: true, Target: filepath.Join(root, "orphan")},
		{Name: "not-ours", IsLink: true, Target: filepath.Join("C:", "somewhere", "not-ours")},
	}
	got := planSkills(canonical, observed, root)
	want := []SkillAction{
		{Kind: "create", Name: "missing"},
		{Kind: "retarget", Name: "retarget-me"},
		{Kind: "conflict", Name: "occupied"},
		{Kind: "remove", Name: "orphan"},
	}
	if len(got) != len(want) {
		t.Fatalf("plan = %+v, want %+v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("action %d = %+v, want %+v", i, got[i], want[i])
		}
	}
}

func TestPlanSkillsLeavesForeignLinksAlone(t *testing.T) {
	root := filepath.Join("C:", "vault", "skills")
	observed := []ObservedEntry{{Name: "plugin-skill", IsLink: true, Target: filepath.Join("C:", "plugins", "cache", "plugin-skill")}}
	if got := planSkills(nil, observed, root); len(got) != 0 {
		t.Fatalf("plan = %+v, want nothing: a link outside the vault is not ours", got)
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `go test ./pkg/agentsync/ -run TestPlanSkills -v`
Expected: FAIL to compile — `undefined: ObservedEntry`.

- [ ] **Step 3: Implement**

Create `pkg/agentsync/skills.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package agentsync

import "path/filepath"

// ObservedEntry is one entry in a harness's skills directory as it exists on disk.
type ObservedEntry struct {
	Name   string
	IsLink bool
	Target string // resolved link target; empty when the entry is not a link
}

// SkillAction is one reconcile step for a single skill name.
type SkillAction struct {
	Kind string // create | retarget | remove | conflict
	Name string
}

// planSkills reconciles one harness's skills directory against the canonical set. A real directory
// is reported as a conflict and never touched — adoption resolves those. A link that points outside
// the vault belongs to someone else (a plugin manager, the user) and is left alone entirely.
// Order is stable: canonical order first, then orphan removals in observed order.
func planSkills(canonical []string, observed []ObservedEntry, skillsRoot string) []SkillAction {
	byName := make(map[string]ObservedEntry, len(observed))
	for _, e := range observed {
		byName[e.Name] = e
	}
	wanted := make(map[string]bool, len(canonical))
	var out []SkillAction
	for _, name := range canonical {
		wanted[name] = true
		e, present := byName[name]
		switch {
		case !present:
			out = append(out, SkillAction{Kind: "create", Name: name})
		case !e.IsLink:
			out = append(out, SkillAction{Kind: "conflict", Name: name})
		case !sameTarget(e.Target, filepath.Join(skillsRoot, name)):
			out = append(out, SkillAction{Kind: "retarget", Name: name})
		}
	}
	for _, e := range observed {
		if wanted[e.Name] || !e.IsLink {
			continue
		}
		if withinRoot(e.Target, skillsRoot) {
			out = append(out, SkillAction{Kind: "remove", Name: e.Name})
		}
	}
	return out
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `go test ./pkg/agentsync/ -v`
Expected: PASS.

- [ ] **Step 5: Stage**

```bash
git add pkg/agentsync/skills.go pkg/agentsync/skills_test.go
```

---

### Task 7: Execute the skills plan on disk

**Files:**
- Modify: `pkg/agentsync/skills.go` (append)
- Test: `pkg/agentsync/skills_test.go` (append)

**Interfaces:**
- Consumes: `planSkills` (Task 6), link primitives (Task 5), `Paths` / `Action` / `configRootExists` (Task 4).
- Produces: `canonicalSkills(skillsRoot string) ([]string, error)`, `observeSkills(dir string) ([]ObservedEntry, error)`, `reconcileSkills(p Paths, dryRun bool) ([]Action, error)`, and `Apply(p Paths, dryRun bool) ([]Action, error)` which runs the steering projection followed by the skills reconciler. Tasks 11 and 12 call `Apply`.

- [ ] **Step 1: Write the failing test**

```bash
cat >> pkg/agentsync/skills_test.go <<'EOF'

// seedSkill creates a canonical skill tree in the vault.
func seedSkill(t *testing.T, p Paths, name string) {
	t.Helper()
	dir := filepath.Join(p.SkillsRoot, name)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "SKILL.md"), []byte("---\nname: "+name+"\n---\nbody\n"), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestReconcileSkillsLinksIntoPresentHarnesses(t *testing.T) {
	p := testPaths(t, "canonical\n", ".codex", ".claude")
	seedSkill(t, p, "graphify")
	actions, err := reconcileSkills(p, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(actions) != 2 {
		t.Fatalf("actions = %+v, want one link per present harness", actions)
	}
	for _, rel := range []string{filepath.Join(".codex", "skills", "graphify"), filepath.Join(".claude", "skills", "graphify")} {
		link := filepath.Join(p.Home, rel)
		if !isLink(link) {
			t.Errorf("%s is not a link", rel)
		}
		if _, err := os.ReadFile(filepath.Join(link, "SKILL.md")); err != nil {
			t.Errorf("reading through %s: %v", rel, err)
		}
	}
	// pi has no fixed skills dir, so nothing is created for it even when its config root exists
	if _, err := os.Stat(filepath.Join(p.Home, ".pi", "agent", "skills")); !os.IsNotExist(err) {
		t.Error("pi must not get a skills directory")
	}
}

func TestReconcileSkillsIsIdempotentAndReportsConflicts(t *testing.T) {
	p := testPaths(t, "canonical\n", ".codex")
	seedSkill(t, p, "graphify")
	if _, err := reconcileSkills(p, false); err != nil {
		t.Fatal(err)
	}
	again, err := reconcileSkills(p, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(again) != 0 {
		t.Fatalf("second reconcile = %+v, want no actions", again)
	}

	// a real directory occupying a canonical name is reported, never replaced
	p2 := testPaths(t, "canonical\n", ".codex")
	seedSkill(t, p2, "graphify")
	occupied := filepath.Join(p2.Home, ".codex", "skills", "graphify")
	if err := os.MkdirAll(occupied, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(occupied, "SKILL.md"), []byte("mine"), 0o644); err != nil {
		t.Fatal(err)
	}
	acts, err := reconcileSkills(p2, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(acts) != 1 || acts[0].Kind != ActionSkillConflict {
		t.Fatalf("actions = %+v, want a single conflict", acts)
	}
	body, err := os.ReadFile(filepath.Join(occupied, "SKILL.md"))
	if err != nil || string(body) != "mine" {
		t.Fatalf("the user's directory was modified: %q %v", body, err)
	}
}
EOF
```

Add `"os"` to the import block of `pkg/agentsync/skills_test.go` (it currently imports only `path/filepath` and `testing`).

- [ ] **Step 2: Run the test to verify it fails**

Run: `go test ./pkg/agentsync/ -run TestReconcileSkills -v`
Expected: FAIL to compile — `undefined: reconcileSkills`.

- [ ] **Step 3: Implement**

Append to `pkg/agentsync/skills.go` (add `"fmt"`, `"os"`, `"sort"` and the `harness` import to its import block):

```go
// canonicalSkills lists the vault's skill directories, sorted for a deterministic plan.
func canonicalSkills(skillsRoot string) ([]string, error) {
	entries, err := os.ReadDir(skillsRoot)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("reading canonical skills: %w", err)
	}
	var names []string
	for _, e := range entries {
		if e.IsDir() {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)
	return names, nil
}

// observeSkills reads a harness's skills directory without following links.
func observeSkills(dir string) ([]ObservedEntry, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("reading %s: %w", dir, err)
	}
	out := make([]ObservedEntry, 0, len(entries))
	for _, e := range entries {
		path := filepath.Join(dir, e.Name())
		entry := ObservedEntry{Name: e.Name(), IsLink: isLink(path)}
		if entry.IsLink {
			target, err := linkTarget(path)
			if err != nil {
				// an unreadable link is treated as foreign and left alone
				continue
			}
			entry.Target = target
		}
		out = append(out, entry)
	}
	return out, nil
}

// reconcileSkills junctions every canonical skill into each present harness that scans a fixed
// skills directory. The skills directory itself is created when missing: that is Arc's own target,
// unlike the harness config root, which Arc never creates.
func reconcileSkills(p Paths, dryRun bool) ([]Action, error) {
	canonical, err := canonicalSkills(p.SkillsRoot)
	if err != nil {
		return nil, err
	}
	var actions []Action
	for _, spec := range harness.List() {
		dir := spec.SkillsPath(p.Home)
		if dir == "" || !configRootExists(spec, p.Home) {
			continue
		}
		observed, err := observeSkills(dir)
		if err != nil {
			return actions, err
		}
		for _, a := range planSkills(canonical, observed, p.SkillsRoot) {
			link := filepath.Join(dir, a.Name)
			if a.Kind == "conflict" {
				actions = append(actions, Action{Kind: ActionSkillConflict, Runtime: spec.Runtime, Path: link, Detail: "real directory; run adopt"})
				continue
			}
			actions = append(actions, Action{Kind: actionKindFor(a.Kind), Runtime: spec.Runtime, Path: link})
			if dryRun {
				continue
			}
			if err := applySkillAction(a.Kind, dir, link, filepath.Join(p.SkillsRoot, a.Name)); err != nil {
				return actions, err
			}
		}
	}
	return actions, nil
}

func actionKindFor(kind string) string {
	switch kind {
	case "create":
		return ActionLinkCreate
	case "retarget":
		return ActionLinkRetarget
	default:
		return ActionLinkRemove
	}
}

func applySkillAction(kind, dir, link, target string) error {
	switch kind {
	case "create":
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return fmt.Errorf("creating %s: %w", dir, err)
		}
		return createLink(link, target)
	case "retarget":
		if err := removeLink(link); err != nil {
			return err
		}
		return createLink(link, target)
	case "remove":
		return removeLink(link)
	}
	return nil
}

// Apply runs both projections. Steering first: a harness that starts mid-sync should see the rules
// before it sees new skills.
func Apply(p Paths, dryRun bool) ([]Action, error) {
	actions, err := projectSteering(p, dryRun)
	if err != nil {
		return actions, err
	}
	skillActions, err := reconcileSkills(p, dryRun)
	return append(actions, skillActions...), err
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `go test ./pkg/agentsync/ -v`
Expected: PASS, all tests.

- [ ] **Step 5: Stage**

```bash
git add pkg/agentsync/skills.go pkg/agentsync/skills_test.go
```

---

### Task 8: Status

**Files:**
- Create: `pkg/agentsync/status.go`
- Test: `pkg/agentsync/status_test.go`

**Interfaces:**
- Consumes: `applyRegion` (Task 3), `Paths` (Task 4), `canonicalSkills` / `observeSkills` / `planSkills` (Tasks 6-7).
- Produces: `type HarnessStatus struct { Runtime, Label string; Present bool; Steering string; SkillsLinked, SkillsConflict int; Note string }` where `Steering` is one of `"current"`, `"stale"`, `"absent"`; `func Status(p Paths) ([]HarnessStatus, error)`; and the pure helper `piSkillsNote(entries []string, claudeSkills, vaultSkills string) string`. Tasks 11-13 render this.

Pi's row is informational: it has no fixed skills directory, so status reports which path its settings array reaches the farm through, and warns when it reaches neither. Arc never edits pi's settings.

- [ ] **Step 1: Write the failing test**

Create `pkg/agentsync/status_test.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package agentsync

import (
	"os"
	"path/filepath"
	"testing"
)

func TestStatusReportsSteeringState(t *testing.T) {
	p := testPaths(t, "canonical rules\n", ".codex")
	byRuntime := func() map[string]HarnessStatus {
		st, err := Status(p)
		if err != nil {
			t.Fatal(err)
		}
		m := map[string]HarnessStatus{}
		for _, s := range st {
			m[s.Runtime] = s
		}
		return m
	}

	if got := byRuntime()["codex"]; got.Steering != "absent" || !got.Present {
		t.Fatalf("before projection: %+v, want present with absent steering", got)
	}
	if got := byRuntime()["pi"]; got.Present {
		t.Fatalf("pi has no config root here: %+v", got)
	}
	if _, err := Apply(p, false); err != nil {
		t.Fatal(err)
	}
	if got := byRuntime()["codex"]; got.Steering != "current" {
		t.Fatalf("after projection: %+v, want current", got)
	}
	if err := os.WriteFile(p.SteeringDoc, []byte("changed rules\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := byRuntime()["codex"]; got.Steering != "stale" {
		t.Fatalf("after canonical edit: %+v, want stale", got)
	}
}

func TestStatusCountsLinksAndConflicts(t *testing.T) {
	p := testPaths(t, "canonical\n", ".codex")
	seedSkill(t, p, "graphify")
	seedSkill(t, p, "effort-tracking")
	occupied := filepath.Join(p.Home, ".codex", "skills", "graphify")
	if err := os.MkdirAll(occupied, 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := Apply(p, false); err != nil {
		t.Fatal(err)
	}
	st, err := Status(p)
	if err != nil {
		t.Fatal(err)
	}
	for _, s := range st {
		if s.Runtime != "codex" {
			continue
		}
		if s.SkillsLinked != 1 || s.SkillsConflict != 1 {
			t.Fatalf("codex = %+v, want 1 linked and 1 conflict", s)
		}
	}
}

func TestPiSkillsNote(t *testing.T) {
	claudeSkills := filepath.Join("C:", "Users", "k", ".claude", "skills")
	vaultSkills := filepath.Join("C:", "vault", "skills")
	if note := piSkillsNote([]string{claudeSkills, "!" + filepath.Join(claudeSkills, "simplify")}, claudeSkills, vaultSkills); note == "" {
		t.Error("a pointer at the claude skills dir must be reported as reaching the farm")
	}
	if note := piSkillsNote([]string{vaultSkills}, claudeSkills, vaultSkills); note == "" {
		t.Error("a pointer straight at the vault must be reported as reaching the farm")
	}
	if note := piSkillsNote([]string{filepath.Join("C:", "elsewhere")}, claudeSkills, vaultSkills); note == "" {
		t.Error("a pointer at neither must produce a warning note, not an empty one")
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `go test ./pkg/agentsync/ -run 'TestStatus|TestPiSkills' -v`
Expected: FAIL to compile — `undefined: Status`.

- [ ] **Step 3: Implement**

Create `pkg/agentsync/status.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package agentsync

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/harness"
)

// HarnessStatus is one row of the sync view.
type HarnessStatus struct {
	Runtime        string `json:"runtime"`
	Label          string `json:"label"`
	Present        bool   `json:"present"`
	Steering       string `json:"steering"` // current | stale | absent
	SkillsLinked   int    `json:"skillslinked"`
	SkillsConflict int    `json:"skillsconflict"`
	Note           string `json:"note,omitempty"`
}

func Status(p Paths) ([]HarnessStatus, error) {
	canonicalBody, err := os.ReadFile(p.SteeringDoc)
	if err != nil && !os.IsNotExist(err) {
		return nil, err
	}
	canonicalSkillNames, err := canonicalSkills(p.SkillsRoot)
	if err != nil {
		return nil, err
	}
	specs := harness.List()
	out := make([]HarnessStatus, 0, len(specs))
	for _, spec := range specs {
		st := HarnessStatus{Runtime: spec.Runtime, Label: spec.Label, Steering: "absent"}
		st.Present = configRootExists(spec, p.Home)
		if st.Present && len(canonicalBody) > 0 {
			existing, _ := os.ReadFile(spec.SteeringPath(p.Home))
			switch {
			case !strings.Contains(string(existing), steeringBegin):
				st.Steering = "absent"
			case applyRegion(string(existing), string(canonicalBody)) == string(existing):
				st.Steering = "current"
			default:
				st.Steering = "stale"
			}
		}
		if dir := spec.SkillsPath(p.Home); dir != "" && st.Present {
			observed, err := observeSkills(dir)
			if err != nil {
				return nil, err
			}
			for _, e := range observed {
				if e.IsLink && withinRoot(e.Target, p.SkillsRoot) {
					st.SkillsLinked++
				}
			}
			for _, a := range planSkills(canonicalSkillNames, observed, p.SkillsRoot) {
				if a.Kind == "conflict" {
					st.SkillsConflict++
				}
			}
		}
		if spec.Runtime == "pi" && st.Present {
			claudeSkills := ""
			if cl, ok := harness.Lookup("claude"); ok {
				claudeSkills = cl.SkillsPath(p.Home)
			}
			st.Note = piSkillsNote(piSettingsSkills(spec.ConfigRoot(p.Home)), claudeSkills, p.SkillsRoot)
		}
		out = append(out, st)
	}
	return out, nil
}

// piSettingsSkills reads the skills array out of pi's settings. Read-only, always: Arc distributes
// availability, and pi's exclusion entries belong to the user.
func piSettingsSkills(configRoot string) []string {
	data, err := os.ReadFile(filepath.Join(configRoot, "settings.json"))
	if err != nil {
		return nil
	}
	var parsed struct {
		Skills []string `json:"skills"`
	}
	if json.Unmarshal(data, &parsed) != nil {
		return nil
	}
	return parsed.Skills
}

// piSkillsNote describes how pi reaches the synced skills, or warns that it does not. A "!" prefix
// is an exclusion entry, not a search path.
func piSkillsNote(entries []string, claudeSkills, vaultSkills string) string {
	for _, e := range entries {
		if strings.HasPrefix(e, "!") {
			continue
		}
		expanded := e
		if strings.HasPrefix(expanded, "~") {
			expanded = filepath.Join(filepath.Dir(filepath.Dir(claudeSkills)), strings.TrimPrefix(expanded, "~"+string(filepath.Separator)))
		}
		if claudeSkills != "" && sameTarget(expanded, claudeSkills) {
			return "via " + claudeSkills
		}
		if sameTarget(expanded, vaultSkills) {
			return "via the vault directly"
		}
	}
	return "pi settings do not point at the synced skills"
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `go test ./pkg/agentsync/ -v`
Expected: PASS, all tests.

- [ ] **Step 5: Stage**

```bash
git add pkg/agentsync/status.go pkg/agentsync/status_test.go
```

---

### Task 9: Adoption plan (pure)

**Files:**
- Create: `pkg/agentsync/adopt.go`
- Test: `pkg/agentsync/adopt_test.go`

**Interfaces:**
- Consumes: `blockBefore` (Task 3), `Paths` (Task 4).
- Produces: `carriedLines(block, canonical string) []string`, `type CarriedLine struct { Runtime, Line string }`, `type SkillMove struct { Runtime, Name, From string }`, `type SkillCollision struct { Name string; Sources []string }`, `type AdoptPlan struct { SeedFrom string; SeedLines int; Carried []CarriedLine; Moves []SkillMove; Collisions []SkillCollision; Blocked bool; Reasons []string }`, and `collisions(inventory map[string][]SkillMove) []SkillCollision`. Task 10 builds and applies the plan.

A **carried line** is a line that, after trimming, is non-empty and does not appear verbatim anywhere in the canonical doc. Comparison is line-set, not positional, so reordering a rule is not a loss.

- [ ] **Step 1: Write the failing test**

Create `pkg/agentsync/adopt_test.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package agentsync

import (
	"reflect"
	"testing"
)

func TestCarriedLinesFindsOnlyRealLosses(t *testing.T) {
	canonical := "# Prefs\n\n- rule one\n- rule two\n"
	block := "# Prefs\n\n- rule two\n- rule one\n- rule three\n\n"
	got := carriedLines(block, canonical)
	if !reflect.DeepEqual(got, []string{"- rule three"}) {
		t.Fatalf("carriedLines = %#v, want only the genuinely missing rule", got)
	}
	if len(carriedLines("   \n\n"+canonical, canonical)) != 0 {
		t.Fatal("blank lines and reordering must never block adoption")
	}
}

func TestCollisionsRefuseDuplicateNames(t *testing.T) {
	inventory := map[string][]SkillMove{
		"codex":    {{Runtime: "codex", Name: "1devtool-orchestrator", From: `C:\codex\1devtool-orchestrator`}},
		"opencode": {{Runtime: "opencode", Name: "1devtool-orchestrator", From: `C:\opencode\1devtool-orchestrator`}},
		"claude":   {{Runtime: "claude", Name: "graphify", From: `C:\claude\graphify`}},
	}
	got := collisions(inventory)
	if len(got) != 1 || got[0].Name != "1devtool-orchestrator" {
		t.Fatalf("collisions = %+v, want exactly the duplicated name", got)
	}
	if len(got[0].Sources) != 2 {
		t.Fatalf("sources = %v, want both holders named", got[0].Sources)
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `go test ./pkg/agentsync/ -run 'TestCarriedLines|TestCollisions' -v`
Expected: FAIL to compile — `undefined: carriedLines`.

- [ ] **Step 3: Implement**

Create `pkg/agentsync/adopt.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package agentsync

import (
	"sort"
	"strings"
)

// CarriedLine is a line a harness holds that the canonical document does not. Adoption refuses to
// apply while any exists, because seeding from one harness would otherwise delete another's rules.
type CarriedLine struct {
	Runtime string `json:"runtime"`
	Line    string `json:"line"`
}

// SkillMove relocates one harness-local skill tree into the vault.
type SkillMove struct {
	Runtime string `json:"runtime"`
	Name    string `json:"name"`
	From    string `json:"from"`
}

// SkillCollision is one skill name held by more than one harness. Never merged automatically.
type SkillCollision struct {
	Name    string   `json:"name"`
	Sources []string `json:"sources"`
}

type AdoptPlan struct {
	SeedFrom   string           `json:"seedfrom"`
	SeedLines  int              `json:"seedlines"`
	Carried    []CarriedLine    `json:"carried"`
	Moves      []SkillMove      `json:"moves"`
	Collisions []SkillCollision `json:"collisions"`
	Blocked    bool             `json:"blocked"`
	Reasons    []string         `json:"reasons,omitempty"`
}

// carriedLines returns block's lines that are absent from canonical, compared as a trimmed set so
// reordering and whitespace never register as a loss.
func carriedLines(block, canonical string) []string {
	have := map[string]bool{}
	for _, l := range strings.Split(canonical, "\n") {
		have[strings.TrimSpace(l)] = true
	}
	seen := map[string]bool{}
	var out []string
	for _, l := range strings.Split(block, "\n") {
		t := strings.TrimSpace(l)
		if t == "" || have[t] || seen[t] {
			continue
		}
		seen[t] = true
		out = append(out, t)
	}
	return out
}

// collisions reports every skill name claimed by more than one harness, sorted for stable output.
func collisions(inventory map[string][]SkillMove) []SkillCollision {
	holders := map[string][]string{}
	for _, moves := range inventory {
		for _, m := range moves {
			holders[m.Name] = append(holders[m.Name], m.Runtime+":"+m.From)
		}
	}
	var out []SkillCollision
	for name, sources := range holders {
		if len(sources) < 2 {
			continue
		}
		sort.Strings(sources)
		out = append(out, SkillCollision{Name: name, Sources: sources})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `go test ./pkg/agentsync/ -v`
Expected: PASS.

- [ ] **Step 5: Stage**

```bash
git add pkg/agentsync/adopt.go pkg/agentsync/adopt_test.go
```

---

### Task 10: Adoption on disk

**Files:**
- Modify: `pkg/agentsync/adopt.go` (append)
- Test: `pkg/agentsync/adopt_test.go` (append)

**Interfaces:**
- Consumes: everything from Tasks 3-9.
- Produces: `func PlanAdopt(p Paths) (AdoptPlan, error)` and `func Adopt(p Paths, apply bool, prefer map[string]string, acceptLoss bool) (AdoptPlan, error)`. `prefer` maps a skill name to the runtime whose copy wins. Tasks 11-12 expose both.

`Adopt` order: seed canonical from claude's steering file when the vault has none; build the plan; refuse when blocked; back up each rewritten file as `<file>.bak`; strip each harness's hand-written block and write the region; move skills into the vault; then run `Apply` so everything is linked.

- [ ] **Step 1: Write the failing test**

```bash
cat >> pkg/agentsync/adopt_test.go <<'EOF'

func TestAdoptRefusesToDropACarriedRule(t *testing.T) {
	p := testPaths(t, "", ".claude", ".pi/agent")
	writeFile(t, filepath.Join(p.Home, ".claude", "CLAUDE.md"), "# Prefs\n- rule one\n")
	writeFile(t, filepath.Join(p.Home, ".pi", "agent", "AGENTS.md"), "# Prefs\n- rule one\n- pi only rule\n")

	plan, err := Adopt(p, true, nil, false)
	if err == nil {
		t.Fatal("apply must refuse while a carried line exists")
	}
	if !plan.Blocked || len(plan.Carried) != 1 || plan.Carried[0].Line != "- pi only rule" {
		t.Fatalf("plan = %+v, want the pi-only rule reported", plan)
	}
	body := readFile(t, filepath.Join(p.Home, ".pi", "agent", "AGENTS.md"))
	if !strings.Contains(body, "- pi only rule") {
		t.Fatal("a refused adoption must not have modified anything")
	}
}

func TestAdoptSeedsProjectsAndBacksUp(t *testing.T) {
	p := testPaths(t, "", ".claude", ".pi/agent")
	writeFile(t, filepath.Join(p.Home, ".claude", "CLAUDE.md"), "# Prefs\n- rule one\n")
	writeFile(t, filepath.Join(p.Home, ".pi", "agent", "AGENTS.md"), "# Prefs\n- rule one\n")

	if _, err := Adopt(p, true, nil, false); err != nil {
		t.Fatal(err)
	}
	canonical := readFile(t, p.SteeringDoc)
	if !strings.Contains(canonical, "- rule one") {
		t.Fatalf("canonical not seeded: %q", canonical)
	}
	pi := readFile(t, filepath.Join(p.Home, ".pi", "agent", "AGENTS.md"))
	if !strings.Contains(pi, steeringBegin) || strings.Count(pi, "- rule one") != 1 {
		t.Fatalf("pi steering not replaced by the region: %q", pi)
	}
	if _, err := os.Stat(filepath.Join(p.Home, ".pi", "agent", "AGENTS.md.bak")); err != nil {
		t.Fatalf("no backup written: %v", err)
	}
}

func TestAdoptMovesSkillsAndRefusesCollisions(t *testing.T) {
	p := testPaths(t, "", ".claude", ".codex")
	writeFile(t, filepath.Join(p.Home, ".claude", "CLAUDE.md"), "# Prefs\n")
	writeFile(t, filepath.Join(p.Home, ".claude", "skills", "graphify", "SKILL.md"), "claude copy\n")
	writeFile(t, filepath.Join(p.Home, ".codex", "skills", "graphify", "SKILL.md"), "codex copy\n")

	if _, err := Adopt(p, true, nil, false); err == nil {
		t.Fatal("a duplicated skill name must block apply")
	}
	if _, err := Adopt(p, true, map[string]string{"graphify": "codex"}, false); err != nil {
		t.Fatal(err)
	}
	if got := readFile(t, filepath.Join(p.SkillsRoot, "graphify", "SKILL.md")); got != "codex copy\n" {
		t.Fatalf("canonical skill = %q, want the preferred copy", got)
	}
	for _, rel := range []string{filepath.Join(".claude", "skills", "graphify"), filepath.Join(".codex", "skills", "graphify")} {
		if !isLink(filepath.Join(p.Home, rel)) {
			t.Errorf("%s was not junctioned back", rel)
		}
	}
}
EOF
```

`writeFile`, `readFile`, and `testPaths` already exist in `agentsync_test.go` from Task 4 — same
package, so use them rather than redefining. Extend `adopt_test.go`'s imports to
`"os"`, `"path/filepath"`, `"reflect"`, `"strings"`, `"testing"`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `go test ./pkg/agentsync/ -run TestAdopt -v`
Expected: FAIL to compile — `undefined: Adopt`.

- [ ] **Step 3: Implement**

Append to `pkg/agentsync/adopt.go` (extend its imports with `"fmt"`, `"os"`, `"path/filepath"`, and the `harness` package):

```go
// seedRuntime is the harness whose steering file seeds the canonical document when the vault has
// none. Claude by decision: it is where the user authors these rules today.
const seedRuntime = "claude"

// PlanAdopt reports what adoption would do, including everything that would block it.
func PlanAdopt(p Paths) (AdoptPlan, error) {
	plan := AdoptPlan{}
	canonical, err := os.ReadFile(p.SteeringDoc)
	if err != nil && !os.IsNotExist(err) {
		return plan, err
	}
	if len(canonical) == 0 {
		spec, ok := harness.Lookup(seedRuntime)
		if !ok {
			return plan, fmt.Errorf("seed harness %q missing from the catalog", seedRuntime)
		}
		seed, readErr := os.ReadFile(spec.SteeringPath(p.Home))
		if readErr != nil {
			return plan, fmt.Errorf("no canonical doc and no %s steering file to seed from: %w", seedRuntime, readErr)
		}
		canonical = []byte(blockBefore(string(seed)))
		plan.SeedFrom = spec.SteeringPath(p.Home)
	}
	plan.SeedLines = len(strings.Split(strings.TrimRight(string(canonical), "\n"), "\n"))

	inventory := map[string][]SkillMove{}
	for _, spec := range harness.List() {
		if !configRootExists(spec, p.Home) {
			continue
		}
		existing, _ := os.ReadFile(spec.SteeringPath(p.Home))
		for _, line := range carriedLines(blockBefore(string(existing)), string(canonical)) {
			plan.Carried = append(plan.Carried, CarriedLine{Runtime: spec.Runtime, Line: line})
		}
		dir := spec.SkillsPath(p.Home)
		if dir == "" {
			continue
		}
		observed, err := observeSkills(dir)
		if err != nil {
			return plan, err
		}
		for _, e := range observed {
			if e.IsLink {
				continue // already managed, or someone else's
			}
			inventory[spec.Runtime] = append(inventory[spec.Runtime], SkillMove{Runtime: spec.Runtime, Name: e.Name, From: filepath.Join(dir, e.Name)})
		}
	}
	plan.Collisions = collisions(inventory)
	for _, moves := range inventory {
		plan.Moves = append(plan.Moves, moves...)
	}
	sort.Slice(plan.Moves, func(i, j int) bool {
		if plan.Moves[i].Name != plan.Moves[j].Name {
			return plan.Moves[i].Name < plan.Moves[j].Name
		}
		return plan.Moves[i].Runtime < plan.Moves[j].Runtime
	})
	return plan, nil
}

// Adopt migrates hand-maintained steering blocks and skills into the vault. It refuses rather than
// guess: a rule only one harness holds, or a skill name two harnesses claim, must be resolved first.
func Adopt(p Paths, apply bool, prefer map[string]string, acceptLoss bool) (AdoptPlan, error) {
	plan, err := PlanAdopt(p)
	if err != nil {
		return plan, err
	}
	unresolved := plan.Collisions[:0:0]
	for _, c := range plan.Collisions {
		if prefer[c.Name] == "" {
			unresolved = append(unresolved, c)
		}
	}
	if len(plan.Carried) > 0 && !acceptLoss {
		plan.Blocked = true
		plan.Reasons = append(plan.Reasons, fmt.Sprintf("%d line(s) exist only in a harness copy; fold them into the canonical doc or pass accept-loss", len(plan.Carried)))
	}
	if len(unresolved) > 0 {
		plan.Blocked = true
		for _, c := range unresolved {
			plan.Reasons = append(plan.Reasons, fmt.Sprintf("skill %q is held by %d harnesses; choose one with prefer", c.Name, len(c.Sources)))
		}
	}
	if !apply || plan.Blocked {
		if apply && plan.Blocked {
			return plan, fmt.Errorf("adoption blocked: %s", strings.Join(plan.Reasons, "; "))
		}
		return plan, nil
	}

	if plan.SeedFrom != "" {
		seed, err := os.ReadFile(plan.SeedFrom)
		if err != nil {
			return plan, err
		}
		if err := os.MkdirAll(filepath.Dir(p.SteeringDoc), 0o755); err != nil {
			return plan, err
		}
		if err := os.WriteFile(p.SteeringDoc, []byte(blockBefore(string(seed))), 0o644); err != nil {
			return plan, err
		}
	}
	canonical, err := os.ReadFile(p.SteeringDoc)
	if err != nil {
		return plan, err
	}
	for _, spec := range harness.List() {
		if !configRootExists(spec, p.Home) {
			continue
		}
		target := spec.SteeringPath(p.Home)
		existing, readErr := os.ReadFile(target)
		if readErr != nil && !os.IsNotExist(readErr) {
			return plan, readErr
		}
		if len(existing) > 0 {
			if err := os.WriteFile(target+".bak", existing, 0o644); err != nil {
				return plan, fmt.Errorf("backing up %s: %w", target, err)
			}
		}
		stripped := strings.TrimPrefix(string(existing), blockBefore(string(existing)))
		if err := os.WriteFile(target, []byte(applyRegion(stripped, string(canonical))), 0o644); err != nil {
			return plan, err
		}
	}

	if err := os.MkdirAll(p.SkillsRoot, 0o755); err != nil {
		return plan, err
	}
	for _, m := range plan.Moves {
		if winner, ok := prefer[m.Name]; ok && winner != m.Runtime {
			continue // a losing copy stays where it is; the reconciler reports it as a conflict
		}
		dest := filepath.Join(p.SkillsRoot, m.Name)
		if _, err := os.Stat(dest); err == nil {
			continue // already canonical
		}
		if err := os.Rename(m.From, dest); err != nil {
			return plan, fmt.Errorf("moving %s into the vault: %w", m.From, err)
		}
	}
	for _, m := range plan.Moves {
		if winner, ok := prefer[m.Name]; ok && winner != m.Runtime {
			if err := os.RemoveAll(m.From); err != nil {
				return plan, fmt.Errorf("removing the losing copy %s: %w", m.From, err)
			}
		}
	}
	if _, err := Apply(p, false); err != nil {
		return plan, err
	}
	return plan, nil
}
```

Note on the losing copy: it is deleted only when the user explicitly named a winner with `prefer`, and the winner's bytes are already in the vault by then. Without `prefer` the run is blocked and nothing is removed.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `go test ./pkg/agentsync/ -v`
Expected: PASS, all tests.

- [ ] **Step 5: Stage**

```bash
git add pkg/agentsync/adopt.go pkg/agentsync/adopt_test.go
```

---

### Task 11: RPC domain

**Files:**
- Create: `pkg/wshrpc/wshrpctypes_agentsync.go`
- Modify: `pkg/wshrpc/wshrpctypes.go:35-54` (add `AgentSyncCommands` to `WshRpcInterface`)
- Create: `pkg/wshrpc/wshserver/wshserver_agentsync.go`
- Regenerates: `pkg/wshrpc/wshclient/wshclient.go`, `frontend/app/store/wshclientapi.ts`, `frontend/types/gotypes.d.ts`

**Interfaces:**
- Consumes: `agentsync.Apply`, `Status`, `Adopt`, `PlanAdopt`, `DefaultPaths` (Tasks 4-10).
- Produces: RPC commands `AgentSyncStatusCommand`, `AgentSyncApplyCommand`, `AgentSyncAdoptCommand`, `AgentSyncSteeringReadCommand`, `AgentSyncSteeringWriteCommand`, and their data types. Tasks 12-14 call these.

- [ ] **Step 1: Write the types**

Create `pkg/wshrpc/wshrpctypes_agentsync.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshrpc

import "context"

type AgentSyncCommands interface {
	AgentSyncStatusCommand(ctx context.Context) (*CommandAgentSyncStatusRtnData, error)
	AgentSyncApplyCommand(ctx context.Context, data CommandAgentSyncApplyData) (*CommandAgentSyncApplyRtnData, error)
	AgentSyncAdoptCommand(ctx context.Context, data CommandAgentSyncAdoptData) (*CommandAgentSyncAdoptRtnData, error)
	AgentSyncSteeringReadCommand(ctx context.Context) (*CommandAgentSyncSteeringReadRtnData, error)
	AgentSyncSteeringWriteCommand(ctx context.Context, data CommandAgentSyncSteeringWriteData) (*CommandAgentSyncSteeringWriteRtnData, error)
}

type AgentSyncHarness struct {
	Runtime        string `json:"runtime"`
	Label          string `json:"label"`
	Present        bool   `json:"present"`
	Steering       string `json:"steering"`
	SkillsLinked   int    `json:"skillslinked"`
	SkillsConflict int    `json:"skillsconflict"`
	Note           string `json:"note,omitempty"`
}

type AgentSyncAction struct {
	Kind    string `json:"kind"`
	Runtime string `json:"runtime"`
	Path    string `json:"path"`
	Detail  string `json:"detail,omitempty"`
}

type CommandAgentSyncStatusRtnData struct {
	Harnesses   []AgentSyncHarness `json:"harnesses"`
	SteeringDoc string             `json:"steeringdoc"`
	SkillsRoot  string             `json:"skillsroot"`
}

type CommandAgentSyncApplyData struct {
	DryRun bool `json:"dryrun,omitempty"`
}

type CommandAgentSyncApplyRtnData struct {
	Actions []AgentSyncAction `json:"actions"`
}

type CommandAgentSyncAdoptData struct {
	Apply      bool              `json:"apply,omitempty"`
	Prefer     map[string]string `json:"prefer,omitempty"`
	AcceptLoss bool              `json:"acceptloss,omitempty"`
}

type AgentSyncCarriedLine struct {
	Runtime string `json:"runtime"`
	Line    string `json:"line"`
}

type AgentSyncSkillMove struct {
	Runtime string `json:"runtime"`
	Name    string `json:"name"`
	From    string `json:"from"`
}

type AgentSyncSkillCollision struct {
	Name    string   `json:"name"`
	Sources []string `json:"sources"`
}

type CommandAgentSyncAdoptRtnData struct {
	SeedFrom   string                    `json:"seedfrom,omitempty"`
	SeedLines  int                       `json:"seedlines"`
	Carried    []AgentSyncCarriedLine    `json:"carried,omitempty"`
	Moves      []AgentSyncSkillMove      `json:"moves,omitempty"`
	Collisions []AgentSyncSkillCollision `json:"collisions,omitempty"`
	Blocked    bool                      `json:"blocked"`
	Reasons    []string                  `json:"reasons,omitempty"`
}

type CommandAgentSyncSteeringReadRtnData struct {
	Path    string `json:"path"`
	Content string `json:"content"`
	Mtime   int64  `json:"mtime"`
}

type CommandAgentSyncSteeringWriteData struct {
	Content   string `json:"content"`
	BaseMtime int64  `json:"basemtime"`
}

type CommandAgentSyncSteeringWriteRtnData struct {
	Mtime    int64 `json:"mtime"`
	Conflict bool  `json:"conflict"`
}
```

Then add `AgentSyncCommands` to the `WshRpcInterface` composition in `pkg/wshrpc/wshrpctypes.go`, on its own line after `MemoryCommands`.

- [ ] **Step 2: Write the server handlers**

Create `pkg/wshrpc/wshserver/wshserver_agentsync.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"fmt"
	"os"

	"github.com/wavetermdev/waveterm/pkg/agentsync"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

func (ws *WshServer) AgentSyncStatusCommand(ctx context.Context) (*wshrpc.CommandAgentSyncStatusRtnData, error) {
	p := agentsync.DefaultPaths()
	rows, err := agentsync.Status(p)
	if err != nil {
		return nil, fmt.Errorf("reading harness sync status: %w", err)
	}
	out := make([]wshrpc.AgentSyncHarness, len(rows))
	for i, r := range rows {
		out[i] = wshrpc.AgentSyncHarness{
			Runtime: r.Runtime, Label: r.Label, Present: r.Present, Steering: r.Steering,
			SkillsLinked: r.SkillsLinked, SkillsConflict: r.SkillsConflict, Note: r.Note,
		}
	}
	return &wshrpc.CommandAgentSyncStatusRtnData{Harnesses: out, SteeringDoc: p.SteeringDoc, SkillsRoot: p.SkillsRoot}, nil
}

func (ws *WshServer) AgentSyncApplyCommand(ctx context.Context, data wshrpc.CommandAgentSyncApplyData) (*wshrpc.CommandAgentSyncApplyRtnData, error) {
	actions, err := agentsync.Apply(agentsync.DefaultPaths(), data.DryRun)
	if err != nil {
		return nil, fmt.Errorf("syncing harness config: %w", err)
	}
	out := make([]wshrpc.AgentSyncAction, len(actions))
	for i, a := range actions {
		out[i] = wshrpc.AgentSyncAction{Kind: a.Kind, Runtime: a.Runtime, Path: a.Path, Detail: a.Detail}
	}
	return &wshrpc.CommandAgentSyncApplyRtnData{Actions: out}, nil
}

func (ws *WshServer) AgentSyncAdoptCommand(ctx context.Context, data wshrpc.CommandAgentSyncAdoptData) (*wshrpc.CommandAgentSyncAdoptRtnData, error) {
	plan, err := agentsync.Adopt(agentsync.DefaultPaths(), data.Apply, data.Prefer, data.AcceptLoss)
	rtn := &wshrpc.CommandAgentSyncAdoptRtnData{
		SeedFrom: plan.SeedFrom, SeedLines: plan.SeedLines, Blocked: plan.Blocked, Reasons: plan.Reasons,
	}
	for _, c := range plan.Carried {
		rtn.Carried = append(rtn.Carried, wshrpc.AgentSyncCarriedLine{Runtime: c.Runtime, Line: c.Line})
	}
	for _, m := range plan.Moves {
		rtn.Moves = append(rtn.Moves, wshrpc.AgentSyncSkillMove{Runtime: m.Runtime, Name: m.Name, From: m.From})
	}
	for _, c := range plan.Collisions {
		rtn.Collisions = append(rtn.Collisions, wshrpc.AgentSyncSkillCollision{Name: c.Name, Sources: c.Sources})
	}
	if err != nil {
		// a blocked plan is data the caller must see, not just an error string
		return rtn, err
	}
	return rtn, nil
}

func (ws *WshServer) AgentSyncSteeringReadCommand(ctx context.Context) (*wshrpc.CommandAgentSyncSteeringReadRtnData, error) {
	path := agentsync.DefaultPaths().SteeringDoc
	content, err := os.ReadFile(path)
	if err != nil && !os.IsNotExist(err) {
		return nil, fmt.Errorf("reading canonical steering doc: %w", err)
	}
	var mtime int64
	if st, statErr := os.Stat(path); statErr == nil {
		mtime = st.ModTime().UnixMilli()
	}
	return &wshrpc.CommandAgentSyncSteeringReadRtnData{Path: path, Content: string(content), Mtime: mtime}, nil
}

func (ws *WshServer) AgentSyncSteeringWriteCommand(ctx context.Context, data wshrpc.CommandAgentSyncSteeringWriteData) (*wshrpc.CommandAgentSyncSteeringWriteRtnData, error) {
	res, err := agentsync.WriteSteering(agentsync.DefaultPaths(), data.Content, data.BaseMtime)
	if err != nil {
		return nil, fmt.Errorf("writing canonical steering doc: %w", err)
	}
	return &wshrpc.CommandAgentSyncSteeringWriteRtnData{Mtime: res.Mtime, Conflict: res.Conflict}, nil
}
```

- [ ] **Step 3: Add the mtime-guarded writer**

Append to `pkg/agentsync/agentsync.go`:

```go
// WriteResult mirrors memvault.WriteResult: a conflict means the file changed under the editor and
// nothing was written.
type WriteResult struct {
	Mtime    int64
	Conflict bool
}

// WriteSteering replaces the canonical document, refusing when it changed since baseMtime. A
// baseMtime of 0 means "the caller has not read it yet" and skips the check.
func WriteSteering(p Paths, content string, baseMtime int64) (WriteResult, error) {
	if st, err := os.Stat(p.SteeringDoc); err == nil && baseMtime != 0 && st.ModTime().UnixMilli() != baseMtime {
		return WriteResult{Mtime: st.ModTime().UnixMilli(), Conflict: true}, nil
	}
	if err := os.MkdirAll(filepath.Dir(p.SteeringDoc), 0o755); err != nil {
		return WriteResult{}, err
	}
	if err := os.WriteFile(p.SteeringDoc, []byte(content), 0o644); err != nil {
		return WriteResult{}, err
	}
	st, err := os.Stat(p.SteeringDoc)
	if err != nil {
		return WriteResult{}, err
	}
	return WriteResult{Mtime: st.ModTime().UnixMilli()}, nil
}
```

Add `"path/filepath"` to that file's imports.

- [ ] **Step 4: Regenerate bindings and build**

Run:
```bash
task generate
go build ./...
```
Expected: `task generate` rewrites `wshclient.go`, `wshclientapi.ts`, and `gotypes.d.ts` with the five new commands; the build succeeds. Never hand-edit those three files.

- [ ] **Step 5: Verify the whole backend still tests clean**

From PowerShell:
```powershell
$env:CGO_CFLAGS = "-O2 -g -I$((Get-Location).Path -replace '\\','/')/pkg/jarvisembed/csrc"
go test ./pkg/agentsync/... ./pkg/harness/... ./pkg/memroots/... ./pkg/memvault/... ./pkg/wshrpc/...
```
Expected: PASS. `pkg/memvault` is included because it shares the steering-file targets.

- [ ] **Step 6: Stage**

```bash
git add pkg/wshrpc/wshrpctypes_agentsync.go pkg/wshrpc/wshrpctypes.go pkg/wshrpc/wshserver/wshserver_agentsync.go pkg/wshrpc/wshclient/wshclient.go pkg/agentsync/agentsync.go frontend/app/store/wshclientapi.ts frontend/types/gotypes.d.ts
```

---

### Task 12: `wsh agent-sync` CLI

**Files:**
- Create: `cmd/wsh/cmd/wshcmd-agentsync.go`

**Interfaces:**
- Consumes: the RPC commands from Task 11.
- Produces: `wsh agent-sync status`, `wsh agent-sync sync [--dry-run]`, `wsh agent-sync adopt [--apply] [--prefer <runtime>:<skill>] [--accept-loss]`. This is the first end-to-end usable deliverable: the whole feature works from here with no frontend.

- [ ] **Step 1: Implement**

Create `cmd/wsh/cmd/wshcmd-agentsync.go`, following the shape of `wshcmd-agent-memory-project.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"fmt"
	"strings"

	"github.com/spf13/cobra"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshrpc/wshclient"
)

var agentSyncCmd = &cobra.Command{
	Use:   "agent-sync",
	Short: "sync steering files and skills from the vault into every harness",
}

var agentSyncStatusCmd = &cobra.Command{
	Use:          "status",
	Short:        "show what each harness currently reflects",
	Args:         cobra.NoArgs,
	PreRunE:      preRunSetupRpcClient,
	RunE:         agentSyncStatusRun,
	SilenceUsage: true,
}

var agentSyncSyncCmd = &cobra.Command{
	Use:          "sync",
	Short:        "project the canonical steering doc and link canonical skills",
	Args:         cobra.NoArgs,
	PreRunE:      preRunSetupRpcClient,
	RunE:         agentSyncSyncRun,
	SilenceUsage: true,
}

var agentSyncAdoptCmd = &cobra.Command{
	Use:          "adopt",
	Short:        "migrate hand-maintained steering blocks and skills into the vault",
	Args:         cobra.NoArgs,
	PreRunE:      preRunSetupRpcClient,
	RunE:         agentSyncAdoptRun,
	SilenceUsage: true,
}

var (
	agentSyncDryRun     bool
	agentSyncApply      bool
	agentSyncPrefer     []string
	agentSyncAcceptLoss bool
)

func init() {
	agentSyncSyncCmd.Flags().BoolVar(&agentSyncDryRun, "dry-run", false, "print the plan without writing")
	agentSyncAdoptCmd.Flags().BoolVar(&agentSyncApply, "apply", false, "commit the migration (default is a dry run)")
	agentSyncAdoptCmd.Flags().StringArrayVar(&agentSyncPrefer, "prefer", nil, "resolve a skill collision, as <runtime>:<skill>")
	agentSyncAdoptCmd.Flags().BoolVar(&agentSyncAcceptLoss, "accept-loss", false, "accept dropping lines that exist only in a harness copy")
	agentSyncCmd.AddCommand(agentSyncStatusCmd, agentSyncSyncCmd, agentSyncAdoptCmd)
	rootCmd.AddCommand(agentSyncCmd)
}

func agentSyncStatusRun(cmd *cobra.Command, args []string) error {
	res, err := wshclient.AgentSyncStatusCommand(RpcClient, &wshrpc.RpcOpts{Timeout: 15000})
	if err != nil {
		return err
	}
	WriteStdout("canonical steering: %s\ncanonical skills:   %s\n\n", res.SteeringDoc, res.SkillsRoot)
	for _, h := range res.Harnesses {
		if !h.Present {
			WriteStdout("%-12s not present\n", h.Label)
			continue
		}
		line := fmt.Sprintf("%-12s steering %-8s skills %d linked", h.Label, h.Steering, h.SkillsLinked)
		if h.SkillsConflict > 0 {
			line += fmt.Sprintf(", %d conflict", h.SkillsConflict)
		}
		if h.Note != "" {
			line += "  (" + h.Note + ")"
		}
		WriteStdout("%s\n", line)
	}
	return nil
}

func agentSyncSyncRun(cmd *cobra.Command, args []string) error {
	res, err := wshclient.AgentSyncApplyCommand(RpcClient, wshrpc.CommandAgentSyncApplyData{DryRun: agentSyncDryRun}, &wshrpc.RpcOpts{Timeout: 30000})
	if err != nil {
		return err
	}
	if len(res.Actions) == 0 {
		WriteStdout("everything already in sync\n")
		return nil
	}
	for _, a := range res.Actions {
		detail := ""
		if a.Detail != "" {
			detail = "  " + a.Detail
		}
		WriteStdout("%-16s %-9s %s%s\n", a.Kind, a.Runtime, a.Path, detail)
	}
	return nil
}

func agentSyncAdoptRun(cmd *cobra.Command, args []string) error {
	prefer := map[string]string{}
	for _, p := range agentSyncPrefer {
		runtime, skill, ok := strings.Cut(p, ":")
		if !ok {
			return fmt.Errorf("--prefer wants <runtime>:<skill>, got %q", p)
		}
		prefer[skill] = runtime
	}
	res, err := wshclient.AgentSyncAdoptCommand(RpcClient, wshrpc.CommandAgentSyncAdoptData{
		Apply: agentSyncApply, Prefer: prefer, AcceptLoss: agentSyncAcceptLoss,
	}, &wshrpc.RpcOpts{Timeout: 60000})
	if res != nil {
		if res.SeedFrom != "" {
			WriteStdout("seed: %s (%d lines)\n", res.SeedFrom, res.SeedLines)
		}
		for _, c := range res.Carried {
			WriteStdout("carried  %-9s %s\n", c.Runtime, c.Line)
		}
		for _, m := range res.Moves {
			WriteStdout("move     %-9s %s\n", m.Runtime, m.From)
		}
		for _, c := range res.Collisions {
			WriteStdout("collision %s: %s\n", c.Name, strings.Join(c.Sources, ", "))
		}
		for _, r := range res.Reasons {
			WriteStdout("blocked: %s\n", r)
		}
	}
	return err
}
```

Both helpers are verified to exist: `preRunSetupRpcClient` is wired as `PreRunE` throughout `cmd/wsh/cmd/` (see `wshcmd-agentstatus.go:23`), and `WriteStdout` is defined at `cmd/wsh/cmd/wshcmd-root.go:75`.

- [ ] **Step 2: Build**

Run: `go build ./cmd/wsh/`
Expected: builds clean.

- [ ] **Step 3: Verify end to end against the real machine, read-only first**

Run:
```bash
task build:backend
dist/bin/wsh agent-sync status
dist/bin/wsh agent-sync sync --dry-run
dist/bin/wsh agent-sync adopt
```
Expected: status lists four harnesses with codex/claude/opencode/pi rows; the dry runs print a plan and **write nothing**. Confirm nothing changed:
```bash
git -C . status --short
md5sum ~/.codex/skills/1devtool-orchestrator/SKILL.md ~/.config/opencode/skills/1devtool-orchestrator/SKILL.md
```
Expected: the two md5s still differ (adoption has not run) and no repo file is dirty.

Do not run `adopt --apply` as part of this task. That is a real migration of the user's files; it needs their explicit go-ahead, and the dry-run output is what they need to see first.

- [ ] **Step 4: Stage**

```bash
git add cmd/wsh/cmd/wshcmd-agentsync.go
```

---

### Task 13: Settings section

**Files:**
- Modify: `frontend/app/view/agents/settingsstore.ts` (add the section id)
- Modify: `frontend/app/view/agents/settingssurface.tsx` (add `HarnessSyncSection`, render it after `MemorySection` at :~626)

**Interfaces:**
- Consumes: `RpcApi.AgentSyncStatusCommand`, `AgentSyncApplyCommand`, `AgentSyncSteeringReadCommand`, `AgentSyncSteeringWriteCommand` (Task 11).
- Produces: `SETTINGS_SECTION_HARNESS_SYNC` (a dom id for deep links) and the rendered section. Task 14 asserts against `[data-harness-sync-row]`.

- [ ] **Step 1: Add the section id**

In `frontend/app/view/agents/settingsstore.ts`, beside the existing embeddings id:

```ts
export const SETTINGS_SECTION_HARNESS_SYNC = "settings-harness-sync";
```

- [ ] **Step 2: Add the section component**

In `frontend/app/view/agents/settingssurface.tsx`, add below `MemorySection`:

```tsx
type HarnessSyncRow = AgentSyncHarness;

// Steering state -> the token that carries it. Chips never hardcode a color: a raw hex opts out of
// every runtime theme.
const STEERING_TONE: Record<string, string> = {
    current: "text-success",
    stale: "text-warning",
    absent: "text-muted",
};

function HarnessSyncSection() {
    const [rows, setRows] = useState<HarnessSyncRow[]>([]);
    const [steeringDoc, setSteeringDoc] = useState("");
    const [content, setContent] = useState("");
    const [baseMtime, setBaseMtime] = useState(0);
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const preview = content.split("\n").slice(0, 3).join("\n");

    const refresh = useCallback(() => {
        void RpcApi.AgentSyncStatusCommand(TabRpcClient)
            .then((r) => {
                setRows(r.harnesses ?? []);
                setSteeringDoc(r.steeringdoc ?? "");
            })
            .catch((e) => setError(String(e)));
        void RpcApi.AgentSyncSteeringReadCommand(TabRpcClient)
            .then((r) => {
                setContent(r.content ?? "");
                setBaseMtime(r.mtime ?? 0);
            })
            .catch(() => setContent(""));
    }, []);

    useEffect(refresh, [refresh]);

    const openEditor = () => {
        setDraft(content);
        setError(null);
        setEditing(true);
    };

    // save, then project immediately: an edit the harnesses have not received yet is the stale state
    // this whole feature exists to remove.
    const saveEditor = () => {
        setBusy(true);
        fireAndForget(async () => {
            try {
                const res = await RpcApi.AgentSyncSteeringWriteCommand(TabRpcClient, {
                    content: draft,
                    basemtime: baseMtime,
                });
                if (res.conflict) {
                    setError("The canonical doc changed on disk. Reopen the editor to pick up the new version.");
                    refresh();
                    return;
                }
                await RpcApi.AgentSyncApplyCommand(TabRpcClient, { dryrun: false });
                setEditing(false);
                refresh();
            } catch (e) {
                setError(String(e));
            } finally {
                setBusy(false);
            }
        });
    };

    const syncNow = () => {
        setBusy(true);
        setError(null);
        fireAndForget(async () => {
            try {
                await RpcApi.AgentSyncApplyCommand(TabRpcClient, { dryrun: false });
                refresh();
            } catch (e) {
                setError(String(e));
            } finally {
                setBusy(false);
            }
        });
    };

    return (
        <div id={SETTINGS_SECTION_HARNESS_SYNC}>
            <SectionLabel>Harness sync</SectionLabel>
            <div className="flex items-start justify-between gap-5">
                <div className="min-w-0 flex-1">
                    <div className="text-[14px] font-semibold text-primary">Canonical steering</div>
                    <div className="mb-3 mt-0.5 text-[12.5px] text-muted">
                        Projected into every harness's steering file.{" "}
                        <span className="font-mono text-[12px]">{steeringDoc}</span>
                    </div>
                </div>
                <button
                    type="button"
                    onClick={openEditor}
                    className="shrink-0 rounded-[9px] border border-edge-mid bg-surface-raised px-[18px] py-2 text-[13px] font-semibold text-secondary transition-colors hover:border-edge-strong"
                >
                    Edit
                </button>
            </div>
            {preview ? (
                <pre className="mb-4 overflow-x-auto whitespace-pre-wrap rounded-[9px] border border-edge-faint bg-surface-raised p-3 font-mono text-[12px] text-secondary">
                    {preview}
                </pre>
            ) : null}
            <div className="mb-4">
                {rows.map((h) => (
                    <div
                        key={h.runtime}
                        data-harness-sync-row={h.runtime}
                        className="flex items-center justify-between gap-5 border-t border-edge-faint py-2.5 first:border-t-0"
                    >
                        <div className="min-w-0 flex-1 text-[13.5px] font-semibold text-primary">{h.label}</div>
                        {h.present ? (
                            <div className="flex flex-none items-center gap-5 font-mono text-[12px]">
                                <span className={STEERING_TONE[h.steering] ?? "text-muted"}>steering {h.steering}</span>
                                <span className="text-muted">
                                    {h.note ? h.note : `${h.skillslinked} linked`}
                                    {h.skillsconflict > 0 ? ` · ${h.skillsconflict} conflict` : ""}
                                </span>
                            </div>
                        ) : (
                            <div className="flex-none font-mono text-[12px] text-muted">not present</div>
                        )}
                    </div>
                ))}
            </div>
            <div className="flex justify-end">
                <SaveButton label={busy ? "Syncing…" : "Sync now"} onClick={syncNow} disabled={busy} />
            </div>
            {error ? <div className="mt-2 text-[12px] text-error">{error}</div> : null}
            <ModalShell open={editing} onClose={() => setEditing(false)} className="w-[720px] max-w-[92vw] p-5">
                <div className="mb-3 text-[14px] font-semibold text-primary">Canonical steering</div>
                <textarea
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    spellCheck={false}
                    className="h-[52vh] w-full resize-none rounded-[9px] border border-edge-mid bg-surface-raised p-3 font-mono text-[12.5px] text-primary outline-none focus:border-accent-700"
                />
                <div className="mt-3 flex justify-end gap-2.5">
                    <button
                        type="button"
                        onClick={() => setEditing(false)}
                        className="rounded-[9px] border border-edge-mid bg-surface-raised px-[18px] py-2 text-[13px] font-semibold text-secondary transition-colors hover:border-edge-strong"
                    >
                        Cancel
                    </button>
                    <SaveButton label={busy ? "Saving…" : "Save and sync"} onClick={saveEditor} disabled={busy} />
                </div>
            </ModalShell>
        </div>
    );
}
```

Render it after `MemorySection` in the surface body:

```tsx
                    <MemorySection />
                    <SectionGap />
                    <HarnessSyncSection />
                    <SectionGap />
```

Import edits, verified against the file's current import block: add `SETTINGS_SECTION_HARNESS_SYNC` to the existing `./settingsstore` import, add `useCallback` to the existing `react` import (the file imports only `useEffect, useState` today), and add `import { ModalShell } from "@/app/modals/modalshell";`. `fireAndForget` is already imported from `@/util/util`. `AgentSyncHarness` needs no import — `frontend/types/gotypes.d.ts` is a `declare global` file, so generated types are ambient.

`ModalShell` takes `open`, `onClose`, `onSubmit`, `className`, `align`, `topClass`, `dismissOnBackdrop`, `children` (`frontend/app/modals/modalshell.tsx:26`). It claims focus only when nothing inside the panel took it, so the textarea keeps focus on open.

Adoption is deliberately not wired to a button in this task. It is destructive, it needs the dry-run report and a collision decision, and the CLI already carries it — a "Review adoption…" modal is a follow-up once the migration has actually been run once.

- [ ] **Step 3: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: only the ~3 known `frontend/tauri/api.test.ts` baseline errors. Any error naming `settingssurface.tsx` or `AgentSync*` is yours.

- [ ] **Step 4: Stage**

```bash
git add frontend/app/view/agents/settingsstore.ts frontend/app/view/agents/settingssurface.tsx
```

---

### Task 14: Launch hook and CDP verification

**Files:**
- Modify: `frontend/app/cockpit/cockpit-actions.ts:94` (fire the sync alongside the memory projection)
- Modify: `scripts/cdp/scenarios.mjs` (add the `harness-sync` scenario and register it in the export array)

**Interfaces:**
- Consumes: `RpcApi.AgentSyncApplyCommand` (Task 11), `[data-harness-sync-row]` (Task 13).
- Produces: nothing downstream. This is the last task.

- [ ] **Step 1: Fire the sync at agent launch**

**Read the surrounding code before editing.** The existing `MemoryProjectCommand` call at :94 sits inside an `if (opts.runtime === "codex")` branch — memory projection is codex-only because claude is that engine's hub. Harness sync is **not** runtime-scoped: one run updates all four harnesses, so the call goes *outside* that branch. Putting it inside would sync only when a codex agent launches.

In `frontend/app/cockpit/cockpit-actions.ts`, after the closing `})();` of the codex block and before `const agentPanel = runtimeCreatesAgentPanel(opts.runtime);`:

```ts
    // steering and skills are launch-time too, for every runtime: a harness must never start against
    // a stale region. fire-and-forget — a sync failure must not block the launch.
    void RpcApi.AgentSyncApplyCommand(TabRpcClient, { dryrun: false }).catch(() => {});
```

- [ ] **Step 2: Add the CDP scenario**

In `scripts/cdp/scenarios.mjs`, add before the export array:

```js
// --- harness config sync ------------------------------------------------------------------------
// The Settings section renders one row per catalog harness, driven by AgentSyncStatusCommand. This
// asserts the RPC reaches the surface at all; the reconciler's own behavior is unit-tested in Go.
const harnessSync = {
    name: "harness-sync",
    surface: "settings",
    async arrange() {
        return {};
    },
    async assert(h) {
        const steps = [];
        await h.goto("settings");
        await h.ev(
            `(() => { document.getElementById("settings-harness-sync")?.scrollIntoView({ block: "start" }); return true; })()`
        );
        await h.ev("new Promise((r) => setTimeout(r, 400))");
        const rows = await h.ev(
            `(() => [...document.querySelectorAll('[data-harness-sync-row]')].map((n) => n.getAttribute('data-harness-sync-row')))()`
        );
        steps.push({
            step: "settings -> harness sync section lists every catalog harness",
            ok: Array.isArray(rows) && ["pi", "claude", "codex", "opencode"].every((r) => rows.includes(r)),
            detail: `rows=${JSON.stringify(rows)}`,
        });
        const status = await h.rpc("agentsyncstatus", null);
        steps.push({
            step: "AgentSyncStatusCommand returns a row per harness",
            ok: !!status && Array.isArray(status.harnesses) && status.harnesses.length === 4,
            detail: JSON.stringify(status && status.harnesses ? status.harnesses.map((x) => x.runtime) : status),
        });
        await h.shot("cdp-shots/harness-sync.png");
        return steps;
    },
    async teardown() {},
};
```

Register `harnessSync` in the exported array at the bottom of the file. The wire command name is the handler name lowercased with `Command` dropped — `MemoryProjectionStatusCommand` generates `command "memoryprojectionstatus"` (`wshclient.go:1023`), so `AgentSyncStatusCommand` generates `agentsyncstatus`. Confirm against the generated comment if the scenario's RPC step fails.

- [ ] **Step 3: Run the scenario**

With the dev app running (`task dev`):

Run: `task verify:ui -- harness-sync`
Expected: PASS on both steps; screenshot at `cdp-shots/harness-sync.png`, contact sheet at `cdp-shots/index.html`.

If CDP refuses to connect on :9222, the dev app is not running or another session's edit crashed it — check the dev log rather than retrying blindly.

- [ ] **Step 4: Full verification sweep**

```bash
npx vitest run
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit
go build ./...
```
From PowerShell:
```powershell
$env:CGO_CFLAGS = "-O2 -g -I$((Get-Location).Path -replace '\\','/')/pkg/jarvisembed/csrc"
go test ./pkg/...
```
Expected: vitest passes; tsc shows only the ~3 baseline `api.test.ts` errors; Go builds and tests pass.

- [ ] **Step 5: Stage, then stop**

```bash
git add frontend/app/cockpit/cockpit-actions.ts scripts/cdp/scenarios.mjs docs/superpowers/specs/2026-09-07-harness-config-sync-design.md docs/superpowers/plans/2026-09-07-harness-config-sync.md
git status --short
```

Do **not** commit. Report the staged diff and ask for approval; the spec and this plan go in the same single commit as the code.

---

## Post-implementation: the actual migration

Adoption is not part of the build. Once the code is merged, the real migration is one interactive session, run by the user:

1. `wsh agent-sync adopt` — read the dry-run report.
2. Fold the three pi-only rules (solution ladder, "Reuse before write", the longer "Stay minimal") into `~/.waveterm/vault/steering/AGENTS.md`. The pre-commit simplify-review rule is deliberately dropped.
3. `wsh agent-sync adopt --apply --accept-loss --prefer <runtime>:1devtool-orchestrator` — accepting the one intentional drop and choosing which copy of the colliding skill wins.
4. Verify: `md5sum ~/.codex/skills/1devtool-orchestrator/SKILL.md ~/.config/opencode/skills/1devtool-orchestrator/SKILL.md` now match, because both paths resolve to the same vault file.
