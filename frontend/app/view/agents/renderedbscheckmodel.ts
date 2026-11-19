// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pure: what the Rendered builder check card draws. Its state follows the pane's own views (builderCheckView for the
// pending and failed check, checkMain for the builder's open question), so the card and the pane never disagree.

import {
    checkAsk,
    checkClock,
    checkMain,
    partTitle,
    plural,
    type BrainstormFile,
    type BuilderCheckView,
    type CheckClock,
    type CheckSpan,
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

export const CHECK_FAILED_LINE = "The builder check did not finish";
export const CHECK_SETTLED_LINE = "A builder read the design";

// the one-row card's title while the Brainstorm tab shows: the step the full card names in its state
export function checkRowTitle(f: BrainstormFile, check: BuilderCheckView, linePending: boolean): string {
    switch (checkCardState(f, check, linePending)) {
        case "reading":
        case "taking-in":
            return check.kind === "pending" ? check.text : "";
        case "failed":
            return CHECK_FAILED_LINE;
        case "asking":
            return builderHead(f).lead;
        case "settled":
            return CHECK_SETTLED_LINE;
    }
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

const SEC_MS = 1000;
const MIN_SEC = 60;
// the check locks the design's edits (editLock), so the card says so where the pane says to read meanwhile
const EDITS_WAIT = "Edits to the design wait until it is back.";

// "5m 02s", the board's reading of a duration; under a minute, "42s"
export function cardTime(ms: number): string {
    const secs = Math.max(0, Math.floor(ms / SEC_MS));
    const m = Math.floor(secs / MIN_SEC);
    const s = secs % MIN_SEC;
    return m === 0 ? `${s}s` : `${m}m ${String(s).padStart(2, "0")}s`;
}

function cardAbout(ms: number): string {
    const mins = Math.round(ms / (MIN_SEC * SEC_MS));
    return mins < 1 ? "under a minute" : `about ${mins}m`;
}

// the pane's clock (checkClock) in the BuilderCheck and CheckStates boards' words: their times and their note
export function cardClock(
    check: Extract<BuilderCheckView, { kind: "pending" }>,
    span: CheckSpan | null,
    times: BrainstormCheckTimes | null,
    now: number
): CheckClock {
    const clock = checkClock(check, span, times, now);
    const ms = span == null ? null : (span.end ?? now) - span.start;
    const elapsed = ms == null ? null : cardTime(ms);
    const known = times != null && times.usualms > 0 && times.longestms > 0;
    const timesText = known ? `usual ${cardTime(times.usualms)} · longest ${cardTime(times.longestms)}` : null;
    if (check.stage === "taking-in") {
        const done = elapsed == null ? "The builder finished." : `The builder finished in ${elapsed}.`;
        return {
            ...clock,
            elapsed,
            times: timesText,
            note: `${done} The agent is sorting its questions into yours, its calls and what the design already answers.`,
        };
    }
    if (!known) {
        return { ...clock, elapsed, times: null, note: EDITS_WAIT };
    }
    const about = cardAbout(times.usualms);
    return {
        ...clock,
        elapsed,
        times: timesText,
        note: clock.over
            ? `Taking longer than usual: most checks here finish in ${about}. ${EDITS_WAIT}`
            : `Checks here usually take ${about}. ${EDITS_WAIT}`,
    };
}
