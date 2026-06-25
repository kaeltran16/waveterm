// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Utility to abstract the fetch function, routing through the Tauri http plugin in the webview.

export function fetch(input: string | Request | URL, init?: RequestInit): Promise<Response> {
    // Tauri webview: globalThis.fetch is CORS-blocked (wavesrv is a different origin) and there is
    // no session-level authkey injection (Electron does that via onBeforeSendHeaders). Route through
    // the http plugin (Rust-side reqwest, no CORS) and carry the authkey header ourselves.
    if (typeof window !== "undefined" && (window as any).__TAURI_INTERNALS__ != null) {
        return tauriFetch(input, init);
    }
    return globalThis.fetch(input, init);
}

async function tauriFetch(input: string | Request | URL, init?: RequestInit): Promise<Response> {
    const { fetch: pluginFetch } = await import("@tauri-apps/plugin-http");
    const authKey = (window as any).api?.getAuthKey?.();
    const headers = new Headers(init?.headers);
    if (authKey) {
        headers.set("X-AuthKey", authKey);
    }
    return pluginFetch(input as any, { ...init, headers });
}
