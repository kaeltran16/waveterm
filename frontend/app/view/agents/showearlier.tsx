// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { viewFade } from "@/app/element/motiontokens";
import { AnimatePresence, motion } from "motion/react";

// each host passes its own marker attribute: the scenarios select the control by it
export function ShowEarlier({ show, marker, onClick }: { show: boolean; marker: string; onClick: () => void }) {
    return (
        <AnimatePresence initial={false}>
            {show ? (
                <motion.button
                    key="earlier"
                    type="button"
                    {...{ [marker]: "" }}
                    onClick={onClick}
                    variants={viewFade}
                    initial="initial"
                    animate="animate"
                    className="w-full cursor-pointer rounded-[6px] py-2 text-center text-[12px] font-semibold text-muted hover:bg-surface-hover hover:text-primary"
                >
                    Show earlier turns
                </motion.button>
            ) : null}
        </AnimatePresence>
    );
}
