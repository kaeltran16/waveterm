// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import type { QueueRow } from "./briefingmodel";
import { ackAll, actOnQueue } from "./briefqueueactions";
import type { BriefLine } from "./briefrows";

const row = (over: Partial<QueueRow>): QueueRow => ({
    key: "k",
    kind: "gate",
    title: "Plan gate",
    source: "run 7",
    detail: "",
    ts: null,
    action: null,
    nav: null,
    tone: "asking",
    attrib: "",
    why: "",
    cites: [],
    wireKind: "",
    channelId: "ch1",
    runId: "r1",
    taskId: "",
    retry: false,
    ...over,
});

const line = (target: BriefLine["target"]) => ({ id: "waiting:k", target }) as BriefLine;

function fakeDeps(fail = false) {
    const rpc = () => vi.fn(() => (fail ? Promise.reject(new Error("refused")) : Promise.resolve()));
    return {
        rpc: { dagAction: rpc(), ackRun: rpc() },
        undo: { notify: vi.fn(), error: vi.fn() },
        openLine: vi.fn(),
    };
}

describe("actOnQueue", () => {
    it("retries the exact task the server named", async () => {
        const deps = fakeDeps();
        await actOnQueue(deps, row({ wireKind: "dag-blocked", taskId: "t2", retry: true }), line(null));
        expect(deps.rpc.dagAction).toHaveBeenCalledWith({
            channelid: "ch1",
            runid: "r1",
            taskid: "t2",
            action: "retry",
        });
    });

    it("retries a blocked task that can be retried", async () => {
        const deps = fakeDeps();
        await actOnQueue(deps, row({ wireKind: "dag-blocked", taskId: "t3", retry: true }), line(null));
        expect(deps.rpc.dagAction).toHaveBeenCalledWith(expect.objectContaining({ taskid: "t3", action: "retry" }));
        expect(deps.undo.notify).toHaveBeenCalledWith("Retrying t3");
    });

    it("acknowledges an unverified run, falling back to the title when there is no source", async () => {
        const deps = fakeDeps();
        await actOnQueue(deps, row({ wireKind: "run-unverified", source: "" }), line(null));
        expect(deps.rpc.ackRun).toHaveBeenCalledWith({ channelid: "ch1", runid: "r1" });
        expect(deps.undo.notify).toHaveBeenCalledWith("Acknowledged · Plan gate");
    });

    it("shows a refused action's message instead of a success toast", async () => {
        const deps = fakeDeps(true);
        await actOnQueue(deps, row({ wireKind: "dag-blocked", taskId: "t2", retry: true }), line(null));
        expect(deps.undo.error).toHaveBeenCalledWith("refused");
        expect(deps.undo.notify).not.toHaveBeenCalled();
    });

    it("opens the row's target for anything it cannot act on in place", async () => {
        const deps = fakeDeps();
        await actOnQueue(deps, row({ wireKind: "ask" }), line({ oref: "run:r1" }));
        expect(deps.openLine).toHaveBeenCalledWith({ oref: "run:r1" });
        expect(deps.rpc.dagAction).not.toHaveBeenCalled();
    });

    it("does nothing for a row with no target and no in-place action", async () => {
        const deps = fakeDeps();
        await actOnQueue(deps, row({ wireKind: "ask" }), line(null));
        expect(deps.openLine).not.toHaveBeenCalled();
    });
});

describe("ackAll", () => {
    const runs = [
        { channelId: "a", runId: "1" },
        { channelId: "b", runId: "2" },
    ];

    it("acks every run and says how many", async () => {
        const deps = fakeDeps();
        await ackAll(deps, runs);
        expect(deps.rpc.ackRun).toHaveBeenCalledTimes(2);
        expect(deps.rpc.ackRun).toHaveBeenCalledWith({ channelid: "b", runid: "2" });
        expect(deps.undo.notify).toHaveBeenCalledWith("Acknowledged 2 unverified runs");
    });

    it("keeps acking past a refusal and names how many failed", async () => {
        const deps = fakeDeps();
        deps.rpc.ackRun.mockImplementationOnce(() => Promise.reject(new Error("no")));
        await ackAll(deps, runs);
        expect(deps.rpc.ackRun).toHaveBeenCalledTimes(2);
        expect(deps.undo.error).toHaveBeenCalledWith("1 of 2 acknowledgements failed");
        expect(deps.undo.notify).not.toHaveBeenCalled();
    });
});
