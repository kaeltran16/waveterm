// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wstore

import (
	"context"
	"fmt"
	"testing"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
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

// StampWorkerOwner records the owning run/channel oref on a worker tab's meta so the Phase-2 lookup is a
// direct field read. Seed a tab, stamp it, read the meta back.
func TestStampWorkerOwner(t *testing.T) {
	ctx := context.Background()
	// ParseORef (used by StampWorkerOwner) requires a UUID oid, matching real tab oids.
	tabOID := uuid.NewString()
	tab := &waveobj.Tab{OID: tabOID, Name: "worker", Meta: waveobj.MetaMapType{}}
	if err := DBInsert(ctx, tab); err != nil {
		t.Fatalf("seed tab: %v", err)
	}
	tabORef := waveobj.MakeORef(waveobj.OType_Tab, tabOID).String()
	runORef := waveobj.MakeORef(waveobj.OType_Run, "r-1").String()
	chORef := waveobj.MakeORef(waveobj.OType_Channel, "c-1").String()
	if err := StampWorkerOwner(ctx, tabORef, runORef, chORef); err != nil {
		t.Fatalf("stamp: %v", err)
	}
	got, err := DBMustGet[*waveobj.Tab](ctx, tabOID)
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

func TestGetRunReadsRow(t *testing.T) {
	ctx := context.Background()
	ch, err := CreateChannel(ctx, "getrun-row", "/p")
	if err != nil {
		t.Fatalf("create channel: %v", err)
	}
	if err := AppendRun(ctx, ch.OID, waveobj.Run{ID: "r-1", Goal: "g", Status: "planning", CreatedTs: 1}); err != nil {
		t.Fatalf("append: %v", err)
	}
	got, err := GetRun(ctx, ch.OID, "r-1")
	if err != nil || got == nil || got.ID != "r-1" || got.ChannelOID != ch.OID {
		t.Fatalf("GetRun row read wrong: %+v err=%v", got, err)
	}
	// Lock row-sourcing: a run present ONLY as a db_run row (never appended to the channel blob) must be
	// found. The old blob scan could not see it; the row read must. This is the discriminating assertion.
	if err := DBInsert(ctx, &waveobj.Run{OID: "r-rowonly", ID: "r-rowonly", ChannelOID: ch.OID, Goal: "g", Status: "planning", CreatedTs: 2}); err != nil {
		t.Fatalf("seed row-only run: %v", err)
	}
	rowOnly, err := GetRun(ctx, ch.OID, "r-rowonly")
	if err != nil || rowOnly == nil || rowOnly.ID != "r-rowonly" {
		t.Fatalf("GetRun did not read the row-only run: %+v err=%v", rowOnly, err)
	}
	if _, err := GetRun(ctx, "wrong-channel", "r-1"); err == nil {
		t.Fatalf("expected error for mismatched channel id")
	}
	if _, err := GetRun(ctx, ch.OID, "nope"); err == nil {
		t.Fatalf("expected error for missing run")
	}
}

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
