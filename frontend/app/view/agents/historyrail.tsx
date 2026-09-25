// frontend/app/view/agents/historyrail.tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The history column at its collapsed width: one lane dot per row on a single line, nothing else. A
// narrow presentation of rows the surface already has — no second data path, no second selection model.

import { cn } from "@/util/util";
import { PanelLeftOpen } from "lucide-react";
import { WORKING_TREE, type HistoryRow } from "./historyrows";

const ROW_H = 34;

export function HistoryRail({
    rows,
    selected,
    onSelect,
    onExpand,
}: {
    rows: HistoryRow[];
    selected: string | null;
    onSelect: (hash: string) => void;
    onExpand: () => void;
}) {
    return (
        <div data-history-rail className="flex min-h-0 flex-1 flex-col">
            <button
                onClick={onExpand}
                title="Expand history"
                aria-label="Expand history"
                className="flex flex-none items-center justify-center py-[8px] text-ink-faint hover:text-foreground"
            >
                <PanelLeftOpen size={15} />
            </button>
            <div className="min-h-0 flex-1 overflow-y-auto py-[4px]">
                <div className="relative">
                    <div className="absolute bottom-0 left-1/2 top-0 w-[2px] -translate-x-1/2 bg-graphlane-1/40" />
                    {rows.map((r) => (
                        <button
                            key={r.hash || WORKING_TREE}
                            onClick={() => onSelect(r.hash)}
                            title={r.subject}
                            style={{ height: ROW_H }}
                            className={cn(
                                "relative flex w-full items-center justify-center hover:bg-surface",
                                r.hash === selected && "bg-surface-selected"
                            )}
                        >
                            <span
                                className={cn(
                                    "h-[8px] w-[8px] rounded-full",
                                    r.workingTree
                                        ? "border border-dashed border-warning bg-background"
                                        : "bg-graphlane-1",
                                    r.hash === selected && "ring-2 ring-accent/40"
                                )}
                            />
                        </button>
                    ))}
                </div>
            </div>
        </div>
    );
}
