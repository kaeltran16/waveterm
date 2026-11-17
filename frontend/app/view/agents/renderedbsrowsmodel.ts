// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pure: which of the Rendered transcript's prompts draw as a brainstorm row. A prompt that is an answer Arc sent (an
// answer record, decision 3) folds to its question and pick with where it was picked; one the brainstorm file's
// history knows but no record does reads as answered, claiming no place; a canvas mark line is the mark bubble.

import type { AgentEntry } from "./agentsviewmodel";
import { answeredQuestions, type AnswerOption, type BrainstormFile } from "./brainstormmodel";
import type { AnswerOrigin, AnswerRecord } from "./brainstormstore";

// a record is written as the line is sent and the transcript stamps the prompt as it lands, so the prompt is never
// older than its record; this allows for the two clocks' rounding
const RECORD_SKEW_MS = 2_000;
// sendLine puts waiting picks before the line they ride with
const CARRIED = /^brainstorm: settle .*?; then: /;
const BRAINSTORM_HEAD = "brainstorm:";
// canvasHandoffLine: "look at <crop> — mark on <board>: <note>", the crop under the canvas's feedback folder
const MARK_LINE = /^look at (\.superpowers\/design\/([^/]+)\/feedback\/([^/\s]+)) — mark on (.+?): (.*)$/;
const NO_NOTE = "(no note)";

export type RowOption = { label: string; detail?: string; picked: boolean };

export type EntryRowView =
    | {
          kind: "answer";
          origin: AnswerOrigin;
          // the talk question's number; null for the builder's question
          n: number | null;
          builder: boolean;
          question: string;
          why?: string;
          answer: string;
          options: RowOption[];
          // the answer when it was typed rather than picked from the options
          ownWords: string | null;
      }
    | { kind: "answered"; n: number; answer: string }
    | { kind: "mark"; crop: string; canvas: string; file: string; board: string; note: string | null };

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

// the latest record of this line sent before the prompt landed; a prompt with no time takes the latest
function recordFor(text: string, ts: number | undefined, records: AnswerRecord[]): AnswerRecord | null {
    let found: AnswerRecord | null = null;
    for (const r of records) {
        if (oneLine(r.line) !== text || (ts != null && r.at > ts + RECORD_SKEW_MS)) continue;
        if (found == null || r.at >= found.at) found = r;
    }
    return found;
}

function rowOptions(options: AnswerOption[] | undefined, picked: (o: AnswerOption, i: number) => boolean): RowOption[] {
    return (options ?? []).map((o, i) => ({ label: o.label, detail: o.detail || undefined, picked: picked(o, i) }));
}

function answerView(r: AnswerRecord, f: BrainstormFile): EntryRowView {
    const answer = r.answer;
    if (r.builder != null) {
        const y = f.check?.yours.find((q) => q.q === r.builder);
        const options = rowOptions(y?.options, (o) => o.label === answer);
        return {
            kind: "answer",
            origin: r.origin,
            n: null,
            builder: true,
            question: r.builder,
            why: y?.why,
            answer,
            options,
            ownWords: options.some((o) => o.picked) ? null : answer,
        };
    }
    // answered: the history entry; still being written up: the open question
    const h = answeredQuestions(f).find((e) => e.n === r.question);
    const q = h == null && f.question?.n === r.question ? f.question : null;
    const options = h
        ? rowOptions(h.options, (o, i) => (h.picked != null ? i === h.picked : o.label === answer))
        : rowOptions(q?.options, (o) => o.label === answer);
    return {
        kind: "answer",
        origin: r.origin,
        n: r.question,
        builder: false,
        question: h?.q ?? q?.text ?? "",
        why: h?.why ?? q?.why,
        answer,
        options,
        ownWords: options.some((o) => o.picked) ? null : answer,
    };
}

// the latest answered question this text answers: the agent's record of the answer, or the option it picked
function historyAnswer(text: string, f: BrainstormFile): EntryRowView | null {
    const answer = text.replace(CARRIED, "");
    if (answer.startsWith(BRAINSTORM_HEAD)) return null;
    const h = [...answeredQuestions(f)]
        .reverse()
        .find(
            (e) =>
                e.n != null &&
                (oneLine(e.a) === answer ||
                    (e.picked != null && oneLine(e.options?.[e.picked]?.label ?? "") === answer))
        );
    return h ? { kind: "answered", n: h.n, answer } : null;
}

export function entryRowView(
    entry: AgentEntry,
    records: AnswerRecord[],
    f: BrainstormFile | null
): EntryRowView | null {
    if (entry.kind !== "user") return null;
    const text = oneLine(entry.text);
    const mark = MARK_LINE.exec(text);
    if (mark) {
        const note = mark[5].trim();
        return {
            kind: "mark",
            crop: mark[1],
            canvas: mark[2],
            file: mark[3],
            board: mark[4],
            note: note === NO_NOTE || note === "" ? null : note,
        };
    }
    if (f == null) return null;
    const r = recordFor(text, entry.ts, records);
    return r != null ? answerView(r, f) : historyAnswer(text, f);
}
