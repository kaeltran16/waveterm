// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { Lineage } from "./runlineage";
import {
    activateTab,
    addTab,
    boardPaneWidth,
    closeTab,
    EMPTY_WORKSPACE,
    finishedRowTabs,
    iconOnlyTabs,
    openTab,
    paneShape,
    paneWidth,
    setCollapsed,
    setExpanded,
    tabKey,
    tabLabel,
    tabWaiting,
    toggleCollapsed,
    updateTab,
    type RunGraphState,
    type WorkspaceState,
    type WorkspaceTab,
} from "./workspacemodel";

const run = (runId: string): WorkspaceTab => ({ kind: "run", runId, view: "tasks" });
const file = (path: string, line: number | null): WorkspaceTab => ({ kind: "file", path, line });
const changes: WorkspaceTab = { kind: "changes", selected: null };
const docs = (selected: string | null): WorkspaceTab => ({ kind: "docs", selected });
const initiative = (effortId: string, open?: number | null): WorkspaceTab => ({ kind: "initiative", effortId, open });

function withTabs(...tabs: WorkspaceTab[]): WorkspaceState {
    return tabs.reduce(openTab, EMPTY_WORKSPACE);
}

describe("tabKey", () => {
    it("keys one tab per run, per file path, and one each for changes, brainstorm and canvas", () => {
        expect(tabKey(run("r1"))).toBe("run:r1");
        expect(tabKey(file("src/a.ts", 3))).toBe("file:src/a.ts");
        expect(tabKey(changes)).toBe("changes");
        expect(tabKey({ kind: "brainstorm" })).toBe("brainstorm");
        expect(tabKey({ kind: "canvas" })).toBe("canvas");
    });

    it("keys one Task tab per run's task and one Final tab per run, whatever its round", () => {
        expect(tabKey({ kind: "task", runId: "r1", taskId: "t-4" })).toBe("task:r1:t-4");
        expect(tabKey({ kind: "final", runId: "r1", round: null })).toBe("final:r1");
        expect(tabKey({ kind: "final", runId: "r1", round: 2, session: "v1" })).toBe("final:r1");
    });

    it("keys one Docs tab per agent and one Initiative tab per effort", () => {
        expect(tabKey(docs("a.md"))).toBe("docs");
        expect(tabKey(docs(null))).toBe("docs");
        expect(tabKey(initiative("e1"))).toBe("initiative:e1");
        expect(withTabs(initiative("e1"), initiative("e2"), initiative("e1")).tabs.map(tabKey)).toEqual([
            "initiative:e1",
            "initiative:e2",
        ]);
    });
});

describe("openTab", () => {
    it("adds a new tab and makes it active", () => {
        const s = withTabs(run("r1"), changes);
        expect(s.tabs.map(tabKey)).toEqual(["run:r1", "changes"]);
        expect(s.active).toBe("changes");
    });

    it("activates an existing key without a duplicate", () => {
        const s = openTab(withTabs(run("r1"), changes), run("r1"));
        expect(s.tabs.map(tabKey)).toEqual(["run:r1", "changes"]);
        expect(s.active).toBe("run:r1");
    });

    it("moves a reopened File tab's line", () => {
        const s = openTab(withTabs(file("a.ts", 3), changes), file("a.ts", 40));
        expect(s.tabs[0]).toEqual(file("a.ts", 40));
        expect(s.active).toBe("file:a.ts");
    });

    it("keeps a reopened Run tab's view", () => {
        const s0 = updateTab(withTabs(run("r1")), "run:r1", { view: "graph" });
        const s = openTab(s0, run("r1"));
        expect(s.tabs[0]).toEqual({ kind: "run", runId: "r1", view: "graph" });
    });

    it("keeps a reopened Run tab's graph state, which survives a swap to another view and back", () => {
        const graph: RunGraphState = { mode: "focus", focus: "t-3", trail: ["t-7"] };
        const s0 = updateTab(withTabs(run("r1")), "run:r1", { view: "graph", graph });
        const swapped = updateTab(updateTab(s0, "run:r1", { view: "activity" }), "run:r1", { view: "graph" });
        expect(openTab(swapped, run("r1")).tabs[0]).toEqual({ kind: "run", runId: "r1", view: "graph", graph });
    });

    it("keeps a reopened Changes tab's selection", () => {
        const s0 = updateTab(withTabs(changes), "changes", { selected: "b.ts" });
        expect(openTab(s0, changes).tabs[0]).toEqual({ kind: "changes", selected: "b.ts" });
    });

    it("takes a reopened Docs tab's incoming selection, and keeps the old one on null", () => {
        const s0 = withTabs(docs("a.md"), changes);
        expect(openTab(s0, docs("b.md")).tabs[0]).toEqual(docs("b.md"));
        expect(openTab(s0, docs(null)).tabs[0]).toEqual(docs("a.md"));
        expect(openTab(s0, docs(null)).active).toBe("docs");
    });

    it("keeps a reopened Initiative tab's open chunk", () => {
        const s0 = updateTab(withTabs(initiative("e1")), "initiative:e1", { open: 2 });
        expect(openTab(s0, initiative("e1")).tabs[0]).toEqual(initiative("e1", 2));
    });

    it("un-collapses the pane, for a new tab and an existing one", () => {
        const collapsed = setCollapsed(withTabs(run("r1")), true);
        expect(openTab(collapsed, run("r1")).collapsed).toBe(false);
        expect(openTab(collapsed, changes).collapsed).toBe(false);
    });
});

describe("closeTab", () => {
    it("activates the right neighbour of the closed active tab", () => {
        const s = closeTab(activateTab(withTabs(run("r1"), changes, file("a.ts", 1)), "changes"), "changes");
        expect(s.tabs.map(tabKey)).toEqual(["run:r1", "file:a.ts"]);
        expect(s.active).toBe("file:a.ts");
    });

    it("activates the left neighbour when the closed active tab was last", () => {
        const s = closeTab(withTabs(run("r1"), changes), "changes");
        expect(s.active).toBe("run:r1");
    });

    it("keeps the active tab when another closes", () => {
        const s = closeTab(withTabs(run("r1"), changes), "run:r1");
        expect(s.tabs.map(tabKey)).toEqual(["changes"]);
        expect(s.active).toBe("changes");
    });

    it("returns the empty workspace when the last tab closes, collapsed or expanded", () => {
        expect(closeTab(withTabs(run("r1")), "run:r1")).toBe(EMPTY_WORKSPACE);
        expect(closeTab(setExpanded(withTabs(run("r1")), true), "run:r1")).toBe(EMPTY_WORKSPACE);
    });

    it("changes nothing for an unknown key", () => {
        const s = withTabs(run("r1"));
        expect(closeTab(s, "canvas")).toBe(s);
    });
});

describe("activateTab", () => {
    it("activates a known key and ignores an unknown one", () => {
        const s = withTabs(run("r1"), changes);
        expect(activateTab(s, "run:r1").active).toBe("run:r1");
        expect(activateTab(s, "canvas")).toBe(s);
    });
});

describe("updateTab", () => {
    it("patches a tab's sub-state", () => {
        const s = updateTab(withTabs(changes), "changes", { selected: "a.ts" });
        expect(s.tabs[0]).toEqual({ kind: "changes", selected: "a.ts" });
    });

    it("refuses a patch that would change the tab's kind or key", () => {
        const s = withTabs(run("r1"));
        expect(updateTab(s, "run:r1", { runId: "r2" })).toBe(s);
        expect(updateTab(s, "run:r1", { kind: "canvas" })).toBe(s);
    });

    it("changes a Docs selection and an Initiative's open chunk, never its effort", () => {
        expect(updateTab(withTabs(docs(null)), "docs", { selected: "a.md" }).tabs[0]).toEqual(docs("a.md"));
        const s = withTabs(initiative("e1"));
        expect(updateTab(s, "initiative:e1", { open: 3 }).tabs[0]).toEqual(initiative("e1", 3));
        expect(updateTab(s, "initiative:e1", { open: null }).tabs[0]).toEqual(initiative("e1", null));
        expect(updateTab(s, "initiative:e1", { effortId: "e2" })).toBe(s);
    });
});

describe("collapse and expand", () => {
    it("collapsing clears expanded", () => {
        const s = setCollapsed(setExpanded(withTabs(run("r1")), true), true);
        expect(s.collapsed).toBe(true);
        expect(s.expanded).toBe(false);
    });

    it("expanding restores a collapsed pane", () => {
        const s = setExpanded(setCollapsed(withTabs(run("r1")), true), true);
        expect(s.expanded).toBe(true);
        expect(s.collapsed).toBe(false);
    });

    it("toggles collapse with tabs", () => {
        const s = toggleCollapsed(withTabs(run("r1")));
        expect(s.collapsed).toBe(true);
        expect(toggleCollapsed(s).collapsed).toBe(false);
    });

    it("changes nothing with no tabs", () => {
        expect(toggleCollapsed(EMPTY_WORKSPACE)).toBe(EMPTY_WORKSPACE);
        expect(setCollapsed(EMPTY_WORKSPACE, true)).toBe(EMPTY_WORKSPACE);
        expect(setExpanded(EMPTY_WORKSPACE, true)).toBe(EMPTY_WORKSPACE);
    });
});

describe("paneWidth", () => {
    it("keeps the stored width when it fits", () => {
        expect(paneWidth(600, 1400)).toBe(600);
    });

    it("never goes under 360", () => {
        expect(paneWidth(200, 1400)).toBe(360);
    });

    it("clamps down so the transcript keeps 360", () => {
        expect(paneWidth(900, 1000)).toBe(640);
    });

    it("holds its own 360 floor on a window too narrow for both", () => {
        expect(paneWidth(600, 500)).toBe(360);
    });

    it("reads a stored width that is not a number as the 600 default", () => {
        expect(paneWidth(Number.NaN, 1400)).toBe(600);
    });
});

describe("boardPaneWidth", () => {
    it.each([
        { name: "the widest when nothing is stored", stored: null, room: 1362, want: 1002 },
        { name: "never under 360 on a narrow row", stored: null, room: 600, want: 360 },
        { name: "a stored width clamped as paneWidth clamps it", stored: 1200, room: 1362, want: 1002 },
        { name: "a stored width that fits", stored: 700, room: 1362, want: 700 },
        { name: "a stored width under the floor", stored: 200, room: 1362, want: 360 },
        { name: "the 600 default for the widest in an unmeasured row", stored: null, room: Infinity, want: 600 },
        { name: "the stored width in an unmeasured row", stored: 700, room: Infinity, want: 700 },
    ])("gives $name", ({ stored, room, want }) => {
        expect(boardPaneWidth(stored, room)).toBe(want);
    });
});

describe("paneShape", () => {
    it("is none with no tabs, whatever the flags say", () => {
        expect(paneShape(EMPTY_WORKSPACE)).toBe("none");
    });

    it("is open with tabs, strip when collapsed, and expanded when expanded", () => {
        const s = withTabs(run("r1"));
        expect(paneShape(s)).toBe("open");
        expect(paneShape(setCollapsed(s, true))).toBe("strip");
        expect(paneShape(setExpanded(s, true))).toBe("expanded");
    });
});

describe("tabLabel", () => {
    it("names a run by its title, and by its id until the title loads", () => {
        expect(tabLabel(run("r-7f3a"), "stats and dedupe")).toBe("Run · stats and dedupe");
        expect(tabLabel(run("r-7f3a"), undefined)).toBe("Run · r-7f3a");
    });

    it("names Changes plainly and a file by its base name, on either separator", () => {
        expect(tabLabel(changes, undefined)).toBe("Changes");
        expect(tabLabel(file("internal/stats/stats.go", 17), undefined)).toBe("stats.go");
        expect(tabLabel(file("C:\\src\\pkg\\main.go", null), undefined)).toBe("main.go");
    });

    it("names the brainstorm and the canvas by their topic, and by kind alone without one", () => {
        expect(tabLabel({ kind: "brainstorm" }, "tag search")).toBe("Brainstorm · tag search");
        expect(tabLabel({ kind: "canvas" }, "import-screen")).toBe("Canvas · import-screen");
        expect(tabLabel({ kind: "brainstorm" }, undefined)).toBe("Brainstorm");
        expect(tabLabel({ kind: "canvas" }, "")).toBe("Canvas");
    });

    it("names Docs plainly and an Initiative by its title, and by kind alone until the title loads", () => {
        expect(tabLabel(docs(null), undefined)).toBe("Docs");
        expect(tabLabel(initiative("e1"), "Stats and dedupe")).toBe("Initiative · Stats and dedupe");
        expect(tabLabel(initiative("e1"), undefined)).toBe("Initiative");
    });

    it("names a Task tab by its task id and the Final tab plainly", () => {
        expect(tabLabel({ kind: "task", runId: "r1", taskId: "t-4" }, undefined)).toBe("Task · t-4");
        expect(tabLabel({ kind: "final", runId: "r1", round: 2 }, undefined)).toBe("Final");
    });
});

describe("tabWaiting", () => {
    const ask = (runId: string, owner: string) => ({ runId, owner });
    const asks = (...items: { runId: string; owner: string }[]) =>
        items.reduce<Record<string, { owner?: string }[]>>((acc, a) => {
            (acc[a.runId] ??= []).push({ owner: a.owner });
            return acc;
        }, {});

    it("counts a Run tab's user-owned asks, not the lead's", () => {
        const runAsks = asks(ask("r1", "user"), ask("r1", "lead"), ask("r1", "user"), ask("r2", "user"));
        expect(tabWaiting(run("r1"), { runAsks, brainstormAsking: false, failedFinals: [] })).toBe(2);
        expect(tabWaiting(run("r3"), { runAsks, brainstormAsking: false, failedFinals: [] })).toBe(0);
    });

    it("counts one for an asking Brainstorm tab and nothing for the other kinds", () => {
        const input = { runAsks: {}, brainstormAsking: true, failedFinals: [] };
        expect(tabWaiting({ kind: "brainstorm" }, input)).toBe(1);
        expect(tabWaiting({ kind: "brainstorm" }, { ...input, brainstormAsking: false, failedFinals: [] })).toBe(0);
        expect(tabWaiting(changes, input)).toBe(0);
        expect(tabWaiting(file("a.go", 1), input)).toBe(0);
        expect(tabWaiting({ kind: "canvas" }, input)).toBe(0);
    });

    it("marks a Final tab while its run's current round failed and the run holds an ask of yours", () => {
        const final: WorkspaceTab = { kind: "final", runId: "r1", round: null };
        const input = { runAsks: asks(ask("r1", "user")), brainstormAsking: false, failedFinals: ["r1"] };
        expect(tabWaiting(final, input)).toBe(1);
        expect(tabWaiting(final, { ...input, failedFinals: [] })).toBe(0);
        expect(tabWaiting(final, { ...input, runAsks: asks(ask("r1", "lead")) })).toBe(0);
    });
});

describe("iconOnlyTabs", () => {
    // three 100px tabs with the strip's 2px gaps between them take 304px
    const widths = [100, 100, 100];

    it("keeps every label while the full widths fit, the room exactly included", () => {
        expect(iconOnlyTabs(widths, 400, 0)).toEqual([false, false, false]);
        expect(iconOnlyTabs(widths, 304, 1)).toEqual([false, false, false]);
    });

    it("drops every tab but the shown one to its icon once the full widths overflow", () => {
        expect(iconOnlyTabs(widths, 303, 1)).toEqual([true, false, true]);
        expect(iconOnlyTabs(widths, 50, 2)).toEqual([true, true, false]);
    });

    it("never compacts the shown tab, even alone and over the room", () => {
        expect(iconOnlyTabs([500], 100, 0)).toEqual([false]);
    });

    it("compacts every tab when none is shown", () => {
        expect(iconOnlyTabs(widths, 303, -1)).toEqual([true, true, true]);
        expect(iconOnlyTabs([], 0, -1)).toEqual([]);
    });
});

describe("addTab", () => {
    it("opens the pane on the tab when it has none", () => {
        const s = addTab(EMPTY_WORKSPACE, changes);
        expect(s.tabs.map(tabKey)).toEqual(["changes"]);
        expect(s.active).toBe("changes");
        expect(s.unseen).toEqual([]);
    });

    it("joins behind the active tab, marked unseen", () => {
        const s = addTab(withTabs(file("a.ts", 3)), run("r1"));
        expect(s.tabs.map(tabKey)).toEqual(["file:a.ts", "run:r1"]);
        expect(s.active).toBe("file:a.ts");
        expect(s.unseen).toEqual(["run:r1"]);
    });

    it("marks an existing tab once and keeps its sub-state", () => {
        const s0 = updateTab(withTabs(changes, file("a.ts", 3)), "changes", { selected: "b.ts" });
        const s = addTab(addTab(s0, changes), changes);
        expect(s.tabs[0]).toEqual({ kind: "changes", selected: "b.ts" });
        expect(s.unseen).toEqual(["changes"]);
    });

    it("leaves the active tab unmarked", () => {
        expect(addTab(withTabs(changes), changes).unseen).toEqual([]);
    });

    it("keeps a collapsed pane collapsed", () => {
        const s = addTab(setCollapsed(withTabs(file("a.ts", 3)), true), changes);
        expect(s.collapsed).toBe(true);
        expect(paneShape(s)).toBe("strip");
    });
});

describe("unseen", () => {
    const marked = () => addTab(withTabs(file("a.ts", 3)), run("r1"));

    it("clears when the tab is activated", () => {
        expect(activateTab(marked(), "run:r1").unseen).toEqual([]);
    });

    it("clears when the tab is opened", () => {
        expect(openTab(marked(), run("r1")).unseen).toEqual([]);
    });

    it("goes with its closed tab", () => {
        expect(closeTab(marked(), "run:r1").unseen).toEqual([]);
    });
});

describe("the board tab", () => {
    const board = (boardId: string): WorkspaceTab => ({ kind: "board", channelId: "ch1", boardId });

    it("keys one tab per board", () => {
        expect(tabKey(board("b1"))).toBe("board:b1");
        expect(tabKey(board("b2"))).not.toBe(tabKey(board("b1")));
    });

    it("names the board, and the kind alone until its name loads", () => {
        expect(tabLabel(board("b1"), "App architecture")).toBe("Board · App architecture");
        expect(tabLabel(board("b1"), undefined)).toBe("Board");
    });

    it("keeps one tab when the board is opened twice", () => {
        const s = openTab(withTabs(board("b1"), changes), board("b1"));
        expect(s.tabs.map(tabKey)).toEqual(["board:b1", "changes"]);
        expect(s.active).toBe("board:b1");
    });
});

describe("finishedRowTabs", () => {
    const lineage = {
        roles: {
            "ended:r1:t-4": { kind: "worker", leadRunId: "r1", taskId: "t-4" },
            "ended:r1:verifier:v2": { kind: "stage", leadRunId: "r1", stageRole: "verifier" },
            "ended:r1:review:rv1": { kind: "stage", leadRunId: "r1", stageRole: "plan-reviewer" },
            "final:r1": { kind: "stage", leadRunId: "r1", stageRole: "verifier" },
        },
        runs: {
            r1: {
                runId: "r1",
                channelId: "c1",
                title: "stats",
                project: "linkshelf",
                dag: { final: { state: "passed", round: 2, verifierrunid: "v2" } },
            },
        },
    } as unknown as Lineage;

    it.each<[string, string, WorkspaceTab[]]>([
        [
            "a done worker: its Task tab, then Changes",
            "ended:r1:t-4",
            [{ kind: "task", runId: "r1", taskId: "t-4" }, changes],
        ],
        [
            "the Final stage row: the current round's Final tab, then Changes",
            "final:r1",
            [{ kind: "final", runId: "r1", round: null }, changes],
        ],
        [
            "an ended verifier: the Final tab on its round, marked as its session, then Changes",
            "ended:r1:verifier:v2",
            [{ kind: "final", runId: "r1", round: 2, session: "v2" }, changes],
        ],
        ["an ended plan reviewer: nothing", "ended:r1:review:rv1", []],
        ["a live agent: nothing", "tab-1", []],
        ["an ended id the lineage has not placed yet: nothing", "ended:r9:t-1", []],
    ])("%s", (_what, id, want) => {
        expect(finishedRowTabs(id, lineage)).toEqual(want);
    });
});
