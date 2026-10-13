import { describe, expect, it } from "vitest";
import {
    ACTIVITY_FULL,
    activityLevel,
    advancePhase,
    BREATH_MIN_MS,
    BREATH_MS,
    breathFromPhase,
    breathPeriodMs,
    breathPhase,
    idleOrbit,
    impulseEnvelope,
    MOTION_FRAME_MS,
    nextFrameDelay,
    ORBIT_MS,
    ORBIT_PITCH,
    ORBIT_PITCH_MS,
    pulseRate,
    STILL_FRAME_MS,
    UTTERANCE_MS,
    utteranceEnvelope,
} from "./petmotion";

describe("idleOrbit", () => {
    it("turns through a full circle over one period and starts the next identically", () => {
        expect(idleOrbit(0).yaw).toBeCloseTo(0);
        expect(idleOrbit(ORBIT_MS / 2).yaw).toBeCloseTo(Math.PI);
        expect(idleOrbit(ORBIT_MS).yaw).toBeCloseTo(0);
    });

    it("keeps yaw bounded however long the session has been open", () => {
        // the reason yaw is taken modulo the period rather than accumulated: an all-night session must not
        // push the angle into float spacing coarser than a frame of turn, where rotation visibly steps
        const overnight = 14 * 60 * 60 * 1000;
        for (const t of [overnight, overnight + 7, overnight * 3]) {
            expect(idleOrbit(t).yaw).toBeGreaterThanOrEqual(0);
            expect(idleOrbit(t).yaw).toBeLessThan(Math.PI * 2);
        }
    });

    it("bobs the pitch within its cap, on a period that does not divide the yaw period", () => {
        for (const t of [0, 900, 5_000, 23_456, ORBIT_MS * 2.5]) {
            expect(Math.abs(idleOrbit(t).pitch)).toBeLessThanOrEqual(ORBIT_PITCH + 1e-9);
        }
        // if the two periods shared a short cycle the avatar would visibly return to the same pose
        expect(ORBIT_MS % ORBIT_PITCH_MS).not.toBe(0);
    });

    it("never depends on a pointer, because nothing about the turn is a response to one", () => {
        // the whole point of the replacement: same clock, same angle, wherever the cursor is
        expect(idleOrbit(1_234)).toEqual(idleOrbit(1_234));
    });

    it("returns no rotation for a non-finite clock", () => {
        expect(idleOrbit(Number.NaN)).toEqual({ yaw: 0, pitch: 0 });
    });
});

describe("impulseEnvelope", () => {
    it("rises from nothing, peaks, and returns to nothing across the window", () => {
        expect(impulseEnvelope(0, 0, 1_000)).toBe(0);
        expect(impulseEnvelope(180, 0, 1_000)).toBeCloseTo(1);
        expect(impulseEnvelope(1_000, 0, 1_000)).toBe(0);
        expect(impulseEnvelope(5_000, 0, 1_000)).toBe(0);
    });

    it("has an onset, which is what separates a punctuation from an utterance", () => {
        // utteranceEnvelope starts at its peak because the bubble is already on screen by then. A ripple
        // or a jolt is the first the user hears of the thing, so starting at full would read as a jump cut.
        expect(impulseEnvelope(1, 0, 1_000)).toBeLessThan(0.05);
        expect(impulseEnvelope(90, 0, 1_000)).toBeLessThan(impulseEnvelope(180, 0, 1_000));
    });

    it("decays monotonically after the peak", () => {
        let last = Infinity;
        for (let t = 200; t <= 1_000; t += 50) {
            const v = impulseEnvelope(t, 0, 1_000);
            expect(v).toBeLessThanOrEqual(last);
            last = v;
        }
    });

    it("reads as nothing happening for a null, future or non-finite trigger", () => {
        expect(impulseEnvelope(500, null, 1_000)).toBe(0);
        expect(impulseEnvelope(500, 900, 1_000)).toBe(0);
        expect(impulseEnvelope(500, Number.NaN, 1_000)).toBe(0);
        expect(impulseEnvelope(500, 0, 0)).toBe(0);
    });
});

describe("utteranceEnvelope", () => {
    it("is silent when nothing has been said", () => {
        expect(utteranceEnvelope(1000, null)).toBe(0);
    });

    it("peaks at the moment of the utterance", () => {
        expect(utteranceEnvelope(5000, 5000)).toBeCloseTo(1);
    });

    it("decays monotonically to nothing across the window", () => {
        const a = utteranceEnvelope(5000 + UTTERANCE_MS * 0.25, 5000);
        const b = utteranceEnvelope(5000 + UTTERANCE_MS * 0.75, 5000);
        expect(a).toBeGreaterThan(b);
        expect(b).toBeGreaterThan(0);
    });

    it("is exhausted once the window has passed", () => {
        expect(utteranceEnvelope(5000 + UTTERANCE_MS, 5000)).toBe(0);
        expect(utteranceEnvelope(5000 + UTTERANCE_MS * 4, 5000)).toBe(0);
    });

    it("stays bounded to 0..1 across the window", () => {
        for (const f of [0, 0.1, 0.5, 0.9, 1]) {
            const v = utteranceEnvelope(5000 + UTTERANCE_MS * f, 5000);
            expect(v).toBeGreaterThanOrEqual(0);
            expect(v).toBeLessThanOrEqual(1);
        }
    });

    it("ignores a timestamp from the future rather than surging", () => {
        // a clock adjustment must not make the rings spike forever
        expect(utteranceEnvelope(4000, 5000)).toBe(0);
    });

    it("returns zero for non-finite inputs", () => {
        expect(utteranceEnvelope(Number.NaN, 5000)).toBe(0);
        expect(utteranceEnvelope(5000, Number.NaN)).toBe(0);
    });
});

describe("breathPhase", () => {
    it("starts and ends a period at rest", () => {
        expect(breathPhase(0)).toBeCloseTo(0);
        expect(breathPhase(BREATH_MS)).toBeCloseTo(0);
    });

    it("peaks halfway through the period", () => {
        expect(breathPhase(BREATH_MS / 2)).toBeCloseTo(1);
    });

    it("stays bounded to 0..1", () => {
        for (let i = 0; i <= 20; i++) {
            const v = breathPhase((BREATH_MS * i) / 7);
            expect(v).toBeGreaterThanOrEqual(0);
            expect(v).toBeLessThanOrEqual(1);
        }
    });

    it("returns zero for a non-finite time or a non-positive period", () => {
        expect(breathPhase(Number.NaN)).toBe(0);
        expect(breathPhase(1000, 0)).toBe(0);
    });

    it("matches breathFromPhase on the same phase", () => {
        expect(breathPhase(BREATH_MS * 0.3)).toBeCloseTo(breathFromPhase(0.3));
        expect(breathFromPhase(0.5)).toBeCloseTo(1);
        expect(breathFromPhase(Number.NaN)).toBe(0);
    });
});

describe("activity tempo", () => {
    it("breathes at the base period with nobody working, faster under load, floored at full load", () => {
        expect(BREATH_MS).toBe(4_800);
        expect(breathPeriodMs(0)).toBe(4_800);
        expect(Math.abs(breathPeriodMs(2) - 3_400)).toBeLessThanOrEqual(100);
        expect(breathPeriodMs(ACTIVITY_FULL)).toBeCloseTo(BREATH_MIN_MS);
        expect(breathPeriodMs(20)).toBeCloseTo(BREATH_MIN_MS);
    });

    it("never slows down as the working count rises", () => {
        for (let w = 0; w < 10; w += 0.5) {
            expect(breathPeriodMs(w + 0.5)).toBeLessThanOrEqual(breathPeriodMs(w));
        }
    });

    it("adds nothing at rest and reads bad input as rest", () => {
        expect(activityLevel(0)).toBe(0);
        expect(pulseRate(0)).toBe(0);
        for (const bad of [-3, Number.NaN, Number.POSITIVE_INFINITY]) {
            expect(activityLevel(bad)).toBe(0);
            expect(pulseRate(bad)).toBe(0);
        }
    });

    it("loads concavely, so a couple of agents already register", () => {
        expect(activityLevel(2)).toBeGreaterThan(2 / ACTIVITY_FULL);
        expect(activityLevel(ACTIVITY_FULL)).toBe(1);
        expect(activityLevel(50)).toBe(1);
    });

    it("pulses faster as load rises", () => {
        expect(pulseRate(0.1)).toBeGreaterThan(0);
        expect(pulseRate(1)).toBeGreaterThan(pulseRate(0.5));
        expect(pulseRate(0.5)).toBeGreaterThan(pulseRate(0.1));
    });
});

describe("advancePhase", () => {
    it("moves by dt over the period and wraps into 0..1", () => {
        expect(advancePhase(0, 960, 4_800)).toBeCloseTo(0.2);
        expect(advancePhase(0.9, 960, 4_800)).toBeCloseTo(0.1);
    });

    it("changes speed, not position, when the period drops mid-breath", () => {
        const dt = 33;
        let phase = 0;
        for (let i = 0; i < 40; i++) {
            phase = advancePhase(phase, dt, 4_800);
        }
        const next = advancePhase(phase, dt, 1_900);
        expect(next - phase).toBeGreaterThan(0);
        expect(next - phase).toBeLessThanOrEqual(dt / 1_900 + 1e-12);
        expect(Math.abs(breathFromPhase(next) - breathFromPhase(phase))).toBeLessThan(0.1);
    });

    it("clamps a backgrounded tab's long frame to one second of travel", () => {
        expect(advancePhase(0, 5_000, 4_800)).toBeCloseTo(1_000 / 4_800);
        expect(advancePhase(0.1, 5_000, 1_900) - 0.1).toBeLessThanOrEqual(1_000 / 1_900 + 1e-12);
    });

    it("holds the phase for a bad period or a bad dt", () => {
        expect(advancePhase(0.4, 16, 0)).toBe(0.4);
        expect(advancePhase(0.4, 16, -10)).toBe(0.4);
        expect(advancePhase(0.4, 16, Number.NaN)).toBe(0.4);
        expect(advancePhase(0.4, -16, 4_800)).toBe(0.4);
        expect(advancePhase(0.4, Number.NaN, 4_800)).toBe(0.4);
    });
});

describe("nextFrameDelay", () => {
    // the wait is followed by a requestAnimationFrame, which lands on the first display frame after it
    const landsAt = (delay: number, frameMs = 1_000 / 60) => Math.ceil(delay / frameMs) * frameMs;

    it("draws a moving avatar at 30fps, on every second frame of a 60Hz display", () => {
        expect(landsAt(nextFrameDelay(false, false))).toBeCloseTo(MOTION_FRAME_MS, 5);
    });

    it("redraws a moving avatar at once when it is resized", () => {
        expect(nextFrameDelay(true, false)).toBe(0);
    });

    it("holds a still (reduced-motion) avatar to the still rate, on its intended frame", () => {
        expect(landsAt(nextFrameDelay(false, true))).toBeCloseTo(STILL_FRAME_MS, -1);
    });

    it("redraws a still avatar at once when it is resized", () => {
        expect(nextFrameDelay(true, true)).toBe(0);
    });
});
