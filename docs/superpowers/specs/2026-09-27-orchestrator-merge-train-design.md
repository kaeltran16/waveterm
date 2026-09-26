# Orchestrator merge train, sharded Go tests, and what was dropped

Finishes the speed work finding 27 deferred (`docs/orchestrator-findings-2026-09-25.md`, findings 23 and 27,
the Handoff and "Fixes after the handoff"). Already shipped and not repeated here: the scoped per-merge Verify
(`ARC_VERIFY_CHANGED`, `scripts/verify.mjs`), dependencies satisfied at merge, and the `waitingOn` merge order.

The goal named three items and asked each to earn its place. After measuring:

| Item | Verdict |
|---|---|
| 1. Merge train with bisect | Build it (section 2) |
| 2. Automatic retry of a Verify that fails outside what the task touched | Dropped (section 4.1) |
| 3a. Targeted worker checks | Dropped (section 4.2) |
| 3b. Incremental tsc | Dropped (section 4.3) |
| 3c. Measure CPU contention between workers | Done (section 1) |
| New: shard the slow Go test packages in `verify.mjs`, and fix the two order-dependent watchdog tests sharding exposes | Build it (section 3), added with the human's approval |

## Decisions (human, 2026-09-27)

- Shard the Go tests in `scripts/verify.mjs` and fix the order-dependent watchdog tests in this run.
- The spec review below carries the rest.

## 1. Measurements

Measured 2026-09-26 23:15 to 2026-09-27 00:05 on the dev machine: 10 cores, 16 logical, 32 GB, Go build cache
warm, `CGO_ENABLED=1 CC="zig cc -target x86_64-windows-gnu"`. Run 5952d714 was running up to three workers at
the same time, so the "alone" numbers are close to idle but not idle (CPU load read 1% to 52% between runs).

### Per-merge Verify, scoped

| Merge shape | Time | What ran |
|---|---|---|
| One Go file in `pkg/orchestrate` (`verify.mjs` on a real edit) | 175 s | `go test` of `pkg/orchestrate` (111 s), `wshserver` (21 s), `cmd/server`, `cmd/wsh/cmd`, `pkg/web`, plus about 50 s to compile and link them |
| 8d03e12c's paths (Go in `pkg/orchestrate` plus 16 frontend files) | 221 s | the same Go set, tsc, `vitest related` (11 s); includes a one-off CGO rebuild |
| Run 5952d714's first three live merges | 259 s, 226 s, 203 s | overlapped the benchmarks below, so upper bounds |

The handoff deferred the train as "worth less once Verify is about a minute." For this repo's orchestrator
work it is 3 to 4.5 minutes, not one: a change to `pkg/orchestrate` reaches `wshserver`, `cmd/wsh/cmd`,
`cmd/server` and `pkg/web`, and a `wshrpc` type change reaches about 38 packages. Run 5952d714 queued two
reviewed lanes behind one Verify in its first 20 minutes: t-1 waited 10.5 min to merge and t-2 12.6 min, and t-4,
which depends on them, was spawned when t-2 merged.

### Where the Verify time goes

- `pkg/orchestrate`: 545 top-level tests, none `t.Parallel`, 99 s summed. 15 tests take 1 s or more (32 s
  together); the rest is a long tail of 0.1 to 1 s tests that spawn git. CPU load while it runs alone is low:
  the time is spent waiting on child processes, not computing.
- Split into processes by test name (`-test.run`, round robin), from one prebuilt test binary:

  | Shards | Wall time |
  |---|---|
  | 1 | 100 to 111 s |
  | 2 | 67 s |
  | 3 | 43 s |
  | 4 | 37 to 52 s |
  | 6 | 33 s |

- Other large packages alone: `wshserver` 20 s (198 tests), `gitinfo` 32 s (104), `jarvis` 12 s (320),
  `cmd/wsh/cmd` 2.6 s (133), `reporadar` 6 s (96). Test count predicts time only roughly.

### CPU contention between parallel workers (item 3c)

| Command | Alone | 3 at once | 5 at once |
|---|---|---|---|
| tsc `--noEmit` | 17.5 s | 19.6 s (1.12x) | 23.4 s (1.34x) |
| `go test ./pkg/orchestrate/`, build cached | 101 s | 116 s (1.15x) | 140 s (1.39x) |
| The scoped Go set above, each copy in its own tree with its own edit (compile, link, test) | 112 s | | 214 to 260 s (2.3x) |

In the last row the tests themselves slowed 1.5x (105 s to 157 s) and compile plus link went from about 10 s to
about 100 s, with CPU at 100% while the five linked. So contention is real for Go builds and small for tsc and
for the tests themselves. Finding 27 logged about 2 min per tsc run in run 18d08579; tsc alone here takes 17.5 s
and 23 s five at once, so that figure is mostly what ran beside it or the tool-call timing caveat the finding
names, not tsc.

### Flakes (item 2)

- The `wshserver` flake finding 27 wanted a retry for (`TestLeadCompletingItsPlanRunRecordsTheProjectHead`,
  TempDir cleanup under load) was fixed in `a2c2ca6e`. The lead's own reproduction, six `-test.cpu=1` runs at
  once, passed 12 of 12 twice over.
- `pkg/orchestrate` passed 8 of 8 runs three and five at once, and the scoped Go set 5 of 5 at once in separate trees.
- The one order-dependent pair left, `TestWatchdogTickDetectsStallInBlockedDag` and
  `...InAwaitingReviewDag` (finding 23), failed in 5 of 5 sharded runs, in whichever shard they landed, and never
  in the full ordered run. Cause: `watchdogTick` ticks every dag in the shared test store, and
  `silentSiblingDag`'s `spawnWorker` stub counts spawns for dags that other tests left behind.

### Tsc incremental (item 3b)

| Run | Time |
|---|---|
| Full `--noEmit` | 17.3 to 17.8 s |
| `--incremental`, cold | 17.6 s |
| `--incremental`, nothing changed | 4.0 s |
| `--incremental`, one leaf file gains an export | 18.5 s |
| `--incremental`, a core store file gains an export | 17.7 s |
| `--incremental`, comment-only edit in one file | 17.0 s |

### Worker build and test time now (item 3a)

Run 5952d714's workers, from their transcripts: build and test commands took 0 to 1.4 min of sessions of 4 to 9
min. They filtered with `-run` (`go test ./pkg/orchestrate/ -run 'TestWakeLeads|...'`, `-run JarvisCtx`), and the
plan's Check (tsc, `go vet`, a wsh cross-build) took 38 s. In run 18d08579 the share was 59%, because that plan's
tasks named whole package trees.

## 2. Merge train with bisect

### Behavior

When the merge queue opens (no Verify running or failed, no conflict waiting for `--continue`), the engine
merges every ready lane, in the order `autoMergeable` already gives (most waited-on first, then plan order),
each as its own squash commit, and runs one Verify for all of them. If it passes, every lane in the batch is
done. If it fails and the batch has more than one lane, the engine bisects: it runs Verify on prefixes of the
batch in a separate tree until it knows the first lane whose merge fails. The lanes before it are done. That
lane is verify-failed and wakes the lead, as a failed Verify does today. The lanes after it stay merged and
verifying, and the Verify that follows the lead's fix and `dag merge <task> --continue` judges them with it.

Merge first, then verify, as today. Dependents keep starting at their dependency's merge (shipped in "Fixes after
the handoff"). A train that verified before merging would push every dependent's start back by a Verify.

### Rules

1. **A Verify judges its batch.** The batch is every lane tip in `verifying`. Its order is the order of their
   squash commits (`EndCommit` on each tip's child run) on the landing branch, read with
   `git merge-base --is-ancestor`. Verify is scoped from the oldest tip's `EndCommit^` to `HEAD`
   (`changedFilesEnv`), so it covers the whole batch and anything committed on top of it. For a batch of one this
   is what `verifyScopeEnv` does today.
2. **Merging a batch.** `AutoMergeReady` checks, in this order: a `verify-failed` task holds everything; a
   conflict waiting for `--continue` holds everything; a `verifying` task with no project claim resumes that
   batch's Verify; otherwise it takes the claim once and merges the ready lanes one by one. The first lane that does
   not merge ends the batch:
   - a conflict marks that lane `blocked-merge` as today, and no Verify starts: the tree is mid-merge. The
     lanes merged before it stay `verifying` until the lead resolves the conflict and continues, and that
     Verify's batch includes them.
   - a dirty index stops the batch there, and the hold is noted as today (`noteMergesHeld`).
   - any other refusal (git declining, a lane whose dependency is verifying, possibly one merged earlier in this
     batch) skips that lane and goes on, as today's loop does. A lane refused on every tick then can't stall the
     others for its whole retry budget.
   - The lanes merged so far get their Verify.
   - If nothing merged, the claim is released.

   The `verifying`/`verify-failed` guard in `mergeTaskLocked` (`requireCleanIndex`) is checked once, before
   the first merge of a batch, not against the batch's own tips.
3. **Pass.** Every tip in the batch goes `done`, its lane's chunks close (`closeLandedChunks`), and each gets a
   `task-verify-passed` event with the batch's `ms`, plus `batch` (the tip ids in order) when there is more than one.
4. **Fail, and the batch can be bisected.** It can be bisected when it has two or more tips and `HEAD` is the newest tip's
   `EndCommit`. Prefix *i* is the tree at the *i*-th tip's `EndCommit`. Prefix 0, the commit before the batch,
   passed its own Verify; prefix *n* (all of it) just failed. Binary search: `lo = 0, hi = n`; while
   `hi - lo > 1`, verify prefix `mid = (lo + hi) / 2`, scoped from the oldest tip's `EndCommit^` to that commit;
   a pass sets `lo = mid`, a failure sets `hi = mid` and keeps that run's output. The first failing lane is tip
   `hi`, found in `ceil(log2 n)` extra Verify runs. Then:
   - tips 1 to `hi - 1` go `done`, as a pass, with `bisect: true` on their event;
   - tip `hi` goes `verify-failed` with the output of the smallest failing prefix, a `task-verify-failed` event
     carrying `batch` and `bisect` (the number of extra runs), and the wake. The wake's reason says it was found by
     bisecting, and names the batch (`exit 1; bisected from t-1, t-4, t-6`), through the existing
     `verifyFailedWake(taskID, reason)`;
   - tips after `hi` stay `verifying`, with their output set to one line naming the failed task
     ("held: task t-4's Verify failed; verified with its fix"), which is what the digest's `VerifyLastLine` shows.
5. **Fail, and it can't be bisected.** A batch of one, or a `HEAD` past the newest tip, which is how a lead's fix
   commit sits after `--continue`. The oldest tip goes `verify-failed`, and the tips after it stay verifying as above.
   With a batch of one this is today's behavior. After a `--continue`, the oldest tip is the one continued. A prefix
   bisect there would test trees without the fix and blame that lane again, whatever broke.
6. **A bisect step that cannot run** (the tree cannot be created, Setup fails, or the command could not start) ends the
   bisect. The oldest lane not yet known good, tip `lo + 1`, goes `verify-failed` with the batch's output. The
   reason names the step that could not run. Later tips stay verifying. That is the rule 5 outcome, reached
   later, so a broken bisect never passes a lane it did not verify.
7. **Where the bisect runs.** In one detached worktree beside the landing tree
   (`worktreeDir(project, runID+"-bisect")`), created at the first prefix, set up once with the plan's Setup,
   moved between prefixes with `git checkout --detach <sha>`, and removed at the end. Never in the landing tree,
   which in `--landing checkout` is the human's checkout. `runBaseCheck` (`basecheck.go`) already creates,
   sets up and removes a detached tree: that part moves into one helper both use.
8. **Cancel and restart.** The bisect runs inside the Verify goroutine, under the same project claim, so no merge
   lands mid-bisect. `stopDagVerify` cancels its context, and the loop stops on `ctx.Err()`. A server restart
   loses the claim. `AutoMergeReady` then resumes the batch's Verify at `HEAD`, and a failure bisects from the
   start. Bisect progress is not persisted.
9. **Progress.** The running Verify's output tail (`recordVerifyProgressLocked`) is written to every tip in the
   batch. During a bisect the engine writes a line before each step
   (`verify: bisecting: testing t-1, t-4 at <short sha>`), so `VerifyLastLine` says what is running.

`dag merge <task>` by hand stays one lane. The Verify after it judges every `verifying` tip (rule 1), so a lane
merged by hand while other tips wait on a conflict is judged with them. `--continue` on a `verify-failed` task
(`rerunVerify`) sets it `verifying` and starts that batch's Verify. On a `blocked-merge` task, it commits the
resolution and starts the Verify for every `verifying` tip. The command surface and the lead's instructions do not change.

### Code

- `pkg/orchestrate/verify.go`: the `landing` claim carries the batch (tip ids). The Verify runner takes a batch:
  ordering, scope, run, and on failure the bisect. `recordVerifyLocked` records a batch outcome: the passed
  tips, the failed tip with its output and reason, and the held tips. `resumeVerify` resumes the batch.
- `pkg/orchestrate/mergetask.go`: `AutoMergeReady` gets rule 2's checks in order and a batch merge under one
  claim. `landAfterMerge` and `continueBlockedMerge` start the batch's Verify. `mergeTaskLocked`'s guard is
  checked once per batch.
- `pkg/orchestrate/basecheck.go`: the detached-tree create, Setup and remove move into a helper beside
  `runBaseCheck`, which uses it unchanged.
- No new task state, run-event kind, wshrpc type or generated file. The events gain `batch` and `bisect` data
  keys. The digest's `verify-wait` step already lists every verifying task. `docs/orchestrator-guide.md` says
  how merges batch and bisect.

Out of the way of run 5952d714: no change to `engine.go`, `wake.go`, `liveness.go`, `digest.go`, `review.go`
or `scheduler.go`.

### Tests

Engine tests with the existing `mergeWorktree` and `runPlanCommand` seams, and a real git repo where ordering
and the bisect tree need one:

- two ready lanes merge in one claim and one Verify, scoped to both squash commits; a pass marks both done and
  closes both lanes' chunks;
- a failing batch of three whose second lane breaks: two bisect steps (prefix 1 passes, prefix 2 fails): tip 1
  done, tip 2 verify-failed with prefix 2's output and a bisect reason, tip 3 verifying and held, one wake;
- a failing batch whose last lane breaks: the others done, the last verify-failed;
- a batch of one fails as today, with no bisect step;
- `--continue` after a fix commit: one Verify for the failed tip and the held ones; a failure blames the continued
  tip with no bisect; a pass marks all done;
- a conflict on the second lane: the first stays verifying with no Verify started, `AutoMergeReady` does not
  resume it, and continuing the conflict starts one Verify for both;
- a bisect step whose Setup fails: the oldest lane not known good goes verify-failed, the rest held, nothing passed
  unverified;
- a cancelled dag stops the bisect, and nothing is recorded;
- resume after a lost claim reruns the batch's Verify.

## 3. Sharded Go tests in `verify.mjs`, and the watchdog tests they expose

### Behavior

`scripts/verify.mjs` runs the Go packages it chose (scoped at a merge, all of the patterns unscoped) in two groups:

- **Sharded:** a package with at least `SHARD_MIN_TESTS = 100` top-level tests, counted from its `_test.go`
  sources (`func Test...` at the start of a line), is built once with `go test -c`. Its test names come from the
  binary's `-test.list`, minus benchmarks. They are dealt round robin into `SHARDS = 4` groups, and each group runs as the
  binary with `-test.run '^(A|B|...)$'` and `-test.timeout=10m`, `go test`'s own default, in the package's directory,
  as `go test` runs it. The groups run at the same time; packages are sharded one after another, so no more than four
  test processes run at once. At the current tree that is `pkg/orchestrate`, `pkg/jarvis`, `pkg/wshrpc/wshserver`,
  `cmd/wsh/cmd` and `pkg/gitinfo`.
- **The rest:** one `go test` over the other packages, as today, keeping Go's test cache for them.

Why these numbers: 4 shards took `pkg/orchestrate` from about 100 s to 37 to 52 s, and 6 gained only a few more
seconds (section 1). The threshold is a proxy. A package below 100 tests runs here in seconds, except
`reporadar` (96 tests, 6 s). Above it, `pkg/gitinfo` (104, 32 s) gains the most and `cmd/wsh/cmd` (133, 2.6 s)
the least. Each shard runs the package's `TestMain` again, a store migration of well under a second.

The build uses the same environment the plain `go test` gets. Run 5952d714 is adding `goTestEnv` (cgo on with zig
on Windows) to this file. If it has landed when this run is submitted, this run's branch takes it first (section 5)
and the build uses it. Output: each shard's output is printed. The package summary line follows `go test`'s format
(`ok  <pkg>  <s>s`, or `FAIL <pkg> <s>s` after the failing shard's output), so the engine's failure excerpt
(`firstFailureExcerpt`) finds `--- FAIL` as it does now. A failing shard does not stop the others, and the script exits
nonzero once all have finished if any failed, as `go test` does.

Expected saving: about 60 s on every per-merge Verify that reaches `pkg/orchestrate` (175 s to about 115 s idle,
estimated from the shard timings, not measured end to end). The final stage's unscoped Verify gains the same.
Workers do not run `verify.mjs`, so their checks are unchanged.

### The order-dependent watchdog tests

`silentSiblingDag` (`pkg/orchestrate/watchdogscope_test.go`) counts only the spawns for its own dag: its
`spawnWorker` stub counts a call only when `cwd` is under that test's project path. A dag another test left in
the store is still ticked, and never counted. The assertion stays what it was meant to be: observing this parked
dag spawns nothing.

### Tests

`scripts/verify.test.mjs`: counting top-level tests from source text (a `TestMain`, a `Test` helper with a
lower-case suffix, and methods do not count); dealing names into shards (order kept, no shard empty when there are
fewer names than shards, the anchored `-test.run` pattern); partitioning packages by the threshold; the summary
line for a pass and a failure. `go test ./pkg/orchestrate/ -run 'TestWatchdogTick'` in each of 4 shards passes,
and so does the full sharded run of `pkg/orchestrate`.

## 4. Dropped

### 4.1 Automatic Verify retry (item 2)

The flake it was for is fixed (`a2c2ca6e`), and nothing flaked in 25 runs three to six at once (section 1). The only
recorded failure in a package the task did not touch, t-8's in run 18d08579, was a real regression. A retry
would have spent another 3 to 4 min Verify before waking the lead. A retry also hides a new flake that should be fixed. And
"touched" would need Go package knowledge in the language-agnostic engine, or a new exit-code contract with the
Verify script. Revisit if a flake shows up again in the kept `--- FAIL` output (finding 25), and fix that test first.

### 4.2 Targeted worker checks (item 3a)

Workers already target. The worker brief says to run the tests the task names plus Check, and not the full
Verify (`workerContract`, since `59073139`). The current run's workers filter with `-run` and spend 0 to 1.4
min on builds and tests (section 1). Finding 27's 59% came from a plan whose tasks named whole package trees:
that is a plan-writing issue, and the plan reviewer sees it. Contention (2.3x for five Go builds at once) is real, but
it is compile and link time. A worker needs that time whatever it filters.

### 4.3 Incremental tsc (item 3b)

It saves time only on a tree with no changes (4 s against 17.5 s). Any edit, even a comment, costs the full run
(section 1), and a worker typechecks after editing. tsc also contends little (1.34x five at once).

## 5. Coordination with run 5952d714

Run 5952d714 changes `scripts/verify.mjs` and `verify.test.mjs` (`goTestEnv`), and appends to the findings doc and
`orchestrator-guide.md`. Before `dag submit`, the lead brings `main` into this run's branch if 5952d714 has landed.
If it hasn't, the plan goes ahead on this base, and the land-back keeps `goTestEnv` and uses it for the shard build.
This run does not touch the engine files 5952d714 changed (section 2).

## 6. Recording

The findings doc gets a "Fixes: merge train and Go test shards" table in the style of the earlier fix sections:
the train, the sharding, the watchdog test fix, and the three dropped items with their reasons, and the
Handoff's "Still deferred" sentence points to it. The measurements stay in this spec, and the findings doc links here.
