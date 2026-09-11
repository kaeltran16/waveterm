// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The avatar's form, as data. Expression in, a flat list of line segments and points in screen space out.
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
}

export interface ScenePoint {
    x: number;
    y: number;
    depth: number;
    tone: SceneTone;
    alpha: number;
    /** diameter in css px */
    size: number;
}

export interface AvatarScene {
    segments: SceneSegment[];
    points: ScenePoint[];
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
    /** brightness and pulse rate, 0..1 */
    energy: number;
    /** ring coplanarity and network cohesion, 0..1 */
    align: number;
    /** instability, 0..1 */
    jitter: number;
    /** platter rotation rate, 0..1 */
    spin: number;
    /** fraction of network links cut, 0..1 */
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
    yaw: number;
    pitch: number;
    /** 0..1 from breathPhase */
    breath: number;
    /** 0..1 from utteranceEnvelope */
    utterance: number;
    /** true when the avatar has nothing to express: smaller and dimmer, at the periphery */
    quiet: boolean;
    /**
     * A wave crossing the network, as progress 0..1 from the centre outward, or null for no ripple.
     *
     * Progress rather than an intensity envelope, because the front has to travel: an envelope that rose
     * and fell would send the wave out and then pull it back in, which reads as a pulse rather than as
     * news arriving. The brightness bell over that progress is computed here.
     */
    ripple: number | null;
    /** 0..1 impact, displacing the whole assembly. An arrival that has to be felt, not read. */
    jolt: number;
    rings: number;
    ringTicks: number;
    nodes: number;
    shell: boolean;
    /** reduced motion: no rotation, spin, breath or surge */
    still: boolean;
}

// Severity reads in the tone before the shape has been parsed: error for the worst thing that can be true,
// warning for the body clock, muted for slow drift, accent at rest. Same mapping the blob used.
const MOODS: Record<PetExpression["kind"], AvatarMood> = {
    // energy 0.74 had the same bug drifting did, and it mattered more here because this is rank 1. Nothing
    // in the register table asks cannot-see to dim: its tells are severed links, nodes drifting outside the
    // sphere and ticks stuttering out of phase, all structural. Being dim was a fourth tell nobody asked
    // for, and combined with sever cutting 72% of the links it made the most severe register the faintest
    // thing the avatar could show. An alarm is bright.
    "cannot-see": { toneVar: "--color-error", energy: 0.95, align: 0.14, jitter: 0.75, spin: 0.85, sever: 0.72 },
    tired: { toneVar: "--color-warning", energy: 0.44, align: 0.8, jitter: 0.03, spin: 0.34, sever: 0 },
    // energy, not tone, is the one that was wrong here. Drifting was authored at 0.34 — dimmer than tired,
    // the single register the design table defines as dimming — so decay borrowed the exhaustion tell and
    // then outdid it. Read against the table it is the opposite: decay is loss of STRUCTURE, not loss of
    // power, and drifting already owns three structural tells (align, spin, sever). It keeps its power.
    // Still under at-rest, so that "everything is fine" stays the brightest thing the avatar can be.
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
 * Registers used to change in a single frame — tone, brightness, platter tilt and sever all snapped at
 * once — which read as a glitch rather than as a condition changing. The form is continuous, so the
 * change should be too.
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

// Posture is a bearing marker and an outline, never a count: which kind of waiting, not how much of it.
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

export type Vec3 = [number, number, number];

export interface Network {
    nodes: Vec3[];
    links: [number, number][];
}

// Memoised by count. Same input, same output — so this stays pure from a caller's view — but the
// nearest-neighbour pass is O(n squared) and must not run on every frame.
const NETWORK_CACHE = new Map<number, Network>();

export function networkFor(count: number): Network {
    const n = Math.max(0, Math.floor(count));
    const hit = NETWORK_CACHE.get(n);
    if (hit != null) {
        return hit;
    }
    const nodes: Vec3[] = [];
    for (let i = 0; i < n; i++) {
        // a Fibonacci sphere for even angular spread, then pulled inward by a repeating factor so the
        // network fills the sphere's volume instead of decorating its shell
        const y = n === 1 ? 0 : 1 - (i / (n - 1)) * 2;
        const r = Math.sqrt(Math.max(0, 1 - y * y));
        const th = i * 2.399963;
        const depth = 0.42 + 0.56 * (((i * 7) % 5) / 4);
        nodes.push([Math.cos(th) * r * depth, y * depth, Math.sin(th) * r * depth]);
    }
    const links: [number, number][] = [];
    const seen = new Set<string>();
    for (let i = 0; i < nodes.length; i++) {
        const near: [number, number][] = [];
        for (let j = 0; j < nodes.length; j++) {
            if (i === j) {
                continue;
            }
            const a = nodes[i];
            const b = nodes[j];
            near.push([Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]), j]);
        }
        near.sort((p, q) => p[0] - q[0]);
        for (let k = 0; k < Math.min(3, near.length); k++) {
            const j = near[k][1];
            const key = i < j ? i + ":" + j : j + ":" + i;
            if (!seen.has(key)) {
                seen.add(key);
                links.push([Math.min(i, j), Math.max(i, j)]);
            }
        }
    }
    const net = { nodes, links };
    NETWORK_CACHE.set(n, net);
    return net;
}

function rot3(p: Vec3, yaw: number, pitch: number): Vec3 {
    const cy = Math.cos(yaw);
    const sy = Math.sin(yaw);
    const x = p[0] * cy + p[2] * sy;
    let z = -p[0] * sy + p[2] * cy;
    const cp = Math.cos(pitch);
    const sp = Math.sin(pitch);
    const y = p[1] * cp - z * sp;
    z = p[1] * sp + z * cp;
    return [x, y, z];
}

function rotX(p: Vec3, a: number): Vec3 {
    const c = Math.cos(a);
    const s = Math.sin(a);
    return [p[0], p[1] * c - p[2] * s, p[1] * s + p[2] * c];
}

function rotZ(p: Vec3, a: number): Vec3 {
    const c = Math.cos(a);
    const s = Math.sin(a);
    return [p[0] * c - p[1] * s, p[0] * s + p[1] * c, p[2]];
}

// Each platter sits on its own plane. As alignment falls the planes diverge, which is the drifting
// register: vault decay is loss of structure, not loss of power, so it needs a different tell from tired.
function ringTilt(ringIndex: number, align: number): { tiltX: number; tiltZ: number } {
    return {
        tiltX: (0.24 + ringIndex * 0.34) * (1 - align) + 0.16 * ringIndex,
        tiltZ: ringIndex * 1.05 + (1 - align) * 0.7,
    };
}

/** The plane normal for a platter, so coplanarity is assertable without reading segments. */
export function ringPlaneNormal(ringIndex: number, align: number): Vec3 {
    const { tiltX, tiltZ } = ringTilt(ringIndex, align);
    // a ring in the xz plane has normal +y; carry it through the same two rotations the ring gets
    const n = rotZ(rotX([0, 1, 0], tiltX), tiltZ);
    const len = Math.hypot(n[0], n[1], n[2]) || 1;
    return [n[0] / len, n[1] / len, n[2] / len];
}

const RING_BASE_RADIUS = 1.42;
const RING_GAP = 0.3;

// How thick the ripple front is, in sphere radii. Wide enough that it lights several nodes at once (a
// front that lit one node at a time reads as a chase, not a wave) and narrow enough that the form is
// never uniformly lit, which would just be a flash.
const RIPPLE_WIDTH = 0.38;
// How far past the shell the front travels before the window ends, so the wave leaves rather than stopping.
const RIPPLE_REACH = 1.25;
// Peak displacement of a jolt, as a fraction of the viewport. Small on purpose: the edge test's headroom
// is about 10px at the shipped size, and a knock that moves the form out of its own box is a bug.
const JOLT_PX = 0.02;
// Shake rate. Fast enough to read as an impact rather than as a sway.
const JOLT_HZ = 0.055;

// Alignment fades the line work, but only down to this floor. Coplanarity is already carried by the platter
// planes diverging (ringTilt), so multiplying alignment straight into alpha spent the same signal a second
// time — and that second spend compounded with the mood's own energy and with QUIET_DIM. At the quiet size
// the avatar is in almost all the time, drifting's shell arcs landed near 5% alpha of --color-muted over
// --color-background, and cannot-see's near 2%: the two registers that report a fault were the two you
// could not see. A floored ramp keeps the ordering (aligned still reads brighter) without the collapse.
//
// One constant for both the shell and the platter edges. They had separate ramps — the edges were already
// floored at 0.4 and the shell was not — with nothing to justify treating them differently.
const ALIGN_DIM_FLOOR = 0.55;

const alignDim = (align: number) => ALIGN_DIM_FLOOR + (1 - ALIGN_DIM_FLOOR) * align;

const clamp01 = (v: number) => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0);

// How much the idle state dims. It does not shrink: the peripheral-when-idle rule (design §3) rides
// brightness alone, on purpose. It used to ride three axes at once — petview picked a smaller canvas, this
// factor scaled the sphere radius, and the same factor scaled the glow — and since at-rest-and-idle is the
// condition the avatar is in almost all the time, the compounded result (a form 28px wide inside a 68px box,
// at 0.62 alpha, in the lowest-contrast tone of the five) was the state a user essentially always saw.
export const QUIET_DIM = 0.75;
// The sphere's radius as a fraction of the viewport. Tuned down from a value that filled the box: sized so
// the OUTERMOST platter plus its ticks still leaves margin inside the canvas, because the bloom needs
// somewhere to fall off. A form that reaches the edge turns its own glow into a visible square where the
// blur clamps against the framebuffer border. This puts the widest primitive at roughly two thirds of the
// half-width, which was the point where the box stopped being visible.
const SPHERE_FRACTION = 0.148;

export function buildAvatarScene(input: SceneInput): AvatarScene {
    const mood: RenderMood = input.mood ?? settledMood(input.expression);
    const still = input.still;
    const now = still ? 0 : input.now;
    const breath = still ? 0 : clamp01(input.breath);
    const utterance = still ? 0 : clamp01(input.utterance);
    const yaw = still ? 0 : input.yaw;
    const pitch = still ? 0.22 : 0.22 + input.pitch;

    const dim = input.quiet ? QUIET_DIM : 1;
    const glow = (0.45 + 0.55 * mood.energy) * dim;

    // The jolt moves the whole form rather than any part of it: a rigid knock reads as something landing
    // on the avatar, where a per-primitive wobble would read as the avatar itself becoming unstable, which
    // is already what jitter means in the cannot-see register.
    const jolt = still ? 0 : clamp01(input.jolt);
    const knock = jolt * input.size * JOLT_PX;
    const centreX = input.size / 2 + Math.sin(now * JOLT_HZ) * knock;
    const centreY = input.size / 2 + Math.cos(now * JOLT_HZ * 1.37) * knock * 0.6;
    // deliberately not scaled by `dim` — see QUIET_DIM. The geometry is the same size in every state.
    const radius = input.size * SPHERE_FRACTION * (1 + 0.03 * breath);

    const segments: SceneSegment[] = [];
    const points: ScenePoint[] = [];
    let extent = 0;

    // Perspective is a divide rather than a matrix: both renderers take screen-space primitives, which is
    // what keeps the fallback pixel-comparable with the primary instead of subtly differently projected.
    const project = (p: Vec3): [number, number, number, number] => {
        const k = 1 / (1 - p[2] * 0.17);
        const x = centreX + p[0] * radius * k;
        const y = centreY - p[1] * radius * k;
        extent = Math.max(extent, Math.hypot(x - centreX, y - centreY));
        return [x, y, p[2], k];
    };

    const strip = (pts: [number, number, number, number][], tone: SceneTone, alpha: number) => {
        for (let i = 1; i < pts.length; i++) {
            const a = pts[i - 1];
            const b = pts[i];
            segments.push({
                ax: a[0],
                ay: a[1],
                bx: b[0],
                by: b[1],
                depth: (a[2] + b[2]) / 2,
                tone,
                alpha: clamp01(alpha),
            });
        }
    };

    // the shell: latitude and longitude arcs implying a sphere without drawing a surface
    const alignAlpha = alignDim(mood.align);
    if (input.shell) {
        for (let i = 0; i < 3; i++) {
            const lat = (i - 1) * 0.62;
            const rr = Math.cos(lat);
            const arc: [number, number, number, number][] = [];
            for (let k = 0; k <= 64; k++) {
                const a = (k / 64) * Math.PI * 2;
                arc.push(project(rot3([Math.cos(a) * rr, Math.sin(lat), Math.sin(a) * rr], yaw, pitch)));
            }
            strip(arc, "body", 0.26 * glow * alignAlpha);
        }
        for (let i = 0; i < 3; i++) {
            const lon = (i / 3) * Math.PI;
            const arc: [number, number, number, number][] = [];
            for (let k = 0; k <= 64; k++) {
                const a = (k / 64) * Math.PI * 2;
                arc.push(project(rot3(rotZ(rotX([Math.cos(a), Math.sin(a), 0], Math.PI / 2), lon), yaw, pitch)));
            }
            strip(arc, "body", 0.22 * glow * alignAlpha);
        }
    }

    const net = networkFor(input.nodes);
    const scatter = (1 - mood.align) * 0.42;
    const rippleAt = still || input.ripple == null ? null : clamp01(input.ripple);
    // a bell over progress: the wave fades as it leaves rather than switching off at the shell
    const rippleGain = rippleAt == null ? 0 : Math.sin(rippleAt * Math.PI);
    const rippleFront = rippleAt == null ? 0 : rippleAt * RIPPLE_REACH;
    // how strongly the ripple is touching a node at sphere-radius r, 0..1
    const rippleAtRadius = (r: number) =>
        rippleAt == null ? 0 : Math.max(0, 1 - Math.abs(r - rippleFront) / RIPPLE_WIDTH) * rippleGain;
    const nodeRadius = net.nodes.map((n) => Math.hypot(n[0], n[1], n[2]));
    const placed = net.nodes.map((n, i) => {
        const ph = i * 1.7;
        const w = still ? Math.sin(ph) : Math.sin(now * 0.0009 + ph);
        const w2 = still ? Math.cos(ph) : Math.cos(now * 0.0011 + ph * 1.3);
        const j = still ? 0 : Math.sin(now * 0.02 + ph) * mood.jitter * 0.09;
        return project(
            rot3(
                [n[0] * (1 + w * scatter) + j, n[1] * (1 + w2 * scatter * 0.8), n[2] * (1 + w * scatter * 0.6)],
                yaw,
                pitch
            )
        );
    });

    net.links.forEach((link, i) => {
        // severed links are what degraded recall looks like from the inside. Deterministic in the index so
        // the same links stay cut frame to frame rather than flickering.
        if (mood.sever > 0 && (i % 7) / 7 < mood.sever) {
            return;
        }
        const a = placed[link[0]];
        const b = placed[link[1]];
        const depth = (a[2] + b[2]) / 2;
        const lit = rippleAtRadius((nodeRadius[link[0]] + nodeRadius[link[1]]) / 2);
        segments.push({
            ax: a[0],
            ay: a[1],
            bx: b[0],
            by: b[1],
            depth,
            tone: lit > 0.55 ? "hot" : "body",
            alpha: clamp01((0.26 + 0.4 * ((depth + 1) / 2)) * glow * (1 + 1.8 * lit)),
        });
    });

    // a pulse walking the graph, slower when energy is low
    const head = still ? 0 : (now * 0.0007 * (0.25 + mood.energy)) % Math.max(1, placed.length);
    placed.forEach((p, i) => {
        const span = Math.max(1, placed.length);
        const dist = Math.abs((((i - head) % span) + span) % span);
        const near = 1 - Math.min(1, dist / 2.4);
        const front = (p[2] + 1) / 2;
        const lit = rippleAtRadius(nodeRadius[i]);
        points.push({
            x: p[0],
            y: p[1],
            depth: p[2],
            tone: near > 0.5 || lit > 0.35 ? "hot" : "body",
            alpha: clamp01((0.42 + 0.55 * front) * glow * (0.5 + 0.5 * near) * (1 + 2.2 * lit)),
            size: Math.max(1.6, input.size * 0.013) * p[3] * (0.7 + 0.5 * front) * (1 + 0.6 * near + 1.4 * lit),
        });
    });

    // the platters: exterior tick rings, evoking hard-drive platters and reel-to-reel tape, whose tick
    // lengths ride the utterance envelope
    const ringCount = Math.max(0, Math.floor(input.rings));
    for (let ri = 0; ri < ringCount; ri++) {
        const ringRadius = RING_BASE_RADIUS + ri * RING_GAP;
        const dir = ri % 2 ? -1 : 1;
        const spin = still ? 0 : now * 0.00034 * dir * mood.spin * (1 + ri * 0.25);
        const { tiltX, tiltZ } = ringTilt(ri, mood.align);
        const tickCount = Math.max(6, Math.round(input.ringTicks * (1 - ri * 0.12)));
        const amp = 0.2 + 0.8 * utterance;

        for (let i = 0; i < tickCount; i++) {
            const a = (i / tickCount) * Math.PI * 2 + spin;
            // three partials so it reads as speech rather than as a sine
            let w =
                Math.sin(i * 0.55 + now * 0.006) * 0.5 +
                Math.sin(i * 1.31 - now * 0.009) * 0.32 +
                Math.sin(i * 2.77 + now * 0.013) * 0.18;
            if (still) {
                w = Math.sin(i * 0.55) * 0.5 + Math.sin(i * 1.31) * 0.32 + Math.sin(i * 2.77) * 0.18;
            } else if (mood.jitter > 0.3) {
                w += Math.sin(i * 5.1 + now * 0.03) * mood.jitter * 0.5;
            }
            const mag = Math.abs(w) * amp;
            const major = i % 8 === 0;
            const len = (0.05 + 0.3 * mag + (major ? 0.05 : 0)) * (0.5 + 0.5 * mood.energy);
            const inner = project(
                rot3(rotZ(rotX([Math.cos(a) * ringRadius, 0, Math.sin(a) * ringRadius], tiltX), tiltZ), yaw, pitch)
            );
            const outer = project(
                rot3(
                    rotZ(rotX([Math.cos(a) * (ringRadius + len), 0, Math.sin(a) * (ringRadius + len)], tiltX), tiltZ),
                    yaw,
                    pitch
                )
            );
            const front = (inner[2] + 1) / 2;
            segments.push({
                ax: inner[0],
                ay: inner[1],
                bx: outer[0],
                by: outer[1],
                depth: inner[2],
                tone: major ? "hot" : "body",
                alpha: clamp01((0.22 + 0.55 * front) * glow * (0.55 + 0.45 * mag * 1.6)),
            });
        }

        const edge: [number, number, number, number][] = [];
        for (let k = 0; k <= 96; k++) {
            const a = (k / 96) * Math.PI * 2 + spin;
            edge.push(
                project(
                    rot3(rotZ(rotX([Math.cos(a) * ringRadius, 0, Math.sin(a) * ringRadius], tiltX), tiltZ), yaw, pitch)
                )
            );
        }
        strip(edge, "body", 0.32 * glow * alignAlpha);
    }

    // the bearing marker: which kind of waiting, at a fixed bearing. Never a count — the nav rail's badge
    // owns counts, and that split is the whole reason keeping both indicators is not redundancy.
    const bearing = MARKER_BEARINGS[input.posture];
    if (bearing != null && ringCount > 0) {
        const markerRadius = RING_BASE_RADIUS + (ringCount - 1) * RING_GAP + 0.22;
        const from = ((bearing - 20) * Math.PI) / 180;
        const to = ((bearing + 20) * Math.PI) / 180;
        const arc: [number, number, number, number][] = [];
        for (let k = 0; k <= 32; k++) {
            const a = from + (to - from) * (k / 32);
            arc.push(
                project(
                    rot3(rotZ(rotX([Math.cos(a) * markerRadius, 0, Math.sin(a) * markerRadius], 0.16), 0), yaw, pitch)
                )
            );
        }
        strip(arc, "marker", 0.9 * dim);
    }

    return {
        segments,
        points,
        toneVar: mood.toneVar,
        toneFromVar: mood.toneFromVar,
        toneMix: mood.toneMix,
        markerVar: MARKER_VARS[input.posture],
        centreX,
        centreY,
        extent,
    };
}

// Referenced by Task 4. Exported here so the bearing table has one home.
export { MARKER_BEARINGS };
