// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { AgentVM } from "./agentsviewmodel";
import { buildFleetSnapshot, buildJarvisPrompt } from "./jarvisderive";

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
