// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wavebase

import (
	"path/filepath"
	"testing"
)

// useSnapshotBase lays out <tmp>/arc-snap/data as the data dir and returns the arc-snap base.
func useSnapshotBase(t *testing.T, snapshot bool) string {
	t.Helper()
	base := filepath.Join(t.TempDir(), "arc-snap")
	old := DataHome_VarCache
	DataHome_VarCache = filepath.Join(base, "data")
	t.Cleanup(func() { DataHome_VarCache = old })
	if snapshot {
		t.Setenv(ArcSnapshotVarName, "1")
	} else {
		t.Setenv(ArcSnapshotVarName, "")
	}
	return base
}

func TestSnapshotMayStartOnlyInsideScratch(t *testing.T) {
	base := useSnapshotBase(t, true)
	scratch := filepath.Join(base, "scratch")
	cases := []struct {
		cwd  string
		want bool
	}{
		{scratch, true},
		{filepath.Join(scratch, "proj", "sub"), true},
		{"", false},                // the shell's default cwd is the home dir
		{"~/code/waveterm", false}, // not absolute
		{base, false},              // the snapshot's own store
		{filepath.Join(base, "scratch-other"), false}, // a sibling sharing the prefix
		{filepath.Join(scratch, "..", "data"), false},
		{filepath.Dir(base), false},
	}
	for _, c := range cases {
		if got := SnapshotMayStart(c.cwd); got != c.want {
			t.Errorf("SnapshotMayStart(%q) = %v, want %v", c.cwd, got, c.want)
		}
	}
}

func TestSnapshotMayWriteOnlyInsideBase(t *testing.T) {
	base := useSnapshotBase(t, true)
	cases := []struct {
		path string
		want bool
	}{
		{filepath.Join(base, "data", "db"), true},
		{filepath.Join(base, "vault", "note.md"), true},
		{base, true},
		{base + "-other", false}, // a sibling with the base as a name prefix
		{filepath.Join(base, "..", "real"), false},
		{filepath.Join(base, "data", "..", "..", "real"), false},
		{"arc-snap/data/x", false}, // relative
		{"", false},
		{filepath.Dir(base), false},
	}
	for _, c := range cases {
		if got := SnapshotMayWrite(c.path); got != c.want {
			t.Errorf("SnapshotMayWrite(%q) = %v, want %v", c.path, got, c.want)
		}
	}
}

func TestNoSnapshotAllowsAnyPath(t *testing.T) {
	base := useSnapshotBase(t, false)
	outside := filepath.Join(filepath.Dir(base), "real")
	for _, p := range []string{outside, "", "relative/path"} {
		if !SnapshotMayWrite(p) {
			t.Errorf("SnapshotMayWrite(%q) = false with %s unset", p, ArcSnapshotVarName)
		}
		if !SnapshotMayStart(p) {
			t.Errorf("SnapshotMayStart(%q) = false with %s unset", p, ArcSnapshotVarName)
		}
	}
}
