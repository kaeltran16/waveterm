# Motion sweep, Final round 2 fixes Implementation Plan

**Verify:** `node scripts/verify.mjs ./pkg/wavebase`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
**Final:** `node scripts/cdp/final-verify.mjs motion-run-sheet motion-dag-peek motion-peeks motion-final motion-brief motion-brief-controls motion-brainstorm motion-lens motion-agent motion-diff motion-code motion-gaps dag-motion jarvis-motion run-sheet-polish dag-peek final-stage final-shots brief-surface brief-peek brief-profile new-run-window brainstorm-mode workflow-scan doc-review agent-composer shell-tasks sessions-list git-history diff-compare settings-storage code-sidebar code-search project-overview`

**Goal:** make the run's Final pass. Round 2's Final passed 488 of 490 steps; every round-1 failure is fixed.
Two steps failed, both in Final round 1 passing and both reading a moment against the clock:

- `motion-run-sheet` step 7
- `brief-peek` step 13

Find the cause of each. If the scenario samples too early, fix the scenario. If the app is wrong, fix the app.
Do not loosen a step until it passes.

**Output dir of the failed Final:**
`C:/Users/kael02/AppData/Local/dev.arc.app/data/final-shots/ee4cd975-1a04-433d-a7f6-7091622e7c4b/2`.
- `shots.json` holds each step's detail.
- `cdp-shots/` holds the screenshots.

## Rules for every task

- **Reproduce under the Final command:** `node scripts/cdp/final-verify.mjs <scenario>`. Load makes these show.
  Run the scenario at least three times; a fix that passes once proves nothing about a timing failure.
- **An absence check waits for the exit by polling,** up to a bound well past the exit's duration, as the
  sweep's rule says. Never a longer fixed sleep.
- **A frame-sampling check must not depend on the first sample landing before the change.** Read the "before"
  value synchronously before the change is injected, and assert what the moment promises: no intermediate
  value under reduced motion, at least one under full motion.
- **Done means:**
  - your scenario passes three times in a row under `final-verify.mjs`;
  - it also passes once together with the scenario before it in the Final list.

### Task 1: motion-run-sheet step 7, the reduced-motion strip sample
**Depends on:** none
**Files:** `scripts/cdp/scenarios-motion-run-sheet.mjs`

**What fails.** Step 7 injects t-2 → done under `prefers-reduced-motion: reduce` and samples the segment's
color every frame. Final read:
- `colors: ["rgb(84, 199, 154)"]`, only the final color;
- `transition.property: "none"`;
- the next line changed, with no flash.

The step requires `colors.length === 2`. The change landed before the sampler's first
`requestAnimationFrame`, so the "before" color was never recorded. t-12 hit the same trap in motion-code.

**The fix.** Capture the segment's color before injecting. Then assert:
- the sampled values hold no color other than the before and after colors;
- the last value is the done color;
- `transition.property` stays `none`.

Check step 6, the full-motion step in the same file: if it has the same early-sample exposure, apply the same
before-capture there, keeping its "at least one intermediate color" requirement.

### Task 2: brief-peek step 13, the decision form after Escape
**Depends on:** none
**Files:** `scripts/cdp/scenarios-brief.mjs`, `frontend/app/view/jarvis/decisionlog.tsx`

**What fails.** Step 13 opens the record's Add decision form, types, dispatches Escape on its input, sleeps
400ms, then requires `[data-jarvis-decision-form]` to be gone. Final read
`{"typed":true,"afterEsc":{"form":true,"add":true,"peek":true}}`.

Since t-2 (this run), the form opens and closes through `PaneReveal` with `composerReveal` in
`decisionlog.tsx`, so it stays attached for its exit. It passed in round 1.

**First tell which of two things happened.** Poll for the form's absence (bounded at about 2s) and record when
it left.
- **It leaves within the bound:** the fixed sleep was the defect. Keep the poll.
- **It never leaves:** the Escape did not close it, or its exit never completes. Find out which, from the
  form's `open` state and the PaneReveal wrapper, and fix the cause in `decisionlog.tsx`. Keep the form's
  Escape behavior and data attributes.

Other steps in `scenarios-brief.mjs` that check a decision form's or composer's absence after a fixed sleep get
the same poll.
