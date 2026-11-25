# Memory tab auto-apply: round fixes

**Spec:** `C:\Users\kael02\AppData\Local\arc-wt\e21dcb40\docs\superpowers\specs\2026-11-23-memory-tab-usability-design.md`
**Verify:** `node scripts/verify.mjs ./pkg/memhygiene ./pkg/jarvisvolunteer ./pkg/wshrpc/... ./cmd/wsh/...`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit && go vet ./pkg/memhygiene ./pkg/jarvisvolunteer ./pkg/wshrpc/... ./cmd/wsh/...`
**Final:** `node scripts/cdp/final-verify.mjs setup-memory`
**Prototype:** C:\Users\kael02\IdeaProjects\waveterm\.superpowers\design\memory-tab-redesign\project\FlowAuto.dc.html

The run's plan is `docs/superpowers/plans/2026-11-25-memory-tab-auto-apply.md`; its Decisions still hold. These
tasks fix what the landed tasks left open.

## Decisions

- **Progress lands the newest finished list, not only the newest started one.** `loadMemory` drops any list
  whose sequence is not the latest started, so during a split Apply (one `memhygiene:update` per change) every
  list is superseded by the next and only the last one lands: the scenario saw only 0 and 60 of 60. A list now
  lands when it started after the last one that landed. `replaceProject` still makes every list started
  before it stale. Why: keeps the guard against older state landing over newer, without starving progress.
- **"Stay" counts what remains in the shared folder after the split.** Today it is `memories` minus every
  move and copy that comes over, applied ones included. `memories` is re-measured at each check, so after a
  partial Apply and a re-check (the AutoChanged path) the moves already applied are subtracted twice. Why: the
  board's rule (stay + come over = the shared folder's memories before the split) must hold at every point of
  the split, not only before the first Apply.
- **"N more below" counts the split items below the list's visible area** and updates as it scrolls; it is
  hidden when nothing is below. Why: the AutoAll board shows it beside Show fewer; t-5 left it out.

### Task 1: Split progress and stay count are right during a split
**Files:** `frontend/app/view/agents/memorystore.ts`, `frontend/app/view/agents/memorystore.test.ts`, `frontend/app/view/agents/memorymodel.ts`, `frontend/app/view/agents/memorymodel.test.ts`

**What to build:** while a split's Apply runs, each re-list that finishes after the last one that landed
updates the projects atom, so the progress line moves through the counts in between. A list started before a
`replaceProject` (decision, row result, undo) still never lands over it. `splitCounts(p).stay` gives the
memories left in the shared folder after the split at every point: before any Apply, mid-split, and after a
partial Apply followed by a re-check. Find from the state (change statuses, `checkedat`, the applied changes'
times or ops) whether `memories` already excludes an applied move, rather than adding a wire field, unless
the state cannot tell; if it cannot, say so in Differs from plan.

**Acceptance:**
- three lists started in order and finishing in order 1, 2, 3 each land; finishing in order 2, 1, 3, list 1
  does not land over list 2
- a list started before a `replaceProject` and finishing after it does not land
- `stay` for a split with 90 coming over (53 move, 37 copy) from a shared folder of 177 is 87 before any
  Apply, stays 87 after 20 moves are applied with no re-check, and stays 87 after those 20 are applied and a
  re-check re-measured `memories` as 157

### Task 2: Split list counter, Arc did layout during a row's exit, refusal spacing
**Files:** `frontend/app/view/agents/setupmemory.tsx`, `scripts/cdp/scenarios-settings.mjs`

**What to build:** the full split list shows "N more below" beside Show fewer, as on the AutoAll board,
counting the items below the scroll box's visible area and updating on scroll. While an opened row changes
height or leaves for its did line, the "Arc did this week" section moves with the rows above it rather than
being overlapped by them (t-6 caught a frame after Apply where the waiting rows covered the did lines). The
undo refusal box keeps the list's normal gap above the next did line (t-6's undo-refused screenshot shows the
next line's title touching its bottom edge). Use only existing `@theme` tokens. Moments: the did section's
move is the same layout motion as the rows' (17 with 2); no new moment.

**Acceptance:**
- scenario step `split-all-left-out` (or the step that opens Show all) asserts the "N more below" text equals
  the items below the box's visible area, and that it drops after scrolling the box
- scenario step `split-applying` samples, every animation frame from the Apply click until the row settles,
  the bounding boxes of `[data-memory-row]` elements and `[data-memory-did]`, and asserts no waiting row
  overlaps the did section in any frame; it also asserts the progress counts it recorded include at least one
  value strictly between 0 and the total (Task 1)
- scenario step `undo-refused` asserts the gap between the refusal box's bottom and the next did line's top
  is greater than 0 and equals the gap between two did lines
