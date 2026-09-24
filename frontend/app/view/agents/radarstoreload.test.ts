// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    initRadarScope,
    initRadarScopeFromNewest,
    loadReports,
    radarLoadErrorAtom,
    radarReportsAtom,
    radarScopeAtom,
} from "./radarstore";

vi.mock("@/app/store/wshclientapi", () => ({ RpcApi: { ListRadarReportsCommand: vi.fn() } }));

describe("radar report loading", () => {
    beforeEach(() => {
        vi.mocked(RpcApi.ListRadarReportsCommand).mockReset();
        globalStore.set(radarScopeAtom, { name: "p", path: "/p" });
        globalStore.set(radarReportsAtom, null);
        globalStore.set(radarLoadErrorAtom, null);
    });

    it("a failed list read is an error, and the list stays not-fetched rather than empty", async () => {
        vi.mocked(RpcApi.ListRadarReportsCommand).mockRejectedValueOnce(new Error("boom"));
        await loadReports("/p");
        expect(globalStore.get(radarReportsAtom)).toBeNull();
        expect(globalStore.get(radarLoadErrorAtom)).toContain("boom");
    });

    it("a successful read clears an earlier error", async () => {
        globalStore.set(radarLoadErrorAtom, "old");
        vi.mocked(RpcApi.ListRadarReportsCommand).mockResolvedValueOnce({ reports: [] } as any);
        await loadReports("/p");
        expect(globalStore.get(radarReportsAtom)).toEqual([]);
        expect(globalStore.get(radarLoadErrorAtom)).toBeNull();
    });

    it("no scope at all is a loaded empty list, so never-scanned is honest", async () => {
        await initRadarScope(null);
        expect(globalStore.get(radarReportsAtom)).toEqual([]);
    });

    it("a failed newest-scanned lookup is an error, not a never-scanned landing", async () => {
        globalStore.set(radarScopeAtom, null);
        vi.mocked(RpcApi.ListRadarReportsCommand).mockRejectedValueOnce(new Error("down"));
        await initRadarScopeFromNewest();
        expect(globalStore.get(radarReportsAtom)).toBeNull();
        expect(globalStore.get(radarLoadErrorAtom)).toContain("down");
    });
});
