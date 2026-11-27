// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { atom } from "jotai";
import { beforeEach, describe, expect, it } from "vitest";
import type { AgentsViewModel, SurfaceKey } from "./agents";
import type { AgentVM } from "./agentsviewmodel";
import { finalStageId } from "./finalstage";
import { pickerFlipAtom, viewModeAtom } from "./renderedmode";
import { endedWorkerId, type Lineage } from "./runlineage";
import { focusSubagentAtom } from "./subagentsstore";
import { EMPTY_WORKSPACE, type WorkspaceTab } from "./workspacemodel";
import {
    closeWorkspaceTab,
    joinWorkspaceTab,
    openBeside,
    openWorkspaceTab,
    pushWorkspaceTab,
    rendersNow,
    seedFinishedRow,
    setWorkspaceCollapsed,
    toggleWorkspaceCollapsed,
    workspaceAtom,
} from "./workspacestore";

const RUN: WorkspaceTab = { kind: "run", runId: "r1", view: "tasks" };
const CHANGES: WorkspaceTab = { kind: "changes", selected: null };

let seq = 0;
// every test gets fresh agent ids, since the per-agent atoms live for the module's lifetime
const freshId = (tag: string) => `${tag}-${++seq}`;

const claude = (id: string, over: Partial<AgentVM> = {}): AgentVM => ({
    id,
    name: id,
    task: "",
    state: "idle",
    agent: "claude",
    blockId: `block-${id}`,
    ...over,
});

function fakeModel(agents: AgentVM[], surface: SurfaceKey = "agent"): AgentsViewModel {
    return { agentsAtom: atom(agents), surfaceAtom: atom<SurfaceKey>(surface) } as unknown as AgentsViewModel;
}

beforeEach(() => {
    globalStore.set(focusSubagentAtom, null);
});

describe("workspace store", () => {
    it("keeps one agent's tabs apart from another's actions", () => {
        const a = freshId("a");
        const b = freshId("b");
        openWorkspaceTab(a, RUN);
        openWorkspaceTab(b, CHANGES);
        setWorkspaceCollapsed(b, true);
        closeWorkspaceTab(b, "changes");
        expect(globalStore.get(workspaceAtom(a)).tabs).toEqual([RUN]);
        expect(globalStore.get(workspaceAtom(a)).collapsed).toBe(false);
        expect(globalStore.get(workspaceAtom(b))).toBe(EMPTY_WORKSPACE);
    });

    it("toggles collapse only with tabs, and says whether it did", () => {
        const a = freshId("a");
        expect(toggleWorkspaceCollapsed(a)).toBe(false);
        expect(globalStore.get(workspaceAtom(a))).toBe(EMPTY_WORKSPACE);
        openWorkspaceTab(a, RUN);
        expect(toggleWorkspaceCollapsed(a)).toBe(true);
        expect(globalStore.get(workspaceAtom(a)).collapsed).toBe(true);
    });
});

describe("joinWorkspaceTab", () => {
    const BOARD: WorkspaceTab = { kind: "board", channelId: "c1", boardId: "0a1b2c3d" };
    const KEY = "board:0a1b2c3d";

    it("adds the tab behind the active one, unseen, without changing the active tab", () => {
        const id = freshId("c");
        openWorkspaceTab(id, RUN);
        joinWorkspaceTab(fakeModel([claude(id)]), id, BOARD);
        const ws = globalStore.get(workspaceAtom(id));
        expect(ws.tabs).toEqual([RUN, BOARD]);
        expect(ws.active).toBe("run:r1");
        expect(ws.unseen).toEqual([KEY]);
    });

    it("moves the tab from another agent's workspace", () => {
        const before = freshId("a");
        const after = freshId("b");
        const model = fakeModel([claude(before), claude(after)]);
        openWorkspaceTab(before, RUN);
        joinWorkspaceTab(model, before, BOARD);
        openWorkspaceTab(after, CHANGES);
        joinWorkspaceTab(model, after, BOARD);
        expect(globalStore.get(workspaceAtom(before)).tabs).toEqual([RUN]);
        expect(globalStore.get(workspaceAtom(after)).tabs).toEqual([CHANGES, BOARD]);
    });

    it("adds the tab back after it was closed", () => {
        const id = freshId("c");
        const model = fakeModel([claude(id)]);
        openWorkspaceTab(id, RUN);
        joinWorkspaceTab(model, id, BOARD);
        closeWorkspaceTab(id, KEY);
        joinWorkspaceTab(model, id, BOARD);
        expect(globalStore.get(workspaceAtom(id)).tabs).toEqual([RUN, BOARD]);
        expect(globalStore.get(workspaceAtom(id)).unseen).toEqual([KEY]);
    });

    it("adds nothing for an agent that does not render, but still takes the tab from the others", () => {
        const before = freshId("a");
        const term = freshId("t");
        globalStore.set(viewModeAtom(term), "terminal");
        const model = fakeModel([claude(before), claude(term)]);
        openWorkspaceTab(before, RUN);
        joinWorkspaceTab(model, before, BOARD);
        joinWorkspaceTab(model, term, BOARD);
        expect(globalStore.get(workspaceAtom(before)).tabs).toEqual([RUN]);
        expect(globalStore.get(workspaceAtom(term))).toBe(EMPTY_WORKSPACE);
    });
});

describe("rendersNow", () => {
    it("is true for a live claude agent in the Rendered view", () => {
        const id = freshId("c");
        expect(rendersNow(fakeModel([claude(id)]), id)).toBe(true);
    });

    it("is false for an agent the roster does not hold", () => {
        expect(rendersNow(fakeModel([]), freshId("gone"))).toBe(false);
    });

    it("is false for another runtime, a plain terminal, or no block", () => {
        const codex = freshId("codex");
        const term = freshId("term");
        const noBlock = freshId("nb");
        const model = fakeModel([
            claude(codex, { agent: "codex" }),
            claude(term, { kind: "terminal" }),
            claude(noBlock, { blockId: undefined }),
        ]);
        expect(rendersNow(model, codex)).toBe(false);
        expect(rendersNow(model, term)).toBe(false);
        expect(rendersNow(model, noBlock)).toBe(false);
    });

    it("is false in the Terminal view, and while a picker holds the terminal", () => {
        const toggled = freshId("t");
        const flipped = freshId("f");
        globalStore.set(viewModeAtom(toggled), "terminal");
        globalStore.set(pickerFlipAtom(flipped), Date.now());
        const model = fakeModel([claude(toggled), claude(flipped)]);
        expect(rendersNow(model, toggled)).toBe(false);
        expect(rendersNow(model, flipped)).toBe(false);
    });

    it("is true for an ended worker and the final stage, which the roster never holds, in either view", () => {
        const ended = endedWorkerId(freshId("run"), "t1");
        const stage = finalStageId(freshId("run"));
        globalStore.set(viewModeAtom(stage), "terminal");
        const model = fakeModel([]);
        expect(rendersNow(model, ended)).toBe(true);
        expect(rendersNow(model, stage)).toBe(true);
    });

    it("is false while the agent's subagent interior is open, and only that agent's", () => {
        const parent = freshId("p");
        const other = freshId("o");
        globalStore.set(focusSubagentAtom, { parentId: parent, agentId: "sub1", transcriptPath: "/t", label: "x" });
        const model = fakeModel([claude(parent), claude(other)]);
        expect(rendersNow(model, parent)).toBe(false);
        expect(rendersNow(model, other)).toBe(true);
    });
});

describe("openBeside", () => {
    it("opens the tab and returns true for a Rendered agent on the Agent surface", () => {
        const id = freshId("c");
        expect(openBeside(fakeModel([claude(id)]), id, RUN, { ctrlKey: false })).toBe(true);
        expect(globalStore.get(workspaceAtom(id)).tabs).toEqual([RUN]);
        expect(globalStore.get(workspaceAtom(id)).active).toBe("run:r1");
    });

    it("opens with no event given", () => {
        const id = freshId("c");
        expect(openBeside(fakeModel([claude(id)]), id, RUN)).toBe(true);
    });

    it("declines and opens nothing with Ctrl held", () => {
        const id = freshId("c");
        expect(openBeside(fakeModel([claude(id)]), id, RUN, { ctrlKey: true })).toBe(false);
        expect(globalStore.get(workspaceAtom(id))).toBe(EMPTY_WORKSPACE);
    });

    it("declines and opens nothing off the Agent surface", () => {
        const id = freshId("c");
        expect(openBeside(fakeModel([claude(id)], "sessions"), id, RUN)).toBe(false);
        expect(globalStore.get(workspaceAtom(id))).toBe(EMPTY_WORKSPACE);
    });

    it("declines and opens nothing when the agent does not render", () => {
        const id = freshId("c");
        globalStore.set(viewModeAtom(id), "terminal");
        expect(openBeside(fakeModel([claude(id)]), id, RUN)).toBe(false);
        expect(globalStore.get(workspaceAtom(id))).toBe(EMPTY_WORKSPACE);
    });
});

describe("pushWorkspaceTab", () => {
    const DOCS: WorkspaceTab = { kind: "docs", selected: "C:\r\spec.md" };

    it("adds the tab behind the active one, unseen", () => {
        const id = freshId("c");
        openWorkspaceTab(id, CHANGES);
        pushWorkspaceTab(id, DOCS);
        const ws = globalStore.get(workspaceAtom(id));
        expect(ws.tabs).toEqual([CHANGES, DOCS]);
        expect(ws.active).toBe("changes");
        expect(ws.unseen).toEqual(["docs"]);
    });

    it("leaves a collapsed pane collapsed", () => {
        const id = freshId("c");
        openWorkspaceTab(id, CHANGES);
        setWorkspaceCollapsed(id, true);
        pushWorkspaceTab(id, DOCS);
        const ws = globalStore.get(workspaceAtom(id));
        expect(ws.collapsed).toBe(true);
        expect(ws.unseen).toEqual(["docs"]);
    });

    it("sets the selection of an existing Docs tab, active or not", () => {
        const id = freshId("c");
        openWorkspaceTab(id, { kind: "docs", selected: "C:\r\old.md" });
        pushWorkspaceTab(id, DOCS);
        expect(globalStore.get(workspaceAtom(id)).tabs).toEqual([DOCS]);
        openWorkspaceTab(id, CHANGES);
        pushWorkspaceTab(id, { kind: "docs", selected: "C:\r\plan.md" });
        expect(globalStore.get(workspaceAtom(id)).tabs[0]).toEqual({ kind: "docs", selected: "C:\r\plan.md" });
    });
});

describe("seedFinishedRow", () => {
    // a run with one done task, t-4, whose worker's row is the ended id; placed: whether the lineage has it yet
    const workerRow = (placed = true) => {
        const runId = freshId("run");
        const id = endedWorkerId(runId, "t-4");
        const lineage = {
            roles: placed ? { [id]: { kind: "worker", leadRunId: runId, taskId: "t-4" } } : {},
            runs: {},
        } as unknown as Lineage;
        return { id, lineage, taskKey: `task:${runId}:t-4` };
    };

    it("opens the row's first tab active with Changes behind it, unseen", () => {
        const { id, lineage, taskKey } = workerRow();
        seedFinishedRow(id, lineage);
        const ws = globalStore.get(workspaceAtom(id));
        expect(ws.tabs.map((t) => t.kind)).toEqual(["task", "changes"]);
        expect(ws.active).toBe(taskKey);
        expect(ws.unseen).toEqual(["changes"]);
    });

    it("seeds only once: after both tabs close, focusing the row again leaves no pane", () => {
        const { id, lineage, taskKey } = workerRow();
        seedFinishedRow(id, lineage);
        closeWorkspaceTab(id, taskKey);
        closeWorkspaceTab(id, "changes");
        seedFinishedRow(id, lineage);
        expect(globalStore.get(workspaceAtom(id))).toBe(EMPTY_WORKSPACE);
    });

    it("seeds only into an empty workspace", () => {
        const { id, lineage } = workerRow();
        openWorkspaceTab(id, RUN);
        seedFinishedRow(id, lineage);
        expect(globalStore.get(workspaceAtom(id)).tabs).toEqual([RUN]);
    });

    it("waits for a lineage that places the row, then seeds", () => {
        const { id, lineage } = workerRow(false);
        seedFinishedRow(id, lineage);
        expect(globalStore.get(workspaceAtom(id))).toBe(EMPTY_WORKSPACE);
        const placed = { ...lineage, roles: { [id]: { kind: "worker", leadRunId: "r", taskId: "t-4" } } } as Lineage;
        seedFinishedRow(id, placed);
        expect(globalStore.get(workspaceAtom(id)).tabs.map((t) => t.kind)).toEqual(["task", "changes"]);
    });
});
