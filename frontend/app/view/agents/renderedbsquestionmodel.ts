// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pure: what the Rendered question card draws for the open talk question. Its rows (the approaches while the judge
// weighs, else the options with the pick's badge and the judge's ranking), the hint under them, which of Guess for me
// and Skip it offers, the judge's status and clock start, and the row that opens a brainstorm.

import {
    judgeWork,
    OPTION_KEYS,
    plural,
    progressView,
    type AnswerOption,
    type BrainstormFile,
    type BrainstormQuestion,
    type BuilderCheckRecord,
    type JudgeWork,
} from "./brainstormmodel";

// the pane's words for the pick
export const JUDGE_PICK = "Judge’s pick";
export const AGENT_PICK = "Agent’s pick";

const ORDINALS = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth"];

// judging: the approaches stand in for the options; judged and failed: the judge's result landed; plain: no judge
export type QuestionRowsState = "judging" | "judged" | "failed" | "plain";

export type QuestionRows = {
    state: QuestionRowsState;
    options: AnswerOption[];
    badge: (i: number) => string | null;
    // the judge's ranking of a kept option, drawn in place of its detail
    note: (i: number) => string | null;
    work: JudgeWork | null;
};

const NONE = () => null;

function ordinal(n: number): string {
    return ORDINALS[n - 1] ?? `#${n}`;
}

// the pick ranks first; every other kept option follows it in the judge's order
function keptNotes(options: AnswerOption[]): (i: number) => string | null {
    const order = options.map((o, i) => ({ o, i })).sort((a, b) => Number(!!b.o.pick) - Number(!!a.o.pick));
    const rank = new Map(order.map(({ i }, k) => [i, k + 1]));
    return (i) => (options[i]?.pick ? null : `kept as the ${ordinal(rank.get(i) ?? i + 1)} option`);
}

// a rerun's earlier options, read and judge are left out while the judge weighs, as the pane does
export function questionRows(q: BrainstormQuestion, judging: boolean): QuestionRows {
    if (judging) {
        const options = (q.approaches ?? []).map((a) => ({ label: a.name, detail: a.description }));
        return { state: "judging", options, badge: NONE, note: NONE, work: null };
    }
    const options = q.options ?? [];
    const work = judgeWork(q);
    const judged = work?.judged === true;
    const label = judged ? JUDGE_PICK : AGENT_PICK;
    return {
        state: work == null ? "plain" : judged ? "judged" : "failed",
        options,
        badge: (i) => (options[i]?.pick ? label : null),
        note: judged ? keptNotes(options) : NONE,
        work,
    };
}

// only the first OPTION_KEYS.length rows have a key to press
export function picksHint(rows: number): string {
    if (rows === 0) {
        return "answer in the box below";
    }
    const keys = Math.min(rows, OPTION_KEYS.length);
    return `press ${keys === 1 ? "1" : `1–${keys}`} to pick · or type your own answer below`;
}

// guessing or skipping means something only for a question about a part; the judge's pick is coming, so no guess
// while it weighs; in the builder check every part is already written, so no skip. Guess for me is offered on
// question 1 too: the guess line means the same to the agent on any question
export function questionActions(f: BrainstormFile, judging: boolean): { guess: boolean; skip: boolean } {
    const about = (f.question?.part ?? "") !== "";
    return { guess: about && !judging, skip: about && f.check == null };
}

export function judgeStatus(q: BrainstormQuestion): string {
    return `The judge is weighing ${plural(q.approaches?.length ?? 0, "approach", "approaches")}`;
}

// Arc's record of a reading judge says when it started; without one, the file's write that asked for it
export function judgeStartMs(record: BuilderCheckRecord | undefined, modifiedMs: number | null): number | null {
    return record?.state === "reading" ? record.ts : modifiedMs;
}

// in Claude Code a hook reveals the brainstorm, so the transcript has no entry to say it started: the card says it
// over question 1 until the first answer lands in the history
export function startedRow(f: BrainstormFile): { decisions: string } | null {
    if (f.history.length > 0) {
        return null;
    }
    const n = progressView(f).segments.length;
    return { decisions: `${plural(n, "decision", "decisions")} to talk through` };
}
