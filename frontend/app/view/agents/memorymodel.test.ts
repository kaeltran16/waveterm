// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    cleanupDetail,
    didLines,
    diffLabel,
    digest,
    emptyText,
    firstRowKey,
    focusOrder,
    keepIds,
    kindLabel,
    kindTone,
    rowButtons,
    splitCounts,
    splitItemChip,
    splitList,
    splitState,
    spotCheck,
    stepFocus,
    waitingRows,
    waitingStatus,
    type WaitingRow,
} from "./memorymodel";

// local-time stamps, so the day names don't depend on the machine's zone
const NOW = new Date(2026, 9, 14, 18, 0).getTime();
const CHECKED = new Date(2026, 9, 14, 9, 12).getTime();
const NEXT = new Date(2026, 9, 21, 9, 12).getTime();

const SHARED_FOLDER = "C:/Users/me/.claude/projects/C--Users-me-src-SIEM/memory";
const SPLIT_PATH = "C:\\Users\\me\\src\\SIEM\\src\\cyber_ai\\cyber_assistant";

function op(over: Partial<MemOp> = {}): MemOp {
    return {
        folder: "",
        memories: [],
        old: "",
        new: "",
        indexremove: [],
        indexadd: "",
        indexfolder: "",
        writename: "",
        writebody: "",
        docpath: "",
        docsection: "",
        docpassage: "",
        tofolder: "",
        settingspath: "",
        settingsvalue: "",
        stripharvester: false,
        ...over,
    };
}

function change(id: string, over: Partial<MemChange> = {}): MemChange {
    return {
        id,
        kind: "trim",
        group: "",
        title: id,
        note: "",
        applylabel: "Apply trim",
        effect: "",
        files: [],
        evidence: [],
        diffs: [],
        indexdelta: { lines: 0, bytes: 0 },
        ownindexdelta: { lines: 0, bytes: 0 },
        op: op(),
        status: "open",
        conflictfile: "",
        decidedat: 0,
        backupuntil: 0,
        applyid: "",
        ...over,
    };
}

function project(over: Partial<MemHygieneProject> = {}): MemHygieneProject {
    return {
        project: "waveterm",
        path: "C:\\Users\\me\\src\\waveterm",
        checkedat: CHECKED,
        nextcheckat: NEXT,
        checking: false,
        lasterror: "",
        memories: 69,
        sessions: 1232,
        folder: "C:/Users/me/.claude/projects/C--Users-me-src-waveterm/memory",
        sharedwith: [],
        ownfolder: "",
        formershared: "",
        switchedat: 0,
        index: { exists: true, lines: 89, bytes: 12561 },
        changes: [],
        ...over,
    };
}

function splitProject(changes: MemChange[], over: Partial<MemHygieneProject> = {}): MemHygieneProject {
    return project({
        project: "cyber_assistant",
        path: SPLIT_PATH,
        memories: 198,
        sessions: 12,
        folder: SHARED_FOLDER,
        sharedwith: ["cyber_anomaly_detector", "MP-Frontend"],
        ownfolder: "C:/Users/me/.claude/projects/C--Users-me-src-SIEM-src-cyber_ai-cyber_assistant/memory",
        index: { exists: true, lines: 134, bytes: 16768 },
        ownindex: { exists: false, lines: 0, bytes: 0 },
        changes,
        ...over,
    });
}

const settings = (status = "open") =>
    change("s1", {
        kind: "settings",
        group: "switch",
        status,
        op: op({ settingspath: `${SPLIT_PATH}\\.claude\\settings.local.json` }),
    });

describe("kindTone", () => {
    it("sets removals apart from additions and edits in place", () => {
        expect(["delete", "remove-shared"].map(kindTone)).toEqual(["remove", "remove"]);
        expect(["move-here", "copy-here", "add-to-index", "move-to-doc"].map(kindTone)).toEqual([
            "add",
            "add",
            "add",
            "add",
        ]);
        expect(["trim", "merge", "settings"].map(kindTone)).toEqual(["edit", "edit", "edit"]);
    });
});

describe("kindLabel", () => {
    it("labels each kind, naming the doc target and the shared repo", () => {
        const p = splitProject([]);
        expect(
            kindLabel(p, change("1", { kind: "move-to-doc", op: op({ docpath: "C:\\src\\waveterm\\CLAUDE.md" }) }))
        ).toBe("Move to CLAUDE.md");
        expect(kindLabel(p, change("1", { kind: "remove-shared" }))).toBe("Remove from SIEM");
        expect(kindLabel(p, change("1", { kind: "add-to-index" }))).toBe("Add to index");
        expect(kindLabel(p, settings())).toBe("Settings");
    });

    it("names the shared repo for a removal after the switch-over moved the folder", () => {
        const p = project({ path: SPLIT_PATH, folder: "D:/own/memory", formershared: SHARED_FOLDER });
        expect(kindLabel(p, change("1", { kind: "remove-shared" }))).toBe("Remove from SIEM");
    });
});

describe("diffLabel", () => {
    it("F21: a diff header names MEMORY.md by its role, on either separator", () => {
        const p = splitProject([]);
        const back = (s: string) => s.replace(/\//g, "\\");
        expect(diffLabel(p, `${SHARED_FOLDER}/MEMORY.md`)).toBe("SIEM’s MEMORY.md");
        expect(diffLabel(p, back(`${SHARED_FOLDER}/MEMORY.md`))).toBe("SIEM’s MEMORY.md");
        expect(diffLabel(p, `${p.ownfolder}/MEMORY.md`)).toBe("cyber_assistant’s MEMORY.md");
        expect(diffLabel(p, back(`${p.ownfolder}/MEMORY.md`))).toBe("cyber_assistant’s MEMORY.md");
        expect(diffLabel(p, back(`${SHARED_FOLDER}/split-a-build.md`))).toBe("split-a-build.md");
        expect(diffLabel(p, "C:/x/settings.local.json")).toBe("settings.local.json");
        expect(diffLabel(project(), "MEMORY.md")).toBe("MEMORY.md");
        const switched = project({ path: SPLIT_PATH, folder: "D:/own/memory", formershared: SHARED_FOLDER });
        expect(diffLabel(switched, `${SHARED_FOLDER}/MEMORY.md`)).toBe("SIEM’s MEMORY.md");
    });
});

// the one-page tab: the FlowAuto board's projects, with local-time stamps
const FLOW_NOW = new Date(2026, 10, 25, 10, 0).getTime();
const FLOW_CHECKED = new Date(2026, 10, 18, 9, 0).getTime();
const FLOW_NEXT = new Date(2026, 10, 30, 9, 0).getTime();
const SIEM_SRC = "C:\\Users\\me\\src\\SIEM\\src";
const DAY = 24 * 60 * 60 * 1000;

function names(prefix: string, n: number): string[] {
    return Array.from({ length: n }, (_, i) => `${prefix}-${i}.md`);
}

function shared(id: string, n: number, kind = "move-here", status = "open"): MemChange {
    return change(id, { kind, group: "shared", title: `${id} title`, status, op: op({ memories: names(id, n) }) });
}

// a project sharing SIEM's 177 memories, with one shared change per count given
function sharing(name: string, moves: number[], copies: number[], over: Partial<MemHygieneProject> = {}) {
    return project({
        project: name,
        path: `${SIEM_SRC}\\${name}`,
        checkedat: FLOW_CHECKED,
        nextcheckat: FLOW_NEXT,
        memories: 177,
        folder: SHARED_FOLDER,
        sharedwith: ["others"],
        ownfolder: `C:/own/${name}`,
        changes: [
            ...moves.map((n, i) => shared(`m${i}`, n)),
            ...copies.map((n, i) => shared(`c${i}`, n, "copy-here")),
            settings(),
        ],
        ...over,
    });
}

function removal(id: string, n: number, status = "open"): MemChange {
    return change(id, {
        kind: "remove-shared",
        title: `${id} title`,
        status,
        op: op({ folder: SHARED_FOLDER, memories: names(id, n) }),
    });
}

function docMove(id: string, title: string, status = "open"): MemChange {
    return change(id, {
        kind: "move-to-doc",
        title,
        status,
        op: op({ docpath: `${SIEM_SRC}\\cyber_anomaly_detector\\CLAUDE.md` }),
    });
}

const detector = (over: Partial<MemHygieneProject> = {}) =>
    project({
        project: "cyber_anomaly_detector",
        path: `${SIEM_SRC}\\cyber_anomaly_detector`,
        checkedat: new Date(2026, 10, 17, 16, 46).getTime(),
        nextcheckat: FLOW_NEXT,
        lasterror: "Check interrupted by a restart",
        folder: "C:/own/cyber_anomaly_detector",
        ownfolder: "C:/own/cyber_anomaly_detector",
        formershared: SHARED_FOLDER,
        switchedat: new Date(2026, 10, 3, 12, 0).getTime(),
        changes: [
            removal("r1", 1),
            removal("r2", 5),
            removal("r3", 1, "kept"),
            removal("r4", 2, "conflict"),
            docMove("d1", "Configurable-numbers rule belongs in the repo doc"),
            docMove("d2", "MP contract test parses detector migrations: repo rule"),
            docMove("d3", "kept doc move", "kept"),
        ],
        ...over,
    });

function flowAuto(): MemHygieneProject[] {
    return [
        // only routine conflicts left: the next check's, not the user's
        project({
            changes: [change("t1", { status: "conflict" }), change("t2", { kind: "merge", status: "conflict" })],
        }),
        sharing("MP-Frontend", [1, 1, 51], [1, 37]),
        sharing("cyber_assistant", [24], [39]),
        sharing("kept_sharing", [], [], { changes: [shared("m0", 3), settings("kept")] }),
        sharing("universal_parser_config_generator", [2], [29]),
        detector(),
    ];
}

describe("waitingRows", () => {
    it("FlowAuto: splits, the cleanup, doc moves, then the failed check, each with the board's lines", () => {
        expect(waitingRows(flowAuto())).toEqual([
            {
                key: "split/MP-Frontend",
                kind: "split",
                project: "MP-Frontend",
                changeId: "",
                chip: "Own memory",
                title: "Give MP-Frontend its own memory",
                sub: "91 come over: 53 move, 38 copy · 86 stay in SIEM’s",
            },
            {
                key: "split/cyber_assistant",
                kind: "split",
                project: "cyber_assistant",
                changeId: "",
                chip: "Own memory",
                title: "Give cyber_assistant its own memory",
                sub: "63 come over: 24 move, 39 copy · 114 stay in SIEM’s",
            },
            {
                key: "split/universal_parser_config_generator",
                kind: "split",
                project: "universal_parser_config_generator",
                changeId: "",
                chip: "Own memory",
                title: "Give universal_parser_config_generator its own memory",
                sub: "31 come over: 2 move, 29 copy · 146 stay in SIEM’s",
            },
            {
                key: "cleanup/cyber_anomaly_detector",
                kind: "cleanup",
                project: "cyber_anomaly_detector",
                changeId: "",
                chip: "Clear",
                title: "Clear 6 memories no project loads from SIEM’s memory",
                sub: "cyber_anomaly_detector took them on Nov 3",
            },
            {
                key: "doc/cyber_anomaly_detector/d1",
                kind: "doc",
                project: "cyber_anomaly_detector",
                changeId: "d1",
                chip: "Move to CLAUDE.md",
                title: "Configurable-numbers rule belongs in the repo doc",
                sub: "cyber_anomaly_detector · edits CLAUDE.md in your working tree",
            },
            {
                key: "doc/cyber_anomaly_detector/d2",
                kind: "doc",
                project: "cyber_anomaly_detector",
                changeId: "d2",
                chip: "Move to CLAUDE.md",
                title: "MP contract test parses detector migrations: repo rule",
                sub: "cyber_anomaly_detector · edits CLAUDE.md in your working tree",
            },
            {
                key: "failed/cyber_anomaly_detector",
                kind: "failed",
                project: "cyber_anomaly_detector",
                changeId: "",
                chip: "Check failed",
                title: "cyber_anomaly_detector’s last check failed",
                sub: "Check interrupted by a restart · checked Nov 17 at 16:46",
            },
        ]);
        expect(waitingStatus(flowAuto())).toEqual({ text: "7 waiting for you · 1 check failed", tone: "warn" });
    });

    it("leaving a memory out moves it from come over to stay", () => {
        const p = sharing("MP-Frontend", [1, 1, 51], [1, 37]);
        p.changes[0].status = "kept";
        expect(splitCounts(p)).toEqual({
            comeOver: 90,
            move: 52,
            copy: 38,
            stay: 87,
            leftOut: 1,
            here: 0,
            total: 90,
            changed: 0,
        });
        expect(waitingRows([p])[0].sub).toBe("90 come over · 1 left out · 87 stay in SIEM’s");
    });

    it("a switched split, and removals and doc moves not open, give no row", () => {
        const switched = sharing("MP-Frontend", [], [], {
            changes: [shared("m0", 1, "move-here", "applied"), settings("applied")],
        });
        const decided = detector({
            lasterror: "",
            changes: [removal("r1", 1, "applied"), removal("r2", 1, "conflict"), docMove("d1", "x", "conflict")],
        });
        expect(waitingRows([switched, decided])).toEqual([]);
    });

    it("with nothing waiting, says so and names the earliest next check's day", () => {
        const ps = [
            project({ nextcheckat: FLOW_NEXT + DAY }),
            project({ project: "b", nextcheckat: FLOW_NEXT }),
            project({ project: "c", nextcheckat: 0 }),
        ];
        expect(waitingStatus(ps)).toEqual({ text: "Nothing waits for you", tone: "ok" });
        expect(emptyText(ps)).toBe("Nothing waits for you. The next check runs Monday, Nov 30.");
        expect(emptyText([project({ nextcheckat: 0 })])).toBe("Nothing waits for you.");
    });

    it.each([
        ["the drive letter's case", { folder: "C:/Users/me/.claude/projects/c--users-me-src-siem/memory" }, "SIEM’s"],
        ["a folder no ancestor slugs to, by its own name", { folder: "D:/mem/team-notes" }, "team-notes’s"],
        ["a trailing separator on the folder", { folder: `${SHARED_FOLDER}/` }, "SIEM’s"],
        ["a doubled separator", { folder: SHARED_FOLDER.replace("/memory", "//memory") }, "SIEM’s"],
        ["a project at the repo's root", { path: "C:\\Users\\me\\src\\SIEM" }, "SIEM’s"],
        [
            "every trailing separator on the path",
            {
                path: "C:\\Users\\me\\src\\SIEM\\\\",
                folder: "C:/Users/me/.claude/projects/C--Users-me-src-SIEM-/memory",
            },
            "C--Users-me-src-SIEM-’s",
        ],
        ["an empty folder, as empty", { folder: "" }, "’s"],
    ])("names the shared repo whatever %s", (_name, over: Partial<MemHygieneProject>, want) => {
        expect(waitingRows([splitProject([settings()], over)])[0].sub.replace(/^.* stay in /, "")).toBe(want);
    });

    it("a memhygiene address lands on its project's first waiting row, or none", () => {
        const ps = flowAuto();
        expect(firstRowKey(ps, "cyber_anomaly_detector")).toBe("cleanup/cyber_anomaly_detector");
        expect(firstRowKey(ps, "MP-Frontend")).toBe("split/MP-Frontend");
        expect(firstRowKey(ps, "waveterm")).toBeNull();
    });
});

describe("a waiting row's buttons", () => {
    const ctx = (over: Partial<{ applying: boolean; busy: boolean; result: MemRowResult | null }> = {}) => ({
        applying: false,
        busy: false,
        result: null,
        ...over,
    });
    const splitBatch: MemBatch = {
        id: "sb",
        kind: "split",
        at: 0,
        changeids: [],
        skipped: [],
        indexbefore: { exists: true, lines: 0, bytes: 0 },
        indexafter: { exists: true, lines: 0, bytes: 0 },
    };
    const at = (here: number, rest: MemChange[] = [shared("rest", 91 - here)], batches: MemBatch[] = [splitBatch]) =>
        sharing("MP-Frontend", [], [], {
            changes: [...(here ? [shared("done", here, "move-here", "applied")] : []), ...rest, settings()],
            batches,
        });
    const on = (label: string, disabled = false) => ({ label, disabled });
    const apply = { ...on("Apply and switch over"), action: "apply" };
    const keepSharing = on("Keep sharing");
    const failed = (p: MemHygieneProject): MemRowResult => ({
        project: p,
        stop: "failed",
        here: 40,
        total: 91,
        changed: 0,
        newer: 0,
        failed: "rest title",
        error: "denied",
    });

    it.each([
        { name: "open", p: at(0), c: ctx(), want: { primary: apply, keep: keepSharing, undo: null } },
        {
            name: "partial, with its batch",
            p: at(30),
            c: ctx(),
            want: { primary: apply, keep: keepSharing, undo: { ...on("Undo the 30"), batchId: "sb" } },
        },
        {
            name: "partial, with no batch yet",
            p: at(30, undefined, []),
            c: ctx(),
            want: { primary: apply, keep: keepSharing, undo: null },
        },
        {
            name: "changed",
            p: at(88, [shared("edited", 3, "move-here", "conflict")]),
            c: ctx(),
            want: {
                primary: { ...on("Check now"), action: "check" },
                keep: null,
                undo: { ...on("Undo the 88"), batchId: "sb" },
            },
        },
        {
            name: "changed, while its check runs",
            p: { ...at(88, [shared("edited", 3, "move-here", "conflict")]), checking: true },
            c: ctx(),
            want: {
                primary: { ...on("Check now", true), action: "check" },
                keep: null,
                undo: { ...on("Undo the 88"), batchId: "sb" },
            },
        },
        {
            name: "failed",
            p: at(40),
            c: (p: MemHygieneProject) => ctx({ result: failed(p) }),
            want: {
                primary: { ...on("Try again"), action: "apply" },
                keep: null,
                undo: { ...on("Undo the 40"), batchId: "sb" },
            },
        },
        { name: "applying", p: at(41), c: ctx({ applying: true }), want: { primary: null, keep: null, undo: null } },
        {
            name: "open, while another decision runs",
            p: at(0),
            c: ctx({ busy: true }),
            want: { primary: { ...apply, disabled: true }, keep: on("Keep sharing", true), undo: null },
        },
    ])("a split, $name", ({ p, c, want }) => {
        const row = waitingRows([p])[0];
        expect(rowButtons(p, row, typeof c === "function" ? c(p) : c)).toEqual(want);
    });

    it("a cleanup clears its memories, a doc move moves, a failed check checks", () => {
        const ps = flowAuto();
        const rows = waitingRows(ps);
        const of = (key: string) => rowButtons(ps[5], rows.find((r: WaitingRow) => r.key === key)!, ctx());
        expect(of("cleanup/cyber_anomaly_detector")).toEqual({
            primary: { ...on("Clear 6"), action: "apply" },
            keep: on("Keep them"),
            undo: null,
        });
        expect(of("doc/cyber_anomaly_detector/d1")).toEqual({
            primary: { ...on("Move to CLAUDE.md"), action: "apply" },
            keep: on("Keep"),
            undo: null,
        });
        expect(of("failed/cyber_anomaly_detector")).toEqual({
            primary: { ...on("Check now"), action: "check" },
            keep: null,
            undo: null,
        });
    });
});

describe("a split row opened", () => {
    it("spot-checks two moves and two copies, skipping left-out memories", () => {
        const p = sharing("MP-Frontend", [1, 1, 51], [1, 37]);
        expect(spotCheck(p).map((c) => c.id)).toEqual(["m0", "m1", "c0", "c1"]);
        p.changes[0].status = "kept";
        expect(spotCheck(p).map((c) => c.id)).toEqual(["m1", "m2", "c0", "c1"]);
    });

    it("lists every change under Move here and Copy here, a left-out one still counted and marked", () => {
        const p = sharing("MP-Frontend", [1, 1, 51], [1, 37]);
        p.changes[1].status = "kept";
        expect(splitList(p).map((g) => [g.label, g.count, g.changes.map((c) => c.id)])).toEqual([
            ["Move here", 53, ["m0", "m1", "m2"]],
            ["Copy here", 38, ["c0", "c1"]],
        ]);
        expect(p.changes.slice(0, 4).map(splitItemChip)).toEqual(["Move", "Left out", "Move", "Copy"]);
    });

    function result(p: MemHygieneProject, over: Partial<MemRowResult>): MemRowResult {
        return { project: p, stop: "", here: 0, total: 0, changed: 0, newer: 0, failed: "", error: "", ...over };
    }

    const MP_UI = "MP UI work must reuse the app’s existing components and styles";
    const at = (here: number, rest: MemChange[] = [shared("rest", 91 - here)]) =>
        sharing("MP-Frontend", [], [], {
            changes: [...(here ? [shared("done", here, "move-here", "applied")] : []), ...rest, settings()],
        });

    it.each([
        {
            name: "open",
            p: at(0),
            applying: false,
            res: null,
            want: { state: "open", tag: "", text: "", undo: "", next: "" },
        },
        {
            name: "applying",
            p: at(41),
            applying: true,
            res: null,
            want: {
                state: "applying",
                tag: "Applying",
                text: "Bringing over 41 of 91, then switching over…",
                undo: "",
                next: "",
            },
        },
        {
            name: "partial",
            p: at(30),
            applying: false,
            res: null,
            want: { state: "partial", tag: "30 of 91 here", text: "", undo: "Undo the 30", next: "" },
        },
        {
            name: "changed",
            p: at(88, [shared("edited", 3, "move-here", "conflict")]),
            applying: false,
            res: null,
            want: {
                state: "changed",
                tag: "88 of 91 here",
                text:
                    "88 of 91 already here. 3 memories changed on disk after the Nov 18 check, so Arc left them in " +
                    "SIEM’s memory and has not switched over. Check again to sort those 3; Apply then brings them " +
                    "over and switches.",
                undo: "Undo the 88",
                next: "Check now",
            },
        },
        {
            name: "newer",
            p: at(91, []),
            applying: false,
            res: (p: MemHygieneProject) => result(p, { stop: "newer", here: 91, total: 91, newer: 2 }),
            want: {
                state: "newer",
                tag: "91 of 91 here",
                text:
                    "91 of 91 already here, not switched over. 2 memories were written to SIEM’s memory after the " +
                    "check and have no sort yet; switching now would leave them out of MP-Frontend’s sessions. " +
                    "Check again, then Apply switches over.",
                undo: "Undo the 91",
                next: "Check now",
            },
        },
        {
            name: "failed",
            p: at(40, [
                change("ui", { kind: "move-here", group: "shared", title: MP_UI, op: op({ memories: ["ui.md"] }) }),
                shared("rest", 50),
            ]),
            applying: false,
            res: (p: MemHygieneProject) =>
                result(p, {
                    stop: "failed",
                    here: 40,
                    total: 91,
                    failed: MP_UI,
                    error: "[the error the move returned]",
                }),
            want: {
                state: "failed",
                tag: "40 of 91 here",
                text:
                    `Stopped at 41 of 91. “${MP_UI}” did not move: [the error the move returned]. ` +
                    "MP-Frontend is not switched over; the 40 already here stay.",
                undo: "Undo the 40",
                next: "Try again",
            },
        },
    ])("$name reads as its board", ({ p, applying, res, want }) => {
        expect(splitState(p, applying, res == null ? null : res(p))).toEqual(want);
    });

    it("a single newer memory reads in the singular, and an error's own period is not doubled", () => {
        const p = at(40);
        const newer = result(p, { stop: "newer", here: 40, total: 91, newer: 1 });
        expect(splitState(p, false, newer).text).toMatch(/1 memory was written .* and has no sort yet;/);
        const failed = result(p, { stop: "failed", failed: "rest title", error: "Access is denied." });
        expect(splitState(p, false, failed).text).toMatch(/did not move: Access is denied\. MP-Frontend is not/);
    });

    it("a stop from before the last check no longer holds", () => {
        const p = at(30);
        const stale = result({ ...p, checkedat: FLOW_CHECKED - DAY }, { stop: "newer", newer: 2 });
        expect(splitState(p, false, stale).state).toBe("partial");
    });
});

describe("a cleanup row opened", () => {
    it("counts only open removals and names who took them and who still loads the shared memory", () => {
        const ps = flowAuto();
        const d = cleanupDetail(ps[5], ps);
        expect(d.changes.map((c) => c.id)).toEqual(["r1", "r2"]);
        expect(d.count).toBe(6);
        expect(d.opened).toBe("cyber_anomaly_detector took them on Nov 3; no other project loads them");
        expect(d.body).toBe(
            "These stay in cyber_anomaly_detector’s own memory. Clearing them only takes them out of SIEM’s, which " +
                "MP-Frontend, cyber_assistant, kept_sharing and universal_parser_config_generator load."
        );
    });
});

describe("keepIds", () => {
    it("keeps the switch-over for a split, each open removal for a cleanup, and the one doc move", () => {
        const ps = flowAuto();
        const rows = waitingRows(ps);
        const byKey = (k: string) => rows.find((r) => r.key === k)!;
        expect(keepIds(ps[1], byKey("split/MP-Frontend"))).toEqual(["s1"]);
        expect(keepIds(ps[5], byKey("cleanup/cyber_anomaly_detector"))).toEqual(["r1", "r2"]);
        expect(keepIds(ps[5], byKey("doc/cyber_anomaly_detector/d2"))).toEqual(["d2"]);
        expect(keepIds(ps[5], byKey("failed/cyber_anomaly_detector"))).toEqual([]);
    });
});

describe("Arc did this week", () => {
    const at = (d: number, h: number, m: number) => new Date(2026, 10, d, h, m).getTime();

    function batch(
        id: string,
        kind: string,
        when: number,
        changeids: string[],
        over: Partial<MemBatch> = {}
    ): MemBatch {
        return {
            id,
            kind,
            at: when,
            changeids,
            skipped: [],
            indexbefore: { exists: true, lines: 0, bytes: 0 },
            indexafter: { exists: true, lines: 0, bytes: 0 },
            ...over,
        };
    }

    const applied = (id: string, kind: string) => change(id, { kind, title: `${id} title`, status: "applied" });

    function routine(): MemHygieneProject {
        const kinds = ["trim", "trim", "trim", "trim", "trim", "delete", "delete", "merge", "merge", "add-to-index"];
        const changes = kinds.map((k, i) => applied(`a${i}`, k));
        const skipped: MemSkip[] = [
            { changeid: "x1", kind: "trim", title: "", reason: "changed", error: "" },
            { changeid: "x2", kind: "trim", title: "", reason: "changed", error: "" },
            { changeid: "x3", kind: "trim", title: "", reason: "overlap", error: "" },
            { changeid: "x4", kind: "merge", title: "", reason: "failed", error: "disk full" },
        ];
        const b = batch(
            "b1",
            "routine",
            at(20, 9, 7),
            changes.map((c) => c.id),
            {
                skipped,
                indexbefore: { exists: true, lines: 108, bytes: 13900 },
                indexafter: { exists: true, lines: 101, bytes: 11700 },
            }
        );
        return project({ changes, batches: [b] });
    }

    function switchedSplit(settingsStatus = "applied"): MemHygieneProject {
        return project({
            project: "MP-Frontend",
            path: `${SIEM_SRC}\\MP-Frontend`,
            folder: "C:/own/MP-Frontend",
            formershared: SHARED_FOLDER,
            changes: [
                shared("m0", 60, "move-here", "applied"),
                shared("c0", 30, "copy-here", "applied"),
                shared("m1", 1, "move-here", "kept"),
                settings(settingsStatus),
            ],
            batches: [batch("s", "split", at(24, 9, 40), ["m0", "c0", "s1"])],
        });
    }

    it("a routine line counts what is still applied by kind, and what it skipped by kind and reason", () => {
        const lines = didLines([routine()], FLOW_NOW);
        expect(lines.map((l) => [l.key, l.title, l.text])).toEqual([
            [
                "waveterm/b1",
                "waveterm",
                "10 changes on Nov 20 at 09:07 · 5 trims, 2 deletes, 2 merges, 1 index add · 2 trims skipped: " +
                    "changed after the check · 1 trim skipped: another change Arc made touched its memory · " +
                    "1 merge skipped: its apply failed (disk full)",
            ],
        ]);
    });

    it("counts follow an undone change", () => {
        const p = routine();
        p.changes[0].status = "kept";
        p.changes[5].status = "open";
        expect(didLines([p], FLOW_NOW)[0].text).toMatch(
            /^8 changes on Nov 20 at 09:07 · 4 trims, 2 merges, 1 delete, 1 index add · /
        );
    });

    it("leaves out a batch older than a week and a split not yet switched", () => {
        const old = routine();
        old.batches![0].at = FLOW_NOW - 7 * DAY - 1;
        expect(didLines([old, switchedSplit("open")], FLOW_NOW)).toEqual([]);
    });

    it("lists newest first across projects, with a split's and a cleanup's own lines", () => {
        const cleanup = detector({
            changes: [removal("r1", 1, "applied"), removal("r2", 5, "applied")],
            batches: [batch("c", "cleanup", at(22, 10, 2), ["r1", "r2"])],
        });
        const lines = didLines([routine(), cleanup, switchedSplit()], FLOW_NOW);
        expect(lines.map((l) => [l.key, l.title, l.text, l.see])).toEqual([
            [
                "MP-Frontend/s",
                "MP-Frontend",
                "Own memory since yesterday at 09:40 · 90 came over, 1 left out in SIEM’s · switched over",
                "memories",
            ],
            [
                "cyber_anomaly_detector/c",
                "SIEM’s memory",
                "Cleared 6 memories no project loads on Nov 22 at 10:02",
                "memories",
            ],
            ["waveterm/b1", "waveterm", expect.stringMatching(/^10 changes/), "changes"],
        ]);
    });

    it("keys move focus through the waiting rows, then the did lines, stopping at either end", () => {
        const order = focusOrder([...flowAuto().slice(1), routine()], FLOW_NOW);
        expect(order).toEqual([...waitingRows(flowAuto()).map((r) => r.key), "waveterm/b1"]);
        expect(stepFocus(order, null, 1)).toBe(order[0]);
        expect(stepFocus(order, "gone", -1)).toBe(order[0]);
        expect(stepFocus(order, order[6], 1)).toBe("waveterm/b1");
        expect(stepFocus(order, "waveterm/b1", 1)).toBe("waveterm/b1");
        expect(stepFocus(order, order[1], -1)).toBe(order[0]);
        expect(stepFocus(order, order[0], -1)).toBe(order[0]);
        expect(stepFocus([], null, 1)).toBeNull();
    });

    it("a digest lists each applied change, the index line, and Undo all N; a split undoes only whole", () => {
        const [line] = didLines([routine()], FLOW_NOW);
        const d = digest(line);
        expect(d.changes.map((c) => c.id)).toEqual(["a0", "a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8", "a9"]);
        expect(d.index).toBe("waveterm’s MEMORY.md: 101 lines, 11.7 KB after these, from 108 lines, 13.9 KB");
        expect(d.undoAll).toBe("Undo all 10");
        expect(d.undoEach).toBe(true);

        const split = digest(didLines([switchedSplit()], FLOW_NOW)[0]);
        expect(split.changes.map((c) => c.id)).toEqual(["m0", "c0", "s1"]);
        expect(split.index).toBe("");
        expect(split.undoEach).toBe(false);
    });

    it("a blocked split says which cleanup to undo first", () => {
        const p = switchedSplit();
        p.batches![0].undoblock = { project: "cyber_anomaly_detector", batchid: "c", at: at(24, 10, 2), memories: 2 };
        expect(didLines([p], FLOW_NOW)[0].refusal).toBe(
            "Can’t undo yet. Clearing SIEM’s memory on Nov 24 removed 2 memories this split brought over; undoing " +
                "the split now would leave MP-Frontend’s sessions without them. Undo that cleanup first."
        );
        expect(didLines([switchedSplit()], FLOW_NOW)[0].refusal).toBe("");
    });
});
