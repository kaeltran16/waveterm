// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// An initiative's notes as one newest-first feed. The effort keeps two logs: every chunk's note trail,
// which records everything down to renames and stage moves, and the events list, which the backend keeps
// for "what changed that matters". The feed reads the events, so bookkeeping never reaches it.
//
// An event names its chunk by whatever ref its writer passed: a label, a 1-based index, or a label renamed
// since. Events written before effortops stored the resolved label still carry those, but each one shares
// its timestamp with the note written onto the chunk itself, and that note is what locates it.
//
// Pure: no React, no Wave runtime imports.

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

// today's entries read by time of day, older ones by date
export function stamp(ts: number, now: number): string {
    const d = new Date(ts);
    return localDay(ts) === localDay(now) ? `${pad2(d.getHours())}:${pad2(d.getMinutes())}` : localDay(ts).slice(5);
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

export type FeedRow = {
    key: string;
    entry: FeedEntry;
    // blank when it repeats the stamp above, unless a chunk tag starts a new run here
    day: string;
    tagged: boolean;
    spaced: boolean;
    head: string;
    body: string;
    // characters the headline leaves out; zero means the row has nothing to expand
    extra: number;
};

export function feedRows(
    feed: FeedEntry[],
    opts: { only: string | null; limit: number; now: number }
): { rows: FeedRow[]; left: number; newestKey: string | null } {
    const entries = opts.only == null ? feed : feed.filter((e) => e.chunk === opts.only);
    const newest = entries.find((e) => e.text !== "");
    const rows: FeedRow[] = [];
    let prevChunk: string | null = null;
    let prevDay: string | null = null;
    entries.slice(0, opts.limit).forEach((e, i) => {
        // an added chunk has nothing to read but its name, so the name is the line and no tag sits above it
        const added = e.kind === "chunk-added";
        const body = added ? (opts.only == null ? e.chunk : "") : noteBody(e);
        const head = added ? body : headline(body);
        const day = stamp(e.ts, opts.now);
        const tagged = opts.only == null && !added && e.chunk !== prevChunk;
        rows.push({
            key: String(e.seq),
            entry: e,
            day: tagged || day !== prevDay ? day : "",
            tagged,
            spaced: i > 0 && (tagged || (added && prevChunk != null)),
            head,
            body,
            extra: body.length - head.length,
        });
        prevChunk = added ? null : e.chunk;
        prevDay = day;
    });
    return {
        rows,
        left: Math.max(0, entries.length - opts.limit),
        newestKey: newest != null ? String(newest.seq) : null,
    };
}

// the size hint on a folded note
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
