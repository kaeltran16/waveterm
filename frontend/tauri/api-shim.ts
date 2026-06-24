// Minimal getApi() shim for the connect+shellproc path only (Phase 0).
// Expand ONLY when a runtime "getApi().X is not a function" error proves X is reached.
import { invoke } from "@tauri-apps/api/core";

// route harness logs to the Rust console (the WebView2 console isn't observable in the dev loop).
export function hlog(msg: string) {
    invoke("harness_log", { msg }).catch(() => {});
}

export function installApiShim() {
    (window as any).api = {
        getEnv: (_k: string) => null, // endpoints come from get_init, not env, in the harness
        getPlatform: () => "win32",
        getIsDev: () => true,
        sendLog: (msg: string) => hlog("[wsh-log] " + msg),
        getAuthKey: () => (window as any).__waveAuthKey ?? "",
    };
}
