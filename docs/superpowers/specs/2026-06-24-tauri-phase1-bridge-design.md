# Tauri Migration — Phase 1 Bridge Spec (Day-One Native Bridge)

> Captured 2026-06-24. The second phase sub-spec under
> [`tauri-migration-meta-spec.md`](../../tauri-migration-meta-spec.md), following
> [`2026-06-24-tauri-phase0-spike-design.md`](./2026-06-24-tauri-phase0-spike-design.md).
> The meta spec §5 deferred "the full tiered table with call sites" to this spec; this is
> that table plus the bridge's implementation strategy. Per meta spec §12 each phase is
> `writing-plans → executing-plans`; this spec is the input to the Phase 1 plan.

## 1. Goal

Replace Phase 0's 18-line `frontend/tauri/api-shim.ts` mock with a **real, type-complete
`window.api`** implemented over Tauri `invoke`/events, so the unchanged `getApi():
ElectronApi` interface (`frontend/app/store/global.ts:358` — `return (window as any).api`)
works transparently on Tauri for the **boot + env/identity + terminal-basics** slice
(meta spec §8). Zero changes at the 66 call sites (meta spec T3).

This phase proves the bridge *as an interface contract*, not the full app: it is verified
on an extended bare-xterm harness, not the production Terminal component (see §3).

## 2. Scope

**In scope:** the real `window.api` for the day-one method set (§5), uniform typed stubs
for everything else, the Rust commands/events backing them, and harness-driven
verification.

**Out of scope:** the real Terminal/cockpit boot (Phase 5), window chrome + interaction —
titlebar, zoom, fullscreen, context menus, chord mode (Phase 2), net-new native — tray,
notifications, file-dialog-as-feature, spawn-editor (Phase 3), packaging + sidecar
bundling + updater (Phase 4), and teardown/cut-method deletion + real-boot auth rewiring
(Phase 5). The existing Electron app stays fully working in parallel; nothing in `emain/`
is touched.

### 2.1 Verification vehicle — extended harness, not the real Terminal (decision P1-1)

Phase 1 verifies the bridge on the **Phase 0 bare-xterm harness, extended**, *not* the
production `TermViewModel`. This is a hard code constraint, not a preference:
`frontend/app/view/term/term-model.ts:46-95` declares `implements ViewModel`, takes
`{ blockId, nodeModel, tabModel }`, and transitively pulls in `BlockNodeModel`,
`TabModel`, `WorkspaceLayoutModel`, `WaveAIModel`, `createBlock*`, `useBlockAtom`, and the
`WOS` wave-object store. Mounting it requires the block/tab/workspace scaffolding — the
exact subsystem the meta spec deletes in **Phase 5**. So the production Terminal can only
come online *after* Phase 5 gives it a minimal block/tab shell. Phase 1 proves the bridge
contract; Phase 5 proves it inside the real component.

## 3. The core problem — synchronous getters over an async transport

The Electron preload (`emain/preload.ts`) exposes **synchronous** getters via
`ipcRenderer.sendSync`:

```ts
getEnv: (varName) => ipcRenderer.sendSync("get-env", varName),   // returns string
getPlatform: () => ipcRenderer.sendSync("get-platform"),          // returns NodeJS.Platform
```

Call sites depend on that synchronicity. `frontend/util/endpoints.ts:16-18` does
`` `ws://${getEnv(WSServerEndpointVarName)}` `` inline, and `frontend/wave.ts:67` does
`updateZoomFactor(getApi().getZoomFactor())`. **Tauri has no `sendSync`** — `invoke()` is
async-only (`Promise<T>`), and browser/WebView2 JS cannot block on a promise. A
`() => string` signature cannot be satisfied by `await invoke(...)`.

**Resolution — boot-prefetch + synchronous cache** (the pattern Phase 0 already used in
`main.tsx:24-32`): before any module that reads `getApi()` is imported, `await` a single
Tauri command that returns *all* sync-getter data, cache it in module scope, and let the
synchronous getters read the cache. Every `ElectronApi` method then maps by its Electron
primitive:

| Electron primitive | Methods (examples) | Tauri implementation |
|---|---|---|
| `sendSync` (sync return) | `getEnv`, `getAuthKey`, `getPlatform`, `getIsDev`, `getUserName`, `getHostName` | read from boot-prefetch cache (synchronous) |
| `send` (fire-and-forget) | `sendLog`, `openExternal`, `nativePaste`, `incrementTermCommands` | `invoke(cmd, args).catch(noop)` |
| `invoke` (Promise) | `saveTextFile`, `setIsActive` | `invoke(cmd, args)` passthrough |
| `on` (event listener) | `onWaveInit` | Tauri `listen(event, e => cb(e.payload))` |

This split *is* the bridge design; the rest is filling in per-method commands.

## 4. Bridge module shape (decision P1-2)

One file: **`frontend/tauri/api.ts`**, exporting `installTauriApi(init: InitData)`, built
as a **flat object literal mirroring `emain/preload.ts` line-for-line** so the Electron and
Tauri implementations stay diffable against the single `ElectronApi` type. It absorbs and
deletes `api-shim.ts` (and the inline `getEnv`/`__waveAuthKey` hacks in `main.tsx:25-32`).

No per-domain module split (boot/env/terminal/events). The real method count is ~14; a
single file is below the "doing too much" threshold and matches the existing preload's
shape. (YAGNI; revisit only if it actually grows.)

Ordering discipline (preserve from Phase 0): `installTauriApi` runs synchronously *after*
the boot prefetch resolves and *before* importing any module that reads `getApi()` at
module-eval time (`ws`, `wshrpcutil-base`, etc.).

## 5. Method tiering — the full table

`ElectronApi` has 60 methods; ~41 are called from the frontend, ~19 are dead (almost all
in cut subsystems — webview/builder/tabs/workspaces). Phase 1 gives **~12 a real
implementation** and **everything else a typed stub**.

### 5.1 Day-one (real implementation)

The meta spec §8 slice — Boot + env/identity + terminal basics:

| Method | Primitive | Tauri impl | Notes |
|---|---|---|---|
| `getEnv(varName)` | sync | prefetch cache | returns `WAVE_SERVER_WS/WEB_ENDPOINT` from `get_init` |
| `getAuthKey()` | sync | prefetch cache | load-bearing on Tauri — see §7 |
| `onWaveInit(cb)` | event | `listen("wave-init")` | round-trip only; payload scoped in §6.1 |
| `setWindowInitStatus(status)` | send | `invoke("set_window_init_status")` | triggers `wave-init` emit on `"ready"` |
| `getPlatform()` | sync | prefetch cache | `"win32"` (Windows-only, T7) |
| `getIsDev()` | sync | prefetch cache | Tauri dev flag |
| `getUserName()` | sync | prefetch cache | from Rust |
| `getHostName()` | sync | prefetch cache | from Rust |
| `sendLog(log)` | send | `invoke("fe_log").catch(noop)` | rename of Phase 0 `harness_log` |
| `setIsActive()` | invoke | `invoke("set_is_active")` | returns `Promise<void>` |
| `openExternal(url)` | send | `invoke("open_external")` (§5.3) | guards non-string url like preload |
| `incrementTermCommands(opts)` | send | `invoke("increment_term_commands").catch(noop)` | telemetry; Rust may no-op |

`nativePaste` and `saveTextFile` were dropped from the day-one set during planning (P1-6):
reading their Electron handlers showed each is a tentacle of a *later* phase, not a
self-contained terminal method. `native-paste` is `event.sender.paste()`
(`emain-ipc.ts:457`) — a focused-webContents paste with no Rust→WebView2 equivalent; its
real wiring needs the focused Terminal (Phase 5). `save-text-file` calls
`electron.dialog.showSaveDialog` (`emain-ipc.ts:516`) — an interactive save dialog, i.e.
the Phase 3 net-new "file-dialog". Both are stubbed in Phase 1 (§5.2).

### 5.2 Stubbed (deferred + cut, ~46 methods)

Everything not in §5.1 gets a **uniform typed benign-default stub** — *not* a bare throw,
because the bridge implements the complete `ElectronApi` type and an incidental call must
not crash:

- `send`/event methods → no-op (event listeners never fire).
- typed sync getters → benign default (`getZoomFactor → 1`, `getCursorPoint → {x:0,y:0}`,
  `getUpdaterStatus → {status:"unavailable"}`-shaped default, dir getters → `""`).
- `invoke`-returning methods → resolved Promise (`closeTab → Promise.resolve(false)`,
  `captureScreenshot → Promise.resolve("")`, `clearWebviewStorage → Promise.resolve()`).
- each stub logs once (deduped by name) on first call, so a real dependency surfaces
  loudly during later phases.

These split into **deferred** (updater, `openNativePath`, `downloadFile` → real impls in
Phase 2/3; `saveTextFile` → Phase 3 with the file-dialog; `nativePaste` → Phase 5 with the
real Terminal) and **cut** (webview/builder/tabs/workspaces/`getPathForFile` → deleted with
callers in Phase 5, meta spec §6). For Phase 1 they are identical: stub. The split is
documented for the later phases, not acted on here.

### 5.3 Terminal-basics OS access

`openExternal(url)` is the only day-one method needing OS access. Implement it as our own
Rust `#[command] open_external` wrapping the lightweight **`open` crate** (`open = "5"`),
not a Tauri plugin: a self-defined command is capability-exempt and needs no JS package,
keeping the dependency footprint to a single small crate (matches the minimal-deps
preference). `incrementTermCommands`, `sendLog`, `setIsActive` need no OS access.

## 6. Rust surface additions

On top of Phase 0's `get_init` and `harness_log` (`src-tauri/src/init.rs`):

- **Extend the boot prefetch** so one round trip feeds all sync getters: `InitData` (or a
  sibling `get_env_info` command) gains `platform`, `isDev`, `userName`, `hostName`. One
  `await`, not one per getter.
- **New commands:** `set_window_init_status(status)`, `fe_log(msg)` (rename
  `harness_log`), `set_is_active()`, `open_external(url)`, `increment_term_commands(opts)`.
- **New event:** `wave-init`, emitted by `set_window_init_status` when status is `"ready"`.
- Register all in `tauri::generate_handler![...]` (`src-tauri/src/main.rs:64`).

### 6.0 Capabilities (mandatory — decision P1-7)

Phase 0 has no `src-tauri/capabilities/` file: self-defined `invoke` commands are exempt
from the v2 permission system. Phase 1 introduces the first **event** usage, and the JS
`listen()` API routes through the built-in event plugin, which **requires** the
`core:event:default` permission. Without a capability file, `onWaveInit`'s `listen` is
denied at runtime. Add `src-tauri/capabilities/default.json` granting `core:default` +
`core:event:default`, scoped to the main window (give the config window an explicit
`"label": "main"` so the capability target is unambiguous).

### 6.1 Boot-handshake scope (decision P1-3)

Phase 1 implements the `setWindowInitStatus("ready") → wave-init emit → onWaveInit(cb)`
**round-trip mechanism** with a **minimal payload**, to (a) complete the boot seam
described in meta spec §4 and (b) prove the Rust→FE event path that every deferred event
method (`onZoomFactorChange`, `onFullScreenChange`, `onUpdaterStatusChange`,
`onContextMenuClick`, …) will reuse.

It does **not** assemble the real `WaveInitOpts` (`{tabId, clientId, windowId, activate,
primaryTabStartup?}`, `custom.d.ts:66-71`). Electron sources those IDs from window/
workspace state (`emain-window.ts`) — the machinery being cut — so the real assembly
belongs to Phase 5's boot rewiring. The harness continues to obtain `tabId` via
`WorkspaceListCommand` (as in Phase 0 `main.tsx:59-62`), independent of the handshake.

## 7. Auth (decision P1-4)

On Tauri the renderer's websocket carries the authkey as a **query param**, not a header.

Why: Electron authenticates the renderer's socket via session header-injection —
`emain/authkey.ts:15-22` registers `session.webRequest.onBeforeSendHeaders` to stamp
`X-AuthKey` on every request (`emain.ts:406`, `emain-tabview.ts:356`). That is why
`wave.ts:159` boots through `initWshrpc` with **no** authkey in the URL and still connects.
WebView2 has no `onBeforeSendHeaders` equivalent and browser JS cannot set WebSocket
headers, so that channel is unavailable.

The query-param path already exists and is production code: `buildWsConnUrl`
(`frontend/util/wsutil.ts:27-33`) appends `&authkey=`, fed from `WSControl.eoOpts.authKey`
(`ws.ts:76`). Phase 0 used it successfully. Therefore:

- The bridge implements `getApi().getAuthKey()` returning the `get_init` authkey
  (replacing Phase 0's `window.__waveAuthKey` hack).
- The harness connects via `initElectronWshrpc(client, { authKey })`
  (`wshrpcutil-base.ts:114`), threading the key into the existing query-param plumbing.
  Backend and transport are unchanged (meta spec T5).

`getAuthKey()` is uncalled in Electron precisely because the main process hid auth in
header-injection; the runtime swap promotes it from dead method to load-bearing boot
method. **Deferred to Phase 5:** rewiring the real `wave.ts` boot (which uses `initWshrpc`
without an authkey) to carry the key on Tauri — decided then between threading `eoOpts`
vs. having the ws transport self-serve `getAuthKey()`.

## 8. Layout (all additive)

```
src-tauri/
  Cargo.toml                  + open = "5"
  tauri.conf.json             window gets explicit "label": "main"
  capabilities/default.json   (new) core:default + core:event:default, windows ["main"]
  src/
    init.rs            extend InitData (platform/isDev/userName/hostName); rename harness_log→fe_log
    main.rs            register new commands + populate extended InitData
    commands.rs (new)  set_window_init_status (+ wave-init emit), set_is_active,
                       open_external, increment_term_commands
frontend/tauri/
  api.ts (new)       installTauriApi(init): the full window.api (replaces api-shim.ts)
  api-shim.ts        DELETED (absorbed into api.ts)
  main.tsx           use installTauriApi; drop __waveAuthKey + inline getEnv hacks
  terminal-harness.tsx  + observe-gate affordances (open-external + init-status buttons)
  api.test.ts (new)  unit tests: prefetch-cache wrapper, stub defaults, event subscribe
```

## 9. Verification (per meta spec §12)

Pure logic is unit-tested TDD-style; integration is verified by explicit observe-gates on
the Windows dev app. The gate is real, not a substitute for the tests.

**Unit tests (`api.test.ts`):**
- sync getters return the prefetched values after `installTauriApi`.
- stub defaults are correct and type-safe (event no-op, getter default, invoke resolves).
- `onWaveInit` registers a listener and the callback receives the emitted payload.

**Observe-gates (harness on Windows dev app):**
1. Endpoints resolve through the *real* `getEnv` (no inline override) → ws connects,
   authenticated by query param (re-confirms Phase 0 through the real bridge).
2. `setWindowInitStatus("ready")` → Rust emits `wave-init` → `onWaveInit` callback fires
   with the minimal payload (boot round-trip). Proves the capability file (§6.0) is wired.
3. A harness "open-external" affordance → `openExternal(url)` opens the default browser.
4. `incrementTermCommands`/`sendLog`/`setIsActive` invoke without error.
5. No stub is hit on the harness happy path (the dedup logger stays silent).

## 10. Decision log

- **P1-1 — Verification vehicle:** extended bare-xterm harness, not the production
  Terminal. *`TermViewModel` is welded to blocks/tabs/workspace (cut until Phase 5).*
- **P1-2 — Bridge shape:** single `frontend/tauri/api.ts`, flat object mirroring
  `preload.ts`. *Diffable against the one `ElectronApi` type; ~14 methods; YAGNI on splitting.*
- **P1-3 — Boot handshake:** implement the `wave-init` round-trip mechanism with a minimal
  payload; defer real `WaveInitOpts` assembly to Phase 5. *The IDs come from cut
  window/workspace state.*
- **P1-4 — Auth:** query-param authkey via the existing `eoOpts`/`buildWsConnUrl` path;
  `getAuthKey()` becomes load-bearing. *WebView2 has no header-injection; real-boot
  rewiring is Phase 5.*
- **P1-5 — Stubs:** everything outside the day-one set gets a typed benign-default stub
  (not a throw), logged once. *Keeps `window.api` type-complete; deletion is Phase 5.*
- **P1-6 — Terminal-basics narrowed:** day-one terminal methods are `openExternal` +
  `incrementTermCommands` only; `saveTextFile` (→ Phase 3 file-dialog) and `nativePaste`
  (→ Phase 5 focused-Terminal paste) are stubbed. *Their handlers are tentacles of later
  phases, not self-contained terminal methods.* Shrinks the OS-dep footprint to one crate.
- **P1-7 — Capabilities file required:** add `capabilities/default.json` with
  `core:event:default`. *The first event usage needs it; self-defined `invoke` did not.*

## 11. Spec coverage

§3 sync/async pattern → §5 tiering + §6 Rust; §5.1 day-one → tests + gates 1-4; §5.2 stubs
→ gate 5 + unit test; §6.0 capabilities → gate 2; §6.1 handshake → gate 2; §7 auth → gate
1; §9 maps every gate to a spec section. Each method in §5.1 has a backing Rust command in
§6 and a verification in §9.
