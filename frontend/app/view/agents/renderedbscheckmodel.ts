// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pure: what the Rendered builder check card draws. Its state follows the pane's own views (builderCheckView for the
// pending and failed check, checkMain for the builder's open question), so the card and the pane never disagree.

import {
    checkAsk,
    checkMain,
    partTitle,
    plural,
    type BrainstormFile,
    type BuilderCheckView,
    type CheckClock,
} from "./brainstormmodel";

export type CheckCardState = "reading" | "taking-in" | "failed" | "asking" | "settled";

// a pending or failed check outranks whatever an earlier check left in the file
export function checkCardState(f: BrainstormFile, check: BuilderCheckView, linePending: boolean): CheckCardState {
    if (check.kind === "pending") {
        return check.stage;
    }
    if (check.kind === "failed") {
        return "failed";
    }
    return checkMain(f, false, linePending) === "builder" ? "asking" : "settled";
}

// "Builder question · i of n", and the part the question is for, which the head links to
export function builderHead(f: BrainstormFile): { lead: string; part: { id: string; title: string } | null } {
    const ask = checkAsk(f);
    const part = ask.open?.part;
    return {
        lead: `Builder question · ${ask.index} of ${ask.total}`,
        part: part ? { id: part, title: partTitle(f, part) } : null,
    };
}

export function settledLine(questions: number): string {
    const verb = questions === 1 ? "is" : "are";
    return `Its ${plural(questions, "question", "questions")} ${verb} settled. Approving starts an orchestrator run from the spec.`;
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

// the clock's bar as CSS widths: the fill and the usual mark, fractions of the longest past check
export function clockBar(bar: CheckClock["bar"], over: boolean): { fill: string; usual: string; over: boolean } | null {
    return bar == null ? null : { fill: pct(bar.fill), usual: pct(bar.usual), over };
}
