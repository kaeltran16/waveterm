# Orchestrator guide gaps: the clear-bug batch

Effort `5d11f853-41e2-44d4-8aa4-bf92cee88dca` ("Orchestrator guide — gaps and rough edges (2026-09-18)"). This
batch fixes the 19 chunks that are clear bugs. The other 12 chunks are out of scope, and a later run designs
them. Every claim below was checked against the code on `orch-gaps` at `c10edc67`. Where the effort's note
turned out wrong, this spec says so.

## Decisions

- **#4:** a conflicted merge holds every other merge until it is continued. The alternative was to search
  history for the resolver's commit afterward.
- **#5:** sealed evidence records one Verify entry per landed lane, carrying its last result. A timed-out
  Verify whose re-run passed reads as passed.
- **#17:** every orchestrator lead is named after its run, not only plan-run leads.
- **#1 keys:** the 1–9/Enter answer bindings follow the agent whose question card is shown. The cause
  claimed for them was wrong (see #1), so this fix needs a live check.
- **#12:** the DAG node's `escalate` button opens the same route picker as the detail panel's `escalate…`.
- **#15:** `answeragent` errors when nothing is pending. Every caller was checked, and none depends on the
  silent success: `DagAnswerCommand` confirms a pending ask before calling, and the frontend's `submitAnswer`
  ignores the result (`fireAndForget` logs a rejection).

## Fixes

### #1: liveWorkers ignores DAG child runs

Verified: `liveWorkers` (`runmodel.ts`) walks only `run.phases`. An engine run's workers are DAG child
runs, and its lead is idle between wakes, so the count `CancelRunButton` passes to `confirmCancelRun` is 0
mid-run and the confirm never opens.

The effort's claim about the keys is **wrong**: a goal run's lead *is* recorded in the orchestrate phase's
`workerorefs` (`spawnRunWorkersWithPrompt`), so a planning run does have phases. The difference that fits
the symptom: the question card (`RunSheetFrame`, `runsheet.tsx`) reads the live `run:` object
(`runAtom`), while the 1–9/Enter bindings (`BriefSheet`, `briefsheet.tsx`) read the channel list's
snapshot (`stageRunAtom` over `activeChannelRunsAtom`), which a `run:` update never refreshes. This cause is
unconfirmed.

The effort's "lead row reads 0 workers" claim is also wrong about the cause: the Agent tree counts workers
through lineage (`agenttreemodel.ts`), not `liveWorkers`. Its causes are #2 and #9.

Fix:
- A new `runLiveWorkers(run, agents, lineage)` in `runmodel.ts` returns every live worker a cancel stops: the
  run's phase workers, plus the roster agents whose lineage role is a worker under this run
  (`role.kind === "worker" && role.leadRunId === run.id`), excluding idle ones, deduped. `CancelRunButton`
  uses it. `liveWorkers` and `cancelSurvivors` stay phase-only, because the per-worker Stop
  (`StopRunWorkerCommand`) accepts only workers the run owns (`jarvis.RunOwnsWorker`).
- A new `leadAsker(run, agents)` returns the asking phase worker. A DAG worker's question goes through the
  child-ask card and the lead, never the run's own ask card.
- The ask bindings (`buildChannelsAskBindings`) move from `BriefSheet` into `RunSheetFrame`. There they
  target the same `leadAsker` the card renders, read from the live run.

Tests: `runmodel.test.ts` gets an engine run with an idle lead and two working DAG workers (count 2) and an
asking DAG worker that `leadAsker` ignores. Live check: pressing 1 answers a lead's question on the Brief.

### #2: Engine-dispatched workers missing from the Agent tree

Verified: `jarvis.SpawnRunWorker` creates the tab with `wcore.CreateTab`, which only queues the workspace
update on a ctx that collects updates. `spawnRunWorkersWithPrompt` collects and broadcasts; the engine's
`spawnWorker` (`engine.go`) does neither.

Fix: `SpawnRunWorker` owns its tab's visibility, beside the initial `agent:status` it already publishes.
When the caller's ctx collects no updates (`waveobj.ContextGetUpdates(ctx) == nil`), it collects its own and
broadcasts them on return, including after a failure part-way. A caller that already collects keeps
flushing its own. Tests stub the tab creation and the broadcast.

### #3: Starting a run can throw TypeError reading null id

Verified: `CreateRunCommand` ends `out, _ := wstore.GetRun(...)` and can return `{run: null}`, and
`openChannelSheet(oid, run.id)` throws on it.

Fix: `CreateRunCommand` sends the channel update (the run exists), then returns the read error wrapped with
the run id. `createRun` (`runactions.ts`) throws a clear error if the RPC ever returns no run. The launcher
already prints a thrown error. The underlying read failure (possibly the "transaction has already been
committed" seen under load) is not diagnosed here.

### #4: Landed-commit credit after a resolved conflict can name another lane

Verified: once the lead commits a conflict fix, `IndexClean` passes, `AutoMergeReady` lands another lane,
and `--continue` then finds nothing to commit and credits `HEAD` (`finishMerge`, `resolved`), which is the
other lane's squash commit.

Fix (`mergetask.go`): a task in `blocked-merge` with no `MergeError` is a conflict awaiting `dag merge
--continue`, and it holds the project. While one exists, a merge of any other lane (automatic or explicit)
is refused as `errProjectBusy` naming that task. `--continue` then credits the resolver's commit. A refused
merge (`MergeError` set) holds nothing.

### #5: Sealed evidence says verification none recorded after Verify passed

Verified: `SealEvidence` (`pkg/jarvis/evidence.go`) reads verifications only from worker transcripts. The
engine's Verify results exist only as `task-verify-passed` / `task-verify-failed` run events.

Fix: when the sealed run owns a DAG (`run.DagORef` set and the dag's `RunID` is this run) with a Verify, the
seal reads those events (`wstore.QueryRunEventsByKind`) and adds one entry per task, carrying the newest
result: `Cmd` is the dag's Verify, `Result` is pass or fail, and `Detail` names the task. The entries are
in dag order and come after the transcript entries. A dag or event read error fails the seal, so the
backfill retries rather than freezing an incomplete snapshot. Child runs are sealed before their Verify
runs and are unchanged.

### #6: Brief sheet cannot send a typed answer to a lead's question

Verified: `AnswerBar`'s "or type your own answer…" input has no send path; only an option click calls
`onSubmit`. A focused input also turns off the Enter binding (`ctx.editable`), so this is broken on every
surface.

Fix: Enter in the input (not Shift+Enter, not mid-IME-composition) submits once every question is answered,
and otherwise moves to the next unanswered question. That is the same rule the option click uses, extracted
as a pure `nextUnansweredQuestion` in `agentsviewmodel.ts`. `answerHint` says "press Enter to send" once
text is typed.

### #7: Closed lead tab stays in the app as a frozen working row

Verified: `deleteLeadTab` (`leadclose.go`) calls `wcore.DeleteTab` on a ctx that collects nothing and
broadcasts nothing.

Fix: the default `deleteLeadTab` collects the updates and broadcasts them after `DeleteTab`, including when
it fails part-way.

### #8: Verify has no task row or output once the lane worker is reaped

Verified: `liveTaskRow` (`runsheetmodel.ts`) shows "running Verify" only while the worker session is live.
The worker is reaped before Verify, so the row reads "no session · … session closed, work continues".

Fix: a `verifying` task whose worker is not dispatched reads meta "running Verify", state `verifying`, and
opens the DAG task. Streaming Verify output is out of scope.

### #9: App reload empties the Agent tree of running workers

Verified: status atoms (`session-models/agentstatusstore.ts`) fill only from new `agent:status` events.
wavesrv keeps each block's last state event (`Persist: 1`, per-scope), readable with
`EventReadHistoryCommand`, but nothing reads it on load.

Fix: once `setupAgentStatusSubscription` has run, the first time a block's status atom is created, its
retained event is requested once. A pure `seedAgentStatus(current, retained)` applies it only when no live
event has arrived meanwhile and it carries a state. A failed read is logged with the block oref.

### #10: parallelism-wait shown when slots are free

Verified: `buildNext` (`digest.go`) returns `parallelism-wait` whenever any task is busy and nothing can
dispatch, even with free slots.

Fix: `parallelism-wait` requires the busy count to reach `g.Parallelism`. With free slots, pending tasks
with unsatisfied deps report `dependency-wait`. `TestNextParallelismWaitBeatsDependency` encodes the bug and
is changed.

### #11: Lead-held question mislabelled on the task row

Verified: the digest's `waitreason` is `lead-ask` for a lead-held question; `liveTaskRow` matches only
`ask`. Fix: `lead-ask` reads "asked the lead".

### #12: DAG node escalate button fails silently

Verified: the node's `escalate` sends a `DagActionCommand` with no model, which the server rejects, and
`runAction`/`runEscalate` drop the rejection (`void`).

Fix: the node's `escalate` selects the node and opens the detail panel's route picker. Every DAG action's
rejection shows as an error line in the detail panel until the next action.

### #13: Blocked merge reads as a failure on the Brief

Verified: `BuildAttention`'s `blocked` case (`pkg/jarvis/attention.go`) always prints "`N` consecutive
failures — decide retry/skip". A dag is also blocked by `blocked-merge` and `verify-failed` tasks.

Fix: the Waiting-on-you row names the cause, in the order the digest ranks them. A conflicted merge is
blocked and needs resolving, then `dag merge <task> --continue`. A refused merge gives the first line of
its `mergeerror`. A failed Verify is named as such. Only failures keep the retry/skip text. The
failed-Verify case is included because it had the same wrong text.

### #14: DAG view shows workers the lead's route

Verified: `buildViewData` (`dagstore.ts`) derives a task's route from the owner run's runtime/model. The
engine's `effectiveTaskRoute` uses task runspec, then the **dag's** `workerroute`, then the owner.

Fix: the view mirrors `effectiveTaskRoute` exactly (the dag's `workerroute`, which a submit copies from the
run's). A worker-route task reads "run worker route".

### #15: answeragent succeeds when nothing was answered

Verified: `DeliverAnswer` returns `false, nil` when no ask is pending. Fix: it returns an error wrapping a
new `agentask.ErrNoPendingAsk`, naming the oref. `AnswerAgentCommand` already propagates errors.

### #16: + Run project list squashes rows when projects overflow

Verified: the rows are flex children of a `max-h-[150px] flex-col` scroller with no `shrink-0`, so they
shrink instead of overflowing. Fix: rows don't shrink. This is CSS only, so it has no unit test and needs a
live check.

### #17: Plan run's first lead is named after its first wake

Verified: a lead's label is the tab's custom label, else the agent's ai-title. Claude Code derives the
ai-title from the first prompt, which for a plan run is the first wake.

Fix: `EnsureWorkers` gives an orchestrator run's lead tab `session:label`, set to the run's title (first
line of its goal, which is the plan title for a plan run). Every surface then names the lead after the run
(decision #17).

### #18: Delete the orphaned frontend deleteChannel wrapper

Verified: `deleteChannel` in `channelsstore.ts` has no caller. The `deletechannel` RPC is the teardown in
`scripts/cdp/scenarios.mjs`, `cdp-e2e-runs-piece4.mjs` and `cdp-profile-verify.mjs`. Fix: delete only the
wrapper.

### #19: TestQuickReorderQueue_RollingTimeout flakes under load

Verified: the test spaces items 10ms apart under a 50ms timeout. When load stretches the gaps past 50ms, the
queue correctly flushes a buffered item early, so the flake comes from the test's timing, not the queue.

Fix (test only): widen the timeout well past any scheduler stall, keep the same seven items and the same
order assertion, and let `collectItems`' deadline replace the fixed trailing sleep.

## Out of scope

The 12 chunks the goal lists as out of scope. Streaming Verify output (#8). The cause of the `GetRun` read
failure (#3).

## Docs

A final task, after every code task, updates `docs/orchestrator-guide.md`. It removes each "Rough edges" bullet
(or the sentences of one) whose chunk is done, corrects the `deleteChannel` line, and removes the
`TestQuickReorderQueue` flake bullet if its chunk is done, since that bullet would otherwise be false.

## Needs a live check

#1 (1–9/Enter reach a lead's question on the Brief; Cancel opens its confirm mid-run), #2 (an engine worker
appears in the Agent tree without a reload), #7 (a completed lead's row leaves the app), #9 (a reload keeps
running workers' rows), #16 (a long project list scrolls), #17 (a new lead's row reads the run's title).
