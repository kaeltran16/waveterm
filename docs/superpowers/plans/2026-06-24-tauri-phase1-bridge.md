# Tauri Phase 1 — Day-One Native Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps
> use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Phase 0's `api-shim.ts` mock with a real, type-complete Tauri `window.api`
covering the boot + env/identity + terminal-basics slice, verified on the bare-xterm harness.

**Architecture:** A boot prefetch (`get_init`) caches all synchronous-getter data so the
sync `ElectronApi` getters can read it without `await`; fire-and-forget/Promise methods map
to Tauri `invoke`; the `onWaveInit` event maps to Tauri `listen` (requiring a new
capabilities file). Everything outside the ~12 day-one methods becomes a typed benign-default
stub. Backend, transport, and the 66 call sites are unchanged.

**Tech Stack:** Rust + Tauri v2 (`@tauri-apps/api ^2.11`); the `open` crate; TypeScript +
Vite; vitest (TS unit, env jsdom); manual observe-gates on the Windows dev app via
`cargo tauri dev` (per meta spec §12).

**Spec:** [`docs/superpowers/specs/2026-06-24-tauri-phase1-bridge-design.md`](../specs/2026-06-24-tauri-phase1-bridge-design.md)

> **GIT (user override):** Do NOT commit per task. Per the user's workflow, batch ALL
> changes into ONE commit at the end (Task 8), shown for approval first. The spec + this plan
> fold into that same feature commit. No per-task commits below.

> **Verification model:** TS bridge logic is unit-tested TDD-style (Task 4). Rust commands
> are side-effecting wrappers verified by the `cargo check` compile gate per task and the
> integration observe-gates in Task 7 (mirrors Phase 0). `cargo check` and `vitest` run from
> the **project root**.

---

## File Structure

| File | Responsibility |
|---|---|
| `src-tauri/src/init.rs` (modify) | `InitData` struct (boot prefetch payload) + `fe_log` command |
| `src-tauri/src/commands.rs` (create) | `set_window_init_status` (+`wave-init` emit), `set_is_active`, `open_external`, `increment_term_commands` |
| `src-tauri/src/main.rs` (modify) | register commands; seed static `InitData` fields; field-update on `WAVESRV-ESTART` |
| `src-tauri/Cargo.toml` (modify) | add `open = "5"` |
| `src-tauri/tauri.conf.json` (modify) | give the window `"label": "main"` |
| `src-tauri/capabilities/default.json` (create) | grant `core:default` + `core:event:default` to window `main` |
| `frontend/tauri/api.ts` (create) | `installTauriApi(init)` + `hlog` — the full `window.api` |
| `frontend/tauri/api-shim.ts` (delete) | absorbed into `api.ts` |
| `frontend/tauri/main.tsx` (modify) | call `installTauriApi`; drop `__waveAuthKey` + inline `getEnv` hacks |
| `frontend/tauri/terminal-harness.tsx` (modify) | import `hlog` from `./api`; add observe-gate toolbar |
| `frontend/tauri/api.test.ts` (create) | unit tests: sync getters, invoke methods, `onWaveInit`, stubs |

---

## Task 1: Rust — extend InitData and rename `harness_log` → `fe_log`

**Files:**
- Modify: `src-tauri/src/init.rs`

- [ ] **Step 1: Replace the file contents**

`src-tauri/src/init.rs`:

```rust
use serde::Serialize;
use std::sync::{Arc, Mutex};

#[derive(Default, Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InitData {
    pub ws_endpoint: String,
    pub web_endpoint: String,
    pub auth_key: String,
    pub version: String,
    pub build_time: i64,
    pub platform: String,
    pub is_dev: bool,
    pub user_name: String,
    pub host_name: String,
}

#[derive(Default)]
pub struct InitState(pub Arc<Mutex<InitData>>);

#[tauri::command]
pub fn get_init(state: tauri::State<InitState>) -> InitData {
    state.0.lock().unwrap().clone()
}

// backs both getApi().sendLog and the harness's hlog. Renamed from harness_log:
// the WebView2 console isn't observable from the dev loop, so logs land in the Rust console.
#[tauri::command]
pub fn fe_log(msg: String) {
    println!("[fe-log] {}", msg);
}
```

- [ ] **Step 2: Verify it compiles (will fail until main.rs is updated in Task 2)**

Run (from project root): `cargo check --manifest-path src-tauri/Cargo.toml`
Expected: FAILS — `main.rs` still references `init::harness_log` and the old `InitData`
literal. That is corrected in Task 2; do not fix it here. (If you prefer a green gate, do
Tasks 1–2 back-to-back and run `cargo check` once after Task 2.)

---

## Task 2: Rust — command module, dependency, and main.rs wiring

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Create: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/main.rs`

- [ ] **Step 1: Add the `open` crate**

In `src-tauri/Cargo.toml`, under `[dependencies]`, add:

```toml
open = "5"
```

- [ ] **Step 2: Create the commands module**

`src-tauri/src/commands.rs`:

```rust
use tauri::{AppHandle, Emitter};

// Phase 1 minimal wave-init payload — proves the Rust→FE event round-trip.
// The real WaveInitOpts (tabId/clientId/windowId from window/workspace state) is
// assembled in Phase 5 when the real boot path comes online.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WaveInitOpts {
    pub tab_id: String,
    pub client_id: String,
    pub window_id: String,
    pub activate: bool,
}

#[tauri::command]
pub fn set_window_init_status(app: AppHandle, status: String) {
    println!("[init-status] {}", status);
    if status == "ready" {
        let opts = WaveInitOpts {
            tab_id: String::new(),
            client_id: String::new(),
            window_id: String::new(),
            activate: true,
        };
        if let Err(e) = app.emit("wave-init", opts) {
            eprintln!("[init-status] emit wave-init failed: {}", e);
        }
    }
}

#[tauri::command]
pub fn set_is_active() {
    // Phase 1: acknowledge only (Electron sets an internal wasActive flag).
}

#[tauri::command]
pub fn open_external(url: String) {
    if let Err(e) = open::that(&url) {
        eprintln!("[open-external] failed to open {}: {}", url, e);
    }
}

#[tauri::command]
pub fn increment_term_commands() {
    // Phase 1: telemetry sink no-op (Electron increments command counters).
}
```

- [ ] **Step 3: Wire main.rs — module, handlers, seeded fields, field-update parse**

In `src-tauri/src/main.rs`:

(a) Add the module declaration after `mod init;`:

```rust
mod commands;
```

(b) Replace the `if let Some(info) = estart::parse_estart(&line) { ... }` block inside
`spawn_wavesrv`'s stderr thread so it updates only the parsed fields (preserving the seeded
identity fields) — replace:

```rust
            if let Some(info) = estart::parse_estart(&line) {
                let mut d = state_data.lock().unwrap();
                *d = InitData {
                    ws_endpoint: info.ws,
                    web_endpoint: info.web,
                    auth_key: auth_key.clone(),
                    version: info.version,
                    build_time: info.buildtime,
                };
                println!("[tauri] wavesrv ready: {:?}", *d);
            } else {
```

with:

```rust
            if let Some(info) = estart::parse_estart(&line) {
                let mut d = state_data.lock().unwrap();
                d.ws_endpoint = info.ws;
                d.web_endpoint = info.web;
                d.version = info.version;
                d.build_time = info.buildtime;
                println!("[tauri] wavesrv ready: {:?}", *d);
            } else {
```

(c) The `InitData` import is still used by the `#[derive]`-less seed below; keep
`use init::{InitData, InitState};` as-is.

(d) Replace the `tauri::Builder::default()...` chain in `fn main()` with:

```rust
    let auth_key = Uuid::new_v4().to_string();
    tauri::Builder::default()
        .manage(InitState::default())
        .invoke_handler(tauri::generate_handler![
            init::get_init,
            init::fe_log,
            commands::set_window_init_status,
            commands::set_is_active,
            commands::open_external,
            commands::increment_term_commands
        ])
        .setup(move |app| {
            // seed the static identity fields before wavesrv parsing fills in the endpoints.
            {
                let state = app.state::<InitState>();
                let mut d = state.0.lock().unwrap();
                d.auth_key = auth_key.clone();
                d.platform = "win32".to_string();
                d.is_dev = cfg!(debug_assertions);
                d.user_name = std::env::var("USERNAME").unwrap_or_default();
                d.host_name = std::env::var("COMPUTERNAME").unwrap_or_default();
            }
            spawn_wavesrv(auth_key.clone(), app.state::<InitState>());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
```

Note: `InitData` is no longer constructed as a literal in the thread, but it IS named by the
seed block via the state type; if rust-analyzer flags `InitData` as unused, change the import
to `use init::InitState;` and keep `InitData` only where referenced. Let the compiler guide.

- [ ] **Step 4: Verify the Rust backend compiles**

Run (from project root): `cargo check --manifest-path src-tauri/Cargo.toml`
Expected: PASS (warnings OK). If `open` fails to resolve, run
`cargo fetch --manifest-path src-tauri/Cargo.toml` first.

---

## Task 3: Rust — capabilities file and window label

**Files:**
- Modify: `src-tauri/tauri.conf.json`
- Create: `src-tauri/capabilities/default.json`

- [ ] **Step 1: Give the window an explicit label**

In `src-tauri/tauri.conf.json`, change the windows entry:

```json
    "windows": [
      { "label": "main", "title": "Wave Tauri Spike", "width": 1000, "height": 700 }
    ],
```

- [ ] **Step 2: Create the capabilities file**

`src-tauri/capabilities/default.json`:

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "Phase 1 bridge: core defaults + event listen for the main window.",
  "windows": ["main"],
  "permissions": ["core:default", "core:event:default"]
}
```

- [ ] **Step 3: Verify capabilities parse during build codegen**

Run (from project root): `cargo check --manifest-path src-tauri/Cargo.toml`
Expected: PASS. A malformed capability identifier or unknown permission fails here (the
`tauri-build` codegen validates capability files). If it errors with "permission not found",
confirm the exact strings `core:default` and `core:event:default`.

---

## Task 4: TS — the bridge (`api.ts`) with unit tests (TDD)

**Files:**
- Create: `frontend/tauri/api.test.ts`
- Create: `frontend/tauri/api.ts`

- [ ] **Step 1: Write the failing tests**

`frontend/tauri/api.test.ts`:

```ts
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn(() => Promise.resolve());
const listenMock = vi.fn(() => Promise.resolve(() => {}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: any[]) => invokeMock(...a) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: (...a: any[]) => listenMock(...a) }));

import { installTauriApi, type InitData } from "./api";

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
        listenMock.mockImplementationOnce((_evt: string, cb: any) => {
            cb({ payload: { tabId: "t1" } });
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
        expect(api.getZoomFactor()).toBe(1);
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (from project root): `npx vitest run frontend/tauri/api.test.ts`
Expected: FAIL — `Cannot find module './api'` (file not created yet).

- [ ] **Step 3: Implement the bridge**

`frontend/tauri/api.ts`:

```ts
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
```

Note: `getUpdaterStatus`/`getAboutModalDetails` defaults are cast `as any` — they are
deferred-method stubs not exercised by the harness (Task 7, gate 5); their real return shapes
are pinned when the methods get real implementations in Phase 2/3.

- [ ] **Step 4: Run the tests to verify they pass**

Run (from project root): `npx vitest run frontend/tauri/api.test.ts`
Expected: PASS — all describe blocks green.

---

## Task 5: TS — rewire `main.tsx` and delete `api-shim.ts`

**Files:**
- Modify: `frontend/tauri/main.tsx`
- Modify: `frontend/tauri/terminal-harness.tsx`
- Delete: `frontend/tauri/api-shim.ts`

- [ ] **Step 1: Repoint the harness log import**

In `frontend/tauri/terminal-harness.tsx`, change line 10 from:

```ts
import { hlog } from "./api-shim";
```

to:

```ts
import { hlog } from "./api";
```

- [ ] **Step 2: Rewire main.tsx to use the real bridge**

In `frontend/tauri/main.tsx`, replace the top import block and the first part of `boot()`.
Replace:

```ts
import { invoke } from "@tauri-apps/api/core";
import { createRoot } from "react-dom/client";
import { hlog, installApiShim } from "./api-shim";

type InitData = { wsEndpoint: string; webEndpoint: string; authKey: string; version: string; buildTime: number };
```

with:

```ts
import { invoke } from "@tauri-apps/api/core";
import { createRoot } from "react-dom/client";
import { hlog, installTauriApi, type InitData } from "./api";
```

Then replace this block inside `boot()`:

```ts
        const init = await invoke<InitData>("get_init");
        (window as any).__waveAuthKey = init.authKey;
        installApiShim();
        // the real endpoints.ts reads endpoints via getApi().getEnv(); feed it from get_init.
        (window as any).api.getEnv = (k: string) => {
            if (k === "WAVE_SERVER_WS_ENDPOINT") return init.wsEndpoint;
            if (k === "WAVE_SERVER_WEB_ENDPOINT") return init.webEndpoint;
            return null;
        };
        hlog("init: ws=" + init.wsEndpoint + " version=" + init.version);
```

with:

```ts
        const init = await invoke<InitData>("get_init");
        installTauriApi(init);
        hlog("init: ws=" + init.wsEndpoint + " version=" + init.version);
```

Leave the rest of `boot()` (the `initElectronWshrpc(client, { authKey: init.authKey })` wiring,
the ws-open wait, the WorkspaceList → tabId fetch, and the `TerminalHarness` render) unchanged.

- [ ] **Step 3: Delete the shim**

Delete `frontend/tauri/api-shim.ts`.

Run (from project root): `git rm frontend/tauri/api-shim.ts`
(or delete the file; it will be staged in Task 8.)

- [ ] **Step 4: Verify nothing else imports the shim**

Run (from project root): `grep -rn "api-shim" frontend/`
Expected: NO output (zero matches). If any remain, repoint them to `./api`.

- [ ] **Step 5: Re-run the unit tests (regression)**

Run (from project root): `npx vitest run frontend/tauri/api.test.ts`
Expected: PASS (unchanged from Task 4).

---

## Task 6: TS — harness observe-gate affordances

**Files:**
- Modify: `frontend/tauri/terminal-harness.tsx`

- [ ] **Step 1: Add the import for getApi**

At the top of `frontend/tauri/terminal-harness.tsx`, add (alongside the existing imports):

```ts
import { getApi } from "@/store/global";
```

- [ ] **Step 2: Register onWaveInit and render a toolbar**

In `TerminalHarness`, add an effect that registers the wave-init handler once, and render a
small fixed toolbar above the terminal. Add this effect right after the existing
`useEffect(() => { ... }, [])` block (as a second effect):

```tsx
    useEffect(() => {
        // observe-gate 2: prove the Rust→FE event round-trip and the capabilities wiring.
        getApi().onWaveInit((opts) => getApi().sendLog("wave-init received: " + JSON.stringify(opts)));
    }, []);
```

Then change the returned JSX from:

```tsx
    return <div ref={elemRef} style={{ width: "100vw", height: "100vh" }} />;
```

to:

```tsx
    return (
        <div style={{ width: "100vw", height: "100vh", display: "flex", flexDirection: "column" }}>
            <div style={{ display: "flex", gap: 8, padding: 4, background: "#222", color: "#ddd", fontFamily: "monospace", fontSize: 12 }}>
                <button onClick={() => getApi().setWindowInitStatus("ready")}>init: ready</button>
                <button onClick={() => getApi().openExternal("https://waveterm.dev")}>open external</button>
                <button onClick={() => getApi().incrementTermCommands()}>incr term cmds</button>
                <button onClick={() => getApi().setIsActive()}>set active</button>
            </div>
            <div ref={elemRef} style={{ flex: 1 }} />
        </div>
    );
```

Note: `term.open(elemRef.current)` + `fit.fit()` already run in the first effect; the
terminal now fills the flex child instead of the full viewport. The resize handler already
calls `fit.fit()`, so reflow still works.

- [ ] **Step 3: Verify the harness still type-checks**

Run (from project root): `npx vitest run frontend/tauri/api.test.ts`
Expected: PASS (the harness isn't unit-tested, but a TS error in it would surface during the
Task 7 dev build). No new test needed here — Task 7 is the gate.

---

## Task 7: Integration observe-gates (Windows dev app)

**Files:** none (verification only).

- [ ] **Step 1: Launch the dev app**

Run (from project root): `cargo tauri dev`
This runs `beforeDevCommand` (the harness Vite server on :5174), compiles the Rust shell,
spawns the dev-built `wavesrv`, and opens the WebView2 window. Watch the Rust console
(the terminal where you ran the command) for `[fe-log]`, `[init-status]`, `[tauri]` lines.

- [ ] **Step 2: Gate 1 — boot through the real `getEnv` (auth via query param)**

Expected: the terminal renders and a shell prompt appears (PTY flowing). The console shows
`[fe-log] init: ws=... version=...` and `[fe-log] ws open=true`. This proves `installTauriApi`'s
real `getEnv` fed `getWSServerEndpoint()` and the authkey query param authenticated the socket
(spec §7), with NO inline `getEnv`/`__waveAuthKey` hacks.

- [ ] **Step 3: Gate 2 — wave-init round-trip (proves the capability file)**

Click **init: ready**. Expected console line:
`[init-status] ready` followed by `[fe-log] wave-init received: {"tabId":"","clientId":"","windowId":"","activate":true}`.
If instead you see a `listen` error (e.g. "event.listen not allowed"), the capabilities file
(Task 3) is missing or the window label doesn't match `"main"` — fix and relaunch.

- [ ] **Step 4: Gate 3 — openExternal**

Click **open external**. Expected: the default browser opens `https://waveterm.dev`. No
console error from `[open-external]`.

- [ ] **Step 5: Gate 4 — incrementTermCommands / setIsActive / sendLog invoke cleanly**

Click **incr term cmds** and **set active**. Expected: no errors in the console; the commands
return without throwing. (`sendLog` was already exercised by every `[fe-log]` line.)

- [ ] **Step 6: Gate 5 — no stub hit on the happy path**

Expected: the WebView2 devtools console (right-click → Inspect, or it may be the dev console)
shows NO `[tauri-bridge] stub called:` warnings during normal boot + the gate clicks. A stub
warning means a real dependency was reached unexpectedly — investigate before declaring done.

- [ ] **Step 7: Confirm all five gates passed**

All of gates 1–5 must be observed live. If any failed, fix and re-run before Task 8.

---

## Task 8: Final review and single commit (await approval)

**Files:** all of the above + the spec + this plan.

- [ ] **Step 1: Self-review the diff**

Run (from project root): `git status` then `git --no-pager diff` (and review new/staged files).
Confirm: no debug statements left in production paths, no commented-out code, `api-shim.ts`
deleted, no `api-shim` references remain.

- [ ] **Step 2: Run the full TS unit suite (no regressions elsewhere)**

Run (from project root): `npx vitest run`
Expected: PASS (existing suites + the new `api.test.ts`).

- [ ] **Step 3: Present the commit for approval (user git workflow)**

Show the file list with M/A/D status and the proposed message, then ask:
"Awaiting approval. Proceed? (yes/no)". Proposed message:

```
feat(tauri): phase-1 day-one native bridge (real window.api over invoke/events)
```

The spec (`docs/superpowers/specs/2026-06-24-tauri-phase1-bridge-design.md`) and this plan
fold into THIS commit — no separate docs commit. Do NOT commit until the user approves.

---

## Self-Review (against the spec)

**Spec coverage:**
- §3 sync/async pattern → Task 4 (`getEnv`/identity read the cache; invoke/event split). ✓
- §4 bridge module shape (single `api.ts`, preload-mirror) → Task 4. ✓
- §5.1 day-one (12 methods) → Task 4 implements all; gates 1–4 verify. ✓
- §5.2 stubs (benign defaults, log-once) → Task 4 `installStubs` + tests + gate 5. ✓
- §5.3 `openExternal` via `open` crate → Task 2 (`open_external`) + Task 4. ✓
- §6 Rust commands + `wave-init` event → Tasks 1–2. ✓
- §6.0 capabilities (mandatory) → Task 3 + gate 2. ✓
- §6.1 boot-handshake minimal payload → Task 2 `WaveInitOpts` + Task 6 register + gate 2. ✓
- §7 auth via query param + `getAuthKey` from `get_init` → Task 4 `getAuthKey` + gate 1. ✓
- §9 verification (unit + observe-gates) → Tasks 4, 7. ✓

**Placeholder scan:** no TBD/TODO; every code step shows complete code; every command has
expected output. ✓

**Type consistency:** `InitData` (TS, camelCase) matches the Rust `InitData` (serde
`rename_all = "camelCase"`); `WaveInitOpts` referenced in `api.ts` is the ambient global
(`custom.d.ts:66`) and the Rust emit payload uses the same camelCase keys; command names
(`fe_log`, `open_external`, `set_window_init_status`, `set_is_active`,
`increment_term_commands`, `get_init`) are identical between `main.rs` handlers and the
`invoke(...)` call sites in `api.ts`. ✓
