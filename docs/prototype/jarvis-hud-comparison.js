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
    attention: token("warning"),
};
let condition = "idle";
let paused = reducedMotion.matches;
let elapsed = 0;
let activeTime = 0;
let response = 0;
let inspection = 0;
let inspectDepth = false;
const views = [];

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

function ticks(parent, radius, count, majorEvery = 4, z = 0) {
    const positions = [];
    for (let i = 0; i < count; i++) {
        const angle = (i * TAU) / count;
        const length = i % majorEvery === 0 ? 0.09 : 0.035;
        for (const r of [radius, radius + length]) positions.push(Math.cos(angle) * r, Math.sin(angle) * r, z);
    }
    return segments(parent, positions, colours.blue, 0.85, 0.78);
}

function band(parent, inner, outer, start, length, opacity, z = 0) {
    const mesh = new THREE.Mesh(
        new THREE.RingGeometry(inner, outer, 64, 1, start, length),
        new THREE.MeshBasicMaterial({
            color: colours.blue,
            transparent: true,
            opacity,
            side: THREE.DoubleSide,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
        })
    );
    mesh.position.z = z;
    parent.add(mesh);
    return mesh;
}

function attentionMarker(root) {
    const marker = new THREE.Group();
    root.add(marker);
    arc(marker, 1.68, 0.26, 0.42, colours.attention, 2, 1);
    segments(marker, [1.64, 0.91, 0, 1.64, 1.03, 0, 1.64, 1.08, 0, 1.64, 1.1, 0], colours.attention, 1.6, 1);
    return marker;
}

function structuredCore(parent, z = 0) {
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
    return core;
}

function precision(root, small) {
    root.rotation.set(0.03, -0.04, 0);
    const main = new THREE.Group();
    root.add(main);
    for (let i = 0; i < 3; i++) {
        const start = (i * TAU) / 3 + 0.18;
        arc(main, 1.06, start, 1.65, colours.blue, small ? 1.65 : 2.1, 1);
        band(main, 1.015, 1.055, start, 1.65, 0.2);
        arc(root, 1.45, start + 0.17, 1.3, colours.blue, 0.85, 0.85);
    }
    ticks(root, 1.49, small ? 24 : 48);
    arc(root, 0.79, 0, TAU, colours.blue, 0.75, 0.55);
    const core = structuredCore(root);
    const signal = new THREE.Group();
    root.add(signal);
    arc(signal, 0.8, 0, 0.38, colours.blueHot, 1.4, 1);
    const marker = attentionMarker(root);
    return (_, state) => {
        main.rotation.z = activeTime * 0.08;
        signal.visible = response > 0.01;
        signal.rotation.z = activeTime * 1.2;
        core.scale.setScalar(1 + response * 0.12);
        marker.visible = state === "attention";
    };
}

function depth(root, small) {
    root.rotation.set(0.2, -0.28, -0.06);
    const planes = [-0.38, 0, 0.32].map((z) => {
        const group = new THREE.Group();
        group.position.z = z;
        root.add(group);
        return group;
    });
    for (let i = 0; i < 6; i++) {
        const start = (i * TAU) / 6 + 0.08;
        arc(planes[0], 1.4, start, 0.78, colours.blue, 0.9, 0.65);
        band(planes[0], 1.32, 1.39, start, 0.78, 0.18);
    }
    ticks(planes[0], 1.47, small ? 24 : 48);
    for (let i = 0; i < 3; i++) {
        const start = (i * TAU) / 3 + 0.3;
        arc(planes[1], 1.11, start, 1.62, colours.blue, small ? 1.7 : 2, 1);
        band(planes[1], 1.02, 1.1, start, 1.62, 0.32);
        arc(planes[2], 0.83, start - 0.2, 1.3, colours.blueHot, 1.05, 0.75);
    }
    arc(planes[2], 0.91, 0, TAU, colours.blue, 0.7, 0.5);
    const supports = [];
    for (let i = 0; i < 6; i++) {
        const a = (i * TAU) / 6 + 0.45;
        supports.push(Math.cos(a) * 1.4, Math.sin(a) * 1.4, -0.38, Math.cos(a) * 1.11, Math.sin(a) * 1.11, 0);
    }
    segments(root, supports, colours.blue, 0.8, 0.45);
    const core = structuredCore(root, -0.25);
    band(core, 0.31, 0.41, 0, TAU, 0.17);
    const marker = attentionMarker(root);
    const tracer = new THREE.Group();
    planes[1].add(tracer);
    arc(tracer, 1.11, -0.06, 0.25, colours.blueHot, 2.1, 1);
    return (_, state) => {
        planes[0].rotation.z = -activeTime * 0.04;
        planes[1].rotation.z = activeTime * 0.09;
        planes[2].rotation.z = -activeTime * 0.06;
        planes[2].position.z = 0.32 + response * 0.18;
        core.position.z = -0.25 + response * 0.16;
        tracer.visible = response > 0.01;
        tracer.rotation.z = activeTime * 0.8;
        marker.visible = state === "attention";
    };
}

function iris(root, small) {
    root.rotation.set(0.1, -0.13, 0);
    const blades = [];
    const bladeCount = 8;
    for (let i = 0; i < bladeCount; i++) {
        const pivot = new THREE.Group();
        const angle = (i * TAU) / bladeCount;
        root.add(pivot);
        const outline = [];
        const shape = new THREE.Shape();
        const contour = [];
        for (let j = 0; j <= 10; j++) {
            const a = (j / 10) * 0.8;
            contour.push([Math.cos(a) * 1.05, Math.sin(a) * 1.05]);
        }
        contour.push([Math.cos(1.05) * 0.42, Math.sin(1.05) * 0.42]);
        contour.push([Math.cos(0.7) * 0.34, Math.sin(0.7) * 0.34]);
        contour.push([0.72, 0.06]);
        contour.forEach(([x, y], j) => {
            if (j === 0) shape.moveTo(x, y);
            else shape.lineTo(x, y);
            const next = contour[(j + 1) % contour.length];
            outline.push(x, y, 0, ...next, 0);
        });
        shape.closePath();
        const fill = new THREE.Mesh(
            new THREE.ShapeGeometry(shape),
            new THREE.MeshBasicMaterial({
                color: colours.blue,
                transparent: true,
                opacity: 0.2,
                side: THREE.DoubleSide,
                depthWrite: false,
                blending: THREE.AdditiveBlending,
            })
        );
        pivot.add(fill);
        segments(pivot, outline, colours.blue, small ? 0.95 : 1.2, 0.92);
        pivot.rotation.z = angle;
        pivot.position.z = i * 0.008;
        blades.push({ pivot, angle });
    }
    for (let i = 0; i < 4; i++) arc(root, 1.29, (i * TAU) / 4 + 0.12, 1.28, colours.blue, 1.2, 0.95);
    ticks(root, 1.46, small ? 24 : 48);
    arc(root, 1.42, 0, TAU, colours.blue, 0.7, 0.6);
    const core = new THREE.Group();
    root.add(core);
    arc(core, 0.19, 0, TAU, colours.blueHot, 1, 0.75, -0.1);
    const marker = attentionMarker(root);
    return (_, state) => {
        blades.forEach(({ pivot, angle }) => {
            pivot.rotation.z = angle + response * 0.16;
            pivot.position.x = Math.cos(angle + 0.35) * response * 0.2;
            pivot.position.y = Math.sin(angle + 0.35) * response * 0.2;
        });
        core.scale.setScalar(1 + response * 0.45);
        marker.visible = state === "attention";
    };
}

const builders = { hud, precision, depth, iris };

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
    const bearing = new THREE.Group();
    const root = new THREE.Group();
    scene.add(bearing);
    bearing.add(root);
    const update = builders[element.dataset.kind](root, small);
    const resize = () => {
        const { width, height } = element.getBoundingClientRect();
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
        renderer.setSize(width, height);
        composer.setSize(width, height);
        draw();
    };
    const draw = () => {
        bearing.rotation.set(inspection * 0.22, inspection * 0.72, 0);
        update(elapsed, condition);
        composer.render();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    resize();
    return { draw, renderer, composer, scene, observer };
}

const stateCopy = {
    idle: ["Idle · standing by", "Standing by"],
    responding: ["Responding · simulated", "Responding"],
    attention: ["Needs you · simulated", "Your attention is needed"],
};
const behaviorCopy = {
    hud: {
        idle: "Independent rings rotate continuously.",
        responding: "The bright core pulses; rings keep rotating.",
        attention: "An amber sector and exclamation mark appear.",
    },
    precision: {
        idle: "Settled geometry. No perpetual spin.",
        responding: "A tracer travels; the main ring advances slowly.",
        attention: "A localized amber sector. The open core holds.",
    },
    depth: {
        idle: "A stable stack with a slight natural tilt.",
        responding: "The forward plane lifts as light traces the middle ring.",
        attention: "The stack settles; a rim marker calls for attention.",
    },
    iris: {
        idle: "A compact, resting aperture.",
        responding: "Eight blades open outward to reveal the core.",
        attention: "The aperture closes; an amber marker appears.",
    },
};
function settlePreview() {
    if (paused || reducedMotion.matches) {
        response = condition === "responding" ? 1 : 0;
        inspection = inspectDepth ? 1 : 0;
    }
}

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
        const [status, title] = stateCopy[condition];
        document.querySelector("#status").textContent = status;
        document.querySelectorAll("[data-variant]").forEach((card) => {
            card.querySelector(".state-title").textContent = title;
            card.querySelector(".state-copy").textContent = behaviorCopy[card.dataset.variant][condition];
        });
        settlePreview();
        redraw();
    });
});
document.querySelector("#angle").addEventListener("click", () => {
    inspectDepth = !inspectDepth;
    document.querySelector("#angle").setAttribute("aria-pressed", String(inspectDepth));
    settlePreview();
    redraw();
});
document.querySelector("#motion").addEventListener("click", () => {
    paused = !paused;
    syncMotion();
});
reducedMotion.addEventListener("change", () => {
    paused = reducedMotion.matches;
    syncMotion();
    settlePreview();
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
                response = THREE.MathUtils.damp(response, condition === "responding" ? 1 : 0, 9, delta);
                inspection = THREE.MathUtils.damp(inspection, inspectDepth ? 1 : 0, 9, delta);
                activeTime += delta * response;
                redraw();
            }
        }
        frameId = requestAnimationFrame(frame);
    };
    frameId = requestAnimationFrame(frame);
    window.__hudComparison = {
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
        get response() {
            return response;
        },
        get inspection() {
            return inspection;
        },
        get activeTime() {
            return activeTime;
        },
        variants: Object.keys(builders),
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
