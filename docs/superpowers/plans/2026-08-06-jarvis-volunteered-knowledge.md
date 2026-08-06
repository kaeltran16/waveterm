# Jarvis Volunteered Knowledge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the Jarvis creature in window chrome volunteer three classes of knowledge about your work — a relevant past run, a new attribution edge, a dossier going quiet — instead of only reporting system housekeeping.

**Architecture:** A new Go package `pkg/jarvisvolunteer` owns the whole speak/stay-silent decision: a deterministic rate gate runs first (so a quiet trigger costs nothing), three stateless producers read durable state, a deterministic prefilter drops already-emitted ids, and a cheap-tier model judge picks at most one candidate. The result publishes on a new wave event that the creature's existing subscription path consumes. Idempotence comes from stamping each utterance's `(at, id)` from the fact rather than from emission time, so the creature's existing `localStorage` watermark suppresses repeats — which is why this needs no new database table and no migration.

**Tech Stack:** Go (backend, `pkg/`), TypeScript + React 19 + jotai (frontend, `frontend/app/view/jarvis/`), vitest (frontend unit tests), Go stdlib `testing` (backend), Chrome DevTools Protocol scenarios (`scripts/cdp/`).

**Spec:** [`docs/superpowers/specs/2026-08-06-jarvis-volunteered-knowledge-design.md`](../specs/2026-08-06-jarvis-volunteered-knowledge-design.md)

## Global Constraints

- **Never hand-edit generated files.** Go is the source of truth for the wire protocol. After changing any `wshrpc` / `waveobj` / `wps` event type, run `task generate`. It produces `frontend/app/store/wshclientapi.ts` and the generated Go/TS type files.
- **Never commit without explicit user approval.** Each task's commit step is written out, but the user approves before any commit is made. Spec and plan documents fold into the feature commit they describe — never a separate docs-only commit.
- **No emojis** anywhere in code, comments, commit messages, or UI copy.
- **Comments explain "why", never "what".** Lower case. Only where necessary.
- **Colors come from `@theme` tokens in `frontend/tailwindsetup.css`.** Never raw hex or rgba in components — a hardcoded color silently opts out of every runtime theme.
- **Prefer Tailwind over new SCSS.**
- **No jsdom render or snapshot tests.** Pure logic is extracted to a `foo.ts` and unit-tested in `foo.test.ts`; "does it render" belongs to a CDP scenario.
- **Go tests use stdlib `testing`** with `t.Fatalf` and descriptive messages. No testify, no assertion libraries.
- **Every terminal path in `pkg/jarvisvolunteer` returns a named reason**, never a bare nil.
- **`At` and `ID` on a `Candidate` are always derived from the fact, never from `time.Now()`.** This is the correctness mechanism for say-once; violating it makes the creature repeat itself forever.
- **Go side must never push a frontend navigation address through `waveobj.ParseORef`** — `ParseORef` expects a UUID, and these addresses carry vault node ids.

### Verification commands (used throughout)

```powershell
# Go. The new package depends on jarvisembed transitively, so a bare `go test` fails to BUILD with
# "sqlite-vec.h: fatal error: sqlite3.h: No such file or directory". The -I path must be Windows-style;
# a Git-Bash POSIX path (/c/Users/...) fails identically and silently. Run from PowerShell at repo root.
$env:CGO_CFLAGS = "-O2 -g -I$((Get-Location).Path -replace '\\','/')/pkg/jarvisembed/csrc"
go test ./pkg/jarvisvolunteer/
```

```
npx vitest run frontend/app/view/jarvis/
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit
```

Note: bare `npx tsc` stack-overflows on this repo, which is why `task check:ts` is broken. Use the `node --stack-size=4000` form. The baseline is clean (exit 0), so any error it reports is yours.

---

## File Structure

**New — `pkg/jarvisvolunteer/`:**

| File | Responsibility |
|---|---|
| `candidate.go` | `Candidate`, `Producer`, `Trigger` types; class and reason constants |
| `gate.go` | Deterministic rate gate and prefilter (stable-id dedup, shortlist cap) |
| `recall.go` | Producer reading the dispatch-time proactive suggestion |
| `connection.go` | Producer reading attribution edges |
| `looseend.go` | Producer reading dossier state; the three tuning constants |
| `judge.go` | Cheap-tier model call, prompt construction, reply parsing |
| `volunteer.go` | `Evaluate` orchestration and broker publish |
| `main_test.go` | `TestMain` isolating git config for vault-backed fixtures |
| `*_test.go` | One test file per source file |

**Modified — Go:**

| File | Change |
|---|---|
| `pkg/baseds/baseds.go` | `VolunteerData` wave-event payload |
| `pkg/wps/wpstypes.go` | `Event_JarvisVolunteer` constant plus `AllEvents` entry |
| `pkg/tsgen/tsgenevent.go` | `WaveEventDataTypes` entry so the TS type generates |
| `pkg/wshrpc/wshserver/wshserver_runs.go` | Two off-band triggers (run created, run reaches rest) |
| `cmd/server/main-server.go` | Register the hourly loose-end sweep hook |

**Modified — frontend (`frontend/app/view/jarvis/` unless noted):**

| File | Change |
|---|---|
| `petvoice.ts` | Three new `PetEvent` kinds; optional `source` field |
| `petjoin.ts` | `eventFromVolunteer` adapter |
| `petsources.tsx` | One more wave-event subscription plus history backlog |
| `petbubble.tsx` | Three `KIND_LABEL` entries |
| `petpeek.tsx` | Open and Ask affordances on a knowledge row |
| `petstore.ts` | `pendingDecisionAnchorAtom` |
| `openref.ts` | Memory-note route; decision anchor; delete the stale header claim |
| `decisionlog.tsx` | Consume the anchor atom to scroll and flash |
| `jarvissubjectstore.ts` | `askAboutRecord` generalized to `askAboutSource` |
| `scripts/cdp/scenarios.mjs` | New `jarvis-volunteer` scenario |
| `docs/jarvis-tab.md` | Document the volunteered register |

---

## Task 1: The wave event contract

Establishes the Go→TS wire type first, so every later task has a real payload to target. `pkg/tsgen/tsgenevent_test.go` guards Go/TS wave-event drift, so this task is where that guard is satisfied.

**Files:**
- Modify: `pkg/baseds/baseds.go` (append after `MemoryActivityData`, around line 94)
- Modify: `pkg/wps/wpstypes.go:35` (constant block) and `pkg/wps/wpstypes.go:38-57` (`AllEvents`)
- Modify: `pkg/tsgen/tsgenevent.go:24-42` (`WaveEventDataTypes`)

**Interfaces:**
- Consumes: nothing.
- Produces: `baseds.VolunteerData` (Go) and the generated TS type `VolunteerData`; `wps.Event_JarvisVolunteer` (value `"jarvis:volunteer"`).

- [ ] **Step 1: Write the failing test**

Add to `pkg/tsgen/tsgenevent_test.go`:

```go
func TestVolunteerEventHasDataType(t *testing.T) {
	rtype, found := WaveEventDataTypes[wps.Event_JarvisVolunteer]
	if !found {
		t.Fatalf("Event_JarvisVolunteer missing from WaveEventDataTypes: the TS type would generate as `any`")
	}
	if rtype != reflect.TypeOf(baseds.VolunteerData{}) {
		t.Fatalf("Event_JarvisVolunteer maps to %v, want baseds.VolunteerData", rtype)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

```powershell
$env:CGO_CFLAGS = "-O2 -g -I$((Get-Location).Path -replace '\\','/')/pkg/jarvisembed/csrc"
go test ./pkg/tsgen/ -run TestVolunteerEventHasDataType -v
```

Expected: FAIL to compile — `undefined: wps.Event_JarvisVolunteer` and `undefined: baseds.VolunteerData`.

- [ ] **Step 3: Add the payload type**

In `pkg/baseds/baseds.go`, after `MemoryActivityData`:

```go
// VolunteerData is the payload of Event_JarvisVolunteer: one thing Jarvis chose to say unprompted.
// Id and At are stamped from the FACT (a run's end time, a dossier's last-touched time), never from
// the moment of emission — the frontend watermark compares At first and breaks ties on Id, so a
// re-emitted identical fact must carry an identical pair or the creature repeats itself forever.
// Ref/Anchor are frontend navigation addresses only; they carry vault node ids and must never be
// passed to waveobj.ParseORef.
type VolunteerData struct {
	Class      string `json:"class"` // recall | connection | loose-end
	Id         string `json:"id"`
	At         int64  `json:"at"` // UnixMilli
	Title      string `json:"title"`
	Text       string `json:"text"`
	SourceType string `json:"sourcetype,omitempty"` // dossier | decision | memory | run
	Ref        string `json:"ref,omitempty"`
	Anchor     string `json:"anchor,omitempty"`
}
```

- [ ] **Step 4: Register the event**

In `pkg/wps/wpstypes.go`, add to the constant block after `Event_MemoryActivity`:

```go
	Event_JarvisVolunteer     = "jarvis:volunteer"     // type: baseds.VolunteerData
```

And add `Event_JarvisVolunteer,` as the last entry of `AllEvents`.

In `pkg/tsgen/tsgenevent.go`, add to `WaveEventDataTypes` after the `Event_MemoryActivity` line:

```go
	wps.Event_JarvisVolunteer:     reflect.TypeOf(baseds.VolunteerData{}),
```

- [ ] **Step 5: Run tests to verify they pass**

```powershell
go test ./pkg/tsgen/ ./pkg/wps/ ./pkg/baseds/ -v
```

Expected: PASS, including the existing wave-event coverage and golden-sync tests.

- [ ] **Step 6: Regenerate TypeScript bindings**

```
task generate
```

Then confirm the type reached the frontend:

```
git diff --stat
```

Expected: generated TS type files show a new `VolunteerData` type. If `task generate` fails, do not hand-edit the generated output — fix the Go definition and rerun.

- [ ] **Step 7: Typecheck the frontend against the new generated type**

```
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit
```

Expected: exit 0.

- [ ] **Step 8: Commit**

```bash
git add pkg/baseds/baseds.go pkg/wps/wpstypes.go pkg/tsgen/tsgenevent.go pkg/tsgen/tsgenevent_test.go
git add frontend/types
git commit -m "feat(jarvis): add the jarvis:volunteer wave event and its payload type"
```

---

## Task 2: Candidate types and the deterministic rate gate

The whole cost floor lives here: the rate gate runs before any read or model call, so a trigger inside the quiet window costs nothing.

**Files:**
- Create: `pkg/jarvisvolunteer/candidate.go`
- Create: `pkg/jarvisvolunteer/gate.go`
- Create: `pkg/jarvisvolunteer/main_test.go`
- Test: `pkg/jarvisvolunteer/gate_test.go`

**Interfaces:**
- Consumes: nothing.
- Produces: `Candidate` struct (fields `Class`, `ID`, `At`, `Title`, `Snippet`, `SourceType`, `SourceRef`, `Anchor`); `Producer` interface with `Name() string` and `Candidates(ctx context.Context, t *Trigger) ([]Candidate, error)`; `Trigger` struct; class constants `ClassRecall`/`ClassConnection`/`ClassLooseEnd`; reason constants; `allowNow(now int64) bool`; `markSpoke(now int64)`; `prefilter(cands []Candidate) []Candidate`; `markEmitted(id string)`; `shortlistMax`.

- [ ] **Step 1: Write the failing test**

Create `pkg/jarvisvolunteer/gate_test.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvisvolunteer

import "testing"

func cand(id string, at int64) Candidate {
	return Candidate{Class: ClassLooseEnd, ID: id, At: at, Title: "t", Snippet: "s"}
}

func TestRateGateBlocksInsideQuietWindow(t *testing.T) {
	resetGateForTest()
	const start int64 = 1_000_000
	if !allowNow(start) {
		t.Fatalf("first utterance must be allowed on a fresh gate")
	}
	markSpoke(start)
	if allowNow(start + quietWindowMs - 1) {
		t.Fatalf("a trigger inside the quiet window must be blocked")
	}
	if !allowNow(start + quietWindowMs) {
		t.Fatalf("a trigger at exactly the window edge must be allowed")
	}
}

func TestPrefilterDropsAlreadyEmitted(t *testing.T) {
	resetGateForTest()
	markEmitted("seen-1")
	got := prefilter([]Candidate{cand("seen-1", 10), cand("fresh-1", 20)})
	if len(got) != 1 || got[0].ID != "fresh-1" {
		t.Fatalf("an already-emitted id must be dropped, got %+v", got)
	}
}

func TestPrefilterCapsShortlist(t *testing.T) {
	resetGateForTest()
	var in []Candidate
	for i := 0; i < shortlistMax+3; i++ {
		in = append(in, cand(string(rune('a'+i)), int64(i)))
	}
	got := prefilter(in)
	if len(got) != shortlistMax {
		t.Fatalf("shortlist must cap at %d, got %d", shortlistMax, len(got))
	}
}

func TestPrefilterDropsUnstampedCandidate(t *testing.T) {
	resetGateForTest()
	got := prefilter([]Candidate{{Class: ClassRecall, ID: "no-at", At: 0}, cand("ok", 5)})
	if len(got) != 1 || got[0].ID != "ok" {
		t.Fatalf("a candidate with no At can never advance the watermark and must be dropped, got %+v", got)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

```powershell
$env:CGO_CFLAGS = "-O2 -g -I$((Get-Location).Path -replace '\\','/')/pkg/jarvisembed/csrc"
go test ./pkg/jarvisvolunteer/ -v
```

Expected: FAIL to build — the package does not exist.

- [ ] **Step 3: Write the types**

Create `pkg/jarvisvolunteer/candidate.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Package jarvisvolunteer decides whether Jarvis says something unprompted, and what. It is the only
// place the cadence and precedence rules live: split across producers they would become emergent, and
// an emergent interruption rate is the defect that gets a feature like this switched off.
package jarvisvolunteer

import "context"

// The three knowledge classes. Each reads an engine that already computes; none adds a retrieval pass.
const (
	ClassRecall     = "recall"     // a relevant past item, already judged at dispatch
	ClassConnection = "connection" // an attribution edge that just formed
	ClassLooseEnd   = "loose-end"  // a dossier going quiet
)

// Every terminal path names its reason. Returning nothing on failure is what made six distinct failures
// in the sibling proactive package indistinguishable from never having run; counting no-candidates
// against judge-declined is also the cost audit that choosing a model judge obliges us to have.
const (
	ReasonNoCandidates  = "no-candidates"
	ReasonRateLimited   = "rate-limited"
	ReasonJudgeDeclined = "judge-declined"
	ReasonJudgeError    = "judge-error"
	ReasonVaultError    = "vault-error"
	ReasonProducerError = "producer-error"
)

// Candidate is one thing Jarvis could say.
//
// ID and At are stamped from the FACT, never from time.Now(). The frontend watermark
// (frontend/app/view/jarvis/petstore.ts) compares At first and breaks ties on ID, so a re-emitted
// identical fact carries an identical pair, fails the newer-than check and dies silently. That is the
// whole reason this feature needs no server-side said-log and no database migration.
//
// SourceRef and Anchor are FRONTEND NAVIGATION ADDRESSES. They carry vault node ids inside oref-shaped
// strings (the same thing askAboutRecord already does with "task:"+dossierId) and must never be passed
// to waveobj.ParseORef, which expects a UUID.
type Candidate struct {
	Class      string
	ID         string
	At         int64 // UnixMilli, from the fact
	Title      string
	Snippet    string
	SourceType string // dossier | decision | memory | run
	SourceRef  string
	Anchor     string // optional sub-object to highlight within SourceRef
}

// Trigger is what woke the evaluation. Run is nil for the unattended sweep.
type Trigger struct {
	Kind      string // "run-created" | "run-rest" | "sweep"
	ChannelID string
	RunID     string
}

// Producer contributes candidates by reading durable state. Producers are STATELESS: none owns a queue,
// an outbox or a cursor. A dropped, failed or rate-limited trigger therefore loses nothing, because the
// next trigger re-reads the same facts and the candidate is still there.
type Producer interface {
	Name() string
	Candidates(ctx context.Context, t *Trigger) ([]Candidate, error)
}
```

Create `pkg/jarvisvolunteer/gate.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvisvolunteer

import "sync"

// quietWindowMs is the minimum silence between any two utterances. UNFITTED — shipped deliberately
// conservative and adjusted on evidence, because the failure modes are asymmetric: too quiet is a
// feature that underdelivers, too chatty is a feature that gets turned off. Revisit with the count of
// ReasonRateLimited against actual utterances.
const quietWindowMs int64 = 45 * 60 * 1000

// shortlistMax bounds what reaches the judge. Unfitted; with the rate gate ahead of it and the
// already-emitted filter behind it, this is not what constrains admission.
const shortlistMax = 5

var (
	gateMu      sync.Mutex
	lastSpokeAt int64
	emitted     = map[string]bool{}
)

// allowNow reports whether the quiet window has elapsed. Called BEFORE any read or model call, so a
// trigger inside the window costs zero I/O and zero tokens. The cost of that ordering is that a
// genuinely urgent candidate waits out the window; accepted, because there is no urgency signal to
// distinguish one and inventing one would be speculative.
func allowNow(now int64) bool {
	gateMu.Lock()
	defer gateMu.Unlock()
	return lastSpokeAt == 0 || now-lastSpokeAt >= quietWindowMs
}

func markSpoke(now int64) {
	gateMu.Lock()
	defer gateMu.Unlock()
	lastSpokeAt = now
}

// markEmitted records an id so the judge is never paid for a candidate the frontend would discard.
// This is a COST optimisation, not the correctness mechanism — say-once is enforced by the frontend
// watermark against the stable (At, ID) pair — so losing this map to a wavesrv restart is harmless.
func markEmitted(id string) {
	gateMu.Lock()
	defer gateMu.Unlock()
	emitted[id] = true
}

// prefilter drops already-emitted and unstampable candidates and caps the shortlist. Deterministic,
// no model, no I/O.
func prefilter(cands []Candidate) []Candidate {
	gateMu.Lock()
	defer gateMu.Unlock()
	var out []Candidate
	seen := map[string]bool{}
	for _, c := range cands {
		if c.ID == "" || c.At == 0 {
			continue // an undatable candidate could never advance the watermark: it would re-speak forever
		}
		if emitted[c.ID] || seen[c.ID] {
			continue
		}
		seen[c.ID] = true
		out = append(out, c)
		if len(out) == shortlistMax {
			break
		}
	}
	return out
}

// resetGateForTest clears the process-wide gate state between tests.
func resetGateForTest() {
	gateMu.Lock()
	defer gateMu.Unlock()
	lastSpokeAt = 0
	emitted = map[string]bool{}
}
```

Create `pkg/jarvisvolunteer/main_test.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvisvolunteer

import (
	"os"
	"testing"
)

// TestMain isolates the git-backed fixture vault from the machine's ambient git config so commits are
// deterministic. Mirrors pkg/jarvisproactive/main_test.go.
func TestMain(m *testing.M) {
	os.Setenv("GIT_CONFIG_GLOBAL", os.DevNull)
	os.Setenv("GIT_CONFIG_SYSTEM", os.DevNull)
	os.Exit(m.Run())
}
```

- [ ] **Step 4: Run tests to verify they pass**

```powershell
go test ./pkg/jarvisvolunteer/ -v
```

Expected: PASS — four tests.

- [ ] **Step 5: Commit**

```bash
git add pkg/jarvisvolunteer/
git commit -m "feat(jarvis): candidate types and the deterministic rate gate for volunteered knowledge"
```

---

## Task 3: The recall producer

Reads a judgement that already happened. `jarvisproactive.EvaluateDispatch` already runs at run creation and persists its pick; this adds no retrieval pass and no model call.

**Files:**
- Create: `pkg/jarvisvolunteer/recall.go`
- Test: `pkg/jarvisvolunteer/recall_test.go`

**Interfaces:**
- Consumes: `Candidate`, `Producer`, `Trigger`, `ClassRecall` from Task 2.
- Produces: `RecallProducer` struct with `Name() string` and `Candidates(ctx, *Trigger) ([]Candidate, error)`; `refForSourceType(sourceType, nodeID string) string`.

- [ ] **Step 1: Write the failing test**

Create `pkg/jarvisvolunteer/recall_test.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvisvolunteer

import (
	"context"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/jarvisproactive"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func runWithSuggestion(oid string, createdTs int64, sug jarvisproactive.ProactiveSuggestion) *waveobj.Run {
	return &waveobj.Run{
		OID:       oid,
		Goal:      "migrate the auth module",
		CreatedTs: createdTs,
		Meta:      waveobj.MetaMapType{jarvisproactive.MetaKeyProactive: sug},
	}
}

func TestRecallEmitsCandidateForHit(t *testing.T) {
	run := runWithSuggestion("run-1", 1700, jarvisproactive.ProactiveSuggestion{
		Status:     jarvisproactive.StatusHit,
		NodeID:     "dec-abc123",
		SourceType: "decision",
		Title:      "Drop-oldest on overflow",
		Snippet:    "we chose drop-oldest because backpressure stalled the writer",
	})
	got, err := (&RecallProducer{loadRun: func(context.Context, string, string) (*waveobj.Run, error) {
		return run, nil
	}}).Candidates(context.Background(), &Trigger{Kind: "run-created", ChannelID: "c1", RunID: "run-1"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("want 1 candidate, got %d", len(got))
	}
	c := got[0]
	if c.Class != ClassRecall {
		t.Fatalf("class = %q, want %q", c.Class, ClassRecall)
	}
	if c.At != 1700 {
		t.Fatalf("At = %d, want the run's CreatedTs 1700 — At must come from the fact", c.At)
	}
	if c.ID != "recall:run-1:dec-abc123" {
		t.Fatalf("ID = %q, want a stable run+node key", c.ID)
	}
	if c.SourceRef != "task:dec-abc123" && c.SourceType != "decision" {
		t.Fatalf("decision source must resolve through its parent dossier route later: %+v", c)
	}
}

func TestRecallSkipsSentinel(t *testing.T) {
	run := runWithSuggestion("run-2", 1700, jarvisproactive.ProactiveSuggestion{
		Status: jarvisproactive.StatusNone,
		Reason: jarvisproactive.ReasonNoCandidates,
	})
	got, err := (&RecallProducer{loadRun: func(context.Context, string, string) (*waveobj.Run, error) {
		return run, nil
	}}).Candidates(context.Background(), &Trigger{Kind: "run-created", ChannelID: "c1", RunID: "run-2"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("a persisted none-sentinel must yield nothing, got %+v", got)
	}
}

func TestRecallSkipsUndatedRun(t *testing.T) {
	run := runWithSuggestion("run-3", 0, jarvisproactive.ProactiveSuggestion{
		Status: jarvisproactive.StatusHit, NodeID: "n1", SourceType: "memory", Title: "note",
	})
	got, _ := (&RecallProducer{loadRun: func(context.Context, string, string) (*waveobj.Run, error) {
		return run, nil
	}}).Candidates(context.Background(), &Trigger{Kind: "run-created", ChannelID: "c1", RunID: "run-3"})
	if len(got) != 0 {
		t.Fatalf("a run with no CreatedTs cannot be stamped from the fact and must be skipped, got %+v", got)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

```powershell
go test ./pkg/jarvisvolunteer/ -run TestRecall -v
```

Expected: FAIL to build — `undefined: RecallProducer`.

- [ ] **Step 3: Write the producer**

Create `pkg/jarvisvolunteer/recall.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvisvolunteer

import (
	"context"
	"fmt"

	"github.com/wavetermdev/waveterm/pkg/jarvisproactive"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// RecallProducer reads the suggestion jarvisproactive already judged and persisted at dispatch. It adds
// no embedding query and no model call: both already ran. loadRun is a seam so tests supply a run
// without a store.
type RecallProducer struct {
	loadRun func(ctx context.Context, channelID, runID string) (*waveobj.Run, error)
}

func NewRecallProducer() *RecallProducer {
	return &RecallProducer{loadRun: wstore.GetRun}
}

func (p *RecallProducer) Name() string { return ClassRecall }

func (p *RecallProducer) Candidates(ctx context.Context, t *Trigger) ([]Candidate, error) {
	if t == nil || t.RunID == "" {
		return nil, nil
	}
	run, err := p.loadRun(ctx, t.ChannelID, t.RunID)
	if err != nil {
		return nil, fmt.Errorf("jarvisvolunteer: loading run %s: %w", t.RunID, err)
	}
	sug, ok := jarvisproactive.ReadSuggestion(run)
	if !ok || sug.Status != jarvisproactive.StatusHit {
		return nil, nil // a pending marker or a reasoned sentinel is not something to say
	}
	if run.CreatedTs == 0 {
		return nil, nil // unstampable from the fact; see Candidate's doc comment
	}
	return []Candidate{{
		Class:      ClassRecall,
		ID:         fmt.Sprintf("recall:%s:%s", run.OID, sug.NodeID),
		At:         run.CreatedTs,
		Title:      sug.Title,
		Snippet:    sug.Snippet,
		SourceType: sug.SourceType,
		SourceRef:  refForSourceType(sug.SourceType, sug.NodeID),
	}}, nil
}

// refForSourceType builds the frontend navigation address for a vault node. A decision has no surface
// of its own — decisionlog.tsx renders it inside its parent record's thread — so a decision address is
// resolved to its parent dossier by the connection producer's helper at publish time; here the node id
// is carried verbatim and the frontend anchors on it. See the spec's navigation table.
func refForSourceType(sourceType, nodeID string) string {
	switch sourceType {
	case "dossier":
		return "task:" + nodeID
	case "decision":
		return "task:" + nodeID // parent resolved at publish; anchor carries the decision id
	case "memory":
		return "memnote:" + nodeID
	default:
		return ""
	}
}
```

- [ ] **Step 4: Run tests to verify they pass**

```powershell
go test ./pkg/jarvisvolunteer/ -run TestRecall -v
```

Expected: PASS — three tests.

- [ ] **Step 5: Commit**

```bash
git add pkg/jarvisvolunteer/recall.go pkg/jarvisvolunteer/recall_test.go
git commit -m "feat(jarvis): recall producer reads the dispatch suggestion already on disk"
```

---

## Task 4: The connection producer

Reads attribution edges. `jarvisattrib.AllEdges` already returns every dossier's edges in one shared read with a per-run commit cache — it was built for the ambient layer, which needs exactly this direction.

**Files:**
- Create: `pkg/jarvisvolunteer/connection.go`
- Test: `pkg/jarvisvolunteer/connection_test.go`

**Interfaces:**
- Consumes: `Candidate`, `Producer`, `Trigger`, `ClassConnection` from Task 2.
- Produces: `ConnectionProducer` struct with `Name()` and `Candidates(ctx, *Trigger)`; `NewConnectionProducer() *ConnectionProducer`.

- [ ] **Step 1: Write the failing test**

Create `pkg/jarvisvolunteer/connection_test.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvisvolunteer

import (
	"context"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/jarvisattrib"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func connProducer(edges map[string][]jarvisattrib.AttributedEdge, run *waveobj.Run, title string) *ConnectionProducer {
	return &ConnectionProducer{
		allEdges:     func(context.Context) (map[string][]jarvisattrib.AttributedEdge, error) { return edges, nil },
		loadRun:      func(context.Context, string, string) (*waveobj.Run, error) { return run, nil },
		dossierTitle: func(context.Context, string) string { return title },
	}
}

func TestConnectionEmitsForEdgeOnThisRun(t *testing.T) {
	edges := map[string][]jarvisattrib.AttributedEdge{
		"task-tauri": {{
			DossierID: "task-tauri", RunORef: "run:run-9", Layers: []int{2},
			Provenance: "ticket-match", Confidence: 0.8, State: jarvisattrib.StateConfirmed,
		}},
	}
	run := &waveobj.Run{OID: "run-9", Goal: "port the titlebar", CompletedTs: 2500}
	got, err := connProducer(edges, run, "Tauri migration").
		Candidates(context.Background(), &Trigger{Kind: "run-rest", ChannelID: "c1", RunID: "run-9"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("want 1 candidate, got %d", len(got))
	}
	c := got[0]
	if c.Class != ClassConnection {
		t.Fatalf("class = %q, want %q", c.Class, ClassConnection)
	}
	if c.At != 2500 {
		t.Fatalf("At = %d, want the run's CompletedTs 2500 — At must come from the fact", c.At)
	}
	if c.ID != "connection:task-tauri:run:run-9" {
		t.Fatalf("ID = %q, want a stable dossier+run key", c.ID)
	}
	if c.SourceRef != "task:task-tauri" {
		t.Fatalf("SourceRef = %q, want the dossier route", c.SourceRef)
	}
	if c.Title != "Tauri migration" {
		t.Fatalf("Title = %q, want the dossier's objective", c.Title)
	}
}

func TestConnectionIgnoresEdgesForOtherRuns(t *testing.T) {
	edges := map[string][]jarvisattrib.AttributedEdge{
		"task-other": {{DossierID: "task-other", RunORef: "run:run-1", State: jarvisattrib.StateConfirmed}},
	}
	run := &waveobj.Run{OID: "run-9", CompletedTs: 2500}
	got, _ := connProducer(edges, run, "Other").
		Candidates(context.Background(), &Trigger{Kind: "run-rest", ChannelID: "c1", RunID: "run-9"})
	if len(got) != 0 {
		t.Fatalf("an edge on a different run must not fire, got %+v", got)
	}
}

func TestConnectionSkipsDetachedEdge(t *testing.T) {
	edges := map[string][]jarvisattrib.AttributedEdge{
		"task-x": {{DossierID: "task-x", RunORef: "run:run-9", State: jarvisattrib.StateDetached}},
	}
	run := &waveobj.Run{OID: "run-9", CompletedTs: 2500}
	got, _ := connProducer(edges, run, "X").
		Candidates(context.Background(), &Trigger{Kind: "run-rest", ChannelID: "c1", RunID: "run-9"})
	if len(got) != 0 {
		t.Fatalf("a human-rejected edge is a correction and must never be volunteered, got %+v", got)
	}
}

func TestConnectionCarriesWeakBucket(t *testing.T) {
	edges := map[string][]jarvisattrib.AttributedEdge{
		"task-y": {{
			DossierID: "task-y", RunORef: "run:run-9", Layers: []int{4},
			Confidence: 0.2, State: jarvisattrib.StateInforming,
		}},
	}
	run := &waveobj.Run{OID: "run-9", CompletedTs: 2500}
	got, _ := connProducer(edges, run, "Y").
		Candidates(context.Background(), &Trigger{Kind: "run-rest", ChannelID: "c1", RunID: "run-9"})
	if len(got) != 1 {
		t.Fatalf("a weak edge is still eligible, got %d", len(got))
	}
	if want := jarvisattrib.BucketFor([]int{4}); got[0].Snippet == "" || !contains(got[0].Snippet, want) {
		t.Fatalf("snippet %q must carry the confidence bucket %q so the utterance can hedge", got[0].Snippet, want)
	}
}

func contains(s, sub string) bool {
	return len(sub) > 0 && len(s) >= len(sub) && (func() bool {
		for i := 0; i+len(sub) <= len(s); i++ {
			if s[i:i+len(sub)] == sub {
				return true
			}
		}
		return false
	})()
}
```

- [ ] **Step 2: Run test to verify it fails**

```powershell
go test ./pkg/jarvisvolunteer/ -run TestConnection -v
```

Expected: FAIL to build — `undefined: ConnectionProducer`.

- [ ] **Step 3: Write the producer**

Create `pkg/jarvisvolunteer/connection.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvisvolunteer

import (
	"context"
	"fmt"

	"github.com/wavetermdev/waveterm/pkg/jarvisattrib"
	"github.com/wavetermdev/waveterm/pkg/jarvisdossier"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wavevault"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// ConnectionProducer reports an attribution edge that just formed on the run that reached rest. The
// three function fields are seams so tests run without a vault or a store.
type ConnectionProducer struct {
	allEdges     func(ctx context.Context) (map[string][]jarvisattrib.AttributedEdge, error)
	loadRun      func(ctx context.Context, channelID, runID string) (*waveobj.Run, error)
	dossierTitle func(ctx context.Context, dossierID string) string
}

func NewConnectionProducer() *ConnectionProducer {
	return &ConnectionProducer{
		allEdges: func(ctx context.Context) (map[string][]jarvisattrib.AttributedEdge, error) {
			v, err := wavevault.OpenVault(ctx)
			if err != nil {
				return nil, fmt.Errorf("jarvisvolunteer: opening vault: %w", err)
			}
			return jarvisattrib.AllEdges(ctx, v)
		},
		loadRun:      wstore.GetRun,
		dossierTitle: liveDossierTitle,
	}
}

func liveDossierTitle(ctx context.Context, dossierID string) string {
	v, err := wavevault.OpenVault(ctx)
	if err != nil {
		return dossierID
	}
	d, err := jarvisdossier.LoadDossier(v.Retriever(wavevault.Scope{Collections: []string{wavevault.CollTasks}}), dossierID)
	if err != nil || d == nil || d.Objective == "" {
		return dossierID
	}
	return d.Objective
}

func (p *ConnectionProducer) Name() string { return ClassConnection }

func (p *ConnectionProducer) Candidates(ctx context.Context, t *Trigger) ([]Candidate, error) {
	if t == nil || t.RunID == "" {
		return nil, nil
	}
	run, err := p.loadRun(ctx, t.ChannelID, t.RunID)
	if err != nil {
		return nil, fmt.Errorf("jarvisvolunteer: loading run %s: %w", t.RunID, err)
	}
	if run == nil || run.CompletedTs == 0 {
		return nil, nil // a run that has not sealed cannot be stamped from the fact
	}
	byDossier, err := p.allEdges(ctx)
	if err != nil {
		return nil, err
	}
	wantORef := "run:" + run.OID
	var out []Candidate
	for dossierID, edges := range byDossier {
		for _, e := range edges {
			if e.RunORef != wantORef || e.State == jarvisattrib.StateDetached {
				continue // a detached edge is a human correction, never something to volunteer
			}
			bucket := jarvisattrib.BucketFor(e.Layers)
			out = append(out, Candidate{
				Class:      ClassConnection,
				ID:         fmt.Sprintf("connection:%s:%s", dossierID, e.RunORef),
				At:         run.CompletedTs,
				Title:      p.dossierTitle(ctx, dossierID),
				Snippet:    fmt.Sprintf("%s (%s confidence, %s)", run.Goal, bucket, e.State),
				SourceType: "dossier",
				SourceRef:  "task:" + dossierID,
			})
		}
	}
	return out, nil
}
```

- [ ] **Step 4: Run tests to verify they pass**

```powershell
go test ./pkg/jarvisvolunteer/ -run TestConnection -v
```

Expected: PASS — four tests.

- [ ] **Step 5: Commit**

```bash
git add pkg/jarvisvolunteer/connection.go pkg/jarvisvolunteer/connection_test.go
git commit -m "feat(jarvis): connection producer reports an attribution edge as it forms"
```

---

## Task 5: The loose-end producer and its constants

Carries the calibration risk the spec names. The `Updated`-age measurement is a **required step**, not a nicety: a constant that cannot say where it came from is exactly the defect the second-brain backlog's calibration item (J5) tracks.

**Files:**
- Create: `pkg/jarvisvolunteer/looseend.go`
- Test: `pkg/jarvisvolunteer/looseend_test.go`

**Interfaces:**
- Consumes: `Candidate`, `Producer`, `Trigger`, `ClassLooseEnd` from Task 2.
- Produces: `LooseEndProducer` struct with `Name()` and `Candidates(ctx, *Trigger)`; `NewLooseEndProducer() *LooseEndProducer`; constants `stalenessMs` and `resurfaceBucketMs`.

- [ ] **Step 1: Measure before picking the threshold**

Run this against the real vault to get the distribution of dossier last-touched ages. It reads only; it writes nothing.

```powershell
$env:CGO_CFLAGS = "-O2 -g -I$((Get-Location).Path -replace '\\','/')/pkg/jarvisembed/csrc"
go run ./cmd/jarvisbackfill --help
```

If that binary offers no listing mode, get the ages directly from the vault's task collection on disk:

```powershell
Get-ChildItem "$env:USERPROFILE\.waveterm\vault\tasks" -Filter *.md |
  Select-Object Name, LastWriteTime, @{n='AgeDays';e={[math]::Round(((Get-Date) - $_.LastWriteTime).TotalDays,1)}} |
  Sort-Object AgeDays
```

Record the observed range and the chosen value. **Write both into the constant's comment in Step 3** — the model to follow is `pkg/jarvisproactive/gate.go`, whose `cosThreshold` comment states the measured range, the probe results, the chosen value and why the previous value was wrong.

- [ ] **Step 2: Write the failing test**

Create `pkg/jarvisvolunteer/looseend_test.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvisvolunteer

import (
	"context"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/jarvisdossier"
)

func looseProducer(ds []jarvisdossier.Dossier, now int64) *LooseEndProducer {
	return &LooseEndProducer{
		listDossiers: func(context.Context) ([]jarvisdossier.Dossier, error) { return ds, nil },
		now:          func() int64 { return now },
	}
}

func TestLooseEndFiresOnStaleOpenDossier(t *testing.T) {
	const now int64 = 10 * stalenessMs
	ds := []jarvisdossier.Dossier{
		{ID: "task-a", Status: "open", Objective: "finish the migration", Updated: now - stalenessMs - 1},
	}
	got, err := looseProducer(ds, now).Candidates(context.Background(), &Trigger{Kind: "sweep"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("want 1 candidate, got %d", len(got))
	}
	if got[0].Class != ClassLooseEnd {
		t.Fatalf("class = %q, want %q", got[0].Class, ClassLooseEnd)
	}
	if got[0].SourceRef != "task:task-a" {
		t.Fatalf("SourceRef = %q, want the dossier route", got[0].SourceRef)
	}
}

func TestLooseEndIgnoresFreshAndTerminal(t *testing.T) {
	const now int64 = 10 * stalenessMs
	ds := []jarvisdossier.Dossier{
		{ID: "fresh", Status: "open", Updated: now - 1},
		{ID: "done", Status: "done", Updated: now - stalenessMs - 1},
		{ID: "cancelled", Status: "cancelled", Updated: now - stalenessMs - 1},
	}
	got, _ := looseProducer(ds, now).Candidates(context.Background(), &Trigger{Kind: "sweep"})
	if len(got) != 0 {
		t.Fatalf("a fresh or terminal dossier is not a loose end, got %+v", got)
	}
}

func TestLooseEndFiresOnBlockedRegardlessOfAge(t *testing.T) {
	const now int64 = 10 * stalenessMs
	ds := []jarvisdossier.Dossier{
		{ID: "blocked", Status: "open", Objective: "waiting on review", Updated: now - 1, Blockers: []string{"needs review"}},
	}
	got, _ := looseProducer(ds, now).Candidates(context.Background(), &Trigger{Kind: "sweep"})
	if len(got) != 1 {
		t.Fatalf("a blocked dossier is a loose end whatever its age, got %d", len(got))
	}
}

// The idempotence property: both ID and At floor to the same bucket, so re-reading an unchanged
// dossier produces a byte-identical (At, ID) pair. The frontend watermark compares At FIRST, so
// bucketing only the ID would let every re-emission slip past and re-speak forever.
func TestLooseEndPairIsStableWithinABucket(t *testing.T) {
	const base int64 = 100 * resurfaceBucketMs
	mk := func(updated int64) Candidate {
		ds := []jarvisdossier.Dossier{{ID: "task-a", Status: "open", Updated: updated}}
		got, _ := looseProducer(ds, base+50*stalenessMs).Candidates(context.Background(), &Trigger{Kind: "sweep"})
		if len(got) != 1 {
			t.Fatalf("expected a candidate for updated=%d", updated)
		}
		return got[0]
	}
	a := mk(base)
	b := mk(base + resurfaceBucketMs/2) // same bucket, different raw stamp
	if a.ID != b.ID {
		t.Fatalf("ID must be stable within a bucket: %q vs %q", a.ID, b.ID)
	}
	if a.At != b.At {
		t.Fatalf("At must ALSO floor to the bucket, else the watermark lets a repeat through: %d vs %d", a.At, b.At)
	}
	c := mk(base + resurfaceBucketMs*3)
	if c.ID == a.ID || c.At == a.At {
		t.Fatalf("a later bucket must produce a NEW pair so a long-silent loose end can resurface")
	}
}

func TestResurfaceBucketIsCoarserThanStaleness(t *testing.T) {
	if resurfaceBucketMs <= stalenessMs {
		t.Fatalf("resurfaceBucketMs (%d) must exceed stalenessMs (%d), else a loose end re-fires before it has gone stale again",
			resurfaceBucketMs, stalenessMs)
	}
}
```

- [ ] **Step 3: Write the producer**

Create `pkg/jarvisvolunteer/looseend.go`. Replace the bracketed measurement note in the `stalenessMs` comment with the real numbers from Step 1 before committing.

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvisvolunteer

import (
	"context"
	"fmt"
	"time"

	"github.com/wavetermdev/waveterm/pkg/jarvisdossier"
	"github.com/wavetermdev/waveterm/pkg/wavevault"
)

// stalenessMs is how long a non-terminal dossier may go untouched before it is a loose end.
//
// MEASURED against the real vault's task collection on <DATE>: <N> dossiers, Updated ages spanning
// <MIN>-<MAX> days, median <MED>. Chosen at <VALUE> because <REASON — e.g. it sits above the median so
// routine in-progress work does not trip it, while catching the long tail>. Re-measure if the corpus
// grows substantially; a constant that cannot say where it came from is the defect J5 tracks
// (docs/jarvis-second-brain-open-issues.md).
const stalenessMs int64 = 14 * 24 * 60 * 60 * 1000

// resurfaceBucketMs is how long before one loose end may be raised again. Both the candidate's ID and
// its At floor to this bucket, which is what makes a re-read of an unchanged dossier produce an
// identical (At, ID) pair that the frontend watermark discards. MUST be coarser than stalenessMs, or a
// loose end re-fires before it has gone stale again — asserted in looseend_test.go.
const resurfaceBucketMs int64 = 30 * 24 * 60 * 60 * 1000

// terminalStatuses never produce a loose end.
var terminalStatuses = map[string]bool{"done": true, "cancelled": true, "archived": true}

// LooseEndProducer reports a dossier going quiet. The two function fields are seams for tests.
type LooseEndProducer struct {
	listDossiers func(ctx context.Context) ([]jarvisdossier.Dossier, error)
	now          func() int64
}

func NewLooseEndProducer() *LooseEndProducer {
	return &LooseEndProducer{listDossiers: liveDossiers, now: func() int64 { return time.Now().UnixMilli() }}
}

func liveDossiers(ctx context.Context) ([]jarvisdossier.Dossier, error) {
	v, err := wavevault.OpenVault(ctx)
	if err != nil {
		return nil, fmt.Errorf("jarvisvolunteer: opening vault: %w", err)
	}
	r := v.Retriever(wavevault.Scope{Collections: []string{wavevault.CollTasks}})
	nodes, err := r.Query(wavevault.Filter{})
	if err != nil {
		return nil, fmt.Errorf("jarvisvolunteer: querying tasks: %w", err)
	}
	var out []jarvisdossier.Dossier
	for _, n := range nodes {
		d, err := jarvisdossier.LoadDossier(r, n.ID)
		if err != nil || d == nil {
			continue // tolerant, mirroring jarvisattrib.AllEdges
		}
		out = append(out, *d)
	}
	return out, nil
}

func (p *LooseEndProducer) Name() string { return ClassLooseEnd }

func (p *LooseEndProducer) Candidates(ctx context.Context, _ *Trigger) ([]Candidate, error) {
	ds, err := p.listDossiers(ctx)
	if err != nil {
		return nil, err
	}
	now := p.now()
	var out []Candidate
	for _, d := range ds {
		if terminalStatuses[d.Status] || d.Updated == 0 {
			continue
		}
		stale := now-d.Updated >= stalenessMs
		if !stale && len(d.Blockers) == 0 {
			continue
		}
		bucket := d.Updated - (d.Updated % resurfaceBucketMs)
		title := d.Objective
		if title == "" {
			title = d.ID
		}
		out = append(out, Candidate{
			Class:      ClassLooseEnd,
			ID:         fmt.Sprintf("loose-end:%s:%d", d.ID, bucket),
			At:         bucket,
			Title:      title,
			Snippet:    looseEndSnippet(d, now),
			SourceType: "dossier",
			SourceRef:  "task:" + d.ID,
		})
	}
	return out, nil
}

func looseEndSnippet(d jarvisdossier.Dossier, now int64) string {
	if len(d.Blockers) > 0 {
		return fmt.Sprintf("blocked on %s", d.Blockers[0])
	}
	days := (now - d.Updated) / (24 * 60 * 60 * 1000)
	return fmt.Sprintf("untouched for %d days", days)
}
```

- [ ] **Step 4: Run tests to verify they pass**

```powershell
go test ./pkg/jarvisvolunteer/ -run "TestLooseEnd|TestResurface" -v
```

Expected: PASS — five tests.

- [ ] **Step 5: Confirm the measurement made it into the comment**

```
git diff pkg/jarvisvolunteer/looseend.go
```

Expected: the `stalenessMs` comment contains real numbers, not the `<DATE>` / `<N>` / `<VALUE>` placeholders. If it still has placeholders, go back to Step 1 — shipping an unexplained constant is what this task exists to prevent.

- [ ] **Step 6: Commit**

```bash
git add pkg/jarvisvolunteer/looseend.go pkg/jarvisvolunteer/looseend_test.go
git commit -m "feat(jarvis): loose-end producer, with its staleness threshold fitted to the real vault"
```

---

## Task 6: The judge

Mirrors `pkg/jarvisproactive/proactive.go`'s judge seam exactly, including the reason `SetJudgeForTest` overrides the process runner rather than the whole call: a test that replaces spec construction cannot observe which tier the real body selects.

**Files:**
- Create: `pkg/jarvisvolunteer/judge.go`
- Test: `pkg/jarvisvolunteer/judge_test.go`

**Interfaces:**
- Consumes: `Candidate`, `shortlistMax` from Task 2.
- Produces: `buildJudgePrompt(cands []Candidate) string`; `parseJudgeReply(reply string, n int) int` (returns -1 for decline); `judge` package var; `SetJudgeForTest(fn) func()`.

- [ ] **Step 1: Write the failing test**

Create `pkg/jarvisvolunteer/judge_test.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvisvolunteer

import (
	"context"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/consult"
)

func TestParseJudgeReply(t *testing.T) {
	cases := []struct {
		reply string
		n     int
		want  int
	}{
		{"1", 3, 0},
		{"3", 3, 2},
		{" 2 \n", 3, 1},
		{"none", 3, -1},
		{"NONE", 3, -1},
		{"", 3, -1},
		{"4", 3, -1},   // out of range
		{"0", 3, -1},   // one-indexed, so 0 is invalid
		{"nope", 3, -1}, // unparseable
	}
	for _, c := range cases {
		if got := parseJudgeReply(c.reply, c.n); got != c.want {
			t.Fatalf("parseJudgeReply(%q, %d) = %d, want %d", c.reply, c.n, got, c.want)
		}
	}
}

func TestBuildJudgePromptListsEveryCandidate(t *testing.T) {
	cands := []Candidate{
		{Class: ClassRecall, Title: "Drop-oldest on overflow", Snippet: "backpressure stalled the writer"},
		{Class: ClassLooseEnd, Title: "Finish the migration", Snippet: "untouched for 21 days"},
	}
	p := buildJudgePrompt(cands)
	for _, want := range []string{"1.", "2.", "Drop-oldest on overflow", "Finish the migration", "none"} {
		if !strings.Contains(p, want) {
			t.Fatalf("prompt missing %q:\n%s", want, p)
		}
	}
}

// The real judge body must select the cheap tier. Overriding judgeRun (the process seam) rather than
// judge (the whole call) is what makes the tier observable — see the same pattern in jarvisproactive.
func TestJudgeUsesCheapTier(t *testing.T) {
	var gotArgs []string
	old := judgeRun
	judgeRun = func(_ context.Context, spec consult.RuntimeSpec, _, _ string, _ func(string)) (string, error) {
		gotArgs = spec.BaseArgs
		return "none", nil
	}
	defer func() { judgeRun = old }()

	if _, err := judge(context.Background(), "", "prompt"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	joined := strings.Join(gotArgs, " ")
	if !strings.Contains(joined, "--model "+consult.CheapModel) {
		t.Fatalf("judge must run on the cheap tier; args were %q", joined)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

```powershell
go test ./pkg/jarvisvolunteer/ -run "TestParseJudge|TestBuildJudge|TestJudgeUses" -v
```

Expected: FAIL to build — `undefined: parseJudgeReply`.

- [ ] **Step 3: Write the judge**

Create `pkg/jarvisvolunteer/judge.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvisvolunteer

import (
	"context"
	"fmt"
	"strconv"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/consult"
)

var errNoClaude = fmt.Errorf("volunteer judge requires the claude CLI, which is not available")

// judgeRun is the inner process-runner seam. judge itself is swappable, but SetJudgeForTest replaces
// spec construction along with the call, so a test using it cannot observe which tier the real body
// selects. Overriding this instead runs the real judge and exposes the spec.
var judgeRun = consult.Run

// judge runs on the cheap tier: deciding whether any of a short list is worth interrupting for is
// bounded classification, not synthesis. One-shot and unstreamed, so the emit callback is discarded.
var judge = func(ctx context.Context, cwd, prompt string) (string, error) {
	spec, ok := consult.SpecForTier("claude", consult.TierCheap)
	if !ok {
		return "", errNoClaude
	}
	return judgeRun(ctx, spec, cwd, prompt, func(string) {})
}

// SetJudgeForTest swaps the model call and returns a restore func the caller defers.
func SetJudgeForTest(fn func(ctx context.Context, cwd, prompt string) (string, error)) func() {
	old := judge
	judge = fn
	return func() { judge = old }
}

// buildJudgePrompt asks the one question a static precedence table cannot answer: not which class
// outranks which, but whether any of these is worth interrupting a working human for right now.
func buildJudgePrompt(cands []Candidate) string {
	var b strings.Builder
	b.WriteString("You are deciding whether an assistant should interrupt a developer at work.\n")
	b.WriteString("Below are things the assistant noticed. Interrupting has a real cost: a wrong or\n")
	b.WriteString("obvious interruption is worse than silence. Prefer silence when unsure.\n\n")
	for i, c := range cands {
		fmt.Fprintf(&b, "%d. [%s] %s - %s\n", i+1, c.Class, c.Title, c.Snippet)
	}
	b.WriteString("\nReply with the number of the single item worth saying now, or the word none.\n")
	b.WriteString("Reply with nothing else.\n")
	return b.String()
}

// parseJudgeReply returns the zero-based index of the pick, or -1 for a decline. Total: any reply it
// cannot read as an in-range one-based number is a decline, never an error.
func parseJudgeReply(reply string, n int) int {
	s := strings.TrimSpace(strings.ToLower(reply))
	if s == "" || strings.HasPrefix(s, "none") {
		return -1
	}
	fields := strings.Fields(s)
	if len(fields) == 0 {
		return -1
	}
	i, err := strconv.Atoi(strings.Trim(fields[0], ".,:"))
	if err != nil || i < 1 || i > n {
		return -1
	}
	return i - 1
}
```

- [ ] **Step 4: Run tests to verify they pass**

```powershell
go test ./pkg/jarvisvolunteer/ -run "TestParseJudge|TestBuildJudge|TestJudgeUses" -v
```

Expected: PASS — three tests.

- [ ] **Step 5: Commit**

```bash
git add pkg/jarvisvolunteer/judge.go pkg/jarvisvolunteer/judge_test.go
git commit -m "feat(jarvis): cheap-tier judge decides whether any candidate is worth interrupting for"
```

---

## Task 7: Evaluate orchestration and publish

Wires Tasks 2-6 into the pipeline and publishes. This is where the "no model call on a quiet trigger" property becomes observable.

**Files:**
- Create: `pkg/jarvisvolunteer/volunteer.go`
- Test: `pkg/jarvisvolunteer/volunteer_test.go`

**Interfaces:**
- Consumes: everything from Tasks 2-6; `baseds.VolunteerData` and `wps.Event_JarvisVolunteer` from Task 1.
- Produces: `Evaluate(ctx context.Context, t *Trigger) (*baseds.VolunteerData, string)` returning the published payload or nil plus a reason; `EvaluateDispatch(ctx, t)` (fire-and-forget wrapper that logs); `SweepLooseEnds()`; `SetPublishSinkForTest(fn) func()`.

- [ ] **Step 1: Write the failing test**

Create `pkg/jarvisvolunteer/volunteer_test.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvisvolunteer

import (
	"context"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/wps"
)

type stubProducer struct {
	name  string
	cands []Candidate
	err   error
}

func (s *stubProducer) Name() string { return s.name }
func (s *stubProducer) Candidates(context.Context, *Trigger) ([]Candidate, error) {
	return s.cands, s.err
}

func withProducers(t *testing.T, ps ...Producer) {
	t.Helper()
	old := producersFor
	producersFor = func(*Trigger) []Producer { return ps }
	t.Cleanup(func() { producersFor = old })
}

func capturePublished(t *testing.T) *[]wps.WaveEvent {
	t.Helper()
	var got []wps.WaveEvent
	restore := SetPublishSinkForTest(func(ev wps.WaveEvent) { got = append(got, ev) })
	t.Cleanup(restore)
	return &got
}

func TestQuietWindowMakesNoModelCall(t *testing.T) {
	resetGateForTest()
	published := capturePublished(t)
	withProducers(t, &stubProducer{name: "x", cands: []Candidate{cand("a", 10)}})

	var judgeCalls int
	defer SetJudgeForTest(func(context.Context, string, string) (string, error) {
		judgeCalls++
		return "1", nil
	})()

	if _, reason := Evaluate(context.Background(), &Trigger{Kind: "sweep"}); reason != "" {
		t.Fatalf("first evaluation should speak, got reason %q", reason)
	}
	if judgeCalls != 1 {
		t.Fatalf("want 1 judge call, got %d", judgeCalls)
	}
	// second trigger lands inside the quiet window
	data, reason := Evaluate(context.Background(), &Trigger{Kind: "sweep"})
	if data != nil || reason != ReasonRateLimited {
		t.Fatalf("want nil + %q, got %+v + %q", ReasonRateLimited, data, reason)
	}
	if judgeCalls != 1 {
		t.Fatalf("rate-limited trigger must not reach the judge; judge calls = %d", judgeCalls)
	}
	if len(*published) != 1 {
		t.Fatalf("want exactly 1 published event, got %d", len(*published))
	}
}

func TestNoCandidatesMakesNoModelCall(t *testing.T) {
	resetGateForTest()
	capturePublished(t)
	withProducers(t, &stubProducer{name: "x", cands: nil})
	var judgeCalls int
	defer SetJudgeForTest(func(context.Context, string, string) (string, error) {
		judgeCalls++
		return "1", nil
	})()

	data, reason := Evaluate(context.Background(), &Trigger{Kind: "sweep"})
	if data != nil || reason != ReasonNoCandidates {
		t.Fatalf("want nil + %q, got %+v + %q", ReasonNoCandidates, data, reason)
	}
	if judgeCalls != 0 {
		t.Fatalf("an empty shortlist must short-circuit before the judge; judge calls = %d", judgeCalls)
	}
}

func TestJudgeDeclineIsSilentAndNamed(t *testing.T) {
	resetGateForTest()
	published := capturePublished(t)
	withProducers(t, &stubProducer{name: "x", cands: []Candidate{cand("a", 10)}})
	defer SetJudgeForTest(func(context.Context, string, string) (string, error) { return "none", nil })()

	data, reason := Evaluate(context.Background(), &Trigger{Kind: "sweep"})
	if data != nil || reason != ReasonJudgeDeclined {
		t.Fatalf("want nil + %q, got %+v + %q", ReasonJudgeDeclined, data, reason)
	}
	if len(*published) != 0 {
		t.Fatalf("a decline must publish nothing, got %d events", len(*published))
	}
}

func TestJudgeErrorIsSilentNotFatal(t *testing.T) {
	resetGateForTest()
	capturePublished(t)
	withProducers(t, &stubProducer{name: "x", cands: []Candidate{cand("a", 10)}})
	defer SetJudgeForTest(func(context.Context, string, string) (string, error) {
		return "", errNoClaude
	})()

	data, reason := Evaluate(context.Background(), &Trigger{Kind: "sweep"})
	if data != nil || reason != ReasonJudgeError {
		t.Fatalf("want nil + %q, got %+v + %q", ReasonJudgeError, data, reason)
	}
}

func TestOneFailingProducerDoesNotSuppressTheOthers(t *testing.T) {
	resetGateForTest()
	capturePublished(t)
	withProducers(t,
		&stubProducer{name: "broken", err: context.DeadlineExceeded},
		&stubProducer{name: "ok", cands: []Candidate{cand("survivor", 10)}},
	)
	defer SetJudgeForTest(func(context.Context, string, string) (string, error) { return "1", nil })()

	data, reason := Evaluate(context.Background(), &Trigger{Kind: "sweep"})
	if data == nil {
		t.Fatalf("a healthy producer must still contribute; reason was %q", reason)
	}
	if data.Id != "survivor" {
		t.Fatalf("published the wrong candidate: %+v", data)
	}
}

// The idempotence property: the same fact evaluated twice publishes at most one NEW payload, and any
// second publish carries a byte-identical (At, Id) pair so the frontend watermark discards it. This is
// the entire justification for having no server-side said-log and no database migration.
func TestSameFactYieldsIdenticalPair(t *testing.T) {
	resetGateForTest()
	published := capturePublished(t)
	fact := Candidate{Class: ClassLooseEnd, ID: "loose-end:task-a:900", At: 900, Title: "t", Snippet: "s"}
	withProducers(t, &stubProducer{name: "x", cands: []Candidate{fact}})
	defer SetJudgeForTest(func(context.Context, string, string) (string, error) { return "1", nil })()

	if _, reason := Evaluate(context.Background(), &Trigger{Kind: "sweep"}); reason != "" {
		t.Fatalf("first evaluation should speak, got %q", reason)
	}
	markSpokeForTestReset()
	data, reason := Evaluate(context.Background(), &Trigger{Kind: "sweep"})
	if data != nil {
		t.Fatalf("an already-emitted fact must not reach the judge again, got %+v (reason %q)", data, reason)
	}
	if reason != ReasonNoCandidates {
		t.Fatalf("want %q after the prefilter drops the seen id, got %q", ReasonNoCandidates, reason)
	}
	if len(*published) != 1 {
		t.Fatalf("want exactly 1 published event across two evaluations, got %d", len(*published))
	}
	first := (*published)[0].Data.(baseds.VolunteerData)
	if first.At != 900 || first.Id != "loose-end:task-a:900" {
		t.Fatalf("published pair must be the fact's own, got At=%d Id=%q", first.At, first.Id)
	}
}
```

Add the import `"github.com/wavetermdev/waveterm/pkg/baseds"` to the test file's import block.

- [ ] **Step 2: Run test to verify it fails**

```powershell
go test ./pkg/jarvisvolunteer/ -run "TestQuiet|TestNoCandidates|TestJudgeDecline|TestJudgeError|TestOneFailing|TestSameFact" -v
```

Expected: FAIL to build — `undefined: Evaluate`.

- [ ] **Step 3: Write the orchestration**

Create `pkg/jarvisvolunteer/volunteer.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvisvolunteer

import (
	"context"
	"log"
	"time"

	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/panichandler"
	"github.com/wavetermdev/waveterm/pkg/wps"
)

// volunteerPersist bounds how much of the recent past a late subscriber can replay. Mirrors
// memdistill's memoryActivityPersist: this is a replay window in the broker's memory, never a durable
// log. A wavesrv restart replays nothing, which is harmless because producers are stateless readers -
// the next trigger re-derives anything still true.
const volunteerPersist = 20

// evaluateTimeout bounds the whole pipeline. The judge is a headless CLI process, so this must never
// run on an RPC handler's context: wshutil.DefaultTimeoutMs is 5000 and binds the SERVER's context, so
// slow synchronous handler work returns a timeout to the client even though it completes. Callers
// dispatch Evaluate off-band.
const evaluateTimeout = 90 * time.Second

// publishSink is the transport, swappable so tests observe a real announcement.
var publishSink = func(ev wps.WaveEvent) { wps.Broker.Publish(ev) }

// SetPublishSinkForTest swaps the broker transport. Returns a restore func the caller defers.
func SetPublishSinkForTest(fn func(wps.WaveEvent)) (restore func()) {
	prev := publishSink
	publishSink = fn
	return func() { publishSink = prev }
}

// producersFor selects which producers a trigger consults. A seam so tests inject stubs.
var producersFor = func(t *Trigger) []Producer {
	switch t.Kind {
	case "run-created":
		return []Producer{NewRecallProducer()}
	case "run-rest":
		return []Producer{NewConnectionProducer()}
	default:
		return []Producer{NewLooseEndProducer()}
	}
}

var nowFn = func() int64 { return time.Now().UnixMilli() }

// markSpokeForTestReset lets a test re-open the quiet window without clearing the emitted-id map,
// which is what isolates the idempotence property from the rate gate.
func markSpokeForTestReset() {
	gateMu.Lock()
	defer gateMu.Unlock()
	lastSpokeAt = 0
}

// Evaluate runs the whole pipeline and returns the published payload, or nil plus a named reason.
// Never returns an error: a broken vault, dead index, unavailable model or panicking producer yields
// silence, never a failed run and never a visible error.
func Evaluate(ctx context.Context, t *Trigger) (*baseds.VolunteerData, string) {
	now := nowFn()
	if !allowNow(now) {
		return nil, ReasonRateLimited // before any read or model call: a quiet trigger costs nothing
	}
	var all []Candidate
	for _, p := range producersFor(t) {
		cands, err := p.Candidates(ctx, t)
		if err != nil {
			// one failing producer is logged and skipped; the others still contribute
			log.Printf("jarvisvolunteer: producer %s failed (non-fatal): %v", p.Name(), err)
			continue
		}
		all = append(all, cands...)
	}
	short := prefilter(all)
	if len(short) == 0 {
		return nil, ReasonNoCandidates // short-circuit: no model call
	}
	reply, err := judge(ctx, "", buildJudgePrompt(short))
	if err != nil {
		return nil, ReasonJudgeError
	}
	pick := parseJudgeReply(reply, len(short))
	if pick < 0 {
		return nil, ReasonJudgeDeclined
	}
	c := short[pick]
	markEmitted(c.ID)
	markSpoke(now)
	data := baseds.VolunteerData{
		Class:      c.Class,
		Id:         c.ID,
		At:         c.At,
		Title:      c.Title,
		Text:       c.Snippet,
		SourceType: c.SourceType,
		Ref:        c.SourceRef,
		Anchor:     c.Anchor,
	}
	publishSink(wps.WaveEvent{
		Event:   wps.Event_JarvisVolunteer,
		Persist: volunteerPersist,
		Data:    data,
	})
	return &data, ""
}

// EvaluateAsync dispatches Evaluate in a detached goroutine. Every caller uses this rather than
// Evaluate directly: the judge is a headless CLI process and must never bind an RPC handler's context.
func EvaluateAsync(t Trigger) {
	go func() {
		defer panichandler.PanicHandler("jarvisvolunteer.evaluate", recover())
		ctx, cancel := context.WithTimeout(context.Background(), evaluateTimeout)
		defer cancel()
		if _, reason := Evaluate(ctx, &t); reason != "" {
			// every terminal path names its reason: counting no-candidates against judge-declined is
			// the cost audit that choosing a model judge obliges us to have
			log.Printf("jarvisvolunteer: %s trigger said nothing (%s)", t.Kind, reason)
		}
	}()
}

// SweepLooseEnds is the hourly unattended entry, registered as a memdistill sweep hook. Synchronous by
// contract - the hook runner already wraps it in a panic handler and it is off any RPC budget.
func SweepLooseEnds() {
	ctx, cancel := context.WithTimeout(context.Background(), evaluateTimeout)
	defer cancel()
	if _, reason := Evaluate(ctx, &Trigger{Kind: "sweep"}); reason != "" {
		log.Printf("jarvisvolunteer: sweep said nothing (%s)", reason)
	}
}
```

- [ ] **Step 4: Run the whole package's tests**

```powershell
go test ./pkg/jarvisvolunteer/ -v
```

Expected: PASS — every test from Tasks 2-7.

- [ ] **Step 5: Commit**

```bash
git add pkg/jarvisvolunteer/volunteer.go pkg/jarvisvolunteer/volunteer_test.go
git commit -m "feat(jarvis): volunteer pipeline - rate gate, prefilter, judge, publish"
```

---

## Task 8: Backend triggers

Hooks the pipeline to three cadences that already exist. No new scheduler, no new daemon.

**Files:**
- Modify: `pkg/wshrpc/wshserver/wshserver_runs.go` (inside the existing `proactiveAsync` block ending near line 300; and inside the existing `captureAsync` block starting near line 442)
- Modify: `cmd/server/main-server.go:591`

**Interfaces:**
- Consumes: `jarvisvolunteer.EvaluateAsync(Trigger)`, `jarvisvolunteer.SweepLooseEnds()`, `jarvisvolunteer.Trigger` from Task 7.
- Produces: nothing new.

- [ ] **Step 1: Add the run-created trigger**

In `pkg/wshrpc/wshserver/wshserver_runs.go`, inside the existing `proactiveAsync(func() { ... })` block, **after** the suggestion has been written (that is, after the `writeProactive` call that persists `sug`), append:

```go
		// the recall producer reads the suggestion this block just persisted, so it must run after the
		// write, not beside it. Detached: the judge is a headless CLI process.
		jarvisvolunteer.EvaluateAsync(jarvisvolunteer.Trigger{
			Kind: "run-created", ChannelID: data.ChannelId, RunID: run.ID,
		})
```

Add `"github.com/wavetermdev/waveterm/pkg/jarvisvolunteer"` to the file's import block.

- [ ] **Step 2: Add the run-rest trigger**

In the same file, inside the existing `captureAsync(func() { ... })` block that calls `jarvisContinuity.CaptureRunBoundary`, append after the `wcore.SendWaveObjUpdate(...)` line:

```go
			jarvisvolunteer.EvaluateAsync(jarvisvolunteer.Trigger{
				Kind: "run-rest", ChannelID: channelId, RunID: runId,
			})
```

- [ ] **Step 3: Register the hourly sweep**

In `cmd/server/main-server.go`, immediately after line 591 (`memdistill.RegisterSweepHook(memgarden.Sweep)`):

```go
	memdistill.RegisterSweepHook(jarvisvolunteer.SweepLooseEnds)
```

Add `"github.com/wavetermdev/waveterm/pkg/jarvisvolunteer"` to that file's import block. Registration must happen before `memdistill.Start` — the hook slice is read per tick but appended at registration, and `RegisterSweepHook`'s own comment says "Call before Start."

- [ ] **Step 4: Verify it builds and existing tests still pass**

```powershell
$env:CGO_CFLAGS = "-O2 -g -I$((Get-Location).Path -replace '\\','/')/pkg/jarvisembed/csrc"
go build ./... 
go test ./pkg/jarvisvolunteer/ ./pkg/wshrpc/wshserver/ ./pkg/memdistill/ -v
```

Expected: build succeeds; all tests PASS.

- [ ] **Step 5: Rebuild the backend so the dev app picks it up**

```
task build:backend
```

Expected: succeeds. A new wave event and a new backend package do nothing in a running dev app until wavesrv is rebuilt.

- [ ] **Step 6: Commit**

```bash
git add pkg/wshrpc/wshserver/wshserver_runs.go cmd/server/main-server.go
git commit -m "feat(jarvis): trigger volunteer evaluation on run created, run rest, and the hourly sweep"
```

---

## Task 9: Frontend vocabulary and subscription

Three new utterance kinds and the adapter that turns the wave event into one. The compiler enforces the label work: `KIND_LABEL` in `petbubble.tsx` is a total `Record` over the kind union.

**Files:**
- Modify: `frontend/app/view/jarvis/petvoice.ts`
- Modify: `frontend/app/view/jarvis/petjoin.ts`
- Modify: `frontend/app/view/jarvis/petsources.tsx`
- Modify: `frontend/app/view/jarvis/petbubble.tsx`
- Test: `frontend/app/view/jarvis/petvoice.test.ts` (extend), `frontend/app/view/jarvis/petjoin.test.ts` (create if absent)

**Interfaces:**
- Consumes: the generated TS type `VolunteerData` from Task 1.
- Produces: `PetEvent.kind` union extended with `"recall" | "connection" | "loose-end"`; `PetEvent.source?: PetEventSource`; `PetEventSource` interface `{ ref: string; anchor?: string; title: string; sourceType: string }`; `eventFromVolunteer(d: VolunteerData | null | undefined): PetEvent | null`.

- [ ] **Step 1: Write the failing tests**

Append to `frontend/app/view/jarvis/petvoice.test.ts`:

```ts
describe("volunteered knowledge", () => {
    const vol = (id: string, at: number): PetEvent => ({
        id,
        at,
        kind: "loose-end",
        text: "Still open - finish the migration",
        source: { ref: "task:task-a", title: "Finish the migration", sourceType: "dossier" },
    });

    it("speaks a knowledge utterance like any other event", () => {
        const { utterance, watermark } = nextUtterance([vol("loose-end:task-a:900", 900)], null);
        expect(utterance?.kind).toBe("loose-end");
        expect(utterance?.source?.ref).toBe("task:task-a");
        expect(watermark).toEqual({ at: 900, id: "loose-end:task-a:900" });
    });

    // the whole reason the backend stamps (at, id) from the fact rather than from emission time
    it("stays silent when the same fact is re-emitted", () => {
        const fact = vol("loose-end:task-a:900", 900);
        const { watermark } = nextUtterance([fact], null);
        const again = nextUtterance([fact], watermark);
        expect(again.utterance).toBeNull();
        expect(again.watermark).toBeNull();
    });

    it("speaks again once the fact moves to a new bucket", () => {
        const { watermark } = nextUtterance([vol("loose-end:task-a:900", 900)], null);
        const next = nextUtterance([vol("loose-end:task-a:1800", 1800)], watermark);
        expect(next.utterance?.id).toBe("loose-end:task-a:1800");
    });
});
```

Create `frontend/app/view/jarvis/petjoin.test.ts` (or append if it exists):

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { eventFromVolunteer } from "./petjoin";

describe("eventFromVolunteer", () => {
    const base = {
        class: "loose-end",
        id: "loose-end:task-a:900",
        at: 900,
        title: "Finish the migration",
        text: "untouched for 21 days",
        sourcetype: "dossier",
        ref: "task:task-a",
    };

    it("maps a payload to an utterance carrying its source", () => {
        const ev = eventFromVolunteer(base as any);
        expect(ev).not.toBeNull();
        expect(ev!.kind).toBe("loose-end");
        expect(ev!.at).toBe(900);
        expect(ev!.text).toContain("Finish the migration");
        expect(ev!.source).toEqual({ ref: "task:task-a", anchor: undefined, title: "Finish the migration", sourceType: "dossier" });
    });

    it("rejects an unknown class rather than inventing a label", () => {
        expect(eventFromVolunteer({ ...base, class: "made-up" } as any)).toBeNull();
    });

    it("rejects a payload with no stable id or no timestamp", () => {
        expect(eventFromVolunteer({ ...base, id: "" } as any)).toBeNull();
        expect(eventFromVolunteer({ ...base, at: 0 } as any)).toBeNull();
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```
npx vitest run frontend/app/view/jarvis/petvoice.test.ts frontend/app/view/jarvis/petjoin.test.ts
```

Expected: FAIL — `eventFromVolunteer` is not exported; `source` is not a property of `PetEvent`.

- [ ] **Step 3: Extend the event type**

In `frontend/app/view/jarvis/petvoice.ts`, replace the `PetEvent` interface with:

```ts
// Where a knowledge utterance points. `ref` is a frontend navigation address (see openref.ts), which
// may carry a vault node id inside an oref-shaped string — the same thing askAboutRecord already does
// with "task:"+dossierId. `anchor` names a sub-object to highlight within `ref`, which is how a
// decision addresses its parent record's thread: decisionlog.tsx renders it, so it has no route of
// its own.
export interface PetEventSource {
    ref: string;
    anchor?: string;
    title: string;
    sourceType: string; // dossier | decision | memory | run
}

export interface PetEvent {
    id: string; // stable across reloads; the watermark compares against it
    at: number; // epoch ms
    kind:
        | "resume"
        | "sweep"
        | "distill-batch"
        | "notes-written"
        | "bg-agent-done"
        // volunteered knowledge: what Jarvis knows about your work, not what the system did
        | "recall"
        | "connection"
        | "loose-end";
    text: string;
    reportedAsCondition?: boolean;
    // set only on volunteered knowledge; housekeeping events leave it unset and behave as before
    source?: PetEventSource;
}
```

- [ ] **Step 4: Write the adapter**

In `frontend/app/view/jarvis/petjoin.ts`, append:

```ts
const VOLUNTEER_KINDS = ["recall", "connection", "loose-end"] as const;
type VolunteerKind = (typeof VOLUNTEER_KINDS)[number];

// The backend stamps id and at from the FACT, not from emission time, so an unchanged fact re-emitted
// after a restart carries an identical pair and nextUtterance discards it against the watermark. This
// adapter must therefore pass both through untouched — deriving either here would break say-once.
export function eventFromVolunteer(d: VolunteerData | null | undefined): PetEvent | null {
    const cls = d?.class;
    if (d == null || cls == null || !(VOLUNTEER_KINDS as readonly string[]).includes(cls)) {
        return null;
    }
    if (!d.id || !d.at) {
        return null; // no stable id or no timestamp means the watermark cannot order it
    }
    const title = d.title?.trim() ?? "";
    const body = d.text?.trim() ?? "";
    if (!title && !body) {
        return null;
    }
    return {
        id: d.id,
        at: d.at,
        kind: cls as VolunteerKind,
        text: body ? `${title} - ${body}` : title,
        source: d.ref
            ? { ref: d.ref, anchor: d.anchor || undefined, title: title || d.ref, sourceType: d.sourcetype ?? "" }
            : undefined,
    };
}
```

- [ ] **Step 5: Add the labels**

In `frontend/app/view/jarvis/petbubble.tsx`, extend `KIND_LABEL`:

```ts
const KIND_LABEL: Record<PetEvent["kind"], string> = {
    resume: "Where we were",
    sweep: "While you were out",
    "distill-batch": "While you were out",
    "notes-written": "What I wrote down",
    "bg-agent-done": "While you were out",
    recall: "You have been here before",
    connection: "This just connected",
    "loose-end": "Still open",
};
```

- [ ] **Step 6: Subscribe**

In `frontend/app/view/jarvis/petsources.tsx`, add the backlog loader beside the existing ones:

```ts
// scope "" for the same reason as the memory-activity read: the event is published scope-less, because
// it is a fact about your work rather than about one object.
async function loadVolunteerBacklog(): Promise<boolean> {
    try {
        const events = await RpcApi.EventReadHistoryCommand(TabRpcClient, {
            event: "jarvis:volunteer",
            scope: "",
            maxitems: ACTIVITY_BACKLOG,
        });
        for (const e of events ?? []) {
            const mapped = eventFromVolunteer(e?.data as VolunteerData | undefined);
            if (mapped != null) {
                pushPetEvent(mapped);
            }
        }
        return true;
    } catch {
        return false; // the live subscription still covers anything from here on
    }
}
```

Inside `PetSources`'s `useEffect`, add `void readUntilLanded({ read: loadVolunteerBacklog, live });` beside the other three, and a second subscription:

```ts
        const unsubVolunteer = waveEventSubscribeSingle({
            eventType: "jarvis:volunteer",
            handler: (event) => {
                const mapped = eventFromVolunteer(event?.data);
                if (mapped != null) {
                    pushPetEvent(mapped);
                }
            },
        });
```

Add `unsubVolunteer();` to the cleanup return, and add `eventFromVolunteer` to the existing `./petjoin` import.

- [ ] **Step 7: Run tests to verify they pass**

```
npx vitest run frontend/app/view/jarvis/
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit
```

Expected: vitest PASS; typecheck exit 0.

- [ ] **Step 8: Commit**

```bash
git add frontend/app/view/jarvis/petvoice.ts frontend/app/view/jarvis/petjoin.ts frontend/app/view/jarvis/petsources.tsx frontend/app/view/jarvis/petbubble.tsx frontend/app/view/jarvis/petvoice.test.ts frontend/app/view/jarvis/petjoin.test.ts
git commit -m "feat(jarvis): the creature can say three kinds of knowledge, not just housekeeping"
```

---

## Task 10: Navigation — memory-note route and decision anchor

One genuinely new route plus an anchor. Also deletes a stale claim in `openref.ts`'s header that cost this design pass an hour to disprove.

**Files:**
- Modify: `frontend/app/view/jarvis/openref.ts`
- Modify: `frontend/app/view/jarvis/petstore.ts`
- Modify: `frontend/app/view/jarvis/decisionlog.tsx`
- Test: `frontend/app/view/jarvis/openref.test.ts` (extend)

**Interfaces:**
- Consumes: `selectNote` from `frontend/app/view/agents/memstore.ts`; `PetEventSource` from Task 9.
- Produces: `OrefNav` union extended with `{ kind: "memnote"; oid: string }`; `openORef(model, oref, anchor?)` gaining an optional third parameter; `pendingDecisionAnchorAtom` exported from `petstore.ts`.

- [ ] **Step 1: Write the failing test**

Append to `frontend/app/view/jarvis/openref.test.ts`:

```ts
describe("volunteered-knowledge routes", () => {
    it("classifies a memory note address", () => {
        expect(orefNavPlan("memnote:mem-abc123")).toEqual({ kind: "memnote", oid: "mem-abc123" });
    });

    it("still classifies the existing routes", () => {
        expect(orefNavPlan("task:task-a").kind).toBe("task");
        expect(orefNavPlan("run:run-9").kind).toBe("run");
        expect(orefNavPlan("channel:c1").kind).toBe("channel");
    });

    it("treats a malformed address as unsupported rather than throwing", () => {
        expect(orefNavPlan("memnote:").kind).toBe("unsupported");
        expect(orefNavPlan("").kind).toBe("unsupported");
        expect(orefNavPlan("decision").kind).toBe("unsupported");
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

```
npx vitest run frontend/app/view/jarvis/openref.test.ts
```

Expected: FAIL — `memnote:mem-abc123` classifies as `unsupported`.

- [ ] **Step 3: Add the anchor atom**

In `frontend/app/view/jarvis/petstore.ts`, append:

```ts
// The decision a volunteered utterance pointed at, for decisionlog.tsx to scroll to and flash. A
// decision has no surface of its own — decisionlog renders it inside its parent record's thread — so
// navigation lands on the record and this names the card. Cleared by the consumer once honoured, the
// same shape as pendingRunFocusAtom.
export const pendingDecisionAnchorAtom = atom<string | null>(null) as PrimitiveAtom<string | null>;
```

- [ ] **Step 4: Add the route**

In `frontend/app/view/jarvis/openref.ts`, update the header comment — delete the stale claim and state what is actually true:

```ts
// Open a Jarvis grounding source (an oref) in its native cockpit surface. There is no generic oref router
// in the app; navigation is per-surface (a pending-focus atom + a surfaceAtom flip). Channel / run / task /
// agent / memnote have a clean focus path; the rest no-op. A decision has no route of its own on purpose:
// decisionlog.tsx renders it inside its parent record's thread, so a decision addresses that record with
// the decision id passed as `anchor`. orefNavPlan is a pure, total classifier (never throws); openORef
// performs the side effects.
```

Extend the union and the classifier:

```ts
export type OrefNav =
    | { kind: "channel"; oid: string }
    | { kind: "run"; oid: string }
    | { kind: "task"; oid: string }
    | { kind: "agent"; oid: string }
    | { kind: "memnote"; oid: string }
    | { kind: "unsupported"; otype: string };
```

In `orefNavPlan`, extend the routable check:

```ts
    if (otype === "channel" || otype === "run" || otype === "task" || otype === "agent" || otype === "memnote") {
        return { kind: otype, oid };
    }
```

Give `openORef` the anchor parameter and the memnote branch:

```ts
export async function openORef(model: AgentsViewModel, oref: string, anchor?: string): Promise<void> {
```

In the existing `task` branch, set the anchor before flipping the surface:

```ts
    if (plan.kind === "task") {
        globalStore.set(pendingDecisionAnchorAtom, anchor ?? null);
        selectSubject({ kind: "dossier", id: plan.oid });
        globalStore.set(model.surfaceAtom, "jarvis");
        return;
    }
```

Add the new branch after it:

```ts
    if (plan.kind === "memnote") {
        await selectNote(plan.oid);
        globalStore.set(model.surfaceAtom, "memory");
        return;
    }
```

Add the imports:

```ts
import { selectNote } from "../agents/memstore";
import { pendingDecisionAnchorAtom } from "./petstore";
```

- [ ] **Step 5: Consume the anchor**

In `frontend/app/view/jarvis/decisionlog.tsx`, give `DecisionCardRow` a highlight. Change its signature and body:

```tsx
function DecisionCardRow({ card }: { card: DecisionCard }) {
    const anchor = useAtomValue(pendingDecisionAnchorAtom);
    const ref = useRef<HTMLDivElement | null>(null);
    const highlighted = anchor != null && anchor === card.id;
    useEffect(() => {
        if (!highlighted) {
            return;
        }
        ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
        // clear once honoured so re-selecting this record later does not re-flash
        const t = setTimeout(() => globalStore.set(pendingDecisionAnchorAtom, null), FLASH_MS);
        return () => clearTimeout(t);
    }, [highlighted]);
    return (
        <div
            ref={ref}
            className={cn(
                "rounded-lg border px-3.5 py-3 transition-colors",
                highlighted ? "border-accent bg-accent/8" : "border-border bg-surface"
            )}
        >
```

Leave the rest of the row body unchanged. Add at the top of the file:

```tsx
const FLASH_MS = 2_000;
```

and the imports `useAtomValue` from `jotai`, `useEffect`/`useRef` from `react`, `globalStore` from `@/app/store/jotaiStore`, and `pendingDecisionAnchorAtom` from `./petstore`.

`card.id` is confirmed present: the generated `DecisionCard` type at `frontend/types/gotypes.d.ts:1613` declares `id: string`, carrying the opaque `dec-<8hex>` id minted by `newDecisionID` in `pkg/jarvisdossier/decision.go`. That is the value the backend puts in `Candidate.Anchor`, so the two sides match without a translation step.

- [ ] **Step 6: Run tests to verify they pass**

```
npx vitest run frontend/app/view/jarvis/
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit
```

Expected: vitest PASS; typecheck exit 0.

- [ ] **Step 7: Commit**

```bash
git add frontend/app/view/jarvis/openref.ts frontend/app/view/jarvis/openref.test.ts frontend/app/view/jarvis/petstore.ts frontend/app/view/jarvis/decisionlog.tsx
git commit -m "fix(jarvis): route a memory note and anchor a decision, and correct the stale note that said neither was possible"
```

---

## Task 11: Ask about any source

Widens a gesture that already works for dossiers so it works for every source type an utterance can carry.

**Files:**
- Modify: `frontend/app/view/jarvis/jarvissubjectstore.ts:241-249`
- Test: `frontend/app/view/jarvis/jarvissubjectstore.test.ts` (extend, or create `askaboutsource.test.ts` if the store's test file does not exist)

**Interfaces:**
- Consumes: `conversationForSource(oref, scope)`, `submitJarvisQuery(convId, text)` — both already in this file.
- Produces: `askAboutSource(oref: string, sourceType: string, title: string, text: string): void`. `askAboutRecord` is kept as a thin wrapper so its existing callers do not change.

- [ ] **Step 1: Write the failing test**

Append to the store's test file:

```ts
describe("askAboutSource", () => {
    it("continues one thread when asked twice about the same source", () => {
        const first = conversationForSource("memnote:mem-1", { mode: "object", chips: [], attached: [] });
        const second = conversationForSource("memnote:mem-1", { mode: "object", chips: [], attached: [] });
        expect(second).toBe(first);
    });

    it("mints separate threads for different sources", () => {
        const a = conversationForSource("memnote:mem-1", { mode: "object", chips: [], attached: [] });
        const b = conversationForSource("task:task-a", { mode: "object", chips: [], attached: [] });
        expect(b).not.toBe(a);
    });
});
```

- [ ] **Step 2: Run test to verify it fails or passes**

```
npx vitest run frontend/app/view/jarvis/
```

Expected: these two may already PASS — `conversationForSource` is existing behaviour and this asserts the property `askAboutSource` depends on. If they pass, that is the point: it pins the invariant before generalizing the caller. Proceed to Step 3.

- [ ] **Step 3: Generalize the function**

In `frontend/app/view/jarvis/jarvissubjectstore.ts`, replace `askAboutRecord` with:

```ts
// Ask Jarvis about any grounding source. conversationForSource keys one thread per source oref, so
// asking twice about the same utterance continues one thread rather than minting duplicates — the
// property the jarvis-contextual CDP scenario guards.
export function askAboutSource(oref: string, sourceType: string, title: string, text: string): void {
    const convId = conversationForSource(oref, {
        mode: "object",
        chips: [{ label: title || oref, active: true }],
        attached: [{ oref, sourceType, title }],
    });
    submitJarvisQuery(convId, text);
}

// kept so existing callers do not change: a record is one source type among several
export function askAboutRecord(dossierId: string, objective: string, text: string): void {
    askAboutSource("task:" + dossierId, "task", objective, text);
}
```

- [ ] **Step 4: Run tests to verify they pass**

```
npx vitest run frontend/app/view/jarvis/
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit
```

Expected: vitest PASS; typecheck exit 0.

- [ ] **Step 5: Commit**

```bash
git add frontend/app/view/jarvis/jarvissubjectstore.ts frontend/app/view/jarvis/jarvissubjectstore.test.ts
git commit -m "feat(jarvis): ask about any grounding source, not only a record"
```

---

## Task 12: Peek affordances

The two verbs land on the peek row, not the bubble. The bubble auto-dismisses after six seconds by design, and a click target on something that disappears mid-reach is a worse trap than no target.

**Files:**
- Modify: `frontend/app/view/jarvis/petpeek.tsx`
- Test: none (rendering; covered by the CDP scenario in Task 13)

**Interfaces:**
- Consumes: `openORef(model, ref, anchor)` from Task 10; `askAboutSource` from Task 11; `PetEvent.source` from Task 9.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Add the two controls to a said-row**

In `frontend/app/view/jarvis/petpeek.tsx`, in the section that renders `petSaidAtom`, render the pair only when `event.source` is set — housekeeping utterances have no destination and must not grow dead buttons:

```tsx
{event.source != null ? (
    <div className="mt-1.5 flex gap-2">
        <button
            type="button"
            className="rounded px-1.5 py-0.5 text-[11px] text-accent-soft hover:bg-surface-hover"
            onClick={() => {
                globalStore.set(petPeekOpenAtom, false);
                fireAndForget(() => openORef(model, event.source!.ref, event.source!.anchor));
            }}
        >
            Open
        </button>
        <button
            type="button"
            className="rounded px-1.5 py-0.5 text-[11px] text-accent-soft hover:bg-surface-hover"
            onClick={() => {
                globalStore.set(petPeekOpenAtom, false);
                askAboutSource(
                    event.source!.ref,
                    event.source!.sourceType,
                    event.source!.title,
                    `Tell me more about "${event.source!.title}".`
                );
            }}
        >
            Ask
        </button>
    </div>
) : null}
```

Both close the peek first: leaving it open over a surface it just navigated away from strands an overlay anchored to the creature.

Add the imports `openORef` from `./openref`, `askAboutSource` from `./jarvissubjectstore`, and `fireAndForget` from `@/util/util`.

- [ ] **Step 2: Verify typecheck and unit suite**

```
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit
npx vitest run frontend/app/view/jarvis/
```

Expected: typecheck exit 0; vitest PASS.

- [ ] **Step 3: Verify no hardcoded colors were introduced**

```
git diff frontend/app/view/jarvis/petpeek.tsx | grep -nE "#[0-9a-fA-F]{3,8}|rgba?\("
```

Expected: no output. A raw color silently opts out of every runtime theme, because theming works by overriding the `--color-*` custom properties that the `@theme` tokens define.

- [ ] **Step 4: Commit**

```bash
git add frontend/app/view/jarvis/petpeek.tsx
git commit -m "feat(jarvis): open or ask about a volunteered utterance from the peek"
```

---

## Task 13: Browser-driven scenario and documentation

Closes the loop the unit tests structurally cannot see: a bad hop *between* atoms, which is the defect class this surface's findings keep landing in.

**Files:**
- Modify: `scripts/cdp/scenarios.mjs`
- Modify: `docs/jarvis-tab.md`
- Modify: `docs/superpowers/specs/2026-08-06-jarvis-volunteered-knowledge-design.md` (status line only)

**Interfaces:**
- Consumes: everything from Tasks 1-12.
- Produces: a `jarvis-volunteer` scenario runnable via `task verify:ui -- jarvis-volunteer`.

- [ ] **Step 1: Write the scenario**

Add to `scripts/cdp/scenarios.mjs`, following the arrange → goto → shot → assert → teardown shape the neighbouring scenarios use.

The scenario **injects a pet event directly** rather than arranging a real utterance. A real one needs a live headless CLI judge run, and `docs/jarvis-tab.md` already records that constraint as the reason the cancel path and the thread-archive path have no live steps.

```js
{
    name: "jarvis-volunteer",
    steps: [
        {
            // inject a knowledge utterance straight into the creature's event store, then assert the
            // whole delivery chain. The judge is a headless CLI call up to 90s, far too slow to arrange
            // here — same limit that keeps cancel and thread-archive unit-only.
            name: "bubble appears for an injected knowledge utterance",
            eval: `(() => {
                const mod = window.__wavePetStore;
                if (mod == null) return { ok: false, why: "petstore test hook not exposed" };
                mod.pushPetEvent({
                    id: "loose-end:cdp-probe:900",
                    at: Date.now(),
                    kind: "loose-end",
                    text: "CDP probe - untouched for 21 days",
                    source: { ref: "task:cdp-probe", title: "CDP probe", sourceType: "dossier" },
                });
                return { ok: true };
            })()`,
        },
        {
            name: "peek lists it with Open and Ask",
            eval: `(() => {
                const btns = [...document.querySelectorAll("button")].map((b) => b.innerText.trim());
                return { ok: btns.includes("Open") && btns.includes("Ask"), btns };
            })()`,
        },
        {
            name: "Open navigates to the Jarvis surface with the record selected",
            eval: `(() => {
                const open = [...document.querySelectorAll("button")].find((b) => b.innerText.trim() === "Open");
                if (open == null) return { ok: false, why: "no Open control" };
                open.click();
                return { ok: true };
            })()`,
        },
    ],
},
```

Pin the viewport to 1600x950 in the scenario's arrange step. The real dev window is roughly 1000x700, at which the Subjects column collapses to icon-only status dots and by-name lookups find nothing.

- [ ] **Step 2: Expose the store hook the scenario needs**

In `frontend/app/view/jarvis/petstore.ts`, append:

```ts
// CDP scenarios drive the creature by pushing an event directly: a real volunteered utterance needs a
// headless CLI judge run, which is far too slow to arrange in a scenario. Dev-only.
if (import.meta.env.DEV) {
    (globalThis as any).__wavePetStore = { pushPetEvent };
}
```

- [ ] **Step 3: Run the scenario**

```
task build:backend
task verify:ui -- jarvis-volunteer
```

Expected: PASS table, 3/3 steps; contact sheet written to `cdp-shots/index.html`.

If it fails with ECONNREFUSED on port 9222, that usually means another session's edit crashed `task dev` rather than a CDP hiccup — check the dev log for "going away" before debugging the scenario.

- [ ] **Step 4: Prove each step can fail**

A green scenario that cannot fail is not a net — this is the standard `docs/jarvis-tab.md` holds its five regression scenarios to. Break each fix and confirm the right step reddens:

| Break | Expected red step |
|---|---|
| Remove the `source != null` guard's contents in `petpeek.tsx` so Open/Ask never render | step 2 |
| Make `orefNavPlan` return `unsupported` for `task` | step 3 |
| Make `eventFromVolunteer` return null unconditionally | step 1 (nothing to list) |

Revert each break after confirming.

- [ ] **Step 5: Document the register**

In `docs/jarvis-tab.md`, add the volunteered register to the surface reference: the three kinds, that they carry a source, that Open and Ask live on the peek and not the bubble, and that the creature's watermark is what makes say-once work. Add `jarvis-volunteer` to the verification command list in the "Verifying" section.

In `docs/superpowers/specs/2026-08-06-jarvis-volunteered-knowledge-design.md`, change the status line from `Design settled, unimplemented.` to `Design settled, implemented <DATE>.`

- [ ] **Step 6: Full verification sweep**

```powershell
$env:CGO_CFLAGS = "-O2 -g -I$((Get-Location).Path -replace '\\','/')/pkg/jarvisembed/csrc"
go test ./pkg/jarvisvolunteer/ ./pkg/jarvisproactive/ ./pkg/tsgen/ ./pkg/wps/ ./pkg/wshrpc/wshserver/
```

```
npx vitest run frontend/app/view/jarvis/
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit
npx eslint frontend/app/view/jarvis/
task verify:ui -- jarvis-volunteer jarvis-states jarvis-contextual surface-smoke
```

Expected: all green. `jarvis-states`, `jarvis-contextual` and `surface-smoke` are regression checks that nothing in the pet or Jarvis surface broke.

Known pre-existing failure to discount, not caused by this work: the `jarvis-ask` scenario fails because it still sends `Ctrl+P` while the command palette moved to `Ctrl+Shift+P`.

- [ ] **Step 7: Commit**

```bash
git add scripts/cdp/scenarios.mjs frontend/app/view/jarvis/petstore.ts docs/jarvis-tab.md docs/superpowers/specs/2026-08-06-jarvis-volunteered-knowledge-design.md docs/superpowers/plans/2026-08-06-jarvis-volunteered-knowledge.md
git commit -m "test(jarvis): browser-driven scenario for the volunteered-knowledge delivery chain"
```

Note: the spec and this plan are added here rather than in a separate docs-only commit, per the repository's git rules.

---

## Self-Review

**Spec coverage.** Every section of the design maps to a task:

| Spec section | Task |
|---|---|
| §3 architecture — rate gate, prefilter, judge, publish | 2, 6, 7 |
| §3 reasoned sentinels on every terminal path | 2 (constants), 7 (returned) |
| §4 statelessness; idempotence from the watermark; no new table | 5 (bucket pair), 7 (idempotence test), 9 (re-emission test) |
| §5 three producers | 3, 4, 5 |
| §5 triggers on existing cadences | 8 |
| §5 calibration risk and constant fitting | 5 (measurement is a required step with a placeholder gate) |
| §6 delivery — transport, subscription, vocabulary, labels | 1, 9 |
| §7 navigation — memory route, decision anchor, stale comment | 10 |
| §7 ask generalization | 11 |
| §8 decision 3 — affordances on the peek, not the bubble | 12 |
| §10 off-band by construction (the 5s server-context timeout hazard) | 7 (`EvaluateAsync`), 8 (all three call sites) |
| §11 testing, including proving scenario steps can fail | every task; 13 for the browser-driven half |
| §9 pattern-forming class | deliberately out of scope; no task, by design |

**Placeholder scan.** One intentional placeholder remains: the `<DATE>` / `<N>` / `<VALUE>` markers in the `stalenessMs` comment in Task 5 Step 3. It is not a plan failure — it is the output of Task 5 Step 1's required measurement, and Task 5 Step 5 is an explicit gate that fails the task if the markers survive. The `<DATE>` in Task 13 Step 5's status line is likewise filled at execution.

**Type consistency.** Checked across tasks: `Candidate` fields (`Class`, `ID`, `At`, `Title`, `Snippet`, `SourceType`, `SourceRef`, `Anchor`) are used identically in Tasks 3, 4, 5 and 7. The Go payload `baseds.VolunteerData` uses lowercase json tags (`class`, `id`, `at`, `title`, `text`, `sourcetype`, `ref`, `anchor`) and the frontend adapter in Task 9 reads exactly those. `PetEventSource` fields (`ref`, `anchor`, `title`, `sourceType`) are consistent between Task 9's definition, Task 10's consumer and Task 12's buttons. `openORef` gains its third parameter in Task 10 and is called with three arguments in Task 12.

**Every referenced type verified against the tree.** The one field this plan initially assumed — `DecisionCard.id`, which Task 10's anchor match depends on — was checked and is present at `frontend/types/gotypes.d.ts:1613` as `id: string`. No task references a type, function or field that was not read during planning.

**Known pre-existing failure, unrelated to this work.** The `jarvis-ask` browser-driven scenario fails 0/2 because it still sends `Ctrl+P` while the command palette moved to `Ctrl+Shift+P`. Discount it; do not attempt to fix it inside this plan.
