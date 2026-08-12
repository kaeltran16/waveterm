# Memory Re-Centralization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the configured vault (`memory:vaultpath`, default `~/.waveterm/vault`) the single source of truth for memory — the scan reads it, every write targets it, Claude hubs / Codex / pi-memory become derived sync surfaces (harvest in, projection out), and the existing hub notes fold into the vault once.

**Architecture:** `memroots` resolves one root (`memory:vaultpath` → `jarvis:vaultpath` → default) and stops federating mirrors. All memvault write paths (`CreateNote`, `AcceptPending`, `RouteLearnings`, `Harvest`) target `<vault>/memory`. Three harvests fold native agent memory into the vault (Claude hub sweep, Codex `MEMORY.md`, pi-memory `MEMORY.md`), all deduped by `factHash`; the sweep hook runs at boot (the one-time fold) and hourly. Projection sources vault notes (per-project scope filter + echo rule) into steering files (codex/pi/gemini + new opencode) and exports them into Claude hubs. The wavevault retriever and memgarden gardener read the vault only. No wshrpc/waveobj changes, so no `task generate`.

**Tech Stack:** Go (wavesrv backend), existing memvault/memroots/memdistill/memgarden packages, existing `factHash`/`existingHashes`/`archivedHashes` dedup machinery.

## Global Constraints

- Windows dev machine: bare `go test ./pkg/...` fails to build 6 packages without `CGO_CFLAGS=-O2 -g -I<repo>/pkg/jarvisembed/csrc` (Windows-style path, from PowerShell or `$(pwd -W)` in bash). `task build:backend` already sets it.
- **Set `memory:vaultpath` to the desired vault (e.g. `C:\Users\kael02\IdeaProjects\obsidian\Work`) BEFORE the first boot after Task 6** — the one-time fold writes into whatever the configured root is at boot time.
- No wshrpc/waveobj/wconfig type changes → do NOT run `task generate`.
- No frontend changes in this plan.
- Comments explain "why", never "what"; lowercase.
- Git: repo convention (AGENTS.md) is one feature commit at the end — the per-task commits below are natural checkpoints; batch them into the single feature commit when finishing.
- Spec: `docs/superpowers/specs/2026-08-12-memory-recentralization-vault-sot-design.md` is the source of truth; the plan is subordinate to it.

---

### Task 1: memroots — one vault root, no mirrors

**Files:**
- Modify: `pkg/memroots/memroots.go` (VaultRoot resolution, delete customLegacyRoot, Mirrors/AllRoots)
- Test: `pkg/memroots/memroots_test.go`

**Interfaces:**
- Consumes: `wconfig.GetWatcher().GetFullConfig().Settings.MemoryVaultPath`, `.JarvisVaultPath`; `wavebase.GetHomeDir()`
- Produces: `VaultRoot() string` (memory:vaultpath → jarvis:vaultpath → `~/.waveterm/vault`); `Mirrors() []Mirror` (empty); `AllRoots() []Mirror` (vault memory only)

- [ ] **Step 1: Write the failing tests**

```go
func TestMirrorsEmpty(t *testing.T) {
	got := buildMirrors("/home/u", "/custom/notes")
	if len(got) != 0 {
		t.Fatalf("buildMirrors = %v, want none (claude/codex are derived sync surfaces now)", got)
	}
}

func TestAllRootsVaultOnly(t *testing.T) {
	got := buildAllRoots("/home/u/.waveterm/vault/memory", buildMirrors("/home/u", ""))
	want := []string{"vault"}
	if len(got) != len(want) || got[0].Source != "vault" {
		t.Fatalf("buildAllRoots = %v, want vault root only", got)
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run (PowerShell): `$env:CGO_CFLAGS="-O2 -g -I$((Get-Location).Path -replace '\\','/')/pkg/jarvisembed/csrc"; go test ./pkg/memroots/`
Expected: FAIL — buildMirrors still returns claude/codex mirrors.

- [ ] **Step 3: Implement**

In `pkg/memroots/memroots.go`:

```go
// VaultRoot resolves the Wave Vault root from config + home. memory:vaultpath is the single SoT
// setting (the key Settings > Memory edits); jarvis:vaultpath remains as a legacy fallback so
// existing jarvis setups keep working; otherwise the default ~/.waveterm/vault.
func VaultRoot() string {
	root := filepath.Join(wavebase.GetHomeDir(), vaultSubpath)
	cfg := wconfig.GetWatcher().GetFullConfig()
	if cfg.Settings.MemoryVaultPath != "" {
		root = wavebase.ExpandHomeDirSafe(cfg.Settings.MemoryVaultPath)
	} else if cfg.Settings.JarvisVaultPath != "" {
		root = wavebase.ExpandHomeDirSafe(cfg.Settings.JarvisVaultPath)
	}
	return root
}
```

Delete `customLegacyRoot()` entirely (its "configured path is a side mirror" behavior is gone — the configured path IS the root). Replace `buildMirrors`:

```go
// buildMirrors returns the external scan roots. None by design: claude hubs / codex / pi-memory
// are derived sync surfaces (harvested into the vault), not independent memory sources — scanning
// them is what produced the duplicate memory rows. Kept as a function for the composition test.
func buildMirrors(home, customLegacy string) []Mirror {
	return nil
}
```

`Mirrors()` and `AllRoots()` bodies stay the same; they now compose to empty + vault-only.

- [ ] **Step 4: Run tests to verify they pass**

Run (PowerShell): the same `go test ./pkg/memroots/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add pkg/memroots/memroots.go pkg/memroots/memroots_test.go
git commit -m "feat(memory): one vault root, drop claude/codex scan mirrors"
```

---

### Task 2: All write paths target the vault

**Files:**
- Modify: `pkg/memvault/memvault.go` (CreateNote writes source_hash), `pkg/wshrpc/wshserver/wshserver_memory.go:58-68` (create), `pkg/memvault/review.go:146-156` (AcceptPending), `pkg/memvault/learn.go:120-175` (RouteLearnings)
- Test: `pkg/memvault/learn_test.go` (or route_test.go), `pkg/memvault/review_test.go`

**Interfaces:**
- Consumes: `memvault.DefaultVaultPath()`, `memvault.factHash(body)` (harvest.go)
- Produces: `CreateNote` writes `metadata.source_hash` (factHash of body); `AcceptPending` and `RouteLearnings` no longer resolve `HubDirForCwd`.

- [ ] **Step 1: Write the failing test (RouteLearnings targets the vault, not a hub)**

In `pkg/memvault/learn_test.go` (append; if the file exists, use `cat >> file <<'EOF'`, never Write):

```go
func TestRouteLearningsTargetsVault(t *testing.T) {
	vaultDir := t.TempDir()
	orig := DefaultVaultPath
	DefaultVaultPath = func() string { return vaultDir }
	defer func() { DefaultVaultPath = orig }()
	res, err := RouteLearnings("C:\\proj\\x", []LearnCandidate{
		{Type: "learning", Scope: "x", Body: "always use pnpm here", IsCorrection: true},
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if res.Committed != 1 {
		t.Fatalf("Committed = %d, want 1", res.Committed)
	}
	entries, _ := os.ReadDir(vaultDir)
	if len(entries) != 1 || !strings.HasSuffix(entries[0].Name(), ".md") {
		t.Fatalf("vault dir = %v, want exactly one note file", entries)
	}
	data, _ := os.ReadFile(filepath.Join(vaultDir, entries[0].Name()))
	if !strings.Contains(string(data), "source_hash:") {
		t.Fatalf("note missing source_hash:\n%s", data)
	}
}
```

(Add `DefaultVaultPath` as a package-level `var` — see Step 3 — so tests can point it at a temp dir.)

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./pkg/memvault/ -run TestRouteLearningsTargetsVault`
Expected: FAIL — note written into `~/.claude/...` (or compiles against the new var and fails the vault-dir assertion).

- [ ] **Step 3: Implement**

In `pkg/memvault/memvault.go`, make the write target injectable and add source_hash to CreateNote:

```go
// DefaultVaultPath is the write target for every cockpit memory write; a var so tests can point it
// at a temp dir.
var DefaultVaultPath = func() string { return memroots.MemoryRoot() }
```

(Delete the old `func DefaultVaultPath()`.) In `CreateNote`, always emit a metadata block with type, scope, and source_hash:

```go
	var b strings.Builder
	b.WriteString("---\n")
	b.WriteString("name: " + slug + "\n")
	if noteType == "" {
		noteType = "learning"
	}
	b.WriteString("metadata:\n")
	b.WriteString("  type: " + noteType + "\n")
	if scope != "" {
		b.WriteString("  scope: " + scope + "\n")
	}
	b.WriteString("  source_hash: " + factHash(body) + "\n")
	b.WriteString("---\n\n")
```

In `pkg/wshrpc/wshserver/wshserver_memory.go` `MemoryCreateCommand`, drop the hub branch:

```go
	path, err := memvault.CreateNote(memvault.DefaultVaultPath(), data.Name, data.Type, data.Scope, data.Body)
```

In `pkg/memvault/review.go` `AcceptPending`, drop the hub branch:

```go
func AcceptPending(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	n, body := parseNote(path, data, "pending")
	return acceptPendingInto(PendingNote{Path: path, Type: n.Type, Scope: n.Scope, Body: strings.TrimSpace(body)}, DefaultVaultPath())
}
```

(Remove the now-unused `pendingCwd` helper if nothing else uses it — check with `go vet`.)

In `pkg/memvault/learn.go` `RouteLearnings`, replace `hub := HubDirForCwd(cwd)` with the vault:

```go
func RouteLearnings(cwd string, candidates []LearnCandidate, references []string) (RouteResult, error) {
	target := DefaultVaultPath()
	var res RouteResult
	for _, cand := range candidates {
		if cand.IsCorrection {
			wrote, slug, err := WriteLearning(target, cand)
			if err != nil {
				return res, fmt.Errorf("writing learning: %w", err)
			}
			if wrote {
				res.Committed++
				res.Written = append(res.Written, WrittenNote{ID: slug, Title: firstLine(cand.Body)})
			}
		} else {
			if _, err := WritePending(PendingDir(), cand, cwd); err != nil {
				return res, fmt.Errorf("queuing candidate: %w", err)
			}
			res.Queued++
		}
	}
	for _, cand := range candidates {
		if cand.Supersedes != "" {
			_, slug, _ := WriteLearning(target, LearnCandidate{Type: cand.Type, Scope: cand.Scope, Body: cand.Body})
			_ = MarkSuperseded(target, cand.Supersedes, slug)
		}
	}
	if len(references) > 0 {
		_ = TouchReferenced(target, references, time.Now().UTC().Format(time.RFC3339))
	}
	return res, nil
}
```

Note `WriteLearning` already writes `scope` and `source_hash` (learn.go) — no change needed there. Existing tests that assert the old `DefaultVaultPath()` function type or CreateNote's exact frontmatter must be updated (`memvault_test.go`, `review_test.go`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./pkg/memvault/ ./pkg/wshrpc/wshserver/`
Expected: PASS (fix any fixture assertions that encoded the old frontmatter shape).

- [ ] **Step 5: Commit**

```bash
git add pkg/memvault/memvault.go pkg/memvault/learn.go pkg/memvault/review.go pkg/wshrpc/wshserver/wshserver_memory.go pkg/memvault/*_test.go
git commit -m "feat(memory): route every memory write into the vault"
```

---

### Task 3: Shared sourced-note writer + Codex harvest repoint

**Files:**
- Modify: `pkg/memvault/harvest.go` (writeSourcedNote core, writeHarvestedNote repoint, scope from cwd)
- Test: `pkg/memvault/harvest_test.go`

**Interfaces:**
- Consumes: `memvault.DefaultVaultPath()`, `memvault.factHash`, `memvault.existingHashes`, `memvault.archivedHashes`
- Produces: `writeSourcedNote(dir, slug, noteType, scope, source, hash string, body string) (bool, error)` — the one writer Tasks 3-7 reuse; `harvestInto(memoryMD, cwd, vaultDir)` writes into the vault with scope.

- [ ] **Step 1: Write the failing test (harvest lands in the vault, scoped to the project)**

In `pkg/memvault/harvest_test.go` (append):

```go
func TestHarvestIntoVault(t *testing.T) {
	vaultDir := t.TempDir()
	md := "## Reusable knowledge\n\n- pnpm is the package manager here\n"
	if _, _, err := harvestInto(md, "C:\\proj\\x", vaultDir); err != nil {
		t.Fatal(err)
	}
	entries, _ := os.ReadDir(vaultDir)
	if len(entries) != 1 {
		t.Fatalf("vault dir = %v, want 1 note", entries)
	}
	data, _ := os.ReadFile(filepath.Join(vaultDir, entries[0].Name()))
	s := string(data)
	for _, want := range []string{"source: codex", "scope: x", "source_hash:"} {
		if !strings.Contains(s, want) {
			t.Fatalf("note missing %q:\n%s", want, s)
		}
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./pkg/memvault/ -run TestHarvestIntoVault`
Expected: FAIL (no `scope:` in the note today).

- [ ] **Step 3: Implement**

In `pkg/memvault/harvest.go`, extract the shared writer and teach harvestInto the vault + scope:

```go
// writeSourcedNote is the one note-file writer: deterministic slug, frontmatter with type/scope/
// source/source_hash, body. Skips silently when the slug already exists. Shared by the codex
// harvest, the claude-hub fold, pi-memory harvest, and the vault→hub export.
func writeSourcedNote(dir, slug, noteType, scope, source, hash, body string) (bool, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return false, err
	}
	path := filepath.Join(dir, slug+".md")
	if _, err := os.Stat(path); err == nil {
		return false, nil // slug collision — never overwrite
	}
	if noteType == "" {
		noteType = "learning"
	}
	var b strings.Builder
	b.WriteString("---\n")
	b.WriteString("name: " + slug + "\n")
	b.WriteString("metadata:\n")
	b.WriteString("  type: " + noteType + "\n")
	if scope != "" {
		b.WriteString("  scope: " + scope + "\n")
	}
	if source != "" {
		b.WriteString("  source: " + source + "\n")
	}
	if hash != "" {
		b.WriteString("  source_hash: " + hash + "\n")
	}
	b.WriteString("---\n\n")
	b.WriteString(body)
	if !strings.HasSuffix(body, "\n") {
		b.WriteString("\n")
	}
	if err := os.WriteFile(path, []byte(b.String()), 0o644); err != nil {
		return false, err
	}
	return true, nil
}

func writeHarvestedNote(vaultDir, bullet, hash, scope string) (bool, error) {
	return writeSourcedNote(vaultDir, harvestSlug(bullet, hash), "reference", scope, "codex", hash, bullet)
}
```

Update `harvestInto` to compute the scope from cwd and write into the vault dir:

```go
func harvestInto(memoryMD, cwd, vaultDir string) (ingested, skipped int, err error) {
	bullets := parseCodexReusable(memoryMD, cwd)
	scope := projectLabel(cwd, memroots.RegistryProjects())
	existing := existingHashes(vaultDir)
	for h := range archivedHashes() {
		existing[h] = true
	}
	for _, bullet := range bullets {
		h := factHash(bullet)
		if existing[h] {
			skipped++
			continue
		}
		wrote, werr := writeHarvestedNote(vaultDir, bullet, h, scope)
		if werr != nil {
			return ingested, skipped, fmt.Errorf("writing harvested note: %w", werr)
		}
		existing[h] = true
		if wrote {
			ingested++
		} else {
			skipped++
		}
	}
	return ingested, skipped, nil
}
```

In `Harvest(cwd)` replace `HubDirForCwd(cwd)` with `DefaultVaultPath()`. Update `harvest_test.go` fixtures that asserted the old signature (`writeHarvestedNote` scope param; harvest-into-hub assertions become vault assertions).

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./pkg/memvault/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add pkg/memvault/harvest.go pkg/memvault/harvest_test.go
git commit -m "feat(memory): codex harvest writes into the vault, scoped to the project"
```

---

### Task 4: Claude hub → vault fold + recall repoint

**Files:**
- Modify: `pkg/memvault/harvest.go` (foldHubNote, HarvestClaudeHubs), `pkg/memvault/recall.go` (RecordRecall → vault)
- Test: `pkg/memvault/harvest_test.go`

**Interfaces:**
- Consumes: `memvault.ClaudeHubDirs()`, `memvault.readHubNotes(hubDir)`, `memroots.ScopeForPath`, `memvault.DefaultVaultPath()`
- Produces: `HarvestClaudeHubs() (ingested, skipped int, err error)` — folds every hub note into the vault preserving scope/source/hash/type/captured_at/reviewed/superseded_by/last_referenced/gardener_flag; idempotent by factHash.

- [ ] **Step 1: Write the failing test**

In `pkg/memvault/harvest_test.go` (append):

```go
func TestHarvestClaudeHubsFoldsIntoVault(t *testing.T) {
	vaultDir := t.TempDir()
	hub := filepath.Join(t.TempDir(), "C--Users-u-proj")
	os.MkdirAll(filepath.Join(hub, "memory"), 0o755)
	notePath := filepath.Join(hub, "memory", "old-gotcha.md")
	body := "---\nname: old-gotcha\nmetadata:\n  type: learning\n---\n\nold project gotcha\n"
	os.WriteFile(notePath, []byte(body), 0o644)

	orig := DefaultVaultPath
	DefaultVaultPath = func() string { return vaultDir }
	defer func() { DefaultVaultPath = orig }()
	origDirs := ClaudeHubDirs
	ClaudeHubDirs = func() []string { return []string{hub} }
	defer func() { ClaudeHubDirs = origDirs }()

	ingested, skipped, err := HarvestClaudeHubs()
	if err != nil {
		t.Fatal(err)
	}
	if ingested != 1 || skipped != 0 {
		t.Fatalf("ingested=%d skipped=%d, want 1/0", ingested, skipped)
	}
	entries, _ := os.ReadDir(vaultDir)
	if len(entries) != 1 || entries[0].Name() != "old-gotcha.md" {
		t.Fatalf("vault = %v, want old-gotcha.md (slug preserved)", entries)
	}
	data, _ := os.ReadFile(filepath.Join(vaultDir, entries[0].Name()))
	s := string(data)
	for _, want := range []string{"name: old-gotcha", "scope:", "source: claude", "source_hash:"} {
		if !strings.Contains(s, want) {
			t.Fatalf("vault note missing %q:\n%s", want, s)
		}
	}
	// idempotent: a second run folds nothing new
	ingested2, _, err := HarvestClaudeHubs()
	if err != nil || ingested2 != 0 {
		t.Fatalf("second fold ingested=%d err=%v, want 0/nil", ingested2, err)
	}
}
```

(Requires `ClaudeHubDirs` and `DefaultVaultPath` to be package-level `var`s — Step 3.)

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./pkg/memvault/ -run TestHarvestClaudeHubsFoldsIntoVault`
Expected: FAIL (HarvestClaudeHubs undefined; ClaudeHubDirs not a var).

- [ ] **Step 3: Implement**

In `pkg/memvault/harvest.go`, add the fold. First make `ClaudeHubDirs` a var (it lives in projection.go):

```go
// ClaudeHubDirs enumerates every existing Claude per-project memory hub. A var so tests can stub it.
var ClaudeHubDirs = func() []string {
	root := filepath.Join(wavebase.GetHomeDir(), ".claude", "projects")
	entries, err := os.ReadDir(root)
	if err != nil {
		return nil
	}
	var out []string
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		hub := filepath.Join(root, e.Name(), "memory")
		if info, statErr := os.Stat(hub); statErr == nil && info.IsDir() {
			out = append(out, hub)
		}
	}
	return out
}
```

(Replace the current `func ClaudeHubDirs()` in projection.go with this var declaration, keeping the same body.)

Add the fold:

```go
// foldHubNote writes one hub note into the vault, preserving its slug, scope, and provenance so
// wikilinks and the prune/decay signals survive the fold.
func foldHubNote(vaultDir string, n Note, body string) (bool, error) {
	if n.Scope == "" {
		n.Scope = "shared"
	}
	slug := boundedSlug(n.ID, "note")
	var b strings.Builder
	b.WriteString("---\n")
	b.WriteString("name: " + slug + "\n")
	b.WriteString("metadata:\n")
	b.WriteString("  type: " + nonEmpty(n.Type, "learning") + "\n")
	b.WriteString("  scope: " + yamlQuote(n.Scope) + "\n")
	if n.Source != "" {
		b.WriteString("  source: " + yamlQuote(n.Source) + "\n")
	}
	b.WriteString("  source_hash: " + factHash(body) + "\n")
	if n.CapturedAt != "" {
		b.WriteString("  captured_at: " + yamlQuote(n.CapturedAt) + "\n")
	}
	if n.Reviewed {
		b.WriteString("  reviewed: true\n")
	}
	if n.SupersededBy != "" {
		b.WriteString("  superseded_by: " + yamlQuote(n.SupersededBy) + "\n")
	}
	if n.LastReferenced != "" {
		b.WriteString("  last_referenced: " + yamlQuote(n.LastReferenced) + "\n")
	}
	if n.GardenerFlag != "" {
		b.WriteString("  gardener_flag: " + yamlQuote(n.GardenerFlag) + "\n")
	}
	b.WriteString("---\n\n")
	b.WriteString(strings.TrimSpace(body) + "\n")
	path := filepath.Join(vaultDir, slug+".md")
	if _, err := os.Stat(path); err == nil {
		return false, nil
	}
	if err := os.WriteFile(path, []byte(b.String()), 0o644); err != nil {
		return false, err
	}
	return true, nil
}

// HarvestClaudeHubs folds every Claude hub note into the vault, deduped by body hash. The first run
// is the migration; later runs pick up new organic writes. Idempotent and add-only.
func HarvestClaudeHubs() (int, int, error) {
	vaultDir := DefaultVaultPath()
	if err := os.MkdirAll(vaultDir, 0o755); err != nil {
		return 0, 0, err
	}
	existing := existingHashes(vaultDir)
	for h := range archivedHashes() {
		existing[h] = true
	}
	ingested, skipped := 0, 0
	for _, hubDir := range ClaudeHubDirs() {
		for _, nw := range readHubNotes(hubDir) {
			n := nw.Note
			if n.Scope == "" {
				n.Scope = memroots.ScopeForPath(hubDir, "claude", n.Path)
			}
			h := factHash(nw.Body)
			if existing[h] {
				skipped++
				continue
			}
			wrote, werr := foldHubNote(vaultDir, n, nw.Body)
			if werr != nil {
				return ingested, skipped, fmt.Errorf("folding hub note: %w", werr)
			}
			existing[h] = true
			if wrote {
				ingested++
			} else {
				skipped++
			}
		}
	}
	return ingested, skipped, nil
}
```

In `pkg/memvault/recall.go`, repoint recall telemetry at the vault (recalled slugs match vault note names, which the fold preserves):

```go
func RecordRecall(cwd, transcriptPath string, now time.Time) int {
	return recordRecallInto(DefaultVaultPath(), transcriptPath, now)
}
```

(Remove the `HubDirForCwd` gate; `recordRecallInto` already no-ops on a missing transcript.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./pkg/memvault/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add pkg/memvault/harvest.go pkg/memvault/recall.go pkg/memvault/projection.go pkg/memvault/harvest_test.go
git commit -m "feat(memory): fold claude hub notes into the vault (first-run migration)"
```

---

### Task 5: pi-memory harvest

**Files:**
- Modify: `pkg/memvault/harvest.go` (parsePiMemory, writePiNote, HarvestPiMemory)
- Test: `pkg/memvault/harvest_test.go`

**Interfaces:**
- Consumes: `~/.pi/agent/memory/MEMORY.md` (pi-memory package layout), `memvault.writeSourcedNote`
- Produces: `HarvestPiMemory() (ingested, skipped int, err error)` — parses curated entries (split on `<!-- … -->` markers), dedups by factHash, writes `source: pi` notes. Gated on the file existing (no pi-memory installed → 0/0).

- [ ] **Step 1: Write the failing test**

In `pkg/memvault/harvest_test.go` (append):

```go
func TestParsePiMemoryAndHarvest(t *testing.T) {
	md := "<!-- 2026-06-07 10:12:03 [a1b2c3d4] -->\n#preference [[package-manager]] Always use pnpm in this repo, never npm.\n\n<!-- 2026-06-08 09:00:00 [b2c3d4e5] -->\n#decision [[database-choice]] PostgreSQL for all backend services.\n"
	entries := parsePiMemory(md)
	if len(entries) != 2 {
		t.Fatalf("parsePiMemory = %d entries, want 2", len(entries))
	}
	vaultDir := t.TempDir()
	ingested, skipped, err := harvestPiMemoryInto(vaultDir, md)
	if err != nil {
		t.Fatal(err)
	}
	if ingested != 2 || skipped != 0 {
		t.Fatalf("ingested=%d skipped=%d, want 2/0", ingested, skipped)
	}
	// dedup: same file again adds nothing
	ingested2, _, err := harvestPiMemoryInto(vaultDir, md)
	if err != nil || ingested2 != 0 {
		t.Fatalf("second pass ingested=%d err=%v, want 0/nil", ingested2, err)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./pkg/memvault/ -run TestParsePiMemoryAndHarvest`
Expected: FAIL (functions undefined).

- [ ] **Step 3: Implement**

In `pkg/memvault/harvest.go`:

```go
var piEntryRe = regexp.MustCompile(`(?m)^<!--.*?-->$`)

// parsePiMemory splits pi-memory's curated MEMORY.md into entry texts. Entries are separated by
// <!-- ts [id] --> marker comments; markers and surrounding whitespace are dropped.
func parsePiMemory(md string) []string {
	var out []string
	for _, chunk := range piEntryRe.Split(md, -1) {
		if t := strings.TrimSpace(chunk); t != "" {
			out = append(out, t)
		}
	}
	return out
}

// piTypeFromTag maps a pi-memory #tag to a note type; unknown/absent tags -> learning.
var piTagRe = regexp.MustCompile(`^#([a-z][a-z0-9-]*)`)

func piTypeFromTag(entry string) string {
	if m := piTagRe.FindStringSubmatch(entry); m != nil {
		switch m[1] {
		case "preference", "decision", "lesson", "project", "reference", "feedback":
			return m[1]
		}
	}
	return "learning"
}

// piMemoryPath is pi-memory's curated long-term memory file. A var so tests can stub it.
var piMemoryPath = func() string {
	return filepath.Join(wavebase.GetHomeDir(), ".pi", "agent", "memory", "MEMORY.md")
}

// harvestPiMemoryInto is the testable core: parse entries, dedup by body hash against vaultDir,
// write source: pi notes. Scope is left unset (shared) — pi-memory is a home-level store.
func harvestPiMemoryInto(vaultDir, md string) (int, int, error) {
	if err := os.MkdirAll(vaultDir, 0o755); err != nil {
		return 0, 0, err
	}
	existing := existingHashes(vaultDir)
	for h := range archivedHashes() {
		existing[h] = true
	}
	ingested, skipped := 0, 0
	for _, entry := range parsePiMemory(md) {
		h := factHash(entry)
		if existing[h] {
			skipped++
			continue
		}
		slug := harvestSlug(firstLine(entry), h)
		wrote, werr := writeSourcedNote(vaultDir, slug, piTypeFromTag(entry), "", "pi", h, entry)
		if werr != nil {
			return ingested, skipped, fmt.Errorf("writing pi note: %w", werr)
		}
		existing[h] = true
		if wrote {
			ingested++
		} else {
			skipped++
		}
	}
	return ingested, skipped, nil
}

// HarvestPiMemory folds pi-memory's curated entries into the vault. Missing file (package not
// installed) is a no-op, not an error — pi without pi-memory contributes via transcripts instead.
func HarvestPiMemory() (int, int, error) {
	data, err := os.ReadFile(piMemoryPath())
	if err != nil {
		return 0, 0, nil
	}
	return harvestPiMemoryInto(DefaultVaultPath(), string(data))
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./pkg/memvault/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add pkg/memvault/harvest.go pkg/memvault/harvest_test.go
git commit -m "feat(memory): harvest pi-memory entries into the vault"
```

---

### Task 6: Harvest sweep hook + boot fold

**Files:**
- Modify: `pkg/memvault/harvest.go` (HarvestAll), `cmd/server/main-server.go:590-594`
- Test: `pkg/memvault/harvest_test.go`

**Interfaces:**
- Consumes: `memvault.HarvestClaudeHubs`, `memvault.HarvestPiMemory`, `memdistill.RegisterSweepHook`
- Produces: `HarvestAll() (ingested, skipped int, err error)` — claude fold + pi-memory, totals.

- [ ] **Step 1: Write the failing test**

In `pkg/memvault/harvest_test.go` (append):

```go
func TestHarvestAllAggregates(t *testing.T) {
	vaultDir := t.TempDir()
	hub := filepath.Join(t.TempDir(), "C--Users-u-proj")
	os.MkdirAll(filepath.Join(hub, "memory"), 0o755)
	os.WriteFile(filepath.Join(hub, "memory", "a.md"), []byte("---\nname: a\n---\n\nfact a\n"), 0o644)

	origVault, origDirs, origPi := DefaultVaultPath, ClaudeHubDirs, piMemoryPath
	DefaultVaultPath = func() string { return vaultDir }
	ClaudeHubDirs = func() []string { return []string{hub} }
	piMemoryPath = func() string { return filepath.Join(t.TempDir(), "no-such-MEMORY.md") }
	defer func() {
		DefaultVaultPath, ClaudeHubDirs, piMemoryPath = origVault, origDirs, origPi
	}()

	ingested, skipped, err := HarvestAll()
	if err != nil {
		t.Fatal(err)
	}
	if ingested != 1 || skipped != 0 {
		t.Fatalf("ingested=%d skipped=%d, want 1/0", ingested, skipped)
	}
}
```

(Requires `piMemoryPath` to be a var — it already is, from Task 5.)

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./pkg/memvault/ -run TestHarvestAllAggregates`
Expected: FAIL (HarvestAll undefined / piMemoryPath not a var).

- [ ] **Step 3: Implement**

In `pkg/memvault/harvest.go`, make `piMemoryPath` a var and add the aggregate:

```go
// piMemoryPath is pi-memory's curated long-term memory file. A var so tests can stub it.
var piMemoryPath = func() string {
	return filepath.Join(wavebase.GetHomeDir(), ".pi", "agent", "memory", "MEMORY.md")
}

// HarvestAll runs every native-memory harvest into the vault (claude hubs + pi-memory). The codex
// harvest stays cwd-scoped on demand (MemoryHarvestCommand). Registered as the memory sweep hook:
// the first run at boot is the migration fold, then hourly for new organic writes.
func HarvestAll() (int, int, error) {
	cIngested, cSkipped, err := HarvestClaudeHubs()
	if err != nil {
		return cIngested, cSkipped, err
	}
	pIngested, pSkipped, err := HarvestPiMemory()
	if err != nil {
		return cIngested + pIngested, cSkipped + pSkipped, err
	}
	return cIngested + pIngested, cSkipped + pSkipped, nil
}
```

In `cmd/server/main-server.go`, register the harvest hook beside the gardener (line ~592):

```go
	memdistill.RegisterSweepHook(memgarden.Sweep)
	memdistill.RegisterSweepHook(jarvisvolunteer.SweepLooseEnds)
	memdistill.RegisterSweepHook(func() {
		if _, _, err := memvault.HarvestAll(); err != nil {
			log.Printf("memory harvest sweep: %v", err)
		}
	})
	memdistill.Start(context.Background())
```

(`memdistill.Start` runs `runSweepHooks` immediately at startup, so the first hook invocation is the one-time fold.)

- [ ] **Step 4: Run tests + build to verify**

Run: `go test ./pkg/memvault/` then `task build:backend`
Expected: PASS; backend builds.

- [ ] **Step 5: Commit**

```bash
git add pkg/memvault/harvest.go pkg/memvault/harvest_test.go cmd/server/main-server.go
git commit -m "feat(memory): harvest sweep hook runs the fold at boot and hourly"
```

---

### Task 7: Projection repoint — vault source, hub export, opencode target

**Files:**
- Modify: `pkg/memvault/projection.go` (Project sources vault; exportToHub; steeringTargets + opencode), `pkg/memroots/memroots.go` (RegistryPathForLabel)
- Test: `pkg/memvault/projection_test.go` (if it exists — check; else create), `pkg/memroots/memroots_test.go`

**Interfaces:**
- Consumes: `memvault.DefaultVaultPath()`, `memroots.RegistryProjects`, `memvault.HubDirForCwd`
- Produces: `Project(cwd string) error` — renders vault notes whose scope matches the project label (or is shared/empty) into the steering files (codex/pi/gemini/opencode) and exports them into the project hub (skipping `source: claude`); `memroots.RegistryPathForLabel(label string) string` — reverse of LabelFromHash for the gardener (Task 9).

- [ ] **Step 1: Write the failing test (export skips claude-source notes; new opencode target)**

In `pkg/memvault/projection_test.go` (create if absent; check for an existing one first — if it exists, append):

```go
func TestProjectExportSkipsClaudeEcho(t *testing.T) {
	vaultDir := t.TempDir()
	hubDir := t.TempDir()
	orig := DefaultVaultPath
	DefaultVaultPath = func() string { return vaultDir }
	defer func() { DefaultVaultPath = orig }()

	// a human vault note (should export) and a claude-sourced one (echo rule: skip)
	os.WriteFile(filepath.Join(vaultDir, "human-note.md"), []byte("---\nname: human-note\n---\n\nhuman fact\n"), 0o644)
	os.WriteFile(filepath.Join(vaultDir, "claude-note.md"), []byte("---\nname: claude-note\n---\n\nclaude fact\n"), 0o644)

	exported, skipped, err := exportToHub(hubDir, []NoteWithBody{
		{Note: Note{ID: "human-note", Scope: "proj", Source: "vault", Type: "learning"}, Body: "human fact"},
		{Note: Note{ID: "claude-note", Scope: "proj", Source: "claude", Type: "learning"}, Body: "claude fact"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if exported != 1 || skipped != 1 {
		t.Fatalf("exported=%d skipped=%d, want 1/1", exported, skipped)
	}
	entries, _ := os.ReadDir(hubDir)
	if len(entries) != 1 || entries[0].Name() != "human-note.md" {
		t.Fatalf("hub = %v, want only human-note.md", entries)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./pkg/memvault/ -run TestProjectExportSkipsClaudeEcho`
Expected: FAIL (exportToHub undefined).

- [ ] **Step 3: Implement**

In `pkg/memvault/projection.go`:

```go
// steeringTargets include opencode: it reads AGENTS.md from its config dir, so the projection
// reaches opencode sessions the same way it reaches codex/pi/gemini.
func steeringTargets() []steeringTarget {
	home := wavebase.GetHomeDir()
	return []steeringTarget{
		{runtime: "codex", path: filepath.Join(home, ".codex", "AGENTS.md")},
		{runtime: "antigravity", path: filepath.Join(home, ".gemini", "GEMINI.md")},
		{runtime: "pi", path: filepath.Join(home, ".pi", "agent", "AGENTS.md")},
		{runtime: "opencode", path: filepath.Join(home, ".config", "opencode", "AGENTS.md")},
	}
}

// vaultNotesForProject filters the vault's notes to those belonging to label (plus global ones).
func vaultNotesForProject(label string) []NoteWithBody {
	out := []NoteWithBody{}
	for _, nw := range readHubNotes(DefaultVaultPath()) {
		switch nw.Note.Scope {
		case label, "", "shared":
			out = append(out, nw)
		}
	}
	return out
}

// exportToHub writes the vault notes into hubDir as source: vault notes, skipping claude-source
// ones (echo rule: don't send claude its own facts back). Deduped by body hash against the hub.
func exportToHub(hubDir string, notes []NoteWithBody) (int, int, error) {
	if hubDir == "" {
		return 0, 0, nil
	}
	if err := os.MkdirAll(hubDir, 0o755); err != nil {
		return 0, 0, err
	}
	existing := existingHashes(hubDir)
	exported, skipped := 0, 0
	for _, nw := range notes {
		if nw.Note.Source == "claude" {
			skipped++
			continue
		}
		h := factHash(nw.Body)
		if existing[h] {
			skipped++
			continue
		}
		wrote, werr := writeSourcedNote(hubDir, boundedSlug(nw.Note.ID, "note"), nw.Note.Type, nw.Note.Scope, "vault", h, nw.Body)
		if werr != nil {
			return exported, skipped, fmt.Errorf("exporting note: %w", werr)
		}
		existing[h] = true
		if wrote {
			exported++
		} else {
			skipped++
		}
	}
	return exported, skipped, nil
}

// Project renders the vault's memory for cwd's project into the steering files + the project hub.
func Project(cwd string) error {
	if cwd == "" {
		return fmt.Errorf("cwd is required")
	}
	label := projectLabel(cwd, memroots.RegistryProjects())
	notes := vaultNotesForProject(label)
	hubDir := HubDirForCwd(cwd)
	if _, _, err := exportToHub(hubDir, notes); err != nil {
		return fmt.Errorf("exporting to hub: %w", err)
	}
	return projectHubToTargets(label, notes, steeringTargets())
}
```

(`projectHubToTargets` / `renderFacts` are unchanged; the echo rule inside `renderFacts` still skips each runtime's own source.)

In `pkg/memroots/memroots.go`, add the reverse label lookup (the gardener + any scope→repo resolution):

```go
// RegistryPathForLabel resolves a project label back to its registered path. The label is either a
// registry name or a leaf folder; ambiguous leaf matches return the first registered path.
func RegistryPathForLabel(label string) string {
	for name, p := range RegistryProjects() {
		if name == label || filepath.Base(filepath.Clean(p)) == label {
			return p
		}
	}
	return ""
}
```

(If `projection_test.go` does not exist, create it with a minimal package declaration `package memvault`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./pkg/memvault/ ./pkg/memroots/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add pkg/memvault/projection.go pkg/memroots/memroots.go pkg/memvault/projection_test.go pkg/memroots/memroots_test.go
git commit -m "feat(memory): project from the vault, export to claude hubs, add opencode target"
```

---

### Task 8: wavevault — remove the mirror walk

**Files:**
- Modify: `pkg/wavevault/vault.go` (drop mirrors field + wiring), `pkg/wavevault/read.go` (drop mirror loop)
- Delete: `pkg/wavevault/mirror_test.go`
- Test: `pkg/wavevault/read_test.go` (existing read tests still pass)

**Interfaces:**
- Consumes: nothing new
- Produces: `Retriever.load()` walks only the vault's own collections.

- [ ] **Step 1: Write/confirm the test still passes after the change (behavioral guard)**

There is no new test to write — the existing `read_test.go` exercises collection reads. The mirror test (`mirror_test.go`) is deleted because it tests removed behavior.

- [ ] **Step 2: Implement**

In `pkg/wavevault/vault.go`, remove the `mirrors` field and its assignment:

```go
type Vault struct {
	Root         string
	mu           sync.Mutex
	machineFiles map[string]string
}
```

In `OpenVault`, delete `v.mirrors = memroots.Mirrors`. Remove the `memroots` import if it becomes unused.

In `pkg/wavevault/read.go`, delete the mirror branch in `load()`:

```go
	for _, coll := range r.scope.Collections {
		walk(filepath.Join(r.v.Root, coll), coll, "vault")
	}
```

(The `absorb` signature keeps `source` — the vault walk passes "vault". Remove the now-unused `mirrors` doc comment in vault.go.)

Delete `pkg/wavevault/mirror_test.go`.

- [ ] **Step 3: Run tests to verify**

Run: `go test ./pkg/wavevault/`
Expected: PASS (mirror test gone; collection tests green).

- [ ] **Step 4: Commit**

```bash
git add -A pkg/wavevault/
git commit -m "feat(memory): wavevault retriever reads the vault only (no mirrors)"
```

---

### Task 9: Gardener re-plumb to the vault

**Files:**
- Modify: `pkg/memgarden/gardener.go` (per-scope sweep over vault notes), `pkg/memgarden/decay.go` (isMachine covers claude/pi)
- Test: `pkg/memgarden/gardener_test.go`, `pkg/memgarden/decay_test.go`

**Interfaces:**
- Consumes: `memvault.DefaultVaultPath()`, `memvault.VaultNotes()` (new alias), `memroots.RegistryPathForLabel`
- Produces: `Sweep()` groups vault notes by scope and gardens each scope group (repo index + LLM pillars per scope); `isMachine` = agent|codex|claude|pi.

- [ ] **Step 1: Write the failing test (machine classification covers claude/pi)**

In `pkg/memgarden/decay_test.go` (append):

```go
func TestIsMachineSources(t *testing.T) {
	for _, src := range []string{"agent", "codex", "claude", "pi"} {
		if !isMachine(src) {
			t.Errorf("isMachine(%q) = false, want true (harvested source)", src)
		}
	}
	if isMachine("vault") || isMachine("") {
		t.Errorf("isMachine(human source) = true, want false")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./pkg/memgarden/ -run TestIsMachineSources`
Expected: FAIL (claude/pi not machine today).

- [ ] **Step 3: Implement**

In `pkg/memgarden/decay.go`:

```go
// isMachine reports whether a note was machine-authored (harvested or distilled) rather than
// hand-written. Hand-written vault notes carry source "vault" (or none).
func isMachine(source string) bool {
	switch source {
	case "agent", "codex", "claude", "pi":
		return true
	}
	return false
}
```

In `pkg/memvault/projection.go` (or harvest.go), export a vault-notes reader for the gardener:

```go
// VaultNotes reads every note (with body) in the vault memory collection.
func VaultNotes() []NoteWithBody {
	return readHubNotes(DefaultVaultPath())
}
```

In `pkg/memgarden/gardener.go`, re-plumb from per-hub to per-scope, and add the `memroots` import:

```go
import (
	...
	"github.com/wavetermdev/waveterm/pkg/memroots"
)
```

```go
type gardener struct {
	mu       sync.Mutex
	inflight map[string]bool

	now          func() time.Time
	staleDays    int
	maxArchives  int
	cooldownMins int

	lastLLMSweep map[string]time.Time

	vaultNotesFn  func() []memvault.NoteWithBody
	repoPathFn    func(scope string) string
	repoIndexFn   func(repoPath string) map[string]bool
	archiveFn     func(path, reason string, now time.Time) (string, error)
	flagFn        func(path, reason string) error

	gardenFn func(scope string, notes []memvault.NoteWithBody)
	llmFn    func(model, prompt, corpus string) (string, bool)
}
```

`newGardener()` wires `vaultNotesFn: memvault.VaultNotes`, `repoPathFn: memroots.RegistryPathForLabel`, and
`g.gardenFn = g.gardenScope` (replacing `g.gardenFn = g.gardenProject`). Replace `gardenProject(hubDir)` with:

```go
// gardenScope runs the pillars for one project scope's vault notes, honoring the archive cap.
func (g *gardener) gardenScope(scope string, notes []memvault.NoteWithBody) {
	plain := make([]memvault.Note, len(notes))
	for i, n := range notes {
		plain[i] = n.Note
	}
	now := g.now()
	archivedThisPass := 0
	archivedPaths := map[string]bool{}
	repoPath := g.repoPathFn(scope)

	archive := func(path, reason string) {
		if archivedThisPass >= g.maxArchives {
			return
		}
		if _, err := g.archiveFn(path, reason, now); err != nil {
			log.Printf("[memgarden] archive %s (%s): %v\n", path, reason, err)
			return
		}
		archivedThisPass++
		archivedPaths[path] = true
		log.Printf("[memgarden] archived %s reason=%s scope=%s\n", path, reason, scope)
	}

	for _, a := range classifyDecay(plain, now, g.staleDays) {
		if a.Archive {
			archive(a.Path, a.Reason)
		} else if err := g.flagFn(a.Path, a.Reason); err != nil {
			log.Printf("[memgarden] flag %s (%s): %v\n", a.Path, a.Reason, err)
		}
	}

	if repoPath != "" {
		index := g.repoIndexFn(repoPath)
		for _, n := range notes {
			if archivedPaths[n.Note.Path] || !isMachine(n.Note.Source) || n.Note.SupersededBy != "" {
				continue
			}
			if allRefsDead(extractRefs(n.Body), index) {
				archive(n.Note.Path, "drift")
			}
		}
	}

	g.runLLMPillars(scope, notes, repoPath)

	if archivedThisPass > 0 {
		memdistill.PublishActivity(baseds.MemoryActivityData{
			Kind:     baseds.MemoryActivity_Sweep,
			Cwd:      scope,
			Archived: archivedThisPass,
		})
	}
}
```

Update `runLLMPillars(scope string, …)` (the key is the scope, not hubDir) and `sweep()` to group vault notes by scope:

```go
// sweep groups the vault's notes by scope and launches a single-flight garden per scope.
func (g *gardener) sweep() {
	groups := map[string][]memvault.NoteWithBody{}
	for _, n := range g.vaultNotesFn() {
		scope := n.Note.Scope
		if scope == "" {
			scope = "shared"
		}
		groups[scope] = append(groups[scope], n)
	}
	for scope, notes := range groups {
		g.mu.Lock()
		busy := g.inflight[scope]
		if !busy {
			g.inflight[scope] = true
		}
		g.mu.Unlock()
		if busy {
			continue
		}
		go func(s string, ns []memvault.NoteWithBody) {
			defer func() {
				panichandler.PanicHandler("memgarden.gardenScope", recover())
				g.mu.Lock()
				delete(g.inflight, s)
				g.mu.Unlock()
			}()
			g.gardenFn(s, ns)
		}(scope, notes)
	}
}
```

Update `gardener_test.go` — it constructs `gardener` literals with the old field names (`hubDirsFn`, `hubNotesFn`, `repoPathFn` signature); fix the fixtures to the new fields, keeping the existing pillar assertions intact.

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./pkg/memgarden/ ./pkg/memvault/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add pkg/memgarden/ pkg/memvault/projection.go
git commit -m "feat(memory): gardener sweeps vault notes grouped by project scope"
```

---

### Task 10: End-to-end verification

**Files:**
- None (verification only)

- [ ] **Step 1: Full test sweep**

Run (PowerShell): `$env:CGO_CFLAGS="-O2 -g -I$((Get-Location).Path -replace '\\','/')/pkg/jarvisembed/csrc"; go test ./pkg/...`
Expected: PASS (only pre-existing baseline failures, if any are known — report them).

- [ ] **Step 2: Rebuild backend + restart dev app**

Run: `task build:backend`, then restart `task dev`. Confirm `memory:vaultpath` is set to the Obsidian vault (or the intended root) BEFORE this boot so the fold lands there.

- [ ] **Step 3: Live scan probe (fold happened)**

Run the probe (from the repo root, after backend restart):

```bash
cat > /tmp/memscan_verify.go <<'EOF'
package main

import (
	"fmt"
	"os"

	"github.com/wavetermdev/waveterm/pkg/memvault"
)

func main() {
	g, err := memvault.ScanVault(memvault.VaultRoots())
	if err != nil {
		fmt.Println("ERR:", err)
		os.Exit(1)
	}
	fmt.Printf("notes=%d edges=%d\n", len(g.Notes), len(g.Edges))
	src := map[string]int{}
	for _, n := range g.Notes {
		src[n.Source]++
	}
	fmt.Printf("by source: %v\n", src)
}
EOF
CGO_CFLAGS="-O2 -g -I$(pwd -W)/pkg/jarvisembed/csrc" go run /tmp/memscan_verify.go 2>&1 | grep -v "config watcher\|subdirs"
```

Expected: notes ≈ 200 (down from 347); every path under the vault root; no `raw_memories`, `phase2_workspace_diff`, `rollout_summaries`, legacy `---` hubs, or worktree hubs; the "git worktree" cluster at 1–2 notes instead of 13.

- [ ] **Step 4: UI smoke**

Run: `task verify:ui -- surface-smoke` (or the memory-specific scenario if one exists). Open the Memory tab in the dev app: the saved count matches the probe, sections render, no codex artifacts, no double-listed git-worktree notes.

- [ ] **Step 5: Recall + projection spot-check**

- Confirm `~/.codex/AGENTS.md`, `~/.pi/agent/AGENTS.md`, and now `~/.config/opencode/AGENTS.md` carry the ARC-MEMORY region with vault-sourced facts, and codex/pi sources are not echoed back.
- Confirm a Claude session's fresh organic memory note appears in the vault after the next hourly sweep (or after `wsh agent-memory-hook` enqueues + flushes).

- [ ] **Step 6: Record results + finish**

Write the verification results into the spec's Verify section (mark each item ✓/✗ with numbers). Then the feature is complete: fold per-task commits into one feature commit per AGENTS.md convention and run `wsh jarvis complete --commit $(git rev-parse HEAD)`.

---

## Self-review notes

- Spec §1 (one root) → Task 1; §2 (scan vault only) → Task 1 (AllRoots) + Task 8 (retriever); §3 (writes → vault) → Task 2; §4 (projection: hub export + opencode) → Task 7; §5 (claude fold, codex repoint, pi-memory, pi transcripts) → Tasks 3/4/5 (+ Task 2 for RouteLearnings); §6 (migration = first harvest) → Task 6; gardener continuity (prune/archive act on vault notes) → Task 9.
- Types: `DefaultVaultPath`, `ClaudeHubDirs`, `piMemoryPath` are made `var`s so tests can stub them; every later task uses the same names. `writeSourcedNote` (Task 3) is the one writer reused by Tasks 3/5/7. `HarvestClaudeHubs`/`HarvestPiMemory`/`HarvestAll` signatures are stable from Task 4/5/6 onward.
- No placeholders: every code step carries the full implementation.
