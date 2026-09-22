// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package memvault

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// withEpochFile points epochFile at a temp dir for the duration of the test.
func withEpochFile(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	old := epochFile
	epochFile = func() string { return filepath.Join(dir, "memory-recall-epoch.txt") }
	t.Cleanup(func() { epochFile = old })
	return filepath.Join(dir, "memory-recall-epoch.txt")
}

func TestEnsureRecallEpochWritesOnce(t *testing.T) {
	withEpochFile(t)
	first := time.Date(2026, 9, 22, 12, 0, 0, 0, time.UTC)
	if got := EnsureRecallEpoch(first); !got.Equal(first) {
		t.Fatalf("first EnsureRecallEpoch = %v, want %v", got, first)
	}
	later := first.Add(48 * time.Hour)
	if got := EnsureRecallEpoch(later); !got.Equal(first) {
		t.Fatalf("second EnsureRecallEpoch = %v, want the original %v (the epoch must not move)", got, first)
	}
	if got := RecallEpoch(); !got.Equal(first) {
		t.Fatalf("RecallEpoch = %v, want %v", got, first)
	}
}

func TestRecallEpochAbsentOrMalformedIsZero(t *testing.T) {
	path := withEpochFile(t)
	if got := RecallEpoch(); !got.IsZero() {
		t.Fatalf("absent epoch = %v, want zero (an unreadable epoch must never authorize an archive)", got)
	}
	if err := os.WriteFile(path, []byte("not-a-timestamp"), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := RecallEpoch(); !got.IsZero() {
		t.Fatalf("malformed epoch = %v, want zero", got)
	}
}

func TestTouchReferencedByIDTargetsTheVault(t *testing.T) {
	dir := t.TempDir()
	old := DefaultVaultPath
	DefaultVaultPath = func() string { return dir }
	t.Cleanup(func() { DefaultVaultPath = old })

	path := filepath.Join(dir, "known.md")
	if err := os.WriteFile(path, []byte("---\nname: known\nmetadata:\n  type: learning\n---\n\nbody\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := TouchReferencedByID([]string{"known", "unknown"}, "2026-09-22T10:00:00Z"); err != nil {
		t.Fatalf("TouchReferencedByID: %v", err)
	}
	nw, err := ReadNote(path, "vault")
	if err != nil {
		t.Fatal(err)
	}
	if nw.Note.ReferenceCount != 1 {
		t.Fatalf("reference_count = %d, want 1", nw.Note.ReferenceCount)
	}
}
