// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Renders one JarvisConversation as a list of turns. The turn renderer itself lives in jarvisturn.tsx
// so a run's thread draws Jarvis answers identically.

import type { AgentsViewModel } from "@/app/view/agents/agents";
import { SurfaceEmptyState } from "@/app/view/agents/surfacescaffold";
import { Brain } from "lucide-react";
import type { JarvisConversation, JarvisTurn } from "./jarviscontract";
import { isAnswerTurn } from "./jarviscontract";
import { JarvisAnswer, JarvisUserTurn } from "./jarvisturn";

export function ConversationView({ conversation, model }: { conversation: JarvisConversation; model: AgentsViewModel }) {
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
                        <JarvisAnswer turn={turn} model={model} />
                    </div>
                ) : (
                    <JarvisUserTurn key={i} text={turn.text} />
                )
            )}
        </div>
    );
}
