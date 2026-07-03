// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Single source of truth for cockpit motion. Feel = "Fluid" (calm): macro moments
// ~360ms on a gentle ease-out; micro-interactions stay fast. See
// docs/superpowers/specs/2026-07-03-cockpit-motion-system-design.md.
import type { Variants } from "motion/react";

export const MOTION = {
    durMacro: 0.36, // entrances, reflow
    durMicro: 0.14, // feedback, composer reveal
    durExit: 0.28, // exits leave a touch quicker than they arrive
    easeFluid: [0.22, 1, 0.36, 1] as [number, number, number, number],
} as const;

// Card entrance/exit. IMPORTANT: opacity + scale only — never x/y. Reorder.Item
// owns the x/y transform for drag + reorder; animating y here fights it.
export const cardVariants: Variants = {
    initial: { opacity: 0, scale: 0.97 },
    animate: { opacity: 1, scale: 1, transition: { duration: MOTION.durMacro, ease: MOTION.easeFluid } },
    exit: { opacity: 0, scale: 0.96, transition: { duration: MOTION.durExit, ease: MOTION.easeFluid } },
};

// Modal open/close (shared-modals surface). Scrim cross-fades; blur is static (animating
// backdrop-filter is a perf trap). Panel reuses the card entrance signature (moment 1).
export const modalBackdrop: Variants = {
    initial: { opacity: 0 },
    animate: { opacity: 1, transition: { duration: MOTION.durMicro, ease: MOTION.easeFluid } },
    exit: { opacity: 0, transition: { duration: MOTION.durExit, ease: MOTION.easeFluid } },
};

// Panel reuses moment 1's opacity+scale signature — one source of feel for cards and modals.
export const modalPanel = cardVariants;

// Corner-resize follow. The drag sets the target height instantly; this spring is what the eye tracks,
// so it eases without lag and settles on release instead of snapping. Stiff + well-damped = responsive,
// no wobble. Bound to style.height via useSpring, so it runs off React (no per-frame re-render).
export const resizeSpring = { stiffness: 700, damping: 46, mass: 1 } as const;

// Lift on grab (moment 8). Drop-settle is the Reorder.Item dragTransition already in place.
// Black shadow alpha (not a brand color) — matches the existing shadow-[...rgba(0,0,0,...)] usage.
export const reorderLift = { scale: 1.02, boxShadow: "0 12px 30px rgba(0,0,0,0.45)" };

// Composer reveal (moment 6): expand height + fade in.
export const composerReveal: Variants = {
    initial: { opacity: 0, height: 0 },
    animate: { opacity: 1, height: "auto", transition: { duration: MOTION.durMicro, ease: MOTION.easeFluid } },
    exit: { opacity: 0, height: 0, transition: { duration: MOTION.durMicro, ease: MOTION.easeFluid } },
};

// Narration burst guard (moment 5): only prose/user turns fade in. Tool-action bursts
// never animate, so a fast stream of tool lines cannot strobe.
const NARRATED_KINDS = new Set(["message", "user"]);
export function shouldFadeEntry(kind: string): boolean {
    return NARRATED_KINDS.has(kind);
}
