// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pure graph helper for the memory graph. Layout + pan/zoom are handled by react-force-graph-2d;
// this only derives link-count (degree), which drives node sizing.

import type { MemEdge } from "./memtypes";

// undirected degree per node id; nodes absent from any edge are omitted (read as 0 via `?? 0`).
export function degreeMap(edges: MemEdge[]): Map<string, number> {
    const deg = new Map<string, number>();
    for (const e of edges) {
        deg.set(e.from, (deg.get(e.from) ?? 0) + 1);
        deg.set(e.to, (deg.get(e.to) ?? 0) + 1);
    }
    return deg;
}

// Order-independent structural key for the current graph (sorted node ids + sorted edge keys). The graph
// component memoizes its node/link objects on this, so re-renders that don't change the *set* (hover,
// resize, a 1s now-tick, a search keystroke that doesn't change the results) reuse the same objects
// instead of rebuilding them — which would reset react-force-graph's in-place x/y and restart the
// simulation. That restart-on-every-render is the "clank". Titles are intentionally excluded.
export function graphSignature(nodeIds: string[], edges: MemEdge[]): string {
    const nodes = [...nodeIds].sort().join(",");
    const links = edges.map((e) => `${e.from}>${e.to}`).sort().join(",");
    return `${nodes}|${links}`;
}
