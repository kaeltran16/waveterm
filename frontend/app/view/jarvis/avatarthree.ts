// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The avatar's three.js renderer. Second consumer of avatarscene.ts, and the reason the scene builder was
// kept pure: the form did not change to get here.
//
// It exists for one reason. The hand-rolled renderer this replaced drew with gl.lineWidth(1), which every
// modern WebGL implementation clamps to 1.0 — so at 2x DPR the entire avatar was drawn in half-CSS-pixel
// hairlines. three's LineSegments2 expands each segment into an instanced quad, so line width is real and
// specified in pixels. That is the whole point; everything else here is in service of it.
//
// What this deliberately does NOT do is re-project. avatarscene.ts already emits screen-space x/y with depth
// folded into alpha, so the camera is orthographic over that same space. Putting a perspective camera here
// would apply a second projection on top of the scene builder's own.

import {
    AdditiveBlending,
    BufferAttribute,
    BufferGeometry,
    Color,
    DoubleSide,
    Mesh,
    MeshBasicMaterial,
    OrthographicCamera,
    Scene,
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
import { STROKE_WIDTHS, type AvatarScene, type SceneFill, type SceneSegment, type SceneTone } from "./avatarscene";

export interface ThreeBloomSettings {
    strength: number;
    threshold: number;
    radius: number;
}

// The prototype's numbers at this size, and they have to be: the old settings (strength 1.8, threshold
// 0.05) were tuned for a form of ~890 faint hairlines, where a low threshold and a strong lift were what
// made the thing visible at all. This form is heavier line work over additive fills, and under that bloom
// every register blew out into a featureless blob — the exact failure the new form exists to fix.
// Threshold now sits above the dim body line work so only the lit core, the front arcs and the marker
// rim bloom, which is what gives the form its depth instead of erasing it.
// Radius is kept short for the same reason SPHERE_FRACTION leaves margin: a blur whose tail reaches the
// framebuffer border clamps there, and the clamp is a visible soft-edged square around the avatar.
export const DEFAULT_THREE_BLOOM: ThreeBloomSettings = { strength: 0.35, threshold: 0.4, radius: 0.2 };

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

function picker(colours: SceneColours): (tone: SceneTone) => [number, number, number] {
    const body = channels(colours.body);
    const hot = channels(colours.hot);
    const marker = colours.marker == null ? body : channels(colours.marker);
    return (tone) => (tone === "hot" ? hot : tone === "marker" ? marker : body);
}

export interface PackedLines {
    positions: Float32Array;
    colors: Float32Array;
    segments: number;
}

/**
 * Segments -> flat position/colour arrays for LineSegmentsGeometry.
 *
 * Takes a segment list rather than the whole scene because line width is a material uniform in three's
 * fat-line implementation: the renderer draws the scene as one batch per stroke weight, and each batch
 * packs its own slice.
 *
 * Alpha is premultiplied into the colour rather than carried separately, because LineMaterial's vertex
 * colours are rgb-only. Under additive blending that is not an approximation — a segment contributes
 * `colour * alpha` to the framebuffer either way — which is why the renderer can stay additive and still
 * reproduce the depth falloff the scene builder folded into alpha.
 */
export function packLines(segments: readonly SceneSegment[], size: number, colours: SceneColours): PackedLines {
    const count = segments.length;
    const positions = new Float32Array(count * 6);
    const colors = new Float32Array(count * 6);
    const pick = picker(colours);

    // same mapping the old renderer used: screen pixels to a [-1,1] box, y flipped because screen y runs down
    const nx = (x: number) => (x / size) * 2 - 1;
    const ny = (y: number) => 1 - (y / size) * 2;

    for (let i = 0; i < count; i++) {
        const s = segments[i];
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

export interface PackedFills {
    positions: Float32Array;
    colors: Float32Array;
    triangles: number;
}

/**
 * Fills -> a flat triangle soup, fanned from each polygon's first vertex.
 *
 * One un-indexed mesh rather than one per fill: the form emits on the order of 150 quads a frame and a
 * draw call each would cost more than the geometry does. Same premultiplied-alpha contract as packLines,
 * for the same reason — these composite additively over the line work.
 */
export function packFills(fills: readonly SceneFill[], size: number, colours: SceneColours): PackedFills {
    const pick = picker(colours);
    let triangles = 0;
    for (const f of fills) {
        triangles += Math.max(0, f.points.length - 2);
    }
    const positions = new Float32Array(triangles * 9);
    const colors = new Float32Array(triangles * 9);

    const nx = (x: number) => (x / size) * 2 - 1;
    const ny = (y: number) => 1 - (y / size) * 2;

    let at = 0;
    for (const f of fills) {
        const rgb = pick(f.tone);
        const a = Math.max(0, Math.min(1, f.alpha));
        for (let i = 1; i + 1 < f.points.length; i++) {
            for (const v of [f.points[0], f.points[i], f.points[i + 1]]) {
                positions[at] = nx(v[0]);
                positions[at + 1] = ny(v[1]);
                positions[at + 2] = 0;
                colors[at] = rgb[0] * a;
                colors[at + 1] = rgb[1] * a;
                colors[at + 2] = rgb[2] * a;
                at += 3;
            }
        }
    }
    return { positions, colors, triangles };
}

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
    // far under the faintest real line so geometry is not clipped.
    gl_FragColor = vec4(c.rgb, clamp((l - 0.008) / (1.0 - 0.008), 0.0, 1.0));
}`,
};

export interface AvatarThreeOptions {
    onLost?: () => void;
    onRestored?: () => void;
}

/** One draw batch: every segment in the scene that shares a stroke weight. */
interface LineBatch {
    width: number;
    material: LineMaterial;
    lines: LineSegments2;
    geometry: LineSegmentsGeometry;
}

export class AvatarThree {
    private renderer: WebGLRenderer;
    private canvas: HTMLCanvasElement;
    private options: AvatarThreeOptions;
    private scene = new Scene();
    // the packed scene already lives in a [-1,1] box, so the camera is exactly that box
    private camera = new OrthographicCamera(-1, 1, 1, -1, -10, 10);
    private batches: LineBatch[];
    private fillGeometry = new BufferGeometry();
    private fillMaterial: MeshBasicMaterial;
    private fillMesh: Mesh;
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

        // One batch per stroke weight, built once. The scene's widths come from a fixed ladder precisely so
        // this list is short and static — a per-primitive width would mean a draw call per primitive.
        this.batches = STROKE_WIDTHS.map((width) => {
            const material = new LineMaterial({
                vertexColors: true,
                // pixels, not world units — the reason this renderer exists
                worldUnits: false,
                linewidth: width,
                transparent: true,
                blending: AdditiveBlending,
                // additive summing is order-independent, so depth sorting would only cost work and drop overlaps
                depthTest: false,
                depthWrite: false,
            });
            const geometry = new LineSegmentsGeometry();
            const lines = new LineSegments2(geometry, material);
            // the form is rebuilt every frame and its bounds are the camera box anyway; culling it can only
            // ever throw the whole avatar away on a stale bounding sphere
            lines.frustumCulled = false;
            this.scene.add(lines);
            return { width, material, lines, geometry };
        });

        this.fillMaterial = new MeshBasicMaterial({
            vertexColors: true,
            transparent: true,
            blending: AdditiveBlending,
            depthTest: false,
            depthWrite: false,
            // the projected quads can wind either way once a plane tilts past edge-on
            side: DoubleSide,
        });
        this.fillMesh = new Mesh(this.fillGeometry, this.fillMaterial);
        this.fillMesh.frustumCulled = false;
        // rendered under the line work: the fills are what the strokes sit on, not what covers them
        this.fillMesh.renderOrder = -1;
        this.scene.add(this.fillMesh);

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

    /** Mirrors the fallback's liveness flag, so petview keeps one renderer check for both. */
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
        for (const batch of this.batches) {
            batch.material.resolution.set(pixels, pixels);
        }
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

    draw(scene: AvatarScene, size: number, dpr: number, colours: SceneColours, bloom: ThreeBloomSettings): void {
        if (this.isLost || this.composer == null) {
            return;
        }

        for (const batch of this.batches) {
            const slice = scene.segments.filter((s) => s.width === batch.width);
            batch.lines.visible = slice.length > 0;
            // LineMaterial's width is in the resolution's units, and three sets that resolution to the
            // drawing buffer on every render — so the scene's CSS-pixel weights have to be scaled here or a
            // 2x display would draw the whole form at half the intended weight.
            batch.material.linewidth = batch.width * (dpr > 0 ? dpr : 1);
            if (slice.length === 0) {
                continue;
            }
            const packed = packLines(slice, size, colours);
            // a fresh geometry per frame rather than a resized attribute: LineSegmentsGeometry builds
            // instanced interleaved buffers, and the segment count changes with sever and stutter
            const next = new LineSegmentsGeometry();
            next.setPositions(packed.positions);
            next.setColors(packed.colors);
            batch.geometry.dispose();
            batch.geometry = next;
            batch.lines.geometry = next;
        }

        const fills = packFills(scene.fills, size, colours);
        this.fillMesh.visible = fills.triangles > 0;
        if (fills.triangles > 0) {
            const nextFill = new BufferGeometry();
            nextFill.setAttribute("position", new BufferAttribute(fills.positions, 3));
            nextFill.setAttribute("color", new BufferAttribute(fills.colors, 3));
            this.fillGeometry.dispose();
            this.fillGeometry = nextFill;
            this.fillMesh.geometry = nextFill;
        }

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
        for (const batch of this.batches) {
            batch.geometry.dispose();
            batch.material.dispose();
        }
        this.fillGeometry.dispose();
        this.fillMaterial.dispose();
        this.composer?.dispose();
        this.renderer.dispose();
    }
}
