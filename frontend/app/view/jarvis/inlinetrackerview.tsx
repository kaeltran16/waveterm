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
import { Fragment, useEffect, useState } from "react";
import { feedRows, kilo, type FeedEntry } from "./effortfeed";
import { chunkTone, type ChunkTone } from "./effortmodel";
import type { DetailRow } from "./inlinetracker";

const FOCUS = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";

// the sans stack, deliberately: the mono face ships no ▸/▾/▶, so a mono caret renders the same
// fallback box in both states and the disclosure stops saying anything.
export const GLYPH: Record<ChunkTone, string> = {
    done: "✓",
    active: "▶",
    blocked: "!",
    deferred: "❙❙",
    skipped: "–",
    pending: "·",
};

export const TONE_FG: Record<ChunkTone, string> = {
    done: "text-success",
    active: "text-accent",
    blocked: "text-warning-soft",
    deferred: "text-warning-soft",
    skipped: "text-muted",
    pending: "text-muted",
};

const NOTE_PAGE = 40;
export const STATUSES = ["pending", "active", "blocked", "deferred", "skipped", "done"];

const SMALL_BUTTON =
    "cursor-pointer rounded-[6px] border border-border px-2 py-[3px] font-mono text-[10px] text-muted hover:border-edge-strong hover:text-ink-hi";

export type TrackerEdits = {
    oid: string; // bare effort oid, for the footer's copy button (an empty plan has no facts row)
    title: string;
    effortStatus: string; // active | paused | done | archived
    total: number;
    stages: string[]; // stageOptions(chunks), for "Move to stage"
    onSetStatus: (label: string, status: string) => void;
    onRenameChunk: (label: string, next: string) => void;
    onMoveChunk: (label: string, dir: "up" | "down") => void;
    canMove: (label: string, dir: "up" | "down") => boolean;
    onMoveToStage: (label: string, stage: string) => void;
    onDeleteChunk: (label: string) => void;
    onRenameStage: (at: number, next: string) => void;
    onDeleteStage: (at: number) => void;
    onAddChunk: (label: string, stage: string, runAt: number | null) => void;
    onRename: (title: string) => void;
    onDetails: () => void;
    onTogglePause: () => void;
    onArchive: () => void;
    onUnarchive: () => void;
    onDelete: () => void;
};

type Editing = { id: string; draft: string } | null;

export function InitiativeDetail({
    rows,
    cursor,
    edits,
    onSelectChunk,
    onToggleStage,
}: {
    rows: DetailRow[];
    cursor: string | undefined;
    edits: TrackerEdits;
    onSelectChunk: (id: string) => void;
    onToggleStage: (id: string, open: boolean) => void;
}) {
    // one menu and one inline editor at a time, across every row of this plan
    const [menu, setMenu] = useState<string | null>(null);
    const [editing, setEditing] = useState<Editing>(null);
    const [confirming, setConfirming] = useState(false);
    const [newStage, setNewStage] = useState<{ name: string; chunk: string | null } | null>(null);
    useEffect(() => {
        if (menu == null) {
            return;
        }
        const close = (e: Event) => {
            if (e instanceof KeyboardEvent) {
                if (e.key !== "Escape") {
                    return;
                }
                // the menu is the innermost layer: Escape closes it, not the sidebar or the surface
                e.stopPropagation();
            } else if ((e.target as Element | null)?.closest("[data-jarvis-tracker-menu]") != null) {
                return;
            }
            setMenu(null);
        };
        document.addEventListener("mousedown", close);
        document.addEventListener("keydown", close, true);
        return () => {
            document.removeEventListener("mousedown", close);
            document.removeEventListener("keydown", close, true);
        };
    }, [menu]);

    if (rows.length === 0) {
        return null;
    }
    const startEdit = (id: string, draft: string) => {
        setMenu(null);
        setEditing({ id, draft });
    };
    const commitEdit = (apply: (next: string) => void, before: string) => {
        const next = editing?.draft.trim() ?? "";
        setEditing(null);
        if (next !== "" && next !== before) {
            apply(next);
        }
    };
    const renameInput = (id: string, before: string, apply: (next: string) => void, cls: string) =>
        editing?.id === id ? (
            <input
                autoFocus
                data-jarvis-rename-input
                value={editing.draft}
                onChange={(e) => setEditing({ id, draft: e.target.value })}
                onClick={(e) => e.stopPropagation()}
                onBlur={() => commitEdit(apply, before)}
                onKeyDown={(e) => {
                    if (e.key === "Enter") {
                        commitEdit(apply, before);
                    } else if (e.key === "Escape") {
                        e.stopPropagation();
                        setEditing(null);
                    }
                }}
                className={cn(
                    "min-w-0 flex-1 rounded-[5px] border border-accent/60 bg-background px-1.5 py-px text-primary outline-none",
                    cls
                )}
            />
        ) : null;
    // the last row each open stage header owns, so "+ Add chunk" lands at the end of the right run
    const addAfter = new Map<number, Extract<DetailRow, { kind: "stage" }>>();
    let openStage: Extract<DetailRow, { kind: "stage" }> | null = null;
    for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        if (r.kind === "stage") {
            openStage = r.collapsed ? null : r;
        }
        if (openStage != null && (i + 1 === rows.length || rows[i + 1].kind === "stage")) {
            addAfter.set(i, openStage);
        }
    }

    return (
        // flush with the row above and sharing its corner radius, so an open initiative reads as one
        // card rather than a row with a second block stepped in beneath it
        <div
            data-jarvis-initiative-detail="true"
            className="mb-2 rounded-b-[9px] bg-surface-selected/40 pb-[11px] pl-1.5 pr-2.5 pt-[7px]"
        >
            {rows.map((row, i) => {
                const tail = addAfter.get(i);
                const add =
                    tail != null ? (
                        <AddChunkRow
                            placeholder={`chunk in ${tail.stage || "unstaged"}`}
                            onAdd={(label) => edits.onAddChunk(label, tail.stage, tail.at)}
                        />
                    ) : null;
                if (row.kind === "pending") {
                    return (
                        <p key={row.id} className="px-1.5 py-2 text-[12px] leading-[1.55] text-muted">
                            {row.message}
                        </p>
                    );
                }
                if (row.kind === "facts") {
                    return null; // the footer below carries the id, count and actions now
                }
                if (row.kind === "stage") {
                    const menuId = row.id + "#menu";
                    return (
                        <Fragment key={row.id}>
                            <div
                                data-jarvis-tracker-stage={row.stage}
                                aria-expanded={!row.collapsed}
                                className="relative mt-2 flex items-center gap-2 border-t border-edge-faint px-1.5 pb-1 pt-2.5"
                            >
                                <button
                                    type="button"
                                    aria-label="Toggle stage"
                                    onClick={() => onToggleStage(row.id, row.collapsed)}
                                    className={cn("w-3.5 flex-none cursor-pointer text-[10px] text-ink-mid", FOCUS)}
                                >
                                    {row.collapsed ? "▸" : "▾"}
                                </button>
                                {renameInput(
                                    row.id,
                                    row.stage,
                                    (next) => edits.onRenameStage(row.at, next),
                                    "text-[11.5px] font-semibold"
                                ) ?? (
                                    <button
                                        type="button"
                                        title="Double-click to rename"
                                        onClick={() => onToggleStage(row.id, row.collapsed)}
                                        onDoubleClick={() => startEdit(row.id, row.stage)}
                                        className={cn(
                                            "min-w-0 flex-1 cursor-pointer truncate text-left text-[11.5px] font-semibold text-primary",
                                            FOCUS
                                        )}
                                    >
                                        {row.stage === "" ? "unstaged" : row.stage}
                                    </button>
                                )}
                                <StageBar fraction={row.fraction} />
                                <span className="w-7 flex-none font-mono text-[10.5px] text-muted">{row.fraction}</span>
                                <button
                                    type="button"
                                    aria-label="Stage actions"
                                    onClick={() => setMenu(menu === menuId ? null : menuId)}
                                    className={cn(
                                        "h-5 w-[22px] flex-none cursor-pointer rounded-[5px] border text-[12px] leading-none text-muted hover:text-ink-hi",
                                        menu === menuId ? "border-edge-mid" : "border-transparent",
                                        FOCUS
                                    )}
                                >
                                    ⋯
                                </button>
                                {menu === menuId ? (
                                    <Menu className="right-1 top-[calc(100%-2px)] w-40">
                                        <MenuItem onClick={() => startEdit(row.id, row.stage)}>Rename stage</MenuItem>
                                        <MenuItem
                                            danger
                                            onClick={() => {
                                                setMenu(null);
                                                edits.onDeleteStage(row.at);
                                            }}
                                        >
                                            Delete stage
                                        </MenuItem>
                                    </Menu>
                                ) : null}
                            </div>
                            {add}
                        </Fragment>
                    );
                }
                const selected = cursor === row.id;
                const label = row.row.label;
                const menuId = row.id + "#menu";
                const otherStages = [...edits.stages, ""].filter((s) => s !== row.row.stage);
                return (
                    <Fragment key={row.id}>
                        <div className="relative">
                            <div
                                role="button"
                                tabIndex={-1}
                                aria-pressed={selected}
                                title="Click for notes · double-click to rename"
                                onClick={() => onSelectChunk(row.id)}
                                onDoubleClick={() => startEdit(row.id, label)}
                                data-jarvis-tracker-chunk={label}
                                className={cn(
                                    "my-px flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-[6px] py-[5px] pl-[7px] pr-1.5 text-left",
                                    selected ? "bg-surface-selected" : "hover:bg-surface-hover"
                                )}
                            >
                                <span
                                    aria-hidden
                                    className={cn("w-3 flex-none text-center text-[10px]", TONE_FG[row.row.tone])}
                                >
                                    {GLYPH[row.row.tone]}
                                </span>
                                {renameInput(
                                    row.id,
                                    label,
                                    (next) => edits.onRenameChunk(label, next),
                                    "text-[12px]"
                                ) ?? (
                                    <span
                                        className={cn(
                                            "min-w-0 flex-1 truncate text-[12px] leading-[1.4]",
                                            selected ? "font-semibold text-ink-hi" : "text-secondary",
                                            row.row.status === "skipped" && "line-through"
                                        )}
                                    >
                                        {label}
                                    </span>
                                )}
                                {row.notes > 0 ? (
                                    <span className="flex-none font-mono text-[10.5px] text-muted">
                                        {row.notes} {row.notes === 1 ? "note" : "notes"}
                                    </span>
                                ) : null}
                                <button
                                    type="button"
                                    title="Change status"
                                    data-jarvis-chunk-status={row.row.status}
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        setMenu(menu === menuId ? null : menuId);
                                    }}
                                    className={cn(
                                        "flex w-[86px] flex-none cursor-pointer items-center justify-between gap-1 rounded-[5px] border px-[7px] py-0.5 text-[11px] font-medium hover:border-edge-mid",
                                        menu === menuId ? "border-edge-mid" : "border-transparent",
                                        TONE_FG[row.row.tone],
                                        FOCUS
                                    )}
                                >
                                    {row.row.status}
                                    <span className="text-[8px] text-muted">▾</span>
                                </button>
                            </div>
                            {menu === menuId ? (
                                <Menu className="right-1 top-[calc(100%+2px)] w-[184px]">
                                    <MenuHead>Status</MenuHead>
                                    {STATUSES.map((s) => (
                                        <MenuItem
                                            key={s}
                                            active={s === row.row.status}
                                            glyph={<span className={TONE_FG[chunkTone(s)]}>{GLYPH[chunkTone(s)]}</span>}
                                            onClick={() => {
                                                setMenu(null);
                                                if (s !== row.row.status) {
                                                    edits.onSetStatus(label, s);
                                                }
                                            }}
                                        >
                                            {s}
                                        </MenuItem>
                                    ))}
                                    <MenuRule />
                                    <MenuItem onClick={() => startEdit(row.id, label)}>Rename</MenuItem>
                                    <MenuItem
                                        glyph="↑"
                                        hint="alt ↑"
                                        disabled={!edits.canMove(label, "up")}
                                        onClick={() => {
                                            setMenu(null);
                                            edits.onMoveChunk(label, "up");
                                        }}
                                    >
                                        Move up
                                    </MenuItem>
                                    <MenuItem
                                        glyph="↓"
                                        hint="alt ↓"
                                        disabled={!edits.canMove(label, "down")}
                                        onClick={() => {
                                            setMenu(null);
                                            edits.onMoveChunk(label, "down");
                                        }}
                                    >
                                        Move down
                                    </MenuItem>
                                    {otherStages.length > 0 ? (
                                        <>
                                            <MenuRule />
                                            <MenuHead>Move to stage</MenuHead>
                                            {otherStages.map((s) => (
                                                <MenuItem
                                                    key={s || "~"}
                                                    glyph="→"
                                                    onClick={() => {
                                                        setMenu(null);
                                                        edits.onMoveToStage(label, s);
                                                    }}
                                                >
                                                    {s || "unstaged"}
                                                </MenuItem>
                                            ))}
                                        </>
                                    ) : null}
                                    <MenuRule />
                                    <MenuItem
                                        danger
                                        onClick={() => {
                                            setMenu(null);
                                            edits.onDeleteChunk(label);
                                        }}
                                    >
                                        Delete chunk
                                    </MenuItem>
                                </Menu>
                            ) : null}
                        </div>
                        {add}
                    </Fragment>
                );
            })}
            <NewStageRow
                state={newStage}
                onChange={setNewStage}
                onAdd={(name, chunk) => edits.onAddChunk(chunk, name, null)}
            />
            <TrackerFooter
                facts={rows.find((r): r is Extract<DetailRow, { kind: "facts" }> => r.kind === "facts") ?? null}
                edits={edits}
                confirming={confirming}
                onConfirm={setConfirming}
            />
        </div>
    );
}

function StageBar({ fraction }: { fraction: string }) {
    const [done, total] = fraction.split("/").map(Number);
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    return (
        <span className="h-[3px] w-12 flex-none overflow-hidden rounded-sm bg-border">
            <span className="block h-full rounded-sm bg-success" style={{ width: `${pct}%` }} />
        </span>
    );
}

function Menu({ className, children }: { className: string; children: React.ReactNode }) {
    return (
        <div
            data-jarvis-tracker-menu
            onClick={(e) => e.stopPropagation()}
            className={cn(
                "absolute z-30 rounded-[8px] border border-edge-strong bg-surface-raised p-[5px] shadow-[0_12px_34px_var(--color-background)]",
                className
            )}
        >
            {children}
        </div>
    );
}

function MenuHead({ children }: { children: React.ReactNode }) {
    return (
        <div className="px-[7px] pb-[5px] pt-1 font-mono text-[10.5px] font-bold uppercase tracking-[.1em] text-muted">
            {children}
        </div>
    );
}

const MenuRule = () => <div className="mx-0.5 my-[5px] h-px bg-border" />;

function MenuItem({
    children,
    onClick,
    glyph,
    hint,
    active,
    danger,
    disabled,
}: {
    children: React.ReactNode;
    onClick: () => void;
    glyph?: React.ReactNode;
    hint?: string;
    active?: boolean;
    danger?: boolean;
    disabled?: boolean;
}) {
    return (
        <button
            type="button"
            disabled={disabled}
            onClick={onClick}
            className={cn(
                "flex w-full items-center gap-2 rounded-[5px] px-[7px] py-[5px] text-left text-[12px]",
                danger ? "text-error hover:bg-error/10" : "text-secondary hover:bg-surface-hover",
                active && "bg-surface-hover",
                disabled ? "cursor-default opacity-40" : "cursor-pointer",
                FOCUS
            )}
        >
            <span className="w-3 flex-none text-center text-[10px] text-muted">{glyph}</span>
            <span className="min-w-0 flex-1 truncate">{children}</span>
            {hint != null ? <span className="font-mono text-[10.5px] text-muted">{hint}</span> : null}
        </button>
    );
}

// "+ Add chunk" at the end of a stage run: a button that becomes its own input
function AddChunkRow({ placeholder, onAdd }: { placeholder: string; onAdd: (label: string) => void }) {
    const [draft, setDraft] = useState<string | null>(null);
    if (draft == null) {
        return (
            <button
                type="button"
                data-jarvis-add-chunk
                onClick={() => setDraft("")}
                className={cn(
                    "flex cursor-pointer items-center gap-2 px-[7px] py-1 text-[11.5px] font-medium text-muted hover:text-accent-soft",
                    FOCUS
                )}
            >
                <span className="w-3 text-center">+</span>Add chunk
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
        <div className="flex items-center gap-2 py-[3px] pl-[7px] pr-1.5">
            <span className="w-3 text-center text-[10px] text-muted">+</span>
            <input
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={commit}
                onKeyDown={(e) => {
                    if (e.key === "Enter") {
                        commit();
                    } else if (e.key === "Escape") {
                        e.stopPropagation();
                        setDraft(null);
                    }
                }}
                placeholder={placeholder}
                aria-label="New chunk label"
                className="min-w-0 flex-1 rounded-[5px] border border-edge-mid bg-background px-[7px] py-[3px] text-[12px] text-primary outline-none focus:border-accent/60"
            />
            <span className="font-mono text-[10.5px] text-muted">enter · esc</span>
        </div>
    );
}

// a stage is a label on chunks, so it exists only once its first chunk does: name, then first chunk
function NewStageRow({
    state,
    onChange,
    onAdd,
}: {
    state: { name: string; chunk: string | null } | null;
    onChange: (s: { name: string; chunk: string | null } | null) => void;
    onAdd: (name: string, chunk: string) => void;
}) {
    const input =
        "min-w-0 flex-1 rounded-[5px] border border-edge-mid bg-background px-[7px] py-[3px] text-[11.5px] text-primary outline-none focus:border-accent/60";
    return (
        <div className="mt-2.5 border-t border-edge-faint px-[5px] pt-2">
            {state == null ? (
                <button
                    type="button"
                    data-jarvis-new-stage
                    onClick={() => onChange({ name: "", chunk: null })}
                    className={cn(
                        "flex cursor-pointer items-center gap-2 px-0.5 py-0.5 text-[11.5px] font-semibold text-muted hover:text-accent-soft",
                        FOCUS
                    )}
                >
                    <span className="w-3 text-center">+</span>New stage
                </button>
            ) : state.chunk == null ? (
                <input
                    autoFocus
                    value={state.name}
                    onChange={(e) => onChange({ name: e.target.value, chunk: null })}
                    onKeyDown={(e) => {
                        if (e.key === "Enter" && state.name.trim() !== "") {
                            onChange({ name: state.name.trim(), chunk: "" });
                        } else if (e.key === "Escape") {
                            e.stopPropagation();
                            onChange(null);
                        }
                    }}
                    placeholder="Stage name · enter, then add its first chunk"
                    className={cn(input, "w-full font-semibold")}
                />
            ) : (
                <input
                    autoFocus
                    value={state.chunk}
                    onChange={(e) => onChange({ name: state.name, chunk: e.target.value })}
                    onKeyDown={(e) => {
                        if (e.key === "Enter" && state.chunk?.trim()) {
                            onAdd(state.name, state.chunk.trim());
                            onChange(null);
                        } else if (e.key === "Escape") {
                            e.stopPropagation();
                            onChange(null);
                        }
                    }}
                    placeholder={`first chunk in ${state.name}`}
                    className={cn(input, "w-full")}
                />
            )}
        </div>
    );
}

function TrackerFooter({
    facts,
    edits,
    confirming,
    onConfirm,
}: {
    facts: Extract<DetailRow, { kind: "facts" }> | null;
    edits: TrackerEdits;
    confirming: boolean;
    onConfirm: (on: boolean) => void;
}) {
    const archived = edits.effortStatus === "archived";
    const action = (name: string, label: string, run: () => void, danger = false) => (
        <button
            type="button"
            data-jarvis-initiative-action={name}
            onClick={run}
            className={cn(SMALL_BUTTON, danger && "hover:border-error/50 hover:text-error", FOCUS)}
        >
            {label}
        </button>
    );
    return (
        <div className="mt-3 flex flex-wrap items-center gap-x-2.5 gap-y-1.5 border-t border-edge-faint px-1.5 pt-2.5 font-mono text-[10.5px] text-muted">
            {/* the id is what you paste into a prompt or a `wsh effort` call, and a span is the one
                thing you cannot lift out of a row you can click */}
            <button
                type="button"
                title="copy this initiative's id"
                onClick={() => void navigator.clipboard?.writeText(edits.oid)}
                className={cn("cursor-pointer hover:text-ink-hi", FOCUS)}
            >
                {edits.oid}
            </button>
            {facts != null ? <span>{facts.count}</span> : null}
            {confirming ? (
                <span
                    data-jarvis-delete-confirm
                    className="ml-auto flex items-center gap-2 rounded-[7px] border border-error/40 bg-error/10 py-[3px] pl-2.5 pr-1"
                >
                    <span className="font-sans text-[11.5px] text-error">
                        Delete this initiative, its {edits.total} chunks and their notes?
                    </span>
                    <button type="button" onClick={() => onConfirm(false)} className={cn(SMALL_BUTTON, FOCUS)}>
                        cancel
                    </button>
                    <button
                        type="button"
                        onClick={() => {
                            onConfirm(false);
                            edits.onDelete();
                        }}
                        className={cn(
                            "cursor-pointer rounded-[5px] bg-error px-[9px] py-[3px] font-bold text-background",
                            FOCUS
                        )}
                    >
                        delete
                    </button>
                </span>
            ) : (
                <span className="ml-auto flex items-center gap-1.5">
                    {action("rename", "rename", () => edits.onRename(edits.title))}
                    {action("details", "details", edits.onDetails)}
                    {archived
                        ? action("unarchive", "unarchive", edits.onUnarchive)
                        : action("pause", edits.effortStatus === "paused" ? "resume" : "pause", edits.onTogglePause)}
                    {archived ? null : action("archive", "archive", edits.onArchive, true)}
                    {action("delete", "delete", () => onConfirm(true), true)}
                </span>
            )}
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
