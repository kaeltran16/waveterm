# Duplicate Session Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Duplicate session" action to the session sidebar's row context menu that opens a new tab running the same agent in the same repo as the source session.

**Architecture:** Pure-frontend. Right-clicking a session row opens a context menu (Rename · Pin/Unpin · Duplicate session · Close tab). Duplicate resolves the source session's terminal block, copies its launch-relevant meta via a pure helper, then **creates a new tab inactive → reconfigures the tab's default shell block with the copied meta → activates the tab**. Because the backend creates the block object without starting its controller (`pkg/wcore/block.go:65`), reconfiguring before activation means the controller starts with the cloned `cmd:cwd`/`cmd` — one block, no flash, no delete.

**Tech Stack:** React + TypeScript, Jotai, existing Wave services/RPC (`WorkspaceService.CreateTab`, `RpcApi.SetMetaCommand`, `setActiveTab`, `getApi().closeTab`), `ContextMenuModel`, vitest. No Go, no codegen.

**Spec:** `docs/specs/2026-06-16-duplicate-session-design.md`.

**Conventions for this plan:**
- **No `git commit` steps.** Per the repo owner's strict no-auto-commit rule, each task ends with a **Checkpoint** (tests + VSCode/typecheck-clean). Commits are batched and made only with explicit approval. (Deliberately overrides the writing-plans skill's per-task commit steps — user instructions win, matching the Phase 1/2/3 + subagent-visibility plans.)
- **TDD where it pays:** the one pure function (`buildDuplicateBlockMeta`) gets failing test → red → minimal impl → green. The wiring (`duplicateSession`, the context menu, the rename ref) is verified **live over CDP** (`:9222`), matching how Phases 1–3 verified atom/RPC wiring — no unit tests for wiring (the sidebar test harness is `renderToStaticMarkup`, which can't exercise event handlers/RPC).
- **TS rules:** 4-space indent; `@/...` across dirs, `./x` within dir; named exports; `== null`/`!= null` (never `=== undefined`); early returns; `React.RefObject` (not `MutableRefObject`). 2026 copyright on any new file (none here).
- **Plan location** follows the repo convention `docs/plans/` (not the skill's default `docs/superpowers/plans/`), matching the four existing sidebar plans.

**Verified API facts this plan relies on (source-inspected 2026-06-16):**
- `WorkspaceService.CreateTab(workspaceId, tabName, activateTab): Promise<string>` returns the new tabId (`frontend/app/store/services.ts:172`, `"workspace"` service). The frontend wrapper applies the backend object updates before resolving, so the new tab's `blockids` are readable from the WOS store immediately after `await`.
- `wcore.CreateTab` applies `GetNewTabLayout()` for non-initial tabs = **one** block `{view:"term", controller:"shell"}` (`pkg/wcore/layout.go:63-72`); `CreateBlockWithTelemetry` (`pkg/wcore/block.go:65`) persists the block object but does **not** start its controller, so meta set before the tab renders is honored at controller start.
- Block meta keys (`pkg/waveobj/metaconsts.go`): `MetaKey_View="view"`, `MetaKey_Controller="controller"`, `MetaKey_Cmd="cmd"`, `MetaKey_CmdArgs="cmd:args"`, `MetaKey_CmdCwd="cmd:cwd"`, `MetaKey_CmdInteractive="cmd:interactive"`. Widgets confirm a `{view:"term", controller, cmd:cwd}` block launches in that cwd (`pkg/wconfig/defaultconfig/widgets.json`, `frontend/app/workspace/widgets.tsx:58-61`).
- `RpcApi.SetMetaCommand(TabRpcClient, {oref, meta})` merges meta (used by `togglePin`/`renameSession` in `sessionsidebarmodel.ts:105-123`).
- `setActiveTab(tabId)` (`@/app/store/global`) and `getApi().closeTab(workspaceId, tabId, confirmClose)` (`frontend/types/custom.d.ts:119`, used by both tab bars).
- `ContextMenuModel.getInstance().showContextMenu(menu: ContextMenuItem[], e: React.MouseEvent)` (`@/app/store/contextmenu`) — global singleton used by processviewer/builder. `ContextMenuItem` is an ambient global type (no import; see `tabcontextmenu.ts`). Separator item = `{ type: "separator" }`.
- `sessionsidebarmodel.ts` already imports `globalStore`, `WOS`, `atoms`, `RpcApi`, `TabRpcClient`, `fireAndForget`, `setActiveTab`, and reads tab/block objects via `globalStore.get(WOS.getWaveObjectAtom<Tab|Block>(WOS.makeORef(...)))` (`:35-48`). `SessionRowVM` already exposes `termBlockOref` (`sessionviewmodel.ts:79`).
- `SessionRow` (`sessionrow.tsx:44-152`) is presentational with internal `editing`/`draft` state started by double-click (`:88-128`); `sessionrow.test.tsx` uses a `render(props): string` over `renderToStaticMarkup`.

---

## File Structure

| File | Responsibility |
|---|---|
| `frontend/app/tab/sessionsidebar/sessionviewmodel.ts` | **MODIFY.** Add the pure `buildDuplicateBlockMeta(sourceMeta)` + the `DUPLICATE_META_KEYS` whitelist. (Pure module — no React/Wave imports.) |
| `frontend/app/tab/sessionsidebar/sessionviewmodel.test.ts` | **MODIFY.** Table-driven unit tests for `buildDuplicateBlockMeta`. |
| `frontend/app/tab/sessionsidebar/sessionsidebarmodel.ts` | **MODIFY.** Add `duplicateSession(sourceTabId)` (resolve source term block → copy meta → CreateTab inactive → SetMeta block + tab → activate). |
| `frontend/app/tab/sessionsidebar/sessionrow.tsx` | **MODIFY.** Add `onContextMenu?` + `renameRef?` props to `SessionRow`; refactor double-click rename into a `startEdit` reused by both. |
| `frontend/app/tab/sessionsidebar/sessionsidebar.tsx` | **MODIFY.** In `SessionRowTree`, build the row context menu (Rename/Pin/Duplicate/Close) and wire `onContextMenu` + a per-row `renameRef`. |

---

## Task 1: Pure `buildDuplicateBlockMeta` (TDD)

**Files:**
- Modify: `frontend/app/tab/sessionsidebar/sessionviewmodel.ts`
- Test: `frontend/app/tab/sessionsidebar/sessionviewmodel.test.ts`

- [ ] **Step 1: Write the failing tests (append to `sessionviewmodel.test.ts`)**

Add `buildDuplicateBlockMeta` to the existing import from `./sessionviewmodel`, then append:

```ts
describe("buildDuplicateBlockMeta", () => {
    it("copies an agent session's launch meta and forces view=term", () => {
        const src = { view: "term", controller: "cmd", cmd: "claude", "cmd:interactive": true, "cmd:cwd": "/src/x" };
        expect(buildDuplicateBlockMeta(src)).toEqual({
            view: "term",
            controller: "cmd",
            cmd: "claude",
            "cmd:interactive": true,
            "cmd:cwd": "/src/x",
        });
    });
    it("copies a plain shell session (no cmd)", () => {
        const src = { view: "term", controller: "shell", "cmd:cwd": "/src/x" };
        expect(buildDuplicateBlockMeta(src)).toEqual({ view: "term", controller: "shell", "cmd:cwd": "/src/x" });
    });
    it("preserves a remote connection", () => {
        const src = { view: "term", controller: "shell", "cmd:cwd": "/src/x", connection: "user@host" };
        expect(buildDuplicateBlockMeta(src)).toEqual({
            view: "term",
            controller: "shell",
            "cmd:cwd": "/src/x",
            connection: "user@host",
        });
    });
    it("copies cmd:args when present", () => {
        const src = { view: "term", controller: "cmd", cmd: "codex", "cmd:args": ["--flag"], "cmd:cwd": "/x" };
        expect(buildDuplicateBlockMeta(src)["cmd:args"]).toEqual(["--flag"]);
    });
    it("drops non-launch keys (labels, fontsize, view override)", () => {
        const src = { view: "preview", controller: "shell", "cmd:cwd": "/x", "session:label": "L", "term:fontsize": 14 };
        const out = buildDuplicateBlockMeta(src);
        expect(out.view).toBe("term");
        expect(out["session:label"]).toBeUndefined();
        expect(out["term:fontsize"]).toBeUndefined();
    });
    it("handles a null/empty source", () => {
        expect(buildDuplicateBlockMeta(undefined as any)).toEqual({ view: "term" });
        expect(buildDuplicateBlockMeta({})).toEqual({ view: "term" });
    });
});
```

- [ ] **Step 2: Run the tests, verify they fail**

Run: `npx vitest run frontend/app/tab/sessionsidebar/sessionviewmodel.test.ts`
Expected: FAIL — `buildDuplicateBlockMeta` is not exported.

- [ ] **Step 3: Implement (append to `sessionviewmodel.ts`)**

```ts
/** Launch-relevant block meta keys copied from a source terminal block to reproduce its session in a clone. */
const DUPLICATE_META_KEYS = ["controller", "cmd", "cmd:args", "cmd:cwd", "cmd:interactive", "connection"];

/** Pure: build the new block-def meta for a duplicated session from the source term block's meta.
 *  Always a terminal; copies only the launch-relevant keys that are present on the source so the clone
 *  reproduces exactly how the source was started (agent re-launches; a plain shell stays a shell in the cwd). */
export function buildDuplicateBlockMeta(sourceMeta: Record<string, any>): Record<string, any> {
    const meta: Record<string, any> = { view: "term" };
    for (const key of DUPLICATE_META_KEYS) {
        if (sourceMeta?.[key] != null) {
            meta[key] = sourceMeta[key];
        }
    }
    return meta;
}
```

- [ ] **Step 4: Run the tests, verify they pass**

Run: `npx vitest run frontend/app/tab/sessionsidebar/sessionviewmodel.test.ts`
Expected: PASS — all new cases plus the unchanged existing cases.

- [ ] **Step 5: Checkpoint**

Pure duplicate-meta helper implemented and green; no other behavior touched. No commit.

---

## Task 2: `duplicateSession` wiring

**Files:**
- Modify: `frontend/app/tab/sessionsidebar/sessionsidebarmodel.ts`

- [ ] **Step 1: Add imports**

Add `WorkspaceService` and the pure helper. Update the `services` import (add a new line near the other `@/app/store` imports) and the `sessionviewmodel` import block:

```ts
import { WorkspaceService } from "@/app/store/services";
```

Add `buildDuplicateBlockMeta` to the existing `./sessionviewmodel` import list (which already imports `buildSessionViewModel`, `cycleTarget`, etc.).

- [ ] **Step 2: Add `duplicateSession` (append near `findActiveSessionTermBlock`, end of file)**

```ts
/** Resolve a tab's terminal block (the session block) — same rule the sidebar groups on. */
function findSessionTermBlock(tabId: string): { blockId: string; meta: Record<string, any> } | undefined {
    const tab = globalStore.get(WOS.getWaveObjectAtom<Tab>(WOS.makeORef("tab", tabId)));
    for (const blockId of tab?.blockids ?? []) {
        const block = globalStore.get(WOS.getWaveObjectAtom<Block>(WOS.makeORef("block", blockId)));
        if (block?.meta?.view === "term" && block.meta["cmd:cwd"]) {
            return { blockId, meta: block.meta };
        }
    }
    return undefined;
}

/** Duplicate a session: open a new tab running the same agent in the same cwd as the source.
 *  Reconfigures the new tab's default shell block *before* activating it, so the controller starts
 *  with the cloned cmd:cwd/cmd (the backend doesn't start the controller until the tab renders). */
export function duplicateSession(sourceTabId: string) {
    const source = findSessionTermBlock(sourceTabId);
    if (source == null) {
        return;
    }
    const ws = globalStore.get(atoms.workspace);
    if (ws?.oid == null) {
        return;
    }
    const srcTab = globalStore.get(WOS.getWaveObjectAtom<Tab>(WOS.makeORef("tab", sourceTabId)));
    const agent = srcTab?.meta?.["session:agent"];
    const blockMeta = buildDuplicateBlockMeta(source.meta);
    fireAndForget(async () => {
        const newTabId = await WorkspaceService.CreateTab(ws.oid, "", false);
        const newTab = globalStore.get(WOS.getWaveObjectAtom<Tab>(WOS.makeORef("tab", newTabId)));
        const defaultBlockId = newTab?.blockids?.[0];
        if (defaultBlockId != null) {
            await RpcApi.SetMetaCommand(TabRpcClient, {
                oref: WOS.makeORef("block", defaultBlockId),
                meta: blockMeta,
            });
        }
        if (agent != null) {
            await RpcApi.SetMetaCommand(TabRpcClient, {
                oref: WOS.makeORef("tab", newTabId),
                meta: { "session:agent": agent },
            });
        }
        setActiveTab(newTabId);
    });
}
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean. (`WorkspaceService.CreateTab` returns `Promise<string>`; `atoms`, `globalStore`, `WOS`, `RpcApi`, `TabRpcClient`, `fireAndForget`, `setActiveTab` are already imported.)

- [ ] **Step 4: Checkpoint**

`duplicateSession` resolves the source block, clones its launch meta, and creates+configures+activates a new tab. Verified live in Task 5. No commit.

---

## Task 3: `SessionRow` context-menu + rename-trigger props

**Files:**
- Modify: `frontend/app/tab/sessionsidebar/sessionrow.tsx`

- [ ] **Step 1: Extend the react import + props**

Update the react import (`:5`) to add `type RefObject`:

```ts
import { useRef, useState, type ReactNode, type RefObject } from "react";
```

Add two props to `SessionRowProps` (after `onTogglePin: () => void;`, `:41`):

```ts
    onContextMenu?: (e: React.MouseEvent) => void;
    renameRef?: RefObject<(() => void) | null>;
```

- [ ] **Step 2: Refactor double-click rename into a reusable `startEdit` + expose via `renameRef`**

In the `SessionRow` body, after the `cancelledRef` line (`:61`), add:

```ts
    const startEdit = () => {
        setDraft(editValue ?? "");
        setEditing(true);
    };
    if (renameRef) {
        renameRef.current = startEdit;
    }
```

Add `onContextMenu`/`renameRef` to the destructured props (in the `SessionRow({ ... })` list), then wire `onContextMenu` on the row `<div>` (alongside its existing `onClick={onSelect}`):

```tsx
            onClick={onSelect}
            onContextMenu={onContextMenu}
```

Replace the label span's inline double-click body (`:117-124`) to call `startEdit`:

```tsx
                        onDoubleClick={(e) => {
                            if (!onRename) {
                                return;
                            }
                            e.stopPropagation();
                            startEdit();
                        }}
```

- [ ] **Step 3: Typecheck + existing render tests still pass**

Run: `npx tsc --noEmit` → clean.
Run: `npx vitest run frontend/app/tab/sessionsidebar/sessionrow.test.tsx` → PASS (props are optional; static markup unchanged). The context-menu trigger itself is verified live in Task 5 (the `renderToStaticMarkup` harness can't fire `onContextMenu`).

- [ ] **Step 4: Checkpoint**

`SessionRow` accepts an `onContextMenu` handler and exposes its inline-rename trigger via `renameRef`; double-click rename still works through the shared `startEdit`. No commit.

---

## Task 4: Build + wire the row context menu

**Files:**
- Modify: `frontend/app/tab/sessionsidebar/sessionsidebar.tsx`

- [ ] **Step 1: Update imports**

Add to the react import: `useRef`. Add these imports:

```ts
import { ContextMenuModel } from "@/app/store/contextmenu";
import { atoms } from "@/app/store/global-atoms";
import { globalStore } from "@/app/store/jotaiStore";
import { fireAndForget } from "@/util/util";
```

Add `getApi` to the existing `@/app/store/global` import (which already imports `createTab`, `setActiveTab`), and add `duplicateSession` to the existing `./sessionsidebarmodel` import.

- [ ] **Step 2: Add the menu builder (after `PINNED_LABEL`, `:14`)**

```tsx
function buildSessionRowMenu(row: SessionRowVM, renameRef: React.RefObject<(() => void) | null>): ContextMenuItem[] {
    const ws = globalStore.get(atoms.workspace);
    const menu: ContextMenuItem[] = [
        { label: "Rename", click: () => renameRef.current?.() },
        { label: row.pinned ? "Unpin" : "Pin", click: () => togglePin(row.tabId, row.pinned) },
    ];
    if (row.termBlockOref) {
        menu.push({ label: "Duplicate session", click: () => duplicateSession(row.tabId) });
    }
    menu.push({ type: "separator" });
    menu.push({
        label: "Close tab",
        click: () => {
            if (ws?.oid == null) {
                return;
            }
            fireAndForget(() => getApi().closeTab(ws.oid, row.tabId, false));
        },
    });
    return menu;
}
```

- [ ] **Step 3: Wire `onContextMenu` + `renameRef` in `SessionRowTree`**

Replace `SessionRowTree` (`:16-40`):

```tsx
function SessionRowTree({ row }: { row: SessionRowVM }) {
    const renameRef = useRef<(() => void) | null>(null);
    const onContextMenu = (e: React.MouseEvent) => {
        e.preventDefault();
        ContextMenuModel.getInstance().showContextMenu(buildSessionRowMenu(row, renameRef), e);
    };
    return (
        <>
            <SessionRow
                label={row.label}
                status={row.status}
                active={row.active}
                blocked={row.blocked}
                pinned={row.pinned}
                detail={row.detail}
                subagentCount={row.subagents.length}
                expanded={row.subagentsExpanded}
                editValue={row.customLabel}
                renameRef={renameRef}
                onContextMenu={onContextMenu}
                onToggleExpand={() => toggleSubagentExpand(row.termBlockOref, row.subagentsExpanded)}
                onRename={(name) => renameSession(row.tabId, name)}
                onSelect={() => setActiveTab(row.tabId)}
                onTogglePin={() => togglePin(row.tabId, row.pinned)}
            />
            {row.subagentsExpanded &&
                row.subagents.map((sa, i) => (
                    <SubagentRow key={sa.id} type={sa.type} state={sa.state} last={i === row.subagents.length - 1} />
                ))}
        </>
    );
}
```

- [ ] **Step 4: Typecheck + full sidebar suite**

Run: `npx tsc --noEmit` → clean.
Run: `npx vitest run frontend/app/tab/sessionsidebar` → all green.
Run: `npx eslint frontend/app/tab/sessionsidebar/**/*.{ts,tsx}` → clean.

- [ ] **Step 5: Checkpoint**

Right-clicking a row opens Rename · Pin/Unpin · Duplicate session · ─── · Close tab, wired to the real handlers. No commit.

---

## Task 5: Live verification (CDP) + fallback

**Files:** none (verification only). Dev app on `:9222` with `app:tabbar=left` (see `memory/cdp-verify-dev-app.md`).

- [ ] **Step 1:** `npx vitest run frontend/app/tab/sessionsidebar` → green; `npx tsc --noEmit` → clean; `npx eslint frontend/app/tab/sessionsidebar/**/*.{ts,tsx}` → clean.
- [ ] **Step 2: Menu renders.** Right-click a session row → menu shows Rename · Pin/Unpin · Duplicate session · ─── · Close tab. Rows with no terminal block (no `cmd:cwd`) omit **Duplicate session**.
- [ ] **Step 3: Duplicate a shell session.** In a session that's a plain shell in a repo, click **Duplicate session** → a new tab activates with a single terminal already `cd`'d to the same cwd (run `pwd` to confirm). It appears as a new row in the same group. **Critical check:** the tab has exactly **one** block (no leftover default shell, no split).
- [ ] **Step 4: Duplicate an agent session.** In a session launched as `{controller:"cmd", cmd:"claude", ...}`, Duplicate → the clone relaunches the agent in the same cwd. Confirm the cloned row shows the same `session:agent` identity.
- [ ] **Step 5: Other menu items.** Rename starts the inline editor (same as double-click); Pin/Unpin toggles and the label flips; Close tab closes the row.
- [ ] **Step 6: Fallback if Step 3 fails.** If the clone opens a shell in the *home* dir (default block's controller started before SetMeta) or the tab shows two blocks, the create-inactive timing assumption is wrong on this build. Switch `duplicateSession` (Task 2) to the add-then-delete sequence and re-verify Step 3:

```ts
    fireAndForget(async () => {
        const newTabId = await WorkspaceService.CreateTab(ws.oid, "", true);
        const newTab = globalStore.get(WOS.getWaveObjectAtom<Tab>(WOS.makeORef("tab", newTabId)));
        const defaultBlockId = newTab?.blockids?.[0];
        await RpcApi.CreateBlockCommand(TabRpcClient, {
            tabid: newTabId,
            blockdef: { meta: blockMeta },
        });
        if (defaultBlockId != null) {
            await RpcApi.DeleteBlockCommand(TabRpcClient, { blockid: defaultBlockId });
        }
        if (agent != null) {
            await RpcApi.SetMetaCommand(TabRpcClient, {
                oref: WOS.makeORef("tab", newTabId),
                meta: { "session:agent": agent },
            });
        }
    });
```

(`CreateBlockCommand`/`DeleteBlockCommand` exist at `wshclientapi.ts:184,208`; `CommandCreateBlockData = {tabid, blockdef, rtopts?}`, `CommandDeleteBlockData = {blockid}`. This path is race-free but briefly shows the default shell — only adopt it if the preferred path fails.)

- [ ] **Step 7: Checkpoint** — Duplicate session works end-to-end; menu complete. No commit (await batched approval).

---

## Self-Review

**1. Spec coverage:**
- §2 menu (Rename · Pin/Unpin · Duplicate · Close) → Task 4. ✅
- §2/§3 duplicate behavior (copy launch meta; new tab; agent relaunch or shell-in-cwd; same group; fresh label; `session:agent` copied, label/pinned not) → Task 1 (`buildDuplicateBlockMeta` whitelist excludes `session:label`/`session:pinned`) + Task 2 (`duplicateSession` copies only `session:agent`). ✅
- §3 data flow (resolve term block → buildDuplicateBlockMeta → CreateTab → SetMeta block + tab → activate) → Task 2. ✅
- §4 files (pure helper in `sessionviewmodel.ts`; wiring in `sessionsidebarmodel.ts`; `onContextMenu`/renameRef in `sessionrow.tsx`; menu in `sessionsidebar.tsx`) → Tasks 1,2,3,4. ✅
- §5 edge cases (no term block → Duplicate omitted, Task 4 `if (row.termBlockOref)` + Task 2 early return; plain shell → shell in cwd; remote → `connection` copied; active on create → `setActiveTab`) → Tasks 1,2,4. ✅
- §6 testing (pure unit test + live wiring verification) → Task 1 + Task 5. ✅
- §7 open risk (block-in-new-tab sequencing) → resolved by the create-inactive→configure→activate approach (grounded in `block.go:65`), with a verified fallback in Task 5 Step 6. ✅
- §8 out of scope (no hover icon, no picker/presets/backlog, single-block clone, no cross-workspace, no transcript copy) → nothing in the plan adds these. ✅

**2. Placeholder scan:** No "TBD"/"handle later". Every code step shows complete code; the only judgement steps are the live checks in Task 5 (which include the concrete fallback code).

**3. Type consistency:**
- `buildDuplicateBlockMeta(sourceMeta: Record<string,any>): Record<string,any>` — defined Task 1, consumed Task 2 with the source block's `meta`.
- `duplicateSession(sourceTabId: string)` — defined Task 2, called Task 4 (`duplicateSession(row.tabId)`).
- `SessionRow` new optional props `onContextMenu?: (e: React.MouseEvent) => void` and `renameRef?: RefObject<(() => void) | null>` — defined Task 3, supplied Task 4. `renameRef.current = startEdit` (Task 3) is invoked by the menu's `renameRef.current?.()` (Task 4).
- `buildSessionRowMenu(row: SessionRowVM, renameRef): ContextMenuItem[]` — defined + used in Task 4; `SessionRowVM` already carries `tabId`/`pinned`/`termBlockOref`.
- RPC shapes match verified facts: `SetMetaCommand({oref, meta})`, `CreateTab(wsId, "", bool)→string`, `getApi().closeTab(wsId, tabId, false)`, and (fallback) `CreateBlockCommand({tabid, blockdef})` / `DeleteBlockCommand({blockid})`.

---

## Execution Handoff

Strict order: **Task 1 → Task 2** (wiring needs the pure helper). **Task 3 → Task 4** (the menu supplies the props Task 3 adds). Task 2 and Task 4 must both land before Task 5's live checks. A natural sequence: 1, 2, 3, 4, 5.
