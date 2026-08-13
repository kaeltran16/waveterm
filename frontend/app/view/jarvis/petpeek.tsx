// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The peek is a compact global hub anchored to the creature. It preserves the existing condition,
// recall, pass, and action derivations while giving status, updates, and Ask Jarvis independent bounds.

import { PopoverReveal } from "@/app/element/popoverreveal";
import { globalStore } from "@/app/store/jotaiStore";
import type { AgentsViewModel } from "@/app/view/agents/agents";
import { formatReset } from "@/app/view/agents/agentsviewmodel";
import { attentionAtom } from "@/app/view/agents/attentionstore";
import { tierFromMeta } from "@/app/view/agents/channelmessages";
import { activeChannelAtom, channelsAtom } from "@/app/view/agents/channelsstore";
import { providerLabel } from "@/app/view/agents/cockpitrailmodel";
import { memLoadedAtom, memNotesAtom, memPruneAtom } from "@/app/view/agents/memstore";
import { cn, fireAndForget } from "@/util/util";
import { FloatingFocusManager, autoUpdate, offset, shift, useFloating, type Placement } from "@floating-ui/react";
import { useAtomValue } from "jotai";
import { AlertTriangle, X } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { runAct } from "./petactrun";
import { actsForAttention, actsForEvent, actsForRecall, actsForVault, type PetAct } from "./petacts";
import {
    conditionLine,
    isWindowConstrained,
    postureFor,
    type PetExpression,
    type PetPosture,
    type PetSignals,
} from "./petcondition";
import { PetErrand } from "./peterrand";
import { passLine, recallLine } from "./petjoin";
import {
    petActStateAtom,
    petIndexAtom,
    petLastPassAtom,
    petPeekOpenAtom,
    petSaidAtom,
    type PetCorner,
} from "./petstore";
import type { PetEvent } from "./petvoice";
import { ageLabel } from "./recallderive";

const PLACEMENT: Record<PetCorner, Placement> = {
    "bottom-right": "top-end",
    "bottom-left": "top-start",
};

const ORIGIN: Record<PetCorner, string> = {
    "bottom-right": "bottom right",
    "bottom-left": "bottom left",
};

type StatusTone = "ok" | "warning" | "error" | "unknown";
type ActTone = "primary" | "quiet";

const STATUS_DOT: Record<StatusTone, string> = {
    ok: "bg-success",
    warning: "bg-warning",
    error: "bg-error",
    unknown: "bg-ink-faint",
};

const POSTURE_LABEL: Record<PetPosture, string> = {
    "review-gate": "Review gate",
    escalation: "Escalation",
    "blocked-worker": "Blocked worker",
    none: "Nothing",
};

const HEALTH_STYLE = {
    error: "border-error/30 bg-error/10 text-error-soft",
    warning: "border-warning/30 bg-warning/10 text-warning-soft",
    success: "border-success/30 bg-success/10 text-success-soft",
} as const;

function healthFor(
    expression: PetExpression,
    posture: PetPosture
): { label: string; style: keyof typeof HEALTH_STYLE } {
    if (expression.kind === "cannot-see") {
        return { label: "Needs attention", style: "error" };
    }
    if (expression.kind === "tired") {
        return { label: "Window constrained", style: "warning" };
    }
    if (expression.kind === "drifting") {
        return { label: "Vault needs review", style: "warning" };
    }
    if (posture !== "none") {
        return { label: "Needs you", style: "warning" };
    }
    return { label: "All quiet", style: "success" };
}

function actLeavesPeek(act: PetAct): boolean {
    return act.verb !== "do" || act.op.kind === "clear-superseded";
}

function Acts({
    model,
    acts,
    tone = "quiet",
    className,
    onLeave,
}: {
    model: AgentsViewModel;
    acts: PetAct[];
    tone?: ActTone;
    className?: string;
    onLeave: () => void;
}) {
    const state = useAtomValue(petActStateAtom);
    if (acts.length === 0) {
        return null;
    }
    return (
        <div className={cn("flex flex-wrap items-center gap-1.5", className)}>
            {acts.map((act, index) => {
                const current = state[act.id];
                const primary = tone === "primary" && index === 0;
                return (
                    <span key={act.id} className="flex max-w-full min-w-0 items-center gap-1.5">
                        <button
                            type="button"
                            data-pet-act={act.id}
                            disabled={current?.status === "running"}
                            onClick={() => {
                                if (actLeavesPeek(act)) {
                                    onLeave();
                                }
                                fireAndForget(() => runAct(model, act));
                            }}
                            className={cn(
                                "min-h-8 max-w-full whitespace-normal rounded-[7px] px-2.5 text-left text-[11px] font-semibold",
                                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                                "disabled:cursor-default disabled:bg-surface-hover disabled:text-muted",
                                primary
                                    ? "bg-accent text-background hover:bg-accenthover"
                                    : "border border-edge-mid bg-surface-raised text-accent-soft hover:bg-surface-hover"
                            )}
                        >
                            {act.label}
                        </button>
                        {current?.text != null ? (
                            <span
                                className={cn(
                                    "text-[10.5px] leading-[1.35]",
                                    current.status === "error" ? "text-error" : "text-muted"
                                )}
                            >
                                {current.text}
                            </span>
                        ) : null}
                    </span>
                );
            })}
        </div>
    );
}

function PanelSection({
    name,
    labelId,
    title,
    meta,
    children,
}: {
    name: "status" | "updates" | "ask";
    labelId: string;
    title: string;
    meta?: string;
    children: ReactNode;
}) {
    return (
        <section
            data-pet-section={name}
            aria-labelledby={labelId}
            className={cn(
                "rounded-[10px] border border-border bg-surface",
                name === "ask" ? "overflow-visible" : "overflow-hidden"
            )}
        >
            <div className="flex min-h-[40px] items-center gap-2 border-b border-border px-3">
                <h3
                    id={labelId}
                    className="flex-none font-mono text-[10px] font-semibold uppercase tracking-[0.09em] text-muted"
                >
                    {title}
                </h3>
                {meta != null ? (
                    <span className="ml-auto min-w-0 text-right text-[10px] leading-[1.35] text-muted">{meta}</span>
                ) : null}
            </div>
            {children}
        </section>
    );
}

function StatusMetric({
    label,
    value,
    detail,
    tone,
    className,
    children,
}: {
    label: string;
    value: string;
    detail?: string;
    tone: StatusTone;
    className?: string;
    children?: ReactNode;
}) {
    return (
        <div className={cn("min-w-0 p-2.5", className)}>
            <span className="flex items-center gap-1.5 font-mono text-[9px] font-semibold uppercase tracking-[0.08em] text-muted">
                <span className={cn("h-[5px] w-[5px] flex-none rounded-full", STATUS_DOT[tone])} />
                {label}
            </span>
            <strong className="mt-1.5 block text-[11.5px] font-semibold leading-[1.35] text-secondary">{value}</strong>
            {detail != null ? (
                <span className="mt-0.5 block text-[10px] leading-[1.35] text-muted">{detail}</span>
            ) : null}
            {children}
        </div>
    );
}

function WaitingItems({
    model,
    items,
    channels,
    now,
    onLeave,
}: {
    model: AgentsViewModel;
    items: AttentionItem[];
    channels: Channel[] | null;
    now: number;
    onLeave: () => void;
}) {
    if (items.length === 0) {
        return null;
    }
    return (
        <div className="max-h-[144px] overflow-y-auto border-t border-border">
            {items.map((item) => {
                const channel = (channels ?? []).find((candidate) => candidate.oid === item.channelid);
                const tier = tierFromMeta(channel?.meta);
                return (
                    <div
                        key={item.key}
                        className="flex flex-col gap-1.5 border-b border-border px-3 py-2.5 last:border-b-0"
                    >
                        <div className="flex min-w-0 items-start gap-2">
                            <span className="min-w-0 flex-1 text-[11.5px] font-medium leading-[1.35] text-secondary">
                                {item.source || item.text}
                            </span>
                            <Acts model={model} acts={actsForAttention(item, tier)} onLeave={onLeave} />
                        </div>
                        <span className="font-mono text-[9.5px] text-muted">
                            {item.action} · {ageLabel(Math.max(0, now - item.waitingsince))}
                        </span>
                    </div>
                );
            })}
        </div>
    );
}

function UpdateItem({
    model,
    event,
    now,
    noteExists,
    onLeave,
}: {
    model: AgentsViewModel;
    event: PetEvent;
    now: number;
    noteExists: (id: string) => boolean | undefined;
    onLeave: () => void;
}) {
    return (
        <div className="grid grid-cols-[2px_minmax(0,1fr)] gap-2.5 border-b border-border px-3 py-2.5 last:border-b-0">
            <span className="rounded-full bg-edge-strong" />
            <div className="min-w-0">
                <span className="text-[11.5px] leading-[1.45] text-secondary">{event.text}</span>
                <span className="mt-1 block font-mono text-[9.5px] text-muted">
                    {event.kind} · {ageLabel(Math.max(0, now - event.at))}
                </span>
                <Acts model={model} acts={actsForEvent(event, noteExists)} className="mt-1.5" onLeave={onLeave} />
            </div>
        </div>
    );
}

export function PetPeek({
    model,
    anchor,
    corner,
    signals,
    expression,
}: {
    model: AgentsViewModel;
    anchor: HTMLElement | null;
    corner: PetCorner;
    signals: PetSignals;
    expression: PetExpression;
}) {
    const open = useAtomValue(petPeekOpenAtom);
    const said = useAtomValue(petSaidAtom);
    const pruneCandidates = useAtomValue(memPruneAtom);
    const memNotes = useAtomValue(memNotesAtom);
    const memLoaded = useAtomValue(memLoadedAtom);
    const lastPass = useAtomValue(petLastPassAtom);
    const items = useAtomValue(attentionAtom);
    const channels = useAtomValue(channelsAtom);
    const activeChannel = useAtomValue(activeChannelAtom);
    const indexStatus = useAtomValue(petIndexAtom);
    const recall = recallLine(indexStatus);
    const now = useAtomValue(model.nowAtom);
    const posture = postureFor(signals);
    const health = healthFor(expression, posture);
    const titleId = useId();
    const panelRef = useRef<HTMLDivElement | null>(null);
    const returnFocusRef = useRef<HTMLElement | null>(anchor);
    const [returnFocusEnabled, setReturnFocusEnabled] = useState(true);

    const close = useCallback(() => {
        returnFocusRef.current = anchor;
        setReturnFocusEnabled(true);
        globalStore.set(petPeekOpenAtom, false);
    }, [anchor]);
    const leavePeek = () => {
        setReturnFocusEnabled(false);
    };

    const { refs, floatingStyles, context } = useFloating({
        open,
        placement: PLACEMENT[corner],
        strategy: "fixed",
        middleware: [offset(12), shift({ padding: 8, crossAxis: true })],
        whileElementsMounted: autoUpdate,
    });

    useEffect(() => {
        refs.setPositionReference(anchor);
    }, [anchor, refs]);

    useEffect(() => {
        if (open) {
            returnFocusRef.current = anchor;
            setReturnFocusEnabled(true);
        }
    }, [anchor, open]);

    useEffect(() => {
        if (!open) {
            return;
        }
        const onKey = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                close();
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [close, open]);

    const noteExists = (id: string): boolean | undefined =>
        memLoaded ? memNotes.some((note) => note.id === id) : undefined;
    const rateLimit = signals.rateLimit;
    const windowConstrained = isWindowConstrained(rateLimit);
    const decay = signals.decay;
    const recallActs = actsForRecall(indexStatus);
    const vaultActs = actsForVault(pruneCandidates);
    const priorityActs =
        expression.kind === "cannot-see" ? recallActs : expression.kind === "drifting" ? vaultActs : [];
    const priorityDetail =
        expression.kind === "cannot-see"
            ? recall.text
            : expression.kind === "drifting"
              ? decay != null && decay.staleNotes > 0
                  ? `${decay.staleNotes} marked stale`
                  : "Review the cleanup queue."
              : null;

    const recallValue =
        indexStatus == null
            ? "Not read yet"
            : indexStatus.state === "ok"
              ? "Ready"
              : indexStatus.state === "stale"
                ? "Stale"
                : "Unavailable";
    const recallTone: StatusTone = indexStatus == null ? "unknown" : indexStatus.state === "ok" ? "ok" : "error";

    const windowValue =
        rateLimit == null
            ? "No reading"
            : windowConstrained
              ? "Constrained"
              : `${providerLabel(rateLimit.provider)} · ${Math.round(rateLimit.pct)}% used`;
    const windowDetail = windowConstrained
        ? undefined
        : rateLimit == null
          ? "Usage unavailable"
          : rateLimit.resetAt != null
            ? `resets in ${formatReset(rateLimit.resetAt, now)}`
            : "current five-hour window";

    const vaultValue =
        decay == null
            ? "No reading"
            : decay.queueDepth === 0
              ? "Clear"
              : expression.kind === "drifting"
                ? "Needs review"
                : `${decay.queueDepth} to review`;
    const vaultDetail =
        expression.kind === "drifting"
            ? undefined
            : decay == null
              ? "Cleanup status unavailable"
              : decay.queueDepth === 0
                ? "No cleanup needed"
                : `${decay.staleNotes} stale`;
    const vaultTone: StatusTone = decay == null ? "unknown" : decay.queueDepth === 0 ? "ok" : "warning";

    const oldestWaiting = items.length === 0 ? null : Math.min(...items.map((item) => item.waitingsince));
    const waitingValue = POSTURE_LABEL[posture];
    const waitingDetail =
        oldestWaiting == null ? "No action needed" : `oldest · ${ageLabel(Math.max(0, now - oldestWaiting))}`;

    const openJarvis = () => {
        leavePeek();
        globalStore.set(model.surfaceAtom, "jarvis");
        globalStore.set(petPeekOpenAtom, false);
    };

    return (
        <>
            {open ? <div data-pet-peek-backdrop className="fixed inset-0 z-[64]" onClick={close} /> : null}
            <div ref={refs.setFloating} style={floatingStyles} className="z-[65]">
                <FloatingFocusManager
                    context={context}
                    disabled={!open}
                    initialFocus={panelRef}
                    returnFocus={returnFocusEnabled ? returnFocusRef : false}
                    modal
                >
                    <PopoverReveal
                        open={open}
                        origin={ORIGIN[corner]}
                        className="flex max-h-[calc(100vh-16px)] w-[calc(100vw-16px)] max-w-[420px] flex-col overflow-hidden rounded-[12px] border border-border bg-surface-raised shadow-popover"
                    >
                        <div
                            ref={panelRef}
                            data-pet-peek="1"
                            role="dialog"
                            aria-modal="true"
                            aria-labelledby={titleId}
                            tabIndex={-1}
                            className="flex min-h-0 flex-1 flex-col focus:outline-none"
                        >
                            <div
                                data-pet-peek-header
                                className="flex min-h-[52px] flex-none items-center gap-2 border-b border-border px-3.5"
                            >
                                <h2 id={titleId} className="text-[14px] font-bold text-primary">
                                    Jarvis
                                </h2>
                                <span
                                    data-pet-health
                                    className={cn(
                                        "inline-flex min-w-0 max-w-[132px] items-center gap-1.5 rounded-full border px-2 py-1 text-[10px] font-semibold",
                                        HEALTH_STYLE[health.style]
                                    )}
                                >
                                    <span className="h-1.5 w-1.5 flex-none rounded-full bg-current" />
                                    <span className="truncate">{health.label}</span>
                                </span>
                                <div className="flex-1" />
                                <button
                                    type="button"
                                    aria-label="Open full Jarvis view"
                                    onClick={openJarvis}
                                    className="min-h-8 flex-none whitespace-nowrap rounded-[7px] px-2 text-[11px] text-muted hover:bg-surface-hover hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                                >
                                    <span className="min-[380px]:hidden">Open</span>
                                    <span className="hidden min-[380px]:inline">Open full view</span>
                                </button>
                                <button
                                    type="button"
                                    aria-label="Close Jarvis panel"
                                    onClick={close}
                                    className="flex h-8 w-8 items-center justify-center rounded-[7px] border border-border text-muted hover:bg-surface-hover hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                                >
                                    <X aria-hidden="true" size={15} strokeWidth={2} />
                                </button>
                            </div>

                            <div data-pet-peek-body className="min-h-0 flex-1 space-y-2.5 overflow-y-auto p-3">
                                <PanelSection name="status" labelId={`${titleId}-status`} title="System status">
                                    {expression.kind !== "at-rest" ? (
                                        <div
                                            className={cn(
                                                "m-2.5 rounded-[9px] border p-2.5",
                                                expression.kind === "cannot-see"
                                                    ? "border-error/30 bg-error/10"
                                                    : "border-warning/30 bg-warning/10"
                                            )}
                                        >
                                            <div className="flex items-start gap-2.5">
                                                <AlertTriangle
                                                    aria-hidden="true"
                                                    size={17}
                                                    className={cn(
                                                        "mt-0.5 flex-none",
                                                        expression.kind === "cannot-see" ? "text-error" : "text-warning"
                                                    )}
                                                />
                                                <div className="min-w-0 flex-1">
                                                    <p
                                                        className={cn(
                                                            "text-[12.5px] font-semibold leading-[1.4]",
                                                            expression.kind === "cannot-see"
                                                                ? "text-error"
                                                                : "text-warning"
                                                        )}
                                                    >
                                                        {conditionLine(expression, now)}
                                                    </p>
                                                    {priorityDetail != null ? (
                                                        <p className="mt-1 text-[10.5px] leading-[1.4] text-muted">
                                                            {priorityDetail}
                                                        </p>
                                                    ) : null}
                                                    <Acts
                                                        model={model}
                                                        acts={priorityActs}
                                                        tone="primary"
                                                        className="mt-2"
                                                        onLeave={leavePeek}
                                                    />
                                                </div>
                                            </div>
                                        </div>
                                    ) : null}

                                    <div className="grid grid-cols-2">
                                        <StatusMetric
                                            label="Recall"
                                            value={recallValue}
                                            detail={expression.kind === "cannot-see" ? undefined : recall.text}
                                            tone={recallTone}
                                            className="border-r border-border"
                                        >
                                            {expression.kind !== "cannot-see" ? (
                                                <Acts
                                                    model={model}
                                                    acts={recallActs}
                                                    className="mt-2"
                                                    onLeave={leavePeek}
                                                />
                                            ) : null}
                                        </StatusMetric>
                                        <StatusMetric
                                            label="Window"
                                            value={windowValue}
                                            detail={windowDetail}
                                            tone={rateLimit == null ? "unknown" : windowConstrained ? "warning" : "ok"}
                                        />
                                        <StatusMetric
                                            label="Vault"
                                            value={vaultValue}
                                            detail={vaultDetail}
                                            tone={vaultTone}
                                            className="border-r border-t border-border"
                                        >
                                            {expression.kind !== "drifting" ? (
                                                <Acts
                                                    model={model}
                                                    acts={vaultActs}
                                                    className="mt-2"
                                                    onLeave={leavePeek}
                                                />
                                            ) : null}
                                        </StatusMetric>
                                        <StatusMetric
                                            label="Waiting"
                                            value={waitingValue}
                                            detail={waitingDetail}
                                            tone={items.length === 0 ? "ok" : "warning"}
                                            className="border-t border-border"
                                        />
                                    </div>

                                    <WaitingItems
                                        model={model}
                                        items={items}
                                        channels={channels}
                                        now={now}
                                        onLeave={leavePeek}
                                    />
                                </PanelSection>

                                <PanelSection
                                    name="updates"
                                    labelId={`${titleId}-updates`}
                                    title="Recent updates"
                                    meta={passLine(lastPass, now)}
                                >
                                    {said.length === 0 ? (
                                        <div className="grid grid-cols-[2px_minmax(0,1fr)] gap-2.5 px-3 py-3">
                                            <span className="rounded-full bg-edge-strong" />
                                            <div>
                                                <span className="block text-[11.5px] font-medium text-secondary">
                                                    No updates yet
                                                </span>
                                                <span className="mt-1 block text-[10px] leading-[1.4] text-muted">
                                                    Jarvis will keep spoken updates and their actions here.
                                                </span>
                                            </div>
                                        </div>
                                    ) : (
                                        <div className="max-h-[176px] overflow-y-auto">
                                            {said.map((event) => (
                                                <UpdateItem
                                                    key={event.id}
                                                    model={model}
                                                    event={event}
                                                    now={now}
                                                    noteExists={noteExists}
                                                    onLeave={leavePeek}
                                                />
                                            ))}
                                        </div>
                                    )}
                                </PanelSection>

                                <PanelSection
                                    name="ask"
                                    labelId={`${titleId}-ask`}
                                    title="Ask Jarvis"
                                    meta={activeChannel == null ? "No channel selected" : `#${activeChannel.name}`}
                                >
                                    <PetErrand channel={activeChannel} />
                                </PanelSection>
                            </div>
                        </div>
                    </PopoverReveal>
                </FloatingFocusManager>
            </div>
        </>
    );
}
