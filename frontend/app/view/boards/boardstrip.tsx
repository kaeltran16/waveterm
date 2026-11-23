// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The strip above an open board's canvas, the same in the workspace board tab and the Boards surface: the board's
// drawings row on its left, and the Edit switch pinned at its right end.

import { cardVariants, indicatorSlide } from "@/app/element/motiontokens";
import { cn } from "@/util/util";
import { useAtom, useAtomValue } from "jotai";
import { PenLine } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useId, useRef } from "react";
import { boardDrawingsAtom, boardEditingAtom } from "./boardstore";

// the current chip keeps this far from the row's edge when the row scrolls to it
const CHIP_MARGIN_PX = 12;

export function BoardStrip({ boardId, onPick }: { boardId: string; onPick: (drawingId: string) => void }) {
    const [editing, setEditing] = useAtom(boardEditingAtom(boardId));
    return (
        <div data-board-strip className="flex h-[38px] flex-none items-center gap-2 border-b border-border px-3">
            <div className="min-w-0 flex-1">
                <DrawingsRow boardId={boardId} onPick={onPick} />
            </div>
            <button
                type="button"
                data-board-edit
                aria-pressed={editing}
                onClick={() => setEditing(!editing)}
                className={cn(
                    "inline-flex h-[26px] flex-none cursor-pointer items-center gap-[6px] rounded-[7px] border px-[10px] text-[12px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                    editing
                        ? "border-accent bg-accentbg text-primary"
                        : "border-edge-mid bg-surface text-secondary hover:border-edge-strong hover:bg-surface-hover"
                )}
            >
                <PenLine size={12} strokeWidth={2} aria-hidden />
                Edit
            </button>
        </div>
    );
}

// the board's drawings by number and title: the one in view is current, a new chip enters (moment 1) and the
// current marker slides between chips (moment 9); hidden while the board has none
function DrawingsRow({ boardId, onPick }: { boardId: string; onPick: (drawingId: string) => void }) {
    const state = useAtomValue(boardDrawingsAtom(boardId));
    // one board can show in two strips at once, and each strip's marker slides only within itself
    const markerId = useId();
    const navRef = useRef<HTMLElement>(null);
    const inView = state?.inView ?? null;

    // the current chip stays in view as the row scrolls sideways
    useEffect(() => {
        const nav = navRef.current;
        const chip = nav?.querySelector<HTMLElement>('[aria-current="true"]');
        if (nav == null || chip == null) {
            return;
        }
        if (chip.offsetLeft < nav.scrollLeft) {
            nav.scrollLeft = chip.offsetLeft - CHIP_MARGIN_PX;
        } else if (chip.offsetLeft + chip.offsetWidth > nav.scrollLeft + nav.clientWidth) {
            nav.scrollLeft = chip.offsetLeft + chip.offsetWidth - nav.clientWidth + CHIP_MARGIN_PX;
        }
    }, [inView, state?.drawings.length]);

    if (state == null || state.drawings.length === 0) {
        return null;
    }
    return (
        <nav
            ref={navRef}
            aria-label="Drawings on this board"
            data-board-drawings
            className="relative flex items-center gap-[6px] overflow-x-auto [scrollbar-width:none]"
        >
            <AnimatePresence initial={false}>
                {state.drawings.map((d) => {
                    const current = d.id === inView;
                    const fresh = state.fresh.includes(d.id);
                    return (
                        <motion.button
                            key={d.id}
                            type="button"
                            data-board-drawing={d.id}
                            aria-current={current ? "true" : undefined}
                            variants={cardVariants}
                            initial="initial"
                            animate="animate"
                            exit="exit"
                            onClick={() => onPick(d.id)}
                            className={cn(
                                "relative inline-flex h-[26px] flex-none cursor-pointer items-center gap-[6px] rounded-[7px] border border-edge-mid bg-surface px-[10px] text-[12px] font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                                current ? "text-primary" : "text-secondary hover:border-edge-strong"
                            )}
                        >
                            {current ? (
                                <motion.span
                                    layoutId={markerId}
                                    aria-hidden
                                    transition={indicatorSlide}
                                    className="absolute -inset-px rounded-[7px] border border-accent bg-accentbg"
                                />
                            ) : null}
                            <span
                                data-board-drawing-n
                                className={cn(
                                    "relative font-mono text-[10.5px]",
                                    current ? "text-accent-soft" : "text-muted"
                                )}
                            >
                                {d.n}
                            </span>
                            <span data-board-drawing-title className="relative whitespace-nowrap">
                                {d.title}
                            </span>
                            {fresh ? (
                                <span data-board-drawing-new className="relative text-[10.5px] text-accent">
                                    new
                                </span>
                            ) : null}
                        </motion.button>
                    );
                })}
            </AnimatePresence>
        </nav>
    );
}
