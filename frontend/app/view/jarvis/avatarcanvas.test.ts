import { describe, expect, it, vi } from "vitest";
import { blendTones, drawSceneToCanvas, resolveTone, type SceneColours } from "./avatarcanvas";
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
        ripple: null,
        jolt: 0,
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

describe("blendTones", () => {
    it("returns the endpoints at the ends of the mix", () => {
        expect(blendTones("#000000", "#ffffff", 0)).toBe("#000000");
        expect(blendTones("#000000", "#ffffff", 1)).toBe("#ffffff");
    });

    it("interpolates each channel independently", () => {
        expect(blendTones("#000000", "#ffffff", 0.5)).toBe("#808080");
        expect(blendTones("#ff0000", "#0000ff", 0.5)).toBe("#800080");
    });

    it("returns hex, because the hot tone is derived from whatever this produces", () => {
        // lighten() parses hex only. An rgb() string here would silently flatten the pulse head and the
        // major ticks into the body tone for the length of every register transition.
        expect(blendTones("#e0726c", "#5e9cff", 0.4)).toMatch(/^#[0-9a-f]{6}$/);
    });

    it("expands three-digit hex", () => {
        expect(blendTones("#000", "#fff", 1)).toBe("#ffffff");
    });

    it("snaps at the halfway point rather than blending something it cannot parse", () => {
        expect(blendTones("not-a-colour", "#ffffff", 0.2)).toBe("not-a-colour");
        expect(blendTones("not-a-colour", "#ffffff", 0.8)).toBe("#ffffff");
    });

    it("clamps a mix outside 0..1 and treats a non-finite one as finished", () => {
        expect(blendTones("#000000", "#ffffff", -2)).toBe("#000000");
        expect(blendTones("#000000", "#ffffff", 5)).toBe("#ffffff");
        expect(blendTones("#000000", "#ffffff", Number.NaN)).toBe("#ffffff");
    });
});

describe("resolveTone — crossfade", () => {
    it("blends the two tones while a register change is in flight", () => {
        const read = (name: string) => (name === "--color-a" ? "#000000" : "#ffffff");
        const settled = { ...sceneOf(), toneVar: "--color-b", toneFromVar: null, toneMix: 1 };
        expect(resolveTone(settled, read).body).toBe("#ffffff");

        const midway = { ...sceneOf(), toneVar: "--color-b", toneFromVar: "--color-a", toneMix: 0.5 };
        expect(resolveTone(midway, read).body).toBe("#808080");
    });

    it("still lightens the hot tone mid-crossfade", () => {
        const read = () => "#000000";
        const midway = { ...sceneOf(), toneVar: "--color-b", toneFromVar: "--color-a", toneMix: 0.5 };
        const colours = resolveTone(midway, read);
        expect(colours.hot).not.toBe(colours.body);
    });
});
