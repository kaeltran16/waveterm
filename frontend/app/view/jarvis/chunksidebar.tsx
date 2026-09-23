// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The Chunk sidebar: one chunk's status and note trail beside the Brief. Not modal — the Brief behind
// it stays live, and prev/next step the Brief's own cursor rather than keeping a second one here.
// Past the container breakpoint it floats over the index instead of compressing it (a container query:
// the Brief is the whole surface, the window is not).

import { cn } from "@/util/util";
import { useState } from "react";
import { feedRows, type FeedEntry } from "./effortfeed";
import { chunkTone } from "./effortmodel";
import { GLYPH, STATUSES, TONE_FG } from "./inlinetrackerview";

const FOCUS = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";
const NOTE_PAGE = 40;
const NAV_BUTTON =
    "h-[22px] w-6 cursor-pointer rounded-[6px] border border-border bg-surface-raised text-[11px] hover:border-edge-strong disabled:cursor-default disabled:opacity-40";

export function ChunkSidebar({
    initiative,
    label,
    stage,
    status,
    position,
    feed,
    expanded,
    now,
    handle,
    error,
    onPrev,
    onNext,
    onExpand,
    onClose,
    onActivity,
    onAddNote,
    onSetStatus,
    onEditNote,
    onDeleteNote,
}: {
    initiative: string;
    label: string;
    stage: string;
    status: string;
    position: { n: number; total: number };
    feed: FeedEntry[];
    expanded: number | null;
    now: number;
    handle: string;
    error: string | null;
    onPrev: (() => void) | null;
    onNext: (() => void) | null;
    onExpand: (i: number | null) => void;
    onClose: () => void;
    onActivity: () => void;
    onAddNote: (text: string) => void;
    onSetStatus: (status: string) => void;
    onEditNote: (entry: FeedEntry, text: string) => void;
    onDeleteNote: (entry: FeedEntry) => void;
}) {
    const notes = feedRows(feed, { only: label, limit: NOTE_PAGE, now }).rows.filter((r) => r.body !== "");
    const [draft, setDraft] = useState("");
    const [editing, setEditing] = useState<{ key: string; text: string } | null>(null);
    const submit = () => {
        const text = draft.trim();
        if (text !== "") {
            onAddNote(text);
            setDraft("");
        }
    };
    const saveEdit = (entry: FeedEntry) => {
        const text = editing?.text.trim() ?? "";
        if (text === "") {
            return; // Save is disabled on empty text; the server would refuse it too (EC-EMPTY-NOTE)
        }
        setEditing(null);
        if (text !== entry.text) {
            onEditNote(entry, text);
        }
    };

    return (
        <aside
            aria-label="Chunk"
            data-jarvis-chunk-sidebar
            className="absolute inset-y-0 right-0 z-[4] flex w-[460px] flex-col overflow-hidden border-l border-border bg-background @max-[1280px]:shadow-[-18px_0_44px_var(--color-background)] @max-[980px]:w-[min(460px,92cqw)]"
        >
            <div className="flex flex-none items-center gap-2 border-b border-edge-faint px-[13px] py-[9px]">
                <span className="font-mono text-[10.5px] font-bold uppercase tracking-[.09em] text-muted">Chunk</span>
                <span className="font-mono text-[10.5px] text-muted">
                    {position.n}/{position.total}
                </span>
                <div className="flex gap-1">
                    <button
                        type="button"
                        aria-label="Previous chunk"
                        title="Previous chunk (k)"
                        disabled={onPrev == null}
                        onClick={onPrev ?? undefined}
                        className={cn(NAV_BUTTON, FOCUS)}
                    >
                        ↑
                    </button>
                    <button
                        type="button"
                        aria-label="Next chunk"
                        title="Next chunk (j)"
                        disabled={onNext == null}
                        onClick={onNext ?? undefined}
                        className={cn(NAV_BUTTON, FOCUS)}
                    >
                        ↓
                    </button>
                </div>
                <span className="font-mono text-[10px] text-muted">j / k</span>
                <button
                    type="button"
                    onClick={onClose}
                    className={cn(
                        "ml-auto cursor-pointer rounded-[7px] border border-border bg-surface-raised px-[9px] py-1 text-[10px] font-semibold text-muted hover:border-edge-strong hover:text-ink-hi",
                        FOCUS
                    )}
                >
                    Close
                </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
                <div className="flex flex-col gap-1.5 px-[18px] pb-3.5 pt-[15px]">
                    <div className="flex items-center gap-[7px] font-mono text-[10.5px] uppercase tracking-[.06em] text-muted">
                        <span className="truncate">{initiative}</span>
                        <span className="text-edge-strong">/</span>
                        <span className="truncate">{stage || "unstaged"}</span>
                        <button
                            type="button"
                            onClick={onActivity}
                            className={cn(
                                "ml-auto cursor-pointer normal-case tracking-normal text-accent-soft hover:underline",
                                FOCUS
                            )}
                        >
                            initiative activity ↗
                        </button>
                    </div>
                    <div className="text-pretty text-[16px] font-semibold leading-[1.35] text-primary">{label}</div>
                    <button
                        type="button"
                        title="Copy the CLI handle"
                        onClick={() => void navigator.clipboard?.writeText(handle)}
                        className={cn(
                            "self-start cursor-pointer font-mono text-[10.5px] text-muted hover:text-ink-hi",
                            FOCUS
                        )}
                    >
                        {handle} ⧉
                    </button>
                </div>
                <div className="px-[18px] pb-4">
                    <div
                        role="radiogroup"
                        aria-label="Status"
                        className="grid grid-cols-6 gap-[3px] rounded-[8px] border border-border bg-surface p-[3px]"
                    >
                        {STATUSES.map((s) => {
                            const tone = chunkTone(s);
                            const on = s === status;
                            return (
                                <button
                                    key={s}
                                    type="button"
                                    role="radio"
                                    aria-checked={on}
                                    onClick={() => !on && onSetStatus(s)}
                                    className={cn(
                                        "flex min-w-0 cursor-pointer flex-col items-center gap-0.5 rounded-[6px] border px-0.5 py-[5px] hover:bg-surface-hover",
                                        on ? "border-edge-mid bg-surface-selected" : "border-transparent",
                                        FOCUS
                                    )}
                                >
                                    <span className={cn("text-[11px] leading-none", on ? TONE_FG[tone] : "text-muted")}>
                                        {GLYPH[tone]}
                                    </span>
                                    <span className={cn("font-mono text-[9.5px]", on ? TONE_FG[tone] : "text-muted")}>
                                        {s}
                                    </span>
                                </button>
                            );
                        })}
                    </div>
                </div>
                <div className="border-t border-edge-faint px-[18px] pb-[18px] pt-3">
                    <div className="mb-2 flex items-center gap-2 font-mono text-[10.5px] font-bold uppercase tracking-[.1em] text-muted">
                        <span>Notes</span>
                        <span className="font-normal tracking-[.04em]">{notes.length}</span>
                    </div>
                    {notes.length === 0 ? (
                        <p className="text-[12px] leading-[1.6] text-muted">
                            No notes on this chunk yet. Notes from you or an agent land here.
                        </p>
                    ) : null}
                    {error != null ? <p className="mb-2 text-[11px] text-error">{error}</p> : null}
                    <div className="flex flex-col gap-2">
                        {notes.map((n, i) => {
                            const open = expanded === i;
                            const isEditing = editing?.key === n.key;
                            const editable = n.entry.noteAt != null;
                            return (
                                <div
                                    key={n.key}
                                    data-jarvis-note-card={n.key}
                                    className={cn(
                                        "rounded-[8px] border bg-surface",
                                        open ? "border-edge-mid" : "border-border"
                                    )}
                                >
                                    <button
                                        type="button"
                                        onClick={() => onExpand(open ? null : i)}
                                        className={cn(
                                            "flex w-full cursor-pointer flex-col gap-[5px] rounded-[8px] px-[11px] py-[9px] text-left hover:bg-surface-hover",
                                            FOCUS
                                        )}
                                    >
                                        <span className="flex w-full items-center gap-[7px] font-mono text-[10.5px] text-muted">
                                            <span>
                                                {n.day || n.entry.marked}
                                                {n.entry.edited ? " · edited" : ""}
                                            </span>
                                            <span className="ml-auto">{open ? "▾" : "▸"}</span>
                                        </span>
                                        {isEditing ? null : (
                                            <span
                                                className={cn(
                                                    "whitespace-pre-wrap break-words text-[12.5px] leading-[1.6] text-secondary",
                                                    !open && "line-clamp-3"
                                                )}
                                            >
                                                {n.body}
                                            </span>
                                        )}
                                    </button>
                                    {isEditing ? (
                                        <div className="flex flex-col gap-1.5 px-[11px] pb-2.5">
                                            <textarea
                                                autoFocus
                                                rows={6}
                                                value={editing.text}
                                                onChange={(e) => setEditing({ key: n.key, text: e.target.value })}
                                                onKeyDown={(e) => {
                                                    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                                                        saveEdit(n.entry);
                                                    } else if (e.key === "Escape") {
                                                        e.stopPropagation();
                                                        setEditing(null);
                                                    }
                                                }}
                                                className="w-full resize-y rounded-[7px] border border-accent/60 bg-background px-2.5 py-2 text-[12.5px] leading-[1.6] text-primary outline-none"
                                            />
                                            <div className="flex items-center gap-1.5">
                                                <span className="flex-1 font-mono text-[10.5px] text-muted">
                                                    ctrl+enter save · esc cancel
                                                </span>
                                                <button
                                                    type="button"
                                                    onClick={() => setEditing(null)}
                                                    className={cn(
                                                        "cursor-pointer rounded-[7px] border border-border bg-surface-raised px-[11px] py-1 text-[11px] font-semibold text-secondary",
                                                        FOCUS
                                                    )}
                                                >
                                                    Cancel
                                                </button>
                                                <button
                                                    type="button"
                                                    disabled={editing.text.trim() === ""}
                                                    onClick={() => saveEdit(n.entry)}
                                                    className={cn(
                                                        "cursor-pointer rounded-[7px] bg-accent px-[11px] py-1 text-[11px] font-bold text-background disabled:cursor-default disabled:opacity-40",
                                                        FOCUS
                                                    )}
                                                >
                                                    Save
                                                </button>
                                            </div>
                                        </div>
                                    ) : open && editable ? (
                                        <div className="flex gap-3 border-t border-edge-faint px-[11px] py-1.5">
                                            <button
                                                type="button"
                                                data-jarvis-note-edit
                                                onClick={() => setEditing({ key: n.key, text: n.entry.text })}
                                                className={cn(
                                                    "cursor-pointer font-mono text-[10.5px] text-muted hover:text-accent-soft",
                                                    FOCUS
                                                )}
                                            >
                                                edit
                                            </button>
                                            <button
                                                type="button"
                                                data-jarvis-note-delete
                                                onClick={() => onDeleteNote(n.entry)}
                                                className={cn(
                                                    "cursor-pointer font-mono text-[10.5px] text-muted hover:text-error",
                                                    FOCUS
                                                )}
                                            >
                                                delete
                                            </button>
                                        </div>
                                    ) : null}
                                </div>
                            );
                        })}
                    </div>
                </div>
            </div>
            <div className="flex-none border-t border-border bg-surface px-[13px] pb-3 pt-2.5">
                <div className="flex flex-col gap-1.5 rounded-[8px] border border-edge-mid bg-background py-[7px] pl-2.5 pr-2">
                    <textarea
                        rows={3}
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                                submit();
                            } else if (e.key === "Escape" && draft !== "") {
                                // a half-typed note: Escape clears it before the sidebar's own Escape closes the panel
                                e.stopPropagation();
                                setDraft("");
                            }
                        }}
                        placeholder={`note on ${label}`}
                        aria-label="New note"
                        className="w-full resize-none bg-transparent text-[12.5px] leading-[1.6] text-primary outline-none"
                    />
                    <div className="flex items-center gap-2">
                        <span className="flex-1 font-mono text-[10.5px] text-muted">ctrl+enter to add</span>
                        <button
                            type="button"
                            disabled={draft.trim() === ""}
                            onClick={submit}
                            className={cn(
                                "cursor-pointer rounded-[6px] bg-accent px-[11px] py-1 text-[11px] font-bold text-background disabled:cursor-default disabled:bg-surface-raised disabled:text-muted",
                                FOCUS
                            )}
                        >
                            Add note
                        </button>
                    </div>
                </div>
            </div>
        </aside>
    );
}
