// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { effortPeekFacts, effortPeekModel } from "./peekeffortmodel";

const chunk = (label: string, status: string, stage = ""): EffortChunk => ({ label, status, stage, updatedts: 0 });

const EFFORT = {
    otype: "effort",
    oid: "e1",
    version: 1,
    title: "Cockpit Focus and Peek",
    project: "waveterm",
    status: "active",
    notes: [
        { ts: 20, text: "later" },
        { ts: 10, text: "Surfaces agree on a subject." },
    ],
    chunks: [
        chunk("one", "done", "slice 1"),
        chunk("two", "done", "slice 1"),
        chunk("three", "active", "slice 2"),
        chunk("four", "pending"),
        chunk("five", "skipped"),
    ],
    createdts: 0,
    updatedts: 0,
} as Effort;

describe("effortPeekModel", () => {
    const model = () => effortPeekModel(EFFORT);

    it("counts done chunks, skips shrinking the total", () => {
        expect(model().progress).toBe("2 of 4 chunks done");
        expect(model().doneLine).toBe("2 done · slice 1");
    });

    it("lists the remaining chunks in plan order with the active one marked", () => {
        expect(model().remaining.map((c) => [c.n, c.label, c.active])).toEqual([
            [3, "three", true],
            [4, "four", false],
        ]);
    });

    it("draws one segment per chunk", () => {
        expect(model().segments).toEqual(["done", "done", "active", "pending", "skipped"]);
    });

    it("reads the objective from the first note and omits what is unknown", () => {
        expect(model().objective).toBe("Surfaces agree on a subject.");
        const bare = effortPeekModel({ ...EFFORT, notes: [], project: undefined, chunks: [] } as Effort);
        expect(bare.objective).toBeNull();
        expect(bare.project).toBeNull();
        expect(bare.doneLine).toBeNull();
    });
});

describe("effortPeekModel, whole", () => {
    it("builds every field from the effort", () => {
        expect(effortPeekModel(EFFORT)).toStrictEqual({
            title: "Cockpit Focus and Peek",
            status: "active",
            objective: "Surfaces agree on a subject.",
            progress: "2 of 4 chunks done",
            project: "waveterm",
            segments: ["done", "done", "active", "pending", "skipped"],
            doneLine: "2 done · slice 1",
            remaining: [
                { n: 3, label: "three", status: "active", tone: "active", active: true },
                { n: 4, label: "four", status: "pending", tone: "pending", active: false },
            ],
        });
    });

    it("names each distinct done stage once, in plan order, leaving out a blank one", () => {
        const effort = {
            ...EFFORT,
            chunks: [
                chunk("one", "done", "beta"),
                chunk("two", "done"),
                chunk("three", "done", "alpha"),
                chunk("four", "done", "beta"),
                chunk("five", "active", "gamma"),
            ],
        } as Effort;
        expect(effortPeekModel(effort).doneLine).toBe("4 done · beta · alpha");
    });

    it("takes the earliest note as the objective whatever order the notes arrive in", () => {
        const effort = {
            ...EFFORT,
            notes: [
                { ts: 30, text: "last" },
                { ts: 10, text: "first" },
                { ts: 20, text: "middle" },
            ],
        } as Effort;
        expect(effortPeekModel(effort).objective).toBe("first");
    });

    it("has no objective for an effort that carries no notes at all", () => {
        expect(effortPeekModel({ ...EFFORT, notes: undefined } as Effort).objective).toBeNull();
    });
});

describe("effortPeekFacts", () => {
    it("is gone when the effort is missing", () => {
        expect(effortPeekFacts(undefined)).toEqual({ gone: true });
    });
    it("is present when the effort exists", () => {
        expect(effortPeekFacts(EFFORT)).toEqual({ gone: false });
    });
});
