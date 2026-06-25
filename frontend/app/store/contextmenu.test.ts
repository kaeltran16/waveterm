import { afterEach, describe, expect, it, vi } from "vitest";

const { popup, buildTauriMenu } = vi.hoisted(() => {
    const popup = vi.fn();
    const buildTauriMenu = vi.fn(async () => ({ popup }));
    return { popup, buildTauriMenu };
});

vi.mock("../../tauri/menu", () => ({ buildTauriMenu }));

import { ContextMenuModel } from "./contextmenu";

afterEach(() => {
    buildTauriMenu.mockClear();
    popup.mockClear();
});

describe("ContextMenuModel", () => {
    it("builds a Tauri menu from items and pops it", async () => {
        const items = [{ label: "Copy", click: vi.fn() }];
        ContextMenuModel.getInstance().showContextMenu(items as any, { preventDefault() {} } as any);
        await vi.waitFor(() => expect(buildTauriMenu).toHaveBeenCalledWith(items));
        await vi.waitFor(() => expect(popup).toHaveBeenCalled());
    });
});
