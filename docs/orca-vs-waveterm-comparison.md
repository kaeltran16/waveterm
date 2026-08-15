# WaveTerm vs Orca — End-to-End Technical Comparison

**Source material:** two read-only research reports produced from the actual codebases — waveterm at `v0.14.5` (`C:/Users/cktra/Projects/waveterm`) and orca at `1.4.178-rc.2`, HEAD `5b7f44278a` (2026-08-15) (`C:/Users/cktra/Projects/orca`). Every mechanism named below is cited from those reports. Where a report is silent I mark **not covered**.

---

## 1. TL;DR — 12 one-liner differences

1. **Shell layer:** waveterm is a **Tauri 2 (Rust + WebView2)** shell that spawns a **Go backend (`wavesrv`)** child process; orca is a **monolithic Electron 43** app (Node main + Chromium renderer). Neither proxies model traffic — both drive the user's own local agent CLIs.
2. **UI↔core IPC:** waveterm's React cockpit talks to Go over **WebSocket + HTTP** through one typed RPC spine (`pkg/wshrpc`); orca's renderer talks to its main process over **Electron IPC** (`contextBridge` preload, ~46 sub-APIs) plus PTY byte streams.
3. **Type sync:** waveterm generates TS clients/types and the Go client **from one reflection pass over `WshRpcInterface`** (`task generate`); orca keeps a **hand-audited `PreloadApi` shared type** + `src/shared` contracts — no codegen for IPC.
4. **Isolation model:** orca isolates every agent in **its own linked git worktree** (branch lineage, per-worktree `HISTFILE`); waveterm runs agents as **background cmd-worker tabs** inside one workspace behind a typed Run/Phase state machine.
5. **Orchestration:** waveterm = plan-gated runs with `brainstorm → plan(gate) → execute` playbooks, orchestrator/child-run protocol with one-line `[jarvis] child` notifications, self-report via `wsh jarvis complete`, pure `recomputeStatus`; orca = durable **Run/Task/Dispatch** layer with a control-mail inbox, group addresses (`@all`, `@claude`, `@worktree:<id>`), **DAGs with deps**, decision gates, and cross-server **federation**.
6. **Terminal:** waveterm = one full-size xterm for the focused agent (WebGL addon), server-side blockfile scrollback; orca = **infinite split panes**, WebGL with GPU-context recovery, a **daemon-owned PTY process that survives app quit**, and server-side **headless-emulator scrollback replay** from ANSI checkpoints.
7. **Agent breadth:** waveterm supports **4 local CLIs** (pi, claude, codex, opencode) + an OpenRouter API consult backend; orca detects **~45 agent CLIs** with per-agent launch strategies (`TUI_AGENT_CONFIG`) and quirk tables.
8. **Second brain:** waveterm ships a deep memory stack (memvault Note+Edge graph from wikilink markdown, memdistill background distiller, memgarden dedup/decay, jarvisrecall semantic retrieval on a **sqlite-vec embedding index**, dossier decisions log, attention aggregator); orca's report covers a thinner surface (store `memory` slice, `aiVault` handlers) — internals **not covered**.
9. **Mobile/remote:** orca has a **full mobile app** (E2EE pairing via tweetnacl, native chat, tasks, dictation), an **SSH relay daemon** with credit-based flow control, **headless `orca serve`**, a **web client**, and cross-version wire-compatibility tests; waveterm has SSH/WSL remote shells but the report covers **no mobile or headless surface**.
10. **Scale/maturity:** orca ≈ **2.65M TS lines / 12,446 files / ~5,829 test files** with ~30 CI workflows; waveterm v0.14.5 is a **mid-migration fork** with Electron-era legacy code (block/term surfaces) coexisting with the new cockpit.
11. **Failure-mode engineering:** orca treats byte loss, renderer reloads, and quit races as first-class (PTY delivery credits/acks, watchdogs, crash breadcrumbs, daemon fallback, GPU crash tracker); waveterm's strengths are process hygiene (Windows **kill-on-close job object**, ESTART handshake, `CREATE_NO_WINDOW`, `CancelRequestsForLink` on WS drop) and ctx-cancellation.
12. **Design discipline:** waveterm = tokens-only `@theme` palette (Tailwind 4) with **golden-tested Midnight theme** and prototype-first mockup workflow; orca = ~3,000-line canonical `main.css` + shadcn/Radix component layer with a `STYLEGUIDE.md` and CVA/`data-slot` conventions.

---

## 2. What each product is

**WaveTerm** (positioning): an "AI-native terminal" — a desktop shell that runs the user's real agent CLIs in real ptys, shows the actual TUI, and layers a cockpit on top: an agent card grid, a channels/runs surface, a second brain (vault + memory), a code-review radar, usage donuts, and a pet. Target user: a single developer who wants a terminal that is also an agent cockpit and a durable knowledge ledger. Maturity: `v0.14.5`, explicitly mid-migration from an Electron fork (the Tauri bridge is partial — `set_is_active`/`increment_term_commands` are declared but empty "Phase 1: acknowledge only" stubs; `installStubs` like `getDataDir`/`captureScreenshot` warn-and-return-default). Windows-first today (`wavesrv.x64.exe`, `CREATE_NO_WINDOW`, job objects, WebView2 CDP on `:9222`).

**Orca** (positioning): "The AI Orchestrator for 100x builders" — an Electron IDE that runs Codex, Claude Code, OpenCode, Pi, and 20+ other CLI agents **side-by-side, each in its own git worktree**, tracked in one app, with orchestration (dispatch/DAG/gates), mobile companion, SSH relay, and headless server. Target user: a builder running many parallel agent sessions with strong isolation, remote execution, and phone access. Maturity: `1.4.178-rc.2`, a very large, heavily tested codebase that nonetheless ships prototype/legacy surface in-tree (`ActivityPrototypePage`, `legacy-worker-terminal-recovery`, mobile protocol aliases shim).

---

## 3. UI/UX comparison

### 3.1 Shell and chrome

**waveterm** — boot in `frontend/tauri/main.tsx` (`invoke("get_init")`, `installTauriApi`, `resolveBootIds`, `bootWaveCore` → `<CockpitRoot />`). The whole cockpit is one tree in `frontend/app/cockpit/cockpit-root.tsx`: `CockpitAppBar`, `CockpitShell`, `HintsFooter`, `NewProjectModal`, `NewAgentModal`, `CommandPalette`, `ShortcutsCheatSheet`, `PetView`, `ModalsRenderer`, `ContextMenuHost`, `NotificationToasts`, plus mounted pollers (`NowTicker`, `BackgroundAgentsPoller`, `AttentionPoller`, `PetDecayPoller`). A fixed 46px `app-bar.tsx` (`data-tauri-drag-region`) + a 78px `navrail.tsx` (56px narrow) with icon badges and Ctrl+1..9 surface chords.

**orca** — single React app (`main.tsx` → `App.tsx`) with 3-region chrome in `app-shell/`: left **worktree sidebar** (`Sidebar.tsx`), **titlebar strip** (`TitlebarMainStrip.tsx`, `TitlebarLeftControls.tsx`, `WindowControls.tsx`), active page area. Overlays in `AppRootSurfaces.tsx` (onboarding gate, quick open, dialogs, floating workspace panel, zoom overlay). Page routing via `activeView` in the store's `ui` slice (`useAppChromeLayout.ts`). The sidebar shows per-worktree rows (branch, status dots, unread state, agent badges), repo grouping, tabs, and a cmdk-based quick-open jump palette. A **right sidebar** (route in `right-sidebar-route.ts`) hosts file explorer, source control (git status/diff/staging), markdown, browser, ports, notes panels. Onboarding is a multi-step wizard (`AgentStep`, `IntegrationsStep`, `OnboardingInlineCommandTerminal`).

### 3.2 Surfaces / pages

| waveterm (9–10 surfaces, `SurfaceKey`/`SURFACE_ORDER` in `view/agents/agents.tsx`) | orca (active pages from `AppWorkspaceShell.tsx`) |
|---|---|
| `cockpit` — agent card grid (`agentrow.tsx`), chip filters all/asking/working/idle, background-agents strip, idle section, project switcher, space banner | `terminal` — main worktree/agent-session view, tab bar + split panes (`TerminalWorkbenchContainer.tsx`) |
| `jarvis` — three-pane second brain: `SubjectsColumn` + `Stage` + `StageRail` overlay; channels, records (runs), threads, graph overlay | `landing` — first-run/feature wall |
| `agent` — focused agent's **real TUI** (`CockpitFocusPane`), `AgentTree` roster, `AgentDetailsRail` (toggle `d`), `SubagentInterior` | `tasks` — GitHub/Linear/Jira work-item board (`TaskPage.tsx`) |
| `radar` — automated code-review findings + detail + scan state | `automations` — `AutomationsPage.tsx` |
| `sessions` — archived sessions feed + agent transcripts | `activity` — explicitly a **prototype** page in production |
| `files` — git diff surface between commits | `artifacts` — `ArtifactsPage.tsx` |
| `usage` — token/cost donuts + daily/weekly charts | `space` — disk-space analysis (`WorkspaceSpacePage.tsx`) |
| `memory` — vault notes graph (`memgraph.tsx`), notes list, prune queue | `mobile` — mobile companion pairing/setup |
| `code` — legacy source browser/editor | `new-workspace` — worktree creation composer (`NewWorkspaceComposerModal`/`WorktreeCreationPanel`, incl. `--agent` launch, base branch, GitHub/Linear links) |
| `settings` — theme/fonts/memory/harness prefs | `settings` — `Settings.tsx` |

Note: waveterm keeps the **Agent surface mounted-but-hidden** (`display:none`) so the xterm never remounts; other surfaces unmount on switch with state surviving via module-scope jotai atoms. Orca instead keeps multiple terminals alive as **tabs + split panes** simultaneously.

### 3.3 State management

- **waveterm**: one global jotai store (`frontend/app/store/jotaiStore.ts` `globalStore`; `<Provider store={globalStore}>` in cockpit-root). `initGlobalAtoms` in `global-atoms.ts` builds ~19 atoms (`windowIdAtom`, `workspaceIdAtom`, `workspaceAtom`, `fullConfigAtom`, `settingsAtom`, `allConnStatusAtom`, `rateLimitInfoAtom`, …). A `AgentsViewModel` (in `view/agents/agents.tsx`) owns ~40 atoms passed down as a `model` prop (`surfaceAtom`, `agentsAtom`, `liveAgentsAtom`/`liveTerminalsAtom`, `pendingLaunchesAtom`, `focusIdAtom`, `cursorIdAtom`, `orderAtom`, `backgroundedIdsAtom`, `dismissedAtom`, `answerSelAtom`/`answerTextAtom`, `sentIdsAtom`, `railOpenAtom`, `chipFilterAtom`, `projectFilterAtom`, `cardPrefsAtom`, `diffScopeAtom`, palette/modal atoms, …). Per-agent keyed atoms: `Map<string, PrimitiveAtom>` in `session-models/agentstatusstore.ts` and `agentaskstore.ts`. Backend-originated state flows through **WOS** (`wos.ts`) — a per-oref `{value, loading}` cache with a **version-staleness guard** (`if curValue.value.version >= update.obj.version return`).
- **orca**: one giant zustand store `useAppStore` composed from **~45 slices** (`store/slices/`): `repos` (4,030 lines), `worktrees` (+`worktrees-*`), `terminals`/`tabs`, `ui`, `settings`, `editor` (Monaco tabs, branch diff snapshots), `browser`, `ssh`/`runtime-environment-ssh`, `runtime-status`/`runtime-detected-agents`, `agent-status`, `detected-agents`, `github`/`linear`/`jira`/`hosted-review`/`gitlab`, `diffComments`, `rate-limits`/`usage-provider-slices`, `preflight`/`memory`/`stats`/`workspace-space`/`workspace-cleanup`, `keybindings`/`orca-profiles`/`remote-server-updates`/`terminal-quick-command-hosts`. Selectors are a first-class concern (`store/selectors.ts`, a `zustand-selector-fanout` benchmark, `store-listener-census` instrumentation, per-slice selector tests); `window.__store` exposes the store in dev/e2e. Durable state lives in the **Electron main `Store`** (`persistence.ts`) → `userData/orca-data.json` with backups, protected-secret persistence (sentinel substitution + state-hash guard), async writes, quit flush.

### 3.4 Design systems

- **waveterm**: Tailwind v4 `@theme` tokens in `frontend/tailwindsetup.css` — surface ramp (`background #0c0e11` …), ink ramp, edge ramp, accent ramp (`accent #5e9cff` + 50–900), status ramps (`error/asking/warning/working/success` + `-soft`/`askingbg`/`pill`), identity palettes (`avatar-1..6`, `conn-1..8`, `graphlane-1..6`, `rt-claude/codex/opencode/pi/terminal`), motion/rounded/shadow tokens. Runtime theming: `view/agents/themes.ts` `THEMES` (midnight, slate, carbon, nocturne, onedark, monokai, paper) writes `--color-*` CSS-var overrides; `themestore.ts` persists via `atomWithStorage("themePreset")`; `themes.test.ts` golden-tests Midnight == `@theme` literals. Fonts: Hanken Grotesk + JetBrains Mono (`fontutil.ts` `loadFonts()` at boot). Primitives are **hand-rolled** in `frontend/app/element/` (button, toggle, input, modal with focus trap in `modalfocus.ts`, popover, tooltip, segmented, skeleton, errorboundary, `motiontokens.ts`) — **no shadcn**, only a vendored `cn()`. Keybindings: registry in `keybindings/bindings.ts` with Navigate vs Type postures, `leaderatom.ts` (g-leader chords `g h/a/c/r/s/f/m/u/b/,`), `dispatcher.ts`, `listnav.ts`, `matcher.ts`, mirrored in `docs/keyboard-shortcuts.md`.
- **orca**: canonical `src/renderer/src/assets/main.css` (~3,000 lines): `:root`/`.dark` CSS variables + `@theme inline` Tailwind bindings (background/foreground/card/popover/primary/secondary/muted/accent/destructive/border/input/ring, sidebar families, git-decoration-* and git-graph lane colors, terminal-pane-title colors, chart colors, radius scale), Geist variable font, scrollbar classes. Components are **shadcn-style wrappers over Radix** in `components/ui/` (button, dialog, popover, dropdown-menu, context-menu, sheet, tabs, select, tooltip, hover-card, command/cmdk, sonner, collapsible, accordion, scroll-area, slider, switch, checkbox, toggle-group, badge, card, input, label, separator, textarea, color-picker, progress, repo-multi-combobox). Icons: `lucide-react`. Markdown editing via TipTap 3; code editing via Monaco; previews via react-markdown + mermaid + katex + pdfjs. `docs/STYLEGUIDE.md` documents roles/rules; conventions are `cn()` + CVA + `data-slot`.

### 3.5 How agent activity is presented

- **waveterm**: a *narration layer* over the real TUI. `view/agents/livetranscript.ts` opens `StreamAgentTranscriptCommand` (a `responsestream` RPC, 1-year timeout) per visible agent; the server tails the agent's JSONL transcript file with fsnotify (`wshserver/transcript.go`, `transcriptTailer`). Raw lines are projected by runtime-specific **transcript projectors** (`transcriptregistry.ts` → `transcriptprojection.ts` (claude), `codextranscriptprojection.ts`, `opencodetranscriptprojection.ts`, `pitranscriptprojection.ts`) into `liveEntriesByIdAtom`, with `lastActivityByIdAtom` (liveness) and `tasksByIdAtom` (TodoWrite-equivalent tasks). Run cards render as a phase rail (`runworkercard.tsx`: `RunWorkerCard`, `PhaseHistory`, `RunRollup`) and gate/ask cards (`runcards.tsx`: `ReviewGateCard`, `AskCard`, `BlockedCard`, `CancelRunButton`, `CancelSurvivorsCard`, `ShipMarker`, `StartingCard`, `TriageChip`), plus `StatusPill` and `CompactStepper`. Tool calls come from the projection + per-tool `agent:status` hook detail ("editing X", "running cmd"). Approvals are `AskCard`s from `agentaskstore.ts` consuming `agent:ask`. The cockpit-wide "needs you" list (`attentionstore.ts` polling `GetAttentionCommand`) feeds nav badges and the jarvis rail. There is also `PetView` — a purely presentational avatar reading `attentionAtom` and usage atoms.
- **orca**: an agent "session" is a **terminal pane running the agent CLI's real TUI** wrapped in Orca chrome. Streaming PTY bytes flow main→renderer over `pty:data` IPC and render via xterm.js + WebGL addon (`pane-webgl-renderer.ts`, `pane-terminal-output-scheduler.ts`). Hook events (loopback HTTP from the agent CLIs) drive **agent status cards** (working spinner / done / waiting), completion notifications, subagent roster (Claude/Codex), unread badges, dock badge, and `PermissionRequest` → `AgentQuestionIcon` question cards (`resolveTuiAgentPermissionMode` decides YOLO vs ask). The composer supports prompt, follow-up (`AgentSessionContinuationMenuItem`), interrupt, re-attach. A **native chat** surface (`components/native-chat/`) layers streaming answer bubbles, tool summaries, and diffs over the PTY — mirroring what mobile does. **Design mode**: an embedded Chromium browser (`BrowserPane.tsx`, `agent-browser` + `WebContentsView`-based `browser-manager.ts`, `offscreen-browser-backend.ts`) whose `grab-guest-script.ts` injects a grabber — the user clicks an element and the script extracts a bounded payload (selector ≤700 chars, HTML ≤4096, computed styles, accessible name, ancestor path, cropped screenshot data URL), formatted by `GrabConfirmationSheet.tsx::formatGrabPayloadAsText` into prompt context pasted into the composer. **Diff comments** (`components/diff-comments/`) let the user annotate AI diffs and ship comments back to the agent.

---

## 4. Architecture comparison

### 4.1 Process model and layering

**waveterm** (three processes + CLIs):
```
Rust shell (src-tauri) ──spawns──▶ wavesrv (Go)
   │ 6 Tauri commands: get_init, fe_log, set_window_init_status,
   │ set_is_active, open_external, increment_term_commands
   │ env: WAVETERM_AUTH_KEY / APP_PATH / DATA_HOME / CONFIG_HOME
   │ Windows KILL_ON_CLOSE job object guarantees wavesrv dies with app
   ▼
WebView2 (React 19 cockpit) ──WS /ws?stableid= (X-AuthKey)──▶ wavesrv
                          ──HTTP POST /wave/service (WebCallType)──▶ wavesrv
wsh (CLI) ──Unix domain socket + WAVETERM_JWT + AuthenticateCommand──▶ wavesrv
```
Backend lifecycle (`cmd/server/main-server.go`), in order: env → `wshutil.NewWshRouter()` → data dirs → `wavebase.AcquireWaveLock()` (single instance) → `filestore.InitFilestore()` → `wstore.InitWStore()` (SQLite + migrations) → `wcore.EnsureInitialData()` → `wcore.InitMainServer()` (ed25519 JWT) → `createMainWshClient()` → signal handlers/config watcher/telemetry/`blocklogger`/`jobcontroller`/`blockcontroller`/memdistill sweep hooks → two TCP listeners (`web.MakeTCPListener("web")`, `"websocket"`) + Unix socket → ESTART line → `web.RunWebServer`.

**orca** (many processes):
```
Electron main (src/main/index.ts, 3,328 lines; ~120 service modules)
  ├─ preload (4,966 lines) ─ contextBridge 'api' (46 sub-APIs) → renderer React
  ├─ renderer (React, zustand; also built as web client → out/web)
  ├─ src/shared (pure TS shared by main/renderer/CLI/relay/mobile)
  ├─ src/cli  (orca bin → RPC client to runtime over unix socket/WS; orca open launches app)
  ├─ src/relay (standalone Node daemon deployed to SSH hosts; framed JSON-RPC over stdio)
  ├─ PTY provider daemon (separate process owning PTYs; survives app quit; checkpointing)
  ├─ plugin host process; STT worker thread (sherpa-onnx); headless serve mode (Xvfb)
```
Startup is heavily staged (single-instance lock, GPU fallback tracker, dev-parent watchdog, `--serve` headless, Xvfb auto-start).

### 4.2 IPC/RPC

- **waveterm**: the typed spine is `WshRpcInterface` in `pkg/wshrpc/wshrpctypes.go` — the single source of truth, ~20 command-group interfaces (`CoreCommands`, `BlockCommands`, `ConnCommands`, `ProjectCommands`, `GitCommands`, `AgentCommands`, `MemoryCommands`, `ChannelCommands`, `RunCommands`, `RadarCommands`, `JarvisCommands`, `EffortCommands`, `JobCommands`, `SecretCommands`, `VDomCommands`, `AskCommands`, `PiControlCommands`, `TasksCommands`, file interfaces). Conventions: methods end in `Command`, first arg `context.Context`, return `(T, error)` or `chan RespOrErrorUnion[T]` (stream). `wshrpcmeta.go::GenerateWshCommandDeclMap()` reflects the interface → wire command names; `RpcType_Call` vs `RpcType_ResponseStream` from the return type. Wire message `RpcMessage{command, reqid, resid, timeout, route, source, cont, cancel, error, datatype, data}`; control commands in `wshrpctypes_const.go` (`authenticate`, `routeannounce`, `eventrecv`, `streamdata`, `streamdataack`, `ping`, `message`). Transport: `wshutil/wshrpc.go` (`WshRpc`, `RpcResponseHandler`) and the root router `wshrouter.go` ("works like a network switch") with link/route registration, trust levels, backlog, upstream buffering, and route prefixes `conn:`/`controller:`/`proc:`/`tab:`/`feblock:`/`link:`/`job:`/`bare:`. Frontend side: `WshClient.wshRpcCall`/`wshRpcStream`, `rpcResponseGenerator` (async-generator over a message queue), `sendRpcCancel(reqid)` for cancellation, `wshrouter.ts` (forwards upstream or to local `TabClient`). HTTP: `POST /wave/service` with `WebCallType{service, method, args, uicontext}` → `service.ServiceMap` → `WebReturnType{data, updates, error}` (updates pushed into WOS immediately). WS: `/ws?stableid=<tabrouteid>`, auth via `X-AuthKey` (passed through `eoOpts` in Tauri since the webview can't set headers), ping/pong keepalive, each WS registers a trusted router link, disconnect → `CancelRequestsForLink` reaps streaming RPCs.
- **orca**: Electron IPC registered once in `src/main/ipc/register-core-handlers.ts` → ~70 handler groups (`registerAppHandlers`, `registerPtyHandlers`, `registerBrowserHandlers`, `registerSessionHandlers`, `registerRuntimeHandlers`, `registerSettingsHandlers`, `registerSkillsHandlers`, `registerMobileHandlers`, …). Naming: `domain:verb` for invoke (e.g. `repos:list`, `worktree:create`, `aiVault:listSessions`, `app:relaunch`, `wsl:listDistros`, `plugins:invokeCommand`); push events via `webContents.send('pty:data'|'pty:exit'|'pty:spawned'|'plugins:changed'|…)` consumed through `window.api.<ns>.on*`. Representative PTY channels: `pty:write`, `pty:writeAccepted`, `pty:resize`, `pty:claimViewport`, `pty:signal`, `pty:kill`, `pty:listSessions`, `pty:hasPty`, `pty:inspectProcess`, `pty:getCwd`, `pty:clearBuffer`, `pty:rendererDispatcherReady`, `pty:setRendererPtyVisible`, `pty:sideEffectSnapshot`. Exactly one `sendSync` (`app:stage-before-unload-sync`). Trusted-renderer gating: `setTrustedUIRendererWebContentsId` / `setTrustedBrowserRendererWebContentsId` / `setTrustedClipboardRendererWebContentsId`. For remote/mobile there is a separate **runtime RPC** (`src/main/runtime/rpc/`: `ws-transport.ts`, `unix-socket-transport.ts`, `dispatcher.ts`; server binds loopback `127.0.0.1:6768`, widens only on explicit pairing) with E2EE (`e2ee-keypair.ts`, `device-registry.ts`, tweetnacl) and `UnpairedDeviceAuthThrottle`.

### 4.3 Type-sync approach

- **waveterm**: `task generate` runs `cmd/generatets` (reflection over Go via `pkg/tsgen` → `frontend/types/gotypes.d.ts`, `frontend/app/store/wshclientapi.ts`, `frontend/app/store/services.ts`) then `cmd/generatego` (`pkg/gogen` → `pkg/wshrpc/wshclient/wshclient.go`). JSON tags → TS fields, `tstype` overrides, `WaveObj` base type, `tsRenameMap` (`Window→WaveWindow`, `Elem→VDomElem`, `MetaSettingsType→SettingsType`), `TypeUnions` (WSCommand union), the wshrpc interface → `RpcApiType` class methods with per-command typing (call vs `AsyncGenerator` for streams), `MockRpcClient` seam; events → `WaveEventName` union (`tsgenevent.go`). **Never hand-edit generated files.** The Rust side is *not* codegen'd (6 hand-written commands, serde camelCase mirrored by hand in `frontend/tauri/api.ts`).
- **orca**: no codegen. The contract is `src/shared` (pure TS): `protocol-version.ts`, `terminal-stream-protocol.ts`, `pairing.ts`, `runtime-environments.ts`, `TUI_AGENT_CONFIG`, the agent-hook listener, git-capability cache — imported by main, renderer, CLI, relay, and mobile; the preload surface is type-audited against `PreloadApi` (`window.api` `satisfies PreloadApi`). zod ~4.4.3 used for runtime validation (e.g. settings).

### 4.4 State sync (WOS vs stores)

- **waveterm WOS path** (documented end-to-end in the report): `wcore.SendWaveObjUpdate(oref)` → `wps.Broker.Publish(WaveEvent{event:"waveobj:update", scopes:[oref]})` → broker → client → root router → WS link → WebView → `ws.ts` onmessage → `wshrouter` (command `eventrecv`) → `wps.handleWaveEvent` → scoped handlers → `wos.updateWaveObject` → `globalStore.set(wov.dataAtom, {value, loading:false})` **version-guarded** → `useAtomValue` re-renders. The object model: `WaveObj` contract (every object has `OID` uuid, `Version` int for optimistic concurrency, `Meta` map), `ORef = "otype:oid"`, reflection registry `RegisterType`. Object types (`AllWaveObjTypes`): Client, Window, Workspace, Tab, Channel, RadarReport, Block, LayoutState, MainServer, Job, Run, ChannelMessage, JarvisConvo, Effort. Store: SQLite WAL `busy_timeout=5000`, **single write connection** (`SetMaxOpenConns(1)`), separate **read pool (8 conns, mode=ro)**; generic `db_<otype>(oid PK, version, data json)` tables via migrations (`db/migrations-wstore/` `000001_init`…`000016_effort`); indexed expressions for channel rows; `db_tevent` telemetry; event-persist store. WPS subscriptions are refcounted per `eventType|scope` (`waveEventSubscribeSingle` → `EventSubCommand`/`EventUnsubCommand`); some events persist and replay to late subscribers (`MaxPersist 4096`; `agent:status` uses `Persist:1`).
- **orca**: main-process `Store` (persistence) is the durable truth → `orca-data.json` (+ `.bak.N`, async writes, quit flush, secret sentinel substitution). Renderer zustand slices derive from IPC + push events. Agent status specifically: hook listener normalizes events into per-pane status, **persists last-status** (debounced 250 ms, 7-day hydrate horizon, atomic write) and **replays to listeners on hydrate**. Worktree state is scanned from git (`git worktree list --porcelain`, `-z` when available) with `inFlightWorktreeScans` shared concurrent scans and **mutation-generation fencing** of stale scans. No object-graph pub/sub equivalent to WOS is described; the wire protocol for remote/mobile is the `terminal-stream-protocol` binary stream + runtime RPC (protocol v3, ~40 `RUNTIME_CAPABILITIES` capability strings, `MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION = 2`).

### 4.5 Persistence & schema

waveterm: SQLite object store with JSON blobs + migrations + WAL; telemetry table; event-persist store. orca: JSON file store with backups + state-hash guard + secret protection; orchestration DB (`OrchestrationDb`); worktree metadata derived from git. (Further orca schema details **not covered**.)

---

## 5. Orchestration model

### 5.1 Task flow end-to-end

**waveterm**:
```
UI (channels composer / jarvis stage)
  → RpcApi.CreateRunCommand (wshrpc over WS)
  → wshserver_runs.go → jarvis.NewRun(goal, playbook) → wstore persist
  → EnsureWorkers → SpawnRunWorker
      (background tab via wcore.CreateTab; block meta: view=term, controller=cmd,
       cmd=<bin>, cmdargs=<unattended args>, cmdjwt=true; force-start controller)
  → shellcontroller spawns <harness bin> with prompt in a pty/tab
  → worker runs, writes its JSONL transcript file
  → wsh agent-hook publishes agent:status / agent:ask events
  → frontend livetranscript.ts streams transcript tail (StreamAgentTranscriptCommand)
  → projectors → liveEntriesByIdAtom → card timeline
  → worker self-reports via `wsh jarvis complete` → ReportRunPhaseCommand
  → server CompletePhase → recomputeStatus → waveobj:update → UI phase rail
  → all phases done → SealRunEvidenceCommand (immutable RunEvidence: files +add/-del,
      verifs, artifacts, runtime/duration ms) → RunCompletion surface
```
Run model: `Run` = goal + runtime + mode (`quick | pipeline | orchestrator`) + `Phases []RunPhase`; statuses `planning | awaiting-review | executing | blocked | done | cancelled` derived **purely from phase states** (`recomputeStatus` is the single source of truth, with a large pure-Go test surface). Phase kinds `brainstorm | plan | execute | orchestrate | custom`; states `pending | running | blocked | done | failed | skipped`; special phase flags `Gate` (halt for review), `FreshCtx` (new worker), `Held` (orchestrator self-pause), `Triage`. Playbooks: `DefaultPlaybook` (brainstorm → plan(gate) → execute(fresh)), `DefaultOrchestratorPlaybook(gate)` (single orchestrate phase), `QuickPlaybook` (bare execute); resolvable per-project via `JarvisProfile` (global profile file + per-channel `ProfileOverride`). Worker prompts: `BuildPhasePrompt` (principles + skill + headless guidance + "run `wsh jarvis complete <deliverable> --commit <sha>`"), `BuildQuickPrompt`, `BuildOrchestratePrompt` (plan → `wsh jarvis hold <plan-file>` → dispatch subagents via `wsh jarvis run` → child notify lines `[jarvis] child <id> … -> done|cancelled` — **the lead never reads child transcripts**). Children get `StripPhaseGates`. Advance actions: `complete | approve | sendback | hold | triage` on `AdvanceRunCommand`; `CancelRun` skips open phases; `StopRunWorkerCommand` kills surviving workers. Approvals: plan gates (human approve/sendback in UI) + `AskUserQuestion` → `agent:ask` event → answerable card → `AnswerAgentCommand` (answers written back via the ask bridge; `wsh ask --wait` blocks a Pi tool call up to 30 min and returns JSON answers).

**orca**:
```
User prompt (composer / CLI --prompt / mobile)
  → buildAgentStartupPlan / buildAgentDraftLaunchPlan   (src/shared/tui-agent-startup.ts)
  → launchCommand per TUI_AGENT_CONFIG, e.g.:
      claude 'prompt' (argv) | claude --prefill '<draft>' (draft, no submit)
      codex 'prompt' (argv; preflight trust marker) | pi (argv → ORCA_PI_PREFILL env)
      opencode --prompt 'p' (flag-prompt; waits for bracket-paste cursor signal)
      gemini --prompt-interactive | copilot -i | hermes --tui (bounded query contract)
      aider | goose | amp | kiro | … (stdin-after-start: launch TUI, type prompt after readiness)
  → typed into a PTY (node-pty) spawned in the worktree's shell
      (provider: daemon | LocalPtyProvider | SSH relay | remote runtime)
  → PTY output → main ipc/pty.ts → 'pty:data' → renderer xterm (WebGL)
  → agent CLIs call back via managed hooks → loopback HTTP (or relay hook server)
      → status cards, completion notifications, subagent roster, rate limits
```
Isolation: each agent runs in its **own linked git worktree** (cwd = worktree path; `HISTFILE` injected per-worktree via `src/main/terminal-history.ts`). Follow-ups: composer sends a new prompt into the same TUI (bracketed paste or argv), or a new turn via hook-injected turns (`AgentSessionContinuation`). Approvals: `PermissionRequest` hook events → question cards; `resolveTuiAgentPermissionMode` decides YOLO vs ask.

### 5.2 Parallelism and fan-out

- **waveterm**: parallelism happens through the run model — `orchestrator` mode dispatches child runs (`wsh jarvis run`), each child its own background-tab worker; children never halt (gates stripped); the lead keeps context small (one-line notifications). The UI shows multiple live agents on the cockpit grid simultaneously; the **attention feed** (`BuildAttention`: review gates `awaiting-review`, Gatekeeper escalations, pending asks, oldest-first) aggregates what needs the human. There is no split-pane concurrency surface and no DAG/mailbox concept in the report.
- **orca**: parallelism is spatial — each agent = own worktree + own terminal tab; arbitrary parallel tabs and infinite splits; `worktree create --agent X --prompt Y` (CLI) or composer launches N agents independently. On top: the orchestration layer (`src/cli/specs/orchestration.ts` + runtime RPC methods + skills/orchestration) — durable Run/Task/Dispatch with an inbox/mailbox ("control mail"), message types (`status`, `dispatch`, `worker_done`, `merge_ready`, `escalation`, `handoff`, `question`, `decision_gate`, `heartbeat`), group addresses (`@all`, `@claude`, `@worktree:<id>`, …), `worker-start` composition (worktree+terminal+dispatch), `check --wait` FIFO delivery with `--ack`, decision gates, **DAGs with deps**, circuit-break after 3 consecutive dispatch failures, persisted in `OrchestrationDb`. **Federation** (`orchestration.federation.v1`): run workers on other connected Orca servers via `worker-start --on <environment>`; home server keeps Run/Task authority, dispatch routes by ID across servers with runtime epochs and ack checkpoints. `claude-teams`: Orca launches Claude Code Agent Teams inside its own terminal and opens teammates as native Orca splits (`runtime/claude-agent-teams-*.ts`, `cli agent-teams-tmux`).

### 5.3 Memory / context

- **waveterm** (deep): consult context = capped channel history (20 msgs / 4000 chars) + the operator's global `~/.claude/CLAUDE.md` principles verbatim (`BuildPrompt`); corpus-based model selection (`ModelForCorpus` pins `claude-haiku-4-5` 200K vs `claude-sonnet-5` 1M at `CorpusEscalationBytes = 400*1024`). Second brain: `pkg/memroots` (single registry; `VaultRoot()` default `~/.waveterm/vault`; `MemoryRoot()` = vault's `memory/` collection, the **only write target**); `pkg/memvault` scans markdown vaults (Claude memory schema frontmatter + `[[wikilinks]]`) into `Note`+`Edge` graphs (harvest/learn/prune/review/recall/projection); `pkg/memdistill` background distiller (activity tracking, coordinator, queue; periodic sweeps call `memgarden.Sweep`, `jarvisvolunteer.SweepLooseEnds`, vault migration + `HarvestAll`); `pkg/memgarden` dedup/decay/freshness; `pkg/jarvisrecall` retrieval (semantic via `pkg/jarvisembed` — **CGO sqlite-vec embedding index** — + lexical, judge whether notes answer, converse, tier) backing `JarvisAskCommand` and the `wave_vault_ask` tool; `pkg/jarvisdossier` decisions log (`AcceptDossierEdgeCommand`/`AppendDossierDecisionCommand`); plus attribution/backfill/continuity/proactive/volunteer packages, `pkg/agentsessions` normalized session extraction, `pkg/bgagents`, `pkg/pisession` (Pi v3 JSONL parser, parent-branch traversal), `pkg/pitasks` (read-only `pi-tasks` store scanner). Radar (`pkg/reporadar`): scheduled code review with collectors (structure/git/runs/transcript/memory/config) → signals → clustering → `RadarFinding`s (`radarreport` waveobj; `RunRadarOrigin` links runs to findings; `RecordInvestigation` closes the loop).
- **orca**: report covers `store/slices/memory.ts`, `aiVault` RPC handlers (`aiVault:listSessions`), AiVaultHandler on the relay, mobile aiVault, `diffComments` (AI-diff annotations), `rate-limits`/`usage-provider-slices`, `preflight`. Deeper memory/retrieval internals (embedding, decay, retrieval quality) are **not covered** by the report.

### 5.4 Streaming and cancellation

- **waveterm**: FE async-generator streams over WS; server tails JSONL transcripts via fsnotify; `gen.return()` sends wire `{reqid, cancel:true}` (`sendRpcCancel`) → server cancels the handler ctx (closes watcher/goroutine); WS disconnect → `CancelRequestsForLink`; `restartActiveStreams` on WS reconnect; consult/worker cancellation closes pipes to unblock stuck readers; `ask --wait` abort kills the child.
- **orca**: PTY byte delivery with **accounting** (`rendererInFlightTotalChars`, delivery credits, `pane-terminal-output-scheduler` ack credits, gate on `pty:rendererDispatcherReady`, hidden-pane buffering, restore markers `pty:modelRestoreNeeded`); remote/mobile use the binary `terminal-stream-protocol` (16-byte header, kind `0x74`, version 1, opcodes 1–17 including `Ack`=13, `ClaimViewport`=14, `OutputSpan`, `SetOutputPaused`=16, `WriteUnavailable`=17 — opcode numbers permanent once shipped); cross-version enforcement test runs HEAD vs latest release tag both directions.

---

## 6. Terminal

**waveterm**:
- Frontend: `@xterm/xterm` v6 + addons fit/search/serialize/web-links/**webgl** (`view/term/termwrap.ts`, `term.tsx`). `TerminalWrap.initTerminal()` loads initial data (`loadInitialTerminalData`), subscribes to **blockfile events** (`getFileSubject(zoneId, TermFileName)`, wps `blockfile` event with base64 chunks), and saves state (`BlockService.SaveTerminalState(blockId, state, "full", ptyOffset, termSize)`).
- Backend pty: Go `github.com/creack/pty` (`pkg/shellexec/shellexec.go`, `conninterface.go`); `ShellController` (`pkg/blockcontroller/shellcontroller.go`) runs the shell/cmd proc, feeds `ShellInputCh`, emits `controllerstatus` events; `Controller` interface (`Start/Stop/GetRuntimeStatus/GetConnName/SendInput`) with `BlockInputUnion{inputdata, signame, termsize}`; `durableshellcontroller.go` for persistent shells; `Job` objects track pty processes (`pkg/jobcontroller`); output streams to blockfiles (`pkg/blocklogger`, `pkg/filestore`).
- Splits: **legacy only** — the layout tree (`frontend/app/layout/`, `LayoutState` waveobj, `CreateBlockAction_SplitUp/Down/Left/Right`); the cockpit itself uses no splits (fixed nav rail + surface + optional details rail). The **agent TUI is a single full-size xterm** rendering claude/codex/pi interactively.
- Scrollback: xterm buffer + **server-side blockfile** (no cap described; "KISS" acknowledged).
- Remote: SSH via `golang.org/x/crypto/ssh` (`pkg/remote/conncontroller` — runs a remote `wsh connserver` over the SSH channel + domain socket; `genconn` ssh/wsl impls; `pkg/wslconn` for WSL; `ConnStatus` events via `connchange`). Remote shells are real pty-backed procs on the remote host with wsh RPC back to local wavesrv.
- Extras: `term-wsh.tsx` (wsh-in-terminal mode), OSC handlers, shell integration, `termtheme.ts` (ANSI from `buildThemeVars`).

**orca**:
- Renderer: xterm `6.1.0-beta.287` + **patched WebGL addon** (`pane-webgl-renderer.ts`: GPU context recovery, atlas budget, hidden-pane retention, `pane-terminal-gpu-acceleration.ts`) + ligatures (patched), unicode11, search, web-links, fit, serialize. Pane management is `src/renderer/src/lib/pane-manager/` (~100 files): split/close/move (dnd-kit + custom dividers), layout serialization, fit (resize-observer + WebGL attach signaling), scroll intent + user-scrolling contract, **IME composition (Hangul/CJK/kitty encoding)**, keyboard protocols (CSI-u, mode 2031 replies), bracketed paste, OSC 7 cwd / OSC 8 links / OSC 52 clipboard, mouse hide-while-typing, file links (path hit-testing), drop-to-upload.
- Main: `src/main/ipc/pty.ts` (~7,700 lines) is the delivery pipeline: providers feed output → per-PTY accounting → `webContents.send('pty:data')` → resync/restore markers → exit/spawn events → hidden-pane output buffering → `pty:serializeBuffer:request` snapshots.
- PTY providers: `LocalPtyProvider` (in-process fallback), **daemon** (default; `src/main/daemon/` — a separate Electron/node process that owns PTYs so they **survive app quit**, with spawner, health endpoint, checkpointing, `pty-subprocess.ts` wrapping node-pty), **SSH relay provider**, **remote runtime**. `pty-provider-contract.ts` defines the interface.
- Splits: **infinite** — pane tree with horizontal/vertical splits per terminal tab (`terminal-pane-layout-tree.ts`, `pane-tree-ops.ts`, `pane-subtree-split.ts`), tab groups, floating terminal panel, dashboards.
- Scrollback across restarts: the daemon checkpoints terminal state to disk (`terminal-checkpoint-serializer.ts`: `snapshotAnsi`, `scrollbackAnsi`, `rehydrateSequences`, `pendingEscapeTailAnsi`, cwd, dims, modes, generation; bounded JSON writer); the daemon's `HeadlessEmulator` (server-side xterm-compatible buffer) **replays checkpoints on cold restore** (`terminal-history-checkpoint-reader.ts`, incremental seed transfer, tombstone GC `terminal-history-gc.ts`); per-worktree `HISTFILE` redirection so command history also survives. Trade-off: **50k-line caps on cold restore**; scrollback is best-effort across restart, not guaranteed.
- Performance gates: `terminal-typing-latency`, `foreground-redraw-freeze`, `output-scheduler`, WebGL atlas budget golden tests, typing benchmarks with budgets (`check-terminal-perf-report-budgets.mjs`).

**Head-to-head**: waveterm's terminal is one focused pane with server-side blockfile scrollback and Go-side pty control; orca's is a product-grade subsystem (split panes, daemon-owned PTYs, checkpointed scrollback, IME/keyboard-protocol coverage, byte-accounted delivery, perf budgets). waveterm's remote terminal story (SSH connserver over x/crypto/ssh + WSL) is real but narrower than orca's (SSH + WSL + relay + federated runtime + mobile).

---

## 7. Agent ecosystem

**waveterm** — 4 local CLIs + 1 API:
- Catalog: `pkg/harness/catalog.go` — specs `pi`, `claude`, `codex`, `opencode`, each with `ConsultCapable` + `RunWorkerCapable`; `ProbeAll` runs `<bin> --version` concurrently; `ValidateInstalled(runtime, operation)` gates launches. **OpenRouter is deliberately outside the catalog** (API-only utility).
- Consult one-shots: `claude -p --output-format stream-json --verbose` (JSONL parse `claudeParseLine`); `codex exec --json`; `opencode run --format json`; `pi --mode json --no-session --no-extensions` (`agent_settled` = complete); openrouter API backend (`openrouter.go`). Pipe mode (JSONL) or **pty mode** (`creack/pty` 200x220) for TUI-only CLIs with `cleanTUI` ANSI stripping. Model tiers: `TierCheap` (haiku), `TierMid` (sonnet), `TierCapable` (no flag); `SpecForTier` appends `--model`.
- Run workers (unattended): `claude --dangerously-skip-permissions <prompt>`, `codex --dangerously-bypass-approvals-and-sandbox <prompt>`, `opencode --auto --prompt <prompt>`, `pi <prompt>`.
- Observability: managed hooks into `~/.claude/settings.json` (`PreToolUse`/`PostToolUse` → `wsh agent-hook`; `AskUserQuestion` → `wsh ask`; `Notification`, `Stop`, `SubagentStop`, `UserPromptSubmit`, `SessionEnd` → `agent-memory-hook`); pi extensions bridge (`waveterm-status.ts`, `waveterm-tools.ts`, `waveterm-ask.ts`); codex/opencode via shadow transcripts + `agentobserve` (`wshcmd-agentstatus.go`). The runtimes own their auth (no key proxying except OpenRouter).

**orca** — ~45 detected agent CLIs:
- Detection: `src/shared/agent-detection.ts`, `tui-agent.ts`, `src/main/ipc/tui-agent-detection-commands.ts`; keys in `TUI_AGENT_CONFIG`: claude, claude-agent-teams, openclaude, codex, autohand, ante, trae, opencode, mimo-code, pi, omp, prime-agent, gemini, antigravity, aider, goose, amp, kilo, kiro, crush, aug, cline, codebuff, command-code, continue, cursor, droid, kimi, mistral-vibe, qwen-code, rovo, hermes, openclaw, copilot, grok, devin.
- Per-agent quirks are **config-driven** (not per-runtime code): `draftPasteReadySignal` (codex-composer-prompt, grok-composer-prompt, render-cursor-after-bracketed-paste), `preflightTrust` (cursor/copilot/codex pre-write trust markers so first-launch trust menus don't swallow the paste), `windowsShiftEnterEncoding`/`ctrlEnterEncoding` (CSI-u), `argvPromptSeparator: '--'`, launch strategies (argv / draft prefill / flag-prompt / stdin-after-start / hermes query contract).
- Hooks: managed installers per CLI (`agent-hooks/managed-*`, `installer-utils.ts` — Claude Code hooks config, Codex `~/.codex` hook entry), `ORCA_AGENT_HOOK_*` env injected into PTY spawn env, events POSTed to a loopback HTTP server (endpoint file in userData); events include `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `Stop`, `SubagentStop`, `PreCompact`, `PostCompact`, `PermissionRequest`, OpenCode `MessagePart` (role=user).

**Trade-off**: waveterm's catalog is small but deep (typed harness, model tiers, consult + run-worker duality, API backend); orca's is broad but thin per agent (launch + observe; no consult/run-worker API abstraction described, no OpenRouter/API backend mentioned). Both mutate the user's Claude/Codex hook configs — see Open Questions.

---

## 8. Extensibility

**waveterm**:
- The `pi/` arc package: extensions (installed to `~/.pi/agent/extensions/` by `wsh install-agent-hooks` with `__WSH_PATH__` substitution) — `waveterm-status.ts` (status reporting mirroring the Claude hook), `waveterm-tools.ts` (`wave_run_command`, `wave_open_file`, `wave_vault_ask`, `wave_query_sessions`, `wave_notify` + notification bridge + a **control channel watcher** reading `<sessionId>.json` from `WAVETERM_PI_CONTROL_DIR` → steer/follow_up/set_session_name/compact/abort/new_session/switch_session), `waveterm-ask.ts` (AskUserQuestion bridge), `waveterm-prose-core.ts`, `waveterm-simplify-gate.ts` (pi-simplify review gate). Skills: `arc-dev`, `effort-tracking` (installs to `~/.claude/skills/effort-tracking/SKILL.md`), `ui-mockup`. Prompts: `arc-review.md`. Theme: `arc.json` (TUI theme). Sync: `task sync:piartifacts` copies extensions + theme into `cmd/wsh/cmd/` (go:embed into wsh); `task sync:pi-theme` regenerates `arc.json` from cockpit `@theme` tokens; `check:pi-theme` validates.
- Codegen: `task generate` reflection pipeline (see §4.3). Runtime themes: 7 presets + CSS-var overrides. Settings: flat `key:value` strings (`SettingsType`, schema in `dist/schema/`, `SetConfigCommand`/`wsh setconfig`/settings UI). Secrets: OS-keyring (`pkg/secretstore`).

**orca**:
- Bundled skills: `skills/` sources — `orca-cli/`, `orchestration/`, `computer-use/`, `orca-emulator/`, `orca-emulator-android/`, `orca-linear/`, `linear-tickets/`, `orca-per-workspace-env/` (each with `SKILL.md`). Generated human-readable `skill-guides/` (orchestration.md ≈1,100 lines: Run/Task/Dispatch grammar, ownership, handoff vs supervised, federation, recovery) + `skill-stubs/`; kept in sync by `config/scripts/generate-bundled-skill-guides.mjs` (verify in `pnpm lint`).
- Skills install: `orca skills install|update` → `npx skills add <repo> --skill <name> [--global|--local] [--agent ...]` (with `--yes -y`), targeting detected agent CLIs + shared `.agents/skills`; refuses SSH/WSL bridged contexts (prints the command instead); renderer UI in `components/skills/` + `installed-agent-skill-discovery.ts` scans `.agents/skills`.
- Plugins (separate surface): `src/main/plugins/` — plugin host process, marketplace install (`plugin-marketplace-*`), consent/enablement, language packs, panels, command invocation over RPC; `examples/plugins/`.
- Repo config: `orca.yaml` — setup scripts, hooks (`hooks.ts`, `hooks-runner.ts`), default terminals, `wait-for-setup` sequencing, trust presets (`agent-trust-presets.ts`, `remote-agent-trust-presets.ts`).
- Patches: 5 patched deps in `config/patches/` (node-pty, xterm ×4).

**Trade-off**: waveterm's extensibility centers on the **typed Go spine + codegen** (structural safety) and a small curated pi package with deep integration (control channel, tools, ask bridge); orca's centers on **breadth** (skills marketplace install, plugin host, per-repo `orca.yaml` hooks, ~45-agent coverage) with a hand-maintained shared core.

---

## 9. Mobile / remote story

**orca** (comprehensive):
- **Mobile**: separate pnpm workspace, Expo 55 / React Native 0.83 / expo-router. xterm `6.1.0-beta.285` + webgl inside `react-native-webview` (`terminal-webview-html.ts` builds the host page; injected scripts handle touch/gesture→mouse-cell, tap dispatch, wheel scroll, reflow, theme, query-reply, WebGL recovery, keyboard avoidance). Transport: `rpc-client.ts` (WS JSON-RPC with request deadlines, single-flight, live recovery, health, log redaction), `e2ee.ts` (tweetnacl), pairing via `orca://pair?code=` (`pairing.ts`), host catalog in Keychain/SecureStore, **relay-assisted pairing** (`mobile-relay-*`: credential bundles, rotation, direct-upgrade relay→LAN, invite director), `runtime-capability-probe.ts`. Session surface: tabs, `TerminalPaneView`, **native chat** (streaming answers, diffs, tool summaries, questions, image attachments), quick commands, diff review with PR comments, file browser, browser view, markdown reader, notifications, **dictation** (expo-two-way-audio → desktop sherpa-onnx STT). Tasks: GitHub/Linear work items, workspace creation with smart source. The phone is a **full PTY client** — type into the agent TUI, send prompts/follow-ups, answer permission questions, create worktrees, attach images. Desktop side: pairing QR, presence lock, session-tab sync (publishes tab/agent-status), notification replay after reconnect (`mobile-notification-replay.ts`).
- **Relay** (SSH hosts): `src/relay/relay.ts` — framed JSON-RPC over stdio (1-byte type + length-prefixed frames, `ORCA-RELAY v0.1.0 READY`); handlers `PtyHandler` (credit-based flow control `pty-source-credit-ledger.ts`), `FsHandler` (list/read/write/watch, ripgrep fallback), `GitHandler` (mirrors local worktree ops in lockstep), `PreflightHandler`, `PortScanHandler`, `AgentExecHandler`, `WorkspaceSessionHandler`, `AiVaultHandler`, `ExternalAutomationsHandler`, `AgentHookServer` (agent status works over SSH). **Grace/reconnect**: 60s grace (idle-relay 15 min) keeping PTYs alive on `relay.sock`; later SSH exec bridges new channel stdio to the daemon socket. Log rotation.
- **Remote wire**: protocol v3, ~40 capabilities, `terminal-stream-protocol` binary stream, codified compat rules (new optional JSON field safe; new opcode must be capability-announced; changing published content breaks old clients), enforced by cross-version tests.
- **SSH**: ssh2 native, three execution-host kinds (native, WSL distro, SSH host) + federated remote runtime; SFTP upload/download/stream/watch; port forwarding; WSL path translation and git routing through `wsl.exe`; hook relay inside WSL.
- **Headless/web**: `orca serve` runs Electron main headless (WS 6768, Xvfb on Linux, ready-JSON, mobile + web clients); full renderer web build (`vite.web.config.ts` → `out/web`); remote-server updater (never self-updates headless), upgrade/rollback playbooks in `docs/reference/headless-linux-server.md`.

**waveterm**: remote shells via SSH `conncontroller` (runs a remote `wsh connserver` over the SSH channel + domain socket; ssh/wsl genconn impls; WSL via `pkg/wslconn`; `ConnStatus` via `connchange` events). **No mobile app, no relay daemon, no headless serve, no web client** are mentioned in the report — those surfaces are **not covered / absent from the researched material**. No remote-wire compatibility protocol is described (wsh RPC over the SSH domain socket is the mechanism).

---

## 10. Development experience (building each project itself)

**waveterm**:
- `task dev` → `npm run dev` → `cargo tauri dev` (Vite :5174, HMR; WebView2 CDP :9222 in debug). `task build:backend` builds `wavesrv` + `wsh` into `dist/bin/`. `task init` first-time setup.
- `task generate` — the reflection codegen (TS types, TS client, Go client); **never hand-edit generated files**. `task sync:piartifacts` / `sync:pi-theme` / `check:pi-theme`.
- Typecheck: `npx tsc` **stack-overflows** — workaround `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`.
- Tests: vitest with **181 `.test.ts` files**, pure-logic `.ts` + `.test.ts` beside components, **no jsdom render tests** (visual checks via `task verify:ui -- <scenario>` over CDP → contact sheet `cdp-shots/index.html`); junit to `test-results.xml`. Go tests need `CGO_CFLAGS=-I<pkg/jarvisembed/csrc>` (sqlite-vec) or `task build:backend`.
- Lint/format: `npx eslint .`, `npx prettier --check .`. Worktrees (Windows): `task worktree:prepare` junctions node_modules/target/dist/bin; `worktree:cleanup` junction-first (recursive delete danger).
- Migration discipline: SQL migrations in `db/migrations-wstore/`; new waveobj type needs a migration; prototype-first UI workflow (`ui-mockup` skill, `docs/prototype/mockup-template.html`, `task mockup:kit`).

**orca**:
- pnpm 10.24 monorepo (root workspace deliberately empty; `mobile/` separate workspace with own lockfile), Node 24 floor.
- `build:desktop` chain: typecheck → `build:relay` → `build:cli` (tsc → out, `verify-cli-bin` fixes shebang/packaging, installs dev CLI) → `build:electron-vite` → `verify:built-skills-cli` → `build:web-from-renderer`. electron-vite bundles only `@xterm/headless`, `@xterm/addon-serialize`, `psl`, `zod`; rolldown-vite 7.3.1. Release CI injects `ORCA_BUILD_IDENTITY`/`ORCA_POSTHOG_WRITE_KEY` (contributor builds hard-compile to `null`).
- Lint/format: **oxlint** (native + type-aware, `--deny-warnings`), **oxfmt**, `react-doctor` (perf lint), **knip** dead-code audit, `max-lines` ratchet, `zustand-selector-fanout` check, `check-reliability-gates.mjs`; husky + lint-staged run staged-file linting.
- Tests: **vitest 4, ~5,800 co-located test files**; Playwright `tests/e2e/` (electron-headless) with **golden suites** (session persistence, terminal rendering, source control, agent TUI launch, Windows fresh startup, POSIX profile index); terminal-perf suites with budget gates; SSH/Docker e2e runners; **cross-version wire tests** (HEAD vs release tag); win-update/crash-survival harnesses; mobile vitest + mock server.
- Verification scripts: localization catalog/extraction/coverage, skill guide/manifest verify, macOS entitlements verify, **Linux glibc floor gate** (`verify-linux-glibc-floor.cjs`: `objdump -p` version-needs scan, fails if any strong `GLIBC_ > 2.31`/`GLIBCXX_ > 3.4.28`, asserts `libutil` DT_NEEDED for node-pty).
- Native modules: node-pty compiled from source with a `.symver` pinning patch (binds `openpty/forkpty/pthread_sigmask` to pre-merge glibc versions + `--no-as-needed` libutil/libpthread); sherpa-onnx lazy-loaded in `stt-worker.ts` (worker_threads), exempt from libstdc++ floor; `@parcel/watcher` prebuilt; Windows: `windows-native-registry` optional dep, conpty warmup, `ProcessStartInfo` launcher for `.cmd` runners.
- Versioning/updates: `1.4.178-rc.2`, electron-updater with stable/rc channels, serve-update handoff, quit-and-install with exit watchdogs. CI: ~30 workflows (pr, pr-test-loc split, e2e, golden-e2e, terminal-ime-e2e, terminal-perf, computer-e2e, linux-wayland-gpu-sandbox, win-update/crash-survival, mobile iOS/Android fastlane, daily/hourly/ad-hoc mac builds, release-cut, windows-signing-rehearsal, homebrew-bump…).

**Head-to-head**: waveterm's loop is small and fast (Go reflection codegen makes Go↔TS drift structural; taskfile-ized; small test surface with prototype-first visual verification). Orca's loop is industrial (thousands of tests, budget gates, golden e2e, cross-version wire tests, platform floors) at the cost of build/CI complexity and a giant codebase to navigate.

---

## 11. Key tradeoffs and gaps — actionable learnings

### Where each wins

| Dimension | Winner | Why (mechanisms) |
|---|---|---|
| Type safety across the stack | waveterm | one reflection pass over `WshRpcInterface` derives wire names, Go dispatcher, TS client/types; drift is structural |
| Run-state correctness | waveterm | pure `recomputeStatus` over phase states, pure-Go test surface; plan gates as first-class `Gate` phases |
| Memory/second brain | waveterm | full stack: memvault graph, memdistill, memgarden decay, jarvisrecall semantic (sqlite-vec) + judge, dossier, attention aggregator |
| Agent breadth | orca | ~45 detected CLIs with config-driven quirks vs waveterm's 4 harnesses |
| Parallel isolation | orca | per-agent git worktrees + infinite splits + DAG orchestration + federation |
| Terminal engineering | orca | daemon-owned PTYs surviving quit, server-side scrollback replay from checkpoints, IME/keyboard-protocol coverage, byte-accounted delivery, perf budgets |
| Failure-mode engineering | orca | credits/acks, watchdogs, crash breadcrumbs, GPU fallback, daemon fallback classification |
| Remote/mobile | orca | mobile app + relay + headless serve + web client + cross-version wire tests; waveterm has SSH/WSL shells only |
| Compatibility discipline | orca | protocol versioning rules, capability negotiation, git capability cache, glibc floor gate |
| Test volume | orca | ~5,829 test files vs 181 vitest files (+Go tests); golden e2e and cross-version tests |
| Design discipline | waveterm | tokens-only `@theme`, golden-tested Midnight, prototype-first workflow, pure-logic+thin-render convention |
| Process hygiene (Windows) | waveterm | kill-on-close job object, ESTART handshake, `CancelRequestsForLink`, ctx-cancellation closing pipes |

### Specific gaps and what each could learn

**waveterm → orca learnings (actionable):**
1. **PTY/stream delivery accounting.** waveterm's streaming is "tail the file, push chunks" (`transcript.go`, whole-file `readTranscriptLines` server-side, 5MB WS cap, `RouterInputChQueueSize 100`). Orca's credit/ack pipeline (`rendererInFlightTotalChars`, `pane-terminal-output-scheduler` ack credits, `pty:rendererDispatcherReady` gating) is a proven pattern for not losing bytes under load — waveterm could add ack-based flow control to `responsestream`/transcript tails.
2. **Scrollback durability.** waveterm's scrollback = xterm buffer + server-side blockfile; orca's checkpoint + headless-emulator replay (with caps + tombstone GC) survives restarts. waveterm could checkpoint blockfile offsets + terminal state (it already saves `SaveTerminalState(… "full", ptyOffset, termSize)`) into a replayable snapshot.
3. **Per-agent launch/observation config.** waveterm's runtime support is bespoke per CLI (four projectors, per-runtime parse funcs, per-runtime unattended flags). Orca's `TUI_AGENT_CONFIG` + quirk table + launch-strategy taxonomy scales to 45 agents from config; waveterm could extract the projector/launch differences into a declarative table (draft-paste signals, prompt flags, bracket-paste readiness) to lower the cost of adding a runtime.
4. **Compatibility discipline.** waveterm's transcript projectors parse private JSONL formats with no versioning contract; orca's codified wire rules + cross-version test + git capability cache with fallbacks is the pattern to borrow (e.g. version the transcript tail RPC and pin per-runtime format versions).
5. **Failure-mode hardening of the FE.** Watchdog timeouts, crash breadcrumbs, and daemon-fallback classification are orca strengths; waveterm's WS reconnect already restarts streams (`restartActiveStreams`), but a watchdog for stalled `responsestream` readers and a crash-report path would close the gap.
6. **Remote orchestration.** Orca's relay + federation run agents on SSH hosts with the same hook pipeline; waveterm's SSH connserver gives remote *shells* but the report shows no remote *runs/consult* path — running `wsh jarvis`-style workers over the SSH connserver channel would be the natural extension.
7. **Test depth.** Budget-gated perf tests and golden e2e (visual/session restore) would complement waveterm's pure-logic tests; `task verify:ui` scenarios could be expanded into golden assertions.

**orca → waveterm learnings (actionable):**
1. **Single typed contract with codegen.** Orca's IPC surface is hand-maintained across main/preload/renderer (~70 handler groups, 46 sub-APIs, `PreloadApi` audits) and the relay mirrors local logic "in lockstep" by comment convention. A waveterm-style single-interface reflection pass (or at least a schema-derived client for the runtime RPC) would make drift structural instead of audited.
2. **Pure status derivation.** Orca's agent-status is normalized from heterogeneous hook events with debounced persistence; waveterm's `recomputeStatus`-from-phase-states pattern is simpler to reason about and test. Orca's orchestration layer could derive Run/Task state from a pure reducer over control-mail messages.
3. **A cockpit-grade attention surface.** waveterm's `BuildAttention` + `GetAttentionCommand` ("needs you", oldest-first, badge counts) is a lightweight, single-source aggregator; orca spreads attention across slices (agent-status cards, unread badges, task pages). A unified "needs you" feed would improve the parallel-agent workflow.
4. **Design-system discipline.** waveterm's tokens-only colors, golden-tested theme, and prototype-first mockup workflow prevent drift; orca's 3,000-line `main.css` + shadcn layer is powerful but the report shows no golden test or prototype-gate.
5. **Second-brain depth.** Orca's aiVault/memory slices exist but the report shows no embedding index, dedup/decay gardening, or retrieval-judge pipeline; porting waveterm's memvault/memgarden/jarvisrecall concepts (wikilink graphs, harvest sweeps, semantic retrieval) would round out the orchestrator story.
6. **Surface restraint.** Orca ships a prototype page (`ActivityPrototypePage`), kill switches, and legacy shims in production; waveterm's mid-migration sprawl is similar (legacy block/term), but waveterm gates new UI through mockup audits — orca could gate prototype surfaces behind a flag with the same rigor.
7. **WS/stream cancellation hygiene.** waveterm's `sendRpcCancel(reqid)` + `CancelRequestsForLink` on disconnect is a clean pattern; orca's long-lived PTY streams rely on daemon ownership + restore markers instead — worth borrowing for its non-PTY streams (e.g. hook/status replay channels).

### Shared structural risks
- Both mutate the user's **global hook configs** (`~/.claude/settings.json` for waveterm; Claude Code/Codex hook entries for orca). If both apps are installed, they can fight over the same hook ownership (waveterm's report explicitly acknowledges "a coexisting install can own the hooks").
- Both depend on upstream CLI format stability (waveterm's JSONL projectors; orca's per-agent TUI quirks and bracket-paste races documented for codex/pi/grok).
- Both ship best-effort surfaces somewhere (waveterm: whole-file transcript reads, 5MB WS cap; orca: 50k-line scrollback caps, tombstone GC).

---

## 12. Verdict

**Pick waveterm when:** you want a *curated cockpit around a small set of CLIs* (pi/claude/codex/opencode) with a deep second brain, a **typed, regenerable RPC core**, a **pure run state machine with plan gates**, token/usage and attention surfaces, and you're primarily on Windows. It's the better foundation for a "terminal + knowledge ledger + controlled agent runs" product, and its design-system and codegen discipline make it easier to extend safely. Its risk is breadth: 4 agents, no mobile/headless, mid-migration legacy.

**Pick orca when:** you want *breadth and parallelism* — ~45 agent CLIs, per-agent git-worktree isolation, infinite splits, DAG orchestration + federation, mobile access, SSH/relay remote execution, headless server deployments, and industrial test/compat discipline. Its risk is the opposite: a 2.65M-line monolith with hand-audited IPC, a giant store, prototype/legacy surface in-tree, and compat liability per agent CLI.

**Complements:** the two are genuinely complementary — waveterm's typed-spine + pure-run-state + second-brain architecture is the skeleton orca's orchestration breadth could benefit from; orca's worktree isolation, terminal durability, delivery accounting, and remote/mobile coverage are the muscle waveterm's cockpit lacks. A hybrid (waveterm's Go core + codegen + memory stack under orca's worktree/PTY/mobile layer) is a plausible north star, though far beyond either repo's current trajectory.

---

## Open questions (material gaps the researchers did not cover)

1. **Hook ownership conflict:** both products install managed hooks into `~/.claude/settings.json` / `~/.codex`. What happens when both run? (waveterm's report acknowledges coexisting-install hook risk; orca's report doesn't address it.)
2. **waveterm multi-window/workspace model:** `windowIdAtom`/`workspaceIdAtom` exist, but how multiple windows/workspaces behave (and how the cockpit pairs windows to wavesrv) is not covered.
3. **waveterm on macOS/Linux:** Taskfile has macOS/Linux build targets, but the Tauri shell's Windows-specific logic (`#[cfg(windows)]`, job objects, WebView2 CDP) leaves actual cross-platform behavior unverified.
4. **waveterm token/usage data source:** the usage surface (donuts, charts) exists; where the numbers come from (Claude/Codex APIs? local accounting?) is not covered.
5. **waveterm telemetry/CI:** the report covers Taskfile/lint/tests but no CI configuration or telemetry story.
6. **orca memory internals:** `memory` slice and `aiVault` handlers are named, but the retrieval/embedding/decay pipeline (if any) is not covered — is there an orca equivalent to jarvisrecall/memgarden?
7. **orca agent-hook server security:** loopback HTTP with an endpoint file — auth/trust model for the hooks is not covered.
8. **orca orchestration DB schema and recovery semantics:** `OrchestrationDb` persistence format, crash recovery of in-flight dispatches, and the circuit-break semantics beyond "3 failures" are not detailed.
9. **orca pricing/telemetry posture:** posthog + crash reporting are named; consent mechanics and opt-outs are not covered.
10. **End-to-end latency/perf:** neither report benchmarks real-world agent workloads (parallel runs, large transcripts, memory retrieval) — only orca's synthetic terminal-perf budgets are described.
11. **Upgrade story for managed hooks:** what happens to `~/.claude/settings.json` merges when the app or the CLI updates (idempotency is claimed for waveterm's installer; orca's reconciliation is not detailed).
12. **waveterm consult/worker auth & sandboxing:** workers run with `--dangerously-skip-permissions` etc. — no sandboxing of worker processes is described on either side.

---

**Verification note:** this document is a synthesis of the two provided research reports (both dated 2026-08-15: waveterm at v0.14.5, orca at 1.4.178-rc.2 / HEAD 5b7f44278a). No codebase files were re-read and no commands were run — every claim above traces to a mechanism named in the reports, and gaps are marked "not covered" per the task contract. No files were changed or staged.
