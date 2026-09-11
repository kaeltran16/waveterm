// Study 03 — how the avatar should move. Standalone exploration: no production signals, state writes,
// or avatar changes.
//
// One form (study 02's holographic depth, imported from ./jarvis-hud-form.js) and three ways of moving,
// because at 132px the last study's four forms were nearly the same picture and only their behaviour
// told them apart. This file owns motion and the page; it builds no geometry of its own.

import * as THREE from "three";
import {
    FRAME_MS,
    alarmPupil,
    alarmRim,
    alarmSector,
    arc,
    colours,
    createView,
    depthForm,
    dim,
    disposeView,
    reducedMotion,
} from "./jarvis-hud-form.js";

let condition = "idle";
let paused = reducedMotion.matches;
let elapsed = 0;
let activeTime = 0;
let response = 0;
let alarm = 0;
const views = [];

// Idle is the state the avatar is in almost all the time, and study 02's holographic depth answered it
// with nothing at all — two renders eight seconds apart were byte-identical. These are the three answers
// worth comparing: none, a pulse, or a slow float. They are an axis of their own because they apply to
// the form, not to a treatment; all three treatments idle the same way.
const IDLE_MODES = {
    still: { spin: 0, sway: 0, breath: 0, glow: 0 },
    // scale alone is invisible at 132px (3% of a 97px form is 1.5px), so the swell is carried by
    // brightness and the scale only keeps it from reading as a flicker.
    breath: { spin: 0, sway: 0, breath: 0.03, glow: 0.16 },
    // slow enough to be missed while reading, fast enough to be alive in peripheral vision: the outer
    // plane covers about a quarter turn a minute.
    drift: { spin: 1, sway: 0.05, breath: 0, glow: 0 },
};
let idleMode = "breath";
// integrated rather than derived from `elapsed`, so idle motion eases to a stop when the avatar has
// something to say instead of jumping to a new phase.
let idleTime = 0;

function idleAmount() {
    return Math.max(0, 1 - Math.max(response, alarm));
}

/** The attitude a treatment asks for, plus the idle float on top of it. */
function attitude(root, x, y, z) {
    const sway = IDLE_MODES[idleMode].sway * idleAmount();
    root.rotation.set(x + Math.sin(idleTime * 0.23) * sway * 0.7, y + Math.sin(idleTime * 0.31 + 1.1) * sway, z);
}

/** Scale and brightness of the breath, both 1 when the form is not breathing. */
function breathing() {
    const config = IDLE_MODES[idleMode];
    const wave = Math.sin(idleTime * 0.55);
    const amount = idleAmount();
    return { scale: 1 + config.breath * amount * wave, glow: 1 - config.glow * amount * (0.5 - 0.5 * wave) };
}

function driftPlanes(form) {
    const spin = IDLE_MODES[idleMode].spin;
    form.planes[0].rotation.z = -activeTime * 0.04 - idleTime * 0.035 * spin;
    form.planes[1].rotation.z = activeTime * 0.09 + idleTime * 0.022 * spin;
    form.planes[2].rotation.z = -activeTime * 0.06 - idleTime * 0.014 * spin;
}

/** The breath and the dimming behind a tell, applied the same way by all three treatments. */
function settle(root, materials) {
    const breath = breathing();
    root.scale.setScalar(breath.scale);
    // the tell takes the foreground by pushing the rest of the form back rather than by out-shouting it
    // — a hairline marker over a form at full brightness is what failed to read in study 02.
    dim(materials, (1 - alarm * 0.58) * breath.glow);
}

// ── the three behaviours ──────────────────────────────────────────────────────
// Each tell speaks the same axis its behaviour does — rim, core, attitude — so the state that matters
// most is the one change the form is already fluent in, at a stroke width that survives 132px.

function split(root, small, materials) {
    const form = depthForm(root, small);
    const tell = alarmRim(root, small);
    return () => {
        const open = response * (1 - alarm);
        driftPlanes(form);
        attitude(root, 0.2, -0.28, -0.06);
        form.blades.forEach(({ group, bearing }) => {
            group.position.set(Math.cos(bearing) * open * 0.3, Math.sin(bearing) * open * 0.3, 0);
            group.rotation.z = open * 0.14;
        });
        form.outer.scale.setScalar(1 + open * 0.12);
        form.front.scale.setScalar(1 - open * 0.06);
        form.core.scale.setScalar(1 + open * 0.06);
        tell.visible = alarm > 0.01;
        tell.scale.setScalar(0.93 + alarm * 0.07);
        settle(root, materials);
    };
}

function aperture(root, small, materials) {
    const form = depthForm(root, small);
    const tell = alarmPupil(root, small);
    return () => {
        const open = response * (1 - alarm);
        const shut = alarm;
        driftPlanes(form);
        attitude(root, 0.2, -0.28, -0.06);
        form.blades.forEach(({ group, bearing }) => {
            group.rotation.z = open * 0.62 - shut * 0.1;
            group.position.set(Math.cos(bearing) * open * 0.16, Math.sin(bearing) * open * 0.16, 0);
            group.scale.setScalar(1 - shut * 0.16);
        });
        form.front.scale.setScalar(1 - open * 0.34 + shut * 0.05);
        form.core.position.z = -0.25 + open * 0.4;
        form.core.scale.setScalar(1 + open * 0.7 - shut * 0.3);
        tell.visible = alarm > 0.01;
        tell.scale.setScalar(0.8 + alarm * 0.2);
        settle(root, materials);
    };
}

function attend(root, small, materials) {
    const form = depthForm(root, small);
    const tell = alarmSector(root, small);
    const tracer = new THREE.Group();
    form.planes[1].add(tracer);
    arc(tracer, 1.11, -0.32, 0.64, colours.blueHot, small ? 2.6 : 3.2, 1);
    return () => {
        const face = response * (1 - alarm);
        driftPlanes(form);
        // the whole attitude is the signal: three-quarters-on at rest, square-on when it has something
        // to say, and turned further away while it waits on you.
        attitude(root, 0.2 - face * 0.17 + alarm * 0.14, -0.28 + face * 0.24 - alarm * 0.16, -0.06 + face * 0.06);
        form.planes[2].position.z = 0.32 + face * 0.14;
        tracer.visible = face > 0.02;
        tracer.rotation.z = activeTime * 1.6;
        tell.visible = alarm > 0.01;
        tell.scale.setScalar(0.95 + alarm * 0.05);
        settle(root, materials);
    };
}

const builders = { split, aperture, attend };

const idleCopy = {
    still: "Nothing moves. The form holds exactly this pose until there is something to say.",
    breath: "A slow swell in brightness and scale, about five a minute. Alive, but it does not travel.",
    drift: "The three planes creep at different rates while the whole stack floats a couple of degrees.",
};
const stateCopy = {
    idle: ["Idle · standing by", "Standing by"],
    responding: ["Responding · simulated", "Responding"],
    attention: ["Needs you · simulated", "Your attention is needed"],
};
const behaviorCopy = {
    split: {
        idle: () => idleCopy[idleMode],
        responding: "The middle ring breaks into three arcs and moves outward. The whole silhouette grows.",
        attention: "The rim closes into one amber ring with a single notch; the form behind it recedes.",
    },
    aperture: {
        idle: () => idleCopy[idleMode],
        responding: "Three blades swing open and the core rises into the gap. The centre goes from dark to bright.",
        attention: "The blades shut and the core becomes an amber pupil.",
    },
    attend: {
        idle: () => idleCopy[idleMode],
        responding: "It turns square-on to face you while light sweeps the ring.",
        attention: "It turns further away and an amber sector holds a quarter of the rim.",
    },
};

function copyFor(variant) {
    const entry = behaviorCopy[variant][condition];
    return typeof entry === "function" ? entry() : entry;
}

function syncCopy() {
    const [status, title] = stateCopy[condition];
    document.querySelector("#status").textContent = condition === "idle" ? `Idle · ${idleMode}` : status;
    document.querySelectorAll("[data-variant]").forEach((card) => {
        card.querySelector(".state-title").textContent = title;
        card.querySelector(".state-copy").textContent = copyFor(card.dataset.variant);
    });
}

function settlePreview() {
    if (paused || reducedMotion.matches) {
        response = condition === "responding" ? 1 : 0;
        alarm = condition === "attention" ? 1 : 0;
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

function toggle(id, className) {
    const button = document.querySelector(id);
    button.addEventListener("click", () => {
        const on = document.body.classList.toggle(className);
        button.setAttribute("aria-pressed", String(on));
    });
}

document.querySelectorAll("[data-state]").forEach((button) => {
    button.addEventListener("click", () => {
        condition = button.dataset.state;
        document
            .querySelectorAll("[data-state]")
            .forEach((item) => item.setAttribute("aria-pressed", String(item === button)));
        syncCopy();
        settlePreview();
        redraw();
    });
});
document.querySelectorAll("[data-idle]").forEach((button) => {
    button.addEventListener("click", () => {
        idleMode = button.dataset.idle;
        document
            .querySelectorAll("[data-idle]")
            .forEach((item) => item.setAttribute("aria-pressed", String(item === button)));
        syncCopy();
        redraw();
    });
});
toggle("#magnify", "magnify");
toggle("#glance", "glance");
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
    document.querySelectorAll(".viewport").forEach((element) => {
        views.push(createView(element, builders[element.dataset.kind], fail));
    });
    syncMotion();
    let previous = performance.now();
    const frame = (now) => {
        if (now - previous >= FRAME_MS) {
            const delta = Math.min(now - previous, 100) / 1000;
            previous = now;
            if (!paused && !document.hidden) {
                elapsed += delta;
                response = THREE.MathUtils.damp(response, condition === "responding" ? 1 : 0, 9, delta);
                alarm = THREE.MathUtils.damp(alarm, condition === "attention" ? 1 : 0, 9, delta);
                activeTime += delta * Math.max(response, alarm * 0.15);
                idleTime += delta * idleAmount();
                redraw();
            }
        }
        frameId = requestAnimationFrame(frame);
    };
    frameId = requestAnimationFrame(frame);
    window.__hudBehavior = {
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
        get response() {
            return response;
        },
        get alarm() {
            return alarm;
        },
        get idleMode() {
            return idleMode;
        },
        get idleTime() {
            return idleTime;
        },
        views: views.length,
        variants: Object.keys(builders),
    };
} catch (error) {
    fail(error);
}
window.addEventListener("pagehide", () => {
    cancelAnimationFrame(frameId);
    views.forEach(disposeView);
});
