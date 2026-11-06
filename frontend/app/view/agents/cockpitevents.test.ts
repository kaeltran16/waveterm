// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { AgentVM } from "./agentsviewmodel";
import {
    agentTransitions,
    fillAskedText,
    finishes,
    groupRailEvents,
    mergeRailEvents,
    nextSnap,
    runRailEvents,
    scopeRailRows,
    splitUnread,
    type RailEvent,
} from "./cockpitevents";
import type { Lineage, RunInfo } from "./runlineage";

const a = (over: Partial<AgentVM>) =>
    ({ id: "x", name: "flaky-e2e", task: "fix flake", state: "working", ...over }) as AgentVM;

describe("agentTransitions", () => {
    it("records nothing for an agent seen the first time", () => {
        const { events, next } = agentTransitions({}, [a({})], 100);
        expect(events).toEqual([]);
        expect(next).toEqual({ x: { state: "working", standingBy: false, held: false } });
    });
    it("turns state changes into asked, answered and finished", () => {
        const asking = a({ state: "asking", blockedMs: 10, ask: { questions: [{ question: "retry or wait?" }] } });
        expect(
            agentTransitions({ x: { state: "working", standingBy: false, held: false } }, [asking], 100).events
        ).toEqual([
            { key: "x:asked:90", focusId: "x", who: "flaky-e2e", kind: "asked", text: "retry or wait?", ts: 90 },
        ]);
        expect(
            agentTransitions({ x: { state: "asking", standingBy: false, held: false } }, [a({})], 100).events[0]
        ).toMatchObject({
            kind: "answered",
            ts: 100,
        });
        const idle = a({ state: "idle", idleSince: 95, activity: "142 strings extracted" });
        expect(
            agentTransitions({ x: { state: "working", standingBy: false, held: false } }, [idle], 100).events[0]
        ).toMatchObject({
            kind: "finished",
            text: "142 strings extracted",
            ts: 95,
        });
    });
    it("finishes an agent standing by when its last shell task ends, not at the Stop", () => {
        const idle = a({ state: "idle", idleSince: 95, activity: "dev server up" });
        const stop = agentTransitions(
            { x: { state: "working", standingBy: false, held: false } },
            [idle],
            100,
            new Set(["x"])
        );
        expect(stop.events).toEqual([]);
        expect(stop.next).toEqual({ x: { state: "idle", standingBy: true, held: false } });
        const still = agentTransitions(stop.next, [idle], 150, new Set(["x"]));
        expect(still.events).toEqual([]);
        const ended = agentTransitions(still.next, [idle], 200);
        expect(ended.events).toEqual([
            { key: "x:finished:200", focusId: "x", who: "flaky-e2e", kind: "finished", text: "dev server up", ts: 200 },
        ]);
        expect(agentTransitions(ended.next, [idle], 250).events).toEqual([]);
    });
    it("finishes an agent with no shell tasks once, at the Stop", () => {
        const idle = a({ state: "idle", idleSince: 95, activity: "done" });
        const stop = agentTransitions({ x: { state: "working", standingBy: false, held: false } }, [idle], 100);
        expect(stop.events.map((e) => [e.kind, e.ts])).toEqual([["finished", 95]]);
        expect(agentTransitions(stop.next, [idle], 150).events).toEqual([]);
    });
    it("holds the finish at a Stop while its shell-task read is pending", () => {
        const idle = a({ state: "idle", idleSince: 95, activity: "dev server up" });
        const stop = agentTransitions(
            { x: { state: "working", standingBy: false, held: false } },
            [idle],
            100,
            new Set(),
            new Set(["x"])
        );
        expect(stop.events).toEqual([]);
        expect(stop.next).toEqual({ x: { state: "idle", standingBy: false, held: true } });
    });
    it("finishes once when the held read lands with a running task and that task later ends", () => {
        const idle = a({ state: "idle", idleSince: 95, activity: "dev server up" });
        const stop = agentTransitions(
            { x: { state: "working", standingBy: false, held: false } },
            [idle],
            100,
            new Set(),
            new Set(["x"])
        );
        const landed = agentTransitions(stop.next, [idle], 110, new Set(["x"]));
        expect(landed.events).toEqual([]);
        expect(landed.next).toEqual({ x: { state: "idle", standingBy: true, held: false } });
        const ended = agentTransitions(landed.next, [idle], 300);
        expect(ended.events.map((e) => [e.kind, e.ts])).toEqual([["finished", 300]]);
        expect(agentTransitions(ended.next, [idle], 350).events).toEqual([]);
    });
    it("finishes once, stamped at the Stop, when the held read lands with nothing running", () => {
        const idle = a({ state: "idle", idleSince: 95, activity: "done" });
        const stop = agentTransitions(
            { x: { state: "working", standingBy: false, held: false } },
            [idle],
            100,
            new Set(),
            new Set(["x"])
        );
        const still = agentTransitions(stop.next, [idle], 105, new Set(), new Set(["x"]));
        expect(still.events).toEqual([]);
        const landed = agentTransitions(still.next, [idle], 110);
        expect(landed.events.map((e) => [e.kind, e.ts])).toEqual([["finished", 95]]);
        expect(agentTransitions(landed.next, [idle], 150).events).toEqual([]);
    });
    it("records nothing when the first read of an agent first seen idle lands", () => {
        const idle = a({ state: "idle", idleSince: 95 });
        const seen = agentTransitions({}, [idle], 100, new Set(), new Set(["x"]));
        expect(seen.next.x.held).toBe(false);
        expect(agentTransitions(seen.next, [idle], 110).events).toEqual([]);
    });
    it("forgets agents that left the roster", () => {
        expect(agentTransitions({ gone: { state: "working", standingBy: false, held: false } }, [], 1).next).toEqual(
            {}
        );
    });
});

describe("nextSnap / finishes", () => {
    const working = { state: "working" as const, standingBy: false, held: false };
    it("holds only a finish that is owed, and holds it until the read lands", () => {
        const held = nextSnap(working, "idle", false, true);
        expect(held.held).toBe(true);
        expect(finishes(working, held)).toBe(false);
        // the header advances it during render, so the same inputs must give the same snapshot
        expect(nextSnap(held, "idle", false, true)).toEqual(held);
        const released = nextSnap(held, "idle", false, false);
        expect(finishes(held, released)).toBe(true);
        expect(nextSnap(undefined, "idle", false, true).held).toBe(false);
    });
    it("finishes at the Stop with no read pending, as before", () => {
        expect(finishes(working, nextSnap(working, "idle", false, false))).toBe(true);
    });
});

describe("runRailEvents", () => {
    const run: RunInfo = { runId: "R", channelId: "C", title: "Session auth", project: "p" };
    const ev = (kind: string, ts: number, detail: object = {}): RunEvent => ({
        id: `${kind}${ts}`,
        runid: "R",
        channelid: "C",
        ts,
        kind,
        detail: JSON.stringify(detail),
    });

    it("keeps state changes and drops the rest", () => {
        const out = runRailEvents(
            run,
            [
                ev("child-ask", 1, { taskid: "t3", question: "keep the cookie?" }),
                ev("task-done", 2, { taskid: "t1" }),
                ev("task-review-failed", 3, { taskid: "t7", round: 1, final: false }),
                ev("task-review-failed", 4, { taskid: "t7", round: 2, final: true }),
                ev("task-stalled", 5, { taskid: "t9" }),
                ev("lead-woken", 6),
            ],
            "lead"
        );
        expect(out.map((e) => e.kind)).toEqual(["asked", "finished", "failed", "quiet"]);
        expect(out[0]).toMatchObject({ key: "R:child-ask1", focusId: "row:lead:t3", who: "Session auth", group: "R" });
    });

    // a click lands on the task's row of the run's card; an event naming no task lands on the card
    it("focuses the named task's row, or the card, a leadless run's by its address", () => {
        const out = runRailEvents(run, [ev("task-failed", 1, { taskid: "t1" }), ev("dag-done", 2)], "lead");
        expect(out.map((e) => e.focusId)).toEqual(["row:lead:t1", "lead"]);
        const leadless = runRailEvents(run, [ev("task-failed", 1, { taskid: "t1" }), ev("dag-done", 2)]);
        expect(leadless.map((e) => e.focusId)).toEqual(["row:run:R:t1", "run:R"]);
    });

    // a finished task has not landed while its merge waits; only the merge lands it
    it("reads a task-done as finished and a task-merged as landed", () => {
        const out = runRailEvents(run, [ev("task-done", 1, { taskid: "t1" }), ev("task-merged", 2, { taskid: "t1" })]);
        expect(out.map((e) => e.kind)).toEqual(["finished", "landed"]);
    });
});

describe("mergeRailEvents / splitUnread", () => {
    const e = (key: string, ts: number) => ({ key, who: "w", kind: "asked" as const, text: "", ts });
    it("merges newest first, dedupes by key and caps", () => {
        expect(
            mergeRailEvents(
                [
                    [e("a", 1), e("b", 3)],
                    [e("b", 3), e("c", 2)],
                ],
                2
            ).map((x) => x.key)
        ).toEqual(["b", "c"]);
    });
    it("splits on the seen timestamp", () => {
        const { fresh, old } = splitUnread([e("b", 3), e("a", 1)], 2);
        expect(fresh.map((x) => x.key)).toEqual(["b"]);
        expect(old.map((x) => x.key)).toEqual(["a"]);
    });
});

describe("groupRailEvents", () => {
    const e = (key: string, group?: string) => ({
        key,
        who: group ? "auth-lead" : "w",
        kind: "asked" as const,
        text: "",
        ts: 0,
        group,
    });
    const list = [e("a", "R"), e("p"), e("b", "R"), e("c", "R")];
    it("shows a run's newest event with a count of the rest, and plain agents' events as they are", () => {
        const rows = groupRailEvents(list, {});
        expect(rows.map((r) => r.key)).toEqual(["a", "p"]);
        expect(rows[0].more).toBe("+2 more");
        expect(rows[1].more).toBeUndefined();
    });
    it("lists every event of an opened run, the first offering to fold them again", () => {
        const rows = groupRailEvents(list, { R: true });
        expect(rows.map((r) => r.key)).toEqual(["a", "p", "b", "c"]);
        expect(rows[0].more).toBe("show less");
        expect(rows[2].more).toBeUndefined();
    });
    it("offers nothing for a run with a single event", () => {
        expect(groupRailEvents([e("a", "R")], {})[0].more).toBeUndefined();
    });
});

describe("fillAskedText", () => {
    const asked = (over: Partial<RailEvent> = {}): RailEvent => ({
        key: "x:asked:90",
        focusId: "x",
        who: "flaky-e2e",
        kind: "asked",
        text: "",
        ts: 90,
        ...over,
    });
    const askingNow = a({ state: "asking", ask: { questions: [{ question: "retry or wait?" }] } });
    it("fills an empty asked event once its agent's question arrives", () => {
        expect(fillAskedText([asked()], [askingNow])).toEqual([asked({ text: "retry or wait?" })]);
    });
    it("leaves an asked event that already has its question", () => {
        const events = [asked({ text: "deploy now?" })];
        expect(fillAskedText(events, [askingNow])).toBe(events);
    });
    it("leaves an asked event whose agent stopped asking", () => {
        const events = [asked()];
        expect(fillAskedText(events, [a({ state: "working" })])).toBe(events);
    });
    it("leaves an earlier ask when the agent has a newer event", () => {
        const events = [{ ...asked(), key: "x:answered:95", kind: "answered" as const, ts: 95 }, asked()];
        expect(fillAskedText(events, [askingNow])).toBe(events);
    });
    it("returns the same array when the question has not arrived", () => {
        const events = [asked()];
        expect(fillAskedText(events, [a({ state: "asking" })])).toBe(events);
    });
});

describe("scopeRailRows", () => {
    const agents = [
        a({ id: "p1", project: "payments" }),
        a({ id: "w1", project: "web" }),
        a({ id: "lead", project: "payments" }),
    ];
    const lineage: Lineage = {
        roles: { lead: { kind: "lead", runId: "R" } },
        runs: {},
    };
    const ev = (key: string, over: Partial<RailEvent>): RailEvent => ({
        key,
        who: key,
        kind: "finished",
        text: "",
        ts: 0,
        ...over,
    });
    const rows = [
        ev("p", { focusId: "p1" }),
        ev("w", { focusId: "w1" }),
        ev("run", { focusId: "lead", group: "R" }),
        ev("gone", { focusId: "closed" }),
    ];
    it("keeps every row with no scope", () => {
        expect(scopeRailRows(rows, agents, lineage, "all")).toBe(rows);
    });
    it("keeps an agent's row in its project's scope and drops it from another", () => {
        expect(scopeRailRows(rows, agents, lineage, "web").map((r) => r.key)).toEqual(["w"]);
    });
    it("scopes a run's row by its lead's project", () => {
        expect(scopeRailRows(rows, agents, lineage, "payments").map((r) => r.key)).toEqual(["p", "run"]);
    });
});
