# Jarvis sub-project E — Continuity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Write a dossier's narrative "where it stands" summary at Run rest boundaries (paused/completed) so recall (sub-project C) can serve continuity, with no new surface or wire type.

**Architecture:** A new package `pkg/jarviscontinuity` — the mirror of C's `jarviscapture`. Where C writes a dossier at Run *dispatch*, E updates that dossier's machine-owned `state` block + `status` at Run *rest transitions* (`awaiting-review | blocked | done`), assembling deterministic facts and running one capable-model summary. It is hooked non-fatally and **off-band** into `AdvanceRunCommand` (the same file C hooks, same `sealAsync`-style seam), because the summary is a model call and the handler runs on a 5s RPC budget. Recall reads the `state` block during normal traversal; there is no new RPC or UI.

**Tech Stack:** Go 1.x, `pkg/wavevault` (A), `pkg/jarvisdossier` (B), `pkg/jarvis` (Run lifecycle constants), `pkg/consult` (headless `claude`), `pkg/wstore`. No new WaveObj type, no migration, no `task generate` (no wire type changes).

## Global Constraints

- **E is a pure vault writer at a lifecycle boundary + a pure-read seam.** It never polls; the only model call is the one boundary summary, mocked in tests via `SetSummarizeForTest`.
- **Determinism boundary = cost boundary.** Finding the dossier, assembling facts, and reading decisions are deterministic and free. The model runs once per rest transition, and **not at all** when there is nothing to summarize (the terse no-activity path).
- **Off-band, non-fatal, detached context.** `CaptureRunBoundary` is dispatched on `captureAsync` (a seam, `go fn()` in prod) with its own `context.Background()` timeout — never the RPC handler's `ctx`, never inline. A capture failure must never fail or slow the run transition (known wshrpc 5s-budget / EC-TIME hazard).
- **E does not create dossiers.** If no dossier references the run (C's dispatch capture didn't run), E no-ops. Creation is C's responsibility.
- **Invariant 6 (human owns decisions/completion).** The summary prompt forbids inventing decisions or declaring completion beyond the recorded run status. The model drafts prose over deterministic facts only.
- **Invariant 5 (write-ownership).** Writes go through B's region-aware, diff-validated setters; on `WriteResult.Conflict` (a concurrent human edit) E backs off without clobbering — the next boundary retries.
- **No copying Run evidence into Markdown.** The summary uses the run's status/goal/end-commit-presence and referenced-decision rationale — never a transcript or diff.
- **PLACEHOLDER tuning** (recorded in `docs/deferred.md`): summary length cap (`<=4 sentences`), the rest-state set `{awaiting-review, blocked, done}` (drop `awaiting-review` if gate-heavy runs prove noisy), `continuityCaptureTimeout = 90s`.
- **Windows env; Go tests** via `go test ./pkg/<pkg>/`. Single test: `go test ./pkg/<pkg>/ -run TestName -v`.
- **Git workflow (user override):** do NOT commit without explicit approval. Each task ends by **staging** its files; a single feature commit (including the spec, plan, `docs/deferred.md`, and the meta-spec E-row) is made at the end on approval. Do not add a co-author.
- **Dependency:** E updates dossiers C creates at dispatch. E's *implementation* lands after C merges; its unit tests stand alone (they seed a linked dossier directly). The CDP leg (Task 4) requires C's dispatch hook. E's `AdvanceRunCommand` edit does not conflict with C's `CreateRunCommand` edit (different functions, same file).

---

### Task 1: `pkg/jarviscontinuity/summary.go` — pure fact model + prompt builder

The deterministic, process-free half: the fact struct, the activity check, the terse fallback, and the summary prompt. No vault, no model — fully unit-testable in isolation.

**Files:**
- Create: `pkg/jarviscontinuity/summary.go`
- Create: `pkg/jarviscontinuity/summary_test.go`

**Interfaces:**
- Consumes: nothing (pure stdlib).
- Produces: `SummaryFacts{Objective, RestReason string; Blockers, Decisions []string; RunGoal, RunStatus string; HasEndCommit bool}`; `(SummaryFacts).hasActivity() bool`; `terseState(SummaryFacts) string`; `buildSummaryPrompt(SummaryFacts) string`; consts `restAwaitingReview = "awaiting review"`, `restBlocked = "blocked"`, `restCompleted = "completed"`.

- [ ] **Step 1: Write the failing test**

Create `pkg/jarviscontinuity/summary_test.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarviscontinuity

import (
	"strings"
	"testing"
)

func TestBuildSummaryPromptIncludesFactsAndGuardrails(t *testing.T) {
	f := SummaryFacts{
		Objective:  "ship the widget",
		RestReason: restBlocked,
		Blockers:   []string{"token refresh test failing"},
		Decisions:  []string{"chose middleware extraction because it isolates auth"},
		RunGoal:    "ship ABC-7 the widget",
		RunStatus:  "blocked",
	}
	p := buildSummaryPrompt(f)
	for _, want := range []string{
		"ship the widget", "blocked", "token refresh test failing",
		"middleware extraction", "Do not invent decisions",
	} {
		if !strings.Contains(p, want) {
			t.Errorf("prompt missing %q\n---\n%s", want, p)
		}
	}
}

func TestHasActivityAndTerseState(t *testing.T) {
	empty := SummaryFacts{RestReason: restBlocked}
	if empty.hasActivity() {
		t.Fatal("no blockers/decisions/endcommit -> no activity")
	}
	if got := terseState(empty); !strings.Contains(got, "no recorded progress") {
		t.Errorf("terse paused state = %q", got)
	}
	if got := terseState(SummaryFacts{RestReason: restCompleted}); !strings.Contains(got, "Completed") {
		t.Errorf("terse completed state = %q", got)
	}
	if !(SummaryFacts{RestReason: restBlocked, Blockers: []string{"x"}}).hasActivity() {
		t.Fatal("a blocker means there is activity to summarize")
	}
	if !(SummaryFacts{RestReason: restCompleted, HasEndCommit: true}).hasActivity() {
		t.Fatal("a completed run with an end commit has activity")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./pkg/jarviscontinuity/ -v`
Expected: FAIL — package/undefined `SummaryFacts`, `buildSummaryPrompt`, `terseState`, `restBlocked`.

- [ ] **Step 3: Write minimal implementation**

Create `pkg/jarviscontinuity/summary.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Package jarviscontinuity writes a task dossier's narrative "where it stands" summary at Run rest
// boundaries (paused/completed), so recall (sub-project C) can serve continuity. It is the mirror of
// pkg/jarviscapture (which writes the dossier at dispatch) and stays a lifecycle-boundary writer only.
package jarviscontinuity

import (
	"fmt"
	"strings"
)

// Rest-reason phrases used in the narrative (human-readable, decoupled from jarvis.RunStatus_* strings).
const (
	restAwaitingReview = "awaiting review"
	restBlocked        = "blocked"
	restCompleted      = "completed"
)

// SummaryFacts are the deterministic inputs to the boundary narrative, assembled from the dossier, its
// referenced decisions, and the triggering run. No transcript, no diff (meta-spec non-goal).
type SummaryFacts struct {
	Objective    string
	RestReason   string   // restAwaitingReview | restBlocked | restCompleted
	Blockers     []string // non-empty blocker lines from the dossier
	Decisions    []string // referenced decision rationale snippets
	RunGoal      string
	RunStatus    string
	HasEndCommit bool
}

// hasActivity reports whether there is anything worth a model summary. With no blockers, no decisions,
// and no run outcome signal, E writes a terse deterministic line instead of paying for a model call.
func (f SummaryFacts) hasActivity() bool {
	return len(f.Blockers) > 0 || len(f.Decisions) > 0 || f.HasEndCommit
}

// terseState is the deterministic no-activity narrative — a rewarded "nothing to say" state, never
// confabulation (invariant 7). No model call.
func terseState(f SummaryFacts) string {
	if f.RestReason == restCompleted {
		return "Completed; no recorded details."
	}
	return fmt.Sprintf("Paused (%s); no recorded progress yet.", f.RestReason)
}

// buildSummaryPrompt renders the deterministic facts into the one-shot summary prompt. PLACEHOLDER: the
// <=4-sentence cap is an untuned default (see docs/deferred.md). Invariant 6 guardrails are explicit.
func buildSummaryPrompt(f SummaryFacts) string {
	var b strings.Builder
	b.WriteString("You are Jarvis, summarizing where a development task stands so it can be resumed later.\n")
	b.WriteString("Write ONE short paragraph (at most 4 sentences) describing where the work stands and what remains, using ONLY the facts below.\n")
	b.WriteString("Do not invent decisions. Do not claim the task is complete or correct beyond the stated run status. If a fact is absent, omit it — never speculate.\n\n")
	b.WriteString("Objective: " + f.Objective + "\n")
	b.WriteString("State: " + f.RestReason + "\n")
	if f.RunGoal != "" {
		b.WriteString("Latest run: " + f.RunGoal + " (status: " + f.RunStatus + ")\n")
	}
	if len(f.Blockers) > 0 {
		b.WriteString("Blockers:\n")
		for _, bl := range f.Blockers {
			b.WriteString("- " + bl + "\n")
		}
	}
	if len(f.Decisions) > 0 {
		b.WriteString("Decisions recorded:\n")
		for _, d := range f.Decisions {
			b.WriteString("- " + d + "\n")
		}
	}
	return b.String()
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./pkg/jarviscontinuity/ -v`
Expected: PASS (`TestBuildSummaryPromptIncludesFactsAndGuardrails`, `TestHasActivityAndTerseState`).

- [ ] **Step 5: Stage (commit deferred to approval)**

```bash
git add pkg/jarviscontinuity/summary.go pkg/jarviscontinuity/summary_test.go
```

---

### Task 2: `pkg/jarviscontinuity/continuity.go` — capture writer, resume reader, model seam

The I/O half: find the dossier, assemble facts, summarize (mockable), write `state` + flip `status`, commit; plus the pure-read `Resume` seam and the rest-state helpers.

**Files:**
- Create: `pkg/jarviscontinuity/continuity.go`
- Create: `pkg/jarviscontinuity/continuity_test.go`

**Interfaces:**
- Consumes (Task 1): `SummaryFacts`, `hasActivity`, `terseState`, `buildSummaryPrompt`, `restAwaitingReview`/`restBlocked`/`restCompleted`. From B: `jarvisdossier.LoadDossier(r *wavevault.Retriever, id string) (*Dossier, error)`, `LoadDecision(r, id) (*Decision, error)`, `SetState(v, id, summary, baseHash) (*wavevault.WriteResult, error)`, `SetStatus(v, id, status, baseHash) (*wavevault.WriteResult, error)`; `Dossier{Objective, Status string; Blockers, Refs []string; State string; Hash string; Updated int64}`, `Decision{Rationale string}`; (tests) `CreateDossier`, `SetRefs`, `AppendDecision`, `DossierFacts`, `DecisionFacts`. From A: `wavevault.OpenVault(ctx) (*Vault, error)`, `OpenVaultAtForTest(ctx, root) (*Vault, error)`, `(*Vault).Retriever(Scope) *Retriever`, `(*Vault).Commit(ctx, label) error`, `AllScope()`, `Filter{HasLink}`, `(*Retriever).Query(Filter) ([]Node, error)`, `Node{ID string}`, `WriteResult{Hash string; Conflict bool}`. From `consult`: `SpecFor(string) (RuntimeSpec, bool)`, `Run(ctx, spec, cwd, prompt, emit) (string, error)`. From `jarvis`: `RunStatus_AwaitingReview`, `RunStatus_Blocked`, `RunStatus_Done`. From `waveobj`: `Run{OID, ID, Goal, Status, EndCommit, ProjectPath string}`.
- Produces: `IsRestState(status string) bool`; `CaptureRunBoundary(ctx, run *waveobj.Run) error`; unexported `captureRunBoundary(ctx, v *wavevault.Vault, run *waveobj.Run) error`, `assembleFacts(r *wavevault.Retriever, d *jarvisdossier.Dossier, run *waveobj.Run) SummaryFacts`, `restReason(status) string`, `dossierStatus(status) string`; `Resume(r *wavevault.Retriever, taskID string) (Narrative, error)` + `Narrative{Summary, Status string; Updated int64; RunRefs []string}`; the `summarize` var + `SetSummarizeForTest(fn) (old)`.

- [ ] **Step 1: Write the failing test**

Create `pkg/jarviscontinuity/continuity_test.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarviscontinuity

import (
	"context"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/jarvisdossier"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wavevault"
)

const testRunOID = "cccccccc-0000-0000-0000-000000000001"

// seedDossier builds a fixture vault with a dossier that references testRunOID and one decision.
func seedDossier(t *testing.T) (*wavevault.Vault, string) {
	t.Helper()
	ctx := context.Background()
	v, err := wavevault.OpenVaultAtForTest(ctx, t.TempDir())
	if err != nil {
		t.Fatalf("open vault: %v", err)
	}
	id, hash, err := jarvisdossier.CreateDossier(v, jarvisdossier.DossierFacts{
		Ticket: "ABC-7", Objective: "ship the widget", Confidence: "med",
	})
	if err != nil {
		t.Fatalf("create dossier: %v", err)
	}
	if _, err := jarvisdossier.SetRefs(v, id, []string{"run-" + testRunOID}, hash); err != nil {
		t.Fatalf("set refs: %v", err)
	}
	if _, err := jarvisdossier.AppendDecision(v, jarvisdossier.DecisionFacts{
		TaskID: id, Actor: "jarvis", Provenance: "test",
		Summary: "middleware", Rationale: "chose middleware extraction because it isolates auth",
	}); err != nil {
		t.Fatalf("append decision: %v", err)
	}
	return v, id
}

func TestIsRestState(t *testing.T) {
	for _, s := range []string{"awaiting-review", "blocked", "done"} {
		if !IsRestState(s) {
			t.Errorf("IsRestState(%q) = false, want true", s)
		}
	}
	for _, s := range []string{"planning", "executing", "cancelled", ""} {
		if IsRestState(s) {
			t.Errorf("IsRestState(%q) = true, want false", s)
		}
	}
}

func TestCaptureWritesNarrativeAndFlipsPaused(t *testing.T) {
	ctx := context.Background()
	v, id := seedDossier(t)
	restore := SetSummarizeForTest(func(context.Context, string, string) (string, error) {
		return "Blocked on the token-refresh test; middleware extracted.", nil
	})
	defer SetSummarizeForTest(restore)

	run := &waveobj.Run{OID: testRunOID, ID: testRunOID, Goal: "ship ABC-7 the widget", Status: "blocked"}
	if err := captureRunBoundary(ctx, v, run); err != nil {
		t.Fatalf("captureRunBoundary: %v", err)
	}

	d, err := jarvisdossier.LoadDossier(v.Retriever(wavevault.AllScope()), id)
	if err != nil {
		t.Fatalf("load dossier: %v", err)
	}
	if !strings.Contains(d.State, "token-refresh") {
		t.Errorf("state = %q, want the mocked narrative", d.State)
	}
	if d.Status != "paused" {
		t.Errorf("status = %q, want paused", d.Status)
	}
}

func TestCaptureDoneFlipsCompleted(t *testing.T) {
	ctx := context.Background()
	v, id := seedDossier(t)
	restore := SetSummarizeForTest(func(context.Context, string, string) (string, error) { return "Done.", nil })
	defer SetSummarizeForTest(restore)

	run := &waveobj.Run{OID: testRunOID, ID: testRunOID, Goal: "ship it", Status: "done", EndCommit: "abc123"}
	if err := captureRunBoundary(ctx, v, run); err != nil {
		t.Fatalf("capture: %v", err)
	}
	d, _ := jarvisdossier.LoadDossier(v.Retriever(wavevault.AllScope()), id)
	if d.Status != "completed" {
		t.Errorf("status = %q, want completed", d.Status)
	}
}

func TestCaptureNoDossierIsNoOpNoModel(t *testing.T) {
	ctx := context.Background()
	v, err := wavevault.OpenVaultAtForTest(ctx, t.TempDir())
	if err != nil {
		t.Fatalf("open vault: %v", err)
	}
	called := false
	restore := SetSummarizeForTest(func(context.Context, string, string) (string, error) { called = true; return "x", nil })
	defer SetSummarizeForTest(restore)

	run := &waveobj.Run{OID: "no-such-run", Status: "done"}
	if err := captureRunBoundary(ctx, v, run); err != nil {
		t.Fatalf("capture: %v", err)
	}
	if called {
		t.Fatal("no dossier for the run -> must not call the model")
	}
}

func TestCaptureEmptyTaskWritesTerseNoModel(t *testing.T) {
	ctx := context.Background()
	v, err := wavevault.OpenVaultAtForTest(ctx, t.TempDir())
	if err != nil {
		t.Fatalf("open vault: %v", err)
	}
	id, hash, err := jarvisdossier.CreateDossier(v, jarvisdossier.DossierFacts{Objective: "empty task", Confidence: "med"})
	if err != nil {
		t.Fatalf("create dossier: %v", err)
	}
	if _, err := jarvisdossier.SetRefs(v, id, []string{"run-" + testRunOID}, hash); err != nil {
		t.Fatalf("set refs: %v", err)
	}
	called := false
	restore := SetSummarizeForTest(func(context.Context, string, string) (string, error) { called = true; return "x", nil })
	defer SetSummarizeForTest(restore)

	run := &waveobj.Run{OID: testRunOID, Status: "blocked"} // no blockers/decisions, no EndCommit
	if err := captureRunBoundary(ctx, v, run); err != nil {
		t.Fatalf("capture: %v", err)
	}
	if called {
		t.Fatal("empty task -> terse deterministic line, no model call")
	}
	d, _ := jarvisdossier.LoadDossier(v.Retriever(wavevault.AllScope()), id)
	if !strings.Contains(d.State, "no recorded progress") {
		t.Errorf("state = %q, want the terse fallback", d.State)
	}
}

func TestResumeReadsPrecomputedState(t *testing.T) {
	ctx := context.Background()
	v, id := seedDossier(t)
	restore := SetSummarizeForTest(func(context.Context, string, string) (string, error) { return "narrative here", nil })
	defer SetSummarizeForTest(restore)

	run := &waveobj.Run{OID: testRunOID, ID: testRunOID, Goal: "g", Status: "blocked", EndCommit: "x"}
	if err := captureRunBoundary(ctx, v, run); err != nil {
		t.Fatalf("capture: %v", err)
	}

	n, err := Resume(v.Retriever(wavevault.AllScope()), id)
	if err != nil {
		t.Fatalf("resume: %v", err)
	}
	if !strings.Contains(n.Summary, "narrative here") {
		t.Errorf("resume summary = %q", n.Summary)
	}
	if n.Status != "paused" {
		t.Errorf("resume status = %q, want paused", n.Status)
	}
	found := false
	for _, r := range n.RunRefs {
		if r == "run-"+testRunOID {
			found = true
		}
	}
	if !found {
		t.Errorf("resume runRefs = %v, missing the run ref", n.RunRefs)
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./pkg/jarviscontinuity/ -run 'TestIsRestState|TestCapture|TestResume' -v`
Expected: FAIL — undefined `IsRestState`, `captureRunBoundary`, `Resume`, `SetSummarizeForTest`.

- [ ] **Step 3: Write minimal implementation**

Create `pkg/jarviscontinuity/continuity.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarviscontinuity

import (
	"context"
	"fmt"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/consult"
	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/jarvisdossier"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wavevault"
)

var errNoClaude = fmt.Errorf("continuity summary requires the claude CLI, which is not available")

// summarize is the one model call (the capable model — tiering is deferred). A seam so tests mock it.
// Capture is one-shot and unstreamed, so the emit callback is discarded.
var summarize = func(ctx context.Context, cwd, prompt string) (string, error) {
	spec, ok := consult.SpecFor("claude")
	if !ok {
		return "", errNoClaude
	}
	return consult.Run(ctx, spec, cwd, prompt, func(string) {})
}

// SetSummarizeForTest swaps the model call; returns the previous value for restore.
func SetSummarizeForTest(fn func(ctx context.Context, cwd, prompt string) (string, error)) func(context.Context, string, string) (string, error) {
	old := summarize
	summarize = fn
	return old
}

// IsRestState reports whether a run status is a boundary E captures at: the run has come to rest and
// the human will want to know where it stands. planning/executing are in-flight; cancelled is abandoned.
func IsRestState(status string) bool {
	switch status {
	case jarvis.RunStatus_AwaitingReview, jarvis.RunStatus_Blocked, jarvis.RunStatus_Done:
		return true
	}
	return false
}

// restReason maps a run status to the human-readable narrative rest reason.
func restReason(status string) string {
	switch status {
	case jarvis.RunStatus_Done:
		return restCompleted
	case jarvis.RunStatus_Blocked:
		return restBlocked
	default:
		return restAwaitingReview
	}
}

// dossierStatus maps a run rest status to the dossier status B understands.
func dossierStatus(status string) string {
	if status == jarvis.RunStatus_Done {
		return "completed"
	}
	return "paused"
}

// CaptureRunBoundary writes the dossier's narrative state summary + status at a run rest boundary,
// against the default vault. Contract: the caller dispatches this off-band and logs errors (it makes a
// model call and must never block/fail a run transition).
func CaptureRunBoundary(ctx context.Context, run *waveobj.Run) error {
	v, err := wavevault.OpenVault(ctx)
	if err != nil {
		return err
	}
	return captureRunBoundary(ctx, v, run)
}

// captureRunBoundary takes an explicit vault so tests exercise it against a fixture vault. No-op if no
// dossier references the run (C's dispatch capture is the only creator — E never creates).
func captureRunBoundary(ctx context.Context, v *wavevault.Vault, run *waveobj.Run) error {
	r := v.Retriever(wavevault.AllScope())
	linked, err := r.Query(wavevault.Filter{HasLink: "run-" + run.OID})
	if err != nil {
		return err
	}
	if len(linked) == 0 {
		return nil
	}
	id := linked[0].ID
	d, err := jarvisdossier.LoadDossier(r, id)
	if err != nil {
		return err
	}

	facts := assembleFacts(r, d, run)
	narrative := terseState(facts)
	if facts.hasActivity() {
		out, serr := summarize(ctx, run.ProjectPath, buildSummaryPrompt(facts))
		if serr != nil {
			return serr
		}
		if s := strings.TrimSpace(out); s != "" {
			narrative = s
		}
	}

	res, err := jarvisdossier.SetState(v, id, narrative, d.Hash)
	if err != nil {
		return err
	}
	if res.Conflict {
		return nil // a concurrent human edit won; do not clobber (invariant 5). Next boundary retries.
	}
	if _, err := jarvisdossier.SetStatus(v, id, dossierStatus(run.Status), res.Hash); err != nil {
		return err
	}
	return v.Commit(ctx, "jarvis: continuity summary for run "+run.OID)
}

// assembleFacts gathers the deterministic narrative inputs: the dossier's objective + non-empty
// blockers, the triggering run's outcome, and the rationale of each referenced decision (dangling
// refs are skipped, not fatal). Pure reads — no model.
func assembleFacts(r *wavevault.Retriever, d *jarvisdossier.Dossier, run *waveobj.Run) SummaryFacts {
	var blockers []string
	for _, b := range d.Blockers {
		if strings.TrimSpace(b) != "" {
			blockers = append(blockers, b)
		}
	}
	var decisions []string
	for _, ref := range d.Refs {
		if !strings.HasPrefix(ref, "dec-") {
			continue
		}
		if dec, err := jarvisdossier.LoadDecision(r, ref); err == nil {
			if s := strings.TrimSpace(dec.Rationale); s != "" {
				decisions = append(decisions, s)
			}
		}
	}
	return SummaryFacts{
		Objective:    d.Objective,
		RestReason:   restReason(run.Status),
		Blockers:     blockers,
		Decisions:    decisions,
		RunGoal:      run.Goal,
		RunStatus:    run.Status,
		HasEndCommit: run.EndCommit != "",
	}
}

// Narrative is the continuity view E serves — the precomputed state prose plus the machine status and
// referenced runs. This realizes the meta spec's resume(task) seam.
type Narrative struct {
	Summary string
	Status  string
	Updated int64
	RunRefs []string
}

// Resume reads the precomputed continuity narrative for a task. Pure, deterministic, free (no model):
// it returns whatever E last wrote at a boundary. No wired v1 consumer — recall reads the state block
// during ordinary traversal; this is the named seam for a later ambient/UI slice.
func Resume(r *wavevault.Retriever, taskID string) (Narrative, error) {
	d, err := jarvisdossier.LoadDossier(r, taskID)
	if err != nil {
		return Narrative{}, err
	}
	var runRefs []string
	for _, ref := range d.Refs {
		if strings.HasPrefix(ref, "run-") {
			runRefs = append(runRefs, ref)
		}
	}
	return Narrative{Summary: d.State, Status: d.Status, Updated: d.Updated, RunRefs: runRefs}, nil
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./pkg/jarviscontinuity/ -v`
Expected: PASS — all Task 1 + Task 2 tests.

- [ ] **Step 5: Verify the package builds and vets clean**

Run: `go vet ./pkg/jarviscontinuity/`
Expected: no output (exit 0).

- [ ] **Step 6: Stage (commit deferred to approval)**

```bash
git add pkg/jarviscontinuity/continuity.go pkg/jarviscontinuity/continuity_test.go
```

---

### Task 3: Wire the off-band, non-fatal capture hook into `AdvanceRunCommand`

Adds a `captureAsync` seam and dispatches `CaptureRunBoundary` when a run enters a new rest state. The existing package tests must not touch the vault, so the package default (`maintest_test.go`) stubs `captureAsync` to a no-op; the new wiring test overrides it to capture the dispatch.

**Files:**
- Modify: `pkg/wshrpc/wshserver/wshserver_runs.go` (add import + `captureAsync` seam + `continuityCaptureTimeout` const; capture `preStatus`; dispatch after the post-transition reload)
- Modify: `pkg/wshrpc/wshserver/maintest_test.go` (default `captureAsync` to a no-op for the package's tests)
- Modify: `pkg/wshrpc/wshserver/wshserver_run_test.go` (add the dispatch test)

**Interfaces:**
- Consumes: `jarviscontinuity.IsRestState(status string) bool`, `jarviscontinuity.CaptureRunBoundary(ctx, run *waveobj.Run) error`; existing `wstore.GetRun`, `jarvis.NewRun`, `jarvis.SpawnClaudeWorker`, `wstore.CreateChannel`, `wstore.AppendRun`.
- Produces: `var captureAsync func(func())` (package seam); `const continuityCaptureTimeout`.

- [ ] **Step 1: Add the `captureAsync` seam + timeout const next to `sealAsync`**

In `pkg/wshrpc/wshserver/wshserver_runs.go`, immediately after the existing `sealAsync` declaration (currently ~line 38: `var sealAsync = func(fn func()) { go fn() }`), add:

```go
// captureAsync dispatches the continuity boundary summary (sub-project E) off the RPC handler's
// goroutine — it makes a model call and must never sit on the 5s RPC budget. A seam so tests capture
// the dispatch without running it.
var captureAsync = func(fn func()) { go fn() }

// continuityCaptureTimeout bounds the detached boundary-summary model call (PLACEHOLDER; see docs/deferred.md).
const continuityCaptureTimeout = 90 * time.Second
```

Add the import to the `pkg/...` import group (alphabetical):

```go
	"github.com/wavetermdev/waveterm/pkg/jarviscontinuity"
```

(`context`, `time`, and `log` are already imported in this file.)

- [ ] **Step 2: Capture `preStatus` before the update, and dispatch after the post-transition reload**

In `AdvanceRunCommand`, immediately after the argument validation (`if data.ChannelId == "" ...`) and before the `leadToSteer` block (~line 319), add:

```go
	preStatus := ""
	if pre, perr := wstore.GetRun(ctx, data.ChannelId, data.RunId); perr == nil {
		preStatus = pre.Status
	}
```

Then, after the existing `→ done` seal block (the `if run, gerr := wstore.GetRun(...); ... run.Status == jarvis.RunStatus_Done { ... }` block, currently ending ~line 360) and before `ch, err := wstore.DBMustGet[*waveobj.Channel](ctx, data.ChannelId)`, add:

```go
	// continuity (sub-project E): on entering a rest state (awaiting-review | blocked | done), write the
	// dossier's narrative "where it stands" summary off the RPC budget. Non-fatal; a detached context so
	// it outlives this handler.
	if postRun, gerr := wstore.GetRun(ctx, data.ChannelId, data.RunId); gerr == nil &&
		jarviscontinuity.IsRestState(postRun.Status) && postRun.Status != preStatus {
		run := *postRun
		captureAsync(func() {
			cctx, cancel := context.WithTimeout(context.Background(), continuityCaptureTimeout)
			defer cancel()
			if cerr := jarviscontinuity.CaptureRunBoundary(cctx, &run); cerr != nil {
				log.Printf("AdvanceRun: continuity capture failed (non-fatal): %v", cerr)
			}
		})
	}
```

- [ ] **Step 3: Default `captureAsync` to a no-op for package tests**

In `pkg/wshrpc/wshserver/maintest_test.go`, immediately after the line that sets `sealAsync` (currently `sealAsync = func(fn func()) { fn() }`, ~line 31), add:

```go
	// Continuity capture opens the real vault + calls a model; keep it out of the package's run tests.
	// The dedicated wiring test overrides this locally to observe the dispatch.
	captureAsync = func(fn func()) {}
```

- [ ] **Step 4: Write the failing wiring test**

Append to `pkg/wshrpc/wshserver/wshserver_run_test.go`:

```go
// A run entering a rest state must dispatch the continuity boundary summary off the RPC budget (it is a
// model call). We prove the decoupling via the captureAsync seam: capture the dispatched func instead of
// running it, and confirm a ->done transition dispatched exactly one capture.
func TestAdvanceRunDispatchesContinuityCapture(t *testing.T) {
	ctx := context.Background()
	ch, err := wstore.CreateChannel(ctx, "continuity-dispatch", t.TempDir())
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	run := jarvis.NewRun("finish it", "ws-1", ch.ProjectPath, nil, jarvis.RunMode_Quick, jarvis.QuickPlaybook(), 1)
	if err := wstore.AppendRun(ctx, ch.OID, run); err != nil {
		t.Fatalf("AppendRun: %v", err)
	}

	var capturedContinuity func()
	origCap := captureAsync
	captureAsync = func(fn func()) { capturedContinuity = fn }
	defer func() { captureAsync = origCap }()

	// keep the evidence seal off a real goroutine / git diff for this test
	origSeal := sealAsync
	sealAsync = func(fn func()) {}
	defer func() { sealAsync = origSeal }()

	origSpawn := jarvis.SpawnClaudeWorker
	jarvis.SpawnClaudeWorker = func(_ context.Context, _, _, _, _ string) (string, error) {
		return waveobj.MakeORef(waveobj.OType_Tab, "x").String(), nil
	}
	defer func() { jarvis.SpawnClaudeWorker = origSpawn }()

	ws := &WshServer{}
	if err := ws.AdvanceRunCommand(ctx, wshrpc.CommandAdvanceRunData{
		ChannelId: ch.OID, RunId: run.ID, PhaseIdx: 0, Action: jarvis.RunAction_Complete,
	}); err != nil {
		t.Fatalf("AdvanceRunCommand: %v", err)
	}

	if capturedContinuity == nil {
		t.Fatal("continuity capture was not dispatched on the ->done rest transition")
	}
}
```

- [ ] **Step 5: Run the test to verify it fails, then passes**

Run: `go test ./pkg/wshrpc/wshserver/ -run TestAdvanceRunDispatchesContinuityCapture -v`
Expected before Steps 1–3 are complete: FAIL/compile error — undefined `captureAsync`. After: PASS.

- [ ] **Step 6: Run the full package test to confirm nothing regressed**

Run: `go test ./pkg/wshrpc/wshserver/`
Expected: PASS. In particular `TestCompleteDefersEvidenceSeal` is unaffected (it overrides `sealAsync` locally; `captureAsync` is the package no-op).

- [ ] **Step 7: Verify the build compiles**

Run: `go build ./pkg/wshrpc/wshserver/ ./pkg/jarviscontinuity/`
Expected: no output (exit 0).

- [ ] **Step 8: Stage (commit deferred to approval)**

```bash
git add pkg/wshrpc/wshserver/wshserver_runs.go pkg/wshrpc/wshserver/maintest_test.go pkg/wshrpc/wshserver/wshserver_run_test.go
```

---

### Task 4: CDP scenario — completion narrative surfaces through recall

Extends C's live-app check with the E leg: dispatch a Run (C creates the dossier), advance it to done (E writes the completion narrative), then ask Jarvis and see the narrative reflected. Verified manually against the dev app; **requires C merged** (its dispatch hook + `jarvis-vault-recall` scenario).

**Files:**
- Modify: `scripts/cdp/scenarios.mjs` (extend the `jarvis-vault-recall` scenario, or add `jarvis-continuity-resume`)

**Interfaces:**
- Consumes: the shared CDP attach/arrange/assert helpers in `scripts/cdp/`; C's existing `jarvis-vault-recall` scenario (dispatch + ask).
- Produces: a scenario runnable via `task verify:ui -- jarvis-continuity-resume` (or the extended `jarvis-vault-recall`).

- [ ] **Step 1: Read the existing scenario structure**

Read `scripts/cdp/scenarios.mjs` and C's `jarvis-vault-recall` scenario (arrange → goto → shot → assert → teardown). Note the `.mjs` formatting rule: **hand-format 4-space; never run `prettier --write` on `scripts/*.mjs`** (project memory). Match the surrounding indentation exactly.

- [ ] **Step 2: Add the continuity leg**

Following the existing scenario shape, add a scenario that:
1. **arrange:** dispatch a Run via the real `CreateRunCommand` (C creates the dossier through its Task-1 hook), then advance it to `done` via `AdvanceRunCommand` with `Action: "complete"` (E's Task-3 hook writes the completion narrative). Reuse the run-dispatch/advance arrange the `runs` scenarios use.
2. **goto:** the Jarvis surface; ask "where did <the run's goal / ticket> land".
3. **assert:** the grounded answer reflects a completed task (a `dossier` grounding card whose task is completed) — not the empty-vault `notfound` state.
4. **teardown:** clean the dispatched Run as the `runs` scenarios do.

- [ ] **Step 3: Run the scenario against the dev app**

Prereq: `task dev` running (WebView2 CDP on `:9222`, per `CLAUDE.md`). If iterating, remember the shared-tree HMR gotchas (a `git mv`/crash blanks the page — `location.reload()` and re-verify).
Run: `task verify:ui -- jarvis-continuity-resume`
Expected: PASS row; the completion narrative surfaces. If the dev app is not running, defer to a manual pass and note it at the checkpoint rather than marking it green.

- [ ] **Step 4: Stage (commit deferred to approval)**

```bash
git add scripts/cdp/scenarios.mjs
```

---

## Final: single feature commit (on approval)

- [ ] **Confirm the full suite is green**

Run: `go test ./pkg/jarviscontinuity/ ./pkg/wshrpc/wshserver/`
Expected: PASS.

- [ ] **Record E's deferrals + placeholders in `docs/deferred.md`**

Append entries (matching the file's existing format): the Haiku model tier for boundary summaries (fork 2 — shared with C's synthesis, its own future slice); the resume UI/RPC + ambient "pick up where you left off" affordance (fork 1); the app idle/quit continuity flush (A already commits on quit); completed-task prose re-freshness (§3 caveat — terminal dossiers don't re-summarize on later fact changes); and the PLACEHOLDER tuning (summary `<=4`-sentence cap, the `{awaiting-review, blocked, done}` rest-state set, `continuityCaptureTimeout = 90s`).

```bash
git add docs/deferred.md
```

- [ ] **Get explicit approval to commit, then commit once**

Per the user's git workflow, batch everything into one feature commit — including the spec, the plan, the `docs/deferred.md` entry (spec/plan docs fold into the feature commit they describe; no separate docs commit), and the meta-spec tracking-table E-row link.

```bash
git add docs/superpowers/specs/2026-07-24-jarvis-e-continuity-design.md \
        docs/superpowers/plans/2026-07-24-jarvis-e-continuity.md \
        docs/superpowers/specs/2026-07-23-jarvis-second-brain-meta-spec.md
git commit -F <commit message file>
```

(Update the meta-spec E-row: link the spec + plan and mark it Built.)

---

## Self-Review

**1. Spec coverage:**
- Rest-boundary capture writer (find dossier → assemble facts → summarize → SetState/SetStatus → Commit) → Task 2 (`captureRunBoundary`). ✓
- The narrative (deterministic facts, invariant-6 guardrails, terse empty-task path, length cap) → Tasks 1 (`buildSummaryPrompt`, `terseState`, `hasActivity`) + 2 (`assembleFacts`). ✓
- Pure-read resume seam, unwired in v1 → Task 2 (`Resume`, `Narrative`). ✓
- Rest-state rule `IsRestState(post) && post != pre` (`awaiting-review|blocked|done`) → Task 2 (`IsRestState`) + Task 3 (`preStatus` guard). ✓
- Off-band, non-fatal, detached-context hook in `AdvanceRunCommand` → Task 3 (`captureAsync`, `continuityCaptureTimeout`, background ctx, logged). ✓
- Interim capable model, mockable → Task 2 (`summarize`/`SetSummarizeForTest`, `consult.SpecFor("claude")`). ✓
- CDP completion-narrative leg → Task 4. ✓
- Deferred items + placeholders recorded → `docs/deferred.md` (Final). ✓
- No new WaveObj/migration/RPC/`task generate`; E doesn't create dossiers; conflict-aware (invariant 5) → honored in Task 2 (`res.Conflict` back-off) and the constraints. ✓

**2. Placeholder scan:** No "TBD"/"implement later"/"add error handling" — every step shows concrete code or an exact command. The `PLACEHOLDER` tuning values (summary length cap, rest-state set, capture timeout) are intentional, named, and recorded in `docs/deferred.md`. ✓

**3. Type consistency:** `SummaryFacts` (fields, `hasActivity`, `terseState`, `buildSummaryPrompt`, `rest*` consts) defined in Task 1, consumed in Task 2. `captureRunBoundary(ctx, v, run)` used by both `CaptureRunBoundary` and the Task-2 tests; `SetSummarizeForTest` signature matches its test use across every test. `IsRestState`/`CaptureRunBoundary` (exported) consumed by Task 3's wiring; `captureAsync`/`continuityCaptureTimeout` defined in Task 3 and stubbed in `maintest_test.go`. `SetState`→`SetStatus` chain uses `WriteResult.Hash`/`.Conflict` (verified in `pkg/wavevault/write.go`). `LoadDecision` resolves `dec-*` refs (Node.ID = frontmatter `id`, verified in `parse.go`). Run fields `OID/ID/Goal/Status/EndCommit/ProjectPath` match `waveobj.Run`. ✓
