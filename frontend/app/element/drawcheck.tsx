// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Draw check (moment 16): a check whose stroke draws on when `done` turns true while mounted, saying "this just
// finished"; a check mounted already done is drawn, and reduced motion draws it at once. Render it
// unconditionally and drive `done`. The same 12x12 check path brainstormui.tsx inlines; color via className.

import { atoms } from "@/app/store/global";
import { useAtomValue } from "jotai";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { drawCheck } from "./motiontokens";

const CHECK_PATH = "M2.5 6.5l2.5 2.5 4.5-6";
const CHECK_SIZE = 11;
const CHECK_STROKE = 1.8;

export function DrawCheck({ done, className }: { done: boolean; className?: string }) {
    const reduce = useAtomValue(atoms.prefersReducedMotionAtom);
    return (
        <MotionConfig reducedMotion="user">
            <AnimatePresence initial={false}>
                {done && (
                    <motion.svg
                        key="check"
                        width={CHECK_SIZE}
                        height={CHECK_SIZE}
                        viewBox="0 0 12 12"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth={CHECK_STROKE}
                        className={className}
                        initial={reduce ? false : "hidden"}
                        animate="drawn"
                    >
                        {/* no initial/animate of its own: it inherits the svg's, so initial={false} reaches it */}
                        <motion.path d={CHECK_PATH} variants={drawCheck} />
                    </motion.svg>
                )}
            </AnimatePresence>
        </MotionConfig>
    );
}
