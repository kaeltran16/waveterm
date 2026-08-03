# Branch Comparison Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status: shipped.** Executed and merged 2026-07-31 as commit `cea7ec8a` (the repo's current HEAD). The checkboxes below were ticked retroactively on 2026-08-03 — the worker never marked them during execution, so git history is the authoritative record. The one-off Chrome-DevTools-Protocol screenshot step is backed by `cdp-shots/compare-1-history.png` through `compare-6-back.png` and `cmp-a-aggregate.png` through `cmp-e-exit.png`, captured 2026-07-31 15:58–17:01. Re-verified 2026-08-03: `go test ./pkg/gitinfo/` passes and the six git-module vitest files pass (64 cases), including the 17 branch-comparison row cases in `comparerows.test.ts`.

**Goal:** Give the Diff surface a branch-comparison state — two labelled divergent commit lists, the merge base, and the aggregate file diff between two refs — driven by an editable two-ref control in the subject bar.

**Architecture:** Compare is a two-ref variant of the surface's existing repo scope, not a new surface and not a mode. Entering it swaps the left column (`comparecolumn.tsx`) and the middle pane (`aggregatepane.tsx`); the right-hand diff pane is untouched and shared with history. Three new Go readers back it, two new RPC commands expose them, and one already-shipped-but-uncalled command (`GitDivergenceCommand`) finally gets its caller.

**Tech Stack:** Go (`pkg/gitinfo`, `pkg/wshrpc`), wshrpc codegen via `task generate`, React 19 + jotai + Tailwind 4 (`frontend/app/view/agents/`), vitest for frontend unit tests, Go table tests for the readers.

**Spec:** `docs/superpowers/specs/2026-07-31-git-branch-comparison-design.md`. Read it before starting — the six numbered decisions there are the *why* behind choices this plan states without re-arguing.

**Design source:** `wave-handoff/wave/project/Wave-git-review.dc.html`, the `compare` state — markup at lines 373–450, design notes at line 935, hint footer at line 908.

## Global Constraints

- **Never hand-edit generated files.** `frontend/app/store/wshclientapi.ts`, `frontend/types/gotypes.d.ts` and `pkg/wshrpc/wshclient/wshclient.go` are produced by `task generate`. Edit the Go definitions and regenerate.
- **No raw colours.** Every colour is a `@theme` token from `frontend/tailwindsetup.css` used through a Tailwind utility. A hex or `rgba()` in a component silently opts out of runtime theming.
- **No new SCSS.** Tailwind only.
- **Typecheck with the stack-size flag:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`. Bare `npx tsc` stack-overflows on this repo, which also means `task check:ts` is broken. The baseline is clean (exit 0), so any error it reports is yours.
- **Go tests need the vendored sqlite header** on a bare `go test ./pkg/...`. For `pkg/gitinfo` alone this does not bite, so prefer `go test ./pkg/gitinfo/...`. If you must run the whole tree, set from PowerShell at the repo root: `$env:CGO_CFLAGS = "-O2 -g -I$((Get-Location).Path -replace '\\','/')/pkg/jarvisembed/csrc"`.
- **Do not commit.** The whole plan lands as **one commit at the end, with explicit user approval** (project rule: batch into one commit; the spec doc folds into that same commit rather than getting its own). Tasks end with verification, not `git commit`.
- **Windows-only build.** Paths in the surface are joined with backslashes via the existing `joinPath` helper.

---

### Task 1: The three commit-range readers in Go

**Files:**
- Modify: `pkg/gitinfo/gitinfo.go` (add after `CommitDiff`, which ends the file at line 703)
- Test: `pkg/gitinfo/gitinfo_test.go` (append)

**Interfaces:**
- Consumes: the package's existing `run`, `nameStatusToStatusZ`, `gitTimeout`, and the `Changes` / `Diff` structs; the test fixtures `gitAuthored`, `commitAuthored`, `repoDiverged`.
- Produces: `gitinfo.CompareChanges(ctx, cwd, base, head string) (*Changes, error)`, `gitinfo.CompareDiff(ctx, cwd, base, head, path string) (*Diff, error)`, `gitinfo.DefaultBranch(ctx, cwd string) (string, error)`. Task 2 wraps all three in RPC commands.

- [x] **Step 1: Write the failing tests**

Append to `pkg/gitinfo/gitinfo_test.go`. `repoDiverged` (already at line 880) builds exactly what these need: `main` has the root commit plus `m1.txt`, `feature` has the root commit plus `f1.txt` and `f2.txt`.

```go
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
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `go test ./pkg/gitinfo/... -run "Compare|DefaultBranch" -v`

Expected: FAIL — the package does not compile, because `CompareChanges`, `CompareDiff` and `DefaultBranch` are undefined.

- [x] **Step 3: Implement the three readers**

Append to `pkg/gitinfo/gitinfo.go`:

```go
// CompareChanges returns the per-file changes head introduces relative to base, anchored at their
// merge base (three-dot). The two-dot form would fold in the base side's own commits inverted — their
// additions appearing as deletions — so the file list would match neither side of the compare column.
// Never consults the working tree. Paths are cwd-relative (--relative), matching the rest of the
// package, so parseGitChanges on the frontend handles this shape unchanged. IsRepo=false when cwd is
// not a repo; a git failure errors so the caller can name the ref that did not resolve.
func CompareChanges(ctx context.Context, cwd, base, head string) (*Changes, error) {
	ctx, cancel := context.WithTimeout(ctx, gitTimeout)
	defer cancel()
	inside, err := run(ctx, cwd, "rev-parse", "--is-inside-work-tree")
	if err != nil || strings.TrimSpace(inside) != "true" {
		return &Changes{IsRepo: false}, nil
	}
	spec := base + "..." + head
	nameStatus, err := run(ctx, cwd, "diff", "--name-status", "-z", "--relative", spec)
	if err != nil {
		return nil, err
	}
	numstat, err := run(ctx, cwd, "diff", "--numstat", "--relative", spec)
	if err != nil {
		return nil, err
	}
	return &Changes{StatusZ: nameStatusToStatusZ(nameStatus), Numstat: numstat, IsRepo: true}, nil
}

// CompareDiff returns one file's unified diff between base and head, anchored at their merge base so
// it agrees with CompareChanges. The Diff shape is shared with GetDiff and CommitDiff so the frontend
// parses all three the same way; Untracked is never set, because a two-ref diff has no working tree.
func CompareDiff(ctx context.Context, cwd, base, head, path string) (*Diff, error) {
	ctx, cancel := context.WithTimeout(ctx, gitTimeout)
	defer cancel()
	diff, err := run(ctx, cwd, "diff", base+"..."+head, "--", path)
	if err != nil {
		return nil, err
	}
	return &Diff{Diff: diff}, nil
}

// DefaultBranch resolves the repo's default branch as a *local* branch name: origin/HEAD when the
// remote publishes it, else a probe of main then master. Returns "" (not an error) when none resolve,
// so the compare ref picker opens with an empty base field instead of an error the user cannot act on
// — the same degrade-quietly contract ListBranches uses for a non-repo.
//
// Local-name-only is deliberate: the picker's suggestions come from ListBranches, which reads
// refs/heads, so returning "origin/main" would offer a base the suggestion list cannot show. The cost
// is that a stale local main overstates divergence; the deferred Fetch control is the answer to that.
func DefaultBranch(ctx context.Context, cwd string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, gitTimeout)
	defer cancel()
	if out, err := run(ctx, cwd, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"); err == nil {
		if name := strings.TrimSpace(out); name != "" {
			return strings.TrimPrefix(name, "origin/"), nil
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

- [x] **Step 4: Run the tests to verify they pass**

Run: `go test ./pkg/gitinfo/... -run "Compare|DefaultBranch" -v`

Expected: PASS, nine tests. Then run the whole package to prove nothing regressed: `go test ./pkg/gitinfo/...` — expected PASS.

---

### Task 2: Expose the readers over RPC

**Files:**
- Modify: `pkg/wshrpc/wshrpctypes_git.go` (add two methods to the `GitCommands` interface, four types)
- Modify: `pkg/wshrpc/wshserver/wshserver_git.go` (two handlers, appended)
- Modify: `pkg/wshrpc/wshrpctypes_projects.go:40-42` (one field on `CommandListBranchesRtnData`)
- Modify: `pkg/wshrpc/wshserver/wshserver_projects.go:68-79` (populate that field)
- Regenerated, never hand-edited: `frontend/app/store/wshclientapi.ts`, `frontend/types/gotypes.d.ts`, `pkg/wshrpc/wshclient/wshclient.go`

**Interfaces:**
- Consumes: Task 1's `gitinfo.CompareChanges`, `gitinfo.CompareDiff`, `gitinfo.DefaultBranch`.
- Produces: `RpcApi.GitCompareChangesCommand(TabRpcClient, {cwd, base, head})` → `{statusz, numstat, isrepo}`; `RpcApi.GitCompareDiffCommand(TabRpcClient, {cwd, base, head, path})` → `{diff}`; and a `default` field on the existing `ListBranchesCommand` return. Task 4's store calls all three.

- [x] **Step 1: Add the two commands to the git domain**

In `pkg/wshrpc/wshrpctypes_git.go`, add to the `GitCommands` interface, after `GitCommitDiffCommand`:

```go
	GitCompareChangesCommand(ctx context.Context, data CommandGitCompareChangesData) (*CommandGitCompareChangesRtnData, error)
	GitCompareDiffCommand(ctx context.Context, data CommandGitCompareDiffData) (*CommandGitCompareDiffRtnData, error)
```

and append the four types at the end of the file:

```go
type CommandGitCompareChangesData struct {
	Cwd  string `json:"cwd"`
	Base string `json:"base"`
	Head string `json:"head"`
}

// Mirrors CommandGitCommitChangesRtnData: an aggregate is a change set like any other, so one
// frontend parser (parseGitChanges) serves the working tree, a single commit, and a two-ref range.
type CommandGitCompareChangesRtnData struct {
	StatusZ string `json:"statusz"`
	Numstat string `json:"numstat"`
	IsRepo  bool   `json:"isrepo"`
}

type CommandGitCompareDiffData struct {
	Cwd  string `json:"cwd"`
	Base string `json:"base"`
	Head string `json:"head"`
	Path string `json:"path"`
}

type CommandGitCompareDiffRtnData struct {
	Diff string `json:"diff"`
}
```

- [x] **Step 2: Add the two handlers**

Append to `pkg/wshrpc/wshserver/wshserver_git.go`:

```go
func (ws *WshServer) GitCompareChangesCommand(ctx context.Context, data wshrpc.CommandGitCompareChangesData) (*wshrpc.CommandGitCompareChangesRtnData, error) {
	ch, err := gitinfo.CompareChanges(ctx, data.Cwd, data.Base, data.Head)
	if err != nil {
		return nil, err
	}
	return &wshrpc.CommandGitCompareChangesRtnData{StatusZ: ch.StatusZ, Numstat: ch.Numstat, IsRepo: ch.IsRepo}, nil
}

func (ws *WshServer) GitCompareDiffCommand(ctx context.Context, data wshrpc.CommandGitCompareDiffData) (*wshrpc.CommandGitCompareDiffRtnData, error) {
	d, err := gitinfo.CompareDiff(ctx, data.Cwd, data.Base, data.Head, data.Path)
	if err != nil {
		return nil, err
	}
	return &wshrpc.CommandGitCompareDiffRtnData{Diff: d.Diff}, nil
}
```

- [x] **Step 3: Add the default-branch field to the branches command**

In `pkg/wshrpc/wshrpctypes_projects.go`, change `CommandListBranchesRtnData` (currently lines 40-42) to:

```go
type CommandListBranchesRtnData struct {
	Branches []BranchInfo `json:"branches"`
	// The repo's default branch as a local name, for the compare ref picker's base field. Additive:
	// the New Agent launcher calls this command for its worktree-branch suggestions and ignores it.
	// "" when the repo publishes no origin/HEAD and has neither main nor master.
	Default string `json:"default,omitempty"`
}
```

In `pkg/wshrpc/wshserver/wshserver_projects.go`, in `ListBranchesCommand`, populate it. The whole handler becomes:

```go
func (ws *WshServer) ListBranchesCommand(ctx context.Context, data wshrpc.CommandListBranchesData) (wshrpc.CommandListBranchesRtnData, error) {
	branches, err := gitinfo.ListBranches(ctx, data.ProjectPath)
	if err != nil {
		return wshrpc.CommandListBranchesRtnData{}, err
	}
	rtn := wshrpc.CommandListBranchesRtnData{Branches: make([]wshrpc.BranchInfo, 0, len(branches))}
	for _, b := range branches {
		rtn.Branches = append(rtn.Branches, wshrpc.BranchInfo{Name: b.Name, Age: b.Age})
	}
	// A repo with no resolvable default is not an error here — DefaultBranch returns "" and the
	// picker's base field just opens empty.
	rtn.Default, _ = gitinfo.DefaultBranch(ctx, data.ProjectPath)
	return rtn, nil
}
```

- [x] **Step 4: Regenerate the bindings**

Run: `task generate`

Expected: exit 0, and `frontend/app/store/wshclientapi.ts`, `frontend/types/gotypes.d.ts`, `pkg/wshrpc/wshclient/wshclient.go` change. Do not edit any of the three by hand.

- [x] **Step 5: Verify the generated surface and that the Go tree builds**

Run:

```bash
grep -c "GitCompareChangesCommand\|GitCompareDiffCommand" frontend/app/store/wshclientapi.ts
grep -n "default?" frontend/types/gotypes.d.ts | grep -i branch
go build ./...
go test ./pkg/gitinfo/... ./pkg/wshrpc/...
```

Expected: the first prints `2` or more; the second shows `default?: string` on the branches return type; `go build` and both test packages pass. If the grep on `wshclientapi.ts` prints `0`, `task generate` did not pick up the interface change — check that both methods are on the `GitCommands` interface and rerun.

---

### Task 3: The compare row model

**Files:**
- Create: `frontend/app/view/agents/comparerows.ts`
- Test: `frontend/app/view/agents/comparerows.test.ts`
- Modify: `frontend/app/view/agents/historyrows.ts` (extract `toRow` out of `buildRows` so both row models classify refs and format age identically)

**Interfaces:**
- Consumes: `HistoryCommit` and `BranchInfo` (global generated types, no import needed); `GitChanges` from `./gitstatus`; `HistoryRow`, `RefChip`, `classifyRef` from `./historyrows`.
- Produces: `AGGREGATE`, `CompareSide`, `CompareRow` (union of `CompareAggregateRow` | `CompareHeaderRow` | `CompareCommitRow`), `SIDE_DOT`, `SIDE_TEXT`, `buildCompareRows(opts)`, `compareNavIds(rows)`, `sideJumpTarget(rows, fromId)`. Also `toRow(commit, now)` newly exported from `historyrows.ts`. Tasks 4, 6 and 8 consume these; `CompareCommitRow` extends `HistoryRow` specifically so Task 8 can hand a selected compare commit straight to the shipped `CommitPane` with no adapter.

- [x] **Step 1: Extract the shared commit-to-row mapper**

In `frontend/app/view/agents/historyrows.ts`, add `toRow` above `buildRows` and rewrite `buildRows`'s `map` to use it. Replace lines 106–119 (`export function buildRows` through the close of the `.map`) with:

```ts
// One commit -> one row, with no scope-anchor decoration. buildRows layers divider/before on top;
// comparerows.ts reuses it unchanged, so the history pane and the compare column classify refs and
// format ages through exactly one code path.
export function toRow(c: HistoryCommit, now: number): HistoryRow {
    return {
        hash: c.hash,
        parents: c.parents ?? [],
        subject: c.subject,
        author: c.author,
        email: c.email,
        ts: c.ts,
        when: ageLabel(c.ts, now),
        refs: (c.refs ?? []).map(classifyRef).filter((r): r is RefChip => r != null),
        before: false,
    };
}

export function buildRows(commits: HistoryCommit[], opts: BuildRowsOpts): HistoryRow[] {
    const anchorIdx = opts.anchor ? commits.findIndex((c) => c.hash === opts.anchor) : -1;
    const rows: HistoryRow[] = commits.map((c, i) => ({
        ...toRow(c, opts.now),
        divider: anchorIdx >= 0 && i === anchorIdx ? opts.anchorLabel : undefined,
        before: anchorIdx >= 0 && i > anchorIdx,
    }));
```

Leave the rest of `buildRows` (the `dirtyFileCount` guard and the `rows.unshift` of the working-tree row, lines 120–139) exactly as it is.

- [x] **Step 2: Confirm the extraction changed no behaviour**

Run: `npx vitest run frontend/app/view/agents/historyrows.test.ts`

Expected: PASS, all thirteen existing cases. This is a pure refactor — if any case fails, `toRow` differs from the inline mapping it replaced.

- [x] **Step 3: Write the failing test for the compare row model**

Create `frontend/app/view/agents/comparerows.test.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { AGGREGATE, buildCompareRows, compareNavIds, sideJumpTarget, type CompareRow } from "./comparerows";
import type { GitChanges } from "./gitstatus";

const NOW = 1_700_000_000_000;

function commit(hash: string, subject: string, agoMs = 3_600_000): HistoryCommit {
    return {
        hash,
        parents: [],
        subject,
        author: "dana k",
        email: "dana@example.com",
        ts: NOW - agoMs,
        refs: [],
    } as HistoryCommit;
}

const AGG: GitChanges = {
    files: [
        { path: "src/a.ts", status: "M", adds: 10, dels: 2 },
        { path: "src/b.ts", status: "A", adds: 4, dels: 0 },
    ],
    adds: 14,
    dels: 2,
};

function rows(over: Partial<Parameters<typeof buildCompareRows>[0]> = {}): CompareRow[] {
    return buildCompareRows({
        base: "main",
        head: "feature/idem",
        ahead: [commit("aaa1111", "feature two"), commit("aaa2222", "feature one")],
        behind: [commit("bbb1111", "main one")],
        aggregate: AGG,
        now: NOW,
        ...over,
    });
}

describe("buildCompareRows", () => {
    it("puts the aggregate first, then head's group, then base's", () => {
        expect(rows().map((r) => r.kind)).toEqual([
            "aggregate",
            "header",
            "commit",
            "commit",
            "header",
            "commit",
        ]);
    });

    it("labels each header with its ref, side and count", () => {
        const [, headHeader, , , baseHeader] = rows();
        expect(headHeader).toMatchObject({ kind: "header", side: "head", ref: "feature/idem", count: 2 });
        expect(baseHeader).toMatchObject({ kind: "header", side: "base", ref: "main", count: 1 });
        expect((headHeader as any).note).toBe("2 ahead");
        expect((baseHeader as any).note).toBe("1 behind");
    });

    it("carries the aggregate's file count and totals on the aggregate row", () => {
        expect(rows()[0]).toMatchObject({ kind: "aggregate", id: AGGREGATE, files: 2, adds: 14, dels: 2 });
    });

    it("shows the aggregate row as pending when the aggregate has not loaded", () => {
        expect(rows({ aggregate: null })[0]).toMatchObject({ kind: "aggregate", files: null });
    });

    it("tags every commit row with its side and keeps HistoryRow fields", () => {
        const commits = rows().filter((r) => r.kind === "commit") as any[];
        expect(commits.map((c) => c.side)).toEqual(["head", "head", "base"]);
        expect(commits[0]).toMatchObject({ hash: "aaa1111", subject: "feature two", author: "dana k" });
        expect(commits[0].when).toBe("1h"); // formatted through historyrows' shared mapper
        expect(commits[0].refs).toEqual([]);
    });

    it("omits a side's header entirely when that side has no commits", () => {
        const only = rows({ behind: [] });
        expect(only.filter((r) => r.kind === "header")).toHaveLength(1);
        expect(only.map((r) => r.kind)).toEqual(["aggregate", "header", "commit", "commit"]);
    });

    it("still yields the aggregate row when neither side diverges", () => {
        expect(rows({ ahead: [], behind: [] }).map((r) => r.kind)).toEqual(["aggregate"]);
    });
});

describe("compareNavIds", () => {
    it("lists the aggregate and every commit, excluding headers, in column order", () => {
        expect(compareNavIds(rows())).toEqual([AGGREGATE, "aaa1111", "aaa2222", "bbb1111"]);
    });

    it("is just the aggregate when nothing diverges", () => {
        expect(compareNavIds(rows({ ahead: [], behind: [] }))).toEqual([AGGREGATE]);
    });
});

describe("sideJumpTarget", () => {
    it("goes from the aggregate to head's first commit", () => {
        expect(sideJumpTarget(rows(), AGGREGATE)).toBe("aaa1111");
    });

    it("crosses from a head commit to base's first commit", () => {
        expect(sideJumpTarget(rows(), "aaa2222")).toBe("bbb1111");
    });

    it("crosses back from a base commit to head's first commit", () => {
        expect(sideJumpTarget(rows(), "bbb1111")).toBe("aaa1111");
    });

    it("returns null when the other side has no commits", () => {
        expect(sideJumpTarget(rows({ behind: [] }), "aaa1111")).toBeNull();
    });

    it("returns null for an unknown row id", () => {
        expect(sideJumpTarget(rows(), "nope")).toBeNull();
    });
});
```

- [x] **Step 4: Run the test to verify it fails**

Run: `npx vitest run frontend/app/view/agents/comparerows.test.ts`

Expected: FAIL — cannot resolve `./comparerows`.

- [x] **Step 5: Write the module**

Create `frontend/app/view/agents/comparerows.ts`:

```ts
// frontend/app/view/agents/comparerows.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pure: a divergence read -> the rows the compare column draws. The aggregate is row zero of the
// column rather than a separate control, mirroring how the working tree is row zero of the history —
// so "back to the aggregate" is just a selection, with no gesture and no key whose meaning depends
// on invisible state. Selection order, side colouring and the Tab jump all live here so the column
// stays a renderer.

import { toRow, type HistoryRow } from "./historyrows";
import type { GitChanges } from "./gitstatus";

// Sentinel id for the aggregate row. Deliberately non-empty and deliberately NOT history's
// WORKING_TREE (""): the two row models stay independent, so nothing has to reason about whether an
// empty id means the working tree or the aggregate.
export const AGGREGATE = "__aggregate__";

// "head" is the ref whose commits the aggregate diff describes; "base" is what it is measured against.
export type CompareSide = "head" | "base";

export interface CompareAggregateRow {
    kind: "aggregate";
    id: typeof AGGREGATE;
    // null while the aggregate read is still in flight, so the row can render pending rather than "0 files"
    files: number | null;
    adds: number;
    dels: number;
}

export interface CompareHeaderRow {
    kind: "header";
    id: string; // "header:head" | "header:base" — never navigable, so it only needs to be unique
    side: CompareSide;
    ref: string;
    note: string; // "3 ahead" / "5 behind"
    count: number;
}

// Extends HistoryRow so a selected compare commit can be handed straight to the shipped CommitPane
// with no adapter — the divergence lists come from HistoryLog, so they carry everything a row needs.
export interface CompareCommitRow extends HistoryRow {
    kind: "commit";
    id: string; // the commit hash
    side: CompareSide;
}

export type CompareRow = CompareAggregateRow | CompareHeaderRow | CompareCommitRow;

// Positional lane hues from the shipped graph palette — head green, base blue, the mockup's own two
// colours. Positional, never identity: nothing is claimed by a colour.
export const SIDE_TEXT: Record<CompareSide, string> = {
    head: "text-graphlane-2",
    base: "text-graphlane-1",
};
export const SIDE_DOT: Record<CompareSide, string> = {
    head: "bg-graphlane-2",
    base: "bg-graphlane-1",
};

export interface BuildCompareRowsOpts {
    base: string;
    head: string;
    // commits on head but not base, newest first (Divergence.Ahead)
    ahead: HistoryCommit[];
    // commits on base but not head, newest first (Divergence.Behind)
    behind: HistoryCommit[];
    // null while the aggregate read is in flight
    aggregate: GitChanges | null;
    now: number;
}

function sideRows(commits: HistoryCommit[], side: CompareSide, ref: string, now: number): CompareRow[] {
    if (commits.length === 0) {
        return []; // no header for an empty side: an empty labelled group reads as a failed read
    }
    const header: CompareHeaderRow = {
        kind: "header",
        id: `header:${side}`,
        side,
        ref,
        note: `${commits.length} ${side === "head" ? "ahead" : "behind"}`,
        count: commits.length,
    };
    const rows: CompareRow[] = commits.map((c) => ({
        ...toRow(c, now),
        kind: "commit" as const,
        id: c.hash,
        side,
    }));
    return [header, ...rows];
}

export function buildCompareRows(opts: BuildCompareRowsOpts): CompareRow[] {
    const aggregate: CompareAggregateRow = {
        kind: "aggregate",
        id: AGGREGATE,
        files: opts.aggregate ? opts.aggregate.files.length : null,
        adds: opts.aggregate?.adds ?? 0,
        dels: opts.aggregate?.dels ?? 0,
    };
    return [
        aggregate,
        ...sideRows(opts.ahead, "head", opts.head, opts.now),
        ...sideRows(opts.behind, "base", opts.base, opts.now),
    ];
}

// What j/k walks: the aggregate and every commit, in column order. Headers are labels, not stops.
export function compareNavIds(rows: CompareRow[]): string[] {
    return rows.filter((r) => r.kind !== "header").map((r) => r.id);
}

// Tab: jump to the *first commit of the other side*, so it moves between groups rather than shifting
// focus. From the aggregate row, "the other side" is head — the side the aggregate describes.
export function sideJumpTarget(rows: CompareRow[], fromId: string | null): string | null {
    const first = (side: CompareSide): string | null =>
        (rows.find((r) => r.kind === "commit" && r.side === side) as CompareCommitRow | undefined)?.id ?? null;
    if (fromId === AGGREGATE) {
        return first("head");
    }
    const from = rows.find((r) => r.kind === "commit" && r.id === fromId) as CompareCommitRow | undefined;
    if (from == null) {
        return null;
    }
    return first(from.side === "head" ? "base" : "head");
}
```

- [x] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run frontend/app/view/agents/comparerows.test.ts frontend/app/view/agents/historyrows.test.ts`

Expected: PASS — the seventeen new compare cases and all thirteen history cases.

- [x] **Step 7: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`

Expected: exit 0.

---

### Task 4: The compare store

**Files:**
- Create: `frontend/app/view/agents/comparestore.ts`

**Interfaces:**
- Consumes: `RpcApi.GitDivergenceCommand` (shipped, previously uncalled), Task 2's `RpcApi.GitCompareChangesCommand` and `RpcApi.GitCompareDiffCommand`, the shipped `RpcApi.GitCommitChangesCommand` / `GitCommitDiffCommand`, and `RpcApi.ListBranchesCommand`; `AGGREGATE` from `./comparerows`; `parseGitChanges` / `GitChanges` from `./gitstatus`; `parseUnifiedDiff` / `FileView` from `./gitdiff`.
- Produces: atoms `compareOnAtom`, `compareRefsAtom`, `compareSidesAtom`, `compareAggregateAtom`, `compareSelectionAtom`, `compareSelectedFileAtom`, `compareErrorAtom`, `compareBranchesAtom`, `compareDiffAtom`, and the derived `compareActiveChangesAtom`; loaders `loadCompareRefsMeta`, `enterCompare`, `setCompareRefs`, `selectCompareRow`, `selectCompareFile`, `exitCompare`. Tasks 6, 7, 8 and 9 read these.

**Two deliberate departures from the spec's atom table**, both simplifications found while writing the code — neither changes behaviour:

1. The spec lists a `compareDefaultAtom` holding the repo's default branch. It would be write-only: `loadCompareRefsMeta` returns the default directly and `enterCompare` consumes the return value, so nothing ever reads the atom. Dropped.
2. The spec's store table pairs a derived diff atom with the derived `compareActiveChangesAtom`. Both selection states write the *same* diff atom, so that derivation would be an identity function over it. The primitive `compareDiffAtom` is exported directly instead.

- [x] **Step 1: Write the store**

Create `frontend/app/view/agents/comparestore.ts`:

```ts
// frontend/app/view/agents/comparestore.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Branch-comparison state for the Diff surface. Separate from githistorystore.ts on purpose: that
// file is the single-ref history spine, this is a two-ref read with its own selection. Same idioms —
// module-level atoms written by async loaders through globalStore, with a guard token so a stale load
// cannot clobber a newer one. Module scope is load-bearing: the surface unmounts on nav switch, so
// the refs, the selection and the open file would be lost in component state.
//
// One selection model, two data sources: the aggregate row reads the two-ref commands, a commit row
// reads the same commit-scoped commands the history spine uses — a commit's contents mean the same
// thing however you reached it.

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { atom, type PrimitiveAtom } from "jotai";
import { AGGREGATE } from "./comparerows";
import { parseUnifiedDiff, type FileView } from "./gitdiff";
import { parseGitChanges, type GitChanges } from "./gitstatus";

export interface CompareRefs {
    base: string;
    head: string;
}

export interface CompareSides {
    ahead: HistoryCommit[];
    behind: HistoryCommit[];
    mergeBase: string;
}

export const compareOnAtom = atom<boolean>(false) as PrimitiveAtom<boolean>;
export const compareRefsAtom = atom<CompareRefs | null>(null) as PrimitiveAtom<CompareRefs | null>;
export const compareSidesAtom = atom<CompareSides | null>(null) as PrimitiveAtom<CompareSides | null>;
export const compareAggregateAtom = atom<GitChanges | null>(null) as PrimitiveAtom<GitChanges | null>;
// AGGREGATE, or a commit hash from either side
export const compareSelectionAtom = atom<string>(AGGREGATE) as PrimitiveAtom<string>;
export const compareSelectedFileAtom = atom<string | null>(null) as PrimitiveAtom<string | null>;
// A failed compare read, phrased with the refs in it so the column can name what did not resolve.
export const compareErrorAtom = atom<string | null>(null) as PrimitiveAtom<string | null>;
export const compareBranchesAtom = atom<BranchInfo[]>([]) as PrimitiveAtom<BranchInfo[]>;
// The open file's diff. One atom for both selection states — the aggregate and a commit each write it
// from their own command, so there is nothing for a derived atom to choose between.
export const compareDiffAtom = atom<FileView | null>(null) as PrimitiveAtom<FileView | null>;

const commitChangesAtom = atom<GitChanges | null>(null) as PrimitiveAtom<GitChanges | null>;

// Pane 2 reads one source regardless of which row is selected.
export const compareActiveChangesAtom = atom<GitChanges | null>((get) =>
    get(compareSelectionAtom) === AGGREGATE ? get(compareAggregateAtom) : get(commitChangesAtom)
);

const current = { token: "" };

export function exitCompare(): void {
    current.token = "";
    globalStore.set(compareOnAtom, false);
    globalStore.set(compareSidesAtom, null);
    globalStore.set(compareAggregateAtom, null);
    globalStore.set(compareSelectionAtom, AGGREGATE);
    globalStore.set(compareSelectedFileAtom, null);
    globalStore.set(commitChangesAtom, null);
    globalStore.set(compareDiffAtom, null);
    globalStore.set(compareErrorAtom, null);
    // compareRefsAtom survives on purpose: re-entering compare should offer the pair you last used.
}

// The picker's suggestions and the default base. Failure degrades to free text rather than an error:
// you can still type a ref by hand, which is the whole reason the fields accept free text.
export async function loadCompareRefsMeta(cwd: string): Promise<string> {
    try {
        const rtn = await RpcApi.ListBranchesCommand(TabRpcClient, { projectpath: cwd });
        globalStore.set(compareBranchesAtom, rtn.branches ?? []);
        return rtn.default ?? "";
    } catch {
        globalStore.set(compareBranchesAtom, []);
        return "";
    }
}

// Enter compare on the checked-out branch against the repo's default branch — the review question,
// and the pair that needs no typing. currentBranch comes from filesStateAtom.branch, which the
// change-list read already resolved, so learning where you are costs no extra git call.
export async function enterCompare(cwd: string, currentBranch: string): Promise<void> {
    globalStore.set(compareOnAtom, true);
    globalStore.set(compareErrorAtom, null);
    const def = await loadCompareRefsMeta(cwd);
    const prev = globalStore.get(compareRefsAtom);
    const base = prev?.base || def;
    const head = prev?.head || currentBranch;
    await setCompareRefs(cwd, base, head);
}

export async function setCompareRefs(cwd: string, base: string, head: string): Promise<void> {
    globalStore.set(compareRefsAtom, { base, head });
    const token = `${cwd}|${base}|${head}`;
    current.token = token;
    globalStore.set(compareSidesAtom, null);
    globalStore.set(compareAggregateAtom, null);
    globalStore.set(compareSelectionAtom, AGGREGATE);
    globalStore.set(compareSelectedFileAtom, null);
    globalStore.set(commitChangesAtom, null);
    globalStore.set(compareDiffAtom, null);
    globalStore.set(compareErrorAtom, null);
    if (!base || !head) {
        globalStore.set(compareErrorAtom, "Pick two refs to compare.");
        return;
    }
    try {
        const [div, agg] = await Promise.all([
            RpcApi.GitDivergenceCommand(TabRpcClient, { cwd, base, head }),
            RpcApi.GitCompareChangesCommand(TabRpcClient, { cwd, base, head }),
        ]);
        if (current.token !== token) {
            return;
        }
        if (!div.isrepo || !agg.isrepo) {
            globalStore.set(compareErrorAtom, "Not a git repository.");
            return;
        }
        globalStore.set(compareSidesAtom, {
            ahead: div.ahead ?? [],
            behind: div.behind ?? [],
            mergeBase: div.mergebase ?? "",
        });
        const changes = parseGitChanges(agg.statusz, agg.numstat);
        globalStore.set(compareAggregateAtom, changes);
        const first = changes.files[0]?.path;
        if (first) {
            void selectCompareFile(cwd, first);
        }
    } catch {
        if (current.token === token) {
            // Name the pair: an unresolvable ref is the common cause, and a blank column would
            // otherwise read as "these refs do not differ".
            globalStore.set(compareErrorAtom, `Couldn’t compare ${base} with ${head}.`);
        }
    }
}

export async function selectCompareRow(cwd: string, rowId: string): Promise<void> {
    globalStore.set(compareSelectionAtom, rowId);
    globalStore.set(compareSelectedFileAtom, null);
    globalStore.set(compareDiffAtom, null);
    if (rowId === AGGREGATE) {
        const first = globalStore.get(compareAggregateAtom)?.files[0]?.path;
        if (first) {
            void selectCompareFile(cwd, first);
        }
        return;
    }
    globalStore.set(commitChangesAtom, null);
    try {
        const ch = await RpcApi.GitCommitChangesCommand(TabRpcClient, { cwd, hash: rowId });
        if (globalStore.get(compareSelectionAtom) !== rowId) {
            return; // selection moved on
        }
        const changes = ch.isrepo ? parseGitChanges(ch.statusz, ch.numstat) : null;
        globalStore.set(commitChangesAtom, changes);
        const first = changes?.files[0]?.path;
        if (first) {
            void selectCompareFile(cwd, first);
        }
    } catch {
        if (globalStore.get(compareSelectionAtom) === rowId) {
            globalStore.set(commitChangesAtom, null);
        }
    }
}

export async function selectCompareFile(cwd: string, path: string): Promise<void> {
    globalStore.set(compareSelectedFileAtom, path);
    globalStore.set(compareDiffAtom, null);
    const selection = globalStore.get(compareSelectionAtom);
    const refs = globalStore.get(compareRefsAtom);
    const moved = () =>
        globalStore.get(compareSelectedFileAtom) !== path || globalStore.get(compareSelectionAtom) !== selection;
    try {
        if (selection === AGGREGATE) {
            if (refs == null) {
                return;
            }
            const d = await RpcApi.GitCompareDiffCommand(TabRpcClient, {
                cwd,
                base: refs.base,
                head: refs.head,
                path,
            });
            if (moved()) {
                return;
            }
            globalStore.set(compareDiffAtom, parseUnifiedDiff(d.diff));
            return;
        }
        const d = await RpcApi.GitCommitDiffCommand(TabRpcClient, { cwd, hash: selection, path });
        if (moved()) {
            return;
        }
        globalStore.set(compareDiffAtom, parseUnifiedDiff(d.diff));
    } catch {
        if (!moved()) {
            globalStore.set(compareDiffAtom, null);
        }
    }
}
```

- [x] **Step 2: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`

Expected: exit 0. If `GitCompareChangesCommand` or `default` on the branches return is reported missing on `RpcApi`, Task 2's `task generate` did not run — go back and run it.

- [x] **Step 3: Confirm the existing suite still passes**

Run: `npx vitest run`

Expected: PASS. This store has no test of its own by design — it is thin RPC plumbing, and the repo convention tests pure derivation (Task 3 covers it) while leaving glue to the surface check. `githistorystore.ts` and `filesstore.ts` have no tests either.

---

### Task 5: Extract the changed-file list so two panes share one renderer

**Files:**
- Create: `frontend/app/view/agents/changedfilelist.tsx`
- Modify: `frontend/app/view/agents/commitpane.tsx` (delete lines 17–28 `FileListSkeleton` and lines 88–126 the list body; import and render the new component instead)

**Interfaces:**
- Consumes: `GitChanges` and `statusColor` from `./gitstatus`; `SkeletonLine` from `@/app/element/skeleton`; `cn` from `@/util/util`.
- Produces: `ChangedFileList({ changes, selectedFile, onSelectFile })`. Task 6's `aggregatepane.tsx` renders it, and `CommitPane` now renders it too.

This is a pure refactor: no behaviour change, no new props beyond what `CommitPane` already passes down.

- [x] **Step 1: Create the shared list**

Create `frontend/app/view/agents/changedfilelist.tsx`:

```tsx
// frontend/app/view/agents/changedfilelist.tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The changed-file list shared by the Diff surface's middle pane in both of its states: one commit's
// files (commitpane) and the aggregate between two refs (aggregatepane). Extracted rather than
// duplicated — the row is identical in the mockup for both, so one renderer is one source of truth
// for status colour, path truncation and the selected tint.

import { SkeletonLine } from "@/app/element/skeleton";
import { cn } from "@/util/util";
import { statusColor, type GitChanges } from "./gitstatus";

function FileListSkeleton() {
    return (
        <div className="px-[8px]">
            {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="flex items-center gap-[8px] py-[7px]">
                    <SkeletonLine className="h-[8px] w-[10px]" />
                    <SkeletonLine className="h-[8px] flex-1" />
                    <SkeletonLine className="h-[8px] w-[22px]" />
                </div>
            ))}
        </div>
    );
}

export function ChangedFileList({
    changes,
    selectedFile,
    onSelectFile,
}: {
    changes: GitChanges | null;
    selectedFile: string | null;
    onSelectFile: (path: string) => void;
}) {
    if (changes == null) {
        return <FileListSkeleton />;
    }
    if (changes.files.length === 0) {
        return <div className="px-[8px] py-[6px] text-[12px] text-ink-mid">No files changed</div>;
    }
    return (
        <>
            {changes.files.map((f) => (
                <button
                    key={f.path}
                    onClick={() => onSelectFile(f.path)}
                    className={cn(
                        "flex w-full items-center gap-[8px] rounded-[7px] px-[8px] py-[7px] text-left transition-colors duration-[140ms] hover:bg-surface-raised",
                        f.path === selectedFile && "bg-surface-selected"
                    )}
                >
                    <span className={cn("w-[13px] flex-none text-center font-mono text-[10px] font-bold", statusColor(f.status))}>
                        {f.status}
                    </span>
                    <span
                        className={cn(
                            "min-w-0 flex-1 truncate font-mono text-[11.5px]",
                            f.path === selectedFile ? "text-ink-hi" : "text-ink-mid"
                        )}
                    >
                        {f.path}
                    </span>
                    <span className="flex-none font-mono text-[10px] font-semibold text-success">+{f.adds}</span>
                    <span className="flex-none font-mono text-[10px] font-semibold text-error">−{f.dels}</span>
                </button>
            ))}
        </>
    );
}
```

Note the skeleton's markup: copy `FileListSkeleton` from `commitpane.tsx:17-28` verbatim rather than inventing one, so the loading state does not visibly change.

- [x] **Step 2: Point the commit pane at it**

In `frontend/app/view/agents/commitpane.tsx`:

1. Delete the local `FileListSkeleton` (lines 17–28).
2. Add `import { ChangedFileList } from "./changedfilelist";` to the imports.
3. Drop the now-unused `statusColor` and `SkeletonLine` imports if nothing else in the file uses them (check first — `statusColor` was only used by the list body).
4. Replace the whole scroll container (lines 88–126) with:

```tsx
            <div className="min-h-0 flex-1 overflow-y-auto px-[8px] pb-[20px]">
                <ChangedFileList changes={changes} selectedFile={selectedFile} onSelectFile={onSelectFile} />
            </div>
```

- [x] **Step 3: Verify nothing dangles and the tree still typechecks**

Run:

```bash
grep -n "FileListSkeleton\|statusColor\|SkeletonLine" frontend/app/view/agents/commitpane.tsx
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit
npx vitest run
```

Expected: the grep prints nothing (all three moved to `changedfilelist.tsx`); typecheck exits 0; the suite passes. A typecheck error about an unused import means step 3 above was skipped.

---

### Task 6: The compare column and the aggregate pane

**Files:**
- Create: `frontend/app/view/agents/comparecolumn.tsx`
- Create: `frontend/app/view/agents/aggregatepane.tsx`

**Interfaces:**
- Consumes: `AGGREGATE`, `CompareRow`, `CompareCommitRow`, `CompareHeaderRow`, `SIDE_DOT`, `SIDE_TEXT` from `./comparerows`; `ChangedFileList` from `./changedfilelist`; `GitChanges` from `./gitstatus`; `SkeletonLine` from `@/app/element/skeleton`; `cn` from `@/util/util`.
- Produces: `CompareColumn({ rows, selected, mergeBase, error, loading, onSelect })` and `AggregatePane({ base, head, changes, selectedFile, onSelectFile })`. Task 8 renders both.

- [x] **Step 1: Write the column**

Create `frontend/app/view/agents/comparecolumn.tsx`:

```tsx
// frontend/app/view/agents/comparecolumn.tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pane 1 of the Diff surface in its compare state (Wave-git-review.dc.html, lines 376-399): the
// aggregate as row zero, then two labelled commit groups coloured by side, then the merge base. No
// graph gutter — compare has no lane geometry to draw, so rows are flush-padded instead of indented.

import { SkeletonLine } from "@/app/element/skeleton";
import { cn } from "@/util/util";
import {
    AGGREGATE,
    SIDE_DOT,
    SIDE_TEXT,
    type CompareCommitRow,
    type CompareHeaderRow,
    type CompareRow,
} from "./comparerows";

const ROW_H = 32;
const PAD = 14;

function CompareSkeleton() {
    return (
        <div className="px-[14px]">
            {Array.from({ length: 8 }).map((_, i) => (
                <div key={i} className="flex h-[32px] items-center gap-[9px]">
                    <SkeletonLine className="h-[7px] w-[7px] rounded-full" />
                    <SkeletonLine className="h-[8px] w-[46px]" />
                    <SkeletonLine className="h-[8px] w-[150px]" />
                </div>
            ))}
        </div>
    );
}

function AggregateRowView({
    row,
    selected,
    onSelect,
}: {
    row: Extract<CompareRow, { kind: "aggregate" }>;
    selected: boolean;
    onSelect: () => void;
}) {
    return (
        <button
            onClick={onSelect}
            style={{ height: ROW_H, paddingLeft: PAD }}
            className={cn(
                "relative flex w-full items-center gap-[9px] pr-[12px] text-left transition-colors duration-[140ms] hover:bg-surface",
                selected && "bg-surface-selected"
            )}
        >
            {selected ? <div className="absolute bottom-0 left-0 top-0 w-[2px] bg-accent" /> : null}
            <span className="font-mono text-[9px] font-bold uppercase tracking-[0.14em] text-muted">Aggregate</span>
            <div className="flex-1" />
            {row.files == null ? (
                <SkeletonLine className="h-[8px] w-[80px]" />
            ) : (
                <>
                    <span className="font-mono text-[10.5px] text-ink-faint">
                        {row.files} {row.files === 1 ? "file" : "files"}
                    </span>
                    <span className="font-mono text-[10px] font-semibold text-success">+{row.adds}</span>
                    <span className="font-mono text-[10px] font-semibold text-error">−{row.dels}</span>
                </>
            )}
        </button>
    );
}

function HeaderRowView({ row }: { row: CompareHeaderRow }) {
    return (
        <div className="flex items-center gap-[8px] px-[14px] pb-[8px] pt-[12px]">
            <span className={cn("h-[7px] w-[7px] flex-none rounded-full", SIDE_DOT[row.side])} />
            <span className={cn("font-mono text-[11.5px] font-semibold", SIDE_TEXT[row.side])}>{row.ref}</span>
            <span className="text-[11.5px] text-muted">{row.note}</span>
            <div className="flex-1" />
            <span className="flex-none rounded-[5px] border border-edge-mid bg-surface-raised px-[7px] py-[2px] font-mono text-[10px] font-semibold text-ink-faint">
                {row.count}
            </span>
        </div>
    );
}

function CommitRowView({
    row,
    selected,
    onSelect,
}: {
    row: CompareCommitRow;
    selected: boolean;
    onSelect: () => void;
}) {
    return (
        <button
            onClick={onSelect}
            style={{ height: ROW_H }}
            className={cn(
                "relative flex w-full items-center gap-[9px] pl-[20px] pr-[12px] text-left transition-colors duration-[140ms] hover:bg-surface",
                selected && "bg-surface-selected"
            )}
        >
            {selected ? <div className="absolute bottom-0 left-0 top-0 w-[2px] bg-accent" /> : null}
            <span className={cn("h-[7px] w-[7px] flex-none rounded-full opacity-85", SIDE_DOT[row.side])} />
            <span className="flex-none font-mono text-[11px] text-muted">{row.hash.slice(0, 7)}</span>
            <span
                className={cn(
                    "min-w-0 flex-1 truncate text-[12.5px]",
                    selected ? "font-semibold text-ink-hi" : "text-foreground"
                )}
            >
                {row.subject}
            </span>
            <span className="max-w-[92px] flex-none truncate text-[11px] text-ink-faint">{row.author}</span>
        </button>
    );
}

export function CompareColumn({
    rows,
    selected,
    mergeBase,
    error,
    loading,
    onSelect,
}: {
    rows: CompareRow[];
    selected: string;
    mergeBase: string;
    error: string | null;
    loading: boolean;
    onSelect: (id: string) => void;
}) {
    const diverges = rows.some((r) => r.kind === "commit");
    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex flex-none items-center gap-[9px] px-[14px] pb-[8px] pt-[10px]">
                <span className="font-mono text-[9px] font-bold uppercase tracking-[0.14em] text-muted">Compare</span>
                <div className="flex-1" />
                <span className="font-mono text-[10px] text-ink-faint">
                    {loading || !diverges ? "" : `${rows.filter((r) => r.kind === "commit").length} divergent commits`}
                </span>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto pb-[24px]">
                {error != null ? (
                    <div className="px-[14px] py-[8px] text-[12px] text-error">{error}</div>
                ) : loading ? (
                    <CompareSkeleton />
                ) : (
                    <>
                        {rows.map((row) =>
                            row.kind === "aggregate" ? (
                                <AggregateRowView
                                    key={row.id}
                                    row={row}
                                    selected={selected === AGGREGATE}
                                    onSelect={() => onSelect(AGGREGATE)}
                                />
                            ) : row.kind === "header" ? (
                                <HeaderRowView key={row.id} row={row} />
                            ) : (
                                <CommitRowView
                                    key={row.id}
                                    row={row}
                                    selected={selected === row.id}
                                    onSelect={() => onSelect(row.id)}
                                />
                            )
                        )}
                        {/* A stated result, not an empty list: two refs that agree is an answer. */}
                        {!diverges ? (
                            <div className="px-[14px] py-[8px] text-[12px] text-ink-mid">
                                These refs do not diverge.
                            </div>
                        ) : null}
                        {mergeBase ? (
                            <div className="mx-[14px] mb-[30px] mt-[8px] rounded-[9px] border border-edge-faint bg-surface px-[12px] py-[10px]">
                                <p className="text-[11.5px] leading-[1.5] text-ink-faint">
                                    Merge base{" "}
                                    <span className="font-mono text-[11px] text-ink-mid">
                                        {mergeBase.slice(0, 7)}
                                    </span>
                                    . The file list stays on the aggregate until you select a commit.
                                </p>
                            </div>
                        ) : null}
                    </>
                )}
            </div>
        </div>
    );
}
```

- [x] **Step 2: Write the aggregate pane**

Create `frontend/app/view/agents/aggregatepane.tsx`:

```tsx
// frontend/app/view/agents/aggregatepane.tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pane 2 of the Diff surface while the aggregate row is selected (Wave-git-review.dc.html, lines
// 401-425): what head introduces relative to base, anchored at their merge base. When a *commit* row
// is selected instead, the surface renders the shipped CommitPane — a compare commit row is a
// HistoryRow, so no adapter is needed.

import { ChangedFileList } from "./changedfilelist";
import { SIDE_TEXT } from "./comparerows";
import type { GitChanges } from "./gitstatus";

export function AggregatePane({
    base,
    head,
    changes,
    selectedFile,
    onSelectFile,
}: {
    base: string;
    head: string;
    changes: GitChanges | null;
    selectedFile: string | null;
    onSelectFile: (path: string) => void;
}) {
    const count = changes?.files.length ?? 0;
    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex-none border-b border-edge-faint px-[15px] pb-[11px] pt-[13px]">
                <div className="mb-[8px] font-mono text-[9px] font-bold uppercase tracking-[0.14em] text-muted">
                    Aggregate diff
                </div>
                <div className="flex flex-wrap items-center gap-[8px] font-mono text-[12px] text-ink-mid">
                    <span className={SIDE_TEXT.head}>{head}</span>
                    <span className="text-ink-faint">→</span>
                    <span className={SIDE_TEXT.base}>{base}</span>
                </div>
                <div className="mt-[9px] flex items-center gap-[10px]">
                    <span className="font-mono text-[11px] font-semibold text-muted">
                        {count} {count === 1 ? "file" : "files"}
                    </span>
                    <span className="font-mono text-[11px] font-semibold text-success">+{changes?.adds ?? 0}</span>
                    <span className="font-mono text-[11px] font-semibold text-error">−{changes?.dels ?? 0}</span>
                </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-[8px] pb-[20px] pt-[8px]">
                <ChangedFileList changes={changes} selectedFile={selectedFile} onSelectFile={onSelectFile} />
            </div>
        </div>
    );
}
```

- [x] **Step 3: Confirm every colour resolves to a token, and typecheck**

Run:

```bash
grep -nE "#[0-9a-fA-F]{3,8}|rgba?\(" frontend/app/view/agents/comparecolumn.tsx frontend/app/view/agents/aggregatepane.tsx
for t in graphlane-2 graphlane-1 surface-selected accent success error ink-faint ink-mid ink-hi muted edge-mid edge-faint surface-raised; do
  printf '%s ' "$t"; grep -c -- "--color-$t:" frontend/tailwindsetup.css
done
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit
```

Expected: the first grep prints nothing (no raw colour anywhere); every token line prints `1`; typecheck exits 0. A `0` on a token means it was renamed since this plan was written — stop and report it rather than inventing a colour.

---

### Task 7: The inline two-ref picker

**Files:**
- Create: `frontend/app/view/agents/refpicker.tsx`

**Interfaces:**
- Consumes: `BranchInfo` (global generated type); `cn` from `@/util/util`; `PopoverReveal` from `@/app/element/popoverreveal`; `SIDE_TEXT` from `./comparerows`, so the picker's two fields carry the same side colours the compare column uses and the two cannot drift.
- Produces: `RefPicker({ base, head, branches, editing, onEdit, onApply, onCancel })`. Task 8 renders it in the subject bar in place of the static ref chip and owns the `editing` state via the compare atoms.

The chip displays **head first, then base**, following the mockup (its ref expression at line 871 and the aggregate arrow at lines 405–407 both order it that way). Focus on entry lands on the **base** field regardless of position, because head is almost always the branch you are already on.

- [x] **Step 1: Write the picker**

Create `frontend/app/view/agents/refpicker.tsx`:

```tsx
// frontend/app/view/agents/refpicker.tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The subject bar's ref expression, editable in place (Wave-git-review.dc.html: "press c, or click
// the ref expression and add a second ref"). One control serves both gestures, so there is no second
// overlay and no duplicated ref-selection logic. Free text is accepted alongside the branch
// suggestions, so a tag or a raw SHA works — the suggestion list is local branches only.

import { PopoverReveal } from "@/app/element/popoverreveal";
import { cn } from "@/util/util";
import { useEffect, useRef, useState } from "react";
import { SIDE_TEXT } from "./comparerows";

function Suggestions({
    branches,
    query,
    onPick,
}: {
    branches: BranchInfo[];
    query: string;
    onPick: (name: string) => void;
}) {
    const q = query.trim().toLowerCase();
    const shown = (q ? branches.filter((b) => b.name.toLowerCase().includes(q)) : branches).slice(0, 8);
    return (
        <PopoverReveal
            open={shown.length > 0}
            origin="top"
            className="absolute left-0 top-full z-20 mt-1 w-[240px] overflow-hidden rounded border border-border bg-modalbg py-1 shadow-popover"
        >
            {shown.map((b) => (
                <button
                    key={b.name}
                    // mousedown, not click: the field's blur would tear the popover down first
                    onMouseDown={(e) => {
                        e.preventDefault();
                        onPick(b.name);
                    }}
                    className="flex w-full items-center gap-[8px] px-[10px] py-[6px] text-left hover:bg-surface-hover"
                >
                    <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-ink-mid">{b.name}</span>
                    <span className="flex-none text-[10px] text-ink-faint">{b.age}</span>
                </button>
            ))}
        </PopoverReveal>
    );
}

export function RefPicker({
    base,
    head,
    branches,
    editing,
    onEdit,
    onApply,
    onCancel,
}: {
    base: string;
    head: string;
    branches: BranchInfo[];
    editing: boolean;
    onEdit: () => void;
    onApply: (base: string, head: string) => void;
    onCancel: () => void;
}) {
    const [draftBase, setDraftBase] = useState(base);
    const [draftHead, setDraftHead] = useState(head);
    const [focused, setFocused] = useState<"base" | "head" | null>(null);
    const baseRef = useRef<HTMLInputElement>(null);

    // Re-entering the picker starts from whatever the surface is currently comparing, and focus lands
    // on base — head is where you already are, base is the ref you came to change.
    useEffect(() => {
        if (editing) {
            setDraftBase(base);
            setDraftHead(head);
            baseRef.current?.focus();
            baseRef.current?.select();
        }
    }, [editing, base, head]);

    if (!editing) {
        return (
            <button
                onClick={onEdit}
                className="flex items-center gap-[8px] rounded-[9px] border border-accent-edge bg-surface-selected px-[11px] py-[6px] hover:border-edge-strong"
            >
                <span className="font-mono text-[8.5px] font-semibold uppercase tracking-[0.1em] text-ink-faint">
                    Compare
                </span>
                <span className="font-mono text-[12px] text-ink-hi">
                    {head || "—"} … {base || "—"}
                </span>
            </button>
        );
    }

    const apply = () => onApply(draftBase.trim(), draftHead.trim());
    const keys = (e: React.KeyboardEvent) => {
        if (e.key === "Enter") {
            e.preventDefault();
            apply();
        } else if (e.key === "Escape") {
            // cancels the edit only — leaving compare is Escape's job when the picker is closed
            e.preventDefault();
            e.stopPropagation();
            onCancel();
        }
    };
    const field = "w-[150px] bg-transparent font-mono text-[12px] text-ink-hi outline-none placeholder:text-ink-faint";

    return (
        <div className="relative flex items-center gap-[8px] rounded-[9px] border border-accent-edge bg-surface-selected px-[11px] py-[6px]">
            <span className="font-mono text-[8.5px] font-semibold uppercase tracking-[0.1em] text-ink-faint">
                Compare
            </span>
            <div className="relative">
                <input
                    value={draftHead}
                    onChange={(e) => setDraftHead(e.target.value)}
                    onFocus={() => setFocused("head")}
                    onKeyDown={keys}
                    placeholder="head ref"
                    // side colours come from comparerows, so the picker and the column cannot drift
                    className={cn(field, SIDE_TEXT.head)}
                />
                {focused === "head" ? (
                    <Suggestions branches={branches} query={draftHead} onPick={setDraftHead} />
                ) : null}
            </div>
            <span className="flex-none font-mono text-[12px] text-ink-faint">…</span>
            <div className="relative">
                <input
                    ref={baseRef}
                    value={draftBase}
                    onChange={(e) => setDraftBase(e.target.value)}
                    onFocus={() => setFocused("base")}
                    onKeyDown={keys}
                    placeholder="base ref"
                    className={cn(field, SIDE_TEXT.base)}
                />
                {focused === "base" ? (
                    <Suggestions branches={branches} query={draftBase} onPick={setDraftBase} />
                ) : null}
            </div>
            <button
                onClick={apply}
                className="flex-none rounded border border-border px-[8px] py-[2px] text-[11px] text-ink-mid hover:text-foreground"
            >
                Compare
            </button>
        </div>
    );
}
```

- [x] **Step 2: Confirm the tokens exist and typecheck**

Run:

```bash
grep -nE "#[0-9a-fA-F]{3,8}|rgba?\(" frontend/app/view/agents/refpicker.tsx
for t in accent-edge surface-selected surface-hover modalbg ink-hi ink-faint ink-mid graphlane-1 graphlane-2; do
  printf '%s ' "$t"; grep -c -- "--color-$t:" frontend/tailwindsetup.css
done
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit
```

Expected: no raw colour; every token prints `1`; typecheck exits 0. If `accent-edge` prints `0`, check whether the shipped surface uses a different name for the accent border (`grep -n "accent" frontend/tailwindsetup.css`) and use that — do not add a token for this.

---

### Task 8: Wire compare into the surface

**Files:**
- Modify: `frontend/app/view/agents/filessurface.tsx` (imports; the `refExpr` block at lines 282–286; the list-nav memo at lines 326–343; the ref chip at lines 416–421; the three-pane body at lines 437–470)

**Interfaces:**
- Consumes: from `./comparestore` — `compareOnAtom`, `compareRefsAtom`, `compareSidesAtom`, `compareAggregateAtom`, `compareSelectionAtom`, `compareSelectedFileAtom`, `compareErrorAtom`, `compareBranchesAtom`, `compareActiveChangesAtom`, `compareDiffAtom`, `enterCompare`, `setCompareRefs`, `selectCompareRow`, `selectCompareFile`, `exitCompare`; from `./comparerows` — `AGGREGATE`, `buildCompareRows`, `compareNavIds`, `type CompareCommitRow`; `CompareColumn` from `./comparecolumn`; `AggregatePane` from `./aggregatepane`; `RefPicker` from `./refpicker`.
- Produces: a working compare state on the Diff surface. Task 9 attaches keys to the same store functions.

- [x] **Step 1: Add the imports**

Add to `frontend/app/view/agents/filessurface.tsx`:

```tsx
import { AggregatePane } from "./aggregatepane";
import { CompareColumn } from "./comparecolumn";
import { AGGREGATE, buildCompareRows, compareNavIds, type CompareCommitRow } from "./comparerows";
import {
    compareActiveChangesAtom,
    compareAggregateAtom,
    compareBranchesAtom,
    compareDiffAtom,
    compareErrorAtom,
    compareOnAtom,
    compareRefsAtom,
    compareSelectedFileAtom,
    compareSelectionAtom,
    compareSidesAtom,
    enterCompare,
    exitCompare,
    selectCompareFile,
    selectCompareRow,
    setCompareRefs,
} from "./comparestore";
import { RefPicker } from "./refpicker";
```

- [x] **Step 2: Read the compare atoms and derive its rows**

Immediately after the existing atom reads (after `const activeDiff = useAtomValue(activeDiffAtom);`, line 260), add:

```tsx
    const compareOn = useAtomValue(compareOnAtom);
    const compareRefs = useAtomValue(compareRefsAtom);
    const compareSides = useAtomValue(compareSidesAtom);
    const compareAggregate = useAtomValue(compareAggregateAtom);
    const compareSelection = useAtomValue(compareSelectionAtom);
    const compareFile = useAtomValue(compareSelectedFileAtom);
    const compareError = useAtomValue(compareErrorAtom);
    const compareBranches = useAtomValue(compareBranchesAtom);
    const compareChanges = useAtomValue(compareActiveChangesAtom);
    const compareDiff = useAtomValue(compareDiffAtom);
    // the picker is open when compare is on but no divergence read has landed yet, or the user reopened it
    const [pickerOpen, setPickerOpen] = useState(false);
```

Then, after the `projects` list is built (after line 266), derive the compare rows:

```tsx
    // Rebuilt from the raw divergence on every render: buildCompareRows is pure and the input is at
    // most a few hundred commits, the same reasoning the history rows use.
    const compareRows = useMemo(
        () =>
            compareRefs == null
                ? []
                : buildCompareRows({
                      base: compareRefs.base,
                      head: compareRefs.head,
                      ahead: compareSides?.ahead ?? [],
                      behind: compareSides?.behind ?? [],
                      aggregate: compareAggregate,
                      now: Date.now(),
                  }),
        [compareRefs, compareSides, compareAggregate]
    );
```

- [x] **Step 3: Make the ref expression the picker when compare is on**

Replace the `refExpr` computation (lines 282–286) with:

```tsx
    const refExpr = runSource
        ? `${(runSource.baseCommit || "HEAD").slice(0, 7)} … HEAD`
        : scope === "agent" && state?.ref
          ? `session start ${state.ref.slice(0, 7)} … worktree`
          : `${state?.branch || "—"} · all refs`;

    // Entering compare is a repo-scoped two-ref read, so it needs a cwd and a branch to start from.
    const startCompare = () => {
        if (!state?.cwd || !state.isRepo) {
            return;
        }
        setPickerOpen(true);
        fireAndForget(() => enterCompare(state.cwd!, state.branch ?? ""));
    };
    const leaveCompare = () => {
        setPickerOpen(false);
        exitCompare();
    };
```

Then replace the static "Reading" chip (lines 416–421) with:

```tsx
                        {compareOn ? (
                            <RefPicker
                                base={compareRefs?.base ?? ""}
                                head={compareRefs?.head ?? ""}
                                branches={compareBranches}
                                editing={pickerOpen}
                                onEdit={() => setPickerOpen(true)}
                                onApply={(b, h) => {
                                    setPickerOpen(false);
                                    if (state?.cwd) {
                                        fireAndForget(() => setCompareRefs(state.cwd!, b, h));
                                    }
                                }}
                                onCancel={() => setPickerOpen(false)}
                            />
                        ) : (
                            <button
                                onClick={startCompare}
                                disabled={!state?.cwd || !state.isRepo}
                                className="flex items-center gap-[8px] rounded-[9px] border border-edge-mid bg-surface px-[11px] py-[6px] hover:border-edge-strong disabled:cursor-default disabled:hover:border-edge-mid"
                            >
                                <span className="font-mono text-[8.5px] font-semibold uppercase tracking-[0.1em] text-ink-faint">
                                    Reading
                                </span>
                                <span className="font-mono text-[12px] text-ink-mid">{refExpr}</span>
                            </button>
                        )}
```

The scope chips need no change to their own markup — step 4 below makes the repo chip read as selected while compare is on, and step 5 makes a chip click exit compare.

- [x] **Step 4: Make the repo chip read as selected during compare, and exiting available from a chip**

Replace the `scope` computation (line 281) with:

```tsx
    // Run wins, then a picked project, then the focused agent — the same precedence the load effect
    // uses. Compare is a two-ref read of the repo, so it reads as repo scope for as long as it is on.
    const scope: "run" | "repo" | "agent" = compareOn ? "repo" : runSource ? "run" : projectSel ? "repo" : "agent";
```

and in the scope-chip `.map` (lines 396–414), make each chip a button that leaves compare, since run scope and agent scope are single-ref reads by definition. Replace the opening `<div` of the chip and its `key`/`className` with:

```tsx
                                <button
                                    key={key}
                                    onClick={() => {
                                        if (compareOn && key !== "repo") {
                                            leaveCompare();
                                        }
                                    }}
                                    className={cn(
                                        "flex items-center gap-[6px] border-r border-edge-faint px-[11px] py-[6px] text-[11.5px] font-semibold",
                                        scope === key ? "bg-surface-selected text-ink-hi" : "text-muted"
                                    )}
                                >
```

and close it with `</button>` instead of `</div>`.

- [x] **Step 5: Point list-nav at whichever column is showing**

Replace the `commitIds` / `historyNav` block (lines 326–343) with:

```tsx
    // publish the visible column's rows for global j/k list-nav. cursor == selection: moving selects,
    // which loads that row's files and first diff. Must run before the early return (hooks rules).
    const navIds = compareOn ? compareNavIds(compareRows) : (historyRows ?? []).map((r) => r.hash);
    const navCursor = compareOn ? compareSelection : (selectedCommit ?? undefined);
    const navFile = compareOn ? compareFile : selectedFile;
    const listNav = useMemo<ListNavController | null>(
        () =>
            state?.cwd && navIds.length > 0
                ? {
                      surface: "files",
                      navigableIds: navIds,
                      cursorId: navCursor,
                      setCursor: (id) =>
                          fireAndForget(() =>
                              compareOn ? selectCompareRow(state.cwd!, id) : selectCommit(state.cwd!, id)
                          ),
                      activate:
                          navFile && state.cwd ? () => getApi().openExternal(joinPath(state.cwd!, navFile)) : undefined,
                  }
                : null,
        [state?.cwd, compareOn, navIds.join(" "), navCursor, navFile]
    );
    useSurfaceListNav(listNav);
```

- [x] **Step 6: Render the compare panes**

Replace the three-pane body (lines 437–470) with:

```tsx
                <div className="flex min-h-0 flex-1 border-t border-edge-faint">
                    <div className="flex w-[460px] flex-none flex-col border-r border-edge-faint">
                        {state?.isRepo === false && state?.cwd ? (
                            <div className="px-[14px] py-[10px] text-[12px] text-ink-mid">Not a git repository</div>
                        ) : compareOn ? (
                            <CompareColumn
                                rows={compareRows}
                                selected={compareSelection}
                                mergeBase={compareSides?.mergeBase ?? ""}
                                error={compareError}
                                loading={compareRefs != null && compareSides == null && compareError == null}
                                onSelect={(id) => state?.cwd && fireAndForget(() => selectCompareRow(state.cwd!, id))}
                            />
                        ) : (
                            <HistoryPane
                                rows={historyRows ?? []}
                                selected={selectedCommit}
                                graphOn={graphOn}
                                loading={historyRows == null}
                                onSelect={(hash) => state?.cwd && fireAndForget(() => selectCommit(state.cwd!, hash))}
                            />
                        )}
                    </div>
                    <div className="flex w-[300px] flex-none flex-col border-r border-edge-faint bg-surface">
                        {compareOn ? (
                            compareSelection === AGGREGATE ? (
                                <AggregatePane
                                    base={compareRefs?.base ?? ""}
                                    head={compareRefs?.head ?? ""}
                                    changes={compareChanges}
                                    selectedFile={compareFile}
                                    onSelectFile={(path) =>
                                        state?.cwd && fireAndForget(() => selectCompareFile(state.cwd!, path))
                                    }
                                />
                            ) : (
                                // a compare commit row *is* a HistoryRow, so the shipped pane takes it directly
                                <CommitPane
                                    row={
                                        (compareRows.find(
                                            (r) => r.kind === "commit" && r.id === compareSelection
                                        ) as CompareCommitRow | undefined) ?? null
                                    }
                                    changes={compareChanges}
                                    selectedFile={compareFile}
                                    onSelectFile={(path) =>
                                        state?.cwd && fireAndForget(() => selectCompareFile(state.cwd!, path))
                                    }
                                />
                            )
                        ) : (
                            <CommitPane
                                row={selectedRow}
                                changes={activeChanges}
                                selectedFile={selectedFile}
                                onSelectFile={(path) =>
                                    state?.cwd &&
                                    selectedCommit != null &&
                                    fireAndForget(() => selectCommitFile(state.cwd!, selectedCommit, path))
                                }
                            />
                        )}
                    </div>
                    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                        <CenterPane
                            path={compareOn ? compareFile : selectedFile}
                            view={compareOn ? compareDiff : activeDiff}
                            // "Open in editor" only makes sense for a path that exists in the working tree
                            cwd={!compareOn && selectedCommit === WORKING_TREE ? (state?.cwd ?? null) : null}
                        />
                    </div>
                </div>
```

- [x] **Step 7: Leave compare when the scope's repository changes**

Compare is anchored to one repository, so switching source must not leave a stale two-ref read on screen. Add after the existing history-loading effect (after line 322):

```tsx
    // A different cwd means different refs: keep compare from showing one repo's divergence over
    // another's. Runs and agents are single-ref scopes, so entering either exits compare too.
    useEffect(() => {
        if (globalStore.get(compareOnAtom)) {
            exitCompare();
            setPickerOpen(false);
        }
    }, [state?.cwd, runSource?.runId]);
```

- [x] **Step 8: Typecheck and run the full frontend suite**

Run:

```bash
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit
npx vitest run
```

Expected: typecheck exits 0; the suite passes. A "declared but never read" error on `refExpr` means step 3's replacement chip was not wired; an error on `AGGREGATE` means the import in step 1 was skipped.

- [x] **Step 9: Lint the files you touched**

Run: `npx eslint frontend/app/view/agents/comparerows.ts frontend/app/view/agents/comparestore.ts frontend/app/view/agents/comparecolumn.tsx frontend/app/view/agents/aggregatepane.tsx frontend/app/view/agents/refpicker.tsx frontend/app/view/agents/changedfilelist.tsx frontend/app/view/agents/filessurface.tsx frontend/app/view/agents/commitpane.tsx`

Expected: no errors. Do **not** run `prettier --write` on `filessurface.tsx` or `commitpane.tsx` — it reorganises imports and rewraps the whole file, turning a small diff into hundreds of lines. Hand-format your own lines to match the surrounding style.

---

### Task 9: Keys and footer hints

**Files:**
- Modify: `frontend/app/store/keybindings/listnav.ts:15-23` (one optional field on `ListNavController`)
- Modify: `frontend/app/store/keybindings/bindings.ts` (add `buildFilesBindings`; narrow the `surface:back-home` guard)
- Modify: `frontend/app/view/agents/filessurface.tsx` (register the new bindings; publish the compare rows on the list-nav controller)
- Modify: `frontend/app/cockpit/footerhints.ts` (a `files` entry in `SURFACE_HINTS`)
- Modify: `frontend/app/cockpit/footerhints.test.ts` (include `buildFilesBindings` in the id set)
- Test: `frontend/app/store/keybindings/store.test.ts` (a no-conflict case with compare on)

**Interfaces:**
- Consumes: Task 4's `compareOnAtom`, `compareSelectionAtom` and `exitCompare`; Task 3's `sideJumpTarget` and `CompareRow`; Task 8's `compareRows`; the existing `Binding` / `KeyContext` types, `useKeybindings`, and `listNavAtom`.
- Produces: `buildFilesBindings(): Binding[]` with ids `files:compare`, `files:exit-compare`, `files:switch-side`, plus footer hints referencing them, plus a `rows?: unknown[]` field on `ListNavController`. It takes no model argument — every `run()` reads live atoms, so there is nothing to close over (the same shape as `buildJarvisBindings`).

**Why the global Escape has to change:** `matchBinding` (`matcher.ts:36-40`) takes the **first** active binding in registration order, and `registerBindings` appends — so a surface binding registered by the mounted surface always loses to a global one on the same key. `surface:back-home` is global and claims Escape for the files surface. Narrowing its guard with `!compareOn` is exactly the pattern it already uses for the Jarvis graph peek and autonomy panel, both of which are surface-specific atoms consulted by that global guard.

- [x] **Step 1: Write the failing conflict test**

In `frontend/app/store/keybindings/store.test.ts`, add `buildFilesBindings` to the **existing** `from "./bindings"` import block (lines 6–13) rather than adding a second import from the same module, and add one new import:

```ts
import { compareOnAtom } from "@/app/view/agents/comparestore";
```

and add this case inside the existing `describe("keybindings store", ...)` block:

```ts
    it("hands Escape to the files surface while compare is on, without conflicting", () => {
        const model = {} as any;
        const filesCtx = { surface: "files" as const, editable: false, modalOpen: false, leader: null };
        const all = [...buildGlobalBindings(model), ...buildFilesBindings()];
        const backHome = all.find((b) => b.id === "surface:back-home")!;
        const exitCompare = all.find((b) => b.id === "files:exit-compare")!;

        globalStore.set(compareOnAtom, false);
        expect(backHome.when!(filesCtx)).toBe(true);
        expect(exitCompare.when!(filesCtx)).toBe(false);

        globalStore.set(compareOnAtom, true);
        // compare owns Escape: exactly one of the two is live, so the key never means two things
        expect(backHome.when!(filesCtx)).toBe(false);
        expect(exitCompare.when!(filesCtx)).toBe(true);
        expect(() => assertNoConflicts(all)).not.toThrow();
        globalStore.set(compareOnAtom, false);
    });
```

- [x] **Step 2: Run it to verify it fails**

Run: `npx vitest run frontend/app/store/keybindings/store.test.ts`

Expected: FAIL — `buildFilesBindings` is not exported from `./bindings`.

- [x] **Step 3: Let a list-nav controller carry its rows**

`sideJumpTarget` needs the compare rows, which live in the surface, and `ListNavController` (`listnav.ts:15-23`) publishes only an id list. Rather than have the binding rebuild rows it cannot see, let the controller carry them. In `frontend/app/store/keybindings/listnav.ts`, add one optional field to `ListNavController`, after `activate`:

```ts
    // Optional richer row model, for a surface whose keys need more than an id list — the Diff
    // surface's compare sides, where Tab must know which side a row belongs to. Typed as unknown[]
    // so this module stays free of any surface's row types; the consumer casts. Every other surface
    // leaves it undefined.
    rows?: unknown[];
```

- [x] **Step 4: Add the files bindings and narrow the global Escape**

In `frontend/app/store/keybindings/bindings.ts`, add these imports:

```ts
import { sideJumpTarget, type CompareRow } from "@/app/view/agents/comparerows";
import { compareOnAtom, compareSelectionAtom, exitCompare } from "@/app/view/agents/comparestore";
```

Change the `surface:back-home` binding's `when` (currently lines 170–174) to add one clause:

```ts
            when: (ctx) =>
                navigate(ctx) &&
                ESC_HOME_SURFACES.has(ctx.surface) &&
                !globalStore.get(graphPeekOpenAtom) &&
                !globalStore.get(autonomyPanelOpenAtom) &&
                // the Diff surface's compare state owns Escape while it is on: leaving compare is what
                // Escape means there, and going home instead would strand a two-ref read behind the Cockpit
                !globalStore.get(compareOnAtom),
            run: () => globalStore.set(model.surfaceAtom, "cockpit"),
```

Then append a new builder at the end of the file:

```ts
// Diff-surface keys. `c` is the entry gesture the mockup names; Escape is the single exit; Tab jumps
// between the two compare sides. Entering compare needs a cwd and a branch, which only the surface
// knows, so `c` clicks the control the surface already draws (the same clickThrough shape
// buildJarvisBindings uses) rather than duplicating scope resolution here.
export function buildFilesBindings(): Binding[] {
    const on = (ctx: KeyContext) => ctx.surface === "files" && !ctx.editable && !ctx.modalOpen;
    const inCompare = (ctx: KeyContext) => on(ctx) && globalStore.get(compareOnAtom);
    return [
        {
            id: "files:compare",
            keys: "c",
            group: "Diff",
            label: "Compare refs",
            when: on,
            run: () => {
                const el = document.querySelector<HTMLElement>("[data-files-ref-expr]");
                if (el == null) {
                    return false; // no repo scoped -> nothing to compare; let the key pass
                }
                el.click();
            },
        },
        {
            id: "files:exit-compare",
            keys: "Escape",
            group: "Diff",
            label: "Back to history",
            when: inCompare,
            run: () => exitCompare(),
        },
        {
            id: "files:switch-side",
            keys: "Tab",
            group: "Diff",
            label: "Switch compare side",
            when: inCompare,
            run: () => {
                const c = globalStore.get(listNavAtom);
                if (c == null || c.surface !== "files") {
                    return false;
                }
                // the surface publishes its compare rows on the controller (step 3); the cast is the
                // seam that keeps listnav.ts free of this surface's row types
                const target = sideJumpTarget((c.rows ?? []) as CompareRow[], globalStore.get(compareSelectionAtom));
                if (target == null) {
                    return false; // the other side has no commits — let Tab do its normal thing
                }
                c.setCursor(target);
            },
        },
    ];
}
```

- [x] **Step 5: Publish the compare rows on the controller**

In Task 8's `listNav` memo in `frontend/app/view/agents/filessurface.tsx`, add one line beside `activate`, so `Tab` can resolve a side jump:

```tsx
                      rows: compareOn ? compareRows : undefined,
```

and add `compareRows` to that memo's dependency array.

- [x] **Step 6: Mark the ref expression so `c` can reach it**

In `frontend/app/view/agents/filessurface.tsx`, add `data-files-ref-expr` to the non-compare "Reading" button from Task 8 step 3, and to `RefPicker`'s read-only chip button in `refpicker.tsx` — so `c` opens the picker whether or not compare is already on:

```tsx
                            <button
                                data-files-ref-expr
                                onClick={startCompare}
```

and in `refpicker.tsx`'s `!editing` branch:

```tsx
            <button
                data-files-ref-expr
                onClick={onEdit}
```

- [x] **Step 7: Register the bindings on the surface**

In `frontend/app/view/agents/filessurface.tsx`, add the imports and the registration next to the existing `useSurfaceListNav(listNav)` call:

```tsx
import { buildFilesBindings } from "@/app/store/keybindings/bindings";
import { useKeybindings } from "@/app/store/keybindings/store";
```

```tsx
    // stable array: every run() reads live atoms, so it never needs rebuilding
    const filesBindings = useMemo(() => buildFilesBindings(), []);
    useKeybindings(filesBindings);
```

- [x] **Step 8: Add the footer hints**

In `frontend/app/cockpit/footerhints.ts`, add a `files` entry to `SURFACE_HINTS` and update the stale comment above it (it says only the agent surface has surface-specific bindings, which stops being true here):

```ts
// The agent surface and the Diff surface have surface-specific bindings; the rest fall back to
// GLOBAL_HINTS only.
export const SURFACE_HINTS: Partial<Record<SurfaceKey, FooterHint[]>> = {
    agent: [
        // ...unchanged...
    ],
    files: [
        { ids: ["list:prev-k", "list:next-j", "list:prev", "list:next"], glyph: "↑↓", label: "commit" },
        { ids: ["list:activate"], glyph: "⏎", label: "open file" },
        { ids: ["files:compare"], glyph: "c", label: "compare" },
        { ids: ["files:switch-side"], glyph: "⇥", label: "side" }, // compare-only via its binding
        { ids: ["files:exit-compare"], glyph: "esc", label: "history" }, // compare-only via its binding
    ],
};
```

In `frontend/app/cockpit/footerhints.test.ts`, include the new builder so a renamed id still fails the build:

Replace its single existing import from that module with one block naming all four builders:

```ts
import {
    buildAgentBindings,
    buildFilesBindings,
    buildGlobalBindings,
    buildListNavBindings,
} from "@/app/store/keybindings/bindings";
```

`buildListNavBindings` joins the set because the new `files` hints reference `list:prev-k`, `list:next-j`, `list:prev`, `list:next` and `list:activate`, which that builder owns — without it the test would report those five as dangling.

```ts
        const ids = new Set(
            [
                ...buildGlobalBindings(model),
                ...buildAgentBindings(model),
                ...buildListNavBindings(),
                ...buildFilesBindings(),
            ].map((b) => b.id)
        );
```

- [x] **Step 9: Run the keybinding and hint tests**

Run: `npx vitest run frontend/app/store/keybindings/ frontend/app/cockpit/footerhints.test.ts`

Expected: PASS, including the new Escape-ownership case. A conflict error naming `"c"` means some other builder claims bare `c` for the files surface — read the error's surface/editable/modalOpen and narrow whichever guard is too broad.

- [x] **Step 10: Full verification**

Run:

```bash
go build ./...
go test ./pkg/gitinfo/... ./pkg/wshrpc/...
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit
npx vitest run
npx eslint frontend/app/store/keybindings/bindings.ts frontend/app/store/keybindings/listnav.ts frontend/app/cockpit/footerhints.ts frontend/app/view/agents/filessurface.tsx frontend/app/view/agents/refpicker.tsx
```

Expected: all five clean.

- [x] **Step 11: Verify the rendered surface over the Chrome DevTools Protocol**

With the dev app running (`task dev`), screenshot the compare state:

```bash
node scripts/cdp-shot.mjs cdp-shots/compare.png
```

Navigate to the Diff surface first (`Ctrl+6`, or `g f`), pick a project scope, then press `c`. Open the PNG and check against `wave-handoff/wave/project/Wave-git-review.dc.html`'s compare state: three panes at 460 / 300 / remainder; the Aggregate row at the top of the left column; two labelled side groups, head green and base blue, each with a count badge; the merge base stated at the bottom of that column; the middle pane headed "Aggregate diff" with `head → base` and the file totals; the diff pane showing the selected file. Then select a commit on either side and confirm the middle pane switches to that commit's own files, and that selecting the Aggregate row returns.

If the page is blank, do a full `location.reload()` first — HMR blanks the cockpit when modules move.

- [x] **Step 12: Report for review — do not commit**

Summarise: the nine Go table tests from Task 1; the seventeen `comparerows` cases; the thirteen `historyrows` cases still passing after the `toRow` extraction; the new Escape-ownership keybinding case; `go build ./...`; the typecheck; the full frontend suite; eslint; and what the screenshot showed, including whether commit selection and the return to the aggregate both worked.

Then stop and hand back for the single end-of-work commit, which needs explicit approval. That commit includes `docs/superpowers/specs/2026-07-31-git-branch-comparison-design.md` and this plan, per the project rule that a feature's spec and plan fold into the feature commit.

---

## Not in this plan

Deferred so this plan produces working software on its own. Each is a state or control the mockup declares, so the surface will visibly lack it. All were already deferred by the surface plan (`docs/superpowers/plans/2026-07-31-git-review-surface.md`) and by the design spec:

- **Commit provenance** — the mockup's "Produced by Run #148" line. Excluded by the spec's decision 1; it joins `Run` objects to commit hashes, and Runs reach the frontend only per-active-channel (`activeChannelRunsAtom`), so it needs its own backend read and its own spec.
- The `Fetch` button and its freshness clock — also the real answer to the stale-local-default caveat in the spec's decision 4.
- The filter row (author, path, free text) and history pagination.
- Full-pane "not a repository" and "the Git read failed" panels, each carrying the failing command, its exit code and stderr verbatim. This plan keeps the surface's existing one-line treatment plus a named error in the compare column.
- History scroll-offset persistence and the "Restored" banner.
- Narrow-window folding and row density.
- The Unified / Split diff toggle, and the desaturated diff-text tints `--color-diff-add-ink` / `--color-diff-del-ink`.
- A repeatable `verify:ui` scenario in `scripts/cdp/scenarios.mjs` — Task 9 step 9 is a one-off screenshot check.
