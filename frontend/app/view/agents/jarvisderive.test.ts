// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { AgentVM } from "./agentsviewmodel";
import { buildFleetSnapshot, buildJarvisPrompt, fleetCostUsd, pendingAskCount, type WorkerState } from "./jarvisderive";

function chan(messages: Partial<ChannelMessage>[]): Channel {
    return { otype: "channel", oid: "c1", version: 1, name: "payments-api", createdts: 0, meta: {}, messages: messages as ChannelMessage[] };
}
function agent(over: Partial<AgentVM>): AgentVM {
    return { id: "t1", name: "claude", task: "", state: "working", ...over };
}

describe("buildFleetSnapshot", () => {
    it("resolves a dispatched worker to its live state, task, and ask", () => {
        const c = chan([{ kind: "dispatch", author: "claude", text: "harden webhooks", reforef: "tab:t1" }]);
        const agents = [agent({ id: "t1", name: "claude", state: "asking", task: "harden webhooks", ask: { questions: [{ question: "A or B?" }] } })];
        expect(buildFleetSnapshot(c, agents)).toEqual([
            { oref: "tab:t1", name: "claude", state: "asking", task: "harden webhooks", dispatchTask: "harden webhooks", askText: "A or B?" },
        ]);
    });

    it("marks a dispatched worker with no live row as gone, falling back to the dispatch runtime + task", () => {
        const c = chan([{ kind: "dispatch", author: "codex", text: "build auth", reforef: "tab:t2" }]);
        expect(buildFleetSnapshot(c, [])).toEqual([
            { oref: "tab:t2", name: "codex", state: "gone", task: "build auth", dispatchTask: "build auth" },
        ]);
    });

    it("surfaces the literal dispatch task for a live worker even when live.task is empty", () => {
        const c = chan([{ kind: "dispatch", author: "claude", text: "reply with token DELEG8", reforef: "tab:t1" }]);
        const agents = [agent({ id: "t1", name: "Provide delegation token", state: "working", task: "" })];
        expect(buildFleetSnapshot(c, agents)).toEqual([
            { oref: "tab:t1", name: "Provide delegation token", state: "working", dispatchTask: "reply with token DELEG8" },
        ]);
    });

    it("leaves dispatchTask undefined for a worker present only via a directive", () => {
        const c = chan([{ kind: "directive", author: "you", text: "do the thing", reforef: "tab:t9" }]);
        const snap = buildFleetSnapshot(c, [agent({ id: "t9", name: "web", state: "working", task: "live task" })]);
        expect(snap[0].dispatchTask).toBeUndefined();
        expect(snap[0].task).toBe("live task");
    });

    it("dedups a worker that was dispatched then steered into one entry", () => {
        const c = chan([
            { kind: "dispatch", author: "claude", text: "build", reforef: "tab:t1" },
            { kind: "directive", author: "you", text: "also add tests", reforef: "tab:t1" },
        ]);
        const snap = buildFleetSnapshot(c, [agent({ id: "t1", name: "claude", state: "working", task: "build" })]);
        expect(snap).toHaveLength(1);
        expect(snap[0].name).toBe("claude");
    });

    it("ignores non-dispatch messages and returns [] for an empty channel", () => {
        expect(buildFleetSnapshot(chan([{ kind: "human", author: "you", text: "hi", reforef: "" }]), [])).toEqual([]);
        expect(buildFleetSnapshot(chan([]), [])).toEqual([]);
    });

    it("carries the live ask oref for an asking worker", () => {
        const c = chan([{ kind: "dispatch", author: "claude", text: "go", reforef: "tab:w1" }]);
        const agents = [agent({ id: "w1", name: "claude", state: "asking", ask: { oref: "block:ask1", questions: [{ question: "q?" }] } })];
        const snap = buildFleetSnapshot(c, agents);
        expect(snap[0].askORef).toBe("block:ask1");
    });

    it("carries live activity, cost, and context% for a live worker with usage", () => {
        const c = chan([{ kind: "dispatch", author: "claude", text: "go", reforef: "tab:t1" }]);
        const agents = [
            agent({
                id: "t1",
                name: "claude",
                state: "working",
                task: "go",
                activity: "editing auth.go",
                usage: { costusd: 1.25, contextpct: 42 },
            }),
        ];
        const snap = buildFleetSnapshot(c, agents);
        expect(snap[0].activity).toBe("editing auth.go");
        expect(snap[0].costUsd).toBe(1.25);
        expect(snap[0].contextPct).toBe(42);
    });

    it("leaves activity/cost/context undefined for a gone worker", () => {
        const c = chan([{ kind: "dispatch", author: "codex", text: "build", reforef: "tab:t2" }]);
        const snap = buildFleetSnapshot(c, []);
        expect(snap[0].activity).toBeUndefined();
        expect(snap[0].costUsd).toBeUndefined();
        expect(snap[0].contextPct).toBeUndefined();
    });
});

describe("buildJarvisPrompt", () => {
    const snap = [{ oref: "tab:t1", name: "claude", state: "asking" as const, task: "build", askText: "A or B?" }];
    it("includes each worker's name, state, task, and ask", () => {
        const p = buildJarvisPrompt(snap, chan([]), "");
        expect(p).toContain("claude [asking]");
        expect(p).toContain("build");
        expect(p).toContain("A or B?");
    });
    it("uses the focus text as the task when provided", () => {
        expect(buildJarvisPrompt(snap, chan([]), "what's blocked?")).toContain("what's blocked?");
    });
    it("falls back to a default task when focus is empty", () => {
        expect(buildJarvisPrompt(snap, chan([]), "  ")).toContain("Summarize the current state");
    });
});

describe("pendingAskCount", () => {
    const answeredCard = (askORef: string) =>
        JSON.stringify({ askORef, workerORef: "tab:x", question: "q", options: [{ label: "y" }], choice: 0 });
    const testChan = (msgs: unknown[]) => ({ name: "c", messages: msgs }) as unknown as Channel;
    const testAgent = (id: string, state: string, askoref?: string) =>
        ({
            id,
            name: "claude",
            state,
            ask: askoref ? { oref: askoref, questions: [{ question: "q?" }] } : undefined,
        }) as unknown as AgentVM;

    it("counts an asking worker with no answered card", () => {
        expect(pendingAskCount([testChan([])], [testAgent("w1", "asking", "block:a")])).toBe(1);
    });
    it("drops an asking worker whose ask Jarvis already answered", () => {
        const msgs = [{ id: "1", kind: "jarvis-answered", author: "jarvis", text: "", ts: 0, data: answeredCard("block:a") }];
        expect(pendingAskCount([testChan(msgs)], [testAgent("w1", "asking", "block:a")])).toBe(0);
    });
    it("keeps a NEW ask from a worker whose PREVIOUS ask was answered", () => {
        const msgs = [{ id: "1", kind: "jarvis-answered", author: "jarvis", text: "", ts: 0, data: answeredCard("block:old") }];
        expect(pendingAskCount([testChan(msgs)], [testAgent("w1", "asking", "block:new")])).toBe(1);
    });
    it("ignores non-asking workers", () => {
        expect(pendingAskCount([testChan([])], [testAgent("w1", "working")])).toBe(0);
    });
    it("dedupes an ask answered in ANY channel", () => {
        const answered = testChan([{ id: "1", kind: "jarvis-answered", author: "jarvis", text: "", ts: 0, data: answeredCard("block:a") }]);
        expect(pendingAskCount([testChan([]), answered], [testAgent("w1", "asking", "block:a")])).toBe(0);
    });
    it("is 0 for no channels and no agents", () => {
        expect(pendingAskCount([], [])).toBe(0);
    });
});

describe("buildFleetSnapshot dismiss", () => {
    const dispatch = (oref: string, ts: number) => ({ id: String(ts), kind: "dispatch", author: "claude", text: "go", reforef: oref, ts });
    const dismiss = (oref: string, ts: number) => ({ id: "d" + ts, kind: "dismiss", author: "you", text: "", reforef: oref, ts });
    const chan = (msgs: unknown[]) => ({ name: "c", messages: msgs }) as unknown as Channel;

    it("hides a gone worker dismissed after its dispatch", () => {
        const snap = buildFleetSnapshot(chan([dispatch("tab:w1", 1), dismiss("tab:w1", 2)]), [] as unknown as AgentVM[]);
        expect(snap.find((w) => w.oref === "tab:w1")).toBeUndefined();
    });
    it("keeps a gone worker re-dispatched after its dismiss", () => {
        const snap = buildFleetSnapshot(chan([dispatch("tab:w1", 1), dismiss("tab:w1", 2), dispatch("tab:w1", 3)]), [] as unknown as AgentVM[]);
        expect(snap.find((w) => w.oref === "tab:w1")?.state).toBe("gone");
    });
    it("never hides a live worker even if a dismiss exists", () => {
        const agents = [{ id: "w1", name: "claude", state: "working", task: "" }] as unknown as AgentVM[];
        const snap = buildFleetSnapshot(chan([dispatch("tab:w1", 1), dismiss("tab:w1", 2)]), agents);
        expect(snap.find((w) => w.oref === "tab:w1")?.state).toBe("working");
    });
    it("ignores a dismiss for an oref never dispatched", () => {
        const snap = buildFleetSnapshot(chan([dispatch("tab:w1", 1), dismiss("tab:ghost", 2)]), [] as unknown as AgentVM[]);
        expect(snap).toHaveLength(1);
        expect(snap[0].oref).toBe("tab:w1");
    });
});

describe("fleetCostUsd", () => {
    const w = (over: Partial<WorkerState>): WorkerState => ({ oref: "tab:x", name: "claude", state: "working", ...over });
    it("sums costUsd across live workers", () => {
        expect(fleetCostUsd([w({ costUsd: 1.25 }), w({ costUsd: 0.75 })])).toBe(2);
    });
    it("ignores workers with no cost (gone or unreported)", () => {
        expect(fleetCostUsd([w({ costUsd: 1.5 }), w({ state: "gone" }), w({})])).toBe(1.5);
    });
    it("is 0 for an empty fleet", () => {
        expect(fleetCostUsd([])).toBe(0);
    });
});
