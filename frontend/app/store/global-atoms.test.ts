// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAtoms } from "./global-atoms";
import { globalStore } from "./jotaiStore";
import { getWaveObjectValue } from "./wos";
import { fetch } from "@/util/fetchutil";

vi.mock("@/util/fetchutil", () => ({ fetch: vi.fn() }));

describe("global-atoms", () => {
    it("throws before initialization", () => {
        expect(() => getAtoms()).toThrow("Global atoms accessed before initialization");
    });
});

describe("wos reject-then-retry", () => {
    const block: WaveObj = { otype: "block", oid: "b1", version: 1, meta: {} };
    const oref = "block:b1";

    const okResponse = (data: WaveObj) => ({ ok: true, json: async () => ({ data, error: null }) });

    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("leaves the atom cleared (not loading) and drops the cache so a remount retries", async () => {
        // the transport fails on first load; an unhandled rejection would otherwise leave loading true forever
        (fetch as any).mockRejectedValueOnce(new Error("backend down"));
        const failed = getWaveObjectValue(oref);
        await expect(failed.pendingPromise).rejects.toThrow("backend down");
        expect(globalStore.get(failed.dataAtom)).toEqual({ value: null, loading: false, error: true });

        // the cache entry is gone, so a fresh getWaveObjectValue triggers a new fetch (no stale wov)
        (fetch as any).mockResolvedValueOnce(okResponse(block));
        const retried = getWaveObjectValue(oref);
        expect(retried.pendingPromise).toBeInstanceOf(Promise);
        await expect(retried.pendingPromise).resolves.toEqual(block);
        expect(globalStore.get(retried.dataAtom)).toEqual({ value: block, loading: false, error: false });
    });
});
