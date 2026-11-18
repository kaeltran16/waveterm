// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The Run tab's Tasks view: a row per task in plan order, with a question waiting on you answerable in its row.

import { cn } from "@/util/util";
import { atom, useAtomValue, type Atom } from "jotai";
import { runAtom } from "./channelsstore";
import { ChildAskEntry } from "./childaskcard";
import { ASK_OWNER_USER, childAskKey } from "./childaskmodel";
import type { RunInfo } from "./runlineage";
import { LANE_DOT, LANE_TEXT } from "./runrailsections";
import type { RunViewProps } from "./workspaceruntab";
import { taskRows, type TaskRowView } from "./workspaceruntabmodel";

const TASK_GRID = "grid grid-cols-[minmax(0,1fr)_132px_64px_82px] gap-[10px]";
const LABEL = "font-mono text-[10.5px] font-bold uppercase tracking-[.1em]";

export function TasksView({ model, run, asks, events }: RunViewProps) {
    const now = useAtomValue(model.nowAtom);
    const rows = taskRows(run.dag, run.digest, now);
    const yours = asks.filter((a) => a.owner === ASK_OWNER_USER);
    if (rows.length === 0) {
        return (
            <div className="px-[18px] py-[14px] text-[12.5px] text-muted">
                No plan submitted yet, so there are no tasks.
            </div>
        );
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
