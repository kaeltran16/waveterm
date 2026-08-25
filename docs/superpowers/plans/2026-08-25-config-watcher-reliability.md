# Config Watcher Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Serialize config watcher callbacks, surface watcher construction failure at startup, and reconcile the stale reliability backlog.

**Architecture:** `Watcher` owns one mutex/condition-variable FIFO and one callback worker. Filesystem updates snapshot registered handlers and enqueue without waiting for callbacks. A new error-returning singleton initializer is handled explicitly by wavesrv startup while the existing `GetWatcher` shape remains available to runtime consumers.

**Tech Stack:** Go 1.25.6, `sync.Cond`, `sync.OnceValues`, `fsnotify`, standard Go tests and race detector.

## Global Constraints

- Do not change config parsing, file filtering, broker event payloads, or handler registration semantics.
- Do not implement R4 or any held reliability finding.
- Do not edit generated files.
- Do not commit without separate explicit approval.
- Preserve `GetWatcher() *Watcher` for existing consumers.
- Invoke handlers outside the watcher state mutex.
- Do not use an arbitrarily bounded callback channel.

---

### Task 1: Ordered callback dispatcher

**Files:**
- Create: `pkg/wconfig/filewatcher_test.go`
- Modify: `pkg/wconfig/filewatcher.go:24-173`

**Interfaces:**
- Consumes: `ConfigUpdateHandler`, `FullConfigType`, and existing `panichandler.PanicHandler`.
- Produces: `configDispatcher`, `configDispatch`, `newConfigDispatcher()`, `start()`, `enqueue(configDispatch) bool`, and `close()` for watcher-owned ordered delivery.

- [x] **Step 1: Write dispatcher tests first**

Create `pkg/wconfig/filewatcher_test.go` with package `wconfig` and tests that exercise the real dispatcher:

```go
package wconfig

import (
    "testing"
    "time"
)

const dispatcherTestTimeout = 2 * time.Second

func receiveConfigVersion(t *testing.T, ch <-chan string) string {
    t.Helper()
    select {
    case version := <-ch:
        return version
    case <-time.After(dispatcherTestTimeout):
        t.Fatal("timed out waiting for config dispatch")
        return ""
    }
}

func TestConfigDispatcherPreservesUpdateOrder(t *testing.T) {
    dispatcher := newConfigDispatcher()
    dispatcher.start()
    t.Cleanup(dispatcher.close)

    entered := make(chan struct{})
    release := make(chan struct{})
    observed := make(chan string, 2)
    handler := func(config FullConfigType) {
        if config.Version == "A" {
            close(entered)
            <-release
        }
        observed <- config.Version
    }

    if !dispatcher.enqueue(configDispatch{config: FullConfigType{Version: "A"}, handlers: []ConfigUpdateHandler{handler}}) {
        t.Fatal("enqueue A failed")
    }
    <-entered
    if !dispatcher.enqueue(configDispatch{config: FullConfigType{Version: "B"}, handlers: []ConfigUpdateHandler{handler}}) {
        t.Fatal("enqueue B failed")
    }

    close(release)
    if got := receiveConfigVersion(t, observed); got != "A" {
        t.Fatalf("first update = %q, want A", got)
    }
    if got := receiveConfigVersion(t, observed); got != "B" {
        t.Fatalf("second update = %q, want B", got)
    }
}

func TestConfigDispatcherContinuesAfterHandlerPanic(t *testing.T) {
    dispatcher := newConfigDispatcher()
    dispatcher.start()
    t.Cleanup(dispatcher.close)

    observed := make(chan string, 2)
    panicking := func(FullConfigType) { panic("test panic") }
    recording := func(config FullConfigType) { observed <- config.Version }

    dispatcher.enqueue(configDispatch{
        config: FullConfigType{Version: "A"},
        handlers: []ConfigUpdateHandler{panicking, recording},
    })
    dispatcher.enqueue(configDispatch{
        config: FullConfigType{Version: "B"},
        handlers: []ConfigUpdateHandler{recording},
    })

    if got := receiveConfigVersion(t, observed); got != "A" {
        t.Fatalf("first update = %q, want A", got)
    }
    if got := receiveConfigVersion(t, observed); got != "B" {
        t.Fatalf("second update = %q, want B", got)
    }
}

func TestConfigDispatcherCloseDropsQueuedUpdates(t *testing.T) {
    dispatcher := newConfigDispatcher()
    dispatcher.start()

    entered := make(chan struct{})
    release := make(chan struct{})
    observed := make(chan string, 2)
    handler := func(config FullConfigType) {
        if config.Version == "A" {
            close(entered)
            <-release
        }
        observed <- config.Version
    }

    dispatcher.enqueue(configDispatch{config: FullConfigType{Version: "A"}, handlers: []ConfigUpdateHandler{handler}})
    <-entered
    dispatcher.enqueue(configDispatch{config: FullConfigType{Version: "B"}, handlers: []ConfigUpdateHandler{handler}})
    dispatcher.close()
    if dispatcher.enqueue(configDispatch{config: FullConfigType{Version: "C"}, handlers: []ConfigUpdateHandler{handler}}) {
        t.Fatal("enqueue after close must fail")
    }
    close(release)

    select {
    case <-dispatcher.done:
    case <-time.After(dispatcherTestTimeout):
        t.Fatal("dispatcher did not stop")
    }
    if got := receiveConfigVersion(t, observed); got != "A" {
        t.Fatalf("completed update = %q, want A", got)
    }
    select {
    case got := <-observed:
        t.Fatalf("queued update %q ran after close", got)
    default:
    }
}
```

- [x] **Step 2: Run the tests and verify RED**

Run:

```bash
go test ./pkg/wconfig -run '^TestConfigDispatcher' -count=1
```

Expected: build failure because `newConfigDispatcher` and `configDispatch` do not exist.

- [x] **Step 3: Implement the minimal serial dispatcher**

In `pkg/wconfig/filewatcher.go`, add these internal types and methods:

```go
type configDispatch struct {
    config   FullConfigType
    handlers []ConfigUpdateHandler
}

type configDispatcher struct {
    mutex   sync.Mutex
    cond    *sync.Cond
    queue   []configDispatch
    started bool
    closed  bool
    done    chan struct{}
}

func newConfigDispatcher() *configDispatcher {
    dispatcher := &configDispatcher{done: make(chan struct{})}
    dispatcher.cond = sync.NewCond(&dispatcher.mutex)
    return dispatcher
}

func (d *configDispatcher) start() {
    d.mutex.Lock()
    if d.started || d.closed {
        d.mutex.Unlock()
        return
    }
    d.started = true
    d.mutex.Unlock()
    go d.run()
}

func (d *configDispatcher) enqueue(update configDispatch) bool {
    d.mutex.Lock()
    defer d.mutex.Unlock()
    if d.closed {
        return false
    }
    d.queue = append(d.queue, update)
    d.cond.Signal()
    return true
}

func (d *configDispatcher) close() {
    d.mutex.Lock()
    if d.closed {
        d.mutex.Unlock()
        return
    }
    d.closed = true
    d.queue = nil
    d.cond.Broadcast()
    if !d.started {
        close(d.done)
    }
    d.mutex.Unlock()
}

func (d *configDispatcher) run() {
    defer close(d.done)
    for {
        d.mutex.Lock()
        for len(d.queue) == 0 && !d.closed {
            d.cond.Wait()
        }
        if d.closed {
            d.mutex.Unlock()
            return
        }
        update := d.queue[0]
        d.queue[0] = configDispatch{}
        d.queue = d.queue[1:]
        d.mutex.Unlock()

        for _, handler := range update.handlers {
            invokeConfigHandler(handler, update.config)
        }
    }
}

func invokeConfigHandler(handler ConfigUpdateHandler, config FullConfigType) {
    defer func() {
        panichandler.PanicHandler("filewatcher:notifyHandlers", recover())
    }()
    handler(config)
}
```

Add `dispatcher *configDispatcher` to `Watcher`. Initialize it beside the concrete fsnotify watcher.

Refactor watcher delivery as follows:

- `Start` returns early when already initialized or closed, captures the concrete fsnotify pointer under the mutex, starts the dispatcher once, sends initial values, and starts one fsnotify loop using the captured pointer.
- `sendInitialValues` reads config, updates `fullConfig` under the mutex, unlocks, then calls `broadcast`.
- `handleEvent` no longer holds the watcher mutex around file I/O or callback scheduling.
- `handleSettingsFileEvent` reads config, updates `fullConfig` under the mutex, unlocks, then calls `broadcast`.
- `notifyHandlers` copies `w.handlers` under the mutex, unlocks, and enqueues `configDispatch{config: config, handlers: handlers}`.
- `Close` marks dispatch closed, swaps `w.watcher` to nil under the state mutex, unlocks, and closes the captured fsnotify watcher outside the mutex.

Use this exact handler snapshot pattern:

```go
func (w *Watcher) notifyHandlers(config FullConfigType) {
    w.mutex.Lock()
    handlers := append([]ConfigUpdateHandler(nil), w.handlers...)
    w.mutex.Unlock()
    w.dispatcher.enqueue(configDispatch{config: config, handlers: handlers})
}
```

- [x] **Step 4: Run dispatcher tests and race detector**

Run:

```bash
go test ./pkg/wconfig -run '^TestConfigDispatcher' -count=1
go test -race ./pkg/wconfig -run '^TestConfigDispatcher' -count=1
```

Expected: all three tests pass; race detector reports no race.

- [x] **Step 5: Review Task 1 diff**

Run:

```bash
git diff --check -- pkg/wconfig/filewatcher.go pkg/wconfig/filewatcher_test.go
git diff -- pkg/wconfig/filewatcher.go pkg/wconfig/filewatcher_test.go
```

Confirm callbacks are never invoked under `Watcher.mutex`, no arbitrary queue bound was introduced, and no unrelated config behavior changed.

---

### Task 2: Explicit watcher initialization failure

**Files:**
- Modify: `pkg/wconfig/filewatcher.go:19-62`
- Modify: `pkg/wconfig/filewatcher_test.go`
- Modify: `cmd/server/main-server.go:88-128, 474-590`
- Create: `cmd/server/main-server_test.go`

**Interfaces:**
- Consumes: Task 1's `newConfigDispatcher()` and existing `Watcher.Start()`.
- Produces: `InitWatcher() (*Watcher, error)`, preserved `GetWatcher() *Watcher`, and `startConfigWatcher() error`.

- [x] **Step 1: Add failing initialization tests**

Append this constructor test to `pkg/wconfig/filewatcher_test.go`:

```go
func TestNewWatcherReturnsConstructionError(t *testing.T) {
    sentinel := errors.New("watcher unavailable")
    watcher, err := newWatcher(func() (*fsnotify.Watcher, error) {
        return nil, sentinel
    })
    if watcher != nil {
        t.Fatal("failed construction must not return a watcher")
    }
    if !errors.Is(err, sentinel) {
        t.Fatalf("error = %v, want sentinel", err)
    }
}
```

Add imports for `errors` and `github.com/fsnotify/fsnotify`.

Create `cmd/server/main-server_test.go`:

```go
package main

import (
    "errors"
    "testing"

    "github.com/wavetermdev/waveterm/pkg/wconfig"
)

func TestStartConfigWatcherReturnsInitializationError(t *testing.T) {
    sentinel := errors.New("watcher unavailable")
    original := initConfigWatcher
    initConfigWatcher = func() (*wconfig.Watcher, error) {
        return nil, sentinel
    }
    t.Cleanup(func() { initConfigWatcher = original })

    err := startConfigWatcher()
    if !errors.Is(err, sentinel) {
        t.Fatalf("error = %v, want sentinel", err)
    }
}
```

- [x] **Step 2: Run tests and verify RED**

Run:

```bash
go test ./pkg/wconfig ./cmd/server -run 'Test(NewWatcherReturnsConstructionError|StartConfigWatcherReturnsInitializationError)' -count=1
```

Expected: build failures because `newWatcher`, `initConfigWatcher`, and the error-returning `startConfigWatcher` contract do not yet exist.

- [x] **Step 3: Implement error-preserving singleton initialization**

In `pkg/wconfig/filewatcher.go`:

1. Add `fmt` to imports.
2. Replace `instance` and `once` with an initializer that retains pointer and error:

```go
type fsnotifyFactory func() (*fsnotify.Watcher, error)

var watcherOnce = sync.OnceValues(func() (*Watcher, error) {
    return newWatcher(fsnotify.NewWatcher)
})
```

3. Extract existing construction and path registration into:

```go
func newWatcher(factory fsnotifyFactory) (*Watcher, error) {
    fileWatcher, err := factory()
    if err != nil {
        return nil, err
    }
    watcher := &Watcher{
        watcher:    fileWatcher,
        dispatcher: newConfigDispatcher(),
    }
    configDirAbsPath := wavebase.GetWaveConfigDir()
    log.Printf("create config watcher, configdir=%q", configDirAbsPath)
    const failedStr = "failed to add path %s to watcher: %v"
    if err := watcher.watcher.Add(configDirAbsPath); err != nil {
        log.Printf(failedStr, configDirAbsPath, err)
    }
    for _, dir := range GetConfigSubdirs() {
        if err := watcher.watcher.Add(dir); err != nil && !os.IsNotExist(err) {
            log.Printf(failedStr, dir, err)
        }
    }
    return watcher, nil
}
```

4. Add the public initializer and preserve the existing accessor:

```go
func InitWatcher() (*Watcher, error) {
    return watcherOnce()
}

func GetWatcher() *Watcher {
    watcher, err := InitWatcher()
    if err != nil {
        panic(fmt.Errorf("initializing config watcher: %w", err))
    }
    return watcher
}
```

- [x] **Step 4: Handle initialization at the server boundary**

In `cmd/server/main-server.go`, add the test seam and change startup:

```go
var initConfigWatcher = wconfig.InitWatcher

func startConfigWatcher() error {
    watcher, err := initConfigWatcher()
    if err != nil {
        return fmt.Errorf("initializing config watcher: %w", err)
    }
    watcher.Start()
    return nil
}
```

Replace the bare startup call with:

```go
err = startConfigWatcher()
if err != nil {
    log.Printf("error starting config watcher: %v\n", err)
    return
}
```

Change shutdown to avoid calling the panic-on-error accessor when startup initialization failed:

```go
watcher, err := wconfig.InitWatcher()
if err == nil {
    watcher.Close()
}
```

- [x] **Step 5: Run focused and package tests**

Run:

```bash
CGO_CFLAGS='-IC:/Users/kael02/IdeaProjects/waveterm/pkg/jarvisembed/csrc' go test ./pkg/wconfig ./cmd/server -run 'Test(NewWatcherReturnsConstructionError|StartConfigWatcherReturnsInitializationError)' -count=1
CGO_CFLAGS='-IC:/Users/kael02/IdeaProjects/waveterm/pkg/jarvisembed/csrc' go test -race ./pkg/wconfig -count=1
CGO_CFLAGS='-IC:/Users/kael02/IdeaProjects/waveterm/pkg/jarvisembed/csrc' go test ./cmd/server ./pkg/wconfig -count=1
```

Expected: all tests pass.

- [x] **Step 6: Review Task 2 diff**

Run:

```bash
git diff --check -- pkg/wconfig/filewatcher.go pkg/wconfig/filewatcher_test.go cmd/server/main-server.go cmd/server/main-server_test.go
git diff -- pkg/wconfig/filewatcher.go pkg/wconfig/filewatcher_test.go cmd/server/main-server.go cmd/server/main-server_test.go
```

Confirm the original initialization error remains discoverable with `errors.Is`, startup returns before dependent loops launch, and no existing `GetWatcher` consumer changed.

---

### Task 3: Reconcile reliability documentation

**Files:**
- Modify: `docs/open-issues.md:25-52`
- Modify: `docs/superpowers/briefs/2026-08-25-reliability-improvement-scan.md:1-105`

**Interfaces:**
- Consumes: verified commit `b9aad7fd` for R1/R3 and Tasks 1-2 for R2.
- Produces: a current backlog where R4 is the first remaining actionable reliability fix.

- [x] **Step 1: Update the consolidated backlog**

In `docs/open-issues.md`:

- Replace the 2026-08-24 scan paragraph that still calls O1 a blocker with a historical note that `b9aad7fd` shipped O1-O8 and only the remaining Jarvis findings stay available for triage.
- Remove the actionable rows for the DAG merge blocker and DAG scheduler safety batch.
- Remove the config-watcher R2 row after Tasks 1-2 pass.
- Keep websocket R4 as the first remaining reliability row.
- Keep held R5 and M1 unchanged.

- [x] **Step 2: Update the reliability brief without deleting history**

In `docs/superpowers/briefs/2026-08-25-reliability-improvement-scan.md`:

- Add an update note recording R1 and R3 as shipped in `b9aad7fd` and R2 as shipped by this work.
- Change R1, R2, and R3 statuses in the ranked table and section headings to `Shipped`.
- Replace the recommended sequence with R4 first, followed by the existing R5 probe and M1 measurement.
- Keep the original evidence and validation text as historical rationale.

- [x] **Step 3: Check documentation consistency**

Run:

```bash
rg -n "R1 first|R3 second|R2 third|Actionable blocker|DAG merge blocker|DAG scheduler safety batch|Config watcher" docs/open-issues.md docs/superpowers/briefs/2026-08-25-reliability-improvement-scan.md
git diff --check -- docs/open-issues.md docs/superpowers/briefs/2026-08-25-reliability-improvement-scan.md docs/superpowers/specs/2026-08-25-config-watcher-reliability-design.md docs/superpowers/plans/2026-08-25-config-watcher-reliability.md
```

Expected: no text recommends R1-R3 as future work; historical descriptions are clearly marked shipped; no whitespace errors.

---

### Task 4: Final verification and review

**Files:**
- Review all files changed by Tasks 1-3.

**Interfaces:**
- Consumes: all prior task outputs.
- Produces: verified uncommitted R2 implementation ready for user review.

- [x] **Step 1: Format Go files**

Run:

```bash
gofmt -w pkg/wconfig/filewatcher.go pkg/wconfig/filewatcher_test.go cmd/server/main-server.go cmd/server/main-server_test.go
```

- [x] **Step 2: Run focused verification**

Run:

```bash
CGO_CFLAGS='-IC:/Users/kael02/IdeaProjects/waveterm/pkg/jarvisembed/csrc' go test -race ./pkg/wconfig -count=1
CGO_CFLAGS='-IC:/Users/kael02/IdeaProjects/waveterm/pkg/jarvisembed/csrc' go test ./cmd/server ./pkg/wconfig -count=1
```

Expected: both commands exit 0.

- [x] **Step 3: Build the backend**

Run:

```bash
task build:backend
```

Expected: backend and `wsh` build successfully.

- [x] **Step 4: Self-review the final diff**

Run:

```bash
git status --short
git diff --check
git diff --stat
git diff -- pkg/wconfig/filewatcher.go pkg/wconfig/filewatcher_test.go cmd/server/main-server.go cmd/server/main-server_test.go docs/open-issues.md docs/superpowers/briefs/2026-08-25-reliability-improvement-scan.md docs/superpowers/specs/2026-08-25-config-watcher-reliability-design.md docs/superpowers/plans/2026-08-25-config-watcher-reliability.md
```

Confirm there are no debug statements, commented-out code, generated-file edits, unrelated formatting, or claims unsupported by test output. Do not commit.
