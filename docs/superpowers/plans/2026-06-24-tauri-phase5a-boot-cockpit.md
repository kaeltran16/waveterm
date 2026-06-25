# Tauri Phase 5a — Boot the Real Cockpit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Boot the real agent cockpit in the Tauri window against the unchanged Go backend — replacing the bare-xterm harness — with the old block/tab/layout machinery still present but bypassed (Electron keeps working in parallel; no deletions).

**Architecture:** A frontend-resolved boot. `resolveBootIds()` reads `(clientId, windowId, workspaceId, tabId)` over plain HTTP from the unchanged Go services (`WOS.callBackendService`, `noUIContext=true`); `bootWaveCore()` (extracted from `wave.ts`) then runs the real boot (global wshrpc on the real tab route, `GlobalModel.initialize`, WOS pin, config). The Tauri entry renders a new `CockpitRoot` (production titlebar + standalone `AgentsView` + an inline focus pane that mounts the focused agent's `term` view standalone, replacing `setActiveTab`). Zero new Rust, zero new Go.

**Tech Stack:** TypeScript / React 19 / Jotai / Vitest (jsdom-free, mocked `@tauri-apps/api`) / Tauri v2 core plugins.

**Spec:** `docs/superpowers/specs/2026-06-24-tauri-phase5a-boot-cockpit-design.md`. Decisions P5a-1..P5a-7.

**Git:** Per project rules, **one commit at the end** (Task 9), message shown in Task 9. Run tests per task; do not commit intermediate steps. Branch `feat/tauri-migration` (continues from Phase 2 `0bf480ab`).

**Verification model:** pure logic (Task 1) is unit-tested TDD; the boot/mount integration (Tasks 4–8) is verified by **observe-gates** on the Windows dev Tauri app (`npx tauri dev`), per spec §7 — these are inherently build-observe-fix loops, not pre-scriptable unit tests. Run the Electron app side-by-side to compare the roster (gate 2).

---

## File Structure

| File | Disposition | Responsibility |
|---|---|---|
| `frontend/tauri/bootids.ts` | **create** | `resolveBootIds()` — HTTP bootstrap of `(clientId, windowId, workspaceId, tabId)` |
| `frontend/tauri/bootids.test.ts` | **create** | unit tests for `resolveBootIds` (mock `@/app/store/wos`) |
| `frontend/app/boot/boot-core.ts` | **create** | `bootWaveCore(initOpts)` — shell-agnostic real boot (extracted from `wave.ts`) |
| `frontend/wave.ts` | **modify** | Electron entry: `bootWaveCore` → render `App` (behavior unchanged) |
| `frontend/app/cockpit/cockpit-root.tsx` | **create** | `CockpitRoot` — providers + titlebar + agents + focus pane |
| `frontend/app/cockpit/titlebar.tsx` | **create** | production custom titlebar (drag + min/max/close via Tauri window API) |
| `frontend/app/cockpit/focus-pane.tsx` | **create** | standalone `term` view for the focused agent |
| `frontend/app/cockpit/cockpit.scss` | **create** | cockpit shell + titlebar layout styles |
| `frontend/tauri/main.tsx` | **modify** | install bridge → `resolveBootIds` → `bootWaveCore` → render `CockpitRoot` |
| `frontend/tauri/index.html` | **modify** | mount node `#main` (match the app), keep the module script |
| `frontend/tauri/terminal-harness.tsx` | **delete** (Task 9) | throwaway harness, retired |
| `src-tauri/capabilities/default.json` | **modify (if needed)** | any core permission a real boot path requires (verified at build) |

---

## Task 1: `resolveBootIds()` — HTTP bootstrap of the boot IDs

**Files:**
- Create: `frontend/tauri/bootids.ts`
- Test: `frontend/tauri/bootids.test.ts`

Rationale: `WOS.callBackendService(service, method, args, noUIContext)` (`frontend/app/store/wos.ts:101`) is a plain `fetch` to the web endpoint — no websocket needed, and `noUIContext=true` skips the `globalAtoms.uiContext` read (undefined this early). wavesrv's `EnsureInitialData` (`pkg/wcore/wcore.go:32`) has already created the object graph, so this is a read (with a `CreateWindow` fallback for the empty-`windowids` case). Service shapes (verified): `Client.windowids: string[]`, `Client.oid`; `WaveWindow.workspaceid`, `.oid`; `Workspace.activetabid`, `.tabids: string[]`.

- [ ] **Step 1: Write the failing test**

```typescript
// frontend/tauri/bootids.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";

const callBackendServiceMock = vi.fn();
vi.mock("@/app/store/wos", () => ({
    callBackendService: (...a: any[]) => callBackendServiceMock(...a),
}));

import { resolveBootIds } from "./bootids";

afterEach(() => {
    callBackendServiceMock.mockReset();
});

describe("resolveBootIds", () => {
    it("uses the existing window when the client already has one", async () => {
        callBackendServiceMock.mockImplementation((service: string, method: string) => {
            if (service === "client" && method === "GetClientData")
                return Promise.resolve({ oid: "c-1", windowids: ["w-1"] });
            if (service === "window" && method === "GetWindow")
                return Promise.resolve({ oid: "w-1", workspaceid: "ws-1" });
            if (service === "workspace" && method === "GetWorkspace")
                return Promise.resolve({ oid: "ws-1", tabids: ["t-1"], activetabid: "t-1" });
            throw new Error(`unexpected ${service}.${method}`);
        });
        const ids = await resolveBootIds();
        expect(ids).toEqual({ clientId: "c-1", windowId: "w-1", workspaceId: "ws-1", tabId: "t-1" });
        // every backend call passes noUIContext=true (4th arg) — uiContext isn't populated this early
        expect(callBackendServiceMock).toHaveBeenCalledWith("client", "GetClientData", [], true);
        expect(callBackendServiceMock).toHaveBeenCalledWith("window", "GetWindow", ["w-1"], true);
        expect(callBackendServiceMock).not.toHaveBeenCalledWith("window", "CreateWindow", expect.anything(), true);
    });

    it("creates a window when the client has none", async () => {
        callBackendServiceMock.mockImplementation((service: string, method: string) => {
            if (service === "client" && method === "GetClientData")
                return Promise.resolve({ oid: "c-1", windowids: [] });
            if (service === "window" && method === "CreateWindow")
                return Promise.resolve({ oid: "w-new", workspaceid: "ws-new" });
            if (service === "workspace" && method === "GetWorkspace")
                return Promise.resolve({ oid: "ws-new", tabids: ["t-new"], activetabid: "t-new" });
            throw new Error(`unexpected ${service}.${method}`);
        });
        const ids = await resolveBootIds();
        expect(ids).toEqual({ clientId: "c-1", windowId: "w-new", workspaceId: "ws-new", tabId: "t-new" });
        expect(callBackendServiceMock).toHaveBeenCalledWith("window", "CreateWindow", [null, ""], true);
    });

    it("falls back to the first tab when no active tab is set", async () => {
        callBackendServiceMock.mockImplementation((service: string, method: string) => {
            if (service === "client" && method === "GetClientData")
                return Promise.resolve({ oid: "c-1", windowids: ["w-1"] });
            if (service === "window" && method === "GetWindow")
                return Promise.resolve({ oid: "w-1", workspaceid: "ws-1" });
            if (service === "workspace" && method === "GetWorkspace")
                return Promise.resolve({ oid: "ws-1", tabids: ["t-a"], activetabid: "" });
            throw new Error(`unexpected ${service}.${method}`);
        });
        const ids = await resolveBootIds();
        expect(ids.tabId).toBe("t-a");
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run frontend/tauri/bootids.test.ts`
Expected: FAIL — `resolveBootIds` not exported / file missing.

- [ ] **Step 3: Write minimal implementation**

```typescript
// frontend/tauri/bootids.ts
// Frontend-resolved boot (Tauri). Electron's main process supplied these IDs via the wave-init
// IPC; here we read them from the unchanged Go services over HTTP (WOS.callBackendService is a
// fetch, not wshrpc — so no websocket is needed yet). noUIContext=true because globalAtoms.uiContext
// is not populated this early in boot. wavesrv's EnsureInitialData has already created the graph.
import { callBackendService } from "@/app/store/wos";

export type BootIds = {
    clientId: string;
    windowId: string;
    workspaceId: string;
    tabId: string;
};

export async function resolveBootIds(): Promise<BootIds> {
    const client: Client = await callBackendService("client", "GetClientData", [], true);
    let windowId = client.windowids?.[0];
    let win: WaveWindow;
    if (!windowId) {
        win = await callBackendService("window", "CreateWindow", [null, ""], true);
        windowId = win.oid;
    } else {
        win = await callBackendService("window", "GetWindow", [windowId], true);
    }
    const workspaceId = win.workspaceid;
    const ws: Workspace = await callBackendService("workspace", "GetWorkspace", [workspaceId], true);
    const tabId = ws.activetabid || ws.tabids?.[0];
    if (!tabId) {
        throw new Error("resolveBootIds: workspace has no tabs");
    }
    return { clientId: client.oid, windowId, workspaceId, tabId };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run frontend/tauri/bootids.test.ts`
Expected: PASS (3 tests).

---

## Task 2: Extract `bootWaveCore` from `wave.ts`

**Files:**
- Create: `frontend/app/boot/boot-core.ts`
- Modify: `frontend/wave.ts:142-209` (`initWave`)

Rationale: split the boot from the render so Electron and Tauri share it. Put it in a NEW module (not `wave.ts`) so the Tauri entry importing `bootWaveCore` does **not** drag `App`/`Workspace`/`builder`/`@/layout` (all imported by `wave.ts`) into the Tauri build. `bootWaveCore` is exactly the current `initWave` body **minus** the final `createElement(App)`/`root.render`/`firstRenderPromise` block (`wave.ts:197-208`).

- [ ] **Step 1: Create `boot-core.ts` with the extracted body**

```typescript
// frontend/app/boot/boot-core.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Shell-agnostic boot: connect wshrpc on the real tab route, init global model/atoms, pin the
// client/window/tab/workspace objects, load config. Extracted from wave.ts initWave so both the
// Electron entry (renders App) and the Tauri cockpit entry (renders CockpitRoot) share it.
import { loadBadges } from "@/app/store/badge";
import { GlobalModel } from "@/app/store/global-model";
import { registerControlShiftStateUpdateHandler } from "@/app/store/keymodel";
import { RpcApi } from "@/app/store/wshclientapi";
import { makeTabRouteId } from "@/app/store/wshrouter";
import { initWshrpc, TabRpcClient } from "@/app/store/wshrpcutil";
import {
    atoms,
    getApi,
    globalStore,
    initGlobal,
    initGlobalWaveEventSubs,
    loadConnStatus,
    subscribeToConnEvents,
} from "@/store/global";
import { activeTabIdAtom } from "@/store/tab-model";
import * as WOS from "@/store/wos";
import { isMacOS, setMacOSVersion } from "@/util/platformutil";

export async function bootWaveCore(initOpts: WaveInitOpts): Promise<void> {
    const platform = getApi().getPlatform();
    getApi().sendLog("Boot Wave Core " + JSON.stringify(initOpts));
    const globalInitOpts: GlobalInitOptions = {
        tabId: initOpts.tabId,
        clientId: initOpts.clientId,
        windowId: initOpts.windowId,
        platform,
        environment: "renderer",
        primaryTabStartup: initOpts.primaryTabStartup,
    };
    globalStore.set(activeTabIdAtom, initOpts.tabId);
    await GlobalModel.getInstance().initialize(globalInitOpts);
    initGlobal(globalInitOpts);
    (window as any).globalAtoms = atoms;

    const globalWS = initWshrpc(makeTabRouteId(initOpts.tabId));
    (window as any).globalWS = globalWS;
    (window as any).TabRpcClient = TabRpcClient;

    try {
        await loadConnStatus();
        await loadBadges();
        initGlobalWaveEventSubs(initOpts);
        subscribeToConnEvents();
        if (isMacOS()) {
            const macOSVersion = await RpcApi.MacOSVersionCommand(TabRpcClient);
            setMacOSVersion(macOSVersion);
        }
        const [_client, waveWindow, initialTab] = await Promise.all([
            WOS.loadAndPinWaveObject<Client>(WOS.makeORef("client", initOpts.clientId)),
            WOS.loadAndPinWaveObject<WaveWindow>(WOS.makeORef("window", initOpts.windowId)),
            WOS.loadAndPinWaveObject<Tab>(WOS.makeORef("tab", initOpts.tabId)),
        ]);
        const [ws, _layoutState] = await Promise.all([
            WOS.loadAndPinWaveObject<Workspace>(WOS.makeORef("workspace", waveWindow.workspaceid)),
            WOS.reloadWaveObject<LayoutState>(WOS.makeORef("layout", initialTab.layoutstate)),
        ]);
        ws?.tabids?.forEach((tabid) => WOS.getObjectValue<Tab>(WOS.makeORef("tab", tabid)));
        WOS.wpsSubscribeToObject(WOS.makeORef("workspace", waveWindow.workspaceid));
        document.title = `Wave Terminal - ${initialTab.name}`;
    } catch (e) {
        console.error("Failed initialization error", e);
        getApi().sendLog("Error in bootWaveCore (loading required objects) " + e.message + "\n" + e.stack);
    }
    registerControlShiftStateUpdateHandler();
    const fullConfig = await RpcApi.GetFullConfigCommand(TabRpcClient);
    globalStore.set(atoms.fullConfigAtom, fullConfig);
    const waveaiModeConfig = await RpcApi.GetWaveAIModeConfigCommand(TabRpcClient);
    globalStore.set(atoms.waveaiModeConfigAtom, waveaiModeConfig.configs);
}
```

- [ ] **Step 2: Rewrite `wave.ts` `initWave` to delegate to `bootWaveCore`**

In `frontend/wave.ts`, replace the body of `initWave` (`:142-209`) with a call to `bootWaveCore` plus the render block it kept. Add the import at the top:

```typescript
import { bootWaveCore } from "@/app/boot/boot-core";
```

New `initWave` (Electron path — keeps `loadAllWorkspaceTabs`, `registerGlobalKeys`, `registerElectronReinjectKeyHandler`, and the `App` render that `bootWaveCore` intentionally does NOT include):

```typescript
async function initWave(initOpts: WaveInitOpts) {
    await bootWaveCore(initOpts);
    registerGlobalKeys();
    registerElectronReinjectKeyHandler();
    console.log("Wave First Render");
    let firstRenderResolveFn: () => void = null;
    const firstRenderPromise = new Promise<void>((resolve) => {
        firstRenderResolveFn = resolve;
    });
    const reactElem = createElement(App, { onFirstRender: firstRenderResolveFn }, null);
    const elem = document.getElementById("main");
    const root = createRoot(elem);
    root.render(reactElem);
    await firstRenderPromise;
    console.log("Wave First Render Done");
    getApi().setWindowInitStatus("wave-ready");
}
```

Note: `bootWaveCore` already calls `registerControlShiftStateUpdateHandler` and sets config; remove those now-duplicated lines from `initWave` (they moved into `bootWaveCore`). `GetFullConfigCommand`/`GetWaveAIModeConfigCommand` also moved — delete their old copies from `initWave`. Leave `initBare`, `reinitWave`, `initBuilder`, and the `window.*` globals in `wave.ts` untouched.

- [ ] **Step 3: Verify no type/compile errors (Electron path intact)**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no new errors introduced by the split. (If `tsc` is slow/unavailable, confirm zero Problems in VS Code for `wave.ts` + `boot-core.ts`, per project convention.)

- [ ] **Step 4: Re-run the unit suite (nothing regressed)**

Run: `npx vitest run`
Expected: PASS (the Phase 0–2 suite + Task 1's 3 new tests).

---

## Task 3: `CockpitRoot` shell + production titlebar (skeleton)

**Files:**
- Create: `frontend/app/cockpit/cockpit-root.tsx`
- Create: `frontend/app/cockpit/titlebar.tsx`
- Create: `frontend/app/cockpit/cockpit.scss`

Rationale: the single-window shell. Titlebar uses the Tauri window API directly — the Phase 2 capabilities already grant `allow-minimize`/`allow-toggle-maximize`/`allow-close`/`allow-start-dragging`. `CockpitRoot` provides the same global React context the app root uses (`Provider store={globalStore}` + `WaveEnvContext`, via `makeWaveEnvImpl()`), but not the tab/Dnd plumbing. Skeleton first (empty main region); agents + focus pane land in Tasks 5–6.

- [ ] **Step 1: Titlebar**

```tsx
// frontend/app/cockpit/titlebar.tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
import { getCurrentWindow } from "@tauri-apps/api/window";

// drag + window controls via Tauri core window plugin (perms granted in Phase 2 capabilities).
export function CockpitTitlebar() {
    const win = getCurrentWindow();
    return (
        <div className="cockpit-titlebar" data-tauri-drag-region>
            <div className="cockpit-titlebar-title" data-tauri-drag-region>
                Wave
            </div>
            <div className="cockpit-titlebar-controls">
                <button className="cockpit-tb-btn" onClick={() => win.minimize()} aria-label="Minimize">
                    &#x2013;
                </button>
                <button className="cockpit-tb-btn" onClick={() => win.toggleMaximize()} aria-label="Maximize">
                    &#x25A1;
                </button>
                <button className="cockpit-tb-btn cockpit-tb-close" onClick={() => win.close()} aria-label="Close">
                    &#x2715;
                </button>
            </div>
        </div>
    );
}
```

- [ ] **Step 2: CockpitRoot (skeleton)**

```tsx
// frontend/app/cockpit/cockpit-root.tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
import { globalStore } from "@/app/store/jotaiStore";
import { WaveEnvContext } from "@/app/waveenv/waveenv";
import { makeWaveEnvImpl } from "@/app/waveenv/waveenvimpl";
import { Provider } from "jotai";
import { useRef } from "react";
import "./cockpit.scss";
import { CockpitTitlebar } from "./titlebar";

export function CockpitRoot() {
    const waveEnvRef = useRef(makeWaveEnvImpl());
    return (
        <Provider store={globalStore}>
            <WaveEnvContext.Provider value={waveEnvRef.current}>
                <div className="cockpit-shell">
                    <CockpitTitlebar />
                    <div className="cockpit-main">{/* agents view — Task 5 */}</div>
                </div>
            </WaveEnvContext.Provider>
        </Provider>
    );
}
```

- [ ] **Step 3: Styles**

```scss
// frontend/app/cockpit/cockpit.scss
.cockpit-shell {
    display: flex;
    flex-direction: column;
    height: 100vh;
    width: 100vw;
    overflow: hidden;
    background: var(--main-bg-color, #1a1a1a);
    color: var(--main-text-color, #eee);
}
.cockpit-titlebar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 32px;
    flex-shrink: 0;
    background: var(--panel-bg-color, #222);
    user-select: none;
}
.cockpit-titlebar-title {
    padding: 0 12px;
    font-size: 12px;
    flex: 1;
}
.cockpit-titlebar-controls {
    display: flex;
    height: 100%;
}
.cockpit-tb-btn {
    width: 44px;
    height: 100%;
    border: none;
    background: transparent;
    color: inherit;
    cursor: pointer;
    &:hover {
        background: rgba(255, 255, 255, 0.1);
    }
    &.cockpit-tb-close:hover {
        background: #c42b1c;
        color: #fff;
    }
}
.cockpit-main {
    flex: 1;
    min-height: 0;
    overflow: hidden;
    position: relative;
}
```

- [ ] **Step 4: Verify it builds in the Tauri vite project**

Run: `npx vite build --config frontend/tauri/vite.config.ts`
Expected: build succeeds (nothing imports `CockpitRoot` yet — this just confirms no syntax/type error in the new files). If the `@` alias fails to resolve, confirm `frontend/tauri/vite.config.ts` has the `@ -> frontend` alias (it must, since `main.tsx` already imports `@/app/store/*`).

---

## Task 4: Wire the Tauri entry to the real boot (observe-gate 1)

**Files:**
- Modify: `frontend/tauri/main.tsx`
- Modify: `frontend/tauri/index.html`

Rationale: switch the entry from the harness to the real boot. This is where every transitive coupling surfaces — if the cockpit imports something with an Electron-only dependency, it fails here; fixing those is part of this task's build-observe loop.

- [ ] **Step 1: Rewrite `main.tsx`**

```tsx
// frontend/tauri/main.tsx
import { invoke } from "@tauri-apps/api/core";
import { createRoot } from "react-dom/client";
import { bootWaveCore } from "@/app/boot/boot-core";
import { CockpitRoot } from "@/app/cockpit/cockpit-root";
import { hlog, installTauriApi, type InitData } from "./api";
import { installChromeListeners } from "./chrome";
import { resolveBootIds } from "./bootids";

async function boot() {
    try {
        const init = await invoke<InitData>("get_init");
        installTauriApi(init);
        installChromeListeners();
        hlog("init: ws=" + init.wsEndpoint + " web=" + init.webEndpoint + " version=" + init.version);

        const ids = await resolveBootIds();
        hlog("bootIds: " + JSON.stringify(ids));

        await bootWaveCore({
            tabId: ids.tabId,
            clientId: ids.clientId,
            windowId: ids.windowId,
            activate: true,
        } as WaveInitOpts);

        createRoot(document.getElementById("main")).render(<CockpitRoot />);
        hlog("cockpit rendered");
    } catch (e: any) {
        hlog("BOOT ERROR: " + (e?.stack ?? e?.message ?? String(e)));
        const el = document.getElementById("main") ?? document.body;
        el.innerHTML = "<pre style='color:#f88;padding:20px'>BOOT ERROR: " + String(e) + "</pre>";
    }
}

boot();
```

- [ ] **Step 2: Update `index.html` mount node to `#main`**

```html
<!-- frontend/tauri/index.html -->
<!doctype html>
<html>
    <head>
        <meta charset="utf-8" />
        <title>Wave</title>
    </head>
    <body style="margin: 0; background: #1a1a1a; color: #eee">
        <div id="main"></div>
        <script type="module" src="./main.tsx"></script>
    </body>
</html>
```

- [ ] **Step 3: Observe-gate 1 — it boots**

Run: `npx tauri dev` (from project root). Watch the Rust console for `[fe-log] init:`, `[fe-log] bootIds:`, `[fe-log] cockpit rendered`.
Expected: the Tauri window opens into the cockpit shell — **production titlebar visible** (min/maximize/close work, drag strip moves the window), empty main region, **no white screen, no BOOT ERROR**. If a transitive import throws, fix it (e.g., guard or stub the offending Electron-only call) and re-run. Do not proceed until gate 1 is green.

---

## Task 5: Mount `AgentsView` standalone (observe-gate 2)

**Files:**
- Modify: `frontend/app/cockpit/cockpit-root.tsx`

Rationale: `AgentsViewModel` (`agents.tsx:605`) uses none of `nodeModel`/`tabModel`; its data is the global `liveAgentsAtom`. Mount its `viewComponent` directly with a synthetic context. ViewComponent prop contract is `{blockId, blockRef, contentRef, model}` (`block.tsx:42`).

- [ ] **Step 1: Add the standalone agents mount to `CockpitRoot`**

Replace the `cockpit-main` placeholder with a mounted `AgentsView`. Add imports + a synthetic node model:

```tsx
// add to frontend/app/cockpit/cockpit-root.tsx imports:
import { AgentsViewModel } from "@/app/view/agents/agents";
import { getTabModelByTabId } from "@/app/store/tab-model";
import { atoms as globalAtoms } from "@/app/store/global";
import { atom } from "jotai";

// inside CockpitRoot, after waveEnvRef:
const tabId = globalStore.get(globalAtoms.staticTabId);
const agentsModelRef = useRef<AgentsViewModel>(null);
if (agentsModelRef.current == null) {
    const blockId = "cockpit-agents";
    const nodeModel: any = {
        blockId,
        isFocused: atom(true),
        isMagnified: atom(false),
        anyMagnified: atom(false),
        isResizing: atom(false),
        disablePointerEvents: atom(false),
        onClose: () => {},
        focusNode: () => {},
        toggleMagnify: () => {},
    };
    agentsModelRef.current = new AgentsViewModel({
        blockId,
        nodeModel,
        tabModel: getTabModelByTabId(tabId, waveEnvRef.current as any),
        waveEnv: waveEnvRef.current,
    } as any);
}
const AgentsVC = agentsModelRef.current.viewComponent;
const agentsBlockRef = useRef<HTMLDivElement>(null);
const agentsContentRef = useRef<HTMLDivElement>(null);
```

Render:

```tsx
<div className="cockpit-main" ref={agentsContentRef}>
    <AgentsVC
        blockId="cockpit-agents"
        blockRef={agentsBlockRef}
        contentRef={agentsContentRef}
        model={agentsModelRef.current}
    />
</div>
```

- [ ] **Step 2: Observe-gate 2 — real roster renders**

Run: `npx tauri dev`. Launch a couple of Claude agents in the Electron app (same workspace/data dir is the spike's isolated home — if the Tauri spike uses its own temp home per `main.rs`, start agents inside the Tauri app's terminal once gate 3 exists; for gate 2, seeding a tab/block via the backend is enough to show a roster row).
Expected: the cockpit lists the workspace's agents (or an empty-state if none). No crash from the standalone mount. Compare against Electron's agents view side-by-side if the data dir is shared. Fix any hook/context error surfaced (e.g., a missing atom read) before proceeding.

---

## Task 6: Inline focus pane — standalone term for the focused agent (observe-gate 3)

**Files:**
- Create: `frontend/app/cockpit/focus-pane.tsx`
- Modify: `frontend/app/cockpit/cockpit-root.tsx`

Rationale: the `setActiveTab(agent.id)` replacement (P5a-4). `AgentVM.blockId` is the terminal block OID (`liveagents.ts:54`). Mount the `term` view via `makeViewModel(blockId, "term", nodeModel, tabModel, waveEnv)` (`blockregistry.ts:53`) — `TermViewModel` registers its own wshrpc route in its constructor (`term-model.ts:88`), which works because `bootWaveCore` connected the global client. This is the highest-risk task (P5a-5); if it must be isolated, the roster (Tasks 1–5) still ships.

- [ ] **Step 1: Focus pane component**

```tsx
// frontend/app/cockpit/focus-pane.tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
import { makeViewModel } from "@/app/block/blockregistry";
import { getTabModelByTabId } from "@/app/store/tab-model";
import { useWaveEnv } from "@/app/waveenv/waveenv";
import { atom } from "jotai";
import { useMemo, useRef } from "react";

// renders the focused agent's terminal block in-place (the setActiveTab replacement).
export function CockpitFocusPane({ blockId, tabId }: { blockId: string; tabId: string }) {
    const waveEnv = useWaveEnv();
    const blockRef = useRef<HTMLDivElement>(null);
    const contentRef = useRef<HTMLDivElement>(null);
    const model = useMemo(() => {
        const nodeModel: any = {
            blockId,
            isFocused: atom(true),
            isMagnified: atom(false),
            anyMagnified: atom(false),
            isResizing: atom(false),
            disablePointerEvents: atom(false),
            onClose: () => {},
            focusNode: () => {},
            toggleMagnify: () => {},
        };
        return makeViewModel(blockId, "term", nodeModel, getTabModelByTabId(tabId, waveEnv as any), waveEnv);
    }, [blockId, tabId]);
    const VC = model.viewComponent;
    return (
        <div className="cockpit-focus-pane" ref={contentRef}>
            <VC blockId={blockId} blockRef={blockRef} contentRef={contentRef} model={model} />
        </div>
    );
}
```

- [ ] **Step 2: Track the focused agent's blockId in `CockpitRoot` and render the pane**

The agents view already exposes a focus concept; surface the focused agent's `blockId` to `CockpitRoot`. Minimal approach: read the focused agent from the roster in `CockpitRoot` and render the pane beside the list. Add to `CockpitRoot`:

```tsx
import { useAtomValue } from "jotai";
import { CockpitFocusPane } from "./focus-pane";

// inside CockpitRoot:
const agents = useAtomValue(agentsModelRef.current.agentsAtom);
const focusBlockId = agents?.[0]?.blockId; // first agent for the gate; wire to the real focus index next
```

Render layout (list left, terminal right):

```tsx
<div className="cockpit-main">
    <div className="cockpit-roster" ref={agentsContentRef}>
        <AgentsVC blockId="cockpit-agents" blockRef={agentsBlockRef} contentRef={agentsContentRef} model={agentsModelRef.current} />
    </div>
    {focusBlockId ? <CockpitFocusPane blockId={focusBlockId} tabId={globalStore.get(globalAtoms.staticTabId)} /> : null}
</div>
```

Add styles to `cockpit.scss`:

```scss
.cockpit-main {
    display: flex;
}
.cockpit-roster {
    width: 360px;
    flex-shrink: 0;
    overflow: auto;
}
.cockpit-focus-pane {
    flex: 1;
    min-width: 0;
    overflow: hidden;
}
```

- [ ] **Step 3: Wire the focus pane to the cockpit's real focus index**

Replace the temporary `agents?.[0]` with the agents view's actual focus selection. Read how `agents.tsx` tracks `focusId`/cursor (`agents.tsx:378,422,469`) and lift it (e.g., a focus atom on `AgentsViewModel`, or a callback prop) so `CockpitRoot` renders the pane for the *highlighted* agent. Change `onOpenTerminal`/the `t` key from `setActiveTab(a.id)` to set that focus target (do **not** delete `setActiveTab` — that is 5b).

- [ ] **Step 4: Observe-gate 3 — inline terminal works**

Run: `npx tauri dev`. Highlight an agent.
Expected: its live terminal renders inline in the focus pane; new PTY output appears; typing in the composer reaches the PTY (input round-trips). Switching the highlighted agent swaps the terminal. Fix focus/resize issues in the build-observe loop until green.

---

## Task 7: Capabilities + chrome/stub regression (observe-gates 4 & 5)

**Files:**
- Modify (if needed): `src-tauri/capabilities/default.json`

- [ ] **Step 1: Add any real-boot-required permission**

If gate 1–3 logged a Tauri permission denial (e.g., a core API the real cockpit calls that the harness didn't), add the exact permission string to `capabilities/default.json` `permissions[]` and re-run. The `tauri-build` codegen rejects unknown strings loudly. If no denial occurred, make no change (no speculative permissions — spec §6).

- [ ] **Step 2: Observe-gate 4 — Phase 2 chrome intact in the real shell**

Run: `npx tauri dev`. Verify: drag/minimize/maximize/close (titlebar); zoom `Ctrl+=`/`Ctrl+-`/`Ctrl+0` changes content + the `--zoomfactor` CSS var; `F11` toggles fullscreen; right-click pops the `buildTauriMenu` native menu.
Expected: all Phase 2 behaviors work unchanged inside `CockpitRoot`.

- [ ] **Step 3: Observe-gate 5 — no happy-path stub**

With `npx tauri dev` running, exercise boot → roster → focus a terminal. Watch the Rust console.
Expected: **no** `[tauri-bridge] stub called:` warning on the happy path (cut/obsolete methods aren't reached). If one appears, decide: real-implement it here if it's genuinely needed by the cockpit, or confirm it's incidental and safe. Record the finding.

---

## Task 8: Full verification

- [ ] **Step 1: Unit suite**

Run: `npx vitest run`
Expected: PASS — Phase 0–2 suite + Task 1's 3 tests, no regressions.

- [ ] **Step 2: Rust codegen check**

Run: `cargo check --manifest-path src-tauri/Cargo.toml`
Expected: PASS (capabilities codegen valid; no new Rust was added, but this validates any capability edit from Task 7).

- [ ] **Step 3: Confirm all five observe-gates green**

Re-run `npx tauri dev` once more and confirm gates 1–5 in one session: boots → real roster → inline terminal (output + input) → Phase 2 chrome → no happy-path stub. Record the result in the completion note.

---

## Task 9: Cleanup + single commit

**Files:**
- Delete: `frontend/tauri/terminal-harness.tsx`

- [ ] **Step 1: Remove the retired harness (P5a-7)**

Delete `frontend/tauri/terminal-harness.tsx`. Grep to confirm nothing imports it:

Run: `npx vitest run` and a search for `terminal-harness`.
Expected: no remaining references (main.tsx no longer imports it).

- [ ] **Step 2: Self-review the diff**

Confirm: no commented-out code, no debug `console.log` beyond intentional `hlog` boot markers, `wave.ts` Electron path unchanged in behavior, no deletions of block/tab/layout/workspace machinery (that is 5b).

- [ ] **Step 3: Show the commit for approval, then commit**

Per project git rules, present files (status + summary) and the message, ask "Awaiting approval. Proceed? (yes/no)", then on approval:

```bash
git add frontend/tauri/bootids.ts frontend/tauri/bootids.test.ts \
        frontend/app/boot/boot-core.ts frontend/wave.ts \
        frontend/app/cockpit/ frontend/tauri/main.tsx frontend/tauri/index.html \
        src-tauri/capabilities/default.json \
        docs/superpowers/specs/2026-06-24-tauri-phase5a-boot-cockpit-design.md \
        docs/superpowers/plans/2026-06-24-tauri-phase5a-boot-cockpit.md \
        docs/tauri-migration-meta-spec.md
git rm frontend/tauri/terminal-harness.tsx
git commit -m "feat(tauri): phase-5a boot real cockpit (frontend-resolved boot + standalone agents/term)"
```

(The spec, plan, and meta-spec roadmap edits fold into this feature commit per project rules — not a separate docs commit.)

---

## Self-Review (against the spec)

**Spec coverage:** §5.1 boot seam → Tasks 1 (resolveBootIds) + 2 (bootWaveCore); refined to HTTP-only (no bootstrap-route re-pin) — same decision P5a-3, simpler mechanism, noted in Task 1. §5.2 CockpitRoot → Task 3. §5.3 titlebar + standalone agents → Tasks 3 + 5. §5.4 inline focus pane → Task 6. §5.5 entry swap → Task 4 + Task 9 (harness delete). §6 capabilities/no-new-Rust → Task 7 + Task 8 cargo check. §7 unit tests → Task 1; observe-gates 1–5 → Tasks 4/5/6/7. §8 deferrals (deletions, consumer-flips) → explicitly NOT touched (Task 9 self-review guards this). Each P5a decision maps to a task.

**Placeholder scan:** code is complete for the deterministic tasks (1, 2, 3, 4). Tasks 5–6 carry real starter code + the recipe and are explicitly build-observe (per spec §7, integration is observe-gated, not unit-scriptable) — the one genuinely discovered piece is lifting the agents view's focus index (Task 6 Step 3), which references the exact source lines to read. This is honest scoping, not a placeholder.

**Type consistency:** `BootIds` fields (`clientId/windowId/workspaceId/tabId`) match `resolveBootIds` and the `bootWaveCore` `WaveInitOpts` call. `viewComponent` prop contract `{blockId, blockRef, contentRef, model}` matches `block.tsx:42` across Tasks 5–6. `makeViewModel(blockId, view, nodeModel, tabModel, waveEnv)` matches `blockregistry.ts:53`. `AgentVM.blockId` is the terminal OID (Task 6) per `liveagents.ts:54`.
