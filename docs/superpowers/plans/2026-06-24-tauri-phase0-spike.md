# Tauri Phase 0 Spike — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a standalone Tauri window where Rust spawns the unchanged `wavesrv`, hands the frontend the ws endpoint + authkey via `get_init`, and a bare xterm.js terminal runs a real PTY over the unchanged `wshrpc` websocket.

**Architecture:** Additive to the tree — `src-tauri/` (Rust shell) + `frontend/tauri/` (minimal harness SPA), the existing Electron app untouched. Rust mirrors `emain/emain-wavesrv.ts`'s sidecar handshake; the frontend reuses the real `frontend/app/store` ws + `wshrpc` client. The PTY is owned by a backend block controller, so the harness creates a minimal tab+block, runs `ControllerResync` to launch the shell, sends input via `ControllerInput`, and renders the "term" blockfile stream into xterm.

**Tech Stack:** Rust + Tauri v2 (pinned 2.x), `regex` + `uuid` crates; TypeScript + Vite + `@xterm/xterm` (+ `addon-webgl`, `addon-fit`); Go (`pkg/authkey`); vitest (TS unit), `go test` (Go unit), and manual observe-gates on the Windows dev app (per meta spec §12).

**Source spec:** [`../specs/2026-06-24-tauri-phase0-spike-design.md`](../specs/2026-06-24-tauri-phase0-spike-design.md). Decisions referenced as P0-1..P0-5.

**Verification model:** Phase 0 is a spike. Pure logic is unit-tested TDD-style (Tasks 1, 3, and the ws-URL helper in Task 5). Integration is verified by explicit observe-gates with expected output (Tasks 2, 4, 5, 6) — this is the real gate per meta spec §12, not a substitute for tests.

**Commits:** Per the user's git workflow, every commit requires explicit approval and may be batched. The `Commit` steps below mark logical commit points; do not run them without the user's go-ahead.

---

## File Structure

**Create:**
- `src-tauri/Cargo.toml` — Rust crate manifest (tauri 2.x, regex, uuid, serde).
- `src-tauri/tauri.conf.json` — Tauri config (devUrl → harness vite server, beforeDevCommand, window).
- `src-tauri/build.rs` — standard Tauri build script.
- `src-tauri/src/main.rs` — app entry: spawn wavesrv, read stderr, hold init state, register `get_init`.
- `src-tauri/src/estart.rs` — pure `parse_estart` + `EstartInfo` (unit-tested).
- `src-tauri/src/init.rs` — `InitData` struct + `get_init` command + shared state.
- `frontend/tauri/index.html` — single mount point.
- `frontend/tauri/main.tsx` — invoke `get_init` → connect ws → mount harness.
- `frontend/tauri/terminal-harness.tsx` — xterm + WebGL + create-block + resync/input + term-file pump.
- `frontend/tauri/api-shim.ts` — minimal `window.api` shim (only what the connect+shellproc path reaches).
- `frontend/tauri/vite.config.ts` — vite config; `@/*` → `frontend/*` alias; dev server port.
- `pkg/authkey/authkey_test.go` — unit tests for the query-param fallback.
- `frontend/util/wsutil.test.ts` — unit test for the ws-URL authkey helper.

**Modify:**
- `pkg/authkey/authkey.go:17-26` — add query-param fallback to `ValidateIncomingRequest`.
- `frontend/util/wsutil.ts` — add `buildWsConnUrl` helper.
- `frontend/app/store/ws.ts:77-84` — use `buildWsConnUrl` so `eoOpts.authKey` rides as `&authkey=` query param.

---

## Task 1: Go authkey query-param fallback (P0-2)

**Files:**
- Modify: `pkg/authkey/authkey.go:17-26`
- Test: `pkg/authkey/authkey_test.go` (create)

- [ ] **Step 1: Write the failing test**

Create `pkg/authkey/authkey_test.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package authkey

import (
	"net/http/httptest"
	"testing"
)

func TestValidateIncomingRequest(t *testing.T) {
	authkey = "test-key" // set the package-level var directly (white-box test)

	cases := []struct {
		name    string
		url     string
		header  string
		wantErr bool
	}{
		{"valid header", "/ws", "test-key", false},
		{"valid query param, no header", "/ws?authkey=test-key", "", false},
		{"header wins over bad query", "/ws?authkey=bad", "test-key", false},
		{"no header, no query", "/ws", "", true},
		{"wrong query param", "/ws?authkey=bad", "", true},
		{"wrong header", "/ws", "bad", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest("GET", tc.url, nil)
			if tc.header != "" {
				req.Header.Set(AuthKeyHeader, tc.header)
			}
			err := ValidateIncomingRequest(req)
			if tc.wantErr && err == nil {
				t.Fatalf("expected error, got nil")
			}
			if !tc.wantErr && err != nil {
				t.Fatalf("expected nil, got %v", err)
			}
		})
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run (from project root): `go test ./pkg/authkey/ -run TestValidateIncomingRequest -v`
Expected: FAIL — the `valid query param, no header` and `header wins over bad query` cases error out, because the current code only reads the header.

- [ ] **Step 3: Add the query-param fallback**

Edit `pkg/authkey/authkey.go`, replace `ValidateIncomingRequest`:

```go
func ValidateIncomingRequest(r *http.Request) error {
	reqAuthKey := r.Header.Get(AuthKeyHeader)
	if reqAuthKey == "" {
		reqAuthKey = r.URL.Query().Get("authkey")
	}
	if reqAuthKey == "" {
		return fmt.Errorf("no x-authkey header or authkey query param")
	}
	if reqAuthKey != GetAuthKey() {
		return fmt.Errorf("authkey is invalid")
	}
	return nil
}
```

- [ ] **Step 4: Run test to verify it passes**

Run (from project root): `go test ./pkg/authkey/ -run TestValidateIncomingRequest -v`
Expected: PASS (all 6 sub-cases).

- [ ] **Step 5: Commit** (await approval)

```bash
git add pkg/authkey/authkey.go pkg/authkey/authkey_test.go
git commit -m "feat(authkey): accept authkey via query param fallback"
```

---

## Task 2: Tauri scaffold + harness vite shell (P0-4)

**Files:**
- Create: `src-tauri/Cargo.toml`, `src-tauri/build.rs`, `src-tauri/tauri.conf.json`, `src-tauri/src/main.rs`
- Create: `frontend/tauri/index.html`, `frontend/tauri/main.tsx`, `frontend/tauri/vite.config.ts`

- [ ] **Step 1: Pin and install the Tauri CLI (latest stable 2.x)**

Run: `cargo install tauri-cli --version "^2.0"`
Then record the resolved version: `cargo tauri --version`
Write the exact version into this plan here once known: **Tauri CLI: `2.11.3`** (latest stable 2.x; resolved from `^2.0`. Required switching the Rust default toolchain to `stable-x86_64-pc-windows-msvc` + installing VS 2022 Build Tools "Desktop development with C++" — the GNU toolchain's MinGW `ld` could not link).

- [ ] **Step 2: Create the Rust crate manifest**

Create `src-tauri/Cargo.toml`:

```toml
[package]
name = "wave-tauri"
version = "0.1.0"
edition = "2021"

[lib]
name = "wave_tauri_lib"
crate-type = ["staticlib", "cdylib", "rlib"]

[build-dependencies]
tauri-build = { version = "2", features = [] }

[dependencies]
tauri = { version = "2", features = [] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
regex = "1"
uuid = { version = "1", features = ["v4"] }
```

Create `src-tauri/build.rs`:

```rust
fn main() {
    tauri_build::build()
}
```

- [ ] **Step 3: Create the Tauri config pointing at the harness vite server**

Create `src-tauri/tauri.conf.json`:

```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "wave-tauri-spike",
  "version": "0.1.0",
  "identifier": "dev.waveterm.tauri.spike",
  "build": {
    "devUrl": "http://localhost:5174",
    "beforeDevCommand": "npx vite --config frontend/tauri/vite.config.ts",
    "frontendDist": "../frontend/tauri/dist"
  },
  "app": {
    "windows": [
      { "title": "Wave Tauri Spike", "width": 1000, "height": 700 }
    ],
    "security": { "csp": null }
  }
}
```

- [ ] **Step 4: Create the harness vite config with the `@/` alias**

Create `frontend/tauri/vite.config.ts`:

```ts
import react from "@vitejs/plugin-react-swc";
import { resolve } from "path";
import { defineConfig } from "vite";

export default defineConfig({
    root: resolve(__dirname),
    plugins: [react()],
    resolve: {
        alias: { "@": resolve(__dirname, "..") }, // @/ -> frontend/
    },
    server: { port: 5174, strictPort: true },
    build: { outDir: resolve(__dirname, "dist"), emptyOutDir: true },
});
```

- [ ] **Step 5: Create the harness HTML + a "hello" entry**

Create `frontend/tauri/index.html`:

```html
<!doctype html>
<html>
    <head>
        <meta charset="utf-8" />
        <title>Wave Tauri Spike</title>
    </head>
    <body style="margin: 0; background: #1a1a1a; color: #eee">
        <div id="root"></div>
        <script type="module" src="./main.tsx"></script>
    </body>
</html>
```

Create `frontend/tauri/main.tsx`:

```tsx
import { createRoot } from "react-dom/client";

function App() {
    return <div style={{ padding: 20, fontFamily: "monospace" }}>tauri spike: shell up</div>;
}

createRoot(document.getElementById("root")).render(<App />);
```

- [ ] **Step 6: Create the minimal Rust entry (opens a window only)**

Create `src-tauri/src/main.rs`:

```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

- [ ] **Step 7: Observe-gate — window opens with the page**

Run (from project root): `cargo tauri dev`
Expected: a window titled "Wave Tauri Spike" opens showing "tauri spike: shell up". (The vite dev server starts via `beforeDevCommand`.) Close the window to exit.

- [ ] **Step 8: Commit** (await approval)

```bash
git add src-tauri/ frontend/tauri/
git commit -m "feat(tauri): scaffold phase-0 shell + harness vite entry"
```

---

## Task 3: Rust ESTART line parser (pure, TDD)

**Files:**
- Create: `src-tauri/src/estart.rs`

- [ ] **Step 1: Write the failing test**

Create `src-tauri/src/estart.rs`:

```rust
use regex::Regex;

#[derive(Debug, Clone, PartialEq)]
pub struct EstartInfo {
    pub ws: String,
    pub web: String,
    pub version: String,
    pub buildtime: i64,
}

// Mirrors emain/emain-wavesrv.ts:110 — matches the ESTART line wavesrv prints on stderr.
pub fn parse_estart(line: &str) -> Option<EstartInfo> {
    let re = Regex::new(r"WAVESRV-ESTART ws:([a-z0-9.:]+) web:([a-z0-9.:]+) version:([a-z0-9.-]+) buildtime:(\d+)").ok()?;
    let caps = re.captures(line)?;
    Some(EstartInfo {
        ws: caps[1].to_string(),
        web: caps[2].to_string(),
        version: caps[3].to_string(),
        buildtime: caps[4].parse().ok()?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_real_estart_line() {
        let line = "WAVESRV-ESTART ws:127.0.0.1:61269 web:127.0.0.1:61270 version:0.11.0-beta.1 buildtime:1719240000";
        let info = parse_estart(line).expect("should parse");
        assert_eq!(info.ws, "127.0.0.1:61269");
        assert_eq!(info.web, "127.0.0.1:61270");
        assert_eq!(info.version, "0.11.0-beta.1");
        assert_eq!(info.buildtime, 1719240000);
    }

    #[test]
    fn ignores_event_lines() {
        assert_eq!(parse_estart("WAVESRV-EVENT:{\"foo\":1}"), None);
    }

    #[test]
    fn ignores_plain_log_lines() {
        assert_eq!(parse_estart("some random log output"), None);
    }
}
```

- [ ] **Step 2: Declare the module so the test compiles**

Edit `src-tauri/src/main.rs`, add at the top (after the `#![cfg_attr...]` line):

```rust
mod estart;
```

- [ ] **Step 3: Run test to verify it passes**

Run (from project root): `cargo test --manifest-path src-tauri/Cargo.toml estart`
Expected: PASS (3 tests). (Written test-first; it passes immediately because the parser is included — if the regex is wrong, `parses_real_estart_line` fails, which is the guard.)

- [ ] **Step 4: Commit** (await approval)

```bash
git add src-tauri/src/estart.rs src-tauri/src/main.rs
git commit -m "feat(tauri): parse WAVESRV-ESTART line in rust"
```

---

## Task 4: Rust sidecar spawn + `get_init` (P0-3)

**Files:**
- Create: `src-tauri/src/init.rs`
- Modify: `src-tauri/src/main.rs`

- [ ] **Step 1: Build the dev wavesrv binary**

Run (from project root): `task build:backend:quickdev:windows`
Expected: `dist/bin/wavesrv.x64.exe` exists. Confirm: `ls dist/bin/wavesrv.x64.exe`.

- [ ] **Step 2: Define the init state + `get_init` command**

Create `src-tauri/src/init.rs`:

```rust
use serde::Serialize;
use std::sync::Mutex;

#[derive(Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InitData {
    pub ws_endpoint: String,
    pub web_endpoint: String,
    pub auth_key: String,
    pub version: String,
    pub build_time: i64,
}

#[derive(Default)]
pub struct InitState(pub Mutex<InitData>);

#[tauri::command]
pub fn get_init(state: tauri::State<InitState>) -> InitData {
    state.0.lock().unwrap().clone()
}
```

- [ ] **Step 3: Spawn wavesrv, read stderr, fill init state**

Replace `src-tauri/src/main.rs` with:

```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod estart;
mod init;

use init::{InitData, InitState};
use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use tauri::Manager;
use uuid::Uuid;

fn spawn_wavesrv(auth_key: String, state: tauri::State<InitState>) {
    // Phase 0: spawn the dev-built binary by path (sidecar bundling is Phase 4).
    let exe = std::env::current_dir().unwrap().join("dist/bin/wavesrv.x64.exe");
    let mut child = Command::new(exe)
        .env("WAVETERM_AUTH_KEY", &auth_key)
        // data/config dirs: rely on wavesrv defaults for the spike; override here if needed.
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("failed to spawn wavesrv");

    let stderr = child.stderr.take().unwrap();
    let state_data = state.0.clone();
    std::thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines().flatten() {
            if line.starts_with("WAVESRV-EVENT:") {
                continue; // same stream carries event JSON; ignore for the spike
            }
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
                println!("[wavesrv] {}", line);
            }
        }
    });
}

fn main() {
    let auth_key = Uuid::new_v4().to_string();
    tauri::Builder::default()
        .manage(InitState::default())
        .invoke_handler(tauri::generate_handler![init::get_init])
        .setup(move |app| {
            spawn_wavesrv(auth_key.clone(), app.state::<InitState>());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

> Note: `InitState.0` is a `Mutex` — to share it into the thread, change `init.rs` to wrap it in `Arc`: make the field `pub Arc<Mutex<InitData>>` and update `get_init`/`Default` accordingly. Pin the exact `Arc`/`State` plumbing during execution (the compiler is the guide). The behavior to verify is below.

- [ ] **Step 4: Observe-gate — `get_init` returns real endpoints**

Run (from project root): `cargo tauri dev`
Expected: the Rust console prints `[tauri] wavesrv ready: InitData { ws_endpoint: "127.0.0.1:...", ... }` within a few seconds of launch. If it prints `[wavesrv]` lines but never "ready", the ESTART parse or the stream choice is wrong — fix before proceeding.

- [ ] **Step 5: Commit** (await approval)

```bash
git add src-tauri/src/init.rs src-tauri/src/main.rs
git commit -m "feat(tauri): spawn wavesrv sidecar and expose get_init"
```

---

## Task 5: Frontend connect via `get_init` + authkey query param (P0-2)

**Files:**
- Modify: `frontend/util/wsutil.ts`, `frontend/app/store/ws.ts:77-84`
- Create: `frontend/util/wsutil.test.ts`, `frontend/tauri/api-shim.ts`
- Modify: `frontend/tauri/main.tsx`

- [ ] **Step 1: Write the failing test for the ws-URL helper**

Create `frontend/util/wsutil.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildWsConnUrl } from "./wsutil";

describe("buildWsConnUrl", () => {
    it("includes stableid", () => {
        const url = buildWsConnUrl("ws://127.0.0.1:9001", "abc", null);
        expect(url).toBe("ws://127.0.0.1:9001/ws?stableid=abc");
    });
    it("appends authkey when provided", () => {
        const url = buildWsConnUrl("ws://127.0.0.1:9001", "abc", "key123");
        expect(url).toBe("ws://127.0.0.1:9001/ws?stableid=abc&authkey=key123");
    });
    it("omits authkey when null", () => {
        const url = buildWsConnUrl("ws://127.0.0.1:9001", "a b", null);
        expect(url).toContain("stableid=a%20b");
        expect(url).not.toContain("authkey");
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from project root): `npx vitest run frontend/util/wsutil.test.ts`
Expected: FAIL — `buildWsConnUrl` is not exported.

- [ ] **Step 3: Add the helper to `wsutil.ts`**

Edit `frontend/util/wsutil.ts`, add (keep existing exports):

```ts
function buildWsConnUrl(baseHostPort: string, stableId: string, authKey: string | null): string {
    let url = baseHostPort + "/ws?stableid=" + encodeURIComponent(stableId);
    if (authKey) {
        url += "&authkey=" + encodeURIComponent(authKey);
    }
    return url;
}
```

Add `buildWsConnUrl` to the `export { ... }` line.

- [ ] **Step 4: Run test to verify it passes**

Run (from project root): `npx vitest run frontend/util/wsutil.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Use the helper in `ws.ts`**

Edit `frontend/app/store/ws.ts`. Import `buildWsConnUrl` from `@/util/wsutil`. Replace the `connectNow` URL/headers block (lines ~77-84):

```ts
this.wsConn = newWebSocket(
    buildWsConnUrl(this.baseHostPort, this.stableId, this.eoOpts ? this.eoOpts.authKey : null),
    null
);
```

> The header arg is now always `null` — browsers drop WS headers anyway; the authkey rides as the `&authkey=` query param the Go server accepts (Task 1). The Electron session-header path still works for the existing app (header still injected), so this is backward-compatible.

- [ ] **Step 6: Create the minimal `window.api` shim (discover the reached-set)**

Create `frontend/tauri/api-shim.ts` with an initial best-guess shim, then expand it driven by runtime errors:

```ts
// Minimal getApi() shim for the connect+shellproc path only (Phase 0).
// Expand ONLY when a runtime "getApi().X is not a function" error proves X is reached.
export function installApiShim() {
    (window as any).api = {
        getEnv: (_k: string) => null, // endpoints come from get_init, not env, in the harness
        getPlatform: () => "win32",
        getIsDev: () => true,
        sendLog: (msg: string) => console.log("[wsh-log]", msg),
        getAuthKey: () => (window as any).__waveAuthKey ?? "",
    };
}
```

- [ ] **Step 7: Wire `main.tsx` — get_init → ws connect**

Replace `frontend/tauri/main.tsx`:

```tsx
import { invoke } from "@tauri-apps/api/core";
import { createRoot } from "react-dom/client";
import { installApiShim } from "./api-shim";

type InitData = { wsEndpoint: string; webEndpoint: string; authKey: string; version: string; buildTime: number };

async function boot() {
    const init = await invoke<InitData>("get_init");
    (window as any).__waveAuthKey = init.authKey;
    installApiShim();
    console.log("[harness] init", init);

    // Set the env vars the existing endpoints.ts reads, so getWSServerEndpoint() resolves.
    (window as any).api.getEnv = (k: string) => {
        if (k === "WAVE_SERVER_WS_ENDPOINT") return init.wsEndpoint;
        if (k === "WAVE_SERVER_WEB_ENDPOINT") return init.webEndpoint;
        return null;
    };

    const { TerminalHarness } = await import("./terminal-harness");
    createRoot(document.getElementById("root")).render(<TerminalHarness authKey={init.authKey} />);
}

boot();
```

> Add the `@tauri-apps/api` dependency: `npm install @tauri-apps/api@^2`.

- [ ] **Step 8: Observe-gate — ws connects, authenticated by query param**

Temporarily render a stub `TerminalHarness` that just opens the ws (or comment the import and call the store's ws init). Run `cargo tauri dev`. 
Expected: the wavesrv log shows an accepted `/ws` connection. Confirm the authkey arrived via **query param**: there should be **no** `X-AuthKey` header and **no** "error validating authkey" line. If auth fails, the query-param wiring (Task 1 or Step 5) is wrong.

- [ ] **Step 9: Commit** (await approval)

```bash
git add frontend/util/wsutil.ts frontend/util/wsutil.test.ts frontend/app/store/ws.ts frontend/tauri/
git commit -m "feat(tauri): connect ws via get_init with authkey query param"
```

---

## Task 6: Terminal harness — create block, run PTY, render to xterm (P0-1)

**Files:**
- Create: `frontend/tauri/terminal-harness.tsx`

This is the riskiest task. It reuses the real `wshrpc` RPCs that `TermWrap` uses (`termwrap.ts`), minus OSC/cache/sticker complexity.

- [ ] **Step 1: Investigate — obtain a `tabid`**

Determine how the harness gets a `tabid` to attach a block to. Two candidates, in order of preference:
1. **Reuse the default tab:** after `wavesrv` bootstraps a fresh data dir it creates a default client → workspace → tab. Query it: get `ClientData` via the rpc client, follow `workspaceid` → workspace obj `activetabid` (use `WOS`/`ObjectService` getters as `termwrap.ts`/global store do). Log the discovered `tabid`.
2. **Mint one:** if no default tab is reachable, create a workspace + tab via their `wshrpc` create commands.

Record the working approach inline here: **tabid source: `________`**.

- [ ] **Step 2: Create a terminal block**

Using the rpc client + `RpcApi.CreateBlockCommand`:

```ts
const blockRef = await RpcApi.CreateBlockCommand(TabRpcClient, {
    tabid: TAB_ID,
    blockdef: { meta: { view: "term", controller: "shell" } },
    ephemeral: true,
});
const blockId = blockRef.oid; // ORef -> { otype, oid }
```

- [ ] **Step 3: Build the xterm harness component**

Create `frontend/tauri/terminal-harness.tsx`:

```tsx
import { getFileSubject } from "@/app/store/wps";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { base64ToArray, stringToBase64 } from "@/util/util";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef } from "react";

export function TerminalHarness({ authKey }: { authKey: string }) {
    const elemRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        let disposed = false;
        const term = new Terminal({ fontSize: 13, fontFamily: "monospace", cursorBlink: true });
        const fit = new FitAddon();
        term.loadAddon(fit);
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => console.warn("[harness] webgl context lost -> would fall back to dom"));
        term.loadAddon(webgl);
        term.open(elemRef.current);
        fit.fit();
        console.log("[harness] webgl active:", !webgl.isDisposed);

        (async () => {
            const TAB_ID = await resolveTabId(); // from Step 1
            const block = await RpcApi.CreateBlockCommand(TabRpcClient, {
                tabid: TAB_ID,
                blockdef: { meta: { view: "term", controller: "shell" } },
                ephemeral: true,
            });
            const blockId = block.oid;
            if (disposed) return;

            // output: subscribe to the "term" blockfile and write appends to xterm
            const fileSub = getFileSubject(blockId, "term");
            fileSub.subscribe((msg: WSFileEventData) => {
                if (msg.fileop === "append") {
                    term.write(base64ToArray(msg.data64));
                } else if (msg.fileop === "truncate") {
                    term.clear();
                }
            });

            // launch the shell PTY
            await RpcApi.ControllerResyncCommand(TabRpcClient, {
                tabid: TAB_ID,
                blockid: blockId,
                rtopts: { termsize: { rows: term.rows, cols: term.cols } },
            });

            // input: keystrokes -> controllerinput
            term.onData((data) => {
                RpcApi.ControllerInputCommand(TabRpcClient, { blockid: blockId, inputdata64: stringToBase64(data) });
            });

            // resize -> controllerinput termsize
            const onResize = () => {
                fit.fit();
                RpcApi.ControllerInputCommand(TabRpcClient, {
                    blockid: blockId,
                    termsize: { rows: term.rows, cols: term.cols },
                });
            };
            window.addEventListener("resize", onResize);
        })();

        return () => {
            disposed = true;
            term.dispose();
        };
    }, []);

    return <div ref={elemRef} style={{ width: "100vw", height: "100vh" }} />;
}
```

> `resolveTabId()` implements the Step 1 outcome. Use `stringToBase64`/`base64ToArray` from `@/util/util` (CLAUDE.md: never use `btoa`/`atob`). Confirm the exact `getFileSubject` signature and `WSFileEventData` shape against `termwrap.ts:412,479` during wiring.

- [ ] **Step 4: Observe-gate — PTY runs, WebGL active, resize reflows (spec §8 criteria 2,4,5)**

Run (from project root): `cargo tauri dev`
Expected:
- A terminal renders and shows a shell prompt.
- Typing `dir` and Enter shows real directory output.
- Console logs `[harness] webgl active: true` and no webgl-fallback warning (criterion 4).
- Resizing the window reflows the terminal and the prompt re-wraps correctly (criterion 5).

- [ ] **Step 5: Commit** (await approval)

```bash
git add frontend/tauri/terminal-harness.tsx
git commit -m "feat(tauri): run a real pty in xterm via block controller"
```

---

## Task 7: Full verification gate (spec §8)

**Files:** none (verification only).

- [ ] **Step 1: Run the complete gate**

Run (from project root): `cargo tauri dev`. Confirm ALL five criteria from spec §8:
1. Window opens with a terminal.
2. `dir`/`ls` shows real PTY output from `wavesrv`.
3. ws authenticated via the **query-param** path — `wavesrv` log shows accepted `/ws`, no `X-AuthKey` header, no auth error.
4. xterm **WebGL renderer active** (`[harness] webgl active: true`, no fallback).
5. Resize reflows the PTY.

- [ ] **Step 2: Record results in the spec's decision log**

Append a short "Phase 0 result" note to `docs/superpowers/specs/2026-06-24-tauri-phase0-spike-design.md` capturing: pinned Tauri version, the `tabid` source used, and any surprises (especially WebGL behavior, the `window.api` reached-set, and the stream/parse). This closes the meta spec §10 "Tauri version" open question and informs Phase 1.

- [ ] **Step 3: Commit** (await approval)

```bash
git add docs/superpowers/specs/2026-06-24-tauri-phase0-spike-design.md
git commit -m "docs(migration): record Tauri Phase 0 spike results"
```

---

## Self-Review (author checklist — completed)

- **Spec coverage:** §2.1 render scope → Tasks 2,6; §4 boot handshake → Tasks 3,4; §5 authkey → Tasks 1,5; §6 terminal path → Task 6; §7 dev loop + version pin → Tasks 2,4; §8 success criteria → Tasks 6,7. All spec sections map to a task.
- **Placeholder scan:** the two recorded blanks (Tauri version in Task 2.1; tabid source in Task 6.1) are deliberate runtime-discovered values the executor fills in — flagged by the spec (§6, §7) and the meta spec's build-observe-fix model, not vague TODOs. The `Arc`/`State` note in Task 4.3 names the exact change and its guard (the compiler).
- **Type consistency:** `InitData` (Rust, camelCase serde) ↔ `InitData` (TS) match; `get_init` command name matches the `invoke("get_init")` call; `CreateBlockCommand`/`ControllerResyncCommand`/`ControllerInputCommand` signatures match `gotypes.d.ts` (`CommandCreateBlockData.tabid`, `CommandControllerResyncData.{tabid,blockid,rtopts}`, `CommandBlockInputData.{blockid,inputdata64,termsize}`); `buildWsConnUrl` named identically in helper, test, and `ws.ts` use.
