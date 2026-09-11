// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The avatar's three.js renderer. Third consumer of avatarscene.ts, and the reason the scene builder was
// kept pure: the form did not change to get here.
//
// It exists for one reason. The hand-rolled renderer in avatargl.ts draws with gl.lineWidth(1), which every
// modern WebGL implementation clamps to 1.0 — so at 2x DPR the entire avatar was drawn in half-CSS-pixel
// hairlines, and ~890 segments inside a 46px form summed into a scribble rather than a hologram. three's
// LineSegments2 expands each segment into an instanced quad, so line width is real and specified in pixels.
// That is the whole point; everything else here is in service of it.
//
// What this deliberately does NOT do is re-project. avatarscene.ts already emits screen-space x/y with depth
// folded into alpha, so the camera is orthographic over that same space. Putting a perspective camera here
// would apply a second projection on top of the scene builder's own.

import {
    AdditiveBlending,
    BufferAttribute,
    BufferGeometry,
    Color,
    OrthographicCamera,
    Points,
    Scene,
    ShaderMaterial,
    Vector2,
    WebGLRenderer,
} from "three";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import type { SceneColours } from "./avatarcanvas";
import type { AvatarScene, SceneTone } from "./avatarscene";

export interface ThreeBloomSettings {
    strength: number;
    threshold: number;
    radius: number;
}

// Not the same numbers as avatargl's DEFAULT_BLOOM. That bloom was a hand-rolled two-pass blur whose
// strength was an arbitrary multiplier; UnrealBloomPass strength is a physical-ish gain on the thresholded
// bright pass, and 4.4 there is a white-out.
// Threshold is deliberately low. The two registers that report a fault (drifting, cannot-see) are the two
// that render faintest, and a bloom that only lifts bright pixels lifts everything EXCEPT them — which is
// the same contrast collapse the mood table was already fixed for once.
// Radius is kept short for the same reason SPHERE_FRACTION leaves margin: a blur whose tail reaches the
// framebuffer border clamps there, and the clamp is a visible soft-edged square around the avatar.
export const DEFAULT_THREE_BLOOM: ThreeBloomSettings = { strength: 1.8, threshold: 0.05, radius: 0.4 };

// Stroke width in CSS pixels. The value the whole port exists to be able to set above 1.
export const LINE_WIDTH_PX = 1.0;

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

export interface PackedLines {
    positions: Float32Array;
    colors: Float32Array;
    segments: number;
}

/**
 * Scene -> flat position/colour arrays for LineSegmentsGeometry.
 *
 * Alpha is premultiplied into the colour rather than carried separately, because LineMaterial's vertex
 * colours are rgb-only. Under additive blending that is not an approximation — a segment contributes
 * `colour * alpha` to the framebuffer either way — which is why the renderer can stay additive and still
 * reproduce the depth falloff the scene builder folded into alpha.
 *
 * Exported and pure so the packing is testable without a GL context, the same way packScene is.
 */
export function packLines(scene: AvatarScene, size: number, colours: SceneColours): PackedLines {
    const count = scene.segments.length;
    const positions = new Float32Array(count * 6);
    const colors = new Float32Array(count * 6);

    const body = channels(colours.body);
    const hot = channels(colours.hot);
    const marker = colours.marker == null ? body : channels(colours.marker);
    const pick = (tone: SceneTone) => (tone === "hot" ? hot : tone === "marker" ? marker : body);

    // same mapping avatargl uses: screen pixels to a [-1,1] box, y flipped because screen y runs down
    const nx = (x: number) => (x / size) * 2 - 1;
    const ny = (y: number) => 1 - (y / size) * 2;

    for (let i = 0; i < count; i++) {
        const s = scene.segments[i];
        const rgb = pick(s.tone);
        const a = Math.max(0, Math.min(1, s.alpha));
        const p = i * 6;
        positions[p] = nx(s.ax);
        positions[p + 1] = ny(s.ay);
        positions[p + 2] = 0;
        positions[p + 3] = nx(s.bx);
        positions[p + 4] = ny(s.by);
        positions[p + 5] = 0;
        for (const v of [p, p + 3]) {
            colors[v] = rgb[0] * a;
            colors[v + 1] = rgb[1] * a;
            colors[v + 2] = rgb[2] * a;
        }
    }
    return { positions, colors, segments: count };
}

export interface PackedPoints {
    positions: Float32Array;
    colors: Float32Array;
    sizes: Float32Array;
    count: number;
}

/** Same premultiplied-alpha contract as packLines, plus the per-point size the node dots vary by. */
export function packPoints(scene: AvatarScene, size: number, dpr: number, colours: SceneColours): PackedPoints {
    const count = scene.points.length;
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const sizes = new Float32Array(count);

    const body = channels(colours.body);
    const hot = channels(colours.hot);
    const marker = colours.marker == null ? body : channels(colours.marker);
    const pick = (tone: SceneTone) => (tone === "hot" ? hot : tone === "marker" ? marker : body);

    for (let i = 0; i < count; i++) {
        const pt = scene.points[i];
        const rgb = pick(pt.tone);
        const a = Math.max(0, Math.min(1, pt.alpha));
        positions[i * 3] = (pt.x / size) * 2 - 1;
        positions[i * 3 + 1] = 1 - (pt.y / size) * 2;
        positions[i * 3 + 2] = 0;
        colors[i * 3] = rgb[0] * a;
        colors[i * 3 + 1] = rgb[1] * a;
        colors[i * 3 + 2] = rgb[2] * a;
        sizes[i] = pt.size * dpr;
    }
    return { positions, colors, sizes, count };
}

// PointsMaterial carries one size for the whole cloud, and the node dots vary per point, so the shader is
// the smallest thing that keeps them. Round rather than square: a squared-off node reads as a glitch.
const POINT_VERTEX = `
attribute float size;
varying vec3 vColor;
void main() {
    vColor = color;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = size;
}`;

const POINT_FRAGMENT = `
varying vec3 vColor;
void main() {
    // the squared smoothstep is the falloff the old renderer used: a hard-edged disc reads as a
    // cluster of pinpricks at this size, where the soft one reads as a lit node
    float d = length(gl_PointCoord - vec2(0.5)) * 2.0;
    float a = smoothstep(1.0, 0.0, d);
    a *= a;
    gl_FragColor = vec4(vColor * a, 1.0);
}`;

// The avatar is a glow over the app background, but UnrealBloomPass composites with a hardcoded alpha of
// 1.0, which turns the whole canvas into an opaque box the size of the avatar. This final pass puts the
// alpha back by deriving it from how bright the pixel is: unlit background goes fully transparent, and the
// form keeps its own falloff. Brightness rather than a fixed value because the edges of the bloom have to
// fade out, not cut off.
//
// The canvas is created with premultipliedAlpha: false precisely so this pass can hand back straight rgb
// plus a separate alpha. With premultiplication on, full-brightness rgb carrying a near-zero alpha still
// adds its light to the page, which is what put a faint square around the avatar.
const AlphaFromLuminance = {
    uniforms: { tDiffuse: { value: null as unknown } },
    vertexShader: `
varying vec2 vUv;
void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`,
    fragmentShader: `
uniform sampler2D tDiffuse;
varying vec2 vUv;
void main() {
    vec4 c = texture2D(tDiffuse, vUv);
    float l = max(max(c.r, c.g), c.b);
    // the floor is the bloom's own wash: a wide blur spreads a little energy over every pixel, which
    // without it gives the whole canvas a slight alpha and puts a visible box around the avatar. Kept
    // far under the faintest real line (drifting's shell arcs sit near 0.05) so geometry is not clipped.
    gl_FragColor = vec4(c.rgb, clamp((l - 0.008) / (1.0 - 0.008), 0.0, 1.0));
}`,
};

export interface AvatarThreeOptions {
    onLost?: () => void;
    onRestored?: () => void;
}

export class AvatarThree {
    private renderer: WebGLRenderer;
    private canvas: HTMLCanvasElement;
    private options: AvatarThreeOptions;
    private scene = new Scene();
    // the packed scene already lives in a [-1,1] box, so the camera is exactly that box
    private camera = new OrthographicCamera(-1, 1, 1, -1, -10, 10);
    private geometry = new LineSegmentsGeometry();
    private material: LineMaterial;
    private lines: LineSegments2;
    private pointGeometry = new BufferGeometry();
    private pointMaterial: ShaderMaterial;
    private pointCloud: Points;
    private composer: EffectComposer | null = null;
    private bloomPass: UnrealBloomPass | null = null;
    private isLost = false;
    private lastPixels = 0;
    private onContextLost: EventListener;
    private onContextRestored: EventListener;

    private constructor(canvas: HTMLCanvasElement, renderer: WebGLRenderer, options: AvatarThreeOptions) {
        this.canvas = canvas;
        this.renderer = renderer;
        this.options = options;

        this.material = new LineMaterial({
            vertexColors: true,
            // pixels, not world units — the reason this renderer exists
            worldUnits: false,
            linewidth: LINE_WIDTH_PX,
            transparent: true,
            blending: AdditiveBlending,
            // additive summing is order-independent, so depth sorting would only cost work and drop overlaps
            depthTest: false,
            depthWrite: false,
        });
        this.lines = new LineSegments2(this.geometry, this.material);
        // the form is rebuilt every frame and its bounds are the camera box anyway; culling it can only
        // ever throw the whole avatar away on a stale bounding sphere
        this.lines.frustumCulled = false;
        this.scene.add(this.lines);

        this.pointMaterial = new ShaderMaterial({
            vertexShader: POINT_VERTEX,
            fragmentShader: POINT_FRAGMENT,
            vertexColors: true,
            transparent: true,
            blending: AdditiveBlending,
            depthTest: false,
            depthWrite: false,
        });
        this.pointCloud = new Points(this.pointGeometry, this.pointMaterial);
        this.pointCloud.frustumCulled = false;
        this.scene.add(this.pointCloud);

        this.onContextLost = (ev: Event) => {
            ev.preventDefault();
            this.isLost = true;
            this.options.onLost?.();
        };
        this.onContextRestored = () => {
            this.isLost = false;
            if (this.lastPixels > 0) {
                this.resize(this.lastPixels);
            }
            this.options.onRestored?.();
        };
        canvas.addEventListener("webglcontextlost", this.onContextLost);
        canvas.addEventListener("webglcontextrestored", this.onContextRestored);
    }

    /** Returns null when WebGL is unavailable, so the caller can fall back to the 2D renderer. */
    static create(canvas: HTMLCanvasElement, options: AvatarThreeOptions = {}): AvatarThree | null {
        let renderer: WebGLRenderer;
        try {
            renderer = new WebGLRenderer({ canvas, alpha: true, antialias: true, premultipliedAlpha: false });
        } catch {
            return null;
        }
        // the avatar composites over the app background, so the canvas must clear to nothing, not to black
        renderer.setClearColor(new Color(0x000000), 0);
        return new AvatarThree(canvas, renderer, options);
    }

    /** Mirrors AvatarGL.lost so petview can keep one renderer-liveness check for both. */
    get lost(): boolean {
        return this.isLost;
    }

    resize(pixels: number): void {
        this.lastPixels = pixels;
        if (this.isLost || !(pixels > 0)) {
            return;
        }
        // the canvas is already sized by the caller; setSize must not write style back onto it
        this.renderer.setSize(pixels, pixels, false);
        this.material.resolution.set(pixels, pixels);
        if (this.composer == null) {
            this.composer = new EffectComposer(this.renderer);
            this.composer.addPass(new RenderPass(this.scene, this.camera));
            const bloom = new UnrealBloomPass(
                new Vector2(pixels, pixels),
                DEFAULT_THREE_BLOOM.strength,
                DEFAULT_THREE_BLOOM.radius,
                DEFAULT_THREE_BLOOM.threshold
            );
            this.composer.addPass(bloom);
            this.bloomPass = bloom;
            this.composer.addPass(new ShaderPass(AlphaFromLuminance));
        }
        this.composer.setSize(pixels, pixels);
        this.bloomPass?.resolution.set(pixels, pixels);
    }

    draw(scene: AvatarScene, size: number, _dpr: number, colours: SceneColours, bloom: ThreeBloomSettings): void {
        if (this.isLost || this.composer == null) {
            return;
        }
        const packed = packLines(scene, size, colours);
        if (packed.segments === 0) {
            this.renderer.clear();
            return;
        }
        // a fresh geometry per frame rather than a resized attribute: LineSegmentsGeometry builds instanced
        // interleaved buffers, and the segment count changes with sever/ring count between frames
        const next = new LineSegmentsGeometry();
        next.setPositions(packed.positions);
        next.setColors(packed.colors);
        this.geometry.dispose();
        this.geometry = next;
        this.lines.geometry = next;

        const pts = packPoints(scene, size, _dpr, colours);
        const nextPoints = new BufferGeometry();
        nextPoints.setAttribute("position", new BufferAttribute(pts.positions, 3));
        nextPoints.setAttribute("color", new BufferAttribute(pts.colors, 3));
        nextPoints.setAttribute("size", new BufferAttribute(pts.sizes, 1));
        this.pointGeometry.dispose();
        this.pointGeometry = nextPoints;
        this.pointCloud.geometry = nextPoints;

        if (this.bloomPass != null) {
            this.bloomPass.strength = bloom.strength;
            this.bloomPass.threshold = bloom.threshold;
            this.bloomPass.radius = bloom.radius;
        }
        this.composer.render();
    }

    dispose(): void {
        this.canvas.removeEventListener("webglcontextlost", this.onContextLost);
        this.canvas.removeEventListener("webglcontextrestored", this.onContextRestored);
        this.geometry.dispose();
        this.material.dispose();
        this.pointGeometry.dispose();
        this.pointMaterial.dispose();
        this.composer?.dispose();
        this.renderer.dispose();
    }
}
