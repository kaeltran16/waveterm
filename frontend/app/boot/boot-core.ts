// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Shell-agnostic boot: connect wshrpc on the real tab route, init global model/atoms, pin the
// client/window/tab/workspace objects, load config. Extracted from wave.ts initWave so both the
// Electron entry (renders App) and the Tauri cockpit entry (renders CockpitRoot) share it.
import { loadBadges } from "@/app/store/badge";
import { GlobalModel } from "@/app/store/global-model";
import { registerControlShiftStateUpdateHandler } from "@/app/store/keymodel";
import { RpcApi } from "@/app/store/wshclientapi";
import { makeTabRouteId } from "@/app/store/wshrouter";
import { initWshrpc, TabRpcClient } from "@/app/store/wshrpcutil";
import {
    atoms,
    getApi,
    globalStore,
    initGlobal,
    initGlobalWaveEventSubs,
    loadConnStatus,
    subscribeToConnEvents,
} from "@/store/global";
import { activeTabIdAtom } from "@/store/tab-model";
import * as WOS from "@/store/wos";
import { isMacOS, setMacOSVersion } from "@/util/platformutil";

export async function bootWaveCore(initOpts: WaveInitOpts): Promise<void> {
    const platform = getApi().getPlatform();
    getApi().sendLog("Boot Wave Core " + JSON.stringify(initOpts));
    const globalInitOpts: GlobalInitOptions = {
        tabId: initOpts.tabId,
        clientId: initOpts.clientId,
        windowId: initOpts.windowId,
        platform,
        environment: "renderer",
        primaryTabStartup: initOpts.primaryTabStartup,
    };
    globalStore.set(activeTabIdAtom, initOpts.tabId);
    await GlobalModel.getInstance().initialize(globalInitOpts);
    initGlobal(globalInitOpts);
    (window as any).globalAtoms = atoms;

    const authKey = getApi().getAuthKey();
    const globalWS = initWshrpc(makeTabRouteId(initOpts.tabId), authKey ? { authKey } : undefined);
    (window as any).globalWS = globalWS;
    (window as any).TabRpcClient = TabRpcClient;

    try {
        await loadConnStatus();
        await loadBadges();
        initGlobalWaveEventSubs(initOpts);
        subscribeToConnEvents();
        if (isMacOS()) {
            const macOSVersion = await RpcApi.MacOSVersionCommand(TabRpcClient);
            setMacOSVersion(macOSVersion);
        }
        const [_client, waveWindow, initialTab] = await Promise.all([
            WOS.loadAndPinWaveObject<Client>(WOS.makeORef("client", initOpts.clientId)),
            WOS.loadAndPinWaveObject<WaveWindow>(WOS.makeORef("window", initOpts.windowId)),
            WOS.loadAndPinWaveObject<Tab>(WOS.makeORef("tab", initOpts.tabId)),
        ]);
        const [ws, _layoutState] = await Promise.all([
            WOS.loadAndPinWaveObject<Workspace>(WOS.makeORef("workspace", waveWindow.workspaceid)),
            WOS.reloadWaveObject<LayoutState>(WOS.makeORef("layout", initialTab.layoutstate)),
        ]);
        ws?.tabids?.forEach((tabid) => WOS.getObjectValue<Tab>(WOS.makeORef("tab", tabid)));
        WOS.wpsSubscribeToObject(WOS.makeORef("workspace", waveWindow.workspaceid));
        document.title = `Wave Terminal - ${initialTab.name}`;
    } catch (e) {
        console.error("Failed initialization error", e);
        getApi().sendLog("Error in bootWaveCore (loading required objects) " + e.message + "\n" + e.stack);
    }
    registerControlShiftStateUpdateHandler();
    const fullConfig = await RpcApi.GetFullConfigCommand(TabRpcClient);
    globalStore.set(atoms.fullConfigAtom, fullConfig);
    const waveaiModeConfig = await RpcApi.GetWaveAIModeConfigCommand(TabRpcClient);
    globalStore.set(atoms.waveaiModeConfigAtom, waveaiModeConfig.configs);
}
