// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The workspace pane's Run tab (boards RunTasks and RunGraph): a run's head, then its Tasks, Asks, Activity and Graph
// views, the choice kept on the tab. The pieces are the rail's (its lane dots, ask cards, activity rows), the
// orchestrator sheet's answerable ask and the DAG modal's graph; workspaceruntabmodel.ts derives what they say.

import { indicatorSlide } from "@/app/element/motiontokens";
import { TickNumber } from "@/app/element/ticknumber";
import { ViewSwap } from "@/app/element/viewswap";
import { formatElapsed } from "@/app/view/orchestrate/dagdigest";
import { DagGraphView } from "@/app/view/orchestrate/daggraph";
import { setDagModalAgentsContext } from "@/app/view/orchestrate/dagmodalstate";
import { cn } from "@/util/util";
import { atom, useAtomValue, type Atom } from "jotai";
import { motion } from "motion/react";
import { useEffect } from "react";
import type { AgentsViewModel } from "./agents";
import { formatTokens, type AgentVM } from "./agentsviewmodel";
import { runAtom } from "./channelsstore";
import { ChildAskEntry, useChildAskRefresh } from "./childaskcard";
import { ASK_OWNER_USER, childAskKey } from "./childaskmodel";
import { harnessesAtom } from "./harnessstore";
import type { RunInfo } from "./runlineage";
import { useRunInfo } from "./runlineagestore";
import { runLog } from "./runrail";
import { ActivityRow, LANE_DOT, LANE_TEXT, LeadAskCard, useRunAsks } from "./runrailsections";
import { SEG_FILL, taskStrip } from "./runstrip";
import { tsLabel } from "./runtimeline";
import { useRunUsage } from "./runtokenstore";
import { estimateText, summarizeUsage } from "./runusage";
import { tabKey, type RunView, type WorkspaceTab } from "./workspacemodel";
import {
    answeredAsks,
    runHead,
    runTabCounts,
    taskRows,
    type RunHeadView,
    type RunTabCounts,
    type TaskRowView,
} from "./workspaceruntabmodel";
import { updateWorkspaceTab } from "./workspacestore";

type RunTabProps = {
    model: AgentsViewModel;
    agent: AgentVM;
    tab: Extract<WorkspaceTab, { kind: "run" }>;
};

const VIEWS: { view: RunView; label: string; count?: keyof RunTabCounts }[] = [
    { view: "tasks", label: "Tasks", count: "tasks" },
    { view: "asks", label: "Asks", count: "asks" },
    { view: "activity", label: "Activity", count: "activity" },
    { view: "graph", label: "Graph" },
];

const HEAD_DOT: Record<RunHeadView["state"]["tone"], string> = {
    live: "bg-success",
    done: "bg-success",
    muted: "bg-muted",
};

const TASK_GRID = "grid grid-cols-[minmax(0,1fr)_132px_64px_82px] gap-[10px]";
const LABEL = "font-mono text-[10.5px] font-bold uppercase tracking-[.1em]";

// the run by its id: loading and not-found say so, rather than an empty tab
export function RunTab({ model, agent, tab }: RunTabProps) {
    const { run, loaded } = useRunInfo(tab.runId);
    if (run == null) {
        return (
            <div data-workspace-run-missing className="p-[18px] text-[12.5px] text-muted">
                {loaded ? `Arc cannot find run ${tab.runId}.` : "Loading the run…"}
            </div>
        );
    }
    return <RunTabBody model={model} agent={agent} tab={tab} run={run} />;
}

function RunTabBody({ model, agent, tab, run }: RunTabProps & { run: RunInfo }) {
    const now = useAtomValue(model.nowAtom);
    const asks = useRunAsks(run);
    const events = useChildAskRefresh(run.channelId, run.runId);
    const head = runHead(run, asks, now);
    const counts = runTabCounts(run, asks, events);
    const pick = (view: RunView) => updateWorkspaceTab(agent.id, tabKey(tab), { view });
    return (
        <div data-workspace-run={run.runId} className="flex min-h-0 flex-1 flex-col">
            <RunHead run={run} head={head} />
            <div
                role="tablist"
                aria-label="Run views"
                className="mx-[18px] flex flex-none gap-[18px] border-b border-edge-faint"
            >
                {VIEWS.map((v) => (
                    <ViewButton
                        key={v.view}
                        label={v.label}
                        view={v.view}
                        count={v.count ? counts[v.count] : undefined}
                        active={tab.view === v.view}
                        onPick={pick}
                    />
                ))}
            </div>
            <ViewSwap swapKey={tab.view} className="flex min-h-0 flex-1 flex-col overflow-y-auto">
                {tab.view === "tasks" ? (
                    <TasksView model={model} run={run} asks={asks} events={events} />
                ) : tab.view === "asks" ? (
                    <AsksView model={model} run={run} asks={asks} events={events} />
                ) : tab.view === "activity" ? (
                    <ActivityView events={events} />
                ) : (
                    <GraphView model={model} run={run} />
                )}
            </ViewSwap>
        </div>
    );
}

function RunHead({ run, head }: { run: RunInfo; head: RunHeadView }) {
    const strip = taskStrip(run.dag, run.digest);
    return (
        <div data-workspace-run-head className="flex flex-none flex-col gap-[8px] px-[18px] pb-[6px] pt-[14px]">
            <div className="flex items-baseline gap-[10px]">
                <span className="min-w-0 flex-1 truncate text-[15px] font-semibold text-primary">{head.title}</span>
                <span
                    data-workspace-run-state={head.state.tone}
                    className="inline-flex flex-none items-center gap-[5px] text-[12px] text-secondary"
                >
                    <span className={cn("h-[6px] w-[6px] rounded-full", HEAD_DOT[head.state.tone])} />
                    {head.state.text}
                </span>
            </div>
            <div data-workspace-run-line className="truncate font-mono text-[11px] text-muted">
                {head.line}
            </div>
            {strip ? (
                <div className="flex h-[4px] gap-[3px]">
                    {strip.kind === "segments" ? (
                        strip.states.map((st, i) => (
                            <span key={i} className={cn("min-w-[2px] flex-1 rounded-[2px]", SEG_FILL[st])} />
                        ))
                    ) : (
                        <>
                            <span className="min-w-0 rounded-[2px] bg-success" style={{ flexGrow: strip.done }} />
                            <span
                                className="min-w-0 rounded-[2px] bg-edge-strong"
                                style={{ flexGrow: strip.total - strip.done }}
                            />
                        </>
                    )}
                </div>
            ) : null}
            {head.needsYou ? (
                <div data-workspace-run-needs className="text-[12px]">
                    <span className="font-semibold text-warning">Needs you</span>
                    {head.needsYou.then ? <span className="text-muted"> · then {head.needsYou.then}</span> : null}
                </div>
            ) : null}
        </div>
    );
}

function ViewButton({
    label,
    view,
    count,
    active,
    onPick,
}: {
    label: string;
    view: RunView;
    count: number | undefined;
    active: boolean;
    onPick: (view: RunView) => void;
}) {
    return (
        <button
            type="button"
            role="tab"
            aria-selected={active}
            data-run-view={view}
            onClick={() => onPick(view)}
            className={cn(
                "relative -mb-px inline-flex cursor-pointer items-baseline gap-[6px] pb-[9px] pt-[8px] text-[13px] font-semibold",
                active ? "text-primary" : "text-muted hover:text-secondary"
            )}
        >
            {label}
            {count != null ? (
                <span className="font-mono text-[11px] font-normal text-muted">
                    <TickNumber value={count} />
                </span>
            ) : null}
            {active ? (
                <motion.span
                    layoutId="workspace-run-view-indicator"
                    data-run-view-indicator
                    aria-hidden
                    transition={indicatorSlide}
                    className="absolute inset-x-0 bottom-0 h-[2px] bg-accent"
                />
            ) : null}
        </button>
    );
}

function TasksView({
    model,
    run,
    asks,
    events,
}: {
    model: AgentsViewModel;
    run: RunInfo;
    asks: DagAskItem[];
    events: RunEvent[];
}) {
    const now = useAtomValue(model.nowAtom);
    const rows = taskRows(run.dag, run.digest, now);
    const yours = asks.filter((a) => a.owner === ASK_OWNER_USER);
    if (rows.length === 0) {
        return <Empty>No plan submitted yet, so there are no tasks.</Empty>;
    }
    return (
        <div className="px-[12px] py-[8px]">
            <div className={cn(TASK_GRID, LABEL, "px-[8px] py-[6px] text-muted")}>
                <span>Task</span>
                <span>State</span>
                <span className="text-right">Time</span>
                <span className="text-right">Changes</span>
            </div>
            {rows.map((r) => (
                <TaskRow
                    key={r.id}
                    row={r}
                    task={run.dag?.tasks.find((t) => t.id === r.id)}
                    asks={yours.filter((a) => a.taskid === r.id)}
                    run={run}
                    events={events}
                />
            ))}
            <RunTotals run={run} />
        </div>
    );
}

// a task not dispatched yet reads no run; a static atom keeps the hook count fixed
const NO_RUN_ATOM: Atom<Run | undefined> = atom<Run | undefined>(undefined);

function TaskRow({
    row,
    task,
    asks,
    run,
    events,
}: {
    row: TaskRowView;
    task: TaskNode | undefined;
    asks: DagAskItem[];
    run: RunInfo;
    events: RunEvent[];
}) {
    // a task's changes are its worker run's sealed evidence; a task still working has none yet
    const child = useAtomValue<Run | undefined>(task?.runid ? runAtom(task.runid) : NO_RUN_ATOM);
    const evidence = child?.evidence;
    return (
        <div data-workspace-run-task={row.id} className={cn("rounded-[8px]", asks.length > 0 && "bg-surface-raised")}>
            <div className={cn(TASK_GRID, "items-center p-[8px]")}>
                <div className="min-w-0">
                    <div
                        className={cn(
                            "truncate font-mono text-[12px] font-medium",
                            row.tone === "pending" ? "text-ink-mid" : "text-ink-hi"
                        )}
                    >
                        {row.name}
                    </div>
                    {row.sub ? <div className="truncate font-mono text-[10.5px] text-muted">{row.sub}</div> : null}
                </div>
                <span
                    data-workspace-run-task-state
                    className={cn(
                        "flex min-w-0 items-center gap-[6px] font-mono text-[11px] font-medium",
                        LANE_TEXT[row.tone]
                    )}
                >
                    <span className={cn("h-[7px] w-[7px] flex-none rounded-full", LANE_DOT[row.tone])} />
                    <span className="truncate">{row.state}</span>
                </span>
                <span className="text-right font-mono text-[11px] text-secondary">{row.time}</span>
                <span className="text-right font-mono text-[11px]">
                    {evidence && (evidence.addtotal > 0 || evidence.deltotal > 0) ? (
                        <>
                            <span className="text-success">+{evidence.addtotal}</span>{" "}
                            <span className="text-error">−{evidence.deltotal}</span>
                        </>
                    ) : null}
                </span>
            </div>
            {asks.map((a) => (
                <div
                    key={childAskKey(a)}
                    data-workspace-run-ask={a.taskid}
                    className="mx-[8px] mb-[10px] rounded-[10px] border border-warning/45 bg-warning/[0.12] px-[12px] py-[11px]"
                >
                    <ChildAskEntry channelId={run.channelId} runId={run.runId} ask={a} events={events} />
                </div>
            ))}
        </div>
    );
}

// what the run has cost so far: its api-equivalent spend, its tokens, and its workers' time once reported
function RunTotals({ run }: { run: RunInfo }) {
    const usage = useRunUsage(run.channelId, run.runId);
    const spent = summarizeUsage(usage?.rows);
    const workerMs = run.digest?.report?.workerms;
    const facts = [
        spent && estimateText(spent) ? ["Spent", estimateText(spent)] : null,
        spent ? ["Tokens", formatTokens(spent.total)] : null,
        workerMs ? ["Worker time", formatElapsed(workerMs)] : null,
    ].filter((f): f is [string, string] => f != null);
    if (facts.length === 0) {
        return null;
    }
    return (
        <div
            data-workspace-run-totals
            className="mx-[8px] mt-[14px] flex gap-[24px] border-t border-edge-faint pt-[12px] font-mono text-[11px] text-muted"
        >
            {facts.map(([label, value]) => (
                <span key={label}>
                    {label} <span className="text-secondary">{value}</span>
                </span>
            ))}
        </div>
    );
}

// questions waiting on you first, answerable here, then the lead's, which you can take over, then the answered ones
function AsksView({
    model,
    run,
    asks,
    events,
}: {
    model: AgentsViewModel;
    run: RunInfo;
    asks: DagAskItem[];
    events: RunEvent[];
}) {
    const answered = answeredAsks(events);
    if (asks.length === 0 && answered.length === 0) {
        return <Empty>No questions on this run yet.</Empty>;
    }
    return (
        <div className="flex flex-col gap-[12px] px-[18px] py-[14px]">
            {asks.map((a) =>
                a.owner === ASK_OWNER_USER ? (
                    <div
                        key={childAskKey(a)}
                        data-workspace-run-ask={a.taskid}
                        className="rounded-[10px] border border-warning/45 bg-warning/[0.12] px-[12px] py-[11px]"
                    >
                        <div className={cn(LABEL, "text-warning")}>
                            {a.taskid} asks you · {tsLabel(a.ts)}
                        </div>
                        <ChildAskEntry channelId={run.channelId} runId={run.runId} ask={a} events={events} />
                    </div>
                ) : (
                    <LeadAskCard key={childAskKey(a)} model={model} run={run} ask={a} />
                )
            )}
            {answered.map((a) => (
                <div
                    key={a.key}
                    data-workspace-run-answered={a.taskId}
                    className="flex flex-col gap-[6px] rounded-[10px] border border-edge-faint px-[12px] py-[11px]"
                >
                    <span className={cn(LABEL, "text-muted")}>
                        {a.taskId} asked · answered {tsLabel(a.answeredTs)}
                    </span>
                    {a.question ? (
                        <span className="text-[13px] leading-[1.45] text-secondary">{a.question}</span>
                    ) : null}
                </div>
            ))}
        </div>
    );
}

// every event of the run, newest first
function ActivityView({ events }: { events: RunEvent[] }) {
    const log = runLog(events, events.length);
    if (log.length === 0) {
        return <Empty>Nothing has happened on this run yet.</Empty>;
    }
    return (
        <div data-workspace-run-activity className="flex flex-col gap-[8px] px-[18px] py-[14px]">
            {log.map((l) => (
                <ActivityRow key={l.id} ts={l.ts} text={l.text} className="gap-[12px] text-[11.5px]" />
            ))}
        </div>
    );
}

// the DAG modal's graph, static and without its header: the head above already names the run. A selected task's
// card opens its agent, which needs the roster the modal otherwise gets from the Brief.
function GraphView({ model, run }: { model: AgentsViewModel; run: RunInfo }) {
    const owner = useAtomValue(runAtom(run.runId));
    const harnesses = useAtomValue(harnessesAtom);
    const agents = useAtomValue(model.agentsAtom);
    useEffect(() => {
        setDagModalAgentsContext(model, agents);
    }, [model, agents]);
    if (run.dag == null || owner == null) {
        return <Empty>No plan submitted yet, so there is no graph.</Empty>;
    }
    return (
        <div data-workspace-run-graph className="flex min-h-[360px] flex-1 flex-col">
            <DagGraphView oref={`dag:${run.dag.oid}`} owner={owner} harnesses={harnesses} embedded />
        </div>
    );
}

function Empty({ children }: { children: React.ReactNode }) {
    return <div className="px-[18px] py-[14px] text-[12.5px] text-muted">{children}</div>;
}
