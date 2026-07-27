// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pure derive for the Jarvis vault graph (U3): render types, the base+bloom merge, and the
// attribution-edge visual mapping. No jotai, no RPC — unit-tested directly.

export type GKind = "task" | "decision" | "memory" | "run";

// force-graph render node: kind + label + degree (drives sizing); x/y are owned by the sim.
export type GNode = { id: string; kind: GKind; label: string; status?: string; deg: number; x?: number; y?: number };

// force-graph render link: source/target are ids pre-sim, node objects post-sim.
export type GLink = {
    source: string | GNode;
    target: string | GNode;
    kind: "wikilink" | "attribution";
    provenance?: string;
    bucket?: string;
    state?: string;
};

// stable identity for an edge (endpoints + kind) — dedup key when merging base + blooms.
export const linkKey = (l: GraphLink) => `${l.from}>${l.to}:${l.kind}`;

// Merge the base wikilink graph with every bloomed dossier's runs+attribution edges. Run nodes dedup
// by id (the same run may attribute to two focused tasks); links dedup by linkKey. Base links keep
// their order; bloomed links append.
export function mergeGraph(
    base: { nodes: GraphNode[]; links: GraphLink[] },
    blooms: Map<string, { runs: GraphNode[]; links: GraphLink[] }>
): { nodes: GraphNode[]; links: GraphLink[] } {
    const nodes = new Map<string, GraphNode>();
    for (const n of base.nodes) nodes.set(n.id, n);
    const links: GraphLink[] = [...base.links];
    const seen = new Set(base.links.map(linkKey));
    for (const { runs, links: elinks } of blooms.values()) {
        for (const r of runs) if (!nodes.has(r.id)) nodes.set(r.id, r);
        for (const l of elinks) {
            const k = linkKey(l);
            if (!seen.has(k)) {
                seen.add(k);
                links.push(l);
            }
        }
    }
    return { nodes: [...nodes.values()], links };
}

// the three encoded dimensions of an attribution edge — a wire GraphLink and a render GLink both
// satisfy this, so the renderer styles its own links without rebuilding a wire object
export type EdgeStyleInput = { provenance?: string; bucket?: string; state?: string };

// Visual props for an attribution edge: informing -> dashed (provisional), confirmed -> solid;
// bucket -> opacity + width; semantic provenance -> a distinct low-confidence hue (component picks it).
export function attributionStyle(l: EdgeStyleInput): {
    dashed: boolean;
    opacity: number;
    width: number;
    semantic: boolean;
} {
    const bucket = l.bucket ?? "weak";
    return {
        dashed: l.state === "informing",
        semantic: l.provenance === "semantic",
        opacity: bucket === "strong" ? 1 : bucket === "medium" ? 0.6 : 0.35,
        width: bucket === "strong" ? 1.4 : bucket === "medium" ? 1.0 : 0.7,
    };
}
