package orchestrate

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestMergeSquash(t *testing.T) {
	dir := newGitRepo(t)
	base := gitCmd(t, dir, "rev-parse", "HEAD")
	wt, _ := CreateRunWorktree(context.Background(), dir, "run-1", base)
	os.WriteFile(filepath.Join(wt, "feature.txt"), []byte("feat\n"), 0o644)
	gitCmd(t, wt, "add", ".")
	gitCmd(t, wt, "commit", "-m", "feature")
	sha, err := MergeRunWorktree(context.Background(), dir, "run-1", "do the thing")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "feature.txt")); err != nil {
		t.Fatalf("merged file missing: %v", err)
	}
	if len(sha) != 40 {
		t.Fatalf("bad merge sha %q", sha)
	}
	// integration is separate from resource cleanup: the worktree stays until the caller
	// runs CleanupTaskWorktree, so a cleanup failure can never obscure an already-landed merge.
	if _, err := os.Stat(wt); err != nil {
		t.Fatalf("worktree removal must be left to the cleanup helper: %v", err)
	}
}

func TestMergeConflictBlocked(t *testing.T) {
	dir := newGitRepo(t)
	base := gitCmd(t, dir, "rev-parse", "HEAD")
	wt, _ := CreateRunWorktree(context.Background(), dir, "run-1", base)
	os.WriteFile(filepath.Join(wt, "base.txt"), []byte("child change\n"), 0o644)
	gitCmd(t, wt, "add", ".")
	gitCmd(t, wt, "commit", "-m", "child")
	os.WriteFile(filepath.Join(dir, "base.txt"), []byte("parent change\n"), 0o644)
	gitCmd(t, dir, "add", ".")
	gitCmd(t, dir, "commit", "-m", "parent")
	_, err := MergeRunWorktree(context.Background(), dir, "run-1", "do the thing")
	if !errors.Is(err, ErrMergeConflict) {
		t.Fatalf("want ErrMergeConflict, got %v", err)
	}
	// resolve in the project tree, then continue
	os.WriteFile(filepath.Join(dir, "base.txt"), []byte("resolved\n"), 0o644)
	gitCmd(t, dir, "add", ".")
	if _, err := MergeContinue(context.Background(), dir, "run-1", "do the thing"); err != nil {
		t.Fatal(err)
	}
}

func TestMergeRunWorktreeNonGit(t *testing.T) {
	dir := t.TempDir()
	_, err := MergeRunWorktree(context.Background(), dir, "run-1", "x")
	if !errors.Is(err, ErrNotGitRepo) {
		t.Fatalf("want ErrNotGitRepo, got %v", err)
	}
}
