// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { AgentsViewModel } from "./agents";
import type { AgentVM } from "./agentsviewmodel";
import type { WorkspaceTab } from "./workspacemodel";

// the workspace pane's Changes tab: the agent's changed files beside the selected file's diff
export function ChangesTab(_props: {
    model: AgentsViewModel;
    agent: AgentVM;
    tab: Extract<WorkspaceTab, { kind: "changes" }>;
}) {
    return <div className="p-4 text-[12px] text-muted">Changes</div>;
}
