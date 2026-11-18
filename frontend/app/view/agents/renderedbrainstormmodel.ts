// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pure: which brainstorm card the Rendered transcript draws at its end, and the card head's status. The card follows
// the pane's own main views (mainView, checkMain) with the pane-only "design opened over the question" left out, so
// the card and the pane never disagree on what is asked.

import type { AgentsViewModel } from "./agents";
import type { AgentVM } from "./agentsviewmodel";
import {
    brainstormPhase,
    checkMain,
    checkReview,
    confirmableGuesses,
    mainView,
    progressView,
    shownFile,
    type BrainstormFile,
    type BuilderCheckView,
} from "./brainstormmodel";
import type { BrainstormState } from "./brainstormstore";

// under this column width a card takes the timeline's compact sizes and its side-by-side rows stack: where the option
// rows' chips start to squeeze the label on the boards
export const COMPACT_CARD_PX = 600;

export type RenderedCard =
    | { kind: "none" }
    | { kind: "question"; judging: boolean }
    | { kind: "design" }
    | { kind: "check" }
    | { kind: "review" }
    | { kind: "gone"; why: "unreadable" | "removed" };

export type CardProps = {
    model: AgentsViewModel;
    agent: AgentVM;
    s: BrainstormState;
    f: BrainstormFile;
    compact: boolean;
};

const NONE: RenderedCard = { kind: "none" };

// the check phase's main view, as a card: a review with a change waiting on keep or put back is the review; with a
// guess waiting the design (to confirm it); else the settled approve bar
function checkCard(f: BrainstormFile, linePending: boolean): RenderedCard {
    switch (checkMain(f, false, linePending)) {
        case "working":
            return NONE;
        case "judging":
            return { kind: "question", judging: true };
        case "question":
            return { kind: "question", judging: false };
        case "builder":
            return { kind: "check" };
        case "review":
            if (checkReview(f).pending > 0) {
                return { kind: "review" };
            }
            return confirmableGuesses(f) > 0 ? { kind: "design" } : { kind: "check" };
    }
}

function talkCard(f: BrainstormFile, linePending: boolean): RenderedCard {
    switch (mainView(f, false, linePending)) {
        case "working":
            return NONE;
        case "judging":
            return { kind: "question", judging: true };
        case "question":
            return { kind: "question", judging: false };
        case "design":
            return { kind: "design" };
    }
}

// "working" is the pane's working view, not the agent's process state: the judge's wait keeps its card
export function renderedCard(s: BrainstormState | null, check: BuilderCheckView): RenderedCard {
    if (s == null) {
        return NONE;
    }
    if (s.removed) {
        return { kind: "gone", why: "removed" };
    }
    if (s.file == null) {
        return s.error != null ? { kind: "gone", why: "unreadable" } : NONE;
    }
    const f = shownFile(s.file, s.sent);
    const linePending = s.sent != null;
    // a run has no card: its line is a row, and the workspace pane's Brainstorm tab shows where it stands
    if (f.run != null) {
        return NONE;
    }
    if ((check.kind === "pending" || check.kind === "failed") && f.question == null) {
        return { kind: "check" };
    }
    return f.check != null ? checkCard(f, linePending) : talkCard(f, linePending);
}

// the head's right-hand words; a run draws no card
export function cardStatus(f: BrainstormFile): string {
    switch (brainstormPhase(f)) {
        case "talk":
            return `Talking it through · ${progressView(f).lead} yours`;
        case "check":
            return "Checking with a builder";
        case "run":
            return "";
    }
}
