// frontend/app/view/agents/historyfilterrow.tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The filter row (Wave-git-review.dc.html, the `filtered` state): free text over commit subjects,
// plus an author and a path chip, the active count with "Clear all", and the Graph toggle — which
// lives here rather than in the subject bar because the mockup puts it at the end of this row.
// Three plain inputs, deliberately not a prefix query language: a parser buys one fewer field and
// costs an error state plus a discoverability problem.

import { globalStore } from "@/app/store/jotaiStore";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { useState } from "react";
import {
    clearHistoryFilters,
    graphOnAtom,
    historyFiltersAtom,
    historyRowsAtom,
    setHistoryFilter,
} from "./githistorystore";
import { filterSummary } from "./historyquery";

// A chip is a button until you click it, then a one-line input. Which chip is open is transient, so
// it is the one piece of state here that is allowed to be component-local.
function FilterChip({
    label,
    value,
    placeholder,
    onChange,
}: {
    label: string;
    value: string;
    placeholder: string;
    onChange: (v: string) => void;
}) {
    const [editing, setEditing] = useState(false);
    const on = value.trim() !== "";
    if (editing) {
        return (
            <span className="flex items-center gap-[7px] rounded-[7px] border border-accent/30 bg-accentbg px-[9px] py-[4px]">
                <span className="font-mono text-[9px] font-semibold uppercase tracking-[0.06em] text-ink-faint">
                    {label}
                </span>
                <input
                    autoFocus
                    value={value}
                    placeholder={placeholder}
                    onChange={(e) => onChange(e.target.value)}
                    onBlur={() => setEditing(false)}
                    onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === "Escape") {
                            setEditing(false);
                        }
                    }}
                    className="w-[150px] bg-transparent font-mono text-[11.5px] text-ink-hi outline-none placeholder:text-ink-faint"
                />
            </span>
        );
    }
    return (
        <span
            className={cn(
                "flex items-center gap-[7px] rounded-[7px] border px-[9px] py-[4px] text-[11.5px] font-semibold",
                on ? "border-accent/30 bg-accentbg text-ink-hi" : "border-edge-mid bg-surface text-muted"
            )}
        >
            <button onClick={() => setEditing(true)} className="flex items-center gap-[7px]">
                <span className="font-mono text-[9px] font-semibold uppercase tracking-[0.06em] text-ink-faint">
                    {label}
                </span>
                <span className="max-w-[170px] truncate font-mono text-[11.5px]">{on ? value : placeholder}</span>
            </button>
            {on ? (
                <button onClick={() => onChange("")} className="flex-none text-[11px] opacity-70 hover:opacity-100">
                    ✕
                </button>
            ) : null}
        </span>
    );
}

export function HistoryFilterRow() {
    const filters = useAtomValue(historyFiltersAtom);
    const rows = useAtomValue(historyRowsAtom);
    const graphOn = useAtomValue(graphOnAtom);
    const summary = filterSummary(filters, rows?.length ?? 0);
    return (
        <div className="flex flex-none items-center gap-[8px] border-b border-edge-faint px-[18px] pb-[11px]">
            <div className="flex w-[250px] items-center gap-[8px] rounded-[8px] border border-edge-mid bg-surface px-[10px] py-[5px] focus-within:border-accent/30">
                <span className="flex-none font-mono text-[11px] font-semibold text-ink-faint">/</span>
                <input
                    data-history-filter
                    value={filters.text}
                    placeholder="Filter history — message text"
                    onChange={(e) => setHistoryFilter({ text: e.target.value })}
                    onKeyDown={(e) => {
                        // Escape here means "leave the field", not "clear the filters" — the key's
                        // surface-level meaning is claimed by a binding that only fires outside a field.
                        if (e.key === "Escape") {
                            (e.target as HTMLInputElement).blur();
                        }
                    }}
                    className="min-w-0 flex-1 bg-transparent font-mono text-[12px] text-ink-hi outline-none placeholder:text-ink-faint"
                />
            </div>
            <FilterChip
                label="author"
                value={filters.author}
                placeholder="anyone"
                onChange={(v) => setHistoryFilter({ author: v })}
            />
            <FilterChip
                label="path"
                value={filters.path}
                placeholder="any path"
                onChange={(v) => setHistoryFilter({ path: v })}
            />
            {summary ? (
                <div className="flex items-center gap-[8px] text-[11.5px]">
                    <span data-filter-count className="font-semibold text-accent-soft">
                        {summary}
                    </span>
                    <button
                        onClick={() => clearHistoryFilters()}
                        className="text-muted underline hover:text-foreground"
                    >
                        Clear all · esc
                    </button>
                </div>
            ) : null}
            <div className="flex-1" />
            <button
                onClick={() => globalStore.set(graphOnAtom, !graphOn)}
                className={cn(
                    "flex items-center gap-[7px] rounded-[7px] border px-[10px] py-[5px] text-[11.5px] font-semibold",
                    graphOn ? "border-accent/30 bg-accentbg text-ink-hi" : "border-edge-mid bg-surface text-muted"
                )}
            >
                Graph
                <span className="font-mono text-[9.5px] text-ink-faint">G</span>
            </button>
        </div>
    );
}
