# Brainstorm pane, run records review fixes: final-stage round 1

> **For agentic workers:** each task below runs as one engine worker. Steps use checkbox (`- [ ]`) syntax.

**Spec:** `docs/superpowers/specs/2026-11-05-brainstorm-records-review-fixes-design.md`
**Verify:** `node scripts/verify.mjs ./pkg/wavevault ./pkg/jarvisdossier ./pkg/jarvisattrib ./pkg/wshrpc/...`
**Check:** `task check:ts`
**Final:** `node scripts/cdp/final-verify.mjs brainstorm-mode brainstorm-main brainstorm-check-review brainstorm-builder-check brainstorm-run-landed brief-peek record-band-detach-restore`

**Goal:** Make the one failing Final step pass: `brainstorm-run-landed` step 3 expects the agent tree's brainstorm
line to read `Brainstorm done · merged · run <id8>`, and the app draws `merged · run <id8>`.

**Architecture:** The app is right and the scenario is stale. Commit `71181210f` ("a brainstorm chip on the agent's
row toggles its brainstorm pane", 2026-10-26) dropped the line's "Brainstorm ·" lead on purpose, because the chip
beside it names the brainstorm. It updated `scenarios.mjs` but not `scenarios-brainstorm-run.mjs`. The line comes
from `treeLine` (`frontend/app/view/agents/brainstormmodel.ts:558`) and `runTreeText`
(`frontend/app/view/agents/brainstormrunmodel.ts:196`), which give `<state> · run <id8>`. This run did not touch
either of them or `agenttree.tsx`, so the failure predates the run.

**Tech Stack:** CDP scenarios (`scripts/cdp/scenarios-*.mjs`).

## Global Constraints

- Never run prettier on `scripts/*.mjs`. Keep the file's hand-formatted 4-space style.
- Never attach to or kill the dev app on :9222. A snapshot review app runs there.
- No app code changes: the tree line's text is the intended design.

## Review Focus

- A step's expected text must still pin the state *and* the run id, so a wrong state or id fails the step.
- The `treeStateFit` check (the state drawn inside the line's visible box) stays on each step unchanged.

---

### Task 1: Tree-line steps expect the chip-era text
**Depends on:** none
**Files:** `scripts/cdp/scenarios-brainstorm-run.mjs`

Every line number below is pre-edit.

- [ ] **Step 1: Update the three stale expectations, and the step names that quote them.**
  - `brainstorm-run-blocked` (:344-345): want `` `final failed · run ${short}` ``, step name "2. the tree line reads
    final failed · run <id8>, the state drawn inside it".
  - `brainstorm-run-landed` (:431-432): want `` `merged · run ${short}` ``, step name "3. the tree line reads
    merged · run <id8>, the state drawn inside it".
  - `brainstorm-run-missing` (:518-519): want `` `not found · run ${short}` ``, step name "2. the tree line reads
    not found · run <id8>, the state drawn inside it".
  Leave the `treeStep` calls' state argument ("final failed", "merged", "not found") as it is.

- [ ] **Step 2: Run the three scenarios in an isolated app.**
  Run: `node scripts/cdp/final-verify.mjs brainstorm-run-blocked brainstorm-run-landed brainstorm-run-missing`
  Expected: every step PASSes. The landed step 3 detail reads `{"text":"merged · run <id8>","merged":{"ok":true,…}}`.

- [ ] **Step 3: Commit.**
  ```bash
  git add scripts/cdp/scenarios-brainstorm-run.mjs
  git commit -m "test(cdp): brainstorm run tree steps expect the chip-era line" -m "71181210f dropped the tree line's Brainstorm lead because the row's chip names it; these three steps still expected it."
  ```
