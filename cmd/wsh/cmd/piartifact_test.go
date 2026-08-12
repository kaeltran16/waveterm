// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"os"
	"path/filepath"
	"testing"
)

// repoRoot resolves the repository root relative to this package (cmd/wsh/cmd -> 3 levels up).
func repoRoot(t *testing.T) string {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	root, err := filepath.Abs(filepath.Join(dir, "..", "..", ".."))
	if err != nil {
		t.Fatalf("abs: %v", err)
	}
	return root
}

func readRepoFile(t *testing.T, rel string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(repoRoot(t), rel))
	if err != nil {
		t.Fatalf("reading %s: %v", rel, err)
	}
	return string(b)
}

// embeddedPiStatusExtension must track the authored pi/ package file; task sync:piartifacts keeps
// the embed copy current, and this test fails the build when someone edits the authored file without
// re-syncing (or hand-edits the generated copy).
func TestEmbeddedPiStatusExtensionMatchesPackage(t *testing.T) {
	want := readRepoFile(t, "pi/extensions/waveterm-status.ts")
	if piStatusExtensionTemplate != want {
		t.Fatalf("piStatusExtensionTemplate != pi/extensions/waveterm-status.ts\nrun: task sync:piartifacts")
	}
}

func TestEmbeddedArcThemeMatchesPackage(t *testing.T) {
	want := readRepoFile(t, "pi/themes/arc.json")
	if arcThemeTemplate != want {
		t.Fatalf("arcThemeTemplate != pi/themes/arc.json\nrun: task sync:piartifacts")
	}
}
