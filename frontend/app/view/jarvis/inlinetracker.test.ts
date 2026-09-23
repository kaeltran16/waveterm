// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { BriefLine } from "./briefrows";
import type { ChunkRowModel } from "./effortstore";
import {
    chunkRowId,
    expandableORef,
    stageRowId,
    stageStartsOpen,
    trackerNavIds,
    trackerRows,
    type TrackerRow,
} from "./inlinetracker";

const OREF = "effort:7f2c";

function line(id: string, over: Partial<BriefLine> = {}): BriefLine {
    return {
        id,
        kind: "",
        kindTone: "muted",
        title: "SIEM-1707 AI Correlation Engine enhancements",
        note: "",
        meta: "SIEM-1707",
        state: "active",
        stateTone: "ok",
        progress: { done: 21, total: 33, pct: 64 },
        target: { oref: OREF },
        ...over,
    };
}

function chunk(label: string, status: string, stage: string): ChunkRowModel {
    return { label, status, stage, tone: "pending", trail: [], workrefs: [] };
}

// two stages, and the chunk the initiative picks up next sits in the SECOND one
const CHUNKS: ChunkRowModel[] = [
    chunk("S6-P0 persist weak-signal buffer", "done", "Ticket #1"),
    chunk("S6-P2/P3 retention + D5 purge", "done", "Ticket #1"),
    chunk("S8 item #2 campaign-level narration", "active", "Ticket #2"),
    chunk("S9 chain campaigns", "deferred", "Ticket #2"),
];

const base = {
    lines: [line("initiatives:" + OREF)],
    openLineId: "initiatives:" + OREF,
    chunks: CHUNKS,
    noteCounts: new Map([["S8 item #2 campaign-level narration", 11]]),
    stageOverrides: {},
};

const ids = (rows: TrackerRow[]) => rows.map((r) => `${r.kind}:${r.id}`);

describe("expandableORef", () => {
    it("names the effort behind an Initiatives row", () => {
        expect(expandableORef(line("initiatives:" + OREF))).toBe(OREF);
    });

    it("refuses a Behind-you digest, which summarises a day rather than standing for the object", () => {
        expect(expandableORef(line("behind:effort:2026-09-16:" + OREF))).toBeNull();
    });

    it("refuses a row that opens something other than an effort", () => {
        expect(expandableORef(line("initiatives:run:9", { target: { oref: "run:9" } }))).toBeNull();
    });
});

describe("trackerRows", () => {
    it("leaves a collapsed Brief exactly as it was", () => {
        const rows = trackerRows({ ...base, openLineId: null });
        expect(ids(rows)).toEqual(["line:initiatives:" + OREF]);
        expect(rows[0]).toMatchObject({ kind: "line", expanded: false });
    });

    it("folds the fully-done stage and opens the unfinished one", () => {
        const rows = trackerRows(base);
        const stages = rows.filter((r) => r.kind === "stage");
        expect(stages.map((s) => (s.kind === "stage" ? [s.stage, s.collapsed] : null))).toEqual([
            ["Ticket #1", true],
            ["Ticket #2", false],
        ]);
        expect(stages.map((s) => (s.kind === "stage" ? s.at : -1))).toEqual([0, 1]);
        // the collapsed stage contributes no chunk rows
        expect(rows.filter((r) => r.kind === "chunk")).toHaveLength(2);
    });

    it("splices the open stage's chunks directly under their header, in plan order", () => {
        expect(ids(trackerRows(base))).toEqual([
            "line:initiatives:" + OREF,
            "facts:initiatives:" + OREF + "/facts",
            "stage:initiatives:" + OREF + "/stage:0:Ticket #1",
            "stage:initiatives:" + OREF + "/stage:1:Ticket #2",
            "chunk:" + chunkRowId("initiatives:" + OREF, "S8 item #2 campaign-level narration"),
            "chunk:" + chunkRowId("initiatives:" + OREF, "S9 chain campaigns"),
        ]);
    });

    it("lets an explicit toggle beat the default on either side", () => {
        const opened = trackerRows({
            ...base,
            stageOverrides: { [stageRowId("initiatives:" + OREF, "Ticket #1", 0)]: true },
        });
        expect(opened.filter((r) => r.kind === "chunk")).toHaveLength(4);

        const closed = trackerRows({
            ...base,
            stageOverrides: { [stageRowId("initiatives:" + OREF, "Ticket #2", 1)]: false },
        });
        expect(closed.filter((r) => r.kind === "chunk")).toHaveLength(0);
    });

    it("marks the next chunk and carries each chunk's note count", () => {
        const chunks = trackerRows(base).filter((r) => r.kind === "chunk");
        expect(chunks.map((c) => (c.kind === "chunk" ? [c.row.label, c.next, c.notes] : null))).toEqual([
            ["S8 item #2 campaign-level narration", true, 11],
            ["S9 chain campaigns", false, 0],
        ]);
    });

    it("says the plan is loading rather than flashing an empty one", () => {
        const rows = trackerRows({ ...base, chunks: null });
        expect(rows[1]).toMatchObject({ kind: "pending", message: "Loading this initiative's plan…" });
    });

    it("says so when the initiative genuinely has no chunks", () => {
        const rows = trackerRows({ ...base, chunks: [] });
        expect(rows[1]).toMatchObject({ kind: "pending", message: "No chunks on this initiative yet." });
    });

    it("expands the open line only, leaving its neighbours alone", () => {
        const other = line("initiatives:effort:aaaa", { target: { oref: "effort:aaaa" } });
        const rows = trackerRows({ ...base, lines: [base.lines[0], other] });
        expect(rows.filter((r) => r.kind === "line").map((r) => r.kind === "line" && r.expanded)).toEqual([
            true,
            false,
        ]);
        expect(rows[rows.length - 1].id).toBe("initiatives:effort:aaaa");
    });

    it("does not expand a Behind-you row that happens to name the open effort", () => {
        const digest = line("behind:effort:2026-09-16:" + OREF);
        const rows = trackerRows({ ...base, lines: [digest], openLineId: digest.id });
        expect(ids(rows)).toEqual(["line:" + digest.id]);
    });

    it("keys stages by position, so a stage that reappears later toggles independently", () => {
        const reappearing = [
            chunk("a", "done", "Ticket #1"),
            chunk("b", "active", "Ticket #2"),
            chunk("c", "pending", "Ticket #1"),
        ];
        const rows = trackerRows({ ...base, chunks: reappearing });
        const stages = rows.filter((r) => r.kind === "stage").map((r) => r.id);
        expect(new Set(stages).size).toBe(3);
    });
});

describe("trackerNavIds", () => {
    it("walks lines and chunks, skipping stage headers and the facts row", () => {
        expect(trackerNavIds(trackerRows(base))).toEqual([
            "initiatives:" + OREF,
            chunkRowId("initiatives:" + OREF, "S8 item #2 campaign-level narration"),
            chunkRowId("initiatives:" + OREF, "S9 chain campaigns"),
        ]);
    });

    it("drops the chunks again when the initiative collapses, so a stale cursor cannot survive", () => {
        expect(trackerNavIds(trackerRows({ ...base, openLineId: null }))).toEqual(["initiatives:" + OREF]);
    });
});

describe("stageStartsOpen (design: fully-done stages of 2+ chunks fold)", () => {
    it("folds a finished stage", () => {
        expect(stageStartsOpen({ rows: [chunk("a", "done", "S"), chunk("b", "done", "S")] })).toBe(false);
    });
    it("keeps a one-chunk finished stage open", () => {
        expect(stageStartsOpen({ rows: [chunk("a", "done", "S")] })).toBe(true);
    });
    it("opens every unfinished stage", () => {
        expect(stageStartsOpen({ rows: [chunk("a", "done", "S"), chunk("b", "pending", "S")] })).toBe(true);
    });
});

describe("trackerRows facts row", () => {
    it("carries the design's count and summary inputs", () => {
        const l = { id: "initiatives:effort:e1", target: { oref: "effort:e1" } } as BriefLine;
        const rows = trackerRows({
            lines: [l],
            openLineId: l.id,
            chunks: [chunk("a", "done", "P1"), chunk("b", "blocked", "P2"), chunk("c", "pending", "P2")],
            noteCounts: new Map(),
            stageOverrides: {},
        });
        const facts = rows.find((r) => r.kind === "facts");
        expect(facts).toMatchObject({ count: "3 chunks · 1 done", done: 1, total: 3, blocked: 1, next: "c" });
        const stages = rows.filter((r) => r.kind === "stage");
        expect(stages.map((s) => (s as { first: boolean }).first)).toEqual([true, false]);
    });
});
