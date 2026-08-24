# Jarvis / Orchestrator — improvement scan findings

> 2026-08-24. Read-only scan of the orchestrator engine (`pkg/orchestrate`, lead-side `pkg/jarvis`,
> `wsh jarvis dag` CLI, DAG composer UI) and the Jarvis surface (`pkg/jarvis`, `pkg/jarvisattrib`,
> `jarvisstate`, briefing/volunteers/efforts flows). Produced by two fresh-context code scans; the
> top findings were then spot-verified by hand in the cited files. Sequencing is deliberately
> **not decided here** — this doc records problems only. Follow-ups: each fix batch gets its own
> spec/plan against these findings.

## Provenance and confidence

- Findings marked **verified** were re-read in source by the orchestrating session, not just reported.
- Unmarked findings are grounded in file:line citations from the scan but not independently re-read.
- Nothing here was reproduced in a live run; treat "why it matters" as reasoned, not measured.

## Orchestrator engine

### O1. `dag merge` targets the wrong branch — child work cannot land (blocker) · verified · M

The engine creates child worktrees keyed `<owner.ID>-<taskID>` (`pkg/orchestrate/engine.go:252-256`),
and `CreateRunWorktree` derives the branch as `wave/<owner.ID>-<taskID>` (`pkg/orchestrate/worktree.go`,
branch = `"wave/" + runID`). But `DagMergeCommand` merges `wave/<data.RunId>`
(`pkg/wshrpc/wshserver/wshserver_dag.go:235`) where RunId is the **lead** run id (from `dagIds()`,
`cmd/wsh/cmd/wshcmd-jarvisdag.go:158`; the composer's merge action uses `group.runid` too). The lead has
no worktree or branch, so the squash-merge fails; on the conflict path `MarkBlockedMerge(dagORef, leadRunId)`
then looks for a task whose RunID equals the lead id ("no task owns run"). Even passing a child task's
RunID would miss — the branch is keyed by the composite worktree key, not any Run row. There is no other
caller of `MergeRunWorktree`.

**Impact:** the worktree-isolation story dead-ends — children commit into worktrees nothing can land;
merge + blocked-merge are unreachable-by-design for real DAG runs.
**Direction:** per-task merge (`DagMergeData.TaskId` → derive the child's composite key), or have the
engine stamp each task's worktree key/branch onto the TaskNode at spawn.

### O2. Stalled tasks free their parallelism slot while still alive · verified · S

`NextToSpawn` counts only `TaskState_Running` (`pkg/orchestrate/scheduler.go:61`); stall flagging flips
Running→Stalled without stopping the child process (`engine.go:196-201`). Room grows and the engine
spawns more workers, so actual concurrency exceeds `Parallelism` exactly when things are going badly.
**Direction:** count Running+Stalled in `NextToSpawn`.

### O3. `RetryTask` resets the whole-DAG failure streak · verified · S

`RetryTask` sets `g.Failures = 0` (`scheduler.go:118`), bypassing the consecutive-failure circuit-break.
The routing roadmap states that break "is not bypassed by per-task retries"; N failing tasks plus one
retry lets it chase its tail instead of blocking for the lead.
**Direction:** do not reset in RetryTask; let a fresh success clear the streak (existing accounting).

### O4. Liveness matches pi sessions by cwd only — siblings mask stalls · M

`lastActivityForRun` compares session-header cwd to `workerCwd(run)` (`pkg/orchestrate/liveness.go`);
for non-git projects every child shares `owner.ProjectPath`, so any sibling's transcript writes refresh
every running task's LastActivity. A hung child looks alive — F3's watchdog regressed for non-git
projects via heartbeat aliasing.
**Direction:** match sessions by a per-run identity marker (injected env/id read back from the header).

### O5. Gate approve/sendback act on all gates at once, silently no-op · S

`ApproveGate`/`SendBackGate` loop over every `Gate && Done` task with no task targeting and no error when
none match; `mutation.go` passes taskID for approve/sendback but ignores it. One approval releases every
gate; a typo'd action returns success.
**Direction:** target the action at taskID, error when it isn't a done gate.

### O6. Watchdog goroutine dies permanently on first panic · S

`StartWatchdog` wraps the whole loop in one `defer recover()` inside the goroutine (`watchdog.go`); one
panicking tick ends the loop for the server's lifetime while stalled detection silently stops.
**Direction:** recover inside the per-tick call; log and continue.

### O7. Worktrees reused unverified, never reclaimed outside the broken merge path · M

If `.waveterm/worktrees/<owner>-<task>` exists it is reused on bare `os.Stat` (`engine.go:252-255`) —
possibly stale, dirty, or pinned to another base commit. Removal happens only in `finishMerge`
(unreachable per O1); cancel never touches worktrees.
**Impact:** retries can build on wrong-base state; the worktrees dir grows without bound.
**Direction:** verify reuse (branch exists, HEAD matches BaseCommit or clean) else recreate; sweep on
cancel/dag-done (`DumpRecoveryPatch` already covers the dirty case).

### O8. Lead-notification channel resolution ignores `g.ChannelId` · S

`runChannelID` iterates channels×runs per notification event (`control.go`) although the TaskGroup
already carries `ChannelId`. Pure waste on a hot path, plus a lookup that can disagree with the group.
**Direction:** use `g.ChannelId`; delete `runChannelID`.

## Jarvis surface

### J1. Failed Gatekeeper auto-answer delivery silently dropped (trust) · verified · S

In `handleAsk` (`pkg/jarvis/watcher.go:128-133`): classifier says "answer", but if `DeliverAnswer` errors
or returns `delivered == false` the function just returns — no answered card, no escalation, no log. The
ask vanishes from the Jarvis narrative while the terminal still shows the raw prompt. Violates the
fail-safe-to-escalate discipline everywhere else in the pipeline.
**Direction:** on delivery failure fall through to `postEscalation` ("answer delivery failed").

### J2. One briefing load double-reads every channel's full history · M

`FetchWorkState` loads all channels + all runs (`pkg/jarvisstate/fetch.go:80-92`), then `GatherAttention`
re-fetches both plus `GetChannelMessages(ch, 0, 0)` (unbounded) per channel to scan escalation cards
(`pkg/jarvis/attention.go:244-258`). Briefing load is already ~14s warm (comment in
`briefingstore.ts:56-58`) and grows with total channel history, not recent history.
**Direction:** pass already-loaded channels/runs into the attention builder (the split exists); window
message reads to recent N since only escalation-kind messages matter.

### J3. Improvement-map doc is stale about attribution correction; two dead exports · S

`DetachDossierEdge`/`AcceptDossierEdge`/`ListDetachedEdges` RPCs exist
(`wshserver_jarvis.go:665-700`) with a working UI consumer (`recordactions.ts:60-125`) — the 2026-08-12
improvement map's claim of "no RPC and no consumer" is outdated and would send the next planning cycle
to rebuild shipped work. Meanwhile `jarvisattrib.Backfill` and `.Harden` (`lifecycle.go:339,356`) have
zero non-test callers.
**Direction:** correct the meta doc; wire Backfill/Harden into a "re-scan this record" action or unexport.

### J4. Classifier timeline floods the cheap-tier prompt · S

`recentTimeline` caps message count (12) but not per-message length (`classify.go:88-99`) — one pasted
log enters every classification prompt verbatim, on the highest-frequency LLM call in the app.
**Direction:** truncate each timeline line (~200 chars).

### J5. `OnWorkerExit` swallows every failure path silently · S

DB failures, extract failure, and nil dispatch-channel all bare-`return` with no log
(`pkg/jarvis/onexit.go:32-58`; contrast `outcome.go:96` which logs post failures). A finished worker can
leave its channel permanently silent with no way to distinguish "produced nothing" from "hook broke".
**Direction:** log the abnormal branches (missing transcript stays silent — documented as normal).

### J6. Briefing cursor advances at load, before content is seen · verified · S–M

`loadBriefingAsync` sets the cursor to queryStartedAt as soon as the RPC returns
(`briefingstore.ts:86-105`), triggered on mount. A glance-and-close or mid-render crash marks the whole
delta seen — permanently suppressed from the next bring-up brief. Multi-window regression is handled;
dwell is not.
**Direction:** advance on dwell/explicit acknowledgment rather than load completion.

## Checked and healthy (no findings)

Orchestrator: plandag parse/validation (dup ids, cycles, route allowlist, fail-safe fallback),
decompose degradation to single dispatch, spawn adapter (runexec/runworker), DAG composer UI model/view
split (~2200 lines, tested). Jarvis: attention builder determinism/dedup, outcome double-post guard,
profile patch validation, volunteers trigger wiring + rate gate/idempotence, pet voice backlog policy,
effort card math, briefing store generation guards.

Also noted: roadmap Phase 2 items (same-tier retry policy wiring, `escalate` verb, Attempts tracking)
are not yet implemented anywhere in pkg/ — expected, recorded so nobody assumes otherwise.
