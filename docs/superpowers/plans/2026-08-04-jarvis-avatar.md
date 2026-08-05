# Jarvis Avatar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the eyed-blob SVG creature in the cockpit's window chrome with a holographic avatar — a connection network inside a sphere wrapped in tick-mark data rings — drawn by a WebGL renderer with a canvas 2D fallback, both consuming one pure scene builder.

**Architecture:** Three layers. The existing pure state modules (`petcondition.ts`, `petvoice.ts`) are untouched and still decide *what* Jarvis is expressing. A new pure `avatarscene.ts` turns that expression plus time, pointer and size into a flat list of line segments and points in screen space. Two interchangeable renderers consume that list: `avatargl.ts` (WebGL 2, additive blending, bloom chain) and `avatarcanvas.ts` (canvas 2D, the fallback when the GL context is unavailable or lost). `petview.tsx` owns the animation loop and picks a renderer.

**Tech Stack:** TypeScript, React 19, jotai, vitest. Raw WebGL 2 — **no new npm dependency**. Canvas 2D for the fallback. Colours resolved from Tailwind `@theme` custom properties at render time.

**Spec:** `docs/superpowers/specs/2026-08-04-jarvis-avatar-design.md`

## Global Constraints

Every task's requirements implicitly include this section.

- **No new npm dependencies.** Raw WebGL 2 only. Three.js was explicitly rejected (spec §4 decision 2).
- **Colours come only from `--color-*` custom properties** in `frontend/tailwindsetup.css`, read at render time via `getComputedStyle`. A hardcoded hex, rgba, or shader `vec3` literal for a themeable colour is a defect — runtime theming works by overriding those properties on `document.documentElement`.
- **Pure modules never touch the DOM.** `avatarscene.ts` and `petmotion.ts` must not call `getComputedStyle`, `document`, or `performance`. Time and colour *names* are passed in. This is what makes them unit-testable.
- **No 60-frames-per-second React state.** The animation loop reads jotai atoms once per frame and mutates nothing. A `useState` setter called per frame is a defect (the cockpit runs live terminals).
- **Commits are batched and approval-gated.** Repository rule overrides this plan template: task steps **stage** files with `git add`, they do not commit. One commit at the very end, in Task 10, only after the user explicitly approves. The spec and this plan are staged into that same commit — spec and plan documents fold into the feature commit they describe, never a separate docs-only commit.
- **Typecheck with** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`. Bare `npx tsc` stack-overflows on this repo, which also means `task check:ts` is broken. Baseline is clean, so any error reported is yours.
- **Run a single frontend test with** `npx vitest run <path>`. Full suite: `npx vitest run`. Baseline before this work: 1688 passed, 2 skipped.
- **Lint with** `npx eslint <paths>`. Do **not** run `npx prettier --write` on files you did not author — it reorganises imports and rewraps the whole file, turning a four-line change into a six-hundred-line diff. Hand-format to 4-space indent, 120-column width.
- **Never draw a number.** The avatar expresses *kinds*, never counts. The nav rail's badge owns counts. This is a de-duplication contract, not a style preference.
- **Reduced motion** (`useReducedMotion`) disables rotation, ring spin, breath and the utterance surge. Bloom is not motion and stays.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `frontend/app/view/jarvis/petmotion.ts` | Modify | Involuntary motion, reduced to what a hologram needs: pointer→yaw/pitch, the utterance envelope, the breath phase. Loses everything about eyes. |
| `frontend/app/view/jarvis/petmotion.test.ts` | Modify | Rewritten for the above. |
| `frontend/app/view/jarvis/avatarscene.ts` | Create | Pure. Expression + time + pointer + size → segments and points in screen space. The form lives here and nowhere else. |
| `frontend/app/view/jarvis/avatarscene.test.ts` | Create | Asserts the design: severing, coplanarity, amplitude, presence, the no-count contract. |
| `frontend/app/view/jarvis/avatarcanvas.ts` | Create | Canvas 2D renderer. The fallback. |
| `frontend/app/view/jarvis/avatarcanvas.test.ts` | Create | Proves it consumes every primitive, against a stub context. |
| `frontend/app/view/jarvis/avatargl.ts` | Create | WebGL 2 renderer: vertex packing, programs, framebuffers, bloom chain, context-loss handling. |
| `frontend/app/view/jarvis/avatargl.test.ts` | Create | Vertex packing arithmetic, and the render pass order against a stub context. |
| `frontend/app/view/jarvis/petstore.ts` | Modify | Gains `petSpokeAtAtom` + `markPetSpoke()`. |
| `frontend/app/view/jarvis/petview.tsx` | Rewrite render half | Animation loop, renderer selection and fallback, dev-only scene hook. Keeps the existing drag, click, keyboard and corner-anchoring behaviour. |
| `scripts/cdp/scenarios.mjs` | Modify | New `jarvis-avatar` scenario asserting the scene through the dev hook. |
| `docs/superpowers/specs/2026-08-04-jarvis-pet-design.md` | Modify | Superseded-by pointers on the six sections the new spec replaces. |

---

## Task 1: Reduce petmotion.ts to hologram motion

`petmotion.ts` currently exists to serve eyes. `eyeRoom` clamps pupil travel inside an eyelid and `nextBlinkDelay` schedules blinks; a hologram has neither. The distance-saturation ramp inside `gazeOffset` is the one idea worth keeping, reused to rotate the whole form.

**Files:**
- Modify: `frontend/app/view/jarvis/petmotion.ts` (replace entire contents)
- Modify: `frontend/app/view/jarvis/petmotion.test.ts` (replace entire contents)

**Interfaces:**
- Consumes: nothing.
- Produces: `GAZE_SATURATE_PX: number`, `UTTERANCE_MS: number`, `BREATH_MS: number`, `interface GazeAngles { yaw: number; pitch: number }`, `gazeYawPitch(cx: number, cy: number, pointerX: number, pointerY: number, yawCap: number, pitchCap: number): GazeAngles`, `utteranceEnvelope(now: number, spokeAt: number | null, durationMs?: number): number`, `breathPhase(now: number, periodMs?: number): number`.

- [ ] **Step 1: Write the failing tests**

Replace the entire contents of `frontend/app/view/jarvis/petmotion.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run frontend/app/view/jarvis/petmotion.test.ts`

Expected: FAIL. Import errors for `gazeYawPitch`, `utteranceEnvelope`, `breathPhase`, `UTTERANCE_MS`, `BREATH_MS` — none of them exist yet.

- [ ] **Step 3: Replace petmotion.ts**

Replace the entire contents of `frontend/app/view/jarvis/petmotion.ts`:

```ts
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run frontend/app/view/jarvis/petmotion.test.ts`

Expected: PASS, 19 tests.

- [ ] **Step 5: Confirm nothing else still imports the deleted exports**

Run: `npx eslint frontend/app/view/jarvis/petmotion.ts frontend/app/view/jarvis/petmotion.test.ts`

Then search for stale importers:

```bash
grep -rn "eyeRoom\|nextBlinkDelay\|gazeOffset\|BLINK_MIN_MS\|BLINK_MAX_MS" frontend/
```

Expected: the only hit is `frontend/app/view/jarvis/petview.tsx`, which Task 8 rewrites. Typechecking will fail on that file until then — that is expected and does not block this task.

- [ ] **Step 6: Stage**

```bash
git add frontend/app/view/jarvis/petmotion.ts frontend/app/view/jarvis/petmotion.test.ts
```

Do **not** commit. See Global Constraints.

---

## Task 2: Scene builder foundation — types, mood, and the network

The inner part of the form: nodes distributed through a sphere's *volume*, linked to nearest neighbours. The register that matters most maps here — degraded semantic recall severs links, because a broken connection network is literally what that failure is.

**Files:**
- Create: `frontend/app/view/jarvis/avatarscene.ts`
- Create: `frontend/app/view/jarvis/avatarscene.test.ts`

**Interfaces:**
- Consumes: `PetExpression`, `PetPosture` from `./petcondition`.
- Produces: `type SceneTone = "body" | "hot" | "marker"`, `interface SceneSegment`, `interface ScenePoint`, `interface AvatarScene`, `interface AvatarMood`, `interface SceneInput`, `moodFor(expression: PetExpression): AvatarMood`, `networkFor(count: number): Network`, `buildAvatarScene(input: SceneInput): AvatarScene`, `MARKER_VARS: Record<PetPosture, string | null>`.

- [ ] **Step 1: Write the failing tests**

Create `frontend/app/view/jarvis/avatarscene.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildAvatarScene, moodFor, networkFor, type SceneInput } from "./avatarscene";
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run frontend/app/view/jarvis/avatarscene.test.ts`

Expected: FAIL — `Cannot find module './avatarscene'`.

- [ ] **Step 3: Create avatarscene.ts with the foundation and the network**

Create `frontend/app/view/jarvis/avatarscene.ts`:

```ts
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
    "at-rest": { toneVar: "--color-accent-500", energy: 1, align: 1, jitter: 0, spin: 1, sever: 0 },
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

const clamp01 = (v: number) => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0);

/** Resting scale relative to the active size. Provisional — spec §10 requires tuning against the dev app. */
export const QUIET_SCALE = 0.62;
const SPHERE_FRACTION = 0.19;

export function buildAvatarScene(input: SceneInput): AvatarScene {
    const mood = moodFor(input.expression);
    const still = input.still;
    const now = still ? 0 : input.now;
    const breath = still ? 0 : clamp01(input.breath);
    const utterance = still ? 0 : clamp01(input.utterance);
    const yaw = still ? 0 : input.yaw;
    const pitch = still ? 0.22 : 0.22 + input.pitch;

    const presence = input.quiet ? QUIET_SCALE : 1;
    const glow = (0.45 + 0.55 * mood.energy) * presence;
    const centreX = input.size / 2;
    const centreY = input.size / 2;
    const radius = input.size * SPHERE_FRACTION * presence * (1 + 0.03 * breath);

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

    const net = networkFor(input.nodes);
    const scatter = (1 - mood.align) * 0.42;
    const placed = net.nodes.map((n, i) => {
        const ph = i * 1.7;
        const w = still ? Math.sin(ph) : Math.sin(now * 0.0009 + ph);
        const w2 = still ? Math.cos(ph) : Math.cos(now * 0.0011 + ph * 1.3);
        const j = still ? 0 : Math.sin(now * 0.02 + ph) * mood.jitter * 0.09;
        return project(
            rot3(
                [
                    n[0] * (1 + w * scatter) + j,
                    n[1] * (1 + w2 * scatter * 0.8),
                    n[2] * (1 + w * scatter * 0.6),
                ],
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
            alpha: clamp01((0.14 + 0.34 * ((depth + 1) / 2)) * glow),
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
            alpha: clamp01((0.3 + 0.6 * front) * glow * (0.5 + 0.5 * near)),
            size: Math.max(1.6, input.size * 0.013) * p[3] * (0.7 + 0.5 * front) * (1 + 0.6 * near),
        });
    });

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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run frontend/app/view/jarvis/avatarscene.test.ts`

Expected: PASS. The `rings`/`shell` inputs are accepted but not yet drawn, which is fine — every test in this task passes `rings: 0, shell: false` or does not assert on them.

- [ ] **Step 5: Lint and stage**

```bash
npx eslint frontend/app/view/jarvis/avatarscene.ts frontend/app/view/jarvis/avatarscene.test.ts
git add frontend/app/view/jarvis/avatarscene.ts frontend/app/view/jarvis/avatarscene.test.ts
```

---

## Task 3: Scene builder — the shell and the platters

The middle and outer parts: latitude and longitude arcs implying a sphere without drawing a surface, and tick-mark rings on separately tilted planes. The rings carry two registers — coplanarity is the drifting tell, and tick length is the utterance surge.

**Files:**
- Modify: `frontend/app/view/jarvis/avatarscene.ts`
- Modify: `frontend/app/view/jarvis/avatarscene.test.ts` (append)

**Interfaces:**
- Consumes: everything Task 2 produced.
- Produces: `ringPlaneNormal(ringIndex: number, align: number): Vec3` — exported so coplanarity is assertable without inspecting segments.

- [ ] **Step 1: Append the failing tests**

Append to `frontend/app/view/jarvis/avatarscene.test.ts`:

```ts
import { ringPlaneNormal } from "./avatarscene";

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

    it("scales the whole form down when it has nothing to say", () => {
        // the helmet-display rule: peripheral when idle, central when needed
        const loud = buildAvatarScene(input({ quiet: false })).extent;
        const idle = buildAvatarScene(input({ quiet: true })).extent;
        expect(idle).toBeLessThan(loud);
    });

    it("emits an even vertex count, because every primitive is a segment or a point", () => {
        const scene = buildAvatarScene(input());
        expect(scene.segments.length).toBeGreaterThan(0);
        expect(scene.points.length).toBeGreaterThan(0);
    });
});
```

- [ ] **Step 2: Run to verify the new tests fail**

Run: `npx vitest run frontend/app/view/jarvis/avatarscene.test.ts`

Expected: FAIL — `ringPlaneNormal` is not exported, and the ring/shell/utterance assertions fail because no ring or shell geometry is emitted yet.

- [ ] **Step 3: Add the shell and platter geometry**

In `frontend/app/view/jarvis/avatarscene.ts`, add these helpers immediately after `rot3`:

```ts
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
```

Then, inside `buildAvatarScene`, insert this block **immediately after** the `const project = ...` definition and **before** `const net = networkFor(...)` — the shell should draw behind the network:

```ts
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
            strip(arc, "body", 0.16 * glow * mood.align);
        }
        for (let i = 0; i < 3; i++) {
            const lon = (i / 3) * Math.PI;
            const arc: [number, number, number, number][] = [];
            for (let k = 0; k <= 64; k++) {
                const a = (k / 64) * Math.PI * 2;
                arc.push(project(rot3(rotZ(rotX([Math.cos(a), Math.sin(a), 0], Math.PI / 2), lon), yaw, pitch)));
            }
            strip(arc, "body", 0.13 * glow * mood.align);
        }
    }
```

Then insert this block at the **end** of `buildAvatarScene`, immediately before the `return {` statement:

```ts
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
                alpha: clamp01((0.12 + 0.5 * front) * glow * (0.45 + 0.55 * mag * 1.6)),
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
        strip(edge, "body", 0.2 * glow * (0.4 + 0.6 * mood.align));
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run frontend/app/view/jarvis/avatarscene.test.ts`

Expected: PASS, all tests from Tasks 2 and 3.

- [ ] **Step 5: Lint and stage**

```bash
npx eslint frontend/app/view/jarvis/avatarscene.ts frontend/app/view/jarvis/avatarscene.test.ts
git add frontend/app/view/jarvis/avatarscene.ts frontend/app/view/jarvis/avatarscene.test.ts
```

---

## Task 4: Scene builder — the posture bearing marker

Posture is the kind of waiting, never the amount. A marker arc holds at a bearing on the outermost platter.

**Files:**
- Modify: `frontend/app/view/jarvis/avatarscene.ts`
- Modify: `frontend/app/view/jarvis/avatarscene.test.ts` (append)

**Interfaces:**
- Consumes: `MARKER_BEARINGS`, `MARKER_VARS`, `strip` from Tasks 2 and 3.
- Produces: no new exports. Behaviour only.

- [ ] **Step 1: Append the failing tests**

Append to `frontend/app/view/jarvis/avatarscene.test.ts`:

```ts
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
        expect(keys).toEqual(
            new Set(["segments", "points", "toneVar", "markerVar", "centreX", "centreY", "extent"])
        );
    });

    it("drops the marker when there are no platters to hang it on", () => {
        const scene = buildAvatarScene(input({ posture: "escalation", rings: 0 }));
        expect(scene.segments.some((s) => s.tone === "marker")).toBe(false);
    });
});
```

- [ ] **Step 2: Run to verify the new tests fail**

Run: `npx vitest run frontend/app/view/jarvis/avatarscene.test.ts`

Expected: FAIL — no segment ever has `tone: "marker"`.

- [ ] **Step 3: Emit the marker**

In `frontend/app/view/jarvis/avatarscene.ts`, insert this block at the **end** of `buildAvatarScene`, after the platter loop and immediately before the `return {` statement:

```ts
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
                    rot3(
                        rotZ(rotX([Math.cos(a) * markerRadius, 0, Math.sin(a) * markerRadius], 0.16), 0),
                        yaw,
                        pitch
                    )
                )
            );
        }
        strip(arc, "marker", 0.9 * presence);
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run frontend/app/view/jarvis/avatarscene.test.ts`

Expected: PASS.

- [ ] **Step 5: Typecheck the pure modules and stage**

```bash
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit
```

Expected: errors **only** in `frontend/app/view/jarvis/petview.tsx`, which still imports the exports Task 1 deleted. Task 8 fixes it. Any error in `avatarscene.ts` or `petmotion.ts` is yours.

```bash
npx eslint frontend/app/view/jarvis/avatarscene.ts frontend/app/view/jarvis/avatarscene.test.ts
git add frontend/app/view/jarvis/avatarscene.ts frontend/app/view/jarvis/avatarscene.test.ts
```

---

## Task 5: The canvas 2D renderer — the fallback

Draws the scene with plain strokes. Because there is no bloom, it paints a radial halo standing in for the light the geometry should be emitting. This is the renderer used when WebGL is unavailable or its context is lost.

**Files:**
- Create: `frontend/app/view/jarvis/avatarcanvas.ts`
- Create: `frontend/app/view/jarvis/avatarcanvas.test.ts`

**Interfaces:**
- Consumes: `AvatarScene`, `SceneTone` from `./avatarscene`.
- Produces: `interface SceneColours { body: string; hot: string; marker: string | null }`, `resolveTone(scene: AvatarScene, read: (name: string) => string): SceneColours`, `drawSceneToCanvas(ctx: CanvasRenderingContext2D, scene: AvatarScene, size: number, colours: SceneColours): void`.

- [ ] **Step 1: Write the failing tests**

Create `frontend/app/view/jarvis/avatarcanvas.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { drawSceneToCanvas, resolveTone, type SceneColours } from "./avatarcanvas";
import { buildAvatarScene, type AvatarScene, type SceneInput } from "./avatarscene";
import type { PetExpression } from "./petcondition";

function sceneOf(over: Partial<SceneInput> = {}): AvatarScene {
    const expression: PetExpression = { kind: "at-rest" };
    return buildAvatarScene({
        expression,
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
    });
}

// A stub rather than a real canvas: this asserts that the renderer consumes the whole scene, which is a
// behaviour, not a picture. There are deliberately no jsdom render tests in this codebase.
function stubCtx() {
    const grad = { addColorStop: vi.fn() };
    return {
        clearRect: vi.fn(),
        fillRect: vi.fn(),
        beginPath: vi.fn(),
        moveTo: vi.fn(),
        lineTo: vi.fn(),
        arc: vi.fn(),
        stroke: vi.fn(),
        fill: vi.fn(),
        createRadialGradient: vi.fn(() => grad),
        set strokeStyle(_v: string) {},
        set fillStyle(_v: unknown) {},
        set lineWidth(_v: number) {},
    } as unknown as CanvasRenderingContext2D & { moveTo: ReturnType<typeof vi.fn> };
}

const COLOURS: SceneColours = { body: "rgb(95,116,224)", hot: "rgb(175,187,240)", marker: null };

describe("resolveTone", () => {
    it("resolves the body colour through the injected reader, never a literal", () => {
        const read = vi.fn(() => "#5f74e0");
        const scene = sceneOf();
        const colours = resolveTone(scene, read);
        expect(read).toHaveBeenCalledWith(scene.toneVar);
        expect(colours.body).toBe("#5f74e0");
    });

    it("lightens the body colour for the hot tone rather than asking for a second token", () => {
        const colours = resolveTone(sceneOf(), () => "#5f74e0");
        expect(colours.hot).not.toBe(colours.body);
    });

    it("returns a null marker colour when no posture is waiting", () => {
        expect(resolveTone(sceneOf({ posture: "none" }), () => "#5f74e0").marker).toBeNull();
    });

    it("resolves a marker colour when a posture is waiting", () => {
        const colours = resolveTone(sceneOf({ posture: "escalation" }), () => "#e0726c");
        expect(colours.marker).toBe("#e0726c");
    });
});

describe("drawSceneToCanvas", () => {
    it("draws every segment in the scene, dropping none", () => {
        const ctx = stubCtx();
        const scene = sceneOf();
        drawSceneToCanvas(ctx, scene, 112, COLOURS);
        // one moveTo per segment; the halo uses fillRect, not a path
        expect(ctx.moveTo).toHaveBeenCalledTimes(scene.segments.length);
    });

    it("draws every point in the scene, dropping none", () => {
        const ctx = stubCtx();
        const scene = sceneOf();
        drawSceneToCanvas(ctx, scene, 112, COLOURS);
        expect((ctx.arc as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(scene.points.length);
    });

    it("clears the frame before drawing, so frames do not accumulate", () => {
        const ctx = stubCtx();
        drawSceneToCanvas(ctx, sceneOf(), 112, COLOURS);
        expect(ctx.clearRect).toHaveBeenCalledWith(0, 0, 112, 112);
    });

    it("does not throw when the scene is empty", () => {
        const ctx = stubCtx();
        const empty = sceneOf({ rings: 0, shell: false, nodes: 0 });
        expect(() => drawSceneToCanvas(ctx, empty, 112, COLOURS)).not.toThrow();
    });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run frontend/app/view/jarvis/avatarcanvas.test.ts`

Expected: FAIL — `Cannot find module './avatarcanvas'`.

- [ ] **Step 3: Create avatarcanvas.ts**

Create `frontend/app/view/jarvis/avatarcanvas.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The fallback renderer: the avatar's scene drawn with plain canvas strokes.
//
// Used when WebGL 2 is unavailable, when its context is lost, or when a shader fails to build. It consumes
// the same avatarscene.ts output as the WebGL renderer, which is what makes a lost context survivable
// without a second copy of the geometry that could drift from the first.
//
// It paints a radial halo the WebGL renderer does not need. That is not a stylistic difference: over there
// the glow is a bloom pass earned from the geometry, and without one the line-work reads as a diagram.

import type { AvatarScene, SceneTone } from "./avatarscene";

export interface SceneColours {
    body: string;
    /** the body colour lightened, for the pulse head and the major ticks */
    hot: string;
    marker: string | null;
}

const HOT_LIGHTEN = 0.62;

// Parses #rgb / #rrggbb and mixes toward white. Anything else passes through unchanged, so a token that
// resolves to a colour space this does not parse degrades to a flat tone rather than throwing on a frame.
function lighten(colour: string, k: number): string {
    const hex = colour.trim().replace("#", "");
    const parts =
        hex.length === 3
            ? hex.split("").map((c) => parseInt(c + c, 16))
            : hex.length === 6
              ? [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16))
              : null;
    if (parts == null || parts.some((n) => !Number.isFinite(n))) {
        return colour;
    }
    const mixed = parts.map((n) => Math.round(n + (255 - n) * k));
    return "rgb(" + mixed[0] + "," + mixed[1] + "," + mixed[2] + ")";
}

// `read` is injected rather than calling getComputedStyle here, so this is testable and so the theme-token
// rule cannot be broken by a literal creeping in.
export function resolveTone(scene: AvatarScene, read: (name: string) => string): SceneColours {
    const body = read(scene.toneVar);
    return {
        body,
        hot: lighten(body, HOT_LIGHTEN),
        marker: scene.markerVar == null ? null : read(scene.markerVar),
    };
}

function withAlpha(colour: string, alpha: number): string {
    const a = Math.max(0, Math.min(1, alpha));
    const hex = colour.trim().replace("#", "");
    const parts =
        hex.length === 3
            ? hex.split("").map((c) => parseInt(c + c, 16))
            : hex.length === 6
              ? [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16))
              : null;
    if (parts != null && parts.every((n) => Number.isFinite(n))) {
        return "rgba(" + parts[0] + "," + parts[1] + "," + parts[2] + "," + a + ")";
    }
    const rgb = colour.match(/^rgb\(([^)]+)\)$/);
    if (rgb != null) {
        return "rgba(" + rgb[1] + "," + a + ")";
    }
    return colour;
}

function toneColour(tone: SceneTone, colours: SceneColours): string {
    if (tone === "hot") {
        return colours.hot;
    }
    if (tone === "marker") {
        return colours.marker ?? colours.body;
    }
    return colours.body;
}

export function drawSceneToCanvas(
    ctx: CanvasRenderingContext2D,
    scene: AvatarScene,
    size: number,
    colours: SceneColours
): void {
    ctx.clearRect(0, 0, size, size);

    // the hand-painted halo, standing in for the bloom this renderer does not have
    if (scene.extent > 0) {
        const halo = ctx.createRadialGradient(scene.centreX, scene.centreY, 0, scene.centreX, scene.centreY, scene.extent);
        halo.addColorStop(0, withAlpha(colours.hot, 0.3));
        halo.addColorStop(0.42, withAlpha(colours.body, 0.13));
        halo.addColorStop(1, withAlpha(colours.body, 0));
        ctx.fillStyle = halo;
        ctx.fillRect(0, 0, size, size);
    }

    ctx.lineWidth = Math.max(0.6, size * 0.003);
    for (const s of scene.segments) {
        ctx.strokeStyle = withAlpha(toneColour(s.tone, colours), s.alpha);
        ctx.beginPath();
        ctx.moveTo(s.ax, s.ay);
        ctx.lineTo(s.bx, s.by);
        ctx.stroke();
    }
    for (const p of scene.points) {
        ctx.fillStyle = withAlpha(toneColour(p.tone, colours), p.alpha);
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * 0.5, 0, Math.PI * 2);
        ctx.fill();
    }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run frontend/app/view/jarvis/avatarcanvas.test.ts`

Expected: PASS, 8 tests.

- [ ] **Step 5: Lint and stage**

```bash
npx eslint frontend/app/view/jarvis/avatarcanvas.ts frontend/app/view/jarvis/avatarcanvas.test.ts
git add frontend/app/view/jarvis/avatarcanvas.ts frontend/app/view/jarvis/avatarcanvas.test.ts
```

---

## Task 6: Vertex packing for the WebGL renderer

Packing the scene into one interleaved buffer is where off-by-one bugs live, and it is pure, so it gets tested on its own before any GL calls exist.

**Files:**
- Create: `frontend/app/view/jarvis/avatargl.ts` (packing only; the renderer arrives in Task 7)
- Create: `frontend/app/view/jarvis/avatargl.test.ts`

**Interfaces:**
- Consumes: `AvatarScene` from `./avatarscene`, `SceneColours` from `./avatarcanvas`.
- Produces: `FLOATS_PER_VERTEX: number`, `interface PackedScene { data: Float32Array; lineVertices: number; pointVertices: number }`, `packScene(scene: AvatarScene, size: number, dpr: number, colours: SceneColours, into?: Float32Array): PackedScene`.

- [ ] **Step 1: Write the failing tests**

Create `frontend/app/view/jarvis/avatargl.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { SceneColours } from "./avatarcanvas";
import { FLOATS_PER_VERTEX, packScene } from "./avatargl";
import { buildAvatarScene, type AvatarScene, type SceneInput } from "./avatarscene";

function sceneOf(over: Partial<SceneInput> = {}): AvatarScene {
    return buildAvatarScene({
        expression: { kind: "at-rest" },
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
    });
}

const COLOURS: SceneColours = { body: "#5f74e0", hot: "#afbbf0", marker: "#e0726c" };

describe("packScene", () => {
    it("emits two vertices per segment and one per point, in that order", () => {
        const scene = sceneOf();
        const packed = packScene(scene, 112, 1, COLOURS);
        expect(packed.lineVertices).toBe(scene.segments.length * 2);
        expect(packed.pointVertices).toBe(scene.points.length);
    });

    it("maps screen coordinates into clip space with y flipped", () => {
        const scene = sceneOf({ rings: 0, shell: false, nodes: 0 });
        // hand-build a one-segment scene so the arithmetic is checkable
        scene.segments.push({ ax: 0, ay: 0, bx: 112, by: 112, depth: 0, tone: "body", alpha: 1 });
        const packed = packScene(scene, 112, 1, COLOURS);
        expect(packed.data[0]).toBeCloseTo(-1); // x=0   -> -1
        expect(packed.data[1]).toBeCloseTo(1); //  y=0   -> +1 (clip y is up)
        expect(packed.data[FLOATS_PER_VERTEX + 0]).toBeCloseTo(1); // x=112 -> +1
        expect(packed.data[FLOATS_PER_VERTEX + 1]).toBeCloseTo(-1); // y=112 -> -1
    });

    it("normalises colour channels to 0..1", () => {
        const scene = sceneOf({ rings: 0, shell: false, nodes: 0 });
        scene.segments.push({ ax: 0, ay: 0, bx: 1, by: 1, depth: 0, tone: "body", alpha: 1 });
        const packed = packScene(scene, 112, 1, COLOURS);
        for (let i = 2; i < 5; i++) {
            expect(packed.data[i]).toBeGreaterThanOrEqual(0);
            expect(packed.data[i]).toBeLessThanOrEqual(1);
        }
        expect(packed.data[2]).toBeCloseTo(0x5f / 255, 2);
    });

    it("scales point size by device pixel ratio so points are not half-size on a retina panel", () => {
        const scene = sceneOf({ rings: 0, shell: false, nodes: 0 });
        scene.points.push({ x: 5, y: 5, depth: 0, tone: "body", alpha: 1, size: 4 });
        const one = packScene(scene, 112, 1, COLOURS);
        const two = packScene(scene, 112, 2, COLOURS);
        const sizeIndex = FLOATS_PER_VERTEX - 1;
        expect(two.data[sizeIndex]).toBeCloseTo(one.data[sizeIndex] * 2);
    });

    it("reuses a caller-supplied buffer when it is large enough, to avoid per-frame allocation", () => {
        const scene = sceneOf();
        const first = packScene(scene, 112, 1, COLOURS);
        const second = packScene(scene, 112, 1, COLOURS, first.data);
        expect(second.data).toBe(first.data);
    });

    it("grows past a caller buffer that is too small rather than truncating the scene", () => {
        const scene = sceneOf();
        const tiny = new Float32Array(4);
        const packed = packScene(scene, 112, 1, COLOURS, tiny);
        expect(packed.data).not.toBe(tiny);
        expect(packed.lineVertices).toBe(scene.segments.length * 2);
    });

    it("handles an empty scene without throwing", () => {
        const empty = sceneOf({ rings: 0, shell: false, nodes: 0 });
        const packed = packScene(empty, 112, 1, COLOURS);
        expect(packed.lineVertices).toBe(0);
        expect(packed.pointVertices).toBe(0);
    });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run frontend/app/view/jarvis/avatargl.test.ts`

Expected: FAIL — `Cannot find module './avatargl'`.

- [ ] **Step 3: Create avatargl.ts with the packing half**

Create `frontend/app/view/jarvis/avatargl.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The primary renderer: the avatar's scene drawn as additive WebGL 2 with a bloom pass.
//
// Bloom is the reason this exists. The form is emissive line-work, so there are no surfaces to light and
// none of the usual 3D arguments apply — what WebGL buys here is light: bright ticks bleeding into the
// space around them, overlapping geometry accumulating toward white, and one draw call instead of several
// hundred strokes. Canvas can only fake the first with shadowBlur, which is slow and muddy.
//
// Raw WebGL, no three.js (spec §4 decision 2). Three.js's value was its loader and material system and
// line-work needs neither; its bloom implementation is the one reason to revisit.

import type { SceneColours } from "./avatarcanvas";
import type { AvatarScene, SceneTone } from "./avatarscene";

/** clip x, clip y, r, g, b, alpha, point size */
export const FLOATS_PER_VERTEX = 7;

export interface PackedScene {
    data: Float32Array;
    lineVertices: number;
    pointVertices: number;
}

function channels(colour: string): [number, number, number] {
    const hex = colour.trim().replace("#", "");
    if (hex.length === 3 || hex.length === 6) {
        const parts =
            hex.length === 3
                ? hex.split("").map((c) => parseInt(c + c, 16))
                : [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
        if (parts.every((n) => Number.isFinite(n))) {
            return [parts[0] / 255, parts[1] / 255, parts[2] / 255];
        }
    }
    const rgb = colour.match(/rgba?\(([^)]+)\)/);
    if (rgb != null) {
        const parts = rgb[1].split(",").map((s) => Number(s.trim()));
        if (parts.length >= 3 && parts.slice(0, 3).every((n) => Number.isFinite(n))) {
            return [parts[0] / 255, parts[1] / 255, parts[2] / 255];
        }
    }
    // a token that resolves to something unparseable renders mid-grey rather than dropping the frame
    return [0.5, 0.5, 0.5];
}

function toneChannels(tone: SceneTone, colours: SceneColours): [number, number, number] {
    if (tone === "hot") {
        return channels(colours.hot);
    }
    if (tone === "marker") {
        return channels(colours.marker ?? colours.body);
    }
    return channels(colours.body);
}

// Lines first, then points, because the renderer issues exactly two draw calls over one buffer and needs
// the point vertices contiguous at a known offset.
export function packScene(
    scene: AvatarScene,
    size: number,
    dpr: number,
    colours: SceneColours,
    into?: Float32Array
): PackedScene {
    const vertices = scene.segments.length * 2 + scene.points.length;
    const needed = vertices * FLOATS_PER_VERTEX;
    const data = into != null && into.length >= needed ? into : new Float32Array(Math.max(needed, 64));

    const body = channels(colours.body);
    const hot = channels(colours.hot);
    const marker = colours.marker == null ? body : channels(colours.marker);
    const pick = (tone: SceneTone) => (tone === "hot" ? hot : tone === "marker" ? marker : body);

    let o = 0;
    const put = (x: number, y: number, rgb: [number, number, number], alpha: number, pointSize: number) => {
        data[o++] = (x / size) * 2 - 1;
        // clip space y is up, screen y is down
        data[o++] = 1 - (y / size) * 2;
        data[o++] = rgb[0];
        data[o++] = rgb[1];
        data[o++] = rgb[2];
        data[o++] = Math.max(0, Math.min(1, alpha));
        data[o++] = pointSize;
    };

    for (const s of scene.segments) {
        const rgb = pick(s.tone);
        put(s.ax, s.ay, rgb, s.alpha, 1);
        put(s.bx, s.by, rgb, s.alpha, 1);
    }
    for (const p of scene.points) {
        put(p.x, p.y, pick(p.tone), p.alpha, p.size * dpr);
    }

    // referenced so the unused-import lint does not fire on toneChannels while the renderer half is absent
    void toneChannels;

    return { data, lineVertices: scene.segments.length * 2, pointVertices: scene.points.length };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run frontend/app/view/jarvis/avatargl.test.ts`

Expected: PASS, 7 tests.

- [ ] **Step 5: Lint and stage**

```bash
npx eslint frontend/app/view/jarvis/avatargl.ts frontend/app/view/jarvis/avatargl.test.ts
git add frontend/app/view/jarvis/avatargl.ts frontend/app/view/jarvis/avatargl.test.ts
```

---

## Task 7: The WebGL renderer and its bloom chain

Programs, framebuffers, the five-pass bloom chain, and context-loss handling. Tested against a stub context, which proves the pass order and catches the class of bug that silently produces a black frame.

**Files:**
- Modify: `frontend/app/view/jarvis/avatargl.ts`
- Modify: `frontend/app/view/jarvis/avatargl.test.ts` (append)

**Interfaces:**
- Consumes: `packScene`, `FLOATS_PER_VERTEX` from Task 6.
- Produces: `interface BloomSettings { strength: number; threshold: number; radius: number }`, `DEFAULT_BLOOM: BloomSettings`, `class AvatarGL` with `static create(canvas: HTMLCanvasElement): AvatarGL | null`, `resize(pixels: number): void`, `draw(scene: AvatarScene, size: number, dpr: number, colours: SceneColours, bloom: BloomSettings): void`, `get lost(): boolean`, `dispose(): void`, and constructor option `onLost`/`onRestored` callbacks.

- [ ] **Step 1: Append the failing tests**

Append to `frontend/app/view/jarvis/avatargl.test.ts`:

```ts
import { vi } from "vitest";
import { AvatarGL, DEFAULT_BLOOM } from "./avatargl";

// A stub WebGL2 context. This asserts the pipeline's SHAPE — that the scene is drawn additively into an
// offscreen target, then bright-passed, then blurred on both axes, then composited to the default
// framebuffer. A chain with a missing or reordered pass renders black, which is the bug worth catching and
// the one a screenshot test would report as "looks wrong" without saying why.
function stubGL() {
    const calls: string[] = [];
    const gl: Record<string, unknown> = {
        VERTEX_SHADER: 1, FRAGMENT_SHADER: 2, COMPILE_STATUS: 3, LINK_STATUS: 4,
        ARRAY_BUFFER: 5, STATIC_DRAW: 6, DYNAMIC_DRAW: 7, FLOAT: 8, TRIANGLE_STRIP: 9,
        LINES: 10, POINTS: 11, FRAMEBUFFER: 12, COLOR_ATTACHMENT0: 13, TEXTURE_2D: 14,
        RGBA: 15, UNSIGNED_BYTE: 16, TEXTURE_MIN_FILTER: 17, TEXTURE_MAG_FILTER: 18,
        LINEAR: 19, TEXTURE_WRAP_S: 20, TEXTURE_WRAP_T: 21, CLAMP_TO_EDGE: 22,
        COLOR_BUFFER_BIT: 23, BLEND: 24, ONE: 25, DEPTH_TEST: 26, TEXTURE0: 27, TEXTURE1: 28,
        ACTIVE_UNIFORMS: 29,
        createShader: () => ({}), shaderSource: () => {}, compileShader: () => {},
        getShaderParameter: () => true, getShaderInfoLog: () => "",
        createProgram: () => ({}), attachShader: () => {}, linkProgram: () => {},
        getProgramParameter: (_p: unknown, what: number) => (what === 4 ? true : 0),
        getProgramInfoLog: () => "",
        getActiveUniform: () => ({ name: "u" }), getUniformLocation: () => ({}),
        getAttribLocation: () => 0,
        createBuffer: () => ({}), bindBuffer: () => {}, bufferData: () => {},
        enableVertexAttribArray: () => {}, vertexAttribPointer: () => {},
        createTexture: () => ({}), bindTexture: () => {}, texImage2D: () => {}, texParameteri: () => {},
        createFramebuffer: () => ({}),
        bindFramebuffer: (_t: unknown, fb: unknown) => calls.push(fb == null ? "fb:default" : "fb:offscreen"),
        framebufferTexture2D: () => {},
        viewport: () => {}, clearColor: () => {}, clear: () => {},
        enable: () => {}, disable: () => {}, blendFunc: () => {},
        useProgram: () => {}, activeTexture: () => {},
        uniform1i: () => {}, uniform1f: () => {}, uniform2f: () => {},
        lineWidth: () => {},
        drawArrays: (mode: number, _first: number, count: number) => {
            if (mode === 10) { calls.push("draw:lines:" + count); }
            else if (mode === 11) { calls.push("draw:points:" + count); }
            else { calls.push("draw:quad"); }
        },
        deleteProgram: () => {}, deleteBuffer: () => {}, deleteTexture: () => {}, deleteFramebuffer: () => {},
        getExtension: () => ({ loseContext: () => {}, restoreContext: () => {} }),
    };
    return { gl: gl as unknown as WebGL2RenderingContext, calls };
}

function stubCanvas(gl: WebGL2RenderingContext | null) {
    const listeners = new Map<string, EventListener>();
    return {
        el: {
            width: 112, height: 112,
            getContext: () => gl,
            addEventListener: (t: string, fn: EventListener) => listeners.set(t, fn),
            removeEventListener: (t: string) => listeners.delete(t),
        } as unknown as HTMLCanvasElement,
        fire: (t: string) => listeners.get(t)?.({ preventDefault: () => {} } as unknown as Event),
    };
}

describe("AvatarGL", () => {
    it("returns null when WebGL 2 is unavailable, so the caller can fall back", () => {
        const canvas = stubCanvas(null);
        expect(AvatarGL.create(canvas.el)).toBeNull();
    });

    it("draws lines then points into an offscreen target before compositing to the default one", () => {
        const { gl, calls } = stubGL();
        const canvas = stubCanvas(gl);
        const r = AvatarGL.create(canvas.el);
        expect(r).not.toBeNull();
        r!.resize(112);
        const scene = sceneOf();
        r!.draw(scene, 112, 1, COLOURS, DEFAULT_BLOOM);

        const lines = calls.indexOf("draw:lines:" + scene.segments.length * 2);
        const points = calls.indexOf("draw:points:" + scene.points.length);
        const finalFb = calls.lastIndexOf("fb:default");
        expect(lines).toBeGreaterThanOrEqual(0);
        expect(points).toBeGreaterThan(lines);
        expect(finalFb).toBeGreaterThan(points);
        expect(calls[calls.length - 1]).toBe("draw:quad");
    });

    it("runs a bright pass and four blur passes between the scene and the composite", () => {
        const { gl, calls } = stubGL();
        const canvas = stubCanvas(gl);
        const r = AvatarGL.create(canvas.el)!;
        r.resize(112);
        r.draw(sceneOf(), 112, 1, COLOURS, DEFAULT_BLOOM);
        // bright + (horizontal, vertical) x 2 rounds + composite = 6 fullscreen quads
        expect(calls.filter((c) => c === "draw:quad").length).toBe(6);
    });

    it("reports itself lost after a context-loss event and stops drawing", () => {
        const { gl, calls } = stubGL();
        const canvas = stubCanvas(gl);
        const r = AvatarGL.create(canvas.el)!;
        r.resize(112);
        canvas.fire("webglcontextlost");
        expect(r.lost).toBe(true);
        const before = calls.length;
        r.draw(sceneOf(), 112, 1, COLOURS, DEFAULT_BLOOM);
        expect(calls.length).toBe(before);
    });

    it("notifies the caller on loss and on restore, so the renderer can be swapped", () => {
        const { gl } = stubGL();
        const canvas = stubCanvas(gl);
        const onLost = vi.fn();
        const onRestored = vi.fn();
        AvatarGL.create(canvas.el, { onLost, onRestored })!.resize(112);
        canvas.fire("webglcontextlost");
        expect(onLost).toHaveBeenCalled();
        canvas.fire("webglcontextrestored");
        expect(onRestored).toHaveBeenCalled();
    });

    it("does not draw before resize has allocated its targets", () => {
        const { gl, calls } = stubGL();
        const canvas = stubCanvas(gl);
        const r = AvatarGL.create(canvas.el)!;
        const before = calls.length;
        r.draw(sceneOf(), 112, 1, COLOURS, DEFAULT_BLOOM);
        expect(calls.length).toBe(before);
    });
});
```

- [ ] **Step 2: Run to verify the new tests fail**

Run: `npx vitest run frontend/app/view/jarvis/avatargl.test.ts`

Expected: FAIL — `AvatarGL` and `DEFAULT_BLOOM` are not exported.

- [ ] **Step 3: Add the renderer to avatargl.ts**

In `frontend/app/view/jarvis/avatargl.ts`, delete the `void toneChannels;` line and the now-unused `toneChannels` function, then append:

```ts
export interface BloomSettings {
    strength: number;
    threshold: number;
    radius: number;
}

/**
 * Provisional. Spec §10 requires these be tuned against the live dev app over the Chrome DevTools
 * Protocol — they were chosen on a bench that was never observed rendering.
 */
export const DEFAULT_BLOOM: BloomSettings = { strength: 1.3, threshold: 0.22, radius: 1.6 };

const V_PRIM = `#version 300 es
in vec2 aPos;
in vec3 aCol;
in float aA;
in float aSize;
out vec3 vCol;
out float vA;
void main() {
    vCol = aCol;
    vA = aA;
    gl_PointSize = aSize;
    gl_Position = vec4(aPos, 0.0, 1.0);
}`;

// premultiplied output with blendFunc(ONE, ONE): overlapping geometry accumulates light, which is how
// network density becomes visible instead of every crossing looking like one line
const F_LINE = `#version 300 es
precision highp float;
in vec3 vCol;
in float vA;
out vec4 o;
void main() { o = vec4(vCol * vA, vA); }`;

const F_POINT = `#version 300 es
precision highp float;
in vec3 vCol;
in float vA;
out vec4 o;
void main() {
    float d = length(gl_PointCoord - 0.5) * 2.0;
    float a = smoothstep(1.0, 0.0, d);
    a *= a;
    o = vec4(vCol * vA * a, vA * a);
}`;

const V_QUAD = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() { vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`;

const F_BRIGHT = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
uniform float uThreshold;
out vec4 o;
void main() {
    vec3 c = texture(uTex, vUv).rgb;
    float l = max(max(c.r, c.g), c.b);
    o = vec4(c * (max(0.0, l - uThreshold) / max(0.0001, l)), 1.0);
}`;

const F_BLUR = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
uniform vec2 uDir;
uniform vec2 uTexel;
uniform float uRadius;
out vec4 o;
void main() {
    vec2 s = uDir * uTexel * uRadius;
    vec3 c = texture(uTex, vUv).rgb * 0.2270270270;
    c += (texture(uTex, vUv + s * 1.3846153846).rgb + texture(uTex, vUv - s * 1.3846153846).rgb) * 0.3162162162;
    c += (texture(uTex, vUv + s * 3.2307692308).rgb + texture(uTex, vUv - s * 3.2307692308).rgb) * 0.0702702703;
    o = vec4(c, 1.0);
}`;

const F_COMP = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uScene;
uniform sampler2D uBloom;
uniform float uStrength;
out vec4 o;
void main() {
    vec3 c = texture(uScene, vUv).rgb + texture(uBloom, vUv).rgb * uStrength;
    o = vec4(c, clamp(max(max(c.r, c.g), c.b) * 1.3, 0.0, 1.0));
}`;

interface GLProgram {
    program: WebGLProgram;
    uniforms: Record<string, WebGLUniformLocation | null>;
}

interface RenderTarget {
    texture: WebGLTexture;
    framebuffer: WebGLFramebuffer;
    width: number;
    height: number;
}

export interface AvatarGLOptions {
    onLost?: () => void;
    onRestored?: () => void;
}

export class AvatarGL {
    private gl: WebGL2RenderingContext;
    private canvas: HTMLCanvasElement;
    private options: AvatarGLOptions;
    private programs: Record<string, GLProgram> = {};
    private buffers: { prim: WebGLBuffer | null; quad: WebGLBuffer | null } = { prim: null, quad: null };
    private targets: { scene: RenderTarget | null; a: RenderTarget | null; b: RenderTarget | null } = {
        scene: null,
        a: null,
        b: null,
    };
    private scratch = new Float32Array(0);
    private isLost = false;
    private onContextLost: EventListener;
    private onContextRestored: EventListener;

    private constructor(canvas: HTMLCanvasElement, gl: WebGL2RenderingContext, options: AvatarGLOptions) {
        this.canvas = canvas;
        this.gl = gl;
        this.options = options;
        this.onContextLost = (ev: Event) => {
            // cancelling the default is what makes a later restore possible at all
            ev.preventDefault();
            this.isLost = true;
            this.targets = { scene: null, a: null, b: null };
            this.options.onLost?.();
        };
        this.onContextRestored = () => {
            this.isLost = false;
            this.build();
            this.options.onRestored?.();
        };
        canvas.addEventListener("webglcontextlost", this.onContextLost);
        canvas.addEventListener("webglcontextrestored", this.onContextRestored);
        this.build();
    }

    /** Returns null when WebGL 2 is unavailable or a program fails to build — the caller falls back. */
    static create(canvas: HTMLCanvasElement, options: AvatarGLOptions = {}): AvatarGL | null {
        const gl = canvas.getContext("webgl2", {
            antialias: true,
            alpha: true,
            premultipliedAlpha: false,
        }) as WebGL2RenderingContext | null;
        if (gl == null) {
            return null;
        }
        try {
            return new AvatarGL(canvas, gl, options);
        } catch (err) {
            console.warn("avatar: WebGL setup failed, falling back to canvas", err);
            return null;
        }
    }

    get lost(): boolean {
        return this.isLost;
    }

    private compile(vertexSrc: string, fragmentSrc: string): GLProgram {
        const gl = this.gl;
        const program = gl.createProgram();
        if (program == null) {
            throw new Error("createProgram returned null");
        }
        for (const [type, src] of [
            [gl.VERTEX_SHADER, vertexSrc],
            [gl.FRAGMENT_SHADER, fragmentSrc],
        ] as [number, string][]) {
            const shader = gl.createShader(type);
            if (shader == null) {
                throw new Error("createShader returned null");
            }
            gl.shaderSource(shader, src);
            gl.compileShader(shader);
            if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
                throw new Error("shader compile failed: " + gl.getShaderInfoLog(shader));
            }
            gl.attachShader(program, shader);
        }
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
            throw new Error("program link failed: " + gl.getProgramInfoLog(program));
        }
        const uniforms: Record<string, WebGLUniformLocation | null> = {};
        const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS) as number;
        for (let i = 0; i < count; i++) {
            const info = gl.getActiveUniform(program, i);
            if (info != null) {
                uniforms[info.name] = gl.getUniformLocation(program, info.name);
            }
        }
        return { program, uniforms };
    }

    private build(): void {
        const gl = this.gl;
        this.programs = {
            line: this.compile(V_PRIM, F_LINE),
            point: this.compile(V_PRIM, F_POINT),
            bright: this.compile(V_QUAD, F_BRIGHT),
            blur: this.compile(V_QUAD, F_BLUR),
            comp: this.compile(V_QUAD, F_COMP),
        };
        this.buffers.prim = gl.createBuffer();
        this.buffers.quad = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.quad);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
        gl.disable(gl.DEPTH_TEST);
    }

    private makeTarget(width: number, height: number): RenderTarget {
        const gl = this.gl;
        const w = Math.max(1, width);
        const h = Math.max(1, height);
        const texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        const framebuffer = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        if (texture == null || framebuffer == null) {
            throw new Error("render target allocation failed");
        }
        return { texture, framebuffer, width: w, height: h };
    }

    /** `pixels` is the backing-store size, i.e. css size times device pixel ratio. */
    resize(pixels: number): void {
        if (this.isLost) {
            return;
        }
        const px = Math.max(1, Math.round(pixels));
        this.targets.scene = this.makeTarget(px, px);
        // bloom at half resolution: cheaper, and the blur wants to be soft anyway
        this.targets.a = this.makeTarget(px >> 1, px >> 1);
        this.targets.b = this.makeTarget(px >> 1, px >> 1);
    }

    private bindPrimAttribs(prog: GLProgram): void {
        const gl = this.gl;
        const stride = FLOATS_PER_VERTEX * 4;
        gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.prim);
        const pos = gl.getAttribLocation(prog.program, "aPos");
        const col = gl.getAttribLocation(prog.program, "aCol");
        const alpha = gl.getAttribLocation(prog.program, "aA");
        const size = gl.getAttribLocation(prog.program, "aSize");
        gl.enableVertexAttribArray(pos);
        gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, stride, 0);
        gl.enableVertexAttribArray(col);
        gl.vertexAttribPointer(col, 3, gl.FLOAT, false, stride, 8);
        gl.enableVertexAttribArray(alpha);
        gl.vertexAttribPointer(alpha, 1, gl.FLOAT, false, stride, 20);
        if (size >= 0) {
            gl.enableVertexAttribArray(size);
            gl.vertexAttribPointer(size, 1, gl.FLOAT, false, stride, 24);
        }
    }

    private fullscreen(prog: GLProgram): void {
        const gl = this.gl;
        gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.quad);
        const pos = gl.getAttribLocation(prog.program, "aPos");
        gl.enableVertexAttribArray(pos);
        gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 0, 0);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    draw(scene: AvatarScene, size: number, dpr: number, colours: SceneColours, bloom: BloomSettings): void {
        const { scene: sceneTarget, a, b } = this.targets;
        if (this.isLost || sceneTarget == null || a == null || b == null) {
            return;
        }
        const gl = this.gl;
        const packed = packScene(scene, size, dpr, colours, this.scratch);
        this.scratch = packed.data;
        gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.prim);
        gl.bufferData(
            gl.ARRAY_BUFFER,
            packed.data.subarray(0, (packed.lineVertices + packed.pointVertices) * FLOATS_PER_VERTEX),
            gl.DYNAMIC_DRAW
        );

        // pass 1 — the scene, additive, into an offscreen target
        gl.bindFramebuffer(gl.FRAMEBUFFER, sceneTarget.framebuffer);
        gl.viewport(0, 0, sceneTarget.width, sceneTarget.height);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE);
        gl.useProgram(this.programs.line.program);
        this.bindPrimAttribs(this.programs.line);
        gl.lineWidth(1);
        gl.drawArrays(gl.LINES, 0, packed.lineVertices);
        gl.useProgram(this.programs.point.program);
        this.bindPrimAttribs(this.programs.point);
        gl.drawArrays(gl.POINTS, packed.lineVertices, packed.pointVertices);

        // pass 2 — bright pass into half-resolution A
        gl.disable(gl.BLEND);
        gl.bindFramebuffer(gl.FRAMEBUFFER, a.framebuffer);
        gl.viewport(0, 0, a.width, a.height);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.useProgram(this.programs.bright.program);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, sceneTarget.texture);
        gl.uniform1i(this.programs.bright.uniforms.uTex ?? null, 0);
        gl.uniform1f(this.programs.bright.uniforms.uThreshold ?? null, bloom.threshold);
        this.fullscreen(this.programs.bright);

        // passes 3-6 — separable blur, two rounds, widening on the second
        gl.useProgram(this.programs.blur.program);
        gl.uniform2f(this.programs.blur.uniforms.uTexel ?? null, 1 / a.width, 1 / a.height);
        for (let round = 0; round < 2; round++) {
            for (const dir of [
                [1, 0],
                [0, 1],
            ]) {
                const source = dir[0] === 1 ? a : b;
                const destination = dir[0] === 1 ? b : a;
                gl.bindFramebuffer(gl.FRAMEBUFFER, destination.framebuffer);
                gl.viewport(0, 0, destination.width, destination.height);
                gl.clear(gl.COLOR_BUFFER_BIT);
                gl.activeTexture(gl.TEXTURE0);
                gl.bindTexture(gl.TEXTURE_2D, source.texture);
                gl.uniform1i(this.programs.blur.uniforms.uTex ?? null, 0);
                gl.uniform2f(this.programs.blur.uniforms.uDir ?? null, dir[0], dir[1]);
                gl.uniform1f(this.programs.blur.uniforms.uRadius ?? null, bloom.radius * (1 + round));
                this.fullscreen(this.programs.blur);
            }
        }

        // pass 7 — composite scene plus bloom to the visible framebuffer
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, this.canvas.width, this.canvas.height);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.useProgram(this.programs.comp.program);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, sceneTarget.texture);
        gl.uniform1i(this.programs.comp.uniforms.uScene ?? null, 0);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, a.texture);
        gl.uniform1i(this.programs.comp.uniforms.uBloom ?? null, 1);
        gl.uniform1f(this.programs.comp.uniforms.uStrength ?? null, bloom.strength);
        this.fullscreen(this.programs.comp);
    }

    dispose(): void {
        const gl = this.gl;
        this.canvas.removeEventListener("webglcontextlost", this.onContextLost);
        this.canvas.removeEventListener("webglcontextrestored", this.onContextRestored);
        for (const prog of Object.values(this.programs)) {
            gl.deleteProgram(prog.program);
        }
        for (const buf of [this.buffers.prim, this.buffers.quad]) {
            if (buf != null) {
                gl.deleteBuffer(buf);
            }
        }
        for (const target of [this.targets.scene, this.targets.a, this.targets.b]) {
            if (target != null) {
                gl.deleteTexture(target.texture);
                gl.deleteFramebuffer(target.framebuffer);
            }
        }
        this.programs = {};
        this.targets = { scene: null, a: null, b: null };
    }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run frontend/app/view/jarvis/avatargl.test.ts`

Expected: PASS, 13 tests.

- [ ] **Step 5: Lint and stage**

```bash
npx eslint frontend/app/view/jarvis/avatargl.ts frontend/app/view/jarvis/avatargl.test.ts
git add frontend/app/view/jarvis/avatargl.ts frontend/app/view/jarvis/avatargl.test.ts
```

---

## Task 8: Rewire petview.tsx onto the new renderers

The component keeps everything about *being an object in the corner* — drag between corners, click to open the peek, keyboard activation, the unread marker, the bubble and peek children, the accessible name. What changes is what it draws with: an animation loop over a canvas instead of an SVG tree.

**Files:**
- Modify: `frontend/app/view/jarvis/petstore.ts` (add two exports)
- Modify: `frontend/app/view/jarvis/petview.tsx` (replace the rendering half)

**Interfaces:**
- Consumes: everything from Tasks 1 and 3–7.
- Produces: `petSpokeAtAtom: PrimitiveAtom<number | null>` and `markPetSpoke(at: number): void` from `petstore.ts`; the dev-only global `window.__jarvisAvatarScene` read by Task 9.

- [ ] **Step 1: Add the utterance timestamp to petstore.ts**

Append to `frontend/app/view/jarvis/petstore.ts`:

```ts
// When Jarvis last said something, as a performance.now() reading, or null if not yet this session.
//
// Session-scoped and deliberately not persisted: it drives the data rings' surge, and a relaunch surging
// about something said an hour ago would be a lie. Held as a timestamp rather than as an animating value
// because the render loop derives the envelope per frame — a 60-per-second atom write would put a React
// render on every frame in a window running live terminals.
export const petSpokeAtAtom = atom<number | null>(null) as PrimitiveAtom<number | null>;

export function markPetSpoke(at: number): void {
    globalStore.set(petSpokeAtAtom, at);
}
```

- [ ] **Step 2: Replace petview.tsx**

Replace the entire contents of `frontend/app/view/jarvis/petview.tsx`:

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The avatar: a hologram in window chrome. Thin by design — every decision it draws is made in
// petcondition.ts / petvoice.ts, its geometry is built in avatarscene.ts, and its pixels come from
// avatargl.ts or avatarcanvas.ts. This file owns only the animation loop and which renderer is live.
//
// Mounted once in cockpit-root, never inside a surface: every surface but Agent unmounts on a nav switch,
// and an avatar that vanished when you changed rooms would be a status glyph, not a presence.
//
// It never draws a number. The nav badge owns the count; the avatar owns the kind (design §3).

import { globalStore } from "@/app/store/jotaiStore";
import type { AgentsViewModel } from "@/app/view/agents/agents";
import { liveWindowAgents, providerPlanUsage } from "@/app/view/agents/agentsviewmodel";
import { attentionAtom } from "@/app/view/agents/attentionstore";
import { memPruneAtom, memPruneLoadedAtom } from "@/app/view/agents/memstore";
import { mergeRateLimitWindows, savedRateLimitsAtom, topProviderUsage } from "@/app/view/agents/ratelimitstore";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { motion, useMotionValue, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { drawSceneToCanvas, resolveTone } from "./avatarcanvas";
import { AvatarGL, DEFAULT_BLOOM } from "./avatargl";
import { buildAvatarScene, type AvatarScene } from "./avatarscene";
import { PetBubble } from "./petbubble";
import { expressionFor, postureFor, type PetSignals } from "./petcondition";
import { indexSignal } from "./petjoin";
import { breathPhase, gazeYawPitch, utteranceEnvelope } from "./petmotion";
import { PetPeek } from "./petpeek";
import {
    markPetSpoke,
    petBubbleAtom,
    petCornerAtom,
    petEventsAtom,
    petIndexAtom,
    petPeekOpenAtom,
    petSpokeAtAtom,
    petUnreadAtom,
    petWatermarkAtom,
    rememberSaid,
    setPetCorner,
    setPetWatermark,
    type PetCorner,
} from "./petstore";
import { nextUtterance } from "./petvoice";

// pkg/jarvis/attention.go's three kinds. Named here rather than inlined so the mapping to the avatar's
// posture vocabulary is one line to check against the server.
const ATTENTION_GATE = "gate";
const ATTENTION_ESCALATION = "escalation";
const ATTENTION_ASK = "ask";

const PRUNE_REASON_STALE = "stale";

// Corner anchors. The insets clear the chrome the avatar would otherwise sit on: the 28px hints footer at
// the bottom, and the nav rail on the left (78px measured, expanded). Spec §10: these were measured against
// a 44px creature and need re-measuring at the active size.
const CORNER_CLASS: Record<PetCorner, string> = {
    "bottom-right": "bottom-[40px] right-[18px]",
    "bottom-left": "bottom-[40px] left-[92px]",
};

// Provisional (spec §10). ACTIVE is the size chosen when placement was settled; QUIET_PX is the peripheral
// size the helmet-display rule asks for. Both want tuning against the live dev app.
const ACTIVE_PX = 112;
const QUIET_PX = 68;

const YAW_CAP = 0.6;
const PITCH_CAP = 0.34;
const RINGS = 3;
const RING_TICKS = 72;
const NODES = 16;

function count(items: AttentionItem[], kind: string): number {
    return items.reduce((n, i) => (i.kind === kind ? n + 1 : n), 0);
}

// Every signal the avatar reads. All four ranks are live: `index` is fed by petsources.tsx on a slow
// cadence and stays undefined — "no signal", never "signal absent" — until that read lands.
function usePetSignals(model: AgentsViewModel): PetSignals {
    const agents = useAtomValue(model.agentsAtom);
    const saved = useAtomValue(savedRateLimitsAtom);
    const now = useAtomValue(model.nowAtom);
    const attention = useAtomValue(attentionAtom);
    const prune = useAtomValue(memPruneAtom);
    const pruneLoaded = useAtomValue(memPruneLoadedAtom);
    const index = useAtomValue(petIndexAtom);

    const donuts = mergeRateLimitWindows(providerPlanUsage(liveWindowAgents(agents)), saved, now);
    const top = topProviderUsage(donuts);
    const rateLimit =
        top != null
            ? { pct: top.pct, resetAt: donuts.find((d) => d.provider === top.provider)?.fivehour.reset }
            : undefined;

    return {
        index: indexSignal(index),
        rateLimit,
        decay: pruneLoaded
            ? {
                  queueDepth: prune.length,
                  staleNotes: prune.reduce((n, c) => (c.reason === PRUNE_REASON_STALE ? n + 1 : n), 0),
              }
            : undefined,
        attention: {
            reviewGates: count(attention, ATTENTION_GATE),
            escalations: count(attention, ATTENTION_ESCALATION),
            blockedWorkers: count(attention, ATTENTION_ASK),
        },
    };
}

// Nearest corner from where the drag was released. Only the horizontal half of the drop is read: the
// avatar keeps to the bottom edge (see PET_CORNERS), so releasing it high still lands it in the bottom
// corner on that side rather than nowhere.
function cornerAt(x: number): PetCorner {
    return x < window.innerWidth / 2 ? "bottom-left" : "bottom-right";
}

export function PetView({ model }: { model: AgentsViewModel }) {
    const signals = usePetSignals(model);
    const expression = expressionFor(signals);
    const posture = postureFor(signals);
    const corner = useAtomValue(petCornerAtom);
    const bubble = useAtomValue(petBubbleAtom);
    const unread = useAtomValue(petUnreadAtom);
    const peekOpen = useAtomValue(petPeekOpenAtom);
    const events = useAtomValue(petEventsAtom);
    const watermark = useAtomValue(petWatermarkAtom);
    const reduce = useReducedMotion() === true;
    const [anchor, setAnchor] = useState<HTMLDivElement | null>(null);
    const draggingRef = useRef(false);
    const x = useMotionValue(0);
    const y = useMotionValue(0);

    // faint at rest and solid the moment it has something to express — a health indicator you cannot see
    // does not work, so anything but at-rest-and-idle claims full presence (design §3).
    const quiet = expression.kind === "at-rest" && posture === "none" && !peekOpen && bubble == null;
    const size = quiet ? QUIET_PX : ACTIVE_PX;

    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const [glFailed, setGlFailed] = useState(false);
    const pointerRef = useRef<{ x: number; y: number } | null>(null);

    // Everything the loop needs, in a ref rather than in the closure: the loop is started once per renderer
    // lifetime, and reading state through a ref keeps a condition change from tearing down the GL context.
    const frameRef = useRef({ expression, posture, quiet, size, reduce });
    frameRef.current = { expression, posture, quiet, size, reduce };

    useEffect(() => {
        const canvas = canvasRef.current;
        if (canvas == null) {
            return;
        }
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const gl = AvatarGL.create(canvas, {
            onLost: () => setGlFailed(true),
            onRestored: () => setGlFailed(false),
        });
        const ctx2d = gl == null ? canvas.getContext("2d") : null;
        if (gl == null) {
            setGlFailed(true);
        }

        let raf = 0;
        let lastPixels = -1;
        const read = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

        const frame = (now: number) => {
            const f = frameRef.current;
            const cssSize = f.size;
            const pixels = Math.round(cssSize * dpr);
            if (pixels !== lastPixels) {
                lastPixels = pixels;
                canvas.style.width = cssSize + "px";
                canvas.style.height = cssSize + "px";
                canvas.width = pixels;
                canvas.height = pixels;
                gl?.resize(pixels);
                ctx2d?.setTransform(dpr, 0, 0, dpr, 0, 0);
            }

            const rect = canvas.getBoundingClientRect();
            const pointer = pointerRef.current;
            const gaze =
                pointer == null || f.reduce
                    ? { yaw: 0, pitch: 0 }
                    : gazeYawPitch(
                          rect.left + rect.width / 2,
                          rect.top + rect.height / 2,
                          pointer.x,
                          pointer.y,
                          YAW_CAP,
                          PITCH_CAP
                      );

            const scene: AvatarScene = buildAvatarScene({
                expression: f.expression,
                posture: f.posture,
                size: cssSize,
                now,
                yaw: gaze.yaw,
                pitch: gaze.pitch,
                breath: breathPhase(now),
                utterance: utteranceEnvelope(now, globalStore.get(petSpokeAtAtom)),
                quiet: f.quiet,
                rings: RINGS,
                ringTicks: RING_TICKS,
                nodes: NODES,
                shell: true,
                still: f.reduce,
            });

            const colours = resolveTone(scene, read);
            if (gl != null && !gl.lost) {
                gl.draw(scene, cssSize, dpr, colours, DEFAULT_BLOOM);
            } else if (ctx2d != null) {
                drawSceneToCanvas(ctx2d, scene, cssSize, colours);
            }

            // Dev-only: the CDP harness asserts on this instead of on pixels, which is stronger than what
            // the old SVG tree allowed because it can check the whole scene at once. Folded out of
            // production builds — import.meta.env.DEV is statically false there.
            if (import.meta.env.DEV) {
                (window as unknown as { __jarvisAvatarScene?: unknown }).__jarvisAvatarScene = {
                    segments: scene.segments.length,
                    points: scene.points.length,
                    toneVar: scene.toneVar,
                    markerVar: scene.markerVar,
                    extent: Math.round(scene.extent),
                    expression: f.expression.kind,
                    posture: f.posture,
                    renderer: gl != null && !gl.lost ? "webgl" : "canvas",
                };
            }
            raf = requestAnimationFrame(frame);
        };
        raf = requestAnimationFrame(frame);

        const onMove = (ev: PointerEvent) => {
            pointerRef.current = { x: ev.clientX, y: ev.clientY };
        };
        window.addEventListener("pointermove", onMove);
        return () => {
            cancelAnimationFrame(raf);
            window.removeEventListener("pointermove", onMove);
            gl?.dispose();
        };
        // The loop reads everything else through frameRef, so it is built once. glFailed is in the deps so
        // a context loss with no 2D context yet re-runs setup and acquires one.
    }, [glFailed]);

    // Push once per event (design §4 decision 8). Advancing the watermark re-runs this effect, which then
    // finds nothing new — so the loop settles after one push rather than repeating it.
    useEffect(() => {
        const speech = nextUtterance(events, watermark);
        if (speech.watermark == null) {
            return;
        }
        setPetWatermark(speech.watermark);
        if (speech.utterance != null) {
            rememberSaid(speech.utterance);
            globalStore.set(petBubbleAtom, speech.utterance);
            globalStore.set(petUnreadAtom, false); // the bubble itself is the notice
            markPetSpoke(performance.now()); // and the rings surge for it
        }
    }, [events, watermark]);

    const openPeek = () => {
        globalStore.set(petPeekOpenAtom, true);
        globalStore.set(petUnreadAtom, false);
        globalStore.set(petBubbleAtom, null);
    };

    return (
        <>
            <motion.div
                ref={setAnchor}
                drag
                dragMomentum={false}
                style={{ x, y }}
                onDragStart={() => {
                    draggingRef.current = true;
                }}
                onDragEnd={(_, info) => {
                    setPetCorner(cornerAt(info.point.x));
                    x.set(0);
                    y.set(0);
                }}
                onClick={() => {
                    if (draggingRef.current) {
                        draggingRef.current = false;
                        return;
                    }
                    if (peekOpen) {
                        globalStore.set(petPeekOpenAtom, false);
                        return;
                    }
                    openPeek();
                }}
                role="button"
                tabIndex={0}
                // not "Jarvis": the nav rail's entry-two button already owns that name, and the CDP harness
                // navigates by it (scripts/cdp/attach.mjs SURFACE_LABEL). Two controls with one accessible
                // name is ambiguous to a screen reader and makes a by-label query pick whichever comes
                // first in the DOM — which is the nav button, not the avatar.
                aria-label="Jarvis condition"
                onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        openPeek();
                    }
                }}
                className={cn(
                    "fixed z-[60] flex cursor-grab items-center justify-center rounded-full outline-none active:cursor-grabbing",
                    "transition-opacity duration-300 hover:opacity-100 focus-visible:opacity-100",
                    quiet ? "opacity-40" : "opacity-100",
                    CORNER_CLASS[corner]
                )}
            >
                <canvas ref={canvasRef} aria-hidden="true" className="block" />
                {/* the unread marker: a kind of thing happened, never how many */}
                {unread ? (
                    <span className="pointer-events-none absolute right-0 top-0 h-[9px] w-[9px] rounded-full border border-background bg-accent" />
                ) : null}
            </motion.div>
            <PetBubble
                event={bubble}
                anchor={anchor}
                corner={corner}
                onOpen={openPeek}
                onDismiss={() => {
                    globalStore.set(petBubbleAtom, null);
                    globalStore.set(petUnreadAtom, true);
                }}
            />
            <PetPeek
                model={model}
                anchor={anchor}
                corner={corner}
                signals={signals}
                expression={expression}
                posture={posture}
            />
        </>
    );
}
```

- [ ] **Step 3: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`

Expected: exit 0, clean. If `PetExpression`/`PetPosture` are reported as unused imports, remove them — they are referenced only through inference here.

- [ ] **Step 4: Run the full suite**

Run: `npx vitest run`

Expected: PASS. Baseline was 1688 passed / 2 skipped; this work removes about 9 eye-specific tests and adds roughly 43, so expect a net increase of about 34.

- [ ] **Step 5: Verify in the running app**

Start the dev app (`task dev`) and screenshot it:

```bash
node scripts/cdp-shot.mjs cdp-shots/avatar-live.png
```

Then read the scene the loop is publishing:

```bash
node -e "const{attach}=require('./scripts/cdp/attach.mjs');" 2>/dev/null || true
```

Use the existing attach helper from a small script instead, evaluating `window.__jarvisAvatarScene`. Expected: `renderer: "webgl"`, non-zero `segments` and `points`, `toneVar` matching the current condition, and `markerVar: null` when nothing is waiting.

Confirm no WebGL warnings in the console. If `renderer` reports `"canvas"`, the GL path failed — check the console for the shader compile or link message thrown by `AvatarGL.create`.

- [ ] **Step 6: Lint and stage**

```bash
npx eslint frontend/app/view/jarvis/petview.tsx frontend/app/view/jarvis/petstore.ts
git add frontend/app/view/jarvis/petview.tsx frontend/app/view/jarvis/petstore.ts
```

---

## Task 9: A CDP scenario asserting the scene

The codebase has no jsdom render tests by convention; "does it render" is covered by scenarios in `scripts/cdp/scenarios.mjs`. This one asserts the published scene rather than pixels.

**Files:**
- Modify: `scripts/cdp/scenarios.mjs`

**Interfaces:**
- Consumes: `window.__jarvisAvatarScene` from Task 8.
- Produces: a `jarvis-avatar` scenario registered in the exported `SCENARIOS` array.

- [ ] **Step 1: Read the surrounding conventions**

Read the `surface-smoke` scenario (around line 121) and the `SCENARIOS` export (around line 2681) in `scripts/cdp/scenarios.mjs`. Match the existing shape exactly — the same `name`, `goto`, `shot` and `assert` keys, and the same 4-space indentation. Do **not** run prettier on this file; `.editorconfig` omits `.mjs`, so a write would reindent the whole file to 2 spaces.

- [ ] **Step 2: Add the scenario**

Insert this scenario object before the `SCENARIOS` export, following the formatting of its neighbours:

```javascript
{
    name: "jarvis-avatar",
    // The avatar is a <canvas>, so there are no attributes to read. It publishes its last built scene on
    // window in dev builds instead, which is a stronger assertion than the old SVG tree allowed: the whole
    // scene at once rather than one element's transform.
    viewport: { width: 1600, height: 950 },
    goto: async (c) => {
        await c.goto("cockpit");
    },
    shot: "jarvis-avatar",
    assert: async (c) => {
        const problems = [];
        const scene = await c.ev("window.__jarvisAvatarScene ?? null");
        if (scene == null) {
            return ["avatar published no scene — is the render loop running?"];
        }
        if (!(scene.segments > 0)) {
            problems.push(`expected segments > 0, got ${scene.segments}`);
        }
        if (!(scene.points > 0)) {
            problems.push(`expected points > 0, got ${scene.points}`);
        }
        if (!String(scene.toneVar).startsWith("--color-")) {
            problems.push(`tone must be a theme token, got ${scene.toneVar}`);
        }
        if (!(scene.extent > 0)) {
            problems.push(`expected a non-zero extent, got ${scene.extent}`);
        }
        // exactly one control owns each accessible name; two would make a by-label query ambiguous
        const named = await c.ev(
            `[...document.querySelectorAll('[aria-label="Jarvis condition"]')].length`
        );
        if (named !== 1) {
            problems.push(`expected 1 control named "Jarvis condition", found ${named}`);
        }
        const navNamed = await c.ev(`[...document.querySelectorAll('[aria-label="Jarvis"]')].length`);
        if (navNamed !== 1) {
            problems.push(`expected 1 nav control named "Jarvis", found ${navNamed}`);
        }
        return problems;
    },
},
```

Then add `"jarvis-avatar"` to the `SCENARIOS` array in the same position ordering as its neighbours.

- [ ] **Step 3: Run the scenario against the dev app**

Run: `task verify:ui -- jarvis-avatar surface-smoke`

Expected: both PASS. `surface-smoke` is included because the avatar is a global overlay and could break any surface.

- [ ] **Step 4: Stage**

```bash
git add scripts/cdp/scenarios.mjs
```

---

## Task 10: Tune the provisional numbers, close the docs, and commit

Everything visual in the spec was authored without ever being observed rendering. This task is where that gets fixed, and where the old design doc stops claiming things that are no longer true.

**Files:**
- Modify: `frontend/app/view/jarvis/avatargl.ts` (`DEFAULT_BLOOM`)
- Modify: `frontend/app/view/jarvis/petview.tsx` (`ACTIVE_PX`, `QUIET_PX`, `CORNER_CLASS`, `RINGS`, `RING_TICKS`, `NODES`)
- Modify: `docs/superpowers/specs/2026-08-04-jarvis-pet-design.md`

**Interfaces:**
- Consumes: a working avatar from Task 8.
- Produces: nothing new. Values and documentation only.

- [ ] **Step 1: Tune bloom and geometry against the live app**

With the dev app running, iterate on `DEFAULT_BLOOM` in `avatargl.ts` and the `RINGS` / `RING_TICKS` / `NODES` constants in `petview.tsx`, screenshotting after each change:

```bash
node scripts/cdp-shot.mjs cdp-shots/avatar-tune.png
```

Judge: is the glow reading as light rather than as a blurred copy? Are the ticks legible at the active size, or is the ring density mush? Record the values you settle on in a one-line comment beside each constant explaining what you were trading off, and delete the word "provisional" from those comments.

- [ ] **Step 2: Re-measure occlusion at the new size**

The insets in `CORNER_CLASS` were measured against a 44px creature. Measure the avatar's real bounding box at `ACTIVE_PX` in both corners, on the Agent surface and the Jarvis Stage:

```bash
node -e "1" # use the attach helper from scripts/cdp/attach.mjs in a small script
```

Evaluate the avatar's `getBoundingClientRect()` and compare against the bottom-region inputs, terminals and buttons on each surface. The pet design's finding was that the two bottom corners collide on *opposite* sides — the Agent surface's terminal fills x≥330 so bottom-right is blocked, and the Jarvis Stage's thread list fills x 86–331 so bottom-left is blocked. Confirm that still holds at the larger size. If a corner now collides on both surfaces, reduce `ACTIVE_PX` rather than adding a third corner — the top pair was measured and rejected for sitting on the surface heading band.

- [ ] **Step 3: Mark the superseded sections of the pet design doc**

In `docs/superpowers/specs/2026-08-04-jarvis-pet-design.md`, add a pointer at each of the six superseded places so a future reader does not act on stale guidance. Insert immediately after the document's status line:

```markdown
> **Partly superseded** by [the avatar design](2026-08-04-jarvis-avatar-design.md), which replaces the form
> and the renderer: §4 decisions 6 and 7, the "Creature form" note under §4, the §5 Modules table, the WebGL
> paragraph in §9, and the slit-eyed-states paragraph in §10. Everything else here still stands — the four
> registers, the capability ladder, the data audit, and the three-stage split.
```

- [ ] **Step 4: Run everything**

```bash
npx vitest run
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit
npx eslint frontend/app/view/jarvis/ scripts/cdp/scenarios.mjs
task verify:ui -- jarvis-avatar surface-smoke jarvis-states
```

Expected: suite green, typecheck exit 0, lint clean, all three scenarios PASS.

- [ ] **Step 5: Stage everything, then ask before committing**

```bash
git add frontend/app/view/jarvis/ scripts/cdp/scenarios.mjs docs/superpowers/specs/ docs/superpowers/plans/
git status --short
```

**Stop here and ask the user to approve the commit.** The repository rule is that nothing is committed without explicit approval, and that spec and plan documents fold into the feature commit they describe rather than landing separately — which is why both markdown files are staged alongside the code.

Only after approval:

```bash
git commit -F <path-to-message-file>
```

Write the message to a temp file rather than using a here-string; PowerShell here-string syntax inside the Bash tool is prohibited on this machine. The message should lead with what changed and why the blob went, name the five-round form search and the sourced reference that ended it, and record honestly that the bloom and size values were tuned live in Task 10 while the spec's originals were authored blind.

---

## Self-Review

**Spec coverage.** Every section of `2026-08-04-jarvis-avatar-design.md` maps to a task: §3's three parts to Tasks 2–4; §4 decision 2 (raw WebGL) to Tasks 6–7; decision 3 (canvas fallback) to Task 5 and the `onLost` wiring in Task 8; decision 6 (utterance-reactive, no audio) to Task 1's `utteranceEnvelope` and Task 8's `markPetSpoke`; decision 7 (theme tokens) to `resolveTone`'s injected reader in Task 5; §5's module table to the File Structure table; §6's deletions to Task 1; §7's data flow to Tasks 1 and 8; §8's failure paths to Tasks 5, 7 and 8; §9's verification to the test steps and Task 9; §10's provisional numbers and occlusion re-measurement to Task 10; §12's rename deferral is honoured by using an `avatar*` prefix for new files and leaving `pet*` alone.

**Two gaps I found and closed while reviewing.** The plan originally had no task touching the old pet design doc, leaving it asserting that 3D was permanently deferred — now Task 10 Step 3. And nothing was re-measuring occlusion despite the spec calling it out — now Task 10 Step 2.

**One thing this plan deliberately does not do.** It does not add a "speak" trigger for manual testing. The rings can only be observed surging when a real utterance fires, and all four Voice triggers in the pet design are backend reads that do not exist yet, so nothing pushes an event in production today. The unit tests in Task 3 cover the amplitude behaviour; a temporary dev button would be scope creep. Flag it if you want one.

**Type consistency.** `SceneTone`, `SceneSegment`, `ScenePoint`, `AvatarScene`, `SceneColours`, `PackedScene` and `BloomSettings` are each defined once and used with the same shape everywhere. `FLOATS_PER_VERTEX` is the single source for the vertex stride, used by both `packScene` and `bindPrimAttribs`. `resolveTone` is defined in `avatarcanvas.ts` and imported by both the component and `avatargl.ts`'s types — deliberate, so colour resolution has one home rather than two that can disagree.
