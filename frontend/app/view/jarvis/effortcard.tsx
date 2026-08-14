// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The effort card: a whole-card button that expands in place into the inline chunk tracker
// (Task 5). Resting state only here — title, tags, progress, tone chips, copy handle.

import { cn } from "@/util/util";
import { CHUNK_CHIP_CLASSES, type ChunkChip, type EffortCardModel } from "./effortmodel";
import { ProgressBar } from "./progressbar";

const MARKS: Record<ChunkChip["tone"], string | null> = {
    done: "✓",
    active: "▶",
    blocked: "!",
    deferred: "⏸",
    skipped: "–",
    pending: null,
};

function Tag({ children }: { children: React.ReactNode }) {
    return (
        <span className="flex-none rounded-full bg-surface-raised px-[6px] py-[1px] font-mono text-[9.5px] text-muted">
            {children}
        </span>
    );
}

function Chip({ chip }: { chip: ChunkChip }) {
    const mark = MARKS[chip.tone];
    return (
        <span
            className={cn(
                "inline-flex items-center gap-[3px] rounded-full border border-border px-[7px] py-[1px] font-mono text-[9.5px]",
                CHUNK_CHIP_CLASSES[chip.tone]
            )}
        >
            {mark != null ? <span className="text-[8.5px] leading-none">{mark}</span> : null}
            {chip.label}
        </span>
    );
}

export function EffortCard({
    model,
    expanded,
    onToggle,
}: {
    model: EffortCardModel;
    expanded: boolean;
    onToggle: () => void;
}) {
    const oid = model.oref.replace(/^effort:/, "");
    return (
        <button
            type="button"
            onClick={onToggle}
            aria-expanded={expanded}
            className="cursor-pointer rounded-[10px] border border-border bg-surface px-[13px] py-[11px] text-left transition-colors duration-[140ms] hover:bg-surface-hover"
        >
            <span className="flex items-baseline gap-2">
                <span className="truncate text-[13px] font-semibold text-primary">{model.title}</span>
                {model.ticket != null && <Tag>{model.ticket}</Tag>}
                {model.project != null && <Tag>{model.project}</Tag>}
                {model.parentoid != null && <Tag>parent</Tag>}
                <span className="ml-auto flex flex-none items-center gap-2">
                    <span
                        role="button"
                        tabIndex={0}
                        title="copy the CLI handle"
                        onClick={(e) => {
                            e.stopPropagation();
                            void navigator.clipboard.writeText("wsh effort show " + oid);
                        }}
                        onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                                e.stopPropagation();
                                void navigator.clipboard.writeText("wsh effort show " + oid);
                            }
                        }}
                        className="cursor-pointer rounded-full border border-dotted border-accent/40 px-[7px] py-[1px] font-mono text-[9.5px] text-accent-soft hover:border-accent/70"
                    >
                        wsh effort show {oid}
                    </span>
                    <span className="font-mono text-[10px] text-muted">
                        {expanded ? "▾ collapse" : model.countLine}
                    </span>
                </span>
            </span>
            <ProgressBar pct={model.progressPct} className="mt-2" />
            <span className="mt-2 flex flex-wrap gap-1">
                {model.chips.map((c) => (
                    <Chip key={c.label} chip={c} />
                ))}
                {model.chipOverflow > 0 && (
                    <span className="inline-flex items-center rounded-full border border-dotted border-accent/40 px-[7px] py-[1px] font-mono text-[9.5px] text-accent-soft">
                        +{model.chipOverflow}
                    </span>
                )}
            </span>
            {expanded && <span className="mt-2 block">…</span> /* Task 5 replaces this */}
        </button>
    );
}
