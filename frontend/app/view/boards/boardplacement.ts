// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Where a board lives (decisions 11, 12): a board tied to an agent opens in that agent's workspace while the agent
// renders, and on the Boards surface otherwise (terminal view, ended, a runtime with no Rendered view, no agent, or a
// gone one). The drawer's toast for an agent's request shows unless you are looking at that agent's workspace.

import type { SurfaceKey } from "../agents/agents";
import type { PaneShape } from "../agents/workspacemodel";

export type BoardHome = { kind: "workspace"; agentId: string } | { kind: "boards" };

// renders: whether the agent's center shows the Rendered view, as workspacestore's rendersNow reads it
export function boardHome(agentTabId: string | undefined, renders: (agentId: string) => boolean): BoardHome {
    return agentTabId && renders(agentTabId) ? { kind: "workspace", agentId: agentTabId } : { kind: "boards" };
}

// what the cockpit shows now: the surface, the agent it shows, whether that agent renders, and its pane's shape
export type Looking = { surface: SurfaceKey; focusId: string | undefined; renders: boolean; pane: PaneShape };

export function drawerToastShows(agentTabId: string | undefined, looking: Looking): boolean {
    const inView = looking.pane === "open" || looking.pane === "expanded";
    return !(agentTabId && looking.surface === "agent" && looking.focusId === agentTabId && looking.renders && inView);
}
