# Radar Multi-Mode — Plan 2: Security Lens Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the security lens as the second mode on the pipeline Plan 1 built — its taxonomy, three evidence collectors (boundary classification, dependency-manifest pins, config-security facts), a deterministic admissibility gate, and the shared surface treatment (mode filter chips, per-row badges, per-lens error banner) that a second lens finally makes visible.

**Architecture:** The security lens plugs into the Plan 1 seams. Collection stays single-pass: three new deterministic facts (a structure `security-boundary` tag per security-relevant path, a `dependency` collector emitting floating-pin facts on security-relevant npm packages, and config-security facts on the config collector) join the shared pool. `candidatesForMode(ModeSecurity)` selects the security-classified signals plus the churn/failure signals that can be their consequence; `admissibleForMode(ModeSecurity)` withholds any finding that lacks **both** a security-boundary classification **and** a consequence signal (a config-security or dependency-pin fact counts as both — it is self-sufficient). `ModeSecurity` is appended to `V1Modes` only in the final backend task, so every step before it keeps the correctness scan byte-for-byte unchanged.

**Tech Stack:** Go (`pkg/reporadar`), React/TS (`frontend/app/view/agents`), vitest, Go test. No codegen, no DB migration.

## Global Constraints

- **No new persisted fields → no `task generate`, no migration.** Plan 2 reuses `RadarFinding.Mode`, `RadarSignal.Facts` (`map[string]any`), and `RadarReport.ModeRuns` — all added by Plan 1. It adds only Go-internal constants and a new collector-coverage key (a plain string). Do NOT touch `pkg/waveobj/wtype.go` or any generated file.
- **Fingerprint stays 3-arg** — `fingerprint(projectPath, riskKind, subsystem)` is unchanged. Mode is never hashed.
- **Risk-kind names are globally unique across modes** — the four new security kinds must not collide with the correctness kinds. Guarded automatically by the existing `TestRiskKindsGloballyUnique` (Plan 1) once they are added to `RiskKindsByMode`.
- **`V1Modes` grows LAST.** Append `ModeSecurity` to `V1Modes` only in Task 7. Until then the taxonomy, collectors, and lens logic exist but no scan runs the security mode, so `TestAcceptanceFullScan` / `TestAcceptanceSecondScanReclassifies` stay green at every checkpoint.
- **Collectors: read-only, offline, bounded, secret-redacting.** New collectors read tracked text files from disk (bounded to 512 KB each), parse them deterministically, and emit **facts only** — never a CVE lookup, registry call, or network request. Version strings and config-issue labels are structural; no raw config line is persisted (no snippets on security facts), so no secret can leak.
- **Deterministic output.** Map iteration order is nondeterministic — sort dependency names before emitting so the payload is stable run-to-run.
- **`Facts["classes"]` is `[]string` in-memory but `[]any` after a DB round-trip.** The retry path (`runClusterOnly`) reloads candidates from SQLite, so the classification helper MUST accept both. This is load-bearing — a `[]string`-only type assertion silently drops every classification on retry.
- **Typecheck command:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (bare `npx tsc` stack-overflows here; baseline is clean, exit 0 — any error it reports is yours).
- **Frontend colors:** Tailwind `@theme` tokens only (`text-error`, `text-warning`, `bg-*/NN`, …); never raw hex/rgba. The mode badge tokens already exist (`radarstyles.ts`, added in Plan 1).
- **Git:** Do NOT commit per task. This repo batches all changes into one commit at the end, made only with explicit user approval; the design spec (`docs/superpowers/specs/2026-07-21-radar-multi-mode-design.md`) folds into that feature commit. Each task below ends at "tests green," not at a commit.

**Scope note:** This is Plan 2 of 3 from the design spec. It adds only the security lens plus the shared surface treatment deferred to it by Plan 1. Tech-debt (Plan 3) reuses the same seams. **Deliberately narrowed vs. the spec (documented, not silent):** the dependency collector implements `package.json` floating-pin facts only — `go.mod` is pinned by design (no floating pins to emit) and Cargo.toml + registry-staleness detection are deferred (staleness needs a network call, which violates the offline rule; Cargo needs a TOML-parser dependency). Per-lens *retry* (retry only the failed lens) stays deferred too: the error banner re-runs the existing `RetryRadarClusteringCommand`, which re-clusters every lens from the retained candidates.

---

### Task 1: Security taxonomy scaffolding

Register the security kinds, the shared fact-class constants, and the new collector key. No behavior changes yet — `V1Modes` is untouched, so no scan runs the security mode.

**Files:**
- Modify: `pkg/reporadar/types.go`
- Test: `pkg/reporadar/types_test.go`

**Interfaces:**
- Produces: `RiskAuthBoundaryFragility` / `RiskSecretHandlingBoundaryRisk` / `RiskInputValidationGap` / `RiskDependencyExposure` consts; `V1SecurityRiskKinds []string`; `RiskKindsByMode[ModeSecurity]`; `CollectorDependency` const; `ClassSecurityBoundary` / `ClassConfigSecurity` / `ClassDependencyPin` fact-class consts.

- [ ] **Step 1: Update the tests in `types_test.go`**

Add these two tests to `pkg/reporadar/types_test.go` (keep the existing `TestValidRiskKind` and `TestRiskKindsGloballyUnique`):

```go
func TestSecurityRiskKindsValid(t *testing.T) {
	for _, k := range V1SecurityRiskKinds {
		if !ValidRiskKind(ModeSecurity, k) {
			t.Fatalf("security kind %q should be valid under ModeSecurity", k)
		}
		if ValidRiskKind(ModeCorrectness, k) {
			t.Fatalf("security kind %q must be rejected under ModeCorrectness", k)
		}
	}
	if len(V1SecurityRiskKinds) != 4 {
		t.Fatalf("expected 4 security risk kinds, got %d", len(V1SecurityRiskKinds))
	}
}

func TestFactClassConstantsDistinct(t *testing.T) {
	// the dependency-pin fact class must NOT reuse the dependency-exposure risk-kind string, so the
	// two namespaces stay independent.
	if ClassDependencyPin == RiskDependencyExposure {
		t.Fatal("dependency-pin fact class must differ from the dependency-exposure risk kind")
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go test ./pkg/reporadar/ -run 'TestSecurityRiskKindsValid|TestFactClassConstantsDistinct'`
Expected: FAIL — `V1SecurityRiskKinds` / `RiskAuthBoundaryFragility` / `ClassDependencyPin` undefined (compile error).

- [ ] **Step 3: Add the security taxonomy to `types.go`**

Add `CollectorDependency` to the collector const block (after `CollectorConfig`):

```go
	CollectorConfig     = "config"
	CollectorDependency = "dependency"
```

Add the security taxonomy immediately after the `V1RiskKinds` var (after line 75):

```go
// v1 security-risk taxonomy (globally unique vs. the correctness kinds — see TestRiskKindsGloballyUnique)
const (
	RiskAuthBoundaryFragility      = "auth-boundary-fragility"
	RiskSecretHandlingBoundaryRisk = "secret-handling-boundary-risk"
	RiskInputValidationGap         = "input-validation-gap"
	RiskDependencyExposure         = "dependency-exposure"
)

var V1SecurityRiskKinds = []string{
	RiskAuthBoundaryFragility, RiskSecretHandlingBoundaryRisk,
	RiskInputValidationGap, RiskDependencyExposure,
}

// signal fact-class tags (RadarSignal.Facts["classes"]). Distinct from risk kinds: a class labels
// evidence, a risk kind labels a finding. ClassDependencyPin intentionally does NOT reuse the
// dependency-exposure risk-kind string.
const (
	ClassSecurityBoundary = "security-boundary"
	ClassConfigSecurity   = "config-security"
	ClassDependencyPin    = "dependency-pin"
)
```

Add the `ModeSecurity` entry to `RiskKindsByMode` (it currently has only `ModeCorrectness`):

```go
var RiskKindsByMode = map[string][]string{
	ModeCorrectness: V1RiskKinds,
	ModeSecurity:    V1SecurityRiskKinds,
}
```

**Do NOT change `V1Modes`** — it stays `[]string{ModeCorrectness}` until Task 7.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `go test ./pkg/reporadar/ -run 'TestSecurityRiskKindsValid|TestFactClassConstantsDistinct|TestValidRiskKind|TestRiskKindsGloballyUnique'`
Expected: PASS (all four — `TestRiskKindsGloballyUnique` now checks 10 kinds across two modes and confirms no collision).

---

### Task 2: Security classification helpers (`security.go`)

Create the pure, deterministic classifiers every collector and the lens logic consume: which signals are security-classified, which are consequences, how a path maps to a boundary kind, which dependency names are security-relevant, which version spec is floating, and a bounded file reader.

**Files:**
- Create: `pkg/reporadar/security.go`
- Test: `pkg/reporadar/security_test.go`

**Interfaces:**
- Consumes: `waveobj.RadarSignal`; collector + class consts (Task 1).
- Produces: `factClasses(s) []string`; `hasClass(s, class) bool`; `isSecurityClassified(s) bool`; `isSecurityConsequence(s) bool`; `securityBoundaryKind(path) string`; `securityRelevantDep(name) bool`; `isFloatingSpec(spec) bool`; `readBoundedFile(projectPath, rel) (string, bool)`.

- [ ] **Step 1: Write the failing tests**

Create `pkg/reporadar/security_test.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package reporadar

import (
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func TestFactClassesToleratesDBRoundTrip(t *testing.T) {
	inMem := waveobj.RadarSignal{Facts: map[string]any{"classes": []string{ClassSecurityBoundary}}}
	if !hasClass(inMem, ClassSecurityBoundary) {
		t.Fatal("in-memory []string classes must be readable")
	}
	// after a JSON/DB round-trip, classes arrive as []any — the helper must still read them.
	roundTripped := waveobj.RadarSignal{Facts: map[string]any{"classes": []any{ClassDependencyPin}}}
	if !hasClass(roundTripped, ClassDependencyPin) {
		t.Fatal("[]any classes (DB round-trip) must be readable")
	}
	if hasClass(inMem, ClassConfigSecurity) {
		t.Fatal("absent class must not match")
	}
}

func TestSecurityClassifiedAndConsequence(t *testing.T) {
	boundary := waveobj.RadarSignal{Collector: CollectorStructure, Facts: map[string]any{"classes": []string{ClassSecurityBoundary}}}
	dep := waveobj.RadarSignal{Collector: CollectorDependency, Facts: map[string]any{"classes": []string{ClassDependencyPin}}}
	cfg := waveobj.RadarSignal{Collector: CollectorConfig, Facts: map[string]any{"classes": []string{ClassConfigSecurity}}}
	churn := waveobj.RadarSignal{Collector: CollectorGit}
	noise := waveobj.RadarSignal{Collector: CollectorStructure, Facts: map[string]any{"classes": []string{"source-without-test"}}}

	// classified: the three security facts; NOT churn or a plain no-test structure fact.
	for _, s := range []waveobj.RadarSignal{boundary, dep, cfg} {
		if !isSecurityClassified(s) {
			t.Fatalf("%s/%v should be security-classified", s.Collector, s.Facts)
		}
	}
	for _, s := range []waveobj.RadarSignal{churn, noise} {
		if isSecurityClassified(s) {
			t.Fatalf("%s/%v must NOT be security-classified", s.Collector, s.Facts)
		}
	}
	// consequence: churn (git) + the self-sufficient facts (config/dep); NOT a structure boundary alone.
	if !isSecurityConsequence(churn) || !isSecurityConsequence(dep) || !isSecurityConsequence(cfg) {
		t.Fatal("git churn and config/dep facts must be consequences")
	}
	if isSecurityConsequence(boundary) {
		t.Fatal("a structure security-boundary alone is NOT a consequence")
	}
}

func TestSecurityBoundaryKind(t *testing.T) {
	cases := map[string]string{
		"src/auth/session.ts":     "auth",
		"internal/login/jwt.go":   "auth",
		"pkg/secretstore/vault.go": "secret",
		"src/api/validate.ts":     "input",
		"src/util/format.ts":      "",
	}
	for p, want := range cases {
		if got := securityBoundaryKind(p); got != want {
			t.Fatalf("securityBoundaryKind(%q) = %q, want %q", p, got, want)
		}
	}
}

func TestSecurityRelevantDepAndFloatingSpec(t *testing.T) {
	if !securityRelevantDep("jsonwebtoken") || !securityRelevantDep("passport-oauth") || securityRelevantDep("lodash") {
		t.Fatal("security-relevant dependency detection wrong")
	}
	floating := []string{"^9.0.0", "~1.2.0", "*", "latest", "1.x", ">=2.0.0"}
	pinned := []string{"9.0.0", "1.2.3", "git+https://x/y.git", "workspace:*"}
	for _, s := range floating {
		if !isFloatingSpec(s) {
			t.Fatalf("%q should be floating", s)
		}
	}
	for _, s := range pinned {
		if isFloatingSpec(s) {
			t.Fatalf("%q should be pinned/skipped", s)
		}
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go test ./pkg/reporadar/ -run 'TestFactClasses|TestSecurityClassified|TestSecurityBoundaryKind|TestSecurityRelevantDep'`
Expected: FAIL — `hasClass` / `isSecurityClassified` / `securityBoundaryKind` / `securityRelevantDep` / `isFloatingSpec` undefined.

- [ ] **Step 3: Create `security.go`**

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package reporadar

import (
	"os"
	"path/filepath"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// This file holds the deterministic security classifiers shared by the security collectors and the
// security lens (modes.go). Everything here is pure path/string logic — no repo access except the
// bounded file reader, which reads a single tracked text file.

// factClasses reads a signal's fact classes tolerantly: []string in-memory, []any after a DB round-trip
// (SQLite -> JSON -> map[string]any). A []string-only assertion would silently drop every classification
// on the retry path (runClusterOnly reloads candidates from the store).
func factClasses(s waveobj.RadarSignal) []string {
	raw, ok := s.Facts["classes"]
	if !ok {
		return nil
	}
	switch v := raw.(type) {
	case []string:
		return v
	case []any:
		out := make([]string, 0, len(v))
		for _, e := range v {
			if str, ok := e.(string); ok {
				out = append(out, str)
			}
		}
		return out
	}
	return nil
}

func hasClass(s waveobj.RadarSignal, class string) bool {
	for _, c := range factClasses(s) {
		if c == class {
			return true
		}
	}
	return false
}

// isSecurityClassified reports whether Radar tagged this signal as a security boundary or a
// self-sufficient security fact (config-security / dependency-pin).
func isSecurityClassified(s waveobj.RadarSignal) bool {
	return hasClass(s, ClassSecurityBoundary) || hasClass(s, ClassConfigSecurity) || hasClass(s, ClassDependencyPin)
}

// isSecurityConsequence reports whether this signal is evidence of fragility AT a boundary: a
// churn/failure signal (git/runs/transcript) or a self-sufficient security fact. A structure
// security-boundary tag alone is NOT a consequence — a boundary that never changed and never failed
// is not fragile.
func isSecurityConsequence(s waveobj.RadarSignal) bool {
	switch s.Collector {
	case CollectorGit, CollectorRuns, CollectorTranscript:
		return true
	}
	return hasClass(s, ClassConfigSecurity) || hasClass(s, ClassDependencyPin)
}

// securityBoundaryKind maps a path to a security-boundary category via deterministic name heuristics,
// or "" when the path is not security-relevant. Order matters: auth wins over secret wins over input.
func securityBoundaryKind(p string) string {
	lp := strings.ToLower(strings.ReplaceAll(p, "\\", "/"))
	for _, m := range authMarkers {
		if strings.Contains(lp, m) {
			return "auth"
		}
	}
	for _, m := range secretMarkers {
		if strings.Contains(lp, m) {
			return "secret"
		}
	}
	for _, m := range inputMarkers {
		if strings.Contains(lp, m) {
			return "input"
		}
	}
	return ""
}

var authMarkers = []string{"auth", "session", "login", "permission", "rbac", "oauth", "jwt", "/acl"}
var secretMarkers = []string{"secret", "credential", "keystore", "crypto", "encrypt", "vault"}
var inputMarkers = []string{"validate", "sanitize", "deserialize", "webhook", "upload", "graphql"}

var securityDepMarkers = []string{"auth", "jwt", "jsonwebtoken", "passport", "oauth", "bcrypt", "crypto", "session", "cors", "helmet", "sanitize", "csrf", "cookie", "openssl", "tls"}

// securityRelevantDep reports whether a dependency name looks security-relevant (deterministic
// substring match). Keeps the dependency lens focused and its signal count bounded.
func securityRelevantDep(name string) bool {
	n := strings.ToLower(name)
	for _, m := range securityDepMarkers {
		if strings.Contains(n, m) {
			return true
		}
	}
	return false
}

// isFloatingSpec reports whether an npm version spec is a floating range (caret/tilde/wildcard/range)
// rather than an exact pin. URLs, git refs, and workspace protocols (specs containing ':' or '/') are
// skipped — they are not floating-pin facts.
func isFloatingSpec(spec string) bool {
	s := strings.TrimSpace(spec)
	if s == "" || strings.ContainsAny(s, ":/") {
		return false
	}
	if s == "*" || strings.EqualFold(s, "latest") || strings.EqualFold(s, "x") {
		return true
	}
	switch s[0] {
	case '^', '~', '>', '<':
		return true
	}
	return strings.Contains(s, "x") || strings.Contains(s, "*") || strings.Contains(s, " - ") || strings.Contains(s, "||")
}

const maxManifestBytes = 512 * 1024

// readBoundedFile reads one tracked text file (working-tree copy) up to maxManifestBytes, returning
// ("", false) when missing, oversized, or a directory. Bounded and read-only.
func readBoundedFile(projectPath, rel string) (string, bool) {
	full := filepath.Join(projectPath, filepath.FromSlash(rel))
	info, err := os.Stat(full)
	if err != nil || info.IsDir() || info.Size() > maxManifestBytes {
		return "", false
	}
	b, err := os.ReadFile(full)
	if err != nil {
		return "", false
	}
	return string(b), true
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `go test ./pkg/reporadar/ -run 'TestFactClasses|TestSecurityClassified|TestSecurityBoundaryKind|TestSecurityRelevantDep'`
Expected: PASS.

---

### Task 3: Boundary classification (structure collector)

Have the structure collector additionally emit a `security-boundary` fact for every tracked source file whose path is security-relevant. This is the boundary signal the security admissibility gate requires.

**Files:**
- Modify: `pkg/reporadar/collect_structure.go`
- Test: `pkg/reporadar/collect_structure_test.go`

**Interfaces:**
- Consumes: `securityBoundaryKind` (Task 2), `ClassSecurityBoundary` (Task 1).
- Produces: additional `CollectorStructure` signals with sourceRef `struct:security-boundary:<path>` and `Facts["classes"] = ["security-boundary"]`, `Facts["boundary"] = <kind>`.

- [ ] **Step 1: Write the failing test**

Add to `pkg/reporadar/collect_structure_test.go`:

```go
func TestCollectStructureTagsSecurityBoundaries(t *testing.T) {
	dir := t.TempDir()
	gitCmd(t, dir, "init", "-q")
	writeFile(t, dir, "src/auth/session.ts", "export const login = () => {}\n") // security-relevant
	writeFile(t, dir, "src/util/format.ts", "export const fmt = () => {}\n")     // not
	gitCmd(t, dir, "add", ".")
	gitCmd(t, dir, "commit", "-q", "-m", "init")

	sigs, err := collectStructure(context.Background(), collectInput{projectPath: dir})
	if err != nil {
		t.Fatalf("collectStructure: %v", err)
	}
	var boundary *waveobj.RadarSignal
	for i := range sigs {
		if hasClass(sigs[i], ClassSecurityBoundary) {
			for _, p := range sigs[i].Paths {
				if p == "src/util/format.ts" {
					t.Fatal("non-security path must not be tagged a boundary")
				}
			}
			if sigs[i].Paths[0] == "src/auth/session.ts" {
				boundary = &sigs[i]
			}
		}
	}
	if boundary == nil {
		t.Fatal("expected a security-boundary signal for src/auth/session.ts")
	}
	if boundary.Facts["boundary"] != "auth" {
		t.Fatalf("expected boundary=auth, got %v", boundary.Facts["boundary"])
	}
}
```

Add `"github.com/wavetermdev/waveterm/pkg/waveobj"` to the test file's imports (it currently imports only `context` and `testing`).

- [ ] **Step 2: Run the test to verify it fails**

Run: `go test ./pkg/reporadar/ -run 'TestCollectStructureTagsSecurityBoundaries'`
Expected: FAIL — no security-boundary signal emitted.

- [ ] **Step 3: Emit boundary signals in `collectStructure`**

In `pkg/reporadar/collect_structure.go`, inside `collectStructure`, add a second loop **after** the existing production-source-without-test loop and **before** `return sigs, nil`:

```go
	// security-boundary classification: tag tracked source files whose path is security-relevant. This
	// is a fact (a boundary exists), never a defect — the security lens pairs it with a consequence.
	for _, f := range files {
		kind := securityBoundaryKind(f)
		if kind == "" {
			continue
		}
		summary := fmt.Sprintf("%s is a %s security boundary", f, kind)
		facts := map[string]any{"classes": []string{ClassSecurityBoundary}, "boundary": kind}
		sigs = append(sigs, newSignal(CollectorStructure, "struct:security-boundary:"+f, in.sinceTs, []string{f}, summary, facts, ""))
	}
```

(`files` and `sigs` are already in scope from the existing function body; `fmt` is already imported.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `go test ./pkg/reporadar/ -run 'TestCollectStructureTagsSecurityBoundaries|TestCollectStructureClassifies'`
Expected: PASS (both — the existing classification test is unaffected).

- [ ] **Step 5: Confirm the correctness pipeline is unchanged**

Run: `go test ./pkg/reporadar/`
Expected: PASS — including `TestAcceptanceFullScan` / `TestAcceptanceSecondScanReclassifies`. The new boundary signals enter the shared pool, but `V1Modes` is still `{correctness}` and the correctness selector already returned all signals, so the coupons finding still survives (its subsystem group is unchanged).

---

### Task 4: Dependency-manifest collector (`collect_dependency.go`)

A new collector that emits a floating-pin fact for each security-relevant `package.json` dependency, offline and deterministic. This is a self-sufficient security fact (both boundary and consequence).

**Files:**
- Create: `pkg/reporadar/collect_dependency.go`
- Test: `pkg/reporadar/collect_dependency_test.go`

**Interfaces:**
- Consumes: `git` (`gitexec.go`), `isIgnored` (`collect_structure.go`), `readBoundedFile` / `securityRelevantDep` / `isFloatingSpec` (Task 2), `newSignal` (`signal.go`), `CollectorDependency` / `ClassDependencyPin` (Task 1).
- Produces: `collectDependency(ctx context.Context, in collectInput) ([]waveobj.RadarSignal, error)`.

- [ ] **Step 1: Write the failing test**

Create `pkg/reporadar/collect_dependency_test.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package reporadar

import (
	"context"
	"testing"
)

func TestCollectDependencyFloatingPins(t *testing.T) {
	dir := t.TempDir()
	gitCmd(t, dir, "init", "-q")
	writeFile(t, dir, "package.json", `{
	  "dependencies": {
	    "jsonwebtoken": "^9.0.0",
	    "lodash": "^4.17.0",
	    "bcrypt": "5.1.0"
	  },
	  "devDependencies": {
	    "helmet": "~7.0.0"
	  }
	}`)
	gitCmd(t, dir, "add", ".")
	gitCmd(t, dir, "commit", "-q", "-m", "init")

	sigs, err := collectDependency(context.Background(), collectInput{projectPath: dir})
	if err != nil {
		t.Fatalf("collectDependency: %v", err)
	}
	got := map[string]bool{}
	for _, s := range sigs {
		if !hasClass(s, ClassDependencyPin) {
			t.Fatalf("dependency signal missing dependency-pin class: %+v", s.Facts)
		}
		got[s.Facts["package"].(string)] = true
	}
	if !got["jsonwebtoken"] {
		t.Fatal("floating security-relevant dep jsonwebtoken must be flagged")
	}
	if !got["helmet"] {
		t.Fatal("floating security-relevant devDependency helmet must be flagged")
	}
	if got["lodash"] {
		t.Fatal("lodash is not security-relevant — must not be flagged")
	}
	if got["bcrypt"] {
		t.Fatal("bcrypt is pinned (5.1.0) — must not be flagged")
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `go test ./pkg/reporadar/ -run 'TestCollectDependencyFloatingPins'`
Expected: FAIL — `collectDependency` undefined.

- [ ] **Step 3: Create `collect_dependency.go`**

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package reporadar

import (
	"context"
	"encoding/json"
	"fmt"
	"path"
	"sort"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// collectDependency emits a floating-pin fact for each security-relevant package.json dependency. It
// reads tracked package.json files offline and parses them with stdlib JSON — no registry, no network,
// no CVE lookup. go.mod is pinned by design (no floating pins); Cargo.toml and staleness are deferred.
func collectDependency(ctx context.Context, in collectInput) ([]waveobj.RadarSignal, error) {
	out, err := git(ctx, in.projectPath, "ls-files", "-z")
	if err != nil {
		return nil, fmt.Errorf("git ls-files: %w", err)
	}
	var sigs []waveobj.RadarSignal
	for _, f := range strings.Split(out, "\x00") {
		f = strings.TrimSpace(strings.ReplaceAll(f, "\\", "/"))
		if f == "" || isIgnored(f) || path.Base(f) != "package.json" {
			continue
		}
		content, ok := readBoundedFile(in.projectPath, f)
		if !ok {
			continue
		}
		var pkg struct {
			Dependencies    map[string]string `json:"dependencies"`
			DevDependencies map[string]string `json:"devDependencies"`
		}
		if json.Unmarshal([]byte(content), &pkg) != nil {
			continue // malformed manifest is skipped, not fatal
		}
		for _, deps := range []map[string]string{pkg.Dependencies, pkg.DevDependencies} {
			// sort names so the emitted order (and thus the payload) is deterministic across runs.
			names := make([]string, 0, len(deps))
			for name := range deps {
				names = append(names, name)
			}
			sort.Strings(names)
			for _, name := range names {
				spec := deps[name]
				if !securityRelevantDep(name) || !isFloatingSpec(spec) {
					continue
				}
				summary := fmt.Sprintf("security-relevant dependency %s uses a floating version range %q in %s", name, spec, f)
				facts := map[string]any{"classes": []string{ClassDependencyPin}, "package": name, "spec": spec}
				sigs = append(sigs, newSignal(CollectorDependency, "dep:floating:"+f+":"+name, in.sinceTs, []string{f}, summary, facts, ""))
			}
		}
	}
	return sigs, nil
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `go test ./pkg/reporadar/ -run 'TestCollectDependencyFloatingPins'`
Expected: PASS.

---

### Task 5: Config-security facts (config collector)

Extend the config collector to emit a config-security fact when a tracked config file contains a deterministic misconfiguration marker (permissive CORS or disabled auth). Self-sufficient security fact.

**Files:**
- Modify: `pkg/reporadar/collect_config.go`
- Test: `pkg/reporadar/collect_config_test.go`

**Interfaces:**
- Consumes: `readBoundedFile` (Task 2), `ClassConfigSecurity` (Task 1).
- Produces: additional `CollectorConfig` signals with sourceRef `config-security:<issue>:<file>` and `Facts["classes"] = ["config-security"]`, `Facts["issue"] = "permissive-cors" | "disabled-auth"`; helpers `isConfigFile`, `configSecuritySignals`, `configHasPermissiveCORS`, `configHasDisabledAuth`.

- [ ] **Step 1: Write the failing test**

Add to `pkg/reporadar/collect_config_test.go` (add `"github.com/wavetermdev/waveterm/pkg/waveobj"` to its imports if not already present):

```go
func TestCollectConfigSecurityFacts(t *testing.T) {
	dir := t.TempDir()
	gitCmd(t, dir, "init", "-q")
	writeFile(t, dir, "config/app.yaml", "cors:\n  origin: \"*\"\nauth_enabled: false\n")
	writeFile(t, dir, "config/safe.yaml", "feature_flag: true\n")
	gitCmd(t, dir, "add", ".")
	gitCmd(t, dir, "commit", "-q", "-m", "init")

	sigs, err := collectConfig(context.Background(), collectInput{projectPath: dir})
	if err != nil {
		t.Fatalf("collectConfig: %v", err)
	}
	issues := map[string]bool{}
	for _, s := range sigs {
		if hasClass(s, ClassConfigSecurity) {
			issues[s.Facts["issue"].(string)] = true
			if s.Snippet != "" {
				t.Fatal("config-security signals must not carry a raw snippet (no secret exposure)")
			}
		}
	}
	if !issues["permissive-cors"] || !issues["disabled-auth"] {
		t.Fatalf("expected both config-security issues, got %v", issues)
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `go test ./pkg/reporadar/ -run 'TestCollectConfigSecurityFacts'`
Expected: FAIL — no config-security signals emitted.

- [ ] **Step 3: Extend `collect_config.go`**

Replace the file-gathering loop in `collectConfig` so it also collects config files, and append the config-security signals before returning. The current loop body is:

```go
	for _, f := range strings.Split(out, "\x00") {
		f = strings.TrimSpace(strings.ReplaceAll(f, "\\", "/"))
		if f == "" || isIgnored(f) {
			continue
		}
		if strings.Contains(f, "migration") && strings.HasSuffix(f, ".sql") {
			migrations = append(migrations, f)
		}
	}
```

Change it to also gather config files (add a `var configFiles []string` declaration next to `var migrations []string`):

```go
	for _, f := range strings.Split(out, "\x00") {
		f = strings.TrimSpace(strings.ReplaceAll(f, "\\", "/"))
		if f == "" || isIgnored(f) {
			continue
		}
		if strings.Contains(f, "migration") && strings.HasSuffix(f, ".sql") {
			migrations = append(migrations, f)
		}
		if isConfigFile(f) {
			configFiles = append(configFiles, f)
		}
	}
```

Immediately before `return sigs, nil`, append the config-security signals:

```go
	sigs = append(sigs, configSecuritySignals(in, configFiles)...)
	return sigs, nil
```

Add these helpers to the same file:

```go
// isConfigFile reports whether a path is a config file the security scan should read for
// misconfiguration facts. JSON is included only when clearly a config file (excludes package manifests).
func isConfigFile(f string) bool {
	switch strings.ToLower(path.Ext(f)) {
	case ".yaml", ".yml", ".toml", ".ini", ".conf":
		return true
	case ".json":
		base := path.Base(f)
		return base != "package.json" && base != "package-lock.json" && strings.Contains(strings.ToLower(f), "config")
	}
	return false
}

// configSecuritySignals emits a fact (never a raw line) for each deterministic misconfiguration marker
// found in the given config files. Reads are bounded; no snippet is attached, so no secret is persisted.
func configSecuritySignals(in collectInput, files []string) []waveobj.RadarSignal {
	var sigs []waveobj.RadarSignal
	for _, f := range files {
		content, ok := readBoundedFile(in.projectPath, f)
		if !ok {
			continue
		}
		low := strings.ToLower(content)
		if configHasPermissiveCORS(low) {
			summary := fmt.Sprintf("config %s allows any CORS origin (wildcard)", f)
			facts := map[string]any{"classes": []string{ClassConfigSecurity}, "issue": "permissive-cors"}
			sigs = append(sigs, newSignal(CollectorConfig, "config-security:permissive-cors:"+f, in.sinceTs, []string{f}, summary, facts, ""))
		}
		if configHasDisabledAuth(low) {
			summary := fmt.Sprintf("config %s appears to disable authentication", f)
			facts := map[string]any{"classes": []string{ClassConfigSecurity}, "issue": "disabled-auth"}
			sigs = append(sigs, newSignal(CollectorConfig, "config-security:disabled-auth:"+f, in.sinceTs, []string{f}, summary, facts, ""))
		}
	}
	return sigs
}

func configHasPermissiveCORS(low string) bool {
	if !strings.Contains(low, "cors") && !strings.Contains(low, "allow-origin") {
		return false
	}
	for _, pat := range []string{"origin: *", "origin: \"*\"", "origin: '*'", "origin:*", "allow-origin: *", "allow-origin:*"} {
		if strings.Contains(low, pat) {
			return true
		}
	}
	return false
}

func configHasDisabledAuth(low string) bool {
	for _, pat := range []string{"auth_enabled: false", "auth: false", "require_auth: false", "authentication: false", "auth_required: false", "disable_auth: true", "authentication: none", "auth: none"} {
		if strings.Contains(low, pat) {
			return true
		}
	}
	return false
}
```

(`fmt`, `path`, `strings`, and the `waveobj` import are already present in `collect_config.go`.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `go test ./pkg/reporadar/ -run 'TestCollectConfig'`
Expected: PASS (the new `TestCollectConfigSecurityFacts` and the existing migration test).

---

### Task 6: Security lens logic (`modes.go`)

Register the security cases on the three per-mode seams: candidate selection, admissibility, and prompt framing. This is where "boundary AND consequence" becomes the deterministic gate.

**Files:**
- Modify: `pkg/reporadar/modes.go`
- Test: `pkg/reporadar/modes_test.go`

**Interfaces:**
- Consumes: `isSecurityClassified` / `isSecurityConsequence` (Task 2), `ModeSecurity` (Task 1).
- Produces: `ModeSecurity` cases on `candidatesForMode`, `admissibleForMode`, `modeTaskLine`; helpers `candidatesForSecurity`, `admissibleForSecurity`.

- [ ] **Step 1: Write the failing tests**

Add to `pkg/reporadar/modes_test.go`:

```go
func TestCandidatesForSecurityFiltersPool(t *testing.T) {
	boundary := newSignal(CollectorStructure, "struct:security-boundary:src/auth/s.ts", 1, []string{"src/auth/s.ts"}, "b", map[string]any{"classes": []string{ClassSecurityBoundary}}, "")
	noTest := newSignal(CollectorStructure, "struct:no-test:src/x.ts", 1, []string{"src/x.ts"}, "n", map[string]any{"classes": []string{"source-without-test"}}, "")
	churn := newSignal(CollectorGit, "commit:1", 2, []string{"src/auth/s.ts"}, "c", nil, "")
	mem := newSignal(CollectorMemory, "mem:1", 3, []string{"src/auth/s.ts"}, "m", nil, "")
	dep := newSignal(CollectorDependency, "dep:floating:package.json:jsonwebtoken", 1, []string{"package.json"}, "d", map[string]any{"classes": []string{ClassDependencyPin}}, "")

	got := candidatesForMode(ModeSecurity, []waveobj.RadarSignal{boundary, noTest, churn, mem, dep})
	kept := map[string]bool{}
	for _, s := range got {
		kept[s.SourceRef] = true
	}
	if !kept["struct:security-boundary:src/auth/s.ts"] || !kept["commit:1"] || !kept["dep:floating:package.json:jsonwebtoken"] {
		t.Fatalf("security selector must keep boundary + churn + dep, got %v", kept)
	}
	if kept["struct:no-test:src/x.ts"] || kept["mem:1"] {
		t.Fatalf("security selector must drop no-test structure + memory noise, got %v", kept)
	}
}

func TestAdmissibleForSecurity(t *testing.T) {
	boundary := newSignal(CollectorStructure, "b", 1, []string{"src/auth/s.ts"}, "b", map[string]any{"classes": []string{ClassSecurityBoundary}}, "")
	churn := newSignal(CollectorGit, "c", 2, []string{"src/auth/s.ts"}, "c", nil, "")
	dep := newSignal(CollectorDependency, "d", 1, []string{"package.json"}, "d", map[string]any{"classes": []string{ClassDependencyPin}}, "")
	cfg := newSignal(CollectorConfig, "cfg", 1, []string{"config/app.yaml"}, "cfg", map[string]any{"classes": []string{ClassConfigSecurity}}, "")

	// boundary alone (no consequence) -> withheld.
	if admissibleForMode(ModeSecurity, []waveobj.RadarSignal{boundary}, StrengthLimited) {
		t.Fatal("a security boundary with no consequence must be withheld")
	}
	// churn alone (no boundary) -> withheld.
	if admissibleForMode(ModeSecurity, []waveobj.RadarSignal{churn}, StrengthLimited) {
		t.Fatal("churn with no security classification must be withheld")
	}
	// boundary + churn -> admitted.
	if !admissibleForMode(ModeSecurity, []waveobj.RadarSignal{boundary, churn}, StrengthLimited) {
		t.Fatal("boundary + consequence must be admitted")
	}
	// self-sufficient facts alone -> admitted.
	if !admissibleForMode(ModeSecurity, []waveobj.RadarSignal{dep}, StrengthLimited) {
		t.Fatal("a dependency-pin fact is self-sufficient and must be admitted")
	}
	if !admissibleForMode(ModeSecurity, []waveobj.RadarSignal{cfg}, StrengthLimited) {
		t.Fatal("a config-security fact is self-sufficient and must be admitted")
	}
}

func TestModeTaskLineSecurity(t *testing.T) {
	if got := modeTaskLine(ModeSecurity); got == modeTaskLine(ModeCorrectness) || got == "" {
		t.Fatalf("security task line must be distinct and non-empty, got %q", got)
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go test ./pkg/reporadar/ -run 'TestCandidatesForSecurity|TestAdmissibleForSecurity|TestModeTaskLineSecurity'`
Expected: FAIL — the security cases fall through to the correctness default (e.g. `admissibleForMode(ModeSecurity, {dep})` is currently gated on the correctness rule, and `modeTaskLine(ModeSecurity)` equals the correctness line).

- [ ] **Step 3: Add the security cases to `modes.go`**

In `candidatesForMode`, add a `ModeSecurity` case before `default`:

```go
	case ModeSecurity:
		return candidatesForSecurity(sigs)
```

In `admissibleForMode`, add a `ModeSecurity` case before `default`:

```go
	case ModeSecurity:
		return admissibleForSecurity(supporting)
```

In `modeTaskLine`, add a `ModeSecurity` case before `default`:

```go
	case ModeSecurity:
		return "propose security-risk hypotheses — exploitable boundary fragility grounded in the evidence, never speculative vulnerabilities"
```

Add the two helpers at the end of the file:

```go
// candidatesForSecurity narrows the shared pool to what the security lens clusters over: the
// security-classified signals (boundaries + self-sufficient facts) plus the churn/failure signals that
// can be their consequence. Correctness-only noise (plain no-test structure facts, memory) is dropped.
func candidatesForSecurity(sigs []waveobj.RadarSignal) []waveobj.RadarSignal {
	var out []waveobj.RadarSignal
	for _, s := range sigs {
		if isSecurityClassified(s) || isSecurityConsequence(s) {
			out = append(out, s)
		}
	}
	return out
}

// admissibleForSecurity enforces the security trust gate: a finding must cite BOTH a security-boundary
// classification AND a consequence signal. A config-security or dependency-pin fact satisfies both on
// its own (it is a standing security fact); a structure security boundary needs a separate churn/failure
// consequence — a boundary that never changed and never failed is not fragile.
func admissibleForSecurity(supporting []waveobj.RadarSignal) bool {
	hasBoundary, hasConsequence := false, false
	for _, s := range supporting {
		if isSecurityClassified(s) {
			hasBoundary = true
		}
		if isSecurityConsequence(s) {
			hasConsequence = true
		}
	}
	return hasBoundary && hasConsequence
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `go test ./pkg/reporadar/ -run 'TestCandidatesForSecurity|TestAdmissibleForSecurity|TestModeTaskLine'`
Expected: PASS (including the Plan 1 `TestModeTaskLineDefaultsToCorrectness`).

---

### Task 7: Activate the security lens

Wire the dependency collector into collection, append `ModeSecurity` to `V1Modes`, fix the two Plan 1 cluster tests that hard-code `V1Modes`, and prove the lens end-to-end with a security-citing cluster test and an acceptance assertion.

**Files:**
- Modify: `pkg/reporadar/scan.go` (add the dependency collector to `collectAll`)
- Modify: `pkg/reporadar/types.go` (append `ModeSecurity` to `V1Modes`)
- Modify: `pkg/reporadar/cluster_test.go` (use explicit `[]string{ModeCorrectness}` — see below)
- Test: `pkg/reporadar/security_scan_test.go` (new), `pkg/reporadar/acceptance_test.go`

**Interfaces:**
- Consumes: `collectDependency` (Task 4), `clusterModes` (`scan.go`, Plan 1), the security taxonomy + lens logic (Tasks 1, 6).

- [ ] **Step 1: Fix the Plan 1 cluster tests, then add the failing security tests**

Appending `ModeSecurity` to `V1Modes` makes `clusterModes(..., V1Modes, ...)` run **two** modes, breaking the two Plan 1 tests that assert `len(runs) == 1`. In `pkg/reporadar/cluster_test.go`, change both `clusterModes` calls from `V1Modes` to an explicit single mode so they test one lens deterministically regardless of how many modes ship:

- Line ~37 (`TestClusterModesRecordsCompletedRun`): `findings, runs := clusterModes(context.Background(), "pay", "/repos/pay", sigs, []string{ModeCorrectness}, fn)`
- Line ~51 (`TestClusterModesRecordsFailure`): `findings, runs := clusterModes(context.Background(), "pay", "/repos/pay", nil, []string{ModeCorrectness}, fn)`

Create `pkg/reporadar/security_scan_test.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package reporadar

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// fakeStreamSecurity cites the given ids + files as one auth-boundary-fragility finding.
func fakeStreamSecurity(ids, files []string) streamFn {
	return func(ctx context.Context, prompt string) ([]string, error) {
		inner := SynthResponse{Findings: []SynthFinding{{
			RiskKind: RiskAuthBoundaryFragility, Risk: "r", Why: "w", Severity: "high",
			SignalIDs: ids, Files: files, Mission: "m",
		}}}
		b, _ := json.Marshal(inner)
		return []string{
			`{"type":"system","subtype":"init","model":"claude-sonnet-x"}`,
			`{"type":"result","subtype":"success","result":` + jsonString(string(b)) + `,"usage":{"input_tokens":10,"output_tokens":5}}`,
		}, nil
	}
}

func TestSecurityLensClustersBoundaryFinding(t *testing.T) {
	boundary := newSignal(CollectorStructure, "struct:security-boundary:src/auth/session.ts", 1, []string{"src/auth/session.ts"}, "auth boundary", map[string]any{"classes": []string{ClassSecurityBoundary}, "boundary": "auth"}, "")
	churn := newSignal(CollectorGit, "commit:1", 2, []string{"src/auth/session.ts"}, "changed", nil, "")
	fn := fakeStreamSecurity([]string{boundary.ID, churn.ID}, []string{"src/auth/session.ts"})

	findings, runs := clusterModes(context.Background(), "pay", "/repos/pay", []waveobj.RadarSignal{boundary, churn}, []string{ModeSecurity}, fn)
	if len(runs) != 1 || runs[0].Mode != ModeSecurity || runs[0].Status != ModeRunCompleted {
		t.Fatalf("want 1 completed security run, got %+v", runs)
	}
	if len(findings) != 1 || findings[0].Mode != ModeSecurity || findings[0].RiskKind != RiskAuthBoundaryFragility {
		t.Fatalf("want 1 security auth-boundary finding, got %+v", findings)
	}
}
```

Then add an acceptance assertion to `pkg/reporadar/acceptance_test.go`:

```go
func TestAcceptanceSecurityLensRuns(t *testing.T) {
	ctx := context.Background()
	dir := buildFixtureRepo(t)
	var seen string
	withFakeSynthFn(t, clusterFirstMultiSignalGroup(&seen))

	rpt, _ := wstore.CreateRadarReport(ctx, "pay", dir)
	runScan(ctx, rpt.OID)
	got, _ := wstore.GetRadarReport(ctx, rpt.OID)

	// both lenses ran and completed (the fake returns a correctness kind, so the security lens completes
	// with zero admitted findings — but it ran, which is the point).
	modes := map[string]string{}
	for _, r := range got.ModeRuns {
		modes[r.Mode] = r.Status
	}
	if modes[ModeCorrectness] != ModeRunCompleted || modes[ModeSecurity] != ModeRunCompleted {
		t.Fatalf("expected both lenses completed, got %+v", got.ModeRuns)
	}
	// the correctness finding is intact and stamped correctness (empty back-compat default still holds).
	if len(got.Findings) < 1 || got.Findings[0].Mode != ModeCorrectness {
		t.Fatalf("correctness finding must survive unchanged, got %+v", got.Findings)
	}
	// the planted secret still never reaches the payload, through either lens.
	if strings.Contains(seen, "sk-ABCDEF0123456789") {
		t.Fatal("planted secret leaked into the model payload")
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go test ./pkg/reporadar/ -run 'TestSecurityLensClustersBoundaryFinding|TestAcceptanceSecurityLensRuns'`
Expected: FAIL — `TestSecurityLensClustersBoundaryFinding` fails because the security boundary/churn are dropped or withheld only if lens logic is missing (it exists after Task 6, so this one may already pass); `TestAcceptanceSecurityLensRuns` FAILS because `V1Modes` is still `{correctness}` (only one mode run recorded).

- [ ] **Step 3: Wire the collector and activate the mode**

In `pkg/reporadar/scan.go`, add the dependency collector to `collectAll`, immediately after the `CollectorConfig` line:

```go
	run(CollectorConfig, func() ([]waveobj.RadarSignal, error) { return collectConfig(ctx, in) })
	run(CollectorDependency, func() ([]waveobj.RadarSignal, error) { return collectDependency(ctx, in) })
```

In `pkg/reporadar/types.go`, append `ModeSecurity` to `V1Modes`:

```go
var V1Modes = []string{ModeCorrectness, ModeSecurity}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `go test ./pkg/reporadar/ -run 'TestSecurityLensClustersBoundaryFinding|TestAcceptanceSecurityLensRuns|TestClusterModes'`
Expected: PASS.

- [ ] **Step 5: Full backend gate**

Run: `go test ./pkg/reporadar/ ./pkg/waveobj/`
Expected: PASS — every collector, lens, acceptance, and reconcile test. The correctness acceptance tests still pass: the security lens runs but the fake cites a correctness kind, so it admits nothing and leaves correctness untouched.

Run: `task build:backend`
Expected: exit 0 (rebuilds `wavesrv` + `wsh` with the new collector). No `task generate` — Plan 2 added no waveobj fields.

---

### Task 8: Frontend — mode filter chips + `failedLenses` helper

Wire the mode filter into the results view and add the pure helper the per-lens banner (Task 10) needs. Chips appear only when a report actually spans more than one lens.

**Files:**
- Modify: `frontend/app/view/agents/radarmodel.ts`
- Modify: `frontend/app/view/agents/radarsurface.tsx`
- Test: `frontend/app/view/agents/radarmodel.test.ts`

**Interfaces:**
- Consumes: `filterByMode` / `modeFilterOptions` / `MODE_META` (Plan 1, `radarmodel.ts`), `modeBadge` (Plan 1, `radarstyles.ts`).
- Produces: `failedLenses(report) RadarModeRun[]`; a mode-filter control on the Radar results view.

- [ ] **Step 1: Write the failing test**

Add to the `describe("radar modes", …)` block in `frontend/app/view/agents/radarmodel.test.ts` (import `failedLenses` from `./radarmodel`):

```ts
    test("failedLenses returns only clustering-failed mode runs", () => {
        const report = {
            moderuns: [
                { mode: "correctness", status: "completed" },
                { mode: "security", status: "clustering-failed", clustererror: "boom" },
            ],
        } as RadarReport;
        const failed = failedLenses(report);
        expect(failed).toHaveLength(1);
        expect(failed[0].mode).toBe("security");
        expect(failedLenses(null)).toHaveLength(0);
    });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run frontend/app/view/agents/radarmodel.test.ts`
Expected: FAIL — `failedLenses` is not exported.

- [ ] **Step 3: Add `failedLenses` to `radarmodel.ts`**

Append to `frontend/app/view/agents/radarmodel.ts`:

```ts
// failedLenses returns the mode runs that failed to cluster — the per-lens error banner's source.
export function failedLenses(report: RadarReport | null): RadarModeRun[] {
    return (report?.moderuns ?? []).filter((r) => r.status === "clustering-failed");
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run frontend/app/view/agents/radarmodel.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire the mode filter into `radarsurface.tsx`**

Add to the existing `./radarmodel` import block: `filterByMode`, `modeFilterOptions`, `MODE_META`, and the `RadarMode` type. Add to the `./radarstyles` import: `modeBadge`. Add `useState` is already imported.

Replace the findings-derivation lines (currently `const findings = report?.findings ?? [];` and the `effectiveSelected` line just below it, around lines 156-158) with a mode-filtered derivation:

```tsx
    const [modeFilter, setModeFilter] = useState<RadarMode | "all">("all");
    const allFindings = report?.findings ?? [];
    const modeOptions = modeFilterOptions(allFindings);
    // if the active filter's mode vanished after a re-scan, fall back to "all" so the list is never stuck empty.
    const activeMode = modeFilter !== "all" && !modeOptions.includes(modeFilter) ? "all" : modeFilter;
    const findings = filterByMode(allFindings, activeMode);
    const effectiveSelected = resolveSelection(findings, selectedId);
```

In the summary-chips row (the `<div className="flex flex-wrap items-center gap-3 border-b border-border px-6 py-3">` at line ~222), add the mode chips as the first children, before the `groupSummary(findings)` chips. Render them only when the report spans more than one lens:

```tsx
                            {modeOptions.length > 1 ? (
                                <div className="flex items-center gap-1.5">
                                    {(["all", ...modeOptions] as (RadarMode | "all")[]).map((m) => {
                                        const on = activeMode === m;
                                        return (
                                            <button
                                                key={m}
                                                type="button"
                                                onClick={() => setModeFilter(m)}
                                                className={cn(
                                                    "rounded-full border px-2.5 py-0.5 text-[11px] font-semibold",
                                                    m === "all"
                                                        ? on
                                                            ? "border-accent/40 bg-accent/15 text-accent-soft"
                                                            : "border-border text-muted hover:text-secondary"
                                                        : on
                                                          ? modeBadge(m)
                                                          : "border-border text-muted hover:text-secondary"
                                                )}
                                            >
                                                {m === "all" ? "All" : MODE_META[m].label}
                                            </button>
                                        );
                                    })}
                                    <span className="mx-1 h-4 w-px bg-border" />
                                </div>
                            ) : null}
```

- [ ] **Step 6: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

---

### Task 9: Frontend — mode badges on rows and detail

Show a lens badge on each non-correctness finding (list row + detail header) so a merged list is legible at a glance. Correctness rows stay unbadged to keep the common case clean.

**Files:**
- Modify: `frontend/app/view/agents/radarfindingslist.tsx`
- Modify: `frontend/app/view/agents/radarfindingdetail.tsx`

**Interfaces:**
- Consumes: `findingMode` / `MODE_META` (Plan 1, `radarmodel.ts`), `modeBadge` (Plan 1, `radarstyles.ts`).

- [ ] **Step 1: Add the badge to the list row (`radarfindingslist.tsx`)**

Add `findingMode` and `MODE_META` to the `./radarmodel` import; add `modeBadge` to the `./radarstyles` import.

In the row header line (the `<div className="flex items-center gap-2">` at line ~116, which renders the severity pill + subsystem), add the mode badge immediately after the subsystem `<span>` (line ~125):

```tsx
                                              <span className="truncate font-mono text-[10px] text-muted">{f.subsystem}</span>
                                              {findingMode(f) !== "correctness" ? (
                                                  <span
                                                      className={cn(
                                                          "shrink-0 rounded border px-1 py-px text-[8px] font-bold uppercase tracking-wide",
                                                          modeBadge(findingMode(f))
                                                      )}
                                                  >
                                                      {MODE_META[findingMode(f)].short}
                                                  </span>
                                              ) : null}
```

- [ ] **Step 2: Add the badge to the detail header (`radarfindingdetail.tsx`)**

Add `findingMode` and `MODE_META` to the `./radarmodel` import; add `modeBadge` to the `./radarstyles` import.

In the status row (the `<div className="flex flex-wrap items-center gap-2 text-xs">` at line ~78), add the badge immediately after the severity `<span>` (which closes at line ~85):

```tsx
                    {findingMode(finding) !== "correctness" ? (
                        <span className={cn("rounded border px-2 py-0.5 font-semibold uppercase tracking-wide", modeBadge(findingMode(finding)))}>
                            {MODE_META[findingMode(finding)].label}
                        </span>
                    ) : null}
```

- [ ] **Step 3: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

---

### Task 10: Frontend — per-lens error banner, dev mock, collector checklist

Render a real error banner when a lens fails to cluster (the D3 fix, now visible), add dev-mock scenarios so CDP can render the multi-mode list and the lens-failed banner, and show the new `dependency` collector in the scan checklist.

**Files:**
- Modify: `frontend/app/view/agents/radarsurface.tsx`
- Modify: `frontend/app/view/agents/radardevmock.ts`
- Modify: `frontend/app/view/agents/radarscanstatepanel.tsx`

**Interfaces:**
- Consumes: `failedLenses` (Task 8), `MODE_META` (Plan 1), `retryClustering` (`radarstore.ts`).

- [ ] **Step 1: Add the per-lens banner to `radarsurface.tsx`**

Add `failedLenses` to the `./radarmodel` import; add `retryClustering` to the `./radarstore` import.

Immediately after the partial-scan banner block (the `{state === "partial" ? (…) : null}` ending at line ~246), add:

```tsx
                        {failedLenses(report).length > 0 ? (
                            <div className="flex items-center gap-2.5 border-b border-border bg-error/10 px-6 py-2 text-xs text-error">
                                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                                <span className="flex-1">
                                    <b>Lens failed.</b>{" "}
                                    {failedLenses(report)
                                        .map((r) => MODE_META[findingMode({ mode: r.mode } as RadarFinding)].label)
                                        .join(", ")}{" "}
                                    did not cluster — the other lenses' findings are shown.
                                </span>
                                <button
                                    type="button"
                                    onClick={() => fireAndForget(() => retryClustering(report.oid))}
                                    className="shrink-0 rounded border border-error/40 px-2 py-0.5 font-semibold text-error hover:bg-error/15"
                                >
                                    Retry
                                </button>
                            </div>
                        ) : null}
```

Add `findingMode` and `MODE_META` to the `./radarmodel` import if not already added in Task 8 (Task 8 added `MODE_META`; add `findingMode` here). (Using `findingMode` to normalize the run's `mode` string to a `RadarMode` keeps the label lookup total.)

- [ ] **Step 2: Add dev-mock scenarios (`radardevmock.ts`)**

Add `"security"` and `"lens-failed"` to `RADAR_SCENARIOS`:

```ts
export const RADAR_SCENARIOS = [
    "never-scanned",
    "collecting",
    "clustering",
    "results",
    "partial",
    "security",
    "lens-failed",
    "no-findings",
    "model-failed",
    "cancelled",
] as const;
```

Extend the `finding` factory so a scenario can set a finding's mode (append `mode` to the `extra` spread — it already accepts `Partial<RadarFinding>`, so no signature change is needed; just pass `mode` in the `extra` objects below).

Add the two scenarios to the `switch` in `buildScenario`, before the `results`/`default` case:

```ts
        case "security":
            return base({
                status: "completed",
                coverage: { structure: "ok", git: "ok", runs: "ok", config: "ok", dependency: "ok" },
                moderuns: [
                    { mode: "correctness", status: "completed", findingcount: 1 },
                    { mode: "security", status: "completed", findingcount: 2 },
                ],
                findings: [
                    finding("a", "new"),
                    finding("s1", "new", {
                        mode: "security",
                        riskkind: "auth-boundary-fragility",
                        subsystem: "src/auth",
                        severity: "high",
                        risk: "Auth session boundary churns without test adjacency",
                        why: "session.ts changed 4 times in the window with no covering test change; two agents needed correction here.",
                    }),
                    finding("s2", "recurring", {
                        mode: "security",
                        riskkind: "dependency-exposure",
                        subsystem: "package.json",
                        severity: "medium",
                        strength: "limited",
                        risk: "jsonwebtoken pinned to a floating ^ range",
                        why: "a floating range on an auth-critical dependency can pull an unreviewed version on install.",
                    }),
                ],
            });
        case "lens-failed":
            return base({
                status: "partial",
                coverage: { structure: "ok", git: "ok", runs: "ok", config: "ok", dependency: "ok" },
                moderuns: [
                    { mode: "correctness", status: "completed", findingcount: 1 },
                    { mode: "security", status: "clustering-failed", clustererror: "model returned invalid output" },
                ],
                findings: [finding("a", "new")],
            });
```

- [ ] **Step 3: Show the dependency collector in the checklist (`radarscanstatepanel.tsx`)**

Add `"dependency"` to the `COLLECTORS` array (line 9) and a matching bullet to `EXAMINES` (line 18):

```ts
const COLLECTORS = ["structure", "git", "runs", "transcript", "memory", "config", "dependency"];
```

```ts
    "Config & migration boundaries",
    "Dependency manifest pins",
```

- [ ] **Step 4: Typecheck + unit + visual verification**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

Run: `npx vitest run frontend/app/view/agents/`
Expected: PASS.

CDP (best-effort, per CLAUDE.md "Visual verification"): with the dev app running, drive the new scenarios and screenshot —

```
node scripts/cdp-shot.mjs cdp-shots/radar-security.png   # after __setRadarScenario("security")
node scripts/cdp-shot.mjs cdp-shots/radar-lensfailed.png # after __setRadarScenario("lens-failed")
```

Confirm: mode filter chips (All / Correctness / Security) appear; security rows carry a `SEC` badge; the lens-failed banner renders in the error tone with a Retry button; long `why` text does not clip. Never `Page.reload`.

---

## Integration verification (after all tasks)

Run the full gate before handing back:

- `go test ./pkg/reporadar/ ./pkg/waveobj/` → PASS
- `npx vitest run frontend/app/view/agents/` → PASS
- `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` → exit 0
- `task build:backend` → exit 0
- `task generate` → **no diff** (Plan 2 added no waveobj fields; if this produces a diff, something was hand-edited or a type changed unexpectedly — investigate before continuing)

Do not commit. Report status to the user; the feature is committed once at the end with approval, and the design spec folds into that commit.

## Self-Review

**Spec coverage (Plan 2 subset):**
- Security taxonomy + globally-unique kinds (§"Taxonomies and the trust gate", §Architecture mode dimension) → Task 1.
- Deterministic classifiers, DB-round-trip tolerance → Task 2.
- New collectors: boundary classification (§"New collectors" security) → Task 3; dependency-manifest facts → Task 4; config-security facts → Task 5.
- Security candidate selector + admissibility predicate + prompt framing (§Synthesis, §"Taxonomies and the trust gate") → Task 6.
- Collect-once wiring + one bounded call per mode via the Plan 1 loop, `ModeSecurity` activation → Task 7.
- Frontend surface treatment deferred to Plan 2 by Plan 1: mode filter chips → Task 8; per-row + detail badges → Task 9; per-lens error banner (D3 fix) + dev mock + checklist → Task 10.

**Deliberately deferred (documented, not silent):** `go.mod` floating pins (none exist — pinned by design), Cargo.toml + registry-staleness (offline rule / no TOML dep), per-lens *retry* (banner re-runs the existing whole-report retry), cross-mode finding merge, parallel per-mode calls, per-project mode toggle, architecture mode. All match the design's "Deferred extensions" / "Consequences" sections.

**Placeholder scan:** none. Every code and test step carries complete content. No "TBD / handle errors / similar-to."

**Type consistency:**
- `ValidRiskKind(mode, kind)` — Plan 1 signature, consumed with `ModeSecurity` in Tasks 1, 6.
- `factClasses` / `hasClass` / `isSecurityClassified` / `isSecurityConsequence` / `securityBoundaryKind` / `securityRelevantDep` / `isFloatingSpec` / `readBoundedFile` — defined Task 2, consumed Tasks 3, 4, 5, 6.
- `candidatesForMode` / `admissibleForMode` / `modeTaskLine` — Plan 1 signatures; `ModeSecurity` cases added Task 6, exercised by `clusterModes` (Plan 1) in Task 7.
- `collectDependency(ctx, in)` — defined Task 4, wired into `collectAll` Task 7.
- `configSecuritySignals(in, files)` / `isConfigFile` — defined + consumed within `collectConfig` Task 5.
- `failedLenses(report)` — defined Task 8, consumed Task 10.
- `findingMode` / `filterByMode` / `modeFilterOptions` / `MODE_META` / `modeBadge` — Plan 1 exports, consumed Tasks 8, 9, 10.
- `RadarSignal.Facts["classes"]` written as `[]string` by every collector (Tasks 3-5), read tolerantly (`[]string` + `[]any`) by `factClasses` (Task 2) — the retry path depends on the `[]any` branch.
- `V1Modes` grows to `{correctness, security}` in Task 7; the two Plan 1 `clusterModes` tests are switched to explicit `[]string{ModeCorrectness}` in the same task so they stay deterministic.
