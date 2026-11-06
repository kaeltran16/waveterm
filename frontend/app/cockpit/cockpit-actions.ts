// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
import { pushToast } from "@/app/cockpit/notificationstore";
import { atoms } from "@/app/store/global-atoms";
import { globalStore } from "@/app/store/jotaiStore";
import { WorkspaceService } from "@/app/store/services";
import { RpcApi } from "@/app/store/wshclientapi";
import * as WOS from "@/app/store/wos";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { AgentsViewModel } from "@/app/view/agents/agents";
import { SESSION_BRAINSTORM } from "@/app/view/agents/brainstormstore";
import { resyncController } from "@/app/view/agents/agentcontrollerstore";
import type { PendingLaunch } from "@/app/view/agents/agentsviewmodel";
import { resolveCwd } from "@/app/view/agents/agentcwdresolve";
import {
    buildLaunchMeta,
    launchFocuses,
    launchLanding,
    numberedName,
    runtimeCreatesAgentPanel,
    runtimeStartupCommand,
    type Runtime,
} from "@/app/view/agents/launch";
import { projectsAtom } from "@/app/view/agents/projectsstore";
import { sessionSidebarViewModelAtom } from "@/app/view/agents/session-models/sessionsidebarmodel";
import { flattenVisualOrder } from "@/app/view/agents/session-models/sessionviewmodel";

export interface LaunchAgentOpts {
    runtime: Runtime;
    startupCommand: string;
    startupArgs?: string[]; // exact argv (pi resume path); forwarded verbatim when present
    task: string;
    projectPath: string;
    projectName: string; // labels the roster row + carries project scope
    branch?: string;
    resumePath?: string; // pi transcript path; preflighted before any worktree/tab is created
    label?: string; // the session's name in the roster (session:label), e.g. the initiative it works on
    effortORef?: string; // the initiative it works on (session:effort), "effort:<oid>"
    // the brainstorm.json it carries on (session:brainstorm): attached up front, since the agent's hook reveals the pane
    // only when its write creates the file, and a resumed brainstorm's file already exists
    brainstormFile?: string;
}

// Launch a runtime as its OWN session tab. Agent runtimes get a pending roster row; terminals only
// open in the Agent surface focus pane. We do NOT setActiveTab. The new tab's default term block is
// reconfigured via SetMeta first, so meta is honored at controller start. An agent's process is started
// here with a resync (the backend otherwise starts controllers lazily on the first terminal-view
// resync), so it runs without its terminal mounted and a launch from the Cockpit can stay there; it
// starts at the block's stored size and the terminal resizes it when first opened. A start error throws.
export async function launchAgent(model: AgentsViewModel, opts: LaunchAgentOpts): Promise<string> {
    // Pi --session creates a session when the path is missing; a stale archived entry must never reach
    // that behavior, so a resumePath that no longer exists on disk aborts before anything is created.
    // FileInfo reports a missing path as notfound rather than throwing; a throw still counts as missing.
    if (opts.resumePath) {
        let missing: boolean;
        try {
            missing = !!(await RpcApi.FileInfoCommand(TabRpcClient, { info: { path: opts.resumePath } }))?.notfound;
        } catch {
            missing = true;
        }
        if (missing) {
            throw new Error(`Pi session no longer exists: ${opts.resumePath}`);
        }
    }
    const isTerminal = opts.runtime === "terminal";
    // the shell falls back to the home dir for a missing cmd:cwd, where a resume cannot find its session
    if (!isTerminal && opts.projectPath) {
        const info = await RpcApi.FileInfoCommand(TabRpcClient, { info: { path: opts.projectPath } });
        if (info?.notfound) {
            throw new Error(`Working directory no longer exists: ${opts.projectPath}`);
        }
    }
    let cwd = opts.projectPath;
    if (!isTerminal && opts.branch?.trim()) {
        const rtn = await RpcApi.CreateWorktreeCommand(TabRpcClient, {
            projectpath: opts.projectPath,
            branch: opts.branch.trim(),
        });
        cwd = rtn.worktreepath;
    }
    // A terminal needs a cmd:cwd so the session sidebar detects it as a term session (buildLaunchMeta
    // only sets cmd:cwd when cwd is truthy); "~" falls back to the home dir on the backend.
    if (isTerminal && !cwd) {
        cwd = "~";
    }
    const ws = globalStore.get(atoms.workspace);
    if (ws?.oid == null) {
        throw new Error("no active workspace");
    }
    const tabId = await WorkspaceService.CreateTab(ws.oid, opts.projectName, false);
    let blockId: string;
    try {
        blockId = await configureLaunchTab(tabId, opts, cwd);
    } catch (e) {
        await closeFailedLaunchTab(ws.oid, tabId);
        throw e;
    }
    const agentPanel = runtimeCreatesAgentPanel(opts.runtime);
    if (!isTerminal) {
        // the shared start path, so a refusal reads "failed to start" on the Agent and Sessions surfaces too
        await resyncController({ tabid: tabId, blockid: blockId });
    }
    if (agentPanel) {
        // named as the roster will name its row, so the name does not jump when that row replaces it
        const taken = flattenVisualOrder(globalStore.get(sessionSidebarViewModelAtom))
            .filter((r) => r.projectNamed && r.tabId !== tabId)
            .map((r) => r.label);
        const pending: PendingLaunch = {
            tabId,
            blockId,
            name: opts.label || numberedName(opts.projectName, taken),
            project: opts.projectName,
            ts: Date.now(),
            runtime: opts.runtime,
        };
        globalStore.set(model.pendingLaunchesAtom, [...globalStore.get(model.pendingLaunchesAtom), pending]);
    }
    // An agent is focused; from anywhere but the Cockpit it also lands on the Agent surface. A terminal
    // is focused only on the Agent surface, where its pane shows and starts it; from anywhere else it
    // stays in the background under the Agent tree's "Terminals" group and starts when first opened.
    const surface = globalStore.get(model.surfaceAtom);
    if (launchFocuses(opts.runtime, surface)) {
        globalStore.set(model.focusIdAtom, tabId);
        const landing = launchLanding(surface);
        if (landing) {
            globalStore.set(model.surfaceAtom, landing);
        }
    }
    return tabId;
}

// configureLaunchTab turns the new tab's default block into the launch and tags the tab; returns the block id.
async function configureLaunchTab(tabId: string, opts: LaunchAgentOpts, cwd: string): Promise<string> {
    const tab = globalStore.get(WOS.getWaveObjectAtom<Tab>(WOS.makeORef("tab", tabId)));
    const blockId = tab?.blockids?.[0];
    if (blockId == null) {
        throw new Error("new tab has no block");
    }
    const blockORef = WOS.makeORef("block", blockId);
    await RpcApi.SetMetaCommand(TabRpcClient, {
        oref: blockORef,
        meta: buildLaunchMeta({
            runtime: opts.runtime,
            startupCommand: opts.startupCommand,
            startupArgs: opts.startupArgs,
            task: opts.task,
            cwd,
        }),
    });
    // Refresh the frontend's cached block object. getWaveObjectAtom does a one-time fetch and does
    // NOT subscribe, so the session sidebar's read of this block stays pinned to the pre-SetMeta
    // shell meta — leaving it without cmd:cwd, so the tab never enters the agent roster (the agent
    // renders as a bare terminal and the cockpit panel stays empty). Reload so the roster sees cmd.
    await WOS.reloadWaveObject(blockORef);
    // steering and skills are launch-time, for every runtime: a harness must never start against
    // a stale region. fire-and-forget — a sync failure must not block the launch, but it must be seen.
    void RpcApi.AgentSyncApplyCommand(TabRpcClient, { dryrun: false }).catch((e) =>
        pushToast({
            level: "warn",
            title: "Instructions not synced",
            message: `Harness sync failed: ${e instanceof Error ? e.message : String(e)}. Setup → Instructions has Sync now.`,
        })
    );
    const agentPanel = runtimeCreatesAgentPanel(opts.runtime);
    const tabMeta: MetaType = agentPanel
        ? { "session:agent": opts.runtime, "session:project": opts.projectName }
        : { "session:project": opts.projectName };
    if (opts.label) {
        tabMeta["session:label"] = opts.label;
    }
    if (opts.effortORef) {
        tabMeta["session:effort"] = opts.effortORef;
    }
    if (opts.brainstormFile) {
        tabMeta[SESSION_BRAINSTORM] = opts.brainstormFile;
    }
    await RpcApi.SetMetaCommand(TabRpcClient, { oref: WOS.makeORef("tab", tabId), meta: tabMeta });
    return blockId;
}

// a launch that failed before its process started leaves nothing in its tab worth keeping. A failed start keeps
// its tab, where the block's start error shows.
async function closeFailedLaunchTab(workspaceId: string, tabId: string): Promise<void> {
    try {
        await WorkspaceService.CloseTab(workspaceId, tabId);
    } catch (e) {
        console.error(`closing tab ${tabId} of a failed launch:`, e);
    }
}

// launchAgentOrToast is launchAgent for a click that has nowhere else to say why it failed
export async function launchAgentOrToast(model: AgentsViewModel, opts: LaunchAgentOpts): Promise<string | null> {
    try {
        return await launchAgent(model, opts);
    } catch (e) {
        console.error(`launch ${opts.runtime} in ${opts.projectName} (${opts.projectPath}) failed:`, e);
        pushToast({
            level: "error",
            title: "Couldn't start the agent",
            message: e instanceof Error ? e.message : String(e),
        });
        return null;
    }
}

// Attach = resume a detached background agent inside a fresh Wave terminal block. `claude --resume
// <sessionId>` is the primitive (there is no `claude attach`); task is empty so resume reattaches
// without replaying a prompt. Once it boots, the hook reporter registers it and the session-id dedup
// collapses the background-lane entry into the now-live agent.
export async function attachBackgroundAgent(
    model: AgentsViewModel,
    bg: { sessionId: string; cwd: string; project: string }
): Promise<void> {
    await launchAgent(model, {
        runtime: "claude",
        startupCommand: `claude --resume ${bg.sessionId}`,
        task: "",
        projectPath: bg.cwd,
        projectName: bg.project || "background",
    });
}

// launchPiTab launches a Pi tab at the focused agent's cwd (fallback: first registered project),
// mirroring the new-agent modal's launch shape. No resolvable cwd -> open the modal instead.
export async function launchPiTab(model: AgentsViewModel): Promise<void> {
    const focused = globalStore.get(model.agentsAtom).find((a) => a.id === globalStore.get(model.focusIdAtom)) ?? null;
    let cwd: string | null = null;
    if (focused?.transcriptPath) {
        cwd = await resolveCwd(focused.transcriptPath, focused.blockId);
    }
    if (!cwd) {
        const projects = globalStore.get(projectsAtom);
        cwd = Object.values(projects).find((p) => p.path)?.path ?? null;
    }
    if (!cwd) {
        globalStore.set(model.newAgentOpenAtom, true);
        return;
    }
    const projectName = cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd;
    await launchAgent(model, {
        runtime: "pi",
        startupCommand: runtimeStartupCommand("pi"),
        task: "",
        projectPath: cwd,
        projectName,
    });
}
