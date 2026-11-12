// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package memgate

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestEstimateDefaults(t *testing.T) {
	t.Cleanup(SetStoreDirForTest(t.TempDir()))
	cases := map[string]uint64{
		RoleWorker:   3584 * mib,
		"Verify":     3584 * mib,
		"Check":      3584 * mib,
		"Final":      3584 * mib,
		RoleReviewer: 1536 * mib,
		"Setup":      1536 * mib,
		"lead":       gib,
		"terminal":   gib,
	}
	for role, want := range cases {
		if got := Estimate(Key{"c:\\proj", role}); got != want {
			t.Errorf("Estimate(%s) = %d, want %d", role, got, want)
		}
	}
}

func TestEstimateIsMaxOfLastEight(t *testing.T) {
	t.Cleanup(SetStoreDirForTest(t.TempDir()))
	k := Key{"c:\\proj", RoleWorker}
	Record(k, 9*gib) // the oldest of nine: ages out
	for i := uint64(1); i <= 8; i++ {
		Record(k, i*gib)
	}
	if got := Estimate(k); got != 8*gib {
		t.Fatalf("estimate = %d, want 8 GiB (the 9 GiB record is ninth-oldest)", got)
	}
	Record(k, 0)
	if got := Estimate(k); got != 8*gib {
		t.Fatalf("after a 0 peak estimate = %d, want 8 GiB", got)
	}
	if got := Estimate(Key{"c:\\other", RoleWorker}); got != 3584*mib {
		t.Fatalf("another project's estimate = %d, want the default", got)
	}
}

func TestFootprintsPersist(t *testing.T) {
	dir := t.TempDir()
	t.Cleanup(SetStoreDirForTest(dir))
	k := Key{"c:\\proj", "Verify"}
	Record(k, 5*gib)

	SetStoreDirForTest(dir) // drop the in-memory copy: the next read comes from the file
	if got := Estimate(k); got != 5*gib {
		t.Fatalf("reloaded estimate = %d, want 5 GiB", got)
	}

	path := filepath.Join(dir, footprintsFile)
	if err := os.WriteFile(path, []byte("{not json"), 0o644); err != nil {
		t.Fatal(err)
	}
	SetStoreDirForTest(dir)
	if got := Estimate(k); got != 3584*mib {
		t.Fatalf("corrupt file estimate = %d, want the default", got)
	}
	Record(k, 2*gib)
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var entries []footprintEntry
	if err := json.Unmarshal(data, &entries); err != nil {
		t.Fatalf("file not rewritten as valid json: %v: %s", err, data)
	}
	SetStoreDirForTest(dir)
	if got := Estimate(k); got != 2*gib {
		t.Fatalf("estimate after rewrite = %d, want 2 GiB", got)
	}
}
