# Cleanup Round, Fix Round 1

**Goal:** Make the run's Verify pass on the merged result: one test still pins the run-finished rule's text from before Task 3.

## Why

Verify (`node scripts/verify.mjs ./pkg/orchestrate ./pkg/jarvis ./pkg/wshrpc/wshserver ./cmd/wsh/cmd`) failed on the merged result:

```
--- FAIL: TestRunFinishedReportIsJudgmentOnly (0.00s)
    leadprompt_test.go:367: rules missing "the decisions you made (answers, skips, tells, sendbacks) and why"
```

Task 3 changed the run-finished rule in `pkg/jarvis/leadprompt.go:75` to "the decisions you made (answers, skips, tells, sendbacks, a round) and why", as the plan specified, but `TestRunFinishedReportIsJudgmentOnly` in `pkg/jarvis/leadprompt_test.go:362` still asserts the old substring. The production text is correct; the test is stale.

### Task 1: Update the stale run-finished report substring in the lead-prompt test

**Files:** `pkg/jarvis/leadprompt_test.go`

- [ ] **Step 1:** In `TestRunFinishedReportIsJudgmentOnly`, change the `want` entry `"the decisions you made (answers, skips, tells, sendbacks) and why"` to `"the decisions you made (answers, skips, tells, sendbacks, a round) and why"`. Do not change `pkg/jarvis/leadprompt.go`.
- [ ] **Step 2:** Grep `pkg/` for any other test asserting `sendbacks) and why` and update it the same way (none is expected).
- [ ] **Step 3:** Run `go test ./pkg/jarvis -run '^TestRunFinishedReportIsJudgmentOnly$'` and confirm it passes; then run `go test ./pkg/jarvis` (the package is small) and confirm it passes.
- [ ] **Step 4:** `gofmt -l pkg/jarvis/leadprompt_test.go` prints nothing. Commit `pkg/jarvis/leadprompt_test.go` only.
