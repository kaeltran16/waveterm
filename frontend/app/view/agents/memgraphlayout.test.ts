// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { layoutGraph } from "./memgraphlayout";
import type { MemEdge, MemNote } from "./memtypes";

const note = (id: string, scope: string): MemNote => ({
    id, title: id, description: "", type: "project", scope,
    source: "vault", path: `/v/${id}.md`, links: [], updatedts: 0,
});

describe("layoutGraph", () => {
    it("returns a finite position for every node, within bounds", () => {
        const notes = [note("a", "shared"), note("b", "proj"), note("c", "proj")];
        const edges: MemEdge[] = [{ from: "a", to: "b" }, { from: "b", to: "c" }];
        const pos = layoutGraph(notes, edges, { width: 880, height: 560, iterations: 60 });
        for (const n of notes) {
            const p = pos.get(n.id)!;
            expect(Number.isFinite(p.x)).toBe(true);
            expect(Number.isFinite(p.y)).toBe(true);
            expect(p.x).toBeGreaterThanOrEqual(0);
            expect(p.x).toBeLessThanOrEqual(880);
            expect(p.y).toBeGreaterThanOrEqual(0);
            expect(p.y).toBeLessThanOrEqual(560);
        }
    });
    it("is deterministic (same input → same output)", () => {
        const notes = [note("a", "shared"), note("b", "proj")];
        const edges: MemEdge[] = [{ from: "a", to: "b" }];
        const opts = { width: 800, height: 500, iterations: 40 };
        const p1 = layoutGraph(notes, edges, opts);
        const p2 = layoutGraph(notes, edges, opts);
        expect(p1.get("a")).toEqual(p2.get("a"));
        expect(p1.get("b")).toEqual(p2.get("b"));
    });
    it("handles the empty and single-node cases", () => {
        expect(layoutGraph([], [], { width: 800, height: 500, iterations: 10 }).size).toBe(0);
        const one = layoutGraph([note("solo", "shared")], [], { width: 800, height: 500, iterations: 10 });
        expect(one.get("solo")).toBeDefined();
    });
});
