# Keyboard Operability — Foundation (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a single unified keybinding registry that drives the cockpit's shortcuts, migrate every existing shortcut into it with zero behavior regression, add mnemonic `g`-leader surface teleports, and make all bindings discoverable via a which-key bar and a `?` cheat sheet.

**Architecture:** One jotai `bindingsAtom` holds the live union of active bindings (global bindings + per-surface contributions via a `useKeybindings` hook). A single window-capture-phase listener runs a **pure** `matchBinding(waveEvent, ctx, bindings)` matcher (leader state machine + precedence) and dispatches. The existing `keymodel.appHandleKeyDown` seam (used by the terminal and Monaco editor) is re-pointed at the same dispatcher. The which-key bar and cheat sheet are pure consumers of `bindingsAtom`.

**Tech Stack:** TypeScript, React 19, jotai, Tailwind v4 (`@theme` tokens), vitest. Reuses `frontend/util/keyutil.ts` (`checkKeyPressed`, `adaptFromReactOrNativeKeyEvent`) and `CHORD_TIMEOUT` from `frontend/util/sharedconst.ts`.

**Design spec:** `docs/superpowers/specs/2026-07-03-keyboard-operability-design.md`

**Out of scope (follow-up plan):** per-surface region model, `j/k` roving cursor and per-surface action keys for Files / Channels / Usage / Activity / Memory / Settings, and Agents dashboard-card triage consolidation. This plan migrates only the shortcuts that already work today plus the new `g`-leader nav.

---

## File Structure

**Create:**
- `frontend/app/store/keybindings/types.ts` — `Binding`, `KeyContext`, `MatchResult` types.
- `frontend/app/store/keybindings/matcher.ts` — pure `matchBinding()` + `isSequenceKeys()` helpers.
- `frontend/app/store/keybindings/matcher.test.ts` — exhaustive matcher unit tests.
- `frontend/app/store/keybindings/store.ts` — `bindingsAtom`, `useKeybindings()`, `registerBindings()`/`unregisterBindings()`.
- `frontend/app/store/keybindings/store.test.ts` — register/unregister + conflict-invariant tests.
- `frontend/app/store/keybindings/dispatcher.ts` — module state (leader, model, dedup), `deriveKeyContext()`, `handleWaveEvent()`, `initKeybindingDispatcher()`.
- `frontend/app/store/keybindings/bindings.ts` — `buildGlobalBindings(model)` returning the concrete global + `g`-leader + help bindings.
- `frontend/app/store/keybindings/leaderatom.ts` — `activeLeaderAtom` (drives the which-key bar).
- `frontend/app/cockpit/whichkey-bar.tsx` — transient bottom bar.
- `frontend/app/cockpit/shortcuts-cheatsheet.tsx` — the `?` modal + `cheatsheetOpenAtom`.

**Modify:**
- `frontend/app/store/keymodel.ts` — remove dead `globalKeyMap`/`globalChordMap`/chord logic; re-point `appHandleKeyDown` at the dispatcher; keep `registerControlShiftStateUpdateHandler` + `tryReinjectKey`.
- `frontend/app/cockpit/cockpit-root.tsx` — remove the two ad-hoc `window.addEventListener` blocks; call `initKeybindingDispatcher(model)` + `useKeybindings(buildGlobalBindings(model))`; render `<WhichKeyBar/>` + `<ShortcutsCheatSheet/>`.
- `frontend/app/view/agents/agentsurface.tsx` — replace the local `onKeyDown` with `useKeybindings(...)` surface bindings.
- `frontend/app/cockpit/command-palette.tsx` — add a "Keyboard shortcuts" command that opens the cheat sheet.

---

## Task 1: Types

**Files:**
- Create: `frontend/app/store/keybindings/types.ts`

- [ ] **Step 1: Write the types file**

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { SurfaceKey } from "@/app/view/agents/agents";

export type { SurfaceKey };

// Evaluated fresh on every keydown. `leader` is the active leader prefix (e.g. "g") or null.
export interface KeyContext {
    surface: SurfaceKey;
    editable: boolean; // focus is in an input/textarea/select/contenteditable (covers the terminal textarea)
    modalOpen: boolean; // command palette / new-agent / new-project / any modalsModel modal is open
    leader: string | null;
}

// keys syntax reuses keyutil descriptors:
//   single: "Ctrl:1" | "j" | "Enter" | "Shift:Tab"
//   leader sequence: "g a" (space-separated: <leader> <next>)
export interface Binding {
    id: string;
    keys: string;
    group: string; // cheat-sheet section, e.g. "Global" | "Navigation" | "Agent"
    label: string; // human text for cheat sheet + which-key bar
    when?: (ctx: KeyContext) => boolean; // default: always active
    // Return false to explicitly NOT consume the key (let it pass through, e.g. first Ctrl+C to the PTY).
    // Any other return (including void) consumes it.
    run: (ctx: KeyContext) => void | boolean;
}

export type MatchResult =
    | { kind: "none" }
    | { kind: "enterLeader"; leader: string }
    | { kind: "reset" } // invalid continuation: clear leader, consume the key
    | { kind: "resetAndProcess"; result: MatchResult } // clear leader, then act on the re-matched result
    | { kind: "run"; binding: Binding };
```

- [ ] **Step 2: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: no NEW errors (baseline has ~3 pre-existing errors in `frontend/tauri/api.test.ts`).

- [ ] **Step 3: Commit**

```bash
git add frontend/app/store/keybindings/types.ts
git commit -m "feat(keybindings): add Binding/KeyContext types"
```

---

## Task 2: Pure matcher (the core logic)

**Files:**
- Create: `frontend/app/store/keybindings/matcher.ts`
- Test: `frontend/app/store/keybindings/matcher.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { matchBinding } from "./matcher";
import type { Binding, KeyContext } from "./types";

// Build a minimal WaveKeyboardEvent literal (keyutil reads these fields directly).
function ev(key: string, mods: Partial<WaveKeyboardEvent> = {}): WaveKeyboardEvent {
    return {
        control: false,
        shift: false,
        cmd: false,
        option: false,
        meta: false,
        alt: false,
        key,
        code: "",
        location: 0,
        repeat: false,
        type: "keydown",
        ...mods,
    } as WaveKeyboardEvent;
}

const navCtx: KeyContext = { surface: "cockpit", editable: false, modalOpen: false, leader: null };
const editCtx: KeyContext = { surface: "cockpit", editable: true, modalOpen: false, leader: null };

function bind(over: Partial<Binding>): Binding {
    return { id: "x", keys: "j", group: "g", label: "l", run: () => {}, ...over };
}

describe("matchBinding", () => {
    it("matches a global chord even when editable", () => {
        const b = bind({ id: "palette", keys: "Ctrl:p", when: () => true });
        const r = matchBinding(ev("p", { control: true }), editCtx, [b]);
        expect(r).toEqual({ kind: "run", binding: b });
    });

    it("does not match a navigate single-key when editable", () => {
        const b = bind({ id: "nav", keys: "j", when: (c) => !c.editable });
        expect(matchBinding(ev("j"), editCtx, [b])).toEqual({ kind: "none" });
    });

    it("matches a navigate single-key when not editable", () => {
        const b = bind({ id: "nav", keys: "j", when: (c) => !c.editable });
        expect(matchBinding(ev("j"), navCtx, [b])).toEqual({ kind: "run", binding: b });
    });

    it("enters leader mode when a leader prefix is pressed (navigate posture)", () => {
        const b = bind({ id: "go-agent", keys: "g a", when: (c) => !c.editable && !c.modalOpen });
        expect(matchBinding(ev("g"), navCtx, [b])).toEqual({ kind: "enterLeader", leader: "g" });
    });

    it("does not enter leader mode when editable", () => {
        const b = bind({ id: "go-agent", keys: "g a", when: (c) => !c.editable && !c.modalOpen });
        expect(matchBinding(ev("g"), editCtx, [b])).toEqual({ kind: "none" });
    });

    it("runs the continuation binding when leader is active", () => {
        const b = bind({ id: "go-agent", keys: "g a", when: (c) => !c.editable && !c.modalOpen });
        const ctx: KeyContext = { ...navCtx, leader: "g" };
        expect(matchBinding(ev("a"), ctx, [b])).toEqual({ kind: "run", binding: b });
    });

    it("resets and consumes on an invalid continuation letter", () => {
        const b = bind({ id: "go-agent", keys: "g a", when: (c) => !c.editable && !c.modalOpen });
        const ctx: KeyContext = { ...navCtx, leader: "g" };
        expect(matchBinding(ev("z"), ctx, [b])).toEqual({ kind: "reset" });
    });

    it("resets and re-processes a modifier chord pressed during leader mode", () => {
        const seq = bind({ id: "go-agent", keys: "g a", when: (c) => !c.editable && !c.modalOpen });
        const chord = bind({ id: "s1", keys: "Ctrl:1", when: () => true });
        const ctx: KeyContext = { ...navCtx, leader: "g" };
        expect(matchBinding(ev("1", { control: true }), ctx, [seq, chord])).toEqual({
            kind: "resetAndProcess",
            result: { kind: "run", binding: chord },
        });
    });

    it("returns none when nothing matches", () => {
        expect(matchBinding(ev("q"), navCtx, [bind({ keys: "j" })])).toEqual({ kind: "none" });
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run frontend/app/store/keybindings/matcher.test.ts`
Expected: FAIL — `matchBinding` is not exported / module not found.

- [ ] **Step 3: Write the matcher implementation**

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import * as keyutil from "@/util/keyutil";
import type { Binding, KeyContext, MatchResult } from "./types";

export function isSequenceKeys(keys: string): boolean {
    return keys.includes(" ");
}

function hasModifier(e: WaveKeyboardEvent): boolean {
    return !!(e.control || e.alt || e.meta || e.cmd || e.option);
}

// Pure. No DOM, no atoms. `ctx.leader` carries the active leader prefix (or null).
export function matchBinding(waveEvent: WaveKeyboardEvent, ctx: KeyContext, bindings: Binding[]): MatchResult {
    const active = bindings.filter((b) => (b.when ? b.when(ctx) : true));
    const sequences = active.filter((b) => isSequenceKeys(b.keys));
    const singles = active.filter((b) => !isSequenceKeys(b.keys));

    if (ctx.leader != null) {
        // A modifier chord during leader mode cancels the leader and is processed normally.
        if (hasModifier(waveEvent)) {
            return { kind: "resetAndProcess", result: matchBinding(waveEvent, { ...ctx, leader: null }, bindings) };
        }
        for (const b of sequences) {
            const [lead, next] = b.keys.split(" ");
            if (lead === ctx.leader && keyutil.checkKeyPressed(waveEvent, next)) {
                return { kind: "run", binding: b };
            }
        }
        return { kind: "reset" };
    }

    // Exact single/chord matches take priority over entering a leader.
    for (const b of singles) {
        if (keyutil.checkKeyPressed(waveEvent, b.keys)) {
            return { kind: "run", binding: b };
        }
    }
    // Leader entry.
    const prefixes = new Set(sequences.map((b) => b.keys.split(" ")[0]));
    for (const p of prefixes) {
        if (keyutil.checkKeyPressed(waveEvent, p)) {
            return { kind: "enterLeader", leader: p };
        }
    }
    return { kind: "none" };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run frontend/app/store/keybindings/matcher.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/app/store/keybindings/matcher.ts frontend/app/store/keybindings/matcher.test.ts
git commit -m "feat(keybindings): pure matchBinding with leader state + precedence"
```

---

## Task 3: bindingsAtom + useKeybindings

**Files:**
- Create: `frontend/app/store/keybindings/store.ts`
- Test: `frontend/app/store/keybindings/store.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { describe, expect, it } from "vitest";
import { bindingsAtom, registerBindings, unregisterBindings } from "./store";
import type { Binding } from "./types";

function b(id: string, keys = "j"): Binding {
    return { id, keys, group: "g", label: id, run: () => {} };
}

describe("keybindings store", () => {
    it("registers and unregisters bindings by identity", () => {
        const arr = [b("a"), b("b")];
        registerBindings(arr);
        expect(globalStore.get(bindingsAtom)).toEqual(expect.arrayContaining(arr));
        unregisterBindings(arr);
        for (const binding of arr) {
            expect(globalStore.get(bindingsAtom)).not.toContain(binding);
        }
    });

    it("keeps other registrations intact when one unregisters", () => {
        const g1 = [b("g1")];
        const g2 = [b("g2")];
        registerBindings(g1);
        registerBindings(g2);
        unregisterBindings(g1);
        const now = globalStore.get(bindingsAtom);
        expect(now).toContain(g2[0]);
        expect(now).not.toContain(g1[0]);
        unregisterBindings(g2);
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run frontend/app/store/keybindings/store.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the store implementation**

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { atom } from "jotai";
import { useEffect } from "react";
import type { Binding } from "./types";

// The live union of all currently-active bindings. Read by the dispatcher, which-key bar, and cheat sheet.
export const bindingsAtom = atom<Binding[]>([]);

export function registerBindings(bindings: Binding[]): void {
    globalStore.set(bindingsAtom, [...globalStore.get(bindingsAtom), ...bindings]);
}

export function unregisterBindings(bindings: Binding[]): void {
    const removing = new Set(bindings);
    globalStore.set(
        bindingsAtom,
        globalStore.get(bindingsAtom).filter((b) => !removing.has(b))
    );
}

// Register a stable array of bindings for the lifetime of the calling component.
// Pass a memoized array (useMemo) so it is not re-registered every render.
export function useKeybindings(bindings: Binding[]): void {
    useEffect(() => {
        registerBindings(bindings);
        return () => unregisterBindings(bindings);
    }, [bindings]);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run frontend/app/store/keybindings/store.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/app/store/keybindings/store.ts frontend/app/store/keybindings/store.test.ts
git commit -m "feat(keybindings): bindingsAtom registry + useKeybindings hook"
```

---

## Task 4: Leader atom + dispatcher (impure glue)

**Files:**
- Create: `frontend/app/store/keybindings/leaderatom.ts`
- Create: `frontend/app/store/keybindings/dispatcher.ts`

- [ ] **Step 1: Write the leader atom**

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { atom } from "jotai";

// Non-null while a leader sequence is in progress; drives the which-key bar.
export const activeLeaderAtom = atom<string | null>(null);
```

- [ ] **Step 2: Write the dispatcher**

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { modalsModel } from "@/app/store/modalmodel";
import type { AgentsViewModel } from "@/app/view/agents/agents";
import * as keyutil from "@/util/keyutil";
import { CHORD_TIMEOUT } from "@/util/sharedconst";
import { activeLeaderAtom } from "./leaderatom";
import { matchBinding } from "./matcher";
import { bindingsAtom } from "./store";
import type { Binding, KeyContext } from "./types";

let boundModel: AgentsViewModel | null = null;
let leader: string | null = null;
let leaderTimeout: ReturnType<typeof setTimeout> | null = null;
let lastHandledEvent: KeyboardEvent | null = null;

function setLeader(next: string | null): void {
    leader = next;
    globalStore.set(activeLeaderAtom, next);
    if (leaderTimeout) {
        clearTimeout(leaderTimeout);
        leaderTimeout = null;
    }
    if (next != null) {
        leaderTimeout = setTimeout(() => setLeader(null), CHORD_TIMEOUT);
    }
}

function isEditableTarget(el: Element | null): boolean {
    if (el == null) {
        return false;
    }
    const tag = el.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (el as HTMLElement).isContentEditable;
}

export function deriveKeyContext(): KeyContext {
    const model = boundModel;
    if (model == null) {
        return { surface: "cockpit", editable: false, modalOpen: false, leader };
    }
    const modalOpen =
        globalStore.get(model.paletteOpenAtom) ||
        globalStore.get(model.newAgentOpenAtom) ||
        globalStore.get(model.newProjectOpenAtom) ||
        globalStore.get(modalsModel.modalsAtom).length > 0;
    return {
        surface: globalStore.get(model.surfaceAtom),
        editable: isEditableTarget(document.activeElement),
        modalOpen,
        leader,
    };
}

// Runs a binding; returns whether the key should be consumed (false only when run() returns false).
function runBinding(binding: Binding, ctx: KeyContext): boolean {
    return binding.run(ctx) !== false;
}

// The single entry point. Returns true if the app claimed the key (caller should preventDefault).
export function handleWaveEvent(waveEvent: WaveKeyboardEvent): boolean {
    const nativeEvent = (waveEvent as any).nativeEvent as KeyboardEvent | undefined;
    if (nativeEvent != null && lastHandledEvent === nativeEvent) {
        return false; // already processed (e.g. window-capture then a component-level reinjection)
    }
    if (nativeEvent != null) {
        lastHandledEvent = nativeEvent;
    }
    const ctx = deriveKeyContext();
    const bindings = globalStore.get(bindingsAtom);
    let result = matchBinding(waveEvent, ctx, bindings);
    if (result.kind === "resetAndProcess") {
        setLeader(null);
        result = result.result;
    }
    switch (result.kind) {
        case "enterLeader":
            setLeader(result.leader);
            return true;
        case "reset":
            setLeader(null);
            return true;
        case "run": {
            if (leader != null) {
                setLeader(null);
            }
            return runBinding(result.binding, ctx);
        }
        default:
            return false;
    }
}

export function initKeybindingDispatcher(model: AgentsViewModel): () => void {
    boundModel = model;
    const onKeyDown = (e: KeyboardEvent) => {
        const waveEvent = keyutil.adaptFromReactOrNativeKeyEvent(e);
        const handled = handleWaveEvent(waveEvent);
        if (handled) {
            e.preventDefault();
            e.stopImmediatePropagation();
        }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
        window.removeEventListener("keydown", onKeyDown, true);
        boundModel = null;
    };
}
```

- [ ] **Step 3: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: no NEW errors beyond the ~3 baseline.

- [ ] **Step 4: Commit**

```bash
git add frontend/app/store/keybindings/leaderatom.ts frontend/app/store/keybindings/dispatcher.ts
git commit -m "feat(keybindings): dispatcher + leader state + context derivation"
```

---

## Task 5: Global + leader + help binding definitions

**Files:**
- Create: `frontend/app/store/keybindings/bindings.ts`

Reference for the migrated behaviors:
- `cockpit-root.tsx:56-64` — `Ctrl/Cmd+N` → open new agent.
- `cockpit-root.tsx:72-77` — `Ctrl+1..8` → `SURFACE_ORDER[n-1]`.
- `cockpit-root.tsx:80-85` — `Ctrl+P` → toggle palette.
- `cockpit-root.tsx:88-93` — `Ctrl+Tab` / `Ctrl+Shift+Tab` → `model.cycleFocus(shift)` on the Agent surface.
- `cockpit-root.tsx:96-116` — double-`Ctrl+C` inside the focus pane → `confirmCloseAgent`.

- [ ] **Step 1: Write the bindings factory**

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { confirmCloseAgent } from "@/app/view/agents/agentactions";
import { AgentsViewModel, SURFACE_ORDER, type SurfaceKey } from "@/app/view/agents/agents";
import { globalStore } from "@/app/store/jotaiStore";
import { cheatsheetOpenAtom } from "@/app/cockpit/shortcuts-cheatsheet";
import type { Binding, KeyContext } from "./types";

const DOUBLE_CTRL_C_MS = 500;

// g-leader surface teleports (collision-free letters; see design spec).
const GO_TARGETS: { letter: string; surface: SurfaceKey; label: string }[] = [
    { letter: "h", surface: "cockpit", label: "Cockpit (home)" },
    { letter: "a", surface: "agent", label: "Agent" },
    { letter: "v", surface: "activity", label: "Activity" },
    { letter: "c", surface: "channels", label: "Channels" },
    { letter: "s", surface: "sessions", label: "Sessions" },
    { letter: "f", surface: "files", label: "Files" },
    { letter: "m", surface: "memory", label: "Memory" },
    { letter: "u", surface: "usage", label: "Usage" },
    { letter: ",", surface: "settings", label: "Settings" },
];

const navigate = (ctx: KeyContext) => !ctx.editable && !ctx.modalOpen;

export function buildGlobalBindings(model: AgentsViewModel): Binding[] {
    let lastCtrlC: number | null = null;

    const surfaceChords: Binding[] = SURFACE_ORDER.slice(0, 8).map((surface, i) => ({
        id: `surface:${surface}`,
        keys: `Ctrl:${i + 1}`,
        group: "Global",
        label: `Jump to ${surface}`,
        run: () => globalStore.set(model.surfaceAtom, surface),
    }));

    const goBindings: Binding[] = GO_TARGETS.map((t) => ({
        id: `go:${t.surface}`,
        keys: `g ${t.letter}`,
        group: "Go to",
        label: t.label,
        when: navigate,
        run: () => globalStore.set(model.surfaceAtom, t.surface),
    }));

    return [
        ...surfaceChords,
        ...goBindings,
        {
            id: "palette",
            keys: "Ctrl:p",
            group: "Global",
            label: "Command palette",
            run: () => globalStore.set(model.paletteOpenAtom, (v) => !v),
        },
        {
            id: "go:palette",
            keys: "g p",
            group: "Go to",
            label: "Command palette",
            when: navigate,
            run: () => globalStore.set(model.paletteOpenAtom, true),
        },
        {
            id: "new-agent",
            keys: "Ctrl:n",
            group: "Global",
            label: "New agent",
            run: () => globalStore.set(model.newAgentOpenAtom, true),
        },
        {
            id: "cycle-agent-next",
            keys: "Ctrl:Tab",
            group: "Agent",
            label: "Next agent",
            when: (ctx) => ctx.surface === "agent",
            run: () => model.cycleFocus(false),
        },
        {
            id: "cycle-agent-prev",
            keys: "Ctrl:Shift:Tab",
            group: "Agent",
            label: "Previous agent",
            when: (ctx) => ctx.surface === "agent",
            run: () => model.cycleFocus(true),
        },
        {
            id: "close-agent",
            keys: "Ctrl:c",
            group: "Agent",
            label: "Close agent (press twice)",
            // Global chord (allowed while the terminal is focused/editable), Agent surface only.
            when: (ctx) => ctx.surface === "agent",
            run: () => {
                const inTerm = (document.activeElement as HTMLElement | null)?.closest?.(".cockpit-focus-pane") != null;
                if (!inTerm) {
                    return false; // let ^C reach the shell when not in the focus pane
                }
                const now = performance.now();
                if (lastCtrlC != null && now - lastCtrlC < DOUBLE_CTRL_C_MS) {
                    lastCtrlC = null;
                    const agents = globalStore.get(model.agentsAtom);
                    const fid = globalStore.get(model.focusIdAtom);
                    const a = agents.find((x) => x.id === fid) ?? agents[0];
                    if (a) {
                        confirmCloseAgent(a.id, a.name);
                    }
                    return true; // consume the second press
                }
                lastCtrlC = now;
                return false; // first press falls through so the PTY receives ^C
            },
        },
        {
            id: "help",
            keys: "?",
            group: "Help",
            label: "Keyboard shortcuts",
            when: navigate,
            run: () => globalStore.set(cheatsheetOpenAtom, true),
        },
    ];
}
```

- [ ] **Step 2: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: fails only because `cheatsheetOpenAtom` (Task 8) does not exist yet. If Task 8 is not yet done, temporarily stub the import — but per plan order this task is committed before wiring; the atom is created in Task 8. To keep the build green, create the atom now in a one-line module:

Create `frontend/app/cockpit/shortcuts-cheatsheet.tsx` with only the atom for now (the component is added in Task 8):

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { atom } from "jotai";

export const cheatsheetOpenAtom = atom(false);
```

Re-run the typecheck. Expected: no NEW errors beyond baseline.

- [ ] **Step 3: Commit**

```bash
git add frontend/app/store/keybindings/bindings.ts frontend/app/cockpit/shortcuts-cheatsheet.tsx
git commit -m "feat(keybindings): global chords, g-leader nav, help binding"
```

---

## Task 6: Conflict-invariant test

**Files:**
- Test: `frontend/app/store/keybindings/store.test.ts` (extend)

This is the guardrail: no two bindings that can be active in the same context may share the same keys.

- [ ] **Step 1: Write the failing test**

Append to `store.test.ts`:

```ts
import { buildGlobalBindings } from "./bindings";
import type { Binding, KeyContext, SurfaceKey } from "./types";

// A representative sample of contexts the dispatcher can be in.
const SURFACES: SurfaceKey[] = [
    "cockpit", "agent", "activity", "channels", "sessions", "files", "memory", "usage", "settings",
];
function contexts(): KeyContext[] {
    const out: KeyContext[] = [];
    for (const surface of SURFACES) {
        for (const editable of [false, true]) {
            for (const modalOpen of [false, true]) {
                out.push({ surface, editable, modalOpen, leader: null });
            }
        }
    }
    return out;
}

function assertNoConflicts(bindings: Binding[]) {
    for (const ctx of contexts()) {
        const active = bindings.filter((b) => (b.when ? b.when(ctx) : true));
        const seen = new Map<string, string>();
        for (const b of active) {
            const prev = seen.get(b.keys);
            if (prev != null) {
                throw new Error(
                    `key conflict "${b.keys}" between "${prev}" and "${b.id}" in surface=${ctx.surface} editable=${ctx.editable} modalOpen=${ctx.modalOpen}`
                );
            }
            seen.set(b.keys, b.id);
        }
    }
}

describe("keybinding conflict invariant", () => {
    it("has no two active-in-same-context bindings sharing keys", () => {
        // A stub model is enough: bindings only read atoms at run(), not at build().
        const model = { surfaceAtom: {}, paletteOpenAtom: {}, newAgentOpenAtom: {} } as any;
        expect(() => assertNoConflicts(buildGlobalBindings(model))).not.toThrow();
    });
});
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run frontend/app/store/keybindings/store.test.ts`
Expected: PASS. If it throws a conflict, fix the offending binding's `keys` or `when` before proceeding — do not weaken the test.

- [ ] **Step 3: Commit**

```bash
git add frontend/app/store/keybindings/store.test.ts
git commit -m "test(keybindings): conflict invariant across contexts"
```

---

## Task 7: Wire the dispatcher into cockpit-root; retire the ad-hoc listeners

**Files:**
- Modify: `frontend/app/cockpit/cockpit-root.tsx`

- [ ] **Step 1: Replace the two `useEffect` keyboard blocks and add wiring**

In `CockpitBody`, delete the two `useEffect` blocks that add `window.addEventListener("keydown", ...)` (the `onKey` Ctrl+N block at lines ~55-64 and the `onKeyCapture` block at lines ~65-120), and delete the now-unused `lastCtrlCRef`. Replace with dispatcher init + global-binding registration. Add these imports at the top:

```tsx
import { buildGlobalBindings } from "@/app/store/keybindings/bindings";
import { initKeybindingDispatcher } from "@/app/store/keybindings/dispatcher";
import { useKeybindings } from "@/app/store/keybindings/store";
import { ShortcutsCheatSheet } from "./shortcuts-cheatsheet";
import { WhichKeyBar } from "./whichkey-bar";
import { useMemo } from "react";
```

Inside `CockpitBody`, after `const model = agentsModelRef.current;`:

```tsx
    useEffect(() => initKeybindingDispatcher(model), [model]);
    const globalBindings = useMemo(() => buildGlobalBindings(model), [model]);
    useKeybindings(globalBindings);
```

- [ ] **Step 2: Render the new surfaces**

In the returned JSX of `CockpitBody`, add `<WhichKeyBar />` and `<ShortcutsCheatSheet model={model} />` alongside `<CommandPalette model={model} />`:

```tsx
            <NewProjectModal model={model} />
            <NewAgentModal model={model} />
            <CommandPalette model={model} />
            <WhichKeyBar />
            <ShortcutsCheatSheet model={model} />
            <ModalsRenderer />
```

(Note: `WhichKeyBar` and the full `ShortcutsCheatSheet` are built in Tasks 8-9. If executing strictly in order, this step will not typecheck until those exist. Either reorder to do Tasks 8-9 first, or add the two components as empty stubs now and flesh them out next. Recommended: build 8 and 9, then return to this render step.)

- [ ] **Step 3: Typecheck + run all tests**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Run: `npx vitest run`
Expected: no NEW type errors; all tests pass.

- [ ] **Step 4: Commit**

```bash
git add frontend/app/cockpit/cockpit-root.tsx
git commit -m "feat(keybindings): drive cockpit shortcuts from the registry"
```

---

## Task 8: Which-key bar

**Files:**
- Create: `frontend/app/cockpit/whichkey-bar.tsx`

- [ ] **Step 1: Write the component**

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Transient bottom bar shown while a leader sequence is in progress. Reads the live registry and
// shows only the continuations available for the active leader.

import { activeLeaderAtom } from "@/app/store/keybindings/leaderatom";
import { bindingsAtom } from "@/app/store/keybindings/store";
import { useAtomValue } from "jotai";

export function WhichKeyBar() {
    const leader = useAtomValue(activeLeaderAtom);
    const bindings = useAtomValue(bindingsAtom);
    if (leader == null) {
        return null;
    }
    const items = bindings
        .filter((b) => b.keys.startsWith(leader + " "))
        .map((b) => ({ next: b.keys.split(" ")[1], label: b.label }));
    if (items.length === 0) {
        return null;
    }
    return (
        <div className="fixed inset-x-0 bottom-0 z-[65] flex items-center gap-4 border-t border-edge-strong bg-modalbg px-4 py-2 shadow-popover">
            <span className="shrink-0 font-mono text-[11px] text-accent-soft">{leader} →</span>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                {items.map((it) => (
                    <span key={it.next} className="flex items-center gap-1.5 text-[12px] text-secondary">
                        <span className="rounded-[5px] border border-edge-mid px-[6px] py-0.5 font-mono text-[10.5px] text-primary">
                            {it.next}
                        </span>
                        {it.label}
                    </span>
                ))}
            </div>
        </div>
    );
}
```

- [ ] **Step 2: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: no NEW errors.

- [ ] **Step 3: Commit**

```bash
git add frontend/app/cockpit/whichkey-bar.tsx
git commit -m "feat(keybindings): which-key bottom bar"
```

---

## Task 9: Cheat-sheet modal + palette entry

**Files:**
- Modify: `frontend/app/cockpit/shortcuts-cheatsheet.tsx` (replace the atom-only stub from Task 5)
- Modify: `frontend/app/cockpit/command-palette.tsx`

- [ ] **Step 1: Write the cheat-sheet component**

Replace the contents of `frontend/app/cockpit/shortcuts-cheatsheet.tsx`:

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Centered modal listing every registered binding, grouped by `group`, generated from bindingsAtom.
// Opens on `?` (navigate posture) or via the command palette "Keyboard shortcuts" entry.

import { bindingsAtom } from "@/app/store/keybindings/store";
import type { AgentsViewModel } from "@/app/view/agents/agents";
import { globalStore } from "@/app/store/jotaiStore";
import { cn } from "@/util/util";
import { atom, useAtomValue } from "jotai";
import { useMemo, useState } from "react";

export const cheatsheetOpenAtom = atom(false);

function keyChips(keys: string) {
    // "g a" -> ["g","a"]; "Ctrl:Shift:Tab" -> ["Ctrl","Shift","Tab"]
    const parts = keys.includes(" ") ? keys.split(" ") : keys.split(":");
    return parts;
}

export function ShortcutsCheatSheet({ model }: { model: AgentsViewModel }) {
    const open = useAtomValue(cheatsheetOpenAtom);
    const bindings = useAtomValue(bindingsAtom);
    const surface = useAtomValue(model.surfaceAtom);
    const [query, setQuery] = useState("");
    const close = () => globalStore.set(cheatsheetOpenAtom, false);

    const groups = useMemo(() => {
        const q = query.trim().toLowerCase();
        const filtered = q
            ? bindings.filter((b) => b.label.toLowerCase().includes(q) || b.keys.toLowerCase().includes(q))
            : bindings;
        const byGroup = new Map<string, typeof filtered>();
        for (const b of filtered) {
            const arr = byGroup.get(b.group) ?? [];
            arr.push(b);
            byGroup.set(b.group, arr);
        }
        return [...byGroup.entries()].sort(([a], [b]) => (a === surface ? -1 : b === surface ? 1 : a.localeCompare(b)));
    }, [bindings, query, surface]);

    if (!open) {
        return null;
    }
    return (
        <div
            className="fixed inset-0 z-[70] flex items-start justify-center bg-black/60 pt-[10vh] backdrop-blur-sm"
            onMouseDown={(e) => e.target === e.currentTarget && close()}
            onKeyDown={(e) => e.key === "Escape" && close()}
        >
            <div className="flex max-h-[74vh] w-[min(680px,93vw)] flex-col overflow-hidden rounded-[14px] border border-edge-strong bg-modalbg shadow-popover">
                <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-[13px]">
                    <input
                        autoFocus
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder="Filter shortcuts…"
                        className="flex-1 bg-transparent text-[14px] text-primary outline-none placeholder:text-muted"
                    />
                    <span className="ml-3 shrink-0 rounded-[5px] border border-edge-mid px-[7px] py-0.5 font-mono text-[10.5px] text-muted">
                        esc
                    </span>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
                    {groups.map(([group, items]) => (
                        <div key={group} className="mb-4">
                            <div className="mb-1 font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-muted">
                                {group}
                            </div>
                            {items.map((b) => (
                                <div key={b.id} className="flex items-center justify-between py-[5px] text-[13px]">
                                    <span className="text-secondary">{b.label}</span>
                                    <span className="flex items-center gap-1">
                                        {keyChips(b.keys).map((k, i) => (
                                            <span
                                                key={i}
                                                className={cn(
                                                    "rounded-[5px] border border-edge-mid px-[6px] py-0.5 font-mono text-[10.5px] text-primary"
                                                )}
                                            >
                                                {k}
                                            </span>
                                        ))}
                                    </span>
                                </div>
                            ))}
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}
```

- [ ] **Step 2: Add the palette entry (the "typing" door to the cheat sheet)**

In `frontend/app/cockpit/command-palette.tsx`, add an import and a command item. Import near the top:

```tsx
import { cheatsheetOpenAtom } from "./shortcuts-cheatsheet";
```

In the `commands` array inside `useMemo` (after the `cmd:new-project` entry), add:

```tsx
            {
                key: "cmd:shortcuts",
                kind: "command",
                search: "Keyboard shortcuts help cheat sheet",
                title: "Keyboard shortcuts",
                run: () => {
                    globalStore.set(cheatsheetOpenAtom, true);
                    close();
                },
            },
```

- [ ] **Step 3: Typecheck + run all tests**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Run: `npx vitest run`
Expected: no NEW type errors; all tests pass.

- [ ] **Step 4: Commit**

```bash
git add frontend/app/cockpit/shortcuts-cheatsheet.tsx frontend/app/cockpit/command-palette.tsx
git commit -m "feat(keybindings): shortcuts cheat sheet + palette entry"
```

---

## Task 10: Migrate the Agent surface's local keys into the registry

**Files:**
- Modify: `frontend/app/view/agents/agentsurface.tsx`

Reference — the current local `onKeyDown` (lines ~68-94) handles, when focus is not in an input: `Escape` (exit fullscreen, else go to `cockpit`), `ArrowLeft`/`ArrowRight` (`step(-1)`/`step(1)`), `d` (toggle `railVisibleAtom`), `f` (toggle `terminalFullscreenAtom`). We move these into registry bindings (so they appear in the cheat sheet and are governed by the same posture rules) and add `j`/`k` as aliases for `ArrowUp`/`ArrowDown`-style stepping.

- [ ] **Step 1: Replace the local handler with registry bindings**

Remove the `onKeyDown` function and the `onKeyDown={onKeyDown}` prop on the wrapper `<div>` (keep `ref={wrapRef}` and `tabIndex={0}` so the surface can still hold focus). Add the imports:

```tsx
import { useKeybindings } from "@/app/store/keybindings/store";
import type { Binding } from "@/app/store/keybindings/types";
import { useMemo } from "react";
```

Add, inside the component after `agent` and `step` are defined (bindings must see the current `agent`/`order`; rebuild when they change):

```tsx
    const agentBindings = useMemo<Binding[]>(() => {
        const nav = (ctx: { editable: boolean; modalOpen: boolean; surface: string }) =>
            !ctx.editable && !ctx.modalOpen && ctx.surface === "agent";
        return [
            {
                id: "agent:back",
                keys: "Escape",
                group: "Agent",
                label: "Back to Cockpit (or exit fullscreen)",
                when: nav,
                run: () => {
                    if (globalStore.get(terminalFullscreenAtom)) {
                        globalStore.set(terminalFullscreenAtom, false);
                    } else {
                        globalStore.set(model.surfaceAtom, "cockpit");
                    }
                },
            },
            { id: "agent:prev", keys: "ArrowLeft", group: "Agent", label: "Previous agent", when: nav, run: () => step(-1) },
            { id: "agent:next", keys: "ArrowRight", group: "Agent", label: "Next agent", when: nav, run: () => step(1) },
            { id: "agent:prev-k", keys: "k", group: "Agent", label: "Previous agent", when: nav, run: () => step(-1) },
            { id: "agent:next-j", keys: "j", group: "Agent", label: "Next agent", when: nav, run: () => step(1) },
            {
                id: "agent:toggle-rail",
                keys: "d",
                group: "Agent",
                label: "Toggle agent rail",
                when: nav,
                run: () => globalStore.set(railVisibleAtom, !globalStore.get(railVisibleAtom)),
            },
            {
                id: "agent:fullscreen",
                keys: "f",
                group: "Agent",
                label: "Toggle terminal fullscreen",
                when: nav,
                run: () => globalStore.set(terminalFullscreenAtom, !globalStore.get(terminalFullscreenAtom)),
            },
        ];
    }, [model, order, agent?.id]);
    useKeybindings(agentBindings);
```

Note: `agent:prev`/`agent:prev-k` intentionally duplicate the same action under two keys — that is not a conflict (different `keys`). Keep the cheat sheet tidy by giving both a clear label.

- [ ] **Step 2: Verify the conflict invariant still holds with agent bindings loaded**

Because agent bindings are registered at runtime (not part of `buildGlobalBindings`), extend the invariant test in `store.test.ts` to also feed a merged array. Add:

```ts
it("global + agent-surface sample bindings do not conflict", () => {
    const model = { surfaceAtom: {}, paletteOpenAtom: {}, newAgentOpenAtom: {} } as any;
    // Mirror the agent-surface bindings' keys/when for the invariant check.
    const nav = (c: KeyContext) => !c.editable && !c.modalOpen && c.surface === "agent";
    const agentKeys = ["Escape", "ArrowLeft", "ArrowRight", "k", "j", "d", "f"];
    const agentBindings: Binding[] = agentKeys.map((keys, i) => ({
        id: `agent:${i}`, keys, group: "Agent", label: keys, when: nav, run: () => {},
    }));
    expect(() => assertNoConflicts([...buildGlobalBindings(model), ...agentBindings])).not.toThrow();
});
```

Run: `npx vitest run frontend/app/store/keybindings/store.test.ts`
Expected: PASS. (This catches, e.g., the Agent-surface `f` colliding with a future global `f`.)

- [ ] **Step 3: Typecheck + full test run**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Run: `npx vitest run`
Expected: no NEW type errors; all tests pass.

- [ ] **Step 4: Commit**

```bash
git add frontend/app/view/agents/agentsurface.tsx frontend/app/store/keybindings/store.test.ts
git commit -m "refactor(agents): drive Agent-surface keys from the registry, add j/k"
```

---

## Task 11: Retire the dead keymodel maps; re-point the seam

**Files:**
- Modify: `frontend/app/store/keymodel.ts`
- Modify: `frontend/app/view/term/term-model.test.ts` (mock update, if needed)

Goal: keep the public seam `appHandleKeyDown` (called by `term-model.ts:759`, `waveconfig.tsx:130` via `tryReinjectKey`, and `preview-edit.tsx:81`) working, but have it delegate to the new dispatcher. Remove the now-unused `globalKeyMap`, `globalChordMap`, `activeChord`, `chordTimeout`, `setActiveChord`, `resetChord`, and `checkKeyMap`. Keep `registerControlShiftStateUpdateHandler`, the control-shift helpers, and `tryReinjectKey`.

- [ ] **Step 1: Rewrite `appHandleKeyDown` to delegate**

Replace the body of `appHandleKeyDown` and delete the dead chord machinery. New `appHandleKeyDown`:

```ts
import { handleWaveEvent } from "@/app/store/keybindings/dispatcher";

// ...keep the control-shift atoms/handlers unchanged...

function appHandleKeyDown(waveEvent: WaveKeyboardEvent): boolean {
    if (globalKeybindingsDisabled) {
        return false;
    }
    return handleWaveEvent(waveEvent);
}
```

Delete: `simpleControlShiftAtom` stays (used by control-shift). Delete `globalKeyMap`, `globalChordMap`, `activeChord`, `chordTimeout`, `lastHandledEvent`, `resetChord`, `setActiveChord`, `checkKeyMap`. Keep `globalKeybindingsDisabled`, `setControlShift`, `unsetControlShift`, `registerControlShiftStateUpdateHandler`, `tryReinjectKey`. Keep the exports list unchanged: `{ appHandleKeyDown, registerControlShiftStateUpdateHandler, tryReinjectKey }`.

Note the dedup that used to live here (`lastHandledEvent`) now lives in the dispatcher, so removing it here is safe.

- [ ] **Step 2: Check the term-model test mock**

`term-model.test.ts:25` mocks `@/app/store/keymodel` as `{ appHandleKeyDown: vi.fn(() => false) }`. That mock is still valid (the export still exists). Confirm the test file compiles.

Run: `npx vitest run frontend/app/view/term/term-model.test.ts`
Expected: PASS.

- [ ] **Step 3: Typecheck + full test run**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Run: `npx vitest run`
Expected: no NEW type errors; all tests pass.

- [ ] **Step 4: Commit**

```bash
git add frontend/app/store/keymodel.ts
git commit -m "refactor(keymodel): delegate appHandleKeyDown to the keybinding dispatcher"
```

---

## Task 12: Live verification (CDP) + reference doc sync

**Files:**
- Verify only (no code); update `docs/keyboard-shortcuts.md` if any key changed during implementation.

The project has no jsdom render harness — verify the UI on the live dev app over CDP (see CLAUDE.md "Visual verification").

- [ ] **Step 1: Start the dev app**

Run (background, keep stdin open so wavesrv does not get EOF): `tail -f /dev/null | task dev`
Wait for the Vite app to be reachable inside WebView2 on `http://localhost:5174/`.

- [ ] **Step 2: Verify each behavior over CDP**

Capture a screenshot after each: `node scripts/cdp-shot.mjs <name>.png`. Confirm:
- `Ctrl+1`..`Ctrl+8` switch surfaces (matches NavRail order).
- `Ctrl+P` toggles the command palette; palette lists a "Keyboard shortcuts" command that opens the cheat sheet.
- `Ctrl+N` opens New Agent.
- Press `g` (not typing) → which-key bar appears at the bottom listing `a v c s f m u , p h`; press `f` → Files surface; bar disappears.
- `g` then `Esc` (or wait `CHORD_TIMEOUT`) → bar disappears, no navigation.
- `?` (not typing) opens the cheat sheet; groups render with key chips; `Esc` closes.
- On the Agent surface with the terminal focused: `j`/`g`/`?` type into the terminal (NOT intercepted); `Ctrl+1` still switches surface; double-`Ctrl+C` closes the agent while a single `Ctrl+C` interrupts the TUI.
- On the Agent surface with focus outside the terminal: `ArrowLeft`/`ArrowRight` and `j`/`k` cycle agents, `d` toggles the rail, `f` toggles fullscreen, `Esc` returns to Cockpit.

- [ ] **Step 3: Sync the reference doc**

If any binding changed during implementation, update `docs/keyboard-shortcuts.md` to match the shipped registry.

- [ ] **Step 4: Final commit (if the reference changed)**

```bash
git add docs/keyboard-shortcuts.md
git commit -m "docs: sync keyboard-shortcuts reference with shipped registry"
```

---

## Self-Review (completed by plan author)

**Spec coverage:**
- Unified registry / single source of truth → Tasks 1-3, 5.
- `when`-predicate scope system → Task 1 (`when` on `Binding`), exercised in Tasks 2, 5, 10.
- Dispatcher precedence + leader/chord state machine → Tasks 2 (pure matcher), 4 (glue).
- Terminal reconciliation (global chords beat PTY; single keys don't fire while editable; seam re-pointed) → Tasks 4 (`editable` via `document.activeElement`, window-capture), 11 (`appHandleKeyDown` delegation). Verified in Task 12.
- Which-key bottom bar → Task 8; cheat-sheet modal + `?` + palette door → Tasks 5, 9.
- Migrate existing shortcuts with zero regression → Tasks 5 (globals), 10 (Agent surface), 7 (retire ad-hoc listeners).
- Delete dead `keymodel` maps → Task 11.
- Conflict-invariant test → Tasks 6, 10.
- CDP visual verification → Task 12.
- **Deferred (per spec, not in this plan):** per-surface region model, `j/k` roving cursor for non-Agent surfaces, per-surface action keys (Files/Channels/etc.), remappable config. These are the follow-up plan.

**Placeholder scan:** No TBD/TODO; every code step contains full code; commands have expected output.

**Type consistency:** `Binding`/`KeyContext`/`MatchResult` defined in Task 1 and used unchanged throughout. `matchBinding(waveEvent, ctx, bindings)`, `handleWaveEvent(waveEvent)`, `registerBindings`/`unregisterBindings`/`useKeybindings`, `buildGlobalBindings(model)`, `cheatsheetOpenAtom`, `activeLeaderAtom`, `bindingsAtom` names are consistent across tasks. `run` return contract (`false` = don't consume) is defined in Task 1 and relied on by the double-`Ctrl+C` binding in Task 5 and the dispatcher in Task 4.

**Ordering note:** Task 7 renders `<WhichKeyBar/>` and `<ShortcutsCheatSheet/>`, which are created in Tasks 8-9. Execute 8 and 9 before finishing Task 7's render step (called out inline in Task 7 Step 2).
