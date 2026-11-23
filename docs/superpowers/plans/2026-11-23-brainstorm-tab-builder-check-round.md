# Brainstorm tab: Builder check, fix round

Leftovers the task reviews of the builder-check run named in files it changed. No behavior changes.

**Verify:** `node scripts/verify.mjs ./pkg/waveobj`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
**Final:** `node scripts/cdp/final-verify.mjs workspace-brainstorm-question workspace-brainstorm-check brainstorm-builder-ask brainstorm-builder-check brainstorm-check-review brainstorm-mode brainstorm-question-reasons`

### Task 1: Doc comment and A4 scenario check
**Depends on:** none
**Files:** `frontend/app/view/agents/brainstormui.tsx`, `scripts/cdp/scenarios-workspace-brainstorm-check.mjs`

**What to build:**
- In `brainstormui.tsx`, the comment that starts "the read over the answers, with the one toggle for every answer's pros
  and cons" describes `QuestionAnswers` but now sits above `ProsConsToggle`. Put it back with `QuestionAnswers`, merged
  with that function's `reasonsShown` comment so the comment still reads true (the toggle is in the group unless the
  caller sets `reasonsShown`). `ProsConsToggle` gets a short comment or none.
- In `scenarios-workspace-brainstorm-check.mjs`, the 360 px A4 step computes `showTop` as `null` when the Show label is
  absent, and `Math.abs(fit.showTop) <= 2` passes on `null`. Make the step fail when Show is missing. Also restore the
  missing space after `const reviewCursor =` (before its template string).

**Acceptance:**
- `QuestionAnswers` carries the read/toggle comment; `ProsConsToggle` no longer does.
- The A4 step in `workspace-brainstorm-check` fails if the summary's Show label is absent, and passes on the current
  build (run with `ARC_FINAL_OUT=<tmp dir> node scripts/cdp/final-verify.mjs workspace-brainstorm-check`).
