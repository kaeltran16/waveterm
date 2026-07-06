# Cockpit Hints Footer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the transient which-key bar with an always-on, context-aware keyboard hints footer that can never show a key that wouldn't fire.

**Architecture:** A single always-mounted footer at the bottom of the cockpit reads the live keybinding registry, the current surface, the active leader, and DOM focus, and renders one of three postures (rest / in-terminal / leader). Rest and in-terminal are the *same* code path — the footer filters curated hint chips through each referenced binding's live `when(ctx)`, so keys that can't fire drop automatically. Curated hints reference real binding ids; a unit test fails the build if an id drifts.

**Tech Stack:** React 19 + jotai + Tailwind 4 (`@theme` tokens); vitest for unit tests; existing keybinding registry (`frontend/app/store/keybindings/*`). No jsdom render harness — the component is verified on the live dev app over CDP.

**Spec:** `docs/superpowers/specs/2026-07-06-cockpit-hints-footer-design.md`

---

## Before you start (shared working tree)

This repo is edited from parallel sessions. Before committing (Task 7):
- Re-check `git status` / branch. Stage **only** the files this plan touches.
- **`frontend/app/store/keybindings/bindings.ts` and `frontend/app/store/keybindings/bindings.test.ts` already have uncommitted changes** (a `closeTargetForDoubleCtrlC` / double-`^C` close feature) that predate this work. Your Task 1/2 edits stack on top of the same `bindings.ts`. Same-file hunks can't be cleanly separated, so committing `bindings.ts` sweeps that pre-existing change in. Decide with the user whether to (a) commit that double-`^C` change first as its own commit, or (b) let it ride along. Do not silently discard it.

## Commit policy (per user's git workflow)

The user batches into **one commit at the end** and requires explicit approval before any commit. So each task below ends with a **verify-green checkpoint** (typecheck + relevant tests), not a per-task commit. The single commit lives in Task 7 and is gated on approval. This intentionally deviates from the writing-plans per-task-commit default.

## File structure

| File | Responsibility |
|---|---|
| `frontend/app/store/keybindings/bindings.ts` | Add `buildAgentBindings(model)` (moved from `agentsurface.tsx`, reads live atoms) + the `agent:return-nav` chord. |
| `frontend/app/store/keybindings/store.test.ts` | Replace the hand-mirrored agent-binding array in the conflict test with the real `buildAgentBindings`. |
| `frontend/app/view/agents/agentsurface.tsx` | Register `buildAgentBindings(model)`; add `data-cockpit-surface-wrap` to the wrapper. Drops the inline binding array + `step`. |
| `frontend/app/cockpit/footerhints.ts` | The `FooterHint` type + curated `GLOBAL_HINTS` and `SURFACE_HINTS` tables (presentation source of truth). |
| `frontend/app/cockpit/footerhints.test.ts` | Drift guard — every referenced binding id exists in the built registry. |
| `frontend/app/cockpit/footer-visible.ts` | Pure `visibleHints(ctx, bindings, surfaceHints, globalHints)` (no DOM/atoms). |
| `frontend/app/cockpit/footer-visible.test.ts` | Posture unit tests for `visibleHints`. |
| `frontend/app/cockpit/hints-footer.tsx` | The footer component (three postures). Replaces `whichkey-bar.tsx`. |
| `frontend/app/cockpit/whichkey-bar.tsx` | **Deleted** — folded into the footer. |
| `frontend/app/cockpit/cockpit-root.tsx` | Mount `<HintsFooter/>` in layout flow; drop the `<WhichKeyBar/>` overlay. |

## Commands reference

- Single test file: `npx vitest run <path>`
- Typecheck (repo gotcha — bare `tsc` stack-overflows): `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
- Full unit suite: `npx vitest run`
- Dev app (for CDP): `tail -f /dev/null | task dev` then `node scripts/cdp-shot.mjs out.png`

---

## Task 1: Extract `buildAgentBindings(model)` (behavior-preserving refactor)

Move the agent-surface bindings out of `agentsurface.tsx` into `bindings.ts` so (a) the drift test and the conflict test have one import surface and (b) the array is stable (run() reads live atoms instead of closing over per-render values).

**Files:**
- Modify: `frontend/app/store/keybindings/store.test.ts` (conflict test)
- Modify: `frontend/app/store/keybindings/bindings.ts` (add `buildAgentBindings`)
- Modify: `frontend/app/view/agents/agentsurface.tsx` (use the new builder)

- [ ] **Step 1: Update the conflict test to use the real builder (this is the failing test)**

In `frontend/app/store/keybindings/store.test.ts`, add `buildAgentBindings` to the import and replace the second conflict test's hand-mirrored array. Replace this block:

```ts
    it("global + agent-surface sample bindings do not conflict", () => {
        const model = { surfaceAtom: {}, paletteOpenAtom: {}, newAgentOpenAtom: {} } as any;
        // Mirror the agent-surface bindings' keys/when for the invariant check.
        const nav = (c: KeyContext) => !c.editable && !c.modalOpen && c.surface === "agent";
        const agentKeys = ["Escape", "ArrowLeft", "ArrowRight", "k", "j", "d", "f"];
        const agentBindings: Binding[] = agentKeys.map((keys, i) => ({
            id: `agent:${i}`,
            keys,
            group: "Agent",
            label: keys,
            when: nav,
            run: () => {},
        }));
        expect(() => assertNoConflicts([...buildGlobalBindings(model), ...agentBindings])).not.toThrow();
    });
```

with:

```ts
    it("global + agent-surface bindings do not conflict", () => {
        const model = {} as any; // build() reads no atoms; run()/when() do, and are not called here
        expect(() => assertNoConflicts([...buildGlobalBindings(model), ...buildAgentBindings(model)])).not.toThrow();
    });
```

And update the import line:

```ts
import { buildAgentBindings, buildGlobalBindings } from "./bindings";
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run frontend/app/store/keybindings/store.test.ts`
Expected: FAIL — `buildAgentBindings` is not exported from `./bindings`.

- [ ] **Step 3: Implement `buildAgentBindings` in `bindings.ts`**

Add these imports at the top of `frontend/app/store/keybindings/bindings.ts` (alongside the existing imports):

```ts
import { moveCursor } from "@/app/view/agents/agentsviewmodel";
import { railVisibleAtom, terminalFullscreenAtom } from "@/app/view/agents/railstore";
```

Then append this function to the end of the file (after `buildGlobalBindings`). It reuses the existing module-level `navigate` helper:

```ts
const agentNav = (ctx: KeyContext) => navigate(ctx) && ctx.surface === "agent";

// Agent (Focus) surface bindings. Moved out of agentsurface.tsx so the registry has one home
// and the array is stable: run() reads live atoms instead of closing over per-render focus/order.
// focusIdAtom is kept synced to the resolved focused agent (agentsurface.tsx), so reading it live
// is equivalent to the old closure over `agent.id`.
export function buildAgentBindings(model: AgentsViewModel): Binding[] {
    const step = (delta: number) => {
        const order = globalStore.get(model.orderAtom);
        const fid = globalStore.get(model.focusIdAtom);
        globalStore.set(model.focusIdAtom, moveCursor(order, fid, delta) ?? fid);
        globalStore.set(model.focusReplyAtom, false);
    };
    return [
        {
            id: "agent:back",
            keys: "Escape",
            group: "Agent",
            label: "Back to Cockpit (or exit fullscreen)",
            when: agentNav,
            run: () => {
                if (globalStore.get(terminalFullscreenAtom)) {
                    globalStore.set(terminalFullscreenAtom, false);
                } else {
                    globalStore.set(model.surfaceAtom, "cockpit");
                }
            },
        },
        { id: "agent:prev", keys: "ArrowLeft", group: "Agent", label: "Previous agent", when: agentNav, run: () => step(-1) },
        { id: "agent:next", keys: "ArrowRight", group: "Agent", label: "Next agent", when: agentNav, run: () => step(1) },
        { id: "agent:prev-k", keys: "k", group: "Agent", label: "Previous agent", when: agentNav, run: () => step(-1) },
        { id: "agent:next-j", keys: "j", group: "Agent", label: "Next agent", when: agentNav, run: () => step(1) },
        {
            id: "agent:toggle-rail",
            keys: "d",
            group: "Agent",
            label: "Toggle agent rail",
            when: agentNav,
            run: () => globalStore.set(railVisibleAtom, !globalStore.get(railVisibleAtom)),
        },
        {
            id: "agent:fullscreen",
            keys: "f",
            group: "Agent",
            label: "Toggle terminal fullscreen",
            when: agentNav,
            run: () => globalStore.set(terminalFullscreenAtom, !globalStore.get(terminalFullscreenAtom)),
        },
    ];
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run frontend/app/store/keybindings/store.test.ts`
Expected: PASS (both conflict tests green).

- [ ] **Step 5: Switch `agentsurface.tsx` to the extracted builder**

In `frontend/app/view/agents/agentsurface.tsx`:

Remove these now-unused imports:
```ts
import type { Binding } from "@/app/store/keybindings/types";
import { moveCursor } from "./agentsviewmodel";
```
Change the railstore import to drop `railVisibleAtom` (still need `terminalFullscreenAtom`):
```ts
import { terminalFullscreenAtom } from "./railstore";
```
Add the builder import (next to the existing `useKeybindings` import):
```ts
import { buildAgentBindings } from "@/app/store/keybindings/bindings";
```

Delete the `step` function (the `const step = (delta: number) => { ... };` block) and replace the entire inline `agentBindings` `useMemo` (the `const agentBindings = useMemo<Binding[]>(() => { ... }, [model, order, agent?.id]);` block) plus the following `useKeybindings(agentBindings);` with:

```ts
    // Agent-surface keys live in the registry (bindings.ts). Stable array — run() reads live atoms.
    const agentBindings = useMemo(() => buildAgentBindings(model), [model]);
    useKeybindings(agentBindings);
```

> Note: `order` is still consumed elsewhere in the component (the roster/focus resolution and the
> `useEffect` sync), so keep the `const order = useAtomValue(model.orderAtom);` line. Only the
> binding-array's dependency on it is gone.

- [ ] **Step 6: Verify green (typecheck + tests)**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0 (clean baseline — any error is yours).

Run: `npx vitest run frontend/app/store/keybindings/`
Expected: PASS.

---

## Task 2: Add the `Shift+Esc` return-to-nav chord

Give keyboard users a way out of the terminal back to surface nav. Bare `Esc` still reaches the TUI (`agent:back` stays `!editable`-guarded).

**Files:**
- Modify: `frontend/app/store/keybindings/bindings.ts` (`buildAgentBindings`)
- Modify: `frontend/app/view/agents/agentsurface.tsx` (wrapper attribute)

- [ ] **Step 1: Add a conflict-invariant assertion for the chord (failing test)**

In `frontend/app/store/keybindings/store.test.ts`, add this test inside the `describe("keybinding conflict invariant", ...)` block:

```ts
    it("registers agent:return-nav on Shift:Escape, active only in the terminal", () => {
        const model = {} as any;
        const b = buildAgentBindings(model).find((x) => x.id === "agent:return-nav");
        expect(b?.keys).toBe("Shift:Escape");
        // fires only while the TUI owns focus (editable) on the agent surface
        expect(b?.when?.({ surface: "agent", editable: true, modalOpen: false, leader: null })).toBe(true);
        expect(b?.when?.({ surface: "agent", editable: false, modalOpen: false, leader: null })).toBe(false);
    });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run frontend/app/store/keybindings/store.test.ts -t "return-nav"`
Expected: FAIL — no binding with id `agent:return-nav` (`b` is undefined).

- [ ] **Step 3: Add the binding to `buildAgentBindings`**

In `frontend/app/store/keybindings/bindings.ts`, add this entry to the array returned by `buildAgentBindings` (after `agent:fullscreen`):

```ts
        {
            id: "agent:return-nav",
            keys: "Shift:Escape",
            group: "Agent",
            label: "Return focus to nav",
            when: (ctx) => ctx.surface === "agent" && ctx.editable, // only while the TUI owns focus
            run: () => {
                (document.activeElement as HTMLElement | null)?.blur?.();
                // refocus the surface wrapper (tabIndex=0) so ↑↓/j/k/d/f resume
                document.querySelector<HTMLElement>("[data-cockpit-surface-wrap]")?.focus();
            },
        },
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run frontend/app/store/keybindings/store.test.ts`
Expected: PASS (the new test + both conflict invariants — `Shift:Escape` collides with nothing).

- [ ] **Step 5: Tag the surface wrapper so the chord can refocus it**

In `frontend/app/view/agents/agentsurface.tsx`, add the `data-cockpit-surface-wrap` attribute to the wrapper `div` (the one with `ref={wrapRef} tabIndex={0}`):

```tsx
            <div ref={wrapRef} tabIndex={0} data-cockpit-surface-wrap className="flex h-full w-full outline-none">
```

- [ ] **Step 6: Verify green**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

Run: `npx vitest run frontend/app/store/keybindings/`
Expected: PASS.

---

## Task 3: `footerhints.ts` data + drift guard

The presentation source of truth, plus the test that keeps it honest.

**Files:**
- Create: `frontend/app/cockpit/footerhints.ts`
- Create: `frontend/app/cockpit/footerhints.test.ts`

- [ ] **Step 1: Write the drift-guard test first**

Create `frontend/app/cockpit/footerhints.test.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { buildAgentBindings, buildGlobalBindings } from "@/app/store/keybindings/bindings";
import { describe, expect, it } from "vitest";
import { GLOBAL_HINTS, SURFACE_HINTS } from "./footerhints";

// Every binding id a footer hint references must exist in the built registry, or the footer would
// silently lie about what a key does. Rename/remove a binding id -> this fails the build.
describe("footer hints reference real bindings", () => {
    it("has no dangling binding id", () => {
        const model = {} as any; // build() reads no atoms
        const ids = new Set([...buildGlobalBindings(model), ...buildAgentBindings(model)].map((b) => b.id));
        const referenced = [...GLOBAL_HINTS, ...Object.values(SURFACE_HINTS).flat()].flatMap((h) => h.ids);
        const missing = referenced.filter((id) => !ids.has(id));
        expect(missing).toEqual([]);
    });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run frontend/app/cockpit/footerhints.test.ts`
Expected: FAIL — cannot resolve `./footerhints`.

- [ ] **Step 3: Create `footerhints.ts`**

Create `frontend/app/cockpit/footerhints.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Curated footer hints. Presentation source of truth: each chip supplies a terse glyph + label and
// references the real binding id(s) it stands for. The footer only renders a chip when at least one
// referenced binding is active for the current KeyContext (footer-visible.ts), so a chip can never
// show a key that wouldn't fire. footerhints.test.ts asserts every referenced id exists.

import type { SurfaceKey } from "@/app/store/keybindings/types";

export interface FooterHint {
    ids: string[]; // binding ids this chip represents (>=1); shown if any is active in ctx
    glyph: string; // terse key display, e.g. "↑↓", "⌃P"
    label: string; // terse action, e.g. "move", "palette"
}

// Appended to every surface; each filtered by its binding's live when(ctx).
export const GLOBAL_HINTS: FooterHint[] = [
    { ids: ["go:cockpit"], glyph: "g", label: "go" }, // g-leader nav; drops in the terminal
    { ids: ["palette"], glyph: "⌃P", label: "palette" },
    { ids: ["new-agent"], glyph: "⌃N", label: "new" },
    { ids: ["help"], glyph: "?", label: "help" }, // Shift+?; drops in the terminal
];

// Only the agent surface has surface-specific bindings today (see spec Finding). Other surfaces
// fall back to GLOBAL_HINTS only.
export const SURFACE_HINTS: Partial<Record<SurfaceKey, FooterHint[]>> = {
    agent: [
        { ids: ["agent:prev-k", "agent:next-j", "agent:prev", "agent:next"], glyph: "↑↓", label: "move" },
        { ids: ["agent:toggle-rail"], glyph: "d", label: "rail" },
        { ids: ["agent:fullscreen"], glyph: "f", label: "full" },
        { ids: ["agent:back"], glyph: "esc", label: "back" },
        { ids: ["cycle-agent-next", "cycle-agent-prev"], glyph: "^Tab", label: "cycle" },
        { ids: ["agent:return-nav"], glyph: "⇧Esc", label: "leave" }, // editable-only via its binding
    ],
};
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run frontend/app/cockpit/footerhints.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify green**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

---

## Task 4: `footer-visible.ts` pure posture logic

The pure filter that turns (ctx + registry + hint tables) into the chips to render. Mirrors the `matcher.ts` pattern: no DOM, no atoms, fully unit-tested.

**Files:**
- Create: `frontend/app/cockpit/footer-visible.ts`
- Create: `frontend/app/cockpit/footer-visible.test.ts`

- [ ] **Step 1: Write the posture tests first**

Create `frontend/app/cockpit/footer-visible.test.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Binding, KeyContext } from "@/app/store/keybindings/types";
import { describe, expect, it } from "vitest";
import type { FooterHint } from "./footerhints";
import { visibleHints } from "./footer-visible";

const nav = (c: KeyContext) => !c.editable && !c.modalOpen && c.surface === "agent";
const bindings: Binding[] = [
    { id: "agent:move", keys: "j", group: "Agent", label: "", when: nav, run: () => {} },
    { id: "palette", keys: "Ctrl:p", group: "Global", label: "", run: () => {} },
    { id: "agent:leave", keys: "Shift:Escape", group: "Agent", label: "", when: (c) => c.surface === "agent" && c.editable, run: () => {} },
];
const surfaceHints: FooterHint[] = [
    { ids: ["agent:move"], glyph: "↑↓", label: "move" },
    { ids: ["agent:leave"], glyph: "⇧Esc", label: "leave" },
    { ids: ["nonexistent"], glyph: "x", label: "ghost" },
];
const globalHints: FooterHint[] = [{ ids: ["palette"], glyph: "⌃P", label: "palette" }];

const rest: KeyContext = { surface: "agent", editable: false, modalOpen: false, leader: null };
const term: KeyContext = { surface: "agent", editable: true, modalOpen: false, leader: null };

describe("visibleHints", () => {
    it("at rest shows nav + always-on hints, hides editable-only and dangling ones", () => {
        expect(visibleHints(rest, bindings, surfaceHints, globalHints).map((c) => c.label)).toEqual(["move", "palette"]);
    });

    it("in the terminal drops nav hints and shows editable-surviving ones", () => {
        expect(visibleHints(term, bindings, surfaceHints, globalHints).map((c) => c.label)).toEqual(["leave", "palette"]);
    });

    it("never shows a hint whose binding id does not exist", () => {
        const labels = visibleHints(rest, bindings, surfaceHints, globalHints).map((c) => c.label);
        expect(labels).not.toContain("ghost");
    });

    it("de-dupes a hint referenced by both surface and global tables", () => {
        const s: FooterHint[] = [{ ids: ["palette"], glyph: "⌃P", label: "palette" }];
        const g: FooterHint[] = [{ ids: ["palette"], glyph: "⌃P", label: "palette" }];
        expect(visibleHints(rest, bindings, s, g).filter((c) => c.label === "palette").length).toBe(1);
    });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run frontend/app/cockpit/footer-visible.test.ts`
Expected: FAIL — cannot resolve `./footer-visible`.

- [ ] **Step 3: Implement `visibleHints`**

Create `frontend/app/cockpit/footer-visible.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pure. No DOM, no atoms. Given the live KeyContext, the active registry, and the curated hint
// tables, returns the ordered chips to render. A hint shows only if at least one referenced binding
// is currently active (its when(ctx) passes) — so the footer inherits the dispatcher's posture rules
// and can never show a key that wouldn't fire. Surface hints first, then global; de-duped by id.

import type { Binding, KeyContext } from "@/app/store/keybindings/types";
import type { FooterHint } from "./footerhints";

export interface HintChip {
    glyph: string;
    label: string;
}

export function visibleHints(
    ctx: KeyContext,
    bindings: Binding[],
    surfaceHints: FooterHint[],
    globalHints: FooterHint[]
): HintChip[] {
    const activeIds = new Set(bindings.filter((b) => (b.when ? b.when(ctx) : true)).map((b) => b.id));
    const shown = new Set<string>();
    const out: HintChip[] = [];
    for (const h of [...surfaceHints, ...globalHints]) {
        if (!h.ids.some((id) => activeIds.has(id))) {
            continue;
        }
        if (h.ids.some((id) => shown.has(id))) {
            continue; // already rendered (id referenced by both tables)
        }
        h.ids.forEach((id) => shown.add(id));
        out.push({ glyph: h.glyph, label: h.label });
    }
    return out;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run frontend/app/cockpit/footer-visible.test.ts`
Expected: PASS (all four cases).

- [ ] **Step 5: Verify green**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

---

## Task 5: `hints-footer.tsx` + mount it + delete the which-key bar

The thin glue component. No unit test (no jsdom render harness — the logic is already covered by Task 4; the component is verified on the live app in Task 6).

**Files:**
- Create: `frontend/app/cockpit/hints-footer.tsx`
- Delete: `frontend/app/cockpit/whichkey-bar.tsx`
- Modify: `frontend/app/cockpit/cockpit-root.tsx`

- [ ] **Step 1: Create the footer component**

Create `frontend/app/cockpit/hints-footer.tsx`:

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Always-on keyboard hints footer. Three postures, all in one bar:
//  - leader active (e.g. after `g`): show the continuation list (the former WhichKeyBar).
//  - otherwise: show visibleHints(ctx) — surface hints at rest, and only editable-surviving chords
//    (dimmed) when focus is in the terminal. In-terminal falls out of the filter, not a special case.
// Mounted in layout flow (reserves ~28px), so it never overlays content.

import { deriveKeyContext } from "@/app/store/keybindings/dispatcher";
import { activeLeaderAtom } from "@/app/store/keybindings/leaderatom";
import { bindingsAtom } from "@/app/store/keybindings/store";
import type { AgentsViewModel } from "@/app/view/agents/agents";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect, useState } from "react";
import { visibleHints } from "./footer-visible";
import { GLOBAL_HINTS, SURFACE_HINTS } from "./footerhints";

function FooterBar({ children, dim }: { children?: React.ReactNode; dim?: boolean }) {
    return (
        <div
            className={cn(
                "flex h-7 shrink-0 items-center gap-4 border-t border-edge-strong bg-modalbg px-4",
                dim && "opacity-60"
            )}
        >
            {children}
        </div>
    );
}

function Chip({ glyph, label }: { glyph: string; label: string }) {
    return (
        <span className="flex items-center gap-1.5 text-[12px] text-secondary">
            <span className="rounded-[5px] border border-edge-mid px-[6px] py-0.5 font-mono text-[10.5px] text-primary">
                {glyph}
            </span>
            {label}
        </span>
    );
}

export function HintsFooter({ model }: { model: AgentsViewModel }) {
    const surface = useAtomValue(model.surfaceAtom);
    const leader = useAtomValue(activeLeaderAtom);
    const bindings = useAtomValue(bindingsAtom);
    // `editable` reads document.activeElement (not atom-tracked); recompute on focus moves.
    const [, recomputeOnFocus] = useState(0);
    useEffect(() => {
        const bump = () => recomputeOnFocus((n) => n + 1);
        window.addEventListener("focusin", bump);
        window.addEventListener("focusout", bump);
        return () => {
            window.removeEventListener("focusin", bump);
            window.removeEventListener("focusout", bump);
        };
    }, []);

    // Leader posture: continuations for the active leader (ported from the old WhichKeyBar).
    if (leader != null) {
        const items = bindings
            .filter((b) => b.keys.startsWith(leader + " "))
            .map((b) => ({ next: b.keys.split(" ")[1], label: b.label }));
        return (
            <FooterBar>
                <span className="shrink-0 font-mono text-[11px] text-accent-soft">{leader} →</span>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                    {items.map((it) => (
                        <Chip key={it.next} glyph={it.next} label={it.label} />
                    ))}
                </div>
            </FooterBar>
        );
    }

    // Rest / in-terminal posture: both fall out of filtering hints by live when(ctx).
    const ctx = deriveKeyContext();
    const chips = visibleHints(ctx, bindings, SURFACE_HINTS[surface] ?? [], GLOBAL_HINTS);
    return (
        <FooterBar dim={ctx.editable}>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                {chips.map((c) => (
                    <Chip key={c.glyph + c.label} glyph={c.glyph} label={c.label} />
                ))}
            </div>
        </FooterBar>
    );
}
```

- [ ] **Step 2: Mount it in `cockpit-root.tsx` and drop the overlay**

In `frontend/app/cockpit/cockpit-root.tsx`:

Replace the import line
```ts
import { WhichKeyBar } from "./whichkey-bar";
```
with
```ts
import { HintsFooter } from "./hints-footer";
```

In the returned JSX of `CockpitBody`, delete the `<WhichKeyBar />` line, and insert `<HintsFooter model={model} />` in layout flow — immediately after the `min-h-0 flex-1` content `div`:

```tsx
            <div className="min-h-0 flex-1">
                <CockpitShell model={model} tabId={tabIdRef.current} />
            </div>
            <HintsFooter model={model} />
            <NewProjectModal model={model} />
            <NewAgentModal model={model} />
            <CommandPalette model={model} />
            <ShortcutsCheatSheet model={model} />
            <ModalsRenderer />
```

- [ ] **Step 3: Delete the old which-key bar**

Run: `git rm frontend/app/cockpit/whichkey-bar.tsx`
(Confirm nothing else imports it: `git grep -n "whichkey-bar\|WhichKeyBar"` should return no source references after the `cockpit-root.tsx` edit.)

- [ ] **Step 4: Verify green (typecheck + full suite)**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

Run: `npx vitest run`
Expected: PASS (full suite; no import references the deleted file).

---

## Task 6: Verify on the live dev app (CDP)

No jsdom render harness exists (CLAUDE.md), so verify the rendered footer + the `Shift+Esc` gate on the running dev app over CDP. This is a manual verification task — record what you observe.

**Prereqs:** dev app running. Start headlessly so stdin EOF doesn't kill it: `tail -f /dev/null | task dev` (see memory: dev task dev stdin EOF). Screenshot with `node scripts/cdp-shot.mjs <out>.png`.

- [ ] **Step 1: Footer renders at rest**

On the Cockpit home surface: footer shows global-only chips (`g go · ⌃P palette · ⌃N new · ? help`). Screenshot.
Switch to the Agent surface (`g a` or `Ctrl+2`): footer shows agent chips (`↑↓ move · d rail · f full · esc back · ^Tab cycle`) + globals. Screenshot.

- [ ] **Step 2: Leader morph**

Press `g`. The footer morphs into the `g →` continuation list, then reverts after selection/timeout. Confirm it replaces the rest hints in the same bar (no second bar). Screenshot mid-leader.

- [ ] **Step 3: In-terminal posture + `Shift+Esc` gate**

Focus the Claude Code terminal (click into it / it auto-focuses). Confirm the footer collapses to the muted set (`^Tab cycle · ⇧Esc leave · ⌃P palette · ⌃N new`) and dims. Confirm arrows/`d`/`f`/`g`/`?` chips are gone.
Press **`Shift+Esc`**. Confirm focus leaves the terminal (surface wrapper gains focus) and the footer restores the full agent rest hints. **This is the gate: if WebView2 swallows `Shift+Esc` (nothing happens), stop and report — fall back to a different chord or defer the return-nav binding per the spec.**
Press bare `Esc` while in the terminal beforehand to confirm it still reaches the TUI (unchanged).

- [ ] **Step 4: Record results**

Note pass/fail for each of Steps 1–3 with screenshots. If the `Shift+Esc` gate fails, do not proceed to commit the chord — surface the finding.

---

## Task 7: Commit (gated on approval)

Per the user's git workflow: show the diff summary + message and get explicit approval before committing. Batch the whole feature (and the folded spec + plan docs) into one commit.

- [ ] **Step 1: Re-check the working tree**

Run: `git status --short` and confirm branch. Reconcile the pre-existing `bindings.ts` / `bindings.test.ts` double-`^C` change per "Before you start" (commit it separately first, or include it deliberately). Do not stage the other parallel-session files (`agentdetailsrail.tsx`, `agentheader.tsx`, `filesstore.ts`, `navrail.tsx`, `railicons.tsx`, `package*.json`, `agentdiffnav*`) unless they belong to this work.

- [ ] **Step 2: Stage only this feature's files**

```bash
git add \
  docs/superpowers/specs/2026-07-06-cockpit-hints-footer-design.md \
  docs/superpowers/plans/2026-07-06-cockpit-hints-footer.md \
  frontend/app/store/keybindings/bindings.ts \
  frontend/app/store/keybindings/store.test.ts \
  frontend/app/view/agents/agentsurface.tsx \
  frontend/app/cockpit/footerhints.ts \
  frontend/app/cockpit/footerhints.test.ts \
  frontend/app/cockpit/footer-visible.ts \
  frontend/app/cockpit/footer-visible.test.ts \
  frontend/app/cockpit/hints-footer.tsx
git rm frontend/app/cockpit/whichkey-bar.tsx
git add frontend/app/cockpit/cockpit-root.tsx
```

- [ ] **Step 3: Present + commit on approval**

Show files (M/A/D) + this message, then ask "Awaiting approval. Proceed? (yes/no)":

```
feat(cockpit): always-on contextual keyboard hints footer

Replace the transient which-key bar with a persistent footer that shows
the keys that actually fire for the current surface and focus. Hints are
curated by binding id and filtered through each binding's live when(ctx),
so the footer inherits the dispatcher's posture rules and can't show a key
that wouldn't work (nav hints drop in the terminal automatically). Adds
Shift+Esc to return focus from the terminal to nav; folds the leader
continuation view into the same bar. Agent bindings moved into the registry
(bindings.ts) so the drift test has one source of truth.
```

---

## Self-review notes (author)

- **Spec coverage:** three postures (Tasks 4/5), curated-hints-by-id + drift test (Tasks 3), pure logic + tests (Task 4), fold+delete which-key bar + in-flow mount (Task 5), `buildAgentBindings` extraction reading live atoms (Task 1), `Shift+Esc` return-nav + wrapper tag (Task 2), CDP + `Shift+Esc` gate (Task 6). All spec sections map to a task.
- **Placeholder scan:** none — every code step has complete code and exact commands.
- **Type consistency:** `FooterHint`/`HintChip` defined once (footerhints.ts / footer-visible.ts) and imported; binding ids referenced in `footerhints.ts` (`agent:prev-k`, `agent:next-j`, `agent:prev`, `agent:next`, `agent:toggle-rail`, `agent:fullscreen`, `agent:back`, `cycle-agent-next`, `cycle-agent-prev`, `agent:return-nav`, `go:cockpit`, `palette`, `new-agent`, `help`) all match ids produced by `buildGlobalBindings`/`buildAgentBindings` — enforced by the Task 3 drift test.
- **Deferred (YAGNI, per spec):** row-state hints, clickable chips, hide-footer toggle, glyph↔keys consistency assertion.
```
