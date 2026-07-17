# Theme 3 — Ask-channel Backend Correctness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close two backend concurrency-correctness gaps in the agent ask/run subsystem — (A1) make `DeliverAnswer` atomically claim the pending ask so a picker can never be double-injected, and (A2) serialize `spawnRunWorkers` per run so a phase worker can never be double-spawned.

**Architecture:** A1 adds an atomic `Registry.Claim(oref, askid)` (look-up-and-delete under one lock) and reroutes `DeliverAnswer` through it, so only the first deliverer injects keystrokes; the Gatekeeper additionally passes the `AskId` to reject a stale answer landing on a replaced ask. A2 adds a small reference-counted keyed mutex and wraps the whole read→spawn→attach sequence of `spawnRunWorkers` in a per-`runId` lock, making the `len(WorkerOrefs) > 0` double-spawn guard effective across concurrent callers. No wire-type, codegen, or frontend changes.

**Tech Stack:** Go 1.x, standard library `sync`, existing `pkg/agentask` / `pkg/jarvis` / `pkg/wshrpc/wshserver` test harnesses (`go test`).

**Design source:** `docs/superpowers/briefs/2026-07-17-theme3-backend-correctness-brief.md` (resolved design decisions). Raw scan evidence: `docs/deferred.md` §"Net-new improvement scan (2026-07-17)" Theme 3.

## Global Constraints

- **No wire change / no `task generate`.** `CommandAnswerAgentData` is untouched (A1-b full-askid threading declined). No frontend edits.
- **No new keystroke protocol.** `EncodeAnswer` and the picker byte protocol are unchanged (already covered by `encode_test.go`).
- **Idempotent no-op contract preserved.** `DeliverAnswer` returns `(false, nil)` when no ask is pending — both `AnswerAgentCommand` and the Gatekeeper actuator rely on this.
- **Run spawn stays outside the state-transition transaction.** Do NOT move spawn+attach into an `UpdateRun` — tab creation must keep flushing its own update events. Serialize with a lock instead.
- **Commits are batched at the end pending explicit user approval** (per user git workflow: never commit without approval; fold this plan doc into the feature commit). The "Commit" steps below are green-checkpoints; the actual single commit happens after approval.
- **Build/verify commands:** run from the worktree root. Go tests: `go test ./pkg/agentask/ ./pkg/jarvis/ ./pkg/wshrpc/wshserver/`. Race detector for the concurrency tests: append `-race`.

---

### Task 1: Atomic `Registry.Claim`

**Files:**
- Modify: `pkg/agentask/agentask.go` (add `Claim` method after `Drop`, `:52`)
- Test: `pkg/agentask/agentask_test.go` (append)

**Interfaces:**
- Produces: `func (r *Registry) Claim(oref, askid string) (PendingAsk, bool)` — under one lock: returns `(PendingAsk{}, false)` without deleting if no entry, or if `askid != "" && pending.AskId != askid`; otherwise deletes and returns `(pending, true)`.

- [ ] **Step 1: Write the failing tests**

Append to `pkg/agentask/agentask_test.go`:

```go
func TestClaim_NoPendingIsFalse(t *testing.T) {
	r := MakeRegistry()
	if _, ok := r.Claim("block:none", ""); ok {
		t.Fatalf("Claim returned ok=true for an unknown oref")
	}
}

func TestClaim_EmptyAskidMatchesAndDeletes(t *testing.T) {
	r := MakeRegistry()
	r.Set("block:b1", mkPending("ask-1", "b1"))
	got, ok := r.Claim("block:b1", "")
	if !ok || got.AskId != "ask-1" {
		t.Fatalf("Claim = (%+v,%v), want (ask-1,true)", got, ok)
	}
	if _, still := r.Get("block:b1"); still {
		t.Fatalf("Claim must delete the entry")
	}
}

func TestClaim_MatchingAskidDeletes(t *testing.T) {
	r := MakeRegistry()
	r.Set("block:b1", mkPending("ask-1", "b1"))
	if _, ok := r.Claim("block:b1", "ask-1"); !ok {
		t.Fatalf("Claim with matching askid should win")
	}
	if _, still := r.Get("block:b1"); still {
		t.Fatalf("Claim must delete on a matching askid")
	}
}

func TestClaim_MismatchedAskidRetains(t *testing.T) {
	r := MakeRegistry()
	r.Set("block:b1", mkPending("ask-1", "b1"))
	if _, ok := r.Claim("block:b1", "ask-2"); ok {
		t.Fatalf("Claim with a stale askid must not win")
	}
	if _, still := r.Get("block:b1"); !still {
		t.Fatalf("Claim must retain the entry on an askid mismatch")
	}
}

func TestClaim_ConcurrentExactlyOneWinner(t *testing.T) {
	r := MakeRegistry()
	r.Set("block:b1", mkPending("ask-1", "b1"))
	const n = 32
	var wins int32
	var wg sync.WaitGroup
	wg.Add(n)
	for i := 0; i < n; i++ {
		go func() {
			defer wg.Done()
			if _, ok := r.Claim("block:b1", ""); ok {
				atomic.AddInt32(&wins, 1)
			}
		}()
	}
	wg.Wait()
	if wins != 1 {
		t.Fatalf("concurrent Claim winners = %d, want exactly 1", wins)
	}
}
```

Add imports `"sync"` and `"sync/atomic"` to the test file's import block.

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./pkg/agentask/ -run TestClaim`
Expected: FAIL — `r.Claim undefined (type *Registry has no field or method Claim)`.

- [ ] **Step 3: Implement `Claim`**

Add to `pkg/agentask/agentask.go` after the `Drop` method:

```go
// Claim atomically removes and returns the pending ask for oref, making "who delivers it" a single
// decision. It returns (_, false) WITHOUT deleting when no ask is pending, or when askid != "" and the
// pending ask's AskId differs (a stale answer for an ask that was replaced). Otherwise it deletes the
// entry and returns (pending, true) — only the first caller for a given pending ask wins.
func (r *Registry) Claim(oref, askid string) (PendingAsk, bool) {
	r.lock.Lock()
	defer r.lock.Unlock()
	p, ok := r.pending[oref]
	if !ok {
		return PendingAsk{}, false
	}
	if askid != "" && p.AskId != askid {
		return PendingAsk{}, false
	}
	delete(r.pending, oref)
	return p, true
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./pkg/agentask/ -run TestClaim -race`
Expected: PASS (all 5 `TestClaim*`).

- [ ] **Step 5: Commit (green-checkpoint — batched at end pending approval)**

```bash
git add pkg/agentask/agentask.go pkg/agentask/agentask_test.go
# actual commit deferred; verify green only
```

---

### Task 2: `DeliverAnswer` claims-once (+ restore semantics + callers)

**Files:**
- Modify: `pkg/agentask/deliver.go` (rewrite `DeliverAnswer`, `:18-41`)
- Modify: `pkg/jarvis/watcher.go:110` (pass `data.AskId`)
- Modify: `pkg/wshrpc/wshserver/wshserver.go:2343` (pass `""`)
- Test: `pkg/agentask/deliver_test.go` (update 2 existing calls + add 3 tests)

**Interfaces:**
- Consumes: `Registry.Claim` (Task 1).
- Produces: `func DeliverAnswer(oref, askid string, answers []baseds.AgentAnswerItem) (bool, error)`. New middle param `askid`; behavior: `Claim` first (gate); `!ok` → `(false, nil)`; on **encode** error re-`Set` the pending and return `(false, err)`; on **mid-inject** error do NOT restore, return `(false, err)`; success → `(true, nil)`.

- [ ] **Step 1: Update existing tests to the new signature, then write the failing new tests**

In `pkg/agentask/deliver_test.go`, update the two existing calls:
- `TestDeliverAnswer_NoPending`: `DeliverAnswer("tab:none", "", []baseds.AgentAnswerItem{{SelectedIndexes: []int{0}}})`
- `TestDeliverAnswer_Delivers`: `DeliverAnswer("tab:t1", "", []baseds.AgentAnswerItem{{SelectedIndexes: []int{1}}})`

Then append:

```go
func TestDeliverAnswer_RestoresOnEncodeError(t *testing.T) {
	GlobalRegistry = MakeRegistry()
	GlobalRegistry.Set("tab:t1", PendingAsk{AskId: "a1", BlockId: "b1", Questions: oneQuestion()})
	// index 5 is out of range for the 2-option question -> EncodeAnswer errors AFTER Claim.
	delivered, err := DeliverAnswer("tab:t1", "", []baseds.AgentAnswerItem{{SelectedIndexes: []int{5}}})
	if delivered || err == nil {
		t.Fatalf("want (false, err) on encode failure, got (%v, %v)", delivered, err)
	}
	if _, ok := GlobalRegistry.Get("tab:t1"); !ok {
		t.Fatalf("encode error must restore the pending ask (no keystrokes were sent)")
	}
}

func TestDeliverAnswer_NoRestoreOnInjectError(t *testing.T) {
	GlobalRegistry = MakeRegistry()
	GlobalRegistry.Set("tab:t1", PendingAsk{AskId: "a1", BlockId: "b1", Questions: oneQuestion()})
	orig := sendInput
	sendInput = func(string, []byte) error { return errors.New("pty gone") }
	defer func() { sendInput = orig }()

	delivered, err := DeliverAnswer("tab:t1", "", []baseds.AgentAnswerItem{{SelectedIndexes: []int{1}}})
	if delivered || err == nil {
		t.Fatalf("want (false, err) on inject failure, got (%v, %v)", delivered, err)
	}
	if _, ok := GlobalRegistry.Get("tab:t1"); ok {
		t.Fatalf("mid-inject error must NOT restore (a retry would double-send); entry stays claimed")
	}
}

func TestDeliverAnswer_ConcurrentInjectsOnce(t *testing.T) {
	GlobalRegistry = MakeRegistry()
	GlobalRegistry.Set("tab:t1", PendingAsk{AskId: "a1", BlockId: "b1", Questions: oneQuestion()})
	var mu sync.Mutex
	var writes int
	orig := sendInput
	sendInput = func(string, []byte) error { mu.Lock(); writes++; mu.Unlock(); return nil }
	defer func() { sendInput = orig }()

	const n = 16
	var delivers int32
	var wg sync.WaitGroup
	wg.Add(n)
	for i := 0; i < n; i++ {
		go func() {
			defer wg.Done()
			if ok, _ := DeliverAnswer("tab:t1", "", []baseds.AgentAnswerItem{{SelectedIndexes: []int{1}}}); ok {
				atomic.AddInt32(&delivers, 1)
			}
		}()
	}
	wg.Wait()
	if delivers != 1 {
		t.Fatalf("delivered=true count = %d, want exactly 1", delivers)
	}
	// index 1 => exactly one full sequence (downArrow + enter = 2 writes), never doubled.
	if writes != 2 {
		t.Fatalf("keystroke writes = %d, want 2 (one full sequence)", writes)
	}
}
```

Add imports `"errors"`, `"sync"`, `"sync/atomic"` to `deliver_test.go`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./pkg/agentask/ -run TestDeliverAnswer`
Expected: FAIL — `too many arguments in call to DeliverAnswer` (signature mismatch) on every call.

- [ ] **Step 3: Rewrite `DeliverAnswer`**

Replace `DeliverAnswer` in `pkg/agentask/deliver.go`:

```go
// DeliverAnswer atomically claims the pending ask for oref, then injects its answers into the native
// picker. It returns delivered=false with no error when no ask is pending (already answered/cleared), or
// when askid != "" and no longer matches the pending ask — the idempotent no-op both AnswerAgentCommand
// and the Gatekeeper actuator rely on. Claiming makes concurrent deliveries mutually exclusive: exactly
// one caller injects; the rest see delivered=false. It sends one keystroke per PTY write with
// KeystrokeDelay between each (a single combined write races the picker's React state).
//
// Error recovery mirrors what has already been sent: an EncodeAnswer failure sends no keystrokes, so the
// pending ask is restored and a retry is safe; a mid-inject sendInput failure has already put a partial
// keystroke prefix into the picker, so the entry stays claimed (dropped) — restoring would risk a
// double-send on retry.
func DeliverAnswer(oref, askid string, answers []baseds.AgentAnswerItem) (bool, error) {
	pending, ok := GlobalRegistry.Claim(oref, askid)
	if !ok {
		return false, nil
	}
	keys, err := EncodeAnswer(pending.Questions, answers)
	if err != nil {
		GlobalRegistry.Set(oref, pending) // nothing sent yet — safe to restore for retry
		return false, err
	}
	for i, k := range keys {
		if i > 0 {
			time.Sleep(KeystrokeDelay)
		}
		if err := sendInput(pending.BlockId, k); err != nil {
			return false, err // partial prefix already sent — do NOT restore
		}
	}
	return true, nil
}
```

- [ ] **Step 4: Update the two callers**

`pkg/jarvis/watcher.go:110` — pass the in-process `data.AskId` (double-inject guard + staleness guard):

```go
			delivered, derr := agentask.DeliverAnswer(data.ORef, data.AskId, []baseds.AgentAnswerItem{{SelectedIndexes: []int{idx}}})
```

`pkg/wshrpc/wshserver/wshserver.go:2343` — pass `""` (double-inject guard only; the panel path has no askid on the wire):

```go
	_, err := agentask.DeliverAnswer(data.ORef, "", data.Answers)
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `go test ./pkg/agentask/ -run TestDeliverAnswer -race`
Expected: PASS (2 updated + 3 new).
Then build the callers: `go build ./pkg/jarvis/ ./pkg/wshrpc/wshserver/`
Expected: no errors.

- [ ] **Step 6: Full package check**

Run: `go test ./pkg/agentask/ ./pkg/jarvis/ ./pkg/wshrpc/wshserver/`
Expected: PASS (existing tests still green under the new signature).

- [ ] **Step 7: Commit (green-checkpoint — batched at end pending approval)**

```bash
git add pkg/agentask/deliver.go pkg/agentask/deliver_test.go pkg/jarvis/watcher.go pkg/wshrpc/wshserver/wshserver.go
# actual commit deferred; verify green only
```

---

### Task 3: Reference-counted keyed mutex (A2 primitive)

**Files:**
- Create: `pkg/wshrpc/wshserver/keyedmutex.go`
- Test: `pkg/wshrpc/wshserver/keyedmutex_test.go`

**Interfaces:**
- Produces: `type keyedMutex`, `func newKeyedMutex() *keyedMutex`, `func (k *keyedMutex) Lock(key string)`, `func (k *keyedMutex) Unlock(key string)`. Same key serializes; different keys run concurrently; per-key entries are deleted when idle (no unbounded map growth).

- [ ] **Step 1: Write the failing tests**

Create `pkg/wshrpc/wshserver/keyedmutex_test.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"sync"
	"testing"
	"time"
)

func TestKeyedMutex_SameKeySerializes(t *testing.T) {
	km := newKeyedMutex()
	km.Lock("a")
	entered := make(chan struct{})
	go func() {
		km.Lock("a")
		close(entered)
		km.Unlock("a")
	}()
	select {
	case <-entered:
		t.Fatalf("second Lock on the same key must block until Unlock")
	case <-time.After(50 * time.Millisecond):
		// still blocked as required
	}
	km.Unlock("a")
	select {
	case <-entered:
		// proceeded after Unlock
	case <-time.After(time.Second):
		t.Fatalf("second Lock did not proceed after Unlock")
	}
}

func TestKeyedMutex_DifferentKeysConcurrent(t *testing.T) {
	km := newKeyedMutex()
	km.Lock("a")
	defer km.Unlock("a")
	done := make(chan struct{})
	go func() {
		km.Lock("b")
		km.Unlock("b")
		close(done)
	}()
	select {
	case <-done:
		// a different key did not block on "a"
	case <-time.After(time.Second):
		t.Fatalf("Lock on a different key must not block")
	}
}

func TestKeyedMutex_MutualExclusionUnderLoad(t *testing.T) {
	km := newKeyedMutex()
	var active, maxActive int
	var mu sync.Mutex
	var wg sync.WaitGroup
	const n = 20
	wg.Add(n)
	for i := 0; i < n; i++ {
		go func() {
			defer wg.Done()
			km.Lock("k")
			mu.Lock()
			active++
			if active > maxActive {
				maxActive = active
			}
			mu.Unlock()
			time.Sleep(time.Millisecond)
			mu.Lock()
			active--
			mu.Unlock()
			km.Unlock("k")
		}()
	}
	wg.Wait()
	if maxActive != 1 {
		t.Fatalf("max concurrent holders of one key = %d, want 1", maxActive)
	}
}

func TestKeyedMutex_CleansUpIdleKeys(t *testing.T) {
	km := newKeyedMutex()
	km.Lock("a")
	km.Unlock("a")
	km.mu.Lock()
	n := len(km.locks)
	km.mu.Unlock()
	if n != 0 {
		t.Fatalf("idle key not cleaned up: %d entries remain", n)
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./pkg/wshrpc/wshserver/ -run TestKeyedMutex`
Expected: FAIL — `undefined: newKeyedMutex`.

- [ ] **Step 3: Implement the keyed mutex**

Create `pkg/wshrpc/wshserver/keyedmutex.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import "sync"

// keyedMutex serializes operations that share a key while letting different keys run concurrently.
// Per-key entries are reference-counted and removed once no goroutine holds or is waiting on them, so
// the map stays bounded by the number of keys in flight rather than every key ever seen.
type keyedMutex struct {
	mu    sync.Mutex
	locks map[string]*keyedMutexEntry
}

type keyedMutexEntry struct {
	mu   sync.Mutex
	refs int
}

func newKeyedMutex() *keyedMutex {
	return &keyedMutex{locks: make(map[string]*keyedMutexEntry)}
}

func (k *keyedMutex) Lock(key string) {
	k.mu.Lock()
	e, ok := k.locks[key]
	if !ok {
		e = &keyedMutexEntry{}
		k.locks[key] = e
	}
	e.refs++ // count the waiter before releasing k.mu so Unlock can't delete a live entry
	k.mu.Unlock()
	e.mu.Lock()
}

func (k *keyedMutex) Unlock(key string) {
	k.mu.Lock()
	e := k.locks[key]
	e.refs--
	if e.refs == 0 {
		delete(k.locks, key)
	}
	k.mu.Unlock()
	e.mu.Unlock()
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./pkg/wshrpc/wshserver/ -run TestKeyedMutex -race`
Expected: PASS (all 4).

- [ ] **Step 5: Commit (green-checkpoint — batched at end pending approval)**

```bash
git add pkg/wshrpc/wshserver/keyedmutex.go pkg/wshrpc/wshserver/keyedmutex_test.go
# actual commit deferred; verify green only
```

---

### Task 4: Serialize `spawnRunWorkers` per run (A2 wiring + acceptance test)

**Files:**
- Modify: `pkg/jarvis/runexec.go:27` (convert `SpawnClaudeWorker` to a stubbable `var` seam)
- Modify: `pkg/wshrpc/wshserver/wshserver.go` (package var `runSpawnLocks`; lock/unlock around the `spawnRunWorkers` body, `:1523-1544`)
- Test: `pkg/wshrpc/wshserver/wshserver_spawn_test.go` (create)

**Interfaces:**
- Consumes: `keyedMutex` (Task 3); `wstore.CreateChannel`, `wstore.AppendRun`, `wstore.GetRun`; `jarvis.NewRun`, `jarvis.DefaultPlaybook`, `jarvis.SpawnClaudeWorker` (now a `var`).
- Produces: `var runSpawnLocks = newKeyedMutex()` guarding `spawnRunWorkers` per `runId`.

- [ ] **Step 1: Convert `SpawnClaudeWorker` to a `var` seam**

In `pkg/jarvis/runexec.go`, change the declaration at `:27` from `func SpawnClaudeWorker(...)` to a package var (body unchanged), mirroring the `sendInput` seam pattern in `pkg/agentask/deliver.go`:

```go
// SpawnClaudeWorker creates a background tab running `claude ... <prompt>` ... (existing doc comment kept)
// It is a var so tests can stub the process-spawning boundary without a live tab/PTY.
var SpawnClaudeWorker = func(ctx context.Context, workspaceId, projectName, cwd, prompt string) (string, error) {
	// ... existing body unchanged ...
}
```

Verify no other reference breaks:
Run: `grep -rn "SpawnClaudeWorker" pkg/ cmd/`
Expected: only the declaration + `EnsureWorkers` call site (`runexec.go`); both are call-compatible with a var. Build: `go build ./pkg/jarvis/`.

- [ ] **Step 2: Write the failing acceptance test**

Create `pkg/wshrpc/wshserver/wshserver_spawn_test.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// Two concurrent spawnRunWorkers calls for one run must spawn its running phase exactly once.
// Before the per-run lock both callers read empty WorkerOrefs and both spawn (this fails);
// with the lock the second caller sees the attached oref and skips.
func TestSpawnRunWorkers_ConcurrentSpawnsOnce(t *testing.T) {
	ctx := context.Background()
	ch, err := wstore.CreateChannel(ctx, "spawn-race", "/repo")
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	run := jarvis.NewRun("do X", "ws-id", "/repo", nil, jarvis.RunMode_Pipeline, jarvis.DefaultPlaybook(), 1)
	if err := wstore.AppendRun(ctx, ch.OID, run); err != nil {
		t.Fatalf("AppendRun: %v", err)
	}

	var calls int32
	origSpawn := jarvis.SpawnClaudeWorker
	jarvis.SpawnClaudeWorker = func(_ context.Context, _, _, _, _ string) (string, error) {
		atomic.AddInt32(&calls, 1)
		time.Sleep(30 * time.Millisecond) // widen the read->spawn->attach window so a truly-concurrent second caller overlaps
		return waveobj.MakeORef(waveobj.OType_Tab, "faketab").String(), nil
	}
	defer func() { jarvis.SpawnClaudeWorker = origSpawn }()

	var wg sync.WaitGroup
	wg.Add(2)
	for i := 0; i < 2; i++ {
		go func() {
			defer wg.Done()
			if err := spawnRunWorkers(ctx, ch.OID, run.ID, ch.Name); err != nil {
				t.Errorf("spawnRunWorkers: %v", err)
			}
		}()
	}
	wg.Wait()

	if got := atomic.LoadInt32(&calls); got != 1 {
		t.Fatalf("SpawnClaudeWorker calls = %d, want exactly 1", got)
	}
	out, err := wstore.GetRun(ctx, ch.OID, run.ID)
	if err != nil {
		t.Fatalf("GetRun: %v", err)
	}
	if n := len(out.Phases[0].WorkerOrefs); n != 1 {
		t.Fatalf("phase 0 WorkerOrefs = %d, want 1", n)
	}
}
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `go test ./pkg/wshrpc/wshserver/ -run TestSpawnRunWorkers_ConcurrentSpawnsOnce -race`
Expected: FAIL — `SpawnClaudeWorker calls = 2, want exactly 1` (double-spawn) and/or `WorkerOrefs = 2`. (The `-race` run may also flag the concurrent map/run access this fix removes.)

- [ ] **Step 4: Add the per-run lock**

In `pkg/wshrpc/wshserver/wshserver.go`, add a package var near the other run helpers (just above `spawnRunWorkers`, `:1516`):

```go
// runSpawnLocks serializes spawnRunWorkers per runId so the read-back double-spawn guard
// (len(WorkerOrefs) > 0) is effective across concurrent CreateRun/AdvanceRun calls for one run.
var runSpawnLocks = newKeyedMutex()
```

Then wrap the body of `spawnRunWorkers` — acquire before the read, release after the attach/broadcast:

```go
func spawnRunWorkers(ctx context.Context, channelId, runId, projectName string) error {
	runSpawnLocks.Lock(runId)
	defer runSpawnLocks.Unlock(runId)
	ctx = waveobj.ContextWithUpdates(ctx)
	run, err := wstore.GetRun(ctx, channelId, runId)
	// ... rest of the existing body unchanged ...
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `go test ./pkg/wshrpc/wshserver/ -run TestSpawnRunWorkers_ConcurrentSpawnsOnce -race -count=5`
Expected: PASS on all 5 iterations (deterministic under the lock).

- [ ] **Step 6: Full verification**

Run: `go test ./pkg/agentask/ ./pkg/jarvis/ ./pkg/wshrpc/wshserver/ -race`
Expected: PASS across all three packages.
Then: `go build ./...` (catch any stray break from the seam conversion).
Expected: no errors.

- [ ] **Step 7: Commit (green-checkpoint — batched at end pending approval)**

```bash
git add pkg/jarvis/runexec.go pkg/wshrpc/wshserver/wshserver.go pkg/wshrpc/wshserver/wshserver_spawn_test.go
# actual commit deferred; verify green only
```

---

## Self-Review

**Spec coverage (brief → task):**
- A1 atomic `Claim` → Task 1. ✅
- A1 `DeliverAnswer` uses `Claim`, new `askid` param, restore-on-encode / no-restore-on-inject → Task 2. ✅
- A1 callers: Gatekeeper passes `data.AskId`, `AnswerAgentCommand` passes `""`, no wire change → Task 2 Step 4. ✅
- A1 acceptance (concurrent → inject once; stale askid → no-op; idempotent no-op preserved) → Task 1 `TestClaim_Concurrent*`/`TestClaim_MismatchedAskidRetains`, Task 2 `TestDeliverAnswer_ConcurrentInjectsOnce`/`_NoPending`. ✅
- A2 per-run keyed mutex across read→spawn→attach → Tasks 3 + 4. ✅
- A2 acceptance (concurrent spawnRunWorkers spawn once) → Task 4 `TestSpawnRunWorkers_ConcurrentSpawnsOnce`. ✅
- Non-goals honored: no `CommandAnswerAgentData` change; spawn stays outside the state-transition txn; no `EncodeAnswer`/protocol change. ✅
- Theme 4 coordination: A1 lands the new `DeliverAnswer` signature before Theme 4 adds `watcher_test.go`. ✅

**Placeholder scan:** none — every code step carries complete code.

**Type consistency:** `Claim(oref, askid string) (PendingAsk, bool)` and `DeliverAnswer(oref, askid string, answers []baseds.AgentAnswerItem) (bool, error)` used identically across Tasks 1–2 and both callers; `keyedMutex.Lock/Unlock(string)` and `runSpawnLocks` used identically across Tasks 3–4; `SpawnClaudeWorker` var signature matches its `EnsureWorkers` call site and the test stub.
