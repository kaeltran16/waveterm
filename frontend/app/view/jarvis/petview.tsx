// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The avatar: a hologram in window chrome. Thin by design — every decision it draws is made in
// petcondition.ts / petvoice.ts, its geometry is built in avatarscene.ts, and its pixels come from
// avatarthree.ts or avatarcanvas.ts. This file owns only the animation loop and which renderer is live.
//
// Mounted once in cockpit-root, never inside a surface: every surface but Agent unmounts on a nav switch,
// and an avatar that vanished when you changed rooms would be a status glyph, not a presence.
//
// It never draws a number. The nav badge owns the count; the avatar owns the kind (design §3).

import { globalStore } from "@/app/store/jotaiStore";
import type { AgentsViewModel } from "@/app/view/agents/agents";
import { liveWindowAgents, providerPlanUsage } from "@/app/view/agents/agentsviewmodel";
import { attentionAtom } from "@/app/view/agents/attentionstore";
import { memPruneAtom, memPruneLoadedAtom } from "@/app/view/agents/memstore";
import { mergeRateLimitWindows, savedRateLimitsAtom, topProviderUsage } from "@/app/view/agents/ratelimitstore";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { motion, useMotionValue, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { drawSceneToCanvas, resolveTone } from "./avatarcanvas";
import { approachMood, buildAvatarScene, settledMood, type AvatarScene, type RenderMood } from "./avatarscene";
import type { AvatarThree } from "./avatarthree";
import { PetBubble } from "./petbubble";
import { expressionFor, postureFor, type PetSignals } from "./petcondition";
import { indexSignal } from "./petjoin";
import { breathPhase, idleOrbit, impulseEnvelope, JOLT_MS, RIPPLE_MS, utteranceEnvelope } from "./petmotion";
import { PetPeek } from "./petpeek";
import {
    markPetSpoke,
    petBubbleAtom,
    petCornerAtom,
    petEventsAtom,
    petIndexAtom,
    petPeekOpenAtom,
    petSpokeAtAtom,
    petUnreadAtom,
    petWatermarkAtom,
    rememberSaid,
    setPetCorner,
    setPetWatermark,
    type PetCorner,
} from "./petstore";
import { nextUtterance } from "./petvoice";

// pkg/jarvis/attention.go's three kinds. Named here rather than inlined so the mapping to the avatar's
// posture vocabulary is one line to check against the server.
const ATTENTION_GATE = "gate";
const ATTENTION_ESCALATION = "escalation";
const ATTENTION_ASK = "ask";

const PRUNE_REASON_STALE = "stale";

// The one utterance kind that ripples. Punctuation is not decoration on every event — a wave that crossed
// the network for each of the ten kinds would be constant motion and would stop meaning anything. A
// background agent finishing is news travelling through the graph; the rest is Jarvis talking, which the
// ring surge already covers.
const RIPPLE_EVENT_KIND = "bg-agent-done";

// Corner anchors. The insets clear the chrome the avatar would otherwise sit on: the 28px hints footer at
// the bottom, and the nav rail on the left (78px measured, expanded).
//
// Re-measured after the size grew to AVATAR_PX (spec §10 requires it on any size change). At 1920x1032 the
// bottom-right box lands at 1770,860 and covers the Agent surface's terminal (xterm-link-layer over
// xterm-viewport), while on Jarvis and Cockpit it covers only a generic scroll container. So the pet
// design's finding survives the growth: the two corners are blocked on OPPOSITE surfaces, never the same
// one. Bottom-right sits on the Agent terminal and is clear on Jarvis and Cockpit; bottom-left sits on the
// Jarvis Stage's thread list and is clear on Agent and Cockpit. Dragging between them still escapes every
// collision, which is the whole reason the corner pair is the escape hatch and no third corner is needed.
// Only bottom-right was re-probed at the new size; bottom-left rests against the thread list's own x-range
// (86-331), which a 20px growth does not move it out of.
const CORNER_CLASS: Record<PetCorner, string> = {
    "bottom-right": "bottom-[40px] right-[18px]",
    "bottom-left": "bottom-[40px] left-[92px]",
};

// One size for every state. There were two — 112 active and 68 idle — and the idle one compounded with the
// scene's own idle scaling and its own dimming, which put the form the user sees almost all the time at
// under a fifth of its box by area. The helmet-display rule now lives entirely in QUIET_DIM
// (avatarscene.ts), so this is the only size and nothing multiplies it.
const AVATAR_PX = 132;

// The backing store is capped at 2x: past that the bloom's half-resolution targets cost more than the
// softness they buy back.
const MAX_DPR = 2;

function count(items: AttentionItem[], kind: string): number {
    return items.reduce((n, i) => (i.kind === kind ? n + 1 : n), 0);
}

// Every signal the avatar reads. All four ranks are live: `index` is fed by petsources.tsx on a slow
// cadence and stays undefined — "no signal", never "signal absent" — until that read lands.
function usePetSignals(model: AgentsViewModel): PetSignals {
    const agents = useAtomValue(model.agentsAtom);
    const saved = useAtomValue(savedRateLimitsAtom);
    const now = useAtomValue(model.nowAtom);
    const attention = useAtomValue(attentionAtom);
    const prune = useAtomValue(memPruneAtom);
    const pruneLoaded = useAtomValue(memPruneLoadedAtom);
    const index = useAtomValue(petIndexAtom);

    const donuts = mergeRateLimitWindows(providerPlanUsage(liveWindowAgents(agents)), saved, now);
    const top = topProviderUsage(donuts);
    const rateLimit =
        top != null
            ? {
                  provider: top.provider,
                  pct: top.pct,
                  resetAt: donuts.find((d) => d.provider === top.provider)?.fivehour.reset,
              }
            : undefined;

    return {
        index: indexSignal(index),
        rateLimit,
        decay: pruneLoaded
            ? {
                  queueDepth: prune.length,
                  staleNotes: prune.reduce((n, c) => (c.reason === PRUNE_REASON_STALE ? n + 1 : n), 0),
              }
            : undefined,
        attention: {
            reviewGates: count(attention, ATTENTION_GATE),
            escalations: count(attention, ATTENTION_ESCALATION),
            blockedWorkers: count(attention, ATTENTION_ASK),
        },
    };
}

// Nearest corner from where the drag was released. Only the horizontal half of the drop is read: the
// avatar keeps to the bottom edge (see PET_CORNERS), so releasing it high still lands it in the bottom
// corner on that side rather than nowhere.
function cornerAt(x: number): PetCorner {
    return x < window.innerWidth / 2 ? "bottom-left" : "bottom-right";
}

export function PetView({ model }: { model: AgentsViewModel }) {
    const signals = usePetSignals(model);
    const expression = expressionFor(signals);
    const posture = postureFor(signals);
    const corner = useAtomValue(petCornerAtom);
    const bubble = useAtomValue(petBubbleAtom);
    const unread = useAtomValue(petUnreadAtom);
    const peekOpen = useAtomValue(petPeekOpenAtom);
    const events = useAtomValue(petEventsAtom);
    const watermark = useAtomValue(petWatermarkAtom);
    const reduce = useReducedMotion() === true;
    // Both a ref and state for the same element: the bubble and the peek need it as state to re-position
    // when it lands, while the render loop needs it as a ref so acquiring it does not re-run the effect and
    // rebuild the GL context.
    const [anchor, setAnchor] = useState<HTMLDivElement | null>(null);
    const draggingRef = useRef(false);
    const x = useMotionValue(0);
    const y = useMotionValue(0);

    // faint at rest and solid the moment it has something to express — a health indicator you cannot see
    // does not work, so anything but at-rest-and-idle claims full presence (design §3).
    const quiet = expression.kind === "at-rest" && posture === "none" && !peekOpen && bubble == null;
    const size = AVATAR_PX;

    // Two canvases, not one. A canvas element can only ever hand out contexts of a single kind, so a
    // single element that has already produced a webgl2 context can never produce a 2d one — the fallback
    // would silently draw nothing, which is exactly the blank avatar design §8 forbids. Separate elements
    // also keep the WebGL one mounted while the fallback is showing, which is what lets a later
    // webglcontextrestored arrive at all and the primary renderer come back.
    const glCanvasRef = useRef<HTMLCanvasElement | null>(null);
    const fallbackCanvasRef = useRef<HTMLCanvasElement | null>(null);
    const [renderer, setRenderer] = useState<"webgl" | "canvas">("canvas");
    const rendererRef = useRef(renderer);
    rendererRef.current = renderer;

    // Everything the loop needs, in a ref rather than in the closure: the loop is started once per mount,
    // and reading state through a ref keeps a condition change from tearing down the GL context.
    const frameRef = useRef({ expression, posture, quiet, size, reduce });
    frameRef.current = { expression, posture, quiet, size, reduce };

    // The mood actually being drawn, which lags the condition while a change eases in. Seeded settled
    // rather than from at-rest, so booting into a fault shows the fault instead of animating into it —
    // a transition the user was not present for is not a transition, it is a wrong first frame.
    const moodRef = useRef<RenderMood>(settledMood(expression));
    const lastFrameRef = useRef<number | null>(null);

    // When the last punctuation fired. Refs, not state: nothing renders off them, the frame loop reads
    // them directly, and putting them in state would re-render the component sixty times a second.
    const rippleAtRef = useRef<number | null>(null);
    const joltAtRef = useRef<number | null>(null);

    useEffect(() => {
        const glCanvas = glCanvasRef.current;
        const fallbackCanvas = fallbackCanvasRef.current;
        if (glCanvas == null || fallbackCanvas == null) {
            return;
        }
        const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
        // Probe once and never retry (design §8): a driver that could not give a context at boot will not
        // give one a frame later, and retrying per frame would be a stall per frame.
        // three is ~170KB gzip and the cockpit boots without it, so it loads the way the other heavy viz
        // deps here do (memgraph.tsx, jarvisgraph.tsx). The 2D fallback draws the same scene meanwhile,
        // which is why the avatar is never blank waiting for it.
        let gl: AvatarThree | null = null;
        // only used for the frames between the first draw and three resolving; kept equal to
        // DEFAULT_THREE_BLOOM so the avatar does not visibly re-light once the module lands
        let bloom = { strength: 0.35, threshold: 0.4, radius: 0.2 };
        let dropped = false;
        void import("./avatarthree").then((mod) => {
            if (dropped) {
                return;
            }
            bloom = mod.DEFAULT_THREE_BLOOM;
            // Probe once and never retry (design §8): a driver that could not give a context at boot will
            // not give one a frame later, and retrying per frame would be a stall per frame.
            gl = mod.AvatarThree.create(glCanvas, {
                onLost: () => setRenderer("canvas"),
                onRestored: () => setRenderer("webgl"),
            });
            if (gl == null) {
                return;
            }
            gl.resize(Math.round(frameRef.current.size * dpr));
            setRenderer("webgl");
        });
        const ctx2d = fallbackCanvas.getContext("2d");

        let raf = 0;
        let lastPixels = -1;
        // the declaration is live, so a runtime theme change (themestore.ts rewrites these same custom
        // properties on documentElement) still reads through without re-acquiring it
        const rootStyle = getComputedStyle(document.documentElement);
        const read = (name: string) => rootStyle.getPropertyValue(name).trim();

        const frame = (now: number) => {
            const f = frameRef.current;
            const cssSize = f.size;
            const pixels = Math.round(cssSize * dpr);
            if (pixels !== lastPixels) {
                lastPixels = pixels;
                for (const c of [glCanvas, fallbackCanvas]) {
                    c.style.width = cssSize + "px";
                    c.style.height = cssSize + "px";
                    c.width = pixels;
                    c.height = pixels;
                }
                gl?.resize(pixels);
                // assigning width resets the 2D context state, so the dpr transform goes back on after it
                ctx2d?.setTransform(dpr, 0, 0, dpr, 0, 0);
            }

            const orbit = f.reduce ? { yaw: 0, pitch: 0 } : idleOrbit(now);

            const dt = lastFrameRef.current == null ? 0 : now - lastFrameRef.current;
            lastFrameRef.current = now;
            // reduced motion gets the destination immediately: an ease is motion, and the setting means
            // the user does not want any. The register still changes, it just does not travel there.
            moodRef.current = f.reduce ? settledMood(f.expression) : approachMood(moodRef.current, f.expression, dt);

            const rippleAt = rippleAtRef.current;
            const rippleElapsed = rippleAt == null ? null : now - rippleAt;
            const ripple =
                rippleElapsed == null || rippleElapsed < 0 || rippleElapsed >= RIPPLE_MS
                    ? null
                    : rippleElapsed / RIPPLE_MS;

            const scene: AvatarScene = buildAvatarScene({
                expression: f.expression,
                mood: moodRef.current,
                posture: f.posture,
                size: cssSize,
                now,
                yaw: orbit.yaw,
                pitch: orbit.pitch,
                breath: breathPhase(now),
                utterance: utteranceEnvelope(now, globalStore.get(petSpokeAtAtom)),
                ripple,
                jolt: impulseEnvelope(now, joltAtRef.current, JOLT_MS),
                quiet: f.quiet,
                still: f.reduce,
            });

            const colours = resolveTone(scene, read);
            const live = gl != null && !gl.lost && rendererRef.current === "webgl" ? "webgl" : "canvas";
            if (live === "webgl") {
                gl!.draw(scene, cssSize, dpr, colours, bloom);
            } else if (ctx2d != null) {
                drawSceneToCanvas(ctx2d, scene, cssSize, colours);
            }

            // Dev-only: the CDP harness asserts on this instead of on pixels, which is stronger than what
            // the old SVG tree allowed because it can check the whole scene at once. Folded out of
            // production builds — import.meta.env.DEV is statically false there.
            if (import.meta.env.DEV) {
                (window as unknown as { __jarvisAvatarScene?: unknown }).__jarvisAvatarScene = {
                    segments: scene.segments.length,
                    fills: scene.fills.length,
                    toneVar: scene.toneVar,
                    markerVar: scene.markerVar,
                    extent: Math.round(scene.extent),
                    expression: f.expression.kind,
                    posture: f.posture,
                    renderer: live,
                };
            }
            raf = requestAnimationFrame(frame);
        };
        raf = requestAnimationFrame(frame);

        return () => {
            cancelAnimationFrame(raf);
            // the import may still be in flight; the flag is what stops it building a context into a canvas
            // this effect has already let go of
            dropped = true;
            gl?.dispose();
        };
        // Built once, for the lifetime of the mount. Everything the loop needs it reads through a ref, so a
        // condition change, a size change or a renderer swap cannot tear down and rebuild the GL context.
    }, []);

    // Push once per event (design §4 decision 8). Advancing the watermark re-runs this effect, which then
    // finds nothing new — so the loop settles after one push rather than repeating it.
    useEffect(() => {
        const speech = nextUtterance(events, watermark);
        if (speech.watermark == null) {
            return;
        }
        setPetWatermark(speech.watermark);
        if (speech.utterance != null) {
            rememberSaid(speech.utterance);
            globalStore.set(petBubbleAtom, speech.utterance);
            globalStore.set(petUnreadAtom, false); // the bubble itself is the notice
            markPetSpoke(performance.now()); // and the rings surge for it
            if (speech.utterance.kind === RIPPLE_EVENT_KIND) {
                rippleAtRef.current = performance.now();
            }
        }
    }, [events, watermark]);

    // A jolt on arrival only, not while the escalation stands: the posture marker is what holds the state,
    // and a form that kept flinching for as long as something was waiting would be unusable.
    const lastPostureRef = useRef(posture);
    useEffect(() => {
        const was = lastPostureRef.current;
        lastPostureRef.current = posture;
        if (posture === "escalation" && was !== "escalation") {
            joltAtRef.current = performance.now();
        }
    }, [posture]);

    const openPeek = () => {
        globalStore.set(petPeekOpenAtom, true);
        globalStore.set(petUnreadAtom, false);
        globalStore.set(petBubbleAtom, null);
    };

    return (
        <>
            <motion.div
                ref={setAnchor}
                drag
                dragMomentum={false}
                style={{ x, y }}
                // `layout` is what turns the corner swap from a teleport into a move: the corner is a
                // className change (CORNER_CLASS), so there is no animatable property to tween — motion
                // has to measure the before and after boxes itself.
                layout
                initial={reduce ? false : { opacity: 0, scale: 0.55 }}
                animate={{ opacity: quiet ? 0.4 : 1, scale: 1 }}
                whileHover={{ opacity: 1, scale: 1.07 }}
                whileTap={{ scale: 0.93 }}
                transition={
                    reduce
                        ? { duration: 0 }
                        : // a spring for the geometry so the corner move and the tap rebound overshoot
                          // slightly, and a plain tween for opacity, which has nothing to overshoot into
                          {
                              layout: { type: "spring", stiffness: 320, damping: 30 },
                              scale: { type: "spring", stiffness: 420, damping: 26 },
                              opacity: { duration: 0.3 },
                          }
                }
                onDragStart={() => {
                    draggingRef.current = true;
                }}
                onDragEnd={(_, info) => {
                    setPetCorner(cornerAt(info.point.x));
                    x.set(0);
                    y.set(0);
                }}
                onClick={() => {
                    if (draggingRef.current) {
                        draggingRef.current = false;
                        return;
                    }
                    if (peekOpen) {
                        globalStore.set(petPeekOpenAtom, false);
                        return;
                    }
                    openPeek();
                }}
                role="button"
                tabIndex={0}
                // not "Jarvis": the nav rail's entry-two button already owns that name, and the CDP harness
                // navigates by it (scripts/cdp/attach.mjs SURFACE_LABEL). Two controls with one accessible
                // name is ambiguous to a screen reader and makes a by-label query pick whichever comes
                // first in the DOM — which is the nav button, not the avatar.
                aria-label="Jarvis condition"
                onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        openPeek();
                    }
                }}
                // opacity is animated above rather than set here: an inline style beats a utility class,
                // so leaving the quiet/hover opacity in the class list would have left two owners for it
                // and the class would always have lost.
                className={cn(
                    "fixed z-[60] flex cursor-grab items-center justify-center rounded-full outline-none active:cursor-grabbing",
                    CORNER_CLASS[corner]
                )}
            >
                {/* The idle renderer's canvas is hidden rather than unmounted: unmounting the WebGL one
                    would take its context-restored listener with it, and the avatar could never come back
                    off the fallback. Both are the same size, so the wrapper does not resize on a swap. */}
                <canvas ref={glCanvasRef} aria-hidden="true" className={renderer === "webgl" ? "block" : "hidden"} />
                <canvas
                    ref={fallbackCanvasRef}
                    aria-hidden="true"
                    className={renderer === "canvas" ? "block" : "hidden"}
                />
                {/* the unread marker: a kind of thing happened, never how many */}
                {unread ? (
                    <span className="pointer-events-none absolute right-0 top-0 h-[9px] w-[9px] rounded-full border border-background bg-accent" />
                ) : null}
            </motion.div>
            <PetBubble
                event={bubble}
                anchor={anchor}
                corner={corner}
                onOpen={openPeek}
                onDismiss={() => {
                    globalStore.set(petBubbleAtom, null);
                    globalStore.set(petUnreadAtom, true);
                }}
            />
            {/* the peek derives its own ranked condition LIST from the same signals — expressionFor is
                the creature's single face, and passing it here would cap the panel at one condition */}
            <PetPeek model={model} anchor={anchor} corner={corner} signals={signals} />
        </>
    );
}
