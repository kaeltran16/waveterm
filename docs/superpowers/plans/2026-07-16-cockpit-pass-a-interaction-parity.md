# Cockpit Pass A — Interaction Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the cockpit keyboard contract work on *every* navigable surface — `[`/`]` surface-switch and `j`/`k` list-cursor reach all surfaces including radar — and collapse the three competing keyboard mechanisms into the single global keybinding registry (audit findings **F1 + F2 + F7**, "Pass A").

**Architecture:** The app already has the canonical "one home" for keys: a single global **capture-phase** `window` keydown dispatcher (`frontend/app/store/keybindings/dispatcher.ts`, mounted once in `cockpit-root.tsx:63`) that matches against a live `bindingsAtom`, filtered by each binding's `when(ctx)` predicate. `KeyContext` already carries `surface` / `editable` / `modalOpen`, and `bindings.ts` already puts surface-switching (`Ctrl:1-8`, `g`-leader) and one surface-scoped list-nav set (`buildAgentBindings`) in that registry. Pass A extends this registry rather than adding new listeners:
1. Move `[`/`]` surface-switch and a `g r` radar teleport **into** the registry (they then work on all surfaces via the global listener, and reach radar because the canonical `SURFACE_ORDER` already includes it).
2. Add **one** shared list-cursor mechanism: a `listNavAtom` controller that the active list surface publishes via a tiny `useSurfaceListNav` hook, driven by one set of registry `j`/`k`/`Arrow` bindings.
3. Fold the two ad-hoc `window.addEventListener("keydown")` listeners (SubagentInterior, ReviewSurface) into registry bindings, gaining the typing-guard for free.

**Deviation from the audit's literal wording (intentional):** The audit's F1 says "shell-level listener + a shared list-cursor hook each surface adopts." Adding a shell listener *and* per-surface `onKeyDown` hooks would create two *more* mechanisms. Because the registry is already a global capture-phase dispatcher with surface gating and a typing-guard, putting `[`/`]` and list-nav there is the true single-source realization of the same intent — and it is exactly what F7 recommends ("resolves the where-does-the-contract-live question toward the registry"). The cockpit surface keeps its own rich `useCockpitKeyboard` hook (its 1-9 / r / t / b / n keyset is out of Pass A scope; the audit scores cockpit Interaction as *Conforms*); Pass A only strips the `[`/`]` block out of it.

**Tech Stack:** React 19, jotai, Vitest. Keybinding registry under `frontend/app/store/keybindings/`.

## Global Constraints

- **Single source of truth for surface order:** `SURFACE_ORDER` (`frontend/app/view/agents/agents.tsx:37-46`) is canonical. It already contains `["cockpit","agent","channels","radar","sessions","files","memory","usage"]` (radar included, settings excluded). No other surface-order array may exist after this pass — the private copy in `usecockpitkeyboard.ts` is deleted.
- **Every key lives in the registry** except the cockpit's own `useCockpitKeyboard` rich keyset. No new `window.addEventListener("keydown", …)` is added anywhere in `frontend/app/view/agents/`; F7's two named listeners (subagentinterior + reviewsurface) are removed. Two pre-existing Escape-only listeners remain in the inline modals `newmemorymodal.tsx` / `tooldetailmodal.tsx` — outside F7's scope (modal dismissal, not surface/list nav), deferred to a later modal-keyboard cleanup.
- **Typing-guard is mandatory:** every new binding that uses a bare letter/arrow key must be gated so it does not fire while an input/textarea/select/contentEditable is focused. Use the existing `navigate` predicate (`bindings.ts:26`, `ctx => !ctx.editable && !ctx.modalOpen`) or an equivalent inline `!ctx.editable && !ctx.modalOpen` check.
- **`run()` returning `false` = do not consume the key** (it passes through). Any other return consumes it (dispatcher `preventDefault` + `stopImmediatePropagation`).
- **Bindings arrays passed to `useKeybindings` MUST be memoized** (`useMemo`) — the registry unregisters by object identity (`store.ts:16-22`); a fresh array each render leaks duplicate bindings. `run()`/`when()` read live atoms, so the array itself stays stable.
- **The conflict invariant must hold:** `store.test.ts`'s `assertNoConflicts` requires that no two bindings active in the *same* `KeyContext` share the same `keys`. Every task that adds bindings extends this test with its real runtime combination.
- **No jsdom render harness exists for the cockpit.** Component-wiring tasks (surface adoption) are verified by driving the live dev app over CDP (`node scripts/cdp-shot.mjs`, port 9222 — see `CLAUDE.md` "Visual verification"), not unit tests. Pure logic (bindings `when`/`run`, cycle, gating) *is* unit-tested with Vitest.
- **Typecheck command (tsc gotcha):** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (bare `npx tsc` overflows). Baseline is clean; any error it reports is yours.
- **Git:** no commits until explicit user approval; the plan + spec fold into the single feature commit (do not create a docs-only commit). Do not self-attribute as co-author.

---

## File Structure

**New files:**
- `frontend/app/store/keybindings/listnav.ts` — `ListNavController` type, `listNavAtom`, `useSurfaceListNav` hook. The single home for the "active list cursor" concept. ~35 lines.
- `frontend/app/store/keybindings/bindings.test.ts` — behavior tests for the new bindings (`[`/`]` cycle, `g r`, list-nav gating/movement, subagent/agent Escape exclusion, review keys). New file so `store.test.ts` stays focused on store + conflict invariant.

**Modified files:**
- `frontend/app/store/keybindings/bindings.ts` — add `[`/`]` + `g r` to `buildGlobalBindings`; add `buildListNavBindings()`; add `subagent:back` + tighten `agent:back` in `buildAgentBindings`; add `buildReviewBindings()`.
- `frontend/app/cockpit/cockpit-root.tsx` — register `buildListNavBindings()` alongside the existing global bindings.
- `frontend/app/view/agents/usecockpitkeyboard.ts` — delete the `[`/`]` block + private `surfaceOrder`; drop the now-unused `SurfaceKey` import if unused.
- `frontend/app/view/agents/channelrail.tsx` — publish the channel-rail list controller.
- `frontend/app/view/agents/sessionssurface.tsx` — publish the session-list controller.
- `frontend/app/view/agents/memorysurface.tsx` (`ListView`) — publish the notes-list controller.
- `frontend/app/view/agents/filessurface.tsx` — publish the browse file-list controller (browse mode only).
- `frontend/app/view/agents/radarfindingslist.tsx` — publish the findings-list controller.
- `frontend/app/view/agents/subagentinterior.tsx` — remove the ad-hoc Escape listener.
- `frontend/app/view/agents/reviewsurface.tsx` — remove the ad-hoc triage listener; register `buildReviewBindings()` via `useKeybindings`.
- `frontend/app/store/keybindings/store.test.ts` — extend the conflict invariant to cover the real runtime binding combinations.

---

### Task 1: `[`/`]` surface-switch + `g r` radar into the registry (F1-switch + F2)

**Files:**
- Modify: `frontend/app/store/keybindings/bindings.ts` (`GO_TARGETS` at :15-24; `buildGlobalBindings` at :38-136)
- Modify: `frontend/app/view/agents/usecockpitkeyboard.ts:63-81` (delete the `[`/`]` block) and `:10` (import)
- Test: `frontend/app/store/keybindings/bindings.test.ts` (new)

**Interfaces:**
- Consumes: `SURFACE_ORDER`, `SurfaceKey` (`@/app/view/agents/agents`); `model.surfaceAtom`; `navigate` (bindings.ts, module-private); `globalStore`.
- Produces: two new bindings on `buildGlobalBindings` — `surface:next` (`keys:"]"`), `surface:prev` (`keys:"["`) — and one `go:radar` (`keys:"g r"`). No signature changes.

- [ ] **Step 1: Write the failing tests**

Create `frontend/app/store/keybindings/bindings.test.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { SURFACE_ORDER, type SurfaceKey } from "@/app/view/agents/agents";
import { atom } from "jotai";
import { describe, expect, it } from "vitest";
import { buildGlobalBindings } from "./bindings";
import type { KeyContext } from "./types";

const ctx = (surface: SurfaceKey = "cockpit"): KeyContext => ({
    surface,
    editable: false,
    modalOpen: false,
    leader: null,
});

describe("surface switch [ / ]", () => {
    it("cycles SURFACE_ORDER forward/back with wrap and reaches radar", () => {
        const model = { surfaceAtom: atom<SurfaceKey>("cockpit") } as any;
        const bindings = buildGlobalBindings(model);
        const next = bindings.find((b) => b.id === "surface:next")!;
        const prev = bindings.find((b) => b.id === "surface:prev")!;
        expect(next.keys).toBe("]");
        expect(prev.keys).toBe("[");

        next.run(ctx()); // cockpit -> agent
        expect(globalStore.get(model.surfaceAtom)).toBe("agent");

        globalStore.set(model.surfaceAtom, "channels");
        next.run(ctx()); // channels -> radar (radar is in SURFACE_ORDER)
        expect(globalStore.get(model.surfaceAtom)).toBe("radar");

        globalStore.set(model.surfaceAtom, SURFACE_ORDER[SURFACE_ORDER.length - 1]);
        next.run(ctx()); // wrap forward to first
        expect(globalStore.get(model.surfaceAtom)).toBe(SURFACE_ORDER[0]);

        prev.run(ctx()); // wrap back to last
        expect(globalStore.get(model.surfaceAtom)).toBe(SURFACE_ORDER[SURFACE_ORDER.length - 1]);
    });

    it("enters the cycle gracefully from a surface not in SURFACE_ORDER (settings)", () => {
        const model = { surfaceAtom: atom<SurfaceKey>("settings") } as any;
        const bindings = buildGlobalBindings(model);
        bindings.find((b) => b.id === "surface:next")!.run(ctx("settings"));
        expect(globalStore.get(model.surfaceAtom)).toBe(SURFACE_ORDER[0]);
    });

    it("switch bindings are suppressed while typing / modal open", () => {
        const model = { surfaceAtom: atom<SurfaceKey>("cockpit") } as any;
        const next = buildGlobalBindings(model).find((b) => b.id === "surface:next")!;
        expect(next.when!({ surface: "cockpit", editable: true, modalOpen: false, leader: null })).toBe(false);
        expect(next.when!({ surface: "cockpit", editable: false, modalOpen: true, leader: null })).toBe(false);
        expect(next.when!(ctx())).toBe(true);
    });

    it("exposes a g r leader teleport to radar", () => {
        const model = { surfaceAtom: atom<SurfaceKey>("cockpit") } as any;
        const b = buildGlobalBindings(model).find((x) => x.id === "go:radar")!;
        expect(b.keys).toBe("g r");
        b.run(ctx());
        expect(globalStore.get(model.surfaceAtom)).toBe("radar");
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run frontend/app/store/keybindings/bindings.test.ts`
Expected: FAIL — `surface:next` / `surface:prev` / `go:radar` are `undefined` (bindings not added yet).

- [ ] **Step 3: Add `g r` to `GO_TARGETS`**

In `bindings.ts`, insert the radar target after the channels entry (`:18`) so the which-key order matches `SURFACE_ORDER`:

```ts
    { letter: "c", surface: "channels", label: "Channels" },
    { letter: "r", surface: "radar", label: "Radar" },
    { letter: "s", surface: "sessions", label: "Sessions" },
```

- [ ] **Step 4: Add the `[`/`]` cycle bindings to `buildGlobalBindings`**

Inside `buildGlobalBindings(model)`, add a `cycleSurface` helper near the top (after `let lastCtrlC` at :39) and two bindings in the returned array (e.g. right after `...goBindings,` at :60):

```ts
    const cycleSurface = (delta: number) => {
        const cur = globalStore.get(model.surfaceAtom);
        const idx = SURFACE_ORDER.indexOf(cur);
        const next =
            idx === -1
                ? SURFACE_ORDER[delta > 0 ? 0 : SURFACE_ORDER.length - 1] // surface outside the cycle (settings): enter at an end
                : SURFACE_ORDER[(idx + delta + SURFACE_ORDER.length) % SURFACE_ORDER.length];
        globalStore.set(model.surfaceAtom, next);
    };
```

```ts
        { id: "surface:next", keys: "]", group: "Navigation", label: "Next surface", when: navigate, run: () => cycleSurface(1) },
        { id: "surface:prev", keys: "[", group: "Navigation", label: "Previous surface", when: navigate, run: () => cycleSurface(-1) },
```

(`SURFACE_ORDER` is already imported at `bindings.ts:7`; `globalStore` at :5; `navigate` is the module-private predicate at :26.)

- [ ] **Step 5: Run the new tests to verify they pass**

Run: `npx vitest run frontend/app/store/keybindings/bindings.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Delete the `[`/`]` block from the cockpit hook**

In `usecockpitkeyboard.ts`, remove the entire surface-switch block (`:63-81`):

```ts
        // surface switch: `[` previous / `]` next (rail order). 1–9 are answer keys, so no number jumps.
        if (e.key === "]" || e.key === "[") {
            e.preventDefault();
            const surfaceOrder: SurfaceKey[] = [
                "cockpit", "agent", "channels", "sessions", "files", "memory", "usage",
            ];
            const curSurface = globalStore.get(model.surfaceAtom);
            const idx = surfaceOrder.indexOf(curSurface);
            const nextSurface =
                surfaceOrder[(idx + (e.key === "]" ? 1 : surfaceOrder.length - 1)) % surfaceOrder.length];
            globalStore.set(model.surfaceAtom, nextSurface);
            return;
        }
```

Then check whether `SurfaceKey` is still referenced anywhere in the file. It is imported at `:10` (`import type { AgentsViewModel, SurfaceKey } from "./agents";`). After deleting the block, if `SurfaceKey` has no other use, reduce the import to `import type { AgentsViewModel } from "./agents";`. (`globalStore` is still used elsewhere in the hook — leave it.)

- [ ] **Step 7: Verify the store conflict invariant still holds and typecheck**

Run: `npx vitest run frontend/app/store/keybindings/store.test.ts`
Expected: PASS — `[` and `]` and `g r` do not collide with any existing key in any context (no other binding uses those keys).

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0 (no unused-import error from the `SurfaceKey` edit).

---

### Task 2: Shared list-cursor controller + registry bindings (F1-cursor infrastructure)

**Files:**
- Create: `frontend/app/store/keybindings/listnav.ts`
- Modify: `frontend/app/store/keybindings/bindings.ts` (add `buildListNavBindings`)
- Modify: `frontend/app/cockpit/cockpit-root.tsx:79-80` (register it)
- Test: `frontend/app/store/keybindings/bindings.test.ts`; `frontend/app/store/keybindings/store.test.ts`

**Interfaces:**
- Produces:
  - `ListNavController = { surface: SurfaceKey; navigableIds: string[]; cursorId: string | undefined; setCursor: (id: string) => void }`
  - `listNavAtom: PrimitiveAtom<ListNavController | null>`
  - `useSurfaceListNav(controller: ListNavController | null): void`
  - `buildListNavBindings(): Binding[]` — ids `list:next-j` (`j`), `list:prev-k` (`k`), `list:next` (`ArrowDown`), `list:prev` (`ArrowUp`). Active only when a controller is registered for `ctx.surface` and not editable/modal.
- Consumes: `moveCursor` (`@/app/view/agents/agentsviewmodel`, already imported in bindings.ts:8), `globalStore`, `KeyContext`.
- **Contract for callers (Tasks 3-7):** the rich surfaces (cockpit, agent) MUST NOT register a controller — they own their own keys. Only the plain master-detail list surfaces register. `cursorId == selection`: moving the cursor IS selecting (loading the detail), matching existing click behavior; there is no separate "open" for v1 (Enter-to-open is subsumed by select-on-move for these master-detail surfaces).

- [ ] **Step 1: Write the failing tests**

Append to `frontend/app/store/keybindings/bindings.test.ts`:

```ts
import { buildListNavBindings } from "./bindings";
import { listNavAtom } from "./listnav";

describe("list-nav bindings", () => {
    const chanCtx: KeyContext = { surface: "channels", editable: false, modalOpen: false, leader: null };

    it("is inactive with no controller, when editable/modal, or on a mismatched surface", () => {
        globalStore.set(listNavAtom, null);
        const j = buildListNavBindings().find((b) => b.id === "list:next-j")!;
        expect(j.keys).toBe("j");
        expect(j.when!(chanCtx)).toBe(false); // no controller

        globalStore.set(listNavAtom, { surface: "channels", navigableIds: ["a", "b"], cursorId: "a", setCursor() {} });
        expect(j.when!(chanCtx)).toBe(true);
        expect(j.when!({ ...chanCtx, editable: true })).toBe(false);
        expect(j.when!({ ...chanCtx, modalOpen: true })).toBe(false);
        expect(j.when!({ ...chanCtx, surface: "memory" })).toBe(false); // controller is for channels
        globalStore.set(listNavAtom, null);
    });

    it("j/ArrowDown move forward and k/ArrowUp back via moveCursor (clamped, no wrap)", () => {
        const seen: string[] = [];
        globalStore.set(listNavAtom, {
            surface: "channels",
            navigableIds: ["a", "b", "c"],
            cursorId: "b",
            setCursor: (id) => seen.push(id),
        });
        const bindings = buildListNavBindings();
        bindings.find((b) => b.id === "list:next-j")!.run(chanCtx);
        bindings.find((b) => b.id === "list:prev-k")!.run(chanCtx);
        bindings.find((b) => b.id === "list:next")!.run(chanCtx);
        bindings.find((b) => b.id === "list:prev")!.run(chanCtx);
        expect(seen).toEqual(["c", "a", "c", "a"]); // from "b": +1=c, -1=a, +1=c, -1=a
        globalStore.set(listNavAtom, null);
    });

    it("first press from an empty/absent cursor lands on the first id", () => {
        const seen: string[] = [];
        globalStore.set(listNavAtom, { surface: "channels", navigableIds: ["a", "b"], cursorId: undefined, setCursor: (id) => seen.push(id) });
        buildListNavBindings().find((b) => b.id === "list:next-j")!.run(chanCtx);
        expect(seen).toEqual(["a"]);
        globalStore.set(listNavAtom, null);
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run frontend/app/store/keybindings/bindings.test.ts`
Expected: FAIL — `./listnav` module and `buildListNavBindings` do not exist.

- [ ] **Step 3: Create `listnav.ts`**

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The single home for the cockpit's "active list cursor". A plain master-detail list surface
// publishes its cursor list here while its list view is active; the registry's list-nav bindings
// (bindings.ts) read it on keypress. Only one surface is mounted at a time (cockpitshell), so at
// most one controller is active. The rich surfaces (cockpit/agent) own their own keys and MUST NOT
// register a controller.

import { globalStore } from "@/app/store/jotaiStore";
import type { SurfaceKey } from "@/app/view/agents/agents";
import { atom, type PrimitiveAtom } from "jotai";
import { useEffect } from "react";

export interface ListNavController {
    surface: SurfaceKey;
    navigableIds: string[];
    cursorId: string | undefined;
    setCursor: (id: string) => void; // cursor == selection: moving IS selecting
}

export const listNavAtom = atom<ListNavController | null>(null) as PrimitiveAtom<ListNavController | null>;

// Register `controller` as the active list cursor for the caller's lifetime (or while its list view
// is active). Pass null when the list is not the active view (e.g. memory graph, files review) to
// withdraw. Memoize `controller` (useMemo) so registration only churns when the list/cursor changes.
export function useSurfaceListNav(controller: ListNavController | null): void {
    useEffect(() => {
        if (controller == null) {
            return;
        }
        globalStore.set(listNavAtom, controller);
        return () => {
            globalStore.set(listNavAtom, (prev) => (prev === controller ? null : prev));
        };
    }, [controller]);
}
```

- [ ] **Step 4: Add `buildListNavBindings` to `bindings.ts`**

Add the import at the top of `bindings.ts` (with the other local imports):

```ts
import { listNavAtom } from "./listnav";
```

Add the builder (e.g. after `buildGlobalBindings`, before `agentNav`):

```ts
// One shared set of list-cursor bindings for the plain master-detail surfaces. Active only when the
// mounted surface has published a controller (listnav.ts) for itself and focus is not in a field.
export function buildListNavBindings(): Binding[] {
    const active = (ctx: KeyContext): boolean => {
        if (ctx.editable || ctx.modalOpen) {
            return false;
        }
        const c = globalStore.get(listNavAtom);
        return c != null && c.surface === ctx.surface;
    };
    const move = (delta: number) => {
        const c = globalStore.get(listNavAtom);
        if (c == null) {
            return;
        }
        const next = moveCursor(c.navigableIds, c.cursorId, delta);
        if (next != null) {
            c.setCursor(next);
        }
    };
    return [
        { id: "list:next-j", keys: "j", group: "Navigation", label: "Next item", when: active, run: () => move(1) },
        { id: "list:prev-k", keys: "k", group: "Navigation", label: "Previous item", when: active, run: () => move(-1) },
        { id: "list:next", keys: "ArrowDown", group: "Navigation", label: "Next item", when: active, run: () => move(1) },
        { id: "list:prev", keys: "ArrowUp", group: "Navigation", label: "Previous item", when: active, run: () => move(-1) },
    ];
}
```

(`moveCursor` is already imported at `bindings.ts:8`; `globalStore` at :5; `KeyContext`/`Binding` at :10.)

- [ ] **Step 5: Register the list-nav bindings app-wide**

In `cockpit-root.tsx`, add the import and register after the existing global bindings (`:79-80`):

```ts
import { buildGlobalBindings, buildListNavBindings } from "@/app/store/keybindings/bindings";
```

```ts
    const globalBindings = useMemo(() => buildGlobalBindings(model), [model]);
    useKeybindings(globalBindings);
    const listNavBindings = useMemo(() => buildListNavBindings(), []);
    useKeybindings(listNavBindings);
```

- [ ] **Step 6: Run the list-nav tests to verify they pass**

Run: `npx vitest run frontend/app/store/keybindings/bindings.test.ts`
Expected: PASS (all list-nav tests + Task 1 tests).

- [ ] **Step 7: Extend the conflict invariant**

In `store.test.ts`, import the new symbols at the top:

```ts
import { buildAgentBindings, buildGlobalBindings, buildListNavBindings } from "./bindings";
import { listNavAtom } from "./listnav";
```

Add to the `describe("keybinding conflict invariant")` block:

```ts
    it("global + list-nav (controller active on a plain surface) has no key conflicts", () => {
        const model = {} as any;
        globalStore.set(listNavAtom, { surface: "channels", navigableIds: [], cursorId: undefined, setCursor() {} });
        expect(() => assertNoConflicts([...buildGlobalBindings(model), ...buildListNavBindings()])).not.toThrow();
        globalStore.set(listNavAtom, null);
    });

    it("global + list-nav + agent bindings do not conflict (no controller)", () => {
        const model = {} as any;
        globalStore.set(listNavAtom, null);
        expect(() =>
            assertNoConflicts([...buildGlobalBindings(model), ...buildListNavBindings(), ...buildAgentBindings(model)])
        ).not.toThrow();
    });
```

Run: `npx vitest run frontend/app/store/keybindings/store.test.ts`
Expected: PASS. (On the agent surface the controller is `channels`/null, so `list:next-j`'s `when` is false there and cannot collide with `agent:next-j`; on channels `agent:next-j`'s `agentNav` is false.)

---

### Task 3: Channels adopts the shared list-cursor

**Files:**
- Modify: `frontend/app/view/agents/channelrail.tsx`
- Verify (CDP): live dev app

**Interfaces:**
- Consumes: `useSurfaceListNav`, `ListNavController` (`@/app/store/keybindings/listnav`). Rail already has: `active` (visible channels, `channelrail.tsx:48-51`), `activeId` prop, `onSelect` prop.
- Cursor == `activeChannelIdAtom` (via `activeId`); setCursor == `onSelect` (calls `selectChannel`). Register from the **rail** because the visible/filtered order lives there.

- [ ] **Step 1: Register the controller in `ChannelRail`**

Add imports:

```ts
import { useSurfaceListNav, type ListNavController } from "@/app/store/keybindings/listnav";
import { useMemo } from "react"; // if not already imported
```

Inside `ChannelRail`, after `active`/`archived` are derived (`:48-51`), add (navigable order = visible active rows, then archived, matching render order):

```ts
    const navIds = useMemo(() => [...active, ...archived].map((c) => c.oid), [active, archived]);
    const controller = useMemo<ListNavController>(
        () => ({ surface: "channels", navigableIds: navIds, cursorId: activeId, setCursor: onSelect }),
        [navIds, activeId, onSelect]
    );
    useSurfaceListNav(controller);
```

If archived rows should be excluded from `j`/`k` (they render collapsed), use `active.map((c) => c.oid)` instead. Prefer including both only if archived rows are visibly listed by default; otherwise use `active` only. (Pick one; match what the rail renders as reachable rows.)

- [ ] **Step 2: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 3: Verify over CDP against the live dev app**

Ensure the dev app is running (`tail -f /dev/null | task dev` per the memory gotcha; do not kill an existing dev server without approval). Then:

Run: `node scripts/cdp-shot.mjs scratchpad/channels-before.png`
Drive: press `g c` (or `]` from cockpit until Channels), then press `j` twice and `k` once. Re-shot: `node scripts/cdp-shot.mjs scratchpad/channels-after.png`.
Expected: the highlighted/active channel row moves down two then up one; the center pane updates to the selected channel. Confirm typing in the rail search box still inserts `j`/`k` literally (typing-guard).

---

### Task 4: Sessions adopts the shared list-cursor

**Files:**
- Modify: `frontend/app/view/agents/sessionssurface.tsx`
- Verify (CDP): live dev app

**Interfaces:**
- Cursor == `model.sessionsSelAtom` (`sel`, `sessionssurface.tsx:70`); setCursor == `setSel`. Navigable order = the pinned `"all"` entry followed by every grouped session key `` `${runtime}:${id}` `` in render order (`:149-199`).

- [ ] **Step 1: Register the controller in `SessionsSurface`**

Add imports (`useSurfaceListNav`, `ListNavController`, `useMemo`). After `groups` is computed (`:77-82`), and before any early return, add:

```ts
    const navIds = useMemo(
        () => ["all", ...groups.flatMap((g) => g.items.map((s) => `${s.runtime}:${s.id}`))],
        [groups]
    );
    const controller = useMemo<ListNavController>(
        () => ({ surface: "sessions", navigableIds: navIds, cursorId: sel, setCursor: setSel }),
        [navIds, sel, setSel]
    );
    useSurfaceListNav(controller);
```

`sel` is a `string` (default `"all"`), never undefined, so no coercion needed. `setSel` is the `useAtom` setter (stable).

- [ ] **Step 2: Typecheck** — `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` → exit 0.

- [ ] **Step 3: Verify over CDP**

Navigate to Sessions (`g s` or `]`). Press `j` from the default "All activity" selection; confirm the left-list selection moves into the first grouped session and the right pane swaps from the merged feed to that session's detail; `k` returns to "All activity". Confirm the filter chips still work by mouse.

---

### Task 5: Memory adopts the shared list-cursor (list view only)

**Files:**
- Modify: `frontend/app/view/agents/memorysurface.tsx` (the `ListView` component, ~:113-208)
- Verify (CDP): live dev app

**Interfaces:**
- Cursor == `memSelectedIdAtom` (`selectedId` prop into `ListView`); setCursor == `selectNote`. Register from `ListView` (rendered only in list view, `:571`), so switching to graph view auto-withdraws the controller. Navigable order = `groupByScope(notes)` flattened (matches the rows `ListView` renders at `:124,153`).

- [ ] **Step 1: Register the controller in `ListView`**

Add imports (`useSurfaceListNav`, `ListNavController`; `useMemo` if needed). `ListView` already computes `const groups = groupByScope(notes)` (`:124`) and receives `selectedId`. After `groups`, add:

```ts
    const navIds = useMemo(() => groups.flatMap((g) => g.items.map((n) => n.id)), [groups]);
    const controller = useMemo<ListNavController>(
        () => ({
            surface: "memory",
            navigableIds: navIds,
            cursorId: selectedId ?? undefined,
            setCursor: (id) => fireAndForget(() => selectNote(id)),
        }),
        [navIds, selectedId]
    );
    useSurfaceListNav(controller);
```

(`fireAndForget` and `selectNote` are already imported in this file — confirm; if `selectNote` is imported into the surface but not visible inside `ListView`'s scope, it is module-level so it is in scope.)

- [ ] **Step 2: Typecheck** — exit 0.

- [ ] **Step 3: Verify over CDP**

Navigate to Memory (`g m` or `]`), stay in list view. Press `j`/`k`; confirm the highlighted note row moves and the detail rail loads that note's body. Switch to graph view; confirm `j`/`k` no longer drive the list (controller withdrawn) and the search box still accepts `j`/`k` as text.

---

### Task 6: Files adopts the shared list-cursor (browse mode only)

**Files:**
- Modify: `frontend/app/view/agents/filessurface.tsx`
- Verify (CDP): live dev app

**Interfaces:**
- Cursor == `filesSelectedPathAtom` (`selected`, `:276`); setCursor == `(path) => state.cwd && selectFile(state.cwd, path)`. Register only when `mode === "browse"` (review mode has its own keys — Task 9). Navigable order = `changes.files.map((c) => c.path)` (`:431` render order). The hook call MUST be above the `SurfaceEmptyState` early return (`:330-337`).

- [ ] **Step 1: Register the controller in `FilesSurface`**

Add imports (`useSurfaceListNav`, `ListNavController`; `useMemo`). Place the controller computation and hook call **before** the `agents.length === 0 && projects.length === 0` early return, after `mode`/`state`/`selected` are available:

```ts
    const browseFiles = mode === "browse" ? (state?.changes?.files ?? []) : [];
    const navIds = useMemo(() => browseFiles.map((c) => c.path), [browseFiles]);
    const controller = useMemo<ListNavController | null>(
        () =>
            mode === "browse" && state?.cwd
                ? {
                      surface: "files",
                      navigableIds: navIds,
                      cursorId: selected ?? undefined,
                      setCursor: (path) => fireAndForget(() => selectFile(state.cwd!, path)),
                  }
                : null,
        [mode, state?.cwd, navIds, selected]
    );
    useSurfaceListNav(controller);
```

Adjust the exact field access (`state?.changes?.files`) to the real shape confirmed in the file. `fireAndForget` and `selectFile` are already imported.

- [ ] **Step 2: Typecheck** — exit 0.

- [ ] **Step 3: Verify over CDP**

Navigate to Files (`g f`). In Browse mode press `j`/`k`; confirm the selected file row moves and the center diff pane updates. Toggle to Review mode; confirm `j`/`k` are now handled by review's own file navigation (Task 9), not the browse controller (no double-move).

---

### Task 7: Radar adopts the shared list-cursor

**Files:**
- Modify: `frontend/app/view/agents/radarfindingslist.tsx`
- Verify (CDP): live dev app; `frontend/app/view/agents/radarnav.test.ts` still passes

**Interfaces:**
- Cursor == `selectedId` prop; setCursor == `onSelect` prop (the `RadarSurface` `setSelectedId` state setter). Register from `RadarFindingsList` (owns the grouped render order). Navigable order = `GROUP_ORDER` flattened over `groupFindings(findings)` (matches the rendered `<button>` rows, `:54,90`).

- [ ] **Step 1: Register the controller in `RadarFindingsList`**

Add imports (`useSurfaceListNav`, `ListNavController`; `useMemo`). The component already computes the grouped findings (`groupFindings(findings)`, `:43`) and iterates `GROUP_ORDER` (`:54`). Build the flat visible order the same way and register:

```ts
    const navIds = useMemo(
        () => GROUP_ORDER.flatMap((g) => (grouped[g] ?? []).map((f) => f.id)),
        [grouped]
    );
    const controller = useMemo<ListNavController>(
        () => ({ surface: "radar", navigableIds: navIds, cursorId: selectedId, setCursor: onSelect }),
        [navIds, selectedId, onSelect]
    );
    useSurfaceListNav(controller);
```

Use the exact local variable name for the grouped map (`grouped` here is illustrative — match the real name at `:43`).

- [ ] **Step 2: Typecheck + radar nav test**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` → exit 0.
Run: `npx vitest run frontend/app/view/agents/radarnav.test.ts` → PASS (unchanged; confirms radar stays in `SURFACE_ORDER` + navrail).

- [ ] **Step 3: Verify over CDP**

Navigate to radar via `]` (from Channels) — confirm `]` now *reaches* radar (Task 1's fix; previously skipped). Also confirm `g r` reaches it. Press `j`/`k`; the selected finding moves through the grouped list and the detail pane updates.

---

### Task 8: F7a — SubagentInterior Escape into the registry

**Files:**
- Modify: `frontend/app/store/keybindings/bindings.ts` (`buildAgentBindings`, `agent:back` at :152-165)
- Modify: `frontend/app/view/agents/subagentinterior.tsx:23-32`
- Test: `frontend/app/store/keybindings/bindings.test.ts`

**Interfaces:**
- Consumes: `focusSubagentAtom` (`@/app/view/agents/subagentsstore`, `:27`).
- Produces: `subagent:back` binding (`Escape`, active on agent surface when a subagent is focused); `agent:back`'s `when` tightened to exclude the subagent-focused case. The two are mutually exclusive → order-independent, no conflict.

- [ ] **Step 1: Write the failing test**

Append to `bindings.test.ts`:

```ts
import { buildAgentBindings } from "./bindings";
import { focusSubagentAtom } from "@/app/view/agents/subagentsstore";

describe("subagent vs agent Escape", () => {
    it("routes Escape to subagent-back only while a subagent is focused, else to agent-back", () => {
        const bindings = buildAgentBindings({} as any);
        const sub = bindings.find((b) => b.id === "subagent:back")!;
        const back = bindings.find((b) => b.id === "agent:back")!;
        expect(sub.keys).toBe("Escape");
        const agentCtx: KeyContext = { surface: "agent", editable: false, modalOpen: false, leader: null };

        globalStore.set(focusSubagentAtom, { parentId: "p", id: "s" } as any);
        expect(sub.when!(agentCtx)).toBe(true);
        expect(back.when!(agentCtx)).toBe(false);
        sub.run(agentCtx);
        expect(globalStore.get(focusSubagentAtom)).toBeNull();

        // now that no subagent is focused, Escape falls to agent-back
        expect(sub.when!(agentCtx)).toBe(false);
        expect(back.when!(agentCtx)).toBe(true);
    });
});
```

Run: `npx vitest run frontend/app/store/keybindings/bindings.test.ts` → FAIL (`subagent:back` undefined).

- [ ] **Step 2: Add `subagent:back` and tighten `agent:back`**

In `bindings.ts`, add the import:

```ts
import { focusSubagentAtom } from "@/app/view/agents/subagentsstore";
```

In `buildAgentBindings`, add `subagent:back` as the first element of the returned array (before `agent:back`) and tighten `agent:back`'s `when`:

```ts
        {
            id: "subagent:back",
            keys: "Escape",
            group: "Agent",
            label: "Back to parent agent",
            // fires regardless of editable to preserve the old always-on Escape; mutually exclusive
            // with agent:back below (guarded on the same atom).
            when: (ctx) => ctx.surface === "agent" && globalStore.get(focusSubagentAtom) != null,
            run: () => globalStore.set(focusSubagentAtom, null),
        },
        {
            id: "agent:back",
            keys: "Escape",
            group: "Agent",
            label: "Back to Cockpit (or exit fullscreen)",
            when: (ctx) => agentNav(ctx) && globalStore.get(focusSubagentAtom) == null,
            run: () => {
                if (globalStore.get(terminalFullscreenAtom)) {
                    globalStore.set(terminalFullscreenAtom, false);
                } else {
                    globalStore.set(model.surfaceAtom, "cockpit");
                }
            },
        },
```

- [ ] **Step 3: Remove the ad-hoc listener from `SubagentInterior`**

In `subagentinterior.tsx`, delete the effect (`:24-32`):

```ts
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                back();
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, []);
```

Keep `back` if it is still used by the breadcrumb button (`:39`); otherwise inline/remove it. Remove the now-unused `useEffect` import if nothing else uses it in the file.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run frontend/app/store/keybindings/bindings.test.ts` → PASS.

- [ ] **Step 5: Typecheck + CDP smoke**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` → exit 0.
CDP: on the Agent surface, drill into a subagent transcript, press `Escape`; confirm it returns to the parent (same as the breadcrumb "Back to parent (Esc)" button) and that, with no subagent open, `Escape` on the Agent surface returns to Cockpit as before.

---

### Task 9: F7b — ReviewSurface triage keys into the registry

**Files:**
- Modify: `frontend/app/store/keybindings/bindings.ts` (add `buildReviewBindings`)
- Modify: `frontend/app/view/agents/reviewsurface.tsx:41-57` (remove listener, register bindings)
- Test: `frontend/app/store/keybindings/bindings.test.ts`; `frontend/app/store/keybindings/store.test.ts`

**Interfaces:**
- Consumes from `@/app/view/agents/reviewstore`: `reviewModelAtom`, `decisionsAtom`, `reviewSelectedAtom`, `appliedAtom`, `decide`, `undoLast`, `applyReview`, `hunkKey`.
- Produces `buildReviewBindings(): Binding[]` — ids `review:accept` (`a`), `review:reject` (`r`), `review:undo` (`u`), `review:next`/`review:next-j` (`ArrowDown`/`j`), `review:prev`/`review:prev-k` (`ArrowUp`/`k`), `review:apply` (`Enter`). All gated `ctx.surface === "files" && !editable && !modalOpen && reviewModel != null && applied == null`. Registered only while `ReviewSurface` is mounted (files review mode) — so review's `j`/`k` and the browse controller's `j`/`k` never coexist (Files withdraws its browse controller in review mode, Task 6).
- **Behavior change (intended, per F7):** the triage keys now respect the typing-guard — they no longer fire while an input is focused. `a`/`r` remain no-ops when there is no pending hunk (`run` returns `false` to pass the key through).

- [ ] **Step 1: Write the failing test**

Append to `bindings.test.ts`:

```ts
import { buildReviewBindings } from "./bindings";
import { appliedAtom, decisionsAtom, reviewModelAtom, reviewSelectedAtom } from "@/app/view/agents/reviewstore";

describe("review bindings", () => {
    const filesCtx: KeyContext = { surface: "files", editable: false, modalOpen: false, leader: null };

    it("is active only on files with a loaded, un-applied review and respects the typing-guard", () => {
        const a = buildReviewBindings().find((b) => b.id === "review:accept")!;
        expect(a.keys).toBe("a");
        globalStore.set(reviewModelAtom, null);
        expect(a.when!(filesCtx)).toBe(false); // no model

        globalStore.set(reviewModelAtom, { files: [] } as any);
        globalStore.set(appliedAtom, null);
        expect(a.when!(filesCtx)).toBe(true);
        expect(a.when!({ ...filesCtx, editable: true })).toBe(false);
        expect(a.when!({ ...filesCtx, surface: "memory" })).toBe(false);

        globalStore.set(appliedAtom, { accepted: 1, rejected: 0, failures: [] });
        expect(a.when!(filesCtx)).toBe(false); // already applied

        globalStore.set(reviewModelAtom, null);
        globalStore.set(appliedAtom, null);
    });

    it("j/k move the selected review file", () => {
        globalStore.set(reviewModelAtom, {
            files: [{ path: "x", hunks: [] }, { path: "y", hunks: [] }],
        } as any);
        globalStore.set(appliedAtom, null);
        globalStore.set(reviewSelectedAtom, "x");
        globalStore.set(decisionsAtom, {});
        buildReviewBindings().find((b) => b.id === "review:next-j")!.run(filesCtx);
        expect(globalStore.get(reviewSelectedAtom)).toBe("y");
        globalStore.set(reviewModelAtom, null);
        globalStore.set(appliedAtom, null);
    });
});
```

Run: `npx vitest run frontend/app/store/keybindings/bindings.test.ts` → FAIL (`buildReviewBindings` undefined).

- [ ] **Step 2: Add `buildReviewBindings` to `bindings.ts`**

Add the import:

```ts
import {
    appliedAtom, applyReview, decide, decisionsAtom, hunkKey, reviewModelAtom, reviewSelectedAtom, undoLast,
} from "@/app/view/agents/reviewstore";
```

Add the builder (faithful port of `reviewsurface.tsx`'s `onKey`, reading atoms live):

```ts
export function buildReviewBindings(): Binding[] {
    const ready = (ctx: KeyContext): boolean =>
        ctx.surface === "files" &&
        !ctx.editable &&
        !ctx.modalOpen &&
        globalStore.get(reviewModelAtom) != null &&
        globalStore.get(appliedAtom) == null;
    const files = () => globalStore.get(reviewModelAtom)?.files ?? [];
    const nextPending = (): string | undefined => {
        const sel = globalStore.get(reviewSelectedAtom);
        const d = globalStore.get(decisionsAtom);
        const fs = files();
        const f = fs.find((x) => x.path === sel) ?? fs[0];
        return f?.hunks.map((h) => hunkKey(f.path, h.id)).find((k) => !d[k]);
    };
    const moveSel = (dir: number) => {
        const fs = files();
        if (fs.length === 0) return;
        const sel = globalStore.get(reviewSelectedAtom);
        const i = fs.findIndex((f) => f.path === sel);
        const ni = Math.max(0, Math.min(fs.length - 1, (i < 0 ? 0 : i) + dir));
        globalStore.set(reviewSelectedAtom, fs[ni].path);
    };
    const decideNext = (val: "accept" | "reject") => {
        const k = nextPending();
        if (k == null) return false; // nothing pending — pass the key through
        decide(k, val);
    };
    return [
        { id: "review:accept", keys: "a", group: "Review", label: "Accept next hunk", when: ready, run: () => decideNext("accept") },
        { id: "review:reject", keys: "r", group: "Review", label: "Reject next hunk", when: ready, run: () => decideNext("reject") },
        { id: "review:undo", keys: "u", group: "Review", label: "Undo last decision", when: ready, run: () => undoLast() },
        { id: "review:next", keys: "ArrowDown", group: "Review", label: "Next file", when: ready, run: () => moveSel(1) },
        { id: "review:next-j", keys: "j", group: "Review", label: "Next file", when: ready, run: () => moveSel(1) },
        { id: "review:prev", keys: "ArrowUp", group: "Review", label: "Previous file", when: ready, run: () => moveSel(-1) },
        { id: "review:prev-k", keys: "k", group: "Review", label: "Previous file", when: ready, run: () => moveSel(-1) },
        {
            id: "review:apply",
            keys: "Enter",
            group: "Review",
            label: "Apply review",
            when: ready,
            run: () => {
                const d = globalStore.get(decisionsAtom);
                const pending = files().some((f) => f.hunks.some((h) => !d[hunkKey(f.path, h.id)]));
                if (pending) return false; // still hunks to decide — do not apply
                void applyReview();
            },
        },
    ];
}
```

Match the `Decision` literal type used by `decide` in `reviewstore.ts` (it may be a named `Decision` type rather than `"accept" | "reject"` — import and use it if so).

- [ ] **Step 3: Register in `ReviewSurface`, remove the listener**

In `reviewsurface.tsx`, remove the entire triage `useEffect` (`:42-57`) and the now-orphaned local helpers `pendingKeysOf` (`:23-27`) and `moveSel` (`:29-33`) if they have no other callers. Add:

```ts
import { useKeybindings } from "@/app/store/keybindings/store";
import { buildReviewBindings } from "@/app/store/keybindings/bindings";
import { useMemo } from "react";
```

```ts
    const reviewBindings = useMemo(() => buildReviewBindings(), []);
    useKeybindings(reviewBindings);
```

Remove any imports left unused after deleting the listener/helpers (`useEffect`, `hunkKey`, `decide`, `applyReview`, `undoLast` if no longer referenced in the component body — the diff rendering may still use some; keep those that remain used). Typecheck will flag leftovers.

- [ ] **Step 4: Run the review tests to verify they pass**

Run: `npx vitest run frontend/app/store/keybindings/bindings.test.ts` → PASS.

- [ ] **Step 5: Extend the conflict invariant for review**

In `store.test.ts`, import `buildReviewBindings` and add:

```ts
    it("global + review bindings (files review mode) do not conflict", () => {
        const model = {} as any;
        globalStore.set(listNavAtom, null);
        expect(() => assertNoConflicts([...buildGlobalBindings(model), ...buildReviewBindings()])).not.toThrow();
    });
```

(Review's `a`/`r`/`u` are only active on `files`; `r` does not clash with any global binding, and the browse controller is withdrawn in review mode so `list:*` `j`/`k` are inactive there.)

Run: `npx vitest run frontend/app/store/keybindings/store.test.ts` → PASS.

- [ ] **Step 6: Typecheck + CDP smoke**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` → exit 0.
CDP: Files → Review mode. Press `j`/`k` to move between files, `a`/`r` to accept/reject the next pending hunk, `u` to undo, `Enter` (after all hunks decided) to apply. Confirm that focusing a text field suppresses `a`/`r`/`u` (the new typing-guard) — previously they fired while typing.

---

### Task 10: Full verification pass

**Files:** none (verification only)

- [ ] **Step 1: Full unit test suite**

Run: `npx vitest run frontend/app/store/keybindings/ frontend/app/view/agents/radarnav.test.ts`
Expected: all PASS (store, bindings, radarnav). Then run the broader suite `npx vitest run` and confirm no new failures versus baseline (note: `pkg/tsgen TestGenerateWaveEventTypes` is a known-unrelated Go failure — not in scope; the vitest suite should be green).

- [ ] **Step 2: Typecheck the whole frontend**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 3: Grep-verify the invariants from Global Constraints**

Run: `grep -rn 'addEventListener("keydown"' frontend/app/view/agents/`
Expected: **F7's two named targets removed** — no matches in `subagentinterior.tsx` or `reviewsurface.tsx`. Two pre-existing Escape-only listeners survive in the inline modals `newmemorymodal.tsx` and `tooldetailmodal.tsx`; these are outside F7's scope (F7 targeted the two triage/interior listeners, not modal dismissal) and are left for a later modal-keyboard cleanup.

Run: `grep -rn "surfaceOrder" frontend/app/view/agents/usecockpitkeyboard.ts`
Expected: **0 matches** (private copy deleted).

- [ ] **Step 4: CDP end-to-end interaction-parity sweep**

With the live dev app running, drive each surface over CDP and confirm the parity promise:
- `[` / `]` cycles through **all 8** `SURFACE_ORDER` surfaces including radar, from any starting surface (not just cockpit).
- `Ctrl+1..8` and `g h/a/c/r/s/f/m/u` all jump correctly (radar via `Ctrl+4` and `g r`).
- `j`/`k` move the cursor/selection on channels, sessions, memory (list), files (browse), radar; and are inert (type as text) when a search/rename input is focused.
- Agent surface `j`/`k` (focus cycling) and cockpit `j`/`k` (card cursor) still work — no regression from the new global `list:*` bindings (neither registers a controller).

- [ ] **Step 5: Checkpoint summary**

Report done/verified/skipped: which surfaces were CDP-verified, any that could not be exercised (e.g. no live channels/sessions data — note it), and confirm the two ad-hoc listeners are gone and all keys route through the registry.

---

## Self-Review (completed against the audit)

**Spec coverage (Pass A = F1 + F2 + F7):**
- **F1 surface-switch** → Task 1 (`[`/`]` in registry, works on every surface via the global listener). ✔
- **F1 list-cursor** → Tasks 2-7 (one shared `useSurfaceListNav` + `buildListNavBindings`, adopted by channels/sessions/memory/files/radar). ✔
- **F1 usage Segmented toggles** → intentionally **not** given list-nav (usage has no row list; the audit's own alternative is "note the gap is intentional"). Usage still gains `[`/`]`/`Ctrl`/`g` surface-switch parity and its Segmented buttons keep native Tab/Enter. Documented here as the accepted resolution. ✔ (scope note, not a code task)
- **F2 radar** → Task 1 (`SURFACE_ORDER` already includes radar, so `[`/`]` and `Ctrl:1-8` reach it; `g r` added). `radarnav.test.ts` already locks the order. ✔
- **F7 subagentinterior** → Task 8. ✔
- **F7 reviewsurface** → Task 9. ✔

**Type consistency:** `ListNavController` fields (`surface`, `navigableIds`, `cursorId`, `setCursor`) are used identically in `listnav.ts`, `buildListNavBindings`, and every surface adoption. `buildListNavBindings`/`buildReviewBindings` take no args; `buildGlobalBindings`/`buildAgentBindings` take `model` — consistent with existing signatures and the conflict tests.

**Placeholder scan:** none — every step carries the actual code or the exact command + expected output. Where a real local identifier must be confirmed against the file (e.g. memory's `groupByScope` grouping variable, radar's `grouped` map name, files' `state.changes.files` shape), the step says to match the real name and typecheck catches drift.

**Known follow-ups (out of Pass A scope, noted for honesty):** `cursorId == selection` means `j`/`k` loads the detail on every step (standard master-detail behavior). If rapid navigation proves janky in practice, add debouncing — deferred per "measure before optimizing." A distinct Enter-to-descend action (e.g. focus a channel composer, resume a session) can be layered onto the controller later via an optional `open` field.

## Post-review adjustments (final whole-branch review)

Final review returned 0 Critical, 1 Important, 4 Minor. Resolutions:
- **[Important — fixed]** `NewMemoryModal` was gated by local React state, so `deriveKeyContext.modalOpen` never saw it; with focus off its inputs, the new global `[`/`]`/`j`/`k` fired on the surface beneath and `[` unmounted the modal, losing a typed note. Fixed by hoisting the open flag to `model.memNewOpenAtom` (mirrors `newAgentOpenAtom`/`newProjectOpenAtom`) and OR-ing it into `deriveKeyContext`. Added an unmount effect in `MemorySurface` resetting the flag, so a programmatic surface change while the modal is open can't leave `modalOpen` stuck `true` (which would freeze global nav). CDP-verified: modal open ⇒ `[`/`]` suppressed + modal survives; Escape ⇒ modal closes and surface-switch is released.
- **[Minor — fixed]** Radar `navIds` flattened all groups including collapsed ones, so `j`/`k` could select a hidden row. Now built from open groups only (matches the `isOpen` render gate); `grouped` memoized on `[findings]`, which also removes radar's per-render controller re-registration.
- **[Minor — fixed]** Corrected the plan's inaccurate "grep keydown returns 0" claim: F7's two named listeners (subagentinterior + reviewsurface) are removed; two pre-existing Escape-only listeners survive in the inline modals `newmemorymodal`/`tooldetailmodal`, outside F7's scope, deferred to a later modal-keyboard cleanup.
- **[Minor — fixed]** `store.test.ts` conflict-invariant surface sample now includes `radar` (the surface F2 makes reachable).
- **[Minor — accepted, won't-fix]** Sessions/memory rebuild `navIds` from time-dependent grouping each render, re-registering the list-nav controller. Harmless — nothing subscribes to `listNavAtom` reactively (bindings read it via `globalStore.get` at keypress), so there is no re-render cascade and the set is self-healing. Memoizing time-varying grouping adds risk/ugliness for zero functional gain; deferred per "measure before optimizing."
