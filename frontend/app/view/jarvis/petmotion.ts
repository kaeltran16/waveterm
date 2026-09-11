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
// This module used to serve eyes, then it served a gaze. eyeRoom clamped pupil travel inside a lid and
// nextBlinkDelay scheduled blinks; the hologram form has neither. gazeYawPitch then turned the whole
// assembly to face the pointer, and that is gone too — a hologram that watches the cursor is a pet, and
// tracking the pointer across a window whose other surfaces are live terminals made the avatar read as
// something demanding attention rather than something holding it. It turns on its own clock now.

export interface OrbitAngles {
    /** radians, positive turns the avatar's near face toward larger screen x */
    yaw: number;
    /** radians, positive tips the near face upward */
    pitch: number;
}

// One full turn. Deliberately long: at 48s the near face crosses the silhouette slowly enough that the
// motion is only visible if you look for it, which is the difference between a hologram idling and a
// loading spinner. The platters already spin on their own much faster clock (mood.spin), so the body
// turn is the slowest thing in the form and reads as parallax rather than as rotation.
export const ORBIT_MS = 48_000;

// The pitch bob rides a second, coprime-ish period so the pair never returns to the same pose on a short
// cycle. Shallow — this is a nod, not a tumble, and the scene already tilts the whole form by 0.22.
export const ORBIT_PITCH_MS = 17_000;
export const ORBIT_PITCH = 0.18;

/**
 * The body's own rotation, from the clock alone.
 *
 * Yaw is taken modulo the period rather than accumulated. `now` is a monotonic ms clock that only grows,
 * and a session left open overnight would otherwise push it past the point where float32 spacing is
 * coarser than a frame's worth of turn — the rotation would visibly quantise into steps.
 */
export function idleOrbit(now: number): OrbitAngles {
    if (!Number.isFinite(now)) {
        return { yaw: 0, pitch: 0 };
    }
    const turn = (((now % ORBIT_MS) + ORBIT_MS) % ORBIT_MS) / ORBIT_MS;
    return {
        yaw: turn * Math.PI * 2,
        pitch: Math.sin((now / ORBIT_PITCH_MS) * Math.PI * 2) * ORBIT_PITCH,
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

// Punctuation windows. A ripple is the network carrying news across itself, so it needs long enough to
// visibly cross the form; a jolt is an impact and has to be over before it becomes a wobble.
export const RIPPLE_MS = 1_400;
export const JOLT_MS = 520;

// Fraction of the window spent rising. Utterances start at their peak and decay because the bubble is
// already on screen by then — the surge is the tail of something the user has seen. A punctuation is the
// first the user hears of it, so it needs an onset to be an event rather than a fade.
const IMPULSE_ATTACK = 0.18;

/**
 * 0 -> 1 -> 0 across the window, with a fast rise and a squared falloff.
 *
 * Same defensive shape as utteranceEnvelope, and for the same reasons: a null or future `firedAt` reads
 * as nothing happening rather than as a permanent surge, so a clock adjustment cannot leave the avatar
 * stuck mid-impact.
 */
export function impulseEnvelope(now: number, firedAt: number | null, durationMs: number): number {
    if (firedAt == null || !Number.isFinite(firedAt) || !Number.isFinite(now) || !(durationMs > 0)) {
        return 0;
    }
    const elapsed = now - firedAt;
    if (!(elapsed >= 0) || elapsed >= durationMs) {
        return 0;
    }
    const p = elapsed / durationMs;
    if (p < IMPULSE_ATTACK) {
        return p / IMPULSE_ATTACK;
    }
    const fall = 1 - (p - IMPULSE_ATTACK) / (1 - IMPULSE_ATTACK);
    return fall * fall;
}

export const BREATH_MS = 4_200;

// 0 at rest, 1 at full inhale, back to 0 — a raised cosine so there is no discontinuity at the loop point.
export function breathPhase(now: number, periodMs = BREATH_MS): number {
    if (!Number.isFinite(now) || !(periodMs > 0)) {
        return 0;
    }
    return (1 - Math.cos((now / periodMs) * Math.PI * 2)) / 2;
}
