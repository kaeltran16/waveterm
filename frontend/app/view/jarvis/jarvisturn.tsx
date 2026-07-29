// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// One Jarvis turn, rendered the same way wherever it appears: the recall thread and, after the
// consolidation, inline in a run's thread while the run keeps running. Extracted from
// conversationview.tsx so there is exactly one answer renderer.

import type { AgentsViewModel } from "@/app/view/agents/agents";
import { cn } from "@/util/util";
import type { JarvisAnswerTurn } from "./jarviscontract";
import { isCitation } from "./jarviscontract";
import { terminalBadge, type TerminalBadge } from "./jarvisturnderive";
import { openORef } from "./openref";
import { groundingByN } from "./recallderive";

export function JarvisWorkingSteps({ turn }: { turn: JarvisAnswerTurn }) {
    if (turn.workingSteps.length === 0) return null;
    return (
        <ul className="mb-3 flex flex-col gap-1 rounded-[9px] border border-border bg-surface px-3 py-2">
            {turn.workingSteps.map((s) => (
                <li key={s.id} className="flex items-center gap-2 text-[12px]">
                    <span
                        className={cn(
                            "inline-block h-1.5 w-1.5 rounded-full",
                            s.status === "done" && "bg-success",
                            s.status === "active" && "bg-accent",
                            s.status === "pending" && "bg-ink-faint"
                        )}
                    />
                    <span className={cn(s.status === "pending" ? "text-muted" : "text-ink-mid")}>{s.label}</span>
                </li>
            ))}
        </ul>
    );
}

export function JarvisUserTurn({ text }: { text: string }) {
    return (
        <div className="flex justify-end">
            <div className="max-w-[560px] rounded-[12px] bg-surface-raised px-3.5 py-2 text-[14px] text-primary">{text}</div>
        </div>
    );
}

const BADGE_TONE: Record<TerminalBadge["tone"], string> = {
    warning: "border-warning/40 bg-warning/10 text-warning",
    error: "border-error/40 bg-error/10 text-error",
    muted: "border-border text-muted",
};

export function JarvisAnswer({
    turn,
    model,
    onRetry,
    onCancel,
}: {
    turn: JarvisAnswerTurn;
    model: AgentsViewModel;
    onRetry?: () => void;
    onCancel?: () => void;
}) {
    const byN = groundingByN(turn.grounding);
    const badge = terminalBadge(turn.terminal);
    return (
        <div className="max-w-[720px]">
            <JarvisWorkingSteps turn={turn} />
            {/* a streaming turn has no badge yet, so Cancel cannot live in the badge row below */}
            {turn.streaming && onCancel != null ? (
                <div className="mb-2">
                    <button
                        type="button"
                        onClick={onCancel}
                        className="cursor-pointer rounded-[7px] border border-edge-mid px-2.5 py-1 font-mono text-[11px] text-muted hover:border-edge-strong hover:text-secondary"
                    >
                        Cancel
                    </button>
                </div>
            ) : null}
            {badge != null ? (
                <div className="mb-2 flex items-center gap-2">
                    <span
                        className={cn(
                            "inline-flex items-center gap-2 rounded-[7px] border px-2.5 py-1 text-[11.5px] font-semibold",
                            BADGE_TONE[badge.tone]
                        )}
                    >
                        {badge.label}
                    </span>
                    {(turn.terminal === "error" || turn.terminal === "cancelled") && onRetry != null ? (
                        <button
                            type="button"
                            onClick={onRetry}
                            className="cursor-pointer rounded-[7px] border border-edge-mid px-2.5 py-1 font-mono text-[11px] text-muted hover:border-edge-strong hover:text-secondary"
                        >
                            Retry
                        </button>
                    ) : null}
                </div>
            ) : null}
            <p className="text-[14.5px] leading-[1.65] text-secondary">
                {turn.segments.map((seg, i) => {
                    if (!isCitation(seg)) return <span key={i}>{seg.text}</span>;
                    const card = byN.get(seg.citationRef);
                    return (
                        <button
                            key={i}
                            type="button"
                            title={card ? `${card.title} — open source` : undefined}
                            onClick={() => {
                                if (card) void openORef(model, card.navTarget);
                            }}
                            className="mx-0.5 inline-flex h-[17px] min-w-[17px] items-center justify-center rounded-[5px] bg-accentbg px-1 align-baseline text-[10.5px] font-bold text-accent-soft hover:bg-accent/25"
                        >
                            {seg.citationRef}
                        </button>
                    );
                })}
            </p>
        </div>
    );
}
