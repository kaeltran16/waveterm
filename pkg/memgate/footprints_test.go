// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package memgate

import (
	"os"
	"path/filepath"
	"testing"
)

func TestEstimateIsTheMedian(t *testing.T) {
	t.Cleanup(SetStoreDirForTest(t.TempDir()))
	mb := gbDec / 1000
	k := Key{"c:\\waveterm", RoleWorker}
	for _, p := range []uint64{4600, 4800, 4200, 4100, 5300} {
		Record(k, p*mb)
	}
	if got := Estimate(k); got != 4600*mb {
		t.Fatalf("estimate = %d, want the 4.6 GB median", got)
	}
	Record(k, 19800*mb)
	if got := Estimate(k); got != 4700*mb {
		t.Fatalf("estimate with a 19.8 GB outlier = %d, want 4.7 GB (the mean of 4.6 and 4.8)", got)
	}
	Record(k, 0)
	if got := Estimate(k); got != 4700*mb {
		t.Fatalf("a 0 peak changed the estimate to %d", got)
	}

	kept := Key{"c:\\proj", RoleWorker}
	Record(kept, 9*gib) // the oldest of nine: ages out
	for i := uint64(1); i <= 8; i++ {
		Record(kept, i*gib)
	}
	if got := Estimate(kept); got != 4*gib+gib/2 {
		t.Fatalf("estimate = %d, want 4.5 GiB: the median of the last 8 (1-8 GiB)", got)
	}

	cases := map[Key]uint64{
		{"c:\\other", RoleWorker}:   3584 * mib,
		{"c:\\other", RoleReviewer}: 1536 * mib,
		{"c:\\other", "x"}:          gib,
	}
	for k, want := range cases {
		if got := Estimate(k); got != want {
			t.Errorf("unseen %v estimate = %d, want %d", k, got, want)
		}
	}
}

func TestFootprintsFallBackToDefaults(t *testing.T) {
	dir := t.TempDir()
	t.Cleanup(SetStoreDirForTest(dir))
	k := Key{"c:\\proj", "Verify"}
	const def = 3584 * mib
	if got := Estimate(k); got != def {
		t.Fatalf("missing file estimate = %d, want the default", got)
	}

	path := filepath.Join(dir, footprintsFile)
	if err := os.Mkdir(path, 0o755); err != nil {
		t.Fatal(err)
	}
	SetStoreDirForTest(dir)
	if got := Estimate(k); got != def {
		t.Fatalf("estimate with a directory in the file's place = %d, want the default", got)
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}

	if err := os.WriteFile(path, []byte("not json"), 0o644); err != nil {
		t.Fatal(err)
	}
	SetStoreDirForTest(dir)
	if got := Estimate(k); got != def {
		t.Fatalf("corrupt file estimate = %d, want the default", got)
	}

	Record(k, 2*gib)
	SetStoreDirForTest(dir) // drop the in-memory copy: the next read comes from the file
	if got := Estimate(k); got != 2*gib {
		t.Fatalf("estimate reloaded after the rewrite = %d, want 2 GiB", got)
	}
}
