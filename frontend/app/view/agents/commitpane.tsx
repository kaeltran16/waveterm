// frontend/app/view/agents/commitpane.tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pane 2 of the Diff surface (Wave-git-review.dc.html): who made the selected commit, when, and which
// files it touched. Read-only — no stage control, no message box, nothing that authors a commit.

import { REGION_LABEL } from "@/app/view/jarvis/briefstyle";
import { cn, fireAndForget } from "@/util/util";
import { Copy } from "lucide-react";
import { formatAgo } from "./agentsviewmodel";
import { ChangedFileList, ReviewProgress, TreeModeToggle } from "./changedfilelist";
import type { EditFlag } from "./filesstore";
import { type GitChanges } from "./gitstatus";
import { WORKING_TREE, refChipClass, type HistoryRow } from "./historyrows";
import type { ReviewSubject } from "./reviewmarks";
import { SubLabel } from "./sectionlabel";

function initials(name: string): string {
    return name.slice(0, 2).toUpperCase();
}

function WorkingTreeHeader({ row, caption, heading }: { row: HistoryRow; caption?: string; heading: string }) {
    return (
        <>
            <div className={cn(REGION_LABEL, "mb-[8px] flex items-center gap-[7px] text-warning")}>
                <span className="h-[9px] w-[9px] rounded-full border border-dashed border-warning" />
                {heading}
            </div>
            {row.subject !== heading ? (
                <div className="text-[14px] font-semibold leading-[1.4] text-ink-hi">{row.subject}</div>
            ) : null}
            {caption ? <div className="mt-[6px] text-[12px] text-ink-mid">{caption}</div> : null}
        </>
    );
}

function CopyHashButton({ hash }: { hash: string }) {
    return (
        <button
            onClick={() => fireAndForget(() => navigator.clipboard.writeText(hash))}
            title="Copy hash"
            aria-label="Copy hash"
            className="flex h-[22px] w-[22px] flex-none items-center justify-center rounded-[5px] text-muted hover:bg-surface hover:text-foreground"
        >
            <Copy size={13} />
        </button>
    );
}

// the column header: the history row right above already shows the author, refs and age, so only what
// names the commit stays, on one line
function LineHeader({ row, caption, heading }: { row: HistoryRow; caption?: string; heading: string }) {
    if (row.hash === WORKING_TREE) {
        return (
            <div className="flex min-w-0 items-center gap-[8px]">
                <span className="h-[9px] w-[9px] flex-none rounded-full border border-dashed border-warning" />
                <span className="flex-none text-[12.5px] font-semibold text-ink-hi">{heading}</span>
                {caption ? <span className="min-w-0 truncate text-[12px] text-ink-mid">{caption}</span> : null}
            </div>
        );
    }
    return (
        <div className="flex min-w-0 items-center gap-[8px]">
            <span className="flex-none rounded-[5px] border border-accent/30 bg-accentbg px-[6px] py-[1px] font-mono text-[11px] font-semibold text-accent-soft">
                {row.hash.slice(0, 7)}
            </span>
            <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold text-ink-hi" title={row.subject}>
                {row.subject}
            </span>
            <CopyHashButton hash={row.hash} />
        </div>
    );
}

function CommitHeader({ row }: { row: HistoryRow }) {
    return (
        <>
            <div className="mb-[9px] flex items-center gap-[8px]">
                <span className="rounded-[5px] border border-accent/30 bg-accentbg px-[7px] py-[2px] font-mono text-[12px] font-semibold text-accent-soft">
                    {row.hash.slice(0, 7)}
                </span>
                <CopyHashButton hash={row.hash} />
                <div className="flex-1" />
                <span className="font-mono text-[11px] text-muted">{formatAgo(Date.now() - row.ts)}</span>
            </div>
            <div className="mb-[8px] text-[14px] font-semibold leading-[1.4] text-ink-hi">{row.subject}</div>
            <div className="flex items-center gap-[8px]">
                <span className="flex h-[20px] w-[20px] items-center justify-center rounded-full bg-surface-raised font-mono text-[10.5px] font-bold text-ink-mid">
                    {initials(row.author)}
                </span>
                <span className="text-[12px] text-ink-mid">{row.author}</span>
            </div>
            {row.refs.length > 0 ? (
                <div className="mt-[9px] flex flex-wrap gap-[6px]">
                    {row.refs.map((r) => (
                        <span
                            key={r.label}
                            className={cn(
                                "rounded-[4px] border px-[6px] py-[2px] font-mono text-[10.5px] font-semibold",
                                refChipClass(r.kind)
                            )}
                        >
                            {r.label}
                        </span>
                    ))}
                </div>
            ) : null}
        </>
    );
}

export function CommitPane({
    row,
    changes,
    selectedFile,
    onSelectFile,
    caption,
    heading = "Working tree",
    review,
    failure = null,
    onRetry,
    lineCounts = true,
    header = "full",
    flags,
}: {
    row: HistoryRow;
    changes: GitChanges | null;
    selectedFile: string | null;
    onSelectFile: (path: string) => void;
    review: ReviewSubject | null;
    // the working-tree row's "measured from what" line; worktreeCaption builds it
    caption?: string;
    // the working-tree row's name; worktreeHeading builds it
    heading?: string;
    // the file list's read failed
    failure?: string | null;
    onRetry?: () => void;
    // false when git listed the files but could not count their lines
    lineCounts?: boolean;
    // "line" under the history column, whose selected row already says the rest
    header?: "full" | "line";
    // the edits range's per-file caveats, by path
    flags?: Record<string, EditFlag>;
}) {
    const isWorkingTree = row.hash === WORKING_TREE;
    const count = changes?.files.length ?? 0;
    return (
        <div data-commit-pane className="flex min-h-0 flex-1 flex-col">
            {header === "line" ? (
                <div className="flex-none px-[15px] pb-[2px] pt-[10px]">
                    <LineHeader row={row} caption={caption} heading={heading} />
                </div>
            ) : (
                <div className="flex-none border-b border-edge-faint px-[15px] pb-[12px] pt-[14px]">
                    {isWorkingTree ? (
                        <WorkingTreeHeader row={row} caption={caption} heading={heading} />
                    ) : (
                        <CommitHeader row={row} />
                    )}
                </div>
            )}
            <div className="flex-none px-[15px] pb-[8px] pt-[10px]">
                <div className="flex items-center gap-[9px]">
                    <SubLabel>
                        {count} {count === 1 ? "file" : "files"}
                    </SubLabel>
                    <div className="flex-1" />
                    {lineCounts ? (
                        <>
                            <span className="font-mono text-[11px] font-semibold text-diff-added">
                                +{changes?.adds ?? 0}
                            </span>
                            <span className="font-mono text-[11px] font-semibold text-diff-removed">
                                −{changes?.dels ?? 0}
                            </span>
                        </>
                    ) : null}
                    <TreeModeToggle />
                </div>
                <ReviewProgress review={review} changes={changes} />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-[8px] pb-[20px]">
                <ChangedFileList
                    changes={changes}
                    selectedFile={selectedFile}
                    onSelectFile={onSelectFile}
                    review={review}
                    failure={failure}
                    onRetry={onRetry}
                    lineCounts={lineCounts}
                    flags={flags}
                />
            </div>
        </div>
    );
}
