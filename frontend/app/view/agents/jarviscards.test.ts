import { describe, expect, it } from "vitest";
import { parseCardData, unreadCount } from "./jarviscards";

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
