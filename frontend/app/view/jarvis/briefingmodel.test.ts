// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { AgentVM } from "@/app/view/agents/agentsviewmodel";
import { describe, expect, it } from "vitest";
import { normalizeBriefingNav, projectBriefing, type BriefingModelInput } from "./briefingmodel";

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
    sources: { runs: true, sessions: true, dossiers: true, attention: "volatile" },
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

    it("builds the attention banner and removes current attention items from delta", () => {
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
        expect(m.attention?.count).toBe(1);
        expect(m.delta).toHaveLength(0);
        expect(m.activeRuns).toHaveLength(0); // attention is banner-only, never a row
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
        p.sources = { runs: false, sessions: true, dossiers: true, attention: "volatile" };
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
});
