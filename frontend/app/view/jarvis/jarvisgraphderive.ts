// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pure derive for the Jarvis vault graph (U3): render types, the base+bloom merge, and the
// attribution-edge visual mapping. No jotai, no RPC — unit-tested directly.

import { truncateTitle } from "./memgraphlayout";

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

// a wikilink is one relation whichever note wrote it, so A→B and B→A are one edge; an attribution
// edge is directed (record → run) and keeps its own key
const dedupKey = (l: GraphLink) => (l.kind === "wikilink" ? `${[l.from, l.to].sort().join("~")}:wikilink` : linkKey(l));

// Merge the base wikilink graph with every bloomed dossier's runs+attribution edges. Run nodes dedup
// by id (the same run may attribute to two focused tasks); links dedup by dedupKey. Base links keep
// their order; bloomed links append.
export function mergeGraph(
    base: { nodes: GraphNode[]; links: GraphLink[] },
    blooms: Map<string, { runs: GraphNode[]; links: GraphLink[] }>
): { nodes: GraphNode[]; links: GraphLink[] } {
    const nodes = new Map<string, GraphNode>();
    for (const n of base.nodes) nodes.set(n.id, n);
    const links: GraphLink[] = [];
    const seen = new Set<string>();
    const add = (l: GraphLink) => {
        const k = dedupKey(l);
        if (!seen.has(k)) {
            seen.add(k);
            links.push(l);
        }
    };
    base.links.forEach(add);
    for (const { runs, links: elinks } of blooms.values()) {
        for (const r of runs) if (!nodes.has(r.id)) nodes.set(r.id, r);
        elinks.forEach(add);
    }
    return { nodes: [...nodes.values()], links };
}

// What the canvas draws: the nodes with at least one link, plus the selected node, and the links among
// them. An isolated record carries no information on a map; it stays findable, and picking it draws it.
export function visibleGraph(
    merged: { nodes: GraphNode[]; links: GraphLink[] },
    selectedId: string | null
): { nodes: GraphNode[]; links: GraphLink[] } {
    const ids = new Set(merged.nodes.map((n) => n.id));
    const links = merged.links.filter((l) => ids.has(l.from) && ids.has(l.to));
    const linked = new Set(links.flatMap((l) => [l.from, l.to]));
    return { nodes: merged.nodes.filter((n) => linked.has(n.id) || n.id === selectedId), links };
}

export const KINDS = ["task", "decision", "memory", "run"] as const;

// the legend's kinds: only those drawn, in legend order
export function presentKinds(nodes: { kind: string }[]): GKind[] {
    const have = new Set(nodes.map((n) => n.kind));
    return KINDS.filter((k) => have.has(k));
}

// a node's title line: the label's first line cut as the canvas cuts it. A task's label is its record's
// whole objective, so this is what every list and the canvas show.
export const nodeTitle = (label: string) => truncateTitle(label.split("\n", 1)[0]);

// Find matches on the title line, so every listed match visibly contains the query.
export function matchNodes<N extends { label: string }>(nodes: N[], query: string): N[] {
    const q = query.trim().toLowerCase();
    if (q === "") return [];
    return nodes.filter((n) => nodeTitle(n.label).toLowerCase().includes(q));
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
