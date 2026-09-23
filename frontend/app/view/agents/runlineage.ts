// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pure lineage for the Agent surface: which roster agents lead an orchestrator run and which work a task
// under one. Read from the run a tab was spawned for (jarvis:runoref) and that run's dag, with the
// engine's digest for what only it knows: lanes and who holds a question. No React, no Wave runtime.

import { modelLabel } from "@/app/view/agents/session-models/sessionviewmodel";
import { projectOf, type AgentVM } from "./agentsviewmodel";

export type RunRole = { kind: "lead"; runId: string } | { kind: "worker"; leadRunId: string; taskId: string };

// RunInfo is one orchestrator run as the tree and header show it, keyed by the lead's run id.
export interface RunInfo {
    runId: string;
    channelId: string;
    title: string;
    // the lead's project, or the run's checkout for a run with no lead in the roster
    project: string;
    // whether the run has ever had a lead session, so a run with none in the roster can say which it is
    leadStarted?: boolean;
    // the run's own status, the only truth for a run that has no dag to measure progress against
    status?: string;
    dag?: TaskGroup;
    digest?: DagStatusDigest;
}

export interface Lineage {
    roles: Record<string, RunRole>; // by agent id
    runs: Record<string, RunInfo>; // by lead run id
}

export const NO_LINEAGE: Lineage = { roles: {}, runs: {} };

// runRoleOf is an agent's part in a run. A dag's owning run is its lead's, and any other run holding the
// dag is a task's child run. An orchestrator run with no dag yet, or whose dag has not loaded, is a lead.
// Anything else is a plain agent: a Quick run, or a child the engine no longer links that carries no task id.
export function runRoleOf(run: Run | undefined, dag: TaskGroup | undefined, stampedTaskId?: string): RunRole | null {
    if (run == null) {
        return null;
    }
    if (run.dagoref && dag != null) {
        if (dag.runid === run.oid) {
            return { kind: "lead", runId: run.oid };
        }
        const tasks = dag.tasks ?? [];
        // a task's reviewer works that task too, so it nests under the lead beside the worker it follows. the
        // engine unlinks a run once it is over (a verdict applied, a retry dispatched) while its tab can live on,
        // and a relaunch leaves such a tab for good; the task id stamped on it at spawn still places it
        const task =
            tasks.find((t) => t.runid === run.oid || t.reviewrunid === run.oid) ??
            (stampedTaskId ? tasks.find((t) => t.id === stampedTaskId) : undefined);
        return task ? { kind: "worker", leadRunId: dag.runid, taskId: task.id } : null;
    }
    return run.mode === "orchestrator" ? { kind: "lead", runId: run.oid } : null;
}

// holdsTask reports whether agent's run is the one taskId currently points at, its worker or its reviewer, rather
// than a tab left from an earlier attempt or a finished review.
export function holdsTask(run: RunInfo, taskId: string, agent: Pick<AgentVM, "runId">): boolean {
    const task = run.dag?.tasks?.find((t) => t.id === taskId);
    return task != null && agent.runId != null && (task.runid === agent.runId || task.reviewrunid === agent.runId);
}

// leadAgentOf finds the roster agent leading runId, if it is in the roster.
export function leadAgentOf<T extends { id: string }>(lineage: Lineage, agents: T[], runId: string): T | undefined {
    return agents.find((a) => {
        const role = lineage.roles[a.id];
        return role?.kind === "lead" && role.runId === runId;
    });
}

// agentProject is the project an agent is shown under. A worker's own is the engine's worktree, so it reads
// its lead's, else its run's checkout.
export function agentProject(lineage: Lineage, agents: AgentVM[], agent: AgentVM): string {
    const role = lineage.roles[agent.id];
    if (role?.kind !== "worker") {
        return projectOf(agent);
    }
    const lead = leadAgentOf(lineage, agents, role.leadRunId);
    return lead ? projectOf(lead) : (lineage.runs[role.leadRunId]?.project ?? "");
}

// taskAgentOf finds the roster agent working taskId of runId, if it is in the roster: the task's current one
// before a tab an earlier run left on it.
export function taskAgentOf<T extends { id: string; runId?: string }>(
    lineage: Lineage,
    agents: T[],
    runId: string,
    taskId: string
): T | undefined {
    const onTask = agents.filter((a) => {
        const role = lineage.roles[a.id];
        return role?.kind === "worker" && role.leadRunId === runId && role.taskId === taskId;
    });
    const run = lineage.runs[runId];
    return (run && onTask.find((a) => holdsTask(run, taskId, a))) ?? onTask[0];
}

const ENDED_WORKER_PREFIX = "ended:";

// endedWorkerId is what a done task's worker is focused by. Its session has ended, so the surface reads it back
// from its transcript, whether or not its tab is still in the roster.
export function endedWorkerId(runId: string, taskId: string): string {
    return `${ENDED_WORKER_PREFIX}${runId}:${taskId}`;
}

export function isEndedWorkerId(id: string): boolean {
    return id.startsWith(ENDED_WORKER_PREFIX);
}

// endedRoles gives each done task of the runs in view a worker role under its ended id, so the header and the
// rail place a done worker as they place a live one.
export function endedRoles(runs: Record<string, RunInfo>): Record<string, RunRole> {
    const roles: Record<string, RunRole> = {};
    for (const run of Object.values(runs)) {
        for (const task of run.dag?.tasks ?? []) {
            if (task.state === "done") {
                roles[endedWorkerId(run.runId, task.id)] = { kind: "worker", leadRunId: run.runId, taskId: task.id };
            }
        }
    }
    return roles;
}

// endedWorkerVM is a done task's worker as the Agent surface shows it, from the child run the task last ran:
// idle since that run completed, and read from the transcript its session wrote.
export function endedWorkerVM(runId: string, task: TaskNode, child: Run | undefined, transcriptPath?: string): AgentVM {
    return {
        id: endedWorkerId(runId, task.id),
        name: task.label || task.id,
        task: task.label ?? "",
        state: "idle",
        agent: child?.runtime || undefined,
        model: modelLabel(child?.model),
        idleSince: child?.completedts,
        transcriptPath: transcriptPath || undefined,
        runId: task.runid,
    };
}

// runTitle names a run by its plan's title, else the first line of its goal.
export function runTitle(run: Run | undefined, dag: TaskGroup | undefined): string {
    const title = dag?.title?.trim();
    if (title) {
        return title;
    }
    return run?.goal?.trim().split("\n")[0] || "Orchestrator run";
}

// laneLabel is the letter a task's lane goes by, in the plan order the digest lists lanes in.
export function laneLabel(digest: DagStatusDigest | undefined, taskId: string): string | undefined {
    const i = (digest?.lanes ?? []).findIndex((lane) => lane.includes(taskId));
    if (i < 0) {
        return undefined;
    }
    return i < 26 ? String.fromCharCode(65 + i) : String(i + 1);
}

export type WorkerAsk = { owner: "lead"; deadline?: number } | { owner: "you" };

// workerAsk says who holds a task's open question, if it has one.
export function workerAsk(digest: DagStatusDigest | undefined, taskId: string): WorkerAsk | undefined {
    const td = digest?.tasks?.find((t) => t.taskid === taskId);
    if (td?.waitreason === "lead-ask") {
        return { owner: "lead", deadline: td.askdeadline };
    }
    if (td?.waitreason === "ask") {
        return { owner: "you" };
    }
    return undefined;
}

export function formatLeft(ms: number): string {
    return ms < 60_000 ? "<1m left" : `${Math.floor(ms / 60_000)}m left`;
}

export interface WorkerLine {
    taskId: string;
    lane?: string;
    age: string;
    ask?: WorkerAsk;
    // a finished task's outcome ("landed" / "done")
    outcome?: string;
    // a task that has not started: the dependencies it still waits on (empty = just queued)
    waits?: string[];
}

// workerSubtext is a worker row's second line, led by its task id since the row's title is the task's label:
// what it came to, what it waits on, whose turn its question is, else its lane and age.
export function workerSubtext(w: WorkerLine): string {
    const lane = w.lane ? `lane ${w.lane}` : "";
    let tail: string[];
    if (w.outcome) {
        tail = [lane, w.outcome];
    } else if (w.waits) {
        tail = [lane, w.waits.length > 0 ? `waits on ${w.waits.join(", ")}` : "queued"];
    } else if (w.ask?.owner === "lead") {
        tail = ["asked the lead", w.age];
    } else if (w.ask?.owner === "you") {
        tail = ["asks you", w.age];
    } else {
        tail = [lane, w.age];
    }
    return [w.taskId, ...tail].filter(Boolean).join(" · ");
}

const NOT_STARTED = new Set(["pending", "ready"]);

// unmetDeps is what a not-started task still waits on, or undefined once it has started.
export function unmetDeps(dag: TaskGroup | undefined, task: TaskNode): string[] | undefined {
    if (!NOT_STARTED.has(task.state)) {
        return undefined;
    }
    const byId = new Map((dag?.tasks ?? []).map((t) => [t.id, t] as const));
    return (task.deps ?? []).filter((d) => byId.get(d)?.state !== "done");
}

// runProgress counts a run's finished tasks: done or skipped, out of every task in the plan.
export function runProgress(dag: TaskGroup | undefined): { done: number; total: number } {
    const tasks = dag?.tasks ?? [];
    return { done: tasks.filter((t) => t.state === "done" || t.state === "skipped").length, total: tasks.length };
}

// leadStandingBy reports a lead sitting at its prompt while its run's plan executes: between wakes it only waits
// for the engine, and the roster's folding of waiting into working would read that as busy.
export function leadStandingBy(agent: Pick<AgentVM, "atPrompt">, run: RunInfo): boolean {
    const status = run.dag?.status;
    return agent.atPrompt === true && run.dag != null && status !== "done" && status !== "cancelled";
}
