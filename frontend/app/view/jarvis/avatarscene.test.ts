import { describe, expect, it } from "vitest";
import {
    approachMood,
    buildAvatarScene,
    MOOD_TAU_MS,
    moodFor,
    settledMood,
    STROKE,
    STROKE_WIDTHS,
    type AvatarScene,
    type RenderMood,
    type SceneInput,
} from "./avatarscene";
import type { PetExpression } from "./petcondition";

const AT_REST: PetExpression = { kind: "at-rest" };
const BLIND: PetExpression = { kind: "cannot-see", reason: "off" };
const TIRED: PetExpression = { kind: "tired", provider: "claude", pct: 92 };
const DRIFTING: PetExpression = { kind: "drifting", queueDepth: 14 };

const POSTURES = ["none", "review-gate", "escalation", "blocked-worker"] as const;

// The size the avatar actually ships at (petview's AVATAR_PX). Every threshold below is a fraction of it,
// because "does this read" is only ever a question about this size.
const SIZE = 132;

function input(over: Partial<SceneInput> = {}): SceneInput {
    return {
        expression: AT_REST,
        posture: "none",
        size: SIZE,
        now: 0,
        yaw: 0,
        pitch: 0,
        breath: 0,
        utterance: 0,
        quiet: false,
        ripple: null,
        jolt: 0,
        still: false,
        ...over,
    };
}

/** Total light the scene puts on the canvas. Additive blending makes the alpha sum the closest pure proxy. */
function light(scene: AvatarScene): number {
    return scene.segments.reduce((n, s) => n + s.alpha, 0) + scene.fills.reduce((n, f) => n + f.alpha, 0);
}

describe("moodFor", () => {
    it("gives every expression a themeable tone token, never a literal colour", () => {
        for (const e of [AT_REST, BLIND, TIRED, DRIFTING]) {
            expect(moodFor(e).toneVar).toMatch(/^--color-/);
        }
    });

    it("severs nothing at rest and severs most when it cannot see", () => {
        expect(moodFor(AT_REST).sever).toBe(0);
        expect(moodFor(BLIND).sever).toBeGreaterThan(0.5);
    });

    it("slows the form most when tired, because a depleted window is a machine running slow", () => {
        expect(moodFor(TIRED).spin).toBeLessThan(moodFor(AT_REST).spin);
        expect(moodFor(TIRED).energy).toBeLessThan(moodFor(AT_REST).energy);
    });

    it("loses alignment when drifting, which is loss of structure rather than loss of power", () => {
        expect(moodFor(DRIFTING).align).toBeLessThan(moodFor(TIRED).align);
    });

    it("dims for tired and for nothing else, because only one register is about power", () => {
        // The register table (design doc §3) makes this load-bearing: a depleted rate-limit window is the
        // one condition defined as dimming. Drifting and cannot-see were both authored below it once, so
        // decay and blindness borrowed the exhaustion tell — and cannot-see, the most severe register there
        // is, ended up the faintest of the four.
        for (const e of [AT_REST, DRIFTING, BLIND]) {
            expect(moodFor(e).energy).toBeGreaterThan(moodFor(TIRED).energy);
        }
    });

    it("stutters only when something is actually wrong", () => {
        expect(moodFor(AT_REST).jitter).toBe(0);
        expect(moodFor(BLIND).jitter).toBeGreaterThan(moodFor(DRIFTING).jitter);
    });
});

describe("buildAvatarScene — the form", () => {
    it("emits both line work and fills, because neither alone carries the form", () => {
        const scene = buildAvatarScene(input());
        expect(scene.segments.length).toBeGreaterThan(0);
        expect(scene.fills.length).toBeGreaterThan(0);
    });

    it("draws every stroke at one of the ladder's four weights", () => {
        // weight is what separates the layers, and avatarthree batches by it: a width off the ladder would
        // silently never be drawn
        const scene = buildAvatarScene(input({ posture: "escalation", utterance: 1 }));
        for (const s of scene.segments) {
            expect(STROKE_WIDTHS).toContain(s.width);
        }
    });

    it("emits fills as convex quads, because a fan from vertex zero is all a renderer does with them", () => {
        const scene = buildAvatarScene(input({ posture: "escalation" }));
        for (const f of scene.fills) {
            expect(f.points.length).toBe(4);
        }
    });

    it("stays under the primitive budget the old form blew through", () => {
        // ~890 hairlines inside a 132px box is what made the sphere-and-network form a smudge; the fix is
        // structural, so it is guarded structurally rather than left as a comment
        const scene = buildAvatarScene(input({ posture: "escalation", utterance: 1, ripple: 0.5 }));
        expect(scene.segments.length).toBeLessThan(650);
    });

    it("carries the mood's tone token rather than a colour", () => {
        const scene = buildAvatarScene(input({ expression: TIRED }));
        expect(scene.toneVar).toBe(moodFor(TIRED).toneVar);
    });

    it("keeps every primitive alpha within 0..1", () => {
        for (const expression of [AT_REST, BLIND, TIRED, DRIFTING]) {
            const scene = buildAvatarScene(input({ expression, utterance: 1, ripple: 0.4, now: 3_100 }));
            for (const s of scene.segments) {
                expect(s.alpha).toBeGreaterThanOrEqual(0);
                expect(s.alpha).toBeLessThanOrEqual(1);
            }
            for (const f of scene.fills) {
                expect(f.alpha).toBeGreaterThanOrEqual(0);
                expect(f.alpha).toBeLessThanOrEqual(1);
            }
        }
    });

    it("produces no NaN coordinates for any expression or posture", () => {
        for (const expression of [AT_REST, BLIND, TIRED, DRIFTING]) {
            for (const posture of POSTURES) {
                const scene = buildAvatarScene(input({ expression, posture, yaw: 0.4, pitch: -0.2 }));
                for (const s of scene.segments) {
                    expect(Number.isFinite(s.ax + s.ay + s.bx + s.by)).toBe(true);
                }
                for (const f of scene.fills) {
                    for (const p of f.points) {
                        expect(Number.isFinite(p[0] + p[1])).toBe(true);
                    }
                }
            }
        }
    });

    it("holds still when reduced motion is set", () => {
        const a = buildAvatarScene(input({ still: true, now: 0 }));
        const b = buildAvatarScene(input({ still: true, now: 9_999 }));
        expect(a).toEqual(b);
    });

    it("never turns far enough to lose the form edge-on", () => {
        // idleOrbit yaws a full circle, which was right for a sphere and is wrong for a stack of planes: a
        // quarter of every turn would collapse the avatar to a handful of lines. The scene reads that yaw as
        // a phase and sways inside a bounded arc, so the form is never seen from an angle it does not read
        // from — asserted as "the silhouette never collapses", which is the thing that actually matters.
        let narrowest = Infinity;
        for (let turn = 0; turn < 24; turn++) {
            const scene = buildAvatarScene(input({ yaw: (turn / 24) * Math.PI * 2 }));
            const xs = scene.segments.flatMap((s) => [s.ax, s.bx]);
            narrowest = Math.min(narrowest, Math.max(...xs) - Math.min(...xs));
        }
        expect(narrowest).toBeGreaterThan(SIZE * 0.4);
    });
});

describe("buildAvatarScene — the register axes", () => {
    it("cuts struts as severance rises, deterministically", () => {
        const rest = buildAvatarScene(input({ expression: AT_REST }));
        const blind = buildAvatarScene(input({ expression: BLIND }));
        expect(blind.segments.length).toBeLessThan(rest.segments.length);
        // the same ones stay cut frame to frame: a link that came and went would be jitter, not damage
        expect(buildAvatarScene(input({ expression: BLIND, now: 5_000 })).segments.length).toBe(blind.segments.length);
    });

    it("spreads the three planes apart as alignment falls", () => {
        // coplanarity IS the drifting register's tell, so it is asserted on the geometry, not on pixels
        const spread = (expression: PetExpression) => {
            const depths = buildAvatarScene(input({ expression })).segments.map((s) => s.depth);
            return Math.max(...depths) - Math.min(...depths);
        };
        expect(spread(DRIFTING)).toBeGreaterThan(spread(AT_REST));
        expect(spread(BLIND)).toBeGreaterThan(spread(DRIFTING));
    });

    it("holds still at rest rather than idling like a spinner", () => {
        // spin is spent only on what alignment has already loosened, so a healthy avatar breathes in place
        const a = buildAvatarScene(input({ expression: AT_REST, now: 0 }));
        const b = buildAvatarScene(input({ expression: AT_REST, now: 6_000 }));
        expect(a.segments).toEqual(b.segments);
    });

    it("tumbles once alignment is lost", () => {
        const a = buildAvatarScene(input({ expression: BLIND, now: 0 }));
        const b = buildAvatarScene(input({ expression: BLIND, now: 6_000 }));
        expect(a.segments.map((s) => s.ax)).not.toEqual(b.segments.map((s) => s.ax));
    });

    it("says instability by cutting the form out, never by shaking it", () => {
        // The replacement for a positional tremble, and the reason for it: a jitter that displaced the form
        // spoke in the same channel as a jolt — "an arrival landed on me" and "I am losing my own signal"
        // became the same motion — and at 132px a sub-2px tremble read as a rendering fault anyway.
        const at = (jitter: number) =>
            buildAvatarScene(input({ expression: BLIND, now: 2_350, mood: { ...settledMood(BLIND), jitter } }));
        const steady = at(0);
        const stuttering = at(0.75);
        expect(stuttering.segments.map((s) => [s.ax, s.ay, s.bx, s.by])).toEqual(
            steady.segments.map((s) => [s.ax, s.ay, s.bx, s.by])
        );
        expect(stuttering.centreX).toBe(steady.centreX);
        expect(stuttering.centreY).toBe(steady.centreY);
        expect(light(stuttering)).toBeLessThan(light(steady));
    });

    it("drops layers independently, so the whole form never blinks at once", () => {
        // a form that vanished and returned would read as a rendering fault; parts cutting out reads as a
        // signal being lost
        let sawPartial = false;
        for (let step = 0; step < 40; step++) {
            const scene = buildAvatarScene(input({ expression: BLIND, now: step * 137 }));
            const alphas = new Set(scene.segments.filter((s) => s.width === STROKE.fine).map((s) => s.alpha));
            if (alphas.size > 1) {
                sawPartial = true;
                break;
            }
        }
        expect(sawPartial).toBe(true);
    });

    it("never lets a register fall out of the same brightness band as resting", () => {
        // It guards a compounding, not one number. Alignment used to be spent twice (planes diverge AND
        // alpha falls), that product met a mood energy already below resting, and QUIET_DIM multiplied the
        // result again. Measured through the GL renderer at the shipped size, drifting lit 1.2% of its box
        // against resting's 8.5%. Every factor was defensible alone; the product was a register that
        // reported vault decay by becoming invisible.
        //
        // Averaged over the clock, because the stutter deliberately takes light away at some instants — the
        // guard is about the register's floor over time, not about a single frame.
        const mean = (expression: PetExpression) => {
            let total = 0;
            for (let step = 0; step < 64; step++) {
                total += light(buildAvatarScene(input({ expression, quiet: true, now: step * 97 })));
            }
            return total / 64;
        };
        const rest = mean(AT_REST);
        for (const expression of [TIRED, DRIFTING, BLIND]) {
            expect(mean(expression)).toBeGreaterThan(0.5 * rest);
        }
    });
});

describe("buildAvatarScene — presence", () => {
    it("dims when it has nothing to say, and does not shrink", () => {
        // The helmet-display rule (peripheral when idle, central when needed) rides brightness alone. It
        // used to ride three axes at once — a smaller canvas from petview, a smaller form radius, AND a
        // dimmer glow — which compounded into a resting form under a fifth of its box by area. At-rest-and-
        // idle is the condition the avatar is in almost all the time, so that was the state the user saw.
        const loud = buildAvatarScene(input({ quiet: false }));
        const idle = buildAvatarScene(input({ quiet: true }));
        expect(idle.extent).toBeCloseTo(loud.extent);
        expect(light(idle)).toBeLessThan(light(loud));
    });

    it("still fills enough of its box at rest to be visible", () => {
        // guards the regression above returning by any route: a form under about a quarter of its own box
        // reads as a smudge in window chrome, whatever the reason it got small
        expect(buildAvatarScene(input({ quiet: true })).extent).toBeGreaterThan(SIZE * 0.28);
    });

    it("never reaches its own canvas edge, even mid-utterance under a knock", () => {
        // The bloom needs somewhere to fall off: a primitive at the border makes the blur clamp against the
        // framebuffer and the avatar wears a visible lighter square. This is the constraint that keeps
        // SPHERE_FRACTION where it is, so it is asserted rather than left as a comment.
        for (const expression of [AT_REST, BLIND, TIRED, DRIFTING]) {
            for (const posture of POSTURES) {
                for (const yaw of [0, 1.6, 3.1, 4.7]) {
                    const scene = buildAvatarScene(
                        input({
                            expression,
                            posture,
                            utterance: 1,
                            breath: 1,
                            yaw,
                            pitch: -0.34,
                            now: 7_777,
                            // a jolt moves the centre the extent is measured from, so the worst case for
                            // the border is a full-amplitude knock at full utterance, not either alone
                            jolt: 1,
                            ripple: 0.5,
                        })
                    );
                    const offCentre = Math.hypot(scene.centreX - SIZE / 2, scene.centreY - SIZE / 2);
                    expect(scene.extent + offCentre).toBeLessThan(SIZE / 2);
                }
            }
        }
    });
});

describe("buildAvatarScene — posture", () => {
    it("emits no marker primitives and no marker colour when nothing is waiting", () => {
        const scene = buildAvatarScene(input({ posture: "none" }));
        expect(scene.markerVar).toBeNull();
        expect(scene.segments.some((s) => s.tone === "marker")).toBe(false);
        expect(scene.fills.some((f) => f.tone === "marker")).toBe(false);
    });

    it("emits a filled sector and a marker colour for each kind of waiting", () => {
        // the fill is the point: the same marker drawn as a hairline arc disappeared at the shipped size,
        // because a stroke competing with a lit form behind it loses however wide you make it
        for (const posture of ["review-gate", "escalation", "blocked-worker"] as const) {
            const scene = buildAvatarScene(input({ posture }));
            expect(scene.markerVar).toMatch(/^--color-/);
            expect(scene.fills.some((f) => f.tone === "marker")).toBe(true);
            expect(scene.segments.some((s) => s.tone === "marker" && s.width === STROKE.bold)).toBe(true);
        }
    });

    it("dims the body behind the marker rather than drawing over it", () => {
        const waiting = buildAvatarScene(input({ posture: "escalation" }));
        const clear = buildAvatarScene(input({ posture: "none" }));
        const body = (s: AvatarScene) => s.segments.filter((x) => x.tone !== "marker").reduce((n, x) => n + x.alpha, 0);
        expect(body(waiting)).toBeLessThan(body(clear));
    });

    it("keeps the marker at full strength however dim the body behind it is", () => {
        const bright = buildAvatarScene(input({ expression: AT_REST, posture: "escalation" }));
        const faint = buildAvatarScene(input({ expression: TIRED, posture: "escalation" }));
        const rim = (s: AvatarScene) => Math.max(...s.segments.filter((x) => x.tone === "marker").map((x) => x.alpha));
        expect(rim(faint)).toBeCloseTo(rim(bright));
    });

    it("puts each kind of waiting at its own bearing", () => {
        // three postures that are otherwise identical are told apart by WHERE on the rim the marker sits
        const bearingOf = (posture: (typeof POSTURES)[number]) => {
            const scene = buildAvatarScene(input({ posture, still: true }));
            const marks = scene.fills.filter((f) => f.tone === "marker");
            const x = marks.reduce((n, f) => n + f.points[0][0], 0) / marks.length;
            const y = marks.reduce((n, f) => n + f.points[0][1], 0) / marks.length;
            return Math.atan2(y - scene.centreY, x - scene.centreX);
        };
        const bearings = (["review-gate", "escalation", "blocked-worker"] as const).map(bearingOf);
        expect(new Set(bearings.map((b) => b.toFixed(2))).size).toBe(3);
    });

    it("gives each kind of waiting a distinguishable colour", () => {
        const vars = (["review-gate", "escalation", "blocked-worker"] as const).map(
            (posture) => buildAvatarScene(input({ posture })).markerVar
        );
        expect(new Set(vars).size).toBe(3);
    });

    it("cannot draw a count, because the scene has no primitive that could carry one", () => {
        // The de-duplication contract with the nav rail badge is structural, not a runtime check: the only
        // primitive types are strokes and fills, so a number is unrepresentable. This test guards the type
        // from growing a text primitive later.
        const scene = buildAvatarScene(input({ posture: "escalation", expression: BLIND }));
        expect(new Set(Object.keys(scene))).toEqual(
            new Set([
                "segments",
                "fills",
                "toneVar",
                "toneFromVar",
                "toneMix",
                "markerVar",
                "centreX",
                "centreY",
                "extent",
            ])
        );
    });
});

describe("approachMood", () => {
    // three time constants covers ~95% of the distance; used as "settled" throughout
    const settle = (from: RenderMood, to: PetExpression, steps = 40) => {
        let m = from;
        for (let i = 0; i < steps; i++) {
            m = approachMood(m, to, MOOD_TAU_MS / 2);
        }
        return m;
    };

    it("arrives at the target mood rather than near it", () => {
        const m = settle(settledMood(AT_REST), TIRED);
        const target = moodFor(TIRED);
        expect(m.energy).toBeCloseTo(target.energy, 3);
        expect(m.align).toBeCloseTo(target.align, 3);
        expect(m.sever).toBeCloseTo(target.sever, 3);
        expect(m.toneVar).toBe(target.toneVar);
        expect(m.toneFromVar).toBeNull();
    });

    it("passes through the space between the two moods instead of snapping", () => {
        // the whole point: a register change used to land in one frame, tone and geometry at once
        const one = approachMood(settledMood(AT_REST), BLIND, 16);
        expect(one.sever).toBeGreaterThan(0);
        expect(one.sever).toBeLessThan(moodFor(BLIND).sever);
        expect(one.align).toBeLessThan(moodFor(AT_REST).align);
        expect(one.align).toBeGreaterThan(moodFor(BLIND).align);
    });

    it("takes the same wall-clock time whatever the framerate", () => {
        // exponential step, not a fixed fraction per frame — otherwise a 144Hz display eases four times
        // faster than a 30Hz one and the transition is a different animation on different machines
        let slow = settledMood(AT_REST);
        for (let t = 0; t < 480; t += 32) {
            slow = approachMood(slow, TIRED, 32);
        }
        let fast = settledMood(AT_REST);
        for (let t = 0; t < 480; t += 8) {
            fast = approachMood(fast, TIRED, 8);
        }
        expect(slow.energy).toBeCloseTo(fast.energy, 2);
    });

    it("crossfades the tone, and only while the tone is actually changing", () => {
        const settledAtRest = settledMood(AT_REST);
        expect(settledAtRest.toneFromVar).toBeNull();

        const started = approachMood(settledAtRest, TIRED, 16);
        expect(started.toneFromVar).toBe(moodFor(AT_REST).toneVar);
        expect(started.toneVar).toBe(moodFor(TIRED).toneVar);
        expect(started.toneMix).toBeLessThan(0.2);

        expect(settle(started, TIRED).toneFromVar).toBeNull();
    });

    it("reverses out of a half-finished crossfade from the blend, not from the tone it was heading for", () => {
        // a condition that appears and clears inside one poll cycle must not produce a colour pop
        // the frame that notices the change only arms the crossfade at 0; the next one advances it
        let m = approachMood(approachMood(settledMood(AT_REST), BLIND, MOOD_TAU_MS), BLIND, MOOD_TAU_MS);
        expect(m.toneMix).toBeGreaterThan(0);
        expect(m.toneMix).toBeLessThan(1);
        m = approachMood(m, AT_REST, 16);
        expect(m.toneVar).toBe(moodFor(AT_REST).toneVar);
        expect(m.toneFromVar).toBe(moodFor(BLIND).toneVar);
    });

    it("does not move on a zero, negative or non-finite frame time", () => {
        const start = settledMood(AT_REST);
        for (const dt of [0, -16, Number.NaN]) {
            expect(approachMood(start, TIRED, dt).energy).toBeCloseTo(start.energy);
        }
    });

    it("clamps an absurd frame gap instead of overshooting", () => {
        // a backgrounded window can hand back a multi-second dt on its first frame
        const m = approachMood(settledMood(AT_REST), BLIND, 600_000);
        expect(m.sever).toBeLessThanOrEqual(moodFor(BLIND).sever);
        expect(m.energy).toBeGreaterThanOrEqual(Math.min(moodFor(AT_REST).energy, moodFor(BLIND).energy));
    });
});

describe("buildAvatarScene — punctuation", () => {
    it("brightens the form when a ripple crosses it", () => {
        expect(light(buildAvatarScene(input({ ripple: 0.4 })))).toBeGreaterThan(
            light(buildAvatarScene(input({ ripple: null })))
        );
    });

    it("moves the front outward, so the wave travels instead of pulsing in place", () => {
        // measured as the ripple's CONTRIBUTION rather than as absolute brightness: the form's own depth
        // falloff swings a primitive's alpha more than the ripple does, so an argmax over the raw value
        // just reports whichever layer happens to face the viewer
        const base = buildAvatarScene(input({ ripple: null }));
        const litRadius = (ripple: number) => {
            const scene = buildAvatarScene(input({ ripple }));
            let weight = 0;
            let total = 0;
            scene.segments.forEach((s, i) => {
                const gain = s.alpha - base.segments[i].alpha;
                if (gain > 0) {
                    const r = Math.hypot((s.ax + s.bx) / 2 - scene.centreX, (s.ay + s.by) / 2 - scene.centreY);
                    weight += gain;
                    total += gain * r;
                }
            });
            expect(weight).toBeGreaterThan(0);
            return total / weight;
        };
        expect(litRadius(0.8)).toBeGreaterThan(litRadius(0.2));
    });

    it("leaves the form untouched when nothing is rippling", () => {
        expect(buildAvatarScene(input({ ripple: null }))).toEqual(buildAvatarScene(input({ ripple: null, jolt: 0 })));
    });

    it("lights the centre and shows the sweep while Jarvis is speaking", () => {
        const quietForm = buildAvatarScene(input({ utterance: 0 }));
        const speaking = buildAvatarScene(input({ utterance: 1 }));
        expect(light(speaking)).toBeGreaterThan(light(quietForm));
        // the sweep is the one part of the form that spins on its own clock, so it must never be visible
        // at rest — a permanent sweep is a loading spinner
        const sweep = (s: AvatarScene) => s.segments.filter((x) => x.tone === "hot" && x.width === STROKE.bold).length;
        expect(sweep(quietForm)).toBe(0);
        expect(sweep(speaking)).toBeGreaterThan(0);
    });

    it("keeps a tired voice quieter than a rested one instead of clamping both to full", () => {
        // unscaled, a tired avatar that started speaking hit the same alpha ceiling a rested one does, and
        // its register vanished for as long as it was talking
        const peak = (expression: PetExpression) => {
            const spoke = buildAvatarScene(input({ expression, utterance: 1 }));
            const still = buildAvatarScene(input({ expression, utterance: 0 }));
            return light(spoke) - light(still);
        };
        expect(peak(TIRED)).toBeLessThan(peak(AT_REST));
    });

    it("displaces the whole assembly for a jolt, rather than deforming it", () => {
        // a per-primitive wobble would read as instability, which is already what jitter means — so a jolt
        // must move the centre and leave the geometry rigid
        const steady = buildAvatarScene(input({ jolt: 0, now: 4_000 }));
        const hit = buildAvatarScene(input({ jolt: 1, now: 4_000 }));
        expect(Math.hypot(hit.centreX - steady.centreX, hit.centreY - steady.centreY)).toBeGreaterThan(0);
        expect(hit.extent).toBeCloseTo(steady.extent, 5);
    });

    it("holds still for all of it when reduced motion is set", () => {
        const calm = buildAvatarScene(input({ still: true, jolt: 1, ripple: 0.5, utterance: 1, now: 4_000 }));
        const none = buildAvatarScene(input({ still: true, jolt: 0, ripple: null, utterance: 0, now: 4_000 }));
        expect(calm).toEqual(none);
    });
});
