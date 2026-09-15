// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The initiative sheet. The notes are what an initiative is opened to read, so they lead: one newest-first
// feed over the effort's events with each run of notes tagged by its chunk (effortfeed.ts). The facts sit
// under the title as one quiet line, and the plan, with every edit the chunks take, folds below the feed:
// one click away, never standing between the reader and the notes.

import type { AgentsViewModel } from "@/app/view/agents/agents";
import { formatAge } from "@/app/view/agents/agentsviewmodel";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { Fragment, useEffect, useId, useMemo, useState } from "react";
import { briefingStateAtom } from "./briefingstore";
import {
    effortFeed,
    FEED_PAGE,
    feedNoteCounts,
    feedRows,
    kilo,
    paragraphs,
    type FeedEntry,
    type FeedRow,
} from "./effortfeed";
import { chunkTone, effortFacts, groupChunksByStage, nextChunk, stageOptions, type ChunkTone } from "./effortmodel";
import {
    addChunkOp,
    advanceChunk,
    appendChunkNote,
    effortChunkRows,
    effortDetailAtom,
    loadEffortDetail,
    reopenChunk,
    setChunkStage,
    setEffortStatus,
    type ChunkRowModel,
} from "./effortstore";
import { activeSubjectAtom } from "./jarvissubjectstore";
import { STAGE_SCROLLER } from "./stagemeasure";

const FOCUS = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";
const SECTION_LABEL = "font-mono text-[9.5px] font-semibold uppercase tracking-[.13em] text-feed-label";
const SMALL_BUTTON = `cursor-pointer rounded-[6px] border border-border px-2 py-[3px] font-mono text-[10px] text-muted hover:text-primary ${FOCUS}`;

// "removed" is the feed's word for a chunk the plan no longer holds
const STATUS_FG: Record<ChunkTone | "removed", string> = {
    done: "text-success",
    active: "text-accent",
    blocked: "text-asking",
    deferred: "text-ink-mid",
    skipped: "text-ink-faint",
    pending: "text-muted",
    removed: "text-ink-faint",
};
const statusFg = (status: string) => (status === "removed" ? STATUS_FG.removed : STATUS_FG[chunkTone(status)]);

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

// Row controls reveal on hover but stay IN FLOW: `hidden` -> `group-hover:block` reflowed the row
// (measured at 118.7px of label shrink), which reads as a jitter under the cursor. Opacity also
// keeps them focusable — a display:none button cannot be tabbed to.
const REVEAL_ON_HOVER =
    "opacity-0 transition-opacity duration-[140ms] group-hover:opacity-100 focus-visible:opacity-100";

// The one stage editor, shared by the header and the per-row tag. The datalist turns "put this chunk
// in a stage that already exists" into a pick; typing a fresh name starts a new run; empty clears.
// No blur handler, matching the chunk/note inputs below: Enter commits, Escape cancels.
function StageInput({
    value,
    options,
    onCommit,
    onCancel,
}: {
    value: string;
    options: string[];
    onCommit: (stage: string) => void;
    onCancel: () => void;
}) {
    const [draft, setDraft] = useState(value);
    const listId = useId();
    return (
        <>
            <input
                autoFocus
                list={listId}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === "Enter") {
                        onCommit(draft.trim());
                    } else if (e.key === "Escape") {
                        onCancel();
                    }
                }}
                placeholder="stage name (empty clears)"
                className="w-44 flex-none rounded-[7px] border border-edge-mid bg-background px-2 py-[2px] text-[12px] text-primary outline-none focus:border-accent/60"
            />
            <datalist id={listId}>
                {options.map((o) => (
                    <option key={o} value={o} />
                ))}
            </datalist>
        </>
    );
}

// The line above a run of chunks, wearing the cockpit's group-header chrome: mono uppercase tracked
// label, count pill, hairline rule. A stage is the same kind of thing as a region heading, so it reads
// as one rather than as a label smaller than its own children.
//
// Unstaged runs get a "+ stage" in the same slot: it names the whole run in one gesture, and it is
// the only always-visible way in — without it stages are a CLI-only secret.
//
// A header is a divider, not a container: the rows under it stay in the same flat list, each keeping
// its own status and its own right to block. It carries no progress bar on purpose — the plan's
// header already owns the count, and a second bar reads as a second denominator.
function StageHeader({
    stage,
    fraction,
    options,
    onCommit,
}: {
    stage: string;
    fraction: string;
    options: string[];
    onCommit: (stage: string) => void;
}) {
    const [editing, setEditing] = useState(false);
    // a commit that changes nothing would still stamp "stage set to X" on every chunk in the run.
    const commit = (next: string): void => {
        setEditing(false);
        if (next !== stage) {
            onCommit(next);
        }
    };
    return (
        <div className="flex items-center gap-2 px-1.5 pb-1 pt-[9px]">
            {editing ? (
                <StageInput value={stage} options={options} onCommit={commit} onCancel={() => setEditing(false)} />
            ) : (
                <button
                    type="button"
                    title={
                        stage === ""
                            ? "name this run of chunks as a stage"
                            : "rename this stage — every chunk under it moves together; empty clears it"
                    }
                    onClick={() => setEditing(true)}
                    className={cn(
                        "min-w-0 cursor-pointer truncate font-mono text-[9.5px] font-bold uppercase tracking-[.12em]",
                        FOCUS,
                        stage === "" ? "text-muted hover:text-secondary" : "text-feed-label hover:text-secondary"
                    )}
                >
                    {stage === "" ? "+ stage" : stage}
                </button>
            )}
            {stage !== "" ? (
                <span className="flex-none rounded-full border border-edge-faint bg-surface-raised px-2 py-[1px] font-mono text-[9.5px] font-semibold text-muted">
                    {fraction}
                </span>
            ) : null}
            <span className="h-px min-w-3 flex-1 bg-edge-faint" />
        </div>
    );
}

// The per-chunk stage control, hover-revealed like `reopen` so the row stays quiet. It means "a stage
// STARTS here": it claims this chunk and the rest of its run, leaving the next run alone. That is what
// makes repeated use subdivide a flat plan — each click trims the stage the previous click set,
// so three clicks cut fourteen chunks into three stages instead of fourteen edits.
//
// The header is the other half: it renames the run it sits on, whole. Both write setChunkStage.
function StageTag({
    stage,
    options,
    onCommit,
}: {
    stage: string;
    options: string[];
    onCommit: (stage: string) => void;
}) {
    const [editing, setEditing] = useState(false);
    if (editing) {
        return (
            <StageInput
                value={stage}
                options={options}
                onCommit={(next) => {
                    setEditing(false);
                    if (next !== stage) {
                        onCommit(next);
                    }
                }}
                onCancel={() => setEditing(false)}
            />
        );
    }
    return (
        <button
            type="button"
            title={
                stage === ""
                    ? "start a stage here — claims this chunk and the rest of its run"
                    : "stage: " + stage + " — start a different stage from here down"
            }
            onClick={() => setEditing(true)}
            className={cn(
                "flex-none cursor-pointer rounded-[6px] border border-border px-2 py-[3px] font-mono text-[9.5px] text-muted hover:text-primary",
                FOCUS,
                REVEAL_ON_HOVER
            )}
        >
            stage
        </button>
    );
}

// a workref names who is on the chunk: the agent's name when the roster knows the tab, else the oref.
function workrefLabel(ref: ChunkWorkRef, agents: { id: string; name: string }[]): string {
    if (ref.kind === "agent") {
        const tabid = ref.oref.replace(/^agent:/, "");
        const name = agents.find((a) => a.id === tabid)?.name;
        return name != null ? `${name} working here` : ref.oref;
    }
    return ref.oref;
}

function NoteParagraphs({ body }: { body: string }) {
    return (
        <>
            {paragraphs(body).map((p, i) => (
                <span key={i} className={cn("block", p.level === 1 && "pl-[14px]", p.level === 2 && "pl-[28px]")}>
                    {p.segs.map((s, j) =>
                        s.code ? (
                            <span key={j} className="font-mono text-[11.5px] text-accent-soft">
                                {s.text}
                            </span>
                        ) : (
                            <Fragment key={j}>{s.text}</Fragment>
                        )
                    )}
                </span>
            ))}
        </>
    );
}

function FeedLine({
    row,
    open,
    onToggle,
    onTag,
}: {
    row: FeedRow;
    open: boolean;
    onToggle: () => void;
    onTag: () => void;
}) {
    const e = row.entry;
    const expandable = row.extra > 0;
    const marked = e.marked !== "" ? <span className="font-mono text-[10.5px] text-muted">{e.marked}</span> : null;
    return (
        <div
            data-jarvis-effort-note={row.key}
            className={cn("flex items-start gap-2.5 pb-[3px]", row.spaced ? "pt-3" : "pt-[3px]")}
        >
            <button
                type="button"
                onClick={onToggle}
                disabled={!expandable}
                aria-expanded={expandable ? open : undefined}
                aria-label={expandable ? (open ? "Fold note" : "Expand note") : undefined}
                className={cn(
                    "w-[52px] flex-none cursor-pointer pt-px text-left font-mono text-[10px] text-ink-faint disabled:cursor-default",
                    FOCUS
                )}
            >
                {expandable ? (open ? "▾ " : "▸ ") : ""}
                {row.day}
            </button>
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                {row.tagged ? (
                    <button
                        type="button"
                        onClick={onTag}
                        title="Show only this chunk"
                        className={cn("flex min-w-0 cursor-pointer items-baseline gap-2 text-left", FOCUS)}
                    >
                        <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] font-medium text-muted">
                            {e.chunk}
                        </span>
                        <span
                            className={cn("flex-none font-mono text-[9px] font-semibold uppercase", statusFg(e.status))}
                        >
                            {e.status}
                        </span>
                    </button>
                ) : null}
                {open ? (
                    <div className="flex flex-col gap-1.5 text-[12.5px] leading-[1.65] text-secondary">
                        {marked}
                        <NoteParagraphs body={row.body} />
                    </div>
                ) : (
                    // the day button is the keyboard's way in; the text takes a click too because it is the
                    // bigger target
                    <span
                        onClick={expandable ? onToggle : undefined}
                        className={cn("text-[12.5px] leading-[1.55] text-ink-mid", expandable && "cursor-pointer")}
                    >
                        {marked}
                        {marked != null && row.head !== "" ? " " : ""}
                        {row.head}
                        {expandable ? (
                            <span className="font-mono text-[10px] text-ink-faint"> {kilo(row.extra)} more</span>
                        ) : null}
                    </span>
                )}
            </div>
        </div>
    );
}

function NotesFeed({ feed }: { feed: FeedEntry[] }) {
    const [only, setOnly] = useState<string | null>(null);
    const [limit, setLimit] = useState(FEED_PAGE);
    const [opened, setOpened] = useState<Record<string, boolean>>({});
    const { rows, left, newestKey } = feedRows(feed, { only, limit, now: Date.now() });
    const notes = feed.filter((e) => e.text !== "").length;
    return (
        <section data-jarvis-effort-section="notes" className="flex flex-col">
            <div className="flex items-baseline gap-2.5 pb-1.5">
                <span className={SECTION_LABEL}>Notes</span>
                <span className="font-mono text-[10px] text-ink-faint">
                    {feed.length === 0 ? "none yet" : `${plural(notes, "note")} · newest first`}
                </span>
            </div>
            {only != null ? (
                <div className="flex items-baseline gap-2 pb-1.5 pt-0.5">
                    <span className="flex-none font-mono text-[10px] text-ink-faint">only</span>
                    <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] font-medium text-secondary">
                        {only}
                    </span>
                    <button
                        type="button"
                        onClick={() => setOnly(null)}
                        className={cn(
                            "flex-none cursor-pointer font-mono text-[10px] text-accent hover:text-accenthover",
                            FOCUS
                        )}
                    >
                        show all
                    </button>
                </div>
            ) : null}
            {rows.map((row) => {
                // the newest note is the one the record was opened to read
                const open = row.extra > 0 && (opened[row.key] ?? row.key === newestKey);
                return (
                    <FeedLine
                        key={row.key}
                        row={row}
                        open={open}
                        onToggle={() => setOpened({ ...opened, [row.key]: !open })}
                        onTag={() => setOnly(row.entry.chunk)}
                    />
                );
            })}
            {left > 0 ? (
                <button
                    type="button"
                    onClick={() => setLimit(limit + FEED_PAGE)}
                    className={cn(
                        "ml-[62px] mt-2.5 cursor-pointer self-start rounded-[6px] border border-border px-2.5 py-1 font-mono text-[10px] text-ink-mid hover:text-ink-hi",
                        FOCUS
                    )}
                >
                    Show {Math.min(left, FEED_PAGE)} older · {left} left
                </button>
            ) : null}
        </section>
    );
}

function PlanChunk({
    row,
    next,
    notes,
    agents,
    options,
    onReopen,
    onStage,
}: {
    row: ChunkRowModel;
    next: boolean;
    notes: number;
    agents: { id: string; name: string }[];
    options: string[];
    onReopen: () => void;
    onStage: (stage: string) => void;
}) {
    return (
        <div className="group flex flex-col py-0.5">
            <div className="flex items-baseline gap-2">
                <span
                    className={cn("min-w-0 flex-1 text-[12px] leading-[1.45]", next ? "text-accent" : "text-secondary")}
                >
                    {row.label}
                </span>
                <StageTag stage={row.stage} options={options} onCommit={onStage} />
                {row.status === "done" ? (
                    <button type="button" onClick={onReopen} className={cn(SMALL_BUTTON, "flex-none", REVEAL_ON_HOVER)}>
                        reopen
                    </button>
                ) : null}
                {notes > 0 ? (
                    <span className="flex-none font-mono text-[10px] text-ink-faint">{plural(notes, "note")}</span>
                ) : null}
                <span
                    className={cn(
                        "w-[62px] flex-none text-right font-mono text-[9px] font-semibold uppercase",
                        statusFg(row.status)
                    )}
                >
                    {row.status}
                </span>
            </div>
            {row.owner != null ? <span className="font-mono text-[10px] text-muted">owner: {row.owner}</span> : null}
            {row.workrefs.map((w) => (
                <span key={w.oref} title={w.oref} className="font-mono text-[10px] text-accent-soft">
                    {workrefLabel(w, agents)} · {formatAge(Date.now() - w.ts)}
                </span>
            ))}
        </div>
    );
}

function PlanSection({
    effort,
    feed,
    agents,
    onMutate,
}: {
    effort: Effort;
    feed: FeedEntry[];
    agents: { id: string; name: string }[];
    onMutate: (fn: () => Promise<void>) => void;
}) {
    const [open, setOpen] = useState(false);
    const [adding, setAdding] = useState(false);
    const [draft, setDraft] = useState("");
    const oref = "effort:" + effort.oid;
    const rows = effortChunkRows(effort);
    const options = stageOptions(rows);
    const counts = feedNoteCounts(feed);
    const next = nextChunk(rows)?.label;
    const done = rows.filter((r) => r.status === "done").length;
    const skipped = rows.filter((r) => r.status === "skipped").length;

    const submitChunk = (): void => {
        const label = draft.trim();
        if (label === "") {
            return;
        }
        setDraft("");
        setAdding(false);
        onMutate(() => addChunkOp(oref, label));
    };

    return (
        <section data-jarvis-effort-section="plan" className="flex flex-col border-t border-edge-faint">
            <button
                type="button"
                aria-expanded={open}
                onClick={() => setOpen(!open)}
                className={cn("flex w-full cursor-pointer items-baseline gap-2 pb-1.5 pt-2.5 text-left", FOCUS)}
            >
                <span className="w-2.5 flex-none font-mono text-[10px] text-muted">{open ? "▾" : "▸"}</span>
                <span className={SECTION_LABEL}>Plan</span>
                <span className="font-mono text-[10px] text-ink-faint">
                    {done} of {plural(rows.length - skipped, "chunk")} done
                </span>
            </button>
            {open ? (
                <div className="flex flex-col pl-[18px]">
                    {groupChunksByStage(rows).map((g, gi) => (
                        <div key={g.stage + ":" + gi} className="flex flex-col">
                            {/* every run gets a header: an unstaged one renders as "+ stage", which both
                                separates it and is the way to name it. */}
                            <StageHeader
                                stage={g.stage}
                                fraction={g.fraction}
                                options={options}
                                onCommit={(stage) =>
                                    onMutate(() =>
                                        setChunkStage(
                                            oref,
                                            g.rows.map((r) => r.label),
                                            stage
                                        )
                                    )
                                }
                            />
                            {g.rows.map((r, i) => (
                                <PlanChunk
                                    key={r.label}
                                    row={r}
                                    next={r.label === next}
                                    notes={counts.get(r.label) ?? 0}
                                    agents={agents}
                                    options={options}
                                    onReopen={() => onMutate(() => reopenChunk(oref, r.label))}
                                    // the run tail: this chunk down to the next stage boundary
                                    onStage={(stage) =>
                                        onMutate(() =>
                                            setChunkStage(
                                                oref,
                                                g.rows.slice(i).map((x) => x.label),
                                                stage
                                            )
                                        )
                                    }
                                />
                            ))}
                        </div>
                    ))}
                    <div className="flex flex-wrap items-center gap-2 pb-1 pt-2.5">
                        {adding ? (
                            <input
                                autoFocus
                                value={draft}
                                onChange={(e) => setDraft(e.target.value)}
                                onKeyDown={(e) => {
                                    if (e.key === "Enter") {
                                        submitChunk();
                                    } else if (e.key === "Escape") {
                                        setAdding(false);
                                        setDraft("");
                                    }
                                }}
                                placeholder="chunk label"
                                className="w-56 rounded-[7px] border border-edge-mid bg-background px-2 py-1 text-[12px] text-primary outline-none focus:border-accent/60"
                            />
                        ) : (
                            <button type="button" onClick={() => setAdding(true)} className={SMALL_BUTTON}>
                                + chunk
                            </button>
                        )}
                        <button
                            type="button"
                            title="copy the CLI handle"
                            onClick={() => void navigator.clipboard.writeText("wsh effort show " + effort.oid)}
                            className={cn("cursor-pointer font-mono text-[9.5px] text-muted hover:text-primary", FOCUS)}
                        >
                            wsh effort show {effort.oid}
                        </button>
                    </div>
                </div>
            ) : null}
        </section>
    );
}

export function EffortDetailView({ model }: { model: AgentsViewModel }) {
    const subject = useAtomValue(activeSubjectAtom);
    const cache = useAtomValue(effortDetailAtom);
    const agents = useAtomValue(model.agentsAtom);
    const briefing = useAtomValue(briefingStateAtom);
    const oref = subject?.kind === "effort" ? "effort:" + subject.id : null;
    const effort = oref != null ? (cache.get(oref) ?? null) : null;
    // the one list holding every effort: the freshest updatedts the app knows, and the parent and children
    const summaries = briefing.snapshot?.state.efforts;
    const freshTs = summaries?.find((e) => e.oref === oref)?.updatedts;
    const [error, setError] = useState<string | null>(null);
    const [noting, setNoting] = useState(false);
    const [noteDraft, setNoteDraft] = useState("");
    const [mutateError, setMutateError] = useState<string | null>(null);
    const feed = useMemo(() => (effort != null ? effortFeed(effort) : []), [effort]);

    // the subject selection warms the cache; this effect covers direct mounts, retries, and an effort
    // ticked from outside the app — loadEffortDetail decides whether the cached copy still stands.
    useEffect(() => {
        if (oref == null) {
            return;
        }
        let cancelled = false;
        setError(null);
        loadEffortDetail(oref, freshTs).catch((e) => {
            if (!cancelled) {
                setError(e instanceof Error ? e.message : String(e));
            }
        });
        return () => {
            cancelled = true;
        };
    }, [oref, freshTs]);

    const runMutation = async (fn: () => Promise<void>): Promise<void> => {
        setMutateError(null);
        try {
            await fn();
        } catch (e) {
            setMutateError(e instanceof Error ? e.message : String(e));
        }
    };

    const retry = (): void => {
        if (oref == null) {
            return;
        }
        setError(null);
        void loadEffortDetail(oref, freshTs).catch((e) => setError(e instanceof Error ? e.message : String(e)));
    };

    const facts = effort != null ? effortFacts(effort, summaries ?? []) : null;
    const activeChunk = effort != null ? nextChunk(effort.chunks)?.label : undefined;

    const submitNote = (): void => {
        const text = noteDraft.trim();
        if (text === "" || oref == null) {
            return;
        }
        setNoteDraft("");
        setNoting(false);
        void runMutation(() => appendChunkNote(oref, activeChunk ?? null, text));
    };

    return (
        <div className={cn(STAGE_SCROLLER, "min-h-0 flex-1")} aria-live="polite">
            <div className="flex flex-col gap-[18px] px-5 py-[22px]">
                {error != null ? (
                    <div className="flex flex-col gap-2 rounded-[10px] border border-border bg-surface px-4 py-3">
                        <span className="text-[13px] font-semibold text-primary">Couldn't load this initiative.</span>
                        <span className="text-[12px] text-secondary">{error}</span>
                        <button
                            type="button"
                            onClick={retry}
                            className="mt-1 w-fit cursor-pointer rounded-[7px] border border-border bg-surface-raised px-2.5 py-1 text-[11px] font-semibold text-secondary hover:text-primary"
                        >
                            Retry
                        </button>
                    </div>
                ) : null}
                {effort == null && error == null ? (
                    <div className="flex flex-col gap-4">
                        {["title", "notes", "plan"].map((k) => (
                            <div
                                key={k}
                                className="h-10 animate-pulse rounded-[10px] bg-surface motion-reduce:animate-none"
                            />
                        ))}
                    </div>
                ) : null}
                {effort != null && facts != null ? (
                    <>
                        <div className="flex flex-col gap-2">
                            <span className="text-pretty text-[19px] font-semibold leading-[1.3] tracking-[-.01em] text-ink-hi">
                                {effort.title}
                            </span>
                            <div className="flex flex-wrap gap-x-3.5 gap-y-0.5 font-mono text-[10px] leading-[1.55] text-muted">
                                {[...facts.facts, ["updated", formatAge(Date.now() - effort.updatedts) + " ago"]].map(
                                    ([k, v], i) => (
                                        <span key={k + ":" + i}>
                                            <span className="text-ink-faint">{k}</span> {v}
                                        </span>
                                    )
                                )}
                            </div>
                        </div>
                        <span className="text-pretty text-[13px] leading-[1.6] text-ink-mid">{facts.next}</span>
                        <div className="flex flex-col gap-2">
                            <div className="flex flex-wrap items-center gap-2">
                                <button
                                    type="button"
                                    onClick={() => setNoting(!noting)}
                                    aria-expanded={noting}
                                    className={cn(
                                        "flex-none cursor-pointer rounded-[7px] border border-accent bg-accent px-3.5 py-1.5 text-[12px] font-semibold text-background hover:bg-accenthover",
                                        FOCUS
                                    )}
                                >
                                    Add note
                                </button>
                                <button
                                    type="button"
                                    disabled={activeChunk == null}
                                    onClick={() => void runMutation(() => advanceChunk("effort:" + effort.oid))}
                                    className={cn(
                                        "flex-none cursor-pointer rounded-[7px] border border-edge-strong px-3.5 py-1.5 text-[12px] font-semibold text-secondary hover:text-ink-hi disabled:cursor-default disabled:opacity-40",
                                        FOCUS
                                    )}
                                >
                                    Mark active chunk done
                                </button>
                                <span className="flex-1" />
                                {/* no confirm, as on the card this replaces: `wsh effort unarchive` is the way back */}
                                {effort.status !== "archived" ? (
                                    <button
                                        type="button"
                                        onClick={() =>
                                            void runMutation(() => setEffortStatus("effort:" + effort.oid, "archived"))
                                        }
                                        className={SMALL_BUTTON}
                                    >
                                        Archive
                                    </button>
                                ) : null}
                            </div>
                            {noting ? (
                                <input
                                    autoFocus
                                    value={noteDraft}
                                    onChange={(e) => setNoteDraft(e.target.value)}
                                    onKeyDown={(e) => {
                                        if (e.key === "Enter") {
                                            submitNote();
                                        } else if (e.key === "Escape") {
                                            setNoting(false);
                                            setNoteDraft("");
                                        }
                                    }}
                                    placeholder={
                                        activeChunk != null ? `note on ${activeChunk}` : "initiative-level note"
                                    }
                                    className="w-full rounded-[7px] border border-edge-mid bg-background px-2.5 py-1.5 text-[12.5px] text-primary outline-none focus:border-accent/60"
                                />
                            ) : null}
                            {mutateError != null ? <span className="text-[11px] text-error">{mutateError}</span> : null}
                        </div>
                        <NotesFeed key={"notes:" + effort.oid} feed={feed} />
                        <PlanSection
                            key={"plan:" + effort.oid}
                            effort={effort}
                            feed={feed}
                            agents={agents}
                            onMutate={(fn) => void runMutation(fn)}
                        />
                    </>
                ) : null}
            </div>
        </div>
    );
}
