// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The workspace pane's Task tab: a finished task as its lead's run recorded it, opened beside the ended worker's
// transcript in place of the details rail.

import { useAtomValue } from "jotai";
import type { AgentsViewModel } from "./agents";
import type { AgentVM } from "./agentsviewmodel";
import type { WorkspaceTab } from "./workspacemodel";

type TaskTabProps = {
    model: AgentsViewModel;
    agent: AgentVM;
    tab: Extract<WorkspaceTab, { kind: "task" }>;
};

export function TaskTab({ model, tab }: TaskTabProps) {
    // the lead's run from the lineage the tree already holds, so a run only the page knows still reads
    const run = useAtomValue(model.lineageAtom).runs[tab.runId];
    const task = run?.dag?.tasks?.find((t) => t.id === tab.taskId);
    return (
        <div data-workspace-task={tab.taskId} className="flex min-h-0 flex-1 flex-col overflow-y-auto">
            <div
                data-workspace-task-head
                className="flex flex-none items-center gap-[10px] px-[18px] pb-[12px] pt-[16px]"
            >
                <span className="min-w-0 flex-1 truncate text-[15px] font-semibold text-primary">
                    {task?.label || tab.taskId}
                </span>
            </div>
        </div>
    );
}
