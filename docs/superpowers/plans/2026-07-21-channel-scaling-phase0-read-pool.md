# Channel Scaling — Phase 0: Read-Connection Pool — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only SQLite connection pool so top-level reads stop head-of-line-blocking behind a slow writer on the single write connection, without regressing the correctness that single-connection serialization currently guarantees.

**Architecture:** Keep the existing `globalDB` handle as the sole *write* connection (`SetMaxOpenConns(1)`, `mode=rwc`) — all writes and read-modify-write transactions stay on it and still serialize exactly as today. Add a second `readDB` handle (`mode=ro`, `SetMaxOpenConns(N)`) and `WithReadTx`/`WithReadTxRtn` wrappers; route the pure-read helpers in `wstore_dbops.go` to it. `txwrap` reuses an in-context transaction and ignores the passed handle, so a read nested inside a write (e.g. `DBUpdateFn` → `DBMustGet(tx.Context())`) automatically stays on the write connection — only *top-level* reads hit the pool. WAL (already enabled) lets N readers run concurrently with the one writer.

**Tech Stack:** Go, `github.com/jmoiron/sqlx`, `github.com/sawka/txwrap`, mattn `sqlite3` driver (WAL), standard `testing` with `-race`.

## Global Constraints

- **This is Phase 0 of the `2026-07-21-channel-data-model-scaling-design.md` spec.** It touches no data model, no wire protocol, no frontend. Phases 1–3 (split `Messages`/`Runs` into indexed rows; migrate reads; contract) get their own plans after this lands.
- **The write handle is unchanged:** `globalDB` stays `mode=rwc`, `SetMaxOpenConns(1)`. Every write and every read-modify-write stays on it.
- **Correctness invariant (must not regress):** any decision that reads state and then writes based on it must run inside one `WithTx` on the write handle. Reads routed to the pool are pure reads only.
- **`readDB` must be opened *after* migrations run** (the write handle creates the DB file + WAL/`-shm`; a `mode=ro` connection cannot create them). `globalDB` stays open for process lifetime, which is what lets a `mode=ro` connection read a WAL database.
- **No new dependencies.** Go stdlib + the libraries already in `go.mod`.
- **Do not hand-edit generated files.** Phase 0 changes no generated types; `task generate` is not needed.
- **Verification commands:** `go build ./pkg/...` and `go test ./pkg/wstore/ -race -v`.

---

## File Structure

- **Modify `pkg/wstore/wstore_dbsetup.go`** — add `ReadDBMaxConns` const, `readDB` package var, `MakeReadDB`, `WithReadTx`, `WithReadTxRtn`, and the correctness-audit doc comment; open `readDB` in `InitWStore` after migration.
- **Modify `pkg/wstore/wstore_dbops.go`** — route the pure-read helpers from `WithTx`/`WithTxRtn` to `WithReadTx`/`WithReadTxRtn`. Writes untouched.
- **Create `pkg/wstore/wstore_readpool_test.go`** — infra tests, nesting-safety guard, the read-does-not-block-writer red→green test, and the `PostChannelMessageIf` serialization `-race` test.

The package's `TestMain` (`wstore_maintest_test.go`) already points the data dir at a temp dir and runs `InitWStore()`, so tests get a real migrated store with both handles open.

---

### Task 1: Read-only connection pool + `WithReadTx`/`WithReadTxRtn`

**Files:**
- Modify: `pkg/wstore/wstore_dbsetup.go`
- Test: `pkg/wstore/wstore_readpool_test.go` (create)

**Interfaces:**
- Consumes: `GetDBName()`, `InitWStore()`, `waveobj.ContextUpdates{Begin,Commit,Rollback}Tx`, `txwrap.WithTx`/`WithTxRtn` (all existing in `wstore_dbsetup.go`).
- Produces:
  - `readDB *sqlx.DB` (package var)
  - `MakeReadDB(ctx context.Context) (*sqlx.DB, error)`
  - `WithReadTx(ctx context.Context, fn func(tx *TxWrap) error) error`
  - `WithReadTxRtn[RT any](ctx context.Context, fn func(tx *TxWrap) (RT, error)) (RT, error)`
  - `const ReadDBMaxConns = 8`

- [ ] **Step 1: Write the failing tests**

Create `pkg/wstore/wstore_readpool_test.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wstore

import (
	"context"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// WithReadTxRtn returns data committed through the write handle.
func TestReadPoolReadsCommittedData(t *testing.T) {
	ctx := context.Background()
	ch, err := CreateChannel(ctx, "read-pool", "/p")
	if err != nil {
		t.Fatalf("create channel: %v", err)
	}
	name, err := WithReadTxRtn(ctx, func(tx *TxWrap) (string, error) {
		return tx.GetString("SELECT json_extract(data, '$.name') FROM db_channel WHERE oid = ?", ch.OID), nil
	})
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if name != "read-pool" {
		t.Fatalf("want name %q, got %q", "read-pool", name)
	}
}

// The read pool is opened mode=ro: a write attempted through it errors, catching a mis-audited
// "read" helper at runtime instead of letting it silently bypass the write connection.
func TestReadPoolRejectsWrites(t *testing.T) {
	ctx := context.Background()
	err := WithReadTx(ctx, func(tx *TxWrap) error {
		tx.Exec("INSERT INTO db_channel (oid, version, data) VALUES (?, ?, ?)", "ro-test", 1, "{}")
		return tx.Err
	})
	if err == nil {
		t.Fatal("expected a write through the read-only pool to error, got nil")
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go test ./pkg/wstore/ -run 'TestReadPool' -v`
Expected: FAIL to compile — `undefined: WithReadTxRtn`, `undefined: WithReadTx`.

- [ ] **Step 3: Implement the read pool in `wstore_dbsetup.go`**

Add the constant and package var near the top (after `var globalDB *sqlx.DB` at line 26):

```go
// ReadDBMaxConns bounds the read-only pool. Reads are short SELECTs on a desktop-scale DB, so a
// small fixed pool is plenty; tune here if a reader-starvation symptom ever shows up.
const ReadDBMaxConns = 8

// readDB is a mode=ro pool serving pure top-level reads, so they do not queue behind the single
// write connection. Opened after migrations (a ro connection cannot create the DB/WAL files) and
// only usable while the writable globalDB stays open (required to read a WAL database read-only).
var readDB *sqlx.DB
```

Add `MakeReadDB` next to `MakeDB` (after line 57):

```go
func MakeReadDB(ctx context.Context) (*sqlx.DB, error) {
	dbName := GetDBName()
	rtn, err := sqlx.Open("sqlite3", fmt.Sprintf("file:%s?mode=ro&_busy_timeout=5000", dbName))
	if err != nil {
		return nil, err
	}
	rtn.DB.SetMaxOpenConns(ReadDBMaxConns)
	return rtn, nil
}
```

Open `readDB` in `InitWStore`, after the successful `migrateutil.Migrate(...)` call (after line 39, before the `log.Printf`):

```go
	readDB, err = MakeReadDB(ctx)
	if err != nil {
		return err
	}
```

Add the wrappers and the audit comment after `WithTxRtn` (after line 81):

```go
// --- Read pool ---------------------------------------------------------------------------------
//
// CORRECTNESS AUDIT (Phase 0). The single write connection only ever protected correctness where a
// read and a dependent write span what would otherwise be two connections. Every such site does its
// read AND its write inside ONE WithTx on the write handle, so the read pool cannot regress it:
//
//   - PostChannelMessageIf (wstore_channel.go)  cond-check + append in one WithTx        -> safe
//   - DBUpdateFn / DBUpdateFnErr (wstore_dbops.go)  DBMustGet + DBUpdate in one WithTx    -> safe
//   - run-state transitions (wshserver_runs.go)  read + mutate in one nested WithTx       -> safe
//
// KNOWN, NOT FIXED HERE: the double-spawn guard (check len(WorkerOrefs) in one call, persist in a
// later call — see docs/deferred.md) is a pre-existing cross-transaction TOCTOU. The single
// connection only narrowed its window; it never closed it. The read pool may widen the window. The
// real fix (fold spawn+attach into one write tx) is a separate open item, out of scope for Phase 0.

// WithReadTx runs fn against the read-only pool. Pure reads only; a write errors (mode=ro). If ctx
// already carries a TxWrap (a read nested inside a write), txwrap reuses that transaction and this
// pool is bypassed — nested reads stay on the write connection and see its uncommitted state.
func WithReadTx(ctx context.Context, fn func(tx *TxWrap) error) (rtnErr error) {
	waveobj.ContextUpdatesBeginTx(ctx)
	defer func() {
		if rtnErr != nil {
			waveobj.ContextUpdatesRollbackTx(ctx)
		} else {
			waveobj.ContextUpdatesCommitTx(ctx)
		}
	}()
	return txwrap.WithTx(ctx, readDB, fn)
}

func WithReadTxRtn[RT any](ctx context.Context, fn func(tx *TxWrap) (RT, error)) (rtnVal RT, rtnErr error) {
	waveobj.ContextUpdatesBeginTx(ctx)
	defer func() {
		if rtnErr != nil {
			waveobj.ContextUpdatesRollbackTx(ctx)
		} else {
			waveobj.ContextUpdatesCommitTx(ctx)
		}
	}()
	return txwrap.WithTxRtn(ctx, readDB, fn)
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `go test ./pkg/wstore/ -run 'TestReadPool' -v`
Expected: PASS (`TestReadPoolReadsCommittedData`, `TestReadPoolRejectsWrites`).

- [ ] **Step 5: Commit** (fold the spec + this plan into the first implementation commit — no docs-only commit, per the repo git workflow)

```bash
git add pkg/wstore/wstore_dbsetup.go pkg/wstore/wstore_readpool_test.go \
  docs/superpowers/specs/2026-07-21-channel-data-model-scaling-design.md \
  docs/superpowers/plans/2026-07-21-channel-scaling-phase0-read-pool.md
git commit -m "feat(wstore): add read-only connection pool + WithReadTx wrappers"
```

---

### Task 2: Route pure-read helpers to the pool (red → green)

**Files:**
- Modify: `pkg/wstore/wstore_dbops.go`
- Test: `pkg/wstore/wstore_readpool_test.go` (add cases)

**Interfaces:**
- Consumes: `WithReadTx`, `WithReadTxRtn` (Task 1); `WithTx` (unchanged, for writes).
- Produces: no new symbols — the read helpers keep their signatures; only their transaction wrapper changes.

The pure-read helpers to convert (all currently `WithTxRtn`, except `DBGetWSCounts` which is `WithTx`): `DBGetCount`, `DBGetWSCounts`, `DBGetBlockViewCounts`, `DBGetSingletonByType`, `DBExistsORef`, `DBGetORef`, `dbSelectOIDs`, `DBSelectORefs`, `DBGetAllOIDsByType`, `DBGetAllObjsByType`, `DBResolveEasyOID`, `DBFindTabForBlockId`, `DBFindWorkspaceForTabId`, `DBFindWindowForWorkspaceId`. Leave the writers on `WithTx`: `DBInsert`, `DBUpdate`, `DBUpdateFn`, `DBUpdateFnErr`, `DBDelete`. (`DBGetSingleton`, `DBGet`, `DBMustGet`, `DBSelectMap` delegate to converted helpers and need no change.)

- [ ] **Step 1: Write the failing test + the nesting-safety guard**

Add to `pkg/wstore/wstore_readpool_test.go` (add `"sync"`, `"sync/atomic"`, `"time"`, and `"github.com/google/uuid"` to the import block):

```go
// A top-level read must complete promptly while a writer holds the single write connection, instead
// of queueing behind it. Before the read helpers move to the pool this FAILS (the read blocks on the
// one write conn); after, it passes (the read uses the separate ro pool + WAL snapshot).
func TestReadsDoNotBlockBehindWriter(t *testing.T) {
	ctx := context.Background()
	ch, err := CreateChannel(ctx, "no-block", "/p")
	if err != nil {
		t.Fatalf("create channel: %v", err)
	}
	writeHeld := make(chan struct{})
	writeRelease := make(chan struct{})
	go func() {
		_ = WithTx(ctx, func(tx *TxWrap) error {
			close(writeHeld)
			<-writeRelease // hold the single write connection open
			return nil
		})
	}()
	<-writeHeld

	done := make(chan error, 1)
	go func() {
		_, e := DBMustGet[*waveobj.Channel](ctx, ch.OID)
		done <- e
	}()
	select {
	case e := <-done:
		close(writeRelease)
		if e != nil {
			t.Fatalf("read failed: %v", e)
		}
	case <-time.After(2 * time.Second):
		close(writeRelease)
		t.Fatal("read blocked behind the held write transaction")
	}
}

// A read that reuses an enclosing write tx (called with tx.Context()) must see that tx's uncommitted
// row — proving nested reads stay on the write connection and are NOT diverted to the ro pool (which
// could not see uncommitted data). Guards the txwrap-reuse assumption the whole phase rests on.
func TestNestedReadReusesWriteTx(t *testing.T) {
	ctx := context.Background()
	oid := uuid.NewString()
	err := WithTx(ctx, func(tx *TxWrap) error {
		ch := &waveobj.Channel{OID: oid, Name: "nested", Meta: waveobj.MetaMapType{}}
		if e := DBInsert(tx.Context(), ch); e != nil {
			return e
		}
		got, e := DBMustGet[*waveobj.Channel](tx.Context(), oid)
		if e != nil {
			return e
		}
		if got.Name != "nested" {
			t.Errorf("nested read did not see the uncommitted row (name=%q)", got.Name)
		}
		return nil
	})
	if err != nil {
		t.Fatalf("tx failed: %v", err)
	}
}
```

- [ ] **Step 2: Run to verify the blocking test fails**

Run: `go test ./pkg/wstore/ -run 'TestReadsDoNotBlockBehindWriter' -v`
Expected: FAIL — `read blocked behind the held write transaction` (reads still use `globalDB`, whose single connection is held by the writer). `TestNestedReadReusesWriteTx` already passes.

- [ ] **Step 3: Convert the read helpers**

In `pkg/wstore/wstore_dbops.go`, for each read helper listed above, change its transaction wrapper:
- `WithTxRtn(ctx, ...)` → `WithReadTxRtn(ctx, ...)`
- `DBGetWSCounts` only: `WithTx(ctx, ...)` → `WithReadTx(ctx, ...)`

Example — `DBGetORef` (line 151) becomes:

```go
func DBGetORef(ctx context.Context, oref waveobj.ORef) (waveobj.WaveObj, error) {
	return WithReadTxRtn(ctx, func(tx *TxWrap) (waveobj.WaveObj, error) {
		table := tableNameFromOType(oref.OType)
		query := fmt.Sprintf("SELECT oid, version, data FROM %s WHERE oid = ?", table)
		var row idDataType
		found := tx.Get(&row, query, oref.OID)
		if !found {
			return nil, nil
		}
		rtn, err := waveobj.FromJson(row.Data)
		if err != nil {
			return rtn, err
		}
		waveobj.SetVersion(rtn, row.Version)
		return rtn, nil
	})
}
```

Apply the identical wrapper swap to the other listed read helpers. Do **not** touch `DBInsert`, `DBUpdate`, `DBUpdateFn`, `DBUpdateFnErr`, `DBDelete`. After editing, confirm no writer was converted:

Run: `grep -nE 'WithReadTx' pkg/wstore/wstore_dbops.go`
Expected: matches only the read helpers above; none inside `DBInsert`/`DBUpdate*`/`DBDelete`.

- [ ] **Step 4: Run tests + build to verify green**

Run: `go test ./pkg/wstore/ -v`
Expected: PASS — `TestReadsDoNotBlockBehindWriter` now passes; all pre-existing wstore tests (channel, radarreport) still pass.

Run: `go build ./pkg/...`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add pkg/wstore/wstore_dbops.go pkg/wstore/wstore_readpool_test.go
git commit -m "perf(wstore): route pure reads to the read-only pool"
```

---

### Task 3: `PostChannelMessageIf` serialization guard under `-race`

**Files:**
- Test: `pkg/wstore/wstore_readpool_test.go` (add case)

**Interfaces:**
- Consumes: `CreateChannel`, `PostChannelMessageIf`, `NewChannelMessage`, `DBMustGet` (all existing).
- Produces: no new symbols — a regression guard only.

- [ ] **Step 1: Write the invariant test**

Add to `pkg/wstore/wstore_readpool_test.go`:

```go
// The A3 correctness invariant: PostChannelMessageIf's cond-check + append run in one WithTx on the
// write handle, so concurrent posters still serialize even with the read pool present. With a cond
// of "only if empty", exactly one of N racing posters may post. Run under -race.
func TestPostChannelMessageIfSerializesUnderRace(t *testing.T) {
	ctx := context.Background()
	ch, err := CreateChannel(ctx, "serialize", "/p")
	if err != nil {
		t.Fatalf("create channel: %v", err)
	}
	var wg sync.WaitGroup
	var posted int32
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			msg := NewChannelMessage("human", "you", "only-one", "", int64(n))
			ok, e := PostChannelMessageIf(ctx, ch.OID, msg, func(c *waveobj.Channel) bool {
				return len(c.Messages) == 0
			})
			if e == nil && ok {
				atomic.AddInt32(&posted, 1)
			}
		}(i)
	}
	wg.Wait()

	if posted != 1 {
		t.Fatalf("want exactly 1 successful post (serialized), got %d", posted)
	}
	got, err := DBMustGet[*waveobj.Channel](ctx, ch.OID)
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	if len(got.Messages) != 1 {
		t.Fatalf("want 1 message persisted, got %d", len(got.Messages))
	}
}
```

- [ ] **Step 2: Run under `-race` to verify it passes**

Run: `go test ./pkg/wstore/ -run 'TestPostChannelMessageIfSerializesUnderRace' -race -v`
Expected: PASS, and no `DATA RACE` report. (If `posted != 1`, the cond+append is no longer serialized on the write handle — a real regression to investigate, not a flaky test.)

- [ ] **Step 3: Full package race pass**

Run: `go test ./pkg/wstore/ -race -v`
Expected: PASS across the whole package with no data races.

- [ ] **Step 4: Commit**

```bash
git add pkg/wstore/wstore_readpool_test.go
git commit -m "test(wstore): guard PostChannelMessageIf serialization under -race"
```

---

## Self-Review

**1. Spec coverage (Phase 0 slice of the design doc §3):**
- Two handles (write `globalDB` unchanged; new `readDB` `mode=ro`) — Task 1. ✅
- Explicit `WithReadTx`/`WithReadTxRtn` boundary — Task 1. ✅
- Pure reads routed to the pool; read-modify-write stays on the write handle — Task 2 (+ the writer-exclusion grep). ✅
- Correctness-audit table enumerating read-then-write sites — doc comment in Task 1, Step 3. ✅
- Double-spawn TOCTOU noted, not fixed — audit comment. ✅
- `go test -race` hammering concurrent posts/reads asserting the `PostChannelMessageIf` invariant — Task 3. ✅
- Immediate latency relief, reversible by routing reads back — the wrapper swap in Task 2 is the single reversible seam. ✅

**2. Placeholder scan:** No TBD/TODO/"handle errors appropriately". Every code step shows complete code; every run step shows the exact command and expected result. ✅

**3. Type consistency:** `WithReadTx`/`WithReadTxRtn` signatures match `WithTx`/`WithTxRtn` (only the handle differs). `readDB *sqlx.DB`, `ReadDBMaxConns` const, `MakeReadDB` used consistently across Task 1. Read helpers keep their existing exported signatures — callers unaffected. ✅

**Verified assumptions:** `txwrap.WithTx` reuses an in-context `*TxWrap` and ignores the passed `db` (`txwrap.go:60-98`) → nested-read safety. `ContextUpdatesBeginTx` is a no-op when ctx carries no update context (`ctxupdate.go:87-95`) → the wrappers are safe for background-ctx reads. WAL is enabled on the file (`wstore_dbsetup.go:51`) and `globalDB` stays open process-long → `mode=ro` reads work. `SetMaxOpenConns(1)` on the write handle is what makes the red test's held-write block a concurrent `globalDB` read.

## Notes for later phases (not in this plan)

- **Phase 1 (expand):** add `db_run` + `db_channelmessage` tables + expression indexes on `json_extract(data,'$.channeloid')` (next migration is `000014_*`; run `task build:backend --force` after adding `.sql`). Introduce `OType_Run`/`OType_ChannelMessage`, dual-write, Go startup backfill, stamp `run:`/`channel:` oref on worker-tab meta.
- **Phase 2 (migrate reads):** point hot-path lookups + FE at the indexed rows / tab-meta; add `GetChannelMessages`/`GetChannelRuns` RPCs; FE assembles from message-list + run-list + per-object WOS subscriptions.
- **Phase 3 (contract):** stop embedding `Messages`/`Runs` in the channel blob; drop the arrays. The A1 write/broadcast payoff lands here.
