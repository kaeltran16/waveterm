// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { initiativeChunkRows, openChunk } from "./workspaceinitiativemodel";

// local times, so the expected stamps hold in any zone
const at = (month: number, day: number, h: number, m: number) => new Date(2026, month - 1, day, h, m).getTime();
const note = (ts: number, text: string): EffortNote => ({ ts, text });
const chunk = (label: string, status: string, notes?: EffortNote[]): EffortChunk => ({
    label,
    status,
    updatedts: 0,
    ...(notes ? { notes } : {}),
});

const effort = (chunks: EffortChunk[]) =>
    ({
        otype: "effort",
        oid: "e1",
        version: 1,
        title: "T",
        status: "active",
        chunks,
        createdts: 0,
        updatedts: 0,
    }) as Effort;

// written out of order: the rows sort them
const FIVE_NOTES = [
    note(at(11, 17, 18, 4), "third"),
    note(at(11, 18, 15, 7), "newest"),
    note(at(11, 16, 9, 0), "oldest"),
    note(at(11, 18, 13, 36), "second"),
    note(at(11, 17, 9, 30), "fourth"),
];

describe("initiativeChunkRows", () => {
    it("lists every chunk in plan order with its number, tone and status", () => {
        const rows = initiativeChunkRows(
            effort([chunk("a", "done"), chunk("b", "pending"), chunk("c", "active"), chunk("d", "bogus")])
        );
        expect(rows.map((r) => [r.n, r.label, r.tone, r.status])).toEqual([
            [1, "a", "done", "done"],
            [2, "b", "pending", "pending"],
            [3, "c", "active", "active"],
            [4, "d", "pending", "bogus"],
        ]);
    });

    it.each([
        {
            name: "five notes",
            notes: FIVE_NOTES,
            shown: ["newest", "second", "third"],
            stamps: ["11-18 15:07", "11-18 13:36", "11-17 18:04"],
            older: 2,
        },
        {
            name: "three notes",
            notes: FIVE_NOTES.slice(0, 3),
            shown: ["newest", "third", "oldest"],
            stamps: ["11-18 15:07", "11-17 18:04", "11-16 09:00"],
            older: 0,
        },
        { name: "no notes", notes: undefined, shown: [], stamps: [], older: 0 },
    ])("a chunk with $name shows its latest 3 newest first and counts the rest", ({ notes, shown, stamps, older }) => {
        const [row] = initiativeChunkRows(effort([chunk("a", "active", notes)]));
        expect(row.notes.map((n) => n.text)).toEqual(shown);
        expect(row.notes.map((n) => n.at)).toEqual(stamps);
        expect(row.older).toBe(older);
        expect(row.openable).toBe(shown.length > 0);
    });
});

describe("openChunk", () => {
    const rows = initiativeChunkRows(
        effort([
            chunk("a", "done", [note(1, "x")]),
            chunk("b", "pending"),
            chunk("c", "active", [note(2, "y")]),
            chunk("d", "active", [note(3, "z")]),
        ])
    );
    const quiet = initiativeChunkRows(effort([chunk("a", "done", [note(1, "x")]), chunk("b", "active")]));

    it.each([
        { name: "unset opens the first active chunk", rows, open: undefined, want: 3 },
        { name: "unset with an active chunk that has no notes opens none", rows: quiet, open: undefined, want: null },
        { name: "null opens none", rows, open: null, want: null },
        { name: "a chunk with notes opens", rows, open: 1, want: 1 },
        { name: "a chunk with no notes is not openable", rows, open: 2, want: null },
        { name: "a chunk number past the plan opens none", rows, open: 9, want: null },
    ])("$name", ({ rows, open, want }) => {
        expect(openChunk(rows, open)).toBe(want);
    });
});
