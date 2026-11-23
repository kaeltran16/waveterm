// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Per-agent canvas state. Keyed by agent id, so switching the focused agent never touches another agent's
// terminal/canvas mode, and held in atoms because the Agent surface's own useState is not the only reader.

import { globalStore } from "@/app/store/jotaiStore";
import { atom, type PrimitiveAtom } from "jotai";
import { atomFamily } from "jotai/utils";
import type { AgentsViewModel } from "./agents";
import type { Mark } from "./canvasmarks";
import { ALL_TAB, canvasTabs, currentTab, stepTab, type CanvasBoard } from "./canvasmodel";
import { digitTab, OTHER_TAB, otherBoards, windowTab, windowTabs, type WindowScope } from "./canvaswindowmodel";
import { closeWorkspaceTab } from "./workspacestore";

export type CanvasState = {
    topic: string;
    dir: string;
    projectDir: string;
    mode: "terminal" | "canvas";
    board: string | null;
    // every board side by side (the All tab), rather than the selected one alone
    all: boolean;
    boards: CanvasBoard[];
    // where wavesrv serves the project's design folder; null until the poller has asked it to
    base: string | null;
    status: "probing" | "ready" | "server-down" | "removed";
    lastModifiedMs: number | null;
    lastViewedMs: number;
    marking: boolean;
    // drawn and not yet sent; a new box replaces it
    mark: Mark | null;
    reloadKey: number;
    // each served board's Last-Modified: the Mockup row's "updated" and which boards are served
    boardModifiedMs?: Record<string, number>;
};

// cast because a null initial value picks jotai's read-only overload under the non-strict tsconfig
export const canvasStateAtom = atomFamily(
    (_agentId: string) => atom<CanvasState | null>(null) as PrimitiveAtom<CanvasState | null>
);

// the agent whose canvas window (the Rendered view's modal over its boards) is open: one window at most
export const canvasWindowAtom = atom<string | null>(null) as PrimitiveAtom<string | null>;

// what the open window is for (a brainstorm question's answers or a part's boards); null on an unscoped window
export const canvasWindowScopeAtom = atom<WindowScope | null>(null) as PrimitiveAtom<WindowScope | null>;

// atomFamily can't be enumerated, and canvasOwner has to find an agent by topic
const attached = new Set<string>();

export function getCanvas(agentId: string): CanvasState | null {
    return globalStore.get(canvasStateAtom(agentId));
}

export function updateCanvas(agentId: string, fn: (s: CanvasState) => CanvasState): void {
    const s = getCanvas(agentId);
    if (s != null) {
        globalStore.set(canvasStateAtom(agentId), fn(s));
    }
}

export function attachCanvas(
    agentId: string,
    a: { topic: string; dir: string; projectDir: string; board?: string },
    now: number
): void {
    const prev = getCanvas(agentId);
    let next: CanvasState;
    if (prev != null && prev.topic === a.topic) {
        const board = a.board ?? prev.board;
        // a reveal naming a board opens that board's own tab
        const all = a.board != null ? false : prev.all;
        const keep = board === prev.board && all === prev.all;
        // the base is the old project's design folder, so a canvas re-attached from another project drops it
        const base = a.projectDir === prev.projectDir ? prev.base : null;
        next = { ...prev, dir: a.dir, projectDir: a.projectDir, board, all, base, mark: keep ? prev.mark : null };
    } else {
        next = {
            topic: a.topic,
            dir: a.dir,
            projectDir: a.projectDir,
            mode: "terminal",
            board: a.board ?? null,
            all: false,
            boards: [],
            base: null,
            status: "probing",
            lastModifiedMs: null,
            lastViewedMs: now,
            marking: false,
            mark: null,
            reloadKey: 0,
        };
    }
    attached.add(agentId);
    globalStore.set(canvasStateAtom(agentId), next);
}

// its workspace tab goes with it: left open, the tab would draw an empty body
export function detachCanvas(agentId: string): void {
    attached.delete(agentId);
    if (globalStore.get(canvasWindowAtom) === agentId) {
        globalStore.set(canvasWindowAtom, null);
        globalStore.set(canvasWindowScopeAtom, null);
    }
    globalStore.set(canvasStateAtom(agentId), null);
    closeWorkspaceTab(agentId, "canvas");
}

// live is the roster's ids: a closed agent's canvas is never detached (only the removed-canvas button does that), so
// the lookup has to skip it rather than land on an agent the surface no longer has
export function canvasOwner(topic: string, live: ReadonlySet<string>): string | null {
    for (const id of attached) {
        if (live.has(id) && getCanvas(id)?.topic === topic) {
            return id;
        }
    }
    return null;
}

// mode is the Terminal view's: whether the canvas takes over the center there (agentpanes.ts's showPane)
export function setCanvasMode(agentId: string, mode: "terminal" | "canvas", now: number): void {
    updateCanvas(agentId, (s) =>
        mode === "canvas"
            ? { ...s, mode, lastViewedMs: now }
            : { ...s, mode, marking: false, mark: null }
    );
}

// showing the canvas, in either view, is a look at it
export function stampCanvasViewed(agentId: string, now: number): void {
    updateCanvas(agentId, (s) => ({ ...s, lastViewedMs: now }));
}

// a mark is drawn over one board where it sits on screen, so any board or view switch drops it
function withTab(s: CanvasState, tab: string | null): CanvasState {
    return tab === ALL_TAB ? { ...s, all: true, mark: null } : { ...s, all: false, board: tab ?? s.board, mark: null };
}

// [ and ] walk the tabs, All included
export function stepCanvasBoard(agentId: string, delta: number): void {
    updateCanvas(agentId, (s) => withTab(s, stepTab(canvasTabs(s.boards), currentTab(s), delta)));
}

export function selectCanvasTab(agentId: string, tab: string): void {
    updateCanvas(agentId, (s) => withTab(s, tab));
}

// a board picked on the All canvas: the view stays, the selection moves

export function selectCanvasBoard(agentId: string, board: string): void {
    updateCanvas(agentId, (s) => ({ ...s, board, mark: null }));
}

// a window on an agent with no canvas would draw nothing, so it does not open
export function openCanvasWindow(
    agentId: string,
    at: { board?: string; mark?: boolean; scope?: WindowScope } = {}
): void {
    if (getCanvas(agentId) == null) {
        return;
    }
    globalStore.set(canvasWindowScopeAtom, at.scope ?? null);
    if (at.board != null) {
        selectCanvasTab(agentId, at.board);
    }
    if (at.mark) {
        updateCanvas(agentId, (s) => ({ ...s, marking: true, mark: null }));
    }
    globalStore.set(canvasWindowAtom, agentId);
}

// Other boards is the grid of the boards outside the scope's tabs, or the one board alone when there is only one
function withWindowTab(scope: WindowScope, s: CanvasState, tab: string): CanvasState {
    if (tab !== OTHER_TAB) {
        return withTab(s, tab);
    }
    const others = otherBoards(scope, s.boards);
    if (others.length === 0) {
        return s;
    }
    return others.length === 1 ? withTab(s, others[0].name) : { ...s, all: true, mark: null };
}

// [ and ] in the window: the scope's tabs and Other boards when scoped, else today's walk
export function stepCanvasWindow(agentId: string, delta: number): void {
    const scope = globalStore.get(canvasWindowScopeAtom);
    if (scope == null) {
        stepCanvasBoard(agentId, delta);
        return;
    }
    updateCanvas(agentId, (s) => {
        const tab = stepTab(windowTabs(scope, s.boards), windowTab(scope, s), delta);
        return tab == null ? s : withWindowTab(scope, s, tab);
    });
}

// a board name outside the scope's tabs is a pick from the Other boards grid: shown alone, the tab staying Other boards
export function selectCanvasWindowTab(agentId: string, tab: string): void {
    const scope = globalStore.get(canvasWindowScopeAtom);
    if (scope == null) {
        selectCanvasTab(agentId, tab);
        return;
    }
    updateCanvas(agentId, (s) => withWindowTab(scope, s, tab));
}

export function selectCanvasWindowDigit(agentId: string, digit: number): void {
    const scope = globalStore.get(canvasWindowScopeAtom);
    const tab = scope == null ? null : digitTab(scope, digit);
    if (tab != null) {
        selectCanvasWindowTab(agentId, tab);
    }
}

export function closeCanvasWindow(): void {
    const id = globalStore.get(canvasWindowAtom);
    if (id == null) {
        return;
    }
    globalStore.set(canvasWindowAtom, null);
    globalStore.set(canvasWindowScopeAtom, null);
    setMarking(id, false);
}

export function setMarking(agentId: string, on: boolean): void {
    updateCanvas(agentId, (s) => (on ? { ...s, marking: true } : { ...s, marking: false, mark: null }));
}

export function setMark(agentId: string, mark: Mark | null): void {
    updateCanvas(agentId, (s) => ({ ...s, mark }));
}

export function focusedCanvas(model: AgentsViewModel): CanvasState | null {
    const id = globalStore.get(model.focusIdAtom);
    return id ? getCanvas(id) : null;
}
