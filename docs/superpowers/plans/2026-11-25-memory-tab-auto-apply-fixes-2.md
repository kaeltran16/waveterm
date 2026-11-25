# Memory tab auto-apply: undo-refused frame check

**Spec:** `C:\Users\kael02\AppData\Local\arc-wt\e21dcb40\docs\superpowers\specs\2026-11-23-memory-tab-usability-design.md`
**Verify:** `node scripts/verify.mjs ./pkg/memhygiene ./pkg/jarvisvolunteer ./pkg/wshrpc/... ./cmd/wsh/...`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit && go vet ./pkg/memhygiene ./pkg/jarvisvolunteer ./pkg/wshrpc/... ./cmd/wsh/...`
**Final:** `node scripts/cdp/final-verify.mjs setup-memory`
**Prototype:** C:\Users\kael02\IdeaProjects\waveterm\.superpowers\design\memory-tab-redesign\project\FlowAuto.dc.html

## Decisions

- **The undo-refused step checks for overlap in every frame and the gap once settled, not a gap in every
  frame.** Round 2's Final failed step 8 on one frame: box bottom 822.125, pane bottom 822.203, next line top
  822.203. The next line did not cover the box; the reveal had just reached the box's bottom edge, and the
  padding under it (part of the revealed height) was still growing. A height reveal whose padding is part of
  the revealed height always passes through a gap near 0, so the `touching` condition (gap of 0.5px or less
  once the box's bottom is inside the pane) asks for something the reveal cannot give. The overlap that
  t-6 caught is what the step guards, and `covered` already catches it. Why not change the motion instead: the
  page shows no defect, and moving the padding out of the reveal would make the next line jump by 14px at the
  end.

### Task 1: undo-refused asserts no overlap per frame and the settled gap
**Files:** `scripts/cdp/scenarios-settings.mjs`

**What to build:** in step 8 (`undo-refused`), the per-frame sampler records a bad frame only when the next did
line covers the drawn part of the refusal box (the existing `covered` rule, top above the lower of the box's and
the pane's bottom by more than 0.5px). Drop the `touching` rule from the sampler. The settled check is
unchanged: the gap from the box's bottom to the next line's top is above 0 and equals the gap an opened did
line leaves above the next line. Update the step's title and comment to say this.

**Acceptance:**
- step 8 fails when the next did line covers any drawn part of the refusal box in any frame from the Undo click
  until it settles
- step 8 fails when the settled gap is 0 or differs from an opened did line's gap
- `node scripts/cdp/final-verify.mjs setup-memory` passes all 13 steps
