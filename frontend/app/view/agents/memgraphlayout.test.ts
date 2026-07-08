// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { degreeMap, graphSignature, labelZoomThreshold, seedPosition } from "./memgraphlayout";
import type { MemEdge } from "./memtypes";

describe("graphSignature", () => {
    const edges: MemEdge[] = [{ from: "a", to: "b" }];
    it("is stable across node-id ordering (same set -> same key, so the sim doesn't restart)", () => {
        expect(graphSignature(["a", "b", "c"], edges)).toBe(graphSignature(["c", "a", "b"], edges));
    });
    it("is stable across edge ordering", () => {
        const e1: MemEdge[] = [{ from: "a", to: "b" }, { from: "b", to: "c" }];
        const e2: MemEdge[] = [{ from: "b", to: "c" }, { from: "a", to: "b" }];
        expect(graphSignature(["a", "b", "c"], e1)).toBe(graphSignature(["a", "b", "c"], e2));
    });
    it("changes when a node is added or removed", () => {
        expect(graphSignature(["a", "b"], edges)).not.toBe(graphSignature(["a", "b", "c"], edges));
    });
    it("changes when the edge set changes", () => {
        expect(graphSignature(["a", "b"], [{ from: "a", to: "b" }])).not.toBe(graphSignature(["a", "b"], []));
    });
});

describe("degreeMap", () => {
    it("counts undirected degree per node", () => {
        const edges: MemEdge[] = [{ from: "a", to: "b" }, { from: "b", to: "c" }, { from: "a", to: "c" }];
        const deg = degreeMap(edges);
        expect(deg.get("a")).toBe(2);
        expect(deg.get("b")).toBe(2);
        expect(deg.get("c")).toBe(2);
    });
    it("is empty for no edges (isolated nodes read as degree 0 via ??)", () => {
        const deg = degreeMap([]);
        expect(deg.size).toBe(0);
        expect(deg.get("x") ?? 0).toBe(0);
    });
});

describe("labelZoomThreshold", () => {
    it("labels hubs before leaves (threshold non-increasing with degree)", () => {
        expect(labelZoomThreshold(10)).toBeLessThan(labelZoomThreshold(3));
        expect(labelZoomThreshold(3)).toBeLessThan(labelZoomThreshold(1));
        expect(labelZoomThreshold(1)).toBeLessThan(labelZoomThreshold(0));
    });
    it("labels hubs at typical fit-to-view zoom (below 1)", () => {
        expect(labelZoomThreshold(8)).toBeLessThanOrEqual(0.6);
    });
});

describe("seedPosition", () => {
    const cache = new Map([["a", { x: 100, y: -40 }]]);
    const edges: MemEdge[] = [{ from: "a", to: "b" }];

    it("returns the cached position for a cached node", () => {
        expect(seedPosition("a", edges, cache)).toEqual({ x: 100, y: -40 });
    });
    it("seeds an uncached node near a cached linked neighbor, not on top of it", () => {
        const p = seedPosition("b", edges, cache)!;
        expect(p).not.toBeNull();
        const dist = Math.hypot(p.x - 100, p.y + 40);
        expect(dist).toBeGreaterThan(0);
        expect(dist).toBeLessThan(60);
    });
    it("is deterministic for the same inputs", () => {
        expect(seedPosition("b", edges, cache)).toEqual(seedPosition("b", edges, cache));
    });
    it("spreads different new nodes around the same neighbor", () => {
        const e2: MemEdge[] = [
            { from: "a", to: "b" },
            { from: "a", to: "c" },
        ];
        expect(seedPosition("b", e2, cache)).not.toEqual(seedPosition("c", e2, cache));
    });
    it("returns null when neither the node nor any neighbor is cached", () => {
        expect(seedPosition("z", edges, cache)).toBeNull();
        expect(seedPosition("b", edges, new Map())).toBeNull();
    });
});
