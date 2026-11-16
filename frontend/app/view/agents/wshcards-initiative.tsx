// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// wsh effort calls: initiative and chunk cards, and the effort show/list views. A card draws from the call's argv and
// is enriched from the effort record through wshdata; a record that will not load leaves the argv card and its error.

import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { stateRpcTimeoutMs } from "@/app/view/jarvis/briefingstore";
import { chunkTone, type ChunkTone } from "@/app/view/jarvis/effortmodel";
import { openTarget } from "@/app/view/jarvis/openref";
import { cn } from "@/util/util";
import { ArrowUpRight, Check, ChevronDown, Flag, Pencil, Plus } from "lucide-react";
import { useState, type ReactNode } from "react";
import type { AgentActionEntry } from "./agentsviewmodel";
import {
    bareEffortId,
    buildInitiativeCard,
    CREATED_CHUNKS_SHOWN,
    effortListModel,
    effortListRequest,
    effortShowModel,
    type ChunkFacts,
    type InitiativeCard,
    type Progress,
} from "./initiativecards";
import type { TranscriptContext } from "./transcriptcontext";
import { actionCommand } from "./transcriptlayout";
import { wshJsonOutput } from "./wshcall";
import { CallFacts } from "./wshchangerow";
import { useWshData } from "./wshdata";
import { AsOfNow, type WshRendererProps, type WshRenderers } from "./wshrenderers";

const fetchEffort = (effortId: string) =>
    RpcApi.EffortGetCommand(TabRpcClient, { effortoid: effortId }, { timeout: stateRpcTimeoutMs }).then(
        (r) => r.effort
    );

const fetchEfforts = (req: { includearchived: boolean; project?: string }) =>
    RpcApi.EffortListCommand(TabRpcClient, req, { timeout: stateRpcTimeoutMs }).then((r) => r.efforts ?? []);

// the call's own JSON output, when it ran with --json and succeeded
function jsonOf<T>(action: AgentActionEntry): T | null {
    const d = action.detail;
    return d?.kind === "bash" ? wshJsonOutput<T>(actionCommand(action), d.output, d.exit) : null;
}

function chunkSubject(chunk: ChunkFacts): string {
    if (chunk.number != null && chunk.label) return `${chunk.number}. ${chunk.label}`;
    return chunk.label ?? (chunk.number != null ? `#${chunk.number}` : "");
}

const mono = (compact: boolean) => (compact ? "text-[11px]" : "text-[12px]");

function ProgressBar({ fraction, width, className }: { fraction: number; width: string; className?: string }) {
    return (
        <span
            aria-hidden
            className={cn(
                "relative inline-block h-[3px] shrink-0 overflow-hidden rounded-[2px] bg-edge-mid",
                className
            )}
            style={{ width }}
        >
            <span
                className="absolute inset-y-0 left-0 bg-success"
                style={{ width: `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%` }}
            />
        </span>
    );
}

function ProgressLine({ progress, title, compact }: { progress: Progress; title?: string; compact: boolean }) {
    return (
        <div
            className={cn(
                "flex items-center text-muted",
                compact ? "ml-[22px] mt-1.5 gap-2 text-[11.5px]" : "ml-[26px] mt-2 gap-2.5 text-[12px]"
            )}
        >
            {title ? <span className="min-w-0 truncate">{title}</span> : null}
            <span className="shrink-0">
                {progress.done} of {progress.total} done
            </span>
            <ProgressBar
                fraction={progress.total > 0 ? progress.done / progress.total : 0}
                width={compact ? "60px" : "80px"}
            />
        </div>
    );
}

// the chunk's state as a dot: done is a check, active a dot in a ring, blocked the warning ring, the rest an empty ring
function ChunkDot({ tone, size }: { tone: ChunkTone; size: number }) {
    const px = { width: size, height: size };
    if (tone === "done") {
        return (
            <span
                role="img"
                aria-label="Done"
                className="inline-flex shrink-0 items-center justify-center rounded-full bg-success/15"
                style={px}
            >
                <Check size={size - 4} strokeWidth={3.2} className="text-success" aria-hidden />
            </span>
        );
    }
    const ring =
        tone === "active"
            ? "border-accent"
            : tone === "blocked"
              ? "border-warning"
              : tone === "pending"
                ? "border-edge-strong"
                : "border-muted";
    const dot = tone === "active" ? "bg-accent" : "bg-warning";
    return (
        <span
            role="img"
            aria-label={tone === "pending" ? "Pending" : tone[0].toUpperCase() + tone.slice(1)}
            className={cn("inline-flex shrink-0 items-center justify-center rounded-full border-[1.5px]", ring)}
            style={px}
        >
            {tone === "active" || tone === "blocked" ? (
                <span className={cn("rounded-full", dot)} style={{ width: size / 2 - 1, height: size / 2 - 1 }} />
            ) : null}
        </span>
    );
}

function OpenLink({ ctx, effortId, compact }: { ctx: TranscriptContext; effortId?: string; compact: boolean }) {
    if (!ctx.model || !effortId) {
        return null;
    }
    return (
        <button
            type="button"
            onClick={() => void openTarget(ctx.model!, { kind: "effort", effortId })}
            className={cn(
                "inline-flex shrink-0 cursor-pointer items-center gap-1 text-ink-mid hover:text-foreground",
                compact ? "text-[11.5px]" : "text-[12px]"
            )}
        >
            Open
            <ArrowUpRight size={11} strokeWidth={2.2} aria-hidden />
        </button>
    );
}

function LoadError({ error, compact }: { error?: string; compact: boolean }) {
    return error ? (
        <div className={cn("text-muted", compact ? "ml-[22px] mt-1.5 text-[11px]" : "ml-[26px] mt-2 text-[12px]")}>
            Couldn't load the initiative: {error}
        </div>
    ) : null;
}

function CardHeader({
    icon,
    label,
    subject,
    right,
    compact,
}: {
    icon: ReactNode;
    label: string;
    subject?: string;
    right: ReactNode;
    compact: boolean;
}) {
    return (
        <div className={cn("flex items-center font-sans", compact ? "gap-2" : "gap-2.5")}>
            {icon}
            <span className={cn("shrink-0 text-ink-mid", compact ? "text-[12.5px]" : "text-[13.5px]")}>{label}</span>
            {subject ? (
                <span
                    className={cn(
                        "min-w-0 truncate font-semibold text-foreground",
                        compact ? "text-[12.5px]" : "text-[13.5px]"
                    )}
                >
                    {subject}
                </span>
            ) : null}
            <span className="flex-1" />
            {right}
        </div>
    );
}

function Shell({ children, tone, compact }: { children: ReactNode; tone?: "warning"; compact: boolean }) {
    return (
        <div
            className={cn(
                "border font-sans",
                tone === "warning" ? "border-warning/35 bg-warning/[0.04]" : "border-edge-mid",
                compact ? "rounded-[8px] px-2.5 py-2" : "rounded-[10px] px-3.5 py-3"
            )}
        >
            {children}
        </div>
    );
}

function ChunkDone({ card, ctx, action, compact }: CardProps<"chunk-done">) {
    const size = compact ? 14 : 16;
    return (
        <Shell compact={compact}>
            <CardHeader
                compact={compact}
                icon={<ChunkDot tone="done" size={size} />}
                label="Chunk done"
                subject={chunkSubject(card.chunk) || card.title || card.effortId}
                right={
                    <>
                        <OpenLink ctx={ctx} effortId={card.effortId} compact={compact} />
                        <CallFacts action={action} compact={compact} />
                    </>
                }
            />
            {card.note ? (
                <div
                    className={cn(
                        "text-secondary",
                        compact
                            ? "ml-[22px] mt-1.5 text-[12px] leading-[1.5]"
                            : "ml-[26px] mt-2 text-[13px] leading-[1.55]"
                    )}
                >
                    {card.note}
                </div>
            ) : null}
            {card.progress ? <ProgressLine progress={card.progress} title={card.title} compact={compact} /> : null}
            <LoadError error={card.error} compact={compact} />
        </Shell>
    );
}

// the ring-and-dot mark of a blocked chunk, drawn the same at card and row size
function BlockedMark({ size }: { size: number }) {
    return <ChunkDot tone="blocked" size={size} />;
}

function ChunkBlocked({ card, ctx, action, compact }: CardProps<"chunk-blocked">) {
    return (
        <Shell tone="warning" compact={compact}>
            <CardHeader
                compact={compact}
                icon={<BlockedMark size={compact ? 12 : 14} />}
                label="Chunk blocked"
                subject={chunkSubject(card.chunk) || card.effortId}
                right={
                    <>
                        <OpenLink ctx={ctx} effortId={card.effortId} compact={compact} />
                        <CallFacts action={action} compact={compact} />
                    </>
                }
            />
            {card.needs ? (
                <div
                    className={cn(
                        "text-secondary",
                        compact ? "ml-5 mt-1.5 text-[12px]" : "ml-6 mt-2 text-[13px] leading-[1.55]"
                    )}
                >
                    <span className="text-warning">needs:</span> {card.needs}
                </div>
            ) : null}
            {compact ? null : (
                <div className="ml-6 mt-1.5 text-[12px] text-muted">
                    Shows in the briefing's attention banner until it moves
                </div>
            )}
            <LoadError error={card.error} compact={compact} />
        </Shell>
    );
}

// the lighter cards are one line: an icon, what happened, what it happened to, and the call's facts
function EventRow({
    icon,
    label,
    subject,
    trailing,
    action,
    compact,
    below,
}: {
    icon: ReactNode;
    label: string;
    subject?: string;
    trailing?: string;
    action: AgentActionEntry;
    compact: boolean;
    below?: ReactNode;
}) {
    return (
        <div className={cn("px-0.5 font-sans text-ink-mid", compact ? "text-[12.5px]" : "text-[13.5px]")}>
            <div className={cn("flex items-center", compact ? "gap-[7px]" : "gap-2.5")}>
                {icon}
                <span className="shrink-0">{label}</span>
                {subject ? <span className="min-w-0 truncate text-foreground">{subject}</span> : null}
                <span className="flex-1" />
                {trailing ? (
                    <span className={cn("min-w-0 shrink truncate text-muted", compact ? "text-[11px]" : "text-[12px]")}>
                        {trailing}
                    </span>
                ) : null}
                <CallFacts action={action} compact={compact} />
            </div>
            {below}
        </div>
    );
}

function iconSize(compact: boolean): number {
    return compact ? 12 : 14;
}

type CardProps<K extends InitiativeCard["kind"]> = {
    card: Extract<InitiativeCard, { kind: K }>;
    ctx: TranscriptContext;
    action: AgentActionEntry;
    compact: boolean;
};

function ChunkCard({ call, wshKey, action, ctx, compact }: WshRendererProps) {
    const effortId = bareEffortId(call.args[0] ?? "");
    const state = useWshData(effortId ? `effort:${effortId}` : null, () => fetchEffort(effortId));
    const card = buildInitiativeCard(wshKey, call, {
        effort: state.data,
        error: state.error,
        ts: action.ts ?? action.startedTs,
    });
    const size = iconSize(compact);
    switch (card.kind) {
        case "chunk-done":
            return <ChunkDone card={card} ctx={ctx} action={action} compact={compact} />;
        case "chunk-blocked":
            return <ChunkBlocked card={card} ctx={ctx} action={action} compact={compact} />;
        case "chunk-status":
            return (
                <EventRow
                    icon={<ChunkDot tone={chunkTone(card.status)} size={size} />}
                    label={`Chunk ${card.chunk.number ?? card.chunk.label ?? ""} ${card.status}`}
                    subject={card.chunk.number != null ? card.chunk.label : undefined}
                    action={action}
                    compact={compact}
                    below={<LoadError error={card.error} compact={compact} />}
                />
            );
        case "chunk-added":
            return (
                <EventRow
                    icon={<Plus size={size} strokeWidth={2} className="shrink-0 text-ink-mid" aria-hidden />}
                    label="Added chunk"
                    subject={chunkSubject(card.chunk)}
                    trailing={card.initiative}
                    action={action}
                    compact={compact}
                    below={<LoadError error={card.error} compact={compact} />}
                />
            );
        case "chunk-noted":
            return (
                <EventRow
                    icon={<Pencil size={size} strokeWidth={2} className="shrink-0 text-ink-mid" aria-hidden />}
                    label={`Noted on chunk ${card.chunk.number ?? card.chunk.label ?? ""}`}
                    subject={card.note}
                    action={action}
                    compact={compact}
                    below={<LoadError error={card.error} compact={compact} />}
                />
            );
    }
    return null;
}

function InitiativeCreated({ call, action, ctx, compact }: WshRendererProps) {
    const state = useWshData("efforts", () => fetchEfforts({ includearchived: false }));
    const card = buildInitiativeCard("effort-create", call, { efforts: state.data, error: state.error });
    if (card.kind !== "initiative-created") {
        return null;
    }
    const shown = card.chunks.slice(0, CREATED_CHUNKS_SHOWN);
    const pad = compact ? "px-2.5" : "px-3.5";
    return (
        <div
            className={cn(
                "overflow-hidden border border-edge-mid font-sans",
                compact ? "rounded-[8px]" : "rounded-[10px]"
            )}
        >
            <div className={cn(pad, compact ? "py-2" : "py-3")}>
                <CardHeader
                    compact={compact}
                    icon={
                        <Flag
                            size={iconSize(compact) + 1}
                            strokeWidth={2}
                            className="shrink-0 text-ink-mid"
                            aria-hidden
                        />
                    }
                    label="Initiative created"
                    subject={card.title}
                    right={
                        <>
                            {card.ticket ? (
                                <span className="shrink-0 rounded-[4px] border border-edge-mid px-1.5 py-px font-mono text-[11.5px] text-ink-mid">
                                    {card.ticket}
                                </span>
                            ) : null}
                            <OpenLink ctx={ctx} effortId={card.effortId} compact={compact} />
                            <CallFacts action={action} compact={compact} />
                        </>
                    }
                />
                <LoadError error={card.error} compact={compact} />
            </div>
            {shown.length > 0 ? (
                <div className="flex flex-col border-t border-edge-faint py-1.5">
                    {shown.map((c) => (
                        <div
                            key={c.number}
                            className={cn(
                                "flex items-center gap-2.5 py-[5px] text-secondary",
                                pad,
                                compact ? "text-[12px]" : "text-[13px]"
                            )}
                        >
                            <span className={cn("w-[18px] text-right font-mono text-ink-faint", mono(compact))}>
                                {c.number}
                            </span>
                            <ChunkDot tone="pending" size={12} />
                            <span className="min-w-0 truncate">{c.label}</span>
                        </div>
                    ))}
                    {card.chunks.length > shown.length ? (
                        <div className={cn("py-1 text-muted", pad, compact ? "text-[11.5px]" : "text-[12px]")}>
                            {card.chunks.length - shown.length} more chunks
                        </div>
                    ) : null}
                </div>
            ) : null}
            {card.progress || card.project ? (
                <div
                    className={cn(
                        "flex flex-wrap gap-x-4 gap-y-1.5 border-t border-edge-faint py-2 text-muted",
                        pad,
                        compact ? "text-[11.5px]" : "text-[12.5px]"
                    )}
                >
                    {card.project ? <span>{card.project}</span> : null}
                    {card.progress ? (
                        <span>
                            {card.progress.done} of {card.progress.total} done
                        </span>
                    ) : null}
                </div>
            ) : null}
        </div>
    );
}

function ViewMessage({ children }: { children: ReactNode }) {
    return <div className="px-3 py-2.5 font-sans text-[12.5px] text-muted">{children}</div>;
}

function ViewFrame({ children }: { children: ReactNode }) {
    return <div className="overflow-hidden rounded-[8px] border border-edge-mid bg-surface font-sans">{children}</div>;
}

function MoreButton({ label, onClick, compact }: { label: string; onClick: () => void; compact: boolean }) {
    return (
        <button
            type="button"
            onClick={onClick}
            className={cn(
                "flex w-full cursor-pointer items-center gap-1 border-t border-edge-faint px-3 py-[7px] text-left text-muted hover:text-ink-mid",
                compact ? "text-[11.5px]" : "text-[12px]"
            )}
        >
            {label}
            <ChevronDown size={11} aria-hidden />
        </button>
    );
}

function EffortShowView({ call, action, ctx, compact }: WshRendererProps) {
    const effortId = bareEffortId(call.args[0] ?? "");
    const fromCall = jsonOf<CommandEffortGetRtnData>(action)?.effort;
    const state = useWshData(!fromCall && effortId ? `effort:${effortId}` : null, () => fetchEffort(effortId));
    const [all, setAll] = useState(false);
    const effort = fromCall ?? state.data;
    if (!effort) {
        return (
            <ViewMessage>
                {state.error ? `Couldn't load the initiative: ${state.error}` : "Loading the initiative…"}
            </ViewMessage>
        );
    }
    const m = effortShowModel(effort);
    const rows = all ? m.rows : m.rows.slice(0, m.shown);
    const rest = m.rows.length - m.shown;
    return (
        <ViewFrame>
            <div className="flex items-center gap-2.5 px-3 pb-2 pt-2.5">
                <Flag size={14} strokeWidth={2} className="shrink-0 text-ink-mid" aria-hidden />
                <span
                    className={cn(
                        "min-w-0 truncate font-semibold text-foreground",
                        compact ? "text-[12.5px]" : "text-[13.5px]"
                    )}
                >
                    {m.title}
                </span>
                <span className="shrink-0 text-[12px] text-muted">
                    {[m.project, m.status].filter(Boolean).join(" · ")}
                </span>
                <span className="flex-1" />
                {fromCall ? null : <AsOfNow />}
                <span className="shrink-0 text-[12px] text-ink-mid">
                    {m.done} of {m.total} done
                </span>
                <OpenLink ctx={ctx} effortId={bareEffortId(effort.oid ?? effortId)} compact={compact} />
            </div>
            <div className="mx-3 mb-2">
                <ProgressBar fraction={m.total > 0 ? m.done / m.total : 0} width="100%" />
            </div>
            <div className="flex flex-col pb-1.5 pt-0.5">
                {rows.map((r) => (
                    <div
                        key={r.number}
                        data-view-row
                        className={cn(
                            "flex items-center gap-2.5 px-3 py-[5px] text-secondary",
                            compact ? "text-[12px]" : "text-[13px]"
                        )}
                    >
                        <span className="w-[18px] text-right font-mono text-[11px] text-ink-faint">{r.number}</span>
                        <ChunkDot tone={r.tone} size={12} />
                        <span className="min-w-0 flex-1 truncate">{r.label}</span>
                        {r.notes > 0 ? (
                            <span className="shrink-0 text-[11.5px] text-ink-faint">
                                {r.notes} {r.notes === 1 ? "note" : "notes"}
                            </span>
                        ) : null}
                    </div>
                ))}
            </div>
            {rest > 0 && !all ? (
                <MoreButton label={`${rest} more chunks`} onClick={() => setAll(true)} compact={compact} />
            ) : null}
        </ViewFrame>
    );
}

function EffortListView({ call, action, compact }: WshRendererProps) {
    const req = effortListRequest(call);
    const fromCall = jsonOf<CommandEffortListRtnData>(action)?.efforts;
    const state = useWshData(fromCall ? null : req.key, () => fetchEfforts(req));
    const [all, setAll] = useState(false);
    const efforts = fromCall ?? state.data;
    if (!efforts) {
        return (
            <ViewMessage>
                {state.error ? `Couldn't load the initiatives: ${state.error}` : "Loading the initiatives…"}
            </ViewMessage>
        );
    }
    const m = effortListModel(efforts);
    const rows = all ? m.rows : m.rows.slice(0, m.shown);
    const rest = m.rows.length - m.shown;
    return (
        <ViewFrame>
            {fromCall ? null : (
                <div className="flex justify-end px-3 pt-2">
                    <AsOfNow />
                </div>
            )}
            <div className="flex flex-col py-1">
                {rows.map((r, i) => (
                    <div
                        key={r.id}
                        data-view-row
                        className={cn("flex flex-col gap-0.5 px-3 py-[7px]", i > 0 && "border-t border-edge-faint")}
                    >
                        <div className={cn("flex items-center gap-2.5", compact ? "text-[12px]" : "text-[13px]")}>
                            <span className="min-w-0 flex-1 truncate text-foreground">{r.title}</span>
                            {r.ticket ? (
                                <span className="shrink-0 rounded-[4px] border border-edge-mid px-[5px] font-mono text-[11px] text-ink-mid">
                                    {r.ticket}
                                </span>
                            ) : null}
                            <ProgressBar fraction={r.fraction} width={compact ? "50px" : "70px"} />
                            <span className="w-11 shrink-0 text-right font-mono text-[11.5px] text-secondary">
                                {r.done}/{r.total}
                            </span>
                        </div>
                        {r.current ? <div className="truncate text-[12px] text-ink-faint">{r.current}</div> : null}
                    </div>
                ))}
            </div>
            {rest > 0 && !all ? (
                <MoreButton label={`${rest} more initiatives`} onClick={() => setAll(true)} compact={compact} />
            ) : null}
        </ViewFrame>
    );
}

export const INITIATIVE_RENDERERS: WshRenderers = {
    "effort-show": EffortShowView,
    "effort-list": EffortListView,
    "effort-create": InitiativeCreated,
    "chunk-status": ChunkCard,
    "effort-advance": ChunkCard,
    "chunk-add": ChunkCard,
    "chunk-note": ChunkCard,
};
