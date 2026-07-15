# Batch Memory Distillation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move memory distillation off the per-session `SessionEnd` hook into a wavesrv-owned, per-cwd batch queue that distills several sessions in one `claude -p` pass.

**Architecture:** The `SessionEnd` hook becomes a cheap wshrpc enqueue. wavesrv (`pkg/memdistill`) keeps a persistent per-cwd pending queue; when a bucket reaches a size threshold or a max-age backstop, it distills that bucket's transcript tails in a single combined `claude -p` call and routes the learnings through the existing memory write path. The batch's own headless transcript is filtered out of the Sessions tab.

**Tech Stack:** Go (wavesrv, wsh, wshrpc), SQLite-adjacent JSON file for the queue, `claude` CLI for distillation.

## Global Constraints

- Copyright header on every new Go file: `// Copyright 2026, Command Line Inc.` / `// SPDX-License-Identifier: Apache-2.0`.
- Never hand-edit generated files (`pkg/wshrpc/wshclient/wshclient.go`, `frontend/app/store/wshclientapi.ts`, `frontend/types/gotypes.d.ts`). Edit Go definitions, then run `task generate`.
- Hooks and background jobs must be **fail-safe**: any error is logged/swallowed, never propagated in a way that breaks an agent turn.
- Go tests: `go test ./pkg/<pkg>/` (single package) or `go test ./pkg/...`.
- Model IDs: cheaper = `claude-haiku-4-5`; 1M-context = `claude-sonnet-5`.
- Defaults: threshold `N = 8`, `maxAge = 24h`, `combinedBudget = 400 * 1024`, tick interval `1h`, flush timeout `110s`, enqueue RPC timeout `5000ms`.
- Recursion guard env var must be identical everywhere it is read/written: `WAVETERM_MEMORY_DISTILL` (exported as `memdistill.DistillGuardVar`).

---

### Task 1: Extract `memvault.RouteLearnings`

Pull the routing body of `MemoryLearnCommand` into a reusable `memvault` function so both the wshrpc handler and the batch flush share one code path.

**Files:**
- Modify: `pkg/memvault/learn.go` (add `RouteLearnings`)
- Modify: `pkg/wshrpc/wshserver/wshserver.go:1550-1587` (`MemoryLearnCommand` delegates)
- Test: `pkg/memvault/route_test.go` (create)

**Interfaces:**
- Consumes: existing `memvault.LearnCandidate`, `memvault.WriteLearning`, `memvault.WritePending`, `memvault.MarkSuperseded`, `memvault.TouchReferenced`, `memvault.HubDirForCwd`, `memvault.DefaultVaultPath`, `memvault.PendingDir`.
- Produces: `func RouteLearnings(cwd string, candidates []LearnCandidate, references []string) (committed int, queued int, err error)`.

- [ ] **Step 1: Write the failing test**

Create `pkg/memvault/route_test.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package memvault

import "testing"

func TestRouteLearnings_CorrectionCommitsNonCorrectionQueues(t *testing.T) {
	// no cwd -> hub is "" -> corrections go to the default vault, non-corrections to the pending tray.
	// We only assert the returned counts here; storage side effects are covered by existing learn tests.
	cands := []LearnCandidate{
		{Type: "feedback", Body: "always run the typechecker with the stack-size flag", IsCorrection: true},
		{Type: "learning", Body: "the sessions scanner walks ~/.claude/projects", IsCorrection: false},
	}
	committed, queued, err := RouteLearnings("", cands, nil)
	if err != nil {
		t.Fatalf("RouteLearnings error: %v", err)
	}
	if committed != 1 {
		t.Errorf("committed = %d, want 1", committed)
	}
	if queued != 1 {
		t.Errorf("queued = %d, want 1", queued)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./pkg/memvault/ -run TestRouteLearnings -v`
Expected: FAIL — `undefined: RouteLearnings`.

- [ ] **Step 3: Add `RouteLearnings` to `pkg/memvault/learn.go`**

Append to `pkg/memvault/learn.go` (add `"time"` to imports if not present — it already is):

```go
// RouteLearnings writes distilled candidates into memory: corrections auto-commit into the project
// hub (or the default vault when cwd has no hub), everything else lands in the review tray. Supersedes
// and references are applied against the hub. Shared by MemoryLearnCommand and batch distillation.
func RouteLearnings(cwd string, candidates []LearnCandidate, references []string) (int, int, error) {
	hub := HubDirForCwd(cwd)
	committed, queued := 0, 0
	for _, cand := range candidates {
		if cand.IsCorrection {
			target := hub
			if target == "" {
				target = DefaultVaultPath()
			}
			wrote, _, err := WriteLearning(target, cand)
			if err != nil {
				return committed, queued, err
			}
			if wrote {
				committed++
			}
		} else {
			if _, err := WritePending(PendingDir(), cand, cwd); err != nil {
				return committed, queued, err
			}
			queued++
		}
	}
	if hub != "" {
		for _, cand := range candidates {
			if cand.Supersedes != "" {
				_, slug, _ := WriteLearning(hub, LearnCandidate{Type: cand.Type, Scope: cand.Scope, Body: cand.Body})
				_ = MarkSuperseded(hub, cand.Supersedes, slug)
			}
		}
		if len(references) > 0 {
			_ = TouchReferenced(hub, references, time.Now().UTC().Format(time.RFC3339))
		}
	}
	return committed, queued, nil
}
```

- [ ] **Step 4: Point `MemoryLearnCommand` at the shared helper**

Replace the body of `MemoryLearnCommand` in `pkg/wshrpc/wshserver/wshserver.go` (lines 1550-1587) with:

```go
func (ws *WshServer) MemoryLearnCommand(ctx context.Context, data wshrpc.CommandMemoryLearnData) (*wshrpc.CommandMemoryLearnRtnData, error) {
	cands := make([]memvault.LearnCandidate, len(data.Candidates))
	for i, c := range data.Candidates {
		cands[i] = memvault.LearnCandidate{Type: c.Type, Scope: c.Scope, Body: c.Body, IsCorrection: c.IsCorrection, Supersedes: c.Supersedes}
	}
	committed, queued, err := memvault.RouteLearnings(data.Cwd, cands, data.References)
	if err != nil {
		return nil, err
	}
	return &wshrpc.CommandMemoryLearnRtnData{Committed: committed, Queued: queued}, nil
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `go test ./pkg/memvault/ -run TestRouteLearnings -v && go test ./pkg/wshrpc/wshserver/ -run MemoryLearn -v`
Expected: PASS for the new test and the existing `pkg/wshrpc/wshserver/memory_learn_test.go`.

- [ ] **Step 6: Commit**

```bash
git add pkg/memvault/learn.go pkg/memvault/route_test.go pkg/wshrpc/wshserver/wshserver.go
git commit -m "refactor(memvault): extract RouteLearnings from MemoryLearnCommand"
```

---

### Task 2: `memdistill` queue store

The persistent per-cwd pending queue: load/save a JSON file, enqueue with per-path dedup, and hold the last-known-good claude path.

**Files:**
- Create: `pkg/memdistill/queue.go`
- Test: `pkg/memdistill/queue_test.go`

**Interfaces:**
- Produces:
  - `type pendingSession struct { TranscriptPath string; EnqueuedAt string }` (JSON tags `transcriptpath`, `enqueuedat`)
  - `type queueState struct { ClaudePath string; Buckets map[string][]pendingSession }` (JSON tags `claudepath`, `buckets`)
  - `func loadQueue(path string) queueState`
  - `func saveQueue(path string, st queueState) error`
  - `func addPending(st *queueState, cwd, transcriptPath, claudePath, enqueuedAt string)` — appends unless `transcriptPath` already in that bucket; updates `ClaudePath` when non-empty.

- [ ] **Step 1: Write the failing test**

Create `pkg/memdistill/queue_test.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package memdistill

import (
	"path/filepath"
	"testing"
)

func TestAddPending_DedupesByPath(t *testing.T) {
	st := queueState{Buckets: map[string][]pendingSession{}}
	addPending(&st, "/repo/a", "/t/1.jsonl", "/usr/bin/claude", "2026-07-15T00:00:00Z")
	addPending(&st, "/repo/a", "/t/1.jsonl", "", "2026-07-15T00:01:00Z") // duplicate path
	addPending(&st, "/repo/a", "/t/2.jsonl", "", "2026-07-15T00:02:00Z")
	if got := len(st.Buckets["/repo/a"]); got != 2 {
		t.Fatalf("bucket size = %d, want 2 (dupe path ignored)", got)
	}
	if st.ClaudePath != "/usr/bin/claude" {
		t.Errorf("ClaudePath = %q, want it preserved from the first non-empty enqueue", st.ClaudePath)
	}
}

func TestSaveLoadQueue_RoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "queue.json")
	st := queueState{ClaudePath: "/c", Buckets: map[string][]pendingSession{
		"/repo/a": {{TranscriptPath: "/t/1.jsonl", EnqueuedAt: "2026-07-15T00:00:00Z"}},
	}}
	if err := saveQueue(path, st); err != nil {
		t.Fatalf("saveQueue: %v", err)
	}
	got := loadQueue(path)
	if got.ClaudePath != "/c" || len(got.Buckets["/repo/a"]) != 1 {
		t.Fatalf("round-trip mismatch: %+v", got)
	}
}

func TestLoadQueue_MissingFileIsEmpty(t *testing.T) {
	got := loadQueue(filepath.Join(t.TempDir(), "does-not-exist.json"))
	if got.Buckets == nil || len(got.Buckets) != 0 {
		t.Fatalf("missing file should load empty non-nil buckets, got %+v", got)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./pkg/memdistill/ -run TestAddPending -v`
Expected: FAIL — package/symbols not defined.

- [ ] **Step 3: Write `pkg/memdistill/queue.go`**

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Package memdistill owns the per-cwd pending-session queue and the batch distillation that turns
// finished coding sessions into memory. wavesrv enqueues sessions (via the SessionEnd hook over
// wshrpc) and this package flushes each cwd bucket through a single combined `claude -p` pass.
package memdistill

import (
	"encoding/json"
	"os"
)

type pendingSession struct {
	TranscriptPath string `json:"transcriptpath"`
	EnqueuedAt     string `json:"enqueuedat"` // RFC3339 UTC
}

type queueState struct {
	ClaudePath string                      `json:"claudepath"`
	Buckets    map[string][]pendingSession `json:"buckets"`
}

// loadQueue reads path; a missing or unparseable file yields an empty (non-nil) state.
func loadQueue(path string) queueState {
	st := queueState{Buckets: map[string][]pendingSession{}}
	b, err := os.ReadFile(path)
	if err != nil {
		return st
	}
	if json.Unmarshal(b, &st) != nil || st.Buckets == nil {
		return queueState{Buckets: map[string][]pendingSession{}}
	}
	return st
}

// saveQueue writes st atomically (temp file + rename).
func saveQueue(path string, st queueState) error {
	b, err := json.MarshalIndent(st, "", "  ")
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// addPending appends the session to its cwd bucket unless transcriptPath is already queued there.
// A non-empty claudePath refreshes the last-known-good path.
func addPending(st *queueState, cwd, transcriptPath, claudePath, enqueuedAt string) {
	if st.Buckets == nil {
		st.Buckets = map[string][]pendingSession{}
	}
	if claudePath != "" {
		st.ClaudePath = claudePath
	}
	for _, p := range st.Buckets[cwd] {
		if p.TranscriptPath == transcriptPath {
			return
		}
	}
	st.Buckets[cwd] = append(st.Buckets[cwd], pendingSession{TranscriptPath: transcriptPath, EnqueuedAt: enqueuedAt})
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./pkg/memdistill/ -v`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add pkg/memdistill/queue.go pkg/memdistill/queue_test.go
git commit -m "feat(memdistill): persistent per-cwd pending queue"
```

---

### Task 3: `memdistill` distillation (prompt, tail, corpus, parse)

The distillation mechanics: the batch prompt + sentinel, reading a capped transcript tail, assembling the combined corpus with a chosen model, and tolerant JSON parsing into `memvault.LearnCandidate`.

**Files:**
- Create: `pkg/memdistill/distill.go`
- Test: `pkg/memdistill/distill_test.go`

**Interfaces:**
- Consumes: `memvault.LearnCandidate`.
- Produces:
  - `const DistillGuardVar = "WAVETERM_MEMORY_DISTILL"`
  - `const DistillSentinel = "You are distilling durable learnings from"`
  - `const batchDistillPrompt string` (begins with `DistillSentinel`)
  - `const combinedBudget = 400 * 1024`
  - `func readTail(path string, maxBytes int64) string`
  - `func buildCorpus(sessions []pendingSession) (corpus string, model string)`
  - `func parseDistillOutput(raw string) (cands []memvault.LearnCandidate, refs []string, ok bool)`
  - `func runDistill(claudePath, model, corpus string) (raw string, ok bool)` (spawns `claude -p`; not unit-tested)

- [ ] **Step 1: Write the failing test**

Create `pkg/memdistill/distill_test.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package memdistill

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestBatchPromptStartsWithSentinel(t *testing.T) {
	if !strings.HasPrefix(batchDistillPrompt, DistillSentinel) {
		t.Fatalf("batchDistillPrompt must start with DistillSentinel so the Sessions filter matches")
	}
}

func TestReadTail_ReturnsLastBytes(t *testing.T) {
	path := filepath.Join(t.TempDir(), "t.jsonl")
	if err := os.WriteFile(path, []byte("0123456789"), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := readTail(path, 4); got != "6789" {
		t.Errorf("readTail = %q, want %q", got, "6789")
	}
	if got := readTail(path, 100); got != "0123456789" {
		t.Errorf("readTail (over-size) = %q, want whole file", got)
	}
}

func TestBuildCorpus_CapsPerSessionAndPicksModel(t *testing.T) {
	dir := t.TempDir()
	var sessions []pendingSession
	// two sessions, each larger than half the budget, so each gets truncated to budget/2
	big := strings.Repeat("x", combinedBudget)
	for i, name := range []string{"a.jsonl", "b.jsonl"} {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, []byte(big), 0o644); err != nil {
			t.Fatal(err)
		}
		sessions = append(sessions, pendingSession{TranscriptPath: p, EnqueuedAt: "2026-07-15T00:0" + string(rune('0'+i)) + ":00Z"})
	}
	corpus, model := buildCorpus(sessions)
	if len(corpus) > combinedBudget+512 { // +separators headroom
		t.Errorf("corpus length %d exceeds budget", len(corpus))
	}
	if model != "claude-sonnet-5" {
		t.Errorf("model = %q, want claude-sonnet-5 for a budget-filling corpus", model)
	}
}

func TestParseDistillOutput_TolerantAndMapped(t *testing.T) {
	raw := "here is your json:\n{\"candidates\":[{\"type\":\"feedback\",\"body\":\"b\",\"iscorrection\":true}],\"references\":[\"slug-1\"]}\nthanks"
	cands, refs, ok := parseDistillOutput(raw)
	if !ok || len(cands) != 1 || !cands[0].IsCorrection || cands[0].Body != "b" {
		t.Fatalf("parse failed: ok=%v cands=%+v", ok, cands)
	}
	if len(refs) != 1 || refs[0] != "slug-1" {
		t.Errorf("refs = %+v, want [slug-1]", refs)
	}
}

func TestParseDistillOutput_NoJSON(t *testing.T) {
	if _, _, ok := parseDistillOutput("no json here"); ok {
		t.Errorf("expected ok=false when there is no JSON object")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./pkg/memdistill/ -run 'TestBatchPrompt|TestReadTail|TestBuildCorpus|TestParse' -v`
Expected: FAIL — symbols not defined.

- [ ] **Step 3: Write `pkg/memdistill/distill.go`**

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package memdistill

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/memvault"
)

const (
	// DistillGuardVar marks the headless distill sub-session so its own SessionEnd hook no-ops
	// instead of enqueuing itself.
	DistillGuardVar = "WAVETERM_MEMORY_DISTILL"
	// DistillSentinel is the stable leading text of the distill prompt. The Sessions scanner filters
	// any session whose first prompt starts with it, hiding the headless distill transcript.
	DistillSentinel = "You are distilling durable learnings from"

	combinedBudget = 400 * 1024 // ~150K tokens; at/above this, use the 1M-context model
	haikuModel     = "claude-haiku-4-5"
	sonnetModel    = "claude-sonnet-5"
	flushTimeout   = 110 * time.Second
)

const batchDistillPrompt = DistillSentinel + " multiple finished coding sessions from one project, " +
	"concatenated and separated by lines like '===== SESSION n ====='. Merge and dedup learnings across " +
	`them. Output ONLY a JSON object: {"candidates":[{"type","scope","body","iscorrection","supersedes"}],"references":[]}. ` +
	"type is one of: feedback | learning | project | reference. " +
	`Set iscorrection=true ONLY for an explicit correction the user gave ("no, do it this way"). ` +
	"supersedes: the slug of an existing memory this learning replaces, or omit. " +
	"references: slugs of existing memories the sessions clearly relied on. " +
	`Extract only durable, reusable learnings. If none, return {"candidates":[],"references":[]}.`

// readTail returns the last maxBytes of path (whole file when smaller). Any error yields "".
func readTail(path string, maxBytes int64) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return ""
	}
	start := int64(0)
	if st.Size() > maxBytes {
		start = st.Size() - maxBytes
	}
	if _, err := f.Seek(start, io.SeekStart); err != nil {
		return ""
	}
	b, err := io.ReadAll(f)
	if err != nil {
		return ""
	}
	return string(b)
}

// buildCorpus reads a capped tail of each session (combinedBudget split evenly) and joins them with
// labeled separators. The model is chosen on the assembled size, mirroring the single-session cutoff.
func buildCorpus(sessions []pendingSession) (string, string) {
	if len(sessions) == 0 {
		return "", haikuModel
	}
	perSession := int64(combinedBudget / len(sessions))
	var b strings.Builder
	for i, s := range sessions {
		fmt.Fprintf(&b, "\n\n===== SESSION %d (%s) =====\n\n", i+1, s.TranscriptPath)
		b.WriteString(readTail(s.TranscriptPath, perSession))
	}
	corpus := b.String()
	model := haikuModel
	if len(corpus) >= combinedBudget {
		model = sonnetModel
	}
	return corpus, model
}

type distillOutput struct {
	Candidates []struct {
		Type         string `json:"type"`
		Scope        string `json:"scope"`
		Body         string `json:"body"`
		IsCorrection bool   `json:"iscorrection"`
		Supersedes   string `json:"supersedes"`
	} `json:"candidates"`
	References []string `json:"references"`
}

// parseDistillOutput extracts the first {...} block and maps it to memvault candidates. ok is false
// on no-JSON / parse failure.
func parseDistillOutput(raw string) ([]memvault.LearnCandidate, []string, bool) {
	i := strings.IndexByte(raw, '{')
	j := strings.LastIndexByte(raw, '}')
	if i < 0 || j <= i {
		return nil, nil, false
	}
	var out distillOutput
	if json.Unmarshal([]byte(raw[i:j+1]), &out) != nil {
		return nil, nil, false
	}
	cands := make([]memvault.LearnCandidate, len(out.Candidates))
	for k, c := range out.Candidates {
		cands[k] = memvault.LearnCandidate{Type: c.Type, Scope: c.Scope, Body: c.Body, IsCorrection: c.IsCorrection, Supersedes: c.Supersedes}
	}
	return cands, out.References, true
}

// runDistill spawns the headless `claude -p` pass. claudePath falls back to "claude" on PATH.
func runDistill(claudePath, model, corpus string) (string, bool) {
	exe := claudePath
	if exe == "" {
		exe = "claude"
	}
	ctx, cancel := context.WithTimeout(context.Background(), flushTimeout)
	defer cancel()
	c := exec.CommandContext(ctx, exe, "-p", "--model", model, batchDistillPrompt)
	c.Stdin = strings.NewReader(corpus)
	c.Env = append(os.Environ(), DistillGuardVar+"=1")
	stdout, err := c.Output()
	if err != nil {
		return "", false
	}
	return string(stdout), true
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./pkg/memdistill/ -v`
Expected: PASS (queue tests + distill tests).

- [ ] **Step 5: Commit**

```bash
git add pkg/memdistill/distill.go pkg/memdistill/distill_test.go
git commit -m "feat(memdistill): batch prompt, capped-tail corpus, tolerant parse"
```

---

### Task 4: `memdistill` coordinator (enqueue, trigger, flush, start)

Ties the queue and distillation together: the `distiller` struct with enqueue, trigger evaluation, single-flight flush, sweep, and the package-level `Enqueue`/`Start` entrypoints. Injectable `distillFn`/`routeFn`/`now` make flush testable without spawning `claude`.

**Files:**
- Create: `pkg/memdistill/coordinator.go`
- Test: `pkg/memdistill/coordinator_test.go`

**Interfaces:**
- Consumes: `loadQueue`, `saveQueue`, `addPending`, `buildCorpus`, `runDistill`, `parseDistillOutput`, `memvault.RouteLearnings`, `wavebase.GetWaveDataDir`.
- Produces:
  - `const thresholdN = 8`, `const maxAge = 24 * time.Hour`, `const tickInterval = time.Hour`
  - `type distiller struct { ... }` with `newDistiller(path string) *distiller`
  - methods: `(*distiller) enqueue(cwd, transcriptPath, claudePath string)`, `(*distiller) maybeFlush(cwd string)`, `(*distiller) flush(cwd string)`, `(*distiller) sweep()`
  - `func shouldFlush(sessions []pendingSession, now time.Time) bool`
  - package funcs: `func Enqueue(cwd, transcriptPath, claudePath string)`, `func Start(ctx context.Context)`

- [ ] **Step 1: Write the failing test**

Create `pkg/memdistill/coordinator_test.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package memdistill

import (
	"path/filepath"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/memvault"
)

func mkTime(s string) time.Time {
	t, _ := time.Parse(time.RFC3339, s)
	return t
}

func TestShouldFlush_ThresholdAndMaxAge(t *testing.T) {
	now := mkTime("2026-07-15T12:00:00Z")
	var eight []pendingSession
	for i := 0; i < 8; i++ {
		eight = append(eight, pendingSession{EnqueuedAt: "2026-07-15T11:59:00Z"})
	}
	if !shouldFlush(eight, now) {
		t.Error("8 fresh sessions should flush on threshold")
	}
	old := []pendingSession{{EnqueuedAt: "2026-07-14T00:00:00Z"}} // >24h old
	if !shouldFlush(old, now) {
		t.Error("a single >maxAge session should flush on backstop")
	}
	fresh := []pendingSession{{EnqueuedAt: "2026-07-15T11:59:00Z"}}
	if shouldFlush(fresh, now) {
		t.Error("one fresh session should not flush")
	}
	if shouldFlush(nil, now) {
		t.Error("empty bucket should not flush")
	}
}

func TestFlush_RoutesAndClearsBucket(t *testing.T) {
	path := filepath.Join(t.TempDir(), "q.json")
	d := newDistiller(path)
	var routedCwd string
	var routedBodies []string
	d.distillFn = func(claudePath, model, corpus string) (string, bool) {
		return `{"candidates":[{"type":"feedback","body":"x","iscorrection":true}],"references":[]}`, true
	}
	d.routeFn = func(cwd string, cands []memvault.LearnCandidate, refs []string) (int, int, error) {
		routedCwd = cwd
		for _, c := range cands {
			routedBodies = append(routedBodies, c.Body)
		}
		return len(cands), 0, nil
	}
	d.enqueue("/repo/a", "/t/1.jsonl", "/usr/bin/claude") // writes queue, no flush (below threshold)
	d.flush("/repo/a")
	if routedCwd != "/repo/a" || len(routedBodies) != 1 || routedBodies[0] != "x" {
		t.Fatalf("flush did not route candidates: cwd=%q bodies=%+v", routedCwd, routedBodies)
	}
	if got := loadQueue(path); len(got.Buckets["/repo/a"]) != 0 {
		t.Errorf("bucket not cleared after flush: %+v", got.Buckets["/repo/a"])
	}
}

func TestFlush_KeepsBucketOnDistillFailure(t *testing.T) {
	path := filepath.Join(t.TempDir(), "q.json")
	d := newDistiller(path)
	d.distillFn = func(claudePath, model, corpus string) (string, bool) { return "", false }
	routed := false
	d.routeFn = func(string, []memvault.LearnCandidate, []string) (int, int, error) { routed = true; return 0, 0, nil }
	d.enqueue("/repo/a", "/t/1.jsonl", "")
	d.flush("/repo/a")
	if routed {
		t.Error("routeFn must not run when distill fails")
	}
	if got := loadQueue(path); len(got.Buckets["/repo/a"]) != 1 {
		t.Error("bucket must be retained when distill fails")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./pkg/memdistill/ -run 'TestShouldFlush|TestFlush' -v`
Expected: FAIL — symbols not defined.

- [ ] **Step 3: Write `pkg/memdistill/coordinator.go`**

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package memdistill

import (
	"context"
	"log"
	"path/filepath"
	"sync"
	"time"

	"github.com/wavetermdev/waveterm/pkg/memvault"
	"github.com/wavetermdev/waveterm/pkg/wavebase"
)

const (
	thresholdN   = 8
	maxAge       = 24 * time.Hour
	tickInterval = time.Hour
	queueFile    = "memory-distill-queue.json"
)

type distiller struct {
	mu        sync.Mutex
	path      string
	inflight  map[string]bool
	distillFn func(claudePath, model, corpus string) (string, bool)
	routeFn   func(cwd string, cands []memvault.LearnCandidate, refs []string) (int, int, error)
	now       func() time.Time
}

func newDistiller(path string) *distiller {
	return &distiller{
		path:      path,
		inflight:  map[string]bool{},
		distillFn: runDistill,
		routeFn:   memvault.RouteLearnings,
		now:       time.Now,
	}
}

// shouldFlush reports whether a bucket has reached the size threshold or its oldest entry is past maxAge.
func shouldFlush(sessions []pendingSession, now time.Time) bool {
	if len(sessions) == 0 {
		return false
	}
	if len(sessions) >= thresholdN {
		return true
	}
	if ts, err := time.Parse(time.RFC3339, sessions[0].EnqueuedAt); err == nil {
		return now.Sub(ts) >= maxAge
	}
	return false
}

func (d *distiller) enqueue(cwd, transcriptPath, claudePath string) {
	d.mu.Lock()
	st := loadQueue(d.path)
	addPending(&st, cwd, transcriptPath, claudePath, d.now().UTC().Format(time.RFC3339))
	if err := saveQueue(d.path, st); err != nil {
		log.Printf("[memdistill] save queue: %v\n", err)
	}
	d.mu.Unlock()
	d.maybeFlush(cwd)
}

// maybeFlush launches a single-flight background flush when the bucket is due.
func (d *distiller) maybeFlush(cwd string) {
	d.mu.Lock()
	st := loadQueue(d.path)
	due := shouldFlush(st.Buckets[cwd], d.now()) && !d.inflight[cwd]
	if due {
		d.inflight[cwd] = true
	}
	d.mu.Unlock()
	if due {
		go d.flush(cwd)
	}
}

// flush distills the cwd bucket and, on success, routes the learnings and clears the bucket. Errors
// leave the bucket for a later retry. Always releases the single-flight slot.
func (d *distiller) flush(cwd string) {
	defer func() {
		d.mu.Lock()
		delete(d.inflight, cwd)
		d.mu.Unlock()
	}()

	d.mu.Lock()
	st := loadQueue(d.path)
	sessions := append([]pendingSession(nil), st.Buckets[cwd]...)
	claudePath := st.ClaudePath
	d.mu.Unlock()
	if len(sessions) == 0 {
		return
	}

	corpus, model := buildCorpus(sessions)
	raw, ok := d.distillFn(claudePath, model, corpus)
	if !ok {
		return
	}
	cands, refs, ok := parseDistillOutput(raw)
	if !ok {
		return
	}
	if len(cands) > 0 || len(refs) > 0 {
		if _, _, err := d.routeFn(cwd, cands, refs); err != nil {
			log.Printf("[memdistill] route learnings: %v\n", err)
			return
		}
	}

	// clear only the sessions we distilled; anything enqueued during the flush is preserved.
	distilled := map[string]bool{}
	for _, s := range sessions {
		distilled[s.TranscriptPath] = true
	}
	d.mu.Lock()
	st = loadQueue(d.path)
	var kept []pendingSession
	for _, s := range st.Buckets[cwd] {
		if !distilled[s.TranscriptPath] {
			kept = append(kept, s)
		}
	}
	if len(kept) == 0 {
		delete(st.Buckets, cwd)
	} else {
		st.Buckets[cwd] = kept
	}
	if err := saveQueue(d.path, st); err != nil {
		log.Printf("[memdistill] save queue after flush: %v\n", err)
	}
	d.mu.Unlock()
}

// sweep evaluates every bucket against both trigger conditions (backstop + failed-flush retry).
func (d *distiller) sweep() {
	d.mu.Lock()
	st := loadQueue(d.path)
	cwds := make([]string, 0, len(st.Buckets))
	for cwd := range st.Buckets {
		cwds = append(cwds, cwd)
	}
	d.mu.Unlock()
	for _, cwd := range cwds {
		d.maybeFlush(cwd)
	}
}

var (
	defaultDistiller *distiller
	startOnce        sync.Once
)

func ensure() {
	startOnce.Do(func() {
		defaultDistiller = newDistiller(filepath.Join(wavebase.GetWaveDataDir(), queueFile))
	})
}

// Enqueue records a finished session for later batch distillation.
func Enqueue(cwd, transcriptPath, claudePath string) {
	ensure()
	defaultDistiller.enqueue(cwd, transcriptPath, claudePath)
}

// Start runs a startup sweep and an hourly backstop sweep until ctx is cancelled.
func Start(ctx context.Context) {
	ensure()
	go func() {
		defaultDistiller.sweep()
		t := time.NewTicker(tickInterval)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				defaultDistiller.sweep()
			}
		}
	}()
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./pkg/memdistill/ -v`
Expected: PASS (all memdistill tests).

- [ ] **Step 5: Commit**

```bash
git add pkg/memdistill/coordinator.go pkg/memdistill/coordinator_test.go
git commit -m "feat(memdistill): coordinator with threshold/max-age flush and single-flight"
```

---

### Task 5: `MemoryEnqueueSessionCommand` wshrpc

Add the wire command the hook calls; the handler delegates to `memdistill.Enqueue`.

**Files:**
- Modify: `pkg/wshrpc/wshrpctypes.go` (interface method + data type, near lines 107-110 and 1042)
- Modify: `pkg/wshrpc/wshserver/wshserver.go` (handler, near the other Memory* handlers)
- Regenerate: `pkg/wshrpc/wshclient/wshclient.go`, `frontend/app/store/wshclientapi.ts`, `frontend/types/gotypes.d.ts` (via `task generate` — do not hand-edit)

**Interfaces:**
- Consumes: `memdistill.Enqueue`.
- Produces:
  - `type CommandMemoryEnqueueSessionData struct { Cwd string; TranscriptPath string; ClaudePath string }` (JSON tags `cwd`, `transcriptpath`, `claudepath`)
  - interface method `MemoryEnqueueSessionCommand(ctx context.Context, data CommandMemoryEnqueueSessionData) error`
  - generated client `wshclient.MemoryEnqueueSessionCommand(w *wshutil.WshRpc, data wshrpc.CommandMemoryEnqueueSessionData, opts *wshrpc.RpcOpts) error`

- [ ] **Step 1: Add the data type to `pkg/wshrpc/wshrpctypes.go`**

Immediately after `CommandMemoryLearnRtnData` (around line 1051), add:

```go
type CommandMemoryEnqueueSessionData struct {
	Cwd            string `json:"cwd"`
	TranscriptPath string `json:"transcriptpath"`
	ClaudePath     string `json:"claudepath"`
}
```

- [ ] **Step 2: Add the interface method**

In the `WshRpcInterface` interface, immediately after the `MemoryLearnCommand` line (line 110), add:

```go
	MemoryEnqueueSessionCommand(ctx context.Context, data CommandMemoryEnqueueSessionData) error
```

- [ ] **Step 3: Implement the handler in `pkg/wshrpc/wshserver/wshserver.go`**

After `MemoryLearnCommand` (after line 1587), add (and ensure `memdistill` is imported — add `"github.com/wavetermdev/waveterm/pkg/memdistill"` to the import block):

```go
func (ws *WshServer) MemoryEnqueueSessionCommand(ctx context.Context, data wshrpc.CommandMemoryEnqueueSessionData) error {
	memdistill.Enqueue(data.Cwd, data.TranscriptPath, data.ClaudePath)
	return nil
}
```

- [ ] **Step 4: Regenerate bindings**

Run: `task generate`
Expected: `wshclient.go` gains `MemoryEnqueueSessionCommand`; TS types regenerate. No manual edits.

- [ ] **Step 5: Verify it compiles and the client fn exists**

Run: `go build ./... && grep -n "func MemoryEnqueueSessionCommand" pkg/wshrpc/wshclient/wshclient.go`
Expected: build succeeds; grep prints the generated function.

- [ ] **Step 6: Commit**

```bash
git add pkg/wshrpc/wshrpctypes.go pkg/wshrpc/wshserver/wshserver.go pkg/wshrpc/wshclient/wshclient.go frontend/app/store/wshclientapi.ts frontend/types/gotypes.d.ts
git commit -m "feat(wshrpc): add MemoryEnqueueSessionCommand"
```

---

### Task 6: Rewrite the SessionEnd hook to enqueue

The hook stops distilling inline; it resolves the claude binary and sends the enqueue RPC. Also drop the moved constants/helpers and lower the hook timeout.

**Files:**
- Modify: `cmd/wsh/cmd/wshcmd-agent-memory-hook.go` (rewrite body; remove `distillPrompt`, `distill`, `readTranscriptTail`, model/tail consts)
- Modify: `cmd/wsh/cmd/wshcmd-installhooks.go:35` (SessionEnd timeout 120 → 10)
- Modify: `cmd/wsh/cmd/wshcmd-installhooks_test.go` (update the expected timeout if asserted)

**Interfaces:**
- Consumes: `wshclient.MemoryEnqueueSessionCommand`, `wshrpc.CommandMemoryEnqueueSessionData`, `memdistill.DistillGuardVar`, `wshutil.WaveJwtTokenVarName`, existing `setupRpcClient`, `RpcClient`.

- [ ] **Step 1: Rewrite `cmd/wsh/cmd/wshcmd-agent-memory-hook.go`**

Replace the whole file with:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"encoding/json"
	"io"
	"os"
	"os/exec"

	"github.com/spf13/cobra"
	"github.com/wavetermdev/waveterm/pkg/memdistill"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshrpc/wshclient"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
)

// SessionEnd enqueue hook. Records the finished session for wavesrv's batch memory distiller and
// returns immediately. Fail-safe: any problem returns nil so a hook never breaks the agent's turn.

// sessionEndEvent is the subset of the SessionEnd hook stdin payload we use.
type sessionEndEvent struct {
	TranscriptPath string `json:"transcript_path"`
	Cwd            string `json:"cwd"`
}

var agentMemoryHookCmd = &cobra.Command{
	Use:                   "agent-memory-hook",
	Short:                 "Claude Code SessionEnd hook: enqueue the session for batch memory distillation",
	Args:                  cobra.NoArgs,
	RunE:                  agentMemoryHookRun,
	Hidden:                true,
	DisableFlagsInUseLine: true,
	SilenceErrors:         true,
	SilenceUsage:          true,
}

func init() {
	rootCmd.AddCommand(agentMemoryHookCmd)
}

// agentMemoryHookRun always returns nil: a hook must never break the agent's turn.
func agentMemoryHookRun(cmd *cobra.Command, args []string) error {
	if os.Getenv(memdistill.DistillGuardVar) != "" {
		return nil // we are the headless distillation sub-session; don't enqueue ourselves
	}
	raw, err := io.ReadAll(os.Stdin)
	if err != nil {
		return nil
	}
	var ev sessionEndEvent
	if json.Unmarshal(raw, &ev) != nil || ev.TranscriptPath == "" {
		return nil
	}
	claudePath, _ := exec.LookPath("claude") // "" is fine; wavesrv falls back to PATH

	jwt := os.Getenv(wshutil.WaveJwtTokenVarName)
	if jwt == "" {
		return nil
	}
	if setupRpcClient(nil, jwt) != nil {
		return nil
	}
	_ = wshclient.MemoryEnqueueSessionCommand(RpcClient, wshrpc.CommandMemoryEnqueueSessionData{
		Cwd:            ev.Cwd,
		TranscriptPath: ev.TranscriptPath,
		ClaudePath:     claudePath,
	}, &wshrpc.RpcOpts{Timeout: 5000})
	return nil
}
```

- [ ] **Step 2: Lower the SessionEnd hook timeout**

In `cmd/wsh/cmd/wshcmd-installhooks.go` line 35, change:

```go
	{"SessionEnd", "", "agent-memory-hook", 120},
```
to:
```go
	{"SessionEnd", "", "agent-memory-hook", 10},
```

- [ ] **Step 3: Update the installhooks test if it asserts the timeout**

Run: `grep -n "120\|SessionEnd" cmd/wsh/cmd/wshcmd-installhooks_test.go`
If a test asserts `120` for SessionEnd, change it to `10`. If no such assertion exists, skip this step.

- [ ] **Step 4: Verify build and tests**

Run: `go build ./cmd/wsh/... && go test ./cmd/wsh/cmd/ -run InstallHooks -v`
Expected: build succeeds; installhooks tests pass.

- [ ] **Step 5: Commit**

```bash
git add cmd/wsh/cmd/wshcmd-agent-memory-hook.go cmd/wsh/cmd/wshcmd-installhooks.go cmd/wsh/cmd/wshcmd-installhooks_test.go
git commit -m "feat(wsh): SessionEnd hook enqueues for batch distillation"
```

---

### Task 7: Start the distiller in wavesrv

Launch the backstop sweep + ticker at wavesrv startup.

**Files:**
- Modify: `cmd/server/main-server.go` (add `memdistill.Start` near the other background service starts, ~line 574)

**Interfaces:**
- Consumes: `memdistill.Start`.

- [ ] **Step 1: Add the startup call**

In `cmd/server/main-server.go`, immediately after `blockcontroller.InitBlockController()` (line 574), add:

```go
	memdistill.Start(context.Background())
```

Add `"github.com/wavetermdev/waveterm/pkg/memdistill"` to the import block (`context` is already imported — it is used at line 542).

- [ ] **Step 2: Verify build**

Run: `go build ./cmd/server/...`
Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
git add cmd/server/main-server.go
git commit -m "feat(server): start batch memory distiller at boot"
```

---

### Task 8: Filter the distill phantom session from the Sessions tab

Drop any Claude session whose first prompt starts with the distill sentinel, so the headless batch transcript never appears in the Sessions tab. A drift test ties the filter to the live prompt constant.

**Files:**
- Modify: `pkg/agentsessions/agentsessions.go:67-100` (`extractClaudeSession`)
- Test: `pkg/agentsessions/distillfilter_test.go` (create)

**Interfaces:**
- Consumes: `memdistill.DistillSentinel` (test only), the existing `s.Task` field.

- [ ] **Step 1: Write the failing test**

Create `pkg/agentsessions/distillfilter_test.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package agentsessions

import (
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/memdistill"
)

// drift guard: the local sentinel must stay a prefix of the live batch prompt.
func TestDistillSentinelMatchesPrompt(t *testing.T) {
	if !strings.HasPrefix(memdistill.BatchDistillPromptForTest(), distillSessionSentinel) {
		t.Fatalf("distillSessionSentinel %q is no longer a prefix of the batch prompt", distillSessionSentinel)
	}
}

func TestExtractClaudeSession_DropsDistillSession(t *testing.T) {
	line := `{"type":"user","cwd":"/repo","message":{"content":"` + distillSessionSentinel + ` blah blah"}}`
	if s := extractClaudeSession("id1", []string{line}); s != nil {
		t.Fatalf("distill session should be filtered out, got %+v", s)
	}
	normal := `{"type":"user","cwd":"/repo","message":{"content":"fix the login bug"}}`
	if s := extractClaudeSession("id2", []string{normal}); s == nil {
		t.Fatal("normal session should not be filtered")
	}
}
```

- [ ] **Step 2: Expose the prompt for the drift test**

The drift test needs to read the batch prompt without exporting the raw constant. Add a tiny test accessor to `pkg/memdistill/distill.go`:

```go
// BatchDistillPromptForTest exposes the batch prompt for cross-package drift tests.
func BatchDistillPromptForTest() string { return batchDistillPrompt }
```

- [ ] **Step 3: Run test to verify it fails**

Run: `go test ./pkg/agentsessions/ -run Distill -v`
Expected: FAIL — `distillSessionSentinel` undefined.

- [ ] **Step 4: Add the filter to `extractClaudeSession`**

In `pkg/agentsessions/agentsessions.go`, add a package-level constant near the other consts (line 26 area):

```go
// distillSessionSentinel is the leading text of the batch memory-distillation prompt. Sessions whose
// first prompt starts with it are the headless distiller's own transcripts — hidden from the list.
// Kept in sync with memdistill's prompt by TestDistillSentinelMatchesPrompt.
const distillSessionSentinel = "You are distilling durable learnings from"
```

Then, in `extractClaudeSession`, replace the final `if !hasTask { return nil }` / `return s` block (lines 96-99) with:

```go
	if !hasTask {
		return nil
	}
	if strings.HasPrefix(s.Task, distillSessionSentinel) {
		return nil // the batch distiller's own headless transcript
	}
	return s
```

(`strings` is already imported in this file.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `go test ./pkg/agentsessions/ -run Distill -v && go test ./pkg/agentsessions/`
Expected: PASS, including the pre-existing agentsessions tests.

- [ ] **Step 6: Commit**

```bash
git add pkg/agentsessions/agentsessions.go pkg/agentsessions/distillfilter_test.go pkg/memdistill/distill.go
git commit -m "feat(agentsessions): hide batch-distillation phantom sessions"
```

---

## Final verification

- [ ] **Full backend build + tests**

Run: `go build ./... && go test ./pkg/memdistill/ ./pkg/memvault/ ./pkg/agentsessions/ ./pkg/wshrpc/wshserver/ ./cmd/wsh/cmd/`
Expected: all pass. (`pkg/tsgen TestGenerateWaveEventTypes` is a known pre-existing failure unrelated to this work — do not chase it.)

- [ ] **Rebuild backend binaries** so the dev app uses the new hook + server:

Run: `task build:backend`

- [ ] **Manual smoke** (optional, per verify skill): end a Claude Code session ≥ 8 times in one repo (or set `thresholdN` low temporarily) and confirm (a) learnings appear in memory, (b) no distill prompt shows up as a session in the Sessions tab.

## Notes for the implementer

- **Do not commit** the spec/plan docs on their own. Per repo git rules, `docs/superpowers/specs/2026-07-15-batch-memory-distillation-design.md` and this plan fold into the **first feature commit** (Task 1). Add them to that commit's `git add`.
- The `pkg/memdistill` package must not import `pkg/agentsessions` (agentsessions imports memdistill in its test only — keep the dependency one-way).
- If `task generate` complains about stale client state, see the repo's known "wshrpc codegen bootstrap gotcha": this change only *adds* a command, so a plain `task generate` after Steps 1-3 of Task 5 should suffice.
