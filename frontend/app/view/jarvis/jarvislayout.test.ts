// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    collapseFor,
    RAIL_WIDE_PX,
    STAGE_MIN_PX,
    stageWidth,
    SUBJECTS_WIDE_PX,
    type LayoutCollapse,
} from "./jarvislayout";

// asserted in SURFACE width throughout: the nav rail is variable (navrailwidth.ts), so a window->surface
// helper would be a second, silently drifting source of truth. The CDP scenario owns window widths.
const NOTHING: LayoutCollapse = { railCollapsed: false, subjectsCollapsed: false, railOverlay: false };

describe("collapseFor", () => {
    it("collapses nothing while the Stage clears its floor", () => {
        expect(collapseFor(1400)).toEqual(NOTHING);
        expect(stageWidth(1400, collapseFor(1400))).toBeGreaterThanOrEqual(STAGE_MIN_PX);
    });

    it("yields the context rail first — the design's step 1", () => {
        expect(collapseFor(1000)).toEqual({ railCollapsed: true, subjectsCollapsed: false, railOverlay: false });
    });

    it("yields the Subjects column only after the rail — step 2", () => {
        expect(collapseFor(800)).toEqual({ railCollapsed: true, subjectsCollapsed: true, railOverlay: false });
    });

    it("floats the rail once collapsing both is still not enough", () => {
        expect(collapseFor(700)).toEqual({ railCollapsed: true, subjectsCollapsed: true, railOverlay: true });
    });

    it("never collapses Subjects while the rail is still wide", () => {
        for (let w = 400; w <= 2400; w += 4) {
            const c = collapseFor(w);
            if (c.subjectsCollapsed) {
                expect(c.railCollapsed).toBe(true);
            }
        }
    });

    it("never overlays the rail before collapsing Subjects", () => {
        for (let w = 400; w <= 2400; w += 4) {
            const c = collapseFor(w);
            if (c.railOverlay) {
                expect(c.subjectsCollapsed).toBe(true);
            }
        }
    });

    // rule 5, as a width assertion rather than "the thread is still mounted" — the mounted check passed on
    // the broken layout, which is how this shipped. 696 is where the order runs out of regions to yield.
    it("holds the Stage at or above its floor wherever the order can", () => {
        for (let w = 696; w <= 2400; w += 2) {
            expect(stageWidth(w, collapseFor(w))).toBeGreaterThanOrEqual(STAGE_MIN_PX);
        }
    });

    it("still gives the Stage every pixel the order can free below that", () => {
        const c = collapseFor(600);
        expect(c).toEqual({ railCollapsed: true, subjectsCollapsed: true, railOverlay: true });
        expect(stageWidth(600, c)).toBeGreaterThan(stageWidth(600, NOTHING));
    });

    it("collapses nothing on an unmeasured (zero) width rather than slamming shut on the first frame", () => {
        expect(collapseFor(0)).toEqual(NOTHING);
    });

    it("is monotonic — a wider surface never collapses more", () => {
        const weight = (c: LayoutCollapse) =>
            Number(c.railCollapsed) + Number(c.subjectsCollapsed) + Number(c.railOverlay);
        let prev = collapseFor(500);
        for (let w = 504; w <= 2400; w += 4) {
            const c = collapseFor(w);
            expect(weight(c)).toBeLessThanOrEqual(weight(prev));
            prev = c;
        }
    });

    it("the mirrored widths still match the components they came from", () => {
        // guards the mirror: if subjectscolumn's w-[272px] or RAIL_EXPANDED_PX moves, the arithmetic here
        // silently drifts and the Stage floor stops being real.
        expect(SUBJECTS_WIDE_PX).toBe(272);
        expect(RAIL_WIDE_PX).toBe(300);
    });
});
