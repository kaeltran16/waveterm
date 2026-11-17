// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { waveEventSubscribeSingle } from "@/app/store/wps";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { dropModItems, getAgentQueueAtom, getModItemsAtom, setupAgentQueueSubscription } from "./agentqueuestore";

vi.mock("@/app/store/wps", () => ({ waveEventSubscribeSingle: vi.fn() }));

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
