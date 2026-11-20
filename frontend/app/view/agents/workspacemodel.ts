// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The Rendered view's workspace pane: the tabs an agent opened beside its transcript, which one is active, and
// whether the pane is collapsed to its strip or expanded over the center. Pure, so the store and the views share one
// set of transitions.

import { ASK_OWNER_USER } from "./childaskmodel";

export type RunView = "tasks" | "activity" | "graph";

// the Graph view's mode, its one selected task, and the Focus back trail; kept on the tab so a view swap keeps it
export type RunGraphState = { mode: "lanes" | "focus"; focus: string | null; trail: string[] };

export type WorkspaceTab =
    | { kind: "run"; runId: string; view: RunView; graph?: RunGraphState }
    | { kind: "changes"; selected: string | null }
    | { kind: "file"; path: string; line: number | null }
    // selected: the absolute path of the shown doc; null is the newest
    | { kind: "docs"; selected: string | null }
    // open: the 1-based chunk whose notes are open; undefined is the first active chunk, null is none
    | { kind: "initiative"; effortId: string; open?: number | null }
    | { kind: "brainstorm" }
    | { kind: "canvas" }
    | { kind: "board"; channelId: string; boardId: string };

// unseen: the keys of tabs that joined behind the active one and have not been shown since
export type WorkspaceState = {
    tabs: WorkspaceTab[];
    active: string | null;
    collapsed: boolean;
    expanded: boolean;
    unseen: string[];
};

export const EMPTY_WORKSPACE: WorkspaceState = {
    tabs: [],
    active: null,
    collapsed: false,
    expanded: false,
    unseen: [],
};

function seen(state: WorkspaceState, key: string): string[] {
    return state.unseen.includes(key) ? state.unseen.filter((k) => k !== key) : state.unseen;
}

export const DEFAULT_PANE_PX = 600;
export const MIN_PANE_PX = 360;
export const MIN_TRANSCRIPT_PX = 360;
export const STRIP_PX = 44;

// one tab per key, so a second click on the same link activates its tab rather than piling up a duplicate
export function tabKey(tab: WorkspaceTab): string {
    switch (tab.kind) {
        case "run":
            return `run:${tab.runId}`;
        case "file":
            return `file:${tab.path}`;
        case "board":
            return `board:${tab.boardId}`;
        case "initiative":
            return `initiative:${tab.effortId}`;
        default:
            return tab.kind;
    }
}

// the transcript keeps its minimum until the pane reaches its own, which then wins: a pane under 360 holds no tab
export function paneWidth(stored: number, availablePx: number): number {
    const want = Number.isFinite(stored) ? stored : DEFAULT_PANE_PX;
    return Math.max(MIN_PANE_PX, Math.min(want, availablePx - MIN_TRANSCRIPT_PX));
}

// reopening a key keeps the tab's sub-state (a Run tab's view, the Changes selection), except a File tab's line,
// which is what the new link cites, and a Docs tab's selection when the new open names a doc
export function openTab(state: WorkspaceState, tab: WorkspaceTab): WorkspaceState {
    const key = tabKey(tab);
    const at = state.tabs.findIndex((t) => tabKey(t) === key);
    const replaces = tab.kind === "file" || (tab.kind === "docs" && tab.selected != null);
    const tabs = at < 0 ? [...state.tabs, tab] : replaces ? state.tabs.map((t, i) => (i === at ? tab : t)) : state.tabs;
    return { ...state, tabs, active: key, collapsed: false, unseen: seen(state, key) };
}

// joins the pane without taking it over: behind the active tab, marked unseen, a collapsed pane left collapsed. With no
// pane yet there is nothing to take over, so the tab opens it
export function addTab(state: WorkspaceState, tab: WorkspaceTab): WorkspaceState {
    if (state.tabs.length === 0) {
        return openTab(state, tab);
    }
    const key = tabKey(tab);
    if (state.active === key) {
        return state;
    }
    const has = state.tabs.some((t) => tabKey(t) === key);
    const unseen = state.unseen.includes(key) ? state.unseen : [...state.unseen, key];
    return { ...state, tabs: has ? state.tabs : [...state.tabs, tab], unseen };
}

// closing the active tab activates its right neighbour, else its left; the pane goes with its last tab
export function closeTab(state: WorkspaceState, key: string): WorkspaceState {
    const at = state.tabs.findIndex((t) => tabKey(t) === key);
    if (at < 0) {
        return state;
    }
    const tabs = state.tabs.filter((_, i) => i !== at);
    if (tabs.length === 0) {
        return EMPTY_WORKSPACE;
    }
    const active = state.active === key ? tabKey(tabs[Math.min(at, tabs.length - 1)]) : state.active;
    return { ...state, tabs, active, unseen: state.unseen.filter((k) => k !== key && k !== active) };
}

export function activateTab(state: WorkspaceState, key: string): WorkspaceState {
    if (state.active === key || !state.tabs.some((t) => tabKey(t) === key)) {
        return state;
    }
    return { ...state, active: key, unseen: seen(state, key) };
}

// a patch only changes a tab's sub-state: one that would change its kind or key is refused
export function updateTab(state: WorkspaceState, key: string, patch: Partial<WorkspaceTab>): WorkspaceState {
    const at = state.tabs.findIndex((t) => tabKey(t) === key);
    if (at < 0) {
        return state;
    }
    const next = { ...state.tabs[at], ...patch } as WorkspaceTab;
    if (next.kind !== state.tabs[at].kind || tabKey(next) !== key) {
        return state;
    }
    return { ...state, tabs: state.tabs.map((t, i) => (i === at ? next : t)) };
}

// collapsed and expanded never hold together: collapsing clears expanded, expanding restores the pane
export function setCollapsed(state: WorkspaceState, collapsed: boolean): WorkspaceState {
    if (state.tabs.length === 0 || state.collapsed === collapsed) {
        return state;
    }
    return { ...state, collapsed, expanded: collapsed ? false : state.expanded };
}

export function setExpanded(state: WorkspaceState, expanded: boolean): WorkspaceState {
    if (state.tabs.length === 0 || state.expanded === expanded) {
        return state;
    }
    return { ...state, expanded, collapsed: expanded ? false : state.collapsed };
}

export function toggleCollapsed(state: WorkspaceState): WorkspaceState {
    return setCollapsed(state, !state.collapsed);
}

export type PaneShape = "none" | "open" | "strip" | "expanded";

// what the surface draws: no pane, the pane beside the transcript, the collapsed strip, or the pane over the center
export function paneShape(state: WorkspaceState): PaneShape {
    if (state.tabs.length === 0) {
        return "none";
    }
    return state.collapsed ? "strip" : state.expanded ? "expanded" : "open";
}

// name: the run's title for a Run tab, the topic for Brainstorm and Canvas, the board's name, the initiative's title; a
// run not loaded yet shows its id
export function tabLabel(tab: WorkspaceTab, name: string | undefined): string {
    switch (tab.kind) {
        case "run":
            return `Run · ${name || tab.runId}`;
        case "changes":
            return "Changes";
        case "file":
            return tab.path.split(/[\\/]/).pop() || tab.path;
        case "docs":
            return "Docs";
        case "initiative":
            return name ? `Initiative · ${name}` : "Initiative";
        case "brainstorm":
            return name ? `Brainstorm · ${name}` : "Brainstorm";
        case "canvas":
            return name ? `Canvas · ${name}` : "Canvas";
        case "board":
            return name ? `Board · ${name}` : "Board";
    }
}

export const TAB_GAP_PX = 2;

// decided from every tab's full width, never the compacted ones, so dropping to icons cannot flip the decision back;
// shown is the active tab's index (-1 for none), which always keeps its label
export function iconOnlyTabs(fullWidths: number[], roomPx: number, shown: number): boolean[] {
    const need = fullWidths.reduce((sum, w) => sum + w, 0) + TAB_GAP_PX * Math.max(0, fullWidths.length - 1);
    return fullWidths.map((_, i) => need > roomPx && i !== shown);
}

export type WaitInput = {
    // each run's dag asks, as childAsksAtom holds them
    runAsks: Record<string, { owner?: string }[]>;
    // the agent's brainstorm waits on the user
    brainstormAsking: boolean;
};

// what a tab holds that waits on you: a Run tab's user-owned asks, one for an asking Brainstorm tab
export function tabWaiting(tab: WorkspaceTab, input: WaitInput): number {
    if (tab.kind === "run") {
        return (input.runAsks[tab.runId] ?? []).filter((a) => a.owner === ASK_OWNER_USER).length;
    }
    return tab.kind === "brainstorm" && input.brainstormAsking ? 1 : 0;
}

export function waitingOnYou(tabs: WorkspaceTab[], input: WaitInput): number {
    return tabs.reduce((n, t) => n + tabWaiting(t, input), 0);
}
