// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Whether an agent's brainstorm or canvas is showing, and the one way to show or hide either. In the Terminal view
// one takes over the center (its `mode`); in Rendered it is the workspace pane's tab, shown while that tab is the
// active tab of an uncollapsed pane. Every key, badge, poller and router asks here, so the two views never drift.

import { globalStore } from "@/app/store/jotaiStore";
import { useAtomValue } from "jotai";
import type { AgentsViewModel } from "./agents";
import { brainstormAtom, setBrainstormMode, stampBrainstormViewed } from "./brainstormstore";
import { canvasStateAtom, setCanvasMode, setMarking, stampCanvasViewed } from "./canvasstore";
import { pickerFlipAtom, viewModeAtom } from "./renderedmode";
import { focusSubagentAtom } from "./subagentsstore";
import type { WorkspaceState } from "./workspacemodel";
import { closeWorkspaceTab, openWorkspaceTab, rendersNow, workspaceAtom } from "./workspacestore";

export type PaneKind = "brainstorm" | "canvas";

// in Rendered each has its own tab, so an agent with both shows whichever tab is active. In Terminal an agent with a
// brainstorm never shows its canvas: the brainstorm pane opens its boards
export function shownPane(
    rendered: boolean,
    brainstorm: { mode: "terminal" | "brainstorm" } | null,
    canvas: { mode: "terminal" | "canvas" } | null,
    ws: WorkspaceState
): PaneKind | null {
    if (rendered) {
        if (ws.collapsed) {
            return null;
        }
        if (ws.active === "brainstorm" && brainstorm != null) {
            return "brainstorm";
        }
        return ws.active === "canvas" && canvas != null ? "canvas" : null;
    }
    const kind: PaneKind | null = brainstorm != null ? "brainstorm" : canvas != null ? "canvas" : null;
    if (kind == null) {
        return null;
    }
    const on = kind === "brainstorm" ? brainstorm!.mode === "brainstorm" : canvas!.mode === "canvas";
    return on ? kind : null;
}

// reads the per-agent atoms whenstate.ts's watchFocusedCanvas subscribes, so the key hints follow a change here
export function paneShown(model: AgentsViewModel, agentId: string): PaneKind | null {
    return shownPane(
        rendersNow(model, agentId),
        globalStore.get(brainstormAtom(agentId)),
        globalStore.get(canvasStateAtom(agentId)),
        globalStore.get(workspaceAtom(agentId))
    );
}

// paneShown for a component: it subscribes to what paneShown reads, so the caller redraws when any of it changes
export function usePaneShown(model: AgentsViewModel, agentId: string): PaneKind | null {
    useAtomValue(model.agentsAtom);
    useAtomValue(focusSubagentAtom);
    useAtomValue(viewModeAtom(agentId));
    useAtomValue(pickerFlipAtom(agentId));
    useAtomValue(brainstormAtom(agentId));
    useAtomValue(canvasStateAtom(agentId));
    useAtomValue(workspaceAtom(agentId));
    return paneShown(model, agentId);
}

// the tab beside the transcript, for a Rendered card, which has no model and is Rendered by being drawn
export function openPaneTab(agentId: string, kind: PaneKind, now: number): void {
    if (kind === "brainstorm") {
        stampBrainstormViewed(agentId, now);
    } else {
        stampCanvasViewed(agentId, now);
    }
    openWorkspaceTab(agentId, { kind });
}

// shows or hides the agent's brainstorm or canvas in the view it is in: its tab in Rendered, the center in Terminal
export function showPane(model: AgentsViewModel, agentId: string, kind: PaneKind, on: boolean, now: number): void {
    if (!rendersNow(model, agentId)) {
        if (kind === "brainstorm") {
            setBrainstormMode(agentId, on ? "brainstorm" : "terminal", now);
        } else {
            setCanvasMode(agentId, on ? "canvas" : "terminal", now);
        }
        return;
    }
    if (on) {
        openPaneTab(agentId, kind, now);
        return;
    }
    // a mark is drawn over the board where it sits on screen, so it goes with the tab, as with the center pane
    if (kind === "canvas") {
        setMarking(agentId, false);
    }
    closeWorkspaceTab(agentId, kind);
}
