// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The universal search's frame around its rows: the search bar, the scope tabs, the error band and the footer.
// Presentational only: command-palette.tsx owns the state and hands each piece what it shows.

import { errorNudge, indicatorSlide } from "@/app/element/motiontokens";
import { cn } from "@/util/util";
import { Check, Search } from "lucide-react";
import { AnimatePresence, LayoutGroup, motion } from "motion/react";
import type { RefObject } from "react";
import { boardAskHint, followLine } from "./actions/boarddraw";
import type { BoardDrawTarget } from "./actions/types";
import type { FooterLine } from "./palette-items";
import { FooterKeyLine } from "./palette-rows";
import {
    DRILL_LABELS,
    ghostHint,
    scopeDef,
    SCOPES,
    type BoardDrill,
    type NavState,
    type ScopeId,
} from "./palette-scope";

interface SearchBarProps {
    nav: NavState;
    placeholder: string;
    inputRef: RefObject<HTMLInputElement>;
    onQuery: (value: string) => void;
    onKeyDown: (e: React.KeyboardEvent) => void;
    onLeaveDrill: () => void; // the drill chip: back to all commands
    onLeaveLevel: () => void; // the action chip: back one level
}

export function PaletteSearchBar({
    nav,
    placeholder,
    inputRef,
    onQuery,
    onKeyDown,
    onLeaveDrill,
    onLeaveLevel,
}: SearchBarProps) {
    const atTop = nav.drill == null && nav.actions == null;
    // a narrowed scope names itself in the box; in All, a lone letter that starts a prefix says where it leads
    const token = atTop && nav.scope !== "all" ? scopeDef(nav.scope).label : null;
    const ghost = atTop && nav.scope === "all" ? ghostHint(nav.query) : null;
    return (
        <div className="flex shrink-0 items-center gap-2.5 px-4 pb-[7px] pt-[13px]">
            <Search size={15} strokeWidth={2} className="shrink-0 text-muted" />
            {token != null ? (
                <span
                    data-palette-token
                    className="shrink-0 rounded-[5px] bg-accentbg px-[7px] py-px text-[12px] font-medium text-accent-soft"
                >
                    {token}
                </span>
            ) : null}
            {nav.drill != null ? (
                <button
                    type="button"
                    aria-label="Back to all commands"
                    onClick={() => {
                        onLeaveDrill();
                        inputRef.current?.focus();
                    }}
                    className="flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md border border-edge-mid bg-surface-raised px-2 py-0.5 text-[12px] text-secondary"
                >
                    <span className="text-muted">Commands</span>
                    <span className="text-muted">›</span>
                    <span>{DRILL_LABELS[nav.drill]}</span>
                </button>
            ) : null}
            {nav.actions != null ? (
                <button
                    type="button"
                    data-palette-drill
                    aria-label="Back to results"
                    onClick={() => {
                        onLeaveLevel();
                        inputRef.current?.focus();
                    }}
                    className="flex min-w-0 max-w-[55%] shrink-0 cursor-pointer items-center gap-1.5 rounded-md border border-edge-mid bg-surface-raised px-2 py-0.5 text-[12px] text-secondary"
                >
                    <span className="shrink-0 text-muted">{nav.actions.thing.noun}</span>
                    <span className="shrink-0 text-muted">›</span>
                    <span className="truncate">{nav.actions.thing.title}</span>
                    {nav.actions.input != null ? (
                        <>
                            <span className="shrink-0 text-muted">›</span>
                            <span className="shrink-0">
                                {nav.actions.input.label}
                                {nav.actions.input.board != null ? "…" : null}
                            </span>
                        </>
                    ) : null}
                    {nav.actions.input?.board?.step === "ask" ? (
                        <>
                            <span className="shrink-0 text-muted">›</span>
                            <span className="truncate">{nav.actions.input.board.boardName}</span>
                        </>
                    ) : null}
                </button>
            ) : null}
            <div className="relative min-w-0 flex-1">
                <input
                    ref={inputRef}
                    data-palette-input
                    aria-label="Search"
                    value={nav.query}
                    onChange={(e) => onQuery(e.target.value)}
                    onKeyDown={onKeyDown}
                    placeholder={placeholder}
                    autoComplete="off"
                    spellCheck={false}
                    className="w-full bg-transparent text-[14px] text-primary outline-none placeholder:text-muted"
                />
                {ghost != null ? (
                    // the typed text, invisible, holds the ghost just past the caret
                    <div
                        aria-hidden
                        className="pointer-events-none absolute inset-0 flex items-center overflow-hidden whitespace-pre text-[14px]"
                    >
                        <span className="invisible">{nav.query}</span>
                        <span className="text-muted">{ghost}</span>
                    </div>
                ) : null}
            </div>
            <span className="shrink-0 rounded-[5px] border border-edge-mid px-[7px] py-0.5 font-mono text-[10.5px] text-muted">
                esc
            </span>
        </div>
    );
}

export function PaletteScopeTabs({
    scope,
    needsCount,
    openGen,
    onPick,
}: {
    scope: ScopeId;
    needsCount: number;
    // bumped per open. the key remounts the group, since LayoutGroup reads its id only on mount; the fresh id
    // has no snapshot, so an open draws the bar in place
    openGen: number;
    onPick: (scope: ScopeId) => void;
}) {
    return (
        <div
            role="group"
            aria-label="Scope"
            className="flex shrink-0 items-stretch gap-1 border-b border-border px-2.5"
        >
            <LayoutGroup key={openGen} id={`palette-scope-${openGen}`}>
                {SCOPES.map((s) => {
                    const on = s.id === scope;
                    const count = s.id === "needs" ? needsCount : 0;
                    return (
                        <button
                            key={s.id}
                            type="button"
                            aria-pressed={on}
                            data-palette-scope={s.id}
                            tabIndex={-1}
                            onClick={() => onPick(s.id)}
                            className={cn(
                                "relative flex cursor-pointer items-center gap-1.5 px-[7px] pb-[9px] pt-2 text-[12.5px] font-medium",
                                on ? "text-primary" : "text-muted hover:text-secondary"
                            )}
                        >
                            <span>{s.label}</span>
                            {count > 0 ? (
                                <span className="font-mono text-[10.5px] font-bold text-asking">{count}</span>
                            ) : null}
                            {on ? (
                                <motion.span
                                    layoutId="palette-scope-indicator"
                                    data-palette-scope-indicator
                                    aria-hidden
                                    transition={indicatorSlide}
                                    className="absolute inset-x-0 bottom-0 h-[2px] bg-accent"
                                />
                            ) : null}
                        </button>
                    );
                })}
            </LayoutGroup>
        </div>
    );
}

// Under the board drill's rows: at the name step where the board is made and the empty-name nudge (moment 13, again
// on each empty Enter); at the ask step what the ask changes and, for an agent, the Keep following tick.
export function PaletteBoardStep({
    board,
    project,
    target,
    onToggleFollow,
}: {
    board: BoardDrill;
    project: string;
    target: BoardDrawTarget;
    onToggleFollow: () => void;
}) {
    if (board.step === "name") {
        return (
            <div data-palette-board-step="name" className="flex flex-col gap-2 px-3.5 py-4">
                <span className="text-[13px] text-secondary">
                    Type the new board's name above. It is made in {project || "this project"} when you press Enter,
                    then you choose what to draw.
                </span>
                <AnimatePresence initial={false}>
                    {board.tried ? (
                        <motion.span
                            key={`tried-${board.tried}`}
                            data-palette-board-error
                            variants={errorNudge}
                            initial="initial"
                            animate="animate"
                            className="text-[12px] text-error"
                        >
                            Type a name first
                        </motion.span>
                    ) : (
                        <span key="hint" className="text-[12px] text-muted">
                            Enter makes it · ← back to the boards
                        </span>
                    )}
                </AnimatePresence>
            </div>
        );
    }
    if (board.step !== "ask") {
        return null;
    }
    return (
        <div data-palette-board-step="ask" className="flex flex-col gap-3 px-2.5 pb-1.5 pt-3.5">
            <span className="text-[13px] leading-normal text-secondary">{boardAskHint(target.source.kind)}</span>
            {target.followable ? (
                <button
                    type="button"
                    role="checkbox"
                    aria-checked={board.follow}
                    data-palette-follow
                    tabIndex={-1}
                    onClick={onToggleFollow}
                    className={cn(
                        "flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2.5 text-left",
                        board.follow ? "border-accent/50 bg-accentbg" : "border-border bg-surface"
                    )}
                >
                    <span
                        className={cn(
                            "mt-px flex size-4 shrink-0 items-center justify-center rounded border-[1.5px]",
                            board.follow ? "border-accent bg-accent" : "border-edge-strong"
                        )}
                    >
                        {board.follow ? <Check size={11} strokeWidth={3.2} className="text-background" /> : null}
                    </span>
                    <span className="flex flex-1 flex-col gap-[3px]">
                        <span className="text-[13px] font-semibold text-primary">Keep following</span>
                        <span className="text-[12px] text-ink-mid">{followLine(target.source.title)}</span>
                    </span>
                    <span className="shrink-0 rounded-[5px] border border-border px-1.5 py-px font-mono text-[10.5px] text-muted">
                        Tab
                    </span>
                </button>
            ) : null}
        </div>
    );
}

export function PaletteErrorBand({ error }: { error: string | undefined }) {
    if (!error) {
        return null;
    }
    return (
        <div
            role="alert"
            className="shrink-0 border-b border-error/30 bg-error/10 px-4 py-2 text-[12px] text-error-soft"
        >
            {error}
        </div>
    );
}

export function PaletteFooter({ echo, extra, inActions }: { echo: string; extra: FooterLine[]; inActions: boolean }) {
    return (
        <div className="flex shrink-0 flex-col gap-1 border-t border-border px-4 py-[9px]">
            <div className="flex items-center gap-3">
                {/* widened only to line up with a key line below it */}
                <span className={cn("shrink-0 font-mono text-[11px] text-accent-soft", extra.length > 0 && "w-[60px]")}>
                    ⏎
                </span>
                <span className="min-w-0 flex-1 truncate text-[12px] text-secondary">{echo}</span>
                <span className="flex shrink-0 items-center gap-3 font-mono text-[10.5px] text-muted">
                    <span>↑↓ move</span>
                    <span>{inActions ? "← back" : "Tab scope"}</span>
                    <span>esc close</span>
                </span>
            </div>
            {extra.map((f) => (
                <FooterKeyLine key={f.k} {...f} />
            ))}
        </div>
    );
}
