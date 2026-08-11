// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

// selectNote fires MemoryReadCommand over TabRpcClient; stub the RPC layer so the test
// exercises only the synchronous atom side-effects (open drawer, clear edit state). The
// mutation helpers fire MemoryDeleteCommand on the same client.
vi.mock("@/app/store/wshclientapi", () => ({
    RpcApi: {
        MemoryReadCommand: vi.fn().mockResolvedValue({ body: "", note: { updatedts: 0 } }),
        MemoryDeleteCommand: vi.fn().mockResolvedValue(undefined),
    },
}));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));

import { globalStore } from "@/app/store/jotaiStore";
import {
    advanceSavedSelection,
    advanceSelection,
    deleteNote,
    dismissPending,
    memConflictAtom,
    memEdgesAtom,
    memEditingAtom,
    memNotesAtom,
    memPendingAtom,
    memRailOpenAtom,
    memSelectedIdAtom,
    memSelectedPendingPathAtom,
    removeNoteFromGraph,
    selectNote,
    sortArchived,
} from "./memstore";
import type { MemNote } from "./memtypes";

const note = (id: string): MemNote =>
    ({ id, path: `/vault/${id}.md`, source: "vault", title: id, description: "", type: "user", scope: "global", updatedts: 0 }) as MemNote;

const pending = (path: string): MemoryPendingNote =>
    ({ path, title: path, type: "learning", scope: "", source: "agent", body: "x", capturedat: "" }) as MemoryPendingNote;

describe("memstore drawer + edit state", () => {
    beforeEach(() => {
        globalStore.set(memNotesAtom, [note("a"), note("b")]);
        // simulate a collapsed drawer with a stale edit session, then verify selectNote resets it
        globalStore.set(memRailOpenAtom, false);
        globalStore.set(memEditingAtom, true);
        globalStore.set(memConflictAtom, true);
    });

    it("selectNote opens the drawer and clears stale edit state", async () => {
        await selectNote("a");
        expect(globalStore.get(memRailOpenAtom)).toBe(true);
        expect(globalStore.get(memEditingAtom)).toBe(false);
        expect(globalStore.get(memConflictAtom)).toBe(false);
    });
});

describe("advanceSelection", () => {
    const paths = ["a", "b", "c"];
    it("picks the note that shifts into the removed index", () => {
        expect(advanceSelection(paths, "b", "s1")).toEqual({ pendingPath: "c", savedId: null });
    });
    it("falls back to the previous when the last is removed", () => {
        expect(advanceSelection(paths, "c", "s1")).toEqual({ pendingPath: "b", savedId: null });
    });
    it("falls back to the first saved when the queue empties", () => {
        expect(advanceSelection(["a"], "a", "s1")).toEqual({ pendingPath: null, savedId: "s1" });
    });
    it("returns null saved when nothing remains", () => {
        expect(advanceSelection(["a"], "a", null)).toEqual({ pendingPath: null, savedId: null });
    });
});

describe("sortArchived", () => {
    it("orders newest archivedat first and does not mutate input", () => {
        const input = [
            { id: "a", title: "A", reason: "decay", archivedat: "2026-07-01T00:00:00Z", path: "/x/a", originhub: "/h" },
            { id: "b", title: "B", reason: "drift", archivedat: "2026-07-19T00:00:00Z", path: "/x/b", originhub: "/h" },
        ] as MemoryArchivedNote[];
        const out = sortArchived(input);
        expect(out.map((n) => n.id)).toEqual(["b", "a"]);
        expect(input[0].id).toBe("a"); // input untouched
    });
});

describe("advanceSavedSelection", () => {
    const ids = ["a", "b", "c"];
    it("picks the note that shifts into the removed index", () => {
        expect(advanceSavedSelection(ids, "b")).toBe("c");
    });
    it("falls back to the previous when the last is removed", () => {
        expect(advanceSavedSelection(ids, "c")).toBe("b");
    });
    it("falls back to the first when nothing shifts in", () => {
        expect(advanceSavedSelection(ids, "a")).toBe("b");
    });
    it("returns null when the list empties", () => {
        expect(advanceSavedSelection(["a"], "a")).toBeNull();
    });
    it("returns null when the id is absent", () => {
        expect(advanceSavedSelection(ids, "zz")).toBeNull();
    });
});

describe("removeNoteFromGraph", () => {
    it("drops the note and any edge touching it", () => {
        const notes = [note("a"), note("b"), note("c")];
        const edges = [
            { from: "a", to: "b" },
            { from: "b", to: "c" },
            { from: "c", to: "a" },
        ];
        const { notes: outNotes, edges: outEdges } = removeNoteFromGraph(notes, edges, new Set(["b"]));
        expect(outNotes.map((n) => n.id)).toEqual(["a", "c"]);
        expect(outEdges).toEqual([{ from: "c", to: "a" }]); // only the edge touching b goes
    });
    it("leaves edges untouched when the removed id is absent", () => {
        const notes = [note("a")];
        const edges = [{ from: "a", to: "b" }];
        const { notes: outNotes, edges: outEdges } = removeNoteFromGraph(notes, edges, new Set(["zz"]));
        expect(outNotes).toHaveLength(1);
        expect(outEdges).toEqual(edges);
    });
});

describe("deleteNote local update", () => {
    beforeEach(() => {
        globalStore.set(memNotesAtom, [note("a"), note("b"), note("c")]);
        globalStore.set(memEdgesAtom, [
            { from: "a", to: "b" },
            { from: "c", to: "a" },
        ]);
    });

    it("removes the note and its edges locally, no rescan, and advances selection", async () => {
        globalStore.set(memSelectedIdAtom, "b");
        await deleteNote("/vault/b.md");
        expect(globalStore.get(memNotesAtom).map((n) => n.id)).toEqual(["a", "c"]);
        expect(globalStore.get(memEdgesAtom)).toEqual([{ from: "c", to: "a" }]); // only the edge touching b goes
        expect(globalStore.get(memSelectedIdAtom)).toBe("c"); // note that shifted into b's slot
    });

    it("keeps the selection when the deleted note was not selected", async () => {
        globalStore.set(memSelectedIdAtom, "a");
        await deleteNote("/vault/b.md");
        expect(globalStore.get(memSelectedIdAtom)).toBe("a");
    });

    it("clears selection when the last note is deleted", async () => {
        globalStore.set(memNotesAtom, [note("a")]);
        globalStore.set(memEdgesAtom, []);
        globalStore.set(memSelectedIdAtom, "a");
        await deleteNote("/vault/a.md");
        expect(globalStore.get(memNotesAtom)).toEqual([]);
        expect(globalStore.get(memSelectedIdAtom)).toBeNull();
    });
});

describe("dismissPending local update", () => {
    beforeEach(() => {
        globalStore.set(memPendingAtom, [pending("/p/a.md"), pending("/p/b.md")]);
    });

    it("removes the pending locally, no rescan, and advances to the shifted-in candidate", async () => {
        globalStore.set(memSelectedPendingPathAtom, "/p/a.md");
        await dismissPending("/p/a.md");
        expect(globalStore.get(memPendingAtom).map((p) => p.path)).toEqual(["/p/b.md"]);
        expect(globalStore.get(memSelectedPendingPathAtom)).toBe("/p/b.md");
    });
});
