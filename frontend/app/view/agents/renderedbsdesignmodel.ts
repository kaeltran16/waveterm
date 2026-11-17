// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pure: what the Rendered design card draws, from the pane's own derived views (reviewHead, partView, partGist,
// partBoards). A decision's row, the one press that confirms it, the head's line and the guesses Confirm all takes.

import {
    answeredQuestions,
    canCheck,
    decisionParts,
    drawnDecisionParts,
    noteParts,
    partBoards,
    partGist,
    partView,
    plural,
    reviewHead,
    type BrainstormFile,
    type BrainstormPart,
    type BuilderCheckView,
    type PartPick,
    type PartView,
} from "./brainstormmodel";

export type DesignRow = {
    id: string;
    title: string;
    gist: string;
    view: PartView;
    // what That's right holds: confirm for a guess, keep for a decision the agent changed; null where there is nothing to confirm
    pick: PartPick | null;
    // the decision's first board, once the canvas is served
    board: string | null;
};

export type DesignView = {
    // every decision is yours: one line sums the design up and the builder check is next
    settled: boolean;
    line: string;
    // settled: how many guesses the user confirmed, beside the line; null with none
    confirmed: string | null;
    confirmAll: number | null;
    check: boolean;
    rows: DesignRow[];
    notes: { id: string; title: string; gist: string }[];
    waiting: string | null;
};

// the pane has no confirm for a changed decision, only keep or put back; That's right on it means the change stands
export function cardRowPick(f: BrainstormFile, p: BrainstormPart): PartPick | null {
    switch (partView(f, p)) {
        case "guess":
            return "confirm";
        case "changed":
            return "keep";
        default:
            return null;
    }
}

export function waitingLine(): string {
    return "Waiting for you: confirm the design, then Check with a builder";
}

// a yours decision no answered question or builder answer went into was a guess the user confirmed
function confirmedGuesses(f: BrainstormFile): number {
    const answeredInto = new Set([
        ...answeredQuestions(f).flatMap((h) => h.into),
        ...(f.check?.yours ?? []).flatMap((y) => (y.a != null ? (y.into ?? []) : [])),
    ]);
    return decisionParts(f).filter((p) => p.state === "yours" && !answeredInto.has(p.id)).length;
}

function settledLine(f: BrainstormFile): string {
    const n = decisionParts(f).length;
    return `The design · ${n} of ${n} yours`;
}

function confirmedLine(f: BrainstormFile): string | null {
    const confirmed = confirmedGuesses(f);
    return confirmed > 0 ? `you confirmed ${plural(confirmed, "guess", "guesses")}` : null;
}

export function designView(
    f: BrainstormFile,
    base: string | null,
    check: BuilderCheckView = { kind: "none" }
): DesignView {
    const head = reviewHead(f, check);
    const settled = canCheck(f);
    return {
        settled,
        line: settled ? settledLine(f) : head.line,
        confirmed: settled ? confirmedLine(f) : null,
        confirmAll: head.action === "confirm-all" ? head.guesses : null,
        check: head.action === "check",
        rows: drawnDecisionParts(f).map((p) => ({
            id: p.id,
            title: p.title,
            gist: partGist(f, p),
            view: partView(f, p),
            pick: cardRowPick(f, p),
            board: partBoards(f, p, base)?.[0] ?? null,
        })),
        notes: noteParts(f).map((p) => ({ id: p.id, title: p.title, gist: partGist(f, p) })),
        waiting: settled ? null : waitingLine(),
    };
}
