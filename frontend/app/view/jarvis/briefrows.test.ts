// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { ActiveWorkRow, DeltaRow, QueueRow, RunRow } from "./briefingmodel";
import {
    behindGroups,
    filterLines,
    initiativeLine,
    projectName,
    queueLine,
    sessionLine,
    sessionWindow,
    sinceLabel,
    type BriefLine,
} from "./briefrows";
import { buildEffortCard } from "./effortmodel";

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const NOW = new Date(2026, 8, 15, 12, 0).getTime();

describe("queueLine", () => {
    const q: QueueRow = {
        key: "gate:1",
        kind: "plan gate",
        title: "Approve the plan",
        source: "waveterm",
        detail: "waveterm · #arc",
        ts: NOW - 5 * MIN,
        action: "Review",
        nav: { kind: "channel", channelId: "c1", runId: "r1" },
        tone: "asking",
        attrib: "Orchestrator · S4c",
        why: "2 of 4 done",
        cites: [],
        wireKind: "plan-gate",
        channelId: "c1",
        runId: "r1",
        phaseIdx: 0,
        taskId: "",
        retry: false,
    };

    it("reads kind, title, why, attribution and wait as one line that opens its target", () => {
        expect(queueLine(q, NOW)).toMatchObject({
            id: "waiting:gate:1",
            kind: "gate",
            kindTone: "asking",
            title: "Approve the plan",
            note: "2 of 4 done",
            why: "2 of 4 done",
            meta: "Orchestrator · S4c · waveterm · #arc",
            state: "",
            age: "5m",
            target: { queue: { kind: "channel", channelId: "c1", runId: "r1" } },
        });
    });

    it("stays static when it names nothing to open, and prints no wait it does not know", () => {
        const line = queueLine({ ...q, nav: null, ts: null, tone: "error" }, NOW);
        expect([line.target, line.age, line.kindTone]).toEqual([null, "", "error"]);
    });
});

describe("initiativeLine", () => {
    const summary = (chunks: { label: string; status: string }[], over: Partial<EffortSummary> = {}) =>
        ({
            oref: "effort:e1",
            title: "SIEM",
            status: "active",
            done: chunks.filter((c) => c.status === "done").length,
            total: chunks.length,
            activechunk: chunks.find((c) => c.status !== "done" && c.status !== "skipped")?.label,
            updatedts: NOW,
            project: "cad",
            ticket: "SIEM-1707",
            chunks,
            ...over,
        }) as EffortSummary;

    it("shows progress, the next chunk's short name, and ticket and project", () => {
        const card = buildEffortCard(
            summary([
                { label: "A", status: "done" },
                { label: "S8 item #2 deep-dive - narration spec", status: "active" },
                { label: "C", status: "skipped" },
                { label: "D", status: "pending" },
            ])
        );
        expect(initiativeLine(card)).toMatchObject({
            id: "initiatives:effort:e1",
            title: "SIEM",
            note: "S8 item #2 deep-dive",
            meta: "SIEM-1707 · cad",
            state: "active",
            stateTone: "ok",
            progress: { done: 1, total: 3, pct: 33 },
            target: { oref: "effort:e1" },
        });
    });

    it("says deferred when all that is left to pick up is deferred", () => {
        const card = buildEffortCard(
            summary(
                [
                    { label: "A", status: "done" },
                    { label: "M1", status: "deferred" },
                ],
                { project: undefined, ticket: undefined }
            )
        );
        expect(initiativeLine(card)).toMatchObject({ state: "deferred", stateTone: "muted", meta: "no project" });
    });

    it("puts a blocked chunk ahead of everything else it could say", () => {
        const card = buildEffortCard(
            summary([
                { label: "A", status: "active" },
                { label: "B", status: "blocked" },
            ])
        );
        expect(initiativeLine(card)).toMatchObject({ state: "1 blocked", stateTone: "asking" });
    });
});

describe("sessionLine", () => {
    const run: ActiveWorkRow = {
        key: "run:run:r1:0",
        kind: "run",
        oref: "run:r1",
        name: "execute the plan",
        meta: "waveterm · executing",
        chip: { label: "executing", tone: "running" },
        ts: NOW - 10 * DAY,
    };

    it("folds a run silent past seven days, and dates it by its age", () => {
        expect(sessionLine(run, NOW)).toMatchObject({
            id: "sessions:run:run:r1:0",
            kind: "▶ run",
            title: "execute the plan",
            meta: "waveterm · executing",
            state: "10d",
            stale: true,
            target: { oref: "run:r1" },
            runOid: "r1",
        });
        expect(sessionLine({ ...run, ts: NOW - DAY }, NOW).stale).toBe(false);
    });

    it("never folds what needs eyes, and names its state instead of its age", () => {
        const agent: ActiveWorkRow = {
            key: "agent:t1:1",
            kind: "agent",
            oref: "agent:t1",
            name: "lead · SIEM status",
            meta: "claude · cad",
            chip: { label: "asking", tone: "asking" },
            ts: NOW - 20 * DAY,
        };
        expect(sessionLine(agent, NOW)).toMatchObject({
            kind: "! agent",
            kindTone: "asking",
            state: "asking",
            stateTone: "asking",
            stale: false,
            target: null,
            agentId: "t1",
        });
    });
});

describe("sessionWindow", () => {
    const runs = (n: number, ageMs: number, tag: string): RunRow[] =>
        Array.from({ length: n }, (_, i) => ({
            oref: `run:${tag}${i}`,
            oid: `${tag}${i}`,
            goal: `${tag} ${i}`,
            project: "waveterm",
            status: "executing",
            workerOrefs: [],
            ts: NOW - ageMs - i * MIN,
        }));
    const legs = (activeRuns: RunRow[]) => ({ activeRuns, directAgents: [] });

    // capped first, a window of week-quiet runs showed nothing but the fold, and its "+N more" only fed the fold
    it("takes stale runs out before the cap, so the live ones still show", () => {
        const w = sessionWindow(legs([...runs(9, 10 * DAY, "old"), ...runs(2, 30 * MIN, "live")]), false, NOW);
        expect(w.rows.filter((r) => !sessionLine(r, NOW).stale).map((r) => r.name)).toEqual(["live 0", "live 1"]);
        expect(w.rows.filter((r) => sessionLine(r, NOW).stale)).toHaveLength(9);
        expect(w.more).toBe(0);
    });

    it("caps the live rows per kind and counts what the cap hid", () => {
        const closed = sessionWindow(legs(runs(10, 30 * MIN, "live")), false, NOW);
        expect(closed.rows).toHaveLength(8);
        expect(closed.more).toBe(2);
        const open = sessionWindow(legs(runs(10, 30 * MIN, "live")), true, NOW);
        expect(open.rows).toHaveLength(10);
        expect(open.more).toBe(0);
    });
});

describe("behindGroups", () => {
    const delta = (over: Partial<DeltaRow>): DeltaRow => ({
        key: "k",
        ts: NOW,
        kind: "effort-note",
        title: "SIEM",
        wording: "effort-note",
        detail: "A · note",
        oref: "effort:e1",
        ...over,
    });

    it("folds an initiative's events into one digest that leads with its newest note", () => {
        const groups = behindGroups(
            [
                {
                    label: "Today",
                    rows: [
                        delta({ key: "1", ts: NOW - MIN, kind: "chunk-added", detail: "B · " }),
                        delta({ key: "2", ts: NOW - 2 * MIN, detail: "A · Shipped the fold. Then more." }),
                        delta({
                            key: "3",
                            ts: NOW - 3 * MIN,
                            kind: "run-done",
                            title: "execute plan",
                            wording: "Run completed",
                            detail: "summary",
                            oref: "run:r1",
                        }),
                        delta({ key: "4", ts: NOW - 4 * MIN, kind: "chunk-done", detail: "A · plan written" }),
                    ],
                },
            ],
            [],
            NOW
        );
        expect(groups.map((g) => g.label)).toEqual(["Today"]);
        expect(groups[0].lines.map((l) => [l.id, l.kind, l.title, l.note, l.detail, l.state])).toEqual([
            [
                "behind:effort:Today:effort:e1",
                "Initiative",
                "SIEM",
                "Shipped the fold.",
                "2 notes · 1 chunk done · 1 chunk added",
                "1m",
            ],
            ["behind:3", "Run completed", "execute plan", "", "summary", "3m"],
        ]);
        expect(groups[0].lines[0].target).toEqual({ oref: "effort:e1" });
        expect(groups[0].lines.map((l) => [l.group, l.kindTone])).toEqual([
            ["delta", "muted"],
            ["delta", "ok"],
        ]);
    });

    it("keeps a record's event in the kind column and its status in the detail", () => {
        const [group] = behindGroups(
            [
                {
                    label: "Today",
                    rows: [
                        delta({
                            key: "d",
                            kind: "dossier",
                            title: "Clear the gate",
                            wording: "Record updated · current status: blocked",
                            detail: "status: blocked",
                            oref: "task:d1",
                        }),
                    ],
                },
            ],
            [],
            NOW
        );
        expect(group.lines[0]).toMatchObject({
            kind: "Record updated",
            kindTone: "asking",
            detail: "current status: blocked",
        });
    });

    it("says what an initiative did when it wrote no note", () => {
        const [group] = behindGroups(
            [
                {
                    label: "Yesterday",
                    rows: [
                        delta({ key: "1", kind: "effort-status", detail: "paused" }),
                        delta({ key: "2", kind: "effort-created", detail: "3 chunks" }),
                    ],
                },
            ],
            [],
            NOW
        );
        expect([group.lines[0].note, group.lines[0].detail]).toEqual(["", "created · marked paused"]);
    });

    it("keeps shipped runs as their own group", () => {
        const groups = behindGroups(
            [],
            [
                {
                    oref: "run:r2",
                    goal: "ship it",
                    project: "waveterm",
                    summary: "Shipped the fold. Then more.",
                    completedTs: NOW - 2 * 60 * MIN,
                    fresh: true,
                    hasReport: true,
                    effortOid: "",
                    chunkLabel: "",
                },
            ],
            NOW
        );
        expect(groups).toHaveLength(1);
        expect(groups[0].label).toBe("Shipped · 7 days");
        expect(groups[0].lines[0]).toMatchObject({
            id: "behind:shipped:run:r2",
            kind: "Shipped",
            kindTone: "ok",
            title: "ship it",
            meta: "",
            detail: "waveterm · Shipped the fold.",
            state: "2h",
            target: { oref: "run:r2" },
            hasReport: true,
            fresh: true,
            group: "shipped",
        });
    });
});

describe("filterLines", () => {
    const line = (id: string, over: Partial<BriefLine>): BriefLine => ({
        id,
        kind: "",
        kindTone: "muted",
        title: "",
        note: "",
        meta: "",
        state: "",
        stateTone: "muted",
        progress: null,
        target: null,
        why: "",
        age: "",
        detail: "",
        ...over,
    });

    it("matches any column the line shows, ignoring case", () => {
        const lines = [line("a", { title: "SIEM", meta: "cad" }), line("b", { title: "Radar", note: "trust fixes" })];
        expect(filterLines(lines, "TRUST").map((l) => l.id)).toEqual(["b"]);
        expect(filterLines(lines, "cad").map((l) => l.id)).toEqual(["a"]);
        expect(filterLines(lines, "  ").map((l) => l.id)).toEqual(["a", "b"]);
        expect(filterLines([line("c", { detail: "waveterm · shipped" })], "waveterm").map((l) => l.id)).toEqual(["c"]);
    });
});

describe("design row helpers", () => {
    it("names a project by its registry key, else the path's last segment", () => {
        expect(projectName("C:/x/waveterm", { waveterm: { path: "C:/x/waveterm" } } as never)).toBe("waveterm");
        expect(projectName("C:\\x\\orch-demo", {} as never)).toBe("orch-demo");
        expect(projectName("", {} as never)).toBe("");
    });
    it("says since when the delta runs", () => {
        const now = new Date(2026, 8, 23, 10, 0).getTime();
        expect(sinceLabel(new Date(2026, 8, 22, 18, 40).getTime(), now, false)).toBe("since yesterday 18:40");
        expect(sinceLabel(new Date(2026, 8, 23, 9, 5).getTime(), now, false)).toBe("since today 09:05");
        expect(sinceLabel(new Date(2026, 8, 12, 9, 5).getTime(), now, false)).toBe("since Sep 12");
        expect(sinceLabel(0, now, true)).toBe("the last 7 days");
    });
});
