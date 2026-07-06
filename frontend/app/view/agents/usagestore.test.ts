import { afterEach, describe, expect, it, vi } from "vitest";
import { globalStore } from "@/app/store/jotaiStore";

const getStats = vi.fn();
vi.mock("@/app/store/wshclientapi", () => ({
    RpcApi: { GetUsageStatsCommand: (...a: any[]) => getStats(...a) },
}));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));

import { loadUsage, usageErrorAtom, usageLoadedAtom, usageStatsAtom } from "./usagestore";

afterEach(() => {
    getStats.mockReset();
    globalStore.set(usageStatsAtom, {
        totals: { tokensToday: 0, tokensWeek: 0, spendTodayUsd: 0, spendWeekUsd: 0 },
        split: [],
        daily: [],
        dailyTruncated: false,
        providers: [],
    });
    globalStore.set(usageErrorAtom, false);
    globalStore.set(usageLoadedAtom, false);
});

describe("loadUsage", () => {
    it("aggregates returned buckets into the stats atom and clears the error flag", async () => {
        const sentinel = {
            totals: { tokensToday: -1, tokensWeek: -1, spendTodayUsd: 0, spendWeekUsd: 0 },
            split: [],
            daily: [],
            dailyTruncated: false,
            providers: [],
        };
        globalStore.set(usageStatsAtom, sentinel);
        globalStore.set(usageErrorAtom, true);
        getStats.mockResolvedValue({ buckets: [] }); // empty is a valid success -> atom replaced with zeros
        await loadUsage(7);
        expect(globalStore.get(usageStatsAtom)).not.toBe(sentinel); // success replaced the atom
        expect(globalStore.get(usageStatsAtom).totals.tokensToday).toBe(0);
        expect(globalStore.get(usageErrorAtom)).toBe(false);
        expect(globalStore.get(usageLoadedAtom)).toBe(true);
    });

    it("keeps the last-good stats and flags error when the RPC throws", async () => {
        const good = {
            totals: { tokensToday: 5, tokensWeek: 5, spendTodayUsd: 0, spendWeekUsd: 0 },
            split: [],
            daily: [],
            dailyTruncated: false,
            providers: [],
        };
        globalStore.set(usageStatsAtom, good);
        getStats.mockRejectedValue(new Error("network error"));
        await loadUsage(7);
        expect(globalStore.get(usageStatsAtom)).toEqual(good); // NOT clobbered with empty
        expect(globalStore.get(usageErrorAtom)).toBe(true);
        expect(globalStore.get(usageLoadedAtom)).toBe(true);
    });
});
