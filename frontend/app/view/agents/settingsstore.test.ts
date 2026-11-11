// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { toastsAtom } from "@/app/cockpit/notificationstore";
import { globalStore } from "@/app/store/jotaiStore";
import { describe, expect, it, vi } from "vitest";
import { pendingSettingsSectionAtom, takePendingSettingsSection, writeConfig } from "./settingsstore";

const setConfigCommand = vi.fn();
vi.mock("@/app/store/wshclientapi", () => ({
    RpcApi: { SetConfigCommand: (...args: any[]) => setConfigCommand(...args) },
}));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));

describe("takePendingSettingsSection", () => {
    it("returns nothing when no escort is pending", () => {
        globalStore.set(pendingSettingsSectionAtom, null);
        expect(takePendingSettingsSection()).toBeNull();
    });

    it("honours one escort exactly once, so a remount does not re-scroll", () => {
        globalStore.set(pendingSettingsSectionAtom, "headless");
        expect(takePendingSettingsSection()).toBe("headless");
        expect(takePendingSettingsSection()).toBeNull();
    });
});

describe("writeConfig", () => {
    it("says so when the write is refused", async () => {
        globalStore.set(toastsAtom, []);
        setConfigCommand.mockRejectedValueOnce(new Error("open settings.json: access denied"));
        await writeConfig({ "term:scrollback": 2250 });
        expect(setConfigCommand).toHaveBeenCalledWith({}, { "term:scrollback": 2250 });
        expect(globalStore.get(toastsAtom)).toMatchObject([
            { title: "Setting not saved", message: "open settings.json: access denied", level: "error" },
        ]);
    });

    it("stays quiet when the write lands", async () => {
        globalStore.set(toastsAtom, []);
        setConfigCommand.mockResolvedValueOnce(undefined);
        await writeConfig({ "term:scrollback": 2250 });
        expect(globalStore.get(toastsAtom)).toEqual([]);
    });
});
