// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The orchestrator run's execution overview (spec 6.1): health strip, next engine move, worker rows
// (reusing the agent surface's status/activity units), and the attention/merge queue. Renders the
// backend digest as-is; degradation states come from useDagDigest + resolveTaskWorker, never inferred
// healthy.

import { useAtomValue } from "jotai";
import type { Atom } from "jotai";
import { atom } from "jotai";
import type { ReactNode } from "react";
import { runAtom } from "../agents/channelsstore";
import type { AgentsViewModel } from "../agents/agents";
import type { AgentVM } from "../agents/agentsviewmodel";
import { ActivityLine, StatusLine } from "../agents/statusline";
import { useDagDigest, nextStepText, type DigestState } from "./dagdigest";
import { useDagGroup } from "./dagstore";
import { resolveTaskWorker, openTaskWorker, type TaskWorkerView } from "./taskcorrelate";
import { workerSortKey } from "./workertasksort";

export function DagOverview({
    channelId,
    runId,
    dagOref,
    model,
    agents,
}: {
    channelId: string;
    runId: string;
    dagOref: string;
    model: AgentsViewModel;
    agents: AgentVM[];
}) {
    const digestState = useDagDigest(channelId, runId, dagOref);
    const [group] = useDagGroup(dagOref);
    const digest = digestState.digest;

    const healthTone = healthToneFor(digestState);
    const elapsed = digest?.durations?.elapsedms;

    return (
        <div className="mb-4 overflow-hidden rounded-xl border border-edge-mid bg-surface">
            {/* health strip */}
            <div className="flex items-center gap-3 border-b border-edge-mid px-3.5 py-2.5">
                <span className={healthTone + " text-[13px] font-bold"}>{digestState.stale ? "Refreshing status" : digest?.health ?? "DAG status unavailable"}</span>
                <div className="flex flex-1 flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10.5px] text-muted">
                    <span>{digest?.counts ? `${digest.counts.done}/${digest.counts.total} done` : "…"}</span>
                    {elapsed ? <span>{formatElapsed(elapsed)}</span> : null}
                    <span>{digest?.counts?.attention ? `attention ${digest.counts.attention}` : ""}</span>
                    <span>{digest?.counts?.mergeready ? `merge ${digest.counts.mergeready}` : ""}</span>
                </div>
            </div>

            {/* next engine move */}
            {digest ? (
                <div className="border-b border-edge-mid px-3.5 py-2 font-mono text-[11px] text-secondary">
                    <span className="mr-1.5 text-muted">next:</span>
                    {nextStepText(digest.next)}
                </div>
            ) : null}

            {/* attention / merge queue: only actionable exceptions + merge-ready tasks */}
            {digest ? <Queue digest={digest} group={group} /> : null}

            {/* worker rows */}
            <div className="flex flex-col px-3.5 py-2">
                {group == null ? (
                    <EmptyRow text="DAG status unavailable" />
                ) : (
                    orderedWorkerRows(group, digest, channelId, model, agents, digestState)
                )}
            </div>
        </div>
    );
}

function healthToneFor(state: DigestState): string {
    if (state.stale) {
        return "text-muted";
    }
    switch (state.digest?.health) {
        case "needs-you":
            return "text-warning";
        case "stalled":
            return "text-error";
        case "done":
        case "cancelled":
            return "text-muted";
        default:
            return "text-success";
    }
}

function formatElapsed(ms: number): string {
    const s = Math.floor(ms / 1000);
    if (s < 60) {
        return `${s}s`;
    }
    const m = Math.floor(s / 60);
    if (m < 60) {
        return `${m}m`;
    }
    return `${Math.floor(m / 60)}h${m % 60}m`;
}

function EmptyRow({ text }: { text: string }) {
    return <div className="py-1 font-mono text-[11px] text-muted">{text}</div>;
}

// orderedWorkerRows renders each task as a worker row in exception-first order (spec 6.1). Rows never
// re-derive scheduler policy; the digest + group are rendered as-is.
function orderedWorkerRows(
    group: TaskGroup,
    digest: DagStatusDigest | undefined,
    channelId: string,
    model: AgentsViewModel,
    agents: AgentVM[],
    digestState: DigestState
): ReactNode {
    const taskDigestById = new Map<string, DagTaskDigest>();
    for (const td of digest?.tasks ?? []) {
        taskDigestById.set(td.taskid, td);
    }
    const sorted = [...group.tasks]
        .map((t, i) => ({ t, i, td: taskDigestById.get(t.id) }))
        .sort((a, b) => {
            const k = workerSortKey(a.td ?? emptyDigest(a.t.id), a.t) - workerSortKey(b.td ?? emptyDigest(b.t.id), b.t);
            return k !== 0 ? k : a.i - b.i;
        });
    return sorted.map(({ t, td }) => (
        <WorkerRow
            key={t.id}
            task={t}
            td={td}
            channelId={channelId}
            model={model}
            agents={agents}
            digestStale={digestState.stale}
        />
    ));
}

function emptyDigest(taskId: string): DagTaskDigest {
    return { taskid: taskId, waitreason: "", mergestate: "not-required", cleanupstate: "clear" };
}

// stable no-run atom for a task that has not been dispatched (runAtom is oref-cached, so per-run
// atoms keep identity across renders; a static Atom is needed for the no-run slot so the row's hook
// count never varies)
const NO_RUN_ATOM = atom<Run | undefined>(undefined);

// WorkerRow resolves the task's worker via the shared correlation (dispatched / pending / unavailable)
// and renders the shared status + activity units. Never falls back to a fabricated worker.
function WorkerRow({
    task,
    td,
    channelId,
    model,
    agents,
    digestStale,
}: {
    task: TaskNode;
    td?: DagTaskDigest;
    channelId: string;
    model: AgentsViewModel;
    agents: AgentVM[];
    digestStale: boolean;
}) {
    const childRun: Run | undefined = useAtomValue<Run | undefined>(
        (task.runid ? runAtom(task.runid) : NO_RUN_ATOM) as Atom<Run | undefined>
    );
    const worker: TaskWorkerView = resolveTaskWorker({ id: task.id, runid: task.runid }, childRun, agents);

    return (
        <div className="flex min-w-0 items-center gap-2 border-b border-edge-faint py-1.5 last:border-b-0">
            <div className="min-w-0 flex-1">
                {worker.state === "dispatched" && worker.agent ? (
                    <StatusLine agent={worker.agent} nowAtom={model.nowAtom} />
                ) : (
                    <div className="flex min-w-0 items-center gap-2 font-mono text-[11px] text-secondary">
                        <span className="shrink-0 truncate">{task.label || task.id}</span>
                    </div>
                )}
                <ActivityLine
                    agent={worker.state === "dispatched" && worker.agent ? worker.agent : idleAgent(task.label || task.id)}
                    right={null}
                    className="mt-0.5"
                />
            </div>
            <TaskRowSignal task={task} td={td} worker={worker} channelId={channelId} model={model} digestStale={digestStale} />
        </div>
    );
}

function idleAgent(name: string): AgentVM {
    return { id: "", name, task: "", state: "idle" };
}

function TaskRowSignal({
    task,
    td,
    worker,
    channelId,
    model,
    digestStale,
}: {
    task: TaskNode;
    td?: DagTaskDigest;
    worker: TaskWorkerView;
    channelId: string;
    model: AgentsViewModel;
    digestStale: boolean;
}) {
    const actions = td?.humanactions ?? [];
    return (
        <div className="flex shrink-0 items-center gap-1.5">
            {actions.length > 0 ? (
                <span className="rounded-[5px] border border-edge-mid px-1.5 py-0.5 font-mono text-[9.5px] text-ink-mid">
                    {actions.join("/")}
                </span>
            ) : null}
            {worker.state === "dispatched" ? (
                <button
                    type="button"
                    onClick={() => openTaskWorker(worker, model, channelId)}
                    className="cursor-pointer rounded-[5px] border border-accent/50 px-1.5 py-0.5 font-mono text-[9.5px] font-semibold text-accent-soft hover:border-accent"
                >
                    Open in Agent ↗
                </button>
            ) : worker.state === "unavailable" ? (
                <div className="flex items-center gap-1.5">
                    <span className="font-mono text-[9.5px] text-muted">
                        {task.runid ? (digestStale ? "Refreshing status" : "Worker session unavailable") : "Not dispatched yet"}
                    </span>
                    {task.runid ? (
                        <button
                            type="button"
                            onClick={() => openTaskWorker(worker, model, channelId)}
                            className="cursor-pointer rounded-[5px] border border-edge-mid px-1.5 py-0.5 font-mono text-[9.5px] text-secondary hover:border-edge-strong"
                        >
                            View child run
                        </button>
                    ) : null}
                </div>
            ) : null}
        </div>
    );
}

// Queue renders only actionable exceptions + merge-ready tasks (spec 6.1.5). Completed/plain-waiting
// tasks never land here.
function Queue({ digest, group }: { digest: DagStatusDigest; group: TaskGroup | undefined }) {
    const tasks = (group?.tasks ?? []).filter((t) => {
        const td = digest.tasks.find((d) => d.taskid === t.id);
        if (td == null) {
            return false;
        }
        if (td.waitreason === "ask" || td.waitreason === "failure") {
            return true;
        }
        if (td.cleanupstate === "failed") {
            return true;
        }
        if (t.state === "failed" || t.state === "stalled" || t.state === "blocked-merge") {
            return true;
        }
        return td.mergestate === "ready";
    });
    if (tasks.length === 0) {
        return null;
    }
    return (
        <div className="border-b border-edge-mid px-3.5 py-2">
            <div className="mb-1.5 font-mono text-[9.5px] font-semibold uppercase tracking-[.09em] text-muted">
                Needs attention
            </div>
            <div className="flex flex-col gap-1">
                {tasks.map((t) => {
                    const td = digest.tasks.find((d) => d.taskid === t.id);
                    const label = td?.asksummary ? `ask: ${td.asksummary}` : `${t.label || t.id} · ${stateLabel(t, td)}`;
                    return (
                        <div key={t.id} className="flex items-center gap-2 font-mono text-[11px] text-secondary">
                            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-warning" />
                            <span className="min-w-0 flex-1 truncate">{label}</span>
                            {td?.asksummary ? <span className="shrink-0 font-mono text-[9.5px] text-muted">{t.id}</span> : null}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

function stateLabel(t: TaskNode, td?: DagTaskDigest): string {
    if (td?.mergestate === "ready") {
        return "merge ready";
    }
    if (td?.cleanupstate === "failed") {
        return "cleanup failed";
    }
    return t.state;
}