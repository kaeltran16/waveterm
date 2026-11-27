// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
import { pushToast } from "@/app/cockpit/notificationstore";
import { atoms } from "@/app/store/global-atoms";
import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { AgentsViewModel } from "@/app/view/agents/agents";
import { SESSION_BRAINSTORM } from "@/app/view/agents/brainstormstore";
import { launchAgentTab, settleLaunchStart } from "@/app/view/agents/agentcontrollerstore";
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
// open in the Agent surface focus pane. We do NOT setActiveTab. The backend opens the tab with its meta
// already set and starts an agent's process there (controllers otherwise start lazily on the first
// terminal-view resync), so it runs without its terminal mounted and a launch from the Cockpit can stay
// there; it starts at the block's stored size and the terminal resizes it when first opened. A refused
// start keeps its tab, where the block's start error shows, and throws.
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
    // steering and skills are launch-time, for every runtime: a harness must never start against
    // a stale region. fire-and-forget — a sync failure must not block the launch, but it must be seen.
    void RpcApi.AgentSyncApplyCommand(TabRpcClient, { dryrun: false }).catch((e) =>
        pushToast({
            level: "warn",
            title: "Instructions not synced",
            message: `Harness sync failed: ${e instanceof Error ? e.message : String(e)}. Setup → Instructions has Sync now.`,
        })
    );
    const launched = await launchAgentTab({
        workspaceid: ws.oid,
        tabname: opts.projectName,
        tabmeta: launchTabMeta(opts),
        blockmeta: buildLaunchMeta({
            runtime: opts.runtime,
            startupCommand: opts.startupCommand,
            startupArgs: opts.startupArgs,
            task: opts.task,
            cwd,
        }),
        start: !isTerminal,
    });
    const { tabid: tabId, blockid: blockId } = launched;
    if (!isTerminal) {
        // a refusal reads "failed to start" on the Agent and Sessions surfaces too
        settleLaunchStart(launched);
    }
    const agentPanel = runtimeCreatesAgentPanel(opts.runtime);
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

// launchTabMeta tags the launch's tab for the roster
function launchTabMeta(opts: LaunchAgentOpts): MetaType {
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
    return tabMeta;
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
