// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { atom } from "jotai";
import { describe, expect, it } from "vitest";
import type { AgentsViewModel, SurfaceKey } from "../agents/agents";
import type { AgentVM } from "../agents/agentsviewmodel";
import { viewModeAtom } from "../agents/renderedmode";
import { rendersNow } from "../agents/workspacestore";
import { boardHome, drawerToastShows, type Looking } from "./boardplacement";

let seq = 0;
// the per-agent view atoms live for the module's lifetime, so every test gets fresh ids
const freshId = (tag: string) => `${tag}-${++seq}`;

const agent = (id: string, over: Partial<AgentVM> = {}): AgentVM => ({
    id,
    name: id,
    task: "",
    state: "idle",
    agent: "claude",
    blockId: `block-${id}`,
    ...over,
});

function homeOf(agents: AgentVM[], agentTabId: string | undefined) {
    const model = { agentsAtom: atom(agents) } as unknown as AgentsViewModel;
    return boardHome(agentTabId, (id) => rendersNow(model, id));
}

describe("boardHome", () => {
    it("opens a tied board in its agent's workspace while that agent renders", () => {
        const id = freshId("claude");
        expect(homeOf([agent(id)], id)).toEqual({ kind: "workspace", agentId: id });
    });

    it("opens a pi agent's board in its workspace too", () => {
        const id = freshId("pi");
        expect(homeOf([agent(id, { agent: "pi" })], id)).toEqual({ kind: "workspace", agentId: id });
    });

    it("opens on Boards when the agent shows its terminal", () => {
        const id = freshId("term");
        globalStore.set(viewModeAtom(id), "terminal");
        expect(homeOf([agent(id)], id)).toEqual({ kind: "boards" });
    });

    it("opens on Boards for a codex agent", () => {
        const id = freshId("codex");
        expect(homeOf([agent(id, { agent: "codex" })], id)).toEqual({ kind: "boards" });
    });

    it("opens on Boards with no agent, and when the agent is gone", () => {
        expect(homeOf([agent(freshId("other"))], undefined)).toEqual({ kind: "boards" });
        expect(homeOf([], freshId("gone"))).toEqual({ kind: "boards" });
    });
});

describe("drawerToastShows", () => {
    const AGENT = "tab-1";
    const lookingAt = (over: Partial<Looking> = {}): Looking => ({
        surface: "agent" as SurfaceKey,
        focusId: AGENT,
        renders: true,
        pane: "open",
        ...over,
    });

    it("stays quiet while the Agent surface shows that agent with its pane open or expanded", () => {
        expect(drawerToastShows(AGENT, lookingAt())).toBe(false);
        expect(drawerToastShows(AGENT, lookingAt({ pane: "expanded" }))).toBe(false);
    });

    it("shows on another surface", () => {
        expect(drawerToastShows(AGENT, lookingAt({ surface: "boards" }))).toBe(true);
    });

    it("shows while another agent is shown", () => {
        expect(drawerToastShows(AGENT, lookingAt({ focusId: "tab-2" }))).toBe(true);
    });

    it("shows when the pane is collapsed to its strip, or there is none", () => {
        expect(drawerToastShows(AGENT, lookingAt({ pane: "strip" }))).toBe(true);
        expect(drawerToastShows(AGENT, lookingAt({ pane: "none" }))).toBe(true);
    });

    it("shows when the agent shows its terminal, where no pane is drawn", () => {
        expect(drawerToastShows(AGENT, lookingAt({ renders: false }))).toBe(true);
    });

    it("always shows for a board with no agent", () => {
        expect(drawerToastShows(undefined, lookingAt({ focusId: undefined }))).toBe(true);
    });
});
