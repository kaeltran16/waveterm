// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The run face of the Brief's detail sheet (docs/prototype/run-sheet.dc.html): a status read, not a place
// to watch. The lead's and the workers' transcripts live on the Agent surface, which every live row and the
// dock open; what stays here is where the run stands, what needs you, and what it is configured to do.
//
// Three regions, fixed in place across every state: the reading (verb, meter, meta, goal), the body (a
// card for what needs you, then the tasks), and the dock (the configuration line and the run's actions).
// All derivations are runsheetmodel.ts; this file maps them to DOM and to the verbs that already exist.

import * as WOS from "@/app/store/wos";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { openDiff, runDiffScope } from "@/app/view/agents/agentdiffnav";
import type { AgentsViewModel } from "@/app/view/agents/agents";
import type { AgentVM } from "@/app/view/agents/agentsviewmodel";
import { jumpToAgent } from "@/app/view/agents/channelsprimitives";
import { runAtom } from "@/app/view/agents/channelsstore";
import { ChildAskCard } from "@/app/view/agents/childaskcard";
import { userOwnedAsks } from "@/app/view/agents/childaskmodel";
import { childAsksAtom } from "@/app/view/agents/childaskstore";
import { InlineMarkdown } from "@/app/view/agents/inlinemarkdown";
import { MarkdownMessage } from "@/app/view/agents/markdownmessage";
import { AskCard, CancelRunButton, CancelSurvivorsCard } from "@/app/view/agents/runcards";
import { needsEvidenceSeal, verifCounts } from "@/app/view/agents/runcompletion";
import { useRunEvents } from "@/app/view/agents/runeventstore";
import { cancelSurvivors, isTerminal, leadWorker, liveWorkers } from "@/app/view/agents/runmodel";
import { buildRunTimeline } from "@/app/view/agents/runtimeline";
import { eventsCount, GroupSection } from "@/app/view/agents/runtimelineview";
import { attentionQueue, type QueueEntry } from "@/app/view/orchestrate/attentionqueue";
import { formatElapsed, taskBriefs, useDagDigest, type TaskBrief } from "@/app/view/orchestrate/dagdigest";
import { openDagLive, openDagTask } from "@/app/view/orchestrate/dagmodalstate";
import { useDagGroup } from "@/app/view/orchestrate/dagstore";
import { recoverySummary, recoveryText } from "@/app/view/orchestrate/recoverysummary";
import { openTaskWorker, resolveTaskWorker, type TaskWorkerView } from "@/app/view/orchestrate/taskcorrelate";
import { cn, fireAndForget } from "@/util/util";
import { atom, useAtomValue, type Atom } from "jotai";
import { useEffect, useState, type ReactNode } from "react";
import { RunSettingsPanel, saveRunAsDefaults, SHEET_BTN } from "./briefrunsheet";
import { openJarvisWithSource, sourceRefForRun } from "./contextualentry";
import { runSettingsDraft, type LinkedGroupRead } from "./runsettings";
import {
    orderedTasks,
    runGraphRef,
    sheetStatus,
    taskRow,
    taskSectionMeta,
    type SheetDagRead,
    type SheetRowAction,
    type SheetStatus,
    type SheetTone,
} from "./runsheetmodel";
import { STAGE_PROSE } from "./stagemeasure";

const EYEBROW = "font-mono text-[9.5px] font-bold uppercase tracking-[.13em] text-feed-label";
const LINK =
    "cursor-pointer font-mono text-[10.5px] text-accent-soft hover:text-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent";
const DOCK_BTN = cn(SHEET_BTN, "bg-transparent px-3 py-1.5 text-[11.5px]");
const DOCK_ACCENT = cn(DOCK_BTN, "border-accent/50 bg-accent/12 text-accent-soft");
const ROW_BTN =
    "cursor-pointer rounded-[5px] border border-border px-[7px] py-0.5 font-mono text-[9.5px] text-secondary hover:border-edge-strong hover:text-ink-hi focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent";

const TONE_TEXT: Record<SheetTone, string> = {
    success: "text-success",
    "success-soft": "text-success-soft",
    warning: "text-warning",
    "warning-soft": "text-warning-soft",
    error: "text-error",
    "error-soft": "text-error-soft",
    muted: "text-muted",
    faint: "text-ink-faint",
    accent: "text-accent-soft",
    dim: "text-muted",
};

const TONE_BG: Record<SheetTone, string> = {
    success: "bg-success",
    "success-soft": "bg-success-soft",
    warning: "bg-warning",
    "warning-soft": "bg-warning-soft",
    error: "bg-error",
    "error-soft": "bg-error-soft",
    muted: "bg-muted",
    faint: "bg-edge-strong",
    accent: "bg-accent",
    dim: "bg-accent-700",
};

const ROW_ACTION_LABEL: Record<Exclude<SheetRowAction, null>, string> = {
    "open-agent": "Open in Agent ↗",
    "open-child-run": "View child run",
    "open-dag-task": "Open DAG ↗",
};

// stable no-run atom for a task that has not been dispatched: runAtom is oref-cached, and the row's hook
// count must not vary with whether the task has a child run
const NO_RUN_ATOM = atom<Run | undefined>(undefined);

type SheetCtx = {
    model: AgentsViewModel;
    channel: Channel;
    run: Run;
    agents: AgentVM[];
    now: number;
};

export function RunSheet({ model, channel, run: runProp }: { model: AgentsViewModel; channel: Channel; run: Run }) {
    // the run's live WOS object, falling back to the list entry until it hydrates; both track one run
    const run = useAtomValue(runAtom(runProp.id)) ?? runProp;
    const agents = useAtomValue(model.agentsAtom);
    const now = useAtomValue(model.nowAtom);

    // a done run shows its sealed evidence; one sealed before the feature existed is backfilled once, and the
    // mirrored update re-renders this with run.evidence present
    useEffect(() => {
        if (needsEvidenceSeal(run)) {
            fireAndForget(() => RpcApi.SealRunEvidenceCommand(TabRpcClient, { channelid: channel.oid, runid: run.id }));
        }
    }, [run.id, run.status, run.evidence]);

    const ctx: SheetCtx = { model, channel, run, agents, now };
    const graph = runGraphRef(run);
    if (graph != null) {
        return <LinkedRunSheet ctx={ctx} dagOref={"dag:" + graph} />;
    }
    return <RunSheetFrame ctx={ctx} dag={null} />;
}

// The dag read is a component boundary rather than hooks inside a branch: a run without a graph never
// subscribes to one.
function LinkedRunSheet({ ctx, dagOref }: { ctx: SheetCtx; dagOref: string }) {
    const digest = useDagDigest(ctx.channel.oid, ctx.run.id, dagOref);
    const [group, loading] = useDagGroup(dagOref);
    const errored = useAtomValue(WOS.getWaveObjectErrorAtom(dagOref));
    const groupRead: LinkedGroupRead = loading ? "loading" : group != null ? "ready" : errored ? "error" : "missing";
    return <RunSheetFrame ctx={ctx} dag={{ digest, group: group ?? null, groupRead }} />;
}

function RunSheetFrame({ ctx, dag }: { ctx: SheetCtx; dag: SheetDagRead | null }) {
    const { run, agents, now, channel } = ctx;
    const asks = useAtomValue(childAsksAtom)[run.id] ?? [];
    const userAsks = userOwnedAsks(asks);
    const asker = liveWorkers(run, agents).find((w) => w.state === "asking");
    const survivors = cancelSurvivors(run, agents).length;
    const status = sheetStatus({ run, nowMs: now, dag, userAsks, workerAsking: asker != null, survivors });
    const showEvidence = run.status === "done";

    return (
        <div data-run-sheet={run.status} className="flex min-h-0 flex-1 flex-col bg-background">
            <Reading run={run} status={status} onRetry={dag?.digest.retry} />
            <div className="sc min-h-0 flex-1 overflow-y-auto px-4 pb-2.5">
                {survivors > 0 ? (
                    <CancelSurvivorsCard model={ctx.model} channelId={channel.oid} run={run} agents={agents} />
                ) : null}
                {asker != null ? <AskCard model={ctx.model} agent={asker} kind="clarify" /> : null}
                {dag != null ? (
                    <div className="mt-3.5">
                        <ChildAskCard channelId={channel.oid} runId={run.id} />
                    </div>
                ) : null}
                {showEvidence ? (
                    <Evidence ctx={ctx} dag={dag} />
                ) : (
                    <Tasks ctx={ctx} dag={dag} status={status} asks={asks} />
                )}
            </div>
            {/* the settings face's selector is kept on the dock: checks read it as "a run face is showing" */}
            <footer data-jarvis-brief-sheet-face="settings" className="flex-none border-t border-edge-faint bg-surface">
                <RunSettingsPanel run={run} />
                <Dock ctx={ctx} group={dag?.group ?? null} />
            </footer>
        </div>
    );
}

function Reading({ run, status, onRetry }: { run: Run; status: SheetStatus; onRetry?: () => void }) {
    const [goalOpen, setGoalOpen] = useState(false);
    const meter = status.meter;
    return (
        <div className="flex flex-none flex-col gap-[11px] border-b border-edge-faint px-4 pb-3.5 pt-4">
            <div className="flex items-center gap-[9px]">
                <span
                    className={cn(
                        "h-[7px] w-[7px] flex-none rounded-full",
                        TONE_BG[status.tone],
                        status.pulse && "animate-[pulseDot_1.6s_infinite] motion-reduce:animate-none"
                    )}
                />
                <span
                    data-run-sheet-verb
                    aria-live="polite"
                    className="flex-none text-[15px] font-bold tracking-[-.01em] text-primary"
                >
                    {status.verb}
                </span>
                <span className="min-w-0 text-[13px] leading-[1.35] text-ink-mid">{status.sub}</span>
            </div>
            {meter != null && meter.total > 0 ? (
                <div
                    role="img"
                    aria-label={`${meter.done} of ${meter.total} tasks finished`}
                    className={cn("flex", meter.total > 24 ? "gap-px" : "gap-1")}
                >
                    {Array.from({ length: meter.total }, (_, i) => (
                        <span
                            key={i}
                            className={cn(
                                "h-1 flex-1 rounded-[2px]",
                                i < meter.done ? TONE_BG[meter.tone] : "bg-edge-mid"
                            )}
                        />
                    ))}
                </div>
            ) : null}
            {status.meta.length > 0 || status.retry ? (
                <div className="flex flex-wrap gap-x-3.5 gap-y-1 font-mono text-[10.5px]">
                    {status.meta.map((m) => (
                        <span key={m.text} className={TONE_TEXT[m.tone]}>
                            {m.text}
                        </span>
                    ))}
                    {status.retry && onRetry != null ? (
                        <button type="button" onClick={onRetry} className={LINK}>
                            retry
                        </button>
                    ) : null}
                </div>
            ) : null}
            {/* collapsed, the goal is a two-line heading; expanded it becomes the prose it was written as. A div,
                not a button: expanded markdown renders block elements a button may not contain. */}
            <div
                onClick={() => setGoalOpen((o) => !o)}
                title={goalOpen ? "Collapse" : "Expand"}
                className="mt-0.5 cursor-pointer text-[17px] font-bold leading-[1.3] tracking-[-.01em] text-primary hover:opacity-90"
            >
                {goalOpen ? (
                    <MarkdownMessage
                        text={run.goal}
                        className={cn(STAGE_PROSE, "text-[14px] font-semibold leading-snug text-primary")}
                    />
                ) : (
                    <div className="line-clamp-2">
                        <InlineMarkdown text={run.goal} />
                    </div>
                )}
            </div>
        </div>
    );
}

function Tasks({
    ctx,
    dag,
    status,
    asks,
}: {
    ctx: SheetCtx;
    dag: SheetDagRead | null;
    status: SheetStatus;
    asks: DagAskItem[];
}) {
    const { run, channel } = ctx;
    const events = useRunEvents(run.id, channel.oid);
    const [timelineOpen, setTimelineOpen] = useState(false);
    const { groups } = buildRunTimeline(run, events);
    const digestState = dag?.digest;
    const digest = digestState?.digest;
    const group = dag?.group ?? null;
    const readable = dag != null && dag.groupRead === "ready" && group != null && digest != null;
    const briefs = taskBriefs(group ?? undefined);
    // a stale read keeps its figures but dates them, and drops the exception list entirely: an attention
    // queue that might be minutes old is worse than none
    const failedRefresh = digestState?.stale === true && digestState.error != null && !digestState.loading;
    const asOf =
        failedRefresh && digestState.lastUpdatedTs != null
            ? `as of ${formatElapsed(Math.max(0, ctx.now - digestState.lastUpdatedTs))} ago`
            : failedRefresh
              ? "as of an earlier read"
              : null;

    return (
        <div>
            <div className="flex items-center gap-2.5 pb-2 pt-4">
                <span className={EYEBROW}>tasks</span>
                <span className="min-w-0 truncate font-mono text-[10.5px] text-ink-faint">
                    {taskSectionMeta(run, digest)}
                </span>
                <span className="flex-1" />
                {groups.length > 0 ? (
                    <button
                        type="button"
                        aria-expanded={timelineOpen}
                        onClick={() => setTimelineOpen((o) => !o)}
                        className={cn(LINK, "flex-none")}
                    >
                        {timelineOpen ? "▾" : "▸"} timeline · {eventsCount(groups)} events
                    </button>
                ) : null}
            </div>
            {timelineOpen ? (
                <div className="mb-3 flex flex-col border-l-2 border-edge-mid pl-3">
                    <div className="sc max-h-[260px] overflow-y-auto">
                        {groups.map((g) => (
                            <GroupSection key={g.id} group={g} channel={channel} run={run} />
                        ))}
                    </div>
                    {run.dagoref ? (
                        <button
                            type="button"
                            onClick={() => openDagLive(channel.oid, run.id, "dag:" + run.dagoref)}
                            className={cn(LINK, "mt-1 self-start")}
                        >
                            open the full timeline ↗
                        </button>
                    ) : null}
                </div>
            ) : null}
            {readable && !digestState.stale ? <Attention ctx={ctx} digest={digest} group={group} /> : null}
            {readable ? (
                <div className="flex flex-col" data-run-sheet-rows>
                    {orderedTasks(group, digest).map(({ task, td }) => (
                        <TaskRow
                            key={task.id}
                            ctx={ctx}
                            task={task}
                            td={td}
                            briefs={briefs}
                            digest={digest}
                            events={events}
                            askOwner={askOwnerOf(asks, task.id)}
                            asOf={asOf}
                        />
                    ))}
                </div>
            ) : (
                <EmptyTasks ctx={ctx} dag={dag} />
            )}
            {status.next != null ? (
                <div className="pb-1 pt-[13px] font-mono text-[11px] leading-[1.5] text-muted">
                    <span className="text-ink-faint">next: </span>
                    {status.next}
                </div>
            ) : null}
        </div>
    );
}

function askOwnerOf(asks: DagAskItem[], taskId: string): "user" | "lead" | null {
    const ask = asks.find((a) => a.taskid === taskId);
    if (ask == null) {
        return null;
    }
    return ask.owner === "user" ? "user" : "lead";
}

// the task's worker, resolved from its child run and the live roster — shared by rows and the attention
// list so the two can never disagree about who is running a task
function useTaskWorker(task: { id: string; runid?: string }, agents: AgentVM[]): TaskWorkerView {
    const childRun = useAtomValue<Run | undefined>(
        (task.runid ? runAtom(task.runid) : NO_RUN_ATOM) as Atom<Run | undefined>
    );
    return resolveTaskWorker(task, childRun, agents);
}

function TaskRow({
    ctx,
    task,
    td,
    briefs,
    digest,
    events,
    askOwner,
    asOf,
}: {
    ctx: SheetCtx;
    task: TaskNode;
    td: DagTaskDigest | undefined;
    briefs: Map<string, TaskBrief>;
    digest: DagStatusDigest;
    events: RunEvent[];
    askOwner: "user" | "lead" | null;
    asOf: string | null;
}) {
    const worker = useTaskWorker(task, ctx.agents);
    const recovery = recoverySummary(events, task.id);
    const row = taskRow({
        task,
        td,
        worker,
        briefs,
        lanes: digest.lanes,
        durations: digest.durations?.tasks,
        recovery: recovery != null ? recoveryText(recovery, task.state) : null,
        askOwner,
        nowMs: ctx.now,
        asOf,
    });
    const act = () => {
        if (row.action === "open-dag-task") {
            openDagTask(ctx.channel.oid, ctx.run.id, "dag:" + ctx.run.dagoref, task.id);
            return;
        }
        openTaskWorker(worker, ctx.model);
    };
    return (
        <div
            data-run-sheet-row={task.id}
            className="grid grid-cols-[62px_minmax(0,1fr)_auto] items-baseline gap-3 border-b border-edge-faint py-[11px]"
        >
            <span title={task.id} className="truncate font-mono text-[11px] font-medium text-ink-mid">
                {task.id}
            </span>
            <div className="flex min-w-0 flex-col gap-[3px]">
                <span className="text-[12.5px] leading-[1.35] text-ink-hi">{row.label}</span>
                {row.meta ? (
                    <span title={row.meta} className={cn("truncate font-mono text-[10.5px]", TONE_TEXT[row.metaTone])}>
                        {row.meta}
                    </span>
                ) : null}
            </div>
            <div className="flex items-center gap-2">
                <span className={cn("font-mono text-[10px]", TONE_TEXT[row.stateTone])}>{row.state}</span>
                {row.action != null ? (
                    <button type="button" onClick={act} className={ROW_BTN}>
                        {ROW_ACTION_LABEL[row.action]}
                    </button>
                ) : null}
            </div>
        </div>
    );
}

// The exceptions lifted above the list, carrying the digest's own action names. A child's question is
// left out: the questions card above already holds every one that is the human's to answer.
function Attention({ ctx, digest, group }: { ctx: SheetCtx; digest: DagStatusDigest; group: TaskGroup }) {
    const asking = new Set((digest.tasks ?? []).filter((td) => td.waitreason === "ask").map((td) => td.taskid));
    const entries = attentionQueue(digest, group).filter((e) => !asking.has(e.taskId));
    if (entries.length === 0) {
        return null;
    }
    return (
        <div className="mb-2.5 flex flex-col gap-1.5">
            {entries.map((entry) => (
                <AttentionRow key={entry.taskId} ctx={ctx} entry={entry} />
            ))}
        </div>
    );
}

function AttentionRow({ ctx, entry }: { ctx: SheetCtx; entry: QueueEntry }) {
    const worker = useTaskWorker({ id: entry.taskId, runid: entry.runId }, ctx.agents);
    const openWorker = entry.target === "worker" && worker.state !== "pending";
    const go = () =>
        openWorker
            ? openTaskWorker(worker, ctx.model)
            : openDagTask(ctx.channel.oid, ctx.run.id, "dag:" + ctx.run.dagoref, entry.taskId);
    return (
        <button
            type="button"
            onClick={go}
            title={openWorker ? "Open the worker" : "Show this task in the DAG"}
            className="flex w-full cursor-pointer items-center gap-[9px] rounded-[8px] border border-warning/30 bg-warning/12 px-[11px] py-2 text-left hover:border-warning focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        >
            <span className="h-1.5 w-1.5 flex-none rounded-full bg-warning" />
            <span className="flex-none font-mono text-[11px] font-medium text-ink-hi">{entry.label}</span>
            <span className="min-w-0 flex-1 truncate text-[12px] text-secondary">{entry.detail}</span>
            {entry.actions.length > 0 ? (
                <span className="flex-none rounded-[5px] border border-warning/45 px-[7px] py-0.5 font-mono text-[9.5px] text-warning-soft">
                    {entry.actions.join("/")}
                </span>
            ) : null}
        </button>
    );
}

function EmptyBox({ title, body, act }: { title: string; body: string; act?: ReactNode }) {
    return (
        <div
            data-run-sheet-empty
            className="flex flex-col gap-[7px] rounded-[10px] border border-dashed border-edge-strong px-3.5 py-[13px]"
        >
            <span className="text-[12.5px] font-semibold text-ink-hi">{title}</span>
            <span className="text-[11.5px] leading-[1.5] text-muted">{body}</span>
            {act}
        </div>
    );
}

function EmptyTasks({ ctx, dag }: { ctx: SheetCtx; dag: SheetDagRead | null }) {
    const { run, model, agents } = ctx;
    const actClass = cn(SHEET_BTN, "mt-[3px] self-start px-[11px] py-[5px]");
    if (dag == null) {
        if (run.mode === "orchestrator") {
            return (
                <EmptyBox
                    title="No tasks yet"
                    body="The lead writes the plan first. Nothing is dispatched until it submits one."
                />
            );
        }
        const worker = leadWorker(run, agents);
        return (
            <EmptyBox
                title="No task graph"
                body="A quick run is one worker on one goal. Its transcript is the whole run; the Agent view is where it is watched."
                act={
                    worker != null ? (
                        <button type="button" onClick={() => jumpToAgent(model, worker.id)} className={actClass}>
                            Open in Agent ↗
                        </button>
                    ) : undefined
                }
            />
        );
    }
    const loading = dag.groupRead === "loading" || (dag.digest.digest == null && dag.digest.loading);
    if (loading) {
        return (
            <div data-jarvis-brief-sheet-state="loading" className="flex flex-col gap-[11px] pt-0.5">
                <span className="h-[30px] animate-pulse rounded-[8px] bg-surface-raised motion-reduce:animate-none" />
                <span className="h-[30px] w-[72%] animate-pulse rounded-[8px] bg-surface-raised motion-reduce:animate-none" />
            </div>
        );
    }
    const canRetry = dag.groupRead === "ready" && dag.digest.retry != null;
    return (
        <EmptyBox
            title="DAG status unavailable"
            body="The run links a task graph, but the read failed. Nothing about the tasks is shown rather than the run's launch snapshot, which is not what the scheduler is running."
            act={
                canRetry ? (
                    <button type="button" onClick={dag.digest.retry} className={actClass}>
                        Retry the read
                    </button>
                ) : undefined
            }
        />
    );
}

// A done run's body: what landed, then the sealed evidence the run's own numbers came from.
function Evidence({ ctx, dag }: { ctx: SheetCtx; dag: SheetDagRead | null }) {
    const { run, model } = ctx;
    const ev = run.evidence;
    if (ev == null) {
        return (
            <div data-jarvis-brief-sheet-state="loading" className="flex flex-col gap-[11px] pt-[18px]">
                <span className="h-[30px] animate-pulse rounded-[8px] bg-surface-raised motion-reduce:animate-none" />
                <span className="text-[12px] text-ink-mid">Sealing this run's evidence…</span>
            </div>
        );
    }
    const digest = dag?.digest.digest;
    const briefs = taskBriefs(dag?.group ?? undefined);
    const commits = digest?.report?.commits ?? [];
    const files = ev.files ?? [];
    const counts = verifCounts(ev.verifs ?? []);
    const shape = digest?.shape;
    const lines = [
        [
            shape != null ? `${shape.tasks} tasks · ${shape.lanes} lanes` : null,
            ev.durationms ? `${formatElapsed(ev.durationms)} wall` : null,
            digest?.report?.workerms ? `${formatElapsed(digest.report.workerms)} worker time` : null,
        ]
            .filter(Boolean)
            .join(" · "),
        `+${ev.addtotal} −${ev.deltotal} across ${files.length} ${files.length === 1 ? "file" : "files"}`,
        (ev.verifs ?? []).length > 0
            ? `verification: ${counts.pass} passed, ${counts.fail} failed${counts.unknown ? `, ${counts.unknown} unknown` : ""}`
            : "verification: none recorded",
        digest?.report?.unverified ? "unverified: a landed commit has no test attributed" : null,
    ].filter((l): l is string => !!l);

    return (
        <div className="flex flex-col gap-4 pt-4" data-evidence-block>
            <div className="flex flex-col gap-[9px]">
                <span className={EYEBROW}>what landed</span>
                {commits.length > 0
                    ? commits.map((c) => (
                          <div
                              key={`${c.taskid}:${c.commit}`}
                              className="grid grid-cols-[72px_minmax(0,1fr)] items-baseline gap-3 border-b border-edge-faint py-[9px]"
                          >
                              <span className="font-mono text-[11px] font-medium text-ink-mid">
                                  {c.commit.slice(0, 7)}
                              </span>
                              <span className="min-w-0 text-[12.5px] leading-[1.35] text-ink-hi">
                                  {briefs.get(c.taskid)?.label || c.taskid}
                              </span>
                          </div>
                      ))
                    : files.slice(0, 8).map((f) => (
                          <button
                              key={f.path}
                              type="button"
                              onClick={() =>
                                  openDiff(model, runDiffScope(run.id, run.projectpath, run.basecommit), f.path)
                              }
                              className="grid cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-baseline gap-3 border-b border-edge-faint py-[9px] text-left hover:bg-surface-hover"
                          >
                              <span className="truncate font-mono text-[11.5px] text-ink-hi">{f.path}</span>
                              <span className="font-mono text-[10px] text-muted">
                                  +{f.add} −{f.del}
                              </span>
                          </button>
                      ))}
                {commits.length === 0 && files.length === 0 ? (
                    <span className="text-[12px] text-muted">Nothing landed in the repository.</span>
                ) : null}
                {commits.length === 0 && files.length > 8 ? (
                    <span className="font-mono text-[10.5px] text-ink-faint">+{files.length - 8} more files</span>
                ) : null}
            </div>
            <div className="flex flex-col gap-[7px]">
                <span className={EYEBROW}>sealed evidence</span>
                <div className="flex flex-col font-mono text-[11px] leading-[1.6] text-secondary">
                    {lines.map((l) => (
                        <span key={l}>{l}</span>
                    ))}
                </div>
                {ev.summary ? (
                    <p className="line-clamp-4 text-[12px] leading-[1.55] text-ink-mid">{ev.summary}</p>
                ) : null}
                <button
                    type="button"
                    onClick={() => openDiff(model, runDiffScope(run.id, run.projectpath, run.basecommit))}
                    className={cn(LINK, "self-start")}
                >
                    open the repository diff ↗
                </button>
            </div>
        </div>
    );
}

function Dock({ ctx, group }: { ctx: SheetCtx; group: TaskGroup | null }) {
    const { model, channel, run, agents } = ctx;
    const [saving, setSaving] = useState(false);
    const [result, setResult] = useState<{ failed: boolean; text: string } | null>(null);
    const lead = run.mode === "orchestrator" && !isTerminal(run.status) ? leadWorker(run, agents) : undefined;
    // a finished orchestrator has no dials left, so the dock's first slot carries its configuration forward
    const carryForward = run.status === "done" && run.mode === "orchestrator";
    const saveDefaults = () => {
        setSaving(true);
        setResult(null);
        fireAndForget(async () => {
            try {
                await saveRunAsDefaults(run, runSettingsDraft(run, group));
                setResult({ failed: false, text: "Saved as this project's defaults." });
            } catch (e) {
                setResult({ failed: true, text: String(e) });
            } finally {
                setSaving(false);
            }
        });
    };
    return (
        <div className="flex flex-col gap-1.5 border-t border-edge-faint px-4 py-[11px]">
            <div className="flex items-center gap-2">
                {carryForward ? (
                    <button type="button" disabled={saving} onClick={saveDefaults} className={DOCK_ACCENT}>
                        {saving ? "Saving…" : "Save as project defaults"}
                    </button>
                ) : null}
                {run.dagoref ? (
                    <button
                        type="button"
                        onClick={() => openDagLive(channel.oid, run.id, "dag:" + run.dagoref)}
                        className={carryForward ? DOCK_BTN : DOCK_ACCENT}
                    >
                        Open DAG
                    </button>
                ) : null}
                {lead != null ? (
                    <button type="button" onClick={() => jumpToAgent(model, lead.id)} className={DOCK_BTN}>
                        Open lead ↗
                    </button>
                ) : null}
                <button
                    type="button"
                    onClick={() => openJarvisWithSource(model, sourceRefForRun(run))}
                    className={DOCK_BTN}
                >
                    Ask Jarvis
                </button>
                <span className="flex-1" />
                {!isTerminal(run.status) ? (
                    <CancelRunButton
                        channelId={channel.oid}
                        run={run}
                        agents={agents}
                        className={cn(DOCK_BTN, "border-edge-mid text-muted hover:border-error hover:text-error")}
                    />
                ) : null}
            </div>
            {result != null ? (
                <span className={cn("text-[11px]", result.failed ? "text-error" : "text-success")}>{result.text}</span>
            ) : null}
        </div>
    );
}
