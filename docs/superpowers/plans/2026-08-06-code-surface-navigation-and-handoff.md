# Code Surface Navigation, Search and Handoff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the cockpit's Code surface usable by keyboard, searchable by file content, and connected to the Diff surface, Radar findings, and live agents.

**Architecture:** One new primitive, `openInCode(model, {projectPath, rel, line})`, is the single entry point every jump goes through — content-search results, a diff row, a Radar finding, and jump-to-line all call it. The tree's broken keyboard wiring is replaced by a real cursor whose whole contract lives in a pure, tested module. Content search adds one `git grep` reader in Go behind one new RPC command. Handoff to an agent reuses the terminal keystroke injection that channel steering already uses.

**Tech Stack:** Go 1.x (`pkg/gitinfo`, `pkg/wshrpc`), TypeScript + React 19 + jotai + Tailwind 4 (`frontend/app/view/code/`), Monaco via the existing `CodeEditor` wrapper, Vitest for frontend unit tests, `go test` for Go, Chrome DevTools Protocol for rendered verification.

**Spec:** `docs/superpowers/specs/2026-08-06-code-surface-navigation-and-handoff-design.md`

## Global Constraints

- **Never commit without explicit user approval.** This repository's rules are strict: batch the work into **one commit at the end**, and the spec and plan documents fold into that same feature commit — never a docs-only commit. Every task below ends with a *stage* step, not a commit. Task 18 is the single gated commit.
- **This working tree is edited from parallel sessions.** Before staging, re-check `git status` and stage only the paths that task names. Never `git add -A`.
- **Never hand-edit generated files.** `frontend/app/store/wshclientapi.ts` and `frontend/types/gotypes.d.ts` come from `task generate`. Go is the source of truth for the wire protocol.
- **Typecheck command:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`. Bare `npx tsc` stack-overflows on this repository, so `task check:ts` is unusable. The baseline is clean — any error reported is yours.
- **Go tests need a Windows-style CGO include path**, or six packages fail to build:
  ```powershell
  $env:CGO_CFLAGS = "-O2 -g -I$((Get-Location).Path -replace '\\','/')/pkg/jarvisembed/csrc"
  ```
  A Git-Bash POSIX path (`/c/Users/...`) fails with an identical-looking error. `pkg/gitinfo` alone does not need CGO, so `go test ./pkg/gitinfo/...` works without it; anything wider does.
- **Colors come from `@theme` tokens** in `frontend/tailwindsetup.css`. Never a raw hex or `rgba()` in a component — a hardcoded color silently opts out of every runtime theme. Reuse the token utility classes the surrounding code already uses (`text-primary`, `text-secondary`, `text-muted`, `border-border`, `bg-surface`, `bg-accent/10`, `text-accent-soft`).
- **Never run `prettier --write` on `scripts/cdp/scenarios.mjs`** — `.editorconfig` omits `.mjs`, so Prettier reindents the entire file to two spaces and a five-line addition becomes a whole-file diff. Hand-format additions to that file's existing four-space style. The same caution applies to any `.tsx` you did not author: `--write` also reorders imports and rewraps the file.
- **No jsdom render or snapshot tests.** That posture is settled for cockpit surfaces. Testable logic is extracted into a pure `foo.ts` with a `foo.test.ts` beside it; "does it render" is the CDP scenario harness.
- **Generated Go types are ambient globals** in TypeScript (`frontend/types/gotypes.d.ts` wraps them in `declare global`). Use `GitGrepMatch` directly — do not import it.
- **Comments explain "why", never "what", lower case, only where a reader would otherwise be misled.** Match the surrounding files, which are heavily commented on rationale and silent on mechanics.

---

## File Structure

**New files (6 source + 3 test):**

| File | Responsibility |
|---|---|
| `frontend/app/view/code/codetreekeys.ts` | Pure: the tree's whole keyboard contract as a `rows × cursor × key → action` function |
| `frontend/app/view/code/codetreekeys.test.ts` | Its tests, including every directory case the current pane gets wrong |
| `frontend/app/view/code/codesearch.ts` | Pure: group flat grep matches by file, summarize counts |
| `frontend/app/view/code/codesearch.test.ts` | Its tests |
| `frontend/app/view/code/codesearchstore.ts` | Search state atoms + the grep loader with its stale-response guard |
| `frontend/app/view/code/codesearchpane.tsx` | The Search mode of the left column |
| `frontend/app/view/code/codepathbar.tsx` | The bar above the editor: file identity, copy-path, send-to-agent |
| `frontend/app/view/code/codehandoff.ts` | Pure: compose the one-line agent reference; filter live agents by project |
| `frontend/app/view/code/codehandoff.test.ts` | Its tests |

**Modified files (14):**

| File | Change |
|---|---|
| `pkg/gitinfo/gitinfo.go` | Add the `Grep` reader |
| `pkg/gitinfo/gitinfo_test.go` | Add its tests |
| `pkg/wshrpc/wshrpctypes_git.go` | Add `GitGrepCommand` and its data types |
| `pkg/wshrpc/wshserver/wshserver_git.go` | Add the passthrough |
| `frontend/util/paths.ts` | Add `sameRepoPath` and `repoBasename` |
| `frontend/util/paths.test.ts` | Add their tests |
| `frontend/app/view/code/codestore.ts` | Cursor, pending-line, tree-focus and derived-rows atoms; `openInCode` |
| `frontend/app/view/code/codetreepane.tsx` | Cursor rendering, single-owner focus, scroll-into-view, drop the shared list-nav registration |
| `frontend/app/view/code/codeviewer.tsx` | Capture the Monaco instance, reveal the pending line, expose the selection |
| `frontend/app/view/code/codesurface.tsx` | Two-mode left column, path bar |
| `frontend/app/view/code/codefinder.ts` | The `path:123` query grammar |
| `frontend/app/view/code/codefinder.test.ts` | Its tests |
| `frontend/app/view/code/codefinderpalette.tsx` | Route a parsed line through the jump primitive |
| `frontend/app/store/keybindings/bindings.ts` | Tree keys, focus-move keys, the search key |
| `frontend/app/store/keybindings/store.test.ts` | Extend the conflict guard to cover the tree keys while focused |
| `frontend/app/view/agents/gitdiff.ts` | Add `firstChangedLine` |
| `frontend/app/view/agents/gitdiff.test.ts` | Its tests |
| `frontend/app/view/agents/filessurface.tsx` | Rename one prop, add the Open-in-Code button |
| `frontend/app/view/agents/radarfindingdetail.tsx` | Make affected-file rows open the file |
| `scripts/cdp/scenarios.mjs` | Add the `code-search` scenario |

**Generated (2, never hand-edited):** `frontend/app/store/wshclientapi.ts`, `frontend/types/gotypes.d.ts`.

---

# Phase 1 — Backend content search

## Task 1: The `git grep` reader

**Files:**
- Modify: `pkg/gitinfo/gitinfo.go` (append after `ListFiles`, which ends at line 858)
- Test: `pkg/gitinfo/gitinfo_test.go` (append)

**Interfaces:**
- Consumes: the file's existing `run(ctx, cwd, args...)` helper (line 39) and `gitTimeout` constant (line 24). Its imports already include `context`, `errors`, `os/exec`, `strconv`, `strings` — add nothing.
- Produces: `gitinfo.Grep(ctx, cwd, query) (*GrepResult, error)`, `gitinfo.GrepMatch{Path string; Line int; Text string}`, `gitinfo.GrepResult{Matches []GrepMatch; Truncated bool}`, and the unexported `maxGrepMatches = 500`.

- [ ] **Step 1: Write the failing tests**

Append to `pkg/gitinfo/gitinfo_test.go`:

```go
// A repository with one match in each interesting category: tracked, untracked-not-ignored,
// ignored, binary, and a CRLF line (this is a Windows checkout, so real files have CRLF).
func repoForGrep(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	git(t, dir, "init", "-b", "main")
	write := func(name, body string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("tracked.txt", "alpha NEEDLE here\nsecond line\n")
	write("crlf.txt", "carriage NEEDLE return\r\n")
	write(".gitignore", "ignored.txt\n")
	git(t, dir, "add", ".")
	git(t, dir, "commit", "-m", "init")
	write("untracked.txt", "another needle line\n")
	write("ignored.txt", "NEEDLE in an ignored file\n")
	write("bin.dat", "NEEDLE\x00binary\n")
	return dir
}

func grepPaths(res *GrepResult) map[string]bool {
	out := map[string]bool{}
	for _, m := range res.Matches {
		out[m.Path] = true
	}
	return out
}

func TestGrepReturnsPathLineAndText(t *testing.T) {
	res, err := Grep(context.Background(), repoForGrep(t), "NEEDLE")
	if err != nil {
		t.Fatal(err)
	}
	var got *GrepMatch
	for i := range res.Matches {
		if res.Matches[i].Path == "tracked.txt" {
			got = &res.Matches[i]
		}
	}
	if got == nil {
		t.Fatalf("no match in tracked.txt; got %+v", res.Matches)
	}
	if got.Line != 1 {
		t.Errorf("Line = %d, want 1", got.Line)
	}
	if got.Text != "alpha NEEDLE here" {
		t.Errorf("Text = %q, want %q", got.Text, "alpha NEEDLE here")
	}
}

func TestGrepStripsTheCarriageReturn(t *testing.T) {
	res, err := Grep(context.Background(), repoForGrep(t), "carriage")
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Matches) != 1 {
		t.Fatalf("want exactly one match, got %+v", res.Matches)
	}
	if res.Matches[0].Text != "carriage NEEDLE return" {
		t.Errorf("Text = %q — a trailing \\r must be stripped", res.Matches[0].Text)
	}
}

func TestGrepNoMatchIsNotAnError(t *testing.T) {
	res, err := Grep(context.Background(), repoForGrep(t), "no-such-string-anywhere")
	if err != nil {
		t.Fatalf("git grep exits 1 for no matches; that is not an error: %v", err)
	}
	if len(res.Matches) != 0 {
		t.Errorf("want no matches, got %+v", res.Matches)
	}
	if res.Truncated {
		t.Error("Truncated must be false when there are no matches")
	}
}

func TestGrepSearchesUntrackedAndHonorsGitignore(t *testing.T) {
	res, err := Grep(context.Background(), repoForGrep(t), "NEEDLE")
	if err != nil {
		t.Fatal(err)
	}
	paths := grepPaths(res)
	if !paths["untracked.txt"] {
		t.Error("untracked.txt not searched — --untracked is missing, so search disagrees with the file tree")
	}
	if paths["ignored.txt"] {
		t.Error("ignored.txt searched — .gitignore must still be honored")
	}
}

func TestGrepSkipsBinaryFiles(t *testing.T) {
	res, err := Grep(context.Background(), repoForGrep(t), "NEEDLE")
	if err != nil {
		t.Fatal(err)
	}
	if grepPaths(res)["bin.dat"] {
		t.Error("bin.dat searched — -I must skip binary files")
	}
}

func TestGrepIsCaseInsensitive(t *testing.T) {
	res, err := Grep(context.Background(), repoForGrep(t), "needle")
	if err != nil {
		t.Fatal(err)
	}
	if !grepPaths(res)["tracked.txt"] {
		t.Error("lowercase query did not match uppercase NEEDLE")
	}
}

func TestGrepEmptyQueryReturnsNoMatches(t *testing.T) {
	res, err := Grep(context.Background(), repoForGrep(t), "   ")
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Matches) != 0 {
		t.Errorf("an empty query must match nothing (git grep -e \"\" matches every line), got %d", len(res.Matches))
	}
}

func TestGrepTruncatesAtTheCap(t *testing.T) {
	dir := t.TempDir()
	git(t, dir, "init", "-b", "main")
	var sb strings.Builder
	for i := 0; i < maxGrepMatches+100; i++ {
		sb.WriteString("NEEDLE line\n")
	}
	if err := os.WriteFile(filepath.Join(dir, "many.txt"), []byte(sb.String()), 0o644); err != nil {
		t.Fatal(err)
	}
	res, err := Grep(context.Background(), dir, "NEEDLE")
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Matches) != maxGrepMatches {
		t.Errorf("len(Matches) = %d, want the cap %d", len(res.Matches), maxGrepMatches)
	}
	if !res.Truncated {
		t.Error("Truncated must be true once the cap is hit")
	}
}

func TestGrepOnNonRepoIsAnError(t *testing.T) {
	if _, err := Grep(context.Background(), t.TempDir(), "anything"); err == nil {
		t.Error("a non-repository must error (git exits 128), not report zero matches")
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go test ./pkg/gitinfo/ -run TestGrep -v`
Expected: FAIL — `undefined: Grep`, `undefined: GrepResult`, `undefined: GrepMatch`, `undefined: maxGrepMatches`.

- [ ] **Step 3: Write the implementation**

Append to `pkg/gitinfo/gitinfo.go`:

```go
const maxGrepMatches = 500

type GrepMatch struct {
	Path string
	Line int
	Text string
}

// GrepResult holds at most maxGrepMatches matches; Truncated reports that the scan stopped early.
type GrepResult struct {
	Matches   []GrepMatch
	Truncated bool
}

// Grep searches file contents in cwd for a fixed, case-insensitive string.
//
// --untracked is not optional: the Code surface builds its tree and its file finder from
// ls-files --cached --others --exclude-standard, and without the flag git grep would search only
// tracked files — so a newly created file would appear in the tree and never in search results.
// .gitignore is still honored either way.
//
// git grep exits 1 when nothing matched, which is not a failure. Exit 128 (not a repository) and
// everything else are.
func Grep(ctx context.Context, cwd, query string) (*GrepResult, error) {
	q := strings.TrimSpace(query)
	if q == "" {
		return &GrepResult{}, nil // `git grep -e ""` matches every line of every file
	}
	ctx, cancel := context.WithTimeout(ctx, gitTimeout)
	defer cancel()
	out, err := run(ctx, cwd, "grep", "--untracked", "-n", "-z", "-I", "-i", "-F", "--no-color", "-e", q)
	if err != nil {
		var ee *exec.ExitError
		if !errors.As(err, &ee) || ee.ExitCode() != 1 {
			return nil, err
		}
	}
	matches := []GrepMatch{}
	truncated := false
	// -n -z prints "path\0line\0text"; the record itself still ends at a newline, so a path
	// containing a newline is not representable — the limit of git grep's output format.
	for _, rec := range strings.Split(out, "\n") {
		if rec == "" {
			continue
		}
		parts := strings.SplitN(rec, "\x00", 3)
		if len(parts) < 3 {
			continue
		}
		n, convErr := strconv.Atoi(parts[1])
		if convErr != nil {
			continue
		}
		if len(matches) >= maxGrepMatches {
			truncated = true
			break
		}
		matches = append(matches, GrepMatch{
			Path: parts[0],
			Line: n,
			Text: strings.TrimSuffix(parts[2], "\r"), // Windows checkout: real files are CRLF
		})
	}
	return &GrepResult{Matches: matches, Truncated: truncated}, nil
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `go test ./pkg/gitinfo/ -run TestGrep -v`
Expected: PASS, all nine tests.

- [ ] **Step 5: Run the whole package to check nothing regressed**

Run: `go test ./pkg/gitinfo/`
Expected: `ok`.

- [ ] **Step 6: Stage**

```bash
git add pkg/gitinfo/gitinfo.go pkg/gitinfo/gitinfo_test.go
```

---

## Task 2: The `GitGrepCommand` RPC

**Files:**
- Modify: `pkg/wshrpc/wshrpctypes_git.go` (the `GitCommands` interface at line 15, then the data types)
- Modify: `pkg/wshrpc/wshserver/wshserver_git.go` (append after `GitListFilesCommand`, which ends at line 77)
- Regenerate: `frontend/app/store/wshclientapi.ts`, `frontend/types/gotypes.d.ts`

**Interfaces:**
- Consumes: `gitinfo.Grep` from Task 1.
- Produces: `RpcApi.GitGrepCommand(client, {cwd, query}, opts?)` returning `{matches: GitGrepMatch[]; truncated?: boolean}`, and the ambient TypeScript type `GitGrepMatch = {path: string; line: number; text: string}`.

- [ ] **Step 1: Add the command to the interface**

In `pkg/wshrpc/wshrpctypes_git.go`, inside `type GitCommands interface`, after the `GitListFilesCommand` line:

```go
	GitGrepCommand(ctx context.Context, data CommandGitGrepData) (*CommandGitGrepRtnData, error)
```

- [ ] **Step 2: Add the data types**

At the end of `pkg/wshrpc/wshrpctypes_git.go`:

```go
type CommandGitGrepData struct {
	Cwd   string `json:"cwd"`
	Query string `json:"query"`
}

// Unlike the change-list and diff commands, which hand raw git output across the wire for one
// frontend parser to split, grep returns already-parsed matches — the mixed NUL-and-newline record
// format is the parsing Go already does for ls-files, the match cap has to be applied server-side
// regardless, and there is no second caller to share a TypeScript parser with.
type CommandGitGrepRtnData struct {
	Matches   []GitGrepMatch `json:"matches"`
	Truncated bool           `json:"truncated,omitempty"`
}

type GitGrepMatch struct {
	Path string `json:"path"`
	Line int    `json:"line"`
	Text string `json:"text"`
}
```

- [ ] **Step 3: Add the server passthrough**

At the end of `pkg/wshrpc/wshserver/wshserver_git.go`:

```go
func (ws *WshServer) GitGrepCommand(ctx context.Context, data wshrpc.CommandGitGrepData) (*wshrpc.CommandGitGrepRtnData, error) {
	res, err := gitinfo.Grep(ctx, data.Cwd, data.Query)
	if err != nil {
		return nil, err
	}
	matches := make([]wshrpc.GitGrepMatch, 0, len(res.Matches))
	for _, m := range res.Matches {
		matches = append(matches, wshrpc.GitGrepMatch{Path: m.Path, Line: m.Line, Text: m.Text})
	}
	return &wshrpc.CommandGitGrepRtnData{Matches: matches, Truncated: res.Truncated}, nil
}
```

- [ ] **Step 4: Verify the Go side compiles**

Run: `go build ./pkg/wshrpc/... ./pkg/gitinfo/...`
Expected: no output.

- [ ] **Step 5: Regenerate the bindings**

Run: `task generate`
Expected: it completes, and `git diff --stat` shows changes only in `frontend/app/store/wshclientapi.ts` and `frontend/types/gotypes.d.ts`.

- [ ] **Step 6: Verify the generated client function and type exist**

Run: `grep -n "GitGrepCommand" frontend/app/store/wshclientapi.ts && grep -n "GitGrepMatch" frontend/types/gotypes.d.ts`
Expected: both found. If either is missing, the interface entry in Step 1 was not picked up — do not hand-edit the generated file.

- [ ] **Step 7: Build the backend so the dev app can actually call it**

Run: `task build:backend`
Expected: it completes. Without this the new command route-errors at runtime. If you are working in a git worktree, note that this writes *that worktree's* `dist/bin` — the main checkout's `wavesrv` stays stale until rebuilt there.

- [ ] **Step 8: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 9: Stage**

```bash
git add pkg/wshrpc/wshrpctypes_git.go pkg/wshrpc/wshserver/wshserver_git.go frontend/app/store/wshclientapi.ts frontend/types/gotypes.d.ts
```

---

# Phase 2 — Navigation foundation

## Task 3: Path comparison helpers

**Files:**
- Modify: `frontend/util/paths.ts`
- Test: `frontend/util/paths.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `sameRepoPath(a: string, b: string): boolean` and `repoBasename(p: string): string`.

- [ ] **Step 1: Write the failing tests**

Append to `frontend/util/paths.test.ts`:

```ts
describe("sameRepoPath", () => {
    it("ignores separator style", () => {
        expect(sameRepoPath("C:/repo/sub", "C:\\repo\\sub")).toBe(true);
    });

    it("ignores a trailing separator", () => {
        expect(sameRepoPath("C:\\repo\\", "C:\\repo")).toBe(true);
    });

    it("ignores case, because NTFS does", () => {
        expect(sameRepoPath("C:\\Repo\\Sub", "c:\\repo\\sub")).toBe(true);
    });

    it("still distinguishes genuinely different paths", () => {
        expect(sameRepoPath("C:\\repo\\a", "C:\\repo\\b")).toBe(false);
    });

    it("treats an empty path as matching nothing, so a blank cwd cannot claim a project", () => {
        expect(sameRepoPath("", "")).toBe(false);
        expect(sameRepoPath("", "C:\\repo")).toBe(false);
    });
});

describe("repoBasename", () => {
    it("takes the last segment of a backslashed path", () => {
        expect(repoBasename("C:\\code\\my-worktree")).toBe("my-worktree");
    });

    it("takes the last segment of a forward-slashed path", () => {
        expect(repoBasename("C:/code/my-worktree")).toBe("my-worktree");
    });

    it("ignores a trailing separator", () => {
        expect(repoBasename("C:\\code\\my-worktree\\")).toBe("my-worktree");
    });

    it("falls back to the whole string when there is no separator", () => {
        expect(repoBasename("repo")).toBe("repo");
    });

    it("returns an empty string for an empty path", () => {
        expect(repoBasename("")).toBe("");
    });
});
```

Change the import at the top of the file to:

```ts
import { joinRepoPath, repoBasename, sameRepoPath } from "./paths";
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run frontend/util/paths.test.ts`
Expected: FAIL — no export named `sameRepoPath` / `repoBasename`.

- [ ] **Step 3: Write the implementation**

Append to `frontend/util/paths.ts`:

```ts
// A repository path reaches the cockpit either from git (forward slashes) or from the config
// registry (backslashes), so equality has to ignore separator style — and NTFS ignores case.
// joinRepoPath cannot serve here: it builds one path for ShellExecute, it does not compare two.
// An empty path matches nothing, so a blank cwd can never claim a registered project.
export function sameRepoPath(a: string, b: string): boolean {
    if (!a || !b) {
        return false;
    }
    return normalizeRepoPath(a) === normalizeRepoPath(b);
}

function normalizeRepoPath(p: string): string {
    return p.replace(/[\\/]+/g, "/").replace(/\/+$/, "").toLowerCase();
}

// The directory name, used to label a repository that is not in the project registry — a worktree,
// which launchAgent creates and which the Code surface can still browse.
export function repoBasename(p: string): string {
    const segs = p.split(/[\\/]+/).filter((s) => s !== "");
    return segs.length === 0 ? "" : segs[segs.length - 1];
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run frontend/util/paths.test.ts`
Expected: PASS, all cases including the four pre-existing `joinRepoPath` tests.

- [ ] **Step 5: Stage**

```bash
git add frontend/util/paths.ts frontend/util/paths.test.ts
```

---

## Task 4: The tree's keyboard contract, as a pure module

**Files:**
- Create: `frontend/app/view/code/codetreekeys.ts`
- Test: `frontend/app/view/code/codetreekeys.test.ts`

**Interfaces:**
- Consumes: `TreeRow` from `./codetree` (`{kind: "dir" | "file"; path: string; name: string; depth: number; expanded: boolean}`), and `moveCursor(ids: string[], current: string | undefined, delta: number): string | undefined` from `@/app/view/agents/agentsviewmodel`.
- Produces: `TreeKey`, `TreeAction`, and `treeKeyAction(rows, cursor, key): TreeAction`.

- [ ] **Step 1: Write the failing tests**

Create `frontend/app/view/code/codetreekeys.test.ts`:

```ts
// frontend/app/view/code/codetreekeys.test.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { treeKeyAction } from "./codetreekeys";
import type { TreeRow } from "./codetree";

// src/ (expanded) > src/a.ts > src/lib/ (collapsed) > README.md
const rows: TreeRow[] = [
    { kind: "dir", path: "src", name: "src", depth: 0, expanded: true },
    { kind: "file", path: "src/a.ts", name: "a.ts", depth: 1, expanded: false },
    { kind: "dir", path: "src/lib", name: "lib", depth: 1, expanded: false },
    { kind: "file", path: "README.md", name: "README.md", depth: 0, expanded: false },
];

describe("treeKeyAction", () => {
    it("starts on the first row when there is no cursor yet", () => {
        // the old pane derived its cursor from the open file, so with nothing open j did nothing at all
        expect(treeKeyAction(rows, null, "next")).toEqual({ kind: "move", path: "src" });
    });

    it("moves onto a directory row", () => {
        // the bug this module exists to kill: moving onto a directory used to be a silent no-op,
        // which meant the cursor could never get past one
        expect(treeKeyAction(rows, "src/a.ts", "next")).toEqual({ kind: "move", path: "src/lib" });
    });

    it("moves onto a file row", () => {
        expect(treeKeyAction(rows, "src", "next")).toEqual({ kind: "move", path: "src/a.ts" });
    });

    it("moves backwards", () => {
        expect(treeKeyAction(rows, "src/lib", "prev")).toEqual({ kind: "move", path: "src/a.ts" });
    });

    it("does nothing at the end of the list", () => {
        expect(treeKeyAction(rows, "README.md", "next")).toEqual({ kind: "none" });
    });

    it("does nothing at the start of the list", () => {
        expect(treeKeyAction(rows, "src", "prev")).toEqual({ kind: "none" });
    });

    it("opens a file on activate", () => {
        expect(treeKeyAction(rows, "src/a.ts", "activate")).toEqual({ kind: "open", path: "src/a.ts" });
    });

    it("toggles a directory on activate", () => {
        // unreachable in the old pane: it looked the cursor up by the OPEN FILE path, which is never a directory
        expect(treeKeyAction(rows, "src", "activate")).toEqual({ kind: "toggle", path: "src" });
    });

    it("expands a collapsed directory", () => {
        expect(treeKeyAction(rows, "src/lib", "expand")).toEqual({ kind: "toggle", path: "src/lib" });
    });

    it("does not re-expand an already expanded directory", () => {
        expect(treeKeyAction(rows, "src", "expand")).toEqual({ kind: "none" });
    });

    it("collapses an expanded directory", () => {
        expect(treeKeyAction(rows, "src", "collapse")).toEqual({ kind: "toggle", path: "src" });
    });

    it("does not collapse an already collapsed directory", () => {
        expect(treeKeyAction(rows, "src/lib", "collapse")).toEqual({ kind: "none" });
    });

    it("ignores collapse and expand on a file", () => {
        expect(treeKeyAction(rows, "src/a.ts", "collapse")).toEqual({ kind: "none" });
        expect(treeKeyAction(rows, "src/a.ts", "expand")).toEqual({ kind: "none" });
    });

    it("does nothing when the cursor names a row that is no longer visible", () => {
        expect(treeKeyAction(rows, "src/lib/gone.ts", "activate")).toEqual({ kind: "none" });
    });

    it("does nothing on an empty tree", () => {
        expect(treeKeyAction([], null, "next")).toEqual({ kind: "none" });
        expect(treeKeyAction([], null, "activate")).toEqual({ kind: "none" });
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run frontend/app/view/code/codetreekeys.test.ts`
Expected: FAIL — cannot resolve `./codetreekeys`.

- [ ] **Step 3: Write the implementation**

Create `frontend/app/view/code/codetreekeys.ts`:

```ts
// frontend/app/view/code/codetreekeys.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pure: the Code tree's whole keyboard contract, as rows x cursor x key -> one action.
//
// Extracted because the pane's previous wiring derived its cursor from the OPEN FILE and only acted
// on file rows, which made every directory row a dead end — the cursor could not move past one and
// Enter could never match one — and none of that was testable without a DOM.
//
// Moving deliberately does NOT open. The shared list-nav contract says "cursor == selection: moving
// IS selecting", which is right for a session list and wrong for a file tree: every keypress would
// stat-then-read a file over RPC and push a back/forward history entry.

import { moveCursor } from "@/app/view/agents/agentsviewmodel";
import type { TreeRow } from "./codetree";

export type TreeKey = "next" | "prev" | "collapse" | "expand" | "activate";

export type TreeAction =
    | { kind: "move"; path: string }
    | { kind: "toggle"; path: string }
    | { kind: "open"; path: string }
    | { kind: "none" };

const NONE: TreeAction = { kind: "none" };

export function treeKeyAction(rows: readonly TreeRow[], cursor: string | null, key: TreeKey): TreeAction {
    if (rows.length === 0) {
        return NONE;
    }
    if (key === "next" || key === "prev") {
        const next = moveCursor(
            rows.map((r) => r.path),
            cursor ?? undefined,
            key === "next" ? 1 : -1
        );
        // moveCursor clamps rather than wraps, so at either end it hands back the cursor we passed in
        return next == null || next === cursor ? NONE : { kind: "move", path: next };
    }
    const row = rows.find((r) => r.path === cursor);
    if (row == null) {
        return NONE; // a refreshed index can retire the row the cursor named
    }
    if (key === "activate") {
        return row.kind === "dir" ? { kind: "toggle", path: row.path } : { kind: "open", path: row.path };
    }
    if (row.kind !== "dir") {
        return NONE; // collapse and expand are directory gestures
    }
    const wantOpen = key === "expand";
    return row.expanded === wantOpen ? NONE : { kind: "toggle", path: row.path };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run frontend/app/view/code/codetreekeys.test.ts`
Expected: PASS, all 15 cases.

- [ ] **Step 5: Stage**

```bash
git add frontend/app/view/code/codetreekeys.ts frontend/app/view/code/codetreekeys.test.ts
```

---

## Task 5: Cursor, focus and derived rows in the store

**Files:**
- Modify: `frontend/app/view/code/codestore.ts`

**Interfaces:**
- Consumes: existing `codeIndexAtom`, `codeExpandedAtom`, `selectProject` in the same file; `buildTree`, `visibleRows` from `./codetree`.
- Produces: `codeCursorAtom: PrimitiveAtom<string | null>`, `codePendingLineAtom: PrimitiveAtom<number | null>`, `codeTreeFocusedAtom: PrimitiveAtom<boolean>`, and the read-only derived `codeRowsAtom: Atom<TreeRow[]>`.

- [ ] **Step 1: Add the atoms**

In `frontend/app/view/code/codestore.ts`, after `codeSaveAtom` (line 62), add:

```ts
// The tree's highlighted row — a file OR a directory. Deliberately separate from codeFileAtom: the
// cursor used to BE the open file, which is why the cursor could never rest on a directory.
export const codeCursorAtom = atom<string | null>(null) as PrimitiveAtom<string | null>;
// A line a jump wants revealed once the file's text is in place. The store never touches Monaco;
// codeviewer.tsx consumes this and clears it.
export const codePendingLineAtom = atom<number | null>(null) as PrimitiveAtom<number | null>;
// Whether the tree pane holds focus. An atom rather than a document.activeElement query because the
// keybinding `when` predicates are evaluated by store.test.ts in vitest's node environment, where
// there is no document — and because this codebase keeps DOM reads in `run`, never in `when`.
export const codeTreeFocusedAtom = atom<boolean>(false) as PrimitiveAtom<boolean>;

// The rendered row list. Derived rather than memoized inside the pane, because the keyboard bindings
// have to agree with the pane about which rows exist and cannot see a component's useMemo.
export const codeRowsAtom = atom((get) =>
    visibleRows(buildTree(get(codeIndexAtom)?.paths ?? []), get(codeExpandedAtom))
);
```

Extend the existing `./codetree` import to `import { ancestorsOf, buildTree, visibleRows } from "./codetree";`.

- [ ] **Step 2: Reset the cursor and pending line on project switch**

In `selectProject`, alongside the other resets (after `globalStore.set(codeSaveAtom, { kind: "idle" });`):

```ts
    globalStore.set(codeCursorAtom, null);
    globalStore.set(codePendingLineAtom, null);
```

- [ ] **Step 3: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 4: Confirm existing Code tests still pass**

Run: `npx vitest run frontend/app/view/code/`
Expected: PASS — the five existing suites (`codeclassify`, `codedraft`, `codefinder`, `codehistory`, `codetree`) plus `codetreekeys`.

- [ ] **Step 5: Stage**

```bash
git add frontend/app/view/code/codestore.ts
```

---

## Task 6: Rewire the tree pane to the cursor

**Files:**
- Modify: `frontend/app/view/code/codetreepane.tsx` (full rewrite of a 99-line file)

**Interfaces:**
- Consumes: `codeRowsAtom`, `codeCursorAtom`, `codeTreeFocusedAtom`, `codeFileAtom`, `codeProjectAtom`, `codeDraftsAtom`, `draftKey`, `openPath`, `toggleDir` from `./codestore`; `treeKeyAction` is *not* used here (the bindings own keys).
- Produces: a tree pane that owns focus and renders a cursor distinct from the open file. Removes this surface's `useSurfaceListNav` registration, which makes the shared `j`/`k`/`Enter` bindings inert on `code`.

- [ ] **Step 1: Replace the file**

Rows become `role="treeitem"` divs inside one focusable `role="tree"` container instead of individual `<button>`s. This is required, not cosmetic: with buttons, clicking a row moves DOM focus into the row, and `Enter` would then fire both the keybinding and the button's implicit click. One focus owner removes that whole class of double-firing.

```tsx
// frontend/app/view/code/codetreepane.tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The directory tree, built from the same flat path list the finder indexes — one source of truth,
// so the two can never disagree about what exists.
//
// The pane is a single focus owner (role="tree" + tabIndex), not a stack of buttons: the Code
// keybindings are gated on this pane holding focus, and a focused row button would make Enter fire
// both the binding and the button's own click. It registers no list-nav controller — a two-focus
// surface owns its keys (see listnav.ts), and the shared "moving is selecting" contract would make
// every cursor step read a file over RPC.

import { globalStore } from "@/app/store/jotaiStore";
import type { AgentsViewModel } from "@/app/view/agents/agents";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { ChevronDown, ChevronRight, File } from "lucide-react";
import { useEffect, useRef } from "react";
import {
    codeCursorAtom,
    codeDraftsAtom,
    codeFileAtom,
    codeProjectAtom,
    codeRowsAtom,
    codeTreeFocusedAtom,
    draftKey,
    openPath,
    toggleDir,
} from "./codestore";

export function CodeTreePane({ model }: { model: AgentsViewModel }) {
    void model;
    const rows = useAtomValue(codeRowsAtom);
    const cursor = useAtomValue(codeCursorAtom);
    const file = useAtomValue(codeFileAtom);
    const project = useAtomValue(codeProjectAtom);
    const drafts = useAtomValue(codeDraftsAtom);
    const openFile = file.kind === "none" ? null : file.path;
    const rowRefs = useRef(new Map<string, HTMLDivElement>());

    // a finder or search jump expands ancestors, which is invisible if the row it revealed is
    // off-screen; the cursor is what makes the landing visible
    useEffect(() => {
        if (cursor != null) {
            rowRefs.current.get(cursor)?.scrollIntoView({ block: "nearest" });
        }
    }, [cursor]);

    return (
        <div
            role="tree"
            tabIndex={0}
            data-code-tree
            onFocus={() => globalStore.set(codeTreeFocusedAtom, true)}
            onBlur={() => globalStore.set(codeTreeFocusedAtom, false)}
            className="h-full overflow-y-auto border-r border-border py-2 outline-none"
        >
            {rows.map((row) => (
                <div
                    key={row.path}
                    ref={(el) => {
                        if (el == null) {
                            rowRefs.current.delete(row.path);
                        } else {
                            rowRefs.current.set(row.path, el);
                        }
                    }}
                    role="treeitem"
                    aria-selected={row.path === cursor}
                    aria-expanded={row.kind === "dir" ? row.expanded : undefined}
                    onClick={() => {
                        globalStore.set(codeCursorAtom, row.path);
                        if (row.kind === "dir") {
                            toggleDir(row.path);
                        } else {
                            fireAndForget(() => openPath(row.path));
                        }
                    }}
                    style={{ paddingLeft: 8 + row.depth * 12 }}
                    className={cn(
                        "flex w-full cursor-pointer items-center gap-1.5 py-[3px] pr-2 text-left text-[12.5px] text-secondary hover:bg-accent/10 hover:text-primary",
                        row.path === openFile && "text-accent-soft",
                        row.path === cursor && "bg-accent/10"
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
                    {/* drafts survive an unmount, so unsaved work can exist on a file you are not looking
                        at — the dot is the only thing that says so */}
                    {row.kind === "file" && project != null && drafts.has(draftKey(project, row.path)) ? (
                        <span
                            aria-label="Unsaved edits"
                            title="Unsaved edits"
                            className="ml-auto size-[6px] flex-none rounded-full bg-accent-soft"
                        />
                    ) : null}
                </div>
            ))}
        </div>
    );
}
```

- [ ] **Step 2: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0. `useSurfaceListNav` and `buildTree`/`visibleRows` are no longer imported here — if the typechecker reports them unused, the imports were not removed.

- [ ] **Step 3: Verify in the dev app that the tree still renders and clicking still opens**

With `task dev` running: `node scripts/cdp-shot.mjs cdp-shots/task6-tree.png`, then open the PNG. Expected: the Code surface's tree renders as before; clicking a file opens it; clicking a directory expands it.

- [ ] **Step 4: Stage**

```bash
git add frontend/app/view/code/codetreepane.tsx
```

---

## Task 7: The tree keybindings

**Files:**
- Modify: `frontend/app/store/keybindings/bindings.ts` (`buildCodeBindings`, which starts at line 647)
- Test: `frontend/app/store/keybindings/store.test.ts` (extend the existing Code conflict test)

**Interfaces:**
- Consumes: `treeKeyAction` (Task 4); `codeRowsAtom`, `codeCursorAtom`, `codeTreeFocusedAtom`, `openPath`, `toggleDir` (Tasks 5 and 6).
- Produces: seven new bindings in the "Code" group — `code:tree-next`, `code:tree-prev`, `code:tree-next-arrow`, `code:tree-prev-arrow`, `code:tree-collapse`, `code:tree-expand`, `code:tree-activate` — plus `code:focus-tree` and `code:focus-editor`.

- [ ] **Step 1: Write the failing test**

In `frontend/app/store/keybindings/store.test.ts`, add after the existing `"global + code-surface bindings do not conflict, editable or not"` test:

```ts
    // The tree keys are bare letters and arrows, live only while the tree pane holds focus. With
    // focus false they are inert and prove nothing, so assert with focus TRUE — and with a list-nav
    // controller published for another surface, which is the state the shared j/k bindings need to
    // be inert in.
    it("global + list-nav + code tree keys (tree focused) do not conflict", () => {
        const model = {} as any;
        globalStore.set(listNavAtom, { surface: "jarvis", navigableIds: [], cursorId: undefined, setCursor() {} });
        globalStore.set(codeTreeFocusedAtom, true);
        try {
            expect(() =>
                assertNoConflicts([...buildGlobalBindings(model), ...buildListNavBindings(), ...buildCodeBindings()])
            ).not.toThrow();
        } finally {
            globalStore.set(codeTreeFocusedAtom, false);
            globalStore.set(listNavAtom, null);
        }
    });
```

Add `codeTreeFocusedAtom` to the imports at the top of the test file:

```ts
import { codeTreeFocusedAtom } from "@/app/view/code/codestore";
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run frontend/app/store/keybindings/store.test.ts`
Expected: FAIL — no export `codeTreeFocusedAtom` if Task 5 is missing, otherwise the test passes trivially because the tree bindings do not exist yet. Either way, proceed: the test's job is to guard Step 3, and Step 4 is where it earns its keep.

- [ ] **Step 3: Add the bindings**

In `frontend/app/store/keybindings/bindings.ts`, extend the `codestore` import:

```ts
import {
    codeCursorAtom,
    codeFinderOpenAtom,
    codeRowsAtom,
    codeTreeFocusedAtom,
    goBack,
    goForward,
    openPath,
    refreshIndex,
    saveCurrent,
    toggleDir,
} from "@/app/view/code/codestore";
```

and add:

```ts
import { treeKeyAction, type TreeKey } from "@/app/view/code/codetreekeys";
```

Inside `buildCodeBindings()`, after the existing `const on = ...` line:

```ts
    // Live whenever the tree pane holds focus — NOT gated on !editable, because the editor is
    // writable and the caret sits in Monaco most of the time. Focus is read from an atom, not the
    // DOM: store.test.ts evaluates every `when` in vitest's node environment, where document is
    // undefined.
    const inTree = (ctx: KeyContext) => ctx.surface === "code" && !ctx.modalOpen && globalStore.get(codeTreeFocusedAtom);
    const treeKey = (key: TreeKey) => (): void | boolean => {
        const action = treeKeyAction(globalStore.get(codeRowsAtom), globalStore.get(codeCursorAtom), key);
        switch (action.kind) {
            case "move":
                globalStore.set(codeCursorAtom, action.path);
                return;
            case "toggle":
                toggleDir(action.path);
                return;
            case "open":
                void openPath(action.path);
                return;
            case "none":
                return false; // nothing to do here — let the key pass
        }
    };
```

and add these entries to the returned array:

```ts
        {
            id: "code:tree-next",
            keys: "j",
            group: "Code",
            label: "Next file or folder",
            when: inTree,
            run: treeKey("next"),
        },
        {
            id: "code:tree-prev",
            keys: "k",
            group: "Code",
            label: "Previous file or folder",
            when: inTree,
            run: treeKey("prev"),
        },
        {
            id: "code:tree-next-arrow",
            keys: "ArrowDown",
            group: "Code",
            label: "Next file or folder",
            when: inTree,
            run: treeKey("next"),
        },
        {
            id: "code:tree-prev-arrow",
            keys: "ArrowUp",
            group: "Code",
            label: "Previous file or folder",
            when: inTree,
            run: treeKey("prev"),
        },
        {
            id: "code:tree-collapse",
            keys: "ArrowLeft",
            group: "Code",
            label: "Collapse folder",
            when: inTree,
            run: treeKey("collapse"),
        },
        {
            id: "code:tree-expand",
            keys: "ArrowRight",
            group: "Code",
            label: "Expand folder",
            when: inTree,
            run: treeKey("expand"),
        },
        {
            id: "code:tree-activate",
            keys: "Enter",
            group: "Code",
            label: "Open file / toggle folder",
            when: inTree,
            run: treeKey("activate"),
        },
        {
            id: "code:focus-tree",
            keys: "Alt:t",
            group: "Code",
            label: "Focus the file tree",
            // reaching the tree from a writable editor needs a modified key; a bare letter is
            // swallowed by Monaco, which is why the finder moved to Ctrl+P
            when: (ctx) => ctx.surface === "code" && !ctx.modalOpen,
            run: () => {
                // a DOM read in `run` is the established convention here (see files:compare)
                document.querySelector<HTMLElement>("[data-code-tree]")?.focus();
            },
        },
        {
            id: "code:focus-editor",
            keys: "Alt:e",
            group: "Code",
            label: "Focus the editor",
            when: (ctx) => ctx.surface === "code" && !ctx.modalOpen,
            run: () => {
                const ta = document.querySelector<HTMLTextAreaElement>(".monaco-editor textarea");
                if (ta == null) {
                    return false; // no editor open — let the key pass
                }
                ta.focus();
            },
        },
```

- [ ] **Step 4: Run the keybinding tests to verify no conflicts**

Run: `npx vitest run frontend/app/store/keybindings/store.test.ts`
Expected: PASS. A failure names the colliding pair and the context — resolve by changing the new binding's key, never by loosening `when`.

- [ ] **Step 5: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 6: Verify by keyboard in the dev app**

With `task dev` running and the Code surface open with a project selected: press `Alt+T`, then `j` several times through a directory row, `Enter` on a directory, `ArrowRight`/`ArrowLeft` on a directory, `Enter` on a file, then `Alt+E` and confirm typing goes into the editor. Expected: the cursor moves past directories, Enter expands and opens, and Back (`Alt+ArrowLeft`) returns to the previously *opened* file rather than stepping back through every row you passed over.

- [ ] **Step 7: Stage**

```bash
git add frontend/app/store/keybindings/bindings.ts frontend/app/store/keybindings/store.test.ts
```

---

## Task 8: The jump primitive and the line reveal

**Files:**
- Modify: `frontend/app/view/code/codestore.ts`
- Modify: `frontend/app/view/code/codeviewer.tsx`

**Interfaces:**
- Consumes: `sameRepoPath`, `repoBasename` (Task 3); `codeCursorAtom`, `codePendingLineAtom` (Task 5); existing `selectProject`, `revealPath`, `openPath`, `projectsAtom`.
- Produces: `openInCode(model: AgentsViewModel, target: {projectPath: string; rel: string; line?: number}): Promise<void>` from `codestore.ts`, and `codeEditorSelection(): {startLine: number; endLine: number} | null` from `codeviewer.tsx`.

- [ ] **Step 1: Add the primitive**

In `frontend/app/view/code/codestore.ts`, add these imports:

```ts
import type { AgentsViewModel } from "@/app/view/agents/agents";
import { projectsAtom } from "@/app/view/agents/projectsstore";
import { joinRepoPath, repoBasename, sameRepoPath } from "@/util/paths";
```

(the existing `joinRepoPath` import from `@/util/paths` is replaced by that one line), and append:

```ts
// The one way into this surface from anywhere else: a content-search hit, a diff row, a Radar
// finding, a finder query with a line. Takes the view model because surfaceAtom lives on the
// AgentsViewModel instance rather than in a module — the same type-only seam bindings.ts uses.
export async function openInCode(
    model: AgentsViewModel,
    target: { projectPath: string; rel: string; line?: number }
): Promise<void> {
    const project = resolveJumpProject(target.projectPath);
    const cur = globalStore.get(codeProjectAtom);
    // switching resets expand state, history and the file; a jump within the repository you are
    // already reading must not throw that away
    if (cur == null || !sameRepoPath(cur.path, project.path)) {
        await selectProject(project);
    }
    revealPath(target.rel);
    globalStore.set(codeCursorAtom, target.rel);
    // set before the read: the viewer honors this the moment the text lands
    globalStore.set(codePendingLineAtom, target.line ?? null);
    globalStore.set(model.surfaceAtom, "code");
    await openPath(target.rel);
}

function resolveJumpProject(projectPath: string): CodeProject {
    const registry = globalStore.get(projectsAtom) ?? {};
    for (const [name, v] of Object.entries(registry)) {
        if (v?.path && sameRepoPath(v.path, projectPath)) {
            return { name, path: v.path };
        }
    }
    // launchAgent creates worktrees, so a diff's cwd is frequently a repository the registry does
    // not know. git ls-files needs only a path, so browse it under its directory name rather than
    // refusing the jump — the header shows the full path, so nothing is hidden.
    return { name: repoBasename(projectPath), path: projectPath };
}
```

- [ ] **Step 2: Consume the pending line in the viewer**

Replace `frontend/app/view/code/codeviewer.tsx` with:

```tsx
// frontend/app/view/code/codeviewer.tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Renders whichever variant the store resolved the opened file to. The text case hands off to the
// existing Monaco wrapper, which derives the language from the filename — so Go, Rust and TypeScript
// all highlight without a language map here. Only the text case is editable; every other variant
// (binary, too large, missing, unreadable) stays a dead end by construction.
//
// This is also the only module that touches Monaco directly. The store publishes a pending line and
// a handoff asks for the current selection; both are served here so codestore.ts stays IO-and-atoms.

import { globalStore } from "@/app/store/jotaiStore";
import type { AgentsViewModel } from "@/app/view/agents/agents";
import { SurfaceEmptyState } from "@/app/view/agents/surfacescaffold";
import { CodeEditor } from "@/app/view/codeeditor/codeeditor";
import { joinRepoPath } from "@/util/paths";
import { fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import type * as MonacoTypes from "monaco-editor";
import { useEffect } from "react";
import {
    codeDraftsAtom,
    codeFileAtom,
    codePendingLineAtom,
    codeProjectAtom,
    draftKey,
    editDraft,
    refreshIndex,
} from "./codestore";

function sizeLabel(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Module-scoped rather than a ref: the path bar's handoff control needs the same instance, and the
// surface unmounts on every nav switch. Cleared by the cleanup CodeEditor invokes on unmount.
let editor: MonacoTypes.editor.IStandaloneCodeEditor | null = null;

export function codeEditorSelection(): { startLine: number; endLine: number } | null {
    const sel = editor?.getSelection();
    if (sel == null || sel.isEmpty()) {
        return null;
    }
    return { startLine: sel.startLineNumber, endLine: sel.endLineNumber };
}

function applyPendingLine(ed: MonacoTypes.editor.IStandaloneCodeEditor): void {
    const line = globalStore.get(codePendingLineAtom);
    if (line == null) {
        return;
    }
    globalStore.set(codePendingLineAtom, null);
    ed.revealLineInCenter(line);
    ed.setPosition({ lineNumber: line, column: 1 });
}

export function CodeViewer({ model }: { model: AgentsViewModel }) {
    const file = useAtomValue(codeFileAtom);
    const project = useAtomValue(codeProjectAtom);
    const drafts = useAtomValue(codeDraftsAtom);
    const pendingLine = useAtomValue(codePendingLineAtom);

    // Two paths, both needed. Monaco is keyed by file path, so opening a DIFFERENT file remounts it
    // and onMount is the only hook that runs late enough to reveal a line. Jumping to another line
    // in the file already open does not remount, so the effect covers that — and it cannot cover
    // the first mount, because Monaco lazy-loads and no re-render follows its arrival.
    useEffect(() => {
        if (pendingLine != null && editor != null) {
            applyPendingLine(editor);
        }
    }, [pendingLine, file]);

    switch (file.kind) {
        case "none":
            return (
                <SurfaceEmptyState
                    title="No file open"
                    body="Pick a file from the tree, or press Ctrl+P to search by name."
                />
            );
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
        case "text": {
            // `text` is the draft when one exists, so the buffer survives a surface unmount. Monaco's
            // prop-sync effect no-ops when the incoming text already equals the model's (monaco-react
            // checks before pushing an edit), so feeding our own keystrokes back does not move the caret.
            const draft = project != null ? drafts.get(draftKey(project, file.path)) : undefined;
            return (
                <CodeEditor
                    key={file.path}
                    blockId={model.blockId}
                    text={draft?.text ?? file.text}
                    fileName={file.path}
                    readonly={false}
                    onChange={editDraft}
                    onMount={(ed) => {
                        editor = ed;
                        applyPendingLine(ed);
                        return () => {
                            if (editor === ed) {
                                editor = null;
                            }
                        };
                    }}
                />
            );
        }
    }
}
```

- [ ] **Step 3: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 4: Run the frontend suite**

Run: `npx vitest run`
Expected: PASS. `openInCode` has no unit test of its own — it is IO orchestration over atoms, and the settled posture is to test the pure parts (`sameRepoPath`, `repoBasename`, `treeKeyAction`) and verify the wiring in the running app. Its callers in Phase 4 are what exercise it.

- [ ] **Step 5: Stage**

```bash
git add frontend/app/view/code/codestore.ts frontend/app/view/code/codeviewer.tsx
```

---

## Task 9: Jump-to-line through the finder's query

**Files:**
- Modify: `frontend/app/view/code/codefinder.ts`
- Test: `frontend/app/view/code/codefinder.test.ts`
- Modify: `frontend/app/view/code/codefinderpalette.tsx`
- Modify: `frontend/app/view/code/codesurface.tsx` (pass `model` to the palette)

**Interfaces:**
- Consumes: `openInCode` (Task 8), `codePendingLineAtom` (Task 5), existing `rankPaths`.
- Produces: `parseFinderQuery(raw: string): {text: string; line?: number}`.

- [ ] **Step 1: Write the failing tests**

Append to `frontend/app/view/code/codefinder.test.ts`:

```ts
describe("parseFinderQuery", () => {
    it("splits a trailing :line off the path", () => {
        expect(parseFinderQuery("app/store/codestore.ts:152")).toEqual({
            text: "app/store/codestore.ts",
            line: 152,
        });
    });

    it("reads a bare :line as a jump within the open file", () => {
        expect(parseFinderQuery(":152")).toEqual({ text: "", line: 152 });
    });

    it("leaves a query with no line alone", () => {
        expect(parseFinderQuery("codestore.ts")).toEqual({ text: "codestore.ts" });
    });

    it("does not treat digits in a filename as a line", () => {
        expect(parseFinderQuery("file2.ts")).toEqual({ text: "file2.ts" });
    });

    it("treats a trailing colon with no digits as still-typing text", () => {
        expect(parseFinderQuery("codestore.ts:")).toEqual({ text: "codestore.ts:" });
    });

    it("takes only the last :line when there are several", () => {
        expect(parseFinderQuery("a:1:2")).toEqual({ text: "a:1", line: 2 });
    });

    it("trims surrounding whitespace", () => {
        expect(parseFinderQuery("  a.ts:9  ")).toEqual({ text: "a.ts", line: 9 });
    });
});
```

Extend the file's import to `import { parseFinderQuery, rankPaths } from "./codefinder";`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run frontend/app/view/code/codefinder.test.ts`
Expected: FAIL — no export named `parseFinderQuery`.

- [ ] **Step 3: Add the parser**

Append to `frontend/app/view/code/codefinder.ts`:

```ts
export interface FinderQuery {
    text: string;
    line?: number;
}

// A trailing ":<digits>" is a line. Reusing the finder for this is why there is no second overlay
// and no Ctrl+G dialog. A trailing colon with nothing after it is someone mid-keystroke, so it
// stays part of the text.
const LINE_SUFFIX = /:(\d+)$/;

export function parseFinderQuery(raw: string): FinderQuery {
    const q = raw.trim();
    const m = LINE_SUFFIX.exec(q);
    if (m == null) {
        return { text: q };
    }
    return { text: q.slice(0, m.index), line: parseInt(m[1], 10) };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run frontend/app/view/code/codefinder.test.ts`
Expected: PASS — the seven new cases and the pre-existing `rankPaths` cases.

- [ ] **Step 5: Wire the palette**

In `frontend/app/view/code/codefinderpalette.tsx`:

Change the signature to `export function CodeFinderPalette({ model }: { model: AgentsViewModel })`, and add the imports:

```ts
import type { AgentsViewModel } from "@/app/view/agents/agents";
import { parseFinderQuery, rankPaths } from "./codefinder";
import { codeFinderOpenAtom, codeIndexAtom, codePendingLineAtom, codeProjectAtom, openInCode } from "./codestore";
```

(`openPath` and `revealPath` are no longer needed — `openInCode` does both.)

Add `const project = useAtomValue(codeProjectAtom);`, then replace the `matches` memo and `choose`:

```ts
    const parsed = useMemo(() => parseFinderQuery(query), [query]);
    const matches = useMemo(() => rankPaths(parsed.text, index?.paths ?? [], MAX_RESULTS), [parsed.text, index]);
```

```ts
    const choose = (path: string) => {
        close();
        if (project != null) {
            fireAndForget(() => openInCode(model, { projectPath: project.path, rel: path, line: parsed.line }));
        }
    };
    // a bare ":152" names no file, so it means "that line of the file already open"
    const jumpInPlace = () => {
        close();
        globalStore.set(codePendingLineAtom, parsed.line ?? null);
    };
```

In the input's `onKeyDown`, replace the Enter branch:

```ts
                        } else if (e.key === "Enter") {
                            e.preventDefault();
                            if (parsed.text === "" && parsed.line != null) {
                                jumpInPlace();
                            } else if (matches[cursor] != null) {
                                choose(matches[cursor].path);
                            }
                        }
```

Update the placeholder to `"Find a file by name — add :123 for a line"`.

- [ ] **Step 6: Pass the model in**

In `frontend/app/view/code/codesurface.tsx`, change `<CodeFinderPalette />` to `<CodeFinderPalette model={model} />`.

- [ ] **Step 7: Typecheck and run the suite**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit && npx vitest run frontend/app/view/code/`
Expected: exit 0, then PASS.

- [ ] **Step 8: Verify in the dev app**

With `task dev` running, on the Code surface with a project selected: press `Ctrl+P`, type a filename with `:120`, press Enter. Expected: the file opens scrolled to line 120 with the caret there. Then `Ctrl+P`, type `:5`, Enter. Expected: the same file jumps to line 5.

- [ ] **Step 9: Stage**

```bash
git add frontend/app/view/code/codefinder.ts frontend/app/view/code/codefinder.test.ts frontend/app/view/code/codefinderpalette.tsx frontend/app/view/code/codesurface.tsx
```

---

## Task 10: The path bar

**Files:**
- Create: `frontend/app/view/code/codepathbar.tsx`
- Modify: `frontend/app/view/code/codesurface.tsx` (`CodePanes`)

**Interfaces:**
- Consumes: `codeProjectAtom`, `codeFileAtom`, `codeDraftsAtom`, `draftKey` from `./codestore`; `joinRepoPath` from `@/util/paths`.
- Produces: `<CodePathBar model={model} />`. Task 14 adds the send-to-agent control to this file.

- [ ] **Step 1: Create the component**

```tsx
// frontend/app/view/code/codepathbar.tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Which file you are looking at, and the two things you want to do with its identity. Until this
// existed the only clue was the tree highlight, and the only copy-path affordance was buried in the
// "file too large" empty state.
//
// Save status stays in SurfaceHeader. Splitting identity from save state is a real cost, but moving
// working controls for tidiness is churn.

import type { AgentsViewModel } from "@/app/view/agents/agents";
import { joinRepoPath } from "@/util/paths";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { codeDraftsAtom, codeFileAtom, codeProjectAtom, draftKey } from "./codestore";

export function CodePathBar({ model }: { model: AgentsViewModel }) {
    void model;
    const project = useAtomValue(codeProjectAtom);
    const file = useAtomValue(codeFileAtom);
    const drafts = useAtomValue(codeDraftsAtom);
    const [copied, setCopied] = useState(false);

    if (project == null || file.kind === "none") {
        return null;
    }
    const abs = joinRepoPath(project.path, file.path);
    const dirty = file.kind === "text" && drafts.has(draftKey(project, file.path));

    return (
        <div className="flex flex-none items-center gap-2 border-b border-border px-3 py-1.5">
            <span className="min-w-0 truncate font-mono text-[11.5px] text-secondary">{file.path}</span>
            {dirty ? (
                <span
                    aria-label="Unsaved edits"
                    title="Unsaved edits"
                    className="size-[6px] flex-none rounded-full bg-accent-soft"
                />
            ) : null}
            <div className="flex-1" />
            <button
                type="button"
                aria-label="Copy absolute path"
                title={abs}
                onClick={() => {
                    void navigator.clipboard?.writeText(abs);
                    setCopied(true);
                    window.setTimeout(() => setCopied(false), 1200);
                }}
                className={cn(
                    "flex flex-none cursor-pointer items-center gap-1 rounded-[6px] border border-border px-2 py-[3px] text-[11px]",
                    copied ? "text-accent-soft" : "text-muted hover:text-primary"
                )}
            >
                {copied ? <Check size={11} strokeWidth={2} /> : <Copy size={11} strokeWidth={1.8} />}
                <span>{copied ? "Copied" : "Copy path"}</span>
            </button>
        </div>
    );
}
```

- [ ] **Step 2: Put it above the editor**

In `frontend/app/view/code/codesurface.tsx`, replace `CodePanes` with:

```tsx
function CodePanes({ model }: { model: AgentsViewModel }) {
    return (
        <div className="flex h-full w-full">
            <div className="w-[280px] flex-none">
                <CodeTreePane model={model} />
            </div>
            <div className="flex min-w-0 flex-1 flex-col">
                <CodePathBar model={model} />
                <div className="min-h-0 flex-1">
                    <CodeViewer model={model} />
                </div>
            </div>
        </div>
    );
}
```

and add `import { CodePathBar } from "./codepathbar";`.

- [ ] **Step 3: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 4: Verify in the dev app**

Open a file on the Code surface, then `node scripts/cdp-shot.mjs cdp-shots/task10-pathbar.png`. Expected: the repo-relative path appears above the editor with a "Copy path" button; the editor is not clipped or shifted off-screen. Click "Copy path" and confirm the label flips to "Copied" and the clipboard holds the absolute path.

- [ ] **Step 5: Stage**

```bash
git add frontend/app/view/code/codepathbar.tsx frontend/app/view/code/codesurface.tsx
```

---

# Phase 3 — Content search

## Task 11: Grouping search results

**Files:**
- Create: `frontend/app/view/code/codesearch.ts`
- Test: `frontend/app/view/code/codesearch.test.ts`

**Interfaces:**
- Consumes: the ambient generated type `GitGrepMatch` (`{path: string; line: number; text: string}`) — do not import it.
- Produces: `SearchGroup {path: string; matches: GitGrepMatch[]}`, `groupMatches(matches): SearchGroup[]`, `summarize(groups, truncated): string`.

- [ ] **Step 1: Write the failing tests**

Create `frontend/app/view/code/codesearch.test.ts`:

```ts
// frontend/app/view/code/codesearch.test.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { groupMatches, summarize } from "./codesearch";

const m = (path: string, line: number, text = "hit"): GitGrepMatch => ({ path, line, text });

describe("groupMatches", () => {
    it("groups consecutive matches in one file", () => {
        const groups = groupMatches([m("a.ts", 1), m("a.ts", 9)]);
        expect(groups).toHaveLength(1);
        expect(groups[0].path).toBe("a.ts");
        expect(groups[0].matches.map((x) => x.line)).toEqual([1, 9]);
    });

    it("keeps git's file order rather than sorting", () => {
        const groups = groupMatches([m("z.ts", 1), m("a.ts", 1)]);
        expect(groups.map((g) => g.path)).toEqual(["z.ts", "a.ts"]);
    });

    it("regroups a file that reappears later instead of duplicating it", () => {
        const groups = groupMatches([m("a.ts", 1), m("b.ts", 2), m("a.ts", 3)]);
        expect(groups.map((g) => g.path)).toEqual(["a.ts", "b.ts"]);
        expect(groups[0].matches.map((x) => x.line)).toEqual([1, 3]);
    });

    it("returns nothing for no matches", () => {
        expect(groupMatches([])).toEqual([]);
    });
});

describe("summarize", () => {
    it("counts matches and files", () => {
        expect(summarize(groupMatches([m("a.ts", 1), m("a.ts", 2), m("b.ts", 1)]), false)).toBe(
            "3 matches in 2 files"
        );
    });

    it("uses the singular for one of each", () => {
        expect(summarize(groupMatches([m("a.ts", 1)]), false)).toBe("1 match in 1 file");
    });

    it("says so when the result was truncated", () => {
        expect(summarize(groupMatches([m("a.ts", 1)]), true)).toBe("1 match in 1 file (truncated)");
    });

    it("says nothing matched for an empty result", () => {
        expect(summarize([], false)).toBe("No matches");
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run frontend/app/view/code/codesearch.test.ts`
Expected: FAIL — cannot resolve `./codesearch`.

- [ ] **Step 3: Write the implementation**

Create `frontend/app/view/code/codesearch.ts`:

```ts
// frontend/app/view/code/codesearch.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pure: shape a flat list of grep matches into what the results pane draws. git's order is kept
// rather than sorted — it walks the index, so its order is already the repository's own.

export interface SearchGroup {
    path: string;
    matches: GitGrepMatch[];
}

export function groupMatches(matches: readonly GitGrepMatch[]): SearchGroup[] {
    const out: SearchGroup[] = [];
    const byPath = new Map<string, SearchGroup>();
    for (const match of matches) {
        let group = byPath.get(match.path);
        if (group == null) {
            group = { path: match.path, matches: [] };
            byPath.set(match.path, group);
            out.push(group); // first appearance fixes the file's position
        }
        group.matches.push(match);
    }
    return out;
}

export function summarize(groups: readonly SearchGroup[], truncated: boolean): string {
    if (groups.length === 0) {
        return "No matches";
    }
    const files = groups.length;
    const total = groups.reduce((n, g) => n + g.matches.length, 0);
    const head = `${total} ${total === 1 ? "match" : "matches"} in ${files} ${files === 1 ? "file" : "files"}`;
    return truncated ? `${head} (truncated)` : head;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run frontend/app/view/code/codesearch.test.ts`
Expected: PASS, all eight cases.

- [ ] **Step 5: Stage**

```bash
git add frontend/app/view/code/codesearch.ts frontend/app/view/code/codesearch.test.ts
```

---

## Task 12: The search store

**Files:**
- Create: `frontend/app/view/code/codesearchstore.ts`
- Modify: `frontend/app/view/code/codestore.ts` (reset search on project switch)

**Interfaces:**
- Consumes: `RpcApi.GitGrepCommand` (Task 2).
- Produces: `codeSearchModeAtom: PrimitiveAtom<"files" | "search">`, `codeSearchQueryAtom: PrimitiveAtom<string>`, `codeSearchAtom: PrimitiveAtom<SearchState>`, `runSearch(project: CodeProject, query: string): Promise<void>`, `resetSearch(): void`.
- **Import direction matters:** this module must not import from `codestore.ts`. `runSearch` takes the project as an argument precisely so that `codestore.ts` can import `resetSearch` without a cycle.

- [ ] **Step 1: Create the store**

```ts
// frontend/app/view/code/codesearchstore.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Content-search state for the Code surface. Its own module rather than more of codestore.ts, which
// is already 325 lines and owns a different concern (the file index and the open buffer).
//
// It deliberately imports nothing from codestore: runSearch takes the project as an argument, so
// codestore can import resetSearch to clear this on a project switch without an import cycle.

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { atom, type PrimitiveAtom } from "jotai";

// One union rather than parallel loading/error booleans, for the same reason CodeFile is one: the
// pane renders an exhaustive switch and cannot land in a contradictory pair of states.
export type SearchState =
    | { kind: "idle" }
    | { kind: "searching"; query: string }
    | { kind: "done"; query: string; matches: GitGrepMatch[]; truncated: boolean }
    | { kind: "error"; query: string; message: string };

export const codeSearchModeAtom = atom<"files" | "search">("files") as PrimitiveAtom<"files" | "search">;
export const codeSearchQueryAtom = atom<string>("") as PrimitiveAtom<string>;
export const codeSearchAtom = atom<SearchState>({ kind: "idle" }) as PrimitiveAtom<SearchState>;

// The RPC layer's DefaultTimeoutMs is 5s and it binds the SERVER-side context, so a search the
// server would have finished gets killed under it. The reader self-limits at gitinfo's 10s
// gitTimeout; this ceiling sits above that so git's own limit is the one that decides.
const GREP_RPC_TIMEOUT_MS = 20_000;

// guards a slow search against a newer one, same pattern as codestore's index and file loads
const current = { token: "" };

export async function runSearch(project: { path: string }, query: string): Promise<void> {
    const q = query.trim();
    if (q === "") {
        globalStore.set(codeSearchAtom, { kind: "idle" });
        return;
    }
    const token = `${project.path}|${q}`;
    current.token = token;
    globalStore.set(codeSearchAtom, { kind: "searching", query: q });
    try {
        const res = await RpcApi.GitGrepCommand(
            TabRpcClient,
            { cwd: project.path, query: q },
            { timeout: GREP_RPC_TIMEOUT_MS }
        );
        if (current.token !== token) {
            return;
        }
        globalStore.set(codeSearchAtom, {
            kind: "done",
            query: q,
            matches: res.matches ?? [],
            truncated: res.truncated ?? false,
        });
    } catch (e) {
        if (current.token !== token) {
            return;
        }
        // a failed RPC is an error, not an empty repository — the same distinction the index load makes
        globalStore.set(codeSearchAtom, {
            kind: "error",
            query: q,
            message: e instanceof Error ? e.message : String(e),
        });
    }
}

export function resetSearch(): void {
    current.token = "";
    globalStore.set(codeSearchQueryAtom, "");
    globalStore.set(codeSearchAtom, { kind: "idle" });
    globalStore.set(codeSearchModeAtom, "files");
}
```

- [ ] **Step 2: Clear search when the project changes**

In `frontend/app/view/code/codestore.ts`, add `import { resetSearch } from "./codesearchstore";` and call it inside `selectProject`, beside the other resets:

```ts
    resetSearch(); // results belong to the repository they were found in
```

- [ ] **Step 3: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0. A "circular dependency" or undefined-at-import error here means Step 1's rule was broken — `codesearchstore.ts` must not import from `codestore.ts`.

- [ ] **Step 4: Stage**

```bash
git add frontend/app/view/code/codesearchstore.ts frontend/app/view/code/codestore.ts
```

---

## Task 13: The search pane and the two-mode column

**Files:**
- Create: `frontend/app/view/code/codesearchpane.tsx`
- Modify: `frontend/app/view/code/codesurface.tsx` (`CodePanes` + a column-tabs component)
- Modify: `frontend/app/store/keybindings/bindings.ts` (the search key)

**Interfaces:**
- Consumes: `groupMatches`, `summarize` (Task 11); `codeSearchModeAtom`, `codeSearchQueryAtom`, `codeSearchAtom`, `runSearch` (Task 12); `openInCode`, `codeProjectAtom` (Task 8).
- Produces: `<CodeSearchPane model={model} />`, and the binding `code:search` on `Ctrl:Shift:f`.

- [ ] **Step 1: Create the pane**

```tsx
// frontend/app/view/code/codesearchpane.tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Content search results, in the left column rather than an overlay: results are read repeatedly
// while jumping between them, and an overlay that closes on each jump makes that a loop of
// reopening. Every result row goes through openInCode, the same primitive the finder and the two
// cockpit entry points use.

import type { AgentsViewModel } from "@/app/view/agents/agents";
import { cn, fireAndForget } from "@/util/util";
import { useAtom, useAtomValue } from "jotai";
import { useEffect, useMemo, useRef } from "react";
import { groupMatches, summarize } from "./codesearch";
import { codeSearchAtom, codeSearchQueryAtom, runSearch } from "./codesearchstore";
import { codeProjectAtom, openInCode } from "./codestore";

export function CodeSearchPane({ model }: { model: AgentsViewModel }) {
    const project = useAtomValue(codeProjectAtom);
    const [query, setQuery] = useAtom(codeSearchQueryAtom);
    const state = useAtomValue(codeSearchAtom);
    const inputRef = useRef<HTMLInputElement>(null);

    // the surface unmounts on nav switch, so this runs on every return to Search mode — which is
    // what you want: the query survives in an atom, the caret comes back to it
    useEffect(() => {
        inputRef.current?.focus();
    }, []);

    const groups = useMemo(
        () => (state.kind === "done" ? groupMatches(state.matches) : []),
        [state]
    );

    const submit = () => {
        if (project != null) {
            fireAndForget(() => runSearch(project, query));
        }
    };

    return (
        <div className="flex h-full flex-col border-r border-border">
            <div className="flex-none px-2 py-2">
                <input
                    ref={inputRef}
                    value={query}
                    placeholder="Search file contents"
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === "Enter") {
                            e.preventDefault();
                            submit();
                        }
                    }}
                    className="w-full rounded-[8px] border border-border bg-surface px-2 py-1 text-[12px] text-primary outline-none placeholder:text-muted"
                />
            </div>
            <SearchBody model={model} state={state} groups={groups} onRetry={submit} />
        </div>
    );
}

function SearchBody({
    model,
    state,
    groups,
    onRetry,
}: {
    model: AgentsViewModel;
    state: ReturnType<typeof useAtomValue<typeof codeSearchAtom>>;
    groups: ReturnType<typeof groupMatches>;
    onRetry: () => void;
}) {
    const project = useAtomValue(codeProjectAtom);
    if (state.kind === "idle") {
        return <div className="px-3 py-2 text-[11.5px] text-muted">Type a string and press Enter.</div>;
    }
    if (state.kind === "searching") {
        return <div className="px-3 py-2 text-[11.5px] text-muted">Searching…</div>;
    }
    if (state.kind === "error") {
        return (
            <div className="px-3 py-2 text-[11.5px] text-muted">
                <p className="text-error">Search failed: {state.message}</p>
                <button
                    type="button"
                    onClick={onRetry}
                    className="mt-1 cursor-pointer rounded-[6px] border border-border px-2 py-[3px] text-[11px] hover:text-primary"
                >
                    Retry
                </button>
            </div>
        );
    }
    return (
        <>
            <div className="flex-none px-3 pb-1 text-[10.5px] text-muted">{summarize(groups, state.truncated)}</div>
            <div className="min-h-0 flex-1 overflow-y-auto pb-2">
                {groups.map((group) => (
                    <div key={group.path}>
                        <div className="sticky top-0 bg-surface px-2 py-1 font-mono text-[10.5px] text-muted">
                            {group.path}
                        </div>
                        {group.matches.map((match) => (
                            <div
                                key={`${match.path}:${match.line}`}
                                onClick={() => {
                                    if (project != null) {
                                        fireAndForget(() =>
                                            openInCode(model, {
                                                projectPath: project.path,
                                                rel: match.path,
                                                line: match.line,
                                            })
                                        );
                                    }
                                }}
                                className={cn(
                                    "flex cursor-pointer gap-2 px-3 py-[2px] text-[11.5px] hover:bg-accent/10"
                                )}
                            >
                                <span className="w-[34px] flex-none text-right font-mono text-[10.5px] text-muted">
                                    {match.line}
                                </span>
                                <span className="min-w-0 truncate font-mono text-secondary">{match.text.trim()}</span>
                            </div>
                        ))}
                    </div>
                ))}
            </div>
        </>
    );
}
```

- [ ] **Step 2: Add the column tabs and the mode switch**

In `frontend/app/view/code/codesurface.tsx`, add imports:

```ts
import { codeSearchModeAtom } from "./codesearchstore";
import { CodeSearchPane } from "./codesearchpane";
```

and replace `CodePanes` with:

```tsx
function CodePanes({ model }: { model: AgentsViewModel }) {
    const [mode, setMode] = useAtom(codeSearchModeAtom);
    return (
        <div className="flex h-full w-full">
            {/* Search rows carry a line number and a line of source, which is unreadable at the
                tree's width, so the column widens for them rather than truncating everything. */}
            <div className={cn("flex flex-none flex-col", mode === "search" ? "w-[380px]" : "w-[280px]")}>
                <div className="flex flex-none gap-1 border-b border-border px-2 py-1">
                    {(["files", "search"] as const).map((m) => (
                        <button
                            key={m}
                            type="button"
                            data-code-column-tab={m}
                            onClick={() => setMode(m)}
                            className={cn(
                                "cursor-pointer rounded-[6px] px-2 py-[3px] text-[11px] capitalize",
                                m === mode ? "bg-accent/10 text-accent-soft" : "text-muted hover:text-primary"
                            )}
                        >
                            {m}
                        </button>
                    ))}
                </div>
                <div className="min-h-0 flex-1">
                    {mode === "files" ? <CodeTreePane model={model} /> : <CodeSearchPane model={model} />}
                </div>
            </div>
            <div className="flex min-w-0 flex-1 flex-col">
                <CodePathBar model={model} />
                <div className="min-h-0 flex-1">
                    <CodeViewer model={model} />
                </div>
            </div>
        </div>
    );
}
```

Add `useAtom` to the jotai import in that file.

- [ ] **Step 3: Add the keybinding**

In `buildCodeBindings()` in `frontend/app/store/keybindings/bindings.ts`, add:

```ts
        {
            id: "code:search",
            keys: "Ctrl:Shift:f",
            group: "Code",
            label: "Search file contents",
            // like the file finder's Ctrl+P and save's Ctrl+S, deliberately NOT gated on !editable:
            // the caret is in Monaco when you want this, so a bare letter would be unreachable
            when: (ctx) => ctx.surface === "code" && !ctx.modalOpen,
            run: () => globalStore.set(codeSearchModeAtom, "search"),
        },
```

and import `codeSearchModeAtom` from `@/app/view/code/codesearchstore`.

- [ ] **Step 4: Run the keybinding conflict tests**

Run: `npx vitest run frontend/app/store/keybindings/store.test.ts`
Expected: PASS. `Ctrl:Shift:f` must not collide with a global chord.

- [ ] **Step 5: Typecheck and run the whole suite**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit && npx vitest run`
Expected: exit 0, then PASS.

- [ ] **Step 6: Verify in the dev app**

Requires Task 2's `task build:backend` to have run. On the Code surface with a project selected: press `Ctrl+Shift+F`, type a string you know appears in several files, press Enter. Expected: the column widens, results group by file with line numbers, the summary line counts them, and clicking a result opens that file scrolled to that line. Then search a nonsense string and confirm "No matches" rather than an error.

- [ ] **Step 7: Stage**

```bash
git add frontend/app/view/code/codesearchpane.tsx frontend/app/view/code/codesurface.tsx frontend/app/store/keybindings/bindings.ts
```

---

## Task 14: The rendered-search CDP scenario

**Files:**
- Modify: `scripts/cdp/scenarios.mjs`

**Interfaces:**
- Consumes: the harness helpers `h.goto`, `h.ev`, `h.shot`, `h.activeSurfaceLabel` from `scripts/cdp/attach.mjs`; the `data-code-project-picker` attribute already on the picker button and the `data-code-column-tab` attribute added in Task 13.
- Produces: a `code-search` scenario runnable via `task verify:ui -- code-search`.

- [ ] **Step 1: Add the scenario**

Hand-format to the file's existing four-space indentation. Add before the array/registry of scenarios at the end of the file, then register `codeSearch` there alongside the others (match how `surfaceSmoke` is registered).

```js
// --- code: content search ----------------------------------------------------------------------
// Drives the real grep RPC, so it needs a backend built with GitGrepCommand (task build:backend).
// The query is a string this repository certainly contains; asserting "some rows" rather than an
// exact count keeps it from breaking on every edit.
const CODE_SEARCH_QUERY = "openInCode";

const pickFirstProject = (h) =>
    h.ev(`(() => {
        const chip = document.querySelector('[data-code-project-picker]');
        if (!chip) return 'no-picker';
        if (!document.querySelector('[data-code-column-tab]')) chip.click();
        return 'ok';
    })()`);

const chooseProjectRow = (h) =>
    h.ev(`(() => {
        const rows = [...document.querySelectorAll('button')].filter((b) => b.querySelector('.font-mono'));
        if (!rows.length) return false;
        rows[0].click();
        return true;
    })()`);

const setSearchQuery = (h, text) =>
    h.ev(`(() => {
        const input = document.querySelector('input[placeholder="Search file contents"]');
        if (!input) return false;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(input, ${JSON.stringify(text)});
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        return true;
    })()`);

const codeSearch = {
    name: "code-search",
    surface: "code",
    async arrange() {
        return {};
    },
    async assert(h) {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const steps = [];
        await h.goto("code");
        steps.push({
            step: "Code surface is active",
            ok: (await h.activeSurfaceLabel()) === SURFACE_LABEL.code,
            detail: `active=${await h.activeSurfaceLabel()}`,
        });

        await pickFirstProject(h);
        await sleep(300);
        await chooseProjectRow(h);
        await sleep(1200); // the index is one git ls-files call

        const switched = await h.ev(`(() => {
            const t = document.querySelector('[data-code-column-tab="search"]');
            if (!t) return false;
            t.click();
            return true;
        })()`);
        steps.push({ step: "switch the left column to Search", ok: switched === true, detail: `switched=${switched}` });

        const typed = await setSearchQuery(h, CODE_SEARCH_QUERY);
        steps.push({ step: "type a query and submit", ok: typed === true, detail: `typed=${typed}` });

        // poll rather than sleep a guessed interval: the RPC shells out to git
        let summary = "";
        for (let i = 0; i < 20; i++) {
            summary = await h.ev(
                `(() => { const el=[...document.querySelectorAll('div')].find((d)=>/match(es)? in \\\\d+ file/.test(d.textContent||'')); return el?(el.textContent||'').trim():''; })()`
            );
            if (summary) break;
            await sleep(500);
        }
        steps.push({
            step: `search "${CODE_SEARCH_QUERY}" reports a match summary`,
            ok: summary !== "",
            detail: `summary=${summary || "(none)"}`,
        });

        await h.shot("cdp-shots/code-search.png");
        return steps;
    },
    async teardown(h) {
        await h.goto("cockpit"); // leave the app where a human expects it
    },
};
```

- [ ] **Step 2: Run the scenario**

Run: `task verify:ui -- code-search`
Expected: a PASS row per step and exit 0. Requires `task dev` running with the debug flag and a backend built from Task 2.

If it fails with `ECONNREFUSED :9222`, that usually means another session's edit crashed `task dev` rather than a CDP problem — check the dev log for "going away" before debugging the scenario.

- [ ] **Step 3: Confirm the existing smoke scenario still passes**

Run: `task verify:ui -- surface-smoke`
Expected: PASS for all nine surfaces, `code` included.

- [ ] **Step 4: Stage**

```bash
git add scripts/cdp/scenarios.mjs
```

---

# Phase 4 — The cockpit connections

## Task 15: Composing the agent handoff

**Files:**
- Create: `frontend/app/view/code/codehandoff.ts`
- Test: `frontend/app/view/code/codehandoff.test.ts`

**Interfaces:**
- Consumes: `AgentVM` from `@/app/view/agents/agentsviewmodel` (fields used: `blockId`, `kind`, `project`, `name`, `id`).
- Produces: `handoffLine({rel, startLine?, endLine?, note?}): string` and `liveAgentsForProject(agents, projectName): AgentVM[]`.

- [ ] **Step 1: Write the failing tests**

Create `frontend/app/view/code/codehandoff.test.ts`:

```ts
// frontend/app/view/code/codehandoff.test.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { AgentVM } from "@/app/view/agents/agentsviewmodel";
import { describe, expect, it } from "vitest";
import { handoffLine, liveAgentsForProject } from "./codehandoff";

const agent = (over: Partial<AgentVM>): AgentVM =>
    ({ id: "t1", name: "a", task: "", state: "working", ...over }) as AgentVM;

describe("handoffLine", () => {
    it("references the file when there is no selection", () => {
        expect(handoffLine({ rel: "src/a.ts" })).toBe("look at src/a.ts");
    });

    it("references a single line", () => {
        expect(handoffLine({ rel: "src/a.ts", startLine: 12, endLine: 12 })).toBe("look at src/a.ts:12");
    });

    it("references a line range", () => {
        expect(handoffLine({ rel: "src/a.ts", startLine: 12, endLine: 40 })).toBe("look at src/a.ts:12-40");
    });

    it("appends a note", () => {
        expect(handoffLine({ rel: "src/a.ts", startLine: 3, endLine: 3, note: "this leaks" })).toBe(
            "look at src/a.ts:3 — this leaks"
        );
    });

    it("is always ONE line, because the payload is injected into a PTY and submitted on the first newline", () => {
        const out = handoffLine({ rel: "src/a.ts", note: "first\nsecond\n\tthird" });
        expect(out).toBe("look at src/a.ts — first second third");
        expect(out.includes("\n")).toBe(false);
    });

    it("ignores a whitespace-only note", () => {
        expect(handoffLine({ rel: "src/a.ts", note: "   \n  " })).toBe("look at src/a.ts");
    });
});

describe("liveAgentsForProject", () => {
    const roster: AgentVM[] = [
        agent({ id: "match", project: "waveterm", blockId: "b1" }),
        agent({ id: "other-project", project: "elsewhere", blockId: "b2" }),
        agent({ id: "no-block", project: "waveterm" }),
        agent({ id: "terminal", project: "waveterm", blockId: "b3", kind: "terminal" }),
        agent({ id: "background", project: "waveterm", blockId: "b4", kind: "background" }),
        agent({ id: "explicit-agent", project: "waveterm", blockId: "b5", kind: "agent" }),
    ];

    it("keeps agents in this project that have a terminal block to write to", () => {
        expect(liveAgentsForProject(roster, "waveterm").map((a) => a.id)).toEqual(["match", "explicit-agent"]);
    });

    it("returns nothing for an unknown project", () => {
        expect(liveAgentsForProject(roster, "nope")).toEqual([]);
    });

    it("returns nothing for a blank project name, so a worktree cannot match everything", () => {
        expect(liveAgentsForProject(roster, "")).toEqual([]);
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run frontend/app/view/code/codehandoff.test.ts`
Expected: FAIL — cannot resolve `./codehandoff`.

- [ ] **Step 3: Write the implementation**

Create `frontend/app/view/code/codehandoff.ts`:

```ts
// frontend/app/view/code/codehandoff.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pure: what gets handed to an agent, and which agents can receive it.
//
// The payload is a REFERENCE, never a snippet, and always exactly one line. ControllerInputCommand
// appends a carriage return and submits, so a multi-line payload would submit at its first newline
// and dribble the rest in as separate messages. Reading the file is what the agent is for.

import type { AgentVM } from "@/app/view/agents/agentsviewmodel";

export function handoffLine(a: { rel: string; startLine?: number; endLine?: number; note?: string }): string {
    let ref = a.rel;
    if (a.startLine != null) {
        ref += a.endLine != null && a.endLine !== a.startLine ? `:${a.startLine}-${a.endLine}` : `:${a.startLine}`;
    }
    // collapsing every run of whitespace is what guarantees the single line above
    const note = (a.note ?? "").replace(/\s+/g, " ").trim();
    return note === "" ? `look at ${ref}` : `look at ${ref} — ${note}`;
}

// Agents that can receive a keystroke injection for this project: a real agent (not a plain
// terminal, not a detached background agent) with a terminal block to write to. A blank project
// name matches nothing — a worktree browsed outside the registry has no registry name, and must
// fall back to the clipboard rather than claiming every agent.
export function liveAgentsForProject(agents: readonly AgentVM[], projectName: string): AgentVM[] {
    if (!projectName) {
        return [];
    }
    return agents.filter(
        (a) => !!a.blockId && (a.kind == null || a.kind === "agent") && a.project === projectName
    );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run frontend/app/view/code/codehandoff.test.ts`
Expected: PASS, all nine cases.

- [ ] **Step 5: Stage**

```bash
git add frontend/app/view/code/codehandoff.ts frontend/app/view/code/codehandoff.test.ts
```

---

## Task 16: The send-to-agent control

**Files:**
- Modify: `frontend/app/view/code/codepathbar.tsx`

**Interfaces:**
- Consumes: `handoffLine`, `liveAgentsForProject` (Task 15); `codeEditorSelection` (Task 8); `model.agentsAtom`; `RpcApi.ControllerInputCommand`; `stringToBase64` from `@/util/util`; `PopoverReveal` from `@/app/element/popoverreveal`.
- Produces: a `<SendToAgent>` control rendered inside the path bar.

- [ ] **Step 1: Add the control**

In `frontend/app/view/code/codepathbar.tsx`, add imports:

```ts
import { PopoverReveal } from "@/app/element/popoverreveal";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import type { AgentVM } from "@/app/view/agents/agentsviewmodel";
import { stringToBase64 } from "@/util/util";
import { Send } from "lucide-react";
import { handoffLine, liveAgentsForProject } from "./codehandoff";
import { codeEditorSelection } from "./codeviewer";
```

Render `<SendToAgent model={model} rel={file.path} projectName={project.name} />` in the path bar after the copy button, drop the `void model;` line, and append:

```tsx
// A handoff is a keystroke injection into a live agent's terminal — exactly what typing there
// yourself would do. Deliberately not recorded: channel steering posts a directive message so a
// channel timeline stays the source of truth, and this surface has no channel to post to.
function SendToAgent({
    model,
    rel,
    projectName,
}: {
    model: AgentsViewModel;
    rel: string;
    projectName: string;
}) {
    const agents = useAtomValue(model.agentsAtom);
    const [open, setOpen] = useState(false);
    const [note, setNote] = useState("");
    const [sent, setSent] = useState<string | null>(null);
    const targets = liveAgentsForProject(agents, projectName);

    const compose = () => {
        const sel = codeEditorSelection();
        return handoffLine({ rel, startLine: sel?.startLine, endLine: sel?.endLine, note });
    };

    const send = (target: AgentVM) => {
        const line = compose();
        setOpen(false);
        setNote("");
        setSent(`Sent to ${target.name}`);
        window.setTimeout(() => setSent(null), 1600);
        void RpcApi.ControllerInputCommand(TabRpcClient, {
            blockid: target.blockId!,
            inputdata64: stringToBase64(line + "\r"),
        });
    };

    // no live agent for this project — and a worktree browsed outside the registry never has one,
    // so the clipboard is the honest fallback rather than a disabled button with no explanation
    const copyInstead = () => {
        void navigator.clipboard?.writeText(compose());
        setOpen(false);
        setNote("");
        setSent("Copied reference");
        window.setTimeout(() => setSent(null), 1600);
    };

    return (
        <div className="relative flex-none">
            <button
                type="button"
                onClick={() => setOpen((v) => !v)}
                className="flex cursor-pointer items-center gap-1 rounded-[6px] border border-border px-2 py-[3px] text-[11px] text-muted hover:text-primary"
            >
                <Send size={11} strokeWidth={1.8} />
                <span>{sent ?? (targets.length === 0 ? "Copy reference" : "Send to agent")}</span>
            </button>
            <PopoverReveal
                open={open}
                origin="top right"
                className="absolute right-0 top-[calc(100%+6px)] z-20 w-[280px] overflow-hidden rounded-[10px] border border-border bg-surface p-2 shadow-lg"
            >
                <p className="px-1 pb-1 font-mono text-[10.5px] text-muted">{compose()}</p>
                <input
                    value={note}
                    placeholder="Add a note (optional)"
                    onChange={(e) => setNote(e.target.value)}
                    className="mb-1.5 w-full rounded-[6px] border border-border bg-surface px-2 py-1 text-[11.5px] text-primary outline-none placeholder:text-muted"
                />
                {targets.length === 0 ? (
                    <>
                        <p className="px-1 pb-1 text-[11px] text-muted">
                            No agent is running in this project. Copy the reference instead.
                        </p>
                        <button
                            type="button"
                            onClick={copyInstead}
                            className="w-full cursor-pointer rounded-[6px] border border-border px-2 py-1 text-[11.5px] text-secondary hover:text-primary"
                        >
                            Copy reference
                        </button>
                    </>
                ) : (
                    targets.map((t) => (
                        <button
                            key={t.id}
                            type="button"
                            onClick={() => send(t)}
                            className="flex w-full cursor-pointer items-center justify-between rounded-[6px] px-2 py-1 text-left text-[11.5px] text-secondary hover:bg-accent/10 hover:text-primary"
                        >
                            <span className="truncate">{t.name}</span>
                            <span className="flex-none pl-2 font-mono text-[10px] text-muted">{t.state}</span>
                        </button>
                    ))
                )}
            </PopoverReveal>
        </div>
    );
}
```

- [ ] **Step 2: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 3: Verify with a live agent**

With `task dev` running, launch an agent on a registered project, then open that same project on the Code surface, open a file, select a few lines, and click "Send to agent". Expected: the popover previews a single line like `look at frontend/app/view/code/codestore.ts:152-160`, and choosing the agent makes that text appear as a submitted message in the agent's terminal. Then open a project with no running agent and confirm the button reads "Copy reference" and the clipboard receives the line.

- [ ] **Step 4: Stage**

```bash
git add frontend/app/view/code/codepathbar.tsx
```

---

## Task 17: Jumping in from a diff

**Files:**
- Modify: `frontend/app/view/agents/gitdiff.ts`
- Test: `frontend/app/view/agents/gitdiff.test.ts`
- Modify: `frontend/app/view/agents/filessurface.tsx` (`CenterPane` at line 254, and its call site near line 690)

**Interfaces:**
- Consumes: `FileView` and `DiffLine` from `./gitdiff`; `openInCode` (Task 8).
- Produces: `firstChangedLine(view: FileView): number | undefined`, and an "Open in Code" button on the diff pane header.

- [ ] **Step 1: Write the failing tests**

Append to `frontend/app/view/agents/gitdiff.test.ts`:

```ts
describe("firstChangedLine", () => {
    it("returns the new-side number of the first added line", () => {
        const view = parseUnifiedDiff(
            ["@@ -10,3 +10,4 @@", " ctx one", "+added here", " ctx two"].join("\n")
        );
        expect(firstChangedLine(view)).toBe(11);
    });

    it("falls back to the first numbered line for a deletion-only hunk", () => {
        const view = parseUnifiedDiff(["@@ -10,3 +10,2 @@", " ctx one", "-gone", " ctx two"].join("\n"));
        expect(firstChangedLine(view)).toBe(10);
    });

    it("returns undefined when there is nothing to land on", () => {
        expect(firstChangedLine(parseUnifiedDiff(""))).toBeUndefined();
    });
});
```

Extend that file's import to include `firstChangedLine` alongside `parseUnifiedDiff`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run frontend/app/view/agents/gitdiff.test.ts`
Expected: FAIL — no export named `firstChangedLine`.

- [ ] **Step 3: Add the helper**

Append to `frontend/app/view/agents/gitdiff.ts`:

```ts
// Where a jump into the Code surface should land: the first added line's new-side number. A
// deletion-only hunk has no added line, so its first numbered line — the context line the hunk
// starts on — is the closest honest answer.
export function firstChangedLine(view: FileView): number | undefined {
    const line = view.lines.find((l) => l.kind === "add") ?? view.lines.find((l) => l.gNew !== "");
    if (line == null) {
        return undefined;
    }
    const n = parseInt(line.gNew, 10);
    return Number.isFinite(n) ? n : undefined;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run frontend/app/view/agents/gitdiff.test.ts`
Expected: PASS — the three new cases plus every pre-existing one.

- [ ] **Step 5: Rename the working-tree-only prop and add the repository prop**

In `frontend/app/view/agents/filessurface.tsx`, change `CenterPane`'s signature and body. The existing `cwd` becomes `editorCwd` because it is null unless you are looking at the working tree — shelling out to the OS editor only makes sense for a file on disk. The new `repoCwd` is the repository, always present, because the Code surface always shows the working-tree file and its own "file no longer exists" state covers a path that is gone.

```tsx
function CenterPane({
    path,
    view,
    editorCwd,
    repoCwd,
    model,
}: {
    path: string | null;
    view: FileView | null;
    editorCwd: string | null;
    repoCwd: string | null;
    model: AgentsViewModel;
}) {
```

In its header row, replace the `{cwd && (...)}` block with:

```tsx
                        {repoCwd && (
                            <button
                                onClick={() =>
                                    fireAndForget(() =>
                                        openInCode(model, {
                                            projectPath: repoCwd,
                                            rel: path,
                                            line: view != null ? firstChangedLine(view) : undefined,
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
```

Add to that file's imports:

```ts
import { firstChangedLine } from "./gitdiff";
import { openInCode } from "@/app/view/code/codestore";
```

(if `firstChangedLine` can join an existing `./gitdiff` import, do that instead of adding a second line).

- [ ] **Step 6: Update the call site**

Near line 690, change the `<CenterPane .../>` props to:

```tsx
                            <CenterPane
                                path={compareOn ? compareFile : selectedFile}
                                view={compareOn ? compareDiff : activeDiff}
                                // "Open in editor" only makes sense for a path that exists in the working tree
                                editorCwd={!compareOn && selectedCommit === WORKING_TREE ? (state?.cwd ?? null) : null}
                                // "Open in Code" wants only the repository: the Code surface always shows the
                                // working-tree file, and says so itself when the path is gone
                                repoCwd={state?.cwd ?? null}
                                model={model}
                            />
```

`model` is already in scope here — verified: `CenterPane` is a module-level function at line 254, and its only call site is inside `FilesSurface({ model })`, which begins at line 306. Nothing needs threading.

- [ ] **Step 7: Check `git status` before staging**

Run: `git status --short frontend/app/view/agents/filessurface.tsx`
Expected: modified by you only. This file is over 700 lines and parallel sessions edit this tree — if it carries changes you did not make, stop and reconcile rather than staging them.

- [ ] **Step 8: Typecheck and run the suite**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit && npx vitest run`
Expected: exit 0, then PASS.

- [ ] **Step 9: Verify in the dev app**

On the Diff surface, select a commit and a changed file, then click "Open in Code". Expected: the Code surface opens that repository, that file, scrolled to the first changed line. Repeat from a working-tree diff and confirm both buttons appear there while only "Open in Code" appears on a historical commit.

- [ ] **Step 10: Stage**

```bash
git add frontend/app/view/agents/gitdiff.ts frontend/app/view/agents/gitdiff.test.ts frontend/app/view/agents/filessurface.tsx
```

---

## Task 18: Jumping in from a Radar finding

**Files:**
- Modify: `frontend/app/view/agents/radarfindingdetail.tsx` (the affected-files list at ~line 146)

**Interfaces:**
- Consumes: `openInCode` (Task 8); the component's existing `model`, `report` (`report.projectpath`) and `finding` (`finding.files`) props.
- Produces: clickable affected-file rows.

- [ ] **Step 1: Make the rows open the file**

Replace the affected-files `<ul>` body:

```tsx
                    <ul>
                        {finding.files.map((f) => (
                            <li key={f} className="border-b border-border last:border-b-0">
                                {/* findings carry no line numbers, so this lands at the top of the file */}
                                <button
                                    type="button"
                                    onClick={() =>
                                        fireAndForget(() =>
                                            openInCode(model, { projectPath: report.projectpath, rel: f })
                                        )
                                    }
                                    className="w-full cursor-pointer truncate px-3 py-1.5 text-left font-mono text-xs text-muted-foreground hover:bg-accent/10 hover:text-primary"
                                >
                                    {f}
                                </button>
                            </li>
                        ))}
                    </ul>
```

Add `import { openInCode } from "@/app/view/code/codestore";`. `fireAndForget` is already imported in this file.

- [ ] **Step 2: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 3: Verify in the dev app**

On the Radar surface, open a finding that lists affected files and click one. Expected: the Code surface opens that project with that file open at the top.

- [ ] **Step 4: Stage**

```bash
git add frontend/app/view/agents/radarfindingdetail.tsx
```

---

## Task 19: Full verification and the single commit

**Files:** none — this task verifies and commits everything staged by Tasks 1 to 18.

- [ ] **Step 1: Run the whole frontend suite**

Run: `npx vitest run`
Expected: PASS. Report the actual counts; do not claim success without reading the output.

- [ ] **Step 2: Run the Go tests for the touched packages**

```powershell
$env:CGO_CFLAGS = "-O2 -g -I$((Get-Location).Path -replace '\\','/')/pkg/jarvisembed/csrc"
go test ./pkg/gitinfo/... ./pkg/wshrpc/...
```
Expected: `ok` for each.

- [ ] **Step 3: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0. The baseline is clean, so any error is from this work.

- [ ] **Step 4: Lint and format-check only the files this work touched**

Run: `npx eslint frontend/app/view/code frontend/util/paths.ts frontend/app/store/keybindings/bindings.ts`
Expected: no errors. Pre-existing `no-undef` complaints in `scripts/*.mjs` are known and not yours.

Run: `npx prettier --check frontend/app/view/code`
Expected: pass. If it fails, run `npx prettier --write` **only on files you created** — on files you merely edited, `--write` reorders imports and rewraps the whole file, turning a small change into a several-hundred-line diff.

- [ ] **Step 5: Run both CDP scenarios**

Run: `task verify:ui -- surface-smoke code-search`
Expected: PASS for every step of both, exit 0.

- [ ] **Step 6: Review the complete diff yourself**

Run: `git diff --cached --stat` then `git diff --cached`
Check for: leftover debug statements, commented-out code, raw hex colors, hand-edits to `wshclientapi.ts` or `gotypes.d.ts`, and any file you did not intend to stage.

- [ ] **Step 7: Confirm nothing from another session is staged**

Run: `git status --short`
Expected: only the paths Tasks 1 to 18 named appear as staged. Unstaged changes belonging to a parallel session must stay unstaged.

- [ ] **Step 8: Stage the spec and this plan**

The repository's rule is that spec and plan documents fold into the feature commit they describe, never a separate docs-only commit.

```bash
git add docs/superpowers/specs/2026-08-06-code-surface-navigation-and-handoff-design.md docs/superpowers/plans/2026-08-06-code-surface-navigation-and-handoff.md
```

- [ ] **Step 9: Ask the user for explicit approval to commit**

Do not commit without it. Report what passed and what, if anything, was skipped or is failing. When approved, commit with a message in this repository's style — a subject that names the problem the change removes, not the feature added:

```bash
git commit -F- <<'MSG'
feat(code): the file tree's cursor was the open file, so no key could reach a directory and the surface could not be searched or reached from anywhere else

The tree now carries its own cursor with Enter as the action, git grep backs a
content search in the left column, and one openInCode primitive serves the
finder, a diff row, a Radar finding, and a one-line handoff to a live agent.
MSG
```

---

## Self-Review

**Spec coverage.** Every section of `docs/superpowers/specs/2026-08-06-code-surface-navigation-and-handoff-design.md` maps to a task:

| Spec section | Task |
|---|---|
| §1 backend reader | 1 |
| §1 command, codegen, the two timeouts | 2, 12 |
| §2 `codetreekeys.ts` | 4 |
| §2 `codetreepane.tsx` | 6 |
| §2 `codestore.ts` atoms + derived rows | 5 |
| §3 jump primitive + line reveal | 8 |
| §4 path bar | 10 |
| §4 finder query grammar | 9 |
| §5 pure grouping / store / pane | 11, 12, 13 |
| §6 handoff composition | 15 |
| §6 handoff control | 16 |
| §6 `firstChangedLine` + diff jump | 17 |
| §6 Radar jump | 18 |
| §7 wiring: bindings, paths, scenario | 3, 7, 13, 14 |
| §8 failure modes | 13 (search states), 16 (clipboard fallback), 8 (existing missing-file state) |
| §9 testing | 1, 3, 4, 9, 11, 15, 17 unit tests; 14 CDP; 19 full run |
| §10 phasing | the four phases above |

Decisions 3, 4 (focus keys, arrow collapse/expand) land in Task 7. Decision 7 (unregistered repositories open anyway) is `resolveJumpProject` in Task 8. Decision 13 (handoffs are not recorded) is a comment in Task 16, since it is the absence of code. Decision 15 (save controls stay put) is honored by Task 10 not touching `SurfaceHeader`.

**Two deviations from the spec as written, both deliberate and both now reflected back into the spec.** The tree-focus gate reads an atom instead of `document.activeElement`, because `store.test.ts` evaluates every `when` in vitest's Node environment where `document` is undefined. And the tree rows became `role="treeitem"` divs instead of buttons, because a focused row button would make `Enter` fire both the keybinding and the button's own click.

**Type consistency check.** `openInCode(model, {projectPath, rel, line?})` is called identically in Tasks 9, 13, 17 and 18. `codeEditorSelection()` is produced in Task 8 and consumed in Task 16 with the same `{startLine, endLine}` shape. `handoffLine`'s parameter names match between Tasks 15 and 16. `TreeAction`'s four variants are produced in Task 4 and all four are handled in Task 7's switch. `SearchState`'s four variants are produced in Task 12 and all four are handled in Task 13's `SearchBody`. `GrepMatch` (Go, Task 1) converts explicitly to `wshrpc.GitGrepMatch` (Task 2), which generates the ambient `GitGrepMatch` used in Tasks 11 and 12.

**One thing a reviewer should watch.** Task 13's `SearchBody` types its `state` prop through `ReturnType<typeof useAtomValue<typeof codeSearchAtom>>`, which is indirect. If the typechecker objects, replace it with the direct import `import type { SearchState } from "./codesearchstore";` and type the prop `state: SearchState` — that is the intent either way.
