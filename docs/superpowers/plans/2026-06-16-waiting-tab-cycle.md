# Waiting-Tab Cycle + Ctrl Tab Switch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `Ctrl+Tab` / `Ctrl+Shift+Tab` to cycle through sessions that need attention (`status === "waiting"`), and move absolute tab switching from `Alt+1-9` to `Ctrl+1-9`.

**Architecture:** The sidebar already derives a `SidebarViewModel` of sessions in visual order and a forward-only `needsYouTarget` helper. We generalize that pure helper into a bidirectional `waitingTarget(vm, offset)`, add a thin `cycleWaiting(offset)` model action that resolves the target and calls `setActiveTab`, and register three keybindings in the global keymap. The waiting scan is the only real logic and is unit-tested; the model action and keybindings are thin glue, verified by typecheck + manual run (matching how the existing `cycleSession`/`jumpToNeedsYou` are tested).

**Tech Stack:** TypeScript, React/Jotai frontend, vitest for unit tests. Keybindings live in `frontend/app/store/keymodel.ts`; pure sidebar logic in `frontend/app/tab/sessionsidebar/sessionviewmodel.ts`.

**Spec:** `docs/superpowers/specs/2026-06-16-waiting-tab-cycle-design.md`

> **Commit policy (project override):** This repo's owner requires all changes batched into a **single commit at the end, only after explicit approval** — so the per-task TDD steps below do NOT commit individually. Committing happens once in the final task, and only on a "yes". This intentionally diverges from the skill's frequent-commit default.

---

## File Structure

| File | Responsibility | Change |
| --- | --- | --- |
| `frontend/app/tab/sessionsidebar/sessionviewmodel.ts` | Pure, runtime-free sidebar logic | Generalize `needsYouTarget` → `waitingTarget(vm, offset)`; keep `needsYouTarget` as a forward wrapper |
| `frontend/app/tab/sessionsidebar/sessionviewmodel.test.ts` | Unit tests for the pure logic | Add `waitingTarget` cases |
| `frontend/app/tab/sessionsidebar/sessionsidebarmodel.ts` | Sidebar runtime actions (Jotai + RPC) | Add `cycleWaiting(offset)` |
| `frontend/app/store/keymodel.ts` | Global keybinding registration + dispatch | Tab loop `Cmd:${idx}` → `Ctrl:${idx}`; add `Ctrl:Tab` / `Ctrl:Shift:Tab` |
| `docs/docs/keybindings.mdx` | User-facing keybinding reference | (Optional) reflect new bindings |

---

## Task 1: Generalize the waiting-session scan (`waitingTarget`)

**Files:**
- Modify: `frontend/app/tab/sessionsidebar/sessionviewmodel.ts:179-193` (the `needsYouTarget` function)
- Test: `frontend/app/tab/sessionsidebar/sessionviewmodel.test.ts`

- [ ] **Step 1: Write the failing tests**

In `sessionviewmodel.test.ts`, add `waitingTarget` to the existing import from `./sessionviewmodel` (alphabetically, after `toggleCollapsed` / near `subagentExpanded` — order does not matter functionally):

```ts
import {
    aggregateStatus,
    badgeToStatus,
    buildDuplicateBlockMeta,
    buildSessionViewModel,
    cwdToServiceLabel,
    cycleTarget,
    flattenVisualOrder,
    loomBinOrDefault,
    needsYouTarget,
    NO_CWD_LABEL,
    reduceSubagents,
    rollUpStatus,
    subagentExpanded,
    toggleCollapsed,
    waitingTarget,
    type SessionInput,
} from "./sessionviewmodel";
```

Then add this `describe` block immediately after the existing `describe("needsYouTarget", ...)` block (around line 272). Distinct cwds give each session its own single-row group, so the flattened visual order is `[t1, t2, t3]`:

```ts
describe("waitingTarget", () => {
    it("forward: returns the next waiting row after active, skipping non-waiting", () => {
        const vm = buildSessionViewModel([
            input({ tabId: "t1", cwd: "/src/A", active: true }),
            input({ tabId: "t2", cwd: "/src/B", status: "working" }),
            input({ tabId: "t3", cwd: "/src/C", status: "waiting" }),
        ]);
        expect(waitingTarget(vm, 1)).toBe("t3");
    });
    it("backward: returns the previous waiting row before active", () => {
        const vm = buildSessionViewModel([
            input({ tabId: "t1", cwd: "/src/A", status: "waiting" }),
            input({ tabId: "t2", cwd: "/src/B", status: "working" }),
            input({ tabId: "t3", cwd: "/src/C", active: true }),
        ]);
        expect(waitingTarget(vm, -1)).toBe("t1");
    });
    it("backward: wraps past the start to the last waiting row", () => {
        const vm = buildSessionViewModel([
            input({ tabId: "t1", cwd: "/src/A", active: true }),
            input({ tabId: "t2", cwd: "/src/B", status: "working" }),
            input({ tabId: "t3", cwd: "/src/C", status: "waiting" }),
        ]);
        expect(waitingTarget(vm, -1)).toBe("t3");
    });
    it("returns undefined when nothing is waiting (both directions)", () => {
        const vm = buildSessionViewModel([
            input({ tabId: "t1", cwd: "/src/A", active: true, status: "working" }),
            input({ tabId: "t2", cwd: "/src/B", status: "idle" }),
        ]);
        expect(waitingTarget(vm, 1)).toBeUndefined();
        expect(waitingTarget(vm, -1)).toBeUndefined();
    });
    it("with exactly one waiting row, both directions find it", () => {
        const vm = buildSessionViewModel([
            input({ tabId: "t1", cwd: "/src/A", active: true }),
            input({ tabId: "t2", cwd: "/src/B", status: "waiting" }),
        ]);
        expect(waitingTarget(vm, 1)).toBe("t2");
        expect(waitingTarget(vm, -1)).toBe("t2");
    });
    it("returns undefined for an empty model", () => {
        expect(waitingTarget(buildSessionViewModel([]), 1)).toBeUndefined();
        expect(waitingTarget(buildSessionViewModel([]), -1)).toBeUndefined();
    });
    it("does not throw and is deterministic when no row is active", () => {
        const vm = buildSessionViewModel([
            input({ tabId: "t1", cwd: "/src/A", status: "waiting" }),
            input({ tabId: "t2", cwd: "/src/B", status: "working" }),
        ]);
        expect(waitingTarget(vm, 1)).toBe("t1");
        expect(waitingTarget(vm, -1)).toBe("t1");
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run frontend/app/tab/sessionsidebar/sessionviewmodel.test.ts -t "waitingTarget"`
Expected: FAIL — `waitingTarget is not a function` / import has no exported member `waitingTarget`.

- [ ] **Step 3: Implement `waitingTarget` and make `needsYouTarget` a wrapper**

In `sessionviewmodel.ts`, replace the existing `needsYouTarget` function (lines 179-193) with:

```ts
/** Pure: the next/prev waiting session relative to the active one in visual order, wrapping.
 *  offset +1 scans forward, -1 scans backward. */
export function waitingTarget(vm: SidebarViewModel, offset: number): string | undefined {
    const order = flattenVisualOrder(vm);
    if (order.length === 0) {
        return undefined;
    }
    const activeIdx = order.findIndex((r) => r.active);
    for (let i = 1; i <= order.length; i++) {
        // double-mod normalizes a possibly-negative index (offset -1) back into [0, len)
        const idx = (((activeIdx + offset * i) % order.length) + order.length) % order.length;
        if (order[idx].status === "waiting") {
            return order[idx].tabId;
        }
    }
    return undefined;
}

/** Pure: the next waiting (needs-you) session after the active one in visual order, wrapping. */
export function needsYouTarget(vm: SidebarViewModel): string | undefined {
    return waitingTarget(vm, 1);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run frontend/app/tab/sessionsidebar/sessionviewmodel.test.ts`
Expected: PASS — the new `waitingTarget` block AND the existing `needsYouTarget` block both green (the wrapper preserves the old behavior, so the existing tests are the regression guard for the refactor).

---

## Task 2: Add the `cycleWaiting` model action

**Files:**
- Modify: `frontend/app/tab/sessionsidebar/sessionsidebarmodel.ts:16-28` (import) and the function region near `cycleSession`/`jumpToNeedsYou` (lines 146-160)

No unit test: this is runtime glue over `globalStore`/`setActiveTab`, matching the existing untested `cycleSession`/`jumpToNeedsYou`. Verified by typecheck (Task 4 gate) and manual run (final task).

- [ ] **Step 1: Add `waitingTarget` to the import**

In `sessionsidebarmodel.ts`, add `waitingTarget,` to the existing named import from `./sessionviewmodel` (lines 16-28):

```ts
import {
    badgeToStatus,
    buildDuplicateBlockMeta,
    buildSessionViewModel,
    cwdToServiceLabel,
    cycleTarget,
    needsYouTarget,
    subagentExpanded,
    waitingTarget,
    type SessionInput,
    type SessionStatus,
    type SidebarViewModel,
    type SubagentVM,
} from "./sessionviewmodel";
```

- [ ] **Step 2: Add the `cycleWaiting` function**

Immediately after the existing `cycleSession` function (it ends at line ~152, just before `jumpToNeedsYou`), add:

```ts
export function cycleWaiting(offset: number) {
    const vm = globalStore.get(sessionSidebarViewModelAtom);
    const target = waitingTarget(vm, offset);
    if (target != null) {
        setActiveTab(target);
    }
}
```

- [ ] **Step 3: Verify no TypeScript errors**

Confirm the editor's Problems panel is clean for `sessionsidebarmodel.ts` (the project convention is to trust editor diagnostics for compilation). `globalStore`, `sessionSidebarViewModelAtom`, and `setActiveTab` are all already in scope in this file (used by `cycleSession`).

---

## Task 3: Register the keybindings

**Files:**
- Modify: `frontend/app/store/keymodel.ts:24` (import), `:705-709` (tab loop), and `registerGlobalKeys` body

- [ ] **Step 1: Add `cycleWaiting` to the sidebar-model import**

Change line 24 from:

```ts
import { cycleSession, findActiveSessionTermBlock, jumpToNeedsYou } from "@/app/tab/sessionsidebar/sessionsidebarmodel";
```

to:

```ts
import { cycleSession, cycleWaiting, findActiveSessionTermBlock, jumpToNeedsYou } from "@/app/tab/sessionsidebar/sessionsidebarmodel";
```

- [ ] **Step 2: Move absolute tab switch from `Cmd` (Alt on Win) to `Ctrl`**

In the `for (let idx = 1; idx <= 9; idx++)` loop (line ~705), change the absolute-tab descriptor from `Cmd:${idx}` to `Ctrl:${idx}`. Leave the `Ctrl:Shift:c{Digit${idx}}` / `Ctrl:Shift:c{Numpad${idx}}` block-number bindings in the same loop untouched:

```ts
    for (let idx = 1; idx <= 9; idx++) {
        globalKeyMap.set(`Ctrl:${idx}`, () => {
            switchTabAbs(idx);
            return true;
        });
        globalKeyMap.set(`Ctrl:Shift:c{Digit${idx}}`, () => {
            switchBlockByBlockNum(idx);
            return true;
        });
        globalKeyMap.set(`Ctrl:Shift:c{Numpad${idx}}`, () => {
            switchBlockByBlockNum(idx);
            return true;
        });
    }
```

- [ ] **Step 3: Add the waiting-cycle bindings**

In `registerGlobalKeys`, next to the existing `Cmd:Shift:j` / `Cmd:Shift:k` session-cycle bindings (around line 538), add:

```ts
    globalKeyMap.set("Ctrl:Tab", () => {
        cycleWaiting(1);
        return true;
    });
    globalKeyMap.set("Ctrl:Shift:Tab", () => {
        cycleWaiting(-1);
        return true;
    });
```

- [ ] **Step 4: Verify no TypeScript errors**

Confirm the editor's Problems panel is clean for `keymodel.ts`. `switchTabAbs` and `switchBlockByBlockNum` are already defined in this file; `cycleWaiting` is now imported.

---

## Task 4: (Optional) Update keybinding docs

**Files:**
- Modify: `docs/docs/keybindings.mdx` (Global Keybindings table, lines ~49-51)

Skip this task if you do not maintain the published docs for this fork.

- [ ] **Step 1: Update the tab-number row and add the waiting-cycle rows**

Replace the `Cmd:1-9` "Switch to tab number" row with a `Ctrl:1-9` row, and add two rows for the waiting cycle. Note the file's convention: it documents macOS keys and tells Windows/Linux users to read `Cmd` as `Alt` — but these new bindings are literal `Ctrl` on all platforms, so write them as `Ctrl` directly:

```mdx
| <Kbd k="Ctrl:1-9"/>                               | Switch to tab number                                                                                                                                   |
| <Kbd k="Ctrl:Tab"/>                               | Jump to the next session that needs attention (waiting), wrapping                                                                                      |
| <Kbd k="Ctrl:Shift:Tab"/>                         | Jump to the previous session that needs attention (waiting), wrapping                                                                                  |
```

---

## Task 5: Verify and commit

- [ ] **Step 1: Run the full unit test file once more**

Run: `npx vitest run frontend/app/tab/sessionsidebar/sessionviewmodel.test.ts`
Expected: PASS, all describe blocks green.

- [ ] **Step 2: Manual verification in the running app**

Launch the dev app and confirm:
- With **2+ waiting sessions**, `Ctrl+Tab` advances through them and `Ctrl+Shift+Tab` goes back, both wrapping.
- With **0 waiting sessions**, `Ctrl+Tab` does nothing (expected no-op).
- `Ctrl+1` … `Ctrl+9` jump to the Nth tab.
- `Ctrl+D` still sends EOF to a shell (e.g. exits a `python` REPL) — i.e. we did not steal a terminal control code.
- `Alt+Shift+N` still jumps to the next waiting session (unchanged), and `Alt+Shift+J/K` still cycle all sessions.

- [ ] **Step 3: Show the diff and request approval (DO NOT skip)**

Run: `git status` and `git --no-pager diff --stat`
Present the file list (M paths + one-line summary each) and the proposed commit message:

```
feat(sidebar): Ctrl+Tab waiting-session cycle, Ctrl+number tab switch
```

Then ask: "Awaiting approval. Proceed? (yes/no)" — per the repo owner's git workflow, do not commit until told yes.

- [ ] **Step 4: Commit (only after explicit approval)**

```bash
git add frontend/app/tab/sessionsidebar/sessionviewmodel.ts \
        frontend/app/tab/sessionsidebar/sessionviewmodel.test.ts \
        frontend/app/tab/sessionsidebar/sessionsidebarmodel.ts \
        frontend/app/store/keymodel.ts \
        docs/docs/keybindings.mdx \
        docs/superpowers/specs/2026-06-16-waiting-tab-cycle-design.md \
        docs/superpowers/plans/2026-06-16-waiting-tab-cycle.md
git commit -m "feat(sidebar): Ctrl+Tab waiting-session cycle, Ctrl+number tab switch"
```

(Drop `keybindings.mdx` from the `git add` list if Task 4 was skipped.)

---

## Self-Review

**Spec coverage:**
- `Ctrl+1-9` tab switch → Task 3 Step 2. ✓
- `Ctrl+Tab` / `Ctrl+Shift+Tab` waiting cycle → Task 1 (logic) + Task 2 (action) + Task 3 Step 3 (bindings). ✓
- Bidirectional waiting scan generalizing `needsYouTarget` → Task 1. ✓
- `jumpToNeedsYou` / `Alt+Shift+N` unchanged → preserved by the `needsYouTarget` wrapper (Task 1 Step 3); regression-guarded by the existing test block. ✓
- Cross-platform Cmd→Ctrl note → Task 3 Step 2 changes the literal descriptor (applies to all platforms, as the spec accepts). ✓
- Tests for forward/backward/wrap/0-waiting/1-waiting/no-active → Task 1 Step 1. ✓
- Docs → Task 4 (optional). ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code; every run step has an exact command and expected result. ✓

**Type consistency:** `waitingTarget(vm, offset)` signature is identical across Task 1 (definition), Task 2 (call in `cycleWaiting`), and the tests. `cycleWaiting(offset)` is defined in Task 2 and imported/called in Task 3 with the same name. `needsYouTarget(vm)` keeps its original signature. ✓
