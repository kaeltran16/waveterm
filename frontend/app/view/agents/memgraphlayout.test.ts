// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { degreeMap, graphSignature } from "./memgraphlayout";
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
