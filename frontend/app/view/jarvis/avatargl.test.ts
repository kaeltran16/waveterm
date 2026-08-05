import { describe, expect, it, vi } from "vitest";
import type { SceneColours } from "./avatarcanvas";
import { AvatarGL, DEFAULT_BLOOM, FLOATS_PER_VERTEX, packScene } from "./avatargl";
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

    it("re-allocates its targets on restore, so a recovered context is not a permanently blank avatar", () => {
        // losing the context drops the render targets, and nothing else calls resize afterwards — the
        // canvas is already the size it was. Without a re-allocation here draw() early-returns forever and
        // the avatar goes blank the moment it switches back off the fallback.
        const { gl, calls } = stubGL();
        const canvas = stubCanvas(gl);
        const r = AvatarGL.create(canvas.el)!;
        r.resize(112);
        canvas.fire("webglcontextlost");
        canvas.fire("webglcontextrestored");
        expect(r.lost).toBe(false);
        const before = calls.length;
        r.draw(sceneOf(), 112, 1, COLOURS, DEFAULT_BLOOM);
        expect(calls.length).toBeGreaterThan(before);
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
