// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { EditFile } from "@/app/view/agents/agentsviewmodel";
import { describe, expect, it } from "vitest";
import { NOT_TRACKED } from "./codeclassify";
import {
    binaryPeekMessage,
    initialPeekMode,
    PEEK_PREFERRED_PX,
    peekHeaderPath,
    peekModes,
    peekPlacement,
    peekRow,
    peekStat,
    resolvePeekPath,
    tabDiffBody,
    uniqueBareNameMatch,
    type PeekFile,
    type PeekGit,
    type PeekHead,
} from "./codepeekmodel";

const open = { projectPath: "C:\\repo", rel: "a.ts", inRepo: true };

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

describe("uniqueBareNameMatch", () => {
    const files = ["frontend/app/a.tsx", "pkg/b.go", "pkg/x/b.go", "c.md", "docs/xc.md"];
    it("finds the one file with that name at any depth", () => {
        expect(uniqueBareNameMatch("a.tsx", files)).toBe("frontend/app/a.tsx");
        expect(uniqueBareNameMatch("c.md", files)).toBe("c.md");
    });
    it("gives null when several files share the name, or none has it", () => {
        expect(uniqueBareNameMatch("b.go", files)).toBeNull();
        expect(uniqueBareNameMatch("z.ts", files)).toBeNull();
    });
    it("gives null for a path with a folder in it", () => {
        expect(uniqueBareNameMatch("app/a.tsx", files)).toBeNull();
        expect(uniqueBareNameMatch("app\\a.tsx", files)).toBeNull();
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
    // the tab's Source already shows a new file's every line; the card keeps its inserted-text Diff
    it("disables diff in the tab for a file new since HEAD, and keeps it on the card", () => {
        const fresh = textFile(repo({ kind: "absent" }, { adds: 1, dels: 0 }));
        expect(peekModes("C:\\repo\\a.ts", fresh, "tab").diff.enabled).toBe(false);
        expect(peekModes("C:\\repo\\a.ts", fresh, "card").diff.enabled).toBe(true);
        expect(peekModes("C:\\repo\\a.ts", fresh).diff.enabled).toBe(true);
    });
    it("enables diff in the tab and on the card for a changed tracked file", () => {
        const changed = textFile(repo(head, { adds: 1, dels: 1 }));
        expect(peekModes("C:\\repo\\a.ts", changed, "tab").diff.enabled).toBe(true);
        expect(peekModes("C:\\repo\\a.ts", changed, "card").diff.enabled).toBe(true);
        expect(peekModes("C:\\repo\\a.ts", changed).diff.enabled).toBe(true);
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
    it("reads a change with unknown line counts as uncounted, not as no changes", () => {
        const change = { adds: 0, dels: 0, lineCounts: false as const };
        expect(peekStat(textFile(repo({ kind: "text", text: "" }, change)))).toEqual({ label: "line counts unknown" });
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

describe("tabDiffBody", () => {
    const head: PeekHead = { kind: "text", text: "x\n" };
    // two hunks: the first adds line 13 and changes 14, the second adds line 40
    const entry: EditFile = {
        path: "internal/a.go",
        badge: "M",
        adds: 3,
        dels: 1,
        lines: [
            { sign: "", text: "@@ -12,3 +12,4 @@ func Normalize() {", hunk: true },
            { sign: "", text: "\tfor {", oldNo: 12, newNo: 12 },
            { sign: "+", text: "\t\t// long", newNo: 13 },
            { sign: "-", text: "\t\told()", oldNo: 13 },
            { sign: "+", text: "\t\tnew()", newNo: 14 },
            { sign: "", text: "@@ -38,1 +39,2 @@", hunk: true },
            { sign: "", text: "}", oldNo: 38, newNo: 39 },
            { sign: "+", text: "// end", newNo: 40 },
        ],
    };
    const read = (files: EditFile[], truncated = false) => ({ kind: "read" as const, files, truncated });

    it("gives the HEAD side's own message when HEAD cannot be read", () => {
        const body = tabDiffBody({ kind: "error", message: "binary at HEAD" }, read([entry]), "internal/a.go", 13);
        expect(body).toEqual({ kind: "head", message: "binary at HEAD" });
    });
    it("passes a failed read's own text through", () => {
        const body = tabDiffBody(head, { kind: "failed", message: "git: exit 128" }, "internal/a.go", 13);
        expect(body).toEqual({ kind: "error", message: "git: exit 128" });
    });
    it("stays loading while the read is in flight", () => {
        expect(tabDiffBody(head, { kind: "loading" }, "internal/a.go", 13)).toEqual({ kind: "loading" });
    });
    it("gives the file's hunks, landing on the cited added row", () => {
        const body = tabDiffBody(head, read([entry]), "internal/a.go", 13);
        expect(body.kind).toBe("hunks");
        if (body.kind !== "hunks") return;
        expect(body.hunks.map((h) => h.label)).toEqual(["func Normalize() {", "line 39"]);
        expect(body.hunks.map((h) => h.rows.length)).toEqual([4, 2]);
        expect(body.landOn).toBe(1);
    });
    it("counts the landing row across hunks", () => {
        const body = tabDiffBody(head, read([entry]), "internal/a.go", 40);
        expect(body.kind === "hunks" && body.landOn).toBe(5);
    });
    // 13 is also the removed row's old number: only a new-side number can be the cited line
    it("lands on no row for a line outside every hunk", () => {
        const body = tabDiffBody(head, read([entry]), "internal/a.go", 30);
        expect(body.kind === "hunks" && body.landOn).toBeNull();
        const none = tabDiffBody(head, read([entry]), "internal/a.go", null);
        expect(none.kind === "hunks" && none.landOn).toBeNull();
    });
    it("reads No line changes when the patch has no entry for the file", () => {
        expect(tabDiffBody(head, read([]), "internal/a.go", 13)).toEqual({ kind: "note", note: "empty" });
        expect(tabDiffBody(head, read([entry]), "internal/b.go", 13)).toEqual({ kind: "note", note: "empty" });
    });
    it("reads Too large when a truncated patch left the file out", () => {
        expect(tabDiffBody(head, read([], true), "internal/a.go", 13)).toEqual({ kind: "note", note: "toolarge" });
    });
    it("reads No line changes when the file's entry has no hunks", () => {
        const bare: EditFile = { ...entry, lines: [] };
        expect(tabDiffBody(head, read([bare]), "internal/a.go", 13)).toEqual({ kind: "note", note: "empty" });
    });
    it("reads Binary file when git says the file's patch is binary", () => {
        const bin: EditFile = { ...entry, lines: [], binary: true };
        expect(tabDiffBody(head, read([bin]), "internal/a.go", 13)).toEqual({ kind: "note", note: "binary" });
    });
});

describe("peekHeaderPath", () => {
    const abs = "C:\\repo\\docs\\shots\\stats-panel.png";
    const raw = "shots/stats-panel.png";
    function kinds(inRepo: boolean): PeekFile[] {
        const o = {
            projectPath: inRepo ? "C:\\repo" : "C:\\repo\\docs\\shots",
            rel: inRepo ? "docs/shots/stats-panel.png" : "stats-panel.png",
            inRepo,
        };
        return [
            { kind: "text", text: "x\n", git: { kind: "norepo" }, open: o },
            { kind: "binary", size: 10, open: o },
            { kind: "toolarge", size: 10, open: o },
            { kind: "folder", open: o },
        ];
    }
    it("is repo-relative for every kind of file inside a repository", () => {
        for (const file of kinds(true)) {
            expect(peekHeaderPath({ abs, raw, file })).toBe("docs/shots/stats-panel.png");
        }
    });
    it("is the absolute path for the same kinds outside a repository", () => {
        for (const file of kinds(false)) {
            expect(peekHeaderPath({ abs, raw, file })).toBe(abs);
        }
    });
    it("is the raw path when nothing resolved", () => {
        expect(peekHeaderPath({ abs: null, raw, file: { kind: "nocwd" } })).toBe(raw);
    });
    it("is the absolute path for a file with nothing to open", () => {
        expect(peekHeaderPath({ abs, raw, file: { kind: "missing" } })).toBe(abs);
    });
});
