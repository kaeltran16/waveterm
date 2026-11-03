// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEffortSync, EFFORT_SYNC_WINDOW_MS, flushEffortSync, type EffortSyncDeps } from "./effortsync";

const summary = (oref: string, updatedts: number) => ({ oref, updatedts }) as EffortSummary;

function fakeDeps(over: Partial<EffortSyncDeps> = {}) {
    const calls = { reloads: 0, lists: 0, refreshed: [] as [string, number][], dropped: [] as string[] };
    const deps: EffortSyncDeps = {
        surface: () => "jarvis",
        cachedORefs: () => [],
        listEfforts: async () => {
            calls.lists++;
            return [];
        },
        reloadBriefing: async () => {
            calls.reloads++;
        },
        refreshDetail: async (oref, ts) => {
            calls.refreshed.push([oref, ts]);
        },
        dropDetails: (orefs) => {
            calls.dropped.push(...orefs);
        },
        ...over,
    };
    return { deps, calls };
}

describe("flushEffortSync", () => {
    it("reloads the briefing on the Brief and re-reads the effort list", async () => {
        const { deps, calls } = fakeDeps();
        await flushEffortSync(deps);
        expect(calls.reloads).toBe(1);
        expect(calls.lists).toBe(1);
    });

    it("leaves the briefing alone off the Brief, which reloads on entry", async () => {
        const { deps, calls } = fakeDeps({ surface: () => "agent" });
        await flushEffortSync(deps);
        expect(calls.reloads).toBe(0);
        expect(calls.lists).toBe(1);
    });

    it("refreshes each cached detail with its listed updatedts and drops the deleted ones", async () => {
        const { deps, calls } = fakeDeps({
            cachedORefs: () => ["effort:a", "effort:gone", "effort:b"],
            listEfforts: async () => [summary("effort:a", 10), summary("effort:b", 20), summary("effort:uncached", 30)],
        });
        await flushEffortSync(deps);
        expect(calls.refreshed).toEqual([
            ["effort:a", 10],
            ["effort:b", 20],
        ]);
        expect(calls.dropped).toEqual(["effort:gone"]);
    });

    it("keeps the cache when the list fails rather than reading every entry as deleted", async () => {
        const err = vi.spyOn(console, "error").mockImplementation(() => {});
        const { deps, calls } = fakeDeps({
            cachedORefs: () => ["effort:a"],
            listEfforts: async () => {
                throw new Error("EC-TIME");
            },
        });
        await flushEffortSync(deps);
        expect(calls.dropped).toEqual([]);
        expect(calls.refreshed).toEqual([]);
        expect(err).toHaveBeenCalled();
        err.mockRestore();
    });

    it("one failed refresh does not stop the others", async () => {
        const err = vi.spyOn(console, "error").mockImplementation(() => {});
        const refreshed: string[] = [];
        const { deps } = fakeDeps({
            cachedORefs: () => ["effort:a", "effort:b"],
            listEfforts: async () => [summary("effort:a", 1), summary("effort:b", 2)],
            refreshDetail: async (oref) => {
                if (oref === "effort:a") throw new Error("boom");
                refreshed.push(oref);
            },
        });
        await flushEffortSync(deps);
        expect(refreshed).toEqual(["effort:b"]);
        expect(err).toHaveBeenCalledWith(expect.stringContaining("effort:a"), expect.any(Error));
        err.mockRestore();
    });
});

describe("createEffortSync", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("turns a burst of events into one flush after the window", async () => {
        const { deps, calls } = fakeDeps();
        const sync = createEffortSync(deps);
        for (let i = 0; i < 10; i++) {
            sync.poke();
            await vi.advanceTimersByTimeAsync(EFFORT_SYNC_WINDOW_MS / 20);
        }
        expect(calls.lists).toBe(0);
        await vi.advanceTimersByTimeAsync(EFFORT_SYNC_WINDOW_MS);
        expect(calls.lists).toBe(1);
        expect(calls.reloads).toBe(1);
    });

    it("a steady stream still flushes once per window instead of waiting for it to stop", async () => {
        const { deps, calls } = fakeDeps();
        const sync = createEffortSync(deps);
        const windows = 4;
        for (let t = 0; t < windows * EFFORT_SYNC_WINDOW_MS; t += EFFORT_SYNC_WINDOW_MS / 5) {
            sync.poke();
            await vi.advanceTimersByTimeAsync(EFFORT_SYNC_WINDOW_MS / 5);
        }
        expect(calls.lists).toBeGreaterThanOrEqual(windows - 1);
        expect(calls.lists).toBeLessThanOrEqual(windows);
    });

    it("cancel stops a pending flush", async () => {
        const { deps, calls } = fakeDeps();
        const sync = createEffortSync(deps);
        sync.poke();
        sync.cancel();
        await vi.advanceTimersByTimeAsync(EFFORT_SYNC_WINDOW_MS * 2);
        expect(calls.lists).toBe(0);
    });
});
