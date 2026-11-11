// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package orchestrate

import (
	"context"
	"path/filepath"
	"testing"
)

// initRepoWithIgnore is a repo with a.txt and a .gitignore holding out/, both committed.
func initRepoWithIgnore(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	useTestWorktreeRoot(t)
	gitCmd(t, dir, "init", "-b", "main")
	gitCmd(t, dir, "config", "user.email", "t@test")
	gitCmd(t, dir, "config", "user.name", "t")
	writeFile(t, filepath.Join(dir, "a.txt"), "zero\n")
	writeFile(t, filepath.Join(dir, ".gitignore"), "out/\n")
	gitCmd(t, dir, "add", ".")
	gitCmd(t, dir, "commit", "-qm", "base")
	return dir
}

func TestFingerprintSeesCommitsEditsAndNewFiles(t *testing.T) {
	dir := initRepoWithIgnore(t)
	ctx := context.Background()
	fp := func() string {
		s, err := worktreeFingerprint(ctx, dir)
		if err != nil {
			t.Fatal(err)
		}
		return s
	}
	base := fp()
	writeFile(t, filepath.Join(dir, "a.txt"), "one")
	edited := fp()
	if edited == base {
		t.Fatal("an edit is progress")
	}
	// already modified: status text alone would not change; a different length changes the size within the same second
	writeFile(t, filepath.Join(dir, "a.txt"), "one two")
	if fp() == edited {
		t.Fatal("a further edit to a modified file is progress")
	}
	before := fp()
	writeFile(t, filepath.Join(dir, "out", "log.txt"), "artifact")
	if fp() != before {
		t.Fatal("an ignored file is not progress")
	}
	writeFile(t, filepath.Join(dir, "new.txt"), "x")
	withNew := fp()
	if withNew == before {
		t.Fatal("a new untracked file is progress")
	}
	gitCmd(t, dir, "add", "-A")
	gitCmd(t, dir, "commit", "-qm", "c")
	if fp() == withNew {
		t.Fatal("a commit is progress")
	}
}

func TestFingerprintErrorsOutsideARepo(t *testing.T) {
	if _, err := worktreeFingerprint(context.Background(), filepath.Join(t.TempDir(), "gone")); err == nil {
		t.Fatal("an unreadable tree is an error, not a fingerprint")
	}
}

func TestSuspectReasonNamesWhatFired(t *testing.T) {
	if got, want := suspectReason(22*60_000, "running go test ./pkg/x"), "worktree unchanged 22m while active; now: running go test ./pkg/x"; got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
	if got, want := suspectReason(22*60_000, ""), "worktree unchanged 22m while active"; got != want {
		t.Fatalf("with no current tool, got %q, want %q", got, want)
	}
}
