// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { atom } from "jotai";
import { beforeEach, describe, expect, it } from "vitest";
import type { AgentsViewModel, SurfaceKey } from "./agents";
import type { AgentVM } from "./agentsviewmodel";
import { finalStageId } from "./finalstage";
import { pickerFlipAtom, viewModeAtom } from "./renderedmode";
import { endedWorkerId } from "./runlineage";
import { focusSubagentAtom } from "./subagentsstore";
import { EMPTY_WORKSPACE, type WorkspaceTab } from "./workspacemodel";
import {
    closeWorkspaceTab,
    joinWorkspaceTab,
    openBeside,
    openWorkspaceTab,
    rendersNow,
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

    it("is false for an ended worker and the final stage", () => {
        const ended = endedWorkerId(freshId("run"), "t1");
        const stage = finalStageId(freshId("run"));
        const model = fakeModel([claude(ended), claude(stage)]);
        expect(rendersNow(model, ended)).toBe(false);
        expect(rendersNow(model, stage)).toBe(false);
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
