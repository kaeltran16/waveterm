// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The Brief's one toast: bottom-centre over the surface, with Undo when the edit can be taken back, and Undo for
// the deletes still pending (briefundo.ts). Brief-local rather than the cockpit's notificationstore, which is
// global and has no action button; it shares that store's level styling, so an error reads the same in both.

import { TOAST_LEVEL } from "@/app/cockpit/notificationtoasts";
import { cardVariants } from "@/app/element/motiontokens";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { AnimatePresence, MotionConfig, motion, type Variants } from "motion/react";
import { briefToastAtom } from "./briefundo";

// a leaving toast takes no clicks: its Undo belongs to an edit that has already committed or been replaced
const toastVariants: Variants = { ...cardVariants, exit: { ...cardVariants.exit, pointerEvents: "none" } };

const UNDO_CLASS =
    "shrink-0 cursor-pointer rounded-[6px] border border-edge-mid px-[9px] py-[3px] font-mono text-[10.5px] font-semibold text-accent-soft hover:text-ink-hi focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";

const ERROR = TOAST_LEVEL.error;

export function BriefToastView() {
    const toast = useAtomValue(briefToastAtom);
    const pending = toast?.pendingUndo;
    // keyed by id so a toast replacing another crosses over it rather than swapping its text in place
    return (
        <MotionConfig reducedMotion="user">
            <AnimatePresence mode="popLayout">
                {toast != null ? (
                    <motion.div
                        key={toast.id}
                        layout
                        variants={toastVariants}
                        initial="initial"
                        animate="animate"
                        exit="exit"
                        role="status"
                        data-jarvis-brief-toast={toast.error ? "error" : "info"}
                        // above the dialog layer (modalshell's z-70): a toast reports what an open dialog just did.
                        // w-max then capped: an absolute box shrinks to the room right of left-1/2, so without it a
                        // long error would wrap at half the surface
                        className={cn(
                            "absolute bottom-6 left-1/2 z-[80] flex w-max max-w-[min(560px,90%)] -translate-x-1/2 items-center gap-3 rounded-[9px] border bg-surface-raised py-2 pl-3.5 pr-2.5 shadow-popover-md",
                            toast.error ? ERROR.edge : "border-edge-strong"
                        )}
                    >
                        {toast.error ? (
                            <ERROR.Icon
                                size={15}
                                role="img"
                                aria-label={ERROR.label}
                                className={cn("shrink-0", ERROR.tone)}
                            />
                        ) : null}
                        <span
                            className={cn(
                                "min-w-0 break-words text-[12.5px]",
                                toast.error ? "text-error" : "text-secondary"
                            )}
                        >
                            {toast.text}
                        </span>
                        {toast.undo != null ? (
                            <button type="button" data-jarvis-toast-undo onClick={toast.undo} className={UNDO_CLASS}>
                                Undo
                            </button>
                        ) : null}
                        {pending != null ? (
                            <button
                                type="button"
                                data-jarvis-toast-undo="pending"
                                title={
                                    pending.count === 1
                                        ? "Undo the pending delete"
                                        : `Undo the ${pending.count} pending deletes`
                                }
                                onClick={pending.undo}
                                className={UNDO_CLASS}
                            >
                                {pending.count === 1 ? "Undo" : `Undo ${pending.count}`}
                            </button>
                        ) : null}
                    </motion.div>
                ) : null}
            </AnimatePresence>
        </MotionConfig>
    );
}
