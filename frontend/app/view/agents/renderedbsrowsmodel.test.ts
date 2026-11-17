// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { AgentEntry } from "./agentsviewmodel";
import type { BrainstormFile, HistoryEntry } from "./brainstormmodel";
import type { AnswerRecord } from "./brainstormstore";
import { entryRowView } from "./renderedbsrowsmodel";

const T = 1_700_000_000_000;

const Q4 = {
    n: 4,
    text: "Should a verify waiting for its turn show in the run's graph?",
    part: "queue",
    why: "Today its node reads the same as a stuck one.",
    options: [
        { label: "A queued chip on the Final node", detail: "the graph says 2nd in line" },
        { label: "Only the attention banner", detail: "quiet until it matters" },
        { label: "Both", detail: "the chip at once, the banner after 20 minutes" },
    ],
};

const Q2: HistoryEntry = {
    kind: "question",
    n: 2,
    q: "What tells Arc memory is running low?",
    why: "Two signals exist.",
    a: "The OS low-memory signal",
    into: ["signal"],
    options: [
        { label: "Free memory under a line", detail: "" },
        { label: "The OS low-memory signal", detail: "" },
    ],
    picked: 1,
};

const Q3: HistoryEntry = {
    kind: "question",
    n: 3,
    q: "How many Finals may run at once?",
    a: "One Final at a time",
    into: ["approach"],
    options: [
        { label: "Two at a time", detail: "" },
        { label: "One Final at a time", detail: "" },
    ],
    picked: 1,
};

const BUILDER_Q = "Does time spent queued count toward the run's wall time in Usage?";

const FILE: BrainstormFile = {
    v: 1,
    title: "Run memory pressure",
    spec: "docs/spec.md",
    canvas: "final-queue",
    question: Q4,
    working: null,
    parts: [],
    history: [Q2, Q3],
    done: false,
    check: {
        yours: [
            {
                q: BUILDER_Q,
                why: "It changes the Usage numbers.",
                options: [
                    { label: "Yes", detail: "" },
                    { label: "No", detail: "" },
                ],
            },
        ],
        calls: [],
        answered: [],
    },
    run: null,
};

const user = (text: string, ts?: number): AgentEntry => ({ kind: "user", text, ts });

const rec = (over: Partial<AnswerRecord>): AnswerRecord => ({
    line: "Both",
    question: 4,
    builder: null,
    answer: "Both",
    origin: "transcript",
    at: T,
    ...over,
});

describe("entryRowView", () => {
    it("folds an answer with a record to its question and pick, keeping where it was picked", () => {
        const v = entryRowView(user("Both", T + 500), [rec({})], FILE);
        expect(v).toEqual({
            kind: "answer",
            origin: "transcript",
            n: 4,
            builder: false,
            question: Q4.text,
            why: Q4.why,
            answer: "Both",
            options: [
                { label: Q4.options[0].label, detail: Q4.options[0].detail, picked: false },
                { label: Q4.options[1].label, detail: Q4.options[1].detail, picked: false },
                { label: "Both", detail: Q4.options[2].detail, picked: true },
            ],
            ownWords: null,
        });
    });

    it("keeps a pane origin", () => {
        const v = entryRowView(user("Both", T + 500), [rec({ origin: "pane" })], FILE);
        expect(v?.kind === "answer" && v.origin).toBe("pane");
    });

    it("reads an answered question from the history, its pick from the entry's index", () => {
        const v = entryRowView(
            user("The OS low-memory signal", T + 500),
            [rec({ line: "The OS low-memory signal", question: 2, answer: "The OS low-memory signal" })],
            FILE
        );
        expect(v).toMatchObject({ kind: "answer", n: 2, question: Q2.q, why: Q2.why });
        expect(v?.kind === "answer" && v.options.map((o) => o.picked)).toEqual([false, true]);
    });

    it("matches a line that carried picks, and names the answer alone", () => {
        const line = "brainstorm: settle confirm queue; then: Both";
        const v = entryRowView(user(line, T + 500), [rec({ line })], FILE);
        expect(v).toMatchObject({ kind: "answer", n: 4, answer: "Both" });
    });

    it("an answer in the user's own words marks no option and keeps the words", () => {
        const words = "Only when two runs wait";
        const v = entryRowView(user(words, T + 500), [rec({ line: words, answer: words })], FILE);
        expect(v?.kind === "answer" && v.options.every((o) => !o.picked)).toBe(true);
        expect(v?.kind === "answer" && v.ownWords).toBe(words);
    });

    it("folds a builder answer with a record to the builder's question", () => {
        const line = "brainstorm: builder answer: Yes";
        const v = entryRowView(
            user(line, T + 500),
            [rec({ line, question: null, builder: BUILDER_Q, answer: "Yes" })],
            FILE
        );
        expect(v).toMatchObject({ kind: "answer", builder: true, n: null, question: BUILDER_Q, answer: "Yes" });
        expect(v?.kind === "answer" && v.options.map((o) => o.picked)).toEqual([true, false]);
    });

    it("pairs an entry with the record sent before it, not a later one with the same line", () => {
        const first = rec({ question: 3, line: "Yes", answer: "Yes", at: T });
        const second = rec({ question: 4, line: "Yes", answer: "Yes", at: T + 60_000 });
        const early = entryRowView(user("Yes", T + 1_000), [first, second], FILE);
        const late = entryRowView(user("Yes", T + 61_000), [first, second], FILE);
        expect(early?.kind === "answer" && early.n).toBe(3);
        expect(late?.kind === "answer" && late.n).toBe(4);
    });

    it("an answer the history knows but no record does is the plain answered row", () => {
        expect(entryRowView(user("One Final at a time", T), [], FILE)).toEqual({
            kind: "answered",
            n: 3,
            answer: "One Final at a time",
        });
    });

    it("an entry older than every record with its line falls back to the history", () => {
        const v = entryRowView(
            user("One Final at a time", T - 60_000),
            [rec({ line: "One Final at a time", question: 3 })],
            FILE
        );
        expect(v).toEqual({ kind: "answered", n: 3, answer: "One Final at a time" });
    });

    it("a superseded question is no answer", () => {
        const f = { ...FILE, history: [{ ...Q3, superseded: true as const }] };
        expect(entryRowView(user("One Final at a time", T), [], f)).toBeNull();
    });

    it("classifies a canvas mark line: the board, the note and the crop path", () => {
        const line =
            "look at .superpowers/design/final-queue/feedback/003.png — mark on Main.dc.html: The chip crowds the Final label";
        expect(entryRowView(user(line, T), [], null)).toEqual({
            kind: "mark",
            crop: ".superpowers/design/final-queue/feedback/003.png",
            canvas: "final-queue",
            file: "003.png",
            board: "Main.dc.html",
            note: "The chip crowds the Final label",
        });
    });

    it("a mark sent with no note has none", () => {
        const line = "look at .superpowers/design/final-queue/feedback/004.png — mark on States.dc.html: (no note)";
        expect(entryRowView(user(line, T), [], null)).toMatchObject({
            kind: "mark",
            board: "States.dc.html",
            note: null,
        });
    });

    it("anything else is no row", () => {
        expect(entryRowView(user("Let's think it through", T), [rec({})], FILE)).toBeNull();
        expect(entryRowView(user("brainstorm: check", T), [], FILE)).toBeNull();
        expect(entryRowView({ kind: "message", text: "Both" }, [rec({})], FILE)).toBeNull();
        expect(entryRowView(user("Both", T), [], null)).toBeNull();
    });
});
