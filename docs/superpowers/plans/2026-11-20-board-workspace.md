# Board tab: simplified, and widened while a board is shown

**Verify:** `node scripts/verify.mjs ./pkg/wconfig`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
**Final:** `node scripts/cdp/final-verify.mjs workspace-pane boards-workspace`
**Prototype:** C:\Users\kael02\IdeaProjects\waveterm\.superpowers\design\board-workspace\project\Main.dc.html

The workspace pane's Board tab (`frontend/app/view/agents/workspaceboardtab.tsx`) loses its header line and its
stack of turn lines: the tab is the tab strip, the canvas and one ask bar under it (the board's agent chip, an
input group holding the selection chip, a one-line input and Ask, and the board's facts at the bar's end). Above
the bar, at most one line shows a turn that is drawing, needs you or failed. While a board tab is the shown tab
the pane widens to all of the row but the transcript's 360px. Boards in the canvas folder: **Main** (1440x900:
pane 1002px, idle with 2 shapes selected) and **States** (the bar idle with nothing selected, drawing, needs you,
failed, and a 1000px window where the pane is 562px). Frontend only: no Go, wshrpc or generated file changes.
Match layout, type and copy through the `@theme` tokens in `frontend/tailwindsetup.css` (no new tokens; map the
prototype's greys onto the nearest existing ones, as the current tab already does). Motion reuses
`motiontokens.ts` per `docs/reference/motion-system.md`. Read `DESIGN.md` before styling. Verify's `./pkg/wconfig`
is a placeholder: `scripts/verify.mjs` requires a Go pattern, and it picks the vitest and tsc runs from the changed
paths, so a frontend merge tests the frontend and no Go package.

## Decisions beyond the design

1. **"Widened" is a width rule, not a new pane shape.** While the shown tab is a board and the pane is open
   (not strip, not expanded), its width is `availablePx - MIN_TRANSCRIPT_PX` (the row less 360px, never under
   `MIN_PANE_PX`), so Main's 1362px row gives 1002px and States' 922px row gives 562px. Switching to another tab
   returns to the stored width, through the pane's existing width tween (`REVEAL`): you asked for the switch.
   Expanded and strip are unchanged.
2. **A board has its own width preference.** The resize handle stays on a board tab (the prototype draws its
   grip). A drag there commits to a new `workspaceBoardWidthAtom` (localStorage `agent.workspace.boardwidth`,
   `null` = the widest), never to `agent.workspace.width`, so narrowing a board does not shrink the Changes tab,
   and the board does not snap back after a drag. Double-click on a board tab returns it to the widest. Why not
   reuse the one stored width: then a board could never be wider than the other tabs, which is the design's point.
3. **The ask bar is the one ask control in both layouts.** Expanded (`ws.expanded`) keeps the full turns column
   (`BoardTalk`) on the left, but without its own ask box: `BoardTalkProps.ask` becomes optional and the Boards
   surface keeps passing it. The bar sits under the canvas in both layouts; the one-line status above it shows
   only beside the transcript, since the turns column already shows every turn when expanded.
4. **The line above the bar is the newest turn, and only while it is unresolved:** drawing (`waiting`: "Waiting";
   `answering`: "Drawing · 18 s", "Still drawing · …" past `SLOW_AFTER_MS`, the dot pulsing), a request waiting
   on your choice ("wants a new board", the prototype's fixed words, with New board from this and Keep it here),
   failed ("couldn't answer" with Retry), and a forward not yet in the transcript (sending, held: "waiting for
   <agent>", needs an agent; each with Draw instead). Answered, stopped, sent and replied turns show no line, so
   an idle board shows none (Main). This drops Show and Send to the agent from the beside layout; both stay in the
   expanded turns column. Why: the design keeps only the states that need attention or explain a disabled input.
5. **The input's placeholder carries the hint.** In flight: disabled, "You can ask once this answer lands", Stop
   in Ask's place while a turn answers (today's `askBox` rule). Idle with nothing selected: "Select shapes to ask
   about them". With a selection: the "Selected <label>" chip inside the group and "Ask the board". A board that
   won't open: disabled with today's won't-open hint, and the facts read "won't open". The needs-you and failed
   boards show "Ask the board" with nothing selected; the States board's first caption pins the idle rule, so the
   rule wins over those two fixtures. The input is one line (`<input>`): Enter asks, empty does nothing.
6. **The agent chip in the bar is bare and opens upward.** `BoardAgentChip` gains one prop for the bar: no
   "Agent" word, `aria-label` "Board agent: <label>", and its picker opening above the chip (at the pane's bottom a
   picker below would clip). The Boards surface keeps today's chip.
7. **The board's name leaves the tab body.** The tab strip already labels it (`Board · <name>`), and the facts
   move to the bar's end, where they ellipsize first: the input group keeps `flex: 1 1 320px; min-width: 200px`.

### Task 1: the pane widens while a board tab is shown
**Depends on:** none
**Files:** `frontend/app/view/agents/workspacemodel.ts`, `frontend/app/view/agents/workspacemodel.test.ts`, `frontend/app/view/agents/workspacestore.ts`, `frontend/app/view/agents/workspacepane.tsx`, `scripts/cdp/scenarios-workspace-pane.mjs`

**What to build:** decisions 1 and 2. A pure width rule in `workspacemodel.ts` beside `paneWidth` (a board's
stored width or `null`, and the room, to the open pane's width), guarding a non-finite room: `WorkspacePane` passes
`Infinity` while the row is unmeasured, and `null` must then give `DEFAULT_PANE_PX`, not `Infinity - 360`;
a persisted `workspaceBoardWidthAtom` in `workspacestore.ts` beside `workspaceWidthAtom` (same `getOnInit`
reason), and `WorkspacePane` choosing the rule by the shown tab's kind, committing a drag and resetting a
double-click into the atom of the shown tab's kind. The handle's title on a board tab reads "Drag to resize ·
double-click resets to full width"; other tabs keep today's.

**State changes and moments:** the pane growing to the board width and back on a tab switch uses the pane's
existing width tween (`REVEAL`, macro); a drag stays uneased.

**Acceptance:**
- the rule: `null` gives the room less 360, never under 360; a stored board width is clamped as `paneWidth`
  clamps; an `Infinity` room gives 600 for `null` and the stored width for a number (a row in the rule's tests)
- with a board tab shown in the open pane, the pane is the row's width less 360; showing the Changes tab returns
  it to the stored width; expanded and strip are unchanged with a board shown
- a drag on a board tab writes `agent.workspace.boardwidth` and leaves `agent.workspace.width` unchanged; it holds
  across a switch away and back; double-click on a board tab returns it to the widest
- scenario `workspace-pane`: new steps that open a board tab (a board made in arrange the way
  `scripts/cdp/scenarios-boards-ask.mjs` makes one, removed in teardown with the new key restored like the
  others) and assert, with a screenshot, the pane at row less 360 at the scenario's 1600px viewport; the switch
  to Changes and back; the board drag and double-click; and at a 1000px-wide viewport the pane at row less 360
  (States board, last frame: 562px when the row is 922px)

### Task 2: the Board tab: no header, one ask bar, one line
**Depends on:** none
**Files:** `frontend/app/view/agents/workspaceboardtab.tsx`, `frontend/app/view/boards/boardtalkmodel.ts`, `frontend/app/view/boards/boardtalkmodel.test.ts`, `frontend/app/view/boards/boardtalk.tsx`, `frontend/app/view/boards/boardagentpicker.tsx`, `scripts/cdp/scenarios-boards-workspace.mjs`

**What to build:** decisions 3 to 7. `WorkspaceBoardTab` drops `Header` and `Lines`; under the canvas (both
layouts) an ask bar per Main: the bare agent chip (when the board has a talk, as today), the input group (the
selection chip, the one-line input, Ask or Stop), and the facts (`boardFacts`, or "won't open"). Above it, beside
the transcript only, the single line of decision 4, with the prototype's per-state look (States board: the green
pulsing dot and "Drawing · 18 s"; the amber-bordered needs-you row with its two actions; the error icon,
"couldn't answer" and Retry). The line's and the input's rules are pure functions in `boardtalkmodel.ts`
(the line from the talk and `now`; the placeholder, disabled state and selection chip from `askBox`'s result),
replacing `besideLines`, `BESIDE_TURNS`, `BesideLine` and `drawerWorking`; delete whatever else the change
leaves unused there, with its tests. `BoardTalk` renders no ask box when `ask` is absent. Choices keep today's
`onChoice` (New board from this goes to the Boards surface's form).

**State changes and moments:** the line appearing and leaving above the bar reveals and collapses (6); a line
changing state in place (drawing to failed) washes its detail once (14), keyed on the line's state, never its
text, since the seconds tick every second; the needs-you row breathes (3); the
drawing dot pulses (7); the selection chip enters and leaves (1).

**Acceptance:**
- the line rule returns nothing for an idle talk (answered, stopped, sent, replied newest turn) and the line of
  decision 4 for each unresolved state, using the newest turn only
- the input rule gives decision 5's placeholder, disabled state, chip and Stop for: in flight, idle with and
  without a selection, and a board that won't open
- a failed line's Retry re-asks that turn; a needs-you line's Keep it here keeps it and New board from this
  opens the Boards form; Enter in the input asks, and an empty input does nothing
- the Boards surface's talk column still shows its ask box (`BoardTalk` given `ask`)
- scenario `boards-workspace`: W1 rewritten to the new tab, each with a screenshot: idle with 2 shapes selected
  (no header, no line; chip, "Selected …" chip, "Ask the board", Ask, facts at the bar's end: Main board); idle
  with nothing selected ("Select shapes to ask about them"); drawing (the line with its seconds, the input
  disabled with "You can ask once this answer lands", Stop); needs you (both actions, Keep it here clears the
  line); failed (Retry re-asks); a drawing turn failing in place keeps one line whose detail washes once (14),
  and a ticking drawing line does not wash; selecting shapes shows the selection chip and clearing the
  selection removes it (1); a 1000px-wide viewport where the facts are truncated and the input group is at
  least 200px wide. That step asserts no pane width: without Task 1 the pane is the stored width, and Task 1's
  scenario owns widths.
- scenario `boards-workspace`, removed behaviour: delete the "W1 new turn" step (the two-line list with the
  oldest leaving, `readLines`, `lineOf`); rewrite `readTab` to read the bar and the single line instead of
  `data-board-tab-header`, `-tab-name`, `-facts` in the header and `data-board-drawing`; in W2, replace the
  after-Back assertions on `lines == [r4, r5]` and `drawing` with the bar and the single line (the drawing
  line while a turn answers, none when idle), and assert the expanded turns column has no ask box with the bar
  under the canvas. The steps "join on draw", "open from Boards", "toast off-screen" and "Escape with the board
  mounted twice" read none of the removed hooks and stay as they are, passing.
