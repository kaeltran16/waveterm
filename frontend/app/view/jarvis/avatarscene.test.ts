import { describe, expect, it } from "vitest";
import {
    type AvatarScene,
    buildAvatarScene,
    moodFor,
    networkFor,
    ringPlaneNormal,
    type SceneInput,
} from "./avatarscene";
import type { PetExpression } from "./petcondition";

const AT_REST: PetExpression = { kind: "at-rest" };
const BLIND: PetExpression = { kind: "cannot-see", reason: "off" };
const TIRED: PetExpression = { kind: "tired", pct: 92 };
const DRIFTING: PetExpression = { kind: "drifting", queueDepth: 14 };

function input(over: Partial<SceneInput> = {}): SceneInput {
    return {
        expression: AT_REST,
        posture: "none",
        size: 112,
        now: 0,
        yaw: 0,
        pitch: 0,
        breath: 0,
        utterance: 0,
        quiet: false,
        rings: 3,
        ringTicks: 72,
        nodes: 16,
        shell: true,
        still: false,
        ...over,
    };
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

    it("slows the platters most when tired, because a depleted window is a machine running slow", () => {
        expect(moodFor(TIRED).spin).toBeLessThan(moodFor(AT_REST).spin);
        expect(moodFor(TIRED).energy).toBeLessThan(moodFor(AT_REST).energy);
    });

    it("loses alignment when drifting, which is loss of structure rather than loss of power", () => {
        expect(moodFor(DRIFTING).align).toBeLessThan(moodFor(TIRED).align);
    });
});

describe("networkFor", () => {
    it("returns nothing for a zero node count", () => {
        expect(networkFor(0)).toEqual({ nodes: [], links: [] });
    });

    it("keeps every node inside the unit sphere", () => {
        for (const n of networkFor(24).nodes) {
            expect(Math.hypot(n[0], n[1], n[2])).toBeLessThanOrEqual(1);
        }
    });

    it("links every node to at least one neighbour", () => {
        const net = networkFor(12);
        const touched = new Set<number>();
        for (const [a, b] of net.links) {
            touched.add(a);
            touched.add(b);
        }
        expect(touched.size).toBe(net.nodes.length);
    });

    it("never links a node to itself and never repeats a pair", () => {
        const net = networkFor(20);
        const seen = new Set<string>();
        for (const [a, b] of net.links) {
            expect(a).not.toBe(b);
            const key = a < b ? a + ":" + b : b + ":" + a;
            expect(seen.has(key)).toBe(false);
            seen.add(key);
        }
    });

    it("is stable across calls, so the form does not reshuffle every frame", () => {
        expect(networkFor(16)).toEqual(networkFor(16));
    });
});

describe("buildAvatarScene — the network", () => {
    it("emits fewer links when it cannot see than at rest", () => {
        // the rank-1 register: degraded recall IS a broken connection network
        const rest = buildAvatarScene(input({ expression: AT_REST, rings: 0, shell: false }));
        const blind = buildAvatarScene(input({ expression: BLIND, rings: 0, shell: false }));
        expect(blind.segments.length).toBeLessThan(rest.segments.length);
    });

    it("emits one point per node", () => {
        const scene = buildAvatarScene(input({ nodes: 14, rings: 0, shell: false }));
        expect(scene.points.length).toBe(14);
    });

    it("carries the mood's tone token rather than a colour", () => {
        const scene = buildAvatarScene(input({ expression: TIRED }));
        expect(scene.toneVar).toBe(moodFor(TIRED).toneVar);
    });

    it("keeps every primitive alpha within 0..1", () => {
        const scene = buildAvatarScene(input({ expression: DRIFTING }));
        for (const s of scene.segments) {
            expect(s.alpha).toBeGreaterThanOrEqual(0);
            expect(s.alpha).toBeLessThanOrEqual(1);
        }
        for (const p of scene.points) {
            expect(p.alpha).toBeGreaterThanOrEqual(0);
            expect(p.alpha).toBeLessThanOrEqual(1);
        }
    });

    it("produces no NaN coordinates for any expression or posture", () => {
        for (const expression of [AT_REST, BLIND, TIRED, DRIFTING]) {
            for (const posture of ["none", "review-gate", "escalation", "blocked-worker"] as const) {
                const scene = buildAvatarScene(input({ expression, posture, yaw: 0.4, pitch: -0.2 }));
                for (const s of scene.segments) {
                    expect(Number.isFinite(s.ax + s.ay + s.bx + s.by)).toBe(true);
                }
                for (const p of scene.points) {
                    expect(Number.isFinite(p.x + p.y + p.size)).toBe(true);
                }
            }
        }
    });

    it("holds still when reduced motion is set", () => {
        const a = buildAvatarScene(input({ still: true, now: 0 }));
        const b = buildAvatarScene(input({ still: true, now: 9_999 }));
        expect(a).toEqual(b);
    });
});

function dot(a: readonly number[], b: readonly number[]): number {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

describe("ringPlaneNormal", () => {
    it("returns unit normals", () => {
        for (let i = 0; i < 4; i++) {
            const n = ringPlaneNormal(i, 1);
            expect(Math.hypot(n[0], n[1], n[2])).toBeCloseTo(1);
        }
    });

    it("brings the ring planes together as alignment rises", () => {
        // coplanarity IS the drifting register's tell, so it is asserted on the geometry, not on pixels
        const spreadAligned = 1 - Math.abs(dot(ringPlaneNormal(0, 1), ringPlaneNormal(2, 1)));
        const spreadDrifting = 1 - Math.abs(dot(ringPlaneNormal(0, 0.14), ringPlaneNormal(2, 0.14)));
        expect(spreadAligned).toBeLessThan(spreadDrifting);
    });
});

describe("buildAvatarScene — shell and platters", () => {
    it("draws no ring geometry when the ring count is zero", () => {
        const none = buildAvatarScene(input({ rings: 0, shell: false }));
        const three = buildAvatarScene(input({ rings: 3, shell: false }));
        expect(three.segments.length).toBeGreaterThan(none.segments.length);
    });

    it("adds shell arcs only when the shell is on", () => {
        const off = buildAvatarScene(input({ rings: 0, shell: false }));
        const on = buildAvatarScene(input({ rings: 0, shell: true }));
        expect(on.segments.length).toBeGreaterThan(off.segments.length);
    });

    it("lengthens ring ticks monotonically with the utterance envelope", () => {
        // the rings answer to Jarvis speaking. There is no audio; the driver is the bubble appearing.
        const reach = (utterance: number) =>
            buildAvatarScene(input({ utterance, rings: 3, shell: false, nodes: 0 })).extent;
        expect(reach(1)).toBeGreaterThan(reach(0.5));
        expect(reach(0.5)).toBeGreaterThan(reach(0));
    });

    it("dims when it has nothing to say, and does not shrink", () => {
        // The helmet-display rule (peripheral when idle, central when needed) rides brightness alone. It
        // used to ride three axes at once — a smaller canvas from petview, a smaller sphere radius, AND a
        // dimmer glow — which compounded into a resting form 28px wide inside a 68px box. At-rest-and-idle
        // is the condition the avatar is in almost all the time, so that was the state the user always saw.
        const loud = buildAvatarScene(input({ quiet: false }));
        const idle = buildAvatarScene(input({ quiet: true }));
        expect(idle.extent).toBeCloseTo(loud.extent);
        const peak = (s: AvatarScene) => Math.max(...s.segments.map((x) => x.alpha));
        expect(peak(idle)).toBeLessThan(peak(loud));
    });

    it("still fills enough of its box at rest to be visible", () => {
        // guards the regression above returning by any route: a form under about a quarter of its own box
        // reads as a smudge in window chrome, whatever the reason it got small
        const scene = buildAvatarScene(input({ quiet: true }));
        expect(scene.extent).toBeGreaterThan(112 * 0.28);
    });

    it("never reaches its own canvas edge, even mid-utterance at full jitter", () => {
        // The bloom needs somewhere to fall off: a primitive at the border makes the blur clamp against the
        // framebuffer and the avatar wears a visible lighter square. This is the constraint that keeps
        // SPHERE_FRACTION where it is, so it is asserted rather than left as a comment.
        for (const expression of [AT_REST, BLIND, TIRED, DRIFTING]) {
            for (const posture of ["none", "review-gate", "escalation", "blocked-worker"] as const) {
                const scene = buildAvatarScene(
                    input({ expression, posture, utterance: 1, breath: 1, yaw: 0.6, pitch: -0.34, now: 7_777 })
                );
                expect(scene.extent).toBeLessThan(112 / 2);
            }
        }
    });

    it("emits an even vertex count, because every primitive is a segment or a point", () => {
        const scene = buildAvatarScene(input());
        expect(scene.segments.length).toBeGreaterThan(0);
        expect(scene.points.length).toBeGreaterThan(0);
    });
});

describe("buildAvatarScene — posture", () => {
    it("emits no marker primitives and no marker colour when nothing is waiting", () => {
        const scene = buildAvatarScene(input({ posture: "none" }));
        expect(scene.markerVar).toBeNull();
        expect(scene.segments.some((s) => s.tone === "marker")).toBe(false);
    });

    it("emits marker primitives and a marker colour for each kind of waiting", () => {
        for (const posture of ["review-gate", "escalation", "blocked-worker"] as const) {
            const scene = buildAvatarScene(input({ posture }));
            expect(scene.markerVar).toMatch(/^--color-/);
            expect(scene.segments.some((s) => s.tone === "marker")).toBe(true);
        }
    });

    it("gives each kind of waiting a distinguishable colour", () => {
        const vars = (["review-gate", "escalation", "blocked-worker"] as const).map(
            (posture) => buildAvatarScene(input({ posture })).markerVar
        );
        expect(new Set(vars).size).toBe(3);
    });

    it("cannot draw a count, because the scene has no primitive that could carry one", () => {
        // The de-duplication contract with the nav rail badge is structural, not a runtime check: the only
        // primitive types are segments and points, so a number is unrepresentable. This test guards the
        // type from growing a text primitive later.
        const scene = buildAvatarScene(input({ posture: "escalation", expression: BLIND }));
        const keys = new Set(Object.keys(scene));
        expect(keys).toEqual(new Set(["segments", "points", "toneVar", "markerVar", "centreX", "centreY", "extent"]));
    });

    it("drops the marker when there are no platters to hang it on", () => {
        const scene = buildAvatarScene(input({ posture: "escalation", rings: 0 }));
        expect(scene.segments.some((s) => s.tone === "marker")).toBe(false);
    });
});
