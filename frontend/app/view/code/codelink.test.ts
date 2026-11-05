// frontend/app/view/code/codelink.test.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { resolveDocLink, slugHeadings } from "./codelink";

describe("slugHeadings", () => {
    it("slugHeadings matches GitHub for punctuation and repeats", () => {
        expect(slugHeadings(["The final stage", "A/B: test", "Setup", "Setup"])).toEqual([
            "the-final-stage",
            "ab-test",
            "setup",
            "setup-1",
        ]);
        expect(slugHeadings(["`codeFile` **kinds**", "snake_case-name", "x", "x", "x-1"])).toEqual([
            "codefile-kinds",
            "snake_case-name",
            "x",
            "x-1",
            "x-1-1",
        ]);
    });
});

describe("resolveDocLink", () => {
    it("resolves a sibling against the open file's directory", () => {
        expect(resolveDocLink("docs/specs/a.md", "b.md")).toEqual({ rel: "docs/specs/b.md", line: null, anchor: null });
        expect(resolveDocLink("docs/specs/a.md", "./b.md")).toEqual({
            rel: "docs/specs/b.md",
            line: null,
            anchor: null,
        });
    });

    it("walks up with ..", () => {
        expect(resolveDocLink("docs/specs/a.md", "../plans/p.md")).toEqual({
            rel: "docs/plans/p.md",
            line: null,
            anchor: null,
        });
    });

    it("resolves from a file at the repository root", () => {
        expect(resolveDocLink("README.md", "docs/x.md")).toEqual({ rel: "docs/x.md", line: null, anchor: null });
    });

    it("treats a leading slash as the repository root, as GitHub does", () => {
        expect(resolveDocLink("docs/a.md", "/README.md")).toEqual({ rel: "README.md", line: null, anchor: null });
    });

    it("lands on the first line of a GitHub line anchor", () => {
        expect(resolveDocLink("a.md", "src/x.go#L12-L20")).toEqual({ rel: "src/x.go", line: 12, anchor: null });
        expect(resolveDocLink("docs/a.md", "#L7")).toEqual({ rel: "docs/a.md", line: 7, anchor: null });
    });

    it("resolveDocLink keeps an in-page anchor", () => {
        expect(resolveDocLink("docs/a.md", "#the-final-stage")).toEqual({
            rel: "docs/a.md",
            line: null,
            anchor: "the-final-stage",
        });
    });

    it("carries a cross-file anchor", () => {
        expect(resolveDocLink("docs/a.md", "b.md#some-heading")).toEqual({
            rel: "docs/b.md",
            line: null,
            anchor: "some-heading",
        });
        expect(resolveDocLink("a.md", "b.md#caf%C3%A9")).toEqual({ rel: "b.md", line: null, anchor: "café" });
    });

    it("drops a query string and decodes escapes", () => {
        expect(resolveDocLink("a.md", "my%20notes.md?plain=1")).toEqual({
            rel: "my notes.md",
            line: null,
            anchor: null,
        });
    });

    it("leaves external links, empty anchors and empty hrefs alone", () => {
        for (const href of ["https://example.com/x.md", "mailto:a@b.c", "//cdn.example.com/x", "#", "", "C:\\x.md"]) {
            expect(resolveDocLink("docs/a.md", href), href).toBeNull();
        }
    });

    it("refuses a link that climbs above the repository root", () => {
        expect(resolveDocLink("a.md", "../outside.md")).toBeNull();
    });
});
