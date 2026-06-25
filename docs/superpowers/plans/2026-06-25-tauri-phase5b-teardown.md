# Tauri Phase 5b — Frontend Teardown Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete the Electron-era frontend machinery (layout engine, tab UI, workspace, builder, tsunami, `<webview>`, block tiling-frame, Electron render entry) that Phase 5a proved the cockpit boots without, making the Tauri cockpit the sole frontend — after first severing the cockpit's remaining couplings into those trees.

**Architecture:** Staged "decouple → gate → delete → unify." Stage 1 makes the cockpit independent of the doomed trees while everything still compiles (split `SubBlock`, slim `blockregistry`, cut the AI-panel state, flip context menus, prune `global.ts`/`keymodel.ts`). Stage 2 is an observe-gate (cockpit unchanged, nothing deleted). Stage 3 bulk-deletes the now-orphaned trees + relocates the live session-model layer out of `app/tab/`. Stage 4 removes the dead Electron renderer vite config. Zero new Rust, zero new Go.

**Tech Stack:** TypeScript / React 19 / Jotai / Vitest / Tauri v2. `tsc --noEmit` is the primary teardown safety net; integration is verified by CDP observe-gates on the Windows dev Tauri app (`npx tauri dev`), per spec §6.

**Spec:** `docs/superpowers/specs/2026-06-25-tauri-phase5b-teardown-design.md`. Decisions P5b-1..P5b-8.

**Git:** Per project rules, **one commit at the end** (Task 13), shown for approval. Run `tsc`/`vitest` per task; do not commit intermediate steps. Branch `feat/tauri-migration` (continues from Phase 5a `01e37a34`). The spec + this plan fold into the Phase 5b feature commit.

**Verification model:** Stage-1/3 tasks end with `npx tsc --noEmit -p tsconfig.json` (and `npx vitest run` where tests are touched). The decouple checkpoint (Task 8) and the final gates (Task 13) are CDP observe-gates — inherently build-observe, not unit-scriptable. "Run tsc" below always means `npx tsc --noEmit -p tsconfig.json` from the project root.

---

## File Structure

| File | Disposition | Responsibility |
|---|---|---|
| `frontend/app/block/subblock.tsx` | **create** (T1) | the `SubBlock` chain split out of `block.tsx` (terminal VDOM sub-block) |
| `frontend/app/view/term/term.tsx` | modify (T1) | import `SubBlock` from `subblock.tsx` |
| `frontend/app/block/block.tsx` | modify (T1) → **delete** (T10) | drop the `SubBlock` chain; the tiling-frame remainder dies in T10 |
| `frontend/app/block/blockregistry.ts` | modify (T2) | drop `web`/`waveai`/`help`/`tsunami` registrations (frees those views) |
| `frontend/app/view/term/term-model.ts` | modify (T3) | cut the two `WorkspaceLayoutModel`/`WaveAIModel` touchpoints |
| `frontend/app/store/contextmenu.ts` (+ `.test.ts`) | modify (T4) | `showContextMenu` → `buildTauriMenu`; drop the Electron id-round-trip |
| `frontend/app/store/global.ts` | modify (T5) | remove `createBlock*`/`replaceBlock` + `@/layout` imports |
| `frontend/app/waveenv/{waveenv.ts,waveenvimpl.ts}` | modify (T5) | drop `createBlock` from the `WaveEnv` surface |
| `frontend/app/store/keymodel.ts` | modify (T6) | drop Electron-only fns + deleted-tree imports; prune `appHandleKeyDown` |
| `frontend/app/view/agents/agents.tsx` | modify (T7) | remove the dead `setActiveTab` else-branch |
| `frontend/app/view/agents/session-models/*` | **create via move** (T9) | the 4 live session-model files relocated out of `app/tab/` |
| `frontend/app/block/blocktypes.ts` | modify (T10) | drop frame-only prop types + the `@/layout` `NodeModel` import |
| `electron.vite.config.ts` | modify (T11) | remove the dead `renderer` block |
| (deletions) | T9, T10 | trees + Electron entry + dead-anyway files (exact lists in those tasks) |

---

## Stage 1 — Decouple (compiles throughout; no moves, no deletes)

### Task 1: Split `SubBlock` out of `block.tsx`

**Files:**
- Create: `frontend/app/block/subblock.tsx`
- Modify: `frontend/app/block/block.tsx` (remove the `SubBlock` chain), `frontend/app/view/term/term.tsx:5`

Rationale (spec §5.1.3): `term.tsx` renders the terminal's VDOM via `SubBlock`, which lives in `block.tsx` alongside the tiling `Block`. Extract the `SubBlock` chain (`getViewElem` + `BlockSubBlock` + `SubBlockInner` + `SubBlock`) into its own module so the tiling-frame remainder of `block.tsx` can be deleted in Task 10. `SubBlock` keeps using `makeViewModel` (the slimmed registry, T2).

- [ ] **Step 1: Create `subblock.tsx` with the `SubBlock` chain**

Move these exact pieces from `block.tsx` into the new file: the `getViewElem` helper (block.tsx:29-44), `BlockSubBlock` (63-…), `SubBlockInner` (304-324), and `SubBlock` (326-334). Include the imports they need:

```tsx
// frontend/app/block/subblock.tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The SubBlock chain, split out of block.tsx so the tiling frame (Block/BlockFrame) can be
// deleted while the terminal's VDOM sub-block keeps working. Uses makeViewModel (slimmed registry).
import { FullSubBlockProps, SubBlockProps } from "@/app/block/blocktypes";
import { useTabModel } from "@/app/store/tab-model";
import { useWaveEnv } from "@/app/waveenv/waveenv";
import { CenteredDiv } from "@/element/quickelems";
import { getBlockComponentModel, registerBlockComponentModel, unregisterBlockComponentModel } from "@/store/global";
import { makeORef } from "@/store/wos";
import { isBlank, useAtomValueSafe } from "@/util/util";
import { useAtomValue } from "jotai";
import { memo, useEffect, useMemo, useRef } from "react";
import { BlockEnv } from "./blockenv";
import { makeViewModel } from "./blockregistry";

// ⟪paste getViewElem (block.tsx:29-44), BlockSubBlock (63-…end of that memo),
//   SubBlockInner (304-324), SubBlock (326-334) verbatim here⟫

export { SubBlock };
```

Note: copy the bodies exactly as they appear in `block.tsx`; only the imports are re-derived (drop `BlockFrame`, `@/layout`, and `Block`-only imports that `SubBlock` does not use). `BlockSubBlock` uses `getBlockMetaKeyAtom` via `waveEnv` — keep that usage as-is.

- [ ] **Step 2: Remove the `SubBlock` chain from `block.tsx`**

Delete `getViewElem`, `BlockSubBlock`, `SubBlockInner`, and `SubBlock` from `block.tsx`, and change its final export from `export { Block, SubBlock };` (block.tsx:336) to `export { Block };`. Leave `Block`/`BlockPreview`/`BlockInner` intact (they die in Task 10).

- [ ] **Step 3: Repoint `term.tsx`**

In `frontend/app/view/term/term.tsx:5` change:
```tsx
import { SubBlock } from "@/app/block/block";
```
to:
```tsx
import { SubBlock } from "@/app/block/subblock";
```

- [ ] **Step 4: Verify**

Run tsc. Expected: clean (no new errors; `block.tsx` still compiles with `Block`, `term.tsx` imports `SubBlock` from the new module).

---

### Task 2: Slim `blockregistry`

**Files:**
- Modify: `frontend/app/block/blockregistry.ts`

Rationale (spec §5.1.4, P5b-7): `blockregistry` statically imports every view model, which is what drags `webview`/`tsunami` into the cockpit build. Drop only the four registrations for views being deleted; keep the rest (all clean of doomed-tree imports).

- [ ] **Step 1: Remove the four imports + registrations**

Delete these import lines:
```ts
import { TsunamiViewModel } from "@/app/view/tsunami/tsunami";   // line 12
import { HelpViewModel } from "@/view/helpview/helpview";        // line 19
import { WaveAiModel } from "@/view/waveai/waveai";              // line 21
import { WebViewModel } from "@/view/webview/webview";           // line 22
```
And these registry entries:
```ts
BlockRegistry.set("web", WebViewModel);        // line 27
BlockRegistry.set("waveai", WaveAiModel);      // line 28
BlockRegistry.set("help", HelpViewModel);      // line 33
BlockRegistry.set("tsunami", TsunamiViewModel);// line 35
```
Keep `term`, `preview`, `cpuplot`, `sysinfo`, `vdom`, `tips`, `launcher`, `aifilediff`, `waveconfig`, `processviewer`, `agents`.

- [ ] **Step 2: Verify**

Run tsc. Expected: clean. (The `webview`/`tsunami`/`helpview`/`waveai` files still exist — they're deleted in Task 10 — but nothing imports them now except each other.)

---

### Task 3: Cut the AI-panel state from `term-model.ts`

**Files:**
- Modify: `frontend/app/view/term/term-model.ts:4,16,288-294,843-859`

Rationale (spec §5.1.5, P5b-4): these two touchpoints are the only live imports of `WorkspaceLayoutModel`; removing them frees `WorkspaceLayoutModel` + `app/aipanel/*` for deletion. Both gate the per-terminal Wave AI panel, which the cockpit never mounts.

- [ ] **Step 1: Remove the AI-panel-gated shell button (endIconButtons)**

In `term-model.ts`, delete lines 288-294:
```ts
            const isAIPanelOpen = get(WorkspaceLayoutModel.getInstance().panelVisibleAtom);
            if (isAIPanelOpen) {
                const shellIntegrationButton = this.getShellIntegrationIconButton(get);
                if (shellIntegrationButton) {
                    rtn.push(shellIntegrationButton);
                }
            }
```
(The `endIconButtons` atom keeps the rest of its body — the webgl button block etc.)

- [ ] **Step 2: Remove the "Send to Wave AI" context-menu item**

Delete lines 843-859 (the separator + "Send to Wave AI" item + trailing separator):
```ts
            menu.push({ type: "separator" });
            menu.push({
                label: "Send to Wave AI",
                click: () => {
                    if (selection) {
                        const aiModel = WaveAIModel.getInstance();
                        aiModel.appendText(selection, true, { scrollToBottom: true });
                        const layoutModel = WorkspaceLayoutModel.getInstance();
                        if (!layoutModel.getAIPanelVisible()) {
                            layoutModel.setAIPanelVisible(true);
                        }
                        aiModel.focusInput();
                    }
                },
            });

            menu.push({ type: "separator" });
```

- [ ] **Step 3: Remove the now-unused imports**

Delete `import { WaveAIModel } from "@/app/aipanel/waveai-model";` (line 4) and `import { WorkspaceLayoutModel } from "@/app/workspace/workspace-layout-model";` (line 16). If `getShellIntegrationIconButton` is now unreferenced, leave it (harmless) — tsc will not error on an unused private method; remove it only if tsc/lint flags it.

- [ ] **Step 4: Verify**

Run tsc. Expected: clean. If tsc reports `WaveAIModel`/`WorkspaceLayoutModel` still referenced elsewhere in `term-model.ts`, remove those references (they are AI-panel-related) until clean.

---

### Task 4: Flip `ContextMenuModel` to `buildTauriMenu`

**Files:**
- Modify: `frontend/app/store/contextmenu.ts`
- Modify: `frontend/app/store/contextmenu.test.ts`

Rationale (spec §5.1.6, P5b-8): `term.tsx` has no `WaveEnv` in scope and `ContextMenuModel` has many surviving (orphaned-view) callers, so flip the implementation, not the call sites. Rewriting `showContextMenu` to use `buildTauriMenu` gives every caller a working native menu and drops `getApi().showContextMenu`.

- [ ] **Step 1: Rewrite `showContextMenu`**

Replace the body of `ContextMenuModel.showContextMenu` (contextmenu.ts:71-…) so it builds + pops a Tauri menu instead of registering ids and calling `getApi().showContextMenu`:

```ts
import { buildTauriMenu } from "@/../tauri/menu"; // frontend/tauri/menu.ts — app is Tauri-only now
import { fireAndForget } from "@/util/util";

// ... inside class ContextMenuModel:
showContextMenu(menu: ContextMenuItem[], ev: React.MouseEvent<any>, _opts?: ShowContextMenuOpts): void {
    ev?.preventDefault?.();
    fireAndForget(async () => {
        const m = await buildTauriMenu(menu);
        await m.popup();
    });
}
```

Confirm the import path resolves under the tsconfig aliases (the Tauri vite alias maps `@/...`; `frontend/tauri/menu.ts` is reachable as a relative `../tauri/menu` from `frontend/app/store/` — use whichever path tsc accepts; verify in Step 3). Remove the now-dead id-registration helpers and the `getApi().showContextMenu(...)` call (contextmenu.ts:86) and any `onContextMenuClick` wiring in this file.

- [ ] **Step 2: Update the test**

`contextmenu.test.ts` asserts the old Electron behavior (an `id` is generated, `getApi().showContextMenu` is called — lines 73-78, 123). Rewrite it to assert the new behavior: mock `@/../tauri/menu`'s `buildTauriMenu` (returns an object with a `popup` spy) and assert `showContextMenu` builds the menu from the items and calls `popup`. Example:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";

const popup = vi.fn();
const buildTauriMenu = vi.fn(async () => ({ popup }));
vi.mock("@/../tauri/menu", () => ({ buildTauriMenu: (...a: any[]) => buildTauriMenu(...a) }));

import { ContextMenuModel } from "./contextmenu";

afterEach(() => { buildTauriMenu.mockClear(); popup.mockClear(); });

describe("ContextMenuModel", () => {
    it("builds a Tauri menu from items and pops it", async () => {
        const items = [{ label: "Copy", click: vi.fn() }];
        ContextMenuModel.getInstance().showContextMenu(items as any, { preventDefault() {} } as any);
        await vi.waitFor(() => expect(buildTauriMenu).toHaveBeenCalledWith(items));
        await vi.waitFor(() => expect(popup).toHaveBeenCalled());
    });
});
```

- [ ] **Step 3: Verify**

Run tsc, then `npx vitest run frontend/app/store/contextmenu.test.ts`. Expected: tsc clean; the rewritten test passes. If the `@/../tauri/menu` import does not resolve, fall back to a relative import that does and update the mock path to match.

---

### Task 5: Prune `global.ts` block-create functions + drop `createBlock` from `WaveEnv`

**Files:**
- Modify: `frontend/app/store/global.ts` (imports lines 7-16; functions ~365-445)
- Modify: `frontend/app/waveenv/waveenvimpl.ts:34`, `frontend/app/waveenv/waveenv.ts`

Rationale (spec §5.1.5): `createBlock`/`createBlockSplitHorizontally`/`createBlockSplitVertically`/`replaceBlock` all call `getLayoutModelForStaticTab()` (tiling-tree ops). The cockpit creates agent blocks via `ObjectService.CreateBlock` (the backend RPC, `cockpit-actions.ts:12`), not these. Remove them so `@/layout` can be deleted.

- [ ] **Step 1: Find any surviving caller (safety check)**

Run a search for callers so removal is evidence-based:
```bash
rg -n "createBlockSplitHorizontally|createBlockSplitVertically|\breplaceBlock\b|\bcreateBlock\b" frontend --glob '!frontend/app/store/global.ts'
```
Expected callers are all in dying files (`keymodel.ts` — pruned in T6; `waveenvimpl.ts` — this task; `termsticker`/Electron UI — dies in T10). If a **kept** cockpit file (anything under `app/view/term`, `app/view/agents`, `app/cockpit`) calls one, do NOT remove that function — stop and reassess. Record the caller list in the task notes.

- [ ] **Step 2: Remove the functions + their `@/layout` imports**

Delete `createBlockSplitHorizontally`, `createBlockSplitVertically`, `createBlock`, and `replaceBlock` (global.ts ~365-445) and the `@/layout/index` / `@/layout/lib/types` imports they use (the import block at lines 7-16 — remove `getLayoutModelForStaticTab`, `LayoutTreeActionType`, `LayoutTreeInsertNodeAction`, `newLayoutNode`, `LayoutTreeReplaceNodeAction`, `LayoutTreeSplitHorizontalAction`, `LayoutTreeSplitVerticalAction`). Keep any other `global.ts` symbols.

- [ ] **Step 3: Drop `createBlock` from the `WaveEnv` surface**

In `waveenvimpl.ts`, remove `createBlock,` from the imports (line 7) and `createBlock,` from the returned object (line 34). In `waveenv.ts`, remove the `createBlock` field from the `WaveEnv` interface.

- [ ] **Step 4: Verify**

Run tsc. Expected: clean once T6 (keymodel) has also dropped its `createBlockSplit*`/`replaceBlock` imports. If run before T6, tsc will flag `keymodel.ts` — that is expected; do T6 next. (If you prefer each task independently green, run T6 before T5.)

---

### Task 6: Prune `keymodel.ts`

**Files:**
- Modify: `frontend/app/store/keymodel.ts`

Rationale (spec §5.1.5): `keymodel` is kept (live consumers: `boot-core`→`registerControlShiftStateUpdateHandler`, `term-model.ts:6`→`appHandleKeyDown`, `waveconfig`/`preview-edit`→`tryReinjectKey`). Remove only its dependence on deleted trees.

- [ ] **Step 1: Delete the Electron-only functions**

Delete `registerGlobalKeys` (keymodel.ts:521 to its closing brace) and `registerElectronReinjectKeyHandler` (498-502). Then delete any helper that is now referenced only by those (candidates: `switchTab`, `switchBlock`, tiling-navigation handlers, `handleGitSplit`, `uxCloseBlock`). Use tsc (Step 4) to confirm which became unused.

- [ ] **Step 2: Prune the layout block in `appHandleKeyDown`**

In `appHandleKeyDown` (434-486), delete the `if (isTabWindow()) { … getLayoutModelForStaticTab() … }` block (lines 470-484). The function keeps its chord + `globalKeyMap` handling and the final `return false;`.

- [ ] **Step 3: Remove the deleted-tree imports**

Remove these imports:
```ts
import { cycleSession, cycleWaiting, findActiveLoomBlockId, findActiveSessionTermBlock, jumpToNeedsYou, switchToVisualIndex } from "@/app/tab/sessionsidebar/sessionsidebarmodel"; // line 24
import { loomBinOrDefault } from "@/app/tab/sessionsidebar/sessionviewmodel"; // line 25
import { WorkspaceLayoutModel } from "@/app/workspace/workspace-layout-model"; // line 26
import { deleteLayoutModelForTab, getLayoutModelForStaticTab, NavigateDirection } from "@/layout/index"; // line 27
```
and remove `createBlockSplitHorizontally`, `createBlockSplitVertically`, `replaceBlock` from the `@/app/store/global` import (lines 9,10,20). (These were used only by the functions deleted in Step 1.)

- [ ] **Step 4: Verify + sweep**

Run tsc. Expected: clean. If tsc reports a removed symbol still referenced (e.g. a kept helper used `WorkspaceLayoutModel`), either keep that helper's caller-free deletion going or remove the stray reference — iterate until clean. Confirm `registerControlShiftStateUpdateHandler`, `appHandleKeyDown`, and `tryReinjectKey` still exist and export.

---

### Task 7: Remove the dead `setActiveTab` else-branch in `agents.tsx`

**Files:**
- Modify: `frontend/app/view/agents/agents.tsx:5,629-636`

Rationale (spec §5.1.6): `openTerminal`'s `inlineTerminal` path (630-633) already replaced `setActiveTab`; the else-branch (635) is dead.

- [ ] **Step 1: Remove the else-branch**

Change `openTerminal` (agents.tsx:629-636) to:
```ts
    openTerminal(agentId: string) {
        const agent = globalStore.get(this.agentsAtom).find((a) => a.id === agentId);
        globalStore.set(this.terminalTargetAtom, agent?.blockId);
    }
```
(removing the `if (this.inlineTerminal) { … return; } setActiveTab(agentId);` shape — `inlineTerminal` is always true in the cockpit). If `inlineTerminal` becomes unused elsewhere, leave it; do not expand scope.

- [ ] **Step 2: Drop the import**

In `agents.tsx:5`, change `import { getApi, setActiveTab } from "@/app/store/global";` to `import { getApi } from "@/app/store/global";`.

- [ ] **Step 3: Verify**

Run tsc. Expected: clean.

---

## Stage 2 — Decouple observe-gate

### Task 8: Decouple checkpoint (observe-gate, nothing deleted yet)

Rationale (spec §5.2): prove the cockpit is unchanged by the decouple before deleting anything.

- [ ] **Step 1: Build + run**

Run: `npx tauri dev` (from project root).

- [ ] **Step 2: Verify the gate**

Confirm in the running Tauri window (CDP per [[cdp-verify-dev-app]] if needed):
1. Boots into the cockpit shell (titlebar + roster), no white screen, no `BOOT ERROR`.
2. Roster lists the real agents.
3. Highlighting an agent renders its terminal inline; new PTY output appears; composer input round-trips.
4. Starting a new agent session (the cockpit's new-session action) creates a terminal that renders.
5. Right-clicking the terminal pops a **native** context menu (the `buildTauriMenu` flip); copy/paste work.
6. Phase 2 chrome intact: drag/min/max/close, zoom `Ctrl+=/-/0`, `F11` fullscreen.

Do not proceed to Stage 3 until all six are green. If anything regressed, the cause is in Stage 1 (Tasks 1-7) — fix there, not by deleting.

---

## Stage 3 — Relocate + bulk delete

### Task 9: Relocate the session-model layer, then delete `app/tab/`

**Files:**
- Move: `frontend/app/tab/sessionsidebar/{sessionsidebarmodel.ts, sessionviewmodel.ts, sessionviewmodel.test.ts, agentstatusstore.ts, sessiongroupstore.ts}` → `frontend/app/view/agents/session-models/`
- Modify: `frontend/app/view/agents/liveagents.ts:10-12`, `frontend/app/view/agents/agentsviewmodel.ts:3`
- Delete: the rest of `frontend/app/tab/`

Rationale (spec §5.1.1, P5b-5): these 5 files (4 models + 1 test) have zero doomed-tree imports — the agents roster's live data source. Move them out, then delete the dead tab UI. Done as one task so there is no broken intermediate committed state (tsc runs at the end).

- [ ] **Step 1: Move the live files**

```bash
mkdir -p frontend/app/view/agents/session-models
git mv frontend/app/tab/sessionsidebar/sessionsidebarmodel.ts frontend/app/view/agents/session-models/
git mv frontend/app/tab/sessionsidebar/sessionviewmodel.ts frontend/app/view/agents/session-models/
git mv frontend/app/tab/sessionsidebar/sessionviewmodel.test.ts frontend/app/view/agents/session-models/
git mv frontend/app/tab/sessionsidebar/agentstatusstore.ts frontend/app/view/agents/session-models/
git mv frontend/app/tab/sessionsidebar/sessiongroupstore.ts frontend/app/view/agents/session-models/
```
(Their internal cross-imports are relative and move together; their `@/app/store/*` imports are unaffected.)

- [ ] **Step 2: Update the two live importers**

In `liveagents.ts` (lines 10-12) and `agentsviewmodel.ts` (line 3), change `@/app/tab/sessionsidebar/<file>` → `@/app/view/agents/session-models/<file>` for `agentstatusstore`, `sessionsidebarmodel`, `sessionviewmodel`. (`keymodel.ts`'s former importers were removed in Task 6.)

- [ ] **Step 3: Delete the rest of `app/tab/`**

```bash
git rm -r frontend/app/tab
```
(`session-models` already moved out, so this removes only the dead tab/sessionsidebar UI.)

- [ ] **Step 4: Verify**

Run tsc. Expected: clean — no importer references `@/app/tab/*` (the dead-anyway importers like `workspace.tsx` are deleted in Task 10; if tsc flags them now because Task 10 hasn't run, that is expected — they vanish in Task 10). Run `npx vitest run frontend/app/view/agents/session-models/sessionviewmodel.test.ts`; expected PASS at the new path.

---

### Task 10: Delete the orphaned trees + Electron entry; clean `blocktypes`

**Files:**
- Delete (trees): `frontend/layout/`, `frontend/app/workspace/`, `frontend/builder/`, `frontend/app/view/tsunami/`, `frontend/app/view/webview/`, `frontend/app/view/helpview/`, `frontend/app/view/waveai/waveai.tsx`, `frontend/app/aipanel/`
- Delete (block frame): `frontend/app/block/block.tsx`, `frontend/app/block/blockframe.tsx`, `frontend/app/block/blockframe-header.tsx`, `frontend/app/block/block-model.ts`, `frontend/app/block/connstatusoverlay.tsx`
- Delete (Electron entry): `frontend/wave.ts`, `frontend/app/app.tsx`, `frontend/index.html`
- Delete (dead-anyway): `frontend/app/store/focusManager.ts`, `frontend/app/store/tabrpcclient.ts`, `frontend/app/view/waveai/`, `frontend/app/onboarding/`, `frontend/app/modals/modalregistry.tsx`, `frontend/app/modals/conntypeahead.tsx`, `frontend/app/aipanel/aitooluse.tsx` (covered by the `aipanel/` delete)
- Modify: `frontend/app/block/blocktypes.ts`

Rationale (spec §5.3): everything provably dead once the Electron entry and frame go. `tsc` is the safety net. Delete in a deletions-first order, then sweep.

- [ ] **Step 1: Delete the Electron entry + trees**

```bash
git rm frontend/wave.ts frontend/app/app.tsx frontend/index.html
git rm -r frontend/layout frontend/app/workspace frontend/builder
git rm -r frontend/app/view/tsunami frontend/app/view/webview frontend/app/view/helpview frontend/app/view/waveai
git rm -r frontend/app/aipanel frontend/app/onboarding
git rm frontend/app/store/focusManager.ts frontend/app/store/tabrpcclient.ts
git rm frontend/app/modals/modalregistry.tsx frontend/app/modals/conntypeahead.tsx
git rm frontend/app/block/block.tsx frontend/app/block/blockframe.tsx frontend/app/block/blockframe-header.tsx frontend/app/block/block-model.ts frontend/app/block/connstatusoverlay.tsx
```

- [ ] **Step 2: Clean `blocktypes.ts`**

Now that the frame is gone, remove the frame-only prop types and the `@/layout` import from `blocktypes.ts`:
```ts
// remove line 4: import { NodeModel } from "@/layout/index";
// remove FullBlockProps (16-20), BlockProps (22-25), BlockFrameProps (43-51)
```
Keep `BlockNodeModel`, `FullSubBlockProps`, `SubBlockProps`, `BlockComponentModel2` (the surviving `SubBlock`/registry surface).

- [ ] **Step 3: tsc sweep**

Run tsc. The errors are the residual-importer worklist. Expected residual breakages and their fixes:
- Any file importing a deleted module that itself was *not* listed → it is either (a) also dead (delete it, re-run) or (b) a kept file with a stray import (remove the import). Most kept views import only `blocktypes`/`blockregistry`/their own dir — clean.
- `modalregistry`/`conntypeahead` consumers: if a kept file imported them, that file is on the Electron path — verify and delete.
Iterate `git rm` / import-removal until tsc is clean. Record every file deleted beyond the list above.

- [ ] **Step 4: Delete orphaned tests + vitest sweep**

Run `npx vitest run`. Delete or fix any test file that imports a deleted module (e.g. former `webview.test.tsx`/`widgetfilter.test.ts` went with their dirs; check for stragglers under `frontend/app`). Re-run until green. Expected: PASS.

---

## Stage 4 — Vite / entry unification

### Task 11: Remove the dead Electron renderer config

**Files:**
- Modify: `electron.vite.config.ts:124-176` (the `renderer` block)
- Modify (optional): `frontend/tauri/vite.config.ts:20-21` (dead `@/layout`/`@/builder` aliases)

Rationale (spec §5.4, P5b-2): the `renderer` block's input (`index.html`) is deleted; the Tauri config (`frontend/tauri/vite.config.ts`) is already the renderer Tauri uses. `main`/`preload` stay for Phase 4.

- [ ] **Step 1: Remove the `renderer` block**

Delete the entire `renderer: { … }` block (electron.vite.config.ts:124-176) from the `defineConfig` object, leaving `main` and `preload`.

- [ ] **Step 2 (optional): Drop dead aliases**

In `frontend/tauri/vite.config.ts`, remove the now-dead `"@/layout"` (line 20) and `"@/builder"` (line 21) aliases. Keep `"@/preview"` (the preview harness is not deleted). Skip if it risks tsconfig drift — harmless to leave.

- [ ] **Step 3: Verify**

Run tsc, then `cargo check --manifest-path src-tauri/Cargo.toml`. Expected: tsc clean; cargo clean (no Rust change). Do not run `electron-vite build` — the Electron renderer is intentionally gone (P5b-1).

---

## Final

### Task 12: Chrome cut-methods cleanup

**Files:**
- Modify (conditional): `frontend/tauri/api.ts`, `frontend/types/custom.d.ts`, the `updateWindowControlsOverlay` caller

Rationale (spec §5.1.6): `updateWindowControlsOverlay` and `onMenuItemAbout` are Electron-shaped bridge methods. Remove them if their callers are gone.

- [ ] **Step 1: Find callers**

```bash
rg -n "updateWindowControlsOverlay|onMenuItemAbout" frontend
```

- [ ] **Step 2: Remove if dead**

If the only callers are in deleted files (or only the `api.ts` stub + type decl remain), delete the method from `frontend/tauri/api.ts`, its `ElectronApi` entry in `frontend/types/custom.d.ts`, and any remaining caller (e.g. `app-bg.tsx` if that file survived and the call is now inert). If a **kept** cockpit file still calls one with real intent, leave it (out of scope) and note it. The `showContextMenu`/`onContextMenuClick` `api.ts` stubs + `api.test.ts` stay (harmless; optional removal).

- [ ] **Step 3: Verify**

Run tsc + `npx vitest run`. Expected: clean/green.

---

### Task 13: Full verification + single commit

- [ ] **Step 1: Full static verification**

Run, in order:
- `npx tsc --noEmit -p tsconfig.json` → clean
- `npx vitest run` → PASS (Phase 0–5a suite + the updated `contextmenu.test.ts` + relocated `sessionviewmodel.test.ts`)
- `cargo check --manifest-path src-tauri/Cargo.toml` → clean

- [ ] **Step 2: Final observe-gates (Windows dev Tauri app)**

Run `npx tauri dev` and confirm gates 1–6 from Task 8 still pass **after** the deletions: boots → roster → inline terminal (output + input) → new agent session → native context menu → Phase 2 chrome, and **no** `[tauri-bridge] stub called:` on the happy path. Record the result.

- [ ] **Step 3: Self-review the diff**

Confirm: no commented-out code, no stray debug logs, the cockpit behavior is unchanged from end-of-5a, only deletions/relocations/prunes were made, no new Rust/Go. Run `git status` and verify the deleted set matches Tasks 9-10 (plus any tsc-sweep additions, which should be recorded).

- [ ] **Step 4: Show the commit for approval, then commit**

Per project git rules, present the file list (status + brief summary) and the message, ask "Awaiting approval. Proceed? (yes/no)", then on approval commit (spec + plan fold in):

```bash
git add -A
git commit -m "feat(tauri): phase-5b frontend teardown (delete Electron tree, slim block registry, native context menus)"
```

---

## Self-Review (against the spec)

**Spec coverage:** §5.1.1 (relocate session-models) → Task 9. §5.1.2 (NodeModel) → folded into Task 10 Step 2 (the cockpit uses `BlockNodeModel`, not `NodeModel`; the frame-only types are dropped with the frame — no separate extraction, per the blocktypes read). §5.1.3 (split SubBlock) → Task 1. §5.1.4 (slim registry) → Task 2. §5.1.5 (AI-panel cut + global/keymodel prune) → Tasks 3, 5, 6. §5.1.6 (context-menu flip, chrome cut-methods, setActiveTab) → Tasks 4, 12, 7. §5.2 (decouple gate) → Task 8. §5.3 (bulk delete) → Tasks 9, 10. §5.4 (vite unify) → Task 11. §6 (verification) → tsc/vitest per task + Tasks 8 & 13 gates. §7 deferrals (emain, package.json, preview, orphaned views) → untouched by design (noted in Task 11 Step 3 / not in any task). Each P5b decision maps to a task.

**Placeholder scan:** the prune/delete tasks (5, 6, 10) intentionally use a "remove the named symbols/files, then `tsc`-sweep the residual" method — this is the correct technique for a teardown (the exact residual set is only knowable post-deletion), and each is bounded with exact anchors, a caller-search step, and explicit decision rules, not vague "handle the rest." Task 1's `subblock.tsx` body is a verbatim move of named line ranges (not re-authored), so the code is the existing code. No `TBD`/`TODO`.

**Type/name consistency:** `SubBlock` (exported from `subblock.tsx`, imported in `term.tsx`); `BlockNodeModel`/`SubBlockProps`/`FullSubBlockProps` kept in `blocktypes.ts` and used by `subblock.tsx`; `buildTauriMenu(menu)` signature matches `frontend/tauri/menu.ts`; `registerControlShiftStateUpdateHandler`/`appHandleKeyDown`/`tryReinjectKey` kept in `keymodel.ts` and consumed by `boot-core`/`term-model`/`waveconfig`. `ObjectService.CreateBlock` (kept, backend RPC) is distinct from the pruned `global.ts` `createBlock`.
