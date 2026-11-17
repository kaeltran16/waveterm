// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { AgentsViewModel } from "./agents";
import type { AgentVM } from "./agentsviewmodel";
import type { WorkspaceTab } from "./workspacemodel";

// the workspace pane's Run tab: a run's tasks, asks, activity and graph
export function RunTab({
    tab,
}: {
    model: AgentsViewModel;
    agent: AgentVM;
    tab: Extract<WorkspaceTab, { kind: "run" }>;
}) {
    return <div className="p-4 text-[12px] text-muted">Run · {tab.runId}</div>;
}
