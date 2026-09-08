import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { attentionAtom, loadAttention, splitAttention } from "./attentionstore";

vi.mock("@/app/store/wshclientapi", () => ({
    RpcApi: { GetAttentionCommand: vi.fn() },
}));

const item = (over: Partial<AttentionItem>): AttentionItem =>
    ({ kind: "ask", key: "k", source: "s", text: "t", action: "Answer", waitingsince: 0, ...over }) as AttentionItem;

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

describe("loadAttention", () => {
    beforeEach(() => {
        vi.mocked(RpcApi.GetAttentionCommand).mockReset();
        globalStore.set(attentionAtom, []);
    });

    it("ignores an older response that finishes after a newer load", async () => {
        const older = deferred<{ items: AttentionItem[] }>();
        const newer = deferred<{ items: AttentionItem[] }>();
        vi.mocked(RpcApi.GetAttentionCommand).mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);

        const olderLoad = loadAttention();
        const newerLoad = loadAttention();
        newer.resolve({ items: [item({ key: "newer" })] });
        await newerLoad;
        older.resolve({ items: [item({ key: "older" })] });
        await olderLoad;

        expect(globalStore.get(attentionAtom).map((entry) => entry.key)).toEqual(["newer"]);
    });
});

describe("splitAttention", () => {
    it("routes items with a channel to the Jarvis badge and the rest to Cockpit", () => {
        const out = splitAttention([
            item({ key: "a", channelid: "c1" }),
            item({ key: "b" }),
            item({ key: "c", kind: "gate", channelid: "c2" }),
        ]);
        expect(out.channel.map((i) => i.key)).toEqual(["a", "c"]);
        expect(out.standalone.map((i) => i.key)).toEqual(["b"]);
    });

    it("keeps the two groups disjoint and complete", () => {
        const items = [item({ key: "a", channelid: "c1" }), item({ key: "b" })];
        const out = splitAttention(items);
        expect(out.channel.length + out.standalone.length).toBe(items.length);
    });

    it("treats an empty channel id as standalone, not as a channel named empty", () => {
        const out = splitAttention([item({ key: "a", channelid: "" })]);
        expect(out.standalone).toHaveLength(1);
        expect(out.channel).toHaveLength(0);
    });
});
