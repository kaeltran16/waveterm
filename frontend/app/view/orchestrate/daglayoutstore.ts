// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Where a person dragged a dag's nodes, kept per dag across modal sessions (atomWithStorage convention from
// themestore.ts). Only dragged nodes are stored, as offsets over the computed layout, so a task added to the
// plan later still gets its computed place.

import { atomWithStorage } from "jotai/utils";
import type { Point } from "./daglayout";

export const LAYOUT_RUNS_KEPT = 20;

export type Offsets = Record<string, Point>;
export type LayoutOffsetStore = Record<string, { at: number; offsets: Offsets }>;

export const dagLayoutOffsetsAtom = atomWithStorage<LayoutOffsetStore>("dag.layout.offsets", {});

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export function applyOffsets(base: Map<string, Point>, offsets: Offsets | undefined): Map<string, Point> {
    const out = new Map(base);
    for (const [id, off] of Object.entries(offsets ?? {})) {
        const p = base.get(id);
        if (p == null || !finite(off?.x) || !finite(off?.y)) continue;
        out.set(id, { x: p.x + off.x, y: p.y + off.y });
    }
    return out;
}

export function withOffsets(
    store: LayoutOffsetStore,
    dagOid: string,
    offsets: Offsets,
    nowMs: number
): LayoutOffsetStore {
    const next = { ...store };
    delete next[dagOid];
    if (Object.keys(offsets).length > 0) next[dagOid] = { at: nowMs, offsets };
    const keep = Object.entries(next)
        .sort((a, b) => b[1].at - a[1].at)
        .slice(0, LAYOUT_RUNS_KEPT);
    return Object.fromEntries(keep);
}
