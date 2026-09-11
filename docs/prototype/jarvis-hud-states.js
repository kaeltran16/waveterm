// Study 04 — the chosen avatar across every state the production one has. Standalone exploration: no
// production signals, state writes, or avatar changes.
//
// Study 03 picked one form and one behaviour (holographic depth, B3 "attend", breathing at rest) against
// three made-up states: idle, responding, needs-you. Production has more than that, and it has them on
// three independent axes — so the question this study asks is whether the chosen avatar can carry all of
// them, and whether it still reads when two or three are true at once.
//
// The three axes, all lifted from frontend/app/view/jarvis/:
//   register  petcondition.ts PetExpression → avatarscene.ts MOODS. What kind of shape it is in.
//   posture   petcondition.ts PetPosture    → MARKER_VARS / MARKER_BEARINGS. What is waiting on you.
//   moment    avatarscene.ts SceneInput     → quiet, utterance, ripple, jolt. What is happening now.
//
// Geometry comes from ./jarvis-hud-form.js so studies 03 and 04 cannot drift apart about what the avatar
// is. Everything here is how it moves.

import * as THREE from "three";
import {
    FRAME_MS,
    alarmSector,
    arc,
    colours,
    createView,
    depthForm,
    dim,
    disposeView,
    reducedMotion,
    token,
    tone,
} from "./jarvis-hud-form.js";

// ── the production vocabulary ─────────────────────────────────────────────────

const WHITE = new THREE.Color(1, 1, 1);
// avatarcanvas.ts HOT_LIGHTEN: the highlight tone is the body tone mixed toward white, so a register
// change repaints both from one colour rather than needing a second token per register.
const HOT_LIGHTEN = 0.62;

function register(tokenName, energy, align, jitter, spin, sever, name, line) {
    const body = token(tokenName);
    return { body, hot: body.clone().lerp(WHITE, HOT_LIGHTEN), energy, align, jitter, spin, sever, name, line };
}

// avatarscene.ts MOODS, verbatim. The commentary there is worth reading: cannot-see is the most severe
// register and deliberately the brightest, because an alarm is bright; tired is the only one that dims.
const REGISTERS = {
    "at-rest": register("accent", 1, 1, 0, 1, 0, "At rest", "Nothing needs saying."),
    drifting: register(
        "muted",
        0.88,
        0.4,
        0.1,
        0.62,
        0.25,
        "Drifting",
        "The vault is drifting — 14 notes are queued for cleanup."
    ),
    tired: register(
        "warning",
        0.44,
        0.8,
        0.03,
        0.34,
        0,
        "Tired",
        "Running low on Claude — 78% of the window used, back in 2h 10m."
    ),
    "cannot-see": register(
        "error",
        0.95,
        0.14,
        0.75,
        0.85,
        0.72,
        "Cannot see",
        "I cannot see as well right now — embeddings are off, so recall is keyword-only."
    ),
};
const MOOD_KEYS = ["energy", "align", "jitter", "spin", "sever"];

// avatarscene.ts MARKER_VARS + MARKER_BEARINGS. The bearing is the whole point: three postures that are
// otherwise identical are told apart by WHERE on the rim the marker sits, never by a count.
const POSTURES = {
    none: null,
    "review-gate": {
        colour: token("accent"),
        bearing: -62,
        name: "Review gate",
        line: "A review gate is waiting on you.",
    },
    escalation: { colour: token("error"), bearing: 44, name: "Escalation", line: "Something escalated to you." },
    "blocked-worker": {
        colour: token("asking"),
        bearing: 152,
        name: "Blocked worker",
        line: "A worker is blocked on your reply.",
    },
};
// Production draws the marker as a ±20° arc. Study 03 found 72° is what survives 132px once the body is
// dimmed behind it, so the WIDTH is study 03's and only the CENTRE is production's — a deliberate
// deviation, and the one thing on this page that is not a straight port.
const SECTOR_LENGTH = 1.25;

const MOMENTS = {
    none: { name: "—", line: "" },
    quiet: { name: "Quiet", line: "Nothing to express: smaller and dimmer." },
    speaking: { name: "Speaking", line: "An answer is being said, syllable by syllable." },
    news: { name: "News arriving", line: "A wave crosses the form from the centre outward." },
    knocked: { name: "Knocked", line: "An arrival that has to be felt rather than read." },
};
// avatarscene.ts QUIET_DIM, and the quiet size the scene builder uses.
const QUIET_DIM = 0.75;
const QUIET_SCALE = 0.82;
// avatarscene.ts RIPPLE_REACH / RIPPLE_WIDTH, in form units rather than ring indices.
const RIPPLE_REACH = 1.55;
const RIPPLE_WIDTH = 0.38;
// Where each part of the form sits, so a ripple front at radius r knows what it is passing over. This is
// why jarvis-hud-form.js hands back per-part material lists.
const PART_RADIUS = { core: 0.36, front: 0.87, mid: 1.06, struts: 1.25, outer: 1.4 };
// Which struts go first, so severing scatters the gaps instead of opening one hole.
const SEVER_ORDER = [1, 4, 0, 3, 5, 2];
// Which parts can drop out, and how hard. The core is in the list but last, so the form loses its
// periphery before it loses its centre — a centre that blinks reads as the whole avatar failing rather
// than as the avatar reporting that it cannot see.
const STUTTER_PARTS = ["outer", "mid", "struts", "front", "core"];
// How often a part is gated out at full jitter, and how far it drops when it is.
const STUTTER_RATE = 0.55;
const STUTTER_DEPTH = 0.8;
// avatarscene.ts MOOD_TAU_MS: a register change eases rather than snapping, because the form is
// continuous and so the change should be.
const MOOD_TAU = 0.42;

// ── page state ────────────────────────────────────────────────────────────────

let paused = reducedMotion.matches;
let elapsed = 0;
let delta = 0;
const live = { register: "at-rest", posture: "none", moment: "none" };
const views = [];

/** Scale what `dim` already wrote, for one part of the form. */
function shade(list, factor) {
    for (const entry of list) {
        entry.material.opacity = Math.min(1, entry.material.opacity * factor);
    }
}

/**
 * An irregular 0..1 gate for one part of the form, out of phase with every other part.
 *
 * Two incommensurate sines beaten together: it never repeats on any interval you would notice, and it
 * holds a value for several frames at a time rather than flickering per-frame, which is the difference
 * between a signal dropping out and white noise.
 */
function gate(seed) {
    const a = Math.sin(elapsed * (9.3 + seed * 2.1) + seed * 2.7);
    const b = Math.sin(elapsed * (4.7 + seed * 1.3) + seed * 1.9);
    return 0.5 + 0.5 * a * b;
}

function approach(current, target, tau) {
    return current + (target - current) * (1 - Math.exp(-delta / tau));
}

/** The moment's three envelopes, all derived from one clock so a whole strip beats together. */
function envelopes(moment) {
    if (moment === "speaking") {
        const voice = 0.5 + 0.3 * Math.sin(elapsed * 7.3) + 0.2 * Math.sin(elapsed * 4.1 + 1.4);
        return { utterance: Math.max(0, Math.min(1, voice)), ripple: null, jolt: 0, speaking: true };
    }
    if (moment === "news") {
        // progress from the centre outward, then a pause — the front has to travel and arrive, which is
        // not the same shape as a pulse that rises and falls in place.
        const phase = elapsed % 2.4;
        return { utterance: 0, ripple: phase <= 1.5 ? phase / 1.5 : null, jolt: 0, speaking: false };
    }
    if (moment === "knocked") {
        const phase = elapsed % 2;
        return { utterance: 0, ripple: null, jolt: phase < 0.7 ? Math.exp(-phase * 6) : 0, speaking: false };
    }
    return { utterance: 0, ripple: null, jolt: 0, speaking: false };
}

// ── the avatar ────────────────────────────────────────────────────────────────

/**
 * One avatar, reading its three axes from `state` every frame. Tiles pass a frozen state object and the
 * composite passes the live one, so the same code draws both and there is no second implementation of a
 * state to disagree with.
 */
function avatar(state) {
    return (root, small, materials) => {
        const form = depthForm(root, small);
        // Every posture's marker is built once and hidden; the composite switches posture at runtime and a
        // marker's colour and bearing are fixed at construction.
        const markers = {};
        for (const [key, posture] of Object.entries(POSTURES)) {
            if (posture == null) {
                continue;
            }
            const start = (posture.bearing * Math.PI) / 180 - SECTOR_LENGTH / 2;
            markers[key] = alarmSector(root, small, posture.colour, start, SECTOR_LENGTH);
        }
        const tracer = new THREE.Group();
        form.planes[1].add(tracer);
        arc(tracer, 1.11, -0.32, 0.64, colours.blueHot, small ? 2.6 : 3.2, 1);

        const settled = REGISTERS[state.register];
        const mood = {
            energy: settled.energy,
            align: settled.align,
            jitter: settled.jitter,
            spin: settled.spin,
            sever: settled.sever,
        };
        const body = settled.body.clone();
        const hot = settled.hot.clone();
        let breathPhase = 0;
        let attention = state.posture === "none" ? 0 : 1;
        let face = 0;
        let activeTime = 0;

        return () => {
            const target = REGISTERS[state.register];
            for (const key of MOOD_KEYS) {
                mood[key] = approach(mood[key], target[key], MOOD_TAU);
            }
            const k = 1 - Math.exp(-delta / MOOD_TAU);
            body.lerp(target.body, k);
            hot.lerp(target.hot, k);

            const moment = envelopes(state.moment);
            const quiet = state.moment === "quiet";
            attention = approach(attention, state.posture === "none" ? 0 : 1, 0.16);
            face = approach(face, moment.speaking ? 1 - attention : 0, 0.16);

            // Breath is the idle study 03 chose, and it is the one thing that eases to a stop rather than
            // switching off: the form stays alive until it has something to say, then holds still to say it.
            const calm = Math.max(0, 1 - Math.max(face, attention));
            breathPhase += delta * 0.55 * (0.55 + 0.45 * mood.energy) * calm;
            const wave = Math.sin(breathPhase);
            activeTime += delta * (Math.max(face, attention * 0.15) + moment.utterance * 0.6);

            // align is ring coplanarity: as it falls the three planes come apart and tilt out of the stack,
            // which is decay you can see in the silhouette rather than in the brightness.
            const splay = 1 - mood.align;
            form.planes[0].position.z = -0.38 - splay * 0.3;
            form.planes[2].position.z = 0.32 + face * 0.14 + splay * 0.3;
            form.planes[0].rotation.x = -splay * 0.42;
            form.planes[0].rotation.y = splay * 0.3;
            form.planes[2].rotation.x = splay * 0.34;
            form.planes[2].rotation.y = -splay * 0.24;

            // Production spins the platter faster the healthier it is. Here the chosen idle already owns
            // stillness at rest, so spin is re-read as a tumble that only a form losing its alignment can
            // do — at-rest (align 1) contributes nothing and keeps breathing in place.
            const tumble = mood.spin * splay;
            form.planes[0].rotation.z = -activeTime * 0.04 - elapsed * 0.12 * tumble;
            form.planes[1].rotation.z = activeTime * 0.09 + elapsed * 0.075 * tumble;
            form.planes[2].rotation.z = -activeTime * 0.06 - elapsed * 0.05 * tumble;

            const cut = Math.round(SEVER_ORDER.length * mood.sever);
            SEVER_ORDER.forEach((index, rank) => {
                form.struts[index].visible = rank >= cut;
            });

            // the whole attitude is the signal: three-quarters-on at rest, square-on while speaking, and
            // turned further away while something waits on you.
            root.rotation.set(
                0.2 - face * 0.17 + attention * 0.14,
                -0.28 + face * 0.24 - attention * 0.16,
                -0.06 + face * 0.06
            );
            // Only the jolt moves the form. Jitter used to shake it too, which meant an arrival landing on
            // the avatar and the avatar losing its own signal were saying the same thing in the same
            // channel — and at 132px a 1.5px tremble mostly read as a rendering fault.
            const knock = moment.jolt * 0.09;
            root.position.set(Math.sin(elapsed * 55) * knock, Math.cos(elapsed * 75) * knock * 0.6, 0);
            root.scale.setScalar((1 + 0.03 * calm * wave) * (quiet ? QUIET_SCALE : 1));

            tracer.visible = face > 0.02;
            tracer.rotation.z = activeTime * 1.6;
            for (const [key, marker] of Object.entries(markers)) {
                marker.visible = state.posture === key && attention > 0.01;
                marker.scale.setScalar(0.95 + attention * 0.05);
            }

            tone(materials, body, hot);
            // absolute, and therefore first: everything after this multiplies what it wrote.
            dim(
                materials,
                (0.5 + 0.5 * mood.energy) *
                    (1 - 0.16 * calm * (0.5 - 0.5 * wave)) *
                    (1 - attention * 0.58) *
                    (quiet ? QUIET_DIM : 1)
            );
            if (moment.ripple != null) {
                const front = moment.ripple * RIPPLE_REACH;
                for (const [part, radius] of Object.entries(PART_RADIUS)) {
                    const bell = Math.max(0, 1 - Math.abs(radius - front) / RIPPLE_WIDTH);
                    if (bell > 0) {
                        shade(form.parts[part], 1 + bell * 1.6);
                    }
                }
            }
            if (moment.utterance > 0) {
                // scaled by energy, because `shade` clamps at full opacity: unscaled, a tired avatar that
                // started speaking hit the same ceiling a rested one does and its register vanished for as
                // long as it was talking. A tired voice is quieter.
                const voice = moment.utterance * (0.4 + 0.6 * mood.energy);
                shade(form.parts.core, 1 + voice * 0.7);
                shade(form.parts.front, 1 + voice * 0.4);
            }
            // Jitter, last, because a dropout beats anything that brightened the part it lands on: the
            // parts of the form cut out independently, like a picture losing frames. Instability you can
            // see in one glance at 132px, where a tremble of the same magnitude could not be seen at all.
            if (mood.jitter > 0.005) {
                STUTTER_PARTS.forEach((part, seed) => {
                    const lost = gate(seed) > 1 - mood.jitter * STUTTER_RATE;
                    if (lost) {
                        shade(form.parts[part], 1 - mood.jitter * STUTTER_DEPTH);
                    }
                });
            }
        };
    };
}

// ── page ──────────────────────────────────────────────────────────────────────

function stateOf(element) {
    if (element.dataset.live === "1") {
        return live;
    }
    return {
        register: element.dataset.register ?? "at-rest",
        posture: element.dataset.posture ?? "none",
        moment: element.dataset.moment ?? "none",
    };
}

function syncCopy() {
    const posture = POSTURES[live.posture];
    const moment = MOMENTS[live.moment];
    document.querySelector("#composite-line").textContent = [REGISTERS[live.register].line, posture?.line ?? ""]
        .filter(Boolean)
        .join(" ");
    document.querySelector("#composite-note").textContent = moment.line;
    document.querySelector("#status").textContent =
        [REGISTERS[live.register].name, posture?.name, live.moment === "none" ? null : moment.name]
            .filter(Boolean)
            .join(" · ") || "At rest";
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

function axis(attribute) {
    const buttons = document.querySelectorAll(`[data-${attribute}-pick]`);
    buttons.forEach((button) => {
        button.addEventListener("click", () => {
            live[attribute] = button.dataset[`${attribute}Pick`];
            buttons.forEach((item) => item.setAttribute("aria-pressed", String(item === button)));
            syncCopy();
            redraw();
        });
    });
}

axis("register");
axis("posture");
axis("moment");
toggle("#magnify", "magnify");
toggle("#glance", "glance");
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
    document.querySelectorAll(".viewport").forEach((element) => {
        views.push(createView(element, avatar(stateOf(element)), fail));
    });
    syncCopy();
    syncMotion();
    let previous = performance.now();
    const frame = (now) => {
        if (now - previous >= FRAME_MS) {
            delta = Math.min(now - previous, 100) / 1000;
            previous = now;
            if (!paused && !document.hidden) {
                elapsed += delta;
                redraw();
            }
        }
        frameId = requestAnimationFrame(frame);
    };
    frameId = requestAnimationFrame(frame);
    window.__hudStates = {
        threeRevision: THREE.REVISION,
        get paused() {
            return paused;
        },
        get elapsed() {
            return elapsed;
        },
        get live() {
            return { ...live };
        },
        views: views.length,
        registers: Object.keys(REGISTERS),
        postures: Object.keys(POSTURES),
        moments: Object.keys(MOMENTS),
    };
} catch (error) {
    fail(error);
}
window.addEventListener("pagehide", () => {
    cancelAnimationFrame(frameId);
    views.forEach(disposeView);
});
