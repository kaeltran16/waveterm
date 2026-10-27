# Lead Plans From Approved Design: Round Fixes

**Spec:** `C:/Users/kael02/IdeaProjects/waveterm/docs/superpowers/specs/2026-10-27-lead-plans-from-approved-design-design.md`
**Verify:** `node scripts/verify.mjs ./pkg/jarvis/... ./pkg/waveobj/... ./pkg/wshrpc/... ./pkg/orchestrate/... ./cmd/wsh/...`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit && go vet ./pkg/jarvis/... ./pkg/waveobj/... ./pkg/wshrpc/... ./pkg/orchestrate/... ./cmd/wsh/...`
**Final:** `node scripts/cdp/final-verify.mjs new-run-design run-sheet-designing`

The run landed the approved-design flow and its final stage passed. This round closes what the run left: one
launcher note that still names the Spec review the lead no longer holds, Build this… on a linked canvas that no
scenario drives, and the brainstorm-builder scenario that Task 5 changed but nobody ran.

### Task 1: Approvals note drops the Spec review

**Depends on:** none

The lead's prompt no longer holds a Spec review (spec: the lead plans from the approved design, or asks
`Needs a design`), so the launcher's Approvals note must not promise one.

**Files:**
- Modify: `frontend/app/view/agents/runconfig.ts` (`approvalsNote`)
- Test: `frontend/app/view/agents/runconfig.test.ts`

- [ ] **Step 1:** In `runconfig.test.ts`, change the `approvalsNote` expectations to:
  - `approvalsNote(false)` is `"The lead waits for you whenever a call is yours."`
  - `approvalsNote(true)` is `"No questions: the lead makes the plan review and product calls itself, and records why. You can switch this on the run sheet."`
- [ ] **Step 2:** Run `npx vitest run frontend/app/view/agents/runconfig.test.ts`; expect the two to fail.
- [ ] **Step 3:** Set the two strings in `approvalsNote` to exactly those.
- [ ] **Step 4:** Rerun the test; expect PASS. Grep `frontend/` and `scripts/cdp/` for the old strings
  (`at the spec review`, `decides the spec`) and update any scenario assertion that quotes them.
- [ ] **Step 5:** Commit.

### Task 2: Scenario step for Build this… on a linked canvas

**Depends on:** none

Build this… in a linked design session's canvas pane (`openBuildRun` in
`frontend/app/view/agents/canvaspane.tsx`) attaches the canvas to the waiting run through `routeDesign`, but only
`designroute.test.ts` covers it. Add a step to the `run-sheet-designing` scenario that drives it live.

**Files:**
- Modify: `scripts/cdp/scenarios.mjs` (the `run-sheet-designing` scenario only)

- [ ] **Step 1:** Add step 5 after step 4: on the scenario's mock-up (canvas) designing run, write a `.dc.html`
  board into its session's project, show it in that session's canvas pane on the Agent surface, and click Build
  this…. Assert, as step 4 does for Approve: no New run window opens, the run leaves Designing with `prototype` set
  to the board's absolute path, and the run's channel opens. Shoot it as
  `cdp-shots/run-sheet-designing-5-build-this.png`. Teardown cancels the lead this starts, as it does step 4's.
- [ ] **Step 2:** Run `node scripts/cdp/final-verify.mjs run-sheet-designing`; expect every step to PASS, then open
  the step 5 shot and check it shows the attached run.
- [ ] **Step 3:** Commit.

### Task 3: Run the brainstorm-builder scenarios

**Depends on:** Task 2 (both start a dev app through final-verify.mjs, and two at once compete for its ports)

Task 5 of the run changed step 6b of `brainstorm-builder-check` (goal `Build X.` plus the `Spec · <path>` and
`Prototype · <path>` rows) to match the new `runPrefill`, and no one ran it.

**Files:**
- Modify: `scripts/cdp/scenarios-brainstorm-builder.mjs`, only where a step fails because of this run's change

- [ ] **Step 1:** Run `node scripts/cdp/final-verify.mjs brainstorm-builder-ask brainstorm-builder-check`.
- [ ] **Step 2:** For each failing step, judge whether the run's change caused it (the prefill now opens the
  Approved design start with the spec and the first board as fields). Fix the scenario's expectation when the new
  behavior is what the spec asks; report a product defect under Found not fixed instead of masking it.
- [ ] **Step 3:** Rerun until every step passes; commit any change. With nothing to change, report the PASS table.
