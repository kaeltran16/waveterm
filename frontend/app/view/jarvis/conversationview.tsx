// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Renders one JarvisConversation. The visual center of gravity (spec). Handles user + jarvis turns,
// streamed working-steps (done/active/pending), answer segments interleaved with [n] citations, and the
// three terminals (answered / weak / not-found). One renderer, many states — the 12 fixtures exercise it.

import { SurfaceEmptyState } from "@/app/view/agents/surfacescaffold";
import { cn } from "@/util/util";
import { Brain } from "lucide-react";
import type { JarvisAnswerTurn, JarvisConversation, JarvisTurn } from "./jarviscontract";
import { isAnswerTurn, isCitation } from "./jarviscontract";
import { groundingByN } from "./recallderive";

function WorkingSteps({ turn }: { turn: JarvisAnswerTurn }) {
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

function Answer({ turn }: { turn: JarvisAnswerTurn }) {
    const byN = groundingByN(turn.grounding);
    return (
        <div className="max-w-[720px]">
            <WorkingSteps turn={turn} />
            {turn.terminal === "notfound" ? (
                <div className="mb-2 inline-flex items-center gap-2 rounded-[7px] border border-border px-2.5 py-1 text-[11.5px] font-semibold text-muted">
                    Not found
                </div>
            ) : turn.terminal === "weak" ? (
                <div className="mb-2 inline-flex items-center gap-2 rounded-[7px] border border-warning/40 bg-warning/10 px-2.5 py-1 text-[11.5px] font-semibold text-warning">
                    Weak grounding
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
                            onClick={() => card && console.log("[jarvis] open source", card.navTarget)}
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

function UserTurn({ text }: { text: string }) {
    return (
        <div className="flex justify-end">
            <div className="max-w-[560px] rounded-[12px] bg-surface-raised px-3.5 py-2 text-[14px] text-primary">{text}</div>
        </div>
    );
}

export function ConversationView({ conversation }: { conversation: JarvisConversation }) {
    if (conversation.turns.length === 0) {
        return (
            <SurfaceEmptyState
                glyph={<Brain size={40} strokeWidth={1.6} className="mb-4 text-accent" />}
                title="Ask Jarvis"
                body="Recall what happened, recover context, or understand why a decision was made — grounded in your Wave knowledge."
            />
        );
    }
    return (
        <div className="mx-auto flex max-w-[900px] flex-col gap-6 px-8 py-8">
            {conversation.turns.map((turn: JarvisTurn, i) =>
                isAnswerTurn(turn) ? (
                    <div key={i} className="flex gap-3">
                        <Brain size={18} strokeWidth={1.8} className="mt-1 shrink-0 text-accent" />
                        <Answer turn={turn} />
                    </div>
                ) : (
                    <UserTurn key={i} text={turn.text} />
                )
            )}
        </div>
    );
}
