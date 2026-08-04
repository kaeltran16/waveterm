// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The creature: a small eyed blob in window chrome. Thin by design — every decision it draws is made in
// petcondition.ts / petvoice.ts, so this file can be replaced by a different renderer (three.js was
// deferred, not ruled out) without touching what Jarvis's condition *is*.
//
// Mounted once in cockpit-root, never inside a surface: every surface but Agent unmounts on a nav
// switch, and a creature that vanished when you changed rooms would be a status glyph, not a presence.
//
// It never draws a number. The nav badge owns the count; the creature owns the kind (design §3) — which
// is what makes keeping both indicators de-duplication rather than redundancy.

import { globalStore } from "@/app/store/jotaiStore";
import type { AgentsViewModel } from "@/app/view/agents/agents";
import { liveWindowAgents, providerPlanUsage } from "@/app/view/agents/agentsviewmodel";
import { attentionAtom } from "@/app/view/agents/attentionstore";
import { memPruneAtom, memPruneLoadedAtom } from "@/app/view/agents/memstore";
import {
    mergeRateLimitWindows,
    savedRateLimitsAtom,
    topProviderUsage,
} from "@/app/view/agents/ratelimitstore";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { motion, useMotionValue, useReducedMotion, type MotionValue } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { PetBubble } from "./petbubble";
import { expressionFor, postureFor, type PetExpression, type PetPosture, type PetSignals } from "./petcondition";
import { indexSignal } from "./petjoin";
import { eyeRoom, gazeOffset, nextBlinkDelay } from "./petmotion";
import { PetPeek } from "./petpeek";
import {
    petBubbleAtom,
    petCornerAtom,
    petEventsAtom,
    petIndexAtom,
    petPeekOpenAtom,
    petUnreadAtom,
    petWatermarkAtom,
    rememberSaid,
    setPetCorner,
    setPetWatermark,
    type PetCorner,
} from "./petstore";
import { nextUtterance } from "./petvoice";

// pkg/jarvis/attention.go's three kinds. Named here rather than inlined so the mapping to the pet's
// posture vocabulary is one line to check against the server.
const ATTENTION_GATE = "gate";
const ATTENTION_ESCALATION = "escalation";
const ATTENTION_ASK = "ask";

// The candidate reason memgarden flags weakly; the strong one is "superseded". Both sit in the same
// queue, so staleNotes is a subset of queueDepth, never a second count.
const PRUNE_REASON_STALE = "stale";

// Corner anchors. The insets clear the chrome the creature would otherwise sit on: the 28px hints footer
// at the bottom, and the nav rail on the left (78px measured, expanded).
const CORNER_CLASS: Record<PetCorner, string> = {
    "bottom-right": "bottom-[40px] right-[18px]",
    "bottom-left": "bottom-[40px] left-[92px]",
};

const PET_PX = 44;

// The silhouette per expression. Severity reads in the body tone before you have parsed the shape:
// error for the worst thing that can be true, warning for the body clock, muted for slow drift, accent
// at rest.
interface PetShape {
    bodyRx: number;
    bodyRy: number;
    bodyCy: number;
    eyeRx: number;
    eyeRy: number;
    pupilDy: number;
    tone: string; // a var(--color-*) reference — never a literal, or the creature leaves every theme
}

const SHAPES: Record<PetExpression["kind"], PetShape> = {
    // narrowed lids, upright and tense: peering at something it can no longer resolve
    "cannot-see": { bodyRx: 17, bodyRy: 15.5, bodyCy: 25.5, eyeRx: 5, eyeRy: 1.2, pupilDy: 0, tone: "var(--color-error)" },
    // droop: the body sags and spreads, the gaze drops
    tired: { bodyRx: 18, bodyRy: 13, bodyCy: 29, eyeRx: 4.4, eyeRy: 2.2, pupilDy: 0.9, tone: "var(--color-warning)" },
    // slump: flatter still, looking down
    drifting: { bodyRx: 19, bodyRy: 12.5, bodyCy: 30, eyeRx: 4, eyeRy: 3.4, pupilDy: 1.4, tone: "var(--color-muted)" },
    "at-rest": { bodyRx: 17, bodyRy: 16, bodyCy: 25, eyeRx: 4.4, eyeRy: 4.4, pupilDy: 0, tone: "var(--color-accent-500)" },
};

// Posture is a lean plus an outline, never a count: which kind of waiting, not how much of it.
const LEANS: Record<PetPosture, { rotate: number; y: number; ring: string | undefined }> = {
    "review-gate": { rotate: -8, y: 0, ring: "var(--color-accent)" },
    escalation: { rotate: 8, y: -1.5, ring: "var(--color-error)" },
    "blocked-worker": { rotate: 0, y: 2, ring: "var(--color-asking)" },
    none: { rotate: 0, y: 0, ring: undefined },
};

// Module constants so a re-render (nowAtom ticks every second) cannot restart the breathing loop.
const BASE_ORIGIN = { originX: 0.5, originY: 1 };
// Counter-phased rather than a uniform scale: the volume is roughly conserved, so it reads as a body
// drawing breath instead of a shape being zoomed. The pivot is the base, so it rises off it.
const IDLE_BREATH = { scaleX: [1, 0.985, 1], scaleY: [1, 1.045, 1] };
const IDLE_STILL = { scaleX: 1, scaleY: 1 };
const IDLE_TRANSITION = { duration: 4.2, repeat: Infinity, ease: "easeInOut" as const };
const SHAPE_TRANSITION = { duration: 0.5, ease: "easeOut" as const };
// Posture springs while the silhouette morph eases. Overshoot on a lean reads as weight settling; the same
// overshoot on the body's rx/ry reads as jelly.
const LEAN_TRANSITION = { type: "spring" as const, stiffness: 210, damping: 14, mass: 0.55 };
const EYE_CY_OFFSET = 4;
const EYE_DX = 6.5;
const PUPIL_R = 1.9;
// A lid this narrow has no blink to show and hides its pupil anyway, so both are gated on it.
const SLIT_EYE_RY = 2;
// Well inside the 2.5 units the widest lid would allow: the gaze should be noticed as life, not as an eye
// moving. eyeRoom narrows it further for whatever the current expression has already spent.
const GAZE_CAP = 1.5;

// The pool the creature sits in. A cast shadow would have to be darker than --color-background (#0c0e11) to
// read at all and there is no darker token, so this is a pool tinted with the body's own tone — which works
// on a dark surface and still themes, being the same var the body fills with.
const POOL_OPACITY = 0.2;
const POOL_BREATH = { scaleX: [1, 0.93, 1], opacity: [POOL_OPACITY, POOL_OPACITY * 0.7, POOL_OPACITY] };
const POOL_STILL = { scaleX: 1, opacity: POOL_OPACITY };
const POOL_DROP = 1.6; // below the body's base, so the two meet rather than overlap
const POOL_RY = 1.5;
const POOL_RX_SCALE = 0.78;

const BLINK_CLOSED = 0.08;
const BLINK_CLOSE_MS = 90;
const BLINK_TRANSITION = { duration: BLINK_CLOSE_MS / 1000, ease: "easeOut" as const };

function count(items: AttentionItem[], kind: string): number {
    return items.reduce((n, i) => (i.kind === kind ? n + 1 : n), 0);
}

// Every signal the creature reads. All four ranks are live: `index` is fed by petsources.tsx on a slow
// cadence, and stays undefined — "no signal", never "signal absent" — until that read lands or if it
// reports a state this build does not recognise.
function usePetSignals(model: AgentsViewModel): PetSignals {
    const agents = useAtomValue(model.agentsAtom);
    const saved = useAtomValue(savedRateLimitsAtom);
    const now = useAtomValue(model.nowAtom);
    const attention = useAtomValue(attentionAtom);
    const prune = useAtomValue(memPruneAtom);
    const pruneLoaded = useAtomValue(memPruneLoadedAtom);
    const index = useAtomValue(petIndexAtom);

    // the same merged (live-over-saved) per-provider windows the app-bar gauge reads, collapsed by the
    // same topProviderUsage — so the creature is tired about the number the gauge is showing.
    const donuts = mergeRateLimitWindows(providerPlanUsage(liveWindowAgents(agents)), saved, now);
    const top = topProviderUsage(donuts);
    const rateLimit =
        top != null
            ? { pct: top.pct, resetAt: donuts.find((d) => d.provider === top.provider)?.fivehour.reset }
            : undefined;

    return {
        index: indexSignal(index),
        rateLimit,
        // absent until a read has landed: loadPrune empties the queue on failure, so an unguarded
        // prune.length would report a clean vault it never actually read
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
// creature keeps to the bottom edge (see PET_CORNERS), so releasing it high still lands it in the bottom
// corner on that side rather than nowhere.
function cornerAt(x: number): PetCorner {
    return x < window.innerWidth / 2 ? "bottom-left" : "bottom-right";
}

function Blob({
    shape,
    lean,
    reduce,
    slit,
    blinking,
    gazeX,
    gazeY,
}: {
    shape: PetShape;
    lean: (typeof LEANS)[PetPosture];
    reduce: boolean;
    slit: boolean;
    blinking: boolean;
    gazeX: MotionValue<number>;
    gazeY: MotionValue<number>;
}) {
    const eyeCy = shape.bodyCy - EYE_CY_OFFSET;
    return (
        <svg viewBox="0 0 48 48" width={PET_PX} height={PET_PX} aria-hidden="true">
            {/* The pool sits OUTSIDE the breathing group, for two separate reasons. It has to stay planted
                while the body rises off it, because that contrast is what reads as a lift rather than a
                zoom. And motion writes transform-origin from originX/originY as fractions of the group's
                fill box, so a child extending that box downward would drag the breath's pivot off the
                body's base. Its own group takes the default centre origin, so it widens symmetrically. */}
            <motion.g animate={reduce ? POOL_STILL : POOL_BREATH} transition={IDLE_TRANSITION}>
                <motion.ellipse
                    cx={24}
                    ry={POOL_RY}
                    animate={{ cy: shape.bodyCy + shape.bodyRy + POOL_DROP, rx: shape.bodyRx * POOL_RX_SCALE }}
                    transition={SHAPE_TRANSITION}
                    fill={shape.tone}
                />
            </motion.g>
            {/* Pivot at the blob's base, so breathing grows upward from it and the posture lean tips the
                whole silhouette. Rotating a near-circular body about its centre instead would move only
                the eyes, which is most of the posture's legibility gone.

                It has to be motion's originX/originY, not a CSS transformOrigin: motion sets
                transform-box: fill-box on SVG children and writes transform-origin itself from those two
                props (defaulting to the centre), so a style transformOrigin is silently overwritten.
                As fractions of the fill box they also stay correct while the body's rx/ry animate. */}
            <motion.g animate={reduce ? IDLE_STILL : IDLE_BREATH} transition={IDLE_TRANSITION} style={BASE_ORIGIN}>
                <motion.g
                    animate={{ rotate: lean.rotate, y: lean.y }}
                    transition={reduce ? SHAPE_TRANSITION : LEAN_TRANSITION}
                    style={BASE_ORIGIN}
                >
                    <motion.ellipse
                        cx={24}
                        animate={{ cy: shape.bodyCy, rx: shape.bodyRx, ry: shape.bodyRy }}
                        transition={SHAPE_TRANSITION}
                        fill={shape.tone}
                        stroke={lean.ring}
                        strokeWidth={lean.ring ? 1.6 : 0}
                    />
                    {[-EYE_DX, EYE_DX].map((dx) => (
                        // The blink scales the eye as a whole instead of animating the lid's ry, which the
                        // expression is already animating — two writers on one value fight, and the
                        // expression would win at the end of every blink. Default centre origin: the lid
                        // closes onto itself, taking the pupil with it.
                        <motion.g
                            key={dx}
                            animate={{ scaleY: blinking ? BLINK_CLOSED : 1 }}
                            transition={BLINK_TRANSITION}
                        >
                            <motion.ellipse
                                cx={24 + dx}
                                animate={{ cy: eyeCy, rx: shape.eyeRx, ry: shape.eyeRy }}
                                transition={SHAPE_TRANSITION}
                                fill="var(--color-primary)"
                            />
                            {/* gaze is a transform (x/y) while the droop is the cy attribute, so the two
                                compose instead of overwriting each other */}
                            <motion.circle
                                cx={24 + dx}
                                r={PUPIL_R}
                                animate={{ cy: eyeCy + shape.pupilDy, opacity: slit ? 0 : 1 }}
                                transition={SHAPE_TRANSITION}
                                style={{ x: gazeX, y: gazeY }}
                                fill="var(--color-background)"
                            />
                        </motion.g>
                    ))}
                </motion.g>
            </motion.g>
        </svg>
    );
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
    const [anchor, setAnchor] = useState<HTMLDivElement | null>(null);
    // a drag ends with a click on the same element; without this, moving the creature would also open
    // its peek. onDragStart only fires past motion's drag threshold, so a plain click never sets it.
    const draggingRef = useRef(false);
    const x = useMotionValue(0);
    const y = useMotionValue(0);

    const shape = SHAPES[expression.kind];
    const slit = shape.eyeRy < SLIT_EYE_RY;
    const room = eyeRoom(shape.eyeRx, shape.eyeRy, shape.pupilDy, PUPIL_R, GAZE_CAP);
    const gazeX = useMotionValue(0);
    const gazeY = useMotionValue(0);
    const [blinking, setBlinking] = useState(false);
    const pointerRef = useRef<{ x: number; y: number } | null>(null);

    // Gaze rides motion values rather than React state: a pointermove handler that re-rendered would put a
    // render on every mouse move, in a window whose other surfaces are live terminals. The creature's rect
    // is measured once per effect run rather than per move — a getBoundingClientRect on each pointermove is
    // a forced layout, and the only things that move it are a corner change and a resize.
    useEffect(() => {
        if (reduce) {
            gazeX.set(0);
            gazeY.set(0);
            return;
        }
        let rect = anchor?.getBoundingClientRect() ?? null;
        const measure = () => {
            rect = anchor?.getBoundingClientRect() ?? null;
        };
        const apply = () => {
            const pointer = pointerRef.current;
            if (rect == null || pointer == null) {
                return;
            }
            const gaze = gazeOffset(
                rect.left + rect.width / 2,
                rect.top + rect.height / 2,
                pointer.x,
                pointer.y,
                room.maxX,
                room.maxY
            );
            gazeX.set(gaze.dx);
            gazeY.set(gaze.dy);
        };
        // re-clamp against the room the new expression left, instead of holding a deflection its lid can no
        // longer contain until the pointer happens to move again
        apply();
        const onMove = (e: PointerEvent) => {
            pointerRef.current = { x: e.clientX, y: e.clientY };
            apply();
        };
        window.addEventListener("pointermove", onMove);
        window.addEventListener("resize", measure);
        return () => {
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("resize", measure);
        };
    }, [anchor, corner, reduce, room.maxX, room.maxY, gazeX, gazeY]);

    // A self-rescheduling timer rather than a keyframe loop, because the interval has to be irregular
    // (nextBlinkDelay) and a repeating animation can only be periodic.
    useEffect(() => {
        if (reduce || slit) {
            setBlinking(false);
            return;
        }
        let closeTimer: ReturnType<typeof setTimeout> | undefined;
        let nextTimer: ReturnType<typeof setTimeout> | undefined;
        const schedule = () => {
            nextTimer = setTimeout(() => {
                setBlinking(true);
                closeTimer = setTimeout(() => {
                    setBlinking(false);
                    schedule();
                }, BLINK_CLOSE_MS);
            }, nextBlinkDelay(Math.random()));
        };
        schedule();
        return () => {
            clearTimeout(nextTimer);
            clearTimeout(closeTimer);
        };
    }, [reduce, slit]);

    // Push once per event (design §4 decision 8). Advancing the watermark re-runs this effect, which
    // then finds nothing new — so the loop settles after one push rather than repeating it.
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
        }
    }, [events, watermark]);

    const openPeek = () => {
        globalStore.set(petPeekOpenAtom, true);
        globalStore.set(petUnreadAtom, false);
        globalStore.set(petBubbleAtom, null);
    };

    // faint at rest and solid the moment it has something to express — a health indicator you cannot
    // see does not work, so anything but at-rest-and-idle claims full presence (design §3).
    const quiet = expression.kind === "at-rest" && posture === "none" && !peekOpen && bubble == null;

    return (
        <>
            <motion.div
                ref={setAnchor}
                drag
                dragMomentum={false}
                style={{ x, y }}
                onDragStart={() => {
                    draggingRef.current = true;
                }}
                onDragEnd={(_, info) => {
                    setPetCorner(cornerAt(info.point.x));
                    // the CSS anchor moves, so the drag transform has to go with it or the creature
                    // lands one whole viewport away from the corner it was dropped in
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
                // first in the DOM — which is the nav button, not the creature.
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
                <Blob
                    shape={shape}
                    lean={LEANS[posture]}
                    reduce={reduce}
                    slit={slit}
                    blinking={blinking}
                    gazeX={gazeX}
                    gazeY={gazeY}
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
                posture={posture}
            />
        </>
    );
}
