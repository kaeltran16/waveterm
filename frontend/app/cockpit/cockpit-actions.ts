// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
import { globalStore } from "@/app/store/jotaiStore";
import { ObjectService } from "@/app/store/services";
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
    const cwd = opts.projectPath; // Phase 3 replaces this with the worktree path when a branch is set
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
