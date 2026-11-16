// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// wsh jarvis dag calls about the run itself: plan submit, review verdicts, Final, completion, and the dag status view.
// Each card draws from argv first, then the run and dag status in wshdata, so a missing run still leaves the card.

import * as WOS from "@/app/store/wos";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { cn, fireAndForget } from "@/util/util";
import { ArrowUpRight, Check, CircleDot, GitCommitVertical, LoaderCircle, Share2, X } from "lucide-react";
import { useState, type ReactNode } from "react";
import type { OpenTarget } from "../jarvis/address";
import { shotRounds, stageHasShots } from "../jarvis/finalshotsmodel";
import { FinalShotsViewer } from "../jarvis/finalshotsviewer";
import { openTarget } from "../jarvis/openref";
import { plural } from "./cockpitsurfacemodel";
import {
    completeModel,
    dagChannelId,
    dagDataKey,
    dagRunId,
    dagStatusModel,
    finalArgs,
    finalModel,
    fmtElapsed,
    planReviewModel,
    reviewModel,
    runDataKey,
    submitModel,
    type DagStatusRow,
    type PlanReviewLine,
    type RunStats,
    type TaskPill,
} from "./dagcards";
import type { TranscriptContext } from "./transcriptcontext";
import { CallFacts } from "./wshchangerow";
import { useWshData, type WshDataState } from "./wshdata";
import type { WshRendererProps, WshRenderers } from "./wshrenderers";

type Tone = "pass" | "fail" | "warn" | "plain";

// wshrenderers.tsx's AsOfNow, drawn here because this module may load first (Task 12's wakes import FinalVerdictCard)
// and a value import of the registry would then read DAG_RENDERERS before it exists
function AsOfNow() {
    return <span className="shrink-0 font-mono text-[10.5px] text-muted">as of now</span>;
}

const TONE_TEXT: Record<Tone, string> = {
    pass: "text-success",
    fail: "text-error",
    warn: "text-warning",
    plain: "text-foreground",
};

async function fetchRun(runId: string): Promise<Run> {
    const run = await WOS.loadAndPinWaveObject<Run>(WOS.makeORef("run", runId));
    if (run == null) {
        throw new Error(`run ${runId} not found`);
    }
    return run;
}

async function fetchDag(runId: string, channelId: string | undefined): Promise<CommandDagStatusRtnData> {
    const channel = channelId || (await fetchRun(runId)).channeloid;
    if (!channel) {
        throw new Error(`run ${runId} has no channel`);
    }
    return RpcApi.DagStatusCommand(TabRpcClient, { channelid: channel, runid: runId });
}

function useDagStatus(runId: string | undefined, channelId: string | undefined) {
    return useWshData<CommandDagStatusRtnData>(runId ? dagDataKey(runId) : null, () => fetchDag(runId!, channelId));
}

function useRunObj(runId: string | undefined) {
    return useWshData<Run>(runId ? runDataKey(runId) : null, () => fetchRun(runId!));
}

function Shell({ tone = "plain", compact, children }: { tone?: Tone; compact: boolean; children: ReactNode }) {
    return (
        <div
            className={cn(
                "overflow-hidden border font-sans",
                compact ? "rounded-[8px]" : "rounded-[10px]",
                tone === "fail" ? "border-error/35" : tone === "warn" ? "border-warning/35" : "border-edge-mid"
            )}
        >
            {children}
        </div>
    );
}

function Head({ tone = "plain", compact, children }: { tone?: Tone; compact: boolean; children: ReactNode }) {
    return (
        <div
            className={cn(
                "flex items-center",
                compact ? "gap-2 px-2.5 py-2 text-[12.5px]" : "gap-2.5 px-3.5 py-3 text-[13.5px]",
                tone === "fail" && "bg-error/[0.06]",
                tone === "warn" && "bg-warning/[0.06]"
            )}
        >
            {children}
        </div>
    );
}

// a section under the head, split from it by a faint rule
function Section({ compact, className, children }: { compact: boolean; className?: string; children: ReactNode }) {
    return (
        <div
            className={cn(
                "border-t border-edge-faint",
                compact ? "px-2.5 py-1.5 text-[12px]" : "px-3.5 py-2.5 text-[13px]",
                className
            )}
        >
            {children}
        </div>
    );
}

const Label = ({ children }: { children: ReactNode }) => <span className="shrink-0 text-ink-mid">{children}</span>;

const Mono = ({ children, className }: { children: ReactNode; className?: string }) => (
    <span className={cn("font-mono text-[12px]", className)}>{children}</span>
);

const Spacer = () => <span className="min-w-[6px] flex-1" />;

// a verdict's round chip: a check or a cross on a tinted disc
function Mark({ tone, compact }: { tone: Tone; compact: boolean }) {
    const Icon = tone === "fail" ? X : Check;
    return (
        <span
            role="img"
            aria-label={tone === "fail" ? "Failed" : "Passed"}
            className={cn(
                "inline-flex shrink-0 items-center justify-center rounded-full",
                compact ? "size-3.5" : "size-4",
                tone === "fail"
                    ? "bg-error/15 text-error"
                    : tone === "warn"
                      ? "bg-warning/15 text-warning"
                      : "bg-success/15 text-success"
            )}
        >
            <Icon size={compact ? 9 : 10} strokeWidth={3.2} aria-hidden />
        </span>
    );
}

// a router link; draws nothing without the cockpit model to route through
function CardLink({
    ctx,
    target,
    label,
    compact,
}: {
    ctx: TranscriptContext;
    target?: OpenTarget;
    label: string;
    compact: boolean;
}) {
    const model = ctx.model;
    if (model == null || target == null) {
        return null;
    }
    return (
        <button
            type="button"
            onClick={() => fireAndForget(() => openTarget(model, target))}
            className={cn(
                "inline-flex shrink-0 cursor-pointer items-center gap-1 text-ink-mid hover:text-foreground",
                compact ? "text-[11.5px]" : "text-[12px]"
            )}
        >
            {label}
            {compact ? null : <ArrowUpRight size={11} strokeWidth={2.2} aria-hidden />}
        </button>
    );
}

// a fetch that failed and left nothing to show: the card stays, from argv, and says what it could not load
function LoadError({ state, what, compact }: { state: WshDataState<unknown>; what: string; compact: boolean }) {
    if (state.status !== "error" || state.data !== undefined) {
        return null;
    }
    return (
        <Section compact={compact} className="text-muted">
            <span data-wsh-load-error>
                Couldn't load {what}: {state.error}
            </span>
        </Section>
    );
}

function reviewLineText(r: PlanReviewLine): { tone: Tone; head: string; tail?: string } {
    const head = r.state === "reviewing" ? `Plan review, round ${r.round}` : `Plan review ${r.state}, round ${r.round}`;
    if (r.state !== "reviewing") {
        return { tone: r.state === "passed" ? "pass" : r.state === "failed" ? "fail" : "warn", head };
    }
    const n = r.readers.length;
    const tail = n === 0 ? undefined : `${r.readers.join(" and ")} ${n === 1 ? "is" : "are"} reading it`;
    return { tone: "plain", head, tail };
}

function ReviewStatus({ review, compact }: { review: PlanReviewLine; compact: boolean }) {
    const { tone, head, tail } = reviewLineText(review);
    const size = compact ? 12 : 13;
    return (
        <Section compact={compact} className="flex items-center gap-2.5 text-muted">
            {review.state === "reviewing" ? (
                <LoaderCircle
                    size={size}
                    strokeWidth={2.2}
                    role="img"
                    aria-label="Running"
                    className="shrink-0 animate-spin text-ink-mid"
                />
            ) : tone === "fail" ? (
                <X size={size} strokeWidth={2.6} aria-hidden className="shrink-0 text-error" />
            ) : (
                <Check size={size} strokeWidth={2.6} aria-hidden className={cn("shrink-0", TONE_TEXT[tone])} />
            )}
            <span>{head}</span>
            {tail ? (
                <>
                    <span>·</span>
                    <span className="min-w-0 truncate">{tail}</span>
                </>
            ) : null}
            <Spacer />
            <AsOfNow />
        </Section>
    );
}

function DagSubmitCard({ call, action, ctx, compact }: WshRendererProps) {
    const runId = dagRunId(call, ctx);
    const state = useDagStatus(runId, dagChannelId(call, ctx));
    const group = state.data?.group;
    const m = submitModel(call, group);
    const icon = <Share2 size={compact ? 13 : 15} strokeWidth={2} aria-hidden className="shrink-0 text-ink-mid" />;
    const facts = <CallFacts action={action} compact={compact} />;
    if (m.kind === "round") {
        const count = m.tasks.length > 0 ? plural(m.tasks.length, "task") : undefined;
        const sub = [count, m.last ? "the last round" : undefined].filter(Boolean).join(" · ");
        return (
            <Shell compact={compact}>
                <Head compact={compact}>
                    {icon}
                    <Label>Fix round submitted</Label>
                    {m.round != null ? <span className="font-semibold text-foreground">round {m.round}</span> : null}
                    {sub ? <span className="min-w-0 truncate text-[12.5px] text-muted">{sub}</span> : null}
                    <Spacer />
                    {facts}
                </Head>
                {m.tasks.length > 0 ? (
                    <div className={cn("flex flex-col border-t border-edge-faint", compact ? "py-1" : "py-1.5")}>
                        {m.tasks.map((t) => (
                            <div
                                key={t.id}
                                data-round-task={t.id}
                                className={cn(
                                    "flex items-center gap-2.5 text-secondary",
                                    compact ? "px-2.5 py-1 text-[12px]" : "px-3.5 py-[5px] text-[13px]"
                                )}
                            >
                                <Mono className="w-9 shrink-0 text-foreground">{t.id}</Mono>
                                <span className="min-w-0 truncate">{t.label}</span>
                            </div>
                        ))}
                    </div>
                ) : null}
                <LoadError state={state} what="the dag" compact={compact} />
            </Shell>
        );
    }
    const shape =
        m.tasks != null
            ? `${plural(m.tasks, "task")} · ${plural(m.lanes ?? 0, "lane")} · longest chain ${m.longestChain}`
            : undefined;
    const planTarget: OpenTarget | undefined = group ? { kind: "dag", dagId: group.oid || group.id } : undefined;
    return (
        <Shell compact={compact}>
            <Head compact={compact}>
                {icon}
                <Label>Plan submitted</Label>
                {shape ? <span className="min-w-0 truncate font-semibold text-foreground">{shape}</span> : null}
                <Spacer />
                <CardLink ctx={ctx} target={planTarget} label="Plan" compact={compact} />
                {facts}
            </Head>
            {m.grid.length > 0 ? (
                <div
                    data-plan-grid
                    className={cn(
                        "grid border-t border-edge-faint text-secondary",
                        compact
                            ? "gap-x-4 gap-y-1 px-2.5 py-2 text-[12px]"
                            : "gap-x-7 gap-y-1.5 px-3.5 pt-2.5 pb-3 text-[12.5px]"
                    )}
                    style={{ gridTemplateColumns: `repeat(${m.columns}, minmax(0, 1fr))` }}
                >
                    {m.grid.flatMap((lane) =>
                        Array.from({ length: m.columns }, (_, i) => {
                            const cell = lane[i];
                            if (cell == null) {
                                return <div key={`${lane[0].id}-${i}`} />;
                            }
                            return (
                                <div key={cell.id} data-plan-task={cell.id} className="flex min-w-0 items-center gap-2">
                                    {cell.after.length > 0 ? (
                                        <span className="shrink-0 text-ink-faint">after {cell.after.join(", ")}</span>
                                    ) : null}
                                    <Mono className="shrink-0 text-[11px] text-muted">{cell.id}</Mono>
                                    <span className="min-w-0 truncate">{cell.label}</span>
                                </div>
                            );
                        })
                    )}
                </div>
            ) : null}
            {m.review ? <ReviewStatus review={m.review} compact={compact} /> : null}
            <LoadError state={state} what="the dag" compact={compact} />
        </Shell>
    );
}

function TaskReviewCard({ call, action, ctx, compact }: WshRendererProps) {
    const state = useDagStatus(dagRunId(call, ctx), dagChannelId(call, ctx));
    const m = reviewModel(call, ctx, state.data?.group);
    const tone: Tone = m.passed ? "pass" : "fail";
    return (
        <Shell tone={tone === "fail" ? "fail" : "plain"} compact={compact}>
            <Head tone={tone === "fail" ? "fail" : "plain"} compact={compact}>
                <Mark tone={tone} compact={compact} />
                <Label>Task review</Label>
                {m.taskId ? <Mono className="text-foreground">{m.taskId}</Mono> : null}
                <span className={cn("font-semibold", TONE_TEXT[tone])}>{m.passed ? "passed" : "sent back"}</span>
                {m.round != null ? (
                    <span className="text-[12.5px] text-muted">
                        round {m.round} of {m.total}
                    </span>
                ) : null}
                <Spacer />
                <CallFacts action={action} compact={compact} />
            </Head>
            {m.note ? (
                <Section compact={compact} className="leading-[1.55] whitespace-pre-wrap text-secondary">
                    {m.note}
                </Section>
            ) : null}
        </Shell>
    );
}

function PlanReviewCard({ call, action, compact }: WshRendererProps) {
    const m = planReviewModel(call);
    return (
        <Shell tone={m.tone === "fail" ? "fail" : "plain"} compact={compact}>
            <Head tone={m.tone === "fail" ? "fail" : "plain"} compact={compact}>
                <Mark tone={m.tone} compact={compact} />
                <Label>Plan review</Label>
                <span className={cn("font-semibold", TONE_TEXT[m.tone])}>{m.verdict}</span>
                <Spacer />
                <CallFacts action={action} compact={compact} />
            </Head>
            {m.text ? (
                <Section compact={compact} className="leading-[1.55] whitespace-pre-wrap text-secondary">
                    {m.text}
                </Section>
            ) : null}
        </Shell>
    );
}

// Final's screenshots for one round, in the run sheet's viewer
function ShotsLink({ group, round, compact }: { group: TaskGroup; round: number; compact: boolean }) {
    const [open, setOpen] = useState(false);
    return (
        <>
            <button
                type="button"
                data-final-shots-link
                onClick={() => setOpen(true)}
                className={cn(
                    "inline-flex shrink-0 cursor-pointer items-center gap-1 text-ink-mid hover:text-foreground",
                    compact ? "text-[11.5px]" : "text-[12px]"
                )}
            >
                Shots
                {compact ? null : <ArrowUpRight size={11} strokeWidth={2.2} aria-hidden />}
            </button>
            {open ? <FinalShotsViewer group={group} initial={{ round }} onClose={() => setOpen(false)} /> : null}
        </>
    );
}

function roundHasShots(group: TaskGroup, round: number): boolean {
    const stage = [...(group.pastfinals ?? []), ...(group.final ? [group.final] : [])].find((s) => s.round === round);
    return stage != null && shotRounds(group).some((r) => r.round === round) && stageHasShots(stage);
}

export interface FinalVerdictCardProps {
    passed: boolean;
    round?: number;
    total?: number;
    sha?: string;
    text?: string;
    runId?: string;
    ctx: TranscriptContext;
    compact: boolean;
}

function FinalCard({ facts, ...props }: FinalVerdictCardProps & { facts?: ReactNode }) {
    const { runId, ctx, compact } = props;
    const state = useDagStatus(runId, ctx.channelId);
    const group = state.data?.group;
    const m = finalModel(props, group, roundHasShots);
    const tone: Tone = m.passed ? "pass" : "fail";
    const where = [
        m.round != null ? `round ${m.round}${m.total != null ? ` of ${m.total}` : ""}` : undefined,
        m.sha ? "on the merged result" : undefined,
    ].filter(Boolean);
    return (
        <Shell tone={tone === "fail" ? "fail" : "plain"} compact={compact}>
            <Head tone={tone === "fail" ? "fail" : "plain"} compact={compact}>
                <Mark tone={tone} compact={compact} />
                <Label>Final</Label>
                <span className={cn("font-semibold", TONE_TEXT[tone])}>{m.passed ? "passed" : "failed"}</span>
                {where.length > 0 ? (
                    <span className="min-w-0 truncate text-[12.5px] text-muted">
                        {where.join(" · ")}
                        {m.sha ? <Mono className="ml-1 text-[11.5px]">{m.sha}</Mono> : null}
                    </span>
                ) : null}
                <Spacer />
                {group && m.hasShots && m.round != null ? (
                    <ShotsLink group={group} round={m.round} compact={compact} />
                ) : null}
                {facts}
            </Head>
            {m.text ? (
                <Section compact={compact} className="leading-[1.55] whitespace-pre-wrap text-secondary">
                    {m.text}
                </Section>
            ) : null}
            {m.unverified.length > 0 ? (
                <Section compact={compact} className="leading-[1.55]">
                    <div className="mb-1 text-[12px] font-semibold text-warning">Unverified</div>
                    {m.unverified.map((u, i) => (
                        <div key={i} className="text-secondary">
                            {u}
                        </div>
                    ))}
                </Section>
            ) : null}
            {props.runId ? <LoadError state={state} what="the dag" compact={compact} /> : null}
        </Shell>
    );
}

// Final's verdict, shared by the dag-final card and the run-finished wake
export function FinalVerdictCard(props: FinalVerdictCardProps) {
    return <FinalCard {...props} />;
}

function DagFinalCard({ call, action, ctx, compact }: WshRendererProps) {
    const { passed, text } = finalArgs(call);
    return (
        <FinalCard
            passed={passed}
            text={text}
            runId={dagRunId(call, ctx)}
            ctx={{ ...ctx, channelId: dagChannelId(call, ctx) }}
            compact={compact}
            facts={<CallFacts action={action} compact={compact} />}
        />
    );
}

function statsWords(s: RunStats): string[] {
    return [
        plural(s.tasks, "task"),
        plural(s.failures, "failure"),
        s.elapsedMs != null ? fmtElapsed(s.elapsedMs) : undefined,
        plural(s.commits, "commit"),
        `${plural(s.questions, "question")} to you`,
    ].filter((w): w is string => w != null);
}

function Stats({ stats, compact }: { stats: RunStats; compact: boolean }) {
    const words = statsWords(stats);
    return (
        <Section compact={compact} className={cn("text-muted", compact ? "text-[11.5px]" : "text-[12.5px]")}>
            <div data-run-stats className={cn("flex flex-wrap", compact ? "gap-x-1.5" : "gap-x-[18px] gap-y-1.5")}>
                {compact ? <span>{words.join(" · ")}</span> : words.map((w) => <span key={w}>{w}</span>)}
            </div>
        </Section>
    );
}

function CompleteCard({ call, action, ctx, compact }: WshRendererProps) {
    const runId = dagRunId(call, ctx);
    const isTask = ctx.role?.kind === "worker";
    const runState = useRunObj(isTask ? undefined : runId);
    const dagState = useDagStatus(runId, dagChannelId(call, ctx) || runState.data?.channeloid);
    const m = completeModel(call, ctx, runState.data, dagState.data);
    const facts = <CallFacts action={action} compact={compact} />;
    const iconSize = compact ? 13 : 15;
    if (m.kind === "task") {
        const report: OpenTarget | undefined = m.dagId ? { kind: "dag", dagId: m.dagId, taskId: m.taskId } : undefined;
        return (
            <Shell compact={compact}>
                <Head compact={compact}>
                    <Mark tone="pass" compact={compact} />
                    <Label>Task complete</Label>
                    {m.taskId ? <Mono className="text-foreground">{m.taskId}</Mono> : null}
                    {m.sha ? (
                        <span className="text-secondary">
                            commit <Mono>{m.sha}</Mono>
                        </span>
                    ) : null}
                    <Spacer />
                    <CardLink ctx={ctx} target={report} label="Report" compact={compact} />
                    {facts}
                </Head>
                <Section compact={compact} className="text-[12.5px] text-muted">
                    The engine takes it from here: review, then merge.
                </Section>
            </Shell>
        );
    }
    const report: OpenTarget | undefined = m.runId ? { kind: "run", runId: m.runId } : undefined;
    const loadError = <LoadError state={runState} what="the run" compact={compact} />;
    if (m.land === "held") {
        return (
            <Shell tone="warn" compact={compact}>
                <Head tone="warn" compact={compact}>
                    <CircleDot size={iconSize - 1} strokeWidth={2.4} aria-hidden className="shrink-0 text-warning" />
                    <Label>Run complete</Label>
                    <span className="shrink-0 font-semibold text-warning">land held</span>
                    {m.reason ? <span className="min-w-0 truncate text-[12.5px] text-muted">{m.reason}</span> : null}
                    <Spacer />
                    <CardLink ctx={ctx} target={report} label="Report" compact={compact} />
                    {facts}
                </Head>
                <div className="border-t border-edge-faint">
                    <div
                        className={cn(
                            "leading-[1.55] text-secondary",
                            compact ? "px-2.5 pt-1.5 text-[12px]" : "px-3.5 pt-2.5 pb-1 text-[13px]"
                        )}
                    >
                        {m.branch ? (
                            <>
                                The branch <Mono>{m.branch}</Mono> stays unmerged.{" "}
                            </>
                        ) : (
                            "The run stays unmerged. "
                        )}
                        {m.landLine?.endsWith("--force")
                            ? "Landing it anyway is your call, once you've read the report:"
                            : "Once its hold is cleared, land it with:"}
                    </div>
                    {m.landLine ? (
                        <div
                            data-land-line
                            className={cn(
                                "font-mono text-ink-mid",
                                compact ? "px-2.5 pt-1 pb-1.5 text-[11px]" : "px-3.5 pt-1 pb-2.5 text-[12px]"
                            )}
                        >
                            {m.landLine}
                        </div>
                    ) : null}
                </div>
                {m.stats ? <Stats stats={m.stats} compact={compact} /> : null}
                {loadError}
            </Shell>
        );
    }
    const landed = m.land === "landed";
    return (
        <Shell compact={compact}>
            <Head compact={compact}>
                {landed ? (
                    compact ? (
                        <Mark tone="pass" compact />
                    ) : (
                        <GitCommitVertical
                            size={iconSize}
                            strokeWidth={2}
                            aria-hidden
                            className="shrink-0 text-success"
                        />
                    )
                ) : (
                    <GitCommitVertical size={iconSize} strokeWidth={2} aria-hidden className="shrink-0 text-ink-mid" />
                )}
                <Label>Run complete</Label>
                {m.sha ? (
                    <span
                        className={cn("min-w-0 truncate", compact ? "text-secondary" : "font-semibold text-foreground")}
                    >
                        {landed ? "landed " : "commit "}
                        <Mono className={compact ? "text-[11px]" : "text-[12.5px]"}>{m.sha}</Mono>
                        {landed && !compact ? ` on ${m.base ?? "its base"}` : null}
                    </span>
                ) : null}
                <Spacer />
                <CardLink ctx={ctx} target={report} label="Report" compact={compact} />
                {facts}
            </Head>
            {m.stats ? <Stats stats={m.stats} compact={compact} /> : null}
            {loadError}
        </Shell>
    );
}

const PILL_TEXT: Record<TaskPill, string> = {
    landed: "text-success",
    done: "text-success",
    running: "text-success",
    asks: "text-warning",
    review: "text-ink-mid",
    queued: "text-ink-faint",
    failed: "text-error",
    muted: "text-muted",
};

const PILL_DOT: Record<TaskPill, string> = {
    landed: "bg-success",
    done: "bg-success",
    running: "bg-success",
    asks: "bg-warning",
    review: "bg-ink-mid",
    queued: "bg-ink-faint",
    failed: "bg-error",
    muted: "bg-muted",
};

function PillIcon({ pill, size }: { pill: TaskPill; size: number }) {
    if (pill === "landed" || pill === "done") {
        return <Check size={size} strokeWidth={3} aria-hidden className="shrink-0" />;
    }
    return <span className={cn("size-1.5 shrink-0 rounded-full", PILL_DOT[pill])} />;
}

function StatusRowFull({ row }: { row: DagStatusRow }) {
    return (
        <>
            <Mono className="text-[11.5px] text-muted">{row.id}</Mono>
            <span
                data-task-pill={row.pill}
                className={cn("inline-flex items-center gap-[5px] text-[12px]", PILL_TEXT[row.pill])}
            >
                <PillIcon pill={row.pill} size={10} />
                {row.pillText}
            </span>
            <span className="min-w-0 truncate text-secondary">{row.label}</span>
            <span className={cn("text-ink-faint", row.rightMono ? "font-mono text-[11px]" : "text-[12px]")}>
                {row.right ?? ""}
            </span>
        </>
    );
}

function StatusRowCompact({ row }: { row: DagStatusRow }) {
    const icon =
        row.pill === "running" ? (
            <LoaderCircle size={10} strokeWidth={2.8} aria-hidden className="shrink-0 text-ink-mid" />
        ) : (
            <span className={cn("size-1.5 shrink-0 rounded-full", PILL_DOT[row.pill])} />
        );
    const state = row.pill === "running" && row.right ? `${row.pillText} ${row.right}` : row.pillText;
    return (
        <div data-task-pill={row.pill} className="flex items-center gap-2 px-2.5 py-1 text-[12px]">
            {icon}
            <Mono className="w-[26px] shrink-0 text-[11px] text-foreground">{row.id}</Mono>
            <span className="min-w-0 flex-1 truncate text-secondary">{row.label}</span>
            <span className={cn("shrink-0", row.pill === "running" ? "text-ink-mid" : PILL_TEXT[row.pill])}>
                {state}
            </span>
        </div>
    );
}

function DagStatusView({ call, ctx, compact }: WshRendererProps) {
    const runId = dagRunId(call, ctx);
    const state = useDagStatus(runId, dagChannelId(call, ctx));
    const muted = cn("text-muted", compact ? "text-[12px]" : "text-[12.5px]");
    if (state.data == null) {
        const text =
            runId == null
                ? "No run to read the dag of."
                : state.status === "error"
                  ? `Couldn't load the dag: ${state.error}`
                  : "Loading the dag…";
        return (
            <div data-wsh-load-error={state.status === "error" ? true : undefined} className={muted}>
                {text}
            </div>
        );
    }
    const m = dagStatusModel(state.data, call.args[0], Date.now(), fmtElapsed);
    if (compact) {
        return (
            <div data-dag-status className="flex flex-col rounded-[6px] border border-edge-faint bg-surface py-1">
                {m.rows.map((row) => (
                    <StatusRowCompact key={row.id} row={row} />
                ))}
            </div>
        );
    }
    const status = m.status ? m.status[0].toUpperCase() + m.status.slice(1) : "";
    return (
        <div data-dag-status className="overflow-hidden rounded-[8px] border border-edge-mid bg-surface">
            <div className="flex items-center gap-2.5 border-b border-edge-faint px-3 py-2 text-[12.5px] text-muted">
                <span className="font-semibold text-secondary">{status}</span>
                <span>
                    {m.done} of {m.total} done
                </span>
                <Spacer />
                <span>parallelism {m.parallelism}</span>
                <AsOfNow />
            </div>
            <div className="grid grid-cols-[auto_auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5 px-3 py-2 text-[13px]">
                {m.rows.map((row) => (
                    <StatusRowFull key={row.id} row={row} />
                ))}
            </div>
        </div>
    );
}

export const DAG_RENDERERS: WshRenderers = {
    "dag-submit": DagSubmitCard,
    "dag-planreview": PlanReviewCard,
    "dag-review": TaskReviewCard,
    "dag-final": DagFinalCard,
    "jarvis-complete": CompleteCard,
    "dag-status": DagStatusView,
};
