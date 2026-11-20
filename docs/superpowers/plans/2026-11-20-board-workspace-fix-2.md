# Fix round 2: the ask bar fits a pane at its 360px floor

**Verify:** `node scripts/verify.mjs ./pkg/wconfig`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
**Final:** `node scripts/cdp/final-verify.mjs workspace-pane boards-workspace`

Final passed after round 1. The verifier reported one problem. In the `boards-workspace` step "W1 narrow window"
(a 1000px window with the agent tree shown), the pane sits at its 360px floor (`MIN_PANE_PX`), and the ask bar
(`data-board-ask-bar` in `frontend/app/view/agents/workspaceboardtab.tsx`) does not fit inside it.

Two things in the bar refuse to shrink:
- The bare agent chip's root is `flex-none` (`BoardAgentChip` with `bare`, in
  `frontend/app/view/boards/boardagentpicker.tsx`).
- The input group keeps `min-w-[200px]`.

Together with the bar's padding and gaps, they come to more than 360px. The bar overflows, so Ask is clipped at
the pane's edge. The facts collapse to nothing, which is the intended order (they ellipsize first). Enter still
asks, so the bar works, but its main button cannot be seen or clicked.

## Decisions beyond the design

1. **The bare chip shrinks before the input group.** The order in which things give way at narrow widths becomes:
   1. the facts ellipsize first, as decision 7 of the run's plan says
   2. then the chip's label truncates, down to its runtime dot and chevron
   3. the input group keeps its 200px minimum, so Ask stays fully visible

   Why: the input and Ask are the bar's purpose. The chip is a picker whose full label also appears in its
   `aria-label` and in the picker itself.

### Task 1: the ask bar fits a 360px pane with Ask fully visible
**Depends on:** none
**Files:** `frontend/app/view/boards/boardagentpicker.tsx`, `frontend/app/view/agents/workspaceboardtab.tsx`, `scripts/cdp/scenarios-boards-workspace.mjs`

**What to build:**
- Make the bare chip shrinkable. Its root gets `min-w-0` with a small flex-shrink instead of `flex-none`. The label
  span already truncates, and the dot and chevron stay. The non-bare chip on the Boards surface keeps today's
  classes.
- Adjust the bar in `workspaceboardtab.tsx` only as far as needed, so that at a 360px pane:
  - the chip, the input group (at least 200px) and the facts' slot all fit inside the bar;
  - Ask's right edge lies within the pane.
- At wide panes nothing changes. At 1600px the chip shows its full label, as the W1 idle step already records.
- In the scenario, also restore the two spaces the run's earlier edits dropped: `const box = (` and
  `const text = (` (lines 51 and 75).

**State changes and moments:** none. This is a layout fix only.

**Acceptance:**
- In the `boards-workspace` step "W1 narrow window", add these assertions:
  - Ask's button (`data-board-ask-send`) is fully visible: its right edge is no further right than the pane's
    right edge, and no further right than the bar's.
  - The bar does not overflow: its `scrollWidth` is no larger than its `clientWidth`.
  - The chip's label is truncated.

  The step's existing checks stay: the facts truncated and the group at least 200px. Without the fix, the new
  assertions fail.
- The Boards surface's chip is unchanged: `scenarios-boards-ask.mjs` reads it, and that file is not edited.
- `ARC_FINAL_OUT=<tmp dir> node scripts/cdp/final-verify.mjs boards-workspace` passes every step.
