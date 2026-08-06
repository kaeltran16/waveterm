// frontend/app/view/agents/comparecolumn.tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pane 1 of the Diff surface in its compare state (Wave-git-review.dc.html, lines 376-399): the
// aggregate as row zero, then two labelled commit groups coloured by side, then the merge base. No
// graph gutter — compare has no lane geometry to draw, so rows are flush-padded instead of indented.

import { SkeletonLine } from "@/app/element/skeleton";
import { cn } from "@/util/util";
import {
    AGGREGATE,
    SIDE_DOT,
    SIDE_TEXT,
    type CompareCommitRow,
    type CompareHeaderRow,
    type CompareRow,
} from "./comparerows";

const ROW_H = 32;
const PAD = 14;

function CompareSkeleton() {
    return (
        <div className="px-[14px]">
            {Array.from({ length: 8 }).map((_, i) => (
                <div key={i} className="flex h-[32px] items-center gap-[9px]">
                    <SkeletonLine className="h-[7px] w-[7px] rounded-full" />
                    <SkeletonLine className="h-[8px] w-[46px]" />
                    <SkeletonLine className="h-[8px] w-[150px]" />
                </div>
            ))}
        </div>
    );
}

function AggregateRowView({
    row,
    selected,
    onSelect,
}: {
    row: Extract<CompareRow, { kind: "aggregate" }>;
    selected: boolean;
    onSelect: () => void;
}) {
    return (
        <button
            onClick={onSelect}
            style={{ height: ROW_H, paddingLeft: PAD }}
            className={cn(
                "relative flex w-full items-center gap-[9px] pr-[12px] text-left transition-colors duration-[140ms] hover:bg-surface",
                selected && "bg-surface-selected"
            )}
        >
            {/* no left accent bar — the fill marks the selection, matching historypane.tsx */}
            <span className="font-mono text-[9px] font-bold uppercase tracking-[0.14em] text-muted">Aggregate</span>
            <div className="flex-1" />
            {row.files == null ? (
                <SkeletonLine className="h-[8px] w-[80px]" />
            ) : (
                <>
                    <span className="font-mono text-[10.5px] text-ink-faint">
                        {row.files} {row.files === 1 ? "file" : "files"}
                    </span>
                    <span className="font-mono text-[10px] font-semibold text-success">+{row.adds}</span>
                    <span className="font-mono text-[10px] font-semibold text-error">−{row.dels}</span>
                </>
            )}
        </button>
    );
}

function HeaderRowView({ row }: { row: CompareHeaderRow }) {
    return (
        <div className="flex items-center gap-[8px] px-[14px] pb-[8px] pt-[12px]">
            <span className={cn("h-[7px] w-[7px] flex-none rounded-full", SIDE_DOT[row.side])} />
            <span className={cn("font-mono text-[11.5px] font-semibold", SIDE_TEXT[row.side])}>{row.ref}</span>
            <span className="text-[11.5px] text-muted">{row.note}</span>
            <div className="flex-1" />
            <span className="flex-none rounded-[5px] border border-edge-mid bg-surface-raised px-[7px] py-[2px] font-mono text-[10px] font-semibold text-ink-faint">
                {row.count}
            </span>
        </div>
    );
}

function CommitRowView({
    row,
    selected,
    onSelect,
}: {
    row: CompareCommitRow;
    selected: boolean;
    onSelect: () => void;
}) {
    return (
        <button
            onClick={onSelect}
            style={{ height: ROW_H }}
            className={cn(
                "relative flex w-full items-center gap-[9px] pl-[20px] pr-[12px] text-left transition-colors duration-[140ms] hover:bg-surface",
                selected && "bg-surface-selected"
            )}
        >
            {/* no left accent bar — the fill marks the selection, matching historypane.tsx */}
            <span className={cn("h-[7px] w-[7px] flex-none rounded-full opacity-85", SIDE_DOT[row.side])} />
            <span className="flex-none font-mono text-[11px] text-muted">{row.hash.slice(0, 7)}</span>
            <span
                className={cn(
                    "min-w-0 flex-1 truncate text-[12.5px]",
                    selected ? "font-semibold text-ink-hi" : "text-foreground"
                )}
            >
                {row.subject}
            </span>
            <span className="max-w-[92px] flex-none truncate text-[11px] text-ink-faint">{row.author}</span>
        </button>
    );
}

export function CompareColumn({
    rows,
    selected,
    mergeBase,
    error,
    loading,
    onSelect,
}: {
    rows: CompareRow[];
    selected: string;
    mergeBase: string;
    error: string | null;
    loading: boolean;
    onSelect: (id: string) => void;
}) {
    const diverges = rows.some((r) => r.kind === "commit");
    return (
        <div data-compare-column className="flex min-h-0 flex-1 flex-col">
            <div className="flex flex-none items-center gap-[9px] px-[14px] pb-[8px] pt-[10px]">
                <span className="font-mono text-[9px] font-bold uppercase tracking-[0.14em] text-muted">Compare</span>
                <div className="flex-1" />
                <span className="font-mono text-[10px] text-ink-faint">
                    {loading || !diverges ? "" : `${rows.filter((r) => r.kind === "commit").length} divergent commits`}
                </span>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto pb-[24px]">
                {error != null ? (
                    <div className="px-[14px] py-[8px] text-[12px] text-error">{error}</div>
                ) : loading ? (
                    <CompareSkeleton />
                ) : (
                    <>
                        {rows.map((row) =>
                            row.kind === "aggregate" ? (
                                <AggregateRowView
                                    key={row.id}
                                    row={row}
                                    selected={selected === AGGREGATE}
                                    onSelect={() => onSelect(AGGREGATE)}
                                />
                            ) : row.kind === "header" ? (
                                <HeaderRowView key={row.id} row={row} />
                            ) : (
                                <CommitRowView
                                    key={row.id}
                                    row={row}
                                    selected={selected === row.id}
                                    onSelect={() => onSelect(row.id)}
                                />
                            )
                        )}
                        {/* A stated result, not an empty list: two refs that agree is an answer. */}
                        {!diverges ? (
                            <div className="px-[14px] py-[8px] text-[12px] text-ink-mid">These refs do not diverge.</div>
                        ) : null}
                        {mergeBase ? (
                            <div className="mx-[14px] mb-[30px] mt-[8px] rounded-[9px] border border-edge-faint bg-surface px-[12px] py-[10px]">
                                <p className="text-[11.5px] leading-[1.5] text-ink-faint">
                                    Merge base{" "}
                                    <span className="font-mono text-[11px] text-ink-mid">{mergeBase.slice(0, 7)}</span>.
                                    The file list stays on the aggregate until you select a commit.
                                </p>
                            </div>
                        ) : null}
                    </>
                )}
            </div>
        </div>
    );
}
