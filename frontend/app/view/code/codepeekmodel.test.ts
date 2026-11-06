// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { NOT_TRACKED } from "./codeclassify";
import {
    binaryPeekMessage,
    initialPeekMode,
    PEEK_PREFERRED_PX,
    peekModes,
    peekPlacement,
    peekRow,
    peekStat,
    resolvePeekPath,
    type PeekFile,
    type PeekGit,
    type PeekHead,
} from "./codepeekmodel";

const open = { projectPath: "C:\\repo", rel: "a.ts" };

function textFile(git: PeekGit, text = "x\n"): PeekFile {
    return { kind: "text", text, git, open };
}

function repo(head: PeekHead, change: { adds: number; dels: number } | null): PeekGit {
    return { kind: "repo", root: "C:\\repo", rel: "a.ts", head, change };
}

const fifteenLines = Array.from({ length: 15 }, (_, i) => `line ${i}`).join("\n") + "\n";

describe("resolvePeekPath", () => {
    const HOME = "C:/Users/me";
    it("joins a relative path onto a drive cwd with backslashes", () => {
        expect(resolvePeekPath("docs/a.md", "C:\\repo", "")).toBe("C:\\repo\\docs\\a.md");
    });
    it("normalizes .. against a drive cwd", () => {
        expect(resolvePeekPath("..\\b.ts", "C:\\repo\\sub", "")).toBe("C:\\repo\\b.ts");
    });
    it("normalizes . segments", () => {
        expect(resolvePeekPath("./x/./y.ts", "C:\\repo", "")).toBe("C:\\repo\\x\\y.ts");
    });
    it("takes a forward-slash drive path as absolute", () => {
        expect(resolvePeekPath("D:/other/x.ts", "C:\\repo", "")).toBe("D:\\other\\x.ts");
    });
    it("takes a backslash drive path as absolute", () => {
        expect(resolvePeekPath("D:\\other\\x.ts", null, "")).toBe("D:\\other\\x.ts");
    });
    it("joins under a UNC cwd with backslashes", () => {
        expect(resolvePeekPath("a/b.ts", "\\\\srv\\share\\repo", "")).toBe("\\\\srv\\share\\repo\\a\\b.ts");
    });
    it("keeps a UNC root when .. climbs past it", () => {
        expect(resolvePeekPath("..\\..\\x.ts", "\\\\srv\\share\\repo", "")).toBe("\\\\srv\\share\\x.ts");
    });
    it("keeps a POSIX absolute path", () => {
        expect(resolvePeekPath("/x/y", "/home/me", "")).toBe("/x/y");
    });
    it("joins under a POSIX cwd with forward slashes", () => {
        expect(resolvePeekPath("src/../a.ts", "/home/me", "")).toBe("/home/me/a.ts");
    });
    it("never climbs above a drive root", () => {
        expect(resolvePeekPath("..\\..\\a.ts", "C:\\repo", "")).toBe("C:\\a.ts");
    });
    it("gives null for a relative path with no cwd", () => {
        expect(resolvePeekPath("docs/a.md", null, HOME)).toBeNull();
        expect(resolvePeekPath("docs/a.md", "", HOME)).toBeNull();
    });
    it("expands a ~ path against home, with either separator", () => {
        expect(resolvePeekPath("~/a.md", "C:\\repo", HOME)).toBe("C:\\Users\\me\\a.md");
        expect(resolvePeekPath("~\\src\\B.java", null, HOME)).toBe("C:\\Users\\me\\src\\B.java");
        expect(resolvePeekPath("~/a.md", null, "/home/me")).toBe("/home/me/a.md");
    });
    it("joins a relative path onto a ~ cwd expanded against home", () => {
        expect(resolvePeekPath("a.md", "~", HOME)).toBe("C:\\Users\\me\\a.md");
        expect(resolvePeekPath("a.md", "~/repo", HOME)).toBe("C:\\Users\\me\\repo\\a.md");
    });
    it("gives null for a ~ path or ~ cwd when home is unknown", () => {
        expect(resolvePeekPath("~/a.md", "C:\\repo", "")).toBeNull();
        expect(resolvePeekPath("a.md", "~/repo", "")).toBeNull();
    });
    it("gives null for a ~user path, which names another user's home", () => {
        expect(resolvePeekPath("~bob/a.md", "C:\\repo", HOME)).toBeNull();
    });
});

describe("initialPeekMode", () => {
    it("opens markdown on preview and anything else on source", () => {
        expect(initialPeekMode("x.md")).toBe("preview");
        expect(initialPeekMode("x.ts")).toBe("source");
    });
});

describe("peekModes", () => {
    const head = { kind: "text" as const, text: "x\n" };
    it("disables preview for a non-markdown file", () => {
        const m = peekModes("C:\\repo\\a.ts", textFile(repo(head, null)));
        expect(m.preview).toEqual({ enabled: false, reason: "Preview is for markdown files" });
        expect(m.source.enabled).toBe(true);
        expect(m.diff.enabled).toBe(true);
    });
    it("enables all three for markdown in a repo", () => {
        const m = peekModes("C:\\repo\\a.md", textFile(repo(head, null)));
        expect([m.preview.enabled, m.source.enabled, m.diff.enabled]).toEqual([true, true, true]);
    });
    it("disables diff outside a repository", () => {
        const m = peekModes("C:\\plain\\a.md", textFile({ kind: "norepo" }));
        expect(m.diff).toEqual({ enabled: false, reason: NOT_TRACKED });
        expect(m.preview.enabled).toBe(true);
    });
    it("disables all three in every non-text state", () => {
        const states: PeekFile[] = [
            { kind: "loading" },
            { kind: "missing" },
            { kind: "binary", size: 10, open },
            { kind: "toolarge", size: 10, open },
            { kind: "error", message: "boom" },
            { kind: "nocwd" },
            { kind: "folder", open },
        ];
        for (const f of states) {
            const m = peekModes("C:\\repo\\a.md", f);
            expect([m.preview.enabled, m.source.enabled, m.diff.enabled]).toEqual([false, false, false]);
        }
    });
});

describe("peekStat", () => {
    const absent = { kind: "absent" as const };
    it("labels a staged new file with its numstat adds", () => {
        expect(peekStat(textFile(repo(absent, { adds: 15, dels: 0 }), fifteenLines))).toEqual({
            label: "new file",
            adds: 15,
        });
    });
    it("counts the lines of an untracked new file", () => {
        expect(peekStat(textFile(repo(absent, { adds: 0, dels: 0 }), fifteenLines))).toEqual({
            label: "new file",
            adds: 15,
        });
        expect(peekStat(textFile(repo(absent, null), fifteenLines))).toEqual({ label: "new file", adds: 15 });
    });
    it("counts a last line with no trailing newline", () => {
        expect(peekStat(textFile(repo(absent, null), "a\nb"))).toEqual({ label: "new file", adds: 2 });
    });
    it("reports a change's adds and dels", () => {
        expect(peekStat(textFile(repo({ kind: "text", text: "" }, { adds: 14, dels: 2 })))).toEqual({
            label: "",
            adds: 14,
            dels: 2,
        });
    });
    it("reads no changes for a tracked file with no entry", () => {
        expect(peekStat(textFile(repo({ kind: "text", text: "x\n" }, null)))).toEqual({ label: "no changes" });
    });
    it("gives no stat outside a repository or for a non-text state", () => {
        expect(peekStat(textFile({ kind: "norepo" }))).toBeNull();
        expect(peekStat({ kind: "loading" })).toBeNull();
    });
});

describe("peekRow", () => {
    it("gives the viewport row while the line is on screen", () => {
        expect(peekRow(50, 40, 30)).toBe(10);
        expect(peekRow(40, 40, 30)).toBe(0);
        expect(peekRow(69, 40, 30)).toBe(29);
    });
    it("gives null off screen", () => {
        expect(peekRow(39, 40, 30)).toBeNull();
        expect(peekRow(70, 40, 30)).toBeNull();
    });
});

describe("peekPlacement", () => {
    it("opens below at the preferred height when the room under the line fits it", () => {
        expect(peekPlacement({ lineTop: 0, lineHeight: 18, viewportHeight: 900 })).toEqual({
            side: "below",
            height: PEEK_PREFERRED_PX,
        });
    });
    it("opens above near the bottom, clamped to the room above", () => {
        const lineTop = 900 - 40;
        expect(peekPlacement({ lineTop, lineHeight: 18, viewportHeight: 900 })).toEqual({
            side: "above",
            height: Math.min(PEEK_PREFERRED_PX, lineTop),
        });
        expect(peekPlacement({ lineTop: 300, lineHeight: 18, viewportHeight: 340 })).toEqual({
            side: "above",
            height: 300,
        });
    });
    it("takes the larger side in a short viewport, clamped to its room", () => {
        // room below 300 - 160 - 18 = 122, room above 160
        expect(peekPlacement({ lineTop: 160, lineHeight: 18, viewportHeight: 300 })).toEqual({
            side: "above",
            height: 160,
        });
        // room below 300 - 100 - 18 = 182, room above 100
        expect(peekPlacement({ lineTop: 100, lineHeight: 18, viewportHeight: 300 })).toEqual({
            side: "below",
            height: 182,
        });
    });
});

describe("binaryPeekMessage", () => {
    it("binaryPeekMessage names an image and a plain binary", () => {
        expect(binaryPeekMessage("assets/logo.PNG")).toBe("Image — open it in Code");
        expect(binaryPeekMessage("bin/blob.bin")).toBe("Binary file");
    });
});
