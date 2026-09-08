import { globalStore } from "@/app/store/jotaiStore";
import { waveEventSubscribeSingle } from "@/app/store/wps";
import { RpcApi } from "@/app/store/wshclientapi";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getAgentAskAtom, setupAgentAskSubscription } from "./agentaskstore";
import { attentionAtom } from "./attentionstore";

vi.mock("@/app/store/wps", () => ({ waveEventSubscribeSingle: vi.fn() }));
vi.mock("@/app/store/wshclientapi", () => ({
    RpcApi: { GetAttentionCommand: vi.fn() },
}));

const staleAttention = {
    kind: "ask",
    key: "ask:block:worker",
    source: "worker",
    text: "Waiting on your reply",
    action: "Answer",
    waitingsince: 1,
} as AttentionItem;

describe("agent ask events", () => {
    beforeAll(() => setupAgentAskSubscription());

    beforeEach(() => {
        vi.mocked(RpcApi.GetAttentionCommand).mockReset();
        globalStore.set(attentionAtom, [staleAttention]);
    });

    it("refreshes cockpit attention when an ask is cleared", async () => {
        vi.mocked(RpcApi.GetAttentionCommand).mockResolvedValue({ items: [] });
        const subscription = vi
            .mocked(waveEventSubscribeSingle)
            .mock.calls.map(([request]) => request)
            .find((request) => request.eventType === "agent:ask");
        expect(subscription).toBeDefined();

        subscription!.handler({
            data: { oref: "block:worker", askid: "ask-1", cleared: true },
        } as WaveEvent);

        await vi.waitFor(() => expect(globalStore.get(attentionAtom)).toEqual([]));
    });

    it("does not clear a replacement ask with an older ask id", () => {
        vi.mocked(RpcApi.GetAttentionCommand).mockResolvedValue({ items: [] });
        const subscription = vi
            .mocked(waveEventSubscribeSingle)
            .mock.calls.map(([request]) => request)
            .find((request) => request.eventType === "agent:ask");
        expect(subscription).toBeDefined();
        const replacement = { oref: "block:worker", askid: "ask-b", cleared: false } as AgentAskData;

        subscription!.handler({ data: replacement } as WaveEvent);
        subscription!.handler({
            data: { oref: "block:worker", askid: "ask-a", cleared: true },
        } as WaveEvent);

        expect(globalStore.get(getAgentAskAtom("block:worker"))).toEqual(replacement);
    });

    it("refreshes cockpit attention when an agent block closes", async () => {
        vi.mocked(RpcApi.GetAttentionCommand).mockResolvedValue({ items: [] });
        const subscription = vi
            .mocked(waveEventSubscribeSingle)
            .mock.calls.map(([request]) => request)
            .find((request) => request.eventType === "blockclose");
        expect(subscription).toBeDefined();

        subscription!.handler({ data: "worker" } as WaveEvent);

        await vi.waitFor(() => expect(globalStore.get(attentionAtom)).toEqual([]));
    });
});
