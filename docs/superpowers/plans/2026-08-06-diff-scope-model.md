# Diff surface stored-scope model — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Diff surface's inferred scope — four variables and a ternary chain that no control can write — with one stored `{repo, range}` value, so the Repository / Agent / Run chips stop being buttons that do nothing.

**Architecture:** A new pure module `frontend/app/view/agents/diffscope.ts` owns the scope type and every derivation from it (identity keys, which range chips to draw, history labels). One jotai atom holds the scope. The three stores that load git data — `filesstore.ts` (change list), `githistorystore.ts` (commit history), `comparestore.ts` (two-ref divergence) — read the scope instead of inferring it from each other. The subject bar becomes a repository picker plus a live range strip.

**Tech Stack:** TypeScript, React 19, jotai, Tailwind 4, vitest for unit tests, Chrome DevTools Protocol scenarios (`scripts/cdp/verify.mjs`) for rendered UI.

**Design source:** `docs/superpowers/specs/2026-08-06-diff-scope-model-design.md`.

## Global Constraints

- **No backend changes.** No new RPC command, no new `pkg/gitinfo` reader, no `task generate` run. Every git capability this needs already ships.
- **Commits are batched, not per-task.** Project rule: never commit without explicit approval, and batch into one commit at the end. Each task below therefore ends in a **Checkpoint** (run the gates, leave the tree dirty), not a commit. Task 7 is the single commit, and it only runs after the user approves.
- **The design doc rides along.** Spec and plan documents under `docs/superpowers/` fold into the feature commit they describe — never a docs-only commit. So `docs/superpowers/specs/2026-08-06-diff-scope-model-design.md` and this plan are staged in Task 7 with the code.
- **Colors come from `@theme` tokens** in `frontend/tailwindsetup.css`. Never a raw hex or rgba in a component — runtime theming works by overriding those custom properties, so a hardcoded color silently opts out of every theme.
- **No new SCSS.** Tailwind only.
- **Typecheck command is non-obvious:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`. Bare `npx tsc` stack-overflows on this repo, which also means `task check:ts` is broken. The baseline is clean, so any error reported is yours.
- **Unit test command:** `npx vitest run frontend/app/view/agents/<file>.test.ts`, or `-t "<name>"` to filter by test name.
- **No jsdom render tests for surfaces.** This is a standing project decision. Testable logic is extracted into a pure `foo.ts` with a `foo.test.ts` beside it; "does it render" is covered by the Chrome DevTools Protocol scenarios in `scripts/cdp/scenarios.mjs`.
- **Existing test assertions are frozen.** No behavioral assertion in `filesstore.test.ts` or `githistorystore.test.ts` may be deleted or weakened. Renaming a `describe` block to match a renamed function is fine. Changing what an `expect` asserts is a signal you broke behavior — stop and re-read the design.
- **Commit message style** in this repo is `type(scope): lowercase sentence naming the problem and the fix`. Do not add a Co-Authored-By trailer.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `frontend/app/view/agents/diffscope.ts` | **create** | Pure. The `DiffScope` type plus every derivation: identity keys, available ranges, history labels. No React, no RPC, no atoms. |
| `frontend/app/view/agents/diffscope.test.ts` | **create** | Unit tests for the above. |
| `frontend/app/view/agents/rangestrip.tsx` | **create** | Renders the range chips. A dumb component: takes options, renders buttons, calls back. |
| `frontend/app/view/agents/comparestore.test.ts` | **create** | Unit tests for comparison entering/leaving as a range. |
| `frontend/app/view/agents/agents.tsx` | modify | Swap `filesRunAtom` for `diffScopeAtom` on the view model. |
| `frontend/app/view/agents/filesstore.ts` | modify | Three change-list loaders collapse into one driven by the scope. `filesProjectSelAtom` deleted. |
| `frontend/app/view/agents/filesstore.test.ts` | modify | Same assertions, renamed blocks. |
| `frontend/app/view/agents/githistorystore.ts` | modify | Stale-load token drops the anchor. Divider labels become settable without a git read. |
| `frontend/app/view/agents/githistorystore.test.ts` | modify | Adds the no-reload-on-relabel case; existing cases keep their assertions. |
| `frontend/app/view/agents/comparestore.ts` | modify | `compareOnAtom` becomes derived from the range. `compareAnchorAtom` deleted. |
| `frontend/app/view/agents/filessurface.tsx` | modify | Subject bar rewrite; effects read one scope. |
| `frontend/app/view/agents/agentsessionstore.ts` | modify | Add a synchronous cache peek, so the bar can tell whether an agent has a session start without awaiting. |
| `frontend/app/view/agents/runcompletionsurface.tsx` | modify | Uses the shared `openDiff` helper. |
| `frontend/app/view/agents/agentdetailsrail.tsx` | modify | Uses the shared `openDiff` helper. |
| `frontend/app/view/agents/agentdiffnav.ts` | modify | Becomes the home of `openDiff`; both nav-intent builders fold into it. |
| `frontend/app/store/keybindings/bindings.ts` | modify | `c` writes the comparison range; Escape restores the interrupted range. |
| `scripts/cdp/scenarios.mjs` | modify | Extends the `git-history` scenario with range-strip assertions. |

---

### Task 1: The pure scope module

Nothing is wired in this task. It adds a module and its tests; the app behaves identically.

**Files:**
- Create: `frontend/app/view/agents/diffscope.ts`
- Test: `frontend/app/view/agents/diffscope.test.ts`

**Interfaces:**
- Consumes: `HistoryFilters` from `./historyquery` (shape: `{ author: string; path: string; text: string }`).
- Produces: types `DiffOrigin`, `DiffRepo`, `DiffRange`, `DiffScope`, `RangeOption`, `LoadHistoryOpts`; functions `originKey`, `rangeKey`, `scopeKey`, `historyKey`, `originCwd`, `defaultRangeFor`, `availableRanges`, `historyOptsFor`, `rangeSummary`. Every later task depends on these exact names.

**Note on one deviation from the spec.** The design document lists a pure `rangeOptsFor(range)` returning the change-list RPC's optional arguments. It cannot be pure: the session range needs `ensureSessionStart`, which is an async transcript read. It lives in `filesstore.ts` as `resolveRangeOpts` in Task 2 instead.

**Note on a second deviation, which needs your eye.** The spec's decision 2 says the stored repository holds "an origin, not a resolved directory". That is right for an agent, whose directory is resolved asynchronously from a live transcript and can fail. It is wrong for the other two: a registered project's path comes straight from the config registry, and a run's directory and base commit are immutable values captured when the run started — there is no other place to get either. So `DiffOrigin` below carries a path for project and run, and carries nothing but an id for agent. The spec's *reason* still holds; its blanket phrasing does not.

- [ ] **Step 1: Write the failing test**

Create `frontend/app/view/agents/diffscope.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { NO_FILTERS } from "./historyquery";
import {
    availableRanges,
    defaultRangeFor,
    historyKey,
    historyOptsFor,
    originCwd,
    rangeSummary,
    scopeKey,
    type DiffScope,
} from "./diffscope";

const agentScope: DiffScope = {
    repo: { origin: { kind: "agent", id: "a1" }, label: "jarvis-recall" },
    range: { kind: "session", agentId: "a1" },
};
const projectScope: DiffScope = {
    repo: { origin: { kind: "project", name: "waveterm", path: "/repo" }, label: "waveterm" },
    range: { kind: "working" },
};
const runScope: DiffScope = {
    repo: { origin: { kind: "run", runId: "r1", cwd: "/repo", baseCommit: "9f2c1de" }, label: "run 9f2c1de" },
    range: { kind: "run", runId: "r1", baseCommit: "9f2c1de" },
};

const kinds = (s: DiffScope, ctx = { sessionStartTs: 1719000000, sessionRef: "a3f9c21" }) =>
    availableRanges(s, ctx).map((o) => o.range.kind);

describe("availableRanges", () => {
    // The whole point of the refactor: a chip is drawn only when it has something to switch to, so
    // no permanently-inert control can exist in the bar.
    it("offers working tree, session and compare for an agent", () => {
        expect(kinds(agentScope)).toEqual(["working", "session", "compare"]);
        expect(availableRanges(agentScope, { sessionStartTs: 1719000000, sessionRef: "a3f9c21" }).every((o) => o.available)).toBe(true);
    });

    it("omits the session range entirely for a project — there is no session to anchor on", () => {
        expect(kinds(projectScope)).toEqual(["working", "compare"]);
    });

    it("offers the run range only when the repository came from a run", () => {
        expect(kinds(runScope)).toEqual(["working", "run", "compare"]);
        expect(kinds(agentScope)).not.toContain("run");
        expect(kinds(projectScope)).not.toContain("run");
    });

    // Temporary unavailability is drawn, not hidden: the chip becomes live on its own once the
    // transcript lands, and hiding it would report a passing state as an impossible one.
    it("keeps the session chip but disables it with a reason when no session start has resolved", () => {
        const opts = availableRanges(agentScope, { sessionStartTs: null, sessionRef: "" });
        const session = opts.find((o) => o.range.kind === "session");
        expect(session?.available).toBe(false);
        expect(session?.reason).toBe("no session-start commit recorded yet");
    });

    it("shows the resolved commit beside the session chip only once it is the active range", () => {
        const active = availableRanges(agentScope, { sessionStartTs: 1719000000, sessionRef: "a3f9c21" });
        expect(active.find((o) => o.range.kind === "session")?.detail).toBe("a3f9c21");
        const inactive = availableRanges(
            { ...agentScope, range: { kind: "working" } },
            { sessionStartTs: 1719000000, sessionRef: "" }
        );
        expect(inactive.find((o) => o.range.kind === "session")?.detail).toBe("");
    });
});

describe("scopeKey", () => {
    // Load-bearing: githistorystore compares this against the previous load to tell a remount from a
    // genuine subject change, which is what keeps scroll offset and selection across a nav switch.
    it("is stable for the same scope", () => {
        expect(scopeKey(agentScope)).toBe(scopeKey({ ...agentScope }));
    });

    it("separates an agent, a project and a run that all answer to the same id", () => {
        const keys = new Set([
            scopeKey({ repo: { origin: { kind: "agent", id: "x" }, label: "x" }, range: { kind: "working" } }),
            scopeKey({ repo: { origin: { kind: "project", name: "x", path: "/x" }, label: "x" }, range: { kind: "working" } }),
            scopeKey({ repo: { origin: { kind: "run", runId: "x", cwd: "/x", baseCommit: "" }, label: "x" }, range: { kind: "working" } }),
        ]);
        expect(keys.size).toBe(3);
    });

    it("changes when the range changes, so a stale change-list read cannot land on a new range", () => {
        expect(scopeKey(agentScope)).not.toBe(scopeKey({ ...agentScope, range: { kind: "working" } }));
    });
});

describe("historyKey", () => {
    // Decision 5 of the design: the commit list depends on directory and filters only. The anchor
    // never reaches git — it only labels a divider — so it must not sit in the identity that decides
    // whether to blank the list and scroll to the top.
    it("is stable for the same directory and filters", () => {
        expect(historyKey("/repo", NO_FILTERS)).toBe(historyKey("/repo", NO_FILTERS));
    });

    it("changes when a filter changes", () => {
        expect(historyKey("/repo", NO_FILTERS)).not.toBe(historyKey("/repo", { ...NO_FILTERS, author: "kael" }));
    });

    it("changes when the directory changes", () => {
        expect(historyKey("/repo", NO_FILTERS)).not.toBe(historyKey("/other", NO_FILTERS));
    });
});

describe("historyOptsFor", () => {
    it("labels the session anchor and names what the top row counts", () => {
        expect(historyOptsFor({ kind: "session", agentId: "a1" }, "base9")).toEqual({
            anchor: "base9",
            anchorLabel: "session start",
            rowLabel: "Since session start",
        });
    });

    it("labels the run's base commit", () => {
        expect(historyOptsFor({ kind: "run", runId: "r1", baseCommit: "9f2c1de" }, "")).toEqual({
            anchor: "9f2c1de",
            anchorLabel: "run base",
            rowLabel: "Run changes",
        });
    });

    // No label on purpose: in the working-tree range the top row's count really is uncommitted work
    // against HEAD, so naming it would be noise.
    it("gives the working-tree range no anchor and no label", () => {
        expect(historyOptsFor({ kind: "working" }, "")).toEqual({});
    });
});

describe("compare range", () => {
    it("carries the range it interrupted so leaving restores it", () => {
        const interrupted = { kind: "session", agentId: "a1" } as const;
        const compare = { kind: "compare", base: "main", head: "feat", from: interrupted } as const;
        expect(compare.from).toEqual(interrupted);
    });

    it("is a distinct scope identity per ref pair", () => {
        const a: DiffScope = { ...agentScope, range: { kind: "compare", base: "main", head: "feat", from: { kind: "working" } } };
        const b: DiffScope = { ...agentScope, range: { kind: "compare", base: "main", head: "other", from: { kind: "working" } } };
        expect(scopeKey(a)).not.toBe(scopeKey(b));
    });
});

describe("originCwd", () => {
    // An agent's directory is resolved asynchronously from its transcript, so it is the one origin
    // that cannot answer synchronously.
    it("answers for a project and a run, and defers for an agent", () => {
        expect(originCwd({ kind: "project", name: "waveterm", path: "/repo" })).toBe("/repo");
        expect(originCwd({ kind: "run", runId: "r1", cwd: "/repo", baseCommit: "x" })).toBe("/repo");
        expect(originCwd({ kind: "agent", id: "a1" })).toBeNull();
    });
});

describe("defaultRangeFor", () => {
    it("opens an agent on its session, a project on its working tree, and a run on the run", () => {
        expect(defaultRangeFor({ kind: "agent", id: "a1" })).toEqual({ kind: "session", agentId: "a1" });
        expect(defaultRangeFor({ kind: "project", name: "w", path: "/r" })).toEqual({ kind: "working" });
        expect(defaultRangeFor({ kind: "run", runId: "r1", cwd: "/r", baseCommit: "9f2c1de" })).toEqual({
            kind: "run",
            runId: "r1",
            baseCommit: "9f2c1de",
        });
    });
});

describe("rangeSummary", () => {
    it("says what is being compared against what, in words", () => {
        expect(
            rangeSummary({ kind: "session", agentId: "a1" }, { branch: "main", ref: "a3f9c21", files: 12, adds: 340, dels: 82 })
        ).toBe("worktree against a3f9c21 · 12 files · +340 −82");
    });

    it("names the branch when there is no anchor", () => {
        expect(rangeSummary({ kind: "working" }, { branch: "main", ref: "", files: 3, adds: 9, dels: 1 })).toBe(
            "uncommitted work against HEAD on main · 3 files · +9 −1"
        );
    });

    it("names both refs while comparing", () => {
        expect(
            rangeSummary({ kind: "compare", base: "main", head: "feat", from: { kind: "working" } }, { branch: "feat", ref: "", files: 4, adds: 51, dels: 9 })
        ).toBe("main … feat · 4 files · +51 −9");
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run frontend/app/view/agents/diffscope.test.ts`
Expected: FAIL — `Failed to resolve import "./diffscope"`.

- [ ] **Step 3: Write the module**

Create `frontend/app/view/agents/diffscope.ts`:

```ts
// frontend/app/view/agents/diffscope.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pure: the Diff surface's subject — which repository, and which range within it. Scope used to be a
// conclusion that four separate variables happened to imply, which is why the surface could display it
// and nothing could set it. Here it is one value, and every question the surface and its three git
// stores ask about scope is answered by a function in this file.

import type { HistoryFilters } from "./historyquery";

// A project's path comes from the config registry and a run's directory and base commit were captured
// when the run started, so both answer synchronously. An agent's directory is read from its live
// transcript and can fail, so an agent origin carries only its id and the loader resolves the rest.
export type DiffOrigin =
    | { kind: "agent"; id: string }
    | { kind: "project"; name: string; path: string }
    | { kind: "run"; runId: string; cwd: string; baseCommit: string };

export interface DiffRepo {
    origin: DiffOrigin;
    label: string;
}

export type DiffRange =
    | { kind: "working" }
    | { kind: "session"; agentId: string }
    | { kind: "run"; runId: string; baseCommit: string }
    // `from` is the range comparison interrupted. Escape restores it instead of guessing, which is
    // also what lets the old compareAnchorAtom and its invalidation effect go away.
    | { kind: "compare"; base: string; head: string; from: DiffRange };

export interface DiffScope {
    repo: DiffRepo;
    range: DiffRange;
}

// What the range strip draws. `available: false` means the chip is rendered disabled and explains
// itself; a range that can never apply is absent from the list entirely.
export interface RangeOption {
    range: DiffRange;
    label: string;
    detail: string;
    available: boolean;
    reason?: string;
}

// The history pane's divider label and the name of what its synthetic top row counts. Owned here
// rather than in githistorystore because it is derived from the range and nothing else.
export interface LoadHistoryOpts {
    anchor?: string;
    anchorLabel?: string;
    rowLabel?: string;
}

export function originKey(o: DiffOrigin): string {
    switch (o.kind) {
        case "agent":
            return `agent:${o.id}`;
        case "project":
            return `project:${o.name}`;
        case "run":
            return `run:${o.runId}`;
    }
}

export function rangeKey(r: DiffRange): string {
    switch (r.kind) {
        case "working":
            return "working";
        case "session":
            return `session:${r.agentId}`;
        case "run":
            return `run:${r.runId}:${r.baseCommit}`;
        case "compare":
            return `compare:${r.base}..${r.head}`;
    }
}

// Identifies the subject a change-list read belongs to. Stale reads are dropped by comparing this,
// and a deep link names the scope it wants with it, so both sides speak one vocabulary.
export function scopeKey(scope: DiffScope): string {
    return `${originKey(scope.repo.origin)}|${rangeKey(scope.range)}`;
}

// Deliberately range-free. git's commit list depends on the directory and the filters; the range only
// labels a divider and the synthetic top row, both of which are derived from an atom. Folding the
// range in here would blank the list and scroll to the top on every range change.
export function historyKey(cwd: string, f: HistoryFilters): string {
    return `${cwd}|${f.author}|${f.path}|${f.text}`;
}

export function originCwd(o: DiffOrigin): string | null {
    switch (o.kind) {
        case "project":
            return o.path || null;
        case "run":
            return o.cwd || null;
        case "agent":
            return null;
    }
}

export function defaultRangeFor(o: DiffOrigin): DiffRange {
    switch (o.kind) {
        case "agent":
            return { kind: "session", agentId: o.id };
        case "project":
            return { kind: "working" };
        case "run":
            return { kind: "run", runId: o.runId, baseCommit: o.baseCommit };
    }
}

export interface RangeCtx {
    // null when the agent's transcript has not yielded a session start yet
    sessionStartTs: number | null;
    // the commit the backend resolved for the active session range; "" when that range is not active
    sessionRef: string;
}

export function availableRanges(scope: DiffScope, ctx: RangeCtx): RangeOption[] {
    const out: RangeOption[] = [{ range: { kind: "working" }, label: "Working tree", detail: "", available: true }];
    const origin = scope.repo.origin;
    if (origin.kind === "agent") {
        out.push({
            range: { kind: "session", agentId: origin.id },
            label: "Since session start",
            detail: scope.range.kind === "session" ? shortSha(ctx.sessionRef) : "",
            available: ctx.sessionStartTs != null,
            reason: ctx.sessionStartTs == null ? "no session-start commit recorded yet" : undefined,
        });
    }
    if (origin.kind === "run") {
        out.push({
            range: { kind: "run", runId: origin.runId, baseCommit: origin.baseCommit },
            label: "This run",
            detail: shortSha(origin.baseCommit),
            available: true,
        });
    }
    out.push({
        range: currentCompareRange(scope.range),
        label: "Compare",
        detail: "",
        available: true,
    });
    return out;
}

// Re-entering comparison offers the pair last used, and never nests: comparing while comparing keeps
// the range that comparison originally interrupted.
function currentCompareRange(active: DiffRange): DiffRange {
    if (active.kind === "compare") {
        return active;
    }
    return { kind: "compare", base: "", head: "", from: active };
}

export function historyOptsFor(range: DiffRange, resolvedRef: string): LoadHistoryOpts {
    switch (range.kind) {
        case "session":
            return resolvedRef
                ? { anchor: resolvedRef, anchorLabel: "session start", rowLabel: "Since session start" }
                : {};
        case "run":
            return range.baseCommit
                ? { anchor: range.baseCommit, anchorLabel: "run base", rowLabel: "Run changes" }
                : {};
        case "working":
        case "compare":
            return {};
    }
}

export interface SummaryFacts {
    branch: string;
    ref: string;
    files: number;
    adds: number;
    dels: number;
}

// The quiet line under the subject bar. A string, rendered in a span — deliberately not a control,
// because the button that used to hold this text was the only way into comparison and read as a
// status line.
export function rangeSummary(range: DiffRange, f: SummaryFacts): string {
    const counts = `${f.files} ${f.files === 1 ? "file" : "files"} · +${f.adds} −${f.dels}`;
    switch (range.kind) {
        case "compare":
            return `${range.base} … ${range.head} · ${counts}`;
        case "run":
            return `${shortSha(range.baseCommit)} … HEAD · ${counts}`;
        case "session":
            return `worktree against ${shortSha(f.ref)} · ${counts}`;
        case "working":
            return `uncommitted work against HEAD on ${f.branch || "—"} · ${counts}`;
    }
}

function shortSha(sha: string): string {
    return sha ? sha.slice(0, 7) : "";
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run frontend/app/view/agents/diffscope.test.ts`
Expected: PASS, 18 tests.

- [ ] **Step 5: Checkpoint**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0, no output. Do not commit — see Global Constraints.

---

### Task 2: The change-list store reads the scope

The subject bar's markup does not change in this task — the Repository / Agent / Run chips are still there and still dead. Only the wiring underneath moves, so any behavior change that shows up here is a genuine regression rather than a side effect of a redesigned bar.

**Files:**
- Modify: `frontend/app/view/agents/agents.tsx:96-102` (replace `filesRunAtom`)
- Modify: `frontend/app/view/agents/filesstore.ts:36` (delete `filesProjectSelAtom`), `:49-51` (delete the scope-string helpers), `:122-156` (three loaders → one)
- Modify: `frontend/app/view/agents/filessurface.tsx:363-441` (source selection and the load effect)
- Modify: `frontend/app/view/agents/runcompletionsurface.tsx:41-47` (writes the new atom)
- Test: `frontend/app/view/agents/filesstore.test.ts`

**Interfaces:**
- Consumes: `DiffScope`, `DiffOrigin`, `DiffRange`, `scopeKey`, `originCwd`, `defaultRangeFor` from `./diffscope` (Task 1).
- Produces: `diffScopeAtom: PrimitiveAtom<DiffScope | null>` on `AgentsViewModel`; `loadFilesForScope(scope: DiffScope, agent?: { transcriptPath?: string; blockId?: string }): Promise<void>` from `./filesstore`. Tasks 3–6 all depend on both.

- [ ] **Step 1: Rewrite the two load blocks in the existing test**

In `frontend/app/view/agents/filesstore.test.ts`, replace the import of `loadFilesForAgent` / `loadFilesForRun` / `agentScope` / `runScope` / `projectScope` with `loadFilesForScope` and `scopeKey`, and replace the two `describe` blocks at lines 41–85 with the block below. **The three `expect` calls are unchanged from the originals** — only the function being called changed.

```ts
import { scopeKey, type DiffScope } from "./diffscope";
import {
    consumeFileLink,
    filesDiffAtom,
    filesSelectedPathAtom,
    filesStateAtom,
    loadFilesForScope,
    requestFileLink,
} from "./filesstore";

const runScopeVal: DiffScope = {
    repo: { origin: { kind: "run", runId: "run-1", cwd: "/repo", baseCommit: "abc123" }, label: "run abc123" },
    range: { kind: "run", runId: "run-1", baseCommit: "abc123" },
};
const agentScopeVal = (id: string): DiffScope => ({
    repo: { origin: { kind: "agent", id }, label: id },
    range: { kind: "session", agentId: id },
});

describe("loadFilesForScope, run range", () => {
    it("threads the base commit as ref into GitChanges and the follow-up GitDiff", async () => {
        gitChanges.mockResolvedValue({ isrepo: true, branch: "main", statusz: "M  x.ts\0", numstat: "1\t0\tx.ts\n" });
        gitDiff.mockResolvedValue({ diff: "", content: "", untracked: false });

        await loadFilesForScope(runScopeVal);
        await new Promise((r) => setTimeout(r, 0));

        expect(gitChanges).toHaveBeenCalledWith({}, { cwd: "/repo", ref: "abc123" });
        expect(gitDiff).toHaveBeenCalledWith({}, { cwd: "/repo", path: "x.ts", ref: "abc123" });
        expect(globalStore.get(filesStateAtom)?.ref).toBe("abc123");
    });
});

describe("loadFilesForScope, session range", () => {
    it("resolves the session-start ts, sends it as sessionstartts, and threads the echoed base into GitDiff", async () => {
        resolveCwd.mockResolvedValue("/wt");
        ensureSessionStart.mockResolvedValue(1719000000);
        gitChanges.mockResolvedValue({ isrepo: true, branch: "feat", statusz: "M  y.ts\0", numstat: "2\t0\ty.ts\n", ref: "base9" });
        gitDiff.mockResolvedValue({ diff: "", content: "", untracked: false });

        await loadFilesForScope(agentScopeVal("a1"), { transcriptPath: "/t.jsonl" });
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

        await loadFilesForScope(agentScopeVal("a2"), { transcriptPath: "/t.jsonl" });
        await new Promise((r) => setTimeout(r, 0));

        expect(gitChanges).toHaveBeenCalledWith({}, { cwd: "/wt" });
        expect(globalStore.get(filesStateAtom)?.ref).toBe("");
    });
});

describe("loadFilesForScope, working range on an agent", () => {
    // Newly expressible: an agent's own worktree read with no anchor. Reaching this today would mean
    // selecting a registered project, which means clearing the agent.
    it("sends neither ref nor sessionstartts", async () => {
        resolveCwd.mockResolvedValue("/wt");
        gitChanges.mockResolvedValue({ isrepo: true, branch: "main", statusz: "M  y.ts\0", numstat: "2\t0\ty.ts\n", ref: "" });
        gitDiff.mockResolvedValue({ diff: "", content: "", untracked: false });

        await loadFilesForScope({ ...agentScopeVal("a3"), range: { kind: "working" } }, { transcriptPath: "/t.jsonl" });
        await new Promise((r) => setTimeout(r, 0));

        expect(gitChanges).toHaveBeenCalledWith({}, { cwd: "/wt" });
        expect(ensureSessionStart).not.toHaveBeenCalled();
    });
});
```

In the deep-link `describe` block (lines 87–140), replace every `runScope("r1")` with `scopeKey(runScopeVal)`, every `agentScope("a1")` with `scopeKey(agentScopeVal("a1"))`, and in the same-id case build the three scopes inline as in the Task 1 test. **Every `expect` in that block stays exactly as written.**

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run frontend/app/view/agents/filesstore.test.ts`
Expected: FAIL — `loadFilesForScope` is not exported from `./filesstore`.

- [ ] **Step 3: Replace the three loaders with one**

In `frontend/app/view/agents/filesstore.ts`, delete `filesProjectSelAtom` (line 36), the `FilesProject` interface's role as a scope carrier stays (the picker still lists projects), delete `agentScope` / `runScope` / `projectScope` (lines 49–51), and replace `loadFilesForAgent` / `loadFilesForProject` / `loadFilesForRun` (lines 122–156) with:

```ts
import { originCwd, scopeKey, type DiffOrigin, type DiffRange, type DiffScope } from "./diffscope";

export interface ScopeAgent {
    transcriptPath?: string;
    blockId?: string;
}

// One load for every subject the surface can have. Which range is active decides the anchor and
// nothing else; the directory comes from the origin, resolved from the transcript only for an agent.
export async function loadFilesForScope(scope: DiffScope, agent?: ScopeAgent): Promise<void> {
    const token = scopeKey(scope);
    beginLoad(token);
    const cwd = await resolveScopeCwd(scope.repo.origin, agent);
    if (current.token !== token) {
        return;
    }
    const opts = await resolveRangeOpts(scope.range, agent?.transcriptPath);
    if (current.token !== token) {
        return;
    }
    await loadChangesForCwd(token, cwd, opts);
}

async function resolveScopeCwd(origin: DiffOrigin, agent?: ScopeAgent): Promise<string | null> {
    const known = originCwd(origin);
    if (known != null) {
        return known;
    }
    return (await resolveCwd(agent?.transcriptPath, agent?.blockId)) || null;
}

// The one place a range becomes RPC arguments. Not in diffscope.ts with the other derivations,
// because the session anchor is an async transcript read rather than a pure function of the range.
async function resolveRangeOpts(range: DiffRange, transcriptPath?: string): Promise<LoadOpts> {
    switch (range.kind) {
        case "run":
            return { ref: range.baseCommit };
        case "session":
            // anchor on the session-start commit so committed work stays visible (a plain vs-HEAD
            // diff would collapse to nothing after the agent commits). Null degrades to the live diff.
            return { sessionStartTs: (await ensureSessionStart(transcriptPath)) ?? undefined };
        case "working":
        // comparison drives panes 1 and 2 from comparestore; this load only supplies cwd, branch and
        // whether the directory is a repository at all.
        case "compare":
            return {};
    }
}
```

- [ ] **Step 4: Add the scope atom and point the surface at it**

In `frontend/app/view/agents/agents.tsx`, replace the `filesRunAtom` declaration (lines 96–102) with:

```ts
    // The Diff surface's subject: which repository, and which range within it. One stored value
    // rather than three source variables and a ternary chain, so a control can actually set it.
    diffScopeAtom = atom<DiffScope | null>(null) as PrimitiveAtom<DiffScope | null>;
```

and add `import type { DiffScope } from "./diffscope";` to the file's imports.

In `frontend/app/view/agents/filessurface.tsx`, replace the source-derivation block (lines 363–377) and the load effect (lines 433–441) with:

```ts
    const scope = useAtomValue(model.diffScopeAtom);
    const agent = scope?.repo.origin.kind === "agent" ? agents.find((a) => a.id === scope.repo.origin.id) : undefined;

    // Follows the focused agent only while the stored repository IS an agent — pinning a project or
    // arriving from a run stops focus changes from moving the surface. This is the old
    // run-beats-project-beats-agent precedence, stated once, as data.
    useEffect(() => {
        if (scope != null && scope.repo.origin.kind !== "agent") {
            return;
        }
        if (!focusId) {
            return;
        }
        if (scope?.repo.origin.kind === "agent" && scope.repo.origin.id === focusId) {
            return;
        }
        const a = agents.find((x) => x.id === focusId);
        if (a == null) {
            return;
        }
        const origin: DiffOrigin = { kind: "agent", id: a.id };
        globalStore.set(model.diffScopeAtom, { repo: { origin, label: a.name }, range: defaultRangeFor(origin) });
    }, [focusId, scope, agents]);

    // Default to the first agent when nothing is scoped, so opening Diff is immediately useful
    // instead of a dead "select a source" screen.
    useEffect(() => {
        if (scope == null && !focusId && agents.length > 0) {
            globalStore.set(model.focusIdAtom, agents[0].id);
        }
    }, [scope, focusId, agents]);

    useEffect(() => {
        if (scope == null) {
            return;
        }
        fireAndForget(() =>
            loadFilesForScope(scope, { transcriptPath: agent?.transcriptPath, blockId: agent?.blockId })
        );
    }, [scope && scopeKey(scope), agent?.transcriptPath, agent?.blockId]);
```

Update the source picker's two callbacks (lines 556–560) to write the scope:

```ts
                                        onPickAgent={(id) => {
                                            const a = agents.find((x) => x.id === id);
                                            const origin: DiffOrigin = { kind: "agent", id };
                                            globalStore.set(model.diffScopeAtom, {
                                                repo: { origin, label: a?.name ?? id },
                                                range: defaultRangeFor(origin),
                                            });
                                            globalStore.set(model.focusIdAtom, id);
                                        }}
                                        onPickProject={(p) => {
                                            const origin: DiffOrigin = { kind: "project", name: p.name, path: p.path };
                                            globalStore.set(model.diffScopeAtom, {
                                                repo: { origin, label: p.name },
                                                range: defaultRangeFor(origin),
                                            });
                                        }}
```

Leave the `source`, `scope`-string, `refExpr` and `scopeAnchor` locals and the three dead chips as they are — the bar is rewritten in Task 5. Where they read `projectSel` or `runSource`, read the equivalent off `scope.repo.origin.kind` instead so the file compiles.

In `frontend/app/view/agents/runcompletionsurface.tsx`, change `openRunDiff` (lines 41–47) to write the new atom:

```ts
function openRunDiff(model: AgentsViewModel, run: Run, path?: string) {
    const origin: DiffOrigin = {
        kind: "run",
        runId: run.id,
        cwd: run.projectpath,
        baseCommit: run.basecommit ?? "",
    };
    const scope: DiffScope = { repo: { origin, label: `run ${runShortId(run.id)}` }, range: defaultRangeFor(origin) };
    if (path) {
        requestFileLink(scopeKey(scope), path);
    }
    globalStore.set(model.diffScopeAtom, scope);
    globalStore.set(model.surfaceAtom, "files");
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run frontend/app/view/agents/filesstore.test.ts frontend/app/view/agents/diffscope.test.ts`
Expected: PASS. The change-list store's file has 12 tests now (11 original plus the new working-range case).

- [ ] **Step 6: Checkpoint**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

Run: `npx vitest run frontend/app/view/agents/`
Expected: PASS across the directory. The history store's tests are the ones to watch — they are untouched here and must stay green.

---

### Task 3: History stops reloading when only the label changes

**Files:**
- Modify: `frontend/app/view/agents/githistorystore.ts:51` (opts atom type), `:94-101` (delete the local interface), `:130-132` (token), `:144-199` (loadHistory), add a setter
- Modify: `frontend/app/view/agents/filessurface.tsx:446-475` (the history effect)
- Test: `frontend/app/view/agents/githistorystore.test.ts`

**Interfaces:**
- Consumes: `historyKey`, `historyOptsFor`, `LoadHistoryOpts` from `./diffscope`; `scopeKey` for the deep-link argument.
- Produces: `setHistoryOpts(opts: LoadHistoryOpts): void` from `./githistorystore`, used by the surface in Task 5.

- [ ] **Step 1: Write the failing test**

Append to `frontend/app/view/agents/githistorystore.test.ts`:

```ts
describe("range changes do not re-read git", () => {
    // Decision 5 of the design. The anchor never reaches git — it labels a divider and names what the
    // synthetic top row counts — so folding it into the load identity is what made switching range
    // blank the list and throw the reader back to the top.
    it("keeps the reader's scroll offset and the loaded commits when only the anchor changes", async () => {
        gitHistory.mockResolvedValue({
            isrepo: true,
            head: "aaa1111",
            commits: [commit("aaa1111", "tip commit"), commit("bbb2222", "older commit")],
        });

        await loadHistory("/repo", { anchor: "bbb2222", anchorLabel: "session start", rowLabel: "Since session start" });
        globalStore.set(historyScrollAtom, 420);
        const before = globalStore.get(historyCommitsAtom);

        await loadHistory("/repo", {});

        expect(gitHistory).toHaveBeenCalledTimes(2);
        expect(globalStore.get(historyScrollAtom)).toBe(420);
        expect(globalStore.get(historyCommitsAtom)).toEqual(before);
    });

    it("relabels the divider with no git call at all", async () => {
        gitHistory.mockResolvedValue({
            isrepo: true,
            head: "aaa1111",
            commits: [commit("aaa1111", "tip commit"), commit("bbb2222", "older commit")],
        });

        await loadHistory("/repo", {});
        gitHistory.mockClear();

        setHistoryOpts({ anchor: "bbb2222", anchorLabel: "run base", rowLabel: "Run changes" });

        expect(gitHistory).not.toHaveBeenCalled();
        expect(globalStore.get(historyRowsAtom)?.some((r) => r.hash === "bbb2222")).toBe(true);
    });

    // A different repository IS a different subject: filters and scroll from the old one are
    // meaningless, and a stale path filter would produce an empty history that looks broken.
    it("still starts a different repository at the top", async () => {
        gitHistory.mockResolvedValue({ isrepo: true, head: "aaa1111", commits: [commit("aaa1111", "tip commit")] });

        await loadHistory("/repo", {});
        globalStore.set(historyScrollAtom, 420);
        await loadHistory("/other", {});

        expect(globalStore.get(historyScrollAtom)).toBe(0);
    });
});
```

Add `historyScrollAtom`, `historyCommitsAtom`, `historyRowsAtom` and `setHistoryOpts` to the file's existing import from `./githistorystore`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run frontend/app/view/agents/githistorystore.test.ts -t "range changes do not re-read git"`
Expected: FAIL — `setHistoryOpts` is not exported, and the scroll assertion fails because the anchor is still part of the load token.

- [ ] **Step 3: Drop the anchor from the token and add the setter**

In `frontend/app/view/agents/githistorystore.ts`:

Replace the local `LoadHistoryOpts` interface (lines 94–101) with an import — `import { historyKey, type LoadHistoryOpts } from "./diffscope";` — and re-export it for the pane's convenience: `export type { LoadHistoryOpts };`

Replace `loadToken` (lines 130–132) with:

```ts
// Deliberately excludes the anchor: GitHistoryCommand takes cwd, limit and filters, so two loads that
// differ only in their divider label are the same read and must not blank the list between them.
function loadToken(cwd: string, filters: HistoryFilters): string {
    return historyKey(cwd, filters);
}
```

Update the one call site inside `loadHistory` (line 150) to `const token = loadToken(cwd, filters);`.

Add beside it:

```ts
// Relabels the divider and the synthetic top row without touching git. The rows are derived from this
// atom (historyRowsAtom), so a range change costs one change-list read and zero history reads.
export function setHistoryOpts(opts: LoadHistoryOpts): void {
    globalStore.set(historyOptsAtom, opts);
}
```

- [ ] **Step 4: Point the surface's history effect at the derivations**

In `frontend/app/view/agents/filessurface.tsx`, replace the history effect (lines 446–475) with:

```ts
    // History follows whatever directory the change-list load resolved. The anchor and its labels are
    // derived from the range, and are pushed separately so switching range relabels without a re-read.
    useEffect(() => {
        // A null state means the change list is still loading, not that there is no repository here.
        if (state == null || scope == null) {
            return;
        }
        // A failed change-list read also lands here as isRepo:false, but a repository git cannot read
        // is not an absent one. Ask git for the history anyway: its refusal carries the real message.
        if (!state.cwd || (!state.isRepo && !loadError)) {
            resetHistory();
            return;
        }
        fireAndForget(() => loadHistory(state.cwd, historyOptsFor(scope.range, state.ref), scopeKey(scope)));
    }, [state?.cwd, state?.isRepo, state?.ref, scope && scopeKey(scope), loadError]);

    useEffect(() => {
        if (scope == null || state == null) {
            return;
        }
        setHistoryOpts(historyOptsFor(scope.range, state.ref));
    }, [scope && rangeKey(scope.range), state?.ref]);
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run frontend/app/view/agents/githistorystore.test.ts`
Expected: PASS, 13 tests — the 10 that already existed, unchanged, plus the 3 added above.

- [ ] **Step 6: Checkpoint**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

---

### Task 4: Comparison becomes a range instead of a parallel mode

**Files:**
- Modify: `frontend/app/view/agents/comparestore.ts:34` (derive), `:51` (delete the anchor atom), `:62-74` (exit), `:89-104` (enter)
- Modify: `frontend/app/view/agents/filessurface.tsx:327` (read), `:389-400` (enter/leave), `:481-487` (delete the invalidation effect)
- Modify: `frontend/app/store/keybindings/bindings.ts:617-623` (Escape restores the interrupted range)
- Test: `frontend/app/view/agents/comparestore.test.ts` (create)

**Interfaces:**
- Consumes: `diffScopeAtom` (Task 2), `DiffRange`, `rangeKey` from `./diffscope`.
- Produces: `compareOnAtom` as a derived read-only atom; `enterCompare(cwd, currentBranch)` with the anchor argument removed; `leaveCompare()` which restores the interrupted range.

- [ ] **Step 1: Write the failing test**

Create `frontend/app/view/agents/comparestore.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { globalStore } from "@/app/store/jotaiStore";

const divergence = vi.fn();
const compareChanges = vi.fn();
const compareDiff = vi.fn();
const listBranches = vi.fn();
vi.mock("@/app/store/wshclientapi", () => ({
    RpcApi: {
        GitDivergenceCommand: (...a: any[]) => divergence(...a),
        GitCompareChangesCommand: (...a: any[]) => compareChanges(...a),
        GitCompareDiffCommand: (...a: any[]) => compareDiff(...a),
        ListBranchesCommand: (...a: any[]) => listBranches(...a),
        GitCommitChangesCommand: vi.fn(),
        GitCommitDiffCommand: vi.fn(),
    },
}));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));

import { diffScopeAtom } from "./diffscopeatom";
import { compareOnAtom, enterCompare, leaveCompare } from "./comparestore";
import type { DiffScope } from "./diffscope";

const base: DiffScope = {
    repo: { origin: { kind: "agent", id: "a1" }, label: "jarvis-recall" },
    range: { kind: "session", agentId: "a1" },
};

afterEach(() => {
    divergence.mockReset();
    compareChanges.mockReset();
    listBranches.mockReset();
    globalStore.set(diffScopeAtom, null);
});

describe("comparison as a range", () => {
    it("is off until the stored range says otherwise", () => {
        globalStore.set(diffScopeAtom, base);
        expect(globalStore.get(compareOnAtom)).toBe(false);
    });

    it("turns on by writing the range, and remembers what it interrupted", async () => {
        globalStore.set(diffScopeAtom, base);
        listBranches.mockResolvedValue({ branches: [], default: "main" });
        divergence.mockResolvedValue({ isrepo: true, ahead: [], behind: [], mergebase: "m1" });
        compareChanges.mockResolvedValue({ isrepo: true, statusz: "", numstat: "" });

        await enterCompare("/repo", "feat");

        expect(globalStore.get(compareOnAtom)).toBe(true);
        const range = globalStore.get(diffScopeAtom)!.range;
        expect(range.kind).toBe("compare");
        expect(range.kind === "compare" && range.from).toEqual({ kind: "session", agentId: "a1" });
    });

    // Escape used to call exitCompare, which cleared a boolean and left the surface to work out what
    // to show. The interrupted range is carried, so leaving is a restore rather than a guess.
    it("restores the interrupted range on the way out", async () => {
        globalStore.set(diffScopeAtom, base);
        listBranches.mockResolvedValue({ branches: [], default: "main" });
        divergence.mockResolvedValue({ isrepo: true, ahead: [], behind: [], mergebase: "m1" });
        compareChanges.mockResolvedValue({ isrepo: true, statusz: "", numstat: "" });

        await enterCompare("/repo", "feat");
        leaveCompare();

        expect(globalStore.get(compareOnAtom)).toBe(false);
        expect(globalStore.get(diffScopeAtom)!.range).toEqual({ kind: "session", agentId: "a1" });
    });

    it("does nothing when there is no scope to compare within", async () => {
        await enterCompare("/repo", "feat");
        expect(divergence).not.toHaveBeenCalled();
        expect(globalStore.get(compareOnAtom)).toBe(false);
    });
});
```

- [ ] **Step 2: Extract the scope atom so the store can reach it**

`comparestore.ts` cannot import `agents.tsx` — that is the view model, and importing it from a store would invert the dependency and drag React into a plain module. Move the atom into its own file.

Create `frontend/app/view/agents/diffscopeatom.ts`:

```ts
// frontend/app/view/agents/diffscopeatom.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The Diff surface's stored subject. In its own module, not on the view model, because the git stores
// need to read and write it and must not depend on a React view model. Module scope is also what lets
// the scope survive the surface unmounting on a nav switch.

import { globalStore } from "@/app/store/jotaiStore";
import { atom, type PrimitiveAtom } from "jotai";
import { rangeKey, type DiffRange, type DiffScope } from "./diffscope";

export const diffScopeAtom = atom<DiffScope | null>(null) as PrimitiveAtom<DiffScope | null>;

export function setDiffRange(range: DiffRange): void {
    const scope = globalStore.get(diffScopeAtom);
    if (scope == null || rangeKey(scope.range) === rangeKey(range)) {
        return;
    }
    globalStore.set(diffScopeAtom, { ...scope, range });
}
```

In `agents.tsx`, delete the `diffScopeAtom` declaration added in Task 2 and re-export instead, so callers that reach it through the model keep working:

```ts
    get diffScopeAtom() {
        return diffScopeAtom;
    }
```

with `import { diffScopeAtom } from "./diffscopeatom";` at the top.

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run frontend/app/view/agents/comparestore.test.ts`
Expected: FAIL — `leaveCompare` is not exported and `compareOnAtom` is still a writable boolean.

- [ ] **Step 4: Make comparison a range**

In `frontend/app/view/agents/comparestore.ts`:

Replace `compareOnAtom` (line 34) and delete `compareAnchorAtom` (line 51):

```ts
import { diffScopeAtom } from "./diffscopeatom";
import { rangeKey, type DiffRange } from "./diffscope";

// Derived, not stored: there is exactly one place that says what the surface is showing, so the
// surface can no longer be comparing and in some other scope at the same time.
export const compareOnAtom = atom((get) => get(diffScopeAtom)?.range.kind === "compare");
```

Replace `enterCompare` (lines 89–104):

```ts
// Enter comparison on the checked-out branch against the repository's default branch — the review
// question, and the pair that needs no typing. The range records what it interrupted so leaving is a
// restore rather than a guess; that is also why the old compareAnchorAtom is gone.
export async function enterCompare(cwd: string, currentBranch: string): Promise<void> {
    const scope = globalStore.get(diffScopeAtom);
    if (scope == null) {
        return;
    }
    const from: DiffRange = scope.range.kind === "compare" ? scope.range.from : scope.range;
    globalStore.set(compareErrorAtom, null);
    globalStore.set(compareSidesAtom, null);
    globalStore.set(compareAggregateAtom, null);
    const def = await loadCompareRefsMeta(cwd);
    const prev = globalStore.get(compareRefsAtom);
    const base = prev?.base || def;
    const head = prev?.head || currentBranch;
    globalStore.set(diffScopeAtom, { ...scope, range: { kind: "compare", base, head, from } });
    await setCompareRefs(cwd, base, head);
}

// Restores the range comparison interrupted. Named leaveCompare rather than exitCompare because it
// now moves the surface somewhere specific instead of clearing a flag.
export function leaveCompare(): void {
    const scope = globalStore.get(diffScopeAtom);
    if (scope != null && scope.range.kind === "compare") {
        globalStore.set(diffScopeAtom, { ...scope, range: scope.range.from });
    }
    clearCompareState();
}
```

Rename the body of the old `exitCompare` to `clearCompareState`, keeping every `globalStore.set` it had except the two that no longer exist (`compareOnAtom`, `compareAnchorAtom`), and keep the comment explaining that `compareRefsAtom` survives on purpose.

Also update `setCompareRefs` to write the refs back into the range so the scope stays the single source of truth:

```ts
export async function setCompareRefs(cwd: string, base: string, head: string): Promise<void> {
    globalStore.set(compareRefsAtom, { base, head });
    const scope = globalStore.get(diffScopeAtom);
    if (scope?.range.kind === "compare") {
        globalStore.set(diffScopeAtom, { ...scope, range: { ...scope.range, base, head } });
    }
    // ...rest of the existing body unchanged
```

- [ ] **Step 5: Delete the invalidation effect and update the callers**

In `frontend/app/view/agents/filessurface.tsx`: delete the compare-anchor invalidation effect (lines 481–487) and the `scopeAnchor` local (line 387) entirely — a repository change is now an explicit replacement of the stored scope, so no effect has to detect it. Change `startCompare` to call `enterCompare(state.cwd, state.branch ?? "")` and `leaveCompare` to call the store's `leaveCompare()`.

In `frontend/app/store/keybindings/bindings.ts`, change the Escape binding (lines 617–623) to `run: () => leaveCompare()` and update its import.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run frontend/app/view/agents/comparestore.test.ts`
Expected: PASS, 4 tests.

Run: `npx vitest run frontend/app/view/agents/`
Expected: PASS across the directory.

- [ ] **Step 7: Checkpoint**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

---

### Task 5: The subject bar

This is where the defect actually disappears. Everything before it was groundwork.

**Files:**
- Create: `frontend/app/view/agents/rangestrip.tsx`
- Modify: `frontend/app/view/agents/agentsessionstore.ts` (add a synchronous peek)
- Modify: `frontend/app/view/agents/filessurface.tsx:530-626` (the subject bar)
- Modify: `frontend/app/store/keybindings/bindings.ts:602-615` (the `c` key)
- Modify: `scripts/cdp/scenarios.mjs:2525` (the `git-history` scenario)

**Interfaces:**
- Consumes: `availableRanges`, `rangeKey`, `rangeSummary`, `RangeOption` from `./diffscope`; `setDiffRange` from `./diffscopeatom`; `peekSessionStart` from `./agentsessionstore`.
- Produces: `RangeStrip` component; the DOM hooks `[data-range-chip="<kind>"]` and `[data-files-range-summary]` that the scenario asserts against.

- [ ] **Step 1: Add the synchronous session-start peek**

`availableRanges` needs to know whether an agent has a session start without awaiting. The cache already exists in `agentsessionstore.ts`; it just has no reader. Append to that file:

```ts
// Synchronous read of the memoized value. The range strip needs to know whether an agent has a
// session start in order to decide whether that chip is live, and it cannot await inside a render.
// Returns null when nothing is cached yet — the chip renders disabled and becomes live on its own
// once ensureSessionStart resolves.
export function peekSessionStart(transcriptPath: string | undefined): number | null {
    if (!transcriptPath) {
        return null;
    }
    return cache.get(transcriptPath) ?? null;
}
```

- [ ] **Step 2: Write the range strip component**

Create `frontend/app/view/agents/rangestrip.tsx`:

```tsx
// frontend/app/view/agents/rangestrip.tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The Diff surface's range control. Replaces a three-way segmented control whose click handler did
// nothing outside of comparison mode: a chip is drawn only when it has something to switch to, and a
// chip that is drawn but temporarily unusable carries the disabled attribute and says why, so it takes
// no keyboard focus and is announced as disabled rather than as a button.

import { cn } from "@/util/util";
import { rangeKey, type DiffRange, type RangeOption } from "./diffscope";

export function RangeStrip({
    options,
    active,
    onPick,
}: {
    options: RangeOption[];
    active: DiffRange;
    onPick: (range: DiffRange) => void;
}) {
    const activeKey = rangeKey(active);
    return (
        <div className="flex items-center overflow-hidden rounded-[9px] border border-edge-mid bg-surface">
            {options.map((o) => {
                const selected = o.range.kind === active.kind;
                return (
                    <button
                        key={rangeKey(o.range)}
                        data-range-chip={o.range.kind}
                        disabled={!o.available}
                        title={o.reason}
                        onClick={() => onPick(o.range)}
                        className={cn(
                            "flex items-center gap-[6px] border-r border-edge-faint px-[11px] py-[6px] text-[11.5px] font-semibold last:border-r-0",
                            selected ? "bg-surface-selected text-ink-hi" : "text-muted hover:text-foreground",
                            !o.available && "cursor-not-allowed opacity-40 hover:text-muted"
                        )}
                    >
                        {o.label}
                        {o.detail ? (
                            <span
                                className={cn(
                                    "max-w-[90px] truncate font-mono text-[10.5px]",
                                    selected ? "text-accent-soft" : "text-edge-strong"
                                )}
                            >
                                {o.detail}
                            </span>
                        ) : null}
                    </button>
                );
            })}
            <span className="sr-only">{activeKey}</span>
        </div>
    );
}
```

- [ ] **Step 3: Replace the subject bar**

In `frontend/app/view/agents/filessurface.tsx`, replace the whole subject-bar block (lines 534–626) with:

```tsx
                {/* subject bar: which repository, and which range within it */}
                <div className="flex-none px-[18px] pt-[14px]">
                    <div className="flex items-center gap-[14px] pb-[6px]">
                        <h1 className="flex-none text-[16px] font-bold">Diff</h1>
                        <div className="w-[210px] overflow-hidden rounded-[9px] border border-edge-mid bg-surface">
                            <SourcePicker
                                agents={agents}
                                projects={projects}
                                source={source}
                                onPickAgent={pickAgent}
                                onPickProject={pickProject}
                            />
                        </div>
                        {scope ? (
                            <RangeStrip
                                options={availableRanges(scope, {
                                    sessionStartTs: peekSessionStart(agent?.transcriptPath),
                                    sessionRef: state?.ref ?? "",
                                })}
                                active={scope.range}
                                onPick={(r) =>
                                    r.kind === "compare"
                                        ? startCompare()
                                        : compareOn
                                          ? (leaveCompare(), setDiffRange(r))
                                          : setDiffRange(r)
                                }
                            />
                        ) : null}
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
                        ) : null}
                    </div>
                    {scope ? (
                        <div
                            data-files-range-summary
                            className="pb-[11px] font-mono text-[11.5px] text-ink-faint"
                        >
                            {rangeSummary(scope.range, {
                                branch: state?.branch ?? "",
                                ref: state?.ref ?? "",
                                files: activeChanges?.files.length ?? 0,
                                adds: activeChanges?.adds ?? 0,
                                dels: activeChanges?.dels ?? 0,
                            })}
                        </div>
                    ) : null}
                </div>
```

Delete from the file: the `refExpr` local (lines 378–382), the three-chip `.map` block, and the `Reading` button. Add `pickAgent` / `pickProject` as named callbacks holding the bodies written in Task 2, so the JSX stays readable.

- [ ] **Step 4: Repoint the `c` key**

The comparison key worked by finding `[data-files-ref-expr]` and clicking it. That element no longer exists. In `frontend/app/store/keybindings/bindings.ts` replace the `files:compare` binding (lines 602–615) with:

```ts
        {
            id: "files:compare",
            keys: "c",
            group: "Diff",
            label: "Compare refs",
            when: on,
            run: () => {
                const el = document.querySelector<HTMLElement>('[data-range-chip="compare"]');
                if (el == null) {
                    return false; // no repository scoped -> nothing to compare; let the key pass
                }
                el.click();
            },
        },
```

- [ ] **Step 5: Extend the verification scenario**

In `scripts/cdp/scenarios.mjs`, inside the `git-history` scenario's `assert` function, after the existing step that clicks `[data-files-source-picker]` and selects the healthy repository, add:

```js
        // A project has no session and no run, so exactly two ranges apply. The bug this replaced drew
        // three chips regardless, two of them permanently inert.
        const chips = await h.ev(
            `Array.from(document.querySelectorAll('[data-range-chip]')).map(e => e.dataset.rangeChip + ':' + (e.disabled ? 'off' : 'on')).join(',')`
        );
        rec("project shows two live ranges", chips === "working:on,compare:on", chips);

        // Every chip drawn must be operable — the whole point of the change.
        const dead = await h.ev(
            `Array.from(document.querySelectorAll('[data-range-chip]')).filter(e => !e.disabled && e.offsetParent === null).length`
        );
        rec("no drawn chip is hidden-but-enabled", dead === 0, String(dead));

        const summaryBefore = await h.ev(`document.querySelector('[data-files-range-summary]').textContent`);
        rec("range summary is present", typeof summaryBefore === "string" && summaryBefore.length > 0, summaryBefore);

        // Scroll deep, switch range, and confirm the reader keeps their place: the history read is
        // keyed on directory and filters, so a range change must not blank the list.
        await h.ev(`document.querySelector('[data-history-scroll]').scrollTop = 900`);
        await sleep(200);
        const scrollBefore = await h.ev(`document.querySelector('[data-history-scroll]').scrollTop`);
        await h.ev(`document.querySelector('[data-range-chip="working"]').click()`);
        await sleep(400);
        const scrollAfter = await h.ev(`document.querySelector('[data-history-scroll]').scrollTop`);
        rec("range switch keeps the scroll offset", scrollAfter === scrollBefore, `${scrollBefore} -> ${scrollAfter}`);
```

- [ ] **Step 6: Verify**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

Run: `npx vitest run frontend/app/view/agents/`
Expected: PASS.

Start the dev app (`task dev`) in a separate terminal, wait for the window, then run: `task verify:ui -- git-history surface-smoke`
Expected: both scenarios PASS. If the Chrome DevTools Protocol connection is refused on port 9222, the dev app is not running or crashed — check its log before assuming a code fault.

- [ ] **Step 7: Checkpoint**

Open the Diff tab in the running dev app and confirm by eye: clicking every chip changes the panes, the greyed chip (if any) cannot be focused with Tab, and no control in the bar does nothing when clicked.

---

### Task 6: One helper for every deep link into the surface

**Files:**
- Modify: `frontend/app/view/agents/agentdiffnav.ts` (becomes the home of `openDiff`)
- Modify: `frontend/app/view/agents/runcompletionsurface.tsx:41-47`
- Modify: `frontend/app/view/agents/agentdetailsrail.tsx:83-89`
- Modify: `frontend/app/view/agents/runcompletion.ts:90-96` (delete `runFileNavIntent`)
- Test: `frontend/app/view/agents/agentdiffnav.test.ts`

**Interfaces:**
- Consumes: `diffScopeAtom`, `scopeKey`, `defaultRangeFor`, `requestFileLink`.
- Produces: `openDiff(model, scope, file?)` — the single entry point for arriving at the Diff surface from anywhere else.

- [ ] **Step 1: Write the failing test**

Replace `frontend/app/view/agents/agentdiffnav.test.ts` with:

```ts
import { describe, expect, it, vi } from "vitest";
import { globalStore } from "@/app/store/jotaiStore";

const requestFileLink = vi.fn();
vi.mock("./filesstore", () => ({ requestFileLink: (...a: any[]) => requestFileLink(...a) }));

import { agentDiffScope, openDiff, runDiffScope } from "./agentdiffnav";
import { diffScopeAtom } from "./diffscopeatom";
import { scopeKey } from "./diffscope";

const model = { diffScopeAtom, surfaceAtom: { init: "cockpit" } } as any;

describe("openDiff", () => {
    it("stores the scope and switches to the Diff surface", () => {
        const scope = agentDiffScope("a1", "jarvis-recall");
        openDiff(model, scope);
        expect(globalStore.get(diffScopeAtom)).toEqual(scope);
    });

    // The link and the load must name the scope with the same string, or the request is never claimed
    // and the surface opens on its first file instead of the one that was clicked.
    it("requests the file link under the same key the loader will use", () => {
        requestFileLink.mockClear();
        const scope = runDiffScope("r1", "/repo", "9f2c1de");
        openDiff(model, scope, "pkg/jarvis/evidence.go");
        expect(requestFileLink).toHaveBeenCalledWith(scopeKey(scope), "pkg/jarvis/evidence.go");
    });

    it("skips the link request when no file was named", () => {
        requestFileLink.mockClear();
        openDiff(model, agentDiffScope("a1", "jarvis-recall"));
        expect(requestFileLink).not.toHaveBeenCalled();
    });

    it("opens a run on the run range and an agent on its session range", () => {
        expect(runDiffScope("r1", "/repo", "9f2c1de").range).toEqual({
            kind: "run",
            runId: "r1",
            baseCommit: "9f2c1de",
        });
        expect(agentDiffScope("a1", "n").range).toEqual({ kind: "session", agentId: "a1" });
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run frontend/app/view/agents/agentdiffnav.test.ts`
Expected: FAIL — `openDiff` is not exported.

- [ ] **Step 3: Write the helper**

Replace the body of `frontend/app/view/agents/agentdiffnav.ts` with:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Every way into the Diff surface from elsewhere in the cockpit. One helper rather than a sequence
// each caller assembles, because the file link and the change-list load have to name the scope with
// the same string: a link built from a different one is silently never claimed, and the surface opens
// on its first file instead of the one that was clicked.

import { globalStore } from "@/app/store/jotaiStore";
import { defaultRangeFor, scopeKey, type DiffOrigin, type DiffScope } from "./diffscope";
import { diffScopeAtom } from "./diffscopeatom";
import { requestFileLink } from "./filesstore";
import type { AgentsViewModel } from "./agents";

export function agentDiffScope(agentId: string, label: string): DiffScope {
    const origin: DiffOrigin = { kind: "agent", id: agentId };
    return { repo: { origin, label }, range: defaultRangeFor(origin) };
}

export function runDiffScope(runId: string, cwd: string, baseCommit: string): DiffScope {
    const origin: DiffOrigin = { kind: "run", runId, cwd, baseCommit };
    return { repo: { origin, label: `run ${runId.slice(0, 8)}` }, range: defaultRangeFor(origin) };
}

export function projectDiffScope(name: string, path: string): DiffScope {
    const origin: DiffOrigin = { kind: "project", name, path };
    return { repo: { origin, label: name }, range: defaultRangeFor(origin) };
}

// The file link is requested before the surface switch because the surface's mount triggers the load
// that consumes it.
export function openDiff(model: AgentsViewModel, scope: DiffScope, file?: string): void {
    if (file) {
        requestFileLink(scopeKey(scope), file);
    }
    globalStore.set(model.diffScopeAtom, scope);
    globalStore.set(model.surfaceAtom, "files");
}
```

- [ ] **Step 4: Point both callers at it**

In `frontend/app/view/agents/runcompletionsurface.tsx`, delete the local `openRunDiff` and replace its two call sites (lines 179 and 245) with:

```tsx
onClick={() => openDiff(model, runDiffScope(run.id, run.projectpath, run.basecommit ?? ""), f.path)}
```

and

```tsx
onClick={() => openDiff(model, runDiffScope(run.id, run.projectpath, run.basecommit ?? ""))}
```

Delete `runFileNavIntent` from `frontend/app/view/agents/runcompletion.ts` (lines 90–96) and its now-unused `RunFileNavIntent` type, plus the import in the surface.

In `frontend/app/view/agents/agentdetailsrail.tsx`, replace the local `openDiff` closure (lines 83–89) with:

```tsx
    const openFileDiff = (path?: string) => {
        globalStore.set(model.focusIdAtom, agent.id);
        openDiff(model, agentDiffScope(agent.id, agent.name), railState?.cwd && path ? path : undefined);
    };
```

and update its call sites and imports accordingly.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run frontend/app/view/agents/`
Expected: PASS across the directory, including the deep-link cases in the change-list store's tests and the history store's tests.

- [ ] **Step 6: Checkpoint**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

Run: `npx eslint frontend/app/view/agents/ frontend/app/store/keybindings/bindings.ts`
Expected: no new errors. Pre-existing warnings elsewhere in the repo are not yours.

---

### Task 7: Final verification and the single commit

**Files:** all of the above, plus `docs/superpowers/specs/2026-08-06-diff-scope-model-design.md` and `docs/superpowers/plans/2026-08-06-diff-scope-model.md`.

- [ ] **Step 1: Full unit suite**

Run: `npx vitest run`
Expected: PASS. Note the count and compare against the baseline before this work started.

- [ ] **Step 2: Full typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0, no output.

- [ ] **Step 3: Rendered verification**

With the dev app running, run: `task verify:ui -- git-history surface-smoke`
Expected: both PASS. Review the contact sheet at `cdp-shots/index.html`.

- [ ] **Step 4: Self-review the diff**

Run: `git diff` and read it start to finish. Check specifically for: leftover references to `filesRunAtom`, `filesProjectSelAtom`, `compareAnchorAtom`, `exitCompare`, `agentScope`, `runScope`, `projectScope`, `refExpr` or `data-files-ref-expr`; any raw hex or rgba color introduced in a component; any commented-out code or debug logging.

Run: `grep -rn "filesRunAtom\|filesProjectSelAtom\|compareAnchorAtom\|data-files-ref-expr" frontend/`
Expected: no matches.

- [ ] **Step 5: Ask for approval, then commit once**

Do not run this step without the user's explicit go-ahead — the project rule is that nothing is committed without approval, batched into one commit at the end.

```bash
git add frontend/app/view/agents/ frontend/app/store/keybindings/bindings.ts scripts/cdp/scenarios.mjs docs/superpowers/specs/2026-08-06-diff-scope-model-design.md docs/superpowers/plans/2026-08-06-diff-scope-model.md
git commit -m "refactor(diff): scope was a conclusion four variables implied, so no control could set it and three chips rendered as dead buttons; it is now one stored value"
```

---

## Self-Review

**Spec coverage.** Every section of `2026-08-06-diff-scope-model-design.md` maps to a task: the state model to Task 1; the single change-list loader to Task 2; the range-free history key and relabel-without-reload to Task 3; comparison as a range, with the anchor atom deleted, to Task 4; the range strip, the absent-versus-disabled rule and the deleted "Reading" button to Task 5; the single deep-link helper to Task 6; the full verification gates to Task 7. The spec's rollout order is preserved — the risky store rewiring (Tasks 2–4) lands while the old bar is still on screen, so a regression there is unambiguous.

**Two deviations from the spec, both flagged in place.** The spec lists `rangeOptsFor` as a pure export of the scope module; it needs an async transcript read for the session range, so it lives in the change-list store as `resolveRangeOpts` (noted in Task 1). The spec says the stored repository holds no resolved directory; that is right for an agent but wrong for a project (its path is registry data) and a run (its directory was captured at run time and exists nowhere else), so `DiffOrigin` carries a path for those two (noted in Task 1, and it needs your sign-off).

**One structural decision the spec did not anticipate.** The scope atom cannot live on the view model in `agents.tsx` as the spec assumed, because `comparestore.ts` needs to read and write it and a plain store must not import a React view model. Task 4 moves it to its own module, `diffscopeatom.ts`, with the view model re-exporting it so callers that reach it through the model still work.

**Placeholder scan.** No "TBD", no "handle errors appropriately", no "similar to Task N". Every code step carries the actual code; every test step carries the actual assertions.

**Type consistency.** `scopeKey`, `historyKey`, `rangeKey`, `originCwd`, `defaultRangeFor`, `availableRanges`, `historyOptsFor`, `rangeSummary`, `setDiffRange`, `setHistoryOpts`, `loadFilesForScope`, `enterCompare`, `leaveCompare`, `openDiff`, `agentDiffScope`, `runDiffScope`, `projectDiffScope`, `peekSessionStart` are each defined in exactly one task and spelled identically everywhere they are consumed.
