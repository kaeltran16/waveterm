// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { AgentVM } from "./agentsviewmodel";
import { waitNote, type CockpitSession, type RunWait } from "./cockpitsessionmodel";
import { noteParts, runTabDot, stepTab, tabNeeds, waitAnchor, zoomTabs } from "./cockpitzoommodel";
import { EMPTY_WORKSPACE, type WorkspaceState, type WorkspaceTab } from "./workspacemodel";

const run = (over: Partial<Run>): Run => ({ id: "r", version: 1, status: "executing", createdts: 0, ...over }) as Run;
const session = (runs: Run[]): CockpitSession => ({
    agent: { id: "a", name: "conductor", task: "", state: "idle" } as AgentVM,
    state: "turn",
    conductor: runs.length > 0,
    runs,
});
const wait = (over: Partial<RunWait>): RunWait => ({
    runId: "r",
    key: "k",
    short: "Asks",
    label: "Asks: which way?",
    owner: "conductor",
    why: null,
    minutesLeft: null,
    conductorName: "conductor",
    ...over,
});
const effort = (oid: string, labels: string[]) => ({ oid, chunks: labels.map((label) => ({ label })) }) as Effort;
const ws = (tabs: WorkspaceTab[], active: string | null): WorkspaceState => ({ ...EMPTY_WORKSPACE, tabs, active });

// newest first, as the session lists them
const landed = run({ id: "landed", status: "done", createdts: 3 });
const live = run({ id: "live", status: "executing", createdts: 2 });
const older = run({ id: "older", status: "executing", createdts: 1 });

describe("zoomTabs", () => {
    it("adds a Run tab per listed run and an Initiative tab per distinct initiative, at the run's chunk", () => {
        const a = run({ id: "a", createdts: 2, effortref: { effortoid: "e1", chunklabel: "Second" } });
        const b = run({ id: "b", createdts: 1, effortref: { effortoid: "e1", chunklabel: "First" } });
        const c = run({ id: "c", status: "done", createdts: 0, effortref: { effortoid: "e2", chunklabel: "Only" } });
        const efforts = new Map([
            ["effort:e1", effort("e1", ["First", "Second"])],
            ["effort:e2", effort("e2", ["Only"])],
        ]);
        expect(zoomTabs(session([a, b, c]), {}, efforts, EMPTY_WORKSPACE).tabs).toEqual([
            { kind: "run", runId: "a", view: "tasks" },
            { kind: "run", runId: "b", view: "tasks" },
            { kind: "run", runId: "c", view: "tasks" },
            { kind: "initiative", effortId: "e1", open: 2 },
            { kind: "initiative", effortId: "e2", open: 1 },
        ]);
    });

    it("marks the chunk of the run that waits when an initiative has several runs", () => {
        const a = run({ id: "a", createdts: 2, effortref: { effortoid: "e1", chunklabel: "Second" } });
        const b = run({ id: "b", createdts: 1, effortref: { effortoid: "e1", chunklabel: "First" } });
        const efforts = new Map([["effort:e1", effort("e1", ["First", "Second"])]]);
        const tabs = zoomTabs(session([a, b]), { b: wait({ runId: "b" }) }, efforts, EMPTY_WORKSPACE).tabs;
        expect(tabs.find((t) => t.kind === "initiative")).toEqual({ kind: "initiative", effortId: "e1", open: 1 });
    });

    it("leaves the chunk to the tab when the initiative is not loaded or its chunk is gone", () => {
        const a = run({ id: "a", effortref: { effortoid: "e1", chunklabel: "Gone" } });
        const b = run({ id: "b", effortref: { effortoid: "e2", chunklabel: "Any" } });
        const efforts = new Map([["effort:e1", effort("e1", ["Other"])]]);
        const tabs = zoomTabs(session([a, b]), {}, efforts, EMPTY_WORKSPACE).tabs;
        expect(tabs.filter((t) => t.kind === "initiative").map((t) => "open" in t && t.open)).toEqual([
            undefined,
            undefined,
        ]);
    });

    it("keeps a chunk the Initiative tab already has open", () => {
        const a = run({ id: "a", effortref: { effortoid: "e1", chunklabel: "Second" } });
        const efforts = new Map([["effort:e1", effort("e1", ["First", "Second"])]]);
        const before = ws([{ kind: "initiative", effortId: "e1", open: 1 }], "initiative:e1");
        const tabs = zoomTabs(session([a]), {}, efforts, before).tabs;
        expect(tabs.find((t) => t.kind === "initiative")).toEqual({ kind: "initiative", effortId: "e1" });
    });

    it.each<[string, Run[], Record<string, RunWait>, string]>([
        ["the run that waits", [landed, live, older], { older: wait({ runId: "older" }) }, "run:older"],
        ["else the newest live run", [landed, live, older], {}, "run:live"],
        ["else the newest", [landed, run({ id: "failed", status: "failed", createdts: 1 })], {}, "run:landed"],
    ])("activates %s", (_, runs, waits, want) => {
        expect(zoomTabs(session(runs), waits, new Map(), EMPTY_WORKSPACE).activate).toBe(want);
    });

    it("keeps an already-active one of these Run tabs", () => {
        const before = ws([{ kind: "run", runId: "older", view: "graph" }], "run:older");
        expect(zoomTabs(session([landed, live, older]), {}, new Map(), before).activate).toBeNull();
    });

    it("activates the default run over another tab the pane shows", () => {
        const before = ws([{ kind: "docs", selected: null }], "docs");
        expect(zoomTabs(session([live]), {}, new Map(), before).activate).toBe("run:live");
    });

    it("adds none for a session with no runs and no tabs", () => {
        expect(zoomTabs(session([]), {}, new Map(), EMPTY_WORKSPACE)).toEqual({ tabs: [], activate: null });
    });
});

describe("stepTab", () => {
    const three = ws(
        [
            { kind: "run", runId: "a", view: "tasks" },
            { kind: "docs", selected: null },
            { kind: "changes", selected: null },
        ],
        "docs"
    );

    it.each<[number, string | null, string]>([
        [1, "docs", "changes"],
        [-1, "docs", "run:a"],
        [1, "changes", "run:a"],
        [-1, "run:a", "changes"],
        [1, null, "run:a"],
    ])("steps %i from %s to %s, wrapping", (delta, active, want) => {
        expect(stepTab({ ...three, active }, delta)).toBe(want);
    });

    it("has nowhere to step with no tabs", () => {
        expect(stepTab(EMPTY_WORKSPACE, 1)).toBeNull();
    });
});

describe("runTabDot", () => {
    it.each<[string, RunWait | null, number, boolean, ReturnType<typeof runTabDot>]>([
        ["a wait the conductor holds is muted, though the run has asks", wait({}), 1, false, "held"],
        ["a wait that is yours takes the waiting color", wait({ owner: "you", why: "turn" }), 0, false, "waiting"],
        ["no wait keeps today's waiting color for user asks", null, 1, false, "waiting"],
        ["no wait and no asks shows an unseen tab", null, 0, true, "unseen"],
        ["nothing to show", null, 0, false, null],
    ])("%s", (_, w, asks, unseen, want) => {
        expect(runTabDot(w, asks, unseen)).toBe(want);
    });
});

describe("tabNeeds", () => {
    const runTab: WorkspaceTab = { kind: "run", runId: "r", view: "tasks" };
    const input = (asks: number) => ({
        runAsks: { r: Array.from({ length: asks }, () => ({ owner: "user" })) },
        brainstormAsking: false,
    });
    it.each<[string, RunWait | null, number, number]>([
        ["a wait the conductor holds counts nothing, though the run has asks", wait({}), 2, 0],
        ["a wait that is yours counts its asks", wait({ owner: "you", why: "turn" }), 2, 2],
        ["a wait that is yours with no ask counts once", wait({ owner: "you", why: "none" }), 0, 1],
        ["no wait counts the asks, as today", null, 2, 2],
    ])("%s", (_, w, asks, want) => {
        expect(tabNeeds(runTab, w, input(asks))).toBe(want);
    });
});

describe("waitAnchor", () => {
    const item = (over: Partial<AttentionItem>) =>
        ({
            kind: "ask",
            key: "k",
            source: "",
            text: "",
            action: "",
            phaseidx: 0,
            waitingsince: 0,
            ...over,
        }) as AttentionItem;
    const rows = ["planreview", "t-1", "t-3", "final"];
    it.each<[string, AttentionItem | undefined, RunWait, string[], string]>([
        [
            "a failed Final at the Final row",
            item({ kind: "dag-blocked" }),
            wait({ short: "Final failed" }),
            rows,
            "final",
        ],
        ["a plan to approve at Plan review", item({}), wait({ short: "Plan to approve" }), rows, "planreview"],
        ["a task's ask in its row", item({ taskid: "t-3" }), wait({}), rows, "t-3"],
        ["a task the plan does not list on top", item({ taskid: "t-9" }), wait({}), rows, "top"],
        ["a failed Final on top when no Final row draws", item({}), wait({ short: "Final failed" }), ["t-1"], "top"],
        ["a held landing on top", item({ kind: "run-land-held" }), wait({ short: "Landing held" }), rows, "top"],
        ["an item already gone on top", undefined, wait({}), rows, "top"],
    ])("%s", (_, it_, w, ids, want) => {
        expect(waitAnchor(it_, w, ids)).toBe(want);
    });
});

describe("noteParts", () => {
    it("splits the minutes out of a Watching note, so the count can roll", () => {
        const w = wait({ minutesLeft: 3 });
        const p = noteParts(w);
        expect(p.minutes).toBe(3);
        expect(`${p.before}${p.minutes}${p.after}`).toBe(waitNote(w));
    });

    it("keeps any other note whole", () => {
        const w = wait({ owner: "you", why: "timer" });
        expect(noteParts(w)).toEqual({ before: waitNote(w), minutes: null, after: "" });
    });
});
