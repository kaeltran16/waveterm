import type { AgentVM } from "@/app/view/agents/agentsviewmodel";
import { describe, expect, it } from "vitest";
import { popupTarget } from "./attentionpopuptarget";

const item = (over: Partial<AttentionItem>): AttentionItem =>
    ({ kind: "ask", key: "k", source: "s", text: "t", action: "Answer", waitingsince: 0, ...over }) as AttentionItem;
const agents = [{ id: "tab1", blockId: "b1" } as AgentVM];

describe("popupTarget", () => {
    it("opens the agent of an ask on the roster", () => {
        expect(popupTarget(item({ key: "ask:block:b1", channelid: "c" }), agents)).toEqual({
            kind: "agent",
            tabId: "tab1",
        });
    });
    it("opens the brainstorm of its item even when its source names a roster agent", () => {
        expect(
            popupTarget(item({ kind: "brainstorm", key: "brainstorm:tab1:5", oref: "brainstorm:lag" }), agents)
        ).toEqual({ kind: "brainstorm", topic: "lag" });
    });
    it("opens the item's oref when it is an address", () => {
        expect(popupTarget(item({ kind: "dag-blocked", oref: "task:d1" }), agents)).toEqual({
            kind: "record",
            dossierId: "d1",
            anchor: undefined,
        });
    });
    it("falls through an unsupported oref", () => {
        expect(popupTarget(item({ oref: "bogus:x", runid: "r" }), agents)).toEqual({ kind: "run", runId: "r" });
    });
    it("opens the run of a blocked dag", () => {
        expect(popupTarget(item({ kind: "dag-blocked", channelid: "c", runid: "r" }), agents)).toEqual({
            kind: "run",
            runId: "r",
        });
    });
    it("opens the channel of an escalation with no run", () => {
        expect(popupTarget(item({ kind: "escalation", channelid: "c" }), agents)).toEqual({
            kind: "channel",
            channelId: "c",
        });
    });
    it("is null for an ask with no channel whose agent left", () => {
        expect(popupTarget(item({ key: "ask:block:gone" }), agents)).toBeNull();
    });
    it("opens the run of an ask whose agent left", () => {
        expect(popupTarget(item({ key: "ask:block:gone", runid: "r" }), agents)).toEqual({ kind: "run", runId: "r" });
    });
});
