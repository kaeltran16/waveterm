// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

const previewElectronApi: ElectronApi = {
    getAuthKey: () => "",
    getIsDev: () => false,
    getPlatform: () => "darwin",
    getEnv: (_varName: string) => "",
    getUserName: () => "",
    getHostName: () => "",
    getZoomFactor: () => 1.0,
    openExternal: (_url: string) => {},
    onFullScreenChange: (_callback: (isFullScreen: boolean) => void) => {},
    onZoomFactorChange: (_callback: (zoomFactor: number) => void) => {},
    onControlShiftStateUpdate: (_callback: (state: boolean) => void) => {},
    setWindowInitStatus: (_status: "ready" | "wave-ready") => {},
    onWaveInit: (_callback: (initOpts: WaveInitOpts) => void) => {},
    sendLog: (_log: string) => {},
    nativePaste: () => {},
    getPathForFile: (_file: File) => "",
    saveTextFile: (_fileName: string, _content: string) => Promise.resolve(false),
    setIsActive: async () => {},
};

function installPreviewElectronApi() {
    (window as any).api = previewElectronApi;
}

export { installPreviewElectronApi, previewElectronApi };
