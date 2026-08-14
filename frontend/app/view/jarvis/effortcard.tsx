// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The effort card: a whole-card button that expands in place into the inline chunk tracker.
// Resting state: title, tags, progress, tone chips, copy handle. Expanded: chunk rows with
// marks/trails, advance / + chunk / note actions, reopen on done rows, chip-click scroll+highlight.

import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect, useRef, useState } from "react";
import { CHUNK_CHIP_CLASSES, type ChunkChip, type ChunkTone, type EffortCardModel } from "./effortmodel";
import { addChunkOp, advanceChunk, appendChunkNote, effortChunkRows, effortDetailAtom, effortDetailErrorAtom, loadEffortDetail, reopenChunk } from "./effortstore";
import { ProgressBar } from "./progressbar";

const MARKS: Record<ChunkTone, string | null> = {
    done: "✓",
    active: "▶",
    blocked: "!",
    deferred: "⏸",
    skipped: "–",
    pending: null,
};

function Tag({ children }: { children: React.ReactNode }) {
    return (
        <span className="flex-none rounded-full bg-surface-raised px-[6px] py-[1px] font-mono text-[9.5px] text-muted">
            {children}
        </span>
    );
}

function Chip({ chip, onClick }: { chip: ChunkChip; onClick: () => void }) {
    const mark = MARKS[chip.tone];
    return (
        <span
            role="button"
            tabIndex={0}
            title={chip.label}
            onClick={(e) => {
                e.stopPropagation();
                onClick();
            }}
            onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                    e.stopPropagation();
                    onClick();
                }
            }}
            className={cn(
                "inline-flex cursor-pointer items-center gap-[3px] rounded-full border border-border px-[7px] py-[1px] font-mono text-[9.5px]",
                CHUNK_CHIP_CLASSES[chip.tone]
            )}
        >
            {mark != null ? <span className="text-[8.5px] leading-none">{mark}</span> : null}
            {chip.label}
        </span>
    );
}

// the per-tone square that leads a chunk row; the active/blocked glows mark the states that need eyes.
export function Mark({ tone }: { tone: ChunkTone }) {
    const cls =
        tone === "done"
            ? "border-success/40 bg-success/15 text-success"
            : tone === "active"
              ? "border-accent/60 text-accent-soft shadow-[0_0_0_3px_rgba(94,156,255,0.12)]"
              : tone === "blocked"
                ? "border-asking/60 text-asking shadow-[0_0_0_3px_rgba(230,180,80,0.12)]"
                : tone === "deferred"
                  ? "border-dashed border-edge-strong text-muted"
                  : tone === "skipped"
                    ? "border-transparent text-ink-faint"
                    : "border-edge-strong";
    return (
        <span
            className={cn(
                "flex h-[14px] w-[14px] flex-none items-center justify-center rounded-[4px] border text-[8.5px] leading-none",
                cls
            )}
        >
            {MARKS[tone]}
        </span>
    );
}

const fmtDay = (ts: number): string => {
    const d = new Date(ts);
    return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

export function EffortCard({
    model,
    expanded,
    onToggle,
    onChipClick,
    onOpenDetail,
}: {
    model: EffortCardModel;
    expanded: boolean;
    onToggle: () => void;
    onChipClick?: (label: string) => void;
    onOpenDetail?: () => void;
}) {
    const oid = model.oref.replace(/^effort:/, "");
    const effort = useAtomValue(effortDetailAtom).get(model.oref);
    const detailError = useAtomValue(effortDetailErrorAtom).get(model.oref);
    const [highlighted, setHighlighted] = useState<string | null>(null);
    const [addingChunk, setAddingChunk] = useState(false);
    const [noting, setNoting] = useState(false);
    const [chunkDraft, setChunkDraft] = useState("");
    const [noteDraft, setNoteDraft] = useState("");
    const [mutateError, setMutateError] = useState<string | null>(null);
    const clearTimer = useRef<number | null>(null);

    const rows = effort != null ? effortChunkRows(effort) : [];

    // a chip click may arrive while collapsed: the highlight lands once the expanded rows mount.
    useEffect(() => {
        if (!expanded || highlighted == null) {
            return;
        }
        const idx = rows.findIndex((r) => r.label === highlighted);
        if (idx < 0) {
            return;
        }
        document.getElementById(`chunk-${model.oref}-${idx}`)?.scrollIntoView({ block: "nearest" });
        if (clearTimer.current != null) {
            window.clearTimeout(clearTimer.current);
        }
        clearTimer.current = window.setTimeout(() => setHighlighted(null), 1200);
        return () => {
            if (clearTimer.current != null) {
                window.clearTimeout(clearTimer.current);
            }
        };
    }, [expanded, highlighted, rows, model.oref]);

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

    const handleChipClick = (label: string): void => {
        setHighlighted(label);
        onChipClick?.(label);
    };

    return (
        <button
            type="button"
            onClick={onToggle}
            aria-expanded={expanded}
            className="cursor-pointer rounded-[10px] border border-border bg-surface px-[13px] py-[11px] text-left transition-colors duration-[140ms] hover:bg-surface-hover"
        >
            <span className="flex items-baseline gap-2">
                <span className="truncate text-[13px] font-semibold text-primary">{model.title}</span>
                {model.ticket != null && <Tag>{model.ticket}</Tag>}
                {model.project != null && <Tag>{model.project}</Tag>}
                {model.parentoid != null && <Tag>parent</Tag>}
                <span className="ml-auto flex flex-none items-center gap-2">
                    <span
                        role="button"
                        tabIndex={0}
                        title="copy the CLI handle"
                        onClick={(e) => {
                            e.stopPropagation();
                            void navigator.clipboard.writeText("wsh effort show " + oid);
                        }}
                        onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                                e.stopPropagation();
                                void navigator.clipboard.writeText("wsh effort show " + oid);
                            }
                        }}
                        className="cursor-pointer rounded-full border border-dotted border-accent/40 px-[7px] py-[1px] font-mono text-[9.5px] text-accent-soft hover:border-accent/70"
                    >
                        wsh effort show {oid}
                    </span>
                    <span className="font-mono text-[10px] text-muted">
                        {expanded ? (
                            <span
                                role="button"
                                tabIndex={0}
                                title="open the full record"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    onOpenDetail?.();
                                }}
                                onKeyDown={(e) => {
                                    if (e.key === "Enter" || e.key === " ") {
                                        e.stopPropagation();
                                        onOpenDetail?.();
                                    }
                                }}
                                className="cursor-pointer text-accent-soft hover:underline"
                            >
                                details →
                            </span>
                        ) : (
                            model.countLine
                        )}
                    </span>
                </span>
            </span>
            <ProgressBar pct={model.progressPct} className="mt-2" />
            <span className="mt-2 flex flex-wrap gap-1">
                {model.chips.map((c) => (
                    <Chip key={c.label} chip={c} onClick={() => handleChipClick(c.label)} />
                ))}
                {model.chipOverflow > 0 && (
                    <span className="inline-flex items-center rounded-full border border-dotted border-accent/40 px-[7px] py-[1px] font-mono text-[9.5px] text-accent-soft">
                        +{model.chipOverflow}
                    </span>
                )}
            </span>
            {expanded ? (
                <>
                    {effort == null ? (
                        detailError != null ? (
                            <span className="mt-2 flex items-center gap-2 text-[11px] text-error">
                                {detailError}
                                <button
                                    type="button"
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        void loadEffortDetail(model.oref);
                                    }}
                                    className="cursor-pointer rounded-[4px] border border-border px-1.5 py-[1px] font-mono text-[9px] text-secondary hover:text-primary"
                                >
                                    retry
                                </button>
                            </span>
                        ) : (
                            <div className="mt-2 h-10 animate-pulse rounded-[8px] bg-surface" />
                        )
                    ) : (
                        <>
                            <div className="mt-2 flex flex-col">
                                {rows.map((r, i) => (
                                    <div
                                        key={r.label}
                                        id={`chunk-${model.oref}-${i}`}
                                        className={cn(
                                            "group flex items-center gap-2.5 rounded-[7px] px-2 py-[5px]",
                                            i > 0 && "border-t border-edge-faint",
                                            highlighted === r.label && "bg-surface-selected"
                                        )}
                                        title={
                                            r.trail.length > 0
                                                ? r.trail.map((n) => `${fmtDay(n.ts)} ${n.text}`).join("\n")
                                                : undefined
                                        }
                                    >
                                        <Mark tone={r.tone} />
                                        <span className="min-w-0 flex-1 truncate text-[12px] text-primary">
                                            {r.label}
                                        </span>
                                        {r.latestNote != null && (
                                            <span className="max-w-[30%] truncate text-right font-mono text-[10px] text-muted">
                                                {r.latestNote}
                                            </span>
                                        )}
                                        <span
                                            className={cn(
                                                "flex-none rounded-[4px] px-[5px] py-[1px] font-mono text-[9px] font-semibold uppercase",
                                                CHUNK_CHIP_CLASSES[r.tone]
                                            )}
                                        >
                                            {r.status}
                                        </span>
                                        {r.status === "done" && (
                                            <button
                                                type="button"
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    void runMutation(() => reopenChunk(model.oref, r.label));
                                                }}
                                                className="hidden cursor-pointer rounded-[4px] border border-border px-1.5 py-[1px] font-mono text-[9px] text-muted group-hover:block hover:text-primary"
                                            >
                                                reopen
                                            </button>
                                        )}
                                    </div>
                                ))}
                            </div>
                            <div className="mt-2 flex flex-wrap items-center gap-2">
                                <button
                                    type="button"
                                    disabled={model.activeChunk == null}
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        void runMutation(() => advanceChunk(model.oref));
                                    }}
                                    className="cursor-pointer rounded-[7px] bg-accent px-3 py-[5px] text-[11px] font-semibold text-background hover:bg-accenthover disabled:cursor-default disabled:opacity-40"
                                >
                                    Mark active chunk done
                                </button>
                                <button
                                    type="button"
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        setAddingChunk(true);
                                        setNoting(false);
                                    }}
                                    className="cursor-pointer rounded-[6px] border border-border px-2 py-[3px] text-[10px] text-secondary hover:border-accent hover:text-primary"
                                >
                                    + chunk
                                </button>
                                <button
                                    type="button"
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        setNoting(true);
                                        setAddingChunk(false);
                                    }}
                                    className="cursor-pointer rounded-[6px] border border-border px-2 py-[3px] text-[10px] text-secondary hover:border-accent hover:text-primary"
                                >
                                    note
                                </button>
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
                                                : "effort-level note"
                                        }
                                        className="w-64 rounded-[7px] border border-edge-mid bg-background px-2 py-1 text-[12px] text-primary outline-none focus:border-accent/60"
                                    />
                                ) : null}
                                <span className="ml-auto font-mono text-[9.5px] text-ink-faint">
                                    hover a row for its trail · reopen on done rows
                                </span>
                            </div>
                        </>
                    )}
                </>
            ) : null}
            {mutateError != null ? (
                <span className="mt-2 block text-[11px] text-error">{mutateError}</span>
            ) : null}
        </button>
    );
}
