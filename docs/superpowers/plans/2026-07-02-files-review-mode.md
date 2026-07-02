# Files Review Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Review" mode to the Files surface where a user stages Accept/Reject decisions on an agent/project worktree's uncommitted changes (hunk- and file-level), then applies them in one batch that reverts the rejected changes.

**Architecture:** One new backend write command (`GitRevertCommand`) in `pkg/gitinfo` reverts a file (`git checkout`/`clean`/`rm`) or a patch (`git apply --reverse`). The frontend holds all decisions as pure state until Apply, so undo is free. The diff parser gains reconstructable per-hunk patches (the existing parse is lossy). A new `reviewstore.ts` (logic, unit-tested) + `reviewsurface.tsx` (presentation, ported from the approved design) plug into `filessurface.tsx` behind a Browse⇄Review toggle.

**Tech Stack:** Go (git subprocess, wshrpc), React 19 + jotai + Tailwind v4, vitest, `go test`. Spec: `docs/superpowers/specs/2026-07-02-files-review-mode-design.md`.

**Conventions:** Run the typechecker as `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (bare `npx tsc` overflows). Frontend tests: `npx vitest run <file>`. Go tests: `go test ./pkg/gitinfo/`. Theme: `@theme` tokens only, no hardcoded hex. Never hand-edit generated files — run `task generate`.

**Design reference:** The visual/interaction source is `Wave-diff-review.dc.html` in the claude.ai/design project "wave" (`projectId 76055164-ad6f-4b77-946c-14227a3824ff`). Fetch it with the DesignSync MCP (`get_file`, requires the owner's claude.ai design auth via `/design-login` — the main session has it; a subagent will not, so the ported markup in Task 6 is authoritative for those without access). **The Task 6 port deliberately adapts the design — preserve its layout, spacing, and interaction, but keep these intentional deviations** (per the spec): (1) the left column is a **file list**, not the design's task-grouped "Walkthrough / Plan · N tasks" (task grouping is v2); (2) the `walkthrough`/`runTitle` narrative is **omitted** (no honest data source); (3) exact hexes map to `@theme` tokens — `#54c79a`→`success`, `#e0726c`→`error`, `#e6b450`→`warning`, greys→`ink-*`/`surface`/`border`/`edge-*`; (4) the design's standalone titlebar is dropped (this renders under the cockpit NavRail). Verb mapping: design "Accept/Reject" = keep/discard, "Apply review" = the batch that reverts the rejected changes.

---

## Task 1: Backend — `RevertFile` / `RevertHunk` in `pkg/gitinfo`

**Files:**
- Modify: `pkg/gitinfo/gitinfo.go`
- Test: `pkg/gitinfo/gitinfo_test.go`

- [ ] **Step 1: Write the failing tests**

Append to `pkg/gitinfo/gitinfo_test.go`. These build a temp repo with a committed base, dirty it, and assert revert behavior. Reuse whatever repo-init helper the existing tests use; if none, use the inline helper below.

```go
func initRepo(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	ctx := context.Background()
	for _, args := range [][]string{
		{"init"}, {"config", "user.email", "t@t"}, {"config", "user.name", "t"},
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
	writeFile(t, dir, "a.txt", "l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10\n")
	commitAll(t, dir)
	// two separate edits -> two hunks
	writeFile(t, dir, "a.txt", "l1\nX2\nl3\nl4\nl5\nl6\nl7\nl8\nX9\nl10\n")
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
	// first hunk reverted (X2 -> l2), second still dirty (X9 stays)
	if string(got) != "l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nX9\nl10\n" {
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
```

Add imports to the test file if missing: `os`, `path/filepath`, `strings`, `context`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./pkg/gitinfo/ -run 'Revert' -v`
Expected: FAIL — `undefined: RevertFile` / `undefined: RevertHunk`.

- [ ] **Step 3: Implement `RevertFile`, `RevertHunk`, and a stdin helper**

Add to `pkg/gitinfo/gitinfo.go` (after `runErr`, near line 116). `run`/`runErr` don't pipe stdin, so add `runStdin`:

```go
// runStdin runs git with data piped to stdin (for `apply`). Captures stderr into the error.
func runStdin(ctx context.Context, cwd, stdin string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, "git", append([]string{"-C", cwd}, args...)...)
	cmd.Stdin = strings.NewReader(stdin)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return string(out), fmt.Errorf("git %s: %w: %s", strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
	return string(out), nil
}

// RevertFile discards a file's uncommitted changes based on its porcelain status:
// untracked ("?") -> git clean; newly-added/staged ("A") -> git rm; otherwise restore from HEAD.
func RevertFile(ctx context.Context, cwd, path, status string) error {
	ctx, cancel := context.WithTimeout(ctx, gitTimeout)
	defer cancel()
	s := strings.TrimSpace(status)
	switch {
	case strings.Contains(status, "?"):
		_, err := runErr(ctx, cwd, "clean", "-f", "--", path)
		return err
	case strings.HasPrefix(s, "A"):
		_, err := runErr(ctx, cwd, "rm", "-f", "--", path)
		return err
	default:
		_, err := runErr(ctx, cwd, "checkout", "HEAD", "--", path)
		return err
	}
}

// RevertHunk reverse-applies a unified-diff patch (one or more hunks for a single file) to the
// working tree, discarding exactly those changes. Fails (does not silently no-op) if the patch
// no longer applies — the caller surfaces that so the user can reload a stale diff.
func RevertHunk(ctx context.Context, cwd, path, patch string) error {
	ctx, cancel := context.WithTimeout(ctx, gitTimeout)
	defer cancel()
	_, err := runStdin(ctx, cwd, patch, "apply", "--reverse", "-")
	return err
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./pkg/gitinfo/ -run 'Revert' -v`
Expected: PASS (all four).

- [ ] **Step 5: Commit**

```bash
git add pkg/gitinfo/gitinfo.go pkg/gitinfo/gitinfo_test.go
git commit -m "feat(gitinfo): RevertFile + RevertHunk for diff-review apply"
```

---

## Task 2: Backend — wire `GitRevertCommand` through wshrpc

**Files:**
- Modify: `pkg/wshrpc/wshrpctypes.go` (interface line ~98; data types after line 660)
- Modify: `pkg/wshrpc/wshserver/wshserver.go` (after `GitDiffCommand`, line ~1487)
- Regenerated: `pkg/wshrpc/wshclient/wshclient.go`, `frontend/app/store/wshclientapi.ts`, `frontend/types/gotypes.d.ts`

- [ ] **Step 1: Declare the command on the interface**

In `pkg/wshrpc/wshrpctypes.go`, after line 98 (`GitDiffCommand...`), add:

```go
	GitRevertCommand(ctx context.Context, data CommandGitRevertData) error
```

- [ ] **Step 2: Add the data type**

In `pkg/wshrpc/wshrpctypes.go`, after `CommandGitDiffRtnData` (line 660), add:

```go
type CommandGitRevertData struct {
	Cwd    string `json:"cwd"`
	Path   string `json:"path"`
	Status string `json:"status"`          // porcelain status; used for whole-file revert
	Patch  string `json:"patch,omitempty"` // if set, reverse-apply this patch; else whole-file
}
```

- [ ] **Step 3: Implement the command**

In `pkg/wshrpc/wshserver/wshserver.go`, after `GitDiffCommand` (ends line 1487), add:

```go
func (ws *WshServer) GitRevertCommand(ctx context.Context, data wshrpc.CommandGitRevertData) error {
	if data.Patch != "" {
		return gitinfo.RevertHunk(ctx, data.Cwd, data.Path, data.Patch)
	}
	return gitinfo.RevertFile(ctx, data.Cwd, data.Path, data.Status)
}
```

(`gitinfo` is already imported in this file — it backs `GitChangesCommand`.)

- [ ] **Step 4: Regenerate bindings and build**

Run: `task generate && go build ./...`
Expected: no errors; `GitRevertCommand` now present in `wshclient.go` and `wshclientapi.ts`. Verify:

Run: `grep -c GitRevertCommand frontend/app/store/wshclientapi.ts`
Expected: `1` (or more).

- [ ] **Step 5: Commit**

```bash
git add pkg/wshrpc/wshrpctypes.go pkg/wshrpc/wshserver/wshserver.go pkg/wshrpc/wshclient/wshclient.go frontend/app/store/wshclientapi.ts frontend/types/gotypes.d.ts
git commit -m "feat(wshrpc): GitRevertCommand (file + hunk revert)"
```

---

## Task 3: Frontend — reconstructable per-hunk patches in `gitdiff.ts`

**Files:**
- Modify: `frontend/app/view/agents/gitdiff.ts`
- Test: `frontend/app/view/agents/gitdiff.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `frontend/app/view/agents/gitdiff.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseUnifiedDiff } from "./gitdiff";

const TWO_HUNK = `diff --git a/a.txt b/a.txt
index 111..222 100644
--- a/a.txt
+++ b/a.txt
@@ -1,3 +1,3 @@
 l1
-l2
+X2
 l3
@@ -8,3 +8,3 @@
 l8
-l9
+X9
 l10
`;

describe("parseUnifiedDiff hunks", () => {
    it("splits into two hunks with counts", () => {
        const v = parseUnifiedDiff(TWO_HUNK);
        expect(v.hunks).toHaveLength(2);
        expect(v.hunks[0].adds).toBe(1);
        expect(v.hunks[0].dels).toBe(1);
    });

    it("each hunk patch = diff header + its own block, prefixes intact", () => {
        const v = parseUnifiedDiff(TWO_HUNK);
        const p0 = v.diffHeader + v.hunks[0].body;
        expect(p0).toContain("--- a/a.txt");
        expect(p0).toContain("+++ b/a.txt");
        expect(p0).toContain("@@ -1,3 +1,3 @@");
        expect(p0).toContain("-l2");
        expect(p0).toContain("+X2");
        expect(p0).not.toContain("X9"); // only the first hunk
        expect(p0.endsWith("\n")).toBe(true); // git apply needs a trailing newline
    });

    it("combined patch = header + selected bodies", () => {
        const v = parseUnifiedDiff(TWO_HUNK);
        const combined = v.diffHeader + v.hunks.map((h) => h.body).join("");
        expect(combined).toContain("+X2");
        expect(combined).toContain("+X9");
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run frontend/app/view/agents/gitdiff.test.ts`
Expected: FAIL — `v.hunks` is undefined / `diffHeader` missing.

- [ ] **Step 3: Extend `parseUnifiedDiff`**

In `frontend/app/view/agents/gitdiff.ts`, add the `Hunk` type and extend `FileView`, then populate both in the parse loop. Replace the existing `FileView` interface and `parseUnifiedDiff` with:

```ts
export interface Hunk {
    id: string;
    header: string; // the "@@ ... @@" line
    adds: number;
    dels: number;
    body: string; // raw "@@" block incl. trailing newline — appended to diffHeader to form a patch
}

export interface FileView {
    isDiff: boolean;
    lines: DiffLine[];
    adds: number;
    dels: number;
    hunkLabel: string;
    diffHeader: string; // raw diff/index/---/+++ lines before the first hunk (patch prefix)
    hunks: Hunk[];
}

export function parseUnifiedDiff(diff: string): FileView {
    const lines: DiffLine[] = [];
    let oldN = 0;
    let newN = 0;
    let adds = 0;
    let dels = 0;
    let hunkLabel = "";
    // raw patch reconstruction (parallel to the render model, off the untouched raw text)
    const headerLines: string[] = [];
    const hunks: Hunk[] = [];
    let cur: Hunk | null = null;
    let sawHunk = false;

    for (const raw of diff.split("\n")) {
        // --- raw patch bookkeeping (keeps prefixes/headers, unlike the render model below) ---
        if (raw.startsWith("@@")) {
            cur = { id: `h${hunks.length}`, header: raw, adds: 0, dels: 0, body: raw + "\n" };
            hunks.push(cur);
            sawHunk = true;
        } else if (!sawHunk) {
            if (raw !== "") headerLines.push(raw);
        } else if (cur) {
            cur.body += raw + "\n";
            if (raw.startsWith("+")) cur.adds++;
            else if (raw.startsWith("-")) cur.dels++;
        }

        // --- render model (unchanged from before) ---
        if (HEADER_PREFIXES.some((p) => raw.startsWith(p))) {
            continue;
        }
        if (raw.startsWith("@@")) {
            const m = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
            if (m) {
                oldN = parseInt(m[1], 10);
                newN = parseInt(m[2], 10);
                if (!hunkLabel) {
                    hunkLabel = raw;
                }
            }
            lines.push({ gOld: "", gNew: "", sign: "", text: raw, kind: "hunk" });
            continue;
        }
        if (raw.startsWith("\\")) {
            continue;
        }
        if (raw.startsWith("+")) {
            lines.push({ gOld: "", gNew: String(newN), sign: "+", text: raw.slice(1), kind: "add" });
            newN++;
            adds++;
            continue;
        }
        if (raw.startsWith("-")) {
            lines.push({ gOld: String(oldN), gNew: "", sign: "−", text: raw.slice(1), kind: "del" });
            oldN++;
            dels++;
            continue;
        }
        lines.push({ gOld: String(oldN), gNew: String(newN), sign: "", text: raw.startsWith(" ") ? raw.slice(1) : raw, kind: "ctx" });
        oldN++;
        newN++;
    }
    const diffHeader = headerLines.length ? headerLines.join("\n") + "\n" : "";
    return { isDiff: true, lines, adds, dels, hunkLabel, diffHeader, hunks };
}
```

Also update `plainFileView` (untracked) to satisfy the new fields — add `diffHeader: "", hunks: []` to its return object.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run frontend/app/view/agents/gitdiff.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Typecheck (the render consumers still compile)**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: no NEW errors (baseline has ~3 pre-existing in `frontend/tauri/api.test.ts`).

- [ ] **Step 6: Commit**

```bash
git add frontend/app/view/agents/gitdiff.ts frontend/app/view/agents/gitdiff.test.ts
git commit -m "feat(gitdiff): expose reconstructable per-hunk patches"
```

---

## Task 4: Frontend — review decision model (`reviewstore.ts`), no apply yet

**Files:**
- Create: `frontend/app/view/agents/reviewstore.ts`
- Test: `frontend/app/view/agents/reviewstore.test.ts`

The decision logic is pure and lives in exported functions so it can be unit-tested without React or RPC. `apply()` (the RPC batch) is Task 5.

- [ ] **Step 1: Write the failing test**

Create `frontend/app/view/agents/reviewstore.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { fileDecision, hunkKey, progressOf, rejectedPatchPlan, type ReviewFile } from "./reviewstore";

const files: ReviewFile[] = [
    {
        path: "src/a.ts", status: " M", isNew: false, adds: 2, dels: 1, diffHeader: "H-A\n",
        hunks: [
            { id: "h0", header: "@@1@@", adds: 1, dels: 0, body: "B0\n" },
            { id: "h1", header: "@@2@@", adds: 1, dels: 1, body: "B1\n" },
        ],
    },
    {
        path: "new.ts", status: "??", isNew: true, adds: 3, dels: 0, diffHeader: "",
        hunks: [{ id: "file", header: "@@ new @@", adds: 3, dels: 0, body: "" }],
    },
];

describe("review decision model", () => {
    it("fileDecision derives accept/reject/partial/pending", () => {
        expect(fileDecision(files[0], {})).toBe("pending");
        expect(fileDecision(files[0], { [hunkKey("src/a.ts", "h0")]: "accept" })).toBe("partial");
        const both = { [hunkKey("src/a.ts", "h0")]: "accept", [hunkKey("src/a.ts", "h1")]: "accept" } as const;
        expect(fileDecision(files[0], both)).toBe("accept");
        const rej = { [hunkKey("src/a.ts", "h0")]: "reject", [hunkKey("src/a.ts", "h1")]: "reject" } as const;
        expect(fileDecision(files[0], rej)).toBe("reject");
    });

    it("progressOf counts across all hunks", () => {
        const d = { [hunkKey("src/a.ts", "h0")]: "accept", [hunkKey("new.ts", "file")]: "reject" } as const;
        const p = progressOf(files, d);
        expect(p.total).toBe(3);
        expect(p.accepted).toBe(1);
        expect(p.rejected).toBe(1);
        expect(p.pending).toBe(1);
    });

    it("rejectedPatchPlan: whole-file for all-rejected/untracked, patch for partial", () => {
        const d = {
            [hunkKey("src/a.ts", "h0")]: "reject", // partial (h1 accepted)
            [hunkKey("src/a.ts", "h1")]: "accept",
            [hunkKey("new.ts", "file")]: "reject", // untracked whole-file
        } as const;
        const plan = rejectedPatchPlan(files, d);
        const a = plan.find((x) => x.path === "src/a.ts")!;
        expect(a.patch).toBe("H-A\nB0\n"); // header + only the rejected hunk
        expect(a.status).toBe(" M");
        const n = plan.find((x) => x.path === "new.ts")!;
        expect(n.patch).toBe(""); // whole-file discard
    });

    it("rejectedPatchPlan: all hunks rejected -> whole-file (empty patch)", () => {
        const d = {
            [hunkKey("src/a.ts", "h0")]: "reject",
            [hunkKey("src/a.ts", "h1")]: "reject",
        } as const;
        const plan = rejectedPatchPlan(files, d);
        expect(plan.find((x) => x.path === "src/a.ts")!.patch).toBe("");
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run frontend/app/view/agents/reviewstore.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the pure model + atoms**

Create `frontend/app/view/agents/reviewstore.ts`:

```ts
// frontend/app/view/agents/reviewstore.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Staged Accept/Reject review state for the Files "Review" mode. Decisions are pure frontend
// state (nothing touches the tree until apply()), so undo is free. Pure derivations are exported
// for unit testing; atoms + apply() live alongside.

import { globalStore } from "@/app/store/jotaiStore";
import { atom, type PrimitiveAtom } from "jotai";
import type { Hunk } from "./gitdiff";

export type Decision = "accept" | "reject";
export type FileVerdict = "accept" | "reject" | "partial" | "pending";

export interface ReviewFile {
    path: string;
    status: string; // porcelain status, e.g. " M", "??", "A "
    isNew: boolean;
    adds: number;
    dels: number;
    diffHeader: string;
    hunks: Hunk[];
}

export interface ReviewModel {
    cwd: string;
    files: ReviewFile[];
}

export type Decisions = Record<string, Decision>;

export function hunkKey(path: string, hunkId: string): string {
    return path + ":" + hunkId;
}

export function fileDecision(f: ReviewFile, d: Decisions): FileVerdict {
    const ds = f.hunks.map((h) => d[hunkKey(f.path, h.id)] ?? null);
    if (ds.every((x) => x === "accept")) return "accept";
    if (ds.every((x) => x === "reject")) return "reject";
    if (ds.every((x) => x === null)) return "pending";
    return "partial";
}

export interface Progress {
    total: number;
    accepted: number;
    rejected: number;
    reviewed: number;
    pending: number;
}

export function progressOf(files: ReviewFile[], d: Decisions): Progress {
    let total = 0, accepted = 0, rejected = 0;
    for (const f of files) {
        for (const h of f.hunks) {
            total++;
            const v = d[hunkKey(f.path, h.id)];
            if (v === "accept") accepted++;
            else if (v === "reject") rejected++;
        }
    }
    const reviewed = accepted + rejected;
    return { total, accepted, rejected, reviewed, pending: total - reviewed };
}

export interface RevertOp {
    path: string;
    status: string;
    patch: string; // "" => whole-file revert; else reverse-apply this patch
}

// Groups rejected hunks per file into backend revert ops. Untracked or fully-rejected tracked
// files -> whole-file (empty patch); partially-rejected tracked files -> a combined patch of just
// the rejected hunks (header + their bodies).
export function rejectedPatchPlan(files: ReviewFile[], d: Decisions): RevertOp[] {
    const ops: RevertOp[] = [];
    for (const f of files) {
        const rejected = f.hunks.filter((h) => d[hunkKey(f.path, h.id)] === "reject");
        if (rejected.length === 0) continue;
        const allRejected = rejected.length === f.hunks.length;
        if (f.isNew || allRejected) {
            ops.push({ path: f.path, status: f.status, patch: "" });
        } else {
            ops.push({ path: f.path, status: f.status, patch: f.diffHeader + rejected.map((h) => h.body).join("") });
        }
    }
    return ops;
}

// --- atoms (UI state) ---
export const reviewModelAtom = atom<ReviewModel | null>(null) as PrimitiveAtom<ReviewModel | null>;
export const decisionsAtom = atom<Decisions>({}) as PrimitiveAtom<Decisions>;
export const historyAtom = atom<string[]>([]) as PrimitiveAtom<string[]>;
export const reviewSelectedAtom = atom<string | null>(null) as PrimitiveAtom<string | null>;
export const appliedAtom = atom<{ accepted: number; rejected: number; failures: string[] } | null>(
    null
) as PrimitiveAtom<{ accepted: number; rejected: number; failures: string[] } | null>;

export function decide(key: string, val: Decision): void {
    globalStore.set(decisionsAtom, { ...globalStore.get(decisionsAtom), [key]: val });
    globalStore.set(historyAtom, [...globalStore.get(historyAtom), key]);
}

export function decideMany(keys: string[], val: Decision): void {
    const d = { ...globalStore.get(decisionsAtom) };
    const h = globalStore.get(historyAtom).slice();
    for (const k of keys) {
        if (!d[k]) h.push(k);
        d[k] = val;
    }
    globalStore.set(decisionsAtom, d);
    globalStore.set(historyAtom, h);
}

export function undoKey(key: string): void {
    const d = { ...globalStore.get(decisionsAtom) };
    delete d[key];
    globalStore.set(decisionsAtom, d);
    globalStore.set(historyAtom, globalStore.get(historyAtom).filter((x) => x !== key));
}

export function undoFile(f: ReviewFile): void {
    const keys = f.hunks.map((h) => hunkKey(f.path, h.id));
    const d = { ...globalStore.get(decisionsAtom) };
    keys.forEach((k) => delete d[k]);
    globalStore.set(decisionsAtom, d);
    globalStore.set(historyAtom, globalStore.get(historyAtom).filter((x) => !keys.includes(x)));
}

export function undoLast(): void {
    const h = globalStore.get(historyAtom).slice();
    const k = h.pop();
    if (!k) return;
    const d = { ...globalStore.get(decisionsAtom) };
    if (!h.includes(k)) delete d[k];
    globalStore.set(decisionsAtom, d);
    globalStore.set(historyAtom, h);
}

export function resetReview(): void {
    globalStore.set(decisionsAtom, {});
    globalStore.set(historyAtom, []);
    globalStore.set(appliedAtom, null);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run frontend/app/view/agents/reviewstore.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/app/view/agents/reviewstore.ts frontend/app/view/agents/reviewstore.test.ts
git commit -m "feat(review): staged decision model + revert-op planning"
```

---

## Task 5: Frontend — load the review model + `apply()` batch

**Files:**
- Modify: `frontend/app/view/agents/reviewstore.ts`
- Modify: `frontend/app/view/agents/reviewstore.test.ts` (add apply grouping assertion via the pure plan; the RPC loop itself is exercised in-app)

`apply()` reverts each rejected op via `GitRevertCommand`, collects failures, and asks the Files store to reload. Loading the model fetches every changed file's diff up front (bounded per worktree) so progress + apply see all hunks.

- [ ] **Step 1: Add the loader + apply to `reviewstore.ts`**

Append to `frontend/app/view/agents/reviewstore.ts`:

```ts
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { parseUnifiedDiff } from "./gitdiff";
import { parseGitChanges } from "./gitstatus";
import { loadChangesForCwd } from "./filesstore";

const loadGuard = { token: "" };

// Build the full review model for a worktree: changes + every file's diff (so all hunks are known
// for progress + apply). Untracked files become one synthetic whole-file hunk (id "file").
export async function loadReview(cwd: string | null): Promise<void> {
    const token = cwd ?? "";
    loadGuard.token = token;
    globalStore.set(reviewModelAtom, null);
    resetReview();
    if (!cwd) return;
    const ch = await RpcApi.GitChangesCommand(TabRpcClient, { cwd });
    if (loadGuard.token !== token || !ch.isrepo) {
        if (loadGuard.token === token) globalStore.set(reviewModelAtom, { cwd, files: [] });
        return;
    }
    const changes = parseGitChanges(ch.statusz, ch.numstat);
    const files: ReviewFile[] = [];
    for (const c of changes.files) {
        const d = await RpcApi.GitDiffCommand(TabRpcClient, { cwd, path: c.path });
        if (loadGuard.token !== token) return;
        if (d.untracked) {
            files.push({
                path: c.path, status: c.status, isNew: true,
                adds: d.content.split("\n").length, dels: 0, diffHeader: "",
                hunks: [{ id: "file", header: "@@ new file @@", adds: 0, dels: 0, body: "" }],
            });
        } else {
            const v = parseUnifiedDiff(d.diff);
            files.push({
                path: c.path, status: c.status, isNew: false,
                adds: v.adds, dels: v.dels, diffHeader: v.diffHeader, hunks: v.hunks,
            });
        }
    }
    if (loadGuard.token !== token) return;
    globalStore.set(reviewModelAtom, { cwd, files });
    globalStore.set(reviewSelectedAtom, files[0]?.path ?? null);
}

// Apply: reverse every rejected op; accepted changes are left in the tree. Collects per-file
// failures (stale patch etc.) without aborting the batch, then reloads Files state to reflect
// reality and shows the applied summary.
export async function applyReview(): Promise<void> {
    const model = globalStore.get(reviewModelAtom);
    if (!model) return;
    const d = globalStore.get(decisionsAtom);
    const prog = progressOf(model.files, d);
    if (prog.pending > 0) return; // gated
    const ops = rejectedPatchPlan(model.files, d);
    const failures: string[] = [];
    for (const op of ops) {
        try {
            await RpcApi.GitRevertCommand(TabRpcClient, { cwd: model.cwd, path: op.path, status: op.status, patch: op.patch });
        } catch {
            failures.push(op.path);
        }
    }
    globalStore.set(appliedAtom, { accepted: prog.accepted, rejected: prog.rejected, failures });
    void loadChangesForCwd(`review-apply:${model.cwd}`, model.cwd); // refresh Browse-mode state
}
```

- [ ] **Step 2: Export `loadChangesForCwd` from `filesstore.ts`**

In `frontend/app/view/agents/filesstore.ts` line 36, change `async function loadChangesForCwd` to `export async function loadChangesForCwd`.

- [ ] **Step 3: Verify existing tests still pass + typecheck**

Run: `npx vitest run frontend/app/view/agents/reviewstore.test.ts && node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: reviewstore tests PASS; no new tsc errors.

- [ ] **Step 4: Commit**

```bash
git add frontend/app/view/agents/reviewstore.ts frontend/app/view/agents/filesstore.ts
git commit -m "feat(review): load full review model + batched apply"
```

---

## Task 6: Frontend — `reviewsurface.tsx` (ported design)

**Files:**
- Create: `frontend/app/view/agents/reviewsurface.tsx`

Port the approved `Wave-diff-review.dc.html` right/left panes to React, file-grouped (no tasks). Presentational: reads `reviewstore` atoms, calls its actions. Colors use `@theme` tokens (map: adds/accept→`success`, dels/reject→`error`, partial→`warning`, greys→`ink-*`/`surface`/`border`). No unit test (logic is in `reviewstore`); verified visually in Task 8.

**Before writing:** re-read the "Design reference" block in the plan header for the source design and the four intentional deviations. If you have DesignSync access, `get_file` the design to match spacing/hierarchy; otherwise the code below is authoritative.

- [ ] **Step 1: Create the component**

Create `frontend/app/view/agents/reviewsurface.tsx`. Structure (full code — match existing Tailwind idioms in `filessurface.tsx`):

```tsx
// frontend/app/view/agents/reviewsurface.tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Files "Review" mode: file-grouped staged Accept/Reject over a worktree's uncommitted changes,
// applied in a batch (rejected changes reverted). Ported from Wave-diff-review.dc.html; task
// grouping is v2. State + logic live in reviewstore.ts.

import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect } from "react";
import { parseUnifiedDiff } from "./gitdiff";
import {
    appliedAtom, decide, decideMany, decisionsAtom, fileDecision, hunkKey, progressOf,
    resetReview, reviewModelAtom, reviewSelectedAtom, undoFile, undoKey, undoLast,
    applyReview, type Decisions, type ReviewFile,
} from "./reviewstore";
import { globalStore } from "@/app/store/jotaiStore";

function pendingKeysOf(files: ReviewFile[], d: Decisions): string[] {
    const out: string[] = [];
    for (const f of files) for (const h of f.hunks) { const k = hunkKey(f.path, h.id); if (!d[k]) out.push(k); }
    return out;
}

export function ReviewSurface() {
    const model = useAtomValue(reviewModelAtom);
    const d = useAtomValue(decisionsAtom);
    const selected = useAtomValue(reviewSelectedAtom);
    const applied = useAtomValue(appliedAtom);

    // keyboard triage: A accept / R reject next pending in selected file, U undo, arrows move file
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (!model || applied) return;
            const k = e.key.toLowerCase();
            const sel = model.files.find((f) => f.path === selected) ?? model.files[0];
            const nextPending = sel?.hunks.map((h) => hunkKey(sel.path, h.id)).find((kk) => !d[kk]);
            if (k === "a" && nextPending) { e.preventDefault(); decide(nextPending, "accept"); }
            else if (k === "r" && nextPending) { e.preventDefault(); decide(nextPending, "reject"); }
            else if (k === "u") { e.preventDefault(); undoLast(); }
            else if (e.key === "ArrowDown" || k === "j") { e.preventDefault(); moveSel(model.files, selected, 1); }
            else if (e.key === "ArrowUp" || k === "k") { e.preventDefault(); moveSel(model.files, selected, -1); }
            else if (e.key === "Enter" && pendingKeysOf(model.files, d).length === 0) { e.preventDefault(); void applyReview(); }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [model, d, selected, applied]);

    if (!model) return <div className="flex h-full items-center justify-center text-[13px] text-ink-mid">Loading…</div>;
    if (model.files.length === 0) return <div className="flex h-full items-center justify-center text-[13px] text-ink-mid">No changes to review</div>;

    const prog = progressOf(model.files, d);
    const acceptPct = prog.total ? (prog.accepted / prog.total) * 100 : 0;
    const rejectPct = prog.total ? (prog.rejected / prog.total) * 100 : 0;
    const done = prog.pending === 0;

    if (applied) {
        return (
            <div className="flex h-full flex-col items-center justify-center gap-[16px] p-[30px]">
                <div className="text-[18px] font-bold text-foreground">Review applied</div>
                <div className="font-mono text-[13px] text-ink-mid">
                    Kept {applied.accepted} · discarded {applied.rejected}
                    {applied.failures.length > 0 && <span className="text-error"> · {applied.failures.length} failed</span>}
                </div>
                <button onClick={resetReview} className="rounded-[9px] border border-border px-[15px] py-[8px] text-[12px] text-ink-mid hover:text-foreground">
                    Reopen review
                </button>
            </div>
        );
    }

    const sel = model.files.find((f) => f.path === selected) ?? model.files[0];

    return (
        <div className="flex h-full min-h-0">
            {/* left: file list with per-file review progress */}
            <div className="flex w-[300px] flex-none flex-col border-r border-border bg-surface">
                <div className="flex-none border-b border-edge-faint p-[13px]">
                    <div className="mb-[8px] flex items-baseline justify-between font-mono text-[11px]">
                        <span className="text-ink-faint">{model.files.length} files</span>
                        <span className="text-ink-mid">{prog.reviewed}/{prog.total} reviewed</span>
                    </div>
                    <div className="flex h-[6px] overflow-hidden rounded-[4px] bg-surface-hover">
                        <div className="h-full bg-success" style={{ width: `${acceptPct}%` }} />
                        <div className="h-full bg-error" style={{ width: `${rejectPct}%` }} />
                    </div>
                </div>
                <div className="flex-1 overflow-y-auto p-[8px]">
                    {model.files.map((f) => {
                        const verdict = fileDecision(f, d);
                        const dec = f.hunks.filter((h) => d[hunkKey(f.path, h.id)]).length;
                        const ring = verdict === "accept" ? "text-success" : verdict === "reject" ? "text-error" : verdict === "partial" ? "text-warning" : "text-ink-faint";
                        return (
                            <button key={f.path} onClick={() => globalStore.set(reviewSelectedAtom, f.path)}
                                className={cn("flex w-full items-center gap-[8px] rounded-[8px] px-[9px] py-[7px] text-left hover:bg-surface-hover",
                                    f.path === sel.path && "bg-surface-hover")}>
                                <span className={cn("font-mono text-[11px]", ring)}>●</span>
                                <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink-mid">{f.path}</span>
                                <span className="flex-none font-mono text-[10px] text-ink-faint">{dec}/{f.hunks.length}</span>
                            </button>
                        );
                    })}
                </div>
            </div>

            {/* right: selected file's hunks + footer */}
            <div className="flex min-w-0 flex-1 flex-col bg-transparent">
                <FileHeader f={sel} d={d} />
                <div className="flex-1 overflow-auto p-[16px_20px_26px]">
                    {sel.hunks.map((h) => <HunkBlock key={h.id} f={sel} h={h} d={d} />)}
                </div>
                <div className="flex flex-none items-center gap-[14px] border-t border-border bg-surface px-[22px] py-[12px]">
                    <div className="flex items-center gap-[12px] font-mono text-[11px]">
                        <span className="text-ink-mid">{prog.reviewed}/{prog.total} reviewed</span>
                        <span className="text-success">{prog.accepted} keep</span>
                        <span className="text-error">{prog.rejected} discard</span>
                        <span className="text-ink-faint">{prog.pending} left</span>
                    </div>
                    <div className="flex-1" />
                    {prog.reviewed > 0 && <button onClick={resetReview} className="text-ink-faint hover:text-ink-mid font-[600] text-[12px]">Reset</button>}
                    {prog.pending > 0 && (
                        <button onClick={() => decideMany(pendingKeysOf(model.files, d), "accept")}
                            className="rounded-[9px] border border-border px-[15px] py-[9px] text-[12.5px] font-[600] text-ink-mid hover:text-foreground">
                            Accept all remaining
                        </button>
                    )}
                    <button onClick={() => void applyReview()} disabled={!done}
                        className={cn("flex items-center gap-[7px] rounded-[9px] px-[17px] py-[9px] text-[12.5px] font-bold",
                            done ? "bg-success text-black" : "cursor-not-allowed bg-surface text-ink-faint opacity-70")}>
                        {done ? `Apply review · keep ${prog.accepted}` : `${prog.pending} change${prog.pending === 1 ? "" : "s"} left to review`} →
                    </button>
                </div>
            </div>
        </div>
    );
}

function moveSel(files: ReviewFile[], selected: string | null, dir: number) {
    const i = files.findIndex((f) => f.path === selected);
    const ni = Math.max(0, Math.min(files.length - 1, (i < 0 ? 0 : i) + dir));
    globalStore.set(reviewSelectedAtom, files[ni].path);
}

function FileHeader({ f, d }: { f: ReviewFile; d: Decisions }) {
    const verdict = fileDecision(f, d);
    const fkeys = f.hunks.map((h) => hunkKey(f.path, h.id));
    const glyph = f.isNew ? "A" : "M";
    return (
        <div className="flex flex-none items-center gap-[10px] border-b border-border bg-surface px-[20px] py-[13px]">
            <span className={cn("flex h-[18px] w-[18px] flex-none items-center justify-center rounded-[5px] font-mono text-[10px] font-bold",
                f.isNew ? "bg-success/15 text-success" : "bg-warning/15 text-warning")}>{glyph}</span>
            <span className="min-w-0 truncate font-mono text-[12.5px] font-semibold">{f.path}</span>
            <span className="flex-none font-mono text-[10px] font-bold text-success">+{f.adds}</span>
            <span className="flex-none font-mono text-[10px] font-bold text-error">−{f.dels}</span>
            <div className="flex-1" />
            {verdict === "accept" || verdict === "reject" ? (
                <>
                    <span className={cn("font-mono text-[11px] font-[600]", verdict === "accept" ? "text-success" : "text-error")}>
                        {verdict === "accept" ? "✓ File kept" : "✕ File discarded"}
                    </span>
                    <button onClick={() => undoFile(f)} className="text-ink-faint hover:text-ink-mid text-[11px] underline">Undo</button>
                </>
            ) : (
                <>
                    <button onClick={() => decideMany(fkeys, "reject")}
                        className="rounded-[7px] border border-border px-[10px] py-[4px] text-[11px] font-[600] text-ink-mid hover:border-error hover:text-error">Reject file</button>
                    <button onClick={() => decideMany(fkeys, "accept")}
                        className="rounded-[7px] border border-border px-[10px] py-[4px] text-[11px] font-[600] text-ink-mid hover:border-success hover:text-success">Accept file</button>
                </>
            )}
        </div>
    );
}

function HunkBlock({ f, h, d }: { f: ReviewFile; h: ReviewFile["hunks"][number]; d: Decisions }) {
    const key = hunkKey(f.path, h.id);
    const dec = d[key] ?? null;
    const rail = dec === "accept" ? "border-l-success" : dec === "reject" ? "border-l-error" : "border-l-transparent";
    const view = f.isNew ? null : parseUnifiedDiff(f.diffHeader + h.body);
    return (
        <div className={cn("mb-[10px] overflow-hidden rounded-[8px] border border-border border-l-2", rail)} style={{ opacity: dec === "reject" ? 0.5 : 1 }}>
            <div className="flex items-center gap-[10px] border-b border-edge-faint bg-surface px-[13px] py-[7px]">
                <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-faint">{h.header}</span>
                <span className="flex-none font-mono text-[10px] font-bold text-success">+{h.adds}</span>
                <span className="flex-none font-mono text-[10px] font-bold text-error">−{h.dels}</span>
                {dec === null ? (
                    <>
                        <button onClick={() => decide(key, "reject")} className="rounded-[6px] border border-border px-[9px] py-[3px] text-[10.5px] font-[600] text-ink-mid hover:border-error hover:text-error">Reject</button>
                        <button onClick={() => decide(key, "accept")} className="rounded-[6px] border border-border px-[9px] py-[3px] text-[10.5px] font-[600] text-ink-mid hover:border-success hover:text-success">Accept</button>
                    </>
                ) : (
                    <>
                        <span className={cn("font-mono text-[10px] font-bold", dec === "accept" ? "text-success" : "text-error")}>{dec === "accept" ? "✓ Keep" : "✕ Discard"}</span>
                        <button onClick={() => undoKey(key)} className="text-ink-faint hover:text-ink-mid text-[10.5px] underline">Undo</button>
                    </>
                )}
            </div>
            {view && (
                <div className="overflow-x-auto py-[6px] font-mono text-[12px] leading-[1.7]">
                    {view.lines.filter((l) => l.kind !== "hunk").map((l, i) => (
                        <div key={i} className="flex min-w-max"
                            style={{ background: l.kind === "add" ? "color-mix(in srgb, var(--color-success) 10%, transparent)" : l.kind === "del" ? "color-mix(in srgb, var(--color-error) 10%, transparent)" : undefined }}>
                            <span className="w-[42px] flex-none select-none px-[8px] text-right text-ink-faint">{l.gOld}</span>
                            <span className="w-[42px] flex-none select-none px-[8px] text-right text-ink-faint">{l.gNew}</span>
                            <span className={cn("w-[16px] flex-none text-center", l.kind === "add" ? "text-success" : l.kind === "del" ? "text-error" : "text-foreground")}>{l.sign}</span>
                            <span className={cn("whitespace-pre pr-[28px]", l.kind === "add" ? "text-success" : l.kind === "del" ? "text-error" : "text-foreground")}>{l.text}</span>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
```

- [ ] **Step 2: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add frontend/app/view/agents/reviewsurface.tsx
git commit -m "feat(review): Review-mode surface (file-grouped staged accept/reject)"
```

---

## Task 7: Frontend — Browse ⇄ Review toggle in `filessurface.tsx`

**Files:**
- Modify: `frontend/app/view/agents/filessurface.tsx`

- [ ] **Step 1: Add mode state + toggle + conditional body**

In `frontend/app/view/agents/filessurface.tsx`:

1. Add imports at the top with the other local imports:

```tsx
import { ReviewSurface } from "./reviewsurface";
import { loadReview } from "./reviewstore";
```

2. In `FilesSurface`, add mode state after the existing `useState` (near line 222):

```tsx
    const [mode, setMode] = useState<"browse" | "review">("browse");
```

3. When mode is "review", (re)load the review model for the current cwd. Add after the existing load `useEffect` (near line 244):

```tsx
    useEffect(() => {
        if (mode === "review" && state?.cwd) {
            void loadReview(state.cwd);
        }
    }, [mode, state?.cwd]);
```

4. Replace the "read-only" label in the header (line 258) with a Browse/Review toggle:

```tsx
                        <div className="ml-auto flex gap-[2px] rounded-[7px] border border-border p-[2px]">
                            <button onClick={() => setMode("browse")}
                                className={cn("rounded-[5px] px-[9px] py-[3px] text-[11px] font-[600]", mode === "browse" ? "bg-surface-hover text-foreground" : "text-ink-mid")}>Browse</button>
                            <button onClick={() => setMode("review")}
                                className={cn("rounded-[5px] px-[9px] py-[3px] text-[11px] font-[600]", mode === "review" ? "bg-surface-hover text-foreground" : "text-ink-mid")}>Review</button>
                        </div>
```

(Remove the old `<span ...>read-only</span>` on line 258; keep the `<h1>Files</h1>`.)

5. Replace the center pane (line 298-300) so Review mode renders `ReviewSurface`:

```tsx
            <div className="flex min-w-0 flex-1 flex-col">
                {mode === "review" ? <ReviewSurface /> : <CenterPane path={selected} view={diff} cwd={state?.cwd ?? null} />}
            </div>
```

- [ ] **Step 2: Typecheck + full frontend test run**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit && npx vitest run frontend/app/view/agents/`
Expected: no new tsc errors; all agents-tab tests pass (including the new `gitdiff` + `reviewstore` files).

- [ ] **Step 3: Commit**

```bash
git add frontend/app/view/agents/filessurface.tsx
git commit -m "feat(files): Browse/Review mode toggle"
```

---

## Task 8: Verification — build, tests, live CDP

**Files:** none (verification only)

- [ ] **Step 1: Backend build + all Go tests**

Run: `go build ./... && go test ./pkg/gitinfo/`
Expected: build clean; gitinfo tests PASS.

- [ ] **Step 2: Frontend typecheck + tests + prod build**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit && npx vitest run && npm run build`
Expected: no new tsc errors; vitest all green; vite/tauri build succeeds.

- [ ] **Step 3: Live visual verification (CDP)**

Follow `CLAUDE.md` → "Visual verification (dev)". With `task dev` running (use `tail -f /dev/null | task dev` for a headless bg run so wavesrv doesn't get an EOF): open the Files surface, pick a project/agent worktree with real uncommitted changes, click **Review**, then verify: file list shows per-file progress; hunk Accept/Reject decisions toggle the ring + chip; Undo restores pending; the Apply button gates until nothing is pending; clicking **Apply** reverts only the rejected hunks/files in the working tree (confirm with `git status` in that worktree) and shows the "Review applied" summary.

Run: `node scripts/cdp-shot.mjs review-mode.png`
Expected: a screenshot of the populated Review mode. **Compare against the source design** (`Wave-diff-review.dc.html`, fetched via DesignSync in the main session) — confirm the layout, spacing, and interaction match, allowing for the four intentional deviations in the plan header (file list vs tasks, no walkthrough, `@theme` colors, no standalone titlebar). Attach for review.

- [ ] **Step 4: Final commit (spec + plan fold in per the repo git rule)**

```bash
git add docs/superpowers/specs/2026-07-02-files-review-mode-design.md docs/superpowers/plans/2026-07-02-files-review-mode.md
git commit -m "docs(review): Files review-mode spec + plan"
```

(Per `CLAUDE.md`, spec/plan docs fold into the feature work — if executing task-by-task, prefer adding these docs to Task 1's commit rather than a standalone docs commit.)

---

## Self-review notes

- **Spec coverage:** placement toggle (T7), decision model + undo (T4), Apply batch + failure reporting (T5), backend revert file/hunk (T1-2), lossy-parse fix via raw-diff patches (T3), theme tokens (T6), tests at all three layers (T1/T3/T4). Untracked whole-file path covered (T4 plan + T5 loader + T1 clean). ✓
- **Type consistency:** `hunkKey`, `Decision`, `ReviewFile`, `RevertOp`, `rejectedPatchPlan`, `progressOf`, `fileDecision` defined in T4 and consumed unchanged in T5/T6. `Hunk`/`FileView.diffHeader` defined in T3, consumed in T4/T5/T6. `GitRevertCommand`/`CommandGitRevertData` defined T2, consumed T5. ✓
- **Known approximation:** hunk revert applies to the working tree (`git apply --reverse`), matching the worktree-vs-HEAD diff shown; index-staged edge cases are not specially handled (documented in spec).
