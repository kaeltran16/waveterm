// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// How the keyboard walks a structured ask: where a digit pick moves, what Enter does, and whether the
// ask can be dismissed. Pure, so the cockpit keymap and the AnswerBar share one rule.

import { canSubmitAsk, nextUnansweredQuestion, type AgentAskQuestion, type AgentVM } from "./agentsviewmodel";

const isAnswered = (selections: Record<number, Set<number>>, texts: Record<number, string>, qi: number) =>
    (selections[qi]?.size ?? 0) > 0 || (texts[qi] ?? "").trim() !== "";

/** Pure: the question to move to after a pick on `qi`, or null to stay. A multi-select question stays, since it
 *  takes several picks; a single-select one moves to the next unanswered question, as a click does. It never
 *  submits: the keyboard keeps Enter as the confirm step. */
export function pickAdvance(
    questions: AgentAskQuestion[],
    selections: Record<number, Set<number>>,
    texts: Record<number, string>,
    qi: number
): number | null {
    if (questions[qi]?.multiSelect) {
        return null;
    }
    const next = nextUnansweredQuestion(questions, selections, texts, qi);
    return next === -1 ? null : next;
}

export type EnterAction = { kind: "submit" } | { kind: "question"; qi: number };

/** Pure: Enter on a structured ask submits once every question has an answer; otherwise it moves to the first
 *  unanswered question, starting from the active one, so Enter never leaves an unanswered ask. */
export function enterAction(
    questions: AgentAskQuestion[],
    selections: Record<number, Set<number>>,
    texts: Record<number, string>,
    activeQi: number
): EnterAction {
    if (canSubmitAsk(questions, selections, texts)) {
        return { kind: "submit" };
    }
    const n = questions.length;
    const start = Math.max(0, Math.min(activeQi, n - 1));
    for (let step = 0; step < n; step++) {
        const qi = (start + step) % n;
        if (!isAnswered(selections, texts, qi)) {
            return { kind: "question", qi };
        }
    }
    return { kind: "question", qi: start };
}

/** Pure: whether dismissing the ask cancels it. Only pi's ask tool can be cancelled; for Claude a dismiss would
 *  hide the panel copy while the agent stays blocked, so it is not offered. */
export function canDismissAsk(agent: AgentVM): boolean {
    return agent.agent === "pi";
}
