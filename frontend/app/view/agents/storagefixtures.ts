// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Sample Storage reports for the DEV mock: the rows of the storage-report canvas (Page.dc.html), with its
// paths, owners, sizes and states. Times are offsets from `now`, so the idle column reads as the board does
// whenever a scenario loads.

export type StorageScenario = "storage" | "clearing" | "cleared" | "scanning" | "error" | "clean";

const KB = 1024;
const MB = 1024 * KB;
const GB = 1024 * MB;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const HOME = "C:\\Users\\arc";
const LOCAL = `${HOME}\\AppData\\Local`;
const WT = `${LOCAL}\\arc-wt`;
const WAVETERM = { projectname: "waveterm", projectpath: `${HOME}\\IdeaProjects\\waveterm` };
const SIEM = { projectname: "cyber_anomaly_detector", projectpath: `${HOME}\\IdeaProjects\\cyber_anomaly_detector` };
const LEGACY = `${WAVETERM.projectpath}\\.waveterm\\worktrees`;
const HELD_ERROR = "The process cannot access the file because it is being used by another process.";

type Project = typeof WAVETERM;

function landedTree(
    now: number,
    runid: string,
    project: Project,
    runtitle: string,
    ago: number,
    size: number
): StorageItem {
    const path = `${WT}\\${runid.slice(0, 8)}`;
    return {
        id: `runtree:${path}`,
        kind: "runtree",
        group: "left",
        path,
        ...project,
        runid,
        runtitle,
        runstatus: "done",
        runlandstate: "landed",
        runts: now - ago,
        size,
        modts: now - ago,
        clearable: true,
    };
}

function waveBranch(
    now: number,
    runid: string,
    runtitle: string,
    run: Partial<StorageItem>,
    alsoon: string,
    ago: number
): StorageItem {
    const branch = `wave/${runid}`;
    return {
        id: `branch:${SIEM.projectpath}:refs/heads/${branch}`,
        kind: "branch",
        group: "left",
        ...SIEM,
        branch,
        branchtip: `${runid.slice(0, 8)}0c4e1d2b7a9f3e5c6d8b1a2f4e6c8d0b`,
        runid,
        runtitle,
        ...run,
        runts: now - ago,
        alsoon,
        size: 0,
        modts: now - ago,
        clearable: true,
    };
}

function members(parent: string, prefix: string, n: number): string[] {
    return Array.from({ length: n }, (_, i) => `${parent}\\${prefix}${i + 1}`);
}

function finalOut(now: number, parent: string, prefix: string, n: number, size: number, ago: number): StorageItem {
    return {
        id: `finalout:${parent}\\${prefix}*`,
        kind: "finalout",
        group: "left",
        path: parent,
        paths: members(parent, prefix, n),
        count: n,
        size,
        modts: now - ago,
        clearable: true,
    };
}

function kept(
    now: number,
    kind: string,
    path: string,
    size: number,
    ago: number,
    extra: Partial<StorageItem> = {}
): StorageItem {
    return { id: `${kind}:${path}`, kind, group: "kept", path, size, modts: now - ago, ...extra };
}

function storageItems(now: number): StorageItem[] {
    const skipped = "9e473bf8-e50f-48e2-9a4d-bfb1b79dddcc";
    const live = "dca34385-7b2e-4c1a-9f3d-2e8b6a1c4d70";
    return [
        landedTree(
            now,
            "bd67b1fe-2c41-4f0e-9a51-0d3e6b7c8a10",
            SIEM,
            "Investigation engine leak-check escape fix",
            9 * MIN,
            8 * KB
        ),
        landedTree(
            now,
            "3425249d-8e17-4b6a-a2c9-5f1d0e3b7c42",
            SIEM,
            "Make a plan and implement spec 1 of the investigation engine",
            30 * MIN,
            8 * KB
        ),
        landedTree(now, "009152b3-4d6e-4f80-b1a2-7c9e3d5f1b26", WAVETERM, "Broaden what Radar finds", DAY, 12 * KB),
        landedTree(
            now,
            "866e3b50-1a2b-4c3d-8e4f-5a6b7c8d9e01",
            WAVETERM,
            "Add image paste and a file-select button to the New run goal box",
            2 * DAY,
            12 * KB
        ),
        landedTree(
            now,
            "a6cf3f86-9b8a-4d7c-a6e5-f4d3c2b1a098",
            WAVETERM,
            "Shell task output fills the agent pane instead of a floating peek",
            2 * DAY,
            12 * KB
        ),
        {
            id: `legacygroup:${LEGACY}`,
            kind: "legacygroup",
            group: "left",
            path: LEGACY,
            paths: members(LEGACY, "legacy-run-", 16),
            count: 16,
            ...WAVETERM,
            runcount: 16,
            runts: now - 2 * DAY,
            size: 192 * KB,
            modts: now - 3 * DAY,
            clearable: true,
        },
        {
            id: `legacytree:${LEGACY}\\${skipped}`,
            kind: "legacytree",
            group: "left",
            path: `${LEGACY}\\${skipped}`,
            ...WAVETERM,
            branch: `wave/${skipped}`,
            branchtip: "ad962fe1b3c4d5e6f708192a3b4c5d6e7f809a1b",
            runid: skipped,
            runtitle: "Finish the user notes feature: chunks 8, 9 and 10",
            runstatus: "cancelled",
            runts: now - 6 * DAY,
            tracked: true,
            hasgit: true,
            onlycount: 2,
            onlycommits: [
                { sha: "ad962fe1", subject: "docs: drop the notes palette plan from this run" },
                { sha: "01a08218", subject: "docs: spec and plan for User notes in the palette" },
            ],
            size: 49 * MB,
            modts: now - 6 * DAY,
            skip: "commits",
        },
        waveBranch(
            now,
            "021cb57c-bf17-4c5c-9f41-ee7373a2cc11",
            "Make a plan and implement the 2026-09-30 palette spec",
            { runstatus: "cancelled" },
            "SIEM-1707_anomaly-hypothesis-system-backup-20261001",
            14 * DAY
        ),
        waveBranch(
            now,
            "f15cd1a3-d509-48b6-b505-2155fee20b96",
            "Hypotheses page redesign (ManagementPanel)",
            { runstatus: "done", runlandstate: "held", runlanddismissed: true },
            "DEV-backup-20261007",
            8 * DAY
        ),
        finalOut(now, `${LOCAL}\\Temp`, "arc-final-", 21, 208 * MB, DAY),
        finalOut(now, LOCAL, "arc-final-out-", 2, 106 * MB, 14 * DAY),
        {
            id: `runtree:${WT}\\dca34385`,
            kind: "runtree",
            group: "inuse",
            path: `${WT}\\dca34385`,
            ...WAVETERM,
            branch: `wave/${live}`,
            branchtip: "dca34385f1e2d3c4b5a69788a9b0c1d2e3f40516",
            runid: live,
            runtitle: "Implement memory hygiene: Arc checks each registered project’s Claude memory",
            runstatus: "executing",
            runts: now - HOUR,
            tracked: true,
            hasgit: true,
            size: 51 * MB,
            modts: now - 10_000,
        },
        kept(now, "finalslot", `${LOCAL}\\arc-final\\target`, Math.round(4.1 * GB), 15 * DAY, { slot: 0 }),
        kept(now, "finalslot", `${LOCAL}\\arc-final\\target-1`, Math.round(2.7 * GB), 2 * DAY, { slot: 1 }),
        kept(now, "finalslot", `${LOCAL}\\arc-final\\target-2`, Math.round(2.7 * GB), 2 * DAY, { slot: 2 }),
        kept(now, "transcripts", `${HOME}\\.claude\\projects`, Math.round(2.6 * GB), MIN, { harness: "claude" }),
        kept(now, "finalshots", `${LOCAL}\\dev.arc.app\\data\\final-shots`, Math.round(1.4 * GB), 2 * DAY, {
            count: 31,
        }),
        kept(now, "transcripts", `${HOME}\\.pi`, 525 * MB, HOUR, { harness: "pi" }),
        kept(now, "finalstores", `${LOCAL}\\arc-final`, 173 * MB, 2 * DAY, {
            paths: [`${LOCAL}\\arc-final\\stores-1`, `${LOCAL}\\arc-final\\stores-2`],
            count: 2,
        }),
    ];
}

const HELD_ID = `runtree:${WT}\\3425249d`;
// the clear order of the storage scenario's clearable rows, as the section lists them
const CLEARED_FIRST = [
    `runtree:${WT}\\bd67b1fe`,
    HELD_ID,
    `runtree:${WT}\\009152b3`,
    `runtree:${WT}\\866e3b50`,
    `runtree:${WT}\\a6cf3f86`,
    `legacygroup:${LEGACY}`,
];
const CLEARING_NOW = `branch:${SIEM.projectpath}:refs/heads/wave/f15cd1a3-d509-48b6-b505-2155fee20b96`;

function clearing(now: number): StorageReportData {
    const items = storageItems(now).map((it): StorageItem => {
        if (CLEARED_FIRST.includes(it.id)) {
            return { ...it, clearstate: "cleared" };
        }
        return it.id === CLEARING_NOW ? { ...it, clearstate: "clearing" } : it;
    });
    return { scants: now, clearing: true, cleartotal: 10, cleardone: 6, items };
}

function cleared(now: number): StorageReportData {
    const all = storageItems(now);
    const gone = all.filter((it) => it.group === "left" && it.clearable && it.id !== HELD_ID);
    const items = all
        .filter((it) => !gone.includes(it))
        .map(
            (it): StorageItem =>
                it.id === HELD_ID ? { ...it, clearstate: "failed", clearerror: HELD_ERROR, clearheld: true } : it
        );
    const freed = gone.reduce((sum, it) => sum + it.size, 0);
    const held = all.find((it) => it.id === HELD_ID);
    return {
        scants: now - 2 * MIN,
        items,
        lastclear: {
            ts: now,
            cleared: gone.length,
            freed,
            failed: [{ id: HELD_ID, path: held.path, error: HELD_ERROR, held: true }],
        },
    };
}

export function storageScenarios(now: number): Record<StorageScenario, StorageReportData> {
    const items = storageItems(now);
    return {
        storage: { scants: now, items },
        clearing: clearing(now),
        cleared: cleared(now),
        scanning: { scants: 0, scanning: true, scanstartts: now, items: [] },
        error: {
            scants: now,
            items: items.filter((it) => it.projectname !== SIEM.projectname),
            errors: [{ ...SIEM, error: "git exited 128, not a git repository" }],
        },
        clean: { scants: now, items: items.filter((it) => it.group !== "left") },
    };
}

export const STORAGE_SCENARIOS: Record<StorageScenario, StorageReportData> = storageScenarios(Date.now());
