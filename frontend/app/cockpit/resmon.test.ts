// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    buildViews,
    busyWords,
    fmtAge,
    fmtCpu,
    fmtMem,
    fmtSize,
    foldedTitle,
    isExpanded,
    killChildrenConfirmText,
    killChildrenTargets,
    killConfirmText,
    memberCommand,
    memberOf,
    outcomeNote,
    ownerKindWords,
    ownerNoun,
    readout,
    RESMON_UI_INITIAL,
    resmonLines,
    resmonReduce,
    rowLabel,
    subtreeSize,
    viewHeader,
    viewsSummary,
    type ResMonMember,
    type ResMonUi,
} from "./resmon";

const MB = 1024 * 1024;

const proc = (pid: number, depth: number, name: string, extra: Partial<ProcessInfo> = {}): ProcessInfo => ({
    pid,
    depth,
    name,
    mem: 10 * MB,
    mempct: 0,
    cpu: 0,
    numthreads: 1,
    ...extra,
});

const group = (
    key: string,
    ownerkind: string,
    label: string,
    rows: ProcessInfo[],
    extra: Partial<ResMonGroup> = {}
): ResMonGroup => ({
    key,
    ownerkind,
    label,
    killable: ownerkind === "agenttab" || ownerkind === "runworker",
    cpu: 0,
    mem: 0,
    rows,
    ...extra,
});

const arc = group("arc", "arc", "Arc", [
    proc(2476, 0, "wave-tauri.exe", { role: "Host" }),
    proc(27152, 1, "wavesrv.x64.exe", { role: "Backend" }),
]);

const waveterm = group(
    "job:14820:1",
    "agenttab",
    "waveterm",
    [
        proc(14820, 0, "claude.exe", { tag: "agent", command: '"C:\\bin\\claude.exe" --resume' }),
        proc(14832, 1, "conhost.exe", { tag: "console" }),
        proc(18240, 1, "bash.exe"),
        proc(18244, 2, "go.exe", { command: "C:\\Go\\bin\\go.exe test ./pkg/orchestrate/..." }),
        proc(18311, 3, "orchestrate.test.exe"),
        proc(9932, 1, "cmd.exe"),
        proc(9958, 2, "node.exe"),
    ],
    { runtime: "claude" }
);

const piWorker = group(
    "job:13060:1",
    "runworker",
    "cache-miss notice",
    [
        proc(13060, 0, "cmd.exe", { tag: "launcher" }),
        proc(13072, 1, "conhost.exe", { tag: "console" }),
        proc(13104, 1, "node.exe", { tag: "agent" }),
        proc(21876, 2, "bash.exe"),
        proc(21890, 3, "node.exe"),
    ],
    { runid: "r1", role: "Task 2", runtime: "pi", cpu: 2, mem: 20 * MB }
);

const verify = group(
    "job:22410:1",
    "runcmd",
    "cache-miss notice",
    [
        proc(22410, 0, "bash.exe", { tag: "shell", command: "bash.exe -c node scripts/verify.mjs" }),
        proc(22418, 1, "node.exe"),
    ],
    { runid: "r1", role: "Verify", cpu: 1, mem: 10 * MB }
);

const snap = (extra: Partial<ResMonSnapshotData> = {}): ResMonSnapshotData => ({
    supported: true,
    ready: true,
    ts: 1,
    cpu: 61.4,
    mem: 7.4 * 1024 * MB,
    totalmem: 32 * 1024 * MB,
    busycpu: false,
    busymem: false,
    groups: [],
    ...extra,
});

describe("formatting", () => {
    it("formats cpu with one decimal by default, integer on request, and – when unavailable", () => {
        expect(fmtCpu(28.94)).toBe("28.9%");
        expect(fmtCpu(61.4, 0)).toBe("61%");
        expect(fmtCpu(0)).toBe("0.0%");
        expect(fmtCpu(-1)).toBe("–");
        expect(fmtCpu(-1, 0)).toBe("–");
    });
    it("formats memory in binary units, MB under 1000 MB, GB at and above", () => {
        expect(fmtMem(486 * MB)).toBe("486 MB");
        expect(fmtMem(999 * MB)).toBe("999 MB");
        expect(fmtMem(1000 * MB)).toBe("1.0 GB");
        expect(fmtMem(1.9 * 1024 * MB)).toBe("1.9 GB");
        expect(fmtMem(0)).toBe("0 MB");
        expect(fmtMem(-1)).toBe("–");
    });
    it("formats sizes under 1 MiB in bytes or KB, and as fmtMem from 1 MiB up", () => {
        expect(fmtSize(0)).toBe("0 B");
        expect(fmtSize(512)).toBe("512 B");
        expect(fmtSize(8192)).toBe("8 KB");
        expect(fmtSize(MB)).toBe("1 MB");
        expect(fmtSize(14.6 * 1024 * MB)).toBe("14.6 GB");
    });
    it("keeps fmtMem unchanged at 1 MiB and above", () => {
        expect(fmtMem(MB)).toBe("1 MB");
        expect(fmtMem(14.6 * 1024 * MB)).toBe("14.6 GB");
        expect(fmtMem(8192)).toBe("0 MB");
    });
    it("formats age across the second, minute, hour and day edges", () => {
        const now = 10_000_000_000;
        const ago = (s: number) => now - s * 1000;
        expect(fmtAge(ago(45), now)).toBe("45s");
        expect(fmtAge(ago(59), now)).toBe("59s");
        expect(fmtAge(ago(60), now)).toBe("1m");
        expect(fmtAge(ago(42 * 60), now)).toBe("42m");
        expect(fmtAge(ago(3 * 3600 + 12 * 60), now)).toBe("3h 12m");
        expect(fmtAge(ago(24 * 3600 - 1), now)).toBe("23h 59m");
        expect(fmtAge(ago(24 * 3600), now)).toBe("1d 0h");
        expect(fmtAge(ago(2 * 86400 + 4 * 3600), now)).toBe("2d 4h");
        expect(fmtAge(0, now)).toBe("–");
    });
});

describe("busy and readout", () => {
    it("names every busy combination", () => {
        expect(busyWords(snap())).toBeNull();
        expect(busyWords(snap({ busycpu: true }))).toBe("high CPU");
        expect(busyWords(snap({ busymem: true }))).toBe("high memory");
        expect(busyWords(snap({ busycpu: true, busymem: true }))).toBe("high CPU and memory");
    });
    it("reads `Arc –` before any snapshot and before the first CPU delta", () => {
        for (const s of [null, snap({ ready: false, busycpu: true })]) {
            const r = readout(s);
            expect(r).toMatchObject({ visible: true, ready: false, cpu: "–", mem: "–", busy: null });
        }
    });
    it("hides when unsupported", () => {
        expect(readout(snap({ supported: false })).visible).toBe(false);
        expect(readout(snap({ supported: false, ready: false })).visible).toBe(false);
    });
    it("reads integer CPU and memory when ready, with the busy words in the aria label", () => {
        const r = readout(snap({ busycpu: true }));
        expect(r).toMatchObject({ visible: true, ready: true, cpu: "61%", mem: "7.4 GB", busy: "high CPU" });
        expect(r.aria).toBe("Resource Manager: Arc and its agents use 61% CPU and 7.4 GB, high CPU");
    });
});

describe("buildViews", () => {
    const views = buildViews([verify, waveterm, arc, piWorker]);
    const run = views.find((v) => v.kind === "run")!;
    const tab = views.find((v) => v.kind === "tab")!;

    it("pins Arc first however low its CPU, then sorts by CPU, ties by label", () => {
        const g = (key: string, label: string, cpu: number) => group(key, "agenttab", label, [], { cpu });
        const out = buildViews([g("b", "beta", 5), g("arc", "Arc", 0.1), g("c", "alpha", 5), g("d", "zed", 40)]);
        expect(out.map((x) => x.key)).toEqual(["arc", "d", "c", "b"]);
        expect(views.map((v) => v.key)).toEqual(["arc", "run:r1", waveterm.key]);
    });
    it("groups a run's workers and commands into one view by run id, summing CPU, memory and processes", () => {
        expect(run).toMatchObject({ label: "cache-miss notice", cpu: 3, mem: 30 * MB, procs: 7 });
        expect(run.members.map((m) => m.role)).toEqual(["Task 2", "Verify"]);
    });
    it("orders a run's members by when they started", () => {
        const late = group(
            "job:9:1",
            "runworker",
            "cache-miss notice",
            [proc(9, 0, "claude.exe", { tag: "agent", createts: 50 })],
            { runid: "r1", role: "Lead" }
        );
        const early = group(
            "job:8:1",
            "runworker",
            "cache-miss notice",
            [proc(8, 0, "claude.exe", { tag: "agent", createts: 10 })],
            { runid: "r1", role: "Task 1" }
        );
        expect(buildViews([late, early])[0].members.map((m) => m.role)).toEqual(["Task 1", "Lead"]);
    });
    it("keeps each tab its own view, with one member, Arc's rows unfolded", () => {
        expect(tab.members.map((m) => m.role)).toEqual(["Agent"]);
        expect(views[0].arcRows.map((r) => r.pid)).toEqual([2476, 27152]);
        expect(views[0].members).toEqual([]);
    });
    it("folds a member's core into its line, headed by the agent", () => {
        const [worker, cmd] = run.members;
        expect(worker.head?.pid).toBe(13104);
        expect(worker.folded.map((r) => r.pid)).toEqual([13060, 13072]);
        expect(cmd.head?.pid).toBe(22410);
        expect(cmd.folded).toEqual([]);
        expect(tab.members[0].folded.map((r) => r.pid)).toEqual([14832]);
    });
    it("lists what a member started, re-rooted under its core", () => {
        const depths = (m: ResMonMember) => m.kids.map((r) => `${r.pid}@${r.depth}`).join(" ");
        expect(depths(run.members[0])).toBe("21876@0 21890@1");
        expect(depths(tab.members[0])).toBe("18240@0 18244@1 18311@2 9932@0 9958@1");
    });
    it("names a tab's member Shell when no agent runs in it, and a member with no core has no head", () => {
        const shell = memberOf(group("job:1:1", "agenttab", "scratch", [proc(1, 0, "pwsh.exe", { tag: "shell" })]));
        expect(shell.role).toBe("Shell");
        expect(shell.head?.pid).toBe(1);
        const orphan = memberOf(group("job:2:1", "agenttab", "scratch", [proc(5, 0, "node.exe")]));
        expect(orphan.head).toBeNull();
        expect(orphan.kids.map((r) => r.pid)).toEqual([5]);
    });
});

describe("headers and member lines", () => {
    const views = buildViews([arc, waveterm, piWorker, verify]);
    const [arcView, run, tab] = views;

    it("titles a tab by its Agent tree name, with its project and process count as the detail", () => {
        expect(viewHeader(tab, "Fix resmon labels")).toEqual({
            title: "Fix resmon labels",
            detail: "waveterm · 7 processes",
        });
    });
    it("drops the project when the tree name already carries it, and keeps the tab name without one", () => {
        expect(viewHeader(tab, "waveterm")).toEqual({ title: "waveterm", detail: "7 processes" });
        expect(viewHeader(tab, "Fix resmon labels · waveterm")).toEqual({
            title: "Fix resmon labels · waveterm",
            detail: "7 processes",
        });
        expect(viewHeader(tab, undefined)).toEqual({ title: "waveterm", detail: "7 processes" });
        expect(viewHeader(tab, "  ")).toEqual({ title: "waveterm", detail: "7 processes" });
    });
    it("titles a run by its run title and counts its agents and commands", () => {
        expect(viewHeader(run, "ignored")).toEqual({
            title: "cache-miss notice",
            detail: "Run · 1 agent · 1 command · 7 processes",
        });
        const solo = buildViews([piWorker])[0];
        expect(viewHeader(solo, undefined).detail).toBe("Run · 1 agent · 5 processes");
        expect(viewHeader(arcView, undefined)).toEqual({ title: "Arc", detail: "App, read-only · 2 processes" });
    });
    it("sums up runs, tabs and processes, leaving out a kind with none", () => {
        expect(viewsSummary(views)).toBe("1 run · 1 agent tab · 16 processes");
        expect(viewsSummary([arcView])).toBe("2 processes");
    });
    it("shows an agent by its runtime and a command by its command line", () => {
        expect(memberCommand(run.members[0])).toBe("pi");
        expect(memberCommand(run.members[1])).toBe("bash.exe -c node scripts/verify.mjs");
        expect(memberCommand(memberOf(group("job:2:1", "agenttab", "x", [proc(5, 0, "node.exe")])))).toBe("");
    });
    it("lists the folded core in the chip's title", () => {
        expect(foldedTitle(run.members[0])).toBe("Also in this line: cmd.exe (launcher), conhost.exe (console)");
    });
});

describe("owner words", () => {
    it("maps each owner kind to its header words and its noun", () => {
        expect(["arc", "agenttab", "runworker", "runcmd"].map(ownerKindWords)).toEqual([
            "App, read-only",
            "Agent tab",
            "Run worker",
            "Run command, read-only",
        ]);
        expect(["arc", "agenttab", "runworker", "runcmd"].map(ownerNoun)).toEqual([
            "Arc",
            "agent tab",
            "run worker",
            "run command",
        ]);
    });
});

describe("rowLabel", () => {
    it("labels an Arc row by role, with the image and its --type flag", () => {
        const r = proc(20028, 2, "msedgewebview2.exe", {
            role: "Renderer",
            command: '"C:\\Program Files\\WebView2\\msedgewebview2.exe" --type=renderer --lang=en-US',
        });
        expect(rowLabel(r)).toEqual({ name: "Renderer", cmd: "msedgewebview2.exe --type=renderer" });
        expect(
            rowLabel(proc(27152, 1, "wavesrv.x64.exe", { role: "Backend", command: "C:\\a\\wavesrv.x64.exe --x" }))
        ).toEqual({
            name: "Backend",
            cmd: "wavesrv.x64.exe",
        });
    });
    it("labels other rows by image, with the arguments minus the executable path", () => {
        expect(rowLabel(waveterm.rows[0])).toEqual({ name: "claude.exe", cmd: "--resume" });
        expect(rowLabel(waveterm.rows[3])).toEqual({ name: "go.exe", cmd: "test ./pkg/orchestrate/..." });
        expect(rowLabel(waveterm.rows[1])).toEqual({ name: "conhost.exe", cmd: "" });
    });
    it("falls back to the executable's base name when the image name is missing", () => {
        expect(rowLabel(proc(5, 0, "", { command: '"C:\\x y\\tool.exe" -v' }))).toEqual({
            name: "tool.exe",
            cmd: "-v",
        });
    });
});

describe("kill texts", () => {
    it("counts a row's contiguous deeper rows as its subtree", () => {
        expect(subtreeSize(waveterm.rows, 2)).toBe(2); // bash.exe → go.exe → orchestrate.test.exe
        expect(subtreeSize(waveterm.rows, 4)).toBe(0);
        expect(subtreeSize(waveterm.rows, 0)).toBe(6);
    });
    it("asks to kill a row with 0, 1 and several children", () => {
        expect(killConfirmText(waveterm.rows[4], 0)).toBe(
            "Kill orchestrate.test.exe (18311)? It has no child processes."
        );
        expect(killConfirmText(waveterm.rows[3], 1)).toBe("Kill go.exe (18244) and its 1 child process?");
        expect(killConfirmText(waveterm.rows[2], 3)).toBe("Kill bash.exe (18240) and its 3 child processes?");
    });
    it("targets only the untagged rows for kill children", () => {
        expect(killChildrenTargets(waveterm).map((r) => r.pid)).toEqual([18240, 18244, 18311, 9932, 9958]);
        expect(killChildrenTargets(piWorker).map((r) => r.pid)).toEqual([21876, 21890]);
    });
    it("names the agent and its console as the survivors of kill children", () => {
        expect(killChildrenConfirmText(waveterm)).toBe(
            "Kill 5 processes under waveterm? claude.exe and its console keep running."
        );
    });
    it("names node.exe, not the cmd.exe launcher, as the survivor of a pi launcher chain", () => {
        expect(killChildrenConfirmText(piWorker, "Task 2")).toBe(
            "Kill 2 processes under Task 2? node.exe and its console keep running."
        );
    });
    it("names a lone shell with no console, and one process in the singular", () => {
        const g = group("job:1:1", "agenttab", "notes", [
            proc(1, 0, "pwsh.exe", { tag: "shell" }),
            proc(2, 1, "git.exe"),
        ]);
        expect(killChildrenConfirmText(g)).toBe("Kill 1 process under notes? pwsh.exe keeps running.");
    });
});

describe("outcomeNote", () => {
    const killed = (n: number): ResMonKillRtnData => ({ outcome: "killed", killed: n });
    it("notes a row kill with 0, 1 and 3 children", () => {
        expect(outcomeNote(killed(1), { name: "orchestrate.test.exe", pid: 18311 }, waveterm)).toEqual({
            text: "Killed orchestrate.test.exe (18311).",
            tone: "note",
        });
        expect(outcomeNote(killed(2), { name: "go.exe", pid: 18244 }, waveterm).text).toBe(
            "Killed go.exe (18244) and 1 child process."
        );
        expect(outcomeNote(killed(4), { name: "go.exe", pid: 18244 }, waveterm).text).toBe(
            "Killed go.exe (18244) and 3 child processes."
        );
    });
    it("notes a group kill of 1 and 5", () => {
        expect(outcomeNote(killed(1), null, waveterm)).toEqual({ text: "Killed 1 process.", tone: "note" });
        expect(outcomeNote(killed(5), null, waveterm).text).toBe("Killed 5 processes.");
    });
    it("notes a target that had already exited", () => {
        expect(outcomeNote({ outcome: "gone", killed: 0 }, { name: "node.exe", pid: 21890 }, piWorker)).toEqual({
            text: "node.exe (21890) had already exited.",
            tone: "note",
        });
    });
    it("alerts a refusal naming each owner noun", () => {
        const t = { name: "jarvis.test.exe", pid: 22590 };
        const refused: ResMonKillRtnData = { outcome: "refused", killed: 0 };
        for (const [kind, noun] of [
            ["arc", "Arc"],
            ["agenttab", "agent tab"],
            ["runworker", "run worker"],
            ["runcmd", "run command"],
        ]) {
            expect(outcomeNote(refused, t, group("k", kind, "L", []))).toEqual({
                text: `Not killed: pid 22590 no longer belongs to this ${noun}. The list refreshes in 2s.`,
                tone: "alert",
            });
        }
    });
    it("alerts a protected agent process", () => {
        expect(outcomeNote({ outcome: "protected", killed: 0 }, { name: "claude.exe", pid: 14820 }, waveterm)).toEqual({
            text: "Not killed: claude.exe (14820) is the agent's own process. Kill children stops what it started.",
            tone: "alert",
        });
    });
    it("alerts a failure with the OS text, with or without its trailing period", () => {
        const t = { name: "jarvis.test.exe", pid: 22590 };
        const want = {
            text: "Could not kill jarvis.test.exe (22590): Access is denied. It is still running.",
            tone: "alert",
        };
        expect(outcomeNote({ outcome: "failed", killed: 0, error: "Access is denied." }, t, piWorker)).toEqual(want);
        expect(outcomeNote({ outcome: "failed", killed: 0, error: "Access is denied" }, t, piWorker)).toEqual(want);
    });
});

describe("resmonReduce", () => {
    const views = buildViews([arc, waveterm, piWorker, verify]);
    const tabKey = waveterm.key;
    const at = (ui: ResMonUi, cursor: string): ResMonUi => ({ ...ui, cursor });
    const open = (...keys: string[]): ResMonUi => ({
        ...RESMON_UI_INITIAL,
        expanded: Object.fromEntries(keys.map((k) => [k, true])),
    });

    it("starts with every view collapsed", () => {
        for (const v of views) {
            expect(isExpanded(RESMON_UI_INITIAL, v.key)).toBe(false);
        }
        expect(resmonLines(views, RESMON_UI_INITIAL).map((l) => l.id)).toEqual(["arc", "run:r1", tabKey]);
    });
    it("lists an open run's members, each followed by what it started", () => {
        expect(resmonLines(views, open("run:r1")).map((l) => l.id)).toEqual([
            "arc",
            "run:r1",
            `m:${piWorker.key}`,
            `${piWorker.key}/21876`,
            `${piWorker.key}/21890`,
            `m:${verify.key}`,
            `${verify.key}/22418`,
            tabKey,
        ]);
    });
    it("moves across collapsed views header to header, and clamps at the ends", () => {
        let ui = resmonReduce(RESMON_UI_INITIAL, { type: "move", delta: 1, views });
        expect(ui.cursor).toBe("arc");
        ui = resmonReduce(ui, { type: "move", delta: 1, views });
        expect(ui.cursor).toBe("run:r1");
        ui = resmonReduce(ui, { type: "move", delta: -1, views });
        ui = resmonReduce(ui, { type: "move", delta: -1, views });
        expect(ui.cursor).toBe("arc");
        expect(resmonReduce(RESMON_UI_INITIAL, { type: "move", delta: -1, views }).cursor).toBe(tabKey);
    });
    it("toggles the cursor's view, and a collapse pulls a member or row cursor up to its header", () => {
        let ui = resmonReduce(at(RESMON_UI_INITIAL, "arc"), { type: "toggle", views });
        expect(isExpanded(ui, "arc")).toBe(true);
        expect(resmonReduce(ui, { type: "move", delta: 1, views }).cursor).toBe("arc/2476");
        for (const cursor of [`m:${piWorker.key}`, `${piWorker.key}/21890`]) {
            const closed = resmonReduce(at(open("run:r1"), cursor), { type: "toggle", views });
            expect(isExpanded(closed, "run:r1")).toBe(false);
            expect(closed.cursor).toBe("run:r1");
        }
        ui = resmonReduce(at(RESMON_UI_INITIAL, tabKey), { type: "toggle", views, key: "arc" });
        expect(isExpanded(ui, "arc")).toBe(true);
        expect(ui.cursor).toBe(tabKey);
        expect(resmonReduce(RESMON_UI_INITIAL, { type: "toggle", views })).toBe(RESMON_UI_INITIAL);
    });
    it("asks to kill a row a member started", () => {
        const ui = resmonReduce(at(RESMON_UI_INITIAL, `${tabKey}/18244`), { type: "askKill", views });
        expect(ui.confirm).toEqual({ kind: "row", key: tabKey, pid: 18244 });
    });
    it("asks to kill the row a click names, moving the cursor there", () => {
        const ui = resmonReduce(RESMON_UI_INITIAL, { type: "askKill", views, at: `${piWorker.key}/21890` });
        expect(ui.cursor).toBe(`${piWorker.key}/21890`);
        expect(ui.confirm).toEqual({ kind: "row", key: piWorker.key, pid: 21890 });
    });
    it("ignores x on a member line, a header, an Arc row, or a read-only command's row", () => {
        for (const cursor of [`m:${tabKey}`, tabKey, "run:r1", "arc/2476", `${verify.key}/22418`]) {
            const ui = at(RESMON_UI_INITIAL, cursor);
            expect(resmonReduce(ui, { type: "askKill", views })).toBe(ui);
        }
    });
    it("asks to kill a member's children from its line, one of its rows, or a tab's header", () => {
        for (const [cursor, key] of [
            [`m:${piWorker.key}`, piWorker.key],
            [`${piWorker.key}/21876`, piWorker.key],
            [tabKey, tabKey],
            [`m:${tabKey}`, tabKey],
        ]) {
            expect(resmonReduce(at(RESMON_UI_INITIAL, cursor), { type: "askChildren", views }).confirm).toEqual({
                kind: "group",
                key,
            });
        }
    });
    it("opens a collapsed tab when ⇧X on its header asks, so the confirm shows", () => {
        const ui = resmonReduce(at(RESMON_UI_INITIAL, tabKey), { type: "askChildren", views });
        expect(isExpanded(ui, tabKey)).toBe(true);
    });
    it("ignores ⇧X on a run's header, Arc, a read-only command, or a member that started nothing", () => {
        const bare = group("job:7716:1", "agenttab", "obsidian", [proc(7716, 0, "claude.exe", { tag: "agent" })]);
        const all = buildViews([arc, waveterm, piWorker, verify, bare]);
        for (const cursor of ["run:r1", "arc", `m:${verify.key}`, `${verify.key}/22418`, bare.key, `m:${bare.key}`]) {
            const ui = at(RESMON_UI_INITIAL, cursor);
            expect(resmonReduce(ui, { type: "askChildren", views: all })).toBe(ui);
        }
    });
    it("cancels a confirm, and a new confirm clears that member's note", () => {
        let ui = resmonReduce(RESMON_UI_INITIAL, {
            type: "note",
            key: tabKey,
            note: { text: "Killed 1 process.", tone: "note" },
        });
        ui = resmonReduce(ui, { type: "askChildren", views, at: tabKey });
        expect(ui.notes).toEqual({});
        expect(resmonReduce(ui, { type: "cancel" }).confirm).toBeNull();
    });
    it("close clears the cursor, confirm and notes but keeps the expansion", () => {
        let ui = resmonReduce(at(RESMON_UI_INITIAL, "arc"), { type: "toggle", views });
        ui = resmonReduce(ui, { type: "askKill", views, at: `${tabKey}/18311` });
        ui = resmonReduce(ui, { type: "note", key: verify.key, note: { text: "x", tone: "alert" } });
        ui = resmonReduce(ui, { type: "close" });
        expect(ui).toEqual({ cursor: null, confirm: null, notes: {}, expanded: { arc: true } });
    });
});
