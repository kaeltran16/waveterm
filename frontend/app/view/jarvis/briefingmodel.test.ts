// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { AgentVM } from "@/app/view/agents/agentsviewmodel";
import { describe, expect, it } from "vitest";
import { EFFORT_FIXTURES } from "./briefingfixtures";
import {
    ackableRuns,
    ACTIVE_CAP,
    buildAttentionQueue,
    capRegion,
    DELTA_CAP,
    EFFORT_CAP,
    groupDelta,
    mergeActiveWork,
    projectBriefing,
    queueAction,
    queueKindLabel,
    queueOpenTarget,
    SHIPPED_CAP,
    summarizeAttentionQueue,
    type AgentRow,
    type BlockerRow,
    type BriefingModelInput,
    type DeltaRow,
    type QueueRow,
    type RunRow,
} from "./briefingmodel";
import type { EffortCardModel } from "./effortmodel";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const T0 = 1_800_000_000_000;

const agent = (over: Partial<AgentVM>): AgentVM => ({
    id: "tab-1",
    name: "loom",
    task: "ship the briefing",
    state: "working",
    agent: "claude",
    project: "waveterm",
    activeMs: 5 * 60_000,
    ...over,
});

const workState = (projects: ProjectWork[]): WorkState => ({
    projects,
    sources: { runs: true, sessions: true, dossiers: true, efforts: true, attention: "volatile" },
});

const runItem = (over: Partial<ActiveWorkItem>): ActiveWorkItem => ({
    project: "/p/one",
    kind: "run",
    title: "ship ledger",
    detail: "status: executing",
    ts: T0 - DAY,
    navtarget: "run:r-1",
    ...over,
});

const input = (state: WorkState, agents: AgentVM[] = [], cursor = T0 - DAY): BriefingModelInput => ({
    state,
    agents,
    actualCursor: cursor,
    queryStartedAt: T0,
    sevenDaysAgo: T0 - 7 * DAY,
});

describe("briefing projection", () => {
    it("suppresses a live agent already represented by an active run, exactly by tab oref", () => {
        const state = workState([
            {
                project: "waveterm",
                active: [
                    runItem({ workerorefs: ["tab:a", "tab:b"] }),
                    runItem({ title: "other run", detail: "status: blocked", ts: T0 - 2 * DAY, navtarget: "run:r-2" }),
                ],
                shipped: [],
                events: [],
                delta: [],
            },
        ]);
        const roster = [
            agent({ id: "a", name: "run worker", state: "working" }),
            agent({ id: "x", name: "direct", state: "working", project: undefined }),
            agent({ id: "term", name: "shell", state: "working", kind: "terminal" }),
            agent({ id: "bg", name: "bg", state: "working", kind: "background" }),
            agent({ id: "idle", name: "idle", state: "idle" }),
        ];
        const m = projectBriefing(input(state, roster));
        // "a" and "b" are suppressed (in r-1's workerorefs); "x" remains a direct agent; terminal,
        // background and idle rows are excluded; pending-launch overlays (kind undefined) stay.
        expect(m.directAgents.map((a) => a.id)).toEqual(["x"]);
        expect(m.counts.agents).toBe(1);
        expect(m.counts.runs).toBe(2);
    });

    it("includes pending-launch overlays as direct agents", () => {
        const state = workState([]);
        const m = projectBriefing(input(state, [agent({ id: "p", state: "working", kind: undefined })]));
        expect(m.directAgents.map((a) => a.id)).toEqual(["p"]);
    });

    it("sorts runs blocked-first then ts-desc then oref, agents asking-first then roster order", () => {
        const state = workState([
            {
                project: "waveterm",
                active: [
                    runItem({
                        title: "newer executing",
                        ts: T0 - DAY,
                        navtarget: "run:r-b",
                        detail: "status: executing",
                    }),
                    runItem({ title: "blocked", ts: T0 - 3 * DAY, navtarget: "run:r-a", detail: "status: blocked" }),
                    runItem({
                        title: "older executing",
                        ts: T0 - 2 * DAY,
                        navtarget: "run:r-c",
                        detail: "status: executing",
                    }),
                ],
                shipped: [],
                events: [],
                delta: [],
            },
        ]);
        const m = projectBriefing(
            input(state, [
                agent({ id: "tab-1", name: "w1", state: "working", activeMs: 10 * 60_000 }),
                agent({ id: "tab-2", name: "a1", state: "asking", blockedMs: 60_000 }),
                agent({ id: "tab-3", name: "w2", state: "working", activeMs: 60_000 }),
            ])
        );
        expect(m.activeRuns.map((r) => r.oref)).toEqual(["run:r-a", "run:r-b", "run:r-c"]);
        // asking first; then roster order, whatever each has been doing lately
        expect(m.directAgents.map((a) => a.id)).toEqual(["tab-2", "tab-1", "tab-3"]);
    });

    it("windows delta to actualCursor and words events honestly", () => {
        const delta: TimelineEvent[] = [
            { ts: T0 - DAY, kind: "run-created", title: "g1", detail: "status: executing", navtarget: "run:r-1" },
            { ts: T0 - 2 * DAY, kind: "run-done", title: "g2", detail: "sealed", navtarget: "run:r-2" },
            { ts: T0 - 3 * DAY, kind: "decision", title: "chose sqlite" },
            {
                ts: T0 - 4 * DAY,
                kind: "dossier",
                title: "ship ledger",
                detail: "status: active",
                navtarget: "task:d-1",
            },
            { ts: T0 - 10 * DAY, kind: "run-created", title: "stale", detail: "", navtarget: "run:r-9" },
            { ts: T0 - 5 * DAY, kind: "session", title: "a session", detail: "pi m" },
        ];
        const m = projectBriefing(
            input(workState([{ project: "waveterm", active: [], shipped: [], events: delta, delta }]), [], T0 - 6 * DAY)
        );
        const kinds = m.delta.map((d) => d.kind);
        expect(kinds).not.toContain("session"); // session rows are excluded entirely
        expect(m.delta.map((d) => d.title)).not.toContain("stale"); // the 10-day-old one is outside the cursor window
        expect(m.delta.map((d) => d.wording)).toEqual([
            "Run started",
            "Run completed",
            "Decision recorded",
            "Record updated · current status: active",
        ]);
        expect(m.delta.find((d) => d.kind === "dossier")?.oref).toBe("task:d-1");
    });

    it("promotes in-window completions to New shipped rows and keeps older completions in delta", () => {
        const shipped: ShippedItem[] = [
            { project: "waveterm", runoid: "r-new", goal: "new work", summary: "sealed", completedts: T0 - DAY },
        ];
        const delta: TimelineEvent[] = [
            { ts: T0 - DAY, kind: "run-done", title: "new work", detail: "sealed", navtarget: "run:r-new" },
            { ts: T0 - 8 * DAY, kind: "run-done", title: "old work", detail: "sealed", navtarget: "run:r-old" },
        ];
        const m = projectBriefing(
            input(workState([{ project: "waveterm", active: [], shipped, events: delta, delta }]), [], T0 - 9 * DAY)
        );
        expect(m.shipped.map((s) => s.oref)).toEqual(["run:r-new"]);
        expect(m.shipped[0].fresh).toBe(true);
        expect(m.delta.map((d) => d.kind)).toEqual(["run-done"]); // only the old completion remains
        expect(m.delta[0].title).toBe("old work");
    });

    it("orders shipped rows newest first across projects", () => {
        const item = (project: string, runoid: string, completedts: number): ShippedItem => ({
            project,
            runoid,
            goal: runoid,
            summary: "sealed",
            completedts,
        });
        const m = projectBriefing(
            input(
                workState([
                    { project: "/a", active: [], shipped: [item("/a", "a-old", T0 - 3 * DAY)], events: [], delta: [] },
                    {
                        project: "/b",
                        active: [],
                        shipped: [item("/b", "b-new", T0 - DAY), item("/b", "b-mid", T0 - 2 * DAY)],
                        events: [],
                        delta: [],
                    },
                ])
            )
        );
        expect(m.shipped.map((s) => s.oref)).toEqual(["run:b-new", "run:b-mid", "run:a-old"]);
    });

    it("removes current attention items from delta rather than showing both", () => {
        const active: ActiveWorkItem[] = [
            {
                project: "/p/one",
                kind: "attention",
                title: "the ask bridge",
                detail: "Review: check the diff",
                ts: T0 - DAY,
                navtarget: "run:r-1",
            },
        ];
        const delta: TimelineEvent[] = [
            {
                ts: T0 - DAY,
                kind: "attention",
                title: "the ask bridge",
                detail: "Review: check the diff",
                navtarget: "run:r-1",
            },
        ];
        const m = projectBriefing(
            input(workState([{ project: "waveterm", active, shipped: [], events: delta, delta }]))
        );
        expect(m.delta).toHaveLength(0); // the snapshot's attention item deduped the delta event
        expect(m.activeRuns).toHaveLength(0); // attention is queue-only, never an active-work row
    });

    it("removes a delta event only when ts, title and detail all equal a current attention item's", () => {
        const attention: ActiveWorkItem = {
            project: "/p/one",
            kind: "attention",
            title: "the ask",
            detail: "check it",
            ts: T0 - HOUR,
        };
        const ev = (over: Partial<TimelineEvent>): TimelineEvent => ({
            ts: T0 - HOUR,
            kind: "decision",
            title: "the ask",
            detail: "check it",
            ...over,
        });
        const delta: TimelineEvent[] = [
            ev({}),
            ev({ ts: T0 - 2 * HOUR }),
            ev({ title: "another ask" }),
            ev({ detail: "check something else" }),
            ev({ ts: T0 - 3 * HOUR, title: "unrelated", detail: "unrelated" }),
        ];
        const m = projectBriefing(
            input(workState([{ project: "waveterm", active: [attention], shipped: [], events: [], delta }]))
        );
        expect(m.delta.map((d) => [d.ts, d.title, d.detail])).toEqual([
            [T0 - 2 * HOUR, "the ask", "check it"],
            [T0 - HOUR, "another ask", "check it"],
            [T0 - HOUR, "the ask", "check something else"],
            [T0 - 3 * HOUR, "unrelated", "unrelated"],
        ]);
    });

    it("orders active runs newest first, then by oref when they are equally new", () => {
        const runs = [
            runItem({ ts: T0 - 3 * HOUR, navtarget: "run:r-a" }),
            runItem({ ts: T0 - HOUR, navtarget: "run:r-c" }),
            runItem({ ts: T0 - HOUR, navtarget: "run:r-b" }),
        ];
        const m = projectBriefing(
            input(workState([{ project: "waveterm", active: runs, shipped: [], events: [], delta: [] }]))
        );
        expect(m.activeRuns.map((r) => r.oref)).toEqual(["run:r-b", "run:r-c", "run:r-a"]);
    });

    it("labels unscoped blockers and keeps their target", () => {
        const active: ActiveWorkItem[] = [
            {
                project: "",
                kind: "blocker",
                title: "ship ledger",
                detail: "needs decision on X",
                ts: T0 - DAY,
                navtarget: "task:d-1",
            },
        ];
        const m = projectBriefing(input(workState([{ project: "", active, shipped: [], events: [], delta: [] }])));
        expect(m.blockers).toHaveLength(1);
        expect(m.blockers[0].project).toBeNull(); // view renders "Unscoped record"
        expect(m.blockers[0].oref).toBe("task:d-1");
    });

    it("reports complete vs partial source health", () => {
        const complete = projectBriefing(input(workState([])));
        expect(complete.health.complete).toBe(true);
        const p = workState([]);
        p.sources = { runs: false, sessions: true, dossiers: true, efforts: true, attention: "volatile" };
        const m = projectBriefing(input(p));
        expect(m.health.complete).toBe(false);
        expect(m.health.missingLegs).toEqual(["Runs"]);
    });

    it("excludes shipped rows outside the seven-day window", () => {
        const shipped: ShippedItem[] = [
            { project: "waveterm", runoid: "r-new", goal: "new", summary: "", completedts: T0 - DAY },
            { project: "waveterm", runoid: "r-old", goal: "old", summary: "", completedts: T0 - 8 * DAY },
        ];
        const m = projectBriefing(
            input(workState([{ project: "waveterm", active: [], shipped, events: [], delta: [] }]))
        );
        expect(m.shipped.map((s) => s.oref)).toEqual(["run:r-new"]);
    });

    it("projects efforts, non-archived only, and leaves the display window to the view", () => {
        const state = workState([{ project: "waveterm", active: [], shipped: [], events: [], delta: [] }]);
        state.efforts = EFFORT_FIXTURES;
        const m = projectBriefing(input(state));
        expect(m.efforts.map((e) => e.title)).toEqual(["Scenario gate clearance", "Reflux state-layer migration"]);
        // 8 efforts in, 7 projected (archived never counts), and the cap is what the region opens at
        const many = [
            ...EFFORT_FIXTURES,
            ...Array.from({ length: 6 }, (_, i) => ({
                oref: `effort:e${i}`,
                title: `effort ${i}`,
                status: i === 0 ? "archived" : "active",
                done: 0,
                total: 1,
                updatedts: T0 - i * HOUR,
                chunks: [{ label: "c", status: "pending" }],
            })),
        ] as WorkState["efforts"];
        const m2 = projectBriefing(input({ ...state, efforts: many }));
        expect(m2.efforts).toHaveLength(7);
        expect(m2.efforts.some((e) => e.title === "effort 0")).toBe(false); // archived excluded
        expect(capRegion(m2.efforts, EFFORT_CAP, false)).toMatchObject({ more: 1 });
        expect(capRegion(m2.efforts, EFFORT_CAP, true).rows).toHaveLength(7);
    });

    it("folds blocked chunks into the queue", () => {
        const state = workState([{ project: "waveterm", active: [], shipped: [], events: [], delta: [] }]);
        state.efforts = EFFORT_FIXTURES;
        const m = projectBriefing(input(state));
        const q = buildAttentionQueue({ attention: [], efforts: m.efforts });
        const row = q.find((r) => r.title === "Phase 5");
        expect(row?.kind).toBe("chunk blocked");
        expect(row?.detail).toBe("Scenario gate clearance");
        expect(row?.nav).toEqual({ kind: "effort", oref: "effort:scenario-gate" });
    });

    it("projects every delta row the window holds, and the cap hides two of them", () => {
        const events = Array.from({ length: 12 }, (_, i) => ({
            ts: T0 - i * HOUR,
            kind: "run-created",
            title: `r${i}`,
        })) as TimelineEvent[];
        const state = workState([{ project: "waveterm", active: [], shipped: [], events, delta: events }]);
        const m = projectBriefing(input(state));
        expect(m.delta).toHaveLength(12);
        expect(m.counts.delta).toBe(12); // the pill keeps the true count
        expect(capRegion(m.delta, DELTA_CAP, false)).toMatchObject({ more: 7 });
    });

    it("projects every active leg and shipped row, each capped on its own", () => {
        const active = Array.from({ length: 10 }, (_, i) =>
            runItem({ title: `run ${i}`, ts: T0 - i * HOUR, navtarget: `run:r-${i}` })
        );
        const shipped: ShippedItem[] = Array.from({ length: 10 }, (_, i) => ({
            project: "waveterm",
            runoid: `rs-${i}`,
            goal: `shipped ${i}`,
            summary: "",
            completedts: T0 - i * HOUR,
        }));
        const state = workState([{ project: "waveterm", active, shipped, events: [], delta: [] }]);
        const m = projectBriefing(input(state));
        expect(m.activeRuns).toHaveLength(10);
        expect(m.shipped).toHaveLength(10);
        expect(m.counts.runs).toBe(10);
        expect(m.counts.shipped).toBe(10);
        expect(capRegion(m.activeRuns, ACTIVE_CAP, false)).toMatchObject({ more: 2 });
        expect(capRegion(m.shipped, SHIPPED_CAP, false)).toMatchObject({ more: 7 });
    });
});

describe("briefing projection fields", () => {
    const quiet = { shipped: [], events: [], delta: [] };
    const onlyActive = (active: ActiveWorkItem[]) =>
        projectBriefing(input(workState([{ project: "/p/one", active, ...quiet }])));

    it("reads every field of a run from its snapshot item, defaulting what the item leaves out", () => {
        const m = onlyActive([
            runItem({
                title: "ship ledger",
                detail: "status: blocked",
                navtarget: "run:r-1",
                workerorefs: ["tab:a"],
                mode: "orchestrator",
                ts: T0 - HOUR,
            }),
            runItem({
                title: "bare",
                detail: undefined,
                navtarget: undefined,
                mode: undefined,
                workerorefs: undefined,
                ts: T0 - 2 * HOUR,
            }),
            runItem({ title: "plain detail", detail: "needs a human", navtarget: "task:run:r-3", ts: T0 - 3 * HOUR }),
        ]);
        expect(m.activeRuns).toEqual([
            {
                oref: "run:r-1",
                oid: "r-1",
                goal: "ship ledger",
                project: "/p/one",
                status: "blocked",
                workerOrefs: ["tab:a"],
                mode: "orchestrator",
                ts: T0 - HOUR,
            },
            {
                oref: "run:",
                oid: "",
                goal: "bare",
                project: "/p/one",
                status: "",
                workerOrefs: [],
                mode: "",
                ts: T0 - 2 * HOUR,
            },
            {
                // only a leading run: is the type prefix; the same text inside an id is part of it
                oref: "task:run:r-3",
                oid: "task:run:r-3",
                goal: "plain detail",
                project: "/p/one",
                status: "needs a human",
                workerOrefs: [],
                mode: "",
                ts: T0 - 3 * HOUR,
            },
        ]);
    });

    it("orders runs of one status newest first, then by oref, whatever order they arrive in", () => {
        const at = (navtarget: string, ts: number) => runItem({ navtarget, ts });
        const m = onlyActive([
            at("run:r-old", T0 - 3 * HOUR),
            at("run:r-new", T0 - HOUR),
            at("run:z", T0 - 2 * HOUR),
            at("run:a", T0 - 2 * HOUR),
        ]);
        expect(m.activeRuns.map((r) => r.oref)).toEqual(["run:r-new", "run:a", "run:z", "run:r-old"]);
    });

    it("takes only blockers into the blocker rows, and only runs into the run rows", () => {
        const m = onlyActive([
            { project: "/p/one", kind: "attention", title: "an ask", detail: "d", ts: T0, navtarget: "run:r-9" },
            runItem({ navtarget: "run:r-1" }),
            {
                project: "/p/one",
                kind: "blocker",
                title: "gate",
                detail: "needs X",
                ts: T0 - HOUR,
                navtarget: "task:d-1",
            },
        ]);
        expect(m.activeRuns.map((r) => r.oref)).toEqual(["run:r-1"]);
        expect(m.blockers).toEqual([
            { oref: "task:d-1", objective: "gate", blockers: "needs X", project: "/p/one", ts: T0 - HOUR },
        ]);
    });

    it("defaults a blocker's missing detail, target and scope, and keeps an unscoped one null", () => {
        const m = onlyActive([
            { project: "", kind: "blocker", title: "bare", ts: T0 - HOUR },
            {
                project: "/p/one",
                kind: "blocker",
                title: "scoped",
                detail: "waits",
                ts: T0 - 2 * HOUR,
                navtarget: "task:d-2",
            },
        ]);
        expect(m.blockers).toEqual([
            { oref: "", objective: "bare", blockers: "", project: null, ts: T0 - HOUR },
            { oref: "task:d-2", objective: "scoped", blockers: "waits", project: "/p/one", ts: T0 - 2 * HOUR },
        ]);
    });

    it("orders blockers newest first, then by oref, whatever order they arrive in", () => {
        const at = (navtarget: string, ts: number): ActiveWorkItem => ({
            project: "/p/one",
            kind: "blocker",
            title: navtarget,
            ts,
            navtarget,
        });
        const m = onlyActive([
            at("task:old", T0 - 3 * HOUR),
            at("task:new", T0 - HOUR),
            at("task:z", T0 - 2 * HOUR),
            at("task:a", T0 - 2 * HOUR),
        ]);
        expect(m.blockers.map((b) => b.oref)).toEqual(["task:new", "task:a", "task:z", "task:old"]);
    });

    it("projects each direct agent's fields, asking agents first, then the roster order", () => {
        const roster = [
            agent({ id: "w1", name: "loom", task: "ship it", activeMs: 120_000, blockedMs: 7_000 }),
            agent({
                id: "a1",
                name: "quill",
                state: "asking",
                task: undefined,
                agent: undefined,
                project: undefined,
                blockedMs: 60_000,
                activeMs: 300_000,
            }),
            agent({ id: "a2", name: "sage", state: "asking", task: "t2", blockedMs: undefined, activeMs: 300_000 }),
            agent({ id: "w2", name: "flux", activeMs: undefined }),
        ];
        const m = projectBriefing(input(workState([]), roster));
        expect(m.directAgents).toEqual([
            {
                oref: "agent:a1",
                id: "a1",
                name: "quill",
                task: "quill",
                runtime: "",
                project: null,
                state: "asking",
                startedTs: T0 - 60_000,
            },
            {
                oref: "agent:a2",
                id: "a2",
                name: "sage",
                task: "t2",
                runtime: "claude",
                project: "waveterm",
                state: "asking",
                startedTs: T0,
            },
            {
                oref: "agent:w1",
                id: "w1",
                name: "loom",
                task: "ship it",
                runtime: "claude",
                project: "waveterm",
                state: "working",
                startedTs: T0 - 120_000,
            },
            {
                oref: "agent:w2",
                id: "w2",
                name: "flux",
                task: "ship the briefing",
                runtime: "claude",
                project: "waveterm",
                state: "working",
                startedTs: T0,
            },
        ]);
    });

    it("projects every shipped field and marks fresh only the run whose completion is in the delta", () => {
        const shipped: ShippedItem[] = [
            {
                project: "waveterm",
                runoid: "r-a",
                goal: "ga",
                summary: "done a",
                completedts: T0 - DAY,
                hasreport: true,
                effortoid: "e-1",
                chunklabel: "c1",
                mode: "orchestrator",
            },
            { project: "waveterm", runoid: "r-b", goal: "gb", completedts: T0 - 2 * DAY, hasreport: false },
            // exactly seven days old is still inside the window
            { project: "waveterm", runoid: "r-c", goal: "gc", completedts: T0 - 7 * DAY },
        ];
        const delta: TimelineEvent[] = [
            { ts: T0 - DAY, kind: "run-done", title: "ga", navtarget: "run:r-a" },
            { ts: T0 - DAY, kind: "run-created", title: "ga", navtarget: "run:r-a" },
            { ts: T0 - 2 * DAY, kind: "run-created", title: "gb", navtarget: "run:r-b" },
        ];
        const m = projectBriefing(
            input(workState([{ project: "waveterm", active: [], shipped, events: delta, delta }]), [], T0 - 9 * DAY)
        );
        expect(m.shipped).toEqual([
            {
                oref: "run:r-a",
                goal: "ga",
                project: "waveterm",
                summary: "done a",
                completedTs: T0 - DAY,
                fresh: true,
                hasReport: true,
                effortOid: "e-1",
                chunkLabel: "c1",
                mode: "orchestrator",
            },
            {
                oref: "run:r-b",
                goal: "gb",
                project: "waveterm",
                summary: "",
                completedTs: T0 - 2 * DAY,
                fresh: false,
                hasReport: false,
                effortOid: "",
                chunkLabel: "",
                mode: "",
            },
            {
                oref: "run:r-c",
                goal: "gc",
                project: "waveterm",
                summary: "",
                completedTs: T0 - 7 * DAY,
                fresh: false,
                hasReport: false,
                effortOid: "",
                chunkLabel: "",
                mode: "",
            },
        ]);
        // only the completion is promoted into shipped; the same run's other events stay in the delta
        expect(m.delta.map((d) => [d.kind, d.oref])).toEqual([
            ["run-created", "run:r-a"],
            ["run-created", "run:r-b"],
        ]);
    });

    it("projects every delta field, keeps an event exactly at the cursor, and nulls what it lacks", () => {
        const delta: TimelineEvent[] = [
            { ts: T0 - DAY, kind: "decision", title: "chose sqlite", detail: "because", navtarget: "decision:d1" },
            { ts: T0 - DAY - 1, kind: "decision", title: "too old" },
            { ts: T0 - HOUR, kind: "decision", title: "bare" },
        ];
        const m = projectBriefing(
            input(workState([{ project: "waveterm", active: [], shipped: [], events: delta, delta }]))
        );
        expect(m.delta).toEqual([
            {
                key: `decision:${T0 - DAY}:chose sqlite`,
                ts: T0 - DAY,
                kind: "decision",
                title: "chose sqlite",
                wording: "Decision recorded",
                detail: "because",
                oref: "decision:d1",
            },
            {
                key: `decision:${T0 - HOUR}:bare`,
                ts: T0 - HOUR,
                kind: "decision",
                title: "bare",
                wording: "Decision recorded",
                detail: null,
                oref: null,
            },
        ]);
    });

    it("names each source leg the snapshot could not read", () => {
        const sources = (runs: boolean, dossiers: boolean) => {
            const state = workState([]);
            state.sources = { runs, sessions: true, dossiers, efforts: true, attention: "volatile" };
            return projectBriefing(input(state)).health;
        };
        expect(sources(true, false)).toEqual({ complete: false, missingLegs: ["Records"], attentionState: "volatile" });
        expect(sources(false, false)).toEqual({
            complete: false,
            missingLegs: ["Runs", "Records"],
            attentionState: "volatile",
        });
    });

    it("orders the efforts newest-updated first whatever order the wire sent", () => {
        const effortAt = (title: string, updatedts: number) => ({
            oref: `effort:${title}`,
            title,
            status: "active",
            done: 0,
            total: 1,
            updatedts,
            chunks: [{ label: "c", status: "pending" }],
        });
        const state = workState([]);
        state.efforts = [
            effortAt("old", T0 - 3 * HOUR),
            effortAt("new", T0 - HOUR),
            effortAt("mid", T0 - 2 * HOUR),
        ] as WorkState["efforts"];
        expect(projectBriefing(input(state)).efforts.map((e) => e.title)).toEqual(["new", "mid", "old"]);
    });
});

describe("delta grouping", () => {
    // fixed local noon — calendar-day buckets must not depend on the runner's TZ.
    const NOON = new Date(2027, 0, 15, 12, 0, 0).getTime();
    const day = (d: number, h: number) => new Date(2027, 0, d, h, 0, 0).getTime();
    const deltaRow = (ts: number, title: string): DeltaRow => ({
        key: "k:" + title,
        ts,
        kind: "run-done",
        title,
        wording: "Run completed",
        detail: null,
        oref: null,
    });

    it("buckets by calendar day into Today / Yesterday / Earlier", () => {
        const groups = groupDelta(
            [
                deltaRow(day(15, 9), "this-morning"),
                deltaRow(day(14, 23), "last-night"),
                deltaRow(day(13, 10), "two-days-ago"),
            ],
            NOON
        );
        expect(groups.map((g) => g.label)).toEqual(["Today", "Yesterday", "Earlier"]);
        expect(groups[0].rows.map((r) => r.title)).toEqual(["this-morning"]);
        expect(groups[1].rows.map((r) => r.title)).toEqual(["last-night"]);
        expect(groups[2].rows.map((r) => r.title)).toEqual(["two-days-ago"]);
    });

    it("treats midnight as the day boundary", () => {
        const groups = groupDelta([deltaRow(day(15, 0), "midnight"), deltaRow(day(14, 0), "yesterday-midnight")], NOON);
        expect(groups[0].rows.map((r) => r.title)).toEqual(["midnight"]);
        expect(groups[1].rows.map((r) => r.title)).toEqual(["yesterday-midnight"]);
    });

    it("omits empty groups and returns nothing for an empty delta", () => {
        expect(groupDelta([deltaRow(day(14, 10), "only-yesterday")], NOON).map((g) => g.label)).toEqual(["Yesterday"]);
        expect(groupDelta([], NOON)).toEqual([]);
    });
});

describe("unified active work", () => {
    const run = (over: Partial<RunRow> = {}): RunRow => ({
        oref: "run:r1",
        oid: "r1",
        goal: "run goal",
        project: "waveterm",
        status: "running",
        workerOrefs: [],
        mode: "quick",
        ts: T0 - 2 * HOUR,
        ...over,
    });
    const blocker = (over: Partial<BlockerRow> = {}): BlockerRow => ({
        oref: "task:b1",
        objective: "blocked thing",
        blockers: "waiting on x",
        project: "waveterm",
        ts: T0 - 2 * HOUR,
        ...over,
    });
    const agentRow = (over: Partial<AgentRow> = {}): AgentRow => ({
        oref: "agent:a1",
        id: "a1",
        name: "loom",
        task: "the task",
        runtime: "claude",
        project: "waveterm",
        state: "working",
        startedTs: T0 - 2 * HOUR,
        ...over,
    });

    it("needing-eyes first, then dated rows by recency, then agents in roster order", () => {
        const rows = mergeActiveWork({
            activeRuns: [run({ ts: T0 - HOUR }), run({ oref: "run:r2", ts: T0 - 4 * HOUR, status: "blocked" })],
            blockers: [blocker({ ts: T0 - 2 * HOUR })],
            directAgents: [agentRow({ state: "asking", startedTs: T0 - 3 * HOUR })],
        });
        // needing-eyes (blocked run, blocker, asking agent) first; within a tier, dated rows then agents:
        expect(rows.map((r) => r.kind)).toEqual(["blocker", "run", "agent", "run"]);
        // then the remaining run (1h ago) before… no — it is the only score-1 row here, so it is last.
        expect(rows[3].oref).toBe("run:r1");
        expect(rows[3].chip).toEqual({ label: "running", tone: "running" });
    });

    it("chips: blocked runs, asking agents, and only unscoped blockers", () => {
        const rows = mergeActiveWork({
            activeRuns: [run({ status: "blocked" })],
            blockers: [blocker({ project: null })],
            directAgents: [agentRow({ state: "asking" })],
        });
        expect(rows.find((r) => r.kind === "run")!.chip).toEqual({ label: "blocked", tone: "blocked" });
        expect(rows.find((r) => r.kind === "blocker")!.chip).toEqual({ label: "Unscoped record", tone: "muted" });
        expect(rows.find((r) => r.kind === "agent")!.chip).toEqual({ label: "asking", tone: "asking" });
    });

    it("carries name, meta, oref, and recency for each kind", () => {
        const rows = mergeActiveWork({
            activeRuns: [run({ project: "waveterm", status: "running" })],
            blockers: [blocker({ objective: "gate decision", blockers: "needs the spawn gate" })],
            directAgents: [agentRow({ state: "working", startedTs: T0 - 5 * HOUR })],
        });
        const byKind = Object.fromEntries(rows.map((r) => [r.kind, r]));
        expect(byKind.run!.name).toBe("run goal");
        expect(byKind.run!.meta).toBe("waveterm · running");
        expect(byKind.run!.oref).toBe("run:r1");
        expect(byKind.blocker!.name).toBe("gate decision");
        expect(byKind.blocker!.meta).toBe("needs the spawn gate");
        expect(byKind.agent!.name).toBe("loom · the task");
        expect(byKind.agent!.meta).toBe("claude · waveterm");
        expect(byKind.agent!.ts).toBe(T0 - 5 * HOUR);
    });

    it("keeps its order when an agent starts a new turn", () => {
        const state = workState([
            {
                project: "waveterm",
                active: [
                    runItem({ ts: T0 - HOUR, navtarget: "run:r-new" }),
                    runItem({ ts: T0 - 3 * HOUR, navtarget: "run:r-old" }),
                ],
                shipped: [],
                events: [],
                delta: [],
            },
        ]);
        const order = (agents: AgentVM[]) =>
            mergeActiveWork({ ...projectBriefing(input(state, agents)), blockers: [] }).map((r) => r.oref);
        const before = order([agent({ id: "tab-1", activeMs: 2 * HOUR }), agent({ id: "tab-2", activeMs: 4 * HOUR })]);
        // tab-2's status changed a moment ago (a new prompt), which resets the time in its state
        const after = order([agent({ id: "tab-1", activeMs: 2 * HOUR }), agent({ id: "tab-2", activeMs: 1000 })]);
        expect(after).toEqual(before);
    });

    it("joins only the meta parts that are present", () => {
        const rows = mergeActiveWork({
            activeRuns: [run({ status: "" })],
            blockers: [],
            directAgents: [agentRow({ runtime: "" }), agentRow({ id: "a2", oref: "agent:a2", project: null })],
        });
        expect(rows.find((r) => r.kind === "run")!.meta).toBe("waveterm");
        expect(rows.filter((r) => r.kind === "agent").map((r) => r.meta)).toEqual(["waveterm", "claude"]);
    });

    it("chips a run with its own status, or running when it has none", () => {
        const rows = mergeActiveWork({
            activeRuns: [run({ status: "queued" }), run({ oref: "run:r2", status: "" })],
            blockers: [],
            directAgents: [],
        });
        expect(rows.find((r) => r.oref === "run:r1")!.chip).toEqual({ label: "queued", tone: "running" });
        expect(rows.find((r) => r.oref === "run:r2")!.chip).toEqual({ label: "running", tone: "running" });
    });

    it("gives a scoped blocker no chip and a working agent a running chip", () => {
        const rows = mergeActiveWork({
            activeRuns: [],
            blockers: [blocker({ project: "waveterm" })],
            directAgents: [agentRow({ state: "working" })],
        });
        expect(rows.find((r) => r.kind === "blocker")!.chip).toBeNull();
        expect(rows.find((r) => r.kind === "agent")!.chip).toEqual({ label: "working", tone: "running" });
    });

    it("puts a blocker and an asking agent ahead of a newer running run", () => {
        const rows = mergeActiveWork({
            activeRuns: [run({ ts: T0 })],
            blockers: [blocker({ ts: T0 - 5 * HOUR })],
            directAgents: [agentRow({ state: "asking", startedTs: T0 - 6 * HOUR })],
        });
        expect(rows.map((r) => r.kind)).toEqual(["blocker", "agent", "run"]);
    });

    it("keeps agents in roster order whatever their timestamps say", () => {
        const rows = mergeActiveWork({
            activeRuns: [],
            blockers: [],
            directAgents: [
                agentRow({ id: "a1", oref: "agent:a1", startedTs: T0 - 5 * HOUR }),
                agentRow({ id: "a2", oref: "agent:a2", startedTs: T0 - HOUR }),
                agentRow({ id: "a3", oref: "agent:a3", startedTs: T0 - 3 * HOUR }),
            ],
        });
        expect(rows.map((r) => r.oref)).toEqual(["agent:a1", "agent:a2", "agent:a3"]);
    });

    it("puts the dated rows of a tier ahead of its agents, newest first", () => {
        const rows = mergeActiveWork({
            activeRuns: [run({ oref: "run:a", ts: T0 - 3 * HOUR }), run({ oref: "run:b", ts: T0 - HOUR })],
            blockers: [],
            directAgents: [agentRow({ startedTs: T0 })],
        });
        expect(rows.map((r) => r.oref)).toEqual(["run:b", "run:a", "agent:a1"]);
    });

    it("keeps the input order of two rows that share an identity and a timestamp", () => {
        const rows = mergeActiveWork({
            activeRuns: [run({ goal: "first", ts: T0 }), run({ goal: "second", ts: T0 })],
            blockers: [],
            directAgents: [],
        });
        expect(rows.map((r) => r.name)).toEqual(["first", "second"]);
    });

    it("keeps the order of rows already sorted by identity when timestamps collide", () => {
        const rows = mergeActiveWork({
            activeRuns: [run({ oref: "run:a", ts: T0 }), run({ oref: "run:z", ts: T0 })],
            blockers: [],
            directAgents: [],
        });
        expect(rows.map((r) => r.oref)).toEqual(["run:a", "run:z"]);
    });

    it("stays deterministic when timestamps collide", () => {
        const rows = mergeActiveWork({
            activeRuns: [run({ oref: "run:z", ts: T0 }), run({ oref: "run:a", ts: T0 })],
            blockers: [],
            directAgents: [],
        });
        expect(rows.map((r) => r.oref)).toEqual(["run:a", "run:z"]);
    });
});

const attentionItem = (over: Partial<AttentionItem>): AttentionItem => ({
    kind: "escalation",
    key: "esc:r1",
    channelid: "ch-1",
    channelname: "waveterm",
    runid: "r1",
    source: "ship the ledger",
    text: "Approve before Jarvis proceeds.",
    action: "Review",
    phaseidx: 2,
    waitingsince: T0 - HOUR,
    ...over,
});

describe("buildAttentionQueue", () => {
    const item = attentionItem;

    it("keeps the server's priority order rather than re-sorting on age", () => {
        const q = buildAttentionQueue({
            attention: [
                item({ key: "dag-blocked:d1", kind: "dag-blocked", waitingsince: T0 - HOUR }),
                item({ key: "ask:w1", kind: "ask", waitingsince: T0 - DAY }),
            ],
            efforts: [],
        });
        expect(q.map((r) => r.key)).toEqual(["dag-blocked:d1", "ask:w1"]);
    });

    it("writes a label for every kind the server can emit", () => {
        const kinds = ["escalation", "ask", "dag-blocked", "run-land-held", "run-unverified"];
        const q = buildAttentionQueue({
            attention: kinds.map((k, i) => item({ kind: k, key: k + i })),
            efforts: [],
        });
        expect(q.map((r) => r.kind)).toEqual(["escalation", "ask", "dag blocked", "land held", "unverified"]);
    });

    it("gives a dag-blocked row the error tone and the rest the asking tone", () => {
        const q = buildAttentionQueue({
            attention: [item({ kind: "dag-blocked", key: "d1" }), item({ kind: "ask", key: "a1" })],
            efforts: [],
        });
        expect(q.map((r) => r.tone)).toEqual(["error", "asking"]);
    });

    it("drops the action and nav on a standalone item with no channel to land on", () => {
        const q = buildAttentionQueue({
            attention: [item({ channelid: "", channelname: "", runid: "" })],
            efforts: [],
        });
        expect(q[0]!.action).toBeNull();
        expect(q[0]!.nav).toBeNull();
        expect(q[0]!.detail).toBe("ship the ledger"); // no "#channel" suffix to append
    });

    it("targets the run when the item names one, else the channel", () => {
        const q = buildAttentionQueue({
            attention: [item({ key: "with-run" }), item({ key: "no-run", runid: "" })],
            efforts: [],
        });
        expect(q[0]!.nav).toEqual({ kind: "channel", channelId: "ch-1", runId: "r1" });
        expect(q[1]!.nav).toEqual({ kind: "channel", channelId: "ch-1", runId: null });
    });

    it("carries the channel into the detail line and the age from waiting-since", () => {
        const q = buildAttentionQueue({ attention: [item({})], efforts: [] });
        expect(q[0]!.title).toBe("Approve before Jarvis proceeds.");
        expect(q[0]!.detail).toBe("ship the ledger · #waveterm");
        expect(q[0]!.ts).toBe(T0 - HOUR);
    });

    // a channel-backed item must not be re-routed just because a stray oref rode along.
    it("routes by the channel even when an oref rides along", () => {
        const q = buildAttentionQueue({
            attention: [item({ kind: "dag-blocked", oref: "effort:e-1" })],
            efforts: [],
        });
        expect(q[0]!.nav).toEqual({ kind: "channel", channelId: "ch-1", runId: "r1" });
    });

    // F8: the row carries the initiative, the derived why-line and the citations. The title is joined
    // here from the efforts the Brief already holds, so an initiative's name has one source.
    it("joins the initiative title from the efforts it already has and appends the chunk", () => {
        const q = buildAttentionQueue({
            attention: [item({ effortoid: "e-7", chunklabel: "rebase and squash" })],
            efforts: [{ oref: "effort:e-7", title: "Attention reliability", blockedChunks: [] } as EffortCardModel],
        });
        expect(q[0]!.attrib).toBe("Attention reliability · rebase and squash");
    });

    it("keeps the chunk when the effort is not one the Brief is holding", () => {
        const q = buildAttentionQueue({
            attention: [item({ effortoid: "gone", chunklabel: "backfill" })],
            efforts: [],
        });
        expect(q[0]!.attrib).toBe("backfill");
    });

    it("names no initiative for a run that is not attributed to one", () => {
        const q = buildAttentionQueue({ attention: [item({})], efforts: [] });
        expect(q[0]!.attrib).toBe("");
        expect(q[0]!.why).toBe("");
        expect(q[0]!.cites).toEqual([]);
    });

    it("passes the server's why-line and citations through unchanged", () => {
        const q = buildAttentionQueue({
            attention: [
                item({
                    why: "The plan phase finished — 1 of 2 done. The execute phase starts only when you approve.",
                    cites: ["docs/plans/auth.md", "pkg/auth/plan.go"],
                }),
            ],
            efforts: [],
        });
        expect(q[0]!.why).toBe(
            "The plan phase finished — 1 of 2 done. The execute phase starts only when you approve."
        );
        expect(q[0]!.cites).toEqual(["docs/plans/auth.md", "pkg/auth/plan.go"]);
    });

    it("still falls through to the raw wire kind for a kind it has never seen", () => {
        const q = buildAttentionQueue({ attention: [item({ kind: "some-future-kind", key: "f1" })], efforts: [] });
        expect(q[0]!.kind).toBe("some-future-kind");
    });

    it("puts blocked chunks after the wire rows and leaves them ageless", () => {
        const efforts = projectBriefing(
            input({
                projects: [{ project: "waveterm", active: [], shipped: [], events: [], delta: [] }],
                efforts: EFFORT_FIXTURES,
                sources: { runs: true, sessions: true, dossiers: true, efforts: true, attention: "volatile" },
            })
        ).efforts;
        const q = buildAttentionQueue({ attention: [item({})], efforts });
        expect(q.map((r) => r.kind)).toEqual(["escalation", "chunk blocked"]);
        expect(q[1]!.ts).toBeNull();
    });
});

describe("buildAttentionQueue rows", () => {
    const item = attentionItem;
    const rowOf = (a: AttentionItem, efforts: EffortCardModel[] = []) =>
        buildAttentionQueue({ attention: [a], efforts })[0]!;

    it("carries every field of a wire row through", () => {
        const row = rowOf(
            item({
                kind: "dag-blocked",
                key: "dag-blocked:d1:t-3",
                runid: "r1",
                taskid: "t-3",
                retry: true,
                why: "the task failed twice",
                cites: ["a.go"],
                effortoid: "e-7",
                chunklabel: "rebase",
            }),
            [{ oref: "effort:e-7", title: "Reliability", blockedChunks: [] } as EffortCardModel]
        );
        expect(row).toEqual({
            key: "dag-blocked:d1:t-3",
            kind: "dag blocked",
            title: "Approve before Jarvis proceeds.",
            source: "ship the ledger",
            detail: "ship the ledger · #waveterm",
            ts: T0 - HOUR,
            action: "Review",
            nav: { kind: "channel", channelId: "ch-1", runId: "r1" },
            tone: "error",
            attrib: "Reliability · rebase",
            why: "the task failed twice",
            cites: ["a.go"],
            wireKind: "dag-blocked",
            channelId: "ch-1",
            runId: "r1",
            taskId: "t-3",
            retry: true,
        });
    });

    it("defaults what a wire row leaves out", () => {
        const row = rowOf(item({ channelid: undefined, runid: undefined, taskid: undefined, retry: undefined }));
        expect(row).toMatchObject({ channelId: "", runId: null, taskId: "", retry: false, action: null, nav: null });
    });

    it("reads retry as set only when the wire says true", () => {
        expect(rowOf(item({ retry: false })).retry).toBe(false);
        expect(rowOf(item({ retry: true })).retry).toBe(true);
    });

    it("keeps the action of a row that has a channel to land on", () => {
        expect(rowOf(item({ action: "Review" })).action).toBe("Review");
    });

    it("names no run on the nav when the item carries none", () => {
        expect(rowOf(item({ runid: undefined })).nav).toEqual({ kind: "channel", channelId: "ch-1", runId: null });
        expect(rowOf(item({ runid: undefined })).runId).toBeNull();
        expect(rowOf(item({ runid: "" })).runId).toBeNull();
    });

    it("adds the channel to the detail only for a row that has one", () => {
        expect(rowOf(item({ channelid: "", channelname: "waveterm", runid: "" })).detail).toBe("ship the ledger");
        expect(rowOf(item({ channelname: undefined })).detail).toBe("ship the ledger");
    });

    it("leaves no stray separator when the row has no source", () => {
        expect(rowOf(item({ source: "" })).detail).toBe("#waveterm");
    });

    it("names no initiative without an effort oid, whatever chunk it carries", () => {
        expect(rowOf(item({ effortoid: undefined, chunklabel: "backfill" })).attrib).toBe("");
        expect(rowOf(item({ effortoid: "", chunklabel: "backfill" })).attrib).toBe("");
    });

    it("matches an effort by the oid after its leading effort: prefix only", () => {
        const efforts = [{ oref: "pre-effort:e-7", title: "Mislabelled", blockedChunks: [] } as EffortCardModel];
        expect(rowOf(item({ effortoid: "pre-e-7", chunklabel: "c" }), efforts).attrib).toBe("c");
        expect(rowOf(item({ effortoid: "pre-effort:e-7", chunklabel: "c" }), efforts).attrib).toBe("Mislabelled · c");
    });

    it("rows a blocked chunk with its initiative as source and detail, and nothing to retry", () => {
        const rows = buildAttentionQueue({
            attention: [],
            efforts: [{ oref: "effort:e-1", title: "Gate", blockedChunks: ["Phase 5"] } as EffortCardModel],
        });
        expect(rows).toEqual([
            {
                key: "chunk:effort:e-1:Phase 5",
                kind: "chunk blocked",
                title: "Phase 5",
                source: "Gate",
                detail: "Gate",
                ts: null,
                action: "Open",
                nav: { kind: "effort", oref: "effort:e-1" },
                tone: "asking",
                attrib: "",
                why: "",
                cites: [],
                wireKind: "chunk-blocked",
                channelId: "",
                runId: null,
                taskId: "",
                retry: false,
            },
        ]);
    });

    it("rows a record blocker with its project, and a scopeless one with empty text", () => {
        const rows = buildAttentionQueue({
            attention: [],
            efforts: [],
            blockers: [
                { oref: "task:d1", objective: "Clear the gate", blockers: "waits on SRE", project: "p", ts: 5 },
                { oref: "", objective: "Loose end", blockers: "", project: null, ts: 6 },
            ],
        });
        expect(rows).toEqual([
            {
                key: "blocker:task:d1",
                kind: "blocked",
                wireKind: "blocker",
                title: "Clear the gate",
                source: "p",
                detail: "p",
                ts: 5,
                action: "Open",
                nav: { kind: "record", oref: "task:d1" },
                tone: "asking",
                attrib: "",
                why: "waits on SRE",
                cites: [],
                channelId: "",
                runId: null,
                taskId: "",
                retry: false,
            },
            {
                key: "blocker:",
                kind: "blocked",
                wireKind: "blocker",
                title: "Loose end",
                source: "",
                detail: "",
                ts: 6,
                action: "Open",
                nav: null,
                tone: "asking",
                attrib: "",
                why: "",
                cites: [],
                channelId: "",
                runId: null,
                taskId: "",
                retry: false,
            },
        ]);
    });
});

describe("summarizeAttentionQueue", () => {
    it("summarises multiple rows by kind word and the oldest wait", () => {
        const queue = buildAttentionQueue({
            attention: [
                attentionItem({ kind: "ask", key: "ask:one", waitingsince: T0 - HOUR }),
                attentionItem({ kind: "ask", key: "ask:two", waitingsince: T0 - DAY }),
            ],
            efforts: [],
        });
        expect(summarizeAttentionQueue(queue, T0)).toEqual({
            title: "2 things are waiting on you",
            detail: "ask · ask · oldest 1d",
            oldestTs: T0 - DAY,
        });
    });

    it("ignores rows without an age, and drops the oldest when none has one", () => {
        const queue = buildAttentionQueue({
            attention: [
                attentionItem({ kind: "dag-blocked", key: "g1", waitingsince: 0 }),
                attentionItem({ kind: "ask", key: "a1", waitingsince: T0 - HOUR }),
                attentionItem({ kind: "ask", key: "a2", waitingsince: T0 - 2 * HOUR }),
            ],
            efforts: [],
        });
        expect(summarizeAttentionQueue(queue, T0)).toEqual({
            title: "3 things are waiting on you",
            detail: "blocked · ask · ask · oldest 2h",
            oldestTs: T0 - 2 * HOUR,
        });
        expect(summarizeAttentionQueue(queue.slice(0, 1), T0)?.detail).toBe("blocked");
    });

    it("returns null for an empty queue", () => {
        expect(summarizeAttentionQueue([], T0)).toBeNull();
    });
});

describe("capRegion", () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({ id: i }));

    it("shows the window and reports what it hid", () => {
        expect(capRegion(rows, 3, false)).toEqual({ rows: rows.slice(0, 3), more: 2 });
    });

    it("shows everything and hides nothing once the region is expanded", () => {
        expect(capRegion(rows, 3, true)).toEqual({ rows, more: 0 });
    });

    // the count has to come off the slice, not off the cap: a region shorter than its window hid nothing
    it("reports no overflow for a region that never reached its cap", () => {
        expect(capRegion(rows, 9, false)).toEqual({ rows, more: 0 });
    });
});

// The queue is the one region whose rows are INERT without this: the decision a row waits on is resolved by
// the run body, so a row that cannot open its run cannot be acted on at all.
describe("queueOpenTarget", () => {
    it("opens a run's own sheet, carrying the run so the sheet lands on it rather than the channel's default", () => {
        expect(queueOpenTarget({ kind: "channel", channelId: "c1", runId: "r1" })).toEqual({
            kind: "channel",
            channelId: "c1",
            runId: "r1",
        });
    });

    it("opens a channel with no run named, which is the launcher", () => {
        expect(queueOpenTarget({ kind: "channel", channelId: "c1", runId: null })).toEqual({
            kind: "channel",
            channelId: "c1",
            runId: null,
        });
    });

    // a blocked chunk is addressed by oref instead of by channel; it has its own surface, and routing it
    // through the same router is what stops a second one existing.
    it("routes an effort through its own oref", () => {
        expect(queueOpenTarget({ kind: "effort", oref: "effort:e1" })).toEqual({ kind: "oref", oref: "effort:e1" });
    });

    it("leaves a standalone row with no destination inert", () => {
        expect(queueOpenTarget(null)).toBeNull();
    });
});

describe("design queue wording", () => {
    const q = (over: Partial<QueueRow>): QueueRow =>
        ({
            key: "k" + Math.random(),
            kind: "escalation",
            wireKind: "escalation",
            title: "t",
            source: "s",
            detail: "",
            ts: null,
            action: "Review",
            nav: null,
            tone: "asking",
            attrib: "",
            why: "",
            cites: [],
            channelId: "c1",
            runId: "r1",
            taskId: "",
            retry: false,
            ...over,
        }) as QueueRow;
    it("summarises as the design does", () => {
        const now = 10 * 3_600_000;
        const s = summarizeAttentionQueue(
            [
                q({ wireKind: "dag-blocked" }),
                q({ wireKind: "ask", ts: now - 2 * 3_600_000 }),
                q({ wireKind: "dag-blocked", retry: true }),
            ],
            now
        )!;
        expect(s.title).toBe("3 things are waiting on you");
        expect(s.detail).toBe("blocked · ask · failed · oldest 2h");
    });
    it("one item is singular", () => {
        expect(summarizeAttentionQueue([q({})], 0)!.title).toBe("1 thing is waiting on you");
    });
    it("maps each wire kind to its in-place action", () => {
        expect(queueAction(q({ wireKind: "escalation", taskId: "t-3" }))).toEqual({ label: "Open", kind: "open" });
        expect(queueAction(q({ wireKind: "dag-blocked", taskId: "t-4", retry: true }))).toEqual({
            label: "Retry",
            kind: "retry-dag",
        });
        expect(queueAction(q({ wireKind: "dag-blocked", taskId: "t-2", retry: false }))).toEqual({
            label: "Open",
            kind: "open",
        });
        expect(queueAction(q({ wireKind: "ask" }))).toEqual({ label: "Open", kind: "open" });
        expect(queueAction(q({ wireKind: "run-unverified" }))).toEqual({ label: "Acknowledge", kind: "ack-run" });
        expect(queueAction(q({ wireKind: "run-unverified", runId: null }))).toEqual({ label: "Open", kind: "open" });
        expect(queueAction(q({ wireKind: "run-land-held" }))).toEqual({ label: "Open", kind: "open" });
    });
    it("acknowledges all only the rows whose own button is Acknowledge", () => {
        const rows = [
            q({ wireKind: "run-unverified", channelId: "c1", runId: "r1" }),
            q({ wireKind: "dag-blocked", runId: "r2" }),
            q({ wireKind: "run-unverified", runId: null }),
            q({ wireKind: "run-unverified", channelId: "", runId: "r4" }),
            q({ wireKind: "run-unverified", channelId: "c5", runId: "r5" }),
        ];
        expect(ackableRuns(rows)).toEqual([
            { channelId: "c1", runId: "r1" },
            { channelId: "c5", runId: "r5" },
        ]);
    });
    it("a record blocker joins the queue as blocked and opens its record", () => {
        const rows = buildAttentionQueue({
            attention: [],
            efforts: [],
            blockers: [{ oref: "task:d1", objective: "Clear the gate", blockers: "waits on SRE", project: "p", ts: 5 }],
        });
        expect(rows).toHaveLength(1);
        expect(queueKindLabel(rows[0])).toBe("blocked");
        expect(rows[0].nav).toEqual({ kind: "record", oref: "task:d1" });
        expect(queueOpenTarget(rows[0].nav)).toEqual({ kind: "oref", oref: "task:d1" });
    });
});
