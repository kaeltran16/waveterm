# Jarvis S3 — Proactive Resurfacing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a Run is dispatched, semantically match its goal against past vault work and surface — off-band, behind a high relevance bar — at most one persisted, dismissible "related prior work" card on the run.

**Architecture:** A new pure-Go package `pkg/jarvisproactive` computes the suggestion (embedding pre-filter over S1's index → one capable-model relevance judgement → a single-best/none result). A non-fatal, off-band hook in `CreateRunCommand` runs it beside C's dispatch capture and persists the result to `run.Meta` via `wstore.UpdateRun` + a channel `SendWaveObjUpdate`. The frontend reads `run.meta` and renders one card on the run body, dismissible through the standard object-meta write path. No new RPC, wps event, WaveObj, migration, or `task generate`.

**Tech Stack:** Go (backend, `go test`), `pkg/jarvisembed` (S1 embedding index), `pkg/consult` (capable model), React 19 + jotai + Tailwind 4 (frontend), vitest (FE unit), CDP surface-smoke (render/dismiss verification).

**Spec:** `docs/superpowers/specs/2026-07-24-jarvis-s3-proactive-resurfacing-design.md`

## Global Constraints

- **Opt-in, strictly additive (v2 invariants 10, 11).** Embeddings off (default) → the whole feature is a no-op that never touches `run.Meta`; v2 == v1, zero standing cost. A missing/misconfigured/failing provider or model **degrades to no card**, never an error, and never slows or fails the run dispatch.
- **Embedding + model run only at the dispatch boundary, never on a background poll** (v1 invariant 1). The model runs **at most once** per qualifying dispatch, and only after the deterministic pre-filter clears.
- **Off-band and non-fatal.** The evaluation makes an embedding call + a model call; it must run in a detached goroutine with its own context (like C's `CaptureRunDispatch` and E's `captureAsync`), never on the wshrpc 5s budget. An eval failure logs and is dropped.
- **The model judges, it does not search** (v1 invariant 1). The model picks the single best of a deterministic candidate set or says "none"; it never generates prose or invents a relationship.
- **No new wire surface.** No RPC, no wps event, no WaveObj, no migration, no `task generate`. Delivery rides the run's existing `waveobj:update`; dismissal rides `ObjectService.UpdateObjectMeta`.
- **Go is the source of truth for the `run.Meta` contract.** The meta key string and payload field names are a hand-kept contract mirrored in one Go file and one TS file (no codegen for generic meta values); keep them identical.
- **Typecheck the frontend with** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` — bare `npx tsc` stack-overflows on this repo; baseline is clean (exit 0), so any error is yours.
- **Frontend surface state in module-scope jotai atoms**, never component `useState` for survive-worthy state — the run surface unmounts on nav-switch (only the agent surface stays mounted).
- **Import rule:** `view/agents` must not import the `view/jarvis` *view*; the new frontend files live in `view/agents/` and must not add a `view/jarvis` import.
- **Design language:** dark mode only; colors are `@theme` tokens in `tailwindsetup.css` (never raw hex/rgba); existing cockpit fonts; restrained motion; the card is visually subordinate to the run's own content (a suggestion, not a demand), matching the ambient-tag treatment.
- **PLACEHOLDER tunables** (`queryK`, `cosThreshold`, `shortlistMax`, the judge prompt) are fabricated defaults marked `// PLACEHOLDER` in code and recorded in `docs/deferred.md`; they are calibrated later against a populated, embedded vault.
- **Git workflow (user's, STRICT):** do NOT commit without explicit approval. Each task ends with a **Checkpoint** (run its tests/build, confirm green) — not an autonomous commit. The whole feature commits once at the end after approval (see Finalization), with the spec doc folded into that feature commit and the v2 meta-spec tracking-table S3 row updated in the same commit.

---

## Task 1: `jarvisproactive` — types + pure gate helpers

The deterministic, model-free core: the `run.Meta` payload contract, the cosine pre-filter (threshold + self-exclusion + cap), the judge prompt builder, and the judge-reply parser. All pure and fixture-testable with no vault, index, or model.

**Files:**
- Create: `pkg/jarvisproactive/suggestion.go`
- Create: `pkg/jarvisproactive/gate.go`
- Test: `pkg/jarvisproactive/gate_test.go`

**Interfaces:**
- Produces:
  - `MetaKeyProactive = "jarvis:proactive"` (string const) and `MetaKeyProactiveDismissed = "jarvis:proactive:dismissed"` (string const).
  - `type ProactiveSuggestion struct { Status, NodeID, SourceType, Title, Snippet, Why string }` with json tags (`status` required; the rest `omitempty`). `Status ∈ {"hit","none"}`.
  - `type candidate struct { NodeID, SourceType, Title, Snippet string; Score float32 }` (unexported).
  - `func prefilter(chunks []jarvisembed.ScoredChunk, excludeNodeID string) []candidate`
  - `func buildJudgePrompt(goal string, cands []candidate) string`
  - `func parseJudgeReply(reply string, n int) int` — returns a 0-based index into the shortlist, or `-1` for none/invalid/out-of-range.
- Consumes: `jarvisembed.ScoredChunk{NodeID, Collection, SectionHeading, SectionIdx, Snippet, Score}` (S1, `pkg/jarvisembed/index.go:29`).

- [ ] **Step 1: Write the failing test**

Create `pkg/jarvisproactive/gate_test.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvisproactive

import (
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/jarvisembed"
)

func chunk(id, coll, heading, snippet string, score float32) jarvisembed.ScoredChunk {
	return jarvisembed.ScoredChunk{NodeID: id, Collection: coll, SectionHeading: heading, Snippet: snippet, Score: score}
}

func TestPrefilterThresholdAndCap(t *testing.T) {
	in := []jarvisembed.ScoredChunk{
		chunk("a", "decisions", "Rate limiting", "drop-oldest on overflow", 0.95),
		chunk("b", "tasks", "Channel scaling", "shard by workspace", 0.83),
		chunk("c", "memory", "Note", "irrelevant", 0.10), // below threshold, dropped
	}
	got := prefilter(in, "")
	if len(got) != 2 {
		t.Fatalf("want 2 above-threshold candidates, got %d", len(got))
	}
	if got[0].NodeID != "a" || got[0].SourceType != "decision" {
		t.Fatalf("first candidate mapping wrong: %+v", got[0])
	}
	if got[1].SourceType != "dossier" {
		t.Fatalf("tasks collection should map to dossier, got %q", got[1].SourceType)
	}
}

func TestPrefilterSelfExclusion(t *testing.T) {
	in := []jarvisembed.ScoredChunk{
		chunk("own-dossier", "tasks", "This run", "the run's own dossier", 0.99),
		chunk("other", "decisions", "Prior", "prior decision", 0.90),
	}
	got := prefilter(in, "own-dossier")
	if len(got) != 1 || got[0].NodeID != "other" {
		t.Fatalf("self node must be excluded, got %+v", got)
	}
}

func TestBuildJudgePromptContainsGoalCandidatesAndGuardrail(t *testing.T) {
	p := buildJudgePrompt("fix the rate limit bug", []candidate{
		{NodeID: "a", SourceType: "decision", Title: "Rate limiting", Snippet: "drop-oldest"},
	})
	for _, want := range []string{"fix the rate limit bug", "Rate limiting", "drop-oldest", "none"} {
		if !strings.Contains(p, want) {
			t.Fatalf("prompt missing %q:\n%s", want, p)
		}
	}
}

func TestParseJudgeReply(t *testing.T) {
	cases := []struct {
		reply string
		n     int
		want  int
	}{
		{"1", 3, 0},
		{"  2  ", 3, 1},
		{"best: 3", 3, 2},
		{"none", 3, -1},
		{"", 3, -1},
		{"4", 3, -1},  // out of range
		{"0", 3, -1},  // 1-based; 0 is invalid
		{"garbage", 3, -1},
	}
	for _, c := range cases {
		if got := parseJudgeReply(c.reply, c.n); got != c.want {
			t.Fatalf("parseJudgeReply(%q,%d) = %d, want %d", c.reply, c.n, got, c.want)
		}
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `go test ./pkg/jarvisproactive/`
Expected: FAIL — package/functions not defined (build error).

- [ ] **Step 3: Write `suggestion.go`**

Create `pkg/jarvisproactive/suggestion.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Package jarvisproactive is the opt-in S3 proactive-resurfacing evaluator: at a
// Run dispatch it matches the run's goal against past vault work (S1's embedding
// index), gates behind a high cosine bar + one capable-model relevance judgement,
// and returns at most one "related prior work" suggestion. Off by default; a
// missing/failing provider degrades to no suggestion, never an error.
package jarvisproactive

// MetaKeyProactive is the run.Meta key holding the dispatch suggestion (a
// ProactiveSuggestion, or Status:"none" when nothing cleared the bar). Hand-kept
// contract mirrored on the frontend (view/agents/proactive.ts) — keep identical.
const MetaKeyProactive = "jarvis:proactive"

// MetaKeyProactiveDismissed is the run.Meta bool the frontend sets when the human
// dismisses the card; a dismissed suggestion never renders again. Mirrored on the FE.
const MetaKeyProactiveDismissed = "jarvis:proactive:dismissed"

// ProactiveSuggestion is the run.Meta payload. Status is "hit" (fields populated)
// or "none" (a persisted sentinel so a re-view never recomputes). Written by Go,
// read by TS — json tags are the wire contract.
type ProactiveSuggestion struct {
	Status     string `json:"status"`
	NodeID     string `json:"nodeId,omitempty"`
	SourceType string `json:"sourceType,omitempty"`
	Title      string `json:"title,omitempty"`
	Snippet    string `json:"snippet,omitempty"`
	Why        string `json:"why,omitempty"`
}
```

- [ ] **Step 4: Write `gate.go`**

Create `pkg/jarvisproactive/gate.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvisproactive

import (
	"fmt"
	"regexp"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/jarvisembed"
	"github.com/wavetermdev/waveterm/pkg/wavevault"
)

// Gate tunables (PLACEHOLDER — a deliberately HIGH bar; tune against a populated,
// embedded vault; see docs/deferred.md).
const (
	queryK       = 8    // semantic candidates requested from the index
	cosThreshold = 0.82 // minimum cosine to survive the pre-filter
	shortlistMax = 5    // max candidates handed to the model judge
)

type candidate struct {
	NodeID     string
	SourceType string
	Title      string
	Snippet    string
	Score      float32
}

// sourceTypeFor maps a vault collection to the display source type (mirrors
// jarvisrecall.nodeCandidate).
func sourceTypeFor(collection string) string {
	switch collection {
	case wavevault.CollTasks:
		return "dossier"
	case wavevault.CollDecisions:
		return "decision"
	default:
		return "memory"
	}
}

// prefilter keeps chunks scoring >= cosThreshold, drops the dispatching run's own
// node (excludeNodeID), dedupes by node id (a node may chunk into several
// sections), and caps at shortlistMax. Deterministic, no model, no I/O.
func prefilter(chunks []jarvisembed.ScoredChunk, excludeNodeID string) []candidate {
	seen := map[string]bool{}
	var out []candidate
	for _, c := range chunks {
		if c.Score < cosThreshold {
			continue
		}
		if c.NodeID == excludeNodeID || seen[c.NodeID] {
			continue
		}
		seen[c.NodeID] = true
		title := strings.TrimSpace(c.SectionHeading)
		if title == "" {
			title = c.NodeID
		}
		out = append(out, candidate{
			NodeID:     c.NodeID,
			SourceType: sourceTypeFor(c.Collection),
			Title:      title,
			Snippet:    strings.TrimSpace(c.Snippet),
			Score:      c.Score,
		})
		if len(out) >= shortlistMax {
			break
		}
	}
	return out
}

// buildJudgePrompt asks the capable model to pick the single most-relevant prior
// item or answer "none". The model judges the given set; it never searches or
// invents (invariant 1). The prefer-none instruction is the noise gate.
func buildJudgePrompt(goal string, cands []candidate) string {
	var b strings.Builder
	b.WriteString("A new task is about to start. Below are candidate items of PAST work that a search flagged as possibly related.\n")
	b.WriteString("Decide whether any candidate is genuinely worth surfacing to someone starting this task — the SAME or a closely-related prior problem, decision, or task, not merely the same topic.\n\n")
	b.WriteString("New task goal:\n")
	b.WriteString(goal)
	b.WriteString("\n\nCandidates:\n")
	for i, c := range cands {
		fmt.Fprintf(&b, "%d. [%s] %s — %s\n", i+1, c.SourceType, c.Title, c.Snippet)
	}
	b.WriteString("\nReply with ONLY the number of the single best candidate (1")
	if len(cands) > 1 {
		fmt.Fprintf(&b, "-%d", len(cands))
	}
	b.WriteString("), or the word \"none\". Prefer \"none\" unless a candidate is clearly worth interrupting for. Do not explain.\n")
	return b.String()
}

var judgeNumRe = regexp.MustCompile(`\d+`)

// parseJudgeReply extracts the chosen 1-based index from the model reply and
// returns it 0-based, or -1 for "none"/empty/out-of-range/unparseable. Fails safe
// to -1 (silence) on any ambiguity.
func parseJudgeReply(reply string, n int) int {
	m := judgeNumRe.FindString(reply)
	if m == "" {
		return -1
	}
	var idx int
	if _, err := fmt.Sscanf(m, "%d", &idx); err != nil {
		return -1
	}
	if idx < 1 || idx > n {
		return -1
	}
	return idx - 1
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `go test ./pkg/jarvisproactive/`
Expected: PASS (all four tests).

- [ ] **Step 6: Checkpoint**

Run: `go vet ./pkg/jarvisproactive/` and `go test ./pkg/jarvisproactive/`
Expected: clean, PASS. Do not commit (see Finalization).

---

## Task 2: `jarvisproactive` — the evaluation orchestration

The impure orchestration: query the index, resolve the run's own dossier to exclude, run the pre-filter, judge (one mockable model call), and build the single-best/none result. `evaluate` takes an explicit index + vault so it is fully unit-testable with a mock embedder and a mock judge; `EvaluateDispatch` is the thin public entry that opens the real index + vault.

**Files:**
- Create: `pkg/jarvisproactive/proactive.go`
- Test: `pkg/jarvisproactive/proactive_test.go`

**Interfaces:**
- Consumes (from Task 1): `ProactiveSuggestion`, `candidate`, `prefilter`, `buildJudgePrompt`, `parseJudgeReply`.
- Consumes (S1/A/consult):
  - `jarvisembed.OpenIndex(ctx) (*jarvisembed.Index, error)`, `(*Index).Available() bool`, `(*Index).Close() error`, `(*Index).Query(ctx, v *wavevault.Vault, queryText string, k int, scope wavevault.Scope) ([]jarvisembed.ScoredChunk, error)`.
  - `jarvisembed.OpenIndexAtForTest(ctx, dbPath string, emb jarvisembed.Embedder) (*Index, error)` and the `jarvisembed.Embedder` interface (for tests).
  - `wavevault.OpenVault(ctx) (*Vault, error)`, `wavevault.OpenVaultAtForTest(ctx, root string) (*Vault, error)`, `(*Vault).Retriever(scope) *Retriever`, `wavevault.AllScope()`, `(*Retriever).Query(wavevault.Filter{HasLink: string}) ([]wavevault.Node, error)`, `(*Retriever).Read(id) (wavevault.Node, string, error)`.
  - `consult.SpecFor("claude") (Spec, bool)`, `consult.Run(ctx, spec, cwd, prompt string, emit func(string)) (string, error)`.
- Produces:
  - `func EvaluateDispatch(ctx context.Context, run *waveobj.Run) (*ProactiveSuggestion, error)` — returns `nil` (no-op: embeddings off / query failed), or a `*ProactiveSuggestion` with `Status:"hit"` or `Status:"none"`. Never errors on a degraded provider; a non-nil error means an unexpected failure the caller logs.
  - `func SetJudgeForTest(fn func(ctx context.Context, cwd, prompt string) (string, error)) func(...)`.

- [ ] **Step 1: Write the failing test**

Create `pkg/jarvisproactive/proactive_test.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvisproactive

import (
	"context"
	"path/filepath"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/jarvisdossier"
	"github.com/wavetermdev/waveterm/pkg/jarvisembed"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wavevault"
)

// mockEmbedder returns a 3-dim canned vector keyed off a keyword so cosine is
// controllable: "rate limit" texts collapse onto one axis, everything else onto
// another. The query goal and a matching decision therefore score ~1.0.
type mockEmbedder struct{}

func (mockEmbedder) Model() string { return "mock-1" }
func (mockEmbedder) Embed(_ context.Context, texts []string) ([][]float32, error) {
	out := make([][]float32, len(texts))
	for i, t := range texts {
		if strings.Contains(strings.ToLower(t), "rate limit") {
			out[i] = []float32{1, 0, 0}
		} else {
			out[i] = []float32{0, 1, 0}
		}
	}
	return out, nil
}

func newTestIndex(t *testing.T, emb jarvisembed.Embedder) *jarvisembed.Index {
	t.Helper()
	ctx := context.Background()
	ix, err := jarvisembed.OpenIndexAtForTest(ctx, filepath.Join(t.TempDir(), "index.db"), emb)
	if err != nil {
		t.Fatalf("open test index: %v", err)
	}
	t.Cleanup(func() { ix.Close() })
	return ix
}

func newTestVault(t *testing.T) *wavevault.Vault {
	t.Helper()
	v, err := wavevault.OpenVaultAtForTest(context.Background(), t.TempDir())
	if err != nil {
		t.Fatalf("open test vault: %v", err)
	}
	return v
}

func TestEvaluateHit(t *testing.T) {
	ctx := context.Background()
	v := newTestVault(t)
	if _, _, err := jarvisdossier.CreateDossier(v, jarvisdossier.DossierFacts{
		Objective: "handle rate limit backoff on the API client",
	}); err != nil {
		t.Fatalf("seed dossier: %v", err)
	}
	if err := v.Commit(ctx, "seed"); err != nil {
		t.Fatalf("commit: %v", err)
	}
	restore := SetJudgeForTest(func(_ context.Context, _, _ string) (string, error) { return "1", nil })
	defer restore()

	run := &waveobj.Run{OID: "run-x", Goal: "fix the rate limit bug", ProjectPath: t.TempDir()}
	sug, err := evaluate(ctx, newTestIndex(t, mockEmbedder{}), v, run)
	if err != nil {
		t.Fatalf("evaluate: %v", err)
	}
	if sug == nil || sug.Status != "hit" {
		t.Fatalf("want a hit suggestion, got %+v", sug)
	}
	if !strings.Contains(strings.ToLower(sug.Title+" "+sug.Snippet), "rate limit") {
		t.Fatalf("suggestion should describe the matched node, got %+v", sug)
	}
}

func TestEvaluateJudgeSaysNone(t *testing.T) {
	ctx := context.Background()
	v := newTestVault(t)
	if _, _, err := jarvisdossier.CreateDossier(v, jarvisdossier.DossierFacts{
		Objective: "handle rate limit backoff on the API client",
	}); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if err := v.Commit(ctx, "seed"); err != nil {
		t.Fatalf("commit: %v", err)
	}
	restore := SetJudgeForTest(func(_ context.Context, _, _ string) (string, error) { return "none", nil })
	defer restore()

	run := &waveobj.Run{OID: "run-y", Goal: "fix the rate limit bug", ProjectPath: t.TempDir()}
	sug, err := evaluate(ctx, newTestIndex(t, mockEmbedder{}), v, run)
	if err != nil {
		t.Fatalf("evaluate: %v", err)
	}
	if sug == nil || sug.Status != "none" {
		t.Fatalf("want a none sentinel, got %+v", sug)
	}
}

func TestEvaluateBelowThresholdSkipsModel(t *testing.T) {
	ctx := context.Background()
	v := newTestVault(t)
	if _, _, err := jarvisdossier.CreateDossier(v, jarvisdossier.DossierFacts{
		Objective: "an entirely unrelated indexing task",
	}); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if err := v.Commit(ctx, "seed"); err != nil {
		t.Fatalf("commit: %v", err)
	}
	called := false
	restore := SetJudgeForTest(func(_ context.Context, _, _ string) (string, error) { called = true; return "1", nil })
	defer restore()

	run := &waveobj.Run{OID: "run-z", Goal: "fix the rate limit bug", ProjectPath: t.TempDir()}
	sug, err := evaluate(ctx, newTestIndex(t, mockEmbedder{}), v, run)
	if err != nil {
		t.Fatalf("evaluate: %v", err)
	}
	if called {
		t.Fatal("model judge must not run when the pre-filter is empty")
	}
	if sug == nil || sug.Status != "none" {
		t.Fatalf("empty shortlist should yield a none sentinel, got %+v", sug)
	}
}

func TestEvaluateSelfExclusion(t *testing.T) {
	ctx := context.Background()
	v := newTestVault(t)
	// The dossier C's capture just wrote for THIS run: it references run-run-self
	// and is textually a perfect match — it must be excluded, leaving nothing.
	id, hash, err := jarvisdossier.CreateDossier(v, jarvisdossier.DossierFacts{
		Objective: "fix the rate limit bug",
	})
	if err != nil {
		t.Fatalf("seed: %v", err)
	}
	if _, err := jarvisdossier.SetRefs(v, id, []string{"run-run-self"}, hash); err != nil {
		t.Fatalf("set refs: %v", err)
	}
	if err := v.Commit(ctx, "seed"); err != nil {
		t.Fatalf("commit: %v", err)
	}
	restore := SetJudgeForTest(func(_ context.Context, _, _ string) (string, error) { return "1", nil })
	defer restore()

	run := &waveobj.Run{OID: "run-self", Goal: "fix the rate limit bug", ProjectPath: t.TempDir()}
	sug, err := evaluate(ctx, newTestIndex(t, mockEmbedder{}), v, run)
	if err != nil {
		t.Fatalf("evaluate: %v", err)
	}
	if sug == nil || sug.Status != "none" {
		t.Fatalf("the run's own dossier must be excluded → none, got %+v", sug)
	}
}

func TestEvaluateDisabledIndexIsNoop(t *testing.T) {
	ctx := context.Background()
	v := newTestVault(t)
	called := false
	restore := SetJudgeForTest(func(_ context.Context, _, _ string) (string, error) { called = true; return "1", nil })
	defer restore()

	run := &waveobj.Run{OID: "run-off", Goal: "fix the rate limit bug", ProjectPath: t.TempDir()}
	sug, err := evaluate(ctx, newTestIndex(t, nil), v, run) // nil embedder → unavailable
	if err != nil {
		t.Fatalf("evaluate: %v", err)
	}
	if sug != nil {
		t.Fatalf("disabled index must be a total no-op (nil), got %+v", sug)
	}
	if called {
		t.Fatal("model judge must not run when embeddings are off")
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `go test ./pkg/jarvisproactive/ -run TestEvaluate`
Expected: FAIL — `evaluate` / `SetJudgeForTest` undefined.

- [ ] **Step 3: Write `proactive.go`**

Create `pkg/jarvisproactive/proactive.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvisproactive

import (
	"context"
	"fmt"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/consult"
	"github.com/wavetermdev/waveterm/pkg/jarvisembed"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wavevault"
)

var errNoClaude = fmt.Errorf("proactive relevance judge requires the claude CLI, which is not available")

// judge is the one capable-model call (tiering deferred). It returns the model's
// raw reply ("<n>" or "none"); parsing is parseJudgeReply's job. A seam so tests
// mock it. One-shot and unstreamed, so the emit callback is discarded.
var judge = func(ctx context.Context, cwd, prompt string) (string, error) {
	spec, ok := consult.SpecFor("claude")
	if !ok {
		return "", errNoClaude
	}
	return consult.Run(ctx, spec, cwd, prompt, func(string) {})
}

// SetJudgeForTest swaps the model call; returns the previous value for restore.
func SetJudgeForTest(fn func(ctx context.Context, cwd, prompt string) (string, error)) func(context.Context, string, string) (string, error) {
	old := judge
	judge = fn
	return old
}

// EvaluateDispatch is the off-band, non-fatal dispatch entry. It opens the real
// index + vault and delegates to evaluate. Returns nil when embeddings are off or
// the query fails (a total no-op — run.Meta is left untouched by the caller);
// otherwise a *ProactiveSuggestion (hit or none sentinel). Contract: the caller
// dispatches this in a detached goroutine, persists a non-nil result to run.Meta,
// and logs errors.
func EvaluateDispatch(ctx context.Context, run *waveobj.Run) (*ProactiveSuggestion, error) {
	ix, err := jarvisembed.OpenIndex(ctx)
	if err != nil {
		return nil, err
	}
	defer ix.Close()
	v, err := wavevault.OpenVault(ctx)
	if err != nil {
		return nil, err
	}
	return evaluate(ctx, ix, v, run)
}

// evaluate takes an explicit index + vault so tests exercise it against a fixture
// vault + mock embedder + mock judge. Returns nil for a total no-op (index
// unavailable / query error), else a hit or a "none" sentinel.
func evaluate(ctx context.Context, ix *jarvisembed.Index, v *wavevault.Vault, run *waveobj.Run) (*ProactiveSuggestion, error) {
	if !ix.Available() {
		return nil, nil // embeddings off → total no-op (invariant 10)
	}
	chunks, err := ix.Query(ctx, v, run.Goal, queryK, wavevault.AllScope())
	if err != nil {
		if err == jarvisembed.ErrEmbeddingsDisabled {
			return nil, nil
		}
		return nil, nil // a provider error degrades to no card, never fails the run (invariant 11)
	}

	cands := prefilter(chunks, ownDossierID(v, run))
	none := &ProactiveSuggestion{Status: "none"}
	if len(cands) == 0 {
		return none, nil // below the bar → sentinel, no model call
	}

	reply, err := judge(ctx, run.ProjectPath, buildJudgePrompt(run.Goal, cands))
	if err != nil {
		return none, nil // model unavailable/failed → no card, sentinel prevents recompute
	}
	pick := parseJudgeReply(reply, len(cands))
	if pick < 0 {
		return none, nil
	}
	c := cands[pick]
	return &ProactiveSuggestion{
		Status:     "hit",
		NodeID:     c.NodeID,
		SourceType: c.SourceType,
		Title:      titleForNode(v, c),
		Snippet:    c.Snippet,
		Why:        fmt.Sprintf("Related to \"%s\"", run.Goal),
	}, nil
}

// ownDossierID resolves the dossier C's dispatch capture just wrote for this run
// (the node referencing run-<oid>), so the run never resurfaces against itself.
// Empty when none is found (capture not yet indexed / failed) — harmless.
func ownDossierID(v *wavevault.Vault, run *waveobj.Run) string {
	linked, err := v.Retriever(wavevault.AllScope()).Query(wavevault.Filter{HasLink: "run-" + run.OID})
	if err != nil || len(linked) == 0 {
		return ""
	}
	return linked[0].ID
}

// titleForNode prefers the node's frontmatter objective for a human title, falling
// back to the pre-filter's section heading. One bounded read for the single chosen node.
func titleForNode(v *wavevault.Vault, c candidate) string {
	n, _, err := v.Retriever(wavevault.AllScope()).Read(c.NodeID)
	if err == nil {
		if obj, ok := n.Frontmatter["objective"]; ok {
			if s := strings.TrimSpace(fmt.Sprintf("%v", obj)); s != "" && s != "<nil>" {
				return s
			}
		}
	}
	return c.Title
}
```

> **Note on `Retriever.Read`:** its signature is `Read(id string) (wavevault.Node, string, error)` (node + body). If the actual arity differs, adapt `titleForNode` — the fallback (`return c.Title`) keeps the feature correct even if the objective lookup is dropped.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `go test ./pkg/jarvisproactive/ -run TestEvaluate -v`
Expected: PASS (all five `TestEvaluate*` tests).

- [ ] **Step 5: Checkpoint**

Run: `go test ./pkg/jarvisproactive/`
Expected: PASS (Task 1 + Task 2 tests). Do not commit.

---

## Task 3: Backend hook — dispatch evaluation in `CreateRunCommand`

Wire the off-band evaluation into run dispatch, beside C's capture, and persist a non-nil result to `run.Meta`, then emit the channel update the frontend already consumes for run changes. This is wiring verified by build + existing tests (and end-to-end by CDP in Task 6), not new unit tests.

**Files:**
- Modify: `pkg/wshrpc/wshserver/wshserver_runs.go` (add a dispatch var near `sealAsync`/`captureAsync` ~line 37-47; add the dispatch block in `CreateRunCommand` after `jarviscapture.CaptureRunDispatch` ~line 237-239).

**Interfaces:**
- Consumes: `jarvisproactive.EvaluateDispatch(ctx, run) (*ProactiveSuggestion, error)`, `jarvisproactive.MetaKeyProactive`; `wstore.UpdateRun(ctx, channelId, runId, fn)`; `wcore.SendWaveObjUpdate(oref)`; `waveobj.MakeORef`, `waveobj.OType_Run`, `waveobj.MetaMapType`.

- [ ] **Step 1: Add the async dispatch seam + timeout**

In `pkg/wshrpc/wshserver/wshserver_runs.go`, immediately after the `captureAsync` var + `continuityCaptureTimeout` const (~line 44-47), add:

```go
// proactiveAsync dispatches the S3 proactive-resurfacing evaluation off the RPC
// handler's goroutine — it makes an embedding + model call and must never sit on
// the 5s RPC budget. A seam so tests capture the dispatch without running it.
var proactiveAsync = func(fn func()) { go fn() }

// proactiveDispatchTimeout bounds the detached dispatch evaluation (PLACEHOLDER; see docs/deferred.md).
const proactiveDispatchTimeout = 90 * time.Second
```

- [ ] **Step 2: Add the dispatch block in `CreateRunCommand`**

In `CreateRunCommand`, immediately after the existing capture block (the `if err := jarviscapture.CaptureRunDispatch(ctx, &run); err != nil { ... }` at ~line 237-239), add:

```go
	proactiveAsync(func() {
		pctx, cancel := context.WithTimeout(context.Background(), proactiveDispatchTimeout)
		defer cancel()
		sug, perr := jarvisproactive.EvaluateDispatch(pctx, &run)
		if perr != nil {
			log.Printf("CreateRun: proactive dispatch eval failed (non-fatal): %v", perr)
			return
		}
		if sug == nil {
			return // embeddings off / degraded — leave run.Meta untouched
		}
		if uerr := wstore.UpdateRun(pctx, data.ChannelId, run.ID, func(r *waveobj.Run) error {
			if r.Meta == nil {
				r.Meta = waveobj.MetaMapType{}
			}
			r.Meta[jarvisproactive.MetaKeyProactive] = *sug
			return nil
		}); uerr != nil {
			log.Printf("CreateRun: persisting proactive suggestion failed (non-fatal): %v", uerr)
			return
		}
		wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Channel, data.ChannelId))
	})
```

- [ ] **Step 3: Add the import**

Add to the import block of `wshserver_runs.go`:

```go
	"github.com/wavetermdev/waveterm/pkg/jarvisproactive"
```

(`context`, `time`, `log`, `wstore`, `wcore`, `waveobj` are already imported — verify; do not duplicate.)

- [ ] **Step 4: Build**

Run: `go build ./...`
Expected: builds clean.

- [ ] **Step 5: Checkpoint**

Run: `go test ./pkg/wshrpc/... ./pkg/jarvisproactive/`
Expected: PASS — existing run/wshserver tests still green (the hook is additive and non-fatal); jarvisproactive green. Do not commit.

---

## Task 4: Frontend — proactive read/dismiss module

The pure FE contract mirror + the dismiss path. `readProactiveSuggestion` derives a view-model from `run.meta` (null unless a non-dismissed hit); `dismissProactive` hides the card immediately (module atom) and persists the dismissal durably. Unit-tested; no React.

**Files:**
- Create: `frontend/app/view/agents/proactive.ts`
- Test: `frontend/app/view/agents/proactive.test.ts`

**Interfaces:**
- Produces:
  - `PROACTIVE_META_KEY = "jarvis:proactive"`, `PROACTIVE_DISMISSED_KEY = "jarvis:proactive:dismissed"` (must equal the Go constants in `suggestion.go`).
  - `interface ProactiveVM { nodeId: string; sourceType: string; title: string; snippet: string; why: string }`
  - `function readProactiveSuggestion(run: Run): ProactiveVM | null`
  - `dismissedProactiveAtom` (jotai atom holding a `Set<string>` of dismissed run oids)
  - `function dismissProactive(run: Run): void`
- Consumes: `ObjectService.UpdateObjectMeta(oref, meta)` (`@/app/store/services`), `WOS.makeORef` (`@/app/store/wos`), `globalStore` (`@/app/store/jotaiStore`), `fireAndForget` (`@/util/util`), the ambient `Run`/`MetaType` global gotypes.

- [ ] **Step 1: Write the failing test**

Create `frontend/app/view/agents/proactive.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { readProactiveSuggestion } from "./proactive";

function run(meta: Record<string, unknown>): Run {
    return { oid: "run-1", meta } as unknown as Run;
}

describe("readProactiveSuggestion", () => {
    it("returns a view-model for a hit", () => {
        const vm = readProactiveSuggestion(
            run({
                "jarvis:proactive": {
                    status: "hit",
                    nodeId: "dec-1",
                    sourceType: "decision",
                    title: "Rate limiting",
                    snippet: "drop-oldest on overflow",
                    why: 'Related to "fix rate limit"',
                },
            })
        );
        expect(vm).not.toBeNull();
        expect(vm?.title).toBe("Rate limiting");
        expect(vm?.sourceType).toBe("decision");
    });

    it("returns null for the none sentinel", () => {
        expect(readProactiveSuggestion(run({ "jarvis:proactive": { status: "none" } }))).toBeNull();
    });

    it("returns null when there is no proactive meta", () => {
        expect(readProactiveSuggestion(run({}))).toBeNull();
    });

    it("returns null when dismissed via the meta flag", () => {
        expect(
            readProactiveSuggestion(
                run({
                    "jarvis:proactive": { status: "hit", nodeId: "d", sourceType: "decision", title: "x", snippet: "y", why: "z" },
                    "jarvis:proactive:dismissed": true,
                })
            )
        ).toBeNull();
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run frontend/app/view/agents/proactive.test.ts`
Expected: FAIL — `./proactive` module not found.

- [ ] **Step 3: Write `proactive.ts`**

Create `frontend/app/view/agents/proactive.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// S3 proactive resurfacing (read side). The suggestion is written to run.Meta by
// the backend at dispatch (pkg/jarvisproactive) and delivered via the run's
// waveobj:update. This module derives the card view-model and owns dismissal:
// an optimistic module atom hides it immediately; ObjectService.UpdateObjectMeta
// persists the flag so it stays gone across reload. Keys mirror the Go constants
// in pkg/jarvisproactive/suggestion.go — keep identical.

import { globalStore } from "@/app/store/jotaiStore";
import { ObjectService } from "@/app/store/services";
import * as WOS from "@/app/store/wos";
import { fireAndForget } from "@/util/util";
import { atom } from "jotai";

export const PROACTIVE_META_KEY = "jarvis:proactive";
export const PROACTIVE_DISMISSED_KEY = "jarvis:proactive:dismissed";

export interface ProactiveVM {
    nodeId: string;
    sourceType: string;
    title: string;
    snippet: string;
    why: string;
}

// dismissedProactiveAtom holds run oids dismissed this session, for an immediate
// optimistic hide independent of the persisted-meta round-trip.
export const dismissedProactiveAtom = atom<Set<string>>(new Set<string>());

export function readProactiveSuggestion(run: Run): ProactiveVM | null {
    const meta = run?.meta as Record<string, unknown> | undefined;
    if (!meta || meta[PROACTIVE_DISMISSED_KEY] === true) {
        return null;
    }
    const raw = meta[PROACTIVE_META_KEY] as Partial<ProactiveVM> & { status?: string };
    if (!raw || raw.status !== "hit") {
        return null;
    }
    return {
        nodeId: raw.nodeId ?? "",
        sourceType: raw.sourceType ?? "memory",
        title: raw.title ?? "",
        snippet: raw.snippet ?? "",
        why: raw.why ?? "",
    };
}

export function dismissProactive(run: Run): void {
    const oid = run?.oid;
    if (!oid) {
        return;
    }
    const next = new Set(globalStore.get(dismissedProactiveAtom));
    next.add(oid);
    globalStore.set(dismissedProactiveAtom, next);
    fireAndForget(() => ObjectService.UpdateObjectMeta(WOS.makeORef("run", oid), { [PROACTIVE_DISMISSED_KEY]: true }));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run frontend/app/view/agents/proactive.test.ts`
Expected: PASS (four tests).

- [ ] **Step 5: Checkpoint**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` and `npx vitest run frontend/app/view/agents/proactive.test.ts`
Expected: tsc exit 0 (baseline clean); tests PASS. Do not commit.

---

## Task 5: Frontend — the card component + run-body mount

Render one proactive card on the run body from the module in Task 4. Informational + dismissible; click-to-open the vault node is deferred (no Tasks/Graph surface exists yet — matches the non-interactive `RelevantDecisions` precedent in `ambientviews.tsx`).

**Files:**
- Create: `frontend/app/view/agents/proactiveviews.tsx`
- Modify: `frontend/app/view/agents/runbody.tsx` (import + mount below the run header)

**Interfaces:**
- Consumes (Task 4): `readProactiveSuggestion`, `dismissedProactiveAtom`, `dismissProactive`.
- Produces: `function ProactiveCard({ run }: { run: Run }): JSX.Element | null`.

- [ ] **Step 1: Write `proactiveviews.tsx`**

Create `frontend/app/view/agents/proactiveviews.tsx`:

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// S3 proactive-resurfacing card: one "related prior work" suggestion surfaced on a
// run at dispatch. Informational + dismissible; non-navigating this cycle (no Tasks
// surface exists yet — same posture as ambientviews.RelevantDecisions). Marked
// visually as ambient so it never reads as a confirmed edge.

import { useAtomValue } from "jotai";
import { dismissProactive, dismissedProactiveAtom, readProactiveSuggestion } from "./proactive";

export function ProactiveCard({ run }: { run: Run }) {
    const dismissed = useAtomValue(dismissedProactiveAtom);
    const vm = readProactiveSuggestion(run);
    if (!vm || dismissed.has(run.oid)) {
        return null;
    }
    return (
        <div className="mb-3 flex items-start gap-2 rounded-[9px] border border-border bg-surface px-3 py-2">
            <div className="min-w-0 flex-1">
                <div className="mb-0.5 font-mono text-[9px] font-semibold uppercase tracking-[.08em] text-muted">
                    Related prior work · {vm.sourceType}
                </div>
                <div className="truncate text-[12.5px] font-semibold text-secondary" title={vm.title}>
                    {vm.title}
                </div>
                {vm.snippet ? <div className="mt-0.5 line-clamp-2 text-[11px] text-muted">{vm.snippet}</div> : null}
            </div>
            <button
                type="button"
                aria-label="Dismiss suggestion"
                onClick={() => dismissProactive(run)}
                className="flex-none rounded-[4px] px-1.5 py-px text-[13px] leading-none text-muted hover:text-secondary"
            >
                ×
            </button>
        </div>
    );
}
```

- [ ] **Step 2: Mount it in `runbody.tsx`**

Add the import alongside the other `./` view imports (near line 37, next to `AmbientTags`):

```tsx
import { ProactiveCard } from "./proactiveviews";
```

Render it directly below the run header row (the `<div className="mb-4 flex items-start gap-3">…</div>` block that holds `StatusPill` / `AmbientTags` / the goal), before the steer/composer area:

```tsx
            <ProactiveCard run={run} />
```

- [ ] **Step 3: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0 (baseline clean).

- [ ] **Step 4: Checkpoint**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` and `npx vitest run frontend/app/view/agents/proactive.test.ts`
Expected: tsc exit 0; tests PASS. Do not commit.

---

## Task 6: CDP surface-smoke + deferred-tunables doc

Prove the render + dismiss + persistence end-to-end against the live dev app by injecting a run whose `meta` already carries a proactive hit (the backend eval pipeline is covered by Task 2's Go tests; CDP does not need live embeddings/model). Record the PLACEHOLDER tunables.

**Files:**
- Modify: `scripts/cdp/scenarios.mjs` (add a `jarvis-proactive` scenario)
- Modify: `docs/deferred.md` (S3 tunables + deferrals)

**Interfaces:**
- Consumes: the CDP scenario harness (`arrange → goto → shot → assert → teardown`) in `scripts/cdp/scenarios.mjs`; the run-injection helper pattern used by existing agent scenarios (`node scripts/inject-live-agents.mjs`). The injected run's `meta["jarvis:proactive"]` = `{ status: "hit", nodeId, sourceType, title, snippet, why }`.

- [ ] **Step 1: Add the `jarvis-proactive` CDP scenario**

In `scripts/cdp/scenarios.mjs`, add a scenario following the existing pattern (mirror the closest run-rendering scenario for `arrange`/`goto`/`teardown`; the two novel asserts are below). The scenario must:
1. **arrange:** inject/select a channel with one run whose `meta["jarvis:proactive"]` is a hit suggestion (`{ status: "hit", nodeId: "dec-demo", sourceType: "decision", title: "Drop-oldest on overflow", snippet: "chose drop-oldest to bound memory", why: "Related to this run" }`), navigate to that run.
2. **assert (card visible):** the run body contains text "Related prior work" and the suggestion title.
3. **assert (dismiss sticks):** click the "Dismiss suggestion" button → the card disappears; reload the page → the card is still absent (the `jarvis:proactive:dismissed` flag persisted through `UpdateObjectMeta`).

Follow the file's existing assert style (DOM query via `Runtime.evaluate`, PASS/FAIL return). Do not hand-edit unrelated scenarios.

- [ ] **Step 2: Run the scenario**

Run: `task verify:ui -- jarvis-proactive`
Expected: PASS row for `jarvis-proactive`; contact sheet updated in `cdp-shots/index.html`.

> If `:9222` refuses the connection mid-run, another session's edit likely crashed `task dev` — check the dev log for "going away", restart dev, retry (see the CDP gotchas in memory). A blank page after this session's own FE edits needs a full `location.reload()`.

- [ ] **Step 3: Record the deferred tunables + deferrals**

Append to `docs/deferred.md` an S3 section recording, verbatim, the PLACEHOLDER constants and their homes, plus the deferrals:

```markdown
## Jarvis S3 — proactive resurfacing (2026-07-24)

PLACEHOLDER tunables (calibrate against a populated, embedded vault):
- `pkg/jarvisproactive/gate.go`: `queryK = 8`, `cosThreshold = 0.82` (deliberately high), `shortlistMax = 5`, and the `buildJudgePrompt` wording.
- `pkg/wshrpc/wshserver/wshserver_runs.go`: `proactiveDispatchTimeout = 90s`.

Deferred out of the S3 first cycle:
- Triggers other than Run dispatch — rest-boundary/continuity resurfacing (would wire E's exposed-but-unwired `jarviscontinuity.Resume`), and conversation-turn resurfacing.
- Global proactive feed / cross-event inbox (card is run-anchored only).
- Ranked lists (single best match only).
- Click-to-open the cited vault node (`vault:<id>` deep-link) — no Tasks (U2) / Graph (U3) surface exists yet; the card is informational this cycle, matching the non-interactive `ambientviews.RelevantDecisions` precedent.
- An "Ask Jarvis about this" card action.
- Model tiering (interim capable model, shared deferred lever).
- Auto-promotion of a surfaced insight into `memory/**` (v3; stays human-gated).
```

- [ ] **Step 4: Checkpoint**

Run: `task verify:ui -- jarvis-proactive`
Expected: PASS. Do not commit.

---

## Finalization (after all tasks green, on explicit approval)

Per the user's STRICT git workflow, the feature is committed **once**, only after the user approves:

1. Update the v2 meta-spec tracking table (`docs/superpowers/specs/2026-07-24-jarvis-second-brain-v2-meta-spec.md`) — fill the **S3 row** (`Spec` / `Plan` links + a one-paragraph "Built" summary), matching the S1/S2/U1 row style.
2. Stage the feature: `pkg/jarvisproactive/*`, the `wshserver_runs.go` hook, the three frontend files, the CDP scenario, `docs/deferred.md`, **the S3 spec doc** (folded in — never a docs-only commit), the S3 **plan doc**, and the meta-spec tracking-table edit.
3. One commit. End the commit message body with the co-author trailer per the project convention.

**Do not** create a separate docs-only commit for the spec/plan, and **do not** commit before approval.

---

## Self-Review

**Spec coverage:**
- Dispatch trigger + off-band hook → Task 3. ✓
- Two-stage gate (high-threshold pre-filter → capable-model single-best/none) → Task 1 (`prefilter`, `buildJudgePrompt`, `parseJudgeReply`) + Task 2 (`evaluate` orchestration, `judge`). ✓
- One card, single best match → Task 1 `shortlistMax` + Task 2 single-pick; Task 5 renders one. ✓
- Compute once, persist on `run.Meta`, sticky dismissal → Task 2 (`ProactiveSuggestion` incl. "none" sentinel) + Task 3 (persist) + Task 4 (dismiss: optimistic atom + `UpdateObjectMeta`). ✓
- Delivery via run `waveobj:update`, no new stream → Task 3 (`SendWaveObjUpdate` on the channel oref, mirroring the proven run-update path). ✓
- Self-exclusion of the run's own dossier → Task 2 (`ownDossierID`) + `TestEvaluateSelfExclusion`. ✓
- Graceful degradation (flag off / query error / model error → no card, never error) → Task 2 (`evaluate` returns nil / "none") + `TestEvaluateDisabledIndexIsNoop`. ✓
- No RPC / wps / WaveObj / migration / `task generate` → nothing in the file-touch set adds any; dismissal uses existing `ObjectService.UpdateObjectMeta`. ✓
- Testing: Go pipeline tests (Tasks 1-2), FE unit (Task 4), CDP render/dismiss (Task 6). ✓

**Placeholder scan:** No "TBD"/"implement later"/"add error handling" — every code step shows complete code; tunables are explicitly `// PLACEHOLDER` (a spec requirement, recorded in `docs/deferred.md`), not plan gaps.

**Type consistency:** `EvaluateDispatch(ctx, *waveobj.Run) (*ProactiveSuggestion, error)`, `evaluate(ctx, *jarvisembed.Index, *wavevault.Vault, *waveobj.Run)`, `prefilter([]ScoredChunk, string) []candidate`, `parseJudgeReply(string, int) int`, `judge(ctx, cwd, prompt) (string, error)`, and the meta keys `jarvis:proactive` / `jarvis:proactive:dismissed` are used identically across Go (Tasks 1-3) and TS (`PROACTIVE_META_KEY`/`PROACTIVE_DISMISSED_KEY`, Tasks 4-5). `ProactiveSuggestion` json tags (`status`/`nodeId`/`sourceType`/`title`/`snippet`/`why`) match the TS `ProactiveVM` fields + the `readProactiveSuggestion` reader.

**Two assumptions to confirm at execution time (fallbacks noted, non-blocking):**
- `wavevault.Retriever.Read(id)` arity — `titleForNode` falls back to the section-heading title if it differs (Task 2 note).
- `ObjectService.UpdateObjectMeta` merges (does not replace) the run's meta — the standard Wave meta-write behavior; the optimistic `dismissedProactiveAtom` makes dismissal correct in-session even if persistence round-trips differently.
