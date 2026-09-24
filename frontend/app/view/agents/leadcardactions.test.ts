// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { describe, expect, it, vi } from "vitest";
import { dagAction, rowAction, runCardAction, runCardErrorAtom, tellingRowAtom } from "./leadcardactions";

vi.mock("@/app/store/wshclientapi", () => ({
    RpcApi: { DagActionCommand: vi.fn(), DagMergeContinueCommand: vi.fn() },
}));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));

describe("runCardAction", () => {
    it("shows a refusal on the run's card and clears it on the next action", async () => {
        await runCardAction("R", "cancel", () => Promise.reject(new Error("boom")));
        expect(globalStore.get(runCardErrorAtom)["R"]).toBe("cancel failed: boom");
        await runCardAction("R", "cancel", () => Promise.resolve());
        expect(globalStore.get(runCardErrorAtom)["R"]).toBeUndefined();
    });
});

describe("dagAction", () => {
    it("lands a keyboard-run engine refusal on the same card as a click would", async () => {
        vi.mocked(RpcApi.DagActionCommand).mockRejectedValueOnce(new Error("ask already resolved"));
        await dagAction({ runId: "R2", channelId: "C" }, "t-1", "takeover");
        expect(RpcApi.DagActionCommand).toHaveBeenCalledWith(
            {},
            { channelid: "C", runid: "R2", taskid: "t-1", action: "takeover" }
        );
        expect(globalStore.get(runCardErrorAtom)["R2"]).toBe("takeover t-1 failed: ask already resolved");
    });
});

describe("rowAction", () => {
    const run = { runId: "R3", channelId: "C" };
    it("Tell opens the row's input instead of sending", async () => {
        await rowAction(run, { key: "row:L:t1", taskId: "t1" }, "tell");
        expect(globalStore.get(tellingRowAtom)).toBe("row:L:t1");
        expect(RpcApi.DagActionCommand).not.toHaveBeenCalledWith({}, expect.objectContaining({ runid: "R3" }));
    });
    it("Continue resumes the blocked merge, as the DAG view's resolve does", async () => {
        await rowAction(run, { key: "row:L:t5", taskId: "t5" }, "resolve");
        expect(RpcApi.DagMergeContinueCommand).toHaveBeenCalledWith({}, { channelid: "C", runid: "R3", taskid: "t5" });
    });
    it("anything else is an engine action", async () => {
        await rowAction(run, { key: "row:L:t9", taskId: "t9" }, "retry");
        expect(RpcApi.DagActionCommand).toHaveBeenCalledWith(
            {},
            { channelid: "C", runid: "R3", taskid: "t9", action: "retry" }
        );
    });
});
