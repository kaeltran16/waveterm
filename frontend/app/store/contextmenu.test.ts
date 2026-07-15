import { afterEach, describe, expect, it } from "vitest";

import {
    closeContextMenu,
    closeSubmenu,
    ContextMenuModel,
    contextMenuAtom,
    firstActionable,
    focusedItem,
    initialPath,
    isActionable,
    moveHighlight,
    openSubmenu,
    roleAction,
    hasLeadingColumn,
    siblingsAt,
    visibleItems,
} from "./contextmenu";
import { globalStore } from "./jotaiStore";

afterEach(() => {
    globalStore.set(contextMenuAtom, null);
});

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

describe("ContextMenuModel.showContextMenu", () => {
    it("sets the atom with items and cursor coordinates", () => {
        const items: ContextMenuItem[] = [{ label: "Copy", click: () => {} }];
        const ev = {
            clientX: 10,
            clientY: 20,
            preventDefault() {},
            stopPropagation() {},
        } as React.MouseEvent<any>;

        ContextMenuModel.getInstance().showContextMenu(items, ev);

        expect(globalStore.get(contextMenuAtom)).toEqual({ items, x: 10, y: 20 });
    });
});

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

describe("hasLeadingColumn", () => {
    it("is false for a plain action-only menu", () => {
        expect(hasLeadingColumn([{ label: "Copy" }, { label: "Paste" }])).toBe(false);
    });
    it("is true when any item has an icon", () => {
        expect(hasLeadingColumn([{ label: "Copy", icon: null as any }, { label: "X", icon: "i" as any }])).toBe(true);
    });
    it("is true when a checkbox or radio is present", () => {
        expect(hasLeadingColumn([{ label: "A" }, { type: "checkbox", label: "Live", checked: true }])).toBe(true);
        expect(hasLeadingColumn([{ type: "radio", label: "Opus", checked: true }])).toBe(true);
    });
    it("ignores separators and headers, and hidden items", () => {
        expect(hasLeadingColumn([{ type: "separator" }, { type: "header", label: "H" }, { label: "A" }])).toBe(false);
        expect(hasLeadingColumn([{ type: "checkbox", label: "hid", visible: false }, { label: "A" }])).toBe(false);
    });
});
