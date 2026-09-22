# Memory utilization: measurable signal, no silent losses

**Effort:** effort:8ebb62f7-ff00-42dd-bc6d-834b0f9fffe1
**Verify:** `CGO_CFLAGS="-O2 -g -I$(pwd -W)/pkg/jarvisembed/csrc" go test ./pkg/memvault/... ./pkg/memgarden/... ./pkg/memroots/... ./pkg/jarvisrecall/... ./pkg/wshrpc/... ./cmd/wsh/... && npx vitest run`
**Setup:** `task worktree:prepare`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit && CGO_CFLAGS="-O2 -g -I$(pwd -W)/pkg/jarvisembed/csrc" go vet ./pkg/memvault/... ./pkg/memgarden/... ./pkg/jarvisrecall/... ./cmd/wsh/...`

**Spec:** `docs/superpowers/specs/2026-09-22-memory-utilization-design.md`

**Goal:** make memory utilization a signal that can actually fire, stop the decay predicate archiving
on its absence, restore what it already took, and deliver the reach and cost fixes that hang off the
same measurement.

**Architecture:** utilization lives in the note's own frontmatter (`last_referenced` +
`reference_count`), written by Jarvis recall as well as the existing Claude transcript telemetry. A
recorded *epoch* — the first boot with instrumentation — lets `classifyDecay` tell "measured as
unused" apart from "never measured". Data repairs ride the existing boot-migration and gardener-sweep
patterns rather than one-off scripts, except the 2026-09-22 vault-merge residue, which is genuinely a
one-time correction on one machine.

## Global constraints

- **Never hand-edit generated files.** Go is the source of truth. Task 4 and Task 6 change the wshrpc
  interface and must run `task generate` (rewrites `frontend/app/store/wshclientapi.ts`,
  `frontend/app/store/services.ts`, `frontend/types/gotypes.d.ts`,
  `pkg/wshrpc/wshclient/wshclient.go`). Task 6 depends on Task 4 for exactly this reason — two
  branches regenerating the same three files collide on merge.
- **`memvault.Note` is NOT the wire type.** `wshrpc.MemoryNote` mirrors it. Adding a field to
  `memvault.Note` alone requires no regeneration; do not add `ReferenceCount` to `wshrpc.MemoryNote`.
- **Colors come from `@theme` tokens**, never raw hex (Task 7 deletes UI only, but the rule stands).
- `npx tsc` stack-overflows on this repo — always `node --stack-size=4000 node_modules/typescript/lib/tsc.js`.
  Do not run `task check:ts` inside a worktree: it npm-installs for real and destroys the
  `node_modules` junction.
- Never run `prettier --write` on the tree; HEAD is not formatter-clean. Check only files you touched.
- Commit messages: `type(scope): description`, subject < 72 chars. **No attribution trailers** —
  no `Co-Authored-By`, no `Claude-Session`.

---

### Task 1: Reference count, mtime-preserving stamp, and the recall epoch

**Depends on:** none

**Files:**
- Modify: `pkg/memvault/memvault.go` (`Note` struct, `frontmatter` struct, `parseNote`)
- Modify: `pkg/memvault/learn.go` (`TouchReferenced`, new `stampReference`, new `TouchReferencedByID`)
- Modify: `pkg/memvault/archive.go` (`ArchiveDir` becomes a var)
- Create: `pkg/memvault/recallepoch.go`
- Create: `pkg/memvault/recallepoch_test.go`
- Modify: `pkg/memvault/learn_test.go`
- Modify: `cmd/server/main-server.go` (one line in the existing sweep hook)

**Interfaces — Produces:**
- `memvault.Note.ReferenceCount int` (json `referencecount`, yaml `metadata.reference_count`)
- `func memvault.TouchReferencedByID(ids []string, ts string) error`
- `func memvault.EnsureRecallEpoch(now time.Time) time.Time`
- `func memvault.RecallEpoch() time.Time` — zero time when absent/empty/unparseable
- `memvault.ArchiveDir` as a redirectable var, so Task 3 and Task 5 can both write hermetic tests
  without either of them owning the edit (two lanes changing one line would collide on merge)

- [ ] **Step 1: Write the failing tests**

Append to `pkg/memvault/learn_test.go`:

```go
func TestTouchReferencedIncrementsAndPreservesMtime(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "n1.md")
	content := "---\nname: n1\nmetadata:\n  type: learning\n---\n\nbody\n"
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	// a stable, clearly-in-the-past mtime so a bump is unmistakable
	base := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	if err := os.Chtimes(path, base, base); err != nil {
		t.Fatal(err)
	}

	if err := TouchReferenced(dir, []string{"n1"}, "2026-09-22T10:00:00Z"); err != nil {
		t.Fatalf("TouchReferenced: %v", err)
	}
	nw, err := ReadNote(path, "vault")
	if err != nil {
		t.Fatal(err)
	}
	if nw.Note.LastReferenced != "2026-09-22T10:00:00Z" {
		t.Fatalf("last_referenced = %q, want the stamped ts", nw.Note.LastReferenced)
	}
	if nw.Note.ReferenceCount != 1 {
		t.Fatalf("reference_count = %d, want 1", nw.Note.ReferenceCount)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if !info.ModTime().UTC().Equal(base) {
		t.Fatalf("mtime = %v, want it preserved at %v (a recall is a read, not an edit)", info.ModTime().UTC(), base)
	}

	// second touch increments rather than resetting
	if err := TouchReferenced(dir, []string{"n1"}, "2026-09-23T10:00:00Z"); err != nil {
		t.Fatalf("second TouchReferenced: %v", err)
	}
	nw, err = ReadNote(path, "vault")
	if err != nil {
		t.Fatal(err)
	}
	if nw.Note.ReferenceCount != 2 {
		t.Fatalf("reference_count after second touch = %d, want 2", nw.Note.ReferenceCount)
	}
}

func TestTouchReferencedMissingNoteIsNotAnError(t *testing.T) {
	if err := TouchReferenced(t.TempDir(), []string{"absent"}, "2026-09-22T10:00:00Z"); err != nil {
		t.Fatalf("missing note must be fail-safe, got %v", err)
	}
}
```

Create `pkg/memvault/recallepoch_test.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package memvault

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// withEpochFile points epochFile at a temp dir for the duration of the test.
func withEpochFile(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	old := epochFile
	epochFile = func() string { return filepath.Join(dir, "memory-recall-epoch.txt") }
	t.Cleanup(func() { epochFile = old })
	return filepath.Join(dir, "memory-recall-epoch.txt")
}

func TestEnsureRecallEpochWritesOnce(t *testing.T) {
	withEpochFile(t)
	first := time.Date(2026, 9, 22, 12, 0, 0, 0, time.UTC)
	if got := EnsureRecallEpoch(first); !got.Equal(first) {
		t.Fatalf("first EnsureRecallEpoch = %v, want %v", got, first)
	}
	later := first.Add(48 * time.Hour)
	if got := EnsureRecallEpoch(later); !got.Equal(first) {
		t.Fatalf("second EnsureRecallEpoch = %v, want the original %v (the epoch must not move)", got, first)
	}
	if got := RecallEpoch(); !got.Equal(first) {
		t.Fatalf("RecallEpoch = %v, want %v", got, first)
	}
}

func TestRecallEpochAbsentOrMalformedIsZero(t *testing.T) {
	path := withEpochFile(t)
	if got := RecallEpoch(); !got.IsZero() {
		t.Fatalf("absent epoch = %v, want zero (an unreadable epoch must never authorize an archive)", got)
	}
	if err := os.WriteFile(path, []byte("not-a-timestamp"), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := RecallEpoch(); !got.IsZero() {
		t.Fatalf("malformed epoch = %v, want zero", got)
	}
}

func TestTouchReferencedByIDTargetsTheVault(t *testing.T) {
	dir := t.TempDir()
	old := DefaultVaultPath
	DefaultVaultPath = func() string { return dir }
	t.Cleanup(func() { DefaultVaultPath = old })

	path := filepath.Join(dir, "known.md")
	if err := os.WriteFile(path, []byte("---\nname: known\nmetadata:\n  type: learning\n---\n\nbody\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := TouchReferencedByID([]string{"known", "unknown"}, "2026-09-22T10:00:00Z"); err != nil {
		t.Fatalf("TouchReferencedByID: %v", err)
	}
	nw, err := ReadNote(path, "vault")
	if err != nil {
		t.Fatal(err)
	}
	if nw.Note.ReferenceCount != 1 {
		t.Fatalf("reference_count = %d, want 1", nw.Note.ReferenceCount)
	}
}
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `CGO_CFLAGS="-O2 -g -I$(pwd -W)/pkg/jarvisembed/csrc" go test ./pkg/memvault/ -run 'TouchReferenced|RecallEpoch' -v`
Expected: FAIL to compile — `undefined: epochFile`, `undefined: EnsureRecallEpoch`, `undefined: RecallEpoch`, `undefined: TouchReferencedByID`, and `nw.Note.ReferenceCount` undefined.

- [ ] **Step 3: Add `ReferenceCount` to the note model**

In `pkg/memvault/memvault.go`, in the `Note` struct, directly after the `LastReferenced` field:

```go
	ReferenceCount int    `json:"referencecount"` // metadata.reference_count: times recall surfaced this note
```

In the `frontmatter` struct's `Metadata` block, directly after `LastReferenced`:

```go
		ReferenceCount int    `yaml:"reference_count"`
```

In `parseNote`, directly after `n.LastReferenced = fm.Metadata.LastReferenced`:

```go
				n.ReferenceCount = fm.Metadata.ReferenceCount
```

Do **not** add the field to `wshrpc.MemoryNote` — the UI does not read it, and touching the wire type
would force a regeneration this task must not do.

- [ ] **Step 4: Make the stamp count and preserve mtime**

In `pkg/memvault/learn.go`, replace `TouchReferenced` with:

```go
// TouchReferenced records ts as last_referenced on each named note and increments its
// reference_count. Missing notes are skipped, not an error — the caller is a recall, and a stale
// slug must never fail one.
func TouchReferenced(hubDir string, slugs []string, ts string) error {
	for _, s := range slugs {
		if err := stampReference(filepath.Join(hubDir, s+".md"), ts); err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	return nil
}

// stampReference writes last_referenced and the incremented reference_count in one pass, then
// restores the file's mtime. A recall is a read: letting it bump mtime would make UpdatedTs — the
// Memory list's sort key and decay's fallback age basis — report a content change that never
// happened, so every recalled note would look freshly edited.
func stampReference(path, ts string) error {
	info, err := os.Stat(path)
	if err != nil {
		return err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	n, _ := parseNote(path, data, "")
	out := setMetadataField(string(data), "last_referenced", yamlQuote(ts))
	out = setMetadataField(out, "reference_count", strconv.Itoa(n.ReferenceCount+1))
	if err := os.WriteFile(path, []byte(out), 0o644); err != nil {
		return err
	}
	return os.Chtimes(path, info.ModTime(), info.ModTime())
}

// TouchReferencedByID stamps vault notes by note id. Jarvis recall knows ids, not paths; a note's id
// and its filename slug are the same string (the hub fold preserves it), so this is TouchReferenced
// against the one write target.
func TouchReferencedByID(ids []string, ts string) error {
	return TouchReferencedByIDIn(DefaultVaultPath(), ids, ts)
}

// TouchReferencedByIDIn is the testable core: the same stamp against an explicit dir.
func TouchReferencedByIDIn(dir string, ids []string, ts string) error {
	return TouchReferenced(dir, ids, ts)
}
```

Add `"strconv"` to the import block in `pkg/memvault/learn.go`.

- [ ] **Step 5: Add the epoch**

Create `pkg/memvault/recallepoch.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The recall epoch: the instant this installation first ran with recall instrumentation. Before it,
// "never referenced" is the absence of a measurement, not evidence of disuse, and the gardener must
// not archive on it. See docs/superpowers/specs/2026-09-22-memory-utilization-design.md.
package memvault

import (
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/wavebase"
)

// epochFile is the marker's path, keyed to the profile's data dir so dev and prod age
// independently. Same pattern as memroots' last-root marker. A var so tests can redirect it.
var epochFile = func() string {
	dir := wavebase.GetWaveDataDir()
	if dir == "" {
		return "" // no data dir (tests / embedded): no epoch to record
	}
	return filepath.Join(dir, "memory-recall-epoch.txt")
}

// EnsureRecallEpoch records now as the epoch if none exists yet, and returns the epoch in force.
// Called once per boot by the memory sweep — not by the first stamp — so the clock starts even on an
// installation where nothing is ever recalled.
func EnsureRecallEpoch(now time.Time) time.Time {
	if t := RecallEpoch(); !t.IsZero() {
		return t
	}
	path := epochFile()
	if path == "" {
		return time.Time{}
	}
	if err := os.WriteFile(path, []byte(now.UTC().Format(time.RFC3339)), 0o644); err != nil {
		return time.Time{}
	}
	return now.UTC()
}

// RecallEpoch reads the recorded epoch. Absent, empty or unparseable returns the zero time, which
// every caller must read as "the signal is not yet mature": an unreadable epoch can never authorize
// an archive.
func RecallEpoch() time.Time {
	path := epochFile()
	if path == "" {
		return time.Time{}
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return time.Time{}
	}
	t, err := time.Parse(time.RFC3339, strings.TrimSpace(string(data)))
	if err != nil {
		return time.Time{}
	}
	return t
}
```

- [ ] **Step 6: Start the clock at boot**

In `cmd/server/main-server.go`, inside the existing sweep-hook closure that calls
`memroots.MigrateVaultToConfiguredRoot()` and `memvault.HarvestAll()`, add as the **first** statement
in the closure body:

```go
		memvault.EnsureRecallEpoch(time.Now())
```

`time` is already imported in that file; confirm before adding it.

- [ ] **Step 7: Make `ArchiveDir` redirectable**

Tasks 3 and 5 both need to point the archive at a temp dir to test hermetically — otherwise
`archivedHashes()` reads the real `~/.waveterm/memory-archive` (139 notes today) and an "unbacked"
fixture can read as backed. Making the change here means neither of those tasks owns it.

In `pkg/memvault/archive.go`, change the `ArchiveDir` declaration from a func to a var:

```go
// ArchiveDir is the recoverable removal store: a sibling of the vault + pending dirs, never scanned.
// A var so tests can point it at a temp dir.
var ArchiveDir = func() string {
	return filepath.Join(wavebase.GetHomeDir(), ".waveterm", "memory-archive")
}
```

Every existing call site is `ArchiveDir()` already and needs no change.

- [ ] **Step 8: Run the tests and verify they pass**

Run: `CGO_CFLAGS="-O2 -g -I$(pwd -W)/pkg/jarvisembed/csrc" go test ./pkg/memvault/ -run 'TouchReferenced|RecallEpoch' -v`
Expected: PASS, all five tests.

Then the whole package, to confirm the `Note` field and the `ArchiveDir` change did not disturb
existing tests:
Run: `CGO_CFLAGS="-O2 -g -I$(pwd -W)/pkg/jarvisembed/csrc" go test ./pkg/memvault/`
Expected: ok.

- [ ] **Step 9: Commit**

```bash
git add pkg/memvault/memvault.go pkg/memvault/learn.go pkg/memvault/learn_test.go pkg/memvault/archive.go pkg/memvault/recallepoch.go pkg/memvault/recallepoch_test.go cmd/server/main-server.go
git commit -m "feat(memvault): count references and record the recall epoch"
```

---

### Task 2: Jarvis recall stamps the notes it surfaces

**Depends on:** Task 1
**Chunk:** Instrument Jarvis recall so utilization is measurable

**Files:**
- Modify: `pkg/jarvisrecall/cards.go` (new `groundingCards`)
- Modify: `pkg/jarvisrecall/ask.go` (the `AskResult` return)
- Modify: `pkg/jarvisrecall/recall.go` (the `Converse` card build)
- Modify: `pkg/jarvisrecall/cards_test.go`

**Interfaces — Consumes:** `memvault.TouchReferencedByID(ids []string, ts string) error` (Task 1).

`buildCards` stays pure and stays tested as such. The stamping happens in a new wrapper both answer
paths call, so there is exactly one place where "these cards became an answer" is expressed.

- [ ] **Step 1: Write the failing test**

Append to `pkg/jarvisrecall/cards_test.go`:

```go
func TestGroundingCardsStampsOnlyMemoryTargets(t *testing.T) {
	var stamped []string
	old := stampReferences
	stampReferences = func(ids []string, ts string) error {
		stamped = append(stamped, ids...)
		return nil
	}
	t.Cleanup(func() { stampReferences = old })

	cands := []candidate{
		{sourceType: "memory", title: "A", navTarget: "memnote:note-a"},
		{sourceType: "run", title: "R", navTarget: "run:abc"},
		{sourceType: "memory", title: "B", navTarget: "memnote:note-b"},
	}
	cards := groundingCards(cands, 1000)
	if len(cards) != 3 {
		t.Fatalf("groundingCards returned %d cards, want 3 (stamping must not filter)", len(cards))
	}
	if len(stamped) != 2 || stamped[0] != "note-a" || stamped[1] != "note-b" {
		t.Fatalf("stamped = %v, want [note-a note-b]", stamped)
	}
}

func TestGroundingCardsStampFailureDoesNotBreakTheAnswer(t *testing.T) {
	old := stampReferences
	stampReferences = func(ids []string, ts string) error { return errors.New("disk full") }
	t.Cleanup(func() { stampReferences = old })

	cards := groundingCards([]candidate{{sourceType: "memory", navTarget: "memnote:x"}}, 1000)
	if len(cards) != 1 {
		t.Fatalf("a failed stamp must still return the answer's cards, got %d", len(cards))
	}
}
```

Add `"errors"` to the test file's imports.

- [ ] **Step 2: Run the test to verify it fails**

Run: `CGO_CFLAGS="-O2 -g -I$(pwd -W)/pkg/jarvisembed/csrc" go test ./pkg/jarvisrecall/ -run GroundingCards -v`
Expected: FAIL to compile — `undefined: stampReferences`, `undefined: groundingCards`.

- [ ] **Step 3: Add the stamping wrapper**

In `pkg/jarvisrecall/cards.go`, directly after `buildCards`:

```go
// stampReferences is the seam onto memvault's frontmatter stamp, so tests observe the call without
// a vault on disk.
var stampReferences = memvault.TouchReferencedByID

// memNotePrefix is the navTarget scheme memoryCandidate writes; the id follows it.
const memNotePrefix = "memnote:"

// groundingCards builds the answer's cards and records that recall surfaced each memory note in it.
// Utilization is defined as *surfaced as grounding*, not as cited in prose: grounding membership is
// deterministic and already computed here, whereas citation counting would make the measurement
// depend on how the model formatted its answer.
//
// The stamp is best-effort. A vault that cannot be written is a lost measurement, never a lost
// answer, so a failure is logged and the cards are returned regardless.
func groundingCards(cands []candidate, nowMs int64) []waveobj.JarvisConvoGroundingCard {
	cards := buildCards(cands, nowMs)
	var ids []string
	for _, c := range cands {
		if c.sourceType == "memory" && strings.HasPrefix(c.navTarget, memNotePrefix) {
			ids = append(ids, strings.TrimPrefix(c.navTarget, memNotePrefix))
		}
	}
	if len(ids) > 0 {
		if err := stampReferences(ids, time.Now().UTC().Format(time.RFC3339)); err != nil {
			log.Printf("[jarvisrecall] stamping %d recalled notes: %v\n", len(ids), err)
		}
	}
	return cards
}
```

Add `"log"` and `"time"` to `cards.go`'s imports if absent (`strings` and the `memvault` and
`waveobj` imports are already there).

- [ ] **Step 4: Route both answer paths through it**

In `pkg/jarvisrecall/ask.go`, in the final `return` of `Ask`, replace `buildCards(` with
`groundingCards(`:

```go
	return AskResult{Answer: prose, Grounding: groundingCards(cands, time.Now().UnixMilli()), Terminal: terminal}, runErr
```

In `pkg/jarvisrecall/recall.go`, in `Converse`, replace the card build:

```go
	cards := groundingCards(cands, time.Now().UnixMilli())
```

Leave both surrounding comments as they are — they describe `buildCards`' shared-object guarantee,
which still holds.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `CGO_CFLAGS="-O2 -g -I$(pwd -W)/pkg/jarvisembed/csrc" go test ./pkg/jarvisrecall/ -v`
Expected: PASS, including the pre-existing `buildCards` and `Converse` tests (the stamp seam
defaults to the real function, which no-ops against a temp/absent vault).

- [ ] **Step 6: Commit**

```bash
git add pkg/jarvisrecall/cards.go pkg/jarvisrecall/ask.go pkg/jarvisrecall/recall.go pkg/jarvisrecall/cards_test.go
git commit -m "feat(jarvisrecall): stamp the memory notes an answer was grounded in"
```

---

### Task 3: Decay stops archiving on an unfirable signal, and gives back the 67

**Depends on:** Task 1
**Chunk:** Fix the decay predicate so it cannot archive on an unfirable signal

**Files:**
- Modify: `pkg/memgarden/decay.go` (`classifyDecay` signature and predicate)
- Modify: `pkg/memgarden/gardener.go` (struct seam + call site)
- Modify: `pkg/memgarden/decay_test.go`
- Create: `pkg/memvault/restoredecay.go`
- Create: `pkg/memvault/restoredecay_test.go`
- Modify: `cmd/server/main-server.go` (one call in the existing sweep hook)

**Interfaces — Consumes:** `memvault.RecallEpoch() time.Time` (Task 1).
**Interfaces — Produces:** `func memvault.RestoreDecayArchive() (int, error)` — idempotent, guarded by
a marker file, safe to call on every boot.

Measured context this task exists for: 67 notes in `~/.waveterm/memory-archive` carry
`archived_reason: decay` and **none** carries a `last_referenced` stamp. Every one was archived on the
never-referenced branch, which no vault-only note could ever have escaped.

- [ ] **Step 1: Write the failing decay test**

Append to `pkg/memgarden/decay_test.go`:

```go
func TestClassifyDecayRespectsTheEpoch(t *testing.T) {
	now := time.Date(2026, 9, 22, 0, 0, 0, 0, time.UTC)
	oldCap := now.AddDate(0, 0, -40).Format(time.RFC3339)
	oldRef := now.AddDate(0, 0, -40).Format(time.RFC3339)

	machineNever := memvault.Note{ID: "m-never", Path: "/h/m1.md", Source: "agent", CapturedAt: oldCap}
	machineStale := memvault.Note{ID: "m-stale", Path: "/h/m2.md", Source: "codex", CapturedAt: oldCap, LastReferenced: oldRef}
	notes := []memvault.Note{machineNever, machineStale}

	byID := func(actions []DecayAction) map[string]DecayAction {
		out := map[string]DecayAction{}
		for _, a := range actions {
			out[a.NoteID] = a
		}
		return out
	}

	// no epoch recorded: never-referenced is not evidence, so it may only be flagged
	got := byID(classifyDecay(notes, now, 30, time.Time{}))
	if a, ok := got["m-never"]; !ok || a.Archive || a.Reason != "stale" {
		t.Fatalf("no epoch: m-never = %+v, want a non-archiving stale flag", a)
	}
	if a, ok := got["m-stale"]; !ok || !a.Archive {
		t.Fatalf("no epoch: m-stale = %+v, want archive (a real stamp went cold)", a)
	}

	// epoch newer than the cutoff: the signal has not had a full window to fire
	got = byID(classifyDecay(notes, now, 30, now.AddDate(0, 0, -5)))
	if a := got["m-never"]; a.Archive {
		t.Fatalf("immature epoch: m-never archived, want flag only")
	}

	// epoch older than the cutoff: the note was observable for a full window and never surfaced
	got = byID(classifyDecay(notes, now, 30, now.AddDate(0, 0, -60)))
	if a, ok := got["m-never"]; !ok || !a.Archive || a.Reason != "decay" {
		t.Fatalf("mature epoch: m-never = %+v, want archive/decay", a)
	}
}

func TestClassifyDecayNeverArchivesHumanNotes(t *testing.T) {
	now := time.Date(2026, 9, 22, 0, 0, 0, 0, time.UTC)
	oldCap := now.AddDate(0, 0, -40).Format(time.RFC3339)
	notes := []memvault.Note{{ID: "h", Path: "/h/h.md", Source: "vault", CapturedAt: oldCap}}
	for _, epoch := range []time.Time{{}, now.AddDate(0, 0, -60)} {
		for _, a := range classifyDecay(notes, now, 30, epoch) {
			if a.Archive {
				t.Fatalf("human note archived under epoch %v; human notes are flagged, never archived", epoch)
			}
		}
	}
}
```

The existing `TestClassifyDecay` calls `classifyDecay(notes, now, 30)`. Update that call to
`classifyDecay(notes, now, 30, now.AddDate(0, 0, -60))` — a mature epoch, which is the regime its
existing expectations were written for.

- [ ] **Step 2: Run the test to verify it fails**

Run: `CGO_CFLAGS="-O2 -g -I$(pwd -W)/pkg/jarvisembed/csrc" go test ./pkg/memgarden/ -run ClassifyDecay -v`
Expected: FAIL to compile — `too many arguments in call to classifyDecay`.

- [ ] **Step 3: Fix the predicate**

In `pkg/memgarden/decay.go`, replace `classifyDecay` with:

```go
// classifyDecay returns the decay actions for notes as of now. staleDays defines N. epoch is when
// recall instrumentation first ran on this installation; a zero epoch means the signal has never
// been able to fire.
//
// The rule the predicate exists to enforce: the absence of a measurement is not evidence of disuse.
// A never-referenced note is only archive-eligible once the signal itself has been alive for a full
// window — before that it is flagged into the cleanup queue, exactly like a human note.
func classifyDecay(notes []memvault.Note, now time.Time, staleDays int, epoch time.Time) []DecayAction {
	cutoff := now.AddDate(0, 0, -staleDays)
	signalMature := !epoch.IsZero() && epoch.Before(cutoff)
	var out []DecayAction
	for _, n := range notes {
		if n.SupersededBy != "" {
			continue // handled by the superseded queue
		}
		stamped := n.LastReferenced != ""
		unusedByRecall := (stamped && beforeCutoff(n.LastReferenced, cutoff)) ||
			(!stamped && signalMature)
		old := ageBeforeCutoff(n, cutoff)
		switch {
		case isMachine(n.Source) && unusedByRecall && old:
			out = append(out, DecayAction{NoteID: n.ID, Path: n.Path, Reason: "decay", Archive: true})
		case isMachine(n.Source) && !stamped && old:
			// the signal is not mature yet: surface the note for human judgment rather than removing it
			out = append(out, DecayAction{NoteID: n.ID, Path: n.Path, Reason: "stale", Archive: false})
		case !isMachine(n.Source) && !stamped && old:
			// the never-referenced-immortal leak, respecting hand-written notes: flag, never archive.
			out = append(out, DecayAction{NoteID: n.ID, Path: n.Path, Reason: "stale", Archive: false})
		}
	}
	return out
}
```

In `pkg/memgarden/gardener.go`, add to the `gardener` struct, directly after `vaultRootFn`:

```go
	epochFn      func() time.Time
```

In `newGardener()`, directly after `vaultRootFn: memroots.MemoryRoot,`:

```go
		epochFn:        memvault.RecallEpoch,
```

At the call site (`gardener.go`, in `gardenScope`), change:

```go
	for _, a := range classifyDecay(plain, now, g.staleDays, g.epochFn()) {
```

- [ ] **Step 4: Run the decay tests to verify they pass**

Run: `CGO_CFLAGS="-O2 -g -I$(pwd -W)/pkg/jarvisembed/csrc" go test ./pkg/memgarden/ -v`
Expected: PASS, including the updated `TestClassifyDecay`.

- [ ] **Step 5: Write the failing restore test**

Create `pkg/memvault/restoredecay_test.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package memvault

import (
	"os"
	"path/filepath"
	"testing"
)

// archivedFixture writes one archived note carrying reason, restorable into vaultDir.
func archivedFixture(t *testing.T, archiveDir, vaultDir, slug, reason string) string {
	t.Helper()
	body := "---\nname: " + slug + "\nmetadata:\n" +
		"  type: learning\n  source: \"claude\"\n" +
		"  archived_at: \"2026-08-01T00:00:00Z\"\n" +
		"  archived_reason: " + reason + "\n" +
		"  archived_from: \"" + filepath.ToSlash(vaultDir) + "\"\n---\n\n" + slug + " body\n"
	p := filepath.Join(archiveDir, "20260801T000000.000-"+slug+".md")
	if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestRestoreDecayArchiveRestoresOnlyDecayAndIsIdempotent(t *testing.T) {
	archiveDir := t.TempDir()
	vaultDir := t.TempDir()
	markerDir := t.TempDir()

	oldArchive := ArchiveDir
	ArchiveDir = func() string { return archiveDir }
	t.Cleanup(func() { ArchiveDir = oldArchive })
	oldMarker := decayRestoreMarker
	decayRestoreMarker = func() string { return filepath.Join(markerDir, "done.txt") }
	t.Cleanup(func() { decayRestoreMarker = oldMarker })

	decayed := archivedFixture(t, archiveDir, vaultDir, "was-decayed", "decay")
	drifted := archivedFixture(t, archiveDir, vaultDir, "was-drifted", "drift")

	n, err := RestoreDecayArchive()
	if err != nil {
		t.Fatalf("RestoreDecayArchive: %v", err)
	}
	if n != 1 {
		t.Fatalf("restored %d, want 1 (only archived_reason: decay)", n)
	}
	if _, err := os.Stat(filepath.Join(vaultDir, "was-decayed.md")); err != nil {
		t.Fatalf("decayed note not restored into the vault: %v", err)
	}
	if _, err := os.Stat(decayed); !os.IsNotExist(err) {
		t.Fatalf("restored note must leave the archive, stat err = %v", err)
	}
	if _, err := os.Stat(drifted); err != nil {
		t.Fatalf("a drift archive must be left alone: %v", err)
	}

	// second run is a no-op: the marker, not the archive's emptiness, is what guards it
	archivedFixture(t, archiveDir, vaultDir, "later-decay", "decay")
	n, err = RestoreDecayArchive()
	if err != nil {
		t.Fatalf("second RestoreDecayArchive: %v", err)
	}
	if n != 0 {
		t.Fatalf("second run restored %d, want 0", n)
	}
}

func TestRestoreDecaySkipsASlugThatIsBackInTheVault(t *testing.T) {
	archiveDir := t.TempDir()
	vaultDir := t.TempDir()
	markerDir := t.TempDir()

	oldArchive := ArchiveDir
	ArchiveDir = func() string { return archiveDir }
	t.Cleanup(func() { ArchiveDir = oldArchive })
	oldMarker := decayRestoreMarker
	decayRestoreMarker = func() string { return filepath.Join(markerDir, "done.txt") }
	t.Cleanup(func() { decayRestoreMarker = oldMarker })

	archivedFixture(t, archiveDir, vaultDir, "collides", "decay")
	live := filepath.Join(vaultDir, "collides.md")
	if err := os.WriteFile(live, []byte("---\nname: collides\n---\n\nthe live copy\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	if _, err := RestoreDecayArchive(); err != nil {
		t.Fatalf("RestoreDecayArchive: %v", err)
	}
	data, err := os.ReadFile(live)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "---\nname: collides\n---\n\nthe live copy\n" {
		t.Fatalf("a slug already in the vault must not be overwritten, got:\n%s", data)
	}
}
```

`ArchiveDir` is already a redirectable var — Task 1 made it one so this task and Task 5 could both
test hermetically without either owning the edit. Do not change its declaration here.

- [ ] **Step 6: Run the restore test to verify it fails**

Run: `CGO_CFLAGS="-O2 -g -I$(pwd -W)/pkg/jarvisembed/csrc" go test ./pkg/memvault/ -run RestoreDecay -v`
Expected: FAIL to compile — `undefined: decayRestoreMarker`, `undefined: RestoreDecayArchive`.

- [ ] **Step 7: Implement the restore**

Create `pkg/memvault/restoredecay.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// One-shot repair: give back every note the pre-epoch decay predicate archived. Those archives fired
// on the never-referenced branch, which no vault-only note could escape, so the archive is a record
// of a bug rather than of a decision. Runs once per installation, guarded by a marker file — the
// same shape as memroots' legacy-root fold. See
// docs/superpowers/specs/2026-09-22-memory-utilization-design.md.
package memvault

import (
	"log"
	"os"
	"path/filepath"
	"time"

	"github.com/wavetermdev/waveterm/pkg/wavebase"
)

// decayRestoreMarker records that the repair has run, keyed to the profile's data dir. A var so
// tests can redirect it.
var decayRestoreMarker = func() string {
	dir := wavebase.GetWaveDataDir()
	if dir == "" {
		return ""
	}
	return filepath.Join(dir, "memory-decay-restore-done.txt")
}

// RestoreDecayArchive moves every archived note whose reason is "decay" back to the collection it
// came from, stripping the archive metadata. Slug collisions are skipped, never overwritten: a note
// that is already back in the vault has a live copy that outranks the archived one. Idempotent —
// the marker, not the archive's emptiness, is what stops a second run, so a decay archive written
// after the repair (by the fixed predicate, on real evidence) is left alone.
func RestoreDecayArchive() (int, error) {
	marker := decayRestoreMarker()
	if marker == "" {
		return 0, nil // no data dir: nothing to remember having done
	}
	if _, err := os.Stat(marker); err == nil {
		return 0, nil
	}
	restored := 0
	for _, a := range ListArchived() {
		if a.Reason != "decay" {
			continue
		}
		if a.OriginHub != "" {
			if _, err := os.Stat(filepath.Join(a.OriginHub, a.ID+".md")); err == nil {
				continue // a live copy already holds the slug
			}
		}
		if _, err := Restore(a.Path); err != nil {
			// one unrestorable note must not strand the rest
			log.Printf("[memvault] restoring decayed note %s: %v\n", a.Path, err)
			continue
		}
		restored++
	}
	if err := os.WriteFile(marker, []byte(time.Now().UTC().Format(time.RFC3339)), 0o644); err != nil {
		return restored, err
	}
	return restored, nil
}
```

- [ ] **Step 8: Run it on boot**

In `cmd/server/main-server.go`, in the same sweep-hook closure Task 1 touched, directly after the
`memvault.EnsureRecallEpoch(time.Now())` line:

```go
		if n, err := memvault.RestoreDecayArchive(); err != nil {
			log.Printf("memory decay-archive restore: %v", err)
		} else if n > 0 {
			log.Printf("memory decay-archive restore: returned %d notes archived on an unfirable signal", n)
		}
```

- [ ] **Step 9: Run the tests to verify they pass**

Run: `CGO_CFLAGS="-O2 -g -I$(pwd -W)/pkg/jarvisembed/csrc" go test ./pkg/memvault/ ./pkg/memgarden/ -v`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add pkg/memgarden/decay.go pkg/memgarden/decay_test.go pkg/memgarden/gardener.go pkg/memvault/archive.go pkg/memvault/restoredecay.go pkg/memvault/restoredecay_test.go cmd/server/main-server.go
git commit -m "fix(memgarden): never archive on a recall signal that could not fire"
```

---

### Task 4: Cross-project claude facts reach the hub, and the manifest goes

**Depends on:** none
**Chunk:** Fix the echo-rule leak stranding harvested claude notes
**Chunk:** Decide the shared manifest: self-contained lines or cut it

**Files:**
- Modify: `pkg/memvault/projection.go` (`exportToHub`, `vaultNotesForProject`, `Project`; delete
  `renderManifestFrom` and `RenderManifest`)
- Create: `pkg/memvault/sharedindex.go`
- Create: `pkg/memvault/sharedindex_test.go`
- Modify: `pkg/memvault/projection_test.go` (delete the four manifest tests, add the echo-rule test)
- Modify: `pkg/wshrpc/wshrpctypes_memory.go` (drop `MemoryProjectManifestCommand`)
- Modify: `pkg/wshrpc/wshserver/wshserver_memory.go` (drop the handler)
- Modify: `cmd/wsh/cmd/wshcmd-agent-memory-project.go` (drop the `--inject` branch)
- Modify: `cmd/wsh/cmd/wshcmd-agent-memory-project_test.go`
- Regenerate: `task generate`

**Interfaces — Produces:** `func memvault.WriteSharedIndex(hubDir, sharedDir string) error`.

Why the index and not the manifest: Claude's memory tool is sandboxed to `memory/`, so a file in the
sibling `shared/` dir is only reachable through a link in the hub's `MEMORY.md`, which *is* injected
every session. 3 of the 18 shared notes are linked today; the other 15 had only the manifest pointing
at them, and 0 of 440 transcripts ever followed it.

- [ ] **Step 1: Write the failing tests**

Create `pkg/memvault/sharedindex_test.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package memvault

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestApplySharedIndexRegionIsIdempotentAndLeavesHandEntriesAlone(t *testing.T) {
	hand := "# Memory index\n\n- [a hand-written entry](note-a.md) — kept by the memory tool\n"
	body := "### Shared project memory (from the Arc vault)\n\n- [x](../shared/x.md) — a fact\n"

	once := applySharedIndexRegion(hand, body)
	if !strings.Contains(once, "a hand-written entry") {
		t.Fatalf("hand-maintained content outside the region was lost:\n%s", once)
	}
	if !strings.Contains(once, "../shared/x.md") {
		t.Fatalf("region body missing:\n%s", once)
	}
	twice := applySharedIndexRegion(once, body)
	if twice != once {
		t.Fatalf("second apply changed the file:\n--- once ---\n%s\n--- twice ---\n%s", once, twice)
	}
}

func TestApplySharedIndexRegionEmptyBodyStripsTheRegion(t *testing.T) {
	hand := "# Memory index\n\n- [a](a.md)\n"
	withRegion := applySharedIndexRegion(hand, "### h\n\n- [x](../shared/x.md)\n")
	stripped := applySharedIndexRegion(withRegion, "")
	if strings.Contains(stripped, "ARC-SHARED") {
		t.Fatalf("empty body must remove the region entirely:\n%s", stripped)
	}
	if !strings.Contains(stripped, "- [a](a.md)") {
		t.Fatalf("stripping the region must not touch hand entries:\n%s", stripped)
	}
}

func TestWriteSharedIndexLinksEverySharedNote(t *testing.T) {
	hub := t.TempDir()
	shared := t.TempDir()
	if err := os.WriteFile(filepath.Join(shared, "fact-one.md"),
		[]byte("---\nname: fact-one\ndescription: \"the first fact\"\n---\n\nbody one\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(hub, "MEMORY.md"), []byte("# Memory index\n\n- [a](a.md)\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	if err := WriteSharedIndex(hub, shared); err != nil {
		t.Fatalf("WriteSharedIndex: %v", err)
	}
	data, err := os.ReadFile(filepath.Join(hub, "MEMORY.md"))
	if err != nil {
		t.Fatal(err)
	}
	got := string(data)
	if !strings.Contains(got, "[fact-one](../shared/fact-one.md)") {
		t.Fatalf("shared note not linked:\n%s", got)
	}
	if !strings.Contains(got, "the first fact") {
		t.Fatalf("description not carried into the index line:\n%s", got)
	}
	if !strings.Contains(got, "- [a](a.md)") {
		t.Fatalf("hand entry lost:\n%s", got)
	}
}

func TestWriteSharedIndexMissingHubIndexIsCreated(t *testing.T) {
	hub := t.TempDir()
	shared := t.TempDir()
	if err := os.WriteFile(filepath.Join(shared, "solo.md"), []byte("---\nname: solo\n---\n\nbody\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := WriteSharedIndex(hub, shared); err != nil {
		t.Fatalf("WriteSharedIndex: %v", err)
	}
	data, err := os.ReadFile(filepath.Join(hub, "MEMORY.md"))
	if err != nil {
		t.Fatalf("index not created: %v", err)
	}
	if !strings.Contains(string(data), "[solo](../shared/solo.md)") {
		t.Fatalf("link missing from a created index:\n%s", data)
	}
}
```

Append to `pkg/memvault/projection_test.go`:

```go
func TestExportToHubKeepsOwnProjectClaudeNotesAndSendsOthers(t *testing.T) {
	dir := t.TempDir()
	own := map[string]bool{"waveterm": true}
	notes := []NoteWithBody{
		{Note: Note{ID: "mine", Source: "claude", Scope: "waveterm"}, Body: "a fact claude already holds here"},
		{Note: Note{ID: "theirs", Source: "claude", Scope: "opal"}, Body: "a fact from another project"},
		{Note: Note{ID: "global", Source: "claude", Scope: "shared"}, Body: "a fact with no project"},
		{Note: Note{ID: "vaulted", Source: "vault", Scope: "waveterm"}, Body: "an arc-authored fact"},
	}
	exported, _, err := exportToHub(dir, notes, own)
	if err != nil {
		t.Fatalf("exportToHub: %v", err)
	}
	if exported != 3 {
		t.Fatalf("exported %d, want 3 (everything but this project's own claude note)", exported)
	}
	if _, err := os.Stat(filepath.Join(dir, "mine.md")); !os.IsNotExist(err) {
		t.Fatalf("echo rule violated — this project's own claude fact was sent back to it")
	}
	for _, slug := range []string{"theirs", "global", "vaulted"} {
		if _, err := os.Stat(filepath.Join(dir, slug+".md")); err != nil {
			t.Fatalf("%s.md should have been exported: %v", slug, err)
		}
	}
}
```

Delete `TestRenderManifestLines`, `TestRenderManifestCapsAuthoredDescriptions`,
`TestRenderManifestEmptyIsBlank` and `TestRenderManifestEmptyCwd` from that file — the behavior they
cover is being removed.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `CGO_CFLAGS="-O2 -g -I$(pwd -W)/pkg/jarvisembed/csrc" go test ./pkg/memvault/ -run 'SharedIndex|ExportToHub' -v`
Expected: FAIL to compile — `undefined: applySharedIndexRegion`, `undefined: WriteSharedIndex`, and
`too many arguments in call to exportToHub`.

- [ ] **Step 3: Add the shared index writer**

Create `pkg/memvault/sharedindex.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The shared-index region: Arc's links into the hub's sibling shared/ dir, written inside delimiters
// in the hub's MEMORY.md. Claude's memory tool is sandboxed to memory/, so a file in shared/ is only
// reachable through a link in the index — which is injected every session. Content outside the
// delimiters is the memory tool's own hand-maintained index and is never touched.
// See docs/superpowers/specs/2026-09-22-memory-utilization-design.md.
package memvault

import (
	"os"
	"path/filepath"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/memroots"
)

const (
	sharedRegionBegin = "<!-- ARC-SHARED:BEGIN (generated — do not edit; managed by Arc) -->"
	sharedRegionEnd   = "<!-- ARC-SHARED:END -->"
)

// applySharedIndexRegion returns existing with the ARC-SHARED region set to body. An empty body
// removes the region. Idempotent: applying the same body twice is a no-op.
func applySharedIndexRegion(existing, body string) string {
	stripped := existing
	if start := strings.Index(existing, sharedRegionBegin); start >= 0 {
		if end := strings.Index(existing[start:], sharedRegionEnd); end >= 0 {
			tail := strings.TrimLeft(existing[start+end+len(sharedRegionEnd):], "\n")
			stripped = existing[:start] + tail
		}
	}
	if strings.TrimSpace(body) == "" {
		return stripped
	}
	region := sharedRegionBegin + "\n" + body + sharedRegionEnd + "\n"
	if strings.TrimSpace(stripped) == "" {
		return region
	}
	return strings.TrimRight(stripped, "\n") + "\n\n" + region
}

// renderSharedIndex renders the region body: one markdown link per shared note. shared/ is a sibling
// of the hub, so every target is one level up.
func renderSharedIndex(notes []NoteWithBody) string {
	if len(notes) == 0 {
		return ""
	}
	var b strings.Builder
	b.WriteString("### Shared project memory (from the Arc vault)\n\n")
	for _, nw := range notes {
		desc := capLine(nw.Note.Description)
		if desc == "" {
			desc = synthDescription(nw.Body)
		}
		b.WriteString("- [" + nw.Note.ID + "](../shared/" + filepath.Base(nw.Note.Path) + ")")
		if desc != "" {
			b.WriteString(" — " + desc)
		}
		b.WriteString("\n")
	}
	return b.String()
}

// WriteSharedIndex rewrites the hub index's ARC-SHARED region from the notes currently in sharedDir.
// A hub with no index gets one; an empty sharedDir removes the region.
func WriteSharedIndex(hubDir, sharedDir string) error {
	if hubDir == "" {
		return nil
	}
	indexPath := filepath.Join(hubDir, memroots.IndexFile)
	var existing string
	if data, err := os.ReadFile(indexPath); err == nil {
		existing = string(data)
	}
	out := applySharedIndexRegion(existing, renderSharedIndex(readHubNotes(sharedDir)))
	if out == existing {
		return nil
	}
	if strings.TrimSpace(out) == "" {
		return nil // nothing to write and nothing was there
	}
	if err := os.MkdirAll(hubDir, 0o755); err != nil {
		return err
	}
	return os.WriteFile(indexPath, []byte(out), 0o644)
}
```

- [ ] **Step 4: Make the echo rule scope-aware**

In `pkg/memvault/projection.go`, add above `vaultNotesForProject`:

```go
// projectScopeAliases is every scope string that means "this project": the registry label, the leaf
// folder, and the hub-derived label (a registry rename leaves old labels baked into frontmatter).
// One definition, shared by the note filter and the echo rule, so the two can never disagree about
// what "this project" means.
func projectScopeAliases(cwd, label string) map[string]bool {
	return map[string]bool{
		label: true,
		filepath.Base(filepath.Clean(cwd)): true,
		memroots.LabelFromHash(memroots.ProjectHash(filepath.Clean(cwd)), memroots.RegistryProjects()): true,
	}
}
```

Replace `vaultNotesForProject` with:

```go
// vaultNotesForProject filters the vault's notes to those belonging to cwd's project, plus global
// notes (empty/shared).
func vaultNotesForProject(cwd, label string) []NoteWithBody {
	own := projectScopeAliases(cwd, label)
	out := []NoteWithBody{}
	for _, nw := range readHubNotes(DefaultVaultPath()) {
		if own[nw.Note.Scope] || nw.Note.Scope == "" || nw.Note.Scope == "shared" {
			out = append(out, nw)
		}
	}
	return out
}
```

Replace the skip clause in `exportToHub`, and its signature and doc comment:

```go
// exportToHub writes the vault notes into dir as source: vault notes. The echo rule is per-hub, not
// per-runtime: a claude-sourced note is withheld only from the project it was harvested from, which
// already holds it. A claude fact from another project — or one with no project at all — has never
// been seen by this hub, and withholding it was the leak. ownScopes names this project's scopes.
// Deduped by body hash against dir.
func exportToHub(dir string, notes []NoteWithBody, ownScopes map[string]bool) (int, int, error) {
	if dir == "" {
		return 0, 0, nil
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return 0, 0, err
	}
	existing := existingHashes(dir)
	exported, skipped := 0, 0
	for _, nw := range notes {
		if nw.Note.Source == "claude" && ownScopes[nw.Note.Scope] {
			skipped++
			continue
		}
		h := factHash(nw.Body)
		if existing[h] {
			skipped++
			continue
		}
		wrote, werr := writeSourcedNote(dir, boundedSlug(nw.Note.ID, "note"), nw.Note.Type, nw.Note.Scope, "vault", h, nw.Note.Description, nw.Body)
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
```

In `Project`, replace the export call and add the index write:

```go
	sharedDir := SharedDirForCwd(cwd)
	if _, _, err := exportToHub(sharedDir, notes, projectScopeAliases(cwd, label)); err != nil {
		return fmt.Errorf("exporting to shared dir: %w", err)
	}
	// the export is only reachable from a session through the hub index, which is injected every
	// session; without this the shared dir is a directory nothing reads
	if err := WriteSharedIndex(HubDirForCwd(cwd), sharedDir); err != nil {
		return fmt.Errorf("writing shared index: %w", err)
	}
```

- [ ] **Step 5: Delete the manifest**

In `pkg/memvault/projection.go`, delete `renderManifestFrom` and `RenderManifest` entirely (the two
functions and their doc comments).

In `pkg/wshrpc/wshrpctypes_memory.go`, delete the `MemoryProjectManifestCommand` line from the
interface.

In `pkg/wshrpc/wshserver/wshserver_memory.go`, delete the `MemoryProjectManifestCommand` method and
its doc comment.

In `cmd/wsh/cmd/wshcmd-agent-memory-project.go`: delete the `agentMemoryProjectInject` var, its flag
registration, the `sessionStartPayload` function, the `sessionStartEvent` struct, `resolveProjectCwd`'s
`inject` parameter and stdin branch, and the `--inject` tail of `agentMemoryProjectRun`. The function
body becomes:

```go
func agentMemoryProjectRun(cmd *cobra.Command, args []string) error {
	if agentMemoryProjectCwd == "" {
		return nil
	}
	jwt := os.Getenv(wshutil.WaveJwtTokenVarName)
	if jwt == "" {
		return nil
	}
	if setupRpcClient(nil, jwt) != nil {
		return nil
	}
	return wshclient.MemoryProjectCommand(RpcClient, wshrpc.CommandMemoryProjectData{Cwd: agentMemoryProjectCwd}, &wshrpc.RpcOpts{Timeout: 15000})
}
```

Drop the now-unused `encoding/json`, `io`, `fmt` and `strings` imports from that file. Delete the
`resolveProjectCwd` and `sessionStartPayload` tests from
`cmd/wsh/cmd/wshcmd-agent-memory-project_test.go`; keep any test that exercises the
no-JWT no-op path.

Then search for any remaining caller and remove it:

```bash
grep -rn "MemoryProjectManifest\|--inject\|RenderManifest" --include="*.go" --include="*.ts" cmd/ pkg/ frontend/ | grep -v wshclient.go
```

- [ ] **Step 6: Regenerate the bindings**

Run: `task generate`
Expected: `frontend/app/store/wshclientapi.ts`, `frontend/types/gotypes.d.ts` and
`pkg/wshrpc/wshclient/wshclient.go` lose `MemoryProjectManifestCommand`. Do not hand-edit them.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `CGO_CFLAGS="-O2 -g -I$(pwd -W)/pkg/jarvisembed/csrc" go test ./pkg/memvault/ ./pkg/wshrpc/... ./cmd/wsh/... -v`
Expected: PASS.

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0 (the baseline is clean — any error is from the regeneration).

- [ ] **Step 8: Commit**

```bash
git add pkg/memvault/ pkg/wshrpc/ cmd/wsh/cmd/ frontend/app/store/wshclientapi.ts frontend/types/gotypes.d.ts
git commit -m "fix(memvault): scope the echo rule per hub and index shared notes"
```

---

### Task 5: De-fragment the Claude memory hubs

**Depends on:** Task 1
**Chunk:** De-fragment the Claude memory hubs (double-dash encodings, tmp worktree hubs)

Task 1 is a dependency only for the redirectable `ArchiveDir`, which `PruneDeadHubs`' guard reads
through `vaultBackedHashes` and this task's tests must point at a temp dir.

**Files:**
- Create: `pkg/memvault/hubdefrag.go`
- Create: `pkg/memvault/hubdefrag_test.go`
- Modify: `pkg/memgarden/gardener.go` (register the pillar on the sweep)
- Modify: `pkg/memgarden/gardener_test.go`

**Interfaces — Produces:**
- `func memvault.CanonicalHubHash(hash string) string`
- `func memvault.MergeDoubledHubs() (int, error)` — notes moved
- `func memvault.PruneDeadHubs() (int, error)` — hubs removed

Measured today: 7 hubs under the doubled-separator encoding (`cyber_assistant` is split 53 / 9 across
the two forms, and Claude's recall only ever sees the encoding its own cwd produces), plus 8
single-note `C--tmp-mp-reg-*` hubs left by throwaway worktrees whose paths no longer exist.

- [ ] **Step 1: Write the failing tests**

Create `pkg/memvault/hubdefrag_test.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package memvault

import (
	"os"
	"path/filepath"
	"testing"
)

func TestCanonicalHubHashHalvesSeparatorRuns(t *testing.T) {
	cases := []struct{ in, want string }{
		{"C---Users--kael02--IdeaProjects--waveterm", "C--Users-kael02-IdeaProjects-waveterm"},
		{"C---Users--kael02--IdeaProjects--SIEM--src--cyber_ai--cyber_assistant", "C--Users-kael02-IdeaProjects-SIEM-src-cyber_ai-cyber_assistant"},
		// a lone dash from a real folder name maps to itself
		{"C--Users-kael02-my-project", "C--Users-kael02-my-project"},
	}
	for _, c := range cases {
		if got := CanonicalHubHash(c.in); got != c.want {
			t.Fatalf("CanonicalHubHash(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

// hubFixture writes one note into <root>/<hash>/memory and returns that hub dir.
func hubFixture(t *testing.T, root, hash, slug, body string) string {
	t.Helper()
	hub := filepath.Join(root, hash, "memory")
	if err := os.MkdirAll(hub, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(hub, slug+".md"),
		[]byte("---\nname: "+slug+"\nmetadata:\n  type: learning\n  source: \"claude\"\n---\n\n"+body+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	return hub
}

func TestMergeDoubledHubsRequiresAnExistingCanonicalSibling(t *testing.T) {
	root := t.TempDir()
	oldRoot := claudeProjectsRoot
	claudeProjectsRoot = func() string { return root }
	t.Cleanup(func() { claudeProjectsRoot = oldRoot })

	canonical := hubFixture(t, root, "C--Users-k-proj", "canon-note", "canonical body")
	doubled := hubFixture(t, root, "C---Users--k--proj", "doubled-note", "doubled body")
	orphan := hubFixture(t, root, "C---Users--k--noSibling", "orphan-note", "orphan body")

	moved, err := MergeDoubledHubs()
	if err != nil {
		t.Fatalf("MergeDoubledHubs: %v", err)
	}
	if moved != 1 {
		t.Fatalf("moved %d notes, want 1", moved)
	}
	if _, err := os.Stat(filepath.Join(canonical, "doubled-note.md")); err != nil {
		t.Fatalf("doubled note not merged into the canonical hub: %v", err)
	}
	if _, err := os.Stat(doubled); !os.IsNotExist(err) {
		t.Fatalf("emptied doubled hub should be removed, stat err = %v", err)
	}
	if _, err := os.Stat(filepath.Join(orphan, "orphan-note.md")); err != nil {
		t.Fatalf("a doubled hub with no canonical sibling must be left untouched: %v", err)
	}
}

func TestPruneDeadHubsNeedsBothGuards(t *testing.T) {
	root := t.TempDir()
	vault := t.TempDir()
	liveRepo := t.TempDir()

	oldRoot := claudeProjectsRoot
	claudeProjectsRoot = func() string { return root }
	t.Cleanup(func() { claudeProjectsRoot = oldRoot })
	oldVault := DefaultVaultPath
	DefaultVaultPath = func() string { return vault }
	t.Cleanup(func() { DefaultVaultPath = oldVault })
	oldArchive := ArchiveDir
	ArchiveDir = func() string { return filepath.Join(t.TempDir(), "archive") }
	t.Cleanup(func() { ArchiveDir = oldArchive })

	// backed: its body is in the vault. unbacked: it exists nowhere else.
	backedHub := hubFixture(t, root, ProjectHashForTest(filepath.Join(root, "gone-repo")), "backed", "a backed body")
	unbackedHub := hubFixture(t, root, ProjectHashForTest(filepath.Join(root, "gone-repo-2")), "unbacked", "a body held nowhere else")
	liveHub := hubFixture(t, root, ProjectHashForTest(liveRepo), "live", "a backed body")

	if err := os.WriteFile(filepath.Join(vault, "backed.md"),
		[]byte("---\nname: backed\n---\n\na backed body\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	removed, err := PruneDeadHubs()
	if err != nil {
		t.Fatalf("PruneDeadHubs: %v", err)
	}
	if removed != 1 {
		t.Fatalf("removed %d hubs, want 1 (only dead AND fully backed)", removed)
	}
	if _, err := os.Stat(backedHub); !os.IsNotExist(err) {
		t.Fatalf("dead, fully-backed hub should be removed, stat err = %v", err)
	}
	if _, err := os.Stat(unbackedHub); err != nil {
		t.Fatalf("a hub holding an unbacked fact must survive: %v", err)
	}
	if _, err := os.Stat(liveHub); err != nil {
		t.Fatalf("a hub whose repo still exists must survive: %v", err)
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `CGO_CFLAGS="-O2 -g -I$(pwd -W)/pkg/jarvisembed/csrc" go test ./pkg/memvault/ -run 'CanonicalHubHash|DoubledHubs|DeadHubs' -v`
Expected: FAIL to compile — `undefined: CanonicalHubHash`, `undefined: claudeProjectsRoot`,
`undefined: MergeDoubledHubs`, `undefined: PruneDeadHubs`, `undefined: ProjectHashForTest`.

- [ ] **Step 3: Implement the de-fragmentation**

Create `pkg/memvault/hubdefrag.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Hub de-fragmentation. Claude addresses its per-project memory by an encoded cwd, so one project
// reached through two spellings of its path owns two hubs and recall only ever sees the one matching
// the session's own encoding. This folds a doubled-separator hub into its canonical sibling, and
// removes hubs whose project is gone and whose every fact the vault already holds.
// See docs/superpowers/specs/2026-09-22-memory-utilization-design.md.
package memvault

import (
	"os"
	"path/filepath"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/memroots"
	"github.com/wavetermdev/waveterm/pkg/wavebase"
)

// claudeProjectsRoot is ~/.claude/projects. A var so tests can redirect it.
var claudeProjectsRoot = func() string {
	return filepath.Join(wavebase.GetHomeDir(), ".claude", "projects")
}

// ProjectHashForTest exposes the encoding to this package's tests, which need to build hub dirs that
// reverse-resolve to a real path.
func ProjectHashForTest(p string) string { return memroots.ProjectHash(filepath.Clean(p)) }

// CanonicalHubHash halves every run of dashes in an encoded hub dir name. A cwd whose separators
// were doubled (C:\\Users\\k) encodes each separator twice, so a run of k dashes in the doubled form
// is a run of ceil(k/2) in the single form — and a lone dash from a real folder name maps to itself.
// The result is a candidate, never a conclusion: a merge happens only when that sibling exists.
func CanonicalHubHash(hash string) string {
	var b strings.Builder
	for i := 0; i < len(hash); {
		if hash[i] != '-' {
			b.WriteByte(hash[i])
			i++
			continue
		}
		j := i
		for j < len(hash) && hash[j] == '-' {
			j++
		}
		for k := 0; k < (j-i+1)/2; k++ {
			b.WriteByte('-')
		}
		i = j
	}
	return b.String()
}

// MergeDoubledHubs folds every doubled-encoding hub into its canonical sibling and removes the
// emptied hub. Existence of the sibling is the proof that two spellings name one project; nothing is
// inferred from the string alone. Returns the number of notes moved.
func MergeDoubledHubs() (int, error) {
	root := claudeProjectsRoot()
	entries, err := os.ReadDir(root)
	if err != nil {
		return 0, nil // no claude dir: nothing to de-fragment
	}
	moved := 0
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		canonical := CanonicalHubHash(e.Name())
		if canonical == e.Name() {
			continue
		}
		srcHub := filepath.Join(root, e.Name(), "memory")
		dstHub := filepath.Join(root, canonical, "memory")
		if !isDir(srcHub) || !isDir(dstHub) {
			continue
		}
		n, mergeErr := mergeHubNotes(srcHub, dstHub)
		moved += n
		if mergeErr != nil {
			return moved, mergeErr
		}
		// only an emptied hub is removed; a note left behind means something was not merged
		if remaining := readHubNotes(srcHub); len(remaining) == 0 {
			_ = os.RemoveAll(filepath.Join(root, e.Name()))
		}
	}
	return moved, nil
}

// mergeHubNotes moves src's notes into dst, deduped by body hash, never overwriting a slug that dst
// already holds. The hub index is not copied: dst maintains its own.
func mergeHubNotes(srcHub, dstHub string) (int, error) {
	existing := map[string]bool{}
	for _, nw := range readHubNotes(dstHub) {
		existing[factHash(nw.Body)] = true
	}
	moved := 0
	for _, nw := range readHubNotes(srcHub) {
		base := filepath.Base(nw.Note.Path)
		dst := filepath.Join(dstHub, base)
		if existing[factHash(nw.Body)] {
			if err := os.Remove(nw.Note.Path); err != nil {
				return moved, err
			}
			continue
		}
		if _, err := os.Stat(dst); err == nil {
			continue // slug collision with different content: leave it for human judgment
		}
		if err := os.Rename(nw.Note.Path, dst); err != nil {
			return moved, err
		}
		existing[factHash(nw.Body)] = true
		moved++
	}
	return moved, nil
}

// PruneDeadHubs removes every hub whose project path no longer exists on disk AND whose every note
// body the vault or the archive still holds. Both guards are required: a gone project alone does not
// license deleting the only copy of a fact. Only the memory subtree is removed. Returns hubs removed.
func PruneDeadHubs() (int, error) {
	backed := vaultBackedHashes(DefaultVaultPath())
	removed := 0
	for _, hub := range ClaudeHubDirs() {
		projectDir := filepath.Dir(hub)
		repo := repoPathForEncodedDir(filepath.Base(projectDir))
		if repo == "" || isDir(repo) {
			continue // unknown or still-live project: leave it alone
		}
		notes := readHubNotes(hub)
		allBacked := true
		for _, nw := range notes {
			if !backed[factHash(nw.Body)] {
				allBacked = false
				break
			}
		}
		if !allBacked {
			continue
		}
		if err := os.RemoveAll(hub); err != nil {
			return removed, err
		}
		removed++
	}
	return removed, nil
}

// repoPathForEncodedDir decodes a hub dir name back to a filesystem path. The encoding is lossy
// (every separator and the drive colon became '-'), so this only resolves the common Windows shape
// "C--rest": drive letter, then each remaining dash as a separator.
func repoPathForEncodedDir(name string) string {
	if len(name) < 4 || name[1:3] != "--" {
		return ""
	}
	return string(name[0]) + ":\\" + strings.ReplaceAll(name[3:], "-", "\\")
}

func isDir(p string) bool {
	info, err := os.Stat(p)
	return err == nil && info.IsDir()
}
```

- [ ] **Step 4: Ride the sweep**

In `pkg/memgarden/gardener.go`, at the top of `Sweep()`, before `defaultGardener.sweep()`:

```go
func Sweep() {
	ensure()
	// hub de-fragmentation is a property of the whole hub layout, not of one project's notes, so it
	// runs once per sweep rather than per scope
	if n, err := memvault.MergeDoubledHubs(); err != nil {
		log.Printf("[memgarden] merging doubled hubs: %v\n", err)
	} else if n > 0 {
		log.Printf("[memgarden] merged %d notes out of doubled-encoding hubs\n", n)
	}
	if n, err := memvault.PruneDeadHubs(); err != nil {
		log.Printf("[memgarden] pruning dead hubs: %v\n", err)
	} else if n > 0 {
		log.Printf("[memgarden] removed %d dead hubs\n", n)
	}
	defaultGardener.sweep()
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `CGO_CFLAGS="-O2 -g -I$(pwd -W)/pkg/jarvisembed/csrc" go test ./pkg/memvault/ ./pkg/memgarden/ -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add pkg/memvault/hubdefrag.go pkg/memvault/hubdefrag_test.go pkg/memgarden/gardener.go pkg/memgarden/gardener_test.go
git commit -m "feat(memvault): merge doubled hub encodings and prune dead hubs"
```

---

### Task 6: `wsh memory stats`, and a byte budget for the index

**Depends on:** Task 1, Task 4
**Chunk:** Re-budget MEMORY.md by bytes rather than lines

Task 4 is a dependency because both tasks change the wshrpc interface and run `task generate`; two
branches rewriting those three generated files collide on merge.

**Files:**
- Create: `pkg/memvault/stats.go`
- Create: `pkg/memvault/stats_test.go`
- Modify: `pkg/wshrpc/wshrpctypes_memory.go` (add `MemoryStatsCommand` + its rtn type)
- Modify: `pkg/wshrpc/wshserver/wshserver_memory.go` (the handler)
- Create: `cmd/wsh/cmd/wshcmd-memory.go`
- Regenerate: `task generate`

**Interfaces — Consumes:** `memvault.Note.ReferenceCount`, `memvault.RecallEpoch()` (Task 1).
**Interfaces — Produces:** `func memvault.ComputeStats(notes []Note, indexes []IndexFile, now time.Time, staleDays int, epoch time.Time) Stats`.

- [ ] **Step 1: Write the failing test**

Create `pkg/memvault/stats_test.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package memvault

import (
	"testing"
	"time"
)

func TestComputeStatsCountsUtilization(t *testing.T) {
	now := time.Date(2026, 9, 22, 0, 0, 0, 0, time.UTC)
	recent := now.AddDate(0, 0, -3).Format(time.RFC3339)
	cold := now.AddDate(0, 0, -90).Format(time.RFC3339)
	oldCap := now.AddDate(0, 0, -90).Format(time.RFC3339)

	notes := []Note{
		{ID: "a", Source: "claude", CapturedAt: oldCap, LastReferenced: recent, ReferenceCount: 4},
		{ID: "b", Source: "codex", CapturedAt: oldCap, LastReferenced: cold, ReferenceCount: 1},
		{ID: "c", Source: "agent", CapturedAt: oldCap},
		{ID: "d", Source: "vault", CapturedAt: oldCap},
		{ID: "e", CapturedAt: oldCap},
	}
	indexes := []IndexFile{{Label: "waveterm", Bytes: 17556}}

	// immature epoch: nothing is archive-eligible
	s := ComputeStats(notes, indexes, now, 30, now.AddDate(0, 0, -5))
	if s.Total != 5 || s.Machine != 3 || s.Human != 2 {
		t.Fatalf("totals = %d/%d/%d, want 5/3/2", s.Total, s.Machine, s.Human)
	}
	if s.Referenced != 2 {
		t.Fatalf("referenced = %d, want 2", s.Referenced)
	}
	if s.ReferencedRecently != 1 {
		t.Fatalf("referenced in window = %d, want 1", s.ReferencedRecently)
	}
	if s.NeverReferenced != 3 {
		t.Fatalf("never referenced = %d, want 3", s.NeverReferenced)
	}
	if s.ArchiveEligible != 1 {
		t.Fatalf("archive-eligible = %d, want 1 (only the cold stamped machine note)", s.ArchiveEligible)
	}

	// mature epoch: the unstamped machine note becomes eligible too
	s = ComputeStats(notes, indexes, now, 30, now.AddDate(0, 0, -90))
	if s.ArchiveEligible != 2 {
		t.Fatalf("archive-eligible with a mature epoch = %d, want 2", s.ArchiveEligible)
	}
}

func TestComputeStatsReportsIndexBudget(t *testing.T) {
	now := time.Date(2026, 9, 22, 0, 0, 0, 0, time.UTC)
	s := ComputeStats(nil, []IndexFile{
		{Label: "waveterm", Bytes: 17556},
		{Label: "opal", Bytes: 4000},
	}, now, 30, time.Time{})
	if len(s.Indexes) != 2 {
		t.Fatalf("indexes = %d, want 2", len(s.Indexes))
	}
	if !s.Indexes[0].OverBudget || s.Indexes[0].OverBy != 17556-IndexBudgetBytes {
		t.Fatalf("waveterm index = %+v, want over budget by %d", s.Indexes[0], 17556-IndexBudgetBytes)
	}
	if s.Indexes[1].OverBudget {
		t.Fatalf("opal index = %+v, want under budget", s.Indexes[1])
	}
	if s.TotalIndexBytes != 21556 {
		t.Fatalf("total index bytes = %d, want 21556", s.TotalIndexBytes)
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `CGO_CFLAGS="-O2 -g -I$(pwd -W)/pkg/jarvisembed/csrc" go test ./pkg/memvault/ -run ComputeStats -v`
Expected: FAIL to compile — `undefined: ComputeStats`, `undefined: IndexFile`, `undefined: IndexBudgetBytes`.

- [ ] **Step 3: Implement the stats**

Create `pkg/memvault/stats.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Memory utilization and injection cost in one report. These are one question: a note that is never
// recalled is pure session-start cost, and until now neither half was visible. See
// docs/superpowers/specs/2026-09-22-memory-utilization-design.md.
package memvault

import (
	"os"
	"path/filepath"
	"time"

	"github.com/wavetermdev/waveterm/pkg/memroots"
)

// IndexBudgetBytes caps one hub index. The budget is bytes because bytes are what session start
// pays: at ~185 bytes per line in the real index, a line budget does not constrain the real cost.
// ~12 KB is roughly 3,000 tokens. Advisory by construction — Claude's memory tool owns MEMORY.md and
// Arc never rewrites its entries, so the deliverable is that the number is visible and checkable.
const IndexBudgetBytes = 12000

// bytesPerToken is the estimate the report labels as an estimate; the real tokenizer is not ours.
const bytesPerToken = 4

// IndexFile is one hub index measured on disk.
type IndexFile struct {
	Label      string `json:"label"`
	Bytes      int    `json:"bytes"`
	Tokens     int    `json:"tokens"`
	OverBudget bool   `json:"overbudget"`
	OverBy     int    `json:"overby"`
}

// Stats is the whole report.
type Stats struct {
	VaultPath          string      `json:"vaultpath"`
	Total              int         `json:"total"`
	Machine            int         `json:"machine"`
	Human              int         `json:"human"`
	Referenced         int         `json:"referenced"`
	ReferencedRecently int         `json:"referencedrecently"`
	NeverReferenced    int         `json:"neverreferenced"`
	TotalReferences    int         `json:"totalreferences"`
	ArchiveEligible    int         `json:"archiveeligible"`
	Epoch              string      `json:"epoch"`
	EpochMatures       string      `json:"epochmatures"`
	Indexes            []IndexFile `json:"indexes"`
	TotalIndexBytes    int         `json:"totalindexbytes"`
	BudgetBytes        int         `json:"budgetbytes"`
}

// isMachineSource mirrors the gardener's provenance split. Duplicated deliberately as a one-line
// predicate rather than exported from memgarden, which imports this package.
func isMachineSource(source string) bool {
	switch source {
	case "agent", "codex", "claude", "pi":
		return true
	}
	return false
}

// ComputeStats is the pure core. epoch and staleDays are passed in so the report answers the same
// question the gardener does, with the same rule.
func ComputeStats(notes []Note, indexes []IndexFile, now time.Time, staleDays int, epoch time.Time) Stats {
	cutoff := now.AddDate(0, 0, -staleDays)
	signalMature := !epoch.IsZero() && epoch.Before(cutoff)
	s := Stats{Total: len(notes), BudgetBytes: IndexBudgetBytes}
	for _, n := range notes {
		machine := isMachineSource(n.Source)
		if machine {
			s.Machine++
		} else {
			s.Human++
		}
		s.TotalReferences += n.ReferenceCount
		stamped := n.LastReferenced != ""
		if !stamped {
			s.NeverReferenced++
		} else {
			s.Referenced++
			if !beforeCutoffTime(n.LastReferenced, cutoff) {
				s.ReferencedRecently++
			}
		}
		if !machine || n.SupersededBy != "" {
			continue
		}
		unused := (stamped && beforeCutoffTime(n.LastReferenced, cutoff)) || (!stamped && signalMature)
		if unused && noteAgeBefore(n, cutoff) {
			s.ArchiveEligible++
		}
	}
	for _, idx := range indexes {
		idx.Tokens = idx.Bytes / bytesPerToken
		if idx.Bytes > IndexBudgetBytes {
			idx.OverBudget = true
			idx.OverBy = idx.Bytes - IndexBudgetBytes
		}
		s.TotalIndexBytes += idx.Bytes
		s.Indexes = append(s.Indexes, idx)
	}
	if !epoch.IsZero() {
		s.Epoch = epoch.UTC().Format(time.RFC3339)
		s.EpochMatures = epoch.AddDate(0, 0, staleDays).UTC().Format(time.RFC3339)
	}
	return s
}

// beforeCutoffTime reports whether an RFC3339 stamp parses and precedes cutoff.
func beforeCutoffTime(ts string, cutoff time.Time) bool {
	t, err := time.Parse(time.RFC3339, ts)
	return err == nil && t.Before(cutoff)
}

// noteAgeBefore mirrors the gardener's age basis: captured_at, else file mtime.
func noteAgeBefore(n Note, cutoff time.Time) bool {
	if n.CapturedAt != "" {
		return beforeCutoffTime(n.CapturedAt, cutoff)
	}
	if n.UpdatedTs > 0 {
		return time.UnixMilli(n.UpdatedTs).Before(cutoff)
	}
	return false
}

// MeasureIndexes sizes every hub index on disk, labelled by project.
func MeasureIndexes() []IndexFile {
	var out []IndexFile
	for _, hub := range ClaudeHubDirs() {
		info, err := os.Stat(filepath.Join(hub, memroots.IndexFile))
		if err != nil {
			continue
		}
		out = append(out, IndexFile{
			Label: memroots.ScopeForHubDir(filepath.Base(filepath.Dir(hub))),
			Bytes: int(info.Size()),
		})
	}
	return out
}

// GatherStats reads the live vault and hub indexes and computes the report.
func GatherStats(now time.Time, staleDays int) Stats {
	var plain []Note
	for _, nw := range VaultNotes() {
		plain = append(plain, nw.Note)
	}
	s := ComputeStats(plain, MeasureIndexes(), now, staleDays, RecallEpoch())
	s.VaultPath = DefaultVaultPath()
	return s
}
```

- [ ] **Step 4: Expose it over RPC**

In `pkg/wshrpc/wshrpctypes_memory.go`, add to the interface, after `MemoryRestoreCommand`:

```go
	MemoryStatsCommand(ctx context.Context) (*CommandMemoryStatsRtnData, error)
```

and at the bottom of the file:

```go
// CommandMemoryStatsRtnData is the memory utilization + injection-cost report. Fields mirror
// memvault.Stats; the server converts.
type CommandMemoryStatsRtnData struct {
	VaultPath          string             `json:"vaultpath"`
	Total              int                `json:"total"`
	Machine            int                `json:"machine"`
	Human              int                `json:"human"`
	Referenced         int                `json:"referenced"`
	ReferencedRecently int                `json:"referencedrecently"`
	NeverReferenced    int                `json:"neverreferenced"`
	TotalReferences    int                `json:"totalreferences"`
	ArchiveEligible    int                `json:"archiveeligible"`
	Epoch              string             `json:"epoch"`
	EpochMatures       string             `json:"epochmatures"`
	Indexes            []MemoryIndexFile  `json:"indexes"`
	TotalIndexBytes    int                `json:"totalindexbytes"`
	BudgetBytes        int                `json:"budgetbytes"`
}

// MemoryIndexFile is one hub index's measured size.
type MemoryIndexFile struct {
	Label      string `json:"label"`
	Bytes      int    `json:"bytes"`
	Tokens     int    `json:"tokens"`
	OverBudget bool   `json:"overbudget"`
	OverBy     int    `json:"overby"`
}
```

In `pkg/wshrpc/wshserver/wshserver_memory.go`, add:

```go
// MemoryStatsCommand reports memory utilization and what memory costs at session start. StaleDays
// comes from the same config the gardener reads, so the report's archive-eligible count is the
// gardener's own answer rather than a second opinion.
func (ws *WshServer) MemoryStatsCommand(ctx context.Context) (*wshrpc.CommandMemoryStatsRtnData, error) {
	s := memvault.GatherStats(time.Now(), memvault.StaleDays)
	out := &wshrpc.CommandMemoryStatsRtnData{
		VaultPath: s.VaultPath, Total: s.Total, Machine: s.Machine, Human: s.Human,
		Referenced: s.Referenced, ReferencedRecently: s.ReferencedRecently,
		NeverReferenced: s.NeverReferenced, TotalReferences: s.TotalReferences,
		ArchiveEligible: s.ArchiveEligible, Epoch: s.Epoch, EpochMatures: s.EpochMatures,
		TotalIndexBytes: s.TotalIndexBytes, BudgetBytes: s.BudgetBytes,
	}
	for _, idx := range s.Indexes {
		out.Indexes = append(out.Indexes, wshrpc.MemoryIndexFile{
			Label: idx.Label, Bytes: idx.Bytes, Tokens: idx.Tokens,
			OverBudget: idx.OverBudget, OverBy: idx.OverBy,
		})
	}
	return out, nil
}
```

Add `"time"` to that file's imports if absent.

- [ ] **Step 5: Add the CLI**

Create `cmd/wsh/cmd/wshcmd-memory.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"fmt"

	"github.com/spf13/cobra"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshrpc/wshclient"
)

var memoryCmd = &cobra.Command{
	Use:   "memory",
	Short: "inspect the Arc memory vault",
}

var memoryStatsCmd = &cobra.Command{
	Use:     "stats",
	Short:   "report memory utilization and what memory costs at session start",
	Args:    cobra.NoArgs,
	RunE:    memoryStatsRun,
	PreRunE: preRunSetupRpcClient,
}

func init() {
	memoryCmd.AddCommand(memoryStatsCmd)
	rootCmd.AddCommand(memoryCmd)
}

func memoryStatsRun(cmd *cobra.Command, args []string) (rtnErr error) {
	defer func() {
		sendActivity("memory-stats", rtnErr == nil)
	}()
	s, err := wshclient.MemoryStatsCommand(RpcClient, &wshrpc.RpcOpts{Timeout: 15000})
	if err != nil {
		return fmt.Errorf("reading memory stats: %w", err)
	}
	pct := 0.0
	if s.Total > 0 {
		pct = float64(s.Referenced) * 100 / float64(s.Total)
	}
	WriteStdout("Vault  %s\n", s.VaultPath)
	WriteStdout("Notes             %5d   machine %d   human %d\n", s.Total, s.Machine, s.Human)
	WriteStdout("Referenced        %5d (%.1f%%)   in window %d   total recalls %d\n",
		s.Referenced, pct, s.ReferencedRecently, s.TotalReferences)
	eligibility := fmt.Sprintf("archive-eligible %d", s.ArchiveEligible)
	if s.Epoch == "" {
		eligibility += " (no recall epoch recorded — nothing can be archived on absence)"
	} else {
		eligibility += fmt.Sprintf(" (epoch %s, matures %s)", s.Epoch, s.EpochMatures)
	}
	WriteStdout("Never referenced  %5d   %s\n", s.NeverReferenced, eligibility)
	WriteStdout("Injection/session (token counts are estimates at %d bytes/token)\n", 4)
	for _, idx := range s.Indexes {
		status := "ok"
		if idx.OverBudget {
			status = fmt.Sprintf("OVER by %d", idx.OverBy)
		}
		WriteStdout("  MEMORY.md (%-24s) %8d B  ~%5d tok   budget %d B   %s\n",
			idx.Label, idx.Bytes, idx.Tokens, s.BudgetBytes, status)
	}
	WriteStdout("  total                            %8d B  ~%5d tok\n", s.TotalIndexBytes, s.TotalIndexBytes/4)
	return nil
}
```

Confirm the helper names against a neighbouring command file before writing — this repo's wsh
commands share `preRunSetupRpcClient`, `WriteStdout` and `sendActivity`; if any differs, match the
neighbour rather than this snippet.

- [ ] **Step 6: Regenerate and rewrite the budget rule**

Run: `task generate`

Then rewrite the memory note that carries the old rule so the budget is bytes, not lines:

```bash
cat > ~/IdeaProjects/obsidian_vault/memory/memory-index-maintenance-keep-memory-md-under-200-lines.md <<'EOF'
---
name: memory-index-maintenance-keep-memory-md-under-200-lines
description: "MEMORY.md is budgeted in BYTES (12,000 per hub index), not lines — a line budget does not track what session start actually pays. Check with `wsh memory stats`."
metadata:
  type: feedback
  scope: "shared"
---

Budget each hub's `MEMORY.md` at **12,000 bytes** (~3,000 tokens), not by line count.

**Why:** session-start injection ran ~5,600-6,400 tokens with `MEMORY.md` at 17,556 bytes — 78% of
it. The old rule was "under ~200 lines"; at 95 lines that is ~185 bytes/line, so the line budget was
satisfied while the real cost was nearly double the budget. Bytes are what session start pays.

**How to apply:** run `wsh memory stats` to see every hub index measured against the budget. When one
is over, prune shipped-feature records (they live in git history) rather than shortening lines —
truncated lines cost bytes and carry nothing. Arc never rewrites the memory tool's entries, so
enforcing this is the agent's job, not the app's.
EOF
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `CGO_CFLAGS="-O2 -g -I$(pwd -W)/pkg/jarvisembed/csrc" go test ./pkg/memvault/ ./pkg/wshrpc/... ./cmd/wsh/... -v`
Expected: PASS.

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 8: Commit**

```bash
git add pkg/memvault/stats.go pkg/memvault/stats_test.go pkg/wshrpc/ cmd/wsh/cmd/wshcmd-memory.go frontend/app/store/wshclientapi.ts frontend/types/gotypes.d.ts
git commit -m "feat(memvault): report utilization and index cost via wsh memory stats"
```

---

### Task 7: Cut the Records tab from the Vault surface

**Depends on:** none
**Chunk:** Cut the Records tab from the Vault surface

**Files:**
- Delete: `frontend/app/view/agents/vaultrecords.tsx`, `frontend/app/view/agents/vaultrecordsmodel.ts`,
  `frontend/app/view/agents/vaultrecordsmodel.test.ts`
- Modify: `frontend/app/view/agents/vaultstore.ts` (the `VaultTab` union)
- Modify: `frontend/app/view/agents/vaultsurface.tsx`
- Modify: `frontend/app/view/agents/vaultline.tsx`
- Modify: `frontend/app/view/jarvis/openref.ts` (`openRecordInVault` loses its destination)
- Modify: `frontend/app/view/jarvis/openref.test.ts`
- Modify: `frontend/app/cockpit/uiclient.ts` if it reports `vaultTab: "records"`

A dossier currently routes to this tab through `openRecordInVault`. With the tab gone its destination
is the Brief peek — which `vaultrecords.tsx`'s own header already names as the only surface that
writes a record's status, so the peek was always the authoritative view and this removes the second one.

- [ ] **Step 1: Write the failing test**

In `frontend/app/view/jarvis/openref.test.ts`, replace the assertion that a record target sets
`vaultTabAtom` to `"records"` with:

```ts
test("a record target opens the Brief peek rather than a Vault tab", () => {
    openTarget(model, { kind: "record", dossierId: "d-1" });
    expect(globalStore.get(briefPeekRecordAtom)).toBe("d-1");
    expect(globalStore.get(vaultTabAtom)).not.toBe("records");
});
```

Import `briefPeekRecordAtom` from `./jarvisstore` in that test file, and drop the
`vaultRecordIdAtom` / `vaultRecordPaneAtom` imports if nothing else uses them. Match the existing
test file's call shape for `openTarget` — read the neighbouring cases before writing this one.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run frontend/app/view/jarvis/openref.test.ts`
Expected: FAIL — the record target still sets the vault tab.

- [ ] **Step 3: Reroute the record target**

In `frontend/app/view/jarvis/openref.ts`, replace `openRecordInVault` with:

```ts
// A record's home is the Brief peek: it is the only surface that writes a record's status, so it was
// always the authoritative view. The Vault's second, read-only index is gone.
function openRecordPeek(dossierId: string): void {
    loadRecordDetail(dossierId);
    globalStore.set(briefPeekRecordAtom, dossierId);
}
```

Update the call site (`openref.ts:204`) to `openRecordPeek(target.dossierId);` — it no longer needs
`model`. Remove the now-unused `vaultRecordIdAtom`, `vaultRecordPaneAtom` and `vaultTabAtom` imports
if nothing else in the file uses them, and add `briefPeekRecordAtom` to the `jarvisstore` import.

- [ ] **Step 4: Delete the tab**

```bash
git rm frontend/app/view/agents/vaultrecords.tsx frontend/app/view/agents/vaultrecordsmodel.ts frontend/app/view/agents/vaultrecordsmodel.test.ts
```

In `frontend/app/view/agents/vaultstore.ts`:

```ts
export type VaultTab = "memory" | "steering" | "skills";
```

Delete `vaultRecordIdAtom` and `vaultRecordPaneAtom` **only if** nothing else imports them — check
first:

```bash
grep -rn "vaultRecordIdAtom\|vaultRecordPaneAtom" frontend/
```

`frontend/app/cockpit/uiclient.ts` reads `vaultRecordId` into its UI snapshot; drop that field there
too, along with the import.

In `frontend/app/view/agents/vaultsurface.tsx`: remove the `VaultRecords` import, the
`taskListAtom` usage and `recordsLine` in `Footer`, the `tab === "records"` branches in `Footer`'s
`left`, in `subtitle`, in the search placeholder, and in the tab body; change
`{tab !== "records" && <VaultRail model={model} />}` to `<VaultRail model={model} />` and delete the
comment above it; remove the `loadTaskList()` call and its two-line comment from the mount effect if
nothing else on the surface needs the task list.

In `frontend/app/view/agents/vaultline.tsx`: remove the `recordStatusCounts` import, the
`CollectionTab tab="records"` entry, the `tab === "records"` cluster branch, and the records cluster
component itself.

- [ ] **Step 5: Run the tests and the typecheck to verify they pass**

Run: `npx vitest run`
Expected: PASS. The deleted `vaultrecordsmodel.test.ts` no longer runs.

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0. Any error here is an import of something just deleted — fix it rather than
re-adding the file.

- [ ] **Step 6: Verify the surface still renders**

Run: `task verify:ui -- surface-smoke`
Expected: PASS. This is the only "does it render" coverage for surfaces — there are deliberately no
jsdom render tests. If the dev app is not running, note that and rely on the typecheck.

- [ ] **Step 7: Commit**

```bash
git add -A frontend/
git commit -m "refactor(vault): remove the Records tab and route records to the Brief peek"
```

---

### Task 8: Retire the pre-merge vault root

**Depends on:** none
**Chunk:** Reconcile vault-merge leftovers: 68 drifted notes, steering divergence, decisions nesting

**Files:** no repository files. This task operates on the live vault
(`~/IdeaProjects/obsidian_vault`) and the retired root (`~/.waveterm/vault`).

Measured 2026-09-22 against the two roots: of the retired root's 350 notes, **279 are byte-identical**
to the vault's copy, **70 have the same slug and different content**, and **1**
(`cardio-distance-not-stored.md`) is absent from the vault because the gardener archived it earlier
the same day as `drift` — so it is already preserved and must not be re-added.

The retired root is not scanned (`AllRoots()` follows `memory:vaultpath`, which points at the
Obsidian vault), so it is dormant rather than active. It resurrects if the data dir's last-root
marker is ever lost, at which point `MigrateVaultToConfiguredRoot` would copy 350 stale notes
forward. Retiring it explicitly is what closes that.

- [ ] **Step 1: Verify the preconditions**

```bash
cd ~/IdeaProjects/obsidian_vault && git status --porcelain
```

Expected: no output. Arc auto-commits into this vault (`jarvis: capture dossier for run …`), so a
dirty tree means something is mid-write — **stop and re-run later** rather than committing someone
else's work.

```bash
OLD=~/.waveterm/vault/memory; NEW=~/IdeaProjects/obsidian_vault/memory
same=0; drift=0; missing=0
for f in $OLD/*.md; do b=$(basename "$f")
  if [ -f "$NEW/$b" ]; then cmp -s "$f" "$NEW/$b" && same=$((same+1)) || drift=$((drift+1))
  else missing=$((missing+1)); fi
done
echo "identical=$same drifted=$drift only-in-old=$missing"
```

Expected: `identical=279 drifted=70 only-in-old=1`. Different numbers mean the roots moved since this
plan was written — stop and re-measure before touching anything.

- [ ] **Step 2: Archive the 70 divergent variants**

```bash
OLD=~/.waveterm/vault/memory; NEW=~/IdeaProjects/obsidian_vault/memory
ARCHIVE=~/.waveterm/memory-archive; TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
STAMP=$(date -u +%Y%m%dT%H%M%S).000
mkdir -p "$ARCHIVE"; n=0
for f in $OLD/*.md; do
  b=$(basename "$f")
  [ -f "$NEW/$b" ] || continue
  cmp -s "$f" "$NEW/$b" && continue
  if ! grep -q '^metadata:' "$f"; then echo "NO METADATA BLOCK: $b" >&2; continue; fi
  awk -v ts="$TS" -v from="$OLD" '
    /^metadata:$/ && !done {
      print
      print "  archived_at: \"" ts "\""
      print "  archived_reason: merge-drift"
      print "  archived_from: \"" from "\""
      done=1; next
    }
    { print }
  ' "$f" > "$ARCHIVE/$STAMP-$b"
  n=$((n+1))
done
echo "archived $n merge-drift variants"
```

Expected: `archived 70 merge-drift variants`, and no `NO METADATA BLOCK` lines (all 70 were verified
to have one). Any such line is a note to handle by hand — do not let the loop swallow it.

- [ ] **Step 3: Flatten the nested decisions dir**

```bash
V=~/IdeaProjects/obsidian_vault
ls "$V/decisions/decisions"/*.md | wc -l    # expect 4
git -C "$V" mv "$V/decisions/decisions"/*.md "$V/decisions/" 2>/dev/null || mv "$V/decisions/decisions"/*.md "$V/decisions/"
rmdir "$V/decisions/decisions"
ls "$V/decisions"/*.md | wc -l              # expect 4
```

The nesting is a `cp -r` artifact from the merge, not a code bug: `wavevault` resolves
`CollDecisions` under the vault root, so nothing writes a nested path.

- [ ] **Step 4: Merge the steering divergence by hand**

```bash
diff ~/.waveterm/vault/steering/AGENTS.md ~/IdeaProjects/obsidian_vault/steering/AGENTS.md
```

The retired copy is a superset: it carries a "From Claude Code" tail line and a "From Pi" block the
vault copy lacks, and orders one "Match process weight to the work" bullet differently. Append the
two missing sections to `~/IdeaProjects/obsidian_vault/steering/AGENTS.md`, keeping the vault copy's
existing "Environment & Git section" heading and its ordering. Ignore the bullet-order difference.
Read both files fully before editing — this is one file and is not worth scripting.

- [ ] **Step 5: Move the retired root aside**

```bash
mv ~/.waveterm/vault ~/.waveterm/vault-retired-$(date -u +%Y%m%d)
ls ~/.waveterm/
```

Moved, not deleted: the 279 identical notes are already in the vault, the 70 divergent ones are in
the archive, and the 1 remaining note is already archived as `drift`. Nothing is lost, and the
dormant root can no longer be resurrected by a lost last-root marker.

- [ ] **Step 6: Verify and commit the vault**

```bash
V=~/IdeaProjects/obsidian_vault
git -C "$V" status --porcelain | head -20
git -C "$V" diff --stat
ls "$V/memory"/*.md | wc -l   # expect 873 — this task adds and removes no memory notes
```

Expected changes: 4 decisions files moved up a level, 1 steering file edited. The memory collection
is untouched (the archive is outside the vault). If `git diff --stat` shows anything else, stop and
investigate rather than committing.

```bash
git -C "$V" add -A
git -C "$V" commit -m "vault: flatten nested decisions and merge steering divergence"
```

- [ ] **Step 7: Commit (repository)**

This task changes no repository files, so there is nothing to commit in the repo. Record the outcome
in the task's completion note instead: notes archived, decisions flattened, steering merged, retired
root moved to its dated path.

---

## Self-review

**Spec coverage**

| Spec section | Task |
|---|---|
| Slice 1 — The signal | Tasks 1, 2 |
| Slice 2 — Decay, and the 67 | Task 3 |
| Slice 3 — Reach | Task 4 |
| Slice 4 — De-fragmentation | Task 5 |
| Slice 5 — Measurement and budget | Tasks 6 (stats, budget), 7 (Records tab) |
| Slice 6 — Merge residue | Task 8 |
| Chunk 9 — declined | no task, by decision |

**Parallelism:** Tasks 1, 4, 7 and 8 start with no dependencies — four lanes. Tasks 2, 3 and 5 open
once Task 1 merges (three more); Task 6 waits on Task 1 and Task 4. Two serial edges are not real
code dependencies and are recorded here so they are not mistaken for one: Task 6 → Task 4, because
both regenerate the same three files, and Task 5 → Task 1, because both would otherwise make the
same one-line `ArchiveDir` change.

**Type consistency:** `TouchReferencedByID(ids []string, ts string) error` is defined in Task 1 and
consumed in Task 2 via the `stampReferences` seam. `RecallEpoch() time.Time` is defined in Task 1 and
consumed in Task 3 (`g.epochFn`) and Task 6 (`GatherStats`). `Note.ReferenceCount` is defined in Task
1 and read in Task 6. `ArchiveDir` becomes a var in Task 1 and is redirected by the tests in Tasks 3
and 5, both of which depend on Task 1 — no task makes that edit twice. `exportToHub` gains its third
parameter in Task 4, and both its callers (`Project` and the new test) pass it there.
`classifyDecay` gains its fourth parameter in Task 3, which also updates the one existing call site
and the one existing test.
