// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// View swap: a pane trading what it shows (another face, loading -> loaded, a filtered list) fades the new view
// in, keyed on `swapKey`. The view drawn when this mounts does not fade, so opening a populated pane plays
// nothing; only a swap while it is on screen does. No AnimatePresence: viewFade has no exit, so the old view
// leaves at once and two never stack in the flow.

import { motion, MotionConfig, PresenceContext } from "motion/react";
import { useContext, useEffect, useMemo, useRef, type ReactNode } from "react";
import { viewFade } from "./motiontokens";

interface ViewSwapProps {
    swapKey: string;
    className?: string;
    children: ReactNode;
}

export function ViewSwap({ swapKey, className, children }: ViewSwapProps) {
    // read only when a keyed view mounts, so it is false for the first view and true for every swap after
    const mounted = useRef(false);
    useEffect(() => {
        mounted.current = true;
    }, []);
    // an ancestor AnimatePresence initial={false} keeps initial:false in its context for the child's whole life,
    // which would mount every later view already opaque; this guard decides instead, and exits still register
    const presence = useContext(PresenceContext);
    const unblocked = useMemo(() => (presence == null ? null : { ...presence, initial: undefined }), [presence]);
    return (
        <MotionConfig reducedMotion="user">
            <PresenceContext.Provider value={unblocked}>
                <motion.div
                    key={swapKey}
                    data-view-swap={swapKey}
                    variants={viewFade}
                    initial={mounted.current ? "initial" : false}
                    animate="animate"
                    className={className}
                >
                    {children}
                </motion.div>
            </PresenceContext.Provider>
        </MotionConfig>
    );
}
