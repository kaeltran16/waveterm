# Code Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a ninth cockpit surface, "Code", that browses and reads any file in a registered git project — read-only, with a directory tree, a fuzzy file finder, and back/forward history.

**Architecture:** One new git RPC (`GitListFilesCommand`, wrapping `git ls-files`) returns a flat list of repo-relative paths; the frontend builds both the directory tree and the finder index from that single list. Files are read with the existing `FileInfoCommand` (stat) then `FileReadCommand` (content), and rendered by the existing read-only Monaco wrapper. All surface state lives in module-scoped jotai atoms because non-Agent surfaces unmount on nav switch.

**Tech Stack:** Go (`pkg/gitinfo`, `pkg/wshrpc`), TypeScript + React 19 + jotai + Tailwind 4, Monaco via the existing `CodeEditor` wrapper, vitest for frontend unit tests, `go test` for backend, CDP scenario harness for render smoke.

**Spec:** `docs/superpowers/specs/2026-08-03-code-browser-surface-design.md`

## Global Constraints

- **Commits are batched and gated.** The user's standing rule is: never commit or push without explicit approval; batch into one commit at the end. So every task below ends with `git add` only. Task 12 is the single commit and requires the user to approve it first. The spec document folds into that same commit — never a separate docs-only commit.
- **Typecheck command is non-standard.** `npx tsc` stack-overflows on this repo and `task check:ts` is therefore broken. Use `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`. Baseline is clean, so any error reported is yours.
- **Go tests need a Windows-style CGO include path.** From the repo root in PowerShell: `$env:CGO_CFLAGS = "-O2 -g -I$((Get-Location).Path -replace '\\','/')/pkg/jarvisembed/csrc"`. A Git-Bash POSIX path silently fails with the same error it is meant to fix.
- **Never hand-edit generated files.** `frontend/app/store/wshclientapi.ts`, `pkg/wshrpc/wshclient/wshclient.go` and `frontend/types/gotypes.d.ts` come from `task generate`.
- **No raw hex or rgba in components.** Colors come from `@theme` tokens in `frontend/tailwindsetup.css`. The one sanctioned exception in this feature is Monaco's internal token colors, which stay stock `vs-dark` (spec decision 4).
- **No new SCSS.** Tailwind only.
- **No jsdom render tests for surfaces.** Pure logic is extracted and unit-tested; "does it render" is the CDP `surface-smoke` scenario.
- **Comments explain why, not what. Lower case. Only when necessary.**
- **Read-only.** No task in this plan writes, saves, or mutates a user file.

---

### Task 1: Backend reader — `gitinfo.ListFiles`

**Files:**
- Modify: `pkg/gitinfo/gitinfo.go` (add `sort` to the import block at lines 10-20; append the new type and function)
- Test: `pkg/gitinfo/gitinfo_test.go` (append)

**Interfaces:**
- Consumes: the file-local `run(ctx, cwd, args...)` helper and the `gitTimeout` constant already in `gitinfo.go`
- Produces: `type FileList struct { Paths []string; IsRepo bool; Truncated bool }` and `func ListFiles(ctx context.Context, cwd string) (*FileList, error)`

- [ ] **Step 1: Write the failing tests**

Append to `pkg/gitinfo/gitinfo_test.go`. The `git(t, dir, ...)` helper already exists at the top of that file; `writeAt` is new.

```go
func writeAt(t *testing.T, dir, rel, body string) {
	t.Helper()
	full := filepath.Join(dir, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(full, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestListFilesIncludesTrackedAndUntrackedButNotIgnored(t *testing.T) {
	dir := t.TempDir()
	git(t, dir, "init", "-b", "main")
	writeAt(t, dir, ".gitignore", "ignored.txt\n")
	writeAt(t, dir, "a.go", "package a\n")
	writeAt(t, dir, "sub/b.go", "package b\n")
	git(t, dir, "add", ".")
	git(t, dir, "commit", "-m", "init")
	writeAt(t, dir, "untracked.go", "package u\n")
	writeAt(t, dir, "ignored.txt", "nope\n")
	writeAt(t, dir, "has space.go", "package s\n")

	fl, err := ListFiles(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	if !fl.IsRepo {
		t.Fatalf("IsRepo = false, want true")
	}
	if fl.Truncated {
		t.Fatalf("Truncated = true, want false")
	}
	want := []string{".gitignore", "a.go", "has space.go", "sub/b.go", "untracked.go"}
	if strings.Join(fl.Paths, "|") != strings.Join(want, "|") {
		t.Fatalf("Paths = %v, want %v", fl.Paths, want)
	}
}

func TestListFilesNonRepoReportsIsRepoFalse(t *testing.T) {
	fl, err := ListFiles(context.Background(), t.TempDir())
	if err != nil {
		t.Fatalf("non-repo must not error: %v", err)
	}
	if fl.IsRepo {
		t.Fatalf("IsRepo = true, want false")
	}
	if len(fl.Paths) != 0 {
		t.Fatalf("Paths = %v, want empty", fl.Paths)
	}
}
```

The `has space.go` case is the point of the `-z` flag: with newline separation git would quote that path as `"has space.go"` and the split would hand the frontend an unopenable name. The expected ordering is plain byte order — `.gitignore` (`.` = 0x2E) sorts before `a.go`, and `has space.go` before `sub/b.go` before `untracked.go`.

- [ ] **Step 2: Run the tests to verify they fail**

```powershell
$env:CGO_CFLAGS = "-O2 -g -I$((Get-Location).Path -replace '\\','/')/pkg/jarvisembed/csrc"
go test ./pkg/gitinfo/ -run TestListFiles -v
```

Expected: compile failure, `undefined: ListFiles`.

- [ ] **Step 3: Implement `ListFiles`**

Add `"sort"` to the import block in `pkg/gitinfo/gitinfo.go`, then append:

```go
// maxListFiles caps the enumeration so a pathological repo cannot hand the frontend a
// multi-megabyte path array. Truncated tells the caller it happened, because a silently
// partial index reads as a complete one.
const maxListFiles = 20000

// FileList is every path git knows about in cwd: tracked files plus untracked files that
// .gitignore does not exclude. Paths are repo-relative with forward slashes, sorted.
type FileList struct {
	Paths     []string `json:"paths"`
	IsRepo    bool     `json:"isrepo"`
	Truncated bool     `json:"truncated"`
}

// ListFiles enumerates cwd for the Code surface's tree and file finder. IsRepo=false when cwd is
// not a repository (not an error — it is an empty state); a git failure IS an error so the caller
// can tell "nothing to browse" from "the read failed".
func ListFiles(ctx context.Context, cwd string) (*FileList, error) {
	ctx, cancel := context.WithTimeout(ctx, gitTimeout)
	defer cancel()
	inside, err := run(ctx, cwd, "rev-parse", "--is-inside-work-tree")
	if err != nil || strings.TrimSpace(inside) != "true" {
		return &FileList{IsRepo: false}, nil
	}
	// -z: NUL-separated, so a path containing a space or non-ASCII byte survives unquoted.
	out, err := run(ctx, cwd, "ls-files", "--cached", "--others", "--exclude-standard", "-z")
	if err != nil {
		return nil, err
	}
	paths := []string{}
	for _, p := range strings.Split(out, "\x00") {
		if p != "" {
			paths = append(paths, p)
		}
	}
	// --cached and --others cannot overlap (others is untracked-only) but the concatenation is
	// not globally ordered, so sort for a stable tree.
	sort.Strings(paths)
	truncated := false
	if len(paths) > maxListFiles {
		paths = paths[:maxListFiles]
		truncated = true
	}
	return &FileList{Paths: paths, IsRepo: true, Truncated: truncated}, nil
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```powershell
go test ./pkg/gitinfo/ -run TestListFiles -v
```

Expected: both PASS.

- [ ] **Step 5: Stage**

```bash
git add pkg/gitinfo/gitinfo.go pkg/gitinfo/gitinfo_test.go
```

---

### Task 2: Expose it over RPC — `GitListFilesCommand`

**Files:**
- Modify: `pkg/wshrpc/wshrpctypes_git.go` (add the method to the `GitCommands` interface at lines 15-22; append the two data types)
- Modify: `pkg/wshrpc/wshserver/wshserver_git.go` (append the handler)
- Regenerated (do not hand-edit): `pkg/wshrpc/wshclient/wshclient.go`, `frontend/app/store/wshclientapi.ts`, `frontend/types/gotypes.d.ts`

**Interfaces:**
- Consumes: `gitinfo.ListFiles` from Task 1
- Produces: `RpcApi.GitListFilesCommand(client, { cwd })` returning `{ files: string[]; isrepo: boolean; truncated?: boolean }`, callable from the frontend as `RpcApi.GitListFilesCommand(TabRpcClient, { cwd })`

- [ ] **Step 1: Add the interface method and data types**

In `pkg/wshrpc/wshrpctypes_git.go`, add to the `GitCommands` interface:

```go
	GitListFilesCommand(ctx context.Context, data CommandGitListFilesData) (*CommandGitListFilesRtnData, error)
```

and append the types:

```go
type CommandGitListFilesData struct {
	Cwd string `json:"cwd"`
}

// Files are repo-relative, forward-slashed, sorted. Truncated reports that the repo exceeded the
// server's cap and Files is a prefix, so the finder can say so instead of implying completeness.
type CommandGitListFilesRtnData struct {
	Files     []string `json:"files"`
	IsRepo    bool     `json:"isrepo"`
	Truncated bool     `json:"truncated,omitempty"`
}
```

- [ ] **Step 2: Add the server handler**

Append to `pkg/wshrpc/wshserver/wshserver_git.go`, matching the shape of `GitHistoryCommand` directly above it:

```go
func (ws *WshServer) GitListFilesCommand(ctx context.Context, data wshrpc.CommandGitListFilesData) (*wshrpc.CommandGitListFilesRtnData, error) {
	fl, err := gitinfo.ListFiles(ctx, data.Cwd)
	if err != nil {
		return nil, err
	}
	return &wshrpc.CommandGitListFilesRtnData{Files: fl.Paths, IsRepo: fl.IsRepo, Truncated: fl.Truncated}, nil
}
```

- [ ] **Step 3: Verify the backend compiles**

```powershell
$env:CGO_CFLAGS = "-O2 -g -I$((Get-Location).Path -replace '\\','/')/pkg/jarvisembed/csrc"
go build ./pkg/...
```

Expected: exit 0. A non-zero exit here usually means the interface method and the handler signature disagree.

- [ ] **Step 4: Regenerate the clients**

```bash
task generate
```

- [ ] **Step 5: Verify the generated clients gained the command**

```bash
git diff --stat frontend/app/store/wshclientapi.ts pkg/wshrpc/wshclient/wshclient.go frontend/types/gotypes.d.ts
```

Expected: all three files modified. Then confirm the wire name resolved to `gitlistfiles`:

```bash
grep -n "GitListFilesCommand" frontend/app/store/wshclientapi.ts
```

Expected: a method calling `client.wshRpcCall("gitlistfiles", data, opts)`.

- [ ] **Step 6: Stage**

```bash
git add pkg/wshrpc/wshrpctypes_git.go pkg/wshrpc/wshserver/wshserver_git.go pkg/wshrpc/wshclient/wshclient.go frontend/app/store/wshclientapi.ts frontend/types/gotypes.d.ts
```

---

### Task 3: Pure module — `codetree.ts`

**Files:**
- Create: `frontend/app/view/code/codetree.ts`
- Test: `frontend/app/view/code/codetree.test.ts`

**Interfaces:**
- Consumes: nothing (no imports beyond types)
- Produces: `TreeNode`, `TreeRow`, `buildTree(paths)`, `visibleRows(tree, expanded)`, `ancestorsOf(path)`

- [ ] **Step 1: Write the failing tests**

```ts
// frontend/app/view/code/codetree.test.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { ancestorsOf, buildTree, visibleRows } from "./codetree";

const PATHS = ["README.md", "src/app/main.ts", "src/app/util.ts", "src/lib.ts", "docs/a/b/c.md"];

describe("buildTree", () => {
    it("puts directories before files, each alphabetically", () => {
        const tree = buildTree(PATHS);
        expect(tree.map((n) => n.name)).toEqual(["docs", "src", "README.md"]);
        expect(tree.map((n) => n.isDir)).toEqual([true, true, false]);
    });

    it("nests children under their directory with full repo-relative paths", () => {
        const tree = buildTree(PATHS);
        const src = tree.find((n) => n.name === "src");
        expect(src?.children.map((n) => n.path)).toEqual(["src/app", "src/lib.ts"]);
    });

    it("keeps a deep single-child chain intact", () => {
        const tree = buildTree(["docs/a/b/c.md"]);
        expect(tree[0].children[0].children[0].path).toBe("docs/a/b/c.md");
    });

    it("handles a flat list with no directories", () => {
        expect(buildTree(["b.ts", "a.ts"]).map((n) => n.name)).toEqual(["a.ts", "b.ts"]);
    });

    it("returns an empty array for an empty repo", () => {
        expect(buildTree([])).toEqual([]);
    });
});

describe("visibleRows", () => {
    it("shows only top-level rows when nothing is expanded", () => {
        const rows = visibleRows(buildTree(PATHS), new Set());
        expect(rows.map((r) => r.path)).toEqual(["docs", "src", "README.md"]);
        expect(rows.every((r) => r.depth === 0)).toBe(true);
    });

    it("reveals the children of an expanded directory and marks it expanded", () => {
        const rows = visibleRows(buildTree(PATHS), new Set(["src"]));
        expect(rows.map((r) => r.path)).toEqual(["docs", "src", "src/app", "src/lib.ts", "README.md"]);
        expect(rows.find((r) => r.path === "src")?.expanded).toBe(true);
        expect(rows.find((r) => r.path === "src/app")?.depth).toBe(1);
    });

    it("does not reveal grandchildren unless the intermediate directory is also expanded", () => {
        const rows = visibleRows(buildTree(PATHS), new Set(["src", "src/app"]));
        expect(rows.map((r) => r.path)).toContain("src/app/main.ts");
        const shallow = visibleRows(buildTree(PATHS), new Set(["src"]));
        expect(shallow.map((r) => r.path)).not.toContain("src/app/main.ts");
    });
});

describe("ancestorsOf", () => {
    it("lists every directory above a file, outermost first", () => {
        expect(ancestorsOf("docs/a/b/c.md")).toEqual(["docs", "docs/a", "docs/a/b"]);
    });

    it("returns nothing for a root-level file", () => {
        expect(ancestorsOf("README.md")).toEqual([]);
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx vitest run frontend/app/view/code/codetree.test.ts
```

Expected: FAIL — cannot resolve `./codetree`.

- [ ] **Step 3: Implement `codetree.ts`**

```ts
// frontend/app/view/code/codetree.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pure: turn the flat, forward-slashed path list from `git ls-files` into the tree the Code surface
// renders, and flatten that tree to rows given a set of expanded directories. No React, no IO.

export interface TreeNode {
    name: string;
    path: string; // repo-relative, forward slashes
    isDir: boolean;
    children: TreeNode[];
}

export interface TreeRow {
    kind: "dir" | "file";
    path: string;
    name: string;
    depth: number;
    expanded: boolean; // always false on a file row
}

export function buildTree(paths: readonly string[]): TreeNode[] {
    const root: TreeNode = { name: "", path: "", isDir: true, children: [] };
    // path -> node, so a directory with thousands of siblings costs a lookup, not a scan
    const index = new Map<string, TreeNode>();
    for (const p of paths) {
        const segs = p.split("/").filter((s) => s !== "");
        let parent = root;
        segs.forEach((seg, i) => {
            const path = parent.path === "" ? seg : `${parent.path}/${seg}`;
            let node = index.get(path);
            if (node == null) {
                node = { name: seg, path, isDir: i < segs.length - 1, children: [] };
                parent.children.push(node);
                index.set(path, node);
            }
            parent = node;
        });
    }
    sortNodes(root);
    return root.children;
}

function sortNodes(node: TreeNode): void {
    node.children.sort((a, b) => {
        if (a.isDir !== b.isDir) {
            return a.isDir ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
    });
    for (const child of node.children) {
        sortNodes(child);
    }
}

export function visibleRows(tree: readonly TreeNode[], expanded: ReadonlySet<string>): TreeRow[] {
    const rows: TreeRow[] = [];
    const walk = (nodes: readonly TreeNode[], depth: number) => {
        for (const n of nodes) {
            const isOpen = n.isDir && expanded.has(n.path);
            rows.push({
                kind: n.isDir ? "dir" : "file",
                path: n.path,
                name: n.name,
                depth,
                expanded: isOpen,
            });
            if (isOpen) {
                walk(n.children, depth + 1);
            }
        }
    };
    walk(tree, 0);
    return rows;
}

// the directories that must be expanded for `path` to be visible — the finder opens files in
// collapsed subtrees, and the tree should show where you landed.
export function ancestorsOf(path: string): string[] {
    const segs = path.split("/").filter((s) => s !== "");
    const out: string[] = [];
    for (let i = 1; i < segs.length; i++) {
        out.push(segs.slice(0, i).join("/"));
    }
    return out;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run frontend/app/view/code/codetree.test.ts
```

Expected: all PASS.

- [ ] **Step 5: Stage**

```bash
git add frontend/app/view/code/codetree.ts frontend/app/view/code/codetree.test.ts
```

---

### Task 4: Pure module — `codefinder.ts`

**Files:**
- Create: `frontend/app/view/code/codefinder.ts`
- Test: `frontend/app/view/code/codefinder.test.ts`

**Interfaces:**
- Consumes: `fuzzyScore(query, text): number | null` from `@/app/cockpit/palette-match`
- Produces: `FinderMatch { path: string; score: number }`, `rankPaths(query, paths, limit): FinderMatch[]`

- [ ] **Step 1: Write the failing tests**

```ts
// frontend/app/view/code/codefinder.test.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { rankPaths } from "./codefinder";

describe("rankPaths", () => {
    it("ranks a basename hit above a match scattered through directory names", () => {
        const paths = ["a/g/e/n/t/r/o/w/other.ts", "frontend/app/view/agents/agentrow.tsx"];
        expect(rankPaths("agentrow", paths, 10)[0].path).toBe("frontend/app/view/agents/agentrow.tsx");
    });

    it("still matches on directory names when the basename does not match", () => {
        const paths = ["frontend/app/view/agents/row.tsx"];
        expect(rankPaths("agents", paths, 10).map((m) => m.path)).toEqual(["frontend/app/view/agents/row.tsx"]);
    });

    it("drops paths the query cannot match at all", () => {
        expect(rankPaths("zzz", ["src/main.ts"], 10)).toEqual([]);
    });

    it("is case-insensitive", () => {
        expect(rankPaths("MAIN", ["src/main.ts"], 10)).toHaveLength(1);
    });

    it("returns the first paths unranked for an empty query", () => {
        const paths = ["b.ts", "a.ts", "c.ts"];
        expect(rankPaths("", paths, 2).map((m) => m.path)).toEqual(["b.ts", "a.ts"]);
    });

    it("treats a whitespace-only query as empty", () => {
        expect(rankPaths("   ", ["b.ts", "a.ts"], 1).map((m) => m.path)).toEqual(["b.ts"]);
    });

    it("honors the limit", () => {
        const paths = ["m1.ts", "m2.ts", "m3.ts", "m4.ts"];
        expect(rankPaths("m", paths, 2)).toHaveLength(2);
    });

    it("breaks score ties by path so the order is stable", () => {
        const ranked = rankPaths("m", ["z/m.ts", "a/m.ts"], 10);
        expect(ranked[0].path).toBe("a/m.ts");
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx vitest run frontend/app/view/code/codefinder.test.ts
```

Expected: FAIL — cannot resolve `./codefinder`.

- [ ] **Step 3: Implement `codefinder.ts`**

```ts
// frontend/app/view/code/codefinder.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pure: rank repo-relative paths against a query for the Code surface's file finder. Reuses the
// command palette's matcher rather than growing a second fuzzy implementation.

import { fuzzyScore } from "@/app/cockpit/palette-match";

export interface FinderMatch {
    path: string;
    score: number;
}

// a basename hit is almost always what you meant. fuzzyScore reports no matched span, so this
// cannot be a bonus applied to part of the full-path score — basename is scored separately and
// the better of the two wins.
const BASENAME_BONUS = 20;

export function rankPaths(query: string, paths: readonly string[], limit: number): FinderMatch[] {
    const q = query.trim();
    if (q === "") {
        return paths.slice(0, limit).map((path) => ({ path, score: 0 }));
    }
    const out: FinderMatch[] = [];
    for (const path of paths) {
        const slash = path.lastIndexOf("/");
        const base = slash === -1 ? path : path.slice(slash + 1);
        const baseScore = fuzzyScore(q, base);
        const pathScore = fuzzyScore(q, path);
        let score: number | null = null;
        if (baseScore != null) {
            score = baseScore + BASENAME_BONUS;
        }
        if (pathScore != null && (score == null || pathScore > score)) {
            score = pathScore;
        }
        if (score != null) {
            out.push({ path, score });
        }
    }
    out.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
    return out.slice(0, limit);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run frontend/app/view/code/codefinder.test.ts
```

Expected: all PASS.

- [ ] **Step 5: Stage**

```bash
git add frontend/app/view/code/codefinder.ts frontend/app/view/code/codefinder.test.ts
```

---

### Task 5: Pure module — `codehistory.ts`

**Files:**
- Create: `frontend/app/view/code/codehistory.ts`
- Test: `frontend/app/view/code/codehistory.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `History { stack: string[]; idx: number }`, `EMPTY_HISTORY`, `push`, `back`, `forward`, `canBack`, `canForward`, `currentPath`

- [ ] **Step 1: Write the failing tests**

```ts
// frontend/app/view/code/codehistory.test.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { back, canBack, canForward, currentPath, EMPTY_HISTORY, forward, push } from "./codehistory";

const three = () => push(push(push(EMPTY_HISTORY, "a.ts"), "b.ts"), "c.ts");

describe("codehistory", () => {
    it("starts empty with nothing to walk", () => {
        expect(currentPath(EMPTY_HISTORY)).toBeNull();
        expect(canBack(EMPTY_HISTORY)).toBe(false);
        expect(canForward(EMPTY_HISTORY)).toBe(false);
    });

    it("pushes onto the end and points at the newest entry", () => {
        const h = three();
        expect(h.stack).toEqual(["a.ts", "b.ts", "c.ts"]);
        expect(currentPath(h)).toBe("c.ts");
    });

    it("ignores re-opening the file already shown", () => {
        const h = push(push(EMPTY_HISTORY, "a.ts"), "a.ts");
        expect(h.stack).toEqual(["a.ts"]);
    });

    it("walks back and forward over the stack", () => {
        const h = back(back(three()));
        expect(currentPath(h)).toBe("a.ts");
        expect(currentPath(forward(h))).toBe("b.ts");
    });

    it("clamps at both ends instead of going out of range", () => {
        const h = three();
        expect(currentPath(back(back(back(back(h)))))).toBe("a.ts");
        expect(currentPath(forward(h))).toBe("c.ts");
    });

    it("truncates the forward tail when pushing after going back", () => {
        const h = push(back(three()), "d.ts");
        expect(h.stack).toEqual(["a.ts", "b.ts", "d.ts"]);
        expect(canForward(h)).toBe(false);
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx vitest run frontend/app/view/code/codehistory.test.ts
```

Expected: FAIL — cannot resolve `./codehistory`.

- [ ] **Step 3: Implement `codehistory.ts`**

```ts
// frontend/app/view/code/codehistory.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pure: the Code surface's back/forward stack over opened file paths. An array and an index —
// deliberately not open-file tabs (see the design spec, decision 5).

export interface History {
    stack: string[];
    idx: number; // -1 when the stack is empty
}

export const EMPTY_HISTORY: History = { stack: [], idx: -1 };

// pushing while parked mid-stack drops everything ahead, the way a browser does
export function push(h: History, path: string): History {
    if (h.idx >= 0 && h.stack[h.idx] === path) {
        return h; // re-opening what is already shown is not a move
    }
    const stack = [...h.stack.slice(0, h.idx + 1), path];
    return { stack, idx: stack.length - 1 };
}

export function back(h: History): History {
    return canBack(h) ? { stack: h.stack, idx: h.idx - 1 } : h;
}

export function forward(h: History): History {
    return canForward(h) ? { stack: h.stack, idx: h.idx + 1 } : h;
}

export function canBack(h: History): boolean {
    return h.idx > 0;
}

export function canForward(h: History): boolean {
    return h.idx >= 0 && h.idx < h.stack.length - 1;
}

export function currentPath(h: History): string | null {
    return h.idx >= 0 ? h.stack[h.idx] : null;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run frontend/app/view/code/codehistory.test.ts
```

Expected: all PASS.

- [ ] **Step 5: Stage**

```bash
git add frontend/app/view/code/codehistory.ts frontend/app/view/code/codehistory.test.ts
```

---

### Task 6: Pure module — `codeclassify.ts`

**Files:**
- Create: `frontend/app/view/code/codeclassify.ts`
- Test: `frontend/app/view/code/codeclassify.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `MAX_VIEW_BYTES`, `FileClass = "text" | "binary" | "toolarge"`, `classifyFile(size, mimeType): FileClass`, `hasNulByte(text): boolean`

- [ ] **Step 1: Write the failing tests**

```ts
// frontend/app/view/code/codeclassify.test.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { classifyFile, hasNulByte, MAX_VIEW_BYTES } from "./codeclassify";

describe("classifyFile", () => {
    it("treats an unrecognized (empty) mimetype as text, because Go and Rust land there", () => {
        expect(classifyFile(1000, "")).toBe("text");
    });

    it("accepts any text/* type", () => {
        expect(classifyFile(1000, "text/x-python")).toBe("text");
    });

    it("accepts the application/* types that are really text", () => {
        expect(classifyFile(1000, "application/json")).toBe("text");
        expect(classifyFile(1000, "application/javascript")).toBe("text");
    });

    it("ignores a charset parameter on the mimetype", () => {
        expect(classifyFile(1000, "text/plain; charset=utf-8")).toBe("text");
    });

    it("calls a real binary type binary", () => {
        expect(classifyFile(1000, "image/png")).toBe("binary");
        expect(classifyFile(1000, "application/octet-stream")).toBe("binary");
    });

    it("lets the size gate win over a text mimetype", () => {
        expect(classifyFile(MAX_VIEW_BYTES + 1, "text/plain")).toBe("toolarge");
    });

    it("admits a file exactly at the cap", () => {
        expect(classifyFile(MAX_VIEW_BYTES, "text/plain")).toBe("text");
    });
});

describe("hasNulByte", () => {
    it("is false for ordinary source text", () => {
        expect(hasNulByte("package main\n\nfunc main() {}\n")).toBe(false);
    });

    it("is true when a NUL appears in the scanned head", () => {
        expect(hasNulByte("abc\u0000def")).toBe(true);
    });

    it("does not scan past the head window", () => {
        expect(hasNulByte("a".repeat(9000) + "\u0000")).toBe(false);
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx vitest run frontend/app/view/code/codeclassify.test.ts
```

Expected: FAIL — cannot resolve `./codeclassify`.

- [ ] **Step 3: Implement `codeclassify.ts`**

```ts
// frontend/app/view/code/codeclassify.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pure: decide how an opened file should be presented, from its stat and (as a backstop) its
// decoded content. Keeps the size and binary gates out of the store's IO path.

export const MAX_VIEW_BYTES = 2 * 1024 * 1024;

// application/* types that are really text. Anything else outside text/* is binary.
const TEXTISH_MIME = new Set([
    "application/json",
    "application/javascript",
    "application/xml",
    "application/x-sh",
    "application/x-yaml",
    "application/yaml",
    "application/toml",
]);

export type FileClass = "text" | "binary" | "toolarge";

// an empty mimetype means the backend did not recognize the extension — Go, Rust and most config
// files land there, so empty must be viewable or the surface would call this repo binary.
export function classifyFile(size: number, mimeType: string): FileClass {
    if (size > MAX_VIEW_BYTES) {
        return "toolarge";
    }
    const m = (mimeType ?? "").split(";")[0].trim().toLowerCase();
    if (m === "" || m.startsWith("text/") || TEXTISH_MIME.has(m)) {
        return "text";
    }
    return "binary";
}

const NUL_SCAN_CHARS = 8192;

// backstop for a wrong or absent mimetype: real source text contains no NUL.
export function hasNulByte(text: string): boolean {
    return text.slice(0, NUL_SCAN_CHARS).includes("\u0000");
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run frontend/app/view/code/codeclassify.test.ts
```

Expected: all PASS.

- [ ] **Step 5: Stage**

```bash
git add frontend/app/view/code/codeclassify.ts frontend/app/view/code/codeclassify.test.ts
```

---

### Task 7: Shared path helper — `joinRepoPath`

**Files:**
- Create: `frontend/util/paths.ts`
- Test: `frontend/util/paths.test.ts`
- Modify: `frontend/app/view/agents/filessurface.tsx` (delete the local `joinPath` at lines 76-80, import the shared one, update its call sites) — **conditional, see Step 5**

**Interfaces:**
- Consumes: nothing
- Produces: `joinRepoPath(root: string, rel: string): string`

- [ ] **Step 1: Write the failing tests**

```ts
// frontend/util/paths.test.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { joinRepoPath } from "./paths";

describe("joinRepoPath", () => {
    it("joins a forward-slashed git path onto a backslashed Windows root", () => {
        expect(joinRepoPath("C:\\repo", "src/main.ts")).toBe("C:\\repo\\src\\main.ts");
    });

    it("normalizes a mixed-separator join to a single separator style", () => {
        expect(joinRepoPath("C:/repo", "src/main.ts")).toBe("C:\\repo\\src\\main.ts");
    });

    it("handles a root-level file", () => {
        expect(joinRepoPath("C:\\repo", "README.md")).toBe("C:\\repo\\README.md");
    });

    it("does not choke on a trailing separator on the root", () => {
        expect(joinRepoPath("C:\\repo\\", "a.ts")).toBe("C:\\repo\\a.ts");
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx vitest run frontend/util/paths.test.ts
```

Expected: FAIL — cannot resolve `./paths`.

- [ ] **Step 3: Implement `frontend/util/paths.ts`**

```ts
// frontend/util/paths.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Windows-only build: git reports repo-relative paths with forward slashes while a project root
// uses backslashes, so a raw `${root}/${rel}` join is mixed-separator. Normalizing the whole join
// to backslashes is what makes open::that (ShellExecute) resolve it and a copied absolute path a
// valid native Windows path.
export function joinRepoPath(root: string, rel: string): string {
    return `${root}/${rel}`.replace(/\/+/g, "\\").replace(/\\+/g, "\\");
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run frontend/util/paths.test.ts
```

Expected: all PASS. The trailing-separator case is why the second `replace` collapses runs — `C:\repo\` + `/a.ts` would otherwise produce a doubled separator.

- [ ] **Step 5: Retire the duplicate in the Diff surface — only if that file is clean**

This working tree is edited from parallel sessions. Check first:

```bash
git status --porcelain frontend/app/view/agents/filessurface.tsx
```

**If the output is empty**, replace the local helper. Delete this function (`frontend/app/view/agents/filessurface.tsx`, lines 76-80):

```ts
// Windows-only build: git reports repo-relative paths with forward slashes while cwd uses backslashes,
// so a raw `${cwd}/${path}` join is mixed-separator. Normalize the whole join to backslashes so
// open::that (ShellExecute) resolves it and a copied absolute path is a valid native Windows path.
function joinPath(cwd: string, rel: string): string {
    return `${cwd}/${rel}`.replace(/\//g, "\\");
}
```

add `import { joinRepoPath } from "@/util/paths";` to the import block, and rename every `joinPath(` call in that file to `joinRepoPath(`.

**If the output is non-empty**, skip this step entirely and leave the duplication — the spec sanctions that explicitly. Note the skip in the task's completion report.

- [ ] **Step 6: Verify nothing broke**

```bash
npx vitest run frontend/app/view/agents/
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit
```

Expected: tests PASS, typecheck exits 0.

- [ ] **Step 7: Stage**

```bash
git add frontend/util/paths.ts frontend/util/paths.test.ts
```

Add `frontend/app/view/agents/filessurface.tsx` to that command only if Step 5 was performed.

---

### Task 8: State and loaders — `codestore.ts`

**Files:**
- Create: `frontend/app/view/code/codestore.ts`

**Interfaces:**
- Consumes: `buildTree`/`ancestorsOf` (Task 3), `EMPTY_HISTORY`/`push`/`back`/`forward`/`currentPath` (Task 5), `classifyFile`/`hasNulByte` (Task 6), `joinRepoPath` (Task 7), `RpcApi.GitListFilesCommand` (Task 2)
- Produces: `CodeProject`, `CodeIndex`, `CodeFile`, the atoms `codeProjectAtom` / `codeIndexAtom` / `codeIndexErrorAtom` / `codeExpandedAtom` / `codeFileAtom` / `codeHistoryAtom` / `codeFinderOpenAtom`, and the actions `selectProject`, `refreshIndex`, `openPath`, `goBack`, `goForward`, `toggleDir`, `revealPath`

**No unit test.** This module is the IO shell — every decision it makes (tree shape, ranking, history moves, size and binary gates, path joining) lives in the pure modules already tested in Tasks 3-7. Its verification is the typecheck in Step 2 and the surface tasks that exercise it.

- [ ] **Step 1: Write `codestore.ts`**

```ts
// frontend/app/view/code/codestore.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Code-surface state + loaders. Every atom is module-scoped for the same reason filesstore.ts does
// it: the surface unmounts on nav switch, so component state would silently drop the whole session
// (selected project, expanded tree, history) every time you looked at something else.

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { base64ToString } from "@/util/util";
import { joinRepoPath } from "@/util/paths";
import { atom, type PrimitiveAtom } from "jotai";
import { ancestorsOf } from "./codetree";
import { classifyFile, hasNulByte } from "./codeclassify";
import { back, currentPath, EMPTY_HISTORY, forward, push, type History } from "./codehistory";

export interface CodeProject {
    name: string;
    path: string;
}

export interface CodeIndex {
    paths: string[];
    isRepo: boolean;
    truncated: boolean;
}

// One union rather than parallel loading/error/tooLarge booleans, so the viewer renders an
// exhaustive switch and cannot land in a contradictory pair of states.
export type CodeFile =
    | { kind: "none" }
    | { kind: "loading"; path: string }
    | { kind: "text"; path: string; text: string }
    | { kind: "binary"; path: string; size: number }
    | { kind: "toolarge"; path: string; size: number }
    | { kind: "missing"; path: string }
    | { kind: "error"; path: string; message: string };

export const codeProjectAtom = atom<CodeProject | null>(null) as PrimitiveAtom<CodeProject | null>;
export const codeIndexAtom = atom<CodeIndex | null>(null) as PrimitiveAtom<CodeIndex | null>;
export const codeIndexErrorAtom = atom<string | null>(null) as PrimitiveAtom<string | null>;
export const codeExpandedAtom = atom<Set<string>>(new Set<string>()) as PrimitiveAtom<Set<string>>;
export const codeFileAtom = atom<CodeFile>({ kind: "none" }) as PrimitiveAtom<CodeFile>;
export const codeHistoryAtom = atom<History>(EMPTY_HISTORY) as PrimitiveAtom<History>;
export const codeFinderOpenAtom = atom<boolean>(false) as PrimitiveAtom<boolean>;

// Returning to a project you already browsed should not re-shell out to git. Cleared per project
// by refreshIndex, which is the only way a new file appears (there is no watcher, by design).
const indexCache = new Map<string, CodeIndex>();

// guards a slow load against a newer one, same pattern as filesstore.ts
const current = { indexToken: "", fileToken: "" };

export async function selectProject(p: CodeProject | null): Promise<void> {
    globalStore.set(codeProjectAtom, p);
    globalStore.set(codeExpandedAtom, new Set<string>());
    globalStore.set(codeHistoryAtom, EMPTY_HISTORY);
    globalStore.set(codeFileAtom, { kind: "none" });
    globalStore.set(codeIndexErrorAtom, null);
    globalStore.set(codeIndexAtom, null);
    if (p == null) {
        current.indexToken = "";
        return;
    }
    await loadIndex(p);
}

async function loadIndex(p: CodeProject): Promise<void> {
    const token = `index:${p.path}`;
    current.indexToken = token;
    const cached = indexCache.get(p.path);
    if (cached != null) {
        globalStore.set(codeIndexAtom, cached);
        return;
    }
    try {
        const res = await RpcApi.GitListFilesCommand(TabRpcClient, { cwd: p.path });
        if (current.indexToken !== token) {
            return;
        }
        const idx: CodeIndex = {
            paths: res.files ?? [],
            isRepo: res.isrepo,
            truncated: res.truncated ?? false,
        };
        indexCache.set(p.path, idx);
        globalStore.set(codeIndexAtom, idx);
    } catch (e) {
        if (current.indexToken !== token) {
            return;
        }
        // a failed RPC is an error, not an empty repo — the Diff surface once conflated these
        globalStore.set(codeIndexErrorAtom, e instanceof Error ? e.message : String(e));
    }
}

export async function refreshIndex(): Promise<void> {
    const p = globalStore.get(codeProjectAtom);
    if (p == null) {
        return;
    }
    indexCache.delete(p.path);
    globalStore.set(codeIndexAtom, null);
    globalStore.set(codeIndexErrorAtom, null);
    await loadIndex(p);
}

export function toggleDir(path: string): void {
    const next = new Set(globalStore.get(codeExpandedAtom));
    if (next.has(path)) {
        next.delete(path);
    } else {
        next.add(path);
    }
    globalStore.set(codeExpandedAtom, next);
}

// expand everything above `path` so a finder jump into a collapsed subtree shows where you landed
export function revealPath(path: string): void {
    const next = new Set(globalStore.get(codeExpandedAtom));
    for (const dir of ancestorsOf(path)) {
        next.add(dir);
    }
    globalStore.set(codeExpandedAtom, next);
}

export async function openPath(rel: string, opts?: { pushHistory?: boolean }): Promise<void> {
    const project = globalStore.get(codeProjectAtom);
    if (project == null) {
        return;
    }
    if (opts?.pushHistory !== false) {
        globalStore.set(codeHistoryAtom, (h) => push(h, rel));
    }
    const token = `file:${rel}`;
    current.fileToken = token;
    globalStore.set(codeFileAtom, { kind: "loading", path: rel });
    const abs = joinRepoPath(project.path, rel);
    try {
        const info = await RpcApi.FileInfoCommand(TabRpcClient, { info: { path: abs } });
        if (current.fileToken !== token) {
            return;
        }
        if (info?.notfound) {
            // the index is a snapshot; this is the visible consequence of having no watcher
            globalStore.set(codeFileAtom, { kind: "missing", path: rel });
            return;
        }
        const size = info?.size ?? 0;
        const klass = classifyFile(size, info?.mimetype ?? "");
        if (klass === "toolarge") {
            globalStore.set(codeFileAtom, { kind: "toolarge", path: rel, size });
            return;
        }
        if (klass === "binary") {
            globalStore.set(codeFileAtom, { kind: "binary", path: rel, size });
            return;
        }
        const data = await RpcApi.FileReadCommand(TabRpcClient, { info: { path: abs } });
        if (current.fileToken !== token) {
            return;
        }
        const text = base64ToString(data?.data64 ?? "");
        if (hasNulByte(text)) {
            globalStore.set(codeFileAtom, { kind: "binary", path: rel, size });
            return;
        }
        globalStore.set(codeFileAtom, { kind: "text", path: rel, text });
    } catch (e) {
        if (current.fileToken !== token) {
            return;
        }
        globalStore.set(codeFileAtom, {
            kind: "error",
            path: rel,
            message: e instanceof Error ? e.message : String(e),
        });
    }
}

// back/forward re-read from disk rather than replaying cached text: simpler, and it shows the file
// as it is now rather than as it was when you first opened it.
export async function goBack(): Promise<void> {
    const next = back(globalStore.get(codeHistoryAtom));
    globalStore.set(codeHistoryAtom, next);
    const path = currentPath(next);
    if (path != null) {
        await openPath(path, { pushHistory: false });
    }
}

export async function goForward(): Promise<void> {
    const next = forward(globalStore.get(codeHistoryAtom));
    globalStore.set(codeHistoryAtom, next);
    const path = currentPath(next);
    if (path != null) {
        await openPath(path, { pushHistory: false });
    }
}
```

- [ ] **Step 2: Verify it typechecks**

```bash
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit
```

Expected: exit 0. If `info.mimetype` or `data.data64` are reported missing, check the generated `FileInfo` / `FileData` shapes in `frontend/types/gotypes.d.ts` and match the actual casing rather than changing the generated file.

- [ ] **Step 3: Stage**

```bash
git add frontend/app/view/code/codestore.ts
```

---

### Task 9: Register the surface and render its shell

**Files:**
- Create: `frontend/app/view/code/codesurface.tsx`
- Modify: `frontend/app/view/agents/agents.tsx` (`SurfaceKey` union at lines 29-38; `SURFACE_ORDER` at lines 42-51)
- Modify: `frontend/app/view/agents/navrail.tsx` (`ICON` at lines 15-25; `ITEMS` at lines 27-36)
- Modify: `frontend/app/view/agents/cockpitshell.tsx` (the surface chain at lines 100-116)
- Modify: `frontend/app/store/keybindings/bindings.ts` (`ESC_HOME_SURFACES` line 41; `GO_TARGETS` lines 25-33; the chord slice line 67)
- Modify: `scripts/cdp/attach.mjs` (`SURFACE_LABEL` lines 12-22)
- Modify: `scripts/cdp/scenarios.mjs` (`SMOKE_SURFACES` line 117)

**Interfaces:**
- Consumes: everything from Task 8; `SurfaceHeader` / `SurfaceEmptyState` / `SurfaceError` from `@/app/view/agents/surfacescaffold`; `projectsAtom` from `@/app/view/agents/projectsstore`; `PopoverReveal` from `@/app/element/popoverreveal`
- Produces: `CodeSurface({ model }: { model: AgentsViewModel })`, and the `SurfaceKey` value `"code"` used by later tasks

- [ ] **Step 1: Add the surface key and order**

In `frontend/app/view/agents/agents.tsx`, add `| "code"` to the `SurfaceKey` union (after `"usage"`, before `"settings"`), and append `"code"` as the ninth entry of `SURFACE_ORDER`:

```ts
export const SURFACE_ORDER: SurfaceKey[] = [
    "cockpit",
    "jarvis",
    "agent",
    "radar",
    "sessions",
    "files",
    "memory",
    "usage",
    "code",
];
```

Update the comment above `SURFACE_ORDER` from "Ctrl+1..8" to "Ctrl+1..9" and from "All 8 entries" to "All 9 entries".

Appending rather than inserting next to Diff is deliberate: every existing `Ctrl+1..8` keeps pointing at the surface it points at today.

- [ ] **Step 2: Add the rail entry**

In `frontend/app/view/agents/navrail.tsx`, add `FileCode2` to the existing `lucide-react` import, then add to `ICON`:

```ts
    code: <FileCode2 {...iconProps} />,
```

and append to `ITEMS`:

```ts
    { key: "code", label: "Code" },
```

- [ ] **Step 3: Write `codesurface.tsx`**

```tsx
// frontend/app/view/code/codesurface.tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Code surface: read any file in a registered git project. Read-only, and deliberately unconnected
// to agents and runs — this answers "what does this code look like", not "what changed".

import { PopoverReveal } from "@/app/element/popoverreveal";
import { globalStore } from "@/app/store/jotaiStore";
import type { AgentsViewModel } from "@/app/view/agents/agents";
import { projectsAtom } from "@/app/view/agents/projectsstore";
import { SurfaceEmptyState, SurfaceError, SurfaceHeader } from "@/app/view/agents/surfacescaffold";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { ChevronDown, FolderGit2, RotateCw } from "lucide-react";
import { useEffect, useState } from "react";
import { canBack, canForward } from "./codehistory";
import {
    codeHistoryAtom,
    codeIndexAtom,
    codeIndexErrorAtom,
    codeProjectAtom,
    goBack,
    goForward,
    refreshIndex,
    selectProject,
    type CodeProject,
} from "./codestore";

export function CodeSurface({ model }: { model: AgentsViewModel }) {
    const registry = useAtomValue(projectsAtom);
    const project = useAtomValue(codeProjectAtom);
    const index = useAtomValue(codeIndexAtom);
    const indexError = useAtomValue(codeIndexErrorAtom);
    const history = useAtomValue(codeHistoryAtom);
    const [pickerOpen, setPickerOpen] = useState(false);

    const projects: CodeProject[] = Object.entries(registry ?? {})
        .filter(([, v]) => v?.path)
        .map(([name, v]) => ({ name, path: v.path }))
        .sort((a, b) => a.name.localeCompare(b.name));

    // the index survives an unmount in a module atom, but a project picked before this surface ever
    // loaded (or a cache cleared elsewhere) leaves the atom null — reload on mount when that happens
    useEffect(() => {
        if (project != null && index == null && indexError == null) {
            fireAndForget(() => selectProject(project));
        }
    }, [project, index, indexError]);

    return (
        <div className="flex h-full w-full flex-col">
            <SurfaceHeader
                title="Code"
                subtitle={project != null ? `${project.name} · ${project.path}` : "No project selected"}
                actions={
                    <>
                        <div className="relative">
                            <button
                                type="button"
                                data-code-project-picker
                                onClick={() => setPickerOpen((v) => !v)}
                                className="flex cursor-pointer items-center gap-1.5 rounded-[8px] border border-border bg-surface px-2.5 py-1 text-[12px] text-secondary hover:text-primary"
                            >
                                <FolderGit2 size={13} strokeWidth={1.8} />
                                <span>{project?.name ?? "Pick a project"}</span>
                                <ChevronDown size={13} strokeWidth={1.8} />
                            </button>
                            <PopoverReveal
                                open={pickerOpen}
                                origin="top right"
                                className="absolute right-0 top-[calc(100%+6px)] z-20 min-w-[240px] overflow-hidden rounded-[10px] border border-border bg-surface shadow-lg"
                            >
                                {projects.length === 0 ? (
                                    <div className="px-3 py-2 text-[12px] text-muted">No registered projects</div>
                                ) : (
                                    projects.map((p) => (
                                        <button
                                            key={p.name}
                                            type="button"
                                            onClick={() => {
                                                setPickerOpen(false);
                                                fireAndForget(() => selectProject(p));
                                            }}
                                            className={cn(
                                                "flex w-full cursor-pointer flex-col items-start gap-0.5 px-3 py-2 text-left hover:bg-accent/10",
                                                p.path === project?.path && "bg-accent/10"
                                            )}
                                        >
                                            <span className="text-[12.5px] text-primary">{p.name}</span>
                                            <span className="font-mono text-[10.5px] text-muted">{p.path}</span>
                                        </button>
                                    ))
                                )}
                            </PopoverReveal>
                        </div>
                        <HeaderButton label="Refresh index" onClick={() => fireAndForget(refreshIndex)}>
                            <RotateCw size={13} strokeWidth={1.8} />
                        </HeaderButton>
                        <HeaderButton
                            label="Back"
                            disabled={!canBack(history)}
                            onClick={() => fireAndForget(goBack)}
                        >
                            ←
                        </HeaderButton>
                        <HeaderButton
                            label="Forward"
                            disabled={!canForward(history)}
                            onClick={() => fireAndForget(goForward)}
                        >
                            →
                        </HeaderButton>
                    </>
                }
            />
            {indexError != null ? (
                <SurfaceError message={`Could not list files: ${indexError}`} onRetry={() => fireAndForget(refreshIndex)} />
            ) : null}
            <div className="min-h-0 flex-1">
                <CodeBody model={model} onPickProject={() => setPickerOpen(true)} />
            </div>
        </div>
    );
}

function HeaderButton({
    label,
    onClick,
    disabled,
    children,
}: {
    label: string;
    onClick: () => void;
    disabled?: boolean;
    children: React.ReactNode;
}) {
    return (
        <button
            type="button"
            aria-label={label}
            title={label}
            disabled={disabled}
            onClick={onClick}
            className="flex h-[26px] w-[26px] cursor-pointer items-center justify-center rounded-[8px] border border-border bg-surface text-[12px] text-secondary hover:text-primary disabled:cursor-default disabled:opacity-40"
        >
            {children}
        </button>
    );
}

function CodeBody({ model, onPickProject }: { model: AgentsViewModel; onPickProject: () => void }) {
    const registry = useAtomValue(projectsAtom);
    const project = useAtomValue(codeProjectAtom);
    const index = useAtomValue(codeIndexAtom);
    const indexError = useAtomValue(codeIndexErrorAtom);

    if (Object.keys(registry ?? {}).length === 0) {
        return (
            <SurfaceEmptyState
                title="No registered projects"
                body="Register a project in Settings to browse its source here."
            />
        );
    }
    if (project == null) {
        return (
            <SurfaceEmptyState
                title="No project selected"
                body="Pick a project to browse its files."
                action={{ label: "Pick a project", onClick: onPickProject }}
            />
        );
    }
    if (indexError != null) {
        return null; // the banner above already says it, and a second message would double up
    }
    if (index == null) {
        return <SurfaceEmptyState title="Listing files…" />;
    }
    if (!index.isRepo) {
        return <SurfaceEmptyState title="Not a git repository" body={project.path} />;
    }
    return <CodePanes model={model} />;
}

// Task 10 replaces this with the tree pane and the viewer.
function CodePanes({ model }: { model: AgentsViewModel }) {
    const index = useAtomValue(codeIndexAtom);
    void model;
    return (
        <div className="px-[28px] py-4 text-[12.5px] text-secondary">
            {index?.paths.length ?? 0} files
        </div>
    );
}
```

- [ ] **Step 4: Render it from the shell**

In `frontend/app/view/agents/cockpitshell.tsx`, add the import:

```ts
import { CodeSurface } from "@/app/view/code/codesurface";
```

and a branch in the chain, after the `memory` branch and before `settings`:

```tsx
                        ) : surface === "code" ? (
                            <CodeSurface model={model} />
```

- [ ] **Step 5: Widen the chord slice, add the teleport and the Escape home**

In `frontend/app/store/keybindings/bindings.ts`:

Line 67 — `SURFACE_ORDER.slice(0, 8)` becomes `SURFACE_ORDER.slice(0, 9)`, so `Ctrl+9` binds to the new surface. Update the adjacent comment from `Ctrl+1..8` to `Ctrl+1..9`.

`GO_TARGETS` — append (`g c` is Jarvis and `g f` is Diff, so `b` for "browse"):

```ts
    { letter: "b", surface: "code", label: "Code (browse source)" },
```

`ESC_HOME_SURFACES` (line 41) — add `"code"`:

```ts
const ESC_HOME_SURFACES = new Set<SurfaceKey>(["jarvis", "radar", "sessions", "files", "memory", "usage", "code"]);
```

- [ ] **Step 6: Add the surface to the CDP smoke run**

In `scripts/cdp/attach.mjs`, add to `SURFACE_LABEL`:

```js
    code: "Code",
```

In `scripts/cdp/scenarios.mjs`, add `"code"` to `SMOKE_SURFACES` (line 117):

```js
const SMOKE_SURFACES = ["cockpit", "jarvis", "radar", "usage", "memory", "files", "settings", "code"];
```

Do not run Prettier over either file — `.editorconfig` omits `.mjs`, so `--write` reindents the whole file to 2 spaces. Hand-format to 4 spaces.

- [ ] **Step 7: Verify**

```bash
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit
npx vitest run frontend/app/store/keybindings/
```

Expected: typecheck exits 0; keybinding tests PASS. If `bindings.test.ts` asserts a surface count or a chord list, update the expectation — a ninth surface legitimately changes it.

Then, with the dev app running (`task dev`):

```bash
task verify:ui -- surface-smoke
```

Expected: a PASS row for `goto code -> active nav "Code", content non-empty`. The empty state supplies the text that makes `contentLen > 0` true even with no project selected.

- [ ] **Step 8: Stage**

```bash
git add frontend/app/view/code/codesurface.tsx frontend/app/view/agents/agents.tsx frontend/app/view/agents/navrail.tsx frontend/app/view/agents/cockpitshell.tsx frontend/app/store/keybindings/bindings.ts scripts/cdp/attach.mjs scripts/cdp/scenarios.mjs
```

---

### Task 10: Tree pane and the Monaco viewer

**Files:**
- Create: `frontend/app/view/code/codetreepane.tsx`
- Create: `frontend/app/view/code/codeviewer.tsx`
- Modify: `frontend/app/view/code/codesurface.tsx` (replace the placeholder `CodePanes` written in Task 9)

**Interfaces:**
- Consumes: `visibleRows`/`buildTree` (Task 3), the atoms and actions from `codestore.ts` (Task 8), `useSurfaceListNav` from `@/app/store/keybindings/listnav`, `CodeEditor` from `@/app/view/codeeditor/codeeditor`
- Produces: `CodeTreePane({ model })`, `CodeViewer({ model })`

- [ ] **Step 1: Write `codetreepane.tsx`**

```tsx
// frontend/app/view/code/codetreepane.tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The directory tree, built from the same flat path list the finder indexes — one source of truth,
// so the two can never disagree about what exists.

import { useSurfaceListNav } from "@/app/store/keybindings/listnav";
import type { AgentsViewModel } from "@/app/view/agents/agents";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { ChevronDown, ChevronRight, File } from "lucide-react";
import { useMemo } from "react";
import { buildTree, visibleRows } from "./codetree";
import { codeExpandedAtom, codeFileAtom, codeIndexAtom, openPath, toggleDir } from "./codestore";

export function CodeTreePane({ model }: { model: AgentsViewModel }) {
    void model;
    const index = useAtomValue(codeIndexAtom);
    const expanded = useAtomValue(codeExpandedAtom);
    const file = useAtomValue(codeFileAtom);
    const selected = file.kind === "none" ? null : file.path;

    const tree = useMemo(() => buildTree(index?.paths ?? []), [index]);
    const rows = useMemo(() => visibleRows(tree, expanded), [tree, expanded]);

    // Enter on a directory expands it, on a file opens it — the cursor IS the selection, so the
    // shared j/k/arrow bindings drive this without the pane owning any keys of its own.
    useSurfaceListNav(
        useMemo(
            () => ({
                surface: "code" as const,
                navigableIds: rows.map((r) => r.path),
                cursorId: selected ?? rows[0]?.path,
                setCursor: (id: string) => {
                    const row = rows.find((r) => r.path === id);
                    if (row?.kind === "file") {
                        fireAndForget(() => openPath(id));
                    }
                },
                activate: () => {
                    const row = rows.find((r) => r.path === selected);
                    if (row?.kind === "dir") {
                        toggleDir(row.path);
                    }
                },
            }),
            [rows, selected]
        )
    );

    return (
        <div className="h-full overflow-y-auto border-r border-border py-2">
            {rows.map((row) => (
                <button
                    key={row.path}
                    type="button"
                    onClick={() =>
                        row.kind === "dir" ? toggleDir(row.path) : fireAndForget(() => openPath(row.path))
                    }
                    style={{ paddingLeft: 8 + row.depth * 12 }}
                    className={cn(
                        "flex w-full cursor-pointer items-center gap-1.5 py-[3px] pr-2 text-left text-[12.5px] text-secondary hover:bg-accent/10 hover:text-primary",
                        row.path === selected && "bg-accent/10 text-accent-soft"
                    )}
                >
                    {row.kind === "dir" ? (
                        row.expanded ? (
                            <ChevronDown size={13} strokeWidth={1.8} className="flex-none" />
                        ) : (
                            <ChevronRight size={13} strokeWidth={1.8} className="flex-none" />
                        )
                    ) : (
                        <File size={13} strokeWidth={1.8} className="flex-none opacity-50" />
                    )}
                    <span className="truncate">{row.name}</span>
                </button>
            ))}
        </div>
    );
}
```

- [ ] **Step 2: Write `codeviewer.tsx`**

```tsx
// frontend/app/view/code/codeviewer.tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Renders whichever variant the store resolved the opened file to. The text case hands off to the
// existing read-only Monaco wrapper, which derives the language from the filename — so Go, Rust and
// TypeScript all highlight without a language map here.

import type { AgentsViewModel } from "@/app/view/agents/agents";
import { SurfaceEmptyState } from "@/app/view/agents/surfacescaffold";
import { CodeEditor } from "@/app/view/codeeditor/codeeditor";
import { useAtomValue } from "jotai";
import { codeFileAtom, codeProjectAtom, refreshIndex } from "./codestore";
import { joinRepoPath } from "@/util/paths";
import { fireAndForget } from "@/util/util";

function sizeLabel(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function CodeViewer({ model }: { model: AgentsViewModel }) {
    const file = useAtomValue(codeFileAtom);
    const project = useAtomValue(codeProjectAtom);

    switch (file.kind) {
        case "none":
            return <SurfaceEmptyState title="No file open" body="Pick a file from the tree, or press f to search by name." />;
        case "loading":
            return <SurfaceEmptyState title="Opening…" body={file.path} />;
        case "missing":
            return (
                <SurfaceEmptyState
                    title="File no longer exists"
                    body={`${file.path} — the file list is a snapshot, so it can fall behind.`}
                    action={{ label: "Refresh index", onClick: () => fireAndForget(refreshIndex) }}
                />
            );
        case "binary":
            return <SurfaceEmptyState title="Binary file" body={`${file.path} — ${sizeLabel(file.size)}`} />;
        case "toolarge":
            return (
                <SurfaceEmptyState
                    title="File too large to display"
                    body={`${file.path} — ${sizeLabel(file.size)}`}
                    action={{
                        label: "Copy path",
                        onClick: () => {
                            if (project != null) {
                                void navigator.clipboard?.writeText(joinRepoPath(project.path, file.path));
                            }
                        },
                    }}
                />
            );
        case "error":
            return <SurfaceEmptyState title="Could not read the file" body={`${file.path} — ${file.message}`} />;
        case "text":
            return (
                <CodeEditor
                    key={file.path}
                    blockId={model.blockId}
                    text={file.text}
                    fileName={file.path}
                    readonly
                />
            );
    }
}
```

- [ ] **Step 3: Replace the placeholder in `codesurface.tsx`**

Delete the `CodePanes` function written in Task 9 and replace it with:

```tsx
function CodePanes({ model }: { model: AgentsViewModel }) {
    return (
        <div className="flex h-full w-full">
            <div className="w-[280px] flex-none">
                <CodeTreePane model={model} />
            </div>
            <div className="min-w-0 flex-1">
                <CodeViewer model={model} />
            </div>
        </div>
    );
}
```

Add the two imports and drop the now-unused `codeIndexAtom` read inside the old placeholder if it becomes unreferenced:

```ts
import { CodeTreePane } from "./codetreepane";
import { CodeViewer } from "./codeviewer";
```

- [ ] **Step 4: Verify**

```bash
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit
npx eslint frontend/app/view/code/
```

Expected: both clean.

- [ ] **Step 5: Verify in the live app**

With `task dev` running, screenshot the surface and confirm three things by eye: the tree lists directories before files, clicking a `.go` file shows Go keyword coloring (proving Monaco's basic-languages grammars loaded), and the pane does not scroll horizontally at the window's default width.

```bash
node scripts/cdp-shot.mjs cdp-shots/code-surface.png
```

**Risk flagged in the spec, resolve it here:** `CodeEditor` reads editor preferences through `useOverrideConfigAtom(blockId, …)` and has only ever been used with a real editor block. If the viewer renders blank or throws, that call is the first suspect — check the browser console over CDP before changing anything else.

- [ ] **Step 6: Stage**

```bash
git add frontend/app/view/code/codetreepane.tsx frontend/app/view/code/codeviewer.tsx frontend/app/view/code/codesurface.tsx
```

---

### Task 11: File finder and keyboard bindings

**Files:**
- Create: `frontend/app/view/code/codefinderpalette.tsx`
- Modify: `frontend/app/view/code/codesurface.tsx` (mount the palette)
- Modify: `frontend/app/store/keybindings/bindings.ts` (add `buildCodeBindings`; add the finder to the go-home guard)

Note on registration: there is **no central binding registry**. Each surface registers its own bindings from inside its component — `filessurface.tsx:435-436` does `const filesBindings = useMemo(() => buildFilesBindings(), []); useKeybindings(filesBindings);`. Step 3 below follows that exactly, in `codesurface.tsx`.

Note on key syntax: `Alt` is a recognized modifier in the key-string parser (`frontend/util/keyutil.ts:96,102`), and `Alt:ArrowLeft` takes the same `Mod:Key` form as the existing `Shift:ArrowLeft` entries in that file.

**Interfaces:**
- Consumes: `rankPaths` (Task 4), `codeFinderOpenAtom` / `codeIndexAtom` / `openPath` / `revealPath` (Task 8)
- Produces: `CodeFinderPalette()`, `buildCodeBindings(): Binding[]`

- [ ] **Step 1: Write `codefinderpalette.tsx`**

```tsx
// frontend/app/view/code/codefinderpalette.tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Fuzzy open-by-name over the same flat path list the tree is built from. Opening a file inside a
// collapsed subtree expands its ancestors, so the tree shows where you landed.

import { globalStore } from "@/app/store/jotaiStore";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect, useMemo, useRef, useState } from "react";
import { rankPaths } from "./codefinder";
import { codeFinderOpenAtom, codeIndexAtom, openPath, revealPath } from "./codestore";

const MAX_RESULTS = 50;

export function CodeFinderPalette() {
    const open = useAtomValue(codeFinderOpenAtom);
    const index = useAtomValue(codeIndexAtom);
    const [query, setQuery] = useState("");
    const [cursor, setCursor] = useState(0);
    const inputRef = useRef<HTMLInputElement>(null);

    const matches = useMemo(
        () => rankPaths(query, index?.paths ?? [], MAX_RESULTS),
        [query, index]
    );

    useEffect(() => {
        if (open) {
            setQuery("");
            setCursor(0);
            inputRef.current?.focus();
        }
    }, [open]);

    useEffect(() => {
        setCursor(0);
    }, [query]);

    if (!open) {
        return null;
    }

    const close = () => globalStore.set(codeFinderOpenAtom, false);
    const choose = (path: string) => {
        close();
        revealPath(path);
        fireAndForget(() => openPath(path));
    };

    return (
        <div className="absolute inset-0 z-30 flex items-start justify-center bg-background/60 pt-[12vh]" onClick={close}>
            <div
                className="w-[min(680px,90%)] overflow-hidden rounded-[12px] border border-border bg-surface shadow-xl"
                onClick={(e) => e.stopPropagation()}
            >
                <input
                    ref={inputRef}
                    value={query}
                    placeholder="Find a file by name"
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === "Escape") {
                            e.preventDefault();
                            close();
                        } else if (e.key === "ArrowDown") {
                            e.preventDefault();
                            setCursor((c) => Math.min(c + 1, matches.length - 1));
                        } else if (e.key === "ArrowUp") {
                            e.preventDefault();
                            setCursor((c) => Math.max(c - 1, 0));
                        } else if (e.key === "Enter" && matches[cursor] != null) {
                            e.preventDefault();
                            choose(matches[cursor].path);
                        }
                    }}
                    className="w-full border-b border-border bg-transparent px-4 py-3 text-[13px] text-primary outline-none placeholder:text-muted"
                />
                <div className="max-h-[50vh] overflow-y-auto">
                    {matches.length === 0 ? (
                        <div className="px-4 py-3 text-[12.5px] text-muted">No matching files</div>
                    ) : (
                        matches.map((m, i) => (
                            <button
                                key={m.path}
                                type="button"
                                onMouseEnter={() => setCursor(i)}
                                onClick={() => choose(m.path)}
                                className={cn(
                                    "block w-full cursor-pointer truncate px-4 py-1.5 text-left font-mono text-[12px] text-secondary",
                                    i === cursor && "bg-accent/10 text-accent-soft"
                                )}
                            >
                                {m.path}
                            </button>
                        ))
                    )}
                </div>
                {index?.truncated ? (
                    <div className="border-t border-border px-4 py-1.5 text-[11px] text-muted">
                        Index truncated — searching the first 20,000 files only.
                    </div>
                ) : null}
            </div>
        </div>
    );
}
```

- [ ] **Step 2: Mount it in the surface**

In `frontend/app/view/code/codesurface.tsx`, import it and render it as the last child of the surface's outer `div`, so it overlays both panes:

```tsx
import { CodeFinderPalette } from "./codefinderpalette";
```

Change the outer wrapper to `className="relative flex h-full w-full flex-col"` and add before its closing tag:

```tsx
            <CodeFinderPalette />
```

- [ ] **Step 3: Add the keyboard bindings**

In `frontend/app/store/keybindings/bindings.ts`, import the store atoms:

```ts
import { codeFinderOpenAtom, goBack, goForward, refreshIndex } from "@/app/view/code/codestore";
```

Add the builder, modeled on `buildFilesBindings` (line 512):

```ts
export function buildCodeBindings(): Binding[] {
    const on = (ctx: KeyContext) => ctx.surface === "code" && !ctx.editable && !ctx.modalOpen;
    return [
        {
            id: "code:find",
            keys: "f",
            group: "Code",
            label: "Find a file by name",
            when: on,
            // Ctrl:p is the command palette, so the finder takes a bare letter like the Diff surface's `c`
            run: () => globalStore.set(codeFinderOpenAtom, true),
        },
        {
            id: "code:back",
            keys: "Alt:ArrowLeft",
            group: "Code",
            label: "Back",
            when: on,
            run: () => {
                void goBack();
            },
        },
        {
            id: "code:forward",
            keys: "Alt:ArrowRight",
            group: "Code",
            label: "Forward",
            when: on,
            run: () => {
                void goForward();
            },
        },
        {
            id: "code:refresh",
            keys: "r",
            group: "Code",
            label: "Refresh the file index",
            when: on,
            run: () => {
                void refreshIndex();
            },
        },
    ];
}
```

Then register it from inside `frontend/app/view/code/codesurface.tsx`, in the `CodeSurface` component body, exactly as the Diff surface does at `filessurface.tsx:435-436`:

```tsx
    // stable array: every run() reads live atoms, so it never needs rebuilding
    const codeBindings = useMemo(() => buildCodeBindings(), []);
    useKeybindings(codeBindings);
```

with the imports:

```ts
import { buildCodeBindings } from "@/app/store/keybindings/bindings";
import { useKeybindings } from "@/app/store/keybindings/store";
import { useMemo } from "react";
```

**Watch for an import cycle here.** `bindings.ts` will now import `codestore.ts`, and `codesurface.tsx` imports `bindings.ts`. That is the same shape the Diff surface already has (`bindings.ts` imports `comparestore`, `filessurface` imports `bindings`) and it is fine, because `codestore.ts` imports nothing from `bindings.ts`. If a circular-import warning appears at dev-server start, that invariant is what broke.

- [ ] **Step 4: Stop Escape from doing two things at once**

While the finder is open, both its own close and the surface's go-home binding match `Escape`, so the dispatcher would close the finder *and* leave for the Cockpit. The Diff surface already solved this: its go-home guard checks `compareOnAtom` (`bindings.ts:174-178`). Add the finder to that same guard:

```ts
                ESC_HOME_SURFACES.has(ctx.surface) &&
                !globalStore.get(graphPeekOpenAtom) &&
                !globalStore.get(autonomyPanelOpenAtom) &&
                !globalStore.get(codeFinderOpenAtom) &&
```

and extend the explanatory comment beside it to name the finder alongside compare.

- [ ] **Step 5: Verify**

```bash
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit
npx vitest run frontend/app/store/keybindings/ frontend/app/view/code/
npx eslint frontend/app/view/code/ frontend/app/store/keybindings/bindings.ts
```

Expected: all clean.

- [ ] **Step 6: Verify the keyboard in the live app**

With `task dev` running and a project selected, confirm by hand: `f` opens the finder; typing filters; Enter opens the file and the tree expands to reveal it; Escape closes the finder and leaves you on the Code surface (**not** on the Cockpit — that regression is exactly what Step 4 prevents); Escape again goes home; `Alt+Left` returns to the previously opened file; `Ctrl+9` reaches the surface from elsewhere; `g b` does too; `Shift+?` lists the four Code bindings in the cheat sheet.

- [ ] **Step 7: Stage**

```bash
git add frontend/app/view/code/codefinderpalette.tsx frontend/app/view/code/codesurface.tsx frontend/app/store/keybindings/bindings.ts
```

---

### Task 12: Full verification and the single commit

**Files:** none new — this task verifies and commits everything staged by Tasks 1-11 plus the spec document.

- [ ] **Step 1: Run the whole frontend suite**

```bash
npx vitest run
```

Expected: PASS. The baseline is green, so any failure belongs to this work.

- [ ] **Step 2: Run the Go suite**

```powershell
$env:CGO_CFLAGS = "-O2 -g -I$((Get-Location).Path -replace '\\','/')/pkg/jarvisembed/csrc"
go test ./pkg/...
```

Expected: PASS. Without that `CGO_CFLAGS` line six packages fail to *build* with a misleading `sqlite3.h: No such file or directory`, and the path must be Windows-style — a Git-Bash POSIX path fails identically.

- [ ] **Step 3: Typecheck and lint**

```bash
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit
npx eslint frontend/app/view/code/ frontend/util/paths.ts
npx prettier --check frontend/app/view/code/ frontend/util/paths.ts
```

Expected: all clean. Do not run `prettier --write` across files you did not author — it reorders imports and rewraps whole files, turning a small diff into hundreds of lines.

- [ ] **Step 4: Confirm the generated files are in sync**

```bash
task generate
git status --porcelain frontend/app/store/wshclientapi.ts pkg/wshrpc/wshclient/wshclient.go frontend/types/gotypes.d.ts
```

Expected: no *further* changes beyond what Task 2 already staged. Output naming a file that is not already staged means a regeneration step was missed.

- [ ] **Step 5: Rebuild the backend so the new RPC actually exists at runtime**

```bash
task build:backend
```

The frontend calls `gitlistfiles`; a stale `wavesrv` answers with a route error and the surface shows "Could not list files".

- [ ] **Step 6: Run the CDP smoke scenario**

With the rebuilt backend and `task dev` running:

```bash
task verify:ui -- surface-smoke
```

Expected: every surface PASSes, including the new `code` row.

- [ ] **Step 7: Self-review the diff**

```bash
git diff --cached
```

Check for: commented-out code, debug logging, raw hex or rgba colors, and any file you did not intend to touch. Confirm `frontend/app/view/agents/filessurface.tsx` appears only if Task 7 Step 5 actually ran.

- [ ] **Step 8: Ask the user to approve the commit**

Do not run `git commit` until the user says yes. Show them the staged file list and the proposed message.

- [ ] **Step 9: Commit, once approved**

Stage the spec and plan documents into this same commit — they fold into the feature commit they describe, never a docs-only commit:

```bash
git add docs/superpowers/specs/2026-08-03-code-browser-surface-design.md docs/superpowers/plans/2026-08-03-code-browser-surface.md
git commit -m "feat(code): a ninth surface for reading source, so a repo is browsable without leaving the cockpit" -m "One git ls-files call feeds both the directory tree and the fuzzy file finder, so the two cannot disagree about what exists and .gitignore is the ignore policy for free. Files open through stat-then-read into the existing read-only Monaco wrapper; back/forward history replaces open-file tabs. Read-only and deliberately unconnected to agents and runs."
```

---

## Self-Review

**Spec coverage.** Every section of `docs/superpowers/specs/2026-08-03-code-browser-surface-design.md` maps to a task: the backend reader and its cap → Task 1; the RPC and codegen → Task 2; the three pure modules → Tasks 3, 4, 5; the classification gates → Task 6; the shared path helper and the conditional Diff-surface cleanup → Task 7; the atoms, cache, guard tokens and stat-then-read loader → Task 8; surface registration, rail, chords, empty states and CDP coverage → Task 9; tree, viewer and all seven file-state variants → Task 10; finder, the four keys and the Escape collision → Task 11; the full verification sweep → Task 12. The spec's "explicitly out of scope" list has no tasks by design.

**Placeholder scan.** Every code step carries real code. The one forward reference — `CodePanes` in Task 9 — is a working placeholder that renders a file count, explicitly labeled as replaced in Task 10, not a "TODO".

**Type consistency.** Checked across tasks: `FileList{Paths,IsRepo,Truncated}` (Task 1) maps to `CommandGitListFilesRtnData{files,isrepo,truncated}` (Task 2) and is consumed as `res.files`/`res.isrepo`/`res.truncated` in Task 8. `History`/`push`/`back`/`forward`/`canBack`/`canForward`/`currentPath` (Task 5) are used under those exact names in Tasks 8 and 9. `classifyFile`/`hasNulByte`/`MAX_VIEW_BYTES` (Task 6) match their call sites in Task 8. `joinRepoPath` (Task 7) matches Tasks 8 and 10. The `CodeFile` union's seven variants (Task 8) are each handled in the Task 10 switch. `codeFinderOpenAtom` (Task 8) is read in Tasks 11 Step 3 and Step 4.

**Known unknown, deliberately left open.** Task 10 Step 5 carries the spec's flagged risk: `CodeEditor` reads editor preferences via `useOverrideConfigAtom(blockId, …)` and has only ever run with a real editor block. It is verified in the live app rather than guessed at now.
