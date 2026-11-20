// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { AgentActionEntry } from "./agentsviewmodel";
import {
    applyArrivals,
    arrivals,
    dismissed,
    EMPTY_MEMORY,
    offers,
    remember,
    startedRunId,
    type Arrival,
    type OfferInput,
} from "./autoopenmodel";
import { EMPTY_WORKSPACE, openTab, paneShape, setCollapsed, tabKey, type WorkspaceTab } from "./workspacemodel";

const SINCE = 1_000_000;
const AFTER = SINCE + 5000;

function bash(command: string, output = "", o: { ts?: number; exit?: number } = {}): AgentActionEntry {
    const exit = o.exit ?? 0;
    return {
        kind: "action",
        verb: "ran",
        target: command,
        command,
        ts: o.ts ?? AFTER,
        outcome: exit === 0 ? "ok" : "fail",
        detail: { kind: "bash", command, output, exit },
    };
}

const REVEAL = "wsh ui reveal canvas:auto-open";
const START = 'wsh runs start "Auto-open policy" --plan docs/plan.md';
const STARTED = "started run r-123 (orchestrator, planning) in waveterm\n";

function input(over: Partial<OfferInput> = {}): OfferInput {
    return {
        since: SINCE,
        entries: [],
        brainstorm: null,
        canvas: null,
        lastEditMs: null,
        hasChanges: false,
        leadRun: null,
        ...over,
    };
}

const kinds = (as: Arrival[]) => as.map((a) => a.kind);
const file: WorkspaceTab = { kind: "file", path: "src/a.ts", line: 3 };

describe("offers", () => {
    it("offers a brainstorm wait written this session", () => {
        const bs = { path: "/p/bs.json", modifiedMs: AFTER, wait: "2", run: null };
        expect(offers(input({ brainstorm: bs }))).toEqual([
            { kind: "brainstorm", id: "/p/bs.json#2", tab: { kind: "brainstorm" } },
        ]);
        expect(offers(input({ brainstorm: { ...bs, wait: null } }))).toEqual([]);
        expect(offers(input({ brainstorm: { ...bs, modifiedMs: SINCE - 1 } }))).toEqual([]);
    });

    it("offers the run a brainstorm started, once per run", () => {
        const bs = { path: "/p/bs.json", modifiedMs: AFTER, wait: null, run: "r-7" };
        expect(offers(input({ brainstorm: bs }))).toEqual([
            { kind: "brainstorm", id: "/p/bs.json#run:r-7", tab: { kind: "brainstorm" } },
        ]);
        const memory = { ...EMPTY_MEMORY, handled: { brainstorm: "/p/bs.json#run:r-7" } };
        expect(arrivals(offers(input({ brainstorm: bs })), memory)).toEqual([]);
    });

    it("offers the canvas the last reveal named while the agent still has it", () => {
        const entries = [bash(REVEAL)];
        expect(offers(input({ entries, canvas: { topic: "auto-open", removed: false } }))).toEqual([
            { kind: "canvas", id: "auto-open", tab: { kind: "canvas" } },
        ]);
        expect(offers(input({ entries, canvas: { topic: "auto-open", removed: true } }))).toEqual([]);
        expect(offers(input({ entries, canvas: { topic: "other", removed: false } }))).toEqual([]);
        expect(offers(input({ entries, canvas: null }))).toEqual([]);
    });

    it("leaves out a reveal or a run start from before the session", () => {
        const canvas = { topic: "auto-open", removed: false };
        const entries = [bash(REVEAL, "", { ts: SINCE - 1 }), bash(START, STARTED, { ts: SINCE - 1 })];
        expect(offers(input({ entries, canvas }))).toEqual([]);
    });

    it("offers the run the last start created", () => {
        expect(offers(input({ entries: [bash(START, STARTED)] }))).toEqual([
            { kind: "run", id: "r-123", tab: { kind: "run", runId: "r-123", view: "tasks" } },
        ]);
        expect(offers(input({ entries: [bash(START, "no channel", { exit: 1 })] }))).toEqual([]);
    });

    it("offers the changes of an edit made this session while the checkout has some", () => {
        expect(offers(input({ lastEditMs: AFTER, hasChanges: true }))).toEqual([
            { kind: "changes", id: `${AFTER}`, tab: { kind: "changes", selected: null } },
        ]);
        expect(offers(input({ lastEditMs: AFTER, hasChanges: false }))).toEqual([]);
        expect(offers(input({ lastEditMs: SINCE - 1, hasChanges: true }))).toEqual([]);
    });

    it("offers a lead its own run, and not its tree's changes", () => {
        const own = [{ kind: "run", id: "r-lead", tab: { kind: "run", runId: "r-lead", view: "tasks" } }];
        expect(offers(input({ leadRun: "r-lead", lastEditMs: AFTER, hasChanges: true }))).toEqual(own);
        expect(offers(input({ leadRun: "r-lead", entries: [bash(START, STARTED)] }))).toEqual(own);
    });
});

describe("startedRunId", () => {
    it("reads the id from --json, else from the started line", () => {
        expect(startedRunId(bash(`${START} --json`, '{"id":"r-9","goal":"x"}'))).toBe("r-9");
        expect(startedRunId(bash(START, STARTED))).toBe("r-123");
        expect(startedRunId(bash(START, "something else"))).toBeNull();
    });
});

describe("arrivals", () => {
    const all = offers(
        input({
            entries: [bash(REVEAL), bash(START, STARTED)],
            canvas: { topic: "auto-open", removed: false },
            lastEditMs: AFTER,
            hasChanges: true,
        })
    );

    it("orders the turn's arrivals by priority", () => {
        expect(kinds(arrivals([...all].reverse(), EMPTY_MEMORY))).toEqual(["canvas", "run", "changes"]);
    });

    it("drops what was handled with the same id, and keeps a new id", () => {
        const memory = { ...EMPTY_MEMORY, handled: { canvas: "auto-open", changes: "1" } };
        expect(kinds(arrivals(all, memory))).toEqual(["run", "changes"]);
    });

    it("drops a kind the user turned down", () => {
        expect(kinds(arrivals(all, { ...EMPTY_MEMORY, dismissed: ["run"] }))).toEqual(["canvas", "changes"]);
    });
});

describe("applyArrivals", () => {
    const canvas: Arrival = { kind: "canvas", id: "t", tab: { kind: "canvas" } };
    const run: Arrival = { kind: "run", id: "r1", tab: { kind: "run", runId: "r1", view: "tasks" } };
    const changes: Arrival = { kind: "changes", id: "1", tab: { kind: "changes", selected: null } };

    it("opens the winner when there is no pane, the others behind it marked, a losing Changes left out", () => {
        const s = applyArrivals(EMPTY_WORKSPACE, [canvas, run, changes]);
        expect(s.tabs.map(tabKey)).toEqual(["canvas", "run:r1"]);
        expect(s.active).toBe("canvas");
        expect(s.unseen).toEqual(["run:r1"]);
    });

    it("opens Changes when it is all the turn brought", () => {
        const s = applyArrivals(EMPTY_WORKSPACE, [changes]);
        expect(s.active).toBe("changes");
    });

    it("never changes what a pane in use shows", () => {
        const s = applyArrivals(openTab(EMPTY_WORKSPACE, file), [canvas, changes]);
        expect(s.active).toBe("file:src/a.ts");
        expect(s.tabs.map(tabKey)).toEqual(["file:src/a.ts", "canvas"]);
        expect(s.unseen).toEqual(["canvas"]);
    });

    it("leaves a collapsed pane collapsed", () => {
        const s = applyArrivals(setCollapsed(openTab(EMPTY_WORKSPACE, file), true), [run]);
        expect(paneShape(s)).toBe("strip");
        expect(s.unseen).toEqual(["run:r1"]);
    });

    it("changes nothing with no arrivals", () => {
        expect(applyArrivals(EMPTY_WORKSPACE, [])).toBe(EMPTY_WORKSPACE);
    });
});

describe("remember and dismissed", () => {
    const canvas: Arrival = { kind: "canvas", id: "t", tab: { kind: "canvas" } };
    const changes: Arrival = { kind: "changes", id: "1", tab: { kind: "changes", selected: null } };

    it("handles every arrival and records only the tabs it put in the pane", () => {
        const arrived = [canvas, changes];
        const m = remember(EMPTY_MEMORY, arrived, applyArrivals(EMPTY_WORKSPACE, arrived));
        expect(m.handled).toEqual({ canvas: "t", changes: "1" });
        expect(m.opened).toEqual(["canvas"]);
    });

    it("turns a kind down when the user closes a tab auto-open put there", () => {
        const m = remember(EMPTY_MEMORY, [canvas], applyArrivals(EMPTY_WORKSPACE, [canvas]));
        expect(dismissed(m, { kind: "canvas" }).dismissed).toEqual(["canvas"]);
        expect(dismissed(m, { kind: "changes", selected: null })).toBe(m);
        expect(dismissed(m, file)).toBe(m);
    });

    it("never turns a kind down for a Docs or Initiative tab, which auto-open does not open", () => {
        const m = { ...EMPTY_MEMORY, opened: ["docs", "initiative:e1"] };
        expect(dismissed(m, { kind: "docs", selected: null })).toBe(m);
        expect(dismissed(m, { kind: "initiative", effortId: "e1" })).toBe(m);
    });
});
