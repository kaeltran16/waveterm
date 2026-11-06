// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.hoisted(() => ({ ResolveDossierEdgesCommand: vi.fn() }));
vi.mock("@/app/store/wshclientapi", () => ({ RpcApi: rpc }));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));

import { globalStore } from "@/app/store/jotaiStore";
import {
    focusDossier,
    graphBloomAtom,
    graphBloomStatusAtom,
    graphSelectedIdAtom,
    retryBloom,
    selectBloomedRun,
} from "./jarvisgraphstore";

const bloom = (dossierId: string, runIds: string[]) =>
    new Map([[dossierId, { runs: runIds.map((id) => ({ id }) as GraphNode), links: [] as GraphLink[] }]]);

const reset = () => {
    globalStore.set(graphSelectedIdAtom, null);
    globalStore.set(graphBloomAtom, new Map());
    globalStore.set(graphBloomStatusAtom, new Map());
};

describe("selectBloomedRun", () => {
    beforeEach(reset);

    it("selects the run node the bloom returned", () => {
        globalStore.set(graphBloomAtom, bloom("task-418", ["run:r1"]));
        expect(selectBloomedRun("task-418", "run:r1")).toBe(true);
        expect(globalStore.get(graphSelectedIdAtom)).toBe("run:r1");
    });

    // the base vault graph carries no run nodes at all, so a run the bloom did not return has no node
    // anywhere: selecting it would leave the header naming a node the canvas never draws.
    it("leaves the selection alone when the bloom has no such run", () => {
        globalStore.set(graphBloomAtom, bloom("task-418", ["run:r1"]));
        expect(selectBloomedRun("task-418", "run:r9")).toBe(false);
        expect(globalStore.get(graphSelectedIdAtom)).toBeNull();
    });

    it("leaves the selection alone when the record never bloomed", () => {
        expect(selectBloomedRun("task-418", "run:r1")).toBe(false);
        expect(globalStore.get(graphSelectedIdAtom)).toBeNull();
    });
});

type Edges = { runs: GraphNode[]; links: GraphLink[] };
const edges = (runId: string): Edges => ({ runs: [{ id: runId } as GraphNode], links: [] });

// a call the test settles by hand, so two blooms can overlap in a chosen order
function deferred() {
    let resolve!: (v: Edges) => void;
    let reject!: (e: Error) => void;
    const promise = new Promise<Edges>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

describe("focusDossier bloom", () => {
    beforeEach(() => {
        reset();
        rpc.ResolveDossierEdgesCommand.mockReset();
        vi.spyOn(console, "warn").mockImplementation(() => {});
    });
    afterEach(() => vi.restoreAllMocks());

    it("lands both of two overlapping blooms", async () => {
        const a = deferred();
        const b = deferred();
        rpc.ResolveDossierEdgesCommand.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
        const pa = focusDossier("task-a");
        const pb = focusDossier("task-b");
        expect(globalStore.get(graphBloomStatusAtom).get("task-a")).toBe("loading");
        expect(globalStore.get(graphBloomStatusAtom).get("task-b")).toBe("loading");
        b.resolve(edges("run:b"));
        a.resolve(edges("run:a"));
        await Promise.all([pa, pb]);
        const map = globalStore.get(graphBloomAtom);
        expect([...map.keys()].sort()).toEqual(["task-a", "task-b"]);
        expect(globalStore.get(graphBloomStatusAtom).size).toBe(0);
    });

    it("leaves a rejected bloom failed, with no bloom, and says which record", async () => {
        rpc.ResolveDossierEdgesCommand.mockRejectedValueOnce(new Error("EC-TIME"));
        await focusDossier("task-a");
        expect(globalStore.get(graphBloomStatusAtom).get("task-a")).toBe("failed");
        expect(globalStore.get(graphBloomAtom).has("task-a")).toBe(false);
        expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("task-a"), expect.anything());
    });

    it("lands the bloom on a retry after a failure and clears the status", async () => {
        rpc.ResolveDossierEdgesCommand.mockRejectedValueOnce(new Error("EC-TIME"));
        await focusDossier("task-a");
        rpc.ResolveDossierEdgesCommand.mockResolvedValueOnce(edges("run:a"));
        await retryBloom("task-a");
        expect(
            globalStore
                .get(graphBloomAtom)
                .get("task-a")
                ?.runs.map((r) => r.id)
        ).toEqual(["run:a"]);
        expect(globalStore.get(graphBloomStatusAtom).has("task-a")).toBe(false);
    });

    it("gives the bloom call the longer bloom budget", async () => {
        rpc.ResolveDossierEdgesCommand.mockResolvedValueOnce(edges("run:a"));
        await focusDossier("task-a");
        expect(rpc.ResolveDossierEdgesCommand).toHaveBeenCalledWith({}, { dossierid: "task-a" }, { timeout: 15000 });
    });
});
