// Shared CDP transport for the verification harness. Extracted from the duplicated pickTarget +
// websocket wrappers in cdp-shot.mjs / cdp-e2e-runs.mjs / cdp-goto-channels.mjs. Requires the dev
// app running with the debug flag (dev-only in src-tauri/src/main.rs): --remote-debugging-port=9222.
// Node 21+ (global WebSocket + fetch; the repo runs Node 24).
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";

// SurfaceKey -> nav-rail label, mirrored from frontend/app/view/agents/navrail.tsx ITEMS. goto clicks
// the nav button by label because globalStore/the agents model are NOT exposed on window (boot-core
// exposes only globalAtoms/globalWS/TabRpcClient) — the nav click is the proven, app-change-free way
// to switch surfaces (see cdp-goto-channels.mjs). Note: the "files" surface is labelled "Diff".
export const SURFACE_LABEL = {
    cockpit: "Cockpit",
    agent: "Agent",
    channels: "Channels",
    radar: "Radar",
    sessions: "Sessions",
    files: "Diff",
    memory: "Memory",
    usage: "Usage",
    settings: "Settings",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connect(wsUrl) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(wsUrl);
        let id = 0;
        const pending = new Map();
        ws.addEventListener("open", () =>
            resolve({
                send: (method, params = {}) => {
                    const msgId = ++id;
                    ws.send(JSON.stringify({ id: msgId, method, params }));
                    return new Promise((res) => pending.set(msgId, res));
                },
                close: () => ws.close(),
            })
        );
        ws.addEventListener("error", reject);
        ws.addEventListener("message", (e) => {
            const msg = JSON.parse(e.data);
            if (msg.id && pending.has(msg.id)) {
                pending.get(msg.id)(msg.result);
                pending.delete(msg.id);
            }
        });
    });
}

async function pickTarget(port) {
    const res = await fetch(`http://localhost:${port}/json/list`);
    const targets = await res.json();
    return (
        targets.find((t) => t.type === "page" && /localhost:5174|wave|arc/i.test(t.url ?? "")) ??
        targets.find((t) => t.type === "page")
    );
}

export async function attach(port = 9222) {
    const target = await pickTarget(port);
    if (!target) {
        throw new Error(
            `no page target on :${port} — is the dev app running with the debug flag? ` +
                `(task dev; the flag is dev-only in src-tauri/src/main.rs)`
        );
    }
    const client = await connect(target.webSocketDebuggerUrl);
    await client.send("Runtime.enable");
    await client.send("Page.enable");

    async function ev(expr) {
        const x = await client.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
        if (x.exceptionDetails) {
            throw new Error(x.exceptionDetails.exception?.description || x.exceptionDetails.text);
        }
        return x.result?.value;
    }

    const shots = [];

    return {
        url: target.url,
        shots,
        ev,
        rpc: (command, data) =>
            ev(`window.TabRpcClient.wshRpcCall(${JSON.stringify(command)}, ${JSON.stringify(data ?? null)}, {})`),
        async goto(surface) {
            const label = SURFACE_LABEL[surface];
            if (!label) throw new Error(`unknown surface "${surface}"`);
            const clicked = await ev(`(() => {
                const b = [...document.querySelectorAll('nav button')]
                    .find((x) => (x.textContent || '').trim() === ${JSON.stringify(label)});
                if (!b) return false;
                b.click();
                return true;
            })()`);
            if (!clicked) throw new Error(`nav button "${label}" not found for surface "${surface}"`);
            await sleep(800); // settle before asserting/screenshotting (matches cdp-goto-channels.mjs)
        },
        activeSurfaceLabel: () =>
            ev(`(() => {
                const b = [...document.querySelectorAll('nav button')]
                    .find((x) => (x.className || '').includes('text-accent-soft'));
                return b ? (b.textContent || '').trim() : null;
            })()`),
        async shot(outPath) {
            const { data } = await client.send("Page.captureScreenshot", { format: "png" });
            mkdirSync(dirname(outPath), { recursive: true });
            writeFileSync(outPath, Buffer.from(data, "base64"));
            const png = basename(outPath);
            shots.push({ name: png.replace(/\.png$/, ""), png });
        },
        close: () => client.close(),
    };
}
