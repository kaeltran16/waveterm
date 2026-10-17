# Remove the legacy run views

Slice 5c deleted pipeline mode, the plan gate and adaptive orchestration, but kept a second renderer so runs stored
before it stay readable: `sheetRoute` (`frontend/app/view/jarvis/runsheetmodel.ts`) sends those runs to `RunBody`
instead of `RunSheet`. One stored run in this project still takes that route. The owner decided on 2026-10-17 that
the legacy renderer goes: every run, old or new, opens in `RunSheet`. An old run then shows what `RunSheet` can draw
of it, and loses the pipeline rail and plan-gate detail.

This is a frontend removal only. The backend's run model, stored runs and the wire types stay as they are.

Out of scope:

- `frontend/app/view/agents/runmodel.ts` and `runmodel.test.ts`: another session has uncommitted edits there. Leave
  any helper that only the legacy views used in place; a follow-up removes it once that work is committed.
- `frontend/app/view/agents/runcards.tsx`: a concurrent run is editing it. Reword only its lines 5-6 comment, which
  names `PhaseRail`, `OrchestratorBody`, `RunBody` and `runbody.tsx`, and change nothing else in the file.
- Specs under `docs/superpowers/specs/` and canvases under `docs/prototype/`: historical records, left as written.

**Verify:** `node scripts/verify.mjs ./pkg/waveobj`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
**Final:** `node scripts/cdp/final-verify.mjs surface-smoke run-sheet-done run-sheet-cards run-sheet-legacy run-sheet-polish diff-review-marks-run dag-peek task-detail lead-card-merge-gate`

### Task 1: Open every run in RunSheet and delete the legacy renderer

**Files:** `frontend/app/view/jarvis/briefsheet.tsx`, `frontend/app/view/jarvis/runsheetmodel.ts`, `frontend/app/view/jarvis/runsheetmodel.test.ts`, `frontend/app/view/agents/runbody.tsx`, `frontend/app/view/agents/runcompletionsurface.tsx`, `frontend/app/view/agents/runworkercard.tsx`, `frontend/app/view/agents/runtimelineview.tsx`, `frontend/app/view/orchestrate/dagoverview.tsx`, `frontend/app/view/agents/runcompletion.ts`, `frontend/app/view/agents/runcompletion.test.ts`, `frontend/app/view/agents/channelsstore.ts`, `frontend/app/view/agents/runtimeline.ts`, `frontend/app/view/agents/runtimeline.test.ts`, `frontend/app/view/agents/runtimeline-picks.test.ts`, `frontend/app/view/agents/runcards.tsx` (comment only), `frontend/app/view/agents/planpreview.tsx` (comment only), `frontend/app/view/agents/usecardstreams.ts` (comment only), `frontend/app/view/orchestrate/timelinegroups.ts` (comment only), `scripts/cdp/scenarios.mjs`

- `briefsheet.tsx`'s `ChannelRun` renders `RunSheet` for every run; drop its `RunBody` import and the comment above
  it that explains the legacy route. Delete `sheetRoute`, its comment, and its tests in `runsheetmodel.test.ts`.
- Delete `runbody.tsx`, `runcompletionsurface.tsx`, `runworkercard.tsx`, `runtimelineview.tsx` and
  `orchestrate/dagoverview.tsx`. Before deleting each, grep every import of each of its exports, `import type` and
  re-exports included. `TONE_CLASS` and `PHASE_TONE_CLASS` in `runbody.tsx` have no live importer (only a comment in
  `runtimeline.ts` names them), so they go with the file; if the grep finds any other live importer of an export,
  move that export into the one live file that uses it.
- `runtimeline.ts`: with `runtimelineview.tsx` gone, some of its exports have no caller outside tests. Remove each
  export that, after the deletions, no non-test file outside `runtimeline.ts` imports and `runtimeline.ts` does not use
  itself, with its tests in `runtimeline.test.ts` and `runtimeline-picks.test.ts`; delete a test file left empty.
  When this plan was written those were `buildRunTimeline`, `RunTimelineGroup`, `RUN_GROUP_ID`, `PREVIEW_COUNT`,
  `artifactsOf`, `clickTargetFor`, `TimelineClick`, `joinWorkspacePath` and `planReviewPicks`/`PlanReviewPick`;
  grep each before removing it. `detailOf`, `eventText`, `eventTitle`, `tsLabel`, `toneFor`, `planReviewLensTitle`
  and `planReviewReviewers` have live users and stay. Reword the line 165-166 comment so it names no deleted file.
- `runcompletion.ts`: remove the exports only the deleted files used, and their tests. `fmtDuration`, `fmtBytes`,
  `fmtClock`, `verifCounts` and `needsEvidenceSeal` have live users and stay. Grep each before removing it.
- `channelsstore.ts`: the comment on `runAtom` says RunBody reads it. If no live file reads `runAtom`, remove it;
  if one does, reword the comment to name that file.
- Comments that name a deleted view, reworded so they name none (or say the views were removed), with no code change:
  `runsheetmodel.ts` line 5 (`RunHeader`, `DagOverview`), `runcards.tsx` lines 5-6, `planpreview.tsx` line 5,
  `usecardstreams.ts` line 7, `orchestrate/timelinegroups.ts` line 5 ("the run body's timeline"), and the
  `scenarios.mjs` comment above `lookSeedRun` (about line 22238, naming `RunBody` and `sheetRoute`): it should say that
  every run, pre-slice-5c ones included, now opens in `RunSheet`, and that `run-sheet-legacy` shows it.
- A scenario in `scripts/cdp/scenarios.mjs` that selects a hook only a deleted file rendered fails the Final: no
  such hook was found when this plan was written, so a failure there is a reason to look, not to edit the scenario
  around it.
- Add a `run-sheet-legacy` scenario and register it in `SCENARIOS`: no run created today takes the old route, because
  `createrun` sets `orchestration: "engine"`. Arrange a run as `run-sheet-done` does. Step 1: seed it with
  `lookSeedRun` as a done orchestrator run shaped like one stored before slice 5c (`orchestration` empty, `claude`
  runtime, sealed evidence), open it with `lookOpenRun`, assert `[data-run-sheet="done"]` shows its goal and landed
  files, and take a `lookShot`. Step 2: reseed with `status: "awaiting-review"` and `plangatepending: true`, reopen,
  assert `[data-run-sheet]` renders and shows the goal, and take a `lookShot`. Step 3: reseed with `mode: "pipeline"`
  (and a non-done status such as `executing`), reopen, assert the same, and take a `lookShot`. These are every shape
  `sheetRoute` used to send to `RunBody`. Put its definition directly after `runSheetCardsLook` and its `SCENARIOS`
  entry directly after `runSheetDoneLook`. A concurrent run adds a scenario before `agentComposer`, so leave that spot
  alone. The Final line already names `run-sheet-legacy`.

Acceptance: `grep -rnE "\b(RunBody|RunCompletion|RunWorkerCard|RunRollup|PhaseHistory|OrchestratorBody|PhaseRail|DagOverview|RunHeader|RunTimeline|sheetRoute|TONE_CLASS|PHASE_TONE_CLASS)\b" frontend scripts/cdp`
and `grep -rnwE "runbody|runcompletionsurface|runworkercard|runtimelineview|dagoverview" frontend scripts/cdp` (case
sensitive: the `runBody` locals in `scenarios.mjs` are not hits) find nothing, or only comments that say the views
were removed. The live `PeekRunBody` and `buildRunTimeline`-style names do not match these word-anchored patterns.
`node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` passes, and
`npx vitest run frontend/app/view/jarvis/runsheetmodel.test.ts frontend/app/view/agents/runcompletion.test.ts frontend/app/view/agents/runtimeline.test.ts frontend/app/view/agents/runtimeline-picks.test.ts`
passes (drop a path whose file the task deleted), as does the full `npx vitest run`. The Final's `run-sheet-legacy`
steps show each pre-slice-5c run shape opening in `RunSheet`.
