// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Step swap (moment 10): content that moves forward or back through a sequence (question N -> N+1, the next
// screenshot, another board) slides out and in along x, the direction from `dir` (+1 next, -1 previous). A new
// `stepKey` plays it; mode="wait" lets the old step leave before the new one arrives, so the two never overlap,
// and initial={false} keeps the first step from sliding in on mount. Under reduced motion the step swaps at once.

import { atoms } from "@/app/store/global";
import { useAtomValue } from "jotai";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import type { ReactNode } from "react";
import { stepSlide } from "./motiontokens";

interface StepSwapProps {
    stepKey: string | number;
    dir: number;
    className?: string;
    children: ReactNode;
}

export function StepSwap({ stepKey, dir, className, children }: StepSwapProps) {
    // Framer's reducedMotion drops only the x; the fade through an empty frame would remain, so swap plainly. The
    // atom, unlike motion's useReducedMotion, follows a preference that changes while mounted
    const reduce = useAtomValue(atoms.prefersReducedMotionAtom);
    if (reduce) {
        return (
            <div key={stepKey} className={className}>
                {children}
            </div>
        );
    }
    return (
        <MotionConfig reducedMotion="user">
            <AnimatePresence initial={false} mode="wait" custom={dir}>
                <motion.div
                    key={stepKey}
                    custom={dir}
                    variants={stepSlide}
                    initial="initial"
                    animate="animate"
                    exit="exit"
                    className={className}
                >
                    {children}
                </motion.div>
            </AnimatePresence>
        </MotionConfig>
    );
}
