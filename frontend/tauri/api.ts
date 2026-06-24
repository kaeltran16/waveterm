import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

// mirrors the Rust InitData (serde camelCase): the single boot prefetch that feeds every
// synchronous getter, so they can satisfy ElectronApi's sync signatures without awaiting.
export type InitData = {
    wsEndpoint: string;
    webEndpoint: string;
    authKey: string;
    version: string;
    buildTime: number;
    platform: string;
    isDev: boolean;
    userName: string;
    hostName: string;
};

const noop = () => {};

// the WebView2 console isn't observable from the dev loop; route logs to the Rust console.
export function hlog(msg: string) {
    invoke("fe_log", { msg }).catch(noop);
}

const warnedStubs = new Set<string>();
function stubWarn(name: string) {
    if (warnedStubs.has(name)) return;
    warnedStubs.add(name);
    console.warn(`[tauri-bridge] stub called: ${name} (not implemented in Phase 1)`);
}

export function installTauriApi(init: InitData) {
    const api: Partial<ElectronApi> = {
        // --- boot ---
        getEnv: (varName: string) => {
            if (varName === "WAVE_SERVER_WS_ENDPOINT") return init.wsEndpoint;
            if (varName === "WAVE_SERVER_WEB_ENDPOINT") return init.webEndpoint;
            return null;
        },
        getAuthKey: () => init.authKey,
        onWaveInit: (callback: (initOpts: WaveInitOpts) => void) => {
            listen<WaveInitOpts>("wave-init", (e) => callback(e.payload)).catch((err) =>
                hlog("onWaveInit listen failed: " + err)
            );
        },
        setWindowInitStatus: (status: "ready" | "wave-ready") => {
            invoke("set_window_init_status", { status }).catch(noop);
        },

        // --- env / identity ---
        getPlatform: () => init.platform as NodeJS.Platform,
        getIsDev: () => init.isDev,
        getUserName: () => init.userName,
        getHostName: () => init.hostName,
        sendLog: (log: string) => hlog(log),
        setIsActive: () => invoke("set_is_active").catch(noop) as Promise<void>,

        // --- terminal basics (day-one) ---
        openExternal: (url: string) => {
            if (url && typeof url === "string") {
                invoke("open_external", { url }).catch(noop);
            } else {
                console.error("Invalid URL passed to openExternal:", url);
            }
        },
        incrementTermCommands: () => {
            invoke("increment_term_commands").catch(noop);
        },
    };

    installStubs(api);
    (window as any).api = api;
}

// Everything outside the day-one set: typed benign-default stubs (not throws), so the bridge
// implements the full ElectronApi type and an incidental call cannot crash. Deleted with the
// cut subsystems in Phase 5; the deferred ones get real impls in Phase 2/3.
function installStubs(api: Partial<ElectronApi>) {
    const voidStubs = [
        "showWorkspaceAppMenu", "showBuilderAppMenu", "showContextMenu", "onContextMenuClick",
        "downloadFile", "onFullScreenChange", "onZoomFactorChange", "onUpdaterStatusChange",
        "installAppUpdate", "onMenuItemAbout", "updateWindowControlsOverlay", "onReinjectKey",
        "setWebviewFocus", "registerGlobalWebviewKeys", "onControlShiftStateUpdate",
        "createWorkspace", "switchWorkspace", "deleteWorkspace", "setActiveTab", "createTab",
        "onBuilderInit", "onQuicklook", "openNativePath", "setKeyboardChordMode",
        "setWaveAIOpen", "closeBuilderWindow", "nativePaste", "openBuilder",
        "setBuilderWindowAppId", "doRefresh", "onNavigate", "onIframeNavigate",
    ];
    for (const name of voidStubs) {
        if ((api as any)[name]) continue;
        (api as any)[name] = (..._a: any[]) => stubWarn(name);
    }

    // typed sync getters → benign defaults
    api.getCursorPoint = () => { stubWarn("getCursorPoint"); return { x: 0, y: 0 } as any; };
    api.getDataDir = () => { stubWarn("getDataDir"); return ""; };
    api.getConfigDir = () => { stubWarn("getConfigDir"); return ""; };
    api.getHomeDir = () => { stubWarn("getHomeDir"); return ""; };
    api.getWebviewPreload = () => { stubWarn("getWebviewPreload"); return ""; };
    api.getAboutModalDetails = () => { stubWarn("getAboutModalDetails"); return {} as any; };
    api.getZoomFactor = () => { stubWarn("getZoomFactor"); return 1; };
    api.getUpdaterStatus = () => { stubWarn("getUpdaterStatus"); return "unavailable" as any; };
    api.getUpdaterChannel = () => { stubWarn("getUpdaterChannel"); return ""; };

    // invoke/Promise methods → resolved benign defaults
    api.closeTab = (..._a: any[]) => { stubWarn("closeTab"); return Promise.resolve(false); };
    api.captureScreenshot = (..._a: any[]) => { stubWarn("captureScreenshot"); return Promise.resolve(""); };
    api.clearWebviewStorage = (..._a: any[]) => { stubWarn("clearWebviewStorage"); return Promise.resolve(); };
    api.saveTextFile = (..._a: any[]) => { stubWarn("saveTextFile"); return Promise.resolve(false); };
    api.getPathForFile = (..._a: any[]) => { stubWarn("getPathForFile"); return ""; };
}
