// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { AgentVM } from "./agentsviewmodel";
import {
    filterByProject,
    filterByStatus,
    groupByRecency,
    mergedFeed,
    overlayLive,
    resolveSelectedSession,
    totalEvents,
} from "./sessionsarchivestore";

const ev = (type: string, ts: number, text = ""): SessionEvent => ({ type, ts, text });

const mk = (over: Partial<SessionActivity> = {}): SessionActivity => ({
    id: "x",
    runtime: "claude",
    projectpath: "/p",
    projectname: "proj",
    branch: "main",
    task: "do the thing",
    model: "claude",
    tokenstotal: 0,
    lastactivets: 0,
    resumecommand: "claude --resume x",
    transcriptpath: "/home/me/.claude/projects/p/x.jsonl",
    status: "done",
    startedts: 0,
    durationms: 0,
    events: [ev("started", 1), ev("finished", 2)],
    ...over,
});

const mkAgent = (over: Partial<AgentVM> = {}): AgentVM =>
    ({ id: "t1", state: "working", transcriptPath: "/home/me/.claude/projects/p/x.jsonl", ...over }) as AgentVM;

describe("overlayLive", () => {
    it("flags a session live when its transcript path matches a roster agent, stripping finished", () => {
        const [s] = overlayLive([mk()], [mkAgent()], 1000);
        expect(s.live).toBe(true);
        expect(s.liveId).toBe("t1");
        expect(s.events.some((e) => e.type === "finished")).toBe(false);
    });
    it("marks needsAttention for a live asking agent", () => {
        const [s] = overlayLive([mk()], [mkAgent({ state: "asking" })], 1000);
        expect(s.needsAttention).toBe(true);
    });
    it("marks needsAttention for an ended waiting session", () => {
        const [s] = overlayLive([mk({ status: "waiting" })], [], 1000);
        expect(s.live).toBe(false);
        expect(s.needsAttention).toBe(true);
    });
});

describe("overlayLive: what the overlay keeps and decides", () => {
    it("keeps a live session's other events, in order, and drops only the finished one", () => {
        const events = [ev("started", 1, "go"), ev("committed", 2, "c1"), ev("finished", 3)];
        const [s] = overlayLive([mk({ events })], [mkAgent()], 1000);
        expect(s.events).toEqual([ev("started", 1, "go"), ev("committed", 2, "c1")]);
    });
    it("leaves an ended session's events as scanned, finished included", () => {
        const events = [ev("started", 1), ev("finished", 2)];
        const [s] = overlayLive([mk({ events, transcriptpath: "/other.jsonl" })], [mkAgent()], 1000);
        expect(s.events).toEqual(events);
    });
    it("does not flag a live session that is not asking", () => {
        const [s] = overlayLive([mk()], [mkAgent({ state: "working" })], 1000);
        expect(s.live).toBe(true);
        expect(s.needsAttention).toBe(false);
    });
    it("does not flag an ended session that finished", () => {
        const [s] = overlayLive([mk({ status: "done" })], [], 1000);
        expect(s.needsAttention).toBe(false);
    });
    it("ignores a roster agent with no transcript path, and still matches the others", () => {
        const roster = [mkAgent({ id: "t0", transcriptPath: undefined }), mkAgent()];
        const [s] = overlayLive([mk()], roster, 1000);
        expect(s.liveId).toBe("t1");
    });
});

describe("session filters and selection", () => {
    const list = overlayLive(
        [
            mk({ id: "a", projectname: "alpha", status: "done", transcriptpath: "/other.jsonl" }),
            mk({ id: "b", projectname: "beta", status: "waiting", transcriptpath: "/nope.jsonl" }),
            mk({ id: "c", projectname: "alpha" }), // live (matches mkAgent path)
        ],
        [mkAgent()],
        1000
    );

    it("filters by the session's existing project name", () => {
        expect(filterByProject(list, "alpha").map((s) => s.id)).toEqual(["a", "c"]);
        expect(filterByProject(list, "all")).toBe(list);
    });

    it("live keeps only live sessions", () => {
        expect(filterByStatus(list, "live").map((s) => s.id)).toEqual(["c"]);
    });

    it("done excludes live and non-done", () => {
        expect(filterByStatus(list, "done").map((s) => s.id)).toEqual(["a"]);
    });

    it("needs keeps waiting/asking", () => {
        expect(filterByStatus(list, "needs").map((s) => s.id)).toEqual(["b"]);
    });

    it("resolves an explicit detail selection from the unfiltered set", () => {
        const shown = filterByProject(list, "alpha");
        expect(shown.map((s) => s.id)).not.toContain("b");
        expect(resolveSelectedSession(list, "claude:b")?.id).toBe("b");
        expect(resolveSelectedSession(list, "all")).toBeUndefined();
    });
});

describe("groupByRecency", () => {
    it("splits into live / today / earlier and drops empties", () => {
        const now = new Date("2026-07-10T12:00:00Z").getTime();
        const startToday = new Date("2026-07-10T01:00:00Z").getTime();
        const yesterday = new Date("2026-07-09T12:00:00Z").getTime();
        const list = overlayLive(
            [
                mk({ id: "live", transcriptpath: "/home/me/.claude/projects/p/x.jsonl" }),
                mk({ id: "today", lastactivets: startToday, transcriptpath: "/t.jsonl" }),
                mk({ id: "old", lastactivets: yesterday, transcriptpath: "/o.jsonl" }),
            ],
            [mkAgent()],
            now
        );
        const groups = groupByRecency(list, now);
        expect(groups.map((g) => g.key)).toEqual(["live", "today", "earlier"]);
        expect(groups[0].items.map((s) => s.id)).toEqual(["live"]);
    });
});

describe("groupByRecency: ordering and membership", () => {
    const now = new Date("2026-07-10T12:00:00Z").getTime();
    const startOfToday = new Date(now).setHours(0, 0, 0, 0);
    const item = (id: string, lastactivets: number, live = false) => ({ id, live, lastactivets });
    const ids = (g: { items: { id: string }[] }) => g.items.map((i) => i.id);

    it("orders each group newest-first whatever order the list came in", () => {
        const groups = groupByRecency(
            [
                item("l1", 10, true),
                item("l2", 30, true),
                item("t1", startOfToday + 10),
                item("t2", startOfToday + 30),
                item("e1", startOfToday - 30),
                item("e2", startOfToday - 10),
            ],
            now
        );
        expect(groups.map((g) => [g.key, g.label, ids(g)])).toEqual([
            ["live", "Live now", ["l2", "l1"]],
            ["today", "Today", ["t2", "t1"]],
            ["earlier", "Earlier", ["e2", "e1"]],
        ]);
    });

    it("counts activity at the first instant of today as today, and the instant before as earlier", () => {
        const groups = groupByRecency([item("edge", startOfToday), item("before", startOfToday - 1)], now);
        expect(groups.map((g) => [g.key, ids(g)])).toEqual([
            ["today", ["edge"]],
            ["earlier", ["before"]],
        ]);
    });

    it("holds only the groups that have sessions, and nothing for an empty list", () => {
        expect(groupByRecency([item("l", 5, true)], now).map((g) => [g.key, ids(g)])).toEqual([["live", ["l"]]]);
        expect(groupByRecency([item("e", 5)], now).map((g) => [g.key, ids(g)])).toEqual([["earlier", ["e"]]]);
        expect(groupByRecency([item("t", startOfToday + 5)], now).map((g) => [g.key, ids(g)])).toEqual([["today", ["t"]]]);
        expect(groupByRecency([], now)).toEqual([]);
    });
});

describe("mergedFeed + totalEvents", () => {
    it("interleaves events newest-first with session context", () => {
        const list = overlayLive(
            [mk({ id: "a", task: "A task", events: [ev("started", 10, "a-start")] }, ), mk({ id: "b", task: "B task", transcriptpath: "/b.jsonl", events: [ev("committed", 20, "b-commit")] })],
            [],
            1000
        );
        const feed = mergedFeed(list);
        expect(feed[0].ts).toBe(20);
        expect(feed[0].sessionTitle).toBe("B task");
        expect(totalEvents(list)).toBe(2);
    });
});
