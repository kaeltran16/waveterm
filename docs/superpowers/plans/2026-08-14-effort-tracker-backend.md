# Effort Tracker — Backend Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the Effort object (ordered chunks, statuses, owners, note trails, workrefs) with create/mutate/list/get/delete RPCs, a complete `wsh effort` CLI, the WorkState efforts leg with delta events, run↔chunk linking (RunEffortRef + auto-attach/detach), and the `wsh jarvis status` efforts line — the full backend, usable via CLI and briefing data.

**Architecture:** New registered `waveobj.Effort` type stored in wstore (migration 000016), mutated through one atomic op-union RPC (`EffortMutateCommand`) whose pure validation/apply logic lives in `pkg/jarvisstate/effortops.go` (testable without a DB). The ledger (`FetchWorkState`) gains an efforts leg and effort delta events. Work linking rides the same ops plus two small DB-backed helpers (`AttachRunToChunk`/`DetachRunFromChunk`). The wsh CLI is a thin cobra layer over the RPCs.

**Tech Stack:** Go (wavesrv, wstore SQLite/WAL, wshrpc codegen), cobra CLI, generated TS bindings (`task generate`).

## Global Constraints

- Run `task generate` after any wshrpc / waveobj type change. Never hand-edit `frontend/app/store/wshclientapi.ts`, `frontend/types/gotypes.d.ts`, `pkg/wshrpc/wshclient/wshclient.go`.
- Typecheck: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (bare `npx tsc` stack-overflows; baseline is clean).
- Backend tests from PowerShell: `$env:CGO_CFLAGS="-O2 -g -I$((Get-Location).Path -replace '\\','/')/pkg/jarvisembed/csrc"; go test ./pkg/...` (bare `go test` fails on sqlite-vec headers). Compile check: `task build:backend`.
- New waveobj type requires a SQL migration pair in `db/migrations-wstore/` — next number is `000016`.
- `RegisterType` requirements (waveobj.go): exact json tags `oid`/`version`, `Meta` typed `MetaMapType`, `GetOType()` on the struct.
- Chunk statuses: `pending | active | done | deferred | blocked | skipped`. Effort statuses: `active | paused | done | archived`.
- Chunk labels unique per effort; chunk refs accept exact label or 1-based index; ambiguity is a hard error (`EC-AMBIGUOUS-CHUNK`), unknown is `EC-UNKNOWN-CHUNK`.
- Error convention: `fmt.Errorf("EC-CODE: message")` (matches the existing EC-TIME style).
- Every mutation bumps `Version` + `UpdatedTs` and auto-stamps the affected trail. Only six kinds emit delta events: `effort-created`, `chunk-done`, `chunk-added`, `chunk-status`, `effort-status`, `effort-note`. Renames/moves/owner/remove/link are trail-only (recorded in notes, no delta event).
- No CAS: last-write-wins on concurrent mutations.
- Delete is real delete (guarded by `--force` / archived requirement in the CLI, and the last-chunk guard at the ops level).
- WorkRefs are **advisory, never causal**: nothing auto-ticks on detach; the tick is always an explicit human or agent decision.
- `attachWork`: kind ∈ {run, agent}; idempotent for the same kind+oref on the same chunk (refreshes Ts); `EC-REF-ALREADY-ATTACHED` when the same oref is already on a different chunk of the same effort.
- `detachWork`: chunk ref optional (omitted = remove from any chunk); absent ref is a no-op.
- attach/detach are trail-only mutations (note auto-stamp, no delta event).
- Comments explain why, not what. KISS — no speculative abstraction.

---

### Task 1: Effort model types + registration + migration

**Files:**
- Modify: `pkg/waveobj/wtype.go` (OType consts, ValidOTypes, struct types, GetOType, AllWaveObjTypes)
- Create: `db/migrations-wstore/000016_effort.up.sql`
- Create: `db/migrations-wstore/000016_effort.down.sql`

**Interfaces:**
- Consumes: existing waveobj conventions (OType const block ~line 30, ValidOTypes ~line 50, structs ~line 200+, AllWaveObjTypes ~line 622).
- Produces: `waveobj.Effort`, `waveobj.EffortChunk`, `waveobj.ChunkWorkRef`, `waveobj.EffortNote`, `waveobj.EffortEvent`, `waveobj.OType_Effort`, `(*Effort).GetOType()`. Used by every later task.

- [ ] **Step 1: Add the OType constants**

In `pkg/waveobj/wtype.go`, add to the OType const block (after `OType_JarvisConversation`):

```go
OType_Effort = "effort"
```

Add to the `ValidOTypes` map:

```go
OType_Effort:        true,
```

- [ ] **Step 2: Add the struct types**

In `pkg/waveobj/wtype.go`, after the `Run`/`RunPhase` types (after line ~330), add:

```go
// Effort is a Wave-owned tracker for work too big for one Run: ordered chunks with statuses,
// owners, an append-only note trail, and a lightweight event log that drives ledger delta events.
// The trail is the record; Events are the delta source — never the reverse.
type Effort struct {
	OID       string          `json:"oid"`
	Version   int             `json:"version"`
	Title     string          `json:"title"`
	Project   string          `json:"project,omitempty"`  // free string; "" = unscoped
	Ticket    string          `json:"ticket,omitempty"`
	Status    string          `json:"status"`             // active | paused | done | archived
	ParentOID string          `json:"parentoid,omitempty"`
	Chunks    []EffortChunk   `json:"chunks"`             // ordered; may be empty (agents create first, plan chunks after)
	Notes     []EffortNote    `json:"notes,omitempty"`
	Events    []EffortEvent   `json:"events,omitempty"`   // delta-source event log (six kinds)
	CreatedTs int64           `json:"createdts"`
	UpdatedTs int64           `json:"updatedts"`
	Meta      MetaMapType     `json:"meta"`
}

func (*Effort) GetOType() string { return OType_Effort }

type EffortChunk struct {
	Label     string         `json:"label"`              // unique within the effort; reference key
	Status    string         `json:"status"`             // pending | active | done | deferred | blocked | skipped
	Owner     string         `json:"owner,omitempty"`
	WorkRefs  []ChunkWorkRef `json:"workrefs,omitempty"` // runs/agent sessions currently working this chunk (populated by Task 9+)
	Notes     []EffortNote   `json:"notes,omitempty"`    // append-only trail
	UpdatedTs int64          `json:"updatedts"`
}

// ChunkWorkRef links live work to a chunk. Advisory, never causal: nothing auto-ticks on detach.
type ChunkWorkRef struct {
	Kind string `json:"kind"` // "run" | "agent"
	ORef string `json:"oref"` // "run:<oid>" | "agent:<tabid>"
	Ts   int64  `json:"ts"`
}

type EffortNote struct {
	Ts   int64  `json:"ts"`
	Text string `json:"text"`
}

type EffortEvent struct {
	Ts    int64  `json:"ts"`
	Kind  string `json:"kind"`  // effort-created | chunk-done | chunk-added | chunk-status | effort-status | effort-note
	Label string `json:"label,omitempty"` // chunk label for chunk-level events, "" for effort-level
	Text  string `json:"text,omitempty"`
}
```

- [ ] **Step 3: Register the type**

In `pkg/waveobj/wtype.go`, in `AllWaveObjTypes()`, add `reflect.TypeOf(&Effort{})` after `reflect.TypeOf(&JarvisConvo{})`.

- [ ] **Step 4: Add the migration pair**

Create `db/migrations-wstore/000016_effort.up.sql` (copy the `db_jarvisconversation` shape):

```sql
CREATE TABLE IF NOT EXISTS db_effort (
    oid varchar(36) PRIMARY KEY,
    version int NOT NULL,
    data json NOT NULL
);
```

Create `db/migrations-wstore/000016_effort.down.sql`:

```sql
DROP TABLE IF EXISTS db_effort;
```

- [ ] **Step 5: Verify**

Run from PowerShell:

```powershell
$env:CGO_CFLAGS="-O2 -g -I$((Get-Location).Path -replace '\\','/')/pkg/jarvisembed/csrc"
go build ./pkg/waveobj/...
go vet ./pkg/waveobj/...
```

Expected: both succeed. (Migration execution is exercised by the wstore TestMain in Task 2.)

- [ ] **Step 6: Commit**

```bash
git add pkg/waveobj/wtype.go db/migrations-wstore/000016_effort.up.sql db/migrations-wstore/000016_effort.down.sql
git commit -m "feat(effort): waveobj Effort type + migration 000016"
```

---

### Task 2: wstore effort storage

**Files:**
- Create: `pkg/wstore/wstore_effort.go`
- Create: `pkg/wstore/wstore_effort_test.go`

**Interfaces:**
- Consumes: `waveobj.Effort` (Task 1), wstore DB helpers (`DBInsert`, `DBMustGet`, `DBGetAllObjsByType`, `DBUpdateFnErr`, `ErrNotFound` from `pkg/wstore/wstore_dbops.go`), `uuid.NewString()`.
- Produces: `wstore.CreateEffort(ctx, e *waveobj.Effort) error`, `wstore.GetEffort(ctx, oid string) (*waveobj.Effort, error)`, `wstore.GetAllEfforts(ctx) ([]*waveobj.Effort, error)`, `wstore.UpdateEffort(ctx, oid string, fn func(*waveobj.Effort) error) error`. Used by every later task.

- [ ] **Step 1: Write the failing tests**

Create `pkg/wstore/wstore_effort_test.go` (the package TestMain in `wstore_maintest_test.go` already points at a throwaway DB):

```go
package wstore

import (
	"context"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func TestEffortCreateGetRoundTrip(t *testing.T) {
	ctx := context.Background()
	e := &waveobj.Effort{Title: "Scenario gate clearance", Ticket: "SIEM-1662", Status: "active"}
	e.Chunks = []waveobj.EffortChunk{{Label: "Phase 1", Status: "pending"}, {Label: "Phase 2", Status: "done"}}
	if err := CreateEffort(ctx, e); err != nil {
		t.Fatal(err)
	}
	got, err := GetEffort(ctx, e.OID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Title != "Scenario gate clearance" || len(got.Chunks) != 2 {
		t.Fatalf("round-trip mismatch: %+v", got)
	}
	if got.Version != 1 || got.CreatedTs == 0 || got.UpdatedTs == 0 || got.Status != "active" {
		t.Fatalf("defaults not set: %+v", got)
	}
	if got.OID == "" {
		t.Fatal("OID not assigned")
	}
}

func TestEffortGetAllSortedByUpdatedDesc(t *testing.T) {
	ctx := context.Background()
	old := &waveobj.Effort{Title: "older", Status: "active"}
	if err := CreateEffort(ctx, old); err != nil {
		t.Fatal(err)
	}
	old.UpdatedTs = 100
	if err := UpdateEffort(ctx, old.OID, func(e *waveobj.Effort) error { e.UpdatedTs = 100; return nil }); err != nil {
		t.Fatal(err)
	}
	recent := &waveobj.Effort{Title: "newer", Status: "active"}
	if err := CreateEffort(ctx, recent); err != nil {
		t.Fatal(err)
	}
	all, err := GetAllEfforts(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(all) < 2 || all[0].OID != recent.OID {
		t.Fatalf("expected newest-updated first, got %+v", all)
	}
}

func TestEffortGetNotFound(t *testing.T) {
	_, err := GetEffort(context.Background(), "00000000-0000-0000-0000-000000000000")
	if err != ErrNotFound {
		t.Fatalf("want ErrNotFound, got %v", err)
	}
}

func TestEffortUpdateFnBumpsVersion(t *testing.T) {
	ctx := context.Background()
	e := &waveobj.Effort{Title: "v", Status: "active"}
	if err := CreateEffort(ctx, e); err != nil {
		t.Fatal(err)
	}
	if err := UpdateEffort(ctx, e.OID, func(e *waveobj.Effort) error { e.Title = "v2"; return nil }); err != nil {
		t.Fatal(err)
	}
	got, err := GetEffort(ctx, e.OID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Version != 2 || got.Title != "v2" {
		t.Fatalf("version/title not updated: %+v", got)
	}
}

func TestEffortUpdateFnErrorRollsBack(t *testing.T) {
	ctx := context.Background()
	e := &waveobj.Effort{Title: "v", Status: "active"}
	if err := CreateEffort(ctx, e); err != nil {
		t.Fatal(err)
	}
	err := UpdateEffort(ctx, e.OID, func(e *waveobj.Effort) error { e.Title = "bad"; return context.DeadlineExceeded })
	if err == nil {
		t.Fatal("want error")
	}
	got, err := GetEffort(ctx, e.OID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Title != "v" || got.Version != 1 {
		t.Fatalf("rollback failed: %+v", got)
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go test ./pkg/wstore/ -run TestEffort -count=1`
Expected: FAIL — undefined `CreateEffort`/`GetEffort`/`GetAllEfforts`/`UpdateEffort`.

- [ ] **Step 3: Implement the storage layer**

Create `pkg/wstore/wstore_effort.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wstore

import (
	"context"
	"sort"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func CreateEffort(ctx context.Context, e *waveobj.Effort) error {
	if e.OID == "" {
		e.OID = uuid.NewString()
	}
	if e.Status == "" {
		e.Status = "active"
	}
	e.Version = 1
	now := waveobj.Now()
	e.CreatedTs = now
	e.UpdatedTs = now
	return DBInsert(ctx, e)
}

func GetEffort(ctx context.Context, oid string) (*waveobj.Effort, error) {
	return DBMustGet[*waveobj.Effort](ctx, oid)
}

func GetAllEfforts(ctx context.Context) ([]*waveobj.Effort, error) {
	all, err := DBGetAllObjsByType[*waveobj.Effort](ctx, waveobj.OType_Effort)
	if err != nil {
		return nil, err
	}
	sort.SliceStable(all, func(i, j int) bool { return all[i].UpdatedTs > all[j].UpdatedTs })
	return all, nil
}

// UpdateEffort applies fn inside one DB transaction; a returned error rolls the write back.
func UpdateEffort(ctx context.Context, oid string, fn func(*waveobj.Effort) error) error {
	return DBUpdateFnErr(ctx, oid, func(e *waveobj.Effort) error {
		if err := fn(e); err != nil {
			return err
		}
		e.Version++
		e.UpdatedTs = waveobj.Now()
		return nil
	})
}
```

Check that `waveobj.Now()` exists (used by other wstore files) — if the package uses `time.Now().UnixMilli()` inline instead, use the same expression the neighboring wstore file uses.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `go test ./pkg/wstore/ -run TestEffort -count=1`
Expected: PASS. If `waveobj.Now` does not exist, replace it with the timestamp expression used in `wstore_channelrows.go` and re-run.

- [ ] **Step 5: Commit**

```bash
git add pkg/wstore/wstore_effort.go pkg/wstore/wstore_effort_test.go
git commit -m "feat(effort): wstore storage layer"
```

---

### Task 3: wshrpc wire types + codegen

**Files:**
- Create: `pkg/wshrpc/wshrpctypes_effort.go`
- Modify: `pkg/wshrpc/wshrpctypes.go` (embed `EffortCommands` in `WshRpcInterface`, after `JarvisCommands`)
- Modify: `pkg/wshrpc/wshrpctypes_jarvis.go` (`WorkState.Efforts`, `SourceHealth.Efforts`)
- Generated (never hand-edit): `pkg/wshrpc/wshclient/wshclient.go`, `frontend/app/store/wshclientapi.ts`, `frontend/types/gotypes.d.ts`

**Interfaces:**
- Consumes: `waveobj.Effort` (Task 1), the interface-group pattern from `wshrpctypes_jarvis.go`.
- Produces: `EffortCommands` interface (4 methods), `CommandEffortCreateData/CommandEffortCreateRtnData`, `CommandEffortMutateData/CommandEffortMutateRtnData`, `CommandEffortListData/CommandEffortListRtnData`, `CommandEffortGetData/CommandEffortGetRtnData`, `EffortOp`, `EffortSummary`, `EffortChunkSummary`; `wshrpc.WorkState.Efforts []EffortSummary`; `wshrpc.SourceHealth.Efforts bool`. Used by tasks 4–8 and both frontend plans.

- [ ] **Step 1: Write the wire types**

Create `pkg/wshrpc/wshrpctypes_effort.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshrpc

import (
	"context"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// EffortCommands is the tracker surface: one atomic create, one atomic op-union mutate, plus
// lightweight list/get for the CLI (independent of the heavy WorkState ledger query).
type EffortCommands interface {
	EffortCreateCommand(ctx context.Context, data CommandEffortCreateData) (*CommandEffortCreateRtnData, error)
	EffortMutateCommand(ctx context.Context, data CommandEffortMutateData) (*CommandEffortMutateRtnData, error)
	EffortListCommand(ctx context.Context, data CommandEffortListData) (*CommandEffortListRtnData, error)
	EffortGetCommand(ctx context.Context, data CommandEffortGetData) (*CommandEffortGetRtnData, error)
}

type CommandEffortCreateData struct {
	Title     string                  `json:"title"`
	Project   string                  `json:"project,omitempty"`
	Ticket    string                  `json:"ticket,omitempty"`
	ParentOID string                  `json:"parentoid,omitempty"`
	Chunks    []CommandEffortChunkSeed `json:"chunks,omitempty"` // may be empty; chunks can be added later
}

type CommandEffortChunkSeed struct {
	Label string `json:"label"`
	Owner string `json:"owner,omitempty"`
}

type CommandEffortCreateRtnData struct {
	EffortOID string `json:"effortoid"`
}

// CommandEffortMutateData carries one atomic batch: all ops validate, then all apply. A failing op
// aborts the whole command.
type CommandEffortMutateData struct {
	EffortOID string     `json:"effortoid"`
	Ops       []EffortOp `json:"ops"`
	Note      string     `json:"note,omitempty"` // appended to the affected trail as the batch's note
}

type CommandEffortMutateRtnData struct {
	Effort *waveobj.Effort `json:"effort"` // post-mutation object
}

type CommandEffortListData struct {
	Project string `json:"project,omitempty"` // "" = all non-archived efforts
}

type CommandEffortListRtnData struct {
	Efforts []EffortSummary `json:"efforts"`
}

type CommandEffortGetData struct {
	EffortOID string `json:"effortoid"`
}

type CommandEffortGetRtnData struct {
	Effort *waveobj.Effort `json:"effort"`
}

// EffortOp is one typed mutation. Op selects the behavior; the remaining fields are the op's
// arguments (validation picks which are required per op).
type EffortOp struct {
	Op        string `json:"op"`                  // rename | setProject | setTicket | setStatus | link | addChunk | removeChunk | renameChunk | moveChunk | setChunkStatus | appendNote | setOwner | advance | reopen
	Title     string `json:"title,omitempty"`     // rename
	Project   string `json:"project,omitempty"`   // setProject ("" clears)
	Ticket    string `json:"ticket,omitempty"`    // setTicket ("" clears)
	Status    string `json:"status,omitempty"`    // setStatus (effort) | setChunkStatus (chunk)
	ParentOID string `json:"parentoid,omitempty"` // link ("" = unlink)
	Chunk     string `json:"chunk,omitempty"`     // chunk ref: exact label or 1-based index string
	Label     string `json:"label,omitempty"`     // addChunk label / renameChunk new label
	At        *int   `json:"at,omitempty"`        // addChunk insert position / moveChunk target (1-based)
	Owner     string `json:"owner,omitempty"`     // addChunk / setOwner ("" clears)
	Note      string `json:"note,omitempty"`      // appendNote text; also honored by setChunkStatus/advance/reopen as extra text
}

// EffortSummary is the ledger-friendly projection of an effort (no note trails).
type EffortSummary struct {
	ORef        string               `json:"oref"`
	Title       string               `json:"title"`
	Project     string               `json:"project,omitempty"`
	Ticket      string               `json:"ticket,omitempty"`
	Status      string               `json:"status"`
	ParentOID   string               `json:"parentoid,omitempty"`
	Chunks      []EffortChunkSummary `json:"chunks,omitempty"`
	Done        int                  `json:"done"`
	Total       int                  `json:"total"`
	ActiveChunk string               `json:"activechunk,omitempty"` // first chunk with status active, else first non-done label
	UpdatedTs   int64                `json:"updatedts"`
}

type EffortChunkSummary struct {
	Label     string              `json:"label"`
	Status    string              `json:"status"`
	Owner     string              `json:"owner,omitempty"`
	WorkRefs  []waveobj.ChunkWorkRef `json:"workrefs,omitempty"`
}
```

- [ ] **Step 2: Embed the interface + extend WorkState/SourceHealth**

In `pkg/wshrpc/wshrpctypes.go`, add `EffortCommands` to `WshRpcInterface` after `JarvisCommands`.

In `pkg/wshrpc/wshrpctypes_jarvis.go`, add to `WorkState` (after `Projects`):

```go
Efforts []EffortSummary `json:"efforts,omitempty"`
```

and to `SourceHealth` (after `Dossiers`):

```go
Efforts bool `json:"efforts"`
```

- [ ] **Step 3: Regenerate bindings**

Run: `task generate`
Expected: `pkg/wshrpc/wshclient/wshclient.go`, `frontend/app/store/wshclientapi.ts`, `frontend/types/gotypes.d.ts` gain the four Effort commands and the new types.

- [ ] **Step 4: Verify**

```powershell
$env:CGO_CFLAGS="-O2 -g -I$((Get-Location).Path -replace '\\','/')/pkg/jarvisembed/csrc"
go build ./pkg/...
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit
```

Expected: both succeed. (The handlers don't exist yet, so `go build ./pkg/...` fails on `WshServer` not implementing `EffortCommands` — that is fixed in Task 5. If so, run `go build ./pkg/wshrpc/ ./pkg/waveobj/ ./pkg/wstore/` instead and accept the wshserver failure until Task 5.)

- [ ] **Step 5: Commit**

```bash
git add pkg/wshrpc/wshrpctypes_effort.go pkg/wshrpc/wshrpctypes.go pkg/wshrpc/wshrpctypes_jarvis.go pkg/wshrpc/wshclient frontend/app/store/wshclientapi.ts frontend/types/gotypes.d.ts
git commit -m "feat(effort): wshrpc wire types + generated bindings"
```

---

### Task 4: pure op validation/apply logic

**Files:**
- Create: `pkg/jarvisstate/effortops.go`
- Create: `pkg/jarvisstate/effortops_test.go`

**Interfaces:**
- Consumes: `waveobj.Effort` (Task 1), `wshrpc.EffortOp` (Task 3).
- Produces: `jarvisstate.ResolveChunkIndex(e *waveobj.Effort, ref string) (int, error)` and `jarvisstate.ApplyEffortOps(e *waveobj.Effort, ops []wshrpc.EffortOp, cmdNote string, now int64) error`. Used by Task 5 (handlers), Task 7 (CLI), and Task 9 (workref ops).

- [ ] **Step 1: Write the failing tests**

Create `pkg/jarvisstate/effortops_test.go`:

```go
package jarvisstate

import (
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

const now = 1_700_000_000_000

func mkEffort() *waveobj.Effort {
	return &waveobj.Effort{
		Title: "t", Status: "active",
		Chunks: []waveobj.EffortChunk{
			{Label: "Phase 1", Status: "done", UpdatedTs: now},
			{Label: "Phase 2", Status: "active", UpdatedTs: now},
			{Label: "Phase 3", Status: "pending", UpdatedTs: now},
		},
	}
}

func expectErrCode(t *testing.T, err error, code string) {
	t.Helper()
	if err == nil || !strings.Contains(err.Error(), code) {
		t.Fatalf("want error containing %q, got %v", code, err)
	}
}

func TestApplyOpsRename(t *testing.T) {
	e := mkEffort()
	err := ApplyEffortOps(e, []wshrpc.EffortOp{{Op: "rename", Title: "new title"}}, "", now)
	if err != nil {
		t.Fatal(err)
	}
	if e.Title != "new title" {
		t.Fatalf("title: %q", e.Title)
	}
}

func TestApplyOpsAddChunkInsertAt(t *testing.T) {
	e := mkEffort()
	err := ApplyEffortOps(e, []wshrpc.EffortOp{{Op: "addChunk", Label: "Phase 0", At: intPtr(1)}}, "", now)
	if err != nil {
		t.Fatal(err)
	}
	if len(e.Chunks) != 4 || e.Chunks[0].Label != "Phase 0" {
		t.Fatalf("chunks: %+v", e.Chunks)
	}
}

func TestApplyOpsAddChunkDuplicateLabel(t *testing.T) {
	e := mkEffort()
	err := ApplyEffortOps(e, []wshrpc.EffortOp{{Op: "addChunk", Label: "Phase 2"}}, "", now)
	expectErrCode(t, err, "EC-DUPLICATE-LABEL")
}

func TestApplyOpsRemoveLastChunkGuard(t *testing.T) {
	e := mkEffort()
	e.Chunks = []waveobj.EffortChunk{{Label: "only", Status: "pending"}}
	err := ApplyEffortOps(e, []wshrpc.EffortOp{{Op: "removeChunk", Chunk: "only"}}, "", now)
	expectErrCode(t, err, "EC-LAST-CHUNK")
}

func TestApplyOpsResolveChunkRefs(t *testing.T) {
	e := mkEffort()
	// label ref
	idx, err := ResolveChunkIndex(e, "Phase 3")
	if err != nil || idx != 2 {
		t.Fatalf("label ref: idx=%d err=%v", idx, err)
	}
	// 1-based index ref
	idx, err = ResolveChunkIndex(e, "2")
	if err != nil || idx != 1 {
		t.Fatalf("index ref: idx=%d err=%v", idx, err)
	}
	// ambiguous: "Phase" matches nothing exactly; "Phase 1" is exact — try a substring that is not a label
	_, err = ResolveChunkIndex(e, "nope")
	expectErrCode(t, err, "EC-UNKNOWN-CHUNK")
}

func TestApplyOpsSetChunkStatusEmitsEvents(t *testing.T) {
	e := mkEffort()
	err := ApplyEffortOps(e, []wshrpc.EffortOp{{Op: "setChunkStatus", Chunk: "Phase 3", Status: "blocked", Note: "waiting on substrate"}}, "", now)
	if err != nil {
		t.Fatal(err)
	}
	if e.Chunks[2].Status != "blocked" {
		t.Fatalf("status: %s", e.Chunks[2].Status)
	}
	if len(e.Chunks[2].Notes) != 1 || !strings.Contains(e.Chunks[2].Notes[0].Text, "blocked") {
		t.Fatalf("auto-stamp missing: %+v", e.Chunks[2].Notes)
	}
	if len(e.Events) != 1 || e.Events[0].Kind != "chunk-status" || e.Events[0].Label != "Phase 3" {
		t.Fatalf("events: %+v", e.Events)
	}
}

func TestApplyOpsAdvanceSemantics(t *testing.T) {
	e := mkEffort()
	// Phase 2 active -> done, Phase 3 becomes active
	err := ApplyEffortOps(e, []wshrpc.EffortOp{{Op: "advance"}}, "", now)
	if err != nil {
		t.Fatal(err)
	}
	if e.Chunks[1].Status != "done" || e.Chunks[2].Status != "active" {
		t.Fatalf("advance: %+v", e.Chunks)
	}
	// no active chunk: advance just activates the first non-done
	e2 := mkEffort()
	e2.Chunks[1].Status = "pending"
	err = ApplyEffortOps(e2, []wshrpc.EffortOp{{Op: "advance"}}, "", now)
	if err != nil {
		t.Fatal(err)
	}
	if e2.Chunks[1].Status != "active" {
		t.Fatalf("advance-no-active: %+v", e2.Chunks)
	}
}

func TestApplyOpsReopenUndoesAdvance(t *testing.T) {
	e := mkEffort()
	err := ApplyEffortOps(e, []wshrpc.EffortOp{{Op: "reopen", Chunk: "Phase 1"}}, "", now)
	if err != nil {
		t.Fatal(err)
	}
	if e.Chunks[0].Status != "active" || e.Chunks[1].Status != "pending" {
		t.Fatalf("reopen: %+v", e.Chunks)
	}
}

func TestApplyOpsReopenNonDoneRejected(t *testing.T) {
	e := mkEffort()
	err := ApplyEffortOps(e, []wshrpc.EffortOp{{Op: "reopen", Chunk: "Phase 3"}}, "", now)
	expectErrCode(t, err, "EC-INVALID-STATUS")
}

func TestApplyOpsAppendNoteToChunk(t *testing.T) {
	e := mkEffort()
	err := ApplyEffortOps(e, []wshrpc.EffortOp{{Op: "appendNote", Chunk: "Phase 1", Note: "soak accepted"}}, "", now)
	if err != nil {
		t.Fatal(err)
	}
	if len(e.Chunks[0].Notes) != 1 || e.Chunks[0].Notes[0].Text != "soak accepted" {
		t.Fatalf("notes: %+v", e.Chunks[0].Notes)
	}
	if len(e.Events) != 1 || e.Events[0].Kind != "effort-note" {
		t.Fatalf("events: %+v", e.Events)
	}
}

func TestApplyOpsAtomicBatchRollback(t *testing.T) {
	e := mkEffort()
	err := ApplyEffortOps(e, []wshrpc.EffortOp{
		{Op: "rename", Title: "half-applied"},
		{Op: "addChunk", Label: "Phase 2"}, // duplicate — must abort the batch
	}, "", now)
	expectErrCode(t, err, "EC-DUPLICATE-LABEL")
	if e.Title != "t" {
		t.Fatalf("batch not atomic: title=%q", e.Title)
	}
}

func TestApplyOpsSetChunkStatusInvalid(t *testing.T) {
	e := mkEffort()
	err := ApplyEffortOps(e, []wshrpc.EffortOp{{Op: "setChunkStatus", Chunk: "Phase 3", Status: "banana"}}, "", now)
	expectErrCode(t, err, "EC-INVALID-STATUS")
}

func TestApplyOpsCmdNoteAppendedToEffort(t *testing.T) {
	e := mkEffort()
	err := ApplyEffortOps(e, []wshrpc.EffortOp{{Op: "setTicket", Ticket: "SIEM-1662"}}, "filed from briefing", now)
	if err != nil {
		t.Fatal(err)
	}
	if len(e.Notes) != 1 || !strings.Contains(e.Notes[0].Text, "filed from briefing") {
		t.Fatalf("cmd note missing: %+v", e.Notes)
	}
}

func intPtr(i int) *int { return &i }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go test ./pkg/jarvisstate/ -run TestApplyOps -count=1`
Expected: FAIL — undefined `ApplyEffortOps`/`ResolveChunkIndex`.

- [ ] **Step 3: Implement the pure op logic**

Create `pkg/jarvisstate/effortops.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Effort mutation logic, pure and DB-free: one validation pass, then one apply pass. The handler
// wraps this in wstore.UpdateEffort so a rejected batch never touches the store.

package jarvisstate

import (
	"fmt"
	"strconv"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

var effortChunkStatuses = map[string]bool{
	"pending": true, "active": true, "done": true, "deferred": true, "blocked": true, "skipped": true,
}

var effortStatuses = map[string]bool{"active": true, "paused": true, "done": true, "archived": true}

// delta-event kinds only; renames/moves/owner/remove/link are trail-only by design (the delta is
// "what changed that matters", the trail is the full record).
var effortEventKinds = map[string]bool{
	"effort-created": true, "chunk-done": true, "chunk-added": true,
	"chunk-status": true, "effort-status": true, "effort-note": true,
}

// ResolveChunkIndex resolves a chunk ref (exact label, or 1-based index string) to a 0-based index.
// A ref that is a valid integer is treated as an index; otherwise it must match one label exactly.
func ResolveChunkIndex(e *waveobj.Effort, ref string) (int, error) {
	if ref == "" {
		return -1, fmt.Errorf("EC-UNKNOWN-CHUNK: empty chunk ref")
	}
	if idx, err := strconv.Atoi(ref); err == nil {
		if idx < 1 || idx > len(e.Chunks) {
			return -1, fmt.Errorf("EC-UNKNOWN-CHUNK: chunk index %d out of range (1..%d)", idx, len(e.Chunks))
		}
		return idx - 1, nil
	}
	for i, c := range e.Chunks {
		if c.Label == ref {
			return i, nil
		}
	}
	return -1, fmt.Errorf("EC-UNKNOWN-CHUNK: no chunk named %q (labels: %s)", ref, chunkLabels(e))
}

func chunkLabels(e *waveobj.Effort) string {
	labels := make([]string, 0, len(e.Chunks))
	for _, c := range e.Chunks {
		labels = append(labels, c.Label)
	}
	return strings.Join(labels, ", ")
}

func chunkNote(e *waveobj.Effort, idx int, text string, now int64) {
	e.Chunks[idx].Notes = append(e.Chunks[idx].Notes, waveobj.EffortNote{Ts: now, Text: text})
	e.Chunks[idx].UpdatedTs = now
}

func effortNote(e *waveobj.Effort, text string, now int64) {
	e.Notes = append(e.Notes, waveobj.EffortNote{Ts: now, Text: text})
}

func effortEvent(e *waveobj.Effort, kind, label, text string, now int64) {
	if !effortEventKinds[kind] {
		return // trail-only mutation
	}
	e.Events = append(e.Events, waveobj.EffortEvent{Ts: now, Kind: kind, Label: label, Text: text})
}

// ApplyEffortOps validates every op first, then applies them in order. On any validation failure
// nothing is applied (the caller runs this inside a store transaction for atomicity). cmdNote is
// appended to the affected trail as the batch's note when an op carries no note of its own.
func ApplyEffortOps(e *waveobj.Effort, ops []wshrpc.EffortOp, cmdNote string, now int64) error {
	// ---- validation pass ----
	for _, op := range ops {
		switch op.Op {
		case "rename":
			if strings.TrimSpace(op.Title) == "" {
				return fmt.Errorf("EC-INVALID-TITLE: title cannot be empty")
			}
		case "setStatus":
			if !effortStatuses[op.Status] {
				return fmt.Errorf("EC-INVALID-STATUS: %q not one of active|paused|done|archived", op.Status)
			}
		case "addChunk":
			label := strings.TrimSpace(op.Label)
			if label == "" {
				return fmt.Errorf("EC-INVALID-LABEL: chunk label cannot be empty")
			}
			for _, c := range e.Chunks {
				if c.Label == label {
					return fmt.Errorf("EC-DUPLICATE-LABEL: chunk %q already exists", label)
				}
			}
			if op.At != nil && (*op.At < 1 || *op.At > len(e.Chunks)+1) {
				return fmt.Errorf("EC-INVALID-INDEX: at %d out of range", *op.At)
			}
		case "removeChunk":
			if _, err := ResolveChunkIndex(e, op.Chunk); err != nil {
				return err
			}
			if len(e.Chunks) == 1 {
				return fmt.Errorf("EC-LAST-CHUNK: cannot remove the last chunk")
			}
		case "renameChunk", "moveChunk", "setChunkStatus", "setOwner", "appendNote":
			if _, err := ResolveChunkIndex(e, op.Chunk); err != nil {
				return err
			}
		case "setChunkStatus":
			if !effortChunkStatuses[op.Status] {
				return fmt.Errorf("EC-INVALID-STATUS: %q not one of pending|active|done|deferred|blocked|skipped", op.Status)
			}
		case "renameChunk":
			if strings.TrimSpace(op.Label) == "" {
				return fmt.Errorf("EC-INVALID-LABEL: chunk label cannot be empty")
			}
			for i, c := range e.Chunks {
				if c.Label == op.Label && op.Chunk != op.Label {
					_ = i
					return fmt.Errorf("EC-DUPLICATE-LABEL: chunk %q already exists", op.Label)
				}
			}
		case "moveChunk":
			if op.At == nil || *op.At < 1 || *op.At > len(e.Chunks) {
				return fmt.Errorf("EC-INVALID-INDEX: at %d out of range", derefAt(op.At))
			}
		case "reopen":
			idx, err := ResolveChunkIndex(e, op.Chunk)
			if err != nil {
				return err
			}
			if e.Chunks[idx].Status != "done" {
				return fmt.Errorf("EC-INVALID-STATUS: reopen requires a done chunk, %q is %s", op.Chunk, e.Chunks[idx].Status)
			}
		case "appendNote":
			if strings.TrimSpace(op.Note) == "" && strings.TrimSpace(cmdNote) == "" {
				return fmt.Errorf("EC-EMPTY-NOTE: note text is empty")
			}
		case "setProject", "setTicket", "link", "advance":
			// no chunk-level validation
		default:
			return fmt.Errorf("EC-UNKNOWN-OP: %q", op.Op)
		}
	}

	// ---- apply pass ----
	for _, op := range ops {
		note := op.Note
		if note == "" {
			note = cmdNote
		}
		switch op.Op {
		case "rename":
			e.Title = op.Title
			effortNote(e, "renamed to "+op.Title, now)
		case "setProject":
			e.Project = op.Project
			effortNote(e, "project set to "+orNone(op.Project), now)
		case "setTicket":
			e.Ticket = op.Ticket
			effortNote(e, "ticket set to "+orNone(op.Ticket), now)
		case "setStatus":
			e.Status = op.Status
			effortNote(e, "effort "+op.Status, now)
			effortEvent(e, "effort-status", "", op.Status, now)
		case "link":
			e.ParentOID = op.ParentOID
			effortNote(e, "linked to parent "+orNone(op.ParentOID), now)
		case "addChunk":
			idx := len(e.Chunks)
			if op.At != nil {
				idx = *op.At - 1
			}
			c := waveobj.EffortChunk{Label: op.Label, Status: "pending", Owner: op.Owner, UpdatedTs: now}
			e.Chunks = append(e.Chunks[:idx], append([]waveobj.EffortChunk{c}, e.Chunks[idx:]...)...)
			effortNote(e, "chunk added: "+op.Label, now)
			effortEvent(e, "chunk-added", op.Label, "", now)
		case "removeChunk":
			idx, _ := ResolveChunkIndex(e, op.Chunk)
			e.Chunks = append(e.Chunks[:idx], e.Chunks[idx+1:]...)
			effortNote(e, "chunk removed: "+op.Chunk, now)
		case "renameChunk":
			idx, _ := ResolveChunkIndex(e, op.Chunk)
			old := e.Chunks[idx].Label
			e.Chunks[idx].Label = op.Label
			chunkNote(e, idx, "renamed from "+old, now)
		case "moveChunk":
			idx, _ := ResolveChunkIndex(e, op.Chunk)
			c := e.Chunks[idx]
			e.Chunks = append(e.Chunks[:idx], e.Chunks[idx+1:]...)
			at := *op.At - 1
			e.Chunks = append(e.Chunks[:at], append([]waveobj.EffortChunk{c}, e.Chunks[at:]...)...)
			chunkNote(e, at, "moved to position "+strconv.Itoa(*op.At), now)
		case "setChunkStatus":
			idx, _ := ResolveChunkIndex(e, op.Chunk)
			old := e.Chunks[idx].Status
			e.Chunks[idx].Status = op.Status
			text := "marked " + op.Status
			if note != "" {
				text += " · " + note
			}
			chunkNote(e, idx, text, now)
			kind := "chunk-status"
			if op.Status == "done" {
				kind = "chunk-done"
			}
			effortEvent(e, kind, op.Chunk, note, now)
		case "appendNote":
			idx, _ := ResolveChunkIndex(e, op.Chunk)
			chunkNote(e, idx, note, now)
			effortEvent(e, "effort-note", op.Chunk, note, now)
		case "setOwner":
			idx, _ := ResolveChunkIndex(e, op.Chunk)
			e.Chunks[idx].Owner = op.Owner
			chunkNote(e, idx, "owner set to "+orNone(op.Owner), now)
		case "advance":
			advance(e, now)
		case "reopen":
			idx, _ := ResolveChunkIndex(e, op.Chunk)
			// undo of advance: reopened chunk active, the previously active chunk back to pending
			for i := range e.Chunks {
				if i != idx && e.Chunks[i].Status == "active" {
					e.Chunks[i].Status = "pending"
				}
			}
			e.Chunks[idx].Status = "active"
			chunkNote(e, idx, "reopened", now)
		}
	}
	return nil
}

// advance marks the active chunk done and activates the next non-done chunk (the run-card contract:
// one active at a time). With no active chunk it activates the first non-done.
func advance(e *waveobj.Effort, now int64) {
	active := -1
	for i, c := range e.Chunks {
		if c.Status == "active" {
			active = i
			break
		}
	}
	if active >= 0 {
		e.Chunks[active].Status = "done"
		chunkNote(e, active, "marked done", now)
		effortEvent(e, "chunk-done", e.Chunks[active].Label, "", now)
	}
	for i, c := range e.Chunks {
		if c.Status == "pending" || c.Status == "blocked" || c.Status == "deferred" {
			e.Chunks[i].Status = "active"
			chunkNote(e, i, "activated", now)
			return
		}
	}
}

func orNone(s string) string {
	if s == "" {
		return "(none)"
	}
	return s
}

func derefAt(p *int) int {
	if p == nil {
		return 0
	}
	return *p
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `go test ./pkg/jarvisstate/ -run TestApplyOps -count=1`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add pkg/jarvisstate/effortops.go pkg/jarvisstate/effortops_test.go
git commit -m "feat(effort): pure op validation/apply logic"
```

---

### Task 5: wshserver handlers

**Files:**
- Create: `pkg/wshrpc/wshserver/wshserver_effort.go`
- Create: `pkg/wshrpc/wshserver/wshserver_effort_test.go`

**Interfaces:**
- Consumes: `wstore.CreateEffort/GetEffort/GetAllEfforts/UpdateEffort` (Task 2), `jarvisstate.ApplyEffortOps` (Task 4), `jarvisstate.Efforts` (Task 6 — see note), wire types (Task 3).
- Produces: `(*WshServer).EffortCreateCommand`, `(*WshServer).EffortMutateCommand`, `(*WshServer).EffortListCommand`, `(*WshServer).EffortGetCommand`. Consumed by Task 7 (CLI) and all frontend plans.

- [ ] **Step 1: Write the failing tests**

Create `pkg/wshrpc/wshserver/wshserver_effort_test.go` (pattern: construct `&WshServer{}` directly, real wstore, cleanup via `wstore.DBDelete` — see `wshserver_jarvis_test.go`):

```go
package wshserver

import (
	"context"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

func cleanupEffort(t *testing.T, oid string) {
	t.Helper()
	t.Cleanup(func() {
		if err := wstore.DBDelete(context.Background(), waveobj.OType_Effort, oid); err != nil {
			t.Errorf("cleanup effort: %v", err)
		}
	})
}

func TestEffortCreateAndMutateRoundTrip(t *testing.T) {
	ctx := context.Background()
	ws := &WshServer{}
	rtn, err := ws.EffortCreateCommand(ctx, wshrpc.CommandEffortCreateData{
		Title: "Scenario gate clearance", Ticket: "SIEM-1662",
		Chunks: []wshrpc.CommandEffortChunkSeed{{Label: "Phase 1"}, {Label: "Phase 2", Owner: "soc"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	cleanupEffort(t, rtn.EffortOID)

	got, err := ws.EffortMutateCommand(ctx, wshrpc.CommandEffortMutateData{
		EffortOID: rtn.EffortOID,
		Ops: []wshrpc.EffortOp{
			{Op: "setChunkStatus", Chunk: "Phase 1", Status: "done"},
			{Op: "addChunk", Label: "Phase 3"},
			{Op: "advance"},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if got.Effort.Chunks[0].Status != "done" || got.Effort.Chunks[1].Status != "active" || len(got.Effort.Chunks) != 3 {
		t.Fatalf("mutate result: %+v", got.Effort.Chunks)
	}
}

func TestEffortCreateValidation(t *testing.T) {
	ws := &WshServer{}
	_, err := ws.EffortCreateCommand(context.Background(), wshrpc.CommandEffortCreateData{
		Title:  "",
		Chunks: []wshrpc.CommandEffortChunkSeed{{Label: "x"}},
	})
	if err == nil || !strings.Contains(err.Error(), "EC-INVALID-TITLE") {
		t.Fatalf("want EC-INVALID-TITLE, got %v", err)
	}
	_, err = ws.EffortCreateCommand(context.Background(), wshrpc.CommandEffortCreateData{
		Title:  "dup",
		Chunks: []wshrpc.CommandEffortChunkSeed{{Label: "a"}, {Label: "a"}},
	})
	if err == nil || !strings.Contains(err.Error(), "EC-DUPLICATE-LABEL") {
		t.Fatalf("want EC-DUPLICATE-LABEL, got %v", err)
	}
}

func TestEffortMutateAtomicBatchRejected(t *testing.T) {
	ctx := context.Background()
	ws := &WshServer{}
	rtn, err := ws.EffortCreateCommand(ctx, wshrpc.CommandEffortCreateData{Title: "atomic"})
	if err != nil {
		t.Fatal(err)
	}
	cleanupEffort(t, rtn.EffortOID)
	_, err = ws.EffortMutateCommand(ctx, wshrpc.CommandEffortMutateData{
		EffortOID: rtn.EffortOID,
		Ops: []wshrpc.EffortOp{
			{Op: "rename", Title: "should-not-stick"},
			{Op: "setChunkStatus", Chunk: "nope", Status: "done"},
		},
	})
	if err == nil || !strings.Contains(err.Error(), "EC-UNKNOWN-CHUNK") {
		t.Fatalf("want EC-UNKNOWN-CHUNK, got %v", err)
	}
	got, gerr := wstore.GetEffort(ctx, rtn.EffortOID)
	if gerr != nil {
		t.Fatal(gerr)
	}
	if got.Title != "atomic" {
		t.Fatalf("batch not atomic: %+v", got)
	}
}

func TestEffortMutateUnknownEffort(t *testing.T) {
	ws := &WshServer{}
	_, err := ws.EffortMutateCommand(context.Background(), wshrpc.CommandEffortMutateData{
		EffortOID: "00000000-0000-0000-0000-000000000000",
		Ops:       []wshrpc.EffortOp{{Op: "rename", Title: "x"}},
	})
	if err == nil || !strings.Contains(err.Error(), "not found") {
		t.Fatalf("want not-found error, got %v", err)
	}
}

func TestEffortLinkParentValidation(t *testing.T) {
	ctx := context.Background()
	ws := &WshServer{}
	parent, err := ws.EffortCreateCommand(ctx, wshrpc.CommandEffortCreateData{Title: "parent"})
	if err != nil {
		t.Fatal(err)
	}
	cleanupEffort(t, parent.EffortOID)
	child, err := ws.EffortCreateCommand(ctx, wshrpc.CommandEffortCreateData{Title: "child"})
	if err != nil {
		t.Fatal(err)
	}
	cleanupEffort(t, child.EffortOID)
	// self-link rejected
	_, err = ws.EffortMutateCommand(ctx, wshrpc.CommandEffortMutateData{
		EffortOID: parent.EffortOID,
		Ops:       []wshrpc.EffortOp{{Op: "link", ParentOID: parent.EffortOID}},
	})
	if err == nil || !strings.Contains(err.Error(), "EC-BAD-PARENT") {
		t.Fatalf("want EC-BAD-PARENT, got %v", err)
	}
	// unknown parent rejected
	_, err = ws.EffortMutateCommand(ctx, wshrpc.CommandEffortMutateData{
		EffortOID: child.EffortOID,
		Ops:       []wshrpc.EffortOp{{Op: "link", ParentOID: "00000000-0000-0000-0000-000000000000"}},
	})
	if err == nil || !strings.Contains(err.Error(), "EC-BAD-PARENT") {
		t.Fatalf("want EC-BAD-PARENT, got %v", err)
	}
	// valid link
	_, err = ws.EffortMutateCommand(ctx, wshrpc.CommandEffortMutateData{
		EffortOID: child.EffortOID,
		Ops:       []wshrpc.EffortOp{{Op: "link", ParentOID: parent.EffortOID}},
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestEffortListAndGet(t *testing.T) {
	ctx := context.Background()
	ws := &WshServer{}
	rtn, err := ws.EffortCreateCommand(ctx, wshrpc.CommandEffortCreateData{Title: "listed", Project: "proj-a"})
	if err != nil {
		t.Fatal(err)
	}
	cleanupEffort(t, rtn.EffortOID)
	archived, err := ws.EffortCreateCommand(ctx, wshrpc.CommandEffortCreateData{Title: "archived"})
	if err != nil {
		t.Fatal(err)
	}
	cleanupEffort(t, archived.EffortOID)
	if _, err := ws.EffortMutateCommand(ctx, wshrpc.CommandEffortMutateData{
		EffortOID: archived.EffortOID,
		Ops:       []wshrpc.EffortOp{{Op: "setStatus", Status: "archived"}},
	}); err != nil {
		t.Fatal(err)
	}
	list, err := ws.EffortListCommand(ctx, wshrpc.CommandEffortListData{})
	if err != nil {
		t.Fatal(err)
	}
	for _, s := range list.Efforts {
		if s.ORef == "effort:"+archived.EffortOID {
			t.Fatalf("archived effort leaked into list: %+v", list.Efforts)
		}
	}
	// get works for archived
	got, err := ws.EffortGetCommand(ctx, wshrpc.CommandEffortGetData{EffortOID: archived.EffortOID})
	if err != nil {
		t.Fatal(err)
	}
	if got.Effort.Status != "archived" {
		t.Fatalf("get: %+v", got.Effort)
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go test ./pkg/wshrpc/wshserver/ -run TestEffort -count=1`
Expected: FAIL — undefined methods.

- [ ] **Step 3: Implement the handlers**

Create `pkg/wshrpc/wshserver/wshserver_effort.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"fmt"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/jarvisstate"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

func (ws *WshServer) EffortCreateCommand(ctx context.Context, data wshrpc.CommandEffortCreateData) (*wshrpc.CommandEffortCreateRtnData, error) {
	title := strings.TrimSpace(data.Title)
	if title == "" {
		return nil, fmt.Errorf("EC-INVALID-TITLE: title cannot be empty")
	}
	if len(title) > 200 {
		return nil, fmt.Errorf("EC-INVALID-TITLE: title exceeds 200 chars")
	}
	if data.ParentOID != "" {
		if _, err := wstore.GetEffort(ctx, data.ParentOID); err != nil {
			return nil, fmt.Errorf("EC-BAD-PARENT: parent effort not found: %v", err)
		}
	}
	e := &waveobj.Effort{
		Title: title, Project: data.Project, Ticket: data.Ticket, Status: "active",
		ParentOID: data.ParentOID,
	}
	seen := map[string]bool{}
	for _, seed := range data.Chunks {
		label := strings.TrimSpace(seed.Label)
		if label == "" {
			return nil, fmt.Errorf("EC-INVALID-LABEL: chunk label cannot be empty")
		}
		if len(label) > 200 {
			return nil, fmt.Errorf("EC-INVALID-LABEL: chunk label exceeds 200 chars")
		}
		if seen[label] {
			return nil, fmt.Errorf("EC-DUPLICATE-LABEL: chunk %q already exists", label)
		}
		seen[label] = true
		e.Chunks = append(e.Chunks, waveobj.EffortChunk{Label: label, Status: "pending", Owner: seed.Owner})
	}
	if err := wstore.CreateEffort(ctx, e); err != nil {
		return nil, err
	}
	// the created event is the delta source; the trail note documents it for humans
	e.Notes = append(e.Notes, waveobj.EffortNote{Ts: e.CreatedTs, Text: "effort created"})
	if len(e.Chunks) > 0 {
		e.Events = append(e.Events, waveobj.EffortEvent{Ts: e.CreatedTs, Kind: "effort-created", Text: fmt.Sprintf("%d chunks", len(e.Chunks))})
	} else {
		e.Events = append(e.Events, waveobj.EffortEvent{Ts: e.CreatedTs, Kind: "effort-created"})
	}
	if err := wstore.UpdateEffort(ctx, e.OID, func(store *waveobj.Effort) error {
		store.Notes = e.Notes
		store.Events = e.Events
		return nil
	}); err != nil {
		return nil, err
	}
	return &wshrpc.CommandEffortCreateRtnData{EffortOID: e.OID}, nil
}

func (ws *WshServer) EffortMutateCommand(ctx context.Context, data wshrpc.CommandEffortMutateData) (*wshrpc.CommandEffortMutateRtnData, error) {
	if _, err := wstore.GetEffort(ctx, data.EffortOID); err != nil {
		return nil, err
	}
	// link op: parent must exist and not be self — pre-validated outside the txn so the error is
	// deterministic and cheap; a parent deleted mid-flight fails the same lookup below.
	for _, op := range data.Ops {
		if op.Op == "link" && op.ParentOID != "" {
			if op.ParentOID == data.EffortOID {
				return nil, fmt.Errorf("EC-BAD-PARENT: cannot link an effort to itself")
			}
			if _, err := wstore.GetEffort(ctx, op.ParentOID); err != nil {
				return nil, fmt.Errorf("EC-BAD-PARENT: parent effort not found")
			}
		}
	}
	var updated *waveobj.Effort
	err := wstore.UpdateEffort(ctx, data.EffortOID, func(e *waveobj.Effort) error {
		if err := jarvisstate.ApplyEffortOps(e, data.Ops, data.Note, waveobj.Now()); err != nil {
			return err
		}
		updated = e
		return nil
	})
	if err != nil {
		return nil, err
	}
	return &wshrpc.CommandEffortMutateRtnData{Effort: updated}, nil
}

func (ws *WshServer) EffortListCommand(ctx context.Context, data wshrpc.CommandEffortListData) (*wshrpc.CommandEffortListRtnData, error) {
	all, err := wstore.GetAllEfforts(ctx)
	if err != nil {
		return nil, err
	}
	var out []wshrpc.EffortSummary
	for _, e := range all {
		if e.Status == "archived" {
			continue
		}
		if data.Project != "" && e.Project != data.Project {
			continue
		}
		out = append(out, jarvisstate.EffortSummaryOf(e))
	}
	return &wshrpc.CommandEffortListRtnData{Efforts: out}, nil
}

func (ws *WshServer) EffortGetCommand(ctx context.Context, data wshrpc.CommandEffortGetData) (*wshrpc.CommandEffortGetRtnData, error) {
	e, err := wstore.GetEffort(ctx, data.EffortOID)
	if err != nil {
		return nil, err
	}
	return &wshrpc.CommandEffortGetRtnData{Effort: e}, nil
}
```

Note: this task references `jarvisstate.EffortSummaryOf(e *waveobj.Effort) wshrpc.EffortSummary` — implement it in Task 6 (Step 1 of Task 6 must land before `go build ./pkg/wshrpc/wshserver/` passes; if you implement this task first, add a minimal `EffortSummaryOf` here temporarily or implement Task 6's Step 1 immediately after this task and before running the build).

Also check that `waveobj.Now()` exists; if not, use the timestamp expression used in `pkg/wstore/wstore_channelrows.go`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `go test ./pkg/wshrpc/wshserver/ -run TestEffort -count=1`
Expected: PASS (once `jarvisstate.EffortSummaryOf` exists from Task 6).

- [ ] **Step 5: Commit**

```bash
git add pkg/wshrpc/wshserver/wshserver_effort.go pkg/wshrpc/wshserver/wshserver_effort_test.go
git commit -m "feat(effort): RPC handlers (create/mutate/list/get)"
```

---

### Task 6: WorkState efforts leg + delta events

**Files:**
- Modify: `pkg/jarvisstate/jarvisstate.go` (`EffortSummaryOf`, `Efforts`, Timeline/Delta signatures)
- Modify: `pkg/jarvisstate/fetch.go` (seams + leg + Sources.Efforts)
- Modify: `pkg/jarvisstate/jarvisstate_test.go` (or create `efforts_leg_test.go`)

**Interfaces:**
- Consumes: `wstore.GetAllEfforts` (Task 2), wire types (Task 3), `waveobj.Effort.Events` (Task 1).
- Produces: `jarvisstate.EffortSummaryOf(e *waveobj.Effort) wshrpc.EffortSummary`, `jarvisstate.Efforts(es []*waveobj.Effort) []wshrpc.EffortSummary`, `jarvisstate.Delta(..., efforts []*waveobj.Effort)`, `jarvisstate.Timeline(..., efforts []*waveobj.Effort)`. `FetchWorkState` populates `WorkState.Efforts` and `SourceHealth.Efforts`. Consumed by the briefing frontend plan and `wsh effort list` (via Task 5).

- [ ] **Step 1: Write the failing tests**

Create `pkg/jarvisstate/efforts_leg_test.go`:

```go
package jarvisstate

import (
	"context"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

func TestEffortSummaryOf(t *testing.T) {
	e := &waveobj.Effort{
		Title: "t", Project: "p", Ticket: "T-1", Status: "active",
		Chunks: []waveobj.EffortChunk{
			{Label: "c1", Status: "done"},
			{Label: "c2", Status: "active"},
			{Label: "c3", Status: "pending"},
		},
		UpdatedTs: 99,
	}
	s := EffortSummaryOf(e)
	if s.ORef != "effort:"+e.OID || s.Done != 1 || s.Total != 3 || s.ActiveChunk != "c2" || s.UpdatedTs != 99 {
		t.Fatalf("summary: %+v", s)
	}
}

func TestEffortSummaryActiveChunkFallsBackToFirstNonDone(t *testing.T) {
	e := &waveobj.Effort{Title: "t", Status: "active",
		Chunks: []waveobj.EffortChunk{{Label: "a", Status: "pending"}, {Label: "b", Status: "pending"}}}
	s := EffortSummaryOf(e)
	if s.ActiveChunk != "a" {
		t.Fatalf("activechunk: %q", s.ActiveChunk)
	}
}

func TestEffortsFiltersArchived(t *testing.T) {
	es := []*waveobj.Effort{
		{Title: "live", Status: "active", Chunks: []waveobj.EffortChunk{{Label: "x", Status: "done"}}},
		{Title: "dead", Status: "archived", Chunks: []waveobj.EffortChunk{{Label: "y", Status: "pending"}}},
	}
	got := Efforts(es)
	if len(got) != 1 || got[0].Title != "live" {
		t.Fatalf("efforts: %+v", got)
	}
}

func TestDeltaIncludesEffortEventsInWindow(t *testing.T) {
	eff := &waveobj.Effort{Title: "t", Project: "p", Status: "active",
		Events: []waveobj.EffortEvent{
			{Ts: 200, Kind: "chunk-done", Label: "Phase 1", Text: "soak accepted"},
			{Ts: 50, Kind: "chunk-added", Label: "Phase 3"},
		},
	}
	evs := Delta(100, nil, nil, nil, nil, nil, []*waveobj.Effort{eff})
	if len(evs) != 1 {
		t.Fatalf("delta: %+v", evs)
	}
	ev := evs[0]
	if ev.Kind != "chunk-done" || ev.Title != "t" || ev.NavTarget != "effort:"+eff.OID || ev.Project != "p" {
		t.Fatalf("event: %+v", ev)
	}
}

func TestDeltaSkipsArchivedEffortEvents(t *testing.T) {
	eff := &waveobj.Effort{Title: "dead", Status: "archived",
		Events: []waveobj.EffortEvent{{Ts: 200, Kind: "chunk-done", Label: "x"}}}
	evs := Delta(100, nil, nil, nil, nil, nil, []*waveobj.Effort{eff})
	if len(evs) != 0 {
		t.Fatalf("archived events leaked: %+v", evs)
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go test ./pkg/jarvisstate/ -run "TestEffort|TestDeltaIncludes|TestDeltaSkips" -count=1`
Expected: FAIL — undefined `EffortSummaryOf`/`Efforts`, and `Delta` signature mismatch.

- [ ] **Step 3: Implement the projections**

In `pkg/jarvisstate/jarvisstate.go`:

```go
// EffortSummaryOf projects one effort into its ledger shape (no trails; the detail RPC serves those).
func EffortSummaryOf(e *waveobj.Effort) wshrpc.EffortSummary {
	s := wshrpc.EffortSummary{
		ORef: "effort:" + e.OID, Title: e.Title, Project: e.Project, Ticket: e.Ticket,
		Status: e.Status, ParentOID: e.ParentOID, UpdatedTs: e.UpdatedTs,
	}
	for _, c := range e.Chunks {
		s.Chunks = append(s.Chunks, wshrpc.EffortChunkSummary{
			Label: c.Label, Status: c.Status, Owner: c.Owner, WorkRefs: c.WorkRefs,
		})
		if c.Status == "done" {
			s.Done++
		}
	}
	s.Total = len(e.Chunks)
	for _, c := range e.Chunks {
		if c.Status == "active" {
			s.ActiveChunk = c.Label
			break
		}
	}
	if s.ActiveChunk == "" {
		for _, c := range e.Chunks {
			if c.Status != "done" && c.Status != "skipped" {
				s.ActiveChunk = c.Label
				break
			}
		}
	}
	return s
}

// Efforts projects the non-archived efforts, newest-updated first (input already sorted).
func Efforts(es []*waveobj.Effort) []wshrpc.EffortSummary {
	var out []wshrpc.EffortSummary
	for _, e := range es {
		if e.Status == "archived" {
			continue
		}
		out = append(out, EffortSummaryOf(e))
	}
	return out
}
```

Update `Timeline` and `Delta` to take an `efforts []*waveobj.Effort` parameter (append effort events, skipping archived efforts, honoring the window):

```go
// in Timeline, after the dossier loop:
for _, e := range efforts {
	if e.Status == "archived" {
		continue
	}
	for _, ev := range e.Events {
		add(wshrpc.TimelineEvent{Ts: ev.Ts, Kind: ev.Kind, Project: e.Project, Title: e.Title, Detail: ev.Text, NavTarget: "effort:" + e.OID})
	}
}
```

`Delta` passes `efforts` through to `Timeline`.

- [ ] **Step 4: Add the fetch seam + leg**

In `pkg/jarvisstate/fetch.go`:

```go
// in fetchSeams:
getEfforts func(ctx context.Context) ([]*waveobj.Effort, error)
// in defaultSeams:
getEfforts: wstore.GetAllEfforts,
```

In `FetchWorkState`, after the dossiers block:

```go
var efforts []*waveobj.Effort
effortsHealthy := false
if es, eerr := defaultSeams.getEfforts(ctx); eerr == nil {
	efforts = es
	effortsHealthy = true
}
st.Sources.Efforts = effortsHealthy
```

and pass `efforts` into `Timeline(...)` and `Delta(...)`, and set:

```go
st.Efforts = Efforts(efforts)
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `go test ./pkg/jarvisstate/ -run "TestEffort|TestDeltaIncludes|TestDeltaSkips" -count=1`
Then: `go test ./pkg/wshrpc/wshserver/ -run TestEffort -count=1`
Then: `go test ./pkg/wstore/ -run TestEffort -count=1`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add pkg/jarvisstate/jarvisstate.go pkg/jarvisstate/fetch.go pkg/jarvisstate/efforts_leg_test.go
git commit -m "feat(effort): WorkState efforts leg + delta events"
```

---

### Task 7: wsh effort CLI (core commands)

**Files:**
- Create: `cmd/wsh/cmd/wshcmd-effort.go`
- Create: `cmd/wsh/cmd/wshcmd-effort_test.go`

**Interfaces:**
- Consumes: `wshclient.EffortCreateCommand/EffortMutateCommand/EffortListCommand/EffortGetCommand` (generated Task 3), `preRunSetupRpcClient` (from `cmd/wsh/cmd` root), `RpcClient` global, `wshrpc.EffortOp`.
- Produces: the `effort` cobra command tree. Consumed by humans and agents; the frontend plans call the RPCs directly.

- [ ] **Step 1: Write the failing tests**

Create `cmd/wsh/cmd/wshcmd-effort_test.go` (registration pattern from `wshcmd-jarvis_test.go`):

```go
package cmd

import "testing"

func hasSub(cmd *cobra.Command, name string) bool {
	for _, c := range cmd.Commands() {
		if c.Name() == name {
			return true
		}
	}
	return false
}

func TestEffortSubcommandsRegistered(t *testing.T) {
	for _, want := range []string{"create", "list", "show", "rename", "project", "ticket", "status", "link", "unlink", "delete", "advance", "reopen", "chunk"} {
		if !hasSub(effortCmd, want) {
			t.Fatalf("`effort %s` subcommand is not registered", want)
		}
	}
	for _, want := range []string{"add", "rename", "move", "remove", "status", "note", "owner"} {
		if !hasSub(effortChunkCmd, want) {
			t.Fatalf("`effort chunk %s` subcommand is not registered", want)
		}
	}
}

func TestEffortCreateFlags(t *testing.T) {
	f := effortCreateCmd.Flags()
	for _, want := range []string{"project", "ticket", "chunk", "parent", "json"} {
		if f.Lookup(want) == nil {
			t.Fatalf("missing --%s flag", want)
		}
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go test ./cmd/wsh/cmd/ -run TestEffort -count=1`
Expected: FAIL — undefined `effortCmd`/`effortChunkCmd`/`effortCreateCmd`.

- [ ] **Step 3: Implement the CLI**

Create `cmd/wsh/cmd/wshcmd-effort.go`. Follow the `jarvis` command structure exactly (parent command + subcommands with `PreRunE: preRunSetupRpcClient`, `RunE` calling `wshclient.*`). The full file:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/spf13/cobra"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshrpc/wshclient"
)

var effortCmd = &cobra.Command{
	Use:   "effort",
	Short: "create and update Wave effort trackers (chunk lists with statuses, owners, note trails)",
}

var effortChunkCmd = &cobra.Command{
	Use:   "chunk",
	Short: "manage an effort's chunks",
}

func init() {
	effortCmd.AddCommand(effortChunkCmd)
	rootCmd.AddCommand(effortCmd)
}

func jsonOut(v any) error {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	fmt.Println(string(b))
	return nil
}

// chunkRef marshals a chunk position (1-based) or label into the op's Chunk field.
func chunkRef(op *wshrpc.EffortOp, ref string) { op.Chunk = ref }

var effortCreateCmd = &cobra.Command{
	Use:   "create <title>",
	Short: "create an effort (optionally seeding chunks)",
	Args:  cobra.ExactArgs(1),
	PreRunE: preRunSetupRpcClient,
	RunE: func(cmd *cobra.Command, args []string) error {
		chunks, _ := cmd.Flags().GetStringArray("chunk")
		parent, _ := cmd.Flags().GetString("parent")
		seed := make([]wshrpc.CommandEffortChunkSeed, 0, len(chunks))
		for _, c := range chunks {
			seed = append(seed, wshrpc.CommandEffortChunkSeed{Label: c})
		}
		rtn, err := wshclient.EffortCreateCommand(RpcClient, wshrpc.CommandEffortCreateData{
			Title: args[0],
			Project: mustFlagString(cmd, "project"),
			Ticket:  mustFlagString(cmd, "ticket"),
			ParentOID: parent,
			Chunks:    seed,
		}, nil)
		if err != nil {
			return err
		}
		if isJSON(cmd) {
			return jsonOut(rtn)
		}
		fmt.Printf("created effort %s\n", rtn.EffortOID)
		return nil
	},
}

var effortListCmd = &cobra.Command{
	Use:     "list",
	Short:   "list non-archived efforts (oid, title, done/total, active chunk)",
	PreRunE: preRunSetupRpcClient,
	RunE: func(cmd *cobra.Command, args []string) error {
		rtn, err := wshclient.EffortListCommand(RpcClient, wshrpc.CommandEffortListData{Project: mustFlagString(cmd, "project")}, nil)
		if err != nil {
			return err
		}
		if isJSON(cmd) {
			return jsonOut(rtn)
		}
		for _, s := range rtn.Efforts {
			fmt.Printf("%s\t%s\t%d/%d\t%s\n", s.ORef, s.Title, s.Done, s.Total, s.ActiveChunk)
		}
		return nil
	},
}

var effortShowCmd = &cobra.Command{
	Use:     "show <effort>",
	Short:   "show an effort's full detail (chunks, statuses, owners, note trails)",
	Args:    cobra.ExactArgs(1),
	PreRunE: preRunSetupRpcClient,
	RunE: func(cmd *cobra.Command, args []string) error {
		rtn, err := wshclient.EffortGetCommand(RpcClient, wshrpc.CommandEffortGetData{EffortOID: args[0]}, nil)
		if err != nil {
			return err
		}
		if isJSON(cmd) {
			return jsonOut(rtn)
		}
		e := rtn.Effort
		fmt.Printf("# %s (%s) — %d/%d\n", e.Title, e.Status, countDone(e), len(e.Chunks))
		for i, c := range e.Chunks {
			fmt.Printf("  %d. [%s] %s%s\n", i+1, c.Status, c.Label, ownerSuffix(c.Owner))
			for _, n := range c.Notes {
				fmt.Printf("      · %s: %s\n", timeStr(n.Ts), n.Text)
			}
		}
		return nil
	},
}

var effortRenameCmd = &cobra.Command{
	Use:     "rename <effort> <title>",
	Short:   "retitle an effort",
	Args:    cobra.ExactArgs(2),
	PreRunE: preRunSetupRpcClient,
	RunE: func(cmd *cobra.Command, args []string) error {
		return mutateOne(args[0], wshrpc.EffortOp{Op: "rename", Title: args[1]})
	},
}

var effortProjectCmd = &cobra.Command{
	Use:     "project <effort> <project|\"\">",
	Short:   "set or clear an effort's project",
	Args:    cobra.ExactArgs(2),
	PreRunE: preRunSetupRpcClient,
	RunE: func(cmd *cobra.Command, args []string) error {
		return mutateOne(args[0], wshrpc.EffortOp{Op: "setProject", Project: args[1]})
	},
}

var effortTicketCmd = &cobra.Command{
	Use:     "ticket <effort> <ticket|\"\">",
	Short:   "set or clear an effort's ticket",
	Args:    cobra.ExactArgs(2),
	PreRunE: preRunSetupRpcClient,
	RunE: func(cmd *cobra.Command, args []string) error {
		return mutateOne(args[0], wshrpc.EffortOp{Op: "setTicket", Ticket: args[1]})
	},
}

var effortStatusCmd = &cobra.Command{
	Use:     "status <effort> <active|paused|done|archived>",
	Short:   "set an effort's status",
	Args:    cobra.ExactArgs(2),
	PreRunE: preRunSetupRpcClient,
	RunE: func(cmd *cobra.Command, args []string) error {
		return mutateOne(args[0], wshrpc.EffortOp{Op: "setStatus", Status: args[1]})
	},
}

var effortLinkCmd = &cobra.Command{
	Use:     "link <effort> --parent <effort>",
	Short:   "link an effort under a parent",
	Args:    cobra.ExactArgs(1),
	PreRunE: preRunSetupRpcClient,
	RunE: func(cmd *cobra.Command, args []string) error {
		parent, _ := cmd.Flags().GetString("parent")
		return mutateOne(args[0], wshrpc.EffortOp{Op: "link", ParentOID: parent})
	},
}

var effortUnlinkCmd = &cobra.Command{
	Use:     "unlink <effort>",
	Short:   "clear an effort's parent link",
	Args:    cobra.ExactArgs(1),
	PreRunE: preRunSetupRpcClient,
	RunE: func(cmd *cobra.Command, args []string) error {
		return mutateOne(args[0], wshrpc.EffortOp{Op: "link", ParentOID: ""})
	},
}

var effortDeleteCmd = &cobra.Command{
	Use:     "delete <effort> [--force]",
	Short:   "delete an effort (refuses unless archived or --force)",
	Args:    cobra.ExactArgs(1),
	PreRunE: preRunSetupRpcClient,
	RunE: func(cmd *cobra.Command, args []string) error {
		force, _ := cmd.Flags().GetBool("force")
		rtn, err := wshclient.EffortGetCommand(RpcClient, wshrpc.CommandEffortGetData{EffortOID: args[0]}, nil)
		if err != nil {
			return err
		}
		if rtn.Effort.Status != "archived" && !force {
			return fmt.Errorf("EC-NOT-ARCHIVED: effort %s is %s — set status archived or pass --force", args[0], rtn.Effort.Status)
		}
		return wshclient.EffortDeleteCommand(RpcClient, wshrpc.CommandEffortDeleteData{EffortOID: args[0]}, nil)
	},
}

var effortAdvanceCmd = &cobra.Command{
	Use:     "advance <effort> [--note \"...\"]",
	Short:   "mark the active chunk done and activate the next non-done chunk",
	Args:    cobra.ExactArgs(1),
	PreRunE: preRunSetupRpcClient,
	RunE: func(cmd *cobra.Command, args []string) error {
		return mutateOne(args[0], wshrpc.EffortOp{Op: "advance", Note: mustFlagString(cmd, "note")})
	},
}

var effortReopenCmd = &cobra.Command{
	Use:     "reopen <effort> <chunk>",
	Short:   "reopen a done chunk (undo advance)",
	Args:    cobra.ExactArgs(2),
	PreRunE: preRunSetupRpcClient,
	RunE: func(cmd *cobra.Command, args []string) error {
		op := wshrpc.EffortOp{Op: "reopen"}
		chunkRef(&op, args[1])
		return mutateOne(args[0], op)
	},
}

var effortChunkAddCmd = &cobra.Command{
	Use:     "add <effort> \"<label>\" [--at N] [--owner X]",
	Short:   "add a chunk (phase)",
	Args:    cobra.ExactArgs(2),
	PreRunE: preRunSetupRpcClient,
	RunE: func(cmd *cobra.Command, args []string) error {
		op := wshrpc.EffortOp{Op: "addChunk", Label: args[1], Owner: mustFlagString(cmd, "owner")}
		if at, err := cmd.Flags().GetInt("at"); err == nil && at > 0 {
			op.At = &at
		}
		return mutateOne(args[0], op)
	},
}

var effortChunkRenameCmd = &cobra.Command{
	Use:     "rename <effort> <chunk> \"<label>\"",
	Short:   "rename a chunk",
	Args:    cobra.ExactArgs(3),
	PreRunE: preRunSetupRpcClient,
	RunE: func(cmd *cobra.Command, args []string) error {
		op := wshrpc.EffortOp{Op: "renameChunk", Label: args[2]}
		chunkRef(&op, args[1])
		return mutateOne(args[0], op)
	},
}

var effortChunkMoveCmd = &cobra.Command{
	Use:     "move <effort> <chunk> <at>",
	Short:   "reorder a chunk (1-based target position)",
	Args:    cobra.ExactArgs(3),
	PreRunE: preRunSetupRpcClient,
	RunE: func(cmd *cobra.Command, args []string) error {
		at, err := parseAt(args[2])
		if err != nil {
			return err
		}
		op := wshrpc.EffortOp{Op: "moveChunk", At: &at}
		chunkRef(&op, args[1])
		return mutateOne(args[0], op)
	},
}

var effortChunkRemoveCmd = &cobra.Command{
	Use:     "remove <effort> <chunk>",
	Short:   "remove a chunk",
	Args:    cobra.ExactArgs(2),
	PreRunE: preRunSetupRpcClient,
	RunE: func(cmd *cobra.Command, args []string) error {
		op := wshrpc.EffortOp{Op: "removeChunk"}
		chunkRef(&op, args[1])
		return mutateOne(args[0], op)
	},
}

var effortChunkStatusCmd = &cobra.Command{
	Use:     "status <effort> <chunk> <pending|active|done|deferred|blocked|skipped> [--note \"...\"]",
	Short:   "set a chunk's status",
	Args:    cobra.ExactArgs(3),
	PreRunE: preRunSetupRpcClient,
	RunE: func(cmd *cobra.Command, args []string) error {
		op := wshrpc.EffortOp{Op: "setChunkStatus", Status: args[2], Note: mustFlagString(cmd, "note")}
		chunkRef(&op, args[1])
		return mutateOne(args[0], op)
	},
}

var effortChunkNoteCmd = &cobra.Command{
	Use:     "note <effort> <chunk> --note \"...\"",
	Short:   "append an annotation to a chunk's trail",
	Args:    cobra.ExactArgs(2),
	PreRunE: preRunSetupRpcClient,
	RunE: func(cmd *cobra.Command, args []string) error {
		op := wshrpc.EffortOp{Op: "appendNote", Note: mustFlagString(cmd, "note")}
		chunkRef(&op, args[1])
		return mutateOne(args[0], op)
	},
}

var effortChunkOwnerCmd = &cobra.Command{
	Use:     "owner <effort> <chunk> <owner|\"\">",
	Short:   "set or clear a chunk's owner",
	Args:    cobra.ExactArgs(3),
	PreRunE: preRunSetupRpcClient,
	RunE: func(cmd *cobra.Command, args []string) error {
		op := wshrpc.EffortOp{Op: "setOwner", Owner: args[2]}
		chunkRef(&op, args[1])
		return mutateOne(args[0], op)
	},
}

// --- shared helpers ---

func mutateOne(effortOID string, op wshrpc.EffortOp) error {
	rtn, err := wshclient.EffortMutateCommand(RpcClient, wshrpc.CommandEffortMutateData{EffortOID: effortOID, Ops: []wshrpc.EffortOp{op}}, nil)
	if err != nil {
		return err
	}
	if isJSONFlagSet() {
		return jsonOut(rtn)
	}
	return nil
}

func mustFlagString(cmd *cobra.Command, name string) string {
	s, _ := cmd.Flags().GetString(name)
	return s
}

func isJSON(cmd *cobra.Command) bool {
	v, _ := cmd.Flags().GetBool("json")
	return v
}

func isJSONFlagSet() bool { return jsonGlobal }

var jsonGlobal bool

func parseAt(s string) (int, error) {
	var at int
	if _, err := fmt.Sscanf(s, "%d", &at); err != nil || at < 1 {
		return 0, fmt.Errorf("EC-INVALID-INDEX: position must be a positive integer")
	}
	return at, nil
}

func countDone(e *waveobj.Effort) int {
	n := 0
	for _, c := range e.Chunks {
		if c.Status == "done" {
			n++
		}
	}
	return n
}

func ownerSuffix(owner string) string {
	if owner == "" {
		return ""
	}
	return " (owner: " + owner + ")"
}

func timeStr(ms int64) string {
	return time.UnixMilli(ms).Format("01-02 15:04")
}
```

and import `waveobj` and `time` in the file. Then register the flags and wire the tree in a single `init()`:

```go
func init() {
	effortCreateCmd.Flags().String("project", "", "project name")
	effortCreateCmd.Flags().String("ticket", "", "ticket id")
	effortCreateCmd.Flags().StringArray("chunk", nil, "chunk label (repeatable)")
	effortCreateCmd.Flags().String("parent", "", "parent effort oid")
	effortCreateCmd.Flags().Bool("json", false, "JSON output")
	effortListCmd.Flags().String("project", "", "filter by project")
	effortListCmd.Flags().Bool("json", false, "JSON output")
	effortShowCmd.Flags().Bool("json", false, "JSON output")
	effortLinkCmd.Flags().String("parent", "", "parent effort oid")
	effortDeleteCmd.Flags().Bool("force", false, "delete without archiving first")
	effortAdvanceCmd.Flags().String("note", "", "annotation")
	effortChunkAddCmd.Flags().Int("at", 0, "1-based insert position")
	effortChunkAddCmd.Flags().String("owner", "", "chunk owner")
	effortChunkStatusCmd.Flags().String("note", "", "annotation")
	effortChunkNoteCmd.Flags().String("note", "", "annotation text (required)")
	effortChunkNoteCmd.MarkFlagRequired("note")

	effortCmd.AddCommand(effortCreateCmd, effortListCmd, effortShowCmd, effortRenameCmd,
		effortProjectCmd, effortTicketCmd, effortStatusCmd, effortLinkCmd, effortUnlinkCmd,
		effortDeleteCmd, effortAdvanceCmd, effortReopenCmd, effortChunkCmd)
	effortChunkCmd.AddCommand(effortChunkAddCmd, effortChunkRenameCmd, effortChunkMoveCmd,
		effortChunkRemoveCmd, effortChunkStatusCmd, effortChunkNoteCmd, effortChunkOwnerCmd)
	rootCmd.AddCommand(effortCmd)
}
```

Note: the `EffortDeleteCommand` referenced by `effortDeleteCmd` does not exist in the Task 3 wire set — **add it now**: extend `EffortCommands` in `pkg/wshrpc/wshrpctypes_effort.go` with `EffortDeleteCommand(ctx, CommandEffortDeleteData) error` (`CommandEffortDeleteData{EffortOID string}`), run `task generate`, and implement the handler in `wshserver_effort.go` (`wstore.DBDelete(ctx, waveobj.OType_Effort, oid)`).

Remove the duplicate `rootCmd.AddCommand(effortCmd)` from the earlier init sketch (the one above is the only registration point; the `var effortCmd = &cobra.Command{...}` block and the first `init()` at the top of the file must not re-add it).

- [ ] **Step 4: Regenerate + build + test**

Run: `task generate`, then from PowerShell:

```powershell
$env:CGO_CFLAGS="-O2 -g -I$((Get-Location).Path -replace '\\','/')/pkg/jarvisembed/csrc"
go build ./cmd/wsh/...
go test ./cmd/wsh/cmd/ -run TestEffort -count=1
```

Expected: PASS. (Human-level verification: `dist/bin/wsh.exe effort --help` lists the tree.)

- [ ] **Step 5: Commit**

```bash
git add cmd/wsh/cmd/wshcmd-effort.go cmd/wsh/cmd/wshcmd-effort_test.go pkg/wshrpc/wshrpctypes_effort.go pkg/wshrpc/wshserver/wshserver_effort.go pkg/wshrpc/wshclient frontend/app/store/wshclientapi.ts frontend/types/gotypes.d.ts
git commit -m "feat(effort): wsh effort CLI"
```

---

### Task 8: wsh jarvis status efforts line

**Files:**
- Modify: `pkg/wshrpc/wshrpctypes_jarvis.go` (CaptureStatus)
- Modify: `pkg/jarvisstate/fetch.go` (FetchCaptureStatus)
- Modify: `cmd/wsh/cmd/wshcmd-jarvisask.go` (status output)

**Interfaces:**
- Consumes: `wstore.GetAllEfforts` (Task 2).
- Produces: `wshrpc.CaptureStatus.Efforts {Active, ChunksDone, ChunksTotal int}`; the `wsh jarvis status` CLI prints an efforts line. Consumed by agents for ambient discovery.

- [ ] **Step 1: Write the failing test**

In `pkg/wshrpc/wshserver/wshserver_jarvis_test.go`, add:

```go
func TestJarvisStatusIncludesEfforts(t *testing.T) {
	ctx := context.Background()
	ws := &WshServer{}
	rtn, err := ws.EffortCreateCommand(ctx, wshrpc.CommandEffortCreateData{
		Title:  "status-effort",
		Chunks: []wshrpc.CommandEffortChunkSeed{{Label: "a"}, {Label: "b"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	cleanupEffort(t, rtn.EffortOID)
	if _, err := ws.EffortMutateCommand(ctx, wshrpc.CommandEffortMutateData{
		EffortOID: rtn.EffortOID,
		Ops:       []wshrpc.EffortOp{{Op: "setChunkStatus", Chunk: "a", Status: "done"}},
	}); err != nil {
		t.Fatal(err)
	}
	st, err := ws.JarvisStatusCommand(ctx, wshrpc.CommandJarvisStatusData{})
	if err != nil {
		t.Fatal(err)
	}
	if st.Status.Efforts.Active < 1 || st.Status.Efforts.ChunksDone < 1 || st.Status.Efforts.ChunksTotal < 2 {
		t.Fatalf("efforts accounting: %+v", st.Status.Efforts)
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `go test ./pkg/wshrpc/wshserver/ -run TestJarvisStatusIncludesEfforts -count=1`
Expected: FAIL — `Efforts` field does not exist on CaptureStatus.

- [ ] **Step 3: Implement**

In `pkg/wshrpc/wshrpctypes_jarvis.go`, add to `CaptureStatus` (find the struct near line 469):

```go
Efforts CaptureEffortsStatus `json:"efforts"`
```

and define:

```go
// CaptureEffortsStatus is the tracker accounting for the `wsh jarvis status` efforts line.
type CaptureEffortsStatus struct {
	Active      int `json:"active"`
	ChunksDone  int `json:"chunksdone"`
	ChunksTotal int `json:"chunkstotal"`
}
```

In `pkg/jarvisstate/fetch.go`, in `FetchCaptureStatus` (or the seam it uses — follow the existing function body), add:

```go
efforts, err := defaultSeams.getEfforts(ctx)
if err == nil {
	for _, e := range efforts {
		if e.Status == "archived" {
			continue
		}
		rtn.Efforts.Active++
		for _, c := range e.Chunks {
			rtn.Efforts.ChunksTotal++
			if c.Status == "done" {
				rtn.Efforts.ChunksDone++
			}
		}
	}
}
```

(Adjust to the actual shape of `FetchCaptureStatus` — read the function first and fit the accounting in.)

In `cmd/wsh/cmd/wshcmd-jarvisask.go`, in the `status` subcommand's RunE (read the existing output format first and match it), add a line:

```go
fmt.Printf("efforts: %d active · %d of %d chunks\n", st.Efforts.Active, st.Efforts.ChunksDone, st.Efforts.ChunksTotal)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `go test ./pkg/wshrpc/wshserver/ -run TestJarvisStatusIncludesEfforts -count=1`
Then the full suite:
```powershell
$env:CGO_CFLAGS="-O2 -g -I$((Get-Location).Path -replace '\\','/')/pkg/jarvisembed/csrc"
go test ./pkg/wstore/ ./pkg/jarvisstate/ ./pkg/wshrpc/wshserver/ ./cmd/wsh/cmd/ -count=1
```
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add pkg/wshrpc/wshrpctypes_jarvis.go pkg/jarvisstate/fetch.go cmd/wsh/cmd/wshcmd-jarvisask.go
git commit -m "feat(effort): jarvis status efforts line"
```

---

### Task 9: attachWork / detachWork ops

**Files:**
- Modify: `pkg/jarvisstate/effortops.go`
- Modify: `pkg/jarvisstate/effortops_test.go`

**Interfaces:**
- Consumes: `wshrpc.EffortOp` (Task 3 — the `Kind`/`ORef`/`Chunk` fields already exist), `waveobj.EffortChunk.WorkRefs` (Task 1).
- Produces: two new op kinds `"attachWork"` and `"detachWork"` handled by `ApplyEffortOps`. Used by Task 10 (CLI), Task 11 (AttachRunToChunk), Task 12 (DetachRunFromChunk).

- [ ] **Step 1: Write the failing tests**

Append to `pkg/jarvisstate/effortops_test.go`:

```go
func TestApplyOpsAttachWork(t *testing.T) {
	e := mkEffort()
	err := ApplyEffortOps(e, []wshrpc.EffortOp{{Op: "attachWork", Chunk: "Phase 2", Kind: "agent", ORef: "agent:tab-1"}}, "", now)
	if err != nil {
		t.Fatal(err)
	}
	if len(e.Chunks[1].WorkRefs) != 1 || e.Chunks[1].WorkRefs[0].ORef != "agent:tab-1" || e.Chunks[1].WorkRefs[0].Kind != "agent" {
		t.Fatalf("workrefs: %+v", e.Chunks[1].WorkRefs)
	}
	if len(e.Chunks[1].Notes) != 1 {
		t.Fatalf("auto-stamp missing: %+v", e.Chunks[1].Notes)
	}
	if len(e.Events) != 0 {
		t.Fatalf("attach must not emit delta events: %+v", e.Events)
	}
}

func TestApplyOpsAttachWorkIdempotentSameChunk(t *testing.T) {
	e := mkEffort()
	for i := 0; i < 2; i++ {
		err := ApplyEffortOps(e, []wshrpc.EffortOp{{Op: "attachWork", Chunk: "Phase 2", Kind: "agent", ORef: "agent:tab-1"}}, "", now)
		if err != nil {
			t.Fatal(err)
		}
	}
	if len(e.Chunks[1].WorkRefs) != 1 {
		t.Fatalf("duplicate refs: %+v", e.Chunks[1].WorkRefs)
	}
}

func TestApplyOpsAttachWorkConflictOtherChunk(t *testing.T) {
	e := mkEffort()
	if err := ApplyEffortOps(e, []wshrpc.EffortOp{{Op: "attachWork", Chunk: "Phase 2", Kind: "agent", ORef: "agent:tab-1"}}, "", now); err != nil {
		t.Fatal(err)
	}
	err := ApplyEffortOps(e, []wshrpc.EffortOp{{Op: "attachWork", Chunk: "Phase 3", Kind: "agent", ORef: "agent:tab-1"}}, "", now)
	expectErrCode(t, err, "EC-REF-ALREADY-ATTACHED")
}

func TestApplyOpsAttachWorkInvalidKind(t *testing.T) {
	e := mkEffort()
	err := ApplyEffortOps(e, []wshrpc.EffortOp{{Op: "attachWork", Chunk: "Phase 2", Kind: "bogus", ORef: "run:x"}}, "", now)
	expectErrCode(t, err, "EC-INVALID-KIND")
}

func TestApplyOpsDetachWork(t *testing.T) {
	e := mkEffort()
	op := wshrpc.EffortOp{Op: "attachWork", Chunk: "Phase 2", Kind: "agent", ORef: "agent:tab-1"}
	if err := ApplyEffortOps(e, []wshrpc.EffortOp{op}, "", now); err != nil {
		t.Fatal(err)
	}
	// chunk-scoped detach
	err := ApplyEffortOps(e, []wshrpc.EffortOp{{Op: "detachWork", Chunk: "Phase 2", ORef: "agent:tab-1"}}, "", now)
	if err != nil {
		t.Fatal(err)
	}
	if len(e.Chunks[1].WorkRefs) != 0 {
		t.Fatalf("refs remain: %+v", e.Chunks[1].WorkRefs)
	}
}

func TestApplyOpsDetachWorkAnyChunk(t *testing.T) {
	e := mkEffort()
	if err := ApplyEffortOps(e, []wshrpc.EffortOp{{Op: "attachWork", Chunk: "Phase 3", Kind: "run", ORef: "run:r1"}}, "", now); err != nil {
		t.Fatal(err)
	}
	// chunk omitted -> removed from whichever chunk holds it
	err := ApplyEffortOps(e, []wshrpc.EffortOp{{Op: "detachWork", ORef: "run:r1"}}, "", now)
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range e.Chunks {
		if len(c.WorkRefs) != 0 {
			t.Fatalf("refs remain: %+v", c.WorkRefs)
		}
	}
}

func TestApplyOpsDetachWorkAbsentIsNoOp(t *testing.T) {
	e := mkEffort()
	err := ApplyEffortOps(e, []wshrpc.EffortOp{{Op: "detachWork", ORef: "run:never-was"}}, "", now)
	if err != nil {
		t.Fatal(err)
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go test ./pkg/jarvisstate/ -run TestApplyOpsAttach -count=1 && go test ./pkg/jarvisstate/ -run TestApplyOpsDetach -count=1`
Expected: FAIL — `EC-UNKNOWN-OP: "attachWork"`.

- [ ] **Step 3: Implement the ops**

In `pkg/jarvisstate/effortops.go`, add to the validation pass (before the `default` case):

```go
case "attachWork":
	if op.Kind != "run" && op.Kind != "agent" {
		return fmt.Errorf("EC-INVALID-KIND: %q not one of run|agent", op.Kind)
	}
	if strings.TrimSpace(op.ORef) == "" {
		return fmt.Errorf("EC-INVALID-OREF: oref cannot be empty")
	}
	idx, err := ResolveChunkIndex(e, op.Chunk)
	if err != nil {
		return err
	}
	for i, c := range e.Chunks {
		if i == idx {
			continue
		}
		for _, w := range c.WorkRefs {
			if w.ORef == op.ORef {
				return fmt.Errorf("EC-REF-ALREADY-ATTACHED: %s is already attached to chunk %q", op.ORef, c.Label)
			}
		}
	}
case "detachWork":
	if strings.TrimSpace(op.ORef) == "" {
		return fmt.Errorf("EC-INVALID-OREF: oref cannot be empty")
	}
	if op.Chunk != "" {
		if _, err := ResolveChunkIndex(e, op.Chunk); err != nil {
			return err
		}
	}
```

and to the apply pass (before the `default` case):

```go
case "attachWork":
	idx, _ := ResolveChunkIndex(e, op.Chunk)
	ref := waveobj.ChunkWorkRef{Kind: op.Kind, ORef: op.ORef, Ts: now}
	replaced := false
	for i := range e.Chunks[idx].WorkRefs {
		if e.Chunks[idx].WorkRefs[i].ORef == op.ORef {
			e.Chunks[idx].WorkRefs[i] = ref // refresh ts; idempotent
			replaced = true
			break
		}
	}
	if !replaced {
		e.Chunks[idx].WorkRefs = append(e.Chunks[idx].WorkRefs, ref)
	}
	chunkNote(e, idx, op.Kind+" attached: "+op.ORef, now)
case "detachWork":
	removeRef := func(idx int) bool {
		out := e.Chunks[idx].WorkRefs[:0]
		removed := false
		for _, w := range e.Chunks[idx].WorkRefs {
			if w.ORef == op.ORef {
				removed = true
				continue
			}
			out = append(out, w)
		}
		e.Chunks[idx].WorkRefs = out
		return removed
	}
	if op.Chunk != "" {
		idx, _ := ResolveChunkIndex(e, op.Chunk)
		if removeRef(idx) {
			chunkNote(e, idx, "detached: "+op.ORef, now)
		}
	} else {
		for i := range e.Chunks {
			if removeRef(i) {
				chunkNote(e, i, "detached: "+op.ORef, now)
			}
		}
	}
```

Note: the `default` case already returns `EC-UNKNOWN-OP`, so the new cases must be added *before* it in both switches. The attach conflict check runs in the validation pass so an atomic batch with a conflicting attach aborts cleanly.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `go test ./pkg/jarvisstate/ -run TestApplyOps -count=1`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add pkg/jarvisstate/effortops.go pkg/jarvisstate/effortops_test.go
git commit -m "feat(effort): attach/detach workref ops"
```

---

### Task 10: wsh effort chunk attach / detach CLI

**Files:**
- Modify: `cmd/wsh/cmd/wshcmd-effort.go`
- Modify: `cmd/wsh/cmd/wshcmd-effort_test.go`

**Interfaces:**
- Consumes: `wshrpc.EffortOp{Op: "attachWork"|"detachWork", Kind, ORef, Chunk}` (Task 1), the CLI helpers from Task 7 (`mutateOne`, `chunkRef`, `mustFlagString`).
- Produces: `wsh effort chunk attach <effort> <chunk> --run <oid> | --agent <tabid>` and `wsh effort chunk detach <effort> <chunk> --run <oid> | --agent <tabid>` (chunk optional on detach). Consumed by agents claiming/relinquishing chunks.

- [ ] **Step 1: Write the failing tests**

Append to `cmd/wsh/cmd/wshcmd-effort_test.go`:

```go
func TestEffortChunkAttachDetachRegistered(t *testing.T) {
	for _, want := range []string{"attach", "detach"} {
		if !hasSub(effortChunkCmd, want) {
			t.Fatalf("`effort chunk %s` subcommand is not registered", want)
		}
	}
}

func TestEffortChunkAttachFlags(t *testing.T) {
	f := effortChunkAttachCmd.Flags()
	for _, want := range []string{"run", "agent"} {
		if f.Lookup(want) == nil {
			t.Fatalf("missing --%s flag", want)
		}
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go test ./cmd/wsh/cmd/ -run TestEffortChunkAttach -count=1`
Expected: FAIL — undefined `effortChunkAttachCmd`.

- [ ] **Step 3: Implement**

In `cmd/wsh/cmd/wshcmd-effort.go`, add:

```go
var effortChunkAttachCmd = &cobra.Command{
	Use:     "attach <effort> <chunk> --run <oid> | --agent <tabid>",
	Short:   "record that a run or agent session is working this chunk",
	Args:    cobra.ExactArgs(2),
	PreRunE: preRunSetupRpcClient,
	RunE: func(cmd *cobra.Command, args []string) error {
		kind, oref, err := workRefFromFlags(cmd)
		if err != nil {
			return err
		}
		op := wshrpc.EffortOp{Op: "attachWork", Kind: kind, ORef: oref}
		chunkRef(&op, args[1])
		return mutateOne(args[0], op)
	},
}

var effortChunkDetachCmd = &cobra.Command{
	Use:     "detach <effort> [chunk] --run <oid> | --agent <tabid>",
	Short:   "remove a run or agent workref (chunk optional: removed from whichever chunk holds it)",
	Args:    cobra.RangeArgs(1, 2),
	PreRunE: preRunSetupRpcClient,
	RunE: func(cmd *cobra.Command, args []string) error {
		kind, oref, err := workRefFromFlags(cmd)
		if err != nil {
			return err
		}
		op := wshrpc.EffortOp{Op: "detachWork", Kind: kind, ORef: oref}
		if len(args) == 2 {
			chunkRef(&op, args[1])
		}
		return mutateOne(args[0], op)
	},
}

// workRefFromFlags resolves the mutually-exclusive --run/--agent pair into a kind + oref.
func workRefFromFlags(cmd *cobra.Command) (string, string, error) {
	run, _ := cmd.Flags().GetString("run")
	agent, _ := cmd.Flags().GetString("agent")
	if run != "" && agent != "" {
		return "", "", fmt.Errorf("EC-INVALID-ARGS: pass --run or --agent, not both")
	}
	if run != "" {
		return "run", "run:" + run, nil
	}
	if agent != "" {
		return "agent", "agent:" + agent, nil
	}
	return "", "", fmt.Errorf("EC-INVALID-ARGS: pass --run <oid> or --agent <tabid>")
}
```

Register in `init()` (in the `effortChunkCmd.AddCommand` list and the flag blocks):

```go
effortChunkAttachCmd.Flags().String("run", "", "run oid")
effortChunkAttachCmd.Flags().String("agent", "", "agent tab id")
effortChunkDetachCmd.Flags().String("run", "", "run oid")
effortChunkDetachCmd.Flags().String("agent", "", "agent tab id")
```

and add both to `effortChunkCmd.AddCommand(...)`.

- [ ] **Step 4: Build + test**

Run: `go build ./cmd/wsh/... && go test ./cmd/wsh/cmd/ -run TestEffortChunkAttach -count=1`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cmd/wsh/cmd/wshcmd-effort.go cmd/wsh/cmd/wshcmd-effort_test.go
git commit -m "feat(effort): wsh effort chunk attach/detach"
```

---

### Task 11: RunEffortRef + auto-attach at run creation

**Files:**
- Modify: `pkg/waveobj/wtype.go` (Run field + `RunEffortRef` type)
- Modify: `pkg/wshrpc/wshrpctypes_runs.go` (`CommandCreateRunData`)
- Modify: `pkg/wshrpc/wshserver/wshserver_runs.go` (`CreateRunCommand`)
- Create: `pkg/jarvisstate/effortlink.go`
- Create: `pkg/jarvisstate/effortlink_test.go`

**Interfaces:**
- Consumes: `jarvisstate.ApplyEffortOps` (Task 4), `wstore.GetEffort/UpdateEffort` (Task 2), `waveobj.Effort` (Task 1).
- Produces: `jarvisstate.AttachRunToChunk(ctx, effortOID, chunkRef, runID string) error` — used by `CreateRunCommand`; consumed by the frontend composer plan via the wire fields `CommandCreateRunData.EffortOID`/`.ChunkLabel` and `waveobj.Run.EffortRef`.

- [ ] **Step 1: Write the failing tests**

Create `pkg/jarvisstate/effortlink_test.go` (real wstore via the package TestMain — confirm `pkg/jarvisstate` has a TestMain; if not, follow `pkg/wstore/wstore_maintest_test.go` and add one to this package):

```go
package jarvisstate

import (
	"context"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

func cleanupEffort(t *testing.T, oid string) {
	t.Helper()
	t.Cleanup(func() {
		if err := wstore.DBDelete(context.Background(), waveobj.OType_Effort, oid); err != nil {
			t.Errorf("cleanup effort: %v", err)
		}
	})
}

func TestAttachRunToChunk(t *testing.T) {
	ctx := context.Background()
	e := &waveobj.Effort{Title: "t", Status: "active",
		Chunks: []waveobj.EffortChunk{{Label: "Phase 1", Status: "active"}}}
	if err := wstore.CreateEffort(ctx, e); err != nil {
		t.Fatal(err)
	}
	cleanupEffort(t, e.OID)

	if err := AttachRunToChunk(ctx, e.OID, "Phase 1", "run:r1"); err != nil {
		t.Fatal(err)
	}
	got, err := wstore.GetEffort(ctx, e.OID)
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Chunks[0].WorkRefs) != 1 || got.Chunks[0].WorkRefs[0].ORef != "run:r1" {
		t.Fatalf("workref: %+v", got.Chunks[0].WorkRefs)
	}
}

func TestAttachRunToChunkIdempotent(t *testing.T) {
	ctx := context.Background()
	e := &waveobj.Effort{Title: "t", Status: "active",
		Chunks: []waveobj.EffortChunk{{Label: "Phase 1", Status: "active"}}}
	if err := wstore.CreateEffort(ctx, e); err != nil {
		t.Fatal(err)
	}
	cleanupEffort(t, e.OID)
	for i := 0; i < 2; i++ {
		if err := AttachRunToChunk(ctx, e.OID, "Phase 1", "run:r1"); err != nil {
			t.Fatal(err)
		}
	}
	got, _ := wstore.GetEffort(ctx, e.OID)
	if len(got.Chunks[0].WorkRefs) != 1 {
		t.Fatalf("not idempotent: %+v", got.Chunks[0].WorkRefs)
	}
}

func TestAttachRunToChunkUnknownEffort(t *testing.T) {
	err := AttachRunToChunk(context.Background(), "00000000-0000-0000-0000-000000000000", "Phase 1", "run:r1")
	if err == nil {
		t.Fatal("want error")
	}
}

func TestAttachRunToChunkUnknownChunk(t *testing.T) {
	ctx := context.Background()
	e := &waveobj.Effort{Title: "t", Status: "active",
		Chunks: []waveobj.EffortChunk{{Label: "Phase 1", Status: "active"}}}
	if err := wstore.CreateEffort(ctx, e); err != nil {
		t.Fatal(err)
	}
	cleanupEffort(t, e.OID)
	err := AttachRunToChunk(ctx, e.OID, "nope", "run:r1")
	if err == nil || !strings.Contains(err.Error(), "EC-UNKNOWN-CHUNK") {
		t.Fatalf("want EC-UNKNOWN-CHUNK, got %v", err)
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go test ./pkg/jarvisstate/ -run TestAttachRun -count=1`
Expected: FAIL — undefined `AttachRunToChunk` (and possibly no TestMain in the package — add one if missing).

- [ ] **Step 3: Implement the helper**

Create `pkg/jarvisstate/effortlink.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvisstate

import (
	"context"
	"time"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// AttachRunToChunk records that a run is working a chunk (idempotent; refreshes the ref ts). Used by
// CreateRunCommand when the composer picked an effort chunk. Advisory only — nothing auto-ticks.
func AttachRunToChunk(ctx context.Context, effortOID, chunkRef, runORef string) error {
	if _, err := wstore.GetEffort(ctx, effortOID); err != nil {
		return err
	}
	return wstore.UpdateEffort(ctx, effortOID, func(e *waveobj.Effort) error {
		return ApplyEffortOps(e, []wshrpc.EffortOp{{
			Op: "attachWork", Chunk: chunkRef, Kind: "run", ORef: runORef,
		}}, "", time.Now().UnixMilli())
	})
}

// DetachRunFromChunk removes a run's workref from whichever chunk holds it (idempotent). Called at
// evidence seal so a finished run stops claiming a chunk.
func DetachRunFromChunk(ctx context.Context, effortOID, runORef string) error {
	if _, err := wstore.GetEffort(ctx, effortOID); err != nil {
		return err
	}
	return wstore.UpdateEffort(ctx, effortOID, func(e *waveobj.Effort) error {
		return ApplyEffortOps(e, []wshrpc.EffortOp{{
			Op: "detachWork", ORef: runORef,
		}}, "", time.Now().UnixMilli())
	})
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `go test ./pkg/jarvisstate/ -run TestAttachRun -count=1`
Expected: PASS.

- [ ] **Step 5: Add the Run field + wire fields**

In `pkg/waveobj/wtype.go`, add to the `Run` struct (after `ParentLeadORef`):

```go
// EffortRef links a run to the effort chunk it executes (set by the composer's effort picker or
// `wsh effort chunk attach --run`). Advisory: the run never ticks the chunk automatically.
EffortRef *RunEffortRef `json:"effortref,omitempty"`
```

and define the type after the `Run` struct:

```go
type RunEffortRef struct {
	EffortOID  string `json:"effortoid"`
	ChunkLabel string `json:"chunklabel"`
}
```

In `pkg/wshrpc/wshrpctypes_runs.go`, add to `CommandCreateRunData`:

```go
EffortOID  string `json:"effortoid,omitempty"`  // optional effort tracker link (composer picker)
ChunkLabel string `json:"chunklabel,omitempty"`
```

Run `task generate`.

- [ ] **Step 6: Wire CreateRunCommand**

In `pkg/wshrpc/wshserver/wshserver_runs.go`, in `CreateRunCommand`:

1. Fetch and validate the effortref once, up front — after the required-field check and **before** `validateHarness`, so the effortref error path never depends on harness setup (import `pkg/jarvisstate` if not already imported in this file):

```go
var effortRef *waveobj.RunEffortRef
if data.EffortOID != "" {
	eff, err := wstore.GetEffort(ctx, data.EffortOID)
	if err != nil {
		return nil, fmt.Errorf("EC-UNKNOWN-EFFORT: %v", err)
	}
	if data.ChunkLabel == "" {
		return nil, fmt.Errorf("EC-UNKNOWN-CHUNK: chunklabel is required when effortoid is set")
	}
	if _, err := jarvisstate.ResolveChunkIndex(eff, data.ChunkLabel); err != nil {
		return nil, err
	}
	effortRef = &waveobj.RunEffortRef{EffortOID: data.EffortOID, ChunkLabel: data.ChunkLabel}
}
```

2. Before `wstore.AppendRun`, set it on the run:

```go
run.EffortRef = effortRef
```

3. After the identity mirror (`run.OID = run.ID`) and before the radar/dossier capture, attach (non-fatal — the run is already persisted; a failed attach only loses the live marker, the ref stays on the run):

```go
if effortRef != nil {
	proactiveAsync(func() {
		actx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if aerr := jarvisstate.AttachRunToChunk(actx, effortRef.EffortOID, effortRef.ChunkLabel, "run:"+run.ID); aerr != nil {
			log.Printf("CreateRun: attaching effort workref failed (non-fatal): %v", aerr)
		}
	})
}
```

Note: `proactiveAsync` already exists in this file (used for the proactive block); reuse it so the attach never delays worker spawn. Import `pkg/jarvisstate` if not already imported in this file.

- [ ] **Step 7: Verify + test**

```powershell
$env:CGO_CFLAGS="-O2 -g -I$((Get-Location).Path -replace '\\','/')/pkg/jarvisembed/csrc"
go build ./pkg/...
go test ./pkg/jarvisstate/ -run TestAttachRun -count=1
go test ./pkg/wshrpc/wshserver/ -run TestEffort -count=1
```

Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
git add pkg/waveobj/wtype.go pkg/wshrpc/wshrpctypes_runs.go pkg/wshrpc/wshserver/wshserver_runs.go pkg/jarvisstate/effortlink.go pkg/jarvisstate/effortlink_test.go pkg/wshrpc/wshclient frontend/app/store/wshclientapi.ts frontend/types/gotypes.d.ts
git commit -m "feat(effort): RunEffortRef + auto-attach at run creation"
```

---

### Task 12: detach at evidence seal

**Files:**
- Modify: `pkg/wshrpc/wshserver/wshserver_runs.go` (`SealRunEvidenceCommand`)
- Modify: `pkg/jarvisstate/effortlink_test.go`

**Interfaces:**
- Consumes: `jarvisstate.DetachRunFromChunk` (Task 3), `waveobj.Run.EffortRef` (Task 3).
- Produces: a sealed run no longer claims its chunk (workref removed, chunk untouched otherwise). Consumed by the frontend completion-offer plan (the offer's "mark chunk done" is a separate `setChunkStatus` call from the UI).

- [ ] **Step 1: Write the failing test**

Append to `pkg/jarvisstate/effortlink_test.go`:

```go
func TestDetachRunFromChunk(t *testing.T) {
	ctx := context.Background()
	e := &waveobj.Effort{Title: "t", Status: "active",
		Chunks: []waveobj.EffortChunk{{Label: "Phase 1", Status: "active"}}}
	if err := wstore.CreateEffort(ctx, e); err != nil {
		t.Fatal(err)
	}
	cleanupEffort(t, e.OID)
	if err := AttachRunToChunk(ctx, e.OID, "Phase 1", "run:r1"); err != nil {
		t.Fatal(err)
	}
	if err := DetachRunFromChunk(ctx, e.OID, "run:r1"); err != nil {
		t.Fatal(err)
	}
	got, err := wstore.GetEffort(ctx, e.OID)
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Chunks[0].WorkRefs) != 0 {
		t.Fatalf("workref remains: %+v", got.Chunks[0].WorkRefs)
	}
}

func TestDetachRunFromChunkIdempotent(t *testing.T) {
	ctx := context.Background()
	e := &waveobj.Effort{Title: "t", Status: "active",
		Chunks: []waveobj.EffortChunk{{Label: "Phase 1", Status: "active"}}}
	if err := wstore.CreateEffort(ctx, e); err != nil {
		t.Fatal(err)
	}
	cleanupEffort(t, e.OID)
	if err := DetachRunFromChunk(ctx, e.OID, "run:never-was"); err != nil {
		t.Fatal(err)
	}
}

func TestDetachRunFromChunkUnknownEffort(t *testing.T) {
	err := DetachRunFromChunk(context.Background(), "00000000-0000-0000-0000-000000000000", "run:r1")
	if err == nil {
		t.Fatal("want error")
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go test ./pkg/jarvisstate/ -run TestDetachRun -count=1`
Expected: FAIL — undefined `DetachRunFromChunk`.

- [ ] **Step 3: Implement the helper + wire the seal**

`DetachRunFromChunk` is already sketched in Task 3 Step 3 — implement it now (it was written together with `AttachRunToChunk`; if you skipped it there, add it to `pkg/jarvisstate/effortlink.go` now).

In `pkg/wshrpc/wshserver/wshserver_runs.go`, in `SealRunEvidenceCommand`, after the evidence `UpdateRun` block succeeds (after line ~618, before the RadarOrigin block):

```go
if run.EffortRef != nil {
	// a sealed run no longer claims its chunk; the workref is advisory, so a failure here only
	// leaves a stale marker, and the next seal attempt (idempotent backfill) re-runs the detach.
	if derr := jarvisstate.DetachRunFromChunk(ctx, run.EffortRef.EffortOID, "run:"+run.ID); derr != nil {
		log.Printf("SealRunEvidence: detaching effort workref failed (non-fatal): %v", derr)
	}
}
```

- [ ] **Step 4: Verify + full suite**

```powershell
$env:CGO_CFLAGS="-O2 -g -I$((Get-Location).Path -replace '\\','/')/pkg/jarvisembed/csrc"
go build ./pkg/...
go test ./pkg/jarvisstate/ ./pkg/wstore/ ./pkg/wshrpc/wshserver/ ./cmd/wsh/cmd/ -count=1
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add pkg/wshrpc/wshserver/wshserver_runs.go pkg/jarvisstate/effortlink.go pkg/jarvisstate/effortlink_test.go
git commit -m "feat(effort): detach workref at evidence seal"
```

---

## Self-review

- **Spec coverage:** model + migration (T1), storage (T2), wire types + codegen (T3), op semantics incl. advance/reopen/last-chunk/atomicity (T4), RPC handlers + validation + link guard + list/get/delete (T5), WorkState leg + delta kinds + archived filtering (T6), CLI core incl. delete guard + JSON (T7), jarvis status line (T8), attach/detach workref ops + conflict rule + idempotency (T9), CLI attach/detach with --run/--agent (T10), RunEffortRef + composer wire fields + auto-attach at create (T11), seal-time detach (T12).
- **Known intentional gap:** `EffortDeleteCommand` is added in Task 7 (not Task 3) — the wire type change there is flagged explicitly; regenerate before building.
- **Constraints honored:** workrefs never auto-tick; attach/detach emit no delta events; `EC-REF-ALREADY-ATTACHED` is per-effort (the spec's "attached elsewhere" guard is scoped to the effort, not global — a global check would require an all-efforts scan per op).
- **Type consistency:** `EffortSummaryOf`/`Efforts` names fixed across T5/T6; `CommandEffortMutateData{Ops []EffortOp}` fixed across T3/T4/T5/T7/T10; `EffortOp.Chunk` is the shared chunk-ref field used by all chunk ops; `AttachRunToChunk(ctx, effortOID, chunkRef, runORef)` / `DetachRunFromChunk(ctx, effortOID, runORef)` are the only entry points used by the handlers; `CommandCreateRunData.EffortOID`/`.ChunkLabel` match `RunEffortRef.EffortOID`/`.ChunkLabel`; chunk refs everywhere use the label-or-index semantics of `ResolveChunkIndex`.
- **Remaining plans (not this one):** frontend (briefing card, effort detail subject, create form, New Agent modal picker, composer picker, completion offers) and discovery (pi skill) — the spec's UI and discovery sections.
