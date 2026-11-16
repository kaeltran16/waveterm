// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// wsh jarvis dag calls a lead makes on a run's tasks and asks: answer, tell, amend, retry, forward, escalate, merge,
// skip and sendback cards. The model (dagactioncards.ts) decides what each shows; this draws it.

import { modalsModel } from "@/app/store/modalmodel";
import { openTarget } from "@/app/view/jarvis/openref";
import { cn, fireAndForget } from "@/util/util";
import {
    ArrowUp,
    ArrowUpRight,
    Check,
    GitMerge,
    MessageSquare,
    PenLine,
    RotateCcw,
    SkipForward,
    Undo2,
    type LucideIcon,
} from "lucide-react";
import type { AgentActionEntry } from "./agentsviewmodel";
import {
    dagActionOf,
    dagRunIds,
    type DagActionIcon,
    type DagActionRow,
    type DagAnswerCard,
    type DagForwardCard,
} from "./dagactioncards";
import { useRunEventsState } from "./runeventstore";
import { formatDuration } from "./tooldetail";
import type { WshCardKey } from "./wshcall";
import type { WshRendererProps, WshRenderers } from "./wshrenderers";

const RETRY_TEXT = "a fresh worker starts when a slot is free";
const CONTINUE_TEXT = "continue after the fix";

const ROW_VERBS: Record<DagActionIcon, string> = {
    tell: "Told",
    amend: "Amended",
    retry: "Retried",
    escalate: "Escalated",
    merge: "Asked Arc to merge",
    skip: "Skipped",
    sendback: "Sent back",
};

const ROW_ICON: Record<DagActionIcon, LucideIcon> = {
    tell: MessageSquare,
    amend: PenLine,
    retry: RotateCcw,
    escalate: ArrowUp,
    merge: GitMerge,
    skip: SkipForward,
    sendback: Undo2,
};

function rowText(row: DagActionRow): string | undefined {
    switch (row.icon) {
        case "tell":
            return row.text ? `"${row.text}"` : undefined;
        case "retry":
            return RETRY_TEXT;
        case "escalate": {
            const target = [row.runtime, row.model].filter(Boolean).join(" ");
            return target ? `re-queued on ${target}` : "re-queued on a chosen model";
        }
        case "merge":
            return row.continued ? CONTINUE_TEXT : undefined;
        default:
            return row.text;
    }
}

// the call's duration and a button to its raw command and output: every card keeps the call's facts
function CallFacts({ action, compact }: { action: AgentActionEntry; compact: boolean }) {
    return (
        <>
            {action.durationMs ? (
                <span className={cn("shrink-0 font-mono text-ink-faint", compact ? "text-[10.5px]" : "text-[11px]")}>
                    {formatDuration(action.durationMs)}
                </span>
            ) : null}
            <button
                type="button"
                aria-label="Show the command"
                onClick={() => modalsModel.pushModal("AgentToolDetailModal", { action })}
                className="flex shrink-0 cursor-pointer rounded-[5px] p-0.5 text-muted hover:bg-surface-hover hover:text-primary"
            >
                <ArrowUpRight size={13} strokeWidth={2.2} aria-hidden />
            </button>
        </>
    );
}

function TaskId({ id, compact }: { id: string; compact: boolean }) {
    return id ? (
        <span className={cn("shrink-0 font-mono text-foreground", compact ? "text-[11px]" : "text-[12px]")}>{id}</span>
    ) : null;
}

function ActionRow({ row, action, compact }: { row: DagActionRow; action: AgentActionEntry; compact: boolean }) {
    const Icon = ROW_ICON[row.icon];
    const text = rowText(row);
    return (
        <div
            data-dag-action={row.icon}
            className={cn(
                "flex items-center font-sans text-ink-mid",
                compact ? "gap-[7px] py-0.5 text-[12.5px]" : "gap-2.5 px-0.5 py-1 text-[13.5px]"
            )}
        >
            <Icon size={compact ? 12 : 14} strokeWidth={2} className="shrink-0" aria-hidden />
            <span className="shrink-0">{ROW_VERBS[row.icon]}</span>
            <TaskId id={row.taskId} compact={compact} />
            {text ? <span className={cn("min-w-0 truncate", row.quoted && "text-secondary")}>{text}</span> : null}
            <span className="flex-1" />
            <CallFacts action={action} compact={compact} />
        </div>
    );
}

// the run's tab, so the human can answer there; no link without a model or a run to open
function ForwardCard({
    card,
    action,
    props,
}: {
    card: DagForwardCard;
    action: AgentActionEntry;
    props: WshRendererProps;
}) {
    const { compact, ctx } = props;
    const { runId } = dagRunIds(props.call, ctx);
    const model = ctx.model;
    return (
        <div
            data-dag-action="forward"
            className="overflow-hidden rounded-[10px] border border-warning/35 bg-transparent font-sans"
        >
            <div
                className={cn(
                    "flex items-center bg-warning/[0.06]",
                    compact ? "gap-2 px-3 py-2" : "gap-2.5 px-3.5 py-[11px]"
                )}
            >
                <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden className="shrink-0 text-warning">
                    <circle cx="7" cy="7" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
                    <circle cx="7" cy="7" r="2.6" fill="currentColor" />
                </svg>
                <span className={cn("shrink-0 text-ink-mid", compact ? "text-[12.5px]" : "text-[13.5px]")}>
                    Forwarded to you
                </span>
                <TaskId id={card.taskId} compact={compact} />
                <span
                    className={cn("shrink-0 font-semibold text-warning", compact ? "text-[12.5px]" : "text-[13.5px]")}
                >
                    waits on you
                </span>
                <span className="flex-1" />
                {model != null && runId ? (
                    <button
                        type="button"
                        onClick={() => fireAndForget(() => openTarget(model, { kind: "run", runId }))}
                        className="flex shrink-0 cursor-pointer items-center gap-1 text-[12px] text-ink-mid hover:text-foreground"
                    >
                        Answer in the run
                        <ArrowUpRight size={11} strokeWidth={2.2} aria-hidden />
                    </button>
                ) : null}
                <CallFacts action={action} compact={compact} />
            </div>
            {card.note ? (
                <div
                    className={cn(
                        "border-t border-edge-faint text-secondary",
                        compact
                            ? "px-3 py-2 text-[12.5px] leading-[1.5]"
                            : "px-3.5 pb-3 pt-2.5 text-[13px] leading-[1.55]"
                    )}
                >
                    {card.note}
                </div>
            ) : null}
        </div>
    );
}

function CheckBox({ picked }: { picked: boolean }) {
    return picked ? (
        <span
            role="img"
            aria-label="Picked"
            className="inline-flex h-[18px] w-[18px] flex-none items-center justify-center rounded-[5px] bg-accent/[0.12]"
        >
            <Check size={11} strokeWidth={3} className="text-accent-soft" aria-hidden />
        </span>
    ) : (
        <span className="w-[18px] flex-none" />
    );
}

function AnswerRow({
    picked,
    label,
    description,
    mono,
    compact,
}: {
    picked: boolean;
    label: string;
    description?: string;
    mono?: boolean;
    compact: boolean;
}) {
    return (
        <div
            data-answer-option={picked ? "picked" : "open"}
            className={cn(
                "flex items-start border-t border-edge-faint",
                picked && "bg-accent/[0.06]",
                compact ? "gap-2.5 px-3 py-2" : "gap-3 px-3.5 py-2.5"
            )}
        >
            <CheckBox picked={picked} />
            <span className="min-w-0">
                <span
                    className={cn(
                        "block whitespace-pre-wrap",
                        compact ? "text-[12.5px]" : "text-[13.5px]",
                        mono && "font-mono",
                        picked ? "font-semibold text-foreground" : "text-ink-mid"
                    )}
                >
                    {label}
                </span>
                {description ? (
                    <span
                        className={cn(
                            "mt-0.5 block",
                            compact ? "text-[12px]" : "text-[13px]",
                            picked ? "text-ink-mid" : "text-muted"
                        )}
                    >
                        {description}
                    </span>
                ) : null}
            </span>
        </div>
    );
}

function extraLabel(picked: number[]): string {
    const nums = picked.map((n) => n + 1).join(", ");
    return picked.length === 1 ? `Picked option ${nums}` : `Picked options ${nums}`;
}

// the worker's question as the lead answered it: the options with the picked one checked
function AnswerCardView({
    card,
    action,
    compact,
}: {
    card: DagAnswerCard;
    action: AgentActionEntry;
    compact: boolean;
}) {
    const context = [card.label, card.header].filter(Boolean);
    return (
        <div data-dag-action="answer" className="overflow-hidden rounded-[10px] border border-edge-mid font-sans">
            <div className={compact ? "px-3 py-2.5" : "px-3.5 py-3"}>
                <div
                    className={cn(
                        "mb-1.5 flex items-center gap-2 text-muted",
                        compact ? "text-[12px]" : "text-[12.5px]"
                    )}
                >
                    <span className={cn("font-mono text-ink-mid", compact ? "text-[11px]" : "text-[11.5px]")}>
                        {card.taskId}
                    </span>
                    {context.map((c, i) => (
                        <span key={i} className="flex gap-2">
                            <span>·</span>
                            <span>{c}</span>
                        </span>
                    ))}
                    <span className="flex-1" />
                    <CallFacts action={action} compact={compact} />
                </div>
                {card.question ? (
                    <div
                        className={cn(
                            "font-semibold leading-normal text-foreground",
                            compact ? "text-[13px]" : "text-[14px]"
                        )}
                    >
                        {card.question}
                    </div>
                ) : null}
            </div>
            {card.options.map((o, i) => (
                <AnswerRow key={i} picked={o.picked} label={o.label} description={o.description} compact={compact} />
            ))}
            {card.extra.map((x, i) =>
                "text" in x ? (
                    <AnswerRow key={`x${i}`} picked label={x.text} compact={compact} />
                ) : (
                    <AnswerRow key={`x${i}`} picked label={extraLabel(x.picked)} compact={compact} />
                )
            )}
            <div
                className={cn(
                    "border-t border-edge-faint text-muted",
                    compact ? "px-3 py-1.5 text-[12px]" : "px-3.5 py-2 text-[12.5px]"
                )}
            >
                The lead answered · delivered to {card.taskId}
            </div>
        </div>
    );
}

function DagActionView({
    props,
    events,
    loadFailed,
}: {
    props: WshRendererProps;
    events: RunEvent[];
    loadFailed: boolean;
}) {
    const model = dagActionOf(props.wshKey as WshCardKey, props.call, props.action, events);
    const { action, compact } = props;
    const card =
        model.kind === "answer" ? (
            <AnswerCardView card={model} action={action} compact={compact} />
        ) : model.kind === "forward" ? (
            <ForwardCard card={model} action={action} props={props} />
        ) : (
            <ActionRow row={model} action={action} compact={compact} />
        );
    if (!loadFailed) {
        return card;
    }
    return (
        <div>
            {card}
            <div className={cn("mt-1 text-muted", compact ? "text-[11.5px]" : "text-[12px]")}>
                The run's events did not load, so this card shows only what the call passed.
            </div>
        </div>
    );
}

// the answer's question and the escalation's model come from the run's events: loaded once, and only for a call that
// reads them
function DagActionWithEvents({
    props,
    channelId,
    runId,
}: {
    props: WshRendererProps;
    channelId: string;
    runId: string;
}) {
    const { events, status } = useRunEventsState(runId, channelId);
    return <DagActionView props={props} events={events} loadFailed={status === "error"} />;
}

const NEEDS_EVENTS: ReadonlySet<WshCardKey> = new Set(["dag-answer", "dag-escalate"]);

function DagActionCard(props: WshRendererProps) {
    const { channelId, runId } = dagRunIds(props.call, props.ctx);
    if (NEEDS_EVENTS.has(props.wshKey as WshCardKey) && channelId && runId) {
        return <DagActionWithEvents props={props} channelId={channelId} runId={runId} />;
    }
    return <DagActionView props={props} events={[]} loadFailed={false} />;
}

export const DAG_ACTION_RENDERERS: WshRenderers = {
    "dag-answer": DagActionCard,
    "dag-tell": DagActionCard,
    "dag-amend": DagActionCard,
    "dag-retry": DagActionCard,
    "dag-forward": DagActionCard,
    "dag-escalate": DagActionCard,
    "dag-merge": DagActionCard,
    "dag-skip": DagActionCard,
    "dag-sendback": DagActionCard,
};
