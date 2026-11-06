# Run view live pass fixes, round 3 Implementation Plan

**Spec:** `docs/superpowers/specs/2026-11-06-run-view-review-fixes-design.md` (F1, F5, F17, F20, F21: the timeline rail sections)
**Verify:** `node scripts/verify.mjs ./pkg/wstore ./pkg/orchestrate ./pkg/wshrpc/wshserver ./cmd/wsh/cmd`
**Check:** `task check:ts`
**Final:** `node scripts/cdp/final-verify.mjs dag-lifecycle dag-observability dag-peek dag-motion plan-review-rounds final-shots palette-actions`

**Goal:** `model-picks` step 7 ("the timeline's Plan reviewed row lists two reviewers") passes again. In round 2's isolated app it found no timeline rows at all (`{"found":false,"rows":[]}`), while `plan-review-rounds` step 2 reads the same rail through the same `railGroupExpr` and passes. This run rewrote the timeline rail (`652fa1a3d`, `a728ee85d`) and the run event load (`a61a68c95`), so it may have broken it.

**Architecture:** One task. React 19 + Tailwind 4 + jotai; logic in pure `.ts` files with tests beside them.

## Global Constraints

- Never attach to or kill a dev app on :9222. Live checks run only through `final-verify.mjs`'s isolated app (`node scripts/cdp/final-verify.mjs <scenario>`). The engine refuses `git worktree add`; to learn how the step behaved before this run, read the code at `cb22dfefd` (`git show cb22dfefd:<path>`), do not check it out.
- The step's bar does not change. Never loosen a bar to make a step pass.
- Logic goes in a pure `.ts` with its test beside it; a `.tsx` only calls it.
- Every line number below is pre-edit; anchor on the quoted code.

## Review Focus

1. The commit body names the cause of the empty rail in `model-picks` and whether this run's changes caused it.
2. The fix is at the cause: product code if the rail or the event load drops what it should show, the scenario if its fixture, viewport or timing is wrong.

---

### Task 1: The rail shows the model-picks run's Plan reviewed row
**Depends on:** none
**Files:** `scripts/cdp/scenarios-runs.mjs`, `frontend/app/view/orchestrate/timelinerail.tsx`, `frontend/app/view/agents/runeventstore.ts`

- [ ] Run `node scripts/cdp/final-verify.mjs model-picks` and record what the DAG modal holds at step 7: the rail's `data-timeline-rail` layout, whether the drawer is open, `[data-timeline-count]`, the rows, and the run's events (`runEventsAtom`, or `JarvisRunEventsCommand` for the run).
- [ ] Find the cause. Compare with `plan-review-rounds` step 2, which passes through the same `railGroupExpr`: the viewport each scenario runs at (a drawer layout starts collapsed, so it renders no rows), the run id the rail reads, and whether the Plan reviewed event reaches the store. Read the base's rail and event load at `cb22dfefd` to say whether this run caused it.
- [ ] Fix it at the cause. If the cause is in a product file not listed above, fix it there and name it under Differs from plan and in the commit body. If the fix is in the scenario, keep step 7's bar as it is.
- [ ] Run `node scripts/cdp/final-verify.mjs model-picks dag-observability` and report every step's result.
