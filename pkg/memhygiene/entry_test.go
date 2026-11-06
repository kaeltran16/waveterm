// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package memhygiene

import (
	"strings"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

func TestUndoRefusesExpiredBackup(t *testing.T) {
	storeSetup(t)
	now := time.Now()
	expired := now.Add(-24 * time.Hour)
	c := wshrpc.MemChange{Id: "c1", Title: "Drop a.md", Status: checkStatusApplied, ApplyId: "gone", BackupUntil: expired.UnixMilli()}
	st := &State{MemHygieneProject: wshrpc.MemHygieneProject{Project: "p", Changes: []wshrpc.MemChange{c}}}

	err := entryUndo(st, &st.Changes[0], now)
	if err == nil || !strings.Contains(err.Error(), "its backup expired on") || !strings.Contains(err.Error(), expired.Format(entryDateLayout)) {
		t.Fatalf("undo of an expired backup: err = %v, want one naming when it expired", err)
	}
	if strings.Contains(err.Error(), "manifest") {
		t.Errorf("err leaks the raw manifest error: %v", err)
	}
	if st.Changes[0].Status != checkStatusApplied || st.Changes[0].ApplyId != "gone" {
		t.Errorf("a refused undo changed the change: %+v", st.Changes[0])
	}
}
