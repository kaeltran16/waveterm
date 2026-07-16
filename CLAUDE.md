# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project status

Wave Terminal — an open-source, AI-native terminal. This fork has **migrated the desktop shell from Electron to Tauri** and is pivoting toward an agent-cockpit UI. `main` is the Tauri build; the original Electron shell was removed from `main` and preserved on the `legacy/electron` branch.

Consequences that matter while working here:
- **`BUILD.md` is stale** (Electron-era). It references `task start`, `task package`, and electron-builder — none of which exist anymore. Trust the Taskfile and this file, not `BUILD.md`, for run/build flow.
- Tauri packaging is currently **Windows-only** (`cargo tauri build` → NSIS; bundles `wavesrv.x64.exe` + `wsh-*-windows.x64.exe`).

## Build & dev commands

The build is orchestrated by [Task](https://taskfile.dev) (`Taskfile.yml`), a `make` replacement. Tasks chain Go, Rust, and npm steps.

| Command | What it does |
|---|---|
| `task init` | First-time setup: `npm install` + `go mod tidy` + docs `npm install`. |
| `task dev` (alias of `task tauri:dev`) | The main way to run. Builds backend, then `cargo tauri dev` (Vite dev server on `:5174`, HMR). |
| `task build:backend` | Builds `wavesrv` + `wsh` into `dist/bin/`. |
| `task generate` | Regenerates TS + Go bindings from Go source. **Run after changing any wshrpc / waveobj / wconfig type.** |
| `task check:ts` | Typecheck the frontend (but see the tsc gotcha below). |
| `npm test` / `npx vitest` | Frontend unit tests (vitest). |
| `npm run build` | Production build = `cargo tauri build`. |
| `task preview` | Standalone component preview server (no backend, no shell). |

Other useful commands:
- **Single frontend test:** `npx vitest run frontend/app/view/agents/projectname.test.ts` or filter by name: `npx vitest run -t "parses estart"`.
- **Go tests:** `go test ./pkg/...` (or a single package, e.g. `go test ./pkg/agentask/`).
- **Rust tests:** `cargo test --manifest-path src-tauri/Cargo.toml`.
- **Clear dev data/config:** `task dev:cleardata`, `task dev:clearconfig` (dev app uses `waveterm-dev` data dirs, isolated from a packaged install).

### Gotchas
- **`npx tsc` stack-overflows on this repo.** Run the typechecker as `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` instead. The baseline is clean (exit 0) — any error it reports is yours.
- **Never hand-edit generated files.** Go is the source of truth for the wire protocol and object types; `task generate` produces `frontend/app/store/wshclientapi.ts` and the generated Go/TS type files. Edit the Go definitions, then regenerate.
- CGO backend builds use the **zig** compiler for cross/static linking (required dependency, see `Taskfile.yml` `build:server:*`).

### Visual verification (dev)
There is no jsdom/render-test harness for the cockpit — verify rendered UI by screenshotting the **live dev app** over the Chrome DevTools Protocol. Tauri renders through WebView2 (Chromium/Edge on Windows), which speaks CDP.
- **Enable:** `src-tauri/src/main.rs` sets `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222`, gated by `#[cfg(debug_assertions)]` (compiled out of `cargo tauri build` — never ships). `cargo tauri dev` watches `src-tauri/`, so the flag activates on the next dev rebuild.
- **Capture:** `node scripts/cdp-shot.mjs [out.png]` — discovers the page target on `:9222` and writes a PNG (the page is the Vite app inside WebView2, `http://localhost:5174/`). The same attach pattern drives full CDP (`Runtime.evaluate` to read the DOM / jotai atoms, `Input.dispatchKeyEvent` for keys). `claude-in-chrome` MCP can't attach (needs Chrome + extension) — use raw CDP.
- **Inject test data first** if you need a populated cockpit: `node scripts/inject-live-agents.mjs <scenario>` (see that script's header).

## Architecture

Three layers, all part of the running app.

### 1. Tauri shell — Rust (`src-tauri/`)
Thin native host that replaces the Electron main process. `main.rs` mints a per-launch UUID auth key and **spawns `wavesrv` as a child process**, passing `WAVETERM_AUTH_KEY`, `WAVETERM_APP_PATH`, `WAVETERM_DATA_HOME`, `WAVETERM_CONFIG_HOME` via env. It then **parses the `WAVESRV-ESTART` line off wavesrv's stderr** (`estart.rs`) to discover the dynamically-assigned websocket/web ports. The frontend reaches native code through a small set of Tauri commands (`commands.rs`: `get_init`, `fe_log`, `set_window_init_status`, `set_is_active`, `open_external`, `increment_term_commands`). Window is borderless (`decorations: false`) — the titlebar is drawn in React.

Migration principle (from prior phases): don't re-port Electron-IPC-shaped contracts; build the Tauri-native primitive and let the old method die.

### 2. Go backend (`cmd/`, `pkg/`)
- **`wavesrv`** (`cmd/server`) — the main backend process: SQLite-backed object store, an HTTP server (`pkg/web`) for service calls, and a websocket for RPC.
- **`wsh`** (`cmd/wsh`) — the CLI helper binary (cobra-based) that ships inside terminals and gets copied to remote hosts; it talks back to `wavesrv` over wshrpc. `wavesrv` locates it via `WAVETERM_APP_PATH`.
- Other `cmd/*` are codegen (`generatets`, `generatego`, `generateschema`) and test harnesses.

Key packages:
- **`pkg/wshrpc`** — the unified, typed RPC system spanning frontend ↔ wavesrv ↔ wsh ↔ remote. `wshrpctypes.go` is the single command interface; `wshserver` implements commands, `wshclient` is the typed client, routing is by route IDs (`wshrouter`). **This is the spine of the app — most cross-process behavior is a wshrpc command.**
- **`pkg/service`** — HTTP-callable backend services (`clientservice`, `windowservice`, `workspaceservice`, `objectservice`, `blockservice`, `userinputservice`), reached from the FE via `callBackendService` (a `fetch`, used during early boot before the websocket is up).
- **`pkg/waveobj` + `pkg/wstore`** — the ORef-addressed object model (client/window/workspace/tab/layout/block) persisted in SQLite and mirrored to the frontend.
- Others: `aiusechat` (Wave AI / LLM chat), `agentask` (agent-cockpit ask protocol — note: multi-answer is gated **server-side** in `encode.go`), `remote/conncontroller` + `wsl` (durable SSH/WSL connections), `blockcontroller` (terminal/block processes), `filestore`, `secretstore`, `telemetry`, `wconfig` (config + JSON schema).

### 3. Frontend — React 19 + Vite + Tailwind 4 + jotai (`frontend/`)
The **Tauri cockpit (`frontend/tauri/main.tsx`) is the sole shipping frontend** (the Electron entry was removed in the Phase 5b teardown). Path aliases: `@/app`, `@/store`, `@/util`.

**Boot flow** (`frontend/tauri/main.tsx`):
1. `invoke("get_init")` → fetch `InitData` (endpoints, auth key, identity) from Rust.
2. `installTauriApi(init)` — builds `window.api` (an `ElectronApi`-shaped shim over Tauri `invoke`/`listen`; unimplemented methods are typed benign stubs).
3. `resolveBootIds()` — HTTP calls to the Go services to find the client/window/workspace/tab IDs (Electron used to supply these via IPC).
4. `bootWaveCore()` (`frontend/app/boot/boot-core.ts`) — connects the wshrpc **websocket** on the tab route, inits `GlobalModel` + jotai atoms, pins the client/window/tab/workspace objects via WOS, loads config.
5. Renders `<CockpitRoot/>`.

Frontend structure:
- **`frontend/app/store/`** — the state + IPC core: jotai atoms (`global-atoms`, `global`), `GlobalModel`, the wshrpc client plumbing (`wshclient`, `wshclientapi` [generated], `wshrouter`, `wshrpcutil`, `tabrpcclient`), **WOS** (`wos.ts` — `loadAndPinWaveObject`, ORef objects mirrored from Go), `wps` (wave pub/sub events), `keymodel` (keybindings/chords).
- **`frontend/app/cockpit/`** — the cockpit shell (`cockpit-root`, `focus-pane`, `titlebar`). A focused single-pane UI that replaces the old multi-tab/multi-block window.
- **`frontend/app/view/`** — block view types (`term`, `preview`, `codeeditor`, `sysinfo`, `vdom`, …). **`view/agents/`** is the heavily-developed agent-cockpit tab (live transcript narration, ask-in-place, timeline collapse, list/focus keyboard triage). It surfaces external Claude Code agents driven by hooks/reporters that live **outside this repo** (under `~/.claude`); see `docs/agents/`.
- `frontend/layout` (tiling layout engine, kept from upstream), `frontend/app/element` + `shadcn` (UI primitives).

## Design docs
Specs and plans live in `docs/superpowers/specs/` and `docs/superpowers/plans/` (the Tauri migration phases and agents-tab work are documented there). Agent-cockpit integration notes are in `docs/agents/`.
