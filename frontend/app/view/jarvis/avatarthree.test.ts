import { describe, expect, it } from "vitest";
import type { SceneColours } from "./avatarcanvas";
import { buildAvatarScene, type AvatarScene, type SceneInput } from "./avatarscene";
import { packLines, packPoints } from "./avatarthree";

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
        ripple: null,
        jolt: 0,
        rings: 3,
        ringTicks: 28,
        nodes: 16,
        shell: true,
        still: false,
        ...over,
    });
}

const COLOURS: SceneColours = { body: "#5f74e0", hot: "#afbbf0", marker: "#e0726c" };

describe("packLines", () => {
    it("emits six position floats and six colour floats per segment", () => {
        const scene = sceneOf();
        const packed = packLines(scene, 112, COLOURS);
        expect(packed.segments).toBe(scene.segments.length);
        expect(packed.positions.length).toBe(scene.segments.length * 6);
        expect(packed.colors.length).toBe(scene.segments.length * 6);
    });

    it("maps screen coordinates into a [-1,1] box with y flipped", () => {
        const scene = sceneOf({ rings: 0, shell: false, nodes: 0 });
        const one: AvatarScene = {
            ...scene,
            segments: [{ ax: 0, ay: 0, bx: 112, by: 112, depth: 0, tone: "body", alpha: 1 }],
            points: [],
        };
        const packed = packLines(one, 112, COLOURS);
        // top-left of the box is (-1, +1); bottom-right is (+1, -1)
        expect(packed.positions[0]).toBeCloseTo(-1);
        expect(packed.positions[1]).toBeCloseTo(1);
        expect(packed.positions[3]).toBeCloseTo(1);
        expect(packed.positions[4]).toBeCloseTo(-1);
    });

    it("premultiplies alpha into the colour, because LineMaterial carries no per-vertex alpha", () => {
        const base = sceneOf({ rings: 0, shell: false, nodes: 0 });
        const seg = { ax: 0, ay: 0, bx: 10, by: 10, depth: 0, tone: "body" as const };
        const full = packLines({ ...base, segments: [{ ...seg, alpha: 1 }], points: [] }, 112, COLOURS);
        const half = packLines({ ...base, segments: [{ ...seg, alpha: 0.5 }], points: [] }, 112, COLOURS);
        expect(half.colors[0]).toBeCloseTo(full.colors[0] / 2);
        expect(half.colors[1]).toBeCloseTo(full.colors[1] / 2);
        expect(half.colors[2]).toBeCloseTo(full.colors[2] / 2);
    });

    it("carries alpha to black at zero, so a severed link contributes no light", () => {
        const base = sceneOf({ rings: 0, shell: false, nodes: 0 });
        const packed = packLines(
            { ...base, segments: [{ ax: 0, ay: 0, bx: 1, by: 1, depth: 0, tone: "body", alpha: 0 }], points: [] },
            112,
            COLOURS
        );
        expect(Array.from(packed.colors)).toEqual(new Array(6).fill(0));
    });

    it("resolves each tone to its own colour", () => {
        const base = sceneOf({ rings: 0, shell: false, nodes: 0 });
        const of = (tone: "body" | "hot" | "marker") =>
            packLines(
                { ...base, segments: [{ ax: 0, ay: 0, bx: 1, by: 1, depth: 0, tone, alpha: 1 }], points: [] },
                112,
                COLOURS
            ).colors.slice(0, 3);
        expect(Array.from(of("body"))).not.toEqual(Array.from(of("hot")));
        expect(Array.from(of("body"))).not.toEqual(Array.from(of("marker")));
    });

    it("packs an empty scene without allocating a malformed buffer", () => {
        const base = sceneOf({ rings: 0, shell: false, nodes: 0 });
        const packed = packLines({ ...base, segments: [], points: [] }, 112, COLOURS);
        expect(packed.segments).toBe(0);
        expect(packed.positions.length).toBe(0);
    });
});

describe("packPoints", () => {
    it("emits one position, one colour and one size per point", () => {
        const scene = sceneOf();
        const packed = packPoints(scene, 112, 1, COLOURS);
        expect(packed.count).toBe(scene.points.length);
        expect(packed.positions.length).toBe(scene.points.length * 3);
        expect(packed.sizes.length).toBe(scene.points.length);
    });

    it("scales point size by device pixel ratio, so a node is the same physical dot at any density", () => {
        const scene = sceneOf();
        const at1 = packPoints(scene, 112, 1, COLOURS);
        const at2 = packPoints(scene, 112, 2, COLOURS);
        expect(at2.sizes[0]).toBeCloseTo(at1.sizes[0] * 2);
    });

    it("premultiplies alpha the same way lines do", () => {
        const base = sceneOf({ rings: 0, shell: false, nodes: 0 });
        const pt = { x: 10, y: 10, depth: 0, tone: "body" as const, size: 2 };
        const full = packPoints({ ...base, segments: [], points: [{ ...pt, alpha: 1 }] }, 112, 1, COLOURS);
        const half = packPoints({ ...base, segments: [], points: [{ ...pt, alpha: 0.5 }] }, 112, 1, COLOURS);
        expect(half.colors[0]).toBeCloseTo(full.colors[0] / 2);
    });
});
