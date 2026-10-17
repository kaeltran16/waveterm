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

Tasks 1 to 6 change no `scripts/cdp/scenarios.mjs`; Task 7 adds every scenario step, after they merge.

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
**Files:** `frontend/app/element/collapsiblerail.tsx`, `frontend/app/element/contextmenu.tsx`, `frontend/app/modals/dialogbutton.tsx`, `frontend/app/view/agents/agentlaunchhero.tsx`, `frontend/app/view/agents/codeblock.tsx`, `frontend/app/view/agents/navrail.tsx`, `frontend/app/view/agents/newagentmodal.tsx`, `frontend/app/view/agents/newprojectmodal.tsx`, `frontend/app/view/agents/planpreview.tsx`, `frontend/app/view/agents/runcards.tsx`

- Text floor: `collapsiblerail.tsx` 126; `contextmenu.tsx` 82; `agentlaunchhero.tsx` 76; `codeblock.tsx` 28, 63;
  `newagentmodal.tsx` 44 (the `LABEL` constant), 466; `newprojectmodal.tsx` 80, 92; `planpreview.tsx` 66, 79, 88;
  `runcards.tsx` 180, 242.
- `dialogbutton.tsx` 47: the shortcut hint is 10px at `opacity-55`. Raise it and replace the opacity with an ink
  token (`text-muted` or `text-ink-faint`) that keeps the 4.5:1 contrast floor on both button styles.
- `navrail.tsx` 93 is the count badge in a 15px pill and 98 the label under each rail icon. Raise both; grow the pill
  so a two-digit count fits, and keep every label on one line in the 78px rail (the narrow 56px rail hides labels).
- Glyphs: `planpreview.tsx` 65 (`▼`/`▶` → lucide `ChevronDown`/`ChevronRight`), `runcards.tsx` 253.

Acceptance: no text under 10.5px and no glyph icon left in these files. Shown by the Final's surface-smoke,
cockpit-rail-tooltip, context-menu, task-detail, agent-launch-hero, new-project-modal, run-sheet-cards and ui-drift
scenarios.

### Task 3: Raise the diff, usage, Code and DAG views' text to the floor and put their shadows on the popover scale

**Depends on:** none
**Files:** `frontend/app/view/agents/aggregatepane.tsx`, `frontend/app/view/agents/dailychart.tsx`, `frontend/app/view/agents/diffpane.tsx`, `frontend/app/view/agents/historypane.tsx`, `frontend/app/view/agents/rangestrip.tsx`, `frontend/app/view/agents/usagesurface.tsx`, `frontend/app/view/code/codepathbar.tsx`, `frontend/app/view/code/codetreepane.tsx`, `frontend/app/view/code/codesurface.tsx`, `frontend/app/view/orchestrate/dagnodes.tsx`

- Text floor: `aggregatepane.tsx` 70; `dailychart.tsx` 419; `diffpane.tsx` 256; `historypane.tsx` 196 (`text-xxxs`);
  `rangestrip.tsx` 53; `usagesurface.tsx` 244; `codepathbar.tsx` 206; `codetreepane.tsx` 303; `dagnodes.tsx` 136
  (a chip on a DAG card: keep the card's height unchanged if the layout in `orchestrate/` sizes it).
- Tailwind `shadow-lg` on floating chrome becomes the matching `shadow-popover-*` step: `dailychart.tsx` 351,
  `codepathbar.tsx` 175, `codesurface.tsx` 190.

Acceptance: no text under 10.5px and no `shadow-sm|md|lg|xl` left in these files. Shown by the Final's git-history,
diff-compare, usage-charts, code-plain-dir, code-sidebar, dag-peek and ui-drift scenarios.

### Task 4: Replace raw white/black overlays and hand-rolled shadows with tokens

**Depends on:** none
**Files:** `frontend/app/view/agents/answerbar.tsx`, `frontend/app/view/agents/agentrow.tsx`, `frontend/app/view/agents/idlesection.tsx`, `frontend/app/view/agents/backgroundedsection.tsx`, `frontend/app/view/agents/settingssurface.tsx`, `frontend/app/view/agents/storagesection.tsx`, `frontend/app/cockpit/resmonpopover.tsx`, `frontend/app/view/agents/cockpithelp.tsx`, `frontend/app/view/jarvis/brieftoast.tsx`, `frontend/app/view/jarvis/inlinetrackerview.tsx`, `frontend/app/view/jarvis/chunksidebar.tsx`, `frontend/tailwindsetup.css`, `DESIGN.md`

- Overlays to surface or edge tokens: `answerbar.tsx` 140, 147, 209, 238, 245, 279, 341, 426; `agentrow.tsx` 66;
  `idlesection.tsx` 42; `backgroundedsection.tsx` 44; `settingssurface.tsx` 1106 (not 559, the toggle knob);
  `storagesection.tsx` 50; `resmonpopover.tsx` 184; `cockpithelp.tsx` 41. A hover keeps reading as a hover and a
  selected chip as selected on the default theme: compare against the house selected row (`bg-surface-selected`).
- Shadows: `brieftoast.tsx` 32 and `inlinetrackerview.tsx` 509 hand-roll the same `0 12px 34px` recipe, and
  `chunksidebar.tsx` 165 a side-sheet `-18px 0 44px`. Use a `shadow-popover-*` step where one reads the same. If none
  does, add one token to `@theme` with a "why" comment and use it at both identical sites, rather than a recipe each.
- `DESIGN.md`: under Typography, state the floor (no visible text under 10.5px; `text-xxs`/`text-xxxs` remain only
  in the pre-slice-5c run views). Under Elevation, list any shadow token this task adds.

Acceptance: no `bg-white`, `bg-black` or hand-rolled `shadow-[` elevation left in these files except
`settingssurface.tsx` 559. Shown by the Final's cockpit-polish, agent-composer, brief-inline-tracker,
brief-initiatives-polish, settings-storage, settings-claude-account, resmon-live, motion-gaps and ui-drift scenarios.

### Task 5: Use the shared Skeleton for every loading placeholder

**Depends on:** none
**Files:** `frontend/app/view/jarvis/runsheet.tsx`, `frontend/app/view/jarvis/briefsurface.tsx`, `frontend/app/view/jarvis/briefsheet.tsx`, `frontend/app/view/jarvis/briefprofileview.tsx`, `frontend/app/view/jarvis/effortdetailview.tsx`

- Each of these hand-writes `animate-pulse rounded-[…] bg-edge-strong motion-reduce:animate-none`, which is
  `Skeleton`/`skeletonClass` in `frontend/app/element/skeleton.tsx`: `runsheet.tsx` 842, 843, 870;
  `briefsurface.tsx` 1481; `briefsheet.tsx` 320; `briefprofileview.tsx` 684; `effortdetailview.tsx` 464. Keep each
  placeholder's size and radius by passing them as `className`. The comment at `briefsurface.tsx` 1466 names the
  skeleton's `animate-pulse`: keep it true.
- Text floor: `runsheet.tsx` 330.

Acceptance: no `animate-pulse` left in these files. Shown by the Final's run-sheet-polish, run-sheet-done,
brief-surface, brief-profile and brief-initiatives-polish scenarios.

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
code-stale-bar and ui-drift scenarios.

### Task 7: Scenario steps for every view the plan changed

**Depends on:** Task 1, Task 2, Task 3, Task 4, Task 5, Task 6
**Files:** `scripts/cdp/scenarios.mjs`

- Extract the "no visible text under `MIN_FONT_PX`" walk that `run-sheet-polish` and `agent-tree-rail` each inline
  into one helper, and use it in those two. Add a step with it to each existing Final scenario that shows a view
  Tasks 1 to 6 changed, on that view's root, after its existing steps.
- Add a `ui-drift` scenario, registered before `agentComposer` (which must stay last), that reaches what no
  existing scenario shows: `planpreview`, `effortcreateform`, `recordpicker`, `aggregatepane`, `answerbar`,
  `idlesection` and `backgroundedsection`, plus one Escape-closes-the-menu step per Task 6 menu. Check the floor on
  each and take one screenshot each with `lookShot`. Reach a state through the app's own path where one exists, and
  through the app's module as the `look` scenarios do otherwise. A view no path reaches without live agents is a
  `skipStep` that says why, never a pass.
- Run `node scripts/cdp/final-verify.mjs` on the named scenarios you changed and fix what fails. A failure that
  shows a Task 1 to 6 file still breaking a rule is fixed in that file, which this task may then edit.

Acceptance: every step passes or skips with a reason, and `ui-drift` is in the Final line's list.
