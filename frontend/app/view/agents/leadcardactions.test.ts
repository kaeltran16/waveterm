// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { describe, expect, it, vi } from "vitest";
import {
    dagAction,
    reviewGuideAtom,
    reviewGuideKey,
    rowAction,
    runCardAction,
    runCardErrorAtom,
    tellingRowAtom,
} from "./leadcardactions";
import { cardErrorShown } from "./leadcardmodel";

vi.mock("@/app/store/wshclientapi", () => ({
    RpcApi: { DagActionCommand: vi.fn(), DagMergeContinueCommand: vi.fn() },
}));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));

const runWith = (runId: string, tasks: [string, string][], askIds: Record<string, string> = {}) => ({
    runId,
    channelId: "C",
    dag: { tasks: tasks.map(([id, state]) => ({ id, state })) } as TaskGroup,
    digest: {
        tasks: Object.entries(askIds).map(([taskid, askid]) => ({ taskid, askid })),
    } as DagStatusDigest,
});

describe("runCardAction", () => {
    it("shows a refusal on the run's card and clears it on the next action", async () => {
        await runCardAction("R", "cancel", () => Promise.reject(new Error("boom")));
        expect(globalStore.get(runCardErrorAtom)["R"]).toEqual({ msg: "cancel failed: boom" });
        await runCardAction("R", "cancel", () => Promise.resolve());
        expect(globalStore.get(runCardErrorAtom)["R"]).toBeUndefined();
    });
});

describe("dagAction", () => {
    it("lands a keyboard-run engine refusal on the same card as a click would, in the action's words", async () => {
        vi.mocked(RpcApi.DagActionCommand).mockRejectedValueOnce(new Error("ask already resolved"));
        await dagAction(runWith("R2", [["t-1", "running"]], { "t-1": "a1" }), "t-1", "takeover");
        expect(RpcApi.DagActionCommand).toHaveBeenCalledWith(
            {},
            { channelid: "C", runid: "R2", taskid: "t-1", action: "takeover" }
        );
        expect(globalStore.get(runCardErrorAtom)["R2"]).toEqual({
            msg: "Take over t-1: ask already resolved",
            taskId: "t-1",
            stamp: "running|a1",
        });
    });

    it("keeps a task's refusal while that task is unchanged, even when another task's row changes", async () => {
        vi.mocked(RpcApi.DagActionCommand).mockRejectedValueOnce(new Error("not failed"));
        await dagAction(
            runWith("R4", [
                ["t-1", "failed"],
                ["t-2", "running"],
            ]),
            "t-1",
            "retry"
        );
        const err = globalStore.get(runCardErrorAtom)["R4"];
        expect(err.msg).toBe("Retry t-1: not failed");
        const otherMoved = runWith("R4", [
            ["t-1", "failed"],
            ["t-2", "done"],
        ]);
        expect(cardErrorShown(err, otherMoved)).toBe(true);
        const moved = runWith("R4", [
            ["t-1", "running"],
            ["t-2", "done"],
        ]);
        expect(cardErrorShown(err, moved)).toBe(false);
    });

    it("keeps today's refusal for an action with no task", async () => {
        vi.mocked(RpcApi.DagActionCommand).mockRejectedValueOnce(new Error("already done"));
        await dagAction(runWith("R5", []), "", "cancel");
        expect(globalStore.get(runCardErrorAtom)["R5"]).toEqual({ msg: "cancel failed: already done" });
    });
});

describe("rowAction", () => {
    const run = runWith("R3", [["t5", "blocked-merge"]]);
    it("Tell opens the row's input instead of sending", async () => {
        await rowAction(run, { key: "row:L:t1", taskId: "t1" }, "tell");
        expect(globalStore.get(tellingRowAtom)).toBe("row:L:t1");
        expect(RpcApi.DagActionCommand).not.toHaveBeenCalledWith({}, expect.objectContaining({ runid: "R3" }));
    });
    it("Continue resumes the blocked merge, as the DAG view's resolve does", async () => {
        await rowAction(run, { key: "row:L:t5", taskId: "t5" }, "resolve");
        expect(RpcApi.DagMergeContinueCommand).toHaveBeenCalledWith({}, { channelid: "C", runid: "R3", taskid: "t5" });
    });
    it("Continue's refusal reads Continue", async () => {
        vi.mocked(RpcApi.DagMergeContinueCommand).mockRejectedValueOnce(new Error("still conflicted"));
        await rowAction(run, { key: "row:L:t5", taskId: "t5" }, "resolve");
        expect(globalStore.get(runCardErrorAtom)["R3"]).toMatchObject({
            msg: "Continue t5: still conflicted",
            stamp: "blocked-merge|",
        });
    });
    it("a keyed Send back carries the guidance typed under the review", async () => {
        globalStore.set(reviewGuideAtom, { [reviewGuideKey("R3", "t7")]: " check the retry path " });
        await rowAction(run, { key: "row:L:t7", taskId: "t7" }, "sendback");
        expect(RpcApi.DagActionCommand).toHaveBeenCalledWith(
            {},
            expect.objectContaining({ runid: "R3", taskid: "t7", action: "sendback", notes: "check the retry path" })
        );
    });
    it("a landed Send back empties the box, so the next round's keyed Send back sends no stale guidance", async () => {
        globalStore.set(reviewGuideAtom, { [reviewGuideKey("R3", "t8")]: "round one notes" });
        await rowAction(run, { key: "row:L:t8", taskId: "t8" }, "sendback");
        expect(globalStore.get(reviewGuideAtom)[reviewGuideKey("R3", "t8")]).toBeUndefined();
        vi.mocked(RpcApi.DagActionCommand).mockClear();
        await rowAction(run, { key: "row:L:t8", taskId: "t8" }, "sendback");
        expect(RpcApi.DagActionCommand).toHaveBeenCalledWith(
            {},
            { channelid: "C", runid: "R3", taskid: "t8", action: "sendback" }
        );
    });
    it("a refused Send back keeps the guidance to retry with", async () => {
        globalStore.set(reviewGuideAtom, { [reviewGuideKey("R3", "t6")]: "keep me" });
        vi.mocked(RpcApi.DagActionCommand).mockRejectedValueOnce(new Error("not failed"));
        await rowAction(run, { key: "row:L:t6", taskId: "t6" }, "sendback");
        expect(globalStore.get(reviewGuideAtom)[reviewGuideKey("R3", "t6")]).toBe("keep me");
    });
    it("anything else is an engine action", async () => {
        await rowAction(run, { key: "row:L:t9", taskId: "t9" }, "retry");
        expect(RpcApi.DagActionCommand).toHaveBeenCalledWith(
            {},
            { channelid: "C", runid: "R3", taskid: "t9", action: "retry" }
        );
    });
});
