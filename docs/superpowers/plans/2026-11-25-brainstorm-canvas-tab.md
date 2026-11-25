# Brainstorm agents get their Canvas tab in Rendered; Esc works after a click on a board

The rule "an agent with a brainstorm never shows its canvas" goes in the Rendered view (Terminal keeps it), the
Canvas tab tags the rows an open question names and opens them through the question's scoped window, and the
canvas window's keys keep working after a click on a board.

Decisions beyond the design, with why:
- **Esc cause, corrected.** A board is served by wavesrv's web listener (`getWebServerEndpoint()`, 127.0.0.1) while
  the app runs on Vite's :5174 or the packaged origin, so the board iframe is cross-origin to the host:
  `allow-same-origin` keeps the board's own origin, not the app's. The host cannot listen inside it. Fix: `pkg/canvasserve`
  injects a small key relay script into every `.html` it serves, which posts each keydown the board did not handle
  to `window.parent`; `BoardIframe` (canvaspane.tsx) accepts messages only from its own iframe's window and origin and
  re-dispatches them as a keydown on its iframe element, so ModalShell's window listener and the keybinding
  dispatcher see them as if focus were in the host. Rejected: refocusing the host after a click (kills typing in
  interactive boards); editing `skills/design/support.js` (each canvas holds its own copy, existing canvases keep
  the old one).
- **Relay rules.** Nothing is relayed for a key the board handled (`defaultPrevented`) or when the board is the top
  window (Open in browser). From an editable field in a board only Escape is relayed, matching the host, where an
  editable focus mutes bare keys but Esc still closes a modal.
- **Every BoardIframe gets the relay**, so the Terminal canvas center (same trap: its selected board takes the
  click) is fixed by the same change. The Canvas tab's previews take no pointer (`pointerEvents: none`) and never
  hold focus, so they have no trap.
- **Canvas keys in Rendered.** bindings.ts's `canvas()` returns the focused canvas in Rendered even with a
  brainstorm, so `[ ]` and `m` work on its Canvas tab. With both tabs in the pane, `b` and `c` switch between
  them: in Rendered, `agent:brainstorm-open` / `agent:canvas-open` fire while their own kind is not the one shown
  (not only while nothing is), the `-close` bindings keep firing only on their own kind, so each key pair stays
  exclusive. Ctrl+Shift+B (`agent:view-chord`) still goes to the brainstorm, with `on = shown() !== "brainstorm"`,
  so with the Canvas tab active it shows the Brainstorm tab instead of closing it. Terminal keeps `canvas()` null
  for a brainstorm agent, where shown() is only ever the brainstorm or nothing, so these gates change nothing there.
- **The agent tree's PaneTag stays the brainstorm chip in both views**; only its comment changes.
- **Tagged rows only for the brainstorm's own canvas**: a Canvas tab row is tagged only when the tab's canvas topic
  equals the brainstorm file's `canvas` (openQuestionBoard would otherwise re-attach the agent to another canvas).
  The scope the tags read and the scope openQuestionBoard opens come from one new function in brainstormstore.ts,
  `openQuestionScope(s)`, a wrapper over brainstormwindowmodel.ts's existing `questionScope`.
- **store.test.ts's brainstorm case** keeps its Terminal assertions (Terminal keeps the rule) and loses any that
  pin the canvas standing down in Rendered; the Rendered rule's own cases (agentpanes.test.ts's Rendered "never
  shows the canvas", renderedbsboardsmodel's "one its brainstorm holds") are deleted.
- **Board Main's turn end**: auto-open offers Brainstorm only with a wait or a run, while Main shows the Brainstorm
  tab at "nothing asked". So the step opens the Brainstorm tab before the turn, and the turn brings only the canvas
  reveal: Canvas joins behind the shown Brainstorm tab, unseen (a pane in use keeps showing its tab). The
  Brainstorm-wins priority with a wait is a unit case, not a scenario step.
- **Scenario placement**: the turn-end and untagged Canvas tab steps go in workspace-auto-open (Task 1); the Esc
  steps go in workspace-brainstorm-canvas's canvas-only part (Task 2), so Tasks 1 and 2 run side by side; the tagged
  rows and scoped window steps also go in workspace-brainstorm-canvas (Task 3, after both).

**Verify:** `node scripts/verify.mjs ./pkg/canvasserve`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
**Final:** `node scripts/cdp/final-verify.mjs workspace-auto-open workspace-brainstorm-canvas`
**Prototype:** C:\Users\kael02\IdeaProjects\waveterm\.superpowers\design\brainstorm-canvas-tab\project\Main.dc.html

### Task 1: The Canvas tab for an agent with a brainstorm, in Rendered
**Depends on:** none
**Files:** `frontend/app/view/agents/autoopen.ts`, `frontend/app/view/agents/autoopenmodel.ts`, `frontend/app/view/agents/autoopenmodel.test.ts`, `frontend/app/view/agents/renderedbsboardsmodel.ts`, `frontend/app/view/agents/renderedbsboardsmodel.test.ts`, `frontend/app/view/agents/renderedbsboards.tsx`, `frontend/app/view/agents/agentpanes.ts`, `frontend/app/view/agents/agentpanes.test.ts`, `frontend/app/store/keybindings/bindings.ts`, `frontend/app/store/keybindings/store.test.ts`, `frontend/app/view/agents/agenttree.tsx`, `docs/agents/brainstorm.md`, `scripts/cdp/scenarios-workspace-auto-open.mjs`

Drop the rule in Rendered: autoopen.ts passes the canvas to `offers()` with a brainstorm attached;
`canvasRevealView` loses its `brainstorm` input (and its caller in renderedbsboards.tsx stops passing it);
`shownPane` in Rendered returns `"canvas"` while the active, uncollapsed tab is Canvas and the agent has a canvas,
`"brainstorm"` while it is Brainstorm; bindings.ts's `canvas()`, the `b`/`c` open gates and the view chord per the
header. Comments that state the rule (autoopen.ts, autoopenmodel.ts, agentpanes.ts, agenttree.tsx, bindings.ts's
`canvas()` comment and the view chord's "An agent has a brainstorm or a canvas, never both", store.test.ts) say it now holds in
Terminal only; docs/agents/brainstorm.md says the Rendered view's Canvas tab lists every board of the brainstorm's
canvas.

**Acceptance:**
- a turn end that brings a brainstorm wait and a reveal of the agent's canvas opens Brainstorm and adds Canvas
  behind it, unseen; the latest reveal of a brainstorm agent's canvas is `"card"`, an earlier one `"row-open"`
- Rendered, brainstorm + canvas, Canvas tab active: `paneShown` is `"canvas"`, and `]`/`[` move the list selection
  and `m` opens the window marking; Brainstorm tab active: `"brainstorm"`. Terminal: unchanged (brainstorm wins,
  canvas mode ignored)
- Rendered, brainstorm + canvas: with Canvas active, `b` shows the Brainstorm tab and Ctrl+Shift+B shows it too
  (both tabs stay open); with Brainstorm active, `c` shows the Canvas tab; `b` on Brainstorm and `c` on Canvas close
  their tab. store.test.ts's conflict-free table covers Rendered with each tab active, the open/close pair of each
  key never both matching
- the old rule's Rendered test cases are deleted, not kept beside the new ones
- scenario workspace-auto-open, new steps that attach a brainstorm (no question) to the fixture agent and detach it
  after (or run last, teardown detaching it), so the existing steps keep their canvas-only agent. Board Main: with
  the Brainstorm tab shown, a turn end that reveals the canvas leaves Brainstorm active, adds a Canvas tab behind it
  with the unseen dot, and draws the Mockup card on the reveal. Board CanvasTab: activating the Canvas tab lists
  every board, none with a `[data-canvas-tab-answer]` line, and `]` moves the selected row

### Task 2: Keys reach the host after a click on a board
**Depends on:** none
**Files:** `pkg/canvasserve/canvasserve.go`, `pkg/canvasserve/canvasserve_test.go`, `frontend/app/view/agents/canvaspane.tsx`, `frontend/app/view/agents/boardkeys.ts`, `frontend/app/view/agents/boardkeys.test.ts`, `scripts/cdp/scenarios-workspace-brainstorm-canvas.mjs`

The relay per the header: canvasserve serves `.html` with the relay script injected (before `</body>`, else
appended), keeping `Last-Modified` from the file (the poller's HEAD reads it) and HEAD working; other files are
served unchanged. The message shape and the host's accept/re-dispatch rules live in `boardkeys.ts` beside its test;
`BoardIframe` subscribes per instance and unsubscribes on unmount.

**Acceptance:**
- a served `.dc.html` carries the relay; `canvas.json` and `.js` are byte-identical to disk; a HEAD of a board
  returns the file's Last-Modified
- the host re-dispatches a relayed key only from its own iframe's window and the board origin; an editable-field
  key other than Escape is dropped
- scenario workspace-brainstorm-canvas, new step in the canvas-only part: open the canvas window from a Canvas tab
  row, a real mouse click on the board (`document.activeElement` is then the board's iframe), Escape closes the
  window; again in marking (`m`), a click on the board then Escape acts as it does with no click (canvasEscape);
  and in the Terminal canvas center, after a click on the selected board, a canvas key still acts. Keep in mind CDP
  key events may need page focus (assert the focus state before pressing, so a dead key reads as a failure)

### Task 3: Canvas tab rows an open question names
**Depends on:** Task 1 (the Canvas tab reachable on a brainstorm agent, which its scenario steps open), Task 2
**Files:** `frontend/app/view/agents/brainstormstore.ts`, `frontend/app/view/agents/brainstormstore.test.ts`, `frontend/app/view/agents/workspacecanvastabmodel.ts`, `frontend/app/view/agents/workspacecanvastabmodel.test.ts`, `frontend/app/view/agents/workspacecanvastab.tsx`, `docs/agents/brainstorm.md`, `scripts/cdp/scenarios-workspace-brainstorm-canvas.mjs`

Extract from `openQuestionBoard` the scope it opens into one exported function of the brainstorm state,
`openQuestionScope(s: BrainstormState): WindowScope | null` (brainstormwindowmodel.ts's `questionScope` over the
shown file, the brainstorm's board names and `judgeWait(f, s.sent != null)`, as today), used by `openQuestionBoard`
and the Canvas tab. The tag text is the matching `ScopeTab.label`.
A row whose board has a tab in that scope (and the tab's canvas is the brainstorm's, per the header) draws one more
line under the name, `data-canvas-tab-answer`: the question number in the warning tone, then that tab's `label`
(answerTabLabel's text via the scope, no new wording), truncated; clicking it calls `openQuestionBoard`. Every other
row, and every row once no question is open, opens `openCanvasWindow` unscoped as today. One sentence in
docs/agents/brainstorm.md for the tags.

**Acceptance:**
- with question n open (or its approaches while the judge weighs), a row for a board one answer alone names reads
  `n` and `"<answer number> · <answer label>"`, a board several answers name `"1, 2 · <board label>"`, a shared
  board `"Every answer"`; no tag while the agent writes over the question, for an unnamed board, or on another canvas
- scenario workspace-brainstorm-canvas, new step (board QuestionCanvasTabTagged): with question 4 open, the Canvas
  tab's named rows carry the tag line with 4 and the label, an unnamed row none; next step (board QuestionWindow):
  clicking a tagged row opens the canvas window with the question's answer tabs, band and Pick on that board; an
  untagged row opens the window with no band
