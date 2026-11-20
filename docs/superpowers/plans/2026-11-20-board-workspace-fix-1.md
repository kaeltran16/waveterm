# Fix round 1: the workspace pane's reveal and removal steps assert the sheet slide

**Verify:** `node scripts/verify.mjs ./pkg/wconfig`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
**Final:** `node scripts/cdp/final-verify.mjs workspace-pane boards-workspace`

Final failed 38/40 on two `workspace-pane` steps. Both fail identically on the base, and the run did not cause
them. Commit 451bb4863 (on the base) changed how the pane arrives and leaves: `WorkspacePane`
(`frontend/app/view/agents/workspacepane.tsx`, the `motion.aside`) now enters at its full target width and slides
in like a sheet: `initial={{ width: target, opacity: 0, x: SHEET_SLIDE_PX }}`. It leaves the same way, with
`exit={{ opacity: 0, x: SHEET_SLIDE_PX }}` (`LEAVE`). Its comment gives the reason: growing the width would narrow
the transcript beside it every frame and rewrap the whole feed. The two steps still sample the pane's width and
require a frame strictly between 0 and 600px, so they can never pass:
- "opening a tab reveals the pane (6b) at 600px on a fresh profile" sees `widths: [600]`, `final: 600`
- "closing the last tab removes the pane" sees `widths: [600, "gone"]`

## Decisions beyond the design

1. **The sheet slide is the intended behaviour; the steps change, not the pane.** 451bb4863 made the slide
   on purpose and documented why, and the design for this run does not touch how the pane arrives. Bringing
   back a width tween would undo that fix.

### Task 1: the pane's reveal and removal steps assert the sheet slide
**Depends on:** none
**Files:** `scripts/cdp/scenarios-workspace-pane.mjs`

**What to build:** rewrite the two failing steps so each checks what the pane does now. Every other step stays
as it is. No product code changes.
- **Reveal:** sample the pane's width and its computed opacity (or its `x` translate) on every frame from the
  `openWorkspaceTab` call until it settles. Pass when the pane has its full width (600 on the fresh profile) from
  its first frame, at least one frame shows an opacity strictly between 0 and 1 (or a translate between 0 and
  `SHEET_SLIDE_PX`), and the pane settles at width 600, opacity 1, translate 0.
- **Removal:** sample the same values from the close click until the pane is gone. Pass when at least one frame
  shows the pane at its full width with an opacity strictly between 0 and 1 before it is "gone". Keep the
  step's existing checks: no pane, no rail, no tabs, and no "d pane" in the footer.
- Rename each step to describe the slide (for example "opening a tab slides the pane in (6b) at 600px on a fresh
  profile"), and update the comments above them.

**State changes and moments:** none new. The steps observe the existing sheet entrance and exit (`REVEAL`,
`LEAVE`).

**Acceptance:**
- `ARC_FINAL_OUT=<tmp dir> node scripts/cdp/final-verify.mjs workspace-pane` passes every step, these two
  included.
- Each rewritten step would fail if the pane popped in or out with no intermediate frame, and would fail if the
  pane grew its width from 0. Prove both by reading the sampled values, not by changing the product.
