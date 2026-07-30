// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pure geometry for the meter primitives (element/meter.tsx). Kept React-free so the segment and
// clamping rules are unit-testable on their own — the components are then thin enough to verify by eye.

export interface MeterSeg {
    key: string;
    value: number;
    fill: string; // tailwind utility class, e.g. "bg-accent"
}

export interface MeterSlice {
    key: string;
    fill: string;
    pct: number;
}

// Non-positive segments are dropped, not rendered at 0% width: StackedMeter puts a 2px gap between
// fills and a gap around a zero-width fill reads as a seam. Segments may under-fill the track (a
// partial-progress stack), so pct is not normalised to sum to 100.
export function meterSegments(segs: MeterSeg[], total?: number): MeterSlice[] {
    const live = segs.filter((s) => s.value > 0);
    const denom = total != null && total > 0 ? total : live.reduce((sum, s) => sum + s.value, 0);
    if (denom <= 0) return [];
    return live.map((s) => ({ key: s.key, fill: s.fill, pct: (s.value / denom) * 100 }));
}

export function meterPct(value: number): number {
    if (Number.isNaN(value)) return 0;
    return Math.min(100, Math.max(0, value));
}
