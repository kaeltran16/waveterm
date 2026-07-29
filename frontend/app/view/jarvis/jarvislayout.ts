// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The surface's narrow-window collapse order (design §"collapse order"). Pure — width in, which regions
// yield out — so the order is asserted in unit tests rather than only by eye.
//
// The order exists to protect one thing: the thread and the composer never give up space ("a hard
// constraint, not a preference"). Nothing was width-responsive before, so the order ran backwards — the
// chrome held a constant 572px inside the surface while the Stage absorbed every pixel of loss, measured
// down to 350px at a 1000px window. That is why this is expressed as a floor on the Stage and a sequence
// of regions that yield to keep it, not as a table of breakpoints.

// Region widths, mirrored from where they are set: subjectscolumn.tsx's column and collapsiblerail.tsx's
// RAIL_EXPANDED_PX / RAIL_COLLAPSED_PX. Mirrored rather than imported because those are Tailwind class
// literals and a motion animate value, neither of which is a number this module can read.
export const SUBJECTS_WIDE_PX = 272;
export const SUBJECTS_NARROW_PX = 56;
export const RAIL_WIDE_PX = 300;
export const RAIL_NARROW_PX = 44;

// The Stage's floor — rule 5 of the order, as a number. Derived, not picked: the widest fixed element in
// the thread is the user bubble at max-w-[560px] (jarvisturn.tsx) inside the conversation column's px-8
// (64px), so 624px is the width below which the thread's own content starts being squeezed. 640 is that
// with a little air. Everything above yields to keep this.
export const STAGE_MIN_PX = 640;

export interface LayoutCollapse {
    railCollapsed: boolean; // 1. context rail -> its 44px strip
    subjectsCollapsed: boolean; // 2. Subjects column -> status dots
}

export function chromeWidth(collapse: LayoutCollapse): number {
    return (
        (collapse.subjectsCollapsed ? SUBJECTS_NARROW_PX : SUBJECTS_WIDE_PX) +
        (collapse.railCollapsed ? RAIL_NARROW_PX : RAIL_WIDE_PX)
    );
}

export function stageWidth(surfaceWidth: number, collapse: LayoutCollapse): number {
    return surfaceWidth - chromeWidth(collapse);
}

// surfaceWidth is the Jarvis surface's own width — the window minus the nav rail, which is global chrome
// shared by every surface and therefore not this surface's to collapse (step 4 of the design's order is
// not implemented here; see docs/jarvis-consolidation-open-issues.md JC16).
//
// A width of 0 (the first frame, before the observer has measured) must not read as "narrowest" and slam
// every region shut, so it collapses nothing.
export function collapseFor(surfaceWidth: number): LayoutCollapse {
    const collapse: LayoutCollapse = { railCollapsed: false, subjectsCollapsed: false };
    if (surfaceWidth <= 0) {
        return collapse;
    }
    // apply the order in sequence, stopping as soon as the Stage clears its floor.
    if (stageWidth(surfaceWidth, collapse) >= STAGE_MIN_PX) {
        return collapse;
    }
    collapse.railCollapsed = true;
    if (stageWidth(surfaceWidth, collapse) >= STAGE_MIN_PX) {
        return collapse;
    }
    collapse.subjectsCollapsed = true;
    return collapse;
}
