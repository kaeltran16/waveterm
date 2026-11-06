// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The project Overview's Now region (projectnow.tsx), pure: what runs in the project right now, and what
// finished there that the Events rail has not marked read. Running is live work only: an asking agent is the
// Brief's, not this region's.

import { projectOf, type AgentVM } from "./agentsviewmodel";
import { mergeRailEvents, runRailEvents, scopeRailRows, splitUnread, type RailEvent } from "./cockpitevents";
import { leadAgentOf, runFinished, runProgress, type Lineage, type RunInfo } from "./runlineage";

export type RunningRow = { kind: "agent" | "run" | "terminal"; id: string; name: string; line: string; since: number };

export type FinishedRow = { id: string; kind: "agent" | "run"; name: string; line: string; ts: number };

// a terminal and the command its shell reports running (null at its prompt), with when that was first seen
export type TerminalRead = { vm: AgentVM; command: string | null; since?: number };

const oldestFirst = (x: RunningRow, y: RunningRow) => x.since - y.since;

function runMemberOf(lineage: Lineage, agentId: string, runId: string): boolean {
    const role = lineage.roles[agentId];
    if (role == null) {
        return false;
    }
    return role.kind === "lead" ? role.runId === runId : role.leadRunId === runId;
}

function runRow(run: RunInfo, atWork: number, now: number): RunningRow {
    const { done, total } = runProgress(run.dag);
    const tasks = total > 0 ? ` · ${done}/${total} tasks` : "";
    return {
        kind: "run",
        id: run.runId,
        name: run.title,
        line: `${atWork} at work${tasks}`,
        since: run.dag?.createdts ?? now,
    };
}

/** Pure: the project's live work. Plain working agents, then runs with a member at work, then terminals running
 *  a command, each oldest first. A run's members show only under its row. */
export function runningRows(
    agents: AgentVM[],
    terminals: TerminalRead[],
    lineage: Lineage,
    project: string,
    now: number
): RunningRow[] {
    const plain = agents
        .filter((a) => lineage.roles[a.id] == null && a.state === "working" && projectOf(a) === project)
        .map<RunningRow>((a) => ({
            kind: "agent",
            id: a.id,
            name: a.name,
            line: a.activity || a.task,
            since: now - (a.activeMs ?? 0),
        }));
    // a run is in the project its lead works in, as in the rail; its checkout's folder name only without one
    const runProject = (r: RunInfo) => {
        const lead = leadAgentOf(lineage, agents, r.runId);
        return lead ? projectOf(lead) : r.project;
    };
    const runs = Object.values(lineage.runs)
        .filter((r) => runProject(r) === project && !runFinished(r))
        .map((r) => ({
            run: r,
            atWork: agents.filter((a) => a.state === "working" && runMemberOf(lineage, a.id, r.runId)).length,
        }))
        .filter(({ atWork }) => atWork > 0)
        .map(({ run, atWork }) => runRow(run, atWork, now));
    const terms = terminals
        .filter((t) => t.command != null && projectOf(t.vm) === project)
        .map<RunningRow>((t) => ({
            kind: "terminal",
            id: t.vm.id,
            name: t.vm.name,
            line: t.command,
            since: t.since ?? now,
        }));
    return [...plain.sort(oldestFirst), ...runs.sort(oldestFirst), ...terms.sort(oldestFirst)];
}

const FINISH_KINDS = new Set(["finished", "landed"]);

/** Pure: the project's finishes and lands after the rail's read cursor, newest per agent or run, newest first.
 *  A run's event belongs to the project its lead works in, as in the rail. */
export function finishedRows(input: {
    agentEvents: RailEvent[];
    runEvents: Record<string, RunEvent[]>;
    seenTs: number;
    project: string;
    agents: AgentVM[];
    lineage: Lineage;
}): FinishedRow[] {
    const { agentEvents, runEvents, seenTs, project, agents, lineage } = input;
    const runLists = Object.entries(runEvents).flatMap(([runId, events]) => {
        const run = lineage.runs[runId];
        return run ? [runRailEvents(run, events, leadAgentOf(lineage, agents, runId)?.id)] : [];
    });
    // unbounded: the rail's cap must not drop a project's finish behind other projects' events
    const merged = mergeRailEvents([agentEvents, ...runLists], Infinity);
    const { fresh } = splitUnread(scopeRailRows(merged, agents, lineage, project), seenTs);
    const seen = new Set<string>();
    const rows: FinishedRow[] = [];
    for (const e of fresh) {
        const id = e.group ?? e.focusId;
        if (!FINISH_KINDS.has(e.kind) || id == null || seen.has(id)) {
            continue;
        }
        seen.add(id);
        rows.push({ id, kind: e.group != null ? "run" : "agent", name: e.who, line: e.text, ts: e.ts });
    }
    return rows;
}

/** Pure: nothing runs and nothing finished unread, so the region collapses to one "Now". */
export function isQuiet(running: RunningRow[], finished: FinishedRow[]): boolean {
    return running.length === 0 && finished.length === 0;
}
