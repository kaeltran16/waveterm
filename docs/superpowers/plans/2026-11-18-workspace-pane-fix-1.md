# Workspace pane: final-stage fix, round 1

The final stage failed in Verify on the merged result ce58beb, before any scenario ran. The one failure is a
timeout in a test that predates this run and that the run did not touch:
`scripts/bench/blindreview.test.mjs > reviewBench > writes shuffled diffs, a key, and verdicts unblinded
through the key (rng 0.1)` hit vitest's default 5000 ms. Each `reviewBench` case builds four throwaway git
repos; run alone the case takes about 2.7 s, and under the full suite's load (collect 584 s) it crossed 5 s.

**Verify:** `node scripts/verify.mjs ./pkg/brainstormcheck`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
**Final:** `node scripts/cdp/final-verify.mjs workspace-pane workspace-header workspace-ring workspace-run workspace-changes workspace-file workspace-brainstorm-canvas agent-rendered rendered-shell agent-header agent-rail agent-streams agent-subagents agent-tree-rail shell-tasks run-cost code-peek brainstorm-mode rendered-bs-host rendered-bs-mockup rendered-bs-run rendered-bs-check rendered-bs-design rendered-bs-review rendered-bs-question rendered-bs-boards transcript-dagactions`

### Task 1: Give the git-repo bench tests a timeout that survives the full suite
**Depends on:** none
**Files:** `scripts/bench/blindreview.test.mjs`

**What to build:** the `reviewBench` describe's cases (and any other case in the file that builds git repos,
such as `armDiff`) get an explicit per-test timeout sized for a loaded machine, 30_000 ms, following the
`}, 30_000);` convention in `scripts/cdp/final-verify.test.mjs` (for `it.each`, the timeout is the last
argument of the returned function). Assertions do not change; the code under test does not change.

**Acceptance:**
- `npx vitest run scripts/bench/blindreview.test.mjs` passes, every assertion unchanged.
- Each test in the file that creates a git repo carries the 30_000 ms timeout; the pure tests (`parseVerdict`,
  `combineOrders`, `buildPrompt`, `claudeEnv`, `judgePick`) keep the default.
