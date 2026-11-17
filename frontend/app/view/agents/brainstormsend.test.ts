// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { toastsAtom } from "@/app/cockpit/notificationstore";
import { globalStore } from "@/app/store/jotaiStore";
import { newRunPrefillAtom } from "@/app/view/jarvis/newruncontrol";
import { atom } from "jotai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentsViewModel } from "./agents";
import type { AgentVM } from "./agentsviewmodel";
import { brainstormLine, runPrefill, type BrainstormAction, type BrainstormFile } from "./brainstormmodel";
import { approveAndOpenRun, openRunLauncher, pickPart, reportSendFailure, sendBrainstorm } from "./brainstormsend";
import {
    attachBrainstorm,
    brainstormAnswersAtom,
    brainstormsAtom,
    getBrainstorm,
    shownPicks,
    updateBrainstorm,
    type BrainstormState,
} from "./brainstormstore";

const AGENT = { id: "a1", name: "lag-alerts", blockId: "blk-1", project: "siem" } as AgentVM;

const FILE: BrainstormFile = {
    v: 1,
    title: "Consumer lag alerts",
    spec: "docs/specs/lag.md",
    canvas: "lag",
    question: null,
    working: null,
    parts: [{ id: "page", title: "What on-call sees", state: "yours", body: "b", boards: ["Page.dc.html"] }],
    history: [],
    done: true,
    check: null,
    run: null,
};

const STATE = {
    topic: "lag",
    path: "/p/.superpowers/brainstorm/lag/brainstorm.json",
    cwd: "/p",
    file: FILE,
} as BrainstormState;

// the judge weighing an approach question: the file works while the question lists its approaches
const WAIT: BrainstormFile = {
    ...FILE,
    done: false,
    working: "The judge is weighing 2 approaches.",
    question: {
        n: 2,
        text: "How should alerts reach on-call?",
        part: "page",
        approaches: [
            { name: "Page directly", description: "", facts: [] },
            { name: "Via the channel", description: "", facts: [] },
        ],
    },
};

// calls holds every call in order, so a stop can be seen to come before the prompt
function fakeIO(fail = false, stopFails = false) {
    const sent: [string, string][] = [];
    const calls: string[] = [];
    return {
        sent,
        calls,
        prompt: async (blockId: string, text: string) => {
            if (fail) {
                throw new Error("boom");
            }
            calls.push(`prompt ${blockId}`);
            sent.push([blockId, text]);
        },
        stopJudge: async (blockId: string) => {
            if (stopFails) {
                throw new Error("no such tab");
            }
            calls.push(`stop ${blockId}`);
        },
    };
}

function fakeModel(): AgentsViewModel {
    return { newRunOpenAtom: atom(false) } as unknown as AgentsViewModel;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
    attachBrainstorm(AGENT.id, { topic: "lag", cwd: "/p" }, 0);
    updateBrainstorm(AGENT.id, (s) => ({ ...s, modifiedMs: 500 }));
});

afterEach(() => {
    globalStore.set(newRunPrefillAtom, null);
    globalStore.set(brainstormsAtom, {});
    globalStore.set(brainstormAnswersAtom, {});
    globalStore.set(toastsAtom, []);
});

// a change and a guess waiting on the user, beside a yours part
const REVIEW: BrainstormFile = {
    ...FILE,
    done: true,
    parts: [
        { id: "grain", title: "Grain", state: "guess", body: "daily", was: "hourly" },
        { id: "torch", title: "Torch", state: "guess", body: "on" },
        { id: "page", title: "Page", state: "yours", body: "b" },
    ],
};

describe("pickPart", () => {
    beforeEach(() => updateBrainstorm(AGENT.id, (s) => ({ ...s, file: REVIEW })));

    it("holds a pick in the pane and sends nothing while a decision is left", async () => {
        const io = fakeIO();
        await pickPart(AGENT, "grain", "restore", io);
        expect(getBrainstorm(AGENT.id)?.picks).toEqual({ grain: "restore" });
        expect(io.sent).toEqual([]);
        await pickPart(AGENT, "grain", "restore", io);
        expect(getBrainstorm(AGENT.id)?.picks).toEqual({});
    });

    it("the pick that leaves nothing to settle sends them all as one line", async () => {
        const io = fakeIO();
        await pickPart(AGENT, "torch", "confirm", io, 1000);
        await pickPart(AGENT, "grain", "keep", io, 2000);
        expect(io.sent).toEqual([["blk-1", "brainstorm: settle keep grain; confirm torch"]]);
        const s = getBrainstorm(AGENT.id)!;
        expect(s.picks).toEqual({});
        expect(s.sent).toEqual({ at: 2000, modifiedMs: 500, kind: "line", picks: { grain: "keep", torch: "confirm" } });
        expect(shownPicks(s)).toEqual({ grain: "keep", torch: "confirm" });
    });

    it("a failed send keeps the picks, to send again", async () => {
        await pickPart(AGENT, "torch", "confirm", fakeIO(true));
        await expect(pickPart(AGENT, "grain", "keep", fakeIO(true))).rejects.toThrow("Couldn't send");
        expect(getBrainstorm(AGENT.id)?.picks).toEqual({ torch: "confirm", grain: "keep" });
        expect(getBrainstorm(AGENT.id)?.sent).toBeNull();
    });

    it("sends nothing while the agent writes", async () => {
        updateBrainstorm(AGENT.id, (s) => ({ ...s, file: { ...REVIEW, working: "Rewriting the grain" } }));
        const io = fakeIO();
        await pickPart(AGENT, "torch", "confirm", io);
        await pickPart(AGENT, "grain", "keep", io);
        expect(io.sent).toEqual([]);
    });
});

describe("sendBrainstorm", () => {
    const actions: BrainstormAction[] = [
        { kind: "answer", text: "first line\n\tsecond  line" },
        { kind: "guess" },
        { kind: "skip" },
        { kind: "confirm-all" },
        { kind: "edit", part: "constraints", text: "No new\nservice." },
        { kind: "keep-all" },
        { kind: "check" },
        { kind: "builder-answer", text: "Only report." },
        { kind: "approved" },
        { kind: "keep-talking" },
        { kind: "run", runId: "r1" },
    ];

    it.each(actions)("sends the $kind line to the agent's block as a prompt", async (action) => {
        const io = fakeIO();
        await sendBrainstorm(AGENT, action, io);
        expect(io.sent).toEqual([["blk-1", brainstormLine(action)]]);
    });

    it("a line sent with picks waiting carries them, and clears them", async () => {
        updateBrainstorm(AGENT.id, (s) => ({ ...s, file: REVIEW, picks: { grain: "restore" } }));
        const io = fakeIO();
        await sendBrainstorm(AGENT, { kind: "answer", text: "why daily?" }, io, 1000);
        expect(io.sent).toEqual([["blk-1", "brainstorm: settle restore grain; then: why daily?"]]);
        expect(getBrainstorm(AGENT.id)?.picks).toEqual({});
        expect(getBrainstorm(AGENT.id)?.sent?.picks).toEqual({ grain: "restore" });
    });

    it("Send with no picks waiting has nothing to send", async () => {
        updateBrainstorm(AGENT.id, (s) => ({ ...s, file: REVIEW }));
        await expect(sendBrainstorm(AGENT, { kind: "settle" }, fakeIO())).rejects.toThrow("Nothing to send");
    });

    it("sends a multi-line answer as one line", async () => {
        const io = fakeIO();
        await sendBrainstorm(AGENT, { kind: "answer", text: "  one\n\ntwo\tthree " }, io);
        expect(io.sent).toEqual([["blk-1", "one two three"]]);
    });

    it("records the sent line against the file as it was, an answer as an answer", async () => {
        await sendBrainstorm(AGENT, { kind: "answer", text: "yes" }, fakeIO(), 1000);
        expect(getBrainstorm(AGENT.id)?.sent).toEqual({ at: 1000, modifiedMs: 500, kind: "answer" });
        await sendBrainstorm(AGENT, { kind: "guess" }, fakeIO(), 2000);
        expect(getBrainstorm(AGENT.id)?.sent).toEqual({ at: 2000, modifiedMs: 500, kind: "line" });
        await sendBrainstorm(AGENT, { kind: "check" }, fakeIO(), 3000);
        expect(getBrainstorm(AGENT.id)?.sent).toEqual({ at: 3000, modifiedMs: 500, kind: "check" });
    });

    it("sends a line typed with no question open as the raw text, recorded as an answer", async () => {
        updateBrainstorm(AGENT.id, (s) => ({ ...s, file: FILE }));
        const io = fakeIO();
        await sendBrainstorm(AGENT, { kind: "answer", text: "why not use the\nclarify artifact?" }, io, 1000);
        expect(io.sent).toEqual([["blk-1", "why not use the clarify artifact?"]]);
        expect(getBrainstorm(AGENT.id)?.sent).toEqual({ at: 1000, modifiedMs: 500, kind: "answer" });
    });

    it("refuses a second check while the first is underway, sending nothing", async () => {
        updateBrainstorm(AGENT.id, (s) => ({ ...s, file: FILE }));
        await sendBrainstorm(AGENT, { kind: "check" }, fakeIO(), 1000);
        expect(getBrainstorm(AGENT.id)?.sent).toEqual({ at: 1000, modifiedMs: 500, kind: "check" });
        const io = fakeIO();
        await expect(sendBrainstorm(AGENT, { kind: "check" }, io, 2000)).rejects.toThrow("still working");
        expect(io.sent).toEqual([]);
        expect(getBrainstorm(AGENT.id)?.sent?.at).toBe(1000);
    });

    it.each([
        { kind: "answer", text: " \n\t " },
        { kind: "edit", part: "x", text: "" },
        { kind: "builder-answer", text: "\n" },
    ] as BrainstormAction[])("a blank $kind throws and sends nothing", async (action) => {
        const io = fakeIO();
        await expect(sendBrainstorm(AGENT, action, io)).rejects.toThrow("Nothing to send");
        expect(io.sent).toEqual([]);
        expect(getBrainstorm(AGENT.id)?.sent).toBeNull();
    });

    it("refuses an agent with no terminal", async () => {
        const io = fakeIO();
        await expect(sendBrainstorm({ ...AGENT, blockId: undefined }, { kind: "guess" }, io)).rejects.toThrow(
            "This agent has no terminal to send to"
        );
        expect(io.sent).toEqual([]);
    });

    it("names the agent when sending fails, and records nothing as sent", async () => {
        await expect(sendBrainstorm(AGENT, { kind: "guess" }, fakeIO(true))).rejects.toThrow(
            "Couldn't send to lag-alerts: boom"
        );
        expect(getBrainstorm(AGENT.id)?.sent).toBeNull();
    });

    describe("during the judge's wait", () => {
        beforeEach(() => updateBrainstorm(AGENT.id, (s) => ({ ...s, file: WAIT })));

        it.each([{ kind: "answer", text: "Page directly" }, { kind: "skip" }] as BrainstormAction[])(
            "a $kind stops the judge before it sends",
            async (action) => {
                const io = fakeIO();
                await sendBrainstorm(AGENT, action, io);
                expect(io.calls).toEqual(["stop blk-1", "prompt blk-1"]);
                expect(io.sent).toEqual([["blk-1", brainstormLine(action)]]);
            }
        );

        it("an edit leaves the judge running", async () => {
            const io = fakeIO();
            await sendBrainstorm(AGENT, { kind: "edit", part: "page", text: "x" }, io);
            expect(io.calls).toEqual(["prompt blk-1"]);
        });

        it("a stop that fails sends nothing, and says the judge could not be stopped", async () => {
            const io = fakeIO(false, true);
            await expect(sendBrainstorm(AGENT, { kind: "answer", text: "Page directly" }, io)).rejects.toThrow(
                /^Couldn't stop the judge: no such tab$/
            );
            expect(io.sent).toEqual([]);
            expect(getBrainstorm(AGENT.id)?.sent).toBeNull();
        });

        it("a line already pending ends the wait: the next answer does not stop the judge", async () => {
            const io = fakeIO();
            await sendBrainstorm(AGENT, { kind: "answer", text: "Page directly" }, io, 1000);
            await sendBrainstorm(AGENT, { kind: "answer", text: "Via the channel" }, io, 2000);
            expect(io.calls).toEqual(["stop blk-1", "prompt blk-1", "prompt blk-1"]);
        });
    });

    it.each([
        ["no question", FILE],
        ["working with no approaches", { ...WAIT, question: { ...WAIT.question!, approaches: undefined } }],
        ["approaches but nothing working", { ...WAIT, working: null }],
    ] as [string, BrainstormFile][])("outside the wait (%s) an answer does not stop the judge", async (_, f) => {
        updateBrainstorm(AGENT.id, (s) => ({ ...s, file: f }));
        const io = fakeIO();
        await sendBrainstorm(AGENT, { kind: "answer", text: "yes" }, io);
        expect(io.calls).toEqual(["prompt blk-1"]);
    });
});

describe("the answer record", () => {
    const PATH = "/p/.superpowers/brainstorm/lag/brainstorm.json";
    const records = () => globalStore.get(brainstormAnswersAtom)[PATH] ?? [];
    const ASKING: BrainstormFile = {
        ...REVIEW,
        done: false,
        question: { n: 4, text: "When should on-call get paged?", part: "page" },
    };
    const BUILDER_Q = "Should a page hold the autoscaler?";
    const BUILDER: BrainstormFile = { ...FILE, check: { yours: [{ q: BUILDER_Q }], calls: [], answered: [] } };

    it("an answer sent from the pane sends the same line as before and records origin pane", async () => {
        updateBrainstorm(AGENT.id, (s) => ({ ...s, file: ASKING }));
        const io = fakeIO();
        await sendBrainstorm(AGENT, { kind: "answer", text: "After 15\nminutes" }, io, 1000);
        expect(io.sent).toEqual([["blk-1", "After 15 minutes"]]);
        expect(records()).toEqual([
            {
                line: "After 15 minutes",
                question: 4,
                builder: null,
                answer: "After 15 minutes",
                origin: "pane",
                at: 1000,
            },
        ]);
    });

    it("one sent from the transcript records that origin and the exact line, carried picks included", async () => {
        updateBrainstorm(AGENT.id, (s) => ({ ...s, file: ASKING, picks: { grain: "keep" } }));
        const io = fakeIO();
        await sendBrainstorm(AGENT, { kind: "answer", text: "After 15 minutes" }, io, 2000, "transcript");
        const line = "brainstorm: settle keep grain; then: After 15 minutes";
        expect(io.sent).toEqual([["blk-1", line]]);
        expect(records()).toEqual([
            { line, question: 4, builder: null, answer: "After 15 minutes", origin: "transcript", at: 2000 },
        ]);
    });

    it("an answer to the builder's open question records that question's text", async () => {
        updateBrainstorm(AGENT.id, (s) => ({ ...s, file: BUILDER }));
        await sendBrainstorm(AGENT, { kind: "builder-answer", text: "Only report." }, fakeIO(), 3000, "transcript");
        expect(records()).toEqual([
            {
                line: "brainstorm: builder answer: Only report.",
                question: null,
                builder: BUILDER_Q,
                answer: "Only report.",
                origin: "transcript",
                at: 3000,
            },
        ]);
    });

    it("keeps every answer in send order", async () => {
        updateBrainstorm(AGENT.id, (s) => ({ ...s, file: ASKING }));
        await sendBrainstorm(AGENT, { kind: "answer", text: "one" }, fakeIO(), 1000, "transcript");
        updateBrainstorm(AGENT.id, (s) => ({
            ...s,
            sent: null,
            file: { ...ASKING, question: { ...ASKING.question!, n: 5 } },
        }));
        await sendBrainstorm(AGENT, { kind: "answer", text: "two" }, fakeIO(), 2000);
        expect(records().map((r) => [r.question, r.answer, r.origin])).toEqual([
            [4, "one", "transcript"],
            [5, "two", "pane"],
        ]);
    });

    it("a line with no question open, or that answers nothing, records nothing", async () => {
        updateBrainstorm(AGENT.id, (s) => ({ ...s, file: FILE }));
        await sendBrainstorm(AGENT, { kind: "answer", text: "why daily?" }, fakeIO(), 1000, "transcript");
        updateBrainstorm(AGENT.id, (s) => ({ ...s, sent: null, file: ASKING }));
        await sendBrainstorm(AGENT, { kind: "guess" }, fakeIO(), 2000, "transcript");
        expect(records()).toEqual([]);
    });

    it("a refused or failed send records nothing", async () => {
        updateBrainstorm(AGENT.id, (s) => ({ ...s, file: ASKING }));
        await expect(
            sendBrainstorm(AGENT, { kind: "answer", text: "x" }, fakeIO(true), 1000, "transcript")
        ).rejects.toThrow("Couldn't send");
        await expect(
            sendBrainstorm(AGENT, { kind: "answer", text: " " }, fakeIO(), 1000, "transcript")
        ).rejects.toThrow("Nothing to send");
        await expect(
            sendBrainstorm(
                { ...AGENT, blockId: undefined },
                { kind: "answer", text: "x" },
                fakeIO(),
                1000,
                "transcript"
            )
        ).rejects.toThrow("no terminal");
        expect(records()).toEqual([]);
    });
});

describe("approveAndOpenRun", () => {
    const unlinked = async () => ({});

    it("sends brainstorm: approved before it prefills and opens the launcher", async () => {
        const model = fakeModel();
        const seen: unknown[] = [];
        const io = {
            prompt: async (blockId: string, text: string) => {
                seen.push([blockId, text, globalStore.get(newRunPrefillAtom), globalStore.get(model.newRunOpenAtom)]);
            },
            stopJudge: async () => {},
        };
        await approveAndOpenRun(model, AGENT, STATE, io, unlinked);
        expect(seen).toEqual([["blk-1", "brainstorm: approved", null, false]]);
        expect(globalStore.get(newRunPrefillAtom)).toMatchObject(runPrefill(FILE, { projectName: "siem", cwd: "/p" }));
        expect(globalStore.get(model.newRunOpenAtom)).toBe(true);
    });

    it("leaves the launcher closed when the line cannot be sent", async () => {
        const model = fakeModel();
        const asked: unknown[] = [];
        const attach = async (data: CommandRunDesignAttachData) => {
            asked.push(data);
            return {};
        };
        await expect(approveAndOpenRun(model, AGENT, STATE, fakeIO(true), attach)).rejects.toThrow("Couldn't send to");
        expect(asked).toEqual([]);
        expect(globalStore.get(newRunPrefillAtom)).toBeNull();
        expect(globalStore.get(model.newRunOpenAtom)).toBe(false);
    });

    it("on a session a run waits on, hands the run the design and tells the agent its id, with no launcher", async () => {
        const model = fakeModel();
        const io = fakeIO();
        const asked: CommandRunDesignAttachData[] = [];
        const attach = async (data: CommandRunDesignAttachData) => {
            asked.push(data);
            return { channelid: "c1", runid: "run-7" };
        };
        await approveAndOpenRun(model, AGENT, STATE, io, attach);
        await flush();
        const { spec, prototype } = runPrefill(FILE, { projectName: "siem", cwd: "/p" });
        expect(asked).toEqual([{ blockid: "blk-1", spec, prototype }]);
        expect(io.sent).toEqual([
            ["blk-1", "brainstorm: approved"],
            ["blk-1", "brainstorm: run run-7"],
        ]);
        expect(globalStore.get(newRunPrefillAtom)).toBeNull();
        expect(globalStore.get(model.newRunOpenAtom)).toBe(false);
    });

    it("a refused attach throws and opens nothing", async () => {
        const model = fakeModel();
        const io = fakeIO();
        const attach = async (): Promise<CommandRunDesignAttachRtnData> => {
            throw new Error("run run-7 already took this session's design");
        };
        await expect(approveAndOpenRun(model, AGENT, STATE, io, attach)).rejects.toThrow("already took");
        expect(io.sent).toEqual([["blk-1", "brainstorm: approved"]]);
        expect(globalStore.get(newRunPrefillAtom)).toBeNull();
        expect(globalStore.get(model.newRunOpenAtom)).toBe(false);
    });
});

describe("openRunLauncher", () => {
    it("prefills and opens the launcher without sending", () => {
        const model = fakeModel();
        const io = fakeIO();
        openRunLauncher(model, AGENT, STATE, io);
        expect(globalStore.get(newRunPrefillAtom)).toMatchObject(runPrefill(FILE, { projectName: "siem", cwd: "/p" }));
        expect(globalStore.get(model.newRunOpenAtom)).toBe(true);
        expect(io.sent).toEqual([]);
    });

    it("tells the agent the id of the run the launcher starts", async () => {
        const io = fakeIO();
        openRunLauncher(fakeModel(), AGENT, STATE, io);
        globalStore.get(newRunPrefillAtom)!.onStarted!("run-42");
        await flush();
        expect(io.sent).toEqual([["blk-1", "brainstorm: run run-42"]]);
    });

    it("a refused run-id line raises an error toast with the refusal", async () => {
        openRunLauncher(fakeModel(), AGENT, STATE, fakeIO(true));
        globalStore.get(newRunPrefillAtom)!.onStarted!("run-42");
        await flush();
        expect(globalStore.get(toastsAtom)).toMatchObject([
            { level: "error", message: "Couldn't send to lag-alerts: boom" },
        ]);
    });
});

describe("reportSendFailure", () => {
    it("raises one error toast carrying the error's message", () => {
        reportSendFailure(AGENT.id, new Error("The agent is busy"));
        expect(globalStore.get(toastsAtom)).toMatchObject([{ level: "error", message: "The agent is busy" }]);
    });

    it("carries a non-Error refusal as its text", () => {
        reportSendFailure(AGENT.id, "no such tab");
        expect(globalStore.get(toastsAtom)).toMatchObject([{ level: "error", message: "no such tab" }]);
    });
});
