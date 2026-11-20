// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { AgentsViewModel } from "./agents";
import type { AgentVM } from "./agentsviewmodel";
import type { WorkspaceTab } from "./workspacemodel";

// The workspace pane's Initiative tab: the agent's initiative plan, read-only. The body arrives with the chunk rows
// (docs/superpowers/plans/2026-11-20-workspace-surfaces.md, Task 4).
export function InitiativeTab({
    tab,
}: {
    model: AgentsViewModel;
    agent: AgentVM;
    tab: Extract<WorkspaceTab, { kind: "initiative" }>;
}) {
    return <div data-workspace-initiative={tab.effortId} className="flex min-h-0 flex-1 flex-col" />;
}
