// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    applyMemoryRow,
    memoryApplyingAtom,
    memoryBusyAtom,
    memoryErrorAtom,
    memoryFocusAtom,
    memoryOpenAtom,
    memoryProjectsAtom,
    memoryRefusedAtom,
    memoryRowResultsAtom,
    pressMemoryRow,
    undoMemoryBatch,
    undoMemoryLine,
} from "./memorystore";

vi.mock("@/app/store/wshclientapi", () => ({
    RpcApi: {
        DecideMemoryChangeCommand: vi.fn(),
        ListMemoryHygieneCommand: vi.fn(),
        CheckMemoryHygieneCommand: vi.fn(),
        ApplyMemoryRowCommand: vi.fn(),
        UndoMemoryBatchCommand: vi.fn(),
    },
}));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));
vi.mock("@/app/store/wps", () => ({ waveEventSubscribeSingle: vi.fn(() => () => {}) }));

const decide = vi.mocked(RpcApi.DecideMemoryChangeCommand);

function change(id: string, group: string, status = "open"): MemChange {
    return {
        id,
        kind: group === "switch" ? "settings" : "move-here",
        group,
        title: id,
        note: "",
        applylabel: "",
        effect: "",
        files: [],
        evidence: [],
        diffs: [],
        indexdelta: { lines: 0, bytes: 0 },
        ownindexdelta: { lines: 0, bytes: 0 },
        op: {} as MemOp,
        status,
        conflictfile: "",
        decidedat: 0,
        backupuntil: 0,
        applyid: "",
    };
}

function project(name: string, changes: MemChange[], split = false): MemHygieneProject {
    return {
        project: name,
        path: `C:\\src\\${name}`,
        checkedat: 1,
        nextcheckat: 2,
        checking: false,
        lasterror: "",
        memories: 0,
        sessions: 0,
        folder: `C:/claude/projects/${name}/memory`,
        sharedwith: split ? ["other"] : [],
        ownfolder: "",
        formershared: "",
        switchedat: 0,
        index: { exists: true, lines: 1, bytes: 1 },
        changes,
    };
}

beforeEach(() => {
    decide.mockReset();
    globalStore.set(memoryProjectsAtom, null);
    globalStore.set(memoryErrorAtom, null);
    globalStore.set(memoryOpenAtom, null);
    globalStore.set(memoryFocusAtom, null);
    globalStore.set(memoryRefusedAtom, null);
});

describe("row apply and batch undo", () => {
    const applyRow = vi.mocked(RpcApi.ApplyMemoryRowCommand);
    const undoBatch = vi.mocked(RpcApi.UndoMemoryBatchCommand);
    const MINUTE = 60_000;

    function rowResult(p: MemHygieneProject, over: Partial<MemRowResult> = {}): MemRowResult {
        return { project: p, stop: "", here: 0, total: 0, changed: 0, newer: 0, failed: "", error: "", ...over };
    }

    beforeEach(() => {
        applyRow.mockReset();
        undoBatch.mockReset();
        globalStore.set(memoryApplyingAtom, []);
        globalStore.set(memoryRowResultsAtom, {});
    });

    it("marks the row in flight, then stores the result and the project it returns", async () => {
        const before = project("mp", [change("m1", "shared"), change("s1", "switch")], true);
        const after = project("mp", [change("m1", "shared", "applied"), change("s1", "switch")], true);
        globalStore.set(memoryProjectsAtom, [before, project("other", [])]);
        let inFlight: string[] = [];
        const res = rowResult(after, { stop: "newer", here: 1, total: 1, newer: 2 });
        applyRow.mockImplementation(async () => {
            inFlight = globalStore.get(memoryApplyingAtom);
            return res;
        });

        await applyMemoryRow("mp", "split");

        expect(inFlight).toEqual(["split/mp"]);
        expect(applyRow.mock.calls[0][1]).toEqual({ project: "mp", row: "split", changeid: "" });
        expect(applyRow.mock.calls[0][2].timeout).toBeGreaterThanOrEqual(MINUTE);
        expect(globalStore.get(memoryApplyingAtom)).toEqual([]);
        expect(globalStore.get(memoryRowResultsAtom)).toEqual({ mp: res });
        expect(globalStore.get(memoryProjectsAtom)!.map((p) => p.changes[0]?.status)).toEqual(["applied", undefined]);
        expect(globalStore.get(memoryErrorAtom)).toBeNull();
    });

    it("on a thrown error, says where, clears the in-flight mark and drops the last result", async () => {
        globalStore.set(memoryProjectsAtom, [project("mp", [], true)]);
        globalStore.set(memoryRowResultsAtom, { mp: rowResult(project("mp", [], true), { stop: "failed" }) });
        applyRow.mockRejectedValue(new Error("apply already running"));

        await applyMemoryRow("mp", "doc", "d1");

        expect(applyRow.mock.calls[0][1]).toEqual({ project: "mp", row: "doc", changeid: "d1" });
        expect(globalStore.get(memoryApplyingAtom)).toEqual([]);
        expect(globalStore.get(memoryRowResultsAtom)).toEqual({});
        expect(globalStore.get(memoryErrorAtom)).toMatch(/mp.*apply already running/);
    });

    it("an undo replaces the project and drops its last row result", async () => {
        const undone = project("mp", [change("m1", "shared", "open")], true);
        globalStore.set(memoryProjectsAtom, [project("mp", [change("m1", "shared", "applied")], true)]);
        globalStore.set(memoryRowResultsAtom, { mp: rowResult(undone, { stop: "failed" }) });
        undoBatch.mockResolvedValue(undone);

        await undoMemoryBatch("mp", "b1");

        expect(undoBatch.mock.calls[0][1]).toEqual({ project: "mp", batchid: "b1", changeid: "" });
        expect(globalStore.get(memoryProjectsAtom)).toEqual([undone]);
        expect(globalStore.get(memoryRowResultsAtom)).toEqual({});
    });
});

describe("the page's keys and Undo", () => {
    const applyRow = vi.mocked(RpcApi.ApplyMemoryRowCommand);
    const undoBatch = vi.mocked(RpcApi.UndoMemoryBatchCommand);
    const NO_INDEX = { exists: false, lines: 0, bytes: 0 };

    function switched(undoblock?: MemUndoBlock): MemHygieneProject {
        const p = project("mp", [change("m1", "shared", "applied"), change("s1", "switch", "applied")], true);
        const batch: MemBatch = {
            id: "b1",
            kind: "split",
            at: Date.now(),
            changeids: ["m1", "s1"],
            skipped: [],
            indexbefore: NO_INDEX,
            indexafter: NO_INDEX,
            undoblock,
        };
        return { ...p, batches: [batch] };
    }

    beforeEach(() => {
        applyRow.mockReset();
        undoBatch.mockReset();
        globalStore.set(memoryBusyAtom, false);
        globalStore.set(memoryApplyingAtom, []);
        globalStore.set(memoryRowResultsAtom, {});
    });

    it("an Undo the model refuses shows the refusal and undoes nothing", () => {
        globalStore.set(memoryProjectsAtom, [switched({ project: "det", batchid: "c1", at: 1, memories: 2 })]);
        expect(undoMemoryLine("mp/b1")).toBe(true);
        expect(undoBatch).not.toHaveBeenCalled();
        expect(globalStore.get(memoryRefusedAtom)).toBe("mp/b1");
    });

    it("an Undo nothing refuses undoes the line's whole batch", () => {
        const p = switched();
        globalStore.set(memoryProjectsAtom, [p]);
        undoBatch.mockResolvedValue(p);
        expect(undoMemoryLine("mp/b1")).toBe(true);
        expect(undoBatch.mock.calls.map((c) => c[1])).toEqual([{ project: "mp", batchid: "b1", changeid: "" }]);
        expect(globalStore.get(memoryRefusedAtom)).toBeNull();
    });

    it("runs the opened row's button, and nothing while it is disabled or no row is opened", () => {
        const p = project("mp", [change("m1", "shared"), change("s1", "switch")], true);
        globalStore.set(memoryProjectsAtom, [p]);
        applyRow.mockResolvedValue({
            project: p,
            stop: "",
            here: 0,
            total: 0,
            changed: 0,
            newer: 0,
            failed: "",
            error: "",
        });
        expect(pressMemoryRow("primary")).toBe(false);
        globalStore.set(memoryOpenAtom, "split/mp");
        globalStore.set(memoryBusyAtom, true);
        expect(pressMemoryRow("primary")).toBe(false);
        globalStore.set(memoryBusyAtom, false);
        expect(pressMemoryRow("primary")).toBe(true);
        expect(applyRow.mock.calls.map((c) => c[1])).toEqual([{ project: "mp", row: "split", changeid: "" }]);
    });
});
