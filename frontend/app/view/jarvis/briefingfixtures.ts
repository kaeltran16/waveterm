// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// DEV-only briefing fixtures: five load states a human and the CDP verify:ui harness can render
// without a backend (mirrors jarvisfixtures.ts). The `load` states are real WorkState shapes — the
// projection and the view must not special-case them — and the timestamps hang off a fixed `now` so
// the shots are deterministic. Compiled out of production builds (only reachable through the
// briefingFixtureAtom seam, which import.meta.env.DEV gates).
import { globalStore } from "@/app/store/jotaiStore";
import type { AgentVM } from "@/app/view/agents/agentsviewmodel";
import { briefingAnswerAtom, briefingAskStateAtom, type BriefingLoadState } from "./briefingstore";

export type BriefingFixtureName = "normal" | "attention" | "empty" | "partial" | "failed";
export interface BriefingFixture {
    load: BriefingLoadState;
    agents: AgentVM[];
}

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();

const agents: AgentVM[] = [
    {
        id: "tab-direct",
        name: "loom",
        task: "polish the composer",
        state: "working",
        agent: "claude",
        project: "waveterm",
        activeMs: 4 * 60_000,
    },
];

const normalState: WorkState = {
    projects: [
        {
            project: "waveterm",
            active: [
                {
                    project: "waveterm",
                    kind: "run",
                    title: "Ship the landing briefing",
                    detail: "status: executing",
                    ts: NOW - 2 * DAY,
                    navtarget: "run:r-briefing-1",
                    workerorefs: ["tab:tab-run"],
                },
                {
                    project: "waveterm",
                    kind: "run",
                    title: "Port the usage charts",
                    detail: "status: blocked",
                    ts: NOW - 3 * DAY,
                    navtarget: "run:r-briefing-2",
                },
                {
                    project: "",
                    kind: "blocker",
                    title: "Unify the vault scope model",
                    detail: "needs decision on collection scoping",
                    ts: NOW - DAY,
                    navtarget: "vault:d-briefing-1",
                },
            ],
            shipped: [
                {
                    project: "waveterm",
                    runoid: "r-briefing-shipped",
                    goal: "Memory recentralization",
                    summary: "vault is the single source of truth",
                    completedts: NOW - DAY,
                },
            ],
            events: [],
            delta: [
                {
                    ts: NOW - 2 * DAY,
                    kind: "run-created",
                    project: "waveterm",
                    title: "Ship the landing briefing",
                    detail: "status: executing",
                    navtarget: "run:r-briefing-1",
                },
                {
                    ts: NOW - DAY,
                    kind: "run-done",
                    project: "waveterm",
                    title: "Memory recentralization",
                    detail: "vault is the single source of truth",
                    navtarget: "run:r-briefing-shipped",
                },
                { ts: NOW - 3 * DAY, kind: "decision", title: "chose sqlite over a second store" },
            ],
        },
    ],
    sources: { runs: true, sessions: true, dossiers: true, efforts: true, attention: "volatile" },
};

const attentionState: WorkState = {
    projects: [
        {
            project: "waveterm",
            active: [
                ...(normalState.projects[0].active ?? []),
                {
                    project: "waveterm",
                    kind: "attention",
                    title: "the ask bridge",
                    detail: "Review: check the diff",
                    ts: NOW - DAY,
                    navtarget: "run:r-briefing-1",
                },
            ],
            shipped: normalState.projects[0].shipped,
            events: [],
            delta: [
                ...(normalState.projects[0].delta ?? []),
                {
                    ts: NOW - DAY,
                    kind: "attention",
                    title: "the ask bridge",
                    detail: "Review: check the diff",
                    navtarget: "run:r-briefing-1",
                },
            ],
        },
    ],
    sources: { runs: true, sessions: true, dossiers: true, efforts: true, attention: "volatile" },
};

const partialState: WorkState = {
    projects: normalState.projects,
    sources: { runs: false, sessions: true, dossiers: true, efforts: true, attention: "volatile" },
};

const emptyState: WorkState = {
    projects: [],
    sources: { runs: true, sessions: true, dossiers: true, efforts: true, attention: "volatile" },
};

const loaded = (state: WorkState): BriefingLoadState => ({
    snapshot: { state, queryStartedAt: NOW, actualCursor: NOW - 7 * DAY, complete: true, cursorSaved: true },
    loading: false,
    error: null,
});

export const BRIEFING_FIXTURES: Record<BriefingFixtureName, BriefingFixture> = {
    normal: { load: loaded(normalState), agents },
    attention: { load: loaded(attentionState), agents },
    empty: { load: loaded(emptyState), agents },
    partial: { load: loaded(partialState), agents },
    failed: { load: { snapshot: null, loading: false, error: "fixture failure" }, agents: [] },
};

// The ask fixture answers once and stays: the inline ask is launch-local state, so the answer is
// seeded directly rather than through a fake RPC.
export function setBriefingAskFixtureForDev(): void {
    globalStore.set(briefingAskStateAtom, "answered");
    globalStore.set(briefingAnswerAtom, {
        answer: "Two runs are moving: the briefing itself is executing and the usage charts are blocked. The memory recentralization shipped yesterday [1].",
        sources: [
            { oref: "run:r-briefing-shipped", sourcetype: "shipped", title: "Memory recentralization" },
            { oref: "memory:m-briefing-1", sourcetype: "memory", title: "vault scoping note" },
        ],
        terminal: "answered",
    });
}
