# Mutation survivors, wave 1 of 5: round fixes

Follow-ups the wave 1 tasks and reviews left in the tests they wrote. Change only test files; `git diff` must show no
change to any non-test file. Keep each file's existing line endings (some test files are CRLF in HEAD), and use the
edit tool rather than heredocs or python for strings that contain backslashes.

### Task 1: Fix the stale gitinfo empty-repo test and the agentask keystroke timing margin
**Depends on:** none

- `pkg/gitinfo/gitinfo_test.go`, `TestHistoryLogEmptyRepoIsNotAFailure`: its comment says `git log` exits 128 in a
  freshly initialised repo. With no `Ref`, `HistoryLog` walks `--all`, which exits 0 there (git 2.48.1), so the test
  never reaches the unborn-branch path; `TestHistoryLogUnbornRefIsEmptyHistory` (Ref "main") covers that path. Rewrite
  the comment (and the test name if it misleads) to say what the test actually checks: a new repo with no `Ref` reads
  as an empty history, not a failure. Keep its assertions.
- `pkg/agentask/deliver_test.go`, `TestDeliverAnswer_SpacesKeystrokes`: it asserts that the first keystroke arrives
  less than `KeystrokeDelay` (60 ms) after the call. A scheduling stall of about 60 ms on a loaded machine (Verify
  runs four test processes at once) fails it. Make the test deterministic, so it does not depend on wall-clock slack.
  For example, replace the sleep through a seam the package already has, or one in the test's style, and record the
  sleeps rather than timestamps. If the package has no seam and adding one would mean changing source, assert on
  ordering instead: the first keystroke comes before any sleep, and there is a sleep of at least `KeystrokeDelay`
  between the two keystrokes. Whatever you choose, it must still kill both mutations the test was written for: the
  delay moved before the first keystroke, and the delay removed. Prove each one by applying it, watching the test
  fail, and restoring the source.

Run `go test ./pkg/gitinfo ./pkg/agentask` whole.

### Task 2: Tidy the cockpit-actions launchAgent test setup
**Depends on:** none

`frontend/app/cockpit/cockpit-actions.test.ts`:
- `createWorktree`'s resolved value is set both in the top-level `afterEach` and in `describe("launchAgent")`'s
  `beforeEach`. Keep one: set it once before each test, in the place the file's other mock defaults are reset.
- In "adds a booting row for an agent, after the rows already pending, and foregrounds it", the `Date.now` spy is
  restored after the awaited `launchAgent` call. If the call throws, the spy leaks into later tests. Restore it in a
  `finally` (or with `vi.restoreAllMocks` in the file's teardown, if that fits the file's style better).

Run the file whole with `npx vitest run frontend/app/cockpit/cockpit-actions.test.ts`, then run
`node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`; both must pass.
