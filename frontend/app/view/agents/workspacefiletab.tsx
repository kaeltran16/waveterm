// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { AgentsViewModel } from "./agents";
import type { AgentVM } from "./agentsviewmodel";
import type { WorkspaceTab } from "./workspacemodel";

// the workspace pane's File tab: a cited file in the Code peek, landed on the cited line
export function FileTab({
    tab,
}: {
    model: AgentsViewModel;
    agent: AgentVM;
    tab: Extract<WorkspaceTab, { kind: "file" }>;
}) {
    return <div className="p-4 text-[12px] text-muted">File · {tab.path}</div>;
}
