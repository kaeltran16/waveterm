import { afterEach, describe, expect, it } from "vitest";

import { closeContextMenu, ContextMenuModel, contextMenuAtom, roleAction, visibleItems } from "./contextmenu";
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
