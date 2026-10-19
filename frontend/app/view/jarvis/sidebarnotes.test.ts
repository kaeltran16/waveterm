import { describe, expect, it } from "vitest";
import type { FeedEntry } from "./effortfeed";
import { NOTE_OPEN_CHARS, sidebarNotes } from "./sidebarnotes";

const e = (seq: number, text: string, over: Partial<FeedEntry> = {}): FeedEntry => ({
    seq,
    ts: 1000 + seq,
    kind: "effort-note",
    chunk: "N1",
    status: "active",
    marked: "",
    text,
    noteAt: seq + 1,
    ...over,
});

describe("sidebarNotes", () => {
    it("opens the newest short note by default and gives it no chevron", () => {
        const cards = sidebarNotes([e(2, "short"), e(1, "older")], "N1", 5000, new Set());
        expect(cards[0]).toMatchObject({ open: true, chev: "" });
        expect(cards[1]).toMatchObject({ open: false, chev: "more" });
    });
    it("a long newest note starts folded", () => {
        const cards = sidebarNotes([e(1, "x".repeat(300))], "N1", 5000, new Set());
        expect(cards[0]).toMatchObject({ open: false, chev: "more" });
    });
    it("an expanded card offers less", () => {
        const cards = sidebarNotes([e(2, "a"), e(1, "b")], "N1", 5000, new Set(["1"]));
        expect(cards[1]).toMatchObject({ open: true, chev: "less" });
    });
    it("lists only this chunk's notes that have a body, and opens the first of those", () => {
        const cards = sidebarNotes(
            [e(4, "elsewhere", { chunk: "N2" }), e(3, "short"), e(2, ""), e(1, "older")],
            "N1",
            5000,
            new Set()
        );
        expect(cards.map((c) => c.key)).toEqual(["3", "1"]);
        expect(cards.map((c) => c.open)).toEqual([true, false]);
    });
    it("folds a newest note of exactly the open limit", () => {
        const exact = sidebarNotes([e(1, "x".repeat(NOTE_OPEN_CHARS))], "N1", 5000, new Set());
        expect(exact[0]).toMatchObject({ open: false, chev: "more" });
        const shorter = sidebarNotes([e(1, "x".repeat(NOTE_OPEN_CHARS - 1))], "N1", 5000, new Set());
        expect(shorter[0]).toMatchObject({ open: true, chev: "" });
    });
    it("marks only a note flagged edited as edited", () => {
        const cards = sidebarNotes(
            [e(3, "a", { edited: true }), e(2, "b", { edited: false }), e(1, "c")],
            "N1",
            5000,
            new Set()
        );
        expect(cards.map((c) => c.edited)).toEqual([true, false, false]);
    });
    it("makes a note editable only when its place in the chunk is known and it is not the agent's", () => {
        const cards = sidebarNotes(
            [
                e(3, "a", { noteAt: undefined }),
                e(2, "b", { noteAt: undefined, author: "you" }),
                e(1, "c", { author: "agent" }),
            ],
            "N1",
            5000,
            new Set()
        );
        expect(cards.map((c) => c.editable)).toEqual([false, false, false]);
    });
    it("strips the run: and agent: prefixes only from the front, and gives empty ids for a legacy note", () => {
        const cards = sidebarNotes(
            [
                e(2, "a", { run: "xrun:r1", session: "tab-agent:9" }),
                e(1, "b", { run: "run:r2", session: "agent:tab3" }),
            ],
            "N1",
            5000,
            new Set()
        );
        expect(cards[0]).toMatchObject({ runOid: "xrun:r1", sessionTab: "tab-agent:9" });
        expect(cards[1]).toMatchObject({ runOid: "r2", sessionTab: "tab3" });
        expect(sidebarNotes([e(1, "c")], "N1", 5000, new Set())[0]).toMatchObject({ runOid: "", sessionTab: "" });
    });
    it("labels the author; a legacy note has none", () => {
        const cards = sidebarNotes(
            [
                e(3, "a", { author: "agent", session: "agent:tab9", run: "run:r1" }),
                e(2, "b", { author: "you" }),
                e(1, "c"),
            ],
            "N1",
            5000,
            new Set()
        );
        expect(cards.map((c) => c.who)).toEqual(["agent", "you", ""]);
        expect(cards[0]).toMatchObject({ sessionTab: "tab9", runOid: "r1", editable: false });
        expect(cards[1].editable).toBe(true);
        expect(cards[2].editable).toBe(true);
    });
});
