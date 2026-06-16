# Phase 3 — Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the four §9 polish items for the session sidebar — typed meta keys, persisted collapse state, vim-style keyboard navigation, and a diff-split keybinding.

**Architecture:** All four are additive and ride existing Wave seams. Item 1 (typed `MetaTSType` keys) is the enabling primitive: it makes `session:collapsedgroups` a typed `MetaType` key so Item 2 can read/write it. Pure selection logic for navigation lives in the existing pure module `sessionviewmodel.ts` (unit-tested); thin atom-reading wrappers live in `sessionsidebarmodel.ts`; `keymodel.ts` only binds keys. Diff-split reuses Wave's `createBlockSplitHorizontally` with a `controller: "cmd"` term block.

**Tech Stack:** Go (`MetaTSType` + `tsgen` codegen), React + TypeScript, Jotai atoms, vitest (pure-function unit tests), Wave's `wshrpc` (`SetMetaCommand`), Wave keymodel (`globalKeyMap`).

**Conventions for this plan:**
- **No `git commit` steps.** Per the repo owner's strict no-auto-commit rule, each task ends with a **Checkpoint** (tests + typecheck/VSCode-clean). Commits are batched and made only with explicit approval. (Deliberately overrides the writing-plans skill's per-task commit steps — user instructions win, matching the Phase 2 plan.)
- **TDD where it pays:** pure functions (`toggleCollapsed`, `flattenVisualOrder`, `cycleTarget`, `needsYouTarget`) get a failing test → red → minimal impl → green. Jotai-atom wrappers, keymap bindings, and the Go type change are verified live (matching how Phase 1/2 verified keybindings/`wsh` — no unit tests for wiring).
- **Go rules:** string-keyed struct fields with json tags; consts/types unchanged; do NOT run `go build` (VSCode problems indicate compile errors).
- **Codegen:** never hand-edit `frontend/types/gotypes.d.ts`. After editing `MetaTSType`, run `task generate`.
- **TS rules:** 4-space indent; `@/...` imports across dirs, `./x` within dir; named exports; `== null`/`!= null` (not `=== undefined`); early returns.
- **Windows note (primary OS):** Wave maps `Cmd` → the **Alt** key on Windows/Linux (`keyutil.ts:235`). So the chords below fire as **Alt+Shift+J/K/N/G on Windows** and **⌘+Shift+J/K/N/G on macOS**. Live-test steps state both.

**Prerequisites:**
- Phase 1 + Phase 2 are committed. Build on that base.
- The setting `app:tabbar` is `"left"` so the sidebar mounts (Phase 1 plan Task 8 dev-run recipe).

**Out of scope (YAGNI — stated in the spec §2):** styled tooltips (native `title=` already works), config keys for the diff command or chord remapping, live-ticking idle duration, committing the reporter script.

---

## File Structure

| File | Task | Responsibility |
|---|---|---|
| `pkg/waveobj/wtypemeta.go` | 1 | **MODIFY.** Add `SessionPinned`/`SessionAgent`/`SessionCollapsedGroups` to `MetaTSType`. |
| `frontend/types/gotypes.d.ts` | 1 | **GENERATED** by `task generate` (read-only; never hand-edit). |
| `frontend/app/tab/sessionsidebar/sessionviewmodel.ts` | 2,3 | **MODIFY.** Add pure `toggleCollapsed`, `flattenVisualOrder`, `cycleTarget`, `needsYouTarget`. |
| `frontend/app/tab/sessionsidebar/sessionviewmodel.test.ts` | 2,3 | **MODIFY.** Unit tests for the new pure functions. |
| `frontend/app/tab/sessionsidebar/sessionsidebarmodel.ts` | 1,2,4,5 | **MODIFY.** Drop `as any` casts; add `collapsedGroupsAtom`/`setCollapsedGroups`, `cycleSession`/`jumpToNeedsYou`, `findActiveSessionTermBlock`. |
| `frontend/app/tab/sessionsidebar/sessionsidebar.tsx` | 2 | **MODIFY.** Read collapse from `collapsedGroupsAtom`; write via `setCollapsedGroups`. |
| `frontend/app/store/keymodel.ts` | 4,5 | **MODIFY.** Bind `Cmd:Shift:j/k/n` to nav wrappers; add `handleDiffSplit` + `Cmd:Shift:g`. |

**Verified API facts this plan relies on (source-inspected 2026-06-15):**
- `MetaTSType` is the single shared meta struct (`pkg/waveobj/wtypemeta.go:13`), closing brace after `Count int` (`:161-162`). `tsgen` reflects it into the TS `MetaType` union, so namespaced keys round-trip without a `MetaDataDecl` entry (Phase 2 set `session:pinned` via `meta as any` and it persisted — arbitrary keys are settable).
- `Workspace`, `Tab` are WaveObjs with `Meta MetaMapType` (`wtype.go:182,195`); `Workspace.OID` exists. `RpcApi.SetMetaCommand(client, {oref, meta})` sets meta on any ORef (Phase 2 uses it on a tab ORef).
- `atoms.workspace` is the reactive Workspace atom (`global-atoms.ts`); it carries `oid`, `tabids`, `activetabid`, `meta`. Updating workspace meta via `SetMetaCommand` bumps the object and re-fires the atom.
- `sessionSidebarViewModelAtom` (derived) and `togglePin` live in `sessionsidebarmodel.ts`; `buildSessionViewModel` returns `{ pinned: SessionRowVM[], groups: SessionGroupVM[] }` and each `SessionRowVM` carries `tabId`, `active`, `status` (`sessionviewmodel.ts:48-67`).
- `setActiveTab(tabId)` is exported from `@/app/store/global` (used by `sessionsidebar.tsx`).
- `registerGlobalKeys()` binds via `globalKeyMap.set("<chord>", () => {...; return true;})` (`keymodel.ts:503`). `switchTab` uses `Cmd:[`/`Cmd:]`; `Ctrl:Shift:{h,j,k,l}` is block-focus nav (`:594-625`). `Cmd:Shift:{j,k,n,g}` are unbound (grep-confirmed).
- Split: `createBlockSplitHorizontally(blockDef: BlockDef, targetBlockId: string, position): Promise<string>` (`global.ts:362`), already imported in `keymodel.ts`. A term block that runs a command uses `meta: { view: "term", controller: "cmd", cmd: "<cmd>", "cmd:cwd": "<dir>" }` (`term-model.ts:123` checks `controller == "cmd"`).
- `Cmd` → `event.altKey` on non-macOS (`keyutil.ts:235`); `Cmd:Shift:{j,k,n,g}` are not in the terminal pass-through list (`keyutil.ts:155-174`).

---

## Task 1: Typed meta keys (enabling primitive)

**Files:**
- Modify: `pkg/waveobj/wtypemeta.go` (insert before `Count int`, `:161`)
- Generated: `frontend/types/gotypes.d.ts`
- Modify: `frontend/app/tab/sessionsidebar/sessionsidebarmodel.ts:55-60,94`

- [ ] **Step 1: Add the three fields to `MetaTSType`**

In `pkg/waveobj/wtypemeta.go`, immediately before the line `	Count int `json:"count,omitempty"` // temp for cpu plot. will remove later`, add:

```go
	// for session sidebar (Wave Agent Sessions fork)
	SessionPinned          bool     `json:"session:pinned,omitempty"`          // tab
	SessionAgent           string   `json:"session:agent,omitempty"`           // tab
	SessionCollapsedGroups []string `json:"session:collapsedgroups,omitempty"` // workspace

```

- [ ] **Step 2: Generate the TypeScript types**

Run: `task generate`
Expected: `frontend/types/gotypes.d.ts` `MetaType` gains `"session:pinned"?: boolean`, `"session:agent"?: string`, `"session:collapsedgroups"?: string[]`.

- [ ] **Step 3: Verify Go compiles + generated types present**

Confirm VSCode shows no Go problems in `wtypemeta.go`. Confirm the three keys appear in `frontend/types/gotypes.d.ts` (read it; do not edit).

- [ ] **Step 4: Drop the `as any` / `Record<string, any>` casts in `sessionsidebarmodel.ts`**

Replace the meta-read block (currently `:55-60`):
```ts
        const meta = (tab?.meta ?? {}) as Record<string, any>;
        return {
            tabId,
            name: tab?.name ?? "",
            agent: meta["session:agent"],
            pinned: meta["session:pinned"] === true,
```
with (the keys are now typed on `MetaType`):
```ts
        const meta = tab?.meta ?? {};
        return {
            tabId,
            name: tab?.name ?? "",
            agent: meta["session:agent"],
            pinned: meta["session:pinned"] === true,
```

Replace the `togglePin` write (currently `:90-96`):
```ts
export function togglePin(tabId: string, pinned: boolean) {
    fireAndForget(() =>
        RpcApi.SetMetaCommand(TabRpcClient, {
            oref: WOS.makeORef("tab", tabId),
            // session:pinned is not yet in MetaType (spec §6: meta-as-any for v1).
            meta: { "session:pinned": !pinned } as any,
        })
    );
}
```
with:
```ts
export function togglePin(tabId: string, pinned: boolean) {
    fireAndForget(() =>
        RpcApi.SetMetaCommand(TabRpcClient, {
            oref: WOS.makeORef("tab", tabId),
            meta: { "session:pinned": !pinned },
        })
    );
}
```

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean; no errors on the now-typed `session:*` reads/writes.

- [ ] **Step 6: Checkpoint**

`MetaTSType` carries the three typed keys; `gotypes.d.ts` regenerated; the two `as any`/`Record` casts are gone. No commit.

---

## Task 2: Persisted collapse state

**Files:**
- Modify: `frontend/app/tab/sessionsidebar/sessionviewmodel.ts`
- Modify: `frontend/app/tab/sessionsidebar/sessionviewmodel.test.ts`
- Modify: `frontend/app/tab/sessionsidebar/sessionsidebarmodel.ts`
- Modify: `frontend/app/tab/sessionsidebar/sessionsidebar.tsx`

- [ ] **Step 1: Write the failing test for `toggleCollapsed` (append to `sessionviewmodel.test.ts`)**

```ts
describe("toggleCollapsed", () => {
    it("adds a label that is not present", () => {
        expect(toggleCollapsed([], "ServiceA")).toEqual(["ServiceA"]);
        expect(toggleCollapsed(["X"], "ServiceA")).toEqual(["X", "ServiceA"]);
    });
    it("removes a label that is present", () => {
        expect(toggleCollapsed(["X", "ServiceA"], "ServiceA")).toEqual(["X"]);
    });
    it("does not mutate the input array", () => {
        const input = ["X"];
        toggleCollapsed(input, "ServiceA");
        expect(input).toEqual(["X"]);
    });
});
```

Add `toggleCollapsed` to the import at the top of the test file:
```ts
import {
    aggregateStatus,
    badgeToStatus,
    buildSessionViewModel,
    cwdToServiceLabel,
    NO_CWD_LABEL,
    toggleCollapsed,
    type SessionInput,
} from "./sessionviewmodel";
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx vitest run frontend/app/tab/sessionsidebar/sessionviewmodel.test.ts`
Expected: FAIL — `toggleCollapsed` is not exported.

- [ ] **Step 3: Implement `toggleCollapsed` (append to `sessionviewmodel.ts`)**

```ts
/** Pure: add the label if absent, remove it if present. Never mutates the input. */
export function toggleCollapsed(groups: string[], label: string): string[] {
    return groups.includes(label) ? groups.filter((g) => g !== label) : [...groups, label];
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npx vitest run frontend/app/tab/sessionsidebar/sessionviewmodel.test.ts`
Expected: PASS — including the three `toggleCollapsed` cases.

- [ ] **Step 5: Add the collapse atom + writer to `sessionsidebarmodel.ts`**

Add `globalStore` to the imports (top of file):
```ts
import { globalStore } from "@/app/store/jotaiStore";
```

Append after `togglePin`:
```ts
/** Reactive: the collapsed group labels persisted on the workspace. */
export const collapsedGroupsAtom = atom<string[]>((get) => {
    const ws = get(atoms.workspace);
    return ws?.meta?.["session:collapsedgroups"] ?? [];
});

export function setCollapsedGroups(groups: string[]) {
    const ws = globalStore.get(atoms.workspace);
    if (ws?.oid == null) {
        return;
    }
    fireAndForget(() =>
        RpcApi.SetMetaCommand(TabRpcClient, {
            oref: WOS.makeORef("workspace", ws.oid),
            meta: { "session:collapsedgroups": groups },
        })
    );
}
```

- [ ] **Step 6: Wire the component to the persisted state (`sessionsidebar.tsx`)**

Update the imports:
```tsx
import { collapsedGroupsAtom, sessionCwdsAtom, sessionSidebarViewModelAtom, setCollapsedGroups, togglePin } from "./sessionsidebarmodel";
import { aggregateStatus, toggleCollapsed } from "./sessionviewmodel";
```

Replace the `useState` collapse + `toggle` block (currently `:20,30-39`):
```tsx
    const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
```
```tsx
    const toggle = (label: string) =>
        setCollapsed((prev) => {
            const next = new Set(prev);
            if (next.has(label)) {
                next.delete(label);
            } else {
                next.add(label);
            }
            return next;
        });
```
with:
```tsx
    const collapsedGroups = useAtomValue(collapsedGroupsAtom);
    const collapsed = new Set(collapsedGroups);
```
```tsx
    const toggle = (label: string) => setCollapsedGroups(toggleCollapsed(collapsedGroups, label));
```

Then remove the now-unused `useState` import — change `import { useEffect, useState } from "react";` to `import { useEffect } from "react";`.

- [ ] **Step 7: Typecheck + full sidebar suite**

Run: `npx tsc --noEmit` → clean.
Run: `npx vitest run frontend/app/tab/sessionsidebar` → all green.

- [ ] **Step 8: Checkpoint**

Collapse state reads from / writes to `session:collapsedgroups` on the workspace; `useState` removed; pure `toggleCollapsed` tested. (Live persistence verified in Task 6.) No commit.

---

## Task 3: Keyboard navigation — pure selection functions (TDD)

**Files:**
- Modify: `frontend/app/tab/sessionsidebar/sessionviewmodel.ts`
- Modify: `frontend/app/tab/sessionsidebar/sessionviewmodel.test.ts`

> These operate on a `SidebarViewModel` (built with `buildSessionViewModel`). Visual order = pinned rows first, then each group's rows top-to-bottom. The active row is the one with `active === true`.

- [ ] **Step 1: Write the failing tests (append to `sessionviewmodel.test.ts`)**

```ts
describe("flattenVisualOrder", () => {
    it("lists pinned rows first, then group rows in order", () => {
        const vm = buildSessionViewModel([
            input({ tabId: "p1", cwd: "/src/A", pinned: true }),
            input({ tabId: "g1", cwd: "/src/B" }),
            input({ tabId: "g2", cwd: "/src/C" }),
        ]);
        expect(flattenVisualOrder(vm).map((r) => r.tabId)).toEqual(["p1", "g1", "g2"]);
    });
});

describe("cycleTarget", () => {
    const vm = () =>
        buildSessionViewModel([
            input({ tabId: "t1", cwd: "/src/A", active: true }),
            input({ tabId: "t2", cwd: "/src/B" }),
            input({ tabId: "t3", cwd: "/src/C" }),
        ]);
    it("moves to the next row", () => {
        expect(cycleTarget(vm(), 1)).toBe("t2");
    });
    it("wraps from last to first", () => {
        const v = buildSessionViewModel([
            input({ tabId: "t1", cwd: "/src/A" }),
            input({ tabId: "t2", cwd: "/src/B" }),
            input({ tabId: "t3", cwd: "/src/C", active: true }),
        ]);
        expect(cycleTarget(v, 1)).toBe("t1");
    });
    it("moves to the previous row, wrapping", () => {
        expect(cycleTarget(vm(), -1)).toBe("t3");
    });
    it("returns undefined when there are no rows", () => {
        expect(cycleTarget(buildSessionViewModel([]), 1)).toBeUndefined();
    });
    it("starts at the first row for next when none is active", () => {
        const v = buildSessionViewModel([
            input({ tabId: "t1", cwd: "/src/A" }),
            input({ tabId: "t2", cwd: "/src/B" }),
        ]);
        expect(cycleTarget(v, 1)).toBe("t1");
    });
});

describe("needsYouTarget", () => {
    it("returns the next waiting row after the active one, wrapping", () => {
        const vm = buildSessionViewModel([
            input({ tabId: "t1", cwd: "/src/A", active: true }),
            input({ tabId: "t2", cwd: "/src/B", status: "working" }),
            input({ tabId: "t3", cwd: "/src/C", status: "waiting" }),
        ]);
        expect(needsYouTarget(vm)).toBe("t3");
    });
    it("wraps past the active row to find an earlier waiting row", () => {
        const vm = buildSessionViewModel([
            input({ tabId: "t1", cwd: "/src/A", status: "waiting" }),
            input({ tabId: "t2", cwd: "/src/B", active: true }),
        ]);
        expect(needsYouTarget(vm)).toBe("t1");
    });
    it("returns undefined when nothing is waiting", () => {
        const vm = buildSessionViewModel([
            input({ tabId: "t1", cwd: "/src/A", active: true, status: "working" }),
        ]);
        expect(needsYouTarget(vm)).toBeUndefined();
    });
});
```

Extend the import to include the three functions:
```ts
import {
    aggregateStatus,
    badgeToStatus,
    buildSessionViewModel,
    cwdToServiceLabel,
    cycleTarget,
    flattenVisualOrder,
    needsYouTarget,
    NO_CWD_LABEL,
    toggleCollapsed,
    type SessionInput,
} from "./sessionviewmodel";
```

- [ ] **Step 2: Run the tests, verify they fail**

Run: `npx vitest run frontend/app/tab/sessionsidebar/sessionviewmodel.test.ts`
Expected: FAIL — `flattenVisualOrder`/`cycleTarget`/`needsYouTarget` not exported.

- [ ] **Step 3: Implement the three functions (append to `sessionviewmodel.ts`)**

```ts
/** Sidebar visual order: pinned rows first, then each group's rows top-to-bottom. */
export function flattenVisualOrder(vm: SidebarViewModel): SessionRowVM[] {
    return [...vm.pinned, ...vm.groups.flatMap((g) => g.sessions)];
}

/** Pure: the tabId to switch to when cycling by offset (+1 next, -1 prev) in visual order, wrapping. */
export function cycleTarget(vm: SidebarViewModel, offset: number): string | undefined {
    const order = flattenVisualOrder(vm);
    if (order.length === 0) {
        return undefined;
    }
    const activeIdx = order.findIndex((r) => r.active);
    // no active row: next starts at the top, prev at the bottom
    const base = activeIdx === -1 ? (offset > 0 ? -1 : 0) : activeIdx;
    const nextIdx = (base + offset + order.length) % order.length;
    return order[nextIdx].tabId;
}

/** Pure: the next waiting (needs-you) session after the active one in visual order, wrapping. */
export function needsYouTarget(vm: SidebarViewModel): string | undefined {
    const order = flattenVisualOrder(vm);
    if (order.length === 0) {
        return undefined;
    }
    const activeIdx = order.findIndex((r) => r.active);
    for (let i = 1; i <= order.length; i++) {
        const idx = (activeIdx + i + order.length) % order.length;
        if (order[idx].status === "waiting") {
            return order[idx].tabId;
        }
    }
    return undefined;
}
```

- [ ] **Step 4: Run the tests, verify they pass**

Run: `npx vitest run frontend/app/tab/sessionsidebar/sessionviewmodel.test.ts`
Expected: PASS — all `flattenVisualOrder`/`cycleTarget`/`needsYouTarget` cases green.

- [ ] **Step 5: Checkpoint**

Pure visual-order selection logic implemented and green. No commit.

---

## Task 4: Keyboard navigation — wrappers + keybindings

**Files:**
- Modify: `frontend/app/tab/sessionsidebar/sessionsidebarmodel.ts`
- Modify: `frontend/app/store/keymodel.ts`

- [ ] **Step 1: Add the atom-reading wrappers to `sessionsidebarmodel.ts`**

Extend imports — add `setActiveTab` from global and the two pure functions. `sessionsidebarmodel.ts` does not currently import from `@/app/store/global`, so add this line:
```ts
import { setActiveTab } from "@/app/store/global";
```

Update the `sessionviewmodel` import to include `cycleTarget` and `needsYouTarget`:
```ts
import {
    badgeToStatus,
    buildSessionViewModel,
    cwdToServiceLabel,
    cycleTarget,
    needsYouTarget,
    type SessionInput,
    type SessionStatus,
    type SidebarViewModel,
} from "./sessionviewmodel";
```

Append:
```ts
export function cycleSession(offset: number) {
    const vm = globalStore.get(sessionSidebarViewModelAtom);
    const target = cycleTarget(vm, offset);
    if (target != null) {
        setActiveTab(target);
    }
}

export function jumpToNeedsYou() {
    const vm = globalStore.get(sessionSidebarViewModelAtom);
    const target = needsYouTarget(vm);
    if (target != null) {
        setActiveTab(target);
    }
}
```

- [ ] **Step 2: Bind the chords in `keymodel.ts`**

Add the import (top of `keymodel.ts`, with the other `@/app/...` imports):
```ts
import { cycleSession, jumpToNeedsYou } from "@/app/tab/sessionsidebar/sessionsidebarmodel";
```

In `registerGlobalKeys()`, add after the `Shift:Cmd:[` binding (currently ends `:519`):
```ts
    globalKeyMap.set("Cmd:Shift:j", () => {
        cycleSession(1);
        return true;
    });
    globalKeyMap.set("Cmd:Shift:k", () => {
        cycleSession(-1);
        return true;
    });
    globalKeyMap.set("Cmd:Shift:n", () => {
        jumpToNeedsYou();
        return true;
    });
```

- [ ] **Step 3: Typecheck + sidebar suite**

Run: `npx tsc --noEmit` → clean (watch for an accidental circular-import type error between `keymodel.ts` and `sessionsidebarmodel.ts`; the wrappers are called at runtime, so a cycle resolves, but if tsc flags it, move the import to a dynamic `await import()` inside the handler).
Run: `npx vitest run frontend/app/tab/sessionsidebar` → all green.

- [ ] **Step 4: Live smoke test**

With `app:tabbar=left` and ≥3 tabs across groups, in the running dev app:
- macOS: `⌘+Shift+J` / `⌘+Shift+K` cycle the active session **down/up in sidebar visual order** (pinned first); wraps at the ends. Windows: `Alt+Shift+J` / `Alt+Shift+K`.
- Put one session into `waiting` (amber) via the reporter; `⌘/Alt+Shift+N` jumps straight to it; with none waiting it is a no-op.

- [ ] **Step 5: Checkpoint**

Vim-style session nav works in visual order + needs-you jump. No commit.

---

## Task 5: Diff-split keybinding

**Files:**
- Modify: `frontend/app/tab/sessionsidebar/sessionsidebarmodel.ts`
- Modify: `frontend/app/store/keymodel.ts`

- [ ] **Step 1: Add `findActiveSessionTermBlock` to `sessionsidebarmodel.ts`**

Append:
```ts
/** The active session's terminal block id + cwd (the block the diff-split targets). */
export function findActiveSessionTermBlock(): { blockId: string; cwd: string } | undefined {
    const ws = globalStore.get(atoms.workspace);
    const activeId = ws?.activetabid;
    if (activeId == null) {
        return undefined;
    }
    const tab = globalStore.get(WOS.getWaveObjectAtom<Tab>(WOS.makeORef("tab", activeId)));
    for (const blockId of tab?.blockids ?? []) {
        const block = globalStore.get(WOS.getWaveObjectAtom<Block>(WOS.makeORef("block", blockId)));
        if (block?.meta?.view === "term" && block.meta["cmd:cwd"]) {
            return { blockId, cwd: block.meta["cmd:cwd"] };
        }
    }
    return undefined;
}
```

- [ ] **Step 2: Add the diff-split handler + chord in `keymodel.ts`**

Extend the existing import to include `findActiveSessionTermBlock`:
```ts
import { cycleSession, findActiveSessionTermBlock, jumpToNeedsYou } from "@/app/tab/sessionsidebar/sessionsidebarmodel";
```

Add the handler after `handleSplitVertical` (currently ends `:401`):
```ts
// git --no-pager diff (not "git diff": the pager would block on the block's TTY)
async function handleDiffSplit() {
    const termBlock = findActiveSessionTermBlock();
    if (termBlock == null) {
        return;
    }
    const blockDef: BlockDef = {
        meta: {
            view: "term",
            controller: "cmd",
            cmd: "git --no-pager diff",
            "cmd:cwd": termBlock.cwd,
        },
    };
    await createBlockSplitHorizontally(blockDef, termBlock.blockId, "after");
}
```

In `registerGlobalKeys()`, add after the `Shift:Cmd:d` split binding (currently ends `:531`):
```ts
    globalKeyMap.set("Cmd:Shift:g", () => {
        handleDiffSplit();
        return true;
    });
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean. `BlockDef` is an ambient global type; `createBlockSplitHorizontally` is already imported in `keymodel.ts`.

- [ ] **Step 4: Live smoke test**

With an active session whose terminal has a known cwd (shell integration / OSC 7 active):
- macOS `⌘+Shift+G` / Windows `Alt+Shift+G` splits the layout and opens a term block in that cwd showing `git diff` output. Re-running the chord opens another split. A tab with no terminal/cwd is a no-op (no crash).

- [ ] **Step 5: Checkpoint**

Diff-split opens a `git --no-pager diff` term in the active session's cwd via a layout split. No commit.

---

## Task 6: Phase 3 verification

**Files:** none (verification only)

- [ ] **Step 1:** `npx vitest run frontend/app/tab/sessionsidebar` → all green (Phase 1/2 tests + the new `toggleCollapsed`/`flattenVisualOrder`/`cycleTarget`/`needsYouTarget` cases).
- [ ] **Step 2:** `npx tsc --noEmit` → no new errors.
- [ ] **Step 3:** `npx eslint frontend/app/tab/sessionsidebar/**/*.{ts,tsx} frontend/app/store/keymodel.ts` → clean.
- [ ] **Step 4: Live — typed meta + persisted collapse:** collapse a couple of groups, fully reload the app (or restart), confirm the same groups are still collapsed. Pin/unpin a session and confirm it still works (typed `session:pinned`).
- [ ] **Step 5: Live — nav:** `⌘/Alt+Shift+J/K` cycle in visual order with wrap; `⌘/Alt+Shift+N` jumps to a waiting session.
- [ ] **Step 6: Live — diff-split:** `⌘/Alt+Shift+G` splits a `git diff` term in the active session's cwd.
- [ ] **Step 7: Checkpoint** — Phase 3 complete. No commit (await batched approval).

---

## Self-Review

**1. Spec coverage (against the four §3-§6 items + §7 testing + §8 file list):**
- Typed meta keys (`session:pinned`/`session:agent` + new `session:collapsedgroups`) → Task 1. ✅
- Persisted collapse on workspace meta → Task 2 (atom + writer + component). ✅ (Refinement vs spec §4: reads via a derived `collapsedGroupsAtom` over `atoms.workspace.meta` rather than `getOrefMetaKeyAtom` — equivalent and reactive, since the view model already subscribes to `atoms.workspace`; avoids threading the workspace ORef + a `keyof MetaType` generic. Flagged.)
- Vim nav: pure `flattenVisualOrder`/`cycleTarget`/`needsYouTarget` (§5) → Task 3; wrappers + `Cmd:Shift:j/k/n` → Task 4. ✅
- Diff-split `Cmd:Shift:g` via `createBlockSplitHorizontally` (§6) → Task 5. ✅ (Decision: `controller: "cmd"` + `git --no-pager diff` for a deterministic, dependency-free diff view that won't hang on a pager TTY. Tradeoff: it's a one-shot command block, not a re-runnable shell — the spec §6 "re-run other commands" nuance is dropped for v1 robustness; trivially switchable to a shell+initscript later. Flagged.)
- Testing (§7): pure functions unit-tested in `sessionviewmodel.test.ts`; wiring verified live → Tasks 2,3,6. ✅
- File list (§8) matches Tasks 1-5. ✅

**2. Placeholder scan:** No "TBD"/"handle later"/"similar to". Every code step shows complete code. The only judgement note is the circular-import fallback (Task 4 Step 3), which gives a concrete remedy (`await import()`).

**3. Type consistency:**
- `flattenVisualOrder(vm) → SessionRowVM[]`, `cycleTarget(vm, offset) → string | undefined`, `needsYouTarget(vm) → string | undefined` — defined in Task 3, consumed unchanged by the wrappers in Task 4. Names identical across tasks.
- `toggleCollapsed(string[], string) → string[]` (Task 2) consumed by the component (Task 2 Step 6) with the same signature.
- `collapsedGroupsAtom: Atom<string[]>`, `setCollapsedGroups(string[])`, `findActiveSessionTermBlock() → { blockId, cwd } | undefined` — defined in `sessionsidebarmodel.ts` (Tasks 2,5), imported by `sessionsidebar.tsx` (Task 2) and `keymodel.ts` (Task 5). No drift.
- Meta keys: Go `SessionPinned`→`session:pinned` (bool), `SessionAgent`→`session:agent` (string), `SessionCollapsedGroups`→`session:collapsedgroups` ([]string) → generated `MetaType` keys consumed as `meta["session:pinned"]`/`meta["session:collapsedgroups"]`. Casing consistent.

---

## Execution Handoff

Task 1 first (unblocks Task 2's typed read). Then **Task 2 before Tasks 4 and 5** — Task 2 adds the shared `import { globalStore } from "@/app/store/jotaiStore";` that the Task 4 wrappers and Task 5 helper also use. After Task 2: Task 3→4 (4 depends on 3) and Task 5 are independent.
