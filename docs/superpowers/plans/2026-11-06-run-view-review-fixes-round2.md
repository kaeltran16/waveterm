# Run view live pass fixes, round 2 Implementation Plan

**Spec:** `docs/superpowers/specs/2026-11-06-run-view-review-fixes-design.md` (F9 and F17 sections; the decisions below amend them)
**Verify:** `node scripts/verify.mjs ./pkg/wstore ./pkg/orchestrate ./pkg/wshrpc/wshserver ./cmd/wsh/cmd`
**Check:** `task check:ts`
**Final:** `node scripts/cdp/final-verify.mjs dag-lifecycle dag-observability dag-peek dag-motion plan-review-rounds final-shots palette-actions`

**Goal:** Clear every step that failed the round-1 Final on the merged result: a load timeout in `final-verify.test.mjs` (Verify), `dag-motion` step 5 (F17 drawer), `dag-peek` step m (the tagged card's chip) and `plan-review-rounds` step 4 (plan-reviewer rows in the agent tree).

**Architecture:** Four fixes. The Verify flake is a test-only fix in its own file and runs beside the rest. The other three each touch `scripts/cdp/scenarios-runs.mjs`, so they run one after another. React 19 + Tailwind 4 + jotai; logic in pure `.ts` files with tests beside them.

## Global Constraints

- "The dag has ended" is `runFinished({ dag: group, status: group.status })` (`frontend/app/view/agents/runlineage.ts`); no new predicate.
- Logic goes in a pure `.ts` with its test beside it; a `.tsx` only calls it. Existing `@theme` tokens only; no edit to `tailwindsetup.css`. Copy is sentence case.
- Never attach to or kill a dev app on :9222. A live check runs only through `final-verify.mjs`'s isolated app (`node scripts/cdp/final-verify.mjs <scenario>`), which a task here may run to measure and to confirm its step.
- A scenario step's bar changes only where this plan says so, with the reason in the commit body; never loosen a bar to make a step pass.
- Every line number below is pre-edit; anchor on the quoted code.

## Review Focus

1. F9 still holds: on every card the `id · state word` span is whole and visible, with or without a tag (Task 2).
2. The F17 step's new bar encodes the review's complaint (cards cut through, one rail row), not a number tuned to pass (Task 1).
3. `plan-review-rounds` step 4 is fixed at its cause, named in the commit body, not by a longer wait alone (Task 3).

---

### Task 1: The open Lifecycle drawer leaves the graph the larger share (F17 drawer)
**Depends on:** none
**Files:** `frontend/app/view/orchestrate/timelinerail.tsx`, `scripts/cdp/scenarios-runs.mjs`

Round 1 hid the activity strip in the drawer, but the drawer is capped at `max-h-[45%]` and its rows now fill that cap, so the graph pane stayed at 143px at 1000x700, as the review measured before the fix. The plan's 300px bar was set without measuring the 1000x700 modal: its body there is small enough that 300px may not be reachable even with the drawer collapsed.

- [ ] Measure first, in the isolated app at 1000x700 (`dag-motion`): the modal body's height, the graph header's, the drawer's open and collapsed heights, and the graph pane's in both states. Put the numbers in the commit body.
- [ ] **Product:** the drawer's open cap (`timelinerail.tsx`, `"flex max-h-[45%] flex-none flex-col border-t border-border bg-surface"`) becomes `max-h-[35%]`, so the graph keeps about two thirds of the body.
- [ ] **Step 5** (`dagMotionViewport`, the `DAG_MOTION_PANE_MIN_PX` check): replace the fixed 300px bar with what the review called the defect. With the drawer open and the strip absent: the graph pane is taller than the open drawer; after the refit (wait for it, as step 6 does), every `[data-dag-node]` rect lies inside the graph pane's rect (no card cut through); and the drawer shows at least 3 `[data-timeline-row]` rows. Remove `DAG_MOTION_PANE_MIN_PX` if nothing else reads it. Keep the step's number and its F17 label.
- [ ] Run `node scripts/cdp/final-verify.mjs dag-motion` and report the step's recorded values.

### Task 2: The card's model tag names the model only (F9 with a tag)
**Depends on:** Task 1 (both edit `scripts/cdp/scenarios-runs.mjs`)
**Files:** `frontend/app/view/orchestrate/taskroute.ts`, `frontend/app/view/orchestrate/taskroute.test.ts`, `frontend/app/view/orchestrate/dagnodes.tsx`, `scripts/cdp/scenarios-runs.mjs`

F9 made the card's `id · state word` span `flex-none`, as the spec decided. The tag is `flex-none` too, and `t-4 · waiting` plus `haiku · pinned` is wider than the card's 176px inner width (`CARD_W` 196 minus padding), so the chip overflows the card's right edge (`dag-peek` step m: `fits: false`). The word and the chip cannot both stay whole on one line once the tag carries its source.

Decision: the chip names the model only (`haiku`); who put it there (`pinned`, `plan's pick`, `escalated`, ...) moves to the chip's `title` and the card's `aria-label`, and the peek's route row already shows it (`dagtaskpeek.tsx`, `routeSourceLabel(view.route.source) · ...`). The chip also gets `min-w-0 truncate` as the fallback for a long model id, so it never leaves the card. The state word never gives way (DESIGN.md: status is never colour alone).

- [ ] `cardModelTag` (`taskroute.ts`, "return `${shortModel(r.model)} · ${tag}`") returns `shortModel(r.model)` only; the `CARD_TAG` map still decides which sources show a tag. Update its tests in `taskroute.test.ts` (`"sonnet · review"` becomes `"sonnet"`, and so on); the null cases stay unchanged.
- [ ] `dagnodes.tsx`, the tag span (`"flex-none rounded-[5px] border border-edge-mid bg-surface-raised px-[5px] text-[11.5px] text-accent-soft"`): add `data-dag-node-tag`, a `title` of the model, then ` · `, then `routeSourceLabel(view.route.source)` (re-exported from `dagstore.ts`), and replace `flex-none` with `min-w-0 truncate`. Add the tag and its source to the card's `aria-label`.
- [ ] **Step m** (`dag-peek`, the chip check that finds the span by `/pinned$/`): select `[data-dag-node-tag]` in t-4's card instead, and add that the chip's text is the model only (no ` · `). Keep its other checks (one line, nothing clipped, inside the card, the floor, equal card heights).
- [ ] The F9 step (`dag-peek`, `[data-dag-node-word]` on the tagged card) stays as it is and must still pass.
- [ ] Run `node scripts/cdp/final-verify.mjs dag-peek` and report steps m and F9.

### Task 3: Plan-reviewer rows reach the agent tree in the isolated app
**Depends on:** Task 2 (both edit `scripts/cdp/scenarios-runs.mjs`)
**Files:** `scripts/cdp/scenarios-runs.mjs`

`plan-review-rounds` step 4 ("the agent tree's plan-reviewer rows name their lens and verdict") failed in both of round 1's isolated Final runs with "no plan-reviewer rows in the tree: the run's reviewer tabs were reaped or never joined the roster". It runs before any step round 1 added to that scenario, and `PLAN_REVIEW_TREE_ROWS` already polls for 10s.

- [ ] Find the cause. Run `node scripts/cdp/final-verify.mjs plan-review-rounds` on this branch, and on the base (`git worktree add` of `main` at a temp path, `task worktree:prepare`, run it there, then remove it with `task worktree:cleanup -- <path>`) to learn whether round 1 broke it. Read what the tree and the roster hold for the run's reviewer tabs at step 4.
- [ ] Fix it at the cause: in product code (a file outside this task's list; name it under Differs from plan and in the commit body) if round 1's changes (DAG modal, run sheet, `openref.ts`, palette) broke how reviewer tabs join the roster or show in the tree; in the scenario if its fixture or timing is wrong (for example, reviewer tabs a teardown or earlier step reaps). The step's bar does not change.
- [ ] Run `node scripts/cdp/final-verify.mjs plan-review-rounds` and report every step's result.

### Task 4: The build-slot cleanup hook gets its tests' load allowance
**Depends on:** none
**Files:** `scripts/cdp/final-verify.test.mjs`

Verify failed on the merged result with `final-verify.mjs build slots > is unverified when other final stages keep every slot past the wait: Hook timed out in 10000ms` in the describe's `afterEach` (`rmSync(dir, { recursive: true, force: true })`). Run alone, the describe passes 3 of 3. It is load: Verify runs while workers build. The tests in that describe already carry 30-60s timeouts for the same reason (commits `6ce61f8d1`, `26ee8b254`, `3178c2270`); the hook was left on vitest's 10s default.

- [ ] Give that `afterEach` a 30_000 timeout (vitest's last argument) and pass `maxRetries: 3` to its `rmSync`, since a Windows file a just-exited child held can refuse the first delete. Check the file's other `afterEach`/`afterAll` hooks that remove a temp dir a child process used, and give them the same.
- [ ] Run `npx vitest run scripts/cdp/final-verify.test.mjs` and report it.
