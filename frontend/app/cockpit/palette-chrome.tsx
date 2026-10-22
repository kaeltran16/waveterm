// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The universal search's frame around its rows: the search bar, the scope tabs, the error band and the footer.
// Presentational only: command-palette.tsx owns the state and hands each piece what it shows.

import { cn } from "@/util/util";
import { Search } from "lucide-react";
import type { RefObject } from "react";
import type { FooterLine } from "./palette-items";
import { FooterKeyLine } from "./palette-rows";
import { DRILL_LABELS, ghostHint, scopeDef, SCOPES, type NavState, type ScopeId } from "./palette-scope";

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
                            <span className="shrink-0">{nav.actions.input.label}</span>
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
    onPick,
}: {
    scope: ScopeId;
    needsCount: number;
    onPick: (scope: ScopeId) => void;
}) {
    return (
        <div
            role="group"
            aria-label="Scope"
            className="flex shrink-0 items-stretch gap-1 border-b border-border px-2.5"
        >
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
                            "flex cursor-pointer items-center gap-1.5 px-[7px] pb-[9px] pt-2 text-[12.5px] font-medium",
                            on
                                ? "text-primary shadow-[inset_0_-2px_0_var(--color-accent)]"
                                : "text-muted hover:text-secondary"
                        )}
                    >
                        <span>{s.label}</span>
                        {count > 0 ? (
                            <span className="font-mono text-[10.5px] font-bold text-asking">{count}</span>
                        ) : null}
                    </button>
                );
            })}
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
