// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Dependency-free force-directed layout (Fruchterman-Reingold with cluster seeding). Pure + deterministic:
// initial positions are seeded from a hash of the node id (no Math.random), so tests are stable and the
// graph doesn't jump between renders. We minimize deps per project convention — no d3-force.

import type { MemEdge, MemNote } from "./memtypes";

export type Point = { x: number; y: number };
export type LayoutOpts = { width: number; height: number; iterations: number };

// deterministic [0,1) from a string
function hash01(s: string): number {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return ((h >>> 0) % 100000) / 100000;
}

export function layoutGraph(notes: MemNote[], edges: MemEdge[], opts: LayoutOpts): Map<string, Point> {
    const { width, height, iterations } = opts;
    const pos = new Map<string, Point>();
    if (notes.length === 0) return pos;

    // seed: cluster by scope into rough columns, jitter deterministically by id hash
    const scopes = [...new Set(notes.map((n) => n.scope || "shared"))];
    const colOf = new Map(scopes.map((s, i) => [s, (i + 1) / (scopes.length + 1)]));
    for (const n of notes) {
        const cx = (colOf.get(n.scope || "shared") ?? 0.5) * width;
        pos.set(n.id, {
            x: cx + (hash01(n.id) - 0.5) * width * 0.25,
            y: (0.15 + 0.7 * hash01(n.id + "y")) * height,
        });
    }
    if (notes.length === 1) {
        pos.set(notes[0].id, { x: width / 2, y: height / 2 });
        return pos;
    }

    const area = width * height;
    const k = Math.sqrt(area / notes.length); // ideal edge length
    const ids = notes.map((n) => n.id);
    let temp = width / 10;
    const cool = temp / (iterations + 1);

    for (let it = 0; it < iterations; it++) {
        const disp = new Map<string, Point>(ids.map((id) => [id, { x: 0, y: 0 }]));
        // repulsion (all pairs)
        for (let i = 0; i < ids.length; i++) {
            for (let j = i + 1; j < ids.length; j++) {
                const a = pos.get(ids[i])!;
                const b = pos.get(ids[j])!;
                let dx = a.x - b.x;
                let dy = a.y - b.y;
                let dist = Math.hypot(dx, dy) || 0.01;
                const rep = (k * k) / dist;
                dx = (dx / dist) * rep;
                dy = (dy / dist) * rep;
                const da = disp.get(ids[i])!;
                const db = disp.get(ids[j])!;
                da.x += dx; da.y += dy;
                db.x -= dx; db.y -= dy;
            }
        }
        // attraction (edges)
        for (const e of edges) {
            const a = pos.get(e.from);
            const b = pos.get(e.to);
            if (!a || !b) continue;
            let dx = a.x - b.x;
            let dy = a.y - b.y;
            const dist = Math.hypot(dx, dy) || 0.01;
            const att = (dist * dist) / k;
            dx = (dx / dist) * att;
            dy = (dy / dist) * att;
            const da = disp.get(e.from)!;
            const db = disp.get(e.to)!;
            da.x -= dx; da.y -= dy;
            db.x += dx; db.y += dy;
        }
        // apply, capped by temperature, clamped to bounds
        for (const id of ids) {
            const d = disp.get(id)!;
            const p = pos.get(id)!;
            const len = Math.hypot(d.x, d.y) || 0.01;
            p.x += (d.x / len) * Math.min(len, temp);
            p.y += (d.y / len) * Math.min(len, temp);
            p.x = Math.max(20, Math.min(width - 20, p.x));
            p.y = Math.max(20, Math.min(height - 20, p.y));
        }
        temp -= cool;
    }
    return pos;
}
