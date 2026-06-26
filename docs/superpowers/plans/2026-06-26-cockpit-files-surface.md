# Files Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the cockpit **Files** surface — a read-only, changed-files-only view of the focused agent's git worktree (status list + per-file diff), replacing the `PlaceholderSurface` for `surface === "files"`.

**Architecture:** cwd is read from the focused agent's transcript (zero git); branch + changed files + per-file diff come from two new read-only git wshrpc commands (`GitChangesCommand`, `GitDiffCommand`) that shell out to the `git` binary. Go stays thin (raw stdout); pure, fixture-tested TS parsers turn that into the render model. The view is a hand-rolled JetBrains-Mono diff/plain list (no Monaco).

**Tech Stack:** Go (`pkg/gitinfo`, wshrpc), `task generate` codegen, React 19 + jotai + Tailwind v4 `@theme`, vitest, `git` CLI.

**Spec:** `docs/superpowers/specs/2026-06-26-cockpit-files-surface-design.md`

> **Commit policy (overrides the skill's per-task commits):** per the repo owner's git rules, do NOT commit per task. Each task ends at a green-tests **Checkpoint**. Task 10 stages everything, shows the summary, and asks for approval for a single batched commit (spec + plan + code together).

> **Worktree:** execution happens in an isolated worktree (set up via `superpowers:using-git-worktrees` at execution start). The spec + this plan are currently untracked on `main`'s working tree — copy both into the worktree before Task 1 (they are not on any branch).

---

## File Structure

**Backend (Go):**
- Create `pkg/gitinfo/gitinfo.go` — read-only git exec helper (the only place that runs `git`).
- Create `pkg/gitinfo/gitinfo_test.go` — temp-repo tests.
- Modify `pkg/wshrpc/wshrpctypes.go` — 2 interface methods + 4 structs.
- Modify `pkg/wshrpc/wshserver/wshserver.go` — 2 thin handlers.
- Regenerate (do not hand-edit) `pkg/wshrpc/wshclient/wshclient.go` + `frontend/app/store/wshclientapi.ts` via `task generate`.

**Frontend (pure logic, fixture-tested):**
- Create `frontend/app/view/agents/agentcwd.ts` (+ `.test.ts`) — transcript lines → cwd.
- Create `frontend/app/view/agents/gitstatus.ts` (+ `.test.ts`) — porcelain + numstat → `GitChanges`.
- Create `frontend/app/view/agents/gitdiff.ts` (+ `.test.ts`) — unified diff / plain content → `FileView`.

**Frontend (wiring + view):**
- Create `frontend/app/view/agents/filesstore.ts` — atoms + loaders (mirrors `liveagents.ts`/`previousinfo.ts`).
- Create `frontend/app/view/agents/filessurface.tsx` — the handoff-parity view.
- Modify `frontend/app/view/agents/cockpitshell.tsx` — add the `"files"` branch.
- Modify `docs/deferred.md` — record the Codex-cwd + remote-worktree + picker deferrals.

---

## Task 1: Pure parser — `agentcwd.ts`

**Files:**
- Create: `frontend/app/view/agents/agentcwd.ts`
- Test: `frontend/app/view/agents/agentcwd.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// frontend/app/view/agents/agentcwd.test.ts
import { describe, expect, it } from "vitest";
import { agentCwd } from "./agentcwd";

describe("agentCwd", () => {
    it("reads cwd from a Claude record (top-level cwd)", () => {
        const lines = [
            JSON.stringify({ type: "mode", sessionId: "s" }),
            JSON.stringify({ type: "user", cwd: "C:\\Users\\k\\proj", gitBranch: "main" }),
        ];
        expect(agentCwd(lines)).toBe("C:\\Users\\k\\proj");
    });

    it("reads cwd from a Codex session_meta record (payload.cwd)", () => {
        const lines = [JSON.stringify({ type: "session_meta", payload: { cwd: "/home/k/proj" } })];
        expect(agentCwd(lines)).toBe("/home/k/proj");
    });

    it("returns null when no record carries a cwd", () => {
        expect(agentCwd([JSON.stringify({ type: "mode" })])).toBeNull();
    });

    it("skips blank and malformed lines", () => {
        const lines = ["", "not json", JSON.stringify({ cwd: "/x" })];
        expect(agentCwd(lines)).toBe("/x");
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run frontend/app/view/agents/agentcwd.test.ts`
Expected: FAIL — `Cannot find module './agentcwd'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// frontend/app/view/agents/agentcwd.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pure: extract the agent's working directory from raw transcript JSONL lines. Claude records
// carry a top-level "cwd"; Codex carries it on the session_meta record (payload.cwd). Returns the
// first cwd found, or null. No React, no Wave imports. NOTE: callers pass the transcript TAIL —
// Claude's cwd recurs on nearly every record (fine), but Codex's session_meta is the FIRST line, so
// Codex cwd resolves only when that line is within the tail (see docs/deferred.md).

export function agentCwd(lines: string[]): string | null {
    for (const line of lines) {
        const t = line.trim();
        if (!t) {
            continue;
        }
        let obj: any;
        try {
            obj = JSON.parse(t);
        } catch {
            continue;
        }
        if (typeof obj?.cwd === "string" && obj.cwd) {
            return obj.cwd; // Claude
        }
        if (obj?.type === "session_meta" && typeof obj?.payload?.cwd === "string" && obj.payload.cwd) {
            return obj.payload.cwd; // Codex
        }
    }
    return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run frontend/app/view/agents/agentcwd.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Checkpoint** — tests green; no commit (batched at Task 10).

---

## Task 2: Pure parser — `gitstatus.ts`

**Files:**
- Create: `frontend/app/view/agents/gitstatus.ts`
- Test: `frontend/app/view/agents/gitstatus.test.ts`

Inputs are the raw stdout of `git status --porcelain=v1 -z` (NUL-separated; rename/copy entries carry an extra NUL old-path field) and `git diff --numstat HEAD` (`adds\tdels\tpath`, binary = `-\t-\tpath`).

- [ ] **Step 1: Write the failing test**

```ts
// frontend/app/view/agents/gitstatus.test.ts
import { describe, expect, it } from "vitest";
import { parseGitChanges } from "./gitstatus";

const NUL = "\0";

describe("parseGitChanges", () => {
    it("joins porcelain status with numstat adds/dels", () => {
        const statusZ = ` M src/auth.ts${NUL}A  src/redis.ts${NUL}`;
        const numstat = "3\t1\tsrc/auth.ts\n9\t0\tsrc/redis.ts\n";
        const r = parseGitChanges(statusZ, numstat);
        expect(r.files).toEqual([
            { path: "src/auth.ts", status: "M", adds: 3, dels: 1 },
            { path: "src/redis.ts", status: "A", adds: 9, dels: 0 },
        ]);
        expect(r.adds).toBe(12);
        expect(r.dels).toBe(1);
    });

    it("maps untracked (??) to '?' with zero counts", () => {
        const r = parseGitChanges(`?? notes.md${NUL}`, "");
        expect(r.files).toEqual([{ path: "notes.md", status: "?", adds: 0, dels: 0 }]);
    });

    it("handles deleted files", () => {
        const r = parseGitChanges(` D old.ts${NUL}`, "0\t4\told.ts\n");
        expect(r.files[0]).toEqual({ path: "old.ts", status: "D", adds: 0, dels: 4 });
    });

    it("skips the rename source field and uses the new path", () => {
        const statusZ = `R  new.ts${NUL}old.ts${NUL}`;
        const r = parseGitChanges(statusZ, "0\t0\tnew.ts\n");
        expect(r.files).toEqual([{ path: "new.ts", status: "R", adds: 0, dels: 0 }]);
    });

    it("treats binary numstat (-/-) as zero counts", () => {
        const r = parseGitChanges(` M logo.png${NUL}`, "-\t-\tlogo.png\n");
        expect(r.files[0]).toEqual({ path: "logo.png", status: "M", adds: 0, dels: 0 });
    });

    it("returns empty for a clean tree", () => {
        expect(parseGitChanges("", "")).toEqual({ files: [], adds: 0, dels: 0 });
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run frontend/app/view/agents/gitstatus.test.ts`
Expected: FAIL — `Cannot find module './gitstatus'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// frontend/app/view/agents/gitstatus.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pure: join `git status --porcelain=v1 -z` with `git diff --numstat HEAD` into the Files render
// model. No React, no Wave imports. Fixture-tested.

export interface GitChange {
    path: string;
    status: string; // "M" | "A" | "D" | "?" | "R" | "C" ...
    adds: number;
    dels: number;
}

export interface GitChanges {
    files: GitChange[];
    adds: number; // totals
    dels: number;
}

// porcelain -z: NUL-separated entries "XY path"; rename/copy entries carry an extra NUL old-path.
function parseStatusZ(statusZ: string): { path: string; status: string }[] {
    const out: { path: string; status: string }[] = [];
    const parts = statusZ.split("\0");
    for (let i = 0; i < parts.length; i++) {
        const entry = parts[i];
        if (!entry) {
            continue;
        }
        const xy = entry.slice(0, 2);
        const path = entry.slice(3);
        const status = xy.includes("?") ? "?" : (xy.trim()[0] ?? "?");
        if (xy[0] === "R" || xy[0] === "C") {
            i++; // the next field is the rename/copy source path — consume + ignore it
        }
        out.push({ path, status });
    }
    return out;
}

function parseNumstat(numstat: string): Map<string, { adds: number; dels: number }> {
    const m = new Map<string, { adds: number; dels: number }>();
    for (const line of numstat.split("\n")) {
        if (!line.trim()) {
            continue;
        }
        const cols = line.split("\t");
        const a = cols[0];
        const d = cols[1];
        const path = cols.slice(2).join("\t");
        if (!path) {
            continue;
        }
        m.set(path, {
            adds: a === "-" ? 0 : parseInt(a, 10) || 0,
            dels: d === "-" ? 0 : parseInt(d, 10) || 0,
        });
    }
    return m;
}

export function parseGitChanges(statusZ: string, numstat: string): GitChanges {
    const stat = parseNumstat(numstat);
    const files: GitChange[] = [];
    let adds = 0;
    let dels = 0;
    for (const { path, status } of parseStatusZ(statusZ)) {
        const n = stat.get(path) ?? { adds: 0, dels: 0 };
        files.push({ path, status, adds: n.adds, dels: n.dels });
        adds += n.adds;
        dels += n.dels;
    }
    return { files, adds, dels };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run frontend/app/view/agents/gitstatus.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Checkpoint** — tests green; no commit.

---

## Task 3: Pure parser — `gitdiff.ts`

**Files:**
- Create: `frontend/app/view/agents/gitdiff.ts`
- Test: `frontend/app/view/agents/gitdiff.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// frontend/app/view/agents/gitdiff.test.ts
import { describe, expect, it } from "vitest";
import { parseUnifiedDiff, plainFileView } from "./gitdiff";

const DIFF = [
    "diff --git a/src/x.ts b/src/x.ts",
    "index 111..222 100644",
    "--- a/src/x.ts",
    "+++ b/src/x.ts",
    "@@ -10,3 +10,4 @@ createSession",
    " ctx line",
    "-old line",
    "+new line",
    "+added line",
].join("\n");

describe("parseUnifiedDiff", () => {
    it("drops file headers and parses the hunk header", () => {
        const v = parseUnifiedDiff(DIFF);
        expect(v.isDiff).toBe(true);
        expect(v.hunkLabel).toBe("@@ -10,3 +10,4 @@ createSession");
        expect(v.lines.some((l) => l.text.startsWith("diff --git"))).toBe(false);
    });

    it("tracks old/new gutters and counts adds/dels", () => {
        const v = parseUnifiedDiff(DIFF);
        const body = v.lines.filter((l) => l.kind !== "hunk");
        expect(body.map((l) => [l.gOld, l.gNew, l.sign, l.text])).toEqual([
            ["10", "10", "", "ctx line"],
            ["10", "", "−", "old line"],
            ["", "11", "+", "new line"],
            ["", "12", "+", "added line"],
        ]);
        expect(v.adds).toBe(2);
        expect(v.dels).toBe(1);
    });
});

describe("plainFileView", () => {
    it("numbers every line in the new gutter, no signs", () => {
        const v = plainFileView("a\nb");
        expect(v.isDiff).toBe(false);
        expect(v.lines).toEqual([
            { gOld: "", gNew: "1", sign: "", text: "a", kind: "ctx" },
            { gOld: "", gNew: "2", sign: "", text: "b", kind: "ctx" },
        ]);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run frontend/app/view/agents/gitdiff.test.ts`
Expected: FAIL — `Cannot find module './gitdiff'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// frontend/app/view/agents/gitdiff.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pure: turn `git diff HEAD -- <path>` output (or untracked file content) into the Files render
// model — old/new gutter line numbers + a sign column, faithful to the handoff diff list. No React.

export type DiffLineKind = "add" | "del" | "ctx" | "hunk";

export interface DiffLine {
    gOld: string; // old line number, or ""
    gNew: string; // new line number, or ""
    sign: string; // "+" | "−" | ""
    text: string;
    kind: DiffLineKind;
}

export interface FileView {
    isDiff: boolean;
    lines: DiffLine[];
    adds: number;
    dels: number;
    hunkLabel: string;
}

const HEADER_PREFIXES = ["diff ", "index ", "--- ", "+++ ", "new file", "deleted file", "similarity ", "rename ", "old mode", "new mode"];

export function parseUnifiedDiff(diff: string): FileView {
    const lines: DiffLine[] = [];
    let oldN = 0;
    let newN = 0;
    let adds = 0;
    let dels = 0;
    let hunkLabel = "";
    for (const raw of diff.split("\n")) {
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
            continue; // "\ No newline at end of file"
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
    return { isDiff: true, lines, adds, dels, hunkLabel };
}

export function plainFileView(content: string): FileView {
    const lines: DiffLine[] = content.split("\n").map((text, i) => ({
        gOld: "",
        gNew: String(i + 1),
        sign: "",
        text,
        kind: "ctx" as const,
    }));
    return { isDiff: false, lines, adds: 0, dels: 0, hunkLabel: "" };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run frontend/app/view/agents/gitdiff.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Checkpoint** — tests green; no commit.

---

## Task 4: Backend git helper — `pkg/gitinfo`

**Files:**
- Create: `pkg/gitinfo/gitinfo.go`
- Test: `pkg/gitinfo/gitinfo_test.go`

- [ ] **Step 1: Write the failing test**

```go
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

func TestGetChanges(t *testing.T) {
	dir := repoWithChange(t)
	ch, err := GetChanges(context.Background(), dir)
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
}

func TestGetChangesNotARepo(t *testing.T) {
	ch, err := GetChanges(context.Background(), t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if ch.IsRepo {
		t.Fatal("expected IsRepo false outside a repo")
	}
}

func TestGetDiffTracked(t *testing.T) {
	dir := repoWithChange(t)
	d, err := GetDiff(context.Background(), dir, "a.txt")
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
	d, err := GetDiff(context.Background(), dir, "b.txt")
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./pkg/gitinfo/`
Expected: FAIL — build error (`undefined: GetChanges`, `undefined: GetDiff`).

- [ ] **Step 3: Write minimal implementation**

```go
// pkg/gitinfo/gitinfo.go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Package gitinfo runs read-only git queries for the Files cockpit surface. It shells out to the
// git binary (no go-git dependency) using fixed, read-only subcommands in a given working dir.
package gitinfo

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

const gitTimeout = 10 * time.Second

type Changes struct {
	Branch  string
	StatusZ string
	Numstat string
	IsRepo  bool
}

type Diff struct {
	Diff      string
	Content   string
	Untracked bool
}

func run(ctx context.Context, cwd string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, "git", append([]string{"-C", cwd}, args...)...)
	out, err := cmd.Output()
	return string(out), err
}

func GetChanges(ctx context.Context, cwd string) (*Changes, error) {
	ctx, cancel := context.WithTimeout(ctx, gitTimeout)
	defer cancel()
	inside, err := run(ctx, cwd, "rev-parse", "--is-inside-work-tree")
	if err != nil || strings.TrimSpace(inside) != "true" {
		return &Changes{IsRepo: false}, nil
	}
	branch, _ := run(ctx, cwd, "rev-parse", "--abbrev-ref", "HEAD")
	statusZ, err := run(ctx, cwd, "status", "--porcelain=v1", "-z")
	if err != nil {
		return nil, err
	}
	// `diff --numstat HEAD` errors on a repo with no commits yet; status is still meaningful.
	numstat, _ := run(ctx, cwd, "diff", "--numstat", "HEAD")
	return &Changes{Branch: strings.TrimSpace(branch), StatusZ: statusZ, Numstat: numstat, IsRepo: true}, nil
}

func GetDiff(ctx context.Context, cwd, path string) (*Diff, error) {
	ctx, cancel := context.WithTimeout(ctx, gitTimeout)
	defer cancel()
	st, _ := run(ctx, cwd, "status", "--porcelain=v1", "--", path)
	if strings.HasPrefix(strings.TrimSpace(st), "??") {
		content, err := os.ReadFile(filepath.Join(cwd, path))
		if err != nil {
			return nil, err
		}
		return &Diff{Content: string(content), Untracked: true}, nil
	}
	diff, err := run(ctx, cwd, "diff", "HEAD", "--", path)
	if err != nil {
		return nil, err
	}
	return &Diff{Diff: diff}, nil
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./pkg/gitinfo/`
Expected: PASS (4 tests). (Requires `git` on PATH — it is, in this repo's dev/CI env.)

- [ ] **Step 5: Checkpoint** — tests green; no commit.

---

## Task 5: wshrpc commands + server impl + codegen

**Files:**
- Modify: `pkg/wshrpc/wshrpctypes.go` (interface methods near line 92; structs near line 576)
- Modify: `pkg/wshrpc/wshserver/wshserver.go` (handlers near the agent-transcript handlers ~line 1407; import `gitinfo`)
- Regenerated (do NOT hand-edit): `pkg/wshrpc/wshclient/wshclient.go`, `frontend/app/store/wshclientapi.ts`

- [ ] **Step 1: Add the interface methods** (in `wshrpctypes.go`, immediately after the `GetAgentTranscriptCommand` interface line ~92)

```go
	GitChangesCommand(ctx context.Context, data CommandGitChangesData) (*CommandGitChangesRtnData, error)
	GitDiffCommand(ctx context.Context, data CommandGitDiffData) (*CommandGitDiffRtnData, error)
```

- [ ] **Step 2: Add the structs** (in `wshrpctypes.go`, after `CommandGetAgentTranscriptRtnData` ~line 576)

```go
type CommandGitChangesData struct {
	Cwd string `json:"cwd"`
}

type CommandGitChangesRtnData struct {
	Branch  string `json:"branch"`
	StatusZ string `json:"statusz"`
	Numstat string `json:"numstat"`
	IsRepo  bool   `json:"isrepo"`
}

type CommandGitDiffData struct {
	Cwd  string `json:"cwd"`
	Path string `json:"path"`
}

type CommandGitDiffRtnData struct {
	Diff      string `json:"diff"`
	Content   string `json:"content"`
	Untracked bool   `json:"untracked"`
}
```

- [ ] **Step 3: Add the handlers** (in `wshserver.go`, after `GetAgentTranscriptCommand` ~line 1407)

```go
func (ws *WshServer) GitChangesCommand(ctx context.Context, data wshrpc.CommandGitChangesData) (*wshrpc.CommandGitChangesRtnData, error) {
	ch, err := gitinfo.GetChanges(ctx, data.Cwd)
	if err != nil {
		return nil, fmt.Errorf("git changes: %w", err)
	}
	return &wshrpc.CommandGitChangesRtnData{Branch: ch.Branch, StatusZ: ch.StatusZ, Numstat: ch.Numstat, IsRepo: ch.IsRepo}, nil
}

func (ws *WshServer) GitDiffCommand(ctx context.Context, data wshrpc.CommandGitDiffData) (*wshrpc.CommandGitDiffRtnData, error) {
	d, err := gitinfo.GetDiff(ctx, data.Cwd, data.Path)
	if err != nil {
		return nil, fmt.Errorf("git diff: %w", err)
	}
	return &wshrpc.CommandGitDiffRtnData{Diff: d.Diff, Content: d.Content, Untracked: d.Untracked}, nil
}
```

- [ ] **Step 4: Add the import** — add `"github.com/wavetermdev/waveterm/pkg/gitinfo"` to the import block in `wshserver.go` (verify `fmt` is already imported — it is, used by the neighboring handler).

- [ ] **Step 5: Regenerate bindings**

Run: `task generate`
Expected: succeeds; `git status` shows modified `pkg/wshrpc/wshclient/wshclient.go` and `frontend/app/store/wshclientapi.ts`.

- [ ] **Step 6: Verify generation produced the client methods**

Run: `grep -n "GitChangesCommand\|GitDiffCommand" frontend/app/store/wshclientapi.ts pkg/wshrpc/wshclient/wshclient.go`
Expected: both methods present in both files.

- [ ] **Step 7: Build the backend**

Run: `task build:backend`
Expected: builds `wavesrv` + `wsh` with no errors.

- [ ] **Step 8: Checkpoint** — backend builds, bindings regenerated; no commit.

---

## Task 6: Store — `filesstore.ts`

**Files:**
- Create: `frontend/app/view/agents/filesstore.ts`

This module is impure (RPC + `globalStore`), mirroring `previousinfo.ts` / `liveagents.ts` — no unit test (the pure parsers it composes are tested in Tasks 1-3). Verified by typecheck + the live visual check.

- [ ] **Step 1: Write the module**

```ts
// frontend/app/view/agents/filesstore.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Files-surface state + loaders for the focused agent. Mirrors liveagents.ts/previousinfo.ts:
// module-level atoms written by an async loader via globalStore. cwd is read from the agent's
// transcript (zero git); branch + changes + per-file diff come from the git RPCs.

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { atom, type PrimitiveAtom } from "jotai";
import { agentCwd } from "./agentcwd";
import { parseUnifiedDiff, plainFileView, type FileView } from "./gitdiff";
import { parseGitChanges, type GitChanges } from "./gitstatus";

const CWD_TAIL_LINES = 200;

export interface FilesState {
    cwd: string | null;
    branch: string;
    isRepo: boolean;
    changes: GitChanges | null;
}

export const filesStateAtom = atom<FilesState | null>(null) as PrimitiveAtom<FilesState | null>;
export const filesSelectedPathAtom = atom<string | null>(null) as PrimitiveAtom<string | null>;
export const filesDiffAtom = atom<FileView | null>(null) as PrimitiveAtom<FileView | null>;

// guards against a stale focus's load overwriting a newer one
const current = { id: "" };

const EMPTY: FilesState = { cwd: null, branch: "", isRepo: false, changes: null };

export async function loadFilesForAgent(id: string, transcriptPath: string | undefined): Promise<void> {
    current.id = id;
    globalStore.set(filesStateAtom, null);
    globalStore.set(filesSelectedPathAtom, null);
    globalStore.set(filesDiffAtom, null);

    const cwd = await resolveCwd(transcriptPath);
    if (current.id !== id) {
        return;
    }
    if (!cwd) {
        globalStore.set(filesStateAtom, EMPTY);
        return;
    }
    try {
        const ch = await RpcApi.GitChangesCommand(TabRpcClient, { cwd });
        if (current.id !== id) {
            return;
        }
        const changes = ch.isrepo ? parseGitChanges(ch.statusz, ch.numstat) : null;
        globalStore.set(filesStateAtom, { cwd, branch: ch.branch, isRepo: ch.isrepo, changes });
        const first = changes?.files[0]?.path;
        if (first) {
            void selectFile(cwd, first);
        }
    } catch {
        if (current.id === id) {
            globalStore.set(filesStateAtom, { ...EMPTY, cwd });
        }
    }
}

async function resolveCwd(transcriptPath: string | undefined): Promise<string | null> {
    if (!transcriptPath) {
        return null;
    }
    try {
        const rtn = await RpcApi.GetAgentTranscriptCommand(TabRpcClient, { path: transcriptPath, maxlines: CWD_TAIL_LINES });
        return agentCwd(rtn?.lines ?? []);
    } catch {
        return null;
    }
}

export async function selectFile(cwd: string, path: string): Promise<void> {
    globalStore.set(filesSelectedPathAtom, path);
    globalStore.set(filesDiffAtom, null);
    try {
        const d = await RpcApi.GitDiffCommand(TabRpcClient, { cwd, path });
        if (globalStore.get(filesSelectedPathAtom) !== path) {
            return; // selection moved on
        }
        globalStore.set(filesDiffAtom, d.untracked ? plainFileView(d.content) : parseUnifiedDiff(d.diff));
    } catch {
        if (globalStore.get(filesSelectedPathAtom) === path) {
            globalStore.set(filesDiffAtom, null);
        }
    }
}
```

- [ ] **Step 2: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: no new errors (baseline: ~3 pre-existing in `frontend/tauri/api.test.ts`). If `GitChangesCommand`/`GitDiffCommand` are unknown on `RpcApi`, Task 5's `task generate` did not run — go back and run it.

- [ ] **Step 3: Checkpoint** — typecheck clean; no commit.

---

## Task 7: View — `filessurface.tsx`

**Files:**
- Create: `frontend/app/view/agents/filessurface.tsx`

Faithful to `Wave-cockpit-live.dc.html:733-804`, in `@theme` utilities (no raw hex). Reuses existing tokens: `text-success` (adds/A), `text-error` (dels/D), `text-accent` (M/R), `text-ink-mid` (untracked + gutters), `bg-surface`, `border-edge-faint`.

- [ ] **Step 1: Write the component**

```tsx
// frontend/app/view/agents/filessurface.tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Files surface (Wave-cockpit-live.dc.html:733-804): left = changed-file list for the focused
// agent's worktree; right = the selected file's diff (or plain view for untracked). Read-only.

import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect } from "react";
import type { AgentsViewModel } from "./agents";
import { type DiffLine, type FileView } from "./gitdiff";
import type { GitChange } from "./gitstatus";
import { filesDiffAtom, filesSelectedPathAtom, filesStateAtom, loadFilesForAgent, selectFile } from "./filesstore";

const STATUS_COLOR: Record<string, string> = {
    A: "text-success",
    M: "text-accent",
    R: "text-accent",
    C: "text-accent",
    D: "text-error",
    "?": "text-ink-mid",
};
const statusColor = (s: string) => STATUS_COLOR[s] ?? "text-ink-mid";

function baseName(p: string): string {
    const parts = p.split(/[/\\]/);
    return parts[parts.length - 1] || p;
}

function EmptyCenter({ msg }: { msg: string }) {
    return <div className="flex h-full items-center justify-center text-[13px] text-ink-mid">{msg}</div>;
}

function FileRow({ change, selected, onSelect }: { change: GitChange; selected: boolean; onSelect: () => void }) {
    return (
        <button
            onClick={onSelect}
            className={cn(
                "flex w-full items-center gap-[7px] rounded-[7px] px-[8px] py-[5px] text-left hover:bg-surface-hover",
                selected && "bg-surface-hover"
            )}
        >
            <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-ink-mid">{change.path}</span>
            <span className={cn("flex-none font-mono text-[10px] font-bold", statusColor(change.status))}>{change.status}</span>
        </button>
    );
}

function DiffRow({ line }: { line: DiffLine }) {
    if (line.kind === "hunk") {
        return <div className="bg-surface px-[20px] py-[2px] font-mono text-[11px] text-ink-mid">{line.text}</div>;
    }
    const tint =
        line.kind === "add"
            ? "color-mix(in srgb, var(--color-success) 12%, transparent)"
            : line.kind === "del"
              ? "color-mix(in srgb, var(--color-error) 12%, transparent)"
              : undefined;
    const textColor = line.kind === "add" ? "text-success" : line.kind === "del" ? "text-error" : "text-foreground";
    return (
        <div className="flex min-w-max" style={tint ? { background: tint } : undefined}>
            <span className="w-[42px] flex-none select-none px-[8px] text-right text-ink-faint">{line.gOld}</span>
            <span className="w-[42px] flex-none select-none px-[8px] text-right text-ink-faint">{line.gNew}</span>
            <span className={cn("w-[16px] flex-none text-center", textColor)}>{line.sign}</span>
            <span className={cn("whitespace-pre pr-[28px]", textColor)}>{line.text}</span>
        </div>
    );
}

function CenterPane({ path, view, cwd }: { path: string | null; view: FileView | null; cwd: string | null }) {
    if (!path) {
        return <EmptyCenter msg="Select a file to view its changes" />;
    }
    return (
        <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex flex-none items-center gap-[11px] border-b border-border bg-surface px-[20px] py-[13px]">
                <span className="min-w-0 truncate font-mono text-[13px] font-semibold">{path}</span>
                <div className="flex-1" />
                <span className="flex-none font-mono text-[11px] text-ink-mid">Read-only</span>
                {cwd && (
                    <button
                        onClick={() => fireAndForget(() => window.api.openExternal(`${cwd}/${path}`))}
                        className="flex-none rounded-[8px] border border-border px-[11px] py-[6px] text-[12px] text-ink-mid hover:text-foreground"
                    >
                        Open in editor ↗
                    </button>
                )}
            </div>
            {view == null ? (
                <EmptyCenter msg="Loading…" />
            ) : (
                <>
                    {view.isDiff && (
                        <div className="flex flex-none items-center gap-[14px] border-b border-edge-faint bg-surface px-[20px] py-[8px] font-mono text-[11px] font-bold">
                            <span className="text-success">+{view.adds}</span>
                            <span className="text-error">−{view.dels}</span>
                            <span className="font-medium text-ink-mid">{view.hunkLabel}</span>
                        </div>
                    )}
                    <div className="flex-1 overflow-auto py-[8px] font-mono text-[12.5px] leading-[1.75]">
                        {view.lines.map((l, i) => (
                            <DiffRow key={i} line={l} />
                        ))}
                    </div>
                </>
            )}
        </div>
    );
}

export function FilesSurface({ model }: { model: AgentsViewModel }) {
    const focusId = useAtomValue(model.focusIdAtom);
    const agents = useAtomValue(model.agentsAtom);
    const state = useAtomValue(filesStateAtom);
    const selected = useAtomValue(filesSelectedPathAtom);
    const diff = useAtomValue(filesDiffAtom);

    const agent = agents.find((a) => a.id === focusId);

    useEffect(() => {
        if (focusId) {
            fireAndForget(() => loadFilesForAgent(focusId, agent?.transcriptPath));
        }
    }, [focusId, agent?.transcriptPath]);

    if (!focusId) {
        return <EmptyCenter msg="Focus an agent to see its changed files" />;
    }
    const dirLabel = state?.cwd ? baseName(state.cwd) : "—";
    const changes = state?.changes;

    return (
        <div className="absolute inset-0 flex min-h-0">
            <div className="flex w-[292px] flex-none flex-col border-r border-border bg-surface">
                <div className="flex-none border-b border-edge-faint p-[15px]">
                    <div className="mb-[11px] flex items-center gap-[9px]">
                        <h1 className="text-[16px] font-bold">Files</h1>
                        <span className="font-mono text-[10.5px] text-ink-mid">read-only</span>
                    </div>
                    <div className="flex w-full items-center gap-[8px] rounded-[8px] border border-border px-[10px] py-[7px]">
                        <span className="flex-1 truncate font-mono text-[12px] text-ink-mid">{dirLabel}</span>
                    </div>
                    {state?.isRepo && (
                        <div className="mt-[10px] flex items-center gap-[13px] font-mono text-[11px] font-semibold">
                            <span className="text-ink-mid">{state.branch || "—"}</span>
                            <span className="text-success">+{changes?.adds ?? 0}</span>
                            <span className="text-error">−{changes?.dels ?? 0}</span>
                        </div>
                    )}
                </div>
                <div className="flex-1 overflow-y-auto p-[8px]">
                    {state == null ? (
                        <div className="px-[8px] py-[6px] text-[12px] text-ink-mid">Loading…</div>
                    ) : !state.isRepo ? (
                        <div className="px-[8px] py-[6px] text-[12px] text-ink-mid">Not a git repository</div>
                    ) : (changes?.files.length ?? 0) === 0 ? (
                        <div className="px-[8px] py-[6px] text-[12px] text-ink-mid">No changes</div>
                    ) : (
                        changes!.files.map((c) => (
                            <FileRow
                                key={c.path}
                                change={c}
                                selected={c.path === selected}
                                onSelect={() => state.cwd && fireAndForget(() => selectFile(state.cwd!, c.path))}
                            />
                        ))
                    )}
                </div>
            </div>
            <div className="flex min-w-0 flex-1 flex-col bg-surface">
                <CenterPane path={selected} view={diff} cwd={state?.cwd ?? null} />
            </div>
        </div>
    );
}
```

- [ ] **Step 2: Verify referenced tokens/utilities exist**

Run: `grep -n "color-ink-faint\|color-foreground\|color-surface-hover" frontend/tailwindsetup.css`
Expected: each token exists. If `--color-ink-faint` or `--color-foreground` is absent, either swap to an existing token (e.g. `text-ink-mid`) or add the token to the `@theme` block in `tailwindsetup.css` (no raw hex in the component). Also confirm `window.api.openExternal` exists: `grep -n "openExternal" frontend/tauri/api.ts` — if the shape differs, match the real signature.

- [ ] **Step 3: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: no new errors beyond baseline.

- [ ] **Step 4: Checkpoint** — typecheck clean; no commit.

---

## Task 8: Wire into the surface router

**Files:**
- Modify: `frontend/app/view/agents/cockpitshell.tsx`

- [ ] **Step 1: Add the import** (after the `CockpitSurface` import)

```tsx
import { FilesSurface } from "./filessurface";
```

- [ ] **Step 2: Add the `"files"` branch** — change the router so the chain reads:

```tsx
                {surface === "cockpit" ? (
                    <CockpitSurface model={model} />
                ) : surface === "agent" ? (
                    <AgentSurface model={model} tabId={tabId} />
                ) : surface === "files" ? (
                    <FilesSurface model={model} />
                ) : (
                    <PlaceholderSurface surface={surface} />
                )}
```

- [ ] **Step 3: Typecheck + full test run**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Then: `npx vitest run`
Expected: typecheck clean (baseline only); all vitest tests pass (existing suite + the 13 new parser tests from Tasks 1-3).

- [ ] **Step 4: Checkpoint** — green; no commit.

---

## Task 9: Visual verification (CDP dev app)

No jsdom render harness — verify against the live dev app over CDP (CLAUDE.md "Visual verification").

- [ ] **Step 1: Run the dev app**

Run: `task dev` (leave running). Note: in DEV the cockpit roster is the mock fixture (`devmock.ts`); mock agents have fake transcript paths, so git resolves to "Not a git repository". To verify real data, inject/point at a real agent (`node scripts/inject-live-agents.mjs <scenario>`) or focus a real running agent whose transcript carries a real `cwd`.

- [ ] **Step 2: Navigate + capture**

Drive the NavRail to the Files surface (set `surfaceAtom = "files"` via CDP `Runtime.evaluate`, or click the rail item), with an agent focused (`focusIdAtom` set). Then `node scripts/cdp-shot.mjs files-surface.png`.

- [ ] **Step 3: Compare to the handoff**

Compare `files-surface.png` against `Wave-cockpit-live.dc.html:733-804`: left changed-file list with status glyphs + branch/+adds/−dels header; right diff with old/new gutter, sign column, +/− tint, hunk label; Read-only + Open-in-editor. Fix visual gaps in `filessurface.tsx` and re-capture. Verify the empty states (no focus / not-a-repo / no-changes) render calmly.

- [ ] **Step 4: Checkpoint** — visual parity confirmed.

---

## Task 10: Deferred log + batched commit (approval-gated)

**Files:**
- Modify: `docs/deferred.md`

- [ ] **Step 1: Append deferred entries** to `docs/deferred.md` (new entry at the top):

```markdown
## Files surface — deferred (v1)

- **Codex cwd via tail read:** `loadFilesForAgent` reads the transcript TAIL for cwd. Claude's
  cwd recurs on most records (resolves), but Codex's cwd is only on the first-line `session_meta`,
  so Codex resolves only for sessions short enough to fit the tail. To fix: add a head-read option
  to `GetAgentTranscriptCommand` (or a tiny dedicated command) and use it for Codex.
- **Remote worktrees:** git runs on the wavesrv (local) host. SSH/WSL agent worktrees need the
  `GitChanges`/`GitDiff` commands routed to `wsh` on that host (same impl can live on `wsh`).
- **Project picker:** the handoff's cross-project `toggleProjects` picker is a stub — Files is
  focused-agent-scoped. The left header shows the cwd basename but does not switch projects.
- **Agent-rail placeholders:** Branch + Files-touched in the Agent details rail (Phase 1b) can now
  be fed by `GitChangesCommand` + `gitstatus.ts`; wiring is a follow-on, not done here.
```

- [ ] **Step 2: Self-review the diff**

Run: `git status` and review `git diff` for: no debug logs, no commented-out code, no hand-edits to generated files beyond what `task generate` produced.

- [ ] **Step 3: Final full verification**

Run: `npx vitest run` and `go test ./pkg/gitinfo/` and `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: all green (tsc baseline only).

- [ ] **Step 4: Stage + present for approval** (per the repo owner's git rules — do not commit without explicit "yes")

Stage: `git add pkg/gitinfo frontend/app/view/agents/agentcwd.ts frontend/app/view/agents/agentcwd.test.ts frontend/app/view/agents/gitstatus.ts frontend/app/view/agents/gitstatus.test.ts frontend/app/view/agents/gitdiff.ts frontend/app/view/agents/gitdiff.test.ts frontend/app/view/agents/filesstore.ts frontend/app/view/agents/filessurface.tsx frontend/app/view/agents/cockpitshell.tsx pkg/wshrpc/wshrpctypes.go pkg/wshrpc/wshserver/wshserver.go pkg/wshrpc/wshclient/wshclient.go frontend/app/store/wshclientapi.ts docs/superpowers/specs/2026-06-26-cockpit-files-surface-design.md docs/superpowers/plans/2026-06-26-cockpit-files-surface.md docs/deferred.md`

Present the file list (status M/A) + this proposed message, then ask "Awaiting approval. Proceed? (yes/no)":

```
feat(cockpit): Files surface — focused-agent changed-files + diff

Read-only Files surface for the focused agent's worktree: cwd from the
transcript, branch/status/diff from two new read-only git wshrpc commands
(thin Go + pure fixture-tested TS parsers). Spec + plan folded in.
```

- [ ] **Step 5:** On approval, commit once. (Spec + plan fold into this feature commit per the git rules.)

---

## Self-Review (against the spec)

**Spec coverage:** §2 scope (focused agent / changed-files-only) → Tasks 6-7; §3 data source (transcript cwd + 2 git RPCs) → Tasks 1,4,5,6; §4.1 backend → Tasks 4-5; §4.2 modules → Tasks 1-3,6-7; §4.3 atoms/lifecycle → Task 6; §5 extraction/render → Tasks 2,3,7; §6 UI parity → Tasks 7,9; §7 actions (Open in editor / picker stub) → Task 7; §8 reuse → Tasks 6-7; §9 testing → Tasks 1-4,8,9; §10 retires 1b placeholders → noted Task 10; §11 deferred (Codex cwd / remote / picker) → Task 10. No uncovered requirement.

**Placeholder scan:** every code step has complete code; every command has expected output. None of the banned placeholder phrases present.

**Type consistency:** `GitChanges`/`GitChange` (gitstatus.ts) and `FileView`/`DiffLine` (gitdiff.ts) are produced by the parsers and consumed unchanged in `filesstore.ts` + `filessurface.tsx`. RPC field names (`statusz`, `numstat`, `isrepo`, `untracked`, `content`, `diff`, `branch`, `cwd`, `path`) match the Go `json:` tags in Task 5 and the generated client usage in Task 6. `loadFilesForAgent(id, transcriptPath)` / `selectFile(cwd, path)` signatures match their call sites in the view.
