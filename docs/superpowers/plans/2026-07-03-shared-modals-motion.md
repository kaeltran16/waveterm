# Shared modals motion — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every modal in the app a legible open/close motion (backdrop cross-fade + panel scale-fade) by adding two motion tokens, one shared `ModalShell` for the four cockpit overlays, and motion on the generic `FlexiModal`/`Modal` base.

**Architecture:** Reuse the cockpit motion tokens (`motiontokens.ts`); add a `modalBackdrop` fade token and a `modalPanel = cardVariants` alias. Introduce `ModalShell` (backdrop + panel + `AnimatePresence` + `MotionConfig` + Esc + optional backdrop dismiss) and refactor the four hand-rolled overlays onto it. Animate the generic stack by making `FlexiModal`/`Modal` render `motion.div`s and wrapping `ModalsRenderer` in `AnimatePresence`.

**Tech Stack:** React 19, Framer Motion (`motion/react` v12), Tailwind 4, jotai, vitest.

**Spec:** `docs/superpowers/specs/2026-07-03-shared-modals-motion-design.md`

**Git note (user workflow — STRICT):** Do **not** commit per task. Each task ends with a verification checkpoint (typecheck / tests). A single approval-gated commit happens in Task 8. When staging, add **only** the files this plan touches — the working tree carries unrelated fill-columns work from a parallel session (`cockpitsurface.tsx`, `agentrow.tsx`, `agentsviewmodel.ts`, `agentfilters.test.ts`); never `git add -A`.

**Verification reality:** There is no jsdom render harness for the cockpit UI (per `CLAUDE.md`). Only the token module is unit-tested (Task 1). Every other task is verified by typecheck (`node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`) and the CDP visual pass in Task 8.

**Typecheck command (used throughout):**
```bash
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit
```
Expected: exit 0 (baseline is clean — any error printed is yours).

---

### Task 1: Motion tokens (`modalBackdrop`, `modalPanel`)

**Files:**
- Modify: `frontend/app/element/motiontokens.ts`
- Test: `frontend/app/element/motiontokens.test.ts`

- [ ] **Step 1: Write the failing test**

Add these two `it` blocks inside the `describe("motiontokens", …)` in `frontend/app/element/motiontokens.test.ts`, and add `modalBackdrop, modalPanel` to the import on line 5 (`import { MOTION, cardVariants, modalBackdrop, modalPanel, shouldFadeEntry } from "./motiontokens";`):

```ts
it("modal backdrop cross-fades: micro in, exit out, fluid ease", () => {
    expect((modalBackdrop.initial as { opacity: number }).opacity).toBe(0);
    expect((modalBackdrop.animate as any).opacity).toBe(1);
    expect((modalBackdrop.animate as any).transition.duration).toBeCloseTo(MOTION.durMicro);
    expect((modalBackdrop.exit as any).transition.duration).toBeCloseTo(MOTION.durExit);
    expect((modalBackdrop.animate as any).transition.ease).toEqual(MOTION.easeFluid);
});

it("modal panel reuses the card entrance signature (single source of feel)", () => {
    expect(modalPanel).toBe(cardVariants);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
npx vitest run frontend/app/element/motiontokens.test.ts
```
Expected: FAIL — `modalBackdrop`/`modalPanel` are not exported (import error / undefined).

- [ ] **Step 3: Add the tokens**

In `frontend/app/element/motiontokens.ts`, after the `cardVariants` export (after line 22), add:

```ts
// Modal open/close (shared-modals surface). Scrim cross-fades; blur is static (animating
// backdrop-filter is a perf trap). Panel reuses the card entrance signature (moment 1).
export const modalBackdrop: Variants = {
    initial: { opacity: 0 },
    animate: { opacity: 1, transition: { duration: MOTION.durMicro, ease: MOTION.easeFluid } },
    exit: { opacity: 0, transition: { duration: MOTION.durExit, ease: MOTION.easeFluid } },
};

// Panel reuses moment 1's opacity+scale signature — one source of feel for cards and modals.
export const modalPanel = cardVariants;
```

- [ ] **Step 4: Run the test to verify it passes**

Run:
```bash
npx vitest run frontend/app/element/motiontokens.test.ts
```
Expected: PASS (all `motiontokens` tests green, including the two new ones).

- [ ] **Step 5: Typecheck checkpoint**

Run the typecheck command. Expected: exit 0.

---

### Task 2: `ModalShell` component

**Files:**
- Create: `frontend/app/modals/modalshell.tsx`

No unit test (no render harness — see plan header). Verified by typecheck here + CDP in Task 8.

- [ ] **Step 1: Create the component**

Create `frontend/app/modals/modalshell.tsx` with exactly:

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Shared shell for the cockpit overlays (New Agent, New Project, Command Palette, Keyboard shortcuts).
// Owns the backdrop scrim, the panel, open/close motion (AnimatePresence + motiontokens), the Esc
// listener, and the optional backdrop-click dismiss. Reduced-motion drops the scale, keeps the fade.

import { modalBackdrop, modalPanel } from "@/app/element/motiontokens";
import { cn } from "@/util/util";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { useEffect, type ReactNode } from "react";

interface ModalShellProps {
    open: boolean;
    onClose: () => void; // Esc + (optional) backdrop click
    className?: string; // panel width / max-height, per modal
    topClass?: string; // backdrop top offset; default pt-[11vh]
    dismissOnBackdrop?: boolean; // default true
    children: ReactNode;
}

export function ModalShell({
    open,
    onClose,
    className,
    topClass = "pt-[11vh]",
    dismissOnBackdrop = true,
    children,
}: ModalShellProps) {
    useEffect(() => {
        if (!open) {
            return;
        }
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                onClose();
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [open, onClose]);

    return (
        <MotionConfig reducedMotion="user">
            <AnimatePresence>
                {open && (
                    <motion.div
                        key="backdrop"
                        variants={modalBackdrop}
                        initial="initial"
                        animate="animate"
                        exit="exit"
                        className={cn(
                            "fixed inset-0 z-[70] flex items-start justify-center bg-black/60 backdrop-blur-sm",
                            topClass
                        )}
                        onMouseDown={
                            dismissOnBackdrop
                                ? (e) => {
                                      if (e.target === e.currentTarget) {
                                          onClose();
                                      }
                                  }
                                : undefined
                        }
                    >
                        <motion.div
                            variants={modalPanel}
                            role="dialog"
                            aria-modal="true"
                            onMouseDown={(e) => e.stopPropagation()}
                            className={cn(
                                "overflow-hidden rounded-[14px] border border-edge-strong bg-modalbg shadow-popover",
                                className
                            )}
                        >
                            {children}
                        </motion.div>
                    </motion.div>
                )}
            </AnimatePresence>
        </MotionConfig>
    );
}
```

Note: `ModalShell`'s `AnimatePresence` intentionally omits `initial={false}` (unlike `ModalsRenderer` in Task 7). A modal should animate on every open, and `ModalShell` is always mounted closed by `cockpit-root`, so its panel is added *after* first render and there is no mount-time cascade to suppress.

- [ ] **Step 2: Typecheck checkpoint**

Run the typecheck command. Expected: exit 0.

---

### Task 3: Refactor `CommandPalette` onto `ModalShell`

**Files:**
- Modify: `frontend/app/cockpit/command-palette.tsx`

- [ ] **Step 1: Add the import**

Add near the other imports:
```tsx
import { ModalShell } from "@/app/modals/modalshell";
```

- [ ] **Step 2: Delegate Escape to ModalShell**

In `onKeyDown` (around line 160), delete the `else if (e.key === "Escape")` branch:
```tsx
        } else if (e.key === "Escape") {
            e.preventDefault();
            close();
        }
```
Keep the `ArrowDown` / `ArrowUp` / `Enter` branches. (Escape now bubbles to `ModalShell`'s window listener.)

- [ ] **Step 3: Remove the null-return and rewrap the return**

Delete:
```tsx
    if (!open) {
        return null;
    }
```

Replace the entire final `return ( … )` — the outer backdrop `<div className="fixed inset-0 z-[70] …">` and the inner panel `<div className="flex max-h-[70vh] w-[min(640px,93vw)] …">` — with a `ModalShell` that keeps the panel's two children (the header block and the results block) as its children:

```tsx
    return (
        <ModalShell open={open} onClose={close} className="flex flex-col w-[min(640px,93vw)] max-h-[70vh]">
            {open ? (
                <>
                    {/* header: search icon + input + esc badge — unchanged from the current panel */}
                    <div className="flex shrink-0 items-center gap-[11px] border-b border-border px-4 py-[13px]">
                        {/* …existing svg, input (ref=inputRef, onKeyDown), esc badge… */}
                    </div>
                    {/* results — unchanged from the current panel */}
                    <div className="min-h-0 flex-1 overflow-y-auto py-2">
                        {/* …existing groups/empty-state… */}
                    </div>
                </>
            ) : null}
        </ModalShell>
    );
```
Keep the inner header/results JSX byte-for-byte; only the wrapping backdrop `<div>` and panel `<div>` are removed (the panel's classes moved to `className`). The backdrop-dismiss the palette had (`onMouseDown` close on the scrim) is now `ModalShell`'s default (`dismissOnBackdrop` defaults to `true`).

- [ ] **Step 4: Typecheck checkpoint**

Run the typecheck command. Expected: exit 0.

---

### Task 4: Refactor `ShortcutsCheatSheet` onto `ModalShell`

**Files:**
- Modify: `frontend/app/cockpit/shortcuts-cheatsheet.tsx`

- [ ] **Step 1: Add the import**

```tsx
import { ModalShell } from "@/app/modals/modalshell";
```

- [ ] **Step 2: Remove the null-return and rewrap**

Delete:
```tsx
    if (!open) {
        return null;
    }
```

Replace the final `return ( … )` — the backdrop `<div className="fixed inset-0 z-[70] … pt-[10vh] …" onMouseDown=… onKeyDown=…>` and panel `<div className="flex max-h-[74vh] w-[min(680px,93vw)] …">` — with:

```tsx
    return (
        <ModalShell open={open} onClose={close} className="flex flex-col w-[min(680px,93vw)] max-h-[74vh]" topClass="pt-[10vh]">
            {open ? (
                <>
                    {/* header: filter input + esc badge — unchanged */}
                    <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-[13px]">
                        {/* …existing input + esc badge… */}
                    </div>
                    {/* grouped bindings — unchanged */}
                    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
                        {/* …existing groups.map… */}
                    </div>
                </>
            ) : null}
        </ModalShell>
    );
```
The backdrop's `onKeyDown` Escape and `onMouseDown` backdrop-close are both dropped — `ModalShell` owns Esc, and backdrop dismiss is on by default (matching current behavior). Keep the inner header/body JSX unchanged.

- [ ] **Step 3: Typecheck checkpoint**

Run the typecheck command. Expected: exit 0.

---

### Task 5: Refactor `NewProjectModal` onto `ModalShell`

**Files:**
- Modify: `frontend/app/view/agents/newprojectmodal.tsx`

- [ ] **Step 1: Fix imports**

Add:
```tsx
import { ModalShell } from "@/app/modals/modalshell";
```
Change the React import (line 8) from `import { useEffect, useState } from "react";` to:
```tsx
import { useState } from "react";
```
(`useEffect` is used only by the Esc listener being removed next; leaving it imported is an unused-import error.)

- [ ] **Step 2: Remove the Esc effect and null-return**

Delete the Esc `useEffect` block:
```tsx
    // Esc closes the modal (the "esc" badge); outside-click no longer dismisses (see backdrop below).
    useEffect(() => {
        if (!open) {
            return;
        }
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                close();
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [open]);
```
Delete:
```tsx
    if (!open) {
        return null;
    }
```

- [ ] **Step 3: Rewrap the return**

Replace the final `return ( … )` — the backdrop `<div className="fixed inset-0 z-[70] … pt-[14vh] …">` (no backdrop-dismiss) and panel `<div className="w-[min(480px,92vw)] overflow-hidden rounded-[14px] …">` — with:

```tsx
    return (
        <ModalShell open={open} onClose={close} className="w-[min(480px,92vw)]" topClass="pt-[14vh]" dismissOnBackdrop={false}>
            {open ? (
                <>
                    {/* header — unchanged */}
                    <div className="flex items-center gap-[11px] border-b border-border px-[18px] py-[15px]">
                        {/* …New project title + esc badge… */}
                    </div>
                    {/* body: Name + Local path + error — unchanged */}
                    <div className="flex flex-col gap-[15px] px-[18px] py-4">
                        {/* …existing fields… */}
                    </div>
                    {/* footer: Cancel + Create — unchanged */}
                    <div className="flex items-center gap-3 border-t border-border px-[18px] py-[13px]">
                        {/* …existing buttons… */}
                    </div>
                </>
            ) : null}
        </ModalShell>
    );
```
`dismissOnBackdrop={false}` preserves the current "outside-click does not dismiss" behavior. `NewProjectModal`'s panel is a plain block (no `flex flex-col`), so `className` omits it. Keep the three inner blocks unchanged.

- [ ] **Step 4: Typecheck checkpoint**

Run the typecheck command. Expected: exit 0.

---

### Task 6: Refactor `NewAgentModal` onto `ModalShell`

**Files:**
- Modify: `frontend/app/view/agents/newagentmodal.tsx`

- [ ] **Step 1: Add the import**

```tsx
import { ModalShell } from "@/app/modals/modalshell";
```
(Leave the React import as-is — `NewAgentModal` uses `useEffect` for its data-fetch effects, which stay.)

- [ ] **Step 2: Remove the Esc effect and null-return**

Delete the Esc `useEffect` block (the one guarded by `if (!open) return;` that adds the `keydown` listener for `Escape` → `close()`), and delete:
```tsx
    if (!open) {
        return null;
    }
```
Leave the `pickRuntime` and `launch` const definitions that follow — they are still used by the body.

- [ ] **Step 3: Rewrap the return**

Replace the final `return ( … )` — the backdrop `<div className="fixed inset-0 z-[70] … pt-[11vh] …">` (no backdrop-dismiss) and panel `<div className="flex max-h-[86vh] w-[min(640px,93vw)] flex-col …">` — with:

```tsx
    return (
        <ModalShell open={open} onClose={close} className="flex flex-col w-[min(640px,93vw)] max-h-[86vh]" dismissOnBackdrop={false}>
            {open ? (
                <>
                    {/* header — unchanged */}
                    <div className="flex shrink-0 items-center gap-[11px] border-b border-border px-[18px] py-[15px]">
                        {/* …gradient dot + "New agent" + esc badge… */}
                    </div>
                    {/* scrolling body: Runtime / Project / Task / Startup / Flags / Worktree / error — unchanged */}
                    <div className="flex min-h-0 flex-1 flex-col gap-[15px] overflow-y-auto px-[18px] py-4">
                        {/* …existing sections… */}
                    </div>
                    {/* footer: preview + Cancel + Launch — unchanged */}
                    <div className="flex shrink-0 items-center gap-3 border-t border-border px-[18px] py-[13px]">
                        {/* …existing footer… */}
                    </div>
                </>
            ) : null}
        </ModalShell>
    );
```
`dismissOnBackdrop={false}` preserves the current no-outside-click behavior (default `topClass` `pt-[11vh]` matches). Keep the three inner blocks byte-for-byte; the `open ? … : null` guard preserves today's short-circuit so this large tree is not built while closed. The `Section` helper at the bottom of the file is unchanged.

- [ ] **Step 4: Typecheck checkpoint**

Run the typecheck command. Expected: exit 0.

---

### Task 7: Animate the generic stack (`FlexiModal`/`Modal` + `ModalsRenderer`)

**Files:**
- Modify: `frontend/app/modals/modal.tsx`
- Modify: `frontend/app/modals/modalsrenderer.tsx`

- [ ] **Step 1: Add imports to `modal.tsx`**

Add:
```tsx
import { modalBackdrop, modalPanel } from "@/app/element/motiontokens";
import { motion } from "motion/react";
```

- [ ] **Step 2: Motion-ize the `Modal` component's backdrop + panel**

In `Modal`, change `renderBackdrop`:
```tsx
        const renderBackdrop = (onClick) => (
            <motion.div
                className="modal-backdrop"
                onClick={onClick}
                variants={modalBackdrop}
                initial="initial"
                animate="animate"
                exit="exit"
            />
        );
```
and in `renderModal`, change the panel `<div ref={ref} className={clsx('modal', className)}>` to a `motion.div` with the panel variants (keep the `Button` close, `content-wrapper`, footer children unchanged):
```tsx
                <motion.div
                    ref={ref}
                    className={clsx(`modal`, className)}
                    variants={modalPanel}
                    initial="initial"
                    animate="animate"
                    exit="exit"
                >
                    {/* …existing modal-close Button, content-wrapper, footer… */}
                </motion.div>
```

- [ ] **Step 3: Motion-ize the `FlexiModal` component's backdrop + panel**

In `FlexiModal`, change `renderBackdrop`:
```tsx
        const renderBackdrop = (onClick: () => void) => (
            <motion.div
                className="modal-backdrop"
                onClick={onClick}
                variants={modalBackdrop}
                initial="initial"
                animate="animate"
                exit="exit"
            />
        );
```
and in `renderModal`, change the panel `<div className={cn("modal pt-6 px-4 pb-4", className)} ref={ref}>` to:
```tsx
                <motion.div
                    className={cn("modal pt-6 px-4 pb-4", className)}
                    ref={ref}
                    variants={modalPanel}
                    initial="initial"
                    animate="animate"
                    exit="exit"
                >
                    {children}
                </motion.div>
```

- [ ] **Step 4: Wrap `ModalsRenderer` in `AnimatePresence`**

Rewrite `frontend/app/modals/modalsrenderer.tsx`'s render to (add the `motion/react` import at the top):
```tsx
import { AnimatePresence, MotionConfig } from "motion/react";
```
```tsx
export function ModalsRenderer() {
    const modals = useAtomValue(modalsModel.modalsAtom);
    return (
        <MotionConfig reducedMotion="user">
            <AnimatePresence initial={false}>
                {modals.map((m, i) => {
                    const Comp = REGISTRY[m.displayName];
                    return Comp ? <Comp key={`${m.displayName}-${i}`} {...m.props} /> : null;
                })}
            </AnimatePresence>
        </MotionConfig>
    );
}
```
`AnimatePresence`'s presence context propagates through the `ReactDOM.createPortal` in `modal.tsx`, so a `popModal` keeps the removed modal mounted while its portaled `motion.div`s play their exit, then unmounts. (This is the CDP-verify gate in Task 8.)

- [ ] **Step 5: Typecheck checkpoint**

Run the typecheck command. Expected: exit 0.

---

### Task 8: Full verification + commit

**Files:** none (verification + commit only)

- [ ] **Step 1: Full unit-test run**

Run:
```bash
npx vitest run
```
Expected: PASS (no regressions; `motiontokens` includes the two new cases).

- [ ] **Step 2: Typecheck**

Run the typecheck command. Expected: exit 0.

- [ ] **Step 3: CDP visual verification (dev app)**

Start the dev app if not running (`tail -f /dev/null | task dev` — headless-safe per the dev-stdin gotcha), then over CDP (`:9222`, `scripts/cdp-shot.mjs` / `Runtime.evaluate` / `Input.dispatchKeyEvent`) confirm:
  - **Cockpit overlays** — open each (Command Palette `Ctrl+P`; Keyboard shortcuts `Shift+?`; New Agent + New Project via their launchers): backdrop fades in, panel scales+fades in; on close, both play the exit (no hard cut).
  - **Backdrop dismiss** — Command Palette and Keyboard shortcuts close on a scrim click; **New Agent and New Project do not** (only Esc / Cancel).
  - **Esc** closes all four.
  - **Generic stack (portal gate)** — trigger a `ConfirmModal` (e.g. the Agent header "Close terminal" confirm) and confirm the **portaled** dialog animates open **and exits on close** (both Confirm/Cancel and the ✕). If it snaps closed with no exit, presence did not cross the portal → apply the spec's fallback (local `AnimatePresence` inside `FlexiModal` driven by an internal `open` state) and re-verify.
  - **Reduced motion** — emulate `prefers-reduced-motion: reduce` (CDP `Emulation.setEmulatedMedia`) and confirm the scale is dropped while the opacity fade remains, for both a cockpit overlay and a generic dialog.

- [ ] **Step 4: Show the diff and request commit approval**

Run:
```bash
git status
git diff --stat -- frontend/app/element/motiontokens.ts frontend/app/element/motiontokens.test.ts frontend/app/modals/modalshell.tsx frontend/app/modals/modal.tsx frontend/app/modals/modalsrenderer.tsx frontend/app/cockpit/command-palette.tsx frontend/app/cockpit/shortcuts-cheatsheet.tsx frontend/app/view/agents/newagentmodal.tsx frontend/app/view/agents/newprojectmodal.tsx
```
Present the file list (M/A) + a one-line summary and the proposed message, then ask for approval. Do **not** stage the parallel-session fill-columns files.

- [ ] **Step 5: Commit (only after explicit approval)**

Stage exactly this plan's files (plus the spec + this plan, which fold into the feature commit per repo convention):
```bash
git add frontend/app/element/motiontokens.ts frontend/app/element/motiontokens.test.ts \
  frontend/app/modals/modalshell.tsx frontend/app/modals/modal.tsx frontend/app/modals/modalsrenderer.tsx \
  frontend/app/cockpit/command-palette.tsx frontend/app/cockpit/shortcuts-cheatsheet.tsx \
  frontend/app/view/agents/newagentmodal.tsx frontend/app/view/agents/newprojectmodal.tsx \
  docs/superpowers/specs/2026-07-03-shared-modals-motion-design.md \
  docs/superpowers/plans/2026-07-03-shared-modals-motion.md \
  docs/superpowers/animation-revamp-tracker.md
git commit -m "feat(modals): open/close motion via shared ModalShell + animated FlexiModal base"
```
(The tracker is included because Step 6 flips its row.)

- [ ] **Step 6: Flip the tracker row**

In `docs/superpowers/animation-revamp-tracker.md`, change the **Shared modals** row status from `☐ Not started` to `✅ Shipped <commit-sha>` and add a note (`Backdrop fade + panel scale via ModalShell; generic FlexiModal stack animated; Settings excluded (surface); WhichKeyBar excluded`). Amend it into the same commit, or include it in Step 5's `git add` before committing.

---

## Notes for the executor

- **Reduced motion is free:** `MotionConfig reducedMotion="user"` in `ModalShell` and `ModalsRenderer` makes Framer keep opacity and drop scale — no per-variant work needed.
- **Do not touch** `cockpitsurface.tsx`, `agentrow.tsx`, `agentsviewmodel.ts`, `agentfilters.test.ts` — parallel-session work.
- **The one risk** is Task 7's portal + `AnimatePresence` exit; the fallback is written into the spec and Task 8 Step 3.
