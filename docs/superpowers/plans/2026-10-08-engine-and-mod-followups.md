# Engine and Claude mod follow-ups implementation plan

**Effort:** effort:a40b6c01-2688-4cff-900e-69187b4f098f
**Verify:** `node scripts/verify.mjs ./pkg/orchestrate`
**Check:** `go vet ./pkg/orchestrate/`
**Final:** `node scripts/cdp/final-verify.mjs surface-smoke`

## Goal and shape

Three small follow-ups left open on other initiatives, run as one plan. They touch separate files and none
depends on another, so all three run at the same time.

No task changes a rendered view, a visual state or an interaction. The Final line runs `surface-smoke` as a
regression check of the merged app, not as the proof of any task.

## Global constraints

- Touch only the files a task names. No refactors or reformatting beside the change.
- Match the surrounding code's naming, comment density and test style. Comments say why, never what.
- Each task names its focused tests. Do not run a whole package or the full suite: Verify does that.
- Never run prettier on `scripts/*.mjs`: those files are hand-formatted with 4 spaces.
- `cmd/wsh/cmd/claude-mod/` is a generated copy of `claude/arc-mod/`. Edit `claude/arc-mod/` and refresh the
  copy with `task sync:claudemod`; never edit the copy by hand.

### Task 1: A final tree that cannot be removed does not stop the next final round

**Depends on:** none

**Files:** `pkg/orchestrate/final.go`, `pkg/orchestrate/verifier.go`, `pkg/orchestrate/final_test.go`

Source: initiative b1fe5d7e chunk 10. In run b89b9a80 (landing in the checkout), final round 2 could not
start. The round-1 verifier session outlived its stage with its working directory inside
`.waveterm/worktrees/<run>-final`. On Windows that holds the directory, so `finalTree` failed at "removing a
stale final tree" with "being used by another process", and the run finished unverified.

This path is only the checkout-landed one: `finalTree` in `pkg/orchestrate/final.go` returns the landing tree
when `owner.LandPath` is set, and makes the detached `<run>-final` worktree otherwise.

Required behavior:

- When the stale `<run>-final` tree exists and cannot be removed, `finalTree` does not return an error for
  that reason. It makes the round's detached tree in another directory under the same worktrees root and the
  stage runs there.
- The tree left behind is still cleaned up: hand it to the existing retrying removal (`removeFinalTree` in
  `pkg/orchestrate/verifier.go`, bounded by `finalTreeRemoveAttempts` and `finalTreeRemoveInterval`) rather
  than adding a second retry loop.
- A stale tree that can be removed keeps today's behavior: it is removed and the same directory is reused.
- The returned `cleanup` removes the directory the stage actually used.
- A branch-landed dag is unchanged.

Tests, added as subtests of `TestFinalTree` in `pkg/orchestrate/final_test.go`:

- a stale final tree that cannot be removed: `finalTree` succeeds, returns a different directory that is a
  detached worktree at the checkout's HEAD, and `cleanup` removes that directory;
- a stale final tree that can be removed: the same directory is reused.

Make the removal failure reproducible on every platform through a package-level seam in the style the
package already uses (`finalTreeRemoveInterval` is a `var` for this reason), not by holding a file open.

Run: `go test ./pkg/orchestrate -run '^TestFinalTree$'`

### Task 2: The Claude mod's ask wait ends when the turn is interrupted

**Depends on:** none

**Files:** `claude/arc-mod/hooks/register.ts`, `claude/arc-mod/hooks/ask-core.ts`, `claude/arc-mod/hooks/ask-core.test.ts`, `claude/arc-mod/.claude-plugin/plugin.json`, `cmd/wsh/cmd/claude-mod/`

Source: initiative 99832658 chunks 15 and 16.

In `claude/arc-mod/hooks/register.ts`, the ask hook spawns `wsh ask --wait` and awaits
`Promise.race([fromPicker, fromCard])`. It reads `next.signal.aborted` only after that race settles, so an
interrupt ends the wait only if Claude Code kills the child process. Nothing in the hook ends it.

Required behavior:

- An abort of `next.signal` settles the wait with no reply, whether or not the child has exited. The code
  after the race then runs as it does today for "no answer came back": the card is cleared and the hook
  returns `{ deny: "Interrupted by the user." }`.
- On abort the spawned `wsh ask --wait` stream is ended, the same way the picker path ends it
  (`wait.return(...)`), so no wait is left running.
- A signal that is already aborted when the hook reaches the wait settles at once.
- The picker path and the card path behave as before when there is no abort.

Put the part that can be tested without the Claude Code runtime in `ask-core.ts` as a pure helper (for
example, a promise that resolves to no reply when an `AbortSignal` aborts, including one aborted before the
call), and test it in `ask-core.test.ts` beside the existing tests. `register.ts` only wires it.

Also add an `author` field to `claude/arc-mod/.claude-plugin/plugin.json`, so `claude plugin validate
claude/arc-mod` no longer warns that it has none. Use `{ "name": "Arc" }`.

Then run `task sync:claudemod` and commit the refreshed `cmd/wsh/cmd/claude-mod/` with the change.

Run: `npx vitest run claude/arc-mod/hooks/ask-core.test.ts` and `claude plugin validate claude/arc-mod`

### Task 3: The mod load check reports a failed stub build as could not verify

**Depends on:** none

**Files:** `scripts/claude-mod-load-check.mjs`

Source: initiative 99832658 chunk 16.

`scripts/claude-mod-load-check.mjs` documents its exits as 0 pass, 1 fail, 3 could not verify, with the
reason as the last stdout line. `buildStub` runs `go build` with `execFileSync`, which throws when the build
fails. The throw escapes `main`, so the script dies with exit 1 and a stack trace, which reads as "the mod is
broken" when the truth is that the check could not run.

Required behavior:

- A stub build that fails makes the script exit 3 (`EXIT_UNVERIFIED`), and its last stdout line is
  `could not verify: ` followed by the reason, as the other could-not-verify paths in `main` print it.
- The build's stderr tail is printed before that line, as the `claude -p` failure path prints its stderr.
- The temp dir is still removed.
- A passing build is unchanged.

There is no test file for this script. Prove the change by making the build fail on purpose and reading the
exit code: run the script with a `PATH` whose `go` is a stub that answers `go version` and fails `go build`,
confirm exit 3 and the last line, and say in your report what you ran and what it printed. Do not add a test
framework or fixture for it.

Run: `node scripts/claude-mod-load-check.mjs; echo "exit=$?"`
