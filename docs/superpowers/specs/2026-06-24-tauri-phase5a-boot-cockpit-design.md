# Tauri Migration — Phase 5a Boot-the-Real-Cockpit Spec

> Captured 2026-06-24. The fourth phase sub-spec under
> [`tauri-migration-meta-spec.md`](../../tauri-migration-meta-spec.md), following
> [`2026-06-24-tauri-phase2-chrome-design.md`](./2026-06-24-tauri-phase2-chrome-design.md).
> Covers the **first half** of the meta spec §8 row **"5 · Frontend teardown"**, which is
> split into **5a (boot the real cockpit on Tauri)** + **5b (teardown + consumer-flips)**.
> Per meta spec §12 each phase is `writing-plans → executing-plans`; this spec is the input
> to the Phase 5a plan.

## 0. Roadmap changes this phase records

Two decisions taken before this spec, applied to the meta spec roadmap (§8):

- **Phase 3 (net-new native — tray, notifications, file-dialog, spawn-editor) is deferred**
  to a future feature roadmap. Rationale: those four are *features*, not *foundation* — none
  is on the critical path to "Wave runs on Tauri." The bridge already carries benign stubs
  for the Electron-shaped ones; the net-new ones have no callers yet. (See feature-triage:
  all four are backlog items.)
- **Phase 5 runs before Phase 4** (packaging). Phases 0–2 ran on a throwaway bare-xterm
  harness; Phase 5 boots the *real* app, which is the foundation milestone worth reaching
  before investing in the human-gated signing/packaging pipeline. Packaging the harness has
  little value; packaging after Phase 5 signs/ships the real thing once.
- **Phase 5 is split 5a/5b** (this spec covers 5a). Rationale: make-it-work-then-delete. 5a
  boots the cockpit with the old machinery *dormant* (bypassed, not deleted); 5b deletes the
  now-provably-dead machinery. A boot regression in a big-bang phase could be the new code or
  the deletion; splitting makes the deletion provably safe.

## 1. Goal

The real agent cockpit (`frontend/app/view/agents/*`) **boots and runs in the Tauri window**
against the unchanged Go backend over `wshrpc`, replacing the Phase 0–2 bare-xterm harness.
The old block-tiling / tab / workspace / builder / `<webview>` machinery still exists but is
**bypassed** (the Tauri entry renders a cockpit shell instead of `<Workspace>`); the Electron
app keeps working in parallel for side-by-side comparison. **No deletions in 5a** — the
teardown is 5b.

This phase proves the **real boot path** (frontend-resolved client/window/workspace/tab over
the unchanged Go services) and that the cockpit's data + interaction surfaces work outside the
block frame. The deletions and the Phase 2 consumer-flips are 5b (§8).

## 2. Guiding rule — relocate the boot, don't rebuild it

Electron's main process did the boot orchestration (resolve client → choose/create window →
workspace → active tab) and pushed the resulting IDs to the renderer via the `wave-init` IPC
(`emain/emain-window.ts` `initializeTab`). The Tauri shell has no such main process and Rust
cannot easily speak `wshrpc`. Two load-bearing facts (verified) make relocating that
orchestration **into the frontend** cheap rather than a rewrite:

- **wavesrv auto-creates the whole object graph.** `EnsureInitialData()`
  (`pkg/wcore/wcore.go:32`) creates the singleton Client → Starter workspace → Window → Tab →
  LayoutState before the frontend connects. So "real boot" is mostly a **read** of
  already-existing objects via the **same unchanged Go services** Electron calls
  (`ClientService.GetClientData`, `WindowService.GetWindow`/`CreateWindow`,
  `WorkspaceService.GetWorkspace`). **Zero new Go, zero new Rust.**
- **The wshrpc route id is inbound-only.** `initWshrpc(makeTabRouteId(tabId))`
  (`frontend/wave.ts:159`) sets the route the backend uses to deliver *inbound* tab-scoped
  events; *outbound* request/response RPC works over any route string
  (`frontend/app/store/wshrouter.ts`). So the frontend can connect with a bootstrap route,
  run the resolution RPCs, then pin the real tab route — no chicken-and-egg.

## 3. Scope

**In scope (5a):**

- Refactor `frontend/wave.ts` `initWave` (`:142`) into a shell-agnostic **`bootWaveCore`** +
  the final render, so Electron and Tauri share the boot and differ only in (a) how IDs are
  obtained and (b) which root component renders.
- A Tauri-only **`resolveBootIds()`** that obtains `(clientId, windowId, workspaceId, tabId)`
  by calling the unchanged Go services after a bootstrap wshrpc connection (§5.1).
- A **cockpit shell root** (`CockpitRoot`) rendered by the Tauri entry: production custom
  titlebar + the agents view full-window + the inline focus pane (§5.2–5.4).
- Mount **`AgentsView` standalone** (outside the block frame) with a synthetic ViewModel
  context (§5.3).
- The **inline focus pane**: render the highlighted agent's terminal in-place via the kept
  `term` view mounted standalone, replacing `setActiveTab` (§5.4).
- Replace the harness (`frontend/tauri/main.tsx` + `terminal-harness.tsx`) with the cockpit
  boot in the **same isolated `frontend/tauri/` entry project** (§5.5, decision P5a-1).
- Any capability permissions the real cockpit's `getApi()` calls require beyond the Phase 1/2
  set (§6).
- Observe-gates on the Windows dev app (§7).

**Out of scope (→ 5b unless noted):** all **deletions** (layout engine, block frame/registry,
tab bar/content, `workspace.tsx`, `builder/`, `tsunami`, `<webview>`); the Phase 2
**consumer-flips** (`ContextMenuModel → buildTauriMenu`; `keymodel → chrome.ts`; delete
`showContextMenu`/`onContextMenuClick`/`updateWindowControlsOverlay`/`onMenuItemAbout` + their
callers + the `api.ts` cut-stubs); **vite/entry unification** and **`emain` / electron-builder
removal** (→ 5b / Phase 4); the redesign cockpit **surfaces** beyond the existing agents view
(Usage/Activity/Sessions/Channels/Memory — redesign meta spec, meta spec §7). The Electron app
stays fully working in parallel through 5a; nothing in `emain/` and nothing in the shared
Electron render path (`App` → `Workspace`) is modified destructively.

### 3.1 Verification vehicle — the real cockpit replaces the harness (decision P5a-2)

Phases 0–2 verified on a throwaway harness because the real chrome/cockpit consumers were
pulled in by the block/tab/workspace machinery. 5a is exactly the step that breaks that
coupling: it mounts the cockpit *without* that machinery. So 5a's verification vehicle **is the
real cockpit** on the Windows dev app (CDP observe-gates), and the harness retires at the end
of 5a (decision P5a-7).

## 4. Why the cockpit can mount outside the block frame

From the coupling map (this session's exploration): the cockpit is *physically* a block today
but *logically* independent.

- `AgentsViewModel` (`frontend/app/view/agents/agents.tsx:615`) accepts
  `{blockId, nodeModel, tabModel}` and **uses none of `nodeModel`/`tabModel`** in its logic.
- Its roster comes from the global `liveAgentsAtom` (`liveagents.ts`), derived from
  `sessionSidebarViewModelAtom`, which reads `atoms.workspace` (a genuinely global,
  per-window atom) — **not** from the tiling layout, block frame, or tab-switch logic.
- It talks to agents via RPC (`agentcomposer.tsx` → `ControllerInputCommand`), not by
  rendering anything block-framed.

The one gesture that *does* depend on the deleted UI is **viewing a terminal**: today
"open the agent's terminal" is `setActiveTab(agent.id)` (`agents.tsx:378,469,567`) — each agent
*is* a tab, and the tiling UI renders its terminal after the switch. 5a replaces that with the
inline focus pane (§5.4). Everything else mounts unchanged.

**Data model survives, UI is replaced:** the Tab/Block/Workspace WaveObjects (and
`atoms.workspace`) are *how agents and terminals exist* and must stay. 5b deletes only the
*visual* layer (tiling, frames, tab bar, workspace layout) — never the object model.

## 5. The Phase 5a primitives

### 5.1 The boot seam — `bootWaveCore` + `resolveBootIds`

Split `initWave` (`frontend/wave.ts:142-209`) so the boot is reusable:

- **`bootWaveCore(initOpts: WaveInitOpts): Promise<void>`** — everything `initWave` does
  *except* the final `createElement(App, …)`/`root.render` (`:202-205`): set
  `activeTabIdAtom`, `GlobalModel.initialize`, `initGlobal`, `initWshrpc(makeTabRouteId(tabId))`,
  `loadConnStatus`/`loadBadges`, the WOS pin of client/window/tab/workspace + layout,
  `subscribeToConnEvents`, `GetFullConfig`/`GetWaveAIModeConfig`. Uses `getApi()` so it is
  shell-agnostic. Electron's `initWave` becomes: `bootWaveCore(opts)` → render `App`.
- **`resolveBootIds(): Promise<WaveInitOpts>`** (Tauri-only) — obtains real IDs without
  Electron's main process:
  1. connect a **bootstrap** wshrpc route (a throwaway `tab:boot-<uuid>` — outbound RPC is
     route-agnostic, §2);
  2. `ClientService.GetClientData()` → `clientId`, `windowIds[]`;
  3. `windowId` = `GetWindow(windowIds[0])` if present, else `WindowService.CreateWindow(null, "")`;
  4. `workspaceId` = `window.workspaceid`; `GetWorkspace(workspaceId)` →
     `tabId = workspace.activetabid` (auto-created by wavesrv; if somehow absent,
     `CreateTab(workspaceId, "", true)`);
  5. return `{ clientId, windowId, tabId, ... }`.
  The bootstrap connection is one-shot; `bootWaveCore`'s `initWshrpc(makeTabRouteId(tabId))`
  then establishes the **permanent** inbound tab route. (Exact reconnect/re-pin mechanism is a
  plan detail; the verified invariant is that outbound resolution RPC needs no real tab route.)

The Tauri entry's boot is therefore: `resolveBootIds()` → `bootWaveCore(ids)` → render
`CockpitRoot`. **Rust is untouched** — `wave-init` keeps emitting empty opts; the Tauri
frontend ignores them and resolves its own (decision P5a-3).

### 5.2 The cockpit shell root (`CockpitRoot`)

A new root component the Tauri entry renders into `#main`, replacing
`App → Provider → Workspace`. It provides the global React context the cockpit needs
(`Provider store={globalStore}`, `WaveEnvContext`) but **not** `TabModelContext`/`DndProvider`
tab plumbing. Layout: production titlebar on top, the agents surface filling the rest, with the
inline focus pane as a region within it. Surfaces beyond the agents view are not built here
(redesign scope).

### 5.3 Production titlebar + standalone agents mount

- **Production titlebar** — the real custom titlebar deferred from Phase 2 §7 (the harness
  strip was throwaway): drag region (`data-tauri-drag-region`) + minimize / maximize / close
  wired to the Phase 2 `chrome.ts` window controls, styled with Wave `@theme` tokens. Reuses
  the Phase 2 capabilities (`core:window:*`); no new Rust.
- **Standalone `AgentsView`** — instantiate `AgentsViewModel` with a synthetic context
  (`nodeModel`/`tabModel` unused → minimal/synthetic; a synthetic `blockId` if any code path
  reads it). Render its `viewComponent` directly in `CockpitRoot` instead of through
  `block.tsx`/`blockframe.tsx`.

### 5.4 Inline focus pane — the `setActiveTab` replacement (decision P5a-4)

Replace `setActiveTab(agent.id)` with in-place rendering of the focused agent's terminal:

- The cockpit already tracks a focused agent (`focusAgent`/`focusId`, `agents.tsx`); the pane
  renders the **focused agent's terminal block** by mounting the kept `term` view
  (`frontend/app/view/term/`) standalone — instantiate its ViewModel for the agent's terminal
  `blockId` (available from the roster's block oref) and render its component outside the block
  frame.
- The agent's terminal `blockId` is resolved from the same roster data that drives the list
  (per-agent block oref). Input continues to flow via the existing composer
  (`ControllerInputCommand`); the pane adds the missing **output/view**.
- `onOpenTerminal` / the `t` key (`agents.tsx:128,142,469,567`) switch the focus pane target
  instead of calling `setActiveTab`. (In 5a `setActiveTab` may remain imported as a dormant
  no-op-ish call; its *removal* is 5b with the tab teardown.)

This is the highest-risk item in 5a (it pulls a slice of the redesign "Focus" surface forward,
unstyled). If anything in 5a must be isolated, it is this (decision P5a-5).

### 5.5 Tauri entry swap

`frontend/tauri/main.tsx` keeps installing the bridge (`installTauriApi` from `api.ts`, which
already wires Phase 1 boot/env + Phase 2 chrome via `chrome.ts`/`menu.ts`) and then runs the
cockpit boot (§5.1) instead of mounting `terminal-harness.tsx`. The entry imports the real
cockpit from `@/app/*`. `terminal-harness.tsx` is deleted at the end of 5a (P5a-7). The
`frontend/tauri/` project stays a **separate vite entry** (P5a-1) so the Electron build is
untouched in 5a; entry/vite unification is 5b/Phase 4.

## 6. Rust / config / capabilities surface

- **No new Rust commands and no new Go.** 5a is frontend-only: the boot relocates to the
  renderer using existing services; the titlebar reuses Phase 2 window permissions; the
  terminal/PTY path is the same `wshrpc` one Phase 0 proved.
- **Capabilities:** start from the Phase 1/2 set (`src-tauri/capabilities/default.json`). The
  real cockpit may exercise `getApi()`/RPC paths the harness didn't; any *additional* core
  permission a real call needs is added here and **verified at build time** (the `tauri-build`
  codegen rejects unknown permission strings loudly, as in Phase 1 §6.0 / Phase 2 §6.3). No
  permission is added speculatively — only when a real boot path demands it.

## 7. Verification (per meta spec §12)

Pure refactor logic (`resolveBootIds`, `bootWaveCore` split) is unit-tested where it has
testable seams (mock the Go service calls + `getApi()`); integration is verified by
observe-gates on the Windows dev app (CDP, [[cdp-verify-dev-app]]).

**Unit tests** (jsdom-free, mocking `@tauri-apps/api/*` and the RPC client as in Phase 1/2):
- `resolveBootIds`: empty `windowIds` → `CreateWindow` is called; non-empty → `GetWindow` only;
  returns `tabId = workspace.activetabid`; falls back to `CreateTab` when no active tab.
- `bootWaveCore` is invoked by both the Electron and Tauri paths with the resolved opts
  (delegation seam intact; Electron path otherwise unchanged).

**Observe-gates** (real cockpit on the Windows dev Tauri app):
1. **Boots** — the Tauri window comes up into the cockpit shell (titlebar + agent roster), no
   crash, no white screen; the Rust console shows the resolved IDs.
2. **Real roster** — the roster lists the actual agents in the running workspace (matches what
   Electron shows side-by-side).
3. **Inline terminal** — highlighting an agent renders its live terminal inline; new PTY output
   appears; the composer's input reaches the PTY (proves the focus pane + standalone term mount).
4. **Chrome intact** — Phase 2 still works in the real shell: drag/min/max/close, zoom
   (`+`/`-`/`0` + `--zoomfactor` var), fullscreen (F11), right-click `buildTauriMenu`.
5. **No happy-path stub** — boot + roster + focus a terminal triggers no `[tauri-bridge] stub
   called:` warning (cut/obsolete methods aren't on the cockpit's happy path).

## 8. Deferred to 5b (and Phase 4)

- **Deletions:** `frontend/layout/` (tiling engine), `frontend/app/block/` (frame + registry,
  pruned to what the cockpit keeps), `frontend/app/tab/` (tab bar/content — **except**
  `sessionsidebar/agentstatusstore.ts` + the session/agent stores the cockpit reads),
  `frontend/app/workspace/`, `frontend/builder/`, `frontend/app/view/tsunami/`,
  `frontend/app/view/webview/`. (~62 files / ~15.5k LOC by the coupling-map estimate.)
- **Consumer-flips (from Phase 2 §7):** `ContextMenuModel` → `buildTauriMenu` (delete
  `showContextMenu`/`onContextMenuClick`); `keymodel.ts` → `chrome.ts`
  (zoom/chord/ctrl-shift); delete `updateWindowControlsOverlay` (+ its `app-bg.tsx` caller) and
  `onMenuItemAbout`; remove the `api.ts` cut-stubs once their callers are gone; remove
  `setActiveTab` with the tab teardown.
- **Unify the Tauri entry into the main app build**, and remove **`emain/` + electron-builder**
  (the shared Electron render path breaks once `Workspace` is deleted — expected) → 5b / Phase 4.

## 9. Layout

```
frontend/
  wave.ts (modify)        extract bootWaveCore() from initWave(); Electron path = bootWaveCore → render App
  app/cockpit/ (new)
    cockpit-root.tsx      CockpitRoot: provider context + titlebar + agents + focus pane (§5.2)
    titlebar.tsx          production custom titlebar over chrome.ts window controls (§5.3)
    focus-pane.tsx        standalone term view for the focused agent (§5.4)
  app/view/agents/*       UNCHANGED logic; mounted standalone (no block frame)
  app/view/term/*         UNCHANGED; mounted standalone by the focus pane
frontend/tauri/
  main.tsx (modify)       install bridge, then resolveBootIds → bootWaveCore → render CockpitRoot
  bootids.ts (new)        resolveBootIds(): GetClientData → window → workspace → activetab (§5.1)
  bootids.test.ts (new)   unit tests for resolveBootIds (§7)
  terminal-harness.tsx    DELETED at end of 5a (P5a-7)
src-tauri/
  capabilities/default.json   + any real-boot-required core permission (verified at build, §6)
  src/                        UNCHANGED (no new Rust — P5a-3)
```

## 10. Decision log

- **P5a-1 — Isolated Tauri entry:** 5a keeps `frontend/tauri/` as a separate vite entry that
  imports `@/app/*`, rather than making the main app's vite build multi-entry. *Lowest risk to
  the still-working Electron build during 5a; entry/vite unification defers to 5b/Phase 4.*
- **P5a-2 — Verification vehicle:** the real cockpit on the dev app replaces the harness.
  *5a is the step that decouples the cockpit from the block/tab machinery, so it can finally be
  the test vehicle.*
- **P5a-3 — Boot relocates to the frontend; zero new Rust/Go:** `resolveBootIds` calls the
  unchanged Go services; Rust keeps emitting empty `wave-init`. *wavesrv auto-creates the object
  graph (`EnsureInitialData`) and the wshrpc route is inbound-only, so relocation is ~4 RPCs.*
- **P5a-4 — Inline focus pane replaces `setActiveTab`:** keep the `term` view, mount it
  standalone for the focused agent. *The only cockpit gesture that depended on the deleted tab
  UI; required for a dogfoodable app when Phase 5 ends.*
- **P5a-5 — Inline terminal lands in 5a, not 5b:** 5b is deletion-only. *It is also the
  highest-risk 5a item; if 5a must shed scope, isolate this.*
- **P5a-6 — Data model survives:** delete the tab/block/layout *UI* (5b), never the
  Tab/Block/Workspace WaveObjects or `atoms.workspace`. *They are how agents and terminals
  exist; the cockpit reads them.*
- **P5a-7 — Harness retires at end of 5a:** `terminal-harness.tsx` (+ its mount) is throwaway
  once the real cockpit boots.

## 11. Spec coverage

§2 rule (relocate, don't rebuild) → §5.1 boot seam + §6 (no new Rust/Go). §4 (mountable outside
the frame) → §5.3 standalone mount + gate 2; the one coupling (terminal view) → §5.4 + gate 3.
§5.1 → unit tests + gate 1; §5.3 titlebar → gate 4 (reuses Phase 2); §5.4 → gate 3. §3 in/out →
§8 maps every deferral to 5b/Phase 4. §7 maps each gate + test to a primitive. §10 decisions
each trace to a section. Each in-scope primitive (§5.1–5.5) has a verification in §7 and a
decision in §10.
