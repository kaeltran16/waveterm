// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Right grounding rail. Shows the grounding cards of the conversation's latest jarvis turn: source type,
// title, project, age, freshness. One card may be expanded. Freshness (stale/unavailable) is surfaced,
// not hidden (spec invariant 7). Uses the shared CollapsibleRail (300/44px), persisted-collapsed by
// default so narrow panes keep conversation width (== spec state 12, narrow window).

import { CollapsibleRail, type RailSection } from "@/app/element/collapsiblerail";
import { cn } from "@/util/util";
import { BookMarked } from "lucide-react";
import type { GroundingCard, JarvisConversation } from "./jarviscontract";
import { isAnswerTurn } from "./jarviscontract";
import { ageLabel, freshnessLabel } from "./recallderive";
import { groundingRailOpenAtom } from "./jarvisstore";

function freshnessClass(f: GroundingCard["freshness"]): string {
    switch (f) {
        case "fresh":
            return "text-success";
        case "stale":
            return "text-warning";
        case "unavailable":
            return "text-error";
    }
}

function Card({ card }: { card: GroundingCard }) {
    return (
        <button
            type="button"
            onClick={() => console.log("[jarvis] open source", card.navTarget)}
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

export function GroundingRail({ conversation }: { conversation: JarvisConversation }) {
    const answerTurns = conversation.turns.filter(isAnswerTurn);
    const latest = answerTurns[answerTurns.length - 1];
    const cards = latest?.grounding ?? [];
    const sections: RailSection[] = [
        {
            id: "grounding",
            icon: <BookMarked size={18} strokeWidth={1.8} />,
            label: "Sources",
            content: (
                <div className="flex flex-col gap-2.5">
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-muted">Sources</div>
                    {cards.length === 0 ? (
                        <div className="text-[12px] text-muted">No grounding sources.</div>
                    ) : (
                        cards.map((c) => <Card key={c.n} card={c} />)
                    )}
                </div>
            ),
        },
    ];
    return <CollapsibleRail openAtom={groundingRailOpenAtom} ariaLabel="Grounding sources" sections={sections} />;
}
