# Brainstorm pane: the judge's wait, final-stage fix round 1

> **For agentic workers:** each task below is one worker's. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the final stage's one failing step, `brainstorm-mode` step 2c, pass on the merged result.

**Architecture:** Base commit `042a9906` ("the design canvas lists decisions newest first") reversed the order
`DesignMain` (`brainstormpane.tsx`) draws decisions in, and updated `brainstorm-review-skim` for it, but not
`brainstorm-mode` step 2c. That step compares `JSON.stringify(bsStates(s2d))` against
`JSON.stringify(BS_MID_STATES)`, so it is order-sensitive: the round-1 final read exactly the wanted id → state pairs
in the reverse order and failed. This run's work did not cause it.

**Tech Stack:** CDP scenarios (`scripts/cdp/scenarios.mjs`).

**Spec:** `C:\Users\kael02\IdeaProjects\waveterm\docs\superpowers\specs\2026-10-26-brainstorm-pane-interaction-design.md`
**Verify:** `node scripts/verify.mjs ./pkg/wshrpc/... ./cmd/...`
**Check:** `go build ./... && go vet ./pkg/wshrpc/... && task check:ts`
**Final:** `node scripts/cdp/final-verify.mjs brainstorm-judge-wait brainstorm-judge-tree brainstorm-judged-question brainstorm-mode brainstorm-builder-check surface-smoke`

## Global Constraints

- Change only the test step. The pane's newest-first decision order (`042a9906`) is intended and stays.
- Never run prettier on `scripts/*.mjs` (hand-formatted, 4-space).

## Review Focus

- Step 2c must still fail when any part's state is wrong, or when a part is missing or extra; only the order is freed.

---

### Task 1: brainstorm-mode step 2c checks part states without depending on their order

**Depends on:** none

**Files:** `scripts/cdp/scenarios.mjs`

The step to change is `2c. part states: yours ×3, guess ×3, asked, open`, near line 19331. The round-1 final's detail for the step, verbatim:
`{"states":{"builder":"open","page":"guess","thresholds":"asked","constraints":"guess","current":"guess","anti":"yours","goals":"yours","intent":"yours"},"want":{"intent":"yours","goals":"yours","anti":"yours","current":"guess","constraints":"guess","thresholds":"asked","page":"guess","builder":"open"}}`

- [ ] **Step 1:** Change step 2c's condition so it passes when the read states hold exactly the same id → state pairs as
  `BS_MID_STATES`, in any order: same key count, and every key of `BS_MID_STATES` read with its wanted state. Keep the
  step's name and its `{ states, want }` detail. Leave `bsStates` and `BS_MID_STATES` as they are, and use no other
  step's order change: 2c is about states; `brainstorm-review-skim` already checks the newest-first order.
- [ ] **Step 2:** `node --check scripts/cdp/scenarios.mjs` exits 0.
- [ ] **Step 3:** If the worker can run the scenario, run `brainstorm-mode` alone as the engine's worker prompt says, and
  confirm 2c passes and no other step changed state; if it cannot, say so in the report.
- [ ] **Step 4:** Commit `scripts/cdp/scenarios.mjs` only, subject
  `test(brainstorm): brainstorm-mode's part-states step no longer depends on the decision order`.
