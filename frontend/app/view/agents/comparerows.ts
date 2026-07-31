// frontend/app/view/agents/comparerows.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pure: a divergence read -> the rows the compare column draws. The aggregate is row zero of the
// column rather than a separate control, mirroring how the working tree is row zero of the history —
// so "back to the aggregate" is just a selection, with no gesture and no key whose meaning depends
// on invisible state. Selection order, side colouring and the Tab jump all live here so the column
// stays a renderer.

import type { GitChanges } from "./gitstatus";
import { toRow, type HistoryRow } from "./historyrows";

// Sentinel id for the aggregate row. Deliberately non-empty and deliberately NOT history's
// WORKING_TREE (""): the two row models stay independent, so nothing has to reason about whether an
// empty id means the working tree or the aggregate.
export const AGGREGATE = "__aggregate__";

// "head" is the ref whose commits the aggregate diff describes; "base" is what it is measured against.
export type CompareSide = "head" | "base";

export interface CompareAggregateRow {
    kind: "aggregate";
    id: typeof AGGREGATE;
    // null while the aggregate read is still in flight, so the row can render pending rather than "0 files"
    files: number | null;
    adds: number;
    dels: number;
}

export interface CompareHeaderRow {
    kind: "header";
    id: string; // "header:head" | "header:base" — never navigable, so it only needs to be unique
    side: CompareSide;
    ref: string;
    note: string; // "3 ahead" / "5 behind"
    count: number;
}

// Extends HistoryRow so a selected compare commit can be handed straight to the shipped CommitPane
// with no adapter — the divergence lists come from HistoryLog, so they carry everything a row needs.
export interface CompareCommitRow extends HistoryRow {
    kind: "commit";
    id: string; // the commit hash
    side: CompareSide;
}

export type CompareRow = CompareAggregateRow | CompareHeaderRow | CompareCommitRow;

// Positional lane hues from the shipped graph palette — head green, base blue, the mockup's own two
// colours. Positional, never identity: nothing is claimed by a colour.
export const SIDE_TEXT: Record<CompareSide, string> = {
    head: "text-graphlane-2",
    base: "text-graphlane-1",
};
export const SIDE_DOT: Record<CompareSide, string> = {
    head: "bg-graphlane-2",
    base: "bg-graphlane-1",
};

export interface BuildCompareRowsOpts {
    base: string;
    head: string;
    // commits on head but not base, newest first (Divergence.Ahead)
    ahead: HistoryCommit[];
    // commits on base but not head, newest first (Divergence.Behind)
    behind: HistoryCommit[];
    // null while the aggregate read is in flight
    aggregate: GitChanges | null;
    now: number;
}

function sideRows(commits: HistoryCommit[], side: CompareSide, ref: string, now: number): CompareRow[] {
    if (commits.length === 0) {
        return []; // no header for an empty side: an empty labelled group reads as a failed read
    }
    const header: CompareHeaderRow = {
        kind: "header",
        id: `header:${side}`,
        side,
        ref,
        note: `${commits.length} ${side === "head" ? "ahead" : "behind"}`,
        count: commits.length,
    };
    const rows: CompareRow[] = commits.map((c) => ({
        ...toRow(c, now),
        kind: "commit" as const,
        id: c.hash,
        side,
    }));
    return [header, ...rows];
}

export function buildCompareRows(opts: BuildCompareRowsOpts): CompareRow[] {
    const aggregate: CompareAggregateRow = {
        kind: "aggregate",
        id: AGGREGATE,
        files: opts.aggregate ? opts.aggregate.files.length : null,
        adds: opts.aggregate?.adds ?? 0,
        dels: opts.aggregate?.dels ?? 0,
    };
    return [
        aggregate,
        ...sideRows(opts.ahead, "head", opts.head, opts.now),
        ...sideRows(opts.behind, "base", opts.base, opts.now),
    ];
}

// What j/k walks: the aggregate and every commit, in column order. Headers are labels, not stops.
export function compareNavIds(rows: CompareRow[]): string[] {
    return rows.filter((r) => r.kind !== "header").map((r) => r.id);
}

// Tab: jump to the *first commit of the other side*, so it moves between groups rather than shifting
// focus. From the aggregate row, "the other side" is head — the side the aggregate describes.
export function sideJumpTarget(rows: CompareRow[], fromId: string | null): string | null {
    const first = (side: CompareSide): string | null =>
        (rows.find((r) => r.kind === "commit" && r.side === side) as CompareCommitRow | undefined)?.id ?? null;
    if (fromId === AGGREGATE) {
        return first("head");
    }
    const from = rows.find((r) => r.kind === "commit" && r.id === fromId) as CompareCommitRow | undefined;
    if (from == null) {
        return null;
    }
    return first(from.side === "head" ? "base" : "head");
}
