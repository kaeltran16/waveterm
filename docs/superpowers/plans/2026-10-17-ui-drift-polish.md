# UI drift polish

A static scan on 2026-10-17 checked every live `.tsx` against `DESIGN.md` and found the drift below. This plan
fixes it in place. It is mechanical: no new views, no layout changes beyond what a larger font or a token needs.

The rules every task applies, from `DESIGN.md`:

- **Text floor.** No visible text under 10.5px. A `text-[9px]`, `text-[9.5px]`, `text-[10px]`, `text-xxs` or
  `text-xxxs` becomes `text-[10.5px]`, keeping its weight, case, tracking and color. Where a box is sized to the old
  text (a fixed `h-`, `w-`, `min-w-` or `leading-`), grow the box so nothing clips or wraps. The scenarios' check is
  `MIN_FONT_PX` in `scripts/cdp/scenarios.mjs`.
- **Icons.** A text glyph used as an icon (`▶`, `▼`, `✓`, `↗`, `×`) becomes a `lucide-react` icon, `aria-hidden`
  when a label beside it already names it.
- **Colors and shadows come from `@theme` tokens** in `frontend/tailwindsetup.css`: no `bg-white/…`, `bg-black/…`,
  `text-white`, Tailwind `shadow-sm|md|lg|xl`, or hand-rolled `shadow-[…]` elevation. Hover overlays use the surface
  ramp (`hover:bg-surface-hover`), chips the surface or edge ramps, floating chrome the `shadow-popover-*` scale.
- **Focus.** Every button and link shows `focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent`
  (the house combination); an icon-only control carries an `aria-label`.

Out of scope, and not to be touched by any task:

- The views only runs stored before slice 5c reach (`sheetRoute` in `frontend/app/view/jarvis/runsheetmodel.ts`):
  `runcompletionsurface.tsx`, `runworkercard.tsx`, `runtimelineview.tsx`, `runbody.tsx`, `orchestrate/dagoverview.tsx`.
- Native `title=` tooltips: whether they move to the `Tooltip` primitive is an open decision.
- Modal scrims (`modalshell.tsx`, `finalshotsviewer.tsx`), the settings toggle's white knob, the window close
  button's hover.
- Any file not in a task's Files line. Another session has uncommitted work in this checkout, including
  `motiontokens.ts`, `runmodel.ts`, `runlauncher.tsx`, `routepicker.tsx`, `newruncontrol.tsx` and `profilemodel.ts`.

Tasks 1 to 6 change no `scripts/cdp/scenarios.mjs`; Task 7 adds every scenario step, after they merge. Each task's
acceptance names the steps Task 7 adds for it (its "step" lines); Task 7 owns them all. Two checks recur:

- A **shadow check** reads the element's computed `box-shadow` and compares it with that of a probe `div` given the
  intended token class (for example `shadow-popover-md`), and checks its computed background is not a raw white or
  black overlay.
- A **floor check** walks the view's root for visible text under `MIN_FONT_PX` (the helper Task 7 extracts).

**Verify:** `node scripts/verify.mjs ./pkg/waveobj`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
**Final:** `node scripts/cdp/final-verify.mjs surface-smoke cockpit-polish cockpit-rail-tooltip context-menu task-detail agent-launch-hero new-project-modal jarvis-peek jarvis-volunteer peek-item-views brief-surface brief-profile brief-initiatives-polish brief-inline-tracker record-band-detach-restore new-run-window git-history diff-compare usage-charts code-plain-dir code-diff code-sidebar code-stale-bar dag-peek run-sheet-polish run-sheet-done run-sheet-cards settings-storage settings-claude-account resmon-live motion-gaps radar-report ui-drift agent-composer`

### Task 1: Raise the Jarvis views' text to the floor

**Depends on:** none
**Files:** `frontend/app/view/jarvis/petpeek.tsx`, `frontend/app/view/jarvis/bubblecard.tsx`, `frontend/app/view/jarvis/autonomyladderview.tsx`, `frontend/app/view/jarvis/briefrowviews.tsx`, `frontend/app/view/jarvis/effortcreateform.tsx`, `frontend/app/view/jarvis/jarvisfixturebar.tsx`, `frontend/app/view/jarvis/newinitiativecontrol.tsx`, `frontend/app/view/jarvis/peek/peekrun.tsx`, `frontend/app/view/jarvis/peterrand.tsx`, `frontend/app/view/jarvis/projectpickerview.tsx`, `frontend/app/view/jarvis/recordbandview.tsx`, `frontend/app/view/jarvis/recordpicker.tsx`

Apply the text floor at these sites (line numbers as of `74c7720c9`):

- `petpeek.tsx` 282, 315, 401, 450, 453, 492, 838 (453 and 492 are pills with a fixed `leading-[15px]`: grow them)
- `bubblecard.tsx` 71, 81, 93; `autonomyladderview.tsx` 135, 139; `peek/peekrun.tsx` 65; `peterrand.tsx` 38
- `briefrowviews.tsx` 114 (a `w` key chip with `leading-[14px]`)
- `effortcreateform.tsx` 249: a 10px glyph inside a 13px checkbox. Use a lucide `Check` sized to the box instead.
- `jarvisfixturebar.tsx` 23; `newinitiativecontrol.tsx` 30; `projectpickerview.tsx` 14, 227; `recordbandview.tsx` 45;
  `recordpicker.tsx` 53

Acceptance: no text under 10.5px is left in these files (`grep -nE 'text-\[(9|9\.5|10)px\]|text-xxx?s'` finds
nothing). The views are shown by the Final's jarvis-peek, peek-item-views, brief-surface, jarvis-volunteer,
new-run-window, record-band-detach-restore and ui-drift scenarios, whose floor checks Task 7 adds.

### Task 2: Raise the shell, modal and agent views' text to the floor and replace their glyph icons

**Depends on:** none
**Files:** `frontend/app/element/collapsiblerail.tsx`, `frontend/app/element/contextmenu.tsx`, `frontend/app/modals/dialogbutton.tsx`, `frontend/app/view/agents/agentlaunchhero.tsx`, `frontend/app/view/agents/codeblock.tsx`, `frontend/app/view/agents/navrail.tsx`, `frontend/app/view/agents/newagentmodal.tsx`, `frontend/app/view/agents/newprojectmodal.tsx`, `frontend/app/view/agents/planpreview.tsx`

- Text floor: `collapsiblerail.tsx` 126; `contextmenu.tsx` 82; `agentlaunchhero.tsx` 76; `codeblock.tsx` 28, 63;
  `newagentmodal.tsx` 44 (the `LABEL` constant), 466; `newprojectmodal.tsx` 80, 92; `planpreview.tsx` 66, 79, 88.
  `runcards.tsx` 180, 242 and 253 (BlockedCard, TriageChip, ShipMarker) are left alone: only `runbody.tsx`, a
  pre-slice-5c view, renders them.
- `dialogbutton.tsx` 47: the shortcut hint is 10px at `opacity-55`. Raise it and replace the opacity with an ink
  token (`text-muted` or `text-ink-faint`) that keeps the 4.5:1 contrast floor on both button styles.
- `navrail.tsx` 93 is the count badge in a 15px pill and 98 the label under each rail icon. Raise both; grow the pill
  so a two-digit count fits, and keep every label on one line in the 78px rail (the narrow 56px rail hides labels).
- Glyphs: `planpreview.tsx` 65 (`▼`/`▶` → lucide `ChevronDown`/`ChevronRight`).

Acceptance: no text under 10.5px and no glyph icon left in these files. Shown by the Final's surface-smoke,
cockpit-rail-tooltip, context-menu, task-detail, agent-launch-hero, new-project-modal and ui-drift scenarios, with
these Task 7 steps:

- step (ui-drift): the navrail at the 78px width with a two-digit count on a badge (a fixture, or the module rendered
  with a count of 12): every label is one line (its height equals one line box), the count fits its pill
  (`scrollWidth <= clientWidth`), and the rail passes the floor check; one `lookShot`.
- step (ui-drift): a `DialogButton` with a `hint`, on both button styles: the hint is at least 10.5px, has no
  `opacity` below 1, and its color is an ink token; one `lookShot`.
- step (ui-drift): `planpreview` with a section open and one closed: each toggle holds an `svg` icon and no `▼`/`▶`
  text.

### Task 3: Raise the diff, usage, Code and DAG views' text to the floor and put their shadows on the popover scale

**Depends on:** none
**Files:** `frontend/app/view/agents/aggregatepane.tsx`, `frontend/app/view/agents/dailychart.tsx`, `frontend/app/view/agents/diffpane.tsx`, `frontend/app/view/agents/historypane.tsx`, `frontend/app/view/agents/rangestrip.tsx`, `frontend/app/view/agents/usagesurface.tsx`, `frontend/app/view/code/codepathbar.tsx`, `frontend/app/view/code/codetreepane.tsx`, `frontend/app/view/code/codesurface.tsx`, `frontend/app/view/orchestrate/dagnodes.tsx`

- Text floor: `aggregatepane.tsx` 70; `dailychart.tsx` 419; `diffpane.tsx` 256; `historypane.tsx` 196 (`text-xxxs`);
  `rangestrip.tsx` 53; `usagesurface.tsx` 244; `codepathbar.tsx` 206; `codetreepane.tsx` 303; `dagnodes.tsx` 136
  (a chip on a DAG card: keep the card's height unchanged if the layout in `orchestrate/` sizes it).
- Tailwind `shadow-lg` on floating chrome becomes the matching `shadow-popover-*` step: `dailychart.tsx` 351,
  `codepathbar.tsx` 175, `codesurface.tsx` 190.

Acceptance: no text under 10.5px and no `shadow-sm|md|lg|xl` left in these files. Shown by the Final's git-history,
diff-compare, usage-charts, code-plain-dir, code-sidebar, dag-peek and ui-drift scenarios, with these Task 7 steps:

- step (usage-charts): hover a daily-chart bar so its tooltip shows; shadow check against the step Task 3 chose.
- step (code-plain-dir or code-sidebar): open the `codepathbar` popover and the `codesurface` project picker; a shadow
  check on each, one `lookShot` each.
- step (dag-peek, or ui-drift through the module): a DAG card with a tag chip (`view.tag`): the chip passes the floor
  check and fits on its line, and the card's height equals an untagged card's.

### Task 4: Replace raw white/black overlays and hand-rolled shadows with tokens

**Depends on:** none
**Files:** `frontend/app/view/agents/answerbar.tsx`, `frontend/app/view/agents/agentrow.tsx`, `frontend/app/view/agents/idlesection.tsx`, `frontend/app/view/agents/backgroundedsection.tsx`, `frontend/app/view/agents/settingssurface.tsx`, `frontend/app/view/agents/storagesection.tsx`, `frontend/app/cockpit/resmonpopover.tsx`, `frontend/app/view/agents/cockpithelp.tsx`, `frontend/app/view/jarvis/brieftoast.tsx`, `frontend/app/view/jarvis/inlinetrackerview.tsx`, `frontend/app/view/jarvis/chunksidebar.tsx`, `frontend/tailwindsetup.css`, `DESIGN.md`

- Overlays to surface or edge tokens: `answerbar.tsx` 140, 147, 209, 238, 245, 279, 341, 426; `agentrow.tsx` 66;
  `idlesection.tsx` 42; `backgroundedsection.tsx` 44; `settingssurface.tsx` 1106 (not 559, the toggle knob);
  `storagesection.tsx` 50; `resmonpopover.tsx` 184; `cockpithelp.tsx` 41. A hover keeps reading as a hover and a
  selected chip as selected on the default theme: compare against the house selected row (`bg-surface-selected`).
- Shadows: `brieftoast.tsx` 32 and `inlinetrackerview.tsx` 509 hand-roll `0 12px 34px`, the geometry of
  `shadow-popover-md`: use that step at both. `chunksidebar.tsx` 165 hand-rolls a side-sheet `-18px 0 44px`, which no
  popover step matches (they all cast downward): add one `--shadow-sheet-side` token to `@theme` with a "why" comment
  and use it there, still only under `@max-[1280px]`, where the sheet overlays the content.
- `DESIGN.md`: under Typography, state the floor (no visible text under 10.5px). Say `text-xxs`/`text-xxxs` and
  sub-floor sizes remain in the pre-slice-5c run views (including `runcards.tsx`'s BlockedCard, TriageChip and
  ShipMarker, which only `runbody.tsx` renders), and are pending in `routepicker.tsx`, `runlauncher.tsx` and
  `newruncontrol.tsx`, which this plan does not touch. Under Elevation, list `--shadow-sheet-side`.

Acceptance: no `bg-white`, `bg-black` or hand-rolled `shadow-[` elevation left in these files except
`settingssurface.tsx` 559. Shown by the Final's cockpit-polish, agent-composer, brief-inline-tracker,
brief-initiatives-polish, settings-storage, settings-claude-account, resmon-live, motion-gaps and ui-drift scenarios,
with these Task 7 steps:

- step (ui-drift): an `answerbar` with options, shot at rest, with one option hovered (CDP mouse move) and with one
  selected. The hovered option's computed background differs from the resting one, the selected one's equals a probe
  with `bg-surface-selected`, and none is a raw white or black overlay; one `lookShot` per state.
- step (cockpit-polish): the cockpit `HintsBar` (`[data-cockpit-hints]`) key chips have no raw white overlay
  background.
- step (resmon-live): in the open resmon popover, the element at `resmonpopover.tsx` 184 has no raw white or black
  overlay background.
- step (brief-inline-tracker): an open tracker menu (`[data-jarvis-tracker-menu]`): shadow check against
  `shadow-popover-md`. Where the store has no initiative with chunks, ui-drift renders the menu through the module.
- step (ui-drift, or brief-inline-tracker's undo toast where it runs): a brief toast (`[data-jarvis-brief-toast]`):
  shadow check against `shadow-popover-md`, one `lookShot`. The toast shows through the app's undo path when the
  plan has two chunks, and through the module otherwise.
- step (brief-initiatives-polish): the chunk sidebar (`[data-jarvis-chunk-sidebar]`) shot with the viewport narrowed
  to `OBS_NARROW` (1000px) so its container is under 1280px: shadow check against `shadow-sheet-side`, then the
  viewport restored.
- step (settings-storage, and `idlesection`, `backgroundedsection` and `agentrow` in ui-drift): the swapped hover and
  chip backgrounds are no raw white or black overlay.

### Task 5: Use the shared Skeleton for every loading placeholder

**Depends on:** none
**Files:** `frontend/app/view/jarvis/runsheet.tsx`, `frontend/app/view/jarvis/briefsurface.tsx`, `frontend/app/view/jarvis/briefsheet.tsx`, `frontend/app/view/jarvis/briefprofileview.tsx`, `frontend/app/view/jarvis/effortdetailview.tsx`

- Each of these hand-writes `animate-pulse rounded-[…] bg-edge-strong motion-reduce:animate-none`, which is
  `Skeleton`/`skeletonClass` in `frontend/app/element/skeleton.tsx`: `runsheet.tsx` 842, 843, 870;
  `briefsurface.tsx` 1481; `briefsheet.tsx` 320; `briefprofileview.tsx` 684; `effortdetailview.tsx` 464. Keep each
  placeholder's size and radius by passing them as `className`. The comment at `briefsurface.tsx` 1466 names the
  skeleton's `animate-pulse`: keep it true.
- Text floor: `runsheet.tsx` 330.

Acceptance: no hand-written `animate-pulse` class left in these files (the `briefsurface.tsx` 1466 comment may still
name it). Shown by the Final's run-sheet-polish, run-sheet-done, brief-surface, brief-profile and
brief-initiatives-polish scenarios, with this Task 7 step for each of the seven placeholders: hold the view in its
loading frame (the `__recordPeekFor(..., { hold: true })` pattern, a delayed RPC through the module, or rendering the
loading branch through the module), assert an element with `animate-pulse` and `bg-edge-strong` keeps the
placeholder's size, and take one `lookShot`. A placeholder no path can hold is a `skipStep` that says why.

### Task 6: Close the hand-rolled dropdowns on Escape and give the Code surface's buttons focus and labels

**Depends on:** none
**Files:** `frontend/app/view/agents/projectswitcher.tsx`, `frontend/app/view/agents/radarsurface.tsx`, `frontend/app/view/agents/radarfindingdetail.tsx`, `frontend/app/view/code/codeviewer.tsx`, `frontend/app/view/code/codediffview.tsx`, `frontend/app/view/code/codestalebar.tsx`, `frontend/app/view/code/codesearchpane.tsx`

- `projectswitcher.tsx` 58, `radarsurface.tsx` 77 and 129, and `radarfindingdetail.tsx` 93 open a menu over a
  click-catching backdrop and close only on an outside click. Close each on Escape too, and return focus to the
  button that opened it. `sourcepicker.tsx` closes its own on Escape; do not change it. Only the open menu handles
  the key, so Escape keeps its meaning elsewhere on the surface.
- Every button and link in the four Code files gets the house focus ring; an icon-only one gets an `aria-label`
  saying what it does.

Acceptance: each of the four menus closes on Escape with focus back on its trigger, and no button in the Code files
lacks a `focus-visible:` ring. Shown by the Final's new-run-window, radar-report, code-diff, code-plain-dir,
code-stale-bar and ui-drift scenarios, with these Task 7 steps:

- step (ui-drift, one per menu): open the menu, press Escape (CDP `Input.dispatchKeyEvent`): the menu is gone and
  `document.activeElement` is the trigger that opened it.
- step (code-diff, code-stale-bar, code-plain-dir): move focus by Tab key events onto a button in each of
  `codeviewer`, `codediffview`, `codestalebar` and `codesearchpane`: the focused button's computed `box-shadow` shows
  the ring (not `none`), with one `lookShot` per file; and every icon-only button (no text content) in those views
  has a non-empty `aria-label`.

### Task 7: Scenario steps for every view the plan changed

**Depends on:** Task 1, Task 2, Task 3, Task 4, Task 5, Task 6
**Files:** `scripts/cdp/scenarios.mjs`

- Extract the "no visible text under `MIN_FONT_PX`" walk that `run-sheet-polish` and `agent-tree-rail` each inline
  into one helper, and use it in those two. Add a step with it to each existing Final scenario that shows a view
  Tasks 1 to 6 changed, on that view's root, after its existing steps.
- Add a `ui-drift` scenario, registered before `agentComposer` (which must stay last), that reaches what no
  existing scenario shows: `planpreview`, `effortcreateform`, `recordpicker`, `aggregatepane`, `answerbar`,
  `idlesection` and `backgroundedsection`. Check the floor on each and take one screenshot each with `lookShot`.
- Add every "step" line in Tasks 2 to 6's acceptance, in the scenario that line names. Reach a state through the
  app's own path where one exists, and through the app's module as the `look` scenarios do otherwise. Only a step
  those lines allow to skip may be a `skipStep`, and it says why; the navrail, dialogbutton, DAG chip, answerbar,
  brief toast, Escape and focus-ring steps always reach their view, through the module if no path does.
- Run `node scripts/cdp/final-verify.mjs` on the named scenarios you changed and fix what fails. A failure that
  shows a Task 1 to 6 file still breaking a rule is fixed in that file, which this task may then edit.

Acceptance: every step passes or skips with a reason allowed above, and `ui-drift` is in the Final line's list.
