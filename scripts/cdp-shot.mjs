// DEV visual-verification helper. Screenshots the running Tauri dev app's WebView2 over the
// Chrome DevTools Protocol and writes a PNG. Use it to verify rendered UI from an agent session
// (no jsdom harness exists for the cockpit; this is the Tauri-era replacement for the old
// Electron `:9222` flow).
//
//   node scripts/cdp-shot.mjs [outfile.png] [port]   # default: cdp-shots/wave-cdp.png on :9222
// Output defaults to the gitignored `cdp-shots/` dir so verification PNGs never surface in git.
//
// PREREQUISITE — the debug port must be enabled. `src-tauri/src/main.rs` sets, dev-only:
//     #[cfg(debug_assertions)] WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222
// WebView2 (Chromium/Edge, what Tauri renders with on Windows) reads that env var before creating
// the webview, exposing CDP 1.3 on :9222. It is compiled out of `cargo tauri build`, so packaged
// installs never expose it. `cargo tauri dev` watches src-tauri, so editing main.rs auto-rebuilds
// and relaunches the dev app with the flag (the window blinks once) — no manual restart.
//
// Requires Node 21+ (global WebSocket + fetch; this repo runs Node 24). The page target is the
// Vite dev server served inside WebView2 (url http://localhost:5174/, title "Wave Terminal - ...").
// `claude-in-chrome` MCP can't attach here (it needs Chrome + an extension) — raw CDP, as below.
//
// Beyond screenshots, the same attach pattern drives full CDP: `Runtime.evaluate` to read the DOM /
// jotai atoms (window.globalStore is exposed on the dev renderer), `Input.dispatchKeyEvent` for keys.

const out = process.argv[2] ?? "cdp-shots/wave-cdp.png";
const port = process.argv[3] ?? "9222";

async function pickTarget() {
    const res = await fetch(`http://localhost:${port}/json/list`);
    const targets = await res.json();
    // prefer the dev page (vite on :5174); fall back to any page target.
    return (
        targets.find((t) => t.type === "page" && /localhost:5174|wave/i.test(t.url ?? "")) ??
        targets.find((t) => t.type === "page")
    );
}

function cdp(wsUrl) {
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
            }),
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

const target = await pickTarget();
if (!target) {
    console.error(`no page target on :${port} — is the dev app running with the debug flag? (see header)`);
    process.exit(1);
}
const client = await cdp(target.webSocketDebuggerUrl);
await client.send("Page.enable");
const { data } = await client.send("Page.captureScreenshot", { format: "png" });
client.close();
const { writeFileSync, mkdirSync } = await import("node:fs");
const { dirname } = await import("node:path");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, Buffer.from(data, "base64"));
console.log(`captured ${target.url} -> ${out}`);
