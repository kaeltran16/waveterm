# Brainstorm board: show what the agent is doing — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** While the brainstorm agent is in a turn, the Working view shows its live step, the turn's elapsed time and a
thumbnail of each board written this turn; the design view's working note shows the same step line.

**Architecture:** A pure model (`brainstormworking.ts`) reads the agent's live transcript entries (`entriesAtomFor`)
for this turn's latest action and the boards it wrote. The brainstorm poller reads each such board's canvas.json
(sizes) into a new `BrainstormState.turn` field, serving the design folder on the first board. `WorkingMain` and the
design note draw the step line from the model; the boards reuse `Thumbnails`. No Go change.

**Tech Stack:** React 19, jotai, Tailwind 4, vitest; CDP scenario in `scripts/cdp`.

**Spec:** `docs/superpowers/specs/2026-11-10-brainstorm-working-visibility-design.md`
**Verify:** `node scripts/verify.mjs ./pkg/waveobj`
**Check:** `task check:ts`
**Final:** `node scripts/cdp/final-verify.mjs brainstorm-working brainstorm-mode brainstorm-judged-question brainstorm-builder-check`
**Prototype:** C:\Users\kael02\IdeaProjects\waveterm\.superpowers\design\brainstorm-working-visibility\project\Main.dc.html

## Decisions beyond the design (and why)

- **D1. The step line comes from the transcript entries, not `AgentVM.activity` / `detailForTool`.** The step is the
  latest `action` entry of this turn (pending ones included: a running command is the current step). Entries carry
  verb and target apart, in the timeline's vocabulary, for every tool and every harness projector; `activity` is one
  string with a bare tool name for most tools. One source for both the step and the boards, and no Go change.
- **D2. The verb is the timeline's word** (`wrote`, `edited`, `ran`, `read`, `grep`...), drawn with the exported `VERB`
  class from `narrationtimeline.tsx` (uppercase mono), the target in the timeline's target style, truncated. The
  prototype's "Write" is a sketch of that style; the spec asks for the timeline's tool-row verb style.
- **D3. "This turn" is the entries after the last `user` entry or non-skill `command` entry** (a human prompt, which
  includes Arc's `brainstorm:` lines typed into the terminal). With none in the tail, every entry is this turn's: the
  stream tails the transcript, and the turn's own prompt is the last one, so a tail without it starts inside the turn.
  Entries carry no timestamps, so the prompt is the only boundary they give.
- **D4. A board counts once its write has a result that did not fail** (`pending` absent and `outcome !== "fail"`): a
  pending Write has not landed the file yet. Boards list in first-write order, each once (an edit of an earlier
  board included); the board the turn wrote last carries a success dot before its caption, as the prototype's
  `Page-trend.dc.html` does.
- **D5. A board is a Write/Edit whose `detail.kind === "edit"` file path is
  `<cwd>/.superpowers/design/<canvas>/project/<name>.dc.html`** (`cwd` = the brainstorm's `s.cwd`). Paths compare with
  `\` normalized to `/` and case-insensitively (Windows); a relative path (pi) is taken against `cwd`. A
  `.dc.html` elsewhere (another project, `feedback/`, nested folders under `project/`) is not a board.
- **D6. Board sizes live in a new `BrainstormState.turn` field**, `{ read: string[]; canvases: Record<string,
  CanvasBoard[]> }`: canvas.json's boards for each canvas this turn wrote on, and the board keys (`<canvas>/<name>`)
  they were read for. `s.boards` stays the file's own canvas, so no existing consumer changes. The poller checks the
  turn's boards every tick (they come from the transcript, not from brainstorm.json's mtime) and does IO only when a
  board key is not in `read`. `Thumbnails` gains optional `sizes` and `latest` props.
- **D7. The live parts show only while `agent.state === "working"`**; otherwise the Working view and the note read
  exactly as today. In a turn with no step known yet, the step line is left out and the fixed sentence ("The next
  question comes after." / the note's full sentence) stays in its place, so the view never loses its explanation.
- **D8. Elapsed time** = now − the block meta `agent:turnstartts` (the turn start `terminalAnswer` already uses),
  formatted by `fmtDuration` (`runcompletion.ts`: "42s", "1m 42s"), ticking off `model.nowAtom`. No turn start known:
  the step line draws without a time.
- **D9. The boards section needs `s.base`** (the served design folder) to draw; until the poller has served it the
  section is absent, as it is when the turn wrote no board.
- **D10. Prototype boards.** The canvas's `project/` holds two boards: `Main.dc.html`, the picked design (step line
  + boards, `brainstorm-working` step 3), and `StepLine.dc.html`, the same design's state with no board yet (step 2).
  The three answer options question 3 did not pick (`StepLine-quiet`, a stall warning the spec makes a non-goal;
  `StepList`; `Timeline`) were moved out of `project/` to the canvas's `unpicked/` folder at plan review, with
  canvas.json's entries for them dropped (the original kept as `unpicked/canvas.json.orig`).
- **Verify note.** `verify.mjs` needs a Go pattern; at each merge it runs tsc and `vitest related` on the merge's
  changed frontend files, so the Go pattern only adds `./pkg/waveobj` (fast) to the final stage's full vitest run.
- **D11. The scenario fakes the agent**: `agent:status` events with `state` and `transcriptpath`, the block's
  `agent:turnstartts`, and a fixture transcript appended to as the turn goes on; the live stream tails it as it does
  a real agent's.

## Global Constraints

- Copy, verbatim: section header `Boards made this turn · N`; the plain lines stay `The next question comes after.`
  and `The agent is writing. Confirm, edit and keep open again when it asks its next question.`; with a step the
  note's second line is `Confirm, edit and keep open again when it asks its next question.`
- Colors only from the `@theme` tokens (`text-muted`, `text-ink-mid`, `bg-success`, ...); no new tokens, no raw colors.
- Turn-board thumbnails are 220px wide (a named constant beside `THUMB_W_QUESTION` in `brainstormui.tsx`), side by
  side with the caption under each (`Thumbnails` `compact`).
- No change to the Go hook, to the arc:brainstorm skill, to the judge wait or to the builder check wait (`CheckWait`).

## Review Focus

1. A `.dc.html` write outside the brainstorm's project, under `feedback/`, or a failed or still-pending write must not
   show as a board (Task 1 tests).
2. A turn whose prompt scrolled out of the stream's tail still shows its boards and step (Task 1 test).
3. The agent ended its turn but `working` is still set (background work): plain line, no step, no boards, no stale
   timer (Task 1 test on the gate, Task 4 step 5).
4. wavesrv refusing to serve the design folder: nothing is marked read, so the next poll tries again; no boards drawn
   meanwhile (Task 2 test).
5. Windows paths: `C:\proj\.superpowers\design\x\project\A.dc.html` against a cwd spelled `c:/proj` is a board
   (Task 1 test).

---

### Task 1: The working-turn model and the state field it sizes boards from
**Depends on:** none
**Files:** `frontend/app/view/agents/brainstormworking.ts`, `frontend/app/view/agents/brainstormworking.test.ts`, `frontend/app/view/agents/brainstormstore.ts`, `frontend/app/view/agents/brainstormstore.test.ts`, `frontend/app/view/agents/brainstormpoller.test.ts`

**Interfaces (Produces — Tasks 2 and 3 use these exactly):**

```ts
// brainstormworking.ts (pure; imports AgentEntry/AgentVM types, canvasDesignDir, fmtDuration)
export type TurnBoard = { canvas: string; name: string };
export type WorkingStep = { verb: string; target: string };
export type WorkingTurn = { step: WorkingStep | null; elapsed: string | null; boards: TurnBoard[]; latest: TurnBoard | null };
export function turnEntries(entries: AgentEntry[]): AgentEntry[];                 // D3
export function turnBoards(entries: AgentEntry[], cwd: string): { boards: TurnBoard[]; latest: TurnBoard | null }; // D4, D5; slices with turnEntries itself
export function boardKey(b: TurnBoard): string;                                    // `${canvas}/${name}`
export function workingStep(entries: AgentEntry[]): WorkingStep | null;            // D1; slices with turnEntries itself
export function workingTurn(
    agent: Pick<AgentVM, "state">, entries: AgentEntry[], cwd: string, turnStartMs: number | undefined, nowMs: number
): WorkingTurn | null;                                                             // null unless agent.state === "working" (D7); elapsed per D8

// brainstormstore.ts: BrainstormState gains (attachBrainstorm initializes it to { read: [], canvases: {} })
turn: { read: string[]; canvases: Record<string, CanvasBoard[]> };
```

- [ ] **Step 1: Write the failing tests** in `brainstormworking.test.ts` (build entries as literal `AgentEntry` objects;
  a Write is `{ kind: "action", verb: "wrote", target: "<base>", detail: { kind: "edit", files: [{ path, badge: "A", adds: 1, dels: 0, lines: [] }] } }`):
  - `turnEntries`: entries after the last `user`; a non-skill `command` also cuts; an `isSkill` command does not; no
    prompt in the list returns every entry.
  - `turnBoards`, cwd `C:/proj`: Writes of `C:\proj\.superpowers\design\lag\project\Page.dc.html` then
    `...\Page-trend.dc.html` → boards `[{canvas:"lag",name:"Page.dc.html"},{canvas:"lag",name:"Page-trend.dc.html"}]`,
    latest `Page-trend.dc.html`; a later Edit of `Page.dc.html` keeps the order and length 2 and makes it latest; a
    board on a second canvas `other` is included; a write before the last `user` entry is not; cwd spelled `c:\proj\`
    matches the same paths; a relative `.superpowers/design/lag/project/R.dc.html` is a board.
  - `turnBoards` rejects: a pending Write, an `outcome: "fail"` Edit, `D:/elsewhere/.superpowers/design/lag/project/X.dc.html`,
    `C:/proj/.superpowers/design/lag/feedback/X.dc.html`, `.../project/sub/X.dc.html`, `.../project/X.html`, and an
    action with no `detail` → `{ boards: [], latest: null }`.
  - `workingStep`: the latest action of the turn `{ verb: "wrote", target: "Page-trend.dc.html" }`, a pending action
    included; a turn with only a `message` → null; an action before the last `user` entry → null.
  - `workingTurn`: `state: "idle"` → null even with actions; working with turn start `now - 102_000` → elapsed
    `"1m 42s"`; turn start undefined → elapsed null with the step kept; working with no entries → `{ step: null,
    elapsed: <string>, boards: [], latest: null }`.
- [ ] **Step 2:** `npx vitest run frontend/app/view/agents/brainstormworking.test.ts` — FAIL (module missing).
- [ ] **Step 3:** Implement `brainstormworking.ts` per the interface and D1–D5, D7, D8. Reuse `canvasDesignDir`
  (`canvasmodel.ts`) and `fmtDuration` (`runcompletion.ts`); no new formatter.
- [ ] **Step 4:** Add `turn` to `BrainstormState` (comment: why it exists, per D6) and to `attachBrainstorm`; add
  `turn: { read: [], canvases: {} }` to the full-state literal in `brainstormstore.test.ts` (the attach `toEqual`) and
  to the `state()` builder in `brainstormpoller.test.ts`, so tsc stays clean.
- [ ] **Step 5:** `npx vitest run frontend/app/view/agents/brainstormworking.test.ts frontend/app/view/agents/brainstormstore.test.ts frontend/app/view/agents/brainstormpoller.test.ts` — PASS.
- [ ] **Step 6:** Commit.

### Task 2: The poller reads the turn boards' canvas.json
**Depends on:** Task 1
**Files:** `frontend/app/view/agents/brainstormpoller.ts`, `frontend/app/view/agents/brainstormpoller.test.ts`

**Interfaces:** Consumes `turnBoards`, `boardKey`, `TurnBoard`, `BrainstormState.turn` (Task 1). Produces
`s.turn.canvases[canvas]` filled within a poll tick of a new board landing, and `s.base` set on the first board.

```ts
// brainstormpoller.ts
export async function readTurnCanvases(
    s: BrainstormState, boards: TurnBoard[], io: BrainstormIO
): Promise<Pick<BrainstormState, "base" | "turn"> | null>;
```

- [ ] **Step 1: Write the failing tests** (`describe("readTurnCanvases")`, using the file's fake IO):
  - no boards → null, and no `serve`/`canvasJson` call.
  - `base: null`, boards on `lag` → `serve` called once with `canvasDesignDir(cwd)`; result `base` is its URL,
    `turn.canvases.lag` is `boardsFromCanvasJson` of `boardUrl(base, "lag", "canvas.json")`'s json, `turn.read` is
    `["lag/Page.dc.html"]`.
  - every key already in `s.turn.read` → null, no IO (the per-tick path).
  - a new board on a canvas already read → canvas.json for that canvas re-read and `read` gains the key; a board on a
    second canvas → both canvases present in `canvases` (the untouched one kept from `s.turn.canvases`).
  - `serve` returns null → null (nothing marked read, so the next poll retries).
  - `canvasJson` returns undefined → `canvases.lag` is `boardsFromCanvasJson(undefined)` (default sizes), key marked read.
- [ ] **Step 2:** `npx vitest run frontend/app/view/agents/brainstormpoller.test.ts -t readTurnCanvases` — FAIL.
- [ ] **Step 3:** Implement `readTurnCanvases` (canvas.json of each distinct canvas that has an unread key; reuse
  `CANVAS_JSON`, `boardUrl`, `boardsFromCanvasJson`). In `pollAndMerge`, after `pollBrainstormOnce`, compute
  `turnBoards(globalStore.get(entriesAtomFor(agentId)), s.cwd).boards`, call `readTurnCanvases({ ...s, ...patch }, ...)`
  and merge its result into the patch before the existing update; a throw stays inside the existing
  `pollAgent` catch (logged with the agent id), never swallowed.
- [ ] **Step 4:** `npx vitest run frontend/app/view/agents/brainstormpoller.test.ts` — PASS.
- [ ] **Step 5:** Commit.

### Task 3: Step line and turn boards in the Working view and the design note
**Depends on:** Task 1 (uses `workingTurn`, `TurnBoard`, `boardKey` and `BrainstormState.turn`)
**Files:** `frontend/app/view/agents/brainstormui.tsx`, `frontend/app/view/agents/brainstormpane.tsx`, `frontend/app/view/agents/brainstormcheck.tsx`

**Interfaces (Task 4 asserts these data attributes):**

```tsx
// brainstormui.tsx
export function useWorkingTurn(agent: AgentVM, s: BrainstormState, nowAtom: Atom<number>): WorkingTurn | null;
// entries from entriesAtomFor(agent.id); turn start from the agent block's "agent:turnstartts" meta, read reactively
// (no blockId: undefined); now from nowAtom
export function WorkingStepLine({ step, elapsed }: { step: WorkingStep; elapsed: string | null }): JSX.Element;
export function WorkingMain({ agent, s, f, nowAtom, openDesign }:
    { agent: AgentVM; s: BrainstormState; f: BrainstormFile; nowAtom: Atom<number>; openDesign: () => void }): JSX.Element;
// Thumbnails gains: sizes?: CanvasBoard[] (board sizes; default s.boards), latest?: string (board name whose caption
// gets a SMALL_DOT bg-success before it, and data-brainstorm-thumb-latest on the caption)
```

Data attributes: the step line `data-brainstorm-step`, inside it `data-brainstorm-step-verb`,
`data-brainstorm-step-target`, `data-brainstorm-step-elapsed` (absent when elapsed is null); the boards section
`data-brainstorm-turn-boards` (thumbnails keep `data-brainstorm-thumb` and `data-brainstorm-open-board`).

- [ ] **Step 1:** `WorkingStepLine` per the prototype: verb in the `VERB` class `narrationtimeline.tsx` already
  exports, target mono 12.5px `text-ink-mid` truncated, elapsed `ml-auto` 12px `text-muted`, baseline-aligned, gap
  10px.
- [ ] **Step 2:** `WorkingMain`: keep the Working label and the big `f.working` line. With `turn?.step` draw
  `WorkingStepLine` in place of "The next question comes after." (D7: no step → that sentence stays). Below it, when
  `turn` has boards and `s.base != null` (D9): `Boards made this turn · N` (12px `text-muted`) and one compact
  `Thumbnails` per canvas (220px, `sizes={s.turn.canvases[canvas]}`, `latest` = `turn.latest.name` on its canvas),
  wrapped side by side. Design button last. Opening a thumbnail uses `Thumbnails`' existing open, which attaches the
  board's own canvas.
- [ ] **Step 3:** Callers: `brainstormpane.tsx` `Design` passes `agent`, `s`, `nowAtom`; `brainstormcheck.tsx` `Check`
  passes `agent`, `s`, `model.nowAtom`.
- [ ] **Step 4:** The design note (`data-brainstorm-working-note` in `DesignMain`): with a step, line 1 is the dot plus
  `WorkingStepLine`, line 2 `Confirm, edit and keep open again when it asks its next question.`; without one, the
  note's text stays exactly as today. No boards in the note.
- [ ] **Step 5:** `task check:ts` clean; `npx eslint` and `npx prettier --check` on the three files. The rendered
  result is proven by Task 4's `brainstorm-working` steps 1–3 (Working view: no step, step only, step + boards),
  4 (thumbnail open, design note) and 5 (out of turn); nothing here is left manual.
- [ ] **Step 6:** Commit.

### Task 4: CDP scenario `brainstorm-working`
**Depends on:** Task 2 (its boards need the poller's turn canvas read), Task 3 (asserts the data attributes Task 3 draws)
**Files:** `scripts/cdp/scenarios-brainstorm-working.mjs`, `scripts/cdp/scenarios.mjs`

A `BS_KIT` module like `scenarios-brainstorm-spikes.mjs`, registered in `scenarios.mjs` beside it. Arrange with
`bsArrangeAgent`: brainstorm.json asks question 3 and has **no `canvas`** (the first mockup turn); set its mtime 10
minutes back (`utimesSync`) so a turn started now reads as the user's answer ("Writing up your answer."). Write
`canvas.json` for canvas `lag-page` listing only `Page.dc.html` (760×640), plus `Page.dc.html` and
`Page-trend.dc.html` (any small board html) under `<cwd>/.superpowers/design/lag-page/project/`. Transcript via
`writeTranscript`/`userText`/`toolUse`/`toolResult` from `agent-page-fixtures.mjs`; publish `agent:status` with
`state: "working"`, `agent: "claude"`, `transcriptpath`, and set block meta `agent:turnstartts` to now − 102 s. Each
step takes a screenshot (`cdp-shots/brainstorm-working-N-<what>.png`). Teardown removes the temp dir, tabs and the
status as the kit's teardown does.

Steps (each a `rec`):
1. Transcript has only the user's answer: Working view shows `Writing up your answer.`, no `[data-brainstorm-step]`,
   `The next question comes after.` still shown, no `[data-brainstorm-turn-boards]`.
2. Append a `Read` of `DESIGN.md` with its result (the StepLine board): step verb text `read`, target `DESIGN.md`,
   elapsed matches `/^\d+m \d{2}s$/` and is ≥ 1m 42s; no boards section.
3. Append the two board Writes with results (the Main board): step `wrote Page-trend.dc.html`; header
   `Boards made this turn · 2`; thumbs `Page.dc.html`, `Page-trend.dc.html` in that order, the latest mark on
   `Page-trend.dc.html` only; `Page-trend`'s thumbnail iframe is drawn at the default 1440-wide size scaled to 220.
4. Click `Page.dc.html`'s Open full size: the canvas pane opens on it; Back returns to the Working view. Open the
   design: the note's text starts with the step (`wrote` `Page-trend.dc.html`) and ends with
   `Confirm, edit and keep open again when it asks its next question.`; no thumbnails in the note.
5. Background work: write brainstorm.json with `question: null, working: "Researching how other alert tools page."`
   and publish `state: "idle"`: Working view shows that line and `The next question comes after.`, no step line,
   no boards; the design note reads its full original sentence.

- [ ] **Step 1:** Write the module and register it.
- [ ] **Step 2:** Run `task verify:ui -- brainstorm-working` against the dev app; every step passes. Run
  `brainstorm-mode` too: its step 4b's exact note text must still pass (its agent is idle).
- [ ] **Step 3:** Commit.
