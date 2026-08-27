// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { modalBackdrop, modalPanel } from "@/app/element/motiontokens";
import { focusTrapTarget, takeModalFocus } from "@/app/modals/modalfocus";
import { useWaveObjectValue } from "@/app/store/wos";
import { harnessesAtom } from "../agents/harnessstore";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { useAtomValue } from "jotai";
import { useEffect, useRef, type JSX } from "react";
import { DagGraphView } from "./daggraph";
import { closeDagModal, dagModalStateAtom, type DagModalState } from "./dagmodalstate";

const DAG_MODAL_HEADING_ID = "dag-modal-heading";
const FOCUSABLE_SELECTOR =
    'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function DagModal() {
    const state = useAtomValue(dagModalStateAtom);
    const panelRef = useRef<HTMLDivElement>(null);
    const open = state != null;

    useEffect(() => {
        if (!open) return;
        const onKey = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                closeDagModal();
                return;
            }
            if (event.key !== "Tab") return;
            event.preventDefault();
            event.stopPropagation();
            const panel = panelRef.current;
            if (!panel) return;
            const focusables = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
            const target = focusTrapTarget(focusables, document.activeElement, event.shiftKey);
            (target ?? panel).focus();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [open]);

    useEffect(() => {
        if (!open) return;
        return takeModalFocus(panelRef.current, document.activeElement as HTMLElement | null);
    }, [open]);

    return (
        <MotionConfig reducedMotion="user">
            <AnimatePresence>
                {state ? (
                    <motion.div
                        key="dag-modal-backdrop"
                        variants={modalBackdrop}
                        initial="initial"
                        animate="animate"
                        exit="exit"
                        data-dag-modal-kind={state.kind}
                        className="absolute inset-0 z-30 flex items-center justify-center bg-background/95 p-4 backdrop-blur-sm"
                        onMouseDown={(event) => {
                            if (event.target === event.currentTarget) closeDagModal();
                        }}
                    >
                        <motion.div
                            ref={panelRef}
                            variants={modalPanel}
                            role="dialog"
                            aria-modal="true"
                            aria-labelledby={DAG_MODAL_HEADING_ID}
                            tabIndex={-1}
                            onMouseDown={(event) => event.stopPropagation()}
                            className="flex h-full max-h-[90vh] w-full max-w-[1200px] flex-col overflow-hidden rounded-lg border border-edge-strong bg-modalbg shadow-popover outline-none"
                        >
                            <div className="flex flex-none items-center gap-3 border-b border-border bg-surface px-4 py-3">
                                <div className="min-w-0 flex-1">
                                    <h2 id={DAG_MODAL_HEADING_ID} className="text-title font-bold text-primary">
                                        Route DAG
                                    </h2>
                                    <p className="font-mono text-xxs uppercase tracking-[.1em] text-muted">
                                        {state.channelId} · {state.runId}
                                    </p>
                                </div>
                                <button
                                    type="button"
                                    onClick={closeDagModal}
                                    className="cursor-pointer rounded-md border border-border bg-surface px-3 py-1.5 text-[11px] font-semibold text-secondary hover:border-edge-strong hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                                >
                                    Close · Esc
                                </button>
                            </div>
                            <div className="min-h-0 flex flex-1">
                                <LiveDagModal state={state} />
                            </div>
                        </motion.div>
                    </motion.div>
                ) : null}
            </AnimatePresence>
        </MotionConfig>
    );
}

function LiveDagModal({ state }: { state: Extract<DagModalState, { kind: "live" }> }): JSX.Element {
    const [owner, loading] = useWaveObjectValue<Run>(`run:${state.runId}`);
    const harnesses = useAtomValue(harnessesAtom);
    if (loading || owner == null) {
        return <div className="flex h-full w-full items-center justify-center text-sm text-muted">loading run route…</div>;
    }
    return <DagGraphView oref={state.dagOref} owner={owner} harnesses={harnesses} />;
}
