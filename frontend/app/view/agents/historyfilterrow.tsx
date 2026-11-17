// frontend/app/view/agents/historyfilterrow.tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The filter row, inside the history column under its header: free text over commit subjects, plus
// an author and a path chip. The match count, Clear filters and the Graph toggle live in the header
// (historypane.tsx), which is the row the diff-polish boards put them on.
// Three plain inputs, deliberately not a prefix query language: a parser buys one fewer field and
// costs an error state plus a discoverability problem.

import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { Search, X } from "lucide-react";
import { useState } from "react";
import { historyFiltersAtom, setHistoryFilter } from "./githistorystore";

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
            <span className="flex h-[28px] flex-none items-center gap-[7px] rounded-[7px] border border-accent/30 bg-accentbg px-[9px]">
                <span className="text-[11.5px] font-semibold text-muted">{label}</span>
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
                    className="w-[110px] bg-transparent font-mono text-[11.5px] text-ink-hi outline-none placeholder:text-muted"
                />
            </span>
        );
    }
    return (
        <span
            className={cn(
                "flex h-[28px] flex-none items-center gap-[7px] rounded-[7px] border px-[9px] text-[11.5px] font-semibold",
                on ? "border-accent/30 bg-accentbg text-ink-hi" : "border-edge-mid bg-surface text-muted"
            )}
        >
            <button onClick={() => setEditing(true)} className="flex min-w-0 items-center gap-[7px]">
                <span className="text-[11.5px] font-semibold text-muted">{label}</span>
                <span className="max-w-[80px] truncate font-mono text-[11.5px]">{on ? value : placeholder}</span>
            </button>
            {on ? (
                <button
                    onClick={() => onChange("")}
                    aria-label={`Clear ${label}`}
                    className="flex-none opacity-70 hover:opacity-100"
                >
                    <X size={12} />
                </button>
            ) : null}
        </span>
    );
}

export function HistoryFilterRow() {
    const filters = useAtomValue(historyFiltersAtom);
    return (
        <div className="flex flex-none items-center gap-[8px] px-[12px] pb-[10px]">
            <div className="flex h-[28px] min-w-0 flex-1 items-center gap-[8px] rounded-[7px] border border-edge-mid bg-surface px-[10px] focus-within:border-accent/30">
                <Search size={13} className="flex-none text-muted" />
                <input
                    data-history-filter
                    value={filters.text}
                    title="Filter by message (/)"
                    placeholder="Filter by message"
                    onChange={(e) => setHistoryFilter({ text: e.target.value })}
                    onKeyDown={(e) => {
                        // Escape here means "leave the field", not "clear the filters" — the key's
                        // surface-level meaning is claimed by a binding that only fires outside a field.
                        if (e.key === "Escape") {
                            (e.target as HTMLInputElement).blur();
                        }
                    }}
                    className="min-w-0 flex-1 bg-transparent font-mono text-[12px] text-ink-hi outline-none placeholder:text-muted"
                />
            </div>
            <FilterChip
                label="Author"
                value={filters.author}
                placeholder="anyone"
                onChange={(v) => setHistoryFilter({ author: v })}
            />
            <FilterChip
                label="Path"
                value={filters.path}
                placeholder="any"
                onChange={(v) => setHistoryFilter({ path: v })}
            />
        </div>
    );
}
