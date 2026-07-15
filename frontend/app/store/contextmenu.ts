// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { atom, type PrimitiveAtom } from "jotai";
import { globalStore } from "./jotaiStore";

export type ContextMenuState = { items: ContextMenuItem[]; x: number; y: number };

// null when no menu is open; <ContextMenuHost> renders <ContextMenu> when non-null.
export const contextMenuAtom = atom<ContextMenuState | null>(null) as PrimitiveAtom<ContextMenuState | null>;

export function closeContextMenu(): void {
    globalStore.set(contextMenuAtom, null);
}

// visible === false hides an item, matching the old native Tauri menu path.
export function visibleItems(items: ContextMenuItem[]): ContextMenuItem[] {
    return items.filter((it) => it.visible !== false);
}

// True when the menu needs a fixed leading column: any visible item carries an icon, or is a
// checkbox/radio (whose checked-state marker lives in that column). Plain menus stay flush.
export function hasLeadingColumn(items: ContextMenuItem[]): boolean {
    return visibleItems(items).some((it) => it.type === "checkbox" || it.type === "radio" || it.icon != null);
}

// Parity fallback for role-based items; production callers generally pass explicit click handlers.
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

type ShowContextMenuOpts = {
    onSelect?: (item: ContextMenuItem) => void;
    onCancel?: () => void;
    onClose?: (item: ContextMenuItem | null) => void;
};

class ContextMenuModel {
    private static instance: ContextMenuModel;

    private constructor() {}

    static getInstance(): ContextMenuModel {
        if (ContextMenuModel.instance == null) {
            ContextMenuModel.instance = new ContextMenuModel();
        }
        return ContextMenuModel.instance;
    }

    showContextMenu(menu: ContextMenuItem[], ev: React.MouseEvent<any>, _opts?: ShowContextMenuOpts): void {
        ev?.preventDefault?.();
        ev?.stopPropagation?.();
        globalStore.set(contextMenuAtom, { items: menu, x: ev.clientX, y: ev.clientY });
    }
}

export { ContextMenuModel };
