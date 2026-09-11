// frontend/app/view/agents/refpicker.tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The subject bar's ref expression, editable in place (Wave-git-review.dc.html: "press c, or click
// the ref expression and add a second ref"). One control serves both gestures, so there is no second
// overlay and no duplicated ref-selection logic. Free text is accepted alongside the branch
// suggestions, so a tag or a raw SHA works.

import { PopoverReveal } from "@/app/element/popoverreveal";
import { cn } from "@/util/util";
import { useEffect, useRef, useState } from "react";
import { SIDE_TEXT } from "./comparerows";

function Suggestions({
    branches,
    query,
    onPick,
}: {
    branches: BranchInfo[];
    query: string;
    onPick: (name: string) => void;
}) {
    const q = query.trim().toLowerCase();
    const shown = (q ? branches.filter((b) => b.name.toLowerCase().includes(q)) : branches).slice(0, 8);
    // Grouped, not sorted: origin/main and main are one letter apart in a flat list and mean quite
    // different things — one is as fresh as the last fetch.
    const groups: { label: string; rows: BranchInfo[] }[] = [
        { label: "Local", rows: shown.filter((b) => !b.remote) },
        { label: "Remote", rows: shown.filter((b) => b.remote) },
    ];
    return (
        <PopoverReveal
            open={shown.length > 0}
            origin="top"
            className="absolute left-0 top-full z-20 mt-1 w-[240px] overflow-hidden rounded border border-border bg-modalbg py-1 shadow-popover"
        >
            {groups.map((g) =>
                g.rows.length === 0 ? null : (
                    <div key={g.label}>
                        <div className="px-[10px] pb-[2px] pt-[4px] font-mono text-[9px] uppercase tracking-[0.1em] text-ink-faint">
                            {g.label}
                        </div>
                        {g.rows.map((b) => (
                            <button
                                key={b.name}
                                // mousedown, not click: the field's blur would tear the popover down first
                                onMouseDown={(e) => {
                                    e.preventDefault();
                                    onPick(b.name);
                                }}
                                className="flex w-full items-center gap-[8px] px-[10px] py-[6px] text-left hover:bg-surface-hover"
                            >
                                <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-ink-mid">
                                    {b.name}
                                </span>
                                <span className="flex-none text-[10px] text-ink-faint">{b.age}</span>
                            </button>
                        ))}
                    </div>
                )
            )}
        </PopoverReveal>
    );
}

function SwapButton({ onClick }: { onClick: () => void }) {
    return (
        <button
            onClick={onClick}
            title="Swap base and head"
            className="flex-none px-[3px] font-mono text-[12px] text-ink-faint hover:text-foreground"
        >
            ⇄
        </button>
    );
}

export function RefPicker({
    base,
    head,
    branches,
    editing,
    onEdit,
    onApply,
    onCancel,
    onSwap,
}: {
    base: string;
    head: string;
    branches: BranchInfo[];
    editing: boolean;
    onEdit: () => void;
    onApply: (base: string, head: string) => void;
    onCancel: () => void;
    onSwap: () => void;
}) {
    const [draftBase, setDraftBase] = useState(base);
    const [draftHead, setDraftHead] = useState(head);
    const [focused, setFocused] = useState<"base" | "head" | null>(null);
    const baseRef = useRef<HTMLInputElement>(null);

    // Re-entering the picker starts from whatever the surface is currently comparing, and focus lands
    // on base — head is where you already are, base is the ref you came to change.
    useEffect(() => {
        if (editing) {
            setDraftBase(base);
            setDraftHead(head);
            baseRef.current?.focus();
            baseRef.current?.select();
        }
    }, [editing, base, head]);

    if (!editing) {
        // The swap sits outside the chip's own button rather than inside it — nesting a button in a
        // button is invalid, and clicking swap must not also open the editor.
        return (
            <div className="flex items-center gap-[4px] rounded-[9px] border border-accent/30 bg-accentbg pr-[8px]">
                <button
                    data-files-ref-expr
                    onClick={onEdit}
                    className="flex items-center gap-[8px] rounded-l-[9px] px-[11px] py-[6px] hover:bg-surface-hover"
                >
                    <span className="font-mono text-xxxs font-semibold uppercase tracking-[0.1em] text-ink-faint">
                        Compare
                    </span>
                    {/* base first, the order `git diff base...head` reads in and the order the summary
                        line beside this chip prints — the two used to name the same pair backwards */}
                    <span className="font-mono text-[12px] text-ink-hi">
                        {base || "—"} … {head || "—"}
                    </span>
                </button>
                <SwapButton onClick={onSwap} />
            </div>
        );
    }

    const apply = () => onApply(draftBase.trim(), draftHead.trim());
    const keys = (e: React.KeyboardEvent) => {
        if (e.key === "Enter") {
            e.preventDefault();
            apply();
        } else if (e.key === "Escape") {
            // cancels the edit only — leaving compare is Escape's job when the picker is closed
            e.preventDefault();
            e.stopPropagation();
            onCancel();
        }
    };
    const field = "w-[150px] bg-transparent font-mono text-[12px] text-ink-hi outline-none placeholder:text-ink-faint";

    return (
        <div className="relative flex items-center gap-[8px] rounded-[9px] border border-accent/30 bg-accentbg px-[11px] py-[6px]">
            <span className="font-mono text-xxxs font-semibold uppercase tracking-[0.1em] text-ink-faint">
                Compare
            </span>
            <div className="relative">
                <input
                    ref={baseRef}
                    value={draftBase}
                    onChange={(e) => setDraftBase(e.target.value)}
                    onFocus={() => setFocused("base")}
                    onKeyDown={keys}
                    placeholder="base ref"
                    // side colours come from comparerows, so the picker and the column cannot drift
                    className={cn(field, SIDE_TEXT.base)}
                />
                {focused === "base" ? (
                    <Suggestions branches={branches} query={draftBase} onPick={setDraftBase} />
                ) : null}
            </div>
            {/* swaps the drafts, not the applied pair: nothing is read until Compare */}
            <SwapButton
                onClick={() => {
                    setDraftBase(draftHead);
                    setDraftHead(draftBase);
                }}
            />
            <div className="relative">
                <input
                    value={draftHead}
                    onChange={(e) => setDraftHead(e.target.value)}
                    onFocus={() => setFocused("head")}
                    onKeyDown={keys}
                    placeholder="head ref"
                    className={cn(field, SIDE_TEXT.head)}
                />
                {focused === "head" ? (
                    <Suggestions branches={branches} query={draftHead} onPick={setDraftHead} />
                ) : null}
            </div>
            <button
                onClick={apply}
                className="flex-none rounded border border-border px-[8px] py-[2px] text-[11px] text-ink-mid hover:text-foreground"
            >
                Compare
            </button>
        </div>
    );
}
