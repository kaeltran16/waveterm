// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// A count that slide-swaps its digits when the value changes. Used by the cockpit header and rail.

import { cn } from "@/util/util";
import { MOTION } from "@/app/element/motiontokens";
import { AnimatePresence, motion } from "motion/react";

// A count that slide-swaps its digits when the value changes (moment: a count ticking is a state
// change worth making legible). Under reduced motion, MotionConfig drops the y transform → crossfade.
export function RollingCount({ value, className }: { value: number; className?: string }) {
    return (
        <span className={cn("relative inline-flex justify-center overflow-hidden tabular-nums", className)}>
            <AnimatePresence mode="popLayout" initial={false}>
                <motion.span
                    key={value}
                    initial={{ y: "-70%", opacity: 0 }}
                    animate={{ y: "0%", opacity: 1 }}
                    exit={{ y: "70%", opacity: 0 }}
                    transition={{ duration: MOTION.durMicro, ease: MOTION.easeFluid }}
                    className="inline-block"
                >
                    {value}
                </motion.span>
            </AnimatePresence>
        </span>
    );
}
