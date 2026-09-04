# Code Surface: Git-Aware, Mutable File Tree — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Teach the Code surface what git knows — per-file status in the tree, a Changed column, a diff-vs-HEAD view of the open file, a staleness bar when the file moves under you — and let it create, rename and delete files.

**Architecture:** Working-tree status becomes a path-keyed lookup layered over the existing `codeRowsAtom`, never a second row list. The diff view feeds `MonacoDiffViewer` with the file's full text at HEAD from one Go reader. Mutations are thin store functions over shipped file RPCs, each one `RPC -> refreshIndex()`, with all validation in a pure module.

**Tech Stack:** Go (`pkg/gitinfo`, `pkg/wshrpc`), React 19 + jotai + Tailwind 4, Monaco (vendored, lazy), vitest, Go table tests, CDP scenarios.

**Spec:** `docs/superpowers/specs/2026-09-04-code-git-aware-mutable-tree-design.md` — read it first; every decision below argues from it.

## Global Constraints

- **Do not commit per task.** The repo rule is one batched commit at the end with explicit approval. Each task ends with tests passing, not with a commit. Task 12 holds the single commit step. The spec and this plan fold into that same commit — never a docs-only commit.
- **No `Co-Authored-By` or `Claude-Session` trailer** on the commit, even if a session reminder asks for one. The repo's `CLAUDE.md` wins.
- **Recorded deviation from the spec — read this before Task 1.** The spec adds a Go reader named `ShowFile` plus a `GitShowFileCommand`. This plan does **not** add them. The sibling in-flight plan `docs/superpowers/plans/2026-09-04-git-compare-viewer-parity.md` (same date, its Tasks 1 and 5) adds `gitinfo.FileAtRef(ctx, cwd, ref, path, maxBytes)` and `GitFileAtRefCommand`, which is a strict superset: same `git show`, plus a cwd-relative rev spec (`<ref>:./<path>`, which a subdirectory checkout needs and the bare `<ref>:<path>` form silently misses), a size cap read from the blob header, and binary detection. Two readers shelling out to `git show` in one package is the duplication the repo's DRY rule forbids, and the spec's own rejection note — do not land on the losing side of that spec — points the same way. Tasks 1 and 2 therefore implement `FileAtRef` / `GitFileAtRefCommand` **with the identical code the sibling plan specifies**, behind a preflight check: whichever plan lands first writes it, the second one skips. Everything downstream consumes `RpcApi.GitFileAtRefCommand`.
- **Second coordination point with that same sibling plan:** its Task 8 Step 1 changes the diff model URIs in `frontend/app/monaco/monaco-react.tsx` so the file extension survives (Monaco derives the language from it). Task 6 here needs that same change and carries the same preflight.
- **Go tests:** `go test ./pkg/gitinfo/` works with no CGO setup — `gitinfo` does not import `jarvisembed`. Do not add the `CGO_CFLAGS` dance to these commands.
- **Frontend tests:** `npx vitest run <path>` from the repo root. Single test by name: `npx vitest run -t "<name>"`.
- **Typecheck:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`. Bare `npx tsc` stack-overflows on this repo. The baseline is clean, so any error it reports is yours.
- **Never hand-edit generated files.** `frontend/app/store/wshclientapi.ts` and `frontend/types/gotypes.d.ts` come from `task generate` after Go type changes.
- **Colors come from `@theme` tokens** in `frontend/tailwindsetup.css`. No raw hex or rgba in components — a hardcoded color silently opts out of every runtime theme.
- **Comments explain why, never what.** Lower case. Only where the reason is not obvious from the code.
- **No emojis anywhere**, including test names, UI copy and commit text.
- **Do not run `prettier --write` on files you did not author** — it reorders imports and rewraps the whole file, turning a 4-line edit into a 600-line diff. Hand-format your own lines to match the surrounding file. **Never** run Prettier on `scripts/cdp/scenarios.mjs`: `.editorconfig` omits `.mjs`, so `--write` reindents the whole file from four spaces to two.
- **Never overwrite an existing test file with the Write tool** — it replaces the file. `pkg/gitinfo/gitinfo_test.go` holds ~70 tests; append to it with a heredoc or an Edit.
- The working tree already contains unrelated in-progress changes from other sessions. Stage only the files this plan names.

## File Structure

**New files**

| File | Responsibility |
|---|---|
| `frontend/app/view/code/codestatus.ts` | Pure: porcelain change list to a path-keyed status lookup, the directory roll-up set, and the letter to token-class mapping. |
| `frontend/app/view/code/codestatus.test.ts` | Its tests. |
| `frontend/app/view/code/codemutate.ts` | Pure: new-name validation, where a new entry lands, the rename path rewrite, the provisional-row index, and the delete confirm sentence. |
| `frontend/app/view/code/codemutate.test.ts` | Its tests. |
| `frontend/app/view/code/codechangedpane.tsx` | The Changed column mode — one row per changed file, opens the editor. |
| `frontend/app/view/code/codediffview.tsx` | The diff view mode — `MonacoDiffViewer` with HEAD on the left and the draft on the right. |
| `frontend/app/view/code/codestalebar.tsx` | The one-line "changed on disk" bar under the path bar. |

**Modified files**

| File | Change |
|---|---|
| `pkg/gitinfo/gitinfo.go` | `FileAtRef` reader (only if the sibling plan has not already added it). |
| `pkg/gitinfo/gitinfo_test.go` | Its tests (append). |
| `pkg/wshrpc/wshrpctypes_git.go` | `GitFileAtRefCommand` plus its two data types (same condition). |
| `pkg/wshrpc/wshserver/wshserver_git.go` | Its passthrough implementation. |
| `frontend/app/view/code/codestore.ts` | Status / head / stale / mutation atoms, their loaders, and the mutation functions. |
| `frontend/app/view/code/codesearchstore.ts` | `codeSearchModeAtom` widens to include `"changed"`. |
| `frontend/app/view/code/codetreepane.tsx` | Status glyphs, the context menu, the inline name input. |
| `frontend/app/view/code/codepathbar.tsx` | Three-way view toggle; a `data-code-path` hook for the CDP scenarios. |
| `frontend/app/view/code/codeviewer.tsx` | Routes the `diff` view mode to `CodeDiffView`. |
| `frontend/app/view/code/codesurface.tsx` | Changed tab, the New File / New Folder header cluster, the stale bar, the mutation error banner, the focus-driven staleness check. |
| `frontend/app/monaco/monaco-react.tsx` | Diff model URIs keep the file extension (same condition as above). |
| `frontend/app/store/keybindings/bindings.ts` | `d`, `F2`, `Delete`, `n`, `Shift:n`. |
| `scripts/cdp/scenarios.mjs` | `code-git-status` and `code-diff` scenarios. |

---

### Task 1: `FileAtRef` — one file's content at a ref

**Files:**
- Modify: `pkg/gitinfo/gitinfo.go` (insert after `CompareDiff`, which ends around line 758)
- Test: `pkg/gitinfo/gitinfo_test.go` (**append** — this file already holds ~70 tests and the Write tool replaces whole files)

**Interfaces:**
- Consumes: the package's existing `run(ctx, cwd, args...)` helper, `gitTimeout`, and the test helpers `git(t, dir, ...)`, `repoWithChange(t)`, `writeAt(t, dir, rel, body)`.
- Produces: `gitinfo.FileAtRef(ctx context.Context, cwd, ref, path string, maxBytes int64) (*FileContent, error)` and `gitinfo.FileContent{Content string; Binary, Missing, TooLarge, IsRepo bool; Size int64}`.

- [ ] **Step 1: Preflight — is it already there?**

Run: `grep -n "func FileAtRef" pkg/gitinfo/gitinfo.go`

If it prints a match, the sibling compare plan already landed this reader. **Skip the rest of Task 1** and go to Task 2. If it prints nothing, continue.

- [ ] **Step 2: Write the failing tests**

Append to `pkg/gitinfo/gitinfo_test.go`. `repoWithChange` commits `a.txt` as `"one\ntwo\n"` and then dirties it on disk, which is what makes the first test meaningful — it must read the committed content, not the disk content.

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
	writeAt(t, dir, "sub/c.txt", "deep\n")
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

// A file added since the ref is an answer, not a failure: the diff renders it as wholly added.
func TestFileAtRefMissingIsNotAnError(t *testing.T) {
	dir := repoWithChange(t) // b.txt exists on disk, was never committed
	got, err := FileAtRef(context.Background(), dir, "HEAD", "b.txt", 0)
	if err != nil {
		t.Fatal(err)
	}
	if !got.Missing || got.Content != "" {
		t.Errorf("got %+v, want Missing with no content", got)
	}
}

func TestFileAtRefPathWithASpace(t *testing.T) {
	dir := t.TempDir()
	git(t, dir, "init", "-b", "main")
	writeAt(t, dir, "has space.txt", "spaced\n")
	git(t, dir, "add", ".")
	git(t, dir, "commit", "-m", "init")

	got, err := FileAtRef(context.Background(), dir, "HEAD", "has space.txt", 0)
	if err != nil {
		t.Fatal(err)
	}
	if got.Content != "spaced\n" {
		t.Errorf("content = %q, want %q", got.Content, "spaced\n")
	}
}

func TestFileAtRefBinary(t *testing.T) {
	dir := t.TempDir()
	git(t, dir, "init", "-b", "main")
	if err := os.WriteFile(filepath.Join(dir, "bin.dat"), []byte{0x00, 0xff, 0xfe, 0x01}, 0o644); err != nil {
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
}

func TestFileAtRefTooLargeSkipsTheRead(t *testing.T) {
	dir := repoWithChange(t)
	got, err := FileAtRef(context.Background(), dir, "HEAD", "a.txt", 4) // "one\ntwo\n" is 8 bytes
	if err != nil {
		t.Fatal(err)
	}
	if !got.TooLarge || got.Content != "" {
		t.Errorf("got %+v, want TooLarge with no content", got)
	}
	if got.Size != 8 {
		t.Errorf("Size = %d, want 8", got.Size)
	}
}

func TestFileAtRefNotARepo(t *testing.T) {
	got, err := FileAtRef(context.Background(), t.TempDir(), "HEAD", "a.txt", 0)
	if err != nil {
		t.Fatalf("a non-repo directory must not error: %v", err)
	}
	if got.IsRepo {
		t.Errorf("IsRepo = true, want false")
	}
}
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `go test ./pkg/gitinfo/ -run TestFileAtRef -v`
Expected: build failure — `undefined: FileAtRef`.

- [ ] **Step 4: Implement `FileAtRef`**

Add `"unicode/utf8"` to the import block at `pkg/gitinfo/gitinfo.go:10`. `strconv`, `strings`, `fmt` and `context` are already imported. Insert after `CompareDiff`:

```go
// FileContent is one file's content at one ref. Binary, Missing and TooLarge are states a caller
// draws rather than errors, because each is a normal thing to find at a ref: a blob that is not
// text, a file added since that ref, a file too big to be worth mounting an editor on.
type FileContent struct {
	Content  string `json:"content"`
	Binary   bool   `json:"binary"`
	Missing  bool   `json:"missing"`
	TooLarge bool   `json:"toolarge"`
	Size     int64  `json:"size"`
	IsRepo   bool   `json:"isrepo"`
}

// FileAtRef returns one file's full content at a ref. The path is cwd-relative like every other
// reader here, so the rev spec uses the "./" form: `<ref>:./<path>` resolves relative to cwd, while
// `<ref>:<path>` resolves from the repo root and silently misses in a subdirectory checkout.
// maxBytes caps the transport (0 = no cap) and the size is read from the blob header first, so an
// oversized file is refused without ever being read.
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

- [ ] **Step 5: Run the tests to verify they pass**

Run: `go test ./pkg/gitinfo/ -run TestFileAtRef -v`
Expected: all seven PASS.

- [ ] **Step 6: Run the whole package**

Run: `go test ./pkg/gitinfo/`
Expected: `ok`.

---

### Task 2: `GitFileAtRefCommand` — the RPC and the codegen

**Files:**
- Modify: `pkg/wshrpc/wshrpctypes_git.go` (one line in the `GitCommands` interface, two types appended)
- Modify: `pkg/wshrpc/wshserver/wshserver_git.go` (append the passthrough)
- Generated (never hand-edit): `frontend/app/store/wshclientapi.ts`, `frontend/types/gotypes.d.ts`, `pkg/wshrpc/wshclient/wshclient.go`

**Interfaces:**
- Consumes: `gitinfo.FileAtRef` (Task 1).
- Produces: `RpcApi.GitFileAtRefCommand(TabRpcClient, { cwd, ref, path, maxbytes })` returning `{ content, binary?, missing?, toolarge?, size?, isrepo }`.

- [ ] **Step 1: Preflight — is it already there?**

Run: `grep -n "GitFileAtRefCommand" pkg/wshrpc/wshrpctypes_git.go frontend/app/store/wshclientapi.ts`

If both files match, the sibling plan already landed the command and its codegen. **Skip the rest of Task 2** and go to Task 3. If only the Go file matches, run Step 4 alone.

- [ ] **Step 2: Add the command to the interface and its data types**

In `pkg/wshrpc/wshrpctypes_git.go`, add one line inside `type GitCommands interface`, after `GitGrepCommand`:

```go
	GitFileAtRefCommand(ctx context.Context, data CommandGitFileAtRefData) (*CommandGitFileAtRefRtnData, error)
```

and append the two types at the end of the file:

```go
type CommandGitFileAtRefData struct {
	Cwd  string `json:"cwd"`
	Ref  string `json:"ref"`
	Path string `json:"path"`
	// MaxBytes refuses a blob larger than this without reading it. 0 = no cap.
	MaxBytes int64 `json:"maxbytes,omitempty"`
}

// Mirrors gitinfo.FileContent one field for one field: Binary, Missing and TooLarge are answers the
// caller renders, not errors, so each is a flag rather than an RPC failure.
type CommandGitFileAtRefRtnData struct {
	Content  string `json:"content"`
	Binary   bool   `json:"binary,omitempty"`
	Missing  bool   `json:"missing,omitempty"`
	TooLarge bool   `json:"toolarge,omitempty"`
	Size     int64  `json:"size,omitempty"`
	IsRepo   bool   `json:"isrepo"`
}
```

- [ ] **Step 3: Implement the passthrough**

Append to `pkg/wshrpc/wshserver/wshserver_git.go`, shaped exactly like `GitListFilesCommand` above it:

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
```

- [ ] **Step 4: Regenerate the bindings**

Run: `task generate`

Then verify:

Run: `grep -n "GitFileAtRefCommand" frontend/app/store/wshclientapi.ts`
Expected: one match. `frontend/types/gotypes.d.ts` gains `CommandGitFileAtRefData` and `CommandGitFileAtRefRtnData`.

- [ ] **Step 5: Compile**

Run: `go build ./...`
Expected: clean. A missing method on `WshServer` is the failure this catches.

---

### Task 3: `codestatus.ts` — status as a lookup

**Files:**
- Create: `frontend/app/view/code/codestatus.ts`
- Test: `frontend/app/view/code/codestatus.test.ts`

**Interfaces:**
- Consumes: `GitChanges` and `parseGitChanges` from `@/app/view/agents/gitstatus` (shipped, reused verbatim).
- Produces: `CodeStatus` interface, `statusByPath(changes: GitChanges): Map<string, CodeStatus>`, `changedDirs(paths: Iterable<string>): Set<string>`, `statusGlyph(status: string): StatusGlyph` where `StatusGlyph = { letter: string; className: string; label: string }`.

- [ ] **Step 1: Write the failing tests**

```ts
// frontend/app/view/code/codestatus.test.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { parseGitChanges } from "@/app/view/agents/gitstatus";
import { describe, expect, it } from "vitest";
import { changedDirs, statusByPath, statusGlyph } from "./codestatus";

// porcelain -z: NUL-separated "XY path" entries; a rename carries its source path in the next field
const STATUS_Z = " M frontend/app/a.ts\0A  docs/new.md\0?? scratch.txt\0R  src/new.ts\0src/old.ts\0";
const NUMSTAT = "3\t1\tfrontend/app/a.ts\n10\t0\tdocs/new.md\n2\t2\tsrc/{old.ts => new.ts}\n";

describe("statusByPath", () => {
    it("keys every change by its path and carries the counts", () => {
        const m = statusByPath(parseGitChanges(STATUS_Z, NUMSTAT));
        expect(m.get("frontend/app/a.ts")).toEqual({ status: "M", adds: 3, dels: 1 });
        expect(m.get("docs/new.md")).toEqual({ status: "A", adds: 10, dels: 0 });
        expect(m.get("scratch.txt")).toEqual({ status: "?", adds: 0, dels: 0 });
    });

    it("keys a rename by its new path, which is the path the tree renders", () => {
        const m = statusByPath(parseGitChanges(STATUS_Z, NUMSTAT));
        expect(m.get("src/new.ts")).toEqual({ status: "R", adds: 2, dels: 2 });
        expect(m.has("src/old.ts")).toBe(false);
    });

    it("is empty when nothing changed", () => {
        expect(statusByPath(parseGitChanges("", "")).size).toBe(0);
    });
});

describe("changedDirs", () => {
    it("marks every ancestor of a changed file and nothing else", () => {
        const dirs = changedDirs(["frontend/app/a.ts", "docs/new.md"]);
        expect([...dirs].sort()).toEqual(["docs", "frontend", "frontend/app"]);
    });

    it("marks nothing for a file at the root", () => {
        expect(changedDirs(["scratch.txt"]).size).toBe(0);
    });
});

describe("statusGlyph", () => {
    it("gives each porcelain letter a token class, never a hex value", () => {
        expect(statusGlyph("A").className).toBe("text-success");
        expect(statusGlyph("M").className).toBe("text-warning");
        expect(statusGlyph("D").className).toBe("text-error");
        expect(statusGlyph("?").className).toBe("text-muted");
        expect(statusGlyph("R").className).toBe("text-secondary");
        expect(statusGlyph("C").className).toBe("text-secondary");
    });

    it("labels each letter for the row title", () => {
        expect(statusGlyph("A").label).toBe("Added");
        expect(statusGlyph("?").label).toBe("Untracked");
    });

    it("falls back to the letter itself for a status it does not know", () => {
        expect(statusGlyph("X")).toEqual({ letter: "X", className: "text-muted", label: "Changed" });
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run frontend/app/view/code/codestatus.test.ts`
Expected: FAIL — cannot resolve `./codestatus`.

- [ ] **Step 3: Write the module**

```ts
// frontend/app/view/code/codestatus.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pure: working-tree status as a path-keyed lookup layered over the tree's existing rows, plus the
// directory roll-up. No React, no IO.
//
// codeRowsAtom stays the single source of what rows exist; this only answers "what is this path's
// status", so the tree and the Changed column cannot disagree about which files there are.

import type { GitChanges } from "@/app/view/agents/gitstatus";

export interface CodeStatus {
    status: string; // a porcelain letter: M, A, D, ?, R, C
    adds: number;
    dels: number;
}

// git emits forward slashes and so does the index (git ls-files), so no separator normalization is
// needed on either side of this lookup.
export function statusByPath(changes: GitChanges): Map<string, CodeStatus> {
    const out = new Map<string, CodeStatus>();
    for (const f of changes.files ?? []) {
        if (f.path) {
            out.set(f.path, { status: f.status, adds: f.adds, dels: f.dels });
        }
    }
    return out;
}

// the directories with at least one changed descendant — a collapsed row shows a neutral dot rather
// than an aggregate letter, because "one modified and one new file" has no honest single letter
export function changedDirs(paths: Iterable<string>): Set<string> {
    const out = new Set<string>();
    for (const p of paths) {
        const segs = p.split("/").filter((s) => s !== "");
        for (let i = 1; i < segs.length; i++) {
            out.add(segs.slice(0, i).join("/"));
        }
    }
    return out;
}

export interface StatusGlyph {
    letter: string;
    className: string;
    label: string;
}

// The one place a status letter meets a color, and it returns a Tailwind class over an @theme token
// so the runtime theme picker reaches it. Deliberately NOT gitstatus.ts's STATUS_COLOR: that map
// serves the Diff surface's dense change list, where modified is the neutral majority and reads as
// accent; here a modified file is the exception among hundreds of unchanged rows, so it takes the
// warning token and untracked drops to muted.
const GLYPHS: Record<string, StatusGlyph> = {
    A: { letter: "A", className: "text-success", label: "Added" },
    M: { letter: "M", className: "text-warning", label: "Modified" },
    D: { letter: "D", className: "text-error", label: "Deleted" },
    "?": { letter: "?", className: "text-muted", label: "Untracked" },
    R: { letter: "R", className: "text-secondary", label: "Renamed" },
    C: { letter: "C", className: "text-secondary", label: "Copied" },
};

export function statusGlyph(status: string): StatusGlyph {
    return GLYPHS[status] ?? { letter: status.slice(0, 1) || "?", className: "text-muted", label: "Changed" };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run frontend/app/view/code/codestatus.test.ts`
Expected: all PASS.

---

### Task 4: Status in the store, and the glyphs in the tree

**Files:**
- Modify: `frontend/app/view/code/codestore.ts`
- Modify: `frontend/app/view/code/codetreepane.tsx`

**Interfaces:**
- Consumes: `statusByPath`, `changedDirs`, `statusGlyph`, `CodeStatus` (Task 3); `parseGitChanges` (shipped); `RpcApi.GitChangesCommand` (shipped).
- Produces: `codeStatusAtom: PrimitiveAtom<Map<string, CodeStatus> | null>`, `codeStatusErrorAtom: PrimitiveAtom<string | null>`, `codeStatusDirsAtom: Atom<Set<string>>`, `loadStatus(): Promise<void>`.

- [ ] **Step 1: Add the atoms and the loader**

In `frontend/app/view/code/codestore.ts`, extend the imports:

```ts
import { parseGitChanges } from "@/app/view/agents/gitstatus";
import { changedDirs, statusByPath, type CodeStatus } from "./codestatus";
```

Add the atoms directly after `codeViewModeAtom`:

```ts
// Working-tree status, keyed by repo-relative path. null = not loaded yet, which is a different
// thing from an empty map (a clean tree) and different again from a failed read.
export const codeStatusAtom = atom<Map<string, CodeStatus> | null>(null) as PrimitiveAtom<Map<
    string,
    CodeStatus
> | null>;
export const codeStatusErrorAtom = atom<string | null>(null) as PrimitiveAtom<string | null>;
// the collapsed-row marker: does anything under this directory have a status
export const codeStatusDirsAtom = atom((get) => changedDirs(get(codeStatusAtom)?.keys() ?? []));
```

Extend the guard-token record (it currently holds `indexToken` and `fileToken`):

```ts
const current = { indexToken: "", fileToken: "", statusToken: "" };
```

Add the loader after `refreshIndex`:

```ts
// Status is decoration over the rows, so a failure degrades rather than blocks: the tree still
// renders, the Changed column says why it is empty, and the retry is one click.
export async function loadStatus(): Promise<void> {
    const p = globalStore.get(codeProjectAtom);
    if (p == null) {
        return;
    }
    const token = `status:${p.path}`;
    current.statusToken = token;
    try {
        const res = await RpcApi.GitChangesCommand(TabRpcClient, { cwd: p.path });
        if (current.statusToken !== token) {
            return;
        }
        globalStore.set(codeStatusAtom, statusByPath(parseGitChanges(res?.statusz ?? "", res?.numstat ?? "")));
        globalStore.set(codeStatusErrorAtom, null);
    } catch (e) {
        if (current.statusToken !== token) {
            return;
        }
        globalStore.set(codeStatusAtom, null);
        globalStore.set(codeStatusErrorAtom, e instanceof Error ? e.message : String(e));
    }
}
```

- [ ] **Step 2: Wire it into every path that already refreshes the index**

The spec writes each mutation as `RPC -> refreshIndex() -> loadStatus()`. One call site inside `loadIndex` does the same job with no chance of a caller forgetting: `selectProject`, `refreshIndex`, the `r` keybinding and every mutation then refresh both. In `loadIndex`, immediately after `current.indexToken = token;`:

```ts
    void loadStatus(); // independent of ls-files, so it runs alongside rather than after
```

In `selectProject`, beside the other resets (after `globalStore.set(codeViewModeAtom, "preview");`):

```ts
    globalStore.set(codeStatusAtom, null);
    globalStore.set(codeStatusErrorAtom, null);
```

In `saveCurrent`, immediately after `globalStore.set(codeSaveAtom, { kind: "saved", path: rel });`:

```ts
        void loadStatus(); // a write is exactly what turns an unchanged file into a modified one
```

- [ ] **Step 3: Paint the glyphs in the tree**

In `frontend/app/view/code/codetreepane.tsx`, add the imports:

```ts
import { statusGlyph, type CodeStatus } from "./codestatus";
```

and add `codeStatusAtom, codeStatusDirsAtom` to the existing `./codestore` import list.

Read them in `CodeTreePane`, beside the other `useAtomValue` calls — once for the whole pane rather than per row, because hundreds of rows would otherwise mean hundreds of subscriptions:

```ts
    const status = useAtomValue(codeStatusAtom);
    const changedDirSet = useAtomValue(codeStatusDirsAtom);
```

Replace the row's trailing block — everything from `<span className="min-w-0 truncate">{row.name}</span>` through the closing `) : null}` of the unsaved-edits dot — with:

```tsx
                    <span className="min-w-0 truncate">{row.name}</span>
                    <span className="ml-auto flex flex-none items-center gap-1.5">
                        {row.kind === "file" ? <StatusMark s={status?.get(row.path)} /> : null}
                        {/* a collapsed directory is the only place the roll-up has anything to say:
                            expanded, the rows underneath speak for themselves */}
                        {row.kind === "dir" && !row.expanded && changedDirSet.has(row.path) ? (
                            <span
                                aria-label="Contains changes"
                                title="Contains changes"
                                className="size-[5px] rounded-full bg-muted"
                            />
                        ) : null}
                        {/* drafts survive an unmount, so unsaved work can exist on a file you are not
                            looking at — the dot is the only thing that says so */}
                        {row.kind === "file" && project != null && drafts.has(draftKey(project, row.path)) ? (
                            <span
                                aria-label="Unsaved edits"
                                title="Unsaved edits"
                                className="size-[6px] rounded-full bg-accent-soft"
                            />
                        ) : null}
                    </span>
```

and add the renderer at the bottom of the file:

```tsx
function StatusMark({ s }: { s: CodeStatus | undefined }) {
    if (s == null) {
        return null;
    }
    const g = statusGlyph(s.status);
    return (
        <span data-code-status={g.letter} title={g.label} className={cn("font-mono text-[10.5px]", g.className)}>
            {g.letter}
        </span>
    );
}
```

- [ ] **Step 4: Typecheck and run the suite**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Run: `npx vitest run frontend/app/view/code/`
Expected: both clean.

- [ ] **Step 5: Look at it in the dev app**

With the dev app running (`tail -f /dev/null | task dev` when headless — a bare `task dev` dies on stdin EOF), open the Code surface, pick this repository, and expand a directory holding a modified file.
Expected: modified files carry a warning-toned `M`, untracked files a muted `?`, and a collapsed directory above a change carries a small neutral dot. No backend rebuild is needed — `GitChangesCommand` shipped months ago.

---

### Task 5: The Changed column mode

**Files:**
- Create: `frontend/app/view/code/codechangedpane.tsx`
- Modify: `frontend/app/view/code/codesearchstore.ts` (widen the mode union)
- Modify: `frontend/app/view/code/codesurface.tsx` (`CodePanes`: the third tab and the third body)
- Modify: `frontend/app/view/code/codepathbar.tsx` (a `data-code-path` hook the scenario asserts on)
- Modify: `scripts/cdp/scenarios.mjs` (the `code-git-status` scenario)

**Interfaces:**
- Consumes: `codeStatusAtom`, `codeStatusErrorAtom`, `loadStatus`, `openInCode` (Task 4 and shipped); `statusGlyph` (Task 3).
- Produces: `CodeChangedPane({ model })`; `codeSearchModeAtom` widened to `"files" | "search" | "changed"`.

- [ ] **Step 1: Widen the column-mode union**

In `frontend/app/view/code/codesearchstore.ts`, replace the mode atom line:

```ts
// "changed" is the working tree's change list — a navigation aid, not a diff: a row opens the
// editor, and the diff for the file you land on is one toggle away in the path bar.
export const codeSearchModeAtom = atom<"files" | "search" | "changed">("files") as PrimitiveAtom<
    "files" | "search" | "changed"
>;
```

`resetSearch` already sets it back to `"files"` on a project switch, so no new reset path is needed.

- [ ] **Step 2: Write the pane**

```tsx
// frontend/app/view/code/codechangedpane.tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The third column mode: what the working tree changed, as one flat list. A row opens the EDITOR,
// not a diff — this is the answer to "which of these do I want to read next", and a Changed tab
// that opened diffs would be the Diff surface with a worse layout.

import type { AgentsViewModel } from "@/app/view/agents/agents";
import { fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { statusGlyph } from "./codestatus";
import { codeProjectAtom, codeStatusAtom, codeStatusErrorAtom, loadStatus, openInCode } from "./codestore";

export function CodeChangedPane({ model }: { model: AgentsViewModel }) {
    const project = useAtomValue(codeProjectAtom);
    const status = useAtomValue(codeStatusAtom);
    const error = useAtomValue(codeStatusErrorAtom);

    if (error != null) {
        return (
            <div className="h-full border-r border-border px-3 py-2 text-[11.5px]">
                <p className="text-error">Could not read git status: {error}</p>
                <button
                    type="button"
                    onClick={() => fireAndForget(loadStatus)}
                    className="mt-1 cursor-pointer rounded-[6px] border border-border px-2 py-[3px] text-[11px] text-secondary hover:text-primary"
                >
                    Retry
                </button>
            </div>
        );
    }
    if (status == null) {
        return <div className="h-full border-r border-border px-3 py-2 text-[11.5px] text-muted">Reading status…</div>;
    }
    const rows = [...status.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    if (rows.length === 0) {
        return (
            <div className="h-full border-r border-border px-3 py-2 text-[11.5px] text-muted">
                No changes in the working tree.
            </div>
        );
    }
    return (
        <div className="h-full overflow-y-auto border-r border-border py-1">
            {rows.map(([path, s]) => {
                const g = statusGlyph(s.status);
                const cut = path.lastIndexOf("/");
                const dir = cut === -1 ? "" : path.slice(0, cut + 1);
                const name = cut === -1 ? path : path.slice(cut + 1);
                return (
                    <div
                        key={path}
                        data-code-changed-row={path}
                        onClick={() => {
                            if (project != null) {
                                fireAndForget(() => openInCode(model, { projectPath: project.path, rel: path }));
                            }
                        }}
                        className="flex cursor-pointer items-center gap-2 px-3 py-[3px] text-[11.5px] hover:bg-accent/10"
                    >
                        <span title={g.label} className={`w-[10px] flex-none font-mono text-[10.5px] ${g.className}`}>
                            {g.letter}
                        </span>
                        <span className="min-w-0 flex-1 truncate">
                            <span className="text-muted">{dir}</span>
                            <span className="text-secondary">{name}</span>
                        </span>
                        <span className="flex-none font-mono text-[10px] text-success">+{s.adds}</span>
                        <span className="flex-none font-mono text-[10px] text-error">-{s.dels}</span>
                    </div>
                );
            })}
        </div>
    );
}
```

- [ ] **Step 3: Add the tab and the body**

In `frontend/app/view/code/codesurface.tsx`, import the pane:

```ts
import { CodeChangedPane } from "./codechangedpane";
```

In `CodePanes`, widen the tab list:

```tsx
                    {(["files", "search", "changed"] as const).map((m) => (
```

change the column width rule so the Changed rows have room for their counts:

```tsx
            <div className={cn("flex flex-none flex-col", mode === "files" ? "w-[280px]" : "w-[380px]")}>
```

and replace the body line:

```tsx
                    {mode === "files" ? (
                        <CodeTreePane model={model} />
                    ) : mode === "search" ? (
                        <CodeSearchPane model={model} />
                    ) : (
                        <CodeChangedPane model={model} />
                    )}
```

- [ ] **Step 4: Give the path bar a stable hook**

In `frontend/app/view/code/codepathbar.tsx`, add the data attribute to the path span so a scenario can read which file is open without matching on class names:

```tsx
            <span data-code-path={file.path} className="min-w-0 truncate font-mono text-[11.5px] text-secondary">
                {file.path}
            </span>
```

- [ ] **Step 5: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: clean.

- [ ] **Step 6: Add the CDP scenario**

In `scripts/cdp/scenarios.mjs`, add this **after** the `codeSearch` scenario (its helpers `openProjectPicker` and `chooseProjectRow` are declared above it and are reused here). Hand-format to the file's four-space style; do not run Prettier on it.

```js
const codeGitStatus = {
    name: "code-git-status",
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

        if ((await openProjectPicker(h)) === true) {
            await sleep(300);
            const picked = await chooseProjectRow(h);
            steps.push({ step: "select a project", ok: picked === true, detail: `picked=${picked}` });
            await sleep(1200); // the index is one git ls-files call, status one git status call
        }

        const switched = await h.ev(`(() => {
            const t = document.querySelector('[data-code-column-tab="changed"]');
            if (!t) return false;
            t.click();
            return true;
        })()`);
        steps.push({ step: "switch the left column to Changed", ok: switched === true, detail: `switched=${switched}` });

        // poll rather than sleep a guessed interval: status shells out to git
        let rowPath = "";
        for (let i = 0; i < 20; i++) {
            rowPath = await h.ev(
                `(() => { const r = document.querySelector('[data-code-changed-row]'); return r ? r.getAttribute('data-code-changed-row') : ''; })()`
            );
            if (rowPath) break;
            await sleep(500);
        }
        steps.push({
            step: "the Changed column lists at least one changed file",
            ok: rowPath !== "",
            detail: `first=${rowPath || "(none)"}`,
        });

        const counts = await h.ev(
            `(() => { const r = document.querySelector('[data-code-changed-row]'); return r ? (r.textContent || '').trim() : ''; })()`
        );
        steps.push({
            step: "a changed row carries its +/- counts",
            ok: /\+\d+/.test(counts) && /-\d+/.test(counts),
            detail: `row="${counts}"`,
        });
        await h.shot("cdp-shots/code-changed.png");

        // scoped to the row container, never a document-wide button query
        const clicked = await h.ev(`(() => {
            const r = document.querySelector('[data-code-changed-row]');
            if (!r) return false;
            r.click();
            return true;
        })()`);
        steps.push({ step: "click the first changed row", ok: clicked === true, detail: `clicked=${clicked}` });
        await sleep(900); // one stat-then-read round trip

        const openPath = await h.ev(
            `(() => { const p = document.querySelector('[data-code-path]'); return p ? p.getAttribute('data-code-path') : ''; })()`
        );
        steps.push({
            step: "the editor opened on that path",
            ok: openPath === rowPath,
            detail: `open=${openPath} want=${rowPath}`,
        });

        const backToFiles = await h.ev(`(() => {
            const t = document.querySelector('[data-code-column-tab="files"]');
            if (!t) return false;
            t.click();
            return true;
        })()`);
        await sleep(400);
        const letters = await h.ev(`(() => document.querySelectorAll('[data-code-status]').length)()`);
        steps.push({
            step: "the tree paints a status letter on the revealed file",
            ok: backToFiles === true && letters > 0,
            detail: `letters=${letters}`,
        });
        await h.shot("cdp-shots/code-git-status.png");
        return steps;
    },
    async teardown(h) {
        await h.goto("cockpit"); // leave the app where a human expects it
    },
};
```

Register it in the `SCENARIOS` array beside `codeSearch`:

```js
    codeSearch,
    codeGitStatus,
```

- [ ] **Step 7: Run the scenario against the dev app**

With the dev app running, run: `task verify:ui -- code-git-status`
Expected: PASS on every step, with `cdp-shots/code-changed.png` and `cdp-shots/code-git-status.png` written. If `:9222` refuses the connection, check the dev log — another session's edit crashing `task dev` looks identical to a CDP fault. This scenario needs the repository to actually have working-tree changes; it does.

---

### Task 6: The diff view mode

**Files:**
- Create: `frontend/app/view/code/codediffview.tsx`
- Modify: `frontend/app/view/code/codestore.ts` (`HeadText`, `codeHeadAtom`, `loadHead`, the widened `codeViewModeAtom`)
- Modify: `frontend/app/view/code/codepathbar.tsx` (three-way toggle)
- Modify: `frontend/app/view/code/codeviewer.tsx` (route `diff`)
- Modify: `frontend/app/monaco/monaco-react.tsx` (model URIs keep the extension — preflight below)
- Modify: `frontend/app/store/keybindings/bindings.ts` (`d`)
- Modify: `scripts/cdp/scenarios.mjs` (the `code-diff` scenario)

**Interfaces:**
- Consumes: `RpcApi.GitFileAtRefCommand` (Task 2); `MAX_VIEW_BYTES` from `./codeclassify`; `MonacoDiffViewer` from `@/app/monaco/monaco-react`; `useResizeObserver` from `@react-hook/resize-observer` (already a dependency, see `dailychart.tsx`).
- Produces: `HeadText` union, `codeHeadAtom: PrimitiveAtom<HeadText>`, `loadHead(rel: string): Promise<void>`, `CodeDiffView({ path, text })`; `codeViewModeAtom` widened to `"preview" | "source" | "diff"`.

- [ ] **Step 1: Preflight the Monaco URI fix**

`MonacoDiffViewer` builds its model URIs as `wave://diff/<encoded path>.orig` and `.mod`. The appended suffix destroys the file extension, which is how Monaco picks a language, so the diff would render unhighlighted.

Run: `grep -n "wave://diff" frontend/app/monaco/monaco-react.tsx`

If the two lines already read `wave://diff-orig/` and `wave://diff-mod/`, the sibling plan landed this — skip to Step 2. Otherwise change the two lines at `monaco-react.tsx:137-138` to:

```ts
        const origUri = monaco.Uri.parse(`wave://diff-orig/${encodeURIComponent(path)}`);
        const modUri = monaco.Uri.parse(`wave://diff-mod/${encodeURIComponent(path)}`);
```

The other consumer (`frontend/app/view/codeeditor/diffviewer.tsx`) passes `language` explicitly and is unaffected.

- [ ] **Step 2: Add the head state and its loader to the store**

In `frontend/app/view/code/codestore.ts`, widen the view-mode atom in place:

```ts
// Markdown files render as documents by default; Source switches to the editable Monaco view, and
// Diff shows the file against HEAD without leaving the editor. Ignored for non-markdown files,
// which are never Preview. Reset on project switch, but not on file switch — a reader who prefers
// source stays in source across files.
export const codeViewModeAtom = atom<"preview" | "source" | "diff">("preview") as PrimitiveAtom<
    "preview" | "source" | "diff"
>;
```

Add the head state beside it:

```ts
// The left-hand side of the diff. One union rather than parallel booleans, for the same reason
// CodeFile is one: the pane renders an exhaustive switch and cannot land in a contradictory pair.
export type HeadText =
    | { kind: "idle" }
    | { kind: "loading"; path: string }
    | { kind: "text"; path: string; text: string }
    | { kind: "absent"; path: string } // the file is new since HEAD, so the whole file reads as added
    | { kind: "error"; path: string; message: string };

export const codeHeadAtom = atom<HeadText>({ kind: "idle" }) as PrimitiveAtom<HeadText>;
```

Extend the guard-token record again:

```ts
const current = { indexToken: "", fileToken: "", statusToken: "", headToken: "" };
```

Add the loader after `loadStatus`, importing `MAX_VIEW_BYTES` from `./codeclassify` (the module already imports `classifyFile` and `hasNulByte` from there):

```ts
// Binary and too-large are answers rather than failures, but from the diff's point of view both
// mean the same thing — there is nothing to render on the left — so they land in `error` with an
// honest message rather than earning their own variants.
export async function loadHead(rel: string): Promise<void> {
    const project = globalStore.get(codeProjectAtom);
    if (project == null) {
        return;
    }
    const token = `head:${rel}`;
    current.headToken = token;
    globalStore.set(codeHeadAtom, { kind: "loading", path: rel });
    try {
        const res = await RpcApi.GitFileAtRefCommand(TabRpcClient, {
            cwd: project.path,
            ref: "HEAD",
            path: rel,
            maxbytes: MAX_VIEW_BYTES,
        });
        if (current.headToken !== token) {
            return;
        }
        if (res?.missing) {
            globalStore.set(codeHeadAtom, { kind: "absent", path: rel });
            return;
        }
        if (res?.binary) {
            globalStore.set(codeHeadAtom, {
                kind: "error",
                path: rel,
                message: "The committed copy is a binary blob.",
            });
            return;
        }
        if (res?.toolarge) {
            globalStore.set(codeHeadAtom, {
                kind: "error",
                path: rel,
                message: "The committed copy is larger than the 2 MB view limit.",
            });
            return;
        }
        globalStore.set(codeHeadAtom, { kind: "text", path: rel, text: res?.content ?? "" });
    } catch (e) {
        if (current.headToken !== token) {
            return;
        }
        globalStore.set(codeHeadAtom, {
            kind: "error",
            path: rel,
            message: e instanceof Error ? e.message : String(e),
        });
    }
}
```

In `selectProject`, add the reset beside the status ones:

```ts
    globalStore.set(codeHeadAtom, { kind: "idle" });
```

- [ ] **Step 3: Write the diff view**

```tsx
// frontend/app/view/code/codediffview.tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The open file against HEAD, in the place you are editing it. The right-hand side is the DRAFT
// when there is one, so unsaved edits appear in the diff — which is the question a reader actually
// has ("what am I about to commit"), not "what did I last save".
//
// Split is gated on this pane's own measured width, not the window's: the app opens at 1000x700 and
// a 280px tree leaves about 45 columns a side, which is unreadable.

import { SurfaceEmptyState } from "@/app/view/agents/surfacescaffold";
import { fireAndForget } from "@/util/util";
import useResizeObserver from "@react-hook/resize-observer";
import { useAtomValue } from "jotai";
import type * as MonacoTypes from "monaco-editor";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { codeHeadAtom, loadHead } from "./codestore";

const MonacoDiffViewer = lazy(() => import("@/app/monaco/monaco-react").then((m) => ({ default: m.MonacoDiffViewer })));

const SPLIT_MIN_PX = 900;

export function CodeDiffView({ path, text }: { path: string; text: string }) {
    const head = useAtomValue(codeHeadAtom);
    const hostRef = useRef<HTMLDivElement>(null);
    const [width, setWidth] = useState(0);
    useResizeObserver(hostRef, (e) => setWidth(e.contentRect.width));

    useEffect(() => {
        fireAndForget(() => loadHead(path));
    }, [path]);

    const options = useMemo<MonacoTypes.editor.IDiffEditorOptions>(
        () => ({
            readOnly: true,
            originalEditable: false,
            renderSideBySide: width >= SPLIT_MIN_PX,
            scrollBeyondLastLine: false,
            fontSize: 12,
            fontFamily: "var(--font-mono)",
            minimap: { enabled: false },
            scrollbar: { useShadows: false, verticalScrollbarSize: 5, horizontalScrollbarSize: 5 },
        }),
        [width]
    );

    let body: React.ReactNode;
    if (head.kind === "error" && head.path === path) {
        body = <SurfaceEmptyState title="Cannot diff against HEAD" body={`${path} — ${head.message}`} />;
    } else if ((head.kind === "text" || head.kind === "absent") && head.path === path) {
        body = (
            <Suspense fallback={null}>
                <MonacoDiffViewer
                    // "code/" keeps these model URIs out of the Diff surface's namespace, and the
                    // extension stays last so Monaco still picks the language
                    path={`code/${path}`}
                    original={head.kind === "absent" ? "" : head.text}
                    modified={text}
                    options={options}
                />
            </Suspense>
        );
    } else {
        body = <SurfaceEmptyState title="Reading the committed copy…" body={path} />;
    }

    return (
        <div ref={hostRef} className="h-full w-full">
            {body}
        </div>
    );
}
```

- [ ] **Step 4: Route the view mode**

In `frontend/app/view/code/codeviewer.tsx`, import the view:

```ts
import { CodeDiffView } from "./codediffview";
```

and in the `case "text":` block, immediately after the `const draft = ...` line, before the markdown branch:

```tsx
            // keyed by path: MonacoDiffViewer creates its models once, so a new file needs a new
            // instance or it keeps the previous file's model URI and language
            if (mode === "diff") {
                return <CodeDiffView key={file.path} path={file.path} text={draft?.text ?? file.text} />;
            }
```

- [ ] **Step 5: Make the view toggle three-way**

In `frontend/app/view/code/codepathbar.tsx`, replace the toggle call site:

```tsx
            {file.kind === "text" ? <ViewModeToggle markdown={isMarkdownPath(file.path)} /> : null}
```

and the component:

```tsx
// Markdown files render as documents by default; Source is the escape back to the editable view and
// Diff shows the file against HEAD. Preview is markdown-only — there is nothing to render for a Go
// file — while Source and Diff are offered for any text file.
function ViewModeToggle({ markdown }: { markdown: boolean }) {
    const [mode, setMode] = useAtom(codeViewModeAtom);
    const modes = (["preview", "source", "diff"] as const).filter((m) => markdown || m !== "preview");
    return (
        <div className="flex flex-none items-center gap-0.5 rounded-[6px] border border-border p-[2px]">
            {modes.map((m) => (
                <button
                    key={m}
                    type="button"
                    data-code-view-mode={m}
                    onClick={() => setMode(m)}
                    className={cn(
                        "cursor-pointer rounded-[4px] px-2 py-[2px] text-[11px] capitalize",
                        m === mode ? "bg-accent/10 text-accent-soft" : "text-muted hover:text-primary"
                    )}
                >
                    {m}
                </button>
            ))}
        </div>
    );
}
```

- [ ] **Step 6: Add the `d` binding**

In `frontend/app/store/keybindings/bindings.ts`, add `codeViewModeAtom` to the existing `@/app/view/code/codestore` import list, and add this binding inside `buildCodeBindings`'s returned array, directly after `code:refresh`:

```ts
        {
            id: "code:diff",
            keys: "d",
            group: "Code",
            label: "Toggle the diff against HEAD",
            when: on,
            run: () => {
                const mode = globalStore.get(codeViewModeAtom);
                globalStore.set(codeViewModeAtom, mode === "diff" ? "source" : "diff");
            },
        },
```

- [ ] **Step 7: Run the tests and typecheck**

Run: `npx vitest run frontend/app/store/keybindings/store.test.ts`
Expected: PASS — that suite evaluates every `when(ctx)` across every context and would fail on a conflicting binding.

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: clean.

- [ ] **Step 8: Add the CDP scenario**

In `scripts/cdp/scenarios.mjs`, after `codeGitStatus`. Four-space indentation, no Prettier.

```js
const codeDiff = {
    name: "code-diff",
    surface: "code",
    async arrange() {
        return {};
    },
    async assert(h) {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const steps = [];
        await h.goto("code");
        if ((await openProjectPicker(h)) === true) {
            await sleep(300);
            await chooseProjectRow(h);
            await sleep(1200);
        }

        // the Changed column guarantees the file we open actually differs from HEAD
        await h.ev(`(() => {
            const t = document.querySelector('[data-code-column-tab="changed"]');
            if (t) t.click();
            return true;
        })()`);
        let rowPath = "";
        for (let i = 0; i < 20; i++) {
            rowPath = await h.ev(
                `(() => { const r = document.querySelector('[data-code-changed-row]'); return r ? r.getAttribute('data-code-changed-row') : ''; })()`
            );
            if (rowPath) break;
            await sleep(500);
        }
        const opened = await h.ev(`(() => {
            const r = document.querySelector('[data-code-changed-row]');
            if (!r) return false;
            r.click();
            return true;
        })()`);
        steps.push({
            step: "open a file that differs from HEAD",
            ok: opened === true && rowPath !== "",
            detail: `path=${rowPath || "(none)"}`,
        });
        await sleep(900);

        const toDiff = await h.ev(`(() => {
            const b = document.querySelector('[data-code-view-mode="diff"]');
            if (!b) return false;
            b.click();
            return true;
        })()`);
        await sleep(1500); // monaco is lazy, and the HEAD read is one git call
        const mounted = await h.ev(`(() => !!document.querySelector('.monaco-diff-editor'))()`);
        steps.push({
            step: "Diff mounts the Monaco diff editor",
            ok: toDiff === true && mounted === true,
            detail: `toggled=${toDiff} mounted=${mounted}`,
        });
        await h.shot("cdp-shots/code-diff.png");

        // `d` is gated on !editable, so focus has to leave Monaco first
        await h.ev(`(() => {
            const t = document.querySelector('[data-code-tree]');
            if (t) t.focus();
            return true;
        })()`);
        await h.ev(
            `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', code: 'KeyD', bubbles: true }))`
        );
        await sleep(800);
        const back = await h.ev(
            `(() => ({ diff: !!document.querySelector('.monaco-diff-editor'), plain: !!document.querySelector('.monaco-editor') }))()`
        );
        steps.push({
            step: "pressing d again returns to the single editor",
            ok: back.diff === false && back.plain === true,
            detail: `diff=${back.diff} plain=${back.plain}`,
        });
        return steps;
    },
    async teardown(h) {
        await h.goto("cockpit"); // leave the app where a human expects it
    },
};
```

Register it beside the others:

```js
    codeGitStatus,
    codeDiff,
```

- [ ] **Step 9: Rebuild the backend and run the scenario**

The new RPC does not exist in the running `wavesrv` until it is rebuilt, and a missing command surfaces as a route error rather than a compile error.

Run: `task build:backend`
Then restart the dev app and run: `task verify:ui -- code-diff`
Expected: PASS. Open `cdp-shots/code-diff.png` and check the diff is syntax-highlighted — an unhighlighted diff means the Step 1 URI fix did not land.

---

### Task 7: The staleness bar

**Files:**
- Create: `frontend/app/view/code/codestalebar.tsx`
- Modify: `frontend/app/view/code/codestore.ts` (`codeStaleAtom`, `checkStale`, the resets)
- Modify: `frontend/app/view/code/codesurface.tsx` (render the bar; check on window focus)
- Modify: `frontend/app/view/code/codetreepane.tsx` (check on tree focus)

**Interfaces:**
- Consumes: `conflictOf` and `FileBase` from `./codedraft` (shipped, reused rather than comparing size/modtime a second way); `atoms.documentHasFocus` from `@/app/store/global-atoms`.
- Produces: `codeStaleAtom: PrimitiveAtom<{ path: string } | null>`, `checkStale(): Promise<void>`, `CodeStaleBar()`.

- [ ] **Step 1: Add the atom and the check**

In `frontend/app/view/code/codestore.ts`, add the atom beside `codeHeadAtom`:

```ts
// Set when the open file's bytes moved on disk since we read them. Never auto-reloads: the caret,
// the scroll offset and the selection would jump under a reader's eyes with no action of theirs.
export const codeStaleAtom = atom<{ path: string } | null>(null) as PrimitiveAtom<{ path: string } | null>;
```

Add the checker after `loadHead`:

```ts
// A re-stat of the ONE open file, on window focus and on tree focus. No watcher, by design: a
// watcher means a backend subscription, debouncing, and reconciling against expand state, to catch
// the same case this catches — an agent wrote while you were looking at another window.
export async function checkStale(): Promise<void> {
    const project = globalStore.get(codeProjectAtom);
    const file = globalStore.get(codeFileAtom);
    if (project == null || file.kind !== "text") {
        return;
    }
    const abs = draftKey(project, file.path);
    const draft = globalStore.get(codeDraftsAtom).get(abs);
    // with a draft, the pinned base is the truth about what we last read; without one, the buffer's
    // own size/modtime is
    const base: FileBase = draft?.base ?? { text: file.text, size: file.size, modtime: file.modtime };
    try {
        const latest = await RpcApi.FileInfoCommand(TabRpcClient, { info: { path: abs } });
        const now = globalStore.get(codeFileAtom);
        if (now.kind !== "text" || now.path !== file.path) {
            return; // the open file changed under a slow stat; only speak for the file we statted
        }
        globalStore.set(codeStaleAtom, conflictOf(base, latest) === "none" ? null : { path: file.path });
    } catch {
        // a failed stat is not evidence of a change, and crying wolf is worse than staying quiet
    }
}
```

Clear it where the buffer is replaced or the project changes. In `openPath`, immediately after `globalStore.set(codeSaveAtom, { kind: "idle" });`:

```ts
    globalStore.set(codeStaleAtom, null);
```

In `saveCurrent`, beside the `void loadStatus();` line added in Task 4:

```ts
        globalStore.set(codeStaleAtom, null); // we just wrote it, so the disk copy is ours again
```

In `selectProject`, beside the other resets:

```ts
    globalStore.set(codeStaleAtom, null);
```

- [ ] **Step 2: Write the bar**

```tsx
// frontend/app/view/code/codestalebar.tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// "The file you are reading changed on disk" is information, not an annoyance to hide — agents run
// against this same working tree. Reload is always deliberate, and when a draft exists the button
// says what it destroys, matching the save-conflict banner's honesty.

import { fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { codeDraftsAtom, codeProjectAtom, codeStaleAtom, draftKey, reloadFromDisk } from "./codestore";

export function CodeStaleBar() {
    const stale = useAtomValue(codeStaleAtom);
    const project = useAtomValue(codeProjectAtom);
    const drafts = useAtomValue(codeDraftsAtom);
    if (stale == null || project == null) {
        return null;
    }
    const dirty = drafts.has(draftKey(project, stale.path));
    return (
        <div
            data-code-stale
            className="flex flex-none items-center gap-3 border-b border-warning/40 bg-warning/10 px-3 py-1.5 text-[11.5px] text-warning"
        >
            <span className="min-w-0 flex-1 truncate">
                {stale.path} changed on disk{dirty ? " — your unsaved edits are still here" : ""}
            </span>
            <button
                type="button"
                onClick={() => fireAndForget(reloadFromDisk)}
                className="flex-none cursor-pointer rounded-[6px] border border-warning/40 px-2 py-[2px] font-semibold hover:bg-warning/15"
            >
                {dirty ? "Discard my edits and reload" : "Reload"}
            </button>
        </div>
    );
}
```

- [ ] **Step 3: Render it and drive the checks**

In `frontend/app/view/code/codesurface.tsx`, add the imports:

```ts
import { atoms } from "@/app/store/global-atoms";
import { CodeStaleBar } from "./codestalebar";
```
and add `checkStale` to the existing `./codestore` import list.

In `CodeSurface`, beside the other `useAtomValue` calls:

```ts
    const hasFocus = useAtomValue(atoms.documentHasFocus);
```

and add the effect after the existing restore effect:

```tsx
    // the case that actually bites: an agent wrote while you were looking at another window
    useEffect(() => {
        if (hasFocus) {
            fireAndForget(checkStale);
        }
    }, [hasFocus]);
```

In `CodePanes`, render the bar directly under the path bar:

```tsx
                <CodePathBar model={model} />
                <CodeStaleBar />
```

In `frontend/app/view/code/codetreepane.tsx`, extend the pane's `onFocus` (leaving the atom write in place):

```tsx
            onFocus={() => {
                globalStore.set(codeTreeFocusedAtom, true);
                fireAndForget(checkStale);
            }}
```
with `checkStale` added to its `./codestore` import list.

- [ ] **Step 4: Typecheck and test**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Run: `npx vitest run frontend/app/view/code/`
Expected: both clean.

- [ ] **Step 5: Prove it in the dev app**

Open a file in the Code surface, then from a terminal append a line to that same file on disk, then click back into the app window.
Expected: the bar appears naming the file, with Reload. Type into the editor first and repeat: the button reads "Discard my edits and reload". Pressing it takes the disk copy.

---

### Task 8: `codemutate.ts` — the pure half of mutation

**Files:**
- Create: `frontend/app/view/code/codemutate.ts`
- Test: `frontend/app/view/code/codemutate.test.ts`

**Interfaces:**
- Consumes: `TreeRow` from `./codetree`; `CodeStatus` from `./codestatus`.
- Produces: `NameError` type; `validateName(name, dir, existing): NameError | null`; `nameErrorMessage(e: NameError): string`; `targetDir(cursor: string | null, rows: readonly TreeRow[]): string`; `provisionalIndex(rows: readonly TreeRow[], dir: string): number`; `renamedPath(path: string, from: string, to: string): string`; `deleteWarning(rel: string, statuses: readonly (CodeStatus | undefined)[], isDir: boolean): string`.

- [ ] **Step 1: Write the failing tests**

```ts
// frontend/app/view/code/codemutate.test.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { TreeRow } from "./codetree";
import {
    deleteWarning,
    nameErrorMessage,
    provisionalIndex,
    renamedPath,
    targetDir,
    validateName,
} from "./codemutate";

const EXISTING = ["src/a.ts", "src/util/b.ts", "README.md"];

const rows: TreeRow[] = [
    { kind: "dir", path: "src", name: "src", depth: 0, expanded: true },
    { kind: "file", path: "src/a.ts", name: "a.ts", depth: 1, expanded: false },
    { kind: "dir", path: "src/util", name: "util", depth: 1, expanded: false },
    { kind: "file", path: "README.md", name: "README.md", depth: 0, expanded: false },
];

describe("validateName", () => {
    it("accepts an ordinary new name", () => {
        expect(validateName("c.ts", "src", EXISTING)).toBeNull();
    });

    it("rejects an empty or whitespace-only name", () => {
        expect(validateName("", "src", EXISTING)).toBe("empty");
        expect(validateName("   ", "src", EXISTING)).toBe("empty");
    });

    it("rejects a path separator in either direction", () => {
        expect(validateName("sub/c.ts", "src", EXISTING)).toBe("separator");
        expect(validateName("sub\\c.ts", "src", EXISTING)).toBe("separator");
    });

    it("rejects the directory dots", () => {
        expect(validateName(".", "src", EXISTING)).toBe("dots");
        expect(validateName("..", "src", EXISTING)).toBe("dots");
    });

    it("accepts a leading dot, which is an ordinary hidden file", () => {
        expect(validateName(".gitignore", "", EXISTING)).toBeNull();
    });

    it("rejects characters Windows cannot put in a filename", () => {
        for (const bad of ["a<b", "a>b", "a:b", 'a"b', "a|b", "a?b", "a*b"]) {
            expect(validateName(bad, "src", EXISTING)).toBe("illegal-char");
        }
    });

    it("rejects a reserved device name with or without an extension", () => {
        expect(validateName("CON", "src", EXISTING)).toBe("reserved");
        expect(validateName("nul.txt", "src", EXISTING)).toBe("reserved");
        expect(validateName("COM1", "src", EXISTING)).toBe("reserved");
        expect(validateName("LPT9.log", "src", EXISTING)).toBe("reserved");
    });

    it("does not treat a name that merely starts with a device name as reserved", () => {
        expect(validateName("console.ts", "src", EXISTING)).toBeNull();
    });

    it("rejects a name already in the index, as a file or as a directory", () => {
        expect(validateName("a.ts", "src", EXISTING)).toBe("exists");
        expect(validateName("util", "src", EXISTING)).toBe("exists");
    });

    it("every error has a message", () => {
        for (const e of ["empty", "separator", "dots", "illegal-char", "reserved", "exists"] as const) {
            expect(nameErrorMessage(e).length).toBeGreaterThan(0);
        }
    });
});

describe("targetDir", () => {
    it("uses the cursor directory itself", () => {
        expect(targetDir("src/util", rows)).toBe("src/util");
    });

    it("uses a cursor file's parent", () => {
        expect(targetDir("src/a.ts", rows)).toBe("src");
    });

    it("falls back to the repo root for a file at the root", () => {
        expect(targetDir("README.md", rows)).toBe("");
    });

    it("falls back to the repo root with no cursor, or a cursor no row matches", () => {
        expect(targetDir(null, rows)).toBe("");
        expect(targetDir("gone/x.ts", rows)).toBe("");
    });
});

describe("provisionalIndex", () => {
    it("puts a new entry at the top for the repo root", () => {
        expect(provisionalIndex(rows, "")).toBe(0);
    });

    it("puts it directly under its target directory row", () => {
        expect(provisionalIndex(rows, "src")).toBe(1);
        expect(provisionalIndex(rows, "src/util")).toBe(3);
    });

    it("falls back to the top when the directory has no visible row", () => {
        expect(provisionalIndex(rows, "nowhere")).toBe(0);
    });
});

describe("renamedPath", () => {
    it("rewrites the renamed path itself", () => {
        expect(renamedPath("src/a.ts", "src/a.ts", "src/z.ts")).toBe("src/z.ts");
    });

    it("rewrites everything under a renamed directory", () => {
        expect(renamedPath("src/util/b.ts", "src/util", "src/helpers")).toBe("src/helpers/b.ts");
    });

    it("leaves an unrelated path alone, including a shared prefix that is not a directory", () => {
        expect(renamedPath("README.md", "src/a.ts", "src/z.ts")).toBe("README.md");
        expect(renamedPath("src/utilities.ts", "src/util", "src/helpers")).toBe("src/utilities.ts");
    });
});

describe("deleteWarning", () => {
    it("tells a tracked file the committed copy survives", () => {
        const msg = deleteWarning("src/a.ts", [undefined], false);
        expect(msg).toContain("src/a.ts");
        expect(msg).toContain("committed copy stays in git history");
    });

    it("tells a staged-but-uncommitted file that checkout restores it", () => {
        const msg = deleteWarning("src/new.ts", [{ status: "A", adds: 3, dels: 0 }], false);
        expect(msg).toContain("git checkout");
    });

    it("tells an untracked file it cannot be undone", () => {
        const msg = deleteWarning("scratch.txt", [{ status: "?", adds: 0, dels: 0 }], false);
        expect(msg).toContain("cannot be undone");
    });

    it("takes the weakest sentence for a directory: one untracked file makes the whole delete final", () => {
        const msg = deleteWarning(
            "src/util",
            [undefined, { status: "A", adds: 1, dels: 0 }, { status: "?", adds: 0, dels: 0 }],
            true
        );
        expect(msg).toContain("cannot be undone");
        expect(msg).toContain("3 files");
    });

    it("says the committed copies survive when everything under a directory is tracked", () => {
        const msg = deleteWarning("src/util", [undefined, { status: "M", adds: 2, dels: 1 }], true);
        expect(msg).toContain("committed copies stay in git history");
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run frontend/app/view/code/codemutate.test.ts`
Expected: FAIL — cannot resolve `./codemutate`.

- [ ] **Step 3: Write the module**

```ts
// frontend/app/view/code/codemutate.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pure: everything a mutation needs to decide before any IO happens. No React, no RPC.
//
// Validation reads the index snapshot rather than the disk, so it can be wrong — which is exactly
// why the write still surfaces the backend's error instead of trusting this.

import type { CodeStatus } from "./codestatus";
import type { TreeRow } from "./codetree";

export type NameError = "empty" | "separator" | "dots" | "illegal-char" | "reserved" | "exists";

// the characters Windows refuses in a filename, plus the control range
const ILLEGAL_CHAR = /[<>:"|?*\u0000-\u001f]/;
// CON, PRN, AUX, NUL, COM1-9, LPT1-9 are devices with or without an extension: "nul.txt" is still
// the null device, and creating one fails at the filesystem rather than at git
const RESERVED = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i;

export function validateName(name: string, dir: string, existing: readonly string[]): NameError | null {
    const n = name.trim();
    if (n === "") {
        return "empty";
    }
    if (n.includes("/") || n.includes("\\")) {
        return "separator";
    }
    if (n === "." || n === "..") {
        return "dots";
    }
    if (ILLEGAL_CHAR.test(n)) {
        return "illegal-char";
    }
    if (RESERVED.test(n)) {
        return "reserved";
    }
    const rel = dir === "" ? n : `${dir}/${n}`;
    if (existing.some((p) => p === rel || p.startsWith(`${rel}/`))) {
        return "exists";
    }
    return null;
}

export function nameErrorMessage(e: NameError): string {
    switch (e) {
        case "empty":
            return "Enter a name.";
        case "separator":
            return "A name cannot contain a path separator.";
        case "dots":
            return '"." and ".." are not names.';
        case "illegal-char":
            return 'A name cannot contain < > : " | ? * or control characters.';
        case "reserved":
            return "That is a reserved device name on Windows.";
        case "exists":
            return "Something with that name is already here.";
    }
}

// Where a new entry lands. Pure and tested because the rule is obvious right up until the cursor is
// on a collapsed directory, on a file at the root, or nowhere at all.
export function targetDir(cursor: string | null, rows: readonly TreeRow[]): string {
    if (cursor == null) {
        return "";
    }
    const row = rows.find((r) => r.path === cursor);
    if (row == null) {
        return "";
    }
    if (row.kind === "dir") {
        return row.path;
    }
    const cut = row.path.lastIndexOf("/");
    return cut === -1 ? "" : row.path.slice(0, cut);
}

// Where the provisional "type a name here" row is spliced into the rendered rows: as the target
// directory's first child, or at the top for the repo root.
export function provisionalIndex(rows: readonly TreeRow[], dir: string): number {
    if (dir === "") {
        return 0;
    }
    const i = rows.findIndex((r) => r.path === dir);
    return i === -1 ? 0 : i + 1;
}

// Rewrite one path across a rename. A directory rename carries its descendants; a shared prefix
// that is not a directory boundary ("src/utilities.ts" under a rename of "src/util") does not.
export function renamedPath(path: string, from: string, to: string): string {
    if (path === from) {
        return to;
    }
    if (path.startsWith(`${from}/`)) {
        return to + path.slice(from.length);
    }
    return path;
}

// The honest recoverability line the confirm shows. git answers this per file, so the confirm can
// say what is true instead of a blanket "this cannot be undone" that is usually false — and for a
// directory the weakest sentence wins, because one untracked file inside makes the whole delete
// final and saying otherwise would be the one kind of wrong this sentence must never be.
export function deleteWarning(
    rel: string,
    statuses: readonly (CodeStatus | undefined)[],
    isDir: boolean
): string {
    const untracked = statuses.some((s) => s?.status === "?");
    const stagedOnly = !untracked && statuses.some((s) => s?.status === "A");
    if (isDir) {
        const n = statuses.length;
        const head = `Delete "${rel}" and everything inside it — ${n} file${n === 1 ? "" : "s"} git knows about, plus anything git ignores.`;
        if (untracked) {
            return `${head} Some of it is not in git, so deleting it cannot be undone.`;
        }
        if (stagedOnly) {
            return `${head} What is staged but never committed is still in the index — git checkout restores it.`;
        }
        return `${head} The committed copies stay in git history.`;
    }
    if (untracked) {
        return `Delete "${rel}"? This file is not in git. Deleting it cannot be undone.`;
    }
    if (stagedOnly) {
        return `Delete "${rel}"? Staged in git — git checkout restores it.`;
    }
    return `Delete "${rel}"? The committed copy stays in git history.`;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run frontend/app/view/code/codemutate.test.ts`
Expected: all PASS.

---

### Task 9: The mutations in the store

**Files:**
- Modify: `frontend/app/view/code/codestore.ts`
- Modify: `frontend/app/view/code/codesurface.tsx` (the mutation error banner)

**Interfaces:**
- Consumes: `RpcApi.FileCreateCommand`, `FileMkdirCommand`, `FileMoveCommand`, `FileDeleteCommand` (all shipped); `renamedPath`, `deleteWarning`, `targetDir` (Task 8); `modalsModel` from `@/app/store/modalmodel`.
- Produces: `codeMutateErrorAtom: PrimitiveAtom<string | null>`; `codeEditAtom: PrimitiveAtom<CodeEdit>` where `CodeEdit = { kind: "rename"; path: string } | { kind: "create"; dir: string; isDir: boolean } | null`; `startCreate(isDir: boolean): void`; `startRename(path: string): void`; `cancelEdit(): void`; `createEntry(dir: string, name: string, isDir: boolean): Promise<void>`; `renamePath(rel: string, newName: string): Promise<void>`; `deletePath(rel: string, isDir: boolean): Promise<void>`; `confirmDelete(rel: string, isDir: boolean): void`.

- [ ] **Step 1: Add the atoms and the edit-state entry points**

In `frontend/app/view/code/codestore.ts`, extend the imports:

```ts
import { modalsModel } from "@/app/store/modalmodel";
import { fireAndForget } from "@/util/util";
import { deleteWarning, renamedPath, targetDir } from "./codemutate";
```
(`joinRepoPath` and `base64ToString` are already imported from their modules.)

Add beside the other atoms:

```ts
// A mutation is a user-initiated action, so its failure gets a banner rather than a silent no-op.
export const codeMutateErrorAtom = atom<string | null>(null) as PrimitiveAtom<string | null>;

// The inline name input's whole state. There is no modal for create or rename: a modal to type
// eleven characters is friction, and the inline row shows WHERE the thing will land.
export type CodeEdit = { kind: "rename"; path: string } | { kind: "create"; dir: string; isDir: boolean } | null;
export const codeEditAtom = atom<CodeEdit>(null) as PrimitiveAtom<CodeEdit>;

export function startCreate(isDir: boolean): void {
    const dir = targetDir(globalStore.get(codeCursorAtom), globalStore.get(codeRowsAtom));
    if (dir !== "") {
        // the provisional row is the target directory's first child, so that directory has to be open
        const expanded = new Set(globalStore.get(codeExpandedAtom));
        for (const a of ancestorsOf(`${dir}/x`)) {
            expanded.add(a);
        }
        expanded.add(dir);
        globalStore.set(codeExpandedAtom, expanded);
    }
    globalStore.set(codeEditAtom, { kind: "create", dir, isDir });
}

export function startRename(path: string): void {
    globalStore.set(codeEditAtom, { kind: "rename", path });
}

export function cancelEdit(): void {
    globalStore.set(codeEditAtom, null);
}
```

- [ ] **Step 2: Add the three mutations**

Append after `checkStale`:

```ts
function errorText(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

// Every mutation is RPC -> refreshIndex(), and refreshIndex reloads status too (see loadIndex).
// Nothing optimistically patches the tree: splicing a path into a cached array and hoping git
// agrees is exactly the drift the single-row-list rule exists to prevent. The index is refreshed
// even when the RPC failed, so the tree shows what is actually there rather than what we intended.
export async function createEntry(dir: string, name: string, isDir: boolean): Promise<void> {
    const project = globalStore.get(codeProjectAtom);
    if (project == null) {
        return;
    }
    const rel = dir === "" ? name : `${dir}/${name}`;
    const abs = joinRepoPath(project.path, rel);
    globalStore.set(codeMutateErrorAtom, null);
    globalStore.set(codeEditAtom, null);
    let ok = true;
    try {
        if (isDir) {
            await RpcApi.FileMkdirCommand(TabRpcClient, { info: { path: abs } });
        } else {
            await RpcApi.FileCreateCommand(TabRpcClient, { info: { path: abs } });
        }
    } catch (e) {
        ok = false;
        globalStore.set(codeMutateErrorAtom, `Could not create ${rel}: ${errorText(e)}`);
    }
    await refreshIndex();
    if (!ok) {
        return;
    }
    revealPath(rel);
    globalStore.set(codeCursorAtom, rel);
    if (!isDir) {
        // an empty directory is not in `git ls-files` output at all, so only a file has a row to open
        await openPath(rel);
    }
}

// Renaming the file you are reading and landing on a `missing` empty state would be a bug wearing a
// feature's clothes, so the open buffer, the cursor, the drafts and the history all come along.
export async function renamePath(rel: string, newName: string): Promise<void> {
    const project = globalStore.get(codeProjectAtom);
    if (project == null) {
        return;
    }
    const cut = rel.lastIndexOf("/");
    const next = cut === -1 ? newName : `${rel.slice(0, cut)}/${newName}`;
    globalStore.set(codeEditAtom, null);
    if (next === rel) {
        return;
    }
    globalStore.set(codeMutateErrorAtom, null);
    let ok = true;
    try {
        await RpcApi.FileMoveCommand(TabRpcClient, {
            srcuri: joinRepoPath(project.path, rel),
            desturi: joinRepoPath(project.path, next),
            opts: { recursive: true },
        });
    } catch (e) {
        ok = false;
        globalStore.set(codeMutateErrorAtom, `Could not rename ${rel}: ${errorText(e)}`);
    }
    if (ok) {
        carryRename(project, rel, next);
    }
    await refreshIndex();
}

// Windows-only build: draft keys come from joinRepoPath, which normalizes the whole join to
// backslashes, so both sides of this comparison are built the same way and a plain prefix match is
// exact rather than approximate.
const ABS_SEP = "\\";

function carryRename(project: CodeProject, rel: string, next: string): void {
    const from = draftKey(project, rel);
    const to = draftKey(project, next);
    const drafts = globalStore.get(codeDraftsAtom);
    const moved = new Map<string, Draft>();
    for (const [key, d] of drafts) {
        if (key === from) {
            moved.set(to, d);
        } else if (key.startsWith(from + ABS_SEP)) {
            moved.set(to + key.slice(from.length), d);
        } else {
            moved.set(key, d);
        }
    }
    globalStore.set(codeDraftsAtom, moved);

    const file = globalStore.get(codeFileAtom);
    if (file.kind !== "none") {
        const p = renamedPath(file.path, rel, next);
        if (p !== file.path) {
            globalStore.set(codeFileAtom, { ...file, path: p });
        }
    }
    const cursor = globalStore.get(codeCursorAtom);
    if (cursor != null) {
        globalStore.set(codeCursorAtom, renamedPath(cursor, rel, next));
    }
    globalStore.set(codeHistoryAtom, (h) => ({ stack: h.stack.map((p) => renamedPath(p, rel, next)), idx: h.idx }));
    revealPath(next);
}

// FileDeleteCommand is a hard delete — no recycle bin, no trash, and deliberately no undo stack
// (holding deleted bytes in memory would be a second source of truth for a file's content). The
// confirm carries the recoverability instead; see confirmDelete.
export async function deletePath(rel: string, isDir: boolean): Promise<void> {
    const project = globalStore.get(codeProjectAtom);
    if (project == null) {
        return;
    }
    globalStore.set(codeMutateErrorAtom, null);
    try {
        await RpcApi.FileDeleteCommand(TabRpcClient, {
            path: joinRepoPath(project.path, rel),
            recursive: isDir,
        });
    } catch (e) {
        globalStore.set(codeMutateErrorAtom, `Could not delete ${rel}: ${errorText(e)}`);
    }
    const file = globalStore.get(codeFileAtom);
    if (file.kind !== "none" && renamedPath(file.path, rel, rel) === file.path && underOrEqual(file.path, rel)) {
        // the buffer's file is gone; the DRAFT is not touched — it is keyed by absolute path and
        // throwing typed text away is never automatic here
        globalStore.set(codeFileAtom, { kind: "none" });
        globalStore.set(codeCursorAtom, null);
    }
    await refreshIndex();
}

function underOrEqual(path: string, dir: string): boolean {
    return path === dir || path.startsWith(`${dir}/`);
}

// Shared by the tree context menu and the Delete keybinding, the way memstore's confirmDeleteNote
// is shared by its list menu and its detail pane.
export function confirmDelete(rel: string, isDir: boolean): void {
    const paths = globalStore.get(codeIndexAtom)?.paths ?? [];
    const status = globalStore.get(codeStatusAtom);
    const under = isDir ? paths.filter((p) => p.startsWith(`${rel}/`)) : [rel];
    modalsModel.pushModal("ConfirmModal", {
        title: isDir ? "Delete folder" : "Delete file",
        message: deleteWarning(
            rel,
            under.map((p) => status?.get(p)),
            isDir
        ),
        confirmLabel: "Delete",
        destructive: true,
        onConfirm: () => fireAndForget(() => deletePath(rel, isDir)),
    });
}
```

- [ ] **Step 3: Show mutation failures**

In `frontend/app/view/code/codesurface.tsx`, add `codeMutateErrorAtom` to the `./codestore` import list, read it in `CodeSurface`:

```ts
    const mutateError = useAtomValue(codeMutateErrorAtom);
```

and render it next to the existing index-error banner, above `<SaveBanner />`:

```tsx
            {mutateError != null ? (
                <SurfaceError
                    message={mutateError}
                    actionLabel="Dismiss"
                    onRetry={() => globalStore.set(codeMutateErrorAtom, null)}
                />
            ) : null}
```
with `import { globalStore } from "@/app/store/jotaiStore";` added.

- [ ] **Step 4: Typecheck and run the suite**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Run: `npx vitest run frontend/app/view/code/`
Expected: both clean. `Draft` and `CodeProject` are already in scope in `codestore.ts`; if the typechecker disagrees, add `Draft` to the existing `./codedraft` type import.

---

### Task 10: The mutation controls

**Files:**
- Modify: `frontend/app/view/code/codetreepane.tsx` (context menu, inline name input, provisional row)
- Modify: `frontend/app/view/code/codesurface.tsx` (New File / New Folder header buttons)

**Interfaces:**
- Consumes: `startCreate`, `startRename`, `cancelEdit`, `createEntry`, `renamePath`, `confirmDelete`, `codeEditAtom` (Task 9); `validateName`, `nameErrorMessage`, `provisionalIndex` (Task 8); `ContextMenuModel` from `@/app/store/contextmenu`.
- Produces: no new exports — this task is the UI over Task 9.

- [ ] **Step 1: Add the inline name input to the tree pane**

In `frontend/app/view/code/codetreepane.tsx`, extend the imports:

```ts
import { ContextMenuModel } from "@/app/store/contextmenu";
import { joinRepoPath } from "@/util/paths";
import { FilePlus, FolderPlus, Pencil, Trash2 } from "lucide-react";
import { useState } from "react";
import { nameErrorMessage, provisionalIndex, validateName } from "./codemutate";
```
and add `cancelEdit, codeEditAtom, codeIndexAtom, confirmDelete, createEntry, renamePath, startCreate, startRename` to the existing `./codestore` import list.

Add the input component at the bottom of the file:

```tsx
// Enter commits, Escape cancels, and the error shows while you type — the pre-check reads the index
// snapshot, so it can be wrong, which is why the write still surfaces the backend's error.
function NameInput({
    initial,
    dir,
    depth,
    existing,
    onCommit,
}: {
    initial: string;
    dir: string;
    depth: number;
    existing: readonly string[];
    onCommit: (name: string) => void;
}) {
    const [value, setValue] = useState(initial);
    const err = value.trim() === initial ? null : validateName(value, dir, existing);
    return (
        <div style={{ paddingLeft: 8 + depth * 12 }} className="flex w-full items-center gap-1.5 py-[3px] pr-2">
            <input
                autoFocus
                value={value}
                data-code-name-input
                onChange={(e) => setValue(e.target.value)}
                onBlur={cancelEdit}
                onKeyDown={(e) => {
                    e.stopPropagation(); // the tree's j/k/n bindings must not eat what you type
                    if (e.key === "Escape") {
                        cancelEdit();
                    }
                    if (e.key === "Enter" && err == null) {
                        onCommit(value.trim());
                    }
                }}
                className="min-w-0 flex-1 rounded-[4px] border border-border bg-surface px-1 py-[1px] text-[12px] text-primary outline-none"
            />
            {err != null ? (
                <span title={nameErrorMessage(err)} className="flex-none text-[10px] text-error">
                    {nameErrorMessage(err)}
                </span>
            ) : null}
        </div>
    );
}
```

- [ ] **Step 2: Splice the provisional row and the rename input into the list**

Still in `CodeTreePane`, read the extra state:

```ts
    const edit = useAtomValue(codeEditAtom);
    const index = useAtomValue(codeIndexAtom);
    const paths = index?.paths ?? [];
    const provisional = edit?.kind === "create" ? provisionalIndex(rows, edit.dir) : -1;
    const provisionalDepth = edit?.kind === "create" && edit.dir !== "" ? (rows.find((r) => r.path === edit.dir)?.depth ?? -1) + 1 : 0;
```

Wrap the existing `rows.map(...)` so the provisional row can sit between two rows. Replace `{rows.map((row) => (` with a built list — keep the whole existing row JSX as the body of `renderRow`:

```tsx
            {rows.flatMap((row, i) => {
                const out: React.ReactNode[] = [];
                if (i === provisional && edit?.kind === "create") {
                    out.push(
                        <NameInput
                            key="__provisional"
                            initial=""
                            dir={edit.dir}
                            depth={provisionalDepth}
                            existing={paths}
                            onCommit={(name) => fireAndForget(() => createEntry(edit.dir, name, edit.isDir))}
                        />
                    );
                }
                out.push(renderRow(row));
                return out;
            })}
            {edit?.kind === "create" && provisional >= rows.length ? (
                <NameInput
                    key="__provisional"
                    initial=""
                    dir={edit.dir}
                    depth={provisionalDepth}
                    existing={paths}
                    onCommit={(name) => fireAndForget(() => createEntry(edit.dir, name, edit.isDir))}
                />
            ) : null}
```

Inside `renderRow`, replace the row's name span when that row is being renamed:

```tsx
                    {edit?.kind === "rename" && edit.path === row.path ? (
                        <NameInput
                            initial={row.name}
                            dir={row.path.includes("/") ? row.path.slice(0, row.path.lastIndexOf("/")) : ""}
                            depth={0}
                            existing={paths.filter((p) => p !== row.path && !p.startsWith(`${row.path}/`))}
                            onCommit={(name) => fireAndForget(() => renamePath(row.path, name))}
                        />
                    ) : (
                        <span className="min-w-0 truncate">{row.name}</span>
                    )}
```

(`renderRow` is a local arrow function in `CodeTreePane` holding the existing row markup verbatim; extracting it is what makes the splice above readable, and it closes over `cursor`, `status`, `drafts` and the rest exactly as the inline map did.)

- [ ] **Step 3: Add the context menu**

On the row container, beside the existing `onClick`:

```tsx
                    onContextMenu={(ev) => {
                        globalStore.set(codeCursorAtom, row.path);
                        ContextMenuModel.getInstance().showContextMenu(
                            [
                                {
                                    label: "New File",
                                    icon: <FilePlus size={13} strokeWidth={1.8} />,
                                    click: () => startCreate(false),
                                },
                                {
                                    label: "New Folder",
                                    icon: <FolderPlus size={13} strokeWidth={1.8} />,
                                    click: () => startCreate(true),
                                },
                                { type: "separator" },
                                {
                                    label: "Rename",
                                    icon: <Pencil size={13} strokeWidth={1.8} />,
                                    accel: "F2",
                                    click: () => startRename(row.path),
                                },
                                {
                                    label: "Delete",
                                    icon: <Trash2 size={13} strokeWidth={1.8} />,
                                    danger: true,
                                    accel: "Delete",
                                    click: () => confirmDelete(row.path, row.kind === "dir"),
                                },
                                { type: "separator" },
                                {
                                    label: "Copy Path",
                                    click: () => {
                                        if (project != null) {
                                            void navigator.clipboard?.writeText(joinRepoPath(project.path, row.path));
                                        }
                                    },
                                },
                            ],
                            ev
                        );
                    }}
```

`startCreate` reads the cursor, which the first line of this handler has just moved to the right-clicked row, so New File lands where the user pointed.

- [ ] **Step 4: Add the header cluster**

In `frontend/app/view/code/codesurface.tsx`, import the icons and `startCreate`:

```ts
import { ChevronDown, FilePlus, FolderGit2, FolderPlus, RotateCw, Save, Undo2 } from "lucide-react";
```

and add two buttons in the header `actions`, directly before the Refresh button — the affordance for an empty or unfocused tree, where there is no row to right-click:

```tsx
                        <HeaderButton label="New file (n)" onClick={() => startCreate(false)}>
                            <FilePlus size={13} strokeWidth={1.8} />
                        </HeaderButton>
                        <HeaderButton label="New folder (Shift+N)" onClick={() => startCreate(true)}>
                            <FolderPlus size={13} strokeWidth={1.8} />
                        </HeaderButton>
```

- [ ] **Step 5: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: clean.

- [ ] **Step 6: Exercise it in the dev app**

In the Code surface: right-click a file row and create a new file beside it; the provisional input appears inside the right directory, Enter creates and opens it, and the tree shows it with an untracked `?`. Rename it (the open buffer follows), then delete it and read the confirm — for a file you just created and never staged it must say the delete cannot be undone.
Expected: all three round-trip, and any failure lands in the banner rather than vanishing.

---

### Task 11: The tree keybindings

**Files:**
- Modify: `frontend/app/store/keybindings/bindings.ts`

**Interfaces:**
- Consumes: `startCreate`, `startRename`, `confirmDelete`, `codeCursorAtom`, `codeRowsAtom` (Tasks 9 and 10).
- Produces: bindings `code:new-file`, `code:new-folder`, `code:rename`, `code:delete`.

- [ ] **Step 1: Add the four bindings**

Add `confirmDelete, startCreate, startRename` to the existing `@/app/view/code/codestore` import list, then add these to the array returned by `buildCodeBindings`, after `code:tree-activate`. They hang off the existing `inTree` predicate, so they cannot fire while the caret is in Monaco:

```ts
        {
            id: "code:new-file",
            keys: "n",
            group: "Code",
            label: "New file in the cursor's directory",
            when: inTree,
            run: () => startCreate(false),
        },
        {
            id: "code:new-folder",
            keys: "Shift:n",
            group: "Code",
            label: "New folder in the cursor's directory",
            when: inTree,
            run: () => startCreate(true),
        },
        {
            id: "code:rename",
            keys: "F2",
            group: "Code",
            label: "Rename the cursor row",
            when: inTree,
            run: () => {
                const cursor = globalStore.get(codeCursorAtom);
                if (cursor == null) {
                    return false; // nothing named, so let the key pass
                }
                startRename(cursor);
            },
        },
        {
            id: "code:delete",
            keys: "Delete",
            group: "Code",
            label: "Delete the cursor row",
            when: inTree,
            run: () => {
                const cursor = globalStore.get(codeCursorAtom);
                const row = globalStore.get(codeRowsAtom).find((r) => r.path === cursor);
                if (row == null) {
                    return false;
                }
                confirmDelete(row.path, row.kind === "dir");
            },
        },
```

- [ ] **Step 2: Run the binding suite**

Run: `npx vitest run frontend/app/store/keybindings/store.test.ts`
Expected: PASS. That suite evaluates every `when(ctx)` across every context and asserts the Code bindings conflict with nothing, so these four are covered by it for free.

- [ ] **Step 3: Run the whole frontend suite and typecheck**

Run: `npx vitest run`
Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: both clean.

- [ ] **Step 4: Try the keys in the dev app**

Click into the tree (the pane is the focus owner), move with `j`/`k`, then press `n`, `Shift+N`, `F2` and `Delete`.
Expected: each opens the right affordance, and none of them fire while the caret is in the editor. `Delete` on a directory names the directory, its file count and the weakest recoverability of what is inside.

---

### Task 12: Verify in the real app, then commit

**Files:**
- Commit: everything from Tasks 1-11, plus the spec and this plan

**Interfaces:**
- Consumes: everything above.
- Produces: one commit.

- [ ] **Step 1: Rebuild the backend**

Run: `task build:backend`
Expected: `dist/bin/wavesrv.x64.exe` and the `wsh-*` binaries rebuilt. If you worked in a worktree, note that this writes THAT worktree's `dist/bin` — rebuild in the main checkout before live checks there.

- [ ] **Step 2: Run every suite**

Run: `go test ./pkg/gitinfo/`
Run: `npx vitest run`
Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: all green. Do not proceed past a failure — fix it.

- [ ] **Step 3: Run both CDP scenarios**

With the dev app running against the rebuilt backend:

Run: `task verify:ui -- code-git-status code-diff`
Expected: PASS on every step, contact sheet at `cdp-shots/index.html`. Open `cdp-shots/code-diff.png` and confirm the diff is syntax-highlighted and readable at the window's real width; open `cdp-shots/code-changed.png` and confirm the Changed rows are legible at 380px.

- [ ] **Step 4: Walk the failure modes by hand**

The spec's table, in the dev app: rename a file to a name that already exists (blocked inline, no RPC); open a file added since HEAD and press `d` (renders wholly added, empty original); edit a file on disk from a terminal while it is open with unsaved edits (stale bar naming the discard, and Ctrl+S still refuses); delete a directory (confirm names it, the count and the weakest recoverability).

- [ ] **Step 5: Self-review the diff**

Run: `git status --short` and `git diff`
Check: no commented-out code, no debug logging, no stray `console.log`, no unrelated files, no hardcoded colors, no emojis. Confirm `scripts/cdp/scenarios.mjs` is still four-space indented (a two-space reindent means Prettier ran on it — revert and hand-format).

- [ ] **Step 6: Ask for approval, then commit**

Do not run this without an explicit yes — the repo rule is no commit without approval.

```bash
git add pkg/gitinfo/gitinfo.go pkg/gitinfo/gitinfo_test.go \
        pkg/wshrpc/wshrpctypes_git.go pkg/wshrpc/wshserver/wshserver_git.go \
        pkg/wshrpc/wshclient/wshclient.go \
        frontend/app/store/wshclientapi.ts frontend/types/gotypes.d.ts \
        frontend/app/monaco/monaco-react.tsx \
        frontend/app/store/keybindings/bindings.ts \
        frontend/app/view/code/ \
        scripts/cdp/scenarios.mjs \
        docs/superpowers/specs/2026-09-04-code-git-aware-mutable-tree-design.md \
        docs/superpowers/plans/2026-09-04-code-git-aware-mutable-tree.md
```

(Drop the Go and generated paths from that list if the preflights in Tasks 1, 2 and 6 all skipped — in that case the sibling plan owns those files and this commit must not carry them.)

Then commit with a message file — never a PowerShell here-string in the Bash tool on this machine:

```
feat(code): git-aware tree, Changed column, diff-vs-HEAD, file mutation

The Code surface now knows what git knows. Tree rows carry a status
letter and collapsed directories a roll-up dot, a third column lists the
working tree's changes, and the path bar's view toggle gains Diff, which
renders the open file against HEAD in Monaco with unsaved edits on the
modified side.

A staleness bar appears when the open file moves on disk, checked on
window focus and tree focus rather than by a watcher, and it never
replaces a buffer without being asked.

The tree can now create, rename and delete: a context menu and inline
name input, F2 / Delete / n / Shift+N on the tree, a delete confirm that
states per-file what git can and cannot recover, and a rename that
carries the open buffer, its draft, the cursor and the history with it.
```

---

## Self-Review

**Spec coverage.** Backend reader (spec section 1) -> Tasks 1 and 2, as `FileAtRef` rather than `ShowFile` (deviation recorded below). `codestatus.ts` -> Task 3. `codeStatusAtom` / `codeStatusDirsAtom` / `loadStatus` and the tree glyphs (decisions 2 and 3) -> Task 4. The Changed column (decision 4) -> Task 5. `codeHeadAtom` / `loadHead` / the three-way toggle / `codediffview.tsx` and the `d` key -> Task 6. `checkStale` and `codestalebar.tsx` (decisions 5 and 6) -> Task 7. `codemutate.ts` including `validateName`, `targetDir` and `deleteWarning` (decisions 7 and 10) -> Task 8. The store mutations, the rename carry (decision 8) and the refresh-not-patch rule (decision 9) -> Task 9. The context menu, inline rename and create, the header cluster and the delete confirm -> Task 10. The four tree keybindings -> Task 11. Both CDP scenarios the spec asks for -> Tasks 5 and 6, run together in Task 12; the Go tests the spec lists -> Task 1; the failure-mode table -> Task 12 Step 4.

**Deviations from the spec, recorded rather than left implicit.**

1. *The reader is `FileAtRef`, not `ShowFile`.* Argued at length in Global Constraints: the same-day sibling plan lands a superset in the same package, and its cwd-relative rev spec is not a nicety — the bare `<ref>:<path>` form the spec proposed silently misses whenever the browsed project path is a subdirectory of the repository, which `resolveJumpProject` makes reachable (it will happily browse a worktree or any directory). Both plans carry preflights so whichever runs second skips the work.
2. *`loadStatus` is called from `loadIndex`, not from each mutation.* The spec writes each mutation as `RPC -> refreshIndex() -> loadStatus()`. One call inside `loadIndex` produces the same two RPCs on every path that already refreshes the index — project switch, `r`, and every mutation — with no chance of a new mutation forgetting one half. Save calls `loadStatus` directly, because a save refreshes status without touching the index.
3. *Binary and too-large at HEAD land in `HeadText`'s `error` variant* rather than earning variants of their own. Both mean "there is nothing to render on the left", the message says which, and the union stays at five cases.
4. *`statusGlyph` does not reuse `gitstatus.ts`'s `STATUS_COLOR`.* The spec named different tokens (warning for modified, muted for untracked) than the shipped map, and the reason is real: in a dense change list modified is the majority and reads as accent, while in a file tree it is the exception. The comment in `codestatus.ts` records this so a later reader does not "fix" it into a duplicate.

**Placeholder scan.** No TBDs, no "add error handling", no "similar to Task N". Every code step carries the actual code. The three preflight branches (Tasks 1, 2, 6) are the only conditionals, each is a single named `grep` with a stated skip, and each names exactly what to do in both directions.

**Type consistency.** `CodeStatus` is defined in Task 3 and consumed by that name in Tasks 4, 8 and 9. `StatusGlyph`'s three fields (`letter`, `className`, `label`) are produced in Task 3 and read in Tasks 4 and 5. `HeadText`'s five variants are defined in Task 6 and switched on in that same task's view. `CodeEdit`'s two shapes are defined in Task 9 and destructured in Task 10 with the same field names (`dir`, `isDir`, `path`). `codeStatusAtom`, `codeStatusErrorAtom`, `codeStatusDirsAtom`, `codeHeadAtom`, `codeStaleAtom`, `codeMutateErrorAtom` and `codeEditAtom` keep those names everywhere they appear. The Go `FileContent` fields map one-for-one onto `CommandGitFileAtRefRtnData`, and the TypeScript reads them lowercased (`res.toolarge`, `res.isrepo`) exactly as `task generate` emits them. `createEntry(dir, name, isDir)` is one function rather than the spec's `createFile` / `createFolder` pair — the two differed only in which RPC they called and which of them the UI would have had to choose between anyway; the UI passes the boolean it already holds in `CodeEdit.isDir`.
