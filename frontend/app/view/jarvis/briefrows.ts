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
import { parseAddress, type OpenTarget } from "./address";
import {
    ACTIVE_CAP,
    mergeActiveWork,
    queueKindLabel,
    queueOpenTarget,
    SEVEN_DAYS_MS,
    type ActiveWorkRow,
    type AgentRow,
    type DeltaGroup,
    type DeltaRow,
    type QueueOpenTarget,
    type QueueRow,
    type RunRow,
    type ShippedRow,
} from "./briefingmodel";
import { headline, noteBody } from "./effortfeed";
import type { EffortCardModel } from "./effortmodel";

export type LineTone = "ok" | "active" | "asking" | "error" | "muted" | "faint";
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
    // the per-region fields the design's row anatomies read; "" where a region has none
    why: string;
    age: string;
    detail: string;
    runOid?: string;
    agentId?: string;
    hasReport?: boolean;
    fresh?: boolean;
    runType?: RunType;
    group?: "delta" | "shipped";
    // an initiative's Jira key, "" with none: the meta draws it as a link
    ticket?: string;
};

export type LineGroup = { label: string; lines: BriefLine[] };

export const SHIPPED_LABEL = "Shipped · 7 days";

// What Space peeks on a row: the target its click opens, or null when it has none or names an address
// the router cannot open (a click on that row still says why).
export function lineOpenTarget(target: LineTarget): OpenTarget | null {
    if (target == null) {
        return null;
    }
    let address = "oref" in target ? target.oref : "";
    if ("queue" in target) {
        const q = target.queue;
        if (q.kind === "channel") {
            return { kind: "channel", channelId: q.channelId, runId: q.runId ?? undefined };
        }
        address = q.oref;
    }
    const parsed = parseAddress(address);
    return parsed.kind === "unsupported" ? null : parsed;
}

const age = (ts: number, now: number) => formatAge(now - ts);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const joined = (parts: (string | undefined)[]) => parts.filter((p) => p != null && p !== "").join(" · ");

export function queueLine(q: QueueRow, now: number): BriefLine {
    const tone: LineTone = q.tone === "error" ? "error" : "asking";
    const target = queueOpenTarget(q.nav);
    return {
        id: "waiting:" + q.key,
        kind: queueKindLabel(q),
        kindTone: tone,
        title: q.title,
        note: q.why,
        meta: joined([q.attrib, q.detail]),
        state: "",
        stateTone: tone,
        progress: null,
        target: target != null ? { queue: target } : null,
        why: q.why,
        age: q.ts != null ? age(q.ts, now) : "",
        // a note written after the block often says it cleared, which is what Unblock and Done act on
        detail: q.chunk?.latest != null ? `latest ${age(q.chunk.latest.ts, now)} · ${q.chunk.latest.text}` : "",
    };
}

export function initiativeLine(card: EffortCardModel): BriefLine {
    const blocked = card.blockedChunks.length;
    // blocked first: it is the one state that is waiting on someone
    const [state, stateTone]: [string, LineTone] =
        card.status === "archived"
            ? ["archived", "faint"]
            : blocked > 0
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
        ticket: card.ticket ?? "",
        state,
        stateTone,
        progress: { done: card.done, total: card.done + card.remaining, pct: card.progressPct },
        target: { oref: card.oref },
        why: "",
        age: "",
        detail: "",
    };
}

// The Initiatives head: what is not moving. A paused initiative was stopped on purpose; a quiet one (no
// update in seven days) stopped without anyone saying so, and the list sorts it to the bottom behind the
// fold, so the count is the only place it shows.
export function initiativesMeta(cards: { status: string; updatedts: number }[], now: number): string {
    const paused = cards.filter((c) => c.status === "paused").length;
    const quiet = cards.filter((c) => c.status !== "paused" && now - c.updatedts > SEVEN_DAYS_MS).length;
    const parts = [paused > 0 ? `${paused} paused` : "", quiet > 0 ? `${quiet} quiet 7d+` : ""];
    return joined(parts) || "all moving";
}

const needsEyes = (row: ActiveWorkRow) =>
    row.kind === "blocker" || row.chip?.tone === "blocked" || row.chip?.tone === "asking";
// a run that needs nothing from you reads by how long it has been quiet; anything else by its state
const isDated = (row: ActiveWorkRow) => row.kind === "run" && !needsEyes(row);
// a run quiet past seven days folds, and so does one blocked that long: a week-old block is a leftover the
// Runs count would otherwise call live while nothing runs. An asking row stays, its ask is still open.
const isStale = (row: ActiveWorkRow, now: number) =>
    row.kind === "run" && (isDated(row) || row.chip?.tone === "blocked") && now - row.ts > SEVEN_DAYS_MS;

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
        why: "",
        age: age(row.ts, now),
        detail: "",
        runOid: row.kind === "run" ? row.oref.replace(/^run:/, "") : undefined,
        agentId: row.kind === "agent" ? row.key.split(":")[1] : undefined,
        runType: row.kind === "run" ? runType(row.mode) : undefined,
        stale: isStale(row, now),
    };
}

export type RunRowFace = {
    type: RunType | "agent";
    meta: string;
    elapsed: string;
    state: string;
    stateTone: LineTone;
    dot: "live" | "asking" | "done" | "idle";
    asking: boolean;
    canStop: boolean;
    stopped: boolean;
    chunkLabel: string;
    effortOref: string;
    chunk: string;
    // what Answer does: a run answers in its sheet, loaded or not; a direct agent's is on the Agent surface
    answer: "sheet" | "agent" | null;
};

export type EffortRef = { oref: string; title: string; chunkStages: Record<string, string>; ticket: string };
// keyed by effort oid, the way a run's effortref names its effort
export type EffortIndex = Map<string, EffortRef>;

// A Runs row (design L266-278, model L1615-1627) from the live Run object and the roster.
export function runRowFace(i: {
    line: BriefLine;
    run?: Run;
    asking: boolean;
    project: string;
    effort?: EffortRef;
}): RunRowFace {
    const { line, run } = i;
    if (run == null) {
        const asking = i.asking || line.state === "asking";
        const isRun = line.runOid != null;
        return {
            // a run whose Run has not loaded yet is still a run: its badge comes from the snapshot's mode
            type: isRun ? (line.runType ?? "quick run") : "agent",
            meta: line.meta,
            elapsed: line.age,
            state: asking ? "asking" : line.state === "working" ? "running" : line.state,
            stateTone: asking ? "asking" : "ok",
            dot: asking ? "asking" : "live",
            asking,
            canStop: false,
            stopped: false,
            chunkLabel: "",
            effortOref: "",
            chunk: "",
            answer: isRun ? "sheet" : line.agentId != null ? "agent" : null,
        };
    }
    const orch = run.mode === "orchestrator";
    const status = run.status ?? "";
    const [state, stateTone]: [string, LineTone] = i.asking
        ? ["asking", "asking"]
        : status === "blocked"
          ? ["blocked", "asking"]
          : status === "awaiting-review"
            ? ["review", "asking"]
            : status === "cancelled"
              ? ["stopped", "faint"]
              : status === "done"
                ? ["done", "ok"]
                : status === "planning"
                  ? ["planning", "ok"]
                  : ["running", "ok"];
    const terminal = status === "done" || status === "cancelled";
    const ref = run.effortref;
    const linked = ref != null && i.effort != null;
    const stage = linked ? (i.effort.chunkStages[ref.chunklabel] ?? "") : "";
    return {
        type: runType(run.mode),
        meta: orch ? `lead · ${i.project}` : `${run.runtime || "claude"} · ${i.project}`,
        elapsed: line.age,
        state,
        stateTone,
        dot: i.asking ? "asking" : terminal ? (status === "done" ? "done" : "idle") : "live",
        asking: i.asking,
        canStop: !terminal,
        stopped: status === "cancelled",
        chunkLabel: linked ? `${i.effort.title} · ${stage || "unstaged"}` : "",
        effortOref: linked ? i.effort.oref : "",
        chunk: ref?.chunklabel ?? "",
        answer: "sheet",
    };
}

// The Sessions region's rows. Blockers are not among them: they wait on you, so they join the queue
// (buildAttentionQueue). Stale runs leave before the cap: capped first, a window full of week-quiet runs
// drew nothing but the fold, and its "+N more" only fed the fold. The live rows still cap per kind, as the
// legs always did, and the stale ones follow them, drawn only while the fold is open.
export function sessionWindow(
    legs: { activeRuns: RunRow[]; directAgents: AgentRow[] },
    open: boolean,
    now: number
): { rows: ActiveWorkRow[]; more: number } {
    const merged = mergeActiveWork({ activeRuns: legs.activeRuns, blockers: [], directAgents: legs.directAgents });
    const live = merged.filter((r) => !isStale(r, now));
    const perKind = new Map<string, number>();
    const shown = live.filter((r) => {
        const n = (perKind.get(r.kind) ?? 0) + 1;
        perKind.set(r.kind, n);
        return open || n <= ACTIVE_CAP;
    });
    return { rows: [...shown, ...merged.filter((r) => isStale(r, now))], more: live.length - shown.length };
}

// The Runs filter. An orchestrator run carries the most to read, so it can be looked at alone; a direct
// agent is neither kind, so a filtered view drops it. Any mode but orchestrator reads as a quick run,
// the same split runRowFace badges.
export type RunKindFilter = "all" | "orchestrator" | "quick";
export const RUN_KIND_FILTERS: readonly RunKindFilter[] = ["all", "orchestrator", "quick"];

// Whether Behind you is on screen enough to have been read: half of it, or half the viewport when it is
// taller than that. Any visible pixel was too loose, since its head peeks in below Runs while you read them.
export function readsAsInView(visible: number, height: number, viewport: number): boolean {
    return height > 0 && visible >= Math.min(height, viewport) / 2;
}

export type RunType = "quick run" | "orchestrator";

export function runType(mode: string): RunType {
    return mode === "orchestrator" ? "orchestrator" : "quick run";
}

export function keepsRunKind(filter: RunKindFilter, mode: string): boolean {
    return filter === "all" || (mode === "orchestrator") === (filter === "orchestrator");
}

export function runKindLegs(
    legs: { activeRuns: RunRow[]; directAgents: AgentRow[] },
    filter: RunKindFilter
): { activeRuns: RunRow[]; directAgents: AgentRow[] } {
    if (filter === "all") {
        return legs;
    }
    return { activeRuns: legs.activeRuns.filter((r) => keepsRunKind(filter, r.mode)), directAgents: [] };
}

// The Initiatives filter: null is every project, and "" picks the initiatives that name none. The options
// sort by name rather than by count, so a chip does not move while you reach for it.
export function initiativeProjects(cards: { project?: string }[]): string[] {
    const names = [...new Set(cards.map((c) => c.project ?? ""))];
    return names.sort((a, b) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b)));
}

export function keepsProject(filter: string | null, project: string | undefined): boolean {
    return filter == null || (project ?? "") === filter;
}

export function projectCounts(cards: { project?: string }[]): Map<string, number> {
    const counts = new Map<string, number>();
    for (const c of cards) {
        counts.set(c.project ?? "", (counts.get(c.project ?? "") ?? 0) + 1);
    }
    return counts;
}

// The Runs chips count what the head's "N live" counts: a stale run is stated by its fold, not by a chip.
export function liveRunKindCounts(
    legs: { activeRuns: RunRow[]; directAgents: AgentRow[] },
    now: number
): Record<RunKindFilter, number> {
    const live = mergeActiveWork({ ...legs, blockers: [] }).filter((r) => !isStale(r, now));
    return runKindCounts(
        live.filter((r) => r.kind === "run").map((r) => r.mode),
        live.filter((r) => r.kind === "agent").length
    );
}

// a direct agent is neither kind, so only all counts it
export function runKindCounts(modes: string[], unkinded = 0): Record<RunKindFilter, number> {
    const orchestrator = modes.filter((m) => keepsRunKind("orchestrator", m)).length;
    return { all: modes.length + unkinded, orchestrator, quick: modes.length - orchestrator };
}

// A region filter's chips get a line of their own under the head while there are few; past this many
// choices besides all, a line of them runs on and wraps, so the head carries one menu instead.
export const FILTER_LINE_MAX = 6;

// options counts the all choice, which every filter leads with
export function filterAsMenu(options: number): boolean {
    return options - 1 > FILTER_LINE_MAX;
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

const RUN_EVENTS = new Set(["run-created", "run-done"]);

// A run goal runs to paragraphs; a Behind you row is one line, so it takes the goal's first line's lead
// sentence.
export function shortTitle(text: string): string {
    return headline(text.trim().split("\n")[0] ?? "");
}

const MD_LIST = /^(?:[-*+]|\d+[.)])\s+/;
const MD_INLINE = /\*\*|__|`/g;
const MD_LINK = /\[([^\]]*)\]\([^)]*\)/g;

// A run's summary is often its report's markdown ("# Run report: ... ## Tasks - t-1: ..."); a row's second
// line takes its first line of prose instead: headings skipped, list markers, emphasis, code ticks and link
// targets dropped.
export function plainSummary(md: string): string {
    const line = md
        .split("\n")
        .map((l) => l.trim())
        .find((l) => l !== "" && !l.startsWith("#") && !/^[-*_=|]{3,}/.test(l));
    if (line == null) {
        return "";
    }
    return headline(line.replace(MD_LIST, "").replace(MD_LINK, "$1").replace(MD_INLINE, "").trim());
}

// One row per initiative per day: the day's notes read as what was written, finished and planned, led by
// the newest note's first sentence, with the runs it started or finished counted beside them. A burst of
// forty notes from one agent would otherwise be forty rows.
function digestLine(group: string, oref: string, title: string, rows: DeltaRow[], now: number): BriefLine {
    const newestFirst = [...rows].sort((a, b) => b.ts - a.ts);
    const notes = newestFirst
        .filter((r) => r.kind !== "chunk-added" && CHUNK_EVENTS.has(r.kind))
        .map((r) => ({ ts: r.ts, text: eventText(r) }))
        .filter((n) => n.text !== "");
    const done = rows.filter((r) => r.kind === "chunk-done").length;
    const added = rows.filter((r) => r.kind === "chunk-added").length;
    const runs = new Set(rows.filter((r) => RUN_EVENTS.has(r.kind)).map((r) => r.oref)).size;
    const status = newestFirst.find((r) => r.kind === "effort-status");
    const top = newestFirst[0];
    return {
        id: `behind:effort:${group}:${oref}`,
        kind: "Initiative",
        kindTone: "muted",
        title,
        note: notes.length > 0 ? headline(noteBody(notes[0])) : "",
        meta: "",
        detail: joined([
            notes.length > 0 ? plural(notes.length, "note") : "",
            done > 0 ? plural(done, "chunk") + " done" : "",
            added > 0 ? plural(added, "chunk") + " added" : "",
            runs > 0 ? plural(runs, "run") : "",
            rows.some((r) => r.kind === "effort-created") ? "created" : "",
            status != null ? "marked " + eventText(status) : "",
        ]),
        state: age(top.ts, now),
        stateTone: "muted",
        progress: null,
        target: { oref },
        why: "",
        age: "",
        group: "delta",
    };
}

const DELTA_TONE: Record<string, LineTone> = {
    "run-created": "active",
    "run-done": "ok",
    decision: "muted",
    dossier: "asking",
};

// the second line: the project, then what happened. A run's start says its status, its finish its summary.
function deltaDetail(row: DeltaRow, project: string): string {
    const detail = row.detail ?? "";
    const status = detail.startsWith("status: ") ? detail.slice("status: ".length) : null;
    if (row.kind === "dossier" && status != null) {
        return joined([project, "current status: " + status]);
    }
    if (row.kind === "run-done") {
        return joined([project, plainSummary(detail)]);
    }
    return joined([project, row.kind === "run-created" && status != null ? status : detail]);
}

function deltaLine(row: DeltaRow, now: number, project: string): BriefLine {
    return {
        id: "behind:" + row.key,
        // a dossier's wording carries its status after " · "; the kind column takes only the event
        kind: row.wording.split(" · ")[0],
        kindTone: DELTA_TONE[row.kind] ?? "muted",
        title: shortTitle(row.title),
        note: "",
        meta: "",
        state: age(row.ts, now),
        stateTone: "muted",
        progress: null,
        target: row.oref != null ? { oref: row.oref } : null,
        why: "",
        age: "",
        detail: deltaDetail(row, project),
        group: "delta",
    };
}

// what Behind you reads beyond the rows: initiative titles for a run's fold, project names for the rest
export type BehindContext = {
    efforts?: EffortIndex;
    projects?: Record<string, { path?: string }> | null;
};

export function behindGroups(
    groups: DeltaGroup[],
    shipped: ShippedRow[],
    now: number,
    ctx: BehindContext = {}
): LineGroup[] {
    const name = (path: string | undefined) => projectName(path ?? "", ctx.projects ?? null);
    const out: LineGroup[] = groups.map((g) => {
        // an initiative's title: from its own events that day, else the index; a run whose initiative has
        // neither (archived, or another project's) stays its own row rather than a digest with no name
        const titles = new Map<string, string>();
        for (const r of g.rows.filter(isEffortEvent)) {
            titles.set(r.oref!, r.title);
        }
        const foldKey = (r: DeltaRow): string | null => {
            if (isEffortEvent(r)) {
                return r.oref!;
            }
            if (!RUN_EVENTS.has(r.kind) || !r.effortOid) {
                return null;
            }
            const oref = "effort:" + r.effortOid;
            const indexed = ctx.efforts?.get(r.effortOid)?.title;
            if (!titles.has(oref) && indexed != null) {
                titles.set(oref, indexed);
            }
            return titles.has(oref) ? oref : null;
        };
        const byEffort = new Map<string, DeltaRow[]>();
        for (const r of g.rows) {
            const k = foldKey(r);
            if (k != null) {
                byEffort.set(k, [...(byEffort.get(k) ?? []), r]);
            }
        }
        const lines: BriefLine[] = [];
        const placed = new Set<string>();
        for (const r of g.rows) {
            const k = foldKey(r);
            if (k == null) {
                lines.push(deltaLine(r, now, name(r.project)));
            } else if (!placed.has(k)) {
                // the digest sits where the initiative's first event did, so the day keeps its order
                placed.add(k);
                lines.push(digestLine(g.label, k, titles.get(k)!, byEffort.get(k)!, now));
            }
        }
        return { label: g.label, lines };
    });
    if (shipped.length > 0) {
        out.push({
            label: SHIPPED_LABEL,
            lines: shipped.map((s) => ({
                id: "behind:shipped:" + s.oref,
                kind: "Shipped",
                kindTone: "ok",
                title: s.goal,
                note: "",
                meta: "",
                state: age(s.completedTs, now),
                stateTone: "muted",
                progress: null,
                target: { oref: s.oref },
                why: "",
                age: "",
                detail: joined([name(s.project), plainSummary(s.summary)]),
                hasReport: s.hasReport,
                fresh: s.fresh,
                runType: runType(s.mode),
                group: "shipped" as const,
            })),
        });
    }
    return out;
}

// Behind you's window, taken after the fold: a cap on raw events let a burst of notes that folds into one
// digest fill the window and call its own events "+N more". Shipped keeps its own cap, so it passes through
// and is not counted.
export function capBehind(groups: LineGroup[], cap: number, expanded: boolean): { groups: LineGroup[]; more: number } {
    if (expanded) {
        return { groups, more: 0 };
    }
    let room = cap;
    let more = 0;
    const kept: LineGroup[] = [];
    for (const g of groups) {
        if (g.label === SHIPPED_LABEL) {
            kept.push(g);
            continue;
        }
        const lines = g.lines.slice(0, Math.max(room, 0));
        room -= lines.length;
        more += g.lines.length - lines.length;
        if (lines.length > 0) {
            kept.push(lines.length === g.lines.length ? g : { ...g, lines });
        }
    }
    return { groups: kept, more };
}

export function filterLines<T extends BriefLine>(lines: T[], query: string): T[] {
    const q = query.trim().toLowerCase();
    if (q === "") {
        return lines;
    }
    return lines.filter((l) =>
        [l.kind, l.title, l.note, l.meta, l.detail, l.state].join(" ").toLowerCase().includes(q)
    );
}

// a project's registry name for its path; the path's last segment when the registry has no entry
export function projectName(path: string, projects: Record<string, { path?: string }> | null): string {
    if (path === "") {
        return "";
    }
    const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    const hit = Object.entries(projects ?? {}).find(([, v]) => v.path != null && norm(v.path) === norm(path));
    return hit != null ? hit[0] : (path.replace(/\\/g, "/").replace(/\/+$/, "").split("/").pop() ?? path);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

// Behind you's meta (design L1793). firstVisit: no stored cursor, so the window is the seven-day default.
export function sinceLabel(cursorTs: number, nowTs: number, firstVisit: boolean): string {
    if (firstVisit) {
        return "the last 7 days";
    }
    const d = new Date(cursorTs);
    const today = new Date(nowTs);
    today.setHours(0, 0, 0, 0);
    const day = new Date(cursorTs);
    day.setHours(0, 0, 0, 0);
    const diff = Math.round((today.getTime() - day.getTime()) / 86_400_000);
    if (diff === 0) {
        return `since today ${hhmm(d)}`;
    }
    if (diff === 1) {
        return `since yesterday ${hhmm(d)}`;
    }
    return `since ${MONTHS[d.getMonth()]} ${d.getDate()}`;
}
