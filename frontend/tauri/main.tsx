import { invoke } from "@tauri-apps/api/core";
import { createRoot } from "react-dom/client";
import { hlog, installTauriApi, type InitData } from "./api";

function waitForOpen(getOpen: () => boolean, timeoutMs: number): Promise<boolean> {
    return new Promise((res) => {
        const start = performance.now();
        const id = setInterval(() => {
            if (getOpen()) {
                clearInterval(id);
                res(true);
            } else if (performance.now() - start > timeoutMs) {
                clearInterval(id);
                res(false);
            }
        }, 100);
    });
}

async function boot() {
    try {
        const init = await invoke<InitData>("get_init");
        installTauriApi(init);
        hlog("init: ws=" + init.wsEndpoint + " version=" + init.version);

        // Global-free RPC: a base WshClient wired via initElectronWshrpc (router + WPS + authKey),
        // imported from wshrpcutil-BASE (wshrpcutil itself imports TabClient -> @/store/global).
        const { initElectronWshrpc } = await import("@/app/store/wshrpcutil-base");
        const { WshClient } = await import("@/app/store/wshclient");
        const { getFileSubject, waveEventSubscribeSingle } = await import("@/app/store/wps");
        const { RpcApi } = await import("@/app/store/wshclientapi");
        const wsmod = await import("@/app/store/ws");

        const client = new WshClient("tab:spike-harness");
        initElectronWshrpc(client, { authKey: init.authKey });

        const opened = await waitForOpen(() => wsmod.globalWS?.open, 8000);
        hlog("ws open=" + opened);
        if (!opened) throw new Error("ws did not open within 8s");

        // route "blockfile" wps events into the file subjects (mirrors global.ts:84-93).
        waveEventSubscribeSingle({
            eventType: "blockfile",
            handler: (event: any) => {
                const sub = getFileSubject(event.data.zoneid, event.data.filename);
                sub?.next(event.data);
            },
        } as any);

        const wsList = await RpcApi.WorkspaceListCommand(client);
        const tabId = wsList?.[0]?.workspacedata?.activetabid;
        hlog("workspaces=" + (wsList?.length ?? 0) + " tabId=" + tabId);
        if (!tabId) throw new Error("no tabid from WorkspaceList");

        const { TerminalHarness } = await import("./terminal-harness");
        createRoot(document.getElementById("root")).render(<TerminalHarness client={client} tabId={tabId} />);
    } catch (e: any) {
        hlog("BOOT ERROR: " + (e?.stack ?? e?.message ?? String(e)));
        const el = document.getElementById("root");
        if (el) el.innerHTML = "<pre style='color:#f88;padding:20px'>BOOT ERROR: " + String(e) + "</pre>";
    }
}

boot();
