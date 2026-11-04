// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { afterEach, describe, expect, it, vi } from "vitest";

const resync = vi.fn();
vi.mock("@/app/store/wshclientapi", () => ({
    RpcApi: { ControllerResyncCommand: (...a: any[]) => resync(...a) },
}));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));
vi.mock("@/app/store/wps", () => ({ waveEventSubscribeSingle: vi.fn() }));

import { getStartErrorAtom, resyncController } from "./agentcontrollerstore";

const data = { tabid: "tab-1", blockid: "blk-1" };

afterEach(() => {
    resync.mockReset();
    globalStore.set(getStartErrorAtom("blk-1"), undefined);
});

describe("resyncController", () => {
    it("records the error and rethrows", async () => {
        resync.mockRejectedValue(new Error("remote connections are not supported"));
        await expect(resyncController(data)).rejects.toThrow("remote connections are not supported");
        expect(globalStore.get(getStartErrorAtom("blk-1"))).toBe("remote connections are not supported");
    });

    it("clears the error on success", async () => {
        globalStore.set(getStartErrorAtom("blk-1"), "earlier failure");
        resync.mockResolvedValue(undefined);
        await resyncController(data);
        expect(globalStore.get(getStartErrorAtom("blk-1"))).toBeUndefined();
        expect(resync).toHaveBeenCalledWith({}, data);
    });
});
