// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.hoisted(() => ({
    GetDossierCommand: vi.fn(),
    ListTaskDossiersCommand: vi.fn(),
    ListRadarReportsCommand: vi.fn(),
    GetChannelRunsCommand: vi.fn(),
    GetChannelMessagesCommand: vi.fn(),
    SetChannelReadCommand: vi.fn(),
    EffortGetCommand: vi.fn(),
    FileInfoCommand: vi.fn(),
}));
const loadAndPin = vi.hoisted(() => vi.fn());
const pushToast = vi.hoisted(() => vi.fn());

vi.mock("@/app/store/wshclientapi", () => ({ RpcApi: rpc }));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));
vi.mock("@/app/store/wos", async () => {
    const { atom } = await import("jotai");
    return {
        loadAndPinWaveObject: (...a: unknown[]) => loadAndPin(...a),
        makeORef: (otype: string, oid: string) => `${otype}:${oid}`,
        getWaveObjectAtom: () => atom(null),
    };
});
vi.mock("@/app/cockpit/notificationstore", () => ({ pushToast: (...a: unknown[]) => pushToast(...a) }));

import { globalStore } from "@/app/store/jotaiStore";
import { atom } from "jotai";
import type { AgentsViewModel, SurfaceKey } from "../agents/agents";
import type { AgentVM } from "../agents/agentsviewmodel";
import { attachCanvas, detachCanvas, getCanvas, setCanvasMode } from "../agents/canvasstore";
import {
    currentReportIdAtom,
    loadReports,
    radarReportsAtom,
    radarScopeAtom,
    radarSelectedIdAtom,
} from "../agents/radarstore";
import { NO_MEMORY_SURFACE } from "./address";
import { briefPeekRecordAtom, briefSheetOpenAtom } from "./jarvisstore";
import { activeRunIdAtom, activeSubjectAtom, recordDetailAtom } from "./jarvissubjectstore";
import { openAddress, openTarget } from "./openref";
import { pendingDecisionAnchorAtom } from "./petstore";
import { taskListAtom, tasksErrorAtom } from "./tasksstore";

const objects = new Map<string, unknown>();

function makeModel(roster: string[] = [], terminals: string[] = []): AgentsViewModel {
    const vm = (id: string) => ({ id, name: id, task: "", state: "working", blockId: `block-${id}` }) as AgentVM;
    return {
        surfaceAtom: atom<SurfaceKey>("cockpit"),
        focusIdAtom: atom<string | undefined>(undefined),
        agentsAtom: atom(roster.map(vm)),
        terminalsAtom: atom<AgentVM[]>(terminals.map(vm)),
    } as unknown as AgentsViewModel;
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => (resolve = r));
    return { promise, resolve };
}

function report(oid: string, path: string, startedts: number, findingIds: string[] = []): RadarReport {
    return {
        oid,
        projectname: path.slice(1),
        projectpath: path,
        startedts,
        findings: findingIds.map((id) => ({ id })),
    } as unknown as RadarReport;
}

const REPORTS_B = [report("rb-new", "/b", 2, ["f-1"]), report("rb-old", "/b", 1, ["f-1"])];

function seedReports(): void {
    for (const r of REPORTS_B) {
        objects.set(`radarreport:${r.oid}`, r);
    }
}

beforeEach(() => {
    vi.resetAllMocks();
    objects.clear();
    loadAndPin.mockImplementation((oref: string) => Promise.resolve(objects.get(oref) ?? null));
    rpc.GetChannelRunsCommand.mockResolvedValue({ runs: [] });
    rpc.GetChannelMessagesCommand.mockResolvedValue({ messages: [] });
    rpc.SetChannelReadCommand.mockResolvedValue(undefined);
    rpc.EffortGetCommand.mockResolvedValue({ effort: null });
    globalStore.set(taskListAtom, null);
    globalStore.set(tasksErrorAtom, null);
    globalStore.set(radarScopeAtom, null);
    globalStore.set(radarReportsAtom, null);
    globalStore.set(currentReportIdAtom, undefined);
    globalStore.set(radarSelectedIdAtom, undefined);
    globalStore.set(briefPeekRecordAtom, null);
    globalStore.set(briefSheetOpenAtom, false);
    globalStore.set(pendingDecisionAnchorAtom, null);
    globalStore.set(activeSubjectAtom, null);
    globalStore.set(activeRunIdAtom, {});
    globalStore.set(recordDetailAtom, {});
});

describe("run and channel landings", () => {
    it("lands a run on its channel's sheet, on that run", async () => {
        const model = makeModel();
        objects.set("run:r1", { oid: "r1", channeloid: "c1" });
        objects.set("channel:c1", { oid: "c1" });
        expect(await openTarget(model, { kind: "run", runId: "r1" })).toEqual({ ok: true });
        expect(globalStore.get(activeSubjectAtom)).toEqual({ kind: "channel", id: "c1" });
        expect(globalStore.get(activeRunIdAtom)["c1"]).toBe("r1");
        expect(globalStore.get(briefSheetOpenAtom)).toBe(true);
        expect(globalStore.get(model.surfaceAtom)).toBe("jarvis");
    });

    it("reports a missing run and leaves the user where they were", async () => {
        const model = makeModel();
        const result = await openTarget(model, { kind: "run", runId: "r-gone" });
        expect(result).toEqual({ ok: false, reason: "unavailable", message: "That run no longer exists" });
        expect(globalStore.get(model.surfaceAtom)).toBe("cockpit");
        expect(pushToast).toHaveBeenCalledWith({ title: "That run no longer exists", message: "", level: "warn" });
    });

    it("reports a run that has no channel to open it in", async () => {
        const model = makeModel();
        objects.set("run:r1", { oid: "r1", channeloid: "" });
        expect(await openTarget(model, { kind: "run", runId: "r1" })).toEqual({
            ok: false,
            reason: "unavailable",
            message: "That run has no channel to open it in",
        });
        expect(globalStore.get(briefSheetOpenAtom)).toBe(false);
    });

    it("reports a channel that no longer exists", async () => {
        const model = makeModel();
        expect(await openTarget(model, { kind: "channel", channelId: "c-gone" })).toEqual({
            ok: false,
            reason: "unavailable",
            message: "That channel no longer exists",
        });
        expect(rpc.GetChannelRunsCommand).not.toHaveBeenCalled();
    });

    it("names the target when a load throws", async () => {
        const model = makeModel();
        loadAndPin.mockRejectedValue(new Error("db closed"));
        expect(await openTarget(model, { kind: "run", runId: "r1" })).toEqual({
            ok: false,
            reason: "failed",
            message: "Couldn't open run r1: db closed",
        });
        expect(pushToast).toHaveBeenCalledWith({
            title: "Couldn't open run r1: db closed",
            message: "",
            level: "error",
        });
    });
});

describe("agent landing", () => {
    it("focuses an agent still in the roster", async () => {
        const model = makeModel(["t1"]);
        expect(await openAddress(model, "tab:t1")).toEqual({ ok: true });
        expect(globalStore.get(model.focusIdAtom)).toBe("t1");
        expect(globalStore.get(model.surfaceAtom)).toBe("agent");
    });

    it("reports an agent that has left the roster", async () => {
        const model = makeModel(["t1"]);
        expect(await openAddress(model, "agent:t2")).toEqual({
            ok: false,
            reason: "unavailable",
            message: "That agent session has ended",
        });
        expect(globalStore.get(model.surfaceAtom)).toBe("cockpit");
    });
});

describe("record landing", () => {
    it("opens a decision's record in the peek with the decision anchored", async () => {
        const model = makeModel();
        globalStore.set(taskListAtom, [{ id: "task-a" } as SpaceSummary]);
        expect(await openAddress(model, "task:task-a", { sourceType: "decision", anchor: "dec-1" })).toEqual({
            ok: true,
        });
        expect(globalStore.get(briefPeekRecordAtom)).toBe("task-a");
        expect(globalStore.get(pendingDecisionAnchorAtom)).toBe("dec-1");
        expect(globalStore.get(model.surfaceAtom)).toBe("jarvis");
        expect(rpc.ListTaskDossiersCommand).not.toHaveBeenCalled();
    });

    it("loads the record list before calling a record gone, and says so", async () => {
        const model = makeModel();
        rpc.ListTaskDossiersCommand.mockResolvedValue({ dossiers: [{ id: "other" }] });
        expect(await openAddress(model, "task:task-a")).toEqual({
            ok: false,
            reason: "unavailable",
            message: "That record no longer exists",
        });
        expect(rpc.ListTaskDossiersCommand).toHaveBeenCalled();
        expect(globalStore.get(briefPeekRecordAtom)).toBeNull();
        expect(globalStore.get(model.surfaceAtom)).toBe("cockpit");
    });

    // the list loads once per Brief mount, so a record created since is not in it yet
    it("refreshes a loaded list once before calling a record gone", async () => {
        const model = makeModel();
        globalStore.set(taskListAtom, [{ id: "old" } as SpaceSummary]);
        rpc.ListTaskDossiersCommand.mockResolvedValue({ dossiers: [{ id: "old" }, { id: "task-new" }] });
        expect(await openAddress(model, "task:task-new")).toEqual({ ok: true });
        expect(globalStore.get(briefPeekRecordAtom)).toBe("task-new");
    });

    it("reports a list that failed to load as a failure, not as a missing record", async () => {
        const model = makeModel();
        rpc.ListTaskDossiersCommand.mockRejectedValue(new Error("vault locked"));
        const result = await openAddress(model, "task:task-a");
        expect(result.ok).toBe(false);
        expect("reason" in result ? result.reason : null).toBe("failed");
        expect("reason" in result ? result.message : "").toContain("record task-a");
    });

    it("a record target opens the Brief peek", async () => {
        const model = makeModel();
        globalStore.set(taskListAtom, [{ id: "task-a" } as SpaceSummary]);
        rpc.GetDossierCommand.mockResolvedValue({ id: "task-a", status: "active", decisions: [] });
        expect(await openTarget(model, { kind: "record", dossierId: "task-a" })).toEqual({ ok: true });
        expect(globalStore.get(briefPeekRecordAtom)).toBe("task-a");
        expect(globalStore.get(model.surfaceAtom)).toBe("jarvis");
        await vi.waitFor(() => expect(globalStore.get(recordDetailAtom)["task-a"]).toBeDefined());
    });
});

// memnote:/memory: still arrive from persisted turns and effort WorkRefs. They must refuse by name and
// leave the user where they were, rather than navigating somewhere that no longer exists.
describe("memory note landing", () => {
    it("refuses every memory spelling without moving the surface", async () => {
        for (const address of ["memnote:n1", "memory:n2"]) {
            const model = makeModel();
            expect(await openAddress(model, address)).toEqual({
                ok: false,
                reason: "unsupported",
                message: NO_MEMORY_SURFACE,
            });
            expect(globalStore.get(model.surfaceAtom)).toBe("cockpit");
        }
    });
});

describe("radar landing", () => {
    it("owns the report's project before selecting the report, so the project's newest does not win", async () => {
        const model = makeModel();
        seedReports();
        rpc.ListRadarReportsCommand.mockResolvedValue({ reports: REPORTS_B });
        expect(await openAddress(model, "radarreport:rb-old", { anchor: "f-1" })).toEqual({ ok: true });
        expect(rpc.ListRadarReportsCommand).toHaveBeenCalledWith(expect.anything(), { projectpath: "/b" });
        expect(globalStore.get(radarScopeAtom)).toEqual({ name: "b", path: "/b" });
        expect(globalStore.get(currentReportIdAtom)).toBe("rb-old");
        expect(globalStore.get(radarSelectedIdAtom)).toBe("f-1");
        expect(globalStore.get(model.surfaceAtom)).toBe("radar");
    });

    it("lands on the report and says so when the finding is no longer in it", async () => {
        const model = makeModel();
        seedReports();
        rpc.ListRadarReportsCommand.mockResolvedValue({ reports: REPORTS_B });
        expect(await openAddress(model, "radarreport:rb-old", { anchor: "f-gone" })).toEqual({
            ok: true,
            notice: "That finding is no longer in this report",
        });
        expect(globalStore.get(currentReportIdAtom)).toBe("rb-old");
        expect(globalStore.get(radarSelectedIdAtom)).toBeUndefined();
        expect(pushToast).toHaveBeenCalledWith({
            title: "That finding is no longer in this report",
            message: "",
            level: "info",
        });
    });

    it("reports a deleted report", async () => {
        const model = makeModel();
        expect(await openAddress(model, "radarreport:rr-gone")).toEqual({
            ok: false,
            reason: "unavailable",
            message: "That scan report no longer exists",
        });
    });

    it("is not overwritten by another project's report load still in flight", async () => {
        const model = makeModel();
        seedReports();
        globalStore.set(radarScopeAtom, { name: "a", path: "/a" });
        const slowA = deferred<{ reports: RadarReport[] }>();
        rpc.ListRadarReportsCommand.mockImplementation((_client: unknown, data: { projectpath: string }) =>
            data.projectpath === "/a" ? slowA.promise : Promise.resolve({ reports: REPORTS_B })
        );
        const loadingA = loadReports("/a");

        expect(await openAddress(model, "radarreport:rb-old", { anchor: "f-1" })).toEqual({ ok: true });

        slowA.resolve({ reports: [report("ra-new", "/a", 9)] });
        await loadingA;
        expect(globalStore.get(currentReportIdAtom)).toBe("rb-old");
        expect(globalStore.get(radarReportsAtom)?.map((r) => r.oid)).toEqual(["rb-new", "rb-old"]);
    });
});

describe("effort landing", () => {
    it("opens the initiative's sheet", async () => {
        const model = makeModel();
        expect(await openAddress(model, "effort:e-1")).toEqual({ ok: true });
        expect(globalStore.get(activeSubjectAtom)).toEqual({ kind: "effort", id: "e-1" });
        expect(globalStore.get(briefSheetOpenAtom)).toBe(true);
        expect(globalStore.get(model.surfaceAtom)).toBe("jarvis");
    });
});

describe("a newer open", () => {
    it("supersedes a landing still loading, which then writes and reports nothing", async () => {
        const model = makeModel(["t1"]);
        const slow = deferred<unknown>();
        objects.set("channel:c1", { oid: "c1" });
        loadAndPin.mockImplementation((oref: string) =>
            oref === "run:r-slow" ? slow.promise : Promise.resolve(objects.get(oref) ?? null)
        );
        const first = openTarget(model, { kind: "run", runId: "r-slow" });
        expect(await openTarget(model, { kind: "agent", tabId: "t1" })).toEqual({ ok: true });

        slow.resolve({ oid: "r-slow", channeloid: "c1" });
        expect(await first).toEqual({ ok: false, reason: "superseded", message: "" });
        expect(globalStore.get(model.surfaceAtom)).toBe("agent");
        expect(globalStore.get(briefSheetOpenAtom)).toBe(false);
        expect(rpc.GetChannelRunsCommand).not.toHaveBeenCalled();
        expect(pushToast).not.toHaveBeenCalled();
    });

    it("includes a click on an address nothing can open", async () => {
        const model = makeModel();
        const slow = deferred<unknown>();
        loadAndPin.mockImplementation(() => slow.promise);
        const first = openTarget(model, { kind: "run", runId: "r-slow" });
        await openAddress(model, "bogus:x");
        slow.resolve({ oid: "r-slow", channeloid: "c1" });
        expect(await first).toEqual({ ok: false, reason: "superseded", message: "" });
        expect(globalStore.get(model.surfaceAtom)).toBe("cockpit");
    });
});

describe("unsupported addresses", () => {
    it("reports an address nothing can open, and stays put", async () => {
        const model = makeModel();
        expect(await openAddress(model, "bogus:x")).toEqual({
            ok: false,
            reason: "unsupported",
            message: "This item can't be opened",
        });
        expect(pushToast).toHaveBeenCalledWith({ title: "This item can't be opened", message: "", level: "warn" });
        expect(globalStore.get(model.surfaceAtom)).toBe("cockpit");
    });

    it("hands the result to a caller that renders failure itself, instead of toasting", async () => {
        const model = makeModel();
        const report = vi.fn();
        await openAddress(model, "vault:dec-1", { sourceType: "decision" }, report);
        expect(report).toHaveBeenCalledWith({
            ok: false,
            reason: "unsupported",
            message: "This citation can't locate its record",
        });
        expect(pushToast).not.toHaveBeenCalled();
    });
});

describe("canvas landing", () => {
    const CWD = "C:\\p";
    const DIR = "C:\\p\\.superpowers\\design\\t";
    const caller = { blockId: "block-a1", cwd: CWD };
    const noReport = () => {};

    afterEach(() => {
        for (const id of ["a1", "a2", "t9"]) {
            detachCanvas(id);
        }
    });

    it("refuses a caller that is no roster agent, and changes nothing", async () => {
        const model = makeModel(["a1"]);
        const result = await openAddress(model, "canvas:t", { caller: { ...caller, blockId: "block-x" } }, noReport);
        expect("reason" in result ? result.reason : null).toBe("unavailable");
        expect("reason" in result ? result.message : "").toContain("wsh ui reveal canvas:t");
        expect(globalStore.get(model.surfaceAtom)).toBe("cockpit");
        expect(getCanvas("a1")).toBeNull();
        expect(rpc.FileInfoCommand).not.toHaveBeenCalled();
    });

    it("refuses a caller whose working directory is unknown", async () => {
        const model = makeModel(["a1"]);
        const result = await openAddress(model, "canvas:t", { caller: { ...caller, cwd: "" } }, noReport);
        expect("reason" in result ? result.message : "").toContain("wsh ui reveal canvas:t");
        expect(getCanvas("a1")).toBeNull();
    });

    it("refuses a canvas folder that does not exist, naming it", async () => {
        const model = makeModel(["a1"]);
        rpc.FileInfoCommand.mockResolvedValue({ notfound: true });
        const result = await openAddress(model, "canvas:t", { caller }, noReport);
        expect("reason" in result ? result.reason : null).toBe("unavailable");
        expect("reason" in result ? result.message : "").toContain(`${DIR}\\project`);
        expect(rpc.FileInfoCommand).toHaveBeenCalledWith(expect.anything(), {
            info: { path: `${DIR}\\project` },
        });
        expect(getCanvas("a1")).toBeNull();
        expect(globalStore.get(model.surfaceAtom)).toBe("cockpit");
    });

    it("attaches the caller's canvas without moving the user or leaving the terminal", async () => {
        const model = makeModel(["a1", "a2"]);
        globalStore.set(model.focusIdAtom, "a2");
        rpc.FileInfoCommand.mockResolvedValue({ path: "x" });
        expect(await openAddress(model, "canvas:t", { caller }, noReport)).toEqual({ ok: true });
        const s = getCanvas("a1");
        expect(s?.topic).toBe("t");
        expect(s?.dir).toBe(DIR);
        expect(s?.projectDir).toBe(CWD);
        expect(s?.mode).toBe("terminal");
        expect(globalStore.get(model.focusIdAtom)).toBe("a2");
        expect(globalStore.get(model.surfaceAtom)).toBe("cockpit");
    });

    it("leaves a canvas the user is already looking at in canvas mode", async () => {
        const model = makeModel(["a1"]);
        rpc.FileInfoCommand.mockResolvedValue({ path: "x" });
        attachCanvas("a1", { topic: "t", dir: DIR, projectDir: CWD }, 1);
        setCanvasMode("a1", "canvas", 2);
        expect(await openAddress(model, "canvas:t", { caller }, noReport)).toEqual({ ok: true });
        expect(getCanvas("a1")?.mode).toBe("canvas");
    });

    it("attaches a background terminal as readily as an agent", async () => {
        const model = makeModel(["a1"], ["t9"]);
        rpc.FileInfoCommand.mockResolvedValue({ path: "x" });
        const result = await openAddress(model, "canvas:t", { caller: { ...caller, blockId: "block-t9" } }, noReport);
        expect(result).toEqual({ ok: true });
        expect(getCanvas("t9")?.topic).toBe("t");
    });

    it("sets the board a reveal names", async () => {
        const model = makeModel(["a1"]);
        rpc.FileInfoCommand.mockResolvedValue({ path: "x" });
        expect(await openAddress(model, "canvas:t/States", { caller }, noReport)).toEqual({ ok: true });
        expect(getCanvas("a1")?.board).toBe("States.dc.html");
    });

    it("without a caller, lands on the agent that already has the canvas", async () => {
        const model = makeModel(["a1", "a2"]);
        attachCanvas("a2", { topic: "t", dir: DIR, projectDir: CWD }, 1);
        expect(await openAddress(model, "canvas:t", undefined, noReport)).toEqual({ ok: true });
        expect(getCanvas("a2")?.mode).toBe("canvas");
        expect(globalStore.get(model.focusIdAtom)).toBe("a2");
        expect(globalStore.get(model.surfaceAtom)).toBe("agent");
        expect(rpc.FileInfoCommand).not.toHaveBeenCalled();
    });

    it("without a caller or an owner, says no agent has it open", async () => {
        const model = makeModel(["a1"]);
        expect(await openAddress(model, "canvas:t", undefined, noReport)).toEqual({
            ok: false,
            reason: "unavailable",
            message: "No agent has the canvas t open",
        });
        expect(globalStore.get(model.surfaceAtom)).toBe("cockpit");
    });

    it("refuses a target built in code with a path in its topic", async () => {
        const model = makeModel(["a1"]);
        rpc.FileInfoCommand.mockResolvedValue({ path: "x" });
        const result = await openTarget(model, { kind: "canvas", topic: ".." }, noReport, caller);
        expect(result.ok).toBe(false);
        expect(rpc.FileInfoCommand).not.toHaveBeenCalled();
        expect(getCanvas("a1")).toBeNull();
    });
});
