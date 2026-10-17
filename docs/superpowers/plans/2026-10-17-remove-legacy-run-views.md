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
- `frontend/app/view/agents/runcards.tsx`: a concurrent run is editing it. Fix only its comments that name a removed
  component, if any, and nothing else.
- Specs under `docs/superpowers/specs/` and canvases under `docs/prototype/`: historical records, left as written.

**Verify:** `node scripts/verify.mjs ./pkg/waveobj`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
**Final:** `node scripts/cdp/final-verify.mjs surface-smoke run-sheet-done run-sheet-cards run-sheet-legacy run-sheet-polish diff-review-marks-run dag-peek task-detail lead-card-merge-gate`

### Task 1: Open every run in RunSheet and delete the legacy renderer

**Files:** `frontend/app/view/jarvis/briefsheet.tsx`, `frontend/app/view/jarvis/runsheetmodel.ts`, `frontend/app/view/jarvis/runsheetmodel.test.ts`, `frontend/app/view/agents/runbody.tsx`, `frontend/app/view/agents/runcompletionsurface.tsx`, `frontend/app/view/agents/runworkercard.tsx`, `frontend/app/view/agents/runtimelineview.tsx`, `frontend/app/view/orchestrate/dagoverview.tsx`, `frontend/app/view/agents/runcompletion.ts`, `frontend/app/view/agents/runcompletion.test.ts`, `frontend/app/view/agents/channelsstore.ts`, `frontend/app/modals/confirmdialog.tsx`, `frontend/app/view/agents/runtimeline.ts`, `scripts/cdp/scenarios.mjs`

- `briefsheet.tsx`'s `ChannelRun` renders `RunSheet` for every run. Delete `sheetRoute` and its tests in
  `runsheetmodel.test.ts`.
- Delete `runbody.tsx`, `runcompletionsurface.tsx`, `runworkercard.tsx`, `runtimelineview.tsx` and
  `orchestrate/dagoverview.tsx`. Before deleting each, grep every import of each of its exports, `import type` and
  re-exports included. A live file still imports `runbody.tsx`'s `TONE_CLASS` (`modals/confirmdialog.tsx`) and
  `PHASE_TONE_CLASS` (`agents/runtimeline.ts`); move each such export into the one live file that uses it, or a
  small module beside them when two do.
- `runcompletion.ts`: remove the exports only the deleted files used, and their tests. `fmtDuration`, `fmtBytes`,
  `fmtClock`, `verifCounts` and `needsEvidenceSeal` have live users and stay. Grep each before removing it.
- `channelsstore.ts` describes its per-run subscription as RunBody's. If only RunBody read it, remove it; if a live
  view reads it, reword the comment to name that view.
- A scenario in `scripts/cdp/scenarios.mjs` that selects a hook only a deleted file rendered fails the Final: no
  such hook was found when this plan was written, so a failure there is a reason to look, not to edit the scenario
  around it.
- Add a `run-sheet-legacy` scenario: no run created today takes the old route, because `createrun` sets
  `orchestration: "engine"`. Seed a done orchestrator run shaped like one stored before slice 5c (`orchestration`
  empty, `claude` runtime, sealed evidence) with `lookSeedRun`, open it with `lookOpenRun` as `run-sheet-done`
  does, assert `[data-run-sheet="done"]` shows its goal and landed files, and take a `lookShot`. Put its definition
  directly after `runSheetCardsLook` and its `SCENARIOS` entry directly after `runSheetDoneLook`. A concurrent run
  adds a scenario before `agentComposer`, so leave that spot alone.

Acceptance: `grep -rnE "RunBody|RunCompletion|RunWorkerCard|RunRollup|PhaseHistory|OrchestratorBody|PhaseRail|DagOverview|RunTimeline\\b|sheetRoute" frontend`
finds only comments that say the views were removed, or nothing. tsc and vitest pass. The Final's run-sheet-legacy
step shows a pre-slice-5c-shaped run opening in `RunSheet`.
