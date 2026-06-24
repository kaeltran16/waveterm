# Tauri Phase 2 — Chrome + Interaction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the window-chrome + interaction methods (zoom, fullscreen, context menu,
ctrl-shift, chord, about) real on the extended bare-xterm harness + a minimal custom titlebar,
behind the unchanged `getApi(): ElectronApi` interface.

**Architecture:** All chrome logic lives in the webview (JS) over Tauri's built-in core plugins
(window/webview/menu), so Phase 2 adds **zero new Rust commands** — only `decorations:false` +
capability grants. Two new focused TS modules hold the primitives (`chrome.ts` = zoom/fullscreen/
ctrl-shift; `menu.ts` = `buildTauriMenu`); `api.ts` stays the thin `ElectronApi` map and delegates.
Methods whose contract is an Electron-IPC workaround (`showContextMenu`/`onContextMenuClick`) are
**not ported** — the primitive is built, the methods stay benign stubs marked cut, the consumer-flip
is Phase 5.

**Tech Stack:** TypeScript + Vite; `@tauri-apps/api` v2 (`/window`, `/webview`, `/menu`, `/dpi`);
vitest (jsdom-free — bare `window` shim + module mocks, per the existing `api.test.ts`); Rust +
Tauri v2 config/capabilities validated by `cargo check` codegen; manual observe-gates on the
Windows dev app via `cargo tauri dev` (per meta spec §12).

**Spec:** [`docs/superpowers/specs/2026-06-24-tauri-phase2-chrome-design.md`](../specs/2026-06-24-tauri-phase2-chrome-design.md)

> **GIT (user override):** Do NOT commit per task. Per the user's workflow, batch ALL changes
> into ONE commit at the end (Task 8), shown for approval first. The spec + this plan fold into
> that same feature commit. No per-task commits below.

> **Verification model:** TS logic is unit-tested TDD-style (Tasks 1-3). The capabilities/config
> change is validated by the `cargo check` codegen (Task 5) and the integration observe-gates
> (Task 7). `cargo check` and `vitest` run from the **project root**.

---

## File Structure

| File | Responsibility |
|---|---|
| `frontend/tauri/menu.ts` (create) | `buildTauriMenu(items)` — the reusable JS context-menu primitive |
| `frontend/tauri/menu.test.ts` (create) | unit tests: menu structure + action wiring |
| `frontend/tauri/chrome.ts` (create) | zoom controller + fullscreen toggle + ctrl-shift compute + DOM-listener install |
| `frontend/tauri/chrome.test.ts` (create) | unit tests: zoom step/clamp/notify, fullscreen toggle, ctrl-shift compute |
| `frontend/tauri/api.ts` (modify) | delegate kept-contract methods to `chrome.ts`; `getAboutModalDetails` from cache; `setKeyboardChordMode` real no-op; trim stub lists; keep menu/about-menu/WCO stubs marked cut |
| `frontend/tauri/api.test.ts` (modify) | add real-method tests; add window/webview mocks |
| `frontend/tauri/main.tsx` (modify) | call `installChromeListeners()` after `installTauriApi` |
| `frontend/tauri/terminal-harness.tsx` (modify) | minimal custom titlebar + observe-gate affordances |
| `src-tauri/tauri.conf.json` (modify) | `"decorations": false` on the `main` window |
| `src-tauri/capabilities/default.json` (modify) | add window/webview/menu permissions |
| `src-tauri/src/*` | **UNCHANGED** (no new Rust commands) |

---

## Task 1: `menu.ts` — the context-menu primitive (TDD)

**Files:**
- Create: `frontend/tauri/menu.test.ts`
- Create: `frontend/tauri/menu.ts`

- [ ] **Step 1: Write the failing tests**

`frontend/tauri/menu.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
    const mk = (kind: string) => vi.fn(async (opts: any) => ({ kind, ...opts }));
    return {
        Menu: mk("menu"),
        MenuItem: mk("item"),
        Submenu: mk("submenu"),
        CheckMenuItem: mk("check"),
        PredefinedMenuItem: mk("predef"),
    };
});
vi.mock("@tauri-apps/api/menu", () => ({
    Menu: { new: h.Menu },
    MenuItem: { new: h.MenuItem },
    Submenu: { new: h.Submenu },
    CheckMenuItem: { new: h.CheckMenuItem },
    PredefinedMenuItem: { new: h.PredefinedMenuItem },
}));

import { buildTauriMenu } from "./menu";

beforeEach(() => {
    for (const f of Object.values(h)) f.mockClear();
});

describe("buildTauriMenu", () => {
    it("maps plain / separator / checkbox / submenu items to the right Tauri classes", async () => {
        const items: ContextMenuItem[] = [
            { label: "Plain", click: () => {} },
            { type: "separator" },
            { label: "Chk", type: "checkbox", checked: true, click: () => {} },
            { label: "Sub", submenu: [{ label: "Inner", click: () => {} }] },
        ];
        await buildTauriMenu(items);
        expect(h.MenuItem).toHaveBeenCalledWith(expect.objectContaining({ text: "Plain" }));
        expect(h.PredefinedMenuItem).toHaveBeenCalledWith(expect.objectContaining({ item: "Separator" }));
        expect(h.CheckMenuItem).toHaveBeenCalledWith(expect.objectContaining({ text: "Chk", checked: true }));
        expect(h.Submenu).toHaveBeenCalledWith(expect.objectContaining({ text: "Sub" }));
        expect(h.MenuItem).toHaveBeenCalledWith(expect.objectContaining({ text: "Inner" }));
        expect(h.Menu).toHaveBeenCalledTimes(1);
    });

    it("wires a plain item's action to its click callback", async () => {
        const click = vi.fn();
        await buildTauriMenu([{ label: "A", click }]);
        const call = h.MenuItem.mock.calls.find((c) => c[0].text === "A");
        await call[0].action();
        expect(click).toHaveBeenCalledOnce();
    });

    it("maps a known role to a predefined item and skips hidden items", async () => {
        await buildTauriMenu([
            { label: "Copy", role: "copy" },
            { label: "Hidden", visible: false, click: () => {} },
        ]);
        expect(h.PredefinedMenuItem).toHaveBeenCalledWith(expect.objectContaining({ item: "Copy" }));
        expect(h.MenuItem).not.toHaveBeenCalledWith(expect.objectContaining({ text: "Hidden" }));
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (from project root): `npx vitest run frontend/tauri/menu.test.ts`
Expected: FAIL — `Cannot find module './menu'`.

- [ ] **Step 3: Implement the primitive**

`frontend/tauri/menu.ts`:

```ts
import { CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu } from "@tauri-apps/api/menu";

// Electron roles we map to Tauri PredefinedMenuItem; anything else falls back to a plain item.
const ROLE_MAP: Record<string, string> = {
    copy: "Copy",
    paste: "Paste",
    cut: "Cut",
    selectall: "SelectAll",
    undo: "Undo",
    redo: "Redo",
};

async function buildItems(items: ContextMenuItem[]): Promise<any[]> {
    const out: any[] = [];
    for (const it of items) {
        if (it.visible === false) continue;
        if (it.type === "separator") {
            out.push(await PredefinedMenuItem.new({ item: "Separator" }));
            continue;
        }
        const role = it.role?.toLowerCase();
        if (role && ROLE_MAP[role]) {
            out.push(await PredefinedMenuItem.new({ item: ROLE_MAP[role] as any }));
            continue;
        }
        if (it.submenu) {
            out.push(await Submenu.new({ text: it.label ?? "", enabled: it.enabled, items: await buildItems(it.submenu) }));
            continue;
        }
        if (it.type === "checkbox") {
            out.push(await CheckMenuItem.new({ text: it.label ?? "", checked: it.checked, enabled: it.enabled, action: it.click }));
            continue;
        }
        out.push(await MenuItem.new({ text: it.label ?? "", enabled: it.enabled, action: it.click }));
    }
    return out;
}

// The long-term context-menu primitive: callbacks fire directly in JS (no id round-trip, no
// Rust). Phase 5's ContextMenuModel imports this and drops getApi().showContextMenu.
export async function buildTauriMenu(items: ContextMenuItem[]): Promise<Menu> {
    return Menu.new({ items: await buildItems(items) });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run (from project root): `npx vitest run frontend/tauri/menu.test.ts`
Expected: PASS — all three tests green.

---

## Task 2: `chrome.ts` — zoom / fullscreen / ctrl-shift primitives (TDD)

**Files:**
- Create: `frontend/tauri/chrome.test.ts`
- Create: `frontend/tauri/chrome.ts`

The DOM-listener wiring (`installChromeListeners`) is intentionally separate from the pure,
directly-callable logic so the unit tests never need real keyboard events (matching the
jsdom-free convention in `api.test.ts`). The listener install is verified by the observe-gates.

- [ ] **Step 1: Write the failing tests**

`frontend/tauri/chrome.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
    setZoom: vi.fn(() => Promise.resolve()),
    setFullscreen: vi.fn(() => Promise.resolve()),
    isFullscreen: vi.fn(() => Promise.resolve(false)),
}));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ setZoom: h.setZoom }) }));
vi.mock("@tauri-apps/api/window", () => ({
    getCurrentWindow: () => ({ setFullscreen: h.setFullscreen, isFullscreen: h.isFullscreen }),
}));

// fresh module per test so module-scope state (factor, subscriber lists, ctrl-shift) resets.
let chrome: typeof import("./chrome");
beforeEach(async () => {
    vi.resetModules();
    for (const f of Object.values(h)) f.mockClear();
    chrome = await import("./chrome");
});

describe("zoom controller", () => {
    it("starts at 1 and notifies + sets webview zoom on change", () => {
        const cb = vi.fn();
        chrome.onZoomFactorChange(cb);
        expect(chrome.getZoomFactor()).toBe(1);
        chrome.zoomIn();
        expect(chrome.getZoomFactor()).toBeCloseTo(1.1);
        expect(h.setZoom).toHaveBeenCalledWith(expect.closeTo(1.1));
        expect(cb).toHaveBeenCalledWith(expect.closeTo(1.1));
    });
    it("clamps within [0.5, 3] and resets to 1", () => {
        for (let i = 0; i < 50; i++) chrome.zoomIn();
        expect(chrome.getZoomFactor()).toBeLessThanOrEqual(3);
        for (let i = 0; i < 100; i++) chrome.zoomOut();
        expect(chrome.getZoomFactor()).toBeGreaterThanOrEqual(0.5);
        chrome.zoomReset();
        expect(chrome.getZoomFactor()).toBe(1);
    });
});

describe("fullscreen toggle", () => {
    it("toggles from the current state and notifies", async () => {
        const cb = vi.fn();
        chrome.onFullScreenChange(cb);
        await chrome.toggleFullscreen();
        expect(h.setFullscreen).toHaveBeenCalledWith(true);
        expect(cb).toHaveBeenCalledWith(true);
    });
});

describe("ctrl-shift compute", () => {
    it("emits true on ctrl+shift keydown without meta, false on release", () => {
        const cb = vi.fn();
        chrome.onControlShiftStateUpdate(cb);
        chrome.applyKeyToCtrlShift({ type: "keydown", ctrl: true, shift: true, meta: false });
        expect(cb).toHaveBeenLastCalledWith(true);
        chrome.applyKeyToCtrlShift({ type: "keyup", ctrl: true, shift: false, meta: false });
        expect(cb).toHaveBeenLastCalledWith(false);
    });
    it("does not emit when meta is held, and dedupes repeats", () => {
        const cb = vi.fn();
        chrome.onControlShiftStateUpdate(cb);
        chrome.applyKeyToCtrlShift({ type: "keydown", ctrl: true, shift: true, meta: true });
        chrome.applyKeyToCtrlShift({ type: "keydown", ctrl: true, shift: true, meta: true });
        expect(cb).not.toHaveBeenCalled();
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (from project root): `npx vitest run frontend/tauri/chrome.test.ts`
Expected: FAIL — `Cannot find module './chrome'`.

- [ ] **Step 3: Implement the module**

`frontend/tauri/chrome.ts`:

```ts
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";

// mirror Electron emain-util.ts zoom bounds.
const MinZoom = 0.5;
const MaxZoom = 3;
const ZoomDelta = 0.1;

let zoomFactor = 1;
const zoomSubs: ((f: number) => void)[] = [];
const fsSubs: ((b: boolean) => void)[] = [];
const csSubs: ((b: boolean) => void)[] = [];
let ctrlShift = false;

const noop = () => {};

export function getZoomFactor(): number {
    return zoomFactor;
}
export function onZoomFactorChange(cb: (f: number) => void) {
    zoomSubs.push(cb);
}
function applyZoom(f: number) {
    zoomFactor = Math.min(MaxZoom, Math.max(MinZoom, Math.round(f * 100) / 100));
    getCurrentWebview().setZoom(zoomFactor).catch(noop);
    for (const cb of zoomSubs) cb(zoomFactor);
}
export function zoomIn() {
    applyZoom(zoomFactor + ZoomDelta);
}
export function zoomOut() {
    applyZoom(zoomFactor - ZoomDelta);
}
export function zoomReset() {
    applyZoom(1);
}

export function onFullScreenChange(cb: (b: boolean) => void) {
    fsSubs.push(cb);
}
export async function toggleFullscreen() {
    const w = getCurrentWindow();
    const next = !(await w.isFullscreen());
    await w.setFullscreen(next);
    for (const cb of fsSubs) cb(next);
}

export function onControlShiftStateUpdate(cb: (b: boolean) => void) {
    csSubs.push(cb);
}
function setCtrlShift(state: boolean) {
    if (state === ctrlShift) return;
    ctrlShift = state;
    for (const cb of csSubs) cb(state);
}
// mirror emain-util.ts handleCtrlShiftState: true only while ctrl+shift held without meta.
export function applyKeyToCtrlShift(e: { type: string; ctrl: boolean; shift: boolean; meta: boolean }) {
    if (e.type === "keyup") {
        if (!e.ctrl || !e.shift) setCtrlShift(false);
        return;
    }
    setCtrlShift(e.ctrl && e.shift && !e.meta);
}

// DOM wiring (verified by observe-gates, not unit tests). Called once at boot from main.tsx.
export function installChromeListeners() {
    window.addEventListener("keydown", (ev) => {
        if (ev.key === "F11") {
            ev.preventDefault();
            toggleFullscreen();
            return;
        }
        if (ev.ctrlKey && (ev.key === "=" || ev.key === "+")) {
            ev.preventDefault();
            zoomIn();
            return;
        }
        if (ev.ctrlKey && ev.key === "-") {
            ev.preventDefault();
            zoomOut();
            return;
        }
        if (ev.ctrlKey && ev.key === "0") {
            ev.preventDefault();
            zoomReset();
            return;
        }
        applyKeyToCtrlShift({ type: "keydown", ctrl: ev.ctrlKey, shift: ev.shiftKey, meta: ev.metaKey });
    });
    window.addEventListener("keyup", (ev) => {
        applyKeyToCtrlShift({ type: "keyup", ctrl: ev.ctrlKey, shift: ev.shiftKey, meta: ev.metaKey });
    });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run (from project root): `npx vitest run frontend/tauri/chrome.test.ts`
Expected: PASS — all describe blocks green.

---

## Task 3: `api.ts` — delegate kept-contract methods; trim stubs (TDD)

**Files:**
- Modify: `frontend/tauri/api.ts`
- Modify: `frontend/tauri/api.test.ts`

- [ ] **Step 1: Add the failing tests**

In `frontend/tauri/api.test.ts`, add window/webview mocks beside the existing core/event mocks
(so importing `api.ts` → `chrome.ts` is safe), and a new describe block. Add after line 6
(after the existing `vi.mock("@tauri-apps/api/event", ...)`):

```ts
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ setZoom: () => Promise.resolve() }) }));
vi.mock("@tauri-apps/api/window", () => ({
    getCurrentWindow: () => ({ setFullscreen: () => Promise.resolve(), isFullscreen: () => Promise.resolve(false) }),
}));
```

Then add this describe block at the end of the file:

```ts
describe("phase-2 chrome methods", () => {
    it("getAboutModalDetails returns version+buildTime from the boot cache", () => {
        installTauriApi(INIT);
        expect((window as any).api.getAboutModalDetails()).toEqual({ version: "0.1.0", buildTime: 1 });
    });
    it("getZoomFactor delegates to the chrome controller (starts at 1)", () => {
        installTauriApi(INIT);
        expect((window as any).api.getZoomFactor()).toBe(1);
    });
    it("setKeyboardChordMode is a no-op that does not warn or throw", () => {
        installTauriApi(INIT);
        expect((window as any).api.setKeyboardChordMode()).toBeUndefined();
    });
    it("onFullScreenChange / onZoomFactorChange / onControlShiftStateUpdate register without throwing", () => {
        installTauriApi(INIT);
        const api = (window as any).api;
        expect(api.onFullScreenChange(() => {})).toBeUndefined();
        expect(api.onZoomFactorChange(() => {})).toBeUndefined();
        expect(api.onControlShiftStateUpdate(() => {})).toBeUndefined();
    });
    it("showContextMenu / onContextMenuClick remain benign stubs (cut, not ported)", () => {
        installTauriApi(INIT);
        const api = (window as any).api;
        expect(api.showContextMenu("ws", [])).toBeUndefined();
        expect(api.onContextMenuClick(() => {})).toBeUndefined();
    });
});
```

Also update the existing `"typed sync getters return benign defaults"` test (around line 98) to
drop the `getZoomFactor` assertion (it is now real, asserted above), leaving:

```ts
    it("typed sync getters return benign defaults", () => {
        installTauriApi(INIT);
        const api = (window as any).api;
        expect(api.getCursorPoint()).toEqual({ x: 0, y: 0 });
    });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (from project root): `npx vitest run frontend/tauri/api.test.ts`
Expected: FAIL — `getAboutModalDetails` returns `{}` (stub) not `{version, buildTime}`;
`setKeyboardChordMode` currently warns/returns via stub. (Some assertions may pass incidentally;
the `getAboutModalDetails` one must fail.)

- [ ] **Step 3: Wire the real methods in `api.ts`**

In `frontend/tauri/api.ts`:

(a) Add imports after line 2 (`import { listen } from "@tauri-apps/api/event";`):

```ts
import * as chrome from "./chrome";
```

(b) Inside `installTauriApi`, add a chrome block to the `api` object literal — insert after the
`incrementTermCommands` method (after line 68, before the closing `};` of the object):

```ts

        // --- window chrome + interaction (Phase 2) ---
        getZoomFactor: () => chrome.getZoomFactor(),
        onZoomFactorChange: (cb: (zoomFactor: number) => void) => chrome.onZoomFactorChange(cb),
        onFullScreenChange: (cb: (isFullScreen: boolean) => void) => chrome.onFullScreenChange(cb),
        onControlShiftStateUpdate: (cb: (state: boolean) => void) => chrome.onControlShiftStateUpdate(cb),
        // real no-op: Tauri has no main-process key interception to coordinate; keymodel.ts's
        // JS chord timer is the mechanism (spec P2-4).
        setKeyboardChordMode: () => {},
        getAboutModalDetails: () => ({ version: init.version, buildTime: init.buildTime }),
```

(c) In `installStubs`, REMOVE the now-real names from the `voidStubs` array:
`onFullScreenChange`, `onZoomFactorChange`, `onControlShiftStateUpdate`, `setKeyboardChordMode`.
The array becomes (note these four removed; `showContextMenu`, `onContextMenuClick`,
`onMenuItemAbout`, `updateWindowControlsOverlay` STAY):

```ts
    const voidStubs = [
        "showWorkspaceAppMenu", "showBuilderAppMenu", "showContextMenu", "onContextMenuClick",
        "downloadFile", "onUpdaterStatusChange",
        "installAppUpdate", "onMenuItemAbout", "updateWindowControlsOverlay", "onReinjectKey",
        "setWebviewFocus", "registerGlobalWebviewKeys",
        "createWorkspace", "switchWorkspace", "deleteWorkspace", "setActiveTab", "createTab",
        "onBuilderInit", "onQuicklook", "openNativePath",
        "setWaveAIOpen", "closeBuilderWindow", "nativePaste", "openBuilder",
        "setBuilderWindowAppId", "doRefresh", "onNavigate", "onIframeNavigate",
    ];
```

(d) In `installStubs`, REMOVE the now-real getter stubs `getAboutModalDetails` and
`getZoomFactor` (delete these two lines):

```ts
    api.getAboutModalDetails = () => { stubWarn("getAboutModalDetails"); return {} as any; };
    api.getZoomFactor = () => { stubWarn("getZoomFactor"); return 1; };
```

(e) Update the cut-stub comment. Change the `installStubs` doc comment (the block above the
function) to note the cut split — replace the existing comment lines:

```ts
// Everything outside the day-one set: typed benign-default stubs (not throws), so the bridge
// implements the full ElectronApi type and an incidental call cannot crash. Deleted with the
// cut subsystems in Phase 5; the deferred ones get real impls in Phase 2/3.
```

with:

```ts
// Everything outside the implemented set: typed benign-default stubs (not throws), so the bridge
// implements the full ElectronApi type and an incidental call cannot crash. showContextMenu/
// onContextMenuClick are CUT (the Tauri primitive is menu.ts buildTauriMenu); updateWindowControls
// Overlay/onMenuItemAbout are obsolete under the custom titlebar. All deleted with their callers in
// Phase 5.
```

- [ ] **Step 4: Run the tests to verify they pass**

Run (from project root): `npx vitest run frontend/tauri/api.test.ts`
Expected: PASS — including the new `phase-2 chrome methods` block.

---

## Task 4: `main.tsx` — install the chrome DOM listeners at boot

**Files:**
- Modify: `frontend/tauri/main.tsx`

- [ ] **Step 1: Import and call `installChromeListeners`**

In `frontend/tauri/main.tsx`, change the import on line 3 from:

```ts
import { hlog, installTauriApi, type InitData } from "./api";
```

to:

```ts
import { hlog, installTauriApi, type InitData } from "./api";
import { installChromeListeners } from "./chrome";
```

Then, immediately after line 23 (`installTauriApi(init);`), add:

```ts
        installChromeListeners();
```

- [ ] **Step 2: Verify the unit suite still passes (no harness unit test; build gate is Task 7)**

Run (from project root): `npx vitest run frontend/tauri/`
Expected: PASS (menu, chrome, api). A TS error in `main.tsx` surfaces at the Task 7 dev build.

---

## Task 5: Rust config + capabilities (no new commands)

**Files:**
- Modify: `src-tauri/tauri.conf.json`
- Modify: `src-tauri/capabilities/default.json`

- [ ] **Step 1: Disable native decorations on the main window**

In `src-tauri/tauri.conf.json`, change the windows entry to add `"decorations": false`:

```json
    "windows": [
      { "label": "main", "title": "Wave Tauri Spike", "width": 1000, "height": 700, "decorations": false }
    ],
```

- [ ] **Step 2: Add the chrome permissions**

Replace the `permissions` array in `src-tauri/capabilities/default.json` with:

```json
  "permissions": [
    "core:default",
    "core:event:default",
    "core:window:default",
    "core:window:allow-minimize",
    "core:window:allow-toggle-maximize",
    "core:window:allow-close",
    "core:window:allow-start-dragging",
    "core:window:allow-set-fullscreen",
    "core:window:allow-is-fullscreen",
    "core:webview:allow-set-webview-zoom",
    "core:menu:default"
  ]
```

- [ ] **Step 3: Validate the capabilities parse (codegen gate)**

Run (from project root): `cargo check --manifest-path src-tauri/Cargo.toml`
Expected: PASS. The `tauri-build` codegen validates every permission identifier. If it errors
with "permission not found" for `core:webview:allow-set-webview-zoom`, the zoom permission id
differs in the pinned Tauri version — find the correct one with:
`ls src-tauri/gen/schemas/` then grep the desktop schema for `set-webview-zoom` / `set-zoom`
(e.g. `grep -ri "set.*zoom" src-tauri/gen/schemas/`), and use the exact identifier it lists.
Likewise confirm `allow-is-fullscreen` exists (it may already be inside `core:window:default`,
in which case removing the explicit line also resolves a duplicate/unknown error).

---

## Task 6: `terminal-harness.tsx` — custom titlebar + observe-gate affordances

**Files:**
- Modify: `frontend/tauri/terminal-harness.tsx`

- [ ] **Step 1: Add imports**

At the top of `frontend/tauri/terminal-harness.tsx`, add to the import block:

```ts
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalPosition } from "@tauri-apps/api/dpi";
import { useState } from "react";
import { buildTauriMenu } from "./menu";
import * as chrome from "./chrome";
```

Note: `useEffect` and `useRef` are already imported from `"react"` on line 10 — merge `useState`
into that existing import instead of duplicating the line. If `LogicalPosition` fails to resolve
from `@tauri-apps/api/dpi` at the Task 7 build, it lives in `@tauri-apps/api/window` in some v2
minor versions — switch the import there.

- [ ] **Step 2: Add chrome state hooks**

Inside `TerminalHarness`, after `const elemRef = useRef<HTMLDivElement>(null);` (line 14), add:

```ts
    const [zoom, setZoom] = useState(1);
    const [ctrlShift, setCtrlShift] = useState(false);
    const [ctxChecked, setCtxChecked] = useState(false);
```

- [ ] **Step 3: Subscribe to zoom + ctrl-shift updates**

Add a third `useEffect` right after the existing `onWaveInit` effect (after line 93):

```ts
    useEffect(() => {
        setZoom(getApi().getZoomFactor());
        getApi().onZoomFactorChange((z) => setZoom(z));
        getApi().onControlShiftStateUpdate((s) => setCtrlShift(s));
    }, []);
```

- [ ] **Step 4: Add the titlebar + affordances and a right-click menu**

Replace the returned JSX (lines 95-105) with:

```tsx
    const onContextMenu = async (e: React.MouseEvent) => {
        e.preventDefault();
        const items: ContextMenuItem[] = [
            { label: "Log Hello", click: () => getApi().sendLog("ctx: hello") },
            { type: "separator" },
            { label: "Checkable", type: "checkbox", checked: ctxChecked, click: () => setCtxChecked((v) => !v) },
            { label: "Submenu", submenu: [{ label: "Inner", click: () => getApi().sendLog("ctx: inner") }] },
        ];
        const menu = await buildTauriMenu(items);
        await menu.popup(new LogicalPosition(e.clientX, e.clientY));
    };

    return (
        <div
            style={{ width: "100vw", height: "100vh", display: "flex", flexDirection: "column" }}
            onContextMenu={onContextMenu}
        >
            <div
                data-tauri-drag-region
                style={{ display: "flex", alignItems: "center", height: 32, background: "#1a1a1a", color: "#ddd", fontFamily: "monospace", fontSize: 12, userSelect: "none" }}
            >
                <span style={{ paddingLeft: 10, flex: 1, pointerEvents: "none" }}>Wave Tauri Spike</span>
                <button onClick={() => getCurrentWindow().minimize()}>—</button>
                <button onClick={() => getCurrentWindow().toggleMaximize()}>▢</button>
                <button onClick={() => getCurrentWindow().close()}>✕</button>
            </div>
            <div style={{ display: "flex", gap: 8, padding: 4, alignItems: "center", background: "#222", color: "#ddd", fontFamily: "monospace", fontSize: 12 }}>
                <button onClick={() => getApi().setWindowInitStatus("ready")}>init: ready</button>
                <button onClick={() => getApi().openExternal("https://waveterm.dev")}>open external</button>
                <button onClick={() => getApi().incrementTermCommands()}>incr term cmds</button>
                <button onClick={() => getApi().setIsActive()}>set active</button>
                <span style={{ marginLeft: 12 }}>zoom:</span>
                <button onClick={() => chrome.zoomOut()}>-</button>
                <span>{zoom.toFixed(2)}</span>
                <button onClick={() => chrome.zoomIn()}>+</button>
                <button onClick={() => chrome.zoomReset()}>reset</button>
                <button onClick={() => chrome.toggleFullscreen()}>fullscreen</button>
                <span style={{ marginLeft: 12 }}>ctrl+shift:</span>
                <span style={{ width: 10, height: 10, borderRadius: 5, background: ctrlShift ? "#4caf50" : "#555" }} />
            </div>
            <div ref={elemRef} style={{ flex: 1 }} />
        </div>
    );
```

- [ ] **Step 5: Verify the unit suite still passes**

Run (from project root): `npx vitest run frontend/tauri/`
Expected: PASS (the harness has no unit test; TS errors surface at the Task 7 dev build).

---

## Task 7: Integration observe-gates (Windows dev app)

**Files:** none (verification only).

- [ ] **Step 1: Launch the dev app**

Run (from project root): `cargo tauri dev`
Watch the Rust console for `[fe-log]` lines. The window now has **no OS titlebar** (custom one).

- [ ] **Step 2: Gate 1 — custom titlebar**

The terminal still renders + the PTY flows (Phase 0/1 regression). Drag the dark top strip →
the window moves. Click `—` (minimize), `▢` (maximize/restore), `✕` (close → relaunch). All work.
Proves `decorations:false` + the window permissions (Task 5).

- [ ] **Step 3: Gate 2 — zoom**

Click `+`/`-`: page content scales and the `zoom: N.NN` readout updates. Press Ctrl+`=` / Ctrl+`-`
/ Ctrl+`0`: same effect from the keyboard. Click `reset` → 1.00. (Proves `setZoom` +
`onZoomFactorChange` + the key listener.)

- [ ] **Step 4: Gate 3 — fullscreen**

Press F11 (and click `fullscreen`): the window enters/leaves fullscreen. The console logs no
errors. (Proves `setFullscreen` + the F11 binding.)

- [ ] **Step 5: Gate 4 — context menu**

Right-click anywhere: a **native** menu appears with "Log Hello", a separator, a "Checkable"
item, and a "Submenu" → "Inner". Click "Log Hello" → `[fe-log] ctx: hello`. Open Submenu →
"Inner" → `[fe-log] ctx: inner`. Toggle "Checkable" twice → the check state flips. Right-click
then click away → menu dismisses, no error. (Proves `buildTauriMenu` + `core:menu:default`.)

- [ ] **Step 6: Gate 5 — ctrl-shift indicator**

Hold Ctrl+Shift → the dot turns green; release → grey. (Proves the ctrl-shift listener.)

- [ ] **Step 7: Gate 6 — no unexpected stub hit**

In the WebView2 devtools console (right-click is now our menu; open devtools via the dev
shortcut or `cargo tauri dev` auto-open), confirm NO `[tauri-bridge] stub called:` warnings on
the happy path — in particular `showContextMenu`/`onContextMenuClick` are never hit (the harness
uses `buildTauriMenu` directly). A stub warning means a real dependency was reached unexpectedly.

- [ ] **Step 8: Confirm all six gates passed**

If any failed, fix and re-run before Task 8.

---

## Task 8: Final review and single commit (await approval)

**Files:** all of the above + the spec + this plan.

- [ ] **Step 1: Self-review the diff**

Run (from project root): `git status` then `git --no-pager diff` (and review new files).
Confirm: no debug statements left in production paths, no commented-out code, `src-tauri/src/*`
untouched, the four removed names are gone from `voidStubs`, `getZoomFactor`/`getAboutModalDetails`
removed from the getter stubs.

- [ ] **Step 2: Run the full TS unit suite (no regressions)**

Run (from project root): `npx vitest run`
Expected: PASS (existing suites + `menu.test.ts`, `chrome.test.ts`, the extended `api.test.ts`).

- [ ] **Step 3: Present the commit for approval (user git workflow)**

Show the file list with M/A/D status and the proposed message, then ask:
"Awaiting approval. Proceed? (yes/no)". Proposed message:

```
feat(tauri): phase-2 chrome + interaction (zoom, fullscreen, context menu, titlebar)
```

The spec (`docs/superpowers/specs/2026-06-24-tauri-phase2-chrome-design.md`) and this plan fold
into THIS commit — no separate docs commit. Do NOT commit until the user approves.

---

## Self-Review (against the spec)

**Spec coverage:**
- §3.1 verification vehicle (harness + minimal titlebar) → Task 6 titlebar + Task 7 gate 1. ✓
- §4.1 keep-real (getZoomFactor, onZoomFactorChange, onFullScreenChange, onControlShiftStateUpdate,
  getAboutModalDetails) → Task 2 (chrome primitives) + Task 3 (api delegation) + tests + gates 2/3/5. ✓
- §4.2 context menu primitive, methods cut → Task 1 (`buildTauriMenu`) + Task 3 (stays stub) + gates 4/6. ✓
- §4.3 `setKeyboardChordMode` real no-op → Task 3 (b) + test + removed from voidStubs. ✓
- §4.4 cuts (`updateWindowControlsOverlay`, `onMenuItemAbout`) → Task 3 (stay stub, comment). ✓
- §5.1 zoom controller → Task 2 `chrome.ts` zoom + Task 6 affordances. ✓
- §5.2 fullscreen toggle → Task 2 `toggleFullscreen` + F11 in `installChromeListeners`. ✓
- §5.3 ctrl-shift listener → Task 2 `applyKeyToCtrlShift` + listener + Task 6 indicator. ✓
- §5.4 `buildTauriMenu` mapping → Task 1. ✓
- §6.1 no new Rust commands → Task 5 touches only json; `src-tauri/src/*` untouched. ✓
- §6.2 decorations:false → Task 5 step 1. ✓
- §6.3 capabilities → Task 5 step 2 + codegen gate step 3. ✓
- §9 verification (unit + observe-gates) → Tasks 1-3 (unit), Task 7 (gates 1-6). ✓

**Placeholder scan:** no TBD/TODO; every code step shows complete code; every command has expected
output; the two "if the identifier/import differs" notes are explicit fallback instructions, not
placeholders. ✓

**Type consistency:** `buildTauriMenu(items: ContextMenuItem[]): Promise<Menu>` consistent across
Task 1 + Task 6 caller; `chrome.getZoomFactor/zoomIn/zoomOut/zoomReset/onZoomFactorChange/
onFullScreenChange/toggleFullscreen/onControlShiftStateUpdate/applyKeyToCtrlShift/
installChromeListeners` identical between Task 2 definitions, Task 3 `api.ts` delegation, Task 4
`main.tsx`, and Task 6 harness; `getAboutModalDetails` returns `{version, buildTime}` (matches
ambient `AboutModalDetails`); `ContextMenuItem` is the ambient global type (`custom.d.ts`). ✓
