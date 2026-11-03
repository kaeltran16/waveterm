# final-stage Part B flake: round 1 fix

> **For agentic workers:** Use superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Spec:** `C:\Users\kael02\AppData\Local\arc-wt\79205509\docs\superpowers\specs\2026-11-03-next-feature-design.md`

**Goal:** Remove the dead modal-reopen guard in `fstDag`, which t-1 found stale since 559f5eda.

## Decisions

- **Remove the guard, not just its comment.** Since 559f5eda (`fix(orchestrate): leaving Jarvis closes the DAG
  modal`) `DagModal` dismisses itself on unmount, so after `fstDag` switches to Jarvis the modal cannot already be
  open. The inner `if (!(await h.ev(`${FST_MODAL} != null`)))` before the "Open DAG" click is dead code, and its
  comment ("a modal the last visit left open comes back with the surface") describes behavior the app no longer
  has. The outer check at the top of `fstDag` (already on Jarvis with the modal open) stays: that case is live.
- **No other change.** The unproven tick-over-seed mechanism and the `active.json` collision between concurrent
  `final-verify.mjs` runs are open issues, not this round's work.

---

### Task 1: Drop fstDag's dead modal-reopen guard
**Depends on:** none
**Files:** `scripts/cdp/scenarios-runs.mjs`

- [ ] **Step 1:** In `fstDag` (about line 3056), delete the comment `// a modal the last visit left open comes back with the surface`
  and replace the guarded click with an unconditional `await finalShotsClick(h, openDag);`. Leave the rest of
  `fstDag` as is.
- [ ] **Step 2:** Run `ARC_FINAL_OUT=<tmp dir> node scripts/cdp/final-verify.mjs final-stage`; every step passes
  (B2 opens the DAG through this path).
- [ ] **Step 3:** Commit `scripts/cdp/scenarios-runs.mjs` only, subject `chore(cdp): drop fstDag's dead modal-reopen
  guard`, body naming 559f5eda as why the guard is dead.

**Acceptance:** `fstDag` clicks "Open DAG" without the inner modal check; the stale comment is gone; `final-stage`
passes.
