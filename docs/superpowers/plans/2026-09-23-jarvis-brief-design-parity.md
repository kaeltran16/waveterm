# Jarvis Brief design parity Implementation Plan

**Setup:** `mkdir -p dist/bin && task worktree:prepare`
**Verify:** `go test ./pkg/jarvis/... ./pkg/jarvisstate/... ./pkg/wshrpc/... ./cmd/wsh/... && npx vitest run frontend/app/view && node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit && go vet ./pkg/jarvis/... ./pkg/jarvisstate/... ./pkg/wshrpc/... ./cmd/wsh/...`

> **For agentic workers:** this plan runs on the Arc orchestrator engine. Each task is one worker in a lane worktree; follow its steps in order. Steps use checkbox (`- [ ]`) syntax for tracking.

## Orchestrated run: rules for every worker

- **Commit your task on your lane branch.** Every "Commit"/checkpoint step is a real `git commit` (message `type(scope): description`, no co-author trailer). The engine squash-merges each lane into the run branch; the owner squashes the run into one commit on `main` after review.
- **Never run `task dev`, `task check:ts`, `task build:*` or `npm install` in your worktree.** `task dev` and `task check:ts` npm-install over the shared `node_modules` junction, and the build tasks write binaries. Typecheck with `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` wherever a step says `task check:ts`. `task generate` is safe; commit what it writes.
- **Skip every step that drives the dev app**: CDP shots, `task verify:ui`, `seed-brief.mjs`, a throwaway run. No dev app runs your worktree's code. Your gate is the task's unit tests, the typecheck and `go vet`. The side-by-side comparison against the design happens after the run, on the merged branch. Task 14 builds its scripts and runs only `design-states.mjs`, which needs headless Chrome, not the dev app.
- **Line numbers in this plan predate earlier tasks' edits.** Locate code by symbol, and read the current file before editing.
- **Stay inside your task's Files list.** Another lane may be editing the files it does not name.

**Goal:** Make the Jarvis Brief match the handoff design `docs/prototype/jarvis-brief-editing.dc.html`, **variant A**, region by region (header, Waiting on you, Initiatives + inline tracker, Runs, Behind you, Chunk sidebar, run sheet, modals), with real data behind every element the design shows.

**Architecture:** The design is the spec. Every row, sheet and modal is rebuilt to the design's anatomy, with the design's hex values mapped to existing `@theme` tokens. The data the design shows that the backend lacks is built for real:
- note authorship (plus the session and run behind an agent note);
- a chunk note dropped when a linked run seals, which carries the run report into the Chunk sidebar;
- queue-row task ids for Approve / Retry;
- a shipped item's report flag.

Features the app has that the design lacks stay, restyled in the design's visual language:
- project search in the modals;
- the Start-from and Routing launcher sections;
- lead and worker routes in the Profile;
- per-project autonomy (moves into the Profile);
- the record band.

**Tech Stack:** Go (`pkg/jarvis`, `pkg/jarvisstate`, `pkg/wshrpc`, `cmd/wsh`), React 19 + Tailwind 4 + jotai (`frontend/app/view/jarvis`), vitest, CDP scenarios (`scripts/cdp/scenarios.mjs`).

**Spec:** `docs/prototype/jarvis-brief-editing.dc.html`, variant A. It is byte-identical to `Jarvis Brief.dc.html` in claude.ai/design project `84a7aa18…`. Every "design L<n>" below cites a line of that file. `docs/superpowers/specs/2026-09-23-jarvis-brief-editing-design.md` covers the editing layer, which already shipped; this plan supersedes its "Everything outside it is unchanged" scope line.

## Global Constraints

- **No raw colours in components.** Map every design hex through this table, and never introduce a new token:

| design | token | design | token |
|---|---|---|---|
| `#0c0e11` | `background` | `#e6e9ed` | `primary` |
| `#0e1116` | `surface` | `#dfe4ea` | `ink-hi` |
| `#13171d` | `surface-raised` | `#cfd5db` | `secondary` |
| `#171c22` | `surface-hover` | `#9aa3ad` | **`ink-mid`** (not `muted`) |
| `#1a222c` | `surface-selected` | `#7f858b` | `muted` |
| `#12161b` | `lane` | `#777f89` | `feed-label` |
| `#161a20` | `edge-faint` | `#4a525c` | `feed-glyph` |
| `#1c2128` / `#1a1f26` | `border` | `#aebfff` | `accent-soft` |
| `#20262e` | `edge-mid` | `#5e9cff` | `accent` |
| `#2a313a` | `edge-strong` | `#8da3ff` | `accenthover` |
| `#54c79a` | `success` | `#e6b450` | `asking` (state) / `warning` |
| `#e0726c` | `error` | `#f0d79f` | `warning-soft` |
| `#f0a9a4` | `error-soft` | `#2f6b55` | `success/45` |
| `rgba(94,156,255,.12)` | `accentbg` | `rgba(94,156,255,.3/.4/.6)` | `accent/30`, `/40`, `/60` |
| `rgba(230,180,80,.15/.3)` | `asking/15`, `asking/30` | `rgba(84,199,154,.15/.3)` | `success/15`, `success/30` |

- **Type scale, verbatim from the design:**
  - Region labels: `font-mono text-[10.5px] font-bold uppercase tracking-[.1em]`.
  - Mono meta text: `text-[10.5px]`.
  - Row meta and state columns: `text-[11px]`; state is `font-semibold`.
  - Row titles: `text-[13px]`.
  - The only 9.5px text is the run sheet's eyebrows (`tracking-[.13em]`) and the Chunk sidebar status-chip labels.
- **Pulse:** `animate-[pulseDot_1.8s_ease-in-out_infinite] motion-reduce:animate-none` (keyframes already exist in `frontend/tailwindsetup.css:308`).
- **Wording:** copy the design's strings verbatim wherever the data allows. A string built from data follows the design's pattern (e.g. `${n} things are waiting on you`).
- **Generated files:** `task generate` after any `pkg/wshrpc` / `pkg/waveobj` type change. Never hand-edit `frontend/types/gotypes.d.ts` or `wshclientapi.ts`.
- **Typecheck:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` in a lane worktree (`task check:ts` elsewhere; about 2 minutes; the baseline is clean). Frontend tests: `npx vitest run <file>`. Go: `go test ./pkg/jarvis/... ./pkg/jarvisstate/... ./pkg/wshrpc/...`.
- **Formatting:** check only the files you touch (`npx prettier --check <files>`, `gofmt -l <files>`). Never `--write` the tree, and never run prettier on `scripts/*.mjs`.
- **Commits:** one per task on its lane branch (see "Orchestrated run" above); the single commit on `main` is made by the owner after approval.

## Review Focus

1. **A legacy note with no author** (every note written before Task 1) renders as `day` only: no "agent"/"you" label and no "open agent session ↗". Test in Task 9 (`sidebarNotes`).
2. **A run report with no sections, or no report at all.** A finished run with `run.report === ""` falls back to the evidence block. A report with only a `#` title and a lead line renders the lead with no section headings. Test in Task 11 (`parseRunReport`).
3. **Unmatched Retry and Approve rows.** A `dag-blocked` item for a merge conflict (`retry: false`) shows **Open**, never Retry: a retry there would re-run a task whose merge git refused. A `dag-gate` item with no task id (the group-level fallback, `attention.go:462`) shows Open, not Approve. Tests in Task 3 (Go) and Task 6 (`queueAction`).
4. **Stage fraction with skips.** An all-skipped stage renders `0/0` with an empty bar, never `NaN%` or a wrapped "all skipped". Test in Task 4 (`groupChunksByStage`).
5. **Initiative collapse default on a long plan.** The design collapses fully-done stages (more than one chunk) and opens the rest. A 33-chunk plan with nothing done therefore opens every stage. That is the design's rule, and it replaces the "only the next stage" rule (`inlinetracker.ts:53`). Test in Task 4 (`stageStartsOpen`).

## File Structure

- `pkg/waveobj/wtype.go`: `EffortNote` gains `Author`, `Session`, `Run`.
- `pkg/wshrpc/wshrpctypes_effort.go`: `CommandEffortMutateData` gains `Author`, `SourceBlock`.
- `pkg/wshrpc/wshrpctypes_channels.go`: `AttentionItem` gains `TaskId`, `Retry`.
- `pkg/wshrpc/wshrpctypes_jarvis.go`: `ShippedItem` gains `HasReport`, `EffortOID`, `ChunkLabel`.
- `pkg/jarvis/effortops.go`: `NoteAuthor`, `ApplyEffortOpsAs`; `chunkNote` stamps the author.
- `pkg/jarvis/attention.go`: task ids on dag items.
- `pkg/jarvisstate/effortlink.go`: `NoteRunFinished`, `RunFinishedText`.
- `pkg/jarvisstate/jarvisstate.go`: `Shipped` fills the new fields.
- `pkg/wshrpc/wshserver/wshserver_effort.go`: `noteAuthorFor`.
- `pkg/wshrpc/wshserver/wshserver_runs.go`: seal calls `NoteRunFinished`.
- `cmd/wsh/cmd/wshcmd-effort.go`: `mutateOne` sends `SourceBlock`.
- `frontend/app/view/jarvis/briefstyle.ts` (new): the shared class strings the four region files use.
- `frontend/app/view/jarvis/briefrowviews.tsx` (new): one row component per region anatomy — `WaitingRow`, `InitiativeRow`, `RunRow`, `DeltaRow`, `ShippedRowView`. Takes rows out of `briefsurface.tsx`, which is at 1800 lines.
- `frontend/app/view/jarvis/briefrows.ts`: `BriefLine` gains the per-region fields the rows need; adds `queueAction`, `projectName`, `sinceLabel`.
- `frontend/app/view/jarvis/briefingmodel.ts`: queue summary copy; blockers join the queue; `RunRow` keeps its oid.
- `frontend/app/view/jarvis/briefsurface.tsx`: header, region wiring, run-list atom.
- `frontend/app/view/jarvis/effortmodel.ts`, `inlinetracker.ts`, `inlinetrackerview.tsx`: fraction, collapse rule, summary line, footer, card chrome.
- `frontend/app/view/jarvis/chunksidebar.tsx` + `sidebarnotes.ts` (new, pure): the note-card model, including run notes.
- `frontend/app/view/jarvis/runreport.ts` (new, pure) + `runreportview.tsx` (new): the parsed report, used by the run sheet and the Chunk sidebar.
- `frontend/app/view/jarvis/runsheet.tsx`, `briefrunsheet.tsx`, `briefsheet.tsx`: header position and ↑/↓, meta with an inline adjust, the ↳ chunk link, the report, the composer in the footer.
- `frontend/app/view/jarvis/effortcreateform.tsx`, `newruncontrol.tsx`, `briefprofileview.tsx`, `autonomyladderview.tsx`: modal and header-chip restyles.
- `frontend/app/view/jarvis/briefingstore.ts`: `markBriefingSeen`.
- `scripts/cdp/scenarios.mjs`: the `brief-design-parity` scenario.
- `docs/keyboard-shortcuts.md`: j/k on the run sheet.

---

## Phase 1 — Backend: the data the design shows

### Task 1: Note authorship
**Depends on:** none

The design labels every note "agent" or "you" (design L370, L1522) and gives an agent note "open agent session ↗" (design L391-395). Today `EffortNote` records neither, and the UI and the CLI send identical ops.

**Files:**
- Modify: `pkg/waveobj/wtype.go` (`EffortNote`, ~L560)
- Modify: `pkg/wshrpc/wshrpctypes_effort.go` (`CommandEffortMutateData`, L41)
- Modify: `pkg/jarvis/effortops.go` (`chunkNote` L62, `ApplyEffortOps` L137, and every `chunkNote(` call in the apply pass: L304, 311, 319, 327, 361, 365, 377, 392, 410, 415, 440, 446)
- Modify: `pkg/wshrpc/wshserver/wshserver_effort.go` (`EffortMutateCommand`, L71)
- Modify: `cmd/wsh/cmd/wshcmd-effort.go` (`mutateOne`, L377)
- Modify: `frontend/app/view/jarvis/effortstore.ts` (`mutateEffort`)
- Test: `pkg/jarvis/effortops_test.go`

**Interfaces:**
- Produces:
  - `EffortNote.Author` (`"you" | "agent" | ""`), `EffortNote.Session` (`"agent:<tabid>"`), `EffortNote.Run` (`"run:<oid>"`).
  - `jarvis.NoteAuthor{Who, Session, Run string}`.
  - `jarvis.ApplyEffortOpsAs(e, ops, cmdNote, now, by NoteAuthor) error`.
  - TS `EffortNote.author?`, `.session?`, `.run?` (via `task generate`).

- [ ] **Step 1: Write the failing test** (append to `pkg/jarvis/effortops_test.go`)

```go
func TestApplyOpsAsStampsTheNoteAuthor(t *testing.T) {
	e := mkEffort()
	by := NoteAuthor{Who: "agent", Session: "agent:tab1", Run: "run:r1"}
	err := ApplyEffortOpsAs(e, []wshrpc.EffortOp{{Op: "appendNote", Chunk: "Phase 2", Note: "halfway"}}, "", effortNow, by)
	if err != nil {
		t.Fatal(err)
	}
	notes := e.Chunks[1].Notes
	n := notes[len(notes)-1]
	if n.Text != "halfway" || n.Author != "agent" || n.Session != "agent:tab1" || n.Run != "run:r1" {
		t.Fatalf("note = %+v, want the agent stamp", n)
	}
}

func TestApplyOpsLeavesTheAuthorEmpty(t *testing.T) {
	e := mkEffort()
	if err := ApplyEffortOps(e, []wshrpc.EffortOp{{Op: "appendNote", Chunk: "Phase 2", Note: "x"}}, "", effortNow); err != nil {
		t.Fatal(err)
	}
	n := e.Chunks[1].Notes[len(e.Chunks[1].Notes)-1]
	if n.Author != "" || n.Session != "" || n.Run != "" {
		t.Fatalf("note = %+v, want no author", n)
	}
}
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `go test ./pkg/jarvis/ -run 'TestApplyOpsAs|TestApplyOpsLeaves' -v`
Expected: build failure — `undefined: NoteAuthor` / `unknown field Author`.

- [ ] **Step 3: Implement**

`pkg/waveobj/wtype.go`, replace `EffortNote`:

```go
type EffortNote struct {
	Ts     int64  `json:"ts"`
	Text   string `json:"text"`
	Edited bool   `json:"edited,omitempty"`
	// Author is who wrote the note: "you" from the cockpit, "agent" from `wsh effort` in a terminal.
	// Empty on notes written before authorship was recorded; those render without one.
	Author string `json:"author,omitempty"`
	// Session and Run are the agent session ("agent:<tabid>") and the run ("run:<oid>") an agent note
	// came from, when they resolve. They back "open agent session ↗" and the run report on the card.
	Session string `json:"session,omitempty"`
	Run     string `json:"run,omitempty"`
}
```

`pkg/wshrpc/wshrpctypes_effort.go`, add to `CommandEffortMutateData` after `Note`:

```go
	// Author stamps the notes this batch writes; only "you" is accepted from a caller (the cockpit). A
	// terminal sends SourceBlock instead and the server derives "agent", its session and its run.
	Author      string `json:"author,omitempty"`
	SourceBlock string `json:"sourceblock,omitempty"` // "block:<id>" of the calling terminal
```

`pkg/jarvis/effortops.go`: replace `chunkNote`, and split the entry point:

```go
// NoteAuthor is who the notes a batch appends are attributed to. The zero value writes no author.
type NoteAuthor struct {
	Who     string // "you" | "agent" | ""
	Session string // "agent:<tabid>"
	Run     string // "run:<oid>"
}

func chunkNote(e *waveobj.Effort, idx int, text string, now int64, by NoteAuthor) {
	e.Chunks[idx].Notes = append(e.Chunks[idx].Notes, waveobj.EffortNote{
		Ts: now, Text: text, Author: by.Who, Session: by.Session, Run: by.Run,
	})
	e.Chunks[idx].UpdatedTs = now
}

// ApplyEffortOps applies a batch with no note author: internal callers (attach/detach) and tests.
func ApplyEffortOps(e *waveobj.Effort, ops []wshrpc.EffortOp, cmdNote string, now int64) error {
	return ApplyEffortOpsAs(e, ops, cmdNote, now, NoteAuthor{})
}
```

Rename the existing `func ApplyEffortOps(e *waveobj.Effort, ops []wshrpc.EffortOp, cmdNote string, now int64) error {` (L137) to `func ApplyEffortOpsAs(e *waveobj.Effort, ops []wshrpc.EffortOp, cmdNote string, now int64, by NoteAuthor) error {`. Then change every `chunkNote(e, <idx>, <text>, now)` in its body to `chunkNote(e, <idx>, <text>, now, by)`: all twelve call sites listed under Files. Confirm with `grep -n "chunkNote(" pkg/jarvis/effortops.go`; every call except the definition must end in `, by)`.

`pkg/wshrpc/wshserver/wshserver_effort.go`: in `EffortMutateCommand`, replace the `jarvis.ApplyEffortOps(e, data.Ops, data.Note, time.Now().UnixMilli())` call with `jarvis.ApplyEffortOpsAs(e, data.Ops, data.Note, time.Now().UnixMilli(), author)`, and before `var updated` add `author := noteAuthorFor(ctx, data)`. Append to the file:

```go
// noteAuthorFor attributes a batch's notes. A source block means `wsh effort` ran in a terminal, which
// in this app is an agent: its tab is the session, and the run owning that tab, if any, is the run. A
// caller-supplied Author is honoured only as "you" — anything else would let a terminal claim the human.
func noteAuthorFor(ctx context.Context, data wshrpc.CommandEffortMutateData) jarvis.NoteAuthor {
	if data.SourceBlock == "" {
		if data.Author == "you" {
			return jarvis.NoteAuthor{Who: "you"}
		}
		return jarvis.NoteAuthor{}
	}
	by := jarvis.NoteAuthor{Who: "agent"}
	if oref, err := waveobj.ParseORef(data.SourceBlock); err == nil && oref.OType == waveobj.OType_Block {
		if block, err := wstore.DBMustGet[*waveobj.Block](ctx, oref.OID); err == nil {
			if tab, err := waveobj.ParseORef(block.ParentORef); err == nil && tab.OType == waveobj.OType_Tab {
				by.Session = "agent:" + tab.OID
			}
		}
	}
	if run, _, ok := ownerRunForBlock(ctx, data.SourceBlock); ok {
		by.Run = "run:" + run.ID
	}
	return by
}
```

`cmd/wsh/cmd/wshcmd-effort.go`: `mutateOne` builds the data with the source block:

```go
func mutateOne(effortOID string, op wshrpc.EffortOp, asJSON bool) error {
	data := wshrpc.CommandEffortMutateData{EffortOID: effortOID, Ops: []wshrpc.EffortOp{op}}
	if RpcContext.BlockId != "" {
		data.SourceBlock = "block:" + RpcContext.BlockId
	}
	rtn, err := wshclient.EffortMutateCommand(RpcClient, data, nil)
```

The rest of the function is unchanged. Find any other CLI mutate call with `grep -n "EffortMutateCommand(RpcClient" cmd/wsh/cmd/*.go`, and set `SourceBlock` the same way in each one.

`frontend/app/view/jarvis/effortstore.ts`: in `mutateEffort`, change the payload to `{ effortoid: effortOid(oref), ops, author: "you" }`.

- [ ] **Step 4: Regenerate the bindings and run the tests**

Run: `task generate && go test ./pkg/jarvis/ ./pkg/jarvisstate/ ./pkg/wshrpc/... && go vet ./pkg/jarvis/ ./pkg/wshrpc/... ./cmd/wsh/...`
Expected: PASS. `git diff frontend/types/gotypes.d.ts` shows `author?`, `session?`, `run?`, `sourceblock?`.

- [ ] **Step 5: Checkpoint** — `git status` shows only the files above plus the generated ones.

### Task 2: A sealed run leaves its report on its chunk
**Depends on:** Task 1

The user asked that "the report [be integrated] to the sidebar after the run completed". A run linked to a chunk (`Run.EffortRef`) gets an agent note on that chunk when it seals. The note carries `Run`, and the Chunk sidebar (Task 9) renders that run's report under the note.

**Files:**
- Modify: `pkg/jarvisstate/effortlink.go`
- Modify: `pkg/wshrpc/wshserver/wshserver_runs.go` (the seal block at ~L852: `if run.EffortRef != nil {`)
- Test: `pkg/jarvisstate/effortlink_test.go`

**Interfaces:**
- Consumes: `jarvis.ApplyEffortOpsAs`, `jarvis.NoteAuthor` (Task 1).
- Produces:
  - `jarvisstate.RunFinishedText(run *waveobj.Run) string`
  - `jarvisstate.NoteRunFinished(ctx, ref waveobj.RunEffortRef, runORef, text string) error`
  - `jarvisstate.RunFinishedPrefix = "Run finished"`

- [ ] **Step 1: Write the failing test** (append to `pkg/jarvisstate/effortlink_test.go`)

```go
func TestRunFinishedTextPrefersTheReportTitle(t *testing.T) {
	r := &waveobj.Run{Goal: "Retire the recall arm", Report: "# Retire the recall arm — run report\n\nDAG x: 6/6 tasks done."}
	if got := RunFinishedText(r); got != "Run finished: Retire the recall arm — run report" {
		t.Fatalf("got %q", got)
	}
	r = &waveobj.Run{Goal: "Rule diff vs prod", Evidence: &waveobj.RunEvidence{Summary: "Found 4 drifts.\nTwo expected."}}
	if got := RunFinishedText(r); got != "Run finished: Found 4 drifts." {
		t.Fatalf("got %q", got)
	}
	r = &waveobj.Run{Goal: "Only a goal"}
	if got := RunFinishedText(r); got != "Run finished: Only a goal" {
		t.Fatalf("got %q", got)
	}
}
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `go test ./pkg/jarvisstate/ -run TestRunFinishedText -v`
Expected: FAIL — `undefined: RunFinishedText`.

- [ ] **Step 3: Implement**. Append to `pkg/jarvisstate/effortlink.go` (add `"strings"` to the imports):

```go
// RunFinishedPrefix opens the note a sealed run leaves on its chunk; NoteRunFinished keys idempotence on it.
const RunFinishedPrefix = "Run finished"

// RunFinishedText is the one line a sealed run's chunk note reads as: the report's title, else the first
// line of the sealed summary, else the goal. The full report renders under the note (Chunk sidebar).
func RunFinishedText(r *waveobj.Run) string {
	first := func(s string) string {
		for _, l := range strings.Split(s, "\n") {
			if t := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(l), "# ")); t != "" {
				return t
			}
		}
		return ""
	}
	line := first(r.Report)
	if line == "" && r.Evidence != nil {
		line = first(r.Evidence.Summary)
	}
	if line == "" {
		line = r.Goal
	}
	return RunFinishedPrefix + ": " + line
}

// NoteRunFinished drops an agent note carrying the run's oref on the chunk the run executed. Idempotent
// per run, because the seal backfill can run more than once.
func NoteRunFinished(ctx context.Context, ref waveobj.RunEffortRef, runORef, text string) error {
	if _, err := wstore.GetEffort(ctx, ref.EffortOID); err != nil {
		return err
	}
	return wstore.UpdateEffort(ctx, ref.EffortOID, func(e *waveobj.Effort) error {
		idx, err := jarvis.ResolveChunkIndex(e, ref.ChunkLabel)
		if err != nil {
			return err
		}
		for _, n := range e.Chunks[idx].Notes {
			if n.Run == runORef && strings.HasPrefix(n.Text, RunFinishedPrefix) {
				return nil
			}
		}
		return jarvis.ApplyEffortOpsAs(e, []wshrpc.EffortOp{{Op: "appendNote", Chunk: ref.ChunkLabel, Note: text}},
			"", time.Now().UnixMilli(), jarvis.NoteAuthor{Who: "agent", Run: runORef})
	})
}
```

In `wshserver_runs.go`, inside `if run.EffortRef != nil {`, right after the `DetachRunFromChunk` error block, add:

```go
		sealed := *run
		sealed.Evidence = ev
		if nerr := jarvisstate.NoteRunFinished(ctx, *run.EffortRef, "run:"+run.ID, jarvisstate.RunFinishedText(&sealed)); nerr != nil {
			log.Printf("SealRunEvidence: noting the finished run on its chunk failed (non-fatal): %v", nerr)
		}
```

`ev` is the evidence sealed in the update just above (`r.Evidence = ev`). If it is declared inside the update closure, hoist the declaration to the enclosing function so it is in scope here.

- [ ] **Step 4: Run the tests**

Run: `go test ./pkg/jarvisstate/ ./pkg/wshrpc/wshserver/ && go vet ./pkg/jarvisstate/ ./pkg/wshrpc/wshserver/`
Expected: PASS.

- [ ] **Step 5: Checkpoint.**

### Task 3: Queue items carry what Approve and Retry need; shipped items carry their report and chunk
**Depends on:** none

The design's Waiting rows act in place (design L99: Approve / Open / Retry), and a Shipped row flags a report (design L326).

**Files:**
- Modify: `pkg/wshrpc/wshrpctypes_channels.go` (`AttentionItem`, L91)
- Modify: `pkg/wshrpc/wshrpctypes_jarvis.go` (`ShippedItem`, L349)
- Modify: `pkg/jarvis/attention.go` (`dagGateItems` ~L443, the `case "blocked":` block ~L346)
- Modify: `pkg/jarvisstate/jarvisstate.go` (`Shipped`, L109)
- Test: `pkg/jarvis/attention_test.go`, `pkg/jarvisstate/jarvisstate_test.go`

**Interfaces:**
- Produces:
  - `AttentionItem.TaskId string`, `AttentionItem.Retry bool`
  - `ShippedItem.HasReport bool`, `ShippedItem.EffortOID string`, `ShippedItem.ChunkLabel string`
  - In TS: `taskid?`, `retry?`, `hasreport?`, `effortoid?`, `chunklabel?`

- [ ] **Step 1: Write the failing tests**

Append to `pkg/jarvis/attention_test.go`:

```go
func TestDagItemsNameTheirTask(t *testing.T) {
	gate := BuildAttention(AttentionInput{Dags: []*waveobj.TaskGroup{{
		ID: "d1", RunID: "r1", ChannelId: "c1", Status: "awaiting-review", UpdatedTs: 5,
		Tasks: []waveobj.TaskNode{{ID: "t-3", State: "done", Gate: true, LastActivity: 5}},
	}}})
	if len(gate) != 1 || gate[0].TaskId != "t-3" {
		t.Fatalf("dag gate = %+v, want TaskId t-3", gate)
	}
	failed := BuildAttention(AttentionInput{Dags: []*waveobj.TaskGroup{{
		ID: "d2", RunID: "r2", ChannelId: "c1", Status: "blocked", Failures: 2, UpdatedTs: 5,
		Tasks: []waveobj.TaskNode{{ID: "t-1", State: "done"}, {ID: "t-4", State: "failed"}},
	}}})
	if failed[0].TaskId != "t-4" || !failed[0].Retry {
		t.Fatalf("circuit break = %+v, want TaskId t-4 and Retry", failed[0])
	}
	merge := BuildAttention(AttentionInput{Dags: []*waveobj.TaskGroup{{
		ID: "d3", RunID: "r3", ChannelId: "c1", Status: "blocked", UpdatedTs: 5,
		Tasks: []waveobj.TaskNode{{ID: "t-2", State: "blocked-merge"}},
	}}})
	if merge[0].TaskId != "t-2" || merge[0].Retry {
		t.Fatalf("merge block = %+v, want TaskId t-2 and no Retry", merge[0])
	}
}
```

Append to `pkg/jarvisstate/jarvisstate_test.go` (add the `wshrpc` import if it is missing):

```go
func TestShippedCarriesReportAndChunk(t *testing.T) {
	r := trun("r1", "done", 100, 500, ev("sum"))
	r.Report = "# t\n\nlead"
	r.EffortRef = &waveobj.RunEffortRef{EffortOID: "e1", ChunkLabel: "N1 box upgrade"}
	items := Shipped([]*waveobj.Run{r, trun("r2", "done", 100, 600, ev("b"))}, 0)
	byID := map[string]wshrpc.ShippedItem{}
	for _, it := range items {
		byID[it.RunOID] = it
	}
	if !byID["r1"].HasReport || byID["r1"].EffortOID != "e1" || byID["r1"].ChunkLabel != "N1 box upgrade" {
		t.Fatalf("r1 = %+v", byID["r1"])
	}
	if byID["r2"].HasReport || byID["r2"].EffortOID != "" {
		t.Fatalf("r2 = %+v", byID["r2"])
	}
}
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `go test ./pkg/jarvis/ -run TestDagItemsNameTheirTask -v; go test ./pkg/jarvisstate/ -run TestShippedCarries -v`
Expected: build failure — unknown fields.

- [ ] **Step 3: Implement**

`AttentionItem`, after `PhaseIdx`:

```go
	// TaskId is the task a dag-gate approves or a dag-blocked item names; Retry says retrying it is the
	// right action (a circuit break), not a merge the human resolves by hand.
	TaskId string `json:"taskid,omitempty"`
	Retry  bool   `json:"retry,omitempty"`
```

`ShippedItem`, after `CompletedTs`:

```go
	HasReport  bool   `json:"hasreport,omitempty"` // the lead filed a run report (Run.Report)
	EffortOID  string `json:"effortoid,omitempty"` // the chunk the run executed, when attributed
	ChunkLabel string `json:"chunklabel,omitempty"`
```

`attention.go`: in the per-task `dagGateItems` literal (`Key: "dag-gate:" + g.ID + ":" + t.ID`), add `TaskId: t.ID,`. Add this helper beside `dagBlockedReason`:

```go
// blockedTask is the task a blocked group is stopped on, and whether retrying it is the action: a merge
// git refused or a failed Verify is resolved by hand, so only a failed task is retryable.
func blockedTask(g *waveobj.TaskGroup) (string, bool) {
	for _, t := range g.Tasks {
		if t.State == "blocked-merge" || t.State == "verify-failed" {
			return t.ID, false
		}
	}
	for _, t := range g.Tasks {
		if t.State == "failed" {
			return t.ID, true
		}
	}
	return "", false
}
```

In the `case "blocked":` block, before `gates = append(`, add `taskID, retry := blockedTask(g)`, and add `TaskId: taskID, Retry: retry,` to the literal.

`jarvisstate.go`, `Shipped`: replace the append with

```go
		item := wshrpc.ShippedItem{
			Project: r.ProjectPath, RunOID: r.OID, Goal: r.Goal, Summary: r.Evidence.Summary,
			Files: r.Evidence.Files, Verifs: r.Evidence.Verifs, CompletedTs: r.CompletedTs,
			HasReport: strings.TrimSpace(r.Report) != "",
		}
		if r.EffortRef != nil {
			item.EffortOID, item.ChunkLabel = r.EffortRef.EffortOID, r.EffortRef.ChunkLabel
		}
		out = append(out, item)
```

(add `"strings"` to the imports if it is missing).

- [ ] **Step 4: Regenerate and run the tests**

Run: `task generate && go test ./pkg/jarvis/ ./pkg/jarvisstate/ && go vet ./pkg/jarvis/ ./pkg/jarvisstate/`
Expected: PASS.

- [ ] **Step 5: Checkpoint.** Commit. (The dev backend is rebuilt by the owner after the run, not in the lane.)

---

## Phase 2 — Frontend models (pure, unit-tested)

### Task 4: Tracker model — fractions, the design's collapse rule, the facts row, efforts' stage index
**Depends on:** none

**Files:**
- Modify: `frontend/app/view/jarvis/effortmodel.ts` (`stageFraction` L84, `StageGroup` L80, `groupChunksByStage` L92, `EffortCardModel`/`buildEffortCard`)
- Modify: `frontend/app/view/jarvis/inlinetracker.ts` (`TrackerRow` facts/stage variants, `stageStartsOpen` L53, `trackerRows` L64)
- Modify: `frontend/app/view/jarvis/briefsurface.tsx` (the `trackerRows({...})` call: drop `countLine`)
- Create: `frontend/app/view/jarvis/briefstyle.ts`
- Test: `frontend/app/view/jarvis/effortmodel.test.ts`, `frontend/app/view/jarvis/inlinetracker.test.ts`

**Interfaces:**
- Produces:
  - `StageGroup<T> = { stage; rows; fraction: string; done: number; total: number }`, where `fraction` is `"${done}/${total}"` and `total` excludes skipped chunks.
  - `stageStartsOpen(group: { rows: ChunkRowModel[] }): boolean`
  - `TrackerRow` facts variant `{ kind: "facts"; id; oref; count: string; done: number; total: number; blocked: number; next: string }`
  - `TrackerRow` stage variant gains `done: number; total: number; first: boolean`
  - `EffortCardModel.chunkStages: Record<string, string>` and `EffortCardModel.shortId: string` (the first 8 characters of the oid)
  - `briefstyle.ts` exports `REGION_LABEL`, `MONO_META`, `ROW_BORDER`, `LINK_BTN`, `SMALL_BTN`, `TONE_TEXT`

- [ ] **Step 1: Write the failing tests**

Append to `effortmodel.test.ts`:

```ts
describe("groupChunksByStage fractions", () => {
    const row = (stage: string, status: string) => ({ stage, status, label: stage + status + Math.random() });
    it("prints done/total with a slash, skips out of the denominator", () => {
        const [g] = groupChunksByStage([row("A", "done"), row("A", "pending"), row("A", "skipped")]);
        expect(g.fraction).toBe("1/2");
        expect([g.done, g.total]).toEqual([1, 2]);
    });
    it("an all-skipped stage is 0/0, never a word that wraps", () => {
        const [g] = groupChunksByStage([row("A", "skipped")]);
        expect(g.fraction).toBe("0/0");
    });
});
```

Append to `inlinetracker.test.ts` (reuse the file's existing chunk fixture helper if it has one; otherwise add this one):

```ts
const chunk = (label: string, stage: string, status: string) =>
    ({ label, stage, status, tone: status, trail: [], workrefs: [] }) as ChunkRowModel;

describe("stageStartsOpen (design: fully-done stages of 2+ chunks fold)", () => {
    it("folds a finished stage", () => {
        expect(stageStartsOpen({ rows: [chunk("a", "S", "done"), chunk("b", "S", "done")] })).toBe(false);
    });
    it("keeps a one-chunk finished stage open", () => {
        expect(stageStartsOpen({ rows: [chunk("a", "S", "done")] })).toBe(true);
    });
    it("opens every unfinished stage", () => {
        expect(stageStartsOpen({ rows: [chunk("a", "S", "done"), chunk("b", "S", "pending")] })).toBe(true);
    });
});

describe("trackerRows facts row", () => {
    it("carries the design's count and summary inputs", () => {
        const line = { id: "initiatives:effort:e1", target: { oref: "effort:e1" } } as BriefLine;
        const rows = trackerRows({
            lines: [line],
            openLineId: line.id,
            chunks: [chunk("a", "P1", "done"), chunk("b", "P2", "blocked"), chunk("c", "P2", "pending")],
            noteCounts: new Map(),
            stageOverrides: {},
        });
        const facts = rows.find((r) => r.kind === "facts");
        expect(facts).toMatchObject({ count: "3 chunks · 1 done", done: 1, total: 3, blocked: 1, next: "c" });
        const stages = rows.filter((r) => r.kind === "stage");
        expect(stages.map((s) => (s as { first: boolean }).first)).toEqual([true, false]);
    });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run frontend/app/view/jarvis/effortmodel.test.ts frontend/app/view/jarvis/inlinetracker.test.ts`
Expected: FAIL — `"1 of 2"` does not equal `"1/2"`, `stageStartsOpen` has the wrong arity, and the `countLine` argument no longer type-checks.

- [ ] **Step 3: Implement**

`effortmodel.ts`:

```ts
export type StageGroup<T> = { stage: string; rows: T[]; fraction: string; done: number; total: number };

function stageCounts(rows: { status: string }[]): { done: number; total: number } {
    const skipped = rows.filter((r) => r.status === "skipped").length;
    return { done: rows.filter((r) => r.status === "done").length, total: rows.length - skipped };
}
```

In `groupChunksByStage`, replace the final `return groups.map((g) => ({ ...g, fraction: stageFraction(g.rows) }));` with

```ts
    return groups.map((g) => {
        const { done, total } = stageCounts(g.rows);
        return { ...g, done, total, fraction: `${done}/${total}` };
    });
```

and change the `groups.push({ stage: row.stage, rows: [row], fraction: "" })` literal to `groups.push({ stage: row.stage, rows: [row], fraction: "", done: 0, total: 0 })`. Delete `stageFraction`.

In `EffortCardModel` add `shortId: string; chunkStages: Record<string, string>;`. In `buildEffortCard`'s returned object add:

```ts
        shortId: e.oref.replace(/^effort:/, "").slice(0, 8),
        chunkStages: Object.fromEntries(chunks.map((c) => [c.label, c.stage ?? ""])),
```

`inlinetracker.ts`: change the facts and stage variants of `TrackerRow`:

```ts
    | { kind: "facts"; id: string; oref: string; count: string; done: number; total: number; blocked: number; next: string }
    | {
          kind: "stage";
          id: string;
          oref: string;
          stage: string;
          fraction: string;
          done: number;
          total: number;
          collapsed: boolean;
          at: number;
          first: boolean;
      }
```

Replace `stageStartsOpen`:

```ts
/**
 * Which stages start open when an initiative is first expanded — the design's rule (design L1357): a
 * stage of two or more chunks that is entirely done starts folded; every other stage starts open. An
 * explicit toggle always wins over this default.
 */
export function stageStartsOpen(group: { rows: ChunkRowModel[] }): boolean {
    const done = group.rows.filter((r) => r.status === "done").length;
    return !(group.rows.length > 1 && done === group.rows.length);
}
```

In `trackerRows`:
- drop `countLine` from the args type and from the destructure;
- replace the facts push with the block below;
- in the stage push, add `done: group.done, total: group.total, first: at === 0,` and change `stageStartsOpen(chunks, group)` to `stageStartsOpen(group)`.

```ts
        const doneN = chunks.filter((c) => c.status === "done").length;
        out.push({
            kind: "facts",
            id: line.id + "/facts",
            oref,
            count: `${chunks.length} chunk${chunks.length === 1 ? "" : "s"} · ${doneN} done`,
            done: doneN,
            total: chunks.length,
            blocked: chunks.filter((c) => c.status === "blocked").length,
            next: (chunks.find((c) => c.status === "active") ?? chunks.find((c) => c.status === "pending"))?.label ?? "",
        });
```

In `briefsurface.tsx`, remove `countLine: openCard?.countLine ?? "",` from the `trackerRows({...})` call.

Create `briefstyle.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The class strings every Brief region repeats, lifted from the design verbatim
// (docs/prototype/jarvis-brief-editing.dc.html) so the regions cannot drift apart again.

export const REGION_LABEL = "flex-none font-mono text-[10.5px] font-bold uppercase tracking-[.1em]";
export const MONO_META = "font-mono text-[10.5px] text-ink-mid";
export const MONO_FAINT = "font-mono text-[10.5px] text-muted";
// a Brief row: rounded, a faint bottom rule, the hover fill
export const ROW_BORDER = "rounded-[9px] border-b border-edge-faint px-[11px]";
// the bordered mono control: "Show 2 archived", "+14 runs older than 7 days"
export const LINK_BTN =
    "cursor-pointer self-start rounded-[6px] border border-border px-2.5 py-1 font-mono text-[10.5px] font-medium text-accent-soft hover:text-ink-hi focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";
// the row action buttons: Open / Stop
export const SMALL_BTN =
    "cursor-pointer rounded-[6px] border border-border bg-surface-raised px-2 py-[3px] text-[10.5px] font-semibold text-secondary hover:border-edge-strong hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";

export type Tone = "ok" | "active" | "asking" | "error" | "muted" | "faint";
export const TONE_TEXT: Record<Tone, string> = {
    ok: "text-success",
    active: "text-accent-soft",
    asking: "text-asking",
    error: "text-error",
    muted: "text-ink-mid",
    faint: "text-muted",
};
```

Existing tests that assert `"x of y"` stage fractions, or call `stageStartsOpen(rows, group)`, need their expectations updated to the new contract. Find them with `grep -rn "of [0-9]\"\|stageStartsOpen(" frontend/app/view/jarvis/*.test.ts`.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run frontend/app/view/jarvis/`
Expected: PASS.

- [ ] **Step 5: Checkpoint.**

### Task 5: Row models — queue actions, run and shipped fields, labels
**Depends on:** Task 3

**Files:**
- Modify: `frontend/app/view/jarvis/briefingmodel.ts` (`QueueRow`, `QueueNav`, `queueOpenTarget`, `buildAttentionQueue`, `summarizeAttentionQueue`, `RunRow`, `ShippedRow`, `projectBriefing`, `SHIPPED_CAP`)
- Modify: `frontend/app/view/jarvis/briefrows.ts` (`BriefLine`, `queueLine`, `sessionLine`, `sessionWindow`, `deltaLine`, `digestLine`, `behindGroups`)
- Test: `frontend/app/view/jarvis/briefingmodel.test.ts`, `frontend/app/view/jarvis/briefrows.test.ts`

**Interfaces:**
- Produces:
  - `QueueRow` gains `wireKind: string; channelId: string; runId: string | null; phaseIdx: number; taskId: string; retry: boolean`.
  - `QueueNav` gains `{ kind: "record"; oref: string }`.
  - `buildAttentionQueue({ attention, efforts, blockers })`.
  - `summarizeAttentionQueue(rows)` → `{ title: "3 things are waiting on you"; detail: "gate · ask · failed · oldest 2h"; oldestTs }`. It takes `now` as a second parameter.
  - `queueKindLabel(row): "gate" | "ask" | "failed" | "blocked" | "triage"`
  - `type QueueAct = { label: "Approve" | "Retry" | "Open"; kind: "approve-gate" | "approve-dag" | "retry-dag" | "open" }` and `queueAction(row): QueueAct`
  - `RunRow` gains `oid: string`. `ShippedRow` gains `hasReport: boolean; effortOid: string; chunkLabel: string`.
  - `BriefLine` gains `why: string; age: string; runOid?: string; agentId?: string; detail: string; hasReport?: boolean; fresh?: boolean; group?: "delta" | "shipped"`.
  - `projectName(path, projects): string`
  - `sinceLabel(cursorTs, nowTs, firstVisit): string`
  - `SHIPPED_CAP = 3`

- [ ] **Step 1: Write the failing tests**

Append to `briefingmodel.test.ts`:

```ts
describe("design queue wording", () => {
    const q = (over: Partial<QueueRow>): QueueRow =>
        ({
            key: "k" + Math.random(),
            kind: "gate",
            wireKind: "gate",
            title: "t",
            source: "s",
            detail: "",
            ts: null,
            action: "Review",
            nav: null,
            tone: "asking",
            attrib: "",
            why: "",
            cites: [],
            channelId: "c1",
            runId: "r1",
            phaseIdx: 0,
            taskId: "",
            retry: false,
            ...over,
        }) as QueueRow;
    it("summarises as the design does", () => {
        const now = 10 * 3_600_000;
        const s = summarizeAttentionQueue(
            [q({ wireKind: "gate" }), q({ wireKind: "ask", ts: now - 2 * 3_600_000 }), q({ wireKind: "dag-blocked", retry: true })],
            now
        )!;
        expect(s.title).toBe("3 things are waiting on you");
        expect(s.detail).toBe("gate · ask · failed · oldest 2h");
    });
    it("one item is singular", () => {
        expect(summarizeAttentionQueue([q({})], 0)!.title).toBe("1 thing is waiting on you");
    });
    it("maps each wire kind to its in-place action", () => {
        expect(queueAction(q({ wireKind: "gate" }))).toEqual({ label: "Approve", kind: "approve-gate" });
        expect(queueAction(q({ wireKind: "dag-gate", taskId: "t-3" }))).toEqual({ label: "Approve", kind: "approve-dag" });
        expect(queueAction(q({ wireKind: "dag-gate", taskId: "" }))).toEqual({ label: "Open", kind: "open" });
        expect(queueAction(q({ wireKind: "dag-blocked", taskId: "t-4", retry: true }))).toEqual({ label: "Retry", kind: "retry-dag" });
        expect(queueAction(q({ wireKind: "dag-blocked", taskId: "t-2", retry: false }))).toEqual({ label: "Open", kind: "open" });
        expect(queueAction(q({ wireKind: "ask" }))).toEqual({ label: "Open", kind: "open" });
    });
    it("a record blocker joins the queue as blocked and opens its record", () => {
        const rows = buildAttentionQueue({
            attention: [],
            efforts: [],
            blockers: [{ oref: "task:d1", objective: "Clear the gate", blockers: "waits on SRE", project: "p", ts: 5 }],
        });
        expect(rows).toHaveLength(1);
        expect(queueKindLabel(rows[0])).toBe("blocked");
        expect(rows[0].nav).toEqual({ kind: "record", oref: "task:d1" });
        expect(queueOpenTarget(rows[0].nav)).toEqual({ kind: "oref", oref: "task:d1" });
    });
});
```

Append to `briefrows.test.ts`:

```ts
describe("design row helpers", () => {
    it("names a project by its registry key, else the path's last segment", () => {
        expect(projectName("C:/x/waveterm", { waveterm: { path: "C:/x/waveterm" } } as never)).toBe("waveterm");
        expect(projectName("C:\\x\\orch-demo", {} as never)).toBe("orch-demo");
        expect(projectName("", {} as never)).toBe("");
    });
    it("says since when the delta runs", () => {
        const now = new Date(2026, 8, 23, 10, 0).getTime();
        expect(sinceLabel(new Date(2026, 8, 22, 18, 40).getTime(), now, false)).toBe("since yesterday 18:40");
        expect(sinceLabel(new Date(2026, 8, 23, 9, 5).getTime(), now, false)).toBe("since today 09:05");
        expect(sinceLabel(new Date(2026, 8, 12, 9, 5).getTime(), now, false)).toBe("since Sep 12");
        expect(sinceLabel(0, now, true)).toBe("the last 7 days");
    });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run frontend/app/view/jarvis/briefingmodel.test.ts frontend/app/view/jarvis/briefrows.test.ts`
Expected: FAIL — `queueAction` / `projectName` / `sinceLabel` are not exported.

- [ ] **Step 3: Implement**

`briefingmodel.ts`:
- `export const SHIPPED_CAP = 3;` (design L1072).
- `RunRow` gains `oid: string;`. In `projectBriefing`'s `activeRuns` map, add `oid: (a.navtarget ?? "").replace(/^run:/, ""),`.
- `ShippedRow` gains `hasReport: boolean; effortOid: string; chunkLabel: string;`. In the `shipped` map, add `hasReport: s.hasreport === true, effortOid: s.effortoid ?? "", chunkLabel: s.chunklabel ?? "",`.
- `QueueNav` gains `| { kind: "record"; oref: string }`. In `queueOpenTarget`, the `nav.kind !== "channel"` branch already returns `{ kind: "oref", oref: nav.oref }`, which covers it.
- `QueueRow` gains `wireKind`, `channelId`, `runId`, `phaseIdx`, `taskId`, `retry`, typed as in Interfaces.

In `buildAttentionQueue`:
- the input type becomes `{ attention: AttentionItem[]; efforts: EffortCardModel[]; blockers?: BlockerRow[] }`;
- the wire-row literal adds `wireKind: a.kind, channelId, runId: a.runid || null, phaseIdx: a.phaseidx ?? 0, taskId: a.taskid ?? "", retry: a.retry === true,`;
- the blocked-chunk literal adds `wireKind: "chunk-blocked", channelId: "", runId: null, phaseIdx: 0, taskId: "", retry: false,`.

After the efforts loop, add:

```ts
    // a record with blockers waits on you as much as a gate does (design L1010: everything that needs you
    // is in this one queue), so it leaves Runs and joins here, opening its record.
    for (const b of input.blockers ?? []) {
        rows.push({
            key: "blocker:" + b.oref,
            kind: "blocked",
            wireKind: "blocker",
            title: b.objective,
            source: b.project ?? "",
            detail: b.project ?? "",
            ts: b.ts,
            action: "Open",
            nav: b.oref !== "" ? { kind: "record", oref: b.oref } : null,
            tone: "asking",
            attrib: "",
            why: b.blockers,
            cites: [],
            channelId: "",
            runId: null,
            phaseIdx: 0,
            taskId: "",
            retry: false,
        });
    }
```

Add, and replace `summarizeAttentionQueue`:

```ts
// the design's four kind words (design L1010-1013); every wire kind reads as one of them
export function queueKindLabel(row: QueueRow): "gate" | "ask" | "failed" | "blocked" | "triage" {
    switch (row.wireKind) {
        case "gate":
        case "plan-gate":
        case "dag-gate":
            return "gate";
        case "ask":
        case "escalation":
            return "ask";
        case "dag-blocked":
            return row.retry ? "failed" : "blocked";
        case "radar-triage":
            return "triage";
        default:
            return "blocked";
    }
}

export type QueueAct = { label: "Approve" | "Retry" | "Open"; kind: "approve-gate" | "approve-dag" | "retry-dag" | "open" };

// What the row's button does in place (design L1598-1609). Approve and Retry need the exact task or phase
// the server named; without it the row opens its run rather than guessing one.
export function queueAction(row: QueueRow): QueueAct {
    if (row.wireKind === "gate" && row.channelId !== "" && row.runId != null) {
        return { label: "Approve", kind: "approve-gate" };
    }
    if (row.wireKind === "dag-gate" && row.taskId !== "" && row.runId != null) {
        return { label: "Approve", kind: "approve-dag" };
    }
    if (row.wireKind === "dag-blocked" && row.retry && row.taskId !== "" && row.runId != null) {
        return { label: "Retry", kind: "retry-dag" };
    }
    return { label: "Open", kind: "open" };
}

export function summarizeAttentionQueue(rows: QueueRow[], now: number): QueueSummary | null {
    if (rows.length === 0) {
        return null;
    }
    const oldestTs = rows.reduce<number | null>((o, r) => (r.ts == null ? o : o == null ? r.ts : Math.min(o, r.ts)), null);
    const n = rows.length;
    const kinds = rows.map(queueKindLabel).join(" · ");
    return {
        title: `${n} ${n === 1 ? "thing is" : "things are"} waiting on you`,
        detail: oldestTs != null ? `${kinds} · oldest ${formatAge(now - oldestTs)}` : kinds,
        oldestTs,
    };
}
```

Import `formatAge` from `@/app/view/agents/agentsviewmodel`. Delete `QUEUE_SUMMARY_SOURCE_CAP`. `QueueSummary` stays `{ title; detail; oldestTs }`.

`briefrows.ts`:
- Extend `BriefLine` with the fields listed in Interfaces. Every line builder sets the new required fields; use `why: ""`, `age: ""`, `detail: ""` where they don't apply.
- `queueLine`: `kind: queueKindLabel(q)`, `why: q.why`, `age: q.ts != null ? age(q.ts, now) : ""`, `meta: joined([q.attrib, q.detail])`, `state: ""`.
- `sessionLine`: `runOid: row.kind === "run" ? row.oref.replace(/^run:/, "") : undefined`, `agentId: row.kind === "agent" ? row.key.split(":")[1] : undefined`.
- `sessionWindow`'s `legs` drops `blockers`, and `mergeActiveWork` is called with `blockers: []`.
- `deltaLine`: `kind: row.wording.split(" · ")[0]`, `detail: row.kind === "dossier" && (row.detail ?? "").startsWith("status: ") ? "current status: " + row.detail!.slice(8) : (row.detail ?? "")`, `kindTone: DELTA_TONE[row.kind] ?? "muted"`, `group: "delta"`, with

```ts
const DELTA_TONE: Record<string, LineTone> = { "run-created": "active", "run-done": "ok", decision: "muted", dossier: "asking" };
```

- `digestLine`: `kind: "Initiative"`, `detail` = the old `meta` string, `meta: ""`, `group: "delta"`.
- Shipped lines in `behindGroups`: `detail: joined([s.project, headline(s.summary)])`, `hasReport: s.hasReport`, `fresh: s.fresh`, `group: "shipped"`, `meta: ""`.

Add:

```ts
// a project's registry name for its path; the path's last segment when the registry has no entry
export function projectName(path: string, projects: Record<string, { path?: string }> | null): string {
    if (path === "") {
        return "";
    }
    const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    const hit = Object.entries(projects ?? {}).find(([, v]) => v.path != null && norm(v.path) === norm(path));
    return hit != null ? hit[0] : (path.replace(/\\/g, "/").replace(/\/+$/, "").split("/").pop() ?? path);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

// Behind you's meta (design L1793). firstVisit: no stored cursor, so the window is the seven-day default.
export function sinceLabel(cursorTs: number, nowTs: number, firstVisit: boolean): string {
    if (firstVisit) {
        return "the last 7 days";
    }
    const d = new Date(cursorTs);
    const today = new Date(nowTs);
    today.setHours(0, 0, 0, 0);
    const day = new Date(cursorTs);
    day.setHours(0, 0, 0, 0);
    const diff = Math.round((today.getTime() - day.getTime()) / 86_400_000);
    if (diff === 0) {
        return `since today ${hhmm(d)}`;
    }
    if (diff === 1) {
        return `since yesterday ${hhmm(d)}`;
    }
    return `since ${MONTHS[d.getMonth()]} ${d.getDate()}`;
}
```

In `briefsurface.tsx`:
- `buildAttentionQueue({ attention, efforts: model_.efforts, blockers: model_.blockers })`;
- `summarizeAttentionQueue(queue, Date.now())`;
- `sessionWindow(model_, ...)` still takes the model; its param type no longer needs blockers.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run frontend/app/view/jarvis/`
Expected: PASS. Update the existing summary tests that asserted `"N items need your attention"` to the new wording, since the design replaces that copy.

- [ ] **Step 5: Checkpoint.**

### Task 6: Note cards and the run report — pure models
**Depends on:** Task 1

**Files:**
- Modify: `frontend/app/view/jarvis/effortfeed.ts` (`FeedEntry`, `effortFeed`)
- Create: `frontend/app/view/jarvis/sidebarnotes.ts`
- Create: `frontend/app/view/jarvis/runreport.ts`
- Test: `frontend/app/view/jarvis/sidebarnotes.test.ts`, `frontend/app/view/jarvis/runreport.test.ts`

**Interfaces:**
- Produces:
  - `FeedEntry` gains `author?: string; session?: string; run?: string`.
  - `sidebarNotes(feed: FeedEntry[], label: string, now: number, expanded: Set<string>): NoteCard[]`
  - `type NoteCard = { key: string; entry: FeedEntry; who: "agent" | "you" | ""; day: string; edited: boolean; text: string; open: boolean; chev: string; editable: boolean; runOid: string; sessionTab: string }`
  - `parseRunReport(md: string): RunReport | null`
  - `type RunReport = { title: string; lead: string; sections: ReportSection[] }`
  - `type ReportSection = { heading: string; count: string; items: ReportItem[] }`
  - `type ReportItem = { text: string; hash: string; tag: string; dot: "ok" | "warn" | "accent" | "faint" | "muted"; dim: boolean }`

- [ ] **Step 1: Write the failing tests**

`runreport.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseRunReport } from "./runreport";

const MD = [
    "# Retire the recall arm — run report",
    "",
    "DAG 2848: 6/6 tasks done, 0 failures, 44m elapsed.",
    "",
    "## Landed",
    "- 9e4ec1a4 retire `wsh jarvis ask` (t-3)",
    "- c08e46e4 pet recall acts (t-1 + t-5)",
    "## Verified on merged main",
    "- vitest: 246 files pass",
    "- task verify:ui: failures in brief-surface 7,",
    "  jarvis-motion 5",
    "## Answered",
    "- t-1: keep the pet expression",
    "## Forwarded",
    "- none",
    "## Live checks (dev app, CDP)",
    "- NOT checked: composer on a live lead",
].join("\n");

describe("parseRunReport", () => {
    const r = parseRunReport(MD)!;
    it("reads the title and the lead line", () => {
        expect(r.title).toBe("Retire the recall arm — run report");
        expect(r.lead).toBe("DAG 2848: 6/6 tasks done, 0 failures, 44m elapsed.");
    });
    it("splits a landed commit into hash, text and task tag", () => {
        expect(r.sections[0]).toMatchObject({ heading: "Landed", count: "2" });
        expect(r.sections[0].items[0]).toMatchObject({ hash: "9e4ec1a4", text: "retire wsh jarvis ask", tag: "t-3", dot: "ok" });
        expect(r.sections[0].items[1].tag).toBe("t-1 + t-5");
    });
    it("joins a continuation line and marks failures as warn", () => {
        const v = r.sections[1].items[1];
        expect(v.text).toBe("task verify:ui: failures in brief-surface 7, jarvis-motion 5");
        expect(v.dot).toBe("warn");
        expect(r.sections[1].items[0].dot).toBe("ok");
    });
    it("reads a leading task id as the tag", () => {
        expect(r.sections[2].items[0]).toMatchObject({ tag: "t-1", text: "keep the pet expression", dot: "accent" });
    });
    it("counts none as none and dims it", () => {
        expect(r.sections[3]).toMatchObject({ count: "none" });
        expect(r.sections[3].items[0]).toMatchObject({ dim: true, dot: "faint" });
        expect(r.sections[4].items[0]).toMatchObject({ dim: true, dot: "faint" });
    });
    it("a blank report is no report", () => {
        expect(parseRunReport("  \n")).toBeNull();
        expect(parseRunReport("# only a title").sections).toEqual([]);
    });
});
```

`sidebarnotes.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { FeedEntry } from "./effortfeed";
import { sidebarNotes } from "./sidebarnotes";

const e = (seq: number, text: string, over: Partial<FeedEntry> = {}): FeedEntry => ({
    seq,
    ts: 1000 + seq,
    kind: "effort-note",
    chunk: "N1",
    status: "active",
    marked: "",
    text,
    noteAt: seq + 1,
    ...over,
});

describe("sidebarNotes", () => {
    it("opens the newest short note by default and gives it no chevron", () => {
        const cards = sidebarNotes([e(2, "short"), e(1, "older")], "N1", 5000, new Set());
        expect(cards[0]).toMatchObject({ open: true, chev: "" });
        expect(cards[1]).toMatchObject({ open: false, chev: "more ▾" });
    });
    it("a long newest note starts folded", () => {
        const cards = sidebarNotes([e(1, "x".repeat(300))], "N1", 5000, new Set());
        expect(cards[0]).toMatchObject({ open: false, chev: "more ▾" });
    });
    it("an expanded card offers less", () => {
        const cards = sidebarNotes([e(2, "a"), e(1, "b")], "N1", 5000, new Set(["1"]));
        expect(cards[1]).toMatchObject({ open: true, chev: "less ▴" });
    });
    it("labels the author; a legacy note has none", () => {
        const cards = sidebarNotes(
            [e(3, "a", { author: "agent", session: "agent:tab9", run: "run:r1" }), e(2, "b", { author: "you" }), e(1, "c")],
            "N1",
            5000,
            new Set()
        );
        expect(cards.map((c) => c.who)).toEqual(["agent", "you", ""]);
        expect(cards[0]).toMatchObject({ sessionTab: "tab9", runOid: "r1", editable: false });
        expect(cards[1].editable).toBe(true);
        expect(cards[2].editable).toBe(true);
    });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run frontend/app/view/jarvis/runreport.test.ts frontend/app/view/jarvis/sidebarnotes.test.ts`
Expected: FAIL — the modules do not exist.

- [ ] **Step 3: Implement**

`effortfeed.ts`: add `author?: string; session?: string; run?: string;` to `FeedEntry`. In `effortFeed`'s returned entry, after the `noteAt` spread, add:

```ts
                ...(note != null ? { author: note.author ?? "", session: note.session ?? "", run: note.run ?? "" } : {}),
```

`runreport.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// A lead's run report (Run.report, the markdown `wsh jarvis complete --report` files) read as the design's
// structured report (design L508-537, parser L1023, classification L1406-1418). Pure.

export type ReportItem = { text: string; hash: string; tag: string; dot: "ok" | "warn" | "accent" | "faint" | "muted"; dim: boolean };
export type ReportSection = { heading: string; count: string; items: ReportItem[] };
export type RunReport = { title: string; lead: string; sections: ReportSection[] };

type Kind = "landed" | "verified" | "answered" | "forwarded" | "live" | "other";

function kindOf(heading: string): Kind {
    const k = heading.toLowerCase();
    for (const kind of ["landed", "verified", "answered", "forwarded", "live"] as const) {
        if (k.startsWith(kind)) {
            return kind;
        }
    }
    return "other";
}

function item(raw: string, kind: Kind): ReportItem {
    let text = raw.replace(/`/g, "");
    let hash = "";
    let tag = "";
    const hm = kind === "landed" ? /^([0-9a-f]{7,8})\s+(.*)$/.exec(text) : null;
    if (hm != null) {
        hash = hm[1];
        text = hm[2];
    }
    const tm = /\s*\((t-\d+(?:\s*\+\s*t-\d+)*)\)\s*$/.exec(text);
    if (tm != null) {
        tag = tm[1];
        text = text.slice(0, tm.index);
    }
    const pm = tag === "" ? /^(t-\d+):\s*/.exec(text) : null;
    if (pm != null) {
        tag = pm[1];
        text = text.slice(pm[0].length);
    }
    const none = text.toLowerCase() === "none";
    const notChecked = /^NOT checked/.test(text);
    const fail = /failures in|fail(ed)?\b/i.test(text) && !/0 fail/i.test(text);
    const pass = /\bPASS\b|\bpass\b|exit 0/.test(text);
    const dim = none || notChecked;
    const dot: ReportItem["dot"] = dim
        ? "faint"
        : kind === "live" || kind === "verified"
          ? fail
              ? "warn"
              : pass
                ? "ok"
                : "muted"
          : kind === "landed"
            ? "ok"
            : kind === "answered"
              ? "accent"
              : "muted";
    return { text, hash, tag, dot, dim };
}

export function parseRunReport(md: string): RunReport | null {
    if (md.trim() === "") {
        return null;
    }
    const out: RunReport = { title: "", lead: "", sections: [] };
    let sec: { heading: string; raw: string[] } | null = null;
    const secs: { heading: string; raw: string[] }[] = [];
    for (const rawLine of md.split("\n")) {
        const l = rawLine.trimEnd();
        if (/^# /.test(l)) {
            out.title = l.slice(2).trim();
        } else if (/^## /.test(l)) {
            sec = { heading: l.slice(3).trim(), raw: [] };
            secs.push(sec);
        } else if (/^- /.test(l) && sec != null) {
            sec.raw.push(l.slice(2).trim());
        } else if (/^\s+\S/.test(l) && sec != null && sec.raw.length > 0) {
            sec.raw[sec.raw.length - 1] += " " + l.trim();
        } else if (l.trim() !== "" && sec == null && out.lead === "") {
            out.lead = l.trim();
        }
    }
    out.sections = secs.map((s) => {
        const kind = kindOf(s.heading);
        const items = s.raw.map((r) => item(r, kind));
        const real = items.filter((i) => i.text.toLowerCase() !== "none").length;
        return { heading: s.heading, count: real > 0 ? String(real) : "none", items };
    });
    return out;
}
```

`sidebarnotes.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The Chunk sidebar's note cards (design L367-397, model L1508-1542). Pure.

import { noteBody, stamp, type FeedEntry } from "./effortfeed";

// a note under this length is read whole; the newest one opens by default (design L1515)
export const NOTE_OPEN_CHARS = 280;

export type NoteCard = {
    key: string;
    entry: FeedEntry;
    who: "agent" | "you" | "";
    day: string;
    edited: boolean;
    text: string;
    open: boolean;
    chev: string;
    editable: boolean;
    runOid: string;
    sessionTab: string;
};

export function sidebarNotes(feed: FeedEntry[], label: string, now: number, expanded: Set<string>): NoteCard[] {
    const entries = feed.filter((f) => f.chunk === label && noteBody(f) !== "");
    return entries.map((f, i) => {
        const key = String(f.seq);
        const text = noteBody(f);
        const newestShort = i === 0 && text.length < NOTE_OPEN_CHARS;
        const open = newestShort || expanded.has(key);
        const who = f.author === "agent" || f.author === "you" ? f.author : "";
        return {
            key,
            entry: f,
            who,
            day: stamp(f.ts, now),
            edited: f.edited === true,
            text,
            open,
            chev: newestShort ? "" : open ? "less ▴" : "more ▾",
            // an agent's note is its record of what it did; yours and legacy ones stay editable
            editable: f.noteAt != null && who !== "agent",
            runOid: (f.run ?? "").replace(/^run:/, ""),
            sessionTab: (f.session ?? "").replace(/^agent:/, ""),
        };
    });
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run frontend/app/view/jarvis/runreport.test.ts frontend/app/view/jarvis/sidebarnotes.test.ts frontend/app/view/jarvis/effortfeed.test.ts`
Expected: PASS.

- [ ] **Step 5: Checkpoint.**

---

## Phase 3 — Frontend views, region by region

Each task below is verified two ways:
- `task check:ts`;
- a CDP screenshot beside the matching design state. The design states are rendered by the harness in Task 14: `node scripts/cdp/design-states.mjs`, which writes `cdp-shots/design/<state>.png`.

Run the dev app as `tail -f /dev/null | task dev` (the memory note on stdin EOF). Seed design-shaped data with `node scripts/cdp/seed-brief.mjs` (Task 14 creates it). Build Task 14's two scripts first if you want the comparison available while you work: they have no dependencies on Tasks 7-13.

### Task 7: Row components
**Depends on:** Task 4, Task 5, Task 6

**Files:**
- Create: `frontend/app/view/jarvis/briefrowviews.tsx`
- Modify: `frontend/app/view/jarvis/briefstyle.ts` (add `CURSOR_RING`, `cursorAttrs`)
- Modify: `frontend/app/view/jarvis/progressbar.tsx` (a `tone` prop)
- Modify: `frontend/app/view/jarvis/briefrows.ts` (`runRowFace`, `LineTone` gains `"faint"`, `initiativeLine` archived state, `sessionLine` sets `age`)
- Test: `frontend/app/view/jarvis/briefrows.test.ts`

**Interfaces:**
- Consumes: `BriefLine` (Task 5), `QueueAct` (Task 5), `TONE_TEXT` (Task 4).
- Produces:
  - `WaitingRow`, `InitiativeRow`, `RunRowView`, `DeltaRowView`, `ShippedRowView`
  - `runRowFace(input): RunRowFace`
  - `ProgressBar({ pct, tone?: "accent" | "success" | "asking", className? })`
  - `type EffortIndex = Map<string /* effort oid */, { oref: string; title: string; chunkStages: Record<string, string> }>`

- [ ] **Step 1: Write the failing test** (append to `briefrows.test.ts`)

```ts
describe("runRowFace", () => {
    const line = { id: "sessions:run:r1", title: "N1 box upgrade", age: "2h", runOid: "r1" } as BriefLine;
    const run = { id: "r1", mode: "orchestrator", status: "executing", runtime: "claude", createdts: 0, effortref: { effortoid: "e1", chunklabel: "N1 box upgrade" } } as unknown as Run;
    const effort = { oref: "effort:e1", title: "Scenario gate clearance", chunkStages: { "N1 box upgrade": "Phase 2 · upgrade" } };
    it("reads an orchestrator run as the design does", () => {
        const f = runRowFace({ line, run, asking: false, project: "arc-infra", effort });
        expect(f).toMatchObject({
            type: "orchestrator",
            meta: "lead · arc-infra",
            elapsed: "2h",
            state: "running",
            stateTone: "ok",
            dot: "live",
            canStop: true,
            chunkLabel: "Scenario gate clearance · Phase 2 · upgrade",
        });
    });
    it("an asking quick run shows asking and can be answered", () => {
        const f = runRowFace({ line, run: { ...run, mode: "", runtime: "claude" } as Run, asking: true, project: "arc-infra" });
        expect(f).toMatchObject({ type: "quick run", meta: "claude · arc-infra", state: "asking", stateTone: "asking", dot: "asking", chunkLabel: "" });
    });
    it("a direct agent has no Stop", () => {
        const f = runRowFace({ line: { ...line, runOid: undefined, agentId: "a1", meta: "claude · waveterm", state: "working" }, asking: false, project: "" });
        expect(f).toMatchObject({ type: "agent", meta: "claude · waveterm", canStop: false, state: "running" });
    });
});
```

- [ ] **Step 2: Run the test and confirm it fails.** `npx vitest run frontend/app/view/jarvis/briefrows.test.ts` fails with "runRowFace is not exported".

- [ ] **Step 3: Implement**

`briefrows.ts`: add `"faint"` to `LineTone`. In `initiativeLine`, put the archived state first: `card.status === "archived" ? ["archived", "faint"] : blocked > 0 ? ...`. In `sessionLine`, set `age: age(row.ts, now)`. Add:

```ts
export type RunRowFace = {
    type: "quick run" | "orchestrator" | "agent";
    meta: string;
    elapsed: string;
    state: string;
    stateTone: LineTone;
    dot: "live" | "asking" | "done" | "idle";
    asking: boolean;
    canStop: boolean;
    stopped: boolean;
    chunkLabel: string;
    effortOref: string;
    chunk: string;
};

// A Runs row (design L266-278, model L1615-1627) from the live Run object and the roster.
export function runRowFace(i: {
    line: BriefLine;
    run?: Run;
    asking: boolean;
    project: string;
    effort?: { oref: string; title: string; chunkStages: Record<string, string> };
}): RunRowFace {
    const { line, run } = i;
    if (run == null) {
        const working = line.state === "working";
        return {
            type: "agent",
            meta: line.meta,
            elapsed: line.age,
            state: i.asking || line.state === "asking" ? "asking" : working ? "running" : line.state,
            stateTone: i.asking || line.state === "asking" ? "asking" : "ok",
            dot: i.asking || line.state === "asking" ? "asking" : "live",
            asking: i.asking || line.state === "asking",
            canStop: false,
            stopped: false,
            chunkLabel: "",
            effortOref: "",
            chunk: "",
        };
    }
    const orch = run.mode === "orchestrator";
    const status = run.status ?? "";
    const [state, stateTone]: [string, LineTone] = i.asking
        ? ["asking", "asking"]
        : status === "blocked"
          ? ["blocked", "asking"]
          : status === "awaiting-review"
            ? ["review", "asking"]
            : status === "cancelled"
              ? ["stopped", "faint"]
              : status === "done"
                ? ["done", "ok"]
                : status === "planning"
                  ? ["planning", "ok"]
                  : ["running", "ok"];
    const terminal = status === "done" || status === "cancelled";
    const ref = run.effortref;
    const stage = ref != null && i.effort != null ? (i.effort.chunkStages[ref.chunklabel] ?? "") : "";
    return {
        type: orch ? "orchestrator" : "quick run",
        meta: orch ? `lead · ${i.project}` : `${run.runtime || "claude"} · ${i.project}`,
        elapsed: line.age,
        state,
        stateTone,
        dot: i.asking ? "asking" : terminal ? (status === "done" ? "done" : "idle") : "live",
        asking: i.asking,
        canStop: !terminal,
        stopped: status === "cancelled",
        chunkLabel: ref != null && i.effort != null ? `${i.effort.title} · ${stage || "unstaged"}` : "",
        effortOref: ref != null && i.effort != null ? i.effort.oref : "",
        chunk: ref?.chunklabel ?? "",
    };
}
```

`progressbar.tsx`: add a `tone` prop. The default stays the accent gradient, so every existing caller is unchanged:

```tsx
const FILL = {
    accent: "bg-gradient-to-r from-accent-600 to-accent",
    success: "bg-success",
    asking: "bg-asking",
} as const;

export function ProgressBar({
    pct,
    tone = "accent",
    className,
}: {
    pct: number;
    tone?: keyof typeof FILL;
    className?: string;
}) {
    const reduce = useReducedMotion();
    return (
        <div className={cn("h-[5px] overflow-hidden rounded-full bg-border", className)}>
            <div
                className={cn("h-full rounded-full", FILL[tone])}
                style={{ width: `${Math.min(100, Math.max(0, pct))}%`, transition: widthTween(reduce) }}
            />
        </div>
    );
}
```

`briefstyle.ts`, append:

```ts
// the j/k cursor: an inset ring, so it never overwrites a row's own tone
export const CURSOR_RING = "ring-1 ring-inset ring-accent/70";
export function cursorAttrs(focused: boolean) {
    return { "data-jarvis-brief-cursor": focused ? "true" : undefined };
}
```

In `briefsurface.tsx`, delete its local `CURSOR_RING` and `cursorAttrs` and import both from `./briefstyle`.

`briefrowviews.tsx`:

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// One row component per Brief region, each drawn to the design's own anatomy
// (docs/prototype/jarvis-brief-editing.dc.html). The regions stopped sharing one LineRow because the
// design gives them different anatomies: Waiting acts in place, Runs is two lines under a type badge,
// Behind you is two lines under a wording column.

import { cn } from "@/util/util";
import type { ReactNode } from "react";
import type { QueueAct } from "./briefingmodel";
import type { BriefLine, RunRowFace } from "./briefrows";
import { CURSOR_RING, cursorAttrs, MONO_FAINT, ROW_BORDER, SMALL_BTN, TONE_TEXT } from "./briefstyle";
import { ProgressBar } from "./progressbar";

const PULSE = "animate-[pulseDot_1.8s_ease-in-out_infinite] motion-reduce:animate-none";

export function WaitingRow({
    line,
    focused,
    act,
    onOpen,
    onAct,
}: {
    line: BriefLine;
    focused: boolean;
    act: QueueAct;
    onOpen?: () => void;
    onAct: () => void;
}) {
    return (
        <div
            data-jarvis-brief-row="queue"
            {...cursorAttrs(focused)}
            onClick={onOpen}
            className={cn(
                "flex items-center gap-[13px] py-1.5 hover:bg-surface-hover",
                ROW_BORDER,
                onOpen != null && "cursor-pointer",
                focused && CURSOR_RING
            )}
        >
            <span className={cn("w-[92px] flex-none truncate font-mono text-[10.5px] font-semibold tracking-[.02em]", TONE_TEXT[line.kindTone])}>
                {line.kind}
            </span>
            <span title={line.why ? `${line.title} — ${line.why}` : line.title} className="min-w-0 flex-1 truncate text-[13px] text-ink-hi">
                {line.title}
                {line.why ? <span className="text-ink-mid"> — {line.why}</span> : null}
            </span>
            <span className="w-[200px] flex-none truncate text-right font-mono text-[11px] text-ink-mid">{line.meta}</span>
            <span className={cn("w-10 flex-none text-right font-mono text-[11px] font-semibold", TONE_TEXT[line.kindTone])}>
                {line.age}
            </span>
            <button
                type="button"
                data-jarvis-queue-act={act.kind}
                onClick={(e) => {
                    e.stopPropagation();
                    onAct();
                }}
                className={cn(
                    "w-[66px] flex-none cursor-pointer rounded-[6px] border py-[3px] font-mono text-[10.5px] font-semibold hover:border-edge-strong hover:text-ink-hi focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                    act.label === "Approve" ? "border-success/35 bg-success/12 text-success" : "border-edge-mid text-secondary"
                )}
            >
                {act.label}
            </button>
        </div>
    );
}

export function InitiativeRow({
    line,
    focused,
    fresh,
    expanded,
    titleSlot,
    onOpen,
    onContextMenu,
}: {
    line: BriefLine;
    focused: boolean;
    fresh: boolean;
    expanded: boolean;
    // the rename input replaces the title in place, keeping the progress, meta and state columns
    titleSlot?: ReactNode;
    onOpen: () => void;
    onContextMenu?: (e: React.MouseEvent) => void;
}) {
    const p = line.progress ?? { done: 0, total: 0, pct: 0 };
    return (
        <div
            role="button"
            tabIndex={-1}
            aria-expanded={expanded}
            aria-label={expanded ? `Collapse ${line.title}` : `Open ${line.title}`}
            data-jarvis-brief-row="initiative"
            {...cursorAttrs(focused)}
            onClick={onOpen}
            onContextMenu={onContextMenu}
            className={cn(
                "relative flex cursor-pointer items-center gap-[13px] border px-[11px] py-[7px]",
                expanded
                    ? "rounded-t-[10px] border-border bg-surface-selected"
                    : "rounded-[9px] border-transparent border-b-edge-faint hover:bg-surface-hover",
                focused && CURSOR_RING,
                fresh && "fresh-mark"
            )}
        >
            <span className="flex w-[92px] flex-none items-center gap-[7px]">
                <ProgressBar pct={p.pct} tone={line.stateTone === "asking" ? "asking" : "success"} className="h-1 min-w-0 flex-1 rounded-[2px]" />
                <span className="flex-none font-mono text-[10.5px] text-ink-mid">
                    {p.done}/{p.total}
                </span>
            </span>
            {titleSlot ?? (
                <span title={line.note ? `${line.title} — ${line.note}` : line.title} className="min-w-0 flex-1 truncate text-[13px] text-ink-hi">
                    {line.title}
                    {line.note ? <span className="text-ink-mid"> — {line.note}</span> : null}
                </span>
            )}
            <span className="w-[190px] flex-none truncate text-right font-mono text-[11px] text-ink-mid">{line.meta}</span>
            <span className={cn("w-[76px] flex-none truncate text-right font-mono text-[11px] font-semibold", TONE_TEXT[line.stateTone])}>
                {line.state}
            </span>
            <span aria-hidden className="w-2.5 flex-none text-center text-[10px] text-muted">
                {expanded ? "▾" : "▸"}
            </span>
        </div>
    );
}

const DOT = { live: cn("bg-success", PULSE), asking: cn("bg-asking", PULSE), done: "bg-success/45", idle: "bg-feed-glyph" };
const TYPE_BADGE = {
    orchestrator: "border-accent-soft/35 text-accent-soft",
    agent: "border-edge-mid text-ink-mid",
    "quick run": "border-edge-mid text-secondary",
};

export function RunRowView({
    line,
    face,
    focused,
    selected,
    onOpenSheet,
    onOpenChunk,
    onAnswer,
    onOpenAgent,
    onStop,
}: {
    line: BriefLine;
    face: RunRowFace;
    focused: boolean;
    selected: boolean;
    onOpenSheet?: () => void;
    onOpenChunk: () => void;
    onAnswer: () => void;
    onOpenAgent: () => void;
    onStop: () => void;
}) {
    const stop = (fn: () => void) => (e: React.MouseEvent) => {
        e.stopPropagation();
        fn();
    };
    return (
        <div
            data-jarvis-brief-row="session"
            {...cursorAttrs(focused)}
            onClick={onOpenSheet}
            className={cn(
                "flex items-center gap-3 py-[7px] hover:bg-surface-hover",
                ROW_BORDER,
                onOpenSheet != null && "cursor-pointer",
                selected && "bg-surface-selected",
                focused && CURSOR_RING
            )}
        >
            <span className={cn("h-[7px] w-[7px] flex-none rounded-full", DOT[face.dot])} />
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <div className="flex min-w-0 items-center gap-2">
                    <span className={cn("flex-none rounded-[5px] border px-[5px] font-mono text-[10px] leading-4", TYPE_BADGE[face.type])}>
                        {face.type}
                    </span>
                    <span title={line.title} className={cn("min-w-0 truncate text-[13px]", face.stopped ? "text-ink-mid" : "text-ink-hi")}>
                        {line.title}
                    </span>
                </div>
                <div className={cn("flex min-w-0 items-center gap-2", MONO_FAINT)}>
                    <span className="flex-none whitespace-nowrap">
                        {face.meta} · {face.elapsed}
                    </span>
                    {face.chunkLabel !== "" ? (
                        <button
                            type="button"
                            title="Open this chunk"
                            onClick={stop(onOpenChunk)}
                            className="min-w-0 cursor-pointer truncate font-mono text-[10.5px] text-muted hover:text-accent-soft"
                        >
                            ↳ {face.chunkLabel}
                        </button>
                    ) : null}
                </div>
            </div>
            <span className={cn("w-[62px] flex-none text-right font-mono text-[11px] font-semibold", TONE_TEXT[face.stateTone])}>
                {face.state}
            </span>
            <div className="flex flex-none justify-end gap-1">
                {face.asking ? (
                    <button
                        type="button"
                        onClick={stop(onAnswer)}
                        className="cursor-pointer rounded-[6px] border border-asking/35 bg-asking/12 px-2 py-[3px] text-[10.5px] font-bold text-asking hover:bg-asking/20"
                    >
                        Answer
                    </button>
                ) : null}
                <button type="button" onClick={stop(onOpenAgent)} className={SMALL_BTN}>
                    Open
                </button>
                {face.canStop ? (
                    <button
                        type="button"
                        title="Stop this session"
                        onClick={stop(onStop)}
                        className={cn(SMALL_BTN, "text-ink-mid hover:border-error/50 hover:text-error")}
                    >
                        Stop
                    </button>
                ) : null}
            </div>
        </div>
    );
}

export function DeltaRowView({ line, focused, onOpen }: { line: BriefLine; focused: boolean; onOpen?: () => void }) {
    return (
        <div
            data-jarvis-brief-row="delta"
            {...cursorAttrs(focused)}
            onClick={onOpen}
            className={cn("flex items-center gap-[13px] py-[7px]", ROW_BORDER, onOpen != null && "cursor-pointer hover:bg-surface-hover", focused && CURSOR_RING)}
        >
            <span className={cn("w-28 flex-none truncate font-mono text-[10.5px] font-semibold", TONE_TEXT[line.kindTone])}>{line.kind}</span>
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span title={line.title} className="truncate text-[13px] text-ink-hi">
                    {line.title}
                </span>
                {line.detail ? <span className={cn("truncate", MONO_FAINT)}>{line.detail}</span> : null}
            </div>
            <span className="w-12 flex-none text-right font-mono text-[11px] text-ink-mid">{line.state}</span>
        </div>
    );
}

export function ShippedRowView({
    line,
    focused,
    selected,
    onOpen,
}: {
    line: BriefLine;
    focused: boolean;
    selected: boolean;
    onOpen?: () => void;
}) {
    return (
        <div
            data-jarvis-brief-row="shipped"
            {...cursorAttrs(focused)}
            onClick={onOpen}
            className={cn(
                "flex items-center gap-3 py-[7px] hover:bg-surface-hover",
                ROW_BORDER,
                onOpen != null ? "cursor-pointer" : "cursor-default",
                selected && "bg-surface-selected",
                focused && CURSOR_RING
            )}
        >
            <span className="h-[7px] w-[7px] flex-none rounded-full bg-success/45" />
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <div className="flex min-w-0 items-center gap-2">
                    <span title={line.title} className="min-w-0 truncate text-[13px] text-ink-hi">
                        {line.title}
                    </span>
                    {line.fresh ? (
                        <span className="flex-none rounded-[5px] border border-accent/40 px-[5px] font-mono text-[9.5px] leading-[15px] text-accent-soft">
                            new
                        </span>
                    ) : null}
                </div>
                {line.detail ? <span className={cn("truncate", MONO_FAINT)}>{line.detail}</span> : null}
            </div>
            {line.hasReport ? <span className="flex-none font-mono text-[10px] text-ink-mid">report</span> : null}
            <span className="w-12 flex-none text-right font-mono text-[11px] text-ink-mid">{line.state}</span>
        </div>
    );
}
```

- [ ] **Step 4: Run the tests.** `npx vitest run frontend/app/view/jarvis/briefrows.test.ts` passes.
- [ ] **Step 5: Checkpoint.**

### Task 8: Header
**Depends on:** Task 7

The design's header order and sizes (design L26-63). The tier becomes the design's one-click button, which cycles every project and posts an undo toast. Per-project tier editing moves into the Profile modal (Task 13).

**Files:**
- Modify: `frontend/app/view/jarvis/briefsurface.tsx` (the `<header>` block, ~L1236-1319)
- Modify: `frontend/app/view/jarvis/autonomyladderview.tsx` (add `TierButton` and `TIER_LABEL`; `AutonomyLadder` stays, mounted by the Profile)
- Modify: `frontend/app/view/jarvis/newinitiativecontrol.tsx`, `newruncontrol.tsx` (button text 9.5px → 10.5px)

**Interfaces:**
- Produces: `TierButton({ channels }: { channels: Channel[] | null })` and `TIER_LABEL: Record<JarvisTier, string>`.

- [ ] **Step 1: Implement `TierButton`** (append to `autonomyladderview.tsx`, importing `briefUndo` from `./briefundo`)

```tsx
// the design's three tier words (design L979), mapped onto the backend's nested tiers
export const TIER_LABEL: Record<JarvisTier, string> = {
    concierge: "L1 · ask first",
    gatekeeper: "L2 · gated",
    delegator: "L3 · autonomous",
};

// The header's tier control (design L41, L1779): one click moves every project one rung up the ladder,
// wrapping, and the toast offers the way back. Per-project tiers and the dispatch mode are edited in the
// Profile, where the other per-project policy lives.
export function TierButton({ channels }: { channels: Channel[] | null }) {
    const projects = useAtomValue(projectsAtom);
    const rows = useMemo(() => channelAutonomy(channels, projects), [channels, projects]);
    const summary = autonomySummary(rows);
    if (summary == null) {
        return null;
    }
    const label = summary.mixed ? `Mixed · ${TIER_LABEL[summary.tier]}` : TIER_LABEL[summary.tier];
    const cycle = () => {
        const order = LADDER.map((r) => r.tier);
        const next = order[(order.indexOf(summary.tier) + 1) % order.length];
        const prev = rows.map((r) => ({ id: r.channelId, tier: r.tier, mode: r.mode }));
        fireAndForget(async () => {
            try {
                await Promise.all(rows.map((r) => setChannelTier(r.channelId, next, r.mode)));
                briefUndo.notify(`Autonomy set to ${TIER_LABEL[next]} for every project`, () =>
                    fireAndForget(async () => {
                        await Promise.all(prev.map((p) => setChannelTier(p.id, p.tier, p.mode)));
                    })
                );
            } catch (e) {
                briefUndo.error(e instanceof Error ? e.message : String(e));
            }
        });
    };
    return (
        <button
            type="button"
            data-jarvis-autonomy="chip"
            onClick={cycle}
            title="Remote-approval policy · click to change"
            className="flex-none cursor-pointer whitespace-nowrap rounded-[6px] border border-border px-2.5 py-[3px] font-mono text-[10.5px] font-bold uppercase tracking-[.06em] text-ink-mid hover:border-edge-strong hover:text-ink-hi focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
            {label}
        </button>
    );
}
```

- [ ] **Step 2: Replace the header** in `briefsurface.tsx` (from `<header` to `</header>`). The waiting chip, the fleet line and the filter keep their current state wiring; their order and classes change:

```tsx
            <header className="flex h-[54px] flex-none items-center gap-2.5 border-b border-edge-faint bg-surface px-[22px]">
                <span aria-hidden className="font-mono text-[12px] font-semibold text-accent-soft">
                    ◈
                </span>
                <span className="flex-none text-[15px] font-bold tracking-[-.01em] text-ink-hi">Jarvis</span>
                {projectCount > 0 ? (
                    <span className="whitespace-nowrap font-mono text-[10.5px] text-ink-mid">
                        all work · {projectCount} {projectCount === 1 ? "project" : "projects"}
                    </span>
                ) : null}
                <span aria-hidden className="mx-1 h-[18px] w-px flex-none bg-border" />
                {model_ != null ? (
                    <span
                        data-jarvis-brief-band="waiting"
                        className={cn(
                            "flex flex-none items-center gap-[7px] rounded-[6px] border px-2.5 py-[3px] font-mono text-[10.5px] font-bold uppercase tracking-[.06em]",
                            queue.length === 0 ? "border-success/30 bg-success/15 text-success" : "border-asking/30 bg-asking/15 text-asking"
                        )}
                    >
                        <span
                            className={cn(
                                "h-[5px] w-[5px] flex-none rounded-full",
                                queue.length === 0
                                    ? "bg-success"
                                    : "animate-[pulseDot_1.8s_ease-in-out_infinite] bg-asking motion-reduce:animate-none"
                            )}
                        />
                        {queue.length === 0 ? "all clear" : <span className="flex items-center gap-1"><RollingCount value={queue.length} /> waiting</span>}
                    </span>
                ) : null}
                <span data-jarvis-brief-band="fleet" className="flex-none whitespace-nowrap font-mono text-[10.5px] text-ink-mid">
                    {fleet.line}
                </span>
                <span className="flex-1" />
                <label className="flex h-[27px] w-[190px] flex-none items-center gap-2 rounded-[8px] border border-border px-2.5 focus-within:border-accent/60">
                    <span aria-hidden className="font-mono text-[10.5px] font-medium text-muted">
                        /
                    </span>
                    <input
                        data-jarvis-brief-filter
                        aria-label="Filter the Brief"
                        placeholder="filter"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === "Escape") {
                                setQuery("");
                                e.currentTarget.blur();
                            }
                        }}
                        className="min-w-0 flex-1 bg-transparent text-[12.5px] text-ink-hi outline-none placeholder:text-muted"
                    />
                    {filtering ? (
                        <span className="flex-none font-mono text-[10.5px] text-muted">
                            {view.visible.length} {view.visible.length === 1 ? "hit" : "hits"}
                        </span>
                    ) : null}
                </label>
                <TierButton channels={channels} />
                <button
                    type="button"
                    data-jarvis-brief-profile
                    aria-expanded={profileOpen}
                    onClick={() => setProfileOpen(true)}
                    className="flex-none cursor-pointer rounded-[6px] border border-border px-2.5 py-[3px] font-mono text-[10.5px] font-bold uppercase tracking-[.06em] text-secondary hover:border-edge-strong hover:text-ink-hi focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                >
                    Profile
                </button>
                <NewInitiativeControl />
                <NewRunControl model={model} />
            </header>
```

Replace the `AutonomyLadder` import with `TierButton`. In `newinitiativecontrol.tsx` and `newruncontrol.tsx`, change the trigger button's `text-[9.5px]` to `text-[10.5px]`, and on + Initiative change `text-*` to `text-secondary` with `hover:border-edge-strong hover:text-ink-hi` (design L44).

- [ ] **Step 3: Verify.** Run `task check:ts` (exit 0). Take a CDP shot of the header and compare it with `cdp-shots/design/default.png`: same order, same divider, chip at 10.5px, filter 190px wide.
- [ ] **Step 4: Checkpoint.**

### Task 9: Regions — Waiting, Initiatives, Runs, Behind you
**Depends on:** Task 8

**Files:**
- Modify: `frontend/app/view/jarvis/briefsurface.tsx`: `REGIONS`, `RegionHead`, `Region`, `QueueSummaryView`, `MoreControl`, `LineRow`, which is deleted and replaced by the Task 7 rows, and the four region blocks.
- Modify: `frontend/app/view/jarvis/briefingstore.ts` (`markBriefingSeen`)
- Modify: `frontend/app/view/jarvis/effortstore.ts` (`archivedEffortsAtom`, `loadArchivedEfforts`)
- Modify: `frontend/app/view/jarvis/briefingmodel.ts` (export `EffortCardModel` builder for archived: reuse `buildEffortCard`)

**Interfaces:**
- Consumes: everything from Tasks 4-8.
- Produces:
  - `markBriefingSeen(): () => void`, which returns the undo;
  - `archivedEffortsAtom: PrimitiveAtom<EffortSummary[]>` and `loadArchivedEfforts(): Promise<void>`;
  - `briefEffortIndexAtom: PrimitiveAtom<EffortIndex>` (in `jarvisstore.ts`; the run sheet reads it in Task 12);
  - `briefRunListAtom: PrimitiveAtom<string[]>` (run oids, in `jarvisstore.ts`; the run sheet reads it in Task 12).

- [ ] **Step 1: Stores**

`briefingstore.ts`:

```ts
// "mark seen" (design L287, L1794): the visit cursor jumps to this snapshot's query start now instead of
// after the dwell, and the Brief re-reads so Behind you empties. Returns the undo.
export function markBriefingSeen(): () => void {
    const prev = globalStore.get(briefingCursorAtom);
    const st = globalStore.get(fetchedBriefingStateAtom);
    if (st.snapshot == null) {
        return () => {};
    }
    globalStore.set(briefingCursorAtom, st.snapshot.queryStartedAt);
    loadBriefing();
    return () => {
        globalStore.set(briefingCursorAtom, prev);
        loadBriefing();
    };
}
```

`effortstore.ts`:

```ts
// the archived initiatives the Brief can reveal (design L251, "Show N archived"); the briefing leg drops
// archived efforts server-side, so these come from the effort list with includearchived.
export const archivedEffortsAtom = atom<EffortSummary[]>([]) as PrimitiveAtom<EffortSummary[]>;
export async function loadArchivedEfforts(): Promise<void> {
    const rtn = await RpcApi.EffortListCommand(TabRpcClient, { includearchived: true }, { timeout: stateRpcTimeoutMs });
    globalStore.set(archivedEffortsAtom, (rtn.efforts ?? []).filter((e) => e.status === "archived"));
}
```

`mutateEffort` also calls `void loadArchivedEfforts().catch(() => {})` after it writes, so archive and unarchive move a row between the two lists.

`jarvisstore.ts`:

```ts
// the Brief's effort titles and chunk stages by oid, for the run sheet's ↳ chunk line (it mounts outside
// the Brief's snapshot)
export const briefEffortIndexAtom = atom<Map<string, { oref: string; title: string; chunkStages: Record<string, string> }>>(
    new Map()
) as PrimitiveAtom<Map<string, { oref: string; title: string; chunkStages: Record<string, string> }>>;
// the run oids of the group the open run sheet belongs to (live runs, or shipped), in row order: the
// sheet's "n / N" and its ↑/↓ (design L420-424)
export const briefRunListAtom = atom<string[]>([]) as PrimitiveAtom<string[]>;
```

- [ ] **Step 2: Region chrome**

- `REGIONS.sessions.label` becomes `"Runs"`.
- `RegionHead`:
  - the label uses `REGION_LABEL` from `briefstyle` with `alert ? "text-asking" : id === "waiting" ? "text-feed-label" : "text-ink-mid"` (design L71, L109);
  - the count becomes `font-mono text-[10.5px] font-medium text-ink-mid`;
  - the meta becomes `MONO_FAINT`.
- Delete `REGION_LABEL`, `SUB_LABEL`, `TONE_FG` and `LineRow` from `briefsurface.tsx`, and use `REGION_LABEL` from `briefstyle.ts` in the loading skeleton.
- `MoreControl` uses `LINK_BTN`.
- `QueueSummaryView`:
  - detail `font-mono text-[10.5px] text-ink-mid`;
  - button `font-mono text-[10.5px] font-semibold text-ink-mid hover:border-edge-strong hover:bg-surface-hover hover:text-ink-hi`, label `{expanded ? "Hide" : `Review ${count}`}` (design L1787, which reads "Review 1" for one item too).

- [ ] **Step 3: Waiting.**
- Region `meta` is always `"gates before asks"`, and `count` is `queue.length || undefined`.
- Replace the `LineRow` inside the waiting reveal with the row below, keyed by queue key:

```tsx
<WaitingRow
    line={l}
    focused={cursor === l.id}
    act={queueAction(queue.find((q) => "waiting:" + q.key === l.id)!)}
    onOpen={l.target != null ? () => openLine(l.target) : undefined}
    onAct={() => actOnQueue(queue.find((q) => "waiting:" + q.key === l.id)!, l)}
/>
```

with, above the JSX:

```tsx
    const actOnQueue = (q: QueueRow, l: BriefLine) => {
        const act = queueAction(q);
        const run = (label: string, fn: () => Promise<void>) =>
            fireAndForget(async () => {
                try {
                    await fn();
                    briefUndo.notify(label);
                } catch (e) {
                    briefUndo.error(e instanceof Error ? e.message : String(e));
                }
            });
        switch (act.kind) {
            case "approve-gate":
                return run(`Approved · ${q.source || q.title}`, () =>
                    RpcApi.AdvanceRunCommand(TabRpcClient, { channelid: q.channelId, runid: q.runId!, phaseidx: q.phaseIdx, action: "approve" })
                );
            case "approve-dag":
                return run(`Approved ${q.taskId} · ${q.source || q.title}`, () =>
                    RpcApi.DagActionCommand(TabRpcClient, { channelid: q.channelId, runid: q.runId!, taskid: q.taskId, action: "approve" })
                );
            case "retry-dag":
                return run(`Retrying ${q.taskId}`, () =>
                    RpcApi.DagActionCommand(TabRpcClient, { channelid: q.channelId, runid: q.runId!, taskid: q.taskId, action: "retry" })
                );
            default:
                if (l.target != null) {
                    openLine(l.target);
                }
        }
    };
```

- [ ] **Step 4: Initiatives.**
- `count` = `lines.initiatives.length`; `meta` = `paused > 0 ? `${paused} paused` : "all moving"`, where `paused = efforts.filter((e) => e.status === "paused").length` (design L1789). Delete `stalled`.
- Archived rows:
  - on mount, `fireAndForget(loadArchivedEfforts)`;
  - `const [showArchived, setShowArchived] = useState(false)`;
  - `archivedCards = useAtomValue(archivedEffortsAtom).map(buildEffortCard)`;
  - when `showArchived`, append `archivedCards.map(initiativeLine)` to the `initiatives` lines (both the filtered and the nav lists);
  - after the rows, when `archivedCards.length > 0`, render `<button type="button" onClick={() => setShowArchived(!showArchived)} className={cn(LINK_BTN, "mt-1")}>{showArchived ? "Hide archived" : `Show ${archivedCards.length} archived`}</button>`.
- Row: replace the rename-input-or-`LineRow` ternary with `<InitiativeRow line={l} focused={cursor === l.id} fresh={freshInitiatives.has(keyOf(l))} expanded={l.id === openInitiative} onContextMenu={(ev) => showInitiativeMenu(l, ev)} onOpen={() => { setCursor(l.id); toggleInitiative(l.id); }} titleSlot={l.id === openInitiative && renamingTitle != null ? <input …existing rename input props… className="min-w-0 flex-1 rounded-[6px] border border-accent/60 bg-background px-[7px] py-0.5 text-[13px] text-ink-hi outline-none" onClick={(e) => e.stopPropagation()} /> : undefined} />`. Keep the input's existing `autoFocus`, `value`, `onChange`, `onBlur` and `onKeyDown` exactly.
- Publish the effort index: `useEffect(() => globalStore.set(briefEffortIndexAtom, new Map([...efforts, ...archivedCards].map((e) => [e.oref.replace(/^effort:/, ""), { oref: e.oref, title: e.title, chunkStages: e.chunkStages }]))), [efforts, archivedCards]);`

- [ ] **Step 5: Runs.**
- `meta` = `${liveN} live`, where `liveN = view.sessionLines.filter((l) => !l.stale).length`.
- The stale fold button uses `LINK_BTN`.
- Replace the session `LineRow` with the component below. It reads its run: hooks cannot run in the `map`, so it is a small component in `briefsurface.tsx`:

```tsx
const NO_RUN = atom<Run | undefined>(undefined);
function BriefRunRow({
    model,
    line,
    focused,
    selected,
    onOpenSheet,
    onOpenChunk,
}: {
    model: AgentsViewModel;
    line: BriefLine;
    focused: boolean;
    selected: boolean;
    onOpenSheet?: () => void;
    onOpenChunk: (effortOref: string, chunk: string) => void;
}) {
    const run = useAtomValue((line.runOid ? runAtom(line.runOid) : NO_RUN) as Atom<Run | undefined>);
    const agents = useAtomValue(model.agentsAtom);
    const projects = useAtomValue(projectsAtom);
    const index = useAtomValue(briefEffortIndexAtom);
    const asking = run != null ? leadAsker(run, agents) != null : line.state === "asking";
    const face = runRowFace({
        line,
        run,
        asking,
        project: projectName(run?.projectpath ?? "", projects),
        effort: run?.effortref != null ? index.get(run.effortref.effortoid) : undefined,
    });
    return (
        <RunRowView
            line={line}
            face={face}
            focused={focused}
            selected={selected}
            onOpenSheet={onOpenSheet}
            onOpenChunk={() => onOpenChunk(face.effortOref, face.chunk)}
            onAnswer={() => onOpenSheet?.()}
            onOpenAgent={() => {
                const worker = run != null ? leadWorker(run, agents) : undefined;
                const id = worker?.id ?? line.agentId;
                if (id == null) {
                    briefUndo.notify("No live session to open.");
                    return;
                }
                jumpToAgent(model, id);
            }}
            onStop={() => run != null && confirmCancelRun(run.channeloid ?? "", run.id, liveWorkers(run, agents).length)}
        />
    );
}
```

  Its `selected` prop is `stageRun?.id === l.runOid && sheetOpen`, where `stageRun` comes from `useAtomValue(stageRunAtom)`. `onOpenChunk` opens the initiative inline on that chunk:

```tsx
    const revealChunk = (effortOref: string, chunk: string) => {
        const lineId = "initiatives:" + effortOref;
        globalStore.set(briefSheetOpenAtom, false);
        clearSubject();
        setOpenInitiative(lineId);
        const chunks = effortCache.get(effortOref) != null ? effortChunkRows(effortCache.get(effortOref)!) : [];
        const at = groupChunksByStage(chunks).findIndex((g) => g.rows.some((r) => r.label === chunk));
        const stage = chunks.find((c) => c.label === chunk)?.stage ?? "";
        if (at >= 0) {
            setStageOverrides((cur) => ({ ...cur, [stageRowId(lineId, stage, at)]: true }));
        }
        setCursor(chunkRowId(lineId, chunk));
        fireAndForget(() => loadEffortDetail(effortOref));
    };
```

- Publish the run list for the sheet's position: `useEffect(() => globalStore.set(briefRunListAtom, stageRun != null && stageRun.status === "done" ? shipped.rows.map((s) => s.oref.replace(/^run:/, "")) : view.sessionLines.flatMap((l) => (l.runOid ? [l.runOid] : []))), [stageRun, shipped, view.sessionLines]);`

- [ ] **Step 6: Behind you.** The region stops using `Region`'s `empty` (design L282-332 always draws both parts). Render:

```tsx
<section data-jarvis-brief-region="behind" className="flex flex-col gap-[9px]">
    <div className="flex items-center gap-[9px]">
        <span className={cn(REGION_LABEL, "text-ink-mid")}>Behind you</span>
        <span className="h-px min-w-3 flex-1 bg-edge-faint" />
        <span className={MONO_FAINT}>{sinceLabel(cursorTs, snapshot?.queryStartedAt ?? Date.now(), storedCursor == null)}</span>
        {deltaRowsN > 0 ? (
            <button
                type="button"
                onClick={() => {
                    const undo = markBriefingSeen();
                    briefUndo.notify("Marked seen", undo);
                }}
                className="cursor-pointer font-mono text-[10.5px] text-accent-soft hover:underline"
            >
                mark seen
            </button>
        ) : null}
    </div>
    <div className="flex flex-col">
        {deltaRowsN === 0 ? <div className="px-[11px] py-[7px] text-[12.5px] text-ink-mid">Nothing new since you last looked.</div> : null}
        {lines.behind.filter((g) => g.label !== SHIPPED_LABEL).map((g) => (
            <div key={g.label} className="flex flex-col">
                <div className="px-[11px] pb-0.5 pt-1.5 font-mono text-[10.5px] font-bold uppercase tracking-[.09em] text-muted">{g.label}</div>
                {g.lines.map((l) => (
                    <DeltaRowView key={l.id} line={l} focused={cursor === l.id} onOpen={l.target != null ? () => openLine(l.target) : undefined} />
                ))}
            </div>
        ))}
        <MoreControl n={deltaWindow.more} expanded={behindOpen} onToggle={() => toggleRegion("behind")} />
        <div className="flex items-center gap-2 px-[11px] pb-0.5 pt-3 font-mono text-[10.5px] font-bold uppercase tracking-[.09em] text-muted">
            <span>Shipped · 7 days</span>
            <span className="font-normal tracking-[.04em]">{shippedAll.length}</span>
        </div>
        {shippedAll.length === 0 ? <div className="px-[11px] py-[7px] text-[12.5px] text-ink-mid">Nothing shipped in the last seven days.</div> : null}
        {shippedLines.map((l) => (
            <ShippedRowView key={l.id} line={l} focused={cursor === l.id} selected={sheetOpen && stageRun != null && "run:" + stageRun.id === (l.target as { oref: string } | null)?.oref} onOpen={l.target != null ? () => openLine(l.target) : undefined} />
        ))}
        {shippedAll.length > SHIPPED_CAP && !filtering ? (
            <button type="button" onClick={() => setShippedOpen(!shippedOpen)} className="cursor-pointer self-start px-[11px] py-[7px] font-mono text-[10.5px] text-accent-soft hover:underline">
                {shippedOpen ? "show less" : `+${shippedAll.length - SHIPPED_CAP} more`}
            </button>
        ) : null}
    </div>
</section>
```

  with, above the JSX:
  - `const storedCursor = useAtomValue(briefingCursorAtom)`;
  - `const [shippedOpen, setShippedOpen] = useAtom(briefShippedOpenAtom)`, where `briefShippedOpenAtom = atom(false)` is declared at module scope beside `briefStaleOpenAtom`;
  - `shippedAll = model_?.shipped ?? []`;
  - `shipped = capRegion(shippedAll, SHIPPED_CAP, shippedOpen || filtering)`;
  - `deltaRowsN = lines.behind.filter((g) => g.label !== SHIPPED_LABEL).reduce((n, g) => n + g.lines.length, 0)`;
  - `shippedLines = lines.behind.find((g) => g.label === SHIPPED_LABEL)?.lines ?? []`.

  Drop `pastRows` and `pastMore`.

- [ ] **Step 7: Verify.** `task check:ts` passes. Run `npx vitest run frontend/app/view/jarvis/` and fix any test that asserted the old `Sessions` label or `LineRow` hooks, using the new `data-jarvis-brief-row` values: `queue`, `initiative`, `session`, `delta`, `shipped`. Seed data, then compare CDP shots of the default, Waiting-open and scrolled states with `cdp-shots/design/{default,waiting}.png`.
- [ ] **Step 8: Checkpoint.**

### Task 10: The expanded initiative card
**Depends on:** Task 7

**Files:**
- Modify: `frontend/app/view/jarvis/inlinetrackerview.tsx`

Change by change (design L135-247):

- [ ] **Step 1: Card chrome.**
  - The root `div` becomes `className="mb-3 rounded-b-[10px] border border-t-0 border-border bg-surface pb-2.5 pl-2.5 pr-3.5 pt-3"`.
  - Replace the `if (row.kind === "facts") { return null; }` branch with the summary line (design L136-140):

```tsx
                if (row.kind === "facts") {
                    const pct = row.total > 0 ? Math.round((row.done / row.total) * 100) : 0;
                    return (
                        <div key={row.id} className="flex flex-wrap items-center gap-x-3.5 gap-y-1.5 px-1.5 pb-1.5">
                            <ProgressBar pct={pct} tone={row.blocked > 0 ? "asking" : "success"} className="h-1.5 w-40 flex-none rounded-[3px]" />
                            <span className="text-[12px] text-secondary">
                                {row.done} of {row.total} done{row.blocked > 0 ? ` · ${row.blocked} blocked` : ""}
                            </span>
                            {row.next !== "" ? (
                                <span className="text-[12px] text-ink-mid">
                                    Next: <span className="text-ink-hi">{row.next}</span>
                                </span>
                            ) : null}
                        </div>
                    );
                }
```

- [ ] **Step 2: Stage header.**
  - The row class becomes `cn("relative flex items-center gap-2 border-t px-1.5 pb-1 pt-2.5", row.first ? "mt-0 border-transparent" : "mt-2 border-edge-faint")`.
  - The caret button text is `text-ink-mid`.
  - `<StageBar fraction={row.fraction} />` becomes `<StageBar done={row.done} total={row.total} />`, with:

```tsx
function StageBar({ done, total }: { done: number; total: number }) {
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    return (
        <span className="h-[3px] w-12 flex-none overflow-hidden rounded-sm bg-border">
            <span className="block h-full rounded-sm bg-success" style={{ width: `${pct}%` }} />
        </span>
    );
}
```

  - The fraction span is `text-ink-mid`.
  - The `⋯` button is `text-ink-mid hover:border-edge-mid hover:text-ink-hi`, with `menu === menuId ? "border-edge-strong" : "border-transparent"`.

- [ ] **Step 3: Chunk row** (design L164-173, model L1302-1303).
  - The label class becomes `cn("min-w-0 flex-1 truncate text-[12px] leading-[1.4]", selected ? "font-semibold text-primary" : row.row.status === "active" ? "font-medium text-ink-hi" : row.row.status === "done" || row.row.status === "skipped" ? "text-ink-mid" : "text-ink-hi", row.row.status === "skipped" && "line-through")`.
  - The notes count is `text-ink-mid`.
  - The pill's open border is `border-edge-strong`, and its hover is `hover:border-edge-mid`.
  - `TONE_FG` `skipped` and `pending` become `text-ink-mid`.
  - `MenuHead` becomes `text-ink-mid`.
  - `MenuItem`'s glyph span becomes `text-ink-mid`; the status glyphs keep their own tone class.

- [ ] **Step 4: Add chunk and New stage** (design L201-225, L1340-1345).
  - `AddChunkRow`'s button: `text-ink-mid hover:text-accent-soft`, with `<span className="w-3 text-center text-ink-mid">+</span>Add chunk`.
  - Its input placeholder is `stage ? `add to ${stage} · enter to add, esc to stop` : "chunk label · enter to add, esc to stop"`. Pass the stage in place of the current `placeholder` prop.
  - `AddChunkRow` also takes `initialDraft?: string | null` (start in adding mode when it is not `null`) and `autoOpen?: boolean`.
  - `NewStageRow` (design L1199): pressing Enter on the name no longer asks for the first chunk in the same input. It calls `onChange({ name, chunk: "" })`, and the parent renders a pending stage header below the last stage: the same markup as a stage header, label = name, `0/0`, no menu. Under it goes an `AddChunkRow` in adding mode, whose Enter calls `onAdd(name, label)` and resets `newStage` to `null`, and whose Escape resets it to `null`. The button text is `text-ink-mid`.

- [ ] **Step 5: Footer** (design L227-246).
  - The container class becomes `mt-3 flex flex-wrap items-center gap-x-2.5 gap-y-1.5 border-t border-edge-faint px-1.5 pt-2.5 font-mono text-[10.5px] text-ink-mid`.
  - The id button shows `edits.oid.slice(0, 8)` and copies the full `edits.oid`.
  - `SMALL_BUTTON` becomes `cursor-pointer rounded-[6px] border border-border px-2 py-[3px] font-mono text-[10.5px] text-ink-mid hover:border-edge-strong hover:text-ink-hi`.
  - The confirm text is `font-sans text-[11.5px] text-error-soft`.
  - Its cancel button is `cursor-pointer rounded-[5px] border border-edge-mid bg-surface-raised px-2 py-0.5 font-mono text-[10.5px] text-secondary hover:text-primary`.

- [ ] **Step 6: Verify.** `task check:ts` passes. Compare CDP shots with the seeded "Scenario gate clearance" expanded against `cdp-shots/design/default.png`, and with its status menu open against `menu.png`, stage menu `stagemenu.png`, delete confirm `confirm.png`. Check that Phase 1 (2/2 done) starts folded and that the stage bars fill.
- [ ] **Step 7: Checkpoint.**

### Task 11: Chunk sidebar
**Depends on:** Task 9

**Files:**
- Modify: `frontend/app/view/jarvis/chunksidebar.tsx`
- Create: `frontend/app/view/jarvis/runreportview.tsx`
- Modify: `frontend/app/view/jarvis/briefsurface.tsx` (the `ChunkSidebar` props: `expanded` becomes a `Set<string>`, and it gains `model`)

**Interfaces:**
- Consumes: `sidebarNotes` / `NoteCard` (Task 6), `parseRunReport` (Task 6).
- Produces: `RunReportView({ run, compact }: { run: Run; compact?: boolean })`, which the run sheet also uses (Task 12).

- [ ] **Step 1: `runreportview.tsx`** (design L508-537)

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// A finished run's report, structured (design L508-537): the lead line, then each section with its count,
// a commit hash that opens its diff, and the task tag. "raw markdown" shows the file as filed.

import { openDiff, runDiffScope } from "@/app/view/agents/agentdiffnav";
import type { AgentsViewModel } from "@/app/view/agents/agents";
import { cn } from "@/util/util";
import { useState } from "react";
import { briefUndo } from "./briefundo";
import { parseRunReport, type ReportItem } from "./runreport";

const EYEBROW = "font-mono text-[9.5px] font-bold uppercase tracking-[.13em] text-ink-mid";
const LINK = "cursor-pointer font-mono text-[10.5px] text-accent-soft hover:text-accent";
const DOT: Record<ReportItem["dot"], string> = {
    ok: "bg-success",
    warn: "bg-asking",
    accent: "bg-accent-soft",
    faint: "bg-edge-strong",
    muted: "bg-ink-mid",
};

export function RunReportView({ model, run, compact }: { model: AgentsViewModel; run: Run; compact?: boolean }) {
    const [raw, setRaw] = useState(false);
    const report = parseRunReport(run.report ?? "");
    if (report == null) {
        return null;
    }
    return (
        <div data-jarvis-run-report className={cn("flex flex-col", compact ? "gap-2.5" : "gap-3.5 pt-4")}>
            <div className="flex items-center gap-2.5">
                <span className={EYEBROW}>run report</span>
                <span className="min-w-0 truncate font-mono text-[10.5px] text-muted">{report.title}</span>
                <span className="flex-1" />
                <button type="button" onClick={() => setRaw(!raw)} className={cn(LINK, "flex-none")}>
                    {raw ? "structured" : "raw markdown"}
                </button>
                <button
                    type="button"
                    onClick={() => {
                        void navigator.clipboard?.writeText(run.report ?? "");
                        briefUndo.notify("Copied the run report");
                    }}
                    className={cn(LINK, "flex-none")}
                >
                    copy
                </button>
            </div>
            {report.lead !== "" ? <div className="break-words font-mono text-[11px] leading-[1.55] text-secondary">{report.lead}</div> : null}
            {raw ? (
                <pre className="m-0 max-h-[420px] overflow-auto whitespace-pre-wrap break-words rounded-[8px] border border-border bg-surface px-[13px] py-3 font-mono text-[11px] leading-[1.6] text-secondary">
                    {run.report}
                </pre>
            ) : (
                <>
                    {report.sections.map((sec) => (
                        <div key={sec.heading} className="flex flex-col gap-0.5">
                            <div className="flex items-center gap-2 pb-1">
                                <span className={EYEBROW}>{sec.heading}</span>
                                <span className="font-mono text-[10.5px] text-muted">{sec.count}</span>
                            </div>
                            {sec.items.map((it, n) => (
                                <div key={n} className="flex items-baseline gap-2.5 border-b border-edge-faint py-[7px]">
                                    <span className={cn("h-1.5 w-1.5 flex-none -translate-y-px rounded-full", DOT[it.dot])} />
                                    {it.hash !== "" ? (
                                        <button
                                            type="button"
                                            title="Open this commit's diff"
                                            onClick={() => openDiff(model, runDiffScope(run.id, run.projectpath, run.basecommit))}
                                            className="w-16 flex-none cursor-pointer text-left font-mono text-[11px] text-accent-soft hover:underline"
                                        >
                                            {it.hash}
                                        </button>
                                    ) : null}
                                    <span className={cn("min-w-0 flex-1 text-pretty break-words text-[12.5px] leading-[1.5]", it.dim ? "text-ink-mid" : "text-ink-hi")}>
                                        {it.text}
                                    </span>
                                    {it.tag !== "" ? (
                                        <span className="flex-none rounded-[5px] border border-edge-mid px-[5px] font-mono text-[10px] leading-4 text-ink-mid">{it.tag}</span>
                                    ) : null}
                                </div>
                            ))}
                        </div>
                    ))}
                    <button type="button" onClick={() => openDiff(model, runDiffScope(run.id, run.projectpath, run.basecommit))} className={cn(LINK, "self-start")}>
                        open the repository diff ↗
                    </button>
                </>
            )}
        </div>
    );
}
```

- [ ] **Step 2: Sidebar changes** (design L336-410, model L1477-1546)
  - Header:
    - the position reads `{position.n} / {position.total}`;
    - `NAV_BUTTON` drops `disabled:opacity-40` and colours its arrow `onPrev == null ? "text-feed-glyph" : "text-secondary"` (and the same for next), using the design's colour swap (`prevFg`/`nextFg`) instead of opacity;
    - the `j / k` hint and the Close button use `text-ink-mid`.
  - Title block:
    - the breadcrumb is `flex flex-wrap items-center gap-[7px] font-mono text-[10.5px] uppercase tracking-[.06em] text-ink-mid`; its two spans lose `truncate`, and the `/` is `text-feed-glyph`;
    - "initiative activity ↗" moves out of the breadcrumb onto the handle line: `<div className="flex items-center gap-2.5"><button …handle… className="min-w-0 truncate …">{handle} ⧉</button><button onClick={onActivity} className="flex-none font-mono text-[10.5px] text-accent-soft hover:underline">activity ↗</button></div>`, and the handle gets `title={handle}`.
  - Status chips: an unselected chip's glyph and label are `text-ink-mid` (not `text-muted`).
  - Notes heading: `<span className="font-normal tracking-[.04em] text-muted">{cards.length} {cards.length === 1 ? "note" : "notes"}</span>`.
  - Cards: replace the `notes`/`feedRows` derivation with `const cards = sidebarNotes(feed, label, now, expanded);`. `expanded` becomes a `Set<string>` of card keys, with `onToggle(key)` replacing `onExpand`. In `briefsurface.tsx`, `readingNoteAtom` becomes `atom<Set<string>>(new Set())`: keep its name, change its type, and update the two `setReadingNote(null)` calls to `setReadingNote(new Set())` and `activateCursor`'s `setReadingNote(0)` to `setReadingNote(new Set())`, since the newest short note already opens by default. `frontend/app/store/keybindings/bindings.ts:547-548` (Escape backs out one rung) becomes `if (globalStore.get(readingNoteAtom).size > 0) { globalStore.set(readingNoteAtom, new Set()); …`, and `jarvisstore.ts:30` becomes `atom<Set<string>>(new Set<string>()) as PrimitiveAtom<Set<string>>`. Each card renders:

```tsx
<div key={c.key} data-jarvis-note-card={c.key} className={cn("rounded-[8px] border bg-surface", isEditing ? "border-accent/45" : "border-border")}>
    <button type="button" onClick={() => !isEditing && onToggle(c.key)} className={cn("flex w-full cursor-pointer flex-col gap-[5px] rounded-[8px] px-[11px] py-[9px] text-left hover:bg-lane", FOCUS)}>
        <span className="flex w-full items-center gap-[7px] font-mono text-[10.5px] text-ink-mid">
            {c.who !== "" ? <span className={c.who === "you" ? "text-accent-soft" : "text-success"}>{c.who}</span> : null}
            <span>{c.day}{c.edited ? " · edited" : ""}</span>
            <span className="ml-auto text-muted">{c.chev}</span>
        </span>
        {isEditing ? null : (
            <span className={cn("whitespace-pre-wrap break-words text-[12.5px] leading-[1.6] text-secondary", !c.open && "line-clamp-3")}>{c.text}</span>
        )}
    </button>
    {c.open && c.runOid !== "" && !isEditing ? (
        <div className="border-t border-edge-faint px-[11px] py-2.5">
            <NoteRun model={model} runOid={c.runOid} />
        </div>
    ) : null}
    {/* the existing editing block, unchanged */}
    {!isEditing && c.open && c.editable ? (/* the existing edit / delete row */) : null}
    {!isEditing && c.open && c.who === "agent" && (c.sessionTab !== "" || c.runOid !== "") ? (
        <div className="flex gap-3 border-t border-edge-faint px-[11px] py-1.5">
            <button type="button" onClick={() => onOpenSession(c)} className={cn("cursor-pointer font-mono text-[10.5px] text-accent-soft hover:underline", FOCUS)}>
                {c.sessionTab !== "" ? "open agent session ↗" : "open run ↗"}
            </button>
        </div>
    ) : null}
</div>
```

  where

```tsx
const NO_RUN = atom<Run | undefined>(undefined);
// the report a finished run left on this chunk (Task 2): the structured report when the lead filed one,
// else the sealed summary
function NoteRun({ model, runOid }: { model: AgentsViewModel; runOid: string }) {
    const run = useAtomValue((runOid ? runAtom(runOid) : NO_RUN) as Atom<Run | undefined>);
    if (run == null) {
        return <span className="text-[11.5px] text-muted">Loading the run…</span>;
    }
    if ((run.report ?? "").trim() !== "") {
        return <RunReportView model={model} run={run} compact />;
    }
    return <p className="m-0 text-[12px] leading-[1.55] text-secondary">{run.evidence?.summary || "The run finished without a report."}</p>;
}
```

  and `onOpenSession(c)` in `briefsurface.tsx`:
  - `c.sessionTab !== ""` → `openTarget(model, { kind: "agent", tabId: c.sessionTab })`, which toasts if the tab has left the roster;
  - otherwise → `openAddress(model, "run:" + c.runOid)`.

  Add `model` to the sidebar props.
  - Composer: the Add note button's disabled state is `disabled:bg-border disabled:text-muted` (design `addBg #1c2128`, `addFg #7f858b`).

- [ ] **Step 3: Verify.** `task check:ts` passes, and `npx vitest run frontend/app/view/jarvis/` passes. Compare a CDP shot with "N1 box upgrade" selected against `cdp-shots/design/sidebar.png`: the header reads `3 / 6`, the breadcrumb is not truncated, the card shows "agent · …" or "you · …" for new notes, and the newest short note starts open. For the report path, run a quick run attached to a seeded chunk:

```bash
wsh effort chunk attach <oid> "Rollback drill" --run run:<runid>
```

Use a throwaway run started from the dev app. Let it finish, then check that the chunk shows "Run finished: …" with the report or summary under it.
- [ ] **Step 4: Checkpoint.**

### Task 12: Run sheet
**Depends on:** Task 11

**Files:**
- Modify: `frontend/app/view/jarvis/briefsheet.tsx` (`SheetShell` header actions: position + ↑/↓)
- Modify: `frontend/app/view/jarvis/briefrunsheet.tsx` (`SheetShell` header, `LoadedConfig` gains `inline`)
- Modify: `frontend/app/view/jarvis/runsheet.tsx` (`Reading`, `RunSheetFrame`, `Evidence`, `Dock`)
- Modify: `frontend/app/view/jarvis/briefsurface.tsx` (`BriefComposer` moves into the sheet, and j/k on an open run sheet)

**Interfaces:**
- Consumes:
  - `briefRunListAtom` and `briefEffortIndexAtom` (Task 9);
  - `RunReportView` (Task 11);
  - `SteerComposer` / `resolveBriefComposerTarget` (existing): export `SteerComposer` from `briefsurface.tsx`, or better, move it to `briefcomposer.tsx`.

- [ ] **Step 1: Header** (design L415-427).
  - `SheetShell`'s header container becomes `px-4 py-2.5`, and the label eyebrow `font-mono text-[9.5px] font-bold uppercase tracking-[.13em] text-accent-soft`.
  - In `BriefSheet`, the `actions` for a run face become the position counter, the two arrows, then the existing New run button:

```tsx
<>
    {pos.total > 0 ? <span className="font-mono text-[10.5px] text-muted">{pos.n} / {pos.total}</span> : null}
    <div className="flex gap-1">
        <button type="button" aria-label="Previous run" title="Previous run (k)" onClick={() => pos.prev && openAddress(model, "run:" + pos.prev)} className={cn("h-[22px] w-6 cursor-pointer rounded-[6px] border border-border bg-surface-raised text-[11px] hover:border-edge-strong", pos.prev ? "text-secondary" : "text-feed-glyph")}>↑</button>
        <button type="button" aria-label="Next run" title="Next run (j)" onClick={() => pos.next && openAddress(model, "run:" + pos.next)} className={cn("h-[22px] w-6 cursor-pointer rounded-[6px] border border-border bg-surface-raised text-[11px] hover:border-edge-strong", pos.next ? "text-secondary" : "text-feed-glyph")}>↓</button>
    </div>
    {/* the existing New run button */}
</>
```

  with

```ts
const list = useAtomValue(briefRunListAtom);
const at = run != null ? list.indexOf(run.id) : -1;
const pos = { n: at + 1, total: at >= 0 ? list.length : 0, prev: at > 0 ? list[at - 1] : null, next: at >= 0 && at < list.length - 1 ? list[at + 1] : null };
```

  - j/k: in `briefsurface.tsx`, when `sheetOpen` and the sheet shows a run, `useSurfaceListNav` gets `navigableIds` = the run lines of the published list (`sessions:*` lines whose `runOid` is in `briefRunListAtom`, or the shipped lines when the list is the shipped one). `setCursor` for such an id also calls `openLine(line.target)`. j/k therefore steps the sheet through runs exactly as the design does (design L1830), using the Brief's one cursor.

- [ ] **Step 2: Reading** (design L429-459).
  - The meta row renders `status.meta` (the tones stay; `muted` maps to `text-ink-mid`, per the Global Constraints table), then `<RunSettingsPanel run={run} inline />`.
  - `LoadedConfig` gets `inline?: boolean`. With `inline`, it renders:
    - (a) when `note != null` (settings fixed or unavailable): a single span, `lead ${run.runtime || "claude"}/${run.model || "default"}` for an orchestrator or `${run.runtime || "claude"}/${run.model || "default"}` for a quick run, in `font-mono text-[10.5px] text-ink-mid`;
    - (b) when editable: spans for `lead …`, `${draft.parallelism} workers` (when greater than 0) and `draft.workerRoute == null ? "workers inherit the lead" : `workers on ${routeLabel(draft.workerRoute)}``, then a button `adjust`/`done` (`font-mono text-[10.5px] text-accent-soft hover:text-accent`, `aria-expanded`). When open, the existing panel (explainer, the two fields, Save settings / Save as project defaults, error, notice) renders as a sibling block below the meta row, inside `rounded-[9px] border border-border bg-surface px-[13px] pb-[13px] pt-[11px]`. `configLine` is not printed inline; the spans replace it.
  - Live cost: append `$${cost.toFixed(2)}` to the meta row when `cost > 0`, where `cost = liveWorkers(run, agents).reduce((s, a) => s + (a.usage?.costusd ?? 0), 0)` (design L1401 prints the run's cost).
  - The footer no longer renders `<RunSettingsPanel run={run} />`; the reading holds it now.
  - After the goal: when `run.effortref != null && index.get(run.effortref.effortoid) != null`, render `<button type="button" title="Open this chunk" onClick={() => revealChunkFromSheet(effort.oref, run.effortref.chunklabel)} className="max-w-full self-start truncate font-mono text-[10.5px] text-ink-mid hover:text-accent-soft">↳ {effort.title} · {stage || "unstaged"} · {run.effortref.chunklabel}</button>`. `revealChunkFromSheet` is `revealChunk` from Task 9: publish it through a `briefRevealChunkAtom` (a `(oref, chunk) => void` set by `briefsurface.tsx`), the same pattern as `chunkMoveAtom`.

- [ ] **Step 3: Body for a finished run.** In `RunSheetFrame`, `showEvidence` renders `(run.report ?? "").trim() !== "" ? <RunReportView model={ctx.model} run={run} /> : <Evidence ctx={ctx} dag={dag} />` (design L508 vs L539). `Evidence`'s eyebrows use `text-ink-mid`, and its summary `p` drops `line-clamp-4` and gets `text-pretty text-secondary` (design L557).

- [ ] **Step 4: Footer** (design L571-587). The dock stays as it is: Save as project defaults, Open DAG, Open lead ↗, Cancel run. For a live quick run with a worker, add `Open in Agent ↗`: `run.mode !== "orchestrator" && !isTerminal(run.status) && leadWorker(run, agents) != null` → `jumpToAgent`.

  Below the dock, render the composer when `resolveBriefComposerTarget` gives a target. Remove `<BriefComposer model={model} />` from `BriefSurface`, and `paddingBottom: composerHeight` from `BriefSheet`. The restyled composer:

```tsx
<div className="flex flex-col gap-1.5 border-t border-edge-faint px-4 pb-3 pt-2.5">
    <div className="flex items-center gap-2 font-mono text-[10.5px]">
        <span className="text-success">{run.mode === "orchestrator" ? "lead" : target.workerName}</span>
        <span className="text-muted">scoped to this session</span>
        {labels.alt != null ? <span className="ml-auto text-muted">{labels.alt}</span> : null}
    </div>
    <div className="flex items-end gap-2 rounded-[8px] border border-edge-mid bg-background py-[7px] pl-2.5 pr-[7px] focus-within:border-edge-strong">
        <textarea
            data-jarvis-brief-composer="input"
            rows={2}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKey}
            placeholder={run.mode === "orchestrator" ? "Message the lead of this session" : "Message the worker on this run"}
            aria-label="Message this session"
            className="min-w-0 flex-1 resize-none bg-transparent text-[12.5px] leading-[1.55] text-primary outline-none placeholder:text-muted"
        />
        <button
            type="button"
            data-jarvis-brief-composer="send"
            onClick={submit}
            disabled={!canSend}
            className={cn("flex-none rounded-[6px] px-[11px] py-[5px] text-[11px] font-bold", canSend ? "cursor-pointer bg-accent text-background" : "bg-border text-muted")}
        >
            Send ⏎
        </button>
    </div>
    {status != null ? <span data-jarvis-brief-composer="status" aria-live="polite" className={cn("text-[11.5px]", status.tone === "ok" ? "text-success" : "text-error")}>{status.text}</span> : null}
</div>
```

  `onKey` keeps its current logic, adapted to a `textarea`: Enter without Shift sends, and Shift+Enter adds the standing rule. Escape stops propagation and closes the sheet (design L1473).

  A **finished** run gets no composer. The design's "Ask about this run" is the Ask audience retired on 2026-09-23 (`docs/deferred.md`); record that in the parity notes (Task 14), don't rebuild it.

- [ ] **Step 5: Verify.** `task check:ts` passes. Compare CDP shots of a live orchestrator run, an asking run, a finished run with a report, and a finished quick run with the design states `runorch`, `runask`, `rundone` and `runquickdone`. j/k with the sheet open moves to the next run and the counter follows.
- [ ] **Step 6: Checkpoint.**

### Task 13: Modals — New initiative, New run, Profile
**Depends on:** Task 8

**Files:**
- Modify: `frontend/app/view/jarvis/effortcreateform.tsx`
- Modify: `frontend/app/view/jarvis/newruncontrol.tsx`
- Modify: `frontend/app/view/agents/runlauncher.tsx` (`ShapeCards`, `ParallelismStepper`, `EYEBROW`)
- Modify: `frontend/app/view/jarvis/briefprofileview.tsx`
- Create: `frontend/app/view/jarvis/projectchips.tsx`

**Interfaces:**
- Produces: `ProjectChips({ names, picked, recent, onPick, columns }: { names: string[]; picked: string | null; recent: string | null; onPick: (name: string) => void; columns: 1 | 2 })`, the design's project chips (design L613, L864). It shows the recent pick plus the first ranked names up to 4, and a `Search…` input that filters the full list when there are more than 4.

- [ ] **Step 1: `projectchips.tsx`**

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The design's project chips (design L864: a two-column grid with "last used"; L796: a wrapping row). The
// design shows four projects; a registry of a hundred cannot be four chips, so the last-used project and
// the next three ranked names are chips, and a search box reaches the rest.

import { cn } from "@/util/util";
import { useState } from "react";
import { rankProjects } from "./newrun";

const CHIP_COUNT = 4;

export function ProjectChips({
    names,
    picked,
    recent,
    onPick,
    columns,
}: {
    names: string[];
    picked: string | null;
    recent: string | null;
    onPick: (name: string) => void;
    columns: 1 | 2;
}) {
    const [query, setQuery] = useState("");
    const ranked = rankProjects(names, query);
    const head = query.trim() === "" ? [...new Set([recent, picked, ...ranked].filter((n): n is string => n != null && names.includes(n)))].slice(0, CHIP_COUNT) : ranked.slice(0, 8);
    return (
        <div className="flex flex-col gap-1.5">
            <div className={cn(columns === 2 ? "grid grid-cols-2 gap-1.5" : "flex flex-wrap gap-1.5")}>
                {head.map((name) => {
                    const on = name === picked;
                    return (
                        <button
                            key={name}
                            type="button"
                            aria-pressed={on}
                            onClick={() => onPick(name)}
                            className={cn(
                                "flex cursor-pointer items-center gap-2 rounded-[7px] border text-left text-[12px] font-medium hover:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                                columns === 2 ? "px-2.5 py-[7px]" : "px-2.5 py-[5px]",
                                on ? "border-accent/40 bg-accentbg text-accent-soft" : "border-border bg-surface-raised text-ink-mid"
                            )}
                        >
                            {columns === 2 ? <span className={cn("h-[7px] w-[7px] flex-none rounded-[2px]", name === recent ? "bg-asking" : "bg-success")} /> : null}
                            <span className="min-w-0 flex-1 truncate">{name}</span>
                            {columns === 2 && name === recent ? <span className="flex-none font-mono text-[10.5px] text-muted">last used</span> : null}
                        </button>
                    );
                })}
            </div>
            {names.length > CHIP_COUNT ? (
                <input
                    value={query}
                    aria-label="Search projects"
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder={`Search ${names.length} projects…`}
                    className="w-full rounded-[7px] border border-edge-mid bg-background px-2.5 py-1.5 text-[12px] text-primary outline-none placeholder:text-muted focus:border-accent/60"
                />
            ) : null}
        </div>
    );
}
```

- [ ] **Step 2: New initiative** (design L778-849).
  - The modal is `w-[min(580px,93vw)]`, centred at the top (`align` as today).
  - The header hint reads `ctrl+⏎ to save` (not `⌘⏎`), in `text-ink-mid`.
  - `fieldLabel` becomes `font-mono text-[10.5px] font-bold uppercase tracking-[.09em] text-ink-mid`.
  - Title placeholder: `e.g. Scenario gate clearance`. On an empty submit, show the error `Title is required` and give the title input `border-error/60`.
  - Project: `<ProjectChips names={Object.keys(projects ?? {})} picked={project || null} recent={null} onPick={setProject} columns={1} />`. Keep a free-text fallback: the Search input doubles as the value when nothing matches. When `ranked` is empty and the query is non-empty, show a chip `Use "<query>"` that calls `onPick(query)`.
  - Ticket and Parent initiative sit in a two-column grid (design L800-809). Their placeholders are `optional` and `optional · effort id`, and both inputs are `font-mono text-[12px]`.
  - Chunks:
    - the label is `Chunks · one per line` plus the hint `Stage: chunk to group` (`font-mono text-[10.5px] text-muted`);
    - the textarea is `min-h-[110px]`;
    - the summary line reads `dupes ? "duplicate chunk labels" : `${lines.length} chunks · ${stages} stage${stages === 1 ? "" : "s"} · ${ticked} done`` (error tone for dupes), then `<span className="flex-1" /><span …muted>tick what's already done</span>`;
    - the preview box is `max-h-[170px] rounded-[7px] border border-edge-faint bg-surface px-2 py-1.5`, and stage headers are `font-mono text-[10.5px] font-bold uppercase tracking-[.08em] text-ink-mid`, including an `unstaged` header when a staged run is followed by unstaged lines (design L1672);
    - each line is a **button** (design L827-831) with a 13px box: `flex h-[13px] w-[13px] items-center justify-center rounded-[3px] border text-[10px] font-bold text-background`, which is `border-success bg-success` with ✓ when ticked and `border-edge-strong` when not, followed by the label (`truncate font-mono text-[11.5px]`, ticked → `text-ink-mid line-through`) and a `duplicate` tag (`text-error`) on a dupe.
  - Footer: `edit ? "changes apply immediately" : "ticked lines save as already done"` (`text-ink-mid`). The primary button reads `edit ? "Save changes" : "Create initiative"`; disabled uses `bg-border text-muted`, not opacity.
  - On success, `briefUndo.notify(edit ? "Initiative updated" : `Created “${title}” · ${lines.length} chunks`)` (design L1240, L1248).

- [ ] **Step 3: New run** (design L851-896).
  - The modal is `w-[min(640px,94vw)]`, and its hint reads `ctrl+⏎ to start`.
  - Project: `<ProjectChips names={entries.map(([n]) => n)} picked={picked} recent={globalStore.get(lastPickedProjectAtom)} onPick={select} columns={2} />`. This replaces the search input and the row list; keep `onSearchKey`'s arrow and Enter behaviour on the chips' search input by passing an `onKeyDown` prop through.
  - Shape (design L869-883): `ShapeCards` in `runlauncher.tsx` becomes compact segments, `flex items-center gap-1.5`. Each card is `flex flex-col items-start gap-0.5 rounded-[7px] border px-[11px] py-[7px] text-left` with the name `text-[12px] font-semibold` and the description `text-[10.5px] text-ink-mid`. The description is `one agent, one goal` for quick and `lead plans, workers fan out` for orchestrator: change `SHAPE_CARDS[].desc` in `runconfig.ts`. Card names keep their ids (`quick` / `orchestrator`). When the shape is orchestrator, `ParallelismStepper` renders **inline to the right** (`ml-auto flex items-center gap-1.5`: a `workers` label, a 24px `−`, the count, a 24px `+`), not as its own section.
  - `StartSection` and `RoutingSection` stay (app features), restyled: `EYEBROW` becomes `font-mono text-[10.5px] font-bold uppercase tracking-[.09em] text-ink-mid`.
  - Goal: a textarea with `rows={3}` and `focus:border-accent/60`.
  - Footer hint: `picked == null ? "pick a project" : blocker ?? `${shape}${shape === "orchestrator" ? " × " + parallelism : ""} in ${picked}``. The design says "Write the goal" when the goal is empty; `launchBlocker` already returns that. Check it and align the wording to `Write the goal`.
  - Start run disabled: `bg-border text-muted`.

- [ ] **Step 4: Profile** (design L898-969).
  - Header:
    - `Profile` (`flex-1 text-[15px] font-semibold text-primary`);
    - a segmented scope control on the right (`flex rounded-[7px] border border-edge-mid p-0.5`) with two buttons, the project label and `global`, each `rounded-[5px] px-2.5 py-[3px] font-mono text-[10.5px] font-semibold`: selected `bg-accentbg text-accent-soft`, otherwise `text-ink-mid`;
    - the Close button leaves the header; the footer has Cancel instead.
  - Project scope keeps the project `<select>`: when there is more than one project, render it under the header as `ProjectChips` with `columns={1}`.
  - **Run defaults** (the `LABEL` becomes `font-mono text-[10.5px] font-bold uppercase tracking-[.09em] text-ink-mid`), in a grid of `grid-cols-[110px_minmax(0,1fr)] items-center gap-2.5`:
    - `Default shape` → two segments `quick`/`orchestrator` (`rounded-[6px] border px-2.5 py-1 font-mono text-[10.5px]`);
    - `Parallel workers` → a − n + stepper (24px buttons);
    - `Lead route` → `RoutePicker` (project scope only);
    - `Worker route` → `RoutePicker`;
    - `Autonomy` → the existing `<AutonomyLadder channels={channels} />` chip and popover, which holds per-project tier and dispatch mode (project scope only).
    - Inherit / reset badges keep their meaning. Render the badge and `reset` inline after each control as `font-mono text-[10px]`.
  - **Principles** (design L927-960): the header `Principles` plus a meta line, `global set, with this project's changes` (project) or `every project inherits these` (global). `PrinciplesEditor` / `GlobalPrinciplesEditor` restyle to the design's cards:
    - each card is `rounded-[7px] border border-edge-mid bg-surface px-2.5 py-2`;
    - the badge is `rounded-[4px] border px-1.5 py-px font-mono text-[10.5px] font-semibold uppercase tracking-[.08em]`: global `border-edge-mid text-ink-mid`, modified `bg-asking/10 text-asking`, project `bg-accent/8 text-accent-soft`;
    - actions are `text-[10.5px]` (`override` accent-soft, `disable`/`reset` ink-mid, `delete` ink-mid hover error);
    - an editable text is a textarea with `rows={2}`;
    - `original · …` renders under a modified card;
    - `+ add principle` is a dashed full-width button;
    - the `Disabled · N` box lists struck-through text with `re-enable`.
  - Footer: `dirty ? "unsaved changes · applies to future runs" : "no changes"` (`text-asking` when dirty, else `text-muted`), a Cancel button (closes), and `Save profile` (`bg-accent text-background` when dirty, else `bg-border text-muted`). Save closes the modal and toasts `Profile saved for ${scope label} · applies to future runs` (design L1734).

- [ ] **Step 5: Verify.** `task check:ts` passes, and `npx vitest run frontend/app/view/` passes (update `runconfig`/`newrun` tests whose expectations named the old shape descriptions). Compare CDP shots of all three modals with `modalinit.png`, `modalrun.png` and `modalprofile.png`.
- [ ] **Step 6: Checkpoint.**

## Phase 4 — Verification and wrap-up

### Task 14: Design-state renderer, seed script, parity scenario, docs
**Depends on:** Task 10, Task 12, Task 13

**Files:**
- Create: `scripts/cdp/design-states.mjs`: renders the design's states headlessly into `cdp-shots/design/`. It copies `docs/prototype/jarvis-brief-editing.dc.html` and `support.js` to a temp dir, replaces the `<dc-import name="Window Shell" …>` wrapper with a plain `div` (the shell is a separate design file), and injects each state by appending overrides before the state object's closing `};` (anchor: `recSel: null, recPicker: false, recPending: null,\n  };`). It serves the dir with `node:http` and shoots with Chrome `--headless=new --window-size=1440,900 --virtual-time-budget=9000 --screenshot=<abs path>`, **sequentially**: parallel Chrome runs collide on the profile and write identical PNGs. The states:
  - `default: ""`
  - `waiting: 'openInit: null, waitingOpen: true,'`
  - `sidebar: 'sel: { iid: "i1", cid: "crx" },'`
  - `menu: 'menu: "crx",'`
  - `stagemenu: 'menu: "stage:i1|Phase 2 · upgrade",'`
  - `confirm: 'confirmDel: "i1",'`
  - `runorch: 'openInit: null, runSel: "s2",'`
  - `runask: 'openInit: null, runSel: "s3",'`
  - `rundone: 'openInit: null, runSel: "s5",'`
  - `runquickdone: 'openInit: null, runSel: "s4",'`
  - `modalinit: 'modal: "initiative",'`
  - `modalrun: 'modal: "run",'`
  - `modalprofile: 'modal: "profile",'`
  - `record: 'openInit: null, recSel: "dos-221",'`
- Create: `scripts/cdp/seed-brief.mjs`: seeds the design's three initiatives into the dev store over CDP (`attach()` from `./attach.mjs`, `h.rpc("effortlist" | "effortcreate" | "effortmutate", …)`), skipping titles that already exist. Data: design `seed()` L986-1009; notes are appended oldest first.
- Modify: `scripts/cdp/scenarios.mjs`: add the `brief-design-parity` scenario.
- Modify: `docs/keyboard-shortcuts.md`: j/k steps runs while a run sheet is open.
- Modify: `docs/superpowers/specs/2026-09-23-jarvis-brief-editing-design.md`: one line under "Out of scope", pointing at this plan for the parity work.

- [ ] **Step 1: Write the scripts.** Both are 4-space `.mjs`, hand-formatted, and never run through prettier.
- [ ] **Step 2: The `brief-design-parity` scenario** asserts, against seeded data:
  - (a) region labels read `WAITING ON YOU`, `INITIATIVES`, `RUNS`, `BEHIND YOU`;
  - (b) header order is filter → tier → Profile → + Initiative → + Run, and the fleet line sits before the filter;
  - (c) the expanded "Scenario gate clearance" shows `2 of 6 done · 1 blocked`, `Next: N1 box upgrade`, and a stage fraction matching `/^\d+\/\d+$/`;
  - (d) the footer id is 8 characters;
  - (e) a Runs row has a `[data-jarvis-brief-row="session"]` with a type badge whose text is one of `quick run`, `orchestrator` or `agent`;
  - (f) Behind you's meta matches `/^since |^the last 7 days$/`;
  - (g) the Chunk sidebar position matches `/^\d+ \/ \d+$/`.
  
  Each check is its own step and records a shot.
- [ ] **Step 3: Full verification.**

```bash
npx vitest run frontend/app/view/
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit
go test ./pkg/jarvis/... ./pkg/jarvisstate/... ./pkg/wshrpc/... ./cmd/wsh/...
go vet ./pkg/jarvis/... ./pkg/jarvisstate/... ./pkg/wshrpc/... ./cmd/wsh/...
node scripts/cdp/design-states.mjs
```

  After the run, on the merged branch with the dev app restarted, the owner runs:

```bash
node scripts/cdp/seed-brief.mjs
task verify:ui -- brief-design-parity brief-inline-tracker brief-surface brief-profile
```

  Expected: all pass. brief-surface and brief-profile may have been failing before this work (the recall-arm run report recorded failures there with no baseline). Run them on `main` first and record the baseline in the parity notes, so a failure you did not cause is not attributed to this work.
- [ ] **Step 4 (owner, after the run): Side-by-side review.** For every design state, put `cdp-shots/design/<state>.png` beside the app's shot of the same state and list every remaining difference in `docs/superpowers/plans/2026-09-23-jarvis-brief-design-parity.md` under a final `## Parity notes` heading. Only data-driven differences may remain: real project names and counts, a run's real route, "no cost reported". Record the one deliberate omission, "Ask about this run" (retired 2026-09-23), there too.
- [ ] **Step 5: Formatting on touched files only.**

```bash
npx prettier --check <touched .ts/.tsx>
npx eslint <touched .ts/.tsx>
gofmt -l <touched .go>
```

- [ ] **Step 6: Commit** on the lane branch. The owner's commit gate follows the run: show the file list with M/A/D status and a summary. Propose the commit message `feat(jarvis): draw the Brief to its design, with authored notes and run reports on chunks`, and ask for approval before committing. This plan folds into that one feature commit.
