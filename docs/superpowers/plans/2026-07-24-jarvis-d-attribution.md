# Jarvis sub-project D — Attribution engine — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `pkg/jarvisattrib` — the deterministic attribution engine that infers confidence-weighted dossier↔Run edges (layers 2–3), self-heals them, and exposes a unified edge read for the recall engine (C).

**Architecture:** A pure-Go package inside `wavesrv`, sibling to `wavevault`/`jarvisdossier`/`jarvisrecall`. The signal extractors are **pure functions** (dossier + runs + injected lookups → edges) so they unit-test without git or a DB; a thin integration layer wires them to `wstore` (Runs/Channels) and `gitinfo` (commit subjects). Inferred edges live in a rebuildable in-memory pass; the only committed state is a small append-only override log (human detach/accept) replayed on every read, plus confirmed edges hardened into the dossier's canonical `refs` block via B.

**Tech Stack:** Go, the `git` binary (shelled out via `pkg/gitinfo`), `pkg/wavevault` (A), `pkg/jarvisdossier` (B), `pkg/wstore` + `pkg/waveobj`. Go `testing` with a temp vault (`OpenVaultAtForTest`), real `git`, and a temp `wstore`.

## Global Constraints

- **Design spec:** `docs/superpowers/specs/2026-07-24-jarvis-d-attribution-design.md` — the authority for every decision below.
- **Execution prerequisite:** sub-project **B must be merged** — D consumes `jarvisdossier.LoadDossier`, `SetRefs`, `CreateDossier`, `DossierFacts`, `Dossier`. (B's code is already in the working tree.) Tasks 1, 2, 6 have no B dependency and can proceed regardless.
- **Determinism (invariant 1):** D calls **no model**. No `aiusechat`, no LLM. Every function here is deterministic and free.
- **Markdown is canonical (invariant 3):** the inferred-edge pass is rebuildable from `wstore` + git + the vault; the **only** committed D state is `<vault>/attributions/overrides.jsonl` (human corrections) and the hardened `[[run-<oid>]]` refs B owns.
- **No RPC / no frontend / no `task generate`:** D is in-process Go consumed by C. No `wshrpc` types.
- **Reference convention:** a run edge's canonical form is the wikilink id `run-<oid>` (rendered `[[run-<oid>]]` by B); the ORef is `run:<oid>`. F, B, and D agree on this.
- **Placeholder tuning:** layer weights, probation window, time-box, bucket cutoffs are PLACEHOLDER constants recorded in `docs/deferred.md` (Task 2) — tune against a populated vault later.
- **Git workflow (repo rule — overrides the skill's per-task commit):** do **not** commit per task. Each task ends at a **green-tests checkpoint** (stage only). The whole feature is committed **once at the end, after explicit user approval** (Closing section), folding in the spec doc and the meta-spec tracking-table D-row. **No co-author line** in the commit message.
- **Windows/tests:** `go test ./pkg/jarvisattrib/` and `./pkg/gitinfo/`. The typechecker/lint gotchas in `CLAUDE.md` are frontend-only; these are Go packages.

---

### Task 1: `gitinfo.RangeLog` — commit subjects over a `base..end` range

`gitinfo.GetRangeChanges` returns files only; layer 2 needs commit **subjects**. Add a range-based sibling of reporadar's `parseGitLog`.

**Files:**
- Modify: `pkg/gitinfo/gitinfo.go` (add `RangeCommit` type + `RangeLog`, near `GetRangeChanges:92`)
- Test: `pkg/gitinfo/gitinfo_test.go`

**Interfaces:**
- Consumes: the existing `run(ctx, cwd, args...)` helper and `gitTimeout` const in `gitinfo.go`.
- Produces: `func RangeLog(ctx context.Context, cwd, base, end string) ([]RangeCommit, error)` and `type RangeCommit struct { Hash string; Ts int64; Subject string }`.

- [ ] **Step 1: Write the failing test**

```go
// pkg/gitinfo/gitinfo_test.go  (add to the existing test file)
func gitRun(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.CommandContext(context.Background(), "git", append([]string{"-C", dir}, args...)...)
	cmd.Env = append(os.Environ(),
		"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
	return strings.TrimSpace(string(out))
}

func TestRangeLog(t *testing.T) {
	dir := t.TempDir()
	gitRun(t, dir, "init", "-q")
	gitRun(t, dir, "commit", "-q", "--allow-empty", "-m", "base commit")
	base := gitRun(t, dir, "rev-parse", "HEAD")
	gitRun(t, dir, "commit", "-q", "--allow-empty", "-m", "PROJ-142 add pkce flow")
	gitRun(t, dir, "commit", "-q", "--allow-empty", "-m", "fix token rotation")
	end := gitRun(t, dir, "rev-parse", "HEAD")

	commits, err := RangeLog(context.Background(), dir, base, end)
	if err != nil {
		t.Fatalf("RangeLog: %v", err)
	}
	if len(commits) != 2 {
		t.Fatalf("want 2 commits in base..end, got %d: %+v", len(commits), commits)
	}
	// git log lists newest first
	if commits[0].Subject != "fix token rotation" || commits[1].Subject != "PROJ-142 add pkce flow" {
		t.Fatalf("subjects wrong: %+v", commits)
	}
	if commits[0].Hash == "" || commits[0].Ts == 0 {
		t.Fatalf("hash/ts not populated: %+v", commits[0])
	}

	// empty range returns empty, not an error
	empty, err := RangeLog(context.Background(), dir, end, end)
	if err != nil {
		t.Fatalf("RangeLog empty: %v", err)
	}
	if len(empty) != 0 {
		t.Fatalf("want 0 commits for end..end, got %d", len(empty))
	}
}
```

(Ensure the test file imports `context`, `os`, `os/exec`, `strings`, `testing`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./pkg/gitinfo/ -run TestRangeLog -v`
Expected: FAIL — `RangeLog` / `RangeCommit` undefined.

- [ ] **Step 3: Write minimal implementation**

```go
// pkg/gitinfo/gitinfo.go  (add after GetRangeChanges)

// RangeCommit is one commit in a base..end range: its SHA, author time (UnixMilli), and subject line.
type RangeCommit struct {
	Hash    string
	Ts      int64
	Subject string
}

// RangeLog returns the commits reachable from end but not base, newest first, for identifier matching
// (layer 2). Unlike GetRangeChanges it yields commit subjects/SHAs, which git diff cannot. Uses a unit
// separator (\x1f) between fields so subjects containing spaces parse cleanly. Empty range → empty slice.
func RangeLog(ctx context.Context, cwd, base, end string) ([]RangeCommit, error) {
	ctx, cancel := context.WithTimeout(ctx, gitTimeout)
	defer cancel()
	out, err := run(ctx, cwd, "log", "--pretty=format:%H%x1f%ct%x1f%s", base+".."+end)
	if err != nil {
		return nil, err
	}
	out = strings.TrimSpace(out)
	if out == "" {
		return nil, nil
	}
	var commits []RangeCommit
	for _, line := range strings.Split(out, "\n") {
		parts := strings.SplitN(line, "\x1f", 3)
		if len(parts) != 3 {
			continue
		}
		secs, _ := strconv.ParseInt(parts[1], 10, 64)
		commits = append(commits, RangeCommit{Hash: parts[0], Ts: secs * 1000, Subject: parts[2]})
	}
	return commits, nil
}
```

(`strconv` and `strings` are already imported in `gitinfo.go`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./pkg/gitinfo/ -run TestRangeLog -v`
Expected: PASS.

- [ ] **Step 5: Checkpoint** — `go test ./pkg/gitinfo/` green; stage `pkg/gitinfo/gitinfo.go` and `pkg/gitinfo/gitinfo_test.go`. Do not commit (see Global Constraints).

---

### Task 2: Edge model, constants, and reference conversion (`edges.go`)

**Files:**
- Create: `pkg/jarvisattrib/edges.go`
- Create: `pkg/jarvisattrib/edges_test.go`
- Modify: `docs/deferred.md` (record the PLACEHOLDER tuning constants)

**Interfaces:**
- Produces:
  - `type EdgeState string` with `StateInforming`, `StateConfirmed`, `StateDetached`.
  - `type AttributedEdge struct { DossierID, RunORef string; Layers []int; Provenance string; Confidence float64; State EdgeState }`
  - `func confidenceFor(layers []int) float64`, `func provenanceFor(layers []int) string`, `func Bucket(c float64) string`
  - `func runRef(oid string) string`, `func refToRunORef(ref string) (string, bool)`, `func orefToRunRef(oref string) (string, bool)`
  - `func containsLayer(ls []int, x int) bool`, `func dedupSortLayers(ls []int) []int`
  - `var nowFn = func() int64 { ... }` (injectable clock for tests)
  - package-level tuning consts (`weightLayer1/2/3`, `probationMs`, `timeBoxMs`, bucket cutoffs) and provenance consts.

- [ ] **Step 1: Write the failing test**

```go
// pkg/jarvisattrib/edges_test.go
package jarvisattrib

import "testing"

func TestConfidenceAndProvenanceFromLayers(t *testing.T) {
	if c := confidenceFor([]int{2, 3}); c != 0.8 {
		t.Fatalf("max weight over {2,3} = %v, want 0.8", c)
	}
	if p := provenanceFor([]int{3, 2}); p != provTicket {
		t.Fatalf("provenance for {3,2} = %q, want %q (strongest layer wins)", p, provTicket)
	}
	if p := provenanceFor([]int{1}); p != provDispatch {
		t.Fatalf("provenance for {1} = %q, want %q", p, provDispatch)
	}
}

func TestBucketCutoffs(t *testing.T) {
	if Bucket(0.3) != "weak" || Bucket(weightLayer2) != "strong" || Bucket(0.5) != "medium" {
		t.Fatalf("buckets: %q %q %q", Bucket(0.3), Bucket(weightLayer2), Bucket(0.5))
	}
}

func TestRefConversionRoundTrip(t *testing.T) {
	oref, ok := refToRunORef(runRef("abc123"))
	if !ok || oref != "run:abc123" {
		t.Fatalf("refToRunORef = %q,%v want run:abc123,true", oref, ok)
	}
	back, ok := orefToRunRef("run:abc123")
	if !ok || back != "run-abc123" {
		t.Fatalf("orefToRunRef = %q,%v want run-abc123,true", back, ok)
	}
	if _, ok := refToRunORef("dec-9f0"); ok {
		t.Fatal("a decision ref must not convert to a run oref")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./pkg/jarvisattrib/ -run 'TestConfidence|TestBucket|TestRefConversion' -v`
Expected: FAIL — build error, symbols undefined.

- [ ] **Step 3: Write minimal implementation**

```go
// pkg/jarvisattrib/edges.go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Package jarvisattrib is the Jarvis attribution engine (sub-project D): it infers confidence-weighted
// dossier<->Run edges from deterministic signals (layers 2-3), self-heals them, and exposes a unified
// edge read for the recall engine (C). It calls no model.
package jarvisattrib

import (
	"sort"
	"strings"
	"time"
)

// Layer confidence weights — PLACEHOLDER tuning, see docs/deferred.md.
const (
	weightLayer1 = 1.0 // canonical dispatch reference (written by F, read by D)
	weightLayer2 = 0.8 // identifier (ticket) match
	weightLayer3 = 0.3 // structural correlation (same repo + overlapping window)
)

// Confidence display bucket cutoffs — PLACEHOLDER.
const (
	bucketWeakMax   = 0.4
	bucketStrongMin = 0.75
)

// Lifecycle windows in UnixMilli — PLACEHOLDER tuning, see docs/deferred.md.
const (
	probationMs int64 = 24 * 60 * 60 * 1000      // before an inferred edge may harden
	timeBoxMs   int64 = 30 * 24 * 60 * 60 * 1000 // a never-reinforced layer-3 edge older than this decays
)

const (
	provDispatch   = "dispatch"
	provTicket     = "ticket-match"
	provStructural = "structural"
	provAccept     = "human-accept"
)

// nowFn is the clock, overridable in tests for probation/time-box coverage (mirrors jarvisdossier).
var nowFn = func() int64 { return time.Now().UnixMilli() }

type EdgeState string

const (
	StateInforming EdgeState = "informing" // inferred, live in traversal, not yet hardened
	StateConfirmed EdgeState = "confirmed" // canonical dispatch ref, deterministic hit past probation, or human-accepted
	StateDetached  EdgeState = "detached"  // human-rejected; suppressed from EdgesFor
)

// AttributedEdge is one dossier->Run attribution. Layers records which signals reinforce it; Confidence
// is the max weight over those layers. (Probation is a computed gate on informing edges — see extract.go —
// not a stored state.)
type AttributedEdge struct {
	DossierID  string
	RunORef    string
	Layers     []int
	Provenance string
	Confidence float64
	State      EdgeState
}

func confidenceFor(layers []int) float64 {
	max := 0.0
	for _, l := range layers {
		w := 0.0
		switch l {
		case 1:
			w = weightLayer1
		case 2:
			w = weightLayer2
		case 3:
			w = weightLayer3
		}
		if w > max {
			max = w
		}
	}
	return max
}

// provenanceFor maps an edge to the provenance of its strongest (lowest-numbered) firing layer.
func provenanceFor(layers []int) string {
	min := 1 << 30
	for _, l := range layers {
		if l < min {
			min = l
		}
	}
	switch min {
	case 1:
		return provDispatch
	case 2:
		return provTicket
	default:
		return provStructural
	}
}

func Bucket(c float64) string {
	switch {
	case c < bucketWeakMax:
		return "weak"
	case c >= bucketStrongMin:
		return "strong"
	default:
		return "medium"
	}
}

func runRef(oid string) string { return "run-" + oid }

func refToRunORef(ref string) (string, bool) {
	if s, ok := strings.CutPrefix(ref, "run-"); ok && s != "" {
		return "run:" + s, true
	}
	return "", false
}

func orefToRunRef(oref string) (string, bool) {
	if s, ok := strings.CutPrefix(oref, "run:"); ok && s != "" {
		return "run-" + s, true
	}
	return "", false
}

func containsLayer(ls []int, x int) bool {
	for _, l := range ls {
		if l == x {
			return true
		}
	}
	return false
}

func dedupSortLayers(ls []int) []int {
	seen := map[int]bool{}
	var out []int
	for _, l := range ls {
		if !seen[l] {
			seen[l] = true
			out = append(out, l)
		}
	}
	sort.Ints(out)
	return out
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./pkg/jarvisattrib/ -run 'TestConfidence|TestBucket|TestRefConversion' -v`
Expected: PASS.

- [ ] **Step 5: Record the placeholder constants in `docs/deferred.md`**

Append:

```markdown
## Jarvis sub-project D — attribution tuning constants (2026-07-24)

`pkg/jarvisattrib/edges.go` ships PLACEHOLDER tuning values, to be calibrated against a populated vault before v2 proactive resurfacing trusts hardened edges:
- layer confidence weights: L1=1.0, L2=0.8, L3=0.3
- probation window: 24h (`probationMs`)
- layer-3 time-box (drift decay): 30d (`timeBoxMs`)
- confidence display buckets: weak <0.4, strong ≥0.75
```

- [ ] **Step 6: Checkpoint** — tests green; stage `pkg/jarvisattrib/edges.go`, `edges_test.go`, `docs/deferred.md`.

---

### Task 3: Layer-2 extractor — identifier match (`extract.go`)

**Files:**
- Create: `pkg/jarvisattrib/extract.go`
- Create: `pkg/jarvisattrib/extract_test.go`

**Interfaces:**
- Consumes: `AttributedEdge`, `weightLayer2`, `provTicket`, `StateInforming` (Task 2); `jarvisdossier.Dossier` (B); `waveobj.Run`.
- Produces: `func extractLayer2(d *jarvisdossier.Dossier, run *waveobj.Run, channelName string, commitSubjects []string) (AttributedEdge, bool)`

- [ ] **Step 1: Write the failing test**

```go
// pkg/jarvisattrib/extract_test.go
package jarvisattrib

import (
	"testing"

	"github.com/wavetermdev/waveterm/pkg/jarvisdossier"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func TestLayer2MatchesTicket(t *testing.T) {
	d := &jarvisdossier.Dossier{ID: "task-1", Ticket: "PROJ-142"}

	// hit via Run.Goal
	e, ok := extractLayer2(d, &waveobj.Run{OID: "r1", Goal: "implement PROJ-142 pkce"}, "", nil)
	if !ok || e.RunORef != "run:r1" || e.Confidence != weightLayer2 || !containsLayer(e.Layers, 2) {
		t.Fatalf("goal match: %+v ok=%v", e, ok)
	}
	if e.Provenance != provTicket || e.State != StateInforming {
		t.Fatalf("goal match provenance/state: %+v", e)
	}

	// hit via commit subject
	if _, ok := extractLayer2(d, &waveobj.Run{OID: "r2"}, "", []string{"fix proj-142 rotation"}); !ok {
		t.Fatal("commit-subject match (case-insensitive) should hit")
	}
	// hit via channel name
	if _, ok := extractLayer2(d, &waveobj.Run{OID: "r3"}, "PROJ-142 oauth work", nil); !ok {
		t.Fatal("channel-name match should hit")
	}
	// no ticket on dossier → never hits
	if _, ok := extractLayer2(&jarvisdossier.Dossier{ID: "t"}, &waveobj.Run{OID: "r4", Goal: "PROJ-142"}, "", nil); ok {
		t.Fatal("ticketless dossier must not match")
	}
	// no match
	if _, ok := extractLayer2(d, &waveobj.Run{OID: "r5", Goal: "unrelated"}, "misc", []string{"chore"}); ok {
		t.Fatal("should not match unrelated run")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./pkg/jarvisattrib/ -run TestLayer2 -v`
Expected: FAIL — `extractLayer2` undefined.

- [ ] **Step 3: Write minimal implementation**

```go
// pkg/jarvisattrib/extract.go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvisattrib

import (
	"regexp"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/jarvisdossier"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// ticketRe matches a ticket-shaped identifier (e.g. PROJ-142) — used by layer-3 self-correction.
var ticketRe = regexp.MustCompile(`\b[A-Z][A-Z0-9]+-\d+\b`)

// extractLayer2 fires when the dossier's ticket appears in the Run's Goal, its Channel name, or any
// commit subject in the Run's range. Deterministic, high confidence on hit.
func extractLayer2(d *jarvisdossier.Dossier, run *waveobj.Run, channelName string, commitSubjects []string) (AttributedEdge, bool) {
	if d.Ticket == "" {
		return AttributedEdge{}, false
	}
	needle := strings.ToLower(d.Ticket)
	haystacks := append([]string{run.Goal, channelName}, commitSubjects...)
	for _, h := range haystacks {
		if h != "" && strings.Contains(strings.ToLower(h), needle) {
			return AttributedEdge{
				DossierID:  d.ID,
				RunORef:    "run:" + run.OID,
				Layers:     []int{2},
				Provenance: provTicket,
				Confidence: weightLayer2,
				State:      StateInforming,
			}, true
		}
	}
	return AttributedEdge{}, false
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./pkg/jarvisattrib/ -run TestLayer2 -v`
Expected: PASS.

- [ ] **Step 5: Checkpoint** — tests green; stage `extract.go`, `extract_test.go`.

---

### Task 4: Layer-3 extractor, window overlap, self-correction, probation (`extract.go`)

**Files:**
- Modify: `pkg/jarvisattrib/extract.go`
- Modify: `pkg/jarvisattrib/extract_test.go`

**Interfaces:**
- Consumes: `AttributedEdge`, `weightLayer3`, `provStructural`, `timeBoxMs`, `probationMs`, `ticketRe`.
- Produces:
  - `func extractLayer3(d *jarvisdossier.Dossier, run *waveobj.Run, anchorPaths map[string]bool, commitSubjects []string, now int64) (AttributedEdge, bool)`
  - `func windowsOverlap(d *jarvisdossier.Dossier, run *waveobj.Run, now int64) bool`
  - `func pastProbation(run *waveobj.Run, now int64) bool`

- [ ] **Step 1: Write the failing test**

```go
// pkg/jarvisattrib/extract_test.go  (add)
func TestLayer3AnchoredCorrelation(t *testing.T) {
	const now = int64(1_000_000_000_000)
	d := &jarvisdossier.Dossier{ID: "task-1", Ticket: "PROJ-142", Status: "active", Created: now - 5000}
	anchor := map[string]bool{"/repo/app": true}

	run := &waveobj.Run{OID: "r1", ProjectPath: "/repo/app", CreatedTs: now - 3000, CompletedTs: now - 1000}

	// in anchor repo + overlapping window + no contradicting ticket → weak edge
	e, ok := extractLayer3(d, run, anchor, nil, now)
	if !ok || e.Confidence != weightLayer3 || e.Provenance != provStructural || !containsLayer(e.Layers, 3) {
		t.Fatalf("expected weak structural edge, got %+v ok=%v", e, ok)
	}

	// wrong repo → no edge
	if _, ok := extractLayer3(d, &waveobj.Run{OID: "r2", ProjectPath: "/other", CreatedTs: now - 3000}, anchor, nil, now); ok {
		t.Fatal("run outside anchor repo must not correlate")
	}
	// no anchors at all → no edge
	if _, ok := extractLayer3(d, run, map[string]bool{}, nil, now); ok {
		t.Fatal("no anchor => layer 3 cannot fire")
	}
	// self-correction: commit carries a DIFFERENT ticket → contradicted, no edge
	if _, ok := extractLayer3(d, run, anchor, []string{"OTHER-9 unrelated"}, now); ok {
		t.Fatal("a different concrete ticket must retract the weak edge")
	}
	// time-boxed: run finished long ago, never reinforced → decays
	old := &waveobj.Run{OID: "r3", ProjectPath: "/repo/app", CreatedTs: now - timeBoxMs - 5000, CompletedTs: now - timeBoxMs - 1000}
	if _, ok := extractLayer3(d, old, anchor, nil, now); ok {
		t.Fatal("a run completed beyond the time-box must decay")
	}
}

func TestPastProbation(t *testing.T) {
	const now = int64(2_000_000_000_000)
	if pastProbation(&waveobj.Run{CreatedTs: now - 1000}, now) {
		t.Fatal("a fresh run is within probation")
	}
	if !pastProbation(&waveobj.Run{CreatedTs: now - probationMs - 1}, now) {
		t.Fatal("a run older than the probation window is past probation")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./pkg/jarvisattrib/ -run 'TestLayer3|TestPastProbation' -v`
Expected: FAIL — `extractLayer3`/`windowsOverlap`/`pastProbation` undefined.

- [ ] **Step 3: Write minimal implementation**

```go
// pkg/jarvisattrib/extract.go  (add)

// windowsOverlap reports whether the run's active window intersects the dossier's. An active dossier's
// window extends to now; a run with no completion extends to now.
func windowsOverlap(d *jarvisdossier.Dossier, run *waveobj.Run, now int64) bool {
	dEnd := d.Updated
	if d.Status == "active" {
		dEnd = now
	}
	rStart := run.CreatedTs
	rEnd := run.CompletedTs
	if rEnd == 0 {
		rEnd = now
	}
	return rStart <= dEnd && rEnd >= d.Created
}

// pastProbation reports whether an inferred edge is old enough to harden. Age is the age of the Run the
// edge is built on — re-derived from Run.CreatedTs, so a cache rebuild computes it identically.
func pastProbation(run *waveobj.Run, now int64) bool {
	return now-run.CreatedTs >= probationMs
}

// extractLayer3 fires a weak structural edge when the run is in one of the dossier's anchor repos and
// their windows overlap. Self-corrects: a concrete different ticket in the run's commits retracts it.
// Time-boxes: a never-reinforced run finished beyond the time-box decays (not returned).
func extractLayer3(d *jarvisdossier.Dossier, run *waveobj.Run, anchorPaths map[string]bool, commitSubjects []string, now int64) (AttributedEdge, bool) {
	if len(anchorPaths) == 0 || !anchorPaths[run.ProjectPath] {
		return AttributedEdge{}, false
	}
	if !windowsOverlap(d, run, now) {
		return AttributedEdge{}, false
	}
	runEnd := run.CompletedTs
	if runEnd == 0 {
		runEnd = now
	}
	if now-runEnd > timeBoxMs {
		return AttributedEdge{}, false
	}
	// self-correction: any ticket-shaped token in the commits that is not this dossier's ticket contradicts.
	for _, s := range commitSubjects {
		for _, m := range ticketRe.FindAllString(s, -1) {
			if !strings.EqualFold(m, d.Ticket) {
				return AttributedEdge{}, false
			}
		}
	}
	return AttributedEdge{
		DossierID:  d.ID,
		RunORef:    "run:" + run.OID,
		Layers:     []int{3},
		Provenance: provStructural,
		Confidence: weightLayer3,
		State:      StateInforming,
	}, true
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./pkg/jarvisattrib/ -run 'TestLayer3|TestPastProbation' -v`
Expected: PASS.

- [ ] **Step 5: Checkpoint** — tests green; stage `extract.go`, `extract_test.go`.

---

### Task 5: Layer-1 read + edge assembly/merge (`extract.go`)

Assembles the merged, deduped, confidence-ordered edge set from the dossier's canonical refs (layer 1) plus the layer-2/3 extractors, using injected lookups so it stays pure.

**Files:**
- Modify: `pkg/jarvisattrib/extract.go`
- Modify: `pkg/jarvisattrib/extract_test.go`

**Interfaces:**
- Consumes: `extractLayer2`/`extractLayer3` (Tasks 3–4); `refToRunORef`, `confidenceFor`, `provenanceFor`, `dedupSortLayers` (Task 2); `jarvisdossier.Dossier.Refs`.
- Produces:
  - `type edgeLookups struct { channelName func(channelOID string) string; commits func(run *waveobj.Run) []string }`
  - `func assembleEdges(d *jarvisdossier.Dossier, runs []*waveobj.Run, lk edgeLookups, now int64) []AttributedEdge`
  - `func mergeInto(m map[string]AttributedEdge, e AttributedEdge)`

- [ ] **Step 1: Write the failing test**

```go
// pkg/jarvisattrib/extract_test.go  (add)
func TestAssembleMergesAndOrders(t *testing.T) {
	const now = int64(1_000_000_000_000)
	// dossier already has a canonical layer-1 ref to run r0, ticket matches r1, r2 is a weak same-repo prior.
	d := &jarvisdossier.Dossier{
		ID: "task-1", Ticket: "PROJ-142", Status: "active", Created: now - 10000,
		Refs: []string{"run-r0", "dec-abc"}, // dec- is a decision ref, ignored by run attribution
	}
	runs := []*waveobj.Run{
		{OID: "r0", ProjectPath: "/repo/app", CreatedTs: now - 9000, CompletedTs: now - 8000},
		{OID: "r1", ProjectPath: "/repo/app", Goal: "PROJ-142 flow", CreatedTs: now - 5000, CompletedTs: now - 4000},
		{OID: "r2", ProjectPath: "/repo/app", CreatedTs: now - 3000, CompletedTs: now - 2000},
	}
	lk := edgeLookups{
		channelName: func(string) string { return "" },
		commits:     func(*waveobj.Run) []string { return nil },
	}

	edges := assembleEdges(d, runs, lk, now)

	byORef := map[string]AttributedEdge{}
	for _, e := range edges {
		byORef[e.RunORef] = e
	}
	// r0: canonical (layer 1), confirmed, confidence 1.0
	if e := byORef["run:r0"]; e.State != StateConfirmed || e.Confidence != 1.0 || !containsLayer(e.Layers, 1) {
		t.Fatalf("r0 layer-1 edge wrong: %+v", e)
	}
	// r1: ticket match AND same-repo/window prior → layers {2,3}, confidence max = 0.8, provenance ticket
	if e := byORef["run:r1"]; !containsLayer(e.Layers, 2) || !containsLayer(e.Layers, 3) || e.Confidence != 0.8 || e.Provenance != provTicket {
		t.Fatalf("r1 merged edge wrong: %+v", e)
	}
	// r2: weak structural only
	if e := byORef["run:r2"]; e.Confidence != weightLayer3 || e.State != StateInforming {
		t.Fatalf("r2 weak edge wrong: %+v", e)
	}
	// ordering: confidence descending
	for i := 1; i < len(edges); i++ {
		if edges[i-1].Confidence < edges[i].Confidence {
			t.Fatalf("edges not confidence-descending: %+v", edges)
		}
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./pkg/jarvisattrib/ -run TestAssemble -v`
Expected: FAIL — `assembleEdges`/`edgeLookups` undefined.

- [ ] **Step 3: Write minimal implementation**

```go
// pkg/jarvisattrib/extract.go  (add — also add "sort" to the import block)

// edgeLookups injects the two I/O-backed resolvers assembleEdges needs, so the core stays pure and
// unit-testable. The integration layer (lifecycle.go) supplies wstore/gitinfo-backed implementations.
type edgeLookups struct {
	channelName func(channelOID string) string
	commits     func(run *waveobj.Run) []string
}

// mergeInto unions an edge into the accumulator by RunORef, recomputing confidence/provenance from the
// unioned layers and preserving a confirmed state.
func mergeInto(m map[string]AttributedEdge, e AttributedEdge) {
	cur, ok := m[e.RunORef]
	if !ok {
		cur = AttributedEdge{DossierID: e.DossierID, RunORef: e.RunORef}
	}
	cur.Layers = dedupSortLayers(append(cur.Layers, e.Layers...))
	cur.Confidence = confidenceFor(cur.Layers)
	cur.Provenance = provenanceFor(cur.Layers)
	if e.State == StateConfirmed || cur.State == StateConfirmed {
		cur.State = StateConfirmed
	} else {
		cur.State = StateInforming
	}
	m[e.RunORef] = cur
}

// assembleEdges builds the merged dossier->Run edge set: layer-1 canonical refs (confirmed) plus the
// layer-2/3 extractors over candidate runs, deduped by run and ordered by confidence descending.
func assembleEdges(d *jarvisdossier.Dossier, runs []*waveobj.Run, lk edgeLookups, now int64) []AttributedEdge {
	byORef := map[string]*waveobj.Run{}
	for _, r := range runs {
		byORef["run:"+r.OID] = r
	}
	m := map[string]AttributedEdge{}
	anchorPaths := map[string]bool{}
	l1 := map[string]bool{}

	// layer 1: the dossier's canonical run references (written by F at dispatch, or hardened by D).
	for _, ref := range d.Refs {
		oref, ok := refToRunORef(ref)
		if !ok {
			continue
		}
		mergeInto(m, AttributedEdge{DossierID: d.ID, RunORef: oref, Layers: []int{1}, State: StateConfirmed})
		l1[oref] = true
		if r := byORef[oref]; r != nil {
			anchorPaths[r.ProjectPath] = true
		}
	}

	// layers 2 & 3 over the remaining candidate runs.
	for _, r := range runs {
		oref := "run:" + r.OID
		if l1[oref] {
			continue
		}
		subs := lk.commits(r)
		if e, ok := extractLayer2(d, r, lk.channelName(r.ChannelOID), subs); ok {
			mergeInto(m, e)
		}
		if e, ok := extractLayer3(d, r, anchorPaths, subs, now); ok {
			mergeInto(m, e)
		}
	}

	out := make([]AttributedEdge, 0, len(m))
	for _, e := range m {
		out = append(out, e)
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Confidence > out[j].Confidence })
	return out
}
```

Add `"sort"` to `extract.go`'s import block.

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./pkg/jarvisattrib/ -run TestAssemble -v`
Expected: PASS.

- [ ] **Step 5: Checkpoint** — `go test ./pkg/jarvisattrib/` green; stage `extract.go`, `extract_test.go`.

---

### Task 6: Override log — append, latest-wins read, commit capture (`store.go`)

**Files:**
- Create: `pkg/jarvisattrib/store.go`
- Create: `pkg/jarvisattrib/store_test.go`

**Interfaces:**
- Consumes: `wavevault.Vault` (`.Root`, `.Commit`), `OpenVaultAtForTest` (A).
- Produces:
  - `type overrideRecord struct { DossierID, RunORef, Action, Actor string; Ts int64 }` (JSON-tagged)
  - `func overridesPath(v *wavevault.Vault) string`
  - `func appendOverride(v *wavevault.Vault, rec overrideRecord) error`
  - `func readOverrides(v *wavevault.Vault) (map[string]string, error)` — key `dossierID|runORef` → latest action

- [ ] **Step 1: Write the failing test**

```go
// pkg/jarvisattrib/store_test.go
package jarvisattrib

import (
	"context"
	"os/exec"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/wavevault"
)

func testVault(t *testing.T) *wavevault.Vault {
	t.Helper()
	v, err := wavevault.OpenVaultAtForTest(context.Background(), t.TempDir())
	if err != nil {
		t.Fatalf("OpenVaultAtForTest: %v", err)
	}
	return v
}

func TestOverrideLogLatestWins(t *testing.T) {
	v := testVault(t)
	must := func(err error) {
		if err != nil {
			t.Fatal(err)
		}
	}
	must(appendOverride(v, overrideRecord{DossierID: "task-1", RunORef: "run:r1", Action: "detach", Actor: "human", Ts: 1}))
	must(appendOverride(v, overrideRecord{DossierID: "task-1", RunORef: "run:r1", Action: "accept", Actor: "human", Ts: 2}))
	must(appendOverride(v, overrideRecord{DossierID: "task-1", RunORef: "run:r2", Action: "detach", Actor: "human", Ts: 3}))

	ov, err := readOverrides(v)
	if err != nil {
		t.Fatalf("readOverrides: %v", err)
	}
	if ov["task-1|run:r1"] != "accept" {
		t.Fatalf("latest for r1 should be accept, got %q", ov["task-1|run:r1"])
	}
	if ov["task-1|run:r2"] != "detach" {
		t.Fatalf("r2 should be detach, got %q", ov["task-1|run:r2"])
	}
}

func TestReadOverridesMissingFile(t *testing.T) {
	ov, err := readOverrides(testVault(t))
	if err != nil || len(ov) != 0 {
		t.Fatalf("missing log should be empty, not error: %v %v", ov, err)
	}
}

func TestOverrideLogIsCommitted(t *testing.T) {
	v := testVault(t)
	if err := appendOverride(v, overrideRecord{DossierID: "task-1", RunORef: "run:r1", Action: "detach", Actor: "human", Ts: 1}); err != nil {
		t.Fatal(err)
	}
	if err := v.Commit(context.Background(), "test override"); err != nil {
		t.Fatalf("Commit: %v", err)
	}
	out, err := exec.Command("git", "-C", v.Root, "ls-files", "attributions/overrides.jsonl").CombinedOutput()
	if err != nil {
		t.Fatalf("git ls-files: %v\n%s", err, out)
	}
	if !strings.Contains(string(out), "attributions/overrides.jsonl") {
		t.Fatalf("override log not tracked by git after commit; ls-files=%q", out)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./pkg/jarvisattrib/ -run 'TestOverride|TestReadOverrides' -v`
Expected: FAIL — `overrideRecord`/`appendOverride`/`readOverrides` undefined.

- [ ] **Step 3: Write minimal implementation**

```go
// pkg/jarvisattrib/store.go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvisattrib

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/wavevault"
)

// overrideRecord is one human correction to an inferred attribution. The log is append-only; the latest
// record for a (DossierID, RunORef) pair wins. It is the only non-derivable state D commits.
type overrideRecord struct {
	DossierID string `json:"dossierID"`
	RunORef   string `json:"runORef"`
	Action    string `json:"action"` // "detach" | "accept"
	Actor     string `json:"actor"`
	Ts        int64  `json:"ts"`
}

// overridesPath is the D-owned log, outside A's four recall collections (so A does not index it as
// recall content) but inside the vault git repo (so A's Commit captures it).
func overridesPath(v *wavevault.Vault) string {
	return filepath.Join(v.Root, "attributions", "overrides.jsonl")
}

func appendOverride(v *wavevault.Vault, rec overrideRecord) error {
	p := overridesPath(v)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return err
	}
	f, err := os.OpenFile(p, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	defer f.Close()
	b, err := json.Marshal(rec)
	if err != nil {
		return err
	}
	_, err = f.Write(append(b, '\n'))
	return err
}

// readOverrides returns the latest action per "dossierID|runORef" key. A missing log is empty, not an
// error. Unparseable lines are skipped (tolerant).
func readOverrides(v *wavevault.Vault) (map[string]string, error) {
	data, err := os.ReadFile(overridesPath(v))
	if errors.Is(err, os.ErrNotExist) {
		return map[string]string{}, nil
	}
	if err != nil {
		return nil, err
	}
	out := map[string]string{}
	for _, line := range strings.Split(strings.TrimSpace(string(data)), "\n") {
		if line == "" {
			continue
		}
		var rec overrideRecord
		if json.Unmarshal([]byte(line), &rec) != nil {
			continue
		}
		out[rec.DossierID+"|"+rec.RunORef] = rec.Action
	}
	return out, nil
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./pkg/jarvisattrib/ -run 'TestOverride|TestReadOverrides' -v`
Expected: PASS.

- [ ] **Step 5: Checkpoint** — tests green; stage `store.go`, `store_test.go`.

---

### Task 7: Probation-gated hardening into canonical refs (`lifecycle.go`)

**Files:**
- Create: `pkg/jarvisattrib/lifecycle.go`
- Create: `pkg/jarvisattrib/lifecycle_test.go`

**Interfaces:**
- Consumes: `orefToRunRef` (Task 2); `jarvisdossier.{CreateDossier,LoadDossier,SetRefs,DossierFacts,Dossier}` (B); `wavevault.{Vault,AllScope}` (A).
- Produces:
  - `func loadDossier(v *wavevault.Vault, id string) (*jarvisdossier.Dossier, error)`
  - `func hardenEdge(v *wavevault.Vault, d *jarvisdossier.Dossier, runORef string) error`

- [ ] **Step 1: Write the failing test**

```go
// pkg/jarvisattrib/lifecycle_test.go
package jarvisattrib

import (
	"context"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/jarvisdossier"
	"github.com/wavetermdev/waveterm/pkg/wavevault"
)

func TestHardenEdgeWritesCanonicalRefAndPreservesProse(t *testing.T) {
	v := testVault(t)
	id, _, err := jarvisdossier.CreateDossier(v, jarvisdossier.DossierFacts{Ticket: "PROJ-142", Objective: "oauth pkce"})
	if err != nil {
		t.Fatalf("CreateDossier: %v", err)
	}
	d, err := loadDossier(v, id)
	if err != nil {
		t.Fatalf("loadDossier: %v", err)
	}

	if err := hardenEdge(v, d, "run:r1"); err != nil {
		t.Fatalf("hardenEdge: %v", err)
	}

	// the run ref is now a real link on the dossier — reachable by A's HasLink filter
	nodes, err := v.Retriever(wavevault.AllScope()).Query(wavevault.Filter{HasLink: "run-r1"})
	if err != nil {
		t.Fatalf("Query: %v", err)
	}
	if len(nodes) != 1 || nodes[0].ID != id {
		t.Fatalf("HasLink(run-r1) did not find the dossier: %+v", nodes)
	}

	// hardening again is idempotent (no duplicate, no error)
	d2, _ := loadDossier(v, id)
	if err := hardenEdge(v, d2, "run:r1"); err != nil {
		t.Fatalf("idempotent harden: %v", err)
	}
	d3, _ := loadDossier(v, id)
	count := 0
	for _, r := range d3.Refs {
		if r == "run-r1" {
			count++
		}
	}
	if count != 1 {
		t.Fatalf("run-r1 appears %d times, want 1", count)
	}

	// the human ## Notes prose is untouched (B's diff-validator guards it)
	nb, _ := v.Retriever(wavevault.AllScope()).Read(id)
	if !contains(nb.Body, "## Notes") {
		t.Fatalf("human Notes section lost after harden: %q", nb.Body)
	}
}

func contains(s, sub string) bool { return len(s) >= len(sub) && (indexOf(s, sub) >= 0) }
func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}

var _ = context.Background
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./pkg/jarvisattrib/ -run TestHardenEdge -v`
Expected: FAIL — `loadDossier`/`hardenEdge` undefined.

- [ ] **Step 3: Write minimal implementation**

```go
// pkg/jarvisattrib/lifecycle.go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvisattrib

import (
	"fmt"

	"github.com/wavetermdev/waveterm/pkg/jarvisdossier"
	"github.com/wavetermdev/waveterm/pkg/wavevault"
)

// loadDossier reads a dossier through an all-collections retriever (dossiers live in tasks/).
func loadDossier(v *wavevault.Vault, id string) (*jarvisdossier.Dossier, error) {
	return jarvisdossier.LoadDossier(v.Retriever(wavevault.AllScope()), id)
}

// hardenEdge unions the run's canonical reference into the dossier refs block (idempotent), retrying
// once on a concurrent-write conflict with the re-read hash. This is how a confirmed edge becomes a
// durable, traversable reference that survives a cache rebuild.
func hardenEdge(v *wavevault.Vault, d *jarvisdossier.Dossier, runORef string) error {
	ref, ok := orefToRunRef(runORef)
	if !ok {
		return fmt.Errorf("jarvisattrib: not a run oref: %q", runORef)
	}
	for _, r := range d.Refs {
		if r == ref {
			return nil // already present
		}
	}
	refs := append(append([]string{}, d.Refs...), ref)
	res, err := jarvisdossier.SetRefs(v, d.ID, refs, d.Hash)
	if err != nil {
		return err
	}
	if res != nil && res.Conflict {
		d2, err := loadDossier(v, d.ID)
		if err != nil {
			return err
		}
		for _, r := range d2.Refs {
			if r == ref {
				return nil
			}
		}
		refs = append(append([]string{}, d2.Refs...), ref)
		_, err = jarvisdossier.SetRefs(v, d2.ID, refs, d2.Hash)
		return err
	}
	return nil
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./pkg/jarvisattrib/ -run TestHardenEdge -v`
Expected: PASS.

- [ ] **Step 5: Checkpoint** — tests green; stage `lifecycle.go`, `lifecycle_test.go`.

---

### Task 8: Detach / Accept overrides + apply-on-read + rebuild replay (`lifecycle.go`)

**Files:**
- Modify: `pkg/jarvisattrib/lifecycle.go`
- Modify: `pkg/jarvisattrib/lifecycle_test.go`

**Interfaces:**
- Consumes: `appendOverride`/`readOverrides` (Task 6), `hardenEdge`/`loadDossier` (Task 7), `assembleEdges` (Task 5), `nowFn` (Task 2), `jarvisdossier.SetRefs`.
- Produces:
  - `func applyOverrides(edges []AttributedEdge, overrides map[string]string) []AttributedEdge`
  - `func Detach(ctx context.Context, v *wavevault.Vault, dossierID, runORef string) error`
  - `func Accept(ctx context.Context, v *wavevault.Vault, dossierID, runORef string) error`

- [ ] **Step 1: Write the failing test**

```go
// pkg/jarvisattrib/lifecycle_test.go  (add)
func TestDetachSuppressesAndSurvivesRebuild(t *testing.T) {
	const now = int64(1_000_000_000_000)
	d := &jarvisdossier.Dossier{ID: "task-1", Ticket: "PROJ-142", Status: "active", Created: now - 9000}
	runs := []*waveobj.Run{{OID: "r1", ProjectPath: "/repo/app", Goal: "PROJ-142", CreatedTs: now - 5000}}
	lk := edgeLookups{channelName: func(string) string { return "" }, commits: func(*waveobj.Run) []string { return nil }}

	v := testVault(t)
	// before any override: the inferred edge is present
	edges := applyOverrides(assembleEdges(d, runs, lk, now), mustOverrides(t, v))
	if len(edges) != 1 {
		t.Fatalf("expected 1 inferred edge pre-detach, got %d", len(edges))
	}

	// user detaches it
	if err := Detach(context.Background(), v, "task-1", "run:r1"); err != nil {
		t.Fatalf("Detach: %v", err)
	}

	// a full rebuild (re-assemble + re-read overrides) still suppresses it
	edges = applyOverrides(assembleEdges(d, runs, lk, now), mustOverrides(t, v))
	if len(edges) != 0 {
		t.Fatalf("detached edge resurrected after rebuild: %+v", edges)
	}
}

func TestAcceptConfirms(t *testing.T) {
	const now = int64(1_000_000_000_000)
	edges := []AttributedEdge{{DossierID: "task-1", RunORef: "run:r1", Layers: []int{3}, Confidence: weightLayer3, State: StateInforming}}
	out := applyOverrides(edges, map[string]string{"task-1|run:r1": "accept"})
	if len(out) != 1 || out[0].State != StateConfirmed {
		t.Fatalf("accept should confirm the edge, got %+v", out)
	}
	_ = now
}

func mustOverrides(t *testing.T, v *wavevault.Vault) map[string]string {
	t.Helper()
	ov, err := readOverrides(v)
	if err != nil {
		t.Fatalf("readOverrides: %v", err)
	}
	return ov
}
```

(Add `"github.com/wavetermdev/waveterm/pkg/waveobj"` to the lifecycle test imports.)

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./pkg/jarvisattrib/ -run 'TestDetach|TestAccept' -v`
Expected: FAIL — `applyOverrides`/`Detach`/`Accept` undefined.

- [ ] **Step 3: Write minimal implementation**

```go
// pkg/jarvisattrib/lifecycle.go  (add — add "context" to the import block)

// applyOverrides replays the human override log over freshly-assembled edges: a detach suppresses the
// edge; an accept forces it confirmed. This is what makes a correction durable across a cache rebuild.
func applyOverrides(edges []AttributedEdge, overrides map[string]string) []AttributedEdge {
	out := make([]AttributedEdge, 0, len(edges))
	for _, e := range edges {
		switch overrides[e.DossierID+"|"+e.RunORef] {
		case "detach":
			continue
		case "accept":
			e.State = StateConfirmed
			out = append(out, e)
		default:
			out = append(out, e)
		}
	}
	return out
}

// Detach records a human rejection and removes any hardened ref so the edge fully disappears. The
// override keeps it suppressed even if the extractors would re-infer it.
func Detach(ctx context.Context, v *wavevault.Vault, dossierID, runORef string) error {
	if err := appendOverride(v, overrideRecord{DossierID: dossierID, RunORef: runORef, Action: "detach", Actor: "human", Ts: nowFn()}); err != nil {
		return err
	}
	ref, ok := orefToRunRef(runORef)
	if !ok {
		return nil
	}
	d, err := loadDossier(v, dossierID)
	if err != nil {
		return err
	}
	kept := make([]string, 0, len(d.Refs))
	removed := false
	for _, r := range d.Refs {
		if r == ref {
			removed = true
			continue
		}
		kept = append(kept, r)
	}
	if removed {
		if _, err := jarvisdossier.SetRefs(v, dossierID, kept, d.Hash); err != nil {
			return err
		}
	}
	return nil
}

// Accept records a human acceptance (provenance human-accept) and hardens the edge into canonical refs.
func Accept(ctx context.Context, v *wavevault.Vault, dossierID, runORef string) error {
	if err := appendOverride(v, overrideRecord{DossierID: dossierID, RunORef: runORef, Action: "accept", Actor: "human", Ts: nowFn()}); err != nil {
		return err
	}
	d, err := loadDossier(v, dossierID)
	if err != nil {
		return err
	}
	return hardenEdge(v, d, runORef)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./pkg/jarvisattrib/ -run 'TestDetach|TestAccept' -v`
Expected: PASS.

- [ ] **Step 5: Checkpoint** — `go test ./pkg/jarvisattrib/` green; stage `lifecycle.go`, `lifecycle_test.go`.

---

### Task 9: Public API — `EdgesFor` / `Backfill` / `Harden` + wstore/gitinfo wiring (`lifecycle.go`)

The integration layer: gather Runs from `wstore`, resolve channel names + commit subjects, run the pure core, apply overrides, and (in `Harden`) promote deterministic-L2 edges past probation. End-to-end tested against a temp vault + temp `wstore`.

**Files:**
- Modify: `pkg/jarvisattrib/lifecycle.go`
- Create: `pkg/jarvisattrib/maintest_test.go`
- Create: `pkg/jarvisattrib/edgesfor_test.go`

**Interfaces:**
- Consumes: `wstore.{DBGetAllObjsByType,DBGet}`, `waveobj.{Run,Channel,OType_Run}`, `gitinfo.RangeLog` (Task 1), the pure core (Tasks 5,8), `pastProbation`/`hardenEdge` (Tasks 4,7).
- Produces (the D ⇄ C seam):
  - `func EdgesFor(ctx context.Context, v *wavevault.Vault, dossierID string) ([]AttributedEdge, error)`
  - `func Backfill(ctx context.Context, v *wavevault.Vault, dossierID string) ([]AttributedEdge, error)`
  - `func Harden(ctx context.Context, v *wavevault.Vault, dossierID string) error`

- [ ] **Step 1: Write the TestMain harness**

```go
// pkg/jarvisattrib/maintest_test.go
package jarvisattrib

import (
	"os"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "jarvisattrib-test-*")
	if err != nil {
		panic(err)
	}
	wavebase.DataHome_VarCache = dir
	if err := wavebase.EnsureWaveDBDir(); err != nil {
		panic(err)
	}
	if err := wstore.InitWStore(); err != nil {
		panic(err)
	}
	code := m.Run()
	os.RemoveAll(dir)
	os.Exit(code)
}
```

- [ ] **Step 2: Write the failing integration test**

```go
// pkg/jarvisattrib/edgesfor_test.go
package jarvisattrib

import (
	"context"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/jarvisdossier"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

func TestEdgesForEndToEnd(t *testing.T) {
	ctx := context.Background()
	v := testVault(t)

	chID := "aaaaaaaa-0000-0000-0000-000000000001"
	runID := "bbbbbbbb-0000-0000-0000-000000000001"
	ch := &waveobj.Channel{OID: chID, Name: "oauth channel", ProjectPath: "/repo/app", Meta: make(waveobj.MetaMapType)}
	// CreatedTs old enough to be past probation immediately; ticket in Goal drives the layer-2 hit.
	run := &waveobj.Run{OID: runID, ID: runID, ChannelOID: chID, Goal: "PROJ-142 pkce flow",
		ProjectPath: "/repo/app", Status: "done", CreatedTs: nowFn() - probationMs - 1000, CompletedTs: nowFn() - 1000,
		Meta: make(waveobj.MetaMapType)}
	if err := wstore.DBInsert(ctx, ch); err != nil {
		t.Fatalf("insert channel: %v", err)
	}
	if err := wstore.DBInsert(ctx, run); err != nil {
		t.Fatalf("insert run: %v", err)
	}
	t.Cleanup(func() {
		_ = wstore.DBDelete(ctx, waveobj.OType_Channel, chID)
		_ = wstore.DBDelete(ctx, waveobj.OType_Run, runID)
	})

	id, _, err := jarvisdossier.CreateDossier(v, jarvisdossier.DossierFacts{Ticket: "PROJ-142", Objective: "oauth"})
	if err != nil {
		t.Fatalf("CreateDossier: %v", err)
	}

	// 1) inferred layer-2 edge, informing (not yet hardened)
	edges, err := EdgesFor(ctx, v, id)
	if err != nil {
		t.Fatalf("EdgesFor: %v", err)
	}
	got := findEdge(edges, "run:"+runID)
	if got == nil || got.State != StateInforming || !containsLayer(got.Layers, 2) || got.Confidence != weightLayer2 {
		t.Fatalf("expected informing layer-2 edge, got %+v (all=%+v)", got, edges)
	}

	// Backfill returns the same informing edge as a proposal
	proposals, err := Backfill(ctx, v, id)
	if err != nil || findEdge(proposals, "run:"+runID) == nil {
		t.Fatalf("Backfill missing the proposal: %+v err=%v", proposals, err)
	}

	// 2) Harden promotes the deterministic, past-probation edge into canonical refs
	if err := Harden(ctx, v, id); err != nil {
		t.Fatalf("Harden: %v", err)
	}
	edges, _ = EdgesFor(ctx, v, id)
	got = findEdge(edges, "run:"+runID)
	if got == nil || got.State != StateConfirmed || !containsLayer(got.Layers, 1) || got.Confidence != 1.0 {
		t.Fatalf("after harden expected confirmed layer-1 edge, got %+v", got)
	}

	// 3) Detach suppresses it
	if err := Detach(ctx, v, id, "run:"+runID); err != nil {
		t.Fatalf("Detach: %v", err)
	}
	edges, _ = EdgesFor(ctx, v, id)
	if findEdge(edges, "run:"+runID) != nil {
		t.Fatalf("detached edge still present: %+v", edges)
	}
}

func findEdge(edges []AttributedEdge, oref string) *AttributedEdge {
	for i := range edges {
		if edges[i].RunORef == oref {
			return &edges[i]
		}
	}
	return nil
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `go test ./pkg/jarvisattrib/ -run TestEdgesForEndToEnd -v`
Expected: FAIL — `EdgesFor`/`Backfill`/`Harden` undefined.

- [ ] **Step 4: Write minimal implementation**

```go
// pkg/jarvisattrib/lifecycle.go  (add — extend the import block with the four packages below)

import (
	"context"

	"github.com/wavetermdev/waveterm/pkg/gitinfo"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// gatherLookups loads all Runs and builds the wstore/gitinfo-backed resolvers the pure core needs.
func gatherLookups(ctx context.Context) (edgeLookups, []*waveobj.Run, error) {
	runs, err := wstore.DBGetAllObjsByType[*waveobj.Run](ctx, waveobj.OType_Run)
	if err != nil {
		return edgeLookups{}, nil, err
	}
	chNames := map[string]string{}
	lk := edgeLookups{
		channelName: func(oid string) string {
			if oid == "" {
				return ""
			}
			if n, ok := chNames[oid]; ok {
				return n
			}
			n := ""
			if ch, err := wstore.DBGet[*waveobj.Channel](ctx, oid); err == nil && ch != nil {
				n = ch.Name
			}
			chNames[oid] = n
			return n
		},
		commits: func(r *waveobj.Run) []string {
			if r.ProjectPath == "" || r.BaseCommit == "" || r.EndCommit == "" {
				return nil
			}
			cs, err := gitinfo.RangeLog(ctx, r.ProjectPath, r.BaseCommit, r.EndCommit)
			if err != nil {
				return nil
			}
			out := make([]string, len(cs))
			for i, c := range cs {
				out[i] = c.Subject
			}
			return out
		},
	}
	return lk, runs, nil
}

// EdgesFor is the D->C seam: the unified, confidence-descending dossier->Run edges (canonical layer-1
// refs + inferred layers 2-3), with the human override log applied and detached edges dropped.
// Read-only — it performs no writes (hardening is Harden/Accept).
func EdgesFor(ctx context.Context, v *wavevault.Vault, dossierID string) ([]AttributedEdge, error) {
	d, err := loadDossier(v, dossierID)
	if err != nil {
		return nil, err
	}
	lk, runs, err := gatherLookups(ctx)
	if err != nil {
		return nil, err
	}
	ov, err := readOverrides(v)
	if err != nil {
		return nil, err
	}
	return applyOverrides(assembleEdges(d, runs, lk, nowFn()), ov), nil
}

// Backfill returns the still-informing (unconfirmed) subset of EdgesFor — the proposals a human would
// review and accept when attributing past work. The batched one-click-accept UI is deferred (G).
func Backfill(ctx context.Context, v *wavevault.Vault, dossierID string) ([]AttributedEdge, error) {
	all, err := EdgesFor(ctx, v, dossierID)
	if err != nil {
		return nil, err
	}
	var proposals []AttributedEdge
	for _, e := range all {
		if e.State == StateInforming {
			proposals = append(proposals, e)
		}
	}
	return proposals, nil
}

// Harden auto-promotes deterministic layer-2 edges that have passed probation into canonical refs
// (layer-3 weak edges require an explicit Accept). Idempotent; reloads the dossier before each write so
// the baseHash guard stays current.
func Harden(ctx context.Context, v *wavevault.Vault, dossierID string) error {
	lk, runs, err := gatherLookups(ctx)
	if err != nil {
		return err
	}
	byORef := map[string]*waveobj.Run{}
	for _, r := range runs {
		byORef["run:"+r.OID] = r
	}
	d, err := loadDossier(v, dossierID)
	if err != nil {
		return err
	}
	now := nowFn()
	ov, err := readOverrides(v)
	if err != nil {
		return err
	}
	edges := applyOverrides(assembleEdges(d, runs, lk, now), ov)
	for _, e := range edges {
		if e.State == StateConfirmed || !containsLayer(e.Layers, 2) {
			continue // already canonical, or only a weak prior (needs human Accept)
		}
		r := byORef[e.RunORef]
		if r == nil || !pastProbation(r, now) {
			continue
		}
		d2, err := loadDossier(v, dossierID)
		if err != nil {
			return err
		}
		if err := hardenEdge(v, d2, e.RunORef); err != nil {
			return err
		}
	}
	return nil
}
```

Merge these into the existing `lifecycle.go` import block (it already imports `fmt`, `context`, `jarvisdossier`, `wavevault`).

- [ ] **Step 5: Run test to verify it passes**

Run: `go test ./pkg/jarvisattrib/ -run TestEdgesForEndToEnd -v`
Expected: PASS.

- [ ] **Step 6: Full package + neighbor regression**

Run: `go test ./pkg/jarvisattrib/ ./pkg/gitinfo/ ./pkg/jarvisdossier/ ./pkg/wavevault/`
Expected: all PASS. Then `go vet ./pkg/jarvisattrib/` clean.

- [ ] **Step 7: Checkpoint** — everything green; stage `lifecycle.go`, `maintest_test.go`, `edgesfor_test.go`.

---

## Closing: single feature commit (approval-gated)

After all tasks are green and self-review passes, and **only with explicit user approval** (repo git rule), make **one** commit folding in:
- all `pkg/jarvisattrib/*.go` + tests
- `pkg/gitinfo/gitinfo.go` + `gitinfo_test.go` (the `RangeLog` addition)
- `docs/deferred.md` (tuning constants)
- `docs/superpowers/specs/2026-07-24-jarvis-d-attribution-design.md` (the spec folds into this feature commit)
- `docs/superpowers/specs/2026-07-23-jarvis-second-brain-meta-spec.md` — update the tracking-table **D row** to link this spec + plan and mark Built.

Suggested message (no co-author line):

```
feat(jarvis): attribution engine — inferred dossier↔Run edges + self-healing (sub-project D)

pkg/jarvisattrib: deterministic layers 2-3 (ticket-match + structural), rebuildable
edge store + committed override log (detach/accept), harden-to-refs via B, unified
EdgesFor read for C. Adds gitinfo.RangeLog. No model calls, no RPC. Layer 4 is v2.
```

---

## Self-Review (completed while writing)

**1. Spec coverage:**
- Edge model (§1) → Task 2. Layer-1 read (§2) → Task 5. Layer-2 (§2) → Task 3. Layer-3 + anchor + no-anchor rule (§2) → Task 4. `gitinfo.RangeLog` (§5) → Task 1. Probation + harden (§3) → Tasks 4, 7. Self-correction / time-box (§3) → Task 4. Detach/Accept + override log + rebuild replay (§3,§4) → Tasks 6, 8. `EdgesFor` unified read (§7) + `Backfill` (§3) → Task 9. Testing (§9) → distributed across every task. `docs/deferred.md` placeholders → Task 2. Tracking-table row → Closing. **No uncovered spec section.**
- Deferred by design (not tasks): layer 4 semantic (v2), the ambient detach/backfill UI (G). Correctly absent.

**2. Placeholder scan:** No "TODO"/"TBD"/"handle appropriately". The PLACEHOLDER *tuning constants* are intentional, named, and recorded in `docs/deferred.md` — they are real values, not plan gaps.

**3. Type consistency:** `AttributedEdge`, `EdgeState` (`StateInforming`/`StateConfirmed`/`StateDetached`), `edgeLookups{channelName,commits}`, `overrideRecord`, and the function set (`extractLayer2`, `extractLayer3`, `windowsOverlap`, `pastProbation`, `assembleEdges`, `mergeInto`, `appendOverride`, `readOverrides`, `hardenEdge`, `loadDossier`, `applyOverrides`, `Detach`, `Accept`, `EdgesFor`, `Backfill`, `Harden`, `gatherLookups`) are used with identical signatures across the tasks that define and consume them. Reference convention `run-<oid>` ⇄ `run:<oid>` is consistent. Consumed external APIs (`jarvisdossier.LoadDossier/SetRefs/CreateDossier/DossierFacts/Dossier`, `wavevault.OpenVaultAtForTest/AllScope/Filter/Vault.Root/Commit`, `wstore.DBGetAllObjsByType/DBGet/DBInsert/DBDelete/InitWStore`, `gitinfo.RangeLog`, `waveobj.Run/Channel/OType_Run/OType_Channel`) match the real signatures verified in the codebase.
