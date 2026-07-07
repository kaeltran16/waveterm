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
