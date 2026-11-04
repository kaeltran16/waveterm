// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package agentsessions

import (
	"os"
	"path/filepath"
	"testing"
)

func TestResumeBlockerExisting(t *testing.T) {
	if got := NewDirCheck(statErr).Blocker(t.TempDir()); got != "" {
		t.Fatalf("an existing dir resumes, got %q", got)
	}
}

func TestResumeBlockerMissing(t *testing.T) {
	gone := filepath.Join(t.TempDir(), "gone")
	want := "its working directory " + gone + " no longer exists"
	if got := NewDirCheck(statErr).Blocker(gone); got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestResumeBlockerEmptyPath(t *testing.T) {
	if got := NewDirCheck(statErr).Blocker(""); got != "no working directory was recorded" {
		t.Fatalf("got %q", got)
	}
}

func TestResumeBlockerStatsEachPathOnce(t *testing.T) {
	calls := map[string]int{}
	check := NewDirCheck(func(path string) error {
		calls[path]++
		return os.ErrNotExist
	})
	for _, p := range []string{"/a", "/b", "/a", "/a", "/b", ""} {
		check.Blocker(p)
	}
	if calls["/a"] != 1 || calls["/b"] != 1 || len(calls) != 2 {
		t.Fatalf("each distinct path is statted once and \"\" never, got %v", calls)
	}
}

func statErr(path string) error {
	_, err := os.Stat(path)
	return err
}
