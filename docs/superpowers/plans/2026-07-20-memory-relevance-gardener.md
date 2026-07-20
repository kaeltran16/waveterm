# Memory Relevance Gardener Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the Claude memory hub relevant automatically by adding a reversible "gardener" loop (decay / freshness / dedup) on top of real recall telemetry, so stale entries don't accumulate faster than a human can drain the cleanup queue.

**Architecture:** Two seams on existing infra. (1) On SessionEnd, the server parses the finished transcript for real recall events and writes ground-truth `last_referenced`. (2) A gardener sweep, riding the memdistill coordinator's single hourly ticker, moves provably-unused machine notes and dead-reference notes into a recoverable archive (per-pass capped), and flags judgment-call items into the existing cleanup queue. New Go package `pkg/memgarden` holds the loop; `pkg/memvault` gains the archive primitive and recall parser; the Memory tab gains an Archived view with one-click Restore.

**Tech Stack:** Go (wavesrv backend, `pkg/memvault` + `pkg/memdistill` + new `pkg/memgarden`), wshrpc typed RPC + codegen (`task generate`), React 19 + jotai + Tailwind 4 frontend (`frontend/app/view/agents`), `claude -p` headless LLM calls (haiku/sonnet, mirrored from the distiller).

## Global Constraints

_Every task's requirements implicitly include this section._

- **No hard delete, ever.** Every removal is an *archive* (a file **move** into `~/.waveterm/memory-archive/`), never `DeleteNote`. Undo = `Restore`.
- **Human-authored notes are never auto-decayed.** Auto-archive applies only to machine notes (`source: agent` or `source: codex`). Human notes (any other source) are flag-only for decay — mirrors the existing `prune.go:25` restraint.
- **Claude hub only** for v1 decay. Recall telemetry exists only for `~/.claude` transcripts. No Codex/Gemini decay.
- **No embeddings.** Dedup uses content hashes (write-time, already built) + a cheap LLM cluster pass (flag-only).
- **One background timer.** Reuse the `memdistill` coordinator's hourly ticker via a registered sweep hook (`memdistill.RegisterSweepHook`). Do **not** add a second `time.Ticker`. *(Reconciles the spec's "no parallel timer" non-goal with "started next to `memdistill.Start(...)`": the gardener registers its sweep next to `memdistill.Start` in `main-server.go`, and it fires on the coordinator's existing ticker.)*
- **Per-pass cap on auto-archives:** `maxArchivesPerPass = 20` per project per sweep. A large refactor spreads recheck across sweeps.
- **Fail-safe throughout.** Recall parsing and the sweep are off the agent hot path and must never break a turn or crash the server. LLM/parse failures retain state and retry next sweep. Wrap sweep goroutines in `panichandler.PanicHandler` (mirror `coordinator.go`).
- **Model convention:** `claude-haiku-4-5` default, `claude-sonnet-5` escalation on large corpus — reuse `memdistill`'s `haikuModel`/`sonnetModel` constants values (redeclare in `memgarden`; do not import unexported distiller consts).
- **`N` (stale window)** defaults to `memvault.StaleDays` (30), overridable via config key `memory:gardenerstaledays`.
- **Never hand-edit generated files.** `pkg/wshrpc/wshclient/wshclient.go`, `frontend/app/store/wshclientapi.ts`, and `frontend/types/gotypes.d.ts` are generated. Edit Go definitions, then run `task generate`.
- **Typecheck command (tsc overflows on this repo):** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`. Baseline is exit 0.
- **Go tests:** `go test ./pkg/memvault/ ./pkg/memgarden/ ./pkg/memdistill/`. Frontend tests: `npx vitest run <file>`.
- **Git (STRICT, from CLAUDE.md):** NEVER commit without explicit approval. Do **not** commit per-task. Each task ends by running its tests and `git add`-ing its files. A single commit at the very end (Task 17), pending approval, includes the code **plus** the spec (`docs/superpowers/specs/2026-07-20-memory-relevance-gardener-design.md`) and this plan — spec/plan docs fold into the feature commit, never a separate docs commit.

## File Structure

**New — `pkg/memvault` (archive primitive + recall telemetry):**
- `recall.go` — `ParseRecalledSlugs(transcript string) []string` (pure); `RecordRecall` / `recordRecallInto` (read transcript, TouchReferenced).
- `recall_test.go`
- `archive.go` — `ArchiveDir()`, `Archive`, `Restore`, `ListArchived`, `ArchivedNote`, `archivedHashes`, `removeMetadataField`.
- `archive_test.go`

**Modified — `pkg/memvault`:**
- `memvault.go` — add `GardenerFlag` to `Note` + `frontmatter`; add `FlagNote`; export `HubNotes`.
- `prune.go` — `classifyPrune` surfaces `gardener_flag` reasons.
- `learn.go` — `WriteLearning` dedup unions the archive.
- `harvest.go` — `harvestInto` dedup unions the archive.
- `projection.go` — `ClaudeHubDirs()`, `RepoPathForHubDir()`, `HubNotes()`.

**New — `pkg/memgarden` (the loop):**
- `decay.go` / `decay_test.go` — `classifyDecay` (pure).
- `freshness.go` / `freshness_test.go` — dead-ref (deterministic) + soft-drift (LLM).
- `dedup.go` / `dedup_test.go` — near-dup cluster (LLM).
- `gardener.go` / `gardener_test.go` — `gardener` struct, `Sweep`, `gardenProject`, single-flight, per-pass cap, mtime-gate, `Register`.

**Modified — wiring & RPC:**
- `pkg/memdistill/coordinator.go` — `RegisterSweepHook`; run hooks on startup + each tick.
- `cmd/server/main-server.go` — `memgarden.Register()` before `memdistill.Start`.
- `pkg/wshrpc/wshserver/wshserver_memory.go` — recall in `MemoryEnqueueSessionCommand`; `MemoryArchiveListCommand`; `MemoryRestoreCommand`.
- `pkg/wshrpc/wshrpctypes_memory.go` — 2 interface methods + data types.
- `pkg/wshrpc/wshrpctypes.go` — `MemoryArchivedNote` wire type.
- `pkg/wconfig/settingsconfig.go` + `pkg/wconfig/metaconsts.go` — `memory:gardenerstaledays`.

**Modified — frontend (`frontend/app/view/agents`):**
- `memstore.ts` — `memArchivedAtom`, `loadArchived`, `restoreArchived`, `sortArchived` (pure).
- `memstore.test.ts` (new or extend) — `sortArchived`.
- `archivedview.tsx` (new) — archived list + Restore.
- `memorysurface.tsx` — render `ArchivedView`; load archived on mount.

---

## Task 1: Recall telemetry parser (pure)

Real recall events appear in Claude transcripts (`.jsonl`) as a `<system-reminder>This memory is N days old…</system-reminder>` block immediately followed by the recalled note's line-numbered file content, whose frontmatter carries `name: <slug>`. In the raw `.jsonl` file the embedded newlines/tabs are literal `\n`/`\t` escape sequences on one physical line per record. This parser extracts the set of recalled slugs — ground truth, superseding the distiller's post-hoc `references` guess.

**Files:**
- Create: `pkg/memvault/recall.go`
- Test: `pkg/memvault/recall_test.go`

**Interfaces:**
- Produces: `func ParseRecalledSlugs(transcript string) []string` — deduped, in first-seen order.

- [ ] **Step 1: Write the failing test**

Use the real format captured from `~/.claude/projects/.../*.jsonl` (line-numbered content, literal `\n`/`\t`). Slugs may contain `_` or `-`.

```go
package memvault

import (
	"reflect"
	"testing"
)

func TestParseRecalledSlugs(t *testing.T) {
	// Two recall blocks in one JSONL record (literal \n and \t, as on disk), plus one in another record.
	transcript := `{"type":"user","message":{"content":[{"type":"tool_result","content":"<system-reminder>This memory is 3 days old. Memories are point-in-time observations, not live state.</system-reminder>\n1\t---\n2\tname: tsc-stack-size-gotcha\n3\tdescription: \"x\"\n---\n"},{"type":"tool_result","content":"<system-reminder>This memory is 1 day old.</system-reminder>\n1\t---\n2\tname: cdp_verify_dev_app\n---\n"}]}}` + "\n" +
		`{"type":"user","message":{"content":[{"type":"tool_result","content":"<system-reminder>This memory is 12 days old.</system-reminder>\n1\t---\n2\tname: tsc-stack-size-gotcha\n---\n"}]}}`
	got := ParseRecalledSlugs(transcript)
	want := []string{"tsc-stack-size-gotcha", "cdp_verify_dev_app"} // deduped, first-seen order
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v want %v", got, want)
	}
}

func TestParseRecalledSlugs_None(t *testing.T) {
	if got := ParseRecalledSlugs(`{"type":"assistant","message":{"content":"no memories here"}}`); len(got) != 0 {
		t.Fatalf("want none, got %v", got)
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `go test ./pkg/memvault/ -run TestParseRecalledSlugs -v`
Expected: FAIL — `undefined: ParseRecalledSlugs`.

- [ ] **Step 3: Write the implementation**

Create `pkg/memvault/recall.go`. The regex matches a recall reminder, then the first `name:` after it. `.` in Go RE2 excludes real newlines (`\n` bytes), so `.*?` stays within one JSONL record (embedded newlines are literal `\`+`n`, which `.` matches).

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Real recall telemetry: parse a finished Claude transcript for the memories it actually recalled.
// Recalled notes appear as `<system-reminder>This memory is N days old…</system-reminder>` blocks
// followed by the note's line-numbered file content (name: <slug> in frontmatter). This is ground
// truth for last_referenced, superseding the distiller's post-hoc `references` guess.
// See docs/superpowers/specs/2026-07-20-memory-relevance-gardener-design.md.
package memvault

import "regexp"

// recallRe pairs each recall reminder with the first `name:` slug that follows it. Non-greedy `.*?`
// keeps each match inside one JSONL record (`.` excludes real newlines; embedded ones are literal \n).
var recallRe = regexp.MustCompile(`This memory is \d+ days? old.*?name:\s*([A-Za-z0-9_-]+)`)

// ParseRecalledSlugs returns the deduped, first-seen-ordered set of note slugs recalled in transcript.
func ParseRecalledSlugs(transcript string) []string {
	var out []string
	seen := map[string]bool{}
	for _, m := range recallRe.FindAllStringSubmatch(transcript, -1) {
		slug := m[1]
		if slug != "" && !seen[slug] {
			seen[slug] = true
			out = append(out, slug)
		}
	}
	return out
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `go test ./pkg/memvault/ -run TestParseRecalledSlugs -v`
Expected: PASS (both tests).

- [ ] **Step 5: Stage**

Run: `git add pkg/memvault/recall.go pkg/memvault/recall_test.go`

---

## Task 2: Record recall on SessionEnd

Wire the parser into the SessionEnd path. The server already receives `Cwd` + `TranscriptPath` via `MemoryEnqueueSessionCommand`. wavesrv runs on the same machine as the transcript, so it reads the file directly and writes real `last_referenced` — no wsh hook change needed. `recordRecallInto` is the testable core (takes a hub dir), mirroring `harvestInto`.

**Files:**
- Modify: `pkg/memvault/recall.go`
- Modify: `pkg/memvault/recall_test.go`
- Modify: `pkg/wshrpc/wshserver/wshserver_memory.go:110-113` (`MemoryEnqueueSessionCommand`)

**Interfaces:**
- Consumes: `ParseRecalledSlugs` (Task 1); `TouchReferenced(hubDir string, slugs []string, ts string) error` (`learn.go:73`); `HubDirForCwd(cwd string) string` (`projection.go:187`).
- Produces: `func RecordRecall(cwd, transcriptPath string, now time.Time) int`; `func recordRecallInto(hubDir, transcriptPath string, now time.Time) int` — both return the count of slugs touched.

- [ ] **Step 1: Write the failing test**

Add to `pkg/memvault/recall_test.go`:

```go
import (
	"os"
	"path/filepath"
	"strings"
	"time"
)

func TestRecordRecallInto(t *testing.T) {
	hub := t.TempDir()
	// a hub note whose slug is recalled
	notePath := filepath.Join(hub, "tsc-stack-size-gotcha.md")
	if err := os.WriteFile(notePath, []byte("---\nname: tsc-stack-size-gotcha\nmetadata:\n  type: reference\n---\n\nbody\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	transcript := filepath.Join(t.TempDir(), "t.jsonl")
	if err := os.WriteFile(transcript, []byte(`{"c":"<system-reminder>This memory is 3 days old.</system-reminder>\n1\t---\n2\tname: tsc-stack-size-gotcha\n---\n"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 7, 20, 0, 0, 0, 0, time.UTC)
	if n := recordRecallInto(hub, transcript, now); n != 1 {
		t.Fatalf("want 1 touched, got %d", n)
	}
	data, _ := os.ReadFile(notePath)
	if !strings.Contains(string(data), "last_referenced: \"2026-07-20T00:00:00Z\"") {
		t.Fatalf("last_referenced not written:\n%s", data)
	}
}

func TestRecordRecallInto_MissingTranscript(t *testing.T) {
	if n := recordRecallInto(t.TempDir(), filepath.Join(t.TempDir(), "nope.jsonl"), time.Now()); n != 0 {
		t.Fatalf("missing transcript should touch nothing, got %d", n)
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `go test ./pkg/memvault/ -run TestRecordRecallInto -v`
Expected: FAIL — `undefined: recordRecallInto`.

- [ ] **Step 3: Write the implementation**

Append to `pkg/memvault/recall.go` (add `os`, `time` to imports):

```go
// RecordRecall reads a finished transcript, extracts recalled slugs, and stamps real last_referenced
// on each in cwd's Claude hub. Fail-safe: missing files / empty cwd touch nothing. Returns the count.
func RecordRecall(cwd, transcriptPath string, now time.Time) int {
	hub := HubDirForCwd(cwd)
	if hub == "" {
		return 0
	}
	return recordRecallInto(hub, transcriptPath, now)
}

// recordRecallInto is the testable core: parse transcriptPath and TouchReferenced each slug in hubDir.
func recordRecallInto(hubDir, transcriptPath string, now time.Time) int {
	data, err := os.ReadFile(transcriptPath)
	if err != nil {
		return 0
	}
	slugs := ParseRecalledSlugs(string(data))
	if len(slugs) == 0 {
		return 0
	}
	_ = TouchReferenced(hubDir, slugs, now.UTC().Format(time.RFC3339))
	return len(slugs)
}
```

- [ ] **Step 4: Run the memvault test to verify it passes**

Run: `go test ./pkg/memvault/ -run TestRecordRecall -v`
Expected: PASS.

- [ ] **Step 5: Wire into the SessionEnd RPC**

In `pkg/wshrpc/wshserver/wshserver_memory.go`, replace the body of `MemoryEnqueueSessionCommand` (currently just `memdistill.Enqueue(...)`). Add `"time"` to imports if missing (it is already imported).

```go
func (ws *WshServer) MemoryEnqueueSessionCommand(ctx context.Context, data wshrpc.CommandMemoryEnqueueSessionData) error {
	// real recall telemetry: stamp last_referenced from what the finished session actually recalled.
	memvault.RecordRecall(data.Cwd, data.TranscriptPath, time.Now())
	memdistill.Enqueue(data.Cwd, data.TranscriptPath, data.ClaudePath)
	return nil
}
```

- [ ] **Step 6: Verify the server package builds**

Run: `go build ./pkg/wshrpc/wshserver/`
Expected: exit 0.

- [ ] **Step 7: Stage**

Run: `git add pkg/memvault/recall.go pkg/memvault/recall_test.go pkg/wshrpc/wshserver/wshserver_memory.go`

---

## Task 3: The archive primitive

Archiving = **move** a hub note into `~/.waveterm/memory-archive/` (sibling of the vault + pending dirs, never a scan root), stamped `archived_at`, `archived_reason`, `archived_from` (origin hub, for Restore), keeping `source_hash`. Leaving the hub means Claude stops recalling it and `ScanVault` stops surfacing it. `Restore` moves it back.

**Files:**
- Create: `pkg/memvault/archive.go`
- Test: `pkg/memvault/archive_test.go`

**Interfaces:**
- Consumes: `parseNote` (`memvault.go:73`), `setMetadataField` (`memvault.go:332`), `firstLine` (`learn.go:92`), `wavebase.GetHomeDir()`.
- Produces:
  - `type ArchivedNote struct { ID, Title, Reason, ArchivedAt, Path, OriginHub string }`
  - `func ArchiveDir() string`
  - `func Archive(notePath, reason string, now time.Time) (string, error)` — returns the archive path.
  - `func Restore(archivePath string) (string, error)` — returns the restored hub path.
  - `func ListArchived() []ArchivedNote` — sorted by `ArchivedAt` desc.
  - `func archivedHashes() map[string]bool` (used by Task 4).
  - `func removeMetadataField(content, key string) string`

- [ ] **Step 1: Write the failing test**

```go
package memvault

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func writeHubNote(t *testing.T, hub, slug, source, hash string) string {
	t.Helper()
	p := filepath.Join(hub, slug+".md")
	body := "---\nname: " + slug + "\ndescription: \"d\"\nmetadata:\n  type: reference\n  source: " + source + "\n  source_hash: " + hash + "\n---\n\n# " + slug + "\n\nbody\n"
	if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestArchiveRestoreRoundTrip(t *testing.T) {
	t.Setenv("HOME", t.TempDir())          // unix
	t.Setenv("USERPROFILE", os.Getenv("HOME")) // windows
	hub := t.TempDir()
	notePath := writeHubNote(t, hub, "dead-note", "agent", "abc123")
	now := time.Date(2026, 7, 20, 0, 0, 0, 0, time.UTC)

	arcPath, err := Archive(notePath, "decay", now)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(notePath); !os.IsNotExist(err) {
		t.Fatalf("note should have left the hub")
	}
	data, _ := os.ReadFile(arcPath)
	s := string(data)
	if !strings.Contains(s, "archived_reason: decay") || !strings.Contains(s, "archived_from:") || !strings.Contains(s, "source_hash: abc123") {
		t.Fatalf("archive frontmatter missing fields:\n%s", s)
	}
	if got := archivedHashes(); !got["abc123"] {
		t.Fatalf("archived hash not indexed: %v", got)
	}
	list := ListArchived()
	if len(list) != 1 || list[0].ID != "dead-note" || list[0].Reason != "decay" {
		t.Fatalf("ListArchived wrong: %+v", list)
	}

	restored, err := Restore(arcPath)
	if err != nil {
		t.Fatal(err)
	}
	if restored != filepath.Join(hub, "dead-note.md") {
		t.Fatalf("restored to wrong path: %s", restored)
	}
	if _, err := os.Stat(arcPath); !os.IsNotExist(err) {
		t.Fatalf("archive file should be gone after restore")
	}
	rdata, _ := os.ReadFile(restored)
	if strings.Contains(string(rdata), "archived_") {
		t.Fatalf("restored note should have archive fields stripped:\n%s", rdata)
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `go test ./pkg/memvault/ -run TestArchiveRestoreRoundTrip -v`
Expected: FAIL — `undefined: Archive`.

- [ ] **Step 3: Write the implementation**

Create `pkg/memvault/archive.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The archive primitive: the gardener's reversible removal. Archiving MOVES a hub note into
// ~/.waveterm/memory-archive/ (a sibling of the vault + pending dirs, never a scan root), stamped
// archived_at/archived_reason/archived_from and keeping source_hash so the distiller won't re-learn
// it. Restore moves it back to its origin hub. No hard delete.
// See docs/superpowers/specs/2026-07-20-memory-relevance-gardener-design.md.
package memvault

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"gopkg.in/yaml.v3"
)

// ArchiveDir is the recoverable removal store: a sibling of the vault + pending dirs, never scanned.
func ArchiveDir() string {
	return filepath.Join(wavebase.GetHomeDir(), ".waveterm", "memory-archive")
}

type ArchivedNote struct {
	ID         string `json:"id"`
	Title      string `json:"title"`
	Reason     string `json:"reason"`     // decay | drift
	ArchivedAt string `json:"archivedat"` // RFC3339
	Path       string `json:"path"`       // path inside the archive dir
	OriginHub  string `json:"originhub"`  // hub dir to restore into
}

type archivedFrontmatter struct {
	Metadata struct {
		ArchivedAt     string `yaml:"archived_at"`
		ArchivedReason string `yaml:"archived_reason"`
		ArchivedFrom   string `yaml:"archived_from"`
	} `yaml:"metadata"`
}

// Archive moves notePath into ArchiveDir, stamping archive metadata. reason is decay | drift.
func Archive(notePath, reason string, now time.Time) (string, error) {
	data, err := os.ReadFile(notePath)
	if err != nil {
		return "", err
	}
	n, _ := parseNote(notePath, data, "claude")
	hubDir := filepath.Dir(notePath)
	content := string(data)
	content = setMetadataField(content, "archived_at", yamlQuote(now.UTC().Format(time.RFC3339)))
	content = setMetadataField(content, "archived_reason", reason)
	content = setMetadataField(content, "archived_from", yamlQuote(hubDir))

	if err := os.MkdirAll(ArchiveDir(), 0o755); err != nil {
		return "", err
	}
	stamp := now.UTC().Format("20060102T150405.000")
	arcPath := filepath.Join(ArchiveDir(), stamp+"-"+n.ID+".md")
	if err := os.WriteFile(arcPath, []byte(content), 0o644); err != nil {
		return "", err
	}
	if err := os.Remove(notePath); err != nil {
		_ = os.Remove(arcPath) // don't leave a duplicate if the move half-failed
		return "", fmt.Errorf("removing archived source: %w", err)
	}
	return arcPath, nil
}

// Restore moves an archived note back to its origin hub (from archived_from), stripping archive fields.
func Restore(archivePath string) (string, error) {
	data, err := os.ReadFile(archivePath)
	if err != nil {
		return "", err
	}
	n, _ := parseNote(archivePath, data, "claude")
	var af archivedFrontmatter
	_ = yaml.Unmarshal(frontmatterBytes(data), &af)
	hub := af.Metadata.ArchivedFrom
	if hub == "" {
		return "", fmt.Errorf("archived note has no archived_from: %s", archivePath)
	}
	content := string(data)
	for _, k := range []string{"archived_at", "archived_reason", "archived_from"} {
		content = removeMetadataField(content, k)
	}
	if err := os.MkdirAll(hub, 0o755); err != nil {
		return "", err
	}
	dest := filepath.Join(hub, n.ID+".md")
	if err := os.WriteFile(dest, []byte(content), 0o644); err != nil {
		return "", err
	}
	if err := os.Remove(archivePath); err != nil {
		return "", fmt.Errorf("removing archive file after restore: %w", err)
	}
	return dest, nil
}

// ListArchived reads every note in ArchiveDir, newest archived_at first. Missing dir -> empty.
func ListArchived() []ArchivedNote {
	entries, err := os.ReadDir(ArchiveDir())
	if err != nil {
		return nil
	}
	var out []ArchivedNote
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".md") {
			continue
		}
		p := filepath.Join(ArchiveDir(), e.Name())
		data, readErr := os.ReadFile(p)
		if readErr != nil {
			continue
		}
		n, _ := parseNote(p, data, "claude")
		var af archivedFrontmatter
		_ = yaml.Unmarshal(frontmatterBytes(data), &af)
		out = append(out, ArchivedNote{
			ID: n.ID, Title: n.Title, Reason: af.Metadata.ArchivedReason,
			ArchivedAt: af.Metadata.ArchivedAt, Path: p, OriginHub: af.Metadata.ArchivedFrom,
		})
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].ArchivedAt > out[j].ArchivedAt })
	return out
}

// archivedHashes returns the set of source_hashes already archived, so the distiller's dedup won't
// re-learn what the gardener removed (the load-bearing link — see harvest.go / learn.go).
func archivedHashes() map[string]bool {
	out := map[string]bool{}
	entries, err := os.ReadDir(ArchiveDir())
	if err != nil {
		return out
	}
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".md") {
			continue
		}
		data, readErr := os.ReadFile(filepath.Join(ArchiveDir(), e.Name()))
		if readErr != nil {
			continue
		}
		if n, _ := parseNote("", data, "claude"); n.SourceHash != "" {
			out[n.SourceHash] = true
		}
	}
	return out
}

// frontmatterBytes returns the YAML frontmatter block (between the leading --- fences), or nil.
func frontmatterBytes(data []byte) []byte {
	s := string(data)
	if !strings.HasPrefix(s, "---\n") {
		return nil
	}
	if end := strings.Index(s[4:], "\n---"); end >= 0 {
		return []byte(s[4 : 4+end])
	}
	return nil
}

// removeMetadataField deletes a "  <key>: ..." line from the frontmatter metadata block. Inverse of
// setMetadataField. Content without frontmatter, or without the key, is returned unchanged.
func removeMetadataField(content, key string) string {
	if !strings.HasPrefix(content, "---\n") {
		return content
	}
	end := strings.Index(content[4:], "\n---")
	if end < 0 {
		return content
	}
	fmText := content[4 : 4+end]
	rest := content[4+end:]
	lines := strings.Split(fmText, "\n")
	out := make([]string, 0, len(lines))
	for _, l := range lines {
		if strings.HasPrefix(l, "  ") && strings.HasPrefix(strings.TrimSpace(l), key+":") {
			continue
		}
		out = append(out, l)
	}
	return "---\n" + strings.Join(out, "\n") + rest
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `go test ./pkg/memvault/ -run TestArchiveRestoreRoundTrip -v`
Expected: PASS.

- [ ] **Step 5: Stage**

Run: `git add pkg/memvault/archive.go pkg/memvault/archive_test.go`

---

## Task 4: Archive-aware dedup (the load-bearing link)

Without this, the distiller re-learns what the gardener archived, and they fight forever. Union `archivedHashes()` into the write-time dedup set used by `WriteLearning` and `harvestInto`.

**Files:**
- Modify: `pkg/memvault/learn.go:35` (`WriteLearning`)
- Modify: `pkg/memvault/harvest.go:177` (`harvestInto`)
- Test: `pkg/memvault/archive_test.go` (extend)

**Interfaces:**
- Consumes: `archivedHashes()` (Task 3), `existingHashes(hubDir)` (`harvest.go:114`).

- [ ] **Step 1: Write the failing test**

Add to `pkg/memvault/archive_test.go`:

```go
func TestWriteLearningSkipsArchivedHash(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	hub := t.TempDir()

	c := LearnCandidate{Type: "learning", Body: "avoid the tsc stack overflow gotcha", IsCorrection: true}
	wrote, slug, err := WriteLearning(hub, c)
	if err != nil || !wrote {
		t.Fatalf("first write should succeed: wrote=%v err=%v", wrote, err)
	}
	// archive it, then try to re-learn the identical fact — must be suppressed.
	if _, err := Archive(filepath.Join(hub, slug+".md"), "decay", time.Date(2026, 7, 20, 0, 0, 0, 0, time.UTC)); err != nil {
		t.Fatal(err)
	}
	wrote2, _, err := WriteLearning(hub, c)
	if err != nil {
		t.Fatal(err)
	}
	if wrote2 {
		t.Fatalf("re-learning an archived fact must be suppressed")
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `go test ./pkg/memvault/ -run TestWriteLearningSkipsArchivedHash -v`
Expected: FAIL — the re-learn is written (`wrote2 == true`).

- [ ] **Step 3: Update `WriteLearning`**

In `pkg/memvault/learn.go`, change the dedup check (currently `if existingHashes(hubDir)[hash] {`):

```go
	hash := factHash(c.Body)
	slug := harvestSlug(c.Body, hash)
	if existingHashes(hubDir)[hash] || archivedHashes()[hash] {
		return false, slug, nil
	}
```

- [ ] **Step 4: Update `harvestInto`**

In `pkg/memvault/harvest.go`, after `existing := existingHashes(hubDir)`:

```go
	existing := existingHashes(hubDir)
	for h := range archivedHashes() { // don't re-harvest what the gardener archived
		existing[h] = true
	}
```

- [ ] **Step 5: Run the memvault suite to verify it passes**

Run: `go test ./pkg/memvault/ -v`
Expected: PASS (new test + all existing harvest/learn tests unaffected).

- [ ] **Step 6: Stage**

Run: `git add pkg/memvault/learn.go pkg/memvault/harvest.go pkg/memvault/archive_test.go`

---

## Task 5: Gardener flag + cleanup-queue surfacing

Judgment-call findings (soft-drift, near-dup) and never-referenced human notes are *flagged*, not archived, via a `metadata.gardener_flag` frontmatter field. `classifyPrune` surfaces flagged notes into the existing cleanup queue alongside `superseded`/`stale`.

**Files:**
- Modify: `pkg/memvault/memvault.go` (`Note`, `frontmatter`, `parseNote`; add `FlagNote`)
- Modify: `pkg/memvault/prune.go` (`classifyPrune`)
- Modify: `pkg/memvault/prune_test.go`

**Interfaces:**
- Produces: `Note.GardenerFlag string`; `func FlagNote(path, reason string) error` (reason: `stale` | `drift` | `duplicate`).
- Reason precedence in `classifyPrune`: `superseded` > `gardener_flag` > computed-`stale`. One candidate per note.

- [ ] **Step 1: Write the failing test**

Add to `pkg/memvault/prune_test.go`:

```go
func TestClassifyPruneSurfacesGardenerFlag(t *testing.T) {
	now := time.Date(2026, 7, 10, 0, 0, 0, 0, time.UTC)
	notes := []Note{
		{ID: "drifted", Title: "D", GardenerFlag: "drift"},
		{ID: "dup", Title: "U", GardenerFlag: "duplicate"},
		{ID: "sup", Title: "S", SupersededBy: "x", GardenerFlag: "drift"}, // superseded wins
	}
	got := classifyPrune(notes, now)
	byID := map[string]string{}
	for _, c := range got {
		byID[c.ID] = c.Reason
	}
	if byID["drifted"] != "drift" || byID["dup"] != "duplicate" || byID["sup"] != "superseded" {
		t.Fatalf("wrong reasons: %+v", byID)
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `go test ./pkg/memvault/ -run TestClassifyPruneSurfacesGardenerFlag -v`
Expected: FAIL — `unknown field GardenerFlag` (compile) then wrong reasons.

- [ ] **Step 3: Add the field to `Note` + `frontmatter` + `parseNote`**

In `pkg/memvault/memvault.go`, add to `Note` (after `LastReferenced`):

```go
	GardenerFlag string `json:"gardenerflag"` // metadata.gardener_flag: stale|drift|duplicate (cleanup queue)
```

Add to the `frontmatter` struct's `Metadata`:

```go
		GardenerFlag   string `yaml:"gardener_flag"`
```

In `parseNote`, after `n.LastReferenced = fm.Metadata.LastReferenced`:

```go
				n.GardenerFlag = fm.Metadata.GardenerFlag
```

- [ ] **Step 4: Add `FlagNote`**

Append to `pkg/memvault/memvault.go` (or `learn.go`, near `editNoteMetadata`). Use `editNoteMetadata` from `learn.go`:

```go
// FlagNote stamps metadata.gardener_flag on a hub note so classifyPrune surfaces it in the cleanup
// queue. reason: "stale" | "drift" | "duplicate". Idempotent (upsert).
func FlagNote(path, reason string) error {
	return editNoteMetadata(path, "gardener_flag", reason)
}
```

- [ ] **Step 5: Update `classifyPrune`**

In `pkg/memvault/prune.go`, extend the switch (add the `GardenerFlag` case before the `LastReferenced` case) and update the doc comment + the `Reason` field comment to mention `drift`/`duplicate`:

```go
		switch {
		case n.SupersededBy != "":
			out = append(out, PruneCandidate{ID: n.ID, Title: n.Title, Reason: "superseded", Path: n.Path})
		case n.GardenerFlag != "":
			out = append(out, PruneCandidate{ID: n.ID, Title: n.Title, Reason: n.GardenerFlag, Path: n.Path})
		case n.LastReferenced != "":
			if ts, err := time.Parse(time.RFC3339, n.LastReferenced); err == nil && ts.Before(cutoff) {
				out = append(out, PruneCandidate{ID: n.ID, Title: n.Title, Reason: "stale", Path: n.Path})
			}
		}
```

- [ ] **Step 6: Run the memvault suite to verify it passes**

Run: `go test ./pkg/memvault/ -v`
Expected: PASS (new + existing `TestClassifyPrune`).

- [ ] **Step 7: Stage**

Run: `git add pkg/memvault/memvault.go pkg/memvault/prune.go pkg/memvault/prune_test.go`

---

## Task 6: Hub enumeration + repo resolution

The gardener needs the universe of hubs to sweep (all `~/.claude/projects/*/memory`) and, for the dead-ref pillar, the repo path behind a hub (via the Projects registry; lossy `projectHash` is reversed by re-encoding registry paths).

**Files:**
- Modify: `pkg/memvault/projection.go`
- Test: `pkg/memvault/projection_test.go` (extend)

**Interfaces:**
- Consumes: `registryProjects()` (`projection.go:175`), `projectHash` (`projection.go:22`), `HubDirForCwd`, `readHubNotes` (`projection.go:133`).
- Produces:
  - `func ClaudeHubDirs() []string` — every existing `~/.claude/projects/*/memory`.
  - `func RepoPathForHubDir(hubDir string) string` — repo path via registry, else `""`.
  - `func HubNotes(hubDir string) []NoteWithBody` — exported wrapper of `readHubNotes`.

- [ ] **Step 1: Write the failing test**

Add to `pkg/memvault/projection_test.go`:

```go
func TestRepoPathForHubDir(t *testing.T) {
	repo := `C:\Users\k\proj`
	projects := map[string]string{"proj": repo}
	hub := filepath.Join("root", ".claude", "projects", projectHash(repo), "memory")
	if got := repoPathForHubDir(hub, projects); got != repo {
		t.Fatalf("want %q got %q", repo, got)
	}
	if got := repoPathForHubDir(filepath.Join("root", ".claude", "projects", "C--unknown", "memory"), projects); got != "" {
		t.Fatalf("unknown hub should resolve to empty, got %q", got)
	}
}
```

(`import "path/filepath"` if not already present.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `go test ./pkg/memvault/ -run TestRepoPathForHubDir -v`
Expected: FAIL — `undefined: repoPathForHubDir`.

- [ ] **Step 3: Write the implementation**

Append to `pkg/memvault/projection.go`:

```go
// ClaudeHubDirs enumerates every existing Claude per-project memory hub (~/.claude/projects/*/memory).
// This is the gardener's sweep universe.
func ClaudeHubDirs() []string {
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

// RepoPathForHubDir reverse-resolves a hub dir to its repo path via the Projects registry, or "" when
// unknown (projectHash is lossy; we re-encode each registered path to match).
func RepoPathForHubDir(hubDir string) string {
	return repoPathForHubDir(hubDir, registryProjects())
}

// repoPathForHubDir is the pure core (testable without config).
func repoPathForHubDir(hubDir string, projects map[string]string) string {
	hash := filepath.Base(filepath.Dir(hubDir)) // .../projects/<hash>/memory
	for _, p := range projects {
		if projectHash(filepath.Clean(p)) == hash {
			return p
		}
	}
	return ""
}

// HubNotes reads every note (with body) directly under hubDir. Exported for the gardener.
func HubNotes(hubDir string) []NoteWithBody {
	return readHubNotes(hubDir)
}
```

Add `"os"` to the imports if not already present (it is used by `readHubNotes`, so it is already imported).

- [ ] **Step 4: Run the test to verify it passes**

Run: `go test ./pkg/memvault/ -run TestRepoPathForHubDir -v`
Expected: PASS.

- [ ] **Step 5: Stage**

Run: `git add pkg/memvault/projection.go pkg/memvault/projection_test.go`

---

## Task 7: Decay classifier (pure)

The decisive pillar. Given hub notes + `now` + `staleDays`, decide per note: **auto-archive** (machine, unused by real recall for N days, capture age > N days), **flag** (human, never-referenced, old — the never-referenced-immortal leak), or leave alone. Superseded notes are left to the existing superseded queue.

**Files:**
- Create: `pkg/memgarden/decay.go`
- Test: `pkg/memgarden/decay_test.go`

**Interfaces:**
- Consumes: `memvault.Note`.
- Produces:
  - `type DecayAction struct { NoteID, Path, Reason string; Archive bool }` (Reason: `decay` for archive, `stale` for flag)
  - `func classifyDecay(notes []memvault.Note, now time.Time, staleDays int) []DecayAction`

- [ ] **Step 1: Write the failing test**

```go
package memgarden

import (
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/memvault"
)

func TestClassifyDecay(t *testing.T) {
	now := time.Date(2026, 7, 20, 0, 0, 0, 0, time.UTC)
	oldCap := now.AddDate(0, 0, -40).Format(time.RFC3339)
	freshCap := now.AddDate(0, 0, -5).Format(time.RFC3339)
	oldRef := now.AddDate(0, 0, -40).Format(time.RFC3339)
	freshRef := now.AddDate(0, 0, -2).Format(time.RFC3339)

	notes := []memvault.Note{
		// machine, never referenced, old -> auto-archive
		{ID: "m-neverref-old", Path: "/h/m1.md", Source: "agent", CapturedAt: oldCap},
		// machine, referenced but stale, old -> auto-archive
		{ID: "m-staleref-old", Path: "/h/m2.md", Source: "codex", CapturedAt: oldCap, LastReferenced: oldRef},
		// machine, recently referenced -> leave alone
		{ID: "m-fresh", Path: "/h/m3.md", Source: "agent", CapturedAt: oldCap, LastReferenced: freshRef},
		// machine, old-referenced but young capture -> leave alone (not old enough)
		{ID: "m-young", Path: "/h/m4.md", Source: "agent", CapturedAt: freshCap, LastReferenced: oldRef},
		// human, never referenced, old -> flag (never auto-archive)
		{ID: "h-neverref-old", Path: "/h/h1.md", Source: "claude", CapturedAt: oldCap},
		// human, referenced-stale -> left to classifyPrune, NOT flagged by decay
		{ID: "h-staleref", Path: "/h/h2.md", Source: "claude", CapturedAt: oldCap, LastReferenced: oldRef},
		// superseded machine -> left to superseded queue
		{ID: "m-superseded", Path: "/h/m5.md", Source: "agent", CapturedAt: oldCap, SupersededBy: "x"},
	}
	got := classifyDecay(notes, now, 30)
	byID := map[string]DecayAction{}
	for _, a := range got {
		byID[a.NoteID] = a
	}
	if a, ok := byID["m-neverref-old"]; !ok || !a.Archive || a.Reason != "decay" {
		t.Fatalf("m-neverref-old should auto-archive: %+v", a)
	}
	if a, ok := byID["m-staleref-old"]; !ok || !a.Archive {
		t.Fatalf("m-staleref-old should auto-archive: %+v", a)
	}
	if a, ok := byID["h-neverref-old"]; !ok || a.Archive || a.Reason != "stale" {
		t.Fatalf("h-neverref-old should flag stale, never archive: %+v", a)
	}
	for _, id := range []string{"m-fresh", "m-young", "h-staleref", "m-superseded"} {
		if _, ok := byID[id]; ok {
			t.Fatalf("%s should be left alone, got %+v", id, byID[id])
		}
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `go test ./pkg/memgarden/ -run TestClassifyDecay -v`
Expected: FAIL — no such package / `undefined: classifyDecay`.

- [ ] **Step 3: Write the implementation**

Create `pkg/memgarden/decay.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Decay: the gardener's decisive pillar. A machine-authored note provably unused (real recall
// telemetry) for N days and older than N days is auto-archived; a human note that is never-referenced
// and old is flagged (never auto-archived). Superseded and referenced-stale notes are left to the
// existing prune queue. Pure + deterministic (0 tokens).
// See docs/superpowers/specs/2026-07-20-memory-relevance-gardener-design.md.
package memgarden

import (
	"time"

	"github.com/wavetermdev/waveterm/pkg/memvault"
)

// DecayAction is one gardener decision for a note. Archive=true -> move to archive (machine only);
// Archive=false -> flag into the cleanup queue.
type DecayAction struct {
	NoteID  string
	Path    string
	Reason  string // "decay" (archive) | "stale" (flag)
	Archive bool
}

func isMachine(source string) bool { return source == "agent" || source == "codex" }

// beforeCutoff reports whether an RFC3339 timestamp parses and precedes cutoff.
func beforeCutoff(ts string, cutoff time.Time) bool {
	t, err := time.Parse(time.RFC3339, ts)
	return err == nil && t.Before(cutoff)
}

// classifyDecay returns the decay actions for notes as of now. staleDays defines N.
func classifyDecay(notes []memvault.Note, now time.Time, staleDays int) []DecayAction {
	cutoff := now.AddDate(0, 0, -staleDays)
	var out []DecayAction
	for _, n := range notes {
		if n.SupersededBy != "" {
			continue // handled by the superseded queue
		}
		neverReferenced := n.LastReferenced == ""
		unusedByRecall := neverReferenced || beforeCutoff(n.LastReferenced, cutoff)
		old := ageBeforeCutoff(n, cutoff)
		switch {
		case isMachine(n.Source) && unusedByRecall && old:
			out = append(out, DecayAction{NoteID: n.ID, Path: n.Path, Reason: "decay", Archive: true})
		case !isMachine(n.Source) && neverReferenced && old:
			// the never-referenced-immortal leak, respecting hand-written notes: flag, never archive.
			out = append(out, DecayAction{NoteID: n.ID, Path: n.Path, Reason: "stale", Archive: false})
		}
	}
	return out
}

// ageBeforeCutoff reports whether the note's age basis (captured_at, else file mtime) precedes cutoff.
func ageBeforeCutoff(n memvault.Note, cutoff time.Time) bool {
	if n.CapturedAt != "" {
		return beforeCutoff(n.CapturedAt, cutoff)
	}
	if n.UpdatedTs > 0 {
		return time.UnixMilli(n.UpdatedTs).Before(cutoff)
	}
	return false
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `go test ./pkg/memgarden/ -run TestClassifyDecay -v`
Expected: PASS.

- [ ] **Step 5: Stage**

Run: `git add pkg/memgarden/decay.go pkg/memgarden/decay_test.go`

---

## Task 8: Dead-ref freshness (deterministic)

A note that names concrete repo paths — all now absent — is about deleted code → auto-archive (reason `drift`). Conservative: extract only path-like tokens with code extensions; archive only when the note has ≥1 such ref and **none** exist. Deterministic (0 tokens), reversible.

**Files:**
- Create: `pkg/memgarden/freshness.go`
- Test: `pkg/memgarden/freshness_test.go`

**Interfaces:**
- Produces:
  - `func extractRefs(body string) []string` — deduped candidate paths (no `:line` suffix).
  - `func buildRepoIndex(repoPath string) map[string]bool` — relative slash-paths + basenames present (bounded walk, skips `.git`/`node_modules`/`dist`/`vendor`/`.claude`/`target`).
  - `func allRefsDead(refs []string, index map[string]bool) bool` — true iff refs non-empty and every ref absent.

- [ ] **Step 1: Write the failing test**

```go
package memgarden

import (
	"os"
	"path/filepath"
	"testing"
)

func TestExtractRefs(t *testing.T) {
	body := "See `prune.go:25` and frontend/app/store/wshclientapi.ts plus a plain word and Foo.md."
	got := extractRefs(body)
	want := map[string]bool{"prune.go": true, "frontend/app/store/wshclientapi.ts": true, "Foo.md": true}
	if len(got) != len(want) {
		t.Fatalf("got %v", got)
	}
	for _, g := range got {
		if !want[g] {
			t.Fatalf("unexpected ref %q in %v", g, got)
		}
	}
}

func TestAllRefsDead(t *testing.T) {
	index := map[string]bool{"prune.go": true, "a/b.ts": true}
	if allRefsDead(nil, index) {
		t.Fatalf("no refs -> not dead")
	}
	if allRefsDead([]string{"prune.go"}, index) {
		t.Fatalf("live ref -> not dead")
	}
	if !allRefsDead([]string{"gone.go", "also/gone.ts"}, index) {
		t.Fatalf("all-absent refs -> dead")
	}
	if allRefsDead([]string{"gone.go", "prune.go"}, index) {
		t.Fatalf("mixed -> not all dead")
	}
}

func TestBuildRepoIndex(t *testing.T) {
	repo := t.TempDir()
	_ = os.MkdirAll(filepath.Join(repo, "pkg"), 0o755)
	_ = os.WriteFile(filepath.Join(repo, "pkg", "x.go"), []byte("x"), 0o644)
	_ = os.MkdirAll(filepath.Join(repo, "node_modules", "y"), 0o755)
	_ = os.WriteFile(filepath.Join(repo, "node_modules", "y", "z.go"), []byte("z"), 0o644)
	idx := buildRepoIndex(repo)
	if !idx["x.go"] || !idx["pkg/x.go"] {
		t.Fatalf("expected x.go indexed by basename + rel path: %v", idx)
	}
	if idx["z.go"] {
		t.Fatalf("node_modules should be skipped")
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `go test ./pkg/memgarden/ -run "TestExtractRefs|TestAllRefsDead|TestBuildRepoIndex" -v`
Expected: FAIL — `undefined: extractRefs`.

- [ ] **Step 3: Write the implementation**

Create `pkg/memgarden/freshness.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Freshness: content-drift detection. The deterministic half auto-archives a note whose only concrete
// path references are all absent from the repo (about deleted code). The LLM half (soft drift) is
// flag-only and added later. Deterministic checks cost 0 tokens.
// See docs/superpowers/specs/2026-07-20-memory-relevance-gardener-design.md.
package memgarden

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// refRe matches path-like tokens with a source extension, optionally with a :line suffix (group 1 is
// the path). Conservative on purpose: prose words never match.
var refRe = regexp.MustCompile(`([A-Za-z0-9_./-]+\.(?:go|ts|tsx|js|jsx|rs|py|md|json|sql|css|scss|ya?ml|toml|sh))(?::\d+)?`)

// extractRefs returns the deduped concrete path references in a note body (":line" stripped).
func extractRefs(body string) []string {
	var out []string
	seen := map[string]bool{}
	for _, m := range refRe.FindAllStringSubmatch(body, -1) {
		p := m[1]
		if p != "" && !seen[p] {
			seen[p] = true
			out = append(out, p)
		}
	}
	return out
}

// allRefsDead reports whether refs is non-empty and every ref is absent from index. A ref with a
// slash is matched as a relative path; a bare filename is matched by basename.
func allRefsDead(refs []string, index map[string]bool) bool {
	if len(refs) == 0 {
		return false
	}
	for _, r := range refs {
		key := filepath.ToSlash(r)
		if index[key] {
			return false
		}
	}
	return true
}

// maxIndexEntries caps the repo index so a pathological tree can't blow up memory.
const maxIndexEntries = 200000

var skipDirs = map[string]bool{".git": true, "node_modules": true, "dist": true, "vendor": true, ".claude": true, "target": true}

// buildRepoIndex walks repoPath and returns the set of present files keyed by both relative slash-path
// and basename. Skips heavy/generated dirs. Empty repoPath -> empty set.
func buildRepoIndex(repoPath string) map[string]bool {
	out := map[string]bool{}
	if repoPath == "" {
		return out
	}
	_ = filepath.WalkDir(repoPath, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() {
			if skipDirs[d.Name()] {
				return filepath.SkipDir
			}
			return nil
		}
		if len(out) >= maxIndexEntries {
			return filepath.SkipAll
		}
		if rel, relErr := filepath.Rel(repoPath, path); relErr == nil {
			out[filepath.ToSlash(rel)] = true
		}
		out[d.Name()] = true
		return nil
	})
	return out
}
```

Note: `allRefsDead` keys every ref by its full slash form; `buildRepoIndex` stores both the relative slash-path and the basename, so a bare `prune.go` ref matches the basename entry and a `a/b.ts` ref matches the relative-path entry.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `go test ./pkg/memgarden/ -run "TestExtractRefs|TestAllRefsDead|TestBuildRepoIndex" -v`
Expected: PASS.

- [ ] **Step 5: Stage**

Run: `git add pkg/memgarden/freshness.go pkg/memgarden/freshness_test.go`

---

## Task 9: Gardener orchestration (deterministic pillars)

Wire decay + dead-ref into a per-project sweep with single-flight, the per-pass archive cap, and the configurable `N`. LLM pillars come later (Tasks 11-12). Dependency-injected like the distiller (`memdistill/coordinator.go`) so orchestration is testable with fakes.

**Files:**
- Create: `pkg/memgarden/gardener.go`
- Test: `pkg/memgarden/gardener_test.go`
- Modify: `pkg/wconfig/settingsconfig.go:113` (add field)
- Modify: `pkg/wconfig/metaconsts.go:61` (add const)

**Interfaces:**
- Consumes: `memvault.HubNotes`, `memvault.NoteWithBody`, `memvault.Archive`, `memvault.FlagNote`, `memvault.RepoPathForHubDir`, `memvault.ClaudeHubDirs`, `memvault.StaleDays`; `classifyDecay`, `extractRefs`, `buildRepoIndex`, `allRefsDead`, `isMachine`; `panichandler.PanicHandler`; `wconfig.GetWatcher()`.
- Produces: `type gardener struct{...}` (injectable deps), `newGardener()`, `(*gardener).gardenProject(hubDir)`, `(*gardener).sweep()`, `Sweep()`, `gardenerStaleDays()`, and the `llmFn`/`runLLMPillars` seams used by Tasks 11-12.

- [ ] **Step 1: Write the failing test**

```go
package memgarden

import (
	"sync"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/memvault"
)

func TestGardenProjectDeterministic(t *testing.T) {
	now := time.Date(2026, 7, 20, 0, 0, 0, 0, time.UTC)
	oldCap := now.AddDate(0, 0, -40).Format(time.RFC3339)

	var archived, flagged []string
	g := newGardener()
	g.now = func() time.Time { return now }
	g.hubNotesFn = func(hub string) []memvault.NoteWithBody {
		return []memvault.NoteWithBody{
			{Note: memvault.Note{ID: "m-dead", Path: "/h/m-dead.md", Source: "agent", CapturedAt: oldCap}},
			{Note: memvault.Note{ID: "h-old", Path: "/h/h-old.md", Source: "claude", CapturedAt: oldCap}},
			{Note: memvault.Note{ID: "ref-dead", Path: "/h/ref-dead.md", Source: "agent", CapturedAt: oldCap}, Body: "about gone.go only"},
		}
	}
	g.repoPathFn = func(hub string) string { return "/repo" }
	g.repoIndexFn = func(repo string) map[string]bool { return map[string]bool{} }
	g.archiveFn = func(path, reason string, _ time.Time) (string, error) {
		archived = append(archived, path+":"+reason)
		return path, nil
	}
	g.flagFn = func(path, reason string) error {
		flagged = append(flagged, path+":"+reason)
		return nil
	}

	g.gardenProject("/h")

	if len(archived) != 2 { // m-dead + ref-dead (both machine+old) archived by decay
		t.Fatalf("want 2 archives, got %v", archived)
	}
	if len(flagged) != 1 || flagged[0] != "/h/h-old.md:stale" {
		t.Fatalf("want 1 stale flag, got %v", flagged)
	}
}

func TestGardenProjectRespectsArchiveCap(t *testing.T) {
	now := time.Date(2026, 7, 20, 0, 0, 0, 0, time.UTC)
	oldCap := now.AddDate(0, 0, -40).Format(time.RFC3339)
	g := newGardener()
	g.now = func() time.Time { return now }
	g.maxArchives = 2
	g.repoPathFn = func(string) string { return "" }
	g.repoIndexFn = func(string) map[string]bool { return map[string]bool{} }
	var n int
	g.archiveFn = func(path, reason string, _ time.Time) (string, error) { n++; return path, nil }
	g.flagFn = func(string, string) error { return nil }
	g.hubNotesFn = func(string) []memvault.NoteWithBody {
		var out []memvault.NoteWithBody
		for i := 0; i < 5; i++ {
			out = append(out, memvault.NoteWithBody{Note: memvault.Note{ID: "x", Path: "/h/x.md", Source: "agent", CapturedAt: oldCap}})
		}
		return out
	}
	g.gardenProject("/h")
	if n != 2 {
		t.Fatalf("archive cap not respected: archived %d, want 2", n)
	}
}

func TestSweepSingleFlight(t *testing.T) {
	g := newGardener()
	release := make(chan struct{})
	started := make(chan struct{}, 4)
	g.hubDirsFn = func() []string { return []string{"/h"} }
	g.gardenFn = func(hub string) {
		started <- struct{}{}
		<-release
	}
	g.sweep()
	g.sweep() // /h already inflight -> must not launch again
	<-started
	select {
	case <-started:
		close(release)
		t.Fatalf("single-flight violated: /h gardened twice concurrently")
	case <-time.After(50 * time.Millisecond):
	}
	close(release)
}

var _ = sync.Mutex{}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `go test ./pkg/memgarden/ -run "TestGardenProject|TestSweep" -v`
Expected: FAIL — `undefined: newGardener`.

- [ ] **Step 3: Add the config knob**

In `pkg/wconfig/settingsconfig.go`, at line 113 replace the single `MemoryVaultPath` line with:

```go
	MemoryVaultPath         string `json:"memory:vaultpath,omitempty"`
	MemoryGardenerStaleDays int    `json:"memory:gardenerstaledays,omitempty"`
```

In `pkg/wconfig/metaconsts.go`, after `ConfigKey_MemoryVaultPath` (line 61):

```go
	ConfigKey_MemoryGardenerStaleDays        = "memory:gardenerstaledays"
```

- [ ] **Step 4: Write the gardener**

Create `pkg/memgarden/gardener.go`. For this task the LLM seam is inert (`runLLMPillars` no-op, `runGardenLLM` returns `("", false)`); Tasks 11-12 fill them.

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The gardener loop: per-project sweep that auto-archives provably-unused machine notes and dead-ref
// notes (deterministic, 0 tokens) and flags judgment calls into the cleanup queue. Rides the memdistill
// coordinator's single hourly ticker (registered in main-server.go). Single-flight per project;
// per-pass archive cap. See docs/superpowers/specs/2026-07-20-memory-relevance-gardener-design.md.
package memgarden

import (
	"log"
	"sync"
	"time"

	"github.com/wavetermdev/waveterm/pkg/memvault"
	"github.com/wavetermdev/waveterm/pkg/panichandler"
	"github.com/wavetermdev/waveterm/pkg/wconfig"
)

const (
	maxArchivesPerPass = 20
	haikuModel         = "claude-haiku-4-5"
	sonnetModel        = "claude-sonnet-5"
)

type gardener struct {
	mu       sync.Mutex
	inflight map[string]bool

	now         func() time.Time
	staleDays   int
	maxArchives int

	hubDirsFn   func() []string
	hubNotesFn  func(hubDir string) []memvault.NoteWithBody
	repoPathFn  func(hubDir string) string
	repoIndexFn func(repoPath string) map[string]bool
	archiveFn   func(path, reason string, now time.Time) (string, error)
	flagFn      func(path, reason string) error

	gardenFn func(hubDir string)                                // indirection so sweep single-flight tests in isolation
	llmFn    func(model, prompt, corpus string) (string, bool)  // used by Tasks 11-12
}

func newGardener() *gardener {
	g := &gardener{
		inflight:    map[string]bool{},
		now:         time.Now,
		staleDays:   gardenerStaleDays(),
		maxArchives: maxArchivesPerPass,
		hubDirsFn:   memvault.ClaudeHubDirs,
		hubNotesFn:  memvault.HubNotes,
		repoPathFn:  memvault.RepoPathForHubDir,
		repoIndexFn: buildRepoIndex,
		archiveFn:   memvault.Archive,
		flagFn:      memvault.FlagNote,
		llmFn:       runGardenLLM,
	}
	g.gardenFn = g.gardenProject
	return g
}

// gardenerStaleDays resolves N from config, falling back to memvault.StaleDays (30).
func gardenerStaleDays() int {
	if cfg := wconfig.GetWatcher().GetFullConfig(); cfg.Settings.MemoryGardenerStaleDays > 0 {
		return cfg.Settings.MemoryGardenerStaleDays
	}
	return memvault.StaleDays
}

// gardenProject runs the pillars for one hub, honoring the per-pass archive cap. Every auto-action is
// logged (the visible action log; the Archived view is the reversibility surface).
func (g *gardener) gardenProject(hubDir string) {
	notes := g.hubNotesFn(hubDir)
	plain := make([]memvault.Note, len(notes))
	for i, n := range notes {
		plain[i] = n.Note
	}
	now := g.now()
	archivedThisPass := 0
	archivedPaths := map[string]bool{}

	archive := func(path, reason string) {
		if archivedThisPass >= g.maxArchives {
			return // spread the rest across later sweeps
		}
		if _, err := g.archiveFn(path, reason, now); err != nil {
			log.Printf("[memgarden] archive %s (%s): %v\n", path, reason, err)
			return
		}
		archivedThisPass++
		archivedPaths[path] = true
		log.Printf("[memgarden] archived %s reason=%s hub=%s\n", path, reason, hubDir)
	}

	// Pillar 1: decay (recall + age).
	for _, a := range classifyDecay(plain, now, g.staleDays) {
		if a.Archive {
			archive(a.Path, a.Reason)
		} else if err := g.flagFn(a.Path, a.Reason); err != nil {
			log.Printf("[memgarden] flag %s (%s): %v\n", a.Path, a.Reason, err)
		}
	}

	// Pillar 2: dead-ref freshness (deterministic). Machine notes whose refs are all gone -> archive.
	repoPath := g.repoPathFn(hubDir)
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

	g.runLLMPillars(hubDir, notes, repoPath) // no-op until Tasks 11-12
}

// runLLMPillars is filled in by Tasks 11-12. Deterministic-only build: no-op.
func (g *gardener) runLLMPillars(hubDir string, notes []memvault.NoteWithBody, repoPath string) {}

// runGardenLLM is the injectable LLM seam. Real headless-claude body lands in Task 11.
func runGardenLLM(model, prompt, corpus string) (string, bool) { return "", false }

// sweep enumerates hubs and launches a single-flight background garden per project.
func (g *gardener) sweep() {
	for _, hub := range g.hubDirsFn() {
		g.mu.Lock()
		busy := g.inflight[hub]
		if !busy {
			g.inflight[hub] = true
		}
		g.mu.Unlock()
		if busy {
			continue
		}
		go func(h string) {
			defer func() {
				panichandler.PanicHandler("memgarden.gardenProject", recover())
				g.mu.Lock()
				delete(g.inflight, h)
				g.mu.Unlock()
			}()
			g.gardenFn(h)
		}(hub)
	}
}

var (
	defaultGardener *gardener
	startOnce       sync.Once
)

func ensure() {
	startOnce.Do(func() { defaultGardener = newGardener() })
}

// Sweep is the coordinator hook entry: garden every project hub once (single-flight, non-blocking).
func Sweep() {
	ensure()
	defaultGardener.sweep()
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `go test ./pkg/memgarden/ -run "TestGardenProject|TestSweep" -v`
Expected: PASS.

- [ ] **Step 6: Verify wconfig + memgarden build**

Run: `go build ./pkg/wconfig/ ./pkg/memgarden/`
Expected: exit 0.

- [ ] **Step 7: Stage**

Run: `git add pkg/memgarden/gardener.go pkg/memgarden/gardener_test.go pkg/wconfig/settingsconfig.go pkg/wconfig/metaconsts.go`

---

## Task 10: Coordinator hook + server startup wiring

Register the gardener sweep on the coordinator's existing ticker (one timer) and wire it in `main-server.go` next to `memdistill.Start`. After this task the deterministic gardener runs live hourly.

**Files:**
- Modify: `pkg/memdistill/coordinator.go`
- Test: `pkg/memdistill/coordinator_test.go` (extend)
- Modify: `cmd/server/main-server.go:590`

**Interfaces:**
- Produces: `func RegisterSweepHook(fn func())` and `(*distiller).runSweepHooks()` in `memdistill`; hooks run on the startup sweep and each tick.

- [ ] **Step 1: Write the failing test**

Add to `pkg/memdistill/coordinator_test.go` (ensure imports `sync/atomic`, `path/filepath`):

```go
func TestSweepRunsRegisteredHooks(t *testing.T) {
	var n int32
	RegisterSweepHook(func() { atomic.AddInt32(&n, 1) })
	t.Cleanup(func() { sweepHooks = nil })
	d := newDistiller(filepath.Join(t.TempDir(), "q.json"))
	d.runSweepHooks()
	if atomic.LoadInt32(&n) != 1 {
		t.Fatalf("hook not run: %d", n)
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `go test ./pkg/memdistill/ -run TestSweepRunsRegisteredHooks -v`
Expected: FAIL — `undefined: RegisterSweepHook`.

- [ ] **Step 3: Add the hook mechanism**

In `pkg/memdistill/coordinator.go`, add near the other package vars:

```go
// sweepHooks are extra per-tick sweeps (e.g. the memory gardener) so the memory subsystem runs on a
// single background ticker rather than a parallel timer. Register before Start.
var sweepHooks []func()

// RegisterSweepHook adds fn to the coordinator's per-tick sweep. Call before Start.
func RegisterSweepHook(fn func()) { sweepHooks = append(sweepHooks, fn) }

func (d *distiller) runSweepHooks() {
	for _, fn := range sweepHooks {
		func() {
			defer func() { panichandler.PanicHandler("memdistill.sweepHook", recover()) }()
			fn()
		}()
	}
}
```

Then update `Start` so each sweep is followed by `runSweepHooks` (startup sweep + ticker):

```go
func Start(ctx context.Context) {
	ensure()
	go func() {
		defer func() {
			panichandler.PanicHandler("memdistill.sweep-loop", recover())
		}()
		defaultDistiller.sweep()
		defaultDistiller.runSweepHooks()
		t := time.NewTicker(tickInterval)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				defaultDistiller.sweep()
				defaultDistiller.runSweepHooks()
			}
		}
	}()
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `go test ./pkg/memdistill/ -run TestSweepRunsRegisteredHooks -v`
Expected: PASS.

- [ ] **Step 5: Register the gardener at startup**

In `cmd/server/main-server.go`, add the import `"github.com/wavetermdev/waveterm/pkg/memgarden"` and, immediately before `memdistill.Start(context.Background())` (line 590):

```go
	memdistill.RegisterSweepHook(memgarden.Sweep)
	memdistill.Start(context.Background())
```

- [ ] **Step 6: Verify the server builds**

Run: `go build ./cmd/server/`
Expected: exit 0.

- [ ] **Step 7: Stage**

Run: `git add pkg/memdistill/coordinator.go pkg/memdistill/coordinator_test.go cmd/server/main-server.go`

---

## Task 11: Soft-drift LLM pillar (flag-only, mtime-gated)

The LLM half of freshness: a note whose advice contradicts current code is *flagged* (`drift`) into the cleanup queue — never auto-archived. Runs only on notes whose referenced files changed since last sweep (per-note in-memory mtime gate), capped per pass so a full rescan spreads across sweeps. Model: haiku, escalating to sonnet on a large corpus. This task also lands the real `runClaudeHeadless` LLM seam used by Task 12.

**Files:**
- Modify: `pkg/memgarden/freshness.go` (add drift helpers + `checkSoftDrift`)
- Modify: `pkg/memgarden/gardener.go` (real `runGardenLLM`/`runClaudeHeadless`, `pickModel`, wire `runLLMPillars`)
- Test: `pkg/memgarden/freshness_test.go` (extend)

**Interfaces:**
- Consumes: `g.llmFn`, `g.flagFn`, `extractRefs`; `memdistill.DistillGuardVar`.
- Produces:
  - `func parseDriftVerdict(raw string) (drift bool, reason string)`
  - `func driftCorpus(noteBody string, refContents map[string]string) string`
  - `func refMtimeFingerprint(repoPath string, refs []string) string`
  - `func (g *gardener) checkSoftDrift(repoPath string, notes []memvault.NoteWithBody)`
  - `func runClaudeHeadless(model, prompt, corpus string) (string, bool)`, `func pickModel(corpus string) string`
  - `maxLLMChecksPerPass = 20`; package-level `lastRefCheck map[string]string` (notePath → ref-mtime fingerprint), mutex-guarded.

- [ ] **Step 1: Write the failing test (pure helpers)**

Add to `pkg/memgarden/freshness_test.go`:

```go
func TestParseDriftVerdict(t *testing.T) {
	if d, _ := parseDriftVerdict(`noise {"drift": true, "reason": "flag renamed"} trailing`); !d {
		t.Fatalf("should parse drift=true")
	}
	if d, _ := parseDriftVerdict(`{"drift": false, "reason": ""}`); d {
		t.Fatalf("should parse drift=false")
	}
	if d, _ := parseDriftVerdict(`not json`); d {
		t.Fatalf("unparseable -> drift=false (fail-safe)")
	}
}

func TestCheckSoftDriftFlagsAndGates(t *testing.T) {
	repo := t.TempDir()
	if err := os.WriteFile(filepath.Join(repo, "live.go"), []byte("package x"), 0o644); err != nil {
		t.Fatal(err)
	}
	lastRefCheck = map[string]string{} // reset the in-memory gate for a deterministic test

	var calls, flags int
	g := newGardener()
	g.llmFn = func(model, prompt, corpus string) (string, bool) {
		calls++
		return `{"drift": true, "reason": "advice contradicts live.go"}`, true
	}
	g.flagFn = func(path, reason string) error {
		if reason == "drift" {
			flags++
		}
		return nil
	}
	notes := []memvault.NoteWithBody{
		{Note: memvault.Note{ID: "n1", Path: "/h/n1.md", Source: "agent"}, Body: "always call live.go the old way"},
		{Note: memvault.Note{ID: "flagged", Path: "/h/f.md", Source: "agent", GardenerFlag: "drift"}, Body: "live.go"}, // already flagged -> skip
		{Note: memvault.Note{ID: "norefs", Path: "/h/nr.md", Source: "agent"}, Body: "no path refs here"},              // no refs -> skip
	}
	g.checkSoftDrift(repo, notes)
	if calls != 1 || flags != 1 {
		t.Fatalf("want 1 llm call + 1 flag, got calls=%d flags=%d", calls, flags)
	}
	// second pass, files unchanged -> mtime gate skips n1 entirely
	g.checkSoftDrift(repo, notes)
	if calls != 1 {
		t.Fatalf("mtime gate failed: expected no new llm calls, got %d", calls)
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `go test ./pkg/memgarden/ -run "TestParseDriftVerdict|TestCheckSoftDrift" -v`
Expected: FAIL — `undefined: parseDriftVerdict`.

- [ ] **Step 3: Add drift helpers to `freshness.go`**

Append to `pkg/memgarden/freshness.go` (add imports `encoding/json`, `fmt`, `sync`):

```go
const (
	maxLLMChecksPerPass = 20
	maxRefBytes         = 4 * 1024   // per referenced file fed to the drift check
	driftPrompt         = "You are checking whether a project memory note still matches the current code. " +
		"Input: the note, then the current content of files it references. " +
		`Output ONLY JSON: {"drift": bool, "reason": string}. ` +
		"Set drift=true only if the note's advice clearly contradicts the current code (renamed symbol, " +
		"removed flag, changed behavior). If it is still accurate or you are unsure, drift=false."
)

// lastRefCheck gates the drift LLM per note by the mtime fingerprint of its referenced files. In-memory
// (mirrors harvest.go's lastHarvestMtime); a server restart re-checks once. Steady-state: no LLM calls.
var (
	lastRefCheckMu sync.Mutex
	lastRefCheck   = map[string]string{}
)

// parseDriftVerdict extracts {"drift":bool,"reason":string} from an LLM response. Fail-safe: any parse
// problem yields drift=false so a note is never flagged on garbage output.
func parseDriftVerdict(raw string) (bool, string) {
	i := strings.IndexByte(raw, '{')
	j := strings.LastIndexByte(raw, '}')
	if i < 0 || j <= i {
		return false, ""
	}
	var v struct {
		Drift  bool   `json:"drift"`
		Reason string `json:"reason"`
	}
	if json.Unmarshal([]byte(raw[i:j+1]), &v) != nil {
		return false, ""
	}
	return v.Drift, v.Reason
}

// driftCorpus assembles the note + its referenced files' current content for the drift check.
func driftCorpus(noteBody string, refContents map[string]string) string {
	var b strings.Builder
	b.WriteString("=== MEMORY NOTE ===\n")
	b.WriteString(noteBody)
	for ref, content := range refContents {
		fmt.Fprintf(&b, "\n\n=== FILE: %s ===\n%s", ref, content)
	}
	return b.String()
}

// refMtimeFingerprint concatenates ref:mtime for each existing referenced file (a change any of them
// invalidates). Missing files are skipped (their disappearance is the dead-ref pillar's job).
func refMtimeFingerprint(repoPath string, refs []string) string {
	var b strings.Builder
	for _, r := range refs {
		if info, err := os.Stat(filepath.Join(repoPath, filepath.FromSlash(r))); err == nil {
			fmt.Fprintf(&b, "%s:%d;", r, info.ModTime().UnixMilli())
		}
	}
	return b.String()
}

// checkSoftDrift runs the flag-only drift LLM on notes whose referenced files changed, capped per pass.
// Already-flagged and ref-less notes are skipped. repoPath="" (unknown project) -> no-op.
func (g *gardener) checkSoftDrift(repoPath string, notes []memvault.NoteWithBody) {
	if repoPath == "" {
		return
	}
	checks := 0
	for _, n := range notes {
		if n.Note.GardenerFlag != "" {
			continue // already surfaced; don't re-check
		}
		refs := extractRefs(n.Body)
		refContents := map[string]string{}
		for _, r := range refs {
			if data, err := os.ReadFile(filepath.Join(repoPath, filepath.FromSlash(r))); err == nil {
				refContents[r] = truncate(string(data), maxRefBytes)
			}
		}
		if len(refContents) == 0 {
			continue // nothing live to compare against (all-dead is the deterministic pillar's job)
		}
		fp := refMtimeFingerprint(repoPath, refs)
		lastRefCheckMu.Lock()
		unchanged := lastRefCheck[n.Note.Path] == fp
		lastRefCheckMu.Unlock()
		if unchanged {
			continue // mtime gate: referenced files unchanged since last check
		}
		if checks >= maxLLMChecksPerPass {
			continue // spread the rest across later sweeps (fingerprint left stale so it re-runs)
		}
		checks++
		raw, ok := g.llmFn(pickModel(driftCorpus(n.Body, refContents)), driftPrompt, driftCorpus(n.Body, refContents))
		if !ok {
			continue // LLM failure: retain state, retry next sweep
		}
		lastRefCheckMu.Lock()
		lastRefCheck[n.Note.Path] = fp
		lastRefCheckMu.Unlock()
		if drift, _ := parseDriftVerdict(raw); drift {
			if err := g.flagFn(n.Note.Path, "drift"); err != nil {
				log.Printf("[memgarden] flag drift %s: %v\n", n.Note.Path, err)
			}
		}
	}
}

// truncate caps s at n bytes on a rune boundary-safe cut.
func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}
```

Note: `freshness.go` now needs `"log"` in its imports.

- [ ] **Step 4: Land the real LLM seam in `gardener.go`**

In `pkg/memgarden/gardener.go`, replace the inert `runGardenLLM`/`runLLMPillars` with real bodies (add imports `context`, `os`, `os/exec`, `strings`, `github.com/wavetermdev/waveterm/pkg/memdistill`):

```go
const (
	combinedBudget = 400 * 1024 // mirror memdistill: at/above this, use the 1M-context model
	llmTimeout     = 110 * time.Second
)

// pickModel escalates to sonnet on a large corpus, mirroring the distiller convention.
func pickModel(corpus string) string {
	if len(corpus) >= combinedBudget {
		return sonnetModel
	}
	return haikuModel
}

// runGardenLLM is the injectable seam wired in newGardener.
func runGardenLLM(model, prompt, corpus string) (string, bool) {
	return runClaudeHeadless(model, prompt, corpus)
}

// runClaudeHeadless runs a `claude -p` pass. The distill guard env marks it as a headless sub-session
// so its own SessionEnd hook no-ops (no self-enqueue, no recall pollution). Mirrors memdistill.runDistill.
func runClaudeHeadless(model, prompt, corpus string) (string, bool) {
	exe := "claude"
	if p, err := exec.LookPath("claude"); err == nil {
		exe = p
	}
	ctx, cancel := context.WithTimeout(context.Background(), llmTimeout)
	defer cancel()
	c := exec.CommandContext(ctx, exe, "-p", "--model", model, prompt)
	c.Stdin = strings.NewReader(corpus)
	c.Env = append(os.Environ(), memdistill.DistillGuardVar+"=1")
	out, err := c.Output()
	if err != nil {
		log.Printf("[memgarden] llm exec failed (model %s): %v\n", model, err)
		return "", false
	}
	return string(out), true
}
```

And wire `runLLMPillars` to call soft-drift (dedup is added in Task 12):

```go
func (g *gardener) runLLMPillars(hubDir string, notes []memvault.NoteWithBody, repoPath string) {
	g.checkSoftDrift(repoPath, notes)
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `go test ./pkg/memgarden/ -v`
Expected: PASS (all memgarden tests, including the earlier deterministic ones — `runLLMPillars` calling `checkSoftDrift` with the test fakes' `repoPathFn` returning `/repo` but the deterministic tests set an empty `repoIndexFn` and no live files, so `checkSoftDrift` finds no live ref contents and makes no llm calls).

> If `TestGardenProjectDeterministic` now makes an unexpected llm call, set `g.llmFn = func(string, string, string) (string, bool) { return "", false }` in that test (the fake repo has no live files, so it should already no-op).

- [ ] **Step 6: Stage**

Run: `git add pkg/memgarden/freshness.go pkg/memgarden/freshness_test.go pkg/memgarden/gardener.go`

---

## Task 12: Near-dup dedup LLM pillar (flag-only, mtime-gated)

Exact-content dups are already blocked at write time (`existingHashes`). This pillar surfaces *semantic* near-dups written at different times — flag-only (`duplicate`), never auto-merged. One LLM cluster call per project, gated by an in-memory fingerprint of the hub's note set (re-runs only when notes change).

**Files:**
- Create: `pkg/memgarden/dedup.go`
- Test: `pkg/memgarden/dedup_test.go`
- Modify: `pkg/memgarden/gardener.go` (`runLLMPillars` also calls dedup)

**Interfaces:**
- Consumes: `g.llmFn`, `g.flagFn`, `pickModel`, `memvault.NoteWithBody`.
- Produces:
  - `func parseClusters(raw string) [][]string`
  - `func dedupCorpus(notes []memvault.NoteWithBody) string`
  - `func noteSetFingerprint(notes []memvault.NoteWithBody) string`
  - `func (g *gardener) checkDedup(hubDir string, notes []memvault.NoteWithBody)`
  - package-level `lastDedupCheck map[string]string` (hubDir → note-set fingerprint), mutex-guarded.

- [ ] **Step 1: Write the failing test**

```go
package memgarden

import (
	"testing"

	"github.com/wavetermdev/waveterm/pkg/memvault"
)

func TestParseClusters(t *testing.T) {
	got := parseClusters(`x {"clusters": [["a","b"], ["c","d","e"]]} y`)
	if len(got) != 2 || len(got[0]) != 2 || len(got[1]) != 3 {
		t.Fatalf("bad clusters: %v", got)
	}
	if len(parseClusters("nope")) != 0 {
		t.Fatalf("unparseable -> empty")
	}
}

func TestCheckDedupFlagsNonCanonicalAndGates(t *testing.T) {
	lastDedupCheck = map[string]string{}
	notes := []memvault.NoteWithBody{
		{Note: memvault.Note{ID: "a", Path: "/h/a.md"}, Body: "the tsc gotcha"},
		{Note: memvault.Note{ID: "b", Path: "/h/b.md"}, Body: "the tsc overflow gotcha"},
		{Note: memvault.Note{ID: "c", Path: "/h/c.md"}, Body: "unrelated"},
	}
	var calls int
	flagged := map[string]bool{}
	g := newGardener()
	g.hubNotesFn = func(string) []memvault.NoteWithBody { return notes }
	g.llmFn = func(model, prompt, corpus string) (string, bool) {
		calls++
		return `{"clusters": [["a","b"]]}`, true
	}
	g.flagFn = func(path, reason string) error {
		if reason == "duplicate" {
			flagged[path] = true
		}
		return nil
	}
	g.checkDedup("/h", notes)
	if calls != 1 {
		t.Fatalf("want 1 dedup call, got %d", calls)
	}
	if flagged["/h/a.md"] { // first in the cluster is canonical -> not flagged
		t.Fatalf("canonical note a should not be flagged")
	}
	if !flagged["/h/b.md"] {
		t.Fatalf("near-dup b should be flagged duplicate")
	}
	g.checkDedup("/h", notes) // note set unchanged -> gated
	if calls != 1 {
		t.Fatalf("dedup gate failed: got %d calls", calls)
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `go test ./pkg/memgarden/ -run "TestParseClusters|TestCheckDedup" -v`
Expected: FAIL — `undefined: parseClusters`.

- [ ] **Step 3: Write `dedup.go`**

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Dedup: surface semantic near-duplicate notes for human-confirmed merge. Flag-only (never auto-merged
// or archived) because exact-content dups are already blocked at write time (existingHashes) and
// judgment-heavy near-dups are too risky to auto-merge. One LLM cluster call per project, gated by an
// in-memory note-set fingerprint. See docs/superpowers/specs/2026-07-20-memory-relevance-gardener-design.md.
package memgarden

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"sort"
	"strings"
	"sync"

	"github.com/wavetermdev/waveterm/pkg/memvault"
)

const dedupPrompt = "You are finding semantic near-duplicate project memory notes. Input: a list of " +
	"notes as `slug: first line`. Group notes that say essentially the same thing (near-duplicates), " +
	`ignoring notes that are merely related. Output ONLY JSON: {"clusters": [["slugA","slugB"], ...]}. ` +
	"Only include clusters of 2+ genuinely redundant notes. If none, return {\"clusters\": []}."

var (
	lastDedupCheckMu sync.Mutex
	lastDedupCheck   = map[string]string{}
)

// parseClusters extracts {"clusters":[[...],...]} from an LLM response. Fail-safe: empty on any problem.
func parseClusters(raw string) [][]string {
	i := strings.IndexByte(raw, '{')
	j := strings.LastIndexByte(raw, '}')
	if i < 0 || j <= i {
		return nil
	}
	var v struct {
		Clusters [][]string `json:"clusters"`
	}
	if json.Unmarshal([]byte(raw[i:j+1]), &v) != nil {
		return nil
	}
	return v.Clusters
}

// dedupCorpus renders `slug: first line` for each note.
func dedupCorpus(notes []memvault.NoteWithBody) string {
	var b strings.Builder
	for _, n := range notes {
		fmt.Fprintf(&b, "%s: %s\n", n.Note.ID, firstLine(n.Body))
	}
	return b.String()
}

// firstLine is the first non-empty trimmed line of a body.
func firstLine(body string) string {
	for _, l := range strings.Split(body, "\n") {
		if t := strings.TrimSpace(l); t != "" {
			return t
		}
	}
	return ""
}

// noteSetFingerprint hashes the sorted (id:mtime) set so dedup re-runs only when a note is added,
// removed, or changed.
func noteSetFingerprint(notes []memvault.NoteWithBody) string {
	parts := make([]string, 0, len(notes))
	for _, n := range notes {
		parts = append(parts, fmt.Sprintf("%s:%d", n.Note.ID, n.Note.UpdatedTs))
	}
	sort.Strings(parts)
	sum := sha256.Sum256([]byte(strings.Join(parts, "|")))
	return hex.EncodeToString(sum[:])
}

// checkDedup flags every non-canonical note in each near-dup cluster (the first slug is canonical).
// Gated by the note-set fingerprint. Notes already flagged are re-flagged idempotently.
func (g *gardener) checkDedup(hubDir string, notes []memvault.NoteWithBody) {
	if len(notes) < 2 {
		return
	}
	fp := noteSetFingerprint(notes)
	lastDedupCheckMu.Lock()
	unchanged := lastDedupCheck[hubDir] == fp
	lastDedupCheckMu.Unlock()
	if unchanged {
		return
	}
	corpus := dedupCorpus(notes)
	raw, ok := g.llmFn(pickModel(corpus), dedupPrompt, corpus)
	if !ok {
		return // retain state, retry next sweep
	}
	lastDedupCheckMu.Lock()
	lastDedupCheck[hubDir] = fp
	lastDedupCheckMu.Unlock()

	pathByID := map[string]string{}
	for _, n := range notes {
		pathByID[n.Note.ID] = n.Note.Path
	}
	for _, cluster := range parseClusters(raw) {
		for i, slug := range cluster {
			if i == 0 {
				continue // keep the first as canonical
			}
			if p := pathByID[slug]; p != "" {
				if err := g.flagFn(p, "duplicate"); err != nil {
					log.Printf("[memgarden] flag duplicate %s: %v\n", p, err)
				}
			}
		}
	}
}
```

- [ ] **Step 4: Wire dedup into `runLLMPillars`**

In `pkg/memgarden/gardener.go`:

```go
func (g *gardener) runLLMPillars(hubDir string, notes []memvault.NoteWithBody, repoPath string) {
	g.checkSoftDrift(repoPath, notes)
	g.checkDedup(hubDir, notes)
}
```

- [ ] **Step 5: Run the full memgarden suite to verify it passes**

Run: `go test ./pkg/memgarden/ -v`
Expected: PASS. (The deterministic gardener tests use `hubNotesFn` returning ≤3 notes with no live refs; `checkDedup` will call the test's `g.llmFn`. In `TestGardenProjectDeterministic`/`TestGardenProjectRespectsArchiveCap`, set `g.llmFn = func(string, string, string) (string, bool) { return "", false }` so dedup no-ops and asserts stay exact.)

- [ ] **Step 6: Adjust the two deterministic tests if needed**

In `pkg/memgarden/gardener_test.go`, add to `TestGardenProjectDeterministic` and `TestGardenProjectRespectsArchiveCap`:

```go
	g.llmFn = func(string, string, string) (string, bool) { return "", false } // keep LLM pillars inert here
```

Re-run: `go test ./pkg/memgarden/ -v` → PASS.

- [ ] **Step 7: Stage**

Run: `git add pkg/memgarden/dedup.go pkg/memgarden/dedup_test.go pkg/memgarden/gardener.go pkg/memgarden/gardener_test.go`

---

## Task 13: RPC surface — MemoryArchiveList + MemoryRestore

Two client-invoked RPCs for the Archived view. Recall extraction + auto-archive stay internal (Task 2 + the sweep). Follows the existing memory-command pattern (`wshserver_memory.go`).

**Files:**
- Modify: `pkg/wshrpc/wshrpctypes_memory.go` (interface + data types)
- Modify: `pkg/wshrpc/wshrpctypes.go` (add `MemoryArchivedNote` wire type near `MemoryPruneCandidate`, ~line 414)
- Modify: `pkg/wshrpc/wshserver/wshserver_memory.go` (implement both)

**Interfaces:**
- Produces (Go interface):
  - `MemoryArchiveListCommand(ctx context.Context) (*CommandMemoryArchiveListRtnData, error)`
  - `MemoryRestoreCommand(ctx context.Context, data CommandMemoryRestoreData) error`
- Wire types: `MemoryArchivedNote{ID,Title,Reason,ArchivedAt,Path,OriginHub}`; `CommandMemoryArchiveListRtnData{Archived []MemoryArchivedNote}`; `CommandMemoryRestoreData{Path string}`.

- [ ] **Step 1: Add the wire type**

In `pkg/wshrpc/wshrpctypes.go`, after `MemoryPruneCandidate` (line 414):

```go
type MemoryArchivedNote struct {
	ID         string `json:"id"`
	Title      string `json:"title"`
	Reason     string `json:"reason"`     // decay | drift
	ArchivedAt string `json:"archivedat"` // RFC3339
	Path       string `json:"path"`       // path inside the archive dir (Restore target)
	OriginHub  string `json:"originhub"`
}
```

- [ ] **Step 2: Add the interface methods + data types**

In `pkg/wshrpc/wshrpctypes_memory.go`, add to the `MemoryCommands` interface (after `MemoryPruneListCommand`):

```go
	MemoryArchiveListCommand(ctx context.Context) (*CommandMemoryArchiveListRtnData, error)
	MemoryRestoreCommand(ctx context.Context, data CommandMemoryRestoreData) error
```

And at the bottom of the file:

```go
type CommandMemoryArchiveListRtnData struct {
	Archived []MemoryArchivedNote `json:"archived"`
}

type CommandMemoryRestoreData struct {
	Path string `json:"path"`
}
```

- [ ] **Step 3: Implement in the server**

In `pkg/wshrpc/wshserver/wshserver_memory.go`, append:

```go
func (ws *WshServer) MemoryArchiveListCommand(ctx context.Context) (*wshrpc.CommandMemoryArchiveListRtnData, error) {
	ans := memvault.ListArchived()
	out := make([]wshrpc.MemoryArchivedNote, len(ans))
	for i, a := range ans {
		out[i] = wshrpc.MemoryArchivedNote{
			ID: a.ID, Title: a.Title, Reason: a.Reason, ArchivedAt: a.ArchivedAt, Path: a.Path, OriginHub: a.OriginHub,
		}
	}
	return &wshrpc.CommandMemoryArchiveListRtnData{Archived: out}, nil
}

func (ws *WshServer) MemoryRestoreCommand(ctx context.Context, data wshrpc.CommandMemoryRestoreData) error {
	if _, err := memvault.Restore(data.Path); err != nil {
		return fmt.Errorf("restoring archived note: %w", err)
	}
	return nil
}
```

- [ ] **Step 4: Verify the backend builds (interface satisfied)**

Run: `go build ./pkg/wshrpc/... ./cmd/server/`
Expected: exit 0. (If it fails with "does not implement MemoryCommands", a method signature is off — fix to match the interface exactly.)

- [ ] **Step 5: Stage**

Run: `git add pkg/wshrpc/wshrpctypes_memory.go pkg/wshrpc/wshrpctypes.go pkg/wshrpc/wshserver/wshserver_memory.go`

---

## Task 14: Regenerate bindings + typecheck

Regenerate the typed client + TS types from the Go source (never hand-edit generated files), then confirm the frontend baseline is still clean.

**Files:**
- Generated (do not hand-edit): `pkg/wshrpc/wshclient/wshclient.go`, `frontend/app/store/wshclientapi.ts`, `frontend/types/gotypes.d.ts`, config schema.

- [ ] **Step 1: Regenerate**

Run: `task generate`
Expected: exit 0. (If it errors, the earlier tsgen drift guards catch Go/TS wave-event mismatches — but this change adds no wave events, so a failure means a malformed type. Fix the Go type and re-run.)

- [ ] **Step 2: Confirm the new client methods generated**

Run: `grep -c "MemoryArchiveListCommand\|MemoryRestoreCommand" pkg/wshrpc/wshclient/wshclient.go`
Expected: `2` or more.

Run: `grep -c "MemoryArchiveListCommand\|MemoryRestoreCommand" frontend/app/store/wshclientapi.ts`
Expected: `2` or more.

- [ ] **Step 3: Confirm the generated TS type exists**

Run: `grep -c "MemoryArchivedNote" frontend/types/gotypes.d.ts`
Expected: `1` or more.

- [ ] **Step 4: Typecheck the frontend (tsc overflow workaround)**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0 (clean baseline; any error is from this change).

- [ ] **Step 5: Stage the generated files**

Run: `git add pkg/wshrpc/wshclient/wshclient.go frontend/app/store/wshclientapi.ts frontend/types/gotypes.d.ts frontend/app/store/services.ts pkg/wconfig/`

> Only stage generated files that actually changed (`git status` to confirm). Do not hand-edit any of them.

---

## Task 15: Frontend memstore — archived atoms + loaders

Add the archived list state, a loader, a restore action (rescans so the note reappears in the graph/list), and a pure `sortArchived` helper (unit-tested).

**Files:**
- Modify: `frontend/app/view/agents/memstore.ts`
- Test: `frontend/app/view/agents/memstore.test.ts` (create if absent, else extend)

**Interfaces:**
- Consumes generated: `RpcApi.MemoryArchiveListCommand`, `RpcApi.MemoryRestoreCommand`; ambient `MemoryArchivedNote`.
- Produces:
  - `memArchivedAtom: PrimitiveAtom<MemoryArchivedNote[]>`
  - `async function loadArchived(): Promise<void>`
  - `async function restoreArchived(path: string): Promise<void>`
  - `function sortArchived(items: MemoryArchivedNote[]): MemoryArchivedNote[]` (newest `archivedat` first; pure)

- [ ] **Step 1: Write the failing test**

Create/extend `frontend/app/view/agents/memstore.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { sortArchived } from "./memstore";

describe("sortArchived", () => {
    it("orders newest archivedat first and does not mutate input", () => {
        const input = [
            { id: "a", title: "A", reason: "decay", archivedat: "2026-07-01T00:00:00Z", path: "/x/a", originhub: "/h" },
            { id: "b", title: "B", reason: "drift", archivedat: "2026-07-19T00:00:00Z", path: "/x/b", originhub: "/h" },
        ] as MemoryArchivedNote[];
        const out = sortArchived(input);
        expect(out.map((n) => n.id)).toEqual(["b", "a"]);
        expect(input[0].id).toBe("a"); // input untouched
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run frontend/app/view/agents/memstore.test.ts`
Expected: FAIL — `sortArchived` is not exported.

- [ ] **Step 3: Add the atoms, loaders, and helper**

Append to `frontend/app/view/agents/memstore.ts` (mirrors `memPruneAtom`/`loadPrune`; `MemoryArchivedNote` is an ambient generated type):

```ts
// Archived view: notes the gardener auto-archived (recoverable). MemoryArchivedNote is an ambient
// generated wire type (frontend/types/gotypes.d.ts).
export const memArchivedAtom = atom<MemoryArchivedNote[]>([]) as PrimitiveAtom<MemoryArchivedNote[]>;

// Newest archivedat first. Pure so it unit-tests without RPC.
export function sortArchived(items: MemoryArchivedNote[]): MemoryArchivedNote[] {
    return [...items].sort((a, b) => (a.archivedat < b.archivedat ? 1 : a.archivedat > b.archivedat ? -1 : 0));
}

export async function loadArchived(): Promise<void> {
    try {
        const r = await RpcApi.MemoryArchiveListCommand(TabRpcClient, { timeout: MEM_RPC_TIMEOUT_MS });
        globalStore.set(memArchivedAtom, sortArchived(r.archived ?? []));
    } catch {
        globalStore.set(memArchivedAtom, []);
    }
}

// Restore moves an archived note back to its hub; rescan so it reappears in the list/graph.
export async function restoreArchived(path: string): Promise<void> {
    await RpcApi.MemoryRestoreCommand(TabRpcClient, { path });
    globalStore.set(memReflowAnimatedAtom, true);
    await Promise.all([loadArchived(), loadMemory()]);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run frontend/app/view/agents/memstore.test.ts`
Expected: PASS.

- [ ] **Step 5: Stage**

Run: `git add frontend/app/view/agents/memstore.ts frontend/app/view/agents/memstore.test.ts`

---

## Task 16: Frontend ArchivedView + wire into MemorySurface

A collapsible archived section (mirrors `CleanupQueue`), each row showing reason + relative age and a one-click Restore. Load archived on mount. The cleanup queue already renders `c.reason` verbatim, so the new `drift`/`duplicate` reasons surface with no change there.

**Files:**
- Create: `frontend/app/view/agents/archivedview.tsx`
- Modify: `frontend/app/view/agents/memorysurface.tsx` (import + render + load-on-mount)

**Interfaces:**
- Consumes: `memArchivedAtom`, `restoreArchived`, `loadArchived` (Task 15); `relativeAge` (`memtypes.ts:62`).

- [ ] **Step 1: Create the component**

Create `frontend/app/view/agents/archivedview.tsx` (mirror `cleanupqueue.tsx`; hidden when empty):

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Archived view: notes the gardener auto-archived (decay / drift). Recoverable with one click — this
// is the reversibility surface for the gardener's automatic actions. Hidden when empty.

import { useAtomValue } from "jotai";
import { useState } from "react";
import { ChevronDown, ChevronRight, Undo2 } from "lucide-react";
import { fireAndForget } from "@/util/util";
import { relativeAge } from "./memtypes";
import { memArchivedAtom, restoreArchived } from "./memstore";

export function ArchivedView() {
    const archived = useAtomValue(memArchivedAtom);
    const [open, setOpen] = useState(false);
    if (archived.length === 0) return null;
    return (
        <div className="border-b border-edge-faint px-[12px] py-[8px]">
            <button
                className="flex items-center gap-[6px] text-[11px] font-mono uppercase tracking-wide text-ink-mid"
                onClick={() => setOpen((v) => !v)}
            >
                {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                {archived.length} archived
            </button>
            {open && (
                <ul className="mt-[6px] flex flex-col gap-[4px]">
                    {archived.map((a) => (
                        <li key={a.path} className="flex items-center gap-[8px] rounded-sm bg-surface/60 px-[8px] py-[6px]">
                            <span className="min-w-0 flex-1 truncate text-[12px] text-ink-high">{a.title || a.id}</span>
                            <span className="shrink-0 text-[10px] font-mono uppercase text-ink-mid">{a.reason}</span>
                            <span className="shrink-0 text-[10px] text-ink-faint">{relativeAge(a.archivedat)}</span>
                            <button title="Restore" className="text-ink-mid hover:text-accent" onClick={() => fireAndForget(() => restoreArchived(a.path))}>
                                <Undo2 size={14} />
                            </button>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}
```

- [ ] **Step 2: Wire into `memorysurface.tsx`**

Add the import alongside the `CleanupQueue` import (line 25):

```tsx
import { ArchivedView } from "./archivedview";
```

Add `loadArchived` and `memArchivedAtom` (if referenced) to the existing `memstore` import block (lines 29-52) — add `loadArchived,` to the import list.

Render `<ArchivedView />` immediately after `<CleanupQueue />` (line 571):

```tsx
                    <CleanupQueue />
                    <ArchivedView />
```

Load archived on mount, in the effect that already calls `loadMemory`/`loadReview`/`loadPrune` (lines 541-545):

```tsx
    useEffect(() => {
        fireAndForget(() => loadMemory());
        fireAndForget(() => loadReview());
        fireAndForget(() => loadPrune());
        fireAndForget(() => loadArchived());
    }, [vaultPath]);
```

- [ ] **Step 3: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 4: Lint the two touched files (Prettier check only; do not auto-format .mjs)**

Run: `npx prettier --check frontend/app/view/agents/archivedview.tsx frontend/app/view/agents/memorysurface.tsx`
Expected: pass, or fix reported files with `npx prettier --write` on **those two files only**.

- [ ] **Step 5: Stage**

Run: `git add frontend/app/view/agents/archivedview.tsx frontend/app/view/agents/memorysurface.tsx`

---

## Task 17: Final integration verification + commit

Full-suite verification across the three layers, then a single commit (pending explicit approval) that folds in the spec + this plan.

- [ ] **Step 1: Run the full Go suite for touched packages**

Run: `go test ./pkg/memvault/ ./pkg/memgarden/ ./pkg/memdistill/ ./pkg/wshrpc/... ./pkg/wconfig/`
Expected: PASS (no failures, no build errors).

- [ ] **Step 2: Build the backend end-to-end**

Run: `go build ./cmd/server/ ./cmd/wsh/`
Expected: exit 0.

- [ ] **Step 3: Frontend tests + typecheck**

Run: `npx vitest run frontend/app/view/agents/memstore.test.ts`
Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: both PASS / exit 0.

- [ ] **Step 4: Optional live smoke (CDP) — deterministic pillars only**

If a dev app is running (`task dev`), inject an old machine note into a hub, force a sweep interval, and confirm it lands in the Archived view with a working Restore. Skip if no dev app is up; do not block the commit on it. (See `docs/agents/` + `scripts/cdp-shot.mjs`.)

- [ ] **Step 5: Self-review the diff**

Run: `git status && git diff --cached --stat`
Confirm: no generated files hand-edited; no debug prints beyond the intentional `[memgarden]` action log; no commented-out code; the spec + this plan are staged.

- [ ] **Step 6: Commit (ONLY after explicit user approval)**

Per CLAUDE.md, do not commit without approval. When approved, stage the spec + plan and commit once:

Run: `git add docs/superpowers/specs/2026-07-20-memory-relevance-gardener-design.md docs/superpowers/plans/2026-07-20-memory-relevance-gardener.md`
Run (message via temp file to avoid Windows quoting issues — no here-strings):

```
git commit -F <path-to-temp-message-file>
```

Suggested message:

```
feat(memory): relevance gardener — recall telemetry + reversible decay/freshness/dedup

Adds real recall telemetry (SessionEnd transcript parse -> last_referenced) and a
reversible gardener loop on the memdistill coordinator's single ticker: auto-archives
provably-unused machine notes and dead-ref notes (deterministic, per-pass capped),
flags soft-drift + near-dup into the existing cleanup queue. Archive is a recoverable
move with one-click Restore in the Memory tab; archived source_hashes join the
distiller dedup set so gardener and distiller don't fight.
```

---

## Self-Review (plan author — completed)

**Spec coverage:**
- §1 Architecture (two seams, no new scheduler) → Tasks 2 (SessionEnd recall), 9-10 (sweep on coordinator ticker via hook). New packages/files match the spec's file list (adjusted: `prune.go`/`learn.go`/`harvest.go` live in `pkg/memvault`, not `pkg/memdistill` as the spec prose says — verified against the tree).
- §2 Real recall telemetry → Tasks 1-2 (`ParseRecalledSlugs`, `RecordRecall`, wired into `MemoryEnqueueSessionCommand`, superseding the distiller `references` guess).
- §3 Archive primitive (move, `archived_*`, `source_hash` joins dedup set, Restore) → Tasks 3-4.
- §4 Three pillars table → decay (Task 7/9), dead-ref auto (Task 8/9), soft-drift flag (Task 11), near-dup flag (Task 12). Human notes flag-only for decay (Task 7). Dedup flag-only (Task 12).
- §5 Auto-with-archive posture + per-pass cap + machine-only auto → Task 9 (`maxArchivesPerPass`, `isMachine` gating).
- §6 Cost guards (haiku/sonnet, mtime-gating, 0-token deterministic pillars) → Tasks 9 (`pickModel`), 11-12 (in-memory mtime/note-set fingerprints).
- §7 Error handling (fail-safe, single-flight, reversible, logged) → panic handlers + single-flight (Tasks 9-10), action log (`[memgarden]`), archive reversibility.
- §8 UI (Archived view + Restore; flagged items reuse cleanup queue) → Tasks 15-16; cleanup queue renders new reasons verbatim (Task 5 surfaces them).
- §9 Data model + RPC (`archived_at`/`archived_reason`, `MemoryArchiveList`, `MemoryRestore`, recall internal) → Tasks 3, 13-14.

**Placeholder scan:** No "TBD"/"handle edge cases"/"similar to Task N"; every code step shows complete code. The one deliberate seam (`runLLMPillars` no-op in Task 9) is filled with real code in Tasks 11-12, and Task 9's inert `runGardenLLM` is explicitly replaced — not left as a placeholder.

**Type consistency:** `DecayAction`, `ArchivedNote`/`MemoryArchivedNote`, `GardenerFlag`, `gardener` struct fields (`hubNotesFn`, `archiveFn`, `flagFn`, `repoPathFn`, `repoIndexFn`, `hubDirsFn`, `gardenFn`, `llmFn`), and RPC names (`MemoryArchiveListCommand`, `MemoryRestoreCommand`) are used identically across tasks. `Note.GardenerFlag` (Task 5) matches `classifyDecay`/`checkSoftDrift`/`checkDedup` reads.

**Known v1 limitations (documented, not defects):** dead-ref + soft-drift only run for registry-resolvable projects (`RepoPathForHubDir` != ""); decay + dedup run on every hub. LLM mtime gates are in-memory, so a server restart triggers one re-check pass (bounded by the per-pass cap). Cross-project archive dedup is global by `source_hash` (per spec §3).
