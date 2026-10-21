# Brainstorm builder step: fix round 1

The final stage found one defect (bug 4): the Agent tree's brainstorm line elides the run state it now carries.
`BrainstormTreeLine` (`frontend/app/view/agents/agenttree.tsx`, ~line 246) puts the run text in a `<button>`, an
atomic inline-block inside a `truncate` span, so once the line overflows the whole button is cut. At the tree's
default width `brainstorm-run-landed-2-passed.png` reads `Brainstorm done · …` and `brainstorm-run-missing.png`
reads `Brainstorm · …`.

Lead's call, recorded here: fix both causes. The state goes ahead of the id (`final failed · run 9c6eb723`), since
the state is what the line is for and the id only names the link target, and the text truncates as text rather
than as a block. The scenarios then check that the state is drawn inside the line's visible box, not only that
the DOM holds it.

### Task 1: The tree line shows the run's state first and truncates as text
**Depends on:** none
**Files:** `frontend/app/view/agents/brainstormrunmodel.ts`, `frontend/app/view/agents/brainstormrunmodel.test.ts`, `frontend/app/view/agents/brainstormmodel.test.ts`, `frontend/app/view/agents/agenttree.tsx`, `scripts/cdp/scenarios-brainstorm-run.mjs`

- [ ] **Step 1: Update the tests first.** In `brainstormrunmodel.test.ts`, `runTreeText(BLOCKED_ID, { tree: "final failed" })`
  is `"final failed · run 9c6eb723"`. `runTreeText(BLOCKED_ID, { tree: "" })` stays `"run 9c6eb723"`. In
  `brainstormmodel.test.ts` the `treeLine` cases that pass a run text use the new order
  (`"building 3/10 · run abcdef01"`, `"merged · run abcdef01"`). Run
  `npx vitest run frontend/app/view/agents/brainstormrunmodel.test.ts frontend/app/view/agents/brainstormmodel.test.ts`:
  the `runTreeText` case fails.
- [ ] **Step 2: `runTreeText(runId, view)`** in `brainstormrunmodel.ts` returns `` `${view.tree} · run ${id8}` ``, or
  `run <id8>` when `tree` is empty. Update its comment if it names the order. Rerun step 1's command: all pass.
- [ ] **Step 3: `BrainstormTreeLine` truncates as text.** The outer `[data-brainstorm-tree-line]` span becomes
  `flex min-w-0 items-baseline text-[11.5px]` (no `truncate` on it). The lead span and the ` · ` separator get
  `flex-none whitespace-pre` (the separator keeps its spaces). The run `<button>` and the plain-text span each get
  `min-w-0 truncate`, plus `text-left` on the button. Click behaviour, colours and titles stay as they are.
  The row that holds the line must let it shrink: if its parent is a flex item without `min-w-0`, add `min-w-0` there,
  and touch nothing else in the row.
- [ ] **Step 4: Scenario steps check what is drawn.** In `scenarios-brainstorm-run.mjs`, the three tree-line steps
  (blocked step 2, landed step 3, missing step 2) expect the new order:
  `Brainstorm · final failed · run <id8>`, `Brainstorm done · merged · run <id8>` and
  `Brainstorm · not found · run <id8>`. Each one also reads, in the page, a `Range` over the state's text
  (`final failed`, `merged`, `not found`) inside `[data-brainstorm-tree-line]`, and passes only when that range's
  `getBoundingClientRect().right` is at most the right edge of the element that clips it (the button or span
  carrying `truncate`) plus 0.5px. Keep the tree at its default width: don't widen it for the check. Record
  the measured numbers in the step's detail.
- [ ] **Step 5: Verify.** Run `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (exit 0). Then run
  `node scripts/cdp/final-verify.mjs brainstorm-run-blocked brainstorm-run-landed brainstorm-run-missing`: every
  step passes. In `cdp-shots/brainstorm-run-blocked-*.png`, `brainstorm-run-landed-*.png` and
  `brainstorm-run-missing*.png` the tree line visibly shows `final failed`, `merged` and `not found`.
  Name the shots you looked at in your report.
