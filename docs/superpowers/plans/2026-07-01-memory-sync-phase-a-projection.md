# Memory Sync — Phase A (Projection + viewer repoint) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the cockpit launches a Codex/antigravity "lackey", render the launch project's Claude memory into that runtime's global steering file so the lackey boots with Claude's brain; and repoint Memory-surface note authoring from the dedicated vault into the focused project's Claude hub.

**Architecture:** Claude Code's per-project memory (`~/.claude/projects/<hash>/memory/`) is the single source of truth. Projection is a pure function of that memory rendered into a delimited region of each lackey's home-level steering file (`~/.codex/AGENTS.md`, `~/.gemini/GEMINI.md`) — never repo files. Projection is triggered at agent launch (deterministic, correctly scoped, no global "active project" and no fsnotify needed, since steering files are read at session start). An explicit "Project now" button and a status strip give observability.

**Tech Stack:** Go (`pkg/memvault`, `pkg/wshrpc`), the wshrpc codegen pipeline (`task generate`), React 19 + jotai + Tailwind 4 frontend. Go tests via `go test`; frontend via `vitest`.

**Context from the spec** (`docs/superpowers/specs/2026-07-01-memory-sync-engine-design.md`):
- Full loop is the eventual target; **this plan is Phase A (projection + viewer repoint only)**. Harvest (Phases B/C) is out of scope here.
- **Echo rule:** a note tagged `source: X` is not projected back to agent X. In Phase A no notes carry a `source` yet (harvest doesn't exist), but the exclusion is implemented now so Phase B needs no projection change.
- **Facts, not directives:** render note content as knowledge (Codex ignores behavioral steering).
- **Readable labels:** the encoded hash never reaches the UI; a project shows as its registry name or its cwd leaf folder.

**Key existing code (read before starting):**
- `pkg/memvault/memvault.go` — `Note`, `ScanVault`, `Root`, `VaultRoots`, `DefaultVaultPath`, `CreateNote`, `deriveScope`, `parseNote`. This plan adds a sibling file `pkg/memvault/projection.go`.
- `pkg/wshrpc/wshrpctypes.go:100-104` (Memory command interface) and `:724-780` (Memory types). `pkg/wshrpc/wshserver/wshserver.go:1508-1563` (Memory handlers).
- `frontend/app/view/agents/memstore.ts` (`createNote`), `newmemorymodal.tsx` (create UI), `memorysurface.tsx` (surface, receives `model`).
- `frontend/app/cockpit/cockpit-actions.ts:27-70` (`launchAgent` — the projection hook point).
- `frontend/app/view/agents/agentcwdresolve.ts` (`resolveCwd(transcriptPath, blockId)`), `filessurface.tsx:103-116` (focused-agent → cwd pattern to mirror).
- `pkg/wconfig` projects registry: `wconfig.GetWatcher().GetFullConfig().Settings` and `.Projects` (`map[string]ProjectKeywords{ Path string }`).

**Codegen note:** After editing `pkg/wshrpc/wshrpctypes.go` or adding a `WshServer` method, run `task generate` to regenerate `pkg/wshrpc/wshclient/wshclient.go`, `frontend/app/store/wshclientapi.ts`, and `frontend/types/gotypes.d.ts`. **Never hand-edit those three files.**

**Typecheck note:** `npx tsc` stack-overflows on this repo. Use:
`node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (baseline has ~3 pre-existing errors in `frontend/tauri/api.test.ts`).

---

## File structure

**Created:**
- `pkg/memvault/projection.go` — projection core: hash/label helpers, note-body reader, facts renderer, steering-region splice, per-runtime steering paths, `Project(cwd)` orchestrator.
- `pkg/memvault/projection_test.go` — unit tests for the pure helpers.
- `frontend/app/view/agents/projectlabel.ts` — `projectLabel(cwd, projects)` display helper (pure).
- `frontend/app/view/agents/projectlabel.test.ts` — its tests.
- `frontend/app/view/agents/syncstrip.tsx` — the Memory-surface projection status strip + "Project now" button.

**Modified:**
- `pkg/memvault/memvault.go` — `deriveScope` uses a readable label for `claude`-source notes.
- `pkg/memvault/memvault_test.go` — extend for the new scope behavior.
- `pkg/wshrpc/wshrpctypes.go` — add `MemoryProjectCommand`, `MemoryProjectionStatusCommand`, and their data types; extend `CommandMemoryCreateData` with `Cwd`.
- `pkg/wshrpc/wshserver/wshserver.go` — implement the two new commands; repoint `MemoryCreateCommand`.
- `frontend/app/view/agents/memstore.ts` — `createNote` takes an optional `cwd`.
- `frontend/app/view/agents/newmemorymodal.tsx` — resolve + pass the focused agent's cwd.
- `frontend/app/view/agents/memorysurface.tsx` — render `<SyncStrip>`.
- `frontend/app/cockpit/cockpit-actions.ts` — call `MemoryProjectCommand` after a non-terminal launch.

---

## Task 1: Project hash + hub dir + label helpers (Go, pure)

**Files:**
- Create: `pkg/memvault/projection.go`
- Create: `pkg/memvault/projection_test.go`

- [ ] **Step 1: Write the failing test**

Create `pkg/memvault/projection_test.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package memvault

import "testing"

func TestProjectHash(t *testing.T) {
	got := projectHash(`C:\Users\kael02\IdeaProjects\waveterm`)
	want := "C--Users-kael02-IdeaProjects-waveterm"
	if got != want {
		t.Fatalf("projectHash = %q, want %q", got, want)
	}
	// forward slashes normalize the same way
	if g := projectHash("/home/k/code/krypton"); g != "-home-k-code-krypton" {
		t.Fatalf("posix projectHash = %q", g)
	}
}

func TestProjectLabel(t *testing.T) {
	projects := map[string]string{"Krypton API": `C:\Users\kael02\IdeaProjects\krypton`}
	// registry hit wins
	if l := projectLabel(`C:\Users\kael02\IdeaProjects\krypton`, projects); l != "Krypton API" {
		t.Fatalf("registry label = %q", l)
	}
	// miss -> leaf folder
	if l := projectLabel(`C:\Users\kael02\IdeaProjects\waveterm`, projects); l != "waveterm" {
		t.Fatalf("leaf label = %q", l)
	}
	// label from an encoded hash, registry miss -> last segment
	if l := labelFromHash("C--Users-kael02-IdeaProjects-waveterm", projects); l != "waveterm" {
		t.Fatalf("hash leaf label = %q", l)
	}
	// label from an encoded hash, registry hit
	if l := labelFromHash("C--Users-kael02-IdeaProjects-krypton", projects); l != "Krypton API" {
		t.Fatalf("hash registry label = %q", l)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./pkg/memvault/ -run 'TestProjectHash|TestProjectLabel' -v`
Expected: FAIL — `undefined: projectHash` (etc.).

- [ ] **Step 3: Write minimal implementation**

Create `pkg/memvault/projection.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Projection renders a project's Claude memory (the hub) into the delimited region of each
// lackey runtime's home-level steering file. Pure helpers here are unit-tested; Project()
// wires them to the filesystem. See docs/superpowers/specs/2026-07-01-memory-sync-engine-design.md.
package memvault

import (
	"path/filepath"
	"strings"
)

// projectHash encodes a cwd the way Claude Code names its per-project dir: every path separator
// (both \ and /) and colon becomes '-'. e.g. C:\Users\k\p -> C--Users-k-p.
func projectHash(cwd string) string {
	r := strings.NewReplacer(`\`, "-", "/", "-", ":", "-")
	return r.Replace(cwd)
}

// projectLabel is the human-readable name for a cwd: its Projects-registry name if the cwd
// matches a registered path, else the leaf folder. projects maps registry name -> path.
func projectLabel(cwd string, projects map[string]string) string {
	clean := filepath.Clean(cwd)
	for name, p := range projects {
		if filepath.Clean(p) == clean {
			return name
		}
	}
	base := filepath.Base(clean)
	if base == "." || base == string(filepath.Separator) || base == "" {
		return clean
	}
	return base
}

// labelFromHash resolves a readable label from an encoded hash dir name (reverse of projectHash,
// which is lossy). Tries a registry match by re-encoding each registered path; falls back to the
// last '-'-delimited segment (the leaf folder in the common case).
func labelFromHash(hash string, projects map[string]string) string {
	for name, p := range projects {
		if projectHash(filepath.Clean(p)) == hash {
			return name
		}
	}
	parts := strings.Split(strings.TrimRight(hash, "-"), "-")
	if len(parts) == 0 {
		return hash
	}
	return parts[len(parts)-1]
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./pkg/memvault/ -run 'TestProjectHash|TestProjectLabel' -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add pkg/memvault/projection.go pkg/memvault/projection_test.go
git commit -m "feat(memvault): project hash + readable label helpers"
```

---

## Task 2: Facts renderer (Go, pure)

Renders a set of hub notes into the markdown that goes inside the steering region. Applies the echo rule (exclude notes whose `source` equals the target runtime). Renders each note as a heading + description + body (facts, not directives).

**Files:**
- Modify: `pkg/memvault/projection.go`
- Modify: `pkg/memvault/projection_test.go`

- [ ] **Step 1: Write the failing test**

Append to `pkg/memvault/projection_test.go`:

```go
func TestRenderFacts(t *testing.T) {
	notes := []NoteWithBody{
		{Note: Note{ID: "prefer-pg", Title: "Prefer Postgres", Description: "DB of record", Source: "claude"},
			Body: "Use Postgres, not a new dependency.\n"},
		{Note: Note{ID: "from-codex", Title: "Codex learned", Source: "codex"}, Body: "x"},
	}
	got := renderFacts("Krypton API", notes, "codex")
	// header carries the project label for status parsing
	if !strings.Contains(got, "project=Krypton API") {
		t.Fatalf("missing project marker:\n%s", got)
	}
	if !strings.Contains(got, "Prefer Postgres") || !strings.Contains(got, "Use Postgres") {
		t.Fatalf("claude note not rendered:\n%s", got)
	}
	// echo rule: a source:codex note must NOT appear in codex's projection
	if strings.Contains(got, "Codex learned") {
		t.Fatalf("echo rule violated — codex note projected back to codex:\n%s", got)
	}
	// same notes projected to agy DO include the codex-sourced note
	agy := renderFacts("Krypton API", notes, "antigravity")
	if !strings.Contains(agy, "Codex learned") {
		t.Fatalf("codex note should project to agy:\n%s", agy)
	}
}

func TestRenderFactsEmpty(t *testing.T) {
	got := renderFacts("waveterm", nil, "codex")
	if !strings.Contains(got, "project=waveterm") {
		t.Fatalf("empty projection still needs the header:\n%s", got)
	}
}
```

Add `"strings"` to the test imports if not already present (Task 1's test does not import it — add it):

```go
import (
	"strings"
	"testing"
)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./pkg/memvault/ -run TestRenderFacts -v`
Expected: FAIL — `undefined: renderFacts`.

- [ ] **Step 3: Write minimal implementation**

Add to `pkg/memvault/projection.go`:

```go
// projectionMarker is embedded in the region's BEGIN line so the status command can read back
// which project each steering file currently reflects.
const projectionHeader = "<!-- ARC-MEMORY:BEGIN project=%s (generated — do not edit; managed by Arc) -->"

// renderFacts renders the region body: a project header plus each note as facts-to-know, excluding
// notes whose Source equals targetRuntime (echo rule). Deterministic order = notes as passed in.
func renderFacts(label string, notes []NoteWithBody, targetRuntime string) string {
	var b strings.Builder
	b.WriteString("## Shared project memory: " + label + "\n\n")
	b.WriteString("These are facts about this project, projected from the primary agent's memory.\n\n")
	for _, n := range notes {
		if n.Note.Source == targetRuntime {
			continue // echo rule: don't send a runtime its own harvested facts
		}
		title := n.Note.Title
		if title == "" {
			title = n.Note.ID
		}
		b.WriteString("### " + title + "\n")
		if n.Note.Description != "" {
			b.WriteString(n.Note.Description + "\n\n")
		}
		body := strings.TrimSpace(n.Body)
		if body != "" {
			b.WriteString(body + "\n\n")
		}
	}
	return strings.TrimRight(b.String(), "\n") + "\n"
}
```

Note: `renderFacts` returns only the region *body*; the BEGIN/END markers (using `projectionHeader`) are added by `applySteeringRegion` in Task 3, which needs the label to build the marker. Pass the label through.

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./pkg/memvault/ -run TestRenderFacts -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add pkg/memvault/projection.go pkg/memvault/projection_test.go
git commit -m "feat(memvault): render hub notes as steering facts with echo rule"
```

---

## Task 3: Steering region splice (Go, pure)

Idempotently replaces the `ARC-MEMORY` region in an existing steering file's content, or appends it if absent. Everything outside the markers is preserved byte-for-byte.

**Files:**
- Modify: `pkg/memvault/projection.go`
- Modify: `pkg/memvault/projection_test.go`

- [ ] **Step 1: Write the failing test**

Append to `pkg/memvault/projection_test.go`:

```go
func TestApplySteeringRegion(t *testing.T) {
	// append when absent, preserving user content
	existing := "# My steering\n\nDo the thing.\n"
	out := applySteeringRegion(existing, "krypton", "BODY-ONE")
	if !strings.HasPrefix(out, existing) {
		t.Fatalf("user content not preserved on append:\n%s", out)
	}
	if !strings.Contains(out, "project=krypton") || !strings.Contains(out, "BODY-ONE") {
		t.Fatalf("region not appended:\n%s", out)
	}
	if !strings.Contains(out, "ARC-MEMORY:END") {
		t.Fatalf("missing END marker:\n%s", out)
	}

	// second apply REPLACES the region in place (idempotent — no duplicate region, user text intact)
	out2 := applySteeringRegion(out, "krypton", "BODY-TWO")
	if strings.Count(out2, "ARC-MEMORY:BEGIN") != 1 {
		t.Fatalf("duplicate region after re-apply:\n%s", out2)
	}
	if strings.Contains(out2, "BODY-ONE") || !strings.Contains(out2, "BODY-TWO") {
		t.Fatalf("region not replaced:\n%s", out2)
	}
	if !strings.Contains(out2, "Do the thing.") {
		t.Fatalf("user content lost on replace:\n%s", out2)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./pkg/memvault/ -run TestApplySteeringRegion -v`
Expected: FAIL — `undefined: applySteeringRegion`.

- [ ] **Step 3: Write minimal implementation**

Add to `pkg/memvault/projection.go`:

```go
const projectionEnd = "<!-- ARC-MEMORY:END -->"

// applySteeringRegion returns existing with the ARC-MEMORY region set to body (for project label).
// Replaces an existing region in place; appends one (separated by a blank line) if none is present.
// Content outside the markers is untouched.
func applySteeringRegion(existing, label, body string) string {
	begin := fmt.Sprintf(projectionHeader, label)
	region := begin + "\n" + body + projectionEnd + "\n"

	startIdx := strings.Index(existing, "<!-- ARC-MEMORY:BEGIN")
	if startIdx >= 0 {
		endIdx := strings.Index(existing[startIdx:], projectionEnd)
		if endIdx >= 0 {
			tail := existing[startIdx+endIdx+len(projectionEnd):]
			tail = strings.TrimLeft(tail, "\n")
			head := existing[:startIdx]
			return head + region + tail
		}
	}
	if existing != "" && !strings.HasSuffix(existing, "\n") {
		existing += "\n"
	}
	if existing != "" {
		existing += "\n"
	}
	return existing + region
}
```

Add `"fmt"` to the imports in `projection.go`:

```go
import (
	"fmt"
	"path/filepath"
	"strings"
)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./pkg/memvault/ -run TestApplySteeringRegion -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add pkg/memvault/projection.go pkg/memvault/projection_test.go
git commit -m "feat(memvault): idempotent steering-region splice"
```

---

## Task 4: Hub reader + steering paths + Project orchestrator (Go)

Reads a project's hub notes (with bodies), then writes each lackey runtime's steering file. This touches the real filesystem, so it's covered by a temp-dir integration test rather than a pure unit test.

**Files:**
- Modify: `pkg/memvault/projection.go`
- Modify: `pkg/memvault/projection_test.go`

- [ ] **Step 1: Write the failing test**

Append to `pkg/memvault/projection_test.go` (add `"os"`, `"path/filepath"` to imports):

```go
func TestProjectToSteeringFiles(t *testing.T) {
	tmp := t.TempDir()
	hub := filepath.Join(tmp, "hub")
	if err := os.MkdirAll(hub, 0o755); err != nil {
		t.Fatal(err)
	}
	note := "---\nname: prefer-pg\ndescription: DB of record\nmetadata:\n  type: project\n---\n\n# Prefer Postgres\n\nUse Postgres.\n"
	if err := os.WriteFile(filepath.Join(hub, "prefer-pg.md"), []byte(note), 0o644); err != nil {
		t.Fatal(err)
	}
	codex := filepath.Join(tmp, "AGENTS.md")
	if err := os.WriteFile(codex, []byte("# user steering\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	agy := filepath.Join(tmp, "GEMINI.md")

	targets := []steeringTarget{{runtime: "codex", path: codex}, {runtime: "antigravity", path: agy}}
	if err := projectHubToTargets(hub, "krypton", targets); err != nil {
		t.Fatalf("projectHubToTargets: %v", err)
	}

	cb, _ := os.ReadFile(codex)
	if !strings.Contains(string(cb), "Prefer Postgres") || !strings.Contains(string(cb), "# user steering") {
		t.Fatalf("codex steering wrong:\n%s", cb)
	}
	ab, err := os.ReadFile(agy) // agy file did not exist -> created
	if err != nil || !strings.Contains(string(ab), "project=krypton") {
		t.Fatalf("agy steering not created/written: err=%v\n%s", err, ab)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./pkg/memvault/ -run TestProjectToSteeringFiles -v`
Expected: FAIL — `undefined: steeringTarget` / `projectHubToTargets`.

- [ ] **Step 3: Write minimal implementation**

Add to `pkg/memvault/projection.go` (add `"os"` and `"github.com/wavetermdev/waveterm/pkg/wavebase"` + `"github.com/wavetermdev/waveterm/pkg/wconfig"` to imports):

```go
type steeringTarget struct {
	runtime string // "codex" | "antigravity"
	path    string
}

// steeringTargets are the home-level steering files for each lackey runtime. Global (home) files
// only — never repo-tracked files. Paths mirror the spike findings.
func steeringTargets() []steeringTarget {
	home := wavebase.GetHomeDir()
	return []steeringTarget{
		{runtime: "codex", path: filepath.Join(home, ".codex", "AGENTS.md")},
		{runtime: "antigravity", path: filepath.Join(home, ".gemini", "GEMINI.md")},
	}
}

// readHubNotes reads every .md note (with body) directly under hubDir. Missing dir -> empty slice.
func readHubNotes(hubDir string) []NoteWithBody {
	entries, err := os.ReadDir(hubDir)
	if err != nil {
		return nil
	}
	var out []NoteWithBody
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".md") {
			continue
		}
		p := filepath.Join(hubDir, e.Name())
		data, readErr := os.ReadFile(p)
		if readErr != nil {
			continue
		}
		n, body := parseNote(p, data, "claude")
		out = append(out, NoteWithBody{Note: n, Body: body})
	}
	return out
}

// projectHubToTargets renders the hub notes and writes each target's steering region.
func projectHubToTargets(hubDir, label string, targets []steeringTarget) error {
	notes := readHubNotes(hubDir)
	for _, tgt := range targets {
		var existing string
		if data, err := os.ReadFile(tgt.path); err == nil {
			existing = string(data)
		}
		body := renderFacts(label, notes, tgt.runtime)
		out := applySteeringRegion(existing, label, body)
		if err := os.MkdirAll(filepath.Dir(tgt.path), 0o755); err != nil {
			return fmt.Errorf("creating steering dir for %s: %w", tgt.runtime, err)
		}
		if err := os.WriteFile(tgt.path, []byte(out), 0o644); err != nil {
			return fmt.Errorf("writing %s steering: %w", tgt.runtime, err)
		}
	}
	return nil
}

// registryProjects reads the Projects registry (name -> path) from live config.
func registryProjects() map[string]string {
	out := map[string]string{}
	cfg := wconfig.GetWatcher().GetFullConfig()
	for name, pk := range cfg.Projects {
		if pk.Path != "" {
			out[name] = pk.Path
		}
	}
	return out
}

// Project renders cwd's Claude hub memory into all lackey steering files. This is the public
// entry point called by the MemoryProjectCommand RPC at agent launch (and the manual button).
func Project(cwd string) error {
	if cwd == "" {
		return fmt.Errorf("cwd is required")
	}
	hubDir := filepath.Join(wavebase.GetHomeDir(), ".claude", "projects", projectHash(cwd), "memory")
	label := projectLabel(cwd, registryProjects())
	return projectHubToTargets(hubDir, label, steeringTargets())
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./pkg/memvault/ -v`
Expected: PASS (all memvault tests, including the new integration test).

- [ ] **Step 5: Commit**

```bash
git add pkg/memvault/projection.go pkg/memvault/projection_test.go
git commit -m "feat(memvault): Project(cwd) writes hub memory into lackey steering files"
```

---

## Task 5: MemoryProjectCommand + MemoryProjectionStatusCommand (wshrpc)

Adds the two RPCs and regenerates bindings. `MemoryProjectCommand` runs `Project(cwd)`. `MemoryProjectionStatusCommand` reads each steering file's region header so the UI can show what each lackey currently reflects.

**Files:**
- Modify: `pkg/wshrpc/wshrpctypes.go:100-104` (interface) and near `:724-780` (types)
- Modify: `pkg/wshrpc/wshserver/wshserver.go` (after `MemoryDeleteCommand`, ~`:1563`)
- Modify: `pkg/memvault/projection.go` (add a status reader)
- Regenerated (do not hand-edit): `wshclient.go`, `wshclientapi.ts`, `gotypes.d.ts`

- [ ] **Step 1: Write the failing test (status reader in memvault)**

Append to `pkg/memvault/projection_test.go`:

```go
func TestProjectionStatus(t *testing.T) {
	tmp := t.TempDir()
	codex := filepath.Join(tmp, "AGENTS.md")
	os.WriteFile(codex, applySteeringRegionSeed("krypton"), 0o644)
	agy := filepath.Join(tmp, "GEMINI.md") // absent

	st := projectionStatusFor([]steeringTarget{{runtime: "codex", path: codex}, {runtime: "antigravity", path: agy}})
	if st["codex"] != "krypton" {
		t.Fatalf("codex status = %q, want krypton", st["codex"])
	}
	if _, ok := st["antigravity"]; ok {
		t.Fatalf("absent steering file should not appear in status")
	}
}

// applySteeringRegionSeed is a tiny test helper producing a file with a region.
func applySteeringRegionSeed(label string) []byte {
	return []byte(applySteeringRegion("", label, "body\n"))
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./pkg/memvault/ -run TestProjectionStatus -v`
Expected: FAIL — `undefined: projectionStatusFor`.

- [ ] **Step 3: Implement the status reader**

Add to `pkg/memvault/projection.go` (add `"regexp"` to imports):

```go
var projectionMarkerRe = regexp.MustCompile(`<!-- ARC-MEMORY:BEGIN project=(.+?) \(generated`)

// projectionStatusFor returns runtime -> project label for each steering file that currently has
// an ARC-MEMORY region. Files without a region (or absent) are omitted.
func projectionStatusFor(targets []steeringTarget) map[string]string {
	out := map[string]string{}
	for _, tgt := range targets {
		data, err := os.ReadFile(tgt.path)
		if err != nil {
			continue
		}
		if m := projectionMarkerRe.FindStringSubmatch(string(data)); m != nil {
			out[tgt.runtime] = m[1]
		}
	}
	return out
}

// ProjectionStatus is the public status entry point for the RPC.
func ProjectionStatus() map[string]string {
	return projectionStatusFor(steeringTargets())
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./pkg/memvault/ -run TestProjectionStatus -v`
Expected: PASS.

- [ ] **Step 5: Add the wshrpc types + interface methods**

In `pkg/wshrpc/wshrpctypes.go`, add to the command interface right after line 104 (`MemoryDeleteCommand`):

```go
	MemoryProjectCommand(ctx context.Context, data CommandMemoryProjectData) error
	MemoryProjectionStatusCommand(ctx context.Context) (*CommandMemoryProjectionStatusRtnData, error)
```

And add the data types near the other Memory types (after `CommandMemoryDeleteData`, ~line 780):

```go
type CommandMemoryProjectData struct {
	Cwd string `json:"cwd"`
}

type CommandMemoryProjectionStatusRtnData struct {
	// Runtimes maps a lackey runtime ("codex" | "antigravity") to the project label its steering
	// file currently reflects. A runtime missing from the map has no projection yet.
	Runtimes map[string]string `json:"runtimes"`
}
```

- [ ] **Step 6: Implement the server handlers**

In `pkg/wshrpc/wshserver/wshserver.go`, add after `MemoryDeleteCommand` (~line 1563):

```go
func (ws *WshServer) MemoryProjectCommand(ctx context.Context, data wshrpc.CommandMemoryProjectData) error {
	if err := memvault.Project(data.Cwd); err != nil {
		return fmt.Errorf("projecting memory: %w", err)
	}
	return nil
}

func (ws *WshServer) MemoryProjectionStatusCommand(ctx context.Context) (*wshrpc.CommandMemoryProjectionStatusRtnData, error) {
	return &wshrpc.CommandMemoryProjectionStatusRtnData{Runtimes: memvault.ProjectionStatus()}, nil
}
```

- [ ] **Step 7: Regenerate bindings and build**

Run: `task generate && go build ./...`
Expected: no errors; `git status` shows regenerated `wshclient.go`, `wshclientapi.ts`, `gotypes.d.ts` alongside your edits.

- [ ] **Step 8: Verify the client binding exists**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: only the ~3 pre-existing `frontend/tauri/api.test.ts` baseline errors (confirms `RpcApi.MemoryProjectCommand` / `MemoryProjectionStatusCommand` typecheck).

- [ ] **Step 9: Commit**

```bash
git add pkg/memvault/ pkg/wshrpc/wshrpctypes.go pkg/wshrpc/wshserver/wshserver.go \
  pkg/wshrpc/wshclient/wshclient.go frontend/app/store/wshclientapi.ts frontend/types/gotypes.d.ts
git commit -m "feat(wshrpc): MemoryProject + MemoryProjectionStatus commands"
```

---

## Task 6: Repoint note authoring to the focused project's hub (Go)

`MemoryCreateCommand` currently always writes to the dedicated vault (`DefaultVaultPath()`). Add an optional `Cwd`: when present, write into that project's Claude hub instead.

**Files:**
- Modify: `pkg/wshrpc/wshrpctypes.go` (`CommandMemoryCreateData`, ~line 767)
- Modify: `pkg/wshrpc/wshserver/wshserver.go` (`MemoryCreateCommand`, ~line 1550)
- Modify: `pkg/memvault/projection.go` (export a hub-dir resolver)
- Regenerated: `wshclient.go`, `wshclientapi.ts`, `gotypes.d.ts`

- [ ] **Step 1: Write the failing test (hub-dir resolver)**

Append to `pkg/memvault/projection_test.go`:

```go
func TestHubDirForCwd(t *testing.T) {
	got := HubDirForCwd(`C:\p\krypton`)
	if !strings.HasSuffix(filepath.ToSlash(got), ".claude/projects/C--p-krypton/memory") {
		t.Fatalf("HubDirForCwd = %q", got)
	}
	if HubDirForCwd("") != "" {
		t.Fatalf("empty cwd must yield empty hub dir")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./pkg/memvault/ -run TestHubDirForCwd -v`
Expected: FAIL — `undefined: HubDirForCwd`.

- [ ] **Step 3: Implement + refactor Project to reuse it**

In `pkg/memvault/projection.go`, add:

```go
// HubDirForCwd returns the Claude per-project memory dir for a cwd, or "" for an empty cwd.
func HubDirForCwd(cwd string) string {
	if cwd == "" {
		return ""
	}
	return filepath.Join(wavebase.GetHomeDir(), ".claude", "projects", projectHash(cwd), "memory")
}
```

Replace the `hubDir := ...` line inside `Project` with:

```go
	hubDir := HubDirForCwd(cwd)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./pkg/memvault/ -run TestHubDirForCwd -v`
Expected: PASS.

- [ ] **Step 5: Add `Cwd` to the create data type**

In `pkg/wshrpc/wshrpctypes.go`, change `CommandMemoryCreateData` (~line 767) to:

```go
type CommandMemoryCreateData struct {
	Name  string `json:"name"`
	Type  string `json:"type,omitempty"`
	Scope string `json:"scope,omitempty"`
	Body  string `json:"body,omitempty"`
	Cwd   string `json:"cwd,omitempty"` // write into this project's Claude hub; empty -> dedicated vault
}
```

- [ ] **Step 6: Repoint the create handler**

In `pkg/wshrpc/wshserver/wshserver.go`, change `MemoryCreateCommand` (~line 1550) body's first line to select the target dir:

```go
func (ws *WshServer) MemoryCreateCommand(ctx context.Context, data wshrpc.CommandMemoryCreateData) (*wshrpc.CommandMemoryCreateRtnData, error) {
	vaultDir := memvault.DefaultVaultPath()
	if hub := memvault.HubDirForCwd(data.Cwd); hub != "" {
		vaultDir = hub
	}
	path, err := memvault.CreateNote(vaultDir, data.Name, data.Type, data.Scope, data.Body)
	if err != nil {
		return nil, fmt.Errorf("creating note: %w", err)
	}
	return &wshrpc.CommandMemoryCreateRtnData{Path: path}, nil
}
```

- [ ] **Step 7: Regenerate + build**

Run: `task generate && go build ./...`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add pkg/memvault/ pkg/wshrpc/wshrpctypes.go pkg/wshrpc/wshserver/wshserver.go \
  pkg/wshrpc/wshclient/wshclient.go frontend/app/store/wshclientapi.ts frontend/types/gotypes.d.ts
git commit -m "feat(memvault): authoring writes into the focused project's Claude hub"
```

---

## Task 7: Readable scope for Claude-hub notes (Go)

`deriveScope` returns the note's parent-folder name relative to the root. For `claude`-source notes that is the encoded hash (`C--Users-...-krypton`), which is exactly the unreadable label to avoid. Map it to a readable label.

**Files:**
- Modify: `pkg/memvault/memvault.go` (`deriveScope`, ~line 154)
- Modify: `pkg/memvault/memvault_test.go`

- [ ] **Step 1: Write the failing test**

Append to `pkg/memvault/memvault_test.go`:

```go
func TestDeriveScopeReadableForClaude(t *testing.T) {
	r := Root{Path: `/home/k/.claude/projects`, Source: "claude"}
	// note lives under the encoded-hash project dir
	path := `/home/k/.claude/projects/-home-k-code-krypton/memory/note.md`
	if got := deriveScope(r, path); got != "krypton" {
		t.Fatalf("claude scope = %q, want readable leaf 'krypton'", got)
	}
	// vault-source notes keep the raw folder name
	rv := Root{Path: `/vault`, Source: "vault"}
	if got := deriveScope(rv, `/vault/teamx/note.md`); got != "teamx" {
		t.Fatalf("vault scope = %q, want 'teamx'", got)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./pkg/memvault/ -run TestDeriveScopeReadableForClaude -v`
Expected: FAIL — claude scope comes back as `-home-k-code-krypton`.

- [ ] **Step 3: Implement**

In `pkg/memvault/memvault.go`, change `deriveScope` to translate the hash for `claude` roots:

```go
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
	first := parts[0]
	if r.Source == "claude" {
		// first is Claude's encoded project-hash dir; show a readable label instead.
		return labelFromHash(first, registryProjects())
	}
	return first
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./pkg/memvault/ -v`
Expected: PASS (all memvault tests).

- [ ] **Step 5: Commit**

```bash
git add pkg/memvault/memvault.go pkg/memvault/memvault_test.go
git commit -m "fix(memvault): group Claude-hub notes under a readable project label"
```

---

## Task 8: `projectLabel` frontend helper (TS, pure)

Display helper mirroring the Go one, for the sync strip. Reads the Projects registry shape from config.

**Files:**
- Create: `frontend/app/view/agents/projectlabel.ts`
- Create: `frontend/app/view/agents/projectlabel.test.ts`

- [ ] **Step 1: Write the failing test**

Create `frontend/app/view/agents/projectlabel.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { projectLabel } from "./projectlabel";

describe("projectLabel", () => {
    const projects = { "Krypton API": { path: "C:\\Users\\k\\IdeaProjects\\krypton" } };

    it("uses the registry name on a path match", () => {
        expect(projectLabel("C:\\Users\\k\\IdeaProjects\\krypton", projects)).toBe("Krypton API");
    });
    it("falls back to the leaf folder on a miss", () => {
        expect(projectLabel("C:\\Users\\k\\IdeaProjects\\waveterm", projects)).toBe("waveterm");
    });
    it("handles posix paths", () => {
        expect(projectLabel("/home/k/code/foo", {})).toBe("foo");
    });
    it("returns empty for empty cwd", () => {
        expect(projectLabel("", {})).toBe("");
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run frontend/app/view/agents/projectlabel.test.ts`
Expected: FAIL — cannot resolve `./projectlabel`.

- [ ] **Step 3: Implement**

Create `frontend/app/view/agents/projectlabel.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Readable project label for display: the Projects-registry name if the cwd matches a registered
// path, else the leaf folder of the cwd. Never surfaces Claude's encoded hash dir name. Pure.

function leaf(cwd: string): string {
    const parts = cwd.replace(/[\\/]+$/, "").split(/[\\/]/);
    return parts[parts.length - 1] ?? "";
}

function samePath(a: string, b: string): boolean {
    const norm = (p: string) => p.replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase();
    return norm(a) === norm(b);
}

export function projectLabel(cwd: string, projects: Record<string, { path?: string }>): string {
    if (!cwd) return "";
    for (const [name, pk] of Object.entries(projects ?? {})) {
        if (pk?.path && samePath(pk.path, cwd)) return name;
    }
    return leaf(cwd);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run frontend/app/view/agents/projectlabel.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/app/view/agents/projectlabel.ts frontend/app/view/agents/projectlabel.test.ts
git commit -m "feat(agents): projectLabel display helper"
```

---

## Task 9: `createNote` passes the focused agent's cwd (TS)

`memstore.createNote` gains an optional `cwd`; `newmemorymodal` resolves the focused agent's cwd and passes it so new notes land in that project's hub.

**Files:**
- Modify: `frontend/app/view/agents/memstore.ts` (`createNote`, lines 74-77)
- Modify: `frontend/app/view/agents/newmemorymodal.tsx`
- Modify: `frontend/app/view/agents/memorysurface.tsx` (pass focused agent to the modal)

- [ ] **Step 1: Extend `createNote`**

In `frontend/app/view/agents/memstore.ts`, change `createNote` (lines 74-77) to:

```ts
export async function createNote(name: string, type: string, scope: string, body: string, cwd?: string): Promise<void> {
    await RpcApi.MemoryCreateCommand(TabRpcClient, { name, type, scope, body, cwd });
    await loadMemory();
}
```

- [ ] **Step 2: Thread cwd into the modal**

In `frontend/app/view/agents/newmemorymodal.tsx`:

Change the component signature (line 14) to accept an optional cwd:

```tsx
export function NewMemoryModal({ onClose, cwd }: { onClose: () => void; cwd?: string }) {
```

Change the `save` call (line 35) to pass it:

```tsx
            await createNote(name.trim(), type, scope.trim(), body.trim(), cwd);
```

Update the header comment (lines 4-5) to reflect the new behavior:

```tsx
// New-memory modal: name + type + scope + body. Creates a note in the focused project's Claude
// hub (via memstore.createNote with the focused agent's cwd), falling back to the dedicated vault
// when no agent is focused. Esc / backdrop click cancels.
```

- [ ] **Step 3: Resolve + pass the focused agent's cwd where the modal is opened**

In `frontend/app/view/agents/memorysurface.tsx`, find where `<NewMemoryModal ... />` is rendered. Mirror the FilesSurface focused-agent pattern (`filessurface.tsx:103-116`):

- Ensure these imports exist at the top:

```tsx
import { useAtomValue } from "jotai";
import { useEffect, useState } from "react";
import { resolveCwd } from "./agentcwdresolve";
```

- Inside the `MemorySurface({ model })` component body, add the focused-agent cwd resolution:

```tsx
    const focusId = useAtomValue(model.focusIdAtom);
    const agents = useAtomValue(model.agentsAtom);
    const agent = agents.find((a) => a.id === focusId);
    const [focusedCwd, setFocusedCwd] = useState<string | null>(null);
    useEffect(() => {
        let live = true;
        void resolveCwd(agent?.transcriptPath, agent?.blockId).then((c) => {
            if (live) setFocusedCwd(c);
        });
        return () => {
            live = false;
        };
    }, [agent?.transcriptPath, agent?.blockId]);
```

- Pass it to the modal:

```tsx
                <NewMemoryModal onClose={() => setShowNew(false)} cwd={focusedCwd ?? undefined} />
```

(Use the surface's existing `showNew`/modal-visibility state name; only the `cwd` prop is added.)

- [ ] **Step 4: Typecheck + tests**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: only the ~3 baseline `api.test.ts` errors.

Run: `npx vitest run frontend/app/view/agents/`
Expected: PASS (existing memory/agents tests still green).

- [ ] **Step 5: Commit**

```bash
git add frontend/app/view/agents/memstore.ts frontend/app/view/agents/newmemorymodal.tsx frontend/app/view/agents/memorysurface.tsx
git commit -m "feat(agents): new memory notes target the focused project's hub"
```

---

## Task 10: Project on launch (TS)

Hook projection into the launch flow so a Codex/antigravity lackey boots with the project's current Claude brain.

**Files:**
- Modify: `frontend/app/cockpit/cockpit-actions.ts` (`launchAgent`, after the block SetMeta, ~line 54)

- [ ] **Step 1: Add the projection call**

In `frontend/app/cockpit/cockpit-actions.ts`, immediately after the first `SetMetaCommand` (block meta, ends line 54) and before the tab-meta `SetMetaCommand`, insert:

```ts
    // Project the launch project's Claude memory into the lackey steering files so a Codex/agy
    // agent boots with the primary agent's brain. Fire-and-forget: a projection failure must not
    // block the launch. Terminals have no memory; claude IS the hub, so neither needs projection.
    if (opts.runtime === "codex" || opts.runtime === "antigravity") {
        void RpcApi.MemoryProjectCommand(TabRpcClient, { cwd }).catch(() => {});
    }
```

(`cwd`, `RpcApi`, and `TabRpcClient` are already in scope in this file.)

- [ ] **Step 2: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: only the ~3 baseline `api.test.ts` errors (confirms `MemoryProjectCommand` is wired).

- [ ] **Step 3: Build the frontend**

Run: `npm run build` is heavy; instead confirm the module compiles via the typecheck above. (Full `cargo tauri build` is not needed for this task.)

- [ ] **Step 4: Commit**

```bash
git add frontend/app/cockpit/cockpit-actions.ts
git commit -m "feat(cockpit): project Claude memory into lackey steering on launch"
```

---

## Task 11: Sync strip UI (TS)

A compact strip on the Memory surface showing which project each lackey's steering file currently reflects, plus a "Project now" button that projects the focused agent's project on demand.

**Files:**
- Create: `frontend/app/view/agents/syncstrip.tsx`
- Modify: `frontend/app/view/agents/memorysurface.tsx` (render `<SyncStrip>`)

- [ ] **Step 1: Implement the strip**

Create `frontend/app/view/agents/syncstrip.tsx`:

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Memory-surface projection status: shows which project each lackey runtime's steering file
// currently reflects (from MemoryProjectionStatusCommand), and a "Project now" button that
// projects the focused agent's project into the lackey steering files on demand.

import { atoms } from "@/app/store/global-atoms";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { useCallback, useEffect, useState } from "react";
import { projectLabel } from "./projectlabel";

const RUNTIME_LABEL: Record<string, string> = { codex: "Codex", antigravity: "Antigravity" };

export function SyncStrip({ focusedCwd }: { focusedCwd: string | null }) {
    const config = useAtomValue(atoms.fullConfigAtom);
    const [status, setStatus] = useState<Record<string, string>>({});
    const [busy, setBusy] = useState(false);

    const refresh = useCallback(() => {
        void RpcApi.MemoryProjectionStatusCommand(TabRpcClient)
            .then((r) => setStatus(r.runtimes ?? {}))
            .catch(() => setStatus({}));
    }, []);

    useEffect(refresh, [refresh]);

    const projectNow = () => {
        if (!focusedCwd || busy) return;
        setBusy(true);
        fireAndForget(async () => {
            try {
                await RpcApi.MemoryProjectCommand(TabRpcClient, { cwd: focusedCwd });
                refresh();
            } finally {
                setBusy(false);
            }
        });
    };

    const label = projectLabel(focusedCwd ?? "", config?.projects ?? {});
    const runtimes = ["codex", "antigravity"];

    return (
        <div className="flex items-center gap-[12px] border-b border-edge-faint px-[16px] py-[9px] text-[12px]">
            <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-ink-faint">
                Projection
            </span>
            {runtimes.map((rt) => {
                const proj = status[rt];
                return (
                    <span key={rt} className="flex items-center gap-[6px] text-ink-mid">
                        <span className={cn("h-[6px] w-[6px] rounded-full", proj ? "bg-mem-project" : "bg-ink-faint")} />
                        {RUNTIME_LABEL[rt]}
                        {proj ? <span className="text-accent-soft">· {proj}</span> : <span className="text-ink-faint">· none</span>}
                    </span>
                );
            })}
            <div className="flex-1" />
            <button
                onClick={projectNow}
                disabled={!focusedCwd || busy}
                title={focusedCwd ? `Project ${label} into the lackey steering files` : "Focus an agent to project its project"}
                className="rounded-[7px] border border-border px-[11px] py-[5px] text-[11.5px] font-semibold text-ink-mid hover:text-foreground disabled:opacity-40"
            >
                {busy ? "Projecting…" : "Project now"}
            </button>
        </div>
    );
}
```

- [ ] **Step 2: Render it on the Memory surface**

In `frontend/app/view/agents/memorysurface.tsx`:

- Import the strip:

```tsx
import { SyncStrip } from "./syncstrip";
```

- Render `<SyncStrip focusedCwd={focusedCwd} />` at the top of the surface's returned layout (above the list/graph), reusing the `focusedCwd` state added in Task 9.

- [ ] **Step 3: Typecheck + tests**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: only the ~3 baseline `api.test.ts` errors.

Run: `npx vitest run frontend/app/view/agents/`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add frontend/app/view/agents/syncstrip.tsx frontend/app/view/agents/memorysurface.tsx
git commit -m "feat(agents): Memory-surface projection status strip + Project now"
```

---

## Task 12: Full-suite gate + manual verification

**Files:** none (verification only)

- [ ] **Step 1: Go tests**

Run: `go test ./pkg/memvault/ ./pkg/wshrpc/...`
Expected: PASS.

- [ ] **Step 2: Frontend tests**

Run: `npx vitest run`
Expected: PASS (baseline count + the new `projectlabel` test; 1 known preview flake is acceptable).

- [ ] **Step 3: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: only the ~3 baseline `frontend/tauri/api.test.ts` errors.

- [ ] **Step 4: Backend build**

Run: `task build:backend`
Expected: builds `wavesrv` + `wsh` into `dist/bin/` with no errors.

- [ ] **Step 5: Live manual check (dev app + CDP)**

Per CLAUDE.md "Visual verification": run the dev app (`tail -f /dev/null | task dev` — see the stdin-EOF gotcha), launch a Codex or antigravity agent in a project that has Claude memory, then confirm:
- `~/.codex/AGENTS.md` (or `~/.gemini/GEMINI.md`) now contains an `ARC-MEMORY:BEGIN project=<label>` region with the project's notes rendered as facts, and the user's pre-existing steering text is intact outside the region.
- The Memory surface Sync strip shows the runtime with the correct project label.
- Creating a new note in the Memory surface while an agent is focused writes into `~/.claude/projects/<hash>/memory/`, not `~/.waveterm/memory`.

This step is a manual gate; note the result in the PR/summary. (Consistent with prior surfaces, automated gates are green before this check.)

---

## Self-Review

**1. Spec coverage** (Phase A slice only):
- Projection into steering-file delimited region → Tasks 2, 3, 4, 5, 10. ✅
- Home-level steering files, never repo files → `steeringTargets()` (Task 4). ✅
- Facts-not-directives rendering → `renderFacts` (Task 2). ✅
- Echo rule (no `source: X` note back to X) → `renderFacts` exclusion (Task 2), verified in test. ✅
- Launch-time trigger (revised from fsnotify per the Explore finding) → Task 10. ✅
- Viewer repoint to focused project's Claude hub → Tasks 6, 9. ✅
- Readable project label everywhere; hash stays backend-internal → Tasks 1, 7 (Go scope), 8 (FE), 11 (strip). ✅
- Sync strip status + "Project now" → Task 11. ✅
- Harvest (Phases B/C) → intentionally OUT of this plan. ✅

**2. Placeholder scan:** No TBD/TODO. Every code step shows complete code. The one non-literal step is Task 9/11's "render at the top of the existing layout / reuse the existing modal-visibility state" — this is because `memorysurface.tsx`'s exact JSX (modal-toggle state name, layout root) must be read at execution time; the inserted code and its placement are fully specified, only the existing state variable name is deferred to what's on disk.

**3. Type consistency:**
- Go: `Project(cwd)`, `HubDirForCwd(cwd)`, `ProjectionStatus()`, `projectHash`, `projectLabel(cwd, map)`, `labelFromHash(hash, map)`, `renderFacts(label, []NoteWithBody, runtime)`, `applySteeringRegion(existing, label, body)`, `steeringTarget{runtime,path}`, `projectHubToTargets(hubDir,label,targets)`, `projectionStatusFor(targets)` — names consistent across Tasks 1-7.
- `NoteWithBody` is the existing memvault type (`memvault.go:199`), reused unchanged.
- wshrpc: `CommandMemoryProjectData{Cwd}`, `CommandMemoryProjectionStatusRtnData{Runtimes}`, `CommandMemoryCreateData.Cwd` — consistent between type defs (Task 5/6) and server handlers.
- TS: `projectLabel(cwd, projects)` matches its Go sibling's contract; `createNote(name,type,scope,body,cwd?)` consistent between `memstore.ts` and `newmemorymodal.tsx`; `MemoryProjectCommand({cwd})` / `MemoryProjectionStatusCommand()` match the generated client from Task 5.

**Runtime-string consistency note:** the frontend `Runtime` union uses `"antigravity"` (launch.ts:4); the backend steering target and echo runtime string must also be `"antigravity"` (not `"agy"`). `steeringTargets()` and the launch-hook guard both use `"antigravity"`. The `source` tag written by future harvest (Phase B/C) must match these runtime strings for the echo rule to bite.
