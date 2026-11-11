// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// A peek body's content arrives in pieces (the run's graph, the agent's git read, the digest), so a section that
// shows up after the body mounted, or content swapped under a new `fadeKey`, fades in (viewFade) instead of
// cutting in. What is already there at mount shows at once, and reduced motion never fades. No AnimatePresence:
// viewFade has no exit, so the old content leaves at once and two never stack (AutoHeight would measure both).

import { viewFade } from "@/app/element/motiontokens";
import { atoms } from "@/app/store/global";
import { useAtomValue } from "jotai";
import { motion } from "motion/react";
import { useEffect, useRef, type ReactNode } from "react";

export function PeekFade({
    fadeKey = "shown",
    className,
    children,
}: {
    fadeKey?: string;
    className?: string;
    children: ReactNode;
}) {
    const reduce = useAtomValue(atoms.prefersReducedMotionAtom);
    const mounted = useRef(false);
    useEffect(() => {
        mounted.current = true;
    }, []);
    if (children == null || children === false) {
        return null;
    }
    return (
        <motion.div
            key={fadeKey}
            data-peek-fade={fadeKey}
            variants={viewFade}
            initial={mounted.current && !reduce ? "initial" : false}
            animate="animate"
            className={className}
        >
            {children}
        </motion.div>
    );
}
