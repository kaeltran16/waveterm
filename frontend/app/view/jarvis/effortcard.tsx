// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The effort card. Collapsed: a single header line (tone square, title, meta, count, bar) over one to
// three status lines saying what is moving and what is stuck. Expanded: the inline chunk tracker with
// marks/trails, advance / + chunk / note actions, reopen on done rows, and the CLI handle.
//
// The toggle is a button INSIDE the card, not a button wrapping it: the expanded body has buttons of
// its own, and nesting those inside an outer button is invalid and cost a stopPropagation call on
// every one of them.

import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { useState } from "react";
import { CHUNK_CHIP_CLASSES, effortStatusLines, effortTone, type ChunkTone, type EffortCardModel } from "./effortmodel";
import {
    addChunkOp,
    advanceChunk,
    appendChunkNote,
    effortChunkRows,
    effortDetailAtom,
    effortDetailErrorAtom,
    loadEffortDetail,
    reopenChunk,
    setEffortStatus,
} from "./effortstore";
import { ProgressBar } from "./progressbar";

const MARKS: Record<ChunkTone, string | null> = {
    done: "✓",
    active: "▶",
    blocked: "!",
    deferred: "⏸",
    skipped: "–",
    pending: null,
};

// the per-tone square that leads a chunk row; the active/blocked glows mark the states that need eyes.
export function Mark({ tone }: { tone: ChunkTone }) {
    const cls =
        tone === "done"
            ? "border-success/40 bg-success/15 text-success"
            : tone === "active"
              ? "border-accent/60 text-accent-soft shadow-[0_0_0_3px_var(--color-accentbg)]"
              : tone === "blocked"
                ? "border-asking/60 text-asking shadow-[0_0_0_3px_var(--color-askingbg)]"
                : tone === "deferred"
                  ? "border-dashed border-edge-strong text-muted"
                  : tone === "skipped"
                    ? "border-transparent text-ink-faint"
                    : "border-edge-strong";
    return (
        <span
            className={cn(
                "flex h-[14px] w-[14px] flex-none items-center justify-center rounded-[4px] border text-xxxs leading-none",
                cls
            )}
        >
            {MARKS[tone]}
        </span>
    );
}

const TONE_FILL: Record<"blocked" | "done" | "active", string> = {
    blocked: "bg-asking",
    done: "bg-success",
    active: "bg-accent",
};

const LINE_FG: Record<ChunkTone, string> = {
    done: "text-success",
    active: "text-accent-soft",
    blocked: "text-asking",
    deferred: "text-muted",
    skipped: "text-ink-faint",
    pending: "text-muted",
};

const fmtDay = (ts: number): string => {
    const d = new Date(ts);
    return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

// a small bordered action, the shape every secondary control in the expanded footer takes.
function FooterButton({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
    return (
        <button
            type="button"
            onClick={onClick}
            className="cursor-pointer rounded-[6px] border border-border bg-surface-raised px-2.5 py-1 text-[11px] font-semibold text-secondary hover:border-edge-strong hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
            {children}
        </button>
    );
}

export function EffortCard({
    model,
    expanded,
    onToggle,
    onOpenDetail,
}: {
    model: EffortCardModel;
    expanded: boolean;
    onToggle: () => void;
    onOpenDetail?: () => void;
}) {
    const oid = model.oref.replace(/^effort:/, "");
    const effort = useAtomValue(effortDetailAtom).get(model.oref);
    const detailError = useAtomValue(effortDetailErrorAtom).get(model.oref);
    const [addingChunk, setAddingChunk] = useState(false);
    const [noting, setNoting] = useState(false);
    const [chunkDraft, setChunkDraft] = useState("");
    const [noteDraft, setNoteDraft] = useState("");
    const [mutateError, setMutateError] = useState<string | null>(null);

    const rows = effort != null ? effortChunkRows(effort) : [];
    const lines = effortStatusLines(model);
    const meta = [model.ticket, model.project, model.parentoid != null ? "parent" : null].filter(Boolean).join(" · ");
    const progress = `${model.done}/${model.done + model.remaining}`;

    // one error surface for every mutate path; never silently swallow.
    const runMutation = async (fn: () => Promise<void>): Promise<void> => {
        setMutateError(null);
        try {
            await fn();
        } catch (e) {
            setMutateError(e instanceof Error ? e.message : String(e));
        }
    };

    const submitChunk = (): void => {
        const label = chunkDraft.trim();
        if (label === "") {
            return;
        }
        setChunkDraft("");
        setAddingChunk(false);
        void runMutation(() => addChunkOp(model.oref, label));
    };
    const submitNote = (): void => {
        const text = noteDraft.trim();
        if (text === "") {
            return;
        }
        setNoteDraft("");
        setNoting(false);
        void runMutation(() => appendChunkNote(model.oref, model.activeChunk ?? null, text));
    };

    return (
        <div className="rounded-[10px] border border-border bg-surface px-[13px] py-[11px]">
            <button
                type="button"
                onClick={onToggle}
                aria-expanded={expanded}
                aria-label={(expanded ? "Collapse " : "Expand ") + model.title}
                className="-mx-1.5 flex w-[calc(100%+0.75rem)] cursor-pointer items-center gap-2.5 rounded-[8px] px-1.5 py-1 text-left transition-colors duration-[140ms] hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
                <span className="w-[11px] flex-none font-mono text-[9.5px] text-muted">{expanded ? "▾" : "▸"}</span>
                <span className={cn("h-[7px] w-[7px] flex-none rounded-[2px]", TONE_FILL[effortTone(model)])} />
                <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold text-primary">{model.title}</span>
                {meta !== "" ? <span className="flex-none font-mono text-[9.5px] text-muted">{meta}</span> : null}
                <span className="flex-none font-mono text-[9.5px] text-muted">{progress}</span>
                <ProgressBar pct={model.progressPct} className="w-[72px] flex-none" />
            </button>

            {expanded ? null : (
                <div className="mt-2 flex flex-col gap-0.5">
                    {lines.map((l) => (
                        <div key={l.mark + l.text} className="flex min-w-0 items-center gap-2.5 pl-[21px]">
                            <span
                                className={cn(
                                    "w-3 flex-none text-center font-mono text-[9.5px] font-bold",
                                    LINE_FG[l.tone]
                                )}
                            >
                                {l.mark}
                            </span>
                            <span className="min-w-0 flex-1 truncate text-[12.5px] text-secondary">{l.text}</span>
                            <span className="flex-none font-mono text-[9.5px] text-muted">{l.reading}</span>
                        </div>
                    ))}
                </div>
            )}

            {expanded ? (
                <div className="ml-4 mt-2 flex flex-col border-l border-border pl-3">
                    {effort == null ? (
                        detailError != null ? (
                            <span className="flex items-center gap-2 text-[11px] text-error">
                                {detailError}
                                <FooterButton onClick={() => void loadEffortDetail(model.oref)}>retry</FooterButton>
                            </span>
                        ) : (
                            <div className="h-10 animate-pulse motion-reduce:animate-none rounded-[8px] bg-surface-raised" />
                        )
                    ) : (
                        <>
                            {rows.map((r) => (
                                <div
                                    key={r.label}
                                    className="group flex min-h-[30px] items-center gap-2.5 rounded-[7px] px-1.5 py-[2px] transition-colors duration-[140ms] hover:bg-surface-hover"
                                    title={
                                        r.trail.length > 0
                                            ? r.trail.map((n) => `${fmtDay(n.ts)} ${n.text}`).join("\n")
                                            : undefined
                                    }
                                >
                                    <Mark tone={r.tone} />
                                    <span className="min-w-0 flex-1 truncate text-[12.5px] text-secondary">
                                        {r.label}
                                    </span>
                                    {r.latestNote != null && (
                                        <span className="max-w-[30%] truncate text-right font-mono text-[9.5px] text-muted">
                                            {r.latestNote}
                                        </span>
                                    )}
                                    <span
                                        className={cn(
                                            "flex-none rounded-[4px] px-1.5 py-[2px] font-mono text-[9.5px] font-semibold uppercase",
                                            CHUNK_CHIP_CLASSES[r.tone]
                                        )}
                                    >
                                        {r.status}
                                    </span>
                                    {r.status === "active" && (
                                        <button
                                            type="button"
                                            onClick={() => void runMutation(() => advanceChunk(model.oref))}
                                            className="flex-none cursor-pointer rounded-[6px] border border-accent/40 bg-surface-raised px-2.5 py-[3px] text-[11px] font-semibold text-accent-soft hover:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                                        >
                                            Mark done
                                        </button>
                                    )}
                                    {r.status === "done" && (
                                        <button
                                            type="button"
                                            onClick={() => void runMutation(() => reopenChunk(model.oref, r.label))}
                                            className="hidden flex-none cursor-pointer rounded-[6px] border border-border px-2 py-[3px] font-mono text-[9.5px] text-muted group-hover:block hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                                        >
                                            reopen
                                        </button>
                                    )}
                                </div>
                            ))}
                            <div className="flex flex-wrap items-center gap-2 px-1.5 pb-0.5 pt-[7px]">
                                <FooterButton
                                    onClick={() => {
                                        setAddingChunk(true);
                                        setNoting(false);
                                    }}
                                >
                                    + chunk
                                </FooterButton>
                                <FooterButton
                                    onClick={() => {
                                        setNoting(true);
                                        setAddingChunk(false);
                                    }}
                                >
                                    Note
                                </FooterButton>
                                {/* no confirm: the efforts list's "show archived" toggle is the way back */}
                                <FooterButton
                                    onClick={() => void runMutation(() => setEffortStatus(model.oref, "archived"))}
                                >
                                    Archive
                                </FooterButton>
                                {addingChunk ? (
                                    <input
                                        autoFocus
                                        value={chunkDraft}
                                        onChange={(e) => setChunkDraft(e.target.value)}
                                        onKeyDown={(e) => {
                                            e.stopPropagation();
                                            if (e.key === "Enter") {
                                                submitChunk();
                                            } else if (e.key === "Escape") {
                                                setAddingChunk(false);
                                                setChunkDraft("");
                                            }
                                        }}
                                        placeholder="chunk label"
                                        className="w-44 rounded-[7px] border border-edge-mid bg-background px-2 py-1 text-[12px] text-primary outline-none focus:border-accent/60"
                                    />
                                ) : null}
                                {noting ? (
                                    <input
                                        autoFocus
                                        value={noteDraft}
                                        onChange={(e) => setNoteDraft(e.target.value)}
                                        onKeyDown={(e) => {
                                            e.stopPropagation();
                                            if (e.key === "Enter") {
                                                submitNote();
                                            } else if (e.key === "Escape") {
                                                setNoting(false);
                                                setNoteDraft("");
                                            }
                                        }}
                                        placeholder={
                                            model.activeChunk != null
                                                ? `note on ${model.activeChunk}`
                                                : "initiative-level note"
                                        }
                                        className="w-64 rounded-[7px] border border-edge-mid bg-background px-2 py-1 text-[12px] text-primary outline-none focus:border-accent/60"
                                    />
                                ) : null}
                                <button
                                    type="button"
                                    title="copy the CLI handle"
                                    onClick={() => void navigator.clipboard.writeText("wsh effort show " + oid)}
                                    className="cursor-pointer font-mono text-[9.5px] text-muted hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                                >
                                    wsh effort show {oid}
                                </button>
                                <span className="flex-1" />
                                {onOpenDetail != null ? (
                                    <button
                                        type="button"
                                        onClick={onOpenDetail}
                                        className="cursor-pointer font-mono text-[9.5px] font-semibold text-accent-soft hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                                    >
                                        full record →
                                    </button>
                                ) : null}
                            </div>
                            <span className="px-1.5 font-mono text-[9.5px] text-ink-faint">
                                hover a row for its trail · reopen on done rows
                            </span>
                        </>
                    )}
                </div>
            ) : null}
            {mutateError != null ? <span className="mt-2 block text-[11px] text-error">{mutateError}</span> : null}
        </div>
    );
}
