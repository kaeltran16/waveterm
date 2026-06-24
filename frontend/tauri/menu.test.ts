import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
    const mk = (kind: string) => vi.fn(async (opts: any) => ({ kind, ...opts }));
    return {
        Menu: mk("menu"),
        MenuItem: mk("item"),
        Submenu: mk("submenu"),
        CheckMenuItem: mk("check"),
        PredefinedMenuItem: mk("predef"),
    };
});
vi.mock("@tauri-apps/api/menu", () => ({
    Menu: { new: h.Menu },
    MenuItem: { new: h.MenuItem },
    Submenu: { new: h.Submenu },
    CheckMenuItem: { new: h.CheckMenuItem },
    PredefinedMenuItem: { new: h.PredefinedMenuItem },
}));

import { buildTauriMenu } from "./menu";

beforeEach(() => {
    for (const f of Object.values(h)) f.mockClear();
});

describe("buildTauriMenu", () => {
    it("maps plain / separator / checkbox / submenu items to the right Tauri classes", async () => {
        const items: ContextMenuItem[] = [
            { label: "Plain", click: () => {} },
            { type: "separator" },
            { label: "Chk", type: "checkbox", checked: true, click: () => {} },
            { label: "Sub", submenu: [{ label: "Inner", click: () => {} }] },
        ];
        await buildTauriMenu(items);
        expect(h.MenuItem).toHaveBeenCalledWith(expect.objectContaining({ text: "Plain" }));
        expect(h.PredefinedMenuItem).toHaveBeenCalledWith(expect.objectContaining({ item: "Separator" }));
        expect(h.CheckMenuItem).toHaveBeenCalledWith(expect.objectContaining({ text: "Chk", checked: true }));
        expect(h.Submenu).toHaveBeenCalledWith(expect.objectContaining({ text: "Sub" }));
        expect(h.MenuItem).toHaveBeenCalledWith(expect.objectContaining({ text: "Inner" }));
        expect(h.Menu).toHaveBeenCalledTimes(1);
    });

    it("wires a plain item's action to its click callback", async () => {
        const click = vi.fn();
        await buildTauriMenu([{ label: "A", click }]);
        const call = h.MenuItem.mock.calls.find((c) => c[0].text === "A");
        await call[0].action();
        expect(click).toHaveBeenCalledOnce();
    });

    it("maps a known role to a predefined item and skips hidden items", async () => {
        await buildTauriMenu([
            { label: "Copy", role: "copy" },
            { label: "Hidden", visible: false, click: () => {} },
        ]);
        expect(h.PredefinedMenuItem).toHaveBeenCalledWith(expect.objectContaining({ item: "Copy" }));
        expect(h.MenuItem).not.toHaveBeenCalledWith(expect.objectContaining({ text: "Hidden" }));
    });
});
