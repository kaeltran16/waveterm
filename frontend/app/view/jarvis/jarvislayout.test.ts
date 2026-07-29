// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { collapseFor, RAIL_WIDE_PX, STAGE_MIN_PX, stageWidth, SUBJECTS_WIDE_PX } from "./jarvislayout";

// the surface's width is the window minus the 78px nav rail
const surfaceFor = (windowWidth: number) => windowWidth - 78;

describe("collapseFor", () => {
    it("collapses nothing while the Stage clears its floor", () => {
        const c = collapseFor(surfaceFor(1920));
        expect(c).toEqual({ railCollapsed: false, subjectsCollapsed: false });
        expect(stageWidth(surfaceFor(1920), c)).toBeGreaterThanOrEqual(STAGE_MIN_PX);
    });

    it("yields the context rail first — the design's step 1", () => {
        const c = collapseFor(surfaceFor(1100));
        expect(c).toEqual({ railCollapsed: true, subjectsCollapsed: false });
    });

    it("yields the Subjects column only after the rail — step 2", () => {
        const c = collapseFor(surfaceFor(900));
        expect(c).toEqual({ railCollapsed: true, subjectsCollapsed: true });
    });

    it("never collapses Subjects while the rail is still wide", () => {
        for (let w = 400; w <= 2400; w += 4) {
            const c = collapseFor(surfaceFor(w));
            if (c.subjectsCollapsed) {
                expect(c.railCollapsed).toBe(true);
            }
        }
    });

    // rule 5, as a width assertion rather than "the thread is still mounted" — the mounted check passed on
    // the broken layout, which is how this shipped.
    it("holds the Stage at or above its floor wherever the order can", () => {
        for (let w = 1034; w <= 2400; w += 2) {
            expect(stageWidth(surfaceFor(w), collapseFor(surfaceFor(w)))).toBeGreaterThanOrEqual(STAGE_MIN_PX);
        }
    });

    it("still gives the Stage every pixel the order can free below that", () => {
        // 720px is narrower than the floor can survive; the order must at least be fully applied there.
        const c = collapseFor(surfaceFor(720));
        expect(c).toEqual({ railCollapsed: true, subjectsCollapsed: true });
        // and strictly better than doing nothing
        const naive = { railCollapsed: false, subjectsCollapsed: false };
        expect(stageWidth(surfaceFor(720), c)).toBeGreaterThan(stageWidth(surfaceFor(720), naive));
    });

    it("collapses nothing on an unmeasured (zero) width rather than slamming shut on the first frame", () => {
        expect(collapseFor(0)).toEqual({ railCollapsed: false, subjectsCollapsed: false });
    });

    it("is monotonic — a wider surface never collapses more", () => {
        let prev = collapseFor(surfaceFor(600));
        for (let w = 604; w <= 2400; w += 4) {
            const c = collapseFor(surfaceFor(w));
            expect(Number(c.railCollapsed) + Number(c.subjectsCollapsed)).toBeLessThanOrEqual(
                Number(prev.railCollapsed) + Number(prev.subjectsCollapsed)
            );
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
