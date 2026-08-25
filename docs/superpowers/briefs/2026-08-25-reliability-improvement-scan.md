# Reliability improvement scan

**Date:** 2026-08-25  
**Status:** Historical scan; R1–R4 resolved.
**Source:** Read-only repository scan plus reconciliation with `docs/open-issues.md` and the
2026-08-24 Jarvis/orchestrator scan. The strongest new findings were independently re-read in the
current source. No failure-injection tests or live reproductions were run during the scan.

**Update:** R1 and R3 shipped in `b9aad7fd`. R2 was resolved by the config-watcher reliability change
that added ordered callback dispatch and explicit startup initialization. R4 was resolved by making
websocket RPC forwarding observe connection cancellation while waiting for output capacity. The original
evidence remains below for rationale; it no longer describes the current R1–R4 implementation.

This brief ranks the most valuable reliability work by concrete consequence and smallest credible fix.
Existing orchestrator findings are linked rather than re-derived; new findings carry their evidence here.

## Ranked shortlist

| Rank | Finding | Status | Effort | Source |
|---|---|---|---|---|
| R1 | Per-task DAG merge targeted the lead branch, so isolated child work could not land | Shipped (`b9aad7fd`) | M | 2026-08-24 scan O1 |
| R2 | Config watcher callbacks could race and apply updates out of order; initialization failure poisoned the singleton | Resolved (config-watcher reliability change) | M | New; details below |
| R3 | DAG safety invariants: stalled tasks freed slots, retry cleared the global failure streak, gate actions targeted every gate, and one panic killed the watchdog | Shipped (`b9aad7fd`) | S–M | 2026-08-24 scan O2/O3/O5/O6 |
| R4 | Websocket RPC forwarding could block forever after the writer exited | Resolved (websocket forwarding change) | S | New; details below |
| R5 | Consult cancellation can abandon `Cmd.Wait` when descendants retain stderr | Reproduce first | M | New; details below |
| M1 | DAG liveness repeats a complete Pi-session corpus scan per active task | Measure first | S measurement; M fix | New; details below |

## Recommended sequence

1. Run the R5 failure-injection probe and M1 timing instrumentation; build either only if its trigger is
   observed.

## R1 — Per-task DAG merge targets the wrong branch

**Status:** Shipped in `b9aad7fd` · **Effort:** M · **Confidence:** Verified in the 2026-08-24 scan.

Before the fix, the engine created child worktrees and branches from the composite owner/task key, while
`dag merge` used the lead run id. The lead owned no child branch, and the blocked-merge path also looked
up the wrong identity. Child commits produced through worktree isolation therefore had no working merge
path.

**Evidence and fix direction:** `docs/superpowers/briefs/2026-08-24-jarvis-orchestrator-improvement-scan.md`
O1. Make merge task-targeted and derive the exact persisted child worktree key/branch rather than
reconstructing it from the lead run.

**Validation:** create a DAG child, commit in its worktree, merge that task, assert the expected diff lands
on the owner branch, then verify successful cleanup and the conflict/blocked path.

## R2 — Config watcher delivery and initialization were unsafe

**Status:** Resolved by the config-watcher reliability change · **Effort:** M · **Confidence:** High
from source inspection and focused race tests.

### R2a — callbacks raced and could arrive out of order

Before the fix, `Watcher.notifyHandlers` started one goroutine per handler per update
(`pkg/wconfig/filewatcher.go`, `notifyHandlers`). There was no ordering, version check, queue, or fan-out
bound. Two filesystem events A then B could therefore run handler B before A. A real handler closed over
and mutated `currentTelemetryEnabled` from these callbacks (`cmd/server/main-server.go`,
`setupTelemetryConfigHandler`), so rapid updates also produce a Go data race.

**Smallest direction:** give the watcher one ordered callback-dispatch queue. Copy the handler slice while
holding the mutex, invoke callbacks outside that mutex, and preserve update order without blocking the
fsnotify event loop.

**Validation:** register a handler that blocks update A, deliver update B, release A, and assert A→B under
`go test -race`. Include queue shutdown behavior if the dispatcher owns a goroutine.

### R2b — first initialization failure poisoned the singleton

Before the fix, `GetWatcher` used `sync.Once`. If `fsnotify.NewWatcher()` failed, the callback returned
without assigning `instance`, but the once guard prevented every later retry. Startup tolerated the nil
result, while many runtime callers used `wconfig.GetWatcher().GetFullConfig()` without a nil check. A
transient resource error could therefore become a delayed process panic far from the cause.

**Smallest direction:** either return an initialization error and fail startup clearly, or replace the once
guard with retryable mutex-protected construction. Fail-fast startup is the simpler contract because the
process already treats the watcher as mandatory after boot.

**Validation:** inject watcher creation failure and assert either the original error terminates startup or
a later call can initialize successfully. No nil watcher should escape as successful initialization.

## R3 — DAG scheduler safety invariant batch

**Status:** Shipped in `b9aad7fd` · **Effort:** S–M total · **Confidence:** Verified in the 2026-08-24 scan.

The shipped scheduler-safety pass fixed four independent defects:

- count `Stalled` workers against parallelism because stall detection does not stop the child;
- do not clear the DAG-wide consecutive-failure streak in `RetryTask`;
- target gate approve/sendback at the requested task and error when it is not a completed gate;
- recover around each watchdog tick rather than around the whole loop.

**Evidence and exact seams:** `docs/superpowers/briefs/2026-08-24-jarvis-orchestrator-improvement-scan.md`
O2, O3, O5, and O6.

**Validation:** deterministic scheduler tests for each invariant, plus a watchdog test where one tick panics
and the next tick still executes.

## R4 — Websocket RPC forwarding could leak after disconnect

**Status:** Resolved by the websocket forwarding change · **Effort:** S · **Confidence:** High from source
inspection and focused cancellation tests.

Before the fix, `HandleWsInternal` started an untracked goroutine that ranged `wproxy.ToRemoteCh` and sent
to the bounded `outputCh` (`pkg/web/ws.go`). `WriteLoop` stopped consuming that channel after a socket
failure or shutdown. If producers filled the buffer, the forwarding goroutine blocked on
`outputCh <- rpcWSMsg` and could not observe `ToRemoteCh` closing when the handler returned. Repeated
loaded disconnects could retain goroutines and their channel/proxy graph.

**Smallest direction:** make the forwarding send cancellation-aware:

```go
select {
case outputCh <- rpcWSMsg:
case <-closeCh:
    return
}
```

Do not add it to the existing wait group without changing shutdown order; the current deferred close of
`ToRemoteCh` happens after that wait.

**Validation:** extract the forwarding loop, saturate `outputCh`, close `closeCh`, and assert prompt exit.
Also cover the normal forwarding path.

## R5 — Consult cancellation may abandon process resources

**Status:** Held for reproduction · **Effort:** M · **Confidence:** High on the failure path, medium on the
cross-platform fix.

`waitCmd` starts `cmd.Wait()` in a goroutine and returns immediately when the context is cancelled
(`pkg/consult/exec.go`). This intentionally bounds caller latency when a descendant inherits stderr and
holds the pipe open, but it abandons that wait goroutine and associated process/pipe resources. Repeated
timeouts against such runtimes can accumulate them.

**Trigger to make actionable:** reproduce with a helper process whose descendant retains stderr after the
parent is killed, and demonstrate that the reaper remains blocked on Windows.

**Candidate directions after reproduction:** kill the complete process tree and wait synchronously, or send
stderr to an owned capped file so `os/exec` has no copy goroutine waiting for descendant-held EOF. Choose
only after the Windows behavior is measured.

## M1 — Liveness repeats task × transcript-corpus filesystem work

**Status:** Measure first · **Effort:** S measurement, M fix · **Confidence:** High on repeated work, medium
on material impact.

Every watchdog tick schedules every running DAG. During scheduling, each active task independently calls
`lastActivityForRun`. That function enumerates the complete Pi session root, opens candidate headers, and
scans up to 200 opening lines for the task marker (`pkg/orchestrate/liveness.go`). Cost therefore grows with
`active tasks × accumulated session files` every tick.

**Trigger to make actionable:** instrument one tick with active DAG/task count, session files visited, files
and bytes opened, and elapsed liveness time. Exercise realistic and synthetic corpus sizes.

**Smallest direction if material:** build one immutable liveness snapshot per `Schedule` call and index the
newest mtime by cwd plus DAG/task marker. That changes the local work from roughly
`O(tasks × session files)` to `O(session files + tasks)` without introducing a persistent cache.

## Exclusions and limits

- Frontend keyboard/accessibility findings from the same scan are valid but excluded by the chosen
  reliability-first scope.
- Existing channel data-model scaling and Jarvis briefing read amplification remain tracked elsewhere and
  are not duplicated here.
- No tests were run. “Actionable” means the source path and acceptance seam are concrete, not that the bug
  has been reproduced live.
