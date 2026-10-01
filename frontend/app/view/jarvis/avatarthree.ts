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
    type InterleavedBuffer,
    type InterleavedBufferAttribute,
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

export type TonePicker = (tone: SceneTone) => [number, number, number];

/** Parses the scene colours once into a tone -> rgb lookup; the renderer keeps it until the colours change. */
export function picker(colours: SceneColours): TonePicker {
    const body = channels(colours.body);
    const hot = channels(colours.hot);
    const marker = colours.marker == null ? body : channels(colours.marker);
    return (tone) => (tone === "hot" ? hot : tone === "marker" ? marker : body);
}

// The renderer draws at display rate, so its buffers live across frames rather than being reallocated and
// re-created on the GPU every frame (that churn was most of the frame's cost). A buffer that is outgrown is
// replaced with headroom, so a segment count that wobbles with the stutter does not reallocate each frame.
const MIN_CAPACITY = 64;
const CAPACITY_GROWTH = 2;

export function growCapacity(needed: number, current: number): number {
    if (current > 0 && needed <= current) {
        return current;
    }
    return Math.max(MIN_CAPACITY, Math.ceil(needed * CAPACITY_GROWTH));
}

export interface PackedLines {
    positions: Float32Array;
    colors: Float32Array;
    segments: number;
}

/**
 * Segments -> flat position/colour floats for LineSegmentsGeometry, written into the caller's arrays from
 * index 0; returns the segment count. The arrays must hold at least six floats per segment.
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
export function packLinesInto(
    segments: readonly SceneSegment[],
    size: number,
    pick: TonePicker,
    positions: Float32Array,
    colors: Float32Array
): number {
    // same mapping the old renderer used: screen pixels to a [-1,1] box, y flipped because screen y runs down
    const nx = (x: number) => (x / size) * 2 - 1;
    const ny = (y: number) => 1 - (y / size) * 2;

    const count = segments.length;
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
        colors[p] = colors[p + 3] = rgb[0] * a;
        colors[p + 1] = colors[p + 4] = rgb[1] * a;
        colors[p + 2] = colors[p + 5] = rgb[2] * a;
    }
    return count;
}

export function packLines(segments: readonly SceneSegment[], size: number, colours: SceneColours): PackedLines {
    const positions = new Float32Array(segments.length * 6);
    const colors = new Float32Array(segments.length * 6);
    const count = packLinesInto(segments, size, picker(colours), positions, colors);
    return { positions, colors, segments: count };
}

export interface PackedFills {
    positions: Float32Array;
    colors: Float32Array;
    triangles: number;
}

export function fillTriangles(fills: readonly SceneFill[]): number {
    let triangles = 0;
    for (const f of fills) {
        triangles += Math.max(0, f.points.length - 2);
    }
    return triangles;
}

/**
 * Fills -> a flat triangle soup, fanned from each polygon's first vertex, written into the caller's arrays
 * (nine floats per triangle, sized from fillTriangles); returns the triangle count.
 *
 * One un-indexed mesh rather than one per fill: the form emits on the order of 150 quads a frame and a
 * draw call each would cost more than the geometry does. Same premultiplied-alpha contract as packLines,
 * for the same reason — these composite additively over the line work.
 */
export function packFillsInto(
    fills: readonly SceneFill[],
    size: number,
    pick: TonePicker,
    positions: Float32Array,
    colors: Float32Array
): number {
    const nx = (x: number) => (x / size) * 2 - 1;
    const ny = (y: number) => 1 - (y / size) * 2;

    let at = 0;
    const vertex = (v: readonly number[], rgb: [number, number, number], a: number) => {
        positions[at] = nx(v[0]);
        positions[at + 1] = ny(v[1]);
        positions[at + 2] = 0;
        colors[at] = rgb[0] * a;
        colors[at + 1] = rgb[1] * a;
        colors[at + 2] = rgb[2] * a;
        at += 3;
    };
    for (const f of fills) {
        const rgb = pick(f.tone);
        const a = Math.max(0, Math.min(1, f.alpha));
        for (let i = 1; i + 1 < f.points.length; i++) {
            vertex(f.points[0], rgb, a);
            vertex(f.points[i], rgb, a);
            vertex(f.points[i + 1], rgb, a);
        }
    }
    return at / 9;
}

export function packFills(fills: readonly SceneFill[], size: number, colours: SceneColours): PackedFills {
    const triangles = fillTriangles(fills);
    const positions = new Float32Array(triangles * 9);
    const colors = new Float32Array(triangles * 9);
    packFillsInto(fills, size, picker(colours), positions, colors);
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
    /** segments the geometry's buffers hold */
    capacity: number;
}

function makeLineGeometry(capacity: number): LineSegmentsGeometry {
    const geometry = new LineSegmentsGeometry();
    geometry.setPositions(new Float32Array(capacity * 6));
    geometry.setColors(new Float32Array(capacity * 6));
    return geometry;
}

function makeFillGeometry(triangles: number): BufferGeometry {
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new BufferAttribute(new Float32Array(triangles * 9), 3));
    geometry.setAttribute("color", new BufferAttribute(new Float32Array(triangles * 9), 3));
    return geometry;
}

// LineSegmentsGeometry keeps each attribute in one interleaved buffer (start and end of a segment share it)
function interleaved(geometry: LineSegmentsGeometry, name: string): InterleavedBuffer {
    return (geometry.getAttribute(name) as InterleavedBufferAttribute).data;
}

/** Uploads only the floats this frame wrote, rather than the buffer's whole capacity. */
function upload(buffer: InterleavedBuffer | BufferAttribute, floats: number): void {
    buffer.clearUpdateRanges();
    buffer.addUpdateRange(0, floats);
    buffer.needsUpdate = true;
}

export class AvatarThree {
    private renderer: WebGLRenderer;
    private canvas: HTMLCanvasElement;
    private options: AvatarThreeOptions;
    private scene = new Scene();
    // the packed scene already lives in a [-1,1] box, so the camera is exactly that box
    private camera = new OrthographicCamera(-1, 1, 1, -1, -10, 10);
    private batches: LineBatch[];
    private fillCapacity = growCapacity(0, 0);
    private fillGeometry = makeFillGeometry(this.fillCapacity);
    private fillMaterial: MeshBasicMaterial;
    // the parsed colours, kept until the theme or the mood's tone actually changes
    private pickKey = "";
    private pick: TonePicker | null = null;
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
            const capacity = growCapacity(0, 0);
            const geometry = makeLineGeometry(capacity);
            const lines = new LineSegments2(geometry, material);
            // the form is rebuilt every frame and its bounds are the camera box anyway; culling it can only
            // ever throw the whole avatar away on a stale bounding sphere
            lines.frustumCulled = false;
            this.scene.add(lines);
            return { width, material, lines, geometry, capacity };
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

        const pickKey = colours.body + "|" + colours.hot + "|" + colours.marker;
        if (this.pick == null || pickKey !== this.pickKey) {
            this.pick = picker(colours);
            this.pickKey = pickKey;
        }
        const pick = this.pick;

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
            // the segment count changes with stutter, so the buffers are sized with headroom and the draw
            // is limited to this frame's count rather than the buffer's
            const capacity = growCapacity(slice.length, batch.capacity);
            if (capacity !== batch.capacity) {
                const next = makeLineGeometry(capacity);
                batch.geometry.dispose();
                batch.geometry = next;
                batch.lines.geometry = next;
                batch.capacity = capacity;
            }
            const positions = interleaved(batch.geometry, "instanceStart");
            const colors = interleaved(batch.geometry, "instanceColorStart");
            const count = packLinesInto(
                slice,
                size,
                pick,
                positions.array as Float32Array,
                colors.array as Float32Array
            );
            upload(positions, count * 6);
            upload(colors, count * 6);
            batch.geometry.instanceCount = count;
        }

        const triangles = fillTriangles(scene.fills);
        this.fillMesh.visible = triangles > 0;
        if (triangles > 0) {
            const capacity = growCapacity(triangles, this.fillCapacity);
            if (capacity !== this.fillCapacity) {
                const next = makeFillGeometry(capacity);
                this.fillGeometry.dispose();
                this.fillGeometry = next;
                this.fillMesh.geometry = next;
                this.fillCapacity = capacity;
            }
            const positions = this.fillGeometry.getAttribute("position") as BufferAttribute;
            const colors = this.fillGeometry.getAttribute("color") as BufferAttribute;
            packFillsInto(scene.fills, size, pick, positions.array as Float32Array, colors.array as Float32Array);
            upload(positions, triangles * 9);
            upload(colors, triangles * 9);
            this.fillGeometry.setDrawRange(0, triangles * 3);
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
