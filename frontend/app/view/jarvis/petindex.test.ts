// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getStatus = vi.fn();
const reconcile = vi.fn();

vi.mock("@/app/store/wshclientapi", () => ({
    RpcApi: {
        GetEmbedIndexStatusCommand: (...a: any[]) => getStatus(...a),
        EmbedReconcileCommand: (...a: any[]) => reconcile(...a),
    },
}));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));

import { loadAndCatchUpIndex } from "./petindex";
import { petActStateAtom, petEventsAtom, petIndexAtom } from "./petstore";

const status = (over: Partial<EmbedIndexStatus>): EmbedIndexStatus =>
    ({
        state: "ok",
        indexednodes: 0,
        vaultnodes: 0,
        stalenodes: 0,
        enabled: true,
        haskey: true,
        ...over,
    }) as EmbedIndexStatus;

beforeEach(() => {
    vi.useFakeTimers();
    getStatus.mockReset();
    reconcile.mockReset();
    globalStore.set(petIndexAtom, null);
    globalStore.set(petActStateAtom, {});
    globalStore.set(petEventsAtom, []);
});

afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
});

describe("loadAndCatchUpIndex", () => {
    it("automatically starts catch-up when the status read finds stale content", async () => {
        getStatus.mockResolvedValue(status({ state: "stale", reason: "content-drift", stalenodes: 3 }));
        reconcile.mockResolvedValue(undefined);

        expect(await loadAndCatchUpIndex()).toBe(true);

        expect(reconcile).toHaveBeenCalledTimes(1);
        expect(globalStore.get(petActStateAtom)["recall:catchup"]).toEqual({
            status: "running",
            text: "catching up",
        });
    });

    it.each([status({ state: "ok" }), status({ state: "off", reason: "provider-error" })])(
        "does not spend an embedding call for status $state/$reason",
        async (indexStatus) => {
            getStatus.mockResolvedValue(indexStatus);

            expect(await loadAndCatchUpIndex()).toBe(true);

            expect(reconcile).not.toHaveBeenCalled();
        }
    );

    it("reports a refused automatic dispatch on the existing catch-up action", async () => {
        getStatus.mockResolvedValue(status({ state: "stale", reason: "not-built", stalenodes: 4 }));
        reconcile.mockRejectedValue(new Error("provider unavailable"));

        expect(await loadAndCatchUpIndex()).toBe(true);

        expect(globalStore.get(petActStateAtom)["recall:catchup"]).toEqual({
            status: "error",
            text: "provider unavailable",
        });
    });

    it("announces once when the catch-up reaches ok", async () => {
        getStatus
            .mockResolvedValueOnce(status({ state: "stale", reason: "content-drift", stalenodes: 2 }))
            .mockResolvedValueOnce(status({ state: "ok", indexednodes: 12, vaultnodes: 12 }));
        reconcile.mockResolvedValue(undefined);

        await loadAndCatchUpIndex();
        await vi.advanceTimersByTimeAsync(30_000);

        expect(globalStore.get(petActStateAtom)["recall:catchup"]).toBeUndefined();
        expect(globalStore.get(petEventsAtom)).toEqual([
            expect.objectContaining({
                kind: "recall-ready",
                text: "Recall is caught up — I can use your latest vault changes.",
            }),
        ]);

        await vi.advanceTimersByTimeAsync(30_000);
        expect(globalStore.get(petEventsAtom)).toHaveLength(1);
    });

    it("stops without announcing when the provider reports a failure", async () => {
        getStatus
            .mockResolvedValueOnce(status({ state: "stale", reason: "content-drift", stalenodes: 2 }))
            .mockResolvedValueOnce(status({ state: "off", reason: "provider-error" }));
        reconcile.mockResolvedValue(undefined);

        await loadAndCatchUpIndex();
        await vi.advanceTimersByTimeAsync(30_000);

        expect(globalStore.get(petActStateAtom)["recall:catchup"]).toBeUndefined();
        expect(globalStore.get(petEventsAtom)).toEqual([]);
    });

    it("gives up after the bounded watch window", async () => {
        getStatus.mockResolvedValue(status({ state: "stale", reason: "content-drift", stalenodes: 2 }));
        reconcile.mockResolvedValue(undefined);

        await loadAndCatchUpIndex();
        await vi.advanceTimersByTimeAsync(12 * 60_000 + 30_000);

        expect(globalStore.get(petActStateAtom)["recall:catchup"]).toBeUndefined();
        expect(globalStore.get(petEventsAtom)).toEqual([]);
    });
});
