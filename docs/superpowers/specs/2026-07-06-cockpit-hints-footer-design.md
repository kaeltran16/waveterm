# Cockpit hints footer — always-on contextual keyboard guidance

**Date:** 2026-07-06
**Status:** Design approved, pre-plan
**Surface:** Cockpit (all surfaces)

## Problem

The cockpit already has a solid keyboard foundation (unified registry, `g`-leader
teleports, per-surface bindings, `Ctrl+P` palette, `Shift+?` cheat sheet). The one
piece of *ambient* guidance — the which-key bar (`whichkey-bar.tsx`) — is **transient**:
it only appears while a `g` leader sequence is mid-flight, then vanishes. At rest the
user gets no reminder of what keys do anything on the current surface.

Goal: turn that transient bar into an **always-on, context-aware footer** that shows
the most useful keys for wherever the user is, and that can never lie about what a key
does.

## Non-goals (v1)

- **Row-state hints** (e.g. show `a answer` when the focused agent is asking). The
  architecture leaves this open for free (see "Future"), but nothing is built.
- **Clickable hint chips.** Display-only in v1.
- **Hide-footer toggle / preference.** The user asked for always-on; a pref atom is a
  trivial later add if wanted.

## Decisions (from brainstorming)

1. **Always-on contextual footer** replaces the transient which-key bar. One bar, three
   postures.
2. **Curated hints reference binding ids** (not a `hint` field on every binding, not
   standalone tables). Presentation lives in one small file; a unit test ties every
   reference back to a real binding so it can't drift.
3. **In-terminal posture is emergent**, not special-cased: the footer filters each
   curated hint through the referenced binding's live `when(ctx)`, so keys that wouldn't
   fire simply don't appear.
4. **`Shift+Esc` returns focus from the terminal to nav** (in-terminal posture only).
   Bare `Esc` still reaches the Claude Code TUI. Must be CDP-verified that WebView2
   delivers `Shift+Esc`.

## Behavior — one bar, three postures

The footer is a single thin (~28px) bar pinned at the bottom of the cockpit, always
mounted. What it renders is driven by the live `KeyContext`:

| Posture | Trigger | Shows |
|---|---|---|
| **Rest** | on a surface, not typing | that surface's hints + global hints. On **agent**: `↑↓ move · d rail · f full · esc back · ^Tab cycle · g go · ⌃P palette · ⌃N new · ? help`. On every **other** surface (incl. Cockpit home): global only — `g go · ⌃P palette · ⌃N new · ? help`. |
| **In-terminal** | focus in the Claude TUI (`ctx.editable`) | only chords that survive `editable`, dimmed: `^Tab cycle · ⇧Esc leave · ⌃P palette · ⌃N new`. Surface nav (arrows, `d`, `f`, `esc`, `g`, `?`) auto-drops. |
| **Leader** | `activeLeaderAtom != null` (e.g. after `g`) | the continuation list — today's which-key content, folded into this bar |

> **Finding (grounds the tables):** only the **agent** surface registers surface-specific
> bindings (`useKeybindings` in `agentsurface.tsx`). The Cockpit home grid, activity,
> channels, sessions, files, memory, usage, and settings have *no* surface bindings — so
> their honest footer is global-only. Rich per-surface hints elsewhere (e.g. Cockpit grid
> `↑↓/⏎`) are a follow-up: add the bindings, add one `FooterHint` entry, and they light up
> for free. `close-agent` (`^C^C`) is intentionally **omitted** from the footer — its
> run-time `inTerm` guard means it wouldn't fire at rest, so showing it would mislead.

**Modal open:** no special handling needed. Modals (`Ctrl+P` palette, `Shift+?` cheat
sheet) are fixed overlays that cover the in-flow footer, and surface hints already carry a
`!modalOpen` guard so they filter out anyway. The cheat sheet *is* the full reference.

**Key property:** in-terminal and rest are the *same code path*. The footer renders a
curated hint only if at least one of its referenced bindings is currently active
(`when(ctx)` passes). In the terminal the surface hints' guard (`!editable`) fails, so
they drop automatically and only global chords remain. One filter rule, three postures.
The footer therefore inherits the exact posture logic the dispatcher already enforces —
it can never show a key that wouldn't fire.

## Architecture

### New: `frontend/app/cockpit/footerhints.ts`

The presentation source of truth. Per-surface curated tables plus a `global` list.

```ts
export interface FooterHint {
    ids: string[];   // binding ids this chip stands for (>=1)
    glyph: string;   // terse key display, e.g. "↑↓", "⏎", "⌘P"
    label: string;   // terse action, e.g. "move", "open"
}

// global hints appended to every surface, filtered by live when(ctx)
export const GLOBAL_HINTS: FooterHint[] = [ /* palette, new, go, help, ... */ ];

// per-surface hints, keyed by SurfaceKey
export const SURFACE_HINTS: Partial<Record<SurfaceKey, FooterHint[]>> = {
    agent: [
        { ids: ["agent:prev-k", "agent:next-j", "agent:prev", "agent:next"], glyph: "↑↓", label: "move" },
        { ids: ["agent:toggle-rail"], glyph: "d", label: "rail" },
        { ids: ["agent:fullscreen"], glyph: "f", label: "full" },
        { ids: ["agent:return-nav"], glyph: "⇧Esc", label: "leave" },
        // ...
    ],
    // cockpit, activity, channels, ...
};
```

Binding ids referenced here come from `bindings.ts` (`buildGlobalBindings`) and the
per-surface `useKeybindings` registrations (currently only `agentsurface.tsx`).

### New: `frontend/app/cockpit/footer-visible.ts` (pure logic)

Mirrors the `matcher.ts` pattern: a pure function, no DOM/atoms, unit-testable.

```ts
// Given the live ctx + registry + hint tables, return the ordered chips to render.
export function visibleHints(
    ctx: KeyContext,
    bindings: Binding[],
    surfaceHints: FooterHint[],
    globalHints: FooterHint[]
): { glyph: string; label: string }[];
```

Rules:
- A hint is shown iff at least one referenced binding exists in `bindings` **and** its
  `when(ctx)` passes (default-true if no `when`).
- Surface hints first, then global hints; de-dupe if the same id appears in both.
- Leader posture is handled in the component (it reads `activeLeaderAtom` and shows
  continuations from the registry, reusing today's which-key filter) — not through this
  function.

### New: `frontend/app/cockpit/hints-footer.tsx`

Replaces `whichkey-bar.tsx` (deleted). Reads:
- `surfaceAtom`, `activeLeaderAtom`, `bindingsAtom` (reactive), and
- `editable`, tracked via `focusin`/`focusout` window listeners.

**Why the focus listeners:** `deriveKeyContext()` reads `document.activeElement` for
`editable`, which is *not* jotai-reactive. Entering/leaving the terminal fires
`focusin`/`focusout` but changes no atom, so the footer must listen for those events and
recompute. This is the one non-obvious bit of wiring; everything else is reactive off
existing atoms.

Render:
- Leader posture (`activeLeaderAtom != null`): show `<leader> → <continuations>` from the
  registry (port `whichkey-bar.tsx`'s existing filter verbatim).
- Otherwise: `visibleHints(ctx, ...)` → chips. Dim the whole bar when `ctx.editable`.

Styling reuses the current which-key chip look (`border-edge-mid`, `font-mono`, the same
`text-[10.5px]` chip / `text-[12px]` label sizes). **Theme tokens only** — no raw
hex/rgba, no new SCSS (Tailwind `@theme` per project convention).

### Edit: `frontend/app/cockpit/cockpit-root.tsx`

- Mount `<HintsFooter/>` in the layout flow, after `<CockpitShell/>` in the flex column,
  so it reserves ~28px and never overlays content. Remove the old `fixed bottom-0`
  `<WhichKeyBar/>` overlay and its import.

### Edit: `frontend/app/store/keybindings/bindings.ts` — extract agent bindings + add return-to-nav

**Consolidate binding definitions.** Today the agent-surface bindings are built *inside*
`agentsurface.tsx` (in a `useMemo` closing over `order`/`agent`, rebuilt+re-registered on
every focus change). Extract them into a stable `buildAgentBindings(model)` in
`bindings.ts`, next to `buildGlobalBindings`. Two wins:

- **Testability/consistency:** the drift test imports both builders from one module and
  has the full id universe. All binding *definitions* live in `bindings.ts`; components
  just register the subset they own.
- **Less churn:** `run()` reads live state from atoms
  (`globalStore.get(model.orderAtom)`, `model.focusIdAtom`) instead of closing over
  build-time values, so the array is stable — no rebuild/re-register on every focus
  change. Behavior-preserving: `focusIdAtom` is already synced to the resolved focused
  agent (`agentsurface.tsx:46`), so reading it live equals today's `agent.id`.

`agentsurface.tsx` then just does `useKeybindings(useMemo(() => buildAgentBindings(model), [model]))`.

Add the return-to-nav chord as one of the agent bindings (all agent bindings in one
place):

```ts
{
    id: "agent:return-nav",
    keys: "Shift:Escape",
    group: "Agent",
    label: "Return focus to nav",
    when: (ctx) => ctx.surface === "agent" && ctx.editable, // only while the TUI owns focus
    run: () => {
        (document.activeElement as HTMLElement | null)?.blur?.();
        // focus the surface wrapper so ↑↓/j/k/d/f resume; the wrapper already has tabIndex=0
        document.querySelector<HTMLElement>("[data-cockpit-surface-wrap]")?.focus();
    },
}
```

`agentsurface.tsx`'s wrapper div gains `data-cockpit-surface-wrap` so the chord can
refocus it. Bare `Esc` is unchanged — it still reaches the TUI because `agent:back` stays
guarded by `!editable`.

### New: `frontend/app/cockpit/footerhints.test.ts` (drift guard)

- Build the full id set: `buildGlobalBindings(model)` ids ∪ `buildAgentBindings(model)`
  ids (both imported from `bindings.ts`), using a lightweight fake `AgentsViewModel`.
- Assert every `id` referenced in `GLOBAL_HINTS` and `SURFACE_HINTS` exists in that set.
- Renaming/removing a binding id → this test fails → build fails. No silent lying footer.
- **Optional, deferred:** also assert each hint's `glyph` letters match the referenced
  binding's `keys` (catches a rebind that leaves the glyph stale). YAGNI for v1 — ids
  churn, glyphs don't.

### New: `frontend/app/cockpit/footer-visible.test.ts`

Unit-test `visibleHints` across the three postures with a synthetic registry + ctx:
- rest on `agent` → surface + global chips present;
- `editable: true` → surface chips gone, only global-surviving chips remain, `⇧Esc leave`
  present;
- a hint whose referenced id is absent → not shown.

## Data flow

```
focusin/focusout ─┐
surfaceAtom ──────┤
activeLeaderAtom ─┼─▶ HintsFooter ──▶ deriveKeyContext() ──▶ visibleHints(ctx, bindings, …)
bindingsAtom ─────┘                         │                        │
                                            └── leader? ── port whichkey filter
```

## Testing

- `footer-visible.test.ts` — pure posture logic (no DOM).
- `footerhints.test.ts` — drift guard (referenced ids exist).
- Existing keybinding tests (`matcher`, `store`, `bindings`) untouched and still green.
- **CDP visual/behavior check on the live dev app** (per CLAUDE.md — no jsdom render
  harness):
  1. Footer renders at rest on Cockpit and Agent surfaces with the right chips.
  2. Pressing `g` morphs the footer into the leader list, then reverts.
  3. Focusing the terminal collapses to the muted global set; `Shift+Esc` returns focus
     to nav and restores full hints. **This confirms WebView2 delivers `Shift+Esc`** — a
     gating check; if it's swallowed, fall back to a different chord or defer the chord.

## Future (free extensions, not in v1)

- **Row-state hints:** register an "answer" binding whose `when` checks the focused
  agent's state, add one `FooterHint` entry — it appears automatically via the same
  filter. No footer changes needed.
- **Clickable chips:** the chip already knows its binding id(s); a click could run the
  binding's `run(ctx)`.
- **Hide-footer pref:** one atom + one guard in `cockpit-root.tsx`.

## Files touched

| File | Change |
|---|---|
| `frontend/app/cockpit/footerhints.ts` | new — curated hint tables |
| `frontend/app/cockpit/footer-visible.ts` | new — pure posture/filter logic |
| `frontend/app/cockpit/hints-footer.tsx` | new — the footer component (replaces which-key bar) |
| `frontend/app/cockpit/footerhints.test.ts` | new — drift guard |
| `frontend/app/cockpit/footer-visible.test.ts` | new — posture unit tests |
| `frontend/app/cockpit/whichkey-bar.tsx` | deleted — folded into the footer |
| `frontend/app/cockpit/cockpit-root.tsx` | edit — mount footer in flow, drop overlay |
| `frontend/app/store/keybindings/bindings.ts` | edit — extract `buildAgentBindings`, add `agent:return-nav` (`Shift+Esc`) |
| `frontend/app/view/agents/agentsurface.tsx` | edit — register `buildAgentBindings`; `data-cockpit-surface-wrap` on wrapper |
