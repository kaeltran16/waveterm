// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package boarddrawer

import (
	"os"
	"path/filepath"
	"testing"
)

func TestRemoveSessionDeletesOnlyThatSession(t *testing.T) {
	root := t.TempDir()
	t.Setenv("CLAUDE_CONFIG_DIR", root)
	const gone, kept = "3595fa34-f5da-4c1b-a060-ece3231792c3", "77897c81-52b0-48c5-bfc5-17f1bd799142"
	proj := filepath.Join(root, "projects", "C--repo")
	other := filepath.Join(root, "projects", "c--repo")
	for _, p := range []string{
		filepath.Join(proj, gone+".jsonl"),
		filepath.Join(proj, gone, "tool-results", "r1.txt"),
		filepath.Join(other, gone+".jsonl"),
		filepath.Join(proj, kept+".jsonl"),
		filepath.Join(proj, kept, "tool-results", "r1.txt"),
	} {
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte("{}"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := RemoveSession(gone); err != nil {
		t.Fatal(err)
	}
	for _, p := range []string{filepath.Join(proj, gone+".jsonl"), filepath.Join(proj, gone), filepath.Join(other, gone+".jsonl")} {
		if _, err := os.Stat(p); !os.IsNotExist(err) {
			t.Errorf("%s must be gone (%v)", p, err)
		}
	}
	for _, p := range []string{filepath.Join(proj, kept+".jsonl"), filepath.Join(proj, kept, "tool-results", "r1.txt")} {
		if _, err := os.Stat(p); err != nil {
			t.Errorf("%s must stay: %v", p, err)
		}
	}
	if err := RemoveSession("*"); err == nil {
		t.Error("a pattern is not a session id")
	}
	if err := RemoveSession(kept[:8]); err == nil {
		t.Error("a partial id is not a session id")
	}
}
