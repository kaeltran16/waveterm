# UI drift polish: final-stage fix round 1

The Final for `docs/superpowers/plans/2026-10-17-ui-drift-polish.md` failed on the merged result (commit `d584484`):
270 of 285 steps passed and 6 were skipped. Its shots and step results are in
`C:/Users/cktra/AppData/Local/dev.arc.app/data/final-shots/ddc625b3-51c3-4a4a-a621-e81be572a11f/1/cdp-shots/shots.json`,
and the app's log is `waveapp.log` in the same folder's parent.

The steps that failed:

- `jarvis-peek`: the scenario threw `nav button "Cockpit" not found for surface "cockpit"`.
- `radar-report` step 9: "the site link opens Code at the line". It clicked, and the surface stayed Radar with
  `file=""`.
- `jarvis-volunteer`: "Open navigates to the Jarvis surface" (surface stayed Cockpit) and "peek closed on navigation".
- `code-sidebar`: all 10 steps, from "start in Files mode" (`selected=false`).
- `brief-surface` step 7 (`nested=2`) and step 8 (`face=null`).

Task 7 reported the last three scenarios as failing on the base too. It checked this by running HEAD's scenarios
against the run's own app, which does not show that the base app fails. Base here means `bf923e39a`, the commit
before this run's first task.

The DESIGN.md rules and out-of-scope list in the original plan still apply. Fix only what this run's commits
(`7f55a48`..`d584484`) caused. A failure the base app shows too is reported in Found not fixed, with the evidence, and
is not fixed here. Do not weaken, skip or delete a step to make it pass.

### Task 1: Fix the jarvis-peek and radar-report failures this run caused

**Depends on:** none
**Files:** `scripts/cdp/scenarios.mjs`, `frontend/app/hook/useEscapeClose.ts`, `frontend/app/store/keybindings/bindings.ts`, `frontend/app/view/agents/radarfindingdetail.tsx`, `frontend/app/view/agents/radarsurface.tsx`, `frontend/app/view/agents/navrail.tsx`

If the cause is in another file this run changed, fix it there and name the file in Differs from plan.

- Run `jarvis-peek` and `radar-report` on this tree's app with `scripts/cdp/final-verify.mjs jarvis-peek radar-report`,
  and reproduce both failures.
- Run them again on the base app: a detached worktree at `bf923e39a`, prepared the way `final-verify.mjs` prepares a
  tree. Record what passes there.
- If a failure is not on the base, find the commit in this run that causes it, using `git bisect` over the run's
  commits or by reading the diffs, and fix the root cause. Suspects to check first:
  - Task 7's change to `jarvisPeek`, which now measures the floor while the view is open and pushes the result with
    the last steps. Something may leave the app off the nav rail before `goto("cockpit")`.
  - Task 6's `useEscapeClose` and the `noEscapeMenuOpen()` guard in `bindings.ts`, around the Dismiss and Reopen flow
    of step 8 that runs just before step 9.

Acceptance: `jarvis-peek` and `radar-report` pass on this tree's app, or Found not fixed shows the same step failing
on the base app.

### Task 2: Settle whether the jarvis-volunteer, code-sidebar and brief-surface failures are on the base

**Depends on:** Task 1
**Files:** `scripts/cdp/scenarios.mjs`, `frontend/app/view/code/codesurface.tsx`, `frontend/app/view/code/codesearchpane.tsx`, `frontend/app/view/jarvis/briefsurface.tsx`, `frontend/app/view/jarvis/briefrowviews.tsx`, `frontend/app/view/jarvis/petpeek.tsx`, `frontend/app/view/jarvis/bubblecard.tsx`

If the cause is in another file this run changed, fix it there and name the file in Differs from plan.

- Run `jarvis-volunteer`, `code-sidebar` and `brief-surface` with `scripts/cdp/final-verify.mjs` on the base app,
  using the base scenarios: a detached worktree at `bf923e39a`. Then run them on this tree's app.
- Each step that fails on this tree but passes on the base: find the commit in this run that causes it, and fix the
  root cause, in the app or in Task 7's scenario change.
- Each step that fails on both: leave it alone. Put the step name and the base run's result in Found not fixed.

Acceptance: each of the three scenarios passes on this tree's app, or Found not fixed shows the same step failing on
the base app with the base scenarios.
