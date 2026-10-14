// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package orchestrate

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/google/uuid"
)

func TestStorageSeamRunKeyForTreeDir(t *testing.T) {
	root := useRoot(t)
	id := uuid.NewString()
	if err := claimRunPrefix(root, id); err != nil {
		t.Fatal(err)
	}
	unmarked := uuid.NewString()
	for name, want := range map[string]string{
		id[:runPrefixLen]:            id,
		id[:runPrefixLen] + "-t-3":   id + "-t-3",
		id[:runPrefixLen] + "-final": id + "-final",
		unmarked + "-t-1":            unmarked + "-t-1",
		unmarked:                     unmarked,
	} {
		got, ok := RunKeyForTreeDir(root, name)
		if !ok || got != want {
			t.Errorf("RunKeyForTreeDir(%s) = %q, %v; want %q", name, got, ok, want)
		}
	}
	for _, name := range []string{unmarked[:runPrefixLen], unmarked[:runPrefixLen] + "-t-3", "run-1-t-0", "src", id[:runPrefixLen] + "x"} {
		if got, ok := RunKeyForTreeDir(root, name); ok {
			t.Errorf("RunKeyForTreeDir(%s) = %q, want no key", name, got)
		}
	}
}

// seamTree makes a run tree on wave/<key> in a fresh repo under a fresh worktree root.
func seamTree(t *testing.T) (project, key, wt string) {
	t.Helper()
	project = newGitRepo(t)
	key = uuid.NewString() + "-t-1"
	wt, err := CreateRunWorktree(context.Background(), project, key, gitCmd(t, project, "rev-parse", "HEAD"))
	if err != nil {
		t.Fatal(err)
	}
	return project, key, wt
}

func assertExists(t *testing.T, path string) {
	t.Helper()
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("%s should still exist: %v", path, err)
	}
}

func assertBranch(t *testing.T, project, key string, want bool) {
	t.Helper()
	if got := gitCmd(t, project, "branch", "--list", "wave/"+key) != ""; got != want {
		t.Fatalf("branch wave/%s exists = %v, want %v", key, got, want)
	}
}

func TestStorageSeamRemoveRunWorktreeExclusive(t *testing.T) {
	ctx := context.Background()
	project, key, wt := seamTree(t)

	unlock := LockTreeForTest(wt)
	err := RemoveRunWorktreeExclusive(ctx, project, key, wt)
	unlock()
	if !errors.Is(err, ErrTreeBusy) {
		t.Fatalf("removing a tree the engine holds = %v, want ErrTreeBusy", err)
	}
	assertExists(t, wt)

	if err := RemoveRunWorktreeExclusive(ctx, project, key, filepath.Join(filepath.Dir(wt), "elsewhere")); err == nil {
		t.Fatal("a wantPath other than the resolved tree must be refused")
	}
	assertExists(t, wt)
	assertBranch(t, project, key, true)

	if err := RemoveRunWorktreeExclusive(ctx, project, key, wt); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(wt); !os.IsNotExist(err) {
		t.Fatalf("the tree should be gone, stat err %v", err)
	}
	assertBranch(t, project, key, false)
	if isWorktreeRegistered(ctx, project, wt) {
		t.Fatal("the tree is still registered")
	}
	assertExists(t, runMarkerPath(worktreeRoot(), key[:runIDLen]))
}

func TestStorageSeamBranchOnly(t *testing.T) {
	ctx := context.Background()
	project, key, wt := seamTree(t)

	if err := RemoveRunWorktreeExclusive(ctx, project, key, ""); err == nil {
		t.Fatal("a branch-only removal must be refused while the tree is on disk")
	}
	assertExists(t, wt)
	assertBranch(t, project, key, true)

	if err := removeWorktreeDir(ctx, project, wt); err != nil {
		t.Fatal(err)
	}
	if err := RemoveRunWorktreeExclusive(ctx, project, key, ""); err != nil {
		t.Fatal(err)
	}
	assertBranch(t, project, key, false)
}

func TestStorageSeamRemoveDirExclusive(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "leftover")
	writeFile(t, filepath.Join(dir, "a.txt"), "a\n")

	unlock := LockTreeForTest(dir)
	err := RemoveDirExclusive(dir)
	unlock()
	if !errors.Is(err, ErrTreeBusy) {
		t.Fatalf("removing a held dir = %v, want ErrTreeBusy", err)
	}
	assertExists(t, dir)

	if err := RemoveDirExclusive(dir); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatalf("the folder should be gone, stat err %v", err)
	}
	if err := RemoveDirExclusive(dir); err != nil {
		t.Fatalf("removing a folder already gone = %v, want nil", err)
	}
}
