# Run Lifecycle Timeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every Jarvis run a durable, append-only lifecycle event log and render it as a hybrid timeline (RUN group + phase groups, with click-through actions) inside the existing run card.

**Architecture:** A new `db_runevent` table is appended at the exact transitions that already persist run state (no new engine logic, no worker protocol change). A read-only RPC (`JarvisRunEventsCommand`) plus a `run:event` wps broadcast feed a pure frontend grouping model whose collapsible timeline renders in `RunBody` and reuses existing verbs (`approveGate`, `jumpToAgent`, run-strip selection, `openDag`, `openPath`) for every click target.

**Tech Stack:** Go (wavesrv backend, SQLite via sawka/txwrap + sqlx), TypeScript/React 19 + jotai (frontend), `task generate` for bindings, vitest for FE unit tests.

## Global Constraints

- **Never hand-edit generated files.** After changing wshrpc / waveobj / wps types run `task generate` and commit the generated diffs (`frontend/app/store/wshclientapi.ts`, `frontend/types/*.d.ts`, `pkg/wshrpc/wshclient/wshclient.go`).
- **Typecheck** with `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` — plain `npx tsc` stack-overflows on this repo.
- **Go tests**: `go test ./pkg/wstore/... ./pkg/orchestrate/... ./pkg/wshrpc/wshserver/...` (if a package pulls sqlite-vec CGO and fails to build, prefix with `CGO_CFLAGS=-IC:\Users\kael02\IdeaProjects\waveterm\pkg\jarvisembed\csrc`).
- **FE tests**: `npx vitest run <file>` — pure logic lives in `.ts` with `.test.ts` beside it; components stay thin and render-only (no jsdom render tests per repo convention).
- Event-log writes are **best-effort telemetry**: a failed append must never fail the run transition that already persisted (log the error, continue).
- Comments explain "why" only; lower case; only when necessary.
- No new dependencies; no new worker-side protocol (`wsh jarvis complete/hold/triage` unchanged).
- Spec: `docs/superpowers/specs/2026-08-14-run-visibility-timeline-design.md`.

---

### Task 1: Migration + `waveobj.RunEvent` + wstore event store

**Files:**
- Create: `db/migrations-wstore/000018_runevent.up.sql`
- Create: `db/migrations-wstore/000018_runevent.down.sql`
- Create: `pkg/waveobj/runevent.go`
- Create: `pkg/wstore/wstore_runevent.go`
- Test: `pkg/wstore/wstore_runevent_test.go`

**Interfaces:**
- Consumes: `wstore.WithTx` / `wstore.WithReadTxRtn` / `wstore.TxWrap` (existing; see `pkg/wstore/wstore_dag.go` for the row-pattern), `github.com/google/uuid`.
- Produces: `waveobj.RunEvent` struct + `waveobj.RunEventKind*` constants; `wstore.AppendRunEvent(ctx, channelId, runId, kind string, phaseIdx *int, detail any) (waveobj.RunEvent, error) — returns the persisted event (id+ts) so callers broadcast the exact row`; `wstore.QueryRunEvents(ctx, channelId, runId string, limit int) ([]waveobj.RunEvent, error)`.

- [ ] **Step 1: Write the failing test**

`pkg/wstore/wstore_runevent_test.go`:

```go
package wstore

import (
	"context"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func TestAppendAndQueryRunEvents(t *testing.T) {
	ctx := context.Background()
	ch := testChannel(t) // create a channel via the existing test helper (see wstore_channel_test.go)
	idx := 1
	if _, err := AppendRunEvent(ctx, ch.OID, "run-1", waveobj.RunEventKindPhaseHeld, &idx, map[string]any{"artifact": "plan.md"}); err != nil {
		t.Fatalf("append: %v", err)
	}
	if _, err := AppendRunEvent(ctx, ch.OID, "run-1", waveobj.RunEventKindCreated, nil, map[string]any{"runtime": "claude"}); err != nil {
		t.Fatalf("append: %v", err)
	}
	events, err := QueryRunEvents(ctx, ch.OID, "run-1", 0)
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	if len(events) != 2 {
		t.Fatalf("want 2 events, got %d", len(events))
	}
	// newest-first
	if events[0].Kind != waveobj.RunEventKindCreated {
		t.Fatalf("want newest-first, first kind %q", events[0].Kind)
	}
	if events[1].PhaseIdx == nil || *events[1].PhaseIdx != 1 {
		t.Fatalf("phaseidx not preserved: %v", events[1].PhaseIdx)
	}
	// channel scoping
	if other, err := QueryRunEvents(ctx, "other-channel", "run-1", 0); err != nil || len(other) != 0 {
		t.Fatalf("other channel should be empty (got %d, err %v)", len(other), err)
	}
}

func TestRunEventPrune(t *testing.T) {
	ctx := context.Background()
	ch := testChannel(t)
	for i := 0; i < maxRunEventsPerRun+10; i++ {
		if _, err := AppendRunEvent(ctx, ch.OID, "run-2", waveobj.RunEventKindCreated, nil, nil); err != nil {
			t.Fatalf("append: %v", err)
		}
	}
	events, err := QueryRunEvents(ctx, ch.OID, "run-2", 0)
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	if len(events) != maxRunEventsPerRun {
		t.Fatalf("want %d after prune, got %d", maxRunEventsPerRun, len(events))
	}
}
```

Note: if `testChannel` does not exist, mirror the channel-creation helper used in `wstore_channel_test.go` (search for `CreateChannel` or an in-memory DB init in that file). The wstore tests already set up a test database in `TestMain` (`wstore_maintest_test.go`) — do not add a second DB.

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./pkg/wstore/ -run 'TestAppendAndQueryRunEvents|TestRunEventPrune' -v`
Expected: FAIL — package does not compile (`AppendRunEvent` undefined).

- [ ] **Step 3: Create the migration**

`db/migrations-wstore/000018_runevent.up.sql`:

```sql
CREATE TABLE IF NOT EXISTS db_runevent (
    oid varchar(36) PRIMARY KEY,
    runid varchar(36) NOT NULL,
    channelid varchar(36) NOT NULL,
    ts int NOT NULL,
    kind varchar(32) NOT NULL,
    phaseidx int,
    data json NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_runevent_run ON db_runevent(runid, ts DESC);
```

`db/migrations-wstore/000018_runevent.down.sql`:

```sql
DROP TABLE IF EXISTS db_runevent;
```

- [ ] **Step 4: Create `pkg/waveobj/runevent.go`**

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package waveobj

import "encoding/json"

// RunEvent kinds (run visibility timeline). Written at the transitions that already persist run
// state; the FE timeline groups them under RUN (cross-cutting) or their phase (phaseidx set).
const (
	RunEventKindCreated        = "run-created"
	RunEventKindPhaseStarted   = "phase-started"
	RunEventKindPhaseComplete  = "phase-complete"
	RunEventKindPhaseHeld      = "phase-held"
	RunEventKindGateApproved   = "gate-approved"
	RunEventKindGateSentBack   = "gate-sent-back"
	RunEventKindTriage         = "triage"
	RunEventKindChildCreated   = "child-created"
	RunEventKindChildDone      = "child-done"
	RunEventKindChildCancelled = "child-cancelled"
	RunEventKindRunCancelled   = "run-cancelled"
	RunEventKindEvidenceSealed = "evidence-sealed"
	RunEventKindTaskSpawned    = "task-spawned"
	RunEventKindTaskStalled    = "task-stalled"
	RunEventKindDagBlocked     = "dag-blocked"
	RunEventKindDagDone        = "dag-done"
)

// Detail payload keys per kind (values are built as map[string]any by writers):
//   phase events:     "artifacts" []string, "commit" string
//   triage:           "verdict" string, "note" string
//   child events:     "childrunid" string, "goal" string, "summary" string
//   evidence-sealed:  "files" int, "addtotal" int, "deltotal" int
//   task/dag events:  "taskid" string, "failures" int
//   created:          "runtime" string, "mode" string

// RunEvent is one row of a run's append-only lifecycle log (db_runevent).
type RunEvent struct {
	ID        string          `json:"id"`
	RunID     string          `json:"runid"`
	ChannelID string          `json:"channelid"`
	Ts        int64           `json:"ts"`
	Kind      string          `json:"kind"`
	PhaseIdx  *int            `json:"phaseidx,omitempty"`
	Detail    json.RawMessage `json:"detail,omitempty"`
}
```

- [ ] **Step 5: Create `pkg/wstore/wstore_runevent.go`**

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wstore

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// maxRunEventsPerRun bounds each run's log; pruning happens on append (bounded work).
const maxRunEventsPerRun = 1000

// runEventRow is the db_runevent scan struct (sqlx db tags).
type runEventRow struct {
	OID       string `db:"oid"`
	RunID     string `db:"runid"`
	ChannelID string `db:"channelid"`
	Ts        int64  `db:"ts"`
	Kind      string `db:"kind"`
	PhaseIdx  *int   `db:"phaseidx"`
	Data      []byte `db:"data"`
}

// AppendRunEvent appends one lifecycle event to a run's log, prunes to the newest
// maxRunEventsPerRun rows, and returns the persisted event (id + ts) so the caller can broadcast the
// exact row it stored. Callers treat failures as non-fatal telemetry — the run transition they
// accompany has already persisted; a log write must never fail the run it describes.
func AppendRunEvent(ctx context.Context, channelId, runId, kind string, phaseIdx *int, detail any) (waveobj.RunEvent, error) {
	detailJSON, err := json.Marshal(detail)
	if err != nil {
		return waveobj.RunEvent{}, fmt.Errorf("run event detail: %w", err)
	}
	ev := waveobj.RunEvent{
		ID: uuid.NewString(), RunID: runId, ChannelID: channelId,
		Ts: time.Now().UnixMilli(), Kind: kind, PhaseIdx: phaseIdx, Detail: detailJSON,
	}
	return ev, WithTx(ctx, func(tx *TxWrap) error {
		tx.Exec(`INSERT INTO db_runevent (oid, runid, channelid, ts, kind, phaseidx, data)
			VALUES (?, ?, ?, ?, ?, ?, ?)`,
			ev.ID, runId, channelId, ev.Ts, kind, phaseIdx, detailJSON)
		if tx.Err != nil {
			return tx.Err
		}
		tx.Exec(`DELETE FROM db_runevent WHERE runid = ?1 AND rowid NOT IN (
			SELECT rowid FROM db_runevent WHERE runid = ?1 ORDER BY ts DESC, rowid DESC LIMIT ?2)`,
			runId, maxRunEventsPerRun)
		return tx.Err
	})
}

// QueryRunEvents returns a run's events newest-first, capped at limit rows (0/negative -> 200, max 500).
func QueryRunEvents(ctx context.Context, channelId, runId string, limit int) ([]waveobj.RunEvent, error) {
	if limit <= 0 || limit > 500 {
		limit = 200
	}
	return WithReadTxRtn(ctx, func(tx *TxWrap) ([]waveobj.RunEvent, error) {
		var rows []runEventRow
		tx.Select(&rows, `SELECT oid, runid, channelid, ts, kind, phaseidx, data FROM db_runevent
			WHERE runid = ?1 AND channelid = ?2
			ORDER BY ts DESC, rowid DESC
			LIMIT ?3`, runId, channelId, limit)
		if tx.Err != nil {
			return nil, tx.Err
		}
		out := make([]waveobj.RunEvent, 0, len(rows))
		for _, r := range rows {
			out = append(out, waveobj.RunEvent{
				ID: r.OID, RunID: r.RunID, ChannelID: r.ChannelID, Ts: r.Ts,
				Kind: r.Kind, PhaseIdx: r.PhaseIdx, Detail: json.RawMessage(r.Data),
			})
		}
		return out, nil
	})
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `go test ./pkg/wstore/ -run 'TestAppendAndQueryRunEvents|TestRunEventPrune' -v`
Expected: PASS (migrations apply at DB open; if the test DB does not auto-migrate, call the migration runner the same way `wstore_dag_test.go` does).

- [ ] **Step 7: Commit**

```bash
git add db/migrations-wstore/000018_runevent.up.sql db/migrations-wstore/000018_runevent.down.sql pkg/waveobj/runevent.go pkg/wstore/wstore_runevent.go pkg/wstore/wstore_runevent_test.go
git commit -m "feat(wstore): add run event log store (db_runevent)"
```

---

### Task 2: Wire types + RPC handler + `run:event` broadcast + generate

**Files:**
- Modify: `pkg/wshrpc/wshrpctypes_jarvis.go` (add to `JarvisCommands` interface; add `RunEventData`, `CommandJarvisRunEventsData`, `CommandJarvisRunEventsRtnData`)
- Modify: `pkg/wshrpc/wshserver/wshserver_jarvis.go` (add handler)
- Modify: `pkg/wps/wpstypes.go` (constant + `AllEvents`)
- Modify: `pkg/tsgen/tsgenevent.go` (`WaveEventDataTypes` entry)
- Run: `task generate` (regenerates wshclient.go, wshclientapi.ts, gotypes.d.ts, waveevent.d.ts — commit the diffs)
- Test: `pkg/wshrpc/wshserver/wshserver_jarvis_test.go`

**Interfaces:**
- Consumes: `waveobj.RunEvent` + `wstore.QueryRunEvents` (Task 1).
- Produces: `wshrpc.RunEventData{ChannelId, RunId, Event waveobj.RunEvent}` (the `run:event` payload); `wps.Event_RunEvent = "run:event"`; `wshclient.JarvisRunEventsCommand` (generated); FE `RunEventData` type (generated).

- [ ] **Step 1: Add the wshrpc types**

In `pkg/wshrpc/wshrpctypes_jarvis.go`:

Add to the `JarvisCommands` interface (alphabetical position near the other Jarvis commands):

```go
JarvisRunEventsCommand(ctx context.Context, data CommandJarvisRunEventsData) (*CommandJarvisRunEventsRtnData, error) // run visibility timeline: list a run's lifecycle events, newest-first
```

Add the data types (with the other jarvis command DTOs in the same file):

```go
// RunEventData is the run:event broadcast payload — the FE appends one row to the focused run's
// timeline without re-querying.
type RunEventData struct {
	ChannelId string           `json:"channelid"`
	RunId     string           `json:"runid"`
	Event     waveobj.RunEvent `json:"event"`
}

type CommandJarvisRunEventsData struct {
	ChannelId string `json:"channelid"`
	RunId     string `json:"runid"`
	Limit     int    `json:"limit,omitempty"` // 0/absent -> 200; capped at 500
}

type CommandJarvisRunEventsRtnData struct {
	Events []waveobj.RunEvent `json:"events"`
}
```

Check the file already imports `waveobj`; if not, add it.

- [ ] **Step 2: Register the event in `pkg/wps/wpstypes.go`**

In the const block (after the dag events) add:

```go
Event_RunEvent = "run:event" // type: wshrpc.RunEventData
```

Add `Event_RunEvent` to the `AllEvents` slice.

- [ ] **Step 3: Add the type mapping in `pkg/tsgen/tsgenevent.go`**

```go
wps.Event_RunEvent:         reflect.TypeOf(wshrpc.RunEventData{}),
```

- [ ] **Step 4: Run `task generate`**

Run: `task generate`
Expected: exits 0; `frontend/types/waveevent.d.ts` gains `| "run:event"` and the `RunEventData` member; `pkg/wshrpc/wshclient/wshclient.go` gains `JarvisRunEventsCommand`; `frontend/types/gotypes.d.ts` gains `CommandJarvisRunEventsData` / `CommandJarvisRunEventsRtnData` / `RunEventData`.

- [ ] **Step 5: Write the failing handler test**

In `pkg/wshrpc/wshserver/wshserver_jarvis_test.go` add a test that builds a channel + run (follow the existing test setup in that file — it uses the shared test DB harness in `wshserver_test.go`), appends two events via `wstore.AppendRunEvent`, and asserts `JarvisRunEventsCommand` returns them newest-first.

```go
func TestJarvisRunEventsCommand(t *testing.T) {
	ctx := context.Background()
	ws := &WshServer{}
	ch, err := wstore.CreateChannel(ctx, "rpc", "/p/one")
	if err != nil {
		t.Fatalf("create channel: %v", err)
	}
	if err := wstore.AppendRun(ctx, ch.OID, waveobj.Run{OID: "r-events-1", ID: "r-events-1", Goal: "test run", Status: "planning", ProjectPath: "/p/one", CreatedTs: 100}); err != nil {
		t.Fatalf("append run: %v", err)
	}
	idx := 0
	if _, err := wstore.AppendRunEvent(ctx, ch.OID, "r-events-1", waveobj.RunEventKindPhaseHeld, &idx, map[string]any{"artifacts": []string{"plan.md"}}); err != nil {
		t.Fatalf("append event: %v", err)
	}
	rtn, err := ws.JarvisRunEventsCommand(ctx, wshrpc.CommandJarvisRunEventsData{ChannelId: ch.OID, RunId: "r-events-1", Limit: 10})
	if err != nil {
		t.Fatalf("command: %v", err)
	}
	if len(rtn.Events) != 1 {
		t.Fatalf("want 1 event, got %d", len(rtn.Events))
	}
	if rtn.Events[0].Kind != waveobj.RunEventKindPhaseHeld {
		t.Fatalf("want phase-held, got %q", rtn.Events[0].Kind)
	}
	if rtn.Events[0].PhaseIdx == nil || *rtn.Events[0].PhaseIdx != 0 {
		t.Fatalf("phaseidx not preserved: %v", rtn.Events[0].PhaseIdx)
	}
}
```

Match the imports used by the other tests in this file (`context`, `wstore`, `waveobj`, `wshrpc`; the file already imports all of them).

- [ ] **Step 6: Implement the handler**

In `pkg/wshrpc/wshserver/wshserver_jarvis.go`, near the other Jarvis commands:

```go
// JarvisRunEventsCommand lists a run's lifecycle events newest-first, for the run-card timeline.
// Bounded read; the channel scoping keeps a stray caller from reading another channel's run log.
func (ws *WshServer) JarvisRunEventsCommand(ctx context.Context, data wshrpc.CommandJarvisRunEventsData) (*wshrpc.CommandJarvisRunEventsRtnData, error) {
	if data.ChannelId == "" || data.RunId == "" {
		return nil, fmt.Errorf("channelid and runid are required")
	}
	events, err := wstore.QueryRunEvents(ctx, data.ChannelId, data.RunId, data.Limit)
	if err != nil {
		return nil, err
	}
	return &wshrpc.CommandJarvisRunEventsRtnData{Events: events}, nil
}
```

Confirm `fmt` and `wstore` are imported in the file.

- [ ] **Step 7: Run tests**

Run: `go test ./pkg/wshrpc/wshserver/ -run TestJarvisRunEventsCommand -v`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add pkg/wshrpc/wshrpctypes_jarvis.go pkg/wps/wpstypes.go pkg/tsgen/tsgenevent.go pkg/wshrpc/wshserver/wshserver_jarvis.go pkg/wshrpc/wshserver/wshserver_jarvis_test.go
git add frontend/app/store/wshclientapi.ts frontend/types/gotypes.d.ts frontend/types/waveevent.d.ts pkg/wshrpc/wshclient/wshclient.go
git commit -m "feat(wshrpc): add JarvisRunEventsCommand and run:event broadcast"
```

---

### Task 3: Write points in run lifecycle handlers

**Files:**
- Modify: `pkg/wshrpc/wshserver/wshserver_runs.go` (append + broadcast at: CreateRunCommand, CreateChildRunCommand, AdvanceRunCommand, CancelRunCommand, sealDoneRunEvidence)
- Test: `pkg/wshrpc/wshserver/wshserver_runs_test.go` (extend; follow the file's existing run-creation setup)

**Interfaces:**
- Consumes: `wstore.AppendRunEvent` (Task 1), `wps.Event_RunEvent` + `wps.Broker.Publish(wps.WaveEvent{...})` (Task 2), `jarvis.ResolveRunWorkerFromMeta`, `waveobj.RunEventKind*`.
- Produces: the run's event log rows; `run:event` broadcasts scoped to `run:<id>`.

- [ ] **Step 1: Add a private append-and-broadcast helper**

At the top of `pkg/wshrpc/wshserver/wshserver_runs.go` (near `publishRunUpdate`):

```go
// appendRunEvent persists one lifecycle event and broadcasts it scoped to the run (the focused run
// card appends one row live). The broadcast carries the persisted event (id + ts) so the FE dedups and
// sorts the live row exactly like a re-query. Best-effort: a telemetry failure is logged, never fatal
// — the run transition it accompanies has already persisted.
func appendRunEvent(ctx context.Context, channelId, runId, kind string, phaseIdx *int, detail any) {
	if ev, err := wstore.AppendRunEvent(ctx, channelId, runId, kind, phaseIdx, detail); err != nil {
		log.Printf("appendRunEvent(%s): %v", kind, err)
	} else {
		wps.Broker.Publish(wps.WaveEvent{
			Event:  wps.Event_RunEvent,
			Scopes: []string{waveobj.MakeORef(waveobj.OType_Run, runId).String()},
			Data:   wshrpc.RunEventData{ChannelId: channelId, RunId: runId, Event: ev},
		})
	}
}
```

No `mustEventDetail` helper is needed in Task 3's helper — the store already serialized the detail, and the returned event carries it.

Both `wps` and `wshrpc` must be imported (the file already imports `wshrpc`, `wps`, `waveobj`, `log`).

- [ ] **Step 2: Write the failing tests**

In `pkg/wshrpc/wshserver/wshserver_run_test.go` (the file already tests `AdvanceRunCommand` with `jarvis.NewRun` + `wstore.AppendRun` + `(&WshServer{})`; follow that pattern — no harness needed). One test drives a pipeline run through its full lifecycle and asserts the log; one tests cancel. The helper `mustKinds` collects the event kinds for a run.

```go
func mustKinds(t *testing.T, ch *waveobj.Channel, runID string) []string {
	t.Helper()
	events, err := wstore.QueryRunEvents(context.Background(), ch.OID, runID, 50)
	if err != nil {
		t.Fatalf("QueryRunEvents: %v", err)
	}
	kinds := make([]string, 0, len(events))
	for _, e := range events {
		kinds = append(kinds, e.Kind)
	}
	return kinds
}

func containsKind(kinds []string, kind string) bool {
	for _, k := range kinds {
		if k == kind {
			return true
		}
	}
	return false
}

func TestRunLifecycleEventsAppended(t *testing.T) {
	ctx := context.Background()
	ch, err := wstore.CreateChannel(ctx, "events-run", t.TempDir())
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	run := jarvis.NewRun("finish it", "ws-1", ch.ProjectPath, nil, jarvis.RunMode_Pipeline, jarvis.DefaultPlaybook(), 1)
	if err := wstore.AppendRun(ctx, ch.OID, run); err != nil {
		t.Fatalf("AppendRun: %v", err)
	}
	// the RPC create path writes these; the direct handler test seeds them the same way
	phase0 := 0
	if _, err := wstore.AppendRunEvent(ctx, ch.OID, run.ID, waveobj.RunEventKindPhaseStarted, &phase0, map[string]any{}); err != nil {
		t.Fatalf("append phase-started: %v", err)
	}
	ws := &WshServer{}
	// AdvanceRunCommand spawns workers for newly-running phases at its tail; stub the spawn seam like
	// TestCompleteDefersEvidenceSeal does so the test never touches real tabs/PTYs
	origSpawn := jarvis.SpawnRunWorker
	jarvis.SpawnRunWorker = func(_ context.Context, _, _, _, _, _ string) (string, error) {
		return waveobj.MakeORef(waveobj.OType_Tab, "x").String(), nil
	}
	defer func() { jarvis.SpawnRunWorker = origSpawn }()
	advance := func(idx int, action string) {
		t.Helper()
		if err := ws.AdvanceRunCommand(ctx, wshrpc.CommandAdvanceRunData{ChannelId: ch.OID, RunId: run.ID, PhaseIdx: idx, Action: action}); err != nil {
			t.Fatalf("AdvanceRunCommand(%s): %v", action, err)
		}
	}
	// DefaultPlaybook: brainstorm(0) -> plan(1, gate) -> execute(2)
	advance(0, jarvis.RunAction_Complete) // phase-complete(0); plan auto-runs, phase-started(1) is engine-side (written by CreateRun's worker-spawn path; not asserted here)
	advance(1, jarvis.RunAction_Hold)      // phase-held(1), run awaiting-review
	advance(1, jarvis.RunAction_SendBack)  // gate-sent-back(1), plan re-opens
	advance(1, jarvis.RunAction_Hold)      // phase-held(1) again
	advance(1, jarvis.RunAction_Approve)   // gate-approved(1), execute(2) runs
	phase2 := 2
	if _, err := wstore.AppendRunEvent(ctx, ch.OID, run.ID, waveobj.RunEventKindPhaseStarted, &phase2, map[string]any{}); err != nil {
		t.Fatalf("append phase-started: %v", err)
	}
	advance(2, jarvis.RunAction_Triage) // triage on the running execute phase (RecordTriage needs running)
	advance(2, jarvis.RunAction_Complete) // run done

	kinds := mustKinds(t, ch, run.ID)
	for _, want := range []string{
		waveobj.RunEventKindPhaseStarted, waveobj.RunEventKindPhaseComplete,
		waveobj.RunEventKindPhaseHeld, waveobj.RunEventKindGateSentBack,
		waveobj.RunEventKindGateApproved, waveobj.RunEventKindTriage,
	} {
		if !containsKind(kinds, want) {
			t.Fatalf("events %v missing %q", kinds, want)
		}
	}
}

func TestRunCancelWritesRunCancelledEvent(t *testing.T) {
	ctx := context.Background()
	ch, err := wstore.CreateChannel(ctx, "cancel-events", t.TempDir())
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	run := jarvis.NewRun("cancel me", "ws-1", ch.ProjectPath, nil, jarvis.RunMode_Quick, jarvis.QuickPlaybook(), 1)
	if err := wstore.AppendRun(ctx, ch.OID, run); err != nil {
		t.Fatalf("AppendRun: %v", err)
	}
	// stopWorkerORef runs on cancel; stub the spawn seam the way TestCompleteDefersEvidenceSeal does
	if err := (&WshServer{}).CancelRunCommand(ctx, wshrpc.CommandCancelRunData{ChannelId: ch.OID, RunId: run.ID}); err != nil {
		t.Fatalf("CancelRunCommand: %v", err)
	}
	if !containsKind(mustKinds(t, ch, run.ID), waveobj.RunEventKindRunCancelled) {
		t.Fatalf("expected run-cancelled event")
	}
}
```

Check `CancelRunCommand`'s `CommandCancelRunData` shape in `wshrpctypes` before writing the cancel test and adjust field names to match; the write point inside the handler must run after the run is persisted cancelled (see Step 3).

- [ ] **Step 3: Add the write points**

In `CreateRunCommand` immediately after the `run.OID = run.ID` / `run.ChannelOID = data.ChannelId` block (BEFORE `spawnRunWorkers`, so the events are written even when spawning fails — the run is already persisted at that point):

```go
phaseIdx := 0
appendRunEvent(ctx, data.ChannelId, run.ID, waveobj.RunEventKindCreated, nil, map[string]any{"runtime": run.Runtime, "mode": run.Mode})
appendRunEvent(ctx, data.ChannelId, run.ID, waveobj.RunEventKindPhaseStarted, &phaseIdx, map[string]any{})
```

In `CreateChildRunCommand` after `spawnRunWorkers` succeeds:

```go
phaseIdx := 0
appendRunEvent(ctx, channelId, child.ID, waveobj.RunEventKindChildCreated, nil, map[string]any{
	"childrunid": child.ID, "goal": child.Goal, "mode": child.Mode,
})
appendRunEvent(ctx, channelId, child.ID, waveobj.RunEventKindPhaseStarted, &phaseIdx, map[string]any{})
```

In `AdvanceRunCommand`, after the `wstore.UpdateRun` succeeds (right after the `if err != nil { return ... }` that follows the UpdateRun call), map the applied action to an event:

```go
switch data.Action {
case jarvis.RunAction_Complete:
	appendRunEvent(ctx, data.ChannelId, data.RunId, waveobj.RunEventKindPhaseComplete, phaseIdxOf(data.PhaseIdx), map[string]any{"artifacts": data.Artifacts, "commit": data.Commit})
case jarvis.RunAction_Hold:
	appendRunEvent(ctx, data.ChannelId, data.RunId, waveobj.RunEventKindPhaseHeld, phaseIdxOf(data.PhaseIdx), map[string]any{"artifacts": data.Artifacts})
case jarvis.RunAction_Approve:
	appendRunEvent(ctx, data.ChannelId, data.RunId, waveobj.RunEventKindGateApproved, phaseIdxOf(data.PhaseIdx), map[string]any{})
case jarvis.RunAction_SendBack:
	appendRunEvent(ctx, data.ChannelId, data.RunId, waveobj.RunEventKindGateSentBack, phaseIdxOf(data.PhaseIdx), map[string]any{})
case jarvis.RunAction_Triage:
	appendRunEvent(ctx, data.ChannelId, data.RunId, waveobj.RunEventKindTriage, phaseIdxOf(data.PhaseIdx), map[string]any{"verdict": data.Verdict, "note": data.Note})
}
```

Add the helper next to `appendRunEvent`:

```go
// phaseIdxOf returns a *int for a phase index (0 also becomes non-nil so storage matches semantics).
func phaseIdxOf(idx int) *int { return &idx }
```

In the same handler, inside the existing `run.Status == jarvis.RunStatus_Done` block where `ParentNotifyLine` is checked (the child-done path), add the parent-log event. The `run` there is the child; its parent tab oref is `run.ParentLeadORef`:

```go
if line, ok := jarvis.ParentNotifyLine(run); ok {
	steerRunLead(ctx, run.ParentLeadORef, line)
	// NEW: record child terminal state on the PARENT run's log so the lead's timeline shows it.
	if m := jarvis.ResolveRunWorkerFromMeta(ctx, run.ParentLeadORef); m != nil && m.Run != nil {
		kind := waveobj.RunEventKindChildDone
		summary := ""
		if run.Status == jarvis.RunStatus_Cancelled {
			kind = waveobj.RunEventKindChildCancelled
		} else if run.Evidence != nil {
			summary = fmt.Sprintf("%d files +%d/-%d", len(run.Evidence.Files), run.Evidence.AddTotal, run.Evidence.DelTotal)
		}
		appendRunEvent(ctx, m.Channel.OID, m.Run.ID, kind, nil, map[string]any{
			"childrunid": run.ID, "goal": run.Goal, "summary": summary,
		})
	}
}
```

In `CancelRunCommand` after the run is updated to cancelled:

```go
appendRunEvent(ctx, data.ChannelId, data.RunId, waveobj.RunEventKindRunCancelled, phaseIdxOf(-1), map[string]any{})
```

`phaseIdxOf(-1)` is fine: cancelled is a run-level event, and the FE groups by `phaseidx == nil` — so use `nil` instead:

```go
appendRunEvent(ctx, data.ChannelId, data.RunId, waveobj.RunEventKindRunCancelled, nil, map[string]any{})
```

In `sealDoneRunEvidence`, after a successful seal (the function has the sealed `run.Evidence`; find where it writes the seal and add after it):

```go
if run.Evidence != nil {
	appendRunEvent(ctx, channelId, runId, waveobj.RunEventKindEvidenceSealed, nil, map[string]any{
		"files": len(run.Evidence.Files), "addtotal": run.Evidence.AddTotal, "deltotal": run.Evidence.DelTotal,
	})
}
```

- [ ] **Step 4: Run tests**

Run: `go test ./pkg/wshrpc/wshserver/ -run TestRunLifecycleEventsAppended -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add pkg/wshrpc/wshserver/wshserver_runs.go pkg/wshrpc/wshserver/wshserver_runs_test.go
git commit -m "feat(runs): write lifecycle events at run transitions"
```

---

### Task 4: DAG engine write points

**Files:**
- Modify: `pkg/orchestrate/engine.go` (append to the owning run's log at the existing publish points)
- Test: `pkg/orchestrate/engine_test.go` (extend with an event-append assertion)

**Interfaces:**
- Consumes: `wstore.AppendRunEvent` (Task 1), `waveobj.RunEventKind*` (Task 1).
- Produces: dag-scoped lifecycle events on the owning run's log (`task-spawned`, `task-stalled`, `dag-blocked`, `dag-done`). No new engine state.

- [ ] **Step 1: Add the write points**

In `pkg/orchestrate/engine.go` `ScheduleOnce`:

At the child-done notification loop (where `publishDagEvent(DagEventChildDone, g, t.ID)` is called at line ~79), append the spawn event there instead. The task-spawn event belongs where `publishDagEvent(DagEventTaskSpawned, g, taskID)` is called (line ~134):

```go
publishDagEvent(DagEventTaskSpawned, g, taskID)
// NEW: owning run's timeline shows the task launch.
appendRunEvent(ctx, g.ChannelId, g.RunID, waveobj.RunEventKindTaskSpawned, nil, map[string]any{"taskid": taskID})
```

In the stall loop (line ~71-72, where `PublishTaskStalled(ctx, g, t.ID)` is called), add after it:

```go
appendRunEvent(ctx, g.ChannelId, g.RunID, waveobj.RunEventKindTaskStalled, nil, map[string]any{"taskid": t.ID})
```

In the status-transition switch (lines ~138-148): on `DagStatus_Blocked` and `DagStatus_Done`:

```go
case DagStatus_Blocked:
	publishDagEvent(DagEventBlocked, g, "")
	appendRunEvent(ctx, g.ChannelId, g.RunID, waveobj.RunEventKindDagBlocked, nil, map[string]any{"failures": g.Failures})
	_ = NotifyLead(ctx, g, DagEventBlocked, fmt.Sprintf("%d failures", g.Failures))
case DagStatus_Done:
	publishDagEvent(DagEventComplete, g, "")
	appendRunEvent(ctx, g.ChannelId, g.RunID, waveobj.RunEventKindDagDone, nil, map[string]any{})
	_ = NotifyLead(ctx, g, DagEventComplete, "all tasks done")
```

Add a file-local helper (bottom of engine.go) so the writes stay one-liners and testable. It mirrors the wshserver helper: persist + broadcast `run:event` scoped to the owning run, so the focused run card live-appends these rows too (the engine's existing `dag:*` events reach the lead's PTY only; `run:event` reaches the FE):

```go
// appendRunEvent records a lifecycle event on the dag's owning run's log and broadcasts it to the
// focused run card. Best-effort telemetry — a failure is logged, never returned: the engine's
// scheduling must not fail over a log write.
func appendRunEvent(ctx context.Context, channelId, runId, kind string, phaseIdx *int, detail any) {
	if ev, err := wstore.AppendRunEvent(ctx, channelId, runId, kind, phaseIdx, detail); err != nil {
		log.Printf("appendRunEvent(%s): %v", kind, err)
	} else {
		wps.Broker.Publish(wps.WaveEvent{
			Event:  wps.Event_RunEvent,
			Scopes: []string{waveobj.MakeORef(waveobj.OType_Run, runId).String()},
			Data:   wshrpc.RunEventData{ChannelId: channelId, RunId: runId, Event: ev},
		})
	}
}
```

Add imports: `log` and `github.com/wavetermdev/waveterm/pkg/wshrpc` (root — import is acyclic: wshrpc root imports wps, and wshrpc only imports orchestrate from its `wshserver` subpackage, which orchestrate does not import). The store already serialized the detail, so no local marshaller is needed.

- [ ] **Step 2: Write the failing test**

In `pkg/orchestrate/engine_test.go`, extend an existing ScheduleOnce test (the file already builds a TaskGroup + run; follow its setup): after calling `ScheduleOnce` with a one-task dag that spawns a child, assert:

```go
events, err := wstore.QueryRunEvents(ctx, chID, runID, 50)
if err != nil {
	t.Fatalf("query: %v", err)
}
var sawSpawn bool
for _, e := range events {
	if e.Kind == waveobj.RunEventKindTaskSpawned {
		sawSpawn = true
	}
}
if !sawSpawn {
	t.Fatalf("expected task-spawned event on the owning run's log, got %+v", events)
}
```

- [ ] **Step 3: Run tests**

Run: `go test ./pkg/orchestrate/ -run TestScheduleOnce -v`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add pkg/orchestrate/engine.go pkg/orchestrate/engine_test.go
git commit -m "feat(orchestrate): write dag lifecycle events to the owning run's log"
```

---

### Task 5: FE state store + pure timeline model

**Files:**
- Create: `frontend/app/view/agents/runeventstore.ts`
- Create: `frontend/app/view/agents/runtimeline.ts`
- Test: `frontend/app/view/agents/runtimeline.test.ts`

**Interfaces:**
- Consumes: generated `RunEvent` type (Task 2 generate), `RpcApi.JarvisRunEventsCommand` + `TabRpcClient` (generated, Task 2), `waveEventSubscribeSingle` from `@/app/store/wps`, jotai atoms.
- Produces: `useRunEvents(runId, channelId)` hook (atom + load + live subscription); `buildRunTimeline(run, events): { groups: RunTimelineGroup[]; preview: RunEvent[] }` pure function; `runTimelineClick(payload)` dispatch stub consumed by Task 6.

- [ ] **Step 1: Write the failing model tests**

`frontend/app/view/agents/runtimeline.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildRunTimeline } from "./runtimeline";
import type { Run, RunEvent } from "@/types/gotypes";

function ev(kind: string, ts: number, phaseIdx?: number): RunEvent {
    return { id: "e" + ts, runid: "run-1", channelid: "ch", ts, kind, phaseidx: phaseIdx, detail: undefined } as RunEvent;
}

const fakeRun = { id: "run-1", phases: [ { kind: "brainstorm" }, { kind: "plan" }, { kind: "execute" } ] } as unknown as Run;

describe("buildRunTimeline", () => {
    it("groups phase events under their phase and cross-cutting events under RUN", () => {
        const events = [ev("run-created", 1), ev("phase-started", 2, 0), ev("triage", 3), ev("phase-complete", 4, 1)];
        const { groups } = buildRunTimeline(fakeRun, events);
        const runGroup = groups.find((g) => g.id === "run");
        const phase1 = groups.find((g) => g.id === "phase-1");
        expect(runGroup?.events.map((e) => e.kind)).toEqual(["triage", "run-created"]);
        expect(phase1?.events.map((e) => e.kind)).toEqual(["phase-complete", "phase-started"]);
    });

    it("preview is the last 3 events overall (newest first)", () => {
        const events = [ev("run-created", 1), ev("phase-started", 2, 0), ev("triage", 3), ev("phase-held", 4, 1)];
        const { preview } = buildRunTimeline(fakeRun, events);
        expect(preview.map((e) => e.kind)).toEqual(["phase-held", "triage", "phase-started"]);
    });

    it("returns empty groups when there are no events", () => {
        const { groups, preview } = buildRunTimeline(fakeRun, []);
        expect(groups).toEqual([]);
        expect(preview).toEqual([]);
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run frontend/app/view/agents/runtimeline.test.ts`
Expected: FAIL — `./runtimeline` module does not exist.

- [ ] **Step 3: Implement the pure model**

`frontend/app/view/agents/runtimeline.ts`:

```ts
// Copyright 2026, Command Line Inc.
//
// Pure: group a run's lifecycle events into the hybrid timeline — cross-cutting events under a RUN
// group, phase-scoped events under their phase group — plus a 3-event collapsed preview (newest
// first). Grouping does not depend on live state; the store in runeventstore.ts feeds it.

import type { Run, RunEvent } from "@/types/gotypes";

export const RUN_GROUP_ID = "run";
export const PREVIEW_COUNT = 3;

export interface RunTimelineGroup {
    id: string; // RUN_GROUP_ID or "phase-<index+1>"
    title: string; // "RUN" or "PHASE N · <kind>"
    events: RunEvent[];
}

// kinds that render under the RUN group — everything not phase-scoped.
const RUN_GROUP_KINDS = new Set([
    "run-created",
    "triage",
    "child-created",
    "child-done",
    "child-cancelled",
    "run-cancelled",
    "evidence-sealed",
    "task-spawned",
    "task-stalled",
    "dag-blocked",
    "dag-done",
]);

export function buildRunTimeline(run: Run, events: RunEvent[]): { groups: RunTimelineGroup[]; preview: RunEvent[] } {
    if (events.length === 0) {
        return { groups: [], preview: [] };
    }
    const sorted = [...events].sort((a, b) => b.ts - a.ts);
    const groups: RunTimelineGroup[] = [];
    const runEvents = sorted.filter((e) => RUN_GROUP_KINDS.has(e.kind));
    if (runEvents.length > 0) {
        groups.push({ id: RUN_GROUP_ID, title: "RUN", events: runEvents });
    }
    (run.phases ?? []).forEach((_, i) => {
        const phaseEvents = sorted.filter((e) => e.phaseidx === i);
        if (phaseEvents.length > 0) {
            groups.push({ id: `phase-${i + 1}`, title: `PHASE ${i + 1} · ${(run.phases?.[i].kind ?? "").toUpperCase()}`, events: phaseEvents });
        }
    });
    return { groups, preview: sorted.slice(0, PREVIEW_COUNT) };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run frontend/app/view/agents/runtimeline.test.ts`
Expected: PASS.

- [ ] **Step 5: Implement the state store**

`frontend/app/view/agents/runeventstore.ts`:

```ts
// Copyright 2026, Command Line Inc.
//
// Run-lifecycle event state: per-run atom, initial load via JarvisRunEventsCommand, live append via
// the run:event broadcast (scoped to run:<id>, so only the focused run's card receives it).

import { useEffect } from "react";
import { atom, useAtomValue, type PrimitiveAtom } from "jotai";
import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { waveEventSubscribeSingle } from "@/app/store/wps";
import { fireAndForget } from "@/util/util";
import type { RunEvent } from "@/types/gotypes";

const eventsAtoms = new Map<string, PrimitiveAtom<RunEvent[]>>();
const loadedRuns = new Set<string>();

function eventsAtomFor(runId: string) {
    let a = eventsAtoms.get(runId);
    if (!a) {
        a = atom<RunEvent[]>([]) as PrimitiveAtom<RunEvent[]>;
        eventsAtoms.set(runId, a);
    }
    return a;
}

async function load(runId: string, channelId: string): Promise<void> {
    if (loadedRuns.has(runId)) {
        return;
    }
    loadedRuns.add(runId);
    try {
        const rtn = await RpcApi.JarvisRunEventsCommand(TabRpcClient, { channelid: channelId, runid: runId, limit: 200 });
        globalStore.set(eventsAtomFor(runId), rtn.events ?? []);
    } catch {
        loadedRuns.delete(runId); // allow retry on transient failure
    }
}

let subscribed = false;
function ensureSubscription() {
    if (subscribed) {
        return;
    }
    subscribed = true;
    waveEventSubscribeSingle({
        eventType: "run:event",
        handler: (event) => {
            const data = event.data as { channelid: string; runid: string; event: RunEvent } | undefined;
            if (data?.runid == null || data.event == null) {
                return;
            }
            const atom = eventsAtoms.get(data.runid);
            if (!atom) {
                return; // no card is watching this run
            }
            globalStore.set(atom, (prev) => {
                const next = prev.filter((e) => e.id !== data.event.id);
                next.unshift(data.event);
                return next.slice(0, 200);
            });
        },
    });
}

// Subscribe a run card to its live event stream and load history once.
export function useRunEvents(runId: string, channelId: string): RunEvent[] {
    ensureSubscription();
    useEffect(() => {
        fireAndForget(() => load(runId, channelId));
    }, [runId, channelId]);
    return useAtomValue(eventsAtomFor(runId));
}
```

Note: `waveEventSubscribeSingle` takes `{ eventType, handler, scope? }`; for run-scoped broadcasts pass `scope: "run:" + runId` in the caller — see the `subscribeWaveEvent` pattern in `agentaskstore.ts` (that file subscribes unscoped and filters by oref; this store subscribes unscoped and filters by runid, which is safe because only the focused card holds an atom). Keep it unscoped to keep the subscription singleton; the filter is cheap.

- [ ] **Step 6: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: clean; if `waveEventSubscribeSingle`'s handler type rejects the inline cast, type `event.data` as `RunEventData` (the generated type) instead of the inline object.

- [ ] **Step 7: Run all FE tests**

Run: `npx vitest run frontend/app/view/agents/runtimeline.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add frontend/app/view/agents/runeventstore.ts frontend/app/view/agents/runtimeline.ts frontend/app/view/agents/runtimeline.test.ts
git commit -m "feat(runs): add run event store and timeline grouping model"
```

---

### Task 6: FE timeline component in the run body

**Files:**
- Create: `frontend/app/view/agents/runtimelineview.tsx` (thin render)
- Modify: `frontend/app/view/agents/runbody.tsx` (mount the component between the header and the stepper)
- Typecheck + vitest gates

**Interfaces:**
- Consumes: `useRunEvents` (Task 5), `buildRunTimeline` + `RunTimelineGroup` (Task 5), existing verbs: `jumpToAgent` (`./channelsprimitives`), `approveGate`/`sendBackGate` (`./runactions`), `setActiveRunId` (`../jarvis/jarvissubjectstore`), `openDag` (`../orchestrate/dagstore`), `getApi().openExternal` from `@/app/store/global` (the completion surface's artifact-open verb), `phaseRailIds`/`currentPhaseIndex` (`./runmodel`).

- [ ] **Step 1: Implement the component**

`frontend/app/view/agents/runtimelineview.tsx`:

```tsx
// Copyright 2026, Command Line Inc.
//
// Thin render: the collapsible hybrid timeline inside the run body. ALL derivations live in
// runtimeline.ts; this component only maps events to rows and click targets.

import { useState } from "react";
import type { Channel, Run, RunEvent } from "@/types/gotypes";
import { buildRunTimeline, type RunTimelineGroup } from "./runtimeline";
import { jumpToAgent } from "./channelsprimitives";
import { approveGate, sendBackGate } from "./runactions";
import { setActiveRunId } from "../jarvis/jarvissubjectstore";
import { openDag } from "../orchestrate/dagstore";
import { getApi } from "@/app/store/global";
import type { AgentsViewModel } from "./agents";

const KIND_TITLE: Record<string, string> = {
    "run-created": "Run created",
    "phase-started": "Phase started",
    "phase-complete": "Phase complete",
    "phase-held": "Held for review",
    "gate-approved": "Gate approved",
    "gate-sent-back": "Gate sent back",
    triage: "Triage",
    "child-created": "Child run created",
    "child-done": "Child done",
    "child-cancelled": "Child cancelled",
    "run-cancelled": "Run cancelled",
    "evidence-sealed": "Evidence sealed",
    "task-spawned": "Task spawned",
    "task-stalled": "Task stalled",
    "dag-blocked": "DAG blocked",
    "dag-done": "DAG complete",
};

export function RunTimeline({
    model, channel, run,
}: { model: AgentsViewModel; channel: Channel; run: Run }) {
    const [open, setOpen] = useState(false);
    const { groups, preview } = buildRunTimeline(run, useRunEvents(run.id, channel.oid));
    if (groups.length === 0) {
        return null; // no lifecycle data yet — render nothing (the card is a fresh run)
    }
    const visible = open ? groups : preview;
    return (
        <div className="mt-2 overflow-hidden rounded-[9px] border border-edge-mid bg-background">
            <button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 hover:bg-surface-hover">
                <span className="shrink-0 font-mono text-xxxs text-edge-strong">{open ? "▼" : "▶"}</span>
                <span className="font-mono text-xxxs font-bold uppercase tracking-[0.08em] text-muted">Timeline</span>
                <span className="text-[11px] text-secondary">{eventsCount(groups)} events</span>
                <span className="ml-auto text-[9px] text-success">● live</span>
            </button>
            <div className="max-h-[300px] overflow-y-auto border-t border-edge-mid px-3 py-2">
                {open ? (
                    groups.map((g) => <GroupSection key={g.id} group={g} channel={channel} run={run} model={model} />)
                ) : (
                    preview.map((e) => <EventRow key={e.id} event={e} channel={channel} run={run} model={model} interactive={false} />)
                )}
            </div>
        </div>
    );
}

function eventsCount(groups: RunTimelineGroup[]): number {
    return groups.reduce((n, g) => n + g.events.length, 0);
}

function GroupSection({ group, channel, run, model }: { group: RunTimelineGroup; channel: Channel; run: Run; model: AgentsViewModel }) {
    return (
        <div>
            <div className="px-1 pt-2 pb-1 font-mono text-xxxs font-bold uppercase tracking-[0.1em] text-edge-strong">{group.title}</div>
            {group.events.map((e) => <EventRow key={e.id} event={e} channel={channel} run={run} model={model} interactive />)}
        </div>
    );
}

function EventRow({ event, channel, run, model, interactive }: { event: RunEvent; channel: Channel; run: Run; model: AgentsViewModel; interactive: boolean }) {
    const onClick = interactive ? clickTarget(event, channel, run, model) : undefined;
    const artifacts = artifactsOf(event);
    return (
        <div
            onClick={onClick}
            style={onClick ? { cursor: "pointer" } : undefined}
            className="flex items-center gap-2 rounded px-1 py-0.5 font-mono text-[11px] text-secondary hover:bg-surface-hover"
        >
            <span className="shrink-0 text-xxxs text-edge-strong">{tsLabel(event.ts)}</span>
            <span className={"shrink-0 text-[10px] " + toneFor(event.kind)}>●</span>
            <span className="truncate">{rowTitle(event)}</span>
            {artifacts.length > 0 && (
                <span
                    className="ml-auto shrink-0 cursor-pointer border-b border-dotted border-edge-strong text-[10px] text-accent-soft hover:text-accent"
                    onClick={(e) => { e.stopPropagation(); openArtifact(run.projectpath, artifacts[0]); }}
                    title={`open ${artifacts[0]} in editor`}
                >
                    {artifacts[0]} ✎
                </span>
            )}
        </div>
    );
}

// openArtifact opens a run artifact the way the completion surface does (getApi().openExternal of the
// projectPath+rel join) — the artifact paths the worker reports are workspace-relative, so a bare
// openExternal would miss the file.
function openArtifact(projectPath: string, rel: string): void {
    const sep = projectPath.includes("\\") ? "\\" : "/";
    getApi().openExternal(rel.match(/^([/\\\\]|[a-zA-Z]:)/) ? rel : `${projectPath}${sep}${rel}`);
}
```

Plus the pure helpers (same file or runtimeline.ts — put them in `runtimeline.ts` so they are testable; move them there in Step 3 below, and import them here):

```ts
// runtimeline.ts additions — pure:
export function eventTitle(event: RunEvent): string;
export function eventKindTitle(kind: string): string; // KIND_TITLE lookup with fallback
export function detailOf<T>(event: RunEvent): T | undefined; // JSON.parse(event.detail)
export function artifactsOf(event: RunEvent): string[];
export function tsLabel(ts: number): string; // HH:MM local

// KIND_TONE maps event kinds onto the EXISTING status/phase tone utilities — the same token classes
// TONE_CLASS / PHASE_TONE_CLASS in runbody.tsx use. No new colors: success = progress, warning =
// attention/stall, asking = review, muted = terminal/informational.
const KIND_TONE: Record<string, string> = {
    "run-created": "text-success",
    "phase-started": "text-success",
    "phase-complete": "text-success",
    "child-created": "text-success",
    "child-done": "text-success",
    "evidence-sealed": "text-success",
    "gate-approved": "text-success",
    "task-spawned": "text-success",
    "dag-done": "text-success",
    "phase-held": "text-asking",
    "gate-sent-back": "text-warning",
    triage: "text-warning",
    "task-stalled": "text-warning",
    "dag-blocked": "text-warning",
    "child-cancelled": "text-muted",
    "run-cancelled": "text-muted",
};

// toneFor returns the tone class for an event kind (muted fallback) — feed it to a "●" dot span.
export function toneFor(kind: string): string {
    return KIND_TONE[kind] ?? "text-muted";
}
```

and the click dispatch (pure decision, testable):

```ts
// runtimeline.ts
export type TimelineClick =
    | { kind: "select-child"; childRunId: string }
    | { kind: "open-dag"; taskId: string }
    | { kind: "focus-phase"; phaseIdx: number }
    | { kind: "approve-gate"; phaseIdx: number }
    | { kind: "sendback-gate"; phaseIdx: number }
    | { kind: "open-diff" }
    | { kind: "none" };

export function clickTargetFor(event: RunEvent, run: Run): TimelineClick {
    const detail = detailOf<{ childrunid?: string; taskid?: string }>(event);
    switch (event.kind) {
        case "child-done":
        case "child-cancelled":
            return detail?.childrunid ? { kind: "select-child", childRunId: detail.childrunid } : { kind: "none" };
        case "task-stalled":
        case "dag-blocked":
            return { kind: "open-dag", taskId: detail?.taskid ?? "" };
        case "phase-started":
        case "phase-complete":
            return event.phaseidx != null ? { kind: "focus-phase", phaseIdx: event.phaseidx } : { kind: "none" };
        case "phase-held":
            return event.phaseidx != null ? { kind: "approve-gate", phaseIdx: event.phaseidx } : { kind: "none" };
        case "gate-approved":
        case "gate-sent-back":
            return event.phaseidx != null ? { kind: "focus-phase", phaseIdx: event.phaseidx } : { kind: "none" };
        case "evidence-sealed":
            return { kind: "open-diff" };
        default:
            return { kind: "none" };
    }
}
```

The component's `clickTarget` applies the decision. It needs the phase-rail node and the completion surface's evidence block scrolled into view — both plain DOM scrolls over elements that already exist (or gain one data attribute in this task), no new state:

```ts
function scrollToPhase(phaseIdx: number): void {
    document.querySelector(`[data-phase-id="${phaseIdx}"]`)?.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function clickTarget(event: RunEvent, run: Run): (() => void) | undefined {
    const t = clickTargetFor(event, run);
    switch (t.kind) {
        case "select-child":
            return () => setActiveRunId(run.channeloid, t.childRunId);
        case "open-dag":
            return () => openDag(run.dagoref ? "dag:" + run.dagoref : "");
        case "focus-phase":
            return () => scrollToPhase(t.phaseIdx);
        case "approve-gate":
            return () => fireAndForget(() => approveGate(run.channeloid, run.id, t.phaseIdx));
        case "sendback-gate":
            return () => fireAndForget(() => sendBackGate(run.channeloid, run.id, t.phaseIdx));
        case "open-diff":
            return () => document.querySelector("[data-evidence-block]")?.scrollIntoView({ behavior: "smooth", block: "start" });
        default:
            return undefined;
    }
}
```

The phase-rail node must carry `data-phase-id` and the RunCompletion evidence section `data-evidence-block`: check the rail node render (`PhaseRailNode` in runbody.tsx) and add `data-phase-id={idx}` if the attribute is absent (one attribute, no behavior change); add `data-evidence-block` to the evidence container in the RunCompletion mount (Step 2). `focus-phase` scrolls to the phase node — the phase's worker card renders immediately below it, so the card region comes into view with it (the mockup's worker-card auto-expand is dropped as unnecessary plumbing; the scroll is the primary action).

- [ ] **Step 2: Mount it in the run body**

In `frontend/app/view/agents/runbody.tsx`, import `RunTimeline` and render it in all three body branches so every run shape — pipeline, orchestrator, done — sees its timeline:

1. **Pipeline branch** — inside the scroller gutter, right after `<RunHeader ... />` (find the existing render and insert after it):

```tsx
<RunTimeline model={model} channel={channel} run={run} />
```

2. **Orchestrator branch** — inside `OrchestratorBody`, after its header/stepper section (find where it renders the lead header and insert the same line).

3. **Done branch** — inside `RunCompletion`, at the top of its evidence section, and add the `data-evidence-block` attribute to the evidence container so the evidence-sealed click scrolls to it:

```tsx
<RunTimeline model={model} channel={channel} run={run} />
<div data-evidence-block>...existing evidence content...</div>
```

The phase-held row's primary click must NOT steal the row's own artifact link — the artifact span stops propagation (already in the EventRow above). The `run` passed in is the live run from `runAtom`, so `run.projectpath` / `run.dagoref` / `run.channeloid` are always present.

- [ ] **Step 3: Move the pure helpers into runtimeline.ts and add tests**

Add `eventTitle`, `detailOf`, `artifactsOf`, `eventKindTitle`, `tsLabel`, `toneFor`, `clickTargetFor`, `TimelineClick` to `runtimeline.ts` (they were shown inline above; the component imports them). Add tests to `runtimeline.test.ts`:

```ts
it("clickTargetFor maps phase-held to approve-gate and child events to select-child", () => {
    expect(clickTargetFor(ev("phase-held", 4, 1), fakeRun)).toEqual({ kind: "approve-gate", phaseIdx: 1 });
    const childEv = { ...ev("child-done", 5), detail: JSON.stringify({ childrunid: "run-9", goal: "t" }) };
    expect(clickTargetFor(childEv, fakeRun)).toEqual({ kind: "select-child", childRunId: "run-9" });
});

it("artifactsOf extracts the first artifact from detail", () => {
    const e = { ...ev("phase-complete", 4, 1), detail: JSON.stringify({ artifacts: ["deliverable.md"] }) };
    expect(artifactsOf(e)).toEqual(["deliverable.md"]);
});

it("toneFor stays within the existing tone utilities and falls back to muted", () => {
    expect(toneFor("phase-started")).toBe("text-success");
    expect(toneFor("task-stalled")).toBe("text-warning");
    expect(toneFor("unknown-kind")).toBe("text-muted");
});
```

- [ ] **Step 4: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: clean. If the generated `RunEvent.detail` type is `string` (json.RawMessage generates as string), adjust `detailOf` to `JSON.parse(event.detail ?? "null")`.

- [ ] **Step 5: Run FE tests**

Run: `npx vitest run frontend/app/view/agents/runtimeline.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/app/view/agents/runtimelineview.tsx frontend/app/view/agents/runbody.tsx frontend/app/view/agents/runtimeline.ts frontend/app/view/agents/runtimeline.test.ts
git commit -m "feat(runs): render the hybrid lifecycle timeline in the run card"
```

---

## Final Verification

- [ ] `go test ./pkg/wstore/... ./pkg/orchestrate/... ./pkg/wshrpc/wshserver/...` — PASS
- [ ] `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` — clean
- [ ] `npx vitest run frontend/app/view/agents/` — PASS
- [ ] Manual smoke (live app): create an orchestrator run with a plan gate; open its card; the Timeline section shows `RUN` + `PHASE 1` groups; click `plan.md` on the held row and the file opens; click the held row and the Review Gate card scrolls into focus; approve the gate; the `gate-approved` event appears as the newest row in real time.