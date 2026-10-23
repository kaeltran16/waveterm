// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/view/code/codestore", async (importOriginal) => {
    const { atom } = await import("jotai");
    return {
        ...(await importOriginal<typeof import("@/app/view/code/codestore")>()),
        // the outline is derived from a parsed buffer; a plain atom lets a test name the symbols
        codeOutlineAtom: atom<unknown[]>([]),
        openInCode: vi.fn(),
        goToLine: vi.fn(),
    };
});

import { globalStore } from "@/app/store/jotaiStore";
import type { AgentsViewModel } from "@/app/view/agents/agents";
import type { OutlineSymbol } from "@/app/view/code/codeoutline";
import {
    codeFileAtom,
    codeOutlineAtom,
    codePendingLineAtom,
    goToLine,
    openInCode,
    type CodeIndex,
} from "@/app/view/code/codestore";
import type { PrimitiveAtom } from "jotai";
import { assembleFileGroups, fileEcho, fileScopeGroups, type FileScopeInput } from "./palette-files";

const paths = [
    "frontend/app/cockpit/command-palette.tsx",
    "frontend/app/cockpit/palette-groups.ts",
    "frontend/app/cockpit/palette-scope.ts",
    "README.md",
];

describe("assembleFileGroups", () => {
    it("leads with recent files on an empty query, then the rest of the project", () => {
        const { groups } = assembleFileGroups("", paths, ["frontend/app/cockpit/palette-groups.ts"], "#waveterm", 50);
        expect(groups.map((g) => g.label)).toEqual(["Recent files", "Files in #waveterm"]);
        expect(groups[0].items.map((f) => f.base)).toEqual(["palette-groups.ts"]);
        expect(groups[1].items.map((f) => f.path)).not.toContain("frontend/app/cockpit/palette-groups.ts");
    });

    it("drops a recent file the index no longer lists", () => {
        const { groups } = assembleFileGroups("", paths, ["gone.ts"], "#w", 50);
        expect(groups.map((g) => g.key)).toEqual(["files"]);
    });

    it("parses path:line, ranking on the path and carrying the line", () => {
        const out = assembleFileGroups("groups:90", paths, [], "#w", 50);
        expect(out.text).toBe("groups");
        expect(out.line).toBe(90);
        expect(out.groups[0].items[0]).toEqual({
            path: "frontend/app/cockpit/palette-groups.ts",
            base: "palette-groups.ts",
            dir: "frontend/app/cockpit",
        });
    });

    it("returns no group when nothing matches", () => {
        expect(assembleFileGroups("zzzz", paths, [], "#w", 50).groups).toEqual([]);
    });

    it("splits a root-level file into an empty dir", () => {
        const { groups } = assembleFileGroups("readme", paths, [], "#w", 50);
        expect(groups[0].items[0]).toEqual({ path: "README.md", base: "README.md", dir: "" });
    });
});

describe("fileEcho", () => {
    it("names the file and the line", () => {
        const f = { path: "a/b.ts", base: "b.ts", dir: "a" };
        expect(fileEcho(f, 90)).toBe("Opens a/b.ts at line 90 in Code");
        expect(fileEcho(f, undefined)).toBe("Opens a/b.ts in Code");
    });
});

describe("fileScopeGroups", () => {
    const model = {} as AgentsViewModel;
    let close: ReturnType<typeof vi.fn>;
    const index = (p: string[]): CodeIndex => ({ paths: p, isRepo: true, truncated: false });
    const input = (over: Partial<FileScopeInput>): FileScopeInput => ({
        query: "",
        surface: "agent",
        target: { name: "waveterm", path: "C:/src/waveterm" },
        index: index(paths),
        error: undefined,
        history: null,
        ...over,
    });
    const run = (over: Partial<FileScopeInput>) => fileScopeGroups(input(over), { model, close });
    const emptyText = (over: Partial<FileScopeInput>) => run(over).groups[0].emptyText;

    beforeEach(() => {
        vi.clearAllMocks();
        close = vi.fn();
        globalStore.set(codeFileAtom, { kind: "none" });
        globalStore.set(codeOutlineAtom as unknown as PrimitiveAtom<OutlineSymbol[]>, []);
    });

    it("says why there is nothing to list yet", () => {
        expect(emptyText({ target: null })).toBe("No project to search. Pick one on Code or in the cockpit.");
        expect(emptyText({ error: "denied" })).toBe("Couldn’t list files in #waveterm: denied");
        expect(emptyText({ index: undefined })).toBe("Loading files in #waveterm…");
    });

    it("rows a file by its name, its folder and line as meta, and opens it in Code", () => {
        const out = run({ query: "groups:90" });
        expect(out.fileHighlight).toBe("groups");
        expect(out.groups[0].label).toBe("Files in #waveterm");
        expect(out.groups[0].items[0]).toMatchObject({
            key: "file:frontend/app/cockpit/palette-groups.ts",
            kind: "file",
            search: "",
            title: "palette-groups.ts",
            meta: "frontend/app/cockpit  :90",
            verb: "Open",
            echo: "Opens frontend/app/cockpit/palette-groups.ts at line 90 in Code",
        });
        out.groups[0].items[0].run();
        expect(close).toHaveBeenCalled();
        expect(vi.mocked(openInCode).mock.calls[0][1]).toEqual({
            projectPath: "C:/src/waveterm",
            rel: "frontend/app/cockpit/palette-groups.ts",
            line: 90,
        });
    });

    it("leads with Code's recent files when Code has the project open", () => {
        const history = {
            stack: [
                { path: "README.md", line: null },
                { path: "frontend/app/cockpit/palette-scope.ts", line: null },
            ],
            idx: 1,
        };
        const out = run({ history });
        expect(out.groups[0]).toMatchObject({ key: "recent-files", label: "Recent files" });
        expect(out.groups[0].items.map((it) => it.title)).toEqual(["README.md"]);
        expect(run({}).groups.map((g) => g.key)).not.toContain("recent-files");
    });

    it("reads a bare :line on Code as a line of the open file", () => {
        const out = run({ query: ":152", surface: "code" });
        expect(out.groups[0]).toMatchObject({ key: "line", label: "Open file" });
        expect(out.groups[0].items[0]).toMatchObject({
            kind: "line",
            title: "Line 152 of the open file",
            verb: "Go to",
            echo: "Moves the open file to line 152",
        });
        out.groups[0].items[0].run();
        expect(globalStore.get(codePendingLineAtom)).toBe(152);
        expect(run({ query: ":152" }).groups.map((g) => g.key)).not.toContain("line");
    });

    it("quotes only the path part when no file matches", () => {
        expect(run({ query: "zzzz:3" }).groups).toEqual([
            { key: "empty", label: "Files", items: [], emptyText: "No files match “zzzz”." },
        ]);
    });

    it("lists the open file's symbols on Code after @", () => {
        expect(emptyText({ query: "@x" })).toBe("Open a file on Code to list its symbols.");
        globalStore.set(codeFileAtom, { kind: "text", path: "src/app.ts", text: "", size: 0, modtime: 0 });
        expect(emptyText({ query: "@x", surface: "code" })).toBe("No symbols found in app.ts.");
        globalStore.set(codeOutlineAtom as unknown as PrimitiveAtom<OutlineSymbol[]>, [
            { name: "render", kind: "func", line: 12, depth: 0 },
        ]);
        expect(emptyText({ query: "@zzz", surface: "code" })).toBe("No symbol matches “zzz”.");
        const out = run({ query: "@ren", surface: "code" });
        expect(out.fileHighlight).toBe("ren");
        expect(out.groups[0]).toMatchObject({ key: "symbols", label: "Symbols in app.ts" });
        expect(out.groups[0].items[0]).toMatchObject({
            key: "symbol:12:render",
            kind: "symbol",
            title: "render",
            meta: ":12",
            verb: "Go to",
            echo: "Moves app.ts to render, line 12",
        });
        out.groups[0].items[0].run();
        expect(goToLine).toHaveBeenCalledWith(12);
        expect(close).toHaveBeenCalled();
    });
});
