// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The Sources card treatment: the grounding cards of a conversation's latest jarvis turn — source type,
// title, project, age, freshness. Freshness (stale/unavailable) is surfaced, not hidden (spec invariant 7).
// Exported as a RailSection, not a rail: after the consolidation there is exactly one rail (StageRail),
// which draws this section among its own.

import { type RailSection } from "@/app/element/collapsiblerail";
import type { AgentsViewModel } from "@/app/view/agents/agents";
import { cn } from "@/util/util";
import { BookMarked } from "lucide-react";
import type { GroundingCard, JarvisConversation } from "./jarviscontract";
import { isAnswerTurn } from "./jarviscontract";
import { openORef } from "./openref";
import { ageLabel, freshnessLabel } from "./recallderive";

function freshnessClass(f: GroundingCard["freshness"]): string {
    switch (f) {
        case "fresh":
            return "text-success";
        case "stale":
            return "text-warning";
        case "unavailable":
            return "text-error";
        // not a health reading, so not on the success/warning/error scale at all
        case "unverified":
            return "text-muted";
    }
}

function Card({ card, model }: { card: GroundingCard; model: AgentsViewModel }) {
    return (
        <button
            type="button"
            onClick={() => void openORef(model, card.navTarget)}
            className={cn(
                "flex w-full cursor-pointer flex-col gap-1 rounded-[10px] border px-3 py-2.5 text-left hover:bg-surface-hover",
                card.expanded ? "border-accent/40 bg-accentbg" : "border-border bg-surface"
            )}
        >
            <div className="flex items-center gap-2">
                <span className="rounded-[5px] bg-surface-selected px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-ink-mid">
                    {card.sourceType}
                </span>
                <span className="ml-auto text-[11px] text-muted">[{card.n}]</span>
            </div>
            <div className="text-[13px] font-semibold text-secondary">{card.title}</div>
            <div className="flex items-center gap-2 text-[11px] text-muted">
                <span>{card.project}</span>
                <span>·</span>
                <span>{ageLabel(card.ageMs)}</span>
                <span className={cn("ml-auto font-semibold", freshnessClass(card.freshness))}>
                    {freshnessLabel(card.freshness)}
                </span>
            </div>
        </button>
    );
}

// whether this conversation has answered at all — the merged surface draws the section only then, so a
// thread that has never been asked anything shows no empty Sources heading.
export function hasGroundingAnswer(conversation: JarvisConversation): boolean {
    return conversation.turns.some(isAnswerTurn);
}

// The Sources section as a RailSection, so the merged surface's single rail draws this exact card
// treatment instead of a second copy of it.
export function groundingSection(conversation: JarvisConversation, model: AgentsViewModel): RailSection {
    const answerTurns = conversation.turns.filter(isAnswerTurn);
    const latest = answerTurns[answerTurns.length - 1];
    const cards = latest?.grounding ?? [];
    return {
        id: "grounding",
        icon: <BookMarked size={18} strokeWidth={1.8} />,
        label: "Sources",
        content: (
            <div className="flex flex-col gap-2.5">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-muted">Sources</div>
                {cards.length === 0 ? (
                    <div className="text-[12px] text-muted">No grounding sources.</div>
                ) : (
                    cards.map((c) => <Card key={c.n} card={c} model={model} />)
                )}
            </div>
        ),
    };
}
