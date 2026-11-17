// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { pushToast } from "@/app/cockpit/notificationstore";
import { globalStore } from "@/app/store/jotaiStore";
import { waveEventSubscribeSingle } from "@/app/store/wps";
import { RpcApi } from "@/app/store/wshclientapi";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
    dropModItems,
    getAgentQueueAtom,
    getLostAtom,
    getModItemsAtom,
    setQueueAgentNamer,
    setupAgentQueueSubscription,
    takeBackQueued,
    takeLost,
} from "./agentqueuestore";

vi.mock("@/app/store/wps", () => ({ waveEventSubscribeSingle: vi.fn() }));
vi.mock("@/app/cockpit/notificationstore", () => ({ pushToast: vi.fn() }));
vi.mock("@/app/store/wshclientapi", () => ({ RpcApi: { AgentTakeBackCommand: vi.fn() } }));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));

const T = Date.UTC(2026, 10, 17, 9, 0, 0);
const a = { id: "a", text: "first", ts: T };
const b = { id: "b", text: "second", ts: T + 1 };

function deliver(data: AgentQueueData) {
    const sub = vi
        .mocked(waveEventSubscribeSingle)
        .mock.calls.map(([req]) => req)
        .find((req) => req.eventType === "agent:queue");
    expect(sub).toBeDefined();
    sub!.handler({ event: "agent:queue", data } as WaveEvent);
}

describe("agent queue events", () => {
    beforeAll(() => setupAgentQueueSubscription());

    it("keeps each block's latest report", () => {
        deliver({ oref: "block:one", held: [a] });
        deliver({ oref: "block:two", held: [b] });
        expect(globalStore.get(getAgentQueueAtom("block:one"))?.held).toEqual([a]);
        expect(globalStore.get(getAgentQueueAtom("block:two"))?.held).toEqual([b]);
        expect(globalStore.get(getAgentQueueAtom("block:none"))).toBeNull();
    });

    it("keeps an item that left the held list, not held, until it is dropped", () => {
        const oref = "block:left";
        deliver({ oref, held: [a, b] });
        deliver({ oref, held: [b] });
        expect(globalStore.get(getModItemsAtom(oref))).toEqual([
            { ...a, held: false },
            { ...b, held: true },
        ]);
        dropModItems(oref, ["a"]);
        expect(globalStore.get(getModItemsAtom(oref))).toEqual([{ ...b, held: true }]);
    });

    it("drops a lost item from the drawn items", () => {
        const oref = "block:lost";
        deliver({ oref, held: [a] });
        deliver({ oref, held: [], lost: [a] });
        expect(globalStore.get(getModItemsAtom(oref))).toEqual([]);
    });

    it("ignores an event with no oref", () => {
        expect(() => deliver({ held: [a] } as AgentQueueData)).not.toThrow();
    });
});

describe("lost messages", () => {
    beforeAll(() => setupAgentQueueSubscription());
    beforeEach(() => vi.mocked(pushToast).mockClear());

    it("toasts a lost item once, naming the agent, and keeps it until a box takes it", () => {
        const oref = "block:lost-kept";
        setQueueAgentNamer((blockId) => (blockId === "lost-kept" ? "fixer" : "someone else"));
        deliver({ oref, held: [a, b] });
        deliver({ oref, held: [b], lost: [a] });
        expect(pushToast).toHaveBeenCalledTimes(1);
        const toast = vi.mocked(pushToast).mock.calls[0][0];
        expect(toast.level).toBe("warn");
        expect(toast.title).toContain("fixer");
        expect(toast.title).toContain("1");
        expect(globalStore.get(getLostAtom(oref))).toEqual([a]);

        // a later report that no longer names it keeps it
        deliver({ oref, held: [] });
        expect(globalStore.get(getLostAtom(oref))).toEqual([a]);

        // the box's mount applies it once
        expect(takeLost(oref)).toEqual([a]);
        expect(takeLost(oref)).toEqual([]);
        expect(globalStore.get(getLostAtom(oref))).toEqual([]);
    });

    it("counts every message lost in one report in one toast", () => {
        const oref = "block:lost-two";
        deliver({ oref, held: [], lost: [a, b] });
        expect(pushToast).toHaveBeenCalledTimes(1);
        expect(vi.mocked(pushToast).mock.calls[0][0].title).toContain("2");
        expect(takeLost(oref)).toEqual([a, b]);
    });

    it("neither toasts nor applies again an event delivered twice", () => {
        const oref = "block:lost-again";
        const event = { oref, held: [], lost: [a] };
        deliver(event);
        expect(takeLost(oref)).toEqual([a]);
        deliver(event);
        expect(pushToast).toHaveBeenCalledTimes(1);
        expect(takeLost(oref)).toEqual([]);
    });

    it("keeps a block's lost items apart from another's", () => {
        deliver({ oref: "block:lost-x", held: [], lost: [a] });
        deliver({ oref: "block:lost-y", held: [], lost: [b] });
        expect(takeLost("block:lost-y")).toEqual([b]);
        expect(takeLost("block:lost-x")).toEqual([a]);
    });
});

describe("take-back", () => {
    beforeAll(() => setupAgentQueueSubscription());

    it("returns the mod's items and stops drawing them", async () => {
        const oref = "block:tb";
        deliver({ oref, held: [a, b] });
        // wavesrv publishes the take-back report before the rpc returns: the items left, not yet dropped
        deliver({ oref, held: [] });
        vi.mocked(RpcApi.AgentTakeBackCommand).mockResolvedValueOnce({ items: [a, b] });
        await expect(takeBackQueued("tb")).resolves.toEqual([a, b]);
        expect(RpcApi.AgentTakeBackCommand).toHaveBeenCalledWith(expect.anything(), { blockid: "tb" });
        expect(globalStore.get(getModItemsAtom(oref))).toEqual([]);
    });

    it("keeps drawing the items when the take-back fails", async () => {
        const oref = "block:tb-fail";
        deliver({ oref, held: [a] });
        vi.mocked(RpcApi.AgentTakeBackCommand).mockRejectedValueOnce(new Error("no answer in time"));
        await expect(takeBackQueued("tb-fail")).rejects.toThrow("no answer in time");
        expect(globalStore.get(getModItemsAtom(oref))).toEqual([{ ...a, held: true }]);
    });
});
