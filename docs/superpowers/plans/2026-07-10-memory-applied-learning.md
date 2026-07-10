# Memory → Applied Learning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Claude agents capture durable learnings at session end (corrections auto-committed, everything else queued for review) and mark superseded/stale hub notes for one-click removal — closing the memory loop in both directions.

**Architecture:** A SessionEnd hook runs a headless `claude -p` distillation over the transcript tail and pipes structured candidates to a new `wsh memory-learn` command → `MemoryLearnCommand` RPC. The RPC routes corrections into the project's Claude hub (`HubDirForCwd`) via a new `WriteLearning` writer (dedup'd like the Codex harvest) and everything else into a pending review store outside the scanned vault roots. The same call records `superseded_by` on replaced notes and bumps `last_referenced` on notes the session used. The Memory surface gains a review tray and a cleanup queue; removal is always human-confirmed.

**Tech Stack:** Go (`pkg/memvault`, `pkg/wshrpc`), Cobra (`cmd/wsh`), React 19 + jotai + Tailwind (`frontend/app/view/agents`), Node ESM hook (`~/.claude`), `task generate` codegen.

## Global Constraints

- **Go is the source of truth for wire types.** After editing `pkg/wshrpc/wshrpctypes.go`, run `task generate` to regenerate `frontend/app/store/wshclientapi.ts` and the Go client. **Never hand-edit generated files.**
- **Typecheck command:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (plain `npx tsc` stack-overflows on this repo). Baseline is clean (exit 0).
- **Go tests:** `go test ./pkg/memvault/`. **Frontend tests:** `npx vitest run <file>`.
- **Distillation models:** default `claude-haiku-4-5`; fall back to `claude-sonnet-5` (1M context) when the transcript tail exceeds ~150K tokens. Never Opus.
- **Timestamps:** RFC3339 UTC (`time.Now().UTC().Format(time.RFC3339)`), matching `writeHarvestedNote`.
- **Machine provenance:** agent-written notes carry `metadata.source: agent`, `source_hash`, `captured_at`, `reviewed: false`.
- **No auto-delete.** Every removal is a human action in the UI.
- **Pending store lives at `~/.waveterm/memory-pending/`** — a sibling of the vault root (`~/.waveterm/memory`), never under any scan root, so `ScanVault` never surfaces unreviewed candidates.
- **Staleness threshold:** a note is "stale" when `last_referenced` is older than 30 days (`StaleDays = 30`).

---

## Checkpoint

Tasks 1–8 deliver **capture** (agents write learnings; humans review). This is independently shippable — stop here if desired. Tasks 9–11 add **pruning** (superseded/stale detection + cleanup queue). Task 12 wires the hook. The hook (Task 12) can ship after either slice.

---

### Task 1: Extend the memvault data model

**Files:**
- Modify: `pkg/memvault/memvault.go` (the `Note` struct, the `frontmatter` struct, `parseNote`)
- Test: `pkg/memvault/memvault_test.go`

**Interfaces:**
- Produces: `Note` gains `Reviewed bool` (json `reviewed`), `SupersededBy string` (json `supersededby`), `LastReferenced string` (json `lastreferenced`), `CapturedAt string` (json `capturedat`). `parseNote` populates all four from frontmatter `metadata.{reviewed,superseded_by,last_referenced,captured_at}`.

- [ ] **Step 1: Write the failing test**

Add to `pkg/memvault/memvault_test.go`:

```go
func TestParseNoteAppliedLearningFields(t *testing.T) {
	md := "---\n" +
		"name: fix-the-thing\n" +
		"description: a learning\n" +
		"metadata:\n" +
		"  type: feedback\n" +
		"  source: agent\n" +
		"  reviewed: false\n" +
		"  captured_at: \"2026-07-10T12:00:00Z\"\n" +
		"  superseded_by: old-approach\n" +
		"  last_referenced: \"2026-07-09T08:00:00Z\"\n" +
		"---\n\nbody text\n"
	n, body := parseNote("/tmp/fix-the-thing.md", []byte(md), "claude")
	if n.Source != "agent" {
		t.Fatalf("source = %q, want agent", n.Source)
	}
	if n.Reviewed != false {
		t.Fatalf("reviewed = %v, want false", n.Reviewed)
	}
	if n.CapturedAt != "2026-07-10T12:00:00Z" {
		t.Fatalf("capturedAt = %q", n.CapturedAt)
	}
	if n.SupersededBy != "old-approach" {
		t.Fatalf("supersededBy = %q", n.SupersededBy)
	}
	if n.LastReferenced != "2026-07-09T08:00:00Z" {
		t.Fatalf("lastReferenced = %q", n.LastReferenced)
	}
	if body != "body text\n" {
		t.Fatalf("body = %q", body)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./pkg/memvault/ -run TestParseNoteAppliedLearningFields`
Expected: FAIL — compile error, `n.Reviewed` / `n.SupersededBy` / etc. undefined.

- [ ] **Step 3: Extend the structs and parseNote**

In `pkg/memvault/memvault.go`, add fields to `Note` (after `SourceHash`):

```go
	Reviewed       bool   `json:"reviewed"`       // metadata.reviewed; false = machine-written, awaiting human review
	CapturedAt     string `json:"capturedat"`     // metadata.captured_at (RFC3339) for agent-written notes
	SupersededBy   string `json:"supersededby"`   // metadata.superseded_by: slug of the note that replaced this one
	LastReferenced string `json:"lastreferenced"` // metadata.last_referenced (RFC3339): last session that used this note
```

Extend the `frontmatter.Metadata` anonymous struct:

```go
	Metadata    struct {
		Type           string `yaml:"type"`
		Scope          string `yaml:"scope"`
		Source         string `yaml:"source"`
		SourceHash     string `yaml:"source_hash"`
		Reviewed       bool   `yaml:"reviewed"`
		CapturedAt     string `yaml:"captured_at"`
		SupersededBy   string `yaml:"superseded_by"`
		LastReferenced string `yaml:"last_referenced"`
	} `yaml:"metadata"`
```

In `parseNote`, inside the `if err := yaml.Unmarshal(...); err == nil {` block, after `n.SourceHash = fm.Metadata.SourceHash`, add:

```go
				n.Reviewed = fm.Metadata.Reviewed
				n.CapturedAt = fm.Metadata.CapturedAt
				n.SupersededBy = fm.Metadata.SupersededBy
				n.LastReferenced = fm.Metadata.LastReferenced
```

Note: `Reviewed` defaults to `false` for notes with no `reviewed:` key (human/harvested notes). That is intentional — the review flag only *means* something on `source: agent` notes; the UI gates the "unreviewed" badge on `source === "agent" && !reviewed` (Task 8).

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./pkg/memvault/ -run TestParseNoteAppliedLearningFields`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add pkg/memvault/memvault.go pkg/memvault/memvault_test.go
git commit -m "feat(memvault): parse applied-learning frontmatter fields"
```

---

### Task 2: Frontmatter field upsert helper

**Files:**
- Modify: `pkg/memvault/memvault.go` (add `setMetadataField`)
- Test: `pkg/memvault/memvault_test.go`

**Interfaces:**
- Produces: `func setMetadataField(content, key, value string) string` — returns `content` with `  <key>: <value>` upserted inside the frontmatter `metadata:` block. Value is written verbatim (caller quotes if needed). Adds a `metadata:` block before the closing `---` if none exists. Content with no frontmatter is returned unchanged.

- [ ] **Step 1: Write the failing test**

```go
func TestSetMetadataField(t *testing.T) {
	// upsert into existing metadata block (replace)
	in := "---\nname: n\nmetadata:\n  type: feedback\n  reviewed: false\n---\n\nbody\n"
	out := setMetadataField(in, "reviewed", "true")
	if !strings.Contains(out, "  reviewed: true\n") || strings.Contains(out, "reviewed: false") {
		t.Fatalf("replace failed:\n%s", out)
	}
	if !strings.Contains(out, "\nbody\n") {
		t.Fatalf("body dropped:\n%s", out)
	}
	// append a new key into an existing metadata block
	out = setMetadataField(in, "superseded_by", "old-slug")
	if !strings.Contains(out, "  superseded_by: old-slug\n") {
		t.Fatalf("append failed:\n%s", out)
	}
	if !strings.Contains(out, "  type: feedback\n") {
		t.Fatalf("existing metadata lost:\n%s", out)
	}
	// no metadata block yet -> create one
	in2 := "---\nname: n\ndescription: d\n---\n\nbody\n"
	out = setMetadataField(in2, "last_referenced", "\"2026-07-10T00:00:00Z\"")
	if !strings.Contains(out, "metadata:\n  last_referenced: \"2026-07-10T00:00:00Z\"\n") {
		t.Fatalf("create-block failed:\n%s", out)
	}
	// no frontmatter -> unchanged
	if got := setMetadataField("plain body\n", "x", "y"); got != "plain body\n" {
		t.Fatalf("no-frontmatter changed: %q", got)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./pkg/memvault/ -run TestSetMetadataField`
Expected: FAIL — `setMetadataField` undefined.

- [ ] **Step 3: Implement setMetadataField**

Add to `pkg/memvault/memvault.go`:

```go
// setMetadataField upserts "  <key>: <value>" inside the frontmatter metadata block, preserving the
// body and all other frontmatter. value is written verbatim — the caller quotes it if YAML requires.
// If there is no metadata: block, one is created before the closing ---. Content without frontmatter
// is returned unchanged.
func setMetadataField(content, key, value string) string {
	if !strings.HasPrefix(content, "---\n") {
		return content
	}
	end := strings.Index(content[4:], "\n---")
	if end < 0 {
		return content
	}
	fmText := content[4 : 4+end]
	rest := content[4+end:] // starts at "\n---"
	lines := strings.Split(fmText, "\n")
	newLine := "  " + key + ": " + value
	metaIdx := -1
	for i, l := range lines {
		if l == "metadata:" || strings.HasPrefix(l, "metadata:") {
			metaIdx = i
			break
		}
	}
	if metaIdx < 0 {
		lines = append(lines, "metadata:", newLine)
		return "---\n" + strings.Join(lines, "\n") + rest
	}
	// scan the indented block under metadata: for an existing key
	replaced := false
	lastMeta := metaIdx
	for i := metaIdx + 1; i < len(lines); i++ {
		if !strings.HasPrefix(lines[i], "  ") {
			break
		}
		lastMeta = i
		trimmed := strings.TrimSpace(lines[i])
		if strings.HasPrefix(trimmed, key+":") {
			lines[i] = newLine
			replaced = true
			break
		}
	}
	if !replaced {
		out := make([]string, 0, len(lines)+1)
		out = append(out, lines[:lastMeta+1]...)
		out = append(out, newLine)
		out = append(out, lines[lastMeta+1:]...)
		lines = out
	}
	return "---\n" + strings.Join(lines, "\n") + rest
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./pkg/memvault/ -run TestSetMetadataField`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add pkg/memvault/memvault.go pkg/memvault/memvault_test.go
git commit -m "feat(memvault): frontmatter field upsert helper"
```

---

### Task 3: Agent-learning writer (auto-commit path)

**Files:**
- Create: `pkg/memvault/learn.go`
- Test: `pkg/memvault/learn_test.go`

**Interfaces:**
- Consumes: `factHash`, `existingHashes`, `harvestSlug`, `slugify`, `yamlQuote` (all in `memvault.go`/`harvest.go`), `HubDirForCwd`.
- Produces:
  - `type LearnCandidate struct { Type, Scope, Body string; IsCorrection bool; Supersedes string }`
  - `func WriteLearning(hubDir string, c LearnCandidate) (wrote bool, slug string, err error)` — writes a `source: agent`, `reviewed: false` note into `hubDir`, deduped by `factHash(c.Body)` against `existingHashes(hubDir)`. Returns `wrote=false` (dedup) with the existing/derived slug.

- [ ] **Step 1: Write the failing test**

Create `pkg/memvault/learn_test.go`:

```go
package memvault

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestWriteLearningWritesProvenance(t *testing.T) {
	dir := t.TempDir()
	wrote, slug, err := WriteLearning(dir, LearnCandidate{Type: "feedback", Scope: "myproj", Body: "prefer tabs over spaces"})
	if err != nil || !wrote {
		t.Fatalf("wrote=%v err=%v", wrote, err)
	}
	data, _ := os.ReadFile(filepath.Join(dir, slug+".md"))
	s := string(data)
	for _, want := range []string{"source: agent", "type: feedback", "scope: myproj", "reviewed: false", "source_hash: ", "captured_at: "} {
		if !strings.Contains(s, want) {
			t.Fatalf("missing %q in:\n%s", want, s)
		}
	}
}

func TestWriteLearningDedups(t *testing.T) {
	dir := t.TempDir()
	if _, _, err := WriteLearning(dir, LearnCandidate{Type: "feedback", Body: "same fact"}); err != nil {
		t.Fatal(err)
	}
	wrote, _, err := WriteLearning(dir, LearnCandidate{Type: "feedback", Body: "same   fact"}) // whitespace-normalized dup
	if err != nil {
		t.Fatal(err)
	}
	if wrote {
		t.Fatalf("expected dedup (wrote=false)")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./pkg/memvault/ -run TestWriteLearning`
Expected: FAIL — `WriteLearning` / `LearnCandidate` undefined.

- [ ] **Step 3: Implement learn.go**

Create `pkg/memvault/learn.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Agent-authored learnings: the write side of the applied-learning loop. WriteLearning is the
// auto-commit path (corrections into the Claude hub, deduped like the Codex harvest); MarkSuperseded
// and TouchReferenced feed the pruning signals. See
// docs/superpowers/specs/2026-07-10-memory-applied-learning-design.md.
package memvault

import (
	"os"
	"path/filepath"
	"strings"
	"time"
)

// LearnCandidate is one distilled learning from a session, as routed by MemoryLearnCommand.
type LearnCandidate struct {
	Type         string `json:"type"`         // learning | feedback | project | reference
	Scope        string `json:"scope"`        // optional cluster label
	Body         string `json:"body"`         // the learning text
	IsCorrection bool   `json:"iscorrection"` // true -> auto-commit; false -> review tray
	Supersedes   string `json:"supersedes"`   // optional slug of an existing hub note this replaces
}

// WriteLearning writes c into hubDir as a source: agent, reviewed: false note, deduped by
// factHash(c.Body). Returns wrote=false (with the derived slug) when the fact is already present.
func WriteLearning(hubDir string, c LearnCandidate) (bool, string, error) {
	if err := os.MkdirAll(hubDir, 0o755); err != nil {
		return false, "", err
	}
	hash := factHash(c.Body)
	slug := harvestSlug(c.Body, hash)
	if existingHashes(hubDir)[hash] {
		return false, slug, nil
	}
	path := filepath.Join(hubDir, slug+".md")
	if _, err := os.Stat(path); err == nil {
		return false, slug, nil // slug collision (near-impossible; slug carries the hash)
	}
	noteType := c.Type
	if noteType == "" {
		noteType = "learning"
	}
	var b strings.Builder
	b.WriteString("---\n")
	b.WriteString("name: " + slug + "\n")
	b.WriteString("description: " + yamlQuote(firstLine(c.Body)) + "\n")
	b.WriteString("metadata:\n")
	b.WriteString("  type: " + noteType + "\n")
	if c.Scope != "" {
		b.WriteString("  scope: " + c.Scope + "\n")
	}
	b.WriteString("  source: agent\n")
	b.WriteString("  source_hash: " + hash + "\n")
	b.WriteString("  captured_at: " + yamlQuote(time.Now().UTC().Format(time.RFC3339)) + "\n")
	b.WriteString("  reviewed: false\n")
	b.WriteString("---\n\n")
	b.WriteString(c.Body + "\n")
	if err := os.WriteFile(path, []byte(b.String()), 0o644); err != nil {
		return false, slug, err
	}
	return true, slug, nil
}

// firstLine is the note description: the first non-empty line of the body, trimmed.
func firstLine(body string) string {
	for _, l := range strings.Split(body, "\n") {
		if t := strings.TrimSpace(l); t != "" {
			return t
		}
	}
	return strings.TrimSpace(body)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./pkg/memvault/ -run TestWriteLearning`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add pkg/memvault/learn.go pkg/memvault/learn_test.go
git commit -m "feat(memvault): agent-learning writer with hash dedup"
```

---

### Task 4: Pending review store

**Files:**
- Create: `pkg/memvault/review.go`
- Test: `pkg/memvault/review_test.go`

**Interfaces:**
- Consumes: `slugify`, `yamlQuote`, `CreateNote`, `HubDirForCwd`, `DefaultVaultPath`, `firstLine` (Task 3).
- Produces:
  - `type PendingNote struct { Path, Type, Scope, Body, Cwd string }` (json tags `path/type/scope/body/cwd`)
  - `func PendingDir() string` → `~/.waveterm/memory-pending`
  - `func WritePending(dir string, c LearnCandidate, cwd string) (string, error)` — writes a candidate into `dir`, recording target `cwd` in frontmatter.
  - `func ListPending(dir string) []PendingNote`
  - `func AcceptPending(path string) (string, error)` — reads the pending note, `CreateNote`s it into its recorded hub (or default vault), deletes the pending file, returns the created path.

- [ ] **Step 1: Write the failing test**

Create `pkg/memvault/review_test.go`:

```go
package memvault

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPendingWriteListAccept(t *testing.T) {
	pending := t.TempDir()
	hub := t.TempDir()
	p, err := WritePending(pending, LearnCandidate{Type: "project", Scope: "x", Body: "build uses zig"}, "C:/proj")
	if err != nil {
		t.Fatal(err)
	}
	list := ListPending(pending)
	if len(list) != 1 || list[0].Type != "project" || list[0].Body != "build uses zig" || list[0].Cwd != "C:/proj" {
		t.Fatalf("list = %+v", list)
	}
	// accept: writes into hub, removes pending. Override the hub target via a note whose recorded
	// cwd resolves to an empty hub -> default vault; here we test the file move by pointing accept at
	// a note we rewrite to carry hub as an absolute dir is out of scope, so assert removal + creation.
	_ = p
	created, err := acceptPendingInto(list[0], hub) // test seam (see impl note)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(created); err != nil {
		t.Fatalf("created note missing: %v", err)
	}
	if len(ListPending(pending)) != 0 {
		t.Fatalf("pending not cleared")
	}
	data, _ := os.ReadFile(created)
	if !strings.Contains(string(data), "type: project") {
		t.Fatalf("created note missing type:\n%s", string(data))
	}
	_ = filepath.Dir(created)
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./pkg/memvault/ -run TestPending`
Expected: FAIL — undefined identifiers.

- [ ] **Step 3: Implement review.go**

Create `pkg/memvault/review.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pending review store: agent-distilled candidates that are NOT auto-committed (facts, prefs) land
// here until a human accepts or rejects them. Lives outside all scan roots so ScanVault never
// surfaces unreviewed notes. See docs/superpowers/specs/2026-07-10-memory-applied-learning-design.md.
package memvault

import (
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/wavebase"
)

// PendingNote is one queued candidate awaiting human review.
type PendingNote struct {
	Path  string `json:"path"`
	Type  string `json:"type"`
	Scope string `json:"scope"`
	Body  string `json:"body"`
	Cwd   string `json:"cwd"`
}

// PendingDir is the review-queue directory: a sibling of the vault root, never a scan root.
func PendingDir() string {
	return filepath.Join(wavebase.GetHomeDir(), ".waveterm", "memory-pending")
}

// WritePending writes c into dir as a candidate note, recording the target cwd in frontmatter so
// AcceptPending knows which hub to commit into. Filename carries a timestamp for stable ordering.
func WritePending(dir string, c LearnCandidate, cwd string) (string, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	slug := slugify(firstLine(c.Body))
	if slug == "" {
		slug = "candidate"
	}
	if len(slug) > 48 {
		slug = slug[:48]
	}
	stamp := time.Now().UTC().Format("20060102T150405.000")
	path := filepath.Join(dir, stamp+"-"+slug+".md")
	var b strings.Builder
	b.WriteString("---\n")
	b.WriteString("name: " + slug + "\n")
	b.WriteString("metadata:\n")
	b.WriteString("  type: " + nonEmpty(c.Type, "learning") + "\n")
	if c.Scope != "" {
		b.WriteString("  scope: " + c.Scope + "\n")
	}
	b.WriteString("  source: agent\n")
	b.WriteString("  cwd: " + yamlQuote(cwd) + "\n")
	b.WriteString("---\n\n")
	b.WriteString(c.Body + "\n")
	if err := os.WriteFile(path, []byte(b.String()), 0o644); err != nil {
		return "", err
	}
	return path, nil
}

func nonEmpty(s, fallback string) string {
	if s == "" {
		return fallback
	}
	return s
}

// ListPending reads every candidate in dir. Missing dir -> empty slice. Sorted by filename (the
// timestamp prefix -> chronological).
func ListPending(dir string) []PendingNote {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var out []PendingNote
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".md") {
			continue
		}
		p := filepath.Join(dir, e.Name())
		data, readErr := os.ReadFile(p)
		if readErr != nil {
			continue
		}
		n, body := parseNote(p, data, "pending")
		out = append(out, PendingNote{Path: p, Type: n.Type, Scope: n.Scope, Body: strings.TrimSpace(body), Cwd: pendingCwd(data)})
	}
	return out
}

// pendingCwd extracts the recorded cwd from a pending note's frontmatter (parseNote doesn't carry it).
func pendingCwd(data []byte) string {
	for _, line := range strings.Split(string(data), "\n") {
		t := strings.TrimSpace(line)
		if strings.HasPrefix(t, "cwd:") {
			v := strings.TrimSpace(strings.TrimPrefix(t, "cwd:"))
			v = strings.Trim(v, `"`)
			return v
		}
		if t == "---" && strings.Contains(string(data), "cwd:") == false {
			break
		}
	}
	return ""
}

// AcceptPending commits a queued candidate into its recorded project hub (or the default vault when
// no cwd), then removes the pending file. Returns the created note path.
func AcceptPending(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	n, body := parseNote(path, data, "pending")
	target := DefaultVaultPath()
	if hub := HubDirForCwd(pendingCwd(data)); hub != "" {
		target = hub
	}
	return acceptPendingInto(PendingNote{Path: path, Type: n.Type, Scope: n.Scope, Body: strings.TrimSpace(body)}, target)
}

// acceptPendingInto is the testable core: create the note in targetDir, then remove the pending file.
func acceptPendingInto(pn PendingNote, targetDir string) (string, error) {
	created, err := CreateNote(targetDir, firstLine(pn.Body), pn.Type, pn.Scope, pn.Body)
	if err != nil {
		return "", err
	}
	_ = os.Remove(pn.Path)
	return created, nil
}
```

Implementation note: `pendingCwd`'s second `if` guard is defensive; simplify if desired — the primary path is the `cwd:` prefix match.

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./pkg/memvault/ -run TestPending`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add pkg/memvault/review.go pkg/memvault/review_test.go
git commit -m "feat(memvault): pending review store outside scan roots"
```

---

### Task 5: MemoryLearn + MemoryReview RPC types and handlers

**Files:**
- Modify: `pkg/wshrpc/wshrpctypes.go` (interface methods + data types)
- Modify: `pkg/wshrpc/wshserver/wshserver.go` (handlers, after `MemoryHarvestCommand`)
- Modify: `pkg/wshrpc/wshserver/wshserver.go` MemoryScan/MemoryRead mapping (carry new Note fields to the wire type)
- Modify: `pkg/wshrpc/wshrpctypes.go` `MemoryNote` struct (add wire fields)

**Interfaces:**
- Consumes: `memvault.WriteLearning`, `memvault.WritePending`, `memvault.PendingDir`, `memvault.ListPending`, `memvault.AcceptPending`, `memvault.HubDirForCwd`, `memvault.DefaultVaultPath`.
- Produces (Go interface methods on `WshRpcInterface`):
  - `MemoryLearnCommand(ctx, CommandMemoryLearnData) (*CommandMemoryLearnRtnData, error)`
  - `MemoryReviewListCommand(ctx) (*CommandMemoryReviewListRtnData, error)`
  - `MemoryReviewAcceptCommand(ctx, CommandMemoryReviewAcceptData) error`
  - Reject reuses existing `MemoryDeleteCommand` (pending files are plain paths; `DeleteNote` is `os.Remove`).

- [ ] **Step 1: Write the failing test (server routing)**

Create `pkg/wshrpc/wshserver/memory_learn_test.go`:

```go
package wshserver

import (
	"context"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

func TestMemoryLearnRoutesCorrectionsVsPending(t *testing.T) {
	ws := &WshServer{}
	rtn, err := ws.MemoryLearnCommand(context.Background(), wshrpc.CommandMemoryLearnData{
		Cwd: "", // empty cwd -> default vault / pending dir; asserts routing counts only
		Candidates: []wshrpc.MemoryLearnCandidate{
			{Type: "feedback", Body: "correction one", IsCorrection: true},
			{Type: "project", Body: "fact one", IsCorrection: false},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if rtn.Committed != 1 || rtn.Queued != 1 {
		t.Fatalf("committed=%d queued=%d, want 1/1", rtn.Committed, rtn.Queued)
	}
}
```

Note: this test writes into the real `DefaultVaultPath()`/`PendingDir()` under the test user's home. Acceptable for a smoke of the routing counts; a hermetic version would inject dirs. If the reviewer prefers isolation, refactor the handler to call injectable helpers — out of scope here.

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./pkg/wshrpc/wshserver/ -run TestMemoryLearn`
Expected: FAIL — types/method undefined.

- [ ] **Step 3: Add wire types**

In `pkg/wshrpc/wshrpctypes.go`, add fields to `MemoryNote` (after `UpdatedTs`):

```go
	Reviewed       bool   `json:"reviewed"`
	CapturedAt     string `json:"capturedat"`
	SupersededBy   string `json:"supersededby"`
	LastReferenced string `json:"lastreferenced"`
```

Add after `CommandMemoryHarvestRtnData`:

```go
type MemoryLearnCandidate struct {
	Type         string `json:"type"`
	Scope        string `json:"scope,omitempty"`
	Body         string `json:"body"`
	IsCorrection bool   `json:"iscorrection,omitempty"`
	Supersedes   string `json:"supersedes,omitempty"`
}

type CommandMemoryLearnData struct {
	Cwd        string                 `json:"cwd"`
	Candidates []MemoryLearnCandidate `json:"candidates"`
	References []string               `json:"references,omitempty"` // slugs of existing notes the session used
}

type CommandMemoryLearnRtnData struct {
	Committed int `json:"committed"`
	Queued    int `json:"queued"`
}

type MemoryPendingNote struct {
	Path  string `json:"path"`
	Type  string `json:"type"`
	Scope string `json:"scope"`
	Body  string `json:"body"`
	Cwd   string `json:"cwd"`
}

type CommandMemoryReviewListRtnData struct {
	Pending []MemoryPendingNote `json:"pending"`
}

type CommandMemoryReviewAcceptData struct {
	Path string `json:"path"`
}
```

Add to the `WshRpcInterface` (after the `MemoryHarvestCommand` line, ~line 113):

```go
	MemoryLearnCommand(ctx context.Context, data CommandMemoryLearnData) (*CommandMemoryLearnRtnData, error)
	MemoryReviewListCommand(ctx context.Context) (*CommandMemoryReviewListRtnData, error)
	MemoryReviewAcceptCommand(ctx context.Context, data CommandMemoryReviewAcceptData) error
```

- [ ] **Step 4: Implement handlers**

In `pkg/wshrpc/wshserver/wshserver.go`, after `MemoryHarvestCommand`:

```go
func (ws *WshServer) MemoryLearnCommand(ctx context.Context, data wshrpc.CommandMemoryLearnData) (*wshrpc.CommandMemoryLearnRtnData, error) {
	hub := memvault.HubDirForCwd(data.Cwd)
	rtn := &wshrpc.CommandMemoryLearnRtnData{}
	for _, c := range data.Candidates {
		cand := memvault.LearnCandidate{Type: c.Type, Scope: c.Scope, Body: c.Body, IsCorrection: c.IsCorrection, Supersedes: c.Supersedes}
		if c.IsCorrection && hub != "" {
			wrote, _, err := memvault.WriteLearning(hub, cand)
			if err != nil {
				return nil, fmt.Errorf("writing learning: %w", err)
			}
			if wrote {
				rtn.Committed++
			}
		} else {
			if _, err := memvault.WritePending(memvault.PendingDir(), cand, data.Cwd); err != nil {
				return nil, fmt.Errorf("queuing candidate: %w", err)
			}
			rtn.Queued++
		}
	}
	return rtn, nil
}

func (ws *WshServer) MemoryReviewListCommand(ctx context.Context) (*wshrpc.CommandMemoryReviewListRtnData, error) {
	pns := memvault.ListPending(memvault.PendingDir())
	out := make([]wshrpc.MemoryPendingNote, len(pns))
	for i, p := range pns {
		out[i] = wshrpc.MemoryPendingNote{Path: p.Path, Type: p.Type, Scope: p.Scope, Body: p.Body, Cwd: p.Cwd}
	}
	return &wshrpc.CommandMemoryReviewListRtnData{Pending: out}, nil
}

func (ws *WshServer) MemoryReviewAcceptCommand(ctx context.Context, data wshrpc.CommandMemoryReviewAcceptData) error {
	if _, err := memvault.AcceptPending(data.Path); err != nil {
		return fmt.Errorf("accepting candidate: %w", err)
	}
	return nil
}
```

Also update `MemoryScanCommand` and `MemoryReadCommand` to carry the new fields — in both, extend the `wshrpc.MemoryNote{...}` literal with:

```go
				Reviewed: n.Reviewed, CapturedAt: n.CapturedAt, SupersededBy: n.SupersededBy, LastReferenced: n.LastReferenced,
```

- [ ] **Step 5: Run test + build**

Run: `go test ./pkg/wshrpc/wshserver/ -run TestMemoryLearn && go build ./...`
Expected: PASS, build clean.

- [ ] **Step 6: Commit**

```bash
git add pkg/wshrpc/wshrpctypes.go pkg/wshrpc/wshserver/wshserver.go pkg/wshrpc/wshserver/memory_learn_test.go
git commit -m "feat(wshrpc): MemoryLearn and MemoryReview commands"
```

---

### Task 6: Regenerate bindings

**Files:**
- Regenerate: `frontend/app/store/wshclientapi.ts`, generated Go client (`pkg/wshrpc/wshclient/wshclient.go`)

**Interfaces:**
- Produces: `RpcApi.MemoryLearnCommand`, `RpcApi.MemoryReviewListCommand`, `RpcApi.MemoryReviewAcceptCommand`, and updated `MemoryNote` TS type in `wshclientapi.ts`.

- [ ] **Step 1: Run codegen**

Run: `task generate`
Expected: exits 0; `git status` shows modified `frontend/app/store/wshclientapi.ts` and the generated Go client.

- [ ] **Step 2: Verify the generated client has the new methods**

Run: `grep -c "MemoryLearnCommand\|MemoryReviewListCommand\|MemoryReviewAcceptCommand" frontend/app/store/wshclientapi.ts`
Expected: `3`

- [ ] **Step 3: Build check**

Run: `go build ./... && node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: both exit 0.

- [ ] **Step 4: Commit**

```bash
git add frontend/app/store/wshclientapi.ts pkg/wshrpc/wshclient/wshclient.go
git commit -m "chore(generate): regenerate bindings for memory-learn RPCs"
```

---

### Task 7: Frontend store — review atoms, loaders, and `learning` type

**Files:**
- Modify: `frontend/app/view/agents/memtypes.ts`
- Modify: `frontend/app/view/agents/memstore.ts`
- Test: `frontend/app/view/agents/memtypes.test.ts` (create if absent)

**Interfaces:**
- Consumes: `RpcApi.MemoryReviewListCommand`, `RpcApi.MemoryReviewAcceptCommand`, `RpcApi.MemoryDeleteCommand`.
- Produces:
  - `MemNote` gains `reviewed: boolean; supersededBy: string; lastReferenced: string` — wait: generated TS uses lowercased-no-underscore keys (`reviewed`, `supersededby`, `lastreferenced`, `capturedat`). Mirror those exact keys in `MemNote`.
  - `META.learning` entry.
  - `memPendingAtom`, `loadReview()`, `acceptPending(path)`, `rejectPending(path)` in `memstore.ts`.

- [ ] **Step 1: Write the failing test**

Create/extend `frontend/app/view/agents/memtypes.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { typeMeta } from "./memtypes";

describe("typeMeta", () => {
    it("maps the learning type to its own label", () => {
        expect(typeMeta("learning").label).toBe("Learning");
    });
    it("falls back for unknown types", () => {
        expect(typeMeta("bogus").label).toBe("Note");
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run frontend/app/view/agents/memtypes.test.ts`
Expected: FAIL — `typeMeta("learning").label` is `"Note"` (fallback), not `"Learning"`.

- [ ] **Step 3: Add the learning type and new fields**

In `frontend/app/view/agents/memtypes.ts`, extend `MemNote`:

```ts
export type MemNote = {
    id: string;
    title: string;
    description: string;
    type: string;
    scope: string;
    source: string; // vault|claude|codex|agent
    path: string;
    links: string[];
    updatedts: number;
    reviewed: boolean;
    capturedat: string;
    supersededby: string;
    lastreferenced: string;
};
```

Add to `META` (a new token `mem-learning` must exist in `tailwindsetup.css`; if absent, reuse an existing token — use `text-mem-feedback`/`bg-mem-feedback` to avoid adding a color):

```ts
    learning: { label: "Learning", dotClass: "bg-mem-feedback", pillClass: "text-mem-feedback" },
```

- [ ] **Step 4: Add review store to memstore.ts**

Append to `frontend/app/view/agents/memstore.ts`:

```ts
import type { MemoryPendingNote } from "@/app/store/wshclientapi"; // generated type

export const memPendingAtom = atom<MemoryPendingNote[]>([]) as PrimitiveAtom<MemoryPendingNote[]>;

export async function loadReview(): Promise<void> {
    try {
        const r = await RpcApi.MemoryReviewListCommand(TabRpcClient, { timeout: MEM_RPC_TIMEOUT_MS });
        globalStore.set(memPendingAtom, r.pending ?? []);
    } catch {
        globalStore.set(memPendingAtom, []);
    }
}

export async function acceptPending(path: string): Promise<void> {
    await RpcApi.MemoryReviewAcceptCommand(TabRpcClient, { path });
    globalStore.set(memReflowAnimatedAtom, true);
    await Promise.all([loadReview(), loadMemory()]);
}

export async function rejectPending(path: string): Promise<void> {
    await RpcApi.MemoryDeleteCommand(TabRpcClient, { path });
    await loadReview();
}
```

If the generated `MemoryPendingNote` import path differs, use the exact export name from `wshclientapi.ts` (check with `grep "MemoryPendingNote" frontend/app/store/wshclientapi.ts`).

- [ ] **Step 5: Run test + typecheck**

Run: `npx vitest run frontend/app/view/agents/memtypes.test.ts && node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: PASS, tsc exit 0.

- [ ] **Step 6: Commit**

```bash
git add frontend/app/view/agents/memtypes.ts frontend/app/view/agents/memstore.ts frontend/app/view/agents/memtypes.test.ts
git commit -m "feat(memory): learning type and review store"
```

---

### Task 8: Review tray UI + machine-authored badge

**Files:**
- Create: `frontend/app/view/agents/reviewtray.tsx`
- Modify: `frontend/app/view/agents/memorysurface.tsx` (mount the tray; trigger `loadReview` on mount)
- Modify: `frontend/app/view/agents/memgraph.tsx` (add `learning` to the legend)

**Interfaces:**
- Consumes: `memPendingAtom`, `loadReview`, `acceptPending`, `rejectPending` (Task 7).

- [ ] **Step 1: Read the surface mount point**

Run: `grep -n "useEffect\|loadMemory\|return (\|<Ctrl\|MemGraph\|MemList" frontend/app/view/agents/memorysurface.tsx | head -30`
Expected: identifies the mount `useEffect` (where `loadMemory()` is called) and the top-level JSX container. Record the exact lines.

- [ ] **Step 2: Create the review tray component**

Create `frontend/app/view/agents/reviewtray.tsx`:

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Review tray: agent-distilled candidates awaiting a human decision. Corrections auto-commit and
// never appear here; facts/prefs queue until approved. Collapsible; hidden entirely when empty.

import { useAtomValue } from "jotai";
import { useState } from "react";
import { Check, ChevronDown, ChevronRight, X } from "lucide-react";
import { acceptPending, memPendingAtom, rejectPending } from "./memstore";
import { typeMeta } from "./memtypes";

export function ReviewTray() {
    const pending = useAtomValue(memPendingAtom);
    const [open, setOpen] = useState(true);
    if (pending.length === 0) return null;
    return (
        <div className="border-b border-edge-faint px-[12px] py-[8px]">
            <button
                className="flex items-center gap-[6px] text-[11px] font-mono uppercase tracking-wide text-ink-mid"
                onClick={() => setOpen((v) => !v)}
            >
                {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                {pending.length} pending review
            </button>
            {open && (
                <ul className="mt-[6px] flex flex-col gap-[4px]">
                    {pending.map((p) => (
                        <li key={p.path} className="flex items-start gap-[8px] rounded-[6px] bg-surface/60 px-[8px] py-[6px]">
                            <span className={`mt-[3px] h-[7px] w-[7px] shrink-0 rounded-full ${typeMeta(p.type).dotClass}`} />
                            <span className="min-w-0 flex-1 truncate text-[12px] text-ink-high">{p.body}</span>
                            <button title="Accept" className="text-ink-mid hover:text-ink-high" onClick={() => void acceptPending(p.path)}>
                                <Check size={14} />
                            </button>
                            <button title="Reject" className="text-ink-mid hover:text-ink-high" onClick={() => void rejectPending(p.path)}>
                                <X size={14} />
                            </button>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}
```

- [ ] **Step 3: Mount the tray and load review data**

In `frontend/app/view/agents/memorysurface.tsx`:
1. Add import: `import { ReviewTray } from "./reviewtray";` and `import { loadReview } from "./memstore";`
2. In the existing mount `useEffect` (where `loadMemory()` runs), add `void loadReview();` alongside it.
3. Render `<ReviewTray />` just inside the top-level container, above the graph/list view switch (use the exact JSX location found in Step 1).

- [ ] **Step 4: Add `learning` to the graph legend**

In `frontend/app/view/agents/memgraph.tsx:522`, change the legend type list from:

```tsx
                {(["project", "reference", "feedback", "user"] as const).map((t) => (
```

to:

```tsx
                {(["project", "reference", "feedback", "learning", "user"] as const).map((t) => (
```

Verify `colors.fill(t)` handles `"learning"` — locate the `colors.fill` definition (`grep -n "fill" frontend/app/view/agents/memgraph.tsx`) and add a `learning` case mirroring `feedback`'s color if it switches on type; if it falls back gracefully, no change needed.

- [ ] **Step 5: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 6: Visual verification (dev app over CDP)**

Run the dev app (`tail -f /dev/null | task dev`), inject a pending candidate by calling the RPC once (or drop a test `.md` into `~/.waveterm/memory-pending/`), open the Memory surface, confirm the tray renders and Accept/Reject work. Capture with `node scripts/cdp-shot.mjs review-tray.png`.
Expected: tray shows the pending item; Accept moves it into the graph, Reject removes it.

- [ ] **Step 7: Commit**

```bash
git add frontend/app/view/agents/reviewtray.tsx frontend/app/view/agents/memorysurface.tsx frontend/app/view/agents/memgraph.tsx
git commit -m "feat(memory): review tray and learning legend entry"
```

---

> **CHECKPOINT — capture is shippable here.** Tasks 9–11 add pruning; Task 12 wires the SessionEnd hook (needed for either slice to run end-to-end).

---

### Task 9: Supersession + last_referenced mutators

**Files:**
- Modify: `pkg/memvault/learn.go` (add `MarkSuperseded`, `TouchReferenced`)
- Test: `pkg/memvault/learn_test.go`

**Interfaces:**
- Consumes: `setMetadataField` (Task 2).
- Produces:
  - `func MarkSuperseded(hubDir, noteSlug, bySlug string) error` — sets `superseded_by: <bySlug>` on `<noteSlug>.md` in `hubDir`.
  - `func TouchReferenced(hubDir string, slugs []string, ts string) error` — sets `last_referenced: "<ts>"` on each named note.

- [ ] **Step 1: Write the failing test**

Add to `pkg/memvault/learn_test.go`:

```go
func TestMarkSupersededAndTouch(t *testing.T) {
	dir := t.TempDir()
	old := filepath.Join(dir, "old.md")
	os.WriteFile(old, []byte("---\nname: old\nmetadata:\n  type: project\n---\n\nold body\n"), 0o644)
	if err := MarkSuperseded(dir, "old", "new-slug"); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(old)
	if !strings.Contains(string(data), "superseded_by: new-slug") {
		t.Fatalf("no superseded_by:\n%s", string(data))
	}
	if err := TouchReferenced(dir, []string{"old"}, "2026-07-10T00:00:00Z"); err != nil {
		t.Fatal(err)
	}
	data, _ = os.ReadFile(old)
	if !strings.Contains(string(data), `last_referenced: "2026-07-10T00:00:00Z"`) {
		t.Fatalf("no last_referenced:\n%s", string(data))
	}
	if !strings.Contains(string(data), "old body") {
		t.Fatalf("body dropped:\n%s", string(data))
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./pkg/memvault/ -run TestMarkSuperseded`
Expected: FAIL — undefined.

- [ ] **Step 3: Implement the mutators**

Add to `pkg/memvault/learn.go`:

```go
// MarkSuperseded flags hubDir/<noteSlug>.md as replaced by bySlug (pruning's strong signal).
func MarkSuperseded(hubDir, noteSlug, bySlug string) error {
	return editNoteMetadata(filepath.Join(hubDir, noteSlug+".md"), "superseded_by", bySlug)
}

// TouchReferenced records ts as last_referenced on each named note (pruning's weak signal).
func TouchReferenced(hubDir string, slugs []string, ts string) error {
	for _, s := range slugs {
		if err := editNoteMetadata(filepath.Join(hubDir, s+".md"), "last_referenced", yamlQuote(ts)); err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	return nil
}

func editNoteMetadata(path, key, value string) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	out := setMetadataField(string(data), key, value)
	return os.WriteFile(path, []byte(out), 0o644)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./pkg/memvault/ -run TestMarkSuperseded`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add pkg/memvault/learn.go pkg/memvault/learn_test.go
git commit -m "feat(memvault): superseded_by and last_referenced mutators"
```

---

### Task 10: Prune-candidate scan + wire into MemoryLearn

**Files:**
- Create: `pkg/memvault/prune.go`
- Test: `pkg/memvault/prune_test.go`
- Modify: `pkg/wshrpc/wshrpctypes.go` (`MemoryPruneListCommand` + types)
- Modify: `pkg/wshrpc/wshserver/wshserver.go` (handler; extend `MemoryLearnCommand` to apply supersession + references)

**Interfaces:**
- Consumes: `ScanVault` semantics / `readHubNotes` (projection.go), `Note` fields.
- Produces:
  - `const StaleDays = 30`
  - `type PruneCandidate struct { ID, Title, Reason, Path string }` (Reason: `"superseded"` or `"stale"`).
  - `func PruneCandidates(now time.Time) []PruneCandidate` — scans all vault roots; a note is a candidate if `SupersededBy != ""` (reason `superseded`, higher priority) or `LastReferenced` older than `StaleDays` (reason `stale`). Superseded sorted first.
  - RPC `MemoryPruneListCommand(ctx) (*CommandMemoryPruneListRtnData, error)`.
  - `MemoryLearnCommand` now also calls `MarkSuperseded` (per candidate `Supersedes`) and `TouchReferenced` (per `References`).

- [ ] **Step 1: Write the failing test**

Create `pkg/memvault/prune_test.go`:

```go
package memvault

import (
	"testing"
	"time"
)

func TestClassifyPrune(t *testing.T) {
	now := time.Date(2026, 7, 10, 0, 0, 0, 0, time.UTC)
	fresh := now.Add(-24 * time.Hour).Format(time.RFC3339)
	old := now.Add(-40 * 24 * time.Hour).Format(time.RFC3339)
	notes := []Note{
		{ID: "a", Title: "A", SupersededBy: "b", LastReferenced: fresh},
		{ID: "c", Title: "C", LastReferenced: old},
		{ID: "d", Title: "D", LastReferenced: fresh},
	}
	got := classifyPrune(notes, now)
	if len(got) != 2 {
		t.Fatalf("want 2 candidates, got %d: %+v", len(got), got)
	}
	if got[0].Reason != "superseded" || got[0].ID != "a" {
		t.Fatalf("superseded should sort first: %+v", got[0])
	}
	if got[1].Reason != "stale" || got[1].ID != "c" {
		t.Fatalf("stale second: %+v", got[1])
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./pkg/memvault/ -run TestClassifyPrune`
Expected: FAIL — undefined.

- [ ] **Step 3: Implement prune.go**

Create `pkg/memvault/prune.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pruning: surface outdated hub notes for human-confirmed removal. Two signals — superseded (strong,
// set by the distiller when a new learning replaces an old one) and stale (weak, no last_referenced
// activity in StaleDays). See docs/superpowers/specs/2026-07-10-memory-applied-learning-design.md.
package memvault

import (
	"sort"
	"time"
)

const StaleDays = 30

// PruneCandidate is one note the cleanup queue suggests removing (never auto-removed).
type PruneCandidate struct {
	ID     string `json:"id"`
	Title  string `json:"title"`
	Reason string `json:"reason"` // "superseded" | "stale"
	Path   string `json:"path"`
}

// classifyPrune is the pure core: superseded first, then stale (last_referenced older than StaleDays).
// A note with no last_referenced is NOT stale (never-referenced human notes are left alone).
func classifyPrune(notes []Note, now time.Time) []PruneCandidate {
	var out []PruneCandidate
	cutoff := now.AddDate(0, 0, -StaleDays)
	for _, n := range notes {
		switch {
		case n.SupersededBy != "":
			out = append(out, PruneCandidate{ID: n.ID, Title: n.Title, Reason: "superseded", Path: n.Path})
		case n.LastReferenced != "":
			if ts, err := time.Parse(time.RFC3339, n.LastReferenced); err == nil && ts.Before(cutoff) {
				out = append(out, PruneCandidate{ID: n.ID, Title: n.Title, Reason: "stale", Path: n.Path})
			}
		}
	}
	sort.SliceStable(out, func(i, j int) bool {
		return out[i].Reason == "superseded" && out[j].Reason != "superseded"
	})
	return out
}

// PruneCandidates scans all vault roots and classifies them against now.
func PruneCandidates(now time.Time) []PruneCandidate {
	g, err := ScanVault(VaultRoots())
	if err != nil {
		return nil
	}
	return classifyPrune(g.Notes, now)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./pkg/memvault/ -run TestClassifyPrune`
Expected: PASS

- [ ] **Step 5: Add the RPC type + method + handler**

In `pkg/wshrpc/wshrpctypes.go`, add:

```go
type MemoryPruneCandidate struct {
	ID     string `json:"id"`
	Title  string `json:"title"`
	Reason string `json:"reason"`
	Path   string `json:"path"`
}

type CommandMemoryPruneListRtnData struct {
	Candidates []MemoryPruneCandidate `json:"candidates"`
}
```

Add to `WshRpcInterface`:

```go
	MemoryPruneListCommand(ctx context.Context) (*CommandMemoryPruneListRtnData, error)
```

In `wshserver.go`, add the handler:

```go
func (ws *WshServer) MemoryPruneListCommand(ctx context.Context) (*wshrpc.CommandMemoryPruneListRtnData, error) {
	cands := memvault.PruneCandidates(time.Now().UTC())
	out := make([]wshrpc.MemoryPruneCandidate, len(cands))
	for i, c := range cands {
		out[i] = wshrpc.MemoryPruneCandidate{ID: c.ID, Title: c.Title, Reason: c.Reason, Path: c.Path}
	}
	return &wshrpc.CommandMemoryPruneListRtnData{Candidates: out}, nil
}
```

Extend `MemoryLearnCommand` (before `return rtn, nil`) to apply the pruning + reference signals:

```go
	if hub != "" {
		for _, c := range data.Candidates {
			if c.Supersedes != "" {
				_, slug, _ := memvault.WriteLearning(hub, memvault.LearnCandidate{Type: c.Type, Scope: c.Scope, Body: c.Body}) // slug of the new note
				_ = memvault.MarkSuperseded(hub, c.Supersedes, slug)
			}
		}
		if len(data.References) > 0 {
			_ = memvault.TouchReferenced(hub, data.References, time.Now().UTC().Format(time.RFC3339))
		}
	}
```

Note: `WriteLearning` here is idempotent by hash — if the correction was already committed in the loop above, the second call returns the existing slug (`wrote=false`) so `MarkSuperseded` still links to the right note. Confirm `time` is imported in `wshserver.go` (it is — used by `GetWindowTokensCommand`).

- [ ] **Step 6: Regenerate + build + test**

Run: `task generate && go build ./... && go test ./pkg/memvault/ ./pkg/wshrpc/wshserver/`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add pkg/memvault/prune.go pkg/memvault/prune_test.go pkg/wshrpc/wshrpctypes.go pkg/wshrpc/wshserver/wshserver.go frontend/app/store/wshclientapi.ts pkg/wshrpc/wshclient/wshclient.go
git commit -m "feat(memory): prune-candidate scan and MemoryLearn supersession wiring"
```

---

### Task 11: Cleanup queue UI

**Files:**
- Create: `frontend/app/view/agents/cleanupqueue.tsx`
- Modify: `frontend/app/view/agents/memstore.ts` (prune atom + loader)
- Modify: `frontend/app/view/agents/memorysurface.tsx` (mount + load)

**Interfaces:**
- Consumes: `RpcApi.MemoryPruneListCommand`, `RpcApi.MemoryDeleteCommand`, `deleteNote` (existing).

- [ ] **Step 1: Add prune store**

Append to `frontend/app/view/agents/memstore.ts`:

```ts
import type { MemoryPruneCandidate } from "@/app/store/wshclientapi";

export const memPruneAtom = atom<MemoryPruneCandidate[]>([]) as PrimitiveAtom<MemoryPruneCandidate[]>;

export async function loadPrune(): Promise<void> {
    try {
        const r = await RpcApi.MemoryPruneListCommand(TabRpcClient, { timeout: MEM_RPC_TIMEOUT_MS });
        globalStore.set(memPruneAtom, r.candidates ?? []);
    } catch {
        globalStore.set(memPruneAtom, []);
    }
}

// Confirmed removal (human action). Reuses deleteNote (rescans the graph) then refreshes the queue.
export async function prune(path: string): Promise<void> {
    await deleteNote(path);
    await loadPrune();
}
```

- [ ] **Step 2: Create the cleanup queue component**

Create `frontend/app/view/agents/cleanupqueue.tsx`:

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Cleanup queue: outdated notes the distiller flagged — superseded (strong) sorted before stale
// (weak). Removal is one click but always a human action; hidden when empty.

import { useAtomValue } from "jotai";
import { useState } from "react";
import { ChevronDown, ChevronRight, Trash2 } from "lucide-react";
import { memPruneAtom, prune } from "./memstore";

export function CleanupQueue() {
    const candidates = useAtomValue(memPruneAtom);
    const [open, setOpen] = useState(false);
    if (candidates.length === 0) return null;
    return (
        <div className="border-b border-edge-faint px-[12px] py-[8px]">
            <button
                className="flex items-center gap-[6px] text-[11px] font-mono uppercase tracking-wide text-ink-mid"
                onClick={() => setOpen((v) => !v)}
            >
                {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                {candidates.length} to clean up
            </button>
            {open && (
                <ul className="mt-[6px] flex flex-col gap-[4px]">
                    {candidates.map((c) => (
                        <li key={c.path} className="flex items-center gap-[8px] rounded-[6px] bg-surface/60 px-[8px] py-[6px]">
                            <span className="min-w-0 flex-1 truncate text-[12px] text-ink-high">{c.title}</span>
                            <span className="shrink-0 text-[10px] font-mono uppercase text-ink-mid">{c.reason}</span>
                            <button title="Remove" className="text-ink-mid hover:text-danger" onClick={() => void prune(c.path)}>
                                <Trash2 size={14} />
                            </button>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}
```

If `text-danger` is not a defined token, use `hover:text-ink-high` (check with `grep -r "text-danger" frontend/app/`).

- [ ] **Step 3: Mount and load**

In `frontend/app/view/agents/memorysurface.tsx`:
1. Import `{ CleanupQueue }` and `{ loadPrune }`.
2. In the mount `useEffect`, add `void loadPrune();`.
3. Render `<CleanupQueue />` directly below `<ReviewTray />`.

- [ ] **Step 4: Typecheck + visual verify**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.
Then in the dev app: drop a test note with `metadata.superseded_by: x` into a hub dir, open Memory, confirm the cleanup queue lists it, Remove deletes it. `node scripts/cdp-shot.mjs cleanup-queue.png`.

- [ ] **Step 5: Commit**

```bash
git add frontend/app/view/agents/cleanupqueue.tsx frontend/app/view/agents/memstore.ts frontend/app/view/agents/memorysurface.tsx
git commit -m "feat(memory): cleanup queue for superseded and stale notes"
```

---

### Task 12: `wsh memory-learn` command + SessionEnd distillation hook

**Files:**
- Create: `cmd/wsh/cmd/wshcmd-memory-learn.go`
- Create: `docs/agents/memory-learn-hook.js` (reference copy; the live file is deployed to `~/.claude/scripts/`)
- Modify: `docs/agents/` — add a short setup note (or extend an existing agents doc) describing the `~/.claude/settings.json` `SessionEnd` registration.

**Interfaces:**
- Consumes: `wshclient.MemoryLearnCommand` (generated), the `preRunSetupRpcClient` PreRunE and `RpcClient` from the `cmd` package (as `wshcmd-ask.go` uses).
- Produces: `wsh memory-learn` reading a JSON `{cwd, candidates, references}` payload on stdin.

- [ ] **Step 1: Create the wsh subcommand**

Create `cmd/wsh/cmd/wshcmd-memory-learn.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"encoding/json"
	"fmt"
	"io"
	"os"

	"github.com/spf13/cobra"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshrpc/wshclient"
)

var memoryLearnCmd = &cobra.Command{
	Use:                   "memory-learn",
	Short:                 "route distilled session learnings into memory (corrections auto-commit; else queue for review)",
	Args:                  cobra.NoArgs,
	RunE:                  memoryLearnRun,
	PreRunE:               preRunSetupRpcClient,
	Hidden:                true,
	DisableFlagsInUseLine: true,
}

func init() {
	rootCmd.AddCommand(memoryLearnCmd)
}

func memoryLearnRun(cmd *cobra.Command, args []string) error {
	raw, err := io.ReadAll(os.Stdin)
	if err != nil {
		return fmt.Errorf("reading stdin: %w", err)
	}
	var data wshrpc.CommandMemoryLearnData
	if err := json.Unmarshal(raw, &data); err != nil {
		return fmt.Errorf("parsing learn payload: %w", err)
	}
	if len(data.Candidates) == 0 && len(data.References) == 0 {
		return nil // nothing to do
	}
	rtn, err := wshclient.MemoryLearnCommand(RpcClient, data, &wshrpc.RpcOpts{Timeout: 10000})
	if err != nil {
		return err
	}
	fmt.Printf("committed %d, queued %d\n", rtn.Committed, rtn.Queued)
	return nil
}
```

- [ ] **Step 2: Build and smoke the command**

Run: `task build:backend`
Then: `echo '{"cwd":"","candidates":[{"type":"project","body":"smoke test fact"}]}' | ./dist/bin/wsh memory-learn` (requires a running dev app for the RPC client to connect; if not running, expect a connection error — that's fine for the build check).
Expected: builds clean; with a running app, prints `committed 0, queued 1`.

- [ ] **Step 3: Commit the command**

```bash
git add cmd/wsh/cmd/wshcmd-memory-learn.go
git commit -m "feat(wsh): memory-learn command routes distilled learnings"
```

- [ ] **Step 4: Create the SessionEnd hook script**

Create `docs/agents/memory-learn-hook.js` (deploy a copy to `~/.claude/scripts/memory-learn.mjs`):

```js
// Copyright 2026, WaveTerm Inc.
// Licensed under the Apache License, Version 2.0.
//
// SessionEnd hook: distills durable learnings from the finished session's transcript tail via a
// headless `claude -p` pass, then routes them to memory through `wsh memory-learn`. Fail-safe:
// any problem -> exit 0 (a failed distillation must never break the agent). Registered in
// ~/.claude/settings.json under hooks.SessionEnd alongside the status/obsidian reporters.

const fs = require("fs");
const path = require("path");
const childProcess = require("child_process");

const HAIKU = "claude-haiku-4-5";
const SONNET = "claude-sonnet-5"; // 1M-context fallback for oversized tails
const TAIL_CHARS = 400_000; // ~150K tokens; above this, use SONNET
const DISTILL_PROMPT = [
    "You are distilling durable learnings from a finished coding session transcript.",
    "Output ONLY a JSON object: {\"candidates\":[{\"type\",\"scope\",\"body\",\"iscorrection\",\"supersedes\"}],\"references\":[]}.",
    "type is one of: feedback | learning | project | reference.",
    "Set iscorrection=true ONLY for an explicit correction the user gave (\"no, do it this way\").",
    "supersedes: the slug of an existing memory this learning replaces, or omit.",
    "references: slugs of existing memories the session clearly relied on.",
    "Extract only durable, reusable learnings. If none, return {\"candidates\":[],\"references\":[]}.",
].join(" ");

function readTail(transcriptPath) {
    const raw = fs.readFileSync(transcriptPath, "utf8");
    return raw.length > TAIL_CHARS ? raw.slice(-TAIL_CHARS) : raw;
}

function firstCwd(transcript) {
    for (const line of transcript.split("\n")) {
        try {
            const o = JSON.parse(line);
            if (o && typeof o.cwd === "string" && o.cwd) return o.cwd;
        } catch (_) {
            /* skip non-JSON lines */
        }
    }
    return process.env.CLAUDE_CWD || "";
}

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
    try {
        const transcriptPath = process.env.CLAUDE_TRANSCRIPT_PATH;
        if (!transcriptPath || !fs.existsSync(transcriptPath)) process.exit(0);
        if (!process.env.WAVETERM_WSHBINDIR) process.exit(0);

        const tail = readTail(transcriptPath);
        if (!tail.trim()) process.exit(0);
        const model = tail.length >= TAIL_CHARS ? SONNET : HAIKU;
        const cwd = firstCwd(tail);

        // headless distillation. -p prints the model's final text; we ask for JSON.
        const distilled = childProcess.spawnSync(
            "claude",
            ["-p", "--model", model, DISTILL_PROMPT],
            { input: tail, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 120000 }
        );
        if (distilled.status !== 0 || !distilled.stdout) process.exit(0);

        // tolerate prose around the JSON: grab the first {...} block.
        const m = distilled.stdout.match(/\{[\s\S]*\}/);
        if (!m) process.exit(0);
        const parsed = JSON.parse(m[0]);
        const payload = JSON.stringify({
            cwd,
            candidates: parsed.candidates || [],
            references: parsed.references || [],
        });

        const wsh = path.join(
            process.env.WAVETERM_WSHBINDIR,
            process.platform === "win32" ? "wsh.exe" : "wsh"
        );
        childProcess.spawnSync(wsh, ["memory-learn"], {
            input: payload,
            encoding: "utf8",
            maxBuffer: 10 * 1024 * 1024,
            timeout: 15000,
        });
    } catch (_) {
        /* fail-safe: never break the agent */
    }
    process.exit(0);
});
```

- [ ] **Step 5: Document the settings.json registration**

Create `docs/agents/memory-learn-setup.md` with the registration snippet (mirrors the Obsidian logger doc):

```markdown
# Memory-learn SessionEnd hook — setup

Deploy `docs/agents/memory-learn-hook.js` to `~/.claude/scripts/memory-learn.mjs`, then add a
`SessionEnd` entry to `~/.claude/settings.json` alongside the existing reporters (do not replace them):

    {
      "type": "command",
      "command": "\"C:\\Program Files\\nodejs\\node.exe\" \"C:\\Users\\<you>\\.claude\\scripts\\memory-learn.mjs\""
    }

Requires the `claude` CLI on PATH (for `claude -p`) and a running Wave app (for `wsh memory-learn`
to reach wavesrv). The hook is fail-safe: any error exits 0 and the agent is unaffected.
```

- [ ] **Step 6: End-to-end verification**

With the dev app running and the hook deployed: run a short Claude Code session in a registered project, give one explicit correction, end it. Confirm: the correction appears in the project hub (`~/.claude/projects/<hash>/memory/`) with `source: agent`, `reviewed: false`; any non-correction facts appear in the review tray. Screenshot the Memory surface.
Expected: correction auto-committed and visible in the graph with the machine badge; facts queued in the tray.

- [ ] **Step 7: Commit**

```bash
git add docs/agents/memory-learn-hook.js docs/agents/memory-learn-setup.md
git commit -m "feat(agents): SessionEnd distillation hook for memory capture"
```

---

## Self-Review

**Spec coverage:**
- §1 Capture (hook + distillation, Haiku/Sonnet, structured output) → Task 12 (hook), Task 5 (routing). ✓
- §2 Trust model (corrections auto-commit + flag + dedup; else review tray) → Task 3 (WriteLearning dedup), Task 4 (pending), Task 5 (routing), Task 8 (tray UI). ✓
- §3 Read-into-behavior (Claude native; MEMORY.md index) → native path is inherent (writing to hub); **MEMORY.md hub index is NOT implemented** — see gap below.
- §4 Data model (`learning` type; provenance frontmatter) → Task 1, Task 3, Task 7. ✓
- §5 Pruning (superseded_by strong; last_referenced weak; human-confirmed) → Task 9, Task 10, Task 11. ✓
- §6 UI (review tray, cleanup queue, machine badge) → Task 8, Task 11. Machine badge on graph node: legend done (Task 8); **per-node badge styling in `memgraph.tsx` node paint is not broken out** — the legend covers the type, and `source: agent` + `reviewed: false` is available on `MemNote` for a node-paint tweak. Left as a follow-up polish, not a blocker.
- §7 RPC surface → Task 5, Task 10. ✓

**Gap — §3 MEMORY.md hub index:** the spec lists generating a hub-side `MEMORY.md` index as a "new" nice-to-have, explicitly for a *future* explicit-injection path that §Non-goals rules out for now. It is not needed for the loop to close (Claude reads the hub dir natively). Deferred deliberately; if the reviewer wants it, add a `WriteMemoryIndex(hubDir)` call at the end of `MemoryLearnCommand` — one small function mirroring `renderFacts`.

**Placeholder scan:** no TBD/TODO; every code step has complete code; test steps show real assertions. ✓

**Type consistency:** `LearnCandidate` (Go) ↔ `MemoryLearnCandidate` (wire) fields align (type/scope/body/iscorrection/supersedes). `MemNote` TS keys use generated lowercase-no-underscore form (`reviewed`, `capturedat`, `supersededby`, `lastreferenced`) matching the Go json tags in Task 1/Task 5. `PruneCandidate` (Go) ↔ `MemoryPruneCandidate` (wire) ↔ `memPruneAtom` element align. ✓
