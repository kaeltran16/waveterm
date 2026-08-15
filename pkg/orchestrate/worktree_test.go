package orchestrate

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func gitCmd(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
	return strings.TrimSpace(string(out))
}

func newGitRepo(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	gitCmd(t, dir, "init", "-b", "main")
	gitCmd(t, dir, "config", "user.email", "t@test")
	gitCmd(t, dir, "config", "user.name", "t")
	os.WriteFile(filepath.Join(dir, "base.txt"), []byte("base\n"), 0o644)
	gitCmd(t, dir, "add", ".")
	gitCmd(t, dir, "commit", "-m", "base")
	return dir
}

func TestCreateAndRemoveWorktree(t *testing.T) {
	dir := newGitRepo(t)
	base := gitCmd(t, dir, "rev-parse", "HEAD")
	wt, err := CreateRunWorktree(context.Background(), dir, "run-1", base)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(wt, "base.txt")); err != nil {
		t.Fatalf("worktree missing base file: %v", err)
	}
	if err := RemoveRunWorktree(context.Background(), dir, "run-1"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(wt); !os.IsNotExist(err) {
		t.Fatalf("worktree still exists: %v", err)
	}
}

func TestIsGitRepoFalse(t *testing.T) {
	if IsGitRepo(t.TempDir()) {
		t.Fatal("temp dir must not be a git repo")
	}
}

func TestRecoveryPatch(t *testing.T) {
	dir := newGitRepo(t)
	base := gitCmd(t, dir, "rev-parse", "HEAD")
	wt, _ := CreateRunWorktree(context.Background(), dir, "run-1", base)
	os.WriteFile(filepath.Join(wt, "new.txt"), []byte("work\n"), 0o644)
	gitCmd(t, wt, "add", ".")
	gitCmd(t, wt, "commit", "-m", "wip")
	if err := DumpRecoveryPatch(context.Background(), dir, "run-1"); err != nil {
		t.Fatal(err)
	}
	patch := filepath.Join(dir, ".waveterm", "recovery", "run-1.patch")
	if _, err := os.Stat(patch); err != nil {
		t.Fatalf("recovery patch missing: %v", err)
	}
}
