// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// An initiative's ACTIVITY: one newest-first feed over the effort's events, with each run of notes tagged
// by its chunk (effortfeed.ts), under the facts as one quiet line.
//
// This is no longer how an initiative is opened. The Brief expands it in place and the plan, its chunks and
// their per-chunk note trails live there (inlinetracker.ts) — so the plan section that used to fold below
// this feed is gone rather than kept in sync with a second copy of itself. What is left is the escape
// hatch the inline tracker links to as "initiative activity": every note on every chunk, in one stream,
// which the per-chunk sidebar deliberately does not show.

import { formatAge } from "@/app/view/agents/agentsviewmodel";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { Fragment, useEffect, useMemo, useState } from "react";
import { briefingStateAtom } from "./briefingstore";
import { effortFeed, FEED_PAGE, feedRows, kilo, paragraphs, type FeedEntry, type FeedRow } from "./effortfeed";
import { chunkTone, effortFacts, type ChunkTone } from "./effortmodel";
import { effortDetailAtom, loadEffortDetail } from "./effortstore";
import { activeSubjectAtom } from "./jarvissubjectstore";
import { STAGE_SCROLLER } from "./stagemeasure";

const FOCUS = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";
const SECTION_LABEL = "font-mono text-[9.5px] font-semibold uppercase tracking-[.13em] text-feed-label";

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

export function EffortDetailView() {
    const subject = useAtomValue(activeSubjectAtom);
    const cache = useAtomValue(effortDetailAtom);
    const briefing = useAtomValue(briefingStateAtom);
    const oref = subject?.kind === "effort" ? "effort:" + subject.id : null;
    const effort = oref != null ? (cache.get(oref) ?? null) : null;
    // the one list holding every effort: the freshest updatedts the app knows, and the parent and children
    const summaries = briefing.snapshot?.state.efforts;
    const freshTs = summaries?.find((e) => e.oref === oref)?.updatedts;
    const [error, setError] = useState<string | null>(null);
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

    const retry = (): void => {
        if (oref == null) {
            return;
        }
        setError(null);
        void loadEffortDetail(oref, freshTs).catch((e) => setError(e instanceof Error ? e.message : String(e)));
    };

    const facts = effort != null ? effortFacts(effort, summaries ?? []) : null;

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
                        {["title", "facts", "notes"].map((k) => (
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
                        <NotesFeed key={"notes:" + effort.oid} feed={feed} />
                    </>
                ) : null}
            </div>
        </div>
    );
}
