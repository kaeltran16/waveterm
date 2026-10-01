// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package effortstore

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wavevault"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// TestMain gives the package a real wstore SQLite DB in a temp data dir, as wstore's own tests do.
func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "effortstore-test-*")
	if err != nil {
		panic(err)
	}
	wavebase.DataHome_VarCache = dir
	if err := wavebase.EnsureWaveDBDir(); err != nil {
		panic(err)
	}
	if err := wstore.InitWStore(); err != nil {
		panic(err)
	}
	code := m.Run()
	os.RemoveAll(dir)
	os.Exit(code)
}

func TestMigrateFromDB(t *testing.T) {
	root := useTempRoot(t)
	ctx := context.Background()
	rows := []*waveobj.Effort{
		{OID: "11111111-1111-1111-1111-111111111111", Version: 1, Title: "one", Status: "active", CreatedTs: 10, UpdatedTs: 20,
			Chunks: []waveobj.EffortChunk{{Label: "a", Status: "done"}}},
		{OID: "22222222-2222-2222-2222-222222222222", Version: 1, Title: "two", Status: "paused", CreatedTs: 30, UpdatedTs: 40},
	}
	for _, e := range rows {
		if err := wstore.DBInsert(ctx, e); err != nil {
			t.Fatal(err)
		}
	}
	// a file already in the vault (pulled from another machine) is newer truth and is not overwritten
	existing := &waveobj.Effort{OID: rows[1].OID, Version: 9, Title: "two from the vault", Status: "active", Chunks: []waveobj.EffortChunk{}}
	b, _ := wavevault.MarshalEffort(existing)
	if err := os.MkdirAll(filepath.Join(root, wavevault.EffortsDir), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(effortFile(root, existing.OID), b, 0o644); err != nil {
		t.Fatal(err)
	}

	n, err := MigrateFromDB(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("want 1 migrated, got %d", n)
	}
	got, err := Get(ctx, rows[0].OID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Title != "one" || got.CreatedTs != 10 || got.UpdatedTs != 20 || len(got.Chunks) != 1 {
		t.Fatalf("migrated effort changed: %+v", got)
	}
	kept, err := Get(ctx, rows[1].OID)
	if err != nil {
		t.Fatal(err)
	}
	if kept.Title != "two from the vault" {
		t.Fatalf("existing file overwritten: %+v", kept)
	}
	left, err := wstore.DBGetAllObjsByType[*waveobj.Effort](ctx, waveobj.OType_Effort)
	if err != nil {
		t.Fatal(err)
	}
	if len(left) != 0 {
		t.Fatalf("db rows not deleted: %+v", left)
	}

	n, err = MigrateFromDB(ctx)
	if err != nil || n != 0 {
		t.Fatalf("second run: want 0 migrated, got %d, %v", n, err)
	}
}
