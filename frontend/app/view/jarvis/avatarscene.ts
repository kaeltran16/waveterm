// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The avatar's form, as data. Condition in, a flat list of screen-space primitives out.
//
// Pure on purpose, and that is the whole design (spec §5). The blob this replaced kept its geometry inside
// petview.tsx as JSX attributes, so the only way to check the form was to screenshot the running app. Here
// the form is a function, so the form is testable.
//
// Two renderers consume this — avatarthree.ts and avatarcanvas.ts — which is also how a lost WebGL context
// survives: the fallback draws the same scene rather than a second, drifting copy of the geometry.
//
// Colours leave here as --color-* NAMES, never resolved values. Resolution needs getComputedStyle, which
// would drag the DOM into a unit test and break the theme-token rule the moment someone inlined a hex.
//
// The FORM itself is the one settled by the design studies under docs/prototype/jarvis-hud-*: three arc
// planes stacked in depth, held together by six struts, around a recessed core. It replaced a wireframe
// sphere wrapped in a node network and three tick platters, which had a single problem that no amount of
// constant-tuning fixed — at the size it ships at, ~890 hairlines inside a 132px box fuse into a smudge.
// This form is roughly half as many primitives, each individually resolvable, and it says the same five
// things by moving rather than by having more parts.

import type { PetExpression, PetPosture } from "./petcondition";

/** Which of the renderer's three resolved colours a primitive wants. */
export type SceneTone = "body" | "hot" | "marker";

export interface SceneSegment {
    ax: number;
    ay: number;
    bx: number;
    by: number;
    /** -1 (far) .. 1 (near), before projection. Renderers may dim on it; nothing depends on a z-buffer. */
    depth: number;
    tone: SceneTone;
    alpha: number;
    /**
     * Stroke weight in CSS px, from the STROKE ladder.
     *
     * Per-segment rather than one width for the whole scene, because weight is what separates the layers of
     * this form: the marker rim has to out-weigh a blade, and a blade has to out-weigh the tick ring behind
     * it. With a single width they differed only in alpha, and additive blending spends alpha on depth
     * already. avatarthree batches by width, so the ladder is short on purpose.
     */
    width: number;
}

/**
 * A filled convex polygon in screen space, drawn as a triangle fan from its first vertex.
 *
 * Line work alone could not carry this form. The posture marker went first: drawn as a hairline arc it
 * disappeared at the shipped size, because a stroke competing with a lit form behind it loses however wide
 * you make it. What reads is a filled sector over a body that has been dimmed behind it. The same is true
 * of the arc bands that give the rim and the blades their thickness.
 *
 * Convex on purpose, and emitted as a strip of quads rather than as one ring sector: an annular sector is
 * not convex, so a fan from its first vertex would cut straight across the hole in the middle. Deliberately
 * a projected polygon rather than an arc description, too — the scene builder owns projection, so a
 * renderer sweeping its own arc would be projecting a second time and the two renderers would disagree
 * about where the marker is.
 */
export interface SceneFill {
    /** at least 3 screen-space vertices, in order */
    points: [number, number][];
    depth: number;
    tone: SceneTone;
    alpha: number;
}

export interface AvatarScene {
    segments: SceneSegment[];
    fills: SceneFill[];
    /** a --color-* custom property name; the renderer resolves it and lightens it for the "hot" tone */
    toneVar: string;
    /** the --color-* name being crossfaded away from, or null when the tone is settled */
    toneFromVar: string | null;
    /** 0..1 progress of that crossfade; 1 (and meaningless) when toneFromVar is null */
    toneMix: number;
    /** a --color-* name for the posture marker, or null when nothing is waiting */
    markerVar: string | null;
    centreX: number;
    centreY: number;
    /** largest primitive distance from the centre, css px. Presence is asserted on this. */
    extent: number;
}

export interface AvatarMood {
    toneVar: string;
    /** brightness, 0..1 */
    energy: number;
    /** how coplanar the three arc planes are, 0..1 */
    align: number;
    /** instability, 0..1 — how much of the form cuts out */
    jitter: number;
    /** tumble rate, 0..1, spent only on what alignment has already loosened */
    spin: number;
    /** fraction of the six struts cut, 0..1 */
    sever: number;
}

export interface SceneInput {
    expression: PetExpression;
    /**
     * The eased mood, when a register change is in flight. Omitted, the expression's settled mood is used
     * — which is what a caller that does not animate (a test, a one-off render) wants.
     */
    mood?: RenderMood;
    posture: PetPosture;
    /** square viewport for the avatar, css px */
    size: number;
    /** monotonic ms; only read when `still` is false */
    now: number;
    /**
     * Orbit phase in radians (petmotion's idleOrbit yaw), read as a phase rather than as an angle.
     *
     * idleOrbit turns a full circle, which was right for a sphere and is wrong for a stack of planes: a
     * quarter of every turn would put the form edge-on and collapse it to a handful of lines. The scene
     * takes the sine of it instead, so the same clock produces a bounded sway around a fixed three-quarter
     * view and the form is never seen from an angle it does not read from.
     */
    yaw: number;
    /** radians, already bounded by idleOrbit; tips the near face up and down */
    pitch: number;
    /** 0..1 from breathPhase */
    breath: number;
    /** 0..1 from utteranceEnvelope */
    utterance: number;
    /** true when the avatar has nothing to express: dimmer, at the periphery */
    quiet: boolean;
    /**
     * A wave crossing the form, as progress 0..1 from the centre outward, or null for no ripple.
     *
     * Progress rather than an intensity envelope, because the front has to travel: an envelope that rose
     * and fell would send the wave out and then pull it back in, which reads as a pulse rather than as
     * news arriving. The brightness bell over that progress is computed here.
     */
    ripple: number | null;
    /** 0..1 impact, displacing the whole assembly. An arrival that has to be felt, not read. */
    jolt: number;
    /** reduced motion: no sway, tumble, breath, stutter or punctuation */
    still: boolean;
}

// Severity reads in the tone before the shape has been parsed: error for the worst thing that can be true,
// warning for the body clock, muted for slow drift, accent at rest.
const MOODS: Record<PetExpression["kind"], AvatarMood> = {
    // Nothing in the register table asks cannot-see to dim: its tells are severed struts, planes out of the
    // stack and the form stuttering out, all structural. Being dim as well would be a fourth tell nobody
    // asked for, and combined with sever cutting most of the struts it made the most severe register the
    // faintest thing the avatar could show. An alarm is bright.
    "cannot-see": { toneVar: "--color-error", energy: 0.95, align: 0.14, jitter: 0.75, spin: 0.85, sever: 0.72 },
    tired: { toneVar: "--color-warning", energy: 0.44, align: 0.8, jitter: 0.03, spin: 0.34, sever: 0 },
    // Drifting was once authored dimmer than tired — the single register the design table defines as
    // dimming — so decay borrowed the exhaustion tell and then outdid it. Read against the table it is the
    // opposite: decay is loss of STRUCTURE, not loss of power, and drifting already owns three structural
    // tells (align, spin, sever). It keeps its power. Still under at-rest, so that "everything is fine"
    // stays the brightest thing the avatar can be.
    drifting: { toneVar: "--color-muted", energy: 0.88, align: 0.4, jitter: 0.1, spin: 0.62, sever: 0.25 },
    // --color-accent rather than the 500 step: at-rest is the tone shown almost all the time, and the 500
    // step (#667ad1 in the default theme) is the closest of the five to the panel it sits on, so the state
    // with the most screen time was also the hardest to see. The error/warning tones already read.
    "at-rest": { toneVar: "--color-accent", energy: 1, align: 1, jitter: 0, spin: 1, sever: 0 },
};

export function moodFor(expression: PetExpression): AvatarMood {
    return MOODS[expression.kind];
}

/**
 * A mood mid-transition: the numeric fields eased, plus which tone is being crossfaded away from.
 *
 * Registers used to change in a single frame — tone, brightness, plane splay and sever all snapped at once
 * — which read as a glitch rather than as a condition changing. The form is continuous, so the change
 * should be too.
 */
export interface RenderMood extends AvatarMood {
    toneFromVar: string | null;
    toneMix: number;
}

/**
 * Time constant of the ease, not its duration: the mood covers about 90% of the remaining distance in
 * three of these. Chosen long enough to read as a transition and short enough that a condition which
 * appears and clears inside one poll cycle still visibly happened.
 */
export const MOOD_TAU_MS = 420;

export function settledMood(expression: PetExpression): RenderMood {
    return { ...moodFor(expression), toneFromVar: null, toneMix: 1 };
}

/**
 * One step of the ease, toward the settled mood of `expression`.
 *
 * Framerate-independent by construction: the step is `1 - exp(-dt/tau)` rather than a fixed fraction per
 * frame, so a 30Hz display and a 144Hz one take the same wall-clock time to arrive. A frame that took
 * absurdly long (a backgrounded tab, a GC pause) is clamped rather than allowed to overshoot.
 */
export function approachMood(current: RenderMood, expression: PetExpression, dtMs: number): RenderMood {
    const target = moodFor(expression);
    const dt = Number.isFinite(dtMs) ? Math.max(0, Math.min(1_000, dtMs)) : 0;
    const k = 1 - Math.exp(-dt / MOOD_TAU_MS);

    // A tone change starts a crossfade from whatever is on screen now, which may itself be a blend part
    // way through an earlier one. Reversing mid-fade therefore fades back from the blend rather than
    // snapping to the tone it was heading for.
    let toneVar = current.toneVar;
    let toneFromVar = current.toneFromVar;
    let toneMix = current.toneMix;
    if (target.toneVar !== current.toneVar) {
        toneFromVar = current.toneVar;
        toneVar = target.toneVar;
        toneMix = 0;
    } else if (toneFromVar != null) {
        toneMix = toneMix + (1 - toneMix) * k;
        // an asymptote never arrives; past this the blend is below one 8-bit step, so it is done
        if (toneMix > 0.997) {
            toneFromVar = null;
            toneMix = 1;
        }
    }

    const to = (from: number, at: number) => from + (at - from) * k;
    return {
        toneVar,
        toneFromVar,
        toneMix,
        energy: to(current.energy, target.energy),
        align: to(current.align, target.align),
        jitter: to(current.jitter, target.jitter),
        spin: to(current.spin, target.spin),
        sever: to(current.sever, target.sever),
    };
}

// Posture is a bearing marker, never a count: which kind of waiting, not how much of it.
export const MARKER_VARS: Record<PetPosture, string | null> = {
    "review-gate": "--color-accent",
    escalation: "--color-error",
    "blocked-worker": "--color-asking",
    none: null,
};

const MARKER_BEARINGS: Record<PetPosture, number | null> = {
    "review-gate": -62,
    escalation: 44,
    "blocked-worker": 152,
    none: null,
};

/**
 * The four stroke weights the form is drawn with, CSS px.
 *
 * A ladder rather than a per-primitive number so avatarthree can batch: line width is a material uniform
 * in three's fat-line implementation, so every distinct width costs a draw call and a geometry rebuild per
 * frame. Four is what the form actually needs — body line work, the lit inner arcs, the blades, and the
 * marker rim that has to beat all of them.
 */
export const STROKE = { fine: 0.85, base: 1.2, heavy: 1.9, bold: 2.8 } as const;

/** Every width a scene can emit, so the renderer can prepare its batches once. */
export const STROKE_WIDTHS: readonly number[] = [STROKE.fine, STROKE.base, STROKE.heavy, STROKE.bold];

type Vec3 = [number, number, number];

/** A rigid transform for one layer of the form: Euler XYZ like three's Group, then a shift along z. */
interface Placement {
    rx: number;
    ry: number;
    rz: number;
    z: number;
}

const IDENTITY: Placement = { rx: 0, ry: 0, rz: 0, z: 0 };

const TAU = Math.PI * 2;

// The named layers. Everything the mood does to brightness, it does to one of these at a time — which is
// what makes "part of it cut out" expressible at all.
const PART_KEYS = ["outer", "mid", "front", "struts", "core"] as const;
type PartKey = (typeof PART_KEYS)[number];

// Where each layer sits, in form units, so a ripple front at radius r knows what it is passing over.
const PART_RADIUS: Record<PartKey, number> = { core: 0.36, front: 0.87, mid: 1.06, struts: 1.25, outer: 1.4 };

const STRUT_COUNT = 6;
// Which struts go first, so severing scatters the gaps instead of opening one hole.
const SEVER_ORDER = [1, 4, 0, 3, 5, 2];

// Which layers can drop out, and how hard. The core is in the list but last, so the form loses its
// periphery before it loses its centre — a centre that blinks reads as the whole avatar failing rather
// than as the avatar reporting that it cannot see.
const STUTTER_PARTS: readonly PartKey[] = ["outer", "mid", "struts", "front", "core"];
// How often a layer is gated out at full jitter, and how far it drops when it is.
const STUTTER_RATE = 0.55;
const STUTTER_DEPTH = 0.8;

// How thick the ripple front is, in form units. Wide enough to light a whole layer at once (a front that
// lit one primitive at a time reads as a chase, not a wave) and narrow enough that the form is never
// uniformly lit, which would just be a flash.
const RIPPLE_WIDTH = 0.38;
// How far past the rim the front travels before the window ends, so the wave leaves rather than stopping.
const RIPPLE_REACH = 1.55;

// Peak displacement of a jolt, as a fraction of the viewport. Small on purpose: the edge test's headroom is
// about 18px at the shipped size, and a knock that moves the form out of its own box is a bug.
const JOLT_PX = 0.02;
// Shake rate. Fast enough to read as an impact rather than as a sway.
const JOLT_HZ = 0.055;

// How much the idle state dims. It does not shrink: the peripheral-when-idle rule (design §3) rides
// brightness alone, on purpose. It used to ride three axes at once — petview picked a smaller canvas, a
// factor scaled the form's radius, and the same factor scaled the glow — and since at-rest-and-idle is the
// condition the avatar is in almost all the time, the compounded result was the state a user essentially
// always saw. The design study that settled this form scaled the idle avatar to 0.82 as well; that is the
// one thing from it deliberately not ported, because this rule is the fix for a bug that already shipped.
export const QUIET_DIM = 0.75;

// One form unit as a fraction of the viewport. Sized so the tick ring — the widest primitive, at 1.56 units
// — still leaves margin inside the canvas, because the bloom needs somewhere to fall off. A form that
// reaches the edge turns its own glow into a visible square where the blur clamps against the framebuffer
// border. This puts the widest primitive at roughly two thirds of the half-width.
const SPHERE_FRACTION = 0.19;

// Bounded sway, in radians, around the fixed three-quarter attitude. See SceneInput.yaw.
const ORBIT_SWAY = 0.16;

// Polyline and quad-strip density: segments per radian per unit radius. Tuned so the longest arc in the
// form lands near a 1.5px chord at the shipped size — fine enough that a circle is a circle, coarse enough
// that the whole form stays under ~550 segments, which is what the old one failed at.
const ARC_DETAIL = 18;
const BAND_DETAIL = 10;
const ARC_MAX = 96;
const BAND_MAX = 64;

// Ticks on the outer plane. 48 at this size fuse into a fuzzy band under additive blending long before they
// resolve; 24 stay countable.
const TICK_COUNT = 24;

// The marker's sweep, in radians — 72°, not the ±20° this used to draw. The narrower arc was legible on a
// contact sheet and invisible in window chrome. The BEARING is what says which kind of waiting; the width
// is only what makes it survive 132px.
const MARKER_SWEEP = 1.25;

const clamp01 = (v: number) => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0);

function rotX(p: Vec3, a: number): Vec3 {
    const c = Math.cos(a);
    const s = Math.sin(a);
    return [p[0], p[1] * c - p[2] * s, p[1] * s + p[2] * c];
}

function rotY(p: Vec3, a: number): Vec3 {
    const c = Math.cos(a);
    const s = Math.sin(a);
    return [p[0] * c + p[2] * s, p[1], -p[0] * s + p[2] * c];
}

function rotZ(p: Vec3, a: number): Vec3 {
    const c = Math.cos(a);
    const s = Math.sin(a);
    return [p[0] * c - p[1] * s, p[0] * s + p[1] * c, p[2]];
}

/**
 * An irregular 0..1 gate for one layer of the form, out of phase with every other layer.
 *
 * Two incommensurate sines beaten together: it never repeats on any interval you would notice, and it holds
 * a value for several frames at a time rather than flickering per-frame, which is the difference between a
 * signal dropping out and white noise. A pure function of the clock, so the scene stays stateless.
 */
function gate(t: number, seed: number): number {
    const a = Math.sin(t * (9.3 + seed * 2.1) + seed * 2.7);
    const b = Math.sin(t * (4.7 + seed * 1.3) + seed * 1.9);
    return 0.5 + 0.5 * a * b;
}

export function buildAvatarScene(input: SceneInput): AvatarScene {
    const mood: RenderMood = input.mood ?? settledMood(input.expression);
    const still = input.still;
    const now = still ? 0 : input.now;
    const t = now / 1_000;
    const breath = still ? 0 : clamp01(input.breath);
    const utterance = still ? 0 : clamp01(input.utterance);

    // The whole attitude is the signal: three-quarters-on at rest, square-on while speaking, and turned
    // further away while something waits on you. `face` rides the utterance envelope rather than easing on
    // its own state, which keeps this function a pure function of its inputs.
    const attention = input.posture === "none" ? 0 : 1;
    const face = utterance * (1 - attention);
    const calm = Math.max(0, 1 - Math.max(face, attention));
    const wave = breath * 2 - 1;

    const quietDim = input.quiet ? QUIET_DIM : 1;
    const glow = (0.5 + 0.5 * mood.energy) * (1 - 0.16 * calm * (0.5 - 0.5 * wave)) * (1 - attention * 0.58) * quietDim;

    // Per-layer brightness, in two directions. `lift` is what brightens a layer (a ripple passing over it,
    // the voice lighting the centre) and `drop` is the stutter. They are kept apart because the clamp
    // between them is load-bearing: a layer that a ripple has already pushed to full opacity must still be
    // able to cut out, and folding them into one product would let the lift cancel the dropout.
    const lift: Record<PartKey, number> = { outer: 1, mid: 1, front: 1, struts: 1, core: 1 };
    const drop: Record<PartKey, number> = { outer: 1, mid: 1, front: 1, struts: 1, core: 1 };

    const rippleAt = still || input.ripple == null ? null : clamp01(input.ripple);
    if (rippleAt != null) {
        const head = rippleAt * RIPPLE_REACH;
        for (const part of PART_KEYS) {
            const bell = Math.max(0, 1 - Math.abs(PART_RADIUS[part] - head) / RIPPLE_WIDTH);
            lift[part] *= 1 + bell * 1.6;
        }
    }
    if (utterance > 0) {
        // scaled by energy, because alpha clamps at 1: unscaled, a tired avatar that started speaking hit
        // the same ceiling a rested one does and its register vanished for as long as it was talking. A
        // tired voice is quieter.
        const voice = utterance * (0.4 + 0.6 * mood.energy);
        lift.core *= 1 + voice * 0.7;
        lift.front *= 1 + voice * 0.4;
    }
    if (!still && mood.jitter > 0.005) {
        STUTTER_PARTS.forEach((part, seed) => {
            if (gate(t, seed) > 1 - mood.jitter * STUTTER_RATE) {
                drop[part] = 1 - mood.jitter * STUTTER_DEPTH;
            }
        });
    }

    // The jolt moves the whole form rather than any part of it: a rigid knock reads as something landing on
    // the avatar, where a per-primitive wobble would read as the avatar itself becoming unstable, which is
    // already what jitter means. That collision is why jitter is a dropout and not a tremble.
    const jolt = still ? 0 : clamp01(input.jolt);
    const knock = jolt * input.size * JOLT_PX;
    const centreX = input.size / 2 + Math.sin(now * JOLT_HZ) * knock;
    const centreY = input.size / 2 + Math.cos(now * JOLT_HZ * 1.37) * knock * 0.6;
    const radius = input.size * SPHERE_FRACTION * (1 + 0.03 * calm * wave);

    const rootRx = 0.2 - face * 0.17 + attention * 0.14 + (still ? 0 : input.pitch);
    const rootRy = -0.28 + face * 0.24 - attention * 0.16 + (still ? 0 : Math.sin(input.yaw) * ORBIT_SWAY);
    const rootRz = -0.06 + face * 0.06;

    // align is plane coplanarity: as it falls the three planes come apart and tilt out of the stack, which
    // is decay you can see in the silhouette rather than in the brightness. spin is then spent only on what
    // alignment has already loosened — at-rest (align 1) contributes no tumble and breathes in place, so
    // the resting avatar is still rather than idling like a spinner.
    const splay = 1 - mood.align;
    const tumble = mood.spin * splay * t;
    // A twist while speaking, which returns when the utterance decays. The form working, not drifting.
    const work = face * 0.6;

    const planeBack: Placement = {
        rx: -splay * 0.42,
        ry: splay * 0.3,
        rz: -work * 0.4 - tumble * 0.12,
        z: -0.38 - splay * 0.3,
    };
    const planeMid: Placement = { rx: 0, ry: 0, rz: work * 0.9 + tumble * 0.075, z: 0 };
    const planeFront: Placement = {
        rx: splay * 0.34,
        ry: -splay * 0.24,
        rz: -work * 0.6 - tumble * 0.05,
        z: 0.32 + face * 0.14 + splay * 0.3,
    };
    // The struts and the core hang off the root, not off a plane: that is what makes the splay read as the
    // stack coming apart rather than as the whole assembly opening like a flower.
    const coreAt: Placement = { rx: 0, ry: 0, rz: 0, z: -0.25 };

    const segments: SceneSegment[] = [];
    const fills: SceneFill[] = [];
    let extent = 0;

    // Perspective is a divide rather than a matrix: both renderers take screen-space primitives, which is
    // what keeps the fallback pixel-comparable with the primary instead of subtly differently projected.
    const project = (p: Vec3, at: Placement): [number, number, number] => {
        const placed = rotX(rotY(rotZ(p, at.rz), at.ry), at.rx);
        const world = rotX(rotY(rotZ([placed[0], placed[1], placed[2] + at.z], rootRz), rootRy), rootRx);
        const k = 1 / (1 - world[2] * 0.17);
        const x = centreX + world[0] * radius * k;
        const y = centreY - world[1] * radius * k;
        extent = Math.max(extent, Math.hypot(x - centreX, y - centreY));
        return [x, y, world[2]];
    };

    // Line work is authored at a base opacity and lit by the mood; the marker is not, which is the contrast
    // that makes it readable over a form the same glow has just dimmed by 58%.
    const bodyAlpha = (base: number, part: PartKey | null): number => {
        const a = clamp01(base * glow);
        return part == null ? a : Math.min(1, a * lift[part]) * drop[part];
    };
    const markerAlpha = (base: number) => clamp01(base * quietDim);

    const line = (a: Vec3, b: Vec3, at: Placement, tone: SceneTone, width: number, alpha: number) => {
        const pa = project(a, at);
        const pb = project(b, at);
        segments.push({
            ax: pa[0],
            ay: pa[1],
            bx: pb[0],
            by: pb[1],
            depth: (pa[2] + pb[2]) / 2,
            tone,
            alpha,
            width,
        });
    };

    const arc = (
        at: Placement,
        r: number,
        start: number,
        length: number,
        tone: SceneTone,
        width: number,
        alpha: number
    ) => {
        const steps = Math.max(4, Math.min(ARC_MAX, Math.ceil(Math.abs(length) * r * ARC_DETAIL)));
        let prev = project([Math.cos(start) * r, Math.sin(start) * r, 0], at);
        for (let i = 1; i <= steps; i++) {
            const a = start + (length * i) / steps;
            const next = project([Math.cos(a) * r, Math.sin(a) * r, 0], at);
            segments.push({
                ax: prev[0],
                ay: prev[1],
                bx: next[0],
                by: next[1],
                depth: (prev[2] + next[2]) / 2,
                tone,
                alpha,
                width,
            });
            prev = next;
        }
    };

    const band = (
        at: Placement,
        inner: number,
        outer: number,
        start: number,
        length: number,
        tone: SceneTone,
        alpha: number
    ) => {
        const steps = Math.max(2, Math.min(BAND_MAX, Math.ceil(Math.abs(length) * outer * BAND_DETAIL)));
        let ia = project([Math.cos(start) * inner, Math.sin(start) * inner, 0], at);
        let oa = project([Math.cos(start) * outer, Math.sin(start) * outer, 0], at);
        for (let i = 1; i <= steps; i++) {
            const a = start + (length * i) / steps;
            const ib = project([Math.cos(a) * inner, Math.sin(a) * inner, 0], at);
            const ob = project([Math.cos(a) * outer, Math.sin(a) * outer, 0], at);
            fills.push({
                points: [
                    [ia[0], ia[1]],
                    [oa[0], oa[1]],
                    [ob[0], ob[1]],
                    [ib[0], ib[1]],
                ],
                depth: (ia[2] + ob[2]) / 2,
                tone,
                alpha,
            });
            ia = ib;
            oa = ob;
        }
    };

    // the outer plane: six rim arcs over a tick ring, the part of the form furthest from the viewer
    for (let i = 0; i < 6; i++) {
        const start = (i * TAU) / 6 + 0.08;
        arc(planeBack, 1.4, start, 0.78, "body", STROKE.fine, bodyAlpha(0.65, "outer"));
        band(planeBack, 1.32, 1.39, start, 0.78, "body", bodyAlpha(0.18, "outer"));
    }
    for (let i = 0; i < TICK_COUNT; i++) {
        const a = (i * TAU) / TICK_COUNT;
        const len = i % 4 === 0 ? 0.09 : 0.035;
        line(
            [Math.cos(a) * 1.47, Math.sin(a) * 1.47, 0],
            [Math.cos(a) * (1.47 + len), Math.sin(a) * (1.47 + len), 0],
            planeBack,
            "body",
            STROKE.fine,
            bodyAlpha(0.78, "outer")
        );
    }

    // the middle plane: three heavy blades, the layer that carries the form's weight
    for (let i = 0; i < 3; i++) {
        const start = (i * TAU) / 3 + 0.3;
        arc(planeMid, 1.11, start, 1.62, "body", STROKE.heavy, bodyAlpha(1, "mid"));
        band(planeMid, 1.02, 1.1, start, 1.62, "body", bodyAlpha(0.32, "mid"));
    }

    // the front plane: a thin ring with three lit arcs inside it, nearest the viewer
    for (let i = 0; i < 3; i++) {
        arc(planeFront, 0.83, (i * TAU) / 3 + 0.1, 1.3, "hot", STROKE.base, bodyAlpha(0.75, "front"));
    }
    arc(planeFront, 0.91, 0, TAU, "body", STROKE.fine, bodyAlpha(0.5, "front"));

    // the struts, spanning back plane to middle. Severed deterministically by rank, so the same ones stay
    // cut frame to frame rather than flickering — a link that came and went would be jitter, not damage.
    const cut = Math.round(STRUT_COUNT * clamp01(mood.sever));
    SEVER_ORDER.forEach((index, rank) => {
        if (rank < cut) {
            return;
        }
        const a = (index * TAU) / 6 + 0.45;
        line(
            [Math.cos(a) * 1.4, Math.sin(a) * 1.4, -0.38],
            [Math.cos(a) * 1.11, Math.sin(a) * 1.11, 0],
            IDENTITY,
            "body",
            STROKE.fine,
            bodyAlpha(0.45, "struts")
        );
    });

    // the core, recessed behind the middle plane: a lit ring, three brackets, and a hex at the centre
    arc(coreAt, 0.31, 0, TAU, "hot", STROKE.base, bodyAlpha(0.95, "core"));
    for (let i = 0; i < 3; i++) {
        arc(coreAt, 0.42, (i * TAU) / 3 + 0.1, 1.1, "body", STROKE.base, bodyAlpha(0.95, "core"));
    }
    for (let i = 0; i < 6; i++) {
        const a = (i * TAU) / 6;
        const b = ((i + 1) * TAU) / 6;
        line(
            [Math.cos(a) * 0.17, Math.sin(a) * 0.17, 0],
            [Math.cos(b) * 0.17, Math.sin(b) * 0.17, 0],
            coreAt,
            "body",
            STROKE.fine,
            bodyAlpha(0.9, "core")
        );
    }
    band(coreAt, 0.31, 0.41, 0, TAU, "body", bodyAlpha(0.17, "core"));

    // A bright short arc sweeping the middle plane, only while Jarvis is actually saying something. It is
    // the one part of the form that spins on its own clock, which is why it must never be visible at rest:
    // a permanent sweep is a loading spinner.
    if (face > 0.02) {
        arc(planeMid, 1.11, -0.32 + (still ? 0 : t * 1.6), 0.64, "hot", STROKE.bold, bodyAlpha(face, null));
    }

    // the bearing marker: which kind of waiting, at a fixed bearing. Never a count — the nav rail's badge
    // owns counts, and that split is the whole reason keeping both indicators is not redundancy.
    const bearing = MARKER_BEARINGS[input.posture];
    if (bearing != null) {
        const start = (bearing * Math.PI) / 180 - MARKER_SWEEP / 2;
        band(IDENTITY, 0.98, 1.46, start, MARKER_SWEEP, "marker", markerAlpha(0.42));
        arc(IDENTITY, 1.46, start, MARKER_SWEEP, "marker", STROKE.bold, markerAlpha(1));
        arc(IDENTITY, 0.98, start, MARKER_SWEEP, "marker", STROKE.heavy, markerAlpha(0.9));
        for (const a of [start, start + MARKER_SWEEP]) {
            line(
                [Math.cos(a) * 0.98, Math.sin(a) * 0.98, 0],
                [Math.cos(a) * 1.46, Math.sin(a) * 1.46, 0],
                IDENTITY,
                "marker",
                STROKE.heavy,
                markerAlpha(0.9)
            );
        }
    }

    return {
        segments,
        fills,
        toneVar: mood.toneVar,
        toneFromVar: mood.toneFromVar,
        toneMix: mood.toneMix,
        markerVar: MARKER_VARS[input.posture],
        centreX,
        centreY,
        extent,
    };
}

export { MARKER_BEARINGS };
