// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { findFileLinks, findWrappedFileLinks, isPeekModifier } from "./termfilelinks";

// the span is derived from the expected linked text, so a wrong offset fails the test.
function expectOne(text: string, linked: string, path: string, line: number | null = null, col: number | null = null) {
    const start = text.indexOf(linked);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(findFileLinks(text)).toEqual([{ start, end: start + linked.length, path, line, col }]);
}

describe("findFileLinks", () => {
    it("drops the parentheses of a tool call", () => {
        const path = "docs/superpowers/specs/2026-11-03-code-peek-design.md";
        expectOne(`● Write(${path})`, path, path);
    });

    it("parses a :line:col suffix and drops backticks and the trailing period", () => {
        const path = "frontend/app/view/term/termwrap.ts";
        expectOne("see `" + path + ":120:7`.", `${path}:120:7`, path, 120, 7);
    });

    it("parses a :line suffix with no column", () => {
        expectOne("at a.go:12, then", "a.go:12", "a.go", 12);
    });

    it("finds a path inside a sentence", () => {
        const path = "frontend/app/view/term/termwrap.ts";
        expectOne(`Updated ${path} with 14 additions`, path, path);
    });

    it.each([["C:\\Users\\me\\repo\\a.go"], ["C:/Users/me/repo/a.go"], ["/home/me/a.py"], ["./x/y.ts"], ["../z.md"]])(
        "finds %s",
        (path) => {
            expectOne(`open ${path} now`, path, path);
        }
    );

    it("finds a bare file name with an extension", () => {
        expectOne("edit README.md please", "README.md", "README.md");
    });

    it.each([
        ["/usr/bin/env"],
        ["./gradlew"],
        ["../tools/run"],
        ["~/bin/deploy"],
        ["~\\bin\\deploy"],
        ["C:\\Windows\\System32\\drivers\\etc\\hosts"],
    ])("finds the anchored extensionless path %s", (path) => {
        expectOne(`run ${path} now`, path, path);
    });

    it.each([["cmd/Makefile"], ["Dockerfile"], ["build/docker/Dockerfile"], ["LICENSE"]])(
        "finds the well-known extensionless file %s",
        (path) => {
            expectOne(`edit ${path} now`, path, path);
        }
    );

    it("parses a :line suffix on a well-known extensionless file", () => {
        expectOne("cmd/Makefile:12: missing separator", "cmd/Makefile:12", "cmd/Makefile", 12);
    });

    it.each([
        ["e.g."],
        ["1.2.3"],
        ["and/or"],
        ["version 1.2.3, e.g. this and/or that"],
        ["TCP/IP and yes/no"],
        ["type /compact to shrink"],
        ["a lone / here"],
        ["the makefile and the license"],
    ])("finds nothing in %s", (text) => {
        expect(findFileLinks(text)).toEqual([]);
    });

    it("leaves a path shortened with … unlinked, since no such file exists", () => {
        const text = "Read ~\\IdeaProjects\\SIEM\\src\\test\\java\\com\\futuredata\\servic…\\QueryTest.java";
        expect(findFileLinks(text)).toEqual([]);
    });

    it.each([["https://github.com/a/b/README.md"], ["file:///C:/x/y.ts"], ["(see https://x.dev/docs/a.md)"]])(
        "leaves the URL %s to the web-link addon",
        (text) => {
            expect(findFileLinks(text)).toEqual([]);
        }
    );

    it.each([
        ["PS C:\\Users\\x\\repo>"],
        ["PS C:\\Users\\x\\repo> "],
        ["kael@box:~/src/repo$ "],
        ["root@box:/etc/nginx# "],
    ])("skips the prompt cwd in %s", (text) => {
        expect(findFileLinks(text)).toEqual([]);
    });

    it("still links a path typed after a prompt", () => {
        const text = "PS C:\\Users\\x\\repo> cat src/a.ts";
        expect(findFileLinks(text).map((m) => m.path)).toEqual(["src/a.ts"]);
    });

    it.each([["GET /api/sessions/10/turn 200"], ['"POST /v1/messages HTTP/1.1" 201'], ["/api/runs/abc 404 12ms"]])(
        "leaves the route on the HTTP log row %s unlinked",
        (text) => {
            expect(findFileLinks(text)).toEqual([]);
        }
    );

    it("still links a rooted path with an extension on an HTTP log row", () => {
        expect(findFileLinks("GET /static/app.js 200").map((m) => m.path)).toEqual(["/static/app.js"]);
    });

    it("still links a rooted extensionless path on a row that is not an HTTP log", () => {
        expect(findFileLinks("run /usr/bin/env 2 times").map((m) => m.path)).toEqual(["/usr/bin/env"]);
    });

    it("finds two paths on one row in order", () => {
        const text = "moved src/a.ts to 'lib/b.tsx',";
        const a = text.indexOf("src/a.ts");
        const b = text.indexOf("lib/b.tsx");
        expect(findFileLinks(text)).toEqual([
            { start: a, end: a + "src/a.ts".length, path: "src/a.ts", line: null, col: null },
            { start: b, end: b + "lib/b.tsx".length, path: "lib/b.tsx", line: null, col: null },
        ]);
    });
});

// rows of a logical line soft-wrapped at cols, one cell per character
function wrapAt(text: string, cols: number): { text: string; cells: number[] }[] {
    const rows = [];
    for (let i = 0; i < text.length; i += cols) {
        const row = text.slice(i, i + cols);
        rows.push({ text: row, cells: Array.from(row, (_, j) => j) });
    }
    return rows;
}

describe("findWrappedFileLinks", () => {
    const Cols = 40;
    const path = "C:/Users/kael02/IdeaProjects/waveterm/frontend/app/briefsurface.tsx";

    it("links a path wrapped onto two rows once, with a two-row range, from either row", () => {
        const head = "    Read(";
        const short = "C:/Users/kael02/IdeaProjects/waveterm/app/briefsurface.tsx";
        const line = `${head}${short})`;
        const rows = wrapAt(line, Cols);
        expect(rows).toHaveLength(2);
        expect(rows[0].text.endsWith("/wa")).toBe(true);
        const end = head.length + short.length;
        const want = {
            match: { start: head.length, end, path: short, line: null, col: null },
            range: { start: { x: head.length + 1, y: 1 }, end: { x: end - Cols, y: 2 } },
        };
        expect(findWrappedFileLinks(rows, 0)).toEqual([want]);
        expect(findWrappedFileLinks(rows, 1)).toEqual([want]);
    });

    it("links a path spanning three rows, whose first row is itself a continuation, as one range", () => {
        const line = `${"x".repeat(Cols)}${"y".repeat(30)} ${path} done`;
        const rows = wrapAt(line, Cols);
        expect(rows).toHaveLength(4);
        const start = line.indexOf(path);
        const end = start + path.length;
        const want = [
            {
                match: { start, end, path, line: null, col: null },
                range: {
                    start: { x: start - Cols + 1, y: 2 },
                    end: { x: end - 3 * Cols, y: 4 },
                },
            },
        ];
        for (const target of [1, 2, 3]) {
            expect(findWrappedFileLinks(rows, target)).toEqual(want);
        }
        expect(findWrappedFileLinks(rows, 0)).toEqual([]);
    });

    it("offsets the rows by the logical line's first buffer row", () => {
        const rows = wrapAt("see src/a.ts", Cols);
        expect(findWrappedFileLinks(rows, 0, 9)[0].range).toEqual({ start: { x: 5, y: 10 }, end: { x: 12, y: 10 } });
    });

    it("returns only the matches that touch the target row", () => {
        const line = "a.ts" + " ".repeat(Cols - 4) + "b.ts";
        const rows = wrapAt(line, Cols);
        expect(findWrappedFileLinks(rows, 0).map((l) => l.match.path)).toEqual(["a.ts"]);
        expect(findWrappedFileLinks(rows, 1).map((l) => l.match.path)).toEqual(["b.ts"]);
    });

    it("maps a path after a wide character by cell, not by string index", () => {
        // 中 and 文 take two cells each
        const text = "中文 src/a.ts";
        const cells = [0, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12];
        expect(cells).toHaveLength(text.length);
        expect(findWrappedFileLinks([{ text, cells }], 0)[0].range).toEqual({
            start: { x: 6, y: 1 },
            end: { x: 13, y: 1 },
        });
    });
});

describe("isPeekModifier", () => {
    it("is Ctrl, not Meta, off mac", () => {
        expect(isPeekModifier({ ctrlKey: true, metaKey: false }, false)).toBe(true);
        expect(isPeekModifier({ ctrlKey: false, metaKey: true }, false)).toBe(false);
    });

    it("is Meta, not Ctrl, on mac", () => {
        expect(isPeekModifier({ ctrlKey: false, metaKey: true }, true)).toBe(true);
        expect(isPeekModifier({ ctrlKey: true, metaKey: false }, true)).toBe(false);
    });
});
