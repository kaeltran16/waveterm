// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

//go:build windows

package orchestrate

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func mklinkJunction(t *testing.T, link, target string) {
	t.Helper()
	if out, err := exec.Command("cmd", "/c", "mklink", "/J", link, target).CombinedOutput(); err != nil {
		t.Fatalf("mklink /J %s %s: %v\n%s", link, target, err, out)
	}
}

// task worktree:prepare junctions the main checkout's node_modules, src-tauri/target and dist/bin into a
// worktree, and git worktree remove --force deletes through a junction on Windows.
func TestRemoveRunWorktreeLeavesJunctionTargetsIntact(t *testing.T) {
	dir := newGitRepo(t)
	base := gitCmd(t, dir, "rev-parse", "HEAD")
	wt, err := CreateRunWorktree(context.Background(), dir, "run-1", base)
	if err != nil {
		t.Fatal(err)
	}
	shared := t.TempDir()
	keep := filepath.Join(shared, "keep.txt")
	if err := os.WriteFile(keep, []byte("keep\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	mklinkJunction(t, filepath.Join(wt, "node_modules"), shared)
	if err := os.MkdirAll(filepath.Join(wt, "dist"), 0o755); err != nil {
		t.Fatal(err)
	}
	mklinkJunction(t, filepath.Join(wt, "dist", "bin"), shared)

	if err := RemoveRunWorktree(context.Background(), dir, "run-1"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(wt); !os.IsNotExist(err) {
		t.Fatalf("worktree must be removed, stat err = %v", err)
	}
	if b, err := os.ReadFile(keep); err != nil || string(b) != "keep\n" {
		t.Fatalf("a junction target must survive worktree removal, got %q err %v", b, err)
	}
}

// The whole point of the unregistered-dir delete is that it reports what is on disk. A live worker
// process holding the tree is what made the delete fail in the first place, and a cleanup that cannot
// remove the directory has to say so rather than emit task-cleanup-completed over it.
func TestRemoveRunWorktreeReportsADirItCannotDelete(t *testing.T) {
	dir := newGitRepo(t)
	base := gitCmd(t, dir, "rev-parse", "HEAD")
	wt, err := CreateRunWorktree(context.Background(), dir, "run-1", base)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(filepath.Join(dir, ".git", "worktrees")); err != nil {
		t.Fatal(err)
	}
	gitCmd(t, dir, "worktree", "prune")
	held, err := os.Create(filepath.Join(wt, "held.txt")) // stands in for the worker's open handle
	if err != nil {
		t.Fatal(err)
	}
	defer held.Close()

	if err := RemoveRunWorktree(context.Background(), dir, "run-1"); err == nil {
		t.Fatal("a worktree dir that could not be deleted must be reported, not swallowed")
	}
	if _, err := os.Stat(wt); err != nil {
		t.Fatalf("the reported failure must match disk: worktree stat err = %v", err)
	}
}
