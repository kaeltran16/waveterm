// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { AgentVM } from "@/app/view/agents/agentsviewmodel";
import { describe, expect, it } from "vitest";
import { EFFORT_FIXTURES } from "./briefingfixtures";
import {
    buildAttentionQueue,
    effortListLabel,
    groupDelta,
    mergeActiveWork,
    normalizeBriefingNav,
    projectBriefing,
    type AgentRow,
    type BlockerRow,
    type BriefingModelInput,
    type DeltaRow,
    type RunRow,
} from "./briefingmodel";

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

    it("sorts runs blocked-first then ts-desc then oref, agents asking-first then started desc", () => {
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
        // asking first; then startedTs desc — w1 started earlier than w2, so w2 comes first
        expect(m.directAgents.map((a) => a.id)).toEqual(["tab-2", "tab-3", "tab-1"]);
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
                navtarget: "vault:d-1",
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
        expect(m.delta.find((d) => d.kind === "dossier")?.oref).toBe("task:d-1"); // vault: -> task:
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

    it("labels unscoped blockers and normalizes their target", () => {
        const active: ActiveWorkItem[] = [
            {
                project: "",
                kind: "blocker",
                title: "ship ledger",
                detail: "needs decision on X",
                ts: T0 - DAY,
                navtarget: "vault:d-1",
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

    it("normalizes only the vault alias", () => {
        expect(normalizeBriefingNav("vault:d-1")).toBe("task:d-1");
        expect(normalizeBriefingNav("run:r-1")).toBe("run:r-1");
        expect(normalizeBriefingNav(undefined)).toBeNull();
        expect(normalizeBriefingNav("")).toBeNull();
    });

    it("projects efforts, non-archived only, capped at 6 with overflow", () => {
        const state = workState([{ project: "waveterm", active: [], shipped: [], events: [], delta: [] }]);
        state.efforts = EFFORT_FIXTURES;
        const m = projectBriefing(input(state));
        expect(m.efforts.map((e) => e.title)).toEqual(["Scenario gate clearance", "Reflux state-layer migration"]);
        expect(m.effortMore).toBe(0);
        // cap: 8 efforts -> 6 cards + 2 overflow (archived never counts)
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
        expect(m2.efforts).toHaveLength(6);
        expect(m2.effortMore).toBe(1);
        expect(m2.efforts.some((e) => e.title === "effort 0")).toBe(false); // archived excluded
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

    it("caps delta rows at 10 and counts the overflow", () => {
        const events = Array.from({ length: 12 }, (_, i) => ({
            ts: T0 - i * HOUR,
            kind: "run-created",
            title: `r${i}`,
        })) as TimelineEvent[];
        const state = workState([{ project: "waveterm", active: [], shipped: [], events, delta: events }]);
        const m = projectBriefing(input(state));
        expect(m.delta).toHaveLength(10);
        expect(m.deltaMore).toBe(2);
        expect(m.counts.delta).toBe(12); // the pill keeps the true count
    });

    it("caps active legs and shipped rows with overflow counts", () => {
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
        expect(m.activeRuns).toHaveLength(8);
        expect(m.activeMore).toBe(2);
        expect(m.shipped).toHaveLength(8);
        expect(m.shippedMore).toBe(2);
        expect(m.counts.runs).toBe(10);
        expect(m.counts.shipped).toBe(10);
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
        goal: "run goal",
        project: "waveterm",
        status: "running",
        workerOrefs: [],
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

    it("interleaves kinds, needing-eyes first, then recency, then identity", () => {
        const rows = mergeActiveWork({
            activeRuns: [run({ ts: T0 - HOUR }), run({ oref: "run:r2", ts: T0 - 4 * HOUR, status: "blocked" })],
            blockers: [blocker({ ts: T0 - 2 * HOUR })],
            directAgents: [agentRow({ state: "asking", startedTs: T0 - 3 * HOUR })],
        });
        // needing-eyes (blocked run, blocker, asking agent) first, recency within tier:
        expect(rows.map((r) => r.kind)).toEqual(["blocker", "agent", "run", "run"]);
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

    it("stays deterministic when timestamps collide", () => {
        const rows = mergeActiveWork({
            activeRuns: [run({ oref: "run:z", ts: T0 }), run({ oref: "run:a", ts: T0 })],
            blockers: [],
            directAgents: [],
        });
        expect(rows.map((r) => r.oref)).toEqual(["run:a", "run:z"]);
    });
});

describe("buildAttentionQueue", () => {
    const item = (over: Partial<AttentionItem>): AttentionItem => ({
        kind: "gate",
        key: "gate:r1",
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

    it("keeps the server's priority order rather than re-sorting on age", () => {
        const q = buildAttentionQueue({
            attention: [
                item({ key: "gate:r1", kind: "gate", waitingsince: T0 - HOUR }),
                item({ key: "ask:w1", kind: "ask", waitingsince: T0 - DAY }),
            ],
            efforts: [],
        });
        expect(q.map((r) => r.key)).toEqual(["gate:r1", "ask:w1"]);
    });

    it("writes a label for every kind the server can emit", () => {
        const kinds = ["gate", "escalation", "ask", "dag-gate", "dag-blocked", "plan-gate", "radar-triage"];
        const q = buildAttentionQueue({
            attention: kinds.map((k, i) => item({ kind: k, key: k + i })),
            efforts: [],
        });
        expect(q.map((r) => r.kind)).toEqual([
            "gate",
            "escalation",
            "ask",
            "dag gate",
            "dag blocked",
            "plan gate",
            "triage",
        ]);
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

    it("lands a plan gate on its channel like any other gate", () => {
        const q = buildAttentionQueue({
            attention: [
                item({ kind: "plan-gate", key: "plan-gate:d1", text: "Approve the plan before any worker starts." }),
            ],
            efforts: [],
        });
        expect(q[0]!.kind).toBe("plan gate");
        expect(q[0]!.nav).toEqual({ kind: "channel", channelId: "ch-1", runId: "r1" });
        expect(q[0]!.tone).toBe("asking"); // a held plan is waiting, not failing
    });

    // the server un-rolled dag gates to one row per task; two tasks of one group must stay two rows.
    it("keeps two gated tasks of the same dag apart", () => {
        const q = buildAttentionQueue({
            attention: [
                item({ kind: "dag-gate", key: "dag-gate:d1:t-0", text: "Approve scaffold before the DAG proceeds." }),
                item({ kind: "dag-gate", key: "dag-gate:d1:t-1", text: "Approve migrate before the DAG proceeds." }),
            ],
            efforts: [],
        });
        expect(q.map((r) => r.key)).toEqual(["dag-gate:d1:t-0", "dag-gate:d1:t-1"]);
        expect(new Set(q.map((r) => r.title)).size).toBe(2);
    });

    it("addresses a triage row by its report rather than a channel", () => {
        const q = buildAttentionQueue({
            attention: [
                item({
                    kind: "radar-triage",
                    key: "radar:r-1",
                    channelid: "",
                    channelname: "",
                    runid: "",
                    source: "arc",
                    text: "4 findings need triage.",
                    action: "Triage",
                    oref: "radarreport:r-1",
                }),
            ],
            efforts: [],
        });
        expect(q[0]!.nav).toEqual({ kind: "radar", oref: "radarreport:r-1" });
        // the no-channel rule used to strip the action off any row without a channel, which would have
        // left the one row that DOES have a destination looking inert.
        expect(q[0]!.action).toBe("Triage");
        expect(q[0]!.detail).toBe("arc");
    });

    it("degrades a triage row with no report to static rather than inventing a target", () => {
        const q = buildAttentionQueue({
            attention: [item({ kind: "radar-triage", key: "radar:r-1", channelid: "", channelname: "", runid: "" })],
            efforts: [],
        });
        expect(q[0]!.nav).toBeNull();
        expect(q[0]!.action).toBeNull();
    });

    // a channel-backed item must not be re-routed just because a stray oref rode along.
    it("prefers the channel for any kind that is not triage", () => {
        const q = buildAttentionQueue({
            attention: [item({ kind: "gate", oref: "radarreport:r-1" })],
            efforts: [],
        });
        expect(q[0]!.nav).toEqual({ kind: "channel", channelId: "ch-1", runId: "r1" });
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
        expect(q.map((r) => r.kind)).toEqual(["gate", "chunk blocked"]);
        expect(q[1]!.ts).toBeNull();
    });
});

describe("effortListLabel", () => {
    it("names the overflow when the briefing caps the list", () => {
        expect(effortListLabel(3)).toBe("+3 more");
    });

    it("still offers a route to the full list when nothing overflows", () => {
        // the archived group lives only on that list, so the link cannot be conditional on overflow
        expect(effortListLabel(0)).toBe("All initiatives");
    });
});
