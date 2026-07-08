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

// Map-style tiered label reveal: hubs are labeled at any practical zoom, mid-degree nodes from
// moderate zoom, leaves only when zoomed in — so the settled fit view names the landmarks instead
// of showing a wall of anonymous dots.
export function labelZoomThreshold(deg: number): number {
    if (deg >= 6) return 0.5;
    if (deg >= 3) return 0.8;
    if (deg >= 1) return 1.3;
    return 1.7;
}

export type XY = { x: number; y: number };

// deterministic small hash → [0, 1); Date.now/Math.random are banned here (stable re-layouts)
function hash01(s: string): number {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return ((h >>> 0) % 1000) / 1000;
}

// Initial position for a node when (re)building graph data: its own cached spot if we have one,
// else deterministically jittered off a cached linked neighbor so structural changes wobble
// locally instead of re-exploding the layout. Null → let d3's default placement handle it.
export function seedPosition(id: string, edges: MemEdge[], cache: Map<string, XY>): XY | null {
    const own = cache.get(id);
    if (own) return { ...own };
    for (const e of edges) {
        const other = e.from === id ? e.to : e.to === id ? e.from : null;
        if (!other) continue;
        const near = cache.get(other);
        if (near) {
            const ang = hash01(id) * 2 * Math.PI;
            const r = 20 + hash01(id + "*") * 20;
            return { x: near.x + Math.cos(ang) * r, y: near.y + Math.sin(ang) * r };
        }
    }
    return null;
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
