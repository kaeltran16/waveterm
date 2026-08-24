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

func TestEnsureRunWorktreeReusesCleanTree(t *testing.T) {
	dir := newGitRepo(t)
	base := gitCmd(t, dir, "rev-parse", "HEAD")
	key := TaskWorktreeKey("owner-1", "t-1")
	wt, err := CreateRunWorktree(context.Background(), dir, key, base)
	if err != nil {
		t.Fatal(err)
	}
	// sentinel: a reused tree keeps its files; a recreated one would not
	os.WriteFile(filepath.Join(wt, "sentinel.txt"), []byte("x"), 0o644)
	gitCmd(t, wt, "add", ".")
	gitCmd(t, wt, "commit", "-m", "child work")
	got, err := EnsureRunWorktree(context.Background(), dir, key, base)
	if err != nil {
		t.Fatal(err)
	}
	if got != wt {
		t.Fatalf("clean committed tree must be reused: got %s want %s", got, wt)
	}
	if _, err := os.Stat(filepath.Join(wt, "sentinel.txt")); err != nil {
		t.Fatal("sentinel lost on reuse")
	}
}

// A clean tree is always reusable even when head != baseCommit: committed child work must survive,
// and owner.BaseCommit is constant per run so a legitimately wrong-base tree cannot arise from the
// engine itself. This pins that contract.
func TestEnsureRunWorktreeKeepsCommittedWorkWhenBaseAdvanced(t *testing.T) {
	dir := newGitRepo(t)
	base := gitCmd(t, dir, "rev-parse", "HEAD")
	key := TaskWorktreeKey("owner-1", "t-1")
	wt, err := CreateRunWorktree(context.Background(), dir, key, base)
	if err != nil {
		t.Fatal(err)
	}
	os.WriteFile(filepath.Join(wt, "feature.txt"), []byte("feat"), 0o644)
	gitCmd(t, wt, "add", ".")
	gitCmd(t, wt, "commit", "-m", "child work")
	// project advances past base while the child works
	os.WriteFile(filepath.Join(dir, "new.txt"), []byte("n"), 0o644)
	gitCmd(t, dir, "add", ".")
	gitCmd(t, dir, "commit", "-m", "advance")
	newBase := gitCmd(t, dir, "rev-parse", "HEAD")

	got, err := EnsureRunWorktree(context.Background(), dir, key, newBase)
	if err != nil {
		t.Fatal(err)
	}
	if got != wt {
		t.Fatalf("committed child work must not be discarded: %s vs %s", got, wt)
	}
	if _, err := os.Stat(filepath.Join(wt, "feature.txt")); err != nil {
		t.Fatal("child work lost on ensure")
	}
}

func TestEnsureRunWorktreeRecreatesDirtyAndDumpsPatch(t *testing.T) {
	dir := newGitRepo(t)
	base := gitCmd(t, dir, "rev-parse", "HEAD")
	key := TaskWorktreeKey("owner-1", "t-1")
	wt, err := CreateRunWorktree(context.Background(), dir, key, base)
	if err != nil {
		t.Fatal(err)
	}
	os.WriteFile(filepath.Join(wt, "uncommitted.txt"), []byte("wip"), 0o644)

	if _, err := EnsureRunWorktree(context.Background(), dir, key, base); err != nil {
		t.Fatal(err)
	}
	if status := gitCmd(t, wt, "status", "--porcelain"); strings.TrimSpace(status) != "" {
		t.Fatalf("dirty tree must be recreated clean, status = %q", status)
	}
	patch, err := os.ReadFile(filepath.Join(dir, ".waveterm", "recovery", key+".patch"))
	if err != nil {
		t.Fatalf("recovery patch missing: %v", err)
	}
	if !strings.Contains(string(patch), "uncommitted.txt") {
		t.Fatalf("patch must capture uncommitted work, got:\n%s", patch)
	}
}

// newGitRepoAt git-inits an existing directory (the channel's project path) with one base commit.
func newGitRepoAt(t *testing.T, dir string) {
	t.Helper()
	gitCmd(t, dir, "init", "-b", "main")
	gitCmd(t, dir, "config", "user.email", "t@test")
	gitCmd(t, dir, "config", "user.name", "t")
	os.WriteFile(filepath.Join(dir, "base.txt"), []byte("base\n"), 0o644)
	gitCmd(t, dir, "add", ".")
	gitCmd(t, dir, "commit", "-m", "base")
}
