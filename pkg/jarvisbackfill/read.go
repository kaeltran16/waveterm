// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvisbackfill

import (
	"database/sql"
	"encoding/json"
	"fmt"

	_ "github.com/mattn/go-sqlite3"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// ReadHistory loads the runs out of a wstore sqlite file.
//
// It reads the object blobs directly rather than going through pkg/wstore on purpose: wstore's
// initialization runs migrations, and this tool is routinely pointed at a live or copied production
// database that it must not modify. The connection is opened read-only and the schema touched is
// just the data column.
func ReadHistory(dbPath string) ([]*waveobj.Run, error) {
	db, err := sql.Open("sqlite3", "file:"+dbPath+"?mode=ro")
	if err != nil {
		return nil, fmt.Errorf("open wstore: %w", err)
	}
	defer db.Close()

	var runs []*waveobj.Run
	if err := scanBlobs(db, "db_run", func(b []byte) error {
		var r waveobj.Run
		if err := json.Unmarshal(b, &r); err != nil {
			return err
		}
		runs = append(runs, &r)
		return nil
	}); err != nil {
		return nil, fmt.Errorf("read runs: %w", err)
	}
	return runs, nil
}

// scanBlobs walks a wstore table's data column. A row that fails to unmarshal is skipped rather than
// fatal — one malformed historical blob should not cost the whole import.
func scanBlobs(db *sql.DB, table string, fn func([]byte) error) error {
	rows, err := db.Query(fmt.Sprintf("SELECT data FROM %q", table))
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var b []byte
		if err := rows.Scan(&b); err != nil {
			return err
		}
		_ = fn(b)
	}
	return rows.Err()
}
