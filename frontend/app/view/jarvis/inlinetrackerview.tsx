// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The inline initiative tracker and its note sidebar — the views over inlinetracker.ts.
//
// Two rules decide the shapes below. The plan reads first: an expanded initiative shows its stages and
// chunks in place, and prose moves out to the sidebar, because an initiative's notes here average ~1.1k
// characters and the sheet this replaces could not hold plan and prose at 640px. And the sidebar is not
// modal: the Brief behind it stays readable and clickable, so reading a note never costs your place in
// the index.
//
// The reader's width is the one adaptive rule. Docking it steals 580px, which a ~1000px window cannot
// spare, so past a container breakpoint the reader stops compressing the index and floats over it under
// a scrim instead. That is a CONTAINER query, not a media query: the Brief is the whole surface, and the
// window is not the surface.

import { cn } from "@/util/util";
import { useState } from "react";
import { feedRows, kilo, type FeedEntry } from "./effortfeed";
import type { ChunkTone } from "./effortmodel";
import type { DetailRow } from "./inlinetracker";

const FOCUS = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";

// the sans stack, deliberately: the mono face ships no ▸/▾/▶, so a mono caret renders the same
// fallback box in both states and the disclosure stops saying anything.
const GLYPH: Record<ChunkTone, string> = {
    done: "✓",
    active: "▶",
    blocked: "!",
    deferred: "❙❙",
    skipped: "–",
    pending: "·",
};

const TONE_FG: Record<ChunkTone, string> = {
    done: "text-success",
    active: "text-accent",
    blocked: "text-warning-soft",
    deferred: "text-warning-soft",
    skipped: "text-muted",
    pending: "text-muted",
};

const NOTE_PAGE = 40;
const STATUSES = ["pending", "active", "blocked", "deferred", "skipped", "done"];

const SMALL_BUTTON =
    "cursor-pointer rounded-[6px] border border-border px-2 py-[3px] font-mono text-[10px] text-muted hover:border-edge-strong hover:text-ink-hi";

export function InitiativeDetail({
    rows,
    cursor,
    archived,
    onSelectChunk,
    onToggleStage,
    onAddChunk,
    onArchive,
}: {
    rows: DetailRow[];
    cursor: string | undefined;
    archived: boolean;
    onSelectChunk: (id: string) => void;
    onToggleStage: (id: string, open: boolean) => void;
    onAddChunk: (label: string) => void;
    onArchive: () => void;
}) {
    if (rows.length === 0) {
        return null;
    }
    return (
        // flush with the row above and sharing its corner radius, so an open initiative reads as one
        // card rather than a row with a second block stepped in beneath it
        <div
            data-jarvis-initiative-detail="true"
            className="mb-2 rounded-b-[9px] bg-surface-selected/40 pb-[11px] pl-1.5 pr-2.5 pt-[7px]"
        >
            {rows.map((row) => {
                if (row.kind === "pending") {
                    return (
                        <p key={row.id} className="px-1.5 py-2 text-[12px] leading-[1.55] text-muted">
                            {row.message}
                        </p>
                    );
                }
                if (row.kind === "facts") {
                    return (
                        <div
                            key={row.id}
                            className="flex flex-wrap items-center gap-x-[9px] gap-y-[5px] px-[5px] pb-[7px] font-mono text-[9px] text-muted"
                        >
                            {/* the id is what you paste into a prompt or a `wsh effort` call, and a
                                span is the one thing you cannot lift out of a row you can click */}
                            <button
                                type="button"
                                title="copy this initiative's id"
                                onClick={() => void navigator.clipboard?.writeText(row.oref.replace(/^effort:/, ""))}
                                className={cn("cursor-pointer text-ink-mid hover:text-ink-hi", FOCUS)}
                            >
                                {row.oref.replace(/^effort:/, "")}
                            </button>
                            <span>{row.count}</span>
                            <span className="ml-auto flex items-center gap-2.5">
                                <AddChunk onAdd={onAddChunk} />
                                {/* no confirm, as on the sheet this replaces: `wsh effort unarchive` is
                                    the way back */}
                                {archived ? null : (
                                    <button type="button" onClick={onArchive} className={cn(SMALL_BUTTON, FOCUS)}>
                                        archive
                                    </button>
                                )}
                            </span>
                        </div>
                    );
                }
                if (row.kind === "stage") {
                    return (
                        <button
                            key={row.id}
                            type="button"
                            aria-expanded={!row.collapsed}
                            onClick={() => onToggleStage(row.id, row.collapsed)}
                            data-jarvis-tracker-stage={row.stage}
                            // 14px above / 1px below: a group header has to bind to the rows it opens,
                            // and equal gaps on both sides make it float between two groups instead
                            className={cn(
                                "flex w-full cursor-pointer items-baseline gap-[7px] px-[5px] pb-px pt-3.5 text-left",
                                FOCUS
                            )}
                        >
                            <span className="w-[9px] flex-none text-center text-[10px] leading-none text-ink-mid">
                                {row.collapsed ? "▸" : "▾"}
                            </span>
                            <span className="min-w-0 flex-1 truncate font-mono text-[9px] font-bold uppercase tracking-[.08em] text-feed-label">
                                {row.stage === "" ? "unstaged" : row.stage}
                            </span>
                            <span className="flex-none font-mono text-[9px] text-muted">{row.fraction}</span>
                        </button>
                    );
                }
                const selected = cursor === row.id;
                return (
                    <button
                        key={row.id}
                        type="button"
                        aria-pressed={selected}
                        onClick={() => onSelectChunk(row.id)}
                        data-jarvis-tracker-chunk={row.row.label}
                        className={cn(
                            "my-px flex w-full min-w-0 cursor-pointer items-baseline gap-2 rounded-[6px] px-[7px] py-[5px] text-left",
                            selected ? "bg-surface-selected" : "hover:bg-surface-hover",
                            FOCUS
                        )}
                    >
                        <span
                            aria-hidden
                            className={cn("w-3 flex-none text-center text-[10px]", TONE_FG[row.row.tone])}
                        >
                            {GLYPH[row.row.tone]}
                        </span>
                        <span
                            className={cn(
                                "min-w-0 flex-1 truncate text-[12px] leading-[1.4]",
                                selected ? "font-semibold text-ink-hi" : "text-secondary"
                            )}
                        >
                            {row.row.label}
                        </span>
                        {row.notes > 0 ? (
                            <span className="flex-none truncate font-mono text-[9px] text-muted">
                                {row.notes} {row.notes === 1 ? "note" : "notes"}
                            </span>
                        ) : null}
                        <span
                            className={cn(
                                "w-[54px] flex-none text-right font-mono text-[8.5px] uppercase tracking-[.04em]",
                                TONE_FG[row.row.tone],
                                row.row.status === "skipped" && "line-through"
                            )}
                        >
                            {row.row.status}
                        </span>
                    </button>
                );
            })}
        </div>
    );
}

export function NoteSidebar({
    label,
    stage,
    status,
    feed,
    reading,
    now,
    handle,
    error,
    onRead,
    onBack,
    onClose,
    onActivity,
    onAddNote,
    onSetStatus,
}: {
    label: string;
    stage: string;
    status: string;
    feed: FeedEntry[];
    reading: number | null;
    now: number;
    handle: string;
    error: string | null;
    onRead: (i: number) => void;
    onBack: () => void;
    onClose: () => void;
    onActivity: () => void;
    onAddNote: (text: string) => void;
    onSetStatus: (status: string) => void;
}) {
    const { rows } = feedRows(feed, { only: label, limit: NOTE_PAGE, now });
    const notes = rows.filter((r) => r.body !== "");
    const open = reading != null ? (notes[reading] ?? null) : null;
    const [noteDraft, setNoteDraft] = useState<string | null>(null);

    const submitNote = () => {
        const text = (noteDraft ?? "").trim();
        setNoteDraft(null);
        if (text !== "") {
            onAddNote(text);
        }
    };

    return (
        <aside
            aria-label={open != null ? "Task note" : "Task notes"}
            data-jarvis-note-sidebar={open != null ? "reader" : "previews"}
            className={cn(
                "absolute inset-y-0 right-0 z-[4] flex flex-col overflow-hidden border-l border-border bg-background",
                // docked at 360; the reader widens to 560 and, below the breakpoint, stops pushing the
                // index and casts a shadow over it instead
                open != null
                    ? "w-[560px] @max-[1280px]:w-[min(560px,84cqw)] @max-[1280px]:shadow-[-26px_0_64px_var(--color-background)] @max-[980px]:w-[min(560px,88cqw)]"
                    : "w-[360px] @max-[980px]:w-[min(360px,92cqw)] @max-[980px]:shadow-[-18px_0_44px_var(--color-background)]"
            )}
        >
            <div className="flex flex-none items-center gap-2 border-b border-edge-faint px-[13px] py-[11px]">
                <span className="font-mono text-[9px] font-bold uppercase tracking-[.12em] text-feed-label">
                    {open != null ? "Task note" : "Task notes"}
                </span>
                <button
                    type="button"
                    onClick={onActivity}
                    className={cn("cursor-pointer font-mono text-[9px] text-accent-soft hover:underline", FOCUS)}
                >
                    initiative activity ↗
                </button>
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

            {open != null ? (
                <div className="min-h-0 flex-1 overflow-y-auto">
                    <div className="sticky top-0 z-[2] flex items-center gap-[9px] border-b border-edge-faint bg-background px-3.5 py-2.5">
                        <button
                            type="button"
                            onClick={onBack}
                            className={cn(
                                "cursor-pointer font-mono text-[9.5px] text-accent-soft hover:underline",
                                FOCUS
                            )}
                        >
                            ← notes
                        </button>
                        <span className="ml-auto whitespace-nowrap font-mono text-[9px] text-muted">
                            {open.day} · {kilo(open.body.length)} chars · {(reading ?? 0) + 1} of {notes.length}
                        </span>
                    </div>
                    <div className="px-[18px] pt-[15px]">
                        <div className="mb-[5px] font-mono text-[8.5px] uppercase tracking-[.06em] text-muted">
                            {stage}
                        </div>
                        <div className="max-w-[68ch] text-[13px] font-semibold leading-[1.45] text-ink-hi">{label}</div>
                    </div>
                    <div className="max-w-[68ch] whitespace-pre-wrap break-words px-[18px] pb-8 pt-3.5 text-[13px] leading-[1.72] text-secondary">
                        {open.body}
                    </div>
                </div>
            ) : (
                <div className="min-h-0 flex-1 overflow-y-auto px-3.5 pb-4 pt-[13px]">
                    {stage !== "" ? (
                        <div className="mb-2 font-mono text-[8.5px] uppercase tracking-[.06em] text-muted">{stage}</div>
                    ) : null}
                    <div className="text-pretty text-[13px] font-semibold leading-[1.45] text-ink-hi">{label}</div>
                    <div className="mt-1.5 flex flex-wrap gap-1.5 font-mono text-[8.5px] uppercase tracking-[.04em] text-muted">
                        <span>{status}</span>
                        <span>·</span>
                        <span>
                            {notes.length} {notes.length === 1 ? "note" : "notes"}
                        </span>
                    </div>
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                        <button
                            type="button"
                            onClick={() => setNoteDraft(noteDraft == null ? "" : null)}
                            aria-expanded={noteDraft != null}
                            className={cn(
                                "flex-none cursor-pointer rounded-[7px] border border-accent bg-accent px-3 py-1.5 text-[11.5px] font-bold text-background hover:bg-accenthover",
                                FOCUS
                            )}
                        >
                            Add note
                        </button>
                        <select
                            value={status}
                            aria-label="Set this task's status"
                            onChange={(e) => onSetStatus(e.target.value)}
                            className={cn(
                                "min-w-0 flex-1 cursor-pointer rounded-[6px] border border-border bg-surface-raised px-[7px] py-1 text-[10px] text-secondary",
                                FOCUS
                            )}
                        >
                            {STATUSES.map((s) => (
                                <option key={s} value={s}>
                                    {s}
                                </option>
                            ))}
                        </select>
                    </div>
                    {noteDraft != null ? (
                        <input
                            autoFocus
                            value={noteDraft}
                            onChange={(e) => setNoteDraft(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === "Enter") {
                                    submitNote();
                                } else if (e.key === "Escape") {
                                    // stopped here: the sidebar's Escape ladder would otherwise close the
                                    // panel out from under a half-typed note
                                    e.stopPropagation();
                                    setNoteDraft(null);
                                }
                            }}
                            placeholder={`note on ${label}`}
                            aria-label="New note"
                            className="mt-2 w-full rounded-[7px] border border-edge-mid bg-background px-2.5 py-1.5 text-[12.5px] text-primary outline-none focus:border-accent/60"
                        />
                    ) : null}
                    {error != null ? <p className="mt-2 text-[11px] text-error">{error}</p> : null}
                    <button
                        type="button"
                        title="copy the CLI handle"
                        onClick={() => void navigator.clipboard?.writeText(handle)}
                        className={cn("mt-2 cursor-pointer font-mono text-[9.5px] text-muted hover:text-ink-hi", FOCUS)}
                    >
                        {handle}
                    </button>
                    {notes.length === 0 ? (
                        <p className="mt-3 text-[12px] leading-[1.6] text-muted">
                            No notes on this task yet. A note written by you or by an agent lands here.
                        </p>
                    ) : (
                        <div className="mt-3 flex flex-col gap-1">
                            {notes.map((n, i) => (
                                <div key={n.key}>
                                    {i === 1 ? (
                                        <div className="mx-[7px] mt-1.5 border-t border-edge-faint pt-[9px] font-mono text-[8.5px] font-bold uppercase tracking-[.1em] text-muted">
                                            Earlier
                                        </div>
                                    ) : null}
                                    <button
                                        type="button"
                                        onClick={() => onRead(i)}
                                        data-jarvis-note-preview={n.key}
                                        className={cn(
                                            "flex w-full cursor-pointer flex-col gap-[3px] rounded-[6px] p-[7px] text-left hover:bg-surface-hover",
                                            FOCUS
                                        )}
                                    >
                                        <span className="flex items-center gap-[7px] font-mono text-[9px] text-muted">
                                            <span>{n.day}</span>
                                            <span>{kilo(n.body.length)} chars</span>
                                            <span className="ml-auto text-accent-soft">open</span>
                                        </span>
                                        <span
                                            className={cn(
                                                "overflow-hidden text-[12px] leading-[1.55]",
                                                i === 0 ? "line-clamp-5 text-secondary" : "line-clamp-3 text-ink-mid"
                                            )}
                                        >
                                            {n.body}
                                        </span>
                                    </button>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            )}
        </aside>
    );
}

// The inline "+ chunk" control: a button that becomes its own input, so an empty plan still has the one
// affordance that fills it without opening anything.
function AddChunk({ onAdd }: { onAdd: (label: string) => void }) {
    const [draft, setDraft] = useState<string | null>(null);
    if (draft == null) {
        return (
            <button type="button" onClick={() => setDraft("")} className={cn(SMALL_BUTTON, FOCUS)}>
                + chunk
            </button>
        );
    }
    const commit = () => {
        const label = draft.trim();
        setDraft(null);
        if (label !== "") {
            onAdd(label);
        }
    };
    return (
        <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
                if (e.key === "Enter") {
                    commit();
                } else if (e.key === "Escape") {
                    setDraft(null);
                }
            }}
            placeholder="chunk label"
            aria-label="New chunk label"
            className="w-56 rounded-[6px] border border-edge-mid bg-background px-2 py-[3px] text-[11px] text-primary outline-none focus:border-accent/60"
        />
    );
}
