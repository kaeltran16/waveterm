// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wstore

import (
	"context"
	"os"
	"strings"
	"testing"
)

// A profile upgraded from a build with Ask carries db_jarvisconversation; TestMain ran every migration, so
// 000020 must have removed it, and its down file must restore exactly 000015's table.
func TestJarvisConversationTableDropped(t *testing.T) {
	got, err := WithReadTxRtn(context.Background(), func(tx *TxWrap) (string, error) {
		return tx.GetString("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'db_jarvisconversation'"), nil
	})
	if err != nil {
		t.Fatalf("query sqlite_master: %v", err)
	}
	if got != "" {
		t.Fatalf("db_jarvisconversation still present after migrations")
	}
	down, err := os.ReadFile("../../db/migrations-wstore/000020_drop_jarvisconversation.down.sql")
	if err != nil {
		t.Fatalf("read down migration: %v", err)
	}
	if !strings.Contains(string(down), "CREATE TABLE IF NOT EXISTS db_jarvisconversation") {
		t.Fatalf("down migration does not recreate db_jarvisconversation:\n%s", down)
	}
}
