# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project status

Wave Terminal — an open-source, AI-native terminal. This fork has **migrated the desktop shell from Electron to Tauri** and is pivoting toward an agent-cockpit UI. `main` is the Tauri build; the original Electron shell was removed from `main` and preserved on the `legacy/electron` branch.

Consequences that matter while working here:

- The upstream Electron-era docs are **gone** (2026-07-31 cleanup): `BUILD.md`, `CONTRIBUTING.md`, `RELEASES.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, the whole Docusaurus site under `docs/`, and `aiprompts/` were deleted; `README.md` was rewritten for Arc. Trust the Taskfile and this file for run/build flow. `docs/README.md` maps what remains.
- Tauri packaging is currently **Windows-only** (`cargo tauri build` → NSIS; bundles `wavesrv.x64.exe` + `wsh-*-windows.x64.exe`).
- Electron-era files still on disk but **not loaded by the cockpit**: `electron.vite.config.ts`, `frontend/app/app.scss`, `frontend/app/theme.scss`. The cockpit's only stylesheet entry is `frontend/tauri/tailwind.css` → `frontend/tailwindsetup.css`.

## Build & dev commands

The build is orchestrated by [Task](https://taskfile.dev) (`Taskfile.yml`), a `make` replacement. Tasks chain Go, Rust, and npm steps.

| Command | What it does |
|---|---|
| `task init` | First-time setup: `npm install` + `go mod tidy`. |
| `task dev` (alias of `task tauri:dev`) | The main way to run. Builds backend, then `cargo tauri dev` (Vite dev server on `:5174`, HMR). |
| `task build:backend` | Builds `wavesrv` + `wsh` into `dist/bin/`. |
| `task generate` | Regenerates TS + Go bindings from Go source. **Run after changing any wshrpc / waveobj / wconfig type.** |
| `npm test` / `npx vitest` | Frontend unit tests (vitest). |
| `npm run build` | Production build = `cargo tauri build`. Requires `task build:backend` first. |
| `task preview` | Standalone component preview server (no backend, no shell). |
| `npm run cockpit:fixtures` | Regenerate the cockpit fixture data under `scripts/cockpit-fixtures/`. |

Other useful commands:

- **Single frontend test:** `npx vitest run frontend/app/view/agents/projectname.test.ts`, or filter by name: `npx vitest run -t "parses estart"`.
- **Rust tests:** `cargo test --manifest-path src-tauri/Cargo.toml`.
- **Lint / format:** flat ESLint config (`eslint.config.js`) + Prettier (`prettier.config.cjs`), but **no Task/npm wrapper** — run `npx eslint .` and `npx prettier --check .` directly. The config still references removed `emain/` (Electron) — dead; ignore. The phantom `tsunami/frontend` and `docs` npm workspaces were removed 2026-07-31.
- **Clear dev data/config:** `task dev:cleardata`, `task dev:clearconfig` (dev app uses `waveterm-dev` data dirs, isolated from a packaged install).

### Gotchas

- **`npx tsc` stack-overflows on this repo** — which means **`task check:ts` is broken** (it just runs `npx tsc --noEmit`). Typecheck with `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` instead. The baseline is clean (exit 0) — any error it reports is yours.
- **Bare `go test ./pkg/...` fails to *build* 6 packages** (`jarvisembed` + its dependents `jarvisattrib`, `jarvisproactive`, `jarvisrecall`, `web`, `wshrpc/wshserver`) with `sqlite-vec.h: fatal error: sqlite3.h: No such file or directory`. CGO needs the vendored header in `pkg/jarvisembed/csrc`, and the `-I` path must be **Windows-style** — a Git-Bash POSIX path (`/c/Users/...`) silently fails with the identical error. From PowerShell at the repo root:
  ```powershell
  $env:CGO_CFLAGS = "-O2 -g -I$((Get-Location).Path -replace '\\','/')/pkg/jarvisembed/csrc"
  go test ./pkg/...
  ```
  `task build:backend` sets this itself (`build:server:internal`) and needs no setup.
- **Never hand-edit generated files.** Go is the source of truth for the wire protocol and object types; `task generate` produces `frontend/app/store/wshclientapi.ts` and the generated Go/TS type files. Edit the Go definitions, then regenerate.
- **A new registered `waveobj` type needs a SQL migration** in `db/migrations-wstore/NNNNNN.{up,down}.sql`, or it fails at runtime with "no such table".
- CGO backend builds use the **zig** compiler for cross/static linking (required dependency, see `Taskfile.yml` `build:server:*`).

### Visual verification (dev)

There is no jsdom/render-test harness for the cockpit — verify rendered UI by screenshotting the **live dev app** over the Chrome DevTools Protocol. Tauri renders through WebView2 (Chromium/Edge on Windows), which speaks CDP.

- **Enable:** `src-tauri/src/main.rs` sets `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222`, gated by `#[cfg(debug_assertions)]` (compiled out of `cargo tauri build` — never ships). `cargo tauri dev` watches `src-tauri/`, so the flag activates on the next dev rebuild.
- **Capture:** `node scripts/cdp-shot.mjs [out.png]` — discovers the page target on `:9222` and writes a PNG (the page is the Vite app inside WebView2, `http://localhost:5174/`). The same attach pattern drives full CDP (`Runtime.evaluate` to read the DOM / jotai atoms, `Input.dispatchKeyEvent` for keys). `claude-in-chrome` MCP can't attach (needs Chrome + extension) — use raw CDP.
- **Scenario harness:** `task verify:ui -- <name...>` (→ `scripts/cdp/verify.mjs`) runs each scenario in `scripts/cdp/scenarios.mjs` as arrange → goto → shot → assert → teardown, prints a PASS/FAIL table, writes a contact sheet to `cdp-shots/index.html`, and exits nonzero on failure. Prefer this over ad-hoc `cdp-shot.mjs` when a repeatable check exists; shared attach logic is in `scripts/cdp/attach.mjs`.
- **Inject test data first** if you need a populated cockpit: `node scripts/inject-live-agents.mjs <scenario>` (see that script's header).

## Architecture

Three layers, all part of the running app.

### 1. Tauri shell — Rust (`src-tauri/`)

Thin native host that replaces the Electron main process. `main.rs` mints a per-launch UUID auth key and **spawns `wavesrv` as a child process**, passing `WAVETERM_AUTH_KEY`, `WAVETERM_APP_PATH`, `WAVETERM_DATA_HOME`, `WAVETERM_CONFIG_HOME` via env. It then **parses the `WAVESRV-ESTART` line off wavesrv's stderr** (`estart.rs`) to discover the dynamically-assigned websocket/web ports. The frontend reaches native code through six Tauri commands only (`init.rs`: `get_init`, `fe_log`; `commands.rs`: `set_window_init_status`, `set_is_active`, `open_external`, `increment_term_commands`). The window is borderless (`decorations: false`) — the titlebar/app-bar is drawn in React.

Migration principle (from prior phases): don't re-port Electron-IPC-shaped contracts; build the Tauri-native primitive and let the old method die.

### 2. Go backend (`cmd/`, `pkg/`)

- **`wavesrv`** (`cmd/server`) — the main backend process: SQLite-backed object store, an HTTP server (`pkg/web`) for service calls, and a websocket for RPC.
- **`wsh`** (`cmd/wsh`) — the CLI helper binary (cobra-based) that ships inside terminals and gets copied to remote hosts; it talks back to `wavesrv` over wshrpc. `wavesrv` locates it via `WAVETERM_APP_PATH`. **Agents report into the cockpit through `wsh`**, so if it isn't on PATH in a spawned shell the cockpit stays empty.
- Other `cmd/*` are codegen (`generatets`, `generatego`, `generateschema`) and test harnesses.

**`pkg/wshrpc` is the spine** — the unified, typed RPC system spanning frontend ↔ wavesrv ↔ wsh ↔ remote. Nearly all cross-process behavior is a wshrpc command. `WshRpcInterface` (in `wshrpctypes.go`) is now **composed from per-domain interfaces** split across `wshrpctypes_*.go` (`_runs`, `_channels`, `_jarvis`, `_memory`, `_radar`, `_agents`, `_ask`, `_jobs`, `_projects`, `_blocks`, `_conn`, `_file`, `_secrets`, `_vdom`); `wshserver/wshserver_*.go` implements them file-per-domain, `wshclient` is the typed client, routing is by route IDs (`wshrouter`).

Other core packages:

- **`pkg/service`** — HTTP-callable backend services (`clientservice`, `windowservice`, `workspaceservice`, `objectservice`, `blockservice`, `userinputservice`), reached from the FE via `callBackendService` (a `fetch`, used during early boot before the websocket is up).
- **`pkg/waveobj` + `pkg/wstore`** — the ORef-addressed object model (client/window/workspace/tab/layout/block, plus cockpit types like `Run`) persisted in SQLite and mirrored to the frontend.
- **`blockcontroller`** (terminal/block processes), **`jobcontroller`/`jobmanager`** (background job processes), `remote/conncontroller` + `wsl` (durable SSH/WSL connections), `filestore`, `secretstore`, `telemetry`, `wconfig` (config + JSON schema).
- **`aiusechat`** — upstream Wave AI (direct LLM API chat), still wired into `pkg/web` + `wshserver`. The cockpit's own conversational surfaces do **not** use it; they go through `pkg/consult` (headless CLI agents). The standalone WaveAI chat block is orphaned and a documented cleanup candidate (`docs/superpowers/plans/2026-07-13-backend-legacy-cleanup.md`).

Cockpit-specific backend domains (all newer than the Electron→Tauri migration):

- **Runs / Channels** (`wshrpctypes_runs.go`, `pkg/consult`) — the orchestration model. A `Run` is a goal executed in phases (`quick | pipeline | orchestrator`); `CreateRunCommand` spawns phase-1's worker tab, `AdvanceRunCommand` completes a phase or resolves a gate (approve/sendback/triage) and spawns the next, `CreateChildRunCommand` lets an orchestrator lead fan out child runs. `pkg/consult` runs one-shot headless CLI agents (`claude -p`, `codex exec`, `agy -p`) behind the Channels "ask @runtime" gesture.
- **Radar** (`pkg/reporadar`) — repo scanning that produces findings, which can be turned into Runs and get outcome written back.
- **Jarvis second brain** (`pkg/jarvis*`) — conversation backend plus dossiers (`jarvisdossier`), recall (`jarvisrecall`), embeddings over sqlite-vec (`jarvisembed`), attribution (`jarvisattrib`), continuity (`jarviscontinuity`), proactive resurfacing (`jarvisproactive`), capture-on-dispatch (`jarviscapture`).
- **Memory / vault** (`pkg/memvault`, `memroots`, `memgarden`, `memdistill`, `pkg/wavevault`) — the durable-knowledge store: `memroots` is the single registry of vault locations, `memvault` owns archive/restore (no hard delete), `memgarden` the decay/prune rules, `memdistill` the learning pipeline.
- **Scanners** (`pkg/usagestats`, `pkg/agentsessions`, `pkg/gitinfo`, `pkg/bgagents`) — read-only readers over on-disk agent transcript JSONL, git state, and `claude agents --json` that feed the Usage / Sessions / Files surfaces.
- **`pkg/agentask`** — the agent-cockpit ask protocol. Note that multi-answer is gated **server-side** in `encode.go`.

### 3. Frontend — React 19 + Vite + Tailwind 4 + jotai (`frontend/`)

The **Tauri cockpit (`frontend/tauri/main.tsx`) is the sole shipping frontend** (the Electron entry was removed in the Phase 5b teardown). Path aliases: `@/app`, `@/store`, `@/util`.

**Boot flow** (`frontend/tauri/main.tsx`):

1. `invoke("get_init")` → fetch `InitData` (endpoints, auth key, identity) from Rust.
2. `installTauriApi(init)` — builds `window.api` (an `ElectronApi`-shaped shim over Tauri `invoke`/`listen`; unimplemented methods are typed benign stubs).
3. `resolveBootIds()` — HTTP calls to the Go services to find the client/window/workspace/tab IDs (Electron used to supply these via IPC).
4. `bootWaveCore()` (`frontend/app/boot/boot-core.ts`) — connects the wshrpc **websocket** on the tab route, inits `GlobalModel` + jotai atoms, pins the client/window/tab/workspace objects via WOS, loads config.
5. Renders `<CockpitRoot/>`.

**The cockpit is one window with N surfaces, not tabs.** `CockpitRoot` (`frontend/app/cockpit/cockpit-root.tsx`) constructs a single long-lived `AgentsViewModel` (`view/agents/agentsviewmodel.ts` — the shared model that nearly every surface reads) and renders `CockpitShell` (`view/agents/cockpitshell.tsx`), which switches on `model.surfaceAtom`. `SURFACE_ORDER` (`view/agents/agents.tsx`) is cockpit, jarvis, agent, radar, sessions, files, memory, usage — ordered to match the NavRail so `Ctrl+1..8` line up with what the user sees; `settings` is a ninth `SurfaceKey` deliberately outside that order. Two consequences:

- **Only the Agent surface stays mounted** when off-screen (hidden via `display:none`, so its live xterm is never torn down and re-fitted at a stale size). Every other surface unmounts on switch — surface-local `useState` is lost, so persist anything survival-worthy in a per-entity jotai atom.
- Cross-surface concerns (pending-launch pruning, ask-draft reset, channel priming) live in the always-mounted shell, not in a surface.

Frontend structure:

- **`frontend/app/store/`** — the state + IPC core: jotai atoms (`global-atoms`, `global`), `GlobalModel`, the wshrpc client plumbing (`wshclient`, `wshclientapi` [generated], `wshrouter`, `wshrpcutil`, `tabrpcclient`), **WOS** (`wos.ts` — `loadAndPinWaveObject`, ORef objects mirrored from Go), `wps` (wave pub/sub events), and keybindings (`keybindings/` — matcher, dispatcher, g-leader chords; `keymodel.ts` is the older layer).
- **`frontend/app/cockpit/`** — window chrome + global overlays: `cockpit-root`, `app-bar`, `command-palette`, `hints-footer`, `shortcuts-cheatsheet`.
- **`frontend/app/view/agents/`** — by far the largest area (~240 files): the surfaces themselves plus their stores. It surfaces external Claude Code / Codex agents driven by hooks/reporters that live **outside this repo** (under `~/.claude`); see `docs/agents/`.
- **`frontend/app/view/jarvis/`** — the Jarvis second-brain surface (stage, subjects column, graph, dossier/record threads, profile).
- Remaining `frontend/app/view/` entries are just `term`, `codeeditor`, `aifilediff`, `vdom` (upstream `preview`/`sysinfo` are gone).
- **`frontend/app/waveenv/`** — the DI seam: `WaveEnv` bundles rpc/atoms/wos/services so models can be constructed against a mock in tests (`mockboundary.tsx`).
- `frontend/layout` (tiling layout engine, kept from upstream), `frontend/app/element` + `shadcn` (UI primitives).

### Frontend conventions

- **Testable logic is extracted, not rendered.** The pattern throughout `view/agents` and `view/jarvis` is a pure `foo.ts` (derive/model/reducer) with a `foo.test.ts` beside it, consumed by a thin `foo.tsx`. There are deliberately **no jsdom render/snapshot tests** — "does it render" is covered by the CDP `surface-smoke` scenario. When wiring is risky, extract it to a model and unit-test that.
- **Colors come from `@theme` tokens in `frontend/tailwindsetup.css`** — never raw hex/rgba in components. Runtime theming (`view/agents/themes.ts` + `themestore.ts`) works by overriding those same `--color-*` custom properties on `document.documentElement`, so a hardcoded color silently opts out of every theme.
- Prefer Tailwind over new SCSS.

## Design docs

- Specs and plans: `docs/superpowers/specs/` and `docs/superpowers/plans/` (paired, date-prefixed — the Tauri migration phases, the Jarvis second-brain sub-projects, agents-tab work). Standalone briefs and meta-specs: `docs/superpowers/briefs/`.
- Live issue trackers: `docs/open-issues.md`, `docs/jarvis-*-open-issues.md`. `docs/README.md` maps the rest of `docs/`.
- Deliberately-deferred items and fabricated placeholder data: `docs/deferred.md`.
- Agent-cockpit integration notes (hooks, ask protocol, usage reporting): `docs/agents/`.
