// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    activateTab,
    closeTab,
    EMPTY_WORKSPACE,
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
    waitingOnYou,
    type WorkspaceState,
    type WorkspaceTab,
} from "./workspacemodel";

const run = (runId: string): WorkspaceTab => ({ kind: "run", runId, view: "tasks" });
const file = (path: string, line: number | null): WorkspaceTab => ({ kind: "file", path, line });
const changes: WorkspaceTab = { kind: "changes", selected: null };

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

    it("keeps a reopened Changes tab's selection", () => {
        const s0 = updateTab(withTabs(changes), "changes", { selected: "b.ts" });
        expect(openTab(s0, changes).tabs[0]).toEqual({ kind: "changes", selected: "b.ts" });
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
});

describe("tabWaiting and waitingOnYou", () => {
    const ask = (runId: string, owner: string) => ({ runId, owner });
    const asks = (...items: { runId: string; owner: string }[]) =>
        items.reduce<Record<string, { owner?: string }[]>>((acc, a) => {
            (acc[a.runId] ??= []).push({ owner: a.owner });
            return acc;
        }, {});

    it("counts a Run tab's user-owned asks, not the lead's", () => {
        const runAsks = asks(ask("r1", "user"), ask("r1", "lead"), ask("r1", "user"), ask("r2", "user"));
        expect(tabWaiting(run("r1"), { runAsks, brainstormAsking: false })).toBe(2);
        expect(tabWaiting(run("r3"), { runAsks, brainstormAsking: false })).toBe(0);
    });

    it("counts one for an asking Brainstorm tab and nothing for the other kinds", () => {
        const input = { runAsks: {}, brainstormAsking: true };
        expect(tabWaiting({ kind: "brainstorm" }, input)).toBe(1);
        expect(tabWaiting({ kind: "brainstorm" }, { ...input, brainstormAsking: false })).toBe(0);
        expect(tabWaiting(changes, input)).toBe(0);
        expect(tabWaiting(file("a.go", 1), input)).toBe(0);
        expect(tabWaiting({ kind: "canvas" }, input)).toBe(0);
    });

    it("sums what waits on you across the open tabs", () => {
        const runAsks = asks(ask("r1", "user"), ask("r2", "user"), ask("r2", "user"), ask("r9", "user"));
        const tabs = [run("r1"), run("r2"), changes, { kind: "brainstorm" } as WorkspaceTab];
        expect(waitingOnYou(tabs, { runAsks, brainstormAsking: true })).toBe(4);
        expect(waitingOnYou([], { runAsks, brainstormAsking: true })).toBe(0);
    });
});
