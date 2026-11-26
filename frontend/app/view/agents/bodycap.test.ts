// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { DiffLine, EditFile } from "./agentsviewmodel";
import {
    BODY_LINES_MAX,
    capDiffFiles,
    capFailures,
    capGrepGroups,
    capLines,
    capText,
    capWeighted,
    moreFailuresLabel,
    moreLinesLabel,
} from "./bodycap";
import type { TestFailure } from "./testoutput";
import { groupGrepMatches } from "./tooldetailmodel";

const numbered = (n: number, prefix = "line") => Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`);

describe("BODY_LINES_MAX", () => {
    it("is the one inline cap, 20 lines", () => {
        expect(BODY_LINES_MAX).toBe(20);
    });
});

describe("capText", () => {
    it("cuts a body over the cap on a whole line and reports the rest", () => {
        const { text, hidden } = capText(numbered(25).join("\n"));
        expect(text.split("\n")).toEqual(numbered(20));
        expect(hidden).toBe(5);
    });

    it("keeps a body at the cap whole", () => {
        const body = numbered(20).join("\n");
        expect(capText(body)).toEqual({ text: body, hidden: 0 });
    });

    it("does not count a trailing newline as a hidden line", () => {
        const body = numbered(20).join("\n") + "\n";
        expect(capText(body).hidden).toBe(0);
    });

    it("takes its own cap", () => {
        expect(capText("a\nb\nc", 1)).toEqual({ text: "a", hidden: 2 });
    });
});

describe("capLines", () => {
    it("keeps the first lines and counts the rest", () => {
        expect(capLines([1, 2, 3, 4], 3)).toEqual({ lines: [1, 2, 3], hidden: 1 });
        expect(capLines([1, 2], 3)).toEqual({ lines: [1, 2], hidden: 0 });
    });
});

describe("capWeighted", () => {
    it("keeps whole items while their lines fit, and counts the items it hid", () => {
        // three-line items: two fit in 7 lines, the third would cross the cap
        const items = ["a", "b", "c", "d"];
        expect(capWeighted(items, () => 3, 7)).toEqual({ items: ["a", "b"], hidden: 2 });
    });

    it("always shows the first item, even one taller than the cap", () => {
        expect(capWeighted(["tall", "next"], () => 50, 20)).toEqual({ items: ["tall"], hidden: 1 });
    });
});

describe("capGrepGroups", () => {
    const matches = [
        ...numbered(3).map((code, i) => ({ loc: `src/a.ts:${i + 1}`, code })),
        ...numbered(4).map((code, i) => ({ loc: `src/b.ts:${i + 1}`, code })),
    ];

    it("counts a file header as a line and reports the match lines it hid", () => {
        // a.ts: header + 3 lines; b.ts: header + 1 of its 4 lines
        const { groups, hidden } = capGrepGroups(groupGrepMatches(matches), 6);
        expect(groups.map((g) => [g.file, g.lines.length])).toEqual([
            ["src/a.ts", 3],
            ["src/b.ts", 1],
        ]);
        expect(hidden).toBe(3);
    });

    it("never ends on a file header with none of its lines shown", () => {
        // a.ts takes 4 lines; a fifth would be b.ts's bare header
        const { groups, hidden } = capGrepGroups(groupGrepMatches(matches), 5);
        expect(groups.map((g) => g.file)).toEqual(["src/a.ts"]);
        expect(groups[groups.length - 1].lines.length).toBeGreaterThan(0);
        expect(hidden).toBe(4);
    });

    it("gives a files-only list no header line", () => {
        const files = numbered(25, "path").map((code) => ({ loc: "", code }));
        const { groups, hidden } = capGrepGroups(groupGrepMatches(files));
        expect(groups).toHaveLength(1);
        expect(groups[0].lines).toHaveLength(20);
        expect(hidden).toBe(5);
    });

    it("keeps a list under the cap whole", () => {
        const groups = groupGrepMatches(matches);
        expect(capGrepGroups(groups)).toEqual({ groups, hidden: 0 });
    });
});

describe("capDiffFiles", () => {
    const file = (path: string, n: number): EditFile => {
        const lines: DiffLine[] = numbered(n).map((text, i) => ({ sign: "+", text, newNo: i + 1 }));
        return { path, badge: "M", adds: n, dels: 0, lines };
    };

    it("keeps the first lines across files, keeps each file's counts, and reports the lines it hid", () => {
        // x: header + 10 lines; y: header + 8 of its 12
        const { files, hidden } = capDiffFiles([file("x.ts", 10), file("y.ts", 12)]);
        expect(files.map((f) => f.lines.length)).toEqual([10, 8]);
        expect(files.map((f) => f.adds)).toEqual([10, 12]);
        expect(hidden).toBe(4);
    });

    it("drops a file whose lines would all be cut rather than end on its header", () => {
        const { files, hidden } = capDiffFiles([file("x.ts", 19), file("y.ts", 5)]);
        expect(files.map((f) => f.path)).toEqual(["x.ts"]);
        expect(hidden).toBe(5);
    });
});

describe("moreLinesLabel", () => {
    it("is singular for one line and plural otherwise", () => {
        expect(moreLinesLabel(1)).toBe("1 more line");
        expect(moreLinesLabel(5)).toBe("5 more lines");
    });
});

describe("capFailures", () => {
    const failure = (messageLines: number): TestFailure => ({
        test: `T${messageLines}`,
        message: numbered(messageLines).join("\n"),
    });

    it.each([
        // each failure costs its name line and at most FAILURE_MESSAGE_LINES of its message
        { name: "fits whole", lines: [1, 2], max: 20, kept: 2, more: 0, hidden: 0, label: null },
        {
            name: "a clamped message alone counts its cut lines",
            lines: [7],
            max: 20,
            kept: 1,
            more: 0,
            hidden: 4,
            label: "4 more lines",
        },
        // 4 + 4 shown of 8 lines each; the third failure's 1 + 1 lines cut too
        {
            name: "cut failures and clamps both count",
            lines: [7, 7, 1],
            max: 9,
            kept: 2,
            more: 1,
            hidden: 10,
            label: "1 more failure",
        },
        {
            name: "a failure with no message is one line",
            lines: [0, 0, 0],
            max: 2,
            kept: 2,
            more: 1,
            hidden: 1,
            label: "1 more failure",
        },
    ])("$name", ({ lines, max, kept, more, hidden, label }) => {
        const cut = capFailures(lines.map(failure), max);
        expect(cut.failures).toHaveLength(kept);
        expect({ more: cut.more, hidden: cut.hidden }).toEqual({ more, hidden });
        if (label != null) {
            expect(moreFailuresLabel(cut)).toBe(label);
        }
    });
});
