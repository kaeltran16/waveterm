// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Runs: the live sessions under their kind filter, with the week-silent ones folded.

import { cardVariants, MOTION } from "@/app/element/motiontokens";
import type { AgentsViewModel } from "@/app/view/agents/agents";
import { cn } from "@/util/util";
import { AnimatePresence, motion, MotionConfig } from "motion/react";
import { BriefRunRow, keyOf, MoreControl, NoMatch, Region, runKindFilter } from "./briefprimitives";
import type { BriefLine, LineTarget, RunKindFilter } from "./briefrows";
import { LINK_BTN } from "./briefstyle";

export function RunsRegion({
    model,
    lines,
    empty,
    runKind,
    onRunKind,
    runCounts,
    liveN,
    only,
    onOnly,
    filtering,
    entering,
    cursor,
    sheetOpen,
    stageRunId,
    openLine,
    onOpenChunk,
    staleCount,
    staleOpen,
    onToggleStale,
    more,
    expanded,
    onToggleMore,
}: {
    model: AgentsViewModel;
    lines: BriefLine[];
    empty: boolean;
    runKind: RunKindFilter;
    onRunKind: (k: RunKindFilter) => void;
    runCounts: Record<RunKindFilter, number>;
    liveN: number;
    only: boolean;
    onOnly: () => void;
    filtering: boolean;
    entering: Set<string>;
    cursor: string | undefined;
    sheetOpen: boolean;
    // the run the sheet shows
    stageRunId: string | undefined;
    openLine: (target: LineTarget, e?: React.MouseEvent) => void;
    onOpenChunk: (effortOref: string, chunk: string) => void;
    staleCount: number;
    staleOpen: boolean;
    onToggleStale: () => void;
    more: number;
    expanded: boolean;
    onToggleMore: () => void;
}) {
    return (
        <Region
            id="sessions"
            empty={empty}
            absent={runKind === "all" ? undefined : `No ${runKind} run is going.`}
            gap="gap-[9px]"
            meta={`${liveN} live`}
            only={only}
            onOnly={onOnly}
            filter={runKindFilter(runKind, onRunKind, runCounts)}
        >
            <div className="flex flex-col">
                {filtering && lines.length === 0 ? <NoMatch /> : null}
                <MotionConfig reducedMotion="user">
                    <AnimatePresence initial={false}>
                        {lines.map((l) => (
                            <motion.div
                                key={l.id}
                                layout
                                variants={cardVariants}
                                initial={entering.has(keyOf(l)) ? "initial" : false}
                                animate="animate"
                                exit="exit"
                                transition={{
                                    duration: MOTION.durMacro,
                                    ease: MOTION.easeFluid,
                                }}
                            >
                                <BriefRunRow
                                    model={model}
                                    line={l}
                                    focused={cursor === l.id}
                                    selected={sheetOpen && stageRunId === l.runOid}
                                    onOpenSheet={l.target != null ? (e) => openLine(l.target, e) : undefined}
                                    onOpenChunk={onOpenChunk}
                                />
                            </motion.div>
                        ))}
                    </AnimatePresence>
                </MotionConfig>
                {/* runs the lead marked executing and then never touched again: they are
                                            real rows, but a week of silence reads as dead, so they fold */}
                {staleCount > 0 && !filtering ? (
                    <button
                        type="button"
                        aria-expanded={staleOpen}
                        data-jarvis-brief-stale
                        onClick={onToggleStale}
                        className={cn(LINK_BTN, "mt-0.5")}
                    >
                        {staleOpen ? `Hide ${staleCount}` : `+${staleCount}`} {staleCount === 1 ? "run" : "runs"} older
                        than 7 days
                    </button>
                ) : null}
                <MoreControl n={more} expanded={expanded} onToggle={onToggleMore} />
            </div>
        </Region>
    );
}
