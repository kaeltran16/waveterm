// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The header's board switcher (boards B2): the open board's name opens the project's boards, newest first, with
// Ask something new at the top. Thin render: the rows' words come from boardtalkmodel.ts.

import { cardVariants } from "@/app/element/motiontokens";
import { useEscapeClose } from "@/app/hook/useEscapeClose";
import { cn } from "@/util/util";
import { ChevronDown, ChevronUp } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { SwitcherRow } from "./boardtalkmodel";

const MARK: Record<NonNullable<SwitcherRow["mark"]>, { label: string; text: string; dot: string }> = {
    answering: { label: "answering", text: "text-success", dot: "bg-working pulse-dot" },
    asks: { label: "asks you", text: "text-warning", dot: "bg-warning pulse-glow" },
    failed: { label: "failed", text: "text-error", dot: "bg-error" },
    wontopen: { label: "won't open", text: "text-error", dot: "bg-error" },
};

export interface BoardSwitcherProps {
    name: string;
    openId: string;
    heading: string;
    rows: SwitcherRow[];
    onPick: (boardId: string) => void;
    onAskNew: () => void;
}

function Mark({ mark }: { mark: NonNullable<SwitcherRow["mark"]> }) {
    const m = MARK[mark];
    return (
        <span
            data-board-switcher-mark={mark}
            className={cn("flex shrink-0 items-center gap-[5px] text-[11.5px] font-semibold", m.text)}
        >
            <span className={cn("h-[7px] w-[7px] rounded-full", m.dot)} />
            {m.label}
        </span>
    );
}

export function BoardSwitcher({ name, openId, heading, rows, onPick, onAskNew }: BoardSwitcherProps) {
    const [open, setOpen] = useState(false);
    const rootRef = useRef<HTMLDivElement | null>(null);
    const triggerRef = useRef<HTMLButtonElement | null>(null);
    const close = useCallback(() => setOpen(false), []);
    // Esc closes it (and the shell's Escape-home yields while it is open); so does a click outside
    useEscapeClose(open, close, triggerRef);
    useEffect(() => {
        if (!open) {
            return;
        }
        const onPointer = (e: PointerEvent) => {
            if (!rootRef.current?.contains(e.target as Node)) {
                setOpen(false);
            }
        };
        document.addEventListener("pointerdown", onPointer, true);
        return () => document.removeEventListener("pointerdown", onPointer, true);
    }, [open]);

    const pick = (fn: () => void) => {
        setOpen(false);
        fn();
    };
    const Chevron = open ? ChevronUp : ChevronDown;

    return (
        <div ref={rootRef} className="relative flex min-w-0">
            <button
                ref={triggerRef}
                type="button"
                data-board-switcher
                aria-haspopup="listbox"
                aria-expanded={open}
                aria-label={`Switch board, now ${name}`}
                onClick={() => setOpen((o) => !o)}
                className={cn(
                    "flex min-w-0 cursor-pointer items-center gap-1.5 rounded-md border-0 px-1.5 py-1 text-[13.5px] font-semibold text-secondary hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                    open ? "bg-surface-hover" : "bg-transparent"
                )}
            >
                <span className="truncate">{name}</span>
                <Chevron size={12} strokeWidth={2} aria-hidden className="shrink-0 text-ink-faint" />
            </button>
            <AnimatePresence>
                {open ? (
                    <motion.div
                        data-board-switcher-popover
                        variants={cardVariants}
                        initial="initial"
                        animate="animate"
                        exit="exit"
                        style={{ transformOrigin: "top left" }}
                        className="absolute left-0 top-[calc(100%+6px)] z-20 flex w-[340px] flex-col gap-1.5 rounded-xl border border-edge-mid bg-surface-raised p-2 shadow-popover-sm"
                    >
                        <button
                            type="button"
                            data-board-ask-new
                            onClick={() => pick(onAskNew)}
                            className="flex cursor-pointer items-center gap-2 rounded-lg border-0 bg-transparent px-2 py-[7px] text-left text-[12.5px] font-semibold text-primary hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                        >
                            <span className="text-[15px] leading-none">+</span>Ask something new
                        </button>
                        <div className="border-t border-border" />
                        <span data-board-switcher-heading className="px-2 py-0.5 text-[11.5px] text-muted">
                            {heading}
                        </span>
                        <div
                            role="listbox"
                            aria-label="Boards"
                            className="flex max-h-[360px] flex-col gap-0.5 overflow-y-auto"
                        >
                            {rows.map((row) => {
                                const current = row.id === openId;
                                return (
                                    <button
                                        key={row.id}
                                        type="button"
                                        role="option"
                                        aria-selected={current}
                                        data-board-switcher-row={row.id}
                                        onClick={() => pick(() => onPick(row.id))}
                                        className={cn(
                                            "flex cursor-pointer flex-col gap-0.5 rounded-lg border-0 px-2 py-[7px] text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                                            current
                                                ? "bg-surface-selected text-primary"
                                                : "bg-transparent text-secondary hover:bg-surface-hover"
                                        )}
                                    >
                                        <span className="flex items-center gap-[7px]">
                                            <span
                                                className={cn(
                                                    "min-w-0 flex-1 truncate text-[13px]",
                                                    current ? "font-semibold" : "font-medium"
                                                )}
                                            >
                                                {row.name}
                                            </span>
                                            {row.mark != null ? (
                                                <Mark mark={row.mark} />
                                            ) : (
                                                <span className="shrink-0 text-[11.5px] text-muted">{row.time}</span>
                                            )}
                                        </span>
                                        <span className="truncate text-[11.5px] text-muted">{row.sub}</span>
                                    </button>
                                );
                            })}
                        </div>
                    </motion.div>
                ) : null}
            </AnimatePresence>
        </div>
    );
}
