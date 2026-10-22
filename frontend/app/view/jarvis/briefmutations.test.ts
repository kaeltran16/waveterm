// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import {
    effortOps,
    mutationRunner,
    openChunkInPlan,
    stepTarget,
    trackerEdits,
    type EffortWrites,
    type MutationDeps,
} from "./briefmutations";
import { chunkKey, effortKey } from "./briefundo";
import type { ChunkRowModel } from "./effortstore";
import { chunkRowId, stageRowId } from "./inlinetracker";

const OREF = "effort:e1";
const LINE = "initiatives:" + OREF;

const chunk = (label: string, stage = "", status = "pending"): ChunkRowModel => ({
    label,
    status,
    stage,
    tone: "pending",
    trail: [],
    workrefs: [],
});

// runs: 0 = A[a,b], 1 = B[c]
const plan = [chunk("a", "A", "done"), chunk("b", "A"), chunk("c", "B")];

function fakeStore(): EffortWrites {
    const ok = () => vi.fn(() => Promise.resolve());
    return {
        setEffortStatus: ok(),
        unarchiveEffort: ok(),
        deleteEffort: ok(),
        setChunkStatus: ok(),
        renameChunk: ok(),
        moveChunk: ok(),
        moveChunkToStage: ok(),
        removeChunks: ok(),
        setChunkStage: ok(),
        addChunkAt: ok(),
    };
}

// run executes the write at once, so each test reads the store calls synchronously
function fakeDeps() {
    const deps = {
        store: fakeStore(),
        undo: { notify: vi.fn(), schedule: vi.fn(), error: vi.fn() },
        run: vi.fn((fn: () => Promise<void>) => void fn()),
        setError: vi.fn(),
        closeInitiative: vi.fn(),
    } satisfies MutationDeps;
    return deps;
}

// the undo a notify call registered
const undoOf = (deps: ReturnType<typeof fakeDeps>, call = 0): (() => void) => deps.undo.notify.mock.calls[call][1];

function editsFor(deps: MutationDeps, pending = new Set<string>()) {
    return trackerEdits(deps, {
        oref: OREF,
        effort: { title: "Ship it", status: "active" },
        chunks: plan,
        pendingDeletes: pending,
        ui: { onRename: vi.fn(), onDetails: vi.fn(), onActivity: vi.fn() },
    });
}

describe("mutationRunner", () => {
    it("clears the previous error and shows a rejected write's message", async () => {
        const setError = vi.fn();
        mutationRunner(setError)(() => Promise.reject(new Error("refused")));
        expect(setError).toHaveBeenLastCalledWith(null);
        await Promise.resolve();
        await Promise.resolve();
        expect(setError).toHaveBeenLastCalledWith("refused");
    });

    it("leaves the error cleared when the write succeeds", async () => {
        const setError = vi.fn();
        mutationRunner(setError)(() => Promise.resolve());
        await Promise.resolve();
        expect(setError.mock.calls).toEqual([[null]]);
    });
});

describe("effortOps", () => {
    it("pauses an active initiative, and its undo sets it back", () => {
        const deps = fakeDeps();
        effortOps(deps, OREF, "Ship it", "active").togglePause();
        expect(deps.store.setEffortStatus).toHaveBeenCalledWith(OREF, "paused");
        expect(deps.undo.notify.mock.calls[0][0]).toBe("Paused");
        undoOf(deps)();
        expect(deps.store.setEffortStatus).toHaveBeenLastCalledWith(OREF, "active");
    });

    it("resumes a paused initiative", () => {
        const deps = fakeDeps();
        effortOps(deps, OREF, "Ship it", "paused").togglePause();
        expect(deps.store.setEffortStatus).toHaveBeenCalledWith(OREF, "active");
        expect(deps.undo.notify.mock.calls[0][0]).toBe("Resumed");
    });

    it("archives, and its undo unarchives", () => {
        const deps = fakeDeps();
        effortOps(deps, OREF, "Ship it", "active").archive();
        expect(deps.store.setEffortStatus).toHaveBeenCalledWith(OREF, "archived");
        expect(deps.undo.notify.mock.calls[0][0]).toBe("Archived “Ship it”");
        undoOf(deps)();
        expect(deps.store.unarchiveEffort).toHaveBeenCalledWith(OREF);
    });

    it("deletes through the undo window and collapses the row first", () => {
        const deps = fakeDeps();
        effortOps(deps, OREF, "Ship it", "active").remove();
        expect(deps.closeInitiative).toHaveBeenCalledWith(LINE);
        const [keys, text, commit] = deps.undo.schedule.mock.calls[0];
        expect(keys).toEqual([effortKey(OREF)]);
        expect(text).toBe("Deleted “Ship it”");
        expect(deps.store.deleteEffort).not.toHaveBeenCalled();
        void commit();
        expect(deps.store.deleteEffort).toHaveBeenCalledWith(OREF);
    });
});

describe("trackerEdits", () => {
    it("names the plan it edits", () => {
        const e = editsFor(fakeDeps());
        expect(e.oid).toBe("e1");
        expect(e.total).toBe(3);
        expect(e.stages).toEqual(["A", "B"]);
        expect(e.effortStatus).toBe("active");
    });

    it("sets a chunk's status, and its undo restores the one it had", () => {
        const deps = fakeDeps();
        editsFor(deps).onSetStatus("a", "blocked");
        expect(deps.store.setChunkStatus).toHaveBeenCalledWith(OREF, "a", "blocked");
        expect(deps.undo.notify.mock.calls[0][0]).toBe("Marked “a” blocked");
        undoOf(deps)();
        expect(deps.store.setChunkStatus).toHaveBeenLastCalledWith(OREF, "a", "done");
    });

    it("moves a chunk inside its run, and its undo puts it back at its old position", () => {
        const deps = fakeDeps();
        const e = editsFor(deps);
        expect(e.canMove("a", "up")).toBe(false);
        expect(e.canMove("b", "down")).toBe(false);
        e.onMoveChunk("a", "down");
        expect(deps.store.moveChunk).toHaveBeenCalledWith(OREF, plan, "a", 2);
        undoOf(deps)();
        expect(deps.store.moveChunk).toHaveBeenLastCalledWith(OREF, plan, "a", 1);
    });

    it("does nothing for a move that has nowhere to go", () => {
        const deps = fakeDeps();
        editsFor(deps).onMoveChunk("a", "up");
        expect(deps.store.moveChunk).not.toHaveBeenCalled();
        expect(deps.undo.notify).not.toHaveBeenCalled();
    });

    it("moves a chunk to another stage, and its undo returns it to its own", () => {
        const deps = fakeDeps();
        editsFor(deps).onMoveToStage("a", "B");
        expect(deps.store.moveChunkToStage).toHaveBeenCalledWith(OREF, plan, "a", "B", 3);
        expect(deps.undo.notify.mock.calls[0][0]).toBe("Moved to B");
        undoOf(deps)();
        expect(deps.store.moveChunkToStage).toHaveBeenLastCalledWith(OREF, plan, "a", "A", 1);
    });

    it("deletes a chunk through the undo window", () => {
        const deps = fakeDeps();
        editsFor(deps).onDeleteChunk("b");
        const [keys, text, commit] = deps.undo.schedule.mock.calls[0];
        expect(keys).toEqual([chunkKey(OREF, "b")]);
        expect(text).toBe("Deleted “b”");
        void commit();
        expect(deps.store.removeChunks).toHaveBeenCalledWith(OREF, plan, ["b"]);
    });

    it("refuses to delete the last chunk left once pending deletes are counted", () => {
        const deps = fakeDeps();
        const pending = new Set([chunkKey(OREF, "a"), chunkKey(OREF, "b")]);
        editsFor(deps, pending).onDeleteChunk("c");
        expect(deps.setError).toHaveBeenCalledWith("An initiative keeps at least one chunk.");
        expect(deps.undo.schedule).not.toHaveBeenCalled();
    });

    it("deletes a whole stage run, naming the stage and its count", () => {
        const deps = fakeDeps();
        editsFor(deps).onDeleteStage(0);
        const [keys, text] = deps.undo.schedule.mock.calls[0];
        expect(keys).toEqual([chunkKey(OREF, "a"), chunkKey(OREF, "b")]);
        expect(text).toBe("Deleted stage “A” · 2 chunks");
    });

    it("renames a stage run's chunks together", () => {
        const deps = fakeDeps();
        editsFor(deps).onRenameStage(0, "Alpha");
        expect(deps.store.setChunkStage).toHaveBeenCalledWith(OREF, ["a", "b"], "Alpha");
    });

    it("adds a chunk at the end of a stage run, or at the end of the plan", () => {
        const deps = fakeDeps();
        const e = editsFor(deps);
        e.onAddChunk("x", "A", 0);
        expect(deps.store.addChunkAt).toHaveBeenCalledWith(OREF, "x", "A", 3);
        e.onAddChunk("y", "", null);
        expect(deps.store.addChunkAt).toHaveBeenLastCalledWith(OREF, "y", "", undefined);
    });

    it("hands the footer's status actions to the same ops the context menu uses", () => {
        const deps = fakeDeps();
        editsFor(deps).onDelete();
        expect(deps.closeInitiative).toHaveBeenCalledWith(LINE);
        expect(deps.undo.schedule.mock.calls[0][0]).toEqual([effortKey(OREF)]);
    });
});

describe("stepTarget", () => {
    const step = (label: string, dir: "prev" | "next", pending = new Set<string>()) =>
        stepTarget({ chunks: plan, pendingDeletes: pending, oref: OREF, lineId: LINE, label, dir });

    it("lands on the next chunk and unfolds the stage run it sits in", () => {
        expect(step("b", "next")).toEqual({ stageId: stageRowId(LINE, "B", 1), cursorId: chunkRowId(LINE, "c") });
    });

    it("skips a chunk waiting out its delete", () => {
        expect(step("a", "next", new Set([chunkKey(OREF, "b")]))).toEqual({
            stageId: stageRowId(LINE, "B", 1),
            cursorId: chunkRowId(LINE, "c"),
        });
    });

    it("has nowhere to go past either end", () => {
        expect(step("a", "prev")).toBeNull();
        expect(step("c", "next")).toBeNull();
    });
});

describe("openChunkInPlan", () => {
    function revealDeps(chunks: ChunkRowModel[]) {
        const calls: string[] = [];
        return {
            calls,
            deps: {
                closeSheet: vi.fn(() => void calls.push("close")),
                openInitiative: vi.fn((id: string) => void calls.push("open " + id)),
                setCursor: vi.fn((id: string) => void calls.push("cursor " + id)),
                loadPlan: vi.fn(async () => {
                    calls.push("load");
                    return chunks;
                }),
                openStage: vi.fn((id: string) => void calls.push("stage " + id)),
            },
        };
    }

    it("opens the initiative on the chunk, then unfolds the chunk's stage once the plan loads", async () => {
        const { calls, deps } = revealDeps(plan);
        await openChunkInPlan(deps, OREF, "c");
        expect(calls).toEqual([
            "close",
            "open " + LINE,
            "cursor " + chunkRowId(LINE, "c"),
            "load",
            "stage " + stageRowId(LINE, "B", 1),
        ]);
        expect(deps.loadPlan).toHaveBeenCalledWith(OREF);
    });

    it("unfolds nothing when the plan has no such chunk", async () => {
        const { deps } = revealDeps(plan);
        await openChunkInPlan(deps, OREF, "gone");
        expect(deps.openStage).not.toHaveBeenCalled();
    });
});
