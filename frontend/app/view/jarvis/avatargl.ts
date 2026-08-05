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

    return { data, lineVertices: scene.segments.length * 2, pointVertices: scene.points.length };
}

export interface BloomSettings {
    strength: number;
    threshold: number;
    radius: number;
}

/**
 * Tuned against the live dev app over the Chrome DevTools Protocol, judged on a contact sheet of all four
 * expressions in both renderers rather than on the one condition the dev machine happened to be in.
 *
 * `threshold` is the load-bearing one and it is not a taste setting. The scene's primitives run from about
 * 0.02 (shell arcs when alignment is low) to about 0.5 (major ticks, pulse head). At 0 everything blooms,
 * and blurring that broad faint floor across a small half-resolution target lifts the WHOLE canvas — the
 * avatar wore a visible lighter square. At 0.09 only the ticks, links and points bleed and the shell does
 * not, so the glow hugs the geometry and reads as light coming off it. Raise it and the form goes flat;
 * drop it and the square returns.
 *
 * `strength` then buys back the brightness the threshold cost. Much past 4 the 8-bit render targets start
 * showing their quantisation as banding in the falloff, so 4.4 sits deliberately just over that line — it
 * was raised from 3.6 because the form read as too faint against the panel it sits on, accepting whatever
 * banding that costs as the better trade at this size.
 */
export const DEFAULT_BLOOM: BloomSettings = { strength: 4.4, threshold: 0.09, radius: 1.5 };

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
    // annotated rather than inferred: the initialiser would narrow this to Float32Array<ArrayBuffer>, which
    // packScene's Float32Array<ArrayBufferLike> result is not assignable to
    private scratch: Float32Array = new Float32Array(0);
    private isLost = false;
    // the last size resize() was asked for, so a restored context can rebuild its targets itself
    private lastPixels = 0;
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
            // The targets went with the context, and nothing outside will ask for them back: the canvas is
            // still exactly the size it was, so the caller's size-changed check never fires. Rebuilding
            // them here is the difference between coming back and drawing nothing forever.
            if (this.lastPixels > 0) {
                this.resize(this.lastPixels);
            }
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
            // The whole chain is premultiplied — the primitive shaders emit vec4(colour * alpha, alpha) and
            // accumulate under blendFunc(ONE, ONE). Declaring false here would make the page compositor
            // multiply by alpha a SECOND time, which is what made the first live render nearly invisible
            // while the canvas fallback, drawing the identical scene, read correctly.
            premultipliedAlpha: true,
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
        this.lastPixels = px;
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
