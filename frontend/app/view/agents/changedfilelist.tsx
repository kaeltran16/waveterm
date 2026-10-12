// frontend/app/view/agents/changedfilelist.tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The changed-file list shared by the Diff surface's middle pane in both of its states: one commit's
// files (commitpane) and the aggregate between two refs (aggregatepane). Extracted rather than
// duplicated — the row is identical in the mockup for both, so one renderer is one source of truth
// for status colour, path truncation and the selected tint.

import { SkeletonLine, SkeletonRows } from "@/app/element/skeleton";
import { globalStore } from "@/app/store/jotaiStore";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { Check, ChevronDown, ChevronRight } from "lucide-react";
import { useMemo } from "react";
import { buildFileTree, collapsedDirsAtom, treeModeAtom, type FileTreeRow } from "./filetree";
import { statusColor, type GitChange, type GitChanges } from "./gitstatus";
import {
    clearReviewed,
    markState,
    reviewMarksAtom,
    reviewProgress,
    setReviewed,
    toggleReviewed,
    type ReviewState,
    type ReviewSubject,
} from "./reviewmarks";

const INDENT_PX = 14;
const ROW_PAD_PX = 8;

function FileListSkeleton() {
    return (
        <SkeletonRows className="h-full space-y-[7px] px-[8px] py-[6px]">
            {(i) => (
                <div key={i} className="flex items-center gap-[8px] px-[8px] py-[5px]">
                    <SkeletonLine className="h-[12px] flex-1" />
                    <SkeletonLine className="h-[10px] w-[22px]" />
                </div>
            )}
        </SkeletonRows>
    );
}

// The tree/flat switch, in the header of whichever pane is hosting the list. Here rather than in the
// two panes so the atom has one reader and the two headers cannot drift apart.
export function TreeModeToggle() {
    const tree = useAtomValue(treeModeAtom);
    return (
        <button
            onClick={() => globalStore.set(treeModeAtom, !tree)}
            title={tree ? "Show a flat path list" : "Group files by directory"}
            className="flex-none rounded border border-edge-mid px-[6px] py-[1px] font-mono text-[10.5px] text-muted hover:text-foreground"
        >
            {tree ? "tree" : "flat"}
        </button>
    );
}

// The check at a row's right end: a sibling of the row's own button, because a button cannot nest
// inside one. Drawn empty from the start so the column reads as a checklist.
function ReviewBox({
    state,
    title,
    onToggle,
    attrs,
}: {
    state: ReviewState;
    title: string;
    onToggle: () => void;
    attrs: Record<string, string>;
}) {
    return (
        <button
            {...attrs}
            onClick={onToggle}
            aria-pressed={state === "ok"}
            aria-label={title}
            title={title}
            className={cn(
                "mr-[6px] flex h-[16px] w-[16px] flex-none items-center justify-center rounded-[4px] border",
                state === "ok"
                    ? "border-accent/30 bg-accentbg"
                    : state === "stale"
                      ? "border-dashed border-warning"
                      : "border-edge-strong group-hover:border-muted"
            )}
        >
            {state === "ok" ? <Check size={11} strokeWidth={3} className="text-accent" /> : null}
        </button>
    );
}

function reviewTitle(state: ReviewState, name: string): string {
    if (state === "ok") {
        return `Unmark ${name}`;
    }
    return state === "stale" ? `Changed since you reviewed it. Mark ${name} reviewed` : `Mark ${name} reviewed`;
}

function FileRow({
    change,
    label,
    depth,
    selected,
    review,
    onSelect,
    onToggle,
}: {
    change: GitChange;
    label: string;
    depth: number;
    selected: boolean;
    // null when the list has no review subject, which draws no check
    review: ReviewState | null;
    onSelect: () => void;
    onToggle: () => void;
}) {
    const ok = review === "ok";
    return (
        <div
            className={cn(
                "group flex items-center rounded-[7px] transition-colors duration-[140ms] hover:bg-surface-raised",
                selected && "bg-surface-selected"
            )}
        >
            <button
                data-changed-file-row={change.path}
                data-review-state={review ?? "none"}
                aria-current={selected ? "true" : undefined}
                onClick={onSelect}
                style={{ paddingLeft: ROW_PAD_PX + depth * INDENT_PX }}
                title={change.path}
                className="flex min-w-0 flex-1 items-center gap-[8px] py-[7px] pr-[8px] text-left"
            >
                <span
                    className={cn(
                        "w-[13px] flex-none text-center font-mono text-[10.5px] font-bold",
                        ok ? "text-muted" : statusColor(change.status)
                    )}
                >
                    {change.status}
                </span>
                <span
                    className={cn(
                        "min-w-0 flex-1 truncate font-mono text-[11.5px]",
                        ok ? (selected ? "text-ink-mid" : "text-muted") : selected ? "text-ink-hi" : "text-ink-mid"
                    )}
                >
                    {label}
                </span>
                <span
                    className={cn(
                        "flex-none font-mono text-[10.5px] font-semibold",
                        ok ? "text-ink-faint" : "text-diff-added"
                    )}
                >
                    +{change.adds}
                </span>
                <span
                    className={cn(
                        "flex-none font-mono text-[10.5px] font-semibold",
                        ok ? "text-ink-faint" : "text-diff-removed"
                    )}
                >
                    −{change.dels}
                </span>
            </button>
            {review != null ? (
                <ReviewBox
                    state={review}
                    title={reviewTitle(review, label)}
                    onToggle={onToggle}
                    attrs={{ "data-review-toggle": change.path }}
                />
            ) : null}
        </div>
    );
}

function DirRow({
    row,
    collapsed,
    done,
    onToggle,
    onReview,
}: {
    row: FileTreeRow;
    collapsed: boolean;
    // reviewed files under this directory; null when the list has no review subject
    done: number | null;
    onToggle: () => void;
    onReview: () => void;
}) {
    const all = done != null && done === row.files;
    const partial = done != null && done > 0 && !all;
    return (
        <div className="group flex items-center rounded-[7px] hover:bg-surface-raised">
            <button
                data-changed-dir-row={row.id}
                onClick={onToggle}
                style={{ paddingLeft: ROW_PAD_PX + row.depth * INDENT_PX }}
                title={row.id}
                className="flex min-w-0 flex-1 items-center gap-[6px] py-[5px] pr-[8px] text-left"
            >
                {collapsed ? (
                    <ChevronRight size={12} className="flex-none text-muted" />
                ) : (
                    <ChevronDown size={12} className="flex-none text-muted" />
                )}
                <span
                    className={cn(
                        "min-w-0 flex-1 truncate font-mono text-[11px] font-semibold",
                        all ? "text-muted" : "text-ink-mid"
                    )}
                >
                    {row.label}
                </span>
                <span className={cn("flex-none font-mono text-[10.5px]", partial ? "text-ink-mid" : "text-muted")}>
                    {partial ? `${done}/${row.files}` : row.files}
                </span>
                <span className={cn("flex-none font-mono text-[10.5px]", all ? "text-ink-faint" : "text-diff-added")}>
                    +{row.adds}
                </span>
                <span className={cn("flex-none font-mono text-[10.5px]", all ? "text-ink-faint" : "text-diff-removed")}>
                    −{row.dels}
                </span>
            </button>
            {done != null ? (
                <ReviewBox
                    state={all ? "ok" : "none"}
                    title={all ? `Unmark every file in ${row.label}` : `Mark every file in ${row.label} reviewed`}
                    onToggle={onReview}
                    attrs={{ "data-review-toggle-dir": row.id }}
                />
            ) : null}
        </div>
    );
}

// The pane's reviewed count, under its file-count row; here rather than in the two panes for the same
// reason as the toggle above. The track is drawn at 0 too, so the first mark does not shift the list.
export function ReviewProgress({ review, changes }: { review: ReviewSubject | null; changes: GitChanges | null }) {
    const marks = useAtomValue(reviewMarksAtom);
    if (review == null || changes == null || changes.files.length === 0) {
        return null;
    }
    const { done, total } = reviewProgress(marks[review], changes.files);
    return (
        <div
            data-files-reviewed
            data-done={done}
            data-total={total}
            className="mt-[8px] flex h-[18px] items-center gap-[9px]"
        >
            <div className="h-[4px] flex-1 overflow-hidden rounded-full bg-edge-faint">
                <div className="h-full rounded-full bg-accent" style={{ width: `${(done / total) * 100}%` }} />
            </div>
            {done === total ? (
                <span className="flex items-center gap-[5px] font-mono text-[10.5px] font-semibold text-accent-soft">
                    <Check size={11} strokeWidth={3} className="text-accent" />
                    all {total} reviewed
                </span>
            ) : (
                <span className="font-mono text-[10.5px] font-semibold text-ink-mid">
                    {done}/{total} reviewed
                </span>
            )}
            {done > 0 ? (
                <button
                    data-review-clear
                    onClick={() => clearReviewed(review)}
                    title="Clear every review mark on this list"
                    className="flex-none text-[11px] font-semibold text-muted underline decoration-edge-strong underline-offset-2 hover:text-foreground"
                >
                    Clear
                </button>
            ) : null}
        </div>
    );
}

export function ChangedFileList({
    changes,
    selectedFile,
    onSelectFile,
    review,
}: {
    changes: GitChanges | null;
    selectedFile: string | null;
    onSelectFile: (path: string) => void;
    // the list's review subject; null draws no checks
    review: ReviewSubject | null;
}) {
    const tree = useAtomValue(treeModeAtom);
    const collapsed = useAtomValue(collapsedDirsAtom);
    const marks = useAtomValue(reviewMarksAtom);
    const rows = useMemo(
        () => (changes != null && tree ? buildFileTree(changes.files, collapsed) : []),
        [changes, tree, collapsed]
    );
    if (changes == null) {
        return <FileListSkeleton />;
    }
    if (changes.files.length === 0) {
        return <div className="px-[8px] py-[6px] text-[12px] text-ink-mid">No files changed</div>;
    }
    const subjectMarks = review != null ? marks[review] : undefined;
    const fileRow = (change: GitChange, label: string, depth: number) => (
        <FileRow
            key={change.path}
            change={change}
            label={label}
            depth={depth}
            selected={change.path === selectedFile}
            review={review != null ? markState(subjectMarks, change) : null}
            onSelect={() => onSelectFile(change.path)}
            onToggle={() => review != null && toggleReviewed(review, change)}
        />
    );
    if (!tree) {
        return <>{changes.files.map((f) => fileRow(f, f.path, 0))}</>;
    }
    const dirMembers = (id: string) => changes.files.filter((c) => c.path.startsWith(id + "/"));
    return (
        <>
            {rows.map((r) => {
                if (r.kind === "file") {
                    return fileRow(r.change!, r.label, r.depth);
                }
                const members = dirMembers(r.id);
                const done = review != null ? members.filter((c) => markState(subjectMarks, c) === "ok").length : null;
                return (
                    <DirRow
                        key={`dir:${r.id}`}
                        row={r}
                        collapsed={collapsed.has(r.id)}
                        done={done}
                        // a new Set every time: jotai compares by reference, so mutating one would
                        // change the value without telling anybody
                        onToggle={() => {
                            const next = new Set(collapsed);
                            if (!next.delete(r.id)) {
                                next.add(r.id);
                            }
                            globalStore.set(collapsedDirsAtom, next);
                        }}
                        // all reviewed unmarks all; anything less marks the rest
                        onReview={() => review != null && setReviewed(review, members, done !== members.length)}
                    />
                );
            })}
        </>
    );
}
