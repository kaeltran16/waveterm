// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Behind you: what landed since your last visit, grouped by day, then Shipped over the last seven days
// under its own kind filter.

import { cn } from "@/util/util";
import { SHIPPED_CAP } from "./briefingmodel";
import { markBriefingSeen } from "./briefingstore";
import { MoreControl, runKindFilter } from "./briefprimitives";
import { SHIPPED_LABEL, type BriefLine, type LineGroup, type LineTarget, type RunKindFilter } from "./briefrows";
import { DeltaRowView, ShippedRowView } from "./briefrowviews";
import { MONO_FAINT, REGION_LABEL } from "./briefstyle";
import { briefUndo } from "./briefundo";

export function BehindRegion({
    sectionRef,
    since,
    groups,
    cursor,
    openLine,
    more,
    expanded,
    onToggleMore,
    shippedTotal,
    shippedLines,
    shippedKind,
    onShippedKind,
    shippedCounts,
    shippedOpen,
    onToggleShipped,
    filtering,
    sheetOpen,
    stageRunId,
}: {
    // the dwell's in-view observer watches this section
    sectionRef: (el: HTMLElement | null) => void;
    since: string;
    // the delta's day groups, Shipped excluded
    groups: LineGroup[];
    cursor: string | undefined;
    openLine: (target: LineTarget, e?: React.MouseEvent) => void;
    more: number;
    expanded: boolean;
    onToggleMore: () => void;
    // every shipped run the kind filter keeps, before the cap
    shippedTotal: number;
    shippedLines: BriefLine[];
    shippedKind: RunKindFilter;
    onShippedKind: (k: RunKindFilter) => void;
    shippedCounts: Record<RunKindFilter, number>;
    shippedOpen: boolean;
    onToggleShipped: () => void;
    filtering: boolean;
    sheetOpen: boolean;
    // the run the sheet shows
    stageRunId: string | undefined;
}) {
    const deltaRowsN = groups.reduce((n, g) => n + g.lines.length, 0);
    const shippedFilter = runKindFilter(shippedKind, onShippedKind, shippedCounts);
    return (
        <section ref={sectionRef} data-jarvis-brief-region="behind" className="flex flex-col gap-[9px]">
            <div className="flex items-center gap-[9px]">
                <span className={cn(REGION_LABEL, "text-ink-mid")}>Behind you</span>
                <span className="h-px min-w-3 flex-1 bg-edge-faint" />
                <span className={MONO_FAINT}>{since}</span>
                {deltaRowsN > 0 ? (
                    <button
                        type="button"
                        data-jarvis-brief-mark-seen
                        onClick={() => {
                            const undo = markBriefingSeen();
                            briefUndo.notify("Marked seen", undo);
                        }}
                        className="cursor-pointer font-mono text-[10.5px] text-accent-soft hover:underline"
                    >
                        mark seen
                    </button>
                ) : null}
            </div>
            <div className="flex flex-col">
                {deltaRowsN === 0 ? (
                    <div className="px-[11px] py-[7px] text-[12.5px] text-ink-mid">
                        Nothing new since you last looked.
                    </div>
                ) : null}
                {groups.map((g) => (
                    <div key={g.label} className="flex flex-col">
                        <div className="px-[11px] pb-0.5 pt-1.5 font-mono text-[10.5px] font-bold uppercase tracking-[.09em] text-muted">
                            {g.label}
                        </div>
                        {g.lines.map((l) => (
                            <DeltaRowView
                                key={l.id}
                                line={l}
                                focused={cursor === l.id}
                                onOpen={l.target != null ? (e) => openLine(l.target, e) : undefined}
                            />
                        ))}
                    </div>
                ))}
                <MoreControl n={more} expanded={expanded} onToggle={onToggleMore} />
                <div className="flex items-center gap-2 px-[11px] pb-0.5 pt-3 font-mono text-[10.5px] font-bold uppercase tracking-[.09em] text-muted">
                    <span>{SHIPPED_LABEL}</span>
                    <span className="font-normal tracking-[.04em]">{shippedTotal}</span>
                    {shippedFilter.menu ? (
                        <span className="ml-auto font-normal normal-case tracking-normal">{shippedFilter.node}</span>
                    ) : null}
                </div>
                {shippedFilter.menu ? null : <div className="px-[11px] pb-1">{shippedFilter.node}</div>}
                {shippedTotal === 0 ? (
                    <div className="px-[11px] py-[7px] text-[12.5px] text-ink-mid">
                        {shippedKind === "all"
                            ? "Nothing shipped in the last seven days."
                            : `No ${shippedKind} run shipped in the last seven days.`}
                    </div>
                ) : null}
                {shippedLines.map((l) => (
                    <ShippedRowView
                        key={l.id}
                        line={l}
                        focused={cursor === l.id}
                        selected={
                            sheetOpen &&
                            stageRunId != null &&
                            l.target != null &&
                            "oref" in l.target &&
                            l.target.oref === "run:" + stageRunId
                        }
                        onOpen={l.target != null ? (e) => openLine(l.target, e) : undefined}
                    />
                ))}
                {shippedTotal > SHIPPED_CAP && !filtering ? (
                    <button
                        type="button"
                        data-jarvis-brief-shipped-more
                        onClick={onToggleShipped}
                        className="cursor-pointer self-start px-[11px] py-[7px] font-mono text-[10.5px] text-accent-soft hover:underline"
                    >
                        {shippedOpen ? "show less" : `+${shippedTotal - SHIPPED_CAP} more`}
                    </button>
                ) : null}
            </div>
        </section>
    );
}
