# Jira integration: Final round 1 fixes

Final (`node scripts/cdp/final-verify.mjs jira-settings jira-check jira-initiative jira-post jira-sidebar jira-details jira-wsh`) failed on the merged result: 35/40 steps passed. The round fixes the five failing steps, in three independent files. Spec: `docs/superpowers/specs/2026-11-03-jira-integration-design.md`. Plan: `docs/superpowers/plans/2026-11-03-jira-integration.md`. The Final output is under `C:/Users/kael02/AppData/Local/dev.arc.app/data/final-shots/6112d260-b817-4ae1-89c9-612fdb071420/1` (`shots.json` has each step's detail).

### Task 1: Jira fixtures wait for the connection and never leak an initiative

**Depends on:** none

`jira-details` threw in arrange: `EC-JIRA-NOTCONFIGURED: Jira isn't set up: add your site and account email in Settings > Jira.` `connectFakeJira` (`scripts/cdp/jira-fixtures.mjs`) returns right after `setconfig`, before wavesrv has reloaded `jira:site`/`jira:email`, so a `jirashow` straight after it can find Jira unconfigured. `jira-check` works around it with its own `waitConnected`. Fix it once in the shared fixture.

Files: `scripts/cdp/jira-fixtures.mjs`, `scripts/cdp/scenarios-jira-details.mjs` (only if it needs to change after the fixture fix).

- [ ] **Step 1:** In `connectFakeJira`, after `setconfig` and `setsecrets`, poll `jiraconnection` with `{ test: false }` (never `test: true`: `jira-settings` step 2 asserts the fake saw no calls before Test again) every 250 ms until it reports `configured: true`, for up to 10 s, then throw with the last reply. Do the same in `disconnectJira` until `configured: false`, so the not-set-up steps don't race the other way.
- [ ] **Step 2:** `seedTicketedInitiative` creates the initiative, then throws if `jirashow` fails, leaking an initiative on a board key (PAY-318, PAY-311, OPS-77, GROW-12, PAY-290), which breaks `jira-check`'s counts in later runs. Wrap the steps after `effortcreate` so a failure calls `effortdelete { effortoid }` before rethrowing.
- [ ] **Step 3:** Run `task verify:ui -- jira-details jira-settings jira-check` against a dev app on this tree (see AGENTS.md "Visual verification"; `scripts/cdp/final-verify.mjs jira-details jira-settings jira-check` starts its own). All steps pass. If `jira-check`'s own `waitConnected` is now redundant you may leave it; do not change its assertions.

### Task 2: jira-post's gated post calls the real RPC bound to RpcApi

**Depends on:** none

Steps 5, 6, 6b and 7 of `jira-post` failed: after `window.__releasePost()` the dialog stayed open and the fake Jira had 0 comments (step 5 detail: `{"dialog":true,"footer":"","comments":0,"status":"To Do"}`). `gatePost` in `scripts/cdp/scenarios-jira-post.mjs` calls `real(...args)` unbound, and `RpcApi.JiraPostCommand` reads `this.mockClient` (`frontend/app/store/wshclientapi.ts`), so the released call throws instead of posting. `scenarios-jira-check.mjs` (`real.apply(RpcApi, args)`) and `scenarios-jira-details.mjs` already bind it.

Files: `scripts/cdp/scenarios-jira-post.mjs`.

- [ ] **Step 1:** Call the held original as `real.apply(RpcApi, args)` in `gatePost`. Check every other place the scenario calls a stored original the same way.
- [ ] **Step 2:** Run `jira-post` (as in Task 1 Step 3) and make all of steps 1-7 pass. Steps 6, 6b and 7 failed after step 5; if one still fails once the post lands, find its own cause and fix it in this file, or, if the defect is in the product (`jirapostdialog.tsx`, `jirapost.ts`, `inlinetrackerview.tsx`, `pkg/wshrpc/wshserver/wshserver_jira.go`), fix it there and say so in the report. Do not loosen an assertion to pass: each one states the spec's behaviour (decision 13 and motion moment 4).

### Task 3: the ticket bar's fold snaps under reduced motion

**Depends on:** none

`jira-initiative` step 4 failed: under `prefers-reduced-motion` the ticket bar body still passes through between heights (`128px, 95px, 64px, 44px, 30px` of `169px`). `MotionConfig reducedMotion="user"` only turns off transform and layout animations in motion; `height` is neither, so `paneReveal` still animates it.

Files: `frontend/app/view/jarvis/ticketbarview.tsx`.

- [ ] **Step 1:** Read `useReducedMotion()` from `motion/react` (as `frontend/app/view/agents/agentdetailsrail.tsx` does) and, when it is true, give the body's `motion.div` a zero-duration transition so height and opacity jump in one frame. Normal motion stays on `paneReveal`/`durMacro`.
- [ ] **Step 2:** Run `jira-initiative` (as in Task 1 Step 3): all six steps pass, step 4 with no between-height frames and step 3 (normal motion) still showing them.
