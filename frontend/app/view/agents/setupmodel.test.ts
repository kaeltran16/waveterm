// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    changedLineCount,
    editorDiscard,
    editorLoaded,
    editorReload,
    editorSaved,
    editorTyped,
    EMPTY_EDITOR,
    firstRunOffer,
    harnessRowLabel,
    harnessRows,
    harnessRowState,
    headerStatus,
    isDirty,
    isFirstRun,
    joinLabels,
    memoryNotices,
    saveBaseMtime,
    saveTargetCount,
    saveTargetNote,
    sharedZoneStatus,
    type HarnessDoc,
    type HarnessRow,
} from "./setupmodel";

function doc(over: Partial<HarnessDoc> = {}): HarnessDoc {
    return { present: true, own: "", shared: "", memory: "", state: "absent", mtime: 100, carried: 0, ...over };
}

function row(runtime: string, over: Partial<HarnessRow> = {}, d: Partial<HarnessDoc> = {}): HarnessRow {
    return { runtime, label: runtime.toUpperCase(), present: true, path: `/h/${runtime}.md`, doc: doc(d), ...over };
}

describe("harnessRowState", () => {
    it("reads a current region as in sync", () => {
        expect(harnessRowState(true, doc({ state: "current" }), false)).toBe("in-sync");
    });

    it("reads a stale region as out of date, even with own rules", () => {
        expect(harnessRowState(true, doc({ state: "stale", carried: 3 }), false)).toBe("out-of-date");
    });

    it("reports own rules ahead of a current region", () => {
        const d = doc({ state: "current", carried: 4 });
        expect(harnessRowState(true, d, false)).toBe("own-rules");
        expect(harnessRowLabel("own-rules", 4)).toBe("Has 4 own lines");
        expect(harnessRowLabel("own-rules", 1)).toBe("Has 1 own line");
    });

    it("reads a memory region with no steering region as old memory only", () => {
        expect(harnessRowState(true, doc({ state: "absent", memory: "<!-- ARC-MEMORY:BEGIN -->\nx" }), false)).toBe(
            "memory-only"
        );
    });

    it("keeps in sync when a current file also carries old memory", () => {
        expect(harnessRowState(true, doc({ state: "current", memory: "m" }), false)).toBe("in-sync");
    });

    it("reads a present harness with no file as no file yet", () => {
        expect(harnessRowState(true, doc({ mtime: 0 }), false)).toBe("no-file");
    });

    it("reads a file with no region as out of date once a shared doc exists", () => {
        expect(harnessRowState(true, doc({ mtime: 5 }), false)).toBe("out-of-date");
        expect(harnessRowState(true, doc({ mtime: 5 }), true)).toBe("no-file");
    });

    it("reads a missing harness as not set up", () => {
        expect(harnessRowState(false, doc({ present: false, state: "current" }), false)).toBe("not-set-up");
        expect(harnessRowLabel("not-set-up", 0)).toBe("Not set up");
    });
});

describe("harnessRows", () => {
    it("keeps the status order and joins each harness's file read", () => {
        const rows = harnessRows(
            [
                { runtime: "claude", label: "Claude Code", present: true } as AgentSyncHarness,
                { runtime: "pi", label: "Pi", present: false } as AgentSyncHarness,
            ],
            { claude: { runtime: "claude", path: "/c/CLAUDE.md", ...doc() } }
        );
        expect(rows.map((r) => r.runtime)).toEqual(["claude", "pi"]);
        expect(rows[0].path).toBe("/c/CLAUDE.md");
        expect(rows[1].doc).toBeNull();
    });
});

describe("saveTargetCount", () => {
    it("counts the present harnesses whatever their state", () => {
        const rows = [
            row("claude", {}, { state: "current" }),
            row("codex", {}, { state: "stale" }),
            row("opencode", { present: false }),
            row("pi", {}, { mtime: 0 }),
        ];
        expect(saveTargetCount(rows)).toBe(3);
    });
});

describe("saveTargetNote", () => {
    it("names own rules and old memory", () => {
        expect(saveTargetNote(doc())).toBe("no own rules");
        expect(saveTargetNote(doc({ memory: "m" }))).toBe("+ old memory");
        expect(saveTargetNote(doc({ carried: 2, memory: "m" }))).toBe("2 own lines + old memory");
    });
});

describe("first run", () => {
    it("applies while the saved shared doc is empty and no fresh page was opened", () => {
        expect(isFirstRun("", false)).toBe(true);
        expect(isFirstRun("  \n", false)).toBe(true);
        expect(isFirstRun("", true)).toBe(false);
        expect(isFirstRun("# rules", false)).toBe(false);
    });

    it("offers the harness with the most own lines", () => {
        const rows = [
            row("claude", {}, { carried: 63, own: "# Personal" }),
            row("codex", {}, { carried: 70 }),
            row("pi", {}, { carried: 2 }),
        ];
        expect(firstRunOffer(rows)).toMatchObject({ runtime: "codex", lines: 70 });
    });

    it("previews the region an earlier sync left, after any own rules", () => {
        const region = row("claude", {}, { carried: 2, shared: "\r\n# Prefs\r\n- arc rule\r" });
        expect(firstRunOffer([region])?.rules).toBe("# Prefs\r\n- arc rule");
        const both = row("claude", {}, { carried: 3, own: "- mine\n", shared: "- arc rule" });
        expect(firstRunOffer([both])?.rules).toBe("- mine\n\n- arc rule");
    });

    it("breaks a tie by row order", () => {
        const rows = [row("claude", {}, { carried: 5 }), row("codex", {}, { carried: 5 })];
        expect(firstRunOffer(rows)?.runtime).toBe("claude");
    });

    it("offers nothing when no present harness holds rules", () => {
        const rows = [row("claude"), row("codex", { present: false }, { carried: 9 })];
        expect(firstRunOffer(rows)).toBeNull();
    });

    it("lists the present harnesses whose file carries old memory, with its size", () => {
        const rows = [row("claude"), row("codex", {}, { memory: "é" }), row("pi", { present: false }, { memory: "m" })];
        expect(memoryNotices(rows)).toEqual([{ runtime: "codex", label: "CODEX", bytes: 2 }]);
    });

    it("counts the harnesses that get none of the rules", () => {
        const rows = [row("claude", {}, { carried: 63 }), row("codex"), row("pi"), row("oc", { present: false })];
        expect(headerStatus(rows, true)).toEqual({ text: "2 of 3 harnesses get none of your rules", tone: "warn" });
    });
});

describe("headerStatus", () => {
    it("reports every present harness in sync", () => {
        const rows = [row("claude", {}, { state: "current" }), row("pi", { present: false })];
        expect(headerStatus(rows, false)).toEqual({ text: "1 harness in sync", tone: "ok" });
    });

    it("counts the harnesses behind the shared doc", () => {
        const rows = [row("claude", {}, { state: "current" }), row("codex", {}, { state: "stale" })];
        expect(headerStatus(rows, false)).toEqual({ text: "1 of 2 harnesses out of date", tone: "warn" });
    });
});

describe("sharedZoneStatus", () => {
    it("names the line count when current and asks for a save when stale", () => {
        expect(sharedZoneStatus(doc({ state: "current", shared: "a\nb\n" })).text).toBe("Same as shared · 2 lines");
        expect(sharedZoneStatus(doc({ state: "stale" })).text).toBe("Out of date: save the shared doc to update");
    });
});

describe("changedLineCount", () => {
    it("is zero for an untouched draft", () => {
        expect(changedLineCount("a\nb", "a\nb")).toBe(0);
    });

    it("counts an edited line once and an insertion without shifting the rest", () => {
        expect(changedLineCount("a\nb\nc", "a\nB\nc")).toBe(1);
        expect(changedLineCount("a\nb\nc", "x\na\nb\nc")).toBe(1);
    });
});

describe("editor conflict transitions", () => {
    const loaded = editorReload("v1", 10);

    it("saves with the read mtime, and with 0 on overwrite", () => {
        expect(saveBaseMtime(loaded, false)).toBe(10);
        expect(saveBaseMtime(loaded, true)).toBe(0);
    });

    it("a clean save rebases the draft on what was written", () => {
        const typed = editorTyped(loaded, "v2");
        expect(isDirty(typed)).toBe(true);
        const saved = editorSaved(typed, "v2", { mtime: 20, conflict: false });
        expect(saved).toEqual({ base: "v2", mtime: 20, draft: "v2", conflict: false });
        expect(isDirty(saved)).toBe(false);
    });

    it("a conflict keeps the draft and the old mtime", () => {
        const typed = editorTyped(loaded, "v2");
        const c = editorSaved(typed, "v2", { mtime: 30, conflict: true });
        expect(c).toEqual({ base: "v1", mtime: 10, draft: "v2", conflict: true });
        // a plain retry still sends the stale mtime; only overwrite skips the guard
        expect(saveBaseMtime(c, false)).toBe(10);
        expect(saveBaseMtime(c, true)).toBe(0);
    });

    it("overwrite after a conflict clears it", () => {
        const c = editorSaved(editorTyped(loaded, "v2"), "v2", { mtime: 30, conflict: true });
        expect(editorSaved(c, "v2", { mtime: 40, conflict: false })).toEqual({
            base: "v2",
            mtime: 40,
            draft: "v2",
            conflict: false,
        });
    });

    it("reload after a conflict loses the draft", () => {
        expect(editorReload("disk", 30)).toEqual({ base: "disk", mtime: 30, draft: "disk", conflict: false });
    });

    it("a background read passes an outside edit through a clean editor", () => {
        expect(editorLoaded(loaded, "theirs", 50)).toEqual({
            base: "theirs",
            mtime: 50,
            draft: "theirs",
            conflict: false,
        });
        expect(editorLoaded(EMPTY_EDITOR, "x", 1).draft).toBe("x");
    });

    it("a background read under a draft keeps the old mtime when the text changed, so the save still conflicts", () => {
        const typed = editorTyped(loaded, "mine");
        const after = editorLoaded(typed, "theirs", 50);
        expect(after).toEqual(typed);
        expect(saveBaseMtime(after, false)).toBe(10);
    });

    it("a background read under a draft takes the new mtime when only the rest of the file moved", () => {
        const after = editorLoaded(editorTyped(loaded, "mine"), "v1", 50);
        expect(after).toEqual({ base: "v1", mtime: 50, draft: "mine", conflict: false });
    });

    it("discard drops the draft and the conflict", () => {
        const c = editorSaved(editorTyped(loaded, "v2"), "v2", { mtime: 30, conflict: true });
        expect(editorDiscard(c)).toEqual({ base: "v1", mtime: 10, draft: "v1", conflict: false });
    });
});

describe("joinLabels", () => {
    it("reads as a sentence list", () => {
        expect(joinLabels([])).toBe("");
        expect(joinLabels(["Pi"])).toBe("Pi");
        expect(joinLabels(["Codex", "OpenCode", "Pi"])).toBe("Codex, OpenCode and Pi");
    });
});
