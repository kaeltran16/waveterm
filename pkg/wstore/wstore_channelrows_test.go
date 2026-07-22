// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wstore

import (
	"context"
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
