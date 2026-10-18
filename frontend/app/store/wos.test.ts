// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { atom } from "jotai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// each service fetch parks here until the test answers it with the response the backend "sent"
const inflight: Array<(resp: unknown) => void> = [];
const env = vi.hoisted(() => ({ endpoint: "http://wavesrv.test" as string | null }));

vi.mock("@/util/fetchutil", () => ({
    fetch: vi.fn(() => new Promise((resolve) => inflight.push(resolve))),
}));
vi.mock("@/util/endpoints", () => ({ getWebServerEndpoint: () => env.endpoint }));
vi.mock("@/app/store/windowtype", () => ({ isPreviewWindow: () => false }));

import { fetch } from "@/util/fetchutil";
import { globalStore } from "./jotaiStore";
import { callBackendService, getWaveObjectValue, loadAndPinWaveObject, updateWaveObject } from "./wos";

const settle = () => new Promise((r) => setTimeout(r, 0));

function answer(body: unknown) {
    inflight.shift()({ ok: true, json: async () => body });
}

function land(data: unknown) {
    answer({ data });
}

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
        land(null);
        await settle();
        expect(globalStore.get(wov.dataAtom).value).toBe(pushed);
    });

    it("keeps a pushed update when an older fetch fails after it", async () => {
        const { oref, oid } = freshRun();
        const wov = getWaveObjectValue(oref);
        const pushed = { otype: "run", oid, version: 1 } as unknown as WaveObj;
        updateWaveObject({ updatetype: "update", otype: "run", oid, obj: pushed } as WaveObjUpdate);
        inflight.shift()({ ok: false, status: 500, statusText: "boom" });
        await settle();
        expect(globalStore.get(wov.dataAtom)).toStrictEqual({ value: pushed, loading: false, error: false });
    });

    it("keeps a pushed delete when an older fetch resolves the object after it", async () => {
        const { oref, oid } = freshRun();
        const wov = getWaveObjectValue(oref);
        updateWaveObject({ updatetype: "delete", otype: "run", oid } as WaveObjUpdate);
        expect(globalStore.get(wov.dataAtom)).toStrictEqual({ value: null, loading: false, error: false });
        land({ otype: "run", oid, version: 1 });
        await settle();
        expect(globalStore.get(wov.dataAtom).value).toBeNull();
    });

    it("still lands a fetch nothing overtook", async () => {
        const { oref, oid } = freshRun();
        const wov = getWaveObjectValue(oref);
        const found = { otype: "run", oid, version: 3 };
        land(found);
        await settle();
        expect(globalStore.get(wov.dataAtom)).toEqual({ value: found, loading: false, error: false });
    });
});

describe("wos fetch on first read", () => {
    beforeEach(() => {
        inflight.length = 0;
    });

    it("starts loading, with no value and no error", () => {
        const { oref } = freshRun();
        const wov = getWaveObjectValue(oref);
        expect(globalStore.get(wov.dataAtom)).toStrictEqual({ value: null, loading: true, error: false });
    });

    it("lands a missing object as a loaded null, not an error", async () => {
        const { oref } = freshRun();
        const wov = getWaveObjectValue(oref);
        land(null);
        await settle();
        expect(globalStore.get(wov.dataAtom)).toStrictEqual({ value: null, loading: false, error: false });
    });

    it.each([
        ["type", (oid: string) => ({ otype: "block", oid, version: 1 })],
        ["id", () => ({ otype: "run", oid: "00000000-0000-4000-8000-ffffffffffff", version: 1 })],
    ])("refuses an object of the wrong %s and marks the read failed", async (_what, mkObj) => {
        const { oref, oid } = freshRun();
        const wov = getWaveObjectValue(oref);
        land(mkObj(oid));
        await settle();
        expect(globalStore.get(wov.dataAtom)).toStrictEqual({ value: null, loading: false, error: true });
    });
});

describe("updateWaveObject", () => {
    beforeEach(() => {
        inflight.length = 0;
    });

    it("ignores a null update", () => {
        expect(updateWaveObject(null)).toBeUndefined();
    });

    it("lands a valid update as loaded, without error", () => {
        const { oref, oid } = freshRun();
        const wov = getWaveObjectValue(oref);
        const obj = { otype: "run", oid, version: 1 } as unknown as WaveObj;
        updateWaveObject({ updatetype: "update", otype: "run", oid, obj } as WaveObjUpdate);
        expect(globalStore.get(wov.dataAtom)).toStrictEqual({ value: obj, loading: false, error: false });
    });

    it("keeps the newer object when an older version arrives", () => {
        const { oref, oid } = freshRun();
        const wov = getWaveObjectValue(oref);
        const v2 = { otype: "run", oid, version: 2 } as unknown as WaveObj;
        const v1 = { otype: "run", oid, version: 1 } as unknown as WaveObj;
        updateWaveObject({ updatetype: "update", otype: "run", oid, obj: v2 } as WaveObjUpdate);
        updateWaveObject({ updatetype: "update", otype: "run", oid, obj: v1 } as WaveObjUpdate);
        expect(globalStore.get(wov.dataAtom).value).toBe(v2);
    });

    it.each([
        ["a null object", () => null],
        ["a null otype", (oid: string) => ({ otype: null, oid, version: 1 })],
        ["an empty otype", (oid: string) => ({ otype: "", oid, version: 1 })],
        ["a null oid", () => ({ otype: "run", oid: null, version: 1 })],
        ["an empty oid", () => ({ otype: "run", oid: "", version: 1 })],
        ["a null version", (oid: string) => ({ otype: "run", oid, version: null })],
        ["a NaN version", (oid: string) => ({ otype: "run", oid, version: NaN })],
        ["a zero version", (oid: string) => ({ otype: "run", oid, version: 0 })],
    ])("drops an update carrying %s", (_what, mkObj) => {
        const { oref, oid } = freshRun();
        const wov = getWaveObjectValue(oref);
        updateWaveObject({ updatetype: "update", otype: "run", oid, obj: mkObj(oid) } as WaveObjUpdate);
        expect(globalStore.get(wov.dataAtom)).toStrictEqual({ value: null, loading: true, error: false });
    });
});

describe("callBackendService", () => {
    const serviceUrl = "http://wavesrv.test/wave/service?service=svc&method=M";
    const lastBody = () => JSON.parse((fetch as any).mock.lastCall[1].body);

    beforeEach(() => {
        inflight.length = 0;
        env.endpoint = "http://wavesrv.test";
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("posts the call to the service endpoint and resolves its data", async () => {
        const p = callBackendService("svc", "M", ["a", 1], true);
        expect(fetch).toHaveBeenLastCalledWith(serviceUrl, {
            method: "POST",
            body: JSON.stringify({ service: "svc", method: "M", args: ["a", 1], uicontext: null }),
        });
        land("result");
        expect(await p).toBe("result");
    });

    it("sends the window's ui context unless the call opts out", async () => {
        const uiContext = { windowid: "w1", activetabid: "t1" };
        vi.stubGlobal("window", { globalAtoms: { uiContext: atom(uiContext) } });
        void callBackendService("svc", "M", []);
        expect(lastBody().uicontext).toStrictEqual(uiContext);
        void callBackendService("svc", "M", [], true);
        expect(lastBody().uicontext).toBeNull();
    });

    it("throws before fetching when there is no web endpoint", () => {
        env.endpoint = null;
        (fetch as any).mockClear();
        expect(() => callBackendService("svc", "M", [])).toThrow("cannot call svc.M: no web endpoint");
        expect(fetch).not.toHaveBeenCalled();
    });

    it("rejects on a non-ok http status", async () => {
        const p = callBackendService("svc", "M", [], true);
        inflight.shift()({ ok: false, status: 500, statusText: "boom", json: async () => ({ data: 1 }) });
        await expect(p).rejects.toThrow("call svc.M failed: 500 boom");
    });

    it("resolves null for an empty response body", async () => {
        const p = callBackendService("svc", "M", [], true);
        answer(null);
        expect(await p).toBeNull();
    });

    it("rejects with the backend's error", async () => {
        const p = callBackendService("svc", "M", [], true);
        answer({ data: 1, error: "bad input" });
        await expect(p).rejects.toThrow("call svc.M error: bad input");
    });

    it("applies the object updates the response carries", async () => {
        const { oref, oid } = freshRun();
        const obj = { otype: "run", oid, version: 4 };
        const p = callBackendService("svc", "M", [], true);
        answer({ data: "ok", updates: [{ updatetype: "update", otype: "run", oid, obj }] });
        expect(await p).toBe("ok");
        expect(globalStore.get(getWaveObjectValue(oref).dataAtom).value).toStrictEqual(obj);
    });
});
