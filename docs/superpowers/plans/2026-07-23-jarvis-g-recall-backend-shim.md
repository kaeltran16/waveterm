# Jarvis G — Plan 2: Recall backend shim + wire Recall mode to real SQLite

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Jarvis Recall surface's fixture source with a real backend: a new streaming wshrpc command `JarvisConverseCommand` that deterministically retrieves a bounded slice of existing Wave objects (runs, radar findings, memory notes), builds grounding cards in code, runs one `claude -p` synthesis over them, and streams working-steps + grounded prose + a terminal — consumed by a now-writable Jarvis conversation store driven from the composer.

**Architecture:** Go is the source of truth for the wire types (a discriminated `JarvisConverseChunk`), regenerated to TS via `task generate`. Grounding is **deterministic and free** — the shim builds every `GroundingCard` from the retrieved objects in Go; the model only writes the prose and picks which `[n]` to cite. Retrieval, card-building, terminal selection, and citation-counting are **pure functions** in a new `pkg/jarvisrecall/` package (unit-tested with Go's `testing`); the DB glue and the model call are a thin orchestrator. On the frontend, the read-only fixture-derived `activeConversationAtom` becomes a writable store keyed by conversation id (mirroring `channelsstore.ts`), and the composer's submit runs the stream under `fireAndForget` into module atoms so an in-flight turn survives the surface unmounting on nav-switch. The dev fixture bar and all Plan 1 CDP scenarios are preserved.

**Tech Stack:** Go (`pkg/wshrpc`, `pkg/wstore`, `pkg/consult`, `pkg/memvault`), the wshrpc responsestream codegen (`task generate`), React 19 + jotai, Vitest, Go `testing`, the repo's CDP scenario harness (`scripts/cdp/`).

**This is Plan 2 of ~4 for sub-project G** (see the [G spec](../specs/2026-07-23-jarvis-ui-surface-design.md) §9 and [Plan 1](2026-07-23-jarvis-g-surface-shell-and-contract.md)):
- Plan 1 (done): surface shell + G⇄F conversation contract + surface states on fixtures.
- **Plan 2 (this):** backend shim `JarvisConverseCommand` (Go) + wire Recall mode to real recall over SQLite. ← makes recall real.
- Plan 3: fleet-manager migration into the surface + Channels removal + `@jarvis` reroute.
- Plan 4: `Ctrl+P` "ask-jarvis" lead group + quick-ask states (8–10) + contextual entries + ambient fixtures + real `[n]`/card navigation.

## What this plan deliberately does NOT do (shim limits, per spec §"Backend" and the meta-spec seam)

- **No vault, no `[[wikilink]]` traversal, no learning-store materialization, no attribution edges.** Those are sub-projects A/B/C/D and replace this shim behind the same `JarvisConverseChunk` protocol later.
- **No full-text index.** Retrieval is load-all-then-filter in Go (the stores have no FTS). Fine at current data volumes; the meta-spec's "structured WHERE + full-text" (layers 1–2) is a vault-era capability.
- **Only three source types are real:** `run`, `radar`, `memory`. `decision` has **no backend store at all**; `channel`/`commit`/`agent`/`session`/`task` have no clean recall mapping yet. These stay in the type enum but are **fixture-only** until B/C/D land. Do not fabricate a store for them.
- **Freshness is essentially `fresh` for shim cards** (they are freshly retrieved from the live store each turn), with **one real exception**: a memory note carrying a gardener flag or a `superseded_by` is surfaced as `stale`. `stale`/`unavailable` as general states remain **fixture-covered** (Plan 1 states 5–7) until the learning store (C) can re-resolve an old citation. This is honest, not a gap.
- **Scope wiring is partial on the FE.** The Go shim implements all four scope modes (`object`/`project`/`all`/`attached`) and they are unit-tested; the composer sends `all` for a new conversation. `object`/`project`/`attached` are driven from contextual entries in **Plan 4**.
- **`[n]` citation click and grounding-card click stay `console.log` stubs** (Plan 1 behavior). Real native-surface navigation is Plan 4. This side-steps the fact that `memory:` navTargets are not parseable ORefs.

## Global Constraints

Every task's requirements implicitly include these. Values copied verbatim from the spec, Plan 1, CLAUDE.md, and the codebase.

- **Go is the source of truth for wire types.** Never hand-edit generated files (`frontend/app/store/wshclientapi.ts`, `frontend/types/gotypes.d.ts`, `pkg/wshrpc/wshclient/wshclient.go`). Edit the Go interface + structs, then run **`task generate`**.
- **A responsestream command is minted purely by returning `chan wshrpc.RespOrErrorUnion[T]`** from the interface method — there is no attribute tag, no string constant. Codegen derives the wire name by lowercasing the method minus the `Command` suffix (`JarvisConverseCommand` → `"jarvisconverse"`).
- **No compile-time interface conformance check exists.** A declared-but-unimplemented command builds green and only fails at call time with a logged `WARNING: method ... does not match`. The impl lands in Task 3; nothing calls the command before Task 5, so the interim is harmless — but do not ship the cycle without the impl.
- **Timeouts, two layers** (mirror `JarvisCommand`): the FE passes `{ timeout: 130_000 }` in `RpcOpts` (the RPC budget; the default is 5s and would kill the stream); the server wraps the model run in `context.WithTimeout(ctx, 120*time.Second)`. The 10s gap is deliberate slack.
- **The `claude -p` primitive is `pkg/consult`** — `spec, ok := consult.SpecFor("claude")` then `consult.Run(ctx, spec, cwd, prompt, emit)`. Do **not** re-implement `exec.Command`. Do **not** use `aiusechat` (slated for removal ~Phase 6).
- **Grounding is deterministic (invariant 1 + 7).** Build every card in Go from the retrieved object. The model never invents a source. `notfound` (zero candidates) is decided in Go **without a model call** (free).
- **Scope enforcement in code, not prompt (invariant 4).** The retriever is filtered by the scope handed to it; the model is never asked to "ignore" objects.
- **Path-separator gotcha.** `Run.ProjectPath` is raw (backslashes on Windows); radar canonicalizes to forward slashes. Any project-equality/label logic must normalize separators.
- **Surface unmounts on nav-switch** (only the agent surface stays mounted). All survive-worthy state — including an in-flight streaming turn — lives in `jarvisstore.ts` module atoms written via `globalStore.set`, never component `useState`. The streaming loop runs under `fireAndForget` so it keeps writing after the surface unmounts.
- **Dark mode only; `@theme` tokens** (`frontend/tailwindsetup.css`) — never raw hex; existing cockpit fonts; restrained motion. (No new components need styling in Plan 2 — the renderer from Plan 1 is already streaming-ready.)
- **No jsdom render tests.** Pure logic → Vitest (FE) / `go test` (backend); rendering → CDP `verify:ui`. Preserve every Plan 1 CDP scenario.
- **Typecheck (FE)** with `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (bare `npx tsc` overflows). Baseline is clean; any error it reports is yours.
- **Vitest single file:** `node node_modules/vitest/vitest.mjs run frontend/app/view/jarvis/<file>.test.ts`. **Go tests:** `go test ./pkg/jarvisrecall/`.
- **Git (per CLAUDE.md):** commits need explicit user approval and are batched — do NOT auto-commit or push. Each task's final step is **"stage + checkpoint for review."** The plan/spec docs fold into the one feature commit at the end.
- **`prettier --write` gotcha:** never run it on `scripts/cdp/*.mjs` (`.editorconfig` omits `.mjs` → 2-space reindent). Hand-match 4-space style.

## File Structure

New (backend, all under `pkg/jarvisrecall/`):

| File | Responsibility |
|---|---|
| `cards.go` | Pure helpers: `candidate` type, per-type mappers (`runCandidate`/`radarCandidate`/`memoryCandidate`), `buildCards`, `buildPrompt`, `selectTerminal`, `countCitations`, `projectLabel`, `memoryFreshness`, `inScope`, `scopeProject`, `sortByRecency`. No DB, no process — unit-tested. |
| `recall.go` | `Converse(ctx, data, emit)` orchestrator + `retrieve(ctx, data)` DB glue. Emits the chunk protocol; calls `consult.Run`. |
| `cards_test.go` | Go unit tests for every pure helper in `cards.go`. |

Modified (backend):

| File | Change |
|---|---|
| `pkg/wshrpc/wshrpctypes_jarvis.go` | Add `JarvisConverseCommand` to the `JarvisCommands` interface (streaming); add `CommandJarvisConverseData`, `JarvisWorkingStep`, `JarvisGroundingCard`, `JarvisConverseChunk` structs. |
| `pkg/wshrpc/wshserver/wshserver_jarvis.go` | Add the `JarvisConverseCommand` server method delegating to `jarvisrecall.Converse`. |
| generated: `wshclient.go`, `wshclientapi.ts`, `gotypes.d.ts` | Regenerated by `task generate` (do not hand-edit). |

New/modified (frontend, under `frontend/app/view/jarvis/`):

| File | Change |
|---|---|
| `recallderive.ts` | Add pure `parseCitations(text, cards): AnswerSegment[]` + `mapWireCard(w): GroundingCard`. |
| `recallderive.test.ts` | Add tests for `parseCitations` + `mapWireCard`. |
| `jarvisstore.ts` | Add writable `conversationsByIdAtom` + `activeConversationIdAtom`; re-derive `activeConversationAtom` (real → fixture fallback) and `conversationsAtom` (real + fixtures); add module fns `startConversation`, `selectConversation`, `submitJarvisQuery`, and the streaming internals; add `jarvisDraftAtom`. |
| `historyrail.tsx` | Select real conversations via `selectConversation`; active-row state honors `activeConversationIdAtom`. |
| `composer.tsx` | Enable the input; wire Enter → `startConversation`/`submitJarvisQuery`; bind text to `jarvisDraftAtom`. |

---

### Task 1: Wire types + codegen

**Files:**
- Modify: `pkg/wshrpc/wshrpctypes_jarvis.go`

**Interfaces:**
- Consumes: `RespOrErrorUnion[T]` (from `wshrpctypes.go`).
- Produces (Go): `CommandJarvisConverseData`, `JarvisWorkingStep`, `JarvisGroundingCard`, `JarvisConverseChunk`; the interface method `JarvisConverseCommand(ctx, CommandJarvisConverseData) chan RespOrErrorUnion[JarvisConverseChunk]`. Produces (generated TS): `CommandJarvisConverseData`, `JarvisWorkingStep`, `JarvisGroundingCard`, `JarvisConverseChunk` in `gotypes.d.ts`; `RpcApi.JarvisConverseCommand(client, data, opts?): AsyncGenerator<JarvisConverseChunk, void, boolean>` in `wshclientapi.ts`.

- [ ] **Step 1: Add the request + chunk structs**

In `pkg/wshrpc/wshrpctypes_jarvis.go`, add (near the existing `CommandJarvisData` / `JarvisChunk`):

```go
// CommandJarvisConverseData is one recall conversation turn: a question plus the resolved scope. The shim
// (pkg/jarvisrecall) filters retrieval by ScopeMode; the model is never asked to ignore out-of-scope objects.
type CommandJarvisConverseData struct {
	ConversationId string   `json:"conversationid"`
	Prompt         string   `json:"prompt"`
	ScopeMode      string   `json:"scopemode"`            // object | project | all | attached
	ProjectPath    string   `json:"projectpath,omitempty"`
	AttachedORefs  []string `json:"attachedorefs,omitempty"`
	RequestId      string   `json:"requestid"`
}

// JarvisWorkingStep is one deterministic retrieval/synthesis step, streamed as it runs.
type JarvisWorkingStep struct {
	Id     string `json:"id"`
	Label  string `json:"label"`
	Status string `json:"status"` // done | active | pending
}

// JarvisGroundingCard is one retrieved source, built DETERMINISTICALLY in Go (not by the model). AgeMs is a
// snapshot at synthesis time. NavTarget is an ORef for run/radar (run:<uuid>, radarreport:<uuid>) or a
// synthetic ref for memory (memory:<slug>, not a parseable ORef; real nav is Plan 4).
type JarvisGroundingCard struct {
	N          int    `json:"n"`
	SourceType string `json:"sourcetype"` // run | radar | memory (shim); others are contract-forward
	Title      string `json:"title"`
	Project    string `json:"project"`
	AgeMs      int64  `json:"agems"`
	Freshness  string `json:"freshness"` // fresh | stale | unavailable
	NavTarget  string `json:"navtarget"`
}

// JarvisConverseChunk is one streamed update. Exactly one payload is meaningful per chunk, keyed by Kind:
//   - "step":      Step is set (a working-step lifecycle update)
//   - "grounding": Grounding is set (one deterministic source card)
//   - "text":      Text is set (an incremental fragment of the model's prose answer)
//   - "terminal":  Terminal is set (answered | weak | notfound; the last chunk of the turn)
type JarvisConverseChunk struct {
	Kind      string               `json:"kind"`
	Step      *JarvisWorkingStep   `json:"step,omitempty"`
	Grounding *JarvisGroundingCard `json:"grounding,omitempty"`
	Text      string               `json:"text,omitempty"`
	Terminal  string               `json:"terminal,omitempty"`
}
```

- [ ] **Step 2: Add the interface method**

In the same file, add to the `JarvisCommands` interface (streaming = returns a channel):

```go
	JarvisConverseCommand(ctx context.Context, data CommandJarvisConverseData) chan RespOrErrorUnion[JarvisConverseChunk] // recall shim: streams working-steps + grounding + prose + terminal
```

- [ ] **Step 3: Verify the package still compiles**

Run: `go build ./pkg/wshrpc/...`
Expected: exit 0. (The method has no impl yet — that is fine; conformance is checked at runtime, not compile time. No caller exists until Task 5.)

- [ ] **Step 4: Regenerate bindings**

Run: `task generate`
Expected: exit 0. It runs `generatets` then `generatego`; both reflect over the interface. If it fails, the new structs likely don't compile — fix them first (see Step 3).

- [ ] **Step 5: Confirm the generated artifacts**

Verify the generated files gained the symbols (read-only checks; do not edit):
- `frontend/types/gotypes.d.ts` contains `type JarvisConverseChunk`, `type JarvisGroundingCard`, `type JarvisWorkingStep`, `type CommandJarvisConverseData` (keys are the lowercase JSON tags: `sourcetype`, `agems`, `navtarget`, `scopemode`, …).
- `frontend/app/store/wshclientapi.ts` contains a `// command "jarvisconverse" [responsestream]` method `JarvisConverseCommand(client, data, opts?): AsyncGenerator<JarvisConverseChunk, void, boolean>`.
- `pkg/wshrpc/wshclient/wshclient.go` contains `func JarvisConverseCommand(...) chan wshrpc.RespOrErrorUnion[wshrpc.JarvisConverseChunk]`.

Run to check: `git status --short frontend/types/gotypes.d.ts frontend/app/store/wshclientapi.ts pkg/wshrpc/wshclient/wshclient.go` (all three should show as modified).

- [ ] **Step 6: FE typecheck** (`node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`, exit 0 — the new generated types must not break the baseline), then **stage + checkpoint** (`git add` the edited + generated files; do not commit).

---

### Task 2: Recall pure helpers (`pkg/jarvisrecall/cards.go`)

**Files:**
- Create: `pkg/jarvisrecall/cards.go`
- Test: `pkg/jarvisrecall/cards_test.go`

**Interfaces:**
- Consumes: `wshrpc.{CommandJarvisConverseData, JarvisGroundingCard}`, `waveobj.{Run, RadarReport, RadarFinding, MakeORef, OType_Run, OType_RadarReport}`, `memvault.Note`.
- Produces: the `candidate` struct; `runCandidate(*waveobj.Run) candidate`; `radarCandidate(*waveobj.RadarReport, waveobj.RadarFinding) candidate`; `memoryCandidate(memvault.Note) candidate`; `buildCards([]candidate, int64) []wshrpc.JarvisGroundingCard`; `buildPrompt(string, []candidate) string`; `selectTerminal(cardCount, citationCount int) string`; `countCitations(string, int) int`; `projectLabel(string) string`; `memoryFreshness(memvault.Note) string`; `inScope(wshrpc.CommandJarvisConverseData, sourceType, project string) bool`; `scopeProject(wshrpc.CommandJarvisConverseData) string`; `sortByRecency([]candidate)`.

- [ ] **Step 1: Write the failing tests**

Create `pkg/jarvisrecall/cards_test.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvisrecall

import (
	"testing"

	"github.com/wavetermdev/waveterm/pkg/memvault"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

func TestSelectTerminal(t *testing.T) {
	cases := []struct {
		cards, cites int
		want         string
	}{
		{0, 0, "notfound"},
		{3, 0, "weak"},
		{3, 2, "answered"},
		{1, 1, "answered"},
	}
	for _, c := range cases {
		if got := selectTerminal(c.cards, c.cites); got != c.want {
			t.Errorf("selectTerminal(%d,%d)=%q want %q", c.cards, c.cites, got, c.want)
		}
	}
}

func TestCountCitations(t *testing.T) {
	// distinct in-range refs only; [4] is out of range (2 cards), [0] invalid
	if got := countCitations("see [1] and [2] and again [1] plus [4] and [0]", 2); got != 2 {
		t.Errorf("countCitations=%d want 2", got)
	}
	if got := countCitations("no citations here", 3); got != 0 {
		t.Errorf("countCitations=%d want 0", got)
	}
}

func TestProjectLabel(t *testing.T) {
	if got := projectLabel(`C:\Users\me\IdeaProjects\waveterm`); got != "waveterm" {
		t.Errorf("projectLabel(win)=%q want waveterm", got)
	}
	if got := projectLabel("/home/me/src/waveterm/"); got != "waveterm" {
		t.Errorf("projectLabel(posix)=%q want waveterm", got)
	}
	if got := projectLabel(""); got != "" {
		t.Errorf("projectLabel(empty)=%q want empty", got)
	}
}

func TestRunCandidate(t *testing.T) {
	r := &waveobj.Run{OID: "11111111-1111-1111-1111-111111111111", Goal: "shard fan-out", ProjectPath: `C:\src\waveterm`, Status: "done", CreatedTs: 1000, CompletedTs: 2000}
	c := runCandidate(r)
	if c.sourceType != "run" || c.title != "shard fan-out" || c.project != "waveterm" {
		t.Errorf("runCandidate fields wrong: %+v", c)
	}
	if c.ts != 2000 {
		t.Errorf("runCandidate ts=%d want 2000 (CompletedTs)", c.ts)
	}
	if c.navTarget != "run:11111111-1111-1111-1111-111111111111" {
		t.Errorf("runCandidate navTarget=%q", c.navTarget)
	}
	if c.freshness != "fresh" {
		t.Errorf("runCandidate freshness=%q want fresh", c.freshness)
	}
}

func TestMemoryFreshness(t *testing.T) {
	if memoryFreshness(memvault.Note{}) != "fresh" {
		t.Error("clean note should be fresh")
	}
	if memoryFreshness(memvault.Note{GardenerFlag: "stale"}) != "stale" {
		t.Error("gardener-flagged note should be stale")
	}
	if memoryFreshness(memvault.Note{SupersededBy: "newer-note"}) != "stale" {
		t.Error("superseded note should be stale")
	}
}

func TestBuildCards(t *testing.T) {
	cands := []candidate{
		{sourceType: "run", title: "a", project: "p", ts: 500, freshness: "fresh", navTarget: "run:x"},
		{sourceType: "memory", title: "b", project: "q", ts: 900, freshness: "stale", navTarget: "memory:b"},
	}
	cards := buildCards(cands, 1000)
	if len(cards) != 2 || cards[0].N != 1 || cards[1].N != 2 {
		t.Fatalf("buildCards N wrong: %+v", cards)
	}
	if cards[0].AgeMs != 500 || cards[1].AgeMs != 100 {
		t.Errorf("buildCards AgeMs wrong: %+v", cards)
	}
	if cards[1].SourceType != "memory" || cards[1].Freshness != "stale" {
		t.Errorf("buildCards mapping wrong: %+v", cards[1])
	}
}

func TestInScope(t *testing.T) {
	all := wshrpc.CommandJarvisConverseData{ScopeMode: "all"}
	if !inScope(all, "run", `C:\src\waveterm`) {
		t.Error("all scope should include everything")
	}
	proj := wshrpc.CommandJarvisConverseData{ScopeMode: "project", ProjectPath: "/src/waveterm"}
	if !inScope(proj, "run", `C:\src\waveterm`) {
		t.Error("project scope should match normalized paths")
	}
	if inScope(proj, "run", "/src/other") {
		t.Error("project scope should exclude a different project")
	}
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `go test ./pkg/jarvisrecall/`
Expected: FAIL / build error (`jarvisrecall` has no such symbols).

- [ ] **Step 3: Write the implementation**

Create `pkg/jarvisrecall/cards.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Package jarvisrecall is the Plan-2 recall SHIM behind the Jarvis conversation backend (sub-project F).
// It retrieves a bounded slice of EXISTING Wave objects (runs, radar findings, memory notes), builds
// grounding deterministically, and runs one claude synthesis over it. The real recall engine (sub-project
// C: vault, wikilink traversal, learning store) replaces this behind the same JarvisConverseChunk protocol.
// This file holds the pure, process-free, DB-free helpers so they are unit-testable in isolation.
package jarvisrecall

import (
	"fmt"
	"path"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/memvault"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

// maxCandidates caps the assembled slice fed to the model (recency-ordered). Bounds prompt size + cost.
const maxCandidates = 12

// candidate is one retrieved source before it is numbered into a grounding card. snippet feeds the prompt
// only (it is not sent to the FE as part of the card).
type candidate struct {
	sourceType string
	title      string
	project    string
	ts         int64
	freshness  string
	navTarget  string
	snippet    string
}

func runCandidate(r *waveobj.Run) candidate {
	ts := r.CreatedTs
	if r.CompletedTs > 0 {
		ts = r.CompletedTs
	}
	snippet := "status: " + r.Status
	if r.Evidence != nil && r.Evidence.Summary != "" {
		snippet = r.Evidence.Summary
	}
	return candidate{
		sourceType: "run",
		title:      r.Goal,
		project:    projectLabel(r.ProjectPath),
		ts:         ts,
		freshness:  "fresh",
		navTarget:  waveobj.MakeORef(waveobj.OType_Run, r.OID).String(),
		snippet:    snippet,
	}
}

func radarCandidate(rep *waveobj.RadarReport, f waveobj.RadarFinding) candidate {
	ts := rep.StartedTs
	if rep.CompletedTs > 0 {
		ts = rep.CompletedTs
	}
	return candidate{
		sourceType: "radar",
		title:      "Finding: " + f.Risk,
		project:    rep.ProjectName,
		ts:         ts,
		freshness:  "fresh",
		navTarget:  waveobj.MakeORef(waveobj.OType_RadarReport, rep.OID).String(),
		snippet:    f.Why,
	}
}

func memoryCandidate(n memvault.Note) candidate {
	return candidate{
		sourceType: "memory",
		title:      n.Title,
		project:    n.Scope,
		ts:         n.UpdatedTs,
		freshness:  memoryFreshness(n),
		navTarget:  "memory:" + n.ID, // NOT a parseable ORef; real nav is Plan 4
		snippet:    n.Description,
	}
}

// memoryFreshness is the shim's one real freshness signal: the gardener marks stale/drift/duplicate notes
// and superseded notes, deterministically (pkg/memgarden). Everything else the shim retrieves is fresh.
func memoryFreshness(n memvault.Note) string {
	if n.GardenerFlag != "" || n.SupersededBy != "" {
		return "stale"
	}
	return "fresh"
}

// projectLabel is the basename of a project path, separator-normalized (Run.ProjectPath is raw/backslashed
// on Windows). Empty in, empty out.
func projectLabel(p string) string {
	if p == "" {
		return ""
	}
	p = strings.ReplaceAll(p, "\\", "/")
	return path.Base(strings.TrimRight(p, "/"))
}

func buildCards(cands []candidate, nowMs int64) []wshrpc.JarvisGroundingCard {
	cards := make([]wshrpc.JarvisGroundingCard, 0, len(cands))
	for i, c := range cands {
		cards = append(cards, wshrpc.JarvisGroundingCard{
			N:          i + 1,
			SourceType: c.sourceType,
			Title:      c.title,
			Project:    c.project,
			AgeMs:      nowMs - c.ts,
			Freshness:  c.freshness,
			NavTarget:  c.navTarget,
		})
	}
	return cards
}

// buildPrompt assembles the numbered-source synthesis prompt. Source [n] aligns with card N == n. The model
// is instructed to cite [n] and never invent — grounding is deterministic; the model only writes prose.
func buildPrompt(question string, cands []candidate) string {
	var b strings.Builder
	b.WriteString("You are Jarvis, Wave's recall assistant. Answer the question using ONLY the numbered sources below.\n")
	b.WriteString("Cite every claim inline with [n] matching a source number. If the sources do not contain the answer, ")
	b.WriteString("say so plainly and cite nothing — never invent a fact or a citation.\n\n")
	b.WriteString("Question: " + question + "\n\nSources:\n")
	for i, c := range cands {
		b.WriteString(fmt.Sprintf("[%d] (%s · %s) %s\n", i+1, c.sourceType, c.project, c.title))
		if c.snippet != "" {
			b.WriteString("    " + strings.TrimSpace(c.snippet) + "\n")
		}
	}
	b.WriteString("\nAnswer concisely in prose with inline [n] citations.")
	return b.String()
}

// selectTerminal is the shim's grounding-quality verdict (spec invariant 7: weak/notfound are rewarded, not
// confabulated). Zero candidates => notfound (decided upstream without a model call). Candidates but the
// model cited none => weak. At least one in-range citation => answered.
func selectTerminal(cardCount, citationCount int) string {
	if cardCount == 0 {
		return "notfound"
	}
	if citationCount == 0 {
		return "weak"
	}
	return "answered"
}

var citationRe = regexp.MustCompile(`\[(\d+)\]`)

// countCitations counts DISTINCT in-range [n] references in the model's prose.
func countCitations(text string, cardCount int) int {
	seen := map[int]bool{}
	for _, m := range citationRe.FindAllStringSubmatch(text, -1) {
		n, err := strconv.Atoi(m[1])
		if err == nil && n >= 1 && n <= cardCount {
			seen[n] = true
		}
	}
	return len(seen)
}

// scopeProject returns the project filter for project-scope, else "" (no filter). GetRadarReports treats ""
// as "all reports".
func scopeProject(data wshrpc.CommandJarvisConverseData) string {
	if data.ScopeMode == "project" {
		return data.ProjectPath
	}
	return ""
}

// inScope decides whether a retrieved object passes the scope filter. object/attached scoping is applied at
// retrieval time (by ORef), so here they behave like "all"; project scope matches separator-normalized paths.
func inScope(data wshrpc.CommandJarvisConverseData, sourceType, project string) bool {
	if data.ScopeMode != "project" {
		return true
	}
	return normPath(project) == normPath(data.ProjectPath)
}

func normPath(p string) string {
	return strings.TrimRight(strings.ReplaceAll(p, "\\", "/"), "/")
}

// sortByRecency orders candidates newest-first (ties keep input order for determinism).
func sortByRecency(cands []candidate) {
	sort.SliceStable(cands, func(i, j int) bool { return cands[i].ts > cands[j].ts })
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `go test ./pkg/jarvisrecall/`
Expected: PASS (all tests). Fix any field-name mismatch against the real structs (`waveobj.Run` at `pkg/waveobj/wtype.go:247`, `RadarReport` at `:427`, `RadarFinding` at `:375`, `memvault.Note` at `pkg/memvault/memvault.go:23`).

- [ ] **Step 5: `go vet ./pkg/jarvisrecall/`** (exit 0), then **stage + checkpoint**.

---

### Task 3: Recall orchestrator + server command

**Files:**
- Create: `pkg/jarvisrecall/recall.go`
- Modify: `pkg/wshrpc/wshserver/wshserver_jarvis.go`

**Interfaces:**
- Consumes: `cards.go` helpers; `wstore.{DBGetAllObjsByType, GetRadarReports}`, `memvault.{ScanVault, VaultRoots}`, `consult.{SpecFor, Run}`, `wavebase.GetHomeDir`, `waveobj.{Run, OType_Run}`, `wshrpc.{CommandJarvisConverseData, JarvisConverseChunk, JarvisWorkingStep, RespOrErrorUnion}`, `panichandler.PanicHandler`.
- Produces: `type Emit func(wshrpc.JarvisConverseChunk)`; `Converse(ctx context.Context, data wshrpc.CommandJarvisConverseData, emit Emit) error`; the `(*WshServer).JarvisConverseCommand` method.

- [ ] **Step 1: Write the orchestrator**

Create `pkg/jarvisrecall/recall.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvisrecall

import (
	"context"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/consult"
	"github.com/wavetermdev/waveterm/pkg/memvault"
	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// synthTimeout caps the model run; kept below the FE's 130s RPC budget (mirror of consultTimeout).
const synthTimeout = 120 * time.Second

// Emit receives one streamed chunk. The caller (wshserver) forwards it onto the RPC channel.
type Emit func(wshrpc.JarvisConverseChunk)

func stepChunk(id, label, status string) wshrpc.JarvisConverseChunk {
	return wshrpc.JarvisConverseChunk{Kind: "step", Step: &wshrpc.JarvisWorkingStep{Id: id, Label: label, Status: status}}
}

// Converse is the recall pipeline: retrieve (deterministic, free) -> emit steps + grounding -> synthesize
// (one claude run) -> emit prose + terminal. notfound is decided without a model call. Grounding is built in
// Go; the model only writes prose and picks [n] to cite (spec invariants 1, 4, 7).
func Converse(ctx context.Context, data wshrpc.CommandJarvisConverseData, emit Emit) error {
	emit(stepChunk("retrieve", "Searching runs, radar, and memory", "active"))
	cands, err := retrieve(ctx, data)
	if err != nil {
		return err
	}
	emit(stepChunk("retrieve", "Searched runs, radar, and memory", "done"))

	cards := buildCards(cands, time.Now().UnixMilli())
	for i := range cards {
		c := cards[i]
		emit(wshrpc.JarvisConverseChunk{Kind: "grounding", Grounding: &c})
	}

	// not-found is free: no candidates => no model call.
	if len(cards) == 0 {
		emit(wshrpc.JarvisConverseChunk{Kind: "text", Text: "Not found. No Wave source in scope references this."})
		emit(wshrpc.JarvisConverseChunk{Kind: "terminal", Terminal: "notfound"})
		return nil
	}

	spec, ok := consult.SpecFor("claude")
	if !ok {
		emit(wshrpc.JarvisConverseChunk{Kind: "text", Text: "Recall requires the claude CLI, which is not available."})
		emit(wshrpc.JarvisConverseChunk{Kind: "terminal", Terminal: "weak"})
		return nil
	}

	emit(stepChunk("synthesize", "Synthesizing a grounded answer", "active"))
	prompt := buildPrompt(data.Prompt, cands)
	runCtx, cancel := context.WithTimeout(ctx, synthTimeout)
	defer cancel()
	var full strings.Builder
	_, runErr := consult.Run(runCtx, spec, synthCwd(data), prompt, func(chunk string) {
		full.WriteString(chunk)
		select {
		case <-runCtx.Done():
		default:
			emit(wshrpc.JarvisConverseChunk{Kind: "text", Text: chunk})
		}
	})
	emit(stepChunk("synthesize", "Synthesized a grounded answer", "done"))
	if runErr != nil {
		emit(wshrpc.JarvisConverseChunk{Kind: "terminal", Terminal: "weak"})
		return runErr
	}
	terminal := selectTerminal(len(cards), countCitations(full.String(), len(cards)))
	emit(wshrpc.JarvisConverseChunk{Kind: "terminal", Terminal: terminal})
	return nil
}

// synthCwd is the cwd for the claude run. Use the scoped project when known so claude discovers that repo's
// CLAUDE.md; otherwise the home dir (a valid dir is required).
func synthCwd(data wshrpc.CommandJarvisConverseData) string {
	if data.ProjectPath != "" {
		return data.ProjectPath
	}
	return wavebase.GetHomeDir()
}

// retrieve loads the in-scope slice of existing objects (runs, radar findings, memory notes), maps each to a
// candidate, and returns the recency-ordered top maxCandidates. Load-all-then-filter (the stores have no FTS).
func retrieve(ctx context.Context, data wshrpc.CommandJarvisConverseData) ([]candidate, error) {
	var cands []candidate

	runs, err := wstore.DBGetAllObjsByType[*waveobj.Run](ctx, waveobj.OType_Run)
	if err != nil {
		return nil, err
	}
	for _, r := range runs {
		if inScope(data, "run", r.ProjectPath) {
			cands = append(cands, runCandidate(r))
		}
	}

	reports, err := wstore.GetRadarReports(ctx, scopeProject(data))
	if err != nil {
		return nil, err
	}
	for _, rep := range reports {
		for _, f := range rep.Findings {
			if f.Group == "nolonger" || f.Group == "dismissed" || f.Group == "suppressed" {
				continue
			}
			cands = append(cands, radarCandidate(rep, f))
		}
	}

	// memory is markdown, not SQLite; a scan failure must not fail recall.
	if graph, gerr := memvault.ScanVault(memvault.VaultRoots()); gerr == nil && graph != nil {
		for _, n := range graph.Notes {
			if inScope(data, "memory", n.Scope) {
				cands = append(cands, memoryCandidate(n))
			}
		}
	}

	sortByRecency(cands)
	if len(cands) > maxCandidates {
		cands = cands[:maxCandidates]
	}
	return cands, nil
}
```

- [ ] **Step 2: Build the recall package**

Run: `go build ./pkg/jarvisrecall/`
Expected: exit 0. Reconcile any signature mismatch against the cited sources: `consult.Run` (`pkg/consult/exec.go:25`), `consult.SpecFor` (used at `pkg/wshrpc/wshserver/wshserver_jarvis.go:168`), `DBGetAllObjsByType` (`pkg/wstore/wstore_dbops.go:220`), `GetRadarReports` (`pkg/wstore/wstore_radarreport.go:37`), `ScanVault`/`VaultRoots` (`pkg/memvault/memvault.go:130,207`), `wavebase.GetHomeDir` (used at `memvault.go:208`).

- [ ] **Step 3: Add the server method**

In `pkg/wshrpc/wshserver/wshserver_jarvis.go`, add the import `"github.com/wavetermdev/waveterm/pkg/jarvisrecall"` and this method (mirrors `JarvisCommand`'s goroutine/panic/close shape):

```go
func (ws *WshServer) JarvisConverseCommand(ctx context.Context, data wshrpc.CommandJarvisConverseData) chan wshrpc.RespOrErrorUnion[wshrpc.JarvisConverseChunk] {
	rtn := make(chan wshrpc.RespOrErrorUnion[wshrpc.JarvisConverseChunk])
	go func() {
		defer func() {
			panichandler.PanicHandler("JarvisConverseCommand", recover())
		}()
		defer close(rtn)
		emit := func(chunk wshrpc.JarvisConverseChunk) {
			// live streaming is best-effort: never let a stalled consumer wedge the pipeline.
			select {
			case rtn <- wshrpc.RespOrErrorUnion[wshrpc.JarvisConverseChunk]{Response: chunk}:
			case <-ctx.Done():
			}
		}
		if err := jarvisrecall.Converse(ctx, data, emit); err != nil {
			rtn <- wshrpc.RespOrErrorUnion[wshrpc.JarvisConverseChunk]{Error: err}
		}
	}()
	return rtn
}
```

- [ ] **Step 4: Build the server**

Run: `go build ./pkg/wshrpc/...`
Expected: exit 0.

- [ ] **Step 5: Run the recall tests again** (guard against a mapping regression): `go test ./pkg/jarvisrecall/` → PASS.

- [ ] **Step 6: Rebuild the backend so the dev app serves the new command**

Run: `task build:backend`
Expected: exit 0 (produces `dist/bin/wavesrv*`). The running `task dev` picks up the new `wavesrv` on its next backend build / restart; the command is unreachable until the backend is rebuilt.

- [ ] **Step 7: Stage + checkpoint.**

---

### Task 4: FE — citation parser + writable conversation store

**Files:**
- Modify: `frontend/app/view/jarvis/recallderive.ts`
- Modify: `frontend/app/view/jarvis/recallderive.test.ts`
- Modify: `frontend/app/view/jarvis/jarvisstore.ts`
- Modify: `frontend/app/view/jarvis/historyrail.tsx`

**Interfaces:**
- Consumes: `AnswerSegment`, `GroundingCard`, `SourceType`, `Freshness`, `JarvisConversation` from `jarviscontract`; `JarvisConverseChunk`/`JarvisGroundingCard` (generated globals); `FIXTURES`, `FIXTURE_STATES` from `jarvisfixtures`; `globalStore` from `@/app/store/global`.
- Produces: `parseCitations(text: string, cards: GroundingCard[]): AnswerSegment[]`; `mapWireCard(w: JarvisGroundingCard): GroundingCard`; atoms `conversationsByIdAtom`, `activeConversationIdAtom`, `jarvisDraftAtom`; re-derived `activeConversationAtom`, `conversationsAtom`; module fns `startConversation(scope): string`, `selectConversation(id): void`, `getConversation(id)`, `setConversation(conv)`.

- [ ] **Step 1: Write the failing parser tests**

Add to `frontend/app/view/jarvis/recallderive.test.ts`:

```ts
import { mapWireCard, parseCitations } from "./recallderive";

describe("parseCitations", () => {
    const cards: GroundingCard[] = [
        { n: 1, sourceType: "run", title: "a", project: "p", ageMs: 0, freshness: "fresh", navTarget: "run:1" },
        { n: 2, sourceType: "decision", title: "b", project: "p", ageMs: 0, freshness: "fresh", navTarget: "dec:2" },
    ];
    it("splits prose into text + in-range citation segments", () => {
        expect(parseCitations("see [1] then [2].", cards)).toEqual([
            { text: "see " },
            { citationRef: 1 },
            { text: " then " },
            { citationRef: 2 },
            { text: "." },
        ]);
    });
    it("ignores out-of-range refs (leaves them as text)", () => {
        expect(parseCitations("ok [5] end", cards)).toEqual([{ text: "ok [5] end" }]);
    });
    it("handles no citations", () => {
        expect(parseCitations("plain text", cards)).toEqual([{ text: "plain text" }]);
    });
    it("handles an empty string", () => {
        expect(parseCitations("", cards)).toEqual([]);
    });
});

describe("mapWireCard", () => {
    it("maps snake/lowercase wire keys to the camelCase view-model", () => {
        const wire = { n: 3, sourcetype: "memory", title: "t", project: "waveterm", agems: 42, freshness: "stale", navtarget: "memory:x" };
        expect(mapWireCard(wire as JarvisGroundingCard)).toEqual({
            n: 3, sourceType: "memory", title: "t", project: "waveterm", ageMs: 42, freshness: "stale", navTarget: "memory:x",
        });
    });
});
```

Note: `recallderive.test.ts` already imports from `./jarviscontract`; if `GroundingCard`/`JarvisGroundingCard` are not yet imported there, add `import type { GroundingCard } from "./jarviscontract";` (top of file — check the existing imports first; `AnswerSegment`/`GroundingCard` are already imported per Plan 1). `JarvisGroundingCard` is a generated global (no import).

- [ ] **Step 2: Run to verify it fails**

Run: `node node_modules/vitest/vitest.mjs run frontend/app/view/jarvis/recallderive.test.ts`
Expected: FAIL (`parseCitations`/`mapWireCard` not exported).

- [ ] **Step 3: Implement the parser + mapper**

Add to `frontend/app/view/jarvis/recallderive.ts`:

```ts
import type { GroundingCard, Freshness, SourceType } from "./jarviscontract";

// parseCitations splits the model's prose into text + citation segments. Only [n] references matching a known
// grounding card are turned into citations; unknown refs stay literal text (never fabricate a citation). Runs
// on every streamed text chunk (accumulated raw text in, segments out) — must be pure and cheap.
export function parseCitations(text: string, cards: GroundingCard[]): AnswerSegment[] {
    const valid = new Set(cards.map((c) => c.n));
    const segs: AnswerSegment[] = [];
    const re = /\[(\d+)\]/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
        const n = Number(m[1]);
        if (!valid.has(n)) continue;
        if (m.index > last) segs.push({ text: text.slice(last, m.index) });
        segs.push({ citationRef: n });
        last = re.lastIndex;
    }
    if (last < text.length) segs.push({ text: text.slice(last) });
    return segs;
}

// mapWireCard converts a generated JarvisGroundingCard (snake/lowercase JSON keys) into the camelCase
// view-model GroundingCard the renderer consumes.
export function mapWireCard(w: JarvisGroundingCard): GroundingCard {
    return {
        n: w.n,
        sourceType: w.sourcetype as SourceType,
        title: w.title,
        project: w.project,
        ageMs: w.agems,
        freshness: w.freshness as Freshness,
        navTarget: w.navtarget,
    };
}
```

(`AnswerSegment` and `GroundingCard` are already imported at the top of `recallderive.ts` from Plan 1; add `Freshness`, `SourceType`, and — if missing — `GroundingCard` to that existing import rather than duplicating it.)

- [ ] **Step 4: Run to verify the parser passes**

Run: `node node_modules/vitest/vitest.mjs run frontend/app/view/jarvis/recallderive.test.ts`
Expected: PASS (Plan 1 cases + the new ones).

- [ ] **Step 5: Make the conversation store writable**

Replace the derived-read block at the bottom of `frontend/app/view/jarvis/jarvisstore.ts` (the `activeConversationAtom` and `conversationsAtom` definitions from Plan 1) with a writable store that keeps the same read signatures and falls back to fixtures for dev/CDP. Add the `globalStore` import at the top:

```ts
import { globalStore } from "@/app/store/global";
```

Then, replacing the two derived atoms:

```ts
// --- real conversations (Plan 2) -------------------------------------------------------------------
// Writable source of truth for real recall conversations, keyed by id. Mirrors channelsstore's
// Record<string,…> primitive-atom + module-setter pattern so an in-flight stream keeps writing after the
// surface unmounts (writes go through globalStore.set at module scope, never component useState).
export const conversationsByIdAtom = atom<Record<string, JarvisConversation>>({});

// null => show the dev/CDP fixture selected by activeFixtureAtom; a string => show that real conversation.
export const activeConversationIdAtom = atom<string | null>(null);

// ephemeral composer draft; a module atom (not useState) so a nav-switch away and back keeps the draft.
export const jarvisDraftAtom = atom<string>("");

// read-only: the conversation currently shown. Real conversation wins; else the fixture (Plan 1 behavior,
// which the dev fixture bar + every Plan 1 CDP scenario still drive). Same read signature as Plan 1.
export const activeConversationAtom = atom<JarvisConversation>((get) => {
    const id = get(activeConversationIdAtom);
    if (id != null) {
        const conv = get(conversationsByIdAtom)[id];
        if (conv) return conv;
    }
    return FIXTURES[get(activeFixtureAtom)];
});

// read-only: the history-rail list — real conversations first (newest-first by insertion), then the dev
// fixtures (excluding the "narrow" alias). Plan 1 showed fixtures only; real ones now prepend.
export const conversationsAtom = atom<JarvisConversation[]>((get) => {
    const real = Object.values(get(conversationsByIdAtom)).reverse();
    const fixtures = FIXTURE_STATES.filter((s) => s !== "narrow").map((s) => FIXTURES[s]);
    return [...real, ...fixtures];
});

// --- module accessors + mutators (module scope: survive unmount) -----------------------------------
export function getConversation(id: string): JarvisConversation | undefined {
    return globalStore.get(conversationsByIdAtom)[id];
}

export function setConversation(conv: JarvisConversation): void {
    globalStore.set(conversationsByIdAtom, { ...globalStore.get(conversationsByIdAtom), [conv.id]: conv });
}

// startConversation creates an empty real conversation, makes it active, and returns its id.
export function startConversation(scope: JarvisScope): string {
    const id = `conv-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    setConversation({ id, title: "New conversation", turns: [], scope });
    globalStore.set(activeConversationIdAtom, id);
    return id;
}

// selectConversation activates a history-rail row: a real conversation by id, or (for a dev fixture row)
// falls back to the fixture selector and clears the real-active id.
export function selectConversation(id: string): void {
    if (globalStore.get(conversationsByIdAtom)[id]) {
        globalStore.set(activeConversationIdAtom, id);
        return;
    }
    if ((FIXTURE_STATES as string[]).includes(id)) {
        globalStore.set(activeFixtureAtom, id as FixtureState);
        globalStore.set(activeConversationIdAtom, null);
    }
}
```

Ensure `JarvisScope` is imported from `./jarviscontract` in the type import at the top of the file (Plan 1 imported `JarvisConversation`; add `JarvisScope`). `FixtureState` is already imported from `./jarvisfixtures`.

- [ ] **Step 6: Update the history rail to select real conversations**

In `frontend/app/view/jarvis/historyrail.tsx`, drive selection through `selectConversation` and derive active-row state from both atoms. Replace the body of `HistoryRail`:

```tsx
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { activeConversationIdAtom, activeFixtureAtom, conversationsAtom, conversationsByIdAtom, selectConversation } from "./jarvisstore";

// Left conversation-history rail. Real conversations select by id; dev-fixture rows fall back to the fixture
// selector (see selectConversation). A row is active when it is the active real conversation, or — when no
// real conversation is active — the selected fixture.
export function HistoryRail() {
    const convs = useAtomValue(conversationsAtom);
    const activeConvId = useAtomValue(activeConversationIdAtom);
    const activeFixture = useAtomValue(activeFixtureAtom);
    const byId = useAtomValue(conversationsByIdAtom);
    return (
        <nav className="flex w-[240px] shrink-0 flex-col border-r border-border bg-surface" aria-label="Conversations">
            <div className="px-4 pb-2 pt-4 text-[11px] font-semibold uppercase tracking-wide text-muted">Conversations</div>
            <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 pb-3">
                {convs.map((c) => {
                    const isReal = byId[c.id] != null;
                    const isActive = isReal ? c.id === activeConvId : activeConvId == null && c.id === activeFixture;
                    return (
                        <button
                            key={c.id}
                            type="button"
                            onClick={() => selectConversation(c.id)}
                            className={cn(
                                "cursor-pointer truncate rounded-[8px] px-3 py-2 text-left text-[13px] text-ink-mid hover:bg-surface-hover hover:text-secondary",
                                isActive && "bg-accentbg text-accent-soft"
                            )}
                        >
                            {c.title}
                        </button>
                    );
                })}
            </div>
        </nav>
    );
}
```

(Removes the Plan 1 `stateById`/`FIXTURE_STATES` local mapping; the fixture rows keep their fixture id as `c.id`, which `selectConversation` recognizes.)

- [ ] **Step 7: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 8: Stage + checkpoint.**

---

### Task 5: FE — composer submit + streaming into the store

**Files:**
- Modify: `frontend/app/view/jarvis/jarvisstore.ts` (add the streaming submit + chunk-apply internals)
- Modify: `frontend/app/view/jarvis/composer.tsx` (enable + wire submit)

**Interfaces:**
- Consumes: `RpcApi` from `@/app/store/wshclientapi`, `TabRpcClient` from `@/app/store/wshrpcutil`, `fireAndForget` from `@/util/util`; `parseCitations`, `mapWireCard` from `./recallderive`; the store fns from Task 4; contract types.
- Produces: `submitJarvisQuery(convId: string, text: string): void`.

- [ ] **Step 1: Add the streaming submit to the store**

Add to `frontend/app/view/jarvis/jarvisstore.ts` (imports at top, functions below the Task 4 mutators):

```ts
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { fireAndForget } from "@/util/util";
import { mapWireCard, parseCitations } from "./recallderive";
import type {
    AnswerSegment,
    GroundingCard,
    JarvisAnswerTurn,
    JarvisUserTurn,
    Terminal,
    WorkingStep,
} from "./jarviscontract";
```

```ts
// A consult runs a headless CLI up to the backend's 120s cap; give the RPC stream headroom past it (the
// layer's 5s default would kill it long before an answer lands). Mirrors usefleetsummary's constant.
const JARVIS_RPC_TIMEOUT_MS = 130_000;

// patchAnswer immutably updates the streaming jarvis turn at turns[idx] of a conversation.
function patchAnswer(convId: string, idx: number, partial: Partial<JarvisAnswerTurn>): void {
    const conv = getConversation(convId);
    if (!conv) return;
    const turn = conv.turns[idx];
    if (!turn || turn.role !== "jarvis") return;
    const turns = conv.turns.slice();
    turns[idx] = { ...turn, ...partial };
    setConversation({ ...conv, turns });
}

// upsertStep replaces a step with the same id (a lifecycle transition) or appends a new one.
function upsertStep(steps: WorkingStep[], step: WorkingStep): WorkingStep[] {
    const i = steps.findIndex((s) => s.id === step.id);
    if (i >= 0) {
        const next = steps.slice();
        next[i] = step;
        return next;
    }
    return [...steps, step];
}

// submitJarvisQuery appends the user's turn + a live jarvis turn, then streams JarvisConverseCommand into
// that jarvis turn. Runs under fireAndForget at module scope so the turn keeps accumulating even if the
// surface unmounts on a nav-switch. Grounding cards + working-steps arrive as typed chunks; prose arrives as
// text fragments re-parsed into [n] segments each chunk; the terminal chunk sets the verdict.
export function submitJarvisQuery(convId: string, text: string): void {
    const conv = getConversation(convId);
    const trimmed = text.trim();
    if (!conv || trimmed === "") return;

    const userTurn: JarvisUserTurn = { role: "user", text: trimmed, attachments: conv.scope.attached };
    const answerTurn: JarvisAnswerTurn = { role: "jarvis", workingSteps: [], segments: [], grounding: [], terminal: "answered" };
    const title = conv.turns.length === 0 ? trimmed : conv.title;
    setConversation({ ...conv, title, turns: [...conv.turns, userTurn, answerTurn] });
    const answerIdx = conv.turns.length + 1;

    fireAndForget(async () => {
        let raw = "";
        let steps: WorkingStep[] = [];
        const cards: GroundingCard[] = [];
        try {
            const gen = RpcApi.JarvisConverseCommand(
                TabRpcClient,
                {
                    conversationid: convId,
                    prompt: trimmed,
                    scopemode: conv.scope.mode,
                    projectpath: "",
                    attachedorefs: conv.scope.attached.map((a) => a.oref),
                    requestid: `${convId}-${answerIdx}`,
                },
                { timeout: JARVIS_RPC_TIMEOUT_MS }
            );
            for await (const chunk of gen) {
                if (chunk == null) continue;
                if (chunk.kind === "step" && chunk.step) {
                    steps = upsertStep(steps, { id: chunk.step.id, label: chunk.step.label, status: chunk.step.status as WorkingStep["status"] });
                    patchAnswer(convId, answerIdx, { workingSteps: steps });
                } else if (chunk.kind === "grounding" && chunk.grounding) {
                    cards.push(mapWireCard(chunk.grounding));
                    patchAnswer(convId, answerIdx, { grounding: [...cards] });
                } else if (chunk.kind === "text") {
                    raw += chunk.text ?? "";
                    const segments: AnswerSegment[] = parseCitations(raw, cards);
                    patchAnswer(convId, answerIdx, { segments });
                } else if (chunk.kind === "terminal") {
                    patchAnswer(convId, answerIdx, { terminal: (chunk.terminal as Terminal) ?? "answered" });
                }
            }
        } catch {
            // preserve whatever streamed; mark the turn weak (mirrors usefleetsummary's error path).
            patchAnswer(convId, answerIdx, { terminal: "weak" });
        }
    });
}
```

- [ ] **Step 2: Wire the composer**

Replace `frontend/app/view/jarvis/composer.tsx` entirely (enable the input, bind to the draft atom, submit on Enter):

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Composer + scope chips. Plan 2 wires submit -> JarvisConverseCommand: Enter starts a real conversation
// (if a fixture is showing) or appends to the active one, then streams the answer into the store. Scope
// chips render the active conversation's scope so "what will Jarvis look at?" is always visible.

import { cn } from "@/util/util";
import { useAtom, useAtomValue } from "jotai";
import { activeConversationAtom, activeConversationIdAtom, jarvisDraftAtom, startConversation, submitJarvisQuery } from "./jarvisstore";
import { globalStore } from "@/app/store/global";

export function Composer() {
    const conv = useAtomValue(activeConversationAtom);
    const [draft, setDraft] = useAtom(jarvisDraftAtom);

    const submit = () => {
        const text = draft.trim();
        if (text === "") return;
        let convId = globalStore.get(activeConversationIdAtom);
        if (convId == null) convId = startConversation(conv.scope);
        submitJarvisQuery(convId, text);
        setDraft("");
    };

    return (
        <div className="flex-none border-t border-border bg-background px-6 py-4">
            <div className="mb-2 flex flex-wrap items-center gap-1.5">
                {conv.scope.chips.map((chip) => (
                    <span
                        key={chip.label}
                        className={cn(
                            "rounded-full border px-2.5 py-0.5 text-[11.5px]",
                            chip.active ? "border-accent/40 bg-accentbg text-accent-soft" : "border-border text-ink-mid"
                        )}
                    >
                        {chip.label}
                    </span>
                ))}
            </div>
            <div className="flex items-center gap-2 rounded-[10px] border border-edge-mid bg-surface px-3.5 py-2.5">
                <input
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) {
                            e.preventDefault();
                            submit();
                        }
                    }}
                    placeholder="Ask Jarvis…"
                    className="min-w-0 flex-1 bg-transparent text-[14px] text-secondary placeholder:text-muted focus:outline-none"
                />
            </div>
        </div>
    );
}
```

- [ ] **Step 3: Typecheck + lint**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (exit 0) and `npx eslint frontend/app/view/jarvis/composer.tsx frontend/app/view/jarvis/jarvisstore.ts` (no errors; remove any unused import).

- [ ] **Step 4: Re-run the Jarvis unit tests** (guard against a contract/import regression): `node node_modules/vitest/vitest.mjs run frontend/app/view/jarvis/` → all PASS.

- [ ] **Step 5: Stage + checkpoint.**

---

### Task 6: Verification — CDP regression + real-recall smoke

**Files:** none (verification only).

- [ ] **Step 1: Full FE typecheck + all Jarvis unit tests + Go tests**

Run, expecting clean:
- `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` → exit 0
- `node node_modules/vitest/vitest.mjs run frontend/app/view/jarvis/` → all PASS
- `go test ./pkg/jarvisrecall/` → PASS
- `go build ./...` → exit 0

- [ ] **Step 2: CDP regression — Plan 1 fixture states still render**

With the dev app running (`task dev`), run:
`task verify:ui -- surface-smoke jarvis-states`
Expected: PASS table for both scenarios; `cdp-shots/index.html` shows `jarvis-empty`…`jarvis-narrow` (9 frames) + `surface-jarvis`. The writable-store refactor must not regress fixture rendering — this is the key guard that Task 4's `activeConversationAtom` fallback preserves Plan 1 behavior.

- [ ] **Step 3: Manual real-recall smoke (backend rebuilt in Task 3 Step 6)**

In the running dev app: go to the Jarvis surface (Recall mode). In the dev fixture bar click `empty`, then type a question that your local Wave data can answer (e.g. "What recent runs touched the cockpit?") and press Enter. Confirm:
- a new conversation appears in the history rail and becomes active;
- working-steps stream ("Searching runs, radar, and memory" → done; "Synthesizing…" → done);
- grounding cards appear in the right rail with real titles/projects/ages;
- prose streams into the center with `[n]` chips that match the cards;
- the turn ends with a terminal (answered, or weak/notfound for a question with no matching sources).

Capture one screenshot for the record: `node scripts/cdp-shot.mjs cdp-shots/jarvis-real-recall.png`.

If `claude` is not on PATH in the dev app's environment, the terminal will be `weak` with the "claude CLI not available" text — note that as an environment condition, not a code failure (it exercises the graceful-degradation path).

- [ ] **Step 4: Stage + checkpoint. Plan 2 complete.** Update the meta-spec tracking table (G Plan column) and the G spec §9 checklist when the cycle's single commit is approved.

---

## Self-Review

**1. Spec coverage** (G spec §"Backend — shim recall + conversation command", §"The 12 states", §"Testing", §9 step 3; meta-spec seams F⇄C and all⇄A):

| Spec item | Task |
|---|---|
| New responsestream `JarvisConverseCommand` in `pkg/wshrpc`, Go source of truth → `task generate` | 1 |
| Pipeline: resolve scope → deterministic retrieve bounded slice (runs/decisions/memory/radar) → one model synthesis → grounded segments + citations + terminal | 2 (pure) + 3 (orchestrator) |
| Streamed working-steps = the retrieval/synthesis steps | 3 (`stepChunk` emits) |
| Model path reuses headless `claude -p` (`consult`), not `aiusechat`; ~130s timeout not 5s | 3 (`consult.Run` + `synthTimeout`); 5 (`JARVIS_RPC_TIMEOUT_MS`) |
| Tiering internal, no user picker (retrieval deterministic/free; synthesis = capable model) | 2/3 (retrieval is code; only synthesis calls the model) |
| Scope enforcement in code, not prompt | 2 (`inScope`/`scopeProject`) + 3 (`retrieve` filters) |
| Freshness resolved at synthesis from the live object; stale/unavailable surfaced not hidden | 2 (`memoryFreshness`); Plan 1 fixtures cover general stale/unavailable (documented shim limit) |
| `weak`/`notfound` are real terminals (no confabulation) | 2 (`selectTerminal`); 3 (notfound is free, no model call) |
| Shim limits: no vault/wikilink/learning-store/attribution | "What this plan does NOT do" + comments in `cards.go`/`recall.go` |
| Wire Recall mode to it (composer submit → stream → conversation) | 4 (writable store) + 5 (composer + streaming) |
| State 2 (active multi-turn), 3 (grounded/mixed), 4 (working) rendered from real shim | 5 (real turns append + stream); renderer unchanged from Plan 1 |
| Vitest for pure FE logic; Go tests for the shim; CDP for rendering; no jsdom | 2 (`cards_test.go`); 4 (`parseCitations`/`mapWireCard` tests); 6 (CDP) |
| Don't regress Plan 1 fixtures/CDP | 4 (fallback keeps fixture reads); 6 Step 2 |

**Deferred to later plans (not gaps):** quick-ask states 8–10 + `Ctrl+P` (Plan 4); real `[n]`/card navigation (Plan 4 — stays `console.log`); contextual entries that drive `object`/`project`/`attached` scope (Plan 4 — the Go shim already implements all four modes); fleet migration + `@jarvis` reroute (Plan 3); `decision`/`channel`/`commit`/`agent`/`session`/`task` sources (B/C/D — remain fixture-only). General `stale`/`unavailable` beyond the memory-gardener signal (learning store, C).

**2. Placeholder scan:** No "TBD"/"implement later" in code. The `console.log` citation/card handlers are inherited Plan-1 behavior with a named Plan-4 replacement point, not placeholders. The `synthCwd`/`memory:`-navTarget/`fresh`-default choices are explicit, documented shim decisions. `projectpath: ""` in the composer's request is the intended Plan-2 default (project scope is Plan 4), not a stub.

**3. Type consistency:**
- Go wire ↔ generated TS: `JarvisConverseChunk{Kind, Step, Grounding, Text, Terminal}` with JSON tags `kind/step/grounding/text/terminal`; `JarvisGroundingCard` tags `n/sourcetype/title/project/agems/freshness/navtarget`; `JarvisWorkingStep` tags `id/label/status`; `CommandJarvisConverseData` tags `conversationid/prompt/scopemode/projectpath/attachedorefs/requestid`. The FE reads exactly these lowercase keys (`chunk.kind`, `chunk.step`, `chunk.grounding`, `chunk.text`, `chunk.terminal`; `w.sourcetype`/`w.agems`/`w.navtarget` in `mapWireCard`; request keys `conversationid`/`scopemode`/… in `submitJarvisQuery`). Any drift shows up as a tsc error against the generated `gotypes.d.ts`.
- View-model mapping: `mapWireCard` produces the exact `GroundingCard` shape the renderer (`conversationview.tsx`/`groundingrail.tsx`) already consumes; `parseCitations` produces `AnswerSegment[]` matching the `isCitation` discriminant (`"citationRef" in s`) the renderer uses.
- Store fns are named identically across `jarvisstore.ts`, `historyrail.tsx`, `composer.tsx`: `startConversation`, `selectConversation`, `submitJarvisQuery`, `getConversation`, `setConversation`; atoms `conversationsByIdAtom`, `activeConversationIdAtom`, `jarvisDraftAtom`, and the re-derived `activeConversationAtom`/`conversationsAtom` keep their Plan 1 read signatures (consumers `composer.tsx`, `conversationview.tsx`, `groundingrail.tsx` unchanged).
- Go: `selectTerminal`/`countCitations`/`buildCards`/`buildPrompt`/`runCandidate`/`radarCandidate`/`memoryCandidate`/`inScope`/`scopeProject`/`sortByRecency`/`projectLabel`/`memoryFreshness` signatures match between `cards.go`, `cards_test.go`, and `recall.go`. `Converse`/`Emit`/`stepChunk` match between `recall.go` and the `wshserver_jarvis.go` caller.
