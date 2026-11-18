# Workspace pane polish: canvas window, stacked boards, tab strip, diff wrap, slim transcript cards

**Effort:** effort:f2ce52d6-4889-4be7-8258-39348ddd83bf
**Verify:** `node scripts/verify.mjs ./pkg/brainstormcheck`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
**Final:** `node scripts/cdp/final-verify.mjs workspace-pane workspace-pane-canvas workspace-brainstorm-canvas workspace-changes rendered-bs-mockup rendered-bs-boards rendered-bs-question canvas-mark canvas-tabs`
**Prototype:** C:\Users\kael02\IdeaProjects\waveterm\.superpowers\design\workspace-pane

The Rendered view's workspace pane, built to the Main board of the prototype (its `boardSet` tweak draws 2 and 6
boards). Every design call is recorded on the effort above (`wsh effort show f2ce52d6`). Out of scope: the Terminal
view's canvas center, a brainstorm's full-size board, the Changes file-list picker, and dropping `tabLabel`'s
`Run · / Brainstorm · / Canvas ·` prefixes (kept).

Verify names one small Go package only because `scripts/verify.mjs` requires a pattern; this plan changes no Go, so
at a merge it runs tsc and the vitest files related to the changed paths, and unscoped it runs that package and every
frontend test.

## Decisions beyond the design

1. **The window is today's `CanvasPane` inside a `ModalShell`** (`align="center"`: the image viewer's frame, `p-10`
   = 40px inset, `backdrop-blur-sm`), mounted once on the Agent surface and driven by one atom holding the agent id
   whose canvas window is open. Why: the window must be "live like today's CanvasPane" (tabs, All, Mark, Open in
   browser, Build this, the mark note and its send); reusing it keeps one implementation of marking and capture.
   `CanvasPane` gains an `onClose` prop that makes it the window: a Close button (title `Close (Esc)`), the header
   hint, and All in rows of 3. Without the prop it renders exactly as today (Terminal center, brainstorm board).
2. **The window counts as a modal for the key context** (`deriveKeyContext`, as `imageZoomOpenAtom` does), so the
   agent and surface keys stand down under it, and it registers its own bindings gated on its atom (the Final shots
   viewer's pattern): `Escape`, `m`, `[` / `]`. Why: without them `m` and `[ ]` would die in the window, which today's
   pane supports.
3. **Esc has one handler, `escapeCanvasWindow`**, which follows the pure `canvasEscape` (a drawn mark → drop it; else
   close the window). Both Esc paths call it: the `Escape` binding in bindings.ts (the dispatcher's capture-phase
   listener claims a matched key and stops its propagation, so `ModalShell`'s own window listener never sees it) and
   `ModalShell`'s `onClose` (reached when the binding's gates do not match). So no single press both drops a mark and
   closes the window. A backdrop press goes through the same `onClose`, so with a mark drawn it drops the mark first,
   as Esc does. A focused note field keeps its own Esc (it stops propagation): it drops the mark only. Marking on with
   nothing drawn: Esc closes. Closing always turns marking off and drops the mark. `ModalShell` is not changed.
4. **The window's All lays boards in rows of 3 in canvas order**, 80px between frames and 120px between rows (the
   design skill's gaps), scaled to fit the window's width, never grown. Why: the goal pins rows of 3, and canvas.json
   positions are free-form (unpositioned boards land in one row today). The Terminal center keeps `canvasLayout`.
5. **The pane's Canvas tab is a new component** (`workspacecanvastab.tsx`), not `CanvasPane`. It draws previews with
   their own data attributes, so `[data-canvas-board]` and `[data-canvas-scroll]` (which `sendCanvasMark`'s capture
   queries) stay unique to `CanvasPane`, and a mark sent from the window captures the window's board.
6. **Pane interactions:** a click on a preview selects that board and opens the window on its tab; a click on a
   board's label only selects it; `[` / `]` move the selection among boards (no All in the pane) and scroll it into
   view; `m` and the Mark button open the window on the selected board with marking on. The pane's Build this builds
   every board (the list shows them all); the window's builds its shown tab, as today.
7. **A sent mark leaves the window open with marking off** (`sendCanvasMark`'s Rendered branch already turns marking
   off and keeps the tab). The window closes on its own when the agent's canvas is detached. A redraw while it is open
   reloads its boards, so the open window counts as on screen for the poller.
8. **Tab strip:** icon-only is decided from every tab's full width (icon, label capped at 200px, close, padding)
   against the strip's measured width, never from the compacted widths, so it cannot oscillate. Any waiting tab shown
   icon-only (Run, and Brainstorm, which can wait too) wears its dot on the icon's corner.
9. **Diff wrap** is an explicit `wrap` prop on `DiffPane` and a fourth `paneOptions` parameter; only the Changes tab
   passes it, so the Diff surface is unchanged.
10. **Mockup card:** only its live-board body goes. The row (topic, board count, updated, Open canvas, Mark) replaces
    the head; the no-boards and server-down explanations and the removed row stay. The row's Mark opens the Canvas
    tab and the window on that board with marking on; Open canvas opens the tab at the board. The `data-rendered-mockup`
    (with its kind values) and `data-rendered-mockup-open` attributes stay: other scenarios read them.
11. **Question card:** the boards block goes; each option's board chip opens the Brainstorm tab at that board
    (`openBrainstormAt`), since an agent with a brainstorm shows its boards there.
12. **Dead code goes with it:** `LiveBoards`, `BoardTabs` and the inline-board tracking only they read
    (`showInlineBoard`, `inlineBoard`, `boardViewedMs`, `boardUnseen`, the poller's inline reload), with their tests.
13. **The window's state is its own small task** (Task 3), so the window UI (Task 4) and the transcript cards (Task 6)
    build on it side by side instead of the cards waiting for the whole window.
14. **The scenario steps are one last task** (Task 7): six tasks run at once and a file has one owner among them; each
    UI task names the step Task 7 adds, and verifies its own UI meanwhile with the scenario files it owns or an ad-hoc
    CDP check. The strip and diff steps go in the existing `workspace-pane` scenario; the canvas, window and Mockup
    row steps need an agent with a served canvas and no brainstorm, which `workspace-pane`'s roster fixture has no
    way to give, so they go in a second scenario, `workspace-pane-canvas`, in the same file, built on RBS_KIT.

### Task 1: Tab strip drops the hidden tabs to their icons when the labels do not fit
**Depends on:** none
**Files:** `frontend/app/view/agents/workspacemodel.ts`, `frontend/app/view/agents/workspacemodel.test.ts`, `frontend/app/view/agents/workspacepane.tsx`

**What to build:** in `TabStrip`/`TabButton` (workspacepane.tsx), when every tab at its full label does not fit the
strip, every tab except the shown one renders its icon only (the name stays in its `title` and `aria-label`); the
shown tab keeps its label and is the one that shrinks if room is still short. A waiting tab shown icon-only moves its
dot to the icon's top-right corner, ringed in the strip's background (prototype: 6px dot, 2px ring); with its label
it stays inline as today. The rule is a pure function in workspacemodel.ts taking the measured full widths and the
strip's width (decision 8). `tabLabel` and its prefixes are unchanged.

**Acceptance:**
- the rule: full widths summing over the room → compact; at or under → labels; the shown tab is never compact
- at 600px with four tabs whose labels overflow (Run with a long title, Changes, a file, Canvas), the three hidden
  tabs are icon-only and the shown one reads its full label; expanding the pane until they fit brings every label back
- `data-workspace-tab`, `data-workspace-tab-waiting` and `data-workspace-tab-close` keep their meaning, so the
  existing workspace scenarios still pass
- scenario step (Task 7, `workspace-pane`): "with more tabs than fit, every tab but the shown one drops to its icon,
  the Run tab's dot on the icon corner"

### Task 2: The Changes tab's diff wraps long lines
**Depends on:** none
**Files:** `frontend/app/view/agents/diffoptions.ts`, `frontend/app/view/agents/diffoptions.test.ts`, `frontend/app/view/agents/diffpane.tsx`, `frontend/app/view/agents/workspacechangestab.tsx`, `frontend/tailwindsetup.css`

**What to build:** `paneOptions` takes a fourth `wrap` parameter that turns on Monaco's word wrap for both the
modified editor and the diff (`wordWrap`, `diffWordWrap`); `DiffPane` takes `wrap?: boolean` (default false) and the
workspace Changes tab passes `true`. A wrapped row keeps its change band across every visual line, and its line
number and +/− sign on the first. Touch tailwindsetup.css only if the band CSS stops at the first visual line.

**Interfaces:** `paneOptions(split: boolean, ignoreWs: boolean, newFile?: boolean, wrap?: boolean)`.

**Acceptance:**
- `paneOptions(..., true)` wraps; omitted or false it does not (the Diff surface's call is unchanged)
- in the pane's Changes tab a line longer than the diff column wraps, with no horizontal scrollbar; the Diff surface
  shows the same file unwrapped
- scenario step (Task 7, `workspace-pane`): "the Changes tab's diff wraps a long line, its band, number and sign kept,
  with no sideways scroll"

### Task 3: The canvas window's state
**Depends on:** none
**Files:** `frontend/app/view/agents/canvasstore.ts`, `frontend/app/view/agents/canvasstore.test.ts`, `frontend/app/view/agents/canvaspoller.ts`, `frontend/app/view/agents/canvaspoller.test.ts`

**What to build:** the store half of the window (decisions 7, 13), no UI: one atom naming the agent whose canvas
window is open, open and close operations, detaching that agent's canvas closes it, and the poller counts the open
window as on screen for its agent, so a redraw bumps `reloadKey` while it is open.

**Interfaces:**
```ts
// canvasstore.ts
export const canvasWindowAtom: PrimitiveAtom<string | null>; // the agent id whose canvas window is open
// board: show that board's tab (not All), dropping any mark; mark: marking on, nothing drawn. Without board the tab is kept
export function openCanvasWindow(agentId: string, at?: { board?: string; mark?: boolean }): void;
export function closeCanvasWindow(): void; // clears the atom, turns marking off and drops the mark
```

**Acceptance:**
- `openCanvasWindow(id, { board, mark: true })` sets the atom to `id`, selects that board's tab (`all` false), marking
  on and no mark; without `board` the current tab stays
- `closeCanvasWindow` clears the atom, marking and mark; `detachCanvas` of the open agent clears the atom too
- a poll while the window is open on an agent whose board file got newer bumps `reloadKey`, even with no pane shown

### Task 4: The canvas window
**Depends on:** Task 3 (opens, closes and reads `canvasWindowAtom`)
**Files:** `frontend/app/view/agents/canvaswindow.tsx`, `frontend/app/view/agents/canvaswindowmodel.ts`, `frontend/app/view/agents/canvaswindowmodel.test.ts`, `frontend/app/view/agents/canvaspane.tsx`, `frontend/app/view/agents/canvassend.ts`, `frontend/app/view/agents/canvassend.test.ts`, `frontend/app/view/agents/agentsurface.tsx`, `frontend/app/store/keybindings/dispatcher.ts`, `frontend/app/store/keybindings/bindings.ts`, `frontend/app/store/keybindings/bindings.test.ts`, `docs/keyboard-shortcuts.md`

**What to build:** the whole canvas in a modal (decisions 1-4, 7): `CanvasWindow` (canvaswindow.tsx) renders the
open agent's `CanvasPane` with `onClose` inside a `ModalShell` at the image viewer's frame, root marked
`data-canvas-window`, mounted once in agentsurface.tsx. Header as the prototype's window: topic, board tabs plus All,
then the updated/scale meta, or while marking with nothing drawn the hint "Click the part of the board that should
change"; Mark, Open in browser, Build this, Close. Boards fit the window's width and scroll; no zoom buttons. All lays
the boards in rows of 3 (`windowGridLayout`). Esc and the backdrop go through `escapeCanvasWindow` (decision 3): the
`Escape` binding gated on the window's atom, beside `m` (toggle marking) and `[` / `]` (step tabs, All included), and
`ModalShell`'s `onClose`. Count the window in `deriveKeyContext`. Add the window's rows to docs/keyboard-shortcuts.md's
"Agent: canvas mode" section. `sendCanvasMark` captures the window's board when the window is open. Until Task 5
lands, the window opens through `openCanvasWindow` only (the Canvas tab's own UI is Task 5's).

**Interfaces:**
```ts
// canvaswindowmodel.ts
export function canvasEscape(s: CanvasState): "drop-mark" | "close";
export function windowGridLayout(boards: CanvasBoard[], paneWidth: number): CanvasLayout; // rows of 3
// canvaswindow.tsx
export function escapeCanvasWindow(): void; // canvasEscape on the open agent's canvas: setMark(null) or closeCanvasWindow()
// canvaspane.tsx: CanvasPane gains onClose?: () => void (set = the window; unset = today's pane)
```

**Acceptance:**
- `canvasEscape`: a drawn mark → `drop-mark`; marking with nothing drawn, or not marking → `close`
- `windowGridLayout`: 6 boards of 1440×900 → 2 rows of 3 in canvas order; 2 boards → one row of 2; frames 80px apart
  in a row and 120px between rows before scaling; scale fits the widest row and never exceeds 1
- with the window open and a mark drawn, one Esc press (focus outside the note) drops the mark and the window stays
  open; the next press closes it; one Esc in the focused note drops the mark only; `assertNoConflicts` stays green
- while the window is open the agent keys (`j` / `k`, `d`, `c`) do nothing underneath it
- the Terminal view's canvas center is unchanged: the `canvas-mark` and `canvas-tabs` scenarios pass
- scenario steps (Task 7, `workspace-pane-canvas`): "a click on a board opens the canvas window: board tabs with All
  in rows of 3, Mark, Open in browser, Build this; a redraw keeps it open; Esc drops a drawn mark, then closes it"
  and "with 2 boards the window's All is one row of 2"

### Task 5: The pane's Canvas tab lists every board
**Depends on:** Task 1, Task 4
**Files:** `frontend/app/view/agents/workspacecanvastab.tsx`, `frontend/app/view/agents/workspacecanvastabmodel.ts`, `frontend/app/view/agents/workspacecanvastabmodel.test.ts`, `frontend/app/view/agents/workspacepane.tsx`, `frontend/app/view/agents/canvaspane.tsx`, `frontend/app/store/keybindings/bindings.ts`, `frontend/app/store/keybindings/bindings.test.ts`, `docs/keyboard-shortcuts.md`, `scripts/cdp/scenarios-workspace-brainstorm-canvas.mjs`

**What to build:** `WorkspaceCanvasTab` replaces `CanvasPane` in `TabBody`'s canvas arm (decisions 5-6). Header on
one row, no board tabs: board count ("6 boards" / "1 board"), updated, scale; Open in browser as a 28px icon button
(`aria-label`/`title` "Open in browser"); Mark (opens the window marking, title "Mark part of the board (m): opens
the board in a window"); Build this…. Below, every board stacked at the pane's width (fit, never grown; 18px between
items), each with its label row; the selected board wears the accent border (only when there is more than one).
Hovering a preview shows the centred "Open in a window" pill; the preview's iframe takes no pointer. The tab shows
the same server-down and removed states as `CanvasPane` (export and reuse them). Export `openBuildRun` from
canvaspane.tsx with the boards it builds as a parameter; the window keeps building its shown tab. In bindings.ts,
while the Canvas tab is the shown tab in Rendered and the window is closed: `m` opens the window on the selected
board with marking on, `[` / `]` move the selection among boards (no All). Update docs/keyboard-shortcuts.md's
Rendered sentence. Update `scenarios-workspace-brainstorm-canvas.mjs`'s Canvas tab step to the list.

**Acceptance:**
- the pure layout: N boards at a width → N frames stacked top to bottom, each scaled to the width (≤ 1), total height
  the frames plus labels plus gaps
- clicking a preview opens the window on that board's tab; clicking a label only selects; Mark opens the window with
  marking on and the hint showing; Open in browser opens the selected board's URL
- `[` / `]` in the tab move the accent border through the boards and scroll the selected one into view
- `workspace-brainstorm-canvas` passes with its Canvas step reading the list
- scenario steps (Task 7, `workspace-pane-canvas`): "the Canvas tab lists every board stacked at the pane's width; the
  selected board wears the accent border, a hover shows Open in a window", "expanded, the list's boards grow to the
  pane's width" and "Mark in the pane opens the window with marking on and the header hint"

### Task 6: The transcript's Mockup card and question card slim down
**Depends on:** Task 3 (its Mark opens the window through `openCanvasWindow`; shares canvasstore.ts and canvaspoller.ts)
**Files:** `frontend/app/view/agents/renderedbsboards.tsx`, `frontend/app/view/agents/renderedbsboardsmodel.ts`, `frontend/app/view/agents/renderedbsboardsmodel.test.ts`, `frontend/app/view/agents/renderedbsquestion.tsx`, `frontend/app/view/agents/canvasstore.ts`, `frontend/app/view/agents/canvasstore.test.ts`, `frontend/app/view/agents/canvaspoller.ts`, `frontend/app/view/agents/canvaspoller.test.ts`, `frontend/app/view/agents/canvasmodel.ts`, `frontend/app/view/agents/canvasmodel.test.ts`, `scripts/cdp/scenarios-rendered-bs-mockup.mjs`, `scripts/cdp/scenarios-rendered-bs-boards.mjs`

**What to build:** decisions 10-12. `MockupCard` with boards is one row: the Mockup icon and word, topic, board
count, "updated …" (ticking), then Open canvas and Mark, laid out as today's head (stacked in the compact column).
The empty and server-down explanations and the removed row stay. `useQuestionBoards` returns only the option chips;
a chip (no pressed state) opens the Brainstorm tab at its board; `QuestionCard` drops `boards.block`. Remove what only
the live board used, and update both scenario files' steps that read the live board, its tabs or its unseen dot. The
window's UI is Task 4's and may not be merged yet: this task's scenario checks the row's Mark through the store
(`canvasWindowAtom` names the agent, marking on, the Canvas tab open), not the window's DOM.

**Acceptance:**
- the card with two served boards renders no iframe and no board tabs; the row reads its topic, "2 boards" and
  "updated …"; Open canvas opens the Canvas tab at the board; Mark opens the tab and calls
  `openCanvasWindow(agentId, { board, mark: true })`
- the question card renders no `[data-rendered-bs-boards]` block; an option's chip opens the Brainstorm tab at that
  board
- `data-rendered-mockup` (kind values) and `data-rendered-mockup-open` unchanged: `workspace-brainstorm-canvas`'s
  card step still finds them
- no export left without a reader among those this task removes from; their tests go with them
- `rendered-bs-mockup` and `rendered-bs-boards` pass with steps for the row and the chips
- scenario step (Task 7, `workspace-pane-canvas`): "the transcript's Mockup card is one row: topic, boards, updated,
  Open canvas, Mark"

### Task 7: Scenario steps for the window, the list, the strip, the diff and the row
**Depends on:** Task 1 (the icon-only strip its step shows), Task 2 (the wrapped diff), Task 4 (the window), Task 5 (the stacked list and pane Mark), Task 6 (the slim Mockup row)
**Chunk:** Build: one orchestrator run against the workspace-pane canvas
**Files:** `scripts/cdp/scenarios-workspace-pane.mjs`, `scripts/cdp/scenarios.mjs`

**What to build:** decision 14. Each step below takes a screenshot and asserts on the DOM, not only that a surface
opened; whatever a step arranges is put back in teardown.
- In the existing `workspace-pane` scenario: the strip and diff steps. For the strip, open four tabs whose labels
  overflow 600px (Run, Changes, a file, Canvas; give the run fixture a long title). For the diff, give agent A's block
  a temp git repo with an uncommitted change holding a line longer than the diff column, made with
  scenarios-shared.mjs's `git` the way `scenarios-workspace-changes.mjs` makes its repo.
- A new exported scenario `workspace-pane-canvas` in the same file, registered in scenarios.mjs, built with
  `RBS_KIT.scenario("workspace-pane-canvas", { noBrainstorm: true }, ...)` (scenarios-rendered-brainstorm.mjs). That
  arranges one fixture agent in Rendered with no brainstorm; write its canvas (6 boards, 1440×900, then rewritten to
  2) under `ctx.cwd`'s `.superpowers/design/<ctx.topic>/project` and attach it in the page with `C.attachCanvas`, as
  `scenarios-rendered-bs-mockup.mjs` does. The attached canvas is what makes the transcript draw the Mockup card, so
  the row step needs no transcript record.

**Acceptance:** both scenarios pass in the dev app with these steps.
In `workspace-pane`:
- "with more tabs than fit, every tab but the shown one drops to its icon, the Run tab's dot on the icon corner":
  hidden tabs have no label text, the shown one has its full label, the waiting dot sits over the Run icon
- "the Changes tab's diff wraps a long line, its band, number and sign kept, with no sideways scroll": the long line
  spans more than one visual row inside its band, no horizontal scrollbar

In `workspace-pane-canvas`:
- "the transcript's Mockup card is one row: topic, boards, updated, Open canvas, Mark": no iframe in the card
- "the Canvas tab lists every board stacked at the pane's width; the selected board wears the accent border, a hover
  shows Open in a window": 6 previews in one column at the pane's width, one accent border, the pill visible on hover
- "expanded, the list's boards grow to the pane's width": after expand, each preview is wider than at 600px and still
  one per row
- "a click on a board opens the canvas window: board tabs with All in rows of 3, Mark, Open in browser, Build this; a
  redraw keeps it open; Esc drops a drawn mark, then closes it": the dialog 40px inside the window; All shows 2 rows
  of 3; rewriting a board file leaves `[data-canvas-window]` open with its iframe reloaded; one Esc with a drawn mark
  leaves the mark gone and the window open, the next Esc closes it
- "with 2 boards the window's All is one row of 2": canvas.json rewritten to 2 boards; the window's All shows them
  side by side in one row
- "Mark in the pane opens the window with marking on and the header hint": the hint reads "Click the part of the
  board that should change"
