// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The Run tab's Tasks view: one box of step rows, Plan review, a row per task in plan order, Final verification. A
// task's row opens to its body: what it came to, its files, and Open agent / Open changes. What each says is
// workspaceruntabmodel.ts'.

import { easeFluidCss, MOTION } from "@/app/element/motiontokens";
import { PaneReveal } from "@/app/element/panereveal";
import { globalStore } from "@/app/store/jotaiStore";
import { openTaskWorker, resolveTaskWorker } from "@/app/view/orchestrate/taskcorrelate";
import { cn } from "@/util/util";
import { atom, useAtomValue } from "jotai";
import { ArrowUpRight, LoaderCircle } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { runAtom } from "./channelsstore";
import { ChildAskEntry } from "./childaskcard";
import { ASK_OWNER_USER, childAskKey } from "./childaskmodel";
import { runFinished } from "./runlineage";
import { AddsDels, TurnChevron } from "./steprows";
import type { RunViewProps } from "./workspaceruntab";
import {
    finalRow,
    planReviewRow,
    ROW_DOT,
    taskBody,
    taskRows,
    type RowDot,
    type StageRowView,
    type TaskBodyView,
    type TaskEvidence,
    type TaskRowView,
} from "./workspaceruntabmodel";
import { openBeside } from "./workspacestore";

// a dot changing state morphs its colour (moment 17)
const DOT_MORPH = { transitionDuration: `${MOTION.durMacro}s`, transitionTimingFunction: easeFluidCss };

const STATE_TEXT: Record<RowDot, string> = {
    merged: "text-muted",
    working: "text-accent",
    asked: "text-warning",
    failed: "text-error",
    waits: "text-muted",
};

const META = "font-mono text-[11px] text-muted";
const ACTION =
    "inline-flex cursor-pointer items-center gap-[5px] rounded-[6px] border border-edge-mid px-[9px] py-[3px] text-[12px] text-secondary hover:border-edge-strong";

// each task's worker run, by task id; a task not dispatched yet has none. One atom over the dag's run ids, so the
// hook count stays fixed as tasks dispatch.
function useChildRuns(dag: TaskGroup | undefined): Record<string, Run | undefined> {
    const key = JSON.stringify((dag?.tasks ?? []).filter((t) => t.runid).map((t) => [t.id, t.runid]));
    const runsAtom = useMemo(() => {
        const pairs: [string, string][] = JSON.parse(key);
        return atom((get) => Object.fromEntries(pairs.map(([id, runId]) => [id, get(runAtom(runId))])));
    }, [key]);
    return useAtomValue(runsAtom);
}

export function TasksView({ model, agent, run, asks, events }: RunViewProps) {
    const now = useAtomValue(model.nowAtom);
    const children = useChildRuns(run.dag);
    const evidence: TaskEvidence = Object.fromEntries(Object.entries(children).map(([id, r]) => [id, r?.evidence]));
    const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
    const rows = taskRows(run.dag, run.digest, now, evidence);
    if (rows.length === 0) {
        return (
            <div className="px-[18px] py-[14px] text-[12.5px] text-muted">
                No plan submitted yet, so there are no tasks.
            </div>
        );
    }
    const toggle = (id: string) =>
        setOpen((prev) => {
            const next = new Set(prev);
            if (!next.delete(id)) {
                next.add(id);
            }
            return next;
        });
    const ctx = { dag: run.dag, digest: run.digest, evidence, events, now, live: !runFinished(run) };
    const review = planReviewRow(run.dag);
    const final = finalRow(run.dag, events, now);
    const yours = asks.filter((a) => a.owner === ASK_OWNER_USER);
    return (
        <div className="px-[18px] pb-[18px] pt-[4px]">
            <div
                data-workspace-run-tasks
                className="flex flex-col divide-y divide-edge-faint overflow-hidden rounded-[10px] border border-edge-mid"
            >
                {review ? <StageRow stage="planreview" row={review} /> : null}
                {rows.map((r) => {
                    const task = run.dag.tasks.find((t) => t.id === r.id);
                    const body = taskBody(task, ctx);
                    return (
                        <TaskRow
                            key={r.id}
                            row={r}
                            open={open.has(r.id)}
                            onToggle={() => toggle(r.id)}
                            body={body}
                            actions={
                                <TaskActions
                                    task={task}
                                    changes={body.changes}
                                    onOpenAgent={() =>
                                        openTaskWorker(
                                            resolveTaskWorker(task, children[r.id], globalStore.get(model.agentsAtom)),
                                            model
                                        )
                                    }
                                    onOpenChanges={(selected) =>
                                        openBeside(model, agent.id, { kind: "changes", selected })
                                    }
                                />
                            }
                        >
                            {yours
                                .filter((a) => a.taskid === r.id)
                                .map((a) => (
                                    <div
                                        key={childAskKey(a)}
                                        data-workspace-run-ask={a.taskid}
                                        className="mx-[14px] mb-[12px] rounded-[10px] border border-warning/45 bg-warning/[0.12] px-[12px] py-[11px]"
                                    >
                                        <ChildAskEntry
                                            channelId={run.channelId}
                                            runId={run.runId}
                                            ask={a}
                                            events={events}
                                        />
                                    </div>
                                ))}
                        </TaskRow>
                    );
                })}
                {final ? <StageRow stage="final" row={final} /> : null}
            </div>
        </div>
    );
}

function Dot({ dot, size }: { dot: RowDot; size: string }) {
    return (
        <span className="grid h-[14px] w-[14px] flex-none place-items-center">
            <span
                data-row-dot={dot}
                style={DOT_MORPH}
                className={cn("rounded-full transition-colors motion-reduce:transition-none", size, ROW_DOT[dot])}
            />
        </span>
    );
}

function StageRow({ stage, row }: { stage: "planreview" | "final"; row: StageRowView }) {
    return (
        <div
            data-workspace-run-stage={stage}
            className="flex items-center gap-[10px] bg-surface px-[14px] py-[9px] text-[12.5px] text-ink-mid"
        >
            <Dot dot={row.dot} size="h-[8px] w-[8px]" />
            <span>{row.label}</span>
            <span className="flex-1" />
            <span data-stage-word className="text-[12px] text-muted">
                {row.word}
            </span>
            {row.time ? <span className="font-mono text-[11px] text-muted">{row.time}</span> : null}
        </div>
    );
}

function StateWord({ row }: { row: TaskRowView }) {
    if (!row.state) {
        return null;
    }
    if (row.dot === "failed") {
        return (
            <span data-task-state className="rounded-[4px] bg-error/15 px-[6px] py-px font-mono text-[11px] text-error">
                {row.state}
            </span>
        );
    }
    return (
        <span data-task-state className={cn("truncate text-[12px]", STATE_TEXT[row.dot])}>
            {row.state}
        </span>
    );
}

function TaskRow({
    row,
    open,
    onToggle,
    body,
    actions,
    children,
}: {
    row: TaskRowView;
    open: boolean;
    onToggle: () => void;
    body: TaskBodyView;
    actions: ReactNode;
    children: ReactNode;
}) {
    return (
        <div data-workspace-run-task={row.id}>
            <button
                type="button"
                aria-expanded={open}
                onClick={onToggle}
                className="flex w-full cursor-pointer items-center gap-[10px] px-[14px] py-[10px] text-left text-[13.5px] text-secondary hover:bg-surface-hover"
            >
                <Dot dot={row.dot} size="h-[8px] w-[8px]" />
                <span className="min-w-0 truncate">{row.name}</span>
                {row.sub ? <span className="flex-none font-mono text-[12px] text-muted">{row.sub}</span> : null}
                <span className="flex-1" />
                <StateWord row={row} />
                {row.adds != null ? <AddsDels adds={row.adds} dels={row.dels} compact /> : null}
                {row.time ? <span className="flex-none font-mono text-[11px] text-muted">{row.time}</span> : null}
                <span className="flex flex-none text-muted">
                    <TurnChevron open={open} size={12} strokeWidth={2.2} />
                </span>
            </button>
            <PaneReveal open={open}>
                <TaskBody body={body} actions={actions} />
            </PaneReveal>
            {children}
        </div>
    );
}

function TaskBody({ body, actions }: { body: TaskBodyView; actions: ReactNode }) {
    return (
        <div data-task-body className="flex flex-col gap-[10px] pb-[14px] pl-[38px] pr-[14px]">
            {body.lead ? (
                <span data-body-lead className="text-[13px] leading-[1.55] text-ink-mid">
                    {body.lead}
                </span>
            ) : null}
            {body.ran ? <RanStep ran={body.ran} /> : null}
            {body.files.length > 0 ? (
                <div className="flex flex-col gap-[4px]">
                    {body.files.map((f) => (
                        <div key={f.path} data-body-file={f.path} className="flex gap-[8px] font-mono text-[11.5px]">
                            <span className="min-w-0 flex-1 truncate text-ink-mid">{f.path}</span>
                            <AddsDels adds={f.add} dels={f.del} compact />
                        </div>
                    ))}
                </div>
            ) : null}
            {body.failure ? (
                <div
                    data-body-failure
                    className="whitespace-pre-wrap rounded-[8px] border border-edge-mid bg-surface-code px-[10px] py-[8px] font-mono text-[11.5px] leading-[1.55] text-ink-mid"
                >
                    {body.failure}
                </div>
            ) : null}
            {body.deciding ? (
                <span data-body-deciding className="text-[13px] leading-[1.55] text-ink-mid">
                    The lead is deciding: retry, escalate, skip or send back.
                </span>
            ) : null}
            {body.reviewer ? (
                <span data-body-reviewer className={META}>
                    {body.reviewer}
                </span>
            ) : null}
            {body.merged ? (
                <span data-body-merged className={META}>
                    {body.merged}
                </span>
            ) : null}
            {body.depends ? (
                <span data-body-depends className={META}>
                    {body.depends}
                </span>
            ) : null}
            {actions}
        </div>
    );
}

// a merged task's running Verify, in the transcript's step-row look
function RanStep({ ran }: { ran: NonNullable<TaskBodyView["ran"]> }) {
    return (
        <div data-body-ran className="flex flex-col overflow-hidden rounded-[8px] border border-edge-faint">
            <div className="flex items-center gap-[8px] px-[10px] py-[6px] text-[12.5px] text-secondary">
                <LoaderCircle
                    size={14}
                    strokeWidth={2.2}
                    role="img"
                    aria-label="Running"
                    className="flex-none animate-spin text-ink-mid"
                />
                <span>Ran</span>
                <span data-ran-command className="min-w-0 truncate font-mono text-[11px] text-muted">
                    {ran.command}
                </span>
                <span className="flex-1" />
                {ran.time ? <span className="font-mono text-[11px] text-muted">{ran.time}</span> : null}
            </div>
            {ran.lastLine ? (
                <div className="truncate border-t border-edge-faint px-[10px] py-[6px] font-mono text-[11px] text-muted">
                    {ran.lastLine}
                </div>
            ) : null}
        </div>
    );
}

function TaskActions({
    task,
    changes,
    onOpenAgent,
    onOpenChanges,
}: {
    task: TaskNode;
    changes: string | null;
    onOpenAgent: () => void;
    onOpenChanges: (selected: string) => void;
}) {
    // a task not dispatched has no agent to open
    if (!task.runid) {
        return null;
    }
    return (
        <div className="flex gap-[6px]">
            <button
                type="button"
                data-open-agent
                title={`Opens ${task.id}'s agent on the Agent surface`}
                onClick={onOpenAgent}
                className={ACTION}
            >
                Open agent <ArrowUpRight size={11} strokeWidth={2.2} aria-hidden />
            </button>
            {changes != null ? (
                <button type="button" data-open-changes onClick={() => onOpenChanges(changes)} className={ACTION}>
                    Open changes
                </button>
            ) : null}
        </div>
    );
}
