// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    layoutFor,
    RAIL_NARROW_PX,
    RAIL_WIDE_PX,
    STAGE_MIN_PX,
    stageWidth,
    SUBJECTS_ICON_PX,
    SUBJECTS_NARROW_PX,
    SUBJECTS_WIDE_PX,
} from "./jarvislayout";

// asserted in SURFACE width throughout: the nav rail is variable (navrailwidth.ts), so a window->surface
// helper would be a second, silently drifting source of truth. The CDP scenario owns window widths.
//
// railPx is passed in rather than decided here — the rail is the user's toggle, not the layout's (see
// jarvissurface.tsx). Both rail widths are exercised, because a bug that only shows with the rail open is
// exactly what shipped last time.
const RAILS = [RAIL_NARROW_PX, RAIL_WIDE_PX];
const stage = (w: number, railPx: number) => stageWidth(w, railPx, layoutFor(w, railPx));

describe("layoutFor", () => {
    it("leaves the Subjects column full width while the Stage clears its floor", () => {
        const l = layoutFor(1400, RAIL_WIDE_PX);
        expect(l).toEqual({ subjectsPx: SUBJECTS_WIDE_PX, subjectsIcons: false, railOverlay: false });
        expect(stage(1400, RAIL_WIDE_PX)).toBeGreaterThanOrEqual(STAGE_MIN_PX);
    });

    it("funds the floor from the Subjects column, taking exactly the deficit", () => {
        // 922 surface with the rail's strip: a full-width column would leave the Stage 606, 34px short. The
        // column gives up 34px and nothing else moves — the staircase this replaced slammed it to 56.
        const l = layoutFor(922, RAIL_NARROW_PX);
        expect(l.subjectsPx).toBe(SUBJECTS_WIDE_PX - 34);
        expect(stage(922, RAIL_NARROW_PX)).toBe(STAGE_MIN_PX);
    });

    // THE regression test. The staircase this replaced was monotone in its *collapse flags* — the old test
    // asserted exactly that and passed — while the Stage's width sawtoothed: measured over CDP, a 1000px
    // window gave the Stage 822px and a 1050px window gave it 656px. Widening the window made the thread
    // narrower. Monotonicity has to be asserted on the width, and at 1px steps: the dip was invisible at
    // the five widths the CDP scenario sampled.
    it("never gives the Stage less on a wider surface", () => {
        for (const railPx of RAILS) {
            let prev = 0;
            for (let w = 400; w <= 2400; w += 1) {
                const got = stage(w, railPx);
                expect(got, `stage shrank at surface ${w} (rail ${railPx})`).toBeGreaterThanOrEqual(prev);
                prev = got;
            }
        }
    });

    it("holds the Stage at its floor wherever the column can fund it", () => {
        // with the rail's strip overlaid the column funds the floor down to 696; a rail the user has opened
        // is 300px the layout may not take back, so that case floors out higher. Both are asserted from the
        // same arithmetic rather than from a magic width.
        for (const railPx of RAILS) {
            const floorable = STAGE_MIN_PX + SUBJECTS_NARROW_PX + (railPx > RAIL_NARROW_PX ? railPx : 0);
            for (let w = floorable; w <= 2400; w += 2) {
                expect(stage(w, railPx), `surface ${w} (rail ${railPx})`).toBeGreaterThanOrEqual(STAGE_MIN_PX);
            }
        }
    });

    it("keeps the column inside its range at every width", () => {
        for (const railPx of RAILS) {
            for (let w = 0; w <= 2400; w += 1) {
                const { subjectsPx } = layoutFor(w, railPx);
                expect(subjectsPx).toBeGreaterThanOrEqual(SUBJECTS_NARROW_PX);
                expect(subjectsPx).toBeLessThanOrEqual(SUBJECTS_WIDE_PX);
            }
        }
    });

    it("drops the column's labels only once it is narrower than they need", () => {
        const atThreshold = SUBJECTS_ICON_PX + STAGE_MIN_PX + RAIL_NARROW_PX;
        expect(layoutFor(atThreshold, RAIL_NARROW_PX).subjectsIcons).toBe(false);
        expect(layoutFor(atThreshold - 1, RAIL_NARROW_PX).subjectsIcons).toBe(true);
        // the swap is a content threshold, never a width one — nothing in the layout steps here
        expect(
            layoutFor(atThreshold, RAIL_NARROW_PX).subjectsPx - layoutFor(atThreshold - 1, RAIL_NARROW_PX).subjectsPx
        ).toBe(1);
        for (const railPx of RAILS) {
            for (let w = 0; w <= 2400; w += 1) {
                const l = layoutFor(w, railPx);
                expect(l.subjectsIcons).toBe(l.subjectsPx < SUBJECTS_ICON_PX);
            }
        }
    });

    it("floats the rail only when keeping its strip inline would break the floor", () => {
        for (let w = 1; w <= 2400; w += 1) {
            const inlineFloor = w - RAIL_NARROW_PX - SUBJECTS_NARROW_PX >= STAGE_MIN_PX;
            expect(layoutFor(w, RAIL_NARROW_PX).railOverlay, `surface ${w}`).toBe(!inlineFloor);
        }
    });

    it("never floats a rail the user has opened", () => {
        // overlay substitutes for the 44px strip, which carries one button. A 300px panel the user asked
        // for is content: taking it out of the flow to buy the Stage width would answer a question they
        // already answered. Under the floor with the rail open is their call, as the design says.
        for (let w = 1; w <= 2400; w += 1) {
            expect(layoutFor(w, RAIL_WIDE_PX).railOverlay, `surface ${w}`).toBe(false);
        }
    });

    it("crosses the overlay boundary without a step in the Stage's width", () => {
        const boundary = STAGE_MIN_PX + SUBJECTS_NARROW_PX + RAIL_NARROW_PX;
        expect(layoutFor(boundary, RAIL_NARROW_PX).railOverlay).toBe(false);
        expect(layoutFor(boundary - 1, RAIL_NARROW_PX).railOverlay).toBe(true);
        // both sides sit exactly on the floor: the strip leaving the flow is invisible in the Stage's
        // width, it only moves who pays for it. This is the step the old step-3 introduced.
        expect(stage(boundary, RAIL_NARROW_PX)).toBe(STAGE_MIN_PX);
        expect(stage(boundary - 1, RAIL_NARROW_PX)).toBe(STAGE_MIN_PX);
    });

    it("degrades linearly below the floor rather than cliff-edging", () => {
        // rule 5 forbids taking the residual from the thread or the composer, so under the floor the Stage
        // just tracks the surface. Asserted so a future "one more lever" cannot reintroduce a jump here.
        for (let w = 300; w < STAGE_MIN_PX + SUBJECTS_NARROW_PX; w += 1) {
            expect(stage(w, RAIL_NARROW_PX)).toBe(w - SUBJECTS_NARROW_PX);
        }
    });

    it("assumes nothing on an unmeasured (zero) width rather than slamming shut on the first frame", () => {
        expect(layoutFor(0, RAIL_WIDE_PX)).toEqual({
            subjectsPx: SUBJECTS_WIDE_PX,
            subjectsIcons: false,
            railOverlay: false,
        });
    });

    it("the mirrored rail widths still match the component they came from", () => {
        // guards the mirror: RAIL_EXPANDED_PX / RAIL_COLLAPSED_PX are a motion animate value in
        // collapsiblerail.tsx, not a number this module can read. The Subjects column no longer needs a
        // mirror — it takes its width from here.
        expect(RAIL_WIDE_PX).toBe(300);
        expect(RAIL_NARROW_PX).toBe(44);
    });
});
