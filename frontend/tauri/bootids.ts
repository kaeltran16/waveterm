// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Frontend-resolved boot (Tauri). Electron's main process supplied these IDs via the wave-init
// IPC; here we read them from the unchanged Go services over HTTP (WOS.callBackendService is a
// fetch, not wshrpc — so no websocket is needed yet). noUIContext=true because globalAtoms.uiContext
// is not populated this early in boot. wavesrv's EnsureInitialData has already created the graph.
import { callBackendService } from "@/app/store/wos";

export type BootIds = {
    clientId: string;
    windowId: string;
    workspaceId: string;
    tabId: string;
};

export async function resolveBootIds(): Promise<BootIds> {
    const client: Client = await callBackendService("client", "GetClientData", [], true);
    let windowId = client.windowids?.[0];
    let win: WaveWindow;
    if (!windowId) {
        win = await callBackendService("window", "CreateWindow", [null, ""], true);
        windowId = win.oid;
    } else {
        win = await callBackendService("window", "GetWindow", [windowId], true);
    }
    const workspaceId = win.workspaceid;
    const ws: Workspace = await callBackendService("workspace", "GetWorkspace", [workspaceId], true);
    const tabId = ws.activetabid || ws.tabids?.[0];
    if (!tabId) {
        throw new Error("resolveBootIds: workspace has no tabs");
    }
    return { clientId: client.oid, windowId, workspaceId, tabId };
}
