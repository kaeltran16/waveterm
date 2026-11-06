// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The project Overview's History (projecthistory.tsx): the last 7 days of the project's ended sessions, newest
// first, each with the runs it started nested under it. A run with no listed origin session stands on its own.

import { formatAgeShort, formatTokens, type AgentVM } from "./agentsviewmodel";
import { leadlessCardId } from "./cardgridlayout";
import { samePath } from "./projectoverviewmodel";
import { leadAgentOf, runProgress, runTitle, type Lineage } from "./runlineage";
import { runtimeMeta } from "./runtimemeta";
import type { LiveSession } from "./sessionsarchivestore";
import { sessionKey } from "./sessionsruns";

export const HISTORY_WINDOW_MS = 7 * 86_400_000;
export const HISTORY_PAGE = 30;

export type HistoryRunItem = {
    key: string;
    runId: string;
    title: string;
    line: string;
    warn: string;
    tone: "ok" | "warn" | "muted";
    ts: number;
};

export type HistoryEntry =
    | { kind: "session"; key: string; session: LiveSession; runs: HistoryRunItem[]; ts: number }
    | { kind: "run"; key: string; run: HistoryRunItem; ts: number };

export function sessionTitle(s: LiveSession): string {
    return s.task || "(untitled session)";
}

// the window's top-level runs: a task's, a stage's or a lead's child run belongs to its parent run, which is listed
export function historyRuns(runs: Run[], now: number): Run[] {
    const since = now - HISTORY_WINDOW_MS;
    return runs.filter((r) => !r.taskid && !r.stagerole && !r.parentleadoref && r.createdts >= since);
}

const CANCELLED_WARN = " · cancelled";

// a failed Final cancels the dag and holds the land, so it names the cause before either
function runWarn(run: Run, dag: TaskGroup | undefined): Pick<HistoryRunItem, "warn" | "tone"> {
    if (dag?.final?.state === "failed" || run.evidence?.verification?.state === "failed") {
        return { warn: " · Final failed", tone: "warn" };
    }
    if (run.land?.state === "held") {
        return { warn: " · land held", tone: "warn" };
    }
    if (run.status === "cancelled" || dag?.status === "cancelled") {
        return { warn: CANCELLED_WARN, tone: "muted" };
    }
    return { warn: "", tone: "ok" };
}

export function runItem(run: Run, dag?: TaskGroup): HistoryRunItem {
    const landed = run.land?.state === "landed";
    const warn = runWarn(run, dag);
    let line: string;
    if (dag != null) {
        const { done, total } = runProgress(dag);
        line = `${done}/${total} tasks${landed ? " · merged" : ""}`;
    } else if (warn.warn === CANCELLED_WARN) {
        // the warn already names the cancel, so the status would only repeat it
        line = "";
    } else {
        line = landed ? "merged" : run.status;
    }
    // runTitle without a dag is the goal's first line, initiative refs stripped
    return {
        key: `run:${run.id}`,
        runId: run.id,
        title: runTitle(run, undefined),
        line,
        ...warn,
        ts: run.createdts,
    };
}

// the run's Cockpit card, as the Now region opens it: its lead's, or the run's own with no lead in the roster.
// a run out of the lineage (no member in the roster) has no card.
export function runCardId(lineage: Lineage, roster: AgentVM[], runId: string): string | undefined {
    if (lineage.runs[runId] == null) {
        return undefined;
    }
    return leadAgentOf(lineage, roster, runId)?.id ?? leadlessCardId(runId);
}

export function sessionLine(s: LiveSession): string {
    const rt = runtimeMeta(s.runtime);
    const parts = [rt.id === "unknown" ? s.runtime : rt.id];
    if (s.durationms > 0) {
        parts.push(formatAgeShort(s.durationms));
    }
    parts.push(`${formatTokens(s.tokenstotal)} tokens`);
    return parts.join(" · ");
}

// a plain substring, case folded: a query is what the user typed, never a pattern
function matches(text: string, q: string): boolean {
    return text.toLowerCase().includes(q);
}

function keepEntry(e: HistoryEntry, q: string): boolean {
    if (e.kind === "run") {
        return matches(e.run.title, q);
    }
    return matches(sessionTitle(e.session), q) || e.runs.some((r) => matches(r.title, q));
}

export function historyEntries(
    sessions: LiveSession[],
    runs: Run[],
    dags: Record<string, TaskGroup | undefined>,
    path: string,
    now: number,
    query: string
): HistoryEntry[] {
    const since = now - HISTORY_WINDOW_MS;
    const listed = sessions.filter(
        (s) => !s.live && !s.runid && s.lastactivets >= since && samePath(s.projectpath, path)
    );
    const entries: HistoryEntry[] = listed.map((s) => ({
        kind: "session",
        key: sessionKey(s),
        session: s,
        runs: [],
        ts: s.lastactivets,
    }));
    for (const r of historyRuns(runs, now)) {
        const item = runItem(r, r.dagoref ? dags[r.dagoref] : undefined);
        const i = r.origintranscript ? listed.findIndex((s) => samePath(s.transcriptpath, r.origintranscript)) : -1;
        const origin = entries[i];
        if (origin?.kind === "session") {
            origin.runs.push(item);
        } else {
            entries.push({ kind: "run", key: item.key, run: item, ts: item.ts });
        }
    }
    for (const e of entries) {
        if (e.kind === "session") {
            e.runs.sort((a, b) => b.ts - a.ts);
        }
    }
    entries.sort((a, b) => b.ts - a.ts);
    const q = query.trim().toLowerCase();
    return q ? entries.filter((e) => keepEntry(e, q)) : entries;
}
