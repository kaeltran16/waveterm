// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Shared height reveal for disclosures and banners: owns AnimatePresence, the reduced-motion config and the
// variant, so a pane grows in and out instead of snapping and pushing its neighbours. initial={false} keeps a
// pane already open at mount from replaying. Like PopoverReveal, render it UNCONDITIONALLY and drive `open`; a
// `{open ? <PaneReveal/> : null}` caller defeats the exit. Pass composerReveal for a strip a few dozen pixels
// tall (a banner); the paneReveal default suits a pane several hundred.

import { cn } from "@/util/util";
import { AnimatePresence, MotionConfig, motion, type Variants } from "motion/react";
import { useMemo, useRef, type ReactNode, type RefObject } from "react";
import { paneReveal } from "./motiontokens";

interface PaneRevealProps {
    open: boolean;
    variants?: Variants;
    className?: string;
    children: ReactNode;
}

// motion resolves a height exit from "auto" by setting the pane to its end height to measure it, which clamps the
// scrollTop of an element scroller around it (motion restores only the window's): a pane closing near a feed's
// bottom threw the feed to its clamped place, then the rows slid back. An exit from the pane's px height needs no
// measurement.
function exitFromPx(variants: Variants, pane: RefObject<HTMLDivElement>): Variants {
    const exit = variants.exit;
    if (exit == null || typeof exit !== "object" || !("height" in exit)) {
        return variants;
    }
    return {
        ...variants,
        exit: () =>
            pane.current == null ? exit : { ...exit, height: [pane.current.offsetHeight, exit.height as number] },
    };
}

export function PaneReveal({ open, variants = paneReveal, className, children }: PaneRevealProps) {
    const pane = useRef<HTMLDivElement>(null);
    const resolved = useMemo(() => exitFromPx(variants, pane), [variants]);
    return (
        <MotionConfig reducedMotion="user">
            <AnimatePresence initial={false}>
                {open && (
                    <motion.div
                        ref={pane}
                        variants={resolved}
                        initial="initial"
                        animate="animate"
                        exit="exit"
                        className={cn("overflow-hidden", className)}
                    >
                        {children}
                    </motion.div>
                )}
            </AnimatePresence>
        </MotionConfig>
    );
}
