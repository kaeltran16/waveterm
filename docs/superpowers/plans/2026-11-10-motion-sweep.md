# Motion sweep: animate the UI built since the motion revamp Implementation Plan

**Verify:** `node scripts/verify.mjs ./pkg/wavebase`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
**Final:** `node scripts/cdp/final-verify.mjs motion-run-sheet motion-dag-peek motion-peeks motion-final motion-brief motion-brief-controls motion-brainstorm motion-lens motion-agent motion-diff motion-code motion-gaps dag-motion jarvis-motion run-sheet-polish dag-peek final-stage final-shots brief-surface brief-peek brief-profile new-run-window brainstorm-mode workflow-scan doc-review agent-composer shell-tasks sessions-list git-history diff-compare settings-storage code-sidebar code-search project-overview`

**Goal:** every state change in the UI built after the 2026-07-04 motion revamp reads as a change instead of a
cut. About 60 components added since then import nothing from the motion layer: panels snap open, errors
appear in one frame, counts jump, a selected item swaps its content in place. Map each of those changes onto
the shared vocabulary, and add eight new primitives where the existing moments cannot say what changed.

**Why a plan and not a spec:** the moments, the guardrails and the feel are settled in
`docs/reference/motion-system.md` and `DESIGN.md`; the only new design is the primitives below, recorded here
and, by Task 1, in the motion reference.

**Verify note:** this plan changes no Go. `verify.mjs` needs a Go pattern, so it names the cheap `./pkg/wavebase`;
at a merge it runs the vitest suites related to the changed paths, and in the final stage all of vitest.

**Final note:** besides the eleven new scenarios and the three that own existing moments, Final reruns one
existing scenario per area the tasks touch (`run-sheet-polish` through `project-overview`). Turning a
conditional into `PaneReveal` can break a scenario that counts absence, and the workers rerun those only on
their own lane; Final is the only check on the merged result.

## Rules for every task

- **Read first:** `docs/reference/motion-system.md`, `frontend/app/element/motiontokens.ts`,
  `frontend/app/element/motionhooks.ts`, and the shared components `element/panereveal.tsx`,
  `element/crossfade.tsx`, `element/popoverreveal.tsx`. Import every duration, ease and variant from the token
  module; never inline a number, keyframe or cubic-bezier.
- **The rejection test still holds:** a moment ships only if it makes a state change more legible. Each task
  lists the changes its audit found. A listed site that turns out not to change on screen is skipped with one
  sentence in the report; a state change the audit missed may be added from the same primitives.
- **No entrance cascade.** Nothing animates when a populated view mounts or when a surface is switched to:
  `initial={false}` on every `AnimatePresence`, `computeEntrances` (keyed on the entity) for lists, and the
  "after mount" guards in the new primitives. Only changes that happen while the view is on screen move.
- **Reduced motion is not optional.** Inline `motion.*` needs a `MotionConfig reducedMotion="user"` ancestor;
  check the surface root (most surfaces have one, the Code surface and the run sheet may not) and add one at the
  component's root if none. CSS moments carry `motion-reduce:` variants. Reduced motion keeps the information
  (the final state, the error, the new number) and drops the movement.
- **Never ease a live 1:1 interaction** (wheel zoom, drag, typing). Numbers that change on their own every
  second or faster (elapsed clocks, resmon readings, token counts while streaming) never tick: a roll every
  second is noise, not a state change.
- **Animate transform and opacity** (and height through `PaneReveal`/`AutoHeight` only). `layout` goes on
  containers, never on text that streams.
- **Keep every hook an existing scenario uses:** ids, `data-*` attributes, roles, aria labels and keyboard
  behavior stay as they are. A disclosure rendered as `{open ? <X/> : null}` becomes an unconditional
  `<PaneReveal open={open}>`; any scenario that counted the element's absence must still pass (the exit leaves
  it attached for `durExit`, so a step that checks absence right after a click must wait for it).
- **Each surface task owns one scenario file** `scripts/cdp/scenarios-motion-<area>.mjs`, created as a stub by
  Task 1. Arrange the data by reusing the arrange of the existing scenario named in the task (import its
  helpers; do not copy fixtures). Assert each moment the task adds with the patterns in `motion-gaps`
  (`scenarios-cockpit.mjs`: a `MutationObserver` records the computed opacity of a node as it is added, then
  the settled value) and `dag-motion` (`scenarios-runs.mjs`): mounts at opacity `0` (or a mid-flight transform)
  and settles at `1`/`none`, an exit stays attached mid-fade and is then removed. One step per task runs under
  `h.cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] })` and
  shows the same change landing with no intermediate frame; teardown resets the media emulation.
- **Done means seen.** Before reporting, run the task's scenario and the surface's existing scenarios named in
  the task in the dev app (`task verify:ui -- <names>`), and look at the shots. Report any scenario that could
  not run, by name.
- Check lint and format on touched paths only (`npx eslint <paths>`, `npx prettier --check <paths>`; not on
  `scripts/*.mjs`). Comments say why, lower case, only where needed.

## Decisions: the new primitives

Task 1 adds these to `motiontokens.ts` (variants, transitions, class strings), `motionhooks.ts` (hooks) or
`element/` (components that own their `MotionConfig` and `AnimatePresence`), each with a "why" comment, and
records them in the motion reference as moments 10-17.

| # | Primitive | What moves | Says | Used for |
|---|---|---|---|---|
| 10 | `stepSlide` variants + `StepSwap` component | content leaves and enters 16px along x, direction from a `dir` prop (+1 next, -1 previous), opacity with it; `durMacro` in, `durExit` out, `mode="wait"` so two never overlap | "you moved forward/back through a sequence" | question N → N+1, screenshot ← →, board switch |
| 11 | `barFillClass` | a CSS transition on `flex-grow`, `width` and `transform` over `durMacro`/`easeFluid`, with `motion-reduce:transition-none` | "progress moved by this much" | task strips, review progress, storage bars, chunk segments |
| 12 | `TickNumber` component | a number that changes rolls: the old value slides up and fades, the new one rises in, `durMicro`; tabular-nums, width reserved so neighbours never shift; renders plain text on mount and under reduced motion | "this count just changed" | spend, tallies, deltas, comment counts |
| 13 | `errorNudge` variants | an inline error, on appearing after a user action, nudges x `[0,-4,4,-2,2,0]` once over `durExit` (Framer drops the x under reduced motion, the error still shows) | "your action failed, here" | save, start, end, cancel and send failures |
| 14 | `useChangeFlash(value)` + `@keyframes changeFlash` | a one-shot background wash, `color-mix` of `--color-accent` at 18% fading to transparent over ~1.2s, when a value changes after mount (never on mount); reduced motion: no wash | "this value changed under you" | a run's next step, a task's state, a peek's facts |
| 15 | `AutoHeight` component | a container's height follows its content (ResizeObserver) over `durMacro`; the first measure snaps | "this card grew/shrank because its content did" | peeks loading, answer bar, the selected-task peek |
| 16 | `DrawCheck` component | an SVG check whose path draws (`pathLength` 0 → 1, `durMacro`) when it appears after mount; mounted already-done it is drawn | "this just finished" | brainstorm steps, Final steps, review complete |
| 17 | `morphTransition` token | the `transition` for a `layout`/`layoutId` element moving between two places or sizes (`durMacro`, `easeFluid`) | "this is the same thing, now here" | screenshot Fit ↔ Actual, chip selection, a row moving between sections |

Existing moments keep their jobs: `PaneReveal` for every disclosure, `composerReveal` through
`PaneReveal variants` for short strips (an error line, a notice), `viewFade` for a pane trading what it shows,
`CrossFade` for a mark or label swapping in place (busy ↔ idle buttons, copied), `PopoverReveal` for menus,
`cardVariants` + `computeEntrances` for items arriving in a list, `popLayout` + `layout` for exits and reflow,
`indicatorSlide` on a `layoutId` for a selection moving across siblings.

## Recurrence

Nearly everything built after the revamp shipped without motion, because no step asks for it. Task 1 adds one
line to the plan rules in `AGENTS.md` ("Plans the engine runs"): a task that builds a view names the state
changes it adds and the moment each uses, and its scenario step shows one of them. That is the rule plan
writers and the plan reviewer already read; no new check is built.

### Task 1: The new primitives, scenario stubs, docs
**Depends on:** none
**Files:** `frontend/app/element/motiontokens.ts`, `frontend/app/element/motiontokens.test.ts`, `frontend/app/element/motionhooks.ts`, `frontend/app/element/motionhooks.test.ts`, `frontend/app/element/stepswap.tsx`, `frontend/app/element/ticknumber.tsx`, `frontend/app/element/ticknumber.ts`, `frontend/app/element/ticknumber.test.ts`, `frontend/app/element/autoheight.tsx`, `frontend/app/element/drawcheck.tsx`, `frontend/tailwindsetup.css`, `docs/reference/motion-system.md`, `DESIGN.md`, `AGENTS.md`, `scripts/cdp/scenarios.mjs`
**Files:** `scripts/cdp/scenarios-motion-run-sheet.mjs`, `scripts/cdp/scenarios-motion-dag-peek.mjs`, `scripts/cdp/scenarios-motion-peeks.mjs`, `scripts/cdp/scenarios-motion-final.mjs`, `scripts/cdp/scenarios-motion-brief.mjs`, `scripts/cdp/scenarios-motion-brief-controls.mjs`, `scripts/cdp/scenarios-motion-brainstorm.mjs`, `scripts/cdp/scenarios-motion-lens.mjs`, `scripts/cdp/scenarios-motion-agent.mjs`, `scripts/cdp/scenarios-motion-diff.mjs`, `scripts/cdp/scenarios-motion-code.mjs`

Build primitives 10-17 from the table above.

- Tokens and pure logic are unit-tested: `motiontokens.test.ts` guards the new values (durations reuse
  `MOTION`, `errorNudge` ends at 0, `stepSlide` maps `dir` to the sign of x in and out). `useChangeFlash` keeps
  its edge logic in a pure helper (a value equal to the previous does not flash; the first value does not
  flash) tested in `motionhooks.test.ts`. `TickNumber`'s direction and width logic go in `ticknumber.ts`
  (up when the new value is larger, down when smaller; reserved width = the longer of old and new formatted
  strings) with `ticknumber.test.ts`.
- `StepSwap`, `TickNumber`, `AutoHeight` and `DrawCheck` own their `MotionConfig reducedMotion="user"` and,
  where they exit, their `AnimatePresence initial={false}`, as `PaneReveal` does.
- `@keyframes changeFlash` goes beside `settle` and `freshMark` in `tailwindsetup.css`, token-colored with
  `color-mix(in oklab, var(--color-accent) 18%, transparent)`, with a `motion-reduce` rule that removes it.
  Export the class string from `motiontokens.ts` as a literal (as `settleClass` is) so Tailwind sees it.
- `DrawCheck` draws the same 12×12 check path `brainstormui.tsx` inlines today and takes a `className` for its
  color; it is the only new SVG.
- Docs: add moments 10-17 to the moments table in `docs/reference/motion-system.md` and the new files (plus the
  existing `element/panereveal.tsx`, missing from it) to its foundation table; extend the Motion bullet in
  `DESIGN.md` with one sentence naming the new primitives. Add the recurrence line from this plan's
  "Recurrence" section to the "Plans the engine runs" list in `AGENTS.md`.
- Create the eleven `scripts/cdp/scenarios-motion-<area>.mjs` stubs. Each exports one scenario named
  `motion-<area>` (the names in this plan's Final line), with the `surface` its task's views live on
  (the surface of the task's first arrange scenario, which `scripts/cdp/verify.mjs` opens with
  `h.goto(scenario.surface)`: `jarvis` for run-sheet, dag-peek, peeks, brief, brief-controls; `agent` for
  final (`final-stage`) and brainstorm; `usage` for lens (`workflow-scan`); `cockpit` for agent
  (`agent-composer`); `files` for diff; `code` for code), an empty `arrange`, an `assert` returning one step
  `{ step: "stub: filled by its surface task", ok: true }`, and a no-op `teardown`. Import all eleven into
  `scripts/cdp/scenarios.mjs` and append them to `SCENARIOS` after `motion-controls`, in this plan's Final
  order. Surface tasks only edit their own stub. A task whose views span surfaces keeps the stub's surface
  and calls `h.goto(<surface>)` in its `assert` before the steps for a view elsewhere (final-shots on
  `jarvis`; canvas on `agent` and doc review on `cockpit`; sessions on `sessions`; storage on `settings`;
  code peek on `agent` and project pages on `cockpit`); it may change its own stub's `surface` if that reads
  better.
- Show the primitives: add steps to the existing `element-primitives` scenario only if it can mount an element
  in isolation; otherwise the surface tasks' scenarios are their visual proof, and the report says so.

### Task 2: Run sheet
**Depends on:** Task 1 (uses the primitives it adds and fills the stub it creates)
**Files:** `frontend/app/view/jarvis/runsheet.tsx`, `frontend/app/view/jarvis/runtimingview.tsx`, `frontend/app/view/jarvis/runreportview.tsx`, `frontend/app/view/jarvis/taskdetail.tsx`, `frontend/app/view/jarvis/decisionlog.tsx`, `scripts/cdp/scenarios-motion-run-sheet.mjs`

Arrange from `run-sheet-polish`, `run-timing` and `task-detail`; rerun those, `run-sheet-done` and
`run-sheet-cards` after.

- `runsheet.tsx`: the goal disclosure (`goalOpen`) and the event timeline (`timelineOpen`) go through
  `PaneReveal` with the chevron on `turnTransition`; the body swap (`body === "report"` vs the default body)
  is a `viewFade` keyed on `body`; the task strip's done/total bars take `barFillClass` and its segments
  `transition-colors` at `durMicro` so a segment changing state recolors instead of jumping; the spend
  (`spent`) is a `TickNumber`; `status.next` takes `useChangeFlash`; the save/end/retry buttons
  (`saving`, `ending`, `canRetry`) swap their labels with `CrossFade`; the "saved" note (`savedFor`) and
  `result` arriving use `viewFade`; timeline rows arriving while the sheet is open enter with `cardVariants`
  through `computeEntrances` keyed on the run id.
- `runtimingview.tsx`: its `open` disclosure through `PaneReveal`. `runreportview.tsx`: the `raw` toggle is a
  `viewFade` keyed on `raw`.
- `taskdetail.tsx`: `pending` → loaded content inside `AutoHeight`; `detail.state` takes `useChangeFlash`.
- `decisionlog.tsx`: the add form (`adding`) through `PaneReveal` with `composerReveal`; a decision added
  while open enters with `cardVariants`; a card's status label swaps with `CrossFade`.

### Task 3: DAG graph and its peeks
**Depends on:** Task 1 (uses the primitives it adds and fills the stub it creates)
**Files:** `frontend/app/view/orchestrate/daggraph.tsx`, `frontend/app/view/orchestrate/daggraph-header.tsx`, `frontend/app/view/orchestrate/dagtaskpeek.tsx`, `frontend/app/view/orchestrate/dagfinalpeek.tsx`, `frontend/app/view/orchestrate/dagpeekcard.tsx`, `scripts/cdp/scenarios-motion-dag-peek.mjs`

Arrange from `dag-peek` and `dag-motion`; rerun those and `dag-observability` after. The DAG nodes already
animate (`dagnodes.tsx`); leave them.

- `daggraph.tsx`: the selected-task peek (the `selectedTask && selectedView` / `FINAL_NODE_ID` branch) appears
  with `PopoverReveal` (origin toward its node) instead of mounting in place; selecting another task while one
  is open keeps the card and `viewFade`s its content keyed on the task id inside an `AutoHeight`, so the card
  resizes to the new task instead of being replaced.
- `dagtaskpeek.tsx`: `actionError` appears through `PaneReveal` (`composerReveal`) and plays `errorNudge`;
  `escalating` swaps with `CrossFade`; the verify tail and the clamped rows' `open` disclosures through
  `PaneReveal`; the `overflows` "more" control fades in with `microFade`.
- `dagfinalpeek.tsx`: `ending` confirm swaps with `CrossFade`; `endError` reveals and nudges as above.
- `daggraph-header.tsx`: `cancelError` reveals and nudges; the `finalizing` status label takes
  `useChangeFlash`; `adjusting` swaps with `CrossFade`.
- `dagpeekcard.tsx`: rows arriving while `status === "live"` enter with `cardVariants` via `computeEntrances`
  keyed on the card; the empty → rows swap is a `viewFade`.

### Task 4: Hover and ctrl-click peeks
**Depends on:** Task 1 (uses the primitives it adds and fills the stub it creates)
**Files:** `frontend/app/view/jarvis/peekitem.tsx`, `frontend/app/view/jarvis/peek/peekrun.tsx`, `frontend/app/view/jarvis/peek/peekagent.tsx`, `frontend/app/view/jarvis/peek/peekeffort.tsx`, `frontend/app/view/jarvis/bubblecard.tsx`, `scripts/cdp/scenarios-motion-peeks.mjs`

Arrange from `peek-item-views` and `peek-ctrl-click`; rerun those and `jarvis-peek` after.

- `peekitem.tsx`: the peek body inside `AutoHeight`; `loading` → content and → `gone` are a `viewFade` keyed on
  the status, so a peek grows to its content instead of jumping from a one-line loader.
- `peekrun.tsx`: the tasks and commits sections arrive through `viewFade`; the tasks count is a `TickNumber`.
- `peekagent.tsx`: the done mark (`agentRunDone`) is a `DrawCheck`; files and rows sections `viewFade` in.
- `peekeffort.tsx`: the segment bar takes `barFillClass`; the done line / remaining swap is a `viewFade`.
- `bubblecard.tsx`: the `more` count is a `TickNumber`.

### Task 5: Final stage and the screenshot viewer
**Depends on:** Task 1 (uses the primitives it adds and fills the stub it creates)
**Files:** `frontend/app/view/agents/finalstageviews.tsx`, `frontend/app/view/agents/finalstagepane.tsx`, `frontend/app/view/jarvis/finalshotsviewer.tsx`, `scripts/cdp/scenarios-motion-final.mjs`

Arrange from `final-stage` and `final-shots`; rerun those and `final-rerun` after.

- `finalstageviews.tsx`: a step's `isOpen` detail, a line's `open` and `viewing` panes, and the third `open`
  disclosure through `PaneReveal`; a step's state glyph swaps with `CrossFade`, and a step that passes while on
  screen draws its check with `DrawCheck`; the unverified list and `past` list sit in `AutoHeight`; `ending`
  and `busy` buttons swap with `CrossFade`.
- `finalstagepane.tsx`: the running → kept → failed swap of the shown step is a `viewFade` keyed on its state;
  `view.state === "failed"` appearing plays `errorNudge` only when it follows the user's rerun, else a plain
  `viewFade`.
- `finalshotsviewer.tsx`: ← → between screenshots is a `StepSwap` with `dir` from the key or button; ↑ ↓
  between scenarios and a round switch are a `viewFade` keyed on scenario/round; the Fit ↔ Actual size toggle
  (`zoom`) moves the image with `layout` on `morphTransition`; the `StepsDrawer` (`stepsOpen`) reveals with
  `PaneReveal` (or a width reveal if it sits beside the stage, tokens only); the round tally is a `TickNumber`.

### Task 6: Initiative brief pages
**Depends on:** Task 1 (uses the primitives it adds and fills the stub it creates)
**Files:** `frontend/app/view/jarvis/briefsheet.tsx`, `frontend/app/view/jarvis/briefpeekview.tsx`, `frontend/app/view/jarvis/briefrowviews.tsx`, `frontend/app/view/jarvis/briefbehind.tsx`, `scripts/cdp/scenarios-motion-brief.mjs`

Arrange from `brief-surface`, `brief-peek` and `brief-initiatives-polish`; rerun those, `brief-peeks-polish`
and `jarvis-motion` after. `jarvis-motion` owns the brief's existing moments (`fresh-mark`, lists); keep them.

- `briefsheet.tsx`: the record band (`bandOpen`) through `PaneReveal`; the face body swap (channel run vs
  channel vs effort) a `viewFade` keyed on the face; the launch `error` reveals with `composerReveal` and plays
  `errorNudge`; `launching` swaps with `CrossFade`.
- `briefpeekview.tsx`: the objective (`objectiveOpen`) and decisions (`decisionsOpen`) disclosures and
  `bodyMore` through `PaneReveal`; `runsLoading` → runs or `runsAbsent` a `viewFade` inside `AutoHeight`; the
  `asking` line arriving takes `useChangeFlash`.
- `briefrowviews.tsx`: a row's `expanded` resume detail through `PaneReveal`; `face.asking` and `face.canStop`
  controls appear with `microFade`; the chunk label (`face.chunkLabel`) takes `useChangeFlash`.
- `briefbehind.tsx`: `deltaTotal` is a `TickNumber`; the shipped filter menu (`shippedFilter.menu`) through
  `PopoverReveal`; a filter change swaps the shipped list with `viewFade`.

### Task 7: Brief controls and new-run setup
**Depends on:** Task 1 (uses the primitives it adds and fills the stub it creates)
**Files:** `frontend/app/view/jarvis/briefrunsheet.tsx`, `frontend/app/view/jarvis/briefprofileview.tsx`, `frontend/app/view/jarvis/newruncontrol.tsx`, `frontend/app/view/jarvis/newinitiativecontrol.tsx`, `frontend/app/view/jarvis/effortcreateform.tsx`, `frontend/app/view/jarvis/projectpickerview.tsx`, `frontend/app/view/jarvis/projectchips.tsx`, `scripts/cdp/scenarios-motion-brief-controls.mjs`

Arrange from `brief-profile`, `new-run-window`, `new-run-defaults` and `new-run-design`; rerun those and
`new-run-attachments` after.

- `briefrunsheet.tsx`: the copy control (`copied`) moves onto `useCopyFeedback` + `CrossFade` like
  `copybutton.tsx`; the inline editor's `open` through `PaneReveal`; `invalid` and `error` reveal with
  `composerReveal`, and `error` plays `errorNudge`; `notice` fades with `microFade`; `turningOn`/`turningOff`
  waiting labels swap with `CrossFade`.
- `briefprofileview.tsx`: `reset.show` and the `inherited` badge swap with `CrossFade`; `pending` → loaded in
  `AutoHeight`; switching between the global and a project profile is a `viewFade` keyed on the scope; the
  save button (`saving`) swaps with `CrossFade`.
- `newruncontrol.tsx`: the orchestrator-only rows (`orchestrator`) reveal with `PaneReveal`; changing
  `startFrom` swaps its row (design / plan / goal) with `viewFade`; the route `current.error`/`current.result`
  swap with `CrossFade`; a start `error` reveals and plays `errorNudge`; `starting` swaps with `CrossFade`.
- `newinitiativecontrol.tsx` / `effortcreateform.tsx`: `NewInitiativeHost` mounts the form with
  `open ? <EffortCreateForm/> : null`, so closing cuts past `ModalShell`'s exit; pass `open` through to
  `ModalShell` (the form stays mounted under its `AnimatePresence`) so it exits as other modals do. In the
  form, `error` reveals with `composerReveal` and plays `errorNudge`; the `submitting` label
  ("Creating…") swaps with `CrossFade`. Keep `data-jarvis-new-initiative` and the drift-view mount in
  `scenarios-cockpit.mjs` (`EffortCreateForm` with `{ onClose() {} }`) working: `open` defaults to true.
- `projectpickerview.tsx`: the dropdown (`open`) through `PopoverReveal`.
- `projectchips.tsx`: the picked chip's highlight (`on = name === picked`) is one `layoutId` element that slides between chips on
  `indicatorSlide`, as the palette scope tabs do (`palette-chrome.tsx`).

### Task 8: Brainstorm
**Depends on:** Task 1 (uses the primitives it adds and fills the stub it creates)
**Files:** `frontend/app/view/agents/brainstormui.tsx`, `frontend/app/view/agents/brainstormreview.tsx`, `frontend/app/view/agents/brainstormcheck.tsx`, `frontend/app/view/agents/brainstormrun.tsx`, `scripts/cdp/scenarios-motion-brainstorm.mjs`

Arrange from `brainstorm-mode` and `brainstorm-answer-boards` (and the arrange in
`scenarios-brainstorm-review.mjs` / `-run.mjs` for those views); rerun those and the brainstorm scenarios of
the files touched after.

- `brainstormui.tsx`: the progress list's done check becomes `DrawCheck` (replacing the inlined SVG), and the
  current-step dot is one `layoutId` element moving to the next step on `indicatorSlide`; moving to another
  question (`goTo`) is a `StepSwap` with `dir` from the question order; the `shown`, `open` and `factsShown`
  disclosures through `PaneReveal`; an option's `pick` mark swaps with `CrossFade`; the side pane (`side`)
  content swap is a `viewFade` keyed on what it shows; `busy` swaps with `CrossFade`.
- `brainstormreview.tsx`: a row's `open` detail through `PaneReveal`; `editing` swaps the cell with `viewFade`;
  the changed and answered counts are `TickNumber`s.
- `brainstormcheck.tsx`: the `main` state swap (question / builder / judging / working) is a `viewFade` keyed
  on `main`; `ask.total` and `ask.calls` are `TickNumber`s; `blocker` reveals with `composerReveal`.
- `brainstormrun.tsx`: `view.merged` arriving draws a `DrawCheck`; `error` reveals and plays `errorNudge`.

### Task 9: Workflow lens, canvas, doc review
**Depends on:** Task 1 (uses the primitives it adds and fills the stub it creates)
**Files:** `frontend/app/view/agents/workflowlensview.tsx`, `frontend/app/view/agents/canvaspane.tsx`, `frontend/app/view/agents/docreviewdialog.tsx`, `frontend/app/view/agents/commentsendbar.tsx`, `scripts/cdp/scenarios-motion-lens.mjs`

Arrange from `workflow-scan`, `canvas-swap`, `canvas-mark` and `doc-review`; rerun those, `workflow-scan-entry`,
`canvas-tabs` and `doc-review-notes` after.

- `workflowlensview.tsx`: the phase swap (`scanning` / `applying` / `done`) is a `viewFade` keyed on the kind;
  the stage list marks a finished stage with `DrawCheck`; a card's `open` "more" through `PaneReveal`; a card
  the user drops leaves with `popLayout` + `cardVariants` exit and the list reflows (`layout`); the kept count is
  a `TickNumber`; `error` and `start.error` reveal and play `errorNudge`; `busy` swaps with `CrossFade`.
- `canvaspane.tsx`: switching boards is a `StepSwap` with `dir` from the board order; entering `marking` reveals
  its toolbar with `composerReveal`; a `mark`/`draft` overlay appears with `PopoverReveal`; the `server-down` /
  `removed` pane swap is a `viewFade`; `sending` swaps with `CrossFade`.
- `docreviewdialog.tsx`: `collapsed` through `PaneReveal`; `load.status` loading → doc or error is a `viewFade`;
  `quoting.pending` reveals with `composerReveal`; `requesting` swaps with `CrossFade`.
- `commentsendbar.tsx`: `note` reveals with `composerReveal`; `error` reveals and plays `errorNudge`; `sending`
  and the recipient kind (live / new) swap with `CrossFade`.

### Task 10: Agent surface panes
**Depends on:** Task 1 (uses the primitives it adds and fills the stub it creates)
**Files:** `frontend/app/view/agents/answerbar.tsx`, `frontend/app/view/agents/nowlineview.tsx`, `frontend/app/view/agents/toolrenderers.tsx`, `frontend/app/view/agents/shelltaskpeek.tsx`, `frontend/app/view/agents/sessionsdetail.tsx`, `frontend/app/view/agents/cockpiteventsrail.tsx`, `frontend/app/view/agents/planpreview.tsx`, `frontend/app/view/agents/runlauncher.tsx`, `scripts/cdp/scenarios-motion-agent.mjs`

Arrange from `agent-composer`, `shell-tasks`, `cockpit-polish` and `sessions-list` (and `agent-rendered` for
the now line); rerun those and `cockpit-ask-keys` after.

- `answerbar.tsx`: the bar's content sits in `AutoHeight`, so a question with more options grows it; the
  summary ↔ question swap is a `viewFade`; the preview pane swaps with `viewFade` keyed on the focused option;
  the selected mark (`isSelected`) swaps with `CrossFade`.
- `nowlineview.tsx` (shipped 2026-11-10; change only its marks): the line's kind changing to `done` swaps the
  spinner for a `DrawCheck`; the call text changing swaps with `CrossFade` keyed on the call. The spinner's
  elapsed time does not tick (it changes every second).
- `toolrenderers.tsx`: the `raw` toggle is a `viewFade`; the `more`/`hidden` overflow lines reveal with
  `PaneReveal`.
- `shelltaskpeek.tsx`: the events ↔ output view swap is a `viewFade` keyed on `view`; events arriving enter
  with `cardVariants` via `computeEntrances` keyed on the task; `monitor` and `persistent` labels swap with
  `CrossFade`.
- `sessionsdetail.tsx`: the find bar (`find != null`) reveals with `composerReveal`; `earlier` arriving is a
  `viewFade`; `lead.live` and `view.ask` swap with `CrossFade`.
- `cockpiteventsrail.tsx`: events arriving while the rail is open enter with `cardVariants` via
  `computeEntrances`; the `fresh` count is a `TickNumber`; an event's `more` detail through `PaneReveal`.
- `planpreview.tsx`: `open` through `PaneReveal`; `editing` swaps with `viewFade`; `saveErr` reveals and plays
  `errorNudge`; `load.status` loading → plan is a `viewFade`.
- `runlauncher.tsx`: `showParallelism` and `showWorkerRoute` rows reveal with `PaneReveal`
  (`composerReveal`); the route `current.error`/`current.result` swap with `CrossFade`.

### Task 11: Diff, history and storage
**Depends on:** Task 1 (uses the primitives it adds and fills the stub it creates)
**Files:** `frontend/app/view/agents/historypane.tsx`, `frontend/app/view/agents/changedfilelist.tsx`, `frontend/app/view/agents/comparecolumn.tsx`, `frontend/app/view/agents/gitstatepanels.tsx`, `frontend/app/view/agents/storagesection.tsx`, `scripts/cdp/scenarios-motion-diff.mjs`

Arrange from `git-history`, `diff-compare`, `diff-review-marks` and `settings-storage`; rerun those and
`diff-states` after.

- `historypane.tsx`: rows appended by "load more" enter with `cardVariants` via `computeEntrances` keyed on the
  project and filter (a filter change swaps the list with `viewFade`, no cascade); `appendState` loading /
  failed swap with `CrossFade`; turning the graph on/off (`graphOn`) is a `viewFade`; `geom.foldedCount` is a
  `TickNumber`.
- `changedfilelist.tsx`: the review progress (`done` of `total`) is a bar with `barFillClass` and a
  `TickNumber`; `done === total` arriving draws a `DrawCheck`; `collapsed` through `PaneReveal`; a file's
  `comments` count is a `TickNumber`.
- `comparecolumn.tsx`: `loading` → rows or `error` is a `viewFade`; the `onCollapse` column collapse through
  `PaneReveal` (width or height, tokens only).
- `gitstatepanels.tsx`: a failure panel arriving enters with `cardVariants` and plays `errorNudge` when it
  follows the user's action; its `stderr` detail through `PaneReveal`.
- `storagesection.tsx`: `confirming` swaps with `CrossFade`; a deleted row leaves with `popLayout` and a height
  exit (`paneReveal` exit) while the list reflows; `notice` reveals with `composerReveal` and
  `notice.failure` plays `errorNudge`; the plan's size bars take `barFillClass`; the freed/size totals are
  `TickNumber`s; scan `loading` → report is a `viewFade`.

### Task 12: Code surface, project pages, image zoom
**Depends on:** Task 1 (uses the primitives it adds and fills the stub it creates)
**Files:** `frontend/app/view/code/codesurface.tsx`, `frontend/app/view/code/codetreepane.tsx`, `frontend/app/view/code/codeviewer.tsx`, `frontend/app/view/code/codesearchpane.tsx`, `frontend/app/view/code/codepeekcard.tsx`, `frontend/app/view/code/codesymbolspane.tsx`, `frontend/app/view/agents/projectnow.tsx`, `frontend/app/view/agents/projecthistory.tsx`, `frontend/app/view/agents/projectbranches.tsx`, `frontend/app/view/agents/projectoverview.tsx`, `frontend/app/view/agents/projectactivity.tsx`, `frontend/app/element/imagezoom.tsx`, `scripts/cdp/scenarios-motion-code.mjs`

Arrange from `code-sidebar`, `code-search`, `code-peek`, `code-image-zoom` and `project-overview`; rerun those,
`code-tree-on-arrival`, `code-keys` and `code-blame` after. `codesurface.tsx` has no `MotionConfig`: add
`reducedMotion="user"` at its root, the way `filessurface.tsx` does.

- `codetreepane.tsx`: expanding a directory turns its chevron on `turnTransition` and the newly inserted child
  rows fade in with `microFade` (opacity only: the tree is a flat row list, so no height reveal and no `layout`
  on rows); the inline create/rename editor reveals with `composerReveal`; `err` reveals and plays
  `errorNudge`.
- `codeviewer.tsx`: turning blame on (`blameOn`) reveals the blame column with a width reveal on tokens; an
  image's loaded/`failed` swap is a `viewFade`.
- `codesearchpane.tsx`: the paths filter (`pathsOpen`) through `PaneReveal`; `invalid` plays `errorNudge`; a
  new result set swaps with `viewFade` keyed on the query (not per keystroke while results stream: key on the
  settled query).
- `codepeekcard.tsx` and `codesymbolspane.tsx`: `absent` / `empty` ↔ content swaps are `viewFade`s.
- `projectnow.tsx`: a command that finishes moves from the running list to the finished list as one
  `layoutId` element on `morphTransition`, and new running rows enter with `cardVariants`.
- `projecthistory.tsx` and `projectbranches.tsx`: `loading` → rows / failed is a `viewFade`. In
  `projecthistory.tsx` only, the nested run rows (`RunRow nested`, `data-history-nested`) of a group that
  opens on screen come in through `PaneReveal`.
- `projectoverview.tsx`: `git.files` is a `TickNumber`. `projectactivity.tsx`: the hover/focus tip appears with
  `PopoverReveal`.
- `imagezoom.tsx`: discrete jumps (fit, actual size, keyboard zoom steps) ease on `morphTransition`; wheel zoom
  and drag pan stay 1:1 and un-eased; the `failed` state swaps with `viewFade`.
