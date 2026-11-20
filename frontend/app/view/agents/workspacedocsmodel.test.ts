// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { docRows, docsFold, selectedDocRow, type DocRow } from "./workspacedocsmodel";

const NOW = new Date(2026, 10, 20, 15, 30);
const at = (month: number, day: number, h: number, m: number) => new Date(2026, month - 1, day, h, m).getTime();
const CWD = "C:\\repo";

const doc = (path: string, ts: number, over: Partial<AgentDoc> = {}): AgentDoc => ({
    path,
    ts,
    verb: "written",
    ...over,
});

const row = (r: DocRow) => ({ name: r.name, folder: r.folder, when: r.when, gone: r.gone });

describe("docRows", () => {
    it.each([
        {
            name: "a doc in a cwd subfolder: the folder relative to the cwd, written today",
            doc: doc("C:\\repo\\docs\\specs\\a.md", at(11, 20, 10, 5)),
            want: { name: "a.md", folder: "docs/specs", when: "written 10:05", gone: false },
        },
        {
            name: "a doc at the cwd root has no folder",
            doc: doc("C:\\repo\\README.md", at(11, 20, 9, 0)),
            want: { name: "README.md", folder: "", when: "written 09:00", gone: false },
        },
        {
            name: "a doc outside the cwd: the absolute folder",
            doc: doc("D:\\notes\\scratch\\b.md", at(11, 20, 14, 7)),
            want: { name: "b.md", folder: "D:\\notes\\scratch", when: "written 14:07", gone: false },
        },
        {
            name: "an edit reads edited",
            doc: doc("C:\\repo\\docs\\c.md", at(11, 20, 10, 41), { verb: "edited" }),
            want: { name: "c.md", folder: "docs", when: "edited 10:41", gone: false },
        },
        {
            name: "a touch on another day shows the date",
            doc: doc("C:\\repo\\docs\\d.md", at(11, 3, 23, 59), { verb: "edited" }),
            want: { name: "d.md", folder: "docs", when: "edited 11-03", gone: false },
        },
        {
            name: "a gone doc reads gone",
            doc: doc("C:\\repo\\docs\\e.md", at(11, 20, 8, 0), { gone: true }),
            want: { name: "e.md", folder: "docs", when: "gone", gone: true },
        },
    ])("$name", ({ doc, want }) => {
        expect(docRows([doc], CWD, NOW).map(row)).toEqual([want]);
    });

    it("lists newest first", () => {
        const rows = docRows(
            [
                doc("C:\\repo\\old.md", at(11, 20, 9, 0)),
                doc("C:\\repo\\new.md", at(11, 20, 11, 0)),
                doc("C:\\repo\\mid.md", at(11, 20, 10, 0)),
            ],
            CWD,
            NOW
        );
        expect(rows.map((r) => r.name)).toEqual(["new.md", "mid.md", "old.md"]);
    });

    it("with no cwd known, the folder is absolute", () => {
        expect(docRows([doc("C:\\repo\\docs\\a.md", at(11, 20, 10, 5))], null, NOW)[0].folder).toBe("C:\\repo\\docs");
    });
});

describe("docsFold", () => {
    const rows = (n: number) =>
        docRows(
            Array.from({ length: n }, (_, i) => doc(`C:\\repo\\d${i}.md`, at(11, 20, 10, 59 - i))),
            CWD,
            NOW
        );

    it.each([
        { name: "six rows: all shown, no fold", n: 6, expanded: false, selected: null, shown: 6, more: null },
        {
            name: "nine rows: six, then Show 3 more",
            n: 9,
            expanded: false,
            selected: null,
            shown: 6,
            more: "Show 3 more",
        },
        { name: "nine rows expanded: all, no fold", n: 9, expanded: true, selected: null, shown: 9, more: null },
        {
            name: "the selected doc past the fold opens it",
            n: 9,
            expanded: false,
            selected: "C:\\repo\\d7.md",
            shown: 9,
            more: null,
        },
    ])("$name", ({ n, expanded, selected, shown, more }) => {
        const fold = docsFold(rows(n), expanded, selected);
        expect(fold.shown.length).toBe(shown);
        expect(fold.more).toBe(more);
    });
});

describe("selectedDocRow", () => {
    const rows = docRows(
        [doc("C:\\repo\\docs\\old.md", at(11, 20, 9, 0)), doc("C:\\repo\\docs\\new.md", at(11, 20, 11, 0))],
        CWD,
        NOW
    );

    it.each([
        { name: "null is the newest doc", selected: null, want: "new.md" },
        {
            name: "a listed path, matched with either separator and case",
            selected: "c:/repo/docs/OLD.md",
            want: "old.md",
        },
        { name: "a path no longer listed falls back to the newest", selected: "C:\\repo\\x.md", want: "new.md" },
    ])("$name", ({ selected, want }) => {
        expect(selectedDocRow(rows, selected)?.name).toBe(want);
    });

    it("an empty list selects nothing", () => {
        expect(selectedDocRow([], null)).toBeNull();
    });
});
