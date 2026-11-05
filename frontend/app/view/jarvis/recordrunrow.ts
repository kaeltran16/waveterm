// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// What one attributed-run row on a record says. A dossier's objective is seeded from its run's goal, so
// rendering the goal put the record's own title in the widest column of every row — N identical lines
// whose only distinguishing datum was an 8-character id (JC23). The run's evidence summary is the thing
// that actually differs per run.

import { fmtDuration } from "@/app/view/agents/runcompletion";
import { runRuntimeView } from "@/app/view/agents/runmodel";
import { headline } from "./effortfeed";
import { ageLabel } from "./recallderive";

export interface RunRow {
    shortId: string;
    headline: string | null;
    meta: string[];
}

// A goal "differs" from the objective only after trimming, collapsing internal whitespace and lowercasing.
// The match this suppresses is an exact copy, so the normalization absorbs incidental drift, nothing more.
function norm(s: string): string {
    return (s ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

function changeStat(ev: RunEvidence): string | null {
    const n = ev.files?.length ?? 0;
    if (n === 0) {
        return null;
    }
    return `+${ev.addtotal ?? 0}/−${ev.deltotal ?? 0} across ${n} file${n === 1 ? "" : "s"}`;
}

const FENCE = /^\s*(```|~~~)/;
const HEADING = /^\s*#{1,6}(\s|$)/;
const LEAD_MARKERS = /^\s*(?:>\s*|[-*+]\s+|\d+[.)]\s+)+/;
// emphasis wraps a word from outside, so an underscore inside snake_case is left alone
const EMPHASIS = /(^|[^\w*])([*_]{1,2})(?=\S)(.+?)(?<=\S)\2(?![\w*])/g;
const PROSE = /[\p{L}\p{N}]/u;

// reportHeadline is the first line of a worker's report that reads as prose: headings and fenced code are
// skipped, and the markers that would print as noise in a one-line row are stripped. A summary with no such
// line gives null, so the row falls back to its goal.
export function reportHeadline(summary: string): string | null {
    let fenced = false;
    for (const raw of (summary ?? "").split(/\r?\n/)) {
        if (FENCE.test(raw)) {
            fenced = !fenced;
            continue;
        }
        if (fenced || HEADING.test(raw)) {
            continue;
        }
        const line = raw.replace(LEAD_MARKERS, "").replace(EMPHASIS, "$1$3").replace(/`/g, "").trim();
        if (PROSE.test(line)) {
            return headline(line);
        }
    }
    return null;
}

export function runRow(run: Run, recordObjective: string, now: number, harnesses: HarnessInfo[]): RunRow {
    const ev = run.evidence;
    const fromReport = reportHeadline(ev?.summary ?? "");
    const head = fromReport ?? (norm(run.goal) === norm(recordObjective) ? null : run.goal);

    // every part is omitted rather than defaulted: an unsealed run has no duration and no change set, and
    // a zero would assert one. The runtime label comes from the strict runRuntimeView — legacy labels
    // Claude · legacy, an unknown value labels itself.
    const meta = [runRuntimeView(run, harnesses).label, ageLabel(Math.max(0, now - (run.createdts ?? now)))];
    if (ev != null && (ev.durationms ?? 0) > 0) {
        meta.push(fmtDuration(ev.durationms));
    }
    const stat = ev != null ? changeStat(ev) : null;
    if (stat != null) {
        meta.push(stat);
    }
    return { shortId: (run.id ?? "").slice(0, 8), headline: head, meta };
}
