// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The avatar's involuntary motion: which way it turns, how hard it surges when Jarvis says something, and
// its resting breath. Pure for the same reason petcondition.ts is — the renderer is swappable (design §5),
// so anything a second renderer would otherwise reimplement lives here instead.
//
// Nothing here reads condition. Aliveness is not a fifth register: the avatar turns and breathes whatever
// it currently expresses, and that is what separates idle from frozen.
//
// This module used to serve eyes. eyeRoom clamped pupil travel inside a lid and nextBlinkDelay scheduled
// blinks; the hologram form has neither, so both are gone. What survived is the distance ramp, reused to
// rotate the whole assembly instead of sliding a pupil inside an eye.

// How far the pointer must be before the turn is fully committed. Below it the turn ramps, so a pointer
// resting alongside the avatar does not peg it to one side.
export const GAZE_SATURATE_PX = 220;

export interface GazeAngles {
    /** radians, positive turns the avatar's near face toward larger screen x */
    yaw: number;
    /** radians, positive tips the near face upward */
    pitch: number;
}

// Pointer position (viewport px) -> rotation of the whole form.
//
// The direction is normalised before the caps are applied, so a diagonal splits its budget between the two
// axes. Clamping each axis independently would let a diagonal reach yawCap AND pitchCap at once, which is a
// harder turn than the caps were chosen to permit.
export function gazeYawPitch(
    cx: number,
    cy: number,
    pointerX: number,
    pointerY: number,
    yawCap: number,
    pitchCap: number
): GazeAngles {
    const vx = pointerX - cx;
    const vy = pointerY - cy;
    const dist = Math.hypot(vx, vy);
    // written as !(dist > 0) so a NaN coordinate lands here too: the pointer on the exact centre has no
    // direction to turn toward, and dividing by it would put NaN into a rotation
    if (!(dist > 0)) {
        return { yaw: 0, pitch: 0 };
    }
    const ramp = Math.min(1, dist / GAZE_SATURATE_PX);
    return {
        yaw: (vx / dist) * Math.max(0, yawCap) * ramp,
        // screen y grows downward while pitch is positive-up, hence the negation
        pitch: -(vy / dist) * Math.max(0, pitchCap) * ramp,
    };
}

// How long a single utterance keeps the data rings surged. The reference calls the rings "audio-reactive",
// but there is no audio anywhere in this application — the Voice register is text bubbles, so the driver is
// the bubble appearing (design §4 decision 6).
export const UTTERANCE_MS = 2_200;

// 1 at the moment of the utterance, decaying to 0 across the window. Injected time rather than
// performance.now() inside, so the decay is assertable and the module stays DOM-free.
export function utteranceEnvelope(now: number, spokeAt: number | null, durationMs = UTTERANCE_MS): number {
    if (spokeAt == null || !Number.isFinite(spokeAt) || !Number.isFinite(now) || !(durationMs > 0)) {
        return 0;
    }
    const elapsed = now - spokeAt;
    // a clock adjustment can put spokeAt in the future; that must read as silence, not as a permanent surge
    if (!(elapsed >= 0) || elapsed >= durationMs) {
        return 0;
    }
    return 1 - elapsed / durationMs;
}

export const BREATH_MS = 4_200;

// 0 at rest, 1 at full inhale, back to 0 — a raised cosine so there is no discontinuity at the loop point.
export function breathPhase(now: number, periodMs = BREATH_MS): number {
    if (!Number.isFinite(now) || !(periodMs > 0)) {
        return 0;
    }
    return (1 - Math.cos((now / periodMs) * Math.PI * 2)) / 2;
}
