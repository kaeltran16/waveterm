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

// standalone exploration: no production signals, state writes, or avatar changes.
const TAU = Math.PI * 2;
const DPR = Math.min(devicePixelRatio, 1.5);
const FRAME_MS = 1000 / 30;
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
const rootStyle = getComputedStyle(document.documentElement);
const token = (name) => new THREE.Color(rootStyle.getPropertyValue(`--color-${name}`).trim());
const colours = {
    blue: token("conn-1"),
    blueHot: token("accent-100"),
    gold: token("conn-6"),
    goldHot: token("warning-soft"),
    white: token("foreground"),
    attention: token("warning"),
};
let condition = "idle";
let paused = reducedMotion.matches;
let elapsed = 0;
const views = [];

function randomSequence(seed) {
    return () => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed / 4294967296;
    };
}

function segments(parent, positions, colour, width = 1, opacity = 0.7) {
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
    const line = new LineSegments2(geometry, material);
    line.computeLineDistances();
    line.frustumCulled = false;
    parent.add(line);
    return line;
}

function arc(parent, radius, start, length, colour, width, opacity, z = 0) {
    const positions = [];
    const count = Math.max(4, Math.ceil(Math.abs(length) * 42));
    for (let i = 0; i < count; i++) {
        for (const angle of [start + (length * i) / count, start + (length * (i + 1)) / count]) {
            positions.push(Math.cos(angle) * radius, Math.sin(angle) * radius, z);
        }
    }
    return segments(parent, positions, colour, width, opacity);
}

function points(parent, positions, colour, size) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    const material = new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        uniforms: {
            tint: { value: colour },
            diameter: { value: size * DPR },
            time: { value: 0 },
            energy: { value: 1 },
        },
        vertexShader: `uniform float diameter; uniform float time; uniform float energy;
            varying float light;
            void main() {
                vec4 p = modelViewMatrix * vec4(position, 1.0);
                light = (0.55 + 0.45 * sin(position.x * 23.0 + position.y * 17.0 + time)) * energy;
                gl_Position = projectionMatrix * p;
                gl_PointSize = diameter * (0.8 + 0.35 * light);
            }`,
        fragmentShader: `uniform vec3 tint; varying float light;
            void main() {
                float r = length(gl_PointCoord - 0.5) * 2.0;
                if (r > 1.0) discard;
                float a = pow(1.0 - r, 1.5);
                gl_FragColor = vec4(tint * (0.8 + light), a);
            }`,
    });
    const cloud = new THREE.Points(geometry, material);
    parent.add(cloud);
    return cloud;
}

function hud(root, small) {
    const rings = [];
    const blue = colours.blue;
    const hot = colours.blueHot;
    root.rotation.x = 0.18;
    root.rotation.y = -0.16;
    for (let layer = 0; layer < 4; layer++) {
        const group = new THREE.Group();
        group.position.z = (layer - 1.5) * 0.12;
        root.add(group);
        rings.push(group);
        const radius = 0.59 + layer * 0.3;
        const count = layer === 3 ? 8 : 3;
        for (let sector = 0; sector < count; sector++) {
            const start = (sector * TAU) / count + layer * 0.31;
            arc(
                group,
                radius,
                start,
                (TAU / count) * (layer === 3 ? 0.68 : 0.82),
                blue,
                layer === 1 ? 1.9 : 1.05,
                0.85
            );
            if (layer === 1 || layer === 3) arc(group, radius - 0.05, start, (TAU / count) * 0.42, hot, 0.8, 0.4);
        }
        const ticks = [];
        const tickCount = small ? 48 : 96;
        for (let i = 0; i < tickCount; i++) {
            if (layer !== 2 && layer !== 3) continue;
            const angle = (TAU * i) / tickCount;
            const major = i % 4 === 0;
            for (const r of [radius + 0.05, radius + (major ? 0.12 : 0.085)])
                ticks.push(Math.cos(angle) * r, Math.sin(angle) * r, 0);
        }
        if (ticks.length) segments(group, ticks, blue, 0.8, 0.55);
    }
    const core = new THREE.Group();
    root.add(core);
    arc(core, 0.33, 0, TAU, hot, 1.8, 0.9);
    arc(core, 0.39, 0.2, Math.PI * 1.6, blue, 0.8, 0.8);
    const paths = [];
    for (let i = 0; i < 6; i++) {
        const angle = (TAU * i) / 6;
        const p = (r, a, z = 0) => [Math.cos(a) * r, Math.sin(a) * r, z];
        paths.push(...p(0.13, angle), ...p(0.26, angle), ...p(0.43, angle), ...p(0.49, angle));
        paths.push(...p(0.94, angle), ...p(1.03, angle), ...p(1.03, angle), ...p(1.1, angle + 0.05));
    }
    segments(core, paths, hot, 1, 0.65);
    const sparks = points(core, [0, 0, 0.08], hot, small ? 8 : 16);
    const nucleus = new THREE.Mesh(
        new THREE.IcosahedronGeometry(0.11, 1),
        new THREE.MeshBasicMaterial({ color: hot, wireframe: true, transparent: true, opacity: 0.65 })
    );
    core.add(nucleus);
    const marker = new THREE.Group();
    root.add(marker);
    arc(marker, 1.72, 0.3, 0.4, colours.attention, 2.5, 1);
    segments(marker, [1.65, 0.9, 0, 1.65, 1.02, 0, 1.65, 1.07, 0, 1.65, 1.09, 0], colours.attention, 2, 1);
    return (t, state) => {
        const active = state === "responding";
        rings.forEach((ring, i) => {
            ring.rotation.z = t * [0.075, -0.12, 0.045, -0.03][i];
        });
        core.scale.setScalar(active ? 1.05 + Math.sin(t * 4) * 0.06 : 1);
        nucleus.rotation.set(t * 0.15, t * 0.22, 0);
        sparks.material.uniforms.time.value = t;
        sparks.material.uniforms.energy.value = active ? 1.8 : 1;
        marker.visible = state === "attention";
    };
}

function neural(root, small) {
    const random = randomSequence(731);
    const gold = colours.gold;
    const hot = colours.goldHot;
    const filaments = [];
    const inner = [];
    const nodes = [];
    const terminals = [];
    const branches = small ? 48 : 76;
    const goldenAngle = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < branches; i++) {
        const y = 1 - (2 * (i + 0.5)) / branches;
        const radius = Math.sqrt(1 - y * y);
        const direction = new THREE.Vector3(Math.cos(i * goldenAngle) * radius, y, Math.sin(i * goldenAngle) * radius);
        const side = new THREE.Vector3().crossVectors(direction, new THREE.Vector3(0, 1, 0)).normalize();
        const chain = [];
        for (let step = 0; step <= 9; step++) {
            const distance = 0.38 + (step / 9) * (1.0 + random() * 0.1);
            const wobble = (random() - 0.5) * 0.16 * Math.sin((step / 9) * Math.PI);
            const point = direction.clone().multiplyScalar(distance).addScaledVector(side, wobble);
            chain.push(point);
            if (step > 0) (step < 4 ? inner : filaments).push(...chain[step - 1].toArray(), ...point.toArray());
            if (step % 2 === 0) nodes.push(...point.toArray());
            if (step > 4 && step < 9) {
                const fork = point
                    .clone()
                    .addScaledVector(side, (random() > 0.5 ? 1 : -1) * (0.1 + random() * 0.16))
                    .addScaledVector(direction, 0.13);
                filaments.push(...point.toArray(), ...fork.toArray());
                nodes.push(...fork.toArray());
            }
        }
        terminals.push(chain[9]);
    }
    const shell = [];
    terminals.forEach((point, i) => {
        const near = terminals
            .map((other, j) => ({ j, distance: point.distanceTo(other) }))
            .filter((v) => v.j > i && v.distance < 0.65)
            .sort((a, b) => a.distance - b.distance)
            .slice(0, 2);
        near.forEach(({ j }) => shell.push(...point.toArray(), ...terminals[j].toArray()));
    });
    segments(root, inner, hot, small ? 0.85 : 1.1, 0.25);
    segments(root, filaments, gold, small ? 0.75 : 0.9, 0.47);
    segments(root, shell, gold, 0.65, 0.23);
    const cloud = points(root, nodes, gold, small ? 2 : 3.2);
    const centre = points(root, [0, 0, 0], hot, small ? 7 : 13);
    const nucleus = new THREE.Mesh(
        new THREE.IcosahedronGeometry(0.3, 1),
        new THREE.MeshBasicMaterial({
            color: hot,
            wireframe: true,
            transparent: true,
            opacity: 0.32,
            blending: THREE.AdditiveBlending,
        })
    );
    root.add(nucleus);
    const pulse = points(
        root,
        terminals.flatMap((p) => p.toArray()),
        hot,
        small ? 3 : 5
    );
    const marker = new THREE.Group();
    const markerMaterial = new THREE.MeshBasicMaterial({ color: hot, side: THREE.DoubleSide });
    const markerShape = new THREE.Shape();
    markerShape.moveTo(0, 0.13);
    markerShape.lineTo(-0.12, -0.1);
    markerShape.lineTo(0.12, -0.1);
    markerShape.closePath();
    marker.add(new THREE.Mesh(new THREE.ShapeGeometry(markerShape), markerMaterial));
    marker.position.set(1.32, 1.18, 0);
    root.parent.add(marker);
    return (t, state) => {
        root.rotation.set(0.18 + Math.sin(t * 0.12) * 0.06, t * 0.065, -0.12);
        cloud.material.uniforms.time.value = t * 0.65;
        centre.material.uniforms.time.value = t;
        const responding = state === "responding";
        pulse.visible = responding;
        pulse.scale.setScalar(0.2 + ((t * 0.36) % 1) * 0.8);
        pulse.material.uniforms.energy.value = 1.5;
        centre.material.uniforms.energy.value = responding ? 1.7 : 1;
        marker.visible = state === "attention";
    };
}

function createView(element) {
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
        fail(new Error("WebGL context lost. Reload the comparison to restore the previews."));
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
    const update = element.dataset.kind === "hud" ? hud(root, small) : neural(root, small);
    const resize = () => {
        const { width, height } = element.getBoundingClientRect();
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
        renderer.setSize(width, height);
        composer.setSize(width, height);
        draw();
    };
    const draw = () => {
        update(elapsed, condition);
        composer.render();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    resize();
    return { draw, renderer, composer, scene, observer };
}

const stateCopy = {
    idle: ["Idle · standing by", "Jarvis is standing by", "Quiet, present, ready when you are."],
    responding: ["Responding · simulated", "Jarvis is responding", "Core activity increases; the silhouette holds."],
    attention: ["Needs you · simulated", "Your attention is needed", "A localized marker, not a whole-body alarm."],
};

function redraw() {
    views.forEach((view) => view.draw());
}
function syncMotion() {
    const button = document.querySelector("#motion");
    button.textContent = reducedMotion.matches ? "Reduced motion" : paused ? "Resume motion" : "Pause motion";
    button.setAttribute("aria-pressed", String(paused));
    button.disabled = reducedMotion.matches;
}
document.querySelectorAll("[data-state]").forEach((button) => {
    button.addEventListener("click", () => {
        condition = button.dataset.state;
        document
            .querySelectorAll("[data-state]")
            .forEach((item) => item.setAttribute("aria-pressed", String(item === button)));
        const [status, title, copy] = stateCopy[condition];
        document.querySelector("#status").textContent = status;
        document.querySelectorAll(".state-title").forEach((item) => {
            item.textContent = title;
        });
        document.querySelectorAll(".state-copy").forEach((item) => {
            item.textContent = copy;
        });
        redraw();
    });
});
document.querySelector("#motion").addEventListener("click", () => {
    paused = !paused;
    syncMotion();
});
reducedMotion.addEventListener("change", () => {
    paused = reducedMotion.matches;
    syncMotion();
    redraw();
});

function fail(error) {
    paused = true;
    syncMotion();
    const banner = document.querySelector("#error");
    banner.hidden = false;
    banner.textContent = `Avatar preview unavailable: ${error.message}`;
    console.error(error);
}
window.addEventListener("error", (event) => fail(event.error ?? new Error(event.message)));
let frameId;
try {
    document.querySelectorAll(".viewport").forEach((element) => views.push(createView(element)));
    syncMotion();
    let previous = performance.now();
    const frame = (now) => {
        if (now - previous >= FRAME_MS) {
            const delta = Math.min(now - previous, 100) / 1000;
            previous = now;
            if (!paused && !document.hidden) {
                elapsed += delta;
                redraw();
            }
        }
        frameId = requestAnimationFrame(frame);
    };
    frameId = requestAnimationFrame(frame);
    window.__avatarComparison = {
        threeRevision: THREE.REVISION,
        get state() {
            return condition;
        },
        get paused() {
            return paused;
        },
        get elapsed() {
            return elapsed;
        },
        views: views.length,
    };
} catch (error) {
    fail(error);
}
window.addEventListener("pagehide", () => {
    cancelAnimationFrame(frameId);
    for (const view of views) {
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
});
