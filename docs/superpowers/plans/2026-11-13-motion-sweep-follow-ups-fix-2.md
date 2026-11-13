# Motion sweep follow-ups: fix round 2

**Goal:** Make Final's project-overview scenario pass in the full Final order: in round 2 its first step's
registered project never reached the switcher within 10s, and 19 steps that need it failed.

**Architecture:** CDP scenarios, and the project registry's frontend store only if the cause is there. The run's plan
and spec still hold: `docs/superpowers/plans/2026-11-13-motion-sweep-follow-ups.md`,
`docs/superpowers/specs/2026-11-13-motion-sweep-follow-ups-design.md`.

**Tech Stack:** TypeScript, jotai, CDP scenarios (node).

**Effort:** effort:b53dbcba-da9b-427d-8b4c-c8d2a1fb9693
**Spec:** `docs/superpowers/specs/2026-11-13-motion-sweep-follow-ups-design.md`
**Verify:** `node scripts/verify.mjs ./pkg/agentask`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
**Final:** `node scripts/cdp/final-verify.mjs motion-peeks motion-brief motion-run-sheet motion-dag-peek motion-brief-controls motion-lens motion-agent motion-diff motion-code jarvis-motion motion-brainstorm brainstorm-check-review motion-final project-overview`

## Global Constraints

- Edit only the files on the Files line. Never weaken a step to pass: each step keeps asserting what its text says.
- Check UI with `ARC_FINAL_OUT=<tmp dir> node scripts/cdp/final-verify.mjs <scenario...>`, never `task verify:ui`.
- This is the run's last Final round: the fix must hold in the full Final order on a loaded machine, not only alone.
- Lint/format only the files you touched: `npx eslint <paths>`, `npx prettier --check <paths>` (not on
  `scripts/*.mjs`).

## Review Focus

- The fix names the cause it proved from a capture (timings, the config's `projects` key, the RPC result), not a
  guess; a longer wait is acceptable only for a setup precondition the capture shows arrives late, never for an
  asserted moment.
- Steps after the first keep their own assertions unchanged.

---

### Task 1: project-overview's registered project reaches the switcher in the full Final order
**Depends on:** none
**Files:** `scripts/cdp/scenarios-project-overview.mjs`, `scripts/cdp/project-overview-kit.mjs`, `scripts/cdp/project-overview-activity.mjs`, `frontend/app/view/agents/projectsstore.ts`

Final round 2 (out: `%LOCALAPPDATA%/dev.arc.app/data/final-shots/7ec830b2-780c-4775-9c1d-8eeda39f76d4/2/shots.json`)
failed project-overview steps 2-20 (218/237). Step 1's detail: `{"listed":false,"opened":true,"allHasEntry":false,
"hasEntry":false}`. `listed` is `until(() => S.globalStore.get(ps.projectsAtom)?.[project] != null, 10000)` after
`ps.registerProject(project, dir)`. `projectsAtom` derives from `atoms.fullConfigAtom.projects`, so it updates only
when wavesrv's config watcher publishes the new projects.json; `registerProject` (`projectsstore.ts`) awaits
`CreateProjectCommand` then `primeChannels()`. Everything that needs the project failed (activity, now, branches up
to "loading shows skeleton lines"); the steps after it, from "a repository with no commit", passed, so the project
arrived later. In round 1 the same scenario passed 100%, and the lead's re-run of `motion-final project-overview`
alone on the merged tree passed 51/51. So it is order- or load-dependent. Round 2's only changes before it were
motion-code step 9's cleanup and motion-dag-peek steps 14b/15b, neither touching projects. Scenarios that override
`fullConfigAtom` (scenarios-brief.mjs ~6225/7251, scenarios-files-states.mjs, scenarios-code-toolbar.mjs) are not in
the Final list but show the pattern to look for.

1. Reproduce: the Final list's scenarios in order (the **Final:** line above), back to back in one isolated app,
   under CPU stress if a plain run passes.
2. Make step 1 capture what the wait meets: when `CreateProjectCommand` resolved, whether `fullConfigAtom.projects`
   holds the project at each poll, and how long until it does; put it in the step's detail.
3. Fix the proven cause where it lies. If the registry is right but the config event is slow under load, the
   scenario may wait for the project on a setup precondition (before any asserted moment) with a bound that the
   capture justifies; if the app itself never refreshes, fix `projectsstore.ts` and say why.
4. Also fix, in `project-overview-activity.mjs`, the load-bound read t-12 found: "Main board, activity: in the last 5
   columns the tooltip flips to the cell's left" once read a tooltip still placed for an earlier cell (tip left 405
   for a cell at 1195). Read after the tooltip is placed for the hovered cell.

Acceptance: project-overview passes in the full Final order (report the runs: count, order, stress); Check is clean.
