// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func mkDir(t *testing.T, base, name string, age time.Duration) string {
	t.Helper()
	p := filepath.Join(base, name)
	if err := os.Mkdir(p, 0700); err != nil {
		t.Fatalf("mkdir %s: %v", name, err)
	}
	if age > 0 {
		old := time.Now().Add(-age)
		if err := os.Chtimes(p, old, old); err != nil {
			t.Fatalf("chtimes %s: %v", name, err)
		}
	}
	return p
}

func TestSweepTempAttachments(t *testing.T) {
	base := t.TempDir()
	retention := 24 * time.Hour

	stale := mkDir(t, base, tempAttachPrefix+"stale", 48*time.Hour)
	recent := mkDir(t, base, tempAttachPrefix+"recent", 0)
	socketDir := mkDir(t, base, "waveterm-1000", 48*time.Hour) // socket-dir style; wrong prefix, must survive
	unrelated := mkDir(t, base, "some-other-dir", 48*time.Hour)

	// regression: an attachment written and still within the read window must survive with its file
	recentFile := filepath.Join(recent, "note.txt")
	if err := os.WriteFile(recentFile, []byte("hi"), 0600); err != nil {
		t.Fatalf("write attachment file: %v", err)
	}

	sweepTempAttachments(base, retention)

	if _, err := os.Stat(stale); !os.IsNotExist(err) {
		t.Errorf("expected stale attachment dir removed, stat err=%v", err)
	}
	if _, err := os.Stat(recentFile); err != nil {
		t.Errorf("expected recent attachment (within retention) to survive, stat err=%v", err)
	}
	if _, err := os.Stat(socketDir); err != nil {
		t.Errorf("expected non-attachment waveterm-<uid> dir to survive, stat err=%v", err)
	}
	if _, err := os.Stat(unrelated); err != nil {
		t.Errorf("expected unrelated dir to survive, stat err=%v", err)
	}
}

func TestSweepTempAttachmentsMissingDir(t *testing.T) {
	// must not panic when the temp dir can't be read
	sweepTempAttachments(filepath.Join(t.TempDir(), "does-not-exist"), time.Hour)
}
