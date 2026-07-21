# Radar Multi-Mode — Plan 1: Mode Framework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route Radar's existing correctness scan through a mode-parameterized pipeline and record per-lens run status, with zero change to correctness findings — the foundation the security and tech-debt lenses (Plans 2 & 3) plug into.

**Architecture:** Promote `Mode` to a first-class dimension. A single scan collects signals once, then loops the scan modes (`V1Modes`, initially `{correctness}`): per mode it selects candidates, runs one bounded Sonnet call scoped to that mode's taxonomy, validates with that mode's admissibility rule, and merges the results. Each mode records a `RadarModeRun` so one lens failing to cluster degrades the report to `partial` instead of blanking it. Fingerprints stay 3-arg (project + risk kind + subsystem); risk-kind names are globally unique across modes, so `reconcile` segregates modes with no change and correctness history never re-keys.

**Tech Stack:** Go (`pkg/reporadar`, `pkg/waveobj`), TS codegen (`task generate`), React/TS frontend pure model (`frontend/app/view/agents`), vitest, Go test.

**Scope note:** This is Plan 1 of 3 from `docs/superpowers/specs/2026-07-21-radar-multi-mode-design.md`. It wires only the correctness mode through the new machinery. Plans 2 (security) and 3 (tech-debt) add their collectors, taxonomies, admissibility predicates, candidate selectors, and surface treatment on top of the seams built here. Surface work (mode filter chips, per-row badges, per-lens error banner) is deferred to Plan 2, where a second lens makes it visible and CDP-testable; Plan 1 lands the backend dimension plus the pure frontend model layer.

## Global Constraints

- **Fingerprint stays 3-arg** — `fingerprint(projectPath, riskKind, subsystem)` is NOT changed. Mode is never part of the hash (changing it would re-key every stored correctness finding).
- **Risk-kind names are globally unique across modes** — the load-bearing invariant that lets the fingerprint and `reconcile` stay unchanged. Guarded by a test in Task 1.
- **Empty `Mode` reads as `correctness`** — for back-compat with reports written before this change (Go: `validateFindings` always sets it; frontend: `findingMode()` defaults it).
- **Never hand-edit generated files** — Go is the source of truth. After changing any `pkg/waveobj` type, run `task generate` to regenerate the TS bindings (`frontend/types/gotypes.d.ts` et al).
- **No DB migration** — all persistence changes are fields on existing waveobj types (`RadarFinding`, `RadarReport`), not new object types, so no `db/migrations-wstore` file is needed.
- **Typecheck command:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (bare `npx tsc` stack-overflows here; baseline is clean, exit 0 — any error it reports is yours).
- **Frontend colors:** Tailwind `@theme` tokens only (`text-accent`, `text-error`, `text-warning`, `bg-*/NN`, …); never raw hex/rgba.
- **Git:** Do NOT commit per task. This repo batches all changes into one commit at the end, made only with explicit user approval; the design spec folds into that feature commit. Each task below ends at "tests green," not at a commit.

---

### Task 1: Mode dimension scaffolding

Add the mode taxonomy registry and the persisted fields every later task depends on. Deliverable: `ValidRiskKind(mode, kind)` behaves correctly, the cross-mode uniqueness invariant holds, and the package compiles.

**Files:**
- Modify: `pkg/reporadar/types.go`
- Modify: `pkg/waveobj/wtype.go:355-422` (add `Mode` to `RadarFinding`, `ModeRuns` + `RadarModeRun` to `RadarReport`)
- Test: `pkg/reporadar/types_test.go`

**Interfaces:**
- Produces: `ModeCorrectness/ModeSecurity/ModeDebt` consts; `V1Modes []string`; `RiskKindsByMode map[string][]string`; `ValidRiskKind(mode, kind string) bool`; `ModeRunCompleted/ModeRunClusterFailed/ModeRunSkipped` consts; `waveobj.RadarModeRun`; `RadarFinding.Mode`; `RadarReport.ModeRuns`.

- [ ] **Step 1: Update the failing test in `types_test.go`**

Replace the whole file with:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package reporadar

import "testing"

func TestValidRiskKind(t *testing.T) {
	if !ValidRiskKind(ModeCorrectness, RiskTestCoverageGap) {
		t.Fatal("test-coverage-gap should be valid for correctness")
	}
	if ValidRiskKind(ModeCorrectness, "style-nit") {
		t.Fatal("style-nit must be rejected")
	}
	if ValidRiskKind("no-such-mode", RiskTestCoverageGap) {
		t.Fatal("unknown mode must reject every kind")
	}
	if len(V1RiskKinds) != 6 {
		t.Fatalf("expected 6 v1 correctness risk kinds, got %d", len(V1RiskKinds))
	}
}

// TestRiskKindsGloballyUnique guards the invariant the fingerprint depends on: no risk-kind name is
// shared across modes, so fingerprints (project+kind+subsystem) never collide across modes and
// reconcile segregates modes with no mode-awareness.
func TestRiskKindsGloballyUnique(t *testing.T) {
	seen := map[string]string{}
	for mode, kinds := range RiskKindsByMode {
		for _, k := range kinds {
			if other, dup := seen[k]; dup {
				t.Fatalf("risk kind %q registered under both %q and %q — must be globally unique", k, other, mode)
			}
			seen[k] = mode
		}
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./pkg/reporadar/ -run 'TestValidRiskKind|TestRiskKindsGloballyUnique'`
Expected: FAIL — `ValidRiskKind` still takes one arg / `ModeCorrectness` undefined (compile error).

- [ ] **Step 3: Add the mode registry to `types.go`**

Add these blocks to `pkg/reporadar/types.go` (after the existing `V1RiskKinds` var, and replace the existing `ValidRiskKind`):

```go
// scan modes (RadarFinding.Mode). Correctness is the only mode wired in Plan 1; the security and
// debt lenses append themselves to V1Modes in their own plans.
const (
	ModeCorrectness = "correctness"
	ModeSecurity    = "security"
	ModeDebt        = "debt"
)

// V1Modes is the ordered set of modes a scan runs. Lens plans append ModeSecurity / ModeDebt.
var V1Modes = []string{ModeCorrectness}

// RiskKindsByMode is the per-mode taxonomy. Kind names MUST be globally unique across modes (see
// TestRiskKindsGloballyUnique) — that uniqueness is what lets the fingerprint stay mode-free.
var RiskKindsByMode = map[string][]string{
	ModeCorrectness: V1RiskKinds,
}

// per-mode clustering outcome (RadarModeRun.Status)
const (
	ModeRunCompleted     = "completed"
	ModeRunClusterFailed = "clustering-failed"
	ModeRunSkipped       = "skipped" // reserved for a future per-project mode toggle
)
```

Replace the existing `ValidRiskKind` func:

```go
func ValidRiskKind(mode, kind string) bool {
	for _, k := range RiskKindsByMode[mode] {
		if k == kind {
			return true
		}
	}
	return false
}
```

- [ ] **Step 4: Add the persisted fields to `wtype.go`**

In `pkg/waveobj/wtype.go`, add `Mode` to `RadarFinding` (immediately after the `Group` field at line 358):

```go
	Mode          string              `json:"mode,omitempty"` // correctness|security|debt (empty reads as correctness)
```

Add the `RadarModeRun` struct immediately before `type RadarReport struct` (line 392):

```go
// RadarModeRun is one mode's outcome within a scan. A scan runs each mode in V1Modes; recording per
// mode lets one lens fail to cluster (clustering-failed) while others deliver, so the report degrades
// to partial instead of appearing empty.
type RadarModeRun struct {
	Mode           string `json:"mode"`
	Status         string `json:"status"` // completed|clustering-failed|skipped
	ClusterError   string `json:"clustererror,omitempty"`
	PayloadTokens  int    `json:"payloadtokens,omitempty"`
	TotalTokens    int    `json:"totaltokens,omitempty"`
	TokensEstimated bool  `json:"tokensestimated,omitempty"`
	ResolvedModel  string `json:"resolvedmodel,omitempty"`
	FindingCount   int    `json:"findingcount,omitempty"`
}
```

Add `ModeRuns` to `RadarReport` (immediately after the `Findings` field at line 420):

```go
	ModeRuns             []RadarModeRun    `json:"moderuns,omitempty"`
```

- [ ] **Step 5: Run test to verify it passes**

Run: `go test ./pkg/reporadar/ -run 'TestValidRiskKind|TestRiskKindsGloballyUnique'`
Expected: PASS (both tests).

---

### Task 2: Per-mode behavior registry (`modes.go`)

Create the per-mode seams the lens plans extend: candidate selection, admissibility, and prompt framing. Plan 1 implements correctness (identical to today's behavior).

**Files:**
- Create: `pkg/reporadar/modes.go`
- Test: `pkg/reporadar/modes_test.go`

**Interfaces:**
- Consumes: `hasExplicitFailure` (`prepare.go:110`), `StrengthLimited` (`types.go`), `waveobj.RadarSignal`.
- Produces: `candidatesForMode(mode string, sigs []waveobj.RadarSignal) []waveobj.RadarSignal`; `admissibleForMode(mode string, supporting []waveobj.RadarSignal, strength string) bool`; `modeTaskLine(mode string) string`.

- [ ] **Step 1: Write the failing test**

Create `pkg/reporadar/modes_test.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package reporadar

import (
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func TestCandidatesForModeCorrectnessReturnsAll(t *testing.T) {
	sigs := []waveobj.RadarSignal{
		newSignal(CollectorGit, "commit:1", 1, []string{"a.go"}, "x", nil, ""),
		newSignal(CollectorStructure, "struct:no-test:b.go", 2, []string{"b.go"}, "y", nil, ""),
	}
	got := candidatesForMode(ModeCorrectness, sigs)
	if len(got) != len(sigs) {
		t.Fatalf("correctness selector must return all signals, got %d of %d", len(got), len(sigs))
	}
}

func TestAdmissibleForModeCorrectness(t *testing.T) {
	// one weak structure signal, no explicit failure => not admissible (today's rule).
	weak := []waveobj.RadarSignal{newSignal(CollectorStructure, "struct:no-test:b.go", 2, []string{"b.go"}, "y", nil, "")}
	if admissibleForMode(ModeCorrectness, weak, StrengthLimited) {
		t.Fatal("a single weak structure signal must be withheld for correctness")
	}
	// one runs signal (explicit failure) => admissible even at limited strength.
	fail := []waveobj.RadarSignal{newSignal(CollectorRuns, "run:1:phase:0", 2, []string{"b.go"}, "failed", nil, "")}
	if !admissibleForMode(ModeCorrectness, fail, StrengthLimited) {
		t.Fatal("an explicit failure must be admissible for correctness")
	}
}

func TestModeTaskLineDefaultsToCorrectness(t *testing.T) {
	if got := modeTaskLine(ModeCorrectness); got == "" {
		t.Fatal("correctness task line must be non-empty")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./pkg/reporadar/ -run 'TestCandidatesForMode|TestAdmissibleForMode|TestModeTaskLine'`
Expected: FAIL — `candidatesForMode` / `admissibleForMode` / `modeTaskLine` undefined.

- [ ] **Step 3: Create `modes.go`**

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package reporadar

import "github.com/wavetermdev/waveterm/pkg/waveobj"

// This file holds the per-mode seams a scan is parameterized by. Correctness is implemented here; the
// security and tech-debt lenses register their own selector / predicate / framing in their plans.

// candidatesForMode selects, from the shared signal pool, the signals a given mode should cluster over.
// Correctness clusters over every signal (its v1 behavior). A mode with no registered selector falls
// back to the full pool.
func candidatesForMode(mode string, sigs []waveobj.RadarSignal) []waveobj.RadarSignal {
	switch mode {
	case ModeCorrectness:
		return sigs
	default:
		return sigs
	}
}

// admissibleForMode is the per-mode admissibility gate applied after the shared validation checks
// (signals exist, files covered, subsystem resolves). It returns false to withhold a finding.
// Correctness reproduces today's rule: withhold a single weak signal with no explicit failure.
func admissibleForMode(mode string, supporting []waveobj.RadarSignal, strength string) bool {
	switch mode {
	case ModeCorrectness:
		return !(strength == StrengthLimited && !hasExplicitFailure(supporting))
	default:
		return !(strength == StrengthLimited && !hasExplicitFailure(supporting))
	}
}

// modeTaskLine is the mode-specific task framing spliced into the synthesis prompt. Lens plans add
// their cases; the default is the correctness framing.
func modeTaskLine(mode string) string {
	switch mode {
	default:
		return "propose correctness-risk hypotheses"
	}
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./pkg/reporadar/ -run 'TestCandidatesForMode|TestAdmissibleForMode|TestModeTaskLine'`
Expected: PASS.

---

### Task 3: Mode-parameterized validation (`validate.go`)

Make `validateFindings` mode-aware: gate on the mode's taxonomy, apply the mode's admissibility predicate, and stamp `Mode` on every finding.

**Files:**
- Modify: `pkg/reporadar/validate.go:40-93`
- Test: `pkg/reporadar/validate_test.go`

**Interfaces:**
- Consumes: `ValidRiskKind(mode, kind)` (Task 1), `admissibleForMode(mode, supporting, strength)` (Task 2).
- Produces: `validateFindings(projectPath, mode string, resp *SynthResponse, byID map[string]waveobj.RadarSignal) []waveobj.RadarFinding` (signature adds `mode`).

- [ ] **Step 1: Update the tests in `validate_test.go`**

In `pkg/reporadar/validate_test.go`, change the two `validateFindings` calls to pass `ModeCorrectness`:

- Line 30: `findings := validateFindings("/repos/pay", ModeCorrectness, resp, byID)`
- Line 56: `out := validateFindings("/repos/pay", ModeCorrectness, &SynthResponse{Findings: findings}, byID)`

Then add a new test asserting the mode is stamped and cross-mode kinds are rejected:

```go
func TestValidateStampsModeAndRejectsForeignKind(t *testing.T) {
	sigs := []waveobj.RadarSignal{
		newSignal(CollectorGit, "commit:1", 1, []string{"src/pay/a.ts"}, "x", nil, ""),
		newSignal(CollectorRuns, "run:1:phase:0", 2, []string{"src/pay/a.ts"}, "y", nil, ""),
		newSignal(CollectorTranscript, "tx:1", 3, []string{"src/pay/a.ts"}, "z", nil, ""),
	}
	byID := map[string]waveobj.RadarSignal{}
	for _, s := range sigs {
		byID[s.ID] = s
	}
	resp := &SynthResponse{Findings: []SynthFinding{
		{RiskKind: RiskTestCoverageGap, Risk: "ok", Why: "w", Severity: "high",
			SignalIDs: []string{sigs[0].ID, sigs[1].ID, sigs[2].ID}, Files: []string{"src/pay/a.ts"}, Mission: "m"},
	}}
	// validated under correctness: kept, and stamped correctness.
	got := validateFindings("/repos/pay", ModeCorrectness, resp, byID)
	if len(got) != 1 || got[0].Mode != ModeCorrectness {
		t.Fatalf("expected 1 finding stamped correctness, got %+v", got)
	}
	// the same correctness kind under a mode that does not own it: rejected.
	if out := validateFindings("/repos/pay", ModeSecurity, resp, byID); len(out) != 0 {
		t.Fatalf("a correctness kind must be rejected under the security mode, got %d", len(out))
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./pkg/reporadar/ -run 'TestValidate'`
Expected: FAIL — `validateFindings` still takes 3 args (compile error).

- [ ] **Step 3: Update `validateFindings`**

In `pkg/reporadar/validate.go`, change the signature and the two decision lines. New signature (line 40):

```go
func validateFindings(projectPath, mode string, resp *SynthResponse, byID map[string]waveobj.RadarSignal) []waveobj.RadarFinding {
```

Replace the kind check (line 44):

```go
		if !ValidRiskKind(mode, sf.RiskKind) {
			continue
		}
```

Replace the strength/admissibility check (lines 67-70) with:

```go
		strength := evidenceStrength(supporting)
		if !admissibleForMode(mode, supporting, strength) {
			continue // fails this mode's admissibility gate
		}
```

Add `Mode: mode,` to the `waveobj.RadarFinding{...}` literal (right after the `Group:` field, line 79):

```go
			Mode:          mode,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./pkg/reporadar/ -run 'TestValidate'`
Expected: PASS (all three validate tests).

---

### Task 4: Mode-parameterized synthesis (`synth.go`)

Scope the prompt to the mode's taxonomy and framing.

**Files:**
- Modify: `pkg/reporadar/synth.go:189-222`
- Test: `pkg/reporadar/synth_prompt_test.go`

**Interfaces:**
- Consumes: `RiskKindsByMode` (Task 1), `modeTaskLine(mode)` (Task 2).
- Produces: `buildSynthesisPrompt(projectName, mode string, groups []CandidateGroup) string`; `synthesize(ctx, projectName, mode string, groups []CandidateGroup, fn streamFn) (*SynthResponse, synthStream, error)` (both add `mode`).

- [ ] **Step 1: Update the test in `synth_prompt_test.go`**

Change the call at line 31 and keep the assertions:

```go
	p := buildSynthesisPrompt("payments-api", ModeCorrectness, groups)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./pkg/reporadar/ -run 'TestPromptContainsTaxonomyAndDelimiters'`
Expected: FAIL — `buildSynthesisPrompt` still takes 2 args (compile error).

- [ ] **Step 3: Update `synth.go`**

Change `buildSynthesisPrompt` (line 189). New signature and the two lines that reference the task framing and the taxonomy:

```go
func buildSynthesisPrompt(projectName, mode string, groups []CandidateGroup) string {
	var b strings.Builder
	b.WriteString("You are Repo Radar's clustering step. From the deterministic evidence below, ")
	b.WriteString(modeTaskLine(mode))
	b.WriteString(" for project ")
	b.WriteString(projectName)
	b.WriteString(".\n\nRules:\n")
	b.WriteString("- Only these risk kinds are allowed: " + strings.Join(RiskKindsByMode[mode], ", ") + ".\n")
```

(Leave the rest of the function — the evidence-citation rule, the JSON schema line, the untrusted-data delimiters, and the group rendering loop — unchanged.)

Change `synthesize` (line 211):

```go
func synthesize(ctx context.Context, projectName, mode string, groups []CandidateGroup, fn streamFn) (*SynthResponse, synthStream, error) {
	prompt := buildSynthesisPrompt(projectName, mode, groups)
	stream, err := runSonnetWith(ctx, prompt, fn)
	if err != nil {
		return nil, stream, err
	}
	resp, perr := parseSynthesisResponse(stream.resultText)
	if perr != nil {
		return nil, stream, perr
	}
	return resp, stream, nil
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./pkg/reporadar/ -run 'TestPromptContainsTaxonomyAndDelimiters'`
Expected: PASS.

---

### Task 5: Per-mode scan orchestration (`scan.go`)

Restructure the clustering half of the scan into a per-mode loop that records a `RadarModeRun` per mode, and refactor `finalizeFindings` to take already-validated findings + mode runs, aggregate status, and retain candidates on any lens failure.

**Files:**
- Modify: `pkg/reporadar/scan.go` (add `clusterModes` + `aggregateModeRuns`; rewrite `runScan` tail, `runClusterOnly`, and `finalizeFindings`)
- Test: `pkg/reporadar/scan_finalize_test.go`, `pkg/reporadar/cluster_test.go` (new)

**Interfaces:**
- Consumes: `candidatesForMode` (Task 2), `validateFindings(projectPath, mode, resp, byID)` (Task 3), `synthesize(ctx, projectName, mode, groups, fn)` (Task 4), `prepareCandidates` (`prepare.go:38`), `reconcile` (`lifecycle.go:25`), `waveobj.RadarModeRun` (Task 1).
- Produces: `clusterModes(ctx, projectName, projectPath string, signals []waveobj.RadarSignal, modes []string, fn streamFn) ([]waveobj.RadarFinding, []waveobj.RadarModeRun)`; `finalizeFindings(ctx, reportId string, validated []waveobj.RadarFinding, modeRuns []waveobj.RadarModeRun, candidates []waveobj.RadarSignal, partialSources []string)` (signature changed).

- [ ] **Step 1: Write the failing tests**

Create `pkg/reporadar/cluster_test.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package reporadar

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// fakeStreamCiting returns a stream that cites the given signal IDs + files as one valid finding.
func fakeStreamCiting(ids, files []string) streamFn {
	return func(ctx context.Context, prompt string) ([]string, error) {
		inner := SynthResponse{Findings: []SynthFinding{{
			RiskKind: RiskTestCoverageGap, Risk: "r", Why: "w", Severity: "high",
			SignalIDs: ids, Files: files, Mission: "m",
		}}}
		b, _ := json.Marshal(inner)
		return []string{
			`{"type":"system","subtype":"init","model":"claude-sonnet-x"}`,
			`{"type":"result","subtype":"success","result":` + jsonString(string(b)) + `,"usage":{"input_tokens":10,"output_tokens":5}}`,
		}, nil
	}
}

func TestClusterModesRecordsCompletedRun(t *testing.T) {
	sigs := []waveobj.RadarSignal{
		newSignal(CollectorGit, "commit:1", 1, []string{"src/pay/a.ts"}, "x", nil, ""),
		newSignal(CollectorRuns, "run:1:phase:0", 2, []string{"src/pay/a.ts"}, "y", nil, ""),
		newSignal(CollectorTranscript, "tx:1", 3, []string{"src/pay/a.ts"}, "z", nil, ""),
	}
	fn := fakeStreamCiting([]string{sigs[0].ID, sigs[1].ID, sigs[2].ID}, []string{"src/pay/a.ts"})
	findings, runs := clusterModes(context.Background(), "pay", "/repos/pay", sigs, V1Modes, fn)
	if len(runs) != 1 || runs[0].Mode != ModeCorrectness || runs[0].Status != ModeRunCompleted {
		t.Fatalf("want 1 completed correctness run, got %+v", runs)
	}
	if runs[0].ResolvedModel != "claude-sonnet-x" || runs[0].FindingCount != 1 {
		t.Fatalf("run metadata not recorded: %+v", runs[0])
	}
	if len(findings) != 1 || findings[0].Mode != ModeCorrectness {
		t.Fatalf("want 1 correctness finding, got %+v", findings)
	}
}

func TestClusterModesRecordsClusterFailure() {}

func TestClusterModesRecordsFailure(t *testing.T) {
	fn := func(ctx context.Context, prompt string) ([]string, error) { return nil, fmt.Errorf("boom") }
	findings, runs := clusterModes(context.Background(), "pay", "/repos/pay", nil, V1Modes, fn)
	if len(findings) != 0 {
		t.Fatalf("no findings expected on failure, got %d", len(findings))
	}
	if len(runs) != 1 || runs[0].Status != ModeRunClusterFailed || runs[0].ClusterError == "" {
		t.Fatalf("want a clustering-failed run with an error, got %+v", runs)
	}
}
```

(Delete the stray `func TestClusterModesRecordsClusterFailure() {}` line before running — it is a placeholder guard to remind you both success and failure are covered; the real cases are the two funcs around it.)

Update `pkg/reporadar/scan_finalize_test.go` for the new `finalizeFindings` signature — replace the whole file:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package reporadar

import (
	"context"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

func TestFinalizePersistsFindingsAndPrunes(t *testing.T) {
	ctx := context.Background()
	rpt, _ := wstore.CreateRadarReport(ctx, "pay", "/repos/pay")
	s1 := newSignal(CollectorGit, "commit:1", 100, []string{"src/coupons/validate.ts"}, "changed", nil, "")
	s2 := newSignal(CollectorRuns, "run:1:phase:0", 200, []string{"src/coupons/validate.ts"}, "failed", nil, "")
	s3 := newSignal(CollectorStructure, "struct:no-test:src/unrelated.ts", 50, []string{"src/unrelated.ts"}, "no test", nil, "")
	pool := []waveobj.RadarSignal{s1, s2, s3}
	wstore.UpdateRadarReport(ctx, rpt.OID, func(r *waveobj.RadarReport) { r.Candidates = pool })
	byID := map[string]waveobj.RadarSignal{s1.ID: s1, s2.ID: s2, s3.ID: s3}
	resp := &SynthResponse{Findings: []SynthFinding{{
		RiskKind: RiskTestCoverageGap, Risk: "coupon branches uncovered", Why: "w", Severity: "high",
		SignalIDs: []string{s1.ID, s2.ID}, Files: []string{"src/coupons/validate.ts"}, Mission: "add tests",
	}}}
	validated := validateFindings("/repos/pay", ModeCorrectness, resp, byID)
	runs := []waveobj.RadarModeRun{{Mode: ModeCorrectness, Status: ModeRunCompleted, ResolvedModel: "claude-sonnet-x"}}
	finalizeFindings(ctx, rpt.OID, validated, runs, pool, nil)

	got, _ := wstore.GetRadarReport(ctx, rpt.OID)
	if got.Status != StatusCompleted {
		t.Fatalf("want completed, got %q", got.Status)
	}
	if len(got.Findings) != 1 || got.Findings[0].Group != GroupNew {
		t.Fatalf("expected 1 new finding, got %+v", got.Findings)
	}
	if len(got.ModeRuns) != 1 || got.ModeRuns[0].Status != ModeRunCompleted {
		t.Fatalf("expected 1 completed mode run, got %+v", got.ModeRuns)
	}
	if len(got.Candidates) != 0 {
		t.Fatalf("candidates should be pruned after success, got %d", len(got.Candidates))
	}
	if len(got.Signals) != 2 {
		t.Fatalf("expected 2 referenced signals retained, got %d", len(got.Signals))
	}
}

func TestFinalizeRetainsCandidatesOnClusterFailure(t *testing.T) {
	ctx := context.Background()
	rpt, _ := wstore.CreateRadarReport(ctx, "pay", "/repos/pay")
	s1 := newSignal(CollectorGit, "commit:1", 100, []string{"src/coupons/validate.ts"}, "changed", nil, "")
	pool := []waveobj.RadarSignal{s1}
	wstore.UpdateRadarReport(ctx, rpt.OID, func(r *waveobj.RadarReport) { r.Candidates = pool })
	runs := []waveobj.RadarModeRun{{Mode: ModeCorrectness, Status: ModeRunClusterFailed, ClusterError: "boom"}}
	finalizeFindings(ctx, rpt.OID, nil, runs, pool, nil)

	got, _ := wstore.GetRadarReport(ctx, rpt.OID)
	if got.Status != StatusFailed {
		t.Fatalf("all-lenses-failed must be failed, got %q", got.Status)
	}
	if len(got.Candidates) != 1 {
		t.Fatalf("candidates must be retained for retry on failure, got %d", len(got.Candidates))
	}
	if got.ClusterError == "" {
		t.Fatalf("aggregate cluster error must be recorded")
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./pkg/reporadar/ -run 'TestClusterModes|TestFinalize'`
Expected: FAIL — `clusterModes` undefined; `finalizeFindings` old signature (compile error).

- [ ] **Step 3: Add `clusterModes` + `aggregateModeRuns` and rewrite `finalizeFindings`, `runScan`, `runClusterOnly`**

In `pkg/reporadar/scan.go`, add `"strings"` to the import block. Add these two functions (place them just above `finalizeFindings`):

```go
// clusterModes runs each scan mode over the shared signal pool: it selects that mode's candidates,
// prepares + synthesizes + validates them, and returns the merged validated findings plus one
// RadarModeRun per mode. A mode whose synthesis fails is recorded clustering-failed and skipped; the
// loop continues so other lenses still deliver.
func clusterModes(ctx context.Context, projectName, projectPath string, signals []waveobj.RadarSignal, modes []string, fn streamFn) ([]waveobj.RadarFinding, []waveobj.RadarModeRun) {
	var merged []waveobj.RadarFinding
	var runs []waveobj.RadarModeRun
	for _, mode := range modes {
		if ctx.Err() != nil {
			return merged, runs
		}
		cand := candidatesForMode(mode, signals)
		groups, payloadTokens := prepareCandidates(cand, DefaultRadarPayloadBudget)
		run := waveobj.RadarModeRun{Mode: mode, PayloadTokens: payloadTokens}
		resp, stream, serr := synthesize(ctx, projectName, mode, groups, fn)
		if serr != nil {
			if ctx.Err() != nil {
				return merged, runs
			}
			run.Status = ModeRunClusterFailed
			run.ClusterError = serr.Error()
			runs = append(runs, run)
			continue
		}
		byID := map[string]waveobj.RadarSignal{}
		for _, s := range cand {
			byID[s.ID] = s
		}
		validated := validateFindings(projectPath, mode, resp, byID)
		run.Status = ModeRunCompleted
		run.ResolvedModel = stream.modelID
		run.TotalTokens = stream.totalTokens
		run.TokensEstimated = !stream.haveUsage
		run.FindingCount = len(validated)
		runs = append(runs, run)
		merged = append(merged, validated...)
	}
	return merged, runs
}

type modeRunAgg struct {
	anyFailed     bool
	allFailed     bool
	estimated     bool
	clusterErr    string
	resolvedModel string
	payloadTokens int
	totalTokens   int
}

// aggregateModeRuns folds per-mode runs into the report's scan-wide fields.
func aggregateModeRuns(runs []waveobj.RadarModeRun) modeRunAgg {
	agg := modeRunAgg{allFailed: len(runs) > 0}
	var errs []string
	for _, r := range runs {
		agg.payloadTokens += r.PayloadTokens
		agg.totalTokens += r.TotalTokens
		if r.TokensEstimated {
			agg.estimated = true
		}
		if r.Status == ModeRunCompleted {
			agg.allFailed = false
			if agg.resolvedModel == "" {
				agg.resolvedModel = r.ResolvedModel
			}
		} else {
			agg.anyFailed = true
			if r.ClusterError != "" {
				errs = append(errs, r.Mode+": "+r.ClusterError)
			}
		}
	}
	agg.clusterErr = strings.Join(errs, "; ")
	return agg
}
```

Replace `finalizeFindings` (the whole function, lines 236-302) with:

```go
// finalizeFindings reconciles the merged validated findings against the previous successful report,
// prunes candidates to referenced signals, folds per-mode runs into the scan-wide status, and
// persists. It retains the candidate pool whenever any lens failed to cluster so Retry can reuse it.
func finalizeFindings(ctx context.Context, reportId string, validated []waveobj.RadarFinding, modeRuns []waveobj.RadarModeRun, candidates []waveobj.RadarSignal, partialSources []string) {
	rpt, err := wstore.GetRadarReport(ctx, reportId)
	if err != nil {
		log.Printf("reporadar: finalize load %s: %v", reportId, err)
		return
	}
	byID := map[string]waveobj.RadarSignal{}
	for _, s := range candidates {
		byID[s.ID] = s
	}

	evidenceTs := map[string]int64{}
	for _, f := range validated {
		var max int64
		for _, id := range f.SignalIDs {
			if s, ok := byID[id]; ok && s.ObservedTs > max {
				max = s.ObservedTs
			}
		}
		evidenceTs[f.Fingerprint] = max
	}

	prev := latestSuccessfulExcluding(ctx, rpt.ProjectPath, reportId)
	reconciled := reconcile(rpt.ProjectPath, validated, prev, evidenceTs)

	refIDs := map[string]bool{}
	for _, f := range reconciled {
		for _, id := range f.SignalIDs {
			refIDs[id] = true
		}
	}
	var kept []waveobj.RadarSignal
	for _, s := range candidates {
		if refIDs[s.ID] {
			kept = append(kept, s)
		}
	}

	agg := aggregateModeRuns(modeRuns)
	status := StatusCompleted
	if len(partialSources) > 0 || agg.anyFailed {
		status = StatusPartial
	}
	if agg.allFailed {
		status = StatusFailed
	}

	endHead, _ := gitHead(ctx, rpt.ProjectPath)
	endDirty := gitDirtyFingerprint(ctx, rpt.ProjectPath)
	if status != StatusFailed && ((rpt.StartHead != "" && endHead != "" && rpt.StartHead != endHead) || rpt.StartDirty != endDirty) {
		status = StatusPartial
		partialSources = appendUnique(partialSources, "repository-changed")
	}
	wstore.UpdateRadarReport(ctx, reportId, func(r *waveobj.RadarReport) {
		r.Findings = reconciled
		r.Signals = kept
		r.ModeRuns = modeRuns
		r.PartialSources = partialSources
		r.ConfiguredModel = ConfiguredRadarModel
		r.ResolvedModel = agg.resolvedModel
		r.PayloadTokens = agg.payloadTokens
		r.TotalTokens = agg.totalTokens
		r.TotalTokensEstimated = agg.estimated
		r.ClusterError = agg.clusterErr
		r.EndHead = endHead
		r.EndDirty = endDirty
		r.WindowEndTs = nowMilli()
		r.Status = status
		r.Phase = ""
		r.CompletedTs = nowMilli()
		if !agg.anyFailed {
			r.Candidates = nil // prune only when every lens succeeded
		}
	})
	publish(reportId)
}
```

Replace the tail of `runScan` (lines 132-160, i.e. from the `groups, payloadTokens := prepareCandidates(...)` block through the `finalizeFindings(...)` call) with:

```go
	setStatus(ctx, reportId, StatusClustering, "clustering")
	if ctx.Err() != nil {
		finishCancelled(ctx, reportId)
		return
	}

	findings, modeRuns := clusterModes(ctx, rpt.ProjectName, rpt.ProjectPath, cr.signals, V1Modes, synthStreamFn)
	if ctx.Err() != nil {
		finishCancelled(ctx, reportId)
		return
	}
	finalizeFindings(ctx, reportId, findings, modeRuns, cr.signals, cr.partialSources)
```

Replace `runClusterOnly` (lines 169-194) with:

```go
func runClusterOnly(ctx context.Context, reportId string) {
	rpt, err := wstore.GetRadarReport(ctx, reportId)
	if err != nil || len(rpt.Candidates) == 0 {
		finishClusterFailed(reportId, "no retained candidates")
		return
	}
	setStatus(ctx, reportId, StatusClustering, "clustering")
	findings, modeRuns := clusterModes(ctx, rpt.ProjectName, rpt.ProjectPath, rpt.Candidates, V1Modes, synthStreamFn)
	if ctx.Err() != nil {
		finishCancelled(ctx, reportId)
		return
	}
	finalizeFindings(ctx, reportId, findings, modeRuns, rpt.Candidates, rpt.PartialSources)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./pkg/reporadar/ -run 'TestClusterModes|TestFinalize'`
Expected: PASS.

- [ ] **Step 5: Run the whole package to confirm no regression**

Run: `go test ./pkg/reporadar/`
Expected: PASS — including the untouched `TestAcceptanceFullScan` and `TestAcceptanceSecondScanReclassifies` (the correctness selector returns all signals, so the payload and findings are identical to before; `ResolvedModel` is still `claude-sonnet-x` via the aggregate).

---

### Task 6: Regenerate bindings + build backend

Regenerate the TS type bindings for the new waveobj fields and confirm the backend builds and the whole package is green. Deliverable: `task generate` is clean, `frontend/types/gotypes.d.ts` gains `RadarFinding.mode` and `RadarReport.moderuns` + `RadarModeRun`, backend builds, tsc is clean.

**Files:**
- Modify (generated — via `task generate`, do NOT hand-edit): `frontend/types/gotypes.d.ts`, `frontend/app/store/wshclientapi.ts` (if touched)

- [ ] **Step 1: Regenerate**

Run: `task generate`
Expected: exits 0. Confirm the generated types updated:

Run: `grep -n "mode\|RadarModeRun\|moderuns" frontend/types/gotypes.d.ts`
Expected: `RadarFinding` has `mode?: string`; a `RadarModeRun` type exists; `RadarReport` has `moderuns?: RadarModeRun[]`.

- [ ] **Step 2: Build the backend**

Run: `task build:backend`
Expected: exits 0 (builds `wavesrv` + `wsh`).

- [ ] **Step 3: Full backend test + typecheck**

Run: `go test ./pkg/reporadar/ ./pkg/waveobj/`
Expected: PASS.

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exits 0 (baseline clean — the new generated fields introduce no type errors yet; the frontend consumes them in Task 7).

---

### Task 7: Frontend pure model layer

Add the mode-aware pure helpers and presentational tokens the surface will consume in Plan 2. No surface wiring yet — these are unit-tested pure functions.

**Files:**
- Modify: `frontend/app/view/agents/radarmodel.ts`
- Modify: `frontend/app/view/agents/radarstyles.ts`
- Test: `frontend/app/view/agents/radarmodel.test.ts`

**Interfaces:**
- Consumes: generated `RadarFinding.mode` (Task 6).
- Produces: `RadarMode` type; `MODE_ORDER`; `MODE_META`; `findingMode(f)`; `modeFilterOptions(findings)`; `filterByMode(findings, mode)`; `modeBadge(mode)`.

- [ ] **Step 1: Write the failing tests**

Add to `frontend/app/view/agents/radarmodel.test.ts` (import the new symbols from `./radarmodel` alongside the existing imports):

```ts
import { findingMode, filterByMode, modeFilterOptions } from "./radarmodel";

describe("radar modes", () => {
    test("findingMode defaults empty/unknown to correctness", () => {
        expect(findingMode({ mode: "" } as RadarFinding)).toBe("correctness");
        expect(findingMode({ mode: "security" } as RadarFinding)).toBe("security");
        expect(findingMode({ mode: "bogus" } as RadarFinding)).toBe("correctness");
        expect(findingMode({} as RadarFinding)).toBe("correctness");
    });

    test("filterByMode passes all or filters to one mode", () => {
        const fs = [{ mode: "correctness" }, { mode: "security" }] as RadarFinding[];
        expect(filterByMode(fs, "all")).toHaveLength(2);
        expect(filterByMode(fs, "security")).toHaveLength(1);
    });

    test("modeFilterOptions returns present modes in canonical order", () => {
        const fs = [{ mode: "debt" }, { mode: "correctness" }] as RadarFinding[];
        expect(modeFilterOptions(fs)).toEqual(["correctness", "debt"]);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run frontend/app/view/agents/radarmodel.test.ts`
Expected: FAIL — `findingMode` / `filterByMode` / `modeFilterOptions` are not exported.

- [ ] **Step 3: Add the pure helpers to `radarmodel.ts`**

Append to `frontend/app/view/agents/radarmodel.ts`:

```ts
export type RadarMode = "correctness" | "security" | "debt";

export const MODE_ORDER: RadarMode[] = ["correctness", "security", "debt"];

const KNOWN_MODES = new Set<string>(MODE_ORDER);

export interface ModeMeta {
    label: string;
    short: string;
}

export const MODE_META: Record<RadarMode, ModeMeta> = {
    correctness: { label: "Correctness", short: "Corr" },
    security: { label: "Security", short: "Sec" },
    debt: { label: "Tech-debt", short: "Debt" },
};

// findingMode reads a finding's mode, defaulting empty/unknown to correctness (reports written before
// the multi-mode change carry no mode).
export function findingMode(f: RadarFinding): RadarMode {
    const m = f.mode;
    return (m && KNOWN_MODES.has(m) ? m : "correctness") as RadarMode;
}

// modeFilterOptions returns the distinct modes present among findings, in canonical order — the set
// the surface's filter chips render.
export function modeFilterOptions(findings: RadarFinding[]): RadarMode[] {
    const present = new Set((findings ?? []).map(findingMode));
    return MODE_ORDER.filter((m) => present.has(m));
}

export function filterByMode(findings: RadarFinding[], mode: RadarMode | "all"): RadarFinding[] {
    return mode === "all" ? (findings ?? []) : (findings ?? []).filter((f) => findingMode(f) === mode);
}
```

- [ ] **Step 4: Add the badge token map to `radarstyles.ts`**

Append to `frontend/app/view/agents/radarstyles.ts`:

```ts
import type { RadarMode } from "./radarmodel";

// Mode → badge classes (border + faint fill + text), all @theme tokens. Correctness reuses the
// surface's existing accent-soft treatment; security/debt reuse error/warning tones.
export const MODE_BADGE: Record<RadarMode, string> = {
    correctness: "border-accent/25 bg-accent/10 text-accent-soft",
    security: "border-error/25 bg-error/10 text-error",
    debt: "border-warning/25 bg-warning/10 text-warning",
};

export function modeBadge(mode: RadarMode): string {
    return MODE_BADGE[mode] ?? MODE_BADGE.correctness;
}
```

(Merge the `import type { RadarMode }` with the existing `import type { RadarTone } from "./radarmodel";` line at the top of the file: `import type { RadarMode, RadarTone } from "./radarmodel";`.)

- [ ] **Step 5: Run test + typecheck to verify they pass**

Run: `npx vitest run frontend/app/view/agents/radarmodel.test.ts`
Expected: PASS.

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exits 0.

---

## Integration verification (after all tasks)

Run the full gate before handing back:

- `go test ./pkg/reporadar/ ./pkg/waveobj/` → PASS
- `npx vitest run frontend/app/view/agents/` → PASS
- `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` → exit 0
- `task build:backend` → exit 0

Do not commit. Report status to the user; the feature is committed once at the end with approval, and the spec doc folds into that commit.

## Self-Review

**Spec coverage (Plan 1 subset):** Mode dimension (§Architecture "Mode as a first-class dimension") → Task 1. Per-mode validate + admissibility seam (§"Taxonomies and the trust gate") → Tasks 2, 3. Mode-parameterized synth (§Synthesis) → Task 4. Collect-once / per-mode synth / per-mode `RadarModeRun` / graceful degradation / aggregate status / retain-on-failure (§"Scan orchestration", §"Per-mode graceful degradation") → Task 5. Additive data model, no migration, `task generate` (§"Data model") → Tasks 1, 6. Frontend mode model (§"Frontend integration", pure-model portion) → Task 7. **Deferred to Plans 2/3 (out of scope here, intentionally):** security + tech-debt collectors/taxonomies/admissibility/candidate-selectors; surface mode chips, per-row badges, and per-lens error banner; the per-lens retry optimization. `V1Modes` stays `{correctness}` until a lens plan appends to it, so no security/debt code path is reachable in Plan 1.

**Placeholder scan:** No "TBD/handle errors/similar-to". The one intentional placeholder — `func TestClusterModesRecordsClusterFailure() {}` in Task 5 Step 1 — is explicitly called out with a delete instruction in the same step.

**Type consistency:** `validateFindings(projectPath, mode, resp, byID)` — defined Task 3, called with `mode` in Tasks 3 & 5. `synthesize(ctx, projectName, mode, groups, fn)` / `buildSynthesisPrompt(projectName, mode, groups)` — defined Task 4, called in Task 5's `clusterModes`. `finalizeFindings(ctx, reportId, validated, modeRuns, candidates, partialSources)` — defined Task 5, called in `runScan`/`runClusterOnly` (Task 5) and the tests (Task 5 Step 1). `RadarModeRun` fields (`Mode/Status/ClusterError/PayloadTokens/TotalTokens/TokensEstimated/ResolvedModel/FindingCount`) — defined Task 1, consumed in Task 5's `clusterModes`/`aggregateModeRuns`/`finalizeFindings`. `findingMode`/`filterByMode`/`modeFilterOptions`/`modeBadge` — defined Task 7, tested Task 7. `ModeRunCompleted`/`ModeRunClusterFailed` used consistently across Tasks 1 & 5.
