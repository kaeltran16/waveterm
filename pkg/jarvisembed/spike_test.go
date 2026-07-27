// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvisembed

import (
	"database/sql"
	"testing"

	sqlite_vec "github.com/asg017/sqlite-vec-go-bindings/cgo"
	_ "github.com/mattn/go-sqlite3"
)

// TestSqliteVecSpike is the build/link gate: it fails to COMPILE if sqlite-vec
// cannot statically link under the CGO/zig build, and fails at RUNTIME if the
// vec0 MATCH + k + metadata-filter query shape is unsupported by the pinned
// version. Task 7's Query rests on exactly this shape.
func TestSqliteVecSpike(t *testing.T) {
	sqlite_vec.Auto()
	db, err := sql.Open("sqlite3", ":memory:")
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer db.Close()

	if _, err := db.Exec(`create virtual table v using vec0(embedding float[3], collection text)`); err != nil {
		t.Fatalf("create vec0: %v", err)
	}
	rows := []struct {
		id   int
		vec  string
		coll string
	}{
		{1, "[1,0,0]", "memory"},
		{2, "[0,1,0]", "tasks"},
		{3, "[0.9,0.1,0]", "memory"},
	}
	for _, r := range rows {
		if _, err := db.Exec(`insert into v(rowid, embedding, collection) values (?, ?, ?)`, r.id, r.vec, r.coll); err != nil {
			t.Fatalf("insert %d: %v", r.id, err)
		}
	}

	// KNN for [1,0,0] restricted to collection='memory' must return rowid 1 then 3, never 2.
	q := `select rowid from v where embedding match ? and k = 2 and collection in ('memory') order by distance`
	res, err := db.Query(q, "[1,0,0]")
	if err != nil {
		t.Fatalf("knn query: %v", err)
	}
	defer res.Close()
	var got []int
	for res.Next() {
		var id int
		if err := res.Scan(&id); err != nil {
			t.Fatalf("scan: %v", err)
		}
		got = append(got, id)
	}
	if len(got) != 2 || got[0] != 1 || got[1] != 3 {
		t.Fatalf("expected [1 3], got %v (metadata-filtered KNN unsupported? use the cosine-scan fallback)", got)
	}
}
