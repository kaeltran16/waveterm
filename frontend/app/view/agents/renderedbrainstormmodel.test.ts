// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { BrainstormFile, BrainstormPart, BuilderCheckView } from "./brainstormmodel";
import type { BrainstormState } from "./brainstormstore";
import { cardStatus, renderedCard } from "./renderedbrainstormmodel";

const NONE: BuilderCheckView = { kind: "none" };
const READING: BuilderCheckView = { kind: "pending", stage: "reading", text: "A builder is reading the design." };
const TAKING_IN: BuilderCheckView = { kind: "pending", stage: "taking-in", text: "Taking in the builder's questions." };
const FAILED: BuilderCheckView = {
    kind: "failed",
    reason: "The agent ended its turn without starting the builder check.",
};

const part = (id: string, state: BrainstormPart["state"], over: Partial<BrainstormPart> = {}): BrainstormPart => ({
    id,
    title: id,
    state,
    body: `${id} body`,
    ...over,
});

const YOURS5 = ["counts", "signal", "approach", "queue", "banner"].map((id) => part(id, "yours"));

const BASE: BrainstormFile = {
    v: 1,
    title: "Run memory pressure",
    spec: "docs/superpowers/specs/2026-11-17-run-memory-pressure-design.md",
    canvas: "run-memory-pressure",
    question: null,
    working: null,
    parts: YOURS5,
    history: [],
    done: false,
    check: null,
    run: null,
};

const file = (over: Partial<BrainstormFile>): BrainstormFile => ({ ...BASE, ...over });

const state = (f: BrainstormFile | null, over: Partial<BrainstormState> = {}): BrainstormState => ({
    topic: "run-memory-pressure",
    path: "/p/.superpowers/brainstorm/run-memory-pressure/brainstorm.json",
    cwd: "/p",
    mode: "terminal",
    file: f,
    error: null,
    failedReads: 0,
    removed: false,
    missedStats: 0,
    modifiedMs: 1000,
    lastViewedMs: 0,
    designOpen: false,
    historyOpen: false,
    boards: [],
    base: null,
    sent: null,
    picks: {},
    sentCheckAt: null,
    review: { cursor: null, open: {} },
    ...over,
});

const OPTIONS = [
    { label: "Runs with a Final", detail: "the case that failed" },
    { label: "Every run", detail: "workers and Finals alike" },
];
const APPROACHES = [1, 2, 3, 4, 5].map((i) => ({ name: `Approach ${i}`, description: "", facts: [] }));
const HISTORY = [
    { kind: "question" as const, n: 1, q: "Which runs?", a: "Runs with a Final", into: ["counts"] },
    { kind: "question" as const, n: 2, q: "Which signal?", a: "The OS signal", into: ["signal"] },
];

// one file per board, in the state the board draws
const FIRST_QUESTION = file({
    question: { n: 1, text: "Which runs does this need to protect?", part: "counts", options: OPTIONS },
    parts: YOURS5.map((p) => ({ ...p, state: "open" as const })),
});
const MAIN = file({
    question: { n: 4, text: "Should a verify waiting show in the graph?", part: "queue", options: OPTIONS },
    parts: [...YOURS5.slice(0, 3), part("queue", "asked"), part("banner", "open")],
    history: HISTORY,
});
const ANSWERED = file({
    question: { n: 5, text: "What should the banner say?", part: "banner" },
    parts: [...YOURS5.slice(0, 4), part("banner", "asked")],
    history: HISTORY,
});
const JUDGE_PICK = file({
    question: {
        n: 3,
        text: "How should a run keep its memory under the limit?",
        part: "approach",
        options: [{ ...OPTIONS[0], pick: true }, OPTIONS[1]],
        judge: { kind: "weighed", added: [], dropped: [{ name: "Approach 5", reason: "too slow" }] },
    },
    parts: [...YOURS5.slice(0, 2), part("approach", "asked"), part("queue", "open"), part("banner", "open")],
});
const JUDGE_FAILED = file({
    question: { ...JUDGE_PICK.question!, judge: { kind: "failed", reason: "the judge timed out" } },
    parts: JUDGE_PICK.parts,
});
const JUDGING = file({
    working: "The judge is weighing 5 approaches.",
    question: {
        n: 3,
        text: "How should a run keep its memory under the limit?",
        part: "approach",
        approaches: APPROACHES,
    },
    parts: JUDGE_PICK.parts,
});
const WORKING = file({ working: "Writing “Final queue” from your answer.", parts: MAIN.parts, history: HISTORY });
const DESIGN_READY = file({
    done: true,
    parts: [...YOURS5.slice(0, 3), part("queue", "guess"), part("banner", "guess")],
    history: HISTORY,
});
const KEEP_TALKING = file({
    parts: [...YOURS5.slice(0, 4), part("banner", "guess", { was: "the old banner line" })],
    history: HISTORY,
});
const READY = file({ done: true, history: HISTORY });
const CHECK = { yours: [], calls: [], answered: [] };
const QUESTIONS_BACK = file({
    done: true,
    history: HISTORY,
    check: { ...CHECK, yours: [{ q: "Does queued time count toward wall time?", options: OPTIONS }] },
});
const SETTLED = file({
    done: true,
    history: HISTORY,
    check: { ...CHECK, yours: [{ q: "Does queued time count toward wall time?", a: "Yes" }] },
});
const CHECK_REVIEW = file({
    done: true,
    history: HISTORY,
    parts: [...YOURS5.slice(0, 3), part("queue", "guess", { was: "the old queue" }), YOURS5[4]],
    check: SETTLED.check,
});
const CHECK_GUESS = file({
    done: true,
    history: HISTORY,
    parts: [...YOURS5.slice(0, 4), part("banner", "guess")],
    check: SETTLED.check,
});
const RUN_STEP = file({ done: true, check: SETTLED.check, run: "3f9a1c2e-0000-4000-8000-000000000000" });

describe("renderedCard", () => {
    it.each([
        ["FirstQuestion", FIRST_QUESTION],
        ["Main", MAIN],
        ["Answered", ANSWERED],
        ["JudgePick", JUDGE_PICK],
        ["JudgeFailed", JUDGE_FAILED],
    ])("%s draws the question card", (_board, f) => {
        expect(renderedCard(state(f), NONE)).toEqual({ kind: "question", judging: false });
    });

    it("Judging draws the question card, judging", () => {
        expect(renderedCard(state(JUDGING), NONE)).toEqual({ kind: "question", judging: true });
    });

    it("Working draws no card", () => {
        expect(renderedCard(state(WORKING), NONE)).toEqual({ kind: "none" });
    });

    it("an answer sent and not yet taken reads as the agent working", () => {
        const sent = { at: 2000, modifiedMs: 1000, kind: "answer" as const };
        expect(renderedCard(state(MAIN, { sent }), NONE)).toEqual({ kind: "none" });
    });

    it.each([
        ["DesignReady", DESIGN_READY],
        ["KeepTalking", KEEP_TALKING],
        ["every decision yours, before the check", READY],
    ])("%s draws the design card", (_board, f) => {
        expect(renderedCard(state(f), NONE)).toEqual({ kind: "design" });
    });

    it.each([
        ["reading", READY, READING],
        ["taking in the builder's questions", READY, TAKING_IN],
        ["the check failed", READY, FAILED],
        ["questions back, one for you", QUESTIONS_BACK, NONE],
        ["settled, the approve bar", SETTLED, NONE],
    ])("BuilderCheck/CheckStates %s draws the check card", (_what, f, check) => {
        expect(renderedCard(state(f), check)).toEqual({ kind: "check" });
    });

    it("a pending check gives way to an open talk question", () => {
        expect(renderedCard(state(MAIN), READING)).toEqual({ kind: "question", judging: false });
    });

    it("in the check, a talk question open draws the question card", () => {
        const f = { ...SETTLED, question: MAIN.question };
        expect(renderedCard(state(f), NONE)).toEqual({ kind: "question", judging: false });
    });

    it("CheckReview, a change waiting on Keep or Put back, draws the review card", () => {
        expect(renderedCard(state(CHECK_REVIEW), NONE)).toEqual({ kind: "review" });
    });

    it("in the check, a guess waiting to be confirmed with no change pending draws the design card", () => {
        expect(renderedCard(state(CHECK_GUESS), NONE)).toEqual({ kind: "design" });
    });

    it("in the check, the agent working draws no card", () => {
        expect(renderedCard(state({ ...SETTLED, working: "Taking in your change." }), NONE)).toEqual({ kind: "none" });
    });

    it("RunStep draws no card: the run is a row, its state in the workspace pane", () => {
        expect(renderedCard(state(RUN_STEP), NONE)).toEqual({ kind: "none" });
    });

    it("Gone: a removed brainstorm draws the gone card, removed, its last good file kept", () => {
        expect(renderedCard(state(MAIN, { removed: true }), NONE)).toEqual({ kind: "gone", why: "removed" });
    });

    it("Gone: a file that never parsed draws the gone card, unreadable", () => {
        const s = state(null, { error: "Unexpected end of JSON input" });
        expect(renderedCard(s, NONE)).toEqual({ kind: "gone", why: "unreadable" });
    });

    it("a read error over a last good file keeps drawing that file", () => {
        expect(renderedCard(state(MAIN, { error: "bad json" }), NONE)).toEqual({ kind: "question", judging: false });
    });

    it("no brainstorm, or no file read yet, draws nothing", () => {
        expect(renderedCard(null, NONE)).toEqual({ kind: "none" });
        expect(renderedCard(state(null), NONE)).toEqual({ kind: "none" });
    });
});

describe("cardStatus", () => {
    it("talking it through reads the parts yours of the drawn decisions", () => {
        expect(cardStatus(MAIN)).toBe("Talking it through · 3 of 5 yours");
        expect(cardStatus(FIRST_QUESTION)).toBe("Talking it through · 0 of 5 yours");
    });

    it("the builder check reads as checking with a builder", () => {
        expect(cardStatus(CHECK_REVIEW)).toBe("Checking with a builder");
    });

    it("a run has no status: its card heads itself", () => {
        expect(cardStatus(RUN_STEP)).toBe("");
    });
});
