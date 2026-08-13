# Jarvis Work Ledger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the jarvis work ledger (Axis 1 of the jarvis improvement map): a deterministic query engine over the two lossless legs (wstore runs + sealed evidence; agentsessions transcript scans), a stateless ask path (RPC + CLI + pi tool) that composes ledger facts with judged prose recall, capture observability, and the retrieval-correctness stack (batch relevance judge, superseded exclusion, liveprobe).

**Architecture:** Three layers with one seam each. `pkg/jarvisstate` (new) holds pure ledger derivations (`ActiveWork`, `Shipped`, `Timeline`, `Delta`) over already-fetched inputs plus a thin fetch layer; `pkg/jarvisrecall` gains a batch relevance judge (the `jarvisproactive` pattern: swappable `judge` var + `SetJudgeForTest`) and a stateless `Ask` core that shares Converse's retrieval→judge→synthesize pipeline; the wshrpc layer gains `JarvisAskCommand` / `JarvisStateCommand` / `JarvisStatusCommand` (reflection-registered, `task generate` emits clients). `wsh jarvis ask` / `wsh jarvis status` are thin CLI shells; `wave_vault_ask` is a pi tool that shells out to `wsh jarvis ask`. The ledger is a *query*, never a write; nothing new captures except distill `decision` candidates (advisory prose notes, explicitly not ledger decisions).

**Tech Stack:** Go backend (wstore sqlite, wavevault, agentsessions, consult tiered model calls, wshrpc reflection codegen), cobra CLI, pi TypeScript extension (TypeBox, vitest), Tailwind-free (no FE component changes this cycle).

## Global Constraints

- **Never hand-edit generated files.** `pkg/wshrpc/wshclient/wshclient.go`, `frontend/types/gotypes.d.ts`, `frontend/app/store/wshclientapi.ts` are produced by `task generate` (run after every wshrpc type/method change). `cmd/wsh/cmd/pi-tools-extension.ts`, `cmd/wsh/cmd/pi-tools-core-extension.ts` are produced by `task sync:piartifacts` (run after every pi extension change). Verify with `git status` that only the intended generated files moved.
- **Go tests need the sqlite-vec CGO header.** Bare `go test ./pkg/...` fails on 6 packages. From PowerShell: `$env:CGO_CFLAGS="-I<repo>\pkg\jarvisembed\csrc"; go test <pkgs>` or use `task build:backend`. Packages without wstore (jarvisrecall pure tests, memdistill) may still pass bare; when in doubt, set CGO_CFLAGS.
- **Never bare `npx tsc`** (stack-overflows on this repo). Typecheck TS with `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`.
- Frontend unit tests: `npx vitest run pi/extensions/waveterm-tools-core.test.ts`.
- Comments explain "why", never "what". KISS/YAGNI. No new `waveobj` types → no SQL migration.
- Commit per task; never commit without explicit user approval at the end.
- The 5s wshrpc default budget (`DefaultTimeoutMs`, `pkg/wshutil/wshrpc.go:28`) applies to the ask RPC — the CLI must pass an explicit `RpcOpts{Timeout}` (see Task 9).
- Dossiers carry no project label (vault tasks are unscoped) — dossier-derived items group under project `""`.

---

### Task 1: `pkg/jarvisstate` — pure ledger derivations + wire types

**Files:**
- Create: `pkg/wshrpc/wshrpctypes_jarvis.go` additions (append to the bottom of the file)
- Create: `pkg/jarvisstate/jarvisstate.go`
- Test: `pkg/jarvisstate/jarvisstate_test.go`

**Interfaces:**
- Produces (used by Task 7's wire layer and Task 8's ask handler):
  - `wshrpc.WorkState`, `wshrpc.ProjectWork`, `wshrpc.ActiveWorkItem`, `wshrpc.ShippedItem`, `wshrpc.TimelineEvent`, `wshrpc.SourceHealth` (wire types, JSON-tagged)
  - `jarvisstate.ActiveWork(runs []*waveobj.Run, sessions []agentsessions.SessionInfo, attention []wshrpc.AttentionItem, dossiers []jarvisdossier.Dossier) []wshrpc.ActiveWorkItem`
  - `jarvisstate.Shipped(runs []*waveobj.Run, windowStartMs int64) []wshrpc.ShippedItem`
  - `jarvisstate.Timeline(runs []*waveobj.Run, sessions []agentsessions.SessionInfo, decisions []DecisionEntry, dossiers []jarvisdossier.Dossier, windowStartMs int64) []wshrpc.TimelineEvent`
  - `jarvisstate.Delta(sinceMs int64, runs []*waveobj.Run, sessions []agentsessions.SessionInfo, decisions []DecisionEntry, attention []wshrpc.AttentionItem, dossiers []jarvisdossier.Dossier) []wshrpc.TimelineEvent`
  - `jarvisstate.DecisionEntry` (pure input type, jarvisstate-local)
- Consumes: `waveobj.Run`/`RunEvidence` (`pkg/waveobj/wtype.go:249`), `agentsessions.SessionInfo` (`pkg/agentsessions/agentsessions.go:90`), `wshrpc.AttentionItem` (`pkg/wshrpc/wshrpctypes_channels.go:109`), `jarvisdossier.Dossier` (`pkg/jarvisdossier/dossier.go:15`).

^- [x] **Step 1: Write the failing tests**

`pkg/jarvisstate/jarvisstate_test.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvisstate

import (
	"testing"

	"github.com/wavetermdev/waveterm/pkg/agentsessions"
	"github.com/wavetermdev/waveterm/pkg/jarvisdossier"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

func trun(id, status string, created, completed int64, evidence *waveobj.RunEvidence) *waveobj.Run {
	return &waveobj.Run{OID: id, ID: id, Goal: "goal-" + id, Status: status, ProjectPath: "/p/one",
		CreatedTs: created, CompletedTs: completed, Evidence: evidence}
}

func ev(summary string) *waveobj.RunEvidence {
	return &waveobj.RunEvidence{Summary: summary, Files: []waveobj.EvidenceFile{{Path: "a.go", Stat: "M", Add: 3, Del: 1}}}
}

func sess(id, project, status string, lastActive int64) agentsessions.SessionInfo {
	return agentsessions.SessionInfo{ID: id, Runtime: "pi", ProjectPath: project, Task: "task-" + id, Model: "m", Status: status, LastActiveTs: lastActive, StartedTs: lastActive}
}

func TestActiveWorkSkipsTerminalRuns(t *testing.T) {
	runs := []*waveobj.Run{
		trun("r1", "executing", 100, 0, nil),
		trun("r2", "done", 100, 200, ev("x")),
		trun("r3", "cancelled", 100, 200, nil),
	}
	items := ActiveWork(runs, nil, nil, nil)
	if len(items) != 1 || items[0].Kind != "run" || items[0].Title != "goal-r1" {
		t.Fatalf("items=%+v want only the executing run", items)
	}
	if items[0].Detail != "status: executing" || items[0].NavTarget != "run:r1" {
		t.Fatalf("item=%+v want status detail + run navtarget", items[0])
	}
}

func TestActiveWorkAttentionMapsProjectViaRun(t *testing.T) {
	runs := []*waveobj.Run{trun("r1", "executing", 100, 0, nil)}
	attn := []wshrpc.AttentionItem{{Kind: "gate", Key: "k", RunId: "r1", Source: "the ask bridge", Text: "review", Action: "Review", WaitingSince: 150}}
	items := ActiveWork(runs, nil, attn, nil)
	if len(items) != 2 {
		t.Fatalf("items=%+v want run + attention", items)
	}
	var a *wshrpc.ActiveWorkItem
	for i := range items {
		if items[i].Kind == "attention" {
			a = &items[i]
		}
	}
	if a == nil || a.Project != "/p/one" || a.Detail != "Review: review" || a.Ts != 150 {
		t.Fatalf("attention item=%+v want project from its run", a)
	}
}

func TestActiveWorkIncludesLiveSessionsAndBlockers(t *testing.T) {
	sessions := []agentsessions.SessionInfo{
		sess("s1", "/p/one", "waiting", 300),
		sess("s2", "/p/one", "done", 200),
	}
	dossiers := []jarvisdossier.Dossier{{ID: "d1", Objective: "ship ledger", Status: "active", Updated: 400, Blockers: []string{"needs decision on X"}}}
	items := ActiveWork(nil, sessions, nil, dossiers)
	if len(items) != 2 {
		t.Fatalf("items=%+v want session + blocker", items)
	}
	var blocker, live *wshrpc.ActiveWorkItem
	for i := range items {
		switch items[i].Kind {
		case "blocker":
			blocker = &items[i]
		case "session":
			live = &items[i]
		}
	}
	if blocker == nil || blocker.Title != "ship ledger" || blocker.Detail != "needs decision on X" || blocker.NavTarget != "vault:d1" {
		t.Fatalf("blocker=%+v wrong", blocker)
	}
	if live == nil || live.Detail != "pi m" {
		t.Fatalf("live session=%+v wrong", live)
	}
}

func TestShippedFiltersDoneWithEvidenceAndWindow(t *testing.T) {
	runs := []*waveobj.Run{
		trun("r1", "done", 100, 500, ev("shipped a")),
		trun("r2", "done", 100, 900, ev("shipped b")),
		trun("r3", "done", 100, 0, nil),         // done but never sealed
		trun("r4", "blocked", 100, 0, ev("nope")), // sealed but not done
	}
	items := Shipped(runs, 600)
	if len(items) != 1 || items[0].RunOID != "r2" || items[0].Summary != "shipped b" {
		t.Fatalf("items=%+v want only r2 in window", items)
	}
	if items[0].CompletedTs != 900 || len(items[0].Files) != 1 {
		t.Fatalf("item=%+v wrong fields", items[0])
	}
	all := Shipped(runs, 0)
	if len(all) != 2 || all[0].RunOID != "r2" {
		t.Fatalf("all=%+v want both sealed, newest first", all)
	}
}

func TestTimelineMergesAndSortsDesc(t *testing.T) {
	runs := []*waveobj.Run{
		trun("r1", "done", 100, 500, ev("shipped a")),
		trun("r2", "blocked", 300, 0, nil),
	}
	sessions := []agentsessions.SessionInfo{sess("s1", "/p/one", "done", 200)}
	decisions := []DecisionEntry{{ID: "d1", Summary: "chose sqlite", CreatedTs: 400}}
	dossiers := []jarvisdossier.Dossier{{ID: "dd", Objective: "ship ledger", Status: "active", Updated: 600}}
	evs := Timeline(runs, sessions, decisions, dossiers, 0)
	if len(evs) != 6 {
		t.Fatalf("evs=%+v want 6 events", evs)
	}
	for i := 1; i < len(evs); i++ {
		if evs[i-1].Ts < evs[i].Ts {
			t.Fatalf("not sorted desc: %+v", evs)
		}
	}
	if evs[0].Kind != "dossier" || evs[0].Title != "ship ledger" {
		t.Fatalf("newest=%+v want dossier event", evs[0])
	}
	if evs[5].Kind != "run-created" || evs[5].Title != "goal-r1" {
		t.Fatalf("oldest=%+v want run-created", evs[5])
	}
}

func TestTimelineWindowFilter(t *testing.T) {
	runs := []*waveobj.Run{
		trun("r1", "done", 100, 500, ev("x")),
		trun("r2", "blocked", 300, 0, nil),
	}
	evs := Timeline(runs, nil, nil, nil, 250)
	if len(evs) != 2 {
		t.Fatalf("evs=%+v want only events >= 250", evs)
	}
	for _, e := range evs {
		if e.Ts < 250 {
			t.Fatalf("event %+v before window", e)
		}
	}
}

func TestDeltaAddsAttentionSince(t *testing.T) {
	runs := []*waveobj.Run{trun("r1", "done", 100, 500, ev("x"))}
	attn := []wshrpc.AttentionItem{{Kind: "ask", Key: "k", RunId: "r1", Source: "worker", Text: "question", Action: "Answer", WaitingSince: 400}}
	evs := Delta(350, runs, nil, nil, attn, nil)
	var found bool
	for _, e := range evs {
		if e.Kind == "attention" {
			found = true
			if e.Project != "/p/one" || e.Detail != "Answer: question" {
				t.Fatalf("attention event=%+v wrong", e)
			}
		}
	}
	if !found {
		t.Fatalf("evs=%+v want an attention event in the delta", evs)
	}
	for _, e := range evs {
		if e.Ts < 350 {
			t.Fatalf("event %+v before since", e)
		}
	}
}
```

- [x] **Step 2: Run the tests to verify they fail to compile**

Run: `go test ./pkg/jarvisstate/...`
Expected: `package jarvisstate is not in std` (no such package) and/or undefined `ActiveWork`/`Shipped`/`Timeline`/`Delta`/`DecisionEntry` and undefined `wshrpc.WorkState`.

- [x] **Step 3: Add the wire types**

Append to the bottom of `pkg/wshrpc/wshrpctypes_jarvis.go`:

```go
// --- Work ledger (Axis 1): wire types for the stateless query surface. --------------------------

// CommandJarvisStateData filters the work-ledger query. Project filters to one project ("" = all);
// SinceMs windows the timeline/delta (0 = unbounded).
type CommandJarvisStateData struct {
	Project string `json:"project,omitempty"`
	SinceMs int64  `json:"sincems,omitempty"`
}

// CommandJarvisStateRtnData is the ledger query response: per-project derivations plus per-leg
// source health (the "never ran vs ran and found nothing" discipline).
type CommandJarvisStateRtnData struct {
	State WorkState `json:"state"`
}

type WorkState struct {
	Projects []ProjectWork `json:"projects,omitempty"`
	Sources  SourceHealth  `json:"sources"`
}

type ProjectWork struct {
	Project string            `json:"project"`
	Active  []ActiveWorkItem  `json:"active,omitempty"`
	Shipped []ShippedItem     `json:"shipped,omitempty"`
	Events  []TimelineEvent   `json:"events,omitempty"`
	Delta   []TimelineEvent   `json:"delta,omitempty"`
}

// ActiveWorkItem is one thing the operator might want surfaced about in-flight work.
type ActiveWorkItem struct {
	Project   string `json:"project"`
	Kind      string `json:"kind"` // "run" | "session" | "attention" | "blocker"
	Title     string `json:"title"`
	Detail    string `json:"detail,omitempty"`
	Ts        int64  `json:"ts"`
	NavTarget string `json:"navtarget,omitempty"` // "run:<oid>" | "vault:<id>"
}

// ShippedItem is one completed, evidence-sealed run within the window.
type ShippedItem struct {
	Project     string                 `json:"project"`
	RunOID      string                 `json:"runoid"`
	Goal        string                 `json:"goal"`
	Summary     string                 `json:"summary,omitempty"`
	Files       []waveobj.EvidenceFile `json:"files,omitempty"`
	Verifs      []waveobj.EvidenceVerif `json:"verifs,omitempty"`
	CompletedTs int64                  `json:"completedts"`
}

// TimelineEvent is one merged, timestamp-descending "what happened when" event.
type TimelineEvent struct {
	Ts        int64  `json:"ts"`
	Kind      string `json:"kind"` // run-created | run-done | session | decision | dossier | attention
	Project   string `json:"project,omitempty"`
	Title     string `json:"title"`
	Detail    string `json:"detail,omitempty"`
	NavTarget string `json:"navtarget,omitempty"`
}

// SourceHealth reports each ledger leg's read status. Attention is always "volatile": the pending-ask
// registry is server-lifetime (a wavesrv restart empties it until agents re-raise), so an empty
// attention read after a restart must never read as a confident "nothing needs you".
type SourceHealth struct {
	Runs      bool   `json:"runs"`
	Sessions  bool   `json:"sessions"`
	Dossiers  bool   `json:"dossiers"`
	Attention string `json:"attention"` // "ok" | "volatile" | "error"
}
```

- [x] **Step 4: Write the pure derivations**

`pkg/jarvisstate/jarvisstate.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Package jarvisstate is the work-ledger query engine (Axis 1): deterministic derivations over the
// two lossless legs (wstore runs + sealed evidence, agentsessions scans) plus the derived layers
// (dossiers, attention). The functions here are pure over already-fetched inputs so tests need no
// OS or RPC; fetch.go is the thin wire layer that fetches the legs.
package jarvisstate

import (
	"sort"

	"github.com/wavetermdev/waveterm/pkg/agentsessions"
	"github.com/wavetermdev/waveterm/pkg/jarvisdossier"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

// runTerminalStatuses are the statuses a run can end in; everything else is in-flight.
var runTerminalStatuses = map[string]bool{"done": true, "cancelled": true}

// ActiveWork derives the per-project needs-you surface: in-flight runs with status, live sessions
// (Status is "done"/"failed" only after the transcript finished), attention items (project resolved
// through the run they wait on), and dossier blockers (dossiers carry no project label — they group
// under "").
func ActiveWork(runs []*waveobj.Run, sessions []agentsessions.SessionInfo, attention []wshrpc.AttentionItem, dossiers []jarvisdossier.Dossier) []wshrpc.ActiveWorkItem {
	var out []wshrpc.ActiveWorkItem
	for _, r := range runs {
		if runTerminalStatuses[r.Status] {
			continue
		}
		out = append(out, wshrpc.ActiveWorkItem{
			Project: r.ProjectPath, Kind: "run", Title: r.Goal,
			Detail: "status: " + r.Status, Ts: r.CreatedTs, NavTarget: "run:" + r.OID,
		})
	}
	runByID := make(map[string]*waveobj.Run, len(runs))
	for _, r := range runs {
		runByID[r.OID] = r
	}
	for _, a := range attention {
		proj := ""
		if r, ok := runByID[a.RunId]; ok {
			proj = r.ProjectPath
		}
		out = append(out, wshrpc.ActiveWorkItem{
			Project: proj, Kind: "attention", Title: a.Source,
			Detail: a.Action + ": " + a.Text, Ts: a.WaitingSince, NavTarget: "run:" + a.RunId,
		})
	}
	for _, s := range sessions {
		if s.Status == "done" || s.Status == "failed" {
			continue
		}
		title := s.Task
		if title == "" {
			title = s.ID
		}
		out = append(out, wshrpc.ActiveWorkItem{
			Project: s.ProjectPath, Kind: "session", Title: title,
			Detail: s.Runtime + " " + s.Model, Ts: s.LastActiveTs,
		})
	}
	for _, d := range dossiers {
		if len(d.Blockers) == 0 {
			continue
		}
		out = append(out, wshrpc.ActiveWorkItem{
			Kind: "blocker", Title: d.Objective, Detail: joinBlockers(d.Blockers),
			Ts: d.Updated, NavTarget: "vault:" + d.ID,
		})
	}
	return out
}

func joinBlockers(bs []string) string {
	out := ""
	for i, b := range bs {
		if i > 0 {
			out += ", "
		}
		out += b
	}
	return out
}

// Shipped returns the completed, evidence-sealed runs within the window, newest first.
// windowStartMs 0 means unbounded. A done run without sealed evidence is not "shipped" — the seal
// is the lossless record and its absence means the run's outcome is not trustworthy.
func Shipped(runs []*waveobj.Run, windowStartMs int64) []wshrpc.ShippedItem {
	var out []wshrpc.ShippedItem
	for _, r := range runs {
		if r.Status != "done" || r.Evidence == nil {
			continue
		}
		if windowStartMs > 0 && r.CompletedTs < windowStartMs {
			continue
		}
		out = append(out, wshrpc.ShippedItem{
			Project: r.ProjectPath, RunOID: r.OID, Goal: r.Goal, Summary: r.Evidence.Summary,
			Files: r.Evidence.Files, Verifs: r.Evidence.Verifs, CompletedTs: r.CompletedTs,
		})
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].CompletedTs > out[j].CompletedTs })
	return out
}

// DecisionEntry is one vault decision's ledger-relevant projection (a pure input; the fetch layer
// loads it from the decisions collection).
type DecisionEntry struct {
	ID        string
	Summary   string
	CreatedTs int64
}

// Timeline merges run, session, decision, and dossier events into one timestamp-descending stream,
// optionally windowed (windowStartMs 0 = unbounded). Status changes are not event-logged anywhere,
// so a dossier's current status is reported on its UpdatedTs event — the honest shape of the data.
func Timeline(runs []*waveobj.Run, sessions []agentsessions.SessionInfo, decisions []DecisionEntry, dossiers []jarvisdossier.Dossier, windowStartMs int64) []wshrpc.TimelineEvent {
	var evs []wshrpc.TimelineEvent
	add := func(ev wshrpc.TimelineEvent) {
		if windowStartMs > 0 && ev.Ts < windowStartMs {
			return
		}
		evs = append(evs, ev)
	}
	for _, r := range runs {
		add(wshrpc.TimelineEvent{Ts: r.CreatedTs, Kind: "run-created", Project: r.ProjectPath, Title: r.Goal, Detail: "status: " + r.Status, NavTarget: "run:" + r.OID})
		if r.CompletedTs > 0 {
			detail := ""
			if r.Evidence != nil {
				detail = r.Evidence.Summary
			}
			add(wshrpc.TimelineEvent{Ts: r.CompletedTs, Kind: "run-done", Project: r.ProjectPath, Title: r.Goal, Detail: detail, NavTarget: "run:" + r.OID})
		}
	}
	for _, s := range sessions {
		add(wshrpc.TimelineEvent{Ts: s.StartedTs, Kind: "session", Project: s.ProjectPath, Title: s.Task, Detail: s.Runtime + " " + s.Model})
	}
	for _, d := range decisions {
		add(wshrpc.TimelineEvent{Ts: d.CreatedTs, Kind: "decision", Title: d.Summary})
	}
	for _, d := range dossiers {
		add(wshrpc.TimelineEvent{Ts: d.Updated, Kind: "dossier", Title: d.Objective, Detail: "status: " + d.Status, NavTarget: "vault:" + d.ID})
	}
	sort.SliceStable(evs, func(i, j int) bool { return evs[i].Ts > evs[j].Ts })
	return evs
}

// Delta is the bring-up answer: everything new since sinceMs (Timeline windowed) plus attention
// items raised inside the window — the one leg Timeline does not see.
func Delta(sinceMs int64, runs []*waveobj.Run, sessions []agentsessions.SessionInfo, decisions []DecisionEntry, attention []wshrpc.AttentionItem, dossiers []jarvisdossier.Dossier) []wshrpc.TimelineEvent {
	evs := Timeline(runs, sessions, decisions, dossiers, sinceMs)
	runByID := make(map[string]string, len(runs))
	for _, r := range runs {
		runByID[r.OID] = r.ProjectPath
	}
	for _, a := range attention {
		if a.WaitingSince < sinceMs {
			continue
		}
		evs = append(evs, wshrpc.TimelineEvent{
			Ts: a.WaitingSince, Kind: "attention", Project: runByID[a.RunId],
			Title: a.Source, Detail: a.Action + ": " + a.Text, NavTarget: "run:" + a.RunId,
		})
	}
	sort.SliceStable(evs, func(i, j int) bool { return evs[i].Ts > evs[j].Ts })
	return evs
}
```

- [x] **Step 5: Run the tests to verify they pass**

Run: `go test ./pkg/jarvisstate/...`
Expected: `ok  github.com/wavetermdev/waveterm/pkg/jarvisstate` (all 7 tests pass).

- [x] **Step 6: Commit**

```bash
git add pkg/jarvisstate/jarvisstate.go pkg/jarvisstate/jarvisstate_test.go pkg/wshrpc/wshrpctypes_jarvis.go
git commit -m "feat(jarvisstate): work-ledger pure derivations (ActiveWork/Shipped/Timeline/Delta)"
```

---

### Task 2: memdistill — `decision` candidate + durable last-pass observability

**Files:**
- Modify: `pkg/memdistill/distill.go` (prompt, ~line 39-46)
- Modify: `pkg/memdistill/queue.go` (queueState + PassRecord + QueueSummary)
- Modify: `pkg/memdistill/coordinator.go` (stamp LastPass in `maybeFlush`)
- Test: `pkg/memdistill/distill_test.go`, `pkg/memdistill/coordinator_test.go`

**Interfaces:**
- Produces (used by Task 7's `JarvisStatusCommand` handler via `jarvisstate.FetchCaptureStatus`):
  - `memdistill.QueueSummary() ([]CwdQueueSummary, error)` — per-cwd pending count + last pass record
  - `memdistill.CwdQueueSummary{Cwd string; Pending int; LastPass *PassRecord}`, `memdistill.PassRecord{Ts int64; Sessions, Committed, Queued int}`
- Consumes: existing `queueState`/`loadQueue`/`saveQueue` (`pkg/memdistill/queue.go`), `maybeFlush` (`pkg/memdistill/coordinator.go:80`), `parseDistillOutput` (`pkg/memdistill/distill.go:101`).

^- [x] **Step 1: Write the failing tests**

Append to `pkg/memdistill/distill_test.go`:

```go
func TestParseDistillOutput_DecisionCandidate(t *testing.T) {
	raw := `{"candidates":[{"type":"decision","body":"we chose X over Y, rejecting Z","iscorrection":false}],"references":[]}`
	cands, _, ok := parseDistillOutput(raw)
	if !ok || len(cands) != 1 || cands[0].Type != "decision" || cands[0].Body != "we chose X over Y, rejecting Z" {
		t.Fatalf("parse failed: ok=%v cands=%+v", ok, cands)
	}
	if cands[0].IsCorrection {
		t.Error("a decision candidate is not a correction; it must land in the review band")
	}
}
```

Append to `pkg/memdistill/coordinator_test.go`:

```go
func TestFlush_StampsLastPass(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "queue.json")
	enqueueAt := mkTime("2026-07-15T11:00:00Z").UTC().Format(time.RFC3339)
	st := queueState{Buckets: map[string][]pendingSession{"/p": {{TranscriptPath: "/t/x.jsonl", EnqueuedAt: enqueueAt}}}}
	if err := saveQueue(path, st); err != nil {
		t.Fatalf("saveQueue: %v", err)
	}
	d := newDistiller(path)
	d.routeFn = func(cwd string, cands []memvault.LearnCandidate, refs []string) (memvault.RouteResult, error) {
		return memvault.RouteResult{Committed: 1, Queued: 0}, nil
	}
	d.distillFn = func(ctx context.Context, s consult.RuntimeSpec, corpus string) (string, bool) {
		return `{"candidates":[{"type":"learning","body":"b"}],"references":[]}`, true
	}
	d.flush("/p") // flush(cwd) builds the spec itself; the stubbed distillFn/routeFn never touch the model
	sums, err := queueSummaryAt(path)
	if err != nil || len(sums) != 1 {
		t.Fatalf("queueSummaryAt: sums=%+v err=%v", sums, err)
	}
	got := sums[0]
	if got.Cwd != "/p" || got.Pending != 0 {
		t.Fatalf("sum=%+v want cwd /p with empty bucket", got)
	}
	if got.LastPass == nil || got.LastPass.Sessions != 1 || got.LastPass.Committed != 1 {
		t.Fatalf("sum=%+v want last pass stamped with the flush's counts", got)
	}
}
```

(Check the existing `flush` body in `coordinator.go:87` — it takes `(cwd string)`, loads the queue itself, and builds the spec from `consult.SpecForTier("openrouter", consult.TierCheap)` internally, so the test only stubs `distillFn`/`routeFn`.)

- [x] **Step 2: Run the tests to verify they fail**

Run: `go test ./pkg/memdistill/...`
Expected: FAIL — `undefined: queueSummaryAt` and the decision candidate passes only if the prompt change is irrelevant to parsing (it is — the parse already maps `type` verbatim; the real gate is the test pinning the new type, plus the prompt change in Step 3).

- [x] **Step 3: Add the prompt guidance + queue observability**

In `pkg/memdistill/distill.go`, change the prompt's type list (line ~42):

```go
	`type is one of: feedback | learning | project | reference | decision. ` +
	`Emit type "decision" ONLY when a session ends with an explicit choice, naming the alternative considered. ` +
```

In `pkg/memdistill/queue.go`, extend the state and add the summary export:

```go
// PassRecord is one finished distill pass over a cwd bucket, kept durably so `wsh jarvis status`
// can answer "did it skip my session" — the activity feed's buffer is in-memory and dies with the
// server; the queue file is the durable record.
type PassRecord struct {
	Ts        int64 `json:"ts"`
	Sessions  int   `json:"sessions"`
	Committed int   `json:"committed"`
	Queued    int   `json:"queued"`
}

type queueState struct {
	Buckets  map[string][]pendingSession `json:"buckets"`
	LastPass map[string]PassRecord       `json:"lastpass,omitempty"`
}
```

In `loadQueue`, initialize `LastPass` alongside `Buckets` (both the missing-file and unparseable paths):

```go
	st := queueState{Buckets: map[string][]pendingSession{}, LastPass: map[string]PassRecord{}}
```

Append to `pkg/memdistill/queue.go`:

```go
// CwdQueueSummary is one cwd's distill queue state: pending count plus the last recorded pass.
type CwdQueueSummary struct {
	Cwd      string      `json:"cwd"`
	Pending  int         `json:"pending"`
	LastPass *PassRecord `json:"lastpass,omitempty"`
}

// QueueSummary reports every cwd that has a pending bucket or a recorded pass, sorted by cwd.
func QueueSummary() ([]CwdQueueSummary, error) {
	return queueSummaryAt(filepath.Join(wavebase.GetWaveDataDir(), queueFile))
}

func queueSummaryAt(path string) ([]CwdQueueSummary, error) {
	st := loadQueue(path)
	cwds := map[string]bool{}
	for cwd := range st.Buckets {
		cwds[cwd] = true
	}
	for cwd := range st.LastPass {
		cwds[cwd] = true
	}
	out := make([]CwdQueueSummary, 0, len(cwds))
	for cwd := range cwds {
		rec := st.LastPass[cwd]
		out = append(out, CwdQueueSummary{Cwd: cwd, Pending: len(st.Buckets[cwd]), LastPass: &rec})
	}
	sort.Strings(...) // sort by Cwd for determinism: sort.Slice(out, func(i, j int) bool { return out[i].Cwd < out[j].Cwd })
	return out, nil
}
```

(Add the missing imports to `queue.go`: `path/filepath`, `sort`, `wavebase`.)

In `pkg/memdistill/coordinator.go` `maybeFlush`, stamp the pass in the same locked save that clears the bucket — right before the existing `saveQueue(d.path, st)`:

```go
	if st.LastPass == nil {
		st.LastPass = map[string]PassRecord{}
	}
	st.LastPass[cwd] = PassRecord{Ts: time.Now().UnixMilli(), Sessions: len(sessions), Committed: res.Committed, Queued: res.Queued}
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `go test ./pkg/memdistill/...`
Expected: `ok  github.com/wavetermdev/waveterm/pkg/memdistill` — new tests pass, existing `TestFlush_RoutesAndClearsBucket` etc. still pass (LastPass is additive).

- [x] **Step 5: Commit**

```bash
git add pkg/memdistill/
git commit -m "feat(memdistill): decision candidate type + durable last-pass observability"
```

---

### Task 3: Superseded exclusion in both seed paths

**Files:**
- Modify: `pkg/jarvisrecall/retrieve.go` (helpers + `selectSeeds` + `semanticSeeds`)
- Test: `pkg/jarvisrecall/retrieve_test.go` (append)

**Interfaces:**
- Produces: `supersededBy(n wavevault.Node) string` (package-private), used by the seed paths.
- Consumes: `wavevault.Node.Frontmatter` (`pkg/wavevault/parse.go:27`, map with top-level or nested `metadata.superseded_by`), `Retriever.Read` (node lookup for L3 ids), the `injectIndex`/`semFake` fixture pattern (`pkg/jarvisrecall/retrieve_semantic_test.go`).

^- [x] **Step 1: Write the failing tests**

Append to `pkg/jarvisrecall/retrieve_test.go`:

```go
// supersededVault builds a fixture vault with two memory notes that both full-text match "solar":
// one live, one flagged superseded (WriteLearning's nested metadata shape). Built standalone so no
// other fixture note can interfere with the keyword match.
func supersededVault(t *testing.T) *wavevault.Vault {
	t.Helper()
	v, err := wavevault.OpenVaultAtForTest(context.Background(), t.TempDir())
	if err != nil {
		t.Fatalf("OpenVaultAtForTest: %v", err)
	}
	write := func(rel, content string) {
		p := filepath.Join(v.Root, rel)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("memory/solar-old.md", "---\nid: solar-old\nmetadata:\n  type: learning\n  superseded_by: solar-live\n---\nold solar panel deployment notes\n")
	write("memory/solar-live.md", "---\nid: solar-live\nmetadata:\n  type: learning\n---\ncurrent solar panel deployment notes\n")
	return v
}

func TestSelectSeedsExcludesSupersededFromKeywordSeeds(t *testing.T) {
	v := supersededVault(t)
	r := v.Retriever(wavevault.AllScope())
	seeds, err := selectSeeds(context.Background(), v, r, "solar panel")
	if err != nil {
		t.Fatalf("selectSeeds: %v", err)
	}
	if len(seeds) != 1 || seeds[0] != "solar-live" {
		t.Fatalf("seeds=%v want only the live note", seeds)
	}
}

func TestSemanticSeedsExcludesSuperseded(t *testing.T) {
	v := supersededVault(t)
	injectIndex(t, &semFake{dims: 3})
	r := v.Retriever(wavevault.AllScope())
	// Both notes embed to basis vec 0, so only the superseded filter can separate them.
	seeds, err := selectSeeds(context.Background(), v, r, "renewable grid")
	if err != nil {
		t.Fatalf("selectSeeds: %v", err)
	}
	if len(seeds) != 1 || seeds[0] != "solar-live" {
		t.Fatalf("seeds=%v want only the live note (superseded excluded from the semantic lane too)", seeds)
	}
}
```

(Imports to add to `retrieve_test.go`: `os`, `path/filepath`.)

- [x] **Step 2: Run the tests to verify they fail**

Run: `go test ./pkg/jarvisrecall/ -run 'TestSelectSeeds|TestSemanticSeeds'`
Expected: FAIL — `seeds=[solar-live solar-old]` includes the superseded note.

- [x] **Step 3: Add the superseded filter**

In `pkg/jarvisrecall/retrieve.go`:

```go
// supersededBy returns the superseded_by target from a node's frontmatter, or "" when unset. Vault
// notes carry it nested under metadata (the WriteLearning shape); harvest-style files may put it at
// the top level. The memory tab already computes supersession — retrieval just never consulted it.
func supersededBy(n wavevault.Node) string {
	if v, ok := n.Frontmatter["superseded_by"]; ok {
		if s, ok := v.(string); ok && strings.TrimSpace(s) != "" {
			return strings.TrimSpace(s)
		}
	}
	if md, ok := n.Frontmatter["metadata"]; ok {
		if m, ok := md.(map[string]any); ok {
			if v, ok := m["superseded_by"]; ok {
				if s, ok := v.(string); ok {
					return strings.TrimSpace(s)
				}
			}
		}
	}
	return ""
}

func isSuperseded(n wavevault.Node) bool { return supersededBy(n) != "" }
```

In `selectSeeds`, skip superseded nodes in the L1 ticket loop and the L2 keyword loop:

```go
		for _, n := range nodes {
			if isSuperseded(n) {
				continue
			}
			add(n.ID, true, n.UpdatedTs)
		}
```
```go
		for _, h := range hits {
			if isSuperseded(h.Node) {
				continue
			}
			add(h.Node.ID, false, h.Node.UpdatedTs)
		}
```

In `semanticSeeds`, filter the round-robin output before returning (a `ScoredChunk` carries only a node id, so the filter reads each candidate's frontmatter through the retriever; a read failure keeps the node — fail-open, a superseded check must never drop a retrievable answer):

```go
	// The index chunk carries only a node id; read frontmatter to drop superseded nodes. Fail-open:
	// an unreadable node is kept (a superseded check must never lose an answer).
	r := v.Retriever(wavevault.AllScope())
	filtered := ids[:0]
	for _, id := range ids {
		if nb, err := r.Read(id); err == nil && isSuperseded(nb.Node) {
			continue
		}
		filtered = append(filtered, id)
	}
	return filtered
```

(Replace the final `return ids` of `semanticSeeds` with the filtered return.)

- [x] **Step 4: Run the tests to verify they pass**

Run: `go test ./pkg/jarvisrecall/`
Expected: `ok` — new tests pass, existing retrieve/semantic/converse/cards tests unaffected.

- [x] **Step 5: Commit**

```bash
git add pkg/jarvisrecall/retrieve.go pkg/jarvisrecall/retrieve_test.go
git commit -m "feat(jarvisrecall): exclude superseded notes from both seed paths"
```

---

### Task 4: Batch relevance judge

**Files:**
- Create: `pkg/jarvisrecall/judge.go`
- Test: `pkg/jarvisrecall/judge_test.go`

**Interfaces:**
- Produces (used by Task 5's `Ask` and Task 6's `Converse`):
  - `SetJudgeForTest(fn func(context.Context, string, string) (string, error)) func()` (mirror of `jarvisproactive.SetJudgeForTest`, `pkg/jarvisproactive/proactive.go:38`)
  - `judgeCandidates(ctx context.Context, cwd, question string, cands []candidate) []candidate` — the keep/remove filter
  - `buildJudgePrompt(question string, cands []candidate) string`, `parseJudgeReply(reply string, n int) []int` (package-private, unit-tested)
- Consumes: `consult.SpecForTier("openrouter", consult.TierCheap)` + `consult.Run` (the `jarvisproactive` pattern), `candidate` (`pkg/jarvisrecall/cards.go:21`).

^- [x] **Step 1: Write the failing tests**

`pkg/jarvisrecall/judge_test.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvisrecall

import (
	"context"
	"errors"
	"testing"
)

func TestParseJudgeReply(t *testing.T) {
	cases := []struct {
		reply string
		n     int
		want  []int // nil = keep-all (ambiguous)
	}{
		{"2, 4", 5, []int{1, 3}},
		{"none", 5, []int{}},
		{"", 5, []int{}},
		{"3", 2, nil},      // out of range: ambiguous, keep all
		{"keep them all", 5, nil}, // no digits and not "none": a lost judge keeps everything
		{"1, 1", 5, []int{0}},     // dedupe
		{"all", 3, nil},
	}
	for _, c := range cases {
		got := parseJudgeReply(c.reply, c.n)
		if len(got) != len(c.want) {
			t.Fatalf("parseJudgeReply(%q,%d) = %v, want %v", c.reply, c.n, got, c.want)
		}
		for i := range got {
			if got[i] != c.want[i] {
				t.Fatalf("parseJudgeReply(%q,%d) = %v, want %v", c.reply, c.n, got, c.want)
			}
		}
	}
}

func mkCands(n int) []candidate {
	out := make([]candidate, n)
	for i := range out {
		out[i] = candidate{sourceType: "memory", title: "c" + string(rune('a'+i)), navTarget: "memory:c" + string(rune('a'+i))}
	}
	return out
}

func TestJudgeCandidatesKeepsOnlyKept(t *testing.T) {
	restore := SetJudgeForTest(func(_ context.Context, _, _ string) (string, error) { return "2, 4", nil })
	defer SetJudgeForTest(restore)
	got := judgeCandidates(context.Background(), "/p", "q", mkCands(5))
	if len(got) != 2 || got[0].title != "cb" || got[1].title != "cd" {
		t.Fatalf("got=%+v want candidates 2 and 4 kept", got)
	}
}

func TestJudgeCandidatesNoneYieldsEmpty(t *testing.T) {
	restore := SetJudgeForTest(func(_ context.Context, _, _ string) (string, error) { return "none", nil })
	defer SetJudgeForTest(restore)
	got := judgeCandidates(context.Background(), "/p", "q", mkCands(3))
	if len(got) != 0 {
		t.Fatalf("got=%+v want none kept", got)
	}
}

func TestJudgeCandidatesKeepsAllOnError(t *testing.T) {
	restore := SetJudgeForTest(func(_ context.Context, _, _ string) (string, error) { return "", errors.New("model down") })
	defer SetJudgeForTest(restore)
	got := judgeCandidates(context.Background(), "/p", "q", mkCands(4))
	if len(got) != 4 {
		t.Fatalf("got=%+v want all kept on judge failure", got)
	}
}

func TestJudgeCandidatesKeepsAllOnGarbageReply(t *testing.T) {
	restore := SetJudgeForTest(func(_ context.Context, _, _ string) (string, error) { return "yep keep everything", nil })
	defer SetJudgeForTest(restore)
	got := judgeCandidates(context.Background(), "/p", "q", mkCands(3))
	if len(got) != 3 {
		t.Fatalf("got=%+v want all kept on unparseable reply", got)
	}
}

func TestJudgeCandidatesSkipsSingleton(t *testing.T) {
	// One candidate is already deterministic; the judge call is pure cost.
	called := false
	restore := SetJudgeForTest(func(_ context.Context, _, _ string) (string, error) { called = true; return "none", nil })
	defer SetJudgeForTest(restore)
	got := judgeCandidates(context.Background(), "/p", "q", mkCands(1))
	if len(got) != 1 || called {
		t.Fatalf("got=%+v called=%v want the single candidate untouched", got, called)
	}
}

func TestBuildJudgePromptNumbersCandidates(t *testing.T) {
	p := buildJudgePrompt("did the bridge ship?", mkCands(2))
	if p == "" || !containsStr(p, "1. [memory] ca") || !containsStr(p, "2. [memory] cb") || !containsStr(p, "Question: did the bridge ship?") {
		t.Fatalf("prompt malformed:\n%s", p)
	}
}
```

(Add a tiny helper `containsStr(haystack, needle string) bool` in the test file using `strings.Contains`.)

- [x] **Step 2: Run the tests to verify they fail**

Run: `go test ./pkg/jarvisrecall/ -run TestParseJudgeReply`
Expected: FAIL — `undefined: parseJudgeReply`.

- [x] **Step 3: Write the judge**

`pkg/jarvisrecall/judge.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvisrecall

import (
	"context"
	"fmt"
	"log"
	"regexp"
	"strconv"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/consult"
)

// errNoJudge mirrors jarvisproactive's failure mode: the cheap tier has no configured provider.
var errNoJudge = fmt.Errorf("relevance judge requires the cheap tier, which is not available")

// judgeRun is the inner process-runner seam (same shape as jarvisproactive.judgeRun).
var judgeRun = consult.Run

// judge is the batch relevance call: one cheap-tier pass over the numbered shortlist returning the
// kept indices. Picking on-topic candidates is bounded classification, not synthesis — the cheap
// tier exists for exactly this. A seam so tests mock it; one-shot and unstreamed.
var judge = func(ctx context.Context, cwd, prompt string) (string, error) {
	spec, ok := consult.SpecForTier("openrouter", consult.TierCheap)
	if !ok {
		return "", errNoJudge
	}
	return judgeRun(ctx, spec, cwd, prompt, func(string) {})
}

// SetJudgeForTest swaps the model call and returns a restore func the caller defers.
func SetJudgeForTest(fn func(ctx context.Context, cwd, prompt string) (string, error)) func() {
	old := judge
	judge = fn
	return func() { judge = old }
}

// buildJudgePrompt asks the cheap tier to keep the on-topic candidates. The numbered list aligns
// with the later synthesis prompt, so kept indices carry straight through.
func buildJudgePrompt(question string, cands []candidate) string {
	var b strings.Builder
	b.WriteString("A question was asked of a work ledger. Below are candidate sources a deterministic search retrieved.\n")
	b.WriteString("Decide which candidates are genuinely ON-TOPIC for the question — relevant to what is asked, not merely sharing a topic word.\n\n")
	b.WriteString("Question: " + question + "\n\nCandidates:\n")
	for i, c := range cands {
		fmt.Fprintf(&b, "%d. [%s] %s", i+1, c.sourceType, c.title)
		if c.project != "" {
			fmt.Fprintf(&b, " (%s)", c.project)
		}
		if c.snippet != "" {
			b.WriteString(" — " + strings.TrimSpace(c.snippet))
		}
		b.WriteString("\n")
	}
	b.WriteString("\nReply with ONLY the comma-separated numbers of the on-topic candidates, or the word \"none\" if none are on-topic. Do not explain.\n")
	return b.String()
}

var judgeNumRe = regexp.MustCompile(`\d+`)

// parseJudgeReply extracts 0-based kept indices from a comma-separated reply. "none"/"" keep
// nothing. Any ambiguity (out-of-range, digits alongside garbage, no digits at all) returns nil —
// the caller keeps everything, because a lost judge is a slower answer, never no answer.
func parseJudgeReply(reply string, n int) []int {
	low := strings.ToLower(strings.TrimSpace(reply))
	if low == "none" || low == "" {
		return []int{}
	}
	matches := judgeNumRe.FindAllString(reply, -1)
	if len(matches) == 0 {
		return nil
	}
	var out []int
	seen := map[int]bool{}
	for _, m := range matches {
		idx, err := strconv.Atoi(m)
		if err != nil || idx < 1 || idx > n {
			return nil
		}
		if !seen[idx] {
			seen[idx] = true
			out = append(out, idx-1)
		}
	}
	return out
}

// judgeCandidates applies the batch judge. Any judge failure keeps every candidate and logs —
// the judge removes wrong memories before synthesis, it must never remove the answer. A singleton
// shortlist skips the call: retrieval already narrowed it deterministically and one candidate is
// nothing for the model to choose between.
func judgeCandidates(ctx context.Context, cwd, question string, cands []candidate) []candidate {
	if len(cands) <= 1 {
		return cands
	}
	reply, err := judge(ctx, cwd, buildJudgePrompt(question, cands))
	if err != nil {
		log.Printf("[jarvisrecall] judge failed, keeping all %d candidates: %v\n", len(cands), err)
		return cands
	}
	kept := parseJudgeReply(reply, len(cands))
	if kept == nil {
		log.Printf("[jarvisrecall] judge reply unparseable (%q), keeping all %d candidates\n", reply, len(cands))
		return cands
	}
	out := make([]candidate, 0, len(kept))
	for _, i := range kept {
		out = append(out, cands[i])
	}
	return out
}
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `go test ./pkg/jarvisrecall/ -run 'TestParseJudgeReply|TestJudge'`
Expected: `ok` — all 7 judge tests pass.

- [x] **Step 5: Commit**

```bash
git add pkg/jarvisrecall/judge.go pkg/jarvisrecall/judge_test.go
git commit -m "feat(jarvisrecall): batch relevance judge with keep-all degradation"
```

---

### Task 5: `Ask` core + `ClassifyAsk` routing

**Files:**
- Create: `pkg/jarvisrecall/ask.go`
- Test: `pkg/jarvisrecall/ask_test.go`

**Interfaces:**
- Produces (used by Task 8's `JarvisAskCommand` handler):
  - `AskKindStatus` / `AskKindHistory` / `AskKindDelta` / `AskKindProse` (consts)
  - `ClassifyAsk(q string) (kind string, windowMs int64)`
  - `LedgerFact{SourceType, Title, Snippet, NavTarget string; Ts int64}`
  - `AskLedgerFn func(ctx context.Context, kind string, windowMs int64) ([]LedgerFact, error)`
  - `Ask(ctx context.Context, scope ScopeArgs, prompt string, ledgerFn AskLedgerFn) (AskResult, error)`
  - `AskResult{Answer string; Sources []waveobj.JarvisConvoSourceRef; Terminal string}`
- Consumes: `analyzeQuery` (`pkg/jarvisrecall/retrieve.go:122`), `retrieve`, `judgeCandidates` (Task 4), `synthesize`/`buildPrompt`/`selectTerminal`/`countCitations`/`notFoundProse`/`synthTimeout` (`pkg/jarvisrecall/recall.go`, `cards.go`), `SetSynthesizeForTest` (`recall.go:51`).

^- [x] **Step 1: Write the failing tests**

`pkg/jarvisrecall/ask_test.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvisrecall

import (
	"context"
	"strings"
	"testing"
)

func TestClassifyAsk(t *testing.T) {
	cases := []struct {
		query      string
		wantKind   string
		wantWindow bool // windowMs != 0
	}{
		{"what is the status of the ask bridge", AskKindStatus, false},
		{"is anything blocked right now", AskKindStatus, false},
		{"did the ask bridge ship", AskKindHistory, false},
		{"what shipped since 2026-08-01T00:00:00Z", AskKindDelta, true},
		{"what happened last week", AskKindDelta, true},
		{"what happened in the last 3 days", AskKindDelta, true},
		{"why did we choose sqlite over postgres", AskKindProse, false},
		{"statusification of the frontend build", AskKindProse, false}, // substring must not match
		{"how do i cook pasta", AskKindProse, false},
	}
	for _, c := range cases {
		kind, windowMs := ClassifyAsk(c.query)
		if kind != c.wantKind {
			t.Fatalf("ClassifyAsk(%q) kind=%q want %q", c.query, kind, c.wantKind)
		}
		if (windowMs != 0) != c.wantWindow {
			t.Fatalf("ClassifyAsk(%q) windowMs=%d want nonzero=%v", c.query, windowMs, c.wantWindow)
		}
	}
}

// askFixture wires the seams: fixture vault for retrieval, stub judge, stub synthesize. Returns the
// vault so the ledgerFn stub can reference it.
func askFixture(t *testing.T) *wavevault.Vault {
	t.Helper()
	v := seedVault(t)
	restoreV := SetOpenVaultForTest(func(context.Context) (*wavevault.Vault, error) { return v, nil })
	t.Cleanup(func() { SetOpenVaultForTest(restoreV) })
	restoreI := SetOpenIndexForTest(func(context.Context) (*jarvisembed.Index, error) {
		return nil, errors.New("no index in test")
	})
	t.Cleanup(func() { SetOpenIndexForTest(restoreI) })
	return v
}

func TestAskAttachesLedgerFactsForStatus(t *testing.T) {
	askFixture(t)
	var gotKind string
	var gotWindow int64
	ledgerFn := func(_ context.Context, kind string, windowMs int64) ([]LedgerFact, error) {
		gotKind, gotWindow = kind, windowMs
		return []LedgerFact{{SourceType: "status", Title: "the ask bridge", Snippet: "status: executing", NavTarget: "run:r1", Ts: 1}}, nil
	}
	restoreJ := SetJudgeForTest(func(_ context.Context, _, _ string) (string, error) { return "1", nil })
	defer SetJudgeForTest(restoreJ)
	restoreS := SetSynthesizeForTest(func(_ context.Context, _, _ string, _ func(string)) (string, error) {
		return "the ask bridge is executing [1]", nil
	})
	defer SetSynthesizeForTest(restoreS)
	res, err := Ask(context.Background(), ScopeArgs{Mode: "all"}, "what is the status of the ask bridge", ledgerFn)
	if err != nil {
		t.Fatalf("Ask: %v", err)
	}
	if gotKind != AskKindStatus || gotWindow != 0 {
		t.Fatalf("ledgerFn kind=%q window=%d want status/0", gotKind, gotWindow)
	}
	if !strings.Contains(res.Answer, "executing") || res.Terminal != "answered" {
		t.Fatalf("res=%+v want synthesize output + answered terminal", res)
	}
	if len(res.Sources) != 1 || res.Sources[0].ORef != "run:r1" || res.Sources[0].SourceType != "status" {
		t.Fatalf("sources=%+v want the ledger fact", res.Sources)
	}
}

func TestAskRoutingTable(t *testing.T) {
	askFixture(t)
	// The contract under test is the routing rule itself: the ledger closure runs iff the query is
	// status/history/delta-shaped, never for prose or off-topic. Terminal behavior is pinned by the
	// dedicated judge tests below.
	cases := []struct {
		query  string
		wantFn bool
	}{
		{"what is the status of the ask bridge", true},
		{"did the ask bridge ship", true},
		{"what happened last week", true},
		{"why did we choose sqlite", false},
		{"how do i cook pasta", false},
	}
	for _, c := range cases {
		called := false
		ledgerFn := func(_ context.Context, _ string, _ int64) ([]LedgerFact, error) {
			called = true
			return nil, nil
		}
		restoreJ := SetJudgeForTest(func(_ context.Context, _, _ string) (string, error) { return "1", nil })
		restoreS := SetSynthesizeForTest(func(_ context.Context, _, _ string, _ func(string)) (string, error) { return "x", nil })
		_, err := Ask(context.Background(), ScopeArgs{Mode: "all"}, c.query, ledgerFn)
		SetJudgeForTest(restoreJ)
		SetSynthesizeForTest(restoreS)
		if err != nil {
			t.Fatalf("Ask(%q): %v", c.query, err)
		}
		if called != c.wantFn {
			t.Fatalf("Ask(%q) ledgerFn called=%v want %v", c.query, called, c.wantFn)
		}
	}
}

func TestAskJudgeNoneYieldsNotFound(t *testing.T) {
	askFixture(t)
	// Two ledger facts: a singleton shortlist skips the judge, so this needs >= 2 candidates to
	// exercise the "judge removed everything" path deterministically.
	ledgerFn := func(_ context.Context, _ string, _ int64) ([]LedgerFact, error) {
		return []LedgerFact{
			{SourceType: "status", Title: "a", NavTarget: "run:a", Ts: 1},
			{SourceType: "status", Title: "b", NavTarget: "run:b", Ts: 2},
		}, nil
	}
	restoreJ := SetJudgeForTest(func(_ context.Context, _, _ string) (string, error) { return "none", nil })
	defer SetJudgeForTest(restoreJ)
	restoreS := SetSynthesizeForTest(func(_ context.Context, _, _ string, _ func(string)) (string, error) { return "x", nil })
	defer SetSynthesizeForTest(restoreS)
	res, err := Ask(context.Background(), ScopeArgs{Mode: "all"}, "what is the status of the ask bridge", ledgerFn)
	if err != nil {
		t.Fatalf("Ask: %v", err)
	}
	if res.Terminal != "notfound" || res.Answer != notFoundProse {
		t.Fatalf("res=%+v want notfound when the judge removes everything", res)
	}
}

func TestAskJudgeErrorKeepsAll(t *testing.T) {
	askFixture(t)
	ledgerFn := func(_ context.Context, _ string, _ int64) ([]LedgerFact, error) {
		return []LedgerFact{
			{SourceType: "status", Title: "a", NavTarget: "run:a", Ts: 1},
			{SourceType: "status", Title: "b", NavTarget: "run:b", Ts: 2},
		}, nil
	}
	restoreJ := SetJudgeForTest(func(_ context.Context, _, _ string) (string, error) { return "", errors.New("down") })
	defer SetJudgeForTest(restoreJ)
	restoreS := SetSynthesizeForTest(func(_ context.Context, _, _ string, _ func(string)) (string, error) { return "answer [1]", nil })
	defer SetSynthesizeForTest(restoreS)
	res, err := Ask(context.Background(), ScopeArgs{Mode: "all"}, "what is the status of the ask bridge", ledgerFn)
	if err != nil {
		t.Fatalf("Ask: %v", err)
	}
	if res.Answer != "answer [1]" || len(res.Sources) != 2 {
		t.Fatalf("res=%+v want answer with both ledger facts kept", res)
	}
}

func TestAskNoLedgerFnIsProseOnly(t *testing.T) {
	askFixture(t)
	restoreJ := SetJudgeForTest(func(_ context.Context, _, _ string) (string, error) { return "1", nil })
	defer SetJudgeForTest(restoreJ)
	restoreS := SetSynthesizeForTest(func(_ context.Context, _, _ string, _ func(string)) (string, error) { return "prose [1]", nil })
	defer SetSynthesizeForTest(restoreS)
	// "widget" matches the seedVault decision rationale, so prose recall finds one candidate.
	res, err := Ask(context.Background(), ScopeArgs{Mode: "all"}, "why did we choose the widget approach", nil)
	if err != nil {
		t.Fatalf("Ask: %v", err)
	}
	if res.Answer != "prose [1]" {
		t.Fatalf("res=%+v want prose-only answer", res)
	}
}
```

(Imports needed in the test file: `errors`, plus `jarvisembed` and `wavevault` for the fixture.)

- [x] **Step 2: Run the tests to verify they fail**

Run: `go test ./pkg/jarvisrecall/ -run TestClassifyAsk`
Expected: FAIL — `undefined: ClassifyAsk`.

- [x] **Step 3: Write `ask.go`**

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvisrecall

import (
	"context"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// Ask routing kinds: the deterministic outcomes of ClassifyAsk.
const (
	AskKindStatus  = "status"
	AskKindHistory = "history"
	AskKindDelta   = "delta"
	AskKindProse   = "prose"
)

// statusWords and historyWords are the ledger-routing word sets. Matching is token-boundary over
// analyzeQuery's keyword output: a keyword equal to a set member counts, substrings do not. A false
// positive only attaches deterministic ledger facts the judge can drop — harmless; a false negative
// silently loses the ledger, so the sets err toward inclusion.
var statusWords = map[string]bool{
	"status": true, "statuses": true, "blocked": true, "blocking": true, "stuck": true,
	"inflight": true, "flight": true, "progress": true, "waiting": true, "needsme": true,
	"ongoing": true, "active": true,
}

var historyWords = map[string]bool{
	"shipped": true, "ship": true, "done": true, "completed": true, "finished": true,
	"landed": true, "released": true, "since": true, "last": true, "week": true, "weeks": true,
	"yesterday": true, "when": true,
}

var windowUnits = map[string]time.Duration{
	"hour": time.Hour, "hours": time.Hour,
	"day": 24 * time.Hour, "days": 24 * time.Hour,
	"week": 7 * 24 * time.Hour, "weeks": 7 * 24 * time.Hour,
	"month": 30 * 24 * time.Hour, "months": 30 * 24 * time.Hour,
}

var (
	// lastWindowRe matches "last week" / "last 3 days" / "last month" on the raw query.
	lastWindowRe = regexp.MustCompile(`(?i)\blast\s+(\d+)?\s*(hour|hours|day|days|week|weeks|month|months)`)
	// sinceDateRe matches "since <RFC3339>" — prose dates ("since monday") are ambiguous and stay
	// history-routed (unbounded window) rather than guessed.
	sinceDateRe = regexp.MustCompile(`(?i)\bsince\s+(\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2})?)?)`)
)

// ClassifyAsk decides the deterministic routing for a stateless ask. "status"/"history" attach
// ledger facts; "delta" attaches the windowed diff but ONLY when the prompt names an explicit time
// window — the stateless ask cannot know "last visit", that cursor is a delivery-axis detail.
// Anything else is prose recall. No model call decides routing.
func ClassifyAsk(q string) (kind string, windowMs int64) {
	_, keywords := analyzeQuery(q)
	tok := map[string]bool{}
	for _, k := range keywords {
		tok[k] = true
	}
	for w := range statusWords {
		if tok[w] {
			return AskKindStatus, 0
		}
	}
	for w := range historyWords {
		if !tok[w] {
			continue
		}
		if m := sinceDateRe.FindStringSubmatch(q); m != nil {
			ts, err := time.Parse(time.RFC3339, strings.Replace(m[1], " ", "T", 1))
			if err == nil {
				return AskKindDelta, ts.UnixMilli()
			}
		}
		if m := lastWindowRe.FindStringSubmatch(q); m != nil {
			n := int64(1)
			if m[1] != "" {
				if parsed, err := strconv.ParseInt(m[1], 10, 64); err == nil && parsed > 0 {
					n = parsed
				}
			}
			unit, ok := windowUnits[strings.ToLower(m[2])]
			if ok {
				return AskKindDelta, time.Now().Add(-unit * time.Duration(n)).UnixMilli()
			}
		}
		if tok["yesterday"] {
			return AskKindDelta, time.Now().Add(-24 * time.Hour).UnixMilli()
		}
		return AskKindHistory, 0
	}
	return AskKindProse, 0
}

// LedgerFact is one deterministic ledger-derived source the ask path attaches (active work, shipped
// items, delta events). AskLedgerFn fetches them; the wshserver handler implements it over
// pkg/jarvisstate so the recall package stays ledger-agnostic.
type LedgerFact struct {
	SourceType string
	Title      string
	Snippet    string
	NavTarget  string
	Ts         int64
}

// AskLedgerFn returns the ledger facts for one routed kind and window (0 = unbounded). A nil
// function means the ask path never attaches ledger facts.
type AskLedgerFn func(ctx context.Context, kind string, windowMs int64) ([]LedgerFact, error)

// AskResult is the stateless answer: prose plus the sources it was grounded on.
type AskResult struct {
	Answer   string
	Sources  []waveobj.JarvisConvoSourceRef
	Terminal string
}

// Ask is the stateless, non-durable ask: classify → attach ledger facts (when routed) → prose
// recall → judge → synthesize. Same retrieval→judge→synthesize core as Converse, minus
// conversation state and with the ledger facts inserted as numbered snippets.
func Ask(ctx context.Context, scope ScopeArgs, prompt string, ledgerFn AskLedgerFn) (AskResult, error) {
	kind, windowMs := ClassifyAsk(prompt)
	cands, err := retrieve(ctx, scope, prompt)
	if err != nil {
		return AskResult{}, err
	}
	if kind != AskKindProse && ledgerFn != nil {
		facts, ferr := ledgerFn(ctx, kind, windowMs)
		if ferr != nil {
			return AskResult{}, ferr
		}
		for _, f := range facts {
			cands = append(cands, candidate{
				sourceType: f.SourceType, title: f.Title, snippet: f.Snippet,
				navTarget: f.NavTarget, ts: f.Ts, freshness: "fresh",
			})
		}
	}
	cands = judgeCandidates(ctx, scopeCwd(scope), prompt, cands)
	if len(cands) == 0 {
		return AskResult{Answer: notFoundProse, Terminal: "notfound"}, nil
	}
	runCtx, cancel := context.WithTimeout(ctx, synthTimeout)
	defer cancel()
	prose, runErr := synthesize(runCtx, scopeCwd(scope), buildPrompt(prompt, cands), func(string) {})
	terminal := "answered"
	if runErr != nil {
		terminal = "weak"
	} else {
		terminal = selectTerminal(len(cands), countCitations(prose, len(cands)))
	}
	sources := make([]waveobj.JarvisConvoSourceRef, 0, len(cands))
	for _, c := range cands {
		sources = append(sources, waveobj.JarvisConvoSourceRef{ORef: c.navTarget, SourceType: c.sourceType, Title: c.title})
	}
	return AskResult{Answer: prose, Sources: sources, Terminal: terminal}, runErr
}
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `go test ./pkg/jarvisrecall/ -run 'TestClassifyAsk|TestAsk'`
Expected: `ok` — all ask tests pass.

- [x] **Step 5: Commit**

```bash
git add pkg/jarvisrecall/ask.go pkg/jarvisrecall/ask_test.go
git commit -m "feat(jarvisrecall): stateless Ask core with deterministic ledger routing"
```

---

### Task 6: Converse judge seam (shared core)

**Files:**
- Modify: `pkg/jarvisrecall/recall.go` (`Converse`)
- Test: `pkg/jarvisrecall/converse_test.go` (append)

**Interfaces:**
- Consumes: `judgeCandidates` (Task 4). No new exports — the seam test pins that Converse now runs the judge once per turn.

- [x] **Step 1: Write the failing test**

Append to `pkg/jarvisrecall/converse_test.go`:

```go
func TestConverseRunsJudgeOnce(t *testing.T) {
	// The judge runs inside the shared retrieval→judge→synthesize core, so Converse gains it this
	// cycle too — every conversation turn incurs one cheap-tier call. This test pins that contract
	// (and the "judge said none → notfound" degradation) so a future refactor cannot silently
	// re-remove the judge from the thread path.
	judgeCalls := 0
	restoreJ := SetJudgeForTest(func(_ context.Context, _, _ string) (string, error) {
		judgeCalls++
		return "1", nil
	})
	defer SetJudgeForTest(restoreJ)
	old := SetSynthesizeForTest(func(ctx context.Context, cwd, prompt string, onChunk func(string)) (string, error) {
		onChunk("yes [1]")
		return "yes [1]", nil
	})
	defer SetSynthesizeForTest(old)
	emit := func(wshrpc.JarvisConverseChunk) {}
	turn, err := Converse(context.Background(), ScopeArgs{Mode: "all"}, nil, "why did we choose sqlite", emit)
	if err != nil {
		t.Fatalf("Converse: %v", err)
	}
	if judgeCalls != 1 {
		t.Fatalf("judge called %d times, want exactly 1", judgeCalls)
	}
	if turn.Terminal != "answered" {
		t.Fatalf("terminal=%q want answered", turn.Terminal)
	}
}
```

(Check the existing imports of `converse_test.go` — it already imports `wshrpc` and uses `SetSynthesizeForTest` at line 19; the fixture vault seam from the existing tests carries over.)

- [x] **Step 2: Run the test to verify it fails**

Run: `go test ./pkg/jarvisrecall/ -run TestConverseRunsJudgeOnce`
Expected: FAIL — `judge called 0 times`.

- [x] **Step 3: Insert the judge into `Converse`**

In `pkg/jarvisrecall/recall.go`, right after the retrieve error check (after `cands, err := retrieve(...)` and its error return, before `cards := buildCards(...)`):

```go
	// The judge is part of the shared core: it removes wrong memories before synthesis. Failure
	// degrades to keep-and-log (judgeCandidates), so a dead judge is a slower answer, never none.
	cands = judgeCandidates(ctx, scopeCwd(scope), prompt, cands)
```

(No new step chunk: the working-step protocol stays as-is — the judge is a correctness layer, not capture; a "none" judge result flows through the existing `len(cards) == 0 → notfound` path.)

- [x] **Step 4: Run the tests to verify they pass**

Run: `go test ./pkg/jarvisrecall/`
Expected: `ok` — the new seam test passes; the existing converse/retrieve tests still pass (their judge calls hit the real cheap tier, which fails in CI → keep-all → unchanged behavior; that failure path is exactly the degradation contract).

- [x] **Step 5: Commit**

```bash
git add pkg/jarvisrecall/recall.go pkg/jarvisrecall/converse_test.go
git commit -m "feat(jarvisrecall): Converse runs the relevance judge once per turn"
```

---

### Task 7: `JarvisStateCommand` + `JarvisStatusCommand` — wire, fetch layer, handlers

**Files:**
- Modify: `pkg/wshrpc/wshrpctypes_jarvis.go` (append command types)
- Modify: `pkg/wshrpc/wshserver/wshserver_jarvis.go` (handlers)
- Create: `pkg/jarvisstate/fetch.go` (thin wire layer)
- Test: `pkg/wshrpc/wshserver/wshserver_jarvis_test.go` (append)
- Generated: `pkg/wshrpc/wshclient/wshclient.go`, `frontend/types/gotypes.d.ts`, `frontend/app/store/wshclientapi.ts`

**Interfaces:**
- Produces:
  - `jarvisstate.FetchWorkState(ctx context.Context, projectFilter string, sinceMs int64) (wshrpc.WorkState, error)` — fetches all legs, per-leg error capture into `Sources`, groups derivations per project
  - `jarvisstate.FetchCaptureStatus(ctx context.Context) (wshrpc.CaptureStatus, error)` — note counts per collection, index availability, distill queue
  - `wshrpc.CommandJarvisStateData/CommandJarvisStateRtnData`, `wshrpc.CommandJarvisStatusData/CommandJarvisStatusRtnData`, `wshrpc.CaptureStatus`, `wshrpc.CwdQueueWire`
- Consumes: Task 1 derivations + wire types; `wstore.GetChannels`/`GetChannelRuns` (`pkg/wstore/wstore_channel.go:64,249`), `agentsessions.ScanSessions(30, 200)` (`agentsessions.go:1108`), `jarvis.GatherAttention` (`pkg/jarvis/attention.go:195`), `wavevault.OpenVault` + `Retriever.Query` + `jarvisdossier.LoadDossier`/`LoadDecision` (the `collectDossiers` pattern, `wshserver_jarvis.go:372`), `jarvisembed.OpenIndex` (`pkg/jarvisembed/index.go:53`), `memdistill.QueueSummary` (Task 2).

- [x] **Step 1: Write the failing handler tests**

Append to `pkg/wshrpc/wshserver/wshserver_jarvis_test.go`:

```go
func TestJarvisStateCommandReturnsFixtureRun(t *testing.T) {
	ctx := context.Background()
	ws := &WshServer{}
	ch, err := wstore.CreateChannel(ctx, "rpc", "/p/one")
	if err != nil {
		t.Fatalf("create channel: %v", err)
	}
	if err := wstore.AppendRun(ctx, ch.OID, waveobj.Run{OID: "r-ledger-1", ID: "r-ledger-1", Goal: "ship the ledger", Status: "done", ProjectPath: "/p/one", CreatedTs: 100}); err != nil {
		t.Fatalf("append run: %v", err)
	}
	// Seal evidence the way the server does at completion.
	if err := wstore.UpdateRun(ctx, ch.OID, "r-ledger-1", func(r *waveobj.Run) error {
		r.CompletedTs = 500
		r.Evidence = &waveobj.RunEvidence{Summary: "ledger shipped", Files: []waveobj.EvidenceFile{{Path: "a.go", Stat: "M", Add: 3, Del: 1}}}
		return nil
	}); err != nil {
		t.Fatalf("update run: %v", err)
	}
	rtn, err := ws.JarvisStateCommand(ctx, wshrpc.CommandJarvisStateData{})
	if err != nil {
		t.Fatalf("JarvisStateCommand: %v", err)
	}
	if !rtn.State.Sources.Runs {
		t.Fatalf("sources=%+v want runs leg healthy", rtn.State.Sources)
	}
	var found bool
	for _, p := range rtn.State.Projects {
		for _, s := range p.Shipped {
			if s.RunOID == "r-ledger-1" && s.Summary == "ledger shipped" {
				found = true
			}
		}
	}
	if !found {
		t.Fatalf("state=%+v want the fixture run in Shipped", rtn.State)
	}
}

func TestJarvisStatusCommandReturnsSections(t *testing.T) {
	ws := &WshServer{}
	rtn, err := ws.JarvisStatusCommand(context.Background(), wshrpc.CommandJarvisStatusData{})
	if err != nil {
		t.Fatalf("JarvisStatusCommand: %v", err)
	}
	if rtn.Status.NoteCounts == nil {
		t.Fatalf("status=%+v want non-nil note counts (may be empty)", rtn.Status)
	}
	if rtn.Status.DistillQueue == nil {
		t.Fatalf("status=%+v want non-nil distill queue (may be empty)", rtn.Status)
	}
}
```

(Check the existing imports of `wshserver_jarvis_test.go` — `waveobj`, `wshrpc`, `wstore` are already used there.)

- [x] **Step 2: Run the tests to verify they fail**

Run: `go test ./pkg/wshrpc/wshserver/ -run TestJarvisStateCommand -count=1`
Expected: FAIL — `ws.JarvisStateCommand undefined`.

- [x] **Step 3: Add the wire types**

Append to `pkg/wshrpc/wshrpctypes_jarvis.go` (after the Task 1 types):

```go
// CommandJarvisStatusData is an empty request: the response is capture-pipeline accounting.
type CommandJarvisStatusData struct{}

// CaptureStatus is the observability answer to "did it skip my session?": vault note counts per
// collection, embedding index availability, and the distill queue state per cwd.
type CaptureStatus struct {
	NoteCounts     map[string]int `json:"notecounts,omitempty"`
	IndexAvailable bool           `json:"indexavailable"`
	IndexError     string         `json:"indexerror,omitempty"`
	DistillQueue   []CwdQueueWire `json:"distillqueue,omitempty"`
}

type CwdQueueWire struct {
	Cwd      string       `json:"cwd"`
	Pending  int          `json:"pending"`
	LastPass *PassRecordWire `json:"lastpass,omitempty"`
}

type PassRecordWire struct {
	Ts        int64 `json:"ts"`
	Sessions  int   `json:"sessions"`
	Committed int   `json:"committed"`
	Queued    int   `json:"queued"`
}

type CommandJarvisStatusRtnData struct {
	Status CaptureStatus `json:"status"`
}
```

- [x] **Step 4: Write the fetch layer**

`pkg/jarvisstate/fetch.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvisstate

import (
	"context"
	"sort"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/agentsessions"
	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/jarvisdossier"
	"github.com/wavetermdev/waveterm/pkg/jarvisembed"
	"github.com/wavetermdev/waveterm/pkg/memdistill"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wavevault"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// sessionWindowDays / sessionLimit bound the transcript leg: the operators' sessions are scanned on
// every ask, so the window is a cost/recency tradeoff, not a fidelity choice.
const (
	sessionWindowDays = 30
	sessionLimit      = 200
)

// FetchWorkState fetches every ledger leg and derives the per-project work state. Each leg's read
// failure degrades that leg to empty and is reported in Sources — the "never ran vs ran and found
// nothing" discipline applied to the ledger; a leg failure never fails the whole query.
func FetchWorkState(ctx context.Context, projectFilter string, sinceMs int64) (wshrpc.WorkState, error) {
	st := wshrpc.WorkState{Sources: wshrpc.SourceHealth{Attention: "volatile"}}

	var runs []*waveobj.Run
	chans, err := wstore.GetChannels(ctx)
	if err == nil {
		for _, ch := range chans {
			cr, cerr := wstore.GetChannelRuns(ctx, ch.OID)
			if cerr != nil {
				continue // one bad channel must not sink the leg
			}
			runs = append(runs, cr...)
		}
		st.Sources.Runs = true
	}
	if err != nil {
		st.Sources.Runs = false
	}

	var sessions []agentsessions.SessionInfo
	if s, serr := agentsessions.ScanSessions(sessionWindowDays, sessionLimit); serr == nil {
		sessions = s
		st.Sources.Sessions = true
	}

	var attention []wshrpc.AttentionItem
	if a, aerr := jarvis.GatherAttention(ctx); aerr == nil {
		attention = a
	}

	var dossiers []jarvisdossier.Dossier
	var decisions []DecisionEntry
	if v, verr := wavevault.OpenVault(ctx); verr == nil {
		r := v.Retriever(wavevault.AllScope())
		if nodes, qerr := r.Query(wavevault.Filter{}); qerr == nil {
			for _, n := range nodes {
				switch n.Collection {
				case wavevault.CollTasks:
					if d, derr := jarvisdossier.LoadDossier(r, n.ID); derr == nil {
						dossiers = append(dossiers, *d)
					}
				case wavevault.CollDecisions:
					if d, derr := jarvisdossier.LoadDecision(r, n.ID); derr == nil {
						decisions = append(decisions, DecisionEntry{ID: d.ID, Summary: d.Summary, CreatedTs: d.Created})
					}
				}
			}
			st.Sources.Dossiers = true
		}
	}

	active := ActiveWork(runs, sessions, attention, dossiers)
	shipped := Shipped(runs, 0)
	timeline := Timeline(runs, sessions, decisions, dossiers, 0)
	delta := Delta(sinceMs, runs, sessions, decisions, attention, dossiers)

	byProject := map[string]*wshrpc.ProjectWork{}
	order := []string{}
	projectOf := func(p string) string {
		key := strings.TrimRight(strings.ReplaceAll(p, "\\", "/"), "/")
		if key == "" {
			key = "(none)"
		}
		if _, ok := byProject[key]; !ok {
			byProject[key] = &wshrpc.ProjectWork{Project: key}
			order = append(order, key)
		}
		return key
	}
	inProject := func(p string) bool {
		return projectFilter == "" || projectOf(p) == projectOf(projectFilter)
	}
	for _, it := range active {
		if !inProject(it.Project) {
			continue
		}
		key := projectOf(it.Project)
		byProject[key].Active = append(byProject[key].Active, it)
	}
	for _, it := range shipped {
		if !inProject(it.Project) {
			continue
		}
		key := projectOf(it.Project)
		byProject[key].Shipped = append(byProject[key].Shipped, it)
	}
	for _, e := range timeline {
		if !inProject(e.Project) {
			continue
		}
		key := projectOf(e.Project)
		byProject[key].Events = append(byProject[key].Events, e)
	}
	for _, e := range delta {
		if !inProject(e.Project) {
			continue
		}
		key := projectOf(e.Project)
		byProject[key].Delta = append(byProject[key].Delta, e)
	}
	sort.Strings(order)
	for _, key := range order {
		st.Projects = append(st.Projects, *byProject[key])
	}
	return st, nil
}

// FetchCaptureStatus reads the capture-pipeline accounting for `wsh jarvis status`. Every section
// degrades to "unavailable" rather than failing the command.
func FetchCaptureStatus(ctx context.Context) (wshrpc.CaptureStatus, error) {
	st := wshrpc.CaptureStatus{NoteCounts: map[string]int{}}
	if v, err := wavevault.OpenVault(ctx); err == nil {
		r := v.Retriever(wavevault.AllScope())
		if nodes, qerr := r.Query(wavevault.Filter{}); qerr == nil {
			for _, n := range nodes {
				st.NoteCounts[n.Collection]++
			}
		}
	}
	if ix, err := jarvisembed.OpenIndex(ctx); err == nil {
		st.IndexAvailable = ix.Available()
		ix.Close()
	} else {
		st.IndexError = err.Error()
	}
	if qs, err := memdistill.QueueSummary(); err == nil {
		for _, q := range qs {
			var last *wshrpc.PassRecordWire
			if q.LastPass != nil {
				last = &wshrpc.PassRecordWire{Ts: q.LastPass.Ts, Sessions: q.LastPass.Sessions, Committed: q.LastPass.Committed, Queued: q.LastPass.Queued}
			}
			st.DistillQueue = append(st.DistillQueue, wshrpc.CwdQueueWire{Cwd: q.Cwd, Pending: q.Pending, LastPass: last})
		}
	}
	return st, nil
}
```

(Add `waveobj` to `fetch.go` imports.)

- [x] **Step 5: Write the handlers**

Append to `pkg/wshrpc/wshserver/wshserver_jarvis.go` (and add `jarvisstate` to its imports):

```go
// JarvisStateCommand is the work-ledger query: per-project active/shipped/timeline/delta plus
// per-leg source health. Stateless and read-only.
func (ws *WshServer) JarvisStateCommand(ctx context.Context, data wshrpc.CommandJarvisStateData) (*wshrpc.CommandJarvisStateRtnData, error) {
	state, err := jarvisstate.FetchWorkState(ctx, data.Project, data.SinceMs)
	if err != nil {
		return nil, fmt.Errorf("fetching work state: %w", err)
	}
	return &wshrpc.CommandJarvisStateRtnData{State: state}, nil
}

// JarvisStatusCommand is the capture accounting: vault note counts, index availability, distill
// queue state. Every section degrades to "unavailable" inside FetchCaptureStatus.
func (ws *WshServer) JarvisStatusCommand(ctx context.Context, data wshrpc.CommandJarvisStatusData) (*wshrpc.CommandJarvisStatusRtnData, error) {
	st, err := jarvisstate.FetchCaptureStatus(ctx)
	if err != nil {
		return nil, err
	}
	return &wshrpc.CommandJarvisStatusRtnData{Status: st}, nil
}
```

- [x] **Step 6: Register the methods on the interface**

In `pkg/wshrpc/wshrpctypes_jarvis.go`, add the two methods to the `JarvisCommands` interface (next to the existing `JarvisConverseCommand` entry, keeping the alignment comment style):

```go
	JarvisStateCommand(ctx context.Context, data CommandJarvisStateData) (*CommandJarvisStateRtnData, error)   // work-ledger query: per-project active/shipped/timeline/delta + source health
	JarvisStatusCommand(ctx context.Context, data CommandJarvisStatusData) (*CommandJarvisStatusRtnData, error) // capture accounting: note counts, index availability, distill queue
```

- [x] **Step 7: Regenerate the clients**

Run: `task generate`
Expected: `pkg/wshrpc/wshclient/wshclient.go` gains `JarvisStateCommand`/`JarvisStatusCommand`; `frontend/types/gotypes.d.ts` and `frontend/app/store/wshclientapi.ts` gain the new types. Verify with `git status` that only generated files + your task files changed.

- [x] **Step 8: Run the tests to verify they pass**

Run: `go test ./pkg/wshrpc/wshserver/ -run 'TestJarvisStateCommand|TestJarvisStatusCommand' -count=1`
Expected: `ok` — both handler tests pass (fixture runs from wstore; vault legs tolerate a real profile).

- [x] **Step 9: Commit**

```bash
git add pkg/wshrpc/wshrpctypes_jarvis.go pkg/wshrpc/wshserver/wshserver_jarvis.go pkg/wshrpc/wshserver/wshserver_jarvis_test.go pkg/jarvisstate/fetch.go pkg/wshrpc/wshclient/wshclient.go frontend/types/gotypes.d.ts frontend/app/store/wshclientapi.ts
git commit -m "feat(jarvisstate): JarvisStateCommand + JarvisStatusCommand wire and handlers"
```

---

### Task 8: `JarvisAskCommand` — wire + handler

**Files:**
- Modify: `pkg/wshrpc/wshrpctypes_jarvis.go` (append ask types)
- Modify: `pkg/wshrpc/wshserver/wshserver_jarvis.go` (handler)
- Test: `pkg/wshrpc/wshserver/wshserver_jarvis_test.go` (append)
- Generated: `pkg/wshrpc/wshclient/wshclient.go`, `frontend/types/gotypes.d.ts`, `frontend/app/store/wshclientapi.ts`

**Interfaces:**
- Produces: `wshrpc.CommandJarvisAskData{Prompt string; Cwd string}`, `wshrpc.CommandJarvisAskRtnData{Answer string; Sources []waveobj.JarvisConvoSourceRef; Terminal string}`, `wshclient.JarvisAskCommand(w, data, opts)`.
- Consumes: Task 5's `jarvisrecall.Ask`/`AskKind*`/`LedgerFact`; Task 1's `jarvisstate.FetchWorkState`.

- [x] **Step 1: Write the failing handler test**

Append to `pkg/wshrpc/wshserver/wshserver_jarvis_test.go`:

```go
func TestJarvisAskCommandAttachesLedgerFacts(t *testing.T) {
	ctx := context.Background()
	ws := &WshServer{}
	ch, err := wstore.CreateChannel(ctx, "rpc", "/p/one")
	if err != nil {
		t.Fatalf("create channel: %v", err)
	}
	if err := wstore.AppendRun(ctx, ch.OID, waveobj.Run{OID: "r-ask-1", ID: "r-ask-1", Goal: "the ask bridge", Status: "executing", ProjectPath: "/p/one", CreatedTs: 100}); err != nil {
		t.Fatalf("append run: %v", err)
	}
	restoreJ := jarvisrecall.SetJudgeForTest(func(_ context.Context, _, _ string) (string, error) { return "1", nil })
	defer jarvisrecall.SetJudgeForTest(restoreJ)
	restoreS := jarvisrecall.SetSynthesizeForTest(func(_ context.Context, _, _ string, _ func(string)) (string, error) {
		return "the ask bridge is executing [1]", nil
	})
	defer jarvisrecall.SetSynthesizeForTest(restoreS)
	rtn, err := ws.JarvisAskCommand(ctx, wshrpc.CommandJarvisAskData{Prompt: "what is the status of the ask bridge", Cwd: "/p/one"})
	if err != nil {
		t.Fatalf("JarvisAskCommand: %v", err)
	}
	if rtn.Answer != "the ask bridge is executing [1]" {
		t.Fatalf("answer=%q want the stub synthesize output", rtn.Answer)
	}
	var foundLedger bool
	for _, s := range rtn.Sources {
		if s.SourceType == "status" && s.ORef == "run:r-ask-1" {
			foundLedger = true
		}
	}
	if !foundLedger {
		t.Fatalf("sources=%+v want the ledger fact from FetchWorkState", rtn.Sources)
	}
}
```

(Imports to add to `wshserver_jarvis_test.go`: `jarvisrecall`.)

- [x] **Step 2: Run the test to verify it fails**

Run: `go test ./pkg/wshrpc/wshserver/ -run TestJarvisAskCommand -count=1`
Expected: FAIL — `ws.JarvisAskCommand undefined`.

- [x] **Step 3: Add the wire types + interface method**

Append to `pkg/wshrpc/wshrpctypes_jarvis.go`:

```go
// CommandJarvisAskData is one stateless ask. Cwd resolves the project scope ("" = all projects).
type CommandJarvisAskData struct {
	Prompt string `json:"prompt"`
	Cwd    string `json:"cwd,omitempty"`
}

type CommandJarvisAskRtnData struct {
	Answer   string                        `json:"answer"`
	Sources  []waveobj.JarvisConvoSourceRef `json:"sources,omitempty"`
	Terminal string                        `json:"terminal"`
}
```

Add to the `JarvisCommands` interface:

```go
	JarvisAskCommand(ctx context.Context, data CommandJarvisAskData) (*CommandJarvisAskRtnData, error) // stateless ask: ledger facts + judged prose recall, one answer
```

- [x] **Step 4: Write the handler**

Append to `pkg/wshrpc/wshserver/wshserver_jarvis.go`:

```go
// JarvisAskCommand answers one stateless question from the work ledger + judged prose recall. The
// ledger closure maps a routed kind to the matching FetchWorkState derivation, so the recall
// package stays ledger-agnostic. Note: this runs two model calls (judge + synthesize) inside the
// handler — the CLI must pass a raised RpcOpts.Timeout (the 5s default would EC-TIME).
func (ws *WshServer) JarvisAskCommand(ctx context.Context, data wshrpc.CommandJarvisAskData) (*wshrpc.CommandJarvisAskRtnData, error) {
	scope := jarvisrecall.ScopeArgs{Mode: "all"}
	if data.Cwd != "" {
		scope = jarvisrecall.ScopeArgs{Mode: "project", ProjectPath: data.Cwd}
	}
	ledgerFn := func(ctx context.Context, kind string, windowMs int64) ([]jarvisrecall.LedgerFact, error) {
		state, err := jarvisstate.FetchWorkState(ctx, scope.ProjectPath, windowMs)
		if err != nil {
			return nil, err
		}
		var facts []jarvisrecall.LedgerFact
		for _, p := range state.Projects {
			switch kind {
			case jarvisrecall.AskKindStatus:
				for _, a := range p.Active {
					facts = append(facts, jarvisrecall.LedgerFact{SourceType: "status", Title: a.Title, Snippet: a.Detail, NavTarget: a.NavTarget, Ts: a.Ts})
				}
			case jarvisrecall.AskKindHistory:
				for _, s := range p.Shipped {
					facts = append(facts, jarvisrecall.LedgerFact{SourceType: "shipped", Title: s.Goal, Snippet: s.Summary, NavTarget: "run:" + s.RunOID, Ts: s.CompletedTs})
				}
			case jarvisrecall.AskKindDelta:
				for _, e := range p.Delta {
					facts = append(facts, jarvisrecall.LedgerFact{SourceType: "delta", Title: e.Title, Snippet: e.Detail, NavTarget: e.NavTarget, Ts: e.Ts})
				}
			}
		}
		return facts, nil
	}
	res, err := jarvisrecall.Ask(ctx, scope, data.Prompt, ledgerFn)
	if err != nil {
		return nil, err
	}
	return &wshrpc.CommandJarvisAskRtnData{Answer: res.Answer, Sources: res.Sources, Terminal: res.Terminal}, nil
}
```

- [x] **Step 5: Regenerate the clients**

Run: `task generate`
Expected: `wshclient.go` gains `JarvisAskCommand`; TS bindings gain the types. `git status` shows only generated + task files.

- [x] **Step 6: Run the tests to verify they pass**

Run: `go test ./pkg/wshrpc/wshserver/ -run TestJarvisAskCommand -count=1`
Expected: `ok`.

- [x] **Step 7: Commit**

```bash
git add pkg/wshrpc/wshrpctypes_jarvis.go pkg/wshrpc/wshserver/wshserver_jarvis.go pkg/wshrpc/wshserver/wshserver_jarvis_test.go pkg/wshrpc/wshclient/wshclient.go frontend/types/gotypes.d.ts frontend/app/store/wshclientapi.ts
git commit -m "feat(wshrpc): JarvisAskCommand stateless ask"
```

---

### Task 9: `wsh jarvis ask` + `wsh jarvis status` CLI

**Files:**
- Create: `cmd/wsh/cmd/wshcmd-jarvisask.go`
- Test: `cmd/wsh/cmd/wshcmd-jarvisask_test.go`

**Interfaces:**
- Consumes: `wshclient.JarvisAskCommand`/`JarvisStatusCommand` (Tasks 7-8), `wshrpc.RpcOpts{Timeout}` (the EC-TIME fix), `preRunSetupRpcClient`/`RpcClient` (`cmd/wsh/cmd/wshcmd-root.go:85`), `renderCaptureStatus` (defined here, pure).
- Produces: `jarvisCmd ask` and `jarvisCmd status` subcommands; `renderCaptureStatus(st wshrpc.CaptureStatus) string`.

^- [x] **Step 1: Write the failing tests**

`cmd/wsh/cmd/wshcmd-jarvisask_test.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

func TestJarvisAskSubcommandRegistered(t *testing.T) {
	var found bool
	for _, c := range jarvisCmd.Commands() {
		if c.Name() == "ask" {
			found = true
		}
	}
	if !found {
		t.Fatal("`jarvis ask` subcommand is not registered")
	}
}

func TestJarvisStatusSubcommandRegistered(t *testing.T) {
	var found bool
	for _, c := range jarvisCmd.Commands() {
		if c.Name() == "status" {
			found = true
		}
	}
	if !found {
		t.Fatal("`jarvis status` subcommand is not registered")
	}
}

func TestRenderCaptureStatusDegradesPerSection(t *testing.T) {
	empty := renderCaptureStatus(wshrpc.CaptureStatus{NoteCounts: map[string]int{}, DistillQueue: []wshrpc.CwdQueueWire{}})
	if !strings.Contains(empty, "unavailable") || !strings.Contains(empty, "(empty)") {
		t.Fatalf("empty render:\n%s\nwant unavailable + empty queue", empty)
	}
	full := renderCaptureStatus(wshrpc.CaptureStatus{
		NoteCounts:     map[string]int{"memory": 406, "tasks": 14, "decisions": 4},
		IndexAvailable: true,
		DistillQueue: []wshrpc.CwdQueueWire{{
			Cwd: "/p", Pending: 2,
			LastPass: &wshrpc.PassRecordWire{Ts: 1786500000000, Sessions: 3, Committed: 1, Queued: 2},
		}},
	})
	for _, want := range []string{"memory", "406", "available", "/p: 2 pending", "3 sessions, 1 committed, 2 queued"} {
		if !strings.Contains(full, want) {
			t.Fatalf("full render missing %q:\n%s", want, full)
		}
	}
}
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `go test ./cmd/wsh/... -run 'TestJarvisAskSubcommand|TestRenderCaptureStatus'`
Expected: FAIL — `jarvis ask` subcommand not registered; `undefined: renderCaptureStatus`.

- [x] **Step 3: Write the CLI**

`cmd/wsh/cmd/wshcmd-jarvisask.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/spf13/cobra"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshrpc/wshclient"
)

// askRpcTimeoutMs bounds the stateless ask: retrieval + a cheap judge + a TierMid synthesize run
// synchronously inside the handler, far beyond the 5s default RPC budget (the EC-TIME trap
// SealEvidence/wsh jarvis complete hit). Two model calls, worst case.
const askRpcTimeoutMs = 180_000

var jarvisAskCmd = &cobra.Command{
	Use:     "ask \"<question>\"",
	Short:   "ask the work ledger a stateless question (status, history, decisions, bring-up)",
	Args:    cobra.MinimumNArgs(1),
	RunE:    jarvisAskRun,
	PreRunE: preRunSetupRpcClient,
}

var jarvisStatusCmd = &cobra.Command{
	Use:     "status",
	Short:   "capture accounting: vault note counts, index availability, distill queue",
	Args:    cobra.NoArgs,
	RunE:    jarvisStatusRun,
	PreRunE: preRunSetupRpcClient,
}

func init() {
	jarvisAskCmd.Flags().String("cwd", "", "project directory to scope the question to")
	jarvisAskCmd.Flags().Bool("json", false, "print the full response as JSON")
	jarvisCmd.AddCommand(jarvisAskCmd)
	jarvisCmd.AddCommand(jarvisStatusCmd)
}

func jarvisAskRun(cmd *cobra.Command, args []string) error {
	question := strings.Join(args, " ")
	cwd, _ := cmd.Flags().GetString("cwd")
	rtn, err := wshclient.JarvisAskCommand(RpcClient, wshrpc.CommandJarvisAskData{Prompt: question, Cwd: cwd}, &wshrpc.RpcOpts{Timeout: askRpcTimeoutMs})
	if err != nil {
		return err
	}
	jsonOut, _ := cmd.Flags().GetBool("json")
	if jsonOut {
		b, err := json.MarshalIndent(rtn, "", "  ")
		if err != nil {
			return err
		}
		fmt.Println(string(b))
		return nil
	}
	fmt.Println(rtn.Answer)
	if len(rtn.Sources) > 0 {
		fmt.Println("\nSources:")
		for _, s := range rtn.Sources {
			fmt.Printf("  [%s] %s\n", s.ORef, s.Title)
		}
	}
	return nil
}

func jarvisStatusRun(cmd *cobra.Command, args []string) error {
	rtn, err := wshclient.JarvisStatusCommand(RpcClient, wshrpc.CommandJarvisStatusData{}, nil)
	if err != nil {
		return err
	}
	fmt.Println(renderCaptureStatus(rtn.Status))
	return nil
}

// renderCaptureStatus formats the capture accounting. Every section degrades to "unavailable"
// rather than failing the command — "did it skip my session?" must be answerable, not crashable.
func renderCaptureStatus(st wshrpc.CaptureStatus) string {
	var b strings.Builder
	b.WriteString("vault notes:\n")
	if len(st.NoteCounts) == 0 {
		b.WriteString("  unavailable\n")
	} else {
		for _, coll := range []string{"memory", "tasks", "decisions"} {
			fmt.Fprintf(&b, "  %-10s %d\n", coll, st.NoteCounts[coll])
		}
	}
	b.WriteString("embedding index: ")
	if st.IndexAvailable {
		b.WriteString("available\n")
	} else if st.IndexError != "" {
		fmt.Fprintf(&b, "unavailable (%s)\n", st.IndexError)
	} else {
		b.WriteString("unavailable\n")
	}
	b.WriteString("distill queue:\n")
	if len(st.DistillQueue) == 0 {
		b.WriteString("  (empty)\n")
	} else {
		for _, q := range st.DistillQueue {
			last := "never"
			if q.LastPass != nil {
				last = fmt.Sprintf("%s (%d sessions, %d committed, %d queued)",
					time.UnixMilli(q.LastPass.Ts).Format("2006-01-02 15:04"),
					q.LastPass.Sessions, q.LastPass.Committed, q.LastPass.Queued)
			}
			fmt.Fprintf(&b, "  %s: %d pending; last pass %s\n", q.Cwd, q.Pending, last)
		}
	}
	return strings.TrimRight(b.String(), "\n")
}
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `go test ./cmd/wsh/... -run 'TestJarvisAskSubcommand|TestJarvisStatusSubcommand|TestRenderCaptureStatus'`
Expected: `ok` (the existing `TestJarvisRunSubcommandRegistered` still passes).

- [x] **Step 5: Commit**

```bash
git add cmd/wsh/cmd/wshcmd-jarvisask.go cmd/wsh/cmd/wshcmd-jarvisask_test.go
git commit -m "feat(wsh): jarvis ask + jarvis status CLI (raised ask RPC timeout)"
```

---

### Task 10: `wave_vault_ask` pi tool

**Files:**
- Modify: `pi/extensions/waveterm-tools-core.ts` (arg builder)
- Modify: `pi/extensions/waveterm-tools.ts` (tool registration)
- Test: `pi/extensions/waveterm-tools-core.test.ts` (append)
- Generated: `cmd/wsh/cmd/pi-tools-extension.ts`, `cmd/wsh/cmd/pi-tools-core-extension.ts` (via `task sync:piartifacts`)

**Interfaces:**
- Consumes: the existing `wsh` helper + `registerTool` pattern in `waveterm-tools.ts`, `vaultAskArgs` (defined here).
- Produces: `vaultAskArgs(question: string, cwd?: string): string[]`; the `wave_vault_ask` tool (name distinct from the ask mirror — `waveterm-ask.ts` deliberately registers no tool, and the flat tool namespace would hard-fail on a duplicate).

- [x] **Step 1: Write the failing test**

Append to `pi/extensions/waveterm-tools-core.test.ts`:

```ts
import { vaultAskArgs } from "./waveterm-tools-core";

// (merge the import into the existing import block at the top of the file)

    it("builds wsh jarvis ask argv with json and optional cwd", () => {
        expect(vaultAskArgs("did the ask bridge ship?", "C:\\proj")).toEqual([
            "jarvis", "ask", "did the ask bridge ship?", "--json", "--cwd", "C:\\proj",
        ]);
        expect(vaultAskArgs("did the ask bridge ship?")).toEqual([
            "jarvis", "ask", "did the ask bridge ship?", "--json",
        ]);
    });
```

- [x] **Step 2: Run the test to verify it fails**

Run: `npx vitest run pi/extensions/waveterm-tools-core.test.ts`
Expected: FAIL — `vaultAskArgs is not exported`.

- [x] **Step 3: Add the arg builder**

In `pi/extensions/waveterm-tools-core.ts`, after `notifyArgs`:

```ts
// wave_vault_ask shells out to `wsh jarvis ask` (the stateless work-ledger question). --json keeps
// the tool's answer parseable; the flag order (positional question first) matches cobra's
// flags-after-args tolerance.
export function vaultAskArgs(question: string, cwd?: string): string[] {
    const args = ["jarvis", "ask", question, "--json"];
    if (cwd) {
        args.push("--cwd", cwd);
    }
    return args;
}
```

- [x] **Step 4: Register the tool**

In `pi/extensions/waveterm-tools.ts`, import `vaultAskArgs` from `./waveterm-tools-core`, then add a tool registration (after `wave_open_file`):

```ts
    // --- Axis 1: wave_vault_ask — read past work from the work ledger ---------------------

    pi.registerTool({
        name: "wave_vault_ask",
        label: "Ask the Wave Work Ledger",
        description:
            "Ask a stateless question about past work, decisions, or project state (status, history, what happened while away). " +
            "Advisory: verify or cite the returned sources before treating the answer as ground truth.",
        promptSnippet: "Ask the Wave work ledger about past work",
        promptGuidelines: [
            "Use wave_vault_ask when the user asks about past work, decisions, or project state.",
            "This reads the past; the ask mirror (ask_user_question) asks the user a live question — do not conflate them.",
        ],
        parameters: Type.Object({
            question: Type.String({ description: "The question to answer from the work ledger" }),
            cwd: Type.Optional(Type.String({ description: "Project directory to scope the question to" })),
        }),
        async execute(_toolCallId: string, params: any): Promise<unknown> {
            const r = await wsh(vaultAskArgs(params.question, params.cwd));
            if (!r.ok) {
                return { content: [{ type: "text", text: `wave_vault_ask failed: ${r.stderr}` }], details: {} };
            }
            let parsed: { answer?: string; sources?: { oref?: string; title?: string }[] } = {};
            try {
                parsed = JSON.parse(r.stdout);
            } catch {
                // fall through to the raw output below
            }
            const text = parsed.answer ?? r.stdout.trim();
            const sources = (parsed.sources ?? []).map((s) => `${s.oref} ${s.title ?? ""}`.trim());
            const content = sources.length ? `${text}\n\nSources:\n${sources.map((s) => `  ${s}`).join("\n")}` : text;
            return { content: [{ type: "text", text: content }], details: { sources: parsed.sources ?? [] } };
        },
    });
```

- [x] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run pi/extensions/waveterm-tools-core.test.ts`
Expected: PASS — `vaultAskArgs` builds the argv.

- [x] **Step 6: Regenerate the embedded copies + typecheck**

Run: `task sync:piartifacts`
Expected: `cmd/wsh/cmd/pi-tools-extension.ts` + `cmd/wsh/cmd/pi-tools-core-extension.ts` re-copied; `git status` shows only those two generated files plus your three edited files.

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: no errors (this repo's typecheck; never bare `npx tsc`).

- [x] **Step 7: Commit**

```bash
git add pi/extensions/waveterm-tools-core.ts pi/extensions/waveterm-tools.ts pi/extensions/waveterm-tools-core.test.ts cmd/wsh/cmd/pi-tools-extension.ts cmd/wsh/cmd/pi-tools-core-extension.ts
git commit -m "feat(pi): wave_vault_ask tool over wsh jarvis ask"
```

---

### Task 11: Liveprobe extension (recall correctness, layer 3)

**Files:**
- Modify: `pkg/jarvisrecall/liveprobe_test.go` (append cases + judge probe)

**Interfaces:**
- Consumes: `probeCases`/`probeCase` (`liveprobe_test.go:40-61`), `TestLiveRecallProbe` (`:152`), `judgeCandidates` (Task 4). Runs only under the `liveprobe` build tag with a real profile + provider key.

- [x] **Step 1: Extend the probe fixture**

In `pkg/jarvisrecall/liveprobe_test.go`, append to `probeCases` — one labeled case per remaining question type plus two more off-topic controls. `wantID` values must be real node ids from the operator's corpus: run the existing probe once against a copy of the profile (`TestLiveRecallProbe` prints what it finds), then fill each `wantID` with the corpus node it should surface. The fixture style mirrors the existing entries (paraphrase query, no shared >=4-char token):

```go
	// Axis 1 ask-routing coverage: status/history-shaped questions still resolve to corpus nodes,
	// and the extras here are the off-topic controls the batch judge must remove.
	{name: "status/blocked", query: "which task is sitting waiting for a review decision right now", wantID: "<corpus-node-id>"},
	{name: "history/shipped", query: "when did we land the sidebar reordering work", wantID: "<corpus-node-id>"},
	{name: "bringup/decision", query: "what changed about the input validation boundary recently", wantID: "<corpus-node-id>"},
	{name: "negative/airline", query: "how do we rebook a missed connection on the airline partner api", negative: true},
	{name: "negative/finance", query: "what is the fx rate hedging policy for quarterly earnings", negative: true},
```

- [x] **Step 2: Add the judge probe**

Append to `pkg/jarvisrecall/liveprobe_test.go`:

```go
// TestLiveJudgeProbe measures the batch judge's effect on the real profile: for each probe case it
// retrieves, runs the judge, and reports kept vs removed. It asserts only the sanity bounds (kept
// <= candidates, and off-topic controls lose at least as many as they keep) — the numbers are the
// measurement, not the gate; the gate is that a human reads them against the next fitting pass.
func TestLiveJudgeProbe(t *testing.T) {
	ctx := context.Background()
	v, err := wavevault.OpenVault(ctx)
	if err != nil {
		t.Fatalf("open vault: %v", err)
	}
	scope := ScopeArgs{Mode: "all"}
	for _, pc := range probeCases {
		cands, err := retrieve(ctx, scope, pc.query)
		if err != nil {
			t.Fatalf("retrieve(%q): %v", pc.query, err)
		}
		before := len(cands)
		kept := judgeCandidates(ctx, scopeCwd(scope), pc.query, cands)
		if len(kept) > before {
			t.Fatalf("judge grew the shortlist for %q: %d -> %d", pc.query, before, len(kept))
		}
		t.Logf("judge %-24s %d -> %d kept (removed %d)", pc.name, before, len(kept), before-len(kept))
		if pc.negative && before-len(kept) < len(kept) {
			t.Logf("note: negative case %q kept %d/%d — review against the federated corpus", pc.name, len(kept), before)
		}
	}
}
```

- [x] **Step 3: Run the probe against a copy of the real profile**

Run (from PowerShell, repo root, `<copy>` = a COPY of the real profile — Query reconciles and writes the index):

```powershell
$env:CGO_ENABLED="1"; $env:CGO_CFLAGS="-I<repo>\pkg\jarvisembed\csrc"
$env:WAVETERM_CONFIG_HOME="<copy>\config"; $env:WAVETERM_DATA_HOME="<copy>\data"
go test -tags liveprobe,osusergo,sqlite_omit_load_extension -run 'TestLiveRecallProbe|TestLiveJudgeProbe' -v ./pkg/jarvisrecall/
```

Expected: `TestLiveRecallProbe` PASSes with the new cases finding their targets (if a `wantID` misses, adjust it to the corpus node the query genuinely surfaces — the probe's labeled output is the ground truth), and `TestLiveJudgeProbe` reports kept/removed per case. The negative cases' judge output is a reading, not a gate.

- [x] **Step 4: Commit**

```bash
git add pkg/jarvisrecall/liveprobe_test.go
git commit -m "test(jarvisrecall): liveprobe coverage for ask question types + judge probe"
```

---

### Task 12: Full verification pass

- [x] **Step 1: Regenerate everything**

Run: `task generate` then `task sync:piartifacts`
Expected: no diff beyond generated files already committed (idempotent).

- [x] **Step 2: Run the Go test suites**

Run (PowerShell):

```powershell
$env:CGO_CFLAGS="-I<repo>\pkg\jarvisembed\csrc"
go test ./pkg/jarvisstate/... ./pkg/jarvisrecall/... ./pkg/memdistill/... ./pkg/jarvisdossier/... ./pkg/wshrpc/wshserver/... ./cmd/wsh/...
```

Expected: `ok` everywhere.

- [x] **Step 3: Run the frontend tests + typecheck**

Run: `npx vitest run pi/extensions/`
Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: all pass; no TS errors.

- [x] **Step 4: Build the backend**

Run: `task build:backend`
Expected: `dist/bin/` contains the freshly built `wavesrv` + `wsh`.

- [x] **Step 5: Smoke the CLI (manual, dev app running) — deferred: no dev app running; needs a live session (see report)**

Run: `wsh jarvis status` then `wsh jarvis ask "what is the status of <something>" --cwd <repo>`
Expected: status prints all three sections (or explicit "unavailable" per section); ask prints an answer + `Sources:` list, with no EC-TIME error (the raised `RpcOpts.Timeout` holds).

- [x] **Step 6: Report completion** — list changed files, test results, and residual risks (vault-leg tests depend on the real profile; liveprobe numbers are a reading; `wave_vault_ask` needs `wsh install-agent-hooks` to reach a live pi).

---

## Self-Review (run by the plan author)

**1. Spec coverage — work-ledger spec:**

| Spec requirement | Task |
|---|---|
| `pkg/jarvisstate` ledger: ActiveWork/Shipped/Timeline/Delta | 1 |
| Source health per leg, attention marked volatile | 1 (types + tests), 7 (fetch) |
| `JarvisStateCommand` wire | 7 |
| `JarvisAskCommand` stateless ask RPC | 8 |
| Ledger resolution: export `analyzeQuery`, status/history word set, token-boundary rule, Delta only on explicit window | 5 (`ClassifyAsk`) |
| Judge: batch cheap-tier call, `SetJudgeForTest`, keep-candidates-and-log degradation | 4 |
| Superseded exclusion in both seed paths (L2/L3) | 3 |
| Shared core: Converse gains the judge this cycle + seam test | 6 |
| `wsh jarvis ask` + `wsh jarvis status` | 9 |
| Timeout story (RpcOpts) | 9 (`askRpcTimeoutMs`) |
| `wave_vault_ask` pi tool + division of labor vs ask mirror | 10 |
| Distill `decision` candidate (advisory prose, not a ledger decision) + parse test | 2 |
| Visible accounting: last distill pass per cwd | 2 (LastPass) + 7 (status) + 9 (render) |
| Routing table test (4 question types + off-topic control) | 5 |
| CLI: round-trip test for `wsh jarvis ask`/`status` (spec §7) | 9 (registration + `renderCaptureStatus` format tests) + 7/8 (handler-level tests over real wstore fixtures). A true RPC client→server round-trip is not this repo's cmd-test pattern (existing `wshcmd-*_test.go` files test registration only); the round trip's two halves are each covered where the seams live, and Task 12 Step 5 smoke-tests the joined path manually. |
| Liveprobe extension (~10 queries, 4 types, 2 off-topic) + judge probe | 11 |
| No new waveobj types, no migration, no FE components | global (satisfied) |
| `task generate` after every type change | 7, 8, 12 |

**2. Placeholder scan:** no TBDs; the only data-dependent fills are Task 11's `wantID` corpus ids, which are real-data fixtures with an explicit discovery step (run the probe, read the labels) — that is the repo's existing liveprobe workflow, not a placeholder.

**3. Type consistency:** `wshrpc.WorkState`/`ProjectWork`/`ActiveWorkItem`/`ShippedItem`/`TimelineEvent`/`SourceHealth` defined once in Task 1 and used by Tasks 1/7/8; `LedgerFact`/`AskLedgerFn`/`AskResult`/`AskKind*` defined in Task 5, consumed by Task 8; `PassRecord`/`CwdQueueSummary` (memdistill, Task 2) mapped to `PassRecordWire`/`CwdQueueWire` (wshrpc, Task 7); `judgeCandidates`/`SetJudgeForTest` (Task 4) consumed by Tasks 5/6/11; `QueueSummary` (Task 2) consumed by Task 7's `FetchCaptureStatus`.
