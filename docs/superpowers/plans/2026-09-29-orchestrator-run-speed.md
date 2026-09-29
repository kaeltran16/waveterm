# Shorter orchestrator runs: overlap the final stage, start reviews on seal, and overlap Verify's packages

**Verify:** `CGO_ENABLED=1 CC="zig cc -target x86_64-windows-gnu" node scripts/verify.mjs ./pkg/orchestrate/... ./pkg/wshrpc/... ./cmd/wsh/...`
**Check:** `CGO_ENABLED=1 CC="zig cc -target x86_64-windows-gnu" go vet ./pkg/orchestrate/... ./pkg/wshrpc/... ./cmd/... && CGO_ENABLED=1 CC="zig cc -target x86_64-windows-gnu" go build ./cmd/...`

**Goal:** Cut the wall-clock time a run spends after its workers finish. Measured on the 2026-09-29 benchmark runs
(f9d2a919, 0dd28414) and the prod store's 15 dags: the Sonnet run spent 53% of its wall clock after the last worker
committed. Three independent sources of that time are fixed here. Each task states the outcome and how it is
proven, not the implementation: choosing the design is part of the task. Read the code each task names, its
callers and the shared helpers before designing.

## Global Constraints

- The three tasks run in parallel and must not edit the same files. Task 1 owns `pkg/orchestrate/final.go`,
  `pkg/orchestrate/verifier.go`, their tests and `docs/orchestrator-guide.md`. Task 2 owns
  `pkg/wshrpc/wshserver/wshserver_runs.go` and its tests. Task 3 owns `scripts/verify.mjs` and
  `scripts/verify.test.mjs`. Do not edit `docs/open-issues.md` or `docs/deferred.md`.
- No wire-type changes and no generated files. If a task truly needs one, edit the Go type, run `task generate`,
  and say why in the report.
- Run only the focused tests that prove your change: `go test ./pkg/x -run '<names>'`. Never a whole package or
  the full suite: Verify runs those at each merge, and `pkg/orchestrate` alone takes 1-3 minutes. Go tests touching
  sqlite need `CGO_ENABLED=1 CC="zig cc -target x86_64-windows-gnu"`.
- Do not pipe a test into `tail`, `head` or `grep` without `set -o pipefail`.
- `gofmt -l` and `npx prettier --check` only the files you touched; never `--write` the tree, and never run
  prettier on `scripts/*.mjs` (hand-formatted at 4 spaces; `.editorconfig` omits `.mjs`).
- Tests assert behavior, and each must fail if the behavior it names is removed.
- Commit messages: `type(scope): description`, with no attribution trailers.

### Task 1: The final stage's verifier runs alongside Check and Verify, not after them
**Depends on:** none

Today `runFinalSteps` (`pkg/orchestrate/final.go`) runs Check, then the unscoped Verify, then the Final command,
and only when all pass does `recordFinalLocked` start the verifier session. The verifier reads the diff and the
tree and is told not to rerun the commands (`verifierPrompt`, `verifier.go`); it does not use their output. In the
last five prod runs, Check plus Verify took 55-161 s (median 127 s) and the verifier 113-137 s once its no-suites
rule landed (`0c1e4523`), one after the other.

Outcome:

- When the plan has no Final command, the verifier session starts at the same time as Check and Verify, on the
  same merged tree, and the stage's time is about the longer of the two instead of their sum.
- The stage's outcome is unchanged in every case: a Check or Verify failure ends the stage failed with the same
  Detail as today, whatever the verifier said, and stops a verifier still running; a verdict that arrives before
  the commands finish waits for them; a command's unverified items (a flaky final Verify, a base-shared Check
  failure) still reach the stage's unverified list alongside the verifier's.
- With a Final command the order stays as today: the verifier reads the Final command's screenshots and reports,
  so it starts only after that command.
- The verifier's prompt stays true. It no longer claims the commands already passed when they are still running;
  it still tells the verifier not to run them.
- The tree is created once for the stage and released once, after both the commands and the verifier are done.
  Fix rounds, cancel (`EndFinalStage`, `stopDagFinal`) and a server restart mid-stage (`startFinalCommands` is
  re-asked every tick) keep working.
- `docs/orchestrator-guide.md` "The final stage" describes the new order.

Proven by tests for: the verifier starts before the commands finish when there is no Final command; a Check
failure and a Verify failure each end the stage failed and stop the verifier, ignoring its verdict; a pass verdict
that arrives first waits for the commands and the stage then passes; a final Verify's flaky report still makes the
stage unverified; a plan with a Final command still starts the verifier only after it; cancelling mid-stage stops
both.

### Task 2: A task's reviewer starts when its evidence is sealed, not on the next 30-second tick
**Depends on:** none

`advanceReviews` (`pkg/orchestrate/review.go:89`) waits for the worker run's sealed evidence before it spawns the
reviewer. The worker's outcome schedules the dag (`outcome.go`), but the evidence is sealed about a second later,
asynchronously, by `sealDoneRunEvidence` (`pkg/wshrpc/wshserver/wshserver_runs.go`), which schedules nothing. So
the reviewer starts on the next watchdog tick (`watchdogInterval`, 30 s): across 62 reviews in the prod store the
gap from the worker's completion to its reviewer was 1-32 s, median 16 s, on the critical path of every task.

Outcome:

- Once a dag worker's evidence is persisted, its dag is scheduled, so the reviewer spawns within a second or two
  of the seal instead of on the next tick.
- A run that is not a dag child schedules nothing new. A seal that fails or is deferred to the backfill behaves
  as today; the watchdog tick remains the fallback.
- Scheduling must not run under a lock the tick also takes, and must not block the seal path on a slow tick.

Proven by tests for: sealing a dag worker's evidence schedules its dag; sealing a run with no dag does not; and,
end to end in `pkg/orchestrate` terms if the seam allows it, a reviewing task whose worker's evidence was just
sealed gets its reviewer in that schedule rather than waiting for the tick.

### Task 3: A scoped Verify tests its large packages at the same time, not one after another
**Depends on:** none

`scripts/verify.mjs` splits each package with `SHARD_MIN_TESTS` or more top-level tests across `SHARDS` (4)
processes, but `goTest` runs the sharded packages one after another. A merge Verify on main for run 0dd28414's t-2
changed-path list (`engine.go`, `mutation.go`, `worktree.go`, `rewind.go`, `rewind_test.go` in `pkg/orchestrate`)
took 83 s on an idle machine: `cmd/wsh/cmd` 10 s, then `pkg/orchestrate` 56 s, then
`pkg/wshrpc/wshserver` 12.5 s, each built and run in turn. `pkg/orchestrate` split 4 ways or 8 ways both took about
57 s on this 12-core machine, so the packages have room to overlap; the machine does not have room for unbounded
processes, since a run's workers compete for the same cores.

Outcome:

- The sharded packages' builds and test processes overlap, with a bounded total number of test processes at once.
  Measure before and after with the same changed-path list: that merge Verify is clearly faster (report both
  timings, and the concurrency you chose and why).
- Everything the engine reads from Verify output is unchanged: each package's output stays together, followed by
  its `ok`/`FAIL` summary line; `--- FAIL` and `panic:` blocks are intact; a failed test that passes alone is
  still reported flaky through `ARC_VERIFY_FLAKY`; a failing package still fails the Verify, and one package's
  failure does not hide another's result.
- The plain (unsharded) packages keep running as they do today.

Proven by `scripts/verify.test.mjs` tests of the scheduling logic (bounded concurrency, each package's output
contiguous and summarized, a failure in one package still reported when another passes) and by the before/after
timing in the report.
