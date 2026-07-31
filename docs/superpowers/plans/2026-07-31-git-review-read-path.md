# Git review read path + lane layout — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and test the read path and graph-layout maths behind commit history and branch comparison in the Diff surface, with no UI changes.

**Architecture:** Extend `pkg/gitinfo` with a full history walk (parents, ref decoration, author, pagination, filters) and a divergence reader, expose both through a new per-domain RPC interface (`GitCommands`), and add two pure frontend modules — lane assignment and SVG geometry — each unit-tested. Nothing renders; this plan produces callable, tested functions that plan 2 (surface restructure) consumes.

**Tech Stack:** Go 1.x shelling out to the `git` binary (no go-git), the wshrpc typed RPC spine with generated TypeScript bindings, TypeScript + vitest for the frontend modules.

**Design source:** `docs/superpowers/briefs/2026-07-31-git-review-ui-design-brief.md` and the mockup at `wave-handoff/wave/project/Wave-git-review.dc.html`. The mockup's `buildGraph` hardcodes lane indices in its fixtures; tasks 4 and 5 replace that with computed layout. The mockup also bakes CSS colour strings into geometry — this plan deliberately does not, returning lane indices and flags so components map lane → token (see Global Constraints).

## Global Constraints

- **Do not hand-edit generated files.** Go is the source of truth for the wire protocol. After changing any `wshrpc` type or interface, run `task generate`, which rewrites `frontend/app/store/wshclientapi.ts` and the generated Go/TS type files.
- **Do not commit during execution.** Batch all work into a single commit at the end, and only after the user explicitly approves. This overrides the writing-plans skill's per-task commit convention.
- **Typecheck with** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`. Plain `npx tsc` stack-overflows on this repo, which also means `task check:ts` is broken. Baseline is clean (exit 0), so any error reported is yours.
- **`go test ./pkg/wshrpc/wshserver/` will not build without a CGO flag.** That package is one of six that fail on `sqlite-vec.h: fatal error: sqlite3.h`. From the repo root in PowerShell, before running it: `$env:CGO_CFLAGS = "-O2 -g -I$((Get-Location).Path -replace '\\','/')/pkg/jarvisembed/csrc"`. The `-I` path must be Windows-style — a Git-Bash POSIX path fails with the identical error. `go test ./pkg/gitinfo/` needs no such setup.
- **Run only the target-file tests for each task.** Full-suite validation is the user's, done manually.
- **No raw hex or CSS colour strings in these modules.** Colours come from `@theme` tokens in `frontend/tailwindsetup.css`, applied in components. Geometry returns lane indices and boolean flags only.
- **Vitest only discovers `.test.ts` / `.test.tsx`.** A `.test.js` file is silently never run.
- **Follow the existing gitinfo idiom:** shell out via the package-local `run(ctx, cwd, args...)` helper, guard with `rev-parse --is-inside-work-tree` and return `IsRepo: false` rather than an error when the directory is not a repo, and wrap each exported call in `context.WithTimeout(ctx, gitTimeout)`.

---

### Task 1: History walk in gitinfo

Adds the one genuinely missing read: a paginated commit walk carrying parent links and ref decoration. Parent links are what a graph is drawn from.

**Files:**
- Modify: `pkg/gitinfo/gitinfo.go` (append; the file's existing exports are `GetChanges`, `GetRangeChanges`, `RangeLog`, `GetDiff`, `ListBranches`, `HeadCommit`, `CommitBefore`, `RevertFile`, `RevertHunk`, `WorktreePath`, `CreateWorktree`)
- Test: `pkg/gitinfo/gitinfo_test.go` (append; reuse the existing `repoWithChange(t)` / `repoCommittedOnBase(t)` helpers as models — both build a repo under `t.TempDir()`)

**Interfaces:**
- Consumes: the package-local `run(ctx, cwd, args ...string) (string, error)` helper and the `gitTimeout` constant, both already in `gitinfo.go`.
- Produces: `gitinfo.HistoryLog(ctx context.Context, cwd string, opts HistoryOpts) (*History, error)`, plus the exported types `HistoryCommit`, `HistoryOpts`, `History`. Task 2 and Task 3 both call this.

- [ ] **Step 1: Write the failing test**

Append to `pkg/gitinfo/gitinfo_test.go`:

```go
// repoBranchMerge builds: root -> a -> (feature: b) -> merge, so history has a real merge commit
// with two parents and a branch ref to decorate.
func repoBranchMerge(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	git := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
		cmd.Env = append(os.Environ(),
			"GIT_AUTHOR_NAME=dana k", "GIT_AUTHOR_EMAIL=dana@example.com",
			"GIT_COMMITTER_NAME=dana k", "GIT_COMMITTER_EMAIL=dana@example.com")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v: %s", args, err, out)
		}
	}
	write := func(name, body string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	commit := func(name, body, msg string) {
		t.Helper()
		write(name, body)
		git("add", ".")
		git("commit", "-m", msg)
	}
	git("init", "--initial-branch=main")
	commit("root.txt", "root\n", "root commit")
	commit("a.txt", "a\n", "second on main")
	git("checkout", "-b", "feature")
	commit("b.txt", "b\n", "only on feature")
	git("checkout", "main")
	git("merge", "--no-ff", "feature", "-m", "merge feature into main")
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
```

`gitinfo_test.go` already imports `context`, `os`, `strings` and `testing` for its existing tests; add `os/exec` and `path/filepath` to the import block if they are not present.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go test ./pkg/gitinfo/ -run 'TestHistoryLog' -v`
Expected: FAIL — compile error, `undefined: HistoryLog`, `undefined: HistoryOpts`.

- [ ] **Step 3: Write the implementation**

Append to `pkg/gitinfo/gitinfo.go`:

```go
// defaultHistoryLimit bounds an unpaginated history read. A cockpit-sized page, not a whole repo:
// the surface pages as the user scrolls, and an unbounded log on a large repo blocks the RPC.
const defaultHistoryLimit = 200

// fieldSep / recordSep are git's own unit and record separators (%x1f / %x1e). Using an explicit
// record separator rather than relying on newlines keeps parsing correct even when a field's own
// content contains a newline.
const (
	fieldSep  = "\x1f"
	recordSep = "\x1e"
)

// HistoryCommit is one commit in a history walk. Parents are full SHAs in git's own order, so
// Parents[0] is the first parent — the lane a graph continues down. Refs are decoration entries as
// git prints them ("HEAD -> main", "origin/main", "tag: v0.9.4"), left unparsed for the frontend.
type HistoryCommit struct {
	Hash    string   `json:"hash"`
	Parents []string `json:"parents"`
	Author  string   `json:"author"`
	Email   string   `json:"email"`
	Ts      int64    `json:"ts"`
	Subject string   `json:"subject"`
	Refs    []string `json:"refs,omitempty"`
}

// HistoryOpts scopes a history walk. Zero value = the default-limit walk from HEAD across all refs.
type HistoryOpts struct {
	Ref    string // revision or range ("main", a SHA, "base..head"); "" = all refs
	Skip   int
	Limit  int // 0 => defaultHistoryLimit
	Author string
	Grep   string
	Path   string
}

// History is a page of commits plus the current HEAD, which the surface needs to anchor a synthetic
// working-tree row to the commit it sits on top of.
type History struct {
	Commits []HistoryCommit `json:"commits"`
	Head    string          `json:"head"`
	IsRepo  bool            `json:"isrepo"`
}

// HistoryLog walks commit history newest-first with parent links and ref decoration. Unlike RangeLog
// (which answers "what commits are in this bounded base..end range") this is the paginated,
// filterable walk a history view scrolls through. --date-order keeps sibling branches interleaved by
// time rather than collapsing one branch at a time, which is what makes a lane graph readable.
func HistoryLog(ctx context.Context, cwd string, opts HistoryOpts) (*History, error) {
	ctx, cancel := context.WithTimeout(ctx, gitTimeout)
	defer cancel()
	inside, err := run(ctx, cwd, "rev-parse", "--is-inside-work-tree")
	if err != nil || strings.TrimSpace(inside) != "true" {
		return &History{IsRepo: false}, nil
	}
	limit := opts.Limit
	if limit <= 0 {
		limit = defaultHistoryLimit
	}
	args := []string{"log", "--date-order", "--no-color", "--decorate=short",
		"--pretty=format:%H" + fieldSep + "%P" + fieldSep + "%an" + fieldSep + "%ae" +
			fieldSep + "%ct" + fieldSep + "%D" + fieldSep + "%s" + recordSep,
		"--max-count=" + strconv.Itoa(limit)}
	if opts.Skip > 0 {
		args = append(args, "--skip="+strconv.Itoa(opts.Skip))
	}
	if opts.Author != "" {
		args = append(args, "--author="+opts.Author)
	}
	if opts.Grep != "" {
		args = append(args, "--grep="+opts.Grep, "--regexp-ignore-case")
	}
	if opts.Ref != "" {
		args = append(args, opts.Ref)
	} else {
		args = append(args, "--all")
	}
	// a pathspec must come last, after the revision
	if opts.Path != "" {
		args = append(args, "--", opts.Path)
	}
	out, err := run(ctx, cwd, args...)
	if err != nil {
		return nil, err
	}
	head, _ := run(ctx, cwd, "rev-parse", "HEAD")
	return &History{Commits: parseHistory(out), Head: strings.TrimSpace(head), IsRepo: true}, nil
}

func parseHistory(out string) []HistoryCommit {
	var commits []HistoryCommit
	for _, rec := range strings.Split(out, recordSep) {
		rec = strings.TrimLeft(rec, "\r\n")
		if strings.TrimSpace(rec) == "" {
			continue
		}
		f := strings.Split(rec, fieldSep)
		if len(f) < 7 {
			continue
		}
		secs, _ := strconv.ParseInt(strings.TrimSpace(f[4]), 10, 64)
		commits = append(commits, HistoryCommit{
			Hash:    f[0],
			Parents: strings.Fields(f[1]),
			Author:  f[2],
			Email:   f[3],
			Ts:      secs * 1000,
			Refs:    parseDecoration(f[5]),
			Subject: f[6],
		})
	}
	return commits
}

// parseDecoration splits git's %D decoration ("HEAD -> main, origin/main, tag: v0.9.4") into its
// entries, left otherwise verbatim so the frontend decides how each kind is labelled.
func parseDecoration(d string) []string {
	d = strings.TrimSpace(d)
	if d == "" {
		return nil
	}
	parts := strings.Split(d, ",")
	refs := make([]string, 0, len(parts))
	for _, p := range parts {
		if p = strings.TrimSpace(p); p != "" {
			refs = append(refs, p)
		}
	}
	return refs
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `go test ./pkg/gitinfo/ -run 'TestHistoryLog' -v`
Expected: PASS — all five tests.

- [ ] **Step 5: Confirm nothing else in the package regressed**

Run: `go test ./pkg/gitinfo/`
Expected: PASS (`ok`). Do not commit; see Global Constraints.

---

### Task 2: Divergence reader

Branch comparison needs both divergent commit lists and the merge base. Built on Task 1's reader rather than the existing `RangeLog`, because the compare UI shows an author per commit and `RangeLog` returns only hash, timestamp and subject — and extending a tested existing function is avoidable churn.

**Files:**
- Modify: `pkg/gitinfo/gitinfo.go` (append)
- Test: `pkg/gitinfo/gitinfo_test.go` (append)

**Interfaces:**
- Consumes: `HistoryLog` / `HistoryOpts` / `HistoryCommit` from Task 1.
- Produces: `gitinfo.GetDivergence(ctx context.Context, cwd, base, head string) (*Divergence, error)` and the `Divergence` type. Task 3 calls this.

- [ ] **Step 1: Write the failing test**

Append to `pkg/gitinfo/gitinfo_test.go`:

```go
// repoDiverged builds root -> shared, then main gains one commit and feature gains two, so the two
// branches have genuinely divergent commits and a merge base that is neither tip.
func repoDiverged(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	git := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
		cmd.Env = append(os.Environ(),
			"GIT_AUTHOR_NAME=dana k", "GIT_AUTHOR_EMAIL=dana@example.com",
			"GIT_COMMITTER_NAME=dana k", "GIT_COMMITTER_EMAIL=dana@example.com")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v: %s", args, err, out)
		}
	}
	commit := func(name, msg string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(dir, name), []byte(name+"\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		git("add", ".")
		git("commit", "-m", msg)
	}
	git("init", "--initial-branch=main")
	commit("root.txt", "root commit")
	git("checkout", "-b", "feature")
	commit("f1.txt", "feature one")
	commit("f2.txt", "feature two")
	git("checkout", "main")
	commit("m1.txt", "main one")
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go test ./pkg/gitinfo/ -run 'TestGetDivergence' -v`
Expected: FAIL — compile error, `undefined: GetDivergence`.

- [ ] **Step 3: Write the implementation**

Append to `pkg/gitinfo/gitinfo.go`:

```go
// Divergence is the two-sided answer to "how do these refs differ": the commits reachable from head
// but not base, the reverse, and the commit they share. Ahead/Behind are named from head's point of
// view. Commit lists are newest-first, matching HistoryLog.
type Divergence struct {
	Ahead     []HistoryCommit `json:"ahead"`
	Behind    []HistoryCommit `json:"behind"`
	MergeBase string          `json:"mergebase"`
	IsRepo    bool            `json:"isrepo"`
}

// GetDivergence compares two refs. The per-side commit lists come from HistoryLog over the symmetric
// ranges, so each commit carries an author — the compare view shows one per row.
func GetDivergence(ctx context.Context, cwd, base, head string) (*Divergence, error) {
	ahead, err := HistoryLog(ctx, cwd, HistoryOpts{Ref: base + ".." + head})
	if err != nil {
		return nil, err
	}
	if !ahead.IsRepo {
		return &Divergence{IsRepo: false}, nil
	}
	behind, err := HistoryLog(ctx, cwd, HistoryOpts{Ref: head + ".." + base})
	if err != nil {
		return nil, err
	}
	mbCtx, cancel := context.WithTimeout(ctx, gitTimeout)
	defer cancel()
	mb, err := run(mbCtx, cwd, "merge-base", base, head)
	if err != nil {
		return nil, err
	}
	return &Divergence{
		Ahead:     ahead.Commits,
		Behind:    behind.Commits,
		MergeBase: strings.TrimSpace(mb),
		IsRepo:    true,
	}, nil
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `go test ./pkg/gitinfo/ -run 'TestGetDivergence' -v`
Expected: PASS — all four tests.

- [ ] **Step 5: Confirm the package is still green**

Run: `go test ./pkg/gitinfo/`
Expected: PASS (`ok`).

---

### Task 3: Expose both reads over RPC

The typed RPC spine is split one file per domain. History and divergence get their own `GitCommands` domain rather than joining `ProjectCommands` — the surface is becoming repo-first, and the two existing git calls (`GitChangesCommand`, `GitDiffCommand`) stay where they are to avoid churn.

**Files:**
- Create: `pkg/wshrpc/wshrpctypes_git.go`
- Create: `pkg/wshrpc/wshserver/wshserver_git.go`
- Modify: `pkg/wshrpc/wshrpctypes.go` — add `GitCommands` to the `WshRpcInterface` composition at lines 35–52
- Generated, do not hand-edit: `frontend/app/store/wshclientapi.ts`, `pkg/wshrpc/wshclient/wshclient.go`, generated TS/Go type files

**Interfaces:**
- Consumes: `gitinfo.HistoryLog`, `gitinfo.HistoryOpts`, `gitinfo.History` (Task 1); `gitinfo.GetDivergence`, `gitinfo.Divergence` (Task 2).
- Produces: for the frontend, `RpcApi.GitHistoryCommand(TabRpcClient, {cwd, ref?, skip?, limit?, author?, grep?, path?})` returning `{commits, head, isrepo}`, and `RpcApi.GitDivergenceCommand(TabRpcClient, {cwd, base, head})` returning `{ahead, behind, mergebase, isrepo}`. Plan 2's history store calls both.

- [ ] **Step 1: Declare the domain interface and its payload types**

Create `pkg/wshrpc/wshrpctypes_git.go`:

```go
// pkg/wshrpc/wshrpctypes_git.go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshrpc

import (
	"context"

	"github.com/wavetermdev/waveterm/pkg/gitinfo"
)

// GitCommands is the repo-first read domain: commit history and ref comparison. The older
// GitChangesCommand / GitDiffCommand / GitRevertCommand live in ProjectCommands and stay there.
type GitCommands interface {
	GitHistoryCommand(ctx context.Context, data CommandGitHistoryData) (*CommandGitHistoryRtnData, error)
	GitDivergenceCommand(ctx context.Context, data CommandGitDivergenceData) (*CommandGitDivergenceRtnData, error)
}

type CommandGitHistoryData struct {
	Cwd string `json:"cwd"`
	// Ref is a revision or range; "" walks all refs. Skip/Limit paginate. Author/Grep/Path filter.
	Ref    string `json:"ref,omitempty"`
	Skip   int    `json:"skip,omitempty"`
	Limit  int    `json:"limit,omitempty"`
	Author string `json:"author,omitempty"`
	Grep   string `json:"grep,omitempty"`
	Path   string `json:"path,omitempty"`
}

type CommandGitHistoryRtnData struct {
	Commits []gitinfo.HistoryCommit `json:"commits"`
	Head    string                  `json:"head"`
	IsRepo  bool                    `json:"isrepo"`
}

type CommandGitDivergenceData struct {
	Cwd  string `json:"cwd"`
	Base string `json:"base"`
	Head string `json:"head"`
}

type CommandGitDivergenceRtnData struct {
	Ahead     []gitinfo.HistoryCommit `json:"ahead"`
	Behind    []gitinfo.HistoryCommit `json:"behind"`
	MergeBase string                  `json:"mergebase"`
	IsRepo    bool                    `json:"isrepo"`
}
```

- [ ] **Step 2: Add the domain to the composed interface**

In `pkg/wshrpc/wshrpctypes.go`, inside `type WshRpcInterface interface { … }` (lines 35–52), add `GitCommands` on its own line alongside the existing entries (`CoreCommands`, `BlockCommands`, `ConnCommands`, …, `AskCommands`, `WshRpcRemoteFileInterface`, `WshRpcFileInterface`).

- [ ] **Step 3: Implement the server side**

Create `pkg/wshrpc/wshserver/wshserver_git.go`:

```go
// pkg/wshrpc/wshserver/wshserver_git.go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"

	"github.com/wavetermdev/waveterm/pkg/gitinfo"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

func (ws *WshServer) GitHistoryCommand(ctx context.Context, data wshrpc.CommandGitHistoryData) (*wshrpc.CommandGitHistoryRtnData, error) {
	h, err := gitinfo.HistoryLog(ctx, data.Cwd, gitinfo.HistoryOpts{
		Ref:    data.Ref,
		Skip:   data.Skip,
		Limit:  data.Limit,
		Author: data.Author,
		Grep:   data.Grep,
		Path:   data.Path,
	})
	if err != nil {
		return nil, err
	}
	return &wshrpc.CommandGitHistoryRtnData{Commits: h.Commits, Head: h.Head, IsRepo: h.IsRepo}, nil
}

func (ws *WshServer) GitDivergenceCommand(ctx context.Context, data wshrpc.CommandGitDivergenceData) (*wshrpc.CommandGitDivergenceRtnData, error) {
	d, err := gitinfo.GetDivergence(ctx, data.Cwd, data.Base, data.Head)
	if err != nil {
		return nil, err
	}
	return &wshrpc.CommandGitDivergenceRtnData{
		Ahead: d.Ahead, Behind: d.Behind, MergeBase: d.MergeBase, IsRepo: d.IsRepo,
	}, nil
}
```

Confirm the receiver matches the existing convention in `wshserver_projects.go:68` and `:80` — `func (ws *WshServer) …` — and fix if it has since changed.

- [ ] **Step 4: Regenerate the bindings**

Run: `task generate`
Expected: exit 0, with `frontend/app/store/wshclientapi.ts` and `pkg/wshrpc/wshclient/wshclient.go` modified. Confirm `GitHistoryCommand` and `GitDivergenceCommand` now appear in `wshclientapi.ts`. Never hand-edit either file.

- [ ] **Step 5: Verify the Go side builds and the generated TypeScript typechecks**

Run, from the repo root in PowerShell:

```powershell
$env:CGO_CFLAGS = "-O2 -g -I$((Get-Location).Path -replace '\\','/')/pkg/jarvisembed/csrc"
go build ./pkg/wshrpc/... ; go vet ./pkg/wshrpc/wshserver/
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit
```

Expected: all three exit 0. The `CGO_CFLAGS` line is required — `pkg/wshrpc/wshserver` is one of six packages that otherwise fails with `sqlite3.h: No such file or directory`, and the `-I` path must be Windows-style.

---

### Task 4: Lane assignment

The mockup hardcodes a lane index per fixture commit. Real history has to be laid out from parent links. This is the core algorithm and it is pure — no DOM, no RPC.

**Files:**
- Create: `frontend/app/view/agents/gitgraph.ts`
- Test: `frontend/app/view/agents/gitgraph.test.ts`

**Interfaces:**
- Consumes: nothing — a pure module.
- Produces: `assignLanes(commits: GraphCommit[]): LanedRow[]` and `laneCount(rows: LanedRow[]): number`, plus the exported types `GraphCommit` and `LanedRow`. Task 5 consumes `LanedRow[]`.

- [ ] **Step 1: Write the failing test**

Create `frontend/app/view/agents/gitgraph.test.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { assignLanes, laneCount, type GraphCommit } from "./gitgraph";

const c = (hash: string, ...parents: string[]): GraphCommit => ({ hash, parents });

describe("assignLanes", () => {
    it("keeps a linear history in one lane", () => {
        const rows = assignLanes([c("a", "b"), c("b", "c"), c("c")]);
        expect(rows.map((r) => r.lane)).toEqual([0, 0, 0]);
        expect(laneCount(rows)).toBe(1);
    });

    it("puts a side branch in its own lane and rejoins at the merge base", () => {
        // m is a merge of a and b; both descend from c
        const rows = assignLanes([c("m", "a", "b"), c("a", "c"), c("b", "c"), c("c")]);
        expect(rows.map((r) => `${r.hash}:${r.lane}`)).toEqual(["m:0", "a:0", "b:1", "c:0"]);
        expect(laneCount(rows)).toBe(2);
    });

    it("flags merge commits by parent count", () => {
        const rows = assignLanes([c("m", "a", "b"), c("a", "c"), c("b", "c"), c("c")]);
        expect(rows.map((r) => r.merge)).toEqual([true, false, false, false]);
    });

    it("frees a lane at a root commit so a later branch reuses it", () => {
        // two disconnected roots: r1 ends, so r2 takes lane 0 rather than lane 1
        const rows = assignLanes([c("r1"), c("r2")]);
        expect(rows.map((r) => r.lane)).toEqual([0, 0]);
        expect(laneCount(rows)).toBe(1);
    });

    it("holds a lane open for a parent outside the loaded window", () => {
        // 'z' is never loaded; its lane stays reserved so a sibling does not steal it
        const rows = assignLanes([c("a", "z"), c("b", "y")]);
        expect(rows.map((r) => r.lane)).toEqual([0, 1]);
        expect(laneCount(rows)).toBe(2);
    });

    it("carries the original commit through unchanged", () => {
        const rows = assignLanes([c("a", "b"), c("b")]);
        expect(rows[0].hash).toBe("a");
        expect(rows[0].parents).toEqual(["b"]);
    });

    it("returns an empty result for empty input", () => {
        expect(assignLanes([])).toEqual([]);
        expect(laneCount([])).toBe(0);
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run frontend/app/view/agents/gitgraph.test.ts`
Expected: FAIL — cannot resolve `./gitgraph`.

- [ ] **Step 3: Write the implementation**

Create `frontend/app/view/agents/gitgraph.ts`:

```ts
// frontend/app/view/agents/gitgraph.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Lane assignment for a commit graph. Pure: takes commits newest-first with parent SHAs and decides
// which vertical lane each one occupies. Geometry (coordinates, paths, folding) is gitgraphgeom.ts.

export interface GraphCommit {
    hash: string;
    parents: string[];
    // set on the synthetic uncommitted row, which sits above the tip with HEAD as its only parent
    workingTree?: boolean;
    // a labelled separator drawn below this row (agent session start, run base)
    divider?: string;
    // dimmed: context from before the scope's anchor
    before?: boolean;
}

export interface LanedRow extends GraphCommit {
    lane: number;
    merge: boolean;
}

// A lane slot holds the hash it is waiting to draw next, or null when free. Reusing freed slots is
// what keeps a wide history from drifting rightwards forever.
type Slots = (string | null)[];

function claim(slots: Slots, hash: string): number {
    const existing = slots.indexOf(hash);
    if (existing !== -1) {
        return existing;
    }
    const free = slots.indexOf(null);
    if (free !== -1) {
        slots[free] = hash;
        return free;
    }
    slots.push(hash);
    return slots.length - 1;
}

export function assignLanes(commits: GraphCommit[]): LanedRow[] {
    const slots: Slots = [];
    const rows: LanedRow[] = [];
    for (const commit of commits) {
        let lane = slots.indexOf(commit.hash);
        if (lane === -1) {
            const free = slots.indexOf(null);
            lane = free !== -1 ? free : slots.length;
        }
        slots[lane] = commit.hash;
        // any lane further right waiting on this same commit merges into `lane` and frees up
        for (let i = lane + 1; i < slots.length; i++) {
            if (slots[i] === commit.hash) {
                slots[i] = null;
            }
        }
        rows.push({ ...commit, lane, merge: commit.parents.length > 1 });
        if (commit.parents.length === 0) {
            slots[lane] = null;
        } else {
            // the first parent continues down this lane; the rest take their own
            slots[lane] = commit.parents[0];
            for (let i = 1; i < commit.parents.length; i++) {
                claim(slots, commit.parents[i]);
            }
        }
        while (slots.length > 0 && slots[slots.length - 1] === null) {
            slots.pop();
        }
    }
    return rows;
}

export function laneCount(rows: LanedRow[]): number {
    return rows.reduce((max, r) => Math.max(max, r.lane + 1), 0);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run frontend/app/view/agents/gitgraph.test.ts`
Expected: PASS — all seven cases.

---

### Task 5: Graph geometry and lane folding

Turns laned rows into SVG coordinates. Mirrors the mockup's `buildGraph` numbers (15px lanes, 13px left pad, 13px corner radius, 30px divider height, 4.5/5.5px node radii) but returns lane *indices* and flags rather than CSS colour strings, so colour stays in the component and theming keeps working.

**Files:**
- Create: `frontend/app/view/agents/gitgraphgeom.ts`
- Test: `frontend/app/view/agents/gitgraphgeom.test.ts`

**Interfaces:**
- Consumes: `LanedRow` from Task 4 (`./gitgraph`).
- Produces: `graphGeometry(rows: LanedRow[], opts: GeometryOpts): GraphGeometry`, plus `GeometryOpts`, `GraphGeometry`, `GraphEdge`, `GraphNode`. Plan 2's history pane renders these.

- [ ] **Step 1: Write the failing test**

Create `frontend/app/view/agents/gitgraphgeom.test.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { assignLanes, type GraphCommit } from "./gitgraph";
import { graphGeometry } from "./gitgraphgeom";

const c = (hash: string, ...parents: string[]): GraphCommit => ({ hash, parents });
const OPTS = { rowH: 34, maxLanes: 7 };

describe("graphGeometry", () => {
    it("draws a straight segment between commits in the same lane", () => {
        const g = graphGeometry(assignLanes([c("a", "b"), c("b")]), OPTS);
        expect(g.edges).toHaveLength(1);
        // same lane => a plain move-line, no curve
        expect(g.edges[0].d).toBe("M13 17 L13 51");
        expect(g.edges[0].d).not.toContain("Q");
    });

    it("curves a segment that crosses lanes", () => {
        const g = graphGeometry(assignLanes([c("m", "a", "b"), c("a", "c"), c("b", "c"), c("c")]), OPTS);
        const crossing = g.edges.filter((e) => e.d.includes("Q"));
        expect(crossing.length).toBeGreaterThan(0);
    });

    it("skips a parent that is outside the loaded window", () => {
        const g = graphGeometry(assignLanes([c("a", "notloaded")]), OPTS);
        expect(g.edges).toHaveLength(0);
        expect(g.nodes).toHaveLength(1);
    });

    it("gives a merge node a larger radius", () => {
        const g = graphGeometry(assignLanes([c("m", "a", "b"), c("a", "c"), c("b", "c"), c("c")]), OPTS);
        expect(g.nodes[0].r).toBeGreaterThan(g.nodes[1].r);
    });

    it("derives gutter width from the lane cap, not the lane count", () => {
        const linear = graphGeometry(assignLanes([c("a", "b"), c("b")]), { rowH: 34, maxLanes: 1 });
        expect(linear.gutter).toBe(13 + 1 * 15 + 4);
        const wide = graphGeometry(assignLanes([c("a", "b"), c("b")]), { rowH: 34, maxLanes: 7 });
        expect(wide.gutter).toBeGreaterThan(linear.gutter);
    });

    it("folds lanes past the cap and counts them", () => {
        // six commits each on their own lane; cap at 3 so three fold
        const rows = assignLanes([c("a", "p1"), c("b", "p2"), c("c", "p3"), c("d", "p4"), c("e", "p5"), c("f", "p6")]);
        const g = graphGeometry(rows, { rowH: 34, maxLanes: 3 });
        expect(g.foldedCount).toBe(3);
        const xs = g.nodes.map((n) => n.x);
        // folded nodes clamp to the last drawable lane rather than running off the gutter
        expect(Math.max(...xs)).toBe(13 + 2 * 15);
        expect(g.nodes.filter((n) => n.folded)).toHaveLength(3);
    });

    it("adds divider height to the row below and to the total", () => {
        const plain = graphGeometry(assignLanes([c("a", "b"), c("b")]), OPTS);
        const withDiv = graphGeometry(
            assignLanes([{ hash: "a", parents: ["b"], divider: "session start" }, c("b")]),
            OPTS
        );
        expect(withDiv.height).toBe(plain.height + 30);
        expect(withDiv.nodes[1].y).toBe(plain.nodes[1].y + 30);
    });

    it("marks the working-tree row's edge as dashed", () => {
        const g = graphGeometry(
            assignLanes([{ hash: "wt", parents: ["a"], workingTree: true }, c("a")]),
            OPTS
        );
        expect(g.edges[0].dashed).toBe(true);
        expect(g.nodes[0].workingTree).toBe(true);
    });

    it("returns zero-size geometry for no rows", () => {
        const g = graphGeometry([], OPTS);
        expect(g.edges).toEqual([]);
        expect(g.nodes).toEqual([]);
        expect(g.foldedCount).toBe(0);
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run frontend/app/view/agents/gitgraphgeom.test.ts`
Expected: FAIL — cannot resolve `./gitgraphgeom`.

- [ ] **Step 3: Write the implementation**

Create `frontend/app/view/agents/gitgraphgeom.ts`:

```ts
// frontend/app/view/agents/gitgraphgeom.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// SVG geometry for the commit graph gutter. Pure. Returns lane indices and flags, never colours —
// the component maps lane -> --color-graphlane-N so runtime theming still applies.

import type { LanedRow } from "./gitgraph";

const LANE_W = 15;
const PAD_L = 13;
const CURVE = 13;
const DIVIDER_H = 30;
const NODE_R = 4.5;
const MERGE_R = 5.5;
const BOTTOM_PAD = 8;

export interface GeometryOpts {
    rowH: number;
    // lanes past this fold into the last drawable column; keeps a 9-lane repo inside a fixed gutter
    maxLanes: number;
}

export interface GraphEdge {
    d: string;
    // lane the segment is tinted by — the leftmost of the two it joins
    lane: number;
    folded: boolean;
    dashed: boolean;
}

export interface GraphNode {
    x: number;
    y: number;
    r: number;
    lane: number;
    merge: boolean;
    folded: boolean;
    workingTree: boolean;
}

export interface GraphGeometry {
    width: number;
    height: number;
    gutter: number;
    edges: GraphEdge[];
    nodes: GraphNode[];
    foldedCount: number;
}

function edgePath(x1: number, y1: number, x2: number, y2: number): string {
    if (x1 === x2) {
        return `M${x1} ${y1} L${x2} ${y2}`;
    }
    const dir = x2 > x1 ? 1 : -1;
    return `M${x1} ${y1} L${x1} ${y2 - CURVE} Q${x1} ${y2} ${x1 + dir * CURVE} ${y2} L${x2} ${y2}`;
}

export function graphGeometry(rows: LanedRow[], opts: GeometryOpts): GraphGeometry {
    const { rowH, maxLanes } = opts;
    const lastLane = Math.max(0, maxLanes - 1);

    // row tops, so a divider under row i pushes everything below it down
    const tops: number[] = [];
    let acc = 0;
    for (const r of rows) {
        tops.push(acc);
        acc += rowH + (r.divider ? DIVIDER_H : 0);
    }

    const rowOf = new Map<string, number>();
    rows.forEach((r, i) => {
        if (r.hash) {
            rowOf.set(r.hash, i);
        }
    });

    const x = (lane: number) => PAD_L + Math.min(lane, lastLane) * LANE_W;
    const y = (i: number) => tops[i] + rowH / 2;

    const edges: GraphEdge[] = [];
    const nodes: GraphNode[] = [];
    let foldedCount = 0;

    rows.forEach((row, i) => {
        const folded = row.lane > lastLane;
        if (folded) {
            foldedCount++;
        }
        const x1 = x(row.lane);
        const y1 = y(i);
        for (const parent of row.parents) {
            const pi = rowOf.get(parent);
            if (pi === undefined) {
                continue; // parent not in this page; the lane stays reserved but nothing is drawn
            }
            const par = rows[pi];
            edges.push({
                d: edgePath(x1, y1, x(par.lane), y(pi)),
                lane: Math.min(row.lane, par.lane),
                folded: folded || par.lane > lastLane,
                dashed: !!row.workingTree,
            });
        }
        nodes.push({
            x: x1,
            y: y1,
            r: row.merge ? MERGE_R : NODE_R,
            lane: row.lane,
            merge: row.merge,
            folded,
            workingTree: !!row.workingTree,
        });
    });

    const gutter = PAD_L + maxLanes * LANE_W + 4;
    return { width: gutter, height: rows.length === 0 ? 0 : acc + BOTTOM_PAD, gutter, edges, nodes, foldedCount };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run frontend/app/view/agents/gitgraphgeom.test.ts`
Expected: PASS — all nine cases.

- [ ] **Step 5: Typecheck both new frontend modules**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0. Baseline is clean, so any reported error belongs to this task.

- [ ] **Step 6: Report for review — do not commit**

Summarise: the five Go tests and four divergence tests passing, the two new RPC commands present in the regenerated `frontend/app/store/wshclientapi.ts`, and the sixteen frontend cases passing. Then stop and hand back for the single end-of-work commit, which needs explicit approval.

---

## Not in this plan

Deliberately deferred so each plan produces working software on its own:

- **Plan 2 — surface restructure.** Three panes at 460 / 300 / remainder, scope pills replacing the source dropdown, ref expression, history rows with the graph gutter, commit detail pane, wiring the existing changed-file and diff panes to commit selection, adding `--color-graphlane-1..6` plus `--color-graphlane-fold` to `frontend/tailwindsetup.css`, and removing Review mode (see Resolved decisions).
- **Plan 3 — branch compare state**, on top of Task 2's divergence reader.
- **Plan 4 — remaining states**: filters, pagination and loading, "not a repository" versus "read failed", state persistence across surface unmount, narrow-width folding, keyboard map, and a CDP `verify:ui` scenario.

## Resolved decisions

**Read-only scope holds, and Review mode is deleted (decided 2026-07-31).** The mockup is implemented as drawn; no design revision is needed.

Review mode was the hunk-level accept/reject workflow: `reviewstore.ts`'s `rejectedPatchPlan()` turned per-hunk *reject* decisions into revert operations sent through `RpcApi.GitRevertCommand`. The case for keeping it was that rejecting an agent's changes is review rather than authoring. The case against, which won: its mode lived in component state (`filessurface.tsx:299`, `useState<"browse" | "review">("browse")`) and so reset to Browse on every surface unmount, making the workflow one you could never stay in; it had no Chrome-DevTools-Protocol verification scenario; the new history view subsumes most of its value once an agent's commits and diffs are visible; and keeping it as a mode would partially revert the design's central move of collapsing two modes onto one time axis.

**What plan 2 removes:** `frontend/app/view/agents/reviewsurface.tsx` (the accept/reject UI), `reviewstore.ts` (decision model and reject-to-revert planner), `reviewstore.test.ts`, and the `modeState` / segmented-control block in `filessurface.tsx`. Recoverable from git history if it is ever wanted back.

**Consequent sub-decision for plan 2:** removing the frontend orphans the revert backend — `GitRevertCommand` in `wshrpctypes_projects.go` and `wshserver_projects.go`, and `RevertFile` / `RevertHunk` in `pkg/gitinfo` (both covered by `TestRevertFileSubdir` and `TestRevertHunkSubdir`). Recommendation: delete the frontend now and leave the Go revert path in place as a **documented cleanup candidate**, following the precedent already set for the orphaned standalone WaveAI chat block. Removing tested Go code in the same change would widen plan 2's blast radius for no user-visible gain.
