// frontend/app/view/agents/historyrail.tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The history column at its collapsed width: one lane dot per row on a single line, nothing else. A
// narrow presentation of rows the surface already has — no second data path, no second selection model.

import { cn } from "@/util/util";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import type { UIEvent } from "react";
import { AGGREGATE } from "./comparerows";
import { NEAR_BOTTOM_PX } from "./historyquery";
import { WORKING_TREE, type HistoryRow } from "./historyrows";

const ROW_H = 34;

function RailDot({
    title,
    selected,
    onClick,
    dotClass,
    attrs,
}: {
    title: string;
    selected: boolean;
    onClick: () => void;
    dotClass: string;
    attrs?: Record<string, string>;
}) {
    return (
        <button
            {...attrs}
            onClick={onClick}
            title={title}
            aria-current={selected ? "true" : undefined}
            style={{ height: ROW_H }}
            className={cn(
                "relative flex w-full items-center justify-center hover:bg-surface",
                selected && "bg-surface-selected"
            )}
        >
            <span className={cn("h-[8px] w-[8px] rounded-full", dotClass, selected && "ring-2 ring-accent/40")} />
        </button>
    );
}

export function HistoryRail({
    rows,
    selected,
    onSelect,
    onToggle,
    expanded = false,
    allChanges = false,
    hasMore = false,
    onLoadMore,
}: {
    rows: HistoryRow[];
    selected: string | null;
    onSelect: (hash: string) => void;
    onToggle: () => void;
    // the history is drawn over the panes beside this rail, so the button folds it back
    expanded?: boolean;
    // compare: a first dot for the whole comparison
    allChanges?: boolean;
    hasMore?: boolean;
    onLoadMore?: () => void;
}) {
    const label = expanded ? "Collapse history" : "Expand history";
    const onScroll = (e: UIEvent<HTMLDivElement>) => {
        const el = e.currentTarget;
        if (hasMore && onLoadMore && el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX) {
            onLoadMore();
        }
    };
    return (
        <div data-history-rail className="flex min-h-0 flex-1 flex-col">
            <button
                onClick={onToggle}
                title={label}
                aria-label={label}
                aria-expanded={expanded}
                className="flex flex-none items-center justify-center py-[8px] text-ink-faint hover:text-foreground"
            >
                {expanded ? <PanelLeftClose size={15} /> : <PanelLeftOpen size={15} />}
            </button>
            <div data-history-rail-scroll onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto py-[4px]">
                <div className="relative">
                    <div className="absolute bottom-0 left-1/2 top-0 w-[2px] -translate-x-1/2 bg-graphlane-1/40" />
                    {allChanges ? (
                        <RailDot
                            title="All changes"
                            selected={selected === AGGREGATE}
                            onClick={() => onSelect(AGGREGATE)}
                            dotClass="border border-accent bg-background"
                            attrs={{ "data-history-rail-all": "" }}
                        />
                    ) : null}
                    {rows.map((r) => (
                        <RailDot
                            key={r.hash || WORKING_TREE}
                            title={r.subject}
                            selected={r.hash === selected}
                            onClick={() => onSelect(r.hash)}
                            dotClass={
                                r.workingTree ? "border border-dashed border-warning bg-background" : "bg-graphlane-1"
                            }
                            attrs={{ "data-history-rail-row": r.hash }}
                        />
                    ))}
                </div>
            </div>
        </div>
    );
}
