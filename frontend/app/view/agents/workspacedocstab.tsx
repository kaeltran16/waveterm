// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { AgentsViewModel } from "./agents";
import type { AgentVM } from "./agentsviewmodel";
import type { WorkspaceTab } from "./workspacemodel";

// The workspace pane's Docs tab: the Markdown files the agent wrote this session, one rendered. The body arrives with
// the Docs list (docs/superpowers/plans/2026-11-20-workspace-surfaces.md, Task 3).
export function DocsTab(_props: {
    model: AgentsViewModel;
    agent: AgentVM;
    tab: Extract<WorkspaceTab, { kind: "docs" }>;
}) {
    return <div data-workspace-docs className="flex min-h-0 flex-1 flex-col" />;
}
