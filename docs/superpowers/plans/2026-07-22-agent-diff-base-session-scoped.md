# Agent diff base: session-scoped — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Anchor the cockpit's live git diff (card pill, agent rail, Diff tab) to the commit that was `HEAD` when the agent's session began, so `+/-` reflects the session's work — not the branch's whole divergence from its default branch.

**Architecture:** A new stateless backend resolver `gitinfo.CommitBefore(cwd, ts)` maps a session-start timestamp to the branch tip at that time. The frontend derives the session-start timestamp from the transcript head (one pure parser, shared cache) and passes it to `GitChangesCommand`, which already diffs committed+uncommitted work against any base and echoes the base into per-file diffs. The old merge-base-vs-default mechanism (`WorktreeBase`) is removed once its callers move.

**Tech Stack:** Go (git shell-out in `pkg/gitinfo`), wshrpc codegen (`task generate`), React/jotai frontend, vitest.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-07-22-agent-diff-base-session-scoped-design.md` — read it first.
- **Git workflow (user rule, overrides the skill's per-task commits):** NEVER commit without explicit user approval. Do **not** commit per-task. Each task ends with a **Verify** step (tests green). A single batched commit at the very end (Task 8, approval-gated) includes the spec doc, this plan, and all code — spec/plan docs fold into the feature commit, never a standalone docs commit.
- **Typecheck command (repo gotcha):** bare `npx tsc` stack-overflows. Use `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`. Baseline is clean (exit 0).
- **Single vitest file:** `npx vitest run <path>`. **Go test:** `go test ./pkg/gitinfo/` etc. **Codegen:** `task generate` after any Go wshrpc/waveobj type change. **Backend rebuild:** `task build:backend`.
- **Never hand-edit generated files** (`frontend/types/gotypes.d.ts`, `frontend/app/store/wshclientapi.ts`) — change the Go source and regenerate.
- Timestamps into the backend are **unix seconds** (int64). The FE converts `Date.parse(...)` ms → seconds.

---

### Task 1: `gitinfo.CommitBefore` resolver

**Files:**
- Modify: `pkg/gitinfo/gitinfo.go` (add function near `WorktreeBase`, ~line 208)
- Test: `pkg/gitinfo/gitinfo_test.go` (add `TestCommitBefore` + a dated-commit helper)

**Interfaces:**
- Produces: `func CommitBefore(ctx context.Context, cwd string, beforeUnixSec int64) (string, error)` — returns the newest first-parent commit on `HEAD` with committer-date ≤ `beforeUnixSec`; `("", nil)` when not a repo, `HEAD` unborn, or no commit precedes the time.

- [ ] **Step 1: Write the failing test**

Add to `pkg/gitinfo/gitinfo_test.go` (uses the existing `git(t, dir, ...)` helper and `HeadCommit`; `time` must be in the import block — add it):

```go
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `go test ./pkg/gitinfo/ -run TestCommitBefore -v`
Expected: FAIL — `undefined: CommitBefore` (compile error).

- [ ] **Step 3: Implement `CommitBefore`**

Add to `pkg/gitinfo/gitinfo.go` (after `WorktreeBase`, before `defaultBranchRef`):

```go
// CommitBefore resolves the commit that was HEAD at the given time — the newest first-parent commit
// on HEAD's history with committer-date at or before beforeUnixSec. It anchors an agent's live diff
// to its session start, so the diff reflects only that session's work (commits since start +
// uncommitted), not the branch's whole divergence. Returns "" (no error) when cwd is not a repo,
// HEAD is unborn, or no commit precedes the time (a brand-new session) — every caller treats "" as
// "fall back to the live working-tree-vs-HEAD diff".
func CommitBefore(ctx context.Context, cwd string, beforeUnixSec int64) (string, error) {
	if beforeUnixSec <= 0 {
		return "", nil
	}
	ctx, cancel := context.WithTimeout(ctx, gitTimeout)
	defer cancel()
	before := time.Unix(beforeUnixSec, 0).UTC().Format(time.RFC3339)
	out, err := run(ctx, cwd, "rev-list", "-1", "--first-parent", "--before="+before, "HEAD")
	if err != nil {
		return "", nil // not a repo / unborn HEAD — no anchor
	}
	return strings.TrimSpace(out), nil
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `go test ./pkg/gitinfo/ -run TestCommitBefore -v`
Expected: PASS.

- [ ] **Step 5: Verify the package**

Run: `go test ./pkg/gitinfo/`
Expected: ok (all gitinfo tests still pass).

---

### Task 2: Add `SessionStartTs` to `GitChangesCommand` (additive)

Keeps `WorktreeBase` in place (removed in Task 7) so the frontend still compiles.

**Files:**
- Modify: `pkg/wshrpc/wshrpctypes_projects.go:44-51` (add field)
- Modify: `pkg/wshrpc/wshserver/wshserver_projects.go:73-85` (add resolution branch)
- Regenerate: `frontend/types/gotypes.d.ts`, `frontend/app/store/wshclientapi.ts` (via `task generate`)

**Interfaces:**
- Produces: request field `SessionStartTs int64 \`json:"sessionstartts,omitempty"\``. Precedence in `GitChangesCommand`: `SessionStartTs != 0` → `CommitBefore`; else `WorktreeBase`; else `Ref`; the resolved base is echoed back as `Ref`.

- [ ] **Step 1: Add the request field**

In `pkg/wshrpc/wshrpctypes_projects.go`, add to `CommandGitChangesData` (after the `WorktreeBase` field, line 50):

```go
	// SessionStartTs, when set, asks the backend to resolve the base as the commit that was HEAD at
	// this unix-seconds time (an agent's session start), so the diff reflects only that session's work
	// (commits since start + uncommitted). Takes precedence over WorktreeBase and Ref; the resolved
	// base is echoed in the response's Ref. 0 = fall through to Ref / live HEAD diff.
	SessionStartTs int64 `json:"sessionstartts,omitempty"`
```

- [ ] **Step 2: Add the resolution branch**

In `pkg/wshrpc/wshserver/wshserver_projects.go`, replace the base-resolution block in `GitChangesCommand` (lines 74-79) with:

```go
	ref := data.Ref
	if data.SessionStartTs != 0 {
		// the commit that was HEAD when the agent's session began; "" degrades to the live HEAD diff.
		ref, _ = gitinfo.CommitBefore(ctx, data.Cwd, data.SessionStartTs)
	} else if data.WorktreeBase {
		// resolve the branch's fork point; "" degrades to the live HEAD diff.
		ref, _ = gitinfo.WorktreeBase(ctx, data.Cwd)
	}
```

- [ ] **Step 3: Regenerate bindings**

Run: `task generate`
Expected: success; `frontend/types/gotypes.d.ts` now shows `sessionstartts?: number` on the `CommandGitChangesData` type (alongside `worktreebase?`).

- [ ] **Step 4: Verify backend + typecheck**

Run: `go build ./... && go test ./pkg/wshrpc/...`
Expected: builds; tests pass.
Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0 (FE untouched, still uses `worktreebase`).

---

### Task 3: Pure `sessionStartTs` transcript parser

**Files:**
- Create: `frontend/app/view/agents/agentsessionstart.ts`
- Test: `frontend/app/view/agents/agentsessionstart.test.ts`

**Interfaces:**
- Produces: `export function sessionStartTs(lines: string[]): number | null` — first transcript line with a parseable top-level `timestamp`, returned as unix **seconds**; `null` if none. (Claude records and Codex records both carry a top-level `timestamp`.)

- [ ] **Step 1: Write the failing test**

Create `frontend/app/view/agents/agentsessionstart.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { sessionStartTs } from "./agentsessionstart";

const sec = (iso: string) => Math.floor(Date.parse(iso) / 1000);

describe("sessionStartTs", () => {
    it("reads a Claude record's top-level timestamp as unix seconds", () => {
        const line = JSON.stringify({ timestamp: "2026-07-08T00:00:00.000Z", cwd: "/x", type: "user" });
        expect(sessionStartTs([line])).toBe(sec("2026-07-08T00:00:00.000Z"));
    });

    it("reads a Codex session_meta record's top-level timestamp", () => {
        const line = JSON.stringify({ timestamp: "2026-07-08T00:00:01.000Z", type: "session_meta", payload: { cwd: "/x" } });
        expect(sessionStartTs([line])).toBe(sec("2026-07-08T00:00:01.000Z"));
    });

    it("skips blank and non-JSON lines and returns the first valid timestamp", () => {
        const line = JSON.stringify({ timestamp: "2026-07-08T00:00:02.000Z" });
        expect(sessionStartTs(["", "not json {", line])).toBe(sec("2026-07-08T00:00:02.000Z"));
    });

    it("returns null when no line has a timestamp", () => {
        expect(sessionStartTs([JSON.stringify({ type: "user", cwd: "/x" })])).toBeNull();
    });

    it("returns null for an empty transcript", () => {
        expect(sessionStartTs([])).toBeNull();
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run frontend/app/view/agents/agentsessionstart.test.ts`
Expected: FAIL — cannot resolve `./agentsessionstart`.

- [ ] **Step 3: Implement the parser**

Create `frontend/app/view/agents/agentsessionstart.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pure: extract the agent session's start time from raw transcript JSONL lines. Both Claude records
// and Codex records ({timestamp, type, payload}) carry a top-level ISO "timestamp"; the head of the
// transcript is the session start. Returns unix seconds, or null. No React, no Wave imports.
export function sessionStartTs(lines: string[]): number | null {
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
        if (typeof obj?.timestamp === "string") {
            const ms = Date.parse(obj.timestamp);
            if (!Number.isNaN(ms)) {
                return Math.floor(ms / 1000);
            }
        }
    }
    return null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run frontend/app/view/agents/agentsessionstart.test.ts`
Expected: PASS (5 tests).

---

### Task 4: `ensureSessionStart` cache store

**Files:**
- Create: `frontend/app/view/agents/agentsessionstore.ts`
- Test: `frontend/app/view/agents/agentsessionstore.test.ts`

**Interfaces:**
- Consumes: `sessionStartTs` (Task 3); `RpcApi.GetAgentTranscriptCommand({ path, maxlines, fromstart })` → `{ lines: string[] }`.
- Produces: `export async function ensureSessionStart(transcriptPath: string | undefined): Promise<number | null>` — reads the transcript head once per path, caches only successful (non-null) results (so a not-yet-written transcript is retried), dedupes concurrent reads. Keyed by `transcriptPath`.

- [ ] **Step 1: Write the failing test**

Create `frontend/app/view/agents/agentsessionstore.test.ts` (distinct paths per case avoid cross-test cache contamination — no reset seam needed):

```ts
import { describe, expect, it, vi } from "vitest";

const getTranscript = vi.fn();
vi.mock("@/app/store/wshclientapi", () => ({
    RpcApi: { GetAgentTranscriptCommand: (...a: any[]) => getTranscript(...a) },
}));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));

import { ensureSessionStart } from "./agentsessionstore";

const sec = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const headLine = (iso: string) => ({ lines: [JSON.stringify({ timestamp: iso })] });

describe("ensureSessionStart", () => {
    it("returns null without an RPC when no transcript path", async () => {
        expect(await ensureSessionStart(undefined)).toBeNull();
        expect(getTranscript).not.toHaveBeenCalled();
    });

    it("resolves the head timestamp as unix seconds and caches it (one RPC)", async () => {
        getTranscript.mockResolvedValue(headLine("2026-07-08T00:00:00.000Z"));
        expect(await ensureSessionStart("/cache.jsonl")).toBe(sec("2026-07-08T00:00:00.000Z"));
        expect(await ensureSessionStart("/cache.jsonl")).toBe(sec("2026-07-08T00:00:00.000Z"));
        expect(getTranscript).toHaveBeenCalledTimes(1);
    });

    it("does not cache a null result — a later read retries", async () => {
        getTranscript.mockReset();
        getTranscript.mockRejectedValueOnce(new Error("not yet"));
        expect(await ensureSessionStart("/retry.jsonl")).toBeNull();
        getTranscript.mockResolvedValueOnce(headLine("2026-07-08T00:00:05.000Z"));
        expect(await ensureSessionStart("/retry.jsonl")).toBe(sec("2026-07-08T00:00:05.000Z"));
        expect(getTranscript).toHaveBeenCalledTimes(2);
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run frontend/app/view/agents/agentsessionstore.test.ts`
Expected: FAIL — cannot resolve `./agentsessionstore`.

- [ ] **Step 3: Implement the store**

Create `frontend/app/view/agents/agentsessionstore.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Session-start anchor cache for the cockpit's live git diff. A session's start time is fixed, so
// each transcript is read once (from its head) and memoized. Shared by the card pill, the agent rail,
// and the Diff tab so they all anchor on the same commit — the pill and the tab can never disagree.
// Only successful resolutions are cached; a not-yet-written transcript resolves to null and is retried
// on the next call.

import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { sessionStartTs } from "./agentsessionstart";

const HEAD_LINES = 200; // session_meta / first record is at the head

const cache = new Map<string, number>(); // transcriptPath -> unix seconds
const inflight = new Map<string, Promise<number | null>>();

export async function ensureSessionStart(transcriptPath: string | undefined): Promise<number | null> {
    if (!transcriptPath) {
        return null;
    }
    const hit = cache.get(transcriptPath);
    if (hit != null) {
        return hit;
    }
    const existing = inflight.get(transcriptPath);
    if (existing) {
        return existing;
    }
    const p = (async () => {
        try {
            const head = await RpcApi.GetAgentTranscriptCommand(TabRpcClient, {
                path: transcriptPath,
                maxlines: HEAD_LINES,
                fromstart: true,
            });
            const ts = sessionStartTs(head?.lines ?? []);
            if (ts != null) {
                cache.set(transcriptPath, ts);
            }
            return ts;
        } catch {
            return null;
        } finally {
            inflight.delete(transcriptPath);
        }
    })();
    inflight.set(transcriptPath, p);
    return p;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run frontend/app/view/agents/agentsessionstore.test.ts`
Expected: PASS (3 tests).

---

### Task 5: Move the card pill + rail to the session base

**Files:**
- Modify: `frontend/app/view/agents/cardgitstore.ts:49-78` (`refreshCardGit`)
- Modify: `frontend/app/view/agents/railstore.ts:49-79` (`loadRailForAgent`)

**Interfaces:**
- Consumes: `ensureSessionStart` (Task 4); `sessionstartts` request field (Task 2).

- [ ] **Step 1: Update `cardgitstore.refreshCardGit`**

In `frontend/app/view/agents/cardgitstore.ts`, add the import:

```ts
import { ensureSessionStart } from "./agentsessionstore";
```

Replace the body of `refreshCardGit` from the `const cwd = await resolveCwd(...)` line through the `GitChangesCommand` call (lines 52-63) with:

```ts
    const [cwd, startTs] = await Promise.all([resolveCwd(transcriptPath, blockId), ensureSessionStart(transcriptPath)]);
    if (loadSeq.get(id) !== seq) {
        return;
    }
    if (!cwd) {
        setStats(id, null);
        return;
    }
    try {
        // sessionstartts: anchor on the commit that was HEAD when this agent's session began, so the
        // pill counts only this session's work (commits since start + uncommitted). Null ts (no
        // transcript yet) degrades to the live working-tree-vs-HEAD diff.
        const ch = await RpcApi.GitChangesCommand(TabRpcClient, { cwd, sessionstartts: startTs ?? undefined });
```

(Leave the rest of the `try` block — the `loadSeq` re-check, `isrepo` guard, `diffStatsFromChanges`, `setStats` — unchanged.)

- [ ] **Step 2: Update `railstore.loadRailForAgent`**

In `frontend/app/view/agents/railstore.ts`, add the import:

```ts
import { ensureSessionStart } from "./agentsessionstore";
```

Replace lines 57-68 (from `const cwd = await resolveCwd(...)` through the `GitChangesCommand` call) with:

```ts
    const [cwd, startTs] = await Promise.all([resolveCwd(transcriptPath, blockId), ensureSessionStart(transcriptPath)]);
    if (current.id !== id) {
        return;
    }
    if (!cwd) {
        globalStore.set(railStateAtom, EMPTY);
        return;
    }
    try {
        // sessionstartts: match the card pill / Diff tab — the branch's changed-file list vs the
        // session-start commit. Null ts degrades to the live working-tree-vs-HEAD diff.
        const ch = await RpcApi.GitChangesCommand(TabRpcClient, { cwd, sessionstartts: startTs ?? undefined });
```

(Leave the rest of the `try` block unchanged.)

- [ ] **Step 3: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 4: Verify the card store's pure test still passes**

Run: `npx vitest run frontend/app/view/agents/cardgitstore.test.ts`
Expected: PASS (it tests `diffStatsFromChanges`, unaffected — confirms no accidental breakage).

---

### Task 6: Move the Diff tab (agent + project) to the session / live base

**Files:**
- Modify: `frontend/app/view/agents/filesstore.ts:38-64,105-129` (`LoadOpts`, `loadChangesForCwd`, `loadFilesForAgent`, `loadFilesForProject`)
- Test: `frontend/app/view/agents/filesstore.test.ts:42-57` (update `loadFilesForAgent` test)

**Interfaces:**
- Consumes: `ensureSessionStart` (Task 4); `sessionstartts` field (Task 2).
- Produces: `LoadOpts = { ref?: string; sessionStartTs?: number }` (replaces `worktreeBase`). `loadFilesForRun` unchanged (`{ ref }`).

- [ ] **Step 1: Update the `loadFilesForAgent` test first (red)**

In `frontend/app/view/agents/filesstore.test.ts`, add a mock for the session store (after the `resolveCwd` mock, line 14):

```ts
const ensureSessionStart = vi.fn();
vi.mock("./agentsessionstore", () => ({ ensureSessionStart: (...a: any[]) => ensureSessionStart(...a) }));
```

Add `ensureSessionStart.mockReset();` to the `afterEach` block (after `resolveCwd.mockReset();`).

Replace the `loadFilesForAgent` describe block (lines 42-57) with:

```ts
describe("loadFilesForAgent", () => {
    it("resolves the session-start ts, sends it as sessionstartts, and threads the echoed base into GitDiff", async () => {
        resolveCwd.mockResolvedValue("/wt");
        ensureSessionStart.mockResolvedValue(1719000000);
        // backend resolved the session-start commit and echoed it back as `ref`
        gitChanges.mockResolvedValue({ isrepo: true, branch: "feat", statusz: "M  y.ts\0", numstat: "2\t0\ty.ts\n", ref: "base9" });
        gitDiff.mockResolvedValue({ diff: "", content: "", untracked: false });

        await loadFilesForAgent("a1", "/t.jsonl");
        await new Promise((r) => setTimeout(r, 0));

        expect(gitChanges).toHaveBeenCalledWith({}, { cwd: "/wt", sessionstartts: 1719000000 });
        // the per-file diff must use the SAME base the list did, not "" — else pill/list/diff disagree
        expect(gitDiff).toHaveBeenCalledWith({}, { cwd: "/wt", path: "y.ts", ref: "base9" });
        expect(globalStore.get(filesStateAtom)?.ref).toBe("base9");
    });

    it("falls back to a live diff (no base) when the session start can't be resolved", async () => {
        resolveCwd.mockResolvedValue("/wt");
        ensureSessionStart.mockResolvedValue(null);
        gitChanges.mockResolvedValue({ isrepo: true, branch: "main", statusz: "M  y.ts\0", numstat: "2\t0\ty.ts\n", ref: "" });
        gitDiff.mockResolvedValue({ diff: "", content: "", untracked: false });

        await loadFilesForAgent("a2", "/t.jsonl");
        await new Promise((r) => setTimeout(r, 0));

        expect(gitChanges).toHaveBeenCalledWith({}, { cwd: "/wt" });
        expect(globalStore.get(filesStateAtom)?.ref).toBe("");
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run frontend/app/view/agents/filesstore.test.ts`
Expected: FAIL — call args mismatch (`worktreebase: true` still sent) / `ensureSessionStart` import not used yet.

- [ ] **Step 3: Update `filesstore.ts`**

Add the import (after the `resolveCwd` import, line 13):

```ts
import { ensureSessionStart } from "./agentsessionstore";
```

Replace `LoadOpts` (lines 38-44) with:

```ts
// How to anchor the diff: an explicit base commit (runs), or a session-start unix-seconds timestamp
// (interactive agents) that the backend resolves to the session-start commit and echoes back so
// committed work still shows. Neither set = live working-tree-vs-HEAD (project view). sessionStartTs
// wins if both are set.
interface LoadOpts {
    ref?: string;
    sessionStartTs?: number;
}
```

Replace the `GitChangesCommand` call and the `ref` selection in `loadChangesForCwd` (lines 56-62) with:

```ts
        const ch = await RpcApi.GitChangesCommand(TabRpcClient, {
            cwd,
            ...(opts.ref ? { ref: opts.ref } : {}),
            ...(opts.sessionStartTs ? { sessionstartts: opts.sessionStartTs } : {}),
        });
        if (current.token !== token) {
            return;
        }
        // sessionStartTs mode: the backend resolved + echoed the concrete base — thread it into per-file
        // diffs so they match the list. Otherwise use the ref we sent ("" = live).
        const ref = opts.sessionStartTs ? (ch.ref ?? "") : (opts.ref ?? "");
```

Replace `loadFilesForAgent` (lines 105-120) with:

```ts
export async function loadFilesForAgent(
    id: string,
    transcriptPath: string | undefined,
    blockId?: string
): Promise<void> {
    const token = `agent:${id}`;
    beginLoad(token);
    const [cwd, sessionStartTs] = await Promise.all([
        resolveCwd(transcriptPath, blockId),
        ensureSessionStart(transcriptPath),
    ]);
    if (current.token !== token) {
        return;
    }
    // anchor on the session-start commit so committed work stays visible (a plain vs-HEAD diff would
    // collapse to nothing after the agent commits). Null ts degrades to the live diff.
    await loadChangesForCwd(token, cwd, { sessionStartTs: sessionStartTs ?? undefined });
}
```

Replace `loadFilesForProject`'s `loadChangesForCwd` call (line 128) and update its doc comment (lines 122-124) to:

```ts
// Project-scoped load: the registry path IS the cwd, so no transcript / session exists to anchor to.
// Show the live working-tree-vs-HEAD diff (uncommitted changes) — the "open this repo in a git client"
// view.
export async function loadFilesForProject(name: string, path: string): Promise<void> {
    const token = `project:${name}`;
    beginLoad(token);
    await loadChangesForCwd(token, path || null, {});
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run frontend/app/view/agents/filesstore.test.ts`
Expected: PASS (both `loadFilesForAgent` cases + the unchanged `loadFilesForRun` case — the run call sends `{ cwd, ref }` with no `sessionstartts` key, matching its existing assertion).

- [ ] **Step 5: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

---

### Task 7: Remove the now-dead `WorktreeBase`

All three callers moved off it (Tasks 5-6); it is now unused.

**Files:**
- Modify: `pkg/wshrpc/wshrpctypes_projects.go` (remove `WorktreeBase` field + its comment)
- Modify: `pkg/wshrpc/wshserver/wshserver_projects.go` (remove the `else if data.WorktreeBase` branch)
- Modify: `pkg/gitinfo/gitinfo.go` (remove `WorktreeBase` and `defaultBranchRef`)
- Modify: `pkg/gitinfo/gitinfo_test.go` (remove `TestWorktreeBase`, `TestWorktreeBaseDegrades`)
- Regenerate: `task generate`

- [ ] **Step 1: Confirm nothing else references them**

Run: `grep -rn "WorktreeBase\|worktreebase\|defaultBranchRef" --include=*.go --include=*.ts --include=*.tsx . | grep -v gotypes.d.ts`
Expected: only the definition/handler/test sites listed above (no other callers; `defaultBranchRef` only used by `WorktreeBase`). If anything else appears, stop and reassess.

- [ ] **Step 2: Remove the RPC field + handler branch**

In `pkg/wshrpc/wshrpctypes_projects.go`, delete the `WorktreeBase bool` field and its `// WorktreeBase ...` comment block (lines 47-50).

In `pkg/wshrpc/wshserver/wshserver_projects.go`, delete the `else if data.WorktreeBase { ... }` branch so the resolution reads:

```go
	ref := data.Ref
	if data.SessionStartTs != 0 {
		// the commit that was HEAD when the agent's session began; "" degrades to the live HEAD diff.
		ref, _ = gitinfo.CommitBefore(ctx, data.Cwd, data.SessionStartTs)
	}
```

- [ ] **Step 3: Remove the gitinfo functions + tests**

In `pkg/gitinfo/gitinfo.go`, delete `WorktreeBase` (lines ~179-208) and `defaultBranchRef` (lines ~213-225).
In `pkg/gitinfo/gitinfo_test.go`, delete `TestWorktreeBase` and `TestWorktreeBaseDegrades`.

- [ ] **Step 4: Regenerate + verify Go**

Run: `task generate`
Expected: success; `worktreebase?` is gone from `frontend/types/gotypes.d.ts`.
Run: `go build ./... && go test ./pkg/gitinfo/ ./pkg/wshrpc/...`
Expected: builds; tests pass.

- [ ] **Step 5: Confirm no stale FE references + typecheck**

Run: `grep -rn "worktreebase\|worktreeBase" frontend/`
Expected: no matches (all removed in Tasks 5-6; the generated type no longer declares it).
Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

---

### Task 8: Full verification + single commit (approval-gated)

- [ ] **Step 1: Run the full relevant test suites**

Run: `go test ./pkg/gitinfo/ ./pkg/wshrpc/...`
Run: `npx vitest run frontend/app/view/agents/agentsessionstart.test.ts frontend/app/view/agents/agentsessionstore.test.ts frontend/app/view/agents/filesstore.test.ts frontend/app/view/agents/cardgitstore.test.ts`
Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: all green, tsc exit 0.

- [ ] **Step 2: Rebuild the backend so the resolver is live in the dev app**

Run: `task build:backend`
Expected: builds `wavesrv` + `wsh` into `dist/bin/`.

- [ ] **Step 3: Visual smoke (optional but recommended)**

Restart `task dev`, then confirm the `MP-Frontend` card pill now shows a plausible session-scoped `+/-` (not the ~455k figure), and that opening its Diff tab shows the same total. Use `node scripts/cdp-shot.mjs` if driving over CDP.

- [ ] **Step 4: Get approval, then commit everything as one feature commit**

Per the user's git workflow, ask for explicit approval, then commit the spec, this plan, and all code together:

```bash
git add docs/superpowers/specs/2026-07-22-agent-diff-base-session-scoped-design.md \
        docs/superpowers/plans/2026-07-22-agent-diff-base-session-scoped.md \
        pkg/gitinfo/ pkg/wshrpc/ frontend/
git commit -m "feat(agents): anchor live git diff to session start, not branch base"
```

(Confirm `git status` first — stage only files this change touched; the working tree may hold others.)

---

## Self-Review

**Spec coverage:**
- `CommitBefore` resolver → Task 1. ✓
- `SessionStartTs` field + precedence + echoed ref → Task 2 (add), Task 7 (finalize). ✓
- `sessionStartTs` pure parser → Task 3. ✓
- `ensureSessionStart` shared cache → Task 4. ✓
- Card pill + rail on session base → Task 5. ✓
- Diff tab: agent → session base, project → live, run → unchanged → Task 6. ✓
- Per-file diff consistency (echoed ref threaded) → Task 6, Step 3. ✓
- Remove `WorktreeBase` → Task 7. ✓
- Degradation to live vs-HEAD → covered in Tasks 1 (`""`), 5/6 (`?? undefined`), tested in Task 6 Step 1 case 2. ✓
- Tests: `TestCommitBefore`, `agentsessionstart.test.ts`, `agentsessionstore.test.ts`, `filesstore.test.ts` updates → Tasks 1,3,4,6. ✓
- Codegen + backend rebuild → Tasks 2,7,8. ✓
- Known limitation (shared-branch time-boxing) — documented in spec; no code (accepted). ✓

**Placeholder scan:** none — every code step has complete code; every command has expected output.

**Type consistency:** `ensureSessionStart(transcriptPath)` signature identical across Tasks 4/5/6. `sessionstartts` (wire, lowercase) vs `sessionStartTs` (Go field / TS local / `LoadOpts`) used consistently. `CommitBefore(ctx, cwd, beforeUnixSec int64)` signature matches its call in Task 2. `LoadOpts` shape (`{ref?, sessionStartTs?}`) matches its uses in `loadChangesForCwd`/`loadFilesForAgent`/`loadFilesForProject`/`loadFilesForRun`.
