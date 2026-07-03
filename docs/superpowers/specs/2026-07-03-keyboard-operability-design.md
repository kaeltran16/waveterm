# Keyboard Operability — Design

- **Date:** 2026-07-03
- **Status:** Approved (brainstorm), pending implementation plan
- **Goal:** Make the cockpit fully operable from the keyboard — every action reachable without the mouse — via one unified, discoverable keybinding system.

## Goal & non-goals

**Goal.** Full keyboard operability: navigate surfaces, move focus within a surface, activate items, answer asks, and run commands entirely from the keyboard. Deliver it through a *single* keybinding registry that is the source of truth for the handlers, the help cheat sheet, and the leader which-key hint.

**Non-goals (v1, deferred — see below).**
- User-remappable bindings / `keybindings.json` config + settings UI.
- `g`+region-letter direct teleport (region movement is `Tab`-cycle only in v1).
- Multiple leader keys.

## Current state (grounded)

- **Works today, hand-rolled in `cockpit-root.tsx`** via a window-level capture-phase listener: `Ctrl+1..8` (jump to surface, positional to `SURFACE_ORDER`), `Ctrl+P` (command palette), `Ctrl+N` (new agent), `Ctrl+Tab`/`Ctrl+Shift+Tab` (cycle agents, Agent surface only), double-`Ctrl+C` (close focused agent).
- **`command-palette.tsx`** — a real fuzzy palette over commands/agents/sessions (arrow + Enter). A genuine asset; kept.
- **`keymodel.ts` is effectively dead** — `globalKeyMap` / `globalChordMap` are empty Maps (the config that populated them was stripped in the Electron→Tauri teardown). `appHandleKeyDown` is still called from the terminal (`term-model.ts:759`) but always no-ops.
- **Every surface reinvents keyboard handling** (`agentsurface`, `channelssurface`, `cockpitsurface`, … each have their own `onKeyDown`). No shared registry, no discoverability layer.

Two keyboard entry points already exist and are the hooks we reuse:
1. The **window-level capture-phase listener** fires before xterm sees a key — this is why `Ctrl+1..8`/`Ctrl+P` beat the terminal.
2. The terminal calls **`appHandleKeyDown(waveEvent)` before forwarding to the PTY** (`term-model.ts:759`); if the app claims the key, it's swallowed.

## Approach

**Unified registry that supersedes the dead `keymodel`.** One module holds an array of binding descriptors; a single React provider installs *one* window-capture dispatcher that tracks leader/chord state, evaluates each binding's `when` predicate against the current context, and runs the first match. The same binding data feeds the handlers, the `?` cheat sheet, and the leader which-key bar.

Rejected: reviving the legacy `keymodel` maps (global mutable Maps, no `when`-scope, no label metadata — fights every requirement); adopting a library (new dependency against the minimize-deps rule, still hand-build scope/which-key/cheat-sheet layers).

## Architecture

### Binding descriptor

```ts
type KeyContext = {
  surface: SurfaceKey;      // active surface from surfaceAtom
  editable: boolean;        // focus is in an input/textarea/contenteditable/terminal
  modalOpen: boolean;       // command palette or a modal is open
  leader: string | null;    // active leader prefix (e.g. "g") or null
};

type Binding = {
  id: string;
  keys: string;             // "Ctrl:1", "g a" (leader seq), "j" — reuses keyutil syntax
  group: string;            // cheat-sheet section: "Global" | "Agents" | ...
  label: string;            // human text for cheat sheet + which-key bar
  when?: (ctx: KeyContext) => boolean;   // default: always active
  run: (ctx: KeyContext) => void;
};
```

### Registration — distributed authorship, one source of truth

A jotai `bindingsAtom` holds the live union of active bindings.
- **Global bindings** register once at boot.
- **Each surface contributes its own bindings** via a `useKeybindings(bindings)` hook that adds them on mount and removes them on unmount. Surface keys live next to the surface's code.
- The cheat sheet and which-key bar are **pure consumers** of `bindingsAtom` — they define no binding data, so they are always accurate and context-aware.

### Dispatcher — one window-capture listener

Installed once in `cockpit-root` (replacing the ad-hoc listener). Evaluated in strict precedence on each keydown:

1. **Leader active?** → match only leader-sequence bindings; on miss, reset the leader and swallow the key.
2. **Global chords** (Ctrl/Alt combos; their `when` ignores `editable`) → the layer that must beat the terminal.
3. **Not editable?** → single-key bindings (`j`/`k`/`Enter`/`Tab`/surface keys).
4. **No match** → let the key through untouched (to the terminal, inputs, etc.). Only `preventDefault`/`stopImmediatePropagation` when a binding actually fires.

Leader/chord state reuses the existing `CHORD_TIMEOUT`.

### Terminal reconciliation

- The capture-phase listener fires before xterm, so global chords preempt the PTY (unchanged behavior).
- The terminal's textarea reports `editable: true`, so single-key bindings do **not** fire while typing — `j` types `j`.
- Route the existing `term-model.ts:759` `appHandleKeyDown` seam into the same dispatcher (one code path); **delete the dead `globalKeyMap`/`globalChordMap`**.
- The terminal keeps its own keys (`Ctrl+Shift+C` copy, `Cmd+K` clear); the registry must not bind those globally.

## Discoverability

- **Which-key bar** — transient, bottom-anchored, full-width, one line (e.g. `g →  a Agent  f Files  u Usage  p Palette`). Appears when the dispatcher enters leader state; reads `bindingsAtom` filtered to bindings whose keys start with the active leader and whose `when` matches the current context (only shows keys that will actually work). Dismisses on a matching key, `Esc`, chord timeout, or focus change.
- **Cheat-sheet modal** — centered modal reusing the command-palette overlay pattern; rows grouped by `group`, each rendering the key as `kbd` chips next to its label, current surface's group first, with a filter input.
- **`?` is a normal character**, so it opens the cheat sheet **only when `!editable`**. For the typing case (e.g. focus in the terminal), the command palette gains a "Keyboard shortcuts" entry that opens the same modal — same modal, two doors, no stolen keystrokes.

## Focus & navigation within a surface

**Regions + roving cursor + visible focus ring.** Each surface is a small set of regions (Agents: agent list · transcript · composer; Files: file list · diff; Channels: rail · messages · composer). Exactly one region is active, marked by a visible focus ring; inside it a cursor highlights the current item (generalizes the Agents triage cursor).

- **Move within a region:** `j`/`k` (+ arrows) move the cursor; `Enter` activates it.
- **Jump between regions:** `Tab` / `Shift+Tab` cycle to the adjacent region (when `!editable`).

**Posture model — implicit, no global mode flag.** The two postures fall out of the `editable` context flag:
- **Navigate posture** (focus on a region, not editable): single keys drive the cursor.
- **Type posture** (focus in composer/terminal/search, editable): keys type normally; `Esc` blurs back to the region cursor.

"Get back to navigating" is just `Esc`; "start typing" is `Enter`/`r` on the composer region — vim insert/normal muscle memory with zero mode state to track. The terminal keeps its own internal modality untouched; while focused, you're simply in type posture.

**Focus ring styling:** a prominent ring/outline on the active region + highlighted cursor row, reusing accent `@theme` tokens (must be prominent to replace the mouse).

## Default keymap

Surface order is `SURFACE_ORDER`: `cockpit, agent, activity, channels, sessions, files, memory, usage` (+ `settings`, pinned separately in the NavRail). `Ctrl+1..8` map positionally to the first eight.

| Layer | Keys | Action |
|---|---|---|
| **Global chords** (work even in terminal) | `Ctrl+1..8` | jump to surface N *(existing)* |
| | `Ctrl+P` | command palette *(existing)* |
| | `Ctrl+N` | new agent *(existing)* |
| | `Ctrl+Tab` / `Ctrl+Shift+Tab` | cycle agents (Agent surface) *(existing)* |
| | double `Ctrl+C` | close focused agent *(existing)* |
| **Leader `g`** ("go", when `!editable`) | `g h` | Cockpit (home) |
| | `g a` | Agent |
| | `g v` | Activity |
| | `g c` | Channels |
| | `g s` | Sessions |
| | `g f` | Files |
| | `g m` | Memory |
| | `g u` | Usage |
| | `g ,` | Settings |
| | `g p` | command palette |
| **Region nav** (when `!editable`) | `Tab` / `Shift+Tab` | cycle regions within surface |
| | `j` / `k` / arrows | move cursor in active region |
| | `Enter` | activate cursor item |
| | `Esc` | leave type posture → back to region cursor |
| **Per-surface** (when `!editable`; consolidates existing triage) | Agents: `r` reply · `t` terminal · `/` filter | |
| | Files: `Enter` open diff · `a` accept · `r` reject (Review mode) · `/` filter | |
| **Help** | `?` (when `!editable`) or palette entry | open cheat sheet |

Leader letters are collision-free (activity→`v`, sessions→`s`, settings→`,`). `Ctrl+1..8` and the `g` leader both reach the main surfaces (positional vs. mnemonic) — intentional redundancy.

## File layout

```
frontend/app/store/keybindings/
  types.ts        — Binding, KeyContext
  store.ts        — bindingsAtom + useKeybindings() + global bindings
  dispatcher.ts   — window-capture state machine (leader/chord + precedence)
  context.ts      — derives KeyContext (surfaceAtom, activeElement, modal atoms)
frontend/app/cockpit/
  whichkey-bar.tsx         — transient bottom bar
  shortcuts-cheatsheet.tsx — the ? modal
```

Delete the dead `globalKeyMap`/`globalChordMap` from `keymodel.ts`; route its `appHandleKeyDown` seam into the dispatcher.

## Phasing (ships incrementally)

1. **Foundation** — engine (`bindingsAtom`, dispatcher, `useKeybindings`, `context`), migrate the existing global chords into it, delete dead `keymodel` maps, add the region/focus-ring primitive + which-key bar + cheat sheet.
2. **Agents surface** (most-used) — consolidate existing triage keys into registry bindings; add the region model.
3. **Files, then Channels** — region + action keys.
4. **Read-mostly surfaces** (Usage / Activity / Memory / Settings / Sessions) — cursor + `Enter`.

## Testing

- **Unit (vitest, the meat):** dispatcher precedence, leader/chord state machine, `when` evaluation, `bindingsAtom` register/unregister — all pure logic.
- **Conflict invariant test:** scan the registry, assert no two bindings that can be active in the same context share the same keys. Guardrail against silent collisions as coverage grows.
- **CDP visual** (project convention, no jsdom harness): which-key bar, cheat sheet, focus ring on the live dev app.

## Deferred / YAGNI

- **Remappable bindings** (`keybindings.json` + settings UI). The registry is designed so config overrides could layer on later without reshaping it.
- **`g`+region-letter teleport** — region movement is `Tab`-cycle only (surfaces have 2–3 regions; letter-teleport would collide with surface initials on the `g` leader).
- **Multiple leaders** — one `g` ("go") leader, always shown by which-key.

## Reference

A standalone, dev/user-facing shortcut table lives at [`docs/keyboard-shortcuts.md`](../../keyboard-shortcuts.md) and should be kept in sync with the registry as coverage grows.
