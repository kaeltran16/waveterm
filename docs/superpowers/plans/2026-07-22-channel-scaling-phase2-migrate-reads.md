# Channel Scaling Phase 2 (Migrate Reads) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Point every hot-path lookup at the Phase-1 indexed rows (`db_run`, `db_channelmessage`) and worker-tab meta instead of the `GetChannels` full-blob scan, add FE-facing per-channel row read RPCs, and cut the active-channel FE view over to assembling from a message-list + run-list + per-run WOS subscriptions — while the channel blob arrays stay dual-written as a fallback.

**Architecture:** Add row-read helpers to `wstore` (indexed `WHERE json_extract(data,'$.channeloid')=?` queries), a worker-oref → owner resolver that reads the Phase-1 `jarvis:runoref`/`jarvis:channeloref` tab meta (with a scan fallback so a missing best-effort stamp can never regress resolution), extend the owner-stamp to concierge/gatekeeper-dispatched workers, migrate the six hot-path scan sites, expose `GetChannelRuns`/`GetChannelMessages` RPCs, and repoint the active-channel FE surface. The channel blob still dual-writes, so the `channel:` WOS object keeps broadcasting on every mutation — Phase 2 uses that continued `channel:` bump as the "list membership changed, refetch IDs" signal and per-run `run:` WOS updates for live run content.

**Tech Stack:** Go (wstore/sqlx/txwrap, wshrpc), SQLite (WAL + JSON1 expression indexes), React 19 + jotai + WOS, vitest, CDP visual verification.

## Global Constraints

- **Reversible & invisible-first.** The channel blob keeps dual-writing `Messages`/`Runs` through Phase 2; nothing in this plan drops them (that is Phase 3). Every migrated read must have identical behavior to the scan it replaces. Reverting = route the read back to `GetChannels`.
- **No new wire event.** Liveness rides existing per-object `waveobj:update` (`run:` subscriptions) + the still-bumping `channel:` object. Do not invent a channel-delta event (design §Approaches, C subsumes B).
- **Never hand-edit generated files.** After any `wshrpctypes*.go` change run `task generate`; it regenerates `frontend/app/store/wshclientapi.ts`, `frontend/types/gotypes.d.ts`, `pkg/wshrpc/wshclient/wshclient.go`.
- **tsc gotcha.** Typecheck with `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (never bare `npx tsc`). Baseline is exit 0 — any error is yours.
- **DB cache-bust.** After adding/altering any `.sql` migration run `task build:backend --force` (Taskfile does not cache-bust on `db/**`). This plan adds **no** new migration (see Task C5 design note) — but if that changes, `--force` is required.
- **Per-package `-race` tests.** Backend tasks run `go test -race ./pkg/<pkg>/`. Full suite: `go test ./pkg/...` (note: a pre-existing, unrelated data race in `pkg/util/iochan` is NOT introduced here — verify with `git diff main -- pkg/util/iochan/` being empty).
- **Git (STRICT, from user CLAUDE.md).** No commits/pushes without explicit approval; batch into one feature commit at the end; do NOT add a co-author; fold this plan + the design doc into the feature commit. Windows: no PowerShell here-strings in Bash for commit messages — use multiple `-m` or `git commit -F`.
- **Only touch what the task requires.** Leave the pre-existing unstaged `docs/superpowers/briefs/2026-07-21-open-ended-improvement-scan-brief.md` change alone (not ours). Re-check branch/status before staging (shared working tree, parallel sessions).

## Design notes (decisions locked before task decomposition)

1. **Scan fallback everywhere.** `StampWorkerOwner` is best-effort (logged on failure), so a worker tab *can* be unstamped. Every meta-based resolver falls back to the old `GetChannels` scan on a meta miss. Common path = meta (O(1)); rare miss = scan (correct). This makes the migration unable to regress resolution correctness even if a stamp is missing.
2. **`handleAsk` checks `runoref` before `channeloref`.** Run workers now carry *both* meta keys (spawnRunWorkers stamps run+channel); concierge workers carry only `channeloref`. Old code tried the gatekeeper/dispatch (message) path first and run workers never matched it (they have no dispatch message), so they fell through to the run scan. Checking `runoref` first reproduces that precedence exactly.
3. **`OnWorkerExit` must NOT start posting outcomes for run workers.** Old `PostOutcome`→`ResolveDispatchChannel` only matched workers referenced by a `dispatch` message (concierge); run workers have no dispatch message, so they got no outcome. After the unified stamp, run workers *do* have `channeloref` — so the migrated path must still gate on "a dispatch message for this worker exists in the resolved channel" (a one-channel scan, bounded) before posting. Behavior-preserving.
4. **Radar keeps NO project-path index (deviation from the "add index" choice — flagged).** Radar filters by *canonicalized* project path (`canonPath`, separator-normalized — see memory `radar-channel-path-separator-gotcha`), so an exact-match `json_extract` index on the raw stored `projectpath` would not reliably match. Instead radar reads a cheap **scalar** channel→projectpath map (`SELECT oid, json_extract(data,'$.projectpath') FROM db_channel` — no blob deserialize) to pick matching channels, then `GetChannelRuns(channelId)` per match. This removes the O(session) *message-history* load (the actual A2 cost) without a useless index and without the canonPath mismatch. If the reviewer prefers the literal index, it is a trivial add — but it would be dead weight.
5. **Phase 2 FE scope = the active-channel surface only.** The rail unread badge and cross-channel ask badges read the `GetChannels` snapshot (`channelsAtom`), which still carries embedded `messages`/`runs` in Phase 2. Migrating those cross-channel aggregates to per-channel row queries would be N queries (worse). Leave them on the snapshot; Phase 3 (blob drop) adds a dedicated server-side aggregate. Documented, not built here.
6. **Per-object broadcast turns on.** `dbUpsertObjTx` currently omits `ContextAddUpdate` ("premature until Phase 2"). Phase 2 flips it on so `run:` (and `channelmessage:`) rows broadcast on commit, feeding FE per-run subscriptions. The `channel:` object still broadcasts too (blob dual-write) — that is the list-membership signal.

---

# PART A — wstore row-read helpers + per-object broadcast

### Task A1: `GetChannelRuns(ctx, channelId)` — indexed run list

**Files:**
- Modify: `pkg/wstore/wstore_channel.go` (add function near `GetRun`, ~line 209)
- Test: `pkg/wstore/wstore_channelrows_test.go` (add test)

**Interfaces:**
- Produces: `func GetChannelRuns(ctx context.Context, channelId string) ([]*waveobj.Run, error)` — every `db_run` row whose `channeloid == channelId`, ordered by `createdts` ascending (append order, matching the blob array order the FE expects).

- [ ] **Step 1: Write the failing test** in `pkg/wstore/wstore_channelrows_test.go`:

```go
// GetChannelRuns returns exactly the db_run rows for a channel, in createdts order, independent of the blob.
func TestGetChannelRuns(t *testing.T) {
	ctx := context.Background()
	ch, err := CreateChannel(ctx, "runs-query", "/p")
	if err != nil {
		t.Fatalf("create channel: %v", err)
	}
	if err := AppendRun(ctx, ch.OID, waveobj.Run{ID: "r-b", Goal: "b", Status: "planning", CreatedTs: 20}); err != nil {
		t.Fatalf("append r-b: %v", err)
	}
	if err := AppendRun(ctx, ch.OID, waveobj.Run{ID: "r-a", Goal: "a", Status: "planning", CreatedTs: 10}); err != nil {
		t.Fatalf("append r-a: %v", err)
	}
	// a run in a different channel must not leak in
	other, _ := CreateChannel(ctx, "other", "/p")
	if err := AppendRun(ctx, other.OID, waveobj.Run{ID: "r-x", Goal: "x", Status: "planning", CreatedTs: 5}); err != nil {
		t.Fatalf("append r-x: %v", err)
	}
	runs, err := GetChannelRuns(ctx, ch.OID)
	if err != nil {
		t.Fatalf("GetChannelRuns: %v", err)
	}
	if len(runs) != 2 {
		t.Fatalf("want 2 runs, got %d", len(runs))
	}
	if runs[0].ID != "r-a" || runs[1].ID != "r-b" {
		t.Fatalf("want [r-a r-b] by createdts, got [%s %s]", runs[0].ID, runs[1].ID)
	}
	if runs[0].ChannelOID != ch.OID {
		t.Fatalf("channeloid = %q, want %q", runs[0].ChannelOID, ch.OID)
	}
}
```

- [ ] **Step 2: Run it, verify it fails** (undefined `GetChannelRuns`):

Run: `go test ./pkg/wstore/ -run TestGetChannelRuns -v`
Expected: FAIL — `undefined: GetChannelRuns`

- [ ] **Step 3: Implement** in `pkg/wstore/wstore_channel.go` (add after `GetRun`):

```go
// GetChannelRuns returns the db_run rows for a channel (indexed on channeloid), in createdts order —
// the row-backed replacement for reading Channel.Runs off the blob. Pure read (read pool).
func GetChannelRuns(ctx context.Context, channelId string) ([]*waveobj.Run, error) {
	return WithReadTxRtn(ctx, func(tx *TxWrap) ([]*waveobj.Run, error) {
		query := `SELECT oid, version, data FROM db_run
			WHERE json_extract(data, '$.channeloid') = ?
			ORDER BY json_extract(data, '$.createdts') ASC`
		var rows []idDataType
		tx.Select(&rows, query, channelId)
		rtn := make([]*waveobj.Run, 0, len(rows))
		for _, row := range rows {
			obj, err := waveobj.FromJson(row.Data)
			if err != nil {
				return nil, err
			}
			waveobj.SetVersion(obj, row.Version)
			rtn = append(rtn, obj.(*waveobj.Run))
		}
		return rtn, nil
	})
}
```

Note: `idDataType` is the existing row struct in `wstore_dbops.go`; this mirrors `DBGetAllObjsByType`'s hydration loop with an added `WHERE`.

- [ ] **Step 4: Run test, verify pass**

Run: `go test ./pkg/wstore/ -run TestGetChannelRuns -v`
Expected: PASS

- [ ] **Step 5:** No commit yet (batched per Global Constraints).

---

### Task A2: `GetChannelMessages(ctx, channelId, before, limit)` — indexed message window

**Files:**
- Modify: `pkg/wstore/wstore_channel.go`
- Test: `pkg/wstore/wstore_channelrows_test.go`

**Interfaces:**
- Produces: `func GetChannelMessages(ctx context.Context, channelId string, before int64, limit int) ([]*waveobj.ChannelMessage, error)` — messages for `channelId`, most-recent-first internally (hits `idx_channelmessage_channeloid_ts`), returned **chronological ascending** (matching the blob order the FE renders). `before == 0` means "latest"; `before > 0` means "strictly older than this ts" (for load-older). `limit <= 0` falls back to a generous default.

- [ ] **Step 1: Write the failing test:**

```go
func TestGetChannelMessages(t *testing.T) {
	ctx := context.Background()
	ch, err := CreateChannel(ctx, "msgs-query", "/p")
	if err != nil {
		t.Fatalf("create channel: %v", err)
	}
	for i, ts := range []int64{10, 20, 30, 40} {
		m := NewChannelMessage("human", "you", fmt.Sprintf("m%d", i), "", ts)
		if _, err := PostChannelMessage(ctx, ch.OID, m); err != nil {
			t.Fatalf("post m%d: %v", i, err)
		}
	}
	// latest window, limit 2 -> the two newest, returned chronological (ts 30 then 40)
	got, err := GetChannelMessages(ctx, ch.OID, 0, 2)
	if err != nil {
		t.Fatalf("GetChannelMessages latest: %v", err)
	}
	if len(got) != 2 || got[0].Ts != 30 || got[1].Ts != 40 {
		t.Fatalf("latest window wrong: %+v", got)
	}
	// load-older before ts=30, limit 2 -> ts 10 then 20
	older, err := GetChannelMessages(ctx, ch.OID, 30, 2)
	if err != nil {
		t.Fatalf("GetChannelMessages older: %v", err)
	}
	if len(older) != 2 || older[0].Ts != 10 || older[1].Ts != 20 {
		t.Fatalf("older window wrong: %+v", older)
	}
}
```

(Ensure `"fmt"` is imported in the test file; it already imports `context`, `testing`, `uuid`, `waveobj` — add `fmt` if missing.)

- [ ] **Step 2: Run it, verify fail** — `undefined: GetChannelMessages`.

Run: `go test ./pkg/wstore/ -run TestGetChannelMessages -v`

- [ ] **Step 3: Implement** in `pkg/wstore/wstore_channel.go`:

```go
// DefaultChannelMessageLimit bounds a message-window fetch. Generous default per the design (true
// lazy "load older" UI is a follow-on); callers pass an explicit limit to paginate.
const DefaultChannelMessageLimit = 500

// GetChannelMessages returns a chronological (ts-ascending) window of a channel's messages from
// db_channelmessage — the row-backed replacement for reading Channel.Messages off the blob. It selects
// newest-first (hitting idx_channelmessage_channeloid_ts) then reverses to ascending. before==0 means
// latest; before>0 returns only messages strictly older than that ts (load-older). Pure read.
func GetChannelMessages(ctx context.Context, channelId string, before int64, limit int) ([]*waveobj.ChannelMessage, error) {
	if limit <= 0 {
		limit = DefaultChannelMessageLimit
	}
	return WithReadTxRtn(ctx, func(tx *TxWrap) ([]*waveobj.ChannelMessage, error) {
		var rows []idDataType
		if before > 0 {
			tx.Select(&rows, `SELECT oid, version, data FROM db_channelmessage
				WHERE json_extract(data, '$.channeloid') = ? AND json_extract(data, '$.ts') < ?
				ORDER BY json_extract(data, '$.ts') DESC LIMIT ?`, channelId, before, limit)
		} else {
			tx.Select(&rows, `SELECT oid, version, data FROM db_channelmessage
				WHERE json_extract(data, '$.channeloid') = ?
				ORDER BY json_extract(data, '$.ts') DESC LIMIT ?`, channelId, limit)
		}
		rtn := make([]*waveobj.ChannelMessage, 0, len(rows))
		for _, row := range rows {
			obj, err := waveobj.FromJson(row.Data)
			if err != nil {
				return nil, err
			}
			waveobj.SetVersion(obj, row.Version)
			rtn = append(rtn, obj.(*waveobj.ChannelMessage))
		}
		// reverse to chronological ascending (matches blob order the FE renders)
		for i, j := 0, len(rtn)-1; i < j; i, j = i+1, j-1 {
			rtn[i], rtn[j] = rtn[j], rtn[i]
		}
		return rtn, nil
	})
}
```

- [ ] **Step 4: Run test, verify pass.**

Run: `go test ./pkg/wstore/ -run TestGetChannelMessages -v`

- [ ] **Step 5:** No commit (batched).

---

### Task A3: Row-backed `GetRun` (replace the blob scan)

**Files:**
- Modify: `pkg/wstore/wstore_channel.go` (`GetRun`, lines 209-222)
- Test: `pkg/wstore/wstore_channelrows_test.go`

**Interfaces:**
- Consumes: `DBGet[*waveobj.Run]` (existing, `wstore_dbops.go`).
- Produces: `func GetRun(ctx, channelId, runId string) (*waveobj.Run, error)` — SAME signature; now reads the `db_run` row by oid (runId is the oid) instead of loading the channel blob and scanning. Verifies the row's `channeloid` matches `channelId` (guards a wrong-channel id).

- [ ] **Step 1: Write the failing test** (asserts the row is the source — seed a run row via `AppendRun`, then corrupt the blob's copy and confirm `GetRun` reflects the ROW, not the blob):

```go
func TestGetRunReadsRow(t *testing.T) {
	ctx := context.Background()
	ch, err := CreateChannel(ctx, "getrun-row", "/p")
	if err != nil {
		t.Fatalf("create channel: %v", err)
	}
	if err := AppendRun(ctx, ch.OID, waveobj.Run{ID: "r-1", Goal: "g", Status: "planning", CreatedTs: 1}); err != nil {
		t.Fatalf("append: %v", err)
	}
	// mutate ONLY the row (UpdateRun dual-writes; then hand-edit blob to diverge is overkill —
	// instead assert GetRun returns the row content and errors on wrong channel)
	got, err := GetRun(ctx, ch.OID, "r-1")
	if err != nil || got == nil || got.ID != "r-1" || got.ChannelOID != ch.OID {
		t.Fatalf("GetRun row read wrong: %+v err=%v", got, err)
	}
	if _, err := GetRun(ctx, "wrong-channel", "r-1"); err == nil {
		t.Fatalf("expected error for mismatched channel id")
	}
	if _, err := GetRun(ctx, ch.OID, "nope"); err == nil {
		t.Fatalf("expected error for missing run")
	}
}
```

- [ ] **Step 2: Run it, verify it fails** (the wrong-channel and content assertions fail against the current blob-scan `GetRun`, which ignores the row and returns a value whose `ChannelOID` may be unset in old blobs / does not validate channel):

Run: `go test ./pkg/wstore/ -run TestGetRunReadsRow -v`
Expected: FAIL (mismatched-channel case returns no error under the blob scan when the run is absent from that channel — but the blob scan errors only on missing; the content `ChannelOID` assertion also pins the new behavior). If it happens to pass, tighten by asserting the read does not require the channel blob (see Step 3 rationale) — the point is to lock row-sourcing.

- [ ] **Step 3: Implement** — replace `GetRun` body:

```go
// GetRun reads a single run by id from its db_run row (runId == oid), verifying it belongs to channelId.
// Row-backed (Phase 2); the channel blob is no longer scanned for this lookup.
func GetRun(ctx context.Context, channelId, runId string) (*waveobj.Run, error) {
	run, err := DBGet[*waveobj.Run](ctx, runId)
	if err != nil {
		return nil, err
	}
	if run == nil {
		return nil, fmt.Errorf("run %q not found", runId)
	}
	if run.ChannelOID != channelId {
		return nil, fmt.Errorf("run %q not in channel %q", runId, channelId)
	}
	return run, nil
}
```

- [ ] **Step 4: Run the FULL wstore suite** (many run handlers call `GetRun` — this proves the row read is a drop-in):

Run: `go test -race ./pkg/wstore/ -v`
Expected: PASS (all existing run/channel tests green)

- [ ] **Step 5:** No commit (batched).

---

### Task A4: Per-object `waveobj:update` broadcast on row dual-write

**Files:**
- Modify: `pkg/wstore/wstore_dbops.go` (`dbUpsertObjTx`, lines 364-387)
- Test: `pkg/wstore/wstore_channelrows_test.go`

**Interfaces:**
- Behavior change: `dbUpsertObjTx` now emits a `waveobj:update` for the row's oref (via `ContextAddUpdate`, published on the enclosing `WithTx` commit) so FE `run:` subscriptions receive live updates. `channel:` still broadcasts separately (blob path unchanged).

- [ ] **Step 1: Write the failing test** — assert an `AppendRun` accumulates a `run:` update on the tx. Use the context-update capture helper the codebase exposes; if none is easily callable in a unit test, assert indirectly via `wps` is not available in unit tests — instead assert the simplest observable: after `AppendRun`, the run row exists AND (the direct assertion) the update-accumulation path is exercised by verifying `dbUpsertObjTx` no longer carries the "no broadcast" contract. Concretely, capture updates with `waveobj.ContextGetUpdatesRtn`:

```go
func TestAppendRunBroadcastsRunUpdate(t *testing.T) {
	ctx := context.Background()
	ch, err := CreateChannel(ctx, "run-bcast", "/p")
	if err != nil {
		t.Fatalf("create channel: %v", err)
	}
	// Wrap in an explicit updates context so we can read what was queued for broadcast.
	ctx = waveobj.ContextWithUpdates(ctx)
	if err := AppendRun(ctx, ch.OID, waveobj.Run{ID: "r-1", Goal: "g", Status: "planning", CreatedTs: 1}); err != nil {
		t.Fatalf("append: %v", err)
	}
	updates := waveobj.ContextGetUpdates(ctx)
	sawRun := false
	for _, u := range updates {
		if u.OType == waveobj.OType_Run && u.OID == "r-1" {
			sawRun = true
		}
	}
	if !sawRun {
		t.Fatalf("expected a run:r-1 waveobj update to be queued, got %+v", updates)
	}
}
```

> **Executor note:** verify the exact helper names in `pkg/waveobj/ctxupdate.go` (`ContextWithUpdates`/`ContextGetUpdates` may be named differently, e.g. `ContextUpdatesBeginTx` + a getter). Read that file first and adapt the test to the real API. If no getter exists, add a tiny read-only test helper in the `waveobj` package or assert via a `wps` subscription in an integration-style test. Do NOT skip the assertion — the broadcast is the point of this task.

- [ ] **Step 2: Run it, verify it fails** (no run update queued today — `dbUpsertObjTx` is broadcast-free).

Run: `go test ./pkg/wstore/ -run TestAppendRunBroadcastsRunUpdate -v`

- [ ] **Step 3: Implement** — in `dbUpsertObjTx`, add the update inside the `WithTx` (mirroring `DBInsert`), and update the doc comment:

```go
// dbUpsertObjTx writes val as a row AND queues a waveobj:update for its oref (published on the enclosing
// WithTx commit) so FE per-object (run:) subscriptions get live deltas — Phase 2 turned this on (Phase 1
// deliberately omitted it while nothing subscribed). Call with a tx.Context() already inside a WithTx on
// the write handle; txwrap reuses that transaction, keeping the row write atomic with the blob write.
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
		waveobj.ContextAddUpdate(ctx, waveobj.WaveObjUpdate{UpdateType: waveobj.UpdateType_Update, OType: val.GetOType(), OID: oid, Obj: val})
		return nil
	})
}
```

- [ ] **Step 4: Run test + full wstore suite, verify pass.**

Run: `go test -race ./pkg/wstore/ -v`
Expected: PASS

- [ ] **Step 5:** No commit (batched).

---

# PART B — worker-owner lookup, concierge stamp, backfill

### Task B1: `StampWorkerOwner` omits empty values + `GetWorkerOwner` reader

**Files:**
- Modify: `pkg/wstore/wstore_channel.go` (`StampWorkerOwner`, lines 236-249; add `GetWorkerOwner`)
- Test: `pkg/wstore/wstore_channelrows_test.go`

**Interfaces:**
- Produces: `func GetWorkerOwner(ctx, workerTabORef string) (runORef string, channelORef string, err error)` — reads `jarvis:runoref`/`jarvis:channeloref` off the worker tab meta; empty strings when absent. Errors only if the oref is not a tab or the tab is gone.
- Change: `StampWorkerOwner(ctx, workerTabORef, runORef, channelORef string)` now writes only the NON-empty keys (concierge workers get `channeloref` only, no empty `runoref`).

- [ ] **Step 1: Write the failing test:**

```go
func TestStampWorkerOwnerOmitsEmpty(t *testing.T) {
	ctx := context.Background()
	tabOID := uuid.NewString()
	if err := DBInsert(ctx, &waveobj.Tab{OID: tabOID, Name: "worker", Meta: waveobj.MetaMapType{}}); err != nil {
		t.Fatalf("seed tab: %v", err)
	}
	tabORef := waveobj.MakeORef(waveobj.OType_Tab, tabOID).String()
	chORef := waveobj.MakeORef(waveobj.OType_Channel, "c-1").String()
	// concierge stamp: channel only, empty run
	if err := StampWorkerOwner(ctx, tabORef, "", chORef); err != nil {
		t.Fatalf("stamp: %v", err)
	}
	runORef, gotCh, err := GetWorkerOwner(ctx, tabORef)
	if err != nil {
		t.Fatalf("GetWorkerOwner: %v", err)
	}
	if runORef != "" {
		t.Fatalf("expected empty runoref, got %q", runORef)
	}
	if gotCh != chORef {
		t.Fatalf("channeloref = %q, want %q", gotCh, chORef)
	}
}
```

- [ ] **Step 2: Run it, verify fail** — `undefined: GetWorkerOwner` (and, once defined, the empty-runoref assertion fails against the current unconditional stamp).

- [ ] **Step 3: Implement** — replace `StampWorkerOwner` body and add `GetWorkerOwner`:

```go
// StampWorkerOwner records the owning run/channel oref on a worker tab's meta (only the non-empty ones —
// concierge workers pass runORef=="" and get channeloref only). Best-effort: a non-tab oref or a gone
// tab returns an error for the caller to log-and-continue; never mutates unrelated state.
func StampWorkerOwner(ctx context.Context, workerTabORef, runORef, channelORef string) error {
	oref, err := waveobj.ParseORef(workerTabORef)
	if err != nil || oref.OType != waveobj.OType_Tab {
		return fmt.Errorf("bad worker oref %q: %w", workerTabORef, err)
	}
	meta := waveobj.MetaMapType{}
	if runORef != "" {
		meta[MetaKey_JarvisRunORef] = runORef
	}
	if channelORef != "" {
		meta[MetaKey_JarvisChannelORef] = channelORef
	}
	if len(meta) == 0 {
		return nil
	}
	return UpdateObjectMeta(ctx, oref, meta, false)
}

// GetWorkerOwner reads the owning run:/channel: orefs stamped on a worker tab's meta (Phase-1/2 stamp).
// Empty strings when a key is absent. Errors only for a non-tab oref or a missing tab.
func GetWorkerOwner(ctx context.Context, workerTabORef string) (runORef string, channelORef string, err error) {
	oref, perr := waveobj.ParseORef(workerTabORef)
	if perr != nil || oref.OType != waveobj.OType_Tab {
		return "", "", fmt.Errorf("bad worker oref %q: %w", workerTabORef, perr)
	}
	tab, gerr := DBMustGet[*waveobj.Tab](ctx, oref.OID)
	if gerr != nil {
		return "", "", gerr
	}
	return tab.Meta.GetString(MetaKey_JarvisRunORef, ""), tab.Meta.GetString(MetaKey_JarvisChannelORef, ""), nil
}
```

- [ ] **Step 4: Run test + existing `TestStampWorkerOwner`, verify both pass.**

Run: `go test ./pkg/wstore/ -run 'TestStampWorkerOwner|TestStampWorkerOwnerOmitsEmpty' -v`

- [ ] **Step 5:** No commit (batched).

---

### Task B2: `jarvis.ResolveRunWorkerFromMeta` (meta lookup + scan fallback)

**Files:**
- Modify: `pkg/jarvis/resolve.go` (add function; keep `ResolveRunWorker` as the fallback + parity oracle)
- Test: `pkg/jarvis/resolve_test.go`

**Interfaces:**
- Consumes: `wstore.GetWorkerOwner`, `wstore.GetRun`, `wstore.DBMustGet[*waveobj.Channel]`, `wstore.GetChannels` (fallback), `RunOwnsWorker` (phase-idx compute).
- Produces: `func ResolveRunWorkerFromMeta(ctx context.Context, askingORef string) *RunWorkerMatch` — meta → run row → channel → phase idx; on any miss/empty runoref, falls back to `ResolveRunWorker(GetChannels)`. Returns nil when no run owns the oref.

- [ ] **Step 1: Write the failing test** — parity: seed a channel+run with a worker oref in a phase (via `wstore.AppendRun` + `StampWorkerOwner`), assert `ResolveRunWorkerFromMeta` returns the same channel/run/phaseIdx as `ResolveRunWorker` over `GetChannels`; and assert the fallback path works when the stamp is missing:

```go
func TestResolveRunWorkerFromMetaParity(t *testing.T) {
	ctx := context.Background()
	ch, err := wstore.CreateChannel(ctx, "rw", "/p")
	if err != nil {
		t.Fatalf("create channel: %v", err)
	}
	workerTab := waveobj.MakeORef(waveobj.OType_Tab, uuid.NewString()).String()
	run := waveobj.Run{ID: "run-1", Goal: "g", Status: "executing", CreatedTs: 1,
		Phases: []waveobj.RunPhase{{Kind: "plan"}, {Kind: "execute", WorkerOrefs: []string{workerTab}}}}
	if err := wstore.AppendRun(ctx, ch.OID, run); err != nil {
		t.Fatalf("append run: %v", err)
	}

	// stamped path
	if err := wstore.StampWorkerOwner(ctx, workerTab,
		waveobj.MakeORef(waveobj.OType_Run, "run-1").String(),
		waveobj.MakeORef(waveobj.OType_Channel, ch.OID).String()); err != nil {
		t.Fatalf("stamp: %v", err)
	}
	m := ResolveRunWorkerFromMeta(ctx, workerTab)
	if m == nil || m.Channel.OID != ch.OID || m.Run.ID != "run-1" || m.PhaseIdx != 1 {
		t.Fatalf("meta resolve wrong: %+v", m)
	}

	// fallback path: an unstamped worker still resolves via the scan
	unstamped := waveobj.MakeORef(waveobj.OType_Tab, uuid.NewString()).String()
	run2 := waveobj.Run{ID: "run-2", Goal: "g2", Status: "executing", CreatedTs: 2,
		Phases: []waveobj.RunPhase{{Kind: "execute", WorkerOrefs: []string{unstamped}}}}
	if err := wstore.AppendRun(ctx, ch.OID, run2); err != nil {
		t.Fatalf("append run2: %v", err)
	}
	m2 := ResolveRunWorkerFromMeta(ctx, unstamped) // no stamp -> fallback scan
	if m2 == nil || m2.Run.ID != "run-2" || m2.PhaseIdx != 0 {
		t.Fatalf("fallback resolve wrong: %+v", m2)
	}
}
```

> **Executor note:** `pkg/jarvis/resolve_test.go` currently tests the pure functions with in-memory fixtures; this test needs the wstore DB (TestMain-initialized). Confirm `pkg/jarvis` tests already run against an initialized wstore (grep the package's `TestMain`/setup). If jarvis tests do NOT init wstore, place this parity test in a package that does (e.g. `pkg/wshrpc/wshserver` has DB-backed tests) OR add the minimal wstore init to the jarvis test setup mirroring `wstore`'s `TestMain`. Do not fake the DB.

- [ ] **Step 2: Run it, verify fail** — `undefined: ResolveRunWorkerFromMeta`.

- [ ] **Step 3: Implement** in `pkg/jarvis/resolve.go`:

```go
// ResolveRunWorkerFromMeta resolves the run/channel/phase owning a worker oref by reading the Phase-1/2
// owner stamp (jarvis:runoref/channeloref) off the worker tab, then loading the run + channel rows — an
// O(1) replacement for the ResolveRunWorker full scan. On any miss (unstamped worker, empty runoref, load
// error) it falls back to the scan so a best-effort stamp gap can never regress resolution. nil = no run.
func ResolveRunWorkerFromMeta(ctx context.Context, askingORef string) *RunWorkerMatch {
	runORef, channelORef, err := wstore.GetWorkerOwner(ctx, askingORef)
	if err != nil || runORef == "" || channelORef == "" {
		return resolveRunWorkerByScan(ctx, askingORef)
	}
	runRef, err1 := waveobj.ParseORef(runORef)
	chRef, err2 := waveobj.ParseORef(channelORef)
	if err1 != nil || err2 != nil {
		return resolveRunWorkerByScan(ctx, askingORef)
	}
	run, err := wstore.GetRun(ctx, chRef.OID, runRef.OID)
	if err != nil || run == nil {
		return resolveRunWorkerByScan(ctx, askingORef)
	}
	ch, err := wstore.DBMustGet[*waveobj.Channel](ctx, chRef.OID)
	if err != nil || ch == nil {
		return resolveRunWorkerByScan(ctx, askingORef)
	}
	phaseIdx := phaseIdxForWorker(run, askingORef)
	if phaseIdx < 0 {
		// stamp is stale (worker no longer in a phase) — trust the scan
		return resolveRunWorkerByScan(ctx, askingORef)
	}
	return &RunWorkerMatch{Channel: ch, Run: run, PhaseIdx: phaseIdx}
}

func phaseIdxForWorker(run *waveobj.Run, workerORef string) int {
	for pi := range run.Phases {
		for _, wo := range run.Phases[pi].WorkerOrefs {
			if wo == workerORef {
				return pi
			}
		}
	}
	return -1
}

// resolveRunWorkerByScan is the fallback: the old full scan over GetChannels.
func resolveRunWorkerByScan(ctx context.Context, askingORef string) *RunWorkerMatch {
	channels, err := wstore.GetChannels(ctx)
	if err != nil {
		return nil
	}
	return ResolveRunWorker(channels, askingORef)
}
```

Add `"context"` and `"github.com/wavetermdev/waveterm/pkg/wstore"` to `resolve.go` imports.

- [ ] **Step 4: Run test, verify pass.**

Run: `go test -race ./pkg/jarvis/ -run TestResolveRunWorkerFromMetaParity -v`

- [ ] **Step 5:** No commit (batched).

---

### Task B3: Stamp concierge/gatekeeper workers on dispatch/directive posts

**Files:**
- Modify: `pkg/wstore/wstore_channel.go` (`PostChannelMessage`, `PostChannelMessageIf` — add post-commit stamp)
- Test: `pkg/wstore/wstore_channelrows_test.go`

**Interfaces:**
- Behavior: after a `dispatch` or `directive` message with a `tab:` `RefORef` commits, best-effort `StampWorkerOwner(ctx, RefORef, "", channel:<channelId>)` so concierge/gatekeeper workers carry `jarvis:channeloref`. Logged (not fatal) on failure; never blocks the post.

- [ ] **Step 1: Write the failing test:**

```go
func TestDispatchMessageStampsWorkerChannel(t *testing.T) {
	ctx := context.Background()
	ch, err := CreateChannel(ctx, "dispatch-stamp", "/p")
	if err != nil {
		t.Fatalf("create channel: %v", err)
	}
	workerTabOID := uuid.NewString()
	if err := DBInsert(ctx, &waveobj.Tab{OID: workerTabOID, Name: "w", Meta: waveobj.MetaMapType{}}); err != nil {
		t.Fatalf("seed worker tab: %v", err)
	}
	workerTabORef := waveobj.MakeORef(waveobj.OType_Tab, workerTabOID).String()
	msg := NewChannelMessage("dispatch", "claude", "do the thing", workerTabORef, 100)
	if _, err := PostChannelMessage(ctx, ch.OID, msg); err != nil {
		t.Fatalf("post dispatch: %v", err)
	}
	_, chORef, err := GetWorkerOwner(ctx, workerTabORef)
	if err != nil {
		t.Fatalf("GetWorkerOwner: %v", err)
	}
	if chORef != waveobj.MakeORef(waveobj.OType_Channel, ch.OID).String() {
		t.Fatalf("dispatch did not stamp channeloref: got %q", chORef)
	}
}
```

- [ ] **Step 2: Run it, verify fail** (dispatch post does not stamp today).

- [ ] **Step 3: Implement** — add a helper and call it at the end of both `PostChannelMessage` and `PostChannelMessageIf` (after the `WithTx` returns nil / posted==true):

```go
// stampDispatchOwner is the concierge/gatekeeper analog of spawnRunWorkers' run stamp: when a dispatch or
// directive message links a worker tab to a channel, record the channel oref on that worker's meta so the
// worker→channel lookup (handleAsk/OnWorkerExit) is a direct read, not a full-channel scan. Best-effort.
func stampDispatchOwner(ctx context.Context, channelId string, msg *waveobj.ChannelMessage) {
	if msg.Kind != "dispatch" && msg.Kind != "directive" {
		return
	}
	oref, err := waveobj.ParseORef(msg.RefORef)
	if err != nil || oref.OType != waveobj.OType_Tab {
		return
	}
	channelORef := waveobj.MakeORef(waveobj.OType_Channel, channelId).String()
	if serr := StampWorkerOwner(ctx, msg.RefORef, "", channelORef); serr != nil {
		log.Printf("stampDispatchOwner: %v", serr)
	}
}
```

In `PostChannelMessage`, after the `if err != nil { return nil, err }` guard and before `return &msg, nil`:
```go
	stampDispatchOwner(ctx, channelId, &msg)
	return &msg, nil
```

In `PostChannelMessageIf`, after the `WithTx` returns, when `posted`:
```go
	if posted {
		stampDispatchOwner(ctx, channelId, &msg)
	}
	return posted, err
```

Add `"log"` to `wstore_channel.go` imports if missing.

- [ ] **Step 4: Run test + full wstore suite, verify pass.**

Run: `go test -race ./pkg/wstore/ -v`

- [ ] **Step 5:** No commit (batched).

---

### Task B4: One-shot backfill — stamp concierge workers from existing dispatch messages

**Files:**
- Modify: `pkg/wstore/wstore_channelrows.go` (add a second one-shot backfill with its own marker; wire into `BackfillChannelRows`)
- Test: `pkg/wstore/wstore_channelrows_test.go`

**Interfaces:**
- Produces: `func backfillConciergeOwnersOnce(ctx) error` — walk each channel's `dispatch`/`directive` messages, `StampWorkerOwner(channeloref only)` for each tab `RefORef`. Idempotent. Gated by a NEW marker `MetaKey_ConciergeOwnersBackfilled` (the Phase-1 marker already fired, so we cannot reuse it).

- [ ] **Step 1: Write the failing test** — seed a legacy channel (direct `DBInsert`) with a dispatch message referencing a seeded worker tab, run the backfill, assert the tab got `channeloref`; run twice for idempotency:

```go
func TestBackfillConciergeOwners(t *testing.T) {
	ctx := context.Background()
	workerTabOID := uuid.NewString()
	if err := DBInsert(ctx, &waveobj.Tab{OID: workerTabOID, Name: "w", Meta: waveobj.MetaMapType{}}); err != nil {
		t.Fatalf("seed worker tab: %v", err)
	}
	workerTabORef := waveobj.MakeORef(waveobj.OType_Tab, workerTabOID).String()
	legacy := &waveobj.Channel{OID: uuid.NewString(), Name: "legacy-concierge", CreatedTs: 1, Meta: waveobj.MetaMapType{},
		Messages: []waveobj.ChannelMessage{{ID: "d1", Kind: "dispatch", RefORef: workerTabORef, Text: "go", Ts: 10}}}
	if err := DBInsert(ctx, legacy); err != nil {
		t.Fatalf("seed legacy channel: %v", err)
	}
	if err := backfillConciergeOwnersOnce(ctx); err != nil {
		t.Fatalf("backfill: %v", err)
	}
	_, chORef, err := GetWorkerOwner(ctx, workerTabORef)
	if err != nil || chORef != waveobj.MakeORef(waveobj.OType_Channel, legacy.OID).String() {
		t.Fatalf("concierge backfill did not stamp: %q err=%v", chORef, err)
	}
	if err := backfillConciergeOwnersOnce(ctx); err != nil { // idempotent
		t.Fatalf("second backfill: %v", err)
	}
}
```

- [ ] **Step 2: Run it, verify fail** — `undefined: backfillConciergeOwnersOnce`.

- [ ] **Step 3: Implement** in `pkg/wstore/wstore_channelrows.go`:

```go
// MetaKey_ConciergeOwnersBackfilled marks the one-shot Phase-2 concierge-worker owner stamp as complete.
// Separate from MetaKey_ChannelRowsBackfilled (that Phase-1 marker already fired on existing data dirs).
const MetaKey_ConciergeOwnersBackfilled = "channel:conciergeownersbackfilled"

// backfillConciergeOwnersOnce stamps jarvis:channeloref onto every worker tab referenced by an existing
// dispatch/directive message, so concierge/gatekeeper workers created before Phase 2 resolve their channel
// by meta. Idempotent (StampWorkerOwner just re-sets the same key). Best-effort per worker.
func backfillConciergeOwnersOnce(ctx context.Context) error {
	channels, err := GetChannels(ctx)
	if err != nil {
		return err
	}
	stamped := 0
	for _, ch := range channels {
		channelORef := waveobj.MakeORef(waveobj.OType_Channel, ch.OID).String()
		for i := range ch.Messages {
			m := ch.Messages[i]
			if m.Kind != "dispatch" && m.Kind != "directive" {
				continue
			}
			oref, perr := waveobj.ParseORef(m.RefORef)
			if perr != nil || oref.OType != waveobj.OType_Tab {
				continue
			}
			if serr := StampWorkerOwner(ctx, m.RefORef, "", channelORef); serr != nil {
				log.Printf("concierge backfill: stamp %s: %v", m.RefORef, serr)
				continue
			}
			stamped++
		}
	}
	log.Printf("concierge-owners backfill: stamped %d workers across %d channels\n", stamped, len(channels))
	return nil
}
```

Then extend `BackfillChannelRows` to run this second pass under its own marker (mirror the existing `channelRowsBackfillDone`/`markChannelRowsBackfilled` pattern with the new key):

```go
	// Phase-2 concierge-owner stamp (separate marker; the Phase-1 marker already fired on existing dirs).
	done2, err := singletonMetaBool(ctx, MetaKey_ConciergeOwnersBackfilled)
	if err != nil {
		return err
	}
	if !done2 {
		if err := backfillConciergeOwnersOnce(ctx); err != nil {
			return err
		}
		if err := markSingletonMetaBool(ctx, MetaKey_ConciergeOwnersBackfilled); err != nil {
			return err
		}
	}
```

> **Executor note:** the existing `channelRowsBackfillDone`/`markChannelRowsBackfilled` are hardcoded to `MetaKey_ChannelRowsBackfilled`. Refactor them into `singletonMetaBool(ctx, key)` / `markSingletonMetaBool(ctx, key)` taking the key as a param (DRY), and have the Phase-1 callers pass `MetaKey_ChannelRowsBackfilled`. Keep the "no MainServer yet → not done / skip mark" semantics identical.

- [ ] **Step 4: Run test + full wstore suite, verify pass.**

Run: `go test -race ./pkg/wstore/ -v`

- [ ] **Step 5:** No commit (batched).

---

# PART C — migrate the six backend read sites

### Task C1: `JarvisDecomposeCommand` — by-id channel lookup

**Files:**
- Modify: `pkg/wshrpc/wshserver/wshserver_jarvis.go` (lines ~57-77)

- [ ] **Step 1:** No new test (behavior-preserving refactor covered by existing jarvis-decompose tests, if any; the change is a linear-scan → indexed by-id read). If a test exists, run it first to establish green.

- [ ] **Step 2: Replace** the `GetChannels`-scan block:

```go
	var channel *waveobj.Channel
	projectPath := ""
	if data.ChannelId != "" {
		if ch, err := wstore.DBMustGet[*waveobj.Channel](ctx, data.ChannelId); err == nil {
			channel = ch
			projectPath = ch.ProjectPath
		}
	}
```

- [ ] **Step 3: Verify build + package tests.**

Run: `go build ./... && go test ./pkg/wshrpc/wshserver/ -run Jarvis -v`
Expected: PASS (or no matching tests — then just build clean)

- [ ] **Step 4:** No commit (batched).

---

### Task C2: `ReportRunPhaseCommand` + `CreateChildRunCommand` — meta run resolve

**Files:**
- Modify: `pkg/wshrpc/wshserver/wshserver_runs.go` (`ReportRunPhaseCommand` ~376-399; `CreateChildRunCommand` ~237-271)

- [ ] **Step 1: Establish green** on the existing childrun/run tests:

Run: `go test ./pkg/wshrpc/wshserver/ -run 'ChildRun|ReportRunPhase|Run' -v`

- [ ] **Step 2: Replace** the `GetChannels` + `jarvis.ResolveRunWorker(channels, data.ORef)` pair in **both** handlers with the meta resolver.

`ReportRunPhaseCommand`:
```go
	m := jarvis.ResolveRunWorkerFromMeta(ctx, data.ORef)
	if m == nil {
		log.Printf("ReportRunPhase: no run owns oref %q (ignoring)", data.ORef)
		return nil // fail safe: a stray report is a no-op, not an error
	}
```

`CreateChildRunCommand`:
```go
	m := jarvis.ResolveRunWorkerFromMeta(ctx, data.ORef)
	if m == nil {
		return nil, fmt.Errorf("no run owns oref %q", data.ORef)
	}
	channelId := m.Channel.OID
	parent := m.Run
```

Remove the now-dead `channels, err := wstore.GetChannels(ctx)` lines and their error handling in both handlers. Keep everything downstream (`m.Channel.OID`, `m.Run`, `m.PhaseIdx`, `OverrideFromMeta(m.Channel)`) unchanged — `ResolveRunWorkerFromMeta` returns the same `*RunWorkerMatch` shape.

- [ ] **Step 3: Verify** build + tests, including the concurrent-spawn tests (they seed runs and set `SpawnClaudeWorker`):

Run: `go test -race ./pkg/wshrpc/wshserver/ -v`
Expected: PASS

> **Executor note:** `wshserver_childrun_test.go` seeds the parent run with `parent.Phases[0].WorkerOrefs = []string{leadORef}` and `AppendRun`, but does NOT stamp the lead worker's tab meta. `ResolveRunWorkerFromMeta` will therefore hit the **fallback scan** in these tests (correct — proves the fallback). If you want the tests to exercise the meta path, add a `StampWorkerOwner(ctx, leadORef, run:<id>, channel:<id>)` after `AppendRun`. Either way the tests must stay green.

- [ ] **Step 4:** No commit (batched).

---

### Task C3: `handleAsk` (watcher) — meta resolve (runoref-first) with scan fallback

**Files:**
- Modify: `pkg/jarvis/watcher.go` (`handleAsk`, lines 93-131)
- Modify: `pkg/jarvis/resolve.go` (add `resolveGatekeeperChannelByMeta` helper)
- Test: `pkg/jarvis/watcher_test.go` (extend if DB-backed) or a new DB-backed resolution test alongside Task B2's

- [ ] **Step 1: Write a failing resolution test** covering the two ownership paths + fallback. Reuse the DB-backed setup from Task B2. Assert:
  - a run worker (stamped run+channel) → `handleAsk` resolves the run channel (runoref path);
  - a concierge worker in a gatekeeper-enabled channel (stamped channel only, with a dispatch message) → resolves that channel;
  - a concierge worker in a NON-gatekeeper channel → not owned (nil).

Because `handleAsk` has side effects (Classify, post), test the extracted resolution instead: factor the ownership resolution into a pure-ish helper `resolveAskOwner(ctx, ownerORef) (ch *waveobj.Channel, task string)` and test THAT (the current inline block). This keeps the risky wiring testable per memory `surface-render-tests-declined`.

```go
func TestResolveAskOwner(t *testing.T) {
	ctx := context.Background()
	// gatekeeper-enabled channel with a concierge worker
	gk, _ := wstore.CreateChannel(ctx, "gk", "/p")
	_ = wstore.SetChannelTier // ensure tier helper exists; otherwise set meta directly:
	if err := wstore.UpdateObjectMeta(ctx, waveobj.MakeORef(waveobj.OType_Channel, gk.OID),
		waveobj.MetaMapType{MetaKey_GatekeeperEnabled: true}, false); err != nil {
		t.Fatalf("enable gatekeeper: %v", err)
	}
	worker := waveobj.MakeORef(waveobj.OType_Tab, uuid.NewString()).String()
	dm := wstore.NewChannelMessage("dispatch", "claude", "concierge task", worker, 10)
	if _, err := wstore.PostChannelMessage(ctx, gk.OID, dm); err != nil { // this also stamps (Task B3)
		t.Fatalf("post dispatch: %v", err)
	}
	ch, task := resolveAskOwner(ctx, worker)
	if ch == nil || ch.OID != gk.OID || task != "concierge task" {
		t.Fatalf("concierge resolve wrong: ch=%+v task=%q", ch, task)
	}
}
```

- [ ] **Step 2: Run it, verify fail** — `undefined: resolveAskOwner`.

- [ ] **Step 3: Implement.** Add `resolveGatekeeperChannelByMeta` to `resolve.go`:

```go
// resolveGatekeeperChannelByMeta resolves the gatekeeper-enabled channel that dispatched a concierge
// worker via the channeloref stamp (Task B3), returning the channel + its dispatch task text. Falls back
// to the message scan on a stamp miss. Returns (nil, "") when no gatekeeper-enabled channel owns it.
func resolveGatekeeperChannelByMeta(ctx context.Context, ownerORef string) (*waveobj.Channel, string) {
	_, channelORef, err := wstore.GetWorkerOwner(ctx, ownerORef)
	if err == nil && channelORef != "" {
		if chRef, perr := waveobj.ParseORef(channelORef); perr == nil {
			if ch, gerr := wstore.DBMustGet[*waveobj.Channel](ctx, chRef.OID); gerr == nil && ch != nil {
				if ch.Meta.GetBool(MetaKey_GatekeeperEnabled, false) {
					return ch, workerTaskFor(ch, ownerORef)
				}
				return nil, "" // owned by a non-gatekeeper channel: not gatekept (matches old skip)
			}
		}
	}
	// fallback: full scan
	channels, cerr := wstore.GetChannels(ctx)
	if cerr != nil {
		return nil, ""
	}
	ch := ResolveGatekeeperChannel(channels, ownerORef)
	if ch == nil {
		return nil, ""
	}
	return ch, workerTaskFor(ch, ownerORef)
}
```

Then in `watcher.go`, extract and rewrite. Replace lines 93-109 with:

```go
func resolveAskOwner(ctx context.Context, ownerORef string) (*waveobj.Channel, string) {
	// run workers carry jarvis:runoref (+channeloref); check that FIRST so a run worker takes the run
	// path, not the concierge path (it also has channeloref). Concierge workers carry channeloref only.
	if m := ResolveRunWorkerFromMeta(ctx, ownerORef); m != nil {
		return m.Channel, runWorkerTask(m.Run, m.PhaseIdx)
	}
	return resolveGatekeeperChannelByMeta(ctx, ownerORef)
}

func handleAsk(ctx context.Context, data baseds.AgentAskData) {
	ownerORef := channelOwnerORef(ctx, data.ORef)
	ch, task := resolveAskOwner(ctx, ownerORef)
	if ch == nil {
		return // not owned by any gatekeeper-enabled channel or run
	}
	// ... unchanged from the current line 110 onward (askAutoAnswerable, Classify, deliver, escalate)
}
```

> **Note the precedence flip vs. old code:** old tried gatekeeper(message)→then run(scan). New tries run(meta)→then gatekeeper(meta). Equivalent because run workers never appear in dispatch messages (they can't match the gatekeeper path), and concierge workers have no run (can't match the run path). Documented in Design Note 2.

Add `"context"` import to `watcher.go` if not present (it is — `handleAsk` already takes ctx).

- [ ] **Step 4: Run tests, verify pass** (new test + existing watcher_test predicates):

Run: `go test -race ./pkg/jarvis/ -v`

- [ ] **Step 5:** No commit (batched).

---

### Task C4: `OnWorkerExit` + `PostOutcome` — meta channel resolve, outcome-gate preserved

**Files:**
- Modify: `pkg/jarvis/onexit.go` (lines 52-62)
- Modify: `pkg/jarvis/outcome.go` (`PostOutcome` signature: take a resolved `*waveobj.Channel`, not `[]*waveobj.Channel`)

**Interfaces:**
- Change: `func PostOutcome(ch *waveobj.Channel, workerORef, runtime string, data OutcomeData)` — caller resolves the channel; `PostOutcome` keeps the "only if a dispatch message for this worker exists" gate (Design Note 3) via `ResolveDispatchChannel([]*waveobj.Channel{ch}, workerORef)` on the single channel (or an equivalent one-channel check), so run workers (no dispatch message) still get no outcome.

- [ ] **Step 1: Establish green** on `onexit_test.go` / `outcome_test.go`.

Run: `go test ./pkg/jarvis/ -run 'Outcome|WorkerExit' -v`

- [ ] **Step 2: Change `PostOutcome`** in `outcome.go` to take a single channel and keep the dispatch-existence gate:

```go
// PostOutcome posts a persisted "outcome" message to ch for workerORef, but only if ch actually
// dispatched the worker (a dispatch message references it) and no fresh outcome already exists. Taking a
// single resolved channel (not the full list) is the Phase-2 change; the dispatch-existence gate is kept
// so run workers — which have no dispatch message — still get no outcome. Fire-and-forget by the caller.
func PostOutcome(ch *waveobj.Channel, workerORef, runtime string, data OutcomeData) {
	if ch == nil {
		return
	}
	// preserve old semantics: only workers dispatched via a message earn an outcome
	if ResolveDispatchChannel([]*waveobj.Channel{ch}, workerORef) == nil {
		return
	}
	payload, _ := json.Marshal(data)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	msg := wstore.NewChannelMessage("outcome", runtime, data.Summary, workerORef, time.Now().UnixMilli())
	msg.Data = string(payload)
	posted, err := wstore.PostChannelMessageIf(ctx, ch.OID, msg, func(fresh *waveobj.Channel) bool {
		return !alreadyHasFreshOutcome(fresh, workerORef)
	})
	if err != nil {
		log.Printf("jarvis: post outcome failed: %v", err)
		return
	}
	if posted {
		wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Channel, ch.OID))
	}
}
```

- [ ] **Step 3: Change `OnWorkerExit`** in `onexit.go` — resolve the channel via meta (fallback to scan), pass the single channel:

```go
	workerORef := waveobj.MakeORef(waveobj.OType_Tab, tabId).String()
	ch := resolveDispatchChannelForWorker(ctx, workerORef)
	if ch == nil {
		return
	}
	PostOutcome(ch, workerORef, runtime, OutcomeData{
		Status:     OutcomeStatus(sess.Status),
		Summary:    outcomeSummary(sess),
		DurationMs: sess.DurationMs,
		ExitCode:   exitCode,
	})
```

Add the resolver to `outcome.go` (or `resolve.go`):

```go
// resolveDispatchChannelForWorker loads the worker's dispatching channel via the channeloref stamp,
// falling back to the full dispatch scan on a stamp miss. The PostOutcome dispatch-existence gate still
// applies, so a wrongly-stamped run worker won't get an outcome.
func resolveDispatchChannelForWorker(ctx context.Context, workerORef string) *waveobj.Channel {
	if _, channelORef, err := wstore.GetWorkerOwner(ctx, workerORef); err == nil && channelORef != "" {
		if chRef, perr := waveobj.ParseORef(channelORef); perr == nil {
			if ch, gerr := wstore.DBMustGet[*waveobj.Channel](ctx, chRef.OID); gerr == nil && ch != nil {
				return ch
			}
		}
	}
	channels, err := wstore.GetChannels(ctx)
	if err != nil {
		return nil
	}
	return ResolveDispatchChannel(channels, workerORef)
}
```

Remove the now-dead `channels, err := wstore.GetChannels(ctx)` block from `onexit.go`.

- [ ] **Step 4: Update `outcome_test.go`** if it calls `PostOutcome(channels, ...)` — switch to the single-channel signature (the pure `alreadyHasFreshOutcome` / `ResolveDispatchChannel` tests are unaffected). Run:

Run: `go test -race ./pkg/jarvis/ -v`
Expected: PASS

- [ ] **Step 5:** No commit (batched).

---

### Task C5: Radar collect — scalar channel-projectpath map + per-channel run rows

**Files:**
- Modify: `pkg/reporadar/collect_runs.go` (lines 17-45)
- Modify: `pkg/wstore/wstore_channel.go` (add `GetChannelProjectPaths`)
- Test: `pkg/wstore/wstore_channelrows_test.go` (for the new helper); existing radar collect tests stay green

**Interfaces:**
- Produces: `func GetChannelProjectPaths(ctx) (map[string]string, error)` — `channelOID → projectpath` via a scalar `json_extract` query (no blob deserialize).

- [ ] **Step 1: Write the failing test** for `GetChannelProjectPaths`:

```go
func TestGetChannelProjectPaths(t *testing.T) {
	ctx := context.Background()
	a, _ := CreateChannel(ctx, "pa", "/proj/a")
	b, _ := CreateChannel(ctx, "pb", "/proj/b")
	m, err := GetChannelProjectPaths(ctx)
	if err != nil {
		t.Fatalf("GetChannelProjectPaths: %v", err)
	}
	if m[a.OID] != "/proj/a" || m[b.OID] != "/proj/b" {
		t.Fatalf("wrong map: %+v", m)
	}
}
```

- [ ] **Step 2: Run it, verify fail** — `undefined: GetChannelProjectPaths`.

- [ ] **Step 3: Implement** `GetChannelProjectPaths` in `wstore_channel.go`:

```go
// GetChannelProjectPaths returns channelOID -> projectpath for every channel via a scalar json_extract
// query — no blob deserialize. Used by radar collect to pick matching channels without loading history.
func GetChannelProjectPaths(ctx context.Context) (map[string]string, error) {
	return WithReadTxRtn(ctx, func(tx *TxWrap) (map[string]string, error) {
		type row struct {
			OId         string `db:"oid"`
			ProjectPath string `db:"projectpath"`
		}
		var rows []row
		tx.Select(&rows, `SELECT oid, COALESCE(json_extract(data, '$.projectpath'), '') AS projectpath FROM db_channel`)
		m := make(map[string]string, len(rows))
		for _, r := range rows {
			m[r.OId] = r.ProjectPath
		}
		return m, nil
	})
}
```

> **Executor note:** verify `tx.Select` binds struct fields by `db:` tag in this codebase (sqlx default). If the existing code uses a different column-binding convention, follow it (grep for a `tx.Select(&rows,` with a multi-column struct). If none exists, fetch two parallel `[]string` via two scalar queries or use `tx.Select` into a `[]struct` with lowercase field names matching columns.

- [ ] **Step 4: Rewrite `collectRuns`** to use the map + per-channel run rows:

```go
func collectRuns(ctx context.Context, in collectInput) ([]waveobj.RadarSignal, error) {
	projectPaths, err := wstore.GetChannelProjectPaths(ctx)
	if err != nil {
		return nil, fmt.Errorf("reading channel project paths: %w", err)
	}
	cp := canonPath(in.projectPath)
	var sigs []waveobj.RadarSignal
	for channelId, chProjectPath := range projectPaths {
		if canonPath(chProjectPath) != cp {
			continue
		}
		runs, rerr := wstore.GetChannelRuns(ctx, channelId)
		if rerr != nil {
			return nil, fmt.Errorf("reading runs for channel %s: %w", channelId, rerr)
		}
		for _, run := range runs {
			if canonPath(run.ProjectPath) != cp && run.ProjectPath != "" {
				continue
			}
			for idx, ph := range run.Phases {
				if ph.State != "failed" && ph.State != "blocked" {
					continue
				}
				ref := fmt.Sprintf("run:%s:phase:%d", run.ID, idx)
				summary := fmt.Sprintf("run %q phase %q (%s) %s", run.Goal, ph.Kind, ph.State, run.Status)
				facts := map[string]any{
					"runid": run.ID, "phasekind": ph.Kind, "phasestate": ph.State, "runstatus": run.Status,
				}
				sigs = append(sigs, newSignal(CollectorRuns, ref, run.CreatedTs, ph.Artifacts, summary, facts, ""))
			}
		}
	}
	return sigs, nil
}
```

- [ ] **Step 5: Verify** — run wstore + reporadar suites:

Run: `go test -race ./pkg/wstore/ ./pkg/reporadar/ -v`
Expected: PASS

> **Executor note:** if `pkg/reporadar` collect tests seed data via `GetChannels`-shaped fixtures (embedded runs), confirm they also go through `AppendRun` (so the `db_run` rows exist). If a test seeds a channel blob with embedded runs via direct `DBInsert` (no rows), it will now find zero runs. Update such fixtures to use `CreateChannel`+`AppendRun`, matching how real data is written. Map ordering is nondeterministic — if a test asserts signal order, sort signals (e.g. by ref) before comparing.

- [ ] **Step 6: Confirm `GetChannels` is now only the fallback + list RPC.**

Run: `grep -rn "wstore.GetChannels(" pkg/ | grep -v _test.go`
Expected: only `wshserver_channels.go` (`GetChannelsCommand`), the three jarvis fallbacks (`resolveRunWorkerByScan`, `resolveGatekeeperChannelByMeta`, `resolveDispatchChannelForWorker`), and the two backfills. NO remaining hot-path scan.

- [ ] **Step 7:** No commit (batched).

---

# PART D — FE-facing RPC commands

### Task D1: `GetChannelRunsCommand` + `GetChannelMessagesCommand`

**Files:**
- Modify: `pkg/wshrpc/wshrpctypes_channels.go` (interface methods + req/rtn structs)
- Modify: `pkg/wshrpc/wshserver/wshserver_channels.go` (handlers)
- Regenerate: `frontend/app/store/wshclientapi.ts`, `frontend/types/gotypes.d.ts`, `pkg/wshrpc/wshclient/wshclient.go` (via `task generate` — do not hand-edit)
- Test: `pkg/wshrpc/wshserver/wshserver_channels_test.go` (create if absent)

**Interfaces:**
- Produces (Go interface, `ChannelCommands`):
```go
GetChannelRunsCommand(ctx context.Context, data CommandGetChannelRunsData) (*CommandGetChannelRunsRtnData, error)
GetChannelMessagesCommand(ctx context.Context, data CommandGetChannelMessagesData) (*CommandGetChannelMessagesRtnData, error)
```
- Structs:
```go
type CommandGetChannelRunsData struct {
	ChannelId string `json:"channelid"`
}
type CommandGetChannelRunsRtnData struct {
	Runs []*waveobj.Run `json:"runs"`
}
type CommandGetChannelMessagesData struct {
	ChannelId string `json:"channelid"`
	Before    int64  `json:"before,omitempty"` // ts cursor; 0 = latest
	Limit     int    `json:"limit,omitempty"`  // 0 = server default
}
type CommandGetChannelMessagesRtnData struct {
	Messages []*waveobj.ChannelMessage `json:"messages"`
}
```

- [ ] **Step 1: Write the failing handler test** in `pkg/wshrpc/wshserver/wshserver_channels_test.go`:

```go
func TestGetChannelRunsAndMessagesCommands(t *testing.T) {
	ctx := context.Background()
	ws := &WshServer{}
	ch, err := wstore.CreateChannel(ctx, "rpc", "/p")
	if err != nil {
		t.Fatalf("create channel: %v", err)
	}
	if err := wstore.AppendRun(ctx, ch.OID, waveobj.Run{ID: "r1", Goal: "g", Status: "planning", CreatedTs: 1}); err != nil {
		t.Fatalf("append run: %v", err)
	}
	if _, err := wstore.PostChannelMessage(ctx, ch.OID, wstore.NewChannelMessage("human", "you", "hi", "", 5)); err != nil {
		t.Fatalf("post msg: %v", err)
	}
	runsRtn, err := ws.GetChannelRunsCommand(ctx, wshrpc.CommandGetChannelRunsData{ChannelId: ch.OID})
	if err != nil || len(runsRtn.Runs) != 1 || runsRtn.Runs[0].ID != "r1" {
		t.Fatalf("GetChannelRuns wrong: %+v err=%v", runsRtn, err)
	}
	msgRtn, err := ws.GetChannelMessagesCommand(ctx, wshrpc.CommandGetChannelMessagesData{ChannelId: ch.OID})
	if err != nil || len(msgRtn.Messages) != 1 || msgRtn.Messages[0].Text != "hi" {
		t.Fatalf("GetChannelMessages wrong: %+v err=%v", msgRtn, err)
	}
}
```

- [ ] **Step 2: Run it, verify fail** — undefined commands/structs.

- [ ] **Step 3: Add interface methods + structs** to `pkg/wshrpc/wshrpctypes_channels.go` (append the two methods to the `ChannelCommands` interface and the four structs to the file).

- [ ] **Step 4: Implement handlers** in `pkg/wshrpc/wshserver/wshserver_channels.go` (pure reads — no broadcast, mirroring `GetChannelsCommand`):

```go
func (ws *WshServer) GetChannelRunsCommand(ctx context.Context, data wshrpc.CommandGetChannelRunsData) (*wshrpc.CommandGetChannelRunsRtnData, error) {
	runs, err := wstore.GetChannelRuns(ctx, data.ChannelId)
	if err != nil {
		return nil, fmt.Errorf("getting channel runs: %w", err)
	}
	return &wshrpc.CommandGetChannelRunsRtnData{Runs: runs}, nil
}

func (ws *WshServer) GetChannelMessagesCommand(ctx context.Context, data wshrpc.CommandGetChannelMessagesData) (*wshrpc.CommandGetChannelMessagesRtnData, error) {
	msgs, err := wstore.GetChannelMessages(ctx, data.ChannelId, data.Before, data.Limit)
	if err != nil {
		return nil, fmt.Errorf("getting channel messages: %w", err)
	}
	return &wshrpc.CommandGetChannelMessagesRtnData{Messages: msgs}, nil
}
```

- [ ] **Step 5: Regenerate bindings.**

Run: `task generate`
Expected: `frontend/app/store/wshclientapi.ts` gains `GetChannelRunsCommand`/`GetChannelMessagesCommand`; `frontend/types/gotypes.d.ts` gains the four `Command*` interfaces + a `Run[]`/`ChannelMessage[]` return; `pkg/wshrpc/wshclient/wshclient.go` gains the Go client fns. **Do not hand-edit these.**

- [ ] **Step 6: Verify** Go test + generation is clean (no drift on a second run):

Run: `go test -race ./pkg/wshrpc/wshserver/ -run TestGetChannelRunsAndMessagesCommands -v && task generate && git status --short`
Expected: test PASS; second `task generate` leaves the tree unchanged (no drift).

- [ ] **Step 7:** No commit (batched).

---

# PART E — FE cutover (active-channel surface)

> No jsdom render harness exists (memory `surface-render-tests-declined`); FE verification = vitest for pure logic + CDP visual parity (Task E4). Extract risky wiring into testable helpers; verify rendering live.

### Task E1: New store atoms + fetch + refetch-on-`channel:`-bump + per-run subscription

**Files:**
- Modify: `frontend/app/view/agents/channelsstore.ts`

**Interfaces:**
- Produces:
  - `activeChannelRunsAtom: Atom<Run[]>` — seeded via `GetChannelRunsCommand`, refetched when the pinned `channel:` object version bumps.
  - `activeChannelMessagesAtom: Atom<ChannelMessage[]>` — seeded via `GetChannelMessagesCommand` (latest window), refetched on the same bump.
  - A per-run WOS subscription so `RunBody` reads live run content: `runAtom(runId): Atom<Run|null>` = `WOS.getWaveObjectAtom<Run>(WOS.makeORef("run", runId))`.

- [ ] **Step 1: Implement the fetch actions + atoms.** Add to `channelsstore.ts`:

```ts
export const activeChannelRunsAtom = atom<Run[]>([]) as PrimitiveAtom<Run[]>;
export const activeChannelMessagesAtom = atom<ChannelMessage[]>([]) as PrimitiveAtom<ChannelMessage[]>;

export async function loadActiveChannelStreams(channelId: string): Promise<void> {
    const [runsRtn, msgsRtn] = await Promise.all([
        RpcApi.GetChannelRunsCommand(TabRpcClient, { channelid: channelId }),
        RpcApi.GetChannelMessagesCommand(TabRpcClient, { channelid: channelId }),
    ]);
    globalStore.set(activeChannelRunsAtom, runsRtn.runs ?? []);
    globalStore.set(activeChannelMessagesAtom, msgsRtn.messages ?? []);
}

// per-run live subscription (RunBody reads this for the focused run's phase deltas)
export function runAtom(runId: string) {
    return WOS.getWaveObjectAtom<Run>(WOS.makeORef("run", runId));
}
```

- [ ] **Step 2: Seed on select + refetch on `channel:` bump.** In `selectChannel` (channelsstore.ts:73-78), after the pin, call `await loadActiveChannelStreams(channelId)`. Add an effect (jotai `atomEffect` or a subscription in the surface) that watches the pinned `activeChannelAtom`'s version and calls `loadActiveChannelStreams(activeChannelId)` on change. Concretely, subscribe in the store module:

```ts
// refetch the row-backed streams whenever the pinned channel object bumps (dual-write keeps channel:
// updating on every message/run mutation — Phase 2's list-membership signal; Phase 3 replaces this).
let lastChannelVersion = -1;
globalStore.sub(activeChannelAtom, () => {
    const ch = globalStore.get(activeChannelAtom);
    if (!ch) { lastChannelVersion = -1; return; }
    if (ch.version === lastChannelVersion) return;
    lastChannelVersion = ch.version;
    loadActiveChannelStreams(ch.oid).catch(() => {});
});
```

> **Executor note:** confirm `Channel` carries a `version` field (it is a `WaveObj`, so yes — `gotypes.d.ts`). If a subscribe-in-module pattern is not used elsewhere, prefer the existing effect convention in `channelsstore.ts`/the surface. Guard against refetch loops (the version check does this).

- [ ] **Step 3: Typecheck.**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0

- [ ] **Step 4:** No commit (batched).

---

### Task E2: Repoint active-channel-surface readers to the new atoms

**Files (from recon):**
- `frontend/app/view/agents/channelssurface.tsx:94,194` — `active?.runs` → `activeChannelRunsAtom`
- `frontend/app/view/agents/channelcontextpanel.tsx:150` — `channel?.messages` → `activeChannelMessagesAtom`
- `frontend/app/view/agents/runmodel.ts:116` (`defaultView`) — takes `channel.runs`; change caller to pass the runs list (see below)
- `frontend/app/view/agents/jarvisderive.ts:37,122` — `buildFleetSnapshot`/`buildJarvisPrompt` read `channel.messages` **for the active channel** → pass the messages list

**Interfaces:** the pure helpers (`buildFleetSnapshot`, `buildJarvisPrompt`, `buildNeeds`, `defaultView`) already take arrays or the channel object. Prefer passing the new arrays explicitly rather than reading off `channel.*`.

- [ ] **Step 1: Repoint `channelssurface.tsx`.** Replace `const runs = (active?.runs ?? []).filter(...)` reads with `const allRuns = useAtomValue(activeChannelRunsAtom);` then the same dismissed-filter over `allRuns`. Update the `dismissTab` recompute (`:194`) to use `allRuns`. Keep `RunBody`'s `run` selection; for the FOCUSED run, read live content via `useAtomValue(runAtom(run.id))` (falling back to the list entry if the WOS atom hasn't hydrated).

- [ ] **Step 2: Repoint `channelcontextpanel.tsx`.** Replace `channel?.messages ?? []` (`:150`) with `useAtomValue(activeChannelMessagesAtom)`; the downstream `buildNeeds`/`consultMsgs`/`buildFleetSnapshot` calls take that array unchanged.

- [ ] **Step 3: Repoint `defaultView`.** In `runmodel.ts`, change `defaultView(channel)` → `defaultView(runsLen: number)` (or pass the runs array) so it no longer reads `channel.runs`; update its caller to pass `activeChannelRunsAtom`'s length. Update `runmodel.test.ts` accordingly (Task E3).

- [ ] **Step 4: Repoint active-channel `jarvisderive` calls.** Where `buildFleetSnapshot(channel, agents)` / `buildJarvisPrompt(snapshot, channel, focus)` are called **for the active channel**, pass a shallow-cloned channel whose `messages` is `activeChannelMessagesAtom` (or refactor the signatures to take `messages` explicitly — preferred, and keeps the pure functions honest). Do NOT touch the cross-channel callers in `channelderive.ts:98`/`jarvisderive.ts:144` (they iterate the `channelsAtom` snapshot — Design Note 5, left on embedded arrays for Phase 2).

- [ ] **Step 5: Typecheck + unit tests.**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit && npx vitest run frontend/app/view/agents/`
Expected: exit 0 / tests green (after Task E3 fixture updates)

- [ ] **Step 6:** No commit (batched).

---

### Task E3: Update FE fixtures/tests for the signature changes

**Files:**
- `frontend/app/view/agents/runmodel.test.ts` (`defaultView` signature)
- `frontend/app/view/agents/jarvisderive.test.ts` (if `buildFleetSnapshot`/`buildJarvisPrompt` signatures change to take `messages`)
- any test asserting `defaultView(channel)`

- [ ] **Step 1:** Update `runmodel.test.ts` `defaultView` cases to the new signature (pass runs length / array). Keep the `run()` factory (it already includes `otype/oid/version/meta` from Phase 1).

- [ ] **Step 2:** If `jarvisderive` signatures changed, update `jarvisderive.test.ts` to pass `messages` explicitly (it currently builds a `Channel` with embedded `messages` — extract that array into the new param).

- [ ] **Step 3: Run FE tests, verify pass.**

Run: `npx vitest run frontend/app/view/agents/`
Expected: all green

- [ ] **Step 4:** No commit (batched).

---

### Task E4: CDP visual parity verification (live dev app)

**Files:** none (verification only)

- [ ] **Step 1:** Ensure a dev app is running (`task dev`; note the stdin-EOF + tail-f gotchas — memory `dev-task-dev-stdin-eof`, `when-task-dev-run-via-the-tail-f...`). Inject populated data if needed: `node scripts/inject-live-agents.mjs <scenario>`.

- [ ] **Step 2: Verify the active-channel surface renders identically** to pre-cutover: transcript messages, run cards/strip, context panel "Needs you/Consults/Fleet". Use `task verify:ui -- <channel scenario>` if a scenario exists, else `node scripts/cdp-shot.mjs cdp-shots/phase2-channel.png` and compare against the current `main` behavior.

- [ ] **Step 3: Verify liveness:** post a message / advance a run (via the app or `wsh`) and confirm the surface updates (message appends on `channel:` bump; run phase updates via `run:` subscription).

- [ ] **Step 4:** Record the result (PASS/FAIL + screenshot path) in the finish summary. If CDP is unavailable (port busy / parallel session), say so explicitly and defer with a note — do not claim verified.

- [ ] **Step 5:** No commit (batched).

---

# PART F — integration, verification, finish

### Task F1: Full verification + finishing-a-development-branch

- [ ] **Step 1: Full backend suite (with `-race` on the touched packages).**

Run: `go test ./pkg/... && go test -race ./pkg/wstore/ ./pkg/jarvis/ ./pkg/wshrpc/wshserver/ ./pkg/reporadar/`
Expected: PASS. (Confirm the only `-race` failure anywhere, if any, is the pre-existing `pkg/util/iochan` one — `git diff main -- pkg/util/iochan/` must be empty.)

- [ ] **Step 2: Codegen no-drift + typecheck + FE tests.**

Run: `task generate && git status --short` (no unexpected changes) ; `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` ; `npx vitest run frontend/app/view/agents/`
Expected: no drift, tsc exit 0, tests green.

- [ ] **Step 3: Backend build (rows/handlers compiled).**

Run: `task build:backend` (no `.sql` added, so `--force` not strictly required — but run it if any migration was added).
Expected: clean build; `dist/bin/` produced.

- [ ] **Step 4: Grep gate — `GetChannels` no longer on any hot path** (repeat Task C5 Step 6).

- [ ] **Step 5: Update the design doc status.** In `docs/superpowers/specs/2026-07-21-channel-data-model-scaling-design.md`: mark Phase 2 shipped (status line + the Phase 2 bullet), note Phase 3 (Contract) is next, and record the two documented Phase-2 deviations/deferrals (radar no-index per Design Note 4; FE cross-channel badges + rail unread left on the snapshot per Design Note 5; per-run subscription in place, `channel:`-bump as list signal until Phase 3).

- [ ] **Step 6: Finish.** Announce and use **superpowers:finishing-a-development-branch**. Per user CLAUDE.md STRICT git: batch ONE feature commit (fold in this plan + the design-doc status edit; no co-author; no separate docs commit), stage only our files (exclude the pre-existing brief edit), then present the merge/PR/keep/discard options. Do not commit without explicit approval.

---

## Self-review (run against the design before executing)

- **Spec coverage:** A1 write (row upsert) already Phase 1; A1 broadcast → Task A4 (`run:` delta). A2 lookup → Tasks A1/A3/B2 + C2/C3/C4. A2 radar → C5. Read pool (A3) already Phase 0 — all new reads use `WithReadTxRtn`. FE APIs `GetChannelMessages(channelId, before, limit)` / `GetChannelRuns(channelId)` → Task D1 (exact signatures). FE assembly from message-list + run-list + per-run subscription → Tasks E1/E2. Worker-oref→run via tab-meta (design call 1) → B1/B2 + concierge extension B3/B4. Ordering/pagination (`ts` index, generous default) → A2. Parity test (old scan vs new lookup) → B2. CDP FE parity → E4.
- **Deviations flagged:** radar projectpath index NOT added (Design Note 4); Phase-2 FE liveness uses `channel:`-bump for list membership (no new wire event — design-compliant) with per-run `run:` subscriptions for content (Design Note 6); cross-channel badges/rail left on the snapshot (Design Note 5). All three are same-outcome, lower-risk, and reversible; reviewer may override.
- **Type consistency:** `RunWorkerMatch` shape unchanged across `ResolveRunWorker` and `ResolveRunWorkerFromMeta`. `GetRun(ctx, channelId, runId)` signature unchanged (row-backed internally). RPC struct/field names (`channelid`, `before`, `limit`, `runs`, `messages`) consistent between D1 structs and E1 call sites.
- **Executor cautions embedded:** verify `waveobj` ctx-update getter API (A4), jarvis test DB init (B2/C3), `singletonMetaBool` refactor (B4), sqlx struct-tag binding (C5), radar fixture seeding via `AppendRun` (C5), `Channel.version` presence (E1). None block the plan; each says how to adapt.
