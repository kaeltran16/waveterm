// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentVM } from "./agentsviewmodel";
import type { BrainstormFile, BrainstormQuestion } from "./brainstormmodel";
import { sendBrainstorm } from "./brainstormsend";
import { attachBrainstorm, brainstormAnswersAtom, brainstormsAtom, updateBrainstorm } from "./brainstormstore";
import {
    AGENT_PICK,
    JUDGE_PICK,
    judgeStartMs,
    judgeStatus,
    picksHint,
    questionActions,
    questionRows,
    startedRow,
} from "./renderedbsquestionmodel";

const APPROACHES = [
    { name: "One Final at a time", description: "queue final-verifies across runs", facts: [] },
    { name: "Memory gate", description: "hold new scenario runs while the OS reports low memory", facts: [] },
    { name: "Shared node_modules", description: "one install for every verify tree", facts: [] },
    { name: "Lower parallelism", description: "cap the run's width at 3", facts: [] },
    { name: "Sonnet workers", description: "smaller model, smaller sessions", facts: [] },
];
const OPTIONS = [
    { label: "One Final at a time", detail: "one queue removes the peak", pick: true },
    { label: "Memory gate", detail: "hold new runs on low memory" },
    { label: "Shared node_modules", detail: "one install for every tree" },
];
const DROPPED = [
    { name: "Lower parallelism", reason: "width barely moves wall time" },
    { name: "Sonnet workers", reason: "the A/B kept Opus for quality" },
];
const Q3: BrainstormQuestion = {
    n: 3,
    text: "How should a run keep its memory under the machine's limit?",
    part: "approach",
    approaches: APPROACHES,
};
const JUDGED: BrainstormQuestion = { ...Q3, options: OPTIONS, judge: { kind: "weighed", added: [], dropped: DROPPED } };
const FAILED: BrainstormQuestion = {
    ...Q3,
    options: OPTIONS,
    judge: { kind: "failed", reason: "Arc restarted before the judge started." },
};

const PARTS = ["what", "who", "approach", "queue", "banner"].map((id) => ({
    id,
    title: id,
    state: "open" as const,
    body: "",
}));
const FILE: BrainstormFile = {
    v: 1,
    title: "Run memory pressure",
    spec: "docs/specs/mem.md",
    question: { n: 1, text: "Which runs does this need to protect?", part: "what", options: OPTIONS.slice(0, 2) },
    working: null,
    parts: PARTS,
    history: [],
    done: false,
    check: null,
    run: null,
};

describe("questionRows", () => {
    it("while the judge weighs, the approaches are the rows, unbadged and unranked", () => {
        const r = questionRows(Q3, true);
        expect(r.options.map((o) => [o.label, o.detail])).toEqual(APPROACHES.map((a) => [a.name, a.description]));
        expect(r.options.map((_, i) => [r.badge(i), r.note(i)])).toEqual(APPROACHES.map(() => [null, null]));
        expect(r.work).toBeNull();
        expect(r.state).toBe("judging");
    });

    it("a weighed question badges the judge's pick, ranks the kept options after it and lists the dropped", () => {
        const r = questionRows(JUDGED, false);
        expect(r.state).toBe("judged");
        expect(r.options.map((o) => o.label)).toEqual(["One Final at a time", "Memory gate", "Shared node_modules"]);
        expect([0, 1, 2].map(r.badge)).toEqual([JUDGE_PICK, null, null]);
        expect([0, 1, 2].map(r.note)).toEqual([null, "kept as the second option", "kept as the third option"]);
        expect(r.work?.dropped).toEqual(DROPPED);
        expect(r.work?.line).toBe("weighed the 5 approaches the agent listed, added none, dropped 2.");
    });

    it("the ranking counts the pick first wherever it sits", () => {
        const picked2 = OPTIONS.map((o, i) => ({ ...o, pick: i === 1 }));
        const r = questionRows({ ...JUDGED, options: picked2 }, false);
        expect([0, 1, 2].map(r.note)).toEqual(["kept as the second option", null, "kept as the third option"]);
    });

    it("a failed judge leaves the agent's pick and says why, ranking nothing", () => {
        const r = questionRows(FAILED, false);
        expect(r.state).toBe("failed");
        expect([0, 1, 2].map(r.badge)).toEqual([AGENT_PICK, null, null]);
        expect([0, 1, 2].map(r.note)).toEqual([null, null, null]);
        expect(r.work?.line).toBe(
            "the judge failed, so the read and pick are the agent’s: Arc restarted before the judge started."
        );
    });

    it("a plain question with the agent's pick badges it as the agent's; no options draws no rows", () => {
        const r = questionRows({ n: 2, text: "q", part: "who", options: OPTIONS }, false);
        expect(r.state).toBe("plain");
        expect(r.badge(0)).toBe(AGENT_PICK);
        expect(questionRows({ n: 5, text: "q", part: "banner" }, false).options).toEqual([]);
    });
});

describe("picksHint", () => {
    it("counts the rows, or sends the answer to the box when there are none", () => {
        expect(picksHint(3)).toBe("1–3 picks · or type your own answer below");
        expect(picksHint(1)).toBe("1 pick · or type your own answer below");
        expect(picksHint(0)).toBe("answer in the box below");
    });
});

describe("questionActions", () => {
    it("offers Guess for me on question 1 too, and Skip, in the talk phase", () => {
        expect(questionActions(FILE, false)).toEqual({ guess: true, skip: true });
    });

    it("leaves Guess for me out while the judge weighs", () => {
        expect(questionActions({ ...FILE, question: Q3 }, true)).toEqual({ guess: false, skip: true });
    });

    it("leaves Skip out in the builder check, and both out for a question about no part", () => {
        const check = { yours: [], calls: [], answered: [] };
        expect(questionActions({ ...FILE, check }, false)).toEqual({ guess: true, skip: false });
        expect(questionActions({ ...FILE, question: { n: 2, text: "q", part: "" } }, false)).toEqual({
            guess: false,
            skip: false,
        });
    });
});

describe("judgeStatus and judgeStartMs", () => {
    it("names how many approaches the judge weighs", () => {
        expect(judgeStatus(Q3)).toBe("The judge is weighing 5 approaches");
        expect(judgeStatus({ ...Q3, approaches: APPROACHES.slice(0, 1) })).toBe("The judge is weighing 1 approach");
    });

    it("times the judge from Arc's reading record, else from when the file asked for it", () => {
        expect(judgeStartMs({ state: "reading", ts: 1000 }, 5000)).toBe(1000);
        expect(judgeStartMs({ state: "answered", ts: 1000 }, 5000)).toBe(5000);
        expect(judgeStartMs(undefined, 5000)).toBe(5000);
        expect(judgeStartMs(undefined, null)).toBeNull();
    });
});

describe("startedRow", () => {
    it("draws above question 1 while nothing is answered, with the decisions to talk through", () => {
        expect(startedRow(FILE)).toEqual({ decisions: "5 decisions to talk through" });
        expect(startedRow({ ...FILE, parts: PARTS.slice(0, 1) })).toEqual({ decisions: "1 decision to talk through" });
    });

    it("is gone once the history has an entry", () => {
        const history = [{ kind: "question" as const, n: 1, q: "q", a: "a", into: ["what"] }];
        expect(startedRow({ ...FILE, history })).toBeNull();
    });
});

describe("picking a row from the card", () => {
    const AGENT = { id: "a1", name: "mem", blockId: "blk-1", project: "arc" } as AgentVM;
    const PATH = "/p/.superpowers/brainstorm/mem/brainstorm.json";
    const fakeIO = () => {
        const sent: string[] = [];
        const stops: string[] = [];
        return {
            sent,
            stops,
            prompt: async (_b: string, text: string) => void sent.push(text),
            stopJudge: async (b: string) => void stops.push(b),
        };
    };

    beforeEach(() => attachBrainstorm(AGENT.id, { topic: "mem", cwd: "/p" }, 0));
    afterEach(() => {
        globalStore.set(brainstormsAtom, {});
        globalStore.set(brainstormAnswersAtom, {});
    });

    it("option 2 sends the line the pane sends for it, recorded as picked here", async () => {
        updateBrainstorm(AGENT.id, (s) => ({ ...s, file: { ...FILE, question: JUDGED } }));
        const io = fakeIO();
        const row = questionRows(JUDGED, false).options[1];
        await sendBrainstorm(AGENT, { kind: "answer", text: row.label }, io, 1000, "transcript");
        expect(io.sent).toEqual(["Memory gate"]);
        expect(globalStore.get(brainstormAnswersAtom)[PATH]).toEqual([
            { line: "Memory gate", question: 3, builder: null, answer: "Memory gate", origin: "transcript", at: 1000 },
        ]);
    });

    it("an approach picked while the judge weighs stops the judge and sends the approach's name", async () => {
        const judging = { ...FILE, question: Q3, working: "The judge is weighing 5 approaches." };
        updateBrainstorm(AGENT.id, (s) => ({ ...s, file: judging }));
        const io = fakeIO();
        const row = questionRows(Q3, true).options[1];
        await sendBrainstorm(AGENT, { kind: "answer", text: row.label }, io, 1000, "transcript");
        expect(io.stops).toEqual(["blk-1"]);
        expect(io.sent).toEqual(["Memory gate"]);
    });
});
