# Reliability improvement scan

**Date:** 2026-08-25  
**Status:** Triaged reliability backlog; no implementation approved.  
**Source:** Read-only repository scan plus reconciliation with `docs/open-issues.md` and the
2026-08-24 Jarvis/orchestrator scan. The strongest new findings were independently re-read in the
current source. No failure-injection tests or live reproductions were run.

This brief ranks the most valuable reliability work by concrete consequence and smallest credible fix.
Existing orchestrator findings are linked rather than re-derived; new findings carry their evidence here.

## Ranked shortlist

| Rank | Finding | Status | Effort | Source |
|---|---|---|---|---|
| R1 | Per-task DAG merge targets the lead branch, so isolated child work cannot land | Actionable blocker | M | 2026-08-24 scan O1 |
| R2 | Config watcher callbacks can race and apply updates out of order; initialization failure permanently poisons the singleton | Actionable | M | New; details below |
| R3 | DAG safety invariants: stalled tasks free slots, retry clears the global failure streak, gate actions target every gate, and one panic kills the watchdog | Actionable batch | S–M | 2026-08-24 scan O2/O3/O5/O6 |
| R4 | Websocket RPC forwarding can block forever after the writer exits | Actionable | S | New; details below |
| R5 | Consult cancellation can abandon `Cmd.Wait` when descendants retain stderr | Reproduce first | M | New; details below |
| M1 | DAG liveness repeats a complete Pi-session corpus scan per active task | Measure first | S measurement; M fix | New; details below |

## Recommended sequence

1. **R1 first.** It blocks the orchestrator's worktree-isolation delivery path.
2. **R3 second.** Four small deterministic fixes restore concurrency, circuit-break, gate-targeting, and
   watchdog invariants before more DAG capability lands.
3. **R2 third.** It removes a process-global race and turns an obscure delayed crash into explicit startup
   behavior.
4. **R4 fourth.** It is a narrow lifecycle fix with a direct cancellation-aware send.
5. Run the R5 failure-injection probe and M1 timing instrumentation; build either only if its trigger is
   observed.

## R1 — Per-task DAG merge targets the wrong branch

**Status:** Actionable blocker · **Effort:** M · **Confidence:** Verified in the 2026-08-24 scan.

The engine creates child worktrees and branches from the composite owner/task key, while `dag merge`
uses the lead run id. The lead owns no child branch, and the blocked-merge path also looks up the wrong
identity. Child commits produced through worktree isolation therefore have no working merge path.

**Evidence and fix direction:** `docs/superpowers/briefs/2026-08-24-jarvis-orchestrator-improvement-scan.md`
O1. Make merge task-targeted and derive the exact persisted child worktree key/branch rather than
reconstructing it from the lead run.

**Validation:** create a DAG child, commit in its worktree, merge that task, assert the expected diff lands
on the owner branch, then verify successful cleanup and the conflict/blocked path.

## R2 — Config watcher delivery and initialization are unsafe

**Status:** Actionable · **Effort:** M · **Confidence:** High from source inspection.

### R2a — callbacks race and can arrive out of order

`Watcher.notifyHandlers` starts one goroutine per handler per update
(`pkg/wconfig/filewatcher.go`, `notifyHandlers`). There is no ordering, version check, queue, or fan-out
bound. Two filesystem events A then B can therefore run handler B before A. A real handler closes over and
mutates `currentTelemetryEnabled` from these callbacks (`cmd/server/main-server.go`,
`setupTelemetryConfigHandler`), so rapid updates also produce a Go data race.

**Smallest direction:** give the watcher one ordered callback-dispatch queue. Copy the handler slice while
holding the mutex, invoke callbacks outside that mutex, and preserve update order without blocking the
fsnotify event loop.

**Validation:** register a handler that blocks update A, deliver update B, release A, and assert A→B under
`go test -race`. Include queue shutdown behavior if the dispatcher owns a goroutine.

### R2b — first initialization failure poisons the singleton

`GetWatcher` uses `sync.Once`. If `fsnotify.NewWatcher()` fails, the callback returns without assigning
`instance`, but the once guard prevents every later retry. Startup tolerates the nil result, while many
runtime callers use `wconfig.GetWatcher().GetFullConfig()` without a nil check. A transient resource error
can therefore become a delayed process panic far from the cause.

**Smallest direction:** either return an initialization error and fail startup clearly, or replace the once
guard with retryable mutex-protected construction. Fail-fast startup is the simpler contract because the
process already treats the watcher as mandatory after boot.

**Validation:** inject watcher creation failure and assert either the original error terminates startup or
a later call can initialize successfully. No nil watcher should escape as successful initialization.

## R3 — DAG scheduler safety invariant batch

**Status:** Actionable · **Effort:** S–M total · **Confidence:** Verified in the 2026-08-24 scan.

Four independent small defects belong in one scheduler-safety pass:

- count `Stalled` workers against parallelism because stall detection does not stop the child;
- do not clear the DAG-wide consecutive-failure streak in `RetryTask`;
- target gate approve/sendback at the requested task and error when it is not a completed gate;
- recover around each watchdog tick rather than around the whole loop.

**Evidence and exact seams:** `docs/superpowers/briefs/2026-08-24-jarvis-orchestrator-improvement-scan.md`
O2, O3, O5, and O6.

**Validation:** deterministic scheduler tests for each invariant, plus a watchdog test where one tick panics
and the next tick still executes.

## R4 — Websocket RPC forwarding can leak after disconnect

**Status:** Actionable · **Effort:** S · **Confidence:** High from source inspection.

`HandleWsInternal` starts an untracked goroutine that ranges `wproxy.ToRemoteCh` and sends to the bounded
`outputCh` (`pkg/web/ws.go`). `WriteLoop` stops consuming that channel after a socket failure or shutdown.
If producers fill the buffer, the forwarding goroutine blocks on `outputCh <- rpcWSMsg` and cannot observe
`ToRemoteCh` closing when the handler returns. Repeated loaded disconnects can retain goroutines and their
channel/proxy graph.

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
