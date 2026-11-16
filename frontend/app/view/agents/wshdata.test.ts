// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// vitest has no DOM here, so a useWshData reader is driven through requestWshData, the call its effect makes on
// each render, and read back through the atom it renders.

import { globalStore } from "@/app/store/jotaiStore";
import { describe, expect, it, vi } from "vitest";
import { requestWshData, seedWshData, WSH_DATA_TTL_MS, wshDataAtom } from "./wshdata";

const read = (key: string) => globalStore.get(wshDataAtom(key));

function deferred<T>() {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => (resolve = r));
    return { promise, resolve };
}

describe("wshdata", () => {
    it("two readers of one key cause one fetch", async () => {
        const d = deferred<string>();
        const fetch = vi.fn(() => d.promise);
        requestWshData("k:dedupe", fetch);
        requestWshData("k:dedupe", fetch);
        expect(read("k:dedupe").status).toBe("loading");
        d.resolve("v");
        await vi.waitFor(() => expect(read("k:dedupe")).toEqual({ status: "ready", data: "v" }));
        requestWshData("k:dedupe", fetch);
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it("a seeded key never fetches", () => {
        seedWshData({ "k:seed": { id: 1 } });
        const fetch = vi.fn(() => Promise.resolve({ id: 2 }));
        requestWshData("k:seed", fetch, Date.now() + 10 * WSH_DATA_TTL_MS);
        expect(fetch).not.toHaveBeenCalled();
        expect(read("k:seed")).toEqual({ status: "ready", data: { id: 1 } });
    });

    it("a rejected fetch yields error with its message", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        requestWshData("k:fail", () => Promise.reject(new Error("no such effort")));
        await vi.waitFor(() => expect(read("k:fail").status).toBe("error"));
        expect(read("k:fail").error).toBe("no such effort");
        expect(warn).toHaveBeenCalledTimes(1);
        warn.mockRestore();
    });

    it("after the TTL a render refetches and keeps the old data until it lands", async () => {
        requestWshData("k:ttl", () => Promise.resolve("old"));
        await vi.waitFor(() => expect(read("k:ttl").data).toBe("old"));

        const d = deferred<string>();
        const fetch = vi.fn(() => d.promise);
        requestWshData("k:ttl", fetch, Date.now() + WSH_DATA_TTL_MS - 1_000);
        expect(fetch).not.toHaveBeenCalled();

        requestWshData("k:ttl", fetch, Date.now() + WSH_DATA_TTL_MS + 1);
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(read("k:ttl")).toEqual({ status: "ready", data: "old" });
        d.resolve("new");
        await vi.waitFor(() => expect(read("k:ttl").data).toBe("new"));
    });
});
