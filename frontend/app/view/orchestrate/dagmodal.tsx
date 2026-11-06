// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { modalBackdrop, modalPanel } from "@/app/element/motiontokens";
import { focusTrapTarget, takeModalFocus } from "@/app/modals/modalfocus";
import { registerModal } from "@/app/modals/modalstack";
import { useWaveObjectValue } from "@/app/store/wos";
import { briefSheetVisibleAtom } from "@/app/view/jarvis/briefsheet";
import { GraphSkeleton } from "@/app/view/jarvis/graphskeleton";
import { useAtomValue } from "jotai";
import { AnimatePresence, motion, MotionConfig } from "motion/react";
import { useEffect, useRef, useState, type JSX } from "react";
import { harnessesAtom } from "../agents/harnessstore";
import { channelProjectLabel } from "../agents/projectlabel";
import { projectsAtom } from "../agents/projectsstore";
import { DagGraphView } from "./daggraph";
import {
    closeDagModal,
    DAG_MODAL_ID,
    dagModalStateAtom,
    dismissDagModal,
    escapeDagModal,
    type DagModalState,
} from "./dagmodalstate";
import { ModelPicksBanner } from "./modelpicksview";
import { timelineLayout, type TimelineLayout } from "./timelinefilter";
import { TimelineRail } from "./timelinerail";

const DAG_MODAL_HEADING_ID = "dag-modal-heading";
const FOCUSABLE_SELECTOR =
    'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function DagModal() {
    const state = useAtomValue(dagModalStateAtom);
    const panelRef = useRef<HTMLDivElement>(null);
    const open = state != null;
    const layout = useTimelineLayout();
    const sheetVisible = useAtomValue(briefSheetVisibleAtom);

    // the modal's state is global but the surface hosting it unmounts on switch
    useEffect(() => dismissDagModal, []);

    useEffect(() => {
        if (!open) return;
        const onKey = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                escapeDagModal();
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

    // on the modal stack, so the run sheet's shell underneath yields Escape. Re-registered, and focus re-taken,
    // whenever the sheet behind shows: the sheet registers once its face loads, which can be after this opened
    // (an address opens both in one tick), and that would leave the sheet on top.
    useEffect(() => {
        if (!open) return;
        const unregister = registerModal(DAG_MODAL_ID);
        const restore = takeModalFocus(panelRef.current, document.activeElement as HTMLElement | null);
        return () => {
            unregister();
            restore();
        };
    }, [open, sheetVisible]);

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
                            className="flex h-full w-full flex-col overflow-hidden rounded-lg border border-edge-strong bg-modalbg shadow-popover outline-none"
                        >
                            <DagModalBody state={state} layout={layout} />
                        </motion.div>
                    </motion.div>
                ) : null}
            </AnimatePresence>
        </MotionConfig>
    );
}

// DagModalBody takes the owner run and channel off the dag itself, never off whoever opened it: a worker
// run's sheet once passed its own run, and the modal named the worker as the graph's owner.
function DagModalBody({ state, layout }: { state: DagModalState; layout: TimelineLayout }) {
    const [group, loading] = useWaveObjectValue<TaskGroup>(state.dagOref);
    return (
        <>
            <div className="flex flex-none items-center gap-3 border-b border-border bg-surface px-4 py-3">
                <div className="min-w-0 flex-1">
                    <h2 id={DAG_MODAL_HEADING_ID} className="text-title font-bold text-primary">
                        Route DAG
                    </h2>
                    {group != null ? <ModalSubtitle channelId={group.channelid} runId={group.runid} /> : null}
                </div>
                <button
                    type="button"
                    onClick={closeDagModal}
                    className="cursor-pointer rounded-md border border-border bg-surface px-3 py-1.5 text-[12px] font-semibold text-secondary hover:border-edge-strong hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                >
                    Close · Esc
                </button>
            </div>
            {group == null ? (
                <div className="min-h-0 flex-1">
                    {loading ? (
                        <GraphSkeleton />
                    ) : (
                        <div className="flex h-full items-center justify-center text-[13px] text-secondary">
                            This DAG no longer exists
                        </div>
                    )}
                </div>
            ) : (
                <div className={"min-h-0 flex flex-1 " + (layout === "drawer" ? "flex-col" : "")}>
                    {/* the banner spans the graph only, so the timeline keeps the full height */}
                    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                        <ModelPicksBanner dagOref={state.dagOref} runId={group.runid} />
                        <div className="min-h-0 flex-1">
                            <LiveDagModal dagOref={state.dagOref} runId={group.runid} />
                        </div>
                    </div>
                    <TimelineRail channelId={group.channelid} runId={group.runid} layout={layout} />
                </div>
            )}
        </>
    );
}

// ModalSubtitle names which run this graph belongs to: the project it runs in, and the run by its short
// prefix, lowercase as the sheet and palette show it — because the pair of raw uuids this replaced
// identified the graph to the database and to nobody else, and the project is the half a reader recognises.
function ModalSubtitle({ channelId, runId }: { channelId: string; runId: string }) {
    const [channel] = useWaveObjectValue<Channel>(`channel:${channelId}`);
    const projects = useAtomValue(projectsAtom);
    return (
        <p data-dag-modal-subtitle className="mt-0.5 font-mono text-[11.5px] uppercase tracking-[.06em] text-ink-mid">
            {channelProjectLabel(channel, projects) || channelId} ·{" "}
            <span data-dag-modal-runid className="normal-case">
                {runId.slice(0, 8)}
            </span>
        </p>
    );
}

// useTimelineLayout tracks whether the modal is wide enough to show live work and history side by
// side. Mirrors the nav rail's window-resize pattern; the decision itself is the pure timelineLayout.
function useTimelineLayout(): TimelineLayout {
    const [layout, setLayout] = useState(() => timelineLayout(window.innerWidth));
    useEffect(() => {
        const onResize = () => setLayout(timelineLayout(window.innerWidth));
        window.addEventListener("resize", onResize);
        return () => window.removeEventListener("resize", onResize);
    }, []);
    return layout;
}

function LiveDagModal({ dagOref, runId }: { dagOref: string; runId: string }): JSX.Element {
    const [owner, loading] = useWaveObjectValue<Run>(`run:${runId}`);
    const harnesses = useAtomValue(harnessesAtom);
    if (loading || owner == null) {
        return <GraphSkeleton />;
    }
    return <DagGraphView oref={dagOref} owner={owner} harnesses={harnesses} />;
}
