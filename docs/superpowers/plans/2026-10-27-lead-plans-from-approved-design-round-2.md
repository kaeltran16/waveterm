# Lead Plans From Approved Design: Round 2 Fix

**Spec:** `C:/Users/kael02/IdeaProjects/waveterm/docs/superpowers/specs/2026-10-27-lead-plans-from-approved-design-design.md`
**Verify:** `node scripts/verify.mjs ./pkg/jarvis/... ./pkg/waveobj/... ./pkg/wshrpc/... ./pkg/orchestrate/... ./cmd/wsh/...`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit && go vet ./pkg/jarvis/... ./pkg/waveobj/... ./pkg/wshrpc/... ./pkg/orchestrate/... ./cmd/wsh/...`
**Final:** `node scripts/cdp/final-verify.mjs new-run-design run-sheet-designing`

The final stage failed on one defect: the run-defaults panel's Approvals note still promises the Spec review the
lead no longer holds (spec decision 2: the lead plans from an approved design, or asks `Needs a design`).

### Task 1: Run-defaults Approvals note drops the Spec review

**Depends on:** none

**Files:** `frontend/app/view/jarvis/briefprofileview.tsx`

Change `APPROVALS_NOTE.ask` (line 86).

- [ ] **Step 1:** Set `APPROVALS_NOTE.ask` to exactly
  `"The lead stops for a goal that needs a design, a plan review that failed twice, product calls, and the last failed final stage."`
  Leave `APPROVALS_NOTE.autonomous` as it is.
- [ ] **Step 2:** Grep `frontend/`, `scripts/cdp/` and `docs/orchestrator-guide.md` case-insensitively for
  `spec review` and confirm no remaining hit describes the lead stopping for or holding a Spec review (the
  doc-review dialog's `Spec review` header and its tests are a different feature and stay).
- [ ] **Step 3:** Run `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`; expect exit 0.
- [ ] **Step 4:** Commit.
