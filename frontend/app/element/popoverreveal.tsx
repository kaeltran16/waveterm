// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Shared reveal for cockpit dropdown/popover panels. Wraps ONLY the panel: owns AnimatePresence, the
// reduced-motion config, the popoverReveal variant, and the transform-origin so the panel scales from
// its anchor corner. Positioning (absolute / z-index) and any backdrop click-catcher stay with the
// caller — they legitimately differ per site. Rendering must be UNCONDITIONAL (drive `open`) so the
// exit animation can play; a `{open ? <PopoverReveal/> : null}` caller defeats AnimatePresence.

import { AnimatePresence, MotionConfig, motion } from "motion/react";
import type { ReactNode } from "react";
import { popoverReveal } from "./motiontokens";

interface PopoverRevealProps {
    open: boolean;
    origin: string; // CSS transform-origin, e.g. "top right" / "bottom left"
    className?: string; // caller's positioning + styling classes for the panel
    children: ReactNode;
}

export function PopoverReveal({ open, origin, className, children }: PopoverRevealProps) {
    return (
        <MotionConfig reducedMotion="user">
            <AnimatePresence>
                {open && (
                    <motion.div
                        variants={popoverReveal}
                        initial="initial"
                        animate="animate"
                        exit="exit"
                        style={{ transformOrigin: origin }}
                        className={className}
                    >
                        {children}
                    </motion.div>
                )}
            </AnimatePresence>
        </MotionConfig>
    );
}
