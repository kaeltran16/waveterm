// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The Brief's one toast: bottom-centre over the surface, with Undo when the edit can be taken back.
// Brief-local rather than the cockpit's notificationstore, which is global and has no action button.

import { cardVariants } from "@/app/element/motiontokens";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { AnimatePresence, MotionConfig, motion, type Variants } from "motion/react";
import { briefToastAtom } from "./briefundo";

// a leaving toast is inert: its Undo is stale, and a notify undo would run twice or clear the newer toast
const toastVariants: Variants = {
    ...cardVariants,
    exit: { ...(cardVariants.exit as object), pointerEvents: "none" },
};

// keyed by id, so a toast replacing another swaps rather than editing the old one's text in place
export function BriefToastView() {
    const toast = useAtomValue(briefToastAtom);
    return (
        <MotionConfig reducedMotion="user">
            <AnimatePresence>
                {toast != null ? (
                    <motion.div
                        key={toast.id}
                        variants={toastVariants}
                        initial="initial"
                        animate="animate"
                        exit="exit"
                        role="status"
                        data-jarvis-brief-toast={toast.error ? "error" : "info"}
                        className="absolute bottom-6 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-[9px] border border-edge-strong bg-surface-raised py-2 pl-3.5 pr-2.5 shadow-[0_12px_34px_var(--color-background)]"
                    >
                        <span
                            className={cn(
                                "whitespace-nowrap text-[12.5px]",
                                toast.error ? "text-error" : "text-secondary"
                            )}
                        >
                            {toast.text}
                        </span>
                        {toast.undo != null ? (
                            <button
                                type="button"
                                data-jarvis-toast-undo
                                onClick={toast.undo}
                                className="cursor-pointer rounded-[6px] border border-edge-mid px-[9px] py-[3px] font-mono text-[10.5px] font-semibold text-accent-soft hover:text-ink-hi focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                            >
                                Undo
                            </button>
                        ) : null}
                    </motion.div>
                ) : null}
            </AnimatePresence>
        </MotionConfig>
    );
}
