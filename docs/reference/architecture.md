# Architecture reference

Extracted from the repo-root `CLAUDE.md` so it is read on demand rather than loaded into every
agent turn. `CLAUDE.md` keeps the rules and gotchas; this file is the descriptive map.

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

**The cockpit is one window with N surfaces, not tabs.** `CockpitRoot` (`frontend/app/cockpit/cockpit-root.tsx`) constructs a single long-lived `AgentsViewModel` (`view/agents/agentsviewmodel.ts` — the shared model that nearly every surface reads) and renders `CockpitShell` (`view/agents/cockpitshell.tsx`), which switches on `model.surfaceAtom`. `SURFACE_ORDER` (`view/agents/agents.tsx`) is cockpit, jarvis, agent, radar, sessions, files, vault, usage, code — ordered to match the NavRail so `Ctrl+1..9` line up with what the user sees; `settings` is a tenth `SurfaceKey` deliberately outside that order. Two consequences:

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
