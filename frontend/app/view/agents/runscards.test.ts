// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    attentionModel,
    attentionStepSummary,
    matchStartedRun,
    NOTHING_WAITING,
    runAnsweredModel,
    runShowModel,
    runShowSourceFromJson,
    runStartedModel,
    SHOWN_TASKS,
} from "./runscards";
import type { WshCall } from "./wshcall";

const run = (over: Partial<Run> = {}): Run =>
    ({
        otype: "run",
        oid: "cecf92e7",
        version: 1,
        id: "cecf92e7",
        goal: "Build the thing\nmore",
        mode: "orchestrator",
        runtime: "claude",
        model: "claude-opus-5-5",
        status: "done",
        createdts: 1_000,
        completedts: 1_000 + 39 * 60_000,
        phases: [],
        workspaceid: "w",
        projectpath: "/p",
        ...over,
    }) as Run;

const task = (id: string, label: string): TaskNode => ({ id, label, state: "done" }) as TaskNode;

const group = (n: number, over: Partial<TaskGroup> = {}): TaskGroup =>
    ({
        title: "Slim it",
        tasks: Array.from({ length: n }, (_, i) => task(`t-${i + 1}`, `Task ${i + 1}`)),
        planreview: { state: "passed", round: 2 },
        final: { state: "passed", round: 1 },
        ...over,
    }) as TaskGroup;

const digest = (done: number, total: number, over: Partial<DagStatusDigest> = {}): DagStatusDigest =>
    ({
        counts: { total, done },
        durations: { elapsedms: 5_000 },
        report: {
            commits: [{ taskid: "t-1", commit: "162e7240aaaa" }],
            unverifiednotes: [{ taskid: "t-9", text: "not checked" }],
            usage: [],
        },
        ...over,
    }) as DagStatusDigest;

const row = (role: string, tokens: number): UsageRow =>
    ({ role, input: tokens, output: 0, cacheread: 0, cachewrite: 0, cachewrite1h: 0, msgs: 1 }) as UsageRow;

const call = (path: string[], args: string[] = [], flags: WshCall["flags"] = {}): WshCall => ({ path, args, flags });

describe("runShowSourceFromJson", () => {
    it("reads runs show --json output", () => {
        const src = runShowSourceFromJson({
            channelid: "ch-1",
            run: run(),
            dag: { group: group(2), digest: digest(2, 2) },
            asks: [],
        });
        expect(src?.channelId).toBe("ch-1");
        expect(src?.group?.tasks).toHaveLength(2);
        expect(src?.digest?.counts.total).toBe(2);
    });

    it("takes a run with no dag", () => {
        const src = runShowSourceFromJson({ channelid: "ch-1", run: run({ mode: "quick" }), dag: null });
        expect(src?.group).toBeUndefined();
        expect(src?.digest).toBeUndefined();
    });

    it("refuses output with no run", () => {
        expect(runShowSourceFromJson({ channelid: "ch-1" })).toBeNull();
        expect(runShowSourceFromJson(null)).toBeNull();
    });
});

describe("runShowModel", () => {
    const now = 9_999_999;

    it("builds the view from --json output: tiles, landed sha, tasks, unverified", () => {
        const src = runShowSourceFromJson({
            channelid: "ch-1",
            run: run({ land: { state: "landed", commit: "c72b9fa1234567" } as RunLand }),
            dag: { group: group(9), digest: digest(9, 9) },
        })!;
        const m = runShowModel(src, now);
        expect(m.runId).toBe("cecf92e7");
        expect(m.title).toBe("Slim it");
        expect(m.pill).toMatchObject({ tone: "ok", sha: "c72b9fa" });
        const tiles = Object.fromEntries(m.tiles.map((t) => [t.label, t]));
        expect(tiles["Tasks"].value).toBe("9 of 9");
        expect(tiles["Elapsed"].value).toBe("39m 00s");
        expect(tiles["Plan review"].value).toContain("2");
        expect(tiles["Final"]).toMatchObject({ tone: "ok" });
        expect(tiles["Final"].value).toContain("1");
        expect(m.tasks).toHaveLength(SHOWN_TASKS);
        expect(m.tasks[0]).toEqual({ id: "t-1", title: "Task 1", sha: "162e724" });
        expect(m.tasks[1].sha).toBeUndefined();
        expect(m.moreTasks).toBe(9 - SHOWN_TASKS);
        expect(m.unverified).toEqual([{ taskId: "t-9", text: "not checked" }]);
    });

    it("builds the view from a run and its digest fetched by id", () => {
        const m = runShowModel(
            { run: run({ status: "executing", completedts: undefined }), group: group(3), digest: digest(1, 3) },
            now
        );
        expect(m.pill.text).toBe("executing");
        expect(m.pill.sha).toBeUndefined();
        expect(m.moreTasks).toBe(0);
        expect(m.tasks).toHaveLength(3);
        const elapsed = m.tiles.find((t) => t.label === "Elapsed");
        expect(elapsed?.value).toBeTruthy();
    });

    it("shows a held land as a warning, a failed Final as an error", () => {
        const m = runShowModel(
            {
                run: run({ land: { state: "held", reason: "dirty" } as RunLand }),
                group: group(1, { final: { state: "failed", round: 2 } as FinalStage }),
                digest: digest(1, 1),
            },
            now
        );
        expect(m.pill.tone).toBe("warn");
        expect(m.tiles.find((t) => t.label === "Final")?.tone).toBe("bad");
    });

    it("totals tokens by role, largest first, with a fill per role", () => {
        const m = runShowModel(
            {
                run: run(),
                usage: [
                    row("worker", 14_100_000),
                    row("lead", 10_700_000),
                    row("reviewer", 1_500_000),
                    row("worker", 100_000),
                ],
            },
            now
        );
        expect(m.tokens?.roles.map((r) => [r.role, r.tokens])).toEqual([
            ["worker", 14_200_000],
            ["lead", 10_700_000],
            ["reviewer", 1_500_000],
        ]);
        expect(m.tokens?.total).toBe("26.4M");
        expect(new Set(m.tokens?.roles.map((r) => r.fill)).size).toBe(3);
    });

    it.each([
        { name: "a fast-track dag", autonomous: false, fasttrack: true, meta: "claude opus · fast track" },
        {
            name: "an autonomous fast-track dag",
            autonomous: true,
            fasttrack: true,
            meta: "claude opus · autonomous · fast track",
        },
        { name: "a dag on the full track", autonomous: false, fasttrack: false, meta: "claude opus" },
    ])("words the route for $name", ({ autonomous, fasttrack, meta }) => {
        const m = runShowModel(
            {
                run: run({ autonomous, model: "claude-opus" }),
                group: group(2, { fasttrack }),
                usage: [row("worker", 1_000)],
            },
            now
        );
        expect(m.tokens?.meta).toBe(meta);
    });

    it("labels the end reviewer's tokens", () => {
        const m = runShowModel({ run: run(), usage: [row("end-reviewer", 1_000)] }, now);
        expect(m.tokens?.roles[0]).toMatchObject({ role: "end-reviewer", label: "end reviewer" });
        expect(m.tokens?.roles[0].fill).not.toBe("bg-ink-faint");
    });

    it("omits tokens when nothing was spent", () => {
        expect(runShowModel({ run: run(), usage: [] }, now).tokens).toBeNull();
        expect(runShowModel({ run: run() }, now).tokens).toBeNull();
    });

    it("leaves out the tiles it has no data for", () => {
        const m = runShowModel({ run: run({ mode: "quick" }) }, now);
        expect(m.tiles.map((t) => t.label)).toEqual(["Elapsed"]);
        expect(m.tasks).toEqual([]);
    });
});

describe("attentionModel", () => {
    const item = (over: Partial<AttentionItem> = {}): AttentionItem =>
        ({
            kind: "ask",
            key: "k",
            source: "Lead",
            text: "Approve   the\nfixes?",
            action: "answer",
            phaseidx: 0,
            waitingsince: 1_000,
            runid: "7c03196e",
            ...over,
        }) as AttentionItem;

    it("is empty with no items", () => {
        expect(attentionModel([], 5_000)).toEqual({ empty: true, rows: [] });
        expect(attentionModel(undefined, 5_000).empty).toBe(true);
    });

    it("keeps one row per item, with the run to open and a collapsed text", () => {
        const m = attentionModel([item(), item({ key: "k2", runid: undefined, waitingsince: 0 })], 61_000);
        expect(m.empty).toBe(false);
        expect(m.rows).toHaveLength(2);
        expect(m.rows[0]).toMatchObject({ key: "k", runId: "7c03196e", text: "Approve the fixes?" });
        expect(m.rows[0].waited).toBeTruthy();
        expect(m.rows[1].runId).toBeUndefined();
        expect(m.rows[1].waited).toBeUndefined();
    });
});

describe("attentionStepSummary", () => {
    const call = (flags: WshCall["flags"]): WshCall => ({ path: ["runs", "attention"], args: [], flags });

    it("summarises an empty --json array", () => {
        expect(attentionStepSummary(call({ json: true }), "[]\n")).toBe(NOTHING_WAITING);
        expect(attentionStepSummary(call({ json: "true" }), "[]")).toBe(NOTHING_WAITING);
    });

    it("gives none for a non-empty array", () => {
        expect(attentionStepSummary(call({ json: true }), JSON.stringify([{ key: "k" }]))).toBeUndefined();
    });

    it("gives none without --json, or for output that does not parse as an array", () => {
        expect(attentionStepSummary(call({}), "[]")).toBeUndefined();
        expect(attentionStepSummary(call({ json: true }), undefined)).toBeUndefined();
        expect(attentionStepSummary(call({ json: true }), "nothing is waiting")).toBeUndefined();
        expect(attentionStepSummary(call({ json: true }), "{}")).toBeUndefined();
    });
});

describe("runStartedModel", () => {
    it("names the chunks the run takes, numbered from their labels, with the initiative", () => {
        const m = runStartedModel({
            call: call(["runs", "start"], ["Projection fixes"], { effort: "e-1", chunk: "2. Projection" }),
            run: run({
                id: "b4e17c02",
                title: "Projection fixes: Skill calls",
                status: "planning",
                effortref: { effortoid: "e-1", chunklabel: "3. Refused Bash" },
            }),
            effortTitle: "Rendered view",
        });
        expect(m.title).toBe("Projection fixes: Skill calls");
        expect(m.runId).toBe("b4e17c02");
        expect(m.status).toMatchObject({ text: "planning" });
        expect(m.chunks).toEqual(["2", "3"]);
        expect(m.initiative).toBe("Rendered view");
    });

    it("has no chunk line for an unlinked run", () => {
        const m = runStartedModel({
            call: call(["runs", "start"], ["fix it"], {}),
            run: run({ title: undefined, goal: "fix it" }),
        });
        expect(m.chunks).toEqual([]);
        expect(m.initiative).toBeUndefined();
    });

    it("renders from argv alone when the run is unknown", () => {
        const m = runStartedModel({
            call: call(["runs", "start"], ["Fix the retry bug\nsecond line"], {
                plan: "p.md",
                runtime: "pi",
                model: "m1",
                chunk: "4",
            }),
        });
        expect(m.title).toBe("Fix the retry bug");
        expect(m.runId).toBeUndefined();
        expect(m.status).toBeUndefined();
        expect(m.mode).toBe("orchestrator");
        expect(m.runtimeModel).toContain("pi");
        expect(m.chunks).toEqual(["4"]);
    });

    it("defaults to a quick run when no plan or mode is given", () => {
        expect(runStartedModel({ call: call(["runs", "start"], ["go"]) }).mode).toBe("quick");
    });
});

describe("matchStartedRun", () => {
    const at = 100_000;
    const runs = [
        run({ id: "r-old", goal: "Fix it", createdts: at - 60_000 }),
        run({ id: "r-new", goal: "Fix it", createdts: at + 500 }),
        run({ id: "r-other", goal: "Other", createdts: at + 600 }),
    ];

    it("takes the run created in the call's window whose goal matches", () => {
        expect(matchStartedRun(runs, { goal: "Fix it", ts: at, durationMs: 1_000 })?.id).toBe("r-new");
    });

    it("with no goal takes the one run created in the window, never a guess among several", () => {
        expect(matchStartedRun([runs[0], runs[1]], { ts: at, durationMs: 1_000 })?.id).toBe("r-new");
        expect(matchStartedRun(runs, { ts: at, durationMs: 1_000 })).toBeUndefined();
    });

    it("finds nothing without the call's time", () => {
        expect(matchStartedRun(runs, { goal: "Fix it" })).toBeUndefined();
    });
});

describe("runAnsweredModel", () => {
    const CALL_TS = 10_000;
    const asks = [
        {
            taskid: "",
            ts: CALL_TS - 1,
            questions: [
                { question: "Approve the fixes?", options: [{ label: "Approve and land" }, { label: "Hold" }] },
            ],
        } as unknown as DagAskItem,
    ];

    it("reads the run id and the picked answers from argv", () => {
        const m = runAnsweredModel({ call: call(["runs", "answer"], ["7c03196e", '[{"selectedindexes":[1]}]']) });
        expect(m.runId).toBe("7c03196e");
        expect(m.items).toHaveLength(1);
        expect(m.items[0].picked).toHaveLength(1);
        expect(m.items[0].question).toBeUndefined();
    });

    it("names the question and the option labels when the ask is still known", () => {
        const m = runAnsweredModel({
            call: call(["runs", "answer"], ["7c03196e", '[{"selectedindexes":[0]}]']),
            asks,
            ts: CALL_TS,
        });
        expect(m.items[0]).toEqual({ question: "Approve the fixes?", picked: ["Approve and land"] });
    });

    it("does not name a question raised after the call ran", () => {
        const later = [{ ...asks[0], ts: CALL_TS + 1 }];
        const m = runAnsweredModel({
            call: call(["runs", "answer"], ["7c03196e", '[{"selectedindexes":[0]}]']),
            asks: later,
            ts: CALL_TS,
        });
        expect(m.items[0].question).toBeUndefined();
        expect(m.items[0].picked).toEqual(["Option 1"]);
    });

    it("names no question when the call has no time", () => {
        const m = runAnsweredModel({ call: call(["runs", "answer"], ["r", '[{"selectedindexes":[0]}]']), asks });
        expect(m.items[0]).toEqual({ picked: ["Option 1"] });
    });

    it("shows a typed answer as typed and several picks of a multi-select", () => {
        const typed = runAnsweredModel({ call: call(["runs", "answer"], ["r", '[{"text":"ship it"}]']) });
        expect(typed.items[0].picked).toEqual(["ship it"]);
        const multi = runAnsweredModel({
            call: call(["runs", "answer"], ["r", '[{"selectedindexes":[0,1]}]']),
            asks,
            ts: CALL_TS,
        });
        expect(multi.items[0].picked).toEqual(["Approve and land", "Hold"]);
    });

    it("survives answers that are not JSON", () => {
        const m = runAnsweredModel({ call: call(["runs", "answer"], ["r", "nope"]) });
        expect(m.runId).toBe("r");
        expect(m.items).toEqual([]);
    });
});
