// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

// the loaders reach the vault over RPC; these tests cover only the synchronous selection guard.
vi.mock("@/app/store/wshclientapi", () => ({ RpcApi: {} }));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));

import { globalStore } from "@/app/store/jotaiStore";
import { graphBloomAtom, graphSelectedIdAtom, selectBloomedRun } from "./jarvisgraphstore";

const bloom = (dossierId: string, runIds: string[]) =>
    new Map([[dossierId, { runs: runIds.map((id) => ({ id }) as GraphNode), links: [] as GraphLink[] }]]);

describe("selectBloomedRun", () => {
    beforeEach(() => {
        globalStore.set(graphSelectedIdAtom, null);
        globalStore.set(graphBloomAtom, new Map());
    });

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
