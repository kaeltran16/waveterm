// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Auto height (moment 15): a container whose height follows its content (a peek loading, the answer bar), so it
// grows and shrinks instead of jumping and shoving what is below. A ResizeObserver measures the content; the
// first measure snaps, so mounting never animates, and reduced motion snaps every time. Content is clipped only
// while the height moves, so a focus ring or popover at the edge is not cut off at rest.

import { atoms } from "@/app/store/global";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { MotionConfig, motion, type Transition } from "motion/react";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { autoHeightTransition } from "./motiontokens";

const SNAP: Transition = { duration: 0 };

interface AutoHeightProps {
    className?: string;
    children: ReactNode;
}

interface Box {
    height: number | "auto";
    animate: boolean; // false until the first measure has landed
}

export function AutoHeight({ className, children }: AutoHeightProps) {
    const reduce = useAtomValue(atoms.prefersReducedMotionAtom);
    const content = useRef<HTMLDivElement>(null);
    const [box, setBox] = useState<Box>({ height: "auto", animate: false });
    const [moving, setMoving] = useState(false);
    useLayoutEffect(() => {
        const el = content.current;
        if (el == null) return;
        const ro = new ResizeObserver(() =>
            setBox((prev) => ({ height: el.offsetHeight, animate: prev.height !== "auto" }))
        );
        ro.observe(el);
        return () => ro.disconnect();
    }, []);
    return (
        <MotionConfig reducedMotion="user">
            <motion.div
                initial={false}
                animate={{ height: box.height }}
                transition={box.animate && !reduce ? autoHeightTransition : SNAP}
                onAnimationStart={() => setMoving(true)}
                onAnimationComplete={() => setMoving(false)}
                className={cn(moving && "overflow-hidden", className)}
            >
                <div ref={content}>{children}</div>
            </motion.div>
        </MotionConfig>
    );
}
