# Tauri Migration — Phase 2 Chrome + Interaction Spec

> Captured 2026-06-24. The third phase sub-spec under
> [`tauri-migration-meta-spec.md`](../../tauri-migration-meta-spec.md), following
> [`2026-06-24-tauri-phase1-bridge-design.md`](./2026-06-24-tauri-phase1-bridge-design.md).
> Covers the meta spec §8 row **"2 · Chrome + interaction"**: custom titlebar, zoom,
> fullscreen, context menus, chord mode. Per meta spec §12 each phase is
> `writing-plans → executing-plans`; this spec is the input to the Phase 2 plan.

## 1. Goal

Make the **window-shell + interaction** methods real on the **extended bare-xterm harness
plus a minimal custom titlebar**, so the unchanged `getApi(): ElectronApi` interface serves
the chrome/interaction slice on Tauri. Phase 1 left these as benign stubs
(`getZoomFactor → 1`, `onFullScreenChange → noop`, `showContextMenu`, `setKeyboardChordMode`,
…); Phase 2 turns the ones that belong here into real implementations and explicitly **cuts**
the ones the redesign replaces.

This phase proves the chrome bridge *as an interface contract + the underlying Tauri
primitives*, not the production cockpit. The real cockpit titlebar, and the consumer-flip that
deletes the cut methods, are Phase 5 (§7).

## 2. Guiding rule — keep the wrapper, cut the workaround

This phase applies the migration principle that refines meta spec T3 ("keep `getApi()`, swap
the impl"). T3 is a churn-avoidance convenience, **not** a mandate to enshrine Electron-shaped
contracts. Since the cockpit is net-new:

- **Keep the contract, implement real** where the method is a thin value/event wrapper that
  survives into the cockpit unchanged: `getZoomFactor`, `onZoomFactorChange`,
  `onFullScreenChange`, `onControlShiftStateUpdate`, `getAboutModalDetails`.
- **Build the Tauri-native primitive and let the method die** where the contract is an
  Electron-IPC-shaped workaround the redesign replaces: `showContextMenu` /
  `onContextMenuClick`. The two methods stay benign stubs **marked "cut, not ported"**; the
  reusable `buildTauriMenu` primitive is written now; the consumer-flip
  (`ContextMenuModel` → `buildTauriMenu`, delete the methods) is Phase 5.
- **Cut outright** where the method is obsolete under the new shell:
  `updateWindowControlsOverlay` (we draw window buttons in CSS), `onMenuItemAbout` (no native
  menubar under a custom titlebar).

## 3. Scope

**In scope:** `decorations:false` + a minimal harness titlebar; real `getZoomFactor` /
`onZoomFactorChange` (JS-owned zoom controller); real `onFullScreenChange`; real
`onControlShiftStateUpdate`; `setKeyboardChordMode` as an intentional real no-op; real
`getAboutModalDetails` from the boot cache; the `buildTauriMenu` primitive + harness
verification; the capability permissions the Tauri JS APIs require; harness observe-gates.

**Out of scope:** the production cockpit titlebar (Phase 5); the consumer-flip that rewires
`ContextMenuModel` and `keymodel.ts` and deletes the cut methods (Phase 5); net-new native —
tray, notifications, file-dialog, spawn-editor (Phase 3); packaging + sidecar bundling +
updater (Phase 4); real-boot auth rewiring (Phase 5). The existing Electron app stays fully
working in parallel; nothing in `emain/` is touched.

### 3.1 Verification vehicle — extended harness + minimal titlebar (decision P2-1)

Phase 2 verifies on the **Phase 1 bare-xterm harness, extended with a minimal custom
titlebar**, *not* the production cockpit. Same hard constraint as Phase 1 §2.1: the real
chrome consumers (`wave.ts`, `global-atoms.ts`, `ContextMenuModel`, `keymodel.ts`) are pulled
in by the block/tab/workspace machinery the meta spec deletes in Phase 5, so they cannot be
mounted yet. The harness titlebar (drag region + min/maximize/close) is a *capability proof*,
not the cockpit titlebar; it also gives the now-undecorated window a way to be moved/closed.

## 4. Per-method disposition

`ElectronApi` chrome/interaction methods and their Phase 2 fate. Electron sources are from the
exploration of `emain/preload.ts`, `emain/emain-ipc.ts`, `emain/emain-util.ts`,
`emain/emain-window.ts`, `emain/emain-menu.ts`.

### 4.1 Keep contract, implement real

| Method | Electron behavior | Tauri impl (Phase 2) |
|---|---|---|
| `getZoomFactor()` (sync) | `webContents.getZoomFactor()` | read the JS zoom controller's current factor (§5.1) |
| `onZoomFactorChange(cb)` (event) | renderer subscribes to `zoom-factor-change` broadcast | register `cb` with the zoom controller |
| `onFullScreenChange(cb)` (event) | `enter/leave-full-screen` → `fullscreen-change` | register `cb`; fired by the JS fullscreen toggle (§5.2) |
| `onControlShiftStateUpdate(cb)` (event) | main-process `before-input-event` computes Ctrl+Shift held → `control-shift-state-update` | a JS keydown/keyup listener computes it in the webview (§5.3) |
| `getAboutModalDetails()` (sync) | `{version, buildTime}` from wavesrv | return `{version, buildTime}` from the existing `InitData` boot cache |

Consumers that survive unchanged: `frontend/wave.ts` (`updateZoomFactor` → `--zoomfactor`
CSS var), `frontend/app/store/global-atoms.ts` (`zoomFactorAtom`, `isFullScreenAtom`),
`frontend/app/store/keymodel.ts` (`registerControlShiftStateUpdateHandler`),
`frontend/app/modals/about.tsx` (`AboutModalDetails`).

### 4.2 Build primitive, let method die (decision P2-2)

| Method | Phase 2 fate |
|---|---|
| `showContextMenu(id, template)` | **stub, marked cut.** Not ported. |
| `onContextMenuClick(cb)` | **stub, marked cut.** Not ported. |

The id round-trip (template-with-ids → native menu → `contextmenu-click` by id →
`ContextMenuModel` looks up the local `click`) exists only because Electron IPC can't pass a
function across the process boundary. Tauri's `@tauri-apps/api/menu` builds the menu in JS
with `action` closures firing directly, so the round-trip is pure dead weight. Phase 2 writes
the **`buildTauriMenu(items: ContextMenuItem[])`** primitive (§5.4) — the long-term code
Phase 5's `ContextMenuModel` will import — and verifies it on the harness. The two
`ElectronApi` methods remain Phase-1-style benign stubs (so the interface stays type-complete
and an incidental call can't crash); they are deleted in Phase 5 with the consumer-flip.

### 4.3 Real no-op (decision P2-4)

| Method | Why a no-op is correct |
|---|---|
| `setKeyboardChordMode()` | On Electron this set a main-process flag so the `before-input-event` handler could pass/suppress the next keystroke. Tauri has no main-process key interception — the webview sees every key first, and `keymodel.ts`'s own JS chord timer (`setActiveChord`/`resetChord`) is the real mechanism. There is nothing native to coordinate, so the bridge method is a documented intentional no-op (removed from the stub list, given an explicit empty body + comment, so it isn't mistaken for an unimplemented stub). |

### 4.4 Cut outright (decision P2-5, P2-6)

| Method | Why cut |
|---|---|
| `updateWindowControlsOverlay(rect)` | Recolors **OS-drawn** min/max/close buttons via Electron's `titleBarOverlay`. Under a full custom titlebar (`decorations:false`) we draw the buttons in React/CSS, so there is nothing to recolor. Stays a no-op stub; its caller (`frontend/app/app-bg.tsx`) is deleted with the block layout in Phase 5. |
| `onMenuItemAbout(cb)` | Fired by a native app-menu item "About Wave Terminal". No native menubar exists under a custom titlebar; the cockpit opens the About modal from in-app UI. Stays a no-op stub. |

## 5. The Tauri chrome primitives

All chrome/interaction logic on Tauri lives in the webview (JS) and routes through Tauri's
built-in **core plugins** (window/webview/menu/event) — so it needs capability permissions
(§6) but **no new Rust commands** (§6.1, decision P2-7). Two new focused TS modules hold the
primitives; `api.ts` stays the thin `ElectronApi` map and delegates to them (decision P2-8).

### 5.1 Zoom controller (`frontend/tauri/chrome.ts`)

Electron tracked a real per-`webContents` zoom factor and broadcast changes; WebView2/Tauri
exposes `getCurrentWebview().setZoom(factor)` (from `@tauri-apps/api/webview`) but **owns no
zoom-factor state and emits no change event**, and the Ctrl+/Ctrl-/Ctrl+0 accelerators were
main-process-only (`emain-util.ts` `increase/decrease/resetZoomLevel`). So the controller is
the new JS home for that logic:

- module-scope `factor` (init `1`) + a subscriber list.
- `getZoomFactor(): number` — returns `factor`.
- `onZoomFactorChange(cb)` — registers `cb`.
- `zoomIn()` / `zoomOut()` / `zoomReset()` — clamp + step the factor (mirror Electron's
  `MinZoomLevel`/`MaxZoomLevel`/`ZoomDelta`), call `setZoom(factor)`, notify subscribers.
- bind Ctrl+`=` / Ctrl+`-` / Ctrl+`0` (+ Shift variants) to these via a keydown listener, so
  zoom works from the keyboard as it did in Electron. (Used by the harness now; Phase 5's
  `keymodel.ts` calls the same `zoomIn/Out/Reset`.)

`wave.ts`'s `updateZoomFactor` (CSS var) is driven for free via `onZoomFactorChange`.

### 5.2 Fullscreen toggle (`frontend/tauri/chrome.ts`)

- `onFullScreenChange(cb)` — registers `cb`.
- `toggleFullscreen()` — `const w = getCurrentWindow(); const fs = await w.isFullscreen();
  await w.setFullscreen(!fs); notify(!fs)` (from `@tauri-apps/api/window`).
- bind F11 to `toggleFullscreen` via the keydown listener (Electron handled F11 in
  `emain-tabview.ts`).

### 5.3 Ctrl-Shift state listener (`frontend/tauri/chrome.ts`)

- `onControlShiftStateUpdate(cb)` — registers `cb`.
- a window keydown/keyup listener mirroring `emain-util.ts handleCtrlShiftState`: emits `true`
  when Ctrl **and** Shift are held without Meta, `false` otherwise; only notifies on change.
  Consumed by `keymodel.ts` (Phase 5) for the Ctrl+Shift overlay; the harness shows an
  indicator now.

### 5.4 Menu primitive (`frontend/tauri/menu.ts`, decision P2-2)

`buildTauriMenu(items: ContextMenuItem[]): Promise<Menu>` — recursively builds a Tauri menu
from the **frontend** `ContextMenuItem[]` type (with `click` callbacks; *not* the id-tagged
`ElectronContextMenuItem[]`). Mapping, using `@tauri-apps/api/menu`:

| `ContextMenuItem` | Tauri |
|---|---|
| plain (`label`, `click`) | `MenuItem.new({ text: label, enabled, action: click })` |
| `type: "separator"` | `PredefinedMenuItem.new({ item: "Separator" })` |
| `type: "checkbox"` (`checked`) | `CheckMenuItem.new({ text, checked, action: click })` |
| `submenu` | `Submenu.new({ text, items: await build(submenu) })` |
| `role` (copy/paste/cut/selectall/undo/redo) | `PredefinedMenuItem.new({ item: <Role> })` |

Callers pop it themselves: `(await buildTauriMenu(items)).popup(new LogicalPosition(x, y))`
at the pointer (Tauri's `popup(at?, window?)` position is relative to the window top-left).
Unknown roles/types fall back to a plain labeled `MenuItem`. Phase 5's `ContextMenuModel`
imports `buildTauriMenu` and drops its id map + `getApi().showContextMenu`/`onContextMenuClick`.

## 6. Rust / config / capabilities surface

### 6.1 No new Rust commands (decision P2-7)

Window controls, fullscreen, zoom, and menus are all built-in Tauri **core** plugin surfaces
callable from the webview; core plugins need no `.plugin()` registration, only capability
grants. `getAboutModalDetails` reads the existing `InitData` cache. **Therefore Phase 2 adds
zero new Rust commands and does not touch `main.rs`/`commands.rs`/`init.rs`.** The Rust-side
work is config + permissions only.

### 6.2 `tauri.conf.json`

Set `decorations: false` on the `main` window so the custom titlebar replaces OS chrome.

### 6.3 `capabilities/default.json`

Extend the Phase 1 permission set (`core:default`, `core:event:default`) with the grants the
JS chrome APIs require:

- `core:window:default`, `core:window:allow-minimize`, `core:window:allow-toggle-maximize`,
  `core:window:allow-close`, `core:window:allow-start-dragging` (titlebar + `data-tauri-drag-region`)
- `core:window:allow-set-fullscreen`, `core:window:allow-is-fullscreen` (fullscreen toggle)
- `core:webview:allow-set-webview-zoom` (zoom) — *verify exact identifier at build time; the
  `tauri-build` codegen rejects an unknown permission string loudly (as in Phase 1 §6.0)*
- `core:menu:default` (context menu via the JS menu API)

## 7. Deferred to Phase 5

- Swap `ContextMenuModel` (`frontend/app/store/contextmenu.ts`) to `buildTauriMenu`; delete
  `showContextMenu` / `onContextMenuClick` from `ElectronApi` + the bridge.
- Wire `keymodel.ts` to the real `chrome.ts` zoom/chord/ctrl-shift; delete the dead
  `updateWindowControlsOverlay` (+ its `app-bg.tsx` caller) and `onMenuItemAbout`.
- Build the production cockpit titlebar (the harness titlebar is throwaway).

## 8. Layout

```
src-tauri/
  tauri.conf.json             main window gets "decorations": false
  capabilities/default.json   + window/webview/menu permissions (§6.3)
  src/                        UNCHANGED (no new Rust commands — §6.1)
frontend/tauri/
  chrome.ts (new)    zoom controller + fullscreen toggle + ctrl-shift listener (§5.1-5.3)
  menu.ts (new)      buildTauriMenu primitive (§5.4)
  api.ts (modify)    wire kept-contract methods to chrome.ts; getAboutModalDetails from cache;
                     setKeyboardChordMode → real no-op; remove the now-real names from the
                     stub lists; keep menu/about-menu/WCO stubs (marked cut)
  terminal-harness.tsx (modify)  minimal custom titlebar + observe-gate affordances
                     (zoom +/-/reset, fullscreen, right-click menu, ctrl-shift indicator)
  chrome.test.ts (new)  unit tests: zoom step/clamp/notify, fullscreen toggle, ctrl-shift
  menu.test.ts (new)    unit tests: buildTauriMenu structure + action wiring (mock the menu API)
  api.test.ts (modify)  getAboutModalDetails + getZoomFactor delegation; cut methods still stub
```

## 9. Verification (per meta spec §12)

Pure logic is unit-tested TDD-style; integration is verified by explicit observe-gates on the
Windows dev app.

**Unit tests** (mock `@tauri-apps/api/{window,webview,menu}`):
- zoom: `getZoomFactor` starts at 1; `zoomIn`/`zoomOut` step + clamp and fire
  `onZoomFactorChange`; `zoomReset` → 1; `setZoom` called with the new factor.
- fullscreen: `toggleFullscreen` calls `setFullscreen(!isFullscreen)` and notifies.
- ctrl-shift: a Ctrl+Shift keydown notifies `true`; release notifies `false`; no duplicate
  notifications on repeat.
- `buildTauriMenu`: a template with a submenu, a separator, and a checkbox produces the
  matching `Submenu.new`/`PredefinedMenuItem.new`/`CheckMenuItem.new`/`MenuItem.new` calls,
  and a plain item's `action` invokes its `click`.
- `getAboutModalDetails` returns `{version, buildTime}` from `InitData`; `getZoomFactor`
  delegates to the controller; `showContextMenu`/`onContextMenuClick` still warn (stub).

**Observe-gates** (harness on the Windows dev app):
1. **Titlebar** — the drag strip moves the window; min / maximize / close buttons work
   (proves `decorations:false` + the window permissions).
2. **Zoom** — `+`/`-` (and Ctrl+`=`/Ctrl+`-`) change content zoom *and* the `--zoomfactor`
   CSS var updates; reset returns to 1 (proves `setZoom` + `onZoomFactorChange`).
3. **Fullscreen** — F11 (and the button) toggles fullscreen; the console logs the
   `onFullScreenChange` payload.
4. **Context menu** — right-click pops a *native* menu; a submenu opens; a checkbox toggles;
   clicking an item fires its `click` (logged); clicking away cancels (proves `buildTauriMenu`
   + `core:menu:default`).
5. **Ctrl-Shift** — holding Ctrl+Shift lights the harness indicator; releasing clears it.
6. **No unexpected stub hit** — the happy path triggers no `[tauri-bridge] stub called:`
   warnings; in particular `showContextMenu`/`onContextMenuClick` are *not* hit (the harness
   uses `buildTauriMenu` directly), confirming the cut/primitive split.

## 10. Decision log

- **P2-1 — Verification vehicle:** extended bare-xterm harness + a minimal custom titlebar,
  not the production cockpit. *Same block/tab/workspace coupling that blocked Phase 1.*
- **P2-2 — Context menu:** write the `buildTauriMenu` JS primitive (callbacks fire in JS, no
  id round-trip, no Rust); keep `showContextMenu`/`onContextMenuClick` as stubs marked cut;
  defer the `ContextMenuModel` flip + deletion to Phase 5. *The id round-trip is an Electron
  IPC workaround that no longer applies.*
- **P2-3 — Zoom/fullscreen/ctrl-shift:** JS-owned in `chrome.ts` via Tauri core plugins; keep
  the thin `getApi()` event/getter contract (it survives into the cockpit). *Electron's
  main-process logic relocates to the webview, where the keys already are.*
- **P2-4 — `setKeyboardChordMode`:** an intentional real no-op. *No native key interception
  to coordinate; `keymodel.ts`'s JS chord timer is the mechanism.*
- **P2-5 — `updateWindowControlsOverlay`:** cut. *Obsolete under a custom titlebar where we
  draw the buttons in CSS.*
- **P2-6 — About:** `getAboutModalDetails` real from the boot cache; `onMenuItemAbout` cut.
  *No native menubar under a custom titlebar.*
- **P2-7 — Zero new Rust commands:** Phase 2 is config + capabilities + TypeScript. *Window/
  webview/menu are built-in core plugins gated by permissions, not custom commands.*
- **P2-8 — File split:** introduce `chrome.ts` + `menu.ts`; keep `api.ts` the thin
  `ElectronApi` map. *Phase 1's single-file YAGNI threshold is now crossed (stateful zoom,
  listeners, recursive menu builder); `menu.ts` is also the unit Phase 5 imports.*

## 11. Spec coverage

§2 rule → §4 disposition tables. §4.1 keep-real → §5.1-5.3 primitives + unit tests + gates
2/3/5; §4.2 cut/primitive → §5.4 + gate 4 + gate 6. §4.3 no-op, §4.4 cuts → stub behavior +
gate 6. §5 primitives → §6 capabilities (gates 1-4 prove the grants) + §6.1 (no Rust). §7
maps every deferral to Phase 5. §9 maps each gate + test to a method. Each kept-real method in
§4.1 has a primitive in §5 and a verification in §9.
