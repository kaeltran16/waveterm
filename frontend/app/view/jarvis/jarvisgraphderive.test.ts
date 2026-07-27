import { describe, expect, it } from "vitest";
import { attributionStyle, linkKey, mergeGraph } from "./jarvisgraphderive";

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

describe("linkKey", () => {
    it("distinguishes wikilink from attribution on the same endpoints", () => {
        expect(linkKey({ from: "a", to: "b", kind: "wikilink" } as GraphLink)).not.toEqual(
            linkKey({ from: "a", to: "b", kind: "attribution" } as GraphLink)
        );
    });
});
