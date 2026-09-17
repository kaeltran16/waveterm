package orchestrate

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestMergeSquash(t *testing.T) {
	dir := newGitRepo(t)
	base := gitCmd(t, dir, "rev-parse", "HEAD")
	wt, _ := CreateRunWorktree(context.Background(), dir, "run-1", base)
	os.WriteFile(filepath.Join(wt, "feature.txt"), []byte("feat\n"), 0o644)
	gitCmd(t, wt, "add", ".")
	gitCmd(t, wt, "commit", "-m", "feature")
	sha, err := MergeRunWorktree(context.Background(), dir, "run-1", "do the thing", nil)
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
	_, err := MergeRunWorktree(context.Background(), dir, "run-1", "do the thing", nil)
	if !errors.Is(err, ErrMergeConflict) {
		t.Fatalf("want ErrMergeConflict, got %v", err)
	}
	// resolve in the project tree, then continue
	os.WriteFile(filepath.Join(dir, "base.txt"), []byte("resolved\n"), 0o644)
	gitCmd(t, dir, "add", ".")
	if _, err := MergeContinue(context.Background(), dir, "run-1", "do the thing", nil); err != nil {
		t.Fatal(err)
	}
}

// the lead's rules say to commit a resolved conflict before `dag merge --continue`, so the commit the
// continue finds at HEAD holds the branch's work even though its message is the lead's own
func TestMergeContinueAfterTheResolverCommittedReturnsTheirCommit(t *testing.T) {
	dir := newGitRepo(t)
	base := gitCmd(t, dir, "rev-parse", "HEAD")
	wt, _ := CreateRunWorktree(context.Background(), dir, "run-1", base)
	os.WriteFile(filepath.Join(wt, "base.txt"), []byte("child change\n"), 0o644)
	gitCmd(t, wt, "add", ".")
	gitCmd(t, wt, "commit", "-m", "child")
	os.WriteFile(filepath.Join(dir, "base.txt"), []byte("parent change\n"), 0o644)
	gitCmd(t, dir, "add", ".")
	gitCmd(t, dir, "commit", "-m", "parent")
	if _, err := MergeRunWorktree(context.Background(), dir, "run-1", "do the thing", nil); !errors.Is(err, ErrMergeConflict) {
		t.Fatalf("want ErrMergeConflict, got %v", err)
	}
	os.WriteFile(filepath.Join(dir, "base.txt"), []byte("parent change\nchild change\n"), 0o644)
	gitCmd(t, dir, "add", ".")
	gitCmd(t, dir, "commit", "-m", "resolve the base.txt conflict")
	resolved := gitCmd(t, dir, "rev-parse", "HEAD")

	sha, err := MergeContinue(context.Background(), dir, "run-1", "do the thing", nil)
	if err != nil {
		t.Fatal(err)
	}
	if sha != resolved {
		t.Fatalf("want the resolver's commit %s, got %q", resolved, sha)
	}
}

// a lane that landed nothing must not be credited with whatever commit is the project's tip: acceptance 2's
// report credited a verify-only task with its predecessor's commit
func TestMergeOfALaneThatLandedNothingReturnsNoCommit(t *testing.T) {
	cases := map[string]func(t *testing.T, wt string){
		"no commits": func(*testing.T, string) {},
		"commits that net to none": func(t *testing.T, wt string) {
			os.WriteFile(filepath.Join(wt, "scratch.txt"), []byte("scratch\n"), 0o644)
			gitCmd(t, wt, "add", ".")
			gitCmd(t, wt, "commit", "-m", "add scratch")
			gitCmd(t, wt, "rm", "-q", "scratch.txt")
			gitCmd(t, wt, "commit", "-m", "drop scratch")
		},
	}
	for name, work := range cases {
		t.Run(name, func(t *testing.T) {
			dir := newGitRepo(t)
			os.WriteFile(filepath.Join(dir, "earlier.txt"), []byte("earlier lane\n"), 0o644)
			gitCmd(t, dir, "add", ".")
			gitCmd(t, dir, "commit", "-m", "run run-1: an earlier lane")
			head := gitCmd(t, dir, "rev-parse", "HEAD")
			wt, err := CreateRunWorktree(context.Background(), dir, "run-2", head)
			if err != nil {
				t.Fatal(err)
			}
			work(t, wt)

			sha, err := MergeRunWorktree(context.Background(), dir, "run-2", "verify only", nil)
			if err != nil {
				t.Fatal(err)
			}
			if sha != "" {
				t.Fatalf("want no commit, got %q", sha)
			}
			if got := gitCmd(t, dir, "rev-parse", "HEAD"); got != head {
				t.Fatalf("nothing may be committed, HEAD moved to %s", got)
			}
		})
	}
}

// a merge retried after its squash already landed still reports that squash, whether the branch survived the
// earlier attempt or cleanup already deleted it
func TestMergeRetryAfterTheSquashLandedReturnsItsCommit(t *testing.T) {
	dir := newGitRepo(t)
	base := gitCmd(t, dir, "rev-parse", "HEAD")
	wt, _ := CreateRunWorktree(context.Background(), dir, "run-1", base)
	os.WriteFile(filepath.Join(wt, "feature.txt"), []byte("feat\n"), 0o644)
	gitCmd(t, wt, "add", ".")
	gitCmd(t, wt, "commit", "-m", "feature")
	landed, err := MergeRunWorktree(context.Background(), dir, "run-1", "do the thing", nil)
	if err != nil {
		t.Fatal(err)
	}

	if sha, err := MergeRunWorktree(context.Background(), dir, "run-1", "do the thing", nil); err != nil || sha != landed {
		t.Fatalf("branch still present: want %s, got %q (%v)", landed, sha, err)
	}
	gitCmd(t, dir, "worktree", "remove", "--force", wt)
	gitCmd(t, dir, "branch", "-D", "wave/run-1")
	if sha, err := MergeRunWorktree(context.Background(), dir, "run-1", "do the thing", nil); err != nil || sha != landed {
		t.Fatalf("branch deleted: want %s, got %q (%v)", landed, sha, err)
	}
}

func TestMergeRunWorktreeNonGit(t *testing.T) {
	dir := t.TempDir()
	_, err := MergeRunWorktree(context.Background(), dir, "run-1", "x", nil)
	if !errors.Is(err, ErrNotGitRepo) {
		t.Fatalf("want ErrNotGitRepo, got %v", err)
	}
}

// the run's spec and plan sit uncommitted in the project checkout until its first merge, which lands them
// with the work they describe
func TestMergeRunWorktreeFoldsDocsIntoTheSquashCommit(t *testing.T) {
	dir := newGitRepo(t)
	base := gitCmd(t, dir, "rev-parse", "HEAD")
	wt, _ := CreateRunWorktree(context.Background(), dir, "run-1", base)
	os.WriteFile(filepath.Join(wt, "feature.txt"), []byte("feat\n"), 0o644)
	gitCmd(t, wt, "add", ".")
	gitCmd(t, wt, "commit", "-m", "feature")
	spec := filepath.Join(dir, "spec.md")
	plan := filepath.Join(dir, "plan.md")
	os.WriteFile(spec, []byte("# spec\n"), 0o644)
	os.WriteFile(plan, []byte("# plan\n"), 0o644)
	outside := filepath.Join(t.TempDir(), "elsewhere.md")
	os.WriteFile(outside, []byte("# not in this repo\n"), 0o644)

	if _, err := MergeRunWorktree(context.Background(), dir, "run-1", "lane", []string{spec, plan, outside}); err != nil {
		t.Fatalf("a path git will not stage must not fail the merge: %v", err)
	}
	files := strings.Fields(gitCmd(t, dir, "show", "--name-only", "--format=", "HEAD"))
	if want := []string{"feature.txt", "plan.md", "spec.md"}; !reflect.DeepEqual(files, want) {
		t.Fatalf("squash commit files = %v, want %v", files, want)
	}
}
