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
