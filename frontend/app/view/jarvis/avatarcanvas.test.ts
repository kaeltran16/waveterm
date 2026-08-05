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
        expect(ctx.arc as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(scene.points.length);
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
