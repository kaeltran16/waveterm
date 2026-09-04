# Diff Surface Comparison and Viewer Parity — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the Diff surface's branch comparison to JetBrains-like parity — a Monaco diff pane usable at the app's real window size, a merge-base/tip-to-tip toggle, remote refs with fetch, ref swapping, and a grouped file tree.

**Architecture:** The diff pane stops parsing unified-diff text and instead renders two full file texts in Monaco. A new `FileAtRef` backend reader supplies either side at any ref; a new pure module turns "what is selected" into "which two refs", so history, compare and working-tree all feed one pane. The history column becomes collapsible so the pane has room to be worth rendering.

**Tech Stack:** Go (`pkg/gitinfo`, `pkg/wshrpc`), React 19 + jotai + Tailwind 4, Monaco (already vendored and lazy-loaded), vitest, Go table tests, CDP scenarios.

**Spec:** `docs/superpowers/specs/2026-09-04-git-compare-viewer-parity-design.md` — read it first; every decision below argues from it.

## Global Constraints

- **Do not commit per task.** The repo's git rule is one batched commit at the end with explicit approval. Each task ends with tests passing, not with a commit. Task 13 holds the single commit step. Spec and plan docs fold into that same commit — never a docs-only commit.
- **Go tests:** `go test ./pkg/gitinfo/` works with no CGO setup — `gitinfo` does not import `jarvisembed`. Do not add the `CGO_CFLAGS` dance to these commands.
- **Frontend tests:** `npx vitest run <path>` from the repo root. Single test by name: `npx vitest run -t "<name>"`.
- **Typecheck:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`. Bare `npx tsc` stack-overflows on this repo. The baseline is clean, so any error it reports is yours.
- **Never hand-edit generated files.** `frontend/app/store/wshclientapi.ts` and `frontend/types/gotypes.d.ts` come from `task generate` after Go type changes.
- **Colors come from `@theme` tokens** in `frontend/tailwindsetup.css`. No raw hex or rgba in components — a hardcoded color silently opts out of every runtime theme.
- **Comments explain why, never what.** Lower case. Only where the reason is not obvious from the code.
- **No emojis anywhere**, including test names and commit text.
- **Do not run `prettier --write` on files you did not author** — it reorders imports and rewraps the whole file, turning a 4-line edit into a 600-line diff. Hand-format your own lines to match the surrounding file.
- The working tree already contains unrelated in-progress changes from other sessions. Stage only the files this plan names.

---

### Task 1: `FileAtRef` — read one file's content at a ref

**Files:**
- Modify: `pkg/gitinfo/gitinfo.go` (add after `CompareDiff`, around line 758)
- Test: `pkg/gitinfo/gitinfo_test.go` (append; **do not overwrite** — this file already holds ~30 tests and the Write tool replaces whole files)

**Interfaces:**
- Consumes: nothing.
- Produces: `gitinfo.FileAtRef(ctx, cwd, ref, path string, maxBytes int64) (*FileContent, error)` and `gitinfo.FileContent{Content string; Binary, Missing, TooLarge, IsRepo bool; Size int64}`.

- [ ] **Step 1: Write the failing tests**

Append to `pkg/gitinfo/gitinfo_test.go`. The existing helpers `git(t, dir, ...)` and `repoWithChange(t)` are at the top of that file — `repoWithChange` commits `a.txt` as `"one\ntwo\n"` and then dirties it on disk, which is what makes the first test meaningful (it must read the committed content, not the disk content).

```go
func TestFileAtRefReadsCommittedContent(t *testing.T) {
	dir := repoWithChange(t)
	got, err := FileAtRef(context.Background(), dir, "HEAD", "a.txt", 0)
	if err != nil {
		t.Fatal(err)
	}
	if !got.IsRepo || got.Missing || got.Binary || got.TooLarge {
		t.Fatalf("flags = %+v, want a plain text hit", got)
	}
	if got.Content != "one\ntwo\n" {
		t.Errorf("content = %q, want the committed text not the dirty worktree text", got.Content)
	}
}

// The regression this test exists for: paths from every other reader in this package are
// cwd-relative (--relative), and "<ref>:<path>" resolves from the repo root, so a bare path
// silently misses whenever the surface is scoped to a subdirectory.
func TestFileAtRefSubdir(t *testing.T) {
	dir := t.TempDir()
	git(t, dir, "init", "-b", "main")
	if err := os.MkdirAll(filepath.Join(dir, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "sub", "c.txt"), []byte("deep\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	git(t, dir, "add", ".")
	git(t, dir, "commit", "-m", "init")

	got, err := FileAtRef(context.Background(), filepath.Join(dir, "sub"), "HEAD", "c.txt", 0)
	if err != nil {
		t.Fatal(err)
	}
	if got.Content != "deep\n" {
		t.Errorf("content = %q, want %q", got.Content, "deep\n")
	}
}

func TestFileAtRefMissingIsNotAnError(t *testing.T) {
	dir := repoWithChange(t)
	got, err := FileAtRef(context.Background(), dir, "HEAD", "b.txt", 0)
	if err != nil {
		t.Fatalf("a blob absent at the ref must not error: %v", err)
	}
	if !got.Missing || got.Content != "" {
		t.Errorf("got %+v, want Missing with no content", got)
	}
}

func TestFileAtRefBinary(t *testing.T) {
	dir := t.TempDir()
	git(t, dir, "init", "-b", "main")
	if err := os.WriteFile(filepath.Join(dir, "bin.dat"), []byte{0x00, 0xff, 0xfe, 0x41}, 0o644); err != nil {
		t.Fatal(err)
	}
	git(t, dir, "add", ".")
	git(t, dir, "commit", "-m", "init")

	got, err := FileAtRef(context.Background(), dir, "HEAD", "bin.dat", 0)
	if err != nil {
		t.Fatal(err)
	}
	if !got.Binary || got.Content != "" {
		t.Errorf("got %+v, want Binary with no content", got)
	}
	if got.Size != 4 {
		t.Errorf("size = %d, want 4", got.Size)
	}
}

func TestFileAtRefTooLargeSkipsTheRead(t *testing.T) {
	dir := repoWithChange(t)
	got, err := FileAtRef(context.Background(), dir, "HEAD", "a.txt", 4)
	if err != nil {
		t.Fatal(err)
	}
	if !got.TooLarge || got.Content != "" {
		t.Errorf("got %+v, want TooLarge with no content", got)
	}
	if got.Size != 8 {
		t.Errorf("size = %d, want the real size 8 so the message can name it", got.Size)
	}
}

func TestFileAtRefNotARepo(t *testing.T) {
	got, err := FileAtRef(context.Background(), t.TempDir(), "HEAD", "a.txt", 0)
	if err != nil {
		t.Fatal(err)
	}
	if got.IsRepo {
		t.Errorf("got %+v, want IsRepo false", got)
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go test ./pkg/gitinfo/ -run TestFileAtRef -v`
Expected: build failure — `undefined: FileAtRef`.

- [ ] **Step 3: Implement `FileAtRef`**

Add `"unicode/utf8"` to the import block at `pkg/gitinfo/gitinfo.go:10`. `strconv`, `strings`, `fmt` and `context` are already imported. Insert after `CompareDiff` (ends around line 758):

```go
// FileContent is one file's content at one ref, in the shape the diff pane consumes. Binary,
// Missing and TooLarge are states the pane draws rather than errors, because each is a normal
// thing to find on one side of a diff: a blob that is not text, a file added on the other side,
// a file too big to be worth mounting an editor on.
type FileContent struct {
	Content  string `json:"content"`
	Binary   bool   `json:"binary"`
	Missing  bool   `json:"missing"`
	TooLarge bool   `json:"toolarge"`
	Size     int64  `json:"size"`
	IsRepo   bool   `json:"isrepo"`
}

// FileAtRef returns one file's full content at a ref, for the two sides of the diff pane. The path
// is cwd-relative like every other reader here, so the rev spec uses the "./" form: `<ref>:./<path>`
// resolves relative to cwd, while `<ref>:<path>` resolves from the repo root and silently misses in
// a subdirectory checkout. maxBytes caps the transport (0 = no cap) and the size is read from the
// blob header first, so an oversized file is refused without ever being read.
func FileAtRef(ctx context.Context, cwd, ref, path string, maxBytes int64) (*FileContent, error) {
	ctx, cancel := context.WithTimeout(ctx, gitTimeout)
	defer cancel()
	inside, err := run(ctx, cwd, "rev-parse", "--is-inside-work-tree")
	if err != nil || strings.TrimSpace(inside) != "true" {
		return &FileContent{IsRepo: false}, nil
	}
	spec := ref + ":./" + path
	sizeOut, err := run(ctx, cwd, "cat-file", "-s", spec)
	if err != nil {
		// the blob does not exist at this ref: an add on one side, a delete on the other
		return &FileContent{IsRepo: true, Missing: true}, nil
	}
	size, err := strconv.ParseInt(strings.TrimSpace(sizeOut), 10, 64)
	if err != nil {
		return nil, fmt.Errorf("git cat-file -s %s: unparsable size %q", spec, strings.TrimSpace(sizeOut))
	}
	if maxBytes > 0 && size > maxBytes {
		return &FileContent{IsRepo: true, TooLarge: true, Size: size}, nil
	}
	out, err := run(ctx, cwd, "show", spec)
	if err != nil {
		return nil, err
	}
	if !utf8.ValidString(out) {
		return &FileContent{IsRepo: true, Binary: true, Size: size}, nil
	}
	return &FileContent{IsRepo: true, Content: out, Size: size}, nil
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `go test ./pkg/gitinfo/ -run TestFileAtRef -v`
Expected: all six PASS.

- [ ] **Step 5: Run the whole package to check nothing regressed**

Run: `go test ./pkg/gitinfo/`
Expected: ok.

---

### Task 2: Remote-tracking refs in `ListBranches`, remote-first `DefaultBranch`

**Files:**
- Modify: `pkg/gitinfo/gitinfo.go:336-366` (`BranchInfo`, `ListBranches`) and `:763` (`DefaultBranch`)
- Test: `pkg/gitinfo/gitinfo_test.go` (append)

**Interfaces:**
- Consumes: nothing.
- Produces: `gitinfo.BranchInfo{Name, Age string; Remote bool}`; `ListBranches(ctx, repoPath string, includeRemotes bool) ([]BranchInfo, error)` — **signature change, one existing caller**; `DefaultBranch` unchanged in signature, changed in behaviour.

- [ ] **Step 1: Write the failing tests**

A real remote is not needed — `refs/remotes` can be written directly, which is also faster and hermetic.

```go
func repoWithRemote(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	git(t, dir, "init", "-b", "main")
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("one\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	git(t, dir, "add", ".")
	git(t, dir, "commit", "-m", "init")
	// a remote-tracking ref without a remote: enough for ref listing, and hermetic
	git(t, dir, "update-ref", "refs/remotes/origin/main", "HEAD")
	git(t, dir, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main")
	return dir
}

func TestListBranchesLocalOnlyByDefault(t *testing.T) {
	dir := repoWithRemote(t)
	got, err := ListBranches(context.Background(), dir, false)
	if err != nil {
		t.Fatal(err)
	}
	for _, b := range got {
		if b.Remote {
			t.Fatalf("got remote branch %q with includeRemotes=false", b.Name)
		}
	}
	if len(got) != 1 || got[0].Name != "main" {
		t.Errorf("got %+v, want just local main", got)
	}
}

func TestListBranchesIncludesRemotesAndSkipsOriginHead(t *testing.T) {
	dir := repoWithRemote(t)
	got, err := ListBranches(context.Background(), dir, true)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	remote := map[string]bool{}
	for _, b := range got {
		names = append(names, b.Name)
		remote[b.Name] = b.Remote
	}
	if len(names) != 2 {
		t.Fatalf("got %v, want local main and origin/main only", names)
	}
	if !remote["origin/main"] {
		t.Errorf("origin/main not tagged Remote: %+v", got)
	}
	if remote["main"] {
		t.Errorf("local main tagged Remote: %+v", got)
	}
	for _, n := range names {
		if n == "origin/HEAD" {
			t.Error("origin/HEAD is a symbolic ref, not a comparison target — it must be filtered")
		}
	}
}

func TestDefaultBranchPrefersRemote(t *testing.T) {
	dir := repoWithRemote(t)
	got, err := DefaultBranch(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	if got != "origin/main" {
		t.Errorf("got %q, want origin/main — the picker can show remotes now", got)
	}
}

func TestDefaultBranchFallsBackToLocal(t *testing.T) {
	dir := t.TempDir()
	git(t, dir, "init", "-b", "main")
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("one\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	git(t, dir, "add", ".")
	git(t, dir, "commit", "-m", "init")

	got, err := DefaultBranch(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	if got != "main" {
		t.Errorf("got %q, want main", got)
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go test ./pkg/gitinfo/ -run "TestListBranches|TestDefaultBranch" -v`
Expected: build failure — too many arguments to `ListBranches`.

- [ ] **Step 3: Implement the reader changes**

Replace `BranchInfo` and `ListBranches` (`gitinfo.go:336-366`):

```go
type BranchInfo struct {
	Name   string
	Age    string // relative committer date, e.g. "2 hours ago"
	Remote bool
}

// ListBranches returns the branches of the repo at repoPath, most-recently-committed first.
// includeRemotes adds refs/remotes, which the compare ref picker wants and the New Agent launcher
// does not: a worktree cannot be created on a remote-tracking ref. origin/HEAD is filtered because
// it is a symbolic alias, not a branch anyone compares against. Returns an empty slice (no error)
// when repoPath is not a git repository, so the caller can degrade to free-text input.
func ListBranches(ctx context.Context, repoPath string, includeRemotes bool) ([]BranchInfo, error) {
	ctx, cancel := context.WithTimeout(ctx, gitTimeout)
	defer cancel()
	inside, err := run(ctx, repoPath, "rev-parse", "--is-inside-work-tree")
	if err != nil || strings.TrimSpace(inside) != "true" {
		return nil, nil
	}
	args := []string{"for-each-ref", "--sort=-committerdate",
		"--format=%(refname:short)\t%(committerdate:relative)\t%(refname)", "refs/heads"}
	if includeRemotes {
		args = append(args, "refs/remotes")
	}
	out, err := run(ctx, repoPath, args...)
	if err != nil {
		return nil, err
	}
	var branches []BranchInfo
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimRight(line, "\r")
		if strings.TrimSpace(line) == "" {
			continue
		}
		fields := strings.Split(line, "\t")
		if len(fields) < 3 {
			continue
		}
		name, age, full := fields[0], fields[1], fields[2]
		if strings.HasSuffix(full, "/HEAD") {
			continue
		}
		branches = append(branches, BranchInfo{
			Name:   name,
			Age:    age,
			Remote: strings.HasPrefix(full, "refs/remotes/"),
		})
	}
	return branches, nil
}
```

Then replace the body of `DefaultBranch` (`gitinfo.go:763`), and **rewrite its doc comment** — the existing one explains why it returns a local-only name, which is the constraint this task removes:

```go
// DefaultBranch resolves the repo's default branch as the ref the compare picker should open on:
// origin/<name> when the remote publishes origin/HEAD, else a probe of local main then master.
// Returns "" (not an error) when none resolve, so the base field just opens empty.
//
// Remote-first is deliberate: the picker lists refs/remotes now, so a remote-tracking ref is
// offerable, and comparing against origin/main rather than a possibly-stale local main is what
// makes the default answer the review question correctly.
func DefaultBranch(ctx context.Context, cwd string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, gitTimeout)
	defer cancel()
	if out, err := run(ctx, cwd, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"); err == nil {
		if name := strings.TrimSpace(out); name != "" {
			return name, nil
		}
	}
	for _, probe := range []string{"main", "master"} {
		if _, err := run(ctx, cwd, "rev-parse", "--verify", "--quiet", probe); err == nil {
			return probe, nil
		}
	}
	return "", nil
}
```

- [ ] **Step 4: Fix the one existing caller**

`pkg/wshrpc/wshserver/wshserver_projects.go:69` calls `gitinfo.ListBranches(ctx, data.ProjectPath)`. Change it to pass the new flag from request data (the RPC field itself lands in Task 5):

```go
	branches, err := gitinfo.ListBranches(ctx, data.ProjectPath, data.IncludeRemotes)
```

This will not compile until Task 5 adds `IncludeRemotes`. To keep this task independently green, add the field to `CommandListBranchesData` now, in `pkg/wshrpc/wshrpctypes_projects.go:36`:

```go
type CommandListBranchesData struct {
	ProjectPath string `json:"projectpath"`
	// The compare ref picker wants remote-tracking refs; the New Agent launcher must not offer
	// them, because a worktree cannot be created on one. Default false keeps that caller correct
	// without it having to know this field exists.
	IncludeRemotes bool `json:"includeremotes,omitempty"`
}
```

And carry `Remote` through the response mapping at `wshserver_projects.go:75`:

```go
		rtn.Branches = append(rtn.Branches, wshrpc.BranchInfo{Name: b.Name, Age: b.Age, Remote: b.Remote})
```

with `wshrpc.BranchInfo` gaining the field (find it with `grep -n "type BranchInfo" pkg/wshrpc/*.go`):

```go
	Remote bool `json:"remote,omitempty"`
```

- [ ] **Step 5: Run the tests**

Run: `go test ./pkg/gitinfo/ && go build ./pkg/...`
Expected: gitinfo ok, build clean.

---

### Task 3: `Fetch`

**Files:**
- Modify: `pkg/gitinfo/gitinfo.go` (add after `DefaultBranch`)
- Test: `pkg/gitinfo/gitinfo_test.go` (append)

**Interfaces:**
- Consumes: `GitFailure`, `failureOf` (both exist, `gitinfo.go:783` and `:803`).
- Produces: `gitinfo.Fetch(ctx, cwd, remote string) (*FetchResult, error)`, `gitinfo.FetchResult{FetchedAt int64; Failure *GitFailure; IsRepo bool}`.

- [ ] **Step 1: Write the failing test**

Fetching from a real remote is not hermetic. What is worth testing is the failure shape — that a fetch against a nonexistent remote surfaces git's own words instead of a bare error.

```go
func TestFetchFailureCarriesStderr(t *testing.T) {
	dir := repoWithChange(t)
	git(t, dir, "add", ".")
	git(t, dir, "commit", "-m", "second")

	got, err := Fetch(context.Background(), dir, "nosuchremote")
	if err != nil {
		t.Fatalf("a git failure belongs in the result, not the error: %v", err)
	}
	if got.Failure == nil {
		t.Fatal("want a Failure describing the fetch that did not run")
	}
	if got.Failure.Stderr == "" {
		t.Error("want git's stderr verbatim so the panel can name the cause")
	}
	if !strings.Contains(got.Failure.Command, "fetch") {
		t.Errorf("command = %q, want the fetch invocation", got.Failure.Command)
	}
}

func TestFetchNotARepo(t *testing.T) {
	got, err := Fetch(context.Background(), t.TempDir(), "origin")
	if err != nil {
		t.Fatal(err)
	}
	if got.IsRepo {
		t.Errorf("got %+v, want IsRepo false", got)
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `go test ./pkg/gitinfo/ -run TestFetch -v`
Expected: build failure — `undefined: Fetch`.

- [ ] **Step 3: Implement `Fetch`**

`fetchTimeout` is separate from `gitTimeout` because 10s is a normal duration for a fetch, not a failure:

```go
// A fetch talks to the network, so it gets its own budget: gitTimeout (10s) is a normal duration
// for one, not a symptom. The client raises its RPC timeout to match.
const fetchTimeout = 55 * time.Second

// FetchResult reports whether remote-tracking refs were updated. A git failure is data, not an
// error: a missing remote or a credential prompt is something the surface renders through the
// shipped GitFailure panel, with git's own stderr in it.
type FetchResult struct {
	FetchedAt int64       `json:"fetchedat"` // unix seconds, for the freshness clock
	Failure   *GitFailure `json:"failure,omitempty"`
	IsRepo    bool        `json:"isrepo"`
}

// Fetch updates remote-tracking refs. Never touches the working tree or any local branch, which is
// what keeps the Diff surface read-only from the repository's point of view.
func Fetch(ctx context.Context, cwd, remote string) (*FetchResult, error) {
	ctx, cancel := context.WithTimeout(ctx, fetchTimeout)
	defer cancel()
	inside, err := run(ctx, cwd, "rev-parse", "--is-inside-work-tree")
	if err != nil || strings.TrimSpace(inside) != "true" {
		return &FetchResult{IsRepo: false}, nil
	}
	if remote == "" {
		remote = "origin"
	}
	args := []string{"fetch", "--prune", remote}
	if _, err := runErr(ctx, cwd, args...); err != nil {
		return &FetchResult{IsRepo: true, Failure: failureOf(args, err)}, nil
	}
	return &FetchResult{IsRepo: true, FetchedAt: time.Now().Unix()}, nil
}
```

Check `failureOf`'s signature at `gitinfo.go:803` before writing this — it takes the args slice and the error. If its stderr comes from a `*exec.ExitError` rather than from `runErr`'s wrapped message, adapt the call so `Stderr` is populated; the test asserts it is non-empty and will tell you.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `go test ./pkg/gitinfo/ -run TestFetch -v`
Expected: both PASS.

- [ ] **Step 5: Run the whole package**

Run: `go test ./pkg/gitinfo/`
Expected: ok.

---

### Task 4: Two-dot form for the compare readers

**Files:**
- Modify: `pkg/gitinfo/gitinfo.go:717-758` (`CompareChanges`, `CompareDiff`)
- Test: `pkg/gitinfo/gitinfo_test.go` (append)

**Interfaces:**
- Consumes: nothing.
- Produces: `CompareChanges(ctx, cwd, base, head string, tips bool)`, `CompareDiff(ctx, cwd, base, head, path string, tips bool)`. `tips=false` keeps today's three-dot behaviour.

- [ ] **Step 1: Write the failing test**

The distinction only shows up when both sides have unique commits: three-dot hides base's own changes, two-dot shows them inverted.

```go
func TestCompareChangesTipsIncludesBaseSideChanges(t *testing.T) {
	dir := t.TempDir()
	git(t, dir, "init", "-b", "main")
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("one\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	git(t, dir, "add", ".")
	git(t, dir, "commit", "-m", "init")

	git(t, dir, "checkout", "-b", "feature")
	if err := os.WriteFile(filepath.Join(dir, "feat.txt"), []byte("f\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	git(t, dir, "add", ".")
	git(t, dir, "commit", "-m", "feature work")

	git(t, dir, "checkout", "main")
	if err := os.WriteFile(filepath.Join(dir, "onmain.txt"), []byte("m\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	git(t, dir, "add", ".")
	git(t, dir, "commit", "-m", "main moved on")

	mergeBase, err := CompareChanges(context.Background(), dir, "main", "feature", false)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(mergeBase.StatusZ, "onmain.txt") {
		t.Error("three-dot must not include the base side's own commits")
	}
	if !strings.Contains(mergeBase.StatusZ, "feat.txt") {
		t.Error("three-dot must include what head introduced")
	}

	tips, err := CompareChanges(context.Background(), dir, "main", "feature", true)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(tips.StatusZ, "onmain.txt") {
		t.Error("two-dot must include the base side's changes — that is the whole point of it")
	}
	if !strings.Contains(tips.StatusZ, "feat.txt") {
		t.Error("two-dot must still include head's changes")
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `go test ./pkg/gitinfo/ -run TestCompareChangesTips -v`
Expected: build failure — too many arguments.

- [ ] **Step 3: Implement the form parameter**

In `CompareChanges` (`gitinfo.go:723`) and `CompareDiff` (`:745`), take `tips bool` as the last parameter and pick the separator. Keep the existing doc comments and add the second form's rationale:

```go
// ... existing three-dot rationale stays ...
// tips selects the two-dot form instead: the full difference between the two tips, base's own
// commits included as reverse changes. It answers "has base moved under me", which the merge-base
// form cannot, and it deliberately does not correspond to either commit column — the pane header
// names the active form so the two can never be confused.
func CompareChanges(ctx context.Context, cwd, base, head string, tips bool) (*Changes, error) {
	// ...
	spec := base + rangeSep(tips) + head
	// ... unchanged below
}

// rangeSep picks the range form. Two dots is the full tip-to-tip difference; three dots is anchored
// at the merge base.
func rangeSep(tips bool) string {
	if tips {
		return ".."
	}
	return "..."
}
```

Apply the same substitution in `CompareDiff`, whose spec is built at `gitinfo.go:752` as `base+"..."+head`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `go test ./pkg/gitinfo/ -run TestCompare -v`
Expected: PASS, including the pre-existing compare tests.

- [ ] **Step 5: Run the whole package**

Run: `go test ./pkg/gitinfo/`
Expected: ok.

---

### Task 5: RPC surface and codegen

**Files:**
- Modify: `pkg/wshrpc/wshrpctypes_git.go` (interface + data types)
- Modify: `pkg/wshrpc/wshserver/wshserver_git.go` (handlers)
- Regenerate: `frontend/app/store/wshclientapi.ts`, `frontend/types/gotypes.d.ts` (never by hand)

**Interfaces:**
- Consumes: `gitinfo.FileAtRef`, `gitinfo.Fetch`, the new `tips` parameters (Tasks 1, 3, 4).
- Produces: `RpcApi.GitFileAtRefCommand({cwd, ref, path, maxbytes})`, `RpcApi.GitFetchCommand({cwd, remote})`, and `form?: string` on the two compare commands.

- [ ] **Step 1: Add the interface methods and data types**

In `pkg/wshrpc/wshrpctypes_git.go`, add to the `GitCommands` interface:

```go
	GitFileAtRefCommand(ctx context.Context, data CommandGitFileAtRefData) (*CommandGitFileAtRefRtnData, error)
	GitFetchCommand(ctx context.Context, data CommandGitFetchData) (*CommandGitFetchRtnData, error)
```

And the types, following the file's existing shape:

```go
type CommandGitFileAtRefData struct {
	Cwd  string `json:"cwd"`
	Ref  string `json:"ref"`
	Path string `json:"path"`
	// 0 = no cap. The frontend sets it so an oversized blob is refused server-side rather than
	// transported and then discarded by the pane.
	MaxBytes int64 `json:"maxbytes,omitempty"`
}

type CommandGitFileAtRefRtnData struct {
	Content  string `json:"content"`
	Binary   bool   `json:"binary"`
	Missing  bool   `json:"missing"`
	TooLarge bool   `json:"toolarge"`
	Size     int64  `json:"size"`
	IsRepo   bool   `json:"isrepo"`
}

type CommandGitFetchData struct {
	Cwd string `json:"cwd"`
	// "" defaults to origin.
	Remote string `json:"remote,omitempty"`
}

type CommandGitFetchRtnData struct {
	FetchedAt int64               `json:"fetchedat"`
	Failure   *gitinfo.GitFailure `json:"failure,omitempty"`
	IsRepo    bool                `json:"isrepo"`
}
```

Add `Form` to both compare request types:

```go
type CommandGitCompareChangesData struct {
	Cwd  string `json:"cwd"`
	Base string `json:"base"`
	Head string `json:"head"`
	// "tips" selects the two-dot form; anything else (including "") is the merge-base default.
	Form string `json:"form,omitempty"`
}
```

and the identical field on `CommandGitCompareDiffData`.

- [ ] **Step 2: Implement the handlers**

In `pkg/wshrpc/wshserver/wshserver_git.go`, beside the existing ones:

```go
func (ws *WshServer) GitFileAtRefCommand(ctx context.Context, data wshrpc.CommandGitFileAtRefData) (*wshrpc.CommandGitFileAtRefRtnData, error) {
	fc, err := gitinfo.FileAtRef(ctx, data.Cwd, data.Ref, data.Path, data.MaxBytes)
	if err != nil {
		return nil, err
	}
	return &wshrpc.CommandGitFileAtRefRtnData{
		Content: fc.Content, Binary: fc.Binary, Missing: fc.Missing,
		TooLarge: fc.TooLarge, Size: fc.Size, IsRepo: fc.IsRepo,
	}, nil
}

func (ws *WshServer) GitFetchCommand(ctx context.Context, data wshrpc.CommandGitFetchData) (*wshrpc.CommandGitFetchRtnData, error) {
	r, err := gitinfo.Fetch(ctx, data.Cwd, data.Remote)
	if err != nil {
		return nil, err
	}
	return &wshrpc.CommandGitFetchRtnData{FetchedAt: r.FetchedAt, Failure: r.Failure, IsRepo: r.IsRepo}, nil
}
```

And thread the form through the two existing compare handlers:

```go
	ch, err := gitinfo.CompareChanges(ctx, data.Cwd, data.Base, data.Head, data.Form == "tips")
```
```go
	d, err := gitinfo.CompareDiff(ctx, data.Cwd, data.Base, data.Head, data.Path, data.Form == "tips")
```

- [ ] **Step 3: Build the backend**

Run: `go build ./pkg/... ./cmd/...`
Expected: clean. If `wshserver` fails on the `sqlite3.h` include, that is the known CGO gotcha — set `CGO_CFLAGS` per CLAUDE.md and retry.

- [ ] **Step 4: Regenerate the bindings**

Run: `task generate`
Expected: `frontend/app/store/wshclientapi.ts` gains `GitFileAtRefCommand` and `GitFetchCommand`; `frontend/types/gotypes.d.ts` gains the four new types plus the `form` / `includeremotes` / `remote` fields. Verify with:

Run: `git diff --stat frontend/app/store/wshclientapi.ts frontend/types/gotypes.d.ts`
Expected: both files changed, no other generated file touched.

- [ ] **Step 5: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0. `comparestore.ts` still compiles because `form` is optional.

---

### Task 6: `diffcontent.ts` — which two refs, and where the first change is

**Files:**
- Create: `frontend/app/view/agents/diffcontent.ts`
- Test: `frontend/app/view/agents/diffcontent.test.ts`

**Interfaces:**
- Consumes: `DiffRange` from `diffscope.ts`.
- Produces: `DiffSelection`, `DiffSide`, `pairRefsFor(sel: DiffSelection): { original: DiffSide; modified: DiffSide }`, `firstDifferingLine(original: string, modified: string): number`.

- [ ] **Step 1: Write the failing tests**

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { firstDifferingLine, pairRefsFor } from "./diffcontent";

describe("pairRefsFor", () => {
    it("diffs the working tree against its anchor, reading the modified side from disk", () => {
        expect(pairRefsFor({ kind: "worktree", anchorRef: "abc1234" })).toEqual({
            original: { kind: "ref", ref: "abc1234" },
            modified: { kind: "worktree" },
        });
    });

    it("falls back to HEAD when the working-tree range has no anchor", () => {
        expect(pairRefsFor({ kind: "worktree", anchorRef: "" }).original).toEqual({ kind: "ref", ref: "HEAD" });
    });

    // a commit's own change is measured against its first parent, which is what the caret means and
    // what the backend's commitBase already does for the change list
    it("diffs a commit against its first parent", () => {
        expect(pairRefsFor({ kind: "commit", hash: "deadbee" })).toEqual({
            original: { kind: "ref", ref: "deadbee^" },
            modified: { kind: "ref", ref: "deadbee" },
        });
    });

    it("anchors a merge-base comparison at the merge base, not at base", () => {
        expect(
            pairRefsFor({ kind: "compare", base: "main", head: "feature", mergeBase: "m1m1m1m", form: "mergebase" })
        ).toEqual({
            original: { kind: "ref", ref: "m1m1m1m" },
            modified: { kind: "ref", ref: "feature" },
        });
    });

    it("uses base itself for a tip-to-tip comparison", () => {
        expect(
            pairRefsFor({ kind: "compare", base: "main", head: "feature", mergeBase: "m1m1m1m", form: "tips" })
        ).toEqual({
            original: { kind: "ref", ref: "main" },
            modified: { kind: "ref", ref: "feature" },
        });
    });

    // the divergence read can be in flight when a file is clicked; base is the honest fallback
    it("falls back to base when the merge base is not known yet", () => {
        expect(
            pairRefsFor({ kind: "compare", base: "main", head: "feature", mergeBase: "", form: "mergebase" }).original
        ).toEqual({ kind: "ref", ref: "main" });
    });
});

describe("firstDifferingLine", () => {
    it("returns the first line that differs, 1-based", () => {
        expect(firstDifferingLine("a\nb\nc\n", "a\nb\nZ\n")).toBe(3);
    });

    it("returns 1 for identical content, so a jump target always exists", () => {
        expect(firstDifferingLine("a\nb\n", "a\nb\n")).toBe(1);
    });

    it("points at the first added line when one side is longer", () => {
        expect(firstDifferingLine("a\n", "a\nb\n")).toBe(2);
    });

    it("points at line 1 when the original side is empty (a new file)", () => {
        expect(firstDifferingLine("", "hello\n")).toBe(1);
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run frontend/app/view/agents/diffcontent.test.ts`
Expected: FAIL — cannot resolve `./diffcontent`.

- [ ] **Step 3: Implement the module**

```ts
// frontend/app/view/agents/diffcontent.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pure: what the diff pane is showing -> which two things to read. The pane renders two full file
// texts rather than a parsed patch, so every state the surface has must answer one question the
// same way: which ref is the left side, which is the right. Keeping that here is what lets history,
// comparison and the working tree share one pane and one loader.

export type CompareForm = "mergebase" | "tips";

export type DiffSelection =
    | { kind: "worktree"; anchorRef: string }
    | { kind: "commit"; hash: string }
    | { kind: "compare"; base: string; head: string; mergeBase: string; form: CompareForm };

// The right side of the working-tree diff is the file on disk, which is not a ref at all.
export type DiffSide = { kind: "ref"; ref: string } | { kind: "worktree" };

export interface DiffPairRefs {
    original: DiffSide;
    modified: DiffSide;
}

export function pairRefsFor(sel: DiffSelection): DiffPairRefs {
    switch (sel.kind) {
        case "worktree":
            return { original: { kind: "ref", ref: sel.anchorRef || "HEAD" }, modified: { kind: "worktree" } };
        // "^" is the first parent, matching gitinfo.commitBase: for a merge that is the conventional
        // "what did this bring in", and for a root commit it simply misses, which the pane renders as
        // an addition — correct, since a root commit adds everything.
        case "commit":
            return { original: { kind: "ref", ref: `${sel.hash}^` }, modified: { kind: "ref", ref: sel.hash } };
        case "compare":
            return {
                original: {
                    kind: "ref",
                    ref: sel.form === "tips" ? sel.base : sel.mergeBase || sel.base,
                },
                modified: { kind: "ref", ref: sel.head },
            };
    }
}

// Where "Open in Code" should land. Not a diff — the first line at which the two texts stop
// agreeing, which is the same answer for every case the pane can show and costs one scan.
export function firstDifferingLine(original: string, modified: string): number {
    const a = original.split("\n");
    const b = modified.split("\n");
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
        if (a[i] !== b[i]) {
            return i + 1;
        }
    }
    return a.length === b.length ? 1 : n + 1;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run frontend/app/view/agents/diffcontent.test.ts`
Expected: 9 passing.

---

### Task 7: `diffcontentstore.ts` — load both sides

**Files:**
- Create: `frontend/app/view/agents/diffcontentstore.ts`

**Interfaces:**
- Consumes: `pairRefsFor`, `DiffSelection`, `DiffSide` (Task 6); `RpcApi.GitFileAtRefCommand`, `RpcApi.FileReadCommand` (Task 5 / existing).
- Produces: `diffPairAtom` (`PrimitiveAtom<DiffPair | null>`), `loadDiffPair(cwd, path, sel)`, `clearDiffPair()`, `MAX_DIFF_BYTES`. `DiffPair = { path; original; modified; binary; tooLarge; size }`.

Per repo convention, thin RPC glue gets no test of its own — the derivation it depends on is tested in Task 6.

- [ ] **Step 1: Write the module**

```ts
// frontend/app/view/agents/diffcontentstore.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The diff pane's content: two full file texts, loaded from whichever pair of refs the current
// selection names. Module-level like every other store on this surface, because the surface
// unmounts on a nav switch. One loader for all three states — the selection decides the refs
// (diffcontent.ts) and nothing here knows which state it is serving.

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { joinRepoPath } from "@/util/paths";
import { base64ToString } from "@/util/util";
import { atom, type PrimitiveAtom } from "jotai";
import { pairRefsFor, type DiffSelection, type DiffSide } from "./diffcontent";

// Monaco is comfortable well past this; the cap exists so one accidental click on a vendored bundle
// or a lockfile does not freeze the surface. Measured against this repo's largest tracked files.
export const MAX_DIFF_BYTES = 2 * 1024 * 1024;

export interface DiffPair {
    path: string;
    original: string;
    modified: string;
    // set when either side is a blob git has no text for
    binary: boolean;
    // set when either side exceeds MAX_DIFF_BYTES; size is the larger side, for the message
    tooLarge: boolean;
    size: number;
}

export const diffPairAtom = atom<DiffPair | null>(null) as PrimitiveAtom<DiffPair | null>;

const current = { token: "" };

export function clearDiffPair(): void {
    current.token = "";
    globalStore.set(diffPairAtom, null);
}

interface SideResult {
    text: string;
    binary: boolean;
    tooLarge: boolean;
    size: number;
}

const EMPTY_SIDE: SideResult = { text: "", binary: false, tooLarge: false, size: 0 };

async function readSide(cwd: string, path: string, side: DiffSide): Promise<SideResult> {
    if (side.kind === "worktree") {
        try {
            const data = await RpcApi.FileReadCommand(TabRpcClient, { info: { path: joinRepoPath(cwd, path) } });
            return { ...EMPTY_SIDE, text: base64ToString(data?.data64 ?? "") };
        } catch {
            // deleted from the working tree: an empty right side is exactly how that reads
            return EMPTY_SIDE;
        }
    }
    const r = await RpcApi.GitFileAtRefCommand(TabRpcClient, {
        cwd,
        ref: side.ref,
        path,
        maxbytes: MAX_DIFF_BYTES,
    });
    // missing is not a failure: the file was added on one side or deleted on the other
    return { text: r.content ?? "", binary: !!r.binary, tooLarge: !!r.toolarge, size: r.size ?? 0 };
}

export async function loadDiffPair(cwd: string, path: string, sel: DiffSelection): Promise<void> {
    const refs = pairRefsFor(sel);
    const token = `${cwd}|${path}|${JSON.stringify(refs)}`;
    current.token = token;
    globalStore.set(diffPairAtom, null);
    try {
        const [original, modified] = await Promise.all([
            readSide(cwd, path, refs.original),
            readSide(cwd, path, refs.modified),
        ]);
        if (current.token !== token) {
            return; // selection moved on
        }
        globalStore.set(diffPairAtom, {
            path,
            original: original.text,
            modified: modified.text,
            binary: original.binary || modified.binary,
            tooLarge: original.tooLarge || modified.tooLarge,
            size: Math.max(original.size, modified.size),
        });
    } catch {
        if (current.token === token) {
            globalStore.set(diffPairAtom, null);
        }
    }
}
```

- [ ] **Step 2: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0. If `joinRepoPath` or `base64ToString` resolve differently, check `frontend/app/view/code/codestore.ts:15` and `:256`, which use both.

---

### Task 8: `diffpane.tsx` — Monaco replaces the row renderer

**Files:**
- Create: `frontend/app/view/agents/diffpane.tsx`
- Modify: `frontend/app/monaco/monaco-react.tsx:137-138` (model URIs)
- Modify: `frontend/app/view/agents/filessurface.tsx` (delete `DiffRow`, `DiffSkeleton`, `NoTextDiff`, `CenterPane` at `:196-330`; render `DiffPane`; drive the loader)
- Modify: `frontend/app/store/keybindings/bindings.ts:638` (`Shift+D`)

**Interfaces:**
- Consumes: `diffPairAtom`, `loadDiffPair`, `MAX_DIFF_BYTES` (Task 7); `firstDifferingLine` (Task 6); `MonacoDiffViewer`, `useSyncMonacoTheme`.
- Produces: `DiffPane` component; `splitViewAtom`, `SPLIT_MIN_PX` exported from `diffpane.tsx`.

- [ ] **Step 1: Preserve language detection in the shared Monaco wrapper**

`MonacoDiffViewer` builds its model URIs as `wave://diff/<path>.orig` and `.mod` (`monaco-react.tsx:137-138`). The appended suffix destroys the file extension, which is how Monaco picks a language — that is why `codeeditor/diffviewer.tsx` has to pass an explicit `language`. Put the discriminator in the path instead, so the extension survives:

```ts
        const origUri = monaco.Uri.parse(`wave://diff-orig/${encodeURIComponent(path)}`);
        const modUri = monaco.Uri.parse(`wave://diff-mod/${encodeURIComponent(path)}`);
```

The other consumer (`codeeditor/diffviewer.tsx`) passes `language` explicitly and is unaffected.

- [ ] **Step 2: Write the pane**

```tsx
// frontend/app/view/agents/diffpane.tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pane 3 of the Diff surface. One Monaco diff editor for every state the surface has — the working
// tree, a commit, a comparison — because they differ only in which two refs feed it. Split is gated
// on the pane's own measured width rather than the window's: a collapsed history column at the
// shipped 1000x700 leaves enough room for unified and not for split.

import { MOTION } from "@/app/element/motiontokens";
import { SkeletonLine } from "@/app/element/skeleton";
import { getApi } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { openInCode } from "@/app/view/code/codestore";
import { joinRepoPath } from "@/util/paths";
import { cn, fireAndForget } from "@/util/util";
import { atom, useAtomValue } from "jotai";
import type * as MonacoTypes from "monaco-editor";
import { motion } from "motion/react";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import type { AgentsViewModel } from "./agents";
import { firstDifferingLine } from "./diffcontent";
import { diffPairAtom } from "./diffcontentstore";

const MonacoDiffViewer = lazy(() => import("@/app/monaco/monaco-react").then((m) => ({ default: m.MonacoDiffViewer })));

// below this the two editors are narrower than most lines in this repo, so the toggle is offered
// disabled rather than producing a view nobody can read
export const SPLIT_MIN_PX = 900;

export const splitViewAtom = atom<boolean>(false);

function paneOptions(split: boolean): MonacoTypes.editor.IDiffEditorOptions {
    return {
        readOnly: true,
        originalEditable: false,
        renderSideBySide: split,
        scrollBeyondLastLine: false,
        minimap: { enabled: false },
        fontSize: 12.5,
        fontFamily: "var(--font-mono)",
        smoothScrolling: true,
        scrollbar: { useShadows: false, verticalScrollbarSize: 6, horizontalScrollbarSize: 6 },
    };
}

function Centered({ msg }: { msg: string }) {
    return <div className="flex h-full items-center justify-center px-[20px] text-center text-[13px] text-muted">{msg}</div>;
}

function PaneSkeleton() {
    return (
        <div className="flex-1 overflow-hidden px-[20px] py-[14px]">
            {Array.from({ length: 12 }).map((_, i) => (
                <div key={i} className="mb-[10px] flex gap-[10px]">
                    <SkeletonLine className="h-[12px] w-[30px]" />
                    <SkeletonLine className="h-[12px] w-[72%]" />
                </div>
            ))}
        </div>
    );
}

function mb(bytes: number): string {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function DiffPane({
    path,
    adds,
    dels,
    editorCwd,
    repoCwd,
    model,
}: {
    path: string | null;
    adds: number;
    dels: number;
    editorCwd: string | null;
    repoCwd: string | null;
    model: AgentsViewModel;
}) {
    const pair = useAtomValue(diffPairAtom);
    const split = useAtomValue(splitViewAtom);
    const hostRef = useRef<HTMLDivElement>(null);
    const [width, setWidth] = useState(0);

    useEffect(() => {
        const el = hostRef.current;
        if (el == null) {
            return;
        }
        const ro = new ResizeObserver(() => setWidth(el.clientWidth));
        ro.observe(el);
        setWidth(el.clientWidth);
        return () => ro.disconnect();
    }, []);

    const splitAvailable = width >= SPLIT_MIN_PX;
    const options = useMemo(() => paneOptions(split && splitAvailable), [split, splitAvailable]);

    const body = () => {
        if (!path) {
            return <Centered msg="Select a file to view its changes" />;
        }
        if (pair == null || pair.path !== path) {
            return <PaneSkeleton />;
        }
        if (pair.tooLarge) {
            return <Centered msg={`File too large to display (${mb(pair.size)}).`} />;
        }
        if (pair.binary) {
            return <Centered msg="Binary file — git reports a change but has no text to show." />;
        }
        if (pair.original === pair.modified) {
            // a pure rename or a mode change: git listed the file, nothing inside it moved
            return <Centered msg="Nothing inside this file changed." />;
        }
        return (
            <Suspense fallback={<PaneSkeleton />}>
                <MonacoDiffViewer path={path} original={pair.original} modified={pair.modified} options={options} />
            </Suspense>
        );
    };

    return (
        <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: MOTION.durMicro, ease: MOTION.easeFluid }}
            className="flex min-h-0 min-w-0 flex-1 flex-col"
            ref={hostRef}
        >
            {path ? (
                <div className="flex flex-none items-center gap-[11px] border-b border-border px-[20px] py-[13px]">
                    <span className="min-w-0 truncate font-mono text-[13px] font-semibold">{path}</span>
                    <span className="flex-none font-mono text-[11px] font-bold text-success">+{adds}</span>
                    <span className="flex-none font-mono text-[11px] font-bold text-error">−{dels}</span>
                    <div className="flex-1" />
                    <button
                        onClick={() => splitAvailable && globalStore.set(splitViewAtom, !split)}
                        disabled={!splitAvailable}
                        title={splitAvailable ? "Toggle split view" : "Not enough room for split view"}
                        className={cn(
                            "flex-none rounded border border-border px-[11px] py-[6px] font-mono text-[11px]",
                            splitAvailable ? "text-ink-mid hover:text-foreground" : "text-ink-faint opacity-50"
                        )}
                    >
                        {split && splitAvailable ? "split" : "unified"}
                    </button>
                    {repoCwd && (
                        <button
                            onClick={() =>
                                fireAndForget(() =>
                                    openInCode(model, {
                                        projectPath: repoCwd,
                                        rel: path,
                                        line: pair ? firstDifferingLine(pair.original, pair.modified) : undefined,
                                    })
                                )
                            }
                            className="flex-none rounded border border-border px-[11px] py-[6px] text-[12px] text-ink-mid hover:text-foreground"
                        >
                            Open in Code
                        </button>
                    )}
                    {editorCwd && (
                        <button
                            onClick={() => getApi().openExternal(joinRepoPath(editorCwd, path))}
                            className="flex-none rounded border border-border px-[11px] py-[6px] text-[12px] text-ink-mid hover:text-foreground"
                        >
                            Open in editor ↗
                        </button>
                    )}
                </div>
            ) : null}
            {body()}
        </motion.div>
    );
}
```

- [ ] **Step 3: Wire it into the surface**

In `filessurface.tsx`:

1. Delete `NoTextDiff`, `DiffSkeleton`, `DiffRow` and `CenterPane` (`:196-330`) and their now-unused imports (`firstChangedLine`, `DiffLine`, `FileView`, `SkeletonLine` if unused elsewhere in the file, `openInCode`, `getApi`, `joinRepoPath` — check each with a grep before removing).
2. Add `useSyncMonacoTheme()` alongside the surface's other hooks, matching `view/code/codesurface.tsx:59`.
3. Replace the `<CenterPane .../>` render (`:718-727`) with:

```tsx
                            <DiffPane
                                path={compareOn ? compareFile : selectedFile}
                                adds={selectedChange?.adds ?? 0}
                                dels={selectedChange?.dels ?? 0}
                                editorCwd={!compareOn && selectedCommit === WORKING_TREE ? (state?.cwd ?? null) : null}
                                repoCwd={state?.cwd ?? null}
                                model={model}
                            />
```

where `selectedChange` is derived just above the return:

```tsx
    // the header's +/- come from the row that is already loaded, so opening a file costs no extra read
    const shownPath = compareOn ? compareFile : selectedFile;
    const shownChanges = compareOn ? compareChanges : activeChanges;
    const selectedChange = shownChanges?.files.find((f) => f.path === shownPath) ?? null;
```

4. Drive the loader with one effect, replacing nothing (the existing per-state diff reads are removed in step 4):

```tsx
    // one place decides which two refs the pane reads; the three selection states differ only in
    // what they name, which is diffcontent.ts's whole job
    useEffect(() => {
        const cwd = state?.cwd;
        if (!cwd || !shownPath) {
            clearDiffPair();
            return;
        }
        const sel: DiffSelection = compareOn
            ? {
                  kind: "compare",
                  base: compareRefs?.base ?? "",
                  head: compareRefs?.head ?? "",
                  mergeBase: compareSides?.mergeBase ?? "",
                  form: scope?.range.kind === "compare" ? scope.range.form : "mergebase",
              }
            : selectedCommit === WORKING_TREE
              ? { kind: "worktree", anchorRef: state?.ref ?? "" }
              : { kind: "commit", hash: selectedCommit ?? "" };
        fireAndForget(() => loadDiffPair(cwd, shownPath, sel));
    }, [
        state?.cwd,
        state?.ref,
        shownPath,
        compareOn,
        compareRefs?.base,
        compareRefs?.head,
        compareSides?.mergeBase,
        selectedCommit,
        scope?.range,
    ]);
```

`scope.range.form` does not exist until Task 10 — until then, hardcode `"mergebase"` and leave a one-line comment saying Task 10 supplies it. This keeps Task 8 independently runnable.

- [ ] **Step 4: Remove the now-dead unified-diff reads**

The pane no longer consumes `activeDiffAtom` / `compareDiffAtom`. Delete the RPC reads that produce them and the atoms themselves:

- `filesstore.ts:197-213` `selectFile` — keep the function (it still sets `filesSelectedPathAtom`) but drop the `GitDiffCommand` call and the `filesDiffAtom` write; delete `filesDiffAtom`.
- `githistorystore.ts` — delete `commitDiffAtom`, `activeDiffAtom`, and the `GitCommitDiffCommand` call in `selectCommitFile` (keep the `selectedFileAtom` write and the working-tree delegation).
- `comparestore.ts` — delete `compareDiffAtom` and the `GitCompareDiffCommand` call in `selectCompareFile` (keep the selection write).

`parseUnifiedDiff` and `gitdiff.ts` stay in the tree — the spec keeps them as the patch source for the actions spec. `plainFileView` may become unused; leave it, it belongs to the same module.

Note the deliberate behaviour change to record in the PR description: a pure rename now reads "Nothing inside this file changed." without the `from <old path>` line, because the old path came from the diff header the pane no longer reads.

- [ ] **Step 5: Add the split keybinding**

In `buildFilesBindings` (`bindings.ts:638`), inside the returned array:

```ts
        {
            // Shift:d, not bare "d" — bare letters on this surface sit next to the g leader and
            // "/" and would shadow future chords.
            id: "files:toggle-split",
            keys: "Shift:d",
            group: "Diff",
            label: "Split / unified",
            when: on,
            run: () => globalStore.set(splitViewAtom, !globalStore.get(splitViewAtom)),
        },
```

- [ ] **Step 6: Run the affected tests and typecheck**

Run: `npx vitest run frontend/app/store/keybindings frontend/app/view/agents`
Expected: PASS, including the bindings conflict test. Tests referencing the deleted atoms (`comparestore.test.ts` may assert on `compareDiffAtom`) must be updated to assert on `diffPairAtom` or have that assertion removed — read the test before changing it.

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

---

### Task 9: Collapsible history column

**Files:**
- Create: `frontend/app/view/agents/difflayout.ts`
- Create: `frontend/app/view/agents/difflayout.test.ts`
- Create: `frontend/app/view/agents/historyrail.tsx`
- Modify: `frontend/app/view/agents/filessurface.tsx` (column widths, the observer, the toggle)
- Modify: `frontend/app/store/keybindings/bindings.ts` (`Shift+H`)

**Interfaces:**
- Consumes: `HistoryRow`, `WORKING_TREE` (`historyrows.ts`); `CompareRow`, `SIDE_DOT` (`comparerows.ts`).
- Produces: `historyCollapsedAtom` (`PrimitiveAtom<boolean | null>`), `resolveCollapsed(explicit, surfaceWidth)`, `HISTORY_COLLAPSE_PX`, `HistoryRail`.

- [ ] **Step 1: Write the failing test**

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { HISTORY_COLLAPSE_PX, resolveCollapsed } from "./difflayout";

describe("resolveCollapsed", () => {
    it("collapses by default below the threshold — the shipped window is 1000px wide", () => {
        expect(resolveCollapsed(null, 1000)).toBe(true);
    });

    it("expands by default above the threshold", () => {
        expect(resolveCollapsed(null, 1600)).toBe(false);
    });

    it("treats the threshold itself as wide enough", () => {
        expect(resolveCollapsed(null, HISTORY_COLLAPSE_PX)).toBe(false);
    });

    // an explicit choice is a choice: resizing must not silently undo it
    it("lets an explicit expand win at a narrow width", () => {
        expect(resolveCollapsed(false, 900)).toBe(false);
    });

    it("lets an explicit collapse win at a wide width", () => {
        expect(resolveCollapsed(true, 1900)).toBe(true);
    });

    // width is 0 before the first ResizeObserver callback; collapsing then would flash the rail
    it("does not collapse on an unmeasured width", () => {
        expect(resolveCollapsed(null, 0)).toBe(false);
    });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run frontend/app/view/agents/difflayout.test.ts`
Expected: FAIL — cannot resolve `./difflayout`.

- [ ] **Step 3: Implement the resolver**

```ts
// frontend/app/view/agents/difflayout.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pure: how wide the Diff surface is -> whether the commit column is a column or a rail. The
// surface ships in a 1000x700 window (src-tauri/tauri.conf.json), where a fixed 460px history plus
// a 300px file list leaves the diff pane about 240px — unreadable. One threshold on one column is
// the whole of it; the rest of the folding cascade stays declined (docs/deferred.md).

import { atom, type PrimitiveAtom } from "jotai";

export const HISTORY_COLLAPSE_PX = 1280;

// null = follow the width; true/false = the user said so and resizing must not undo it
export const historyCollapsedAtom = atom<boolean | null>(null) as PrimitiveAtom<boolean | null>;

export function resolveCollapsed(explicit: boolean | null, surfaceWidth: number): boolean {
    if (explicit != null) {
        return explicit;
    }
    if (surfaceWidth <= 0) {
        return false; // not measured yet; expanding first avoids a rail that flashes and vanishes
    }
    return surfaceWidth < HISTORY_COLLAPSE_PX;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run frontend/app/view/agents/difflayout.test.ts`
Expected: 6 passing.

- [ ] **Step 5: Write the rail**

```tsx
// frontend/app/view/agents/historyrail.tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The history column at its collapsed width: hashes and lane colour, nothing else. A narrow
// presentation of rows the surface already has — no second data path, no second selection model.

import { cn } from "@/util/util";
import { WORKING_TREE, type HistoryRow } from "./historyrows";

const ROW_H = 34;

export function HistoryRail({
    rows,
    selected,
    onSelect,
    onExpand,
}: {
    rows: HistoryRow[];
    selected: string | null;
    onSelect: (hash: string) => void;
    onExpand: () => void;
}) {
    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <button
                onClick={onExpand}
                title="Expand history"
                className="flex-none border-b border-edge-faint py-[6px] text-[11px] text-ink-faint hover:text-foreground"
            >
                ›
            </button>
            <div className="min-h-0 flex-1 overflow-y-auto py-[4px]">
                {rows.map((r) => (
                    <button
                        key={r.hash || WORKING_TREE}
                        onClick={() => onSelect(r.hash)}
                        title={r.subject}
                        style={{ height: ROW_H }}
                        className={cn(
                            "flex w-full items-center justify-center font-mono text-[9px] text-ink-faint hover:text-foreground",
                            r.hash === selected && "bg-surface-selected text-ink-hi"
                        )}
                    >
                        {r.hash === WORKING_TREE ? "·······" : r.hash.slice(0, 7)}
                    </button>
                ))}
            </div>
        </div>
    );
}
```

- [ ] **Step 6: Wire the surface**

In `filessurface.tsx`:

1. Observe the surface root's width into a `surfaceWidth` state with a `ResizeObserver`, the same shape as the pane's observer in Task 8, attached to the outermost `div` of the surface.
2. `const collapsed = resolveCollapsed(useAtomValue(historyCollapsedAtom), surfaceWidth);`
3. Change the left column's class from the fixed `w-[460px]` to a conditional width, keeping every other class:

```tsx
                        <div
                            className={cn(
                                "flex flex-none flex-col border-r border-edge-faint",
                                collapsed ? "w-[44px]" : "w-[460px]"
                            )}
                        >
```

4. Inside it, render `HistoryRail` when `collapsed`, keeping the existing `HistoryPane` / `CompareColumn` branch for the expanded case. The rail takes the same `rows` and `onSelect` those receive; in compare mode pass the compare rows filtered to commits (`rows.filter((r) => r.kind === "commit")`) mapped to their `HistoryRow` shape — `CompareCommitRow extends HistoryRow`, so no adapter is needed.
5. Add a collapse chevron to the expanded header (`onClick={() => globalStore.set(historyCollapsedAtom, true)}`).

- [ ] **Step 7: Add the keybinding**

```ts
        {
            id: "files:toggle-history",
            keys: "Shift:h",
            group: "Diff",
            label: "Collapse / expand history",
            when: on,
            run: () => {
                const cur = globalStore.get(historyCollapsedAtom);
                // from "follow the width", an explicit toggle means "collapse it" — that is the
                // state the user can see and is reacting to
                globalStore.set(historyCollapsedAtom, cur == null ? true : !cur);
            },
        },
```

- [ ] **Step 8: Run the tests**

Run: `npx vitest run frontend/app/view/agents frontend/app/store/keybindings`
Expected: PASS.

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

---

### Task 10: The range form lives in the range

**Files:**
- Modify: `frontend/app/view/agents/diffscope.ts` (`DiffRange`, `rangeKey`, `rangeSummary`, `currentCompareRange`)
- Modify: `frontend/app/view/agents/diffscope.test.ts` (append)
- Modify: `frontend/app/view/agents/comparestore.ts` (thread `form` into both compare RPCs)
- Modify: `frontend/app/view/agents/aggregatepane.tsx` (the toggle)
- Modify: `frontend/app/view/agents/filessurface.tsx` (pass the real form to `loadDiffPair`)

**Interfaces:**
- Consumes: `CompareForm` (Task 6).
- Produces: `DiffRange` compare variant gains `form: CompareForm`; `setCompareForm(cwd, form)` in `comparestore.ts`.

- [ ] **Step 1: Write the failing tests**

Append to `frontend/app/view/agents/diffscope.test.ts`:

```ts
describe("compare range form", () => {
    const mergebase: DiffRange = {
        kind: "compare",
        base: "main",
        head: "feature",
        form: "mergebase",
        from: { kind: "working" },
    };

    // the key is what drops stale reads, so two forms of the same pair must not share one
    it("distinguishes the two forms in rangeKey", () => {
        expect(rangeKey(mergebase)).not.toBe(rangeKey({ ...mergebase, form: "tips" }));
    });

    it("names the active form in the summary line", () => {
        const facts = { branch: "feature", ref: "", files: 3, adds: 10, dels: 2 };
        expect(rangeSummary(mergebase, facts)).toContain("since merge base");
        expect(rangeSummary({ ...mergebase, form: "tips" }, facts)).toContain("tip to tip");
    });
});
```

Import `rangeKey`, `rangeSummary` and the `DiffRange` type at the top of that file if they are not already imported.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run frontend/app/view/agents/diffscope.test.ts`
Expected: FAIL — type error on `form`, or identical keys.

- [ ] **Step 3: Implement**

In `diffscope.ts`:

```ts
import type { CompareForm } from "./diffcontent";

export type DiffRange =
    | { kind: "working" }
    | { kind: "session"; agentId: string }
    | { kind: "run"; runId: string; baseCommit: string }
    // `from` is the range comparison interrupted. `form` is which range form the aggregate uses:
    // merge-base (what head introduced) or tip-to-tip (the full difference). It lives here rather
    // than beside the surface so rangeKey covers it and a form change drops the stale read.
    | { kind: "compare"; base: string; head: string; form: CompareForm; from: DiffRange };
```

```ts
        case "compare":
            return `compare:${r.base}..${r.head}:${r.form}`;
```

```ts
        case "compare":
            return `${range.base} … ${range.head} · ${range.form === "tips" ? "tip to tip" : "since merge base"} · ${counts}`;
```

and in `currentCompareRange`:

```ts
    return { kind: "compare", base: "", head: "", form: "mergebase", from: active };
```

In `comparestore.ts`: read the form off the scope in `setCompareRefs` and pass it to both RPCs, and add the setter:

```ts
function activeForm(): CompareForm {
    const r = globalStore.get(diffScopeAtom)?.range;
    return r?.kind === "compare" ? r.form : "mergebase";
}
```
```ts
            RpcApi.GitCompareChangesCommand(TabRpcClient, { cwd, base, head, form: activeForm() }),
```
```ts
// A form change is a different question about the same two refs, so it re-reads the aggregate and
// the open file but leaves the commit columns alone — divergence does not depend on the form.
export async function setCompareForm(cwd: string, form: CompareForm): Promise<void> {
    const scope = globalStore.get(diffScopeAtom);
    if (scope == null || scope.range.kind !== "compare" || scope.range.form === form) {
        return;
    }
    globalStore.set(diffScopeAtom, { ...scope, range: { ...scope.range, form } });
    await setCompareRefs(cwd, scope.range.base, scope.range.head);
}
```

Also add `form: activeForm()` to the `GitCompareDiffCommand` call in `selectCompareFile`.

In `enterCompare`, include `form` when constructing the range:

```ts
    globalStore.set(diffScopeAtom, { ...scope, range: { kind: "compare", base, head, form: "mergebase", from } });
```

- [ ] **Step 4: Add the toggle to the aggregate pane**

In `aggregatepane.tsx`, add `form` and `onSetForm` props and render two chips under the ref line, using the same `SIDE_TEXT` vocabulary already imported there:

```tsx
                <div className="mt-[9px] flex items-center gap-[6px] font-mono text-[10px]">
                    {(["mergebase", "tips"] as const).map((f) => (
                        <button
                            key={f}
                            onClick={() => onSetForm(f)}
                            className={cn(
                                "rounded-[6px] border px-[7px] py-[2px]",
                                form === f
                                    ? "border-accent/40 bg-accentbg text-ink-hi"
                                    : "border-edge-mid text-ink-faint hover:text-foreground"
                            )}
                        >
                            {f === "mergebase" ? "••• merge base" : "•• tip to tip"}
                        </button>
                    ))}
                </div>
```

Pass them from `filessurface.tsx`'s `<AggregatePane>` render, wiring `onSetForm` to `state?.cwd && fireAndForget(() => setCompareForm(state.cwd!, f))`.

- [ ] **Step 5: Use the real form in the pane loader**

Replace the Task 8 placeholder in the `loadDiffPair` effect with `scope?.range.kind === "compare" ? scope.range.form : "mergebase"`.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run frontend/app/view/agents`
Expected: PASS. `comparestore.test.ts` constructs compare ranges and will need `form: "mergebase"` added to its fixtures — read it first, then edit.

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

---

### Task 11: Swap, remote refs in the picker, fetch

**Files:**
- Modify: `frontend/app/view/agents/refpicker.tsx`
- Modify: `frontend/app/view/agents/comparestore.ts` (`loadCompareRefsMeta`, `swapCompareRefs`, `runFetch`, fetch atoms)
- Modify: `frontend/app/view/agents/filessurface.tsx` (fetch button + clock in the subject bar)
- Modify: `frontend/app/store/keybindings/bindings.ts` (`Shift+S`)

**Interfaces:**
- Consumes: `RpcApi.GitFetchCommand`, `IncludeRemotes` (Task 5).
- Produces: `swapCompareRefs(cwd)`, `runFetch(cwd)`, `fetchStateAtom` (`{ running: boolean; at: number; failure: GitFailure | null }`).

- [ ] **Step 1: Ask for remotes and swap**

In `comparestore.ts`:

```ts
        const rtn = await RpcApi.ListBranchesCommand(TabRpcClient, { projectpath: cwd, includeremotes: true });
```

```ts
// Swapping is a different comparison, not a redraw: both the divergence and the aggregate invert,
// so it goes through the same path a typed pair does.
export async function swapCompareRefs(cwd: string): Promise<void> {
    const refs = globalStore.get(compareRefsAtom);
    if (refs == null || !refs.base || !refs.head) {
        return;
    }
    await setCompareRefs(cwd, refs.head, refs.base);
}
```

```ts
export interface FetchState {
    running: boolean;
    at: number; // unix seconds of the last successful fetch; 0 = never in this session
    failure: GitFailure | null;
}

export const fetchStateAtom = atom<FetchState>({ running: false, at: 0, failure: null }) as PrimitiveAtom<FetchState>;

// A fetch is the one network call this surface makes. The 5s default RPC budget binds the server
// context, so a merely-slow fetch would be killed while still running; the client budget is raised
// to sit just outside gitinfo's own fetchTimeout.
export async function runFetch(cwd: string): Promise<void> {
    globalStore.set(fetchStateAtom, { ...globalStore.get(fetchStateAtom), running: true, failure: null });
    try {
        const r = await RpcApi.GitFetchCommand(TabRpcClient, { cwd }, { timeout: 60000 });
        globalStore.set(fetchStateAtom, {
            running: false,
            at: r.fetchedat ?? 0,
            failure: r.failure ?? null,
        });
        if (r.failure == null) {
            await loadCompareRefsMeta(cwd);
            const refs = globalStore.get(compareRefsAtom);
            if (refs != null) {
                await setCompareRefs(cwd, refs.base, refs.head);
            }
        }
    } catch {
        globalStore.set(fetchStateAtom, {
            running: false,
            at: globalStore.get(fetchStateAtom).at,
            failure: { command: "git fetch", exitcode: -1, stderr: "the fetch did not complete" },
        });
    }
}
```

Check `RpcOpts`'s field name in `frontend/app/store/wshrpcutil.ts` before writing `{ timeout: 60000 }` — match whatever the type declares.

- [ ] **Step 2: Group the picker's suggestions and add the swap control**

In `refpicker.tsx`'s `Suggestions`, split `shown` into local and remote and render a small uppercase `label`-class heading above each non-empty group, keeping the existing row markup. Between the two input fields, replace the static `…` span with a button:

```tsx
            <button
                onClick={onSwap}
                title="Swap base and head"
                className="flex-none px-[3px] font-mono text-[12px] text-ink-faint hover:text-foreground"
            >
                ⇄
            </button>
```

Editing, `onSwap` swaps the two drafts in local state. Closed (the non-editing branch, which currently renders a single button), add the same control beside the ref expression wired to `swapCompareRefs`.

- [ ] **Step 3: Fetch button in the subject bar**

In `filessurface.tsx`, inside the `{compareOn ? ... : null}` block that already renders `RefPicker`, add a button reading `↻ Fetch` (disabled while `running`), plus a `text-ink-faint` clock derived from `fetchStateAtom.at` using the existing `formatAge` helper from `agentsviewmodel.ts`. When `failure` is set, render the shipped `GitFailurePanel` with it, matching how `historyFailure` is rendered at `:637`.

- [ ] **Step 4: Add the swap keybinding**

```ts
        {
            id: "files:swap-refs",
            keys: "Shift:s",
            group: "Diff",
            label: "Swap compare refs",
            when: inCompare,
            run: () => {
                const cwd = globalStore.get(filesStateAtom)?.cwd;
                if (!cwd) {
                    return false;
                }
                void swapCompareRefs(cwd);
            },
        },
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run frontend/app/view/agents frontend/app/store/keybindings`
Expected: PASS. `comparestore.test.ts` asserts on the `ListBranchesCommand` argument shape — update its expectation to include `includeremotes: true`.

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

---

### Task 12: Grouped file tree

**Files:**
- Create: `frontend/app/view/agents/filetree.ts`
- Create: `frontend/app/view/agents/filetree.test.ts`
- Modify: `frontend/app/view/agents/changedfilelist.tsx`

**Interfaces:**
- Consumes: `GitChange`, `GitChanges`, `statusColor` (`gitstatus.ts`).
- Produces: `buildFileTree(files: GitChange[], collapsed: Set<string>): FileTreeRow[]`, `FileTreeRow`, `treeModeAtom`, `collapsedDirsAtom`.

- [ ] **Step 1: Write the failing tests**

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { buildFileTree } from "./filetree";
import type { GitChange } from "./gitstatus";

const f = (path: string, adds = 1, dels = 0): GitChange => ({ path, status: "M", adds, dels });

describe("buildFileTree", () => {
    it("groups files under their directory, directory first", () => {
        const rows = buildFileTree([f("retry/policy.go"), f("retry/budget.go")], new Set());
        expect(rows.map((r) => [r.kind, r.label])).toEqual([
            ["dir", "retry"],
            ["file", "budget.go"],
            ["file", "policy.go"],
        ]);
    });

    it("rolls up counts onto the directory row", () => {
        const rows = buildFileTree([f("retry/policy.go", 10, 2), f("retry/budget.go", 5, 3)], new Set());
        const dir = rows[0];
        expect([dir.files, dir.adds, dir.dels]).toEqual([2, 15, 5]);
    });

    // an indented list of single-child directories is not a tree, it is a staircase
    it("collapses a single-child directory chain into one row", () => {
        const rows = buildFileTree([f("a/b/c/deep.go")], new Set());
        expect(rows.map((r) => r.label)).toEqual(["a/b/c", "deep.go"]);
    });

    it("hides the children of a collapsed directory but keeps its row", () => {
        const rows = buildFileTree([f("retry/policy.go"), f("server/submit.go")], new Set(["retry"]));
        expect(rows.map((r) => r.label)).toEqual(["retry", "server", "submit.go"]);
    });

    it("puts root-level files after the directories", () => {
        const rows = buildFileTree([f("README.md"), f("retry/policy.go")], new Set());
        expect(rows.map((r) => r.label)).toEqual(["retry", "policy.go", "README.md"]);
    });

    it("returns nothing for no files", () => {
        expect(buildFileTree([], new Set())).toEqual([]);
    });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run frontend/app/view/agents/filetree.test.ts`
Expected: FAIL — cannot resolve `./filetree`.

- [ ] **Step 3: Implement**

```ts
// frontend/app/view/agents/filetree.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pure: a flat changed-file list -> the rows a grouped list draws. Single-child directory chains
// fold into one row, which is the difference between a tree and a staircase of one-item folders.

import { atom, type PrimitiveAtom } from "jotai";
import type { GitChange } from "./gitstatus";

export interface FileTreeRow {
    kind: "dir" | "file";
    // full path for a file, joined directory path for a directory; unique, used as the react key
    // and as the collapse identity
    id: string;
    label: string;
    depth: number;
    // files only
    change?: GitChange;
    // directories only
    files?: number;
    adds?: number;
    dels?: number;
}

export const treeModeAtom = atom<boolean>(true) as PrimitiveAtom<boolean>;
export const collapsedDirsAtom = atom<Set<string>>(new Set<string>()) as PrimitiveAtom<Set<string>>;

interface Node {
    dirs: Map<string, Node>;
    files: GitChange[];
}

function emptyNode(): Node {
    return { dirs: new Map(), files: [] };
}

function insert(root: Node, change: GitChange): void {
    const parts = change.path.split("/");
    let node = root;
    for (const dir of parts.slice(0, -1)) {
        let next = node.dirs.get(dir);
        if (next == null) {
            next = emptyNode();
            node.dirs.set(dir, next);
        }
        node = next;
    }
    node.files.push(change);
}

function totals(node: Node): { files: number; adds: number; dels: number } {
    let files = node.files.length;
    let adds = node.files.reduce((n, f) => n + f.adds, 0);
    let dels = node.files.reduce((n, f) => n + f.dels, 0);
    for (const child of node.dirs.values()) {
        const t = totals(child);
        files += t.files;
        adds += t.adds;
        dels += t.dels;
    }
    return { files, adds, dels };
}

function walk(node: Node, prefix: string, depth: number, collapsed: Set<string>, out: FileTreeRow[]): void {
    for (const [name, child] of [...node.dirs.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        // fold a chain of single-child directories into one label
        let label = name;
        let cur = child;
        while (cur.files.length === 0 && cur.dirs.size === 1) {
            const [onlyName, onlyChild] = [...cur.dirs.entries()][0];
            label = `${label}/${onlyName}`;
            cur = onlyChild;
        }
        const id = prefix ? `${prefix}/${label}` : label;
        const t = totals(cur);
        out.push({ kind: "dir", id, label, depth, files: t.files, adds: t.adds, dels: t.dels });
        if (!collapsed.has(id)) {
            walk(cur, id, depth + 1, collapsed, out);
        }
    }
    for (const change of [...node.files].sort((a, b) => a.path.localeCompare(b.path))) {
        out.push({
            kind: "file",
            id: change.path,
            label: change.path.split("/").pop() ?? change.path,
            depth,
            change,
        });
    }
}

export function buildFileTree(files: GitChange[], collapsed: Set<string>): FileTreeRow[] {
    const root = emptyNode();
    for (const f of files) {
        insert(root, f);
    }
    const out: FileTreeRow[] = [];
    walk(root, "", 0, collapsed, out);
    return out;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run frontend/app/view/agents/filetree.test.ts`
Expected: 6 passing. Note the root-files-last ordering assertion — `walk` emits directories before files at every level, which is what that test pins.

- [ ] **Step 5: Render the tree in `ChangedFileList`**

In `changedfilelist.tsx`, read `treeModeAtom` and `collapsedDirsAtom`; when tree mode is on, render `buildFileTree(changes.files, collapsed)`. A file row keeps today's markup exactly, with `paddingLeft: 8 + depth * 14`. A directory row shows a chevron, the label, and its rolled-up `files` / `+adds` / `−dels`, and toggles its id in `collapsedDirsAtom` on click (write a new `Set`, never mutate — jotai compares by reference). Add a small tree/flat toggle to `AggregatePane` and `CommitPane`'s headers writing `treeModeAtom`.

- [ ] **Step 6: Run the tests and typecheck**

Run: `npx vitest run frontend/app/view/agents`
Expected: PASS.

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

---

### Task 13: Verify in the real app, then commit

**Files:**
- Modify: `scripts/cdp/scenarios.mjs` (one new scenario)
- Commit: everything from Tasks 1-12, plus the spec and this plan

**Interfaces:**
- Consumes: everything above.
- Produces: a `diff-compare` scenario; one commit.

- [ ] **Step 1: Build the backend**

The new RPC commands do not exist in the running `wavesrv` until it is rebuilt, and a missing command surfaces as a route error, not a compile error.

Run: `task build:backend`
Expected: `dist/bin/wavesrv.x64.exe` and the `wsh-*` binaries rebuilt.

- [ ] **Step 2: Run the full test suites**

Run: `go test ./pkg/gitinfo/`
Run: `npx vitest run`
Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: all green. Do not proceed past a failure — fix it.

- [ ] **Step 3: Add the CDP scenario**

In `scripts/cdp/scenarios.mjs`, following the shape of the existing entries: pin the viewport to **1000x700** (the shipped window size — this scenario exists to assert the layout claim, so pinning 1600x950 would defeat it), navigate to the Diff surface, press `c` to enter compare, wait for the aggregate row, click the second file row, and assert that the Monaco diff container is present and that the history column is at its collapsed width. Note the two known scenario gotchas: scope every DOM query to a `data-*` container rather than querying `button` document-wide, and record each click as its own step.

- [ ] **Step 4: Run the scenario against the dev app**

Start the dev app (`tail -f /dev/null | task dev` if running headless — a bare `task dev` dies on stdin EOF), then:

Run: `task verify:ui -- diff-compare`
Expected: PASS, with a screenshot in `cdp-shots/`. Look at the screenshot: the diff must be syntax-highlighted, the history column must be a rail, and the pane must be wide enough to read. If `:9222` refuses the connection, check the dev log — another session's edit crashing `task dev` looks identical to a CDP fault.

- [ ] **Step 5: Self-review the diff**

Run: `git status --short` and `git diff`
Check: no commented-out code, no debug logging, no stray `console.log`, no unrelated files, no hardcoded colors, no emojis. Confirm `gitdiff.ts` still compiles despite having fewer consumers, and that nothing references the deleted `activeDiffAtom` / `compareDiffAtom` / `filesDiffAtom`.

- [ ] **Step 6: Ask for approval, then commit**

Do not run this without an explicit yes — the repo rule is no commit without approval.

```bash
git add pkg/gitinfo/gitinfo.go pkg/gitinfo/gitinfo_test.go \
        pkg/wshrpc/wshrpctypes_git.go pkg/wshrpc/wshrpctypes_projects.go \
        pkg/wshrpc/wshserver/wshserver_git.go pkg/wshrpc/wshserver/wshserver_projects.go \
        pkg/wshrpc/wshclient/wshclient.go \
        frontend/app/store/wshclientapi.ts frontend/types/gotypes.d.ts \
        frontend/app/monaco/monaco-react.tsx \
        frontend/app/store/keybindings/bindings.ts \
        frontend/app/view/agents/ \
        scripts/cdp/scenarios.mjs \
        docs/superpowers/specs/2026-09-04-git-compare-viewer-parity-design.md \
        docs/superpowers/plans/2026-09-04-git-compare-viewer-parity.md
```

Then commit with a message file (never a PowerShell here-string in the Bash tool on this machine):

```
feat(diff): Monaco diff pane, collapsible history, compare parity

Replaces the Diff surface's unified-row renderer with Monaco fed by two
file texts at any ref, and fixes the layout that made the pane
unreadable at the shipped 1000x700 window: the history column now
collapses to a rail below 1280px.

Adds the range-form toggle (merge-base / tip-to-tip), remote-tracking
refs with fetch, ref swapping, and a grouped changed-file tree.

Behaviour change: a pure rename now reads "Nothing inside this file
changed." without the previous "from <old path>" line, which came from
the diff header the pane no longer reads.
```

---

## Self-Review

**Spec coverage.** Backend `FileAtRef` -> Task 1; `ListBranches` remotes and remote-first `DefaultBranch` -> Task 2; `Fetch` -> Task 3; compare form readers -> Task 4; RPC surface and codegen -> Task 5; the diff pane and its ref resolution -> Tasks 6-8; layout decision 1 -> Task 9; range-form decision 2 -> Task 10; refs, swap and fetch UI decisions 3 -> Task 11; file grouping -> Task 12; the CDP scenario the spec asks for -> Task 13. Every keybinding the spec lists is folded into the task that ships its feature.

**Deviation from the spec, recorded here rather than left implicit.** The spec said `parseUnifiedDiff` would remain the source of the pane's no-text states. It does not: with both file texts in hand, "binary" and "missing" come from `FileAtRef`'s own flags and "nothing changed" is `original === modified`, so keeping a third read purely to detect them would cost a round trip for nothing. The parser stays in the tree for the actions spec's patches, exactly as the spec's decision 4 requires. The visible consequence is the lost `from <old path>` line on a rename, which Task 8 step 4 and the commit message both call out.

**Placeholder scan.** No TBDs. The three items the spec deferred to this plan are resolved: the 2 MB cap is a named constant in Task 7 with the reason written down and Task 13 step 4 looks at real behaviour; the `refs/remotes` filter is an `IncludeRemotes` request field (Task 2 step 4), chosen so `newagentmodal.tsx` needs no change at all and cannot regress; Monaco's mount cost is checked by eye in Task 13 step 4. Two steps end in "check X before writing this" — `failureOf`'s stderr plumbing (Task 3) and `RpcOpts`'s timeout field name (Task 11) — both name the file to read and the assertion that will catch a wrong guess.

**Type consistency.** `DiffSelection`, `DiffSide` and `CompareForm` are defined in Task 6 and used with those names in Tasks 7, 8 and 10. `DiffPair`'s fields (`path`, `original`, `modified`, `binary`, `tooLarge`, `size`) are produced in Task 7 and read in Task 8. `historyCollapsedAtom` / `resolveCollapsed` / `HISTORY_COLLAPSE_PX` are defined and consumed in Task 9. `FileTreeRow.id` is the collapse identity in both Task 12's implementation and its test. The Go `FileContent` fields map to the RPC `CommandGitFileAtRefRtnData` fields one-for-one, and the TypeScript reads them lowercased (`r.toolarge`, `r.isrepo`) exactly as `task generate` emits them.
