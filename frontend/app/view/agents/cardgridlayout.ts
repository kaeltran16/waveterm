// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The cockpit grid's pure layout geometry: ordered visible cards + per-card prefs + container size ->
// absolute pixel rects, plus the row-height / resize / full-width math the corner-drag engine
// (usecardresize.ts) and the surface (cockpitsurface.tsx) render from. Extracted from
// agentsviewmodel.ts; re-exported there so existing call sites are unchanged. Pure functions only —
// no React, no atoms.

import type { AgentVM, CardPref } from "./agentsviewmodel";

export const GRID_PAGE_ROWS = 3; // 2 columns × 3 rows = 6 rich cards fill one screen
export const GRID_MIN_ROW_PX = 96; // a row cannot be dragged smaller than this
export const GRID_ROW_GAP_PX = 14; // matches the grid's Tailwind gap-3.5
export const FULLWIDTH_DRAG_THRESHOLD_PX = 48; // corner drag past this (±) toggles full-width
export const FULLWIDTH_MAX_VIEWPORT_FRAC = 0.6; // a full-width card can't exceed this fraction of the viewport

/** Pure: split an ordered list round-robin into two columns (even index -> A, odd -> B). */
export function distributeColumns<T>(ordered: T[]): { colA: T[]; colB: T[] } {
    const colA: T[] = [];
    const colB: T[] = [];
    ordered.forEach((item, i) => (i % 2 === 0 ? colA : colB).push(item));
    return { colA, colB };
}

export interface CardRect {
    x: number;
    y: number;
    w: number;
    h: number;
}

export interface GridLayout {
    rects: Map<string, CardRect>;
    totalHeight: number;
    columnsAvail: number;
    colA: AgentVM[];
    colB: AgentVM[];
    fullWidth: AgentVM[];
}

/** Pure: ordered visible cards + prefs + container size -> absolute pixel rect per card id, plus the
 *  column partition (for the resize handlers) and the total content height (for the scroll canvas).
 *  Full-width cards float to a top stack spanning the width; the rest fill two independent columns
 *  below. Mirrors the render math this replaced in cockpitsurface.tsx. */
export function computeGridLayout(
    cards: AgentVM[],
    cardPrefs: Record<string, CardPref>,
    containerW: number,
    containerH: number
): GridLayout {
    const gap = GRID_ROW_GAP_PX;
    const rects = new Map<string, CardRect>();
    const weightOf = (id: string) => cardPrefs[id]?.heightWeight ?? 1;

    const fullWidth = cards.filter((c) => cardPrefs[c.id]?.fullWidth);
    const columnCards = cards.filter((c) => !cardPrefs[c.id]?.fullWidth);

    // full-width stack
    const pageRowPx = containerH / GRID_PAGE_ROWS;
    const fwMaxPx = FULLWIDTH_MAX_VIEWPORT_FRAC * containerH;
    let fwY = 0;
    for (const c of fullWidth) {
        const h = Math.min(fwMaxPx, Math.max(GRID_MIN_ROW_PX, pageRowPx * weightOf(c.id)));
        rects.set(c.id, { x: 0, y: fwY, w: containerW, h });
        fwY += h + gap;
    }
    const fwStackPx = fullWidth.length > 0 ? fwY - gap : 0; // drop trailing gap

    // two columns below the stack
    const colStartY = fwStackPx + (fullWidth.length > 0 ? gap : 0);
    const columnsAvail = Math.max(0, containerH - fwStackPx - (fullWidth.length > 0 ? gap : 0));
    const { colA, colB } = distributeColumns(columnCards);
    // a lone card would otherwise sit at half width with colB empty; let it span the full width
    const colW = columnCards.length === 1 ? containerW : (containerW - gap) / 2;

    const layoutColumn = (col: AgentVM[], x: number): number => {
        const avail = Math.max(0, columnsAvail - gap * Math.max(0, col.length - 1));
        const heights = rowHeightsPx(
            col.map((c) => weightOf(c.id)),
            avail
        );
        let y = colStartY;
        col.forEach((c, i) => {
            rects.set(c.id, { x, y, w: colW, h: heights[i] });
            y += heights[i] + gap;
        });
        return col.length > 0 ? y - gap : colStartY; // column bottom, no trailing gap
    };
    const bottomA = layoutColumn(colA, 0);
    const bottomB = layoutColumn(colB, colW + gap);

    const totalHeight = Math.max(containerH, bottomA, bottomB);
    return { rects, totalHeight, columnsAvail, colA, colB, fullWidth };
}

/** Pure: pixel height per row. When rows fit the page they divide `viewportPx` by weight (fills
 *  exactly). Beyond the page, each row keeps the page row-height (`viewportPx / pageRows`) scaled by
 *  its weight, so the total overflows and the container scrolls. `viewportPx` should already exclude
 *  inter-row gaps. */
export function rowHeightsPx(weights: number[], viewportPx: number, pageRows = GRID_PAGE_ROWS): number[] {
    if (weights.length === 0) {
        return [];
    }
    if (weights.length <= pageRows) {
        const total = weights.reduce((s, w) => s + w, 0);
        return weights.map((w) => (viewportPx * w) / total);
    }
    const base = viewportPx / pageRows;
    return weights.map((w) => base * w);
}

/** Pure: drag the boundary between row `i` and row `i+1` by `deltaPx`. Recomputes every row's height
 *  in pixels (so the returned weights share one scale) and shifts height across the dragged boundary
 *  only, clamping each neighbour to `minPx`. The result is a new pixel-scale weight array; the render
 *  path re-normalises it through `rowHeightsPx`, so absolute scale never matters. */
export function resizeRowWeights(
    weights: number[],
    i: number,
    deltaPx: number,
    viewportPx: number,
    minPx = GRID_MIN_ROW_PX,
    pageRows = GRID_PAGE_ROWS
): number[] {
    const px = rowHeightsPx(weights, viewportPx, pageRows);
    if (i < 0 || i + 1 >= px.length) {
        return weights;
    }
    const pair = px[i] + px[i + 1];
    const above = Math.max(minPx, Math.min(pair - minPx, px[i] + deltaPx));
    const next = px.slice();
    next[i] = above;
    next[i + 1] = pair - above;
    return next;
}

/** Pure: corner-drag hysteresis for the full-width toggle. Past +threshold -> true, past -threshold ->
 *  false; within the dead-zone the current state holds (so a vertical resize drag never flips it). */
export function nextFullWidth(current: boolean, dragDeltaPx: number, threshold = FULLWIDTH_DRAG_THRESHOLD_PX): boolean {
    if (dragDeltaPx > threshold) {
        return true;
    }
    if (dragDeltaPx < -threshold) {
        return false;
    }
    return current;
}

/** Pure: rescale weights to mean 1 so stored card weights stay ratio-scale. `resizeRowWeights`
 *  returns pixel-scale values; `rowHeightsPx` only re-normalises them in its fit branch (<= pageRows),
 *  so persisting pixel-scale weights would explode in the overflow branch (`base * w`). Callers must
 *  normalise before writing a resized weight back. Empty -> empty; a zero/negative mean -> all 1. */
export function normalizeWeights(weights: number[]): number[] {
    if (weights.length === 0) {
        return [];
    }
    const mean = weights.reduce((s, w) => s + w, 0) / weights.length;
    if (!(mean > 0)) {
        return weights.map(() => 1);
    }
    return weights.map((w) => w / mean);
}
