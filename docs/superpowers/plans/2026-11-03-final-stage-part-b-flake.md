# final-stage Part B flake: diagnose and fix

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan. Debug with
> the `diagnosing-bugs` skill (mattpocock:diagnosing-bugs), not systematic-debugging. Steps use checkbox (`- [ ]`) syntax.

**Spec:** `C:\Users\kael02\IdeaProjects\waveterm\docs\superpowers\specs\2026-11-03-next-feature-design.md` — decides
no new feature; this plan takes its "if work is wanted" branch: the one actionable backlog row.
**Verify:** `node scripts/verify.mjs ./pkg/orchestrate ./pkg/jarvis`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
**Final:** `node scripts/cdp/final-verify.mjs final-stage final-shots final-rerun`

**Goal:** Find why the `final-stage` CDP scenario's Part B (B2–B6) fails intermittently, fix the cause, and close
the row in `docs/open-issues.md` §1.

**Architecture:** No new code path. The scenario (`scripts/cdp/scenarios-runs.mjs`, `finalStageScenario`) seeds the
run's dag through `seedDag`/`fstShow` (`scripts/cdp/scenarios-shared.mjs`), publishes `final-step` run events, and
reads the Agent surface's final row/pane and the Jarvis run sheet's DAG modal. The fix lands wherever the cause is:
the scenario's helpers, or the frontend/engine code that shows the stale state.

**Tech Stack:** Node CDP harness (`scripts/cdp/`), React 19 + jotai frontend, Go engine (`pkg/orchestrate`).

## Decisions beyond the spec

- **This run does the flake, not a feature.** The spec chooses no feature and names this row as the only work if
  work is wanted; the run's goal asks for work, so the plan is that row. No feature is added.
- **One task, no width.** Diagnosis is one loop (reproduce, narrow, fix, re-run); its parts cannot proceed
  independently, and inventing parallel tasks would split one causal chain across workers who cannot see each
  other's evidence.
- **Root cause, never a band-aid.** A longer wait, a retry, or a loosened assertion is not a fix unless the
  diagnosis shows the scenario waits on the wrong signal; then the fix is waiting on the right one. If the cause is
  product code (the DAG modal or the tree row showing stale state, or the selected final row losing focus across a
  surface switch), fix the product: a real user would see the same staleness.
- **Known shape to start from** (from `docs/open-issues.md` §1, not proven): in B2 the DAG modal's final node still
  reads B1's "waits on every task" while the tree row already shows Tree running; from B3 on the final row has lost
  its selection (no pane). Leads worth testing first, none decided: `fstDag` reuses a modal "the last visit left
  open", which comes back with the Jarvis surface and may read a cached dag; the watchdog tick can write over a seed
  after `seedDag`'s check passes; `setmeta` is what sends the seeded dag to the page.
- **Reproduce before fixing.** Run `ARC_FINAL_OUT=<dir> node scripts/cdp/final-verify.mjs final-stage` (it starts
  its own isolated dev app from the task's tree) until Part B fails, at most 6 runs. If it never fails in 6, change
  no code: write the run count, the per-step outcomes and what was ruled out into the open-issues row, and complete.
- **Diagnostics are temporary.** Instrumentation added to find the cause is removed before completing, unless it is
  a step `detail` that would have named this cause on the next failure.
- **Shared helpers keep their contract.** `seedDag`, `fstShow` and `fstWriteRun` are also called by `final-shots`,
  `final-rerun` and scenarios in other area modules; the Final line runs the final-* ones. A change to a helper's
  behavior for callers outside `final-*` means running those callers' scenarios too, named in the task's report.

## Review Focus

- A user who opens the run's DAG after the final stage advanced sees the current final node, not the state from
  when the modal was last open.
- A user who selected the Final verification row keeps it selected (and its pane open) across Agent → Jarvis → Agent
  switches.
- A seed the scenario writes is not overwritten by a watchdog tick after the scenario has checked it.
- Events published before the run's history loaded are not lost (the `nudge` republish still covers B3–B5).
- The fix does not change what B1–B6 assert; a step that now passes passes on the same expectations.

---

### Task 1: Diagnose and fix the final-stage Part B flake
**Depends on:** none
**Files:** `scripts/cdp/scenarios-runs.mjs`, `scripts/cdp/scenarios-shared.mjs`, `docs/open-issues.md`

A product-code fix adds the frontend or Go files it touches, plus their tests.

- [ ] **Step 1: Reproduce.** Run `ARC_FINAL_OUT=<tmp dir> node scripts/cdp/final-verify.mjs final-stage` up to 6
  times; keep each run's `shots.json` and the failing steps' `detail`. Stop at the first Part B failure. If none
  fails, follow the no-repro rule in the header.
- [ ] **Step 2: Narrow to one cause.** Using the failing run's details and screenshots (`b2-tree-dag.png`,
  `b3-alongside-pane.png`), find which source the stale view reads and why it misses the update. State the cause
  in one sentence, with the evidence that proves it (a read of the page's atom or the stored dag at the failing
  moment, not inference).
- [ ] **Step 3: Pin it.** If the cause is in product logic with a pure model (`frontend/app/view/*` derive/model
  file), write a vitest beside it that fails on the stale behavior; run `npx vitest run <that test file>` and see it
  fail. If it is in the engine, a `go test ./pkg/<pkg> -run '<TestName>'` that fails. If it is in the scenario
  itself, the failing scenario run from Step 1 is the pin.
- [ ] **Step 4: Fix the cause** where it lives (see the header's root-cause rule).
- [ ] **Step 5: Prove it.** The Step 3 test passes. Then `ARC_FINAL_OUT=<tmp dir> node scripts/cdp/final-verify.mjs
  final-stage` passes 5 runs in a row with every step (0, 0b, B1–B6, Part A) PASS. If a helper in
  `scenarios-shared.mjs` changed, `final-shots` and `final-rerun` pass too.
- [ ] **Step 6: Close the row.** Remove the `final-stage` row from `docs/open-issues.md` §1 (leave "Tracked in their
  own initiatives" as is), so §1 holds no actionable row from this flake. Remove any temporary instrumentation.
- [ ] **Step 7: Commit** the changed paths only (`git add <paths>`), subject `fix(cdp): ...` or the product area's
  prefix, body naming the cause and the 5-run evidence.

**Acceptance:** the cause is stated with evidence in the commit body; the pinning test (Step 3) fails before the
fix and passes after; `final-stage` passes 5 consecutive runs; the open-issues row is gone (or, on no repro, updated
with the 6 runs and what they ruled out, with no code change).
