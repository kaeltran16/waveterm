// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Waiting on you: the queue's summary card, its rows behind a reveal, and the acknowledge-all control.

import { cardVariants, MOTION, paneReveal } from "@/app/element/motiontokens";
import { cn } from "@/util/util";
import { AnimatePresence, motion, MotionConfig } from "motion/react";
import { queueActions, type QueueAct, type QueueRow, type QueueSummary } from "./briefingmodel";
import { keyOf, NoMatch, QueueSummaryView, Region } from "./briefprimitives";
import type { BriefLine } from "./briefrows";
import { WaitingRow } from "./briefrowviews";
import { SMALL_BTN } from "./briefstyle";

export function WaitingRegion({
    queue,
    countLabel,
    lines,
    summary,
    open,
    shown,
    only,
    onOnly,
    onToggle,
    ackable,
    onAckAll,
    entering,
    cursor,
    onOpenRow,
    onAct,
}: {
    queue: QueueRow[];
    // the head's count, "N of M" while a filter is active
    countLabel: string | undefined;
    lines: BriefLine[];
    summary: QueueSummary | null;
    // the summary's own toggle
    open: boolean;
    // whether the rows are drawn: open, or a filter is reaching into them
    shown: boolean;
    only: boolean;
    onOnly: () => void;
    onToggle: () => void;
    ackable: number;
    onAckAll: () => void;
    entering: Set<string>;
    cursor: string | undefined;
    // a click hands its event over, so Ctrl can peek instead
    onOpenRow: (q: QueueRow, l: BriefLine, e: React.MouseEvent) => void;
    onAct: (q: QueueRow, l: BriefLine, act: QueueAct) => void;
}) {
    const queueOf = (l: BriefLine) => queue.find((q) => "waiting:" + q.key === l.id)!;
    return (
        <Region
            id="waiting"
            alert={queue.length > 0}
            count={countLabel}
            empty={queue.length === 0}
            gap="gap-[9px]"
            meta="gates before asks"
            only={only}
            onOnly={onOnly}
            tools={
                ackable > 1 ? (
                    <button
                        type="button"
                        data-jarvis-queue-ack-all
                        onClick={onAckAll}
                        className={cn(SMALL_BTN, "flex-none font-mono")}
                    >
                        Acknowledge {ackable} unverified
                    </button>
                ) : undefined
            }
        >
            {summary != null ? (
                <div className="flex flex-col gap-[9px]">
                    <QueueSummaryView
                        summary={summary}
                        count={queue.length}
                        expanded={open}
                        error={queue.some((q) => q.tone === "error")}
                        onToggle={onToggle}
                    />
                    <MotionConfig reducedMotion="user">
                        <AnimatePresence initial={false}>
                            {shown ? (
                                <motion.div
                                    id="jarvis-attention-details"
                                    key="attention-details"
                                    variants={paneReveal}
                                    initial="initial"
                                    animate="animate"
                                    exit="exit"
                                    className="flex flex-col overflow-hidden"
                                >
                                    {lines.length === 0 ? <NoMatch /> : null}
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
                                            <WaitingRow
                                                line={l}
                                                focused={cursor === l.id}
                                                acts={queueActions(queueOf(l))}
                                                onOpen={
                                                    l.target != null ? (e) => onOpenRow(queueOf(l), l, e) : undefined
                                                }
                                                onAct={(act) => onAct(queueOf(l), l, act)}
                                            />
                                        </motion.div>
                                    ))}
                                </motion.div>
                            ) : null}
                        </AnimatePresence>
                    </MotionConfig>
                </div>
            ) : null}
        </Region>
    );
}
