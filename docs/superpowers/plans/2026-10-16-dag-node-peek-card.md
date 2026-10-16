# DAG node peek card

**Verify:** `node scripts/verify.mjs ./pkg/waveobj`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
**Final:** `node scripts/cdp/final-verify.mjs dag-peek dag-lifecycle dag-observability model-picks final-stage`
**Prototype:** C:/Users/kael02/IdeaProjects/waveterm/.superpowers/design/dag-detail-rail/project/Main.dc.html

**Goal:** the DAG modal's two per-node surfaces (the hover peek `TaskPeekCard` behind a `Tooltip` in
`frontend/app/view/orchestrate/dagnodes.tsx`, and the rail under the graph, `DagDetailRail` / `DagFinalRail`) become one
click-opened card that floats beside the selected node. `Main.dc.html` draws it for a task node, `Final.dc.html` (same
folder) for the final-stage node. That board's "mock only" switch is not UI: each of its six positions (waiting, running,
verifier running, failed, unverified, stopped by you) is a state the card must reach.

**Why:** the rail is a flex sibling of the ReactFlow pane in `daggraph.tsx`. Every change in its height (selecting a node,
Description, the escalate picker, the error line, the model-pick row, the End final stage form) resizes the pane, and the
re-centre effect then pans the graph: layout shift. A card floating over the graph never resizes the pane.

**Spec:** none. The canvas settles the design. The decisions below are the ones the canvas leaves open.

## Decisions beyond the canvas

1. **Names and files.** The node is already "the card" in code (`DagCardNode`, `DagCardData`), so the new surface is
   *the peek*, matching the canvas's `data-dag-task-peek` / `data-dag-final-peek`. Pure logic goes into the existing
   `dagpeek.ts`, which already derives the peek's rows. The shared shell and its placement hook are `dagpeekcard.tsx`,
   the task body is `dagtaskpeek.tsx`, and the final-stage body is `dagfinalpeek.tsx`. `dagdetailrail.tsx` and
   `dagfinalrail.tsx` are deleted. Why: one name per thing, and no `.ts`/`.tsx` pair sharing a basename.
2. **Interface first.** Task 1 lands the pure logic, the shell, and the two body components as stubs with their final
   signatures. It also moves the graph's open helpers (`openTaskFromGraph`, `openFinalFromGraph`) into the body files.
   The task body, the final body and the graph integration can then proceed side by side.
3. **Placement is the shell peek's (`frontend/app/view/agents/shelltaskpeek.tsx`), bounded by the graph pane.** The
   placement is floating-ui `right-start` with `offset`, `flip` (fallback `left-start`), `shift` and `size`, all with the
   pane element as `boundary`. That keeps the card off the 300px timeline rail and above the bottom drawer below 1100px.
   `hide` hides the card while its node is panned out of the pane. `strategy: "absolute"`, rendered inside the pane div,
   no portal. The reference is the node's DOM element, so the card follows pans, zooms and drags through
   `autoUpdate(..., { animationFrame: true })`. Why animationFrame: ReactFlow pans with a CSS transform, which none of
   autoUpdate's scroll/resize observers see. One element while one card is open costs nothing measurable.
   Constants: width 420px (the canvas's `PEEK_W`), gap 12px, pane padding 12px.
   **The card never covers the graph's controls.** The canvas draws the card (z 5) over the zoom cluster (z 4), so a
   card beside a top-right node would leave Fit / Zoom / Reset layout unclickable while it is open. The controls column
   (`absolute right-3 top-3`: zoom cluster, plus Reset layout when shown) gets `data-dag-controls`. Its measured width
   plus the pane padding is a right inset on the placement boundary (`peekMiddleware`'s right padding), so flip, shift
   and size never let the card reach that strip. Why a strip, not a corner: floating-ui takes one rectangular boundary,
   and the strip costs at most the column's width beside a node at the far right, where the card flips left anyway.
4. **The card is not mounted until floating-ui reports it positioned** (`isPositioned`), so it never flashes at 0,0.
5. **Opening and closing.** The card shows exactly when `selectedTaskIdAtom` names a task or the final node. A node
   click toggles. The second click of a double-click (`event.detail > 1`) never closes, so a double-click still selects
   and opens the worker or verifier without the card blinking shut. Esc already clears the selection before it closes
   the modal (`escapeDagModal`). The pane click already clears it. The close button clears it. Hover opens nothing.
   The node keeps its hover highlight and `hoveredTaskAtom`, which the timeline reads.
6. **Per-node card state resets by key.** The graph mounts the task peek as `key={task.id}`, so Description, the
   escalate picker and the action error never follow the selection to another node. The `useEffect` reset and
   daggraph's `descOpen` state go away.
7. **Re-centre.** The pan runs once per selection, after the card is first placed, never on a pane resize or a card
   that grew. It pans only when `selectionNeedsPan` says the node is out of view (`nodeInView`) or its screen rect
   intersects the card's. Why: the canvas places the card beside the node, so a pan is only due when the pane is too
   narrow for either side, or the node was off-screen to begin with.
8. **Action bar.** `peekActions` keeps the engine's action order from `buildViewData` and moves `escalate` last. Labels
   are sentence case: Retry, Skip, Escalate…, Approve, Send back, Merge, Resolve; an unknown action shows itself,
   capitalised. The first action is the filled primary. Escalate, when it is not first, is the outline accent button,
   accented while its picker is open, as the canvas draws it.
9. **Review row.** `DagViewNode.reviewLine` splits into `review: { state, route }` (state = `reviewStateText`, route =
   "same as lead · <model>" or "reviewer route · <model>"), because the canvas puts them on two lines with the state
   toned.
10. **Tokens row** always shows: the usage text and its per-model line, or "none yet" before any usage, as the canvas
    does. The rail hid it.
11. **Description.** The lead (`descriptionLead`) is clamped to 3 lines. "Read the full description" expands the full
    Markdown inside the card's scrolling body ("Show less" collapses it). The toggle shows only when there is more than
    the lead. The card's max height comes from the `size` middleware, so the body scrolls and the bar stays put. The
    canvas's expanded state (bullets, then "Done when: `…`") is how a plan task's description is written, so rendering
    the description's own Markdown draws it; the card adds no structure of its own.
12. **The End final stage form opens inside the card**, between the body and the bar, from the bar's End final stage
    button (`data-final-end`, `aria-expanded`). It reuses `EndFinalForm`; `EndFinalStage`'s absolute popover stays for
    the Agent surface pane. `END_FORM_ROOM_PX` and `DESC_MAX_PX` die with the rails.
13. **Final steps are a vertical list.** One row per step: mark, label, command, state text. A step with kept output
    opens it under its row; the live output tail and the outcome stay visible. This extends the shared `FinalStepList`
    with an optional `showCommand`. The Agent rail's use of it is unchanged.
14. **Bar hint:** "double-click opens its worker · Esc closes" for a task. For the final stage, "double-click opens the
    verifier · Esc closes" while a verifier session exists, else "Esc closes".
15. **Tokens:** @theme tokens only (DESIGN.md), no new ones. The canvas's hexes map to the tokens the rail and node
    already use: `bg-surface-raised` for the card, `bg-surface` for the bar and session box, `border-edge-mid` /
    `border-edge-strong`, `bg-surface-code` for pre blocks, accent / accent-soft / success / warning / error,
    `shadow-popover-lg`.

## DOM contract (the scenarios read these)

- Task peek: `<section data-dag-task-peek={id} aria-label="{id} details">`, close button
  `aria-label="Close task details"`. The Worker row element carries `data-dag-node-route="source:runtime:model"`. The
  model row keeps `data-model-pick={id}` with its `[role=group]` toggle buttons and its "Plan reviewer: …", "waiting"
  and "you changed it" text. The Verify block is `data-dag-peek-verify={id}`. The escalate panel is
  `data-dag-peek-escalate`. Each bar button is `data-dag-peek-action={action}`. The action error is `role="alert"`. The
  session texts "Not dispatched yet", "Worker session unavailable", "View child run" and "Open in Agent ↗" are kept.
- Final peek: `<section data-dag-final-peek aria-label="Final verification details">`, close button
  `aria-label="Close final stage details"`. Each step row has `data-final-step` / `data-final-step-state`, its state text
  in `span.whitespace-nowrap` (`StepText`) and its command in a `span[title]`, and `aria-expanded` when it has kept output.
  Also kept: `data-final-output`, `data-final-past-round`, `data-final-shots-link`, the "Open in Agent ↗" button, the bar's
  `data-final-end`, and the form's `data-run-sheet-end-final` inside the card.
- Graph controls: the column holding the zoom cluster and Reset layout carries `data-dag-controls`.

### Task 1: Peek logic, shell and stub bodies
**Depends on:** none
**Files:** `frontend/app/view/orchestrate/dagpeek.ts`, `frontend/app/view/orchestrate/dagpeek.test.ts`, `frontend/app/view/orchestrate/dagcanvas.ts`, `frontend/app/view/orchestrate/dagcanvas.test.ts`, `frontend/app/view/orchestrate/dagstore.ts`, `frontend/app/view/orchestrate/dagstore.test.ts`, `frontend/app/view/orchestrate/dagpeekcard.tsx`, `frontend/app/view/orchestrate/dagtaskpeek.tsx`, `frontend/app/view/orchestrate/dagfinalpeek.tsx`, `frontend/app/view/orchestrate/dagnodes.tsx`, `frontend/app/view/orchestrate/dagdetailrail.tsx`, `frontend/app/view/orchestrate/dagfinalrail.tsx`, `frontend/app/view/orchestrate/daggraph.tsx`

The interface every other task builds on. Nothing visible changes yet: the rails still render.

- `dagpeek.ts` gains:
  - `PEEK_W_PX = 420`, `PEEK_GAP_PX = 12`, `PEEK_PAD_PX = 12`, `PEEK_PLACEMENT = "right-start"`.
  - `peekMiddleware(boundary: Element | Rect, rightInsetPx: number)`, the floating-ui middleware list from decision 3:
    offset; flip with a `left-start` fallback; shift; size writing `maxHeight`/`availableHeight` into the floating
    element's style; hide. Flip, shift and size use padding `PEEK_PAD_PX` on every side but the right, which uses
    `rightInsetPx` (the controls column's width plus `PEEK_PAD_PX`). Import from `@floating-ui/react`.
  - `peekActions(actions: string[]): { action: string; label: string; primary: boolean; picker: boolean }[]`, per
    decision 8. `picker` is `dagActionRoute(action) === "pick-route"`.
  - `nextSelection(current: string | null, clicked: string, clickCount: number): string | null`, per decision 5.
- `dagcanvas.ts` gains `selectionNeedsPan(viewport, pos: Point, pane: Pane, card: Rect | null): boolean` beside
  `nodeInView`, per decision 7. `card` is in pane pixels.
- `dagstore.ts`: `DagViewNode.reviewLine` becomes `review: { state: string; route: string }` (decision 9). The rail
  joins the two with " · " until it is deleted.
- `dagnodes.tsx`: export `StateGlyph` and a `finalGlyph(tone: FinalTone): GlyphKind` (today's `FINAL_GLYPH` lookup), for
  the peek headers.
- `dagpeekcard.tsx`:
  - `export type PeekPlace = { anchor: HTMLElement; boundary: HTMLElement; rightInsetPx: number; onClose: () => void; onPlaced?: (card: Rect) => void }`.
  - `export function DagPeekCard(props: { place: PeekPlace; attrs: Record<string, string>; label: string; closeLabel: string; glyph: GlyphKind; title: ReactNode; meta: ReactNode; children: ReactNode; panel?: ReactNode; actions?: ReactNode; hint: string })`
    is the canvas's card: header (glyph, title, meta row, × close), scrolling body (`children`), optional `panel`
    (escalate picker, end form, error), bottom bar (`actions` left, `hint` right). It owns the `useFloating` call
    (decisions 3 and 4). `onPlaced` fires with the card's rect relative to `boundary` once it is positioned for the
    current anchor. `attrs` spreads the `data-dag-*-peek` attribute onto the `<section>`. Clicks and pointer-downs inside
    stop propagating.
  - Export the bar's button classes (`PEEK_BTN`, `PEEK_BTN_PRIMARY`, `PEEK_BTN_ACCENT` with an open variant), so both
    bodies style actions alike.
- `dagtaskpeek.tsx`: `export function DagTaskPeek(props: { group: TaskGroup; owner: Run; view: DagViewNode; task: TaskNode; digestTask: DagTaskDigest | undefined; briefs: Map<string, TaskBrief>; place: PeekPlace })`.
  For now it renders the shell with the header and hint only. `openTaskFromGraph` (and the `openFromGraph` it uses) move
  here from `dagdetailrail.tsx`. The rail imports `openFromGraph` from here meanwhile.
- `dagfinalpeek.tsx`: `export function DagFinalPeek(props: { group: TaskGroup; owner: Run; view: FinalStageView; place: PeekPlace })`,
  the same kind of stub. `openFinalFromGraph` and `verifierTabId` (exported) move here from `dagfinalrail.tsx`, which
  imports them meanwhile. `daggraph.tsx` imports both openers from their new homes.

Tests (vitest, beside the code):
- `npx vitest run frontend/app/view/orchestrate/dagpeek.test.ts`:
  - `peekActions`: order kept with escalate moved last; sentence-case labels; first is primary; escalate is `picker`; an
    empty list yields none.
  - `nextSelection`: open, switch, toggle closed, and a second click of a double-click keeps the selection.
  - `peekMiddleware` through `computePosition` with a rect-only platform (no DOM):
    - the card sits right of the node, top-aligned, 12px off;
    - a node near the pane's right edge flips the card to its left;
    - a node low in the pane shifts the card up, or caps its height, so its bottom stays inside the pane;
    - a node outside the pane reports `hide.referenceHidden`;
    - with a right inset, a card beside a node near the top-right never reaches into the inset strip.
- `npx vitest run frontend/app/view/orchestrate/dagcanvas.test.ts -t selectionNeedsPan`: false for a visible node with
  no card or a card beside it; true when the card covers it, and true when the node is out of view.
- `npx vitest run frontend/app/view/orchestrate/dagstore.test.ts`: `buildViewData` gives `review.state` and
  `review.route` for a same-as-lead and a custom reviewer route.

### Task 2: Task peek body
**Depends on:** Task 1
**Files:** `frontend/app/view/orchestrate/dagtaskpeek.tsx`, `frontend/app/view/orchestrate/modelpicksview.tsx`

Fill `DagTaskPeek` with everything `TaskPeekCard` and `DagDetailRail` show today, laid out as `Main.dc.html` draws it,
in this order:

- Header meta row: id · state word in its node tone · gate chip · branch (`view.meta`).
- Body:
  - the worker's activity line (`ActivityLine`);
  - the `taskPeek` rows;
  - the worker session (port `SelectedTaskWorker` from `dagdetailrail.tsx`: status line + Open in Agent ↗, Not
    dispatched yet, or Worker session unavailable + View child run, boxed as the canvas does);
  - a `dl` with Worker (`runtime / model`, then `routeSourceLabel · resolvedModel`), Review (decision 9, the state
    success-toned when it passed and warning-toned when it failed), Model and Tokens (decision 10);
  - the description (decision 11);
  - the Verify block (`taskPeek(...).verify`).
- Panel:
  - the escalate picker: "Re-queue <id> on", the `RoutePicker`, "One judged hop: a second failure blocks this task
    for you.", Cancel / Re-queue on model, disabled until a route is picked;
  - the action error line (`dagActionError` text, `role="alert"`).
- Bar: `peekActions(view.actions)` buttons (`data-dag-peek-action`), and the hint from decision 14.

Port `runAction` / `runEscalate` from the rail, so a refusal shows on the card instead of vanishing.
`TaskModelPick` in `modelpicksview.tsx` is restyled into the card's `dl` row (switch while waiting, read-only "running
on …" line while running). Its signature and `data-model-pick` contract stay, because the rail still renders it until
Task 4 deletes the rail. Follow the DOM contract above exactly.

Acceptance: Check passes; `npx vitest run frontend/app/view/orchestrate` passes. Task 5's scenario steps show the
rendered states:
- `dag-peek` a (running card), b (expanded description), d (gate card: chip, Approve primary, Send back), e (failed
  card with the escalate picker, route picked, Re-queue enabled), f (action error line), g (waiting card);
- `model-picks` 1b (a waiting task's card with its model toggle) and 4 (toggling it to "you changed it");
- `dag-observability` 5 and 7 (Not dispatched yet; Open in Agent).

### Task 3: Final-stage peek body
**Depends on:** Task 1
**Files:** `frontend/app/view/orchestrate/dagfinalpeek.tsx`, `frontend/app/view/agents/finalstageviews.tsx`, `frontend/app/view/agents/finalstage.ts`, `frontend/app/view/agents/finalstage.test.ts`

Fill `DagFinalPeek` as `Final.dc.html` draws it, for all six states.

- Header: `finalGlyph(view.tone)`, "Final verification", and the meta row `final · round N · <state word in its tone>`
  with ` · ended by you` when a human ended the stage, then the round's time. If `FinalStageView` cannot tell an
  ended-by-you stage, add a boolean to it in `finalstage.ts` from the existing `endedByHuman`, with a test in
  `finalstage.test.ts`.
- Body:
  - the verifier: the session row (status line + Open in Agent ↗ via `openFinalFromGraph`) when `verifierTabId` finds
    one, with its activity line; otherwise a dashed line saying when it starts or why it did not run (from today's
    `verifierLine`, worded as the board does);
  - a `dl` Verifier row (route, then "same as lead" / "reviewers route");
  - the steps as a vertical list (decision 13: add `showCommand` to `FinalStepList`, keeping its other callers'
    output);
  - the live output tail (`FinalOutput`) under a "<step> output · live" label;
  - the outcome (`FinalOutcome`: detail, unverified reasons including an ended-by-you reason, earlier rounds, under an
    "Earlier rounds" label as the board does; a small optional prop on a shared view is fine, the Agent pane must render
    as before);
  - `FinalShotsLink`.
- Panel: the End final stage form inside the card (decision 12), with an engine refusal shown beside the bar's button.
- Bar: End final stage while `finalStageEndable(group)`, and the hint from decision 14.

Follow the DOM contract above exactly.

Acceptance: Check passes; `npx vitest run frontend/app/view/agents/finalstage.test.ts` passes, including any new
ended-by-you test. Task 5's scenario steps show the six states:
- the `final-stage` scenario's DAG shots: `b1-waiting-dag`, `a6-dag-peek` (running, renamed from `a6-dag-rail`),
  `a6-dag-peek-end-form` (the form inside the card), `b4-reviewing-dag` (verifier running), `b5-failed-dag`,
  `b5b-kept-dag` (a step's kept output open under its row), `b8-unverified-dag` and `a7-ended-dag` (ended by you);
- `dag-peek` step i (the five-step waiting card, placement).

### Task 4: Graph integration and removal of the peek and rails
**Depends on:** Task 1
**Files:** `frontend/app/view/orchestrate/daggraph.tsx`, `frontend/app/view/orchestrate/dagnodes.tsx`, `frontend/app/view/orchestrate/dagdetailrail.tsx`, `frontend/app/view/orchestrate/dagfinalrail.tsx`

- `daggraph.tsx`:
  - Render `DagTaskPeek` (`key={task.id}`, with the selected task's `digestTask` and `taskBriefs(group)`) or
    `DagFinalPeek` inside the pane div, positioned by the shell. `place.anchor` is the selected node's element (resolve
    it after the nodes render), `place.boundary` is the pane element, `place.rightInsetPx` is the measured width of the
    controls column (now `data-dag-controls`) plus `PEEK_PAD_PX`, and `place.onClose` clears `selectedTaskIdAtom`.
  - Delete the rail branch under the pane, `descOpen`, and its reset effect.
  - `onNodeClick` uses `nextSelection(current, n.id, event.detail)`.
  - Replace the re-centre effect with decision 7: once per selection, from `onPlaced`, pan with today's `setCenter` only
    when `selectionNeedsPan` holds. No `paneRect` or `descOpen` dependency.
- `dagnodes.tsx`: remove the `Tooltip`, `TaskPeekCard`, `PEEK_OPEN_DELAY_MS`, and the imports only they used. Keep the
  hover highlight and `onHover`. `digestTask` / `briefs` leave `DagCardData` if nothing on the node reads them any more.
- Delete `dagdetailrail.tsx` and `dagfinalrail.tsx` (`git rm`). Grep first: every import, `import type` and re-export of
  them, of `DESC_MAX_PX` and `END_FORM_ROOM_PX`, and `PEEK_OPEN_DELAY_MS`, must be gone.

Acceptance: Check passes; `npx vitest run frontend/app/view/orchestrate` passes; `git grep -n "dagdetailrail\|dagfinalrail\|DESC_MAX_PX\|END_FORM_ROOM_PX\|PEEK_OPEN_DELAY_MS\|TaskPeekCard" -- frontend`
prints nothing. Task 5's `dag-peek` steps show the behaviour:
- a: the card beside the node, inside the pane, clear of the timeline rail and the controls; no pane resize or pan on
  open;
- b: no shift when the card grows;
- c: the second click toggles it closed;
- h: the card flips left of a node at the pane's right edge;
- i: placement beside the rightmost final node;
- j: Esc;
- k: a background click;
- l: hover opens nothing.

### Task 5: CDP scenarios
**Depends on:** Task 2, Task 3, Task 4
**Files:** `scripts/cdp/scenarios.mjs`

Update every scenario that read the hover peek or the rails, and add `dag-peek`. Do not run prettier on this file.

- `dag-lifecycle`: step 5b becomes "hover opens nothing": dispatch the same hover events, wait past the old 400ms delay,
  and assert that no `[data-dag-task-peek]` and no `[data-dag-peek]` exists. Step 5d also asserts that the click opened
  `[data-dag-task-peek]` and that Esc removed it while the modal stayed.
- `dag-observability`: steps 5 and 7 read the texts inside `[data-dag-task-peek]` instead of the whole modal.
- `model-picks`: `DAG_RAIL_ROUTE` and the pick-row reads point into `[data-dag-task-peek]`. Update the asserted route
  text to the card's Worker row. The banner rows outside the card keep their count.
- `final-stage`:
  - `FST_DAG_RAIL` becomes `[data-dag-final-peek]`;
  - the kept-output reads use `aria-expanded` instead of `aria-pressed`, and B5b expects the outcome to stay visible
    beside an opened step;
  - the end-form check asserts that the form is inside the card and that neither the card nor any clipping ancestor
    cuts it;
  - rename the shots `a6-dag-rail` / `a6-dag-rail-end-form` to `a6-dag-peek` / `a6-dag-peek-end-form`, and keep
    `b1-waiting-dag`, `b4-reviewing-dag`, `b5-failed-dag`, `b5b-kept-dag`, `b8-unverified-dag` and `a7-ended-dag`, so
    each of the Final board's six states, the end form and an opened step have a shot.
- `model-picks`: after step 2, add step 1b, which shoots the waiting t-2's card with its model toggle
  (`cdp-shots/model-picks-1b-card.png`). Step 4's toggle then shows "you changed it" in the card.
- New `dag-peek` scenario (add it to `SCENARIOS`), following `docs/reference/cdp-run-fixtures.md`. Arrange:
  - `arrangeSheetDagRun` with its own task list `DAG_PEEK_TASKS`, four no-op tasks:
    - t-1, no deps, whose description is a lead paragraph, three bullets and a "Done when: `…`" line, so there is more
      than the lead;
    - t-2, `gate: true`, no deps;
    - t-3, no deps;
    - t-4, deps `t-1`.

    With parallelism 1 only t-1 dispatches; `waitForDispatch` waits for it.
  - Set `ctx.dagId` from `dagstatus`. In one `seedDag`, seed:
    - t-2 `state: "done"` (a done gate offers Approve and Send back);
    - t-3 `state: "failed"` with `escalations: 0` (Retry, Skip, Escalate…);
    - the dag's `check`, `verify` and `finalcmd` commands (any no-op strings), with no `final`.

    The dag is not finalizing, so the engine leaves the stage alone, and the final node is the board's waiting state
    with five rows: Tree, Check, Verify, Final, Verifier.
  - Pin the viewport to 1600x950.

  Open the DAG from the run sheet. Then assert, recording each as a step:
  - a. clicking t-1 opens `[data-dag-task-peek="t-1"]` beside its node: its left edge past the node's right edge, or
    its right edge before the node's left edge. It is entirely inside the graph pane, clear of `[data-timeline-rail]`,
    and does not intersect `[data-dag-controls]`. The pane's rect and `.react-flow__viewport`'s transform are unchanged
    by the open. Shot `cdp-shots/dag-peek-running.png`.
  - b. "Read the full description" expands the bullets and the Done when line inside the card; the pane rect and
    transform are still unchanged. Shot `cdp-shots/dag-peek-description.png`.
  - c. a second click on t-1 closes the card.
  - d. clicking t-2 opens its card: a gate chip, and the bar Approve (primary, `data-dag-peek-action="approve"`) and
    Send back. Shot `cdp-shots/dag-peek-gate.png`.
  - e. clicking t-3 opens its card with the bar Retry (primary), Skip, Escalate…. Clicking Escalate… shows
    `[data-dag-peek-escalate]` with Re-queue on model disabled. Picking a route in its picker enables Re-queue on
    model. Shot `cdp-shots/dag-peek-failed-escalate.png`. Then Cancel; nothing is sent.
  - f. the action error: a refusal is put in place on the page, because a real retry would be accepted and the
    engine would race the check (a seeded DAG proves the UI, not the engine).
    - Replace `RpcApi.DagActionCommand` once with a rejection carrying a fixed reason. Import the app's own module
      instance through the dev server, as the `/@fs` / `/frontend/...` imports of other scenarios do, and check it is
      the instance the card calls.
    - Click Retry on t-3, and assert `[data-dag-task-peek="t-3"] [role="alert"]` reads `retry t-3 failed: <reason>`.
    - Shot `cdp-shots/dag-peek-action-error.png`, then restore the method.
  - g. clicking t-4 opens the waiting card with "Not dispatched yet". Shot `cdp-shots/dag-peek-waiting.png`.
  - h. flip: reopen t-1's card, then pan the graph with a CDP mouse drag (`Input.dispatchMouseEvent`) on empty pane
    background until t-1's right edge is within 200px of the pane's right edge. A pan persists no layout, unlike a node
    drag. The card's right edge is then left of the node's left edge, inside the pane and clear of the controls. Shot
    `cdp-shots/dag-peek-flipped.png`. Fit the graph again (`[aria-label="Fit graph"]`).
  - i. clicking the final node opens `[data-dag-final-peek]` with rows tree, check, verify, final, verifier, each with
    a command `span[title]`. It is inside the pane, clear of `[data-timeline-rail]` and `[data-dag-controls]`. Shot
    `cdp-shots/dag-peek-final.png`.
  - j. Esc closes the card and leaves the modal open.
  - k. reopen the final card; a background (pane) click closes it.
  - l. hovering a node for 700ms opens nothing.

  Teardown with `teardownFixtureRun`.

Acceptance: `node scripts/cdp/verify.mjs` syntax-loads (`node --check scripts/cdp/scenarios.mjs`), and
`task verify:ui -- dag-peek dag-lifecycle dag-observability model-picks final-stage` passes against a dev app built
from this branch (the Final line runs the same set).
