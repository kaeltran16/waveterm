// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// What the record peek says: what is running against a record, what you set it to, and its decision log.
// The peek is a record's only home (openref.ts openRecordPeek), so the log is shown and added to here.
//
// Pure: DossierDetail + the runs attributed to it + the fleet rollup in, strings and rows out. Every
// number here is derived from the rows beneath it (invariant 5), and nothing claims a reading the record
// does not carry (invariant 7) — see updatedLabel.

import { runStatusView, type RunStatusTone } from "@/app/view/agents/runmodel";
import { headline, kilo } from "./effortfeed";
import { fleetCountsLine, type RecordFleet } from "./fleetscope";
import { ageLabel } from "./recallderive";
import { runRow } from "./recordrunrow";
import { allowedTransitions, isTerminalTransition } from "./tasksderive";

export interface PeekStatusRow {
    status: string;
    label: string;
    note: string;
    // the row naming the status the record is already in: marked, and inert. A control that does nothing
    // dressed as one that does is the same lie as a label dressed as a control (invariant 4).
    current: boolean;
    terminal: boolean;
}

export interface PeekRunRow {
    runId: string;
    shortId: string;
    headline: string;
    meta: string;
    state: string;
    tone: RunStatusTone;
}

export interface RecordPeek {
    title: string;
    // the record has no objective, so the title is its id: drawn in mono, as an id rather than a sentence
    titleIsId: boolean;
    // NOT the mockup's freshness word. A DossierDetail carries no freshness reading of any kind — no
    // gardener flag, no verification timestamp — so printing one would assert a check nobody ran, which is
    // the fabrication the Drew band's `unverified` exists to prevent. The record's own updated stamp is
    // what this slot can honestly say.
    updatedLabel: string;
    statusLabel: string;
    statusRows: PeekStatusRow[];
    // null when the objective is one sentence: the title already says all of it
    body: string | null;
    // the body is the stated absence, not content: drawn muted
    bodyIsAbsence: boolean;
    // the link that opens a clamped body, or null when the body is short enough to show whole
    bodyMore: string | null;
    fleetMeta: string;
    runs: PeekRunRow[];
    // the scope read has not landed: the rows draw as skeletons, and nothing is claimed absent yet
    runsLoading: boolean;
    // absence is a written sentence, never an empty frame (invariant 3); null while loading or when there are runs
    runsAbsent: string | null;
    // the label of the footer toggle that shows the record's decision log
    logLine: string;
}

// What each status changes about where the record turns up. Deliberately about listing and focus rather
// than about the queue: status does not filter what reaches you — `listDossiers` (the focus-target list) is
// active|paused only, and the palette sorts archived last, and that is the whole of its effect.
const STATUS_NOTE: Record<string, string> = {
    active: "The default. Offered as a focus target, listed under Active.",
    paused: "Still live, just not now. Still offered as a focus target, listed under Paused.",
    completed: "The work is done. Listed under Done, no longer offered as a focus target.",
    archived: "Out of the way. Reachable only through the palette, sorted last.",
};

const STATUS_ORDER = ["active", "paused", "completed", "archived"];

// past this many characters the body is clamped behind a link to the rest; 20 of the user's records cross it
const BODY_CLAMP_CHARS = 400;

const BODY_ABSENT = "This record states no objective yet.";

const RUNS_ABSENT = "No session has ever been attributed to this record.";

// statusPickerRows is the current status as a marked inert row, plus one control per legal transition. The
// mockup draws four fixed rows; allowedTransitions forbids paused-from-completed, so a fixed four would
// render a button that cannot do anything. An unknown stored status yields transitions but no current row,
// which is the honest reading of a value this build does not have a note for.
export function statusPickerRows(status: string): PeekStatusRow[] {
    const legal = new Set(allowedTransitions(status));
    const rows: PeekStatusRow[] = [];
    for (const s of STATUS_ORDER) {
        const current = s === status;
        if (!current && !legal.has(s)) {
            continue;
        }
        rows.push({
            status: s,
            label: s.charAt(0).toUpperCase() + s.slice(1),
            note: STATUS_NOTE[s] ?? "",
            current,
            terminal: isTerminalTransition(s),
        });
    }
    return rows;
}

export interface ObjectiveParts {
    headline: string;
    // what the objective says past its headline: null when the headline is all of it
    body: string | null;
    // the link that opens a clamped body, or null when the body is short enough to show whole
    bodyMore: string | null;
}

// objectiveParts is the one rule for how an objective is shortened: its first sentence as the headline, and
// the rest as the body, so a host that prints both never says the first sentence twice. A headline that had to
// cut its sentence says only part of it, so then the body is the whole objective. An empty objective is the
// caller's case: each host states that absence its own way.
export function objectiveParts(objective: string): ObjectiveParts {
    const text = objective.trim();
    const head = headline(text);
    let body: string | null = text;
    if (text.startsWith(head)) {
        const rest = text.slice(head.length).trim();
        body = rest === "" ? null : rest;
    }
    const bodyMore =
        body != null && body.length > BODY_CLAMP_CHARS ? `Show the full objective · ${kilo(body.length)}` : null;
    return { headline: head, body, bodyMore };
}

export function statusConfirmCopy(status: string): { title: string; body: string } {
    return {
        title: `Mark this record ${status}?`,
        body: `This sets the record's status to "${status}". You can reactivate it later.`,
    };
}

// a volunteered utterance that named one of this record's decisions opens the peek with the log shown, so the
// card it points at is in sight to flash
export function decisionsOpenOnMount(anchor: string | null, decisions: DecisionCard[]): boolean {
    return anchor != null && (decisions ?? []).some((d) => d.id === anchor);
}

function peekBody(detail: DossierDetail): { body: string | null; bodyIsAbsence: boolean; bodyMore: string | null } {
    const objective = detail.objective?.trim() ?? "";
    if (objective === "") {
        const notes = detail.notes?.trim() ?? "";
        if (notes === "") {
            return { body: BODY_ABSENT, bodyIsAbsence: true, bodyMore: null };
        }
        return { body: notes, bodyIsAbsence: false, bodyMore: null };
    }
    const { body, bodyMore } = objectiveParts(objective);
    return { body, bodyIsAbsence: false, bodyMore };
}

function logLine(n: number): string {
    if (n === 0) {
        return "No decisions yet";
    }
    return `${n} decision${n === 1 ? "" : "s"}`;
}

export interface RecordPeekInput {
    detail: DossierDetail;
    // undefined while the record's scope read is in flight: not loaded is not "never attributed"
    runs: Run[] | undefined;
    fleet: RecordFleet;
    // the worker counts the fleet rollup produced; passed in rather than recomputed so the meta line and
    // the roster it describes can never disagree
    counts: { working: number; waiting: number };
    harnesses: HarnessInfo[];
    now: number;
}

export function buildRecordPeek(input: RecordPeekInput): RecordPeek {
    const { detail, runs, fleet, counts, harnesses, now } = input;
    const objective = detail.objective?.trim() ?? "";
    return {
        title: objective !== "" ? objectiveParts(objective).headline : detail.id,
        titleIsId: objective === "",
        updatedLabel: detail.updated > 0 ? `updated ${ageLabel(Math.max(0, now - detail.updated))}` : "never updated",
        statusLabel: detail.status ?? "",
        statusRows: statusPickerRows(detail.status ?? ""),
        ...peekBody(detail),
        // the record variant of the shared line, so the peek counts workers across channels rather than
        // counting the rows below it — a record's fleet crosses channels by construction (spec §4a fidelity
        // note), and the rows are runs, which is a different number on purpose.
        fleetMeta: fleetCountsLine(counts, 0, fleet),
        runs: (runs ?? []).map((r) => {
            const row = runRow(r, objective, now, harnesses);
            const view = runStatusView(r.status);
            return {
                runId: r.id,
                shortId: row.shortId,
                // runRow returns a null headline when the run's goal merely echoes the record's objective —
                // it suppresses N identical lines. A row still needs something to read, so it falls back to
                // naming the run rather than rendering blank.
                headline: row.headline ?? `run ${row.shortId}`,
                meta: row.meta.join(" · "),
                state: view.label,
                tone: view.tone,
            };
        }),
        runsLoading: runs == null,
        runsAbsent: runs != null && runs.length === 0 ? RUNS_ABSENT : null,
        logLine: logLine(detail.decisions?.length ?? 0),
    };
}
