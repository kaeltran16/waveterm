// frontend/app/view/agents/historypane.tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pane 1 of the Diff surface (Wave-git-review.dc.html): commits newest-first, the uncommitted row at
// the top, an optional lane gutter behind them. Rows are left-padded by the gutter width so the SVG
// and the list stay in register without the rows knowing any geometry.

import { SkeletonLine } from "@/app/element/skeleton";
import { cn } from "@/util/util";
import { assignLanes, laneCount } from "./gitgraph";
import { graphGeometry } from "./gitgraphgeom";
import { GraphGutter } from "./graphgutter";
import { WORKING_TREE, refChipClass, type HistoryRow } from "./historyrows";

const ROW_H = 34;
const HASH_W = 52;
// lanes past this fold into one grey column; nine concurrent lanes will not fit the history column
const MAX_LANES = 7;
const NO_GRAPH_PAD = 14;

function shortHash(hash: string): string {
    return hash === WORKING_TREE ? "·······" : hash.slice(0, 7);
}

// SkeletonLine takes only className, so the ragged widths are literal utility classes rather than an
// inline style — Tailwind cannot generate a class from a computed string either, so no template here.
const SKELETON_WIDTHS = ["w-[120px]", "w-[190px]", "w-[150px]", "w-[210px]", "w-[135px]"];

function HistorySkeleton() {
    return (
        <div className="px-[14px]">
            {Array.from({ length: 10 }).map((_, i) => (
                <div key={i} className="flex h-[34px] items-center gap-[10px]">
                    <SkeletonLine className="h-[9px] w-[9px] rounded-full" />
                    <SkeletonLine className={cn("h-[8px]", SKELETON_WIDTHS[i % SKELETON_WIDTHS.length])} />
                    <div className="flex-1" />
                    <SkeletonLine className="h-[8px] w-[34px]" />
                </div>
            ))}
        </div>
    );
}

function Row({
    row,
    laneIndent,
    selected,
    onSelect,
}: {
    row: HistoryRow;
    laneIndent: number;
    selected: boolean;
    onSelect: () => void;
}) {
    // refs eat the subject's width fast; show the first and collapse the rest into a count
    const chips = row.refs.length > 1 ? row.refs.slice(0, 1) : row.refs;
    const overflow = row.refs.length - chips.length;
    return (
        <button
            onClick={onSelect}
            style={{ height: ROW_H, paddingLeft: laneIndent }}
            className={cn(
                "relative flex w-full items-center gap-[9px] pr-[12px] text-left transition-colors duration-[140ms] hover:bg-surface",
                selected && "bg-surface-selected"
            )}
        >
            {selected ? <div className="absolute bottom-0 left-0 top-0 w-[2px] bg-accent" /> : null}
            <span
                style={{ width: HASH_W }}
                className={cn("flex-none font-mono text-[11px]", row.workingTree ? "text-ink-faint" : "text-muted")}
            >
                {shortHash(row.hash)}
            </span>
            {chips.map((r) => (
                <span
                    key={r.label}
                    className={cn(
                        "max-w-[110px] flex-none truncate rounded-[4px] border px-[6px] py-[1px] font-mono text-[9.5px] font-semibold",
                        refChipClass(r.kind)
                    )}
                >
                    {r.label}
                </span>
            ))}
            {overflow > 0 ? (
                <span className="flex-none rounded-[4px] border border-edge-mid bg-surface-raised px-[6px] py-[1px] font-mono text-[9.5px] font-semibold text-muted">
                    +{overflow}
                </span>
            ) : null}
            <span
                className={cn(
                    "min-w-[140px] flex-1 truncate text-[12.5px]",
                    row.before
                        ? "text-ink-faint"
                        : selected
                          ? "font-semibold text-ink-hi"
                          : row.workingTree
                            ? "text-warning"
                            : "text-foreground"
                )}
            >
                {row.subject}
            </span>
            {row.refs.length === 0 ? (
                <span className="flex-none truncate text-[11px] text-ink-faint" style={{ maxWidth: 92 }}>
                    {row.author}
                </span>
            ) : null}
            <span className="w-[42px] flex-none text-right font-mono text-[10.5px] text-ink-faint">{row.when}</span>
        </button>
    );
}

function Divider({ label }: { label: string }) {
    return (
        <div className="flex items-center gap-[9px] py-[6px] pl-[14px] pr-[12px]" style={{ height: 30 }}>
            <span className="flex-none rounded-[5px] border border-accent/30 bg-accentbg px-[7px] py-[2px] font-mono text-[8.5px] font-bold uppercase tracking-[0.1em] text-accent-soft">
                {label}
            </span>
            <div className="h-px flex-1 bg-accent/30" />
        </div>
    );
}

export function HistoryPane({
    rows,
    selected,
    graphOn,
    loading,
    onSelect,
}: {
    rows: HistoryRow[];
    selected: string | null;
    graphOn: boolean;
    loading: boolean;
    onSelect: (hash: string) => void;
}) {
    const laned = assignLanes(rows);
    const lanes = Math.min(Math.max(laneCount(laned), 1), MAX_LANES);
    const geom = graphGeometry(laned, { rowH: ROW_H, maxLanes: lanes });
    const indent = graphOn ? geom.gutter : NO_GRAPH_PAD;

    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex flex-none items-center gap-[9px] px-[14px] pb-[8px] pt-[10px]">
                <span className="font-mono text-[9px] font-bold uppercase tracking-[0.14em] text-muted">History</span>
                {graphOn && geom.foldedCount > 0 ? (
                    <span className="rounded-[5px] border border-edge-mid bg-surface-raised px-[7px] py-[2px] font-mono text-[9.5px] font-semibold text-graphlane-fold">
                        {laneCount(laned)} lanes · {geom.foldedCount} folded
                    </span>
                ) : null}
                <div className="flex-1" />
                <span className="font-mono text-[10px] text-ink-faint">
                    {loading ? "" : `${rows.length} commit${rows.length === 1 ? "" : "s"}`}
                </span>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto pb-[24px]">
                {loading ? (
                    <HistorySkeleton />
                ) : rows.length === 0 ? (
                    <div className="px-[14px] py-[6px] text-[12px] text-ink-mid">No commits</div>
                ) : (
                    <div className="relative">
                        {graphOn ? <GraphGutter geom={geom} /> : null}
                        {laned.map((row) => (
                            <div key={row.hash || "__wt__"}>
                                <Row
                                    row={row}
                                    laneIndent={indent}
                                    selected={selected === row.hash}
                                    onSelect={() => onSelect(row.hash)}
                                />
                                {row.divider ? <Divider label={row.divider} /> : null}
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}
