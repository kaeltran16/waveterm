// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { AgentActionEntry, AgentEntry } from "./agentsviewmodel";
import type { SubagentVM } from "./session-models/sessionviewmodel";
import { subagentBanner, subagentFromEntries, subagentViewLine } from "./subagentviewmodel";

const START = 1_000_000;
const NOW = START + 230_000; // 3m 50s in
const grep: AgentActionEntry = {
    kind: "action",
    verb: "grep",
    target: "parsePlan(",
    pending: true,
    startedTs: NOW - 10_000,
    ts: NOW - 10_000,
};
const sub = (over: Partial<SubagentVM>): SubagentVM => ({
    id: "fxfindparse",
    type: "Explore",
    state: "working",
    startedAtMs: START,
    toolCount: 9,
    ...over,
});

describe("the subagent view's banner and now line", () => {
    it.each([
        [
            "running with a call",
            sub({ currentCall: grep }),
            { outcome: "running", status: "running · 3m 50s", tools: "9 tools" },
            { title: "Searched", mono: "parsePlan(", facts: "10s · 9 tools" },
        ],
        [
            "running between calls",
            sub({}),
            { outcome: "running", status: "running · 3m 50s", tools: "9 tools" },
            { title: "working", facts: "3m 50s · 9 tools" },
        ],
        [
            "done",
            sub({ state: "success", endedAtMs: START + 60_000, toolCount: 14 }),
            { outcome: "done", status: "done · 1m 00s", tools: "14 tools" },
            { title: "done", facts: "1m 00s · 14 tools" },
        ],
        [
            "failed",
            sub({ state: "failure", endedAtMs: START + 5_000, toolCount: 1 }),
            { outcome: "failed", status: "failed · 5s", tools: "1 tool" },
            { title: "failed", facts: "5s · 1 tool" },
        ],
        [
            // the parent ended before the child wrote an end: no duration to show
            "stopped",
            sub({ state: "stopped" }),
            { outcome: "stopped", status: "stopped", tools: "9 tools" },
            { title: "stopped", facts: "9 tools" },
        ],
    ] as const)("%s", (_name, s, banner, line) => {
        expect(subagentBanner(s, "fix-plan-parse", NOW)).toEqual({
            type: "Explore",
            parent: "subagent of fix-plan-parse",
            ...banner,
        });
        expect(subagentViewLine(s, NOW)).toEqual(line);
    });
});

describe("subagentFromEntries", () => {
    const focus = { agentId: "fxfindparse", label: "Explore", transcriptPath: "/t/agent-fxfindparse.jsonl" };
    const read: AgentActionEntry = { kind: "action", verb: "read", target: "plan.go", ts: START + 1_000 };
    const prompt: AgentEntry = { kind: "user", text: "Find every place a plan is parsed.", ts: START };

    it.each([
        ["a pending call is running it", [prompt, read, grep], { state: "working", toolCount: 2, currentCall: grep }],
        [
            "a closing reply is done",
            [prompt, read, { kind: "message", text: "Found it.", ts: START + 9_000 }],
            { state: "done", toolCount: 1, endedAtMs: START + 9_000 },
        ],
        [
            "the interrupt marker is stopped",
            [prompt, read, { kind: "interrupted" }],
            { state: "stopped", toolCount: 1 },
        ],
        ["a finished call with nothing after is still working", [prompt, read], { state: "working", toolCount: 1 }],
    ] as const)("%s", (_name, entries, want) => {
        expect(subagentFromEntries(focus, [...entries] as AgentEntry[])).toEqual({
            id: "fxfindparse",
            type: "Explore",
            transcriptPath: "/t/agent-fxfindparse.jsonl",
            startedAtMs: START,
            ...want,
        });
    });
});
