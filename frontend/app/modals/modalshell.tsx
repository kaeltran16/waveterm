// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Shared shell for the cockpit overlays (New Agent, New Project, Command Palette, Keyboard shortcuts).
// Owns the backdrop scrim, the panel, open/close motion (AnimatePresence + motiontokens), the Esc
// listener, focus (modalfocus.ts), and the optional backdrop-click dismiss. Reduced-motion drops the
// scale, keeps the fade.

import { modalBackdrop, modalPanel } from "@/app/element/motiontokens";
import { takeModalFocus } from "@/app/modals/modalfocus";
import { cn } from "@/util/util";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { useEffect, useRef, type ReactNode } from "react";

interface ModalShellProps {
    open: boolean;
    onClose: () => void; // Esc + (optional) backdrop click
    onSubmit?: () => void; // Cmd/Ctrl+Enter primary action; no-op when unset
    className?: string; // panel width / max-height, per modal
    align?: "top" | "center"; // vertical placement; default "top" (topClass offset). "center" for alerts.
    topClass?: string; // backdrop top offset when align="top"; default pt-[11vh]
    dismissOnBackdrop?: boolean; // default true
    children: ReactNode;
}

export function ModalShell({
    open,
    onClose,
    onSubmit,
    className,
    align = "top",
    topClass = "pt-[11vh]",
    dismissOnBackdrop = true,
    children,
}: ModalShellProps) {
    const panelRef = useRef<HTMLDivElement>(null);
    // runs after the children's own effects and after React has applied any child autoFocus, so a modal
    // with a text field keeps it — this only claims focus when nothing inside the panel took it.
    useEffect(() => {
        if (!open) {
            return;
        }
        return takeModalFocus(panelRef.current, document.activeElement as HTMLElement | null);
    }, [open]);

    useEffect(() => {
        if (!open) {
            return;
        }
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                onClose();
            } else if (onSubmit && e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                onSubmit();
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [open, onClose, onSubmit]);

    return (
        <MotionConfig reducedMotion="user">
            <AnimatePresence>
                {open && (
                    <motion.div
                        key="backdrop"
                        variants={modalBackdrop}
                        initial="initial"
                        animate="animate"
                        exit="exit"
                        className={cn(
                            "fixed inset-0 z-[70] flex justify-center bg-black/60 backdrop-blur-sm",
                            align === "center" ? "items-center p-10" : cn("items-start", topClass)
                        )}
                        onMouseDown={
                            dismissOnBackdrop
                                ? (e) => {
                                      if (e.target === e.currentTarget) {
                                          onClose();
                                      }
                                  }
                                : undefined
                        }
                    >
                        <motion.div
                            ref={panelRef}
                            variants={modalPanel}
                            role="dialog"
                            aria-modal="true"
                            tabIndex={-1} // focus target for a dialog with no field of its own (alerts, the cheatsheet)
                            onMouseDown={(e) => e.stopPropagation()}
                            className={cn(
                                "overflow-hidden rounded-[14px] border border-edge-strong bg-modalbg shadow-popover outline-none",
                                className
                            )}
                        >
                            {children}
                        </motion.div>
                    </motion.div>
                )}
            </AnimatePresence>
        </MotionConfig>
    );
}
