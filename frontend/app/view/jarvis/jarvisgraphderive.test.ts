import { describe, expect, it } from "vitest";
import {
    attributionStyle,
    linkKey,
    matchNodes,
    mergeGraph,
    nodeTitle,
    presentKinds,
    visibleGraph,
} from "./jarvisgraphderive";
import { truncateTitle } from "./memgraphlayout";

const base = {
    nodes: [
        { id: "t-1", kind: "task", label: "alpha" },
        { id: "m-1", kind: "memory", label: "m-1" },
    ] as GraphNode[],
    links: [{ from: "t-1", to: "m-1", kind: "wikilink" }] as GraphLink[],
};

describe("mergeGraph", () => {
    it("returns the base graph unchanged when no blooms", () => {
        const g = mergeGraph(base, new Map());
        expect(g.nodes.map((n) => n.id)).toEqual(["t-1", "m-1"]);
        expect(g.links).toHaveLength(1);
    });

    it("adds bloomed run nodes and attribution edges, deduping shared runs", () => {
        const blooms = new Map<string, { runs: GraphNode[]; links: GraphLink[] }>([
            [
                "t-1",
                {
                    runs: [{ id: "run:r1", kind: "run", label: "g1" }] as GraphNode[],
                    links: [
                        { from: "t-1", to: "run:r1", kind: "attribution", bucket: "strong", state: "confirmed" },
                    ] as GraphLink[],
                },
            ],
            [
                "t-2",
                {
                    runs: [{ id: "run:r1", kind: "run", label: "g1" }] as GraphNode[],
                    links: [
                        { from: "t-2", to: "run:r1", kind: "attribution", bucket: "weak", state: "informing" },
                    ] as GraphLink[],
                },
            ],
        ]);
        const g = mergeGraph(base, blooms);
        expect(g.nodes.filter((n) => n.id === "run:r1")).toHaveLength(1); // deduped
        expect(g.links).toHaveLength(3); // 1 wikilink + 2 attribution
    });

    it("dedups identical attribution edges by linkKey", () => {
        const l = { from: "t-1", to: "run:r1", kind: "attribution" } as GraphLink;
        const blooms = new Map([["t-1", { runs: [], links: [l, l] }]]);
        expect(mergeGraph({ nodes: [], links: [] }, blooms).links).toHaveLength(1);
    });
});

describe("mergeGraph edge dedupe", () => {
    const nodes = [
        { id: "a", kind: "task", label: "a" },
        { id: "b", kind: "decision", label: "b" },
    ] as GraphNode[];

    it("draws a wikilink written both ways as one edge", () => {
        const links = [
            { from: "a", to: "b", kind: "wikilink" },
            { from: "b", to: "a", kind: "wikilink" },
        ] as GraphLink[];
        expect(mergeGraph({ nodes, links }, new Map()).links).toEqual([links[0]]);
    });

    it("keeps attribution edges directed", () => {
        const links = [
            { from: "a", to: "b", kind: "attribution" },
            { from: "b", to: "a", kind: "attribution" },
        ] as GraphLink[];
        expect(mergeGraph({ nodes: [], links: [] }, new Map([["a", { runs: [], links }]])).links).toHaveLength(2);
    });
});

describe("visibleGraph", () => {
    const merged = {
        nodes: [
            { id: "t-1", kind: "task", label: "alpha" },
            { id: "d-1", kind: "decision", label: "beta" },
            { id: "lone", kind: "memory", label: "gamma" },
        ] as GraphNode[],
        links: [{ from: "t-1", to: "d-1", kind: "wikilink" }] as GraphLink[],
    };

    it("hides a node with no link", () => {
        const g = visibleGraph(merged, null);
        expect(g.nodes.map((n) => n.id)).toEqual(["t-1", "d-1"]);
        expect(g.links).toHaveLength(1);
    });

    it("draws an isolated node once it is selected", () => {
        expect(visibleGraph(merged, "lone").nodes.map((n) => n.id)).toEqual(["t-1", "d-1", "lone"]);
    });

    it("does not count a link to a node the vault does not hold", () => {
        const dangling = { ...merged, links: [{ from: "lone", to: "missing", kind: "wikilink" }] as GraphLink[] };
        const g = visibleGraph(dangling, null);
        expect(g.nodes).toEqual([]);
        expect(g.links).toEqual([]);
    });
});

describe("presentKinds", () => {
    it("lists only the kinds drawn, in legend order", () => {
        const nodes = [
            { id: "r", kind: "run", label: "" },
            { id: "t", kind: "task", label: "" },
        ] as GraphNode[];
        expect(presentKinds(nodes)).toEqual(["task", "run"]);
    });
});

describe("nodeTitle and matchNodes", () => {
    const long = "x".repeat(60);
    const nodes = [
        { id: "t-1", kind: "task", label: "Ship the graph\nbody mentions zebra" },
        { id: "t-2", kind: "task", label: `${long} zebra` },
        { id: "d-1", kind: "decision", label: "Zebra crossing" },
    ] as GraphNode[];

    it("is the label's first line, cut as the canvas cuts it", () => {
        expect(nodeTitle("Ship the graph\nmore")).toBe("Ship the graph");
        expect(nodeTitle(long)).toBe(truncateTitle(long));
    });

    it("matches only on the title line", () => {
        expect(matchNodes(nodes, "zebra").map((n) => n.id)).toEqual(["d-1"]);
        expect(matchNodes(nodes, "  SHIP ").map((n) => n.id)).toEqual(["t-1"]);
    });

    it("matches nothing for a blank query", () => {
        expect(matchNodes(nodes, "  ")).toEqual([]);
    });
});

describe("attributionStyle", () => {
    it("informing -> dashed, confirmed -> solid", () => {
        expect(
            attributionStyle({ from: "a", to: "b", kind: "attribution", state: "informing" } as GraphLink).dashed
        ).toBe(true);
        expect(
            attributionStyle({ from: "a", to: "b", kind: "attribution", state: "confirmed" } as GraphLink).dashed
        ).toBe(false);
    });
    it("bucket drives opacity + width; semantic flagged", () => {
        const weakSem = attributionStyle({
            from: "a",
            to: "b",
            kind: "attribution",
            bucket: "weak",
            provenance: "semantic",
        } as GraphLink);
        expect(weakSem.opacity).toBe(0.35);
        expect(weakSem.semantic).toBe(true);
        expect(
            attributionStyle({ from: "a", to: "b", kind: "attribution", bucket: "strong" } as GraphLink).opacity
        ).toBe(1);
    });
});

describe("attributionStyle by bucket", () => {
    const style = (over: { bucket?: string; provenance?: string; state?: string }) => attributionStyle(over);

    it("draws each bucket at its own opacity and width, an unknown or absent one as weak", () => {
        expect(style({ bucket: "strong" })).toEqual({ dashed: false, semantic: false, opacity: 1, width: 1.4 });
        expect(style({ bucket: "medium" })).toEqual({ dashed: false, semantic: false, opacity: 0.6, width: 1.0 });
        expect(style({ bucket: "weak" })).toEqual({ dashed: false, semantic: false, opacity: 0.35, width: 0.7 });
        expect(style({})).toEqual({ dashed: false, semantic: false, opacity: 0.35, width: 0.7 });
    });

    it("flags semantic only for the semantic provenance", () => {
        expect(style({ provenance: "semantic" }).semantic).toBe(true);
        expect(style({ provenance: "lexical" }).semantic).toBe(false);
    });
});

describe("linkKey", () => {
    it("distinguishes wikilink from attribution on the same endpoints", () => {
        expect(linkKey({ from: "a", to: "b", kind: "wikilink" } as GraphLink)).not.toEqual(
            linkKey({ from: "a", to: "b", kind: "attribution" } as GraphLink)
        );
    });
});
