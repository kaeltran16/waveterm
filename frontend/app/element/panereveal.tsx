// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Shared disclosure reveal: a pane opening under its toggle grows in height and fades, so the content
// below is pushed rather than jumped. Rendering must be UNCONDITIONAL (drive `open`) so the exit can
// play. initial={false}: a pane already open on mount does not replay its reveal. A strip a few dozen
// pixels tall passes composerReveal; paneReveal's macro duration is for anything taller.

import { cn } from "@/util/util";
import { AnimatePresence, MotionConfig, motion, type Variants } from "motion/react";
import type { ReactNode } from "react";
import { paneReveal } from "./motiontokens";

interface PaneRevealProps {
    open: boolean;
    variants?: Variants;
    className?: string;
    children: ReactNode;
}

export function PaneReveal({ open, variants = paneReveal, className, children }: PaneRevealProps) {
    return (
        <MotionConfig reducedMotion="user">
            <AnimatePresence initial={false}>
                {open && (
                    <motion.div
                        variants={variants}
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
