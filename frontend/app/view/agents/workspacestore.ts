// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The workspace pane's state: one in-memory record per agent, so its tabs survive switching agents and a flip to the
// terminal, and one persisted width, a layout preference like the window's other splits.

import { globalStore } from "@/app/store/jotaiStore";
import { atom, type Atom, type PrimitiveAtom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import type { AgentsViewModel } from "./agents";
import { applyArrivals, type Arrival } from "./autoopenmodel";
import { isFinalStageId } from "./finalstage";
import { canRender, effectiveViewMode, pickerFlipAtom, viewModeAtom } from "./renderedmode";
import { isEndedWorkerId } from "./runlineage";
import { focusSubagentAtom } from "./subagentsstore";
import {
    activateTab,
    closeTab,
    DEFAULT_PANE_PX,
    EMPTY_WORKSPACE,
    openTab,
    setCollapsed,
    setExpanded,
    toggleCollapsed,
    updateTab,
    type WorkspaceState,
    type WorkspaceTab,
} from "./workspacemodel";

const workspaceAtoms = new Map<string, PrimitiveAtom<WorkspaceState>>();

function stateAtom(agentId: string): PrimitiveAtom<WorkspaceState> {
    let a = workspaceAtoms.get(agentId);
    if (a == null) {
        a = atom(EMPTY_WORKSPACE);
        workspaceAtoms.set(agentId, a);
    }
    return a;
}

// read-only to callers: every change goes through a transition below
export function workspaceAtom(agentId: string): Atom<WorkspaceState> {
    return stateAtom(agentId);
}

// getOnInit: the pane's first frame reads the stored width rather than jumping to it from the default
export const workspaceWidthAtom = atomWithStorage<number>("agent.workspace.width", DEFAULT_PANE_PX, undefined, {
    getOnInit: true,
});

function apply(agentId: string, step: (s: WorkspaceState) => WorkspaceState): void {
    const a = stateAtom(agentId);
    globalStore.set(a, step(globalStore.get(a)));
}

export function openWorkspaceTab(agentId: string, tab: WorkspaceTab): void {
    apply(agentId, (s) => openTab(s, tab));
}

// what auto-open brings at a turn's end (autoopenmodel.ts); returns the pane it leaves
export function addArrivals(agentId: string, arrived: Arrival[]): WorkspaceState {
    apply(agentId, (s) => applyArrivals(s, arrived));
    return globalStore.get(stateAtom(agentId));
}

export function closeWorkspaceTab(agentId: string, key: string): void {
    apply(agentId, (s) => closeTab(s, key));
}

export function activateWorkspaceTab(agentId: string, key: string): void {
    apply(agentId, (s) => activateTab(s, key));
}

export function updateWorkspaceTab(agentId: string, key: string, patch: Partial<WorkspaceTab>): void {
    apply(agentId, (s) => updateTab(s, key, patch));
}

export function setWorkspaceCollapsed(agentId: string, collapsed: boolean): void {
    apply(agentId, (s) => setCollapsed(s, collapsed));
}

// false, and no change, with no tabs, so a key binding can pass the key on
export function toggleWorkspaceCollapsed(agentId: string): boolean {
    const before = globalStore.get(stateAtom(agentId));
    apply(agentId, toggleCollapsed);
    return globalStore.get(stateAtom(agentId)) !== before;
}

export function setWorkspaceExpanded(agentId: string, expanded: boolean): void {
    apply(agentId, (s) => setExpanded(s, expanded));
}

// whether the agent's center shows the Rendered view: what canRender accepts, in its effective view, with no
// subagent interior open over it
export function rendersNow(model: AgentsViewModel, agentId: string): boolean {
    const agent = globalStore.get(model.agentsAtom).find((a) => a.id === agentId);
    if (agent == null || globalStore.get(focusSubagentAtom)?.parentId === agentId) {
        return false;
    }
    const view = effectiveViewMode(globalStore.get(viewModeAtom(agentId)), globalStore.get(pickerFlipAtom(agentId)));
    return view === "rendered" && canRender(agent, { ended: isEndedWorkerId(agentId), stage: isFinalStageId(agentId) });
}

// opens the tab beside the transcript when the agent shows Rendered on the Agent surface and Ctrl is not held;
// false otherwise, and the caller keeps its own open or peek
export function openBeside(
    model: AgentsViewModel,
    agentId: string,
    tab: WorkspaceTab,
    event?: { ctrlKey: boolean }
): boolean {
    if (event?.ctrlKey || globalStore.get(model.surfaceAtom) !== "agent" || !rendersNow(model, agentId)) {
        return false;
    }
    openWorkspaceTab(agentId, tab);
    return true;
}
