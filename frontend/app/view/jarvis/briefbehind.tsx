// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Behind you: what landed since your last visit, grouped by day, then Shipped over the last seven days
// under its own kind filter.

import { cn } from "@/util/util";
import { SHIPPED_CAP } from "./briefingmodel";
import { markBriefingSeen } from "./briefingstore";
import { LegMissing, MoreControl, NoMatch, RegionHead, REGIONS, runKindFilter } from "./briefprimitives";
import { SHIPPED_LABEL, type BriefLine, type LineGroup, type LineTarget, type RunKindFilter } from "./briefrows";
import { DeltaRowView, ShippedRowView } from "./briefrowviews";
import { MONO_FAINT } from "./briefstyle";
import { briefUndo } from "./briefundo";

export function BehindRegion({
    sectionRef,
    since,
    deltaTotal,
    only,
    onOnly,
    groups,
    cursor,
    openLine,
    more,
    expanded,
    onToggleMore,
    shippedTotal,
    shippedMissing,
    shippedLines,
    shippedKind,
    onShippedKind,
    shippedCounts,
    shippedFilterShown,
    shippedOpen,
    onToggleShipped,
    filtering,
    sheetOpen,
    stageRunId,
}: {
    // the dwell's in-view observer watches this section
    sectionRef: (el: HTMLElement | null) => void;
    since: string;
    // every delta row before the filter: mark seen acts on all of them, not on the matches
    deltaTotal: number;
    only: boolean;
    onOnly: () => void;
    // the delta's day groups as drawn (folded, filtered, capped), Shipped excluded
    groups: LineGroup[];
    cursor: string | undefined;
    openLine: (target: LineTarget, e?: React.MouseEvent) => void;
    more: number;
    expanded: boolean;
    onToggleMore: () => void;
    // every shipped run the kind filter keeps, before the cap
    shippedTotal: number;
    // the snapshot could not read the runs leg, which Shipped is read from
    shippedMissing: boolean;
    shippedLines: BriefLine[];
    shippedKind: RunKindFilter;
    onShippedKind: (k: RunKindFilter) => void;
    // each kind chip's count label (kindLabels)
    shippedCounts: Record<RunKindFilter, string>;
    shippedFilterShown: boolean;
    shippedOpen: boolean;
    onToggleShipped: () => void;
    filtering: boolean;
    sheetOpen: boolean;
    // the run the sheet shows
    stageRunId: string | undefined;
}) {
    const deltaRowsN = groups.reduce((n, g) => n + g.lines.length, 0);
    const shippedFilter = shippedFilterShown ? runKindFilter(shippedKind, onShippedKind, shippedCounts) : null;
    return (
        <section ref={sectionRef} data-jarvis-brief-region="behind" className="flex flex-col gap-[9px]">
            {/* the head is the same show-only button the other regions have; since and mark seen sit beside
                it, since a control cannot nest inside a button */}
            <div className="flex items-center gap-[9px]">
                <RegionHead id="behind" label={REGIONS.behind.label} meta="" only={only} onOnly={onOnly} />
                <span className={cn("flex-none", MONO_FAINT)}>{since}</span>
                {deltaTotal > 0 ? (
                    <button
                        type="button"
                        data-jarvis-brief-mark-seen
                        onClick={() => {
                            const undo = markBriefingSeen();
                            briefUndo.notify("Marked seen", undo);
                        }}
                        className="flex-none cursor-pointer whitespace-nowrap font-mono text-[10.5px] text-accent-soft hover:underline"
                    >
                        mark seen
                    </button>
                ) : null}
            </div>
            <div className="flex flex-col">
                {deltaTotal === 0 ? (
                    <div className="px-[11px] py-[7px] text-[12.5px] text-ink-mid">
                        Nothing new since you last looked.
                    </div>
                ) : deltaRowsN === 0 ? (
                    <NoMatch />
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
                    {shippedFilter?.menu ? (
                        <span className="ml-auto font-normal normal-case tracking-normal">{shippedFilter.node}</span>
                    ) : null}
                </div>
                {shippedFilter != null && !shippedFilter.menu ? (
                    <div className="px-[11px] pb-1">{shippedFilter.node}</div>
                ) : null}
                {shippedMissing ? <LegMissing what="shipped runs" /> : null}
                {shippedTotal === 0 && !shippedMissing ? (
                    <div className="px-[11px] py-[7px] text-[12.5px] text-ink-mid">
                        {shippedKind === "all"
                            ? "Nothing shipped in the last seven days."
                            : `No ${shippedKind} run shipped in the last seven days.`}
                    </div>
                ) : filtering && shippedLines.length === 0 ? (
                    <NoMatch />
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
