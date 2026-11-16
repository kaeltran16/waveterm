// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { AgentActionEntry } from "./agentsviewmodel";
import { dagActionOf, dagRunIds, type DagAnswerCard } from "./dagactioncards";
import { parseWshCalls, wshKey, type WshCall, type WshCardKey } from "./wshcall";

const callOf = (command: string): { call: WshCall; key: WshCardKey } => {
    const call = parseWshCalls(command)[0];
    return { call, key: wshKey(call) as WshCardKey };
};

const action = (command: string, ts?: number): AgentActionEntry => ({
    kind: "action",
    verb: "ran",
    target: command,
    command,
    ts,
});

const event = (kind: string, ts: number, detail: object): RunEvent => ({
    id: `${kind}-${ts}`,
    runid: "run-1",
    channelid: "ch-1",
    ts,
    kind,
    detail: JSON.stringify(detail),
});

describe("dagActionOf rows", () => {
    it("tell carries its quoted text", () => {
        const { call, key } = callOf(`wsh jarvis dag tell t-3 "import add, don't copy it"`);
        expect(dagActionOf(key, call, action(""), [])).toMatchObject({
            kind: "row",
            icon: "tell",
            taskId: "t-3",
            text: "import add, don't copy it",
            quoted: true,
        });
    });

    it("amend carries its note", () => {
        const { call, key } = callOf(`wsh jarvis dag amend t-4 "Files now include run.go"`);
        expect(dagActionOf(key, call, action(""), [])).toMatchObject({
            kind: "row",
            icon: "amend",
            taskId: "t-4",
            text: "Files now include run.go",
        });
    });

    it("retry, skip and a plain merge name only the task", () => {
        for (const [verb, icon] of [
            ["retry", "retry"],
            ["skip", "skip"],
            ["merge", "merge"],
        ] as const) {
            const { call, key } = callOf(`wsh jarvis dag ${verb} t-5`);
            const model = dagActionOf(key, call, action(""), []);
            expect(model).toMatchObject({ kind: "row", icon, taskId: "t-5" });
            expect(model).not.toHaveProperty("text");
        }
    });

    it("a continued merge says so, whatever its flag position", () => {
        const { call, key } = callOf(`wsh jarvis dag merge --continue t-6`);
        expect(dagActionOf(key, call, action(""), [])).toMatchObject({ icon: "merge", taskId: "t-6", continued: true });
    });

    it("sendback carries its guidance, and has none without it", () => {
        const withNote = callOf(`wsh jarvis dag sendback t-2 "cover the empty case"`);
        expect(dagActionOf(withNote.key, withNote.call, action(""), [])).toMatchObject({
            icon: "sendback",
            taskId: "t-2",
            text: "cover the empty case",
        });
        const bare = callOf(`wsh jarvis dag sendback t-2`);
        expect(dagActionOf(bare.key, bare.call, action(""), [])).not.toHaveProperty("text");
    });

    it("escalate reads the model and runtime from its flags", () => {
        const { call, key } = callOf(`wsh jarvis dag escalate t-7 --model opus --runtime claude`);
        expect(dagActionOf(key, call, action(""), [])).toMatchObject({
            icon: "escalate",
            taskId: "t-7",
            model: "opus",
            runtime: "claude",
        });
    });

    it("escalate prefers the engine's task-escalated row for that task nearest the call", () => {
        const { call, key } = callOf(`wsh jarvis dag escalate t-7 --model opus`);
        const events = [
            event("task-escalated", 9_000, { taskid: "t-7", model: "sonnet", runtime: "pi" }),
            event("task-escalated", 5_100, { taskid: "t-7", model: "opus", runtime: "claude" }),
            event("task-escalated", 5_000, { taskid: "t-8", model: "haiku", runtime: "claude" }),
        ];
        expect(dagActionOf(key, call, action("", 5_000), events)).toMatchObject({ model: "opus", runtime: "claude" });
    });

    it("escalate with a task's row absent falls back to its flags", () => {
        const { call, key } = callOf(`wsh jarvis dag escalate t-7 --model opus`);
        const events = [event("task-escalated", 5_000, { taskid: "t-8", model: "haiku", runtime: "claude" })];
        expect(dagActionOf(key, call, action("", 5_000), events)).toMatchObject({ model: "opus" });
    });

    it("forward is its own card, with the note as body", () => {
        const { call, key } = callOf(`wsh jarvis dag forward t-4 "scope call: store the new x/y?"`);
        expect(dagActionOf(key, call, action(""), [])).toEqual({
            kind: "forward",
            taskId: "t-4",
            note: "scope call: store the new x/y?",
        });
    });

    it("a call with no task id still yields a model", () => {
        const { call, key } = callOf(`wsh jarvis dag retry`);
        expect(dagActionOf(key, call, action(""), [])).toMatchObject({ kind: "row", taskId: "" });
    });
});

describe("answer card", () => {
    const ask = (ts: number, detail: object) => event("child-ask", ts, { taskid: "t-4", ...detail });
    const answerCall = (answers: string) => callOf(`wsh jarvis dag answer t-4 '${answers}'`);

    it("matches the task's child-ask event and marks the picked option", () => {
        const { call, key } = answerCall(`[{"selectedindexes":[0]}]`);
        const events = [
            ask(1_000, {
                label: "truncate",
                header: "Suffix",
                question: "Ellipsis or three dots?",
                options: [
                    { label: "ellipsis", description: "one character" },
                    { label: "dots", description: "ascii" },
                ],
            }),
        ];
        const model = dagActionOf(key, call, action("", 2_000), events);
        expect(model).toMatchObject({
            kind: "answer",
            taskId: "t-4",
            label: "truncate",
            header: "Suffix",
            question: "Ellipsis or three dots?",
        });
        const card = model as DagAnswerCard;
        expect(card.options.map((o) => o.picked)).toEqual([true, false]);
        expect(card.options.map((o) => o.label)).toEqual(["ellipsis", "dots"]);
        expect(card.extra).toEqual([]);
    });

    it("takes the latest child-ask for the task at or before the call, ignoring other tasks", () => {
        const { call, key } = answerCall(`[{"selectedindexes":[1]}]`);
        const events = [
            event("child-ask", 4_000, { taskid: "t-9", question: "other task" }),
            ask(3_000, { question: "later", options: [{ label: "a" }, { label: "b" }] }),
            ask(1_000, { question: "earlier", options: [{ label: "a" }] }),
            ask(9_000, { question: "after the call" }),
        ];
        const model = dagActionOf(key, call, action("", 3_500), events) as DagAnswerCard;
        expect(model.question).toBe("later");
        expect(model.options.map((o) => o.picked)).toEqual([false, true]);
    });

    it("an event row that carries only the question still draws it, with the picked indexes beside", () => {
        const { call, key } = answerCall(`[{"selectedindexes":[1]}]`);
        const model = dagActionOf(key, call, action("", 2_000), [ask(1_000, { question: "which?" })]);
        expect(model).toMatchObject({ kind: "answer", question: "which?", options: [], extra: [{ picked: [1] }] });
    });

    it("with no event it shows the answers alone", () => {
        const { call, key } = answerCall(`[{"selectedindexes":[0,2]},{"text":"keep both"}]`);
        const model = dagActionOf(key, call, action("", 2_000), []);
        expect(model).toEqual({
            kind: "answer",
            taskId: "t-4",
            options: [],
            extra: [{ picked: [0, 2] }, { text: "keep both" }],
        });
    });

    it("free text beside known options is listed apart from them", () => {
        const { call, key } = answerCall(`[{"text":"neither: use a tilde"}]`);
        const events = [ask(1_000, { question: "which?", options: [{ label: "a" }, { label: "b" }] })];
        const model = dagActionOf(key, call, action("", 2_000), events) as DagAnswerCard;
        expect(model.options.map((o) => o.picked)).toEqual([false, false]);
        expect(model.extra).toEqual([{ text: "neither: use a tilde" }]);
    });

    it("malformed answers json leaves the card with no answers, not a throw", () => {
        const { call, key } = answerCall(`not json`);
        const model = dagActionOf(key, call, action("", 2_000), []);
        expect(model).toMatchObject({ kind: "answer", taskId: "t-4", options: [], extra: [] });
    });

    it("a malformed event detail is ignored", () => {
        const { call, key } = answerCall(`[{"selectedindexes":[0]}]`);
        const bad = { id: "x", runid: "r", channelid: "c", ts: 1, kind: "child-ask", detail: "{oops" } as RunEvent;
        expect(dagActionOf(key, call, action("", 2_000), [bad])).toMatchObject({ kind: "answer", options: [] });
    });
});

describe("dagRunIds", () => {
    it("takes explicit flags first", () => {
        const { call } = callOf(`wsh jarvis dag retry t-1 --channel ch-9 --runid run-9`);
        expect(dagRunIds(call, { channelId: "ch-1", role: { kind: "lead", runId: "run-1" } })).toEqual({
            channelId: "ch-9",
            runId: "run-9",
        });
    });

    it("falls back to the host's lead or its task's lead run", () => {
        const { call } = callOf(`wsh jarvis dag retry t-1`);
        expect(dagRunIds(call, { channelId: "ch-1", role: { kind: "lead", runId: "run-1" } })).toEqual({
            channelId: "ch-1",
            runId: "run-1",
        });
        expect(
            dagRunIds(call, { channelId: "ch-1", role: { kind: "worker", leadRunId: "run-2", taskId: "t-1" } })
        ).toEqual({
            channelId: "ch-1",
            runId: "run-2",
        });
    });

    it("is empty when nothing says which run", () => {
        const { call } = callOf(`wsh jarvis dag retry t-1`);
        expect(dagRunIds(call, {})).toEqual({});
    });
});
