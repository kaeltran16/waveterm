// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { groupGrepMatches, isCodePath, newFileLines, parseLineGutter } from "./tooldetailmodel";

describe("parseLineGutter", () => {
    it("parses cat -n's tab form into numbers and text", () => {
        expect(parseLineGutter("     1\timport x\n     2\t\n    10\t  return y")).toEqual([
            { no: 1, text: "import x" },
            { no: 2, text: "" },
            { no: 10, text: "  return y" },
        ]);
    });

    it("parses the arrow form", () => {
        expect(parseLineGutter("  41→const a = 1;\n  42→  b();")).toEqual([
            { no: 41, text: "const a = 1;" },
            { no: 42, text: "  b();" },
        ]);
    });

    it("keeps the text after the first separator whole", () => {
        expect(parseLineGutter("1\ta\tb")).toEqual([{ no: 1, text: "a\tb" }]);
    });

    it("gives no gutter to a snippet without the prefix", () => {
        expect(parseLineGutter("const a = 1;\nconst b = 2;")).toBeNull();
    });

    it("gives no gutter when only some lines carry the prefix", () => {
        expect(parseLineGutter("     1\tok\nplain line")).toBeNull();
    });

    it("gives no gutter to an empty snippet", () => {
        expect(parseLineGutter("")).toBeNull();
    });

    it("ignores a trailing newline", () => {
        expect(parseLineGutter("1\ta\n")).toEqual([{ no: 1, text: "a" }]);
    });
});

describe("groupGrepMatches", () => {
    const matches = [
        { loc: "src/a.ts:3", code: "const retry = 1;" },
        { loc: "src/b.ts:10", code: "retry(); Retry();" },
        { loc: "src/a.ts:9", code: "no hit here" },
    ];

    it("groups matches by file in order of first appearance, with line numbers", () => {
        const groups = groupGrepMatches(matches, "retry");
        expect(groups.map((g) => g.file)).toEqual(["src/a.ts", "src/b.ts"]);
        expect(groups[0].lines.map((l) => [l.line, l.code])).toEqual([
            [3, "const retry = 1;"],
            [9, "no hit here"],
        ]);
        expect(groups[1].lines.map((l) => l.line)).toEqual([10]);
    });

    it("marks each match's range", () => {
        const groups = groupGrepMatches(matches, "retry");
        expect(groups[0].lines[0].ranges).toEqual([[6, 11]]);
        expect(groups[0].lines[1].ranges).toEqual([]);
        expect(groups[1].lines[0].ranges).toEqual([[0, 5]]);
    });

    it("matches case-insensitively when asked", () => {
        const groups = groupGrepMatches(matches, "retry", true);
        expect(groups[1].lines[0].ranges).toEqual([
            [0, 5],
            [9, 14],
        ]);
    });

    it("yields no ranges for an invalid regex", () => {
        const groups = groupGrepMatches(matches, "retry(");
        expect(groups.flatMap((g) => g.lines.flatMap((l) => l.ranges))).toEqual([]);
        expect(groups.map((g) => g.file)).toEqual(["src/a.ts", "src/b.ts"]);
    });

    it("yields no ranges without a pattern", () => {
        expect(groupGrepMatches(matches)[0].lines[0].ranges).toEqual([]);
    });

    it("skips zero-length matches", () => {
        expect(groupGrepMatches([{ loc: "a.ts:1", code: "abc" }], "x*")[0].lines[0].ranges).toEqual([]);
    });

    it("keeps a Windows drive path whole", () => {
        const [g] = groupGrepMatches([{ loc: "C:/x/a.go:18", code: "y" }]);
        expect([g.file, g.lines[0].line]).toEqual(["C:/x/a.go", 18]);
    });

    it("puts lines with no location (a files-only result) under one unnamed group", () => {
        const groups = groupGrepMatches([
            { loc: "", code: "src/a.ts" },
            { loc: "", code: "src/b.ts" },
        ]);
        expect(groups).toHaveLength(1);
        expect(groups[0].file).toBe("");
        expect(groups[0].lines.map((l) => [l.line, l.code])).toEqual([
            [undefined, "src/a.ts"],
            [undefined, "src/b.ts"],
        ]);
    });
});

describe("isCodePath", () => {
    it("treats source extensions as code", () => {
        expect(isCodePath("frontend/app/x.ts")).toBe(true);
        expect(isCodePath("pkg/retry/retry.go")).toBe(true);
        expect(isCodePath("C:/a/B.TSX")).toBe(true);
    });

    it("treats .output, .log, .txt and no extension as plain", () => {
        expect(isCodePath("C:/tmp/tasks/b1.output")).toBe(false);
        expect(isCodePath("data/waveapp.log")).toBe(false);
        expect(isCodePath("notes.txt")).toBe(false);
        expect(isCodePath("Makefile")).toBe(false);
        expect(isCodePath("some.dir/Dockerfile")).toBe(false);
    });
});

describe("newFileLines", () => {
    it("numbers a new file's lines from 1 when the diff carries no numbers", () => {
        expect(
            newFileLines({
                path: "a.ts",
                badge: "A",
                adds: 2,
                dels: 0,
                lines: [
                    { sign: "+", text: "one" },
                    { sign: "+", text: "two" },
                ],
            })
        ).toEqual([
            { no: 1, text: "one" },
            { no: 2, text: "two" },
        ]);
    });

    it("keeps a git diff's own numbers and drops its @@ line", () => {
        expect(
            newFileLines({
                path: "a.ts",
                badge: "A",
                adds: 2,
                dels: 0,
                lines: [
                    { sign: "", text: "@@ -0,0 +1,2 @@", hunk: true },
                    { sign: "+", text: "one", newNo: 1 },
                    { sign: "+", text: "two", newNo: 2 },
                ],
            })
        ).toEqual([
            { no: 1, text: "one" },
            { no: 2, text: "two" },
        ]);
    });
});
