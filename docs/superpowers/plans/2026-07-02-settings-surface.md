# Settings Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Settings surface to the cockpit exposing five preferences (default startup surface, details-rail default, persisted New Agent launch flags, terminal font size, memory vault path).

**Architecture:** The cockpit switches "surfaces" via the left NavRail. `"settings"` becomes a new `SurfaceKey` (deliberately excluded from the numbered `SURFACE_ORDER`), rendered by `cockpitshell.tsx` and reached via a gear button pinned to the bottom of the NavRail. Three prefs persist to `localStorage` via `atomWithStorage`; two write `settings.json` via the existing `SetConfigCommand` RPC (which merges, so single-key writes are safe). No Go changes, no `task generate`.

**Tech Stack:** React 19, jotai (`atomWithStorage` from `jotai/utils`), Tailwind v4 `@theme` tokens, vitest. Config read via `getSettingsKeyAtom` (`@/app/store/global`), write via `RpcApi.SetConfigCommand` (`@/app/store/wshclientapi`) with `TabRpcClient` (`@/app/store/wshrpcutil`).

**Spec:** `docs/superpowers/specs/2026-07-02-settings-surface-design.md`

**Git note (user CLAUDE.md overrides skill default):** Do NOT commit per-task. All changes batch into a single commit at the end (Task 8), gated on explicit user approval.

**Verify commands:**
- Typecheck: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (baseline has ~3 pre-existing `frontend/tauri/api.test.ts` errors — ignore only those).
- Unit tests: `npx vitest run <path>`.
- Visual: `node scripts/cdp-shot.mjs <out.png>` against the running dev app.

---

## File Structure

- **Create** `frontend/app/view/agents/cockpitprefsstore.ts` — persisted startup-surface atom + two pure helpers (`startupSurfaceOptions`, `coerceFontSize`).
- **Create** `frontend/app/view/agents/cockpitprefsstore.test.ts` — unit tests for the two pure helpers.
- **Create** `frontend/app/view/agents/settingssurface.tsx` — the Settings surface component.
- **Modify** `frontend/app/view/agents/naflagsstore.ts` — upgrade the two flag atoms to `atomWithStorage`.
- **Modify** `frontend/app/view/agents/agents.tsx` — add `"settings"` to the `SurfaceKey` union.
- **Modify** `frontend/app/view/agents/cockpitshell.tsx` — render `<SettingsSurface>` when `surface === "settings"`.
- **Modify** `frontend/app/view/agents/navrail.tsx` — add a gear button pinned to the bottom.
- **Modify** `frontend/app/cockpit/cockpit-root.tsx` — apply the startup-surface pref on boot.

---

## Task 1: Persist New Agent launch flags

**Files:**
- Modify: `frontend/app/view/agents/naflagsstore.ts`

This is a mechanical atom swap — the New Agent modal already reads/writes these atoms as its single source of truth, so persistence falls out with no other change. No unit test (there is no behavior to assert beyond the storage wrapper; the existing modal tests continue to exercise reads/writes). Verified by typecheck.

- [ ] **Step 1: Replace the two atom declarations**

In `frontend/app/view/agents/naflagsstore.ts`, change the imports and the two atom definitions.

Current:
```typescript
import { atom } from "jotai";

import type { Runtime } from "./launch";

export const naFlagsAtom = atom<Partial<Record<Runtime, Record<string, boolean>>>>({});

export const naRememberFlagsAtom = atom<boolean>(true);
```

New:
```typescript
import { atomWithStorage } from "jotai/utils";

import type { Runtime } from "./launch";

// Persisted (localStorage) so a "remembered" flag set survives app restarts, and so the Settings
// surface and the New Agent modal edit the same durable source of truth.
export const naFlagsAtom = atomWithStorage<Partial<Record<Runtime, Record<string, boolean>>>>(
    "agent.launch.flags",
    {}
);

// When on, the enabled flags carry over to the next New Agent open; when off, they clear after launch.
export const naRememberFlagsAtom = atomWithStorage<boolean>("agent.launch.remember", true);
```

Keep the existing top-of-file comments describing the per-runtime scoping.

- [ ] **Step 2: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: no NEW errors (only the ~3 pre-existing `api.test.ts` errors).

---

## Task 2: Prefs store + pure helpers (TDD)

**Files:**
- Create: `frontend/app/view/agents/cockpitprefsstore.ts`
- Test: `frontend/app/view/agents/cockpitprefsstore.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `frontend/app/view/agents/cockpitprefsstore.test.ts`:
```typescript
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { coerceFontSize, startupSurfaceOptions } from "./cockpitprefsstore";

describe("startupSurfaceOptions", () => {
    it("returns the workflow surfaces without the agent surface", () => {
        const opts = startupSurfaceOptions();
        expect(opts).not.toContain("agent");
        expect(opts).not.toContain("settings");
        expect(opts).toContain("cockpit");
        expect(opts).toContain("usage");
    });
});

describe("coerceFontSize", () => {
    it("parses a valid integer", () => {
        expect(coerceFontSize("14")).toBe(14);
    });
    it("clamps below the minimum", () => {
        expect(coerceFontSize("2")).toBe(6);
    });
    it("clamps above the maximum", () => {
        expect(coerceFontSize("999")).toBe(48);
    });
    it("floors a decimal", () => {
        expect(coerceFontSize("13.7")).toBe(13);
    });
    it("rejects non-numeric input", () => {
        expect(coerceFontSize("abc")).toBeNull();
    });
    it("rejects empty input", () => {
        expect(coerceFontSize("")).toBeNull();
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run frontend/app/view/agents/cockpitprefsstore.test.ts`
Expected: FAIL — cannot resolve `./cockpitprefsstore` (module not found).

- [ ] **Step 3: Write the implementation**

Create `frontend/app/view/agents/cockpitprefsstore.ts`:
```typescript
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Cockpit-native preferences persisted to localStorage (the atomWithStorage convention established
// by railstore.ts). The Settings surface edits these; the cockpit reads them on boot.

import { atomWithStorage } from "jotai/utils";
import { SURFACE_ORDER, type SurfaceKey } from "./agents";

// Which surface opens on launch. Defaults to the cockpit overview (matches prior hardcoded behavior).
export const startupSurfaceAtom = atomWithStorage<SurfaceKey>("cockpit.startup.surface", "cockpit");

// Surfaces offered as a startup choice: the numbered workflow set minus "agent" (it needs a live
// agent to be meaningful). "settings" is naturally absent — it was never in SURFACE_ORDER.
export function startupSurfaceOptions(): SurfaceKey[] {
    return SURFACE_ORDER.filter((k) => k !== "agent");
}

const FONT_SIZE_MIN = 6;
const FONT_SIZE_MAX = 48;

// Parse a font-size input to an integer within range, or null when the input isn't a usable number
// (so the caller can skip the config write instead of persisting garbage).
export function coerceFontSize(raw: string): number | null {
    const n = Number(raw);
    if (raw.trim() === "" || Number.isNaN(n)) {
        return null;
    }
    return Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, Math.floor(n)));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run frontend/app/view/agents/cockpitprefsstore.test.ts`
Expected: PASS (7 assertions across 2 suites).

---

## Task 3: Add the `settings` surface key

**Files:**
- Modify: `frontend/app/view/agents/agents.tsx:25-33`

Mechanical union edit. `"settings"` is added to the type but NOT to `SURFACE_ORDER` (that array drives `Ctrl+1..8` and the rail's workflow loop; Settings is reached via the pinned gear instead).

- [ ] **Step 1: Extend the SurfaceKey union**

In `frontend/app/view/agents/agents.tsx`, change:
```typescript
export type SurfaceKey =
    | "cockpit"
    | "agent"
    | "activity"
    | "channels"
    | "sessions"
    | "files"
    | "memory"
    | "usage";
```
to:
```typescript
export type SurfaceKey =
    | "cockpit"
    | "agent"
    | "activity"
    | "channels"
    | "sessions"
    | "files"
    | "memory"
    | "usage"
    | "settings";
```
Leave `SURFACE_ORDER` (lines 36-45) unchanged.

- [ ] **Step 2: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: the `ICON` map in `navrail.tsx` (`Record<SurfaceKey, ReactNode>`) now errors that `"settings"` is missing — this is expected and fixed in Task 6. No other new errors. (If running tasks strictly in order, this error is transiently present until Task 6.)

---

## Task 4: Build the Settings surface component

**Files:**
- Create: `frontend/app/view/agents/settingssurface.tsx`

Uses Tailwind `@theme` tokens only (no SCSS, no raw hex — project convention). Reuses `ITEMS` from `navrail.tsx` for surface labels, `RUNTIME_FLAGS`/`Runtime` from `launch.ts` for the flag editor, and the persisted atoms from Tasks 1-2. Config inputs seed local state from `getSettingsKeyAtom` and commit via `SetConfigCommand` on blur/Enter/Save.

- [ ] **Step 1: Create the component**

Create `frontend/app/view/agents/settingssurface.tsx`:
```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { getSettingsKeyAtom } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { cn } from "@/util/util";
import { useAtom, useAtomValue } from "jotai";
import { useState } from "react";
import type { AgentsViewModel, SurfaceKey } from "./agents";
import { coerceFontSize, startupSurfaceAtom, startupSurfaceOptions } from "./cockpitprefsstore";
import { RUNTIME_FLAGS, type Runtime } from "./launch";
import { naFlagsAtom, naRememberFlagsAtom } from "./naflagsstore";
import { ITEMS } from "./navrail";
import { railVisibleAtom } from "./railstore";

const LABEL: Record<SurfaceKey, string> = Object.fromEntries(
    ITEMS.map((i) => [i.key, i.label])
) as Record<SurfaceKey, string>;

// Runtimes with a flag catalog (terminal has none) — the flag editor only lists these.
const FLAG_RUNTIMES: { id: Runtime; name: string }[] = [
    { id: "claude", name: "Claude Code" },
    { id: "codex", name: "Codex" },
    { id: "antigravity", name: "Antigravity" },
];

export function SettingsSurface({ model }: { model: AgentsViewModel }) {
    return (
        <div className="flex h-full flex-col overflow-y-auto bg-background px-8 py-6">
            <div className="mb-6">
                <h1 className="text-[19px] font-bold text-primary">Settings</h1>
                <p className="mt-1 text-[12.5px] text-muted">Cockpit preferences and New Agent defaults.</p>
            </div>
            <div className="flex max-w-[640px] flex-col gap-7">
                <GeneralSection />
                <NewAgentDefaultsSection />
                <TerminalSection />
                <MemorySection />
            </div>
        </div>
    );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div>
            <div className="mb-[11px] font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-muted">
                {label}
            </div>
            <div className="flex flex-col gap-[14px]">{children}</div>
        </div>
    );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
    return (
        <div className="flex items-center gap-4">
            <div className="min-w-0 flex-1">
                <div className="text-[13px] font-medium text-secondary">{label}</div>
                {hint ? <div className="mt-0.5 text-[11.5px] text-muted">{hint}</div> : null}
            </div>
            <div className="shrink-0">{children}</div>
        </div>
    );
}

function Toggle({ on, onToggle }: { on: boolean; onToggle: () => void }) {
    return (
        <button
            type="button"
            role="switch"
            aria-checked={on}
            onClick={onToggle}
            className={cn(
                "relative h-[20px] w-[34px] shrink-0 cursor-pointer rounded-full transition-colors",
                on ? "bg-accent" : "bg-edge-strong"
            )}
        >
            <span
                className={cn(
                    "absolute top-[3px] h-[14px] w-[14px] rounded-full bg-background transition-all",
                    on ? "left-[18px]" : "left-[2px]"
                )}
            />
        </button>
    );
}

function GeneralSection() {
    const [startup, setStartup] = useAtom(startupSurfaceAtom);
    const [railVisible, setRailVisible] = useAtom(railVisibleAtom);
    const options = startupSurfaceOptions();
    return (
        <Section label="General">
            <Row label="Startup surface" hint="Which surface opens when the app launches.">
                <div className="flex flex-wrap justify-end gap-[6px]">
                    {options.map((k) => (
                        <button
                            key={k}
                            type="button"
                            onClick={() => setStartup(k)}
                            className={cn(
                                "cursor-pointer rounded-[7px] border px-[10px] py-[5px] text-[12px] font-medium",
                                startup === k
                                    ? "border-accent-700 bg-accentbg text-primary"
                                    : "border-edge-mid bg-surface text-muted-foreground hover:border-edge-strong"
                            )}
                        >
                            {LABEL[k] ?? k}
                        </button>
                    ))}
                </div>
            </Row>
            <Row label="Show details rail by default" hint="The per-agent git/details rail on the Agent surface.">
                <Toggle on={railVisible} onToggle={() => setRailVisible((v) => !v)} />
            </Row>
        </Section>
    );
}

function NewAgentDefaultsSection() {
    const [flags, setFlags] = useAtom(naFlagsAtom);
    const [remember, setRemember] = useAtom(naRememberFlagsAtom);
    const [runtime, setRuntime] = useState<Runtime>("claude");
    const catalog = RUNTIME_FLAGS[runtime];
    const runtimeFlags = flags[runtime] ?? {};
    const setFlag = (id: string, on: boolean) =>
        setFlags((prev) => ({ ...prev, [runtime]: { ...prev[runtime], [id]: on } }));
    return (
        <Section label="New Agent defaults">
            <Row label="Remember flags" hint="Reuse the enabled flags for every new agent (instead of clearing after launch).">
                <Toggle on={remember} onToggle={() => setRemember((v) => !v)} />
            </Row>
            <div className="flex gap-[6px]">
                {FLAG_RUNTIMES.map((r) => (
                    <button
                        key={r.id}
                        type="button"
                        onClick={() => setRuntime(r.id)}
                        className={cn(
                            "cursor-pointer rounded-[7px] border px-[11px] py-[6px] text-[12px] font-medium",
                            runtime === r.id
                                ? "border-accent-700 bg-accentbg text-primary"
                                : "border-edge-mid bg-surface text-muted-foreground hover:border-edge-strong"
                        )}
                    >
                        {r.name}
                    </button>
                ))}
            </div>
            <div className="flex flex-col gap-[7px] rounded-[10px] border border-edge-mid bg-surface p-[11px]">
                {catalog.map((f) => {
                    const on = !!runtimeFlags[f.id];
                    return (
                        <button
                            key={f.id}
                            type="button"
                            onClick={() => setFlag(f.id, !on)}
                            className="flex w-full cursor-pointer items-center gap-[10px] rounded-[7px] px-[8px] py-[6px] text-left hover:bg-surface-hover"
                        >
                            <span
                                className={cn(
                                    "flex h-[15px] w-[15px] shrink-0 items-center justify-center rounded-[4px] border font-mono text-[9px] font-bold text-background",
                                    on ? "border-accent bg-accent" : "border-edge-strong"
                                )}
                            >
                                {on ? "✓" : ""}
                            </span>
                            <span
                                className={cn(
                                    "shrink-0 font-mono text-[11.5px] font-semibold",
                                    on ? "text-accent-soft" : "text-muted-foreground"
                                )}
                            >
                                {f.flag}
                            </span>
                            <span className="flex-1 truncate text-right text-[11px] text-muted">{f.desc}</span>
                        </button>
                    );
                })}
            </div>
        </Section>
    );
}

function TerminalSection() {
    const stored = useAtomValue(getSettingsKeyAtom("term:fontsize"));
    const [draft, setDraft] = useState<string>(stored != null ? String(stored) : "");
    const commit = () => {
        const n = coerceFontSize(draft);
        if (n == null) {
            setDraft(stored != null ? String(stored) : "");
            return;
        }
        setDraft(String(n));
        void RpcApi.SetConfigCommand(TabRpcClient, { "term:fontsize": n });
    };
    return (
        <Section label="Terminal">
            <Row label="Font size" hint="Default font size for agent terminals (px).">
                <input
                    type="number"
                    min={6}
                    max={48}
                    value={draft}
                    placeholder="12"
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={commit}
                    onKeyDown={(e) => {
                        if (e.key === "Enter") {
                            (e.target as HTMLInputElement).blur();
                        }
                    }}
                    className="w-[72px] rounded-[8px] border border-edge-mid bg-surface px-3 py-[7px] text-right font-mono text-[13px] text-primary outline-none focus:border-accent-700"
                />
            </Row>
        </Section>
    );
}

function MemorySection() {
    const stored = useAtomValue(getSettingsKeyAtom("memory:vaultpath"));
    const [draft, setDraft] = useState<string>(stored ?? "");
    const [saved, setSaved] = useState(false);
    const dirty = draft !== (stored ?? "");
    const commit = () => {
        void RpcApi.SetConfigCommand(TabRpcClient, { "memory:vaultpath": draft.trim() }).then(() => {
            setSaved(true);
        });
    };
    return (
        <Section label="Memory">
            <div>
                <div className="text-[13px] font-medium text-secondary">Vault path</div>
                <div className="mt-0.5 text-[11.5px] text-muted">Folder the Memory surface reads and writes.</div>
                <div className="mt-[9px] flex items-center gap-2">
                    <input
                        type="text"
                        value={draft}
                        placeholder="~/vault"
                        onChange={(e) => {
                            setDraft(e.target.value);
                            setSaved(false);
                        }}
                        className="min-w-0 flex-1 rounded-[8px] border border-edge-mid bg-surface px-3 py-[7px] font-mono text-[12.5px] text-primary outline-none focus:border-accent-700"
                    />
                    <button
                        type="button"
                        onClick={commit}
                        disabled={!dirty}
                        className={cn(
                            "shrink-0 rounded-[8px] px-[15px] py-[7px] text-[12.5px] font-semibold",
                            dirty
                                ? "cursor-pointer bg-accent text-background hover:bg-accenthover"
                                : "cursor-not-allowed bg-surface text-muted"
                        )}
                    >
                        {saved && !dirty ? "Saved" : "Save"}
                    </button>
                </div>
            </div>
        </Section>
    );
}
```

- [ ] **Step 2: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: no new errors from this file. (The `navrail.tsx` `ICON` error from Task 3 is still present until Task 6.)

Note: `SettingsSurface` takes `model` for signature parity with the other surfaces; it is currently unused inside. If the linter flags the unused prop, prefix the destructure with a leading underscore is NOT valid for destructured props — instead keep the prop and reference nothing, or drop the prop from the signature and the call site in Task 5. Prefer keeping the prop for parity; suppress with a `void model;` line at the top of the component body if a no-unused-vars rule fires.

---

## Task 5: Render the surface in the shell

**Files:**
- Modify: `frontend/app/view/agents/cockpitshell.tsx:9-19` (imports) and `:73-77` (branch)

- [ ] **Step 1: Add the import**

In `frontend/app/view/agents/cockpitshell.tsx`, add to the existing import block (alphabetical with the other surface imports):
```typescript
import { SettingsSurface } from "./settingssurface";
```

- [ ] **Step 2: Add the render branch**

Change the tail of the branch chain from:
```tsx
                        ) : surface === "memory" ? (
                            <MemorySurface model={model} />
                        ) : (
                            <PlaceholderSurface surface={surface} />
                        )}
```
to:
```tsx
                        ) : surface === "memory" ? (
                            <MemorySurface model={model} />
                        ) : surface === "settings" ? (
                            <SettingsSurface model={model} />
                        ) : (
                            <PlaceholderSurface surface={surface} />
                        )}
```

- [ ] **Step 3: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: no new errors from this file (navrail `ICON` error still present until Task 6).

---

## Task 6: Add the gear button pinned to the NavRail bottom

**Files:**
- Modify: `frontend/app/view/agents/navrail.tsx`

Add `"settings"` to the `ICON` map (fixes the Task 3 typecheck error), then restructure the `<nav>` so the workflow `ITEMS` render at the top and a single Settings button is pinned to the bottom via a flex spacer.

- [ ] **Step 1: Add the settings gear to the ICON map**

In `frontend/app/view/agents/navrail.tsx`, add this entry inside the `ICON` object (e.g. after the `usage` entry, before the closing `};`):
```tsx
    settings: (
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6">
            <circle cx="10" cy="10" r="2.6" />
            <path d="M10 1.5v2.2M10 16.3v2.2M18.5 10h-2.2M3.7 10H1.5M15.8 4.2l-1.6 1.6M5.8 14.2l-1.6 1.6M15.8 15.8l-1.6-1.6M5.8 5.8L4.2 4.2" strokeLinecap="round" />
        </svg>
    ),
```

- [ ] **Step 2: Restructure the nav layout**

Replace the `return (...)` block of `NavRail` (currently rendering only `ITEMS.map`) with a version that pins Settings to the bottom. The whole component becomes:
```tsx
export function NavRail({ model }: { model: AgentsViewModel }) {
    const [active, setActive] = useAtom(model.surfaceAtom);
    const renderItem = (key: SurfaceKey, label: string) => {
        const isActive = active === key;
        return (
            <button
                key={key}
                type="button"
                onClick={() => setActive(key)}
                className={cn(
                    "relative mx-2 flex cursor-pointer flex-col items-center gap-[5px] rounded-[10px] border-0 bg-transparent py-[11px] text-muted hover:text-muted-foreground",
                    isActive && "text-accent-soft"
                )}
            >
                {isActive ? (
                    <>
                        <span className="absolute inset-0 rounded-[10px] bg-accent/10" />
                        <span className="absolute left-[-8px] top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-[3px] bg-accent" />
                    </>
                ) : null}
                <span className="relative z-[1]">{ICON[key]}</span>
                <span className="relative z-[1] text-[10px] font-semibold">{label}</span>
            </button>
        );
    };
    return (
        <nav className="flex w-[78px] shrink-0 flex-col gap-[3px] border-r border-border bg-surface py-2.5">
            {ITEMS.map(({ key, label }) => renderItem(key, label))}
            <div className="flex-1" />
            {renderItem("settings", "Settings")}
        </nav>
    );
}
```

(This refactors the per-item markup into a local `renderItem` helper so the pinned Settings button reuses the exact active-state styling — DRY, no divergence.)

- [ ] **Step 3: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: clean (only the ~3 pre-existing `api.test.ts` errors remain).

---

## Task 7: Apply the startup-surface pref on boot

**Files:**
- Modify: `frontend/app/cockpit/cockpit-root.tsx:41-51`

The model-init block runs once (guarded by `agentsModelRef.current == null`). After the model is created, read the persisted startup surface and set the surface atom.

- [ ] **Step 1: Add the import**

In `frontend/app/cockpit/cockpit-root.tsx`, add:
```typescript
import { startupSurfaceAtom } from "@/app/view/agents/cockpitprefsstore";
```

- [ ] **Step 2: Apply the pref in the init block**

In `CockpitBody`, change the init block from:
```typescript
    if (agentsModelRef.current == null) {
        tabIdRef.current = globalStore.get(atoms.staticTabId);
        const model = new AgentsViewModel({
            blockId: AgentsBlockId,
            nodeModel: makeSyntheticNodeModel(AgentsBlockId),
            tabModel: getTabModelByTabId(tabIdRef.current, waveEnv),
            waveEnv,
        });
        agentsModelRef.current = model;
    }
```
to:
```typescript
    if (agentsModelRef.current == null) {
        tabIdRef.current = globalStore.get(atoms.staticTabId);
        const model = new AgentsViewModel({
            blockId: AgentsBlockId,
            nodeModel: makeSyntheticNodeModel(AgentsBlockId),
            tabModel: getTabModelByTabId(tabIdRef.current, waveEnv),
            waveEnv,
        });
        // Open the user's chosen startup surface (defaults to "cockpit", matching prior behavior).
        globalStore.set(model.surfaceAtom, globalStore.get(startupSurfaceAtom));
        agentsModelRef.current = model;
    }
```

- [ ] **Step 3: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: clean (only the ~3 pre-existing `api.test.ts` errors).

---

## Task 8: Full verification + commit

**Files:** none (verification + commit only)

- [ ] **Step 1: Typecheck the whole frontend**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: only the ~3 pre-existing `frontend/tauri/api.test.ts` errors.

- [ ] **Step 2: Run the unit tests**

Run: `npx vitest run frontend/app/view/agents/cockpitprefsstore.test.ts`
Expected: PASS.

Then run the full suite to confirm no regressions (the New Agent modal tests still pass with the persisted atoms):
Run: `npx vitest run`
Expected: all green (matching the prior baseline count).

- [ ] **Step 3: Visual verification via CDP**

With the dev app running (`task dev`), capture the Settings surface:
- Click the gear at the bottom of the NavRail (or `globalStore.set(model.surfaceAtom, "settings")` via `Runtime.evaluate`).
- Run: `node scripts/cdp-shot.mjs settings-surface.png`
- Confirm: gear pinned to rail bottom with active styling; all four sections render; startup-surface picker excludes Agent; toggling a flag persists across a reload; changing font size / vault path writes `settings.json` (re-open Settings after reload to confirm the value stuck).

- [ ] **Step 4: Self-review the diff**

Run: `git status` and `git --no-pager diff`
Confirm: no debug statements, no commented-out code, only the 8 files from the File Structure section plus the two new docs.

- [ ] **Step 5: Request commit approval**

Present the file list (status + one-line change summary each) and the proposed message, then ask: "Awaiting approval. Proceed? (yes/no)". Do NOT commit before approval.

Proposed message:
```
feat(cockpit): settings surface (startup surface, rail default, launch flags, term font, vault path)
```
Include the spec and plan docs in this same commit (they fold into the feature commit per the repo git rules).

---

## Self-Review (completed by plan author)

**Spec coverage:**
- Default startup surface → Task 2 (atom + options) + Task 4 GeneralSection + Task 7 (boot apply). ✓
- Details rail default → Task 4 GeneralSection (binds existing `railVisibleAtom`). ✓
- Persisted launch flags → Task 1 (atom upgrade) + Task 4 NewAgentDefaultsSection. ✓
- Terminal font size → Task 4 TerminalSection (read `getSettingsKeyAtom`, write `SetConfigCommand`, `coerceFontSize`). ✓
- Memory vault path → Task 4 MemorySection. ✓
- Placement (gear pinned bottom, excluded from SURFACE_ORDER) → Task 3 + Task 6. ✓
- Testing (options list, font coercion, CDP) → Task 2 + Task 8. ✓

**Placeholder scan:** No TBD/TODO; all code steps contain complete code. ✓

**Type consistency:** `SurfaceKey` includes `"settings"` (Task 3) before it is used in `ICON`/`renderItem` (Task 6) and `LABEL`/branch (Tasks 4-5). `coerceFontSize`/`startupSurfaceOptions`/`startupSurfaceAtom` defined in Task 2, consumed in Tasks 4 & 7 with matching signatures. `naFlagsAtom`/`naRememberFlagsAtom` names unchanged in Task 1 (only their backing changed), so the modal and Task 4 agree. `SetConfigCommand(TabRpcClient, { "term:fontsize": number })` / `{ "memory:vaultpath": string }` match the `SettingsType` keys confirmed in `gotypes.d.ts`. ✓
