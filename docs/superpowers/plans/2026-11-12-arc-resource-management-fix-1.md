# Memory and CPU management across Arc, fix round 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Effort:** effort:de39be0f-317c-4b34-a243-5879a6e4d94c
**Spec:** `docs/superpowers/specs/2026-11-12-arc-resource-management-design.md`
**Verify:** `node scripts/verify.mjs ./pkg/... ./cmd/...`
**Check:** `go build ./... && task check:ts`
**Final:** `node scripts/cdp/final-verify.mjs run-sheet-polish final-stage`

**Goal:** Make `pkg/memgate` `TestWaitCancel` deterministic, and make the reconciliation loop end an
over-limit pause even when free memory cannot be read.

**Architecture:** Both fixes are in `pkg/memgate`. Events go out on one delivery goroutine
(`gate.go` `enqueue`/`deliverLoop`), and each closure loads the event sink when it runs, not when it is
enqueued. `TestWaitAdmitsOnRelease` ends with its `held`/`admitted` events possibly still queued; the next
test's `newGate` installs a fresh recorder, and those leftover events land in it, so `TestWaitCancel` sees
`[admitted held]` or `[held held]` instead of `[held]`. The test helper must drain the queue at the test
boundary. Separately, `reconcile.go` `tick` returns as soon as `freeMem()` errors, before
`resumeLimitedLocked(t)`, so a persistent read failure lets a pause outlive the 3-minute limit (decision 12).

**Tech Stack:** Go.

## Decisions

1. **Fix the test boundary, not the product.** Loading the sink at delivery time is correct for the server (one
   sink, set once at startup). The leak is only between tests, so `newGate` drains the queue with the existing
   `flush()` before it installs the recorder, and its cleanup flushes before it clears the sink. No sleeps, no
   retries.
2. **The pause limit does not depend on a memory reading.** `resumeLimitedLocked(t)` runs before the
   `freeMem()` read; pausing, resuming on the high watermark and the rise check stay behind it, since they need
   the figure.

## Global Constraints

- Touch only `pkg/memgate/gate_test.go`, `pkg/memgate/reconcile.go` and `pkg/memgate/reconcile_test.go`.
- Stage files by path; never `git add -A`.

## Review Focus

1. A leftover event from any earlier test reaching a later test's recorder: covered by the `newGate` flush and by
   running the package with `-count=20`.
2. A pause on a machine whose free-memory read fails every tick: covered by `TestPauseLimitWithoutFreeReading`.

---

### Task 1: Deterministic gate tests and a pause limit that holds without a reading

**Files:** `pkg/memgate/gate_test.go`, `pkg/memgate/reconcile.go`, `pkg/memgate/reconcile_test.go`

**Interfaces:**
- Consumes: `flush()` in `gate_test.go`; `newLoop`, `liveTree`, `SetFreeForTest`, the package `now` clock var and
  `resumeLimitedLocked` from the landed t-2/t-3 code.
- Produces: nothing new.

- [ ] **Step 1: Reproduce the flake**

Run: `go test ./pkg/memgate -run 'TestWaitAdmitsOnRelease|TestWaitCancel' -count=200`
Expected: at least one `TestWaitCancel` failure, `events = [...], want [held]`. If 200 runs do not fail, add
`-cpu 1,2,4` and say in the report how many runs it took or that it did not reproduce.

- [ ] **Step 2: Drain the delivery queue at test boundaries**

In `newGate`, call `flush()` after resetting the book and before `SetEventSink`. In its `t.Cleanup`, call
`flush()` before `SetEventSink(nil)` and `SetRoomHook(nil)`.

- [ ] **Step 3: Run the repro again**

Run: `go test ./pkg/memgate -count=20` and `go test ./pkg/memgate -run 'TestWaitAdmitsOnRelease|TestWaitCancel' -count=500`
Expected: PASS both.

- [ ] **Step 4: Write the failing test `TestPauseLimitWithoutFreeReading` in `reconcile_test.go`**

Pause a worker as `TestPauseLimit` does (a live plan command beside it so the worker is not the last tree), then
replace the free reading with `SetFreeForTest(func() (uint64, error) { return 0, errors.New("unreadable") })`,
advance the clock past 3 minutes and tick. Assert: the worker is resumed and a `resumed` event with reason
`ReasonLimit` is recorded.

Run: `go test ./pkg/memgate -run '^TestPauseLimitWithoutFreeReading$'`
Expected: FAIL (no resumed event).

- [ ] **Step 5: Move `resumeLimitedLocked(t)` ahead of the `freeMem()` read in `tick`**

Keep the log line on a read error and the early return after it.

- [ ] **Step 6: Run the package**

Run: `go test ./pkg/memgate -count=5`
Expected: PASS, including `TestPauseLimit` and `TestPauseLimitWithoutFreeReading`.

- [ ] **Step 7: Commit**

```bash
git add pkg/memgate/gate_test.go pkg/memgate/reconcile.go pkg/memgate/reconcile_test.go
git commit -m "fix(memgate): drain events between tests; limit pauses without a reading"
```
