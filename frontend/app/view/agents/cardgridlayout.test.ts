// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    computeGridLayout,
    distributeColumns,
    GRID_MIN_ROW_PX,
    GRID_ROW_GAP_PX,
    nextFullWidth,
    normalizeWeights,
    resizeRowWeights,
    rowHeightsPx,
} from "./cardgridlayout";
import type { AgentVM, CardPref } from "./agentsviewmodel";

describe("distributeColumns", () => {
    it("splits round-robin: even index -> A, odd -> B", () => {
        expect(distributeColumns(["a0", "a1", "a2", "a3"])).toEqual({
            colA: ["a0", "a2"],
            colB: ["a1", "a3"],
        });
    });

    it("puts a lone card in A with an empty B", () => {
        expect(distributeColumns(["a0"])).toEqual({ colA: ["a0"], colB: [] });
    });

    it("gives A the extra card on an odd count", () => {
        expect(distributeColumns(["a0", "a1", "a2"])).toEqual({ colA: ["a0", "a2"], colB: ["a1"] });
    });

    it("fills 2x3 for six cards", () => {
        expect(distributeColumns(["a0", "a1", "a2", "a3", "a4", "a5"])).toEqual({
            colA: ["a0", "a2", "a4"],
            colB: ["a1", "a3", "a5"],
        });
    });

    it("is empty for an empty list", () => {
        expect(distributeColumns([])).toEqual({ colA: [], colB: [] });
    });
});

describe("rowHeightsPx", () => {
    it("divides the viewport by weight when rows fit the page", () => {
        expect(rowHeightsPx([1, 1, 1], 300)).toEqual([100, 100, 100]);
        expect(rowHeightsPx([2, 1], 300)).toEqual([200, 100]);
    });

    it("keeps the page row-height and overflows when rows exceed the page", () => {
        // 4 rows, page = 3 -> base 100 each -> total 400 > 300 (scrolls)
        expect(rowHeightsPx([1, 1, 1, 1], 300)).toEqual([100, 100, 100, 100]);
    });

    it("is empty for no rows", () => {
        expect(rowHeightsPx([], 300)).toEqual([]);
    });
});

describe("resizeRowWeights", () => {
    it("moves height across the dragged boundary, preserving the pair total", () => {
        // [1,1,1] @ vp 600 -> px [200,200,200]; drag boundary 0 by +30 -> [230,170,...],
        // both neighbours stay well above the 96px min, so nothing clamps.
        expect(resizeRowWeights([1, 1, 1], 0, 30, 600)).toEqual([230, 170, 200]);
    });

    it("clamps so neither neighbour drops below the minimum", () => {
        // pair = 200; min 96 -> above clamps to 104, below to 96
        expect(resizeRowWeights([1, 1, 1], 0, 1000, 300, 96)).toEqual([104, 96, 100]);
    });

    it("returns the weights unchanged for an out-of-range boundary", () => {
        expect(resizeRowWeights([1, 1], 1, 30, 300)).toEqual([1, 1]);
        expect(resizeRowWeights([1, 1], -1, 30, 300)).toEqual([1, 1]);
    });
});

describe("nextFullWidth", () => {
    it("turns on past the positive threshold and off past the negative", () => {
        expect(nextFullWidth(false, 60, 48)).toBe(true);
        expect(nextFullWidth(true, -60, 48)).toBe(false);
    });
    it("holds within the deadzone", () => {
        expect(nextFullWidth(false, 10, 48)).toBe(false);
        expect(nextFullWidth(true, 10, 48)).toBe(true);
    });
});

describe("normalizeWeights", () => {
    it("rescales pixel-scale weights to mean 1, preserving ratios", () => {
        // resizeRowWeights output (px) -> ratios centred on 1; keeps the overflow branch (base*w) sane
        expect(normalizeWeights([230, 170, 200])).toEqual([1.15, 0.85, 1]);
    });
    it("leaves equal weights at 1", () => {
        expect(normalizeWeights([5, 5, 5])).toEqual([1, 1, 1]);
    });
    it("falls back to 1 when the mean is not positive", () => {
        expect(normalizeWeights([0, 0])).toEqual([1, 1]);
    });
    it("is empty for an empty list", () => {
        expect(normalizeWeights([])).toEqual([]);
    });
});

// minimal AgentVM stand-ins — computeGridLayout only reads `id`
const card = (id: string): AgentVM => ({ id }) as AgentVM;

describe("computeGridLayout", () => {
    const W = 1000;
    const H = 600;

    it("splits non-full-width cards across two equal columns, colB offset by half+gap", () => {
        const cards = [card("a"), card("b"), card("c"), card("d")];
        const { rects, colA, colB, fullWidth } = computeGridLayout(cards, {}, W, H);
        expect(fullWidth).toHaveLength(0);
        expect(colA.map((c) => c.id)).toEqual(["a", "c"]); // distributeColumns: even indices
        expect(colB.map((c) => c.id)).toEqual(["b", "d"]);
        const colW = (W - GRID_ROW_GAP_PX) / 2;
        expect(rects.get("a")!.x).toBe(0);
        expect(rects.get("a")!.w).toBeCloseTo(colW);
        expect(rects.get("b")!.x).toBeCloseTo(colW + GRID_ROW_GAP_PX);
    });

    it("spans a single column card across the full width (not half), still filling height", () => {
        const { rects, colA, colB } = computeGridLayout([card("solo")], {}, W, H);
        expect(colA.map((c) => c.id)).toEqual(["solo"]);
        expect(colB).toHaveLength(0);
        const r = rects.get("solo")!;
        expect(r.x).toBe(0);
        expect(r.w).toBe(W);
        expect(r.h).toBeCloseTo(H);
    });

    it("stacks equal-weight column cards top-to-bottom with a gap between them", () => {
        const cards = [card("a"), card("b"), card("c")]; // a (idx0) + c (idx2) both land in colA
        const { rects } = computeGridLayout(cards, {}, W, H);
        const a = rects.get("a")!;
        const c = rects.get("c")!;
        expect(a.y).toBe(0);
        expect(c.y).toBeCloseTo(a.h + GRID_ROW_GAP_PX);
    });

    it("floats full-width cards to a top stack spanning the full width", () => {
        const cards = [card("fw"), card("a"), card("b")];
        const prefs: Record<string, CardPref> = { fw: { fullWidth: true } };
        const { rects, fullWidth, colA } = computeGridLayout(cards, prefs, W, H);
        expect(fullWidth.map((c) => c.id)).toEqual(["fw"]);
        expect(rects.get("fw")!).toMatchObject({ x: 0, y: 0, w: W });
        expect(colA.map((c) => c.id)).toEqual(["a"]); // "a" is first of the remaining
        // columns start below the FW stack + one gap
        expect(rects.get("a")!.y).toBeCloseTo(rects.get("fw")!.h + GRID_ROW_GAP_PX);
    });

    it("clamps full-width height to [GRID_MIN_ROW_PX, FULLWIDTH_MAX_VIEWPORT_FRAC*H]", () => {
        const cards = [card("tall"), card("short")];
        const prefs: Record<string, CardPref> = {
            tall: { fullWidth: true, heightWeight: 100 }, // way over the cap
            short: { fullWidth: true, heightWeight: 0.0001 }, // under the floor
        };
        const { rects } = computeGridLayout(cards, prefs, W, H);
        expect(rects.get("tall")!.h).toBeCloseTo(0.6 * H); // FULLWIDTH_MAX_VIEWPORT_FRAC
        expect(rects.get("short")!.h).toBe(GRID_MIN_ROW_PX);
    });

    it("totalHeight is the viewport when content fits, and grows when a column overflows", () => {
        const fit = computeGridLayout([card("a"), card("b")], {}, W, H);
        expect(fit.totalHeight).toBe(H);

        // 8 cards in one column (>GRID_PAGE_ROWS) overflow -> totalHeight exceeds H
        const many = Array.from({ length: 8 }, (_, i) => card(`c${i}`));
        const over = computeGridLayout(many, {}, W, H);
        expect(over.totalHeight).toBeGreaterThan(H);
    });

    it("returns empty rects for no cards", () => {
        const { rects, totalHeight } = computeGridLayout([], {}, W, H);
        expect(rects.size).toBe(0);
        expect(totalHeight).toBe(H);
    });
});
