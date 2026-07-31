import { describe, expect, it } from "vitest";
import { splitAttention } from "./attentionstore";

const item = (over: Partial<AttentionItem>): AttentionItem =>
    ({ kind: "ask", key: "k", source: "s", text: "t", action: "Answer", waitingsince: 0, ...over }) as AttentionItem;

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
