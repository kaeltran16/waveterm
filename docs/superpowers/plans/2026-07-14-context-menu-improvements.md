# Context-menu improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the app's nine right-click menus keyboard-operable, consistently Sentence-cased, and clearly destructive-aware, without adding any new menu actions.

**Architecture:** All menus render through one themed component (`ContextMenuModel` → `frontend/app/element/contextmenu.tsx`). We add a pure keyboard-navigation reducer to the store module (unit-tested), rewrite the renderer to consume it (roving highlight + submenu open state + danger styling + radio dots), then sweep the call sites for labels, danger flags, and confirms.

**Tech Stack:** React 19, jotai, Tailwind 4 (`@theme` tokens), floating-ui, vitest.

## Global Constraints

- **Commits:** Per repo owner's workflow, do **NOT** commit per-task. Stage only. A single feature commit lands at the very end, **only after explicit approval**; the spec (`docs/superpowers/specs/2026-07-14-context-menu-improvements-design.md`) and this plan fold into that same commit — never a separate docs commit.
- **Typecheck command:** `npx tsc` stack-overflows on this repo. Use `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`. Baseline is clean (exit 0); any error it reports is yours.
- **Unit tests:** `npx vitest run <path>`. There is **no cockpit render harness**, so `.tsx` view/renderer changes are verified via typecheck + CDP screenshot against the live dev app (`node scripts/cdp-shot.mjs`), not unit tests. Only the pure reducer (Task 1) is unit-testable.
- **No new colors:** danger styling uses the existing `text-error` / `bg-error/10` tokens. No raw hex/rgba.
- **Label voice:** Sentence case everywhere. Proper nouns (theme display names, "URL") keep their capitalization.
- **Scope:** no new menu actions; no keyboard-shortcut hints in `sublabel`; no icons; no `header`-type usage.

## File structure

- `frontend/types/custom.d.ts` — add `danger?: boolean` to `ContextMenuItem`.
- `frontend/app/store/contextmenu.ts` — add the pure navigation reducer (`MenuPath` + helpers). This module already holds the menu's non-React logic and has a test file; the reducer belongs here so it is testable without a DOM.
- `frontend/app/store/contextmenu.test.ts` — reducer tests.
- `frontend/app/element/contextmenu.tsx` — renderer rewrite: consume the reducer, roving highlight, keyboard handling, danger styling, radio-dot marker.
- Call sites (labels / danger / confirm / radio):
  - `frontend/app/view/agents/memorysurface.tsx`, `frontend/app/view/agents/channelrail.tsx` (danger + confirm + radio)
  - `frontend/app/view/agents/memstore.ts` (confirm helper for note delete)
  - `frontend/app/view/term/term-model.ts` (Sentence-case sweep + radio types)

---

### Task 1: Navigation reducer + `danger` type field

**Files:**
- Modify: `frontend/types/custom.d.ts:153-163` (add `danger?: boolean`)
- Modify: `frontend/app/store/contextmenu.ts` (append reducer helpers)
- Test: `frontend/app/store/contextmenu.test.ts`

**Interfaces:**
- Consumes: `visibleItems(items)` (already exported from `contextmenu.ts`).
- Produces (all exported from `contextmenu.ts`, consumed by Task 2):
  - `type MenuPath = number[]` — indices into the **visible** items at each depth; the last index is the highlighted item; ancestor indices are the open submenu trail.
  - `isActionable(item: ContextMenuItem | undefined): boolean`
  - `siblingsAt(root: ContextMenuItem[], path: MenuPath): ContextMenuItem[]` — visible items at the level of the highlighted index.
  - `focusedItem(root: ContextMenuItem[], path: MenuPath): ContextMenuItem | undefined`
  - `firstActionable(items: ContextMenuItem[]): number` — index into visible items, or `-1`.
  - `initialPath(root: ContextMenuItem[]): MenuPath` — `[firstActionable]` or `[]`.
  - `moveHighlight(root: ContextMenuItem[], path: MenuPath, delta: 1 | -1): MenuPath`
  - `openSubmenu(root: ContextMenuItem[], path: MenuPath): MenuPath | null`
  - `closeSubmenu(path: MenuPath): MenuPath | null` — `null` means "close the whole menu".

- [ ] **Step 1: Add the `danger` field to the type**

In `frontend/types/custom.d.ts`, inside the `ContextMenuItem` type (currently lines 153-163), add one line after `sublabel?: string;`:

```ts
    type ContextMenuItem = {
        label?: string;
        type?: "separator" | "normal" | "submenu" | "checkbox" | "radio" | "header";
        role?: string; // electron role (optional)
        click?: () => void; // not required if role is set
        submenu?: ContextMenuItem[];
        checked?: boolean;
        visible?: boolean;
        enabled?: boolean;
        sublabel?: string;
        danger?: boolean; // destructive action — renderer styles it red
    };
```

- [ ] **Step 2: Write the failing reducer tests**

Append to `frontend/app/store/contextmenu.test.ts`:

```ts
import {
    closeSubmenu,
    firstActionable,
    focusedItem,
    initialPath,
    isActionable,
    moveHighlight,
    openSubmenu,
    siblingsAt,
} from "./contextmenu";

describe("context-menu keyboard reducer", () => {
    const menu: ContextMenuItem[] = [
        { label: "Open", click: () => {} }, // 0
        { type: "separator" }, // 1
        { label: "Disabled", enabled: false }, // 2
        {
            label: "More",
            submenu: [
                { label: "Sub A", click: () => {} }, // 0
                { label: "Sub B", click: () => {} }, // 1
            ],
        }, // 3
        { label: "Delete", danger: true, click: () => {} }, // 4
    ];

    it("isActionable skips separators, headers, and disabled", () => {
        expect(isActionable(menu[0])).toBe(true);
        expect(isActionable(menu[1])).toBe(false);
        expect(isActionable(menu[2])).toBe(false);
        expect(isActionable(undefined)).toBe(false);
    });

    it("initialPath points at the first actionable item", () => {
        expect(initialPath(menu)).toEqual([0]);
        expect(initialPath([{ type: "separator" }])).toEqual([]);
    });

    it("moveHighlight down skips non-actionable and wraps", () => {
        expect(moveHighlight(menu, [0], 1)).toEqual([3]); // skips separator(1) + disabled(2)
        expect(moveHighlight(menu, [3], 1)).toEqual([4]);
        expect(moveHighlight(menu, [4], 1)).toEqual([0]); // wrap to top
    });

    it("moveHighlight up wraps to the last actionable", () => {
        expect(moveHighlight(menu, [0], -1)).toEqual([4]);
        expect(moveHighlight(menu, [3], -1)).toEqual([0]);
    });

    it("openSubmenu descends into the first actionable child", () => {
        expect(openSubmenu(menu, [3])).toEqual([3, 0]);
        expect(openSubmenu(menu, [0])).toBeNull(); // leaf has no submenu
    });

    it("focusedItem resolves the highlighted item at any depth", () => {
        expect(focusedItem(menu, [0])?.label).toBe("Open");
        expect(focusedItem(menu, [3, 1])?.label).toBe("Sub B");
    });

    it("moveHighlight operates within the open submenu level", () => {
        expect(moveHighlight(menu, [3, 0], 1)).toEqual([3, 1]);
        expect(moveHighlight(menu, [3, 1], 1)).toEqual([3, 0]); // wrap within submenu
    });

    it("closeSubmenu pops one level, or signals close at root", () => {
        expect(closeSubmenu([3, 0])).toEqual([3]);
        expect(closeSubmenu([0])).toBeNull();
    });

    it("siblingsAt / firstActionable resolve the right level", () => {
        expect(siblingsAt(menu, [3, 1]).length).toBe(2);
        expect(firstActionable(menu)).toBe(0);
        expect(firstActionable([{ type: "separator" }, { label: "X" }])).toBe(1);
    });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run frontend/app/store/contextmenu.test.ts`
Expected: FAIL — `moveHighlight`, `openSubmenu`, etc. are not exported (import errors / undefined).

- [ ] **Step 4: Implement the reducer**

Append to `frontend/app/store/contextmenu.ts` (after the existing `visibleItems`/`roleAction` exports, before the `ContextMenuModel` class is fine — keep it near `visibleItems`):

```ts
// --- keyboard navigation --------------------------------------------------
// MenuPath indexes into the VISIBLE items at each depth (the renderer maps
// visibleItems, so indices align). The last index is the highlighted item;
// any earlier indices form the open-submenu trail.
export type MenuPath = number[];

export function isActionable(item: ContextMenuItem | undefined): boolean {
    return item != null && item.type !== "separator" && item.type !== "header" && item.enabled !== false;
}

// Visible items at the level of the highlighted (last) index. Defensive: if the
// path walks through a non-submenu, returns the deepest resolvable level.
export function siblingsAt(root: ContextMenuItem[], path: MenuPath): ContextMenuItem[] {
    let items = visibleItems(root);
    for (let d = 0; d < path.length - 1; d++) {
        const sub = items[path[d]]?.submenu;
        if (sub == null) {
            return items;
        }
        items = visibleItems(sub);
    }
    return items;
}

export function focusedItem(root: ContextMenuItem[], path: MenuPath): ContextMenuItem | undefined {
    if (path.length === 0) {
        return undefined;
    }
    return siblingsAt(root, path)[path[path.length - 1]];
}

export function firstActionable(items: ContextMenuItem[]): number {
    const vis = visibleItems(items);
    for (let i = 0; i < vis.length; i++) {
        if (isActionable(vis[i])) {
            return i;
        }
    }
    return -1;
}

export function initialPath(root: ContextMenuItem[]): MenuPath {
    const first = firstActionable(root);
    return first < 0 ? [] : [first];
}

export function moveHighlight(root: ContextMenuItem[], path: MenuPath, delta: 1 | -1): MenuPath {
    const items = siblingsAt(root, path);
    const n = items.length;
    if (n === 0) {
        return path;
    }
    let idx = path.length ? path[path.length - 1] : delta === 1 ? -1 : 0;
    for (let step = 0; step < n; step++) {
        idx = (idx + delta + n) % n;
        if (isActionable(items[idx])) {
            break;
        }
    }
    return [...path.slice(0, -1), idx];
}

export function openSubmenu(root: ContextMenuItem[], path: MenuPath): MenuPath | null {
    const item = focusedItem(root, path);
    if (item?.submenu == null) {
        return null;
    }
    const first = firstActionable(item.submenu);
    return first < 0 ? null : [...path, first];
}

export function closeSubmenu(path: MenuPath): MenuPath | null {
    return path.length <= 1 ? null : path.slice(0, -1);
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run frontend/app/store/contextmenu.test.ts`
Expected: PASS (all reducer tests green; existing helper tests still green).

- [ ] **Step 6: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

---

### Task 2: Renderer rewrite — keyboard nav, danger styling, radio dot

**Files:**
- Modify (full rewrite of the component body): `frontend/app/element/contextmenu.tsx`

**Interfaces:**
- Consumes from Task 1: `MenuPath`, `initialPath`, `moveHighlight`, `openSubmenu`, `closeSubmenu`, `focusedItem` (all from `@/app/store/contextmenu`), plus existing `closeContextMenu`, `roleAction`, `visibleItems`, `ContextMenuState`.
- Produces: no new exports (still `export function ContextMenu`).

**Verification:** no unit test (no render harness). Verified by typecheck + CDP.

- [ ] **Step 1: Rewrite `contextmenu.tsx`**

Replace the entire file with:

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import {
    closeContextMenu,
    closeSubmenu,
    focusedItem,
    initialPath,
    type MenuPath,
    moveHighlight,
    openSubmenu,
    roleAction,
    visibleItems,
    type ContextMenuState,
} from "@/app/store/contextmenu";
import { cn } from "@/util/util";
import { autoUpdate, flip, FloatingPortal, offset, shift, useDismiss, useFloating, useInteractions } from "@floating-ui/react";
import { useEffect, useRef, useState } from "react";

const PANEL = "z-[1000] min-w-[180px] rounded-[8px] border border-edge-mid bg-surface-raised py-1 shadow-lg";
const ITEM =
    "relative flex cursor-pointer items-center gap-2 px-3 py-1 font-mono text-[12.5px] text-secondary";
const ITEM_ACTIVE = "bg-accent/10 text-primary";
const ITEM_DANGER = "text-error";
const ITEM_DANGER_ACTIVE = "bg-error/10 text-error";
const ITEM_DISABLED = "cursor-default opacity-50";

function runClick(item: ContextMenuItem) {
    if (item.enabled === false) {
        return;
    }
    const act = item.click ?? roleAction(item.role);
    act?.();
    closeContextMenu();
}

function pathStartsWith(path: MenuPath, prefix: MenuPath): boolean {
    return prefix.every((v, i) => path[i] === v);
}

function Marker({ item }: { item: ContextMenuItem }) {
    if (item.type === "checkbox") {
        return <span className="w-3 text-accent">{item.checked ? "x" : ""}</span>;
    }
    if (item.type === "radio") {
        return <span className="w-3 text-accent">{item.checked ? "•" : ""}</span>;
    }
    return null;
}

// One menu level. `basePath` is the path prefix that reaches this level's parent
// (empty at root). `active` is the whole highlight path. A row is highlighted when
// active[level] === its index; its submenu is open when the active path goes deeper.
function MenuLevel({
    items,
    basePath,
    active,
    setActive,
}: {
    items: ContextMenuItem[];
    basePath: MenuPath;
    active: MenuPath;
    setActive: (p: MenuPath) => void;
}) {
    const level = basePath.length;
    const vis = visibleItems(items);
    return (
        <>
            {vis.map((item, i) => {
                if (item.type === "separator") {
                    return <div key={i} className="my-1 h-px bg-edge-mid" />;
                }
                if (item.type === "header") {
                    return (
                        <div
                            key={i}
                            className="px-3 py-1 font-mono text-[10px] font-bold uppercase tracking-[0.06em] text-muted"
                        >
                            {item.label}
                        </div>
                    );
                }
                const rowPath = [...basePath, i];
                const onPath = active[level] === i;
                const submenuOpen = onPath && item.submenu != null && active.length > level + 1;
                const disabled = item.enabled === false;
                const danger = item.danger === true;
                return (
                    <MenuRow
                        key={i}
                        item={item}
                        rowPath={rowPath}
                        highlighted={onPath}
                        submenuOpen={submenuOpen}
                        disabled={disabled}
                        danger={danger}
                        active={active}
                        setActive={setActive}
                    />
                );
            })}
        </>
    );
}

function MenuRow({
    item,
    rowPath,
    highlighted,
    submenuOpen,
    disabled,
    danger,
    active,
    setActive,
}: {
    item: ContextMenuItem;
    rowPath: MenuPath;
    highlighted: boolean;
    submenuOpen: boolean;
    disabled: boolean;
    danger: boolean;
    active: MenuPath;
    setActive: (p: MenuPath) => void;
}) {
    const ref = useRef<HTMLDivElement>(null);
    const [flipLeft, setFlipLeft] = useState(false);
    const hasSub = item.submenu != null;

    const onEnter = () => {
        if (disabled) {
            return;
        }
        if (hasSub) {
            const r = ref.current?.getBoundingClientRect();
            if (r) {
                setFlipLeft(r.right + 200 > window.innerWidth);
            }
            // hovering a submenu row opens it (parity with prior behavior)
            const first = item.submenu!.findIndex((s) => s.type !== "separator" && s.type !== "header" && s.enabled !== false);
            setActive(first < 0 ? rowPath : [...rowPath, first]);
        } else {
            setActive(rowPath);
        }
    };

    const activeCls = danger ? ITEM_DANGER_ACTIVE : ITEM_ACTIVE;
    return (
        <div
            ref={ref}
            className={cn(ITEM, danger && !highlighted && ITEM_DANGER, highlighted && activeCls, disabled && ITEM_DISABLED)}
            onMouseEnter={onEnter}
            onClick={() => (hasSub ? undefined : runClick(item))}
        >
            <Marker item={item} />
            <span className="flex-1 whitespace-nowrap">{item.label}</span>
            {hasSub ? <span className="ml-4 text-muted">&gt;</span> : null}
            {item.sublabel ? <span className="ml-4 text-muted">{item.sublabel}</span> : null}
            {submenuOpen ? (
                <div className={cn(PANEL, "absolute top-[-5px]", flipLeft ? "right-full mr-1" : "left-full ml-1")}>
                    <MenuLevel items={item.submenu!} basePath={rowPath} active={active} setActive={setActive} />
                </div>
            ) : null}
        </div>
    );
}

export function ContextMenu({ state }: { state: ContextMenuState }) {
    const { items, x, y } = state;
    const [active, setActive] = useState<MenuPath>(() => initialPath(items));
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

    // grab focus so the menu receives keydown immediately
    const panelRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        panelRef.current?.focus();
    }, []);

    const descendOrActivate = () => {
        const item = focusedItem(items, active);
        if (item == null) {
            return;
        }
        if (item.submenu != null) {
            const opened = openSubmenu(items, active);
            if (opened) {
                setActive(opened);
            }
        } else {
            runClick(item);
        }
    };

    const onKeyDown = (e: React.KeyboardEvent) => {
        switch (e.key) {
            case "ArrowDown":
                e.preventDefault();
                setActive(moveHighlight(items, active, 1));
                break;
            case "ArrowUp":
                e.preventDefault();
                setActive(moveHighlight(items, active, -1));
                break;
            case "ArrowRight":
            case "Enter":
                e.preventDefault();
                descendOrActivate();
                break;
            case "ArrowLeft": {
                e.preventDefault();
                const closed = closeSubmenu(active);
                if (closed) {
                    setActive(closed);
                } else {
                    closeContextMenu();
                }
                break;
            }
            case "Escape":
                e.preventDefault();
                closeContextMenu();
                break;
        }
    };

    return (
        <FloatingPortal>
            <div
                ref={(node) => {
                    refs.setFloating(node);
                    panelRef.current = node;
                }}
                tabIndex={-1}
                style={floatingStyles}
                className={cn(PANEL, "outline-none")}
                onKeyDown={onKeyDown}
                {...getFloatingProps()}
            >
                <MenuLevel items={items} basePath={[]} active={active} setActive={setActive} />
            </div>
        </FloatingPortal>
    );
}
```

- [ ] **Step 2: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 3: Verify existing unit tests still pass**

Run: `npx vitest run frontend/app/store/contextmenu.test.ts frontend/app/element`
Expected: PASS (no renderer unit tests, but store tests must stay green).

- [ ] **Step 4: CDP visual verification**

With the dev app running (`task dev`), open a menu and confirm: arrow keys move a highlight, Enter activates, Right opens a submenu, Left/Esc close, mouse hover still works.
Run: `node scripts/cdp-shot.mjs scratch/ctxmenu-keyboard.png` after right-clicking an agent card.
Expected: screenshot shows a highlighted row; keyboard interaction observed in the live app.

---

### Task 3: Destructive treatment — danger flags + confirms

**Files:**
- Modify: `frontend/app/view/agents/memstore.ts` (add `confirmDeleteNote` helper)
- Modify: `frontend/app/view/agents/memorysurface.tsx:160-172` (menu Delete → confirm + danger) and `:317` (detail-pane Delete button → confirm)
- Modify: `frontend/app/view/agents/channelrail.tsx:136` (Delete channel → confirm + danger)
- The three `Close agent` items already route through `confirmCloseAgent`; only add `danger: true` to them.

**Interfaces:**
- Consumes from Task 1: the `danger` field.
- Consumes existing: `modalsModel.pushModal("ConfirmModal", { title, message, confirmLabel?, destructive?, onConfirm })` (see `agentactions.ts:17`), `deleteNote(path)` (`memstore.ts:134`), the `onDeleteChannel(id)` prop (`channelrail.tsx`).
- Produces: `confirmDeleteNote(path: string, title: string): void` exported from `memstore.ts`.

**Verification:** typecheck + CDP (confirm modal appears on delete).

- [ ] **Step 1: Add the note-delete confirm helper**

In `frontend/app/view/agents/memstore.ts`, add near `deleteNote` (which is at line 134). First ensure `modalsModel` is imported (add if missing):

```ts
import { modalsModel } from "@/app/store/modalmodel";
```

Then add the helper:

```ts
// Confirm before deleting a note — shared by the memory list context menu and the
// detail-pane Delete button, matching the confirmCloseAgent pattern.
export function confirmDeleteNote(path: string, title: string): void {
    modalsModel.pushModal("ConfirmModal", {
        title: "Delete note",
        message: `Delete "${title}"? This removes the file and can't be undone.`,
        confirmLabel: "Delete",
        destructive: true,
        onConfirm: () => fireAndForget(() => deleteNote(path)),
    });
}
```

Confirm `fireAndForget` is already imported in `memstore.ts` (it is used by `deleteNote`); if not, add `import { fireAndForget } from "@/util/util";`.

- [ ] **Step 2: Wire the memory menu + detail button to the helper**

In `frontend/app/view/agents/memorysurface.tsx`, update the import from `./memstore` to include `confirmDeleteNote` (it already imports `deleteNote`).

Change the menu Delete item (currently line 172):

```tsx
                                                    { label: "Delete", danger: true, click: () => confirmDeleteNote(n.path, n.title) },
```

Change the detail-pane Delete button (currently line 317):

```tsx
                            onClick={() => confirmDeleteNote(sel.path, sel.title)}
```

(`sel = notes.find((n) => n.id === selectedId)` at `memorysurface.tsx:412`, same shape as the list rows — `sel.title` is already used at line 259, so both fields are valid.)

- [ ] **Step 3: Wire the channel delete to a confirm + danger**

In `frontend/app/view/agents/channelrail.tsx`, first ensure `modalsModel` is imported:

```ts
import { modalsModel } from "@/app/store/modalmodel";
```

Replace the Delete channel menu item (currently line 136):

```tsx
                                        {
                                            label: "Delete channel",
                                            danger: true,
                                            click: () =>
                                                modalsModel.pushModal("ConfirmModal", {
                                                    title: "Delete channel",
                                                    message: `Delete #${c.name}? This can't be undone.`,
                                                    confirmLabel: "Delete channel",
                                                    destructive: true,
                                                    onConfirm: () => onDeleteChannel(c.oid),
                                                }),
                                        },
```

- [ ] **Step 4: Mark the three `Close agent` items as danger**

Add `danger: true` to the `Close agent` item in each of:
- `frontend/app/view/agents/agentrow.tsx:289` → `items.push({ label: "Close agent", danger: true, click: () => confirmCloseAgent(agent.id, agent.name) });`
- `frontend/app/view/agents/agentheader.tsx:80` → `items.push({ label: "Close agent", danger: true, click: closeTerminal });`
- `frontend/app/view/agents/agenttree.tsx:60` → `{ label: "Close agent", danger: true, click: () => confirmCloseAgent(agent.id, agent.name) },`

- [ ] **Step 5: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 6: CDP verification**

In the dev app: right-click a channel → Delete channel shows red, and clicking it opens a ConfirmModal. Right-click a memory note → Delete shows red + confirms. Right-click an agent card → Close agent shows red.
Run: `node scripts/cdp-shot.mjs scratch/ctxmenu-danger.png`
Expected: destructive items render in `text-error`; confirm modal appears.

---

### Task 4: Cohesion sweep — Sentence-case the terminal menu

**Files:**
- Modify: `frontend/app/view/term/term-model.ts` (labels in `getContextMenuItems` and `getSettingsMenuItems`)

The eight cockpit menus are already Sentence case; only the terminal menu uses Title Case. Change casing only — leave existing punctuation (`...`) and dynamic segments untouched. Proper nouns (theme display names) are unaffected because they come from config.

**Verification:** typecheck + CDP (terminal menu labels).

- [ ] **Step 1: Rewrite the Title-Case labels**

Apply these exact label replacements in `frontend/app/view/term/term-model.ts` (left = current, right = new):

- `"Open URL in External Browser"` → `"Open URL in external browser"`
- `"Magnify Block"` → `"Magnify block"`
- `"Un-Magnify Block"` → `"Un-magnify block"`
- `"Save Session As..."` → `"Save session as..."`
- `"Font Size"` → `"Font size"`
- `"Block (Blinking)"` → `"Block (blinking)"`
- `"Bar (Blinking)"` → `"Bar (blinking)"`
- `"Underline (Blinking)"` → `"Underline (blinking)"`
- `"Transparent Background"` → `"Transparent background"`
- `"No Transparency"` → `"No transparency"`
- `"Allow Bracketed Paste Mode"` → `"Allow bracketed paste mode"`
- `"Force Restart Controller"` → `"Force restart controller"`
- `"Clear Output On Restart"` → `"Clear output on restart"`
- `"Run On Startup"` → `"Run on startup"`
- `"Debug Connection"` → `"Debug connection"`
- `"Session Durability"` → `"Session durability"`
- `"Restart Session in Standard Mode"` → `"Restart session in standard mode"`
- `"Restart Session in Durable Mode"` → `"Restart session in durable mode"`

Leave as-is (already Sentence-case or single words / proper labels): `"Copy"`, `"Paste"`, `"Themes"`, `"Default"`, `"Cursor"`, `"Block"`, `"Bar"`, `"Underline"`, `"Transparency"`, `"Advanced"`, `"On"`, `"Off"`, `"Info"`, `"Verbose"`, and all `"Default (...)"` dynamic labels.

- [ ] **Step 2: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 3: CDP verification**

Right-click inside a terminal in the dev app.
Run: `node scripts/cdp-shot.mjs scratch/ctxmenu-terminal-labels.png`
Expected: all labels read in Sentence case.

---

### Task 5: Radio semantics for mutually-exclusive groups

**Files:**
- Modify: `frontend/app/view/term/term-model.ts` — Themes, Font size, Cursor, Transparency submenu items: `type: "checkbox"` → `type: "radio"`.
- Modify: `frontend/app/view/agents/channelrail.tsx` — Autonomy submenu items: `type: "checkbox"` → `type: "radio"`. **(consistency extension beyond spec §5's named four — same mutually-exclusive pattern; cut this step if the reviewer wants to keep §5 literal.)**
- Optional: `frontend/app/view/term/term-model.ts` — Advanced groups (Allow bracketed paste mode, Clear output on restart, Run on startup, Debug connection): `type: "checkbox"` → `type: "radio"`. **(consistency extension; cut if undesired.)**

The renderer already renders a `•` dot for `type: "radio"` (Task 2). This task only flips the `type` on the item builders.

**Verification:** typecheck + CDP (radio dots).

- [ ] **Step 1: Flip the four named terminal groups to radio**

In `frontend/app/view/term/term-model.ts`, in `getSettingsMenuItems`, change `type: "checkbox"` to `type: "radio"` for every item in the **Themes** submenu (`submenu` built at ~line 921 plus its `Default` unshift), the **Font size** submenu (`fontSizeSubMenu` ~line 970 plus its `Default` unshift), the **Cursor** submenu (`cursorSubMenu` ~line 1002, all seven items), and the **Transparency** submenu (`transparencySubMenu` ~line 935, all three items).

- [ ] **Step 2: Flip the Autonomy submenu to radio (extension)**

In `frontend/app/view/agents/channelrail.tsx`, in the Autonomy submenu map (~line 114-121), change `type: "checkbox"` to `type: "radio"`.

- [ ] **Step 3: (Optional) Flip the terminal Advanced groups to radio (extension)**

In `getSettingsMenuItems`, change `type: "checkbox"` to `type: "radio"` in the Allow-bracketed-paste, Clear-output-on-restart, Run-on-startup, and Debug-connection submenus.

- [ ] **Step 4: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 5: CDP verification**

Open the terminal Themes/Font size/Cursor/Transparency submenus and the channel Autonomy submenu.
Run: `node scripts/cdp-shot.mjs scratch/ctxmenu-radio.png`
Expected: the selected option shows a `•` dot instead of `x`.

---

### Final: verification + single commit (gated on approval)

- [ ] **Step 1: Full typecheck + tests**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Run: `npx vitest run frontend/app/store/contextmenu.test.ts`
Expected: both clean.

- [ ] **Step 2: Full CDP pass**

Right-click each of the nine menus in the dev app; confirm keyboard nav, Sentence-case labels, red destructive items + confirms, and radio dots. Capture a representative screenshot.

- [ ] **Step 3: Stage everything and request approval**

Stage the touched frontend files **and** the spec + this plan (they fold into this one commit). Do NOT commit until the user explicitly approves. Suggested message:

```
feat(contextmenu): keyboard nav, sentence-case labels, destructive affordance

- add pure keyboard-nav reducer (arrows/enter/esc/submenu) + unit tests
- rewrite renderer to roving highlight; danger styling + radio dots
- add danger flag + confirms for Delete channel / Delete note
- sentence-case the terminal menu; radio semantics for exclusive groups
```
