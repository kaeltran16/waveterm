// pkg/gitinfo/gitinfo_test.go
package gitinfo

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
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

func TestHeadCommit(t *testing.T) {
	dir := repoWithChange(t) // has one commit ("init") + uncommitted edits
	sha, err := HeadCommit(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(strings.TrimSpace(sha)) != 40 {
		t.Fatalf("HeadCommit = %q, want a 40-char sha", sha)
	}
	// not a repo -> error, empty
	if _, err := HeadCommit(context.Background(), t.TempDir()); err == nil {
		t.Fatal("expected error for a non-repo dir")
	}
}

// commitAt writes file=content, stages, and commits with a fixed committer date (rev-list --before
// filters on committer date). Returns the new commit sha.
func commitAt(t *testing.T, dir, file, content string, unixSec int64) string {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, file), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	date := time.Unix(unixSec, 0).UTC().Format(time.RFC3339)
	env := append(os.Environ(),
		"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_AUTHOR_DATE="+date,
		"GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t", "GIT_COMMITTER_DATE="+date)
	for _, args := range [][]string{{"add", "."}, {"commit", "-m", "c"}} {
		cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
		cmd.Env = env
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	sha, err := HeadCommit(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	return sha
}

func TestCommitBefore(t *testing.T) {
	dir := t.TempDir()
	git(t, dir, "init", "-b", "main")
	_ = commitAt(t, dir, "a.txt", "1\n", 1000)
	c2 := commitAt(t, dir, "a.txt", "1\n2\n", 2000)
	c3 := commitAt(t, dir, "a.txt", "1\n2\n3\n", 3000)

	if got, _ := CommitBefore(context.Background(), dir, 500); got != "" {
		t.Fatalf("before-all = %q, want empty", got)
	}
	if got, _ := CommitBefore(context.Background(), dir, 2500); got != c2 {
		t.Fatalf("mid = %q, want c2 %q", got, c2)
	}
	if got, _ := CommitBefore(context.Background(), dir, 4000); got != c3 {
		t.Fatalf("after-all = %q, want c3 (HEAD) %q", got, c3)
	}
	if got, err := CommitBefore(context.Background(), t.TempDir(), 4000); err != nil || got != "" {
		t.Fatalf("non-repo = %q, err %v; want empty,nil", got, err)
	}
}

func TestGetChanges(t *testing.T) {
	dir := repoWithChange(t)
	ch, err := GetChanges(context.Background(), dir, "")
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
	// b.txt is untracked with one line ("new\n") — its added line must be counted in numstat
	if !strings.Contains(ch.Numstat, "1\t0\tb.txt") {
		t.Fatalf("untracked b.txt not counted in numstat: %q", ch.Numstat)
	}
}

// repoCommittedOnBase makes a repo with an initial commit, records that SHA as the base, then commits
// a modification and a new file on top. Returns (dir, baseSHA). No uncommitted changes remain.
func repoCommittedOnBase(t *testing.T) (string, string) {
	t.Helper()
	dir := t.TempDir()
	git(t, dir, "init", "-b", "main")
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("one\ntwo\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	git(t, dir, "add", ".")
	git(t, dir, "commit", "-m", "init")
	base, err := HeadCommit(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("one\ntwo\nthree\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "c.txt"), []byte("added\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	git(t, dir, "add", ".")
	git(t, dir, "commit", "-m", "work")
	return dir, base
}

func TestGetChangesRefIncludesCommitted(t *testing.T) {
	dir, base := repoCommittedOnBase(t)
	// HEAD-mode sees nothing (work is committed) — this is the bug we are fixing.
	head, err := GetChanges(context.Background(), dir, "")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(head.Numstat, "a.txt") {
		t.Fatalf("HEAD-mode unexpectedly shows committed change: %q", head.Numstat)
	}
	// ref-mode against the base sees the committed modification (a.txt) and the added file (c.txt).
	ch, err := GetChanges(context.Background(), dir, base)
	if err != nil {
		t.Fatal(err)
	}
	if !ch.IsRepo {
		t.Fatal("expected IsRepo true")
	}
	if !strings.Contains(ch.StatusZ, "a.txt") || !strings.Contains(ch.StatusZ, "c.txt") {
		t.Fatalf("ref statusz missing committed files: %q", ch.StatusZ)
	}
	if !strings.Contains(ch.Numstat, "1\t0\ta.txt") {
		t.Fatalf("ref numstat missing a.txt +1: %q", ch.Numstat)
	}
}

// TestGetRangeChangesExcludesSiblings is the core guard for the fan-out over-attribution fix: a
// commit-range diff (base..tipA) must show only tipA's own commits, never a sibling that merely shares
// the working tree (branch b). It also proves the untracked/working-tree noise never leaks in.
func TestGetRangeChangesExcludesSiblings(t *testing.T) {
	dir := initRepo(t)
	writeFile(t, dir, "base.txt", "base\n")
	commitAll(t, dir)
	base, err := HeadCommit(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	// branch A off base: commits a.txt (this run's own work)
	git(t, dir, "checkout", "-b", "a")
	writeFile(t, dir, "a.txt", "a1\na2\n")
	git(t, dir, "add", "-A")
	git(t, dir, "commit", "-m", "a")
	tipA, err := HeadCommit(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	// branch B off base: commits b.txt (a sibling that shares the tree but not A's lineage), then leaves
	// an uncommitted working-tree edit (must also be excluded from a pure commit-range diff)
	git(t, dir, "checkout", base)
	git(t, dir, "checkout", "-b", "b")
	writeFile(t, dir, "b.txt", "b1\n")
	git(t, dir, "add", "-A")
	git(t, dir, "commit", "-m", "b")
	writeFile(t, dir, "dirty.txt", "d\n")

	ch, err := GetRangeChanges(context.Background(), dir, base, tipA)
	if err != nil {
		t.Fatalf("GetRangeChanges: %v", err)
	}
	if !ch.IsRepo {
		t.Fatal("expected IsRepo=true")
	}
	if !strings.Contains(ch.StatusZ, "a.txt") {
		t.Errorf("expected a.txt in range, got %q", ch.StatusZ)
	}
	if strings.Contains(ch.StatusZ, "b.txt") || strings.Contains(ch.StatusZ, "dirty.txt") {
		t.Errorf("sibling/working-tree noise leaked into range diff: %q", ch.StatusZ)
	}
	if !strings.Contains(ch.Numstat, "a.txt") || strings.Contains(ch.Numstat, "b.txt") {
		t.Errorf("numstat wrong: %q", ch.Numstat)
	}
	// not a repo -> IsRepo false, no error
	nc, err := GetRangeChanges(context.Background(), t.TempDir(), base, tipA)
	if err != nil {
		t.Fatalf("non-repo should not error: %v", err)
	}
	if nc.IsRepo {
		t.Fatal("expected IsRepo=false outside a repo")
	}
}

func TestGetDiffRefShowsCommittedPatch(t *testing.T) {
	dir, base := repoCommittedOnBase(t)
	d, err := GetDiff(context.Background(), dir, "a.txt", base)
	if err != nil {
		t.Fatal(err)
	}
	if d.Untracked {
		t.Fatal("a.txt is tracked; Untracked should be false")
	}
	if !strings.Contains(d.Diff, "+three") {
		t.Fatalf("ref diff missing the added line: %q", d.Diff)
	}
}

func TestUntrackedAdds(t *testing.T) {
	dir := t.TempDir()
	write := func(name, content string) string {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
		return p
	}
	cases := []struct{ name, content, want string }{
		{"three.txt", "a\nb\nc\n", "3"},
		{"notrail.txt", "a\nb", "2"}, // final line without a trailing newline still counts
		{"empty.txt", "", "0"},
		{"binary.bin", "a\x00b\n", "-"},
	}
	for _, c := range cases {
		if got := untrackedAdds(write(c.name, c.content)); got != c.want {
			t.Fatalf("%s: adds = %q, want %q", c.name, got, c.want)
		}
	}
	if got := untrackedAdds(filepath.Join(dir, "missing")); got != "-" {
		t.Fatalf("missing file: adds = %q, want -", got)
	}
}

func TestGetChangesExpandsUntrackedDir(t *testing.T) {
	dir := initRepo(t)
	writeFile(t, dir, "base.txt", "base\n")
	commitAll(t, dir)
	// a brand-new directory with files: default porcelain collapses this to a single "newdir/" entry,
	// which the Files surface can't diff (GetDiff would os.ReadFile a directory). -uall must expand it.
	if err := os.MkdirAll(filepath.Join(dir, "newdir"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "newdir", "a.txt"), []byte("aa\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "newdir", "b.txt"), []byte("bb\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	ch, err := GetChanges(context.Background(), dir, "")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(ch.StatusZ, "newdir/a.txt") || !strings.Contains(ch.StatusZ, "newdir/b.txt") {
		t.Fatalf("statusz should list untracked files individually: %q", ch.StatusZ)
	}
	// the collapsed "newdir/" entry must be gone — it would round-trip into GetDiff as a directory
	for _, e := range strings.Split(ch.StatusZ, "\x00") {
		if len(e) >= 3 && e[3:] == "newdir/" {
			t.Fatalf("statusz still has the collapsed directory entry: %q", ch.StatusZ)
		}
	}
	// each expanded path diffs as untracked content (the bug: a "newdir/" row errored here)
	d, err := GetDiff(context.Background(), dir, "newdir/a.txt", "")
	if err != nil {
		t.Fatal(err)
	}
	if !d.Untracked || strings.TrimSpace(d.Content) != "aa" {
		t.Fatalf("expanded untracked file diff wrong: untracked=%v content=%q", d.Untracked, d.Content)
	}
}

func TestGetChangesNotARepo(t *testing.T) {
	ch, err := GetChanges(context.Background(), t.TempDir(), "")
	if err != nil {
		t.Fatal(err)
	}
	if ch.IsRepo {
		t.Fatal("expected IsRepo false outside a repo")
	}
}

func TestGetDiffTracked(t *testing.T) {
	dir := repoWithChange(t)
	d, err := GetDiff(context.Background(), dir, "a.txt", "")
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
	d, err := GetDiff(context.Background(), dir, "b.txt", "")
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

// subdirRepoWithChange builds a monorepo whose changes live under services/foo/ (plus one root
// file), returning the repo root. Models a "microservice" agent whose cwd is a subdirectory of the
// git root — the case where paths from `status` (repo-root-relative) diverge from `git -C <cwd>`
// pathspecs (cwd-relative).
func subdirRepoWithChange(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	git(t, dir, "init", "-b", "main")
	git(t, dir, "config", "core.autocrlf", "false")
	sub := filepath.Join(dir, "services", "foo")
	if err := os.MkdirAll(filepath.Join(sub, "nested"), 0o755); err != nil {
		t.Fatal(err)
	}
	writeFile(t, dir, "README.md", "root\n")
	if err := os.WriteFile(filepath.Join(sub, "app.js"), []byte("one\ntwo\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sub, "nested", "deep.js"), []byte("d\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	git(t, dir, "add", ".")
	git(t, dir, "commit", "-m", "init")
	// changes: modify a tracked file in the subtree, add an untracked file in the subtree, and touch
	// a file OUTSIDE the subtree (must be excluded from the microservice-scoped view).
	if err := os.WriteFile(filepath.Join(sub, "app.js"), []byte("one\ntwo\nthree\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sub, "new.js"), []byte("new\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	writeFile(t, dir, "README.md", "root\nchanged\n")
	return dir
}

func TestGetChangesSubdir(t *testing.T) {
	root := subdirRepoWithChange(t)
	cwd := filepath.Join(root, "services", "foo")
	ch, err := GetChanges(context.Background(), cwd, "")
	if err != nil {
		t.Fatal(err)
	}
	if !ch.IsRepo {
		t.Fatal("expected IsRepo true from a subdir")
	}
	// paths are relative to cwd (the microservice), not the repo root
	if !strings.Contains(ch.StatusZ, "app.js") || strings.Contains(ch.StatusZ, "services/foo/app.js") {
		t.Fatalf("statusz should be cwd-relative: %q", ch.StatusZ)
	}
	// scoped to the subtree: the out-of-subtree README.md change must not appear
	if strings.Contains(ch.StatusZ, "README.md") {
		t.Fatalf("statusz leaked out-of-subtree file: %q", ch.StatusZ)
	}
	// numstat correlates with cwd-relative status paths, and the untracked new.js is counted
	if !strings.Contains(ch.Numstat, "app.js") {
		t.Fatalf("numstat missing tracked change (cwd-relative): %q", ch.Numstat)
	}
	if !strings.Contains(ch.Numstat, "1\t0\tnew.js") {
		t.Fatalf("untracked new.js not counted in numstat: %q", ch.Numstat)
	}
}

// changePathFor returns the path GetChanges reports for the entry ending in `suffix` — the exact
// string the frontend round-trips back into GetDiff/RevertFile. The fixtures have no renames, so
// every entry carries the 2-char status + space prefix.
func changePathFor(t *testing.T, statusZ, suffix string) string {
	t.Helper()
	for _, e := range strings.Split(statusZ, "\x00") {
		if len(e) < 3 {
			continue
		}
		if p := e[3:]; strings.HasSuffix(p, suffix) {
			return p
		}
	}
	t.Fatalf("no change entry ending in %q: %q", suffix, statusZ)
	return ""
}

func TestGetDiffTrackedSubdir(t *testing.T) {
	root := subdirRepoWithChange(t)
	cwd := filepath.Join(root, "services", "foo")
	ch, err := GetChanges(context.Background(), cwd, "")
	if err != nil {
		t.Fatal(err)
	}
	d, err := GetDiff(context.Background(), cwd, changePathFor(t, ch.StatusZ, "app.js"), "")
	if err != nil {
		t.Fatal(err)
	}
	if d.Untracked {
		t.Fatal("app.js is tracked")
	}
	if !strings.Contains(d.Diff, "+three") {
		t.Fatalf("diff missing addition from a subdir: %q", d.Diff)
	}
}

func TestGetDiffUntrackedSubdir(t *testing.T) {
	root := subdirRepoWithChange(t)
	cwd := filepath.Join(root, "services", "foo")
	ch, err := GetChanges(context.Background(), cwd, "")
	if err != nil {
		t.Fatal(err)
	}
	d, err := GetDiff(context.Background(), cwd, changePathFor(t, ch.StatusZ, "new.js"), "")
	if err != nil {
		t.Fatal(err)
	}
	if !d.Untracked {
		t.Fatal("new.js should be untracked")
	}
	if strings.TrimSpace(d.Content) != "new" {
		t.Fatalf("untracked content from a subdir = %q, want new", d.Content)
	}
}

func TestRevertFileSubdir(t *testing.T) {
	root := subdirRepoWithChange(t)
	cwd := filepath.Join(root, "services", "foo")
	ch, err := GetChanges(context.Background(), cwd, "")
	if err != nil {
		t.Fatal(err)
	}
	if err := RevertFile(context.Background(), cwd, changePathFor(t, ch.StatusZ, "app.js"), " M"); err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(filepath.Join(cwd, "app.js"))
	if string(got) != "one\ntwo\n" {
		t.Fatalf("subdir revert did not restore: %q", got)
	}
}

// End-to-end guard for the --relative diff header: the revert patch is reconstructed from that
// header, so a subdir agent's `git -C cwd apply --reverse` only resolves if the header is
// cwd-relative (a/app.js, not a/services/foo/app.js).
func TestRevertHunkSubdir(t *testing.T) {
	root := subdirRepoWithChange(t)
	cwd := filepath.Join(root, "services", "foo")
	d, err := GetDiff(context.Background(), cwd, "app.js", "")
	if err != nil {
		t.Fatal(err)
	}
	if err := RevertHunk(context.Background(), cwd, "app.js", d.Diff); err != nil {
		t.Fatalf("subdir hunk revert failed to apply: %v", err)
	}
	got, _ := os.ReadFile(filepath.Join(cwd, "app.js"))
	if string(got) != "one\ntwo\n" {
		t.Fatalf("subdir hunk revert did not restore: %q", got)
	}
}

func TestWorktreePath(t *testing.T) {
	got := WorktreePath("/home/u/code/payments-api", "feat/new-agent")
	want := filepath.ToSlash(filepath.Join("/home/u/code", "payments-api-worktrees", "feat-new-agent"))
	if filepath.ToSlash(got) != want {
		t.Fatalf("WorktreePath = %q, want %q", filepath.ToSlash(got), want)
	}
}

func TestCreateWorktreeNewBranch(t *testing.T) {
	dir := repoWithChange(t)
	wt, err := CreateWorktree(context.Background(), dir, "feat/new-agent")
	if err != nil {
		t.Fatalf("CreateWorktree: %v", err)
	}
	if _, err := os.Stat(wt); err != nil {
		t.Fatalf("worktree dir not created: %v", err)
	}
	if !strings.HasSuffix(filepath.ToSlash(wt), "-worktrees/feat-new-agent") {
		t.Fatalf("unexpected worktree path: %s", wt)
	}
	// idempotent: a second call reuses the existing worktree dir
	wt2, err := CreateWorktree(context.Background(), dir, "feat/new-agent")
	if err != nil || wt2 != wt {
		t.Fatalf("reuse failed: wt2=%q err=%v", wt2, err)
	}
}

func TestCreateWorktreeNotARepo(t *testing.T) {
	if _, err := CreateWorktree(context.Background(), t.TempDir(), "feat/x"); err == nil {
		t.Fatal("expected error outside a git repo")
	}
}

func TestListBranches(t *testing.T) {
	dir := repoWithChange(t)
	branches, err := ListBranches(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(branches) != 1 || branches[0].Name != "main" {
		t.Fatalf("branches = %+v, want [main]", branches)
	}
	if branches[0].Age == "" {
		t.Fatal("expected a non-empty relative age")
	}
}

func TestListBranchesMultiple(t *testing.T) {
	dir := repoWithChange(t)
	git(t, dir, "branch", "feat/x")
	git(t, dir, "branch", "feat/y")
	branches, err := ListBranches(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(branches) != 3 {
		t.Fatalf("want 3 branches, got %d: %+v", len(branches), branches)
	}
	names := map[string]bool{}
	for _, b := range branches {
		names[b.Name] = true
	}
	for _, want := range []string{"main", "feat/x", "feat/y"} {
		if !names[want] {
			t.Fatalf("missing branch %q in %+v", want, branches)
		}
	}
}

func TestListBranchesNotARepo(t *testing.T) {
	branches, err := ListBranches(context.Background(), t.TempDir())
	if err != nil {
		t.Fatalf("expected nil error for non-repo, got %v", err)
	}
	if len(branches) != 0 {
		t.Fatalf("expected no branches, got %+v", branches)
	}
}

func initRepo(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	ctx := context.Background()
	for _, args := range [][]string{
		{"init"}, {"config", "user.email", "t@t"}, {"config", "user.name", "t"},
		// hermetic line endings: Git-for-Windows' system config defaults core.autocrlf=true,
		// which would rewrite LF<->CRLF on checkout/apply and make these assertions nondeterministic.
		{"config", "core.autocrlf", "false"},
	} {
		if _, err := run(ctx, dir, args...); err != nil {
			t.Fatalf("git %v: %v", args, err)
		}
	}
	return dir
}

func writeFile(t *testing.T, dir, name, content string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func commitAll(t *testing.T, dir string) {
	t.Helper()
	ctx := context.Background()
	if _, err := run(ctx, dir, "add", "-A"); err != nil {
		t.Fatal(err)
	}
	if _, err := run(ctx, dir, "commit", "-m", "base"); err != nil {
		t.Fatal(err)
	}
}

func TestRevertFileModified(t *testing.T) {
	dir := initRepo(t)
	writeFile(t, dir, "a.txt", "one\ntwo\nthree\n")
	commitAll(t, dir)
	writeFile(t, dir, "a.txt", "one\nCHANGED\nthree\n")
	if err := RevertFile(context.Background(), dir, "a.txt", " M"); err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(filepath.Join(dir, "a.txt"))
	if string(got) != "one\ntwo\nthree\n" {
		t.Fatalf("not restored: %q", got)
	}
}

func TestRevertFileUntracked(t *testing.T) {
	dir := initRepo(t)
	writeFile(t, dir, "a.txt", "base\n")
	commitAll(t, dir)
	writeFile(t, dir, "new.txt", "brand new\n")
	if err := RevertFile(context.Background(), dir, "new.txt", "??"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "new.txt")); !os.IsNotExist(err) {
		t.Fatalf("untracked file not removed")
	}
}

func TestRevertHunkPartial(t *testing.T) {
	dir := initRepo(t)
	base := "l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10\nl11\nl12\nl13\nl14\nl15\nl16\nl17\nl18\nl19\nl20\n"
	writeFile(t, dir, "a.txt", base)
	commitAll(t, dir)
	// two edits far enough apart (default 3-line context doesn't merge) -> two separate hunks
	writeFile(t, dir, "a.txt", "l1\nX2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10\nl11\nl12\nl13\nl14\nl15\nl16\nl17\nl18\nX19\nl20\n")
	full, err := run(context.Background(), dir, "diff", "HEAD", "--", "a.txt")
	if err != nil {
		t.Fatal(err)
	}
	// craft a patch containing ONLY the first hunk: header lines + first @@ block
	lines := strings.SplitAfter(full, "\n")
	var header, hunk1 strings.Builder
	seenHunk := 0
	for _, ln := range lines {
		if strings.HasPrefix(ln, "@@") {
			seenHunk++
		}
		if seenHunk == 0 {
			header.WriteString(ln)
		} else if seenHunk == 1 {
			hunk1.WriteString(ln)
		}
	}
	patch := header.String() + hunk1.String()
	if err := RevertHunk(context.Background(), dir, "a.txt", patch); err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(filepath.Join(dir, "a.txt"))
	// first hunk reverted (X2 -> l2), second still dirty (X19 stays)
	if string(got) != "l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10\nl11\nl12\nl13\nl14\nl15\nl16\nl17\nl18\nX19\nl20\n" {
		t.Fatalf("partial revert wrong: %q", got)
	}
}

func TestRevertHunkStaleFails(t *testing.T) {
	dir := initRepo(t)
	writeFile(t, dir, "a.txt", "one\ntwo\n")
	commitAll(t, dir)
	// a patch that does not match the current tree should error, not silently no-op
	bad := "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1,1 +1,1 @@\n-nonexistent\n+whatever\n"
	if err := RevertHunk(context.Background(), dir, "a.txt", bad); err == nil {
		t.Fatal("expected stale patch to fail")
	}
}

func gitRun(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.CommandContext(context.Background(), "git", append([]string{"-C", dir}, args...)...)
	cmd.Env = append(os.Environ(),
		"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
	return strings.TrimSpace(string(out))
}

func TestRangeLog(t *testing.T) {
	dir := t.TempDir()
	gitRun(t, dir, "init", "-q")
	gitRun(t, dir, "commit", "-q", "--allow-empty", "-m", "base commit")
	base := gitRun(t, dir, "rev-parse", "HEAD")
	gitRun(t, dir, "commit", "-q", "--allow-empty", "-m", "PROJ-142 add pkce flow")
	gitRun(t, dir, "commit", "-q", "--allow-empty", "-m", "fix token rotation")
	end := gitRun(t, dir, "rev-parse", "HEAD")

	commits, err := RangeLog(context.Background(), dir, base, end)
	if err != nil {
		t.Fatalf("RangeLog: %v", err)
	}
	if len(commits) != 2 {
		t.Fatalf("want 2 commits in base..end, got %d: %+v", len(commits), commits)
	}
	// git log lists newest first
	if commits[0].Subject != "fix token rotation" || commits[1].Subject != "PROJ-142 add pkce flow" {
		t.Fatalf("subjects wrong: %+v", commits)
	}
	if commits[0].Hash == "" || commits[0].Ts == 0 {
		t.Fatalf("hash/ts not populated: %+v", commits[0])
	}

	// empty range returns empty, not an error
	empty, err := RangeLog(context.Background(), dir, end, end)
	if err != nil {
		t.Fatalf("RangeLog empty: %v", err)
	}
	if len(empty) != 0 {
		t.Fatalf("want 0 commits for end..end, got %d", len(empty))
	}
}

// gitAuthored is git(t, ...) with a named author instead of the bare "t", so the history and
// divergence tests can assert on the author field they carry.
func gitAuthored(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
	cmd.Env = append(os.Environ(),
		"GIT_AUTHOR_NAME=dana k", "GIT_AUTHOR_EMAIL=dana@example.com",
		"GIT_COMMITTER_NAME=dana k", "GIT_COMMITTER_EMAIL=dana@example.com")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v: %s", args, err, out)
	}
}

// commitAuthored writes name=body, stages everything and commits as "dana k".
func commitAuthored(t *testing.T, dir, name, body, msg string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	gitAuthored(t, dir, "add", ".")
	gitAuthored(t, dir, "commit", "-m", msg)
}

// repoBranchMerge builds: root -> a -> (feature: b) -> merge, so history has a real merge commit
// with two parents and a branch ref to decorate.
func repoBranchMerge(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	gitAuthored(t, dir, "init", "--initial-branch=main")
	commitAuthored(t, dir, "root.txt", "root\n", "root commit")
	commitAuthored(t, dir, "a.txt", "a\n", "second on main")
	gitAuthored(t, dir, "checkout", "-b", "feature")
	commitAuthored(t, dir, "b.txt", "b\n", "only on feature")
	gitAuthored(t, dir, "checkout", "main")
	gitAuthored(t, dir, "merge", "--no-ff", "feature", "-m", "merge feature into main")
	return dir
}

func TestHistoryLogParentsAndOrder(t *testing.T) {
	dir := repoBranchMerge(t)
	h, err := HistoryLog(context.Background(), dir, HistoryOpts{})
	if err != nil {
		t.Fatalf("HistoryLog: %v", err)
	}
	if !h.IsRepo {
		t.Fatal("IsRepo = false, want true")
	}
	if len(h.Commits) != 4 {
		t.Fatalf("got %d commits, want 4", len(h.Commits))
	}
	tip := h.Commits[0]
	if tip.Subject != "merge feature into main" {
		t.Errorf("tip subject = %q, want the merge commit (newest first)", tip.Subject)
	}
	if len(tip.Parents) != 2 {
		t.Errorf("merge commit has %d parents, want 2", len(tip.Parents))
	}
	if tip.Author != "dana k" {
		t.Errorf("author = %q, want %q", tip.Author, "dana k")
	}
	if tip.Ts == 0 {
		t.Error("Ts = 0, want a UnixMilli author time")
	}
	root := h.Commits[len(h.Commits)-1]
	if len(root.Parents) != 0 {
		t.Errorf("root commit has %d parents, want 0", len(root.Parents))
	}
}

func TestHistoryLogDecoratesRefs(t *testing.T) {
	dir := repoBranchMerge(t)
	h, err := HistoryLog(context.Background(), dir, HistoryOpts{})
	if err != nil {
		t.Fatalf("HistoryLog: %v", err)
	}
	var tipRefs []string
	for _, c := range h.Commits {
		if c.Subject == "merge feature into main" {
			tipRefs = c.Refs
		}
	}
	joined := strings.Join(tipRefs, "|")
	if !strings.Contains(joined, "main") {
		t.Errorf("tip refs = %v, want one entry naming main", tipRefs)
	}
	// The frontend (historyrows.ts classifyRef) tells a remote branch from a slashed local branch by
	// the refs/ namespace, which only --decorate=full emits. Short form ("HEAD -> main") is
	// indistinguishable from a remote, so guard the full form here rather than downstream.
	if !strings.Contains(joined, "refs/heads/main") {
		t.Errorf("tip refs = %v, want the full refs/heads/main form (--decorate=full)", tipRefs)
	}
}

func TestHistoryLogPaginates(t *testing.T) {
	dir := repoBranchMerge(t)
	first, err := HistoryLog(context.Background(), dir, HistoryOpts{Limit: 2})
	if err != nil {
		t.Fatalf("HistoryLog: %v", err)
	}
	if len(first.Commits) != 2 {
		t.Fatalf("Limit=2 returned %d commits", len(first.Commits))
	}
	next, err := HistoryLog(context.Background(), dir, HistoryOpts{Limit: 2, Skip: 2})
	if err != nil {
		t.Fatalf("HistoryLog skip: %v", err)
	}
	if len(next.Commits) != 2 {
		t.Fatalf("Skip=2 returned %d commits", len(next.Commits))
	}
	if next.Commits[0].Hash == first.Commits[0].Hash {
		t.Error("Skip=2 returned the same page as Skip=0")
	}
}

func TestHistoryLogFiltersByAuthorAndPath(t *testing.T) {
	dir := repoBranchMerge(t)
	byAuthor, err := HistoryLog(context.Background(), dir, HistoryOpts{Author: "nobody@example.com"})
	if err != nil {
		t.Fatalf("HistoryLog author: %v", err)
	}
	if len(byAuthor.Commits) != 0 {
		t.Errorf("author filter matched %d commits, want 0", len(byAuthor.Commits))
	}
	byPath, err := HistoryLog(context.Background(), dir, HistoryOpts{Path: "b.txt"})
	if err != nil {
		t.Fatalf("HistoryLog path: %v", err)
	}
	if len(byPath.Commits) != 1 {
		t.Fatalf("path filter matched %d commits, want 1", len(byPath.Commits))
	}
	if byPath.Commits[0].Subject != "only on feature" {
		t.Errorf("path filter returned %q", byPath.Commits[0].Subject)
	}
}

func TestHistoryLogNotARepo(t *testing.T) {
	h, err := HistoryLog(context.Background(), t.TempDir(), HistoryOpts{})
	if err != nil {
		t.Fatalf("HistoryLog on non-repo returned error %v, want IsRepo=false", err)
	}
	if h.IsRepo {
		t.Error("IsRepo = true for a directory with no .git")
	}
}

// repoDiverged builds root -> shared, then main gains one commit and feature gains two, so the two
// branches have genuinely divergent commits and a merge base that is neither tip.
func repoDiverged(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	gitAuthored(t, dir, "init", "--initial-branch=main")
	commitAuthored(t, dir, "root.txt", "root.txt\n", "root commit")
	gitAuthored(t, dir, "checkout", "-b", "feature")
	commitAuthored(t, dir, "f1.txt", "f1.txt\n", "feature one")
	commitAuthored(t, dir, "f2.txt", "f2.txt\n", "feature two")
	gitAuthored(t, dir, "checkout", "main")
	commitAuthored(t, dir, "m1.txt", "m1.txt\n", "main one")
	return dir
}

func TestGetDivergenceSplitsBothSides(t *testing.T) {
	dir := repoDiverged(t)
	d, err := GetDivergence(context.Background(), dir, "main", "feature")
	if err != nil {
		t.Fatalf("GetDivergence: %v", err)
	}
	if !d.IsRepo {
		t.Fatal("IsRepo = false, want true")
	}
	if len(d.Ahead) != 2 {
		t.Errorf("Ahead has %d commits, want 2 (feature one, feature two)", len(d.Ahead))
	}
	if len(d.Behind) != 1 {
		t.Errorf("Behind has %d commits, want 1 (main one)", len(d.Behind))
	}
	if d.Ahead[0].Subject != "feature two" {
		t.Errorf("Ahead[0] = %q, want the newest feature commit", d.Ahead[0].Subject)
	}
	if d.Behind[0].Subject != "main one" {
		t.Errorf("Behind[0] = %q, want %q", d.Behind[0].Subject, "main one")
	}
	if d.Ahead[0].Author != "dana k" {
		t.Errorf("Ahead[0].Author = %q, want an author (this is why RangeLog was not reused)", d.Ahead[0].Author)
	}
}

func TestGetDivergenceReportsMergeBase(t *testing.T) {
	dir := repoDiverged(t)
	d, err := GetDivergence(context.Background(), dir, "main", "feature")
	if err != nil {
		t.Fatalf("GetDivergence: %v", err)
	}
	if d.MergeBase == "" {
		t.Fatal("MergeBase is empty")
	}
	root, err := HistoryLog(context.Background(), dir, HistoryOpts{Ref: "main"})
	if err != nil {
		t.Fatal(err)
	}
	want := root.Commits[len(root.Commits)-1].Hash
	if d.MergeBase != want {
		t.Errorf("MergeBase = %q, want the root commit %q", d.MergeBase, want)
	}
}

func TestGetDivergenceIdenticalRefs(t *testing.T) {
	dir := repoDiverged(t)
	d, err := GetDivergence(context.Background(), dir, "main", "main")
	if err != nil {
		t.Fatalf("GetDivergence: %v", err)
	}
	if len(d.Ahead) != 0 || len(d.Behind) != 0 {
		t.Errorf("comparing a ref to itself gave %d ahead / %d behind, want 0 / 0", len(d.Ahead), len(d.Behind))
	}
}

func TestGetDivergenceNotARepo(t *testing.T) {
	d, err := GetDivergence(context.Background(), t.TempDir(), "main", "feature")
	if err != nil {
		t.Fatalf("GetDivergence on non-repo returned error %v, want IsRepo=false", err)
	}
	if d.IsRepo {
		t.Error("IsRepo = true for a directory with no .git")
	}
}

// commitBySubject finds a commit hash in the repo's history by its subject line, so the tests below
// do not depend on --date-order tie-breaking between commits made in the same second.
func commitBySubject(t *testing.T, dir, subject string) string {
	t.Helper()
	h, err := HistoryLog(context.Background(), dir, HistoryOpts{})
	if err != nil {
		t.Fatalf("HistoryLog: %v", err)
	}
	for _, c := range h.Commits {
		if c.Subject == subject {
			return c.Hash
		}
	}
	t.Fatalf("no commit with subject %q in %d commits", subject, len(h.Commits))
	return ""
}

func TestCommitChangesIsolatesOneCommit(t *testing.T) {
	dir := repoBranchMerge(t)
	hash := commitBySubject(t, dir, "second on main")
	ch, err := CommitChanges(context.Background(), dir, hash)
	if err != nil {
		t.Fatalf("CommitChanges: %v", err)
	}
	if !ch.IsRepo {
		t.Fatal("IsRepo = false, want true")
	}
	// that commit added a.txt and nothing else — root.txt already existed, b.txt did not yet
	if !strings.Contains(ch.StatusZ, "a.txt") {
		t.Errorf("StatusZ = %q, want it to mention a.txt", ch.StatusZ)
	}
	if strings.Contains(ch.StatusZ, "root.txt") {
		t.Errorf("StatusZ = %q, want it NOT to mention root.txt", ch.StatusZ)
	}
	if !strings.Contains(ch.Numstat, "a.txt") {
		t.Errorf("Numstat = %q, want it to mention a.txt", ch.Numstat)
	}
}

func TestCommitChangesHandlesRootCommit(t *testing.T) {
	dir := repoBranchMerge(t)
	hash := commitBySubject(t, dir, "root commit")
	ch, err := CommitChanges(context.Background(), dir, hash)
	if err != nil {
		t.Fatalf("CommitChanges: %v", err)
	}
	// a root commit has no parent; every file in it reads as added against the empty tree
	if !strings.Contains(ch.StatusZ, "root.txt") {
		t.Errorf("StatusZ = %q, want it to mention root.txt", ch.StatusZ)
	}
	if !strings.Contains(ch.StatusZ, "A") {
		t.Errorf("StatusZ = %q, want an A status", ch.StatusZ)
	}
}

func TestCommitChangesOnMergeUsesFirstParent(t *testing.T) {
	dir := repoBranchMerge(t)
	hash := commitBySubject(t, dir, "merge feature into main")
	ch, err := CommitChanges(context.Background(), dir, hash)
	if err != nil {
		t.Fatalf("CommitChanges: %v", err)
	}
	// against its first parent (main's tip) the merge brings in exactly b.txt
	if !strings.Contains(ch.StatusZ, "b.txt") {
		t.Errorf("StatusZ = %q, want it to mention b.txt", ch.StatusZ)
	}
	if strings.Contains(ch.StatusZ, "a.txt") {
		t.Errorf("StatusZ = %q, want it NOT to mention a.txt", ch.StatusZ)
	}
}

func TestCommitDiffReturnsThatCommitsPatch(t *testing.T) {
	dir := repoBranchMerge(t)
	hash := commitBySubject(t, dir, "second on main")
	d, err := CommitDiff(context.Background(), dir, hash, "a.txt")
	if err != nil {
		t.Fatalf("CommitDiff: %v", err)
	}
	if !strings.Contains(d.Diff, "+a") {
		t.Errorf("Diff = %q, want it to contain the added line +a", d.Diff)
	}
	if d.Untracked {
		t.Error("Untracked = true, want false for a committed file")
	}
}

func TestCommitChangesNotARepo(t *testing.T) {
	ch, err := CommitChanges(context.Background(), t.TempDir(), "HEAD")
	if err != nil {
		t.Fatalf("CommitChanges: %v", err)
	}
	if ch.IsRepo {
		t.Error("IsRepo = true, want false outside a repository")
	}
}

// The three-dot anchor is the whole point of CompareChanges: main's own m1.txt must not appear.
// Under the two-dot form it would appear as a deletion, which is the regression this guards.
func TestCompareChangesUsesMergeBaseAnchor(t *testing.T) {
	dir := repoDiverged(t)
	ch, err := CompareChanges(context.Background(), dir, "main", "feature")
	if err != nil {
		t.Fatalf("CompareChanges: %v", err)
	}
	if !ch.IsRepo {
		t.Fatal("IsRepo = false, want true")
	}
	if strings.Contains(ch.StatusZ, "m1.txt") {
		t.Errorf("StatusZ mentions m1.txt (%q); three-dot must ignore the base side's own commits", ch.StatusZ)
	}
	for _, want := range []string{"f1.txt", "f2.txt"} {
		if !strings.Contains(ch.StatusZ, want) {
			t.Errorf("StatusZ missing %s: %q", want, ch.StatusZ)
		}
	}
	if !strings.Contains(ch.Numstat, "f1.txt") {
		t.Errorf("Numstat missing f1.txt: %q", ch.Numstat)
	}
}

func TestCompareChangesEmptyWhenRefsAgree(t *testing.T) {
	dir := repoDiverged(t)
	ch, err := CompareChanges(context.Background(), dir, "main", "main")
	if err != nil {
		t.Fatalf("CompareChanges: %v", err)
	}
	if !ch.IsRepo {
		t.Fatal("IsRepo = false, want true")
	}
	if strings.TrimSpace(ch.StatusZ) != "" || strings.TrimSpace(ch.Numstat) != "" {
		t.Errorf("want an empty change set, got statusz=%q numstat=%q", ch.StatusZ, ch.Numstat)
	}
}

func TestCompareChangesNotARepo(t *testing.T) {
	ch, err := CompareChanges(context.Background(), t.TempDir(), "main", "feature")
	if err != nil {
		t.Fatalf("CompareChanges on a non-repo should not error: %v", err)
	}
	if ch.IsRepo {
		t.Fatal("IsRepo = true for a non-repo dir")
	}
}

func TestCompareDiffOnePathBetweenRefs(t *testing.T) {
	dir := repoDiverged(t)
	d, err := CompareDiff(context.Background(), dir, "main", "feature", "f1.txt")
	if err != nil {
		t.Fatalf("CompareDiff: %v", err)
	}
	if !strings.Contains(d.Diff, "f1.txt") {
		t.Errorf("diff does not name f1.txt: %q", d.Diff)
	}
	if !strings.Contains(d.Diff, "+f1.txt") {
		t.Errorf("diff does not show f1.txt's added line: %q", d.Diff)
	}
	if d.Untracked {
		t.Error("Untracked = true; a two-ref diff has no working tree to have untracked files in")
	}
}

// An unresolvable ref must error rather than return an empty diff, so the surface can name the ref
// that failed instead of showing a blank pane that reads as "no differences".
func TestCompareDiffErrorsOnUnresolvableRef(t *testing.T) {
	dir := repoDiverged(t)
	if _, err := CompareDiff(context.Background(), dir, "main", "no-such-ref", "f1.txt"); err == nil {
		t.Fatal("expected an error for an unresolvable ref")
	}
}

func TestDefaultBranchFromOriginHead(t *testing.T) {
	dir := repoDiverged(t)
	// origin/HEAD is an ordinary symbolic ref under refs/remotes; writing it by hand needs no network.
	gitAuthored(t, dir, "update-ref", "refs/remotes/origin/trunk", "main")
	gitAuthored(t, dir, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk")
	got, err := DefaultBranch(context.Background(), dir)
	if err != nil {
		t.Fatalf("DefaultBranch: %v", err)
	}
	if got != "trunk" {
		t.Errorf("DefaultBranch = %q, want %q (the origin/ prefix stripped)", got, "trunk")
	}
}

func TestDefaultBranchProbesMain(t *testing.T) {
	dir := repoDiverged(t) // init -b main, no remote at all
	got, err := DefaultBranch(context.Background(), dir)
	if err != nil {
		t.Fatalf("DefaultBranch: %v", err)
	}
	if got != "main" {
		t.Errorf("DefaultBranch = %q, want %q", got, "main")
	}
}

func TestDefaultBranchProbesMaster(t *testing.T) {
	dir := t.TempDir()
	gitAuthored(t, dir, "init", "--initial-branch=master")
	commitAuthored(t, dir, "root.txt", "root.txt\n", "root commit")
	got, err := DefaultBranch(context.Background(), dir)
	if err != nil {
		t.Fatalf("DefaultBranch: %v", err)
	}
	if got != "master" {
		t.Errorf("DefaultBranch = %q, want %q", got, "master")
	}
}

// No origin/HEAD, no main, no master -> "" and no error, so the ref picker opens with an empty base
// field rather than surfacing an error the user cannot act on.
func TestDefaultBranchNoneResolve(t *testing.T) {
	dir := t.TempDir()
	gitAuthored(t, dir, "init", "--initial-branch=dev")
	commitAuthored(t, dir, "root.txt", "root.txt\n", "root commit")
	got, err := DefaultBranch(context.Background(), dir)
	if err != nil {
		t.Fatalf("DefaultBranch: %v", err)
	}
	if got != "" {
		t.Errorf("DefaultBranch = %q, want \"\"", got)
	}
}

func TestHistoryLogReportsFailureDetail(t *testing.T) {
	dir := repoBranchMerge(t)
	h, err := HistoryLog(context.Background(), dir, HistoryOpts{Ref: "no-such-ref-anywhere"})
	if err != nil {
		t.Fatalf("HistoryLog should describe a git failure, not return an error: %v", err)
	}
	if !h.IsRepo {
		t.Fatal("IsRepo = false, want true — the directory IS a repo; the read is what failed")
	}
	if h.Failure == nil {
		t.Fatal("Failure = nil, want the failing command described")
	}
	if h.Failure.ExitCode != 128 {
		t.Errorf("ExitCode = %d, want 128 (git's fatal-error code)", h.Failure.ExitCode)
	}
	if !strings.Contains(h.Failure.Command, "log") {
		t.Errorf("Command = %q, want it to name the log invocation", h.Failure.Command)
	}
	if !strings.Contains(h.Failure.Stderr, "no-such-ref-anywhere") {
		t.Errorf("Stderr = %q, want git's own message naming the bad revision", h.Failure.Stderr)
	}
}

// A freshly initialised repo has no commits, and git log exits 128 there. That is an empty history,
// not a failed read: reporting it as a failure would greet every new project with an error panel.
func TestHistoryLogEmptyRepoIsNotAFailure(t *testing.T) {
	dir := t.TempDir()
	gitAuthored(t, dir, "init", "--initial-branch=main")
	h, err := HistoryLog(context.Background(), dir, HistoryOpts{})
	if err != nil {
		t.Fatalf("HistoryLog: %v", err)
	}
	if !h.IsRepo {
		t.Error("IsRepo = false, want true for an initialised repo with no commits")
	}
	if h.Failure != nil {
		t.Errorf("Failure = %+v, want nil for an unborn branch", h.Failure)
	}
	if len(h.Commits) != 0 {
		t.Errorf("got %d commits, want 0", len(h.Commits))
	}
}

func TestHistoryLogHealthyReadHasNoFailure(t *testing.T) {
	dir := repoBranchMerge(t)
	h, err := HistoryLog(context.Background(), dir, HistoryOpts{})
	if err != nil {
		t.Fatalf("HistoryLog: %v", err)
	}
	if h.Failure != nil {
		t.Errorf("Failure = %+v, want nil — a working repo must not be able to trip the panel", h.Failure)
	}
}
