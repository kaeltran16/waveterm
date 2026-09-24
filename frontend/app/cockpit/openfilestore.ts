// frontend/app/cockpit/openfilestore.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Routes wsh open/view/edit into the Code surface. The CLI publishes an "openfile" wave event
// (there is no block-layout renderer in this build, so creating preview blocks would be a
// silent no-op); this store turns the path into a project/file selection and navs to Code.

import { globalStore } from "@/app/store/jotaiStore";
import { waveEventSubscribeSingle } from "@/app/store/wps";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import type { AgentsViewModel } from "@/app/view/agents/agents";
import { projectsAtom } from "@/app/view/agents/projectsstore";
import {
    codeProjectAtom,
    codeViewModeAtom,
    openPath,
    registeredProjects,
    selectProject,
} from "@/app/view/code/codestore";
import { normalizeRepoPath, sameRepoPath } from "@/util/paths";
import { routeOpenFile } from "./openfileroute";

export async function openFileInCode(model: AgentsViewModel, path: string, edit = false): Promise<void> {
    const info = await RpcApi.FileInfoCommand(TabRpcClient, { info: { path } });
    // FileInfo marks directories by returning Dir equal to Path (separator-normalized)
    const isDir =
        info != null && !info.notfound && normalizeRepoPath(info.dir ?? "") === normalizeRepoPath(info.path ?? "");
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
    globalStore.set(model.surfaceAtom, "code");
}

let subscribed = false;
export function setupOpenFileSubscription(model: AgentsViewModel): void {
    if (subscribed) return;
    subscribed = true;
    waveEventSubscribeSingle({
        eventType: "openfile",
        handler: (event) => {
            const data = event.data as { path?: string; edit?: boolean };
            if (!data?.path) return;
            openFileInCode(model, data.path, data.edit === true).catch((e) =>
                console.error("openfile handler failed", e)
            );
        },
    });
}
