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
// Requires Node 21+ (global WebSocket + fetch; this repo runs Node 24). The CDP transport lives in
// the shared `scripts/cdp/attach.mjs` (the same one the verify harness uses), so target selection,
// per-command timeouts and socket-drop handling stay single-source — this file is just the CLI.
//
// When the dev app isn't up (or a concurrent HMR teardown drops :9222 mid-run) this exits nonzero
// with an actionable one-line message instead of an unhandled-rejection stack or an infinite hang.

import { attach } from "./cdp/attach.mjs";

const out = process.argv[2] ?? "cdp-shots/wave-cdp.png";
const port = process.argv[3] ?? "9222";

function die(msg) {
    console.error(`cdp-shot: ${msg}`);
    process.exit(1);
}

let client;
try {
    client = await attach(port);
} catch (e) {
    die(e?.message ?? String(e));
}

try {
    await client.shot(out);
} catch (e) {
    client.close();
    die(`screenshot failed — ${e?.message ?? String(e)}`);
}

client.close();
console.log(`captured ${client.url} -> ${out}`);
