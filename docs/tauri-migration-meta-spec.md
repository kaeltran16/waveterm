# Tauri Migration — Meta Spec (Runtime Foundation)

> Captured 2026-06-24. The umbrella doc for moving Wave's runtime from Electron to
> Tauri. Reads alongside [`redesign-brief.md`](./redesign-brief.md) (product intent),
> [`feature-triage.md`](./feature-triage.md) (what exists), and
> [`redesign-meta-spec.md`](./redesign-meta-spec.md) (the cockpit **feature** skeleton).
> Those three define *what the cockpit is*. This doc defines *what it runs on*. It is a
> separate, orthogonal layer — **with one exception: it overrides D1 (Containment) of the
> redesign meta spec** (see §6, §11). Each phase gets its own sub-spec; Phase 0 is first.

## 1. Vision

Keep everything that makes Wave *Wave* — the Go backend, the `wshrpc` transport, the
React agent cockpit, the terminal — and replace only the Electron shell with Tauri. The
payoff is the usual Tauri one (smaller binary, lower memory, OS-native webview) but the
real reason this is now cheap is that the cockpit redesign **deletes the two things that
made an Electron→Tauri port hard**: the multi-`WebContentsView` tab/block architecture
and the embedded `<webview>` blocks. We are not solving those problems; the destination
design simply doesn't contain them.

## 2. Strategy — foundation first

**Port the foundation, not the app.** The foundation is the runtime layer beneath the
feature UI: the Tauri window, the `wavesrv` sidecar, the boot handshake, the native
bridge, and packaging. We stand that up as a minimal shell over the *unchanged* backend,
prove it end-to-end, then the cockpit surfaces (the redesign meta spec's job) are built
**once, on the final runtime** — instead of built in Electron and then ported.

The two hard problems are retired by *exclusion*, not effort:

- **Multi-view tabs** — gone. The cockpit is a single window; navigation is in-DOM
  surface switching, not native tabs. `emain-window.ts` / `emain-tabview.ts` (the
  `WebContentsView` managers) are deleted, not ported.
- **`<webview>` blocks** — gone. The cockpit has zero embedded web content, so nothing
  needs its own web-contents.

The cost does not vanish; it **relocates** out of "the port" and into "build the cockpit
SPA" — which is product work being done regardless of runtime.

## 3. Architecture

Process model:

```
Tauri main (Rust)  ──spawn/sidecar──▶  wavesrv (Go, unchanged)
       │                                     ▲
       │ get_init (ws/web endpoint, authkey)  │ wshrpc over websocket
       ▼                                     │
   single webview  ◀── React cockpit SPA ────┘
```

| Layer | Disposition |
|---|---|
| Go backend (`pkg/` + `cmd/`, ~76k lines / 320 files behind `wshrpc`) | **unchanged** |
| `wshrpc` transport (browser `WebSocket`, `frontend/app/store/*`) | **unchanged** (webview-agnostic) |
| React frontend logic (agents subsystem, terminal, rpc client) | **unchanged** |
| `emain/` (~4.8k lines TS) | **mostly deleted** — window/tabview/webview management has no target on Tauri; ~1.5–2k lines of equivalent lifecycle/bridge logic move to Rust |
| Block-tiling layout engine, `workspace.tsx`, `builder/`, `tsunami`, `<webview>` | **deleted** (see §6) |
| Packaging (`electron-builder`) + updater (`electron-updater`) | **replaced** (Tauri bundler + updater plugin) |

## 4. The boot seam (the linchpin)

The frontend's only real dependency on the shell for connecting to the backend collapses
to one method. `getWSServerEndpoint()` (`frontend/util/endpoints.ts:16`) resolves to
`ws://${getEnv("WAVE_SERVER_WS_ENDPOINT")}`, then a plain `new WebSocket(url)`
(`wsutil.ts:23`). Today Electron parses the `WAVESRV-ESTART` stdout line
(`emain-wavesrv.ts`) into `process.env`; the renderer reads it back via the preload.

On Tauri:

```
spawn wavesrv (env: authkey, data/config dirs) → read stdout
  → match "WAVESRV-ESTART ws:… web:…" → capture endpoints + version
  → #[command] get_init() -> { wsEndpoint, webEndpoint, authKey, initOpts }
  → emit "wave-init" once the frontend has mounted
```

The existing websocket client connects unchanged. This is the foundation's hardest 5%.

## 5. Native bridge

**Strategy:** keep the `getApi(): ElectronApi` TypeScript interface exactly as-is and swap
only the implementation (Tauri `invoke`/events for `ipcRenderer`). The 22 frontend files /
66 call sites do not move; cut methods become `notImplemented` stubs deleted alongside
their callers.

Of the ~41 methods the frontend calls today (+ `getAuthKey`), roughly **two-thirds are
kept** (≈8 of them deferrable past day one) and **one-third cut**; across the full
`ElectronApi` interface the cut share is larger, since it also includes webview/workspace
methods driven only from the main process. **4 net-new** native capabilities are added.
Condensed:

| Group | Methods (representative) | Tauri |
|---|---|---|
| **Boot** | `getEnv`, `getAuthKey`, `onWaveInit`, `setWindowInitStatus` | `get_init` + `wave-init` |
| **Env/identity** | `getPlatform`, `getIsDev`, `getUserName`, `getHostName`, `sendLog`, `setIsActive` | commands |
| **Window chrome** | `updateWindowControlsOverlay`, `onFullScreenChange`, `getZoomFactor`/`onZoomFactorChange` | custom titlebar |
| **Terminal** | `nativePaste`, `saveTextFile`, `openExternal`, `incrementTermCommands` | commands |
| **Interaction** | `setKeyboardChordMode`, `onControlShiftStateUpdate`, `showContextMenu`/`onContextMenuClick`, `onMenuItemAbout`, `getAboutModalDetails` | menu API |
| **Deferrable** | updater (`getUpdaterStatus`, `onUpdaterStatusChange`, `getUpdaterChannel`, `installAppUpdate`); `openNativePath`, `downloadFile` | updater plugin |
| **Net-new (from triage)** | tray, notifications, file-dialog, spawn-editor | Tauri plugins |

The full tiered table with call sites lives in the Phase 1 bridge spec.

## 6. Cuts (and what they override)

Consolidated cut list — each falls away with the subsystem it served:

- **Webview blocks** (`web`, `tsunami`, `help`): `getWebviewPreload`, `setWebviewFocus`,
  `clearWebviewStorage`, `registerGlobalWebviewKeys`, `onReinjectKey`, `onNavigate`,
  `onIframeNavigate`.
- **Builder / tsunami**: `onBuilderInit`, `openBuilder`, `setBuilderWindowAppId`,
  `closeBuilderWindow`, `doRefresh`.
- **Tabs**: `createTab`, `setActiveTab`, `closeTab`. *(A tab is literally a
  `WaveTabView extends WebContentsView`; "switch tab" is `contentView.addChildView/
  removeChildView` — `emain-window.ts:429,383`. No web-contents → nothing to drive.)*
- **Workspaces**: `createWorkspace`, `switchWorkspace`, `deleteWorkspace`,
  `setWaveAIOpen`, `showWorkspaceAppMenu`. *Concept and data model both cut for now;
  re-implementable later (the Go service is untouched behind `wshrpc`). The cockpit's
  project grouping derives from `projectNameFromTranscriptPath` (`projectname.ts`), not
  the workspace object, so the "N projects" view is unaffected.*
- **Drag-drop**: `getPathForFile` (Electron `webUtils`-specific). Feature dropped; the
  composer's "＋ Attach" + native file-dialog covers the need.
- **Multi-view misc**: `captureScreenshot` (`html-to-image` can do it in-DOM if ever
  needed), `getCursorPoint` (DOM events carry coordinates), `onQuicklook`.

**Decisions this overrides (flagged, not silent):**

- **redesign-meta-spec D1 (Containment)** flips from *Option A — evolve the agents block
  inside Wave, keep the tab bar + OS titlebar* to **the cockpit IS the app shell** (full
  window, own titlebar, single webview). The redesign meta spec's §3–§7 (shell split,
  surface inventory, nav/data-flow/conventions) are runtime-agnostic React and carry over
  unchanged; only containment changes.
- **feature-triage KEEP "Multi-Project Workspace"** → cut (reversible).
- **feature-triage KEEP "Drag Files Into AI Prompt" / "Drag-Drop Paths into Terminal"** →
  cut.

## 7. Scope boundary

This doc and its phase specs cover the **foundation only**. Building the cockpit surfaces
(Cockpit reskin, Focus, Usage, then Activity / Sessions / Channels / Memory) is the
**redesign meta spec's** phasing, executed *on top of* this foundation. The surface work
is identical whether on Electron or Tauri — which is the whole argument for foundation
first: it gets built once, on the final runtime.

## 8. Phasing roadmap

| Phase | Scope | Effort |
|---|---|---|
| **0 · Tracer bullet** | Rust `main` → spawn `wavesrv` → `get_init` → websocket connects → **one xterm terminal runs a real PTY in the Tauri webview** | ~1 wk |
| **1 · Day-one bridge** | Boot + env/identity + terminal basics behind the unchanged `getApi()` interface | ~1 wk |
| **2 · Chrome + interaction** | Custom titlebar, zoom, fullscreen, context menus, chord mode | ~1–1.5 wk |
| **3 · Net-new native** | tray, notifications, file-dialog, spawn-editor (Tauri plugins) | ~0.5–1 wk |
| **4 · Packaging + updater** | Tauri bundler, Windows signing, updater plugin + release feed | ~1–2 wk |
| **5 · Frontend teardown** | Delete block/tab/layout engine, `workspace.tsx`, `builder/`, `tsunami`, `<webview>`; boot into a minimal cockpit-shaped shell (surfaces stubbed) | ~1–2 wk |

**Foundation work-size: ~6–9 weeks of human labor** — Windows-only, the cuts applied.
This is a *sizing* anchor, not calendar time: the migration is agent-executed (§12), so
wall-clock is gated by verification loops and human-only steps, not typing — see §12.
Phase 0 is the critical path and is front-loaded so the biggest remaining unknown (the
sidecar handshake + xterm in WebView2) is exposed first.

## 9. Risks & swing factors

Scope is **Windows-only** (T7), which retires the largest technical risk and the largest
timeline swing up front:

- **xterm-on-webview** — largely retired. WebView2 is Chromium, so the WebGL addon,
  monaco, and charts behave as in today's Electron Chromium. Phase 0 still confirms it,
  but a nasty surprise is now unlikely.
- **Signing / updater toolchain** — a new pipeline (Windows code-signing + Tauri updater);
  always a time sink the first time. Now the main residual risk.
- **Human-in-the-loop cadence** — with Claude Code as executor (§12), the Rust-ramp factor
  is moot; calendar time is paced by verification loops and the human-only signing/
  credential steps, not by code volume or typing speed.

*Deferred (out of scope):* macOS/Linux. Adding them later reintroduces WebKit
(WKWebView/WebKitGTK) validation + per-platform signing/notarization, ~+3–5 weeks.

## 10. Open questions & dependencies

- ~~**Platform scope**~~ — **Resolved: Windows-only** (T7); macOS/Linux deferred (§9).
- ~~**Team size / executor**~~ — **Resolved: Claude Code, agent-driven** (T8, §12).
- **Process isolation** — single webview means one renderer for everything; accepted
  because agents run as separate backend processes (a renderer crash kills no work).
- **Updater feed** — reuse the existing release channel shape or adopt Tauri's default?
- **Tauri version** — pin to a v2.x line before Phase 0.

## 11. Decision log

- **T1 — Order:** Foundation first; build the cockpit on the Tauri foundation rather than
  in Electron then port. *Cockpit is mostly net-new; build it once.*
- **T2 — Containment (overrides redesign D1):** The cockpit is the full-window app shell
  (single webview), not a block inside Wave.
- **T3 — Bridge approach:** Keep the `getApi()` TS interface; swap the implementation to
  Tauri. *Zero churn at the 66 call sites.*
- **T4 — Cuts:** Webview blocks, builder/tsunami, tabs, workspaces, drag-drop — not
  ported (see §6). Workspaces reversible later.
- **T5 — Backend & transport untouched:** Go + `wshrpc`-over-websocket cross the boundary
  unchanged.
- **T6 — Estimate basis:** ~6–9 weeks, one experienced dev; swing factors in §9. *(Team
  size still open per §10.)*
- **T7 — Platform:** Windows-only for the foundation. *Retires the WebKit/xterm risk and
  the macOS/Linux timeline swing; deferrable additions noted in §9.*
- **T8 — Executor:** Claude Code (agent-driven), with the human in the loop for
  verification, credentials/signing, and per-phase review (see §12). *Resolves team size.*

## 12. Execution model

The migration is executed by **Claude Code** (agent-driven), not a human dev team (T8).
This changes what paces the calendar:

- **Mechanical bulk compresses.** Bridge stubs, the teardown deletions (block / tab /
  workspace / builder / `<webview>`), and Rust scaffolding are deterministic and fast to
  generate. The ~6–9-week figure (§8) is human-labor *sizing*, not agent wall-clock; the
  Rust-ramp factor does not apply.
- **The real pacing constraints become:**
  1. **Empirical verification loops** — Phase 0 must be *built and run* on the Windows dev
     machine to confirm the terminal works in WebView2. That build-observe-fix cycle is the
     gate, not code volume.
  2. **Human-only steps** — Phase 4 (code-signing certificates, release-feed / account
     setup, security settings) cannot be performed by the agent; the user supplies
     credentials and runs the signing / publishing steps. This is the main human
     bottleneck.
  3. **Review checkpoints** — each phase ships behind a review gate: a per-phase plan doc,
     agent execution, then human review before the next phase begins.
- **Structure:** one sub-spec + plan per phase (writing-plans → executing-plans),
  executed in order, each independently verifiable on the Windows dev app. Phase 0 first.
