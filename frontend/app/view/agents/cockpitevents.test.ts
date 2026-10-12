// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { AgentVM } from "./agentsviewmodel";
import { agentTransitions, groupRailEvents, mergeRailEvents, runRailEvents, splitUnread } from "./cockpitevents";
import type { RunInfo } from "./runlineage";

const a = (over: Partial<AgentVM>) =>
    ({ id: "x", name: "flaky-e2e", task: "fix flake", state: "working", ...over }) as AgentVM;

describe("agentTransitions", () => {
    it("records nothing for an agent seen the first time", () => {
        const { events, next } = agentTransitions({}, [a({})], 100);
        expect(events).toEqual([]);
        expect(next).toEqual({ x: { state: "working", standingBy: false } });
    });
    it("turns state changes into asked, answered and finished", () => {
        const asking = a({ state: "asking", blockedMs: 10, ask: { questions: [{ question: "retry or wait?" }] } });
        expect(agentTransitions({ x: { state: "working", standingBy: false } }, [asking], 100).events).toEqual([
            { key: "x:asked:90", focusId: "x", who: "flaky-e2e", kind: "asked", text: "retry or wait?", ts: 90 },
        ]);
        expect(agentTransitions({ x: { state: "asking", standingBy: false } }, [a({})], 100).events[0]).toMatchObject({
            kind: "answered",
            ts: 100,
        });
        const idle = a({ state: "idle", idleSince: 95, activity: "142 strings extracted" });
        expect(agentTransitions({ x: { state: "working", standingBy: false } }, [idle], 100).events[0]).toMatchObject({
            kind: "finished",
            text: "142 strings extracted",
            ts: 95,
        });
    });
    it("finishes an agent standing by when its last shell task ends, not at the Stop", () => {
        const idle = a({ state: "idle", idleSince: 95, activity: "dev server up" });
        const stop = agentTransitions({ x: { state: "working", standingBy: false } }, [idle], 100, new Set(["x"]));
        expect(stop.events).toEqual([]);
        expect(stop.next).toEqual({ x: { state: "idle", standingBy: true } });
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
        const stop = agentTransitions({ x: { state: "working", standingBy: false } }, [idle], 100);
        expect(stop.events.map((e) => [e.kind, e.ts])).toEqual([["finished", 95]]);
        expect(agentTransitions(stop.next, [idle], 150).events).toEqual([]);
    });
    it("forgets agents that left the roster", () => {
        expect(agentTransitions({ gone: { state: "working", standingBy: false } }, [], 1).next).toEqual({});
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
        expect(out[0]).toMatchObject({ key: "R:child-ask1", focusId: "lead", who: "Session auth", group: "R" });
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
        expect(rows[0].more).toBe("+2 more from auth-lead");
        expect(rows[1].more).toBeUndefined();
    });
    it("lists every event of an opened run, the first offering to fold them again", () => {
        const rows = groupRailEvents(list, { R: true });
        expect(rows.map((r) => r.key)).toEqual(["a", "p", "b", "c"]);
        expect(rows[0].more).toBe("show less from auth-lead");
        expect(rows[2].more).toBeUndefined();
    });
    it("offers nothing for a run with a single event", () => {
        expect(groupRailEvents([e("a", "R")], {})[0].more).toBeUndefined();
    });
});
