// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
import { atoms } from "@/app/store/global-atoms";
import { globalStore } from "@/app/store/jotaiStore";
import { WorkspaceService } from "@/app/store/services";
import { RpcApi } from "@/app/store/wshclientapi";
import * as WOS from "@/app/store/wos";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { AgentsViewModel } from "@/app/view/agents/agents";
import type { PendingLaunch } from "@/app/view/agents/agentsviewmodel";
import { buildLaunchMeta, type Runtime } from "@/app/view/agents/launch";

export interface LaunchAgentOpts {
    runtime: Runtime;
    startupCommand: string;
    task: string;
    projectPath: string;
    projectName: string; // labels the roster row + carries project scope
    branch?: string;
}

// Launch a runtime as its OWN session tab (so it's a first-class roster row), focus it in the Agent
// surface, and register it as a pending launch. We do NOT setActiveTab — the cockpit stays on the
// Agents tab; the agent's process starts when its terminal mounts in the focus pane. The new tab's
// default term block is reconfigured via SetMeta before it renders, so meta is honored at controller
// start (the backend starts controllers lazily on the first terminal-view resync).
export async function launchAgent(model: AgentsViewModel, opts: LaunchAgentOpts): Promise<string> {
    let cwd = opts.projectPath;
    if (opts.runtime !== "terminal" && opts.branch?.trim()) {
        const rtn = await RpcApi.CreateWorktreeCommand(TabRpcClient, {
            projectpath: opts.projectPath,
            branch: opts.branch.trim(),
        });
        cwd = rtn.worktreepath;
    }
    const ws = globalStore.get(atoms.workspace);
    if (ws?.oid == null) {
        throw new Error("no active workspace");
    }
    const tabId = await WorkspaceService.CreateTab(ws.oid, opts.projectName, false);
    const tab = globalStore.get(WOS.getWaveObjectAtom<Tab>(WOS.makeORef("tab", tabId)));
    const blockId = tab?.blockids?.[0];
    if (blockId == null) {
        throw new Error("new tab has no block");
    }
    await RpcApi.SetMetaCommand(TabRpcClient, {
        oref: WOS.makeORef("block", blockId),
        meta: buildLaunchMeta({
            runtime: opts.runtime,
            startupCommand: opts.startupCommand,
            task: opts.task,
            cwd,
        }),
    });
    // Project the launch project's Claude memory into the lackey steering files so a Codex/agy
    // agent boots with the primary agent's brain. Fire-and-forget: a projection failure must not
    // block the launch. Terminals have no memory; claude IS the hub, so neither needs projection.
    if (opts.runtime === "codex" || opts.runtime === "antigravity") {
        void RpcApi.MemoryProjectCommand(TabRpcClient, { cwd }).catch(() => {});
    }
    await RpcApi.SetMetaCommand(TabRpcClient, {
        oref: WOS.makeORef("tab", tabId),
        meta: { "session:agent": opts.runtime, "session:label": opts.projectName },
    });
    const pending: PendingLaunch = {
        tabId,
        blockId,
        name: opts.projectName,
        project: opts.projectName,
        ts: Date.now(),
    };
    globalStore.set(model.pendingLaunchesAtom, [...globalStore.get(model.pendingLaunchesAtom), pending]);
    globalStore.set(model.focusIdAtom, tabId);
    globalStore.set(model.surfaceAtom, "agent");
    return tabId;
}
