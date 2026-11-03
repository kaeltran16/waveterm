// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { fileLinkRange, findFileLinks, isPeekModifier } from "./termfilelinks";

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

describe("fileLinkRange", () => {
    it("maps a match to 1-based inclusive cells on the next row number", () => {
        const match = { start: 7, end: 20, path: "x", line: null, col: null };
        expect(fileLinkRange(match, 4)).toEqual({ start: { x: 8, y: 5 }, end: { x: 20, y: 5 } });
    });

    it("starts a match at column 0 on x 1", () => {
        const match = { start: 0, end: 4, path: "a.go", line: null, col: null };
        expect(fileLinkRange(match, 0)).toEqual({ start: { x: 1, y: 1 }, end: { x: 4, y: 1 } });
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
