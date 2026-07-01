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
import { buildLaunchMeta, runtimeCreatesAgentPanel, type Runtime } from "@/app/view/agents/launch";

export interface LaunchAgentOpts {
    runtime: Runtime;
    startupCommand: string;
    task: string;
    projectPath: string;
    projectName: string; // labels the roster row + carries project scope
    branch?: string;
}

// Launch a runtime as its OWN session tab. Agent runtimes get a pending roster row; terminals only
// open in the Agent surface focus pane. We do NOT setActiveTab — the cockpit stays on the
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
    // Sync the shared brain at launch: pull the launch project's Codex facts into the Claude hub,
    // THEN project the (now-updated) hub into the lackey steering files so the agent boots with the
    // current brain and any just-harvested facts also reach the other lackeys. One fire-and-forget
    // chain — never blocks the launch; each step is independently guarded. Terminals have no memory
    // and claude IS the hub, so neither is synced here.
    if (opts.runtime === "codex" || opts.runtime === "antigravity") {
        void (async () => {
            try {
                await RpcApi.MemoryHarvestCommand(TabRpcClient, { cwd });
            } catch {
                // harvest failure must not prevent projection
            }
            try {
                await RpcApi.MemoryProjectCommand(TabRpcClient, { cwd });
            } catch {
                // projection failure must not block the launch
            }
        })();
    }
    const agentPanel = runtimeCreatesAgentPanel(opts.runtime);
    await RpcApi.SetMetaCommand(TabRpcClient, {
        oref: WOS.makeORef("tab", tabId),
        meta: agentPanel
            ? { "session:agent": opts.runtime, "session:label": opts.projectName }
            : { "session:label": opts.projectName },
    });
    if (agentPanel) {
        const pending: PendingLaunch = {
            tabId,
            blockId,
            name: opts.projectName,
            project: opts.projectName,
            ts: Date.now(),
        };
        globalStore.set(model.pendingLaunchesAtom, [...globalStore.get(model.pendingLaunchesAtom), pending]);
    }
    globalStore.set(model.focusIdAtom, tabId);
    globalStore.set(model.surfaceAtom, "agent");
    return tabId;
}
