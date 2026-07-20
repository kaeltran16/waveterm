// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

// selectNote fires MemoryReadCommand over TabRpcClient; stub the RPC layer so the test
// exercises only the synchronous atom side-effects (open drawer, clear edit state).
vi.mock("@/app/store/wshclientapi", () => ({
    RpcApi: { MemoryReadCommand: vi.fn().mockResolvedValue({ body: "", note: { updatedts: 0 } }) },
}));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));

import { globalStore } from "@/app/store/jotaiStore";
import {
    advanceSelection,
    memConflictAtom,
    memEditingAtom,
    memNotesAtom,
    memRailOpenAtom,
    selectNote,
    sortArchived,
} from "./memstore";
import type { MemNote } from "./memtypes";

const note = (id: string): MemNote =>
    ({ id, path: `/vault/${id}.md`, source: "vault", title: id, description: "", type: "user", scope: "global", updatedts: 0 }) as MemNote;

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
