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

describe("rendersNow", () => {
    it("is true for a live claude agent in the Rendered view", () => {
        const id = freshId("c");
        expect(rendersNow(fakeModel([claude(id)]), id)).toBe(true);
    });

    it("is false for an agent the roster does not hold", () => {
        expect(rendersNow(fakeModel([]), freshId("gone"))).toBe(false);
    });

    it("is false for another runtime, a plain terminal, or no block", () => {
        const pi = freshId("pi");
        const term = freshId("term");
        const noBlock = freshId("nb");
        const model = fakeModel([
            claude(pi, { agent: "pi" }),
            claude(term, { kind: "terminal" }),
            claude(noBlock, { blockId: undefined }),
        ]);
        expect(rendersNow(model, pi)).toBe(false);
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
