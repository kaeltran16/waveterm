// frontend/app/view/agents/aggregatepane.tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pane 2 of the Diff surface while the aggregate row is selected (Wave-git-review.dc.html, lines
// 401-425): what head introduces relative to base, anchored at their merge base. When a *commit* row
// is selected instead, the surface renders the shipped CommitPane — a compare commit row is a
// HistoryRow, so no adapter is needed.

import { cn } from "@/util/util";
import { ChangedFileList, TreeModeToggle } from "./changedfilelist";
import { SIDE_TEXT } from "./comparerows";
import type { CompareForm } from "./diffcontent";
import type { GitChanges } from "./gitstatus";

export function AggregatePane({
    base,
    head,
    form,
    changes,
    selectedFile,
    onSelectFile,
    onSetForm,
}: {
    base: string;
    head: string;
    form: CompareForm;
    changes: GitChanges | null;
    selectedFile: string | null;
    onSelectFile: (path: string) => void;
    onSetForm: (form: CompareForm) => void;
}) {
    const count = changes?.files.length ?? 0;
    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex-none border-b border-edge-faint px-[15px] pb-[11px] pt-[13px]">
                <div className="mb-[8px] font-mono text-[9px] font-bold uppercase tracking-[0.14em] text-muted">
                    Aggregate diff
                </div>
                <div className="flex flex-wrap items-center gap-[8px] font-mono text-[12px] text-ink-mid">
                    <span className={SIDE_TEXT.head}>{head}</span>
                    <span className="text-ink-faint">→</span>
                    <span className={SIDE_TEXT.base}>{base}</span>
                </div>
                {/* The chips name the range separator: three dots is what head introduced since the
                    merge base, two is the full difference between the tips. The file list and the
                    diff pane both read this, so they cannot disagree about which question is asked. */}
                <div className="mt-[9px] flex items-center gap-[6px] font-mono text-[10px]">
                    {(["mergebase", "tips"] as const).map((f) => (
                        <button
                            key={f}
                            onClick={() => onSetForm(f)}
                            className={cn(
                                "rounded-[6px] border px-[7px] py-[2px]",
                                form === f
                                    ? "border-accent/40 bg-accentbg text-ink-hi"
                                    : "border-edge-mid text-ink-faint hover:text-foreground"
                            )}
                        >
                            {f === "mergebase" ? "••• merge base" : "•• tip to tip"}
                        </button>
                    ))}
                </div>
                <div className="mt-[9px] flex items-center gap-[10px]">
                    <span className="font-mono text-[11px] font-semibold text-muted">
                        {count} {count === 1 ? "file" : "files"}
                    </span>
                    <span className="font-mono text-[11px] font-semibold text-success">+{changes?.adds ?? 0}</span>
                    <span className="font-mono text-[11px] font-semibold text-error">−{changes?.dels ?? 0}</span>
                    <div className="flex-1" />
                    <TreeModeToggle />
                </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-[8px] pb-[20px] pt-[8px]">
                <ChangedFileList changes={changes} selectedFile={selectedFile} onSelectFile={onSelectFile} />
            </div>
        </div>
    );
}
