# Run tab Graph Focus: fix round 1, the Done-board step finds no run

**Effort:** effort:40b4d563-2de6-4bf4-b71f-75561fe370ff
**Verify:** `node scripts/verify.mjs ./pkg/waveobj`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
**Final:** `node scripts/cdp/final-verify.mjs workspace-run-graph workspace-run`

Final failed one step of 30: `workspace-run-graph`'s last step, `finished run: every lane merged, the Final
verification row reads as the Tasks view's, no In flight chips (Done board)`, read no Graph (`null`). Its shot
(`workspace-run-graph-12-done-lanes.png`) shows the Run tab reading `Arc cannot find run 7f3a91c2-...`.

Cause: the lead's transcript opens with a run brief, and `BriefRow` reads its run through `useBriefRun` →
`fetchBriefRun` (`frontend/app/view/agents/arcmessagerow.tsx`), keyed `arc-run:<runId>` in `wshdata.ts` with a 30 s
TTL. Past the TTL any re-render (the Report step refocuses the lead) calls `WOS.reloadWaveObject("run:<id>")`, which
sets the server's answer unconditionally, with no version check. The fixture's run exists only in the page, so the
server answers null and the seeded run is wiped. When that answer lands after the Done step's `reseed`, the tab finds
no run. It is timing: each worker's own Final passed this step, and the merged Final, longer and run after
`workspace-run` in the same app, lost the race.

Decision: fix the fixture, not the product. In the app a run always exists on the server, and reloading a run the
server no longer has should read as gone. The fixture seeds `arc-run:<RUN_ID>` with `seedWshData`, as
`scenarios-transcript-arc.mjs` already does for its run (seeded keys never expire, so no live fetch replaces them),
so the brief never asks the server for the page-only run.

### Task 1: The fixture seeds its run's brief, so no live fetch wipes the page-only run
**Depends on:** none
**Files:** `scripts/cdp/workspace-run-fixture.mjs`

Goal: `seedRun` also seeds the wshData key `arc-run:<RUN_ID>` through `seedWshData`
(`frontend/app/view/agents/wshdata.ts`) with the brief `fetchBriefRun` would build from the seeded run and dag
(`goal`, `planSkill`, `autonomous`, `tasks` as `{ id, label, state }`), on every seed, so a reseed keeps it current.

Acceptance:
- `ARC_FINAL_OUT=<tmp dir> node scripts/cdp/final-verify.mjs workspace-run-graph workspace-run` passes every step
  in one app, the Done-board step included, run together as Final runs them.
- No step's assertions change.
