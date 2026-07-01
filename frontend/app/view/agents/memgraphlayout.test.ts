// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { degreeMap } from "./memgraphlayout";
import type { MemEdge } from "./memtypes";

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
