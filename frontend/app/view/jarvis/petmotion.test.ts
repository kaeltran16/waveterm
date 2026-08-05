import { describe, expect, it } from "vitest";
import {
    BREATH_MS,
    breathPhase,
    GAZE_SATURATE_PX,
    gazeYawPitch,
    UTTERANCE_MS,
    utteranceEnvelope,
} from "./petmotion";

const YAW = 0.6;
const PITCH = 0.34;
const FAR = GAZE_SATURATE_PX * 2;

describe("gazeYawPitch", () => {
    it("does not turn when the pointer is on the avatar's own centre", () => {
        // no direction to turn toward, and a divide by zero here would put NaN into a matrix
        expect(gazeYawPitch(100, 100, 100, 100, YAW, PITCH)).toEqual({ yaw: 0, pitch: 0 });
    });

    it("turns to the yaw cap and no pitch when the pointer is straight out to the side", () => {
        const g = gazeYawPitch(100, 100, 100 + FAR, 100, YAW, PITCH);
        expect(g.yaw).toBeCloseTo(YAW);
        expect(g.pitch).toBeCloseTo(0);
    });

    it("pitches up for a pointer above, because screen y grows downward", () => {
        const g = gazeYawPitch(100, 100, 100, 100 - FAR, YAW, PITCH);
        expect(g.pitch).toBeCloseTo(PITCH);
    });

    it("pitches down for a pointer below", () => {
        const g = gazeYawPitch(100, 100, 100, 100 + FAR, YAW, PITCH);
        expect(g.pitch).toBeCloseTo(-PITCH);
    });

    it("splits its budget on a diagonal rather than reaching both caps at once", () => {
        // the bug this guards: clamping each axis independently lets a diagonal hit yawCap AND pitchCap,
        // which is a harder turn than the caps were chosen to allow
        const g = gazeYawPitch(100, 100, 100 + FAR, 100 + FAR, YAW, PITCH);
        expect(Math.abs(g.yaw)).toBeLessThan(YAW);
        expect(Math.abs(g.pitch)).toBeLessThan(PITCH);
    });

    it("turns less for a near pointer, so resting the mouse alongside does not peg it", () => {
        const near = gazeYawPitch(100, 100, 100 + GAZE_SATURATE_PX / 8, 100, YAW, PITCH);
        const far = gazeYawPitch(100, 100, 100 + FAR, 100, YAW, PITCH);
        expect(near.yaw).toBeGreaterThan(0);
        expect(near.yaw).toBeLessThan(far.yaw);
    });

    it("treats a negative cap as no room rather than turning the wrong way", () => {
        const g = gazeYawPitch(100, 100, 100 + FAR, 100, -1, PITCH);
        expect(g.yaw).toBe(0);
    });

    it("returns zero for a non-finite pointer reading instead of NaN", () => {
        expect(gazeYawPitch(100, 100, Number.NaN, 100, YAW, PITCH)).toEqual({ yaw: 0, pitch: 0 });
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
});
