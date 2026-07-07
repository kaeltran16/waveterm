# Themed Right-Click Context Menu Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the native OS context menu with a single themed React menu, and add right-click menus to the cockpit card and transcript surfaces.

**Architecture:** A jotai atom (`contextMenuAtom`) holds `{items, x, y} | null`. `ContextMenuModel.showContextMenu(items, ev)` sets it (instead of building a native Tauri menu). A `<ContextMenuHost/>` mounted once in `cockpit-root` renders a `@floating-ui/react`-positioned panel anchored to the cursor via a virtual reference. Because the imperative `showContextMenu(items, ev)` API is unchanged, all seven existing callers become themed with zero call-site edits; new surfaces just add an `onContextMenu` handler.

**Tech Stack:** React 19, jotai, `@floating-ui/react` (already a dependency), Tailwind v4 `@theme` tokens, vitest.

**Spec:** `docs/superpowers/specs/2026-07-07-right-click-context-menu-design.md`

---

## File Structure

- `frontend/app/store/contextmenu.ts` — MODIFY. Add `contextMenuAtom`, `closeContextMenu()`, `visibleItems()`, `roleAction()`; repoint `ContextMenuModel.showContextMenu` from native menu to the atom (Task 3). Store + pure helpers, no React/floating-ui import (keeps it unit-testable).
- `frontend/app/store/contextmenu.test.ts` — REPLACE. Tests the atom, helpers, and the repointed model.
- `frontend/app/element/contextmenu.tsx` — CREATE. The themed floating panel (`ContextMenu`, `Row`, `SubmenuRow`). View only; CDP-verified.
- `frontend/app/element/contextmenuhost.tsx` — CREATE. Subscribes to `contextMenuAtom`, renders `<ContextMenu>`.
- `frontend/app/cockpit/cockpit-root.tsx` — MODIFY. Mount `<ContextMenuHost/>` beside `<ModalsRenderer/>`.
- `frontend/tauri/menu.ts` + `frontend/tauri/menu.test.ts` — DELETE (native path dead after repoint).
- `frontend/tauri/api.ts:88` — MODIFY. Fix the stale comment that names `menu.ts buildTauriMenu`.
- `frontend/app/view/agents/agentrow.tsx` — MODIFY. Add card `onContextMenu` + `onToggleFullWidth` prop.
- `frontend/app/view/agents/cockpitsurface.tsx` — MODIFY. Wire `onToggleFullWidth`.
- `frontend/app/view/agents/narrationtimeline.tsx` — MODIFY. Add "Copy text" menu on prose rows.

**Why this order:** helpers/atom exist before the view that imports them; the view is mounted (inert) before the model is repointed, so every commit leaves context menus working (native until Task 3, themed after). Deletion follows the repoint; surface rollout is last.

---

### Task 1: Store atom + pure helpers (native menu still active)

Adds the atom and helper functions used by the view. `showContextMenu` is **not** repointed yet — native menus keep working, so this commit is safe on its own.

**Files:**
- Modify: `frontend/app/store/contextmenu.ts`
- Test: `frontend/app/store/contextmenu.test.ts` (replace contents)

- [ ] **Step 1: Write the failing tests**

Replace the entire contents of `frontend/app/store/contextmenu.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";
import { globalStore } from "./jotaiStore";
import { closeContextMenu, contextMenuAtom, roleAction, visibleItems } from "./contextmenu";

afterEach(() => globalStore.set(contextMenuAtom, null));

describe("contextMenuAtom helpers", () => {
    it("closeContextMenu clears the atom", () => {
        globalStore.set(contextMenuAtom, { items: [{ label: "A" }], x: 1, y: 2 });
        closeContextMenu();
        expect(globalStore.get(contextMenuAtom)).toBeNull();
    });

    it("visibleItems drops items with visible === false", () => {
        const items: ContextMenuItem[] = [
            { label: "Shown" },
            { label: "Hidden", visible: false },
            { label: "AlsoShown", visible: true },
        ];
        expect(visibleItems(items).map((i) => i.label)).toEqual(["Shown", "AlsoShown"]);
    });

    it("roleAction returns a function for known roles and undefined otherwise", () => {
        expect(typeof roleAction("copy")).toBe("function");
        expect(typeof roleAction("Paste")).toBe("function");
        expect(roleAction("bogus")).toBeUndefined();
        expect(roleAction(undefined)).toBeUndefined();
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run frontend/app/store/contextmenu.test.ts`
Expected: FAIL — `closeContextMenu`, `contextMenuAtom`, `roleAction`, `visibleItems` are not exported.

- [ ] **Step 3: Add the atom and helpers**

Edit `frontend/app/store/contextmenu.ts`. Add the imports and the exported members. Keep the existing `ContextMenuModel` class and its `buildTauriMenu` call **unchanged** in this task. New file top:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { atom } from "jotai";
import { fireAndForget } from "@/util/util";
import { buildTauriMenu } from "../../tauri/menu";
import { globalStore } from "./jotaiStore";

export type ContextMenuState = { items: ContextMenuItem[]; x: number; y: number };

// null when no menu is open; <ContextMenuHost> renders <ContextMenu> when non-null.
export const contextMenuAtom = atom<ContextMenuState | null>(null);

export function closeContextMenu(): void {
    globalStore.set(contextMenuAtom, null);
}

// visible === false hides an item (matches the old native behavior in menu.ts).
export function visibleItems(items: ContextMenuItem[]): ContextMenuItem[] {
    return items.filter((it) => it.visible !== false);
}

// Fallback for items that carry an Electron `role` instead of a click. No production caller sets
// role today (only a test did), so this is a parity safety-net. paste depends on focus + is async;
// kept for completeness but unreliable outside a focused editable — real callers use `click`.
export function roleAction(role?: string): (() => void) | undefined {
    switch (role?.toLowerCase()) {
        case "copy":
            return () => document.execCommand("copy");
        case "cut":
            return () => document.execCommand("cut");
        case "paste":
            return () => document.execCommand("paste");
        case "selectall":
            return () => document.execCommand("selectAll");
        default:
            return undefined;
    }
}
```

Leave the rest of the file (`ShowContextMenuOpts`, `ContextMenuModel`) exactly as it is.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run frontend/app/store/contextmenu.test.ts`
Expected: PASS (3 tests).

Note: the previous test in this file asserted `buildTauriMenu` was called; that assertion is intentionally removed here and re-added as a repoint test in Task 3.

- [ ] **Step 5: Commit**

```bash
git add frontend/app/store/contextmenu.ts frontend/app/store/contextmenu.test.ts
git commit -m "feat(contextmenu): add themed-menu atom and pure helpers"
```

---

### Task 2: Themed `ContextMenu` component + host (inert until Task 3)

Creates the view and mounts it. Nothing sets the atom yet, so the host renders nothing and native menus still work. This isolates the render code in one reviewable commit.

**Files:**
- Create: `frontend/app/element/contextmenu.tsx`
- Create: `frontend/app/element/contextmenuhost.tsx`
- Modify: `frontend/app/cockpit/cockpit-root.tsx`

No unit test: `@testing-library/react` is not a dependency (see `frontend/app/element/motionhooks.test.ts:7-10`). The component is verified via CDP in Task 3, once the atom is wired.

- [ ] **Step 1: Create the component**

Create `frontend/app/element/contextmenu.tsx`:

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Themed right-click menu. Replaces the native Tauri menu (frontend/tauri/menu.ts, deleted): a
// portaled floating panel styled with @theme tokens, anchored to the cursor via a floating-ui
// virtual reference. Mouse-first — hover highlights, click runs, hover opens submenus, Esc /
// outside-click dismisses. Submenus render as an absolutely-positioned child of the row (not a
// portal) so moving the pointer onto them does not fire the row's mouseleave. The design leaves
// room to add keyboard nav later.

import { closeContextMenu, roleAction, visibleItems, type ContextMenuState } from "@/app/store/contextmenu";
import { cn } from "@/util/util";
import {
    autoUpdate,
    flip,
    FloatingPortal,
    offset,
    shift,
    useDismiss,
    useFloating,
    useInteractions,
} from "@floating-ui/react";
import { useEffect, useRef, useState } from "react";

const PANEL = "z-[1000] min-w-[180px] rounded-[8px] border border-edge-mid bg-surface-raised py-1 shadow-lg";
const ITEM = "relative flex cursor-pointer items-center gap-2 px-3 py-1 font-mono text-[12.5px] text-secondary hover:bg-accent/10 hover:text-primary";
const ITEM_DISABLED = "cursor-default opacity-50 hover:bg-transparent hover:text-secondary";

function runClick(item: ContextMenuItem) {
    if (item.enabled === false) {
        return;
    }
    const act = item.click ?? roleAction(item.role);
    act?.();
    closeContextMenu();
}

function Row({ item }: { item: ContextMenuItem }) {
    if (item.type === "separator") {
        return <div className="my-1 h-px bg-edge-mid" />;
    }
    if (item.type === "header") {
        return (
            <div className="px-3 py-1 font-mono text-[10px] font-bold uppercase tracking-[0.06em] text-muted">
                {item.label}
            </div>
        );
    }
    if (item.submenu) {
        return <SubmenuRow item={item} />;
    }
    const disabled = item.enabled === false;
    return (
        <div className={cn(ITEM, disabled && ITEM_DISABLED)} onClick={() => runClick(item)}>
            {item.type === "checkbox" ? <span className="w-3 text-accent">{item.checked ? "✓" : ""}</span> : null}
            <span className="flex-1 whitespace-nowrap">{item.label}</span>
            {item.sublabel ? <span className="ml-4 text-muted">{item.sublabel}</span> : null}
        </div>
    );
}

function SubmenuRow({ item }: { item: ContextMenuItem }) {
    const [open, setOpen] = useState(false);
    const [flipLeft, setFlipLeft] = useState(false);
    const ref = useRef<HTMLDivElement>(null);
    const disabled = item.enabled === false;
    const onEnter = () => {
        if (disabled) {
            return;
        }
        const r = ref.current?.getBoundingClientRect();
        if (r) {
            setFlipLeft(r.right + 200 > window.innerWidth);
        }
        setOpen(true);
    };
    return (
        <div
            ref={ref}
            className={cn(ITEM, disabled && ITEM_DISABLED)}
            onMouseEnter={onEnter}
            onMouseLeave={() => setOpen(false)}
        >
            <span className="flex-1 whitespace-nowrap">{item.label}</span>
            <span className="ml-4 text-muted">›</span>
            {open ? (
                <div className={cn(PANEL, "absolute top-[-5px]", flipLeft ? "right-full mr-1" : "left-full ml-1")}>
                    {visibleItems(item.submenu!).map((sub, i) => (
                        <Row key={i} item={sub} />
                    ))}
                </div>
            ) : null}
        </div>
    );
}

export function ContextMenu({ state }: { state: ContextMenuState }) {
    const { items, x, y } = state;
    const { refs, floatingStyles, context } = useFloating({
        open: true,
        onOpenChange: (o) => {
            if (!o) {
                closeContextMenu();
            }
        },
        placement: "bottom-start",
        middleware: [offset({ mainAxis: 4 }), flip(), shift({ padding: 8 })],
        whileElementsMounted: autoUpdate,
    });
    useEffect(() => {
        refs.setPositionReference({
            getBoundingClientRect: () => ({ width: 0, height: 0, x, y, top: y, left: x, right: x, bottom: y }),
        });
    }, [x, y, refs]);
    const dismiss = useDismiss(context);
    const { getFloatingProps } = useInteractions([dismiss]);
    return (
        <FloatingPortal>
            <div ref={refs.setFloating} style={floatingStyles} className={PANEL} {...getFloatingProps()}>
                {visibleItems(items).map((it, i) => (
                    <Row key={i} item={it} />
                ))}
            </div>
        </FloatingPortal>
    );
}
```

- [ ] **Step 2: Create the host**

Create `frontend/app/element/contextmenuhost.tsx`:

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Renders the themed context menu from contextMenuAtom. Mounted once in CockpitBody, beside
// ModalsRenderer. Inert until ContextMenuModel.showContextMenu sets the atom (Task 3).

import { ContextMenu } from "@/app/element/contextmenu";
import { contextMenuAtom } from "@/app/store/contextmenu";
import { useAtomValue } from "jotai";

export function ContextMenuHost() {
    const state = useAtomValue(contextMenuAtom);
    if (state == null) {
        return null;
    }
    return <ContextMenu state={state} />;
}
```

- [ ] **Step 3: Mount the host in cockpit-root**

Edit `frontend/app/cockpit/cockpit-root.tsx`. Add the import near the other `@/app` imports (after line 3's `ModalsRenderer` import):

```tsx
import { ContextMenuHost } from "@/app/element/contextmenuhost";
```

Then add the host beside `<ModalsRenderer />` (currently line 76):

```tsx
            <ModalsRenderer />
            <ContextMenuHost />
```

- [ ] **Step 4: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0, no new errors (baseline is clean per CLAUDE.md).

- [ ] **Step 5: Commit**

```bash
git add frontend/app/element/contextmenu.tsx frontend/app/element/contextmenuhost.tsx frontend/app/cockpit/cockpit-root.tsx
git commit -m "feat(contextmenu): themed floating menu component + host (inert)"
```

---

### Task 3: Repoint `ContextMenuModel` to the atom (themed menus go live)

Switches every existing caller (agentheader, term, preview ×2, processviewer, waveenvimpl) to the themed menu.

**Files:**
- Modify: `frontend/app/store/contextmenu.ts`
- Test: `frontend/app/store/contextmenu.test.ts`

- [ ] **Step 1: Write the failing test**

Add this test to `frontend/app/store/contextmenu.test.ts` inside a new `describe`, and add `ContextMenuModel` to the import from `./contextmenu`:

```ts
import { closeContextMenu, ContextMenuModel, contextMenuAtom, roleAction, visibleItems } from "./contextmenu";

describe("ContextMenuModel.showContextMenu", () => {
    it("sets the atom with items and cursor coordinates", () => {
        const items: ContextMenuItem[] = [{ label: "Copy", click: () => {} }];
        const ev = { clientX: 10, clientY: 20, preventDefault() {}, stopPropagation() {} } as any;
        ContextMenuModel.getInstance().showContextMenu(items, ev);
        expect(globalStore.get(contextMenuAtom)).toEqual({ items, x: 10, y: 20 });
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run frontend/app/store/contextmenu.test.ts`
Expected: FAIL — the atom is still `null` because `showContextMenu` calls `buildTauriMenu` instead of setting the atom.

- [ ] **Step 3: Repoint the model**

Edit `frontend/app/store/contextmenu.ts`. Remove the now-unused imports and rewrite the class body. Delete these two lines from the top:

```ts
import { fireAndForget } from "@/util/util";
import { buildTauriMenu } from "../../tauri/menu";
```

Replace the `showContextMenu` method body:

```ts
    showContextMenu(menu: ContextMenuItem[], ev: React.MouseEvent<any>, _opts?: ShowContextMenuOpts): void {
        ev?.preventDefault?.();
        ev?.stopPropagation?.();
        globalStore.set(contextMenuAtom, { items: menu, x: ev.clientX, y: ev.clientY });
    }
```

(`ShowContextMenuOpts` and the singleton scaffolding stay; `_opts` remains unused for signature compatibility — no caller passes it.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run frontend/app/store/contextmenu.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: CDP visual check — themed menu appears**

Start the dev app (`task dev` if not running) and, over CDP on `:9222`, right-click the agent header (the identity bar above a focused agent's terminal — `agentheader.tsx` already calls `showContextMenu`). Confirm a dark themed panel appears at the cursor with "Interrupt turn / Fullscreen terminal / Show details / — / Close agent", matching cockpit tokens (not the gray Windows menu).

Run: `node scripts/cdp-shot.mjs contextmenu-header.png`
Expected: PNG shows the themed panel. If the cockpit is empty, inject data first with `node scripts/inject-live-agents.mjs <scenario>`.

- [ ] **Step 6: Commit**

```bash
git add frontend/app/store/contextmenu.ts frontend/app/store/contextmenu.test.ts
git commit -m "feat(contextmenu): render themed menu everywhere via repointed model"
```

---

### Task 4: Delete the dead native-menu path

**Files:**
- Delete: `frontend/tauri/menu.ts`
- Delete: `frontend/tauri/menu.test.ts`
- Modify: `frontend/tauri/api.ts` (stale comment on line 88)

- [ ] **Step 1: Confirm nothing imports the native menu**

Run: `git grep -n "tauri/menu\|buildTauriMenu" -- 'frontend/*.ts' 'frontend/*.tsx' 'frontend/**/*.ts' 'frontend/**/*.tsx'`
Expected: matches only in `frontend/tauri/menu.ts`, `frontend/tauri/menu.test.ts`, and the comment in `frontend/tauri/api.ts`. No live import in `contextmenu.ts` (removed in Task 3).

- [ ] **Step 2: Delete the files**

```bash
git rm frontend/tauri/menu.ts frontend/tauri/menu.test.ts
```

- [ ] **Step 3: Fix the stale comment in api.ts**

Edit `frontend/tauri/api.ts` line 88. Replace:

```ts
// onContextMenuClick are CUT (the Tauri primitive is menu.ts buildTauriMenu); updateWindowControls
```

with:

```ts
// onContextMenuClick are CUT (context menus are themed React now — app/store/contextmenu.ts); updateWindowControls
```

- [ ] **Step 4: Typecheck + full test run**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

Run: `npx vitest run`
Expected: PASS — the deleted `menu.test.ts` is gone, no suite references it.

- [ ] **Step 5: Commit**

```bash
git add frontend/tauri/api.ts
git commit -m "chore(contextmenu): remove dead native Tauri menu path"
```

---

### Task 5: Cockpit card right-click menu

Adds a context menu to `AgentRow` (the cockpit card). All actions reuse wired handlers; full-width needs one new prop that reuses the existing `setCardPrefs` state.

**Files:**
- Modify: `frontend/app/view/agents/agentrow.tsx`
- Modify: `frontend/app/view/agents/cockpitsurface.tsx`

No unit test (view). Verified via CDP in Step 5.

- [ ] **Step 1: Add imports to agentrow.tsx**

Edit `frontend/app/view/agents/agentrow.tsx`. Add to the imports:

```tsx
import { ContextMenuModel } from "@/app/store/contextmenu";
import { confirmCloseAgent } from "./agentactions";
```

- [ ] **Step 2: Add the `onToggleFullWidth` prop**

In the `AgentRow` destructured params (currently ends around line 137, after `onResizeEnd`), add:

```tsx
    onToggleFullWidth,
```

In the props type (the `}: { ... }` block, after `onResizeEnd?: (full: boolean) => void;` around line 167), add:

```tsx
    onToggleFullWidth?: () => void; // flips this card's full-width pref (menu action)
```

- [ ] **Step 3: Build the menu handler**

Inside the `AgentRow` function body, after `const muteAction = idle ? onDismiss : onBackground;` (line 216), add:

```tsx
    const onContextMenu = (e: React.MouseEvent) => {
        const items: ContextMenuItem[] = [
            { label: "Open", click: onOpen },
            { label: "Open terminal", click: onOpenTerminal },
        ];
        if (diff) {
            items.push({ label: "Review changes", click: onOpenDiff });
        }
        if (onToggleFullWidth) {
            items.push({ label: fullWidth ? "Exit full width" : "Full width", click: onToggleFullWidth });
        }
        if (muteAction) {
            items.push({ label: idle ? "Dismiss" : "Mute & background", click: muteAction });
        }
        items.push({ type: "separator" });
        items.push({ label: "Close agent", click: () => confirmCloseAgent(agent.id, agent.name) });
        ContextMenuModel.getInstance().showContextMenu(items, e);
    };
```

- [ ] **Step 4: Attach the handler to the card root**

On the root `<motion.div>` (currently has `onClick={onCursor}` around line 282), add the handler right after it:

```tsx
            onClick={onCursor}
            onContextMenu={onContextMenu}
```

- [ ] **Step 5: Wire `onToggleFullWidth` in cockpitsurface**

Edit `frontend/app/view/agents/cockpitsurface.tsx`. In `renderCard`, add a prop to the `<AgentRow>` element (after `onResizeEnd={...}` around line 749):

```tsx
                onToggleFullWidth={() =>
                    setCardPrefs((p) => ({ ...p, [a.id]: { ...p[a.id], fullWidth: !p[a.id]?.fullWidth } }))
                }
```

- [ ] **Step 6: Typecheck + CDP check**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

CDP: right-click a card in the cockpit grid. Confirm the themed menu shows "Open / Open terminal / [Review changes] / Full width / [Mute & background|Dismiss] / — / Close agent", and that "Full width" toggles the card's span.

Run: `node scripts/cdp-shot.mjs contextmenu-card.png`
Expected: PNG shows the themed card menu.

- [ ] **Step 7: Commit**

```bash
git add frontend/app/view/agents/agentrow.tsx frontend/app/view/agents/cockpitsurface.tsx
git commit -m "feat(contextmenu): right-click menu on cockpit cards"
```

---

### Task 6: Transcript "Copy text" menu

Adds right-click "Copy text" to the prose rows (message + user) in `NarrationTimeline`. Scoped to copy only: the component is presentational and has no agent id / model, so "Open terminal" would need plumbing through every caller (deferred), and burst expand/collapse is already available by clicking the summary row.

**Files:**
- Modify: `frontend/app/view/agents/narrationtimeline.tsx`

- [ ] **Step 1: Add the import**

Edit `frontend/app/view/agents/narrationtimeline.tsx`. Add:

```tsx
import { ContextMenuModel } from "@/app/store/contextmenu";
```

- [ ] **Step 2: Add a copy-menu helper**

Inside the `NarrationTimeline` function body, after `const items = groupTimeline(entries);` (line 63), add:

```tsx
    const copyMenu = (text: string) => (e: React.MouseEvent) =>
        ContextMenuModel.getInstance().showContextMenu(
            [{ label: "Copy text", click: () => void navigator.clipboard.writeText(text) }],
            e
        );
```

- [ ] **Step 3: Attach to the message row**

On the message `<motion.div>` (the `item.kind === "message"` branch, around line 83-89), add after `className="mt-2 flex gap-2.5"`:

```tsx
                            onContextMenu={copyMenu(item.text)}
```

- [ ] **Step 4: Attach to the user row**

On the user `<motion.div>` (the `item.kind === "user"` branch, around line 106-112), add after `className="mt-2 flex justify-end pl-[30px]"`:

```tsx
                            onContextMenu={copyMenu(item.text)}
```

- [ ] **Step 5: Typecheck + CDP check**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

CDP: right-click a message or your own bubble in a card's narration feed. Confirm the themed "Copy text" menu appears and copying works.

Run: `node scripts/cdp-shot.mjs contextmenu-transcript.png`
Expected: PNG shows the themed "Copy text" menu.

- [ ] **Step 6: Commit**

```bash
git add frontend/app/view/agents/narrationtimeline.tsx
git commit -m "feat(contextmenu): copy-text menu on transcript prose rows"
```

---

## Notes / deferred (per spec "out of scope" + grounding during planning)

- **Keyboard navigation** (arrow/Enter/type-ahead): deferred. The mouse-first component leaves room to add it; not built here.
- **Transcript "Open terminal" and burst expand/collapse** in the right-click menu: deferred. `NarrationTimeline` has no agent id/model (would need plumbing through every caller), and expand/collapse already works by clicking the summary row. v1 transcript menu is Copy-text only.
- **Submenu vertical overflow**: a very tall submenu can clip at the viewport bottom (the CSS-absolute submenu has horizontal edge-flip but no vertical flip). Acceptable for v1; the only deep-submenu caller is the terminal menu. Revisit with full floating-ui nested menus if it bites.
- **`role` fallback**: `roleAction` covers copy/cut/paste/selectall via `execCommand` as a parity net; no production caller uses `role` (only the deleted test did). `paste` is unreliable outside a focused editable.
- **Keyboard "seam"**: the spec mentioned an internal `activeIndex` to leave room for keyboard nav. Shipping an unused state var would be dead code (YAGNI), so it is omitted — the `Row`/list structure is already amenable to adding selection state when keyboard nav is built.
- **Viewport-edge flip test**: the spec listed edge-flip under vitest, but flip is `@floating-ui` internal behavior with no unit harness in this repo. It is verified via the CDP checks in Tasks 3/5/6 instead of a mocked-rect unit test.
