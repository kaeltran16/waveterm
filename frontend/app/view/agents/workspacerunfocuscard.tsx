// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The Graph's Focus centre card: the focused task's id, state and name, then by state its worker's latest step, its
// open question or when it starts, and Open agent / Open changes with the diff stat. Which parts show is
// workspacerunfocuscardmodel.ts'; it fills its wrapper's width.

import { cn } from "@/util/util";
import type { DiffStats } from "./agentsviewmodel";
import type { RunInfo } from "./runlineage";
import { AddsDels } from "./steprows";
import { focusCardView } from "./workspacerunfocuscardmodel";
import { ROW_DOT, type RowDot } from "./workspaceruntabmodel";
import { LatestSteps, STATE_TEXT, TaskActions } from "./workspaceruntasks";

// its own stream id prefix: the Tasks view can be mounted beside it during the view swap
const FOCUS_STREAM = "rungraph-focus-step";

export function FocusCentreCard({
    task,
    dot,
    state,
    waitsOn,
    finished,
    ask,
    evidence,
    live,
    run,
    onOpenAgent,
    onOpenChanges,
}: {
    task: TaskNode;
    dot: RowDot;
    // the state word with its time, "working · 4m"
    state: string;
    waitsOn: string[];
    finished: boolean;
    ask?: DagAskItem;
    evidence?: RunEvidence;
    live?: DiffStats;
    run: RunInfo;
    onOpenAgent: () => void;
    // "" selects no file: the live worker's whole diff
    onOpenChanges: (selected: string) => void;
}) {
    const v = focusCardView({ task, waitsOn, finished, ask, evidence, live });
    return (
        <div
            data-focus-card={task.id}
            className={cn(
                "box-border flex w-full flex-col gap-[8px] rounded-[12px] border bg-surface-raised px-[16px] py-[14px]",
                v.asked ? "border-warning/60" : "border-accent"
            )}
        >
            <div className="flex items-center gap-[8px]">
                <span className={cn("h-[9px] w-[9px] flex-none rounded-full", ROW_DOT[dot])} />
                <span className="flex-1 font-mono text-[11px] text-muted">{task.id}</span>
                <span data-focus-state className={cn("text-[12px]", STATE_TEXT[dot])}>
                    {state}
                </span>
            </div>
            <div className="truncate text-[15px] font-semibold text-primary">{task.label || task.id}</div>
            {v.step ? <LatestSteps run={run} task={task} n={1} prefix={FOCUS_STREAM} /> : null}
            {v.question != null ? (
                <div
                    data-focus-question
                    className="rounded-[8px] border border-edge-mid px-[10px] py-[7px] text-[12.5px] leading-[1.45] text-secondary"
                >
                    {v.question}
                </div>
            ) : null}
            {v.starts != null ? (
                <div data-focus-starts className="text-[12.5px] text-ink-mid">
                    {v.starts}
                </div>
            ) : null}
            {v.actions ? (
                <div className="mt-[2px]">
                    <TaskActions
                        task={task}
                        changes={v.actions.changes}
                        onOpenAgent={onOpenAgent}
                        onOpenChanges={onOpenChanges}
                        trailing={
                            v.actions.diff ? (
                                <span
                                    data-focus-diff
                                    className="flex items-center gap-[4px] whitespace-nowrap font-mono text-[11px] text-muted"
                                >
                                    {v.actions.diff.files}
                                    <AddsDels adds={v.actions.diff.adds} dels={v.actions.diff.dels} compact />
                                </span>
                            ) : undefined
                        }
                    />
                </div>
            ) : null}
        </div>
    );
}
