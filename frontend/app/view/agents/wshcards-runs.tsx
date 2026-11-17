// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// wsh runs calls: start and answer cards, and the runs show/attention views. The data and the wording of each live in
// runscards.ts; this draws them.

import * as WOS from "@/app/store/wos";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { cn } from "@/util/util";
import { ArrowUpRight, Check, MessageSquare } from "lucide-react";
import type { ReactNode } from "react";
import type { AgentActionEntry } from "./agentsviewmodel";
import { LoadFailure } from "./recordedoutput";
import { openRunBeside } from "./runrailsections";
import {
    attentionModel,
    attentionStepSummary,
    matchStartedRun,
    NOTHING_WAITING,
    runAnsweredModel,
    runShowModel,
    runShowSourceFromJson,
    runStartedModel,
    SHORT_RUN_ID,
    type RunShowSource,
    type Tone,
} from "./runscards";
import type { TranscriptContext } from "./transcriptcontext";
import { wshJsonOutput } from "./wshcall";
import { CallFacts } from "./wshchangerow";
import { useWshData } from "./wshdata";
import { AsOfNow, type WshRendererProps, type WshRenderers, type WshStepSummaries } from "./wshrenderers";

const TONE_TEXT: Record<Tone, string> = {
    ok: "text-success",
    warn: "text-warning",
    bad: "text-error",
    muted: "text-muted",
};
const TONE_DOT: Record<Tone, string> = {
    ok: "bg-success",
    warn: "bg-warning",
    bad: "bg-error",
    muted: "bg-muted",
};

// the run glyph the boards draw: three nodes and the two edges joining them
function RunGlyph({ size }: { size: number }) {
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            className="shrink-0 text-ink-mid"
        >
            <circle cx="5" cy="6" r="2.5" />
            <circle cx="5" cy="18" r="2.5" />
            <circle cx="19" cy="12" r="2.5" />
            <path d="M7.5 6.5L16.5 11M7.5 17.5L16.5 13" />
        </svg>
    );
}

function bashFacts(action: AgentActionEntry): { output?: string; exit?: number } {
    return action.detail?.kind === "bash" ? { output: action.detail.output, exit: action.detail.exit } : {};
}

// the call's own --json output, when it ran with --json and exited 0
function callJson<T>(action: AgentActionEntry): T | null {
    const { output, exit } = bashFacts(action);
    return wshJsonOutput<T>(action.command, output, exit);
}

function shortId(id: string): string {
    return id.slice(0, SHORT_RUN_ID);
}

// a link to the run: beside the transcript in the Rendered view, else through the router; with no model to route
// through, no link
function OpenRun({
    runId,
    ctx,
    label,
    compact,
}: {
    runId?: string;
    ctx: TranscriptContext;
    label: string;
    compact: boolean;
}) {
    const model = ctx.model;
    if (!model || !runId) {
        return null;
    }
    return (
        <button
            type="button"
            data-open-run={runId}
            onClick={(e) => openRunBeside(model, ctx.agentId, runId, e)}
            className={cn(
                "inline-flex shrink-0 cursor-pointer items-center gap-1 text-ink-mid hover:text-foreground",
                compact ? "text-[11.5px]" : "text-[12px]"
            )}
        >
            {label}
            <ArrowUpRight size={11} strokeWidth={2.2} aria-hidden />
        </button>
    );
}

function LoadNote({
    state,
    what,
    action,
    compact,
}: {
    state: { status: string; error?: string };
    what: string;
    action: AgentActionEntry;
    compact: boolean;
}) {
    if (state.error) {
        return <LoadFailure message={`Could not load ${what}: ${state.error}`} action={action} compact={compact} />;
    }
    return state.status === "loading" ? <div className="text-[12px] text-muted">{`Loading ${what}…`}</div> : null;
}

function StatusPill({ text, tone, compact }: { text: string; tone: Tone; compact: boolean }) {
    return (
        <span
            className={cn(
                "inline-flex shrink-0 items-center",
                TONE_TEXT[tone],
                compact ? "gap-[5px] text-[11.5px]" : "gap-1.5 text-[12px]"
            )}
        >
            <span className={cn("rounded-full", TONE_DOT[tone], compact ? "size-[5px]" : "size-1.5")} />
            {text}
        </span>
    );
}

// ---- runs show

async function optional<T>(what: string, p: Promise<T> | undefined): Promise<T | undefined> {
    try {
        return await p;
    } catch (e) {
        console.warn(`runs show: ${what} unavailable`, e);
        return undefined;
    }
}

// the run, its digest and its usage by id: current state, not the state when the call ran
async function fetchRunShow(runId: string): Promise<RunShowSource> {
    const run = await WOS.loadAndPinWaveObject<Run>(WOS.makeORef("run", runId));
    if (run == null) {
        throw new Error(`no run ${runId}`);
    }
    const channelId = run.channeloid;
    const read = channelId ? { channelid: channelId, runid: run.id } : undefined;
    const [dag, usage] = await Promise.all([
        optional("task digest", read && run.dagoref ? RpcApi.DagStatusCommand(TabRpcClient, read) : undefined),
        optional("usage", read ? RpcApi.RunUsageCommand(TabRpcClient, read) : undefined),
    ]);
    return { run, channelId, group: dag?.group, digest: dag?.digest, usage: usage?.usage };
}

function RunsShowView({ call, action, ctx, compact }: WshRendererProps) {
    const runId = call.args[0] ?? "";
    const json = runShowSourceFromJson(callJson(action));
    const state = useWshData<RunShowSource>(json || !runId ? null : `runs-show:${runId}`, () => fetchRunShow(runId));
    const src = json ?? state.data;
    if (src == null) {
        return <LoadNote state={state} what="the run" action={action} compact={compact} />;
    }
    const m = runShowModel(src, Date.now());
    const pad = compact ? "px-2.5 py-2" : "px-3 py-2.5";
    const label = compact ? "text-[11.5px]" : "text-[12px]";
    const body = compact ? "text-[12.5px]" : "text-[13px]";
    return (
        <div className="overflow-hidden rounded-[8px] border border-edge-mid bg-surface">
            <div className={cn("flex items-center gap-2.5", pad)}>
                <RunGlyph size={14} />
                <span
                    className={cn(
                        "min-w-0 truncate font-semibold text-foreground",
                        compact ? "text-[12.5px]" : "text-[13.5px]"
                    )}
                >
                    {m.title}
                </span>
                <span className="flex-1" />
                {json ? null : <AsOfNow />}
                <span className={cn("inline-flex shrink-0 items-center gap-1.5", TONE_TEXT[m.pill.tone], label)}>
                    {m.pill.sha ? <Check size={10} strokeWidth={3} aria-hidden /> : null}
                    {m.pill.text}
                    {m.pill.sha ? <span className="font-mono text-[11.5px]">{m.pill.sha}</span> : null}
                </span>
                <OpenRun runId={m.runId} ctx={ctx} label="Open" compact={compact} />
            </div>
            <div
                className={cn("grid border-t border-edge-faint", compact && "grid-cols-2")}
                style={compact ? undefined : { gridTemplateColumns: `repeat(${m.tiles.length}, minmax(0, 1fr))` }}
            >
                {m.tiles.map((t, i) => (
                    <div
                        key={t.label}
                        className={cn(
                            "px-3 py-[9px]",
                            i > 0 && !compact && "border-l border-edge-faint",
                            compact && i > 1 && "border-t border-edge-faint",
                            compact && i % 2 === 1 && "border-l border-edge-faint"
                        )}
                    >
                        <div className={cn("text-muted", label)}>{t.label}</div>
                        <div className={cn(body, t.tone ? TONE_TEXT[t.tone] : "text-foreground")}>{t.value}</div>
                    </div>
                ))}
            </div>
            {m.tokens ? (
                <div className={cn("border-t border-edge-faint", pad)}>
                    <div className={cn("mb-1.5 flex items-baseline gap-2.5 text-muted", label)}>
                        <span>Tokens</span>
                        <span className="text-secondary">{m.tokens.total}</span>
                        <span className="flex-1" />
                        <span>{m.tokens.meta}</span>
                    </div>
                    <div
                        role="img"
                        aria-label={`Tokens by role: ${m.tokens.roles.map((r) => `${r.label} ${r.text}`).join(", ")}`}
                        data-run-tokens
                        className="flex h-1.5 gap-0.5 overflow-hidden rounded-[3px]"
                    >
                        {m.tokens.roles.map((r) => (
                            <span key={r.role} className={r.fill} style={{ flex: r.tokens }} />
                        ))}
                    </div>
                    <div className={cn("mt-[7px] flex flex-wrap gap-x-3.5 gap-y-1 text-ink-mid", label)}>
                        {m.tokens.roles.map((r) => (
                            <span key={r.role} className="inline-flex items-center gap-[5px]">
                                <span className={cn("size-[7px] rounded-[2px]", r.fill)} />
                                {r.label} {r.text}
                            </span>
                        ))}
                    </div>
                </div>
            ) : null}
            {m.tasks.length > 0 ? (
                <div
                    className={cn(
                        "grid grid-cols-[auto_minmax(0,1fr)_auto] gap-x-3 gap-y-[5px] border-t border-edge-faint",
                        pad,
                        body
                    )}
                >
                    {m.tasks.map((t) => (
                        <TaskLine key={t.id} id={t.id} title={t.title} sha={t.sha} />
                    ))}
                </div>
            ) : null}
            {m.moreTasks > 0 ? (
                <div className={cn("border-t border-edge-faint px-3 py-[7px] text-muted", label)}>
                    {m.moreTasks} more {m.moreTasks === 1 ? "task" : "tasks"}
                </div>
            ) : null}
            {m.unverified.map((u) => (
                <div
                    key={u.taskId}
                    className={cn(
                        "border-t border-edge-faint px-3 py-[9px] leading-[1.5] text-secondary",
                        compact ? "text-[12px]" : "text-[12.5px]"
                    )}
                >
                    <span className="font-semibold text-warning">Unverified</span>{" "}
                    <span className="font-mono text-[11.5px] text-muted">{u.taskId}</span> {u.text}
                </div>
            ))}
        </div>
    );
}

function TaskLine({ id, title, sha }: { id: string; title: string; sha?: string }) {
    return (
        <>
            <span className="font-mono text-[11.5px] text-muted">{id}</span>
            <span className="truncate text-secondary">{title}</span>
            {sha ? (
                <span className="font-mono text-[11px] text-ink-faint">{sha}</span>
            ) : (
                <span className="text-[11.5px] text-ink-faint">no commit</span>
            )}
        </>
    );
}

// ---- runs attention

function RunsAttentionView({ action, ctx, compact }: WshRendererProps) {
    const json = callJson<AttentionItem[]>(action);
    const state = useWshData<AttentionItem[]>(json ? null : "runs-attention", async () => {
        const rtn = await RpcApi.GetAttentionCommand(TabRpcClient);
        return rtn.items ?? [];
    });
    const items = json ?? state.data;
    if (items == null) {
        return <LoadNote state={state} what="what is waiting" action={action} compact={compact} />;
    }
    const m = attentionModel(items, Date.now());
    const text = compact ? "text-[12px]" : "text-[12.5px]";
    return (
        <div className="overflow-hidden rounded-[8px] border border-edge-mid bg-surface">
            {m.empty ? (
                <div className={cn("flex items-center gap-2 px-3 py-2.5 text-secondary", text)}>
                    <span>{NOTHING_WAITING}</span>
                    <span className="flex-1" />
                    {json ? null : <AsOfNow />}
                </div>
            ) : (
                m.rows.map((r, i) => (
                    <div
                        key={r.key}
                        className={cn(
                            "flex items-baseline gap-2.5 px-3 py-2",
                            i > 0 && "border-t border-edge-faint",
                            text
                        )}
                    >
                        <span className="shrink-0 rounded-[4px] bg-warning/15 px-1.5 font-mono text-[11px] text-warning">
                            {r.action}
                        </span>
                        <span className="shrink-0 text-muted">{r.source}</span>
                        <span className="min-w-0 flex-1 truncate text-secondary">{r.text}</span>
                        {r.waited ? (
                            <span className="shrink-0 font-mono text-[11px] text-ink-faint">{r.waited}</span>
                        ) : null}
                        <OpenRun runId={r.runId} ctx={ctx} label="Open run" compact={compact} />
                    </div>
                ))
            )}
        </div>
    );
}

// ---- runs start

// the run a start call created, among its channel's runs, when the call carried no --json
async function fetchStartedRun(
    channelId: string,
    call: { goal?: string; ts?: number; durationMs?: number }
): Promise<Run | null> {
    const rtn = await RpcApi.GetChannelRunsCommand(TabRpcClient, { channelid: channelId });
    return matchStartedRun(rtn.runs ?? [], call) ?? null;
}

async function fetchEffort(effortOid: string): Promise<Effort> {
    const rtn = await RpcApi.EffortGetCommand(TabRpcClient, { effortoid: effortOid });
    return rtn.effort;
}

function CardShell({ children, compact }: { children: ReactNode; compact: boolean }) {
    return (
        <div
            className={cn(
                "overflow-hidden border border-edge-mid font-sans",
                compact ? "rounded-[8px]" : "rounded-[10px]"
            )}
        >
            {children}
        </div>
    );
}

function RunStartedCard({ call, action, ctx, compact }: WshRendererProps) {
    const json = callJson<Run>(action);
    const channelId = (typeof call.flags.channel === "string" ? call.flags.channel : "") || ctx.channelId || "";
    const matchKey = json?.id || action.ts == null || !channelId ? null : `runs-start:${channelId}:${action.ts}`;
    const found = useWshData<Run | null>(matchKey, () =>
        fetchStartedRun(channelId, { goal: call.args[0], ts: action.ts, durationMs: action.durationMs })
    );
    const run = json?.id ? json : (found.data ?? undefined);
    const effortId =
        (typeof call.flags.effort === "string" ? call.flags.effort : "") || run?.effortref?.effortoid || "";
    const effort = useWshData<Effort>(effortId ? `effort:${effortId}` : null, () => fetchEffort(effortId));
    const m = runStartedModel({ call, run, effortTitle: effort.data?.title });
    const loadError = found.error ?? effort.error;
    return (
        <CardShell compact={compact}>
            <div className={cn("flex items-center", compact ? "gap-2 px-2.5 py-2" : "gap-2.5 px-3.5 py-3")}>
                <RunGlyph size={compact ? 13 : 15} />
                <span className={cn("shrink-0 text-ink-mid", compact ? "text-[12.5px]" : "text-[13.5px]")}>
                    Run started
                </span>
                <span
                    className={cn(
                        "min-w-0 truncate font-semibold text-foreground",
                        compact ? "text-[12.5px]" : "text-[13.5px]"
                    )}
                >
                    {m.title}
                </span>
                <span className="flex-1" />
                {m.status ? <StatusPill text={m.status.text} tone={m.status.tone} compact={compact} /> : null}
                {compact ? null : <OpenRun runId={m.runId} ctx={ctx} label="Open run" compact={compact} />}
                {compact ? null : <CallFacts action={action} compact={compact} />}
            </div>
            <div
                className={cn(
                    "flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-edge-faint text-muted",
                    compact ? "px-2.5 py-[7px] text-[11.5px]" : "px-3.5 py-[9px] text-[12.5px]"
                )}
            >
                <span>{[m.mode, m.runtimeModel].filter(Boolean).join(" · ")}</span>
                {m.runId ? (
                    <span>
                        run <span className="font-mono text-[11.5px] text-ink-mid">{shortId(m.runId)}</span>
                    </span>
                ) : null}
                {m.chunks.length > 0 ? (
                    <span>
                        {`for ${m.chunks.length === 1 ? "chunk" : "chunks"} ${m.chunks.join(", ")}`}
                        {m.initiative ? (
                            <>
                                {" of "}
                                <span className="text-secondary">{m.initiative}</span>
                            </>
                        ) : null}
                    </span>
                ) : null}
                {compact ? (
                    <span className="ml-auto flex items-center gap-2">
                        <OpenRun runId={m.runId} ctx={ctx} label="Open" compact={compact} />
                        <CallFacts action={action} compact={compact} />
                    </span>
                ) : null}
            </div>
            {loadError ? (
                <LoadFailure
                    message={`Could not load the run's details: ${loadError}`}
                    action={action}
                    compact={compact}
                    className="border-t border-edge-faint px-3.5 py-2"
                />
            ) : null}
        </CardShell>
    );
}

// ---- runs answer

// the run's own pending question, which names the options an answer picked; it is gone once answered, so this reads
// only what is still known
async function fetchRunAsks(runId: string): Promise<DagAskItem[]> {
    const run = await WOS.loadAndPinWaveObject<Run>(WOS.makeORef("run", runId));
    if (run?.channeloid == null) {
        throw new Error(`no run ${runId}`);
    }
    const rtn = await RpcApi.RunAsksCommand(TabRpcClient, { channelid: run.channeloid, runid: run.id });
    return rtn.asks ?? [];
}

function RunAnsweredCard({ call, action, ctx, compact }: WshRendererProps) {
    const runId = call.args[0] ?? "";
    const asks = useWshData<DagAskItem[]>(runId ? `run-asks:${runId}` : null, () => fetchRunAsks(runId));
    const m = runAnsweredModel({ call, asks: asks.data, ts: action.ts });
    const single = m.items.length === 1 ? m.items[0].question : undefined;
    return (
        <CardShell compact={compact}>
            <div className={cn("flex items-center", compact ? "gap-2 px-2.5 py-2" : "gap-2.5 px-3.5 py-3")}>
                <MessageSquare size={compact ? 13 : 14} strokeWidth={2} className="shrink-0 text-ink-mid" aria-hidden />
                <span className={cn("shrink-0 text-ink-mid", compact ? "text-[12.5px]" : "text-[13.5px]")}>
                    Answered for you
                </span>
                {single ? (
                    <span
                        className={cn(
                            "min-w-0 truncate font-semibold text-foreground",
                            compact ? "text-[12.5px]" : "text-[13.5px]"
                        )}
                    >
                        {single}
                    </span>
                ) : null}
                <span className={cn("shrink-0 text-muted", compact ? "text-[11.5px]" : "text-[12.5px]")}>
                    run {shortId(m.runId)}
                </span>
                <span className="flex-1" />
                <OpenRun runId={m.runId} ctx={ctx} label="Open run" compact={compact} />
                <CallFacts action={action} compact={compact} />
            </div>
            {m.items.map((item, i) => (
                <div
                    key={i}
                    className={cn(
                        "border-t border-edge-faint text-foreground",
                        compact
                            ? "px-2.5 py-[7px] pl-[34px] text-[12.5px]"
                            : "px-3.5 pb-[11px] pt-[9px] pl-[38px] text-[13.5px]"
                    )}
                >
                    {m.items.length > 1 && item.question ? (
                        <div className="mb-1 text-[12px] text-muted">{item.question}</div>
                    ) : null}
                    {item.picked.map((p) => (
                        <div key={p} className="flex items-center gap-2">
                            <Check size={12} strokeWidth={3} className="shrink-0 text-accent-soft" aria-hidden />
                            {p}
                        </div>
                    ))}
                </div>
            ))}
            {asks.error ? (
                <LoadFailure
                    message={`Could not read the question: ${asks.error}`}
                    action={action}
                    compact={compact}
                    className="border-t border-edge-faint px-3.5 py-2"
                />
            ) : null}
        </CardShell>
    );
}

export const RUNS_RENDERERS: WshRenderers = {
    "runs-show": RunsShowView,
    "runs-attention": RunsAttentionView,
    "runs-start": RunStartedCard,
    "runs-answer": RunAnsweredCard,
};

export const RUNS_STEP_SUMMARIES: WshStepSummaries = {
    "runs-attention": { summary: attentionStepSummary, tone: "secondary" },
};
