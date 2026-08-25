# Config watcher reliability design

**Date:** 2026-08-25
**Status:** Implemented; pending commit
**Source:** `docs/superpowers/briefs/2026-08-25-reliability-improvement-scan.md` R2

## Problem

The process-global config watcher has two independent reliability defects:

1. `notifyHandlers` launches one goroutine per handler per update. Updates can overtake each other, and the telemetry handler mutates captured state concurrently. Rapid config writes can therefore apply stale state after newer state and produce a Go data race.
2. `GetWatcher` uses `sync.Once` but discards `fsnotify.NewWatcher` errors. The first construction failure permanently leaves the singleton nil, while runtime callers assume it is non-nil. Startup can appear to continue and panic later at an unrelated call site.

The reliability tracker also still lists R1 and R3 as actionable even though commit `b9aad7fd` shipped both. This work reconciles those stale entries while implementing R2.

## Goals

- Deliver config updates to registered handlers in source order.
- Never invoke a config handler while holding the watcher's state mutex.
- Keep filesystem event processing independent of handler execution time.
- Isolate a handler panic so later handlers and updates still run.
- Surface watcher construction failure at server startup with the original error.
- Ensure `GetWatcher` never returns a successful nil value.
- Shut down dispatch without sending on a closed channel or retaining queued updates.

## Non-goals

- Retrying watcher initialization inside a running server process.
- Changing config parsing, filesystem event filtering, or broker event semantics.
- Delivering historical config updates to handlers registered after an update.
- Making arbitrary handler functions cancellable.
- Fixing websocket forwarding (R4) or held reliability findings.
- Broad worktree or orchestrator changes.

## Design

### Explicit initialization

Add `InitWatcher() (*Watcher, error)` in `pkg/wconfig/filewatcher.go`. It constructs the singleton once and retains both the pointer and the original construction error. The server calls this function during startup before registering handlers or starting dependent loops. A construction error is wrapped with startup context, logged, and causes `main` to return.

Keep `GetWatcher() *Watcher` for existing runtime callers. It delegates to `InitWatcher` and panics immediately with the initialization error if initialization failed. It never returns nil. This preserves the existing call-site shape while removing the poisoned nil state; the normal server boundary handles the error explicitly before runtime callers execute.

Watcher construction remains lazy for tests and non-server binaries that already use `GetWatcher` directly.

### Ordered callback dispatcher

Each `Watcher` owns one serial callback dispatcher. A dispatch record contains:

- the immutable `FullConfigType` value for one update;
- a copied snapshot of the handlers registered when that update was published.

The dispatcher uses a mutex-protected in-memory FIFO and one worker goroutine. Enqueue only appends a record and signals the worker, so the filesystem event loop never waits for a handler to finish and the queue is not constrained by an arbitrary channel capacity.

The worker removes one record at a time and invokes its handlers sequentially. Each invocation retains the existing panic recovery boundary. A panic is reported through `panichandler` and dispatch continues with the next handler.

### Watcher locking and data flow

For each initial or filesystem update:

1. Read the complete config.
2. Lock the watcher state mutex only long enough to replace `fullConfig` and copy the current handler slice.
3. Unlock the mutex.
4. Publish the existing `wps.Event_Config` event.
5. Enqueue the config value and handler snapshot.

The fsnotify loop processes events serially, and FIFO enqueue preserves that order through callback execution. `GetFullConfig` and `RegisterUpdateHandler` continue to use the watcher state mutex.

The initial config remains published before the server registers its two current handlers. Registration does not replay the initial value, preserving current behavior.

### Startup and shutdown

`startConfigWatcher` returns an error. It calls `wconfig.InitWatcher`, starts the watcher only on success, and lets `main` abort startup with the original cause when initialization fails.

Starting the watcher starts its dispatcher once before the initial config is published. Repeated `Start` calls do not create duplicate fsnotify or dispatcher goroutines.

`Close` performs these actions safely and idempotently:

1. stop accepting new callback dispatch records;
2. discard records still queued;
3. close the underlying fsnotify watcher;
4. allow a handler already executing to return, after which the dispatcher exits.

`Close` does not wait indefinitely for an arbitrary in-flight handler. No dispatch channel is closed, so concurrent enqueue cannot panic.

## Error handling

- `fsnotify.NewWatcher` failure: return the original error through `InitWatcher`; server startup logs context and exits.
- Watched-path registration failure: preserve current behavior—log the path-specific error and continue, because optional config subdirectories may not exist.
- Handler panic: report it and continue dispatch.
- Enqueue after close: reject the record without invoking callbacks.

## Testing

Add `pkg/wconfig/filewatcher_test.go` with behavior-focused tests:

1. **Ordered delivery:** block handling of update A, enqueue B, release A, and assert observations are A then B. The test must fail against the current goroutine-per-handler implementation and run cleanly under `go test -race`.
2. **Panic isolation:** register a panicking handler followed by an observing handler; assert the observer still receives the update and the dispatcher remains usable for a later update.
3. **Shutdown:** block an in-flight update, queue another, close dispatch, release the first, and assert the queued update is discarded and dispatch exits. Assert enqueue after close is rejected.
4. **Initialization failure:** inject a constructor that returns a sentinel error and assert construction returns a nil watcher plus that exact error; no nil-success state escapes.
5. **Startup boundary:** verify `startConfigWatcher` propagates initialization failure rather than continuing.

Run:

```bash
CGO_CFLAGS='-IC:/Users/kael02/IdeaProjects/waveterm/pkg/jarvisembed/csrc' go test -race ./pkg/wconfig -count=1
CGO_CFLAGS='-IC:/Users/kael02/IdeaProjects/waveterm/pkg/jarvisembed/csrc' go test ./cmd/server ./pkg/wconfig -count=1
```

## Documentation reconciliation

Update `docs/open-issues.md` and the 2026-08-25 reliability brief so they no longer recommend shipped R1/R3 work and remove R2 once this implementation is verified. R4 becomes the first remaining actionable reliability item. Preserve the historical finding details, but mark R1/R3 shipped with commit `b9aad7fd` and R2 shipped by this work rather than presenting them as current work.

## Acceptance criteria

- Handler observations preserve config update order under a deliberately blocked callback.
- `go test -race ./pkg/wconfig` reports no callback race.
- One handler panic does not stop later dispatch.
- Watcher construction failure reaches the server startup boundary with its original cause.
- `GetWatcher` cannot return nil after a failed initialization attempt.
- Closing the watcher drops queued callback work without a send-on-closed-channel panic.
- Existing config consumers retain their current `GetWatcher` call shape.
- R1, R2, and R3 are removed from the actionable backlog and recorded as shipped.
