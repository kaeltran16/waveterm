// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "vitest";
import type { AgentVM } from "./agentsviewmodel";
import { buildFocusSections, moveFocusCursor } from "./focusswitchermodel";

const agent = (id: string, over: Partial<AgentVM> = {}): AgentVM =>
    ({ id, name: id, task: "", state: "working", project: "waveterm", ...over }) as AgentVM;
const space = (id: string, objective: string, over: Partial<SpaceSummary> = {}): SpaceSummary => ({
    id,
    objective,
    ticket: "",
    status: "active",
    updated: 0,
    ...over,
});

test("sections come in agent, run, task order and drop when empty", () => {
    const sections = buildFocusSections([agent("a1")], [space("t1", "alpha")], "", "waveterm");
    expect(sections.map((s) => s.kind)).toEqual(["agent", "task"]);
});

test("a run appears once with its worker count, taking its label from the first worker's task", () => {
    const agents = [
        agent("w1", { runId: "r1", task: "Land runs on their own branch" }),
        agent("w2", { runId: "r1", task: "something else" }),
        agent("w3", { runId: "r2", task: "solo run" }),
    ];
    const runs = buildFocusSections(agents, [], "", "waveterm").find((s) => s.kind === "run")!.rows;
    expect(runs.map((r) => [r.key, r.label, r.detail])).toEqual([
        ["run:r1", "Land runs on their own branch", "2 agents"],
        ["run:r2", "solo run", "1 agent"],
    ]);
});

test("an agent's project shows only when it differs from the current filter", () => {
    const rows = buildFocusSections([agent("here"), agent("there", { project: "other" })], [], "", "waveterm")[0].rows;
    expect(rows.map((r) => [r.id, r.meta, r.project])).toEqual([
        ["here", "", "waveterm"],
        ["there", "other", "other"],
    ]);
});

test("a task leaves the project alone and carries paused and ticket", () => {
    const [row] = buildFocusSections([], [space("t1", "alpha", { status: "paused", ticket: "A-1" })], "", "x")[0].rows;
    expect(row).toMatchObject({ key: "task:t1", project: "", paused: true, meta: "A-1" });
});

test("the query matches label, detail and meta, case-insensitively", () => {
    const agents = [agent("a1", { task: "Fix the Palette" }), agent("a2", { task: "unrelated" })];
    const spaces = [space("t1", "Palette polish"), space("t2", "other", { ticket: "PAL-9" })];
    const keys = buildFocusSections(agents, spaces, "pal", "waveterm").flatMap((s) => s.rows.map((r) => r.key));
    expect(keys).toEqual(["agent:a1", "task:t1", "task:t2"]);
});

test("moveFocusCursor starts at the top, steps, and clamps at both ends", () => {
    const keys = ["a", "b", "c"];
    expect(moveFocusCursor(keys, null, 1)).toBe("a");
    expect(moveFocusCursor(keys, "gone", -1)).toBe("a");
    expect(moveFocusCursor(keys, "a", 1)).toBe("b");
    expect(moveFocusCursor(keys, "c", 1)).toBe("c");
    expect(moveFocusCursor(keys, "a", -1)).toBe("a");
    expect(moveFocusCursor([], "a", 1)).toBeNull();
});
