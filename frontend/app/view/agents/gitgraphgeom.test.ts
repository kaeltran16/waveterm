// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { assignLanes, type GraphCommit } from "./gitgraph";
import { graphGeometry } from "./gitgraphgeom";

const c = (hash: string, ...parents: string[]): GraphCommit => ({ hash, parents });
const OPTS = { rowH: 34, maxLanes: 7 };

describe("graphGeometry", () => {
    it("draws a straight segment between commits in the same lane", () => {
        const g = graphGeometry(assignLanes([c("a", "b"), c("b")]), OPTS);
        expect(g.edges).toHaveLength(1);
        // same lane => a plain move-line, no curve
        expect(g.edges[0].d).toBe("M13 17 L13 51");
        expect(g.edges[0].d).not.toContain("Q");
    });

    it("curves a segment that crosses lanes", () => {
        const g = graphGeometry(assignLanes([c("m", "a", "b"), c("a", "c"), c("b", "c"), c("c")]), OPTS);
        const crossing = g.edges.filter((e) => e.d.includes("Q"));
        expect(crossing.length).toBeGreaterThan(0);
    });

    it("skips a parent that is outside the loaded window", () => {
        const g = graphGeometry(assignLanes([c("a", "notloaded")]), OPTS);
        expect(g.edges).toHaveLength(0);
        expect(g.nodes).toHaveLength(1);
    });

    it("gives a merge node a larger radius", () => {
        const g = graphGeometry(assignLanes([c("m", "a", "b"), c("a", "c"), c("b", "c"), c("c")]), OPTS);
        expect(g.nodes[0].r).toBeGreaterThan(g.nodes[1].r);
    });

    it("derives gutter width from the lane cap, not the lane count", () => {
        const linear = graphGeometry(assignLanes([c("a", "b"), c("b")]), { rowH: 34, maxLanes: 1 });
        expect(linear.gutter).toBe(13 + 1 * 15 + 4);
        const wide = graphGeometry(assignLanes([c("a", "b"), c("b")]), { rowH: 34, maxLanes: 7 });
        expect(wide.gutter).toBeGreaterThan(linear.gutter);
    });

    it("folds lanes past the cap and counts them", () => {
        // six commits each on their own lane; cap at 3 so three fold
        const rows = assignLanes([c("a", "p1"), c("b", "p2"), c("c", "p3"), c("d", "p4"), c("e", "p5"), c("f", "p6")]);
        const g = graphGeometry(rows, { rowH: 34, maxLanes: 3 });
        expect(g.foldedCount).toBe(3);
        const xs = g.nodes.map((n) => n.x);
        // folded nodes clamp to the last drawable lane rather than running off the gutter
        expect(Math.max(...xs)).toBe(13 + 2 * 15);
        expect(g.nodes.filter((n) => n.folded)).toHaveLength(3);
    });

    it("adds divider height to the row below and to the total", () => {
        const plain = graphGeometry(assignLanes([c("a", "b"), c("b")]), OPTS);
        const withDiv = graphGeometry(
            assignLanes([{ hash: "a", parents: ["b"], divider: "session start" }, c("b")]),
            OPTS
        );
        expect(withDiv.height).toBe(plain.height + 30);
        expect(withDiv.nodes[1].y).toBe(plain.nodes[1].y + 30);
    });

    it("marks the working-tree row's edge as dashed", () => {
        const g = graphGeometry(assignLanes([{ hash: "wt", parents: ["a"], workingTree: true }, c("a")]), OPTS);
        expect(g.edges[0].dashed).toBe(true);
        expect(g.nodes[0].workingTree).toBe(true);
    });

    it("returns zero-size geometry for no rows", () => {
        const g = graphGeometry([], OPTS);
        expect(g.edges).toEqual([]);
        expect(g.nodes).toEqual([]);
        expect(g.foldedCount).toBe(0);
    });
});
