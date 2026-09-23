// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// One row component per Brief region, each drawn to the design's own anatomy
// (docs/prototype/jarvis-brief-editing.dc.html). The regions stopped sharing one LineRow because the
// design gives them different anatomies: Waiting acts in place, Runs is two lines under a type badge,
// Behind you is two lines under a wording column.

import { cn } from "@/util/util";
import type { ReactNode } from "react";
import type { QueueAct } from "./briefingmodel";
import type { BriefLine, RunRowFace } from "./briefrows";
import { CURSOR_RING, cursorAttrs, MONO_FAINT, ROW_BORDER, SMALL_BTN, TONE_TEXT } from "./briefstyle";
import { ProgressBar } from "./progressbar";

const PULSE = "animate-[pulseDot_1.8s_ease-in-out_infinite] motion-reduce:animate-none";

export function WaitingRow({
    line,
    focused,
    act,
    onOpen,
    onAct,
}: {
    line: BriefLine;
    focused: boolean;
    act: QueueAct;
    onOpen?: () => void;
    onAct: () => void;
}) {
    return (
        <div
            data-jarvis-brief-row="queue"
            {...cursorAttrs(focused)}
            onClick={onOpen}
            className={cn(
                "flex items-center gap-[13px] py-1.5 hover:bg-surface-hover",
                ROW_BORDER,
                onOpen != null && "cursor-pointer",
                focused && CURSOR_RING
            )}
        >
            <span
                className={cn(
                    "w-[92px] flex-none truncate font-mono text-[10.5px] font-semibold tracking-[.02em]",
                    TONE_TEXT[line.kindTone]
                )}
            >
                {line.kind}
            </span>
            <span
                title={line.why ? `${line.title} — ${line.why}` : line.title}
                className="min-w-0 flex-1 truncate text-[13px] text-ink-hi"
            >
                {line.title}
                {line.why ? <span className="text-ink-mid"> — {line.why}</span> : null}
            </span>
            <span className="w-[200px] flex-none truncate text-right font-mono text-[11px] text-ink-mid">
                {line.meta}
            </span>
            <span
                className={cn(
                    "w-10 flex-none text-right font-mono text-[11px] font-semibold",
                    TONE_TEXT[line.kindTone]
                )}
            >
                {line.age}
            </span>
            <button
                type="button"
                data-jarvis-queue-act={act.kind}
                onClick={(e) => {
                    e.stopPropagation();
                    onAct();
                }}
                className={cn(
                    "w-[66px] flex-none cursor-pointer rounded-[6px] border py-[3px] font-mono text-[10.5px] font-semibold hover:border-edge-strong hover:text-ink-hi focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                    act.label === "Approve"
                        ? "border-success/35 bg-success/12 text-success"
                        : "border-edge-mid text-secondary"
                )}
            >
                {act.label}
            </button>
        </div>
    );
}

export function InitiativeRow({
    line,
    focused,
    fresh,
    expanded,
    titleSlot,
    onOpen,
    onContextMenu,
}: {
    line: BriefLine;
    focused: boolean;
    fresh: boolean;
    expanded: boolean;
    // the rename input replaces the title in place, keeping the progress, meta and state columns
    titleSlot?: ReactNode;
    onOpen: () => void;
    onContextMenu?: (e: React.MouseEvent) => void;
}) {
    const p = line.progress ?? { done: 0, total: 0, pct: 0 };
    return (
        <div
            role="button"
            tabIndex={-1}
            aria-expanded={expanded}
            aria-label={expanded ? `Collapse ${line.title}` : `Open ${line.title}`}
            data-jarvis-brief-row="initiative"
            {...cursorAttrs(focused)}
            onClick={onOpen}
            onContextMenu={onContextMenu}
            className={cn(
                "relative flex cursor-pointer items-center gap-[13px] border px-[11px] py-[7px]",
                expanded
                    ? "rounded-t-[10px] border-border bg-surface-selected"
                    : "rounded-[9px] border-transparent border-b-edge-faint hover:bg-surface-hover",
                focused && CURSOR_RING,
                fresh && "fresh-mark"
            )}
        >
            <span className="flex w-[92px] flex-none items-center gap-[7px]">
                <ProgressBar
                    pct={p.pct}
                    tone={line.stateTone === "asking" ? "asking" : "success"}
                    className="h-1 min-w-0 flex-1 rounded-[2px]"
                />
                <span className="flex-none font-mono text-[10.5px] text-ink-mid">
                    {p.done}/{p.total}
                </span>
            </span>
            {titleSlot ?? (
                <span
                    title={line.note ? `${line.title} — ${line.note}` : line.title}
                    className="min-w-0 flex-1 truncate text-[13px] text-ink-hi"
                >
                    {line.title}
                    {line.note ? <span className="text-ink-mid"> — {line.note}</span> : null}
                </span>
            )}
            <span className="w-[190px] flex-none truncate text-right font-mono text-[11px] text-ink-mid">
                {line.meta}
            </span>
            <span
                className={cn(
                    "w-[76px] flex-none truncate text-right font-mono text-[11px] font-semibold",
                    TONE_TEXT[line.stateTone]
                )}
            >
                {line.state}
            </span>
            <span aria-hidden className="w-2.5 flex-none text-center text-[10px] text-muted">
                {expanded ? "▾" : "▸"}
            </span>
        </div>
    );
}

const DOT = {
    live: cn("bg-success", PULSE),
    asking: cn("bg-asking", PULSE),
    done: "bg-success/45",
    idle: "bg-feed-glyph",
};
const TYPE_BADGE = {
    orchestrator: "border-accent-soft/35 text-accent-soft",
    agent: "border-edge-mid text-ink-mid",
    "quick run": "border-edge-mid text-secondary",
};

export function RunRowView({
    line,
    face,
    focused,
    selected,
    onOpenSheet,
    onOpenChunk,
    onAnswer,
    onOpenAgent,
    onStop,
}: {
    line: BriefLine;
    face: RunRowFace;
    focused: boolean;
    selected: boolean;
    onOpenSheet?: () => void;
    onOpenChunk: () => void;
    onAnswer: () => void;
    onOpenAgent: () => void;
    onStop: () => void;
}) {
    const stop = (fn: () => void) => (e: React.MouseEvent) => {
        e.stopPropagation();
        fn();
    };
    return (
        <div
            data-jarvis-brief-row="session"
            {...cursorAttrs(focused)}
            onClick={onOpenSheet}
            className={cn(
                "flex items-center gap-3 py-[7px] hover:bg-surface-hover",
                ROW_BORDER,
                onOpenSheet != null && "cursor-pointer",
                selected && "bg-surface-selected",
                focused && CURSOR_RING
            )}
        >
            <span className={cn("h-[7px] w-[7px] flex-none rounded-full", DOT[face.dot])} />
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <div className="flex min-w-0 items-center gap-2">
                    <span
                        className={cn(
                            "flex-none rounded-[5px] border px-[5px] font-mono text-[10px] leading-4",
                            TYPE_BADGE[face.type]
                        )}
                    >
                        {face.type}
                    </span>
                    <span
                        title={line.title}
                        className={cn("min-w-0 truncate text-[13px]", face.stopped ? "text-ink-mid" : "text-ink-hi")}
                    >
                        {line.title}
                    </span>
                </div>
                <div className={cn("flex min-w-0 items-center gap-2", MONO_FAINT)}>
                    <span className="flex-none whitespace-nowrap">
                        {face.meta} · {face.elapsed}
                    </span>
                    {face.chunkLabel !== "" ? (
                        <button
                            type="button"
                            title="Open this chunk"
                            onClick={stop(onOpenChunk)}
                            className="min-w-0 cursor-pointer truncate font-mono text-[10.5px] text-muted hover:text-accent-soft"
                        >
                            ↳ {face.chunkLabel}
                        </button>
                    ) : null}
                </div>
            </div>
            <span
                className={cn(
                    "w-[62px] flex-none text-right font-mono text-[11px] font-semibold",
                    TONE_TEXT[face.stateTone]
                )}
            >
                {face.state}
            </span>
            <div className="flex flex-none justify-end gap-1">
                {face.asking ? (
                    <button
                        type="button"
                        onClick={stop(onAnswer)}
                        className="cursor-pointer rounded-[6px] border border-asking/35 bg-asking/12 px-2 py-[3px] text-[10.5px] font-bold text-asking hover:bg-asking/20"
                    >
                        Answer
                    </button>
                ) : null}
                <button type="button" onClick={stop(onOpenAgent)} className={SMALL_BTN}>
                    Open
                </button>
                {face.canStop ? (
                    <button
                        type="button"
                        title="Stop this session"
                        onClick={stop(onStop)}
                        className={cn(SMALL_BTN, "text-ink-mid hover:border-error/50 hover:text-error")}
                    >
                        Stop
                    </button>
                ) : null}
            </div>
        </div>
    );
}

export function DeltaRowView({ line, focused, onOpen }: { line: BriefLine; focused: boolean; onOpen?: () => void }) {
    return (
        <div
            data-jarvis-brief-row="delta"
            {...cursorAttrs(focused)}
            onClick={onOpen}
            className={cn(
                "flex items-center gap-[13px] py-[7px]",
                ROW_BORDER,
                onOpen != null && "cursor-pointer hover:bg-surface-hover",
                focused && CURSOR_RING
            )}
        >
            <span
                className={cn(
                    "w-28 flex-none truncate font-mono text-[10.5px] font-semibold",
                    TONE_TEXT[line.kindTone]
                )}
            >
                {line.kind}
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span title={line.title} className="truncate text-[13px] text-ink-hi">
                    {line.title}
                </span>
                {line.detail ? <span className={cn("truncate", MONO_FAINT)}>{line.detail}</span> : null}
            </div>
            <span className="w-12 flex-none text-right font-mono text-[11px] text-ink-mid">{line.state}</span>
        </div>
    );
}

export function ShippedRowView({
    line,
    focused,
    selected,
    onOpen,
}: {
    line: BriefLine;
    focused: boolean;
    selected: boolean;
    onOpen?: () => void;
}) {
    return (
        <div
            data-jarvis-brief-row="shipped"
            {...cursorAttrs(focused)}
            onClick={onOpen}
            className={cn(
                "flex items-center gap-3 py-[7px] hover:bg-surface-hover",
                ROW_BORDER,
                onOpen != null ? "cursor-pointer" : "cursor-default",
                selected && "bg-surface-selected",
                focused && CURSOR_RING
            )}
        >
            <span className="h-[7px] w-[7px] flex-none rounded-full bg-success/45" />
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <div className="flex min-w-0 items-center gap-2">
                    <span title={line.title} className="min-w-0 truncate text-[13px] text-ink-hi">
                        {line.title}
                    </span>
                    {line.fresh ? (
                        <span className="flex-none rounded-[5px] border border-accent/40 px-[5px] font-mono text-[9.5px] leading-[15px] text-accent-soft">
                            new
                        </span>
                    ) : null}
                </div>
                {line.detail ? <span className={cn("truncate", MONO_FAINT)}>{line.detail}</span> : null}
            </div>
            {line.hasReport ? <span className="flex-none font-mono text-[10px] text-ink-mid">report</span> : null}
            <span className="w-12 flex-none text-right font-mono text-[11px] text-ink-mid">{line.state}</span>
        </div>
    );
}
