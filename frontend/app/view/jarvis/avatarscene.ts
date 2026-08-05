// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The avatar's form, as data. Expression in, a flat list of line segments and points in screen space out.
//
// Pure on purpose, and that is the whole design (spec §5). The blob this replaced kept its geometry inside
// petview.tsx as JSX attributes, so the only way to check the form was to screenshot the running app. Here
// the form is a function, so the form is testable.
//
// Two renderers consume this — avatargl.ts and avatarcanvas.ts — which is also how a lost WebGL context
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
    "cannot-see": { toneVar: "--color-error", energy: 0.74, align: 0.14, jitter: 0.75, spin: 0.85, sever: 0.72 },
    tired: { toneVar: "--color-warning", energy: 0.44, align: 0.8, jitter: 0.03, spin: 0.34, sever: 0 },
    drifting: { toneVar: "--color-muted", energy: 0.34, align: 0.4, jitter: 0.1, spin: 0.62, sever: 0.25 },
    // --color-accent rather than the 500 step: at-rest is the tone shown almost all the time, and the 500
    // step (#667ad1 in the default theme) is the closest of the five to the panel it sits on, so the state
    // with the most screen time was also the hardest to see. The error/warning tones already read.
    "at-rest": { toneVar: "--color-accent", energy: 1, align: 1, jitter: 0, spin: 1, sever: 0 },
};

export function moodFor(expression: PetExpression): AvatarMood {
    return MOODS[expression.kind];
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
    const mood = moodFor(input.expression);
    const still = input.still;
    const now = still ? 0 : input.now;
    const breath = still ? 0 : clamp01(input.breath);
    const utterance = still ? 0 : clamp01(input.utterance);
    const yaw = still ? 0 : input.yaw;
    const pitch = still ? 0.22 : 0.22 + input.pitch;

    const dim = input.quiet ? QUIET_DIM : 1;
    const glow = (0.45 + 0.55 * mood.energy) * dim;
    const centreX = input.size / 2;
    const centreY = input.size / 2;
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
    if (input.shell) {
        for (let i = 0; i < 3; i++) {
            const lat = (i - 1) * 0.62;
            const rr = Math.cos(lat);
            const arc: [number, number, number, number][] = [];
            for (let k = 0; k <= 64; k++) {
                const a = (k / 64) * Math.PI * 2;
                arc.push(project(rot3([Math.cos(a) * rr, Math.sin(lat), Math.sin(a) * rr], yaw, pitch)));
            }
            strip(arc, "body", 0.26 * glow * mood.align);
        }
        for (let i = 0; i < 3; i++) {
            const lon = (i / 3) * Math.PI;
            const arc: [number, number, number, number][] = [];
            for (let k = 0; k <= 64; k++) {
                const a = (k / 64) * Math.PI * 2;
                arc.push(project(rot3(rotZ(rotX([Math.cos(a), Math.sin(a), 0], Math.PI / 2), lon), yaw, pitch)));
            }
            strip(arc, "body", 0.22 * glow * mood.align);
        }
    }

    const net = networkFor(input.nodes);
    const scatter = (1 - mood.align) * 0.42;
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
        segments.push({
            ax: a[0],
            ay: a[1],
            bx: b[0],
            by: b[1],
            depth,
            tone: "body",
            alpha: clamp01((0.26 + 0.4 * ((depth + 1) / 2)) * glow),
        });
    });

    // a pulse walking the graph, slower when energy is low
    const head = still ? 0 : (now * 0.0007 * (0.25 + mood.energy)) % Math.max(1, placed.length);
    placed.forEach((p, i) => {
        const span = Math.max(1, placed.length);
        const dist = Math.abs((((i - head) % span) + span) % span);
        const near = 1 - Math.min(1, dist / 2.4);
        const front = (p[2] + 1) / 2;
        points.push({
            x: p[0],
            y: p[1],
            depth: p[2],
            tone: near > 0.5 ? "hot" : "body",
            alpha: clamp01((0.42 + 0.55 * front) * glow * (0.5 + 0.5 * near)),
            size: Math.max(1.6, input.size * 0.013) * p[3] * (0.7 + 0.5 * front) * (1 + 0.6 * near),
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
                    rotZ(
                        rotX([Math.cos(a) * (ringRadius + len), 0, Math.sin(a) * (ringRadius + len)], tiltX),
                        tiltZ
                    ),
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
        strip(edge, "body", 0.32 * glow * (0.4 + 0.6 * mood.align));
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
        markerVar: MARKER_VARS[input.posture],
        centreX,
        centreY,
        extent,
    };
}

// Referenced by Task 4. Exported here so the bearing table has one home.
export { MARKER_BEARINGS };
