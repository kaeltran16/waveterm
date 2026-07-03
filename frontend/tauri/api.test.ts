import { afterEach, describe, expect, it, vi } from "vitest";

// rest-param signatures so the mock accepts spread args (`invokeMock(...a)`) and a 2-arg listen impl
const invokeMock = vi.fn((..._a: any[]) => Promise.resolve());
const listenMock = vi.fn((..._a: any[]) => Promise.resolve(() => {}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: any[]) => invokeMock(...a) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: (...a: any[]) => listenMock(...a) }));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ setZoom: () => Promise.resolve() }) }));
vi.mock("@tauri-apps/api/window", () => ({
    getCurrentWindow: () => ({ setFullscreen: () => Promise.resolve(), isFullscreen: () => Promise.resolve(false) }),
}));

import { installTauriApi, type InitData } from "./api";

// the bridge attaches to window.api; provide a bare window in the node test env. jsdom is not
// needed (and not installed) because the bridge touches no real DOM API beyond window.api.
(globalThis as any).window = globalThis;

const INIT: InitData = {
    wsEndpoint: "127.0.0.1:1111",
    webEndpoint: "127.0.0.1:2222",
    authKey: "key-abc",
    version: "0.1.0",
    buildTime: 1,
    platform: "win32",
    isDev: true,
    userName: "kael",
    hostName: "devbox",
};

afterEach(() => {
    invokeMock.mockReset();
    invokeMock.mockImplementation(() => Promise.resolve());
    listenMock.mockClear();
    delete (window as any).api;
});

describe("sync getters read the boot-prefetch cache", () => {
    it("getEnv returns the prefetched endpoints, null otherwise", () => {
        installTauriApi(INIT);
        const api = (window as any).api;
        expect(api.getEnv("WAVE_SERVER_WS_ENDPOINT")).toBe("127.0.0.1:1111");
        expect(api.getEnv("WAVE_SERVER_WEB_ENDPOINT")).toBe("127.0.0.1:2222");
        expect(api.getEnv("OTHER")).toBeNull();
    });
    it("identity getters return synchronously", () => {
        installTauriApi(INIT);
        const api = (window as any).api;
        expect(api.getAuthKey()).toBe("key-abc");
        expect(api.getPlatform()).toBe("win32");
        expect(api.getIsDev()).toBe(true);
        expect(api.getUserName()).toBe("kael");
        expect(api.getHostName()).toBe("devbox");
    });
});

describe("invoke-backed methods", () => {
    it("openExternal invokes open_external with the url", () => {
        installTauriApi(INIT);
        (window as any).api.openExternal("https://waveterm.dev");
        expect(invokeMock).toHaveBeenCalledWith("open_external", { url: "https://waveterm.dev" });
    });
    it("openExternal ignores a non-string url", () => {
        installTauriApi(INIT);
        (window as any).api.openExternal(null as any);
        expect(invokeMock).not.toHaveBeenCalled();
    });
    it("setWindowInitStatus invokes with the status", () => {
        installTauriApi(INIT);
        (window as any).api.setWindowInitStatus("ready");
        expect(invokeMock).toHaveBeenCalledWith("set_window_init_status", { status: "ready" });
    });
    it("sendLog routes through fe_log", () => {
        installTauriApi(INIT);
        (window as any).api.sendLog("hello");
        expect(invokeMock).toHaveBeenCalledWith("fe_log", { msg: "hello" });
    });
});

describe("onWaveInit", () => {
    it("registers a wave-init listener and forwards the payload", () => {
        let captured: any = null;
        // optional params (0 required) so this impl is assignable to the variadic listenMock type
        listenMock.mockImplementationOnce((_evt?: string, cb?: (e: any) => void) => {
            cb?.({ payload: { tabId: "t1" } });
            return Promise.resolve(() => {});
        });
        installTauriApi(INIT);
        (window as any).api.onWaveInit((opts: any) => {
            captured = opts;
        });
        expect(listenMock).toHaveBeenCalledWith("wave-init", expect.any(Function));
        expect(captured).toEqual({ tabId: "t1" });
    });
});

describe("stubs fill the rest of ElectronApi with benign defaults", () => {
    it("void/event stubs are no-ops that do not throw", () => {
        installTauriApi(INIT);
        const api = (window as any).api;
        expect(api.createTab()).toBeUndefined();
        expect(api.onContextMenuClick(() => {})).toBeUndefined();
    });
    it("typed sync getters return benign defaults", () => {
        installTauriApi(INIT);
        const api = (window as any).api;
        expect(api.getCursorPoint()).toEqual({ x: 0, y: 0 });
    });
    it("invoke-returning stubs resolve to benign values", async () => {
        installTauriApi(INIT);
        const api = (window as any).api;
        await expect(api.closeTab("w", "t", false)).resolves.toBe(false);
        await expect(api.saveTextFile("a", "b")).resolves.toBe(false);
        await expect(api.clearWebviewStorage(1)).resolves.toBeUndefined();
    });
});

describe("phase-2 chrome methods", () => {
    it("getAboutModalDetails returns version+buildTime from the boot cache", () => {
        installTauriApi(INIT);
        expect((window as any).api.getAboutModalDetails()).toEqual({ version: "0.1.0", buildTime: 1 });
    });
    it("getZoomFactor delegates to the chrome controller (starts at 1)", () => {
        installTauriApi(INIT);
        expect((window as any).api.getZoomFactor()).toBe(1);
    });
    it("setKeyboardChordMode is a no-op that does not warn or throw", () => {
        installTauriApi(INIT);
        expect((window as any).api.setKeyboardChordMode()).toBeUndefined();
    });
    it("onFullScreenChange / onZoomFactorChange / onControlShiftStateUpdate register without throwing", () => {
        installTauriApi(INIT);
        const api = (window as any).api;
        expect(api.onFullScreenChange(() => {})).toBeUndefined();
        expect(api.onZoomFactorChange(() => {})).toBeUndefined();
        expect(api.onControlShiftStateUpdate(() => {})).toBeUndefined();
    });
    it("showContextMenu / onContextMenuClick remain benign stubs (cut, not ported)", () => {
        installTauriApi(INIT);
        const api = (window as any).api;
        expect(api.showContextMenu("ws", [])).toBeUndefined();
        expect(api.onContextMenuClick(() => {})).toBeUndefined();
    });
});
