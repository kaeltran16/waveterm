// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The board's agent (decision 10): the chip, whose picker lists the project's live claude and pi agents,
// and the same list inline in a turn that needs an agent, with Start an agent. Thin render: the choices come from
// boardtalkmodel.ts and picking is the caller's.

import { cardVariants } from "@/app/element/motiontokens";
import { useEscapeClose } from "@/app/hook/useEscapeClose";
import { runtimeMeta } from "@/app/view/agents/runtimemeta";
import { cn } from "@/util/util";
import { ChevronDown, ChevronUp } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentChoice } from "./boardtalkmodel";

const CHIP =
    "inline-flex min-w-0 cursor-pointer items-center gap-1.5 rounded-md border border-edge-mid bg-surface-raised px-2 py-[3px] text-[12px] text-secondary hover:border-edge-strong hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";

export function RuntimeDot({ runtime }: { runtime: string | undefined }) {
    return <span className={cn("h-[7px] w-[7px] shrink-0 rounded-full bg-current", runtimeMeta(runtime).text)} />;
}

export interface AgentChoiceListProps {
    choices: AgentChoice[];
    project: string;
    onPick: (tabId: string) => void;
    onStart?: () => void; // Start an agent: only where a question waits for one
}

export function AgentChoiceList({ choices, project, onPick, onStart }: AgentChoiceListProps) {
    return (
        <div data-board-agent-choices className="flex flex-col gap-0.5">
            {choices.length === 0 ? (
                <span className="px-2 py-[5px] text-[12px] text-muted">No live claude or pi agent in {project}</span>
            ) : (
                choices.map((c) => (
                    <button
                        key={c.tabId}
                        type="button"
                        role="option"
                        aria-selected={c.current}
                        data-board-agent-choice={c.tabId}
                        onClick={() => onPick(c.tabId)}
                        className={cn(
                            "flex min-w-0 cursor-pointer items-center gap-[7px] rounded-lg border-0 px-2 py-[6px] text-left text-[12.5px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                            c.current
                                ? "bg-surface-selected font-semibold text-primary"
                                : "bg-transparent text-secondary hover:bg-surface-hover"
                        )}
                    >
                        <RuntimeDot runtime={c.runtime} />
                        <span className="truncate">{c.name}</span>
                    </button>
                ))
            )}
            {onStart != null ? (
                <button
                    type="button"
                    data-board-start-agent
                    onClick={onStart}
                    className="flex cursor-pointer items-center gap-2 rounded-lg border-0 bg-transparent px-2 py-[6px] text-left text-[12.5px] font-semibold text-primary hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                >
                    <span className="text-[15px] leading-none">+</span>Start an agent
                </button>
            ) : null}
        </div>
    );
}

export interface BoardAgentChipProps {
    chip: { label: string; runtime?: string };
    choices: AgentChoice[];
    project: string;
    onPick: (tabId: string) => void;
    // the workspace tab's ask bar: no "Agent" word, and the picker opens upward, since one below the pane's foot clips
    bare?: boolean;
}

export function BoardAgentChip({ chip, choices, project, onPick, bare }: BoardAgentChipProps) {
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
    const Chevron = open ? ChevronUp : ChevronDown;
    return (
        <div ref={rootRef} className={cn("relative flex", bare ? "flex-none" : "min-w-0")}>
            <button
                ref={triggerRef}
                type="button"
                data-board-agent-chip
                aria-haspopup="listbox"
                aria-expanded={open}
                aria-label={bare ? `Board agent: ${chip.label}` : `The board's agent, now ${chip.label}`}
                onClick={() => setOpen((o) => !o)}
                className={cn(CHIP, bare && "h-7 font-semibold", open && "bg-surface-hover")}
            >
                {bare ? null : <span className="text-muted">Agent</span>}
                {chip.runtime != null ? <RuntimeDot runtime={chip.runtime} /> : null}
                <span className="truncate">{chip.label}</span>
                <Chevron size={11} strokeWidth={2} aria-hidden className="shrink-0 text-ink-faint" />
            </button>
            <AnimatePresence>
                {open ? (
                    <motion.div
                        data-board-agent-picker
                        role="listbox"
                        aria-label="The board's agent"
                        variants={cardVariants}
                        initial="initial"
                        animate="animate"
                        exit="exit"
                        style={{ transformOrigin: bare ? "bottom left" : "top left" }}
                        className={cn(
                            "absolute left-0 z-20 flex w-[280px] flex-col gap-1 rounded-xl border border-edge-mid bg-surface-raised p-2 shadow-popover-sm",
                            bare ? "bottom-[calc(100%+6px)]" : "top-[calc(100%+6px)]"
                        )}
                    >
                        <span className="px-2 py-0.5 text-[11.5px] text-muted">Questions on this board go to</span>
                        <AgentChoiceList
                            choices={choices}
                            project={project}
                            onPick={(tabId) => {
                                setOpen(false);
                                onPick(tabId);
                            }}
                        />
                    </motion.div>
                ) : null}
            </AnimatePresence>
        </div>
    );
}
