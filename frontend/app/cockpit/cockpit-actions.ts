// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
import { globalStore } from "@/app/store/jotaiStore";
import { ObjectService } from "@/app/store/services";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { AgentsViewModel } from "@/app/view/agents/agents";
import { buildLaunchMeta, type Runtime } from "@/app/view/agents/launch";

export interface LaunchAgentOpts {
    runtime: Runtime;
    startupCommand: string;
    task: string;
    projectPath: string;
    branch?: string; // wired in Phase 3
}

// Launch a runtime in the chosen project directory and route to the Agent surface. The new term
// block's controller starts on render; a claude/codex session joins the roster via the reporter.
export async function launchAgent(model: AgentsViewModel, opts: LaunchAgentOpts): Promise<void> {
    let cwd = opts.projectPath;
    if (opts.runtime !== "terminal" && opts.branch?.trim()) {
        const rtn = await RpcApi.CreateWorktreeCommand(TabRpcClient, {
            projectpath: opts.projectPath,
            branch: opts.branch.trim(),
        });
        cwd = rtn.worktreepath;
    }
    const blockId = await ObjectService.CreateBlock(
        {
            meta: buildLaunchMeta({
                runtime: opts.runtime,
                startupCommand: opts.startupCommand,
                task: opts.task,
                cwd,
            }),
        },
        { termsize: { rows: 40, cols: 120 } }
    );
    globalStore.set(model.terminalTargetAtom, blockId);
    globalStore.set(model.surfaceAtom, "agent");
}
