# Canvas tab polish, fix round 1: motion-lens frame samplers wait for the end state

**Verify:** `node scripts/verify.mjs ./pkg/waveobj`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
**Final:** `node scripts/cdp/final-verify.mjs workspace-pane-canvas workspace-brainstorm-canvas canvas-swap canvas-mark canvas-tabs motion-lens`

Final failed one step of 58 on the merged result 41f2fbf: motion-lens `6. switching Main -> Cards slides the board
out to the left and the next in from the right, settling at 0`, with `{"tabs":true,"slide":[],"frames":["Main.dc.html"]}`.
Its screenshot shows Cards picked in the header and the Main board still mid-exit. The product is not at fault:
the step drives the Terminal view's `CanvasPane` (no `onClose`) through `StepSwap`, and neither changed in this run.
A solo `motion-lens` on 41f2fbf passed 21/21. There step 6 sampled the whole slide (`0 … -16, 16 … 0`, 32 frames,
about 530 ms at 60 fps).

## Decisions

1. **The cause is the wait, not the animation.** Step 6 starts a per-frame sampler, clicks, then stops after a
   fixed `polishNap(900)`. On a loaded machine the page renders few frames in that window: `StepSwap`'s
   `mode="wait"` exit had not finished, and the sampler had nothing recorded when it stopped. 8a and 9b have the
   same start, fixed nap, stop shape, and t-2 saw both fail under load during this run (its report: "9b … 8a (pick
   row stayed at opacity 0)").
2. **Fix: wait for the end state, bounded, then stop.** Each of these samplers stops only once the state it
   asserts has been reached, or a bounded wait runs out. Every assertion stays exactly as it is: an animation
   that never runs, never ends or ends wrong still fails. This fixes the specific waits, as earlier calls on
   Final flakes chose. It does not add a retry or any tolerance for a failed step.
3. **Out of scope:** 7a (server-down fade) passed in this Final and in every solo run. Its wait is already a
   `polishWaitFor` on the poller, so it is left alone.

### Task 1: motion-lens samplers 6, 8a and 9b stop on the end state, not after a fixed nap
**Depends on:** none
**Files:** `scripts/cdp/scenarios-motion-lens.mjs`

**What to build:** steps 6, 8a and 9b in `scenarios-motion-lens.mjs` replace the fixed nap between the action
and `stopFrames` (or the settled read) with a bounded wait on the end state the step asserts. Add one
named constant for the bound, a few seconds, well above the solo slide's ~530 ms. Use `polishWaitFor` (in
`scenarios-shared.mjs`), which the file already uses. Afterwards a short nap is allowed, so the sampler records
the final resting frame. The end states:
- **6:** `[data-canvas-frame]` lists only `Cards.dc.html`, and the sampled `[data-canvas-scroll] > div` reads
  `translateX` 0 (the entering board has landed).
- **8a:** the pick row (`PICKS`) is present, and its parent's computed opacity is `"1"`.
- **9b collapse:** `NOTES_PANE` is gone and the toggle's `aria-expanded` is `"false"`.
- **9b expand:** `NOTES_PANE` is present, and its computed opacity is 1.

If the bound runs out, the step goes on to its unchanged assertions and fails with its usual detail.

**Acceptance:**
- the `rec(...)` conditions and step names of 6, 8a and 9b are unchanged; only the waits before reading change
- no fixed `polishNap` sits between those steps' action and `stopFrames`, or their settled read, any more
- `ARC_FINAL_OUT=<tmp dir> node scripts/cdp/final-verify.mjs motion-lens` passes 21/21. Step 6's detail shows
  negative values, then positive ones, ending at 0, with `frames` `["Cards.dc.html"]`. Put that detail in the
  report.
