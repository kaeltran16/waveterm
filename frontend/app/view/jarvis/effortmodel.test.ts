import { describe, expect, it } from "vitest";
import {
    buildEffortCard,
    chunkTone,
    effortDeltaRow,
    effortStatusLines,
    effortTone,
    partitionEfforts,
} from "./effortmodel";

const base = {
    oref: "effort:abc",
    title: "Scenario gate clearance",
    status: "active",
    done: 2,
    total: 8,
    activechunk: "Phase 3",
    updatedts: 1000,
    chunks: [
        { label: "Phase 1", status: "done" },
        { label: "Phase 2", status: "done" },
        { label: "Phase 3", status: "active" },
        { label: "Phase 4", status: "deferred" },
        { label: "Phase 5", status: "blocked" },
        { label: "Phase 6", status: "skipped" },
        { label: "Phase 7", status: "pending" },
        { label: "Phase 8", status: "pending" },
    ],
} as EffortSummary;

describe("buildEffortCard", () => {
    it("projects tones and progress with the skip-shrinking denominator", () => {
        const m = buildEffortCard(base);
        expect(m.done).toBe(2);
        expect(m.remaining).toBe(5); // 8 - 2 done - 1 skipped
        expect(m.progressPct).toBe(29); // round(2/7)
        expect(m.countLine).toBe("2 of 7 · 1 skipped · active: Phase 3");
        expect(m.activeChunk).toBe("Phase 3");
        expect(m.chips.map((c) => c.tone)).toEqual([
            "done", "done", "active", "deferred", "blocked", "skipped", "pending", "pending",
        ]);
        expect(m.blockedChunks).toEqual(["Phase 5"]);
    });

    it("caps chips at 12 with an overflow count", () => {
        const chunks = Array.from({ length: 15 }, (_, i) => ({ label: `c${i}`, status: "pending" }));
        const m = buildEffortCard({ ...base, total: 15, chunks } as EffortSummary);
        expect(m.chips).toHaveLength(12);
        expect(m.chipOverflow).toBe(3);
    });

    it("reads as complete when all non-skipped chunks are done", () => {
        const m = buildEffortCard({
            ...base, done: 7, total: 8, activechunk: undefined, chunks: base.chunks.map((c) =>
                c.status === "skipped" ? c : { ...c, status: "done" }),
        } as EffortSummary);
        expect(m.progressPct).toBe(100);
        expect(m.countLine).toBe("7 of 7 · 1 skipped");
    });

    it("handles all-skipped edge", () => {
        const m = buildEffortCard({
            ...base, done: 0, total: 2, chunks: [
                { label: "a", status: "skipped" }, { label: "b", status: "skipped" },
            ],
        } as EffortSummary);
        expect(m.progressPct).toBe(100);
        expect(m.countLine).toBe("all skipped");
    });

    it("omits the skipped suffix when nothing is skipped", () => {
        const m = buildEffortCard({
            ...base, chunks: base.chunks.filter((c) => c.status !== "skipped"), total: 7,
        } as EffortSummary);
        expect(m.countLine).toBe("2 of 7 · active: Phase 3");
    });
});

describe("chunkTone", () => {
    it("maps all six statuses and degrades unknown to pending", () => {
        expect(chunkTone("done")).toBe("done");
        expect(chunkTone("active")).toBe("active");
        expect(chunkTone("blocked")).toBe("blocked");
        expect(chunkTone("deferred")).toBe("deferred");
        expect(chunkTone("skipped")).toBe("skipped");
        expect(chunkTone("pending")).toBe("pending");
        expect(chunkTone("weird")).toBe("pending");
    });
});

describe("effortDeltaRow", () => {
    it("maps effort events to title + meta and ignores others", () => {
        const ev = { ts: 1, kind: "chunk-done", title: "Scenario gate clearance", detail: "Phase 3 · marked done", navtarget: "effort:abc" } as TimelineEvent;
        expect(effortDeltaRow(ev)).toEqual({ title: "Scenario gate clearance", meta: "Phase 3 · marked done" });
        expect(effortDeltaRow({ ts: 1, kind: "run-done", title: "x", detail: "y" } as TimelineEvent)).toBeNull();
    });
});

describe("effortStatusLines", () => {
    it("leads with the active chunk, then every blocked one", () => {
        const lines = effortStatusLines(buildEffortCard(base));
        expect(lines).toEqual([
            { mark: "▶", tone: "active", text: "Phase 3", reading: "active" },
            { mark: "!", tone: "blocked", text: "Phase 5", reading: "in your queue" },
        ]);
    });

    it("says so when nothing is moving, rather than rendering nothing", () => {
        const card = buildEffortCard({
            ...base, activechunk: undefined,
            chunks: [{ label: "a", status: "pending" }], total: 1, done: 0,
        } as EffortSummary);
        expect(effortStatusLines(card)).toEqual([
            { mark: "⏸", tone: "deferred", text: "no chunk active", reading: "0 of 1" },
        ]);
    });

    it("caps at three lines and counts the blocked chunks it hid", () => {
        const chunks = [
            { label: "moving", status: "active" },
            ...Array.from({ length: 5 }, (_, i) => ({ label: `b${i}`, status: "blocked" })),
        ];
        const lines = effortStatusLines(buildEffortCard({ ...base, total: 6, chunks } as EffortSummary));
        expect(lines).toHaveLength(3);
        expect(lines[2]).toEqual({ mark: "!", tone: "blocked", text: "+4 more blocked", reading: "in your queue" });
    });
});

describe("effortTone", () => {
    it("ranks blocked over done over moving", () => {
        expect(effortTone(buildEffortCard(base))).toBe("blocked");
        const clean = base.chunks!.filter((c) => c.status !== "blocked");
        expect(effortTone(buildEffortCard({ ...base, chunks: clean } as EffortSummary))).toBe("active");
        expect(effortTone(buildEffortCard({ ...base, status: "done", chunks: clean } as EffortSummary))).toBe("done");
    });
});

describe("partitionEfforts", () => {
    const of = (oref: string, status: string) => ({ ...base, oref, status }) as EffortSummary;

    it("splits archived out of the active list", () => {
        const p = partitionEfforts([of("effort:a", "active"), of("effort:b", "archived"), of("effort:c", "done")]);
        expect(p.active.map((e) => e.oref)).toEqual(["effort:a", "effort:c"]);
        expect(p.archived.map((e) => e.oref)).toEqual(["effort:b"]);
    });

    it("preserves the wire order within each group", () => {
        const p = partitionEfforts([
            of("effort:a", "archived"),
            of("effort:b", "active"),
            of("effort:c", "archived"),
            of("effort:d", "paused"),
        ]);
        expect(p.active.map((e) => e.oref)).toEqual(["effort:b", "effort:d"]);
        expect(p.archived.map((e) => e.oref)).toEqual(["effort:a", "effort:c"]);
    });

    it("returns an empty archived group when nothing is archived", () => {
        const p = partitionEfforts([of("effort:a", "active")]);
        expect(p.archived).toEqual([]);
        expect(p.active).toHaveLength(1);
    });

    it("projects each row through buildEffortCard", () => {
        const p = partitionEfforts([of("effort:a", "active")]);
        expect(p.active[0].countLine).toBe("2 of 7 · 1 skipped · active: Phase 3");
    });
});
