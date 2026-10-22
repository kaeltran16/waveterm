// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Initiatives: one row per initiative, the open one revealing its plan inline (with the rename field in
// its title), plus the chunk sidebar that the plan's selected chunk opens beside the regions.

import { cardVariants, MOTION, paneReveal } from "@/app/element/motiontokens";
import type { AgentsViewModel } from "@/app/view/agents/agents";
import { cn, fireAndForget } from "@/util/util";
import { AnimatePresence, motion, MotionConfig, type Variants } from "motion/react";
import type { RunMutation } from "./briefmutations";
import { filterSlot, keyOf, MoreControl, NoMatch, Region, REGIONS } from "./briefprimitives";
import type { BriefLine, LineTarget } from "./briefrows";
import { InitiativeRow } from "./briefrowviews";
import { LINK_BTN } from "./briefstyle";
import { briefUndo, noteKey } from "./briefundo";
import { ChunkSidebar } from "./chunksidebar";
import type { FeedEntry } from "./effortfeed";
import { appendChunkNote, editNote, removeNote, type ChunkRowModel } from "./effortstore";
import type { InitiativeResume } from "./initiativework";
import { isFlatPlan, type DetailRow, type TrackerRow } from "./inlinetracker";
import { InitiativeDetail, type TrackerEdits } from "./inlinetrackerview";
import { openOrPeek, openOrPeekAddress } from "./openref";
import { chunkRef } from "./trackeredit";

// The plan reveal clips only while its height animates: left clipped, it cut off the chunk and stage menus
// that drop below the card's edge.
const planReveal: Variants = {
    initial: { ...(paneReveal.initial as object), overflow: "hidden" },
    animate: { ...(paneReveal.animate as object), transitionEnd: { overflow: "visible" } },
    exit: { ...(paneReveal.exit as object), overflow: "hidden" },
};

export type RenameField = {
    title: string;
    onChange: (title: string) => void;
    onCommit: () => void;
    onCancel: () => void;
};

export function InitiativesRegion({
    lines,
    empty,
    paused,
    only,
    onOnly,
    projects,
    filtering,
    entering,
    fresh,
    cursor,
    openInitiative,
    rename,
    resumeOf,
    onWork,
    onContextMenu,
    onOpen,
    edits,
    detail,
    onSelectChunk,
    onToggleStage,
    mutateError,
    sidebarOpen,
    more,
    expanded,
    onToggleMore,
    archived,
    showArchived,
    onToggleArchived,
}: {
    lines: BriefLine[];
    empty: boolean;
    paused: number;
    only: boolean;
    onOnly: () => void;
    // the project filter; options holds every project an initiative names, picked null for all
    projects: {
        options: string[];
        total: number;
        counts: Map<string, number>;
        picked: string | null;
        onPick: (p: string | null) => void;
    };
    filtering: boolean;
    entering: Set<string>;
    fresh: Set<string>;
    cursor: string | undefined;
    openInitiative: string | null;
    // the open row's title field while it is being renamed
    rename: RenameField | null;
    resumeOf: (l: BriefLine) => InitiativeResume | undefined;
    onWork: (l: BriefLine) => void;
    onContextMenu: (l: BriefLine, ev: React.MouseEvent) => void;
    onOpen: (l: BriefLine) => void;
    edits: TrackerEdits | null;
    detail: DetailRow[];
    onSelectChunk: (id: string) => void;
    onToggleStage: (id: string, open: boolean) => void;
    mutateError: string | null;
    // the sidebar shows the mutate error itself while it is open
    sidebarOpen: boolean;
    more: number;
    expanded: boolean;
    onToggleMore: () => void;
    archived: number;
    showArchived: boolean;
    onToggleArchived: () => void;
}) {
    const project = projects.picked;
    return (
        <Region
            id="initiatives"
            count={lines.length}
            empty={empty}
            gap="gap-[9px]"
            meta={paused > 0 ? `${paused} paused` : "all moving"}
            only={only}
            onOnly={onOnly}
            filter={
                projects.options.length > 1
                    ? filterSlot({
                          label: "Show initiatives of project",
                          noun: "project",
                          tag: "data-jarvis-initiative-project",
                          options: [
                              { value: null, label: "all", count: projects.total },
                              ...projects.options.map((p) => ({
                                  value: p,
                                  label: p || "no project",
                                  count: projects.counts.get(p),
                              })),
                          ],
                          value: project,
                          onChange: projects.onPick,
                      })
                    : undefined
            }
        >
            <div className="flex flex-col">
                {lines.length === 0 ? (
                    filtering || project != null ? (
                        <NoMatch />
                    ) : (
                        <span className="px-[11px] py-[7px] text-[12.5px] text-ink-mid">
                            {REGIONS.initiatives.absent}
                        </span>
                    )
                ) : null}
                <MotionConfig reducedMotion="user">
                    <AnimatePresence initial={false}>
                        {lines.map((l) => (
                            <motion.div
                                key={l.id}
                                // position, not full layout: the pane below owns its own height
                                // animation, and a size-animating parent would re-project that
                                // growth as a scale — stretching the rows it just revealed.
                                layout="position"
                                variants={cardVariants}
                                initial={entering.has(keyOf(l)) ? "initial" : false}
                                animate="animate"
                                exit="exit"
                                transition={{
                                    duration: MOTION.durMacro,
                                    ease: MOTION.easeFluid,
                                }}
                                // each row's layout transform is its own stacking context, so a
                                // plan menu hanging past the card would paint under the rows
                                // after it; the open card is lifted above them
                                className={l.id === openInitiative ? "relative z-10" : undefined}
                            >
                                <InitiativeRow
                                    line={l}
                                    focused={cursor === l.id}
                                    fresh={fresh.has(keyOf(l))}
                                    expanded={l.id === openInitiative}
                                    resume={resumeOf(l)}
                                    onWork={() => onWork(l)}
                                    onContextMenu={(ev) => onContextMenu(l, ev)}
                                    onOpen={() => onOpen(l)}
                                    titleSlot={
                                        l.id === openInitiative && rename != null ? (
                                            <input
                                                autoFocus
                                                data-jarvis-rename-input
                                                value={rename.title}
                                                onChange={(e) => rename.onChange(e.target.value)}
                                                onBlur={rename.onCommit}
                                                onKeyDown={(e) => {
                                                    if (e.key === "Enter") {
                                                        e.currentTarget.blur();
                                                    } else if (e.key === "Escape") {
                                                        e.stopPropagation();
                                                        rename.onCancel();
                                                    }
                                                }}
                                                onClick={(e) => e.stopPropagation()}
                                                className="min-w-0 flex-1 rounded-[6px] border border-accent/60 bg-background px-[7px] py-0.5 text-[13px] text-ink-hi outline-none"
                                            />
                                        ) : undefined
                                    }
                                />
                                {/* the plan reveal: height+opacity on the macro duration, and NOT a
                                                                layout node, so the reveal and the list's reflow don't fight. */}
                                <AnimatePresence initial={false}>
                                    {l.id === openInitiative ? (
                                        <motion.div
                                            key="detail"
                                            variants={planReveal}
                                            initial="initial"
                                            animate="animate"
                                            exit="exit"
                                        >
                                            {edits != null ? (
                                                <InitiativeDetail
                                                    rows={detail}
                                                    cursor={cursor}
                                                    edits={edits}
                                                    onSelectChunk={onSelectChunk}
                                                    onToggleStage={onToggleStage}
                                                />
                                            ) : (
                                                <p
                                                    data-jarvis-initiative-detail="loading"
                                                    className="px-3 py-2 text-[12px] text-muted"
                                                >
                                                    {detail[0]?.kind === "pending" ? detail[0].message : ""}
                                                </p>
                                            )}
                                            {mutateError != null && !sidebarOpen ? (
                                                <p className="px-3 pb-2 text-[11px] text-error">{mutateError}</p>
                                            ) : null}
                                        </motion.div>
                                    ) : null}
                                </AnimatePresence>
                            </motion.div>
                        ))}
                    </AnimatePresence>
                </MotionConfig>
                <MoreControl n={more} expanded={expanded} onToggle={onToggleMore} />
                {archived > 0 ? (
                    <button
                        type="button"
                        data-jarvis-brief-archived={showArchived ? "hide" : "show"}
                        onClick={onToggleArchived}
                        className={cn(LINK_BTN, "mt-1")}
                    >
                        {showArchived ? "Hide archived" : `Show ${archived} archived`}
                    </button>
                ) : null}
            </div>
        </Region>
    );
}

export function BriefChunkPane({
    model,
    initiative,
    selectedChunk,
    planChunks,
    feed,
    readingNote,
    setReadingNote,
    error,
    onPrev,
    onNext,
    onClose,
    openLine,
    runMutation,
    edits,
}: {
    model: AgentsViewModel;
    initiative: string;
    // the selected chunk of the open initiative's plan, null with no sidebar
    selectedChunk: Extract<TrackerRow, { kind: "chunk" }> | null;
    planChunks: ChunkRowModel[];
    feed: FeedEntry[];
    readingNote: Set<string>;
    setReadingNote: (update: Set<string> | ((cur: Set<string>) => Set<string>)) => void;
    error: string | null;
    onPrev: (() => void) | null;
    onNext: (() => void) | null;
    onClose: () => void;
    openLine: (target: LineTarget, e?: React.MouseEvent) => void;
    runMutation: RunMutation;
    edits: TrackerEdits | null;
}) {
    return (
        <AnimatePresence initial={false}>
            {selectedChunk != null ? (
                <ChunkSidebar
                    key="chunk-sidebar"
                    model={model}
                    initiative={initiative}
                    label={selectedChunk.row.label}
                    stage={selectedChunk.row.stage}
                    flat={isFlatPlan(planChunks)}
                    status={selectedChunk.row.status}
                    position={{
                        n: planChunks.findIndex((c) => c.label === selectedChunk.row.label) + 1,
                        total: planChunks.length,
                    }}
                    feed={feed}
                    expanded={readingNote}
                    now={Date.now()}
                    handle={`wsh effort note ${selectedChunk.oref.replace(/^effort:/, "")} "${selectedChunk.row.label}"`}
                    error={error}
                    onPrev={onPrev}
                    onNext={onNext}
                    onToggle={(key) =>
                        setReadingNote((cur) => {
                            const next = new Set(cur);
                            if (!next.delete(key)) {
                                next.add(key);
                            }
                            return next;
                        })
                    }
                    onClose={onClose}
                    onActivity={(e) => openLine({ oref: selectedChunk.oref }, e)}
                    onAddNote={(text) =>
                        runMutation(() => appendChunkNote(selectedChunk.oref, selectedChunk.row.label, text))
                    }
                    onSetStatus={(status) => edits?.onSetStatus(selectedChunk.row.label, status)}
                    onEditNote={(entry, text) =>
                        entry.noteAt != null &&
                        runMutation(() =>
                            editNote(
                                selectedChunk.oref,
                                chunkRef(planChunks, entry.chunk),
                                entry.noteAt!,
                                entry.ts,
                                text
                            )
                        )
                    }
                    onDeleteNote={(entry) => {
                        if (entry.noteAt == null) {
                            return;
                        }
                        const at = entry.noteAt;
                        setReadingNote(new Set());
                        briefUndo.schedule([noteKey(selectedChunk.oref, entry.chunk, entry.ts)], "Note deleted", () =>
                            removeNote(selectedChunk.oref, chunkRef(planChunks, entry.chunk), at, entry.ts)
                        );
                    }}
                    onOpenSession={(c, e) =>
                        fireAndForget(() =>
                            c.sessionTab !== ""
                                ? openOrPeek(model, { kind: "agent", tabId: c.sessionTab }, e)
                                : openOrPeekAddress(model, "run:" + c.runOid, e)
                        )
                    }
                />
            ) : null}
        </AnimatePresence>
    );
}
