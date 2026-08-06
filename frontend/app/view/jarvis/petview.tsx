// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The avatar: a hologram in window chrome. Thin by design — every decision it draws is made in
// petcondition.ts / petvoice.ts, its geometry is built in avatarscene.ts, and its pixels come from
// avatargl.ts or avatarcanvas.ts. This file owns only the animation loop and which renderer is live.
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
import { AvatarGL, DEFAULT_BLOOM } from "./avatargl";
import { buildAvatarScene, type AvatarScene } from "./avatarscene";
import { PetBubble } from "./petbubble";
import { expressionFor, postureFor, type PetSignals } from "./petcondition";
import { indexSignal } from "./petjoin";
import { breathPhase, gazeYawPitch, utteranceEnvelope } from "./petmotion";
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

const YAW_CAP = 0.6;
const PITCH_CAP = 0.34;

// Density, judged on a contact sheet of all four expressions at AVATAR_PX. Three platters is what makes the
// tilt divergence legible as drifting — two read as a coincidence and four are mush at this size. 72 ticks
// leaves each one individually resolvable on the outermost ring, where they are sparsest. 16 nodes is
// enough that severing most of the links at rank 1 still leaves a recognisable network rather than dust.
const RINGS = 3;
const RING_TICKS = 72;
const NODES = 16;

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
    const anchorRef = useRef<HTMLDivElement | null>(null);
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
    const [renderer, setRenderer] = useState<"webgl" | "canvas">("webgl");
    const rendererRef = useRef(renderer);
    rendererRef.current = renderer;
    const pointerRef = useRef<{ x: number; y: number } | null>(null);

    // Everything the loop needs, in a ref rather than in the closure: the loop is started once per mount,
    // and reading state through a ref keeps a condition change from tearing down the GL context.
    const frameRef = useRef({ expression, posture, quiet, size, reduce });
    frameRef.current = { expression, posture, quiet, size, reduce };

    // The avatar's centre, for the gaze. Measured behind a flag rather than every frame: a
    // getBoundingClientRect inside the loop is a forced layout sixty times a second in a window whose other
    // surfaces are live terminals, and the only things that move the avatar are a corner change, a resize
    // and the quiet/active size change.
    const centreRef = useRef<{ x: number; y: number } | null>(null);
    const needMeasureRef = useRef(true);

    useEffect(() => {
        needMeasureRef.current = true;
    }, [corner, size, anchor]);

    useEffect(() => {
        const glCanvas = glCanvasRef.current;
        const fallbackCanvas = fallbackCanvasRef.current;
        if (glCanvas == null || fallbackCanvas == null) {
            return;
        }
        const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
        // Probe once and never retry (design §8): a driver that could not give a context at boot will not
        // give one a frame later, and retrying per frame would be a stall per frame.
        const gl = AvatarGL.create(glCanvas, {
            onLost: () => setRenderer("canvas"),
            onRestored: () => setRenderer("webgl"),
        });
        const ctx2d = fallbackCanvas.getContext("2d");
        if (gl == null) {
            setRenderer("canvas");
        }

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
                needMeasureRef.current = true;
            }

            const anchorEl = anchorRef.current;
            if (needMeasureRef.current && anchorEl != null) {
                const rect = anchorEl.getBoundingClientRect();
                centreRef.current = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
                needMeasureRef.current = false;
            }

            const centre = centreRef.current;
            const pointer = pointerRef.current;
            const gaze =
                pointer == null || centre == null || f.reduce
                    ? { yaw: 0, pitch: 0 }
                    : gazeYawPitch(centre.x, centre.y, pointer.x, pointer.y, YAW_CAP, PITCH_CAP);

            const scene: AvatarScene = buildAvatarScene({
                expression: f.expression,
                posture: f.posture,
                size: cssSize,
                now,
                yaw: gaze.yaw,
                pitch: gaze.pitch,
                breath: breathPhase(now),
                utterance: utteranceEnvelope(now, globalStore.get(petSpokeAtAtom)),
                quiet: f.quiet,
                rings: RINGS,
                ringTicks: RING_TICKS,
                nodes: NODES,
                shell: true,
                still: f.reduce,
            });

            const colours = resolveTone(scene, read);
            const live = gl != null && !gl.lost && rendererRef.current === "webgl" ? "webgl" : "canvas";
            if (live === "webgl") {
                gl!.draw(scene, cssSize, dpr, colours, DEFAULT_BLOOM);
            } else if (ctx2d != null) {
                drawSceneToCanvas(ctx2d, scene, cssSize, colours);
            }

            // Dev-only: the CDP harness asserts on this instead of on pixels, which is stronger than what
            // the old SVG tree allowed because it can check the whole scene at once. Folded out of
            // production builds — import.meta.env.DEV is statically false there.
            if (import.meta.env.DEV) {
                (window as unknown as { __jarvisAvatarScene?: unknown }).__jarvisAvatarScene = {
                    segments: scene.segments.length,
                    points: scene.points.length,
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

        const onMove = (ev: PointerEvent) => {
            pointerRef.current = { x: ev.clientX, y: ev.clientY };
        };
        const onResize = () => {
            needMeasureRef.current = true;
        };
        window.addEventListener("pointermove", onMove);
        window.addEventListener("resize", onResize);
        return () => {
            cancelAnimationFrame(raf);
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("resize", onResize);
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
        }
    }, [events, watermark]);

    const openPeek = () => {
        globalStore.set(petPeekOpenAtom, true);
        globalStore.set(petUnreadAtom, false);
        globalStore.set(petBubbleAtom, null);
    };

    return (
        <>
            <motion.div
                ref={(el) => {
                    anchorRef.current = el;
                    setAnchor(el);
                }}
                drag
                dragMomentum={false}
                style={{ x, y }}
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
                className={cn(
                    "fixed z-[60] flex cursor-grab items-center justify-center rounded-full outline-none active:cursor-grabbing",
                    "transition-opacity duration-300 hover:opacity-100 focus-visible:opacity-100",
                    quiet ? "opacity-40" : "opacity-100",
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
            <PetPeek
                model={model}
                anchor={anchor}
                corner={corner}
                signals={signals}
                expression={expression}
            />
        </>
    );
}
