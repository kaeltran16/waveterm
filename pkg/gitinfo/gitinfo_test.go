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

func TestWorktreeBase(t *testing.T) {
	// a feature branch that has diverged from main -> base is the merge-base (the init commit)
	dir := t.TempDir()
	git(t, dir, "init", "-b", "main")
	writeFile(t, dir, "a.txt", "one\ntwo\n")
	git(t, dir, "add", ".")
	git(t, dir, "commit", "-m", "init")
	base, err := HeadCommit(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	git(t, dir, "checkout", "-b", "feat")
	writeFile(t, dir, "a.txt", "one\ntwo\nthree\n")
	git(t, dir, "add", ".")
	git(t, dir, "commit", "-m", "work")

	got, err := WorktreeBase(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	if got != base {
		t.Fatalf("WorktreeBase = %q, want merge-base %q", got, base)
	}
	// the resolved base surfaces the committed work that HEAD-mode misses (see the assertion below)
	ch, err := GetChanges(context.Background(), dir, got)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(ch.Numstat, "a.txt") {
		t.Fatalf("base-anchored numstat missing committed change: %q", ch.Numstat)
	}
	// HEAD-mode sees nothing (work is committed) — the bug base-anchoring fixes
	head, err := GetChanges(context.Background(), dir, "")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(head.Numstat, "a.txt") {
		t.Fatalf("HEAD-mode unexpectedly shows committed change: %q", head.Numstat)
	}
}

func TestWorktreeBaseDegrades(t *testing.T) {
	// on the default branch (no divergence) -> "" so the caller falls back to the live HEAD diff
	dir := repoWithChange(t) // on main: one commit + uncommitted edits
	got, err := WorktreeBase(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	if got != "" {
		t.Fatalf("WorktreeBase on default branch = %q, want empty", got)
	}
	// not a repo -> "" with no error
	got, err = WorktreeBase(context.Background(), t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if got != "" {
		t.Fatalf("WorktreeBase non-repo = %q, want empty", got)
	}
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
