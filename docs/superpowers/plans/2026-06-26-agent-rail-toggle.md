# Agent Rail Toggle + Real Details Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Agent (focus) surface's right details rail toggleable (default off, persisted, global) and replace its dead chrome (fake `"main"` branch, static placeholder files, disabled Stop/Resume/Pause, placeholder suggestion chips) with real data driven by existing RPCs.

**Architecture:** Pure frontend — no new Go, no new RPCs. A new `railstore.ts` holds the persisted toggle atom (`atomWithStorage`) plus a thin git loader (branch + changed-file list, no per-file diff) that mirrors `filesstore.ts`. The shared transcript→cwd resolver is factored out of `filesstore.ts` so both stores use one copy. Stop/Resume drive the agent's terminal block via the existing `ControllerInputCommand` (ESC interrupts; `"continue\r"` nudges). The transcript header gains Model + Context% chips and the rail-toggle button (in the slot the removed Pause button vacates).

**Tech Stack:** React 19, jotai (+ `jotai/utils` `atomWithStorage`), Tailwind 4 (@theme tokens), TypeScript, wshrpc (`GitChangesCommand`, `GetAgentTranscriptCommand`, `ControllerInputCommand`), vitest.

---

## Git workflow (project override)

This project's CLAUDE.md mandates a STRICT git workflow that **overrides** the writing-plans default of one commit per task:

- **Do NOT commit after each task.** Each task ends with a `git add` (stage) step only.
- The **final task** (Task 8) shows the staged file list + the single `type(scope): description` message, asks for explicit approval, and only then commits **once**.
- The plan doc and the `docs/deferred.md` edit fold into that same feature commit (spec/plan docs are not a separate docs-only commit).

## File Structure

**New files:**
- `frontend/app/view/agents/agentcwdresolve.ts` — RPC-backed `resolveCwd(transcriptPath)` shared by the Files surface and the Agent rail. Wraps `GetAgentTranscriptCommand` + the pure `agentCwd` parser. (Extracted from `filesstore.ts`.)
- `frontend/app/view/agents/railstore.ts` — `railVisibleAtom` (persisted toggle), `railStateAtom` (git data), `loadRailForAgent(id, transcriptPath)` loader. Mirrors `filesstore.ts` minus the per-file diff.

**Modified files:**
- `frontend/app/view/agents/gitstatus.ts` — add shared `STATUS_COLOR`/`statusColor` (moved from `filessurface.tsx`) and a pure `capFiles(files, cap)` helper for the rail's "+N more" cap.
- `frontend/app/view/agents/gitstatus.test.ts` — tests for `capFiles`.
- `frontend/app/view/agents/filesstore.ts` — import shared `resolveCwd`; delete the private copy.
- `frontend/app/view/agents/filessurface.tsx` — import `statusColor` from `gitstatus.ts`; delete the local copy.
- `frontend/app/view/agents/agentsurface.tsx` — render `<AgentDetailsRail>` only when `railVisibleAtom`; add `d` key to toggle it.
- `frontend/app/view/agents/agenttranscript.tsx` — add Model + Context% chips; drop the fake `· main` subline; remove the disabled Pause button and add the rail-toggle button in its slot; remove `PLACEHOLDER_SUGGESTIONS` + the chip block.
- `frontend/app/view/agents/agentdetailsrail.tsx` — real Branch + Files-touched (from `railStateAtom`); real Stop/Resume (via `ControllerInputCommand`); remove `PLACEHOLDER_FILES`; trigger `loadRailForAgent` on mount/focus-change.
- `docs/deferred.md` — update the Phase-1b placeholder entry (Branch/Files/Stop/Resume/suggestions now real or removed); add the cumulative-session-tokens deferral.

**Why this decomposition:** `resolveCwd` is the single genuinely-shared loader between Files and the rail, so it gets its own tiny module rather than coupling the two stores. `STATUS_COLOR`/`statusColor`/`capFiles` are pure GitChange-presentation helpers, so they live in the pure (already-tested, no-React) `gitstatus.ts` where both consumers import them. The toggle atom + rail loader co-locate in `railstore.ts` because they share the rail's lifecycle.

---

### Task 1: Shared cwd resolver

Extract the private `resolveCwd` out of `filesstore.ts` into a shared module so the rail loader (Task 3) can reuse it without duplicating the transcript-tail read. `agentcwd.ts` stays pure (it's unit-tested as pure) — the RPC wrapper gets its own file.

**Files:**
- Create: `frontend/app/view/agents/agentcwdresolve.ts`
- Modify: `frontend/app/view/agents/filesstore.ts:17` (delete `CWD_TAIL_LINES`), `:67-77` (delete private `resolveCwd`), and the import block.

- [ ] **Step 1: Create the shared resolver**

Create `frontend/app/view/agents/agentcwdresolve.ts`:

```typescript
// frontend/app/view/agents/agentcwdresolve.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// RPC-backed cwd resolver shared by the Files surface and the Agent details rail: tail the
// agent's transcript and extract its working directory. The pure parse lives in agentcwd.ts;
// this wrapper adds the GetAgentTranscriptCommand read so agentcwd.ts stays Wave-free + pure-tested.

import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { agentCwd } from "./agentcwd";

const CWD_TAIL_LINES = 200;

export async function resolveCwd(transcriptPath: string | undefined): Promise<string | null> {
    if (!transcriptPath) {
        return null;
    }
    try {
        const rtn = await RpcApi.GetAgentTranscriptCommand(TabRpcClient, {
            path: transcriptPath,
            maxlines: CWD_TAIL_LINES,
        });
        return agentCwd(rtn?.lines ?? []);
    } catch {
        return null;
    }
}
```

- [ ] **Step 2: Point `filesstore.ts` at the shared resolver**

In `frontend/app/view/agents/filesstore.ts`:

Add the import (alongside the existing `./agentcwd`-area imports):

```typescript
import { resolveCwd } from "./agentcwdresolve";
```

Delete the now-unused `agentCwd` import line if `filesstore.ts` no longer references `agentCwd` directly (it won't — only `resolveCwd` used it). Verify with a search; keep `parseUnifiedDiff`/`plainFileView`/`parseGitChanges` imports.

Delete the constant (line 17):

```typescript
const CWD_TAIL_LINES = 200;
```

Delete the private function (lines 67-77):

```typescript
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
```

The remaining `loadFilesForAgent` already calls `resolveCwd(transcriptPath)` — now resolved from the import. No other change.

- [ ] **Step 3: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: no new errors beyond the 3 pre-existing `frontend/tauri/api.test.ts` baseline errors. In particular, no "agentCwd is declared but never read" or unused-import error in `filesstore.ts`.

- [ ] **Step 4: Run the existing agent tests (regression guard)**

Run: `npx vitest run frontend/app/view/agents/agentcwd.test.ts`
Expected: PASS (the pure `agentcwd.ts` is untouched).

- [ ] **Step 5: Stage**

```bash
git add frontend/app/view/agents/agentcwdresolve.ts frontend/app/view/agents/filesstore.ts
```

(No commit — see "Git workflow" above.)

---

### Task 2: Pure git-presentation helpers in `gitstatus.ts`

Move the `STATUS_COLOR`/`statusColor` mapping out of the Files view into the pure `gitstatus.ts` module (single source for both Files surface + rail) and add a `capFiles` helper for the rail's narrow-width "+N more" cap. TDD `capFiles`.

**Files:**
- Modify: `frontend/app/view/agents/gitstatus.ts` (append helpers)
- Modify: `frontend/app/view/agents/gitstatus.test.ts` (append `capFiles` tests)
- Modify: `frontend/app/view/agents/filessurface.tsx:17-25` (delete local copy, import from gitstatus)

- [ ] **Step 1: Write the failing test for `capFiles`**

Append to `frontend/app/view/agents/gitstatus.test.ts`:

```typescript
import { capFiles } from "./gitstatus";

describe("capFiles", () => {
    const mk = (path: string) => ({ path, status: "M", adds: 0, dels: 0 });

    it("returns all files and more=0 when at or under the cap", () => {
        const files = [mk("a.ts"), mk("b.ts")];
        expect(capFiles(files, 8)).toEqual({ shown: files, more: 0 });
    });

    it("truncates to the cap and reports the remainder", () => {
        const files = Array.from({ length: 11 }, (_, i) => mk(`f${i}.ts`));
        const r = capFiles(files, 8);
        expect(r.shown).toHaveLength(8);
        expect(r.shown[0].path).toBe("f0.ts");
        expect(r.more).toBe(3);
    });

    it("handles an empty list", () => {
        expect(capFiles([], 8)).toEqual({ shown: [], more: 0 });
    });
});
```

(`describe`/`it`/`expect` are already imported at the top of the file from `vitest`. Add the `capFiles` import next to the existing `parseGitChanges` import, or as the line shown above — keep one import per symbol consistent with the file.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run frontend/app/view/agents/gitstatus.test.ts`
Expected: FAIL — `capFiles` is not exported (`No "capFiles" export is defined`).

- [ ] **Step 3: Add the helpers to `gitstatus.ts`**

Append to `frontend/app/view/agents/gitstatus.ts` (after `parseGitChanges`):

```typescript
// Tailwind text-color per git status — shared by the Files surface and the Agent details rail.
export const STATUS_COLOR: Record<string, string> = {
    A: "text-success",
    M: "text-accent",
    R: "text-accent",
    C: "text-accent",
    D: "text-error",
    "?": "text-ink-mid",
};

export const statusColor = (s: string): string => STATUS_COLOR[s] ?? "text-ink-mid";

// Pure: cap a changed-file list for a narrow surface (the 296px rail). Returns the first `cap`
// files and the count hidden behind a "+N more" affordance.
export function capFiles(files: GitChange[], cap: number): { shown: GitChange[]; more: number } {
    if (files.length <= cap) {
        return { shown: files, more: 0 };
    }
    return { shown: files.slice(0, cap), more: files.length - cap };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run frontend/app/view/agents/gitstatus.test.ts`
Expected: PASS (all `parseGitChanges` + new `capFiles` cases green).

- [ ] **Step 5: Point `filessurface.tsx` at the shared `statusColor`**

In `frontend/app/view/agents/filessurface.tsx`, delete the local mapping (lines 17-25):

```typescript
const STATUS_COLOR: Record<string, string> = {
    A: "text-success",
    M: "text-accent",
    R: "text-accent",
    C: "text-accent",
    D: "text-error",
    "?": "text-ink-mid",
};
const statusColor = (s: string) => STATUS_COLOR[s] ?? "text-ink-mid";
```

Update the existing `gitstatus` import line:

```typescript
import type { GitChange } from "./gitstatus";
```

to:

```typescript
import { statusColor, type GitChange } from "./gitstatus";
```

The component already calls `statusColor(change.status)` — no further change.

- [ ] **Step 6: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: no new errors beyond the 3-error baseline.

- [ ] **Step 7: Stage**

```bash
git add frontend/app/view/agents/gitstatus.ts frontend/app/view/agents/gitstatus.test.ts frontend/app/view/agents/filessurface.tsx
```

---

### Task 3: `railstore.ts` — toggle atom + thin git loader

The toggle pref and the rail's git data live here. The loader mirrors `filesstore.ts::loadFilesForAgent` but stops after `GitChangesCommand` — no `GitDiffCommand` (the rail shows the file list, not the diff).

**Files:**
- Create: `frontend/app/view/agents/railstore.ts`

- [ ] **Step 1: Create the store**

Create `frontend/app/view/agents/railstore.ts`:

```typescript
// frontend/app/view/agents/railstore.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Agent details-rail state: the rail visibility toggle (global, persisted) + a thin git load
// (branch + changed-file list, no per-file diff). Mirrors filesstore.ts but lighter — the rail
// shows the list, not the diff. cwd resolution is shared via agentcwdresolve.ts.

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { atom, type PrimitiveAtom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { resolveCwd } from "./agentcwdresolve";
import { parseGitChanges, type GitChanges } from "./gitstatus";

export interface RailGitState {
    cwd: string | null;
    branch: string;
    isRepo: boolean;
    changes: GitChanges | null;
}

// First persisted FE pref in frontend/app: rail is global + off by default (localStorage key
// "agent.rail.visible"). Keep persisted prefs to this one atom for now.
export const railVisibleAtom = atomWithStorage("agent.rail.visible", false);

export const railStateAtom = atom<RailGitState | null>(null) as PrimitiveAtom<RailGitState | null>;

// guards against a stale focus's load overwriting a newer one (same pattern as filesstore.ts)
const current = { id: "" };

const EMPTY: RailGitState = { cwd: null, branch: "", isRepo: false, changes: null };

export async function loadRailForAgent(id: string, transcriptPath: string | undefined): Promise<void> {
    current.id = id;
    globalStore.set(railStateAtom, null);

    const cwd = await resolveCwd(transcriptPath);
    if (current.id !== id) {
        return;
    }
    if (!cwd) {
        globalStore.set(railStateAtom, EMPTY);
        return;
    }
    try {
        const ch = await RpcApi.GitChangesCommand(TabRpcClient, { cwd });
        if (current.id !== id) {
            return;
        }
        const changes = ch.isrepo ? parseGitChanges(ch.statusz, ch.numstat) : null;
        globalStore.set(railStateAtom, { cwd, branch: ch.branch, isRepo: ch.isrepo, changes });
    } catch {
        if (current.id === id) {
            globalStore.set(railStateAtom, { ...EMPTY, cwd });
        }
    }
}
```

- [ ] **Step 2: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: no new errors beyond the 3-error baseline. (`atomWithStorage` from `jotai/utils` is already used elsewhere in the repo — `preview-model.tsx` imports `loadable` from the same path, so the dep resolves.)

- [ ] **Step 3: Stage**

```bash
git add frontend/app/view/agents/railstore.ts
```

---

### Task 4: Toggle the rail in `agentsurface.tsx` (render gate + `d` key)

Render `<AgentDetailsRail>` only when `railVisibleAtom` is true; the `flex-1` center self-heals to full width when the rail is gone (no CSS change). Bind `d` in the existing keydown handler. (`d` is free: the surface handler only uses `Esc`/`←`/`→`/`t`, and the only global key chord is Ctrl/Cmd+N in `cockpit-root.tsx` — verified.)

**Files:**
- Modify: `frontend/app/view/agents/agentsurface.tsx`

- [ ] **Step 1: Import the toggle atom + read it**

Add the import (next to the other `./` imports):

```typescript
import { railVisibleAtom } from "./railstore";
```

Add the atom read alongside the other `useAtomValue` calls near the top of `AgentSurface`:

```typescript
    const railVisible = useAtomValue(railVisibleAtom);
```

- [ ] **Step 2: Add the `d` key to the keydown handler**

In `onKeyDown`, add a new branch after the `t` branch (before the closing `}`):

```typescript
        } else if (e.key === "d") {
            e.preventDefault();
            globalStore.set(railVisibleAtom, !globalStore.get(railVisibleAtom));
        }
```

(The existing guard at the top of `onKeyDown` already early-returns when the target is an `INPUT`/`TEXTAREA`/contentEditable, so typing `d` in the composer never toggles the rail.)

- [ ] **Step 3: Gate the rail render**

Replace:

```typescript
            <AgentDetailsRail model={model} agent={agent} />
```

with:

```typescript
            {railVisible ? <AgentDetailsRail model={model} agent={agent} /> : null}
```

- [ ] **Step 4: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: no new errors beyond the 3-error baseline.

- [ ] **Step 5: Stage**

```bash
git add frontend/app/view/agents/agentsurface.tsx
```

---

### Task 5: Transcript header/footer — chips, toggle button, remove dead chrome

Add Model + Context% chips after the state badge; drop the fake `· main` subline (project only); replace the disabled Pause button with the rail-toggle button; remove the placeholder suggestion chips + the const.

**Files:**
- Modify: `frontend/app/view/agents/agenttranscript.tsx`

- [ ] **Step 1: Add imports + a context-color map**

Add to the imports at the top:

```typescript
import { cn } from "@/util/util";
import { railVisibleAtom } from "./railstore";
```

Update the existing `./agentsviewmodel` import to also pull `usageLevel`:

```typescript
import { formatAge, projectOf, toggleSelection, usageLevel, type AgentVM } from "./agentsviewmodel";
```

Delete the placeholder const (lines 22-23):

```typescript
// PLACEHOLDER (1b): no suggestion generator — see spec §8. Disabled, for visual parity with the handoff footer.
const PLACEHOLDER_SUGGESTIONS = ["Looks good, continue", "Run the tests", "Explain your plan"];
```

Add a context-% text-color map next to the existing `STATE_COLOR`/`STATE_LABEL` consts:

```typescript
// header Context % chip color by occupancy band (mirrors the rail gauge, as text not fill)
const CTX_TEXT: Record<"ok" | "warn" | "hot", string> = {
    ok: "text-accent",
    warn: "text-warning",
    hot: "text-error",
};
```

- [ ] **Step 2: Read the toggle atom in the component**

Add alongside the other `useAtomValue` calls at the top of `AgentTranscript`:

```typescript
    const railVisible = useAtomValue(railVisibleAtom);
```

- [ ] **Step 3: Add Model + Context% chips after the state badge**

In the header, the state badge is the `<span>` rendering `STATE_LABEL[agent.state]` inside the `flex items-center gap-[9px]` row. Add the two chips immediately after that `</span>`, still inside the same flex row:

```tsx
                        {agent.model ? (
                            <span className="rounded-[5px] border border-edge-mid px-[7px] py-[1px] font-mono text-[10.5px] font-medium text-muted">
                                {agent.model}
                            </span>
                        ) : null}
                        {agent.usage?.contextpct != null ? (
                            <span
                                className={cn(
                                    "font-mono text-[10.5px] font-semibold",
                                    CTX_TEXT[usageLevel(agent.usage.contextpct)]
                                )}
                            >
                                {Math.round(agent.usage.contextpct)}%
                            </span>
                        ) : null}
```

- [ ] **Step 4: Drop the fake `· main` subline**

Replace the subline block (lines 97-100):

```tsx
                    {/* PLACEHOLDER (1b): branch has no data source — see spec §8 */}
                    <div className="mt-[2px] font-mono text-[11px] font-medium text-muted">
                        {project ? `${project} · ` : ""}main
                    </div>
```

with (project only — branch now lives in the rail):

```tsx
                    <div className="mt-[2px] font-mono text-[11px] font-medium text-muted">{project || "—"}</div>
```

- [ ] **Step 5: Replace the disabled Pause button with the rail-toggle button**

Replace the Pause button block (lines 110-118):

```tsx
                {/* DISABLED (1b): no lifecycle RPC — see spec §8 */}
                <button
                    type="button"
                    disabled
                    title="coming soon"
                    className="cursor-not-allowed rounded-[7px] border border-edge-mid bg-surface-raised px-[11px] py-[6px] text-[12px] font-medium text-muted opacity-50"
                >
                    Pause
                </button>
```

with the toggle button (occupies the same slot, after "Open terminal"):

```tsx
                <button
                    type="button"
                    onClick={() => globalStore.set(railVisibleAtom, !railVisible)}
                    title={railVisible ? "Hide details (d)" : "Show details (d)"}
                    aria-pressed={railVisible}
                    className={cn(
                        "rounded-[7px] border px-[9px] py-[6px]",
                        railVisible
                            ? "border-accent bg-accentbg text-accent"
                            : "border-edge-mid bg-surface-raised text-[#aeb6bf] hover:border-edge-strong"
                    )}
                >
                    <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6">
                        <rect x="3" y="4" width="14" height="12" rx="2" />
                        <line x1="13" y1="4" x2="13" y2="16" />
                    </svg>
                </button>
```

- [ ] **Step 6: Remove the placeholder suggestion chips from the footer**

Replace the footer block (lines 174-194):

```tsx
            {/* footer: suggestion chips (placeholder) + composer */}
            <div className="shrink-0 border-t border-[#1a1f26] bg-background px-[22px] pb-[16px] pt-[14px]">
                <div className="mx-auto max-w-[720px]">
                    <div className="mb-[11px] flex flex-wrap gap-[8px]">
                        {PLACEHOLDER_SUGGESTIONS.map((s) => (
                            <button
                                key={s}
                                type="button"
                                disabled
                                title="coming soon"
                                className="cursor-not-allowed rounded-[20px] border border-warning/30 bg-warning/10 px-[13px] py-[5px] text-[12px] font-medium text-[#e6cd97] opacity-60"
                            >
                                {s}
                            </button>
                        ))}
                    </div>
                    <div ref={composerWrapRef}>
                        <AgentComposer blockId={agent.blockId} placeholder={`message ${agent.name}…`} />
                    </div>
                </div>
            </div>
```

with (composer only):

```tsx
            {/* footer: composer */}
            <div className="shrink-0 border-t border-[#1a1f26] bg-background px-[22px] pb-[16px] pt-[14px]">
                <div className="mx-auto max-w-[720px]">
                    <div ref={composerWrapRef}>
                        <AgentComposer blockId={agent.blockId} placeholder={`message ${agent.name}…`} />
                    </div>
                </div>
            </div>
```

- [ ] **Step 7: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: no new errors beyond the 3-error baseline. (Confirm no "PLACEHOLDER_SUGGESTIONS is declared but never read" or unused-import errors.)

- [ ] **Step 8: Stage**

```bash
git add frontend/app/view/agents/agenttranscript.tsx
```

---

### Task 6: Rail content made real (`agentdetailsrail.tsx`)

Trigger `loadRailForAgent` on mount (= rail-open) and focus change; render the real branch + capped files-touched from `railStateAtom`; wire Stop (ESC) / Resume (`"continue\r"`) through `ControllerInputCommand`, disabled when there's no live terminal block.

**Files:**
- Modify: `frontend/app/view/agents/agentdetailsrail.tsx`

- [ ] **Step 1: Update imports + add the files cap constant**

Replace the import block (lines 4-17) so it includes React's `useEffect`, the RPC plumbing, the util helpers, the rail store, and the git helpers:

```typescript
import { cn, fireAndForget, stringToBase64 } from "@/util/util";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { useAtomValue } from "jotai";
import { useEffect } from "react";
import type { AgentsViewModel } from "./agents";
import {
    formatAge,
    formatTokens,
    projectOf,
    recentActions,
    summarizeActions,
    usageLevel,
    type AgentVM,
} from "./agentsviewmodel";
import { capFiles, statusColor } from "./gitstatus";
import { liveEntriesByIdAtom } from "./livetranscript";
import { loadRailForAgent, railStateAtom } from "./railstore";
import { getSubagentsAtom } from "./session-models/agentstatusstore";
```

Add the cap constant next to the existing `DefaultContextMax`/`GAUGE_FILL` consts:

```typescript
const RailFilesCap = 8; // a 296px rail can't show a large worktree; overflow folds into "+N more"
```

Delete the placeholder files const (lines 26-31):

```typescript
// PLACEHOLDER (1b): no git status source — see spec §8. Static sample matching the handoff.
const PLACEHOLDER_FILES: { status: string; path: string; color: string }[] = [
    { status: "M", path: "src/auth.ts", color: "text-success" },
    { status: "M", path: "src/session.ts", color: "text-success" },
    { status: "+", path: "middleware/store.ts", color: "text-accent" },
];
```

- [ ] **Step 2: Load on mount/focus-change + read the rail state + derive helpers**

At the top of the `AgentDetailsRail` component body, after the existing `subs`/`entries`/`project`/`usage`/`ctxPct`/`tools` derivations, add:

```typescript
    const railState = useAtomValue(railStateAtom);

    useEffect(() => {
        fireAndForget(() => loadRailForAgent(agent.id, agent.transcriptPath));
    }, [agent.id, agent.transcriptPath]);

    const { shown: shownFiles, more: moreFiles } = capFiles(railState?.changes?.files ?? [], RailFilesCap);

    const noTerminal = agent.blockId == null;
    const drive = (data: string) => {
        if (!agent.blockId) {
            return;
        }
        fireAndForget(() =>
            RpcApi.ControllerInputCommand(TabRpcClient, {
                blockid: agent.blockId!,
                inputdata64: stringToBase64(data),
            })
        );
    };
```

- [ ] **Step 3: Make the Branch row real**

Replace the Branch row (lines 70-71):

```tsx
                    {/* PLACEHOLDER (1b): git branch has no data source — see spec §8 */}
                    <DetailRow label="Branch" value="main" />
```

with:

```tsx
                    <DetailRow label="Branch" value={railState?.branch || "—"} />
```

- [ ] **Step 4: Make the Files-touched section real**

Replace the Files-touched section (lines 152-165):

```tsx
            <div>
                <div className="mb-[11px]">
                    <SectionLabel>Files touched</SectionLabel>
                </div>
                {/* PLACEHOLDER (1b): no git status source — see spec §8 */}
                <div className="flex flex-col gap-[7px]">
                    {PLACEHOLDER_FILES.map((f) => (
                        <div key={f.path} className="flex items-center gap-[8px] font-mono text-[11.5px] font-medium text-[#aeb6bf]">
                            <span className={f.color}>{f.status}</span>
                            {f.path}
                        </div>
                    ))}
                </div>
            </div>
```

with:

```tsx
            <div>
                <div className="mb-[11px]">
                    <SectionLabel>Files touched</SectionLabel>
                </div>
                {railState == null ? (
                    <div className="text-[11.5px] text-muted">Loading…</div>
                ) : !railState.isRepo ? (
                    <div className="text-[11.5px] text-muted">Not a git repository</div>
                ) : shownFiles.length === 0 ? (
                    <div className="text-[11.5px] text-muted">No changes</div>
                ) : (
                    <div className="flex flex-col gap-[7px]">
                        {shownFiles.map((f) => (
                            <div
                                key={f.path}
                                className="flex items-center gap-[8px] font-mono text-[11.5px] font-medium text-[#aeb6bf]"
                            >
                                <span className={cn("flex-none font-bold", statusColor(f.status))}>{f.status}</span>
                                <span className="min-w-0 truncate">{f.path}</span>
                            </div>
                        ))}
                        {moreFiles > 0 ? <div className="text-[11px] text-muted">+{moreFiles} more</div> : null}
                    </div>
                )}
            </div>
```

- [ ] **Step 5: Make Stop/Resume real**

Replace the disabled button block (lines 167-185):

```tsx
            {/* DISABLED (1b): no agent-lifecycle RPC — see spec §8 */}
            <div className="mt-[4px] flex gap-[8px]">
                <button
                    type="button"
                    disabled
                    title="coming soon"
                    className="flex-1 cursor-not-allowed rounded-[8px] border border-edge-mid bg-surface-raised py-[8px] text-[12px] font-medium text-muted opacity-50"
                >
                    Resume
                </button>
                <button
                    type="button"
                    disabled
                    title="coming soon"
                    className="flex-1 cursor-not-allowed rounded-[8px] border border-error/30 bg-transparent py-[8px] text-[12px] font-medium text-error opacity-50"
                >
                    Stop
                </button>
            </div>
```

with (Resume nudges from idle; Stop interrupts the current turn — both drive the terminal block; disabled when there's no live block):

```tsx
            <div className="mt-[4px] flex gap-[8px]">
                <button
                    type="button"
                    onClick={() => drive("continue\r")}
                    disabled={noTerminal}
                    title={noTerminal ? "no live terminal" : "nudge the agent to continue from idle"}
                    className="flex-1 rounded-[8px] border border-edge-mid bg-surface-raised py-[8px] text-[12px] font-medium text-secondary hover:border-edge-strong disabled:cursor-not-allowed disabled:text-muted disabled:opacity-50"
                >
                    Resume
                </button>
                <button
                    type="button"
                    onClick={() => drive("\x1b")}
                    disabled={noTerminal}
                    title={noTerminal ? "no live terminal" : "interrupt the current turn"}
                    className="flex-1 rounded-[8px] border border-error/30 bg-transparent py-[8px] text-[12px] font-medium text-error hover:bg-error/10 disabled:cursor-not-allowed disabled:opacity-50"
                >
                    Stop
                </button>
            </div>
```

- [ ] **Step 6: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: no new errors beyond the 3-error baseline. (Confirm no unused-import / unused-const errors for the removed `PLACEHOLDER_FILES`.)

- [ ] **Step 7: Stage**

```bash
git add frontend/app/view/agents/agentdetailsrail.tsx
```

---

### Task 7: Update `docs/deferred.md`

Reflect that Branch / Files-touched / Stop / Resume are now real and the Pause button + suggestion chips were removed; log the one true remaining deferral (cumulative session tokens).

**Files:**
- Modify: `docs/deferred.md`

- [ ] **Step 1: Update the Phase-1b placeholder entry**

In the section `## Agent (Focus) surface placeholders (Phase 1b)`, prepend a resolution note at the top of that section's body so the historical record stays but the current truth is clear:

```markdown
> **Resolved 2026-06-26 (agent-rail-toggle):** git Branch + Files-touched (with per-file
> M/+/− status) are now real, sourced from `GitChangesCommand` via `railstore.ts`. Stop/Resume
> are now real (ESC interrupt / `"continue\r"` nudge via `ControllerInputCommand`), disabled
> only when the agent has no live terminal block. The disabled **Pause** button and the
> placeholder **suggestion chips** were removed. The details rail is now toggleable (default off,
> `d` key / header button, persisted via `atomWithStorage("agent.rail.visible")`). The only
> still-deferred item from this list is **Tokens (total)** — see the entry below.
```

- [ ] **Step 2: Add the cumulative-tokens deferral**

Add a new top-level entry near the top of the file (append-new-at-top convention):

```markdown
## Agent rail "Tokens" — context occupancy, not cumulative (2026-06-26)

- **What:** the Agent details rail's "Tokens" row shows live *context-window occupancy*
  (`round(contextpct% × contextmax)`), not cumulative tokens spent this session.
- **Why:** `AgentUsage` (the statusLine reporter) carries no token-total field. A true cumulative
  figure needs a per-agent transcript scan (the Usage surface does this in aggregate, not per agent).
- **Where it plugs in:** the "Tokens" `DetailRow` in `frontend/app/view/agents/agentdetailsrail.tsx`.
- **To resume:** add a per-agent cumulative-token source (extend the reporter, or a per-agent
  transcript scan reusing the Usage surface's extractor) and feed it into the row.
```

- [ ] **Step 3: Stage**

```bash
git add docs/deferred.md
```

---

### Task 8: Final verification + single commit

- [ ] **Step 1: Full typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exactly the 3 pre-existing `frontend/tauri/api.test.ts` baseline errors — no others.

- [ ] **Step 2: Full test suite**

Run: `npx vitest run`
Expected: all green (the new `capFiles` cases included; no regressions in `gitstatus`/`agentcwd`/`agentsviewmodel`/etc.).

- [ ] **Step 3: CDP visual + behavior verification on the dev app**

Prereq: `task dev` running; if a populated cockpit is needed, `node scripts/inject-live-agents.mjs <scenario>` first. Capture with `node scripts/cdp-shot.mjs <out.png>`. Verify each:

- Rail is **off by default**; the transcript center fills the full width.
- Pressing **`d`** (with focus on the transcript surface, not the composer) toggles the rail; the header toggle button highlights when the rail is visible.
- Toggle state **persists across reload** (localStorage `agent.rail.visible`).
- Rail **Branch** + **Files-touched** match the Files surface for the same focused agent (same branch string; same changed files with the same M/+/− statuses). For a non-repo cwd the rail shows "Not a git repository"; a clean tree shows "No changes".
- Header shows the **Model** chip and the **Context %** chip (colored ok→accent / warn→warning / hot→error); **no Pause button**; footer has **only the composer** (no suggestion chips).
- **Stop** on a working agent returns it to idle with the process still alive (terminal reachable via `t`); **Resume** types `continue` and the agent resumes. Confirm the interrupt byte that actually works — `ESC` (`\x1b`) is the design assumption; if a single ESC doesn't interrupt the live agent, try `Ctrl-C` (`\x03`) and update `drive("\x1b")` in `agentdetailsrail.tsx` accordingly. Record the result.
- Stop/Resume are **disabled** for an agent with no `blockId` (e.g. a mock-roster agent).

Note any deviation here before committing (e.g. the interrupt byte). If `:9222` is busy or the dev app can't be driven, record CDP as deferred (as prior passes have) rather than blocking the commit — but state it explicitly.

- [ ] **Step 4: Self-review the diff**

Run: `git diff --staged`
Confirm: no leftover `PLACEHOLDER_SUGGESTIONS`/`PLACEHOLDER_FILES`, no commented-out code, no debug statements, no new raw hex colors beyond the pre-existing `#aeb6bf`/`#1a1f26`-style values that match the file's established idiom.

- [ ] **Step 5: Show the commit for approval (project STRICT git workflow)**

Present the staged file list with M/A status + a one-line summary each, and the proposed message:

```
feat(cockpit): toggleable agent rail with real branch/files/stop/resume
```

Body should explain WHY: the rail duplicated the agent's own TUI (reachable via `t`) so it shouldn't be forced on; and now that Wave owns the process (blockId, cwd), the dead rows become real instead of being deleted. List: persisted toggle (`d` + header button), Model/Context% header chips, real Branch + Files-touched via `GitChangesCommand`, real Stop (ESC) / Resume (`continue`) via `ControllerInputCommand`, removed Pause + suggestion chips.

Then ask: **"Awaiting approval. Proceed? (yes/no)"**

- [ ] **Step 6: Commit once (only after explicit approval)**

```bash
git commit
```

(All staged changes from Tasks 1-7 + the plan doc + the deferred.md edit fold into this single feature commit. Do not push unless asked.)

---

## Self-Review

**1. Spec coverage**

| Spec item | Task |
|---|---|
| §1 `railVisibleAtom = atomWithStorage("agent.rail.visible", false)` | Task 3 |
| §1 header toggle button (Pause slot) + `d` key | Tasks 5, 4 |
| §1 conditional `<AgentDetailsRail>` render, center self-heals | Task 4 |
| §2 Model chip + Context% chip (usageLevel color), render-when-present | Task 5 |
| §2 subline project-only (drop `· main`) | Task 5 |
| §2 remove Pause button | Task 5 |
| §3 remove `PLACEHOLDER_SUGGESTIONS` + chip block | Task 5 |
| §4 Branch ← `GitChangesCommand.branch` | Tasks 3, 6 |
| §4 Files touched ← `parseGitChanges(...).files`, status-colored, "+N more" cap | Tasks 2, 6 |
| §4 Stop = ESC interrupt; Resume = `"continue\r"`; both `ControllerInputCommand` | Task 6 |
| §4 Stop/Resume disabled when `blockId == null` | Task 6 |
| §5 shared cwd resolver; rail-scoped loader/atom without per-file diff; stale-focus guard; trigger on rail-open + focus change | Tasks 1, 3, 6 |
| Deferred → cumulative session tokens logged | Task 7 |
| Verification: tsc, vitest, CDP | Task 8 |

All spec sections map to a task. (Out-of-scope items — hard terminate/restart, in-rail diff, always-on-header git — are intentionally not built.)

**2. Placeholder scan:** No "TBD"/"implement later"/"add error handling" placeholders — every code step shows full code. Error handling is concrete (try/catch in the loader mirrors `filesstore`; disabled-state guards on Stop/Resume).

**3. Type consistency:** `resolveCwd(transcriptPath: string | undefined): Promise<string | null>` (Task 1) — same signature used by `filesstore` and `railstore`. `capFiles(files: GitChange[], cap: number): { shown: GitChange[]; more: number }` (Task 2) — consumed in Task 6 as `{ shown: shownFiles, more: moreFiles }`. `RailGitState` fields `{cwd, branch, isRepo, changes}` (Task 3) — read in Task 6 as `railState?.branch`, `railState.isRepo`, `railState?.changes?.files`. `railVisibleAtom` is `atomWithStorage(...)` (boolean) — read via `useAtomValue` and written via `globalStore.get/set` in Tasks 4 & 5. `usageLevel(pct) → "ok" | "warn" | "hot"` keys `CTX_TEXT` (Task 5) and `GAUGE_FILL` (existing rail) consistently. `ControllerInputCommand({ blockid, inputdata64 })` matches `AgentComposer`'s existing call shape.
