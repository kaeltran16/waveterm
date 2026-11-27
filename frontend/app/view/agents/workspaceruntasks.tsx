// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The Run tab's Tasks view: one box of step rows, Plan review, a row per task in plan order, Final verification. A
// task's row opens to its body: what it came to, its open question, its files and answered questions, a running
// worker's latest steps, and Open agent / Open changes. What each says is workspaceruntabmodel.ts'.

import { easeFluidCss, MOTION } from "@/app/element/motiontokens";
import { PaneReveal } from "@/app/element/panereveal";
import { globalStore } from "@/app/store/jotaiStore";
import { openTaskWorker, resolveTaskWorker } from "@/app/view/orchestrate/taskcorrelate";
import { cn } from "@/util/util";
import { atom, useAtomValue } from "jotai";
import { ArrowUpRight, LoaderCircle } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { runAtom } from "./channelsstore";
import { ChildAskEntry } from "./childaskcard";
import { ASK_OWNER_USER, childAskKey } from "./childaskmodel";
import { childAskErrorAtom, takeOverChildAsk } from "./childaskstore";
import { startTranscriptStream, stopTranscriptStream } from "./livetranscript";
import { entriesAtomFor } from "./livetranscriptatoms";
import { runFinished, type RunInfo } from "./runlineage";
import { loadRunTranscriptPath, runTranscriptPathsAtom } from "./runlineagestore";
import { AddsDels, StepBox } from "./steprows";
import { TurnChevron } from "./tooldetailbody";
import type { RunViewProps } from "./workspaceruntab";
import {
    finalRow,
    latestSteps,
    leadAskView,
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

export const STATE_TEXT: Record<RowDot, string> = {
    merged: "text-muted",
    working: "text-accent",
    asked: "text-warning",
    failed: "text-error",
    waits: "text-muted",
};

const META = "font-mono text-[11px] text-muted";
const ACTION =
    "inline-flex cursor-pointer items-center gap-[5px] whitespace-nowrap rounded-[6px] border border-edge-mid px-[9px] py-[3px] text-[12px] text-secondary hover:border-edge-strong";

// each task's worker run, by task id; a task not dispatched yet has none. One atom over the dag's run ids, so the
// hook count stays fixed as tasks dispatch.
export function useChildRuns(dag: TaskGroup | undefined): Record<string, Run | undefined> {
    const key = JSON.stringify((dag?.tasks ?? []).filter((t) => t.runid).map((t) => [t.id, t.runid]));
    const runsAtom = useMemo(() => {
        const pairs: [string, string][] = JSON.parse(key);
        return atom((get) => Object.fromEntries(pairs.map(([id, runId]) => [id, get(runAtom(runId))])));
    }, [key]);
    return useAtomValue(runsAtom);
}

// the tasks whose open question has not opened its row yet, marked as opened. A taken-over question keeps its key, so
// it does not reopen a row the user closed; one forwarded to you opens like the lead's, since it lives in the body
function arrivedAsks(asks: DagAskItem[], seen: Set<string>): string[] {
    const fresh = asks.filter((a) => !seen.has(childAskKey(a)));
    fresh.forEach((a) => seen.add(childAskKey(a)));
    return fresh.map((a) => a.taskid);
}

export function TasksView({ model, agent, run, asks, events }: RunViewProps) {
    const now = useAtomValue(model.nowAtom);
    const children = useChildRuns(run.dag);
    const evidence: TaskEvidence = Object.fromEntries(Object.entries(children).map(([id, r]) => [id, r?.evidence]));
    // an open question opens its row once, on arrival; closing it after is the user's call
    const [seenAsks] = useState(() => new Set<string>());
    const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set(arrivedAsks(asks, seenAsks)));
    useEffect(() => {
        const arrived = arrivedAsks(asks, seenAsks);
        if (arrived.length > 0) {
            setOpen((prev) => new Set([...prev, ...arrived]));
        }
    }, [asks, seenAsks]);
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
    const review = planReviewRow(run.dag, events, now);
    const final = finalRow(run.dag, events, now);
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
                    const ask = asks.find((a) => a.taskid === r.id);
                    return (
                        <TaskRow
                            key={r.id}
                            row={r}
                            open={open.has(r.id)}
                            onToggle={() => toggle(r.id)}
                            body={body}
                            ask={ask ? <RowAsk run={run} ask={ask} events={events} now={now} /> : null}
                            steps={
                                task.state === "running" && task.runid ? (
                                    <LatestSteps run={run} task={task} n={LATEST_STEPS} prefix={TASKS_STREAM} />
                                ) : null
                            }
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
                        />
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
    ask,
    steps,
    actions,
}: {
    row: TaskRowView;
    open: boolean;
    onToggle: () => void;
    body: TaskBodyView;
    ask: ReactNode;
    steps: ReactNode;
    actions: ReactNode;
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
                <TaskBody body={body} ask={ask} steps={steps} actions={actions} />
            </PaneReveal>
        </div>
    );
}

function TaskBody({
    body,
    ask,
    steps,
    actions,
}: {
    body: TaskBodyView;
    ask: ReactNode;
    steps: ReactNode;
    actions: ReactNode;
}) {
    return (
        <div data-task-body className="flex flex-col gap-[10px] pb-[14px] pl-[38px] pr-[14px]">
            {body.lead ? (
                <span data-body-lead className="text-[13px] leading-[1.55] text-ink-mid">
                    {body.lead}
                </span>
            ) : null}
            {ask}
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
            {body.asked.map((a) => (
                <div
                    key={a.key}
                    data-body-asked
                    className="flex flex-col gap-[3px] rounded-[8px] border border-edge-faint px-[10px] py-[8px]"
                >
                    <span className={META}>{a.line}</span>
                    <span className="text-[12.5px] leading-[1.45] text-secondary">{a.question}</span>
                </div>
            ))}
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
            {steps}
            {actions}
        </div>
    );
}

const ASK_HEAD = "flex items-center gap-[7px] font-mono text-[11px] text-muted";
const ASK_DOT = "h-[7px] w-[7px] flex-none rounded-full bg-warning";

// an open question in its task's row: the lead's, read-only with Take over, or yours, answerable inline
function RowAsk({ run, ask, events, now }: { run: RunInfo; ask: DagAskItem; events: RunEvent[]; now: number }) {
    const error = useAtomValue(childAskErrorAtom)[childAskKey(ask)];
    if (ask.owner === ASK_OWNER_USER) {
        return (
            <div
                data-row-ask="you"
                data-workspace-run-ask={ask.taskid}
                className="rounded-[10px] border border-warning/45 bg-warning/[0.08] px-[14px] py-[12px]"
            >
                <div className={cn(ASK_HEAD, "mb-[4px]")}>
                    <span className={ASK_DOT} />
                    <span className="text-secondary">{ask.taskid} asks you</span>
                </div>
                <ChildAskEntry channelId={run.channelId} runId={run.runId} ask={ask} events={events} />
            </div>
        );
    }
    const v = leadAskView(ask, now);
    return (
        <div
            data-row-ask="lead"
            className="flex flex-col gap-[9px] rounded-[10px] border border-edge-mid bg-surface-raised px-[14px] py-[12px]"
        >
            <div className={ASK_HEAD}>
                <span className={ASK_DOT} />
                <span className="text-secondary">{v.who}</span> <span data-ask-when>· {v.when}</span>
            </div>
            {v.questions.map((q, i) => (
                <div key={i} className="flex flex-col gap-[9px]">
                    {q.header ? (
                        <span
                            data-ask-header
                            className="font-mono text-[10.5px] font-bold uppercase tracking-[0.1em] text-ink-mid"
                        >
                            {q.header}
                        </span>
                    ) : null}
                    <span data-ask-question className="text-[13.5px] leading-[1.45] text-primary">
                        {q.question}
                    </span>
                    {q.options ? (
                        <span data-ask-options className="text-[12.5px] text-muted">
                            {q.options}
                        </span>
                    ) : null}
                </div>
            ))}
            <div className="flex items-center gap-[8px]">
                <span data-ask-until className="flex-1 font-mono text-[11px] text-muted">
                    {v.until}
                </span>
                <button
                    type="button"
                    data-take-over
                    title="Answer it yourself; the lead leaves it to you"
                    onClick={() => takeOverChildAsk(run.channelId, run.runId, ask)}
                    className={ACTION}
                >
                    Take over
                </button>
            </div>
            {error ? <span className="text-[11px] text-warning">{error}</span> : null}
        </div>
    );
}

const LATEST_STEPS = 3;
const TASKS_STREAM = "runtab-steps";
const NO_CTX = {};

// a running task's worker, its last n steps, through a stream the caller owns under its own id prefix, so closing a
// row or swapping views never stops the worker's stream in another view. Unmounting stops it.
export function LatestSteps({ run, task, n, prefix }: { run: RunInfo; task: TaskNode; n: number; prefix: string }) {
    const id = `${prefix}:${run.runId}:${task.id}`;
    const path = useAtomValue(runTranscriptPathsAtom)[task.runid];
    const entries = useAtomValue(entriesAtomFor(id));
    const steps = useMemo(() => latestSteps(entries, n), [entries, n]);
    const runtime = task.runspec?.runtime;
    useEffect(() => {
        loadRunTranscriptPath(run.channelId, task.runid);
    }, [run.channelId, task.runid]);
    useEffect(() => {
        if (!path) {
            return;
        }
        startTranscriptStream(id, path, runtime);
        return () => stopTranscriptStream(id);
    }, [id, path, runtime]);
    if (steps.length === 0) {
        return null;
    }
    return (
        <div data-body-steps className="[&>[data-steps]]:my-0">
            <StepBox steps={steps} latest={false} ctx={NO_CTX} compact />
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

// trailing, when given, sits right-aligned after a spacer
export function TaskActions({
    task,
    changes,
    onOpenAgent,
    onOpenChanges,
    trailing,
}: {
    task: TaskNode;
    changes: string | null;
    onOpenAgent: () => void;
    onOpenChanges: (selected: string) => void;
    trailing?: ReactNode;
}) {
    // a task not dispatched has no agent to open
    if (!task.runid) {
        return null;
    }
    return (
        <div className="flex items-center gap-[6px]">
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
            {trailing != null ? (
                <>
                    <span className="flex-1" />
                    {trailing}
                </>
            ) : null}
        </div>
    );
}
