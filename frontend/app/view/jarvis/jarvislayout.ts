// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The surface's narrow-window layout (design §"collapse order"). Pure — surface width and the rail's
// current width in, the Subjects column's width out — so the behaviour is asserted in unit tests rather
// than only by eye.
//
// It protects one thing: the thread and the composer never give up space ("a hard constraint, not a
// preference"). That is expressed as a floor on the Stage which the Subjects column funds by giving up
// exactly the deficit, continuously.
//
// Why continuous rather than a staircase. The first build of this snapped the column 272 -> 56 the moment
// the Stage dipped under its floor. A 216px lever fixing a 34px deficit overshoots, so the Stage's width
// was not monotone in the window's: measured over CDP, a 1000px window gave the Stage 822px and a 1050px
// window gave it 656px. Widening the window made the thread *narrower* and flipped the column between
// labelled rows and anonymous glyphs. The old unit test asserted monotonicity of the collapse *flags*,
// which held the whole way through — it is the Stage's width that has to be monotone, and it now is.

export const SUBJECTS_WIDE_PX = 272;
export const SUBJECTS_NARROW_PX = 56;

// Mirrored from collapsiblerail.tsx's RAIL_EXPANDED_PX / RAIL_COLLAPSED_PX, which are a motion animate
// value rather than a number this module can read. Guarded by a test. The Subjects column needs no such
// mirror any more: it takes its width from here.
export const RAIL_WIDE_PX = 300;
export const RAIL_NARROW_PX = 44;

// Below this the column shows status dots instead of labels. A content threshold only — the column's width
// stays continuous across it, so nothing in the layout steps here. 140px holds a group heading and a few
// characters of a subject name; under it the labels are all ellipsis and the dots say more.
//
// The cost, accepted deliberately: between 56 and 140 the strip is drawn in a box wider than its 32px
// glyphs need, so at e.g. a 130px column the dots sit in a loose column. The two alternatives are worse.
// Snapping the column back to 56 in icon mode puts an 84px step back into the Stage's width — the exact
// pathology this module exists to remove. Showing labels down to 56px gives two ellipsised characters and
// a "+ Channel" button too narrow for its own text. A loose strip stays legible and clickable.
export const SUBJECTS_ICON_PX = 140;

// The Stage's floor. Derived, not picked: the widest fixed element in the thread is the user bubble at
// max-w-[560px] (jarvisturn.tsx) inside the stage gutter's px-6 (48px) and the scrollbar's 10px, so 618px
// is where the thread's own content starts being squeezed. 640 is that with a little air.
export const STAGE_MIN_PX = 640;

export interface StageLayout {
    subjectsPx: number; // continuous, SUBJECTS_NARROW_PX..SUBJECTS_WIDE_PX
    subjectsIcons: boolean; // derived from subjectsPx — the column's content, not its width
    railOverlay: boolean; // the rail's strip leaves the flow and floats over the Stage
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

// surfaceWidth is the Jarvis surface's own width — the window minus the nav rail. The nav rail collapses
// itself (view/agents/navrailwidth.ts, the design's step 4); this module never sees it, it just measures a
// wider surface when that happens.
//
// railPx is the rail's *current* width, passed in rather than decided here: the rail is a user preference
// and this module does not get a vote (see jarvissurface.tsx). It only routes around whatever the rail is.
//
// A width of 0 (the first frame, before the observer has measured) must not read as "narrowest" and slam
// the column shut, so it yields nothing.
export function layoutFor(surfaceWidth: number, railPx: number): StageLayout {
    if (surfaceWidth <= 0) {
        return { subjectsPx: SUBJECTS_WIDE_PX, subjectsIcons: false, railOverlay: false };
    }
    // Last resort, and only for the collapsed strip: below the width where even the narrowest column can
    // fund the floor, the strip leaves the flow. A 300px rail the user opened is content, not chrome — see
    // the test; taking it out of the flow would answer a question they already answered.
    const railOverlay = railPx <= RAIL_NARROW_PX && surfaceWidth - railPx - SUBJECTS_NARROW_PX < STAGE_MIN_PX;
    const inlineRail = railOverlay ? 0 : railPx;
    const subjectsPx = clamp(surfaceWidth - inlineRail - STAGE_MIN_PX, SUBJECTS_NARROW_PX, SUBJECTS_WIDE_PX);
    return { subjectsPx, subjectsIcons: subjectsPx < SUBJECTS_ICON_PX, railOverlay };
}

export function stageWidth(surfaceWidth: number, railPx: number, layout: StageLayout): number {
    return surfaceWidth - (layout.railOverlay ? 0 : railPx) - layout.subjectsPx;
}
