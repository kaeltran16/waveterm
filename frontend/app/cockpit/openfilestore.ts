// frontend/app/cockpit/openfilestore.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Routes wsh open/view/edit into the calling agent's workspace pane when it shows Rendered, else the Code surface.
// The CLI publishes an "openfile" wave event (there is no block-layout renderer in this build, so creating preview
// blocks would be a silent no-op); this store turns the path into a workspace tab or a project/file selection.

import { globalStore } from "@/app/store/jotaiStore";
import { waveEventSubscribeSingle } from "@/app/store/wps";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import type { AgentsViewModel } from "@/app/view/agents/agents";
import { projectsAtom } from "@/app/view/agents/projectsstore";
import { besideTabFor } from "@/app/view/agents/workspacedocsstore";
import { pushWorkspaceTab, rendersNow } from "@/app/view/agents/workspacestore";
import {
    codeProjectAtom,
    codeViewModeAtom,
    openPath,
    registeredProjects,
    selectProject,
} from "@/app/view/code/codestore";
import { landOn } from "@/app/view/jarvis/returnsurface";
import { normalizeRepoPath, sameRepoPath } from "@/util/paths";
import { openFileDestination, routeOpenFile } from "./openfileroute";

async function pathIsDir(path: string): Promise<boolean> {
    const info = await RpcApi.FileInfoCommand(TabRpcClient, { info: { path } });
    // FileInfo marks directories by returning Dir equal to Path (separator-normalized)
    return info != null && !info.notfound && normalizeRepoPath(info.dir ?? "") === normalizeRepoPath(info.path ?? "");
}

export async function openFileInCode(
    model: AgentsViewModel,
    path: string,
    edit = false,
    knownDir?: boolean
): Promise<void> {
    const isDir = knownDir ?? (await pathIsDir(path));
    const registered = registeredProjects(globalStore.get(projectsAtom));
    const route = routeOpenFile(path, isDir, globalStore.get(codeProjectAtom), registered);
    const curProject = globalStore.get(codeProjectAtom);
    if (!sameRepoPath(curProject?.path ?? "", route.project.path)) {
        await selectProject(route.project);
    }
    if (route.rel != null) {
        globalStore.set(codeViewModeAtom, edit ? "source" : "preview");
        await openPath(route.rel);
    }
    landOn(model.surfaceAtom, "code");
}

type OpenFileEvent = { path: string; edit?: boolean; oref?: string };

async function handleOpenFile(model: AgentsViewModel, data: OpenFileEvent): Promise<void> {
    const edit = data.edit === true;
    const isDir = await pathIsDir(data.path);
    const agents = globalStore.get(model.agentsAtom);
    const dest = openFileDestination({ oref: data.oref, edit, isDir }, agents, (id) => rendersNow(model, id));
    if (dest.to === "code") {
        return openFileInCode(model, data.path, edit, isDir);
    }
    const agent = agents.find((a) => a.id === dest.agentId);
    if (agent != null) {
        pushWorkspaceTab(agent.id, await besideTabFor(agent, { path: data.path, line: null }));
    }
}

let subscribed = false;
export function setupOpenFileSubscription(model: AgentsViewModel): void {
    if (subscribed) return;
    subscribed = true;
    waveEventSubscribeSingle({
        eventType: "openfile",
        handler: (event) => {
            const data = event.data as Partial<OpenFileEvent>;
            if (!data?.path) return;
            handleOpenFile(model, { ...data, path: data.path }).catch((e) =>
                console.error("openfile handler failed", e)
            );
        },
    });
}
