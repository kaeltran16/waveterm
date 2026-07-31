// frontend/app/view/agents/changedfilelist.tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The changed-file list shared by the Diff surface's middle pane in both of its states: one commit's
// files (commitpane) and the aggregate between two refs (aggregatepane). Extracted rather than
// duplicated — the row is identical in the mockup for both, so one renderer is one source of truth
// for status colour, path truncation and the selected tint.

import { SkeletonLine } from "@/app/element/skeleton";
import { cn } from "@/util/util";
import { statusColor, type GitChanges } from "./gitstatus";

function FileListSkeleton() {
    return (
        <div className="space-y-[7px] px-[8px] py-[6px]">
            {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="flex items-center gap-[8px] px-[8px] py-[5px]">
                    <SkeletonLine className="h-[12px] flex-1" />
                    <SkeletonLine className="h-[10px] w-[22px]" />
                </div>
            ))}
        </div>
    );
}

export function ChangedFileList({
    changes,
    selectedFile,
    onSelectFile,
}: {
    changes: GitChanges | null;
    selectedFile: string | null;
    onSelectFile: (path: string) => void;
}) {
    if (changes == null) {
        return <FileListSkeleton />;
    }
    if (changes.files.length === 0) {
        return <div className="px-[8px] py-[6px] text-[12px] text-ink-mid">No files changed</div>;
    }
    return (
        <>
            {changes.files.map((f) => (
                <button
                    key={f.path}
                    onClick={() => onSelectFile(f.path)}
                    className={cn(
                        "flex w-full items-center gap-[8px] rounded-[7px] px-[8px] py-[7px] text-left transition-colors duration-[140ms] hover:bg-surface-raised",
                        f.path === selectedFile && "bg-surface-selected"
                    )}
                >
                    <span
                        className={cn(
                            "w-[13px] flex-none text-center font-mono text-[10px] font-bold",
                            statusColor(f.status)
                        )}
                    >
                        {f.status}
                    </span>
                    <span
                        className={cn(
                            "min-w-0 flex-1 truncate font-mono text-[11.5px]",
                            f.path === selectedFile ? "text-ink-hi" : "text-ink-mid"
                        )}
                    >
                        {f.path}
                    </span>
                    <span className="flex-none font-mono text-[10px] font-semibold text-success">+{f.adds}</span>
                    <span className="flex-none font-mono text-[10px] font-semibold text-error">−{f.dels}</span>
                </button>
            ))}
        </>
    );
}
