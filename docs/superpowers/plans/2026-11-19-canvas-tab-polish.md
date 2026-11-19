# Canvas tab polish: board rows, no-boards and removed states, one-row window head

**Verify:** `node scripts/verify.mjs ./pkg/waveobj`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
**Final:** `node scripts/cdp/final-verify.mjs workspace-pane-canvas workspace-brainstorm-canvas canvas-swap canvas-mark canvas-tabs motion-lens`
**Prototype:** C:\Users\kael02\IdeaProjects\waveterm\.superpowers\design\canvas-tab-polish

The agent's Canvas tab in the workspace pane (`workspacecanvastab.tsx`, `workspacecanvastabmodel.ts`) and the
canvas window's head (`CanvasPane` with `onClose`, in `canvaswindow.tsx`), rebuilt to the prototype. Its boards:
**Main** (the tab at 600 px: one row per board), **States** (no boards on the left, removed on the right) and
**Window** (the window's head with 12 boards). The prototype's readable source is `gen.mjs` beside `project/`:
`boardC()` is Main, `boardStates()` States, `boardWindow()` Window. Match its layout, type and copy through the
`@theme` tokens (no new tokens: map the prototype's greys onto the nearest existing ones). Motion follows
`docs/reference/motion-system.md` and reuses `motiontokens.ts`, with no new vocabulary.

## Decisions beyond the design

1. **No boards is decided at the source.** The poller (`canvaspoller.ts`) stops inventing a Main board: when
   canvas.json lists none (absent, malformed or empty), it HEADs `Main.dc.html` and keeps a Main board only if
   that answers 200; otherwise `CanvasState.boards` is `[]`. A canvas.json that lists boards keeps them all, served
   or not, as today. `boardsFromCanvasJson` keeps its Main fallback, since the brainstorm poller and its tests rely
   on it; the listed-only read is a new `canvasJsonBoards`. The Terminal view's canvas center and the window are
   out of scope: with `boards: []` they draw what they draw today (`canvasLayout`'s own fallback), and the Mockup
   card already counts served boards, so neither changes.
2. **The tab's view is a pure `tabView(s)`**: `"boards" | "no-boards" | "removed" | "server-down"`. `probing` maps
   to `"boards"` (an empty list), so attaching a canvas never flashes "No boards yet" before the first poll;
   `"no-boards"` needs `status === "ready"` and `boards.length === 0`. The tab's ViewSwap swaps on it.
3. **No-boards head** reads "No boards", plus the age when known (the prototype keeps "updated 6d ago" there), and
   no Open in browser, Mark or Build this…. **Removed head** keeps its row at the same height, empty, so the body
   does not jump when the view swaps. **Server-down head** stays as today minus the zoom %.
4. **The removed copy is decided in `removedExit`**, which gains the tab case:
   `removedExit(backLabel?: string, inTab = false): { label: string; detach: boolean; swapNote: boolean }`.
   Brainstorm (backLabel set): `{ backLabel, detach: false, swapNote: false }`; tab: `{ "Close the tab", true,
   false }`; the Terminal view's center: `{ "Close the canvas", true, true }`. `Removed` (canvaspane.tsx) takes an
   `inTab` prop and prints "The swap control disappears once you close it." only when `swapNote`.
5. **A row's tooltips**: the row button's `aria-label` (and `title`) is "Open <label> in a window"; the
   two-line title span carries the board's full title as its own `title`. A board with no title shows its name
   and size only.
6. **`m`, `[` and `]` stand down with no boards** (`listReady` in `bindings.ts` also requires
   `boards.length > 0`): with nothing listed, `m` would have opened the window on a board that is not there.
7. **Scrolling the selection into view moves only the list's scroller** (`[data-canvas-tab-scroll]`), by the row's
   offset, never `scrollIntoView` on an ancestor chain that includes the workspace pane.
8. **Hover is CSS** (`group-hover`, moment 7): row to `surface-hover`, preview border to `edge-strong`, the
   Maximize2 icon to opacity 1. The selected row keeps its tint on hover; no accent border on any preview.
9. **The tint's `layoutId` is per agent** (`canvas-tab-tint:<agentId>`), its transition `morphTransition`, and
   `duration: 0` under `atoms.prefersReducedMotionAtom`.
10. **The old "expanded, the list's boards grow" scenario step goes**: rows no longer scale with the pane, and the
    fixed preview box is covered by the mixed-sizes step.

### Task 1: updatedAgo in days, the no-boards rule, removedExit's tab case
**Depends on:** none
**Files:** `frontend/app/view/agents/canvasmodel.ts`, `frontend/app/view/agents/canvasmodel.test.ts`, `frontend/app/view/agents/canvaspoller.ts`, `frontend/app/view/agents/canvaspoller.test.ts`

**What to build:** the pure parts the tab and window read. `updatedAgo` reads in days from 24 h on, which the
window's meta and the transcript's Mockup card pick up with no change of theirs. The poller's no-boards rule
(decision 1), through a new `canvasJsonBoards`. `removedExit`'s tab case (decision 4); `Removed` in canvaspane.tsx
keeps compiling unchanged (it reads `label` and `detach`), Task 3 wires `swapNote`.

**Interfaces:**
- `canvasJsonBoards(json: unknown): CanvasBoard[]`: the boards canvas.json lists, placed as today, `[]` when none.
  `boardsFromCanvasJson(json)` returns it, or the Main fallback when it is empty.
- `removedExit(backLabel?: string, inTab = false): { label: string; detach: boolean; swapNote: boolean }`.

**Acceptance:**
- `updatedAgo(now, now - 86_399_000)` is "updated 23h ago", `now - 86_400_000` "updated 1d ago", 6 days back
  "updated 6d ago"; the seconds, minutes and hours readings and `null` → "" stay as today.
- `pollCanvasOnce` with canvas.json serving `{ boards: {} }` (or not served) and `Main.dc.html` answering 404
  patches `status: "ready"`, `boards: []`, `boardModifiedMs: {}`.
- With canvas.json listing nothing and `Main.dc.html` answering 200, it patches the one Main board, as today.
- With canvas.json listing nothing and the `Main.dc.html` HEAD failing to answer (`status: "error"`), it patches
  `{ base: null, status: "server-down" }`, as any other board HEAD that errors does.
- A canvas.json listing boards whose files are not written yet still yields those boards, unserved, as today.
- `removedExit` returns the three cases of decision 4 exactly.
- `boardsFromCanvasJson`'s existing tests and the brainstorm poller's tests pass unchanged.

### Task 2: the canvas window's head stays one row
**Depends on:** none
**Files:** `frontend/app/view/agents/canvaspane.tsx`, `scripts/cdp/scenarios-workspace-pane.mjs`

**What to build:** in the window only (`CanvasPane` with `onClose`), the head never wraps: the board tabs' scroller
takes the remaining width (`flex-1 min-w-0`) and scrolls sideways under the existing `useEdgeFade` mask, keeping
the picked tab in view (the existing effect); topic, meta (age · zoom %, as today), the marking hint, Mark, Open in
browser, Build this… and Close sit on that row with Close at the far right. With no tabs drawn, a spacer still
pushes Close right. CanvasPane without `onClose` (the Terminal view's center, the brainstorm's board view in the
narrow pane) keeps its wrapping head unchanged.

**Acceptance:**
- New step in `workspace-pane-canvas`, after "with 2 boards the window's All is one row of 2" (Window board):
  canvas.json rewritten to 12 boards, the window opened on the last one; every child of the head shares one row
  (vertical centres within 2 px, the head no taller than one row), the tab scroller's `scrollWidth` exceeds its
  `clientWidth` with an edge mask applied, the selected tab lies inside the scroller's box, and Close is the
  head's last control, at its right end. The step closes the window and puts canvas.json back as it found it.
- The existing window steps (tabs with All in rows of 3, two boards in one row, Esc order) and `canvas-tabs`,
  `canvas-mark`, `canvas-swap`, `motion-lens` and `workspace-brainstorm-canvas` pass unchanged.

### Task 3: the Canvas tab as board rows, with no-boards and removed states
**Depends on:** Task 1 (uses `removedExit`'s `swapNote` and the poller's empty `boards`), Task 2 (file order only: both edit `canvaspane.tsx` and `scenarios-workspace-pane.mjs`)
**Files:** `frontend/app/view/agents/workspacecanvastab.tsx`, `frontend/app/view/agents/workspacecanvastabmodel.ts`, `frontend/app/view/agents/workspacecanvastabmodel.test.ts`, `frontend/app/view/agents/canvaspane.tsx`, `frontend/app/store/keybindings/bindings.ts`, `scripts/cdp/scenarios-workspace-pane.mjs`, `scripts/cdp/scenarios-workspace-brainstorm-canvas.mjs`

**What to build:** the Main and States boards. The tab lists one row per board in canvas.json order: a 112×70
preview box (3 px inset, `surface-code` background, `edge-mid` border, 8 px radius) with the whole board fitted
and centred (the existing `BoardIframe` at the board's full size, scaled, `pointer-events: none`), then the name in
mono with `w×h` right-aligned on the same line, then the title in sans 12.5 px clamped to two lines. The whole row
is one button: `openCanvasWindow(agent.id, { board })`. The selected row (`shownBoard(s)`) is tinted `accentbg`
with its name in `accent-soft`. `[` and `]` keep using `stepListBoard` and bring the selected row into view
(decision 7). Hover per decision 8; the old "Open in a window" pill goes, the Maximize2 icon at the row's right
end (`data-canvas-tab-open`) replaces it.

The head: a `TickNumber` of the board count (`format={boardCount}`) and the age, no zoom %; Open in browser, Mark
and Build this… as today. Per `tabView` (decision 2): no boards shows "No boards yet" / "canvas.json lists no
boards. They show here as the agent writes them." (EdgeState and EXPLAINER from canvaspane.tsx) with the head of
decision 3; removed shows `Removed` with `inTab` (decision 4: "Close the tab", no swap sentence) and the empty
head; server-down as today. `listReady` in bindings.ts per decision 6.

Data attributes: `data-canvas-tab` on the root, `data-canvas-tab-scroll` on the scroller,
`data-canvas-tab-preview={board.name}` and `data-selected` on each row. Never `data-canvas-board` or
`data-canvas-scroll`, which `sendCanvasMark`'s capture reads from the window.

Motion: rows in `AnimatePresence initial={false} mode="popLayout"` with a `motion.div` (layout, `cardVariants`)
as each direct child: a board added enters (moment 1, no cascade on mount), a removed one exits as the list
reflows (moment 2); the tint is a `layoutId` element with `morphTransition` (moment 17, decision 9); the count is
moment 12; a rewritten board's preview fades in on load through `BoardIframe`. View changes swap through the
existing ViewSwap.

**Interfaces:** `workspacecanvastabmodel.ts` drops `canvasListLayout`, `LIST_LABEL_H`, `ListFrame` and `ListLayout`
(their only users are the tab and its test) and exports, beside `stepListBoard`:
- `tabView(s: CanvasState): "boards" | "no-boards" | "removed" | "server-down"`
- `tabRows(s: CanvasState): { board: CanvasBoard; label: string; size: string; selected: boolean }[]` (size as
  `"1280×800"`, with the × sign)
- `previewFit(w: number, h: number): { scale: number; left: number; top: number }`: the board fitted inside the
  box's 106×64 content area, centred.

**Acceptance:**
- Unit: `tabRows` keeps canvas order, labels without `.dc.html`, sizes with ×, exactly one selected row (the one
  `shownBoard` names, the first for a stale pick), none for no boards. `previewFit` fits a 1280×800, a 400×800
  and a 1440×2500 board wholly inside 106×64, centred on the free axis. `tabView` maps each status, and `ready`
  with no boards to `"no-boards"`, `probing` with none to `"boards"`. `stepListBoard`'s existing cases hold.
- Rewritten `workspace-pane-canvas` Canvas tab steps (the Main board): the rows in canvas order with name, size
  and title, canvas.json including a 400×800 and a 1440×2500 board, every preview the same 112×70 box; the
  selected row tinted, its name in accent-soft, no preview with an accent border; the head shows count and age
  and no `%`; a real hover shows the open icon on that row only and its preview border at `edge-strong`. Each
  row's `aria-label` and `title` read "Open <label> in a window", its title span's `title` is the board's full
  title, and a board written with no title in canvas.json draws its row with name and size only (no title span).
- A step: `]` moves the tinted selection down and the selected row ends inside the scroller's box, the window
  staying closed.
- A step: a row click opens the window on its board (the existing window step, now clicking a row).
- A step: canvas.json rewritten with one board added and one removed: the added row enters and the removed one
  leaves, ending in the new order.
- The two States steps run last in `workspace-pane-canvas`, after every window and Mark step, in this order:
- A step (States board, left): canvas.json `{ "boards": {} }` with `Main.dc.html` deleted shows "No boards yet"
  and its explainer; the head reads "No boards" with no Mark, Open in browser or Build this…. With the surface
  focused (`focusSurfaceWrap`), pressing `m` and `]` leaves the window closed (`canvasFacts(...).window == null`)
  and the board unchanged.
- A step (States board, right, the scenario's last step): the canvas's `project` folder deleted shows "<topic>
  was removed" without the swap sentence, a "Close the tab" button and a head with no count, age or actions;
  clicking Close the tab detaches the canvas and closes the Canvas tab. Teardown then tolerates the canvas
  already detached and the folder already gone (its close/detach calls are no-ops, `rmSync` uses `force`).
- `workspace-brainstorm-canvas`'s Canvas tab step passes against rows (adjust its stacked check to rows if it
  fails), and Task 2's 12-board window step, `canvas-swap`, `canvas-mark`, `canvas-tabs` and `motion-lens` pass.
