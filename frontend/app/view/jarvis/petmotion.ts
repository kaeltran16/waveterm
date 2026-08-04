// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The creature's involuntary motion: where its pupils point, and when it blinks. Pure for the same reason
// petcondition.ts is — petview.tsx is a swappable renderer (design §5), and gaze targeting and blink timing
// are things a three.js creature would need in this same form, so keeping them here means a renderer swap
// inherits them rather than reimplementing them.
//
// Nothing here reads condition, and that is deliberate: aliveness is not a fifth register. The creature
// tracks the cursor and blinks whatever it currently expresses — that is what separates idle from frozen.

// How far the pointer must be before the eyes are fully deflected. Below it the deflection ramps, so a
// pointer resting on the creature does not peg its pupils to one side.
export const GAZE_SATURATE_PX = 220;

export interface GazeOffset {
    dx: number;
    dy: number;
}

// Pointer position (viewport px) -> pupil deflection (SVG user units), relative to the pupil's resting spot.
//
// The caps are per-axis rather than one radius because the eye is an ellipse, and the expression may have
// already spent the vertical room on a droop (see eyeRoom). Scaling a unit vector by both caps keeps travel
// inside that ellipse; clamping each axis on its own would let a diagonal reach the corner, which is how a
// pupil ends up outside its lid.
export function gazeOffset(
    petCx: number,
    petCy: number,
    pointerX: number,
    pointerY: number,
    maxX: number,
    maxY: number
): GazeOffset {
    const vx = pointerX - petCx;
    const vy = pointerY - petCy;
    const dist = Math.hypot(vx, vy);
    // written as !(dist > 0) so a NaN coordinate falls here too: pointer on the exact centre has no
    // direction to look, and dividing by it would put NaN into a transform
    if (!(dist > 0)) {
        return { dx: 0, dy: 0 };
    }
    const ramp = Math.min(1, dist / GAZE_SATURATE_PX);
    return {
        dx: (vx / dist) * Math.max(0, maxX) * ramp,
        dy: (vy / dist) * Math.max(0, maxY) * ramp,
    };
}

export interface EyeRoom {
    maxX: number;
    maxY: number;
}

// How far the pupil may travel before it leaves the lid, given the eye the current expression is drawing.
// The vertical budget is whatever the expression has not already spent: `drifting` slumps the gaze 1.4 units
// down inside a 3.4-unit lid, leaving almost nothing, so that creature glances sideways only. Falling out of
// the geometry beats a per-expression exception table, and a droopy creature that tracks as freely as an
// alert one is most of the droop undone.
export function eyeRoom(eyeRx: number, eyeRy: number, pupilDy: number, pupilR: number, cap: number): EyeRoom {
    return {
        maxX: Math.max(0, Math.min(cap, eyeRx - pupilR)),
        maxY: Math.max(0, Math.min(cap, eyeRy - pupilR - Math.abs(pupilDy))),
    };
}

// Blink cadence. Irregular on purpose: a fixed interval reads as a metronome, which is worse than not
// blinking at all.
export const BLINK_MIN_MS = 2_600;
export const BLINK_MAX_MS = 7_400;

// rand is injected rather than read from Math.random inside, so the spread is assertable.
export function nextBlinkDelay(rand: number): number {
    const t = Number.isFinite(rand) ? Math.min(1, Math.max(0, rand)) : 0;
    return BLINK_MIN_MS + t * (BLINK_MAX_MS - BLINK_MIN_MS);
}
