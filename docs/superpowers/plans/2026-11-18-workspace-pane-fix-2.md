# Workspace pane: final-stage fix, round 2

The final stage failed in Verify again, before any scenario ran, on the same kind of failure as round 1, in
another file this run never touched:
`scripts/bench/tsmutate.test.mjs > mutateRanges > lists exactly the added or changed lines of non-test,
non-generated TS files` hit vitest's default 5000 ms timeout. Run alone it takes about 1.1 s. Under the full
suite's load (collect 545 s across 486 files) a test that spawns git runs about 5x slower. Round 1 raised the
timeout in one file, and the failure moved to the next one. Measured alone, at least 14 tests in
`scripts/bench/` and `scripts/worktree-junctions.test.mjs` take between 0.7 and 2.7 s. Any of them can cross
5 s under load, so the fix is the suite's timeout, not one more file.

**Verify:** `node scripts/verify.mjs ./pkg/brainstormcheck`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
**Final:** `node scripts/cdp/final-verify.mjs workspace-pane workspace-header workspace-ring workspace-run workspace-changes workspace-file workspace-brainstorm-canvas agent-rendered rendered-shell agent-header agent-rail agent-streams agent-subagents agent-tree-rail shell-tasks run-cost code-peek brainstorm-mode rendered-bs-host rendered-bs-mockup rendered-bs-run rendered-bs-check rendered-bs-design rendered-bs-review rendered-bs-question rendered-bs-boards transcript-dagactions`

### Task 1: One suite-wide test timeout that survives a loaded full run
**Depends on:** none
**Files:** `vitest.config.ts`, `scripts/bench/blindreview.test.mjs`

**What to build:** `vitest.config.ts`'s `test` block sets `testTimeout: 30_000`, with a short comment on why:
under the full suite's load, tests that spawn git or node run about 5x slower than alone, and the 5 s default
failed the final stage twice. Then remove the per-test `30_000` arguments round 1 added to
`scripts/bench/blindreview.test.mjs`, so the timeout lives in one place. Leave the existing explicit timeouts
in `scripts/cdp/final-verify.test.mjs` (30_000 and 60_000) as they are, since the 60_000 ones exceed the new
default. No assertion and no code under test changes.

**Acceptance:**
- `vitest.config.ts`'s `test.testTimeout` is 30_000, and `vitest.config.test.ts` still passes.
- `scripts/bench/blindreview.test.mjs` has no per-test timeout argument, and its assertions are unchanged.
- `npx vitest run scripts/bench scripts/worktree-junctions.test.mjs vitest.config.test.ts` passes.
