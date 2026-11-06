// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { AgentVM } from "./agentsviewmodel";
import type { RailEvent } from "./cockpitevents";
import { finishedRows, isQuiet, runningRows, type FinishedRow, type RunningRow } from "./projectnowmodel";
import type { Lineage, RunInfo } from "./runlineage";

const NOW = 1_000_000;
const P = "waveterm";

const agent = (over: Partial<AgentVM>) =>
    ({ id: "a", name: "loom", task: "fix the flake", state: "working", project: P, ...over }) as AgentVM;

const run = (over: Partial<RunInfo> = {}): RunInfo => ({
    runId: "R",
    channelId: "C",
    title: "Run CPU priority",
    project: P,
    dag: {
        createdts: NOW - 31 * 60_000,
        status: "running",
        tasks: [
            { id: "t-1", state: "done" },
            { id: "t-2", state: "running" },
            { id: "t-3", state: "pending" },
        ],
    } as TaskGroup,
    ...over,
});

const NO_RUNS: Lineage = { roles: {}, runs: {} };

describe("runningRows", () => {
    it("lists a working plain agent of the project with its activity, and excludes another project's", () => {
        const agents = [
            agent({ id: "a", activity: "Editing spawn.go", activeMs: 12 * 60_000 }),
            agent({ id: "b", project: "other" }),
        ];
        expect(runningRows(agents, [], NO_RUNS, P, NOW)).toEqual<RunningRow[]>([
            { kind: "agent", id: "a", name: "loom", line: "Editing spawn.go", since: NOW - 12 * 60_000 },
        ]);
    });

    it("falls back to the task when an agent has no activity", () => {
        expect(runningRows([agent({})], [], NO_RUNS, P, NOW)[0].line).toBe("fix the flake");
    });

    it("excludes asking and idle agents", () => {
        const agents = [agent({ id: "q", state: "asking" }), agent({ id: "i", state: "idle" })];
        expect(runningRows(agents, [], NO_RUNS, P, NOW)).toEqual([]);
    });

    it("shows a run member only under its run's row", () => {
        const agents = [agent({ id: "lead", state: "idle" }), agent({ id: "w1" }), agent({ id: "w2" })];
        const lineage: Lineage = {
            roles: {
                lead: { kind: "lead", runId: "R" },
                w1: { kind: "worker", leadRunId: "R", taskId: "t-2" },
                w2: { kind: "stage", leadRunId: "R", stageRole: "final" },
            },
            runs: { R: run() },
        };
        expect(runningRows(agents, [], lineage, P, NOW)).toEqual<RunningRow[]>([
            { kind: "run", id: "R", name: "Run CPU priority", line: "2 at work · 1/3 tasks", since: NOW - 31 * 60_000 },
        ]);
    });

    it("excludes a run with nothing working, a finished run and another project's run", () => {
        const idle: Lineage = {
            roles: { w: { kind: "worker", leadRunId: "R", taskId: "t-2" } },
            runs: { R: run() },
        };
        expect(runningRows([agent({ id: "w", state: "idle" })], [], idle, P, NOW)).toEqual([]);
        const done: Lineage = { ...idle, runs: { R: run({ dag: { ...run().dag, status: "done" } as TaskGroup }) } };
        expect(runningRows([agent({ id: "w" })], [], done, P, NOW)).toEqual([]);
        const other: Lineage = { ...idle, runs: { R: run({ project: "other" }) } };
        expect(runningRows([agent({ id: "w" })], [], other, P, NOW)).toEqual([]);
    });

    it("places a run by its lead's project when the lead is in the roster, else by its checkout", () => {
        const lineage: Lineage = {
            roles: { lead: { kind: "lead", runId: "R" }, w: { kind: "worker", leadRunId: "R", taskId: "t-2" } },
            runs: { R: run({ project: "waveterm-checkout" }) },
        };
        const agents = [agent({ id: "lead", state: "idle" }), agent({ id: "w", project: "" })];
        expect(runningRows(agents, [], lineage, P, NOW).map((r) => r.id)).toEqual(["R"]);
        expect(runningRows(agents.slice(1), [], lineage, P, NOW)).toEqual([]);
    });

    it("lists a project terminal running a command, and not one at its prompt or in another project", () => {
        const term = (id: string, project: string) =>
            agent({ id, name: id, kind: "terminal", state: "idle", task: "", project });
        const terminals = [
            { vm: term("dev server", P), command: "task dev", since: NOW - 3_600_000 },
            { vm: term("shell", P), command: null },
            { vm: term("elsewhere", "other"), command: "npm test" },
        ];
        expect(runningRows([], terminals, NO_RUNS, P, NOW)).toEqual<RunningRow[]>([
            { kind: "terminal", id: "dev server", name: "dev server", line: "task dev", since: NOW - 3_600_000 },
        ]);
    });

    it("orders agents, runs, then terminals, each oldest first", () => {
        const agents = [
            agent({ id: "new", activeMs: 1_000 }),
            agent({ id: "old", activeMs: 9_000 }),
            agent({ id: "w", state: "working" }),
        ];
        const lineage: Lineage = {
            roles: { w: { kind: "worker", leadRunId: "R", taskId: "t-2" } },
            runs: { R: run() },
        };
        const term = agent({ id: "t", kind: "terminal", state: "idle" });
        const rows = runningRows(agents, [{ vm: term, command: "ls", since: NOW }], lineage, P, NOW);
        expect(rows.map((r) => r.id)).toEqual(["old", "new", "R", "t"]);
    });
});

describe("finishedRows", () => {
    const ev = (over: Partial<RailEvent>): RailEvent => ({
        key: `${over.focusId}:${over.kind}:${over.ts}`,
        focusId: "a",
        who: "loom",
        kind: "finished",
        text: "fixed the flake",
        ts: 100,
        ...over,
    });
    const base = { runEvents: {}, seenTs: 0, project: P, agents: [agent({ id: "a" })], lineage: NO_RUNS };

    it("keeps one row per agent, its newest finish", () => {
        const rows = finishedRows({
            ...base,
            agentEvents: [ev({ ts: 100, text: "first" }), ev({ ts: 200, text: "second" })],
        });
        expect(rows).toEqual<FinishedRow[]>([{ id: "a", kind: "agent", name: "loom", line: "second", ts: 200 }]);
    });

    it("keeps finishes and lands only", () => {
        const rows = finishedRows({
            ...base,
            agentEvents: [ev({ kind: "asked", ts: 300 }), ev({ kind: "failed", ts: 250 }), ev({ ts: 100 })],
        });
        expect(rows.map((r) => r.ts)).toEqual([100]);
    });

    it("excludes events at or before the rail's read cursor", () => {
        const rows = finishedRows({ ...base, seenTs: 200, agentEvents: [ev({ ts: 200 })] });
        expect(rows).toEqual([]);
        expect(finishedRows({ ...base, seenTs: 199, agentEvents: [ev({ ts: 200 })] })).toHaveLength(1);
    });

    it("excludes another project's agent", () => {
        const rows = finishedRows({
            ...base,
            agents: [agent({ id: "a", project: "other" })],
            agentEvents: [ev({})],
        });
        expect(rows).toEqual([]);
    });

    it("gives a run row for a run's landed task, newest per run, newest first", () => {
        const lineage: Lineage = { roles: { lead: { kind: "lead", runId: "R" } }, runs: { R: run() } };
        const runEvents: Record<string, RunEvent[]> = {
            R: [
                { id: "e1", runid: "R", channelid: "C", ts: 300, kind: "task-merged", detail: '{"taskid":"t-1"}' },
                { id: "e0", runid: "R", channelid: "C", ts: 150, kind: "task-merged", detail: '{"taskid":"t-0"}' },
            ],
        };
        const rows = finishedRows({
            ...base,
            agents: [agent({ id: "a" }), agent({ id: "lead", state: "idle" })],
            lineage,
            runEvents,
            agentEvents: [ev({ ts: 200 })],
        });
        expect(rows.map((r) => [r.kind, r.id, r.name, r.ts])).toEqual([
            ["run", "R", "Run CPU priority", 300],
            ["agent", "a", "loom", 200],
        ]);
    });

    it("excludes an event of another project's run", () => {
        const lineage: Lineage = { roles: { lead: { kind: "lead", runId: "R" } }, runs: { R: run() } };
        const rows = finishedRows({
            ...base,
            agents: [agent({ id: "lead", state: "idle", project: "other" })],
            lineage,
            runEvents: { R: [{ id: "e1", runid: "R", channelid: "C", ts: 300, kind: "task-merged" }] },
            agentEvents: [],
        });
        expect(rows).toEqual([]);
    });
});

describe("isQuiet", () => {
    const r: RunningRow = { kind: "agent", id: "a", name: "loom", line: "", since: 0 };
    const f: FinishedRow = { kind: "agent", id: "a", name: "loom", line: "", ts: 0 };
    it("holds only when nothing runs and nothing finished unread", () => {
        expect(isQuiet([], [])).toBe(true);
        expect(isQuiet([r], [])).toBe(false);
        expect(isQuiet([], [f])).toBe(false);
    });
});
