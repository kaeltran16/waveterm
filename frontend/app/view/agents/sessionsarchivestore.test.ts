// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { AgentVM } from "./agentsviewmodel";
import { filterByStatus, groupByRecency, mergedFeed, overlayLive, totalEvents, type LiveSession } from "./sessionsarchivestore";

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
    it("marks needsAttention for an ended failed session", () => {
        const [s] = overlayLive([mk({ status: "failed" })], [], 1000);
        expect(s.live).toBe(false);
        expect(s.needsAttention).toBe(true);
    });
});

describe("filterByStatus", () => {
    const list = overlayLive(
        [
            mk({ id: "a", status: "done", transcriptpath: "/other.jsonl" }),
            mk({ id: "b", status: "failed", transcriptpath: "/nope.jsonl" }),
            mk({ id: "c" }), // live (matches mkAgent path)
        ],
        [mkAgent()],
        1000
    );
    it("live keeps only live sessions", () => {
        expect(filterByStatus(list, "live").map((s) => s.id)).toEqual(["c"]);
    });
    it("done excludes live and non-done", () => {
        expect(filterByStatus(list, "done").map((s) => s.id)).toEqual(["a"]);
    });
    it("needs keeps failed/waiting/asking", () => {
        expect(filterByStatus(list, "needs").map((s) => s.id)).toEqual(["b"]);
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
