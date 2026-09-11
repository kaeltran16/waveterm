// The avatar form these studies share: study 02's holographic depth, as geometry only.
//
// Two pages draw it — jarvis-hud-behavior.js (study 03, how it should move) and jarvis-hud-states.js
// (study 04, every production state) — and a third copy of a 200-line form builder is how two studies
// start disagreeing about what the avatar is. Everything here is construction; nothing animates. The
// pages own their own clocks, because they are asking different questions of the same object.
//
// Standalone exploration: no production signals, state writes, or avatar changes.

import * as THREE from "three";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";

// bloom replaces alpha; restore it as the production avatar does to avoid a rectangular glow.
const alphaFromLight = {
    uniforms: { tDiffuse: { value: null } },
    vertexShader: `varying vec2 vUv;
        void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `uniform sampler2D tDiffuse; varying vec2 vUv;
        void main() {
            vec3 c = texture2D(tDiffuse, vUv).rgb;
            float light = max(max(c.r, c.g), c.b);
            gl_FragColor = vec4(c, clamp((light - 0.008) / 0.992, 0.0, 1.0));
        }`,
};

export const TAU = Math.PI * 2;
export const DPR = Math.min(devicePixelRatio, 1.5);
export const FRAME_MS = 1000 / 30;
export const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

const rootStyle = getComputedStyle(document.documentElement);
export const token = (name) => new THREE.Color(rootStyle.getPropertyValue(`--color-${name}`).trim());

export const colours = {
    blue: token("conn-1"),
    blueHot: token("accent-100"),
    attention: token("warning"),
};

// ── material registry ─────────────────────────────────────────────────────────
// Every primitive of the form registers with whatever sinks are open while it is built, remembering the
// opacity it was authored at and whether it is body or highlight line work. That is what lets a caller
// dim the whole form behind a marker, or recolour it for a register, without the form knowing either
// idea exists.

const sinks = [];
let markerDepth = 0;

function track(material, opacity, role) {
    if (markerDepth > 0) {
        return material;
    }
    for (const sink of sinks) {
        sink.push({ material, base: opacity, role });
    }
    return material;
}

/** Collect every primitive built inside `build` into `list`. Nests: inner and outer sinks both fill. */
export function withSink(list, build) {
    sinks.push(list);
    try {
        return build();
    } finally {
        sinks.pop();
    }
}

/** Primitives built inside `build` are markers: never dimmed, never recoloured with the body. */
export function withMarker(build) {
    markerDepth += 1;
    try {
        return build();
    } finally {
        markerDepth -= 1;
    }
}

export function dim(materials, factor) {
    for (const entry of materials) {
        entry.material.opacity = entry.base * factor;
    }
}

/** Repaint tracked line work: body primitives take `body`, highlights take `hot`. */
export function tone(materials, body, hot) {
    for (const entry of materials) {
        entry.material.color.copy(entry.role === "hot" ? hot : body);
    }
}

// ── primitives ────────────────────────────────────────────────────────────────

export function segments(parent, positions, colour, width = 1, opacity = 0.7) {
    const geometry = new LineSegmentsGeometry();
    geometry.setPositions(positions);
    const material = new LineMaterial({
        color: colour,
        linewidth: width,
        transparent: true,
        opacity,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
    });
    track(material, opacity, colour === colours.blueHot ? "hot" : "body");
    const line = new LineSegments2(geometry, material);
    line.computeLineDistances();
    line.frustumCulled = false;
    parent.add(line);
    return line;
}

export function arc(parent, radius, start, length, colour, width, opacity, z = 0) {
    const positions = [];
    const count = Math.max(4, Math.ceil(Math.abs(length) * 42));
    for (let i = 0; i < count; i++) {
        for (const angle of [start + (length * i) / count, start + (length * (i + 1)) / count]) {
            positions.push(Math.cos(angle) * radius, Math.sin(angle) * radius, z);
        }
    }
    return segments(parent, positions, colour, width, opacity);
}

export function ticks(parent, radius, count, majorEvery = 4) {
    const positions = [];
    for (let i = 0; i < count; i++) {
        const angle = (i * TAU) / count;
        const length = i % majorEvery === 0 ? 0.09 : 0.035;
        for (const r of [radius, radius + length]) positions.push(Math.cos(angle) * r, Math.sin(angle) * r, 0);
    }
    return segments(parent, positions, colours.blue, 0.85, 0.78);
}

export function band(parent, inner, outer, start, length, opacity, colour = colours.blue, z = 0) {
    const material = new THREE.MeshBasicMaterial({
        color: colour,
        transparent: true,
        opacity,
        side: THREE.DoubleSide,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
    });
    track(material, opacity, "body");
    const mesh = new THREE.Mesh(new THREE.RingGeometry(inner, outer, 64, 1, start, length), material);
    mesh.position.z = z;
    parent.add(mesh);
    return mesh;
}

export function disc(parent, radius, opacity, colour, z = 0) {
    const material = new THREE.MeshBasicMaterial({
        color: colour,
        transparent: true,
        opacity,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
    });
    track(material, opacity, "body");
    const mesh = new THREE.Mesh(new THREE.CircleGeometry(radius, 40), material);
    mesh.position.z = z;
    parent.add(mesh);
    return mesh;
}

export function structuredCore(parent, z = 0) {
    const core = new THREE.Group();
    core.position.z = z;
    parent.add(core);
    arc(core, 0.31, 0, TAU, colours.blueHot, 1.1, 0.95);
    for (let i = 0; i < 3; i++) {
        const angle = (i * TAU) / 3;
        arc(core, 0.42, angle + 0.1, 1.1, colours.blue, 1.3, 0.95);
    }
    const hex = [];
    for (let i = 0; i < 6; i++) {
        for (const angle of [(i * TAU) / 6, ((i + 1) * TAU) / 6])
            hex.push(Math.cos(angle) * 0.17, Math.sin(angle) * 0.17, 0);
    }
    segments(core, hex, colours.blue, 0.85, 0.9);
    band(core, 0.31, 0.41, 0, TAU, 0.17);
    return core;
}

/**
 * The form. Three planes at different depths, the middle one split into three sectors a caller can move
 * independently, six struts holding the stack together, and a recessed core.
 *
 * Parts are returned both as groups (to move) and as material lists (to dim, recolour or light one plane
 * at a time), and the struts are separate objects rather than one batch so that severing them is hiding
 * objects rather than rebuilding geometry.
 */
export function depthForm(root, small) {
    const parts = { outer: [], mid: [], front: [], core: [], struts: [] };
    const planes = [-0.38, 0, 0.32].map((z) => {
        const group = new THREE.Group();
        group.position.z = z;
        root.add(group);
        return group;
    });
    const outer = new THREE.Group();
    planes[0].add(outer);
    withSink(parts.outer, () => {
        for (let i = 0; i < 6; i++) {
            const start = (i * TAU) / 6 + 0.08;
            arc(outer, 1.4, start, 0.78, colours.blue, 0.9, 0.65);
            band(outer, 1.32, 1.39, start, 0.78, 0.18);
        }
        ticks(planes[0], 1.47, small ? 24 : 48);
    });
    const front = new THREE.Group();
    planes[2].add(front);
    const blades = [];
    for (let i = 0; i < 3; i++) {
        const start = (i * TAU) / 3 + 0.3;
        const blade = new THREE.Group();
        planes[1].add(blade);
        withSink(parts.mid, () => {
            arc(blade, 1.11, start, 1.62, colours.blue, small ? 1.9 : 2.2, 1);
            band(blade, 1.02, 1.1, start, 1.62, 0.32);
        });
        blades.push({ group: blade, bearing: start + 0.81 });
        withSink(parts.front, () => arc(front, 0.83, start - 0.2, 1.3, colours.blueHot, 1.05, 0.75));
    }
    withSink(parts.front, () => arc(front, 0.91, 0, TAU, colours.blue, 0.7, 0.5));
    const struts = [];
    withSink(parts.struts, () => {
        for (let i = 0; i < 6; i++) {
            const a = (i * TAU) / 6 + 0.45;
            const line = segments(
                root,
                [Math.cos(a) * 1.4, Math.sin(a) * 1.4, -0.38, Math.cos(a) * 1.11, Math.sin(a) * 1.11, 0],
                colours.blue,
                0.8,
                0.45
            );
            struts.push(line);
        }
    });
    const core = withSink(parts.core, () => structuredCore(root, -0.25));
    return { planes, outer, front, blades, struts, core, parts };
}

// ── markers ───────────────────────────────────────────────────────────────────
// Study 03's three tells. Each is built as a marker, so it survives the dimming that pushes the form
// behind it — that contrast, rather than the stroke width alone, is what made them read at 132px.

export function alarmRim(root, small, colour = colours.attention) {
    return withMarker(() => {
        const group = new THREE.Group();
        root.add(group);
        arc(group, 1.46, 0.36, TAU - 0.72, colour, small ? 2.8 : 3.6, 1);
        const notch = [];
        for (const angle of [0.36, TAU - 0.36]) {
            notch.push(
                Math.cos(angle) * 1.34,
                Math.sin(angle) * 1.34,
                0,
                Math.cos(angle) * 1.58,
                Math.sin(angle) * 1.58,
                0
            );
        }
        segments(group, notch, colour, small ? 2.2 : 2.8, 1);
        return group;
    });
}

export function alarmPupil(root, small, colour = colours.attention) {
    return withMarker(() => {
        const group = new THREE.Group();
        root.add(group);
        // a filled disc at full opacity blooms into a featureless ball at 132px, which is legible but is
        // no longer an instrument. The fill only has to say "occupied"; the rings carry the structure.
        disc(group, 0.17, 0.3, colour, 0.12);
        arc(group, 0.26, 0, TAU, colour, small ? 1.6 : 2, 0.9, 0.12);
        arc(group, 0.44, 0, TAU, colour, small ? 2.8 : 3.6, 1, 0.12);
        const spokes = [];
        for (let i = 0; i < 3; i++) {
            const angle = (i * TAU) / 3 + 0.5;
            spokes.push(
                Math.cos(angle) * 0.5,
                Math.sin(angle) * 0.5,
                0.12,
                Math.cos(angle) * 0.68,
                Math.sin(angle) * 0.68,
                0.12
            );
        }
        segments(group, spokes, colour, small ? 1.6 : 2, 0.85);
        return group;
    });
}

/**
 * A sector of the rim, a quarter of the way round. `start` is where it begins, in radians — which is how
 * production's posture marker says WHICH kind of waiting without ever rendering a count.
 */
export function alarmSector(root, small, colour = colours.attention, start = 0.35, length = 1.25) {
    return withMarker(() => {
        const group = new THREE.Group();
        root.add(group);
        band(group, 0.98, 1.46, start, length, 0.42, colour);
        arc(group, 1.46, start, length, colour, small ? 2.8 : 3.6, 1);
        arc(group, 0.98, start, length, colour, small ? 1.6 : 2, 0.9);
        const edges = [];
        for (const angle of [start, start + length]) {
            edges.push(
                Math.cos(angle) * 0.98,
                Math.sin(angle) * 0.98,
                0,
                Math.cos(angle) * 1.46,
                Math.sin(angle) * 1.46,
                0
            );
        }
        segments(group, edges, colour, small ? 1.6 : 2, 0.9);
        return group;
    });
}

// ── viewport ──────────────────────────────────────────────────────────────────

/**
 * One WebGL view of the form inside `element`. `build(root, small, materials)` returns the per-frame
 * update; `materials` is every tracked primitive in that view.
 *
 * `.mini` on the element means ship size: a slightly further camera and a lighter bloom, so the 132px
 * preview is the same picture the cockpit would show rather than a scaled-down detail render.
 */
export function createView(element, build, onLost) {
    const small = element.classList.contains("mini");
    const scene = new THREE.Scene();
    scene.background = null;
    const camera = new THREE.PerspectiveCamera(36, 1, 0.1, 50);
    camera.position.z = small ? 6.3 : 5.8;
    const renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: true,
        premultipliedAlpha: false,
        powerPreference: "low-power",
    });
    renderer.setPixelRatio(DPR);
    renderer.setSize(element.clientWidth, element.clientHeight);
    renderer.domElement.setAttribute("aria-hidden", "true");
    element.appendChild(renderer.domElement);
    renderer.domElement.addEventListener("webglcontextlost", (event) => {
        event.preventDefault();
        onLost?.(new Error("WebGL context lost. Reload the study to restore the previews."));
    });
    const composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    composer.addPass(
        new UnrealBloomPass(new THREE.Vector2(element.clientWidth, element.clientHeight), small ? 0.35 : 0.55, 0.2, 0.4)
    );
    composer.addPass(new ShaderPass(alphaFromLight));
    composer.addPass(new OutputPass());
    const root = new THREE.Group();
    scene.add(root);
    const materials = [];
    const update = withSink(materials, () => build(root, small, materials));
    const draw = () => {
        update();
        composer.render();
    };
    const resize = () => {
        const { width, height } = element.getBoundingClientRect();
        if (!width || !height) {
            return;
        }
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
        renderer.setSize(width, height);
        composer.setSize(width, height);
        draw();
    };
    // the magnifier scales the rendered 132px canvas with a transform, so the element keeps its ship
    // size and the observer must measure the layout box rather than the painted one.
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    resize();
    return { draw, renderer, composer, scene, observer, root, materials };
}

export function disposeView(view) {
    view.observer.disconnect();
    view.scene.traverse((object) => {
        object.geometry?.dispose();
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        materials.forEach((material) => material?.dispose());
    });
    view.composer.passes.forEach((pass) => pass.dispose?.());
    view.composer.dispose();
    view.renderer.dispose();
}
