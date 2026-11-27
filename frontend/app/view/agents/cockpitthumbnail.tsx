// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// A Cockpit thumbnail: a session's header (name, project, state chip, age), the last turn of its transcript and one
// line per run it lists. Read-only: every reply and answer goes through the zoomed view. Also the run line itself,
// which the no-conductor strip draws too.

import { CrossFade } from "@/app/element/crossfade";
import { useChangeFlash, useSettle } from "@/app/element/motionhooks";
import { cardVariants, changeFlashClass, indicatorSlide, settleClass } from "@/app/element/motiontokens";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { AnimatePresence, motion } from "motion/react";
import { entriesToShow } from "./agentrowmodel";
import { displayAgeMs, formatAge } from "./agentsviewmodel";
import {
    lastTurnEntries,
    runLineFace,
    runStage,
    type CockpitSession,
    type RunLineTone,
    type SessionState,
} from "./cockpitsessionmodel";
import { runWaitAtom } from "./cockpitsessionstore";
import { entriesAtomFor } from "./livetranscriptatoms";
import { NarrationTimeline } from "./narrationtimeline";
import { runTitle } from "./runlineage";
import { runDigestsAtom } from "./runlineagestore";
import { runtimeMeta } from "./runtimemeta";

// the newest rows of the last turn a thumbnail draws
export const THUMB_ROWS = 8;

// shared by the thumbnails and the strip, so the ring slides between any two stops
export const RING_LAYOUT_ID = "cockpit-ring";

const STATE_FACE: Record<SessionState, { label: string; chip: string; dot: string; edge: string }> = {
    asks: {
        label: "Asks you",
        chip: "border-warning bg-warning text-on-warning",
        dot: "bg-on-warning",
        edge: "border-warning/45",
    },
    turn: {
        label: "Your turn",
        chip: "border-warning/45 bg-askingbg text-warning",
        dot: "bg-warning",
        edge: "border-warning/45",
    },
    watching: {
        label: "Watching",
        chip: "border-edge-mid bg-pill text-ink-mid",
        dot: "border-[1.5px] border-ink-mid",
        edge: "border-edge-mid",
    },
    working: {
        label: "Working",
        chip: "border-transparent bg-success/10 text-success",
        dot: "bg-success",
        edge: "border-edge-mid",
    },
};

const TONE_FACE: Record<RunLineTone, { text: string; dot: string }> = {
    yours: { text: "font-semibold text-warning", dot: "bg-warning" },
    conductor: { text: "text-muted", dot: "border-[1.5px] border-muted" },
    live: { text: "text-ink-mid", dot: "bg-success" },
    failed: { text: "text-error", dot: "bg-error" },
    done: { text: "text-muted", dot: "bg-ink-faint" },
};

// the selection ring: one element that slides from stop to stop (moment 9)
export function SelectionRing({ className }: { className?: string }) {
    return (
        <motion.span
            layoutId={RING_LAYOUT_ID}
            transition={indicatorSlide}
            data-cockpit-ring
            aria-hidden
            className={cn("pointer-events-none absolute inset-0 rounded-[10px] border border-accent", className)}
        />
    );
}

export function StateChip({ state }: { state: SessionState }) {
    const face = STATE_FACE[state];
    return (
        <CrossFade swapKey={state} className="shrink-0">
            <span
                data-thumb-chip={state}
                className={cn(
                    "inline-flex h-5 items-center gap-[5px] rounded-[5px] border px-[7px] text-[11.5px] font-semibold",
                    face.chip
                )}
            >
                <span className={cn("h-1.5 w-1.5 rounded-full", face.dot)} />
                {face.label}
            </span>
        </CrossFade>
    );
}

// one run: its name and its stage, or what its open wait needs and whose it is
export function RunLine({ run, now, project }: { run: Run; now: number; project?: string }) {
    const wait = useAtomValue(runWaitAtom(run.id));
    const digest = useAtomValue(runDigestsAtom)[run.id];
    const face = runLineFace(run, runStage(run, digest, now), wait);
    const tone = TONE_FACE[face.tone];
    const yours = face.tone === "yours";
    // a wait turning yours is the one change that must catch the eye (moment 14); landing settles once (moment 4)
    const flashing = useChangeFlash(yours) && yours;
    const settling = useSettle(run.status === "done");
    return (
        <div
            data-run-line={run.id}
            data-run-tone={face.tone}
            className={cn(
                "flex min-w-0 items-center gap-2 rounded-[6px] text-[12px]",
                flashing && changeFlashClass,
                settling && settleClass
            )}
        >
            <span className={cn("h-[7px] w-[7px] shrink-0 rounded-full", tone.dot)} />
            <span className="min-w-0 truncate text-secondary">{runTitle(run, undefined)}</span>
            {project ? <span className="shrink-0 text-[11.5px] text-muted">{project}</span> : null}
            <span className="min-w-2 flex-1" />
            <CrossFade swapKey={face.text} className={cn("shrink-0 whitespace-nowrap", tone.text)}>
                <span data-run-line-text>{face.text}</span>
            </CrossFade>
        </div>
    );
}

export function CockpitThumbnail({
    session,
    selected,
    now,
    onClick,
}: {
    session: CockpitSession;
    selected: boolean;
    now: number;
    onClick: () => void;
}) {
    const { agent, state, runs } = session;
    const live = useAtomValue(entriesAtomFor(agent.id));
    const entries = lastTurnEntries(entriesToShow(live, agent.previousInfo), THUMB_ROWS);
    const face = STATE_FACE[state];
    return (
        <motion.div
            layout
            variants={cardVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            data-cockpit-thumb={agent.id}
            data-cockpit-stop={agent.id}
            data-thumb-state={state}
            data-thumb-selected={selected ? "" : undefined}
            onClick={onClick}
            className={cn(
                "relative flex min-h-0 cursor-pointer flex-col overflow-hidden rounded-[10px] border bg-surface-raised",
                face.edge
            )}
        >
            {selected ? <SelectionRing /> : null}
            <div className="flex flex-none items-center gap-2 border-b border-border px-3 py-[9px]">
                <span
                    className={cn("h-[7px] w-[7px] shrink-0 rounded-full bg-current", runtimeMeta(agent.agent).text)}
                />
                <span className="min-w-0 truncate text-[13px] font-semibold text-primary">{agent.name}</span>
                <span className="min-w-0 flex-1 truncate text-[11.5px] text-muted">{agent.project}</span>
                <StateChip state={state} />
                <span className="shrink-0 font-mono text-[11px] text-muted">{formatAge(displayAgeMs(agent, now))}</span>
            </div>
            <div
                data-thumb-transcript
                className="flex min-h-0 flex-1 flex-col justify-end overflow-hidden bg-background px-3.5 pb-2.5 pt-1.5 [mask-image:linear-gradient(to_bottom,transparent_0,black_36px)]"
            >
                {entries.length > 0 ? (
                    <NarrationTimeline entries={entries} active={state === "working"} compact still />
                ) : null}
            </div>
            <div className="flex flex-none flex-col gap-1.5 border-t border-border px-3 pb-2.5 pt-2">
                <AnimatePresence initial={false}>
                    {runs.map((r) => (
                        <motion.div key={r.id} variants={cardVariants} initial="initial" animate="animate" exit="exit">
                            <RunLine run={r} now={now} />
                        </motion.div>
                    ))}
                </AnimatePresence>
                {runs.length === 0 ? (
                    <span data-thumb-no-runs className="text-[12px] text-muted">
                        No runs today
                    </span>
                ) : null}
            </div>
        </motion.div>
    );
}
