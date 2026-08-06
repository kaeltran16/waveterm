// frontend/app/view/agents/rangestrip.tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The Diff surface's range control. Replaces a three-way segmented control whose click handler did
// nothing outside of comparison mode: a chip is drawn only when it has something to switch to, and a
// chip that is drawn but temporarily unusable carries the disabled attribute and says why, so it takes
// no keyboard focus and is announced as disabled rather than as a button.

import { cn } from "@/util/util";
import { rangeKey, type DiffRange, type RangeOption } from "./diffscope";

export function RangeStrip({
    options,
    active,
    onPick,
}: {
    options: RangeOption[];
    active: DiffRange;
    onPick: (range: DiffRange) => void;
}) {
    return (
        <div className="flex items-center overflow-hidden rounded-[9px] border border-edge-mid bg-surface">
            {options.map((o) => {
                const selected = o.range.kind === active.kind;
                return (
                    <button
                        key={rangeKey(o.range)}
                        data-range-chip={o.range.kind}
                        // which chip is active is otherwise only colour, which a screen reader cannot see
                        aria-pressed={selected}
                        disabled={!o.available}
                        title={o.reason}
                        onClick={() => onPick(o.range)}
                        className={cn(
                            "flex items-center gap-[6px] border-r border-edge-faint px-[11px] py-[6px] text-[11.5px] font-semibold last:border-r-0",
                            selected ? "bg-surface-selected text-ink-hi" : "text-muted hover:text-foreground",
                            !o.available && "cursor-not-allowed opacity-40 hover:text-muted"
                        )}
                    >
                        {o.label}
                        {o.detail ? (
                            <span
                                className={cn(
                                    "max-w-[90px] truncate font-mono text-[10.5px]",
                                    selected ? "text-accent-soft" : "text-edge-strong"
                                )}
                            >
                                {o.detail}
                            </span>
                        ) : null}
                    </button>
                );
            })}
        </div>
    );
}
