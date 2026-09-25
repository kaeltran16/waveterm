// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

// each GetObject fetch parks here until the test settles it with the object it "found"
const inflight: Array<(data: unknown) => void> = [];

vi.mock("@/util/fetchutil", () => ({
    fetch: vi.fn(
        () => new Promise((resolve) => inflight.push((data) => resolve({ ok: true, json: async () => ({ data }) })))
    ),
}));
vi.mock("@/util/endpoints", () => ({ getWebServerEndpoint: () => "http://wavesrv.test" }));
vi.mock("@/app/store/windowtype", () => ({ isPreviewWindow: () => false }));

import { globalStore } from "./jotaiStore";
import { getWaveObjectValue, loadAndPinWaveObject, updateWaveObject } from "./wos";

const settle = () => new Promise((r) => setTimeout(r, 0));

let n = 0;
function freshRun(): { oref: string; oid: string } {
    // the WOS cache is module-global: every case gets its own object
    const oid = `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
    return { oref: `run:${oid}`, oid };
}

describe("wos pushed update vs in-flight fetch", () => {
    beforeEach(() => {
        inflight.length = 0;
    });

    it("keeps a pushed update when an older fetch resolves null after it", async () => {
        const { oref, oid } = freshRun();
        const wov = getWaveObjectValue(oref);
        const pushed = { otype: "run", oid, version: 1 } as unknown as WaveObj;
        updateWaveObject({ updatetype: "update", otype: "run", oid, obj: pushed } as WaveObjUpdate);
        expect(await loadAndPinWaveObject(oref)).toBe(pushed);
        inflight.shift()(null);
        await settle();
        expect(globalStore.get(wov.dataAtom).value).toBe(pushed);
    });

    it("keeps a pushed delete when an older fetch resolves the object after it", async () => {
        const { oref, oid } = freshRun();
        const wov = getWaveObjectValue(oref);
        updateWaveObject({ updatetype: "delete", otype: "run", oid } as WaveObjUpdate);
        inflight.shift()({ otype: "run", oid, version: 1 });
        await settle();
        expect(globalStore.get(wov.dataAtom).value).toBeNull();
    });

    it("still lands a fetch nothing overtook", async () => {
        const { oref, oid } = freshRun();
        const wov = getWaveObjectValue(oref);
        const found = { otype: "run", oid, version: 3 };
        inflight.shift()(found);
        await settle();
        expect(globalStore.get(wov.dataAtom)).toEqual({ value: found, loading: false, error: false });
    });
});
