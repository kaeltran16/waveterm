import { describe, expect, it } from "vitest";
import {
    answeredAskORefs,
    autonomyExplainer,
    escalationPending,
    fleetCounts,
    parseCardData,
    pendingAsks,
    tierChip,
    unreadCount,
} from "./jarviscards";

const answered = JSON.stringify({
    askORef: "block:abc",
    workerORef: "tab:xyz",
    question: "TTL 24h or 7d?",
    options: [{ label: "24 hours", sub: "matches token" }, { label: "7 days" }],
    choice: 0,
    reason: "reversible",
});

describe("parseCardData", () => {
    it("parses an answered payload", () => {
        const cd = parseCardData({ id: "1", kind: "jarvis-answered", author: "jarvis", text: "", ts: 0, data: answered });
        expect(cd?.question).toBe("TTL 24h or 7d?");
        expect(cd?.options).toHaveLength(2);
        expect(cd?.choice).toBe(0);
        expect(cd?.askORef).toBe("block:abc");
        expect(cd?.workerORef).toBe("tab:xyz");
    });
    it("parses an escalation payload (no choice)", () => {
        const esc = JSON.stringify({ askORef: "block:a", workerORef: "tab:b", question: "q", options: [{ label: "x" }] });
        expect(parseCardData({ id: "2", kind: "jarvis-escalation", author: "jarvis", text: "", ts: 0, data: esc })?.choice).toBeUndefined();
    });
    it("parses a persisted humanPick", () => {
        const esc = JSON.stringify({ askORef: "block:a", workerORef: "tab:b", question: "q", options: [{ label: "x" }, { label: "y" }], humanPick: 1 });
        const cd = parseCardData({ id: "2h", kind: "jarvis-escalation", author: "jarvis", text: "", ts: 0, data: esc });
        expect(cd?.humanPick).toBe(1);
    });
    it("returns null for a legacy message (no data)", () => {
        expect(parseCardData({ id: "3", kind: "jarvis-answered", author: "jarvis", text: "flat", ts: 0 })).toBeNull();
    });
    it("returns null for malformed json", () => {
        expect(parseCardData({ id: "4", kind: "jarvis-answered", author: "jarvis", text: "", ts: 0, data: "{oops" })).toBeNull();
    });
    it("returns null when required fields are missing", () => {
        expect(parseCardData({ id: "5", kind: "jarvis-answered", author: "jarvis", text: "", ts: 0, data: "{}" })).toBeNull();
    });
});

describe("unreadCount", () => {
    const msgs = [
        { id: "a", kind: "human", author: "you", text: "", ts: 100 },
        { id: "b", kind: "dispatch", author: "claude", text: "", ts: 200 },
        { id: "c", kind: "jarvis-answered", author: "jarvis", text: "", ts: 300 },
    ] as ChannelMessage[];
    it("counts messages after lastRead, excluding your own", () => {
        expect(unreadCount(msgs, 150)).toBe(2); // b, c
    });
    it("excludes your own messages", () => {
        expect(unreadCount(msgs, 0)).toBe(2); // a is author 'you'
    });
    it("boundary ts === lastRead is read", () => {
        expect(unreadCount(msgs, 300)).toBe(0);
    });
    it("no lastRead counts all non-you", () => {
        expect(unreadCount(msgs, undefined)).toBe(2);
    });
});

describe("autonomyExplainer", () => {
    it("marks capabilities cumulatively per tier", () => {
        const c = autonomyExplainer("concierge");
        expect(c.checklist.map((x) => x.active)).toEqual([true, false, false]);
        const g = autonomyExplainer("gatekeeper");
        expect(g.checklist.map((x) => x.active)).toEqual([true, true, false]);
        const d = autonomyExplainer("delegator");
        expect(d.checklist.map((x) => x.active)).toEqual([true, true, true]);
    });
    it("labels the three capabilities", () => {
        expect(autonomyExplainer("concierge").checklist.map((x) => x.label)).toEqual([
            "Observe the fleet",
            "Answer routine questions",
            "Dispatch & steer workers",
        ]);
    });
});

describe("tierChip", () => {
    it("maps tier to its letter", () => {
        expect(tierChip("concierge")).toBe("C");
        expect(tierChip("gatekeeper")).toBe("G");
        expect(tierChip("delegator")).toBe("D");
    });
});

describe("escalationPending", () => {
    const card = { askORef: "block:abc" };
    it("is pending while the worker is still blocked on this ask", () => {
        expect(escalationPending(card, { state: "asking", ask: { oref: "block:abc" } })).toBe(true);
    });
    it("is resolved once the worker answered and resumed (no live ask)", () => {
        // the resurface bug: on remount picked is null, so resolution must come from live worker state
        expect(escalationPending(card, { state: "working" })).toBe(false);
        expect(escalationPending(card, { state: "idle" })).toBe(false);
    });
    it("is resolved when the worker moved on to a different ask", () => {
        expect(escalationPending(card, { state: "asking", ask: { oref: "block:other" } })).toBe(false);
    });
    it("is resolved when the worker has exited (no roster row)", () => {
        expect(escalationPending(card, undefined)).toBe(false);
    });
    it("is resolved when the worker is gone", () => {
        expect(escalationPending(card, { state: "gone" })).toBe(false);
    });
});

describe("fleetCounts", () => {
    it("tallies working and waiting(=asking), ignoring idle/gone", () => {
        const snap = [
            { state: "working" }, { state: "working" }, { state: "asking" },
            { state: "idle" }, { state: "gone" },
        ] as { state: string }[];
        expect(fleetCounts(snap)).toEqual({ working: 2, waiting: 1 });
    });
    it("empty snapshot is zero", () => {
        expect(fleetCounts([])).toEqual({ working: 0, waiting: 0 });
    });
});

const answeredCard = (askORef: string) =>
    JSON.stringify({ askORef, workerORef: "tab:x", question: "q", options: [{ label: "y" }], choice: 0 });

describe("answeredAskORefs", () => {
    it("collects askORefs from jarvis-answered cards only (not escalations)", () => {
        const msgs = [
            { id: "1", kind: "jarvis-answered", author: "jarvis", text: "", ts: 0, data: answeredCard("block:a") },
            { id: "2", kind: "jarvis-escalation", author: "jarvis", text: "", ts: 0, data: answeredCard("block:b") },
            { id: "3", kind: "human", author: "you", text: "hi", ts: 0 },
        ] as ChannelMessage[];
        const s = answeredAskORefs(msgs);
        expect(s.has("block:a")).toBe(true);
        expect(s.has("block:b")).toBe(false);
        expect(s.size).toBe(1);
    });
});

describe("pendingAsks", () => {
    const w = (askORef?: string, state = "asking") => ({ state, askORef, oref: "tab:x" });
    it("keeps an asking worker with no answered card", () => {
        expect(pendingAsks([w("block:a")], [] as ChannelMessage[])).toHaveLength(1);
    });
    it("drops an asking worker whose ask Jarvis already answered", () => {
        const msgs = [{ id: "1", kind: "jarvis-answered", author: "jarvis", text: "", ts: 0, data: answeredCard("block:a") }] as ChannelMessage[];
        expect(pendingAsks([w("block:a")], msgs)).toHaveLength(0);
    });
    it("keeps a NEW ask from a worker whose PREVIOUS ask was answered", () => {
        const msgs = [{ id: "1", kind: "jarvis-answered", author: "jarvis", text: "", ts: 0, data: answeredCard("block:old") }] as ChannelMessage[];
        expect(pendingAsks([w("block:new")], msgs)).toHaveLength(1);
    });
    it("ignores non-asking workers", () => {
        expect(pendingAsks([w("block:a", "working")], [] as ChannelMessage[])).toHaveLength(0);
    });
});
