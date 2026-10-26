// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { LiveSession } from "./sessionsarchivestore";
import type { RunSessions, RunView } from "./sessionsruns";
import {
    composeSearchRows,
    foldHits,
    mergeResultSessions,
    searchSummary,
    snippetParts,
    type CardMatch,
    type Row,
} from "./sessionssearch";

const session = (over: Partial<SessionActivity> = {}): SessionActivity => ({
    id: "s1",
    runtime: "claude",
    projectpath: "/p",
    projectname: "proj",
    branch: "main",
    task: "do the thing",
    model: "claude",
    tokenstotal: 0,
    lastactivets: 0,
    resumecommand: "",
    transcriptpath: "",
    status: "done",
    startedts: 0,
    durationms: 0,
    events: [],
    ...over,
});

const live = (over: Partial<LiveSession> = {}): LiveSession => ({
    ...session(over),
    live: false,
    needsAttention: false,
    ...over,
});

const hit = (over: Partial<SessionHit> = {}): SessionHit => ({
    kind: "turn",
    speaker: "agent",
    ord: 0,
    text: "the timeout stays",
    marks: [[4, 11]],
    ...over,
});

const result = (s: SessionActivity, hits: SessionHit[]): SessionSearchResult => ({
    session: s,
    hits,
    turnhits: hits.filter((h) => h.kind === "turn").length,
    eventhits: hits.filter((h) => h.kind === "event").length,
});

const soloRow = (s: LiveSession): Row => ({
    key: `${s.runtime}:${s.id}`,
    live: s.live,
    lastactivets: s.lastactivets,
    session: s,
});

const runRow = (runId: string, over: { live?: boolean; project?: string; needs?: number } = {}): Row => ({
    key: `run:${runId}`,
    live: !!over.live,
    lastactivets: 0,
    run: {
        group: { runId, sessions: [] } as unknown as RunSessions,
        view: {
            runId,
            project: over.project ?? "proj",
            needs: new Array(over.needs ?? 0).fill({}),
        } as unknown as RunView,
    },
});

const card = (n: number): CardMatch => ({ hits: [], total: n, results: [] });

describe("foldHits", () => {
    it("foldHits puts a lead hit on its run card", () => {
        const lead = session({ id: "lead1", runid: "r1", role: "lead" });
        const m = foldHits([result(lead, [hit({ speaker: "user" })])]);
        expect([...m.keys()]).toEqual(["run:r1"]);
        expect(m.get("run:r1")!.hits.map((h) => h.who)).toEqual(["lead"]);
        expect(m.get("run:r1")!.total).toBe(1);
    });

    it("foldHits folds a worker hit onto its run card under the member's number", () => {
        const lead = session({ id: "lead1", runid: "r1", role: "lead", lastactivets: 1 });
        const worker = session({ id: "w1", runid: "r1", role: "worker", taskid: "t-2", lastactivets: 2 });
        // newest first, as the RPC returns them: the worker before the lead
        const m = foldHits([
            result(worker, [hit({ ord: 0 }), hit({ ord: 1 })]),
            result(lead, [hit({ ord: 0, speaker: "agent" })]),
        ]);
        expect([...m.keys()]).toEqual(["run:r1"]);
        const c = m.get("run:r1")!;
        expect(c.hits.map((h) => h.who)).toEqual(["lead", "2", "2"]);
        expect(c.total).toBe(3);
        expect(c.results[0].session.id).toBe("lead1");
        expect(new Set(c.hits.map((h) => h.key)).size).toBe(3);
    });

    it("foldHits keys a solo by runtime and id with you/agent speakers", () => {
        const solo = session({ id: "s9", runtime: "pi" });
        // a judge's run is its own, but its session stays a solo
        const judge = session({ id: "j1", runid: "rj", role: "brainstorm-judge" });
        const m = foldHits([
            result(solo, [hit({ speaker: "user" }), hit({ speaker: "agent", ord: 1 })]),
            result(judge, [hit()]),
        ]);
        expect([...m.keys()]).toEqual(["pi:s9", "claude:j1"]);
        expect(m.get("pi:s9")!.hits.map((h) => h.who)).toEqual(["you", "agent"]);
    });

    it("foldHits names an event hit by its type", () => {
        const solo = session();
        const m = foldHits([result(solo, [hit(), hit({ kind: "event", speaker: "committed", ord: 3 })])]);
        const c = m.get("claude:s1")!;
        expect(c.hits.map((h) => h.who)).toEqual(["agent", "committed"]);
        expect(c.total).toBe(2);
    });
});

describe("mergeResultSessions", () => {
    it("mergeResultSessions adds a result the archive lacks and keeps one copy of a shared session", () => {
        const a = session({ id: "a" });
        const b = session({ id: "b" });
        const merged = mergeResultSessions(
            [a],
            [result(session({ id: "a", task: "fresh" }), []), result(b, []), result(b, [])]
        );
        expect(merged.map((s) => s.id)).toEqual(["a", "b"]);
        expect(merged[0]).toBe(a);
    });
});

describe("searchSummary", () => {
    it("searchSummary counts cards and every hit", () => {
        const m = new Map([
            ["claude:a", card(4)],
            ["run:r1", card(2)],
            ["pi:b", card(1)],
        ]);
        expect(searchSummary(m)).toBe("3 sessions · 7 matches");
        expect(searchSummary(new Map([["claude:a", card(1)]]))).toBe("1 session · 1 match");
    });
});

describe("composeSearchRows", () => {
    it("composeSearchRows applies the status and project filters over the matched rows", () => {
        const done = live({ id: "done1", status: "done" });
        const running = live({ id: "live1", live: true });
        const unmatched = live({ id: "other", live: true });
        const rows = [soloRow(done), soloRow(running), soloRow(unmatched), runRow("r1", { project: "elsewhere" })];
        const matches = new Map([
            ["claude:done1", card(1)],
            ["claude:live1", card(1)],
            ["run:r1", card(1)],
        ]);
        expect(composeSearchRows(rows, matches, "all", "all").map((r) => r.key)).toEqual([
            "claude:done1",
            "claude:live1",
            "run:r1",
        ]);
        // a matched done session drops under Live
        expect(composeSearchRows(rows, matches, "live", "all").map((r) => r.key)).toEqual(["claude:live1"]);
        // a matched run drops under another project
        expect(composeSearchRows(rows, matches, "all", "proj").map((r) => r.key)).toEqual([
            "claude:done1",
            "claude:live1",
        ]);
    });
});

describe("snippetParts", () => {
    it("snippetParts splits on marks including a mark at the start and end", () => {
        expect(
            snippetParts("abc def ghi", [
                [0, 3],
                [8, 11],
            ])
        ).toEqual([
            { text: "abc", mark: true },
            { text: " def ", mark: false },
            { text: "ghi", mark: true },
        ]);
        expect(snippetParts("no marks", [])).toEqual([{ text: "no marks", mark: false }]);
        // UTF-16 offsets: the emoji is two code units
        expect(snippetParts("😀 lỗi here", [[3, 6]])).toEqual([
            { text: "😀 ", mark: false },
            { text: "lỗi", mark: true },
            { text: " here", mark: false },
        ]);
    });
});
