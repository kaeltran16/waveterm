// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The cockpit grid's corner-resize geometry engine. A corner drag writes card heights straight to
// bound motion values (no per-frame React re-render); ratio-scale weights commit to cardPrefs on
// pointer-up. isResizing suspends the layout spring + render-time MV sync so a background re-render
// can't snap a card back mid-drag. Extracted from cockpitsurface.tsx.

import { motionValue, type MotionValue } from "motion/react";
import { useRef, useState } from "react";
import {
    FULLWIDTH_DRAG_THRESHOLD_PX,
    GRID_MIN_ROW_PX,
    GRID_ROW_GAP_PX,
    normalizeWeights,
    resizeRowWeights,
    type CardPref,
    type CardRect,
} from "./agentsviewmodel";

// per-id geometry motion values, persisted across renders (a move retargets these; it never
// remounts the card). The corner drag writes h/y directly; every other change is retargeted in
// renderCard (in the surface).
type GeomMV = { x: MotionValue<number>; y: MotionValue<number>; w: MotionValue<number>; h: MotionValue<number> };

export function useCardResize(params: {
    rects: Map<string, CardRect>;
    cardPrefs: Record<string, CardPref>;
    setCardPrefs: (u: (p: Record<string, CardPref>) => Record<string, CardPref>) => void;
    colA: { id: string }[];
    colB: { id: string }[];
    columnsAvail: number;
    pageRowPx: number;
    fwMaxPx: number;
    gridViewportW: number;
}): {
    isResizing: boolean;
    activeResizeId: string | undefined;
    getGeom: (id: string, r: CardRect) => GeomMV;
    beginCardResize: (id: string) => void;
    dragResizeMove: (id: string, dx: number, dy: number) => void;
    endCardResize: (id: string, full: boolean) => void;
} {
    const { rects, cardPrefs, setCardPrefs, colA, colB, columnsAvail, pageRowPx, fwMaxPx, gridViewportW } = params;

    // snapshot of the card group being corner-resized, captured on pointer-down so the drag applies an
    // absolute delta to a stable baseline (no drift as pointermove reads updated prefs)
    const resizeSnapRef = useRef<
        | { kind: "fw"; startPx: number }
        | { kind: "col"; ids: string[]; weights: number[]; avail: number; colStartY: number }
        | null
    >(null);
    // corner-drag writes card heights straight to bound motion values (no per-frame React re-render); the
    // ratio-scale weights are committed to cardPrefs once on pointer-up. isResizing suspends the layout
    // spring + the render-time MV sync so a background re-render can't snap a card back mid-drag.
    const [isResizing, setIsResizing] = useState(false);
    // the card currently being corner-dragged; it renders elevated so an in-place width grow overlaps
    // its neighbours instead of clipping behind them
    const [activeResizeId, setActiveResizeId] = useState<string | undefined>(undefined);
    const resizeMoveRef = useRef<{ cardId: string; dyPx: number } | null>(null);
    // snapshot for the live width grow: the dragged card's rect at pointer-down + which side to anchor
    // (left column grows its right edge, right column grows its left edge; a full card shrinks from full)
    const widthSnapRef = useRef<{ startRect: CardRect; isFull: boolean; inColA: boolean } | null>(null);
    const geomMVs = useRef(new Map<string, GeomMV>());
    const getGeom = (id: string, r: CardRect): GeomMV => {
        let g = geomMVs.current.get(id);
        if (!g) {
            g = { x: motionValue(r.x), y: motionValue(r.y), w: motionValue(r.w), h: motionValue(r.h) };
            geomMVs.current.set(id, g);
        }
        return g;
    };

    const colAvail = (n: number) => Math.max(0, columnsAvail - GRID_ROW_GAP_PX * Math.max(0, n - 1));

    const beginCardResize = (cardId: string) => {
        setIsResizing(true);
        setActiveResizeId(cardId);
        const startRect = rects.get(cardId) ?? { x: 0, y: 0, w: 0, h: pageRowPx };
        const isFull = !!cardPrefs[cardId]?.fullWidth;
        widthSnapRef.current = { startRect, isFull, inColA: colA.some((c) => c.id === cardId) };
        if (isFull) {
            resizeSnapRef.current = { kind: "fw", startPx: startRect.h };
            return;
        }
        const col = colA.some((c) => c.id === cardId) ? colA : colB;
        resizeSnapRef.current = {
            kind: "col",
            ids: col.map((c) => c.id),
            weights: col.map((c) => cardPrefs[c.id]?.heightWeight ?? 1),
            avail: colAvail(col.length),
            colStartY: rects.get(col[0].id)?.y ?? 0,
        };
    };
    // commit the drag's height as ratio-scale weights (pointer-up)
    const resizeCardHeight = (cardId: string, dyPx: number) => {
        const snap = resizeSnapRef.current;
        if (!snap) {
            return;
        }
        if (snap.kind === "fw") {
            const px = Math.min(fwMaxPx, Math.max(GRID_MIN_ROW_PX, snap.startPx + dyPx));
            setCardPrefs((p) => ({ ...p, [cardId]: { ...p[cardId], heightWeight: pageRowPx > 0 ? px / pageRowPx : 1 } }));
            return;
        }
        const index = snap.ids.indexOf(cardId);
        if (index === -1 || snap.ids.length < 2) {
            return; // a lone card in its column has no neighbour to shift against
        }
        const last = index === snap.ids.length - 1;
        const boundary = last ? index - 1 : index;
        const delta = last ? -dyPx : dyPx;
        const next = normalizeWeights(resizeRowWeights(snap.weights, boundary, delta, snap.avail));
        setCardPrefs((p) => {
            const out = { ...p };
            snap.ids.forEach((id, i) => (out[id] = { ...out[id], heightWeight: next[i] }));
            return out;
        });
    };
    // live drag (DOM-only, no re-render): grow the dragged card's width in place from the horizontal
    // drag, and redistribute column height from the vertical drag. Full-width is NOT committed here — the
    // card stays in its row, widening over its neighbours, until pointer-up snaps it to the top slot.
    const dragResizeMove = (cardId: string, dxPx: number, dyPx: number) => {
        // width grow: interpolate colW->fullW over the same distance as the commit threshold, so the card
        // is exactly full at the moment it commits (no width jump on release — only the position snaps).
        const ws = widthSnapRef.current;
        const g = geomMVs.current.get(cardId);
        if (ws && g) {
            const fullW = gridViewportW;
            const colW = (gridViewportW - GRID_ROW_GAP_PX) / 2;
            const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
            if (ws.isFull) {
                const t = clamp01(-dxPx / FULLWIDTH_DRAG_THRESHOLD_PX); // drag in shrinks toward a column
                g.w.set(fullW - (fullW - colW) * t);
                g.x.set(0);
            } else {
                const t = clamp01(dxPx / FULLWIDTH_DRAG_THRESHOLD_PX); // drag out grows toward full
                const w = colW + (fullW - colW) * t;
                g.w.set(w);
                g.x.set(ws.inColA ? 0 : ws.startRect.x + ws.startRect.w - w); // anchor the outer edge
            }
        }
        // height: redistribute within the column (or clamp the lone full card) from the vertical drag
        const snap = resizeSnapRef.current;
        if (!snap) {
            return;
        }
        resizeMoveRef.current = { cardId, dyPx };
        if (snap.kind === "fw") {
            g?.h.set(Math.min(fwMaxPx, Math.max(GRID_MIN_ROW_PX, snap.startPx + dyPx)));
            return;
        }
        const index = snap.ids.indexOf(cardId);
        if (index === -1 || snap.ids.length < 2) {
            return; // a lone card in its column has no neighbour to shift against
        }
        const last = index === snap.ids.length - 1;
        const px = resizeRowWeights(snap.weights, last ? index - 1 : index, last ? -dyPx : dyPx, snap.avail);
        // only the dragged boundary moves, but recompute the column's y from the live heights so the
        // lower card's top tracks the drag
        let y = snap.colStartY;
        snap.ids.forEach((id, i) => {
            const gc = geomMVs.current.get(id);
            gc?.h.set(px[i]);
            gc?.y.set(y);
            y += px[i] + GRID_ROW_GAP_PX;
        });
    };
    // pointer-up: commit the drag's height, then commit full-width to the pending state. Dropping
    // isResizing lets the retarget run, easing the card into (or out of) the top full-width slot — the
    // "snap to position" after the in-place grow.
    const endCardResize = (cardId: string, full: boolean) => {
        const m = resizeMoveRef.current;
        if (m) {
            resizeCardHeight(m.cardId, m.dyPx);
        }
        setCardPrefs((p) => ({ ...p, [cardId]: { ...p[cardId], fullWidth: full } }));
        resizeMoveRef.current = null;
        resizeSnapRef.current = null;
        widthSnapRef.current = null;
        setActiveResizeId(undefined);
        setIsResizing(false);
    };

    return { isResizing, activeResizeId, getGeom, beginCardResize, dragResizeMove, endCardResize };
}
