// frontend/app/view/agents/historyrail.tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The history column at its collapsed width: hashes and lane colour, nothing else. A narrow
// presentation of rows the surface already has — no second data path, no second selection model.

import { cn } from "@/util/util";
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
        <div className="flex min-h-0 flex-1 flex-col">
            <button
                onClick={onExpand}
                title="Expand history"
                className="flex-none border-b border-edge-faint py-[6px] text-[11px] text-ink-faint hover:text-foreground"
            >
                ›
            </button>
            <div className="min-h-0 flex-1 overflow-y-auto py-[4px]">
                {rows.map((r) => (
                    <button
                        key={r.hash || WORKING_TREE}
                        onClick={() => onSelect(r.hash)}
                        title={r.subject}
                        style={{ height: ROW_H }}
                        className={cn(
                            "flex w-full items-center justify-center font-mono text-[9px] text-ink-faint hover:text-foreground",
                            r.hash === selected && "bg-surface-selected text-ink-hi"
                        )}
                    >
                        {r.hash === WORKING_TREE ? "·······" : r.hash.slice(0, 7)}
                    </button>
                ))}
            </div>
        </div>
    );
}
