// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { AgentEntry, AgentVM } from "./agentsviewmodel";
import {
    cockpitView,
    isCockpitSession,
    lastTurnEntries,
    observeSessions,
    sessionState,
    stepWait,
    WAIT_TIMER_MS,
    waitVerdict,
    type ConductorRead,
    type SessionState,
    type WaitTrack,
} from "./cockpitsessionmodel";
import type { SubagentVM } from "./session-models/sessionviewmodel";
import type { ShellTask } from "./shelltasks";

const MIN = 60_000;
// a fixed local noon, so "since local midnight" has room on both sides
const NOW = new Date(2026, 10, 27, 12, 0, 0).getTime();
const MIDNIGHT = new Date(2026, 10, 27, 0, 0, 0).getTime();

const agent = (over: Partial<AgentVM>): AgentVM => ({ id: "a", name: "a", task: "", state: "idle", ...over });
const run = (over: Partial<Run>): Run =>
    ({ oid: over.id, id: "r", version: 1, status: "executing", createdts: NOW - 60 * MIN, ...over }) as Run;
const monitor: ShellTask = { id: "m", kind: "monitor", description: "wait" };
const bgSub = { id: "s", type: "general", state: "working", background: true } as SubagentVM;

describe("sessionState", () => {
    it.each<[string, AgentVM, ShellTask[], SubagentVM[], SessionState]>([
        ["asking", agent({ state: "asking" }), [], [], "asks"],
        ["idle with a monitor", agent({ state: "idle" }), [monitor], [], "watching"],
        ["idle with a background subagent", agent({ state: "idle" }), [], [bgSub], "watching"],
        ["plain idle", agent({ state: "idle" }), [], [], "turn"],
        ["working", agent({ state: "working" }), [], [], "working"],
        ["booting", agent({ state: "working", booting: true }), [], [], "working"],
    ])("%s", (_, a, tasks, subs, want) => {
        expect(sessionState(a, tasks, subs)).toBe(want);
    });
});

describe("isCockpitSession", () => {
    it.each<[string, AgentVM, boolean, boolean]>([
        ["a plain agent", agent({}), false, true],
        ["a terminal", agent({ kind: "terminal" }), false, false],
        ["a background agent", agent({ kind: "background" }), false, false],
        ["an agent with a run", agent({ runId: "r1" }), false, false],
        ["an agent with a lineage role", agent({}), true, false],
        ["an agent another agent started", agent({ parentTabId: "t0" }), false, false],
    ])("%s", (_, a, hasRole, want) => {
        expect(isCockpitSession(a, hasRole)).toBe(want);
    });
});

describe("cockpitView", () => {
    const conductor = agent({ id: "c", state: "working", transcriptPath: "C:\\t\\c.jsonl" });
    const view = (runs: Run[], sessions = [{ agent: conductor, state: "working" as SessionState }], sights = {}) =>
        cockpitView({ sessions, runs, sights, loaded: true, now: NOW });

    it("makes a session whose transcript is a run's origin a conductor that lists the run", () => {
        const r = run({ id: "r1", origintranscript: "c:/t/c.jsonl" });
        const v = view([r]);
        expect(v.sessions).toHaveLength(1);
        expect(v.sessions[0].conductor).toBe(true);
        expect(v.sessions[0].runs.map((x) => x.id)).toEqual(["r1"]);
        expect(v.orphans).toEqual([]);
    });

    it("lists live runs and runs ended since local midnight, newest first, and drops older ended ones", () => {
        const origin = { origintranscript: conductor.transcriptPath };
        const runs = [
            run({ id: "live-old", createdts: NOW - 48 * 60 * MIN, ...origin }),
            run({
                id: "landed-today",
                status: "done",
                createdts: NOW - 30 * MIN,
                completedts: NOW - 5 * MIN,
                ...origin,
            }),
            run({
                id: "failed-today",
                status: "failed",
                createdts: NOW - 20 * MIN,
                completedts: MIDNIGHT + MIN,
                ...origin,
            }),
            run({
                id: "ended-yesterday",
                status: "done",
                createdts: NOW - 26 * 60 * MIN,
                completedts: MIDNIGHT - MIN,
                ...origin,
            }),
            run({
                id: "orphan-yesterday",
                status: "cancelled",
                createdts: MIDNIGHT - 90 * MIN,
                completedts: MIDNIGHT - MIN,
            }),
        ];
        const v = view(runs);
        expect(v.sessions[0].runs.map((r) => r.id)).toEqual(["failed-today", "landed-today", "live-old"]);
        expect(v.orphans).toEqual([]);
    });

    it("puts a run whose conductor is absent in orphans", () => {
        const runs = [
            run({ id: "gone", origintranscript: "C:\\t\\exited.jsonl" }),
            run({ id: "launcher", createdts: NOW - 10 * MIN }),
        ];
        const v = view(runs);
        expect(v.sessions[0].conductor).toBe(false);
        expect(v.orphans.map((r) => r.id)).toEqual(["launcher", "gone"]);
    });

    it("folds a session idle at first sight into idle, and counts only the grid's sessions on you", () => {
        const quiet = agent({ id: "q", state: "idle", idleSince: NOW - 60 * MIN });
        const turn = agent({ id: "t", state: "idle", idleSince: NOW - MIN });
        const asks = agent({ id: "k", state: "asking" });
        const v = view(
            [],
            [
                { agent: quiet, state: "turn" },
                { agent: turn, state: "turn" },
                { agent: asks, state: "asks" },
                { agent: conductor, state: "working" },
            ],
            { t: { dismissedAt: null, prompted: true, state: "working" } }
        );
        expect(v.idle.map((s) => s.agent.id)).toEqual(["q"]);
        expect(v.sessions.map((s) => s.agent.id)).toEqual(["t", "k", "c"]);
        expect(v.turnCount).toBe(2);
    });
});

describe("observeSessions", () => {
    const inIdle = (a: AgentVM, sights: ReturnType<typeof observeSessions>) =>
        cockpitView({ sessions: [{ agent: a, state: "turn" }], runs: [], sights, loaded: true, now: NOW }).idle
            .length === 1;

    it("dismisses a session idle at first sight until its next finished turn", () => {
        const a = agent({ id: "a", state: "idle", idleSince: NOW - 10 * MIN });
        const seen = observeSessions({}, [a], NOW);
        expect(inIdle(a, seen)).toBe(true);
        const next = agent({ id: "a", state: "idle", idleSince: NOW + MIN });
        expect(inIdle(next, observeSessions(seen, [next], NOW + MIN))).toBe(false);
    });

    it("dismisses a never-prompted session when it first goes idle", () => {
        const booting = agent({ id: "b", state: "working", booting: true });
        const seen = observeSessions({}, [booting], NOW);
        expect(inIdle(booting, seen)).toBe(false);
        const idle = agent({ id: "b", state: "idle", idleSince: NOW + MIN });
        expect(inIdle(idle, observeSessions(seen, [idle], NOW + 2 * MIN))).toBe(true);
    });

    it("brings a dismissed session back when it starts asking", () => {
        const idle = agent({ id: "a", state: "idle", idleSince: NOW - 10 * MIN });
        const seen = observeSessions({}, [idle], NOW);
        const asking = agent({ id: "a", state: "asking" });
        expect(inIdle(asking, observeSessions(seen, [asking], NOW + MIN))).toBe(false);
    });
});

describe("escalation", () => {
    const live = (state: SessionState): ConductorRead => ({ kind: "live", name: "det", state });
    // steps one wait through (minute, read) pairs from minute 0 and returns the last track
    const walk = (steps: [number, ConductorRead][]): WaitTrack => {
        let t: WaitTrack | undefined;
        for (const [min, read] of steps) {
            t = stepWait(t, read, NOW + min * MIN);
        }
        return t!;
    };
    const verdictAfter = (steps: [number, ConductorRead][]) => waitVerdict(walk(steps), steps[steps.length - 1][1]);

    it.each<
        [string, [number, ConductorRead][], { owner: string; why: string | null; minutesLeft?: number | null } | null]
    >([
        [
            "conductor Working stays the conductor's however long",
            [
                [0, live("working")],
                [600, live("working")],
            ],
            { owner: "conductor", why: null, minutesLeft: null },
        ],
        [
            "Watching 4 min stays the conductor's with 1 min left",
            [
                [0, live("watching")],
                [4, live("watching")],
            ],
            { owner: "conductor", why: null, minutesLeft: 1 },
        ],
        [
            "Watching 5 min in total across a Working gap is yours",
            [
                [0, live("watching")],
                [3, live("working")],
                [10, live("watching")],
                [12, live("watching")],
            ],
            { owner: "you", why: "timer" },
        ],
        ["conductor on Your turn when the wait opens", [[0, live("turn")]], { owner: "you", why: "turn" }],
        ["conductor on Asks you when the wait opens", [[0, live("asks")]], { owner: "you", why: "turn" }],
        [
            "conductor ending a turn into Your turn with it open",
            [
                [0, live("working")],
                [2, live("turn")],
            ],
            { owner: "you", why: "turn" },
        ],
        [
            "conductor gone",
            [
                [0, live("working")],
                [1, { kind: "gone" }],
            ],
            { owner: "you", why: "exit" },
        ],
        ["never had one", [[0, { kind: "none" }]], { owner: "you", why: "none" }],
        ["before the runs store loads", [[0, { kind: "unknown", checkedAt: null }]], null],
        ["a run unknown after a fetch begun as the wait opened", [[0, { kind: "unknown", checkedAt: NOW }]], null],
        [
            "a run unknown after a fetch begun since the wait opened",
            [
                [0, { kind: "unknown", checkedAt: NOW }],
                [1, { kind: "unknown", checkedAt: NOW + MIN / 2 }],
            ],
            { owner: "you", why: "none" },
        ],
        [
            "once yours, a conductor back at Working leaves it yours",
            [
                [0, live("turn")],
                [1, live("working")],
            ],
            { owner: "you", why: "turn" },
        ],
    ])("%s", (_, steps, want) => {
        const got = verdictAfter(steps);
        if (want == null) {
            expect(got).toBeNull();
            return;
        }
        expect(got).toMatchObject(want);
    });

    it("keeps the exited conductor's name", () => {
        const t = walk([
            [0, live("working")],
            [1, { kind: "gone" }],
        ]);
        expect(t.conductorName).toBe("det");
    });

    it("lets a watchedMs set from outside decide at once", () => {
        const t = { ...walk([[0, live("watching")]]), watchedMs: WAIT_TIMER_MS };
        expect(waitVerdict(t, live("watching"))).toMatchObject({ owner: "you", why: "timer" });
    });
});

describe("lastTurnEntries", () => {
    const say = (text: string): AgentEntry => ({ kind: "message", text });
    const you = (text: string): AgentEntry => ({ kind: "user", text });

    it("starts at the last user prompt", () => {
        const entries = [you("one"), say("a"), you("two"), say("b"), say("c")];
        expect(lastTurnEntries(entries, 8)).toEqual([you("two"), say("b"), say("c")]);
    });
    it("keeps at most max rows, the newest", () => {
        const entries = [you("go"), say("1"), say("2"), say("3")];
        expect(lastTurnEntries(entries, 2)).toEqual([say("2"), say("3")]);
    });
    it("keeps the newest when there is no prompt", () => {
        expect(lastTurnEntries([say("1"), say("2"), say("3")], 2)).toEqual([say("2"), say("3")]);
    });
    it("does not start a turn at a queued message", () => {
        const queued: AgentEntry = { kind: "user", text: "also", queued: true };
        const entries = [you("go"), say("1"), queued, say("2")];
        expect(lastTurnEntries(entries, 8)).toEqual(entries);
    });
});
