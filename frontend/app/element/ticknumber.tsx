// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Tick number (moment 12): a count that changes rolls (up when it grew, down when it shrank) so the eye catches
// which number moved. Plain text on mount and under reduced motion. tabular-nums plus a width reserved for the
// longer of the two values keep neighbours still while both are on screen. Not for numbers that change on their
// own every second (clocks, live token counts): a roll every second is noise.

import { atoms } from "@/app/store/global";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { useState } from "react";
import { tickRoll } from "./motiontokens";
import { reservedWidth, tickDirection, type TickDir } from "./ticknumbermodel";

interface TickNumberProps {
    value: number;
    format?: (n: number) => string;
    className?: string;
}

interface Roll {
    value: number;
    dir: TickDir;
    widthCh: number; // 0 once the old value has left
}

export function TickNumber({ value, format = String, className }: TickNumberProps) {
    const reduce = useAtomValue(atoms.prefersReducedMotionAtom);
    const text = format(value);
    const [roll, setRoll] = useState<Roll>({ value, dir: 0, widthCh: 0 });
    // derived during render (React's pattern for state from a changed prop), so the direction is already set on
    // the render that swaps the text
    if (roll.value !== value) {
        setRoll({
            value,
            dir: tickDirection(roll.value, value),
            widthCh: reservedWidth(format(roll.value), text),
        });
    }
    if (reduce) {
        return <span className={cn("tabular-nums", className)}>{text}</span>;
    }
    return (
        <MotionConfig reducedMotion="user">
            <span
                className={cn("relative inline-flex tabular-nums", className)}
                style={roll.widthCh > 0 ? { minWidth: `${roll.widthCh}ch` } : undefined}
            >
                <AnimatePresence
                    initial={false}
                    mode="popLayout"
                    custom={roll.dir}
                    onExitComplete={() => setRoll((r) => ({ ...r, widthCh: 0 }))}
                >
                    <motion.span
                        key={text}
                        custom={roll.dir}
                        variants={tickRoll}
                        initial="initial"
                        animate="animate"
                        exit="exit"
                        className="inline-block"
                    >
                        {text}
                    </motion.span>
                </AnimatePresence>
            </span>
        </MotionConfig>
    );
}
