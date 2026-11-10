// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// A pane trading what it shows (a phase, loading -> loaded, a removed state): a new `fadeKey` fades the new content
// in (viewFade). Only a swap while mounted fades, so opening the view shows what it holds at once, and reduced
// motion never fades. No AnimatePresence: viewFade has no exit, so the old content leaves at once and two never
// stack in the flow.

import { atoms } from "@/app/store/global";
import { useAtomValue } from "jotai";
import { motion } from "motion/react";
import { useEffect, useRef, type ReactNode } from "react";
import { viewFade } from "./motiontokens";

export function ViewFade({
    fadeKey,
    className,
    children,
}: {
    fadeKey: string;
    className?: string;
    children: ReactNode;
}) {
    const reduce = useAtomValue(atoms.prefersReducedMotionAtom);
    const mounted = useRef(false);
    useEffect(() => {
        mounted.current = true;
    }, []);
    return (
        <motion.div
            key={fadeKey}
            data-view-fade={fadeKey}
            variants={viewFade}
            initial={mounted.current && !reduce ? "initial" : false}
            animate="animate"
            className={className}
        >
            {children}
        </motion.div>
    );
}
