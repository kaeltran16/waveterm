# Orchestrator actionable smalls: stage leaks, ending a stuck final stage, the verifier's brief, finding 49's second route

Four rows of `docs/open-issues.md` section 2, re-verified against HEAD `7d7bf612` on 2026-09-28. Each row
holds the evidence; this spec records only the design.

A second orchestrator run is changing the worker brief (`engine.go`), the lead rules
(`pkg/jarvis/leadprompt.go`, `PlanFormat`), `takeLeadTold`, and the success output of state-changing wsh
commands. None of the work below touches those, apart from the one output line item 2's new command prints.

## 1. Background stages outlive the test that started them

**Row:** "`pkg/orchestrate` tests flake because background engine stages outlive the test that started them",
fix (1). Fix (2) is done (`rerunAlone` in `scripts/verify.mjs`); fix (3) belongs to the other run.

**Design.** A package-level tracker of running background stages, in a new `pkg/orchestrate/stages.go`:

```go
// goStage runs fn on its own goroutine as a named background stage. Tests wait for every stage before they
// restore the hooks a stage calls, so no stage lands in the next test's fakes.
func goStage(name string, fn func())
```

It is the WaitGroup the row asks for, kept as a mutex-guarded count of running stages by name
(`map[string]int`) rather than a bare `sync.WaitGroup`: a wait that times out can then say which stages are
still running, and a test's wait never races a stage's `Add` from zero, which `sync.WaitGroup` forbids. The name is
`"<kind> <dagID>"`, for example `"final dag-1"` or `"verify dag-1"`.

These four goroutines become `goStage` calls, and nothing else about them changes:

| Site | Name |
|---|---|
| `final.go:154` `startFinalCommands` | `final <dag>` |
| `verify.go:297` `startVerify` | `verify <dag>` |
| `basecheck.go:68` `startBaseCheck` | `basecheck <dag>` |
| `verifier.go:187` `releaseFinalTree`'s retry | `final-tree <dag>` |

The `*Finished` test hooks (`finalFinished`, `verifyFinished`, `baseCheckFinished`) keep their place. They
signal a result and cannot tell whether a goroutine has exited.

**Test side** (`maintest_test.go`):

- `waitStages(t)` waits until no stage is running, up to `stageLeakTimeout` (10 s, the timeout
  `awaitVerify` already uses). On timeout it fails the test with `t.Errorf("background stages outlived the
  test: final dag-1, verify dag-1")`. It does not hang.
- `restoreAfterStages(t, restore func())` registers `t.Cleanup(func() { waitStages(t); restore() })`. Every
  shared fixture that swaps a hook a stage calls restores it through this helper, so whichever of its
  cleanups runs first waits for the stages: `newFakeLead` (`sendWakeFn`, `appendRunEvent` and the rest),
  `awaitVerify` (`verifyFinished`), `stubPlanCommandProgress` (`runPlanCommand`, which also covers
  `stubPlanCommand` and `stubPlanCommandOutput`), and the final-stage and base-check waiters in
  `final_test.go` and `basecheck_test.go`. A `stubLaunch`-style swap that no stage calls stays as it is.

**Measure first**, as the row asks. Add the tracker and the waits, run `go test ./pkg/orchestrate/ -count=1`
once, and record in the task's report the number of tests that fail on a leak and their names. Then fix
each leak in its test, not in the tracker: the test waits for the stage it started (as `8b88821e` did for
the mid-batch conflict test) or releases what it blocked (`blockingVerify.open`). A test that deliberately
leaves a stage blocked cancels it before cleanup, for example by cancelling the dag. The package passes with
no leak reported. A `finalTreeRemoveInterval` retry in a test shortens the interval, as `land_test.go`
already does for `landTreeRetryEvery`.

If the measurement shows another engine goroutine landing in a later test's hooks (`land.go:150`
`retryLandTreeRemoval` is the only other candidate: `wake.go`'s launch is stubbed in `init`, and `typeWake`
calls `sendBlockInput`), it joins through `goStage` too. The task report names any goroutine added this way.

**Cost.** A test that starts no stage waits zero time. A test that starts one waits until it finishes, which
takes milliseconds with stubbed commands.

## 2. A human ends a stuck final stage

**Row:** "A human cannot end a stuck final stage".

**Decisions (the human's, 2026-09-28):**

- A human can end any running state: `checking`, `final` or `verifying`. A hung Check, Verify or Final
  command (bounded only by its 30-minute timeout) is as stuck as a verifier with dead tools.
- There are two outcomes, **unverified** and **failed**, each with a required reason. Failed is the same as a
  verifier's fail: the reason becomes the stage's Detail, and the lead gets the usual failed-final wake (a
  fix round, or the last-round wake on round `MaxFinalRounds`). A human who wants no fix round cancels the
  run.
- The run sheet exposes it as a dock button that opens an inline reason field.

### Engine: `EndFinalStage`

In `pkg/orchestrate/final.go`:

```go
// EndFinalStage ends a running final stage on the human's word: unverified or failed, with reason recorded.
func EndFinalStage(ctx context.Context, dagID, outcome, reason string) error
```

- `outcome` is `FinalState_Unverified` or `FinalState_Failed`; anything else is refused.
- The reason is trimmed. An empty reason is refused ("ending the final stage needs the human's reason"), and
  so is one longer than `MaxReviewNoteLen`, as a verdict's text is.
- The call is refused, and names the stage's state, when the dag is cancelled, when `g.Final` is nil, or when
  the state is empty or terminal.
- Under `withDagMutation`:
  - `checking` or `final`: afterCommit runs `stopDagFinal(dagID)`, which cancels the running commands. When
    the command goroutine comes back, `recordFinalLocked` finds a terminal state and records nothing. Its
    `keepTree` is false, so it removes a tree it made.
  - `verifying` with a `VerifierRunID`: `stopReviewer` cancels the verifier's run and stops its worker.
    `VerifierRunID` is kept, because the run's usage totals count the verifier through it
    (`TestChildRunIDsIncludesTheVerifier`). A verdict the verifier sends later is refused by
    `RecordFinalVerdict`'s existing state check.
  - Unverified appends `"ended by the human: " + reason` to `f.Unverified`. Failed sets `f.Detail` to the
    same text.
  - Then it finishes the stage the way `RecordFinalVerdict` does: `finishFinal`, `releaseFinalTree`,
    `RecomputeDagStatus`, `UpdateDag` and `SendWaveObjUpdate`. That tail moves into one helper that both
    callers use, so the two paths cannot drift.
  - Unverified also posts `PostQuiet(… "the human ended the final stage unverified: <reason>")`, the
    counterpart of the verifier-pass post. A failed stage's wake is already posted by `finishFinal`.

The reason lands where every final outcome already lands: the dag's `Final` (`Detail` or `Unverified`),
which `wsh jarvis dag status`, `wsh runs show` (`finalLines`), the run report and the cockpit already read.
No new field and no new run-event kind.

### RPC

`DagActionCommand` gets two actions, `final-end-unverified` and `final-end-failed`, with `Notes` carrying the
reason. `RunId` is the orchestrator run's own id; the handler already resolves any run to its `DagORef`, so
the caller never needs the verifier's run id. As with `final-pass`, the handler calls `EndFinalStage` and then
runs `Schedule` on a goroutine. Update the `Action` and `Notes` comments in `wshrpctypes_dag.go`. The generated types carry no comments, so
nothing needs regenerating.

This path never calls `reportRunPhase`, which is the step that marked the caller's own tab complete in
`wsh jarvis dag final`.

### `wsh runs end-final`

```
wsh runs end-final <run-id> unverified|failed "<reason>"
```

- It takes the same `--project` and `--channel` flags as the other `wsh runs` commands, and resolves the run
  with `runsFind`.
- On success it prints one line: `ended run <id>'s final stage: <outcome>`.
- Its RPC timeout is `runsCancelTimeoutMs`, because stopping the verifier's worker waits on it, as a cancel
  does.
- A run with no dag, or no running final stage, gets the server's refusal as its error.
- The `Long` help says when to use it: the stage is stuck, and waiting out the verifier's 20-minute budget or
  the command's timeout is not worth it.

### Run sheet

- `frontend/app/view/jarvis/runsheetmodel.ts` gets a pure `finalStageEndable(group: TaskGroup | null):
  boolean`. It is true when `group.final?.state` is `checking`, `final` or `verifying` and the group is not
  cancelled. `runsheetmodel.test.ts` tests it.
- In `Dock` (`runsheet.tsx`), while `finalStageEndable(group)` is true, an **End final stage** button sits
  beside Open DAG, styled `DOCK_BTN`. It opens an inline form in the dock: a reason `textarea` and three
  buttons, **Pass unverified**, **Fail** (error-toned) and **Keep running**. The two outcome buttons are
  disabled until the reason is non-blank, and while the call runs. An error goes to the dock's existing
  `result` line.
- The call is an `endFinalStage(channelId, runId, outcome, reason)` helper in
  `frontend/app/view/agents/runactions.ts`, which calls `RpcApi.DagActionCommand` with `runid: run.id` and a named timeout constant, `END_FINAL_TIMEOUT_MS` (60 s, matching `runsCancelTimeoutMs`).
- The form uses existing `@theme` tokens and Tailwind only (`DESIGN.md`); there are no new tokens.

### Docs

`docs/orchestrator-guide.md`, "The final stage": one paragraph on ending a stuck stage from the run sheet or
with `wsh runs end-final`, including that failed means a fix round.

## 3. The final verifier's brief

**Rows:** "The final verifier re-runs the test suites the engine's final stage has just passed on the same
commit", and the verifier half of "Workers run whole-package test suites that per-merge Verify and the final
stage already run". The worker-brief half of the second row is the other run's.

**Design.** `verifierPrompt` (`verifier.go`) adds these lines, after the diff line:

- When the stage ran any of Check, Verify or Final, one line names each command that ran and the commit
  (`f.Commit`, short form): "Before you started, the engine ran Check `<cmd>`, Verify `<cmd>` and Final
  `<cmd>` on `<commit>`, and they passed, apart from anything listed below as not verified. Do not run them
  again." Only the commands the plan has are listed. A stage that ran none of them, because the plan has
  none, gets no line.
- Always, whatever the plan has: "Do not run any whole package or test suite. Read the diff. To settle a
  specific doubt about behavior, run one named test with `-run '^TestName$'` (or its vitest equivalent)."
- "You have `<ReviewTimeout>` from your start to give a verdict. A session that gives none is stopped and
  replaced once, and then the result is left unverified." The duration is formatted from `ReviewTimeout`
  and `MaxReviewRespawns`, never hardcoded.

`verifier_test.go` asserts each line's presence, the named commands and commit, and that a plan with no
commands gets no "ran" line but still gets the whole-suite line. The existing prompt tests keep passing.

## 4. Finding 49's "second route" is log noise, not a lost outcome

**Row:** "Finding 49 has a second route, and the findings doc names only the first".

**Re-derived 2026-09-28** (the plan review caught the first version of this section): nothing is lost on
that route.

- `PostOutcome` (`pkg/jarvis/outcome.go:76-79`) posts a channel outcome only for a worker a channel dispatched
  with a `dispatch` message. Engine workers have none, so they never get a channel outcome, reaped or not.
  The engine hears their exits through `ChildOutcomeHook` instead.
- At t-2's and t-3's merges in run `6c7652be`, the reaped worker belonged to a task that had just merged, so
  `HandleChildOutcome` would do nothing even if it resolved the owner: the task is no longer `taskActive`.
- `OnWorkerExit` logs "no dispatch channel for worker …; outcome not posted" only when
  `resolveDispatchChannelForWorker` returns nil. Its fallback scans every channel for a dispatch message,
  so nil means no channel dispatched the worker, which is exactly when there is nothing to post. The only
  exception is a failed `GetChannels`, which it swallows today. The line is noise, and it cost this
  investigation.

**Change (the human's choice, 2026-09-28):**

- `pkg/jarvis/onexit.go`: remove the "outcome not posted" log line; a nil channel returns quietly.
  `resolveDispatchChannelForWorker` (`outcome.go`) logs a `GetChannels` failure itself
  (`jarvis: listing channels to resolve worker <oref>: <err>`) instead of swallowing it, so a real failure
  is still visible.
- `pkg/jarvis/onexit_test.go`, two tests. In both, `RunWorkerExitHook` deletes the worker's tab, as a
  merge's concurrent reap can after `OnWorkerExit` has read the tab and before it resolves the channel. It
  must be that hook: `OnWorkerExit` resolves the dispatch channel before `ChildOutcomeHook` runs, so a tab
  deleted there never reaches the nil-channel path, while `RunWorkerExitHook` runs inside that window:
  - `TestAReapedEngineWorkersExitPostsNothingAndLogsNothing`: the tab carries the owner meta (written with
    `wstore.StampWorkerOwner`) and the channel has no dispatch message. No outcome message is posted, and
    the log has no `jarvis onexit` line.
  - `TestADispatchedWorkersOutcomeSurvivesTheReap`: `seedDispatchedWorker`, with the hook deleting the tab.
    The outcome is posted to the dispatching channel.
- `docs/orchestrator-findings-2026-09-25.md`, row 49: the detail row gains one sentence. The "outcome not
  posted" lines of run `6c7652be` (t-2, t-3) were not a second route: engine workers never get a channel
  outcome, and those tasks had merged. The log line was removed. The row's test list gains the two tests.
  The summary row is unchanged.

## Closing the rows

After the work lands, each of the five rows in `docs/open-issues.md` is struck through and marked
`**fixed \`<commit>\`**` in the file's own style, with a one-line note of what shipped:

- the stage-leak row: fix (1) only. It notes that (3) is the other run's.
- the stuck-final-stage row.
- the verifier re-run row.
- the "Workers run whole-package test suites" row: marked for its verifier half only, because its worker
  half is the other run's. The row is not struck through.
- the finding 49 row: struck, marked fixed, and noting that the premise was wrong (the lines were log noise), with what shipped.

## Out of scope

- The worker brief, lead rules, `PlanFormat`, `takeLeadTold`: the other run's.
- Surfacing `flaky:` lines in the run report (row 175, fix (2)'s leftover).
- `TestSchedulePersistsSpawnedWorkerOwnership`'s `-count>1` failure (row 175: not a leak).
- A Final command for this run. The UI change is a dock form whose logic is a unit-tested model; booting the
  dev app for `surface-smoke` would add up to 10 minutes of wall-clock for little signal.
