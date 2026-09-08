// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The orchestrator run's execution overview (spec 6.1): health strip, next engine move, worker rows
// (reusing the agent surface's status/activity units), and the attention/merge queue. Renders the
// backend digest as-is; degradation states come from useDagDigest + resolveTaskWorker, never inferred
// healthy. Every claim traces to the digest, the group, or the retained lifecycle events.

import { useAtomValue } from "jotai";
import type { Atom } from "jotai";
import { atom } from "jotai";
import type { ReactNode } from "react";
import { runAtom } from "../agents/channelsstore";
import type { AgentsViewModel } from "../agents/agents";
import type { AgentVM } from "../agents/agentsviewmodel";
import { useRunEvents } from "../agents/runeventstore";
import { ActivityLine, StatusLine } from "../agents/statusline";
import { attentionQueue, type QueueEntry } from "./attentionqueue";
import {
    controlWarning,
    freshCounts,
    healthView,
    lastUpdatedText,
    nextStepView,
    taskBriefs,
    useDagDigest,
    type DigestState,
} from "./dagdigest";
import { openDagTask } from "./dagmodalstate";
import { useDagGroup } from "./dagstore";
import { recoverySummary, recoveryText, type RecoverySummary } from "./recoverysummary";
import { openTaskWorker, resolveTaskWorker, workerActivityText, type TaskWorkerView } from "./taskcorrelate";
import { workerSortKey } from "./workertasksort";

// NavContext is what a row needs to take the reader to the thing it is describing.
type NavContext = {
    channelId: string;
    runId: string;
    dagOref: string;
    model: AgentsViewModel;
    agents: AgentVM[];
};

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
    const events = useRunEvents(runId, channelId);
    const now = useAtomValue(model.nowAtom);
    const digest = digestState.digest;
    const nav: NavContext = { channelId, runId, dagOref, model, agents };

    const health = healthView(digestState);
    const counts = freshCounts(digestState);
    const nextMove = nextStepView(digestState, taskBriefs(group));
    const control = controlWarning(digest);
    const lastUpdated = lastUpdatedText(digestState, now);
    const elapsed = counts ? digest?.durations?.elapsedms : undefined;
    const refreshFailed = digestState.error != null && !digestState.loading;

    return (
        <div className="mb-4 overflow-hidden rounded-xl border border-edge-mid bg-surface">
            {/* health strip: aria-live so a health/attention transition is announced, not every tick */}
            <div className="flex items-center gap-3 border-b border-edge-mid px-3.5 py-2.5">
                <span aria-live="polite" className={health.tone + " text-[13px] font-bold"}>
                    {health.text}
                </span>
                <div className="flex flex-1 flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10.5px] text-muted">
                    <span>{counts ? `${counts.done}/${counts.total} done` : "…"}</span>
                    {elapsed ? <span>{formatElapsed(elapsed)}</span> : null}
                    <span aria-live="polite">{counts?.attention ? `attention ${counts.attention}` : ""}</span>
                    <span>{counts?.mergeready ? `merge ${counts.mergeready}` : ""}</span>
                    {lastUpdated ? <span>{lastUpdated}</span> : null}
                    {control ? <span className="text-warning">⚠ {control}</span> : null}
                    {refreshFailed && digestState.retry ? (
                        <button
                            type="button"
                            onClick={digestState.retry}
                            className="cursor-pointer text-warning underline decoration-dotted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
                        >
                            retry
                        </button>
                    ) : null}
                </div>
            </div>

            {/* next engine move */}
            {nextMove ? (
                <div className="border-b border-edge-mid px-3.5 py-2 font-mono text-[11px] text-secondary">
                    <span className="mr-1.5 text-muted">next:</span>
                    {nextMove}
                </div>
            ) : null}

            {/* attention / merge queue: only actionable exceptions + merge-ready tasks */}
            {digest && !digestState.stale ? <Queue digest={digest} group={group} nav={nav} /> : null}

            {/* worker rows */}
            <div className="flex flex-col px-3.5 py-2">
                {group == null ? (
                    <EmptyRow text="DAG status unavailable" />
                ) : (
                    orderedWorkerRows(group, digest, events, nav, digestState)
                )}
            </div>
        </div>
    );
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
    events: RunEvent[],
    nav: NavContext,
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
            recovery={recoverySummary(events, t.id)}
            nav={nav}
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

// useTaskWorker resolves a task's worker from its child run and the live roster. Shared by the worker
// rows and the attention queue so the two can never disagree about who is running a task.
function useTaskWorker(taskId: string, runId: string | undefined, agents: AgentVM[]): TaskWorkerView {
    const childRun: Run | undefined = useAtomValue<Run | undefined>(
        (runId ? runAtom(runId) : NO_RUN_ATOM) as Atom<Run | undefined>
    );
    return resolveTaskWorker({ id: taskId, runid: runId }, childRun, agents);
}

// WorkerRow resolves the task's worker via the shared correlation (dispatched / pending / unavailable)
// and renders the shared status + activity units. Never falls back to a fabricated worker.
function WorkerRow({
    task,
    td,
    recovery,
    nav,
    digestStale,
}: {
    task: TaskNode;
    td?: DagTaskDigest;
    recovery: RecoverySummary | null;
    nav: NavContext;
    digestStale: boolean;
}) {
    const worker = useTaskWorker(task.id, task.runid, nav.agents);
    const activityText = workerActivityText(worker);

    return (
        <div className="flex min-w-0 items-center gap-2 border-b border-edge-faint py-1.5 last:border-b-0">
            <div className="min-w-0 flex-1">
                {/* task identity, rendered identically in every worker state: a dispatched row used to
                    show only the agent, leaving the reader to infer which task it was executing */}
                <div className="flex min-w-0 items-center gap-2 font-mono text-[11px] text-secondary">
                    <span className="min-w-0 truncate">{task.label || task.id}</span>
                </div>
                {worker.state === "dispatched" && worker.agent ? (
                    <StatusLine agent={worker.agent} nowAtom={nav.model.nowAtom} className="mt-0.5" />
                ) : null}
                {activityText == null && worker.agent ? (
                    <ActivityLine agent={worker.agent} right={null} className="mt-0.5" />
                ) : (
                    <div className="mt-0.5 font-mono text-[10.5px] text-muted">{activityText}</div>
                )}
                {recovery ? <RecoveryLine summary={recovery} task={task} nav={nav} /> : null}
            </div>
            <TaskRowSignal task={task} td={td} worker={worker} nav={nav} digestStale={digestStale} />
        </div>
    );
}

// RecoveryLine is the compact "what already went wrong here" note. It expands into the existing
// lifecycle timeline rather than into a second history of its own: selecting the task is what the
// timeline's task filter reads.
function RecoveryLine({ summary, task, nav }: { summary: RecoverySummary; task: TaskNode; nav: NavContext }) {
    return (
        <button
            type="button"
            onClick={() => openDagTask(nav.channelId, nav.runId, nav.dagOref, task.id)}
            title="Show this task's lifecycle history"
            className="mt-0.5 flex cursor-pointer items-center gap-1 font-mono text-[10px] text-muted hover:text-secondary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        >
            <span className="min-w-0 truncate">{recoveryText(summary, task.state)}</span>
            <span aria-hidden="true">↗</span>
        </button>
    );
}

function TaskRowSignal({
    task,
    td,
    worker,
    nav,
    digestStale,
}: {
    task: TaskNode;
    td?: DagTaskDigest;
    worker: TaskWorkerView;
    nav: NavContext;
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
                    onClick={() => openTaskWorker(worker, nav.model, nav.channelId)}
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
                            onClick={() => openTaskWorker(worker, nav.model, nav.channelId)}
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

// Queue renders only actionable exceptions + merge-ready tasks (spec 6.1.5). Membership and content
// are the pure attentionQueue; this is its presentation and its routing.
function Queue({ digest, group, nav }: { digest: DagStatusDigest; group: TaskGroup | undefined; nav: NavContext }) {
    const entries = attentionQueue(digest, group);
    if (entries.length === 0) {
        return null;
    }
    return (
        <div className="border-b border-edge-mid px-3.5 py-2">
            <div className="mb-1.5 font-mono text-[9.5px] font-semibold uppercase tracking-[.09em] text-muted">
                Needs attention
            </div>
            <div className="flex flex-col gap-1">
                {entries.map((entry) => (
                    <QueueRow key={entry.taskId} entry={entry} nav={nav} />
                ))}
            </div>
        </div>
    );
}

// QueueRow is one attention entry, and it goes where the entry says it goes. The action names come
// from the digest, so a row with no attributed action carries no badge rather than a plausible guess.
function QueueRow({ entry, nav }: { entry: QueueEntry; nav: NavContext }) {
    const worker = useTaskWorker(entry.taskId, entry.runId, nav.agents);
    const openWorker = entry.target === "worker" && worker.state !== "pending";
    const go = () =>
        openWorker
            ? openTaskWorker(worker, nav.model, nav.channelId)
            : openDagTask(nav.channelId, nav.runId, nav.dagOref, entry.taskId);
    return (
        <button
            type="button"
            onClick={go}
            title={openWorker ? "Open the worker" : "Show this task in the DAG"}
            className="flex w-full cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-left font-mono text-[11px] text-secondary hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        >
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-warning" />
            <span className="shrink-0 truncate font-semibold text-primary">{entry.label}</span>
            <span className="min-w-0 flex-1 truncate text-muted">{entry.detail}</span>
            {entry.actions.length > 0 ? (
                <span className="shrink-0 rounded-[5px] border border-edge-mid px-1.5 py-0.5 text-[9.5px] text-ink-mid">
                    {entry.actions.join("/")}
                </span>
            ) : null}
            <span aria-hidden="true" className="shrink-0 text-[9.5px] text-muted">
                ↗
            </span>
        </button>
    );
}
