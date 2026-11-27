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
import { canRender, effectiveViewMode, pickerFlipAtom, transcriptLook, viewModeAtom } from "./renderedmode";
import type { Lineage } from "./runlineage";
import { focusSubagentAtom } from "./subagentsstore";
import {
    activateTab,
    addTab,
    closeTab,
    DEFAULT_PANE_PX,
    EMPTY_WORKSPACE,
    finishedRowTabs,
    openTab,
    setCollapsed,
    setExpanded,
    tabKey,
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

// a dragged board width, kept apart so narrowing a board does not shrink the other tabs; null is the widest
export const workspaceBoardWidthAtom = atomWithStorage<number | null>("agent.workspace.boardwidth", null, undefined, {
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

// a board lives in one workspace (decision 12): a join takes its tab out of every other agent's, and adds it behind
// the active one, unseen, when this agent renders. Nothing remembers a closed tab, so the next join adds it again
export function joinWorkspaceTab(model: AgentsViewModel, agentId: string, tab: WorkspaceTab): void {
    const key = tabKey(tab);
    for (const other of workspaceAtoms.keys()) {
        if (other !== agentId) {
            apply(other, (s) => closeTab(s, key));
        }
    }
    if (rendersNow(model, agentId)) {
        apply(agentId, (s) => addTab(s, tab));
    }
}

// a join from outside the pane (`wsh view`): behind the active tab, unseen. A doc pushed to an existing Docs tab is
// also its selection, even while that tab is active, since the push is what asks to show it
export function pushWorkspaceTab(agentId: string, tab: WorkspaceTab): void {
    apply(agentId, (s) => addTab(s, tab));
    if (tab.kind === "docs" && tab.selected != null) {
        apply(agentId, (s) => updateTab(s, tabKey(tab), { selected: tab.selected }));
    }
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

// whether the agent's center has the workspace pane beside it (transcriptLook): a roster agent that canRender accepts,
// in its effective Rendered view, or a finished row, which the roster never holds; never with a subagent interior
// open over it
export function rendersNow(model: AgentsViewModel, agentId: string): boolean {
    if (globalStore.get(focusSubagentAtom)?.parentId === agentId) {
        return false;
    }
    const agent = globalStore.get(model.agentsAtom).find((a) => a.id === agentId);
    const view = effectiveViewMode(globalStore.get(viewModeAtom(agentId)), globalStore.get(pickerFlipAtom(agentId)));
    const rendered = agent != null && view === "rendered" && canRender(agent, { ended: false, stage: false });
    return transcriptLook(agentId, rendered);
}

// the finished rows whose pane was seeded this session: a closed tab stays closed, so the app never forgets one
const seededRows = new Set<string>();

// a finished row's first focus opens its tabs (finishedRowTabs) into an empty workspace, the first one active and
// Changes behind it unseen. A row the lineage has not placed yet is tried again on a later call
export function seedFinishedRow(agentId: string, lineage: Lineage): void {
    if (seededRows.has(agentId)) {
        return;
    }
    const [first, ...rest] = finishedRowTabs(agentId, lineage);
    if (first == null) {
        return;
    }
    seededRows.add(agentId);
    if (globalStore.get(stateAtom(agentId)).tabs.length > 0) {
        return;
    }
    apply(agentId, (s) => rest.reduce(addTab, openTab(s, first)));
}

// for the CDP scenarios, which focus the same fixture rows again in one page
export function forgetFinishedRows(agentIds: string[]): void {
    for (const id of agentIds) {
        seededRows.delete(id);
    }
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
