// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { childAskAgent, childAskKey, childAskSent, newAskEventIds, userOwnedAsks } from "./childaskmodel";

function entry(over: Partial<DagAskItem>): DagAskItem {
    return {
        taskid: "t-1",
        askid: "a-1",
        owner: "user",
        questions: [{ question: "which ttl?" }],
        blockoref: "block:b1",
        ts: 1,
        ...over,
    };
}

function ev(kind: string, ts: number, detail?: Record<string, unknown>): RunEvent {
    return {
        id: `${kind}-${ts}`,
        runid: "run-1",
        channelid: "ch-1",
        ts,
        kind,
        detail: detail == null ? undefined : JSON.stringify(detail),
    };
}

describe("userOwnedAsks", () => {
    it("keeps only the human's entries, oldest first", () => {
        const asks = [
            entry({ taskid: "t-3", askid: "a-3", ts: 30 }),
            entry({ taskid: "t-2", askid: "a-2", owner: "lead", ts: 5 }),
            entry({ taskid: "t-1", askid: "a-1", ts: 10 }),
            entry({ taskid: "t-4", askid: "a-4", owner: undefined, ts: 1 }),
        ];
        expect(userOwnedAsks(asks).map((a) => a.taskid)).toEqual(["t-1", "t-3"]);
    });
});

describe("childAskAgent", () => {
    it("carries every question in the answer bar's shape", () => {
        const agent = childAskAgent(
            entry({
                questions: [
                    {
                        header: "Cache",
                        question: "which ttl?",
                        options: [{ label: "24h", description: "matches prod" }, { label: "7d" }],
                    },
                    { question: "which regions?", multiselect: true, options: [{ label: "eu" }, { label: "us" }] },
                ],
            })
        );
        expect(agent.state).toBe("asking");
        expect(agent.id).toBe("a-1");
        expect(agent.ask?.askId).toBe("a-1");
        expect(agent.ask?.oref).toBe("block:b1");
        expect(agent.ask?.questions).toEqual([
            {
                header: "Cache",
                question: "which ttl?",
                options: [{ label: "24h", description: "matches prod" }, { label: "7d" }],
            },
            { question: "which regions?", multiSelect: true, options: [{ label: "eu" }, { label: "us" }] },
        ]);
    });

    it("keys an entry by its task when the ask id is missing", () => {
        expect(childAskKey(entry({ askid: undefined }))).toBe("t-1");
        expect(childAskAgent(entry({ askid: undefined })).id).toBe("t-1");
    });
});

describe("childAskSent", () => {
    it("is unanswered until the human sends", () => {
        expect(childAskSent(undefined, entry({}), [])).toBe(false);
    });

    it("stays answered while nothing handed the question back", () => {
        expect(childAskSent(100, entry({}), [ev("child-answered", 150, { taskid: "t-1", askid: "a-1" })])).toBe(true);
    });

    it("is answerable again once the question comes back after the send", () => {
        const back = ev("task-forwarded", 200, {
            taskid: "t-1",
            askid: "a-1",
            note: "answer was sent but never confirmed",
        });
        expect(childAskSent(100, entry({}), [back])).toBe(false);
    });

    it("ignores a hand-off from before the send or for another ask", () => {
        const before = ev("task-forwarded", 50, { taskid: "t-1", askid: "a-1" });
        const other = ev("task-forwarded", 200, { taskid: "t-9", askid: "a-9" });
        expect(childAskSent(100, entry({}), [before, other])).toBe(true);
    });
});

describe("newAskEventIds", () => {
    it("returns the unseen rows that change the queue", () => {
        const events = [
            ev("child-ask", 1),
            ev("task-forwarded", 2),
            ev("child-answered", 3),
            ev("child-ask-cleared", 4),
            ev("task-done", 5),
        ];
        expect(newAskEventIds(events, new Set(["child-ask-1"]))).toEqual([
            "task-forwarded-2",
            "child-answered-3",
            "child-ask-cleared-4",
        ]);
    });
});
