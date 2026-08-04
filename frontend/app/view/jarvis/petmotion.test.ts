import { describe, expect, it } from "vitest";
import { BLINK_MAX_MS, BLINK_MIN_MS, eyeRoom, GAZE_SATURATE_PX, gazeOffset, nextBlinkDelay } from "./petmotion";

// the at-rest eye, from petview.tsx's SHAPES: a round lid with the gaze centred
const ALERT = { rx: 4.4, ry: 4.4, dy: 0 };
// the drifting eye: a flatter lid whose gaze is already slumped most of the way down it
const SLUMPED = { rx: 4, ry: 3.4, dy: 1.4 };
const PUPIL_R = 1.9;
const CAP = 1.5;

const FAR = GAZE_SATURATE_PX * 2;

describe("gazeOffset", () => {
    it("does not deflect when the pointer is on the creature's own centre", () => {
        // the 0/0 case: no direction to look, and a NaN here would land in a transform
        expect(gazeOffset(100, 100, 100, 100, CAP, CAP)).toEqual({ dx: 0, dy: 0 });
    });

    it("deflects to the cap on one axis only when the pointer is straight out to the side", () => {
        const g = gazeOffset(100, 100, 100 + FAR, 100, CAP, CAP);
        expect(g.dx).toBeCloseTo(CAP);
        expect(g.dy).toBeCloseTo(0);
    });

    it("follows the pointer up and to the left, signs and all", () => {
        const g = gazeOffset(100, 100, 100 - FAR, 100 - FAR, CAP, CAP);
        expect(g.dx).toBeLessThan(0);
        expect(g.dy).toBeLessThan(0);
    });

    it("keeps a diagonal inside the eye instead of letting it reach the corner", () => {
        // the bug this guards: clamping each axis on its own gives dx=dy=cap, a magnitude of cap*1.41,
        // which puts the pupil outside its lid on the diagonal
        const g = gazeOffset(100, 100, 100 + FAR, 100 + FAR, CAP, CAP);
        expect(Math.hypot(g.dx, g.dy)).toBeLessThanOrEqual(CAP + 1e-9);
    });

    it("deflects less for a near pointer than a distant one, so resting on the creature does not peg it", () => {
        const near = gazeOffset(100, 100, 100 + GAZE_SATURATE_PX / 8, 100, CAP, CAP);
        const far = gazeOffset(100, 100, 100 + FAR, 100, CAP, CAP);
        expect(near.dx).toBeGreaterThan(0);
        expect(near.dx).toBeLessThan(far.dx);
    });

    it("pins an axis with no room to zero while the other still tracks", () => {
        const g = gazeOffset(100, 100, 100 + FAR, 100 + FAR, CAP, 0);
        expect(g.dy).toBe(0);
        expect(g.dx).toBeGreaterThan(0);
    });

    it("never returns NaN for a non-finite pointer reading", () => {
        const g = gazeOffset(100, 100, Number.NaN, 100, CAP, CAP);
        expect(g).toEqual({ dx: 0, dy: 0 });
    });
});

describe("eyeRoom", () => {
    it("gives an alert round eye the full cap in both axes", () => {
        expect(eyeRoom(ALERT.rx, ALERT.ry, ALERT.dy, PUPIL_R, CAP)).toEqual({ maxX: CAP, maxY: CAP });
    });

    it("leaves a slumped eye its sideways glance but almost no vertical room", () => {
        // the droop has already spent the lid: 3.4 - 1.9 - 1.4 leaves 0.1 of travel below
        const room = eyeRoom(SLUMPED.rx, SLUMPED.ry, SLUMPED.dy, PUPIL_R, CAP);
        expect(room.maxX).toBeCloseTo(CAP);
        expect(room.maxY).toBeLessThan(0.2);
        expect(room.maxY).toBeGreaterThanOrEqual(0);
    });

    it("reports no room rather than negative room when the pupil already fills the lid", () => {
        // the tired eye: a 2.2 lid cannot hold a 1.9 pupil dropped 0.9 further
        const room = eyeRoom(4.4, 2.2, 0.9, PUPIL_R, CAP);
        expect(room.maxY).toBe(0);
        expect(room.maxX).toBeGreaterThan(0);
    });

    it("never lets a lid narrower than the pupil produce travel", () => {
        const room = eyeRoom(1, 1, 0, PUPIL_R, CAP);
        expect(room).toEqual({ maxX: 0, maxY: 0 });
    });
});

describe("nextBlinkDelay", () => {
    it("stays inside the published bounds across the whole random range", () => {
        for (const rand of [0, 0.25, 0.5, 0.75, 1]) {
            const delay = nextBlinkDelay(rand);
            expect(delay).toBeGreaterThanOrEqual(BLINK_MIN_MS);
            expect(delay).toBeLessThanOrEqual(BLINK_MAX_MS);
        }
    });

    it("maps the ends of the range onto the ends of the bounds", () => {
        expect(nextBlinkDelay(0)).toBe(BLINK_MIN_MS);
        expect(nextBlinkDelay(1)).toBe(BLINK_MAX_MS);
    });

    it("is monotonic, so the cadence is a spread rather than two speeds", () => {
        expect(nextBlinkDelay(0.3)).toBeLessThan(nextBlinkDelay(0.7));
    });

    it("clamps an out-of-range or non-finite draw instead of scheduling a wild delay", () => {
        expect(nextBlinkDelay(-3)).toBe(BLINK_MIN_MS);
        expect(nextBlinkDelay(9)).toBe(BLINK_MAX_MS);
        expect(nextBlinkDelay(Number.NaN)).toBe(BLINK_MIN_MS);
    });
});
