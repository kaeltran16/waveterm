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
import { memConflictAtom, memEditingAtom, memNotesAtom, memRailOpenAtom, selectNote } from "./memstore";
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
