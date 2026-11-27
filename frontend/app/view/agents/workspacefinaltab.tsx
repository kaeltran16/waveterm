// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The workspace pane's Final tab: a run's Final verification, round by round, opened beside the Final stage's row
// or an ended verifier's transcript in place of the details rail.

import type { AgentsViewModel } from "./agents";
import type { AgentVM } from "./agentsviewmodel";
import type { WorkspaceTab } from "./workspacemodel";

type FinalTabProps = {
    model: AgentsViewModel;
    agent: AgentVM;
    tab: Extract<WorkspaceTab, { kind: "final" }>;
};

export function FinalTab({ tab }: FinalTabProps) {
    return (
        <div data-workspace-final={tab.runId} className="flex min-h-0 flex-1 flex-col overflow-y-auto">
            <div
                data-workspace-final-head
                className="flex flex-none items-center gap-[10px] px-[18px] pb-[12px] pt-[16px]"
            >
                <span className="min-w-0 flex-1 truncate text-[15px] font-semibold text-primary">
                    Final verification
                </span>
            </div>
        </div>
    );
}
