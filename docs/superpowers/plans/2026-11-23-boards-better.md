# Boards, better: one drawing at a time, opened for viewing

**Effort:** effort:27c79c5d-a564-4361-84df-9521ea1505e6
**Spec:** `docs/superpowers/specs/2026-11-20-boards-better-design.md`
**Verify:** `node scripts/verify.mjs ./pkg/boarddrawer ./pkg/boardstore ./pkg/wshrpc/...`
**Check:** `go build ./... && go vet ./pkg/boarddrawer ./pkg/wshrpc/... && task check:ts`
**Final:** `node scripts/cdp/final-verify.mjs boards-ask boards-workspace`

Mockups (the two chosen boards only): `C:/Users/kael02/IdeaProjects/waveterm/.superpowers/design/boards-better/project/A-Slides.dc.html`
(drawings row) and `.../E-EditSwitch.dc.html` (view mode, Edit switch). The other boards in that folder were not
chosen: do not build them. There is no Prototype line because that folder also holds the unchosen boards, and a
Prototype line would ask Final for a step per board.

## Decisions beyond the spec, and why

- **A drawing is an Excalidraw `frame` element** whose `name` is the drawing's title and whose
  `customData.arcDrawing` is its number (max existing + 1 when made). The row lists live frames by that number;
  a frame made by hand in Edit (no number) is listed after them in element order. Why: Excalidraw draws a frame's
  title and clips its children, so a drawing is fit-able and nameable with no custom element.
- **Code, not the drawer, makes and places frames.** The drawer's reply says only whether it edits the drawing in
  view (`"edit": true`) or makes a new one (no key). The frontend wraps a new drawing's added shapes in a frame titled
  with the answer's title, and moves them so the drawing's top-left sits `DRAWING_GAP` right of everything on the
  board, top-aligned with the board's topmost shape (an empty board: at 0,0). An edit's added shapes join the edited
  frame, and the frame refits to its children plus padding. Why: model for judgment (new vs edit, content), code for
  geometry; slides left to right match A-Slides, and the view fits each drawing, so the row never needs the canvas
  to be compact.
- **Edit keeps the drawing's title.** An edit turn still records its own title in the talk; the frame's name stays.
  Why: a drawing renamed under the person on every follow-up would make the row unreliable to find things by.
- **Code enforces "an edit stays inside its drawing" and "kept short".** `CheckAnswer` refuses: an edit with no
  drawing in view; an update or remove on a shape outside the edited drawing, or on any frame; a new drawing with any
  update or remove; an `add` over `MaxDrawingAdds = 40` entries; any text or label (added or updated) over
  `MaxLabelWords = 12` words. The prompt asks for far less (a handful of boxes, a few words each); the caps only
  refuse a clear breach, which fails the turn with its reason as any unusable answer does. Why: the spec's anti-goal
  is denser drawings, and an answer that reaches into another drawing is unusable.
- **The drawing in view travels with the ask** as `drawingid` (the frame id), stored on the turn so Retry and Draw
  instead reuse it. A frame no longer on the board when the turn runs counts as no drawing in view. Agent requests
  (briefings, draw requests, Keep it here) carry none, so they always make a new drawing.
- **The drawer sees which drawing each shape belongs to:** scene lines gain `"frame":"<id>"`, and each frame is a
  line of type `frame` whose `label` is its title. Coordinates of a new drawing are the drawer's own (Arc places it);
  an edit uses board coordinates.
- **Boards drawn before this change** get one frame titled "Earlier drawings" around all their shapes, the first
  time they are opened or an answer lands on them, when the board has live shapes and no frame at all. The wrap is
  saved. Loose shapes a person draws later on a board that has frames stay loose.
- **"The drawing in view"** is the drawing whose frame covers the largest part of the visible canvas (none when no
  frame is visible). **Following** is true while that drawing is the newest; it is computed on every viewport change
  and stored with the board's viewport (`boardViewportAtom`), so reopening reads it. A board opened for the first
  time (no stored viewport) fits its newest drawing, or the whole scene when it has none.
- **A new drawing landing while following** fits that drawing (Excalidraw `scrollToContent` with fit to viewport). Not
  following: the view stays and the row marks the drawing new until it is the drawing in view. **An edit** of the
  drawing in view refits that drawing (it may have grown); it never moves the view to another drawing.
- **One board strip above the canvas** (`boardstrip.tsx`), the same in the workspace board tab and the Boards
  surface: the drawings row on the left, scrolling horizontally with the current drawing kept in view, and the Edit
  button pinned at its right end. Why: one component for both views, and one strip costs the narrow tab one row
  instead of E-EditSwitch's two. The strip shows Edit even on a board with no drawings yet.
- **Edit is `boardEditingAtom(boardId)` in `boardstore.ts`**, in memory only, false at start. Turning Edit off
  clears the canvas's selection and returns the active tool to selection. Excalidraw's own view-mode toggle is
  disabled by passing `viewModeEnabled` as a controlled prop.
- **In view mode the ask ignores the selection:** a selection set by Show outlines shapes but is not sent with an
  ask and shows no Selected chip. In Edit, shapes selected inside one drawing name that drawing; a selection across
  drawings, or of loose shapes, leaves the drawing in view named.
- **The facts' "N drawings"** counts the board's drawings (frames) once the canvas has loaded, so it agrees with the
  row; before that it reads the list's count as today.

## Tasks

### Task 1: Wire fields for drawings
**Depends on:** none
**Files:** `pkg/wshrpc/wshrpctypes_board.go`, `frontend/types/gotypes.d.ts`

**What to build:** the wire shape every other task relies on, then `task generate`. No behaviour.

**Interfaces:**
- `CommandBoardAskData.DrawingId string \`json:"drawingid,omitempty"\``: the drawing in view when the line was asked.
- `BoardTurn.DrawingId string \`json:"drawingid,omitempty"\``: kept on the turn for Retry and Draw instead.
- `BoardAnswer.Title string \`json:"title,omitempty"\``: the answer's title, the new drawing's frame name.
- `BoardAnswer.DrawingId string \`json:"drawingid,omitempty"\``: the frame an edit changes; empty means a new drawing.

**Acceptance:**
- `go build ./...` passes and `frontend/types/gotypes.d.ts` carries the four optional fields as generated.

### Task 2: The drawer answers one drawing at a time
**Depends on:** Task 1 (uses the DrawingId and Title wire fields)
**Files:** `pkg/boarddrawer/answer.go`, `pkg/boarddrawer/answer_test.go`, `pkg/boarddrawer/scene.go`, `pkg/boarddrawer/scene_test.go`, `pkg/boarddrawer/prompt.go`, `pkg/boarddrawer/prompt_test.go`, `pkg/boarddrawer/drawer-prompt.md`, `pkg/boarddrawer/drawer.go`, `pkg/boarddrawer/drawer_test.go`
**Files:** `pkg/wshrpc/wshserver/wshserver_boarddrawer.go`, `pkg/wshrpc/wshserver/wshserver_boarddrawer_test.go`, `pkg/wshrpc/wshserver/wshserver_boardforward.go`, `pkg/wshrpc/wshserver/wshserver_boardforward_test.go`

**What to build:** each drawer answer is either a new drawing or an edit of the drawing in view, never anything
else. `BoardAskCommand` stores `data.DrawingId` on the turn; Draw instead (`wshserver_boardforward.go`, which copies
`SelectedIds` today) copies it too. `SceneSummary` reads frames and each element's `frameId` into the scene (frame
lines with their title as `label`; a `frame` key on member shapes) and records each shape's frame for the check. The
turn prompt names the drawing in view (id and title) when the turn's `DrawingId` is a live frame, and says there is
none otherwise. The prompt (wording is the worker's) tells the drawer: one idea per drawing, a few words per box, no
paragraphs; more to say means another drawing; a follow-up that changes the drawing in view (simpler, more detail,
about selected shapes) sets `"edit": true` and changes only that drawing; a new question gets a new drawing in its
own coordinates, which Arc places; an agent's request is always a new drawing. `CheckAnswer` gains the drawing in
view as an input and enforces the header's rules with the constants `MaxDrawingAdds = 40` and `MaxLabelWords = 12`.
The delivered `BoardAnswer` carries `Title`, and `DrawingId` = the drawing in view on an edit, empty on a new
drawing.

**Interfaces:** `Answer.Edit bool` (the reply's `edit` key). Delivered answers: `BoardAnswer.DrawingId` set exactly
when the answer is an edit.

**Acceptance:**
- An ask with `drawingid` stores it on the turn; Draw instead's new turn carries the original's `DrawingId`.
- A scene with frames lists each frame (type `frame`, its title as label) and marks member shapes with their frame.
- The turn prompt includes the drawing-in-view section exactly when `DrawingId` names a live frame (asserted on the
  inserted id and title, not on wording, per AGENTS.md "Prompt text gets no phrase tests").
- `CheckAnswer` refuses, each with its reason: `edit` with no drawing in view; an update or remove naming a shape
  outside the edited drawing or naming a frame; a new drawing with any update or remove; more than 40 `add` entries;
  a text or label over 12 words. It accepts an edit whose add, update and remove stay in the drawing, and a new
  drawing that only adds. These join the existing `CheckAnswer` table.
- A briefing, a draw request and a Keep it here turn deliver new drawings (`DrawingId` empty) even when the scene has
  frames; an answer that says `edit` on one fails the turn.
- A delivered answer carries the reply's title.

### Task 3: Boards open in view mode, with an Edit switch
**Depends on:** none
**Chunk:** Board opens in view mode, Edit switch
**Files:** `frontend/app/view/boards/boardstore.ts`, `frontend/app/view/boards/boardcanvas.tsx`, `frontend/app/view/boards/boardview.tsx`, `frontend/app/view/boards/boardstrip.tsx`, `frontend/app/view/boards/boardtalkmodel.ts`, `frontend/app/view/boards/boardtalkmodel.test.ts`
**Files:** `frontend/app/view/agents/workspaceboardtab.tsx`, `frontend/app/view/boards/boardssurface.tsx`, `scripts/cdp/scenarios-boards-ask.mjs`, `scripts/cdp/scenarios-boards-workspace.mjs`

**What to build:** every board opens as a viewer. `boardEditingAtom(boardId)` (boardstore, in memory, false at
start) drives Excalidraw's `viewModeEnabled={!editing}` in `boardcanvas.tsx`: no drawing toolbar, no style panel,
clicks and drags pan. The new `boardstrip.tsx` sits above the canvas in both the workspace board tab and the Boards
surface and holds the Edit button at its right end (E-EditSwitch's button: pencil icon, "Edit", `aria-pressed`,
accent border and wash when on, theme tokens only). Pressing Edit toggles the atom; turning it off clears the
selection and active tool. Nothing else changes the mode: switching surfaces, tabs or boards keeps it. Show is
unchanged and still outlines in view mode. `askBox` takes whether Edit is on: in view mode the hint is "Press Edit
to ask about shapes" and no Selected chip shows; with Edit on it is as today. `useBoardView`'s ask sends the
selection only while Edit is on. Existing scenario steps that select shapes to ask about them turn Edit on first.

**Interfaces:** `boardEditingAtom(boardId: string): PrimitiveAtom<boolean>` in `boardstore.ts`;
`BoardStrip` in `boardstrip.tsx` takes `boardId` and leaves a slot (children or a prop) for Task 5's drawings row on
its left. `askBox(talk, selection, busy, wontOpen, editing: boolean)`.

State changes and moments: the Edit button's on/off is a press micro-interaction (moment 7); the toolbar appearing
is Excalidraw's own.

**Acceptance:**
- `askBox` returns the view-mode hint and no selected chip when not editing, whatever the selection; as today when
  editing (joins the existing `askBox`/`askInput` tables in `boardtalkmodel.test.ts`).
- Scenario `boards-ask`, a new step "board opens in view mode": the canvas has no Excalidraw toolbar
  (`.App-toolbar` absent), Edit reads `aria-pressed="false"`, the input reads "Press Edit to ask about shapes", and a
  drag across a shape leaves the shape's x and y unchanged.
- `boards-ask`, a new step "Show outlines in view mode": Show sets the turn's shapes as Excalidraw's selection while
  view mode holds, and no style panel shows.
- `boards-ask`, a new step "Edit brings the tools back": pressing Edit shows the toolbar, a selected shape gives the
  Selected chip and an ask sends its ids; pressing Edit again returns to view mode with the selection cleared.
- `boards-workspace`, a new step: Edit turned on in the agent's board tab is still on for that board on the Boards
  surface and after switching back.
- The existing selection steps in both scenarios pass with Edit turned on first.

### Task 4: Drawings in the board's scene
**Depends on:** Task 1 (uses BoardAnswer's title and drawingid types)
**Files:** `frontend/app/view/boards/boardmodel.ts`, `frontend/app/view/boards/boardmodel.test.ts`, `frontend/app/view/boards/boarddrawings.ts`, `frontend/app/view/boards/boarddrawings.test.ts`

**What to build:** the pure scene logic for drawings (no React, no Excalidraw runtime), as the header decides.
`applyAnswer` lands a new drawing as a frame titled with `answer.title`, numbered, placed right of everything on the
board and holding the added shapes; an edit adds its shapes to frame `answer.drawingid` and refits that frame to its
children (a frame gone since the ask makes the answer a new drawing). Before landing, a board with live shapes and no
frame is wrapped in one frame titled "Earlier drawings" (`wrapEarlier`, also used by the canvas on load).
`shapeCount` does not count frames. `boarddrawings.ts` reads the drawings and answers which is in view and which a
selection names. Whatever Excalidraw needs of a frame and its children (element order, `frameId`, bound text inside
the frame) is this task's to get right: a landed drawing must render with every child inside its frame.

**Interfaces:**
```ts
// boarddrawings.ts
export interface Drawing { id: string; n: number; title: string; bounds: { minX: number; minY: number; maxX: number; maxY: number } }
export interface ViewRect { scrollX: number; scrollY: number; zoom: number; width: number; height: number } // Excalidraw appState terms
export function drawingsOf(elements: readonly ExcalidrawElement[]): Drawing[]; // live frames, by number; hand frames after
export function drawingInView(drawings: readonly Drawing[], view: ViewRect): string | null; // largest visible share
export function askedDrawing(elements: readonly ExcalidrawElement[], selectedIds: readonly string[], inView: string | null): string | null;
// boardmodel.ts
export function wrapEarlier(scene: BoardScene, now: number): BoardScene; // the same object when nothing to wrap
// AnswerResult gains: drawingId: string (the frame the answer landed in, new or edited)
```

**Acceptance:**
- A new-drawing answer on an empty board makes one frame numbered 1, titled with the answer's title, whose bounds
  contain every added shape; on a board with drawings it is numbered max+1 and sits entirely right of every existing
  shape, top-aligned with the topmost.
- An edit answer adds shapes into the named frame, the frame's bounds grow to contain them, no frame is added, and
  `drawingId` is that frame; an edit naming a gone frame lands as a new drawing.
- `wrapEarlier` wraps a frameless board with shapes into one "Earlier drawings" frame numbered 1, and returns the
  scene unchanged for an empty board or one that has a frame.
- `drawingInView` returns the drawing with the largest visible area, the newest when zoomed inside it, and null when
  no frame is visible; `askedDrawing` returns the one frame all selected shapes share, else `inView`.
- `shapeCount` is unchanged by adding a frame.

### Task 5: The drawings row, and the view follows the newest drawing
**Depends on:** Task 3, Task 4 (uses drawingsOf, drawingInView, askedDrawing, wrapEarlier and AnswerResult.drawingId)
**Chunk:** One drawing at a time, findable
**Files:** `frontend/app/view/boards/boardstrip.tsx`, `frontend/app/view/boards/boardcanvas.tsx`, `frontend/app/view/boards/boardview.tsx`, `frontend/app/view/boards/boardstore.ts`, `frontend/app/view/boards/boardtalkmodel.ts`, `frontend/app/view/boards/boardtalkmodel.test.ts`
**Files:** `frontend/app/view/agents/workspaceboardtab.tsx`, `frontend/app/view/boards/boardssurface.tsx`, `scripts/cdp/scenarios-boards-ask.mjs`, `scripts/cdp/scenarios-boards-workspace.mjs`

**What to build:** the drawings row in `BoardStrip` (A-Slides chips: mono number then title; the current one in
accent, `aria-current="true"`; a "new" mark on a drawing that landed while not following), in both views. The canvas
wraps an old board on load (saved), publishes the board's drawings, the drawing in view and following on every
viewport and scene change, and `BoardCanvasControl` gains `fitDrawing(id)`. A row click fits that drawing. A live
answer that lands a new drawing while following fits it; otherwise the view stays and the drawing is marked new. An
edit refits the drawing it changed. `boardViewportAtom` stores following, and a reopened board fits its newest
drawing when it was left following, else restores the viewport; a first open fits the newest drawing. The ask sends
`drawingid`: `askedDrawing(...)` of the Edit selection, else the drawing in view. The facts' drawings count uses the
row's count once the canvas has loaded. The row hides when the board has no drawings.

**Interfaces:** `BoardCanvasControl.fitDrawing(id: string): void`; `BoardViewport` gains `following: boolean`.

State changes and moments: a chip entering for a new drawing (moment 1); the current marker moving between chips
(moment 9, a `layoutId` indicator); the facts' drawings count changing (moment 12, as today).

**Acceptance:**
- `boards-ask`, a new step "drawings row": a board with three drawings shows three chips numbered 1-3 with their
  titles; clicking chip 1 fits drawing 1 (its frame inside the canvas's visible rect) and marks chip 1 current.
- `boards-ask`, a new step "a new drawing is fitted": with the newest drawing in view, a fed new-drawing answer adds
  chip 4, marks it current, and its frame is wholly inside the visible rect.
- `boards-ask`, a new step "the view stays on an earlier drawing": with chip 1 current, a fed new-drawing answer
  leaves the viewport (scrollX, scrollY, zoom) unchanged and marks the new chip new; clicking it clears the mark.
- `boards-ask`, a new step "a follow-up edits the drawing in view": an ask sends `drawingid` = the current drawing;
  a fed edit answer for it changes that drawing's shapes and adds no chip.
- `boards-ask`, a new step "an old board opens as Earlier drawings": a board made with frameless shapes opens with
  one chip "Earlier drawings", and the saved file holds that frame.
- `boards-workspace`, a new step: in the narrow board tab the row shows, and a drawing landed through the page's live
  apply is wholly inside the tab's visible canvas.
- A reopened board left following fits its newest drawing; one left on an earlier drawing restores its viewport
  (a `boards-ask` step, switching boards away and back).
