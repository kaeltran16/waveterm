// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { runRecordRows } from "./runrecord";

describe("runRecordRows", () => {
    it("lists each task with its non-empty sections, then the counts, told and left behind", () => {
        const dag: EvidenceDag = {
            tasks: [
                {
                    taskid: "t-1",
                    state: "done",
                    commit: "0123456789abcdef",
                    reviewrounds: 2,
                    differs: "kept the old flag",
                    notverified: "the CDP scenario\nthe packaged build",
                    reviewerunverified: "the windows path",
                    foundnotfixed: "a stale doc",
                    forlead: "t-4 reads the new key",
                },
                { taskid: "t-2", state: "done", commit: "fedcba9876543210", unstructured: "did it all" },
                { taskid: "t-3", state: "skipped" },
            ],
            answered: 1,
            forwarded: 2,
            told: ["t-1: keep the links clickable"],
            leftbehind: ["t-2", "t-5"],
        };
        expect(runRecordRows(dag)).toEqual([
            { kind: "task", text: "t-1 done  0123456  review rounds 2" },
            { kind: "section", label: "differs", text: "kept the old flag" },
            { kind: "section", label: "not verified", text: "the CDP scenario\nthe packaged build" },
            { kind: "section", label: "reviewer", text: "the windows path" },
            { kind: "section", label: "found not fixed", text: "a stale doc" },
            { kind: "section", label: "for lead", text: "t-4 reads the new key" },
            { kind: "task", text: "t-2 done  fedcba9" },
            { kind: "section", label: "unstructured", text: "did it all" },
            { kind: "task", text: "t-3 skipped" },
            { kind: "run", text: "answered 1  forwarded 2" },
            { kind: "run", label: "told", text: "t-1: keep the links clickable" },
            { kind: "run", label: "left behind", text: "t-2, t-5" },
        ]);
    });

    it("skips empty and whitespace-only sections", () => {
        const dag: EvidenceDag = {
            tasks: [{ taskid: "t-1", state: "done", differs: "", notverified: "  \n ", foundnotfixed: "x" }],
            answered: 0,
            forwarded: 0,
        };
        expect(runRecordRows(dag)).toEqual([
            { kind: "task", text: "t-1 done" },
            { kind: "section", label: "found not fixed", text: "x" },
            { kind: "run", text: "answered 0  forwarded 0" },
        ]);
    });

    it("renders nothing when the run has no record", () => {
        expect(runRecordRows(undefined)).toEqual([]);
    });
});
