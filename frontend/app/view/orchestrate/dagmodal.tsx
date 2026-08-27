// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { modalBackdrop, modalPanel } from "@/app/element/motiontokens";
import { focusTrapTarget, takeModalFocus } from "@/app/modals/modalfocus";
import { modalsModel } from "@/app/store/modalmodel";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { useWaveObjectValue } from "@/app/store/wos";
import { harnessesAtom } from "../agents/harnessstore";
import { cancelRun, createRun } from "../agents/runactions";
import { setActiveRunId } from "../jarvis/jarvissubjectstore";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { useAtomValue } from "jotai";
import { useCallback, useEffect, useMemo, useRef, type JSX } from "react";
import { DagGraphView } from "./daggraph";
import { DagDraftView } from "./dagdraftview";
import { launchDagDraft } from "./daglaunch";
import { projectDraftSummary } from "./draftsummary";
import {
    allocateDagPlanRequestId,
    canDismissDagModal,
    closeDagModal,
    dispatchDagModal,
    dagModalStateAtom,
    requiresRetryConfirmation,
    type DagModalState,
} from "./dagmodalstate";
import { createDagPlanningCoordinator, requestDagPlan } from "./dagplanning";

const DAG_MODAL_HEADING_ID = "dag-modal-heading";
const FOCUSABLE_SELECTOR =
    'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function DagModal() {
    const state = useAtomValue(dagModalStateAtom);
    const harnesses = useAtomValue(harnessesAtom);
    const panelRef = useRef<HTMLDivElement>(null);
    const coordinatorRef = useRef<ReturnType<typeof createDagPlanningCoordinator> | null>(null);
    const open = state != null;

    if (coordinatorRef.current == null) {
        coordinatorRef.current = createDagPlanningCoordinator((request) =>
            requestDagPlan(request, (data, opts) => RpcApi.JarvisPlanDagCommand(TabRpcClient, data, opts)),
        );
    }

    useEffect(() => {
        if (state == null || state.kind !== "decomposing" || coordinatorRef.current == null) return;
        void coordinatorRef.current.run(state.requestId, state.request);
    }, [state]);

    const summary = useMemo(() => {
        if (state?.kind !== "draft" && state?.kind !== "launching") return null;
        return projectDraftSummary({ request: state.request, draft: state.draft, fallback: state.fallback, warnings: state.warnings, harnesses });
    }, [harnesses, state]);

    const launch = useCallback(() => {
        if (state?.kind !== "draft" || summary == null || !summary.canLaunch) return;
        dispatchDagModal({ type: "begin-launch" });
        void launchDagDraft(state.request, state.draft, {
            createDeferredRun: (request) => createRun(request.channelId, request.goal, request.route, { mode: "orchestrator", deferStart: true }),
            submitDag: (channelId, runId, payload) => RpcApi.DagSubmitCommand(TabRpcClient, { channelid: channelId, runid: runId, ...payload }),
            cancelRun,
        }).then((result) => {
            if (result.ok === false) {
                dispatchDagModal({ type: "launch-failed", error: result.error });
                return;
            }
            setActiveRunId(result.channelId, result.runId);
            dispatchDagModal({ type: "launch-succeeded", channelId: result.channelId, runId: result.runId, dagOref: result.dagOref });
        });
    }, [state, summary]);

    const retry = useCallback(() => {
        if (state?.kind === "decomposing") {
            dispatchDagModal({ type: "retry-plan", requestId: allocateDagPlanRequestId() });
            return;
        }
        if (state?.kind !== "draft") return;
        const requestId = () => dispatchDagModal({ type: "retry-plan", requestId: allocateDagPlanRequestId() });
        if (!requiresRetryConfirmation(state)) {
            requestId();
            return;
        }
        modalsModel.pushModal("ConfirmModal", {
            title: "Replace edited fallback?",
            message: "Retrying planning will replace your edited fallback draft.",
            confirmLabel: "Retry planning",
            cancelLabel: "Keep draft",
            onConfirm: requestId,
        });
    }, [state]);

    useEffect(() => {
        if (!open) return;
        const onKey = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                dispatchDagModal({ type: "escape" });
                return;
            }
            if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
                if (state?.kind === "draft" && summary?.canLaunch) {
                    event.preventDefault();
                    event.stopPropagation();
                    launch();
                }
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
    }, [launch, open, state?.kind, summary?.canLaunch]);

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
                            if (event.target === event.currentTarget && canDismissDagModal(state)) closeDagModal();
                        }}
                    >
                        <motion.div ref={panelRef} variants={modalPanel} role="dialog" aria-modal="true" aria-labelledby={DAG_MODAL_HEADING_ID} tabIndex={-1} onMouseDown={(event) => event.stopPropagation()} className="flex h-full max-h-[90vh] w-full max-w-[1200px] flex-col overflow-hidden rounded-lg border border-edge-strong bg-modalbg shadow-popover outline-none">
                            <div className="flex flex-none items-center gap-3 border-b border-border bg-surface px-4 py-3">
                                <div className="min-w-0 flex-1"><h2 id={DAG_MODAL_HEADING_ID} className="text-title font-bold text-primary">Route DAG</h2><p className="font-mono text-xxs uppercase tracking-[.1em] text-muted">{state.kind === "live" ? `${state.channelId} · ${state.runId}` : state.kind}</p></div>
                                {canDismissDagModal(state) ? <button type="button" onClick={closeDagModal} className="cursor-pointer rounded-md border border-border bg-surface px-3 py-1.5 text-[11px] font-semibold text-secondary hover:border-edge-strong hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">Close · Esc</button> : null}
                            </div>
                            <div className={`min-h-0 flex-1 ${state.kind === "live" || state.kind === "draft" || state.kind === "launching" ? "flex" : "flex items-center justify-center"}`}>
                                {state.kind === "live" ? <LiveDagModal state={state} /> : state.kind === "draft" || state.kind === "launching" ? summary ? <DagDraftView state={state} summary={summary} harnesses={harnesses} dispatch={dispatchDagModal} onLaunch={launch} onRetry={retry} disabled={state.kind === "launching"} /> : null : <div className="flex flex-col items-center gap-3 px-6 text-center text-secondary"><span className="text-[13px] font-semibold text-primary">Preparing route DAG…</span>{state.error ? <span className="text-[12px] text-error">{state.error}</span> : null}{state.error ? <button type="button" onClick={retry} className="cursor-pointer rounded-md border border-edge-mid px-3 py-1.5 text-[11px] font-semibold text-secondary hover:border-edge-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">Retry planning</button> : null}</div>}
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
