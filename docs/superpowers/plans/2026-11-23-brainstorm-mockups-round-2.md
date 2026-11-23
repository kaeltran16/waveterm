# Brainstorm mockups, round 2: motion-lens samplers record their starting value

Final failed on motion-lens step 10 ("Request changes grows the note field open..."): the sampled heights were
`[13,47,77,91,97,99,100,101]`, so `grow[0] === 0` failed although the field did grow open. `startFrames`
(`scripts/cdp/scenarios-motion-lens.mjs` ~L54) takes its first reading on the next animation frame, and the step's
click is a separate CDP call; on a loaded machine the click lands before that frame, so the resting value before
the action is never recorded. Every sampler that asserts its first value (`grewOpen`, `collapse[0] === 1`, ...)
shares this race. The doc-review step is outside this run's code; the round fixes it because it holds the land.

**Spec:** `C:\Users\kael02\AppData\Local\arc-wt\6c1bf3f3\docs\superpowers\specs\2026-11-23-brainstorm-mockups-design.md`
**Verify:** `node scripts/verify.mjs ./pkg/waveobj`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
**Final:** `node scripts/cdp/final-verify.mjs brainstorm-answer-boards brainstorm-mode brainstorm-builder-ask brainstorm-working motion-lens workspace-brainstorm-question`
**Prototype:** C:\Users\kael02\IdeaProjects\waveterm\.superpowers\design\brainstorm-mockups\project\Prototype.dc.html

### Task 1: The frame sampler records the value at start
**Depends on:** none
**Files:** `scripts/cdp/scenarios-motion-lens.mjs`

**What to build:** `startFrames` records one reading synchronously when it starts, before scheduling its first
animation frame, so the value before the step's action is always the first sample whatever the frame timing. Fix
it in the shared sampler, not in step 10 alone, and leave every assertion as it is: an animation that never runs,
starts from the wrong value or ends wrong must still fail. Check that each step using `startFrames` still reads a
correct starting value with the extra reading (for example a sampler started before its target exists reads `null`
or `0`, which `distinct` and the step's check must still accept as the step intends).

**Acceptance:**
- a sampler started and then acted on within the same frame still records the pre-action value first (step 10's
  `grow` starts at `0`)
- no motion-lens assertion is loosened; motion-lens passes in full under
  `ARC_FINAL_OUT=<tmp dir> node scripts/cdp/final-verify.mjs motion-lens`
