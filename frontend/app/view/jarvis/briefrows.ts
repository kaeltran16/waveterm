// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The Brief's one-line rows. The regions used to draw four row shapes: a card per waiting item, the whole
// effort card per initiative, a session row and a past row. Each is now the same line: a kind or a progress
// bar, the title with a muted tail, a meta column and a state. A row opens its sheet in one click, which is
// where every action lives, so a line carries where it goes and nothing it could do in place.
//
// Pure: no React.

import { formatAge } from "@/app/view/agents/agentsviewmodel";
import {
    ACTIVE_CAP,
    mergeActiveWork,
    queueOpenTarget,
    SEVEN_DAYS_MS,
    type ActiveWorkRow,
    type AgentRow,
    type BlockerRow,
    type DeltaGroup,
    type DeltaRow,
    type QueueOpenTarget,
    type QueueRow,
    type RunRow,
    type ShippedRow,
} from "./briefingmodel";
import { headline, noteBody } from "./effortfeed";
import type { EffortCardModel } from "./effortmodel";

export type LineTone = "ok" | "active" | "asking" | "error" | "muted";
export type LineTarget = { queue: QueueOpenTarget } | { oref: string } | null;

export type BriefLine = {
    // region-prefixed: one object can sit in two regions, and j/k has to see both rows
    id: string;
    kind: string;
    kindTone: LineTone;
    title: string;
    note: string;
    meta: string;
    state: string;
    stateTone: LineTone;
    progress: { done: number; total: number; pct: number } | null;
    target: LineTarget;
};

export type LineGroup = { label: string; lines: BriefLine[] };

export const SHIPPED_LABEL = "Shipped · 7 days";

const age = (ts: number, now: number) => formatAge(now - ts);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const joined = (parts: (string | undefined)[]) => parts.filter((p) => p != null && p !== "").join(" · ");

export function queueLine(q: QueueRow, now: number): BriefLine {
    const tone: LineTone = q.tone === "error" ? "error" : "asking";
    const target = queueOpenTarget(q.nav);
    return {
        id: "waiting:" + q.key,
        kind: q.kind,
        kindTone: tone,
        title: q.title,
        note: q.why,
        meta: joined([q.attrib, q.detail]),
        state: q.ts != null ? age(q.ts, now) : "",
        stateTone: tone,
        progress: null,
        target: target != null ? { queue: target } : null,
    };
}

export function initiativeLine(card: EffortCardModel): BriefLine {
    const blocked = card.blockedChunks.length;
    // blocked first: it is the one state that is waiting on someone
    const [state, stateTone]: [string, LineTone] =
        blocked > 0
            ? [`${blocked} blocked`, "asking"]
            : card.activeTone === "deferred"
              ? ["deferred", "muted"]
              : [card.status, card.status === "paused" ? "muted" : "ok"];
    return {
        id: "initiatives:" + card.oref,
        kind: "",
        kindTone: "muted",
        title: card.title,
        // chunk labels run long as "<name> - <detail>"; the name is what fits beside a title
        note: card.activeChunk?.split(" - ")[0] ?? "",
        meta: joined([card.ticket, card.project || "no project"]),
        state,
        stateTone,
        progress: { done: card.done, total: card.done + card.remaining, pct: card.progressPct },
        target: { oref: card.oref },
    };
}

const needsEyes = (row: ActiveWorkRow) =>
    row.kind === "blocker" || row.chip?.tone === "blocked" || row.chip?.tone === "asking";
// a run that needs nothing from you reads by how long it has been quiet; anything else by its state
const isDated = (row: ActiveWorkRow) => row.kind === "run" && !needsEyes(row);
const isStale = (row: ActiveWorkRow, now: number) => isDated(row) && now - row.ts > SEVEN_DAYS_MS;

export function sessionLine(row: ActiveWorkRow, now: number): BriefLine & { stale: boolean } {
    const eyes = needsEyes(row);
    const running = row.chip?.tone === "running";
    const dated = isDated(row);
    return {
        id: "sessions:" + row.key,
        kind: (eyes ? "!" : running ? "▶" : "·") + " " + row.kind,
        kindTone: eyes ? "asking" : running ? "active" : "muted",
        title: row.name,
        note: "",
        meta: row.meta,
        state: dated ? age(row.ts, now) : (row.chip?.label ?? row.kind),
        stateTone: eyes ? "asking" : !dated && running ? "ok" : "muted",
        progress: null,
        // a run has a sheet; a blocker or a direct agent has none yet, so its row opens nothing
        target: row.kind === "run" ? { oref: row.oref } : null,
        stale: isStale(row, now),
    };
}

// The Sessions region's rows. Stale runs leave before the cap: capped first, a window full of week-quiet runs
// drew nothing but the fold, and its "+N more" only fed the fold. The live rows still cap per kind, as the
// three legs always did, and the stale ones follow them, drawn only while the fold is open.
export function sessionWindow(
    legs: { activeRuns: RunRow[]; blockers: BlockerRow[]; directAgents: AgentRow[] },
    open: boolean,
    now: number
): { rows: ActiveWorkRow[]; more: number } {
    const merged = mergeActiveWork(legs);
    const live = merged.filter((r) => !isStale(r, now));
    const perKind = new Map<string, number>();
    const shown = live.filter((r) => {
        const n = (perKind.get(r.kind) ?? 0) + 1;
        perKind.set(r.kind, n);
        return open || n <= ACTIVE_CAP;
    });
    return { rows: [...shown, ...merged.filter((r) => isStale(r, now))], more: live.length - shown.length };
}

const CHUNK_EVENTS = new Set(["effort-note", "chunk-status", "chunk-done", "chunk-added"]);
const EFFORT_EVENTS = new Set([...CHUNK_EVENTS, "effort-created", "effort-status"]);

const isEffortEvent = (row: DeltaRow): boolean => EFFORT_EVENTS.has(row.kind) && (row.oref ?? "").startsWith("effort:");

// the timeline folds a chunk event's label into its detail as "<label> · <text>"
function eventText(row: DeltaRow): string {
    const detail = row.detail ?? "";
    if (!CHUNK_EVENTS.has(row.kind)) {
        return detail;
    }
    const at = detail.indexOf(" · ");
    return at < 0 ? "" : detail.slice(at + " · ".length);
}

// One row per initiative per day: the day's notes read as what was written, finished and planned, led by
// the newest note's first sentence. A burst of forty notes from one agent would otherwise be forty rows.
function digestLine(group: string, rows: DeltaRow[], now: number): BriefLine {
    const newestFirst = [...rows].sort((a, b) => b.ts - a.ts);
    const notes = newestFirst
        .filter((r) => r.kind !== "chunk-added" && CHUNK_EVENTS.has(r.kind))
        .map((r) => ({ ts: r.ts, text: eventText(r) }))
        .filter((n) => n.text !== "");
    const done = rows.filter((r) => r.kind === "chunk-done").length;
    const added = rows.filter((r) => r.kind === "chunk-added").length;
    const status = newestFirst.find((r) => r.kind === "effort-status");
    const top = newestFirst[0];
    return {
        id: `behind:effort:${group}:${top.oref}`,
        kind: "initiative",
        kindTone: "muted",
        title: top.title,
        note: notes.length > 0 ? headline(noteBody(notes[0])) : "",
        meta: joined([
            notes.length > 0 ? plural(notes.length, "note") : "",
            done > 0 ? plural(done, "chunk") + " done" : "",
            added > 0 ? plural(added, "chunk") + " added" : "",
            rows.some((r) => r.kind === "effort-created") ? "created" : "",
            status != null ? "marked " + eventText(status) : "",
        ]),
        state: age(top.ts, now),
        stateTone: "muted",
        progress: null,
        target: { oref: top.oref ?? "" },
    };
}

function deltaLine(row: DeltaRow, now: number): BriefLine {
    return {
        id: "behind:" + row.key,
        kind: row.wording,
        kindTone: "muted",
        title: row.title,
        note: "",
        meta: "",
        state: age(row.ts, now),
        stateTone: "muted",
        progress: null,
        target: row.oref != null ? { oref: row.oref } : null,
    };
}

export function behindGroups(groups: DeltaGroup[], shipped: ShippedRow[], now: number): LineGroup[] {
    const out: LineGroup[] = groups.map((g) => {
        const byEffort = new Map<string, DeltaRow[]>();
        for (const r of g.rows.filter(isEffortEvent)) {
            byEffort.set(r.oref!, [...(byEffort.get(r.oref!) ?? []), r]);
        }
        const lines: BriefLine[] = [];
        const placed = new Set<string>();
        for (const r of g.rows) {
            if (!isEffortEvent(r)) {
                lines.push(deltaLine(r, now));
            } else if (!placed.has(r.oref!)) {
                // the digest sits where the initiative's first event did, so the day keeps its order
                placed.add(r.oref!);
                lines.push(digestLine(g.label, byEffort.get(r.oref!)!, now));
            }
        }
        return { label: g.label, lines };
    });
    if (shipped.length > 0) {
        out.push({
            label: "Shipped · 7 days",
            lines: shipped.map((s) => ({
                id: "behind:shipped:" + s.oref,
                kind: "Shipped",
                kindTone: "ok",
                title: s.goal,
                note: "",
                meta: joined([s.project, s.fresh ? "new" : ""]),
                state: age(s.completedTs, now),
                stateTone: "muted",
                progress: null,
                target: { oref: s.oref },
            })),
        });
    }
    return out;
}

export function filterLines<T extends BriefLine>(lines: T[], query: string): T[] {
    const q = query.trim().toLowerCase();
    if (q === "") {
        return lines;
    }
    return lines.filter((l) => [l.kind, l.title, l.note, l.meta, l.state].join(" ").toLowerCase().includes(q));
}
