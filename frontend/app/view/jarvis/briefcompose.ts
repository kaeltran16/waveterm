// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The words on the Brief's one composer. resolveComposerTarget decides WHO a keystroke reaches; this only
// says it out loud, for the Brief's three shapes — the launch view, an expanded thread, a work sheet. The
// user must never be unsure whether a keystroke reaches a running worker or Jarvis, and on the Brief the
// composer never moves, so these three strings are the only thing that changes when its meaning does.

// launch is the Brief with nothing expanded; sheet is a session or an initiative drawer.
export type BriefComposeState =
    | { peek: "launch" }
    | { peek: "thread"; title?: string; turnCount?: number; sourceChip?: string }
    | { peek: "sheet"; kind?: "session" | "initiative"; name?: string; project?: string };

export interface ComposerLabels {
    scope: string;
    hint: string;
    action: string;
    // the second thing Enter could do here, absent when there is no second thing — one field to keep
    // consistent instead of a label plus a flag that could disagree with it.
    alt?: string;
}

const ALL_WORK = "grounded in all work";
const ASK = "Ask ⏎";

export function resolveComposerLabels(state: BriefComposeState): ComposerLabels {
    if (state.peek === "sheet") {
        // a sheet is a session unless it declares itself an initiative: understating the scope is the
        // safer miss of the two.
        const initiative = state.kind === "initiative";
        const name = state.name?.trim();
        const project = state.project?.trim();
        return {
            scope: initiative ? "grounded in this initiative" : "scoped to this session",
            hint: initiative ? `Ask about ${name || "this initiative"}` : "Message the lead of this session",
            action: "Send ⏎",
            // a standing rule outlives the session, so it needs a project to stand for: no project, no offer.
            ...(!initiative && project ? { alt: `⇧⏎ standing rule for ${project}` } : {}),
        };
    }
    if (state.peek === "thread") {
        const followUp = (state.turnCount ?? 0) > 0;
        const chip = state.sourceChip?.trim();
        const title = state.title?.trim();
        return {
            // the chip names one source, so the scope cannot also claim all work — they have to agree.
            scope: chip ? `grounded in ${chip.toLowerCase()}` : ALL_WORK,
            // a thread attached from another surface opens with nothing in it, so its first ask is not a
            // follow-up: the turn count decides that, not the attachment.
            hint: followUp ? "Ask a follow-up in this thread" : `Ask about ${title || "this thread"}`,
            action: followUp ? "Follow up ⏎" : ASK,
        };
    }
    return { scope: ALL_WORK, hint: "Ask across your work", action: ASK };
}
