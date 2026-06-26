// pkg/gitinfo/gitinfo_test.go
package gitinfo

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func git(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
	cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
}

func repoWithChange(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	git(t, dir, "init", "-b", "main")
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("one\ntwo\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	git(t, dir, "add", ".")
	git(t, dir, "commit", "-m", "init")
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("one\ntwo\nthree\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "b.txt"), []byte("new\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	return dir
}

func TestGetChanges(t *testing.T) {
	dir := repoWithChange(t)
	ch, err := GetChanges(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	if !ch.IsRepo {
		t.Fatal("expected IsRepo true")
	}
	if ch.Branch != "main" {
		t.Fatalf("branch = %q, want main", ch.Branch)
	}
	if !strings.Contains(ch.StatusZ, "a.txt") || !strings.Contains(ch.StatusZ, "b.txt") {
		t.Fatalf("statusz missing files: %q", ch.StatusZ)
	}
	if !strings.Contains(ch.Numstat, "a.txt") {
		t.Fatalf("numstat missing tracked change: %q", ch.Numstat)
	}
}

func TestGetChangesNotARepo(t *testing.T) {
	ch, err := GetChanges(context.Background(), t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if ch.IsRepo {
		t.Fatal("expected IsRepo false outside a repo")
	}
}

func TestGetDiffTracked(t *testing.T) {
	dir := repoWithChange(t)
	d, err := GetDiff(context.Background(), dir, "a.txt")
	if err != nil {
		t.Fatal(err)
	}
	if d.Untracked {
		t.Fatal("a.txt is tracked")
	}
	if !strings.Contains(d.Diff, "+three") {
		t.Fatalf("diff missing addition: %q", d.Diff)
	}
}

func TestGetDiffUntracked(t *testing.T) {
	dir := repoWithChange(t)
	d, err := GetDiff(context.Background(), dir, "b.txt")
	if err != nil {
		t.Fatal(err)
	}
	if !d.Untracked {
		t.Fatal("b.txt should be untracked")
	}
	if strings.TrimSpace(d.Content) != "new" {
		t.Fatalf("content = %q, want new", d.Content)
	}
}
