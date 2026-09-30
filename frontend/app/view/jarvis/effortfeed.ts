// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// An initiative's notes as one newest-first feed. The effort keeps two logs: every chunk's note trail,
// which records everything down to renames and stage moves, and the events list, which the backend keeps
// for "what changed that matters". The feed reads the events, so bookkeeping never reaches it. feedGroups
// lays the feed out for reading: day dividers, a heading per chunk within a day, one line per entry.
//
// An event names its chunk by whatever ref its writer passed: a label, a 1-based index, or a label renamed
// since. Events written before effortops stored the resolved label still carry those, but each one shares
// its timestamp with the note written onto the chunk itself, and that note is what locates it.
//
// Pure: no React, no Wave runtime imports.

import { chunkTone, type ChunkTone } from "./effortmodel";

export const FEED_PAGE = 25;

const FEED_KINDS = new Set(["effort-note", "chunk-status", "chunk-done", "chunk-added"]);
const STATUS_NOTE = /^marked (\w+)(?: · ([\s\S]*))?$/;
const HEADLINE_MAX = 180;
const SAME_DAY_PREFIX = /^(\d{4}-\d{2}-\d{2}):?\s+/;
// paths, bare filenames, backtick spans and commit-like hex ids
const CODE_TOKEN =
    /`[^`]+`|(?:[\w.%-]+\/)*[\w-][\w.-]*\.(?:go|tsx?|mjs|md|py|sql|json|css|html)\b|\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{8,40}\b/g;

export type FeedEntry = {
    // the event's index in effort.events: the list only appends, so this keys an entry across refreshes
    seq: number;
    ts: number;
    kind: string;
    chunk: string;
    status: string;
    marked: string;
    text: string;
    // effort-note entries located on their chunk: the note's 1-based place in that chunk's trail, the
    // key editNote/removeNote take. Absent means read-only.
    noteAt?: number;
    edited?: boolean;
    author?: string;
    session?: string;
    run?: string;
};

type LocatedNote = EffortNote & { chunk: EffortChunk; at: number };

export function effortFeed(effort: Effort): FeedEntry[] {
    const chunks = effort.chunks ?? [];
    const notes: LocatedNote[] = chunks.flatMap((chunk) =>
        (chunk.notes ?? []).map((n, i) => ({ ...n, chunk, at: i + 1 }))
    );
    const used = new Set<LocatedNote>();
    const suffix = (n: LocatedNote) => STATUS_NOTE.exec(n.text)?.[2] ?? "";

    const locate = (ev: EffortEvent): LocatedNote | undefined => {
        const status = ev.kind !== "effort-note";
        const text = ev.text ?? "";
        const hits = notes.filter(
            (n) => !used.has(n) && n.ts === ev.ts && (status ? STATUS_NOTE.test(n.text) : n.text === text)
        );
        const pick = (cands: LocatedNote[]) => (status ? cands.find((n) => suffix(n) === text) : cands[0]);
        // one batch can mark several chunks alike at the same instant, so the chunk the event names goes
        // first; a lone candidate stands even when its note differs, because the advance path used to drop
        // the note from the event while writing it onto the chunk
        return (
            pick(hits.filter((n) => n.chunk.label === ev.label)) ??
            pick(hits) ??
            (hits.length === 1 ? hits[0] : undefined)
        );
    };
    const byLabel = (label: string) =>
        chunks.find((c) => c.label === label) ??
        chunks.find((c) => (c.notes ?? []).some((n) => n.text === "renamed from " + label));

    const entries = (effort.events ?? []).flatMap((ev, seq): FeedEntry[] => {
        if (!FEED_KINDS.has(ev.kind)) {
            return [];
        }
        const label = ev.label ?? "";
        const note = ev.kind === "chunk-added" ? undefined : locate(ev);
        if (note != null) {
            used.add(note);
        }
        const chunk = note?.chunk ?? byLabel(label);
        const m = note != null && ev.kind !== "effort-note" ? STATUS_NOTE.exec(note.text) : null;
        return [
            {
                seq,
                ts: ev.ts,
                kind: ev.kind,
                chunk: chunk?.label ?? (/^\d+$/.test(label) ? "removed chunk" : label),
                status: chunk?.status ?? "removed",
                marked:
                    ev.kind === "chunk-added"
                        ? "chunk added"
                        : m != null
                          ? "marked " + m[1]
                          : ev.kind === "chunk-done"
                            ? "marked done"
                            : ev.kind === "chunk-status"
                              ? "status changed"
                              : "",
                text: m != null ? (m[2] ?? "") : (ev.text ?? ""),
                ...(ev.kind === "effort-note" && note != null ? { noteAt: note.at, edited: note.edited === true } : {}),
                // only what the note carries: a legacy note has no author and reads that way
                ...(note?.author ? { author: note.author } : {}),
                ...(note?.session ? { session: note.session } : {}),
                ...(note?.run ? { run: note.run } : {}),
            },
        ];
    });
    // reversed first so a batch sharing one timestamp still reads newest-written first
    return entries.reverse().sort((a, b) => b.ts - a.ts);
}

const pad2 = (n: number) => String(n).padStart(2, "0");
const localDay = (ts: number) => {
    const d = new Date(ts);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
};

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function clock(ts: number): string {
    const d = new Date(ts);
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

// today's entries read by time of day, older ones by date
export function stamp(ts: number, now: number): string {
    return localDay(ts) === localDay(now) ? clock(ts) : localDay(ts).slice(5);
}

// the divider above a day's entries; the time column then needs only the time of day
export function dayLabel(ts: number, now: number): string {
    const d = new Date(ts);
    const date = `${WEEKDAY[d.getDay()]} ${d.getDate()} ${MONTH[d.getMonth()]}`;
    if (localDay(ts) === localDay(now)) {
        return "Today";
    }
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    return localDay(ts) === localDay(yesterday.getTime()) ? "Yesterday · " + date : date;
}

// a leading date that repeats the note's own timestamp says nothing the stamp column doesn't
export function noteBody(note: { ts: number; text: string }): string {
    const m = note.text.match(SAME_DAY_PREFIX);
    return m != null && m[1] === localDay(note.ts) ? note.text.slice(m[0].length) : note.text;
}

// long notes lead with their outcome, so the first sentence stands in for the whole note
export function headline(body: string): string {
    const m = body.match(/^[\s\S]*?[.;](?=\s|$)/);
    const head = (m != null ? m[0] : body).trim();
    if (head.length <= HEADLINE_MAX) {
        return head;
    }
    const cut = head.lastIndexOf(" ", HEADLINE_MAX);
    return head.slice(0, cut > 0 ? cut : HEADLINE_MAX) + "…";
}

export type CodeSegment = { text: string; code: boolean };

export function codeSegments(text: string): CodeSegment[] {
    const segs: CodeSegment[] = [];
    let last = 0;
    for (const m of text.matchAll(CODE_TOKEN)) {
        const at = m.index ?? 0;
        if (at > last) {
            segs.push({ text: text.slice(last, at), code: false });
        }
        segs.push({ text: m[0].replace(/^`|`$/g, ""), code: true });
        last = at + m[0].length;
    }
    if (last < text.length) {
        segs.push({ text: text.slice(last), code: false });
    }
    return segs;
}

export type Paragraph = { level: 0 | 1 | 2; segs: CodeSegment[] };

// notes arrive as single paragraphs that enumerate inline as "(1) … (2) …", sometimes nesting "(a) … (b) …"
export function paragraphs(body: string): Paragraph[] {
    return body
        .split(/\n+/)
        .flatMap((para) => para.split(/\s(?=\((?:\d+|[a-h])\)\s)/))
        .map((text) => text.trim())
        .filter((text) => text !== "")
        .map((text) => ({
            level: /^\(\d+\)\s/.test(text) ? 1 : /^\([a-h]\)\s/.test(text) ? 2 : 0,
            segs: codeSegments(text),
        }));
}

// a chunk added, or a status change with nothing written: the event itself is all there is to read
const isBookkeeping = (e: FeedEntry) => e.kind === "chunk-added" || (e.kind !== "effort-note" && e.text === "");

// the status a "marked X" entry moved its chunk to, drawn as a pill; any other entry has none
const markTone = (e: FeedEntry): ChunkTone | null =>
    e.marked.startsWith("marked ") ? chunkTone(e.marked.slice(7)) : null;

// "removed" is the feed's word for a chunk the plan no longer holds; it reads as skipped
const headTone = (status: string): ChunkTone => (status === "removed" ? "skipped" : chunkTone(status));

export type FeedGroupRow =
    | { kind: "day"; key: string; label: string }
    // added: the time the chunk was added that day, folded out of the stream because it carries nothing to read
    | { kind: "head"; key: string; chunk: string; status: string; tone: ChunkTone; added: string }
    | {
          kind: "note";
          key: string;
          entry: FeedEntry;
          time: string;
          mark: ChunkTone | null;
          head: string;
          body: string;
      }
    | { kind: "event"; key: string; entry: FeedEntry; time: string; text: string; mark: ChunkTone | null };

/**
 * The feed as a reader scans it: a divider per local day, and inside a day one group per chunk, the groups
 * ordered by their newest entry. The stream interleaves chunks, so grouping is what stops every line from
 * needing its own chunk tag. Under "only" the chunk is already named, so no headings, and a chunk added
 * stays a line of its own rather than folding into one.
 */
export function feedGroups(
    feed: FeedEntry[],
    opts: { only: string | null; limit: number; now: number }
): { rows: FeedGroupRow[]; left: number } {
    const entries = opts.only == null ? feed : feed.filter((e) => e.chunk === opts.only);
    const page = entries.slice(0, opts.limit);
    const rows: FeedGroupRow[] = [];
    const days = [...new Set(page.map((e) => localDay(e.ts)))];
    for (const day of days) {
        const inDay = page.filter((e) => localDay(e.ts) === day);
        rows.push({ kind: "day", key: "day:" + day, label: dayLabel(inDay[0].ts, opts.now) });
        for (const chunk of [...new Set(inDay.map((e) => e.chunk))]) {
            let items = inDay.filter((e) => e.chunk === chunk);
            if (opts.only == null) {
                const added = items.find((e) => e.kind === "chunk-added");
                items = items.filter((e) => e.kind !== "chunk-added");
                const status = (items[0] ?? added).status;
                rows.push({
                    kind: "head",
                    key: `head:${day}:${chunk}`,
                    chunk,
                    status,
                    tone: headTone(status),
                    added: added != null ? clock(added.ts) : "",
                });
            }
            for (const e of items) {
                const key = String(e.seq);
                if (isBookkeeping(e)) {
                    rows.push({ kind: "event", key, entry: e, time: clock(e.ts), text: e.marked, mark: markTone(e) });
                    continue;
                }
                const body = noteBody(e);
                rows.push({
                    kind: "note",
                    key,
                    entry: e,
                    time: clock(e.ts),
                    mark: markTone(e),
                    head: headline(body),
                    body,
                });
            }
        }
    }
    return { rows, left: Math.max(0, entries.length - opts.limit) };
}

export function kilo(n: number): string {
    return n < 1000 ? String(n) : (n / 1000).toFixed(1) + "k";
}

export function feedNoteCounts(feed: FeedEntry[]): Map<string, number> {
    const counts = new Map<string, number>();
    for (const e of feed) {
        if (e.text !== "") {
            counts.set(e.chunk, (counts.get(e.chunk) ?? 0) + 1);
        }
    }
    return counts;
}
