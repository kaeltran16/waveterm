import { describe, expect, it } from "vitest";
import type { SceneColours } from "./avatarcanvas";
import {
    buildAvatarScene,
    STROKE,
    STROKE_WIDTHS,
    type AvatarScene,
    type SceneFill,
    type SceneInput,
    type SceneSegment,
} from "./avatarscene";
import { fillTriangles, growCapacity, packFills, packFillsInto, packLines, packLinesInto, picker } from "./avatarthree";

const SIZE = 132;

function sceneOf(over: Partial<SceneInput> = {}): AvatarScene {
    return buildAvatarScene({
        expression: { kind: "at-rest" },
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
    });
}

const COLOURS: SceneColours = { body: "#5f74e0", hot: "#afbbf0", marker: "#e0726c" };

const seg = (over: Partial<SceneSegment> = {}): SceneSegment => ({
    ax: 0,
    ay: 0,
    bx: 10,
    by: 10,
    depth: 0,
    tone: "body",
    alpha: 1,
    width: STROKE.base,
    ...over,
});

const fill = (over: Partial<SceneFill> = {}): SceneFill => ({
    points: [
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
    ],
    depth: 0,
    tone: "body",
    alpha: 1,
    ...over,
});

describe("packLines", () => {
    it("emits six position floats and six colour floats per segment", () => {
        const scene = sceneOf();
        const packed = packLines(scene.segments, SIZE, COLOURS);
        expect(packed.segments).toBe(scene.segments.length);
        expect(packed.positions.length).toBe(scene.segments.length * 6);
        expect(packed.colors.length).toBe(scene.segments.length * 6);
    });

    it("packs only the slice it is handed, because the renderer batches by stroke weight", () => {
        const scene = sceneOf();
        const total = STROKE_WIDTHS.reduce(
            (sum, width) =>
                sum +
                packLines(
                    scene.segments.filter((s) => s.width === width),
                    SIZE,
                    COLOURS
                ).segments,
            0
        );
        // every segment lands in exactly one batch: none double-counted, none stranded off the ladder
        expect(total).toBe(scene.segments.length);
    });

    it("maps screen coordinates into a [-1,1] box with y flipped", () => {
        const packed = packLines([seg({ ax: 0, ay: 0, bx: SIZE, by: SIZE })], SIZE, COLOURS);
        // top-left of the box is (-1, +1); bottom-right is (+1, -1)
        expect(packed.positions[0]).toBeCloseTo(-1);
        expect(packed.positions[1]).toBeCloseTo(1);
        expect(packed.positions[3]).toBeCloseTo(1);
        expect(packed.positions[4]).toBeCloseTo(-1);
    });

    it("premultiplies alpha into the colour, because LineMaterial carries no per-vertex alpha", () => {
        const full = packLines([seg({ alpha: 1 })], SIZE, COLOURS);
        const half = packLines([seg({ alpha: 0.5 })], SIZE, COLOURS);
        expect(half.colors[0]).toBeCloseTo(full.colors[0] / 2);
        expect(half.colors[1]).toBeCloseTo(full.colors[1] / 2);
        expect(half.colors[2]).toBeCloseTo(full.colors[2] / 2);
    });

    it("carries alpha to black at zero, so a stuttered-out layer contributes no light", () => {
        const packed = packLines([seg({ alpha: 0 })], SIZE, COLOURS);
        expect(Array.from(packed.colors)).toEqual(new Array(6).fill(0));
    });

    it("resolves each tone to its own colour", () => {
        const of = (tone: SceneSegment["tone"]) =>
            Array.from(packLines([seg({ tone })], SIZE, COLOURS).colors.slice(0, 3));
        expect(of("body")).not.toEqual(of("hot"));
        expect(of("body")).not.toEqual(of("marker"));
    });

    it("packs an empty slice without allocating a malformed buffer", () => {
        const packed = packLines([], SIZE, COLOURS);
        expect(packed.segments).toBe(0);
        expect(packed.positions.length).toBe(0);
    });
});

describe("packFills", () => {
    it("fans each polygon into n-2 triangles of nine floats", () => {
        const scene = sceneOf({ posture: "escalation" });
        const expected = scene.fills.reduce((sum, f) => sum + Math.max(0, f.points.length - 2), 0);
        const packed = packFills(scene.fills, SIZE, COLOURS);
        expect(expected).toBeGreaterThan(0);
        expect(packed.triangles).toBe(expected);
        expect(packed.positions.length).toBe(expected * 9);
        expect(packed.colors.length).toBe(expected * 9);
    });

    it("maps into the same [-1,1] box as the lines, so fills and strokes register", () => {
        const packed = packFills(
            [
                fill({
                    points: [
                        [0, 0],
                        [SIZE, 0],
                        [SIZE, SIZE],
                    ],
                }),
            ],
            SIZE,
            COLOURS
        );
        expect(packed.positions[0]).toBeCloseTo(-1);
        expect(packed.positions[1]).toBeCloseTo(1);
        expect(packed.positions[6]).toBeCloseTo(1);
        expect(packed.positions[7]).toBeCloseTo(-1);
    });

    it("premultiplies alpha the same way lines do", () => {
        const full = packFills([fill({ alpha: 1 })], SIZE, COLOURS);
        const half = packFills([fill({ alpha: 0.5 })], SIZE, COLOURS);
        expect(half.colors[0]).toBeCloseTo(full.colors[0] / 2);
    });

    it("resolves the marker tone, which is the one fill the posture marker needs", () => {
        const body = Array.from(packFills([fill({ tone: "body" })], SIZE, COLOURS).colors.slice(0, 3));
        const marker = Array.from(packFills([fill({ tone: "marker" })], SIZE, COLOURS).colors.slice(0, 3));
        expect(body).not.toEqual(marker);
    });

    it("contributes nothing for a polygon with fewer than three points", () => {
        const packed = packFills(
            [
                fill({
                    points: [
                        [0, 0],
                        [1, 1],
                    ],
                }),
            ],
            SIZE,
            COLOURS
        );
        expect(packed.triangles).toBe(0);
        expect(packed.positions.length).toBe(0);
    });

    it("packs an empty fill list without allocating a malformed buffer", () => {
        const packed = packFills([], SIZE, COLOURS);
        expect(packed.triangles).toBe(0);
        expect(packed.positions.length).toBe(0);
    });
});

describe("packing into reused buffers", () => {
    // the renderer keeps one buffer per batch across frames instead of a fresh geometry per frame, so the
    // in-place packers must produce exactly what the allocating ones do
    it("writes the same floats into a larger, reused buffer as a fresh pack", () => {
        const scene = sceneOf({ now: 1234, yaw: 0.7, breath: 0.4 });
        const fresh = packLines(scene.segments, SIZE, COLOURS);
        const positions = new Float32Array(scene.segments.length * 6 + 60).fill(9);
        const colors = new Float32Array(positions.length).fill(9);
        const count = packLinesInto(scene.segments, SIZE, picker(COLOURS), positions, colors);
        expect(count).toBe(fresh.segments);
        expect(positions.subarray(0, count * 6)).toEqual(fresh.positions);
        expect(colors.subarray(0, count * 6)).toEqual(fresh.colors);
    });

    it("does the same for fills", () => {
        const scene = sceneOf({ now: 1234, yaw: 0.7, breath: 0.4 });
        const fresh = packFills(scene.fills, SIZE, COLOURS);
        const positions = new Float32Array(fresh.positions.length + 90).fill(9);
        const colors = new Float32Array(positions.length).fill(9);
        const triangles = packFillsInto(scene.fills, SIZE, picker(COLOURS), positions, colors);
        expect(triangles).toBe(fresh.triangles);
        expect(positions.subarray(0, triangles * 9)).toEqual(fresh.positions);
        expect(colors.subarray(0, triangles * 9)).toEqual(fresh.colors);
    });

    it("counts fill triangles without packing them, so the buffer can be sized first", () => {
        const scene = sceneOf();
        expect(fillTriangles(scene.fills)).toBe(packFills(scene.fills, SIZE, COLOURS).triangles);
    });
});

describe("growCapacity", () => {
    it("keeps a buffer that already fits", () => {
        expect(growCapacity(100, 128)).toBe(128);
    });

    it("grows past the need with headroom, so a stuttering count does not reallocate every frame", () => {
        const cap = growCapacity(129, 128);
        expect(cap).toBeGreaterThanOrEqual(129 * 1.5);
    });

    it("starts from a usable size", () => {
        expect(growCapacity(0, 0)).toBeGreaterThan(0);
    });
});
