# Shared modals motion — Design

Date: 2026-07-03
Surface: **Shared modals** (the app's overlay dialogs), the second surface of the app-wide animation
revamp (`docs/superpowers/animation-revamp-tracker.md`). Reuses the cockpit motion tokens
(`frontend/app/element/motiontokens.ts`); adds one new backdrop token and one shared shell.

## Problem

Every modal in the app is a hard cut: it snaps in and snaps out. There is no exit at all — the four
cockpit overlays each `if (!open) return null`, so closing is instantaneous. This reads as abrupt against a
cockpit that now moves with intent (`b3ccce07`).

Two modal families exist, and neither animates:

1. **Cockpit overlays** (`NewProjectModal`, `NewAgentModal`, `CommandPalette`, `ShortcutsCheatSheet`) —
   hand-rolled, each driven by its own jotai visibility atom. They **duplicate identical scaffolding**: the
   `fixed inset-0 z-[70] … bg-black/60 backdrop-blur-sm` backdrop, the `rounded-[14px] border
   border-edge-strong bg-modalbg shadow-popover` panel, a window Esc listener, and (for two of them) a
   backdrop-click close. Four copies of the same wrapper.
2. **Generic stack** (`ConfirmModal`, `MessageModal`, `UserInputModal`) — all render through the shared
   `FlexiModal`/`Modal` base (`frontend/app/modals/modal.tsx`), which `ReactDOM.createPortal`s into `#main`
   and is styled by `modal.scss`. Mounted/unmounted by array membership in `ModalsRenderer`
   (`pushModal`/`popModal`) — there is no `open` prop and thus no "closing" render.

The duplication in family 1 is both the problem and the opportunity: a single motion shell removes the 4×
boilerplate **and** adds motion in one place.

## North star (inherited from the revamp)

**Motion is functional first: it must make a state change more legible.** A modal opening/closing is a
context switch — the panel arriving over a dimmed app tells you "you are now in a focused sub-task"; its
leaving returns you. The motion makes that switch legible instead of a jump-cut. No decorative flourish.

## Locked decisions (from the brainstorm)

- **Scope = both families.** The four cockpit overlays (via a shared `ModalShell`) **and** the generic
  `FlexiModal` stack. **Settings is excluded** — it is a *surface* (`settingssurface.tsx`, a `SurfaceKey`),
  not a modal, and gets motion in the Cross-surface transitions row. **WhichKeyBar is excluded** — it is a
  transient leader-key hint bar, not a modal.
- **Feel.** Backdrop scrim **cross-fades** (opacity only); `backdrop-blur` stays **static** (animating
  `backdrop-filter` is a perf trap). Panel uses **scale + fade** reusing the cockpit card entrance signature
  (`cardVariants`: `opacity 0→1`, `scale 0.97→1`; exit `→0.96`) — no directional drift, per the
  "reuse the vocabulary, no new per-surface primitives" rule.
- **Framer Motion** (`motion/react`, v12) is the tool, as on the cockpit. Durations/easing come from the
  existing `MOTION` tokens (`durMacro` 0.36, `durMicro` 0.14, `durExit` 0.28, `easeFluid`).
- **Single source of truth for feel.** Both shells consume the same tokens. The two styling *bases* (Tailwind
  cockpit shell vs. SCSS/portal `FlexiModal`) stay separate — unifying them is a larger refactor with no
  motion payoff (YAGNI).

## The moments (mapped to the vocabulary)

| Moment | Where | Mechanic |
|---|---|---|
| **Modal open** | both families | Backdrop `modalBackdrop` fade (`durMicro`) + panel `modalPanel` scale/fade (`durMacro`), under `AnimatePresence`. |
| **Modal close** | both families | Backdrop + panel `exit` variants (`durExit`) — the motion that does not exist today. `AnimatePresence` keeps the node mounted until exit completes. |

This is the tracker's moment **#6 (inline reveal)** generalized to overlays: the reveal primitive is a
centered panel entrance rather than a height expand, but the intent (a panel arrives/leaves legibly) is the
same. It composes moment **#1**'s panel signature (`cardVariants`) with a new backdrop fade.

## Architecture

### 1. Motion tokens — `frontend/app/element/motiontokens.ts`

Add one genuinely-new token; reuse the card signature for the panel so feel stays single-sourced:

```ts
// Modal open/close (shared-modals surface). Scrim cross-fades; blur is static (animating
// backdrop-filter is a perf trap). Panel reuses the card entrance signature (moment 1).
export const modalBackdrop: Variants = {
    initial: { opacity: 0 },
    animate: { opacity: 1, transition: { duration: MOTION.durMicro, ease: MOTION.easeFluid } },
    exit:    { opacity: 0, transition: { duration: MOTION.durExit,  ease: MOTION.easeFluid } },
};
export const modalPanel = cardVariants; // panel reuses moment 1's opacity+scale signature
```

`modalPanel` is an explicit alias (greppable, self-documenting) rather than a copy — decoupling it into its
own values would duplicate the feel for no benefit today.

### 2. `ModalShell` — new, `frontend/app/modals/modalshell.tsx`

The shared primitive for the four cockpit overlays. Owns the backdrop, panel, `AnimatePresence`,
`MotionConfig`, the Esc listener, and the optional backdrop dismiss.

```tsx
interface ModalShellProps {
    open: boolean;
    onClose: () => void;              // Esc + (optional) backdrop click
    className?: string;               // panel width / max-height, per modal
    topClass?: string;                // backdrop top offset; default "pt-[11vh]"
    dismissOnBackdrop?: boolean;      // default true
    children: React.ReactNode;
}
```

```tsx
<MotionConfig reducedMotion="user">
  <AnimatePresence>
    {open && (
      <motion.div variants={modalBackdrop} initial="initial" animate="animate" exit="exit"
        className={cn("fixed inset-0 z-[70] flex items-start justify-center bg-black/60 backdrop-blur-sm", topClass)}
        onMouseDown={dismissOnBackdrop ? onBackdrop : undefined}>
        <motion.div variants={modalPanel} role="dialog" aria-modal="true" onMouseDown={(e) => e.stopPropagation()}
          className={cn("overflow-hidden rounded-[14px] border border-edge-strong bg-modalbg shadow-popover", className)}>
          {children}
        </motion.div>
      </motion.div>
    )}
  </AnimatePresence>
</MotionConfig>
```

- The backdrop and panel inherit `initial`/`animate`/`exit` from the parent `motion.div`'s `variants`, so a
  single `variants` per element drives all three states.
- The Esc listener is a `useEffect` gated on `open` (replacing the four per-modal copies).
- `onBackdrop` closes only when `e.target === e.currentTarget` (click landed on the scrim, not the panel);
  the panel's `stopPropagation` is a belt-and-suspenders guard.

### 3. Refactor the four overlays onto `ModalShell`

Each overlay keeps all its hooks and logic and changes only its return. Remove: the outer backdrop `<div>`,
the panel `<div>`, the Esc `useEffect`, and `if (!open) return null`. Return:

```tsx
return (
  <ModalShell open={open} onClose={close} className="…" topClass="…" dismissOnBackdrop={…}>
    {open ? (/* existing body JSX */) : null}
  </ModalShell>
);
```

The `open ? body : null` guard preserves today's behavior of **not building the body tree while closed**
(matters for `NewAgentModal`'s large tree, which re-renders on unrelated atom changes). On close,
`AnimatePresence` replays the **cached** panel element for the exit, so the guard does not break the leave
animation.

Per-modal props (preserving current look and dismiss behavior **exactly**):

The shared panel base is `overflow-hidden rounded-[14px] border border-edge-strong bg-modalbg shadow-popover`
(matching `NewProjectModal` exactly). The three overlays with an internal scroll region add `flex flex-col`
in their `className`; `NewProjectModal` (a short block) does not.

| Overlay | `className` (panel) | `topClass` | `dismissOnBackdrop` |
|---|---|---|---|
| `CommandPalette` | `flex flex-col w-[min(640px,93vw)] max-h-[70vh]` | `pt-[11vh]` (default) | `true` |
| `ShortcutsCheatSheet` | `flex flex-col w-[min(680px,93vw)] max-h-[74vh]` | `pt-[10vh]` | `true` |
| `NewAgentModal` | `flex flex-col w-[min(640px,93vw)] max-h-[86vh]` | `pt-[11vh]` (default) | **`false`** |
| `NewProjectModal` | `w-[min(480px,92vw)]` | `pt-[14vh]` | **`false`** |

`CommandPalette` keeps its `onKeyDown` arrow/enter handling on the input; only its `Escape` branch is dropped
(delegated to `ModalShell`). `ShortcutsCheatSheet` drops its backdrop `onMouseDown`/`onKeyDown` (delegated).

### 4. Generic stack — `FlexiModal`/`Modal` + `ModalsRenderer`

- `modal.tsx`: `.modal-backdrop` `<div>` → `motion.div` with `variants={modalBackdrop}`; `.modal` panel
  `<div>` → `motion.div` with `variants={modalPanel}`; both `initial="initial" animate="animate"
  exit="exit"`. Keep the existing `modal.scss` classes for layout/appearance — motion only adds transform/
  opacity. Applies to both `Modal` and `FlexiModal` (Confirm/Message/UserInput all route through them).
- `ModalsRenderer`: wrap the `.map` in `<MotionConfig reducedMotion="user"><AnimatePresence initial={false}>
  … </AnimatePresence></MotionConfig>` with a **stable key per modal** (e.g. `displayName + index`), so a
  `popModal` keeps the item mounted and plays the exit before unmounting.
- **Presence across the portal:** `FlexiModal` portals into `#main`, but React context (including
  `AnimatePresence`'s presence context) propagates through portals, so the portaled panel receives the exit
  signal. This is the one path with real uncertainty — it is a CDP-verify gate (see Testing).

## Edge cases

- **Reduced motion.** `reducedMotion="user"` (both shells) makes Framer keep opacity and drop scale/transform
  — reduced-motion users get a clean cross-fade with no zoom. No CSS-side loops are involved here.
- **No entrance cascade.** `AnimatePresence initial={false}` — anything already open at first render does not
  animate in; only modals opened after mount animate. (For modals typically nothing is open at mount, so this
  is harmless but on-brand.)
- **Don't build the body while closed.** The `open ? body : null` guard in each overlay (§3) preserves the
  current short-circuit; `AnimatePresence` caching covers the exit.
- **Focus.** `ModalShell` does not manage focus; overlays keep their own `autoFocus`/`inputRef` focus logic
  unchanged.
- **Double Esc.** `ModalShell` owns a window Esc listener; `CommandPalette`'s input `Escape` branch is
  removed to avoid two closes (close is idempotent regardless).

## Files touched (all frontend; no `task generate`, no backend/RPC)

| File | Change |
|---|---|
| `frontend/app/element/motiontokens.ts` | Add `modalBackdrop`; add `modalPanel = cardVariants` alias. |
| `frontend/app/element/motiontokens.test.ts` | Assert `modalBackdrop` values (micro in / exit out, ease) and `modalPanel === cardVariants`. |
| `frontend/app/modals/modalshell.tsx` | **New.** The shared cockpit-overlay shell. |
| `frontend/app/view/agents/newagentmodal.tsx` | Return via `ModalShell` (`dismissOnBackdrop={false}`); drop scaffolding + Esc + null-return. |
| `frontend/app/view/agents/newprojectmodal.tsx` | Return via `ModalShell` (`pt-[14vh]`, `dismissOnBackdrop={false}`); drop scaffolding + Esc + null-return. |
| `frontend/app/cockpit/command-palette.tsx` | Return via `ModalShell`; drop scaffolding; drop input `Escape` branch. |
| `frontend/app/cockpit/shortcuts-cheatsheet.tsx` | Return via `ModalShell` (`pt-[10vh]`); drop scaffolding + backdrop handlers. |
| `frontend/app/modals/modal.tsx` | `Modal` + `FlexiModal`: backdrop/panel → `motion.div` with the shared variants. |
| `frontend/app/modals/modalsrenderer.tsx` | Wrap map in `MotionConfig` + `AnimatePresence initial={false}` with stable keys. |

## Testing / verification

- **Unit (`npx vitest run`):** `modaltokens` additions — `modalBackdrop.animate` uses `durMicro`,
  `modalBackdrop.exit` uses `durExit`, ease is `easeFluid`; `modalPanel === cardVariants`. (Animation itself
  is not unit-testable — no jsdom render harness for the cockpit, per CLAUDE.md.)
- **Typecheck:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (baseline clean).
- **Visual (CDP, per CLAUDE.md):** open/close each of the four overlays (backdrop fade + panel scale, exit on
  close), confirm backdrop-dismiss only where enabled (Palette/Cheatsheet dismiss; New Agent/New Project do
  not), Esc closes all four; trigger a generic dialog (e.g. the Agent header's "Close terminal" confirm) and
  confirm the **portaled** `FlexiModal` animates open **and exits** on close; emulate
  `prefers-reduced-motion` and confirm the scale drops while the fade remains.

## Non-goals

- **Settings** (a surface) and **cross-surface tab transitions** — separate tracker rows.
- **WhichKeyBar** — transient hint bar, not a modal.
- Unifying the two modal styling bases (`ModalShell` vs `FlexiModal`) — no motion payoff (YAGNI).
- Any change to modal *logic* (validation, RPC calls, focus, keyboard nav) — motion only.

## Open questions (resolve in the plan / CDP pass, not blocking)

- **Portal + `AnimatePresence` exit robustness.** If the presence signal does not cross the portal cleanly in
  WebView2, fall back to giving the generic stack its own local `AnimatePresence` inside `FlexiModal` driven
  by an internal `open` state that `ModalsRenderer` toggles before removal. Decide during the CDP pass.
- **Command-palette snappiness.** If `durMacro` (360ms) feels sluggish for `Ctrl+P`, the panel could use
  `durMicro` for its scale while keeping the shared variant for others — decide by feel during CDP; default
  is the shared token (no special-casing).

## Commit note

Per repo convention this spec + its plan fold into the feature commit, not a separate docs-only commit;
nothing is committed without explicit approval. Only my own files are staged (the working tree carries
unrelated fill-columns work from a parallel session).
