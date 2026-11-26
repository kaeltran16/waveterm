# Board graph layout: round 1 fixes

**Spec:** `docs/superpowers/specs/2026-11-26-board-graph-layout-design.md` (D2: a group has an id and a label)
**Verify:** `node scripts/verify.mjs ./pkg/boarddrawer ./pkg/wshrpc/...`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit && go vet ./pkg/boarddrawer ./pkg/wshrpc/...`
**Final:** `node scripts/cdp/final-verify.mjs boards-ask`

### Task 1: Go refuses a graph group without a label
**Depends on:** none
**Files:** `pkg/boarddrawer/answer.go`, `pkg/boarddrawer/answer_test.go`

`checkGraph` checks a group's id and label word count but not that the label is present, so `{"groups":[{"id":"g1"}]}` passes `CheckAnswer`, and `boardlayout.ts` then throws on `undefined.split` while landing it, so no drawing lands. Refuse a group whose label is missing or blank the same way a node without a label is refused (`unusable("graph group %q has no label", ...)`), so code refuses every answer that would not apply. The frontend stays as it is: Go is the single place that guarantees an answer applies.

**Acceptance:**
- A graph whose group has no `label`, or a blank one, is refused with an unusable reason containing "has no label": two rows joined to the existing `TestCheckAnswerGraph` table.
- Every existing `TestCheckAnswerGraph` row and the rest of the package's tests stay green.
