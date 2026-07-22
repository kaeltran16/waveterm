# Channel Scaling — Phase 1: Expand — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Promote `Run` and `ChannelMessage` out of the `Channel` blob into their own indexed object rows (`db_run`, `db_channelmessage`), writing them alongside the existing embedded arrays (dual-write), so the rows exist and are backfilled but nothing reads them yet — a fully reversible expand step that de-risks the later read cutover.

**Architecture:** `Run` and `ChannelMessage` become registered `waveobj.WaveObj` types (`OType_Run`, `OType_ChannelMessage`) with `OID`/`Version`/`Meta` plus a `ChannelOID` parent link. New migration `000014` adds their tables and expression indexes on `json_extract(data,'$.channeloid')`. The five channel-mutation helpers dual-write: they keep mutating the channel blob **and**, in the same write transaction, upsert the object's row — with the row write emitting **no** `waveobj:update` (nothing subscribes to `run:`/`channelmessage:` orefs until Phase 2, so a broadcast would be premature). A one-shot Go startup backfill unpacks existing channel blobs into rows idempotently, and stamps each existing worker tab's `Meta` with its owning `run:`/`channel:` oref (Design call 1). Reads and the frontend are untouched.

**Tech Stack:** Go, `github.com/jmoiron/sqlx`, `github.com/sawka/txwrap`, mattn `sqlite3` (WAL + JSON1), SQLite expression indexes, `task generate` (Go→TS/Go codegen), standard `testing` with `-race`.

## Global Constraints

- **This is Phase 1 (Expand) of `docs/superpowers/specs/2026-07-21-channel-data-model-scaling-design.md`.** Phase 0 (read pool) shipped (`6248d04f`). Phase 1 adds tables + dual-write + backfill; **nothing reads the new rows and the frontend does not change.** Phases 2 (migrate reads) and 3 (contract/drop arrays) get their own plans.
- **Invisible + reversible:** after Phase 1 the app behaves identically. The rows are write-only scaffolding; dropping the two tables (migration `down`) fully reverts. Row writes must **not** emit `waveobj:update` events.
- **Dual-write is atomic:** each mutation writes the channel blob and the row inside **one** `WithTx` on the write handle. Never split them across transactions.
- **Correctness invariant from Phase 0 (must not regress):** any read-then-dependent-write stays inside one `WithTx` on the write handle; reads routed to the pool are pure reads only. `PostChannelMessageIf`'s cond-check + append + row-write must remain one write transaction.
- **Startup ordering (pinned by `TestReadPoolStartupOrdering`):** `InitWStore` must keep the sequence `MakeDB → Migrate → MakeReadDB`. The backfill runs **after** that sequence completes and uses its **own** timeout context (not `InitWStore`'s 2s ctx).
- **Identity:** `Run.ID` and `ChannelMessage.ID` are the object OIDs. On every write set `OID = ID` and `ChannelOID = <channel oid>`. Keep the existing `ID` (`json:"id"`) field — Phase 3 reconciles `id`/`oid` when the embedded arrays are dropped.
- **Never hand-edit generated files.** After the type changes run `task generate`; commit its output. Generated targets: `frontend/types/gotypes.d.ts`, `frontend/app/store/wshclientapi.ts`, `pkg/wshrpc/wshclient/wshclient.go`.
- **`task build:backend --force` after adding the `.sql`** (the Taskfile does not cache-bust on `db/**`). `go test ./pkg/wstore/` re-embeds the migration automatically via `go:embed`, so tests do **not** need `--force`.
- **No new dependencies.** Go stdlib + what is already in `go.mod`.
- **Verification commands:** `go build ./pkg/...`; `go test ./pkg/wstore/ -race -v`; `go test ./pkg/waveobj/ ./pkg/wshrpc/... -race`; `task generate` (no drift); `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (clean, exit 0 — bare `npx tsc` stack-overflows on this repo).

---

## File Structure

- **Create `db/migrations-wstore/000014_channelrows.up.sql`** — `db_run` + `db_channelmessage` tables and the two expression indexes.
- **Create `db/migrations-wstore/000014_channelrows.down.sql`** — drop the indexes + tables (reversibility).
- **Modify `pkg/waveobj/wtype.go`** — add `OType_Run`/`OType_ChannelMessage` consts + `ValidOTypes` entries; add `OID`/`Version`/`ChannelOID`/`Meta` fields to `ChannelMessage` and `Run`; add their `GetOType()` methods; add both to `AllWaveObjTypes()`.
- **Modify `pkg/wstore/wstore_dbops.go`** — add `dbUpsertObjTx` (no-broadcast, same-tx upsert helper).
- **Modify `pkg/wstore/wstore_channel.go`** — dual-write in `PostChannelMessage`, `PostChannelMessageIf`, `AppendRun`, `UpdateRun`, `UpdateChannelMessage`; add identity-stamp helpers; add worker-owner meta-key consts + `StampWorkerOwner`.
- **Create `pkg/wstore/wstore_channelrows.go`** — `BackfillChannelRows` (gated) + `backfillChannelRowsOnce` (core) + the MainServer one-shot marker helpers.
- **Modify `pkg/wstore/wstore_dbsetup.go`** — call `BackfillChannelRows()` from `InitWStore` after `MakeReadDB`.
- **Modify `pkg/wshrpc/wshserver/wshserver_runs.go`** — in `spawnRunWorkers`, stamp each freshly spawned worker tab via `wstore.StampWorkerOwner`.
- **Create `pkg/wstore/wstore_channelrows_test.go`** — table/index existence, type registration + round-trip, dual-write, backfill idempotency + marker, worker-owner stamping.

The `wstore` package `TestMain` (`wstore_maintest_test.go`) points the data dir at a temp dir and runs `InitWStore()`, so tests get a real migrated store with both DB handles open and the backfill already run against an empty store.

---

### Task 1: Migration `000014` — `db_run` + `db_channelmessage` tables + expression indexes

**Files:**
- Create: `db/migrations-wstore/000014_channelrows.up.sql`
- Create: `db/migrations-wstore/000014_channelrows.down.sql`
- Test: `pkg/wstore/wstore_channelrows_test.go` (create)

**Interfaces:**
- Consumes: the migration runner `migrateutil.Migrate` (already wired in `InitWStore`); `WithReadTxRtn`, `TxWrap` (existing).
- Produces: tables `db_run`, `db_channelmessage`; indexes `idx_run_channeloid`, `idx_channelmessage_channeloid_ts`.

- [ ] **Step 1: Write the failing test**

Create `pkg/wstore/wstore_channelrows_test.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wstore

import (
	"context"
	"testing"
)

// The 000014 migration must create both row tables and both expression indexes. TestMain already ran
// InitWStore (which runs the migration), so this reads the live schema out of sqlite_master.
func TestChannelRowSchemaExists(t *testing.T) {
	ctx := context.Background()
	objs := map[string]string{
		"db_run":                           "table",
		"db_channelmessage":                "table",
		"idx_run_channeloid":               "index",
		"idx_channelmessage_channeloid_ts": "index",
	}
	for name, kind := range objs {
		got, err := WithReadTxRtn(ctx, func(tx *TxWrap) (string, error) {
			return tx.GetString("SELECT name FROM sqlite_master WHERE type = ? AND name = ?", kind, name), nil
		})
		if err != nil {
			t.Fatalf("query sqlite_master for %s %q: %v", kind, name, err)
		}
		if got != name {
			t.Fatalf("expected %s %q to exist, sqlite_master returned %q", kind, name, got)
		}
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `go test ./pkg/wstore/ -run 'TestChannelRowSchemaExists' -v`
Expected: FAIL — the tables/indexes do not exist yet (`sqlite_master` returns `""` for `db_run`).

- [ ] **Step 3: Write the migration**

Create `db/migrations-wstore/000014_channelrows.up.sql`:

```sql
CREATE TABLE IF NOT EXISTS db_run (
    oid varchar(36) PRIMARY KEY,
    version int NOT NULL,
    data json NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_run_channeloid ON db_run (json_extract(data, '$.channeloid'));

CREATE TABLE IF NOT EXISTS db_channelmessage (
    oid varchar(36) PRIMARY KEY,
    version int NOT NULL,
    data json NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_channelmessage_channeloid_ts ON db_channelmessage (json_extract(data, '$.channeloid'), json_extract(data, '$.ts'));
```

Create `db/migrations-wstore/000014_channelrows.down.sql`:

```sql
DROP INDEX IF EXISTS idx_channelmessage_channeloid_ts;
DROP TABLE IF EXISTS db_channelmessage;
DROP INDEX IF EXISTS idx_run_channeloid;
DROP TABLE IF EXISTS db_run;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `go test ./pkg/wstore/ -run 'TestChannelRowSchemaExists' -v`
Expected: PASS. (`go test` re-embeds the migration FS automatically; no `--force` needed here.)

- [ ] **Step 5: Commit**

```bash
git add db/migrations-wstore/000014_channelrows.up.sql db/migrations-wstore/000014_channelrows.down.sql pkg/wstore/wstore_channelrows_test.go
git commit -m "feat(wstore): add db_run + db_channelmessage tables (channel scaling phase 1)"
```

---

### Task 2: Promote `Run` + `ChannelMessage` to registered WaveObj types

**Files:**
- Modify: `pkg/waveobj/wtype.go`
- Test: `pkg/wstore/wstore_channelrows_test.go` (add cases)
- Regenerated (do not hand-edit): `frontend/types/gotypes.d.ts`, `frontend/app/store/wshclientapi.ts`, `pkg/wshrpc/wshclient/wshclient.go`

**Interfaces:**
- Consumes: `waveobj.RegisterType` (via `wstore.go`'s `init()` loop over `AllWaveObjTypes()`), `waveobj.ToJson`/`FromJson`/`GetOID` (existing).
- Produces:
  - `const OType_Run = "run"`, `const OType_ChannelMessage = "channelmessage"`
  - `ChannelMessage` and `Run` each gain `OID string json:"oid"`, `Version int json:"version"`, `ChannelOID string json:"channeloid,omitempty"`, `Meta MetaMapType json:"meta"`
  - `func (*Run) GetOType() string`, `func (*ChannelMessage) GetOType() string`
  - both registered via `AllWaveObjTypes()`

**Why the fields are mandatory:** `waveobj.RegisterType` (`waveobj.go:135-163`) panics unless the struct has an `OID string` field tagged `json:"oid"`, a `Version int` field tagged `json:"version"`, and a `Meta MetaMapType` field. Adding these to `AllWaveObjTypes()` without the fields panics `wstore`'s package `init()` — so the fields and the registration land together in this task.

- [ ] **Step 1: Write the failing test**

Add to `pkg/wstore/wstore_channelrows_test.go` (add `"github.com/wavetermdev/waveterm/pkg/waveobj"` to the imports):

```go
// Run and ChannelMessage must be registered WaveObj types whose table names resolve and whose JSON
// round-trips through the waveobj machinery (this is what Task 3's dual-write and Task 4's backfill rely
// on). getOTypeGen/tableNameGen are the same helpers DBInsert/DBGetAllObjsByType use.
func TestRunAndChannelMessageRegistered(t *testing.T) {
	if got := getOTypeGen[*waveobj.Run](); got != waveobj.OType_Run {
		t.Fatalf("Run otype = %q, want %q", got, waveobj.OType_Run)
	}
	if got := getOTypeGen[*waveobj.ChannelMessage](); got != waveobj.OType_ChannelMessage {
		t.Fatalf("ChannelMessage otype = %q, want %q", got, waveobj.OType_ChannelMessage)
	}
	if got := tableNameGen[*waveobj.Run](); got != "db_run" {
		t.Fatalf("Run table = %q, want db_run", got)
	}
	if got := tableNameGen[*waveobj.ChannelMessage](); got != "db_channelmessage" {
		t.Fatalf("ChannelMessage table = %q, want db_channelmessage", got)
	}

	run := &waveobj.Run{OID: "run-abc", ID: "run-abc", ChannelOID: "ch-1", Goal: "do the thing"}
	data, err := waveobj.ToJson(run)
	if err != nil {
		t.Fatalf("ToJson(run): %v", err)
	}
	back, err := waveobj.FromJson(data)
	if err != nil {
		t.Fatalf("FromJson(run): %v", err)
	}
	gotRun, ok := back.(*waveobj.Run)
	if !ok {
		t.Fatalf("FromJson returned %T, want *waveobj.Run", back)
	}
	if gotRun.OID != "run-abc" || gotRun.ChannelOID != "ch-1" || gotRun.Goal != "do the thing" {
		t.Fatalf("run round-trip mismatch: %+v", gotRun)
	}
	if waveobj.GetOID(gotRun) != "run-abc" {
		t.Fatalf("GetOID(run) = %q, want run-abc", waveobj.GetOID(gotRun))
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `go test ./pkg/wstore/ -run 'TestRunAndChannelMessageRegistered' -v`
Expected: FAIL to compile — `undefined: waveobj.OType_Run`, `undefined: waveobj.OType_ChannelMessage`, and `waveobj.Run` has no field `OID`/`ChannelOID`.

- [ ] **Step 3: Add the OType constants**

In `pkg/waveobj/wtype.go`, extend the `const (...)` block (currently ending at `OType_RadarReport` on line 35):

```go
	OType_RadarReport = "radarreport"
	OType_Run            = "run"
	OType_ChannelMessage = "channelmessage"
```

And extend the `ValidOTypes` map (after `OType_RadarReport: true,`):

```go
	OType_RadarReport: true,
	OType_Run:            true,
	OType_ChannelMessage: true,
```

- [ ] **Step 4: Add the identity fields + `GetOType` to `ChannelMessage`**

Replace the `ChannelMessage` struct (currently `wtype.go:204-212`) with:

```go
type ChannelMessage struct {
	OID        string      `json:"oid"`
	Version    int         `json:"version"`
	ChannelOID string      `json:"channeloid,omitempty"` // parent channel oid; indexed for per-channel list queries (phase 2)
	ID         string      `json:"id"`                   // == OID; retained for embedded-blob consumers until phase 3 contract
	Kind       string      `json:"kind"`
	Author     string      `json:"author"`
	Text       string      `json:"text"`
	RefORef    string      `json:"reforef,omitempty"`
	Ts         int64       `json:"ts"`
	Data       string      `json:"data,omitempty"` // optional JSON payload for rich rendering (e.g. JarvisCardData)
	Meta       MetaMapType `json:"meta"`
}

func (*ChannelMessage) GetOType() string {
	return OType_ChannelMessage
}
```

- [ ] **Step 5: Add the identity fields + `GetOType` to `Run`**

In the `Run` struct (`wtype.go:235-254`), add the four identity fields at the top of the struct (immediately after the opening line) and keep every existing field unchanged:

```go
type Run struct {
	OID         string          `json:"oid"`
	Version     int             `json:"version"`
	ChannelOID  string          `json:"channeloid,omitempty"` // parent channel oid; indexed for per-channel run queries (phase 2)
	ID          string          `json:"id"`                   // == OID; retained for embedded-blob consumers until phase 3 contract
	Goal        string          `json:"goal"`
	// ... (all existing fields unchanged: PlaybookId, Mode, WorkspaceId, ProjectPath, BaseCommit,
	//      EndCommit, Principles, Status, Phases, RadarOrigin, CreatedTs, CompletedTs, Evidence,
	//      ParentLeadORef) ...
	Meta MetaMapType `json:"meta"`
}
```

Then add the method after the struct:

```go
func (*Run) GetOType() string {
	return OType_Run
}
```

(Leave the existing `Run` fields exactly as they are; only add `OID`/`Version`/`ChannelOID` before `Goal` and `Meta` at the end.)

- [ ] **Step 6: Register both types**

In `AllWaveObjTypes()` (`wtype.go:599-612`), add the two types to the returned slice:

```go
		reflect.TypeOf(&Job{}),
		reflect.TypeOf(&Run{}),
		reflect.TypeOf(&ChannelMessage{}),
	}
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `go test ./pkg/wstore/ -run 'TestRunAndChannelMessageRegistered' -v`
Expected: PASS. (If `wstore` init panics with "missing OID/Version/Meta field", a required field or json tag is wrong — fix the struct, do not touch `RegisterType`.)

- [ ] **Step 8: Regenerate bindings + typecheck**

Run: `task generate`
Then: `go build ./pkg/...` and `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Then: `go test ./pkg/tsgen/ -v` (the golden/coverage guard — a real failure now that the baseline is clean, see memory `tsgen-waveevent-test`).
Expected: `task generate` updates `gotypes.d.ts` (adds `oid`/`version`/`channeloid`/`meta` to `Run`/`ChannelMessage`), Go builds, tsc exits 0, tsgen tests pass. The FE uses a generic `makeORef(otype, oid)` (`frontend/app/store/wos.ts:51`) with no per-otype registry, so no hand-wiring is needed and the app is unaffected (nothing subscribes to the new orefs yet).

- [ ] **Step 9: Commit** (fold the spec into this commit — the design is already committed, so only stage regenerated files that changed)

```bash
git add pkg/waveobj/wtype.go pkg/wstore/wstore_channelrows_test.go frontend/types/gotypes.d.ts frontend/app/store/wshclientapi.ts pkg/wshrpc/wshclient/wshclient.go
git commit -m "feat(waveobj): promote Run + ChannelMessage to registered object types"
```

---

### Task 3: Dual-write — channel mutations also write the object row

**Files:**
- Modify: `pkg/wstore/wstore_dbops.go` (add `dbUpsertObjTx`)
- Modify: `pkg/wstore/wstore_channel.go` (dual-write in 5 helpers + stamp helpers)
- Test: `pkg/wstore/wstore_channelrows_test.go` (add cases)

**Interfaces:**
- Consumes: `WithTx`, `DBMustGet`, `DBUpdate`, `waveObjTableName`, `waveobj.ToJson`, `waveobj.GetOID` (existing).
- Produces:
  - `func dbUpsertObjTx(ctx context.Context, val waveobj.WaveObj) error` (no-broadcast upsert, reuses the in-context write tx)
  - `func stampMessageIdentity(channelId string, msg *waveobj.ChannelMessage)`
  - `func stampRunIdentity(channelId string, run *waveobj.Run)`
  - `PostChannelMessage`, `PostChannelMessageIf`, `AppendRun`, `UpdateRun`, `UpdateChannelMessage` now dual-write (signatures unchanged).

- [ ] **Step 1: Write the failing tests**

Add to `pkg/wstore/wstore_channelrows_test.go`:

```go
// PostChannelMessage must write the message into db_channelmessage (with oid = message id, channeloid =
// channel oid) IN ADDITION to appending it to the channel blob. The row carries no waveobj:update yet.
func TestPostChannelMessageDualWrites(t *testing.T) {
	ctx := context.Background()
	ch, err := CreateChannel(ctx, "dual-msg", "/p")
	if err != nil {
		t.Fatalf("create channel: %v", err)
	}
	msg := NewChannelMessage("human", "you", "hello", "", 100)
	if _, err := PostChannelMessage(ctx, ch.OID, msg); err != nil {
		t.Fatalf("post: %v", err)
	}
	gotChannelOID, err := WithReadTxRtn(ctx, func(tx *TxWrap) (string, error) {
		return tx.GetString("SELECT json_extract(data, '$.channeloid') FROM db_channelmessage WHERE oid = ?", msg.ID), nil
	})
	if err != nil {
		t.Fatalf("read row: %v", err)
	}
	if gotChannelOID != ch.OID {
		t.Fatalf("row channeloid = %q, want %q", gotChannelOID, ch.OID)
	}
	back, err := DBMustGet[*waveobj.Channel](ctx, ch.OID)
	if err != nil {
		t.Fatalf("read channel: %v", err)
	}
	if len(back.Messages) != 1 || back.Messages[0].ID != msg.ID {
		t.Fatalf("blob missing the message: %+v", back.Messages)
	}
}

// AppendRun + UpdateRun must keep the db_run row in sync with the embedded run.
func TestAppendAndUpdateRunDualWrite(t *testing.T) {
	ctx := context.Background()
	ch, err := CreateChannel(ctx, "dual-run", "/p")
	if err != nil {
		t.Fatalf("create channel: %v", err)
	}
	run := waveobj.Run{ID: "run-1", Goal: "g", Status: "planning", CreatedTs: 1}
	if err := AppendRun(ctx, ch.OID, run); err != nil {
		t.Fatalf("append run: %v", err)
	}
	status, err := WithReadTxRtn(ctx, func(tx *TxWrap) (string, error) {
		return tx.GetString("SELECT json_extract(data, '$.status') FROM db_run WHERE oid = ?", "run-1"), nil
	})
	if err != nil || status != "planning" {
		t.Fatalf("row status after append = %q (err %v), want planning", status, err)
	}
	if err := UpdateRun(ctx, ch.OID, "run-1", func(r *waveobj.Run) error {
		r.Status = "done"
		return nil
	}); err != nil {
		t.Fatalf("update run: %v", err)
	}
	status, err = WithReadTxRtn(ctx, func(tx *TxWrap) (string, error) {
		return tx.GetString("SELECT json_extract(data, '$.status') FROM db_run WHERE oid = ?", "run-1"), nil
	})
	if err != nil || status != "done" {
		t.Fatalf("row status after update = %q (err %v), want done", status, err)
	}
}
```

- [ ] **Step 2: Run to verify they fail**

Run: `go test ./pkg/wstore/ -run 'TestPostChannelMessageDualWrites|TestAppendAndUpdateRunDualWrite' -v`
Expected: FAIL — `no such column`/empty result: the rows are never written (only the blob is).

- [ ] **Step 3: Add the no-broadcast upsert helper**

In `pkg/wstore/wstore_dbops.go`, add after `DBInsert` (after line ~361):

```go
// dbUpsertObjTx writes val as a row WITHOUT emitting a waveobj:update. Phase-1 channel dual-write uses
// it to mirror the message/run still embedded in the channel blob; nothing subscribes to run:/
// channelmessage: orefs until Phase 2, so a broadcast would be premature. Call with a tx.Context()
// already inside a WithTx on the write handle — txwrap reuses that transaction, keeping the row write
// atomic with the blob write.
func dbUpsertObjTx(ctx context.Context, val waveobj.WaveObj) error {
	oid := waveobj.GetOID(val)
	if oid == "" {
		return fmt.Errorf("cannot upsert %T with empty oid", val)
	}
	jsonData, err := waveobj.ToJson(val)
	if err != nil {
		return err
	}
	return WithTx(ctx, func(tx *TxWrap) error {
		table := waveObjTableName(val)
		query := fmt.Sprintf(
			"INSERT INTO %s (oid, version, data) VALUES (?, 1, ?) "+
				"ON CONFLICT(oid) DO UPDATE SET data = excluded.data, version = version + 1",
			table)
		tx.Exec(query, oid, jsonData)
		return nil
	})
}
```

- [ ] **Step 4: Add the identity-stamp helpers**

In `pkg/wstore/wstore_channel.go`, add near the top (after `NewChannelMessage`):

```go
// stampMessageIdentity sets the object identity and parent link on a message before it is written as a
// row (and, since it mutates the pointer before the blob append, on the embedded copy too — keeping the
// two representations identical during dual-write). OID == the message's own UUID.
func stampMessageIdentity(channelId string, msg *waveobj.ChannelMessage) {
	msg.OID = msg.ID
	msg.ChannelOID = channelId
}

// stampRunIdentity does the same for a run.
func stampRunIdentity(channelId string, run *waveobj.Run) {
	run.OID = run.ID
	run.ChannelOID = channelId
}
```

- [ ] **Step 5: Dual-write in `PostChannelMessage`**

Replace `PostChannelMessage` (`wstore_channel.go:78-87`) with:

```go
func PostChannelMessage(ctx context.Context, channelId string, msg waveobj.ChannelMessage) (*waveobj.ChannelMessage, error) {
	stampMessageIdentity(channelId, &msg)
	err := WithTx(ctx, func(tx *TxWrap) error {
		ch, err := DBMustGet[*waveobj.Channel](tx.Context(), channelId)
		if err != nil {
			return err
		}
		appendChannelMessage(ch, msg)
		if err := DBUpdate(tx.Context(), ch); err != nil {
			return err
		}
		return dbUpsertObjTx(tx.Context(), &msg)
	})
	if err != nil {
		return nil, err
	}
	return &msg, nil
}
```

- [ ] **Step 6: Dual-write in `PostChannelMessageIf`**

Replace the body of `PostChannelMessageIf` (`wstore_channel.go:93-108`) — keep the cond semantics, add the stamp + row write inside the existing `WithTx`:

```go
func PostChannelMessageIf(ctx context.Context, channelId string, msg waveobj.ChannelMessage, cond func(*waveobj.Channel) bool) (bool, error) {
	var posted bool
	err := WithTx(ctx, func(tx *TxWrap) error {
		ch, err := DBMustGet[*waveobj.Channel](tx.Context(), channelId)
		if err != nil {
			return err
		}
		if !cond(ch) {
			return nil
		}
		stampMessageIdentity(channelId, &msg)
		appendChannelMessage(ch, msg)
		posted = true
		if err := DBUpdate(tx.Context(), ch); err != nil {
			return err
		}
		return dbUpsertObjTx(tx.Context(), &msg)
	})
	return posted, err
}
```

- [ ] **Step 7: Dual-write in `AppendRun` and `UpdateRun`**

Replace `AppendRun` (`wstore_channel.go:115-120`) and `UpdateRun` (`wstore_channel.go:133-137`) with:

```go
// AppendRun appends a run to the channel and persists it (blob + db_run row).
func AppendRun(ctx context.Context, channelId string, run waveobj.Run) error {
	stampRunIdentity(channelId, &run)
	return WithTx(ctx, func(tx *TxWrap) error {
		ch, err := DBMustGet[*waveobj.Channel](tx.Context(), channelId)
		if err != nil {
			return err
		}
		appendRunIn(ch, run)
		if err := DBUpdate(tx.Context(), ch); err != nil {
			return err
		}
		return dbUpsertObjTx(tx.Context(), &run)
	})
}

// UpdateRun applies fn to the identified run and persists the channel (blob + db_run row).
func UpdateRun(ctx context.Context, channelId, runId string, fn func(*waveobj.Run) error) error {
	return WithTx(ctx, func(tx *TxWrap) error {
		ch, err := DBMustGet[*waveobj.Channel](tx.Context(), channelId)
		if err != nil {
			return err
		}
		var updated *waveobj.Run
		for i := range ch.Runs {
			if ch.Runs[i].ID == runId {
				if err := fn(&ch.Runs[i]); err != nil {
					return err
				}
				updated = &ch.Runs[i]
				break
			}
		}
		if updated == nil {
			return fmt.Errorf("run %q not found in channel", runId)
		}
		stampRunIdentity(channelId, updated)
		if err := DBUpdate(tx.Context(), ch); err != nil {
			return err
		}
		return dbUpsertObjTx(tx.Context(), updated)
	})
}
```

(The `updateRunIn` helper is now unused by `UpdateRun`; leave it if other callers exist, otherwise delete it — `grep -n updateRunIn pkg/` to check.)

- [ ] **Step 8: Dual-write in `UpdateChannelMessage`**

Replace `UpdateChannelMessage` (`wstore_channel.go:72-76`) with:

```go
// UpdateChannelMessage applies fn to the identified message and persists the channel (blob + db_channelmessage row).
func UpdateChannelMessage(ctx context.Context, channelId, messageId string, fn func(*waveobj.ChannelMessage) error) error {
	return WithTx(ctx, func(tx *TxWrap) error {
		ch, err := DBMustGet[*waveobj.Channel](tx.Context(), channelId)
		if err != nil {
			return err
		}
		var updated *waveobj.ChannelMessage
		for i := range ch.Messages {
			if ch.Messages[i].ID == messageId {
				if err := fn(&ch.Messages[i]); err != nil {
					return err
				}
				updated = &ch.Messages[i]
				break
			}
		}
		if updated == nil {
			return fmt.Errorf("message %q not found in channel", messageId)
		}
		stampMessageIdentity(channelId, updated)
		if err := DBUpdate(tx.Context(), ch); err != nil {
			return err
		}
		return dbUpsertObjTx(tx.Context(), updated)
	})
}
```

(The `updateChannelMessageIn` helper is now unused by `UpdateChannelMessage`; `grep -n updateChannelMessageIn pkg/` and delete it if it has no other callers.)

- [ ] **Step 9: Run tests + build to verify green**

Run: `go test ./pkg/wstore/ -run 'TestPostChannelMessageDualWrites|TestAppendAndUpdateRunDualWrite' -v`
Expected: PASS.
Run: `go test ./pkg/wstore/ -v && go build ./pkg/...`
Expected: PASS — all pre-existing wstore tests (channel, radarreport, read-pool) still pass; build clean.

- [ ] **Step 10: Commit**

```bash
git add pkg/wstore/wstore_dbops.go pkg/wstore/wstore_channel.go pkg/wstore/wstore_channelrows_test.go
git commit -m "feat(wstore): dual-write channel messages + runs to indexed rows"
```

---

### Task 4: Startup backfill — unpack existing channel blobs into rows (idempotent, one-shot)

**Files:**
- Create: `pkg/wstore/wstore_channelrows.go`
- Modify: `pkg/wstore/wstore_dbsetup.go` (call the backfill from `InitWStore`)
- Test: `pkg/wstore/wstore_channelrows_test.go` (add cases)

**Interfaces:**
- Consumes: `GetChannels`, `WithTx`, `dbUpsertObjTx`, `stampMessageIdentity`, `stampRunIdentity`, `DBGetSingleton`/`DBInsert`/`DBUpdate` for the marker (existing).
- Produces:
  - `const MetaKey_ChannelRowsBackfilled = "channel:rowsbackfilled"`
  - `func BackfillChannelRows() error` (gated by the marker; own 30s ctx)
  - `func backfillChannelRowsOnce(ctx context.Context) error` (the un-gated core; idempotent)

- [ ] **Step 1: Write the failing tests**

Add to `pkg/wstore/wstore_channelrows_test.go`:

```go
// backfillChannelRowsOnce must unpack the messages/runs embedded in existing channel blobs into their
// rows, stamping oid/channeloid, and be safe to run twice (idempotent). The channel is seeded with a
// DIRECT DBInsert (no dual-write) to simulate legacy pre-Phase-1 data: blob populated, no rows.
func TestBackfillChannelRowsOnce(t *testing.T) {
	ctx := context.Background()
	legacy := &waveobj.Channel{
		OID:       "legacy-ch",
		Name:      "legacy",
		CreatedTs: 1,
		Meta:      waveobj.MetaMapType{},
		Messages: []waveobj.ChannelMessage{
			{ID: "m1", Kind: "human", Text: "hi", Ts: 10},
			{ID: "m2", Kind: "agent", Text: "yo", Ts: 20},
		},
		Runs: []waveobj.Run{
			{ID: "r1", Goal: "g1", Status: "done", CreatedTs: 5},
		},
	}
	if err := DBInsert(ctx, legacy); err != nil {
		t.Fatalf("seed legacy channel: %v", err)
	}

	if err := backfillChannelRowsOnce(ctx); err != nil {
		t.Fatalf("backfill: %v", err)
	}
	assertRowCount := func(table string, want int) {
		got, err := WithReadTxRtn(ctx, func(tx *TxWrap) (int, error) {
			return tx.GetInt("SELECT count(*) FROM "+table+" WHERE json_extract(data, '$.channeloid') = ?", "legacy-ch"), nil
		})
		if err != nil {
			t.Fatalf("count %s: %v", table, err)
		}
		if got != want {
			t.Fatalf("%s row count = %d, want %d", table, got, want)
		}
	}
	assertRowCount("db_channelmessage", 2)
	assertRowCount("db_run", 1)

	// Idempotent: a second pass adds nothing.
	if err := backfillChannelRowsOnce(ctx); err != nil {
		t.Fatalf("second backfill: %v", err)
	}
	assertRowCount("db_channelmessage", 2)
	assertRowCount("db_run", 1)
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `go test ./pkg/wstore/ -run 'TestBackfillChannelRowsOnce' -v`
Expected: FAIL to compile — `undefined: backfillChannelRowsOnce`.

- [ ] **Step 3: Implement the backfill**

Create `pkg/wstore/wstore_channelrows.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wstore

import (
	"context"
	"log"
	"time"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// MetaKey_ChannelRowsBackfilled marks (on the MainServer singleton) that the Phase-1 channel-blob →
// row backfill has completed, so it runs at most once per data dir.
const MetaKey_ChannelRowsBackfilled = "channel:rowsbackfilled"

// BackfillChannelRows runs the one-shot Phase-1 backfill: it unpacks messages/runs embedded in existing
// channel blobs into db_channelmessage/db_run rows and stamps worker-tab meta. Gated by a MainServer
// marker so it is skipped on every boot after the first. Uses its own timeout (not InitWStore's 2s ctx)
// because a large store can take longer than steady-state init.
func BackfillChannelRows() error {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	done, err := channelRowsBackfillDone(ctx)
	if err != nil {
		return err
	}
	if done {
		return nil
	}
	if err := backfillChannelRowsOnce(ctx); err != nil {
		return err
	}
	return markChannelRowsBackfilled(ctx)
}

// backfillChannelRowsOnce is the idempotent core: read every channel once, upsert each embedded message/
// run as a row (stamping identity + parent link), and stamp each existing worker tab's owner meta. Safe
// to call repeatedly — dbUpsertObjTx and StampWorkerOwner are both idempotent.
func backfillChannelRowsOnce(ctx context.Context) error {
	channels, err := GetChannels(ctx)
	if err != nil {
		return err
	}
	var msgs, runs int
	for _, ch := range channels {
		err := WithTx(ctx, func(tx *TxWrap) error {
			for i := range ch.Messages {
				m := ch.Messages[i]
				stampMessageIdentity(ch.OID, &m)
				if err := dbUpsertObjTx(tx.Context(), &m); err != nil {
					return err
				}
				msgs++
			}
			for i := range ch.Runs {
				r := ch.Runs[i]
				stampRunIdentity(ch.OID, &r)
				if err := dbUpsertObjTx(tx.Context(), &r); err != nil {
					return err
				}
				runs++
			}
			return nil
		})
		if err != nil {
			return err
		}
		// stamp worker tabs outside the channel's write tx (each is its own object update); best-effort.
		channelORef := waveobj.MakeORef(waveobj.OType_Channel, ch.OID).String()
		for i := range ch.Runs {
			runORef := waveobj.MakeORef(waveobj.OType_Run, ch.Runs[i].ID).String()
			for _, phase := range ch.Runs[i].Phases {
				for _, workerORef := range phase.WorkerOrefs {
					if serr := StampWorkerOwner(ctx, workerORef, runORef, channelORef); serr != nil {
						log.Printf("backfill: stamp worker %s: %v", workerORef, serr)
					}
				}
			}
		}
	}
	log.Printf("channel-rows backfill: %d messages, %d runs across %d channels\n", msgs, runs, len(channels))
	return nil
}

func channelRowsBackfillDone(ctx context.Context) (bool, error) {
	ms, err := DBGetSingleton[*waveobj.MainServer](ctx)
	if err != nil || ms == nil {
		// no MainServer yet (fresh store) → not backfilled
		return false, nil
	}
	return ms.Meta.GetBool(MetaKey_ChannelRowsBackfilled, false), nil
}

func markChannelRowsBackfilled(ctx context.Context) error {
	ms, err := DBGetSingleton[*waveobj.MainServer](ctx)
	if err != nil || ms == nil {
		// no MainServer row yet: the mark will be set by whoever creates it, and the backfill core is
		// idempotent, so a re-run on next boot is harmless. Skip marking rather than racing wcore's
		// lazy create.
		return nil
	}
	if ms.Meta == nil {
		ms.Meta = waveobj.MetaMapType{}
	}
	ms.Meta[MetaKey_ChannelRowsBackfilled] = true
	return DBUpdate(ctx, ms)
}
```

Note: `StampWorkerOwner` is defined in Task 5. Land Task 4 and Task 5 together, or stub `StampWorkerOwner` returning `nil` first — but the recommended order is to do Task 5's `StampWorkerOwner` definition before running Task 4's build. (The two tasks share `wstore_channel.go`/`wstore_channelrows.go`; commit Task 4's code once Task 5's helper compiles.)

- [ ] **Step 4: Wire the backfill into `InitWStore`**

In `pkg/wstore/wstore_dbsetup.go`, in `InitWStore`, after `readDB, err = MakeReadDB(ctx)` succeeds and before the final `log.Printf`, add:

```go
	if err := BackfillChannelRows(); err != nil {
		return err
	}
```

(Placed after `MakeReadDB` so both handles exist; it uses only the write handle, and its own 30s ctx — not the 2s `InitWStore` ctx. This preserves the `MakeDB → Migrate → MakeReadDB` ordering pinned by `TestReadPoolStartupOrdering`.)

- [ ] **Step 5: Run to verify green**

Run: `go test ./pkg/wstore/ -run 'TestBackfillChannelRowsOnce' -v`
Expected: PASS.
Run: `go test ./pkg/wstore/ -race -v && go build ./pkg/...`
Expected: PASS across the package with no data races; build clean.

- [ ] **Step 6: Commit**

```bash
git add pkg/wstore/wstore_channelrows.go pkg/wstore/wstore_dbsetup.go pkg/wstore/wstore_channelrows_test.go
git commit -m "feat(wstore): one-shot startup backfill of channel blobs into rows"
```

---

### Task 5: Stamp worker-tab meta with the owning run/channel oref (spawn + backfill)

**Files:**
- Modify: `pkg/wstore/wstore_channel.go` (add meta-key consts + `StampWorkerOwner`)
- Modify: `pkg/wshrpc/wshserver/wshserver_runs.go` (stamp at spawn)
- Test: `pkg/wstore/wstore_channelrows_test.go` (add case)

**Interfaces:**
- Consumes: `waveobj.ParseORef`, `waveobj.MakeORef`, `UpdateObjectMeta`, `DBMustGet` (existing).
- Produces:
  - `const MetaKey_JarvisRunORef = "jarvis:runoref"`, `const MetaKey_JarvisChannelORef = "jarvis:channeloref"`
  - `func StampWorkerOwner(ctx context.Context, workerTabORef, runORef, channelORef string) error`
  - `spawnRunWorkers` stamps each freshly spawned worker tab.

**Why:** Design call 1 — worker orefs live nested at `run.Phases[].WorkerOrefs[]` (array-in-array, not directly indexable). Stamping the owning `run:`/`channel:` oref onto the worker tab's `Meta` makes the Phase-2 worker→run lookup a direct field read (the hot paths already load that tab), avoiding a new index table.

- [ ] **Step 1: Write the failing test**

Add to `pkg/wstore/wstore_channelrows_test.go`:

```go
// StampWorkerOwner records the owning run/channel oref on a worker tab's meta so the Phase-2 lookup is a
// direct field read. Seed a tab, stamp it, read the meta back.
func TestStampWorkerOwner(t *testing.T) {
	ctx := context.Background()
	tab := &waveobj.Tab{OID: "wt-1", Name: "worker", Meta: waveobj.MetaMapType{}}
	if err := DBInsert(ctx, tab); err != nil {
		t.Fatalf("seed tab: %v", err)
	}
	tabORef := waveobj.MakeORef(waveobj.OType_Tab, "wt-1").String()
	runORef := waveobj.MakeORef(waveobj.OType_Run, "r-1").String()
	chORef := waveobj.MakeORef(waveobj.OType_Channel, "c-1").String()
	if err := StampWorkerOwner(ctx, tabORef, runORef, chORef); err != nil {
		t.Fatalf("stamp: %v", err)
	}
	got, err := DBMustGet[*waveobj.Tab](ctx, "wt-1")
	if err != nil {
		t.Fatalf("read tab: %v", err)
	}
	if got.Meta.GetString(MetaKey_JarvisRunORef, "") != runORef {
		t.Fatalf("run oref meta = %q, want %q", got.Meta.GetString(MetaKey_JarvisRunORef, ""), runORef)
	}
	if got.Meta.GetString(MetaKey_JarvisChannelORef, "") != chORef {
		t.Fatalf("channel oref meta = %q, want %q", got.Meta.GetString(MetaKey_JarvisChannelORef, ""), chORef)
	}
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `go test ./pkg/wstore/ -run 'TestStampWorkerOwner' -v`
Expected: FAIL to compile — `undefined: StampWorkerOwner`, `undefined: MetaKey_JarvisRunORef`.

- [ ] **Step 3: Implement the consts + `StampWorkerOwner`**

In `pkg/wstore/wstore_channel.go`, add near the other `MetaKey_*` consts (after `MetaKey_Archived`, line ~158):

```go
// MetaKey_JarvisRunORef / MetaKey_JarvisChannelORef stamp the owning run: and channel: oref onto a
// worker tab's meta at spawn, so the worker-oref → run lookup is a direct field read instead of a full
// channel scan (channel-scaling design call 1).
const MetaKey_JarvisRunORef = "jarvis:runoref"
const MetaKey_JarvisChannelORef = "jarvis:channeloref"

// StampWorkerOwner records the owning run/channel oref on a worker tab's meta. Best-effort: a worker
// oref that is not a tab, or a tab that no longer exists (worker closed), is returned as an error for
// the caller to log-and-continue; it never mutates unrelated state.
func StampWorkerOwner(ctx context.Context, workerTabORef, runORef, channelORef string) error {
	oref, err := waveobj.ParseORef(workerTabORef)
	if err != nil || oref.OType != waveobj.OType_Tab {
		return fmt.Errorf("bad worker oref %q: %w", workerTabORef, err)
	}
	meta := waveobj.MetaMapType{
		MetaKey_JarvisRunORef:     runORef,
		MetaKey_JarvisChannelORef: channelORef,
	}
	return UpdateObjectMeta(ctx, oref, meta, false)
}
```

(`UpdateObjectMeta` lives in `pkg/wstore/wstore.go`; `fmt` and `waveobj` are already imported in `wstore_channel.go`.)

- [ ] **Step 4: Run to verify green (unit)**

Run: `go test ./pkg/wstore/ -run 'TestStampWorkerOwner' -v`
Expected: PASS.

- [ ] **Step 5: Stamp at spawn time**

In `pkg/wshrpc/wshserver/wshserver_runs.go`, inside `spawnRunWorkers`, after the `wstore.UpdateRun(...)` block that appends `WorkerOrefs` (after line ~109, before `wps.Broker.SendUpdateEvents`), stamp each spawned tab:

```go
	channelORef := waveobj.MakeORef(waveobj.OType_Channel, channelId).String()
	runORef := waveobj.MakeORef(waveobj.OType_Run, runId).String()
	for _, oref := range spawned {
		if serr := wstore.StampWorkerOwner(ctx, oref, runORef, channelORef); serr != nil {
			log.Printf("spawnRunWorkers: stamp worker %s: %v", oref, serr)
		}
	}
```

(`spawned` is the `map[int]string` returned by `jarvis.EnsureWorkers` — ranging it yields each worker tab oref. `log`, `waveobj`, and `wstore` are already imported in this file.)

- [ ] **Step 6: Build + full package tests**

Run: `go build ./pkg/... && go test ./pkg/wstore/ -race -v && go test ./pkg/wshrpc/wshserver/ -race`
Expected: PASS — build clean, no data races, existing run/spawn tests still pass. (Task 4's `backfillChannelRowsOnce` now compiles against the real `StampWorkerOwner`.)

- [ ] **Step 7: Commit**

```bash
git add pkg/wstore/wstore_channel.go pkg/wshrpc/wshserver/wshserver_runs.go pkg/wstore/wstore_channelrows_test.go
git commit -m "feat(jarvis): stamp owning run/channel oref onto worker tabs"
```

---

## Integration verification (after all tasks)

- [ ] **Backend build + race suite:** `task build:backend --force` (embeds the new migration for the running app), then `go test ./pkg/... -race`. Expected: clean.
- [ ] **Codegen drift:** `task generate` then `git status` — no unstaged changes to generated files (all committed in Task 2). tsc: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` exits 0.
- [ ] **Invisibility spot-check on the live dev app (CDP):** with `task dev` running (headless-safe: `tail -f /dev/null | task dev`), post a message and start a run in a channel; confirm the cockpit renders identically to pre-Phase-1 (no new UI, no console errors) via `node scripts/cdp-shot.mjs` or `task verify:ui`. The rows are being written but nothing reads them.
- [ ] **Row/blob parity (manual, on a populated dev store):** after posting messages and running a run, `SELECT count(*) FROM db_channelmessage` and `db_run` match the counts embedded in the channel blob; the backfill marker is set on the MainServer object (second boot logs no backfill).

---

## Self-Review

**1. Spec coverage (design §2 Phase 1 + §1 target model + Design call 1):**
- Add `db_run` + `db_channelmessage` tables + expression indexes on `json_extract(data,'$.channeloid')` — Task 1. ✅
- Introduce `OType_Run` / `OType_ChannelMessage` — Task 2. ✅
- `Run.ID` / `ChannelMessage.ID` become object OIDs — Task 2 (fields) + Task 3 (`OID = ID` on write). ✅
- Dual-write: mutations keep embedding in the blob **and** write the row — Task 3 (all 5 mutation helpers). ✅
- Delta broadcast for free / no premature broadcast — `dbUpsertObjTx` deliberately omits `ContextAddUpdate` (Phase 2 wires FE subscriptions). ✅
- Backfill existing blobs → rows, idempotent, one-shot marker — Task 4. ✅
- Stamp `run:`/`channel:` oref onto worker-tab meta + backfill (Design call 1) — Task 5 (spawn) + Task 4 (`backfillChannelRowsOnce` stamps existing workers). ✅
- Nothing reads the rows; FE unchanged; reversible (drop tables) — no read-path or FE edits; `000014_channelrows.down.sql`. ✅
- Startup ordering `MakeDB → Migrate → MakeReadDB` preserved; backfill after, own ctx — Task 4 Step 4 (respects `TestReadPoolStartupOrdering`). ✅

**2. Placeholder scan:** No TBD/TODO/"handle errors appropriately". Every code step shows complete code; every run step shows the exact command + expected result. The one forward-reference (`StampWorkerOwner` used in Task 4, defined in Task 5) is called out explicitly with the ordering note. ✅

**3. Type consistency:** `dbUpsertObjTx`, `stampMessageIdentity`/`stampRunIdentity`, `StampWorkerOwner`, `BackfillChannelRows`/`backfillChannelRowsOnce`, `MetaKey_JarvisRunORef`/`MetaKey_JarvisChannelORef`/`MetaKey_ChannelRowsBackfilled` are named identically at definition and every call site. `OType_Run="run"`/`OType_ChannelMessage="channelmessage"` map to tables `db_run`/`db_channelmessage` (via `"db_"+otype`) consistent with the migration. `spawned` is `map[int]string` (matches `EnsureWorkers`). Field json tags (`oid`/`version`/`meta`) satisfy `RegisterType`'s exact-tag checks. ✅

**Verified assumptions:** `RegisterType` requires `OID`(`json:"oid"`)/`Version`(`json:"version"`)/`Meta`(`MetaMapType`) — `waveobj.go:135-163`. `AllWaveObjTypes()` drives both registration (`wstore.go:15-19`) and codegen (`tsgen.go:534`). Migration numbering: latest is `000013_radarreport`, next is `000014`. Table shape `(oid, version, data json)` — `000012_channel.up.sql`. `EnsureWorkers` returns `map[int]string` — `runexec.go:112`. Startup-migration + one-shot-marker precedent — `TryMigrateOldHistory` (`wstore_dboldmigration.go:83-108`, flag on the Client singleton). FE has no per-otype registry (`makeORef` is generic — `wos.ts:51`), so new object types are FE-invisible until Phase 2. `txwrap` reuses an in-context tx, so `dbUpsertObjTx`'s nested `WithTx` stays on the write connection and atomic with the blob write (relied on by Phase 0's `TestNestedReadReusesWriteTx`).
