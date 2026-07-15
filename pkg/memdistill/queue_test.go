// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package memdistill

import (
	"path/filepath"
	"testing"
)

func TestAddPending_DedupesByPath(t *testing.T) {
	st := queueState{Buckets: map[string][]pendingSession{}}
	addPending(&st, "/repo/a", "/t/1.jsonl", "/usr/bin/claude", "2026-07-15T00:00:00Z")
	addPending(&st, "/repo/a", "/t/1.jsonl", "", "2026-07-15T00:01:00Z") // duplicate path
	addPending(&st, "/repo/a", "/t/2.jsonl", "", "2026-07-15T00:02:00Z")
	if got := len(st.Buckets["/repo/a"]); got != 2 {
		t.Fatalf("bucket size = %d, want 2 (dupe path ignored)", got)
	}
	if st.ClaudePath != "/usr/bin/claude" {
		t.Errorf("ClaudePath = %q, want it preserved from the first non-empty enqueue", st.ClaudePath)
	}
}

func TestSaveLoadQueue_RoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "queue.json")
	st := queueState{ClaudePath: "/c", Buckets: map[string][]pendingSession{
		"/repo/a": {{TranscriptPath: "/t/1.jsonl", EnqueuedAt: "2026-07-15T00:00:00Z"}},
	}}
	if err := saveQueue(path, st); err != nil {
		t.Fatalf("saveQueue: %v", err)
	}
	got := loadQueue(path)
	if got.ClaudePath != "/c" || len(got.Buckets["/repo/a"]) != 1 {
		t.Fatalf("round-trip mismatch: %+v", got)
	}
}

func TestLoadQueue_MissingFileIsEmpty(t *testing.T) {
	got := loadQueue(filepath.Join(t.TempDir(), "does-not-exist.json"))
	if got.Buckets == nil || len(got.Buckets) != 0 {
		t.Fatalf("missing file should load empty non-nil buckets, got %+v", got)
	}
}
