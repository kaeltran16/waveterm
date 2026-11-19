// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The workspace pane's Run tab: a run's head (title, state, the Tasks | Activity | Graph control, the facts and spend
// lines, the task strip), then the chosen view, the choice kept on the tab. Each view is its own file
// (workspaceruntasks, workspacerunactivity, workspacerungraph); workspaceruntabmodel.ts derives what the head says.

import { morphTransition } from "@/app/element/motiontokens";
import { TickNumber } from "@/app/element/ticknumber";
import { ViewSwap } from "@/app/element/viewswap";
import { openTarget } from "@/app/view/jarvis/openref";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { ArrowUpRight } from "lucide-react";
import { motion } from "motion/react";
import type { AgentsViewModel } from "./agents";
import type { AgentVM } from "./agentsviewmodel";
import { useChildAskRefresh } from "./childaskcard";
import type { RunInfo } from "./runlineage";
import { useRunInfo } from "./runlineagestore";
import { useRunAsks } from "./runrailsections";
import { useRunUsage } from "./runtokenstore";
import { tabKey, type RunView, type WorkspaceTab } from "./workspacemodel";
import { ActivityView } from "./workspacerunactivity";
import { GraphView } from "./workspacerungraph";
import { dagFocusTask } from "./workspacerungraphmodel";
import {
    headStrip,
    runHead,
    runTabCounts,
    spendLine,
    STRIP_FILL,
    type RunHeadView,
    type RunTabCounts,
} from "./workspaceruntabmodel";
import { TasksView } from "./workspaceruntasks";
import { updateWorkspaceTab } from "./workspacestore";

type RunTabProps = {
    model: AgentsViewModel;
    agent: AgentVM;
    tab: Extract<WorkspaceTab, { kind: "run" }>;
};

// what every view gets, so a view's body changes without touching the shell
export type RunViewProps = RunTabProps & { run: RunInfo; asks: DagAskItem[]; events: RunEvent[] };

const VIEWS: { view: RunView; label: string; count?: keyof RunTabCounts }[] = [
    { view: "tasks", label: "Tasks", count: "tasks" },
    { view: "activity", label: "Activity", count: "activity" },
    { view: "graph", label: "Graph" },
];

const HEAD_DOT: Record<RunHeadView["state"]["tone"], string> = {
    live: "bg-success",
    done: "bg-success",
    muted: "bg-muted",
};

const FACT_LINE = "truncate font-mono text-[11px] text-muted";

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
    const counts = runTabCounts(run, events);
    const pick = (view: RunView) => updateWorkspaceTab(agent.id, tabKey(tab), { view });
    const props: RunViewProps = { model, agent, tab, run, asks, events };
    const dag = run.dag;
    // on the focused task while the graph is in Focus. Through the router: the modal is mounted on Jarvis, not here,
    // so setting its state alone opened nothing
    const openDag = dag
        ? () =>
              fireAndForget(() =>
                  openTarget(model, { kind: "dag", dagId: dag.oid, taskId: dagFocusTask(tab.graph) ?? undefined })
              )
        : undefined;
    return (
        <div data-workspace-run={run.runId} className="flex min-h-0 flex-1 flex-col">
            <RunHead
                run={run}
                head={runHead(run, now)}
                counts={counts}
                view={tab.view}
                onPick={pick}
                onOpenDag={openDag}
            />
            <ViewSwap swapKey={tab.view} className="flex min-h-0 flex-1 flex-col overflow-y-auto">
                {tab.view === "tasks" ? (
                    <TasksView {...props} />
                ) : tab.view === "activity" ? (
                    <ActivityView {...props} />
                ) : (
                    <GraphView {...props} />
                )}
            </ViewSwap>
        </div>
    );
}

function RunHead({
    run,
    head,
    counts,
    view,
    onPick,
    onOpenDag,
}: {
    run: RunInfo;
    head: RunHeadView;
    counts: RunTabCounts;
    view: RunView;
    onPick: (view: RunView) => void;
    onOpenDag?: () => void;
}) {
    const usage = useRunUsage(run.channelId, run.runId);
    const spend = spendLine(usage?.rows, run.digest?.report?.workerms);
    const strip = headStrip(run.dag, run.digest);
    return (
        <div data-workspace-run-head className="flex flex-none flex-col gap-[8px] px-[18px] pb-[12px] pt-[16px]">
            <div className="flex items-center gap-[10px]">
                <span className="min-w-0 flex-1 truncate text-[15px] font-semibold text-primary">{head.title}</span>
                <span
                    data-workspace-run-state={head.state.tone}
                    className="inline-flex flex-none items-center gap-[5px] text-[12px] text-secondary"
                >
                    <span className={cn("h-[6px] w-[6px] rounded-full", HEAD_DOT[head.state.tone])} />
                    {head.state.text}
                </span>
                <div
                    role="tablist"
                    aria-label="Run views"
                    className="flex flex-none overflow-hidden rounded-[6px] border border-edge-mid text-[12px]"
                >
                    {VIEWS.map((v) => (
                        <ViewButton
                            key={v.view}
                            label={v.label}
                            view={v.view}
                            count={v.count ? counts[v.count] : undefined}
                            active={view === v.view}
                            onPick={onPick}
                        />
                    ))}
                </div>
            </div>
            <div data-workspace-run-line className={FACT_LINE}>
                {head.line}
            </div>
            {spend || onOpenDag ? (
                <div className="flex items-center gap-[10px]">
                    {spend ? (
                        <div data-workspace-run-spend className={cn(FACT_LINE, "min-w-0 flex-1")}>
                            {spend}
                        </div>
                    ) : (
                        <span className="flex-1" />
                    )}
                    {onOpenDag ? (
                        <button
                            type="button"
                            data-workspace-run-open-dag
                            title="Open the run's DAG (on the focused task when the graph is in Focus)"
                            onClick={onOpenDag}
                            className="inline-flex flex-none cursor-pointer items-center gap-[5px] rounded-[6px] border border-accent/45 bg-accentbg px-[10px] py-[4px] text-[12px] font-semibold text-accent-soft"
                        >
                            Open DAG
                            <ArrowUpRight size={11} strokeWidth={2.2} aria-hidden />
                        </button>
                    ) : null}
                </div>
            ) : null}
            {strip ? (
                <div data-workspace-run-strip className="flex h-[4px] gap-[3px]">
                    {strip.kind === "segments" ? (
                        strip.dots.map((d, i) => (
                            <span
                                key={i}
                                data-strip-dot={d}
                                className={cn("min-w-[2px] flex-1 rounded-[2px]", STRIP_FILL[d])}
                            />
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
        </div>
    );
}

// a segment of the head's control; the active fill is one shared layoutId, so a pick moves it (moment 17)
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
                "relative inline-flex cursor-pointer items-baseline gap-[5px] px-[10px] py-[4px]",
                active ? "text-primary" : "text-muted hover:text-secondary"
            )}
        >
            {active ? (
                <motion.span
                    layoutId="workspace-run-view-indicator"
                    data-run-view-indicator
                    aria-hidden
                    transition={morphTransition}
                    className="absolute inset-0 bg-surface-selected"
                />
            ) : null}
            <span className="relative">{label}</span>
            {count != null ? (
                <span className="relative font-mono text-[11px] text-muted">
                    <TickNumber value={count} />
                </span>
            ) : null}
        </button>
    );
}
