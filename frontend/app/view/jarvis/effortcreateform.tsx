// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Paste-and-tick effort creation: one line per chunk in the textarea, live checkbox rows below,
// ticked lines become status=done at save (two RPCs — the chunk seed carries no status field).

import { ModalShell } from "@/app/modals/modalshell";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { useEffect, useState } from "react";
import { loadBriefingAsync, stateRpcTimeoutMs } from "./briefingstore";

export interface ParsedChunkLine {
    label: string;
    checked: boolean;
}

// pure parse: split lines, trim, drop blanks, nothing ticked by default — ticks live in the form's
// state and survive re-parses by label.
export function parseChunkLines(text: string): ParsedChunkLine[] {
    const lines: ParsedChunkLine[] = [];
    for (const raw of text.split("\n")) {
        const label = raw.trim();
        if (label === "") {
            continue;
        }
        lines.push({ label, checked: false });
    }
    return lines;
}

const inputCls =
    "w-full rounded-[7px] border border-edge-mid bg-background px-2.5 py-1.5 text-[12px] text-primary placeholder:text-muted outline-none focus:border-accent/60";
const fieldLabel = "font-mono text-[9.5px] font-bold uppercase tracking-[.12em] text-muted";

export function EffortCreateForm({ onClose }: { onClose: () => void }) {
    const [title, setTitle] = useState("");
    const [project, setProject] = useState("");
    const [ticket, setTicket] = useState("");
    const [parent, setParent] = useState("");
    const [text, setText] = useState("");
    const [lines, setLines] = useState<ParsedChunkLine[]>([]);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [titleError, setTitleError] = useState<string | null>(null);

    // re-parse on text change, keeping ticks by label so a tick survives edits elsewhere in the list
    useEffect(() => {
        setLines((prev) => {
            const ticks = new Map(prev.map((l) => [l.label, l.checked]));
            return parseChunkLines(text).map((l) => ({ ...l, checked: ticks.get(l.label) ?? false }));
        });
    }, [text]);

    const ticked = lines.filter((l) => l.checked).length;
    const dupes = lines.some((l, i) => lines.findIndex((x) => x.label === l.label) !== i);
    const canSubmit = !submitting && !dupes && title.trim() !== "";

    const submit = async (): Promise<void> => {
        setTitleError(title.trim() === "" ? "title is required" : null);
        if (title.trim() === "") {
            return;
        }
        setError(null);
        setSubmitting(true);
        try {
            const parentOid = parent.trim().replace(/^effort:/, "");
            const rtn = await RpcApi.EffortCreateCommand(
                TabRpcClient,
                {
                    title: title.trim(),
                    project: project.trim() || undefined,
                    ticket: ticket.trim() || undefined,
                    parentoid: parentOid || undefined,
                    chunks: lines.map((l) => ({ label: l.label })),
                },
                { timeout: stateRpcTimeoutMs }
            );
            // the chunk seed carries no status, so ticked lines become done in one atomic batch.
            const doneOps = lines
                .filter((l) => l.checked)
                .map((l) => ({ op: "setChunkStatus", chunk: l.label, status: "done" }));
            if (doneOps.length > 0) {
                await RpcApi.EffortMutateCommand(
                    TabRpcClient,
                    { effortoid: rtn.effortoid, ops: doneOps },
                    { timeout: stateRpcTimeoutMs }
                );
            }
            void loadBriefingAsync();
            onClose();
        } catch (e) {
            // the effort may exist with all-pending chunks if the mutate failed — the documented fallback.
            setError(e instanceof Error ? e.message : String(e));
            setSubmitting(false);
        }
    };

    return (
        <ModalShell
            open
            onClose={onClose}
            onSubmit={() => void submit()}
            className="flex w-[min(560px,93vw)] flex-col"
        >
            <div className="flex shrink-0 items-center gap-[11px] border-b border-border px-[18px] py-[15px]">
                <div className="flex h-[18px] w-[18px] items-center justify-center rounded-full bg-accentbg font-mono text-[10px] font-bold text-accent-soft">
                    ✦
                </div>
                <span className="flex-1 text-[15px] font-semibold text-primary">New initiative</span>
                <span className="rounded-[5px] border border-edge-mid px-[7px] py-0.5 font-mono text-[10.5px] text-muted">
                    ⌘⏎ to save
                </span>
            </div>
            <div className="flex min-h-0 flex-1 flex-col gap-[13px] overflow-y-auto px-[18px] py-4">
                <div className="flex flex-col gap-1">
                    <span className={fieldLabel}>Title</span>
                    <input
                        autoFocus
                        value={title}
                        onChange={(e) => setTitle(e.target.value)}
                        placeholder="e.g. Scenario gate clearance"
                        className={inputCls}
                    />
                    {titleError != null ? <span className="text-[11px] text-error">{titleError}</span> : null}
                </div>
                <div className="grid grid-cols-2 gap-[13px]">
                    <div className="flex flex-col gap-1">
                        <span className={fieldLabel}>Project</span>
                        <input value={project} onChange={(e) => setProject(e.target.value)} className={inputCls} />
                    </div>
                    <div className="flex flex-col gap-1">
                        <span className={fieldLabel}>Ticket</span>
                        <input value={ticket} onChange={(e) => setTicket(e.target.value)} className={inputCls} />
                    </div>
                </div>
                <div className="flex flex-col gap-1">
                    <span className={fieldLabel}>Parent initiative (optional)</span>
                    <input
                        value={parent}
                        onChange={(e) => setParent(e.target.value)}
                        placeholder="effort:&lt;oid&gt; or just the oid"
                        className={inputCls}
                    />
                </div>
                <div className="flex flex-col gap-1.5">
                    <span className={fieldLabel}>Chunks · one per line</span>
                    <textarea
                        value={text}
                        onChange={(e) => setText(e.target.value)}
                        placeholder={"Phase 1 — WAF posture scan\nPhase 2 — N1 box upgrade\nPhase 3 — gate review"}
                        spellCheck={false}
                        className="min-h-[130px] w-full resize-y rounded-[7px] border border-edge-mid bg-background px-2.5 py-2 font-mono text-[11px] leading-[1.7] text-primary placeholder:text-muted outline-none focus:border-accent/60"
                    />
                    {lines.length > 0 ? (
                        <>
                            <div className="flex items-center gap-2">
                                <span className="font-mono text-[10px] text-muted">
                                    {lines.length} chunks · {ticked} already done
                                </span>
                                {dupes ? (
                                    <span className="font-mono text-[10px] text-error">duplicate chunk labels</span>
                                ) : null}
                            </div>
                            <div className="flex max-h-[140px] flex-col gap-px overflow-y-auto rounded-[7px] border border-edge-faint bg-surface px-2 py-1.5">
                                {lines.map((l, i) => (
                                    <label
                                        key={l.label + ":" + i}
                                        className="flex cursor-pointer items-center gap-2 rounded-[4px] px-1 py-[2px] hover:bg-surface-hover"
                                    >
                                        <input
                                            type="checkbox"
                                            checked={l.checked}
                                            onChange={() =>
                                                setLines((prev) =>
                                                    prev.map((x, j) =>
                                                        j === i ? { ...x, checked: !x.checked } : x
                                                    )
                                                )
                                            }
                                            className="h-[12px] w-[12px] accent-success"
                                        />
                                        <span className="truncate font-mono text-[11.5px] text-primary">
                                            {l.label}
                                        </span>
                                    </label>
                                ))}
                            </div>
                        </>
                    ) : null}
                </div>
            </div>
            <div className="flex shrink-0 items-center gap-2 border-t border-border px-[18px] py-3">
                {error != null ? (
                    <span className="min-w-0 flex-1 truncate text-[11px] text-error">{error}</span>
                ) : (
                    <span className="flex-1 font-mono text-[10px] text-muted">
                        ticked lines save as already done
                    </span>
                )}
                <button
                    type="button"
                    onClick={onClose}
                    className="cursor-pointer rounded-[7px] border border-border bg-surface-raised px-3.5 py-1.5 text-[11.5px] font-semibold text-secondary hover:text-primary"
                >
                    Cancel
                </button>
                <button
                    type="button"
                    disabled={!canSubmit}
                    onClick={() => void submit()}
                    className="cursor-pointer rounded-[7px] bg-accent px-3.5 py-1.5 text-[11.5px] font-semibold text-background hover:bg-accenthover disabled:cursor-default disabled:opacity-40"
                >
                    {submitting ? "Creating…" : "Create initiative"}
                </button>
            </div>
        </ModalShell>
    );
}
