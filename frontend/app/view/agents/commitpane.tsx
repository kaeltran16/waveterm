// frontend/app/view/agents/commitpane.tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pane 2 of the Diff surface (Wave-git-review.dc.html): who made the selected commit, when, and which
// files it touched. Read-only — no stage control, no message box, nothing that authors a commit.

import { cn } from "@/util/util";
import { ChangedFileList, TreeModeToggle } from "./changedfilelist";
import { type GitChanges } from "./gitstatus";
import { WORKING_TREE, refChipClass, type HistoryRow } from "./historyrows";

function initials(name: string): string {
    return name.slice(0, 2).toUpperCase();
}

export function CommitPane({
    row,
    changes,
    selectedFile,
    onSelectFile,
}: {
    row: HistoryRow | null;
    changes: GitChanges | null;
    selectedFile: string | null;
    onSelectFile: (path: string) => void;
}) {
    if (row == null) {
        return (
            <div className="flex h-full items-center justify-center px-[20px] text-center text-[12.5px] text-muted">
                Select a commit
            </div>
        );
    }
    const isWorkingTree = row.hash === WORKING_TREE;
    const count = changes?.files.length ?? 0;
    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex-none border-b border-edge-faint px-[15px] pb-[12px] pt-[14px]">
                <div className="mb-[9px] flex flex-wrap items-center gap-[8px]">
                    <span className="rounded-[5px] border border-accent/30 bg-accentbg px-[7px] py-[2px] font-mono text-[12px] font-semibold text-accent-soft">
                        {isWorkingTree ? "working tree" : row.hash.slice(0, 7)}
                    </span>
                    {row.refs.map((r) => (
                        <span
                            key={r.label}
                            className={cn(
                                "rounded-[4px] border px-[6px] py-[2px] font-mono text-[9.5px] font-semibold",
                                refChipClass(r.kind)
                            )}
                        >
                            {r.label}
                        </span>
                    ))}
                </div>
                <div className="mb-[8px] text-[14px] font-semibold leading-[1.4] text-ink-hi">{row.subject}</div>
                <div className="flex items-center gap-[8px]">
                    <span className="flex h-[20px] w-[20px] items-center justify-center rounded-full bg-surface-raised font-mono text-[9px] font-bold text-ink-mid">
                        {initials(row.author)}
                    </span>
                    <span className="text-[12px] text-ink-mid">{row.author}</span>
                    <span className="font-mono text-[11px] text-ink-faint">
                        {isWorkingTree ? "not committed" : row.when}
                    </span>
                </div>
            </div>
            <div className="flex flex-none items-center gap-[9px] px-[15px] pb-[8px] pt-[10px]">
                <span className="font-mono text-[9px] font-bold uppercase tracking-[0.14em] text-muted">
                    {count} {count === 1 ? "file" : "files"}
                </span>
                <div className="flex-1" />
                <span className="font-mono text-[11px] font-semibold text-success">+{changes?.adds ?? 0}</span>
                <span className="font-mono text-[11px] font-semibold text-error">−{changes?.dels ?? 0}</span>
                <TreeModeToggle />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-[8px] pb-[20px]">
                <ChangedFileList changes={changes} selectedFile={selectedFile} onSelectFile={onSelectFile} />
            </div>
        </div>
    );
}
