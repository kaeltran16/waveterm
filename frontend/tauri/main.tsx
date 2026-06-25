import { invoke } from "@tauri-apps/api/core";
import { createRoot } from "react-dom/client";
import "./tailwind.css";
import { bootWaveCore } from "@/app/boot/boot-core";
import { CockpitRoot } from "@/app/cockpit/cockpit-root";
import { hlog, installTauriApi, type InitData } from "./api";
import { installChromeListeners } from "./chrome";
import { resolveBootIds } from "./bootids";

window.addEventListener("error", (e) => hlog("WINDOW ERROR: " + (e.error?.stack ?? e.message)));
window.addEventListener("unhandledrejection", (e) => hlog("UNHANDLED REJECTION: " + (e.reason?.stack ?? String(e.reason))));

async function boot() {
    try {
        const init = await invoke<InitData>("get_init");
        installTauriApi(init);
        installChromeListeners();
        hlog("init: ws=" + init.wsEndpoint + " web=" + init.webEndpoint + " version=" + init.version);

        const ids = await resolveBootIds();
        hlog("bootIds: " + JSON.stringify(ids));

        await bootWaveCore({
            tabId: ids.tabId,
            clientId: ids.clientId,
            windowId: ids.windowId,
            activate: true,
        } as WaveInitOpts);

        createRoot(document.getElementById("main")).render(<CockpitRoot />);
        hlog("cockpit rendered");
    } catch (e: any) {
        hlog("BOOT ERROR: " + (e?.stack ?? e?.message ?? String(e)));
        const el = document.getElementById("main") ?? document.body;
        el.innerHTML = "<pre style='color:#f88;padding:20px'>BOOT ERROR: " + String(e) + "</pre>";
    }
}

boot();
