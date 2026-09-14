// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pure: which dag child questions the run surface shows, in the shape the cockpit's AnswerBar renders,
// and when the card must re-read the queue. Kept out of the card so it is testable without a DOM.

import { toAskQuestions, type AgentVM } from "./agentsviewmodel";
import { detailOf } from "./runtimeline";

// ASK_OWNER_USER mirrors agentask.AskOwner_User.
export const ASK_OWNER_USER = "user";

// the run rows that change what the queue holds: a raise, a hand-off to the human, an answer, and the
// child clearing its ask
const ASK_QUEUE_EVENT_KINDS = new Set(["child-ask", "task-forwarded", "child-answered", "child-ask-cleared"]);

// childAskKey falls back to the task id because the wire type leaves the ask id optional.
export function childAskKey(ask: DagAskItem): string {
    return ask.askid || ask.taskid;
}

// userOwnedAsks is what the card shows, oldest first. A lead-held entry is the lead's to answer, and two
// answerers on one question would race to type into the child.
export function userOwnedAsks(asks: DagAskItem[]): DagAskItem[] {
    return asks.filter((a) => a.owner === ASK_OWNER_USER).sort((a, b) => a.ts - b.ts);
}

// childAskAgent adapts an entry to the AgentVM the AnswerBar takes; the bar reads only the ask and the
// asking state.
export function childAskAgent(ask: DagAskItem): AgentVM {
    return {
        id: childAskKey(ask),
        name: ask.taskid,
        task: "",
        state: "asking",
        ask: { questions: toAskQuestions(ask.questions), askId: ask.askid, oref: ask.blockoref },
    };
}

// childAskSent reports whether the entry still stands answered from this card. An answer the child never
// consumed is handed back through a task-forwarded row, and that row is the only signal: the note is the
// same on the first and the second failed delivery.
export function childAskSent(sentTs: number | undefined, ask: DagAskItem, events: RunEvent[]): boolean {
    if (sentTs == null) {
        return false;
    }
    return !events.some((e) => {
        if (e.kind !== "task-forwarded" || e.ts <= sentTs) {
            return false;
        }
        const detail = detailOf<{ taskid?: string; askid?: string }>(e);
        return ask.askid ? detail?.askid === ask.askid : detail?.taskid === ask.taskid;
    });
}

// newAskEventIds returns the queue-changing rows the card has not refreshed for yet.
export function newAskEventIds(events: RunEvent[], seen: Set<string>): string[] {
    return events.filter((e) => ASK_QUEUE_EVENT_KINDS.has(e.kind) && !seen.has(e.id)).map((e) => e.id);
}
