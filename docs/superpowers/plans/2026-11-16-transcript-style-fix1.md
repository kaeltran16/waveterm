# Transcript style: fix round 1

**Effort:** effort:f283ad11-bcef-4053-b3f8-cda2e04998a2
**Verify:** `node scripts/verify.mjs ./cmd/wsh/cmd`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
**Final:** `node scripts/cdp/final-verify.mjs agent-rendered narration-feed motion-agent rendered-shell transcript-base transcript-initiative transcript-dag transcript-dagactions transcript-runs transcript-agents transcript-notes transcript-arc transcript-boards`
**Prototype:** C:\Users\kael02\IdeaProjects\waveterm\.superpowers\design\rendered-view-style\project

Round 1 of Final passed 174 of 176 steps. Both failures are in `transcript-dag`, and they share one cause, which
is in the scenario rather than the product:

- "dag status opened with four task states" expected `idle 2m` and saw `idle 3m 27s`.
- "compact dag status and Run complete at 380 px" expected `running 4m` and saw `running 5m 38s`.

`scripts/cdp/scenarios-transcript-dag.mjs` stamps `BUILD`'s t-2 `firstactivity` and t-3 `lastactivity` with
`Date.now()` when the module loads (lines 96-97). `final-verify.mjs` imports every scenario module before it runs
the first one, so by the time transcript-dag runs, its stamps are minutes old. When the scenario runs alone, the
values land inside the window the steps expect, which is why the task passed its own check.

**Decision:** stamp these times when the fixture is seeded, not when the module loads. The steps keep asserting
the exact minutes (`idle 2m`, `running 4m`), so they still prove that elapsed time is computed from the task's
activity time. Loosening the assertions to a pattern would stop proving that.

### Task 1: Stamp transcript-dag's activity times when the fixture is seeded
**Depends on:** none
**Files:** `scripts/cdp/scenarios-transcript-dag.mjs`

- t-2's `firstactivity` (4m 10s before) and t-3's `lastactivity` (2m 11s before) are computed when the seed is
  sent to the page, so they are relative to the moment the step shows its transcript.
- Keep the shape of `fixtures` exactly as it is. `scripts/cdp/scenarios-transcript-boards.mjs` imports
  `fixtures` and re-keys its seeds, so it must keep working unedited. One way that keeps the shape is a getter
  on the task object, because the seed is serialised when `showTranscript` runs.
- The two failing steps keep their current assertions unchanged.
- `scenarios-transcript-base.mjs` lines 46-48 also stamp at module load. Its steps passed in round 1. Read
  them: if a step asserts a value that drifts with the stamp's age, report it under "Found not fixed" with the
  step name. Do not edit that file.

**Acceptance:**
- `ARC_FINAL_OUT=<tmp dir> node scripts/cdp/final-verify.mjs transcript-initiative transcript-dag transcript-boards`
  passes every step. Running transcript-dag after another scenario reproduces the module-load gap.
- Then wait 3 minutes after the modules load before transcript-dag runs, and it still passes. One way: put a
  scenario that takes that long ahead of it, or temporarily delay it locally, never in the commit. Report how
  you checked this.
