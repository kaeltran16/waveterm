import { describe, expect, it } from "vitest";
import {
    clock,
    codeSegments,
    dayLabel,
    effortFeed,
    feedGroups,
    feedNoteCounts,
    headline,
    kilo,
    noteBody,
    paragraphs,
    stamp,
    type FeedEntry,
    type FeedGroupRow,
} from "./effortfeed";

const MIN = 60 * 1000;
// local time, so the day and clock assertions hold in any timezone
const T = new Date(2026, 8, 15, 9, 5).getTime();

function effort(chunks: Partial<EffortChunk>[], events: EffortEvent[]): Effort {
    return {
        oid: "e1",
        otype: "effort",
        version: 1,
        meta: {},
        title: "t",
        status: "active",
        createdts: 0,
        updatedts: 0,
        chunks: chunks.map((c) => ({ label: "", status: "pending", updatedts: 0, ...c })),
        events,
    } as Effort;
}

describe("effortFeed", () => {
    it("names a note's chunk by the note written onto it, even when the event holds an index", () => {
        const e = effort(
            [{ label: "A" }, { label: "B", status: "active", notes: [{ ts: T, text: "shipped the fold" }] }],
            [{ ts: T, kind: "effort-note", label: "2", text: "shipped the fold" }]
        );
        expect(effortFeed(e)).toEqual([
            {
                seq: 0,
                ts: T,
                kind: "effort-note",
                chunk: "B",
                status: "active",
                marked: "",
                text: "shipped the fold",
                noteAt: 1,
                edited: false,
            },
        ]);
    });

    it("reads a status change's note off the chunk when the event dropped it", () => {
        const e = effort(
            [{ label: "B", status: "done", notes: [{ ts: T, text: "marked done · plan written" }] }],
            [{ ts: T, kind: "chunk-done", label: "B", text: "" }]
        );
        const [entry] = effortFeed(e);
        expect([entry.marked, entry.text]).toEqual(["marked done", "plan written"]);
    });

    it("prefers the chunk the event names when one batch marks two chunks alike", () => {
        const e = effort(
            [
                { label: "A", status: "done", notes: [{ ts: T, text: "marked done" }] },
                { label: "B", status: "done", notes: [{ ts: T, text: "marked done" }] },
            ],
            [
                { ts: T, kind: "chunk-done", label: "B", text: "" },
                { ts: T, kind: "chunk-done", label: "A", text: "" },
            ]
        );
        expect(effortFeed(e).map((x) => [x.seq, x.chunk])).toEqual([
            [1, "A"],
            [0, "B"],
        ]);
    });

    it("follows a renamed chunk from the label an added event still carries", () => {
        const e = effort(
            [{ label: "B2 new", notes: [{ ts: T + MIN, text: "renamed from B2 old" }] }],
            [{ ts: T, kind: "chunk-added", label: "B2 old" }]
        );
        const [entry] = effortFeed(e);
        expect([entry.chunk, entry.marked, entry.text]).toEqual(["B2 new", "chunk added", ""]);
    });

    it("tags an entry on a chunk that no longer exists as removed", () => {
        const e = effort([{ label: "A" }], [{ ts: T, kind: "effort-note", label: "4", text: "old note" }]);
        const [entry] = effortFeed(e);
        expect([entry.chunk, entry.status, entry.text]).toEqual(["removed chunk", "removed", "old note"]);
    });

    it("lists newest first and leaves out effort-level events", () => {
        const e = effort(
            [{ label: "A", notes: [{ ts: T + 1, text: "one" }] }],
            [
                { ts: T, kind: "effort-created" },
                { ts: T + 1, kind: "effort-note", label: "A", text: "one" },
                { ts: T + 2, kind: "effort-status", text: "paused" },
                { ts: T + 3, kind: "chunk-added", label: "A" },
            ]
        );
        expect(effortFeed(e).map((x) => x.kind)).toEqual(["chunk-added", "effort-note"]);
    });
});

describe("note text", () => {
    it("drops a leading date only when it repeats the note's own day", () => {
        expect(noteBody({ ts: T, text: "2026-09-15: code complete." })).toBe("code complete.");
        expect(noteBody({ ts: T, text: "2026-09-14 code complete." })).toBe("2026-09-14 code complete.");
    });

    it("heads a note with its first sentence", () => {
        expect(headline("Code complete, verification partial. Details follow; more.")).toBe(
            "Code complete, verification partial."
        );
        expect(headline("fixed effortops.go and moved on")).toBe("fixed effortops.go and moved on");
    });

    it("cuts an overlong first sentence at a word and marks the cut", () => {
        const head = headline("word ".repeat(50) + "end.");
        expect(head.length).toBeLessThanOrEqual(181);
        expect(head.endsWith("word…")).toBe(true);
    });

    it("puts each inline list item on its own line, sub-items one level deeper", () => {
        const flat = paragraphs("Done: (1) first (a) sub (2) second\nNext line").map((p) => [
            p.level,
            p.segs.map((s) => s.text).join(""),
        ]);
        expect(flat).toEqual([
            [0, "Done:"],
            [1, "(1) first"],
            [2, "(a) sub"],
            [1, "(2) second"],
            [0, "Next line"],
        ]);
    });

    it("sets backtick spans, paths and commit ids as code", () => {
        expect(codeSegments("see `wsh effort` in pkg/jarvisstate/effortops.go at 98077bff04 now")).toEqual([
            { text: "see ", code: false },
            { text: "wsh effort", code: true },
            { text: " in ", code: false },
            { text: "pkg/jarvisstate/effortops.go", code: true },
            { text: " at ", code: false },
            { text: "98077bff04", code: true },
            { text: " now", code: false },
        ]);
    });

    it("stamps today's entries with the time and older ones with the date", () => {
        expect(stamp(T, T + 60 * MIN)).toBe("09:05");
        expect(stamp(new Date(2026, 8, 14, 23, 0).getTime(), T)).toBe("09-14");
    });
});

const entry = (seq: number, ts: number, chunk: string, over: Partial<FeedEntry> = {}): FeedEntry => ({
    seq,
    ts,
    kind: "effort-note",
    chunk,
    status: "active",
    marked: "",
    text: "note " + seq,
    ...over,
});
const added = (seq: number, ts: number, chunk: string) =>
    entry(seq, ts, chunk, { kind: "chunk-added", marked: "chunk added", text: "" });

const shape = (rows: FeedGroupRow[]) =>
    rows.map((r) =>
        r.kind === "day" ? `day ${r.label}` : r.kind === "head" ? `head ${r.chunk}` : `${r.kind} ${r.entry.seq}`
    );

describe("dayLabel and clock", () => {
    it("names today, yesterday with its date, and older days by date", () => {
        expect(dayLabel(T, T)).toBe("Today");
        expect(dayLabel(new Date(2026, 8, 14, 23, 0).getTime(), T)).toBe("Yesterday · Mon 14 Sep");
        expect(dayLabel(new Date(2026, 8, 13, 8, 0).getTime(), T)).toBe("Sun 13 Sep");
    });
    it("reads the time of day as HH:MM, whatever the day", () => {
        expect(clock(new Date(2026, 8, 13, 8, 7).getTime())).toBe("08:07");
    });
});

describe("feedGroups", () => {
    it("divides by day, groups by chunk ordered by newest entry, entries newest first", () => {
        const feed = [
            entry(4, T + 4 * MIN, "A"),
            entry(3, T + 3 * MIN, "B"),
            entry(2, T + 2 * MIN, "A"),
            entry(1, new Date(2026, 8, 14, 12, 0).getTime(), "B"),
        ];
        const { rows } = feedGroups(feed, { only: null, limit: 25, now: T });
        expect(shape(rows)).toEqual([
            "day Today",
            "head A",
            "note 4",
            "note 2",
            "head B",
            "note 3",
            "day Yesterday · Mon 14 Sep",
            "head B",
            "note 1",
        ]);
    });

    it("under one chunk draws no headings but keeps the day dividers, and pages the rest", () => {
        const feed = Array.from({ length: 12 }, (_, i) => entry(11 - i, T - i * 60 * MIN, i % 2 === 0 ? "A" : "B"));
        const { rows, left } = feedGroups(feed, { only: "A", limit: 4, now: T });
        expect(rows.some((r) => r.kind === "head")).toBe(false);
        expect(rows.filter((r) => r.kind === "note")).toHaveLength(4);
        expect(rows[0]).toMatchObject({ kind: "day", label: "Today" });
        expect(left).toBe(2);
    });

    it("sets a chunk added and a bare status change as quiet lines, and keeps a status change with a note readable", () => {
        const feed = [
            entry(3, T + 3 * MIN, "A", { kind: "chunk-done", marked: "marked done", text: "Landed. Details follow." }),
            entry(2, T + 2 * MIN, "A", { kind: "chunk-status", marked: "marked active", text: "" }),
            added(1, T + MIN, "A"),
        ];
        const { rows } = feedGroups(feed, { only: null, limit: 25, now: T });
        expect(shape(rows)).toEqual(["day Today", "head A", "note 3", "event 2", "event 1"]);
        expect(rows[3]).toMatchObject({ text: "marked active", time: "09:07" });
        expect(rows[4]).toMatchObject({ text: "chunk added" });
        expect(rows[2]).toMatchObject({ marked: "marked done", head: "Landed.", size: "23" });
    });

    it("heads each note with its first sentence and sizes the whole body", () => {
        const body = "First. " + "x".repeat(1200);
        const { rows } = feedGroups([entry(0, T, "A", { text: body })], { only: null, limit: 25, now: T });
        expect(rows[2]).toMatchObject({ kind: "note", head: "First.", size: "1.2k", body });
    });

    it("carries the chunk's status on its heading", () => {
        const { rows } = feedGroups([entry(0, T, "A", { status: "removed" })], { only: null, limit: 25, now: T });
        expect(rows[1]).toMatchObject({ kind: "head", chunk: "A", status: "removed" });
    });
});

describe("feedNoteCounts", () => {
    it("counts only the entries that carry text, per chunk", () => {
        const counts = feedNoteCounts([entry(2, T, "A"), added(1, T, "A"), entry(0, T, "B")]);
        expect([counts.get("A"), counts.get("B"), counts.get("C")]).toEqual([1, 1, undefined]);
    });
});

describe("kilo", () => {
    it("shortens a count past a thousand to one decimal", () => {
        expect([kilo(950), kilo(1740)]).toEqual(["950", "1.7k"]);
    });
});

describe("effortFeed noteAt", () => {
    const effort = {
        oid: "e",
        chunks: [
            {
                label: "A",
                status: "active",
                notes: [
                    { ts: 10, text: "marked active" },
                    { ts: 20, text: "a real note", edited: true },
                ],
            },
        ],
        events: [
            { ts: 10, kind: "chunk-status", label: "A", text: "" },
            { ts: 20, kind: "effort-note", label: "A", text: "a real note" },
        ],
    } as unknown as Effort;

    it("gives an effort-note its 1-based place in the chunk's trail, and carries edited", () => {
        const note = effortFeed(effort).find((e) => e.kind === "effort-note");
        expect(note?.noteAt).toBe(2);
        expect(note?.edited).toBe(true);
    });
    it("leaves status entries without noteAt, so they stay read-only", () => {
        const status = effortFeed(effort).find((e) => e.kind === "chunk-status");
        expect(status?.noteAt).toBeUndefined();
    });
});
