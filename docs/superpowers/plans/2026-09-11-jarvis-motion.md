# Jarvis Motion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Jarvis tab the motion pass every other cockpit surface already had, built around one idea — motion tells you what changed since you last looked.

**Architecture:** Three phases, sequenced by risk. Phase 1 extends the shared `ModalShell` primitive (a `variant` prop plus a modal stack that fixes a latent Escape bug) and migrates the two Jarvis overlays that pop with no reveal — this is the only phase that can break surfaces outside Jarvis, so it lands and is verified first. Phase 2 adds the north star to the Brief: a pure helper derives which rows are new since your visit cursor, and those rows get a non-layout mark on open while rows arriving live get a real entrance. Phase 3 does the avatar popup's interior. The hologram's own physics is deliberately untouched throughout.

**Tech Stack:** React 19, `motion/react` (Framer v12), Tailwind 4, jotai, vitest, CDP scenario harness (`task verify:ui`).

**Spec:** `docs/superpowers/specs/2026-09-11-jarvis-motion-design.md`

## Global Constraints

- **Colors come from `@theme` tokens** in `frontend/tailwindsetup.css`. Raw hex/rgba never appears in a component `className` or `style` — a hardcoded color silently opts out of every runtime theme. Neutral black/white overlays (`rgba(0,0,0,…)` shadows) are the documented exception.
- **No emojis** in code, comments, or commit messages.
- **Comments explain "why", never "what."** Lower case. Only when necessary.
- **Prefer Tailwind over new SCSS.** New keyframes go in `frontend/tailwindsetup.css`; consumers apply them inline via Tailwind's arbitrary animation syntax plus a reduced-motion guard — e.g. `animate-[settle_0.5s_ease-out] motion-reduce:animate-none` (the established pattern at `frontend/app/view/agents/agentheader.tsx:118`). There is no `--period` theme var convention; the duration is written at the call site.
- **Typecheck with** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`. `npx tsc` stack-overflows on this repo, so `task check:ts` is broken and is not the check. The baseline is clean (exit 0) — any error it reports is yours.
- **Unit tests:** `npx vitest run <path>`, or filter by name with `-t`. Pure logic gets a `foo.test.ts` beside its `foo.ts`. **There are deliberately no jsdom render/snapshot tests** — "does it render" is covered by the CDP `surface-smoke` scenario. Do not add a render harness.
- **Reduced motion** is mandatory on every moment: Framer via `MotionConfig reducedMotion="user"`, CSS via `motion-reduce:animate-none` or a `@media (prefers-reduced-motion: reduce)` block.
- **Never hand-edit generated files.** No task here touches the wire protocol, so no `task generate`, no backend, no RPC, no SQL migration.
- **Do not commit without explicit approval, and do not push.** Per this spec family's convention the spec and plan fold into the feature commit rather than a docs-only commit. Each task below ends with a commit step; run it only under the approval already given for the task. Conventional commits: `type(scope): description`, subject under 72 chars, explaining why. **Do not add a Claude co-author trailer.**
- **Touch only what the task requires.** Do not refactor adjacent code, reformat, or improve comments you did not add.

---

## Planning Notes: three findings that change the spec

These were discovered while reading the code to write this plan. They are called out here rather than silently absorbed.

**1. Freshness cannot be a field added by `projectBriefing` (spec §2 says it is).** The three marked regions build their rows in three different places, and only one of them is inside `projectBriefing`:

| Region | Built by | Has the cursor? |
|---|---|---|
| waiting | `buildAttentionQueue({attention, efforts})` (`briefingmodel.ts:187`) — reads the **live attention poll**, not the snapshot | No |
| initiatives | `buildEffortCard()` (`effortmodel.ts:48`) | No |
| sessions | `mergeActiveWork()` (`briefingmodel.ts:250`), called in the **view** at `briefsurface.tsx:1068` | No |

Threading `actualCursor` into all three means widening three signatures, and `buildEffortCard` has two other callers with no cursor to give it (`effortdetailview.tsx:192`, `effortmodel.ts:195`) — so the field would have to be optional, which is a weaker contract than the spec wants. **Instead: one pure helper returns a `Set<string>` of row keys to mark** (Task 7). It keeps the cursor comparison and the cap in a single tested place, touches no shared row model, and serves spec §2's intent (derive it in a pure, tested layer; one source of truth for the mark) better than its letter.

**2. `ShippedRow.fresh` is not folded in (spec §2 says it is).** That flag drives the static "New" **badge** on shipped rows, and shipped rows live in `behind` — the region spec §2 explicitly *excludes* from the mark. Folding a badge's data source onto a motion helper that excludes its region would be incoherent. `ShippedRow.fresh` and `briefingmodel.ts:467` stay exactly as they are.

**3. Spec §10's open question about peek row keys is closed: they are already stable.** `PeekRow.key = item.key` (`petpeekmodel.ts:39`) comes straight off the wire `AttentionItem.key` — the same key the Brief's queue uses. Moments 12–13 need no key derivation. No task required.

Also worth recording, because it makes moment 1 simpler than the spec implies: **moment 1 needs no hook.** A CSS animation does not restart when React re-renders the same element with an unchanged `className`, and `freshKeys` is a pure function of a stable snapshot + a cursor that a refresh does not move (spec §6). So class membership fires the mark exactly once. `motionhooks.ts`'s `useDidBecomeTrue` / `useSettle` are not needed here.

---

## File Structure

| File | Responsibility | Phase |
|---|---|---|
| `frontend/app/modals/modalstack.ts` | **New.** Which open modal owns the keyboard. Pure LIFO ordering + a module-state holder. | 1 |
| `frontend/app/modals/modalstack.test.ts` | **New.** The ordering functions. | 1 |
| `frontend/app/modals/modalshell.tsx` | Gains `variant`; registers with the stack; gates keys on topmost. | 1 |
| `frontend/app/element/motiontokens.ts` | Gains `sheetPanel`. | 1 |
| `frontend/app/element/motiontokens.test.ts` | Covers `sheetPanel`. | 1 |
| `frontend/app/view/jarvis/briefsheet.tsx` | Onto `ModalShell variant="sheet"`; latches its face so the exit plays. | 1 |
| `frontend/app/view/jarvis/briefrunsheet.tsx` | `SheetShell` loses positioning + scrim to `ModalShell`; interior unchanged. | 1 |
| `frontend/app/view/jarvis/briefprofileview.tsx` | Onto `ModalShell variant="dialog"`. | 1 |
| `frontend/app/view/jarvis/freshrows.ts` | **New.** Which row keys are new since the visit cursor, with the cap. | 2 |
| `frontend/app/view/jarvis/freshrows.test.ts` | **New.** Cursor boundary, cap, null `ts`. | 2 |
| `frontend/tailwindsetup.css` | Gains the `freshMark` keyframe + its `.fresh-mark` rule. | 2 |
| `frontend/app/view/jarvis/briefsurface.tsx` | Moments 1–8. | 2 |
| `frontend/app/view/jarvis/petpeek.tsx` | Moments 12–15. | 3 |
| `frontend/app/view/jarvis/petview.tsx` | Moment 16 only. Character motion untouched. | 3 |
| `scripts/cdp/scenarios.mjs` | The `jarvis-motion` scenario. | 3 |

---

# Phase 1 — the shared primitive

Lands first because it is the only phase that can break surfaces outside Jarvis. Bundling it with cosmetic row motion would make a regression there expensive to bisect.

### Task 1: The modal stack

**Files:**
- Create: `frontend/app/modals/modalstack.ts`
- Test: `frontend/app/modals/modalstack.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `pushId(stack: string[], id: string): string[]`, `popId(stack: string[], id: string): string[]`, `topId(stack: string[]): string | null`, `registerModal(id: string): () => void`, `isTopModal(id: string): boolean`.

- [ ] **Step 1: Write the failing test**

Create `frontend/app/modals/modalstack.test.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { popId, pushId, topId } from "./modalstack";

describe("modalstack", () => {
    it("the last opened modal is the topmost", () => {
        const stack = pushId(pushId([], "peek"), "confirm");
        expect(topId(stack)).toBe("confirm");
    });

    it("an empty stack has no top", () => {
        expect(topId([])).toBe(null);
    });

    it("closing the top hands the keyboard back to the one beneath it", () => {
        const stack = pushId(pushId([], "peek"), "confirm");
        expect(topId(popId(stack, "confirm"))).toBe("peek");
    });

    it("closing out of order leaves the rest of the order intact", () => {
        const stack = pushId(pushId(pushId([], "a"), "b"), "c");
        expect(popId(stack, "b")).toEqual(["a", "c"]);
        expect(topId(popId(stack, "b"))).toBe("c");
    });

    it("registering twice does not double-enter (a re-run effect must not stack an id on itself)", () => {
        expect(pushId(pushId([], "a"), "a")).toEqual(["a"]);
    });

    it("popping something absent is a no-op", () => {
        expect(popId(["a"], "ghost")).toEqual(["a"]);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run frontend/app/modals/modalstack.test.ts`
Expected: FAIL — cannot resolve `./modalstack`.

- [ ] **Step 3: Write minimal implementation**

Create `frontend/app/modals/modalstack.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Which open modal owns the keyboard. Every ModalShell attaches its own window keydown listener, so
// without this they all fire at once — briefpeekview.tsx documents the consequence: a confirm over a
// peek, and one Escape dismisses both. Last opened wins, which is what "topmost" means for overlays
// that stack in mount order.
//
// The ordering is pure so it is testable; only the holder is module state, and it is read at event
// time rather than captured, so a listener never acts on a stale stack.

export function pushId(stack: string[], id: string): string[] {
    return stack.includes(id) ? stack : [...stack, id];
}

export function popId(stack: string[], id: string): string[] {
    return stack.filter((entry) => entry !== id);
}

export function topId(stack: string[]): string | null {
    return stack.length === 0 ? null : stack[stack.length - 1];
}

let openStack: string[] = [];

/** Registers an open modal and returns its unregister. Call from an effect gated on `open`. */
export function registerModal(id: string): () => void {
    openStack = pushId(openStack, id);
    return () => {
        openStack = popId(openStack, id);
    };
}

export function isTopModal(id: string): boolean {
    return topId(openStack) === id;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run frontend/app/modals/modalstack.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add frontend/app/modals/modalstack.ts frontend/app/modals/modalstack.test.ts
git commit -m "feat(modals): track which open modal owns the keyboard

Stacked ModalShells each ran their own Escape listener, so one press
dismissed the whole stack. Ordering only; no consumer yet."
```

---

### Task 2: Gate ModalShell's keys on topmost

**Files:**
- Modify: `frontend/app/modals/modalshell.tsx:36-60` (the key effect and the imports)

**Interfaces:**
- Consumes: `registerModal`, `isTopModal` from Task 1.
- Produces: no API change. `ModalShell`'s props are untouched.

- [ ] **Step 1: Add the imports**

In `frontend/app/modals/modalshell.tsx`, add to the existing imports:

```tsx
import { isTopModal, registerModal } from "@/app/modals/modalstack";
```

and add `useId` to the existing React import so it reads:

```tsx
import { useEffect, useId, useRef, type ReactNode } from "react";
```

- [ ] **Step 2: Register while open**

Immediately after the existing `panelRef` declaration, add:

```tsx
    const shellId = useId();
    // registered in its own effect, before the key listener below, so a shell that opens in the same
    // commit as another is already in the stack when that listener first runs
    useEffect(() => {
        if (!open) {
            return;
        }
        return registerModal(shellId);
    }, [open, shellId]);
```

- [ ] **Step 3: Gate the key handler**

In the existing key effect, add the topmost guard as the first statement of `onKey`, and add `shellId` to the dep array. The effect becomes:

```tsx
    useEffect(() => {
        if (!open) {
            return;
        }
        const onKey = (e: KeyboardEvent) => {
            // only the topmost open shell owns the keyboard. Without this, every mounted shell's
            // listener fires and Escape over a stacked pair dismisses both at once.
            if (!isTopModal(shellId)) {
                return;
            }
            if (e.key === "Escape") {
                onClose();
            } else if (onSubmit && e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                onSubmit();
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [open, onClose, onSubmit, shellId]);
```

Leave the `takeModalFocus` effect alone: each shell restores focus to whatever it saw on open, so a stack unwinds to the right place already.

- [ ] **Step 4: Typecheck and run the full unit suite**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit && npx vitest run`
Expected: exit 0; no new failures. A single modal is always topmost, so nothing existing changes behavior.

- [ ] **Step 5: Verify the stacked case in the dev app**

Run `tail -f /dev/null | task dev` (detaching without a stdin holder EOFs wavesrv). Open Jarvis, open a record peek, trigger the confirm inside it, and press Escape once.
Expected: the confirm closes, the peek stays open. Before this task, both closed.

- [ ] **Step 6: Commit**

```bash
git add frontend/app/modals/modalshell.tsx
git commit -m "fix(modals): give Escape to the topmost modal only

A confirm over a peek closed both on one press, because every mounted
shell ran its own window listener."
```

---

### Task 3: The sheet variant

**Files:**
- Modify: `frontend/app/element/motiontokens.ts` (add `sheetPanel`)
- Modify: `frontend/app/element/motiontokens.test.ts` (cover it)
- Modify: `frontend/app/modals/modalshell.tsx` (the `variant` prop)

**Interfaces:**
- Consumes: `MOTION`, `modalPanel` (existing).
- Produces: `sheetPanel: Variants`; `ModalShell` prop `variant?: "dialog" | "sheet"` defaulting to `"dialog"`.

- [ ] **Step 1: Write the failing test**

Add to `frontend/app/element/motiontokens.test.ts` inside the existing `describe`:

```ts
    it("the sheet slides from the edge it is pinned to, and leaves quicker than it arrives", () => {
        expect((sheetPanel.initial as { x: number }).x).toBeGreaterThan(0);
        expect((sheetPanel.animate as { x: number }).x).toBe(0);
        expect((sheetPanel.animate as any).transition.duration).toBeCloseTo(MOTION.durMacro);
        expect((sheetPanel.exit as any).transition.duration).toBeCloseTo(MOTION.durExit);
        expect((sheetPanel.animate as any).transition.ease).toEqual(MOTION.easeFluid);
    });
```

and add `sheetPanel` to that file's existing import list from `./motiontokens`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run frontend/app/element/motiontokens.test.ts -t "sheet slides"`
Expected: FAIL — `sheetPanel` is not exported.

- [ ] **Step 3: Add the token**

Append to `frontend/app/element/motiontokens.ts`:

```ts
// Sheet reveal (Jarvis detail sheet). A right-pinned full-height drawer slides in from the edge it is
// pinned to: a layer arriving from off-screen reads as navigation, where a centered scale reads as a
// dialog. x is safe here — cardVariants bans it because Reorder.Item owns that transform on cockpit
// cards, and a sheet has no such owner.
export const sheetPanel: Variants = {
    initial: { opacity: 0, x: 24 },
    animate: { opacity: 1, x: 0, transition: { duration: MOTION.durMacro, ease: MOTION.easeFluid } },
    exit: { opacity: 0, x: 24, transition: { duration: MOTION.durExit, ease: MOTION.easeFluid } },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run frontend/app/element/motiontokens.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the variant to ModalShell**

In `frontend/app/modals/modalshell.tsx`, import the new token alongside the existing ones:

```tsx
import { modalBackdrop, modalPanel, sheetPanel } from "@/app/element/motiontokens";
```

Above the `ModalShellProps` interface, add the two lookup maps:

```tsx
export type ModalVariant = "dialog" | "sheet";

// One named composition per shape rather than four independent override props whose combinations
// nobody would test. Two of these differences are behavior, not styling: a sheet is `absolute` at
// z-20 so it stays scoped to the surface that owns it, leaving the app bar reachable and surfaces
// switchable while it is open. A fixed z-70 detail sheet would cover the cockpit chrome.
const BACKDROP: Record<ModalVariant, string> = {
    dialog: "fixed inset-0 z-[70] flex justify-center bg-black/60 backdrop-blur-sm",
    sheet: "absolute inset-0 z-20 flex items-stretch justify-end bg-background/40",
};

const PANEL: Record<ModalVariant, string> = {
    dialog: "overflow-hidden rounded-[14px] border border-edge-strong bg-modalbg shadow-popover outline-none",
    sheet: "overflow-hidden rounded-none border-l border-edge-faint bg-surface shadow-popover outline-none",
};
```

Add the prop to the interface, documented like its neighbors:

```tsx
    variant?: ModalVariant; // "dialog" (centered, default) or "sheet" (right-pinned, surface-scoped)
```

Destructure it with its default alongside the others: `variant = "dialog",`.

- [ ] **Step 6: Drive the markup from the maps**

Replace the backdrop `className` with:

```tsx
                        className={cn(
                            BACKDROP[variant],
                            // align/topClass position a centered dialog; a sheet is pinned by the map above
                            variant === "dialog" &&
                                (align === "center" ? "items-center p-10" : cn("items-start", topClass))
                        )}
```

Replace the panel's `variants` and `className` with:

```tsx
                            variants={variant === "sheet" ? sheetPanel : modalPanel}
```

```tsx
                            className={cn(PANEL[variant], className)}
```

`cn` is `twMerge(clsx(...))`, so a consumer's `className` still overrides width and rounding exactly as it does today.

- [ ] **Step 7: Typecheck and run the suite**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit && npx vitest run`
Expected: exit 0, no new failures. Every existing consumer omits `variant`, so all of them still render the `dialog` strings verbatim.

- [ ] **Step 8: Commit**

```bash
git add frontend/app/element/motiontokens.ts frontend/app/element/motiontokens.test.ts frontend/app/modals/modalshell.tsx
git commit -m "feat(modals): let ModalShell render a surface-scoped sheet

One variant prop bundles the four dialog/sheet differences so a
right-pinned drawer can reuse the shell's motion, focus and Esc."
```

---

### Task 4: BriefSheet onto the shell

**Files:**
- Modify: `frontend/app/view/jarvis/briefsheet.tsx:293-320`
- Modify: `frontend/app/view/jarvis/briefrunsheet.tsx:58-86` (`SheetShell`)

**Interfaces:**
- Consumes: `ModalShell` with `variant="sheet"` (Task 3).
- Produces: no API change. `SheetShell`'s props are unchanged.

**Why this is not a one-line swap:** `briefsheet.tsx:293` early-returns `null` when there is nothing to show, and that guard sits *above* the `close` and `title` derivations. Rendering `{cond ? <ModalShell/> : null}` defeats `AnimatePresence` and the exit never plays — the trap `petbubble.tsx` documents in its own comment. So the component must render `ModalShell` unconditionally, drive it with `open`, and latch what it draws so the exit has content.

- [ ] **Step 1: Strip positioning and scrim out of SheetShell**

In `frontend/app/view/jarvis/briefrunsheet.tsx`, the `<aside>` keeps its identity, header and children but hands its positioning, width, background and border to `ModalShell`. Change its `className` from

```tsx
            className="absolute inset-y-0 right-0 flex w-[640px] max-w-[92vw] flex-col border-l border-edge-faint bg-surface shadow-xl"
```

to

```tsx
            // positioning, width, scrim and edge now belong to ModalShell variant="sheet"
            className="flex h-full min-h-0 flex-col"
```

- [ ] **Step 2: Latch the face and render the shell unconditionally**

In `frontend/app/view/jarvis/briefsheet.tsx`, add `ModalShell` to the imports:

```tsx
import { ModalShell } from "@/app/modals/modalshell";
```

Delete the early return at `briefsheet.tsx:293`:

```tsx
    if (!open || face.kind === "none") {
        return null;
    }
```

and replace it with a latch plus a computed `shown`, placed after the `title` derivation so `close` and `title` are already in scope:

```tsx
    const visible = open && face.kind !== "none";
    // the exit animation still needs something to draw after the subject clears, so the last shown
    // face and its title are latched rather than read live (petbubble.tsx keeps the same rule)
    const [shown, setShown] = useState<{ face: SheetFace; title: string } | null>(null);
    useEffect(() => {
        if (visible) {
            setShown({ face, title });
        }
    }, [visible, face, title]);
```

Move the `close` and `title` declarations above this block unchanged. Import `useState` if the file does not already.

- [ ] **Step 3: Wrap the body**

Replace the outer `<div className="absolute inset-0 z-20">` and its sibling close-button scrim with `ModalShell`. The backdrop click-to-dismiss is now the shell's (`dismissOnBackdrop` defaults true), so the hand-rolled `<button aria-label="Close detail sheet" className="absolute inset-0 …">` is deleted:

```tsx
    return (
        <ModalShell open={visible} variant="sheet" onClose={close} className="h-full w-[640px] max-w-[92vw]">
            {shown != null ? (
                <SheetShell
                    face={shown.face.kind}
                    label={shown.face.kind === "effort" ? "initiative" : "project"}
                    title={shown.title}
                    onClose={close}
                >
                    {/* body unchanged — it continues to read the live `face`, `channel`, `run`, … */}
                </SheetShell>
            ) : null}
        </ModalShell>
    );
```

Keep the existing children of `SheetShell` verbatim; only the wrapper and the three props above change. The children keep reading live state, so a sheet mid-exit draws its last frame from the latched title while its body empties — acceptable for a 280ms exit, and the alternative (latching the whole body) would hold stale run state.

- [ ] **Step 4: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0. If `SheetFace` is not exported from its module, export the type rather than widening `shown` to `any`.

- [ ] **Step 5: Verify in the dev app**

With `tail -f /dev/null | task dev` running, open Jarvis and click a session row to open the detail sheet.
Expected: the sheet slides in from the right edge and fades, rather than appearing instantly; Escape closes it and it slides back out; the app bar stays visible and clickable while it is open; clicking the dimmed area closes it.

- [ ] **Step 6: Screenshot it**

Run: `node scripts/cdp-shot.mjs cdp-shots/jarvis-sheet.png`
Expected: a PNG showing the sheet pinned to the right with the Brief dimmed behind it and the app bar undimmed.

- [ ] **Step 7: Commit**

```bash
git add frontend/app/view/jarvis/briefsheet.tsx frontend/app/view/jarvis/briefrunsheet.tsx
git commit -m "feat(jarvis): reveal the detail sheet instead of popping it

The sheet had no open/close motion at all. Onto ModalShell's sheet
variant, which also hands it focus handling and backdrop dismiss."
```

---

### Task 5: BriefProfileModal onto the shell

**Files:**
- Modify: `frontend/app/view/jarvis/briefprofileview.tsx:211` onward (the modal's wrapper only)

**Interfaces:**
- Consumes: `ModalShell` (Task 3), default `variant="dialog"`.
- Produces: no API change. `BriefProfileModal({ open, onClose })` keeps its signature.

- [ ] **Step 1: Read the current wrapper**

Run: `sed -n '211,260p' frontend/app/view/jarvis/briefprofileview.tsx`
Note its hand-rolled scrim element, its panel classes (width, max-height, rounding, background) and any Escape handling it installs. The panel classes carry forward into `ModalShell`'s `className`; the scrim and Escape handling are deleted because the shell owns them.

- [ ] **Step 2: Swap the wrapper**

Replace the outer positioning div and its scrim with `ModalShell`, carrying the panel's own width/height classes through `className` and keeping every child unchanged:

```tsx
        <ModalShell open={open} onClose={onClose} className="flex max-h-[86vh] w-[min(720px,94vw)] flex-col">
            {/* children unchanged */}
        </ModalShell>
```

Add the import:

```tsx
import { ModalShell } from "@/app/modals/modalshell";
```

Delete any `useEffect` in this file that listens for Escape on `window`, and delete the scrim element — both are now the shell's, and leaving the old Escape listener would close the modal twice over.

- [ ] **Step 3: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 4: Verify in the dev app**

Open Jarvis, click **Profile** in the header.
Expected: the panel fades and scales in on the shared dialog signature; Escape closes it; clicking the scrim closes it; the fields inside keep focus behavior (an autofocused field still holds focus — `takeModalFocus` only claims focus when nothing inside did).

- [ ] **Step 5: Commit**

```bash
git add frontend/app/view/jarvis/briefprofileview.tsx
git commit -m "refactor(jarvis): put the profile modal on the shared shell

It hand-rolled a scrim and popped with no motion; the shell already
owns open/close motion, Esc and focus."
```

---

### Task 6: The 13-consumer regression pass

This is the cost the migration buys, and it is a task rather than a footnote because a shared-primitive change is only as good as its evidence.

**Files:** none modified. This task produces verification.

- [ ] **Step 1: Run every automated check**

```bash
npx vitest run
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit
```
Expected: both clean.

- [ ] **Step 2: Run the CDP smoke suite**

Run: `task verify:ui -- surface-smoke`
Expected: PASS table, exit 0. This covers that every surface still renders after the shell change.

- [ ] **Step 3: Walk all 13 ModalShell consumers by hand**

With the dev app running, open and close each one. For each, confirm: it opens, Escape closes it, the scrim click behaves as it did (`dismissOnBackdrop={false}` consumers must still ignore scrim clicks), `Cmd/Ctrl+Enter` still submits where it did, and focus returns to where it came from.

- [ ] `frontend/app/cockpit/command-palette.tsx` (Ctrl+P)
- [ ] `frontend/app/cockpit/shortcuts-cheatsheet.tsx`
- [ ] `frontend/app/modals/confirmdialog.tsx`
- [ ] `frontend/app/modals/userinputmodal.tsx`
- [ ] `frontend/app/view/agents/newagentmodal.tsx` (`dismissOnBackdrop={false}` — scrim click must NOT close)
- [ ] `frontend/app/view/agents/newmemorymodal.tsx`
- [ ] `frontend/app/view/agents/newprojectmodal.tsx` (`dismissOnBackdrop={false}`)
- [ ] `frontend/app/view/agents/routepicker.tsx`
- [ ] `frontend/app/view/agents/tooldetailmodal.tsx`
- [ ] `frontend/app/view/code/codefinderpalette.tsx`
- [ ] `frontend/app/view/jarvis/briefpeekview.tsx`
- [ ] `frontend/app/view/jarvis/effortcreateform.tsx`
- [ ] `frontend/app/view/jarvis/newruncontrol.tsx`

- [ ] **Step 4: Verify the stacked cases explicitly**

These are the bug the stack fixes, so they get named checks:
- Confirm dialog over the record peek: one Escape closes only the confirm; a second closes the peek.
- Detail sheet open, then a record peek over it: one Escape closes only the peek; the sheet remains.

- [ ] **Step 5: Verify reduced motion**

In the dev app's DevTools, emulate `prefers-reduced-motion: reduce`, then open the sheet and a dialog.
Expected: both still open and close, transforms are dropped, opacity transitions remain (`MotionConfig reducedMotion="user"` handles this; no per-site work).

- [ ] **Step 6: Commit the evidence if anything needed fixing**

If a consumer regressed, fix it in this task and commit with a `fix(modals):` subject naming the consumer. If nothing regressed, there is nothing to commit — record the walk in the PR/commit body of the previous task instead. Do not fabricate a commit.

---

# Phase 2 — the Brief

### Task 7: Which rows are new since your visit

**Files:**
- Create: `frontend/app/view/jarvis/freshrows.ts`
- Test: `frontend/app/view/jarvis/freshrows.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `FRESH_MARK_CAP: number`, `FreshCandidate { key: string; ts: number | null }`, `freshKeys(rows: FreshCandidate[], cursor: number, cap?: number): Set<string>`.

- [ ] **Step 1: Write the failing test**

Create `frontend/app/view/jarvis/freshrows.test.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { FRESH_MARK_CAP, freshKeys } from "./freshrows";

const CURSOR = 1_000;

describe("freshKeys", () => {
    it("marks a row that changed at or after the visit cursor", () => {
        const marked = freshKeys(
            [
                { key: "old", ts: CURSOR - 1 },
                { key: "edge", ts: CURSOR },
                { key: "new", ts: CURSOR + 1 },
            ],
            CURSOR
        );
        expect([...marked].sort()).toEqual(["edge", "new"]);
    });

    it("never marks a row with no timestamp (a blocked chunk has no waiting-since)", () => {
        expect(freshKeys([{ key: "chunk", ts: null }], CURSOR).has("chunk")).toBe(false);
    });

    it("suppresses every mark once more than the cap is fresh — 'new' stops discriminating", () => {
        const rows = Array.from({ length: FRESH_MARK_CAP + 1 }, (_, i) => ({ key: `r${i}`, ts: CURSOR + 1 }));
        expect(freshKeys(rows, CURSOR).size).toBe(0);
    });

    it("marks right up to the cap", () => {
        const rows = Array.from({ length: FRESH_MARK_CAP }, (_, i) => ({ key: `r${i}`, ts: CURSOR + 1 }));
        expect(freshKeys(rows, CURSOR).size).toBe(FRESH_MARK_CAP);
    });

    it("marks nothing when there is no usable cursor, rather than marking everything", () => {
        expect(freshKeys([{ key: "a", ts: 5 }], 0).size).toBe(0);
        expect(freshKeys([{ key: "a", ts: 5 }], Number.NaN).size).toBe(0);
    });

    it("ignores a non-finite row timestamp instead of marking on a comparison with NaN", () => {
        expect(freshKeys([{ key: "a", ts: Number.NaN }], CURSOR).size).toBe(0);
    });

    it("is empty for an empty region", () => {
        expect(freshKeys([], CURSOR).size).toBe(0);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run frontend/app/view/jarvis/freshrows.test.ts`
Expected: FAIL — cannot resolve `./freshrows`.

- [ ] **Step 3: Write minimal implementation**

Create `frontend/app/view/jarvis/freshrows.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Which rows are new since your last visit — the north star of the Jarvis motion pass
// (docs/superpowers/specs/2026-09-11-jarvis-motion-design.md).
//
// A Set of keys rather than a field on each row type, because the three marked regions build their
// rows in three different places and none of them holds the cursor: the waiting queue comes from
// buildAttentionQueue (the live attention poll), initiatives from buildEffortCard (also called by
// effortdetailview and the list splitter, neither of which has a cursor to give), and sessions from
// mergeActiveWork in the view. One helper keeps the comparison and the cap in a single tested place
// instead of widening three signatures and a shared card model.

// Above this many fresh rows in a region the mark suppresses entirely. At that point every row is new,
// "new" stops discriminating, and the mark is decoration rather than a reading aid — a week away must
// not light up the whole surface. Shipped rows keep their own static "New" badge regardless.
export const FRESH_MARK_CAP = 6;

export interface FreshCandidate {
    key: string;
    /** null is never fresh: a blocked-chunk queue row has no waiting-since to compare against. */
    ts: number | null;
}

export function freshKeys(rows: FreshCandidate[], cursor: number, cap = FRESH_MARK_CAP): Set<string> {
    // a cursor this build cannot trust must mark nothing rather than mark everything
    if (!Number.isFinite(cursor) || cursor <= 0) {
        return new Set();
    }
    const fresh = (rows ?? []).filter((r) => r.ts != null && Number.isFinite(r.ts) && r.ts >= cursor);
    return fresh.length > cap ? new Set() : new Set(fresh.map((r) => r.key));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run frontend/app/view/jarvis/freshrows.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add frontend/app/view/jarvis/freshrows.ts frontend/app/view/jarvis/freshrows.test.ts
git commit -m "feat(jarvis): derive which brief rows are new since your visit

The Brief tracked a visit cursor but never showed what it meant. Pure
derivation only; no consumer yet."
```

---

### Task 8: The fresh mark

**Files:**
- Modify: `frontend/tailwindsetup.css` (append near the existing keyframes, after `settle` at `:342`)

**Interfaces:**
- Consumes: `--color-accent` (existing `@theme` token).
- Produces: the CSS class `fresh-mark`, applied by Task 9.

- [ ] **Step 1: Add the keyframe and the rule**

Append to `frontend/tailwindsetup.css` after the `settle` keyframe:

```css
/* Fresh mark (Jarvis motion moment 1): a row new since your last visit carries a one-shot accent rule
   on its leading edge, holding briefly then fading. A positioned ::before rather than a box-shadow,
   because a row's focus cursor is `ring-1 ring-accent/70` — itself a box-shadow — and a second shadow
   would fight it. Absolutely positioned so it adds no layout: the mark must never move a row the user
   is already reading, which is the whole reason it is a mark and not an entrance. */
@keyframes freshMark {
    0%,
    60% {
        opacity: 1;
    }
    100% {
        opacity: 0;
    }
}

.fresh-mark {
    position: relative;
}

.fresh-mark::before {
    content: "";
    position: absolute;
    inset-block: 0;
    inset-inline-start: 0;
    width: 2px;
    border-radius: 2px;
    background: var(--color-accent);
    animation: freshMark 2.4s cubic-bezier(0.22, 1, 0.36, 1) forwards;
    pointer-events: none;
}

/* reduced motion means less movement, not less information: the rule stays, it just never animates */
@media (prefers-reduced-motion: reduce) {
    .fresh-mark::before {
        animation: none;
        opacity: 1;
    }
}
```

- [ ] **Step 2: Verify the class compiles and paints**

With the dev app running, in DevTools console apply it to any Brief row and confirm a 2px accent rule appears at the row's left edge and fades:

```js
document.querySelector('[data-jarvis-brief-row]')?.classList.add('fresh-mark')
```
Expected: the rule appears, holds, fades out; the row does not shift by a pixel; a focused row's accent ring is unaffected.

- [ ] **Step 3: Commit**

```bash
git add frontend/tailwindsetup.css
git commit -m "feat(jarvis): add the fresh-mark leading edge keyframe

A non-layout mark for rows new since your last visit; a pseudo-element
so it never fights a row's box-shadow focus ring."
```

---

### Task 9: Mark on open, enter while watching

**Files:**
- Modify: `frontend/app/view/jarvis/briefsurface.tsx` — the three row components (`QueueRowView:227`, `InitiativeRow:336`, `SessionRow:375`), the derived state near `:1046-1070`, and the three region bodies in the render at `:1272-1330`

**Interfaces:**
- Consumes: `freshKeys`, `FRESH_MARK_CAP` (Task 7); the `fresh-mark` class (Task 8); `cardVariants`, `computeEntrances`, `initialEntranceState`, `MOTION` from `motiontokens`.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Derive the marked keys**

In `BriefSurface`, after the existing `sessions` memo (`briefsurface.tsx:~1070`), add:

```tsx
    // moment 1: which rows are new to YOU. Excludes `behind` deliberately — that region is entirely
    // since-your-last-visit by construction, so marking it would mark every row and its own label
    // already states the fact.
    const cursorTs = snapshot?.actualCursor ?? 0;
    const freshWaiting = useMemo(() => freshKeys(queue.map((q) => ({ key: q.key, ts: q.ts })), cursorTs), [queue, cursorTs]);
    const freshInitiatives = useMemo(
        () => freshKeys(effortWindow.rows.map((e) => ({ key: e.oref, ts: e.updatedts })), cursorTs),
        [effortWindow, cursorTs]
    );
    const freshSessions = useMemo(
        () => freshKeys(sessions.rows.map((r) => ({ key: r.key, ts: r.ts })), cursorTs),
        [sessions, cursorTs]
    );
```

Add the import:

```tsx
import { freshKeys } from "./freshrows";
```

- [ ] **Step 2: Accept and apply the flag on each row**

Add a `fresh: boolean` prop to the three row components and fold the class into their existing wrapper `cn(...)` calls — the class only adds `position: relative` plus a pseudo-element, so no layout changes.

`QueueRowView` (`:227`) — add `fresh` to its props and to the outer element's classes. Its wrapper already composes `base` and the cursor ring; add `fresh && "fresh-mark"` to that same `cn`.

`InitiativeRow` (`:336`) — add `fresh` to its props, then:

```tsx
            className={cn("rounded-[10px]", focused && CURSOR_RING, fresh && "fresh-mark")}
```

`SessionRow` (`:375`) — add `fresh` to its props. It renders a `<button>` or a `<div>` from the same `base`; add `fresh && "fresh-mark"` to both `cn` calls so an openable and a static session row mark identically.

Do **not** touch `PastRow` — `behind` is excluded.

- [ ] **Step 3: Pass it from the render**

At the three call sites, thread membership through:

```tsx
                                            fresh={freshWaiting.has(q.key)}
```
```tsx
                                        fresh={freshInitiatives.has(e.oref)}
```
```tsx
                                        fresh={freshSessions.has(r.key)}
```

- [ ] **Step 4: Add live entrances for the same three regions**

Wrap each region's row list so rows arriving *while you watch* animate in, while a whole-snapshot swap stays silent. Import at the top of the file:

```tsx
import { MotionConfig, motion } from "motion/react";
import { cardVariants, computeEntrances, initialEntranceState, MOTION } from "@/app/element/motiontokens";
```

(`AnimatePresence` is already imported at `:47`.)

Hold one entrance state per region in a ref, keyed on the snapshot's identity so a refresh reseeds silently rather than cascading:

```tsx
    // moment 2: only ids that arrive while the key is unchanged animate in. computeEntrances reseeds on
    // a key change, which is what stops a whole-snapshot refresh from firing N entrances at once.
    const entranceRef = useRef(initialEntranceState());
    const entering = useMemo(() => {
        const ids = [...queue.map((q) => q.key), ...effortWindow.rows.map((e) => e.oref), ...sessions.rows.map((r) => r.key)];
        const { animate, state } = computeEntrances(entranceRef.current, snapshot?.queryStartedAt?.toString(), ids);
        entranceRef.current = state;
        return animate;
    }, [queue, effortWindow, sessions, snapshot]);
```

Then wrap each of the three row lists' children in `AnimatePresence` + `motion.div`, e.g. for the waiting region:

```tsx
                            <MotionConfig reducedMotion="user">
                                <AnimatePresence initial={false}>
                                    {queue.map((q) => {
                                        const target = queueOpenTarget(q.nav);
                                        return (
                                            <motion.div
                                                key={q.key}
                                                layout
                                                variants={cardVariants}
                                                initial={entering.has(q.key) ? "initial" : false}
                                                animate="animate"
                                                exit="exit"
                                                transition={{ duration: MOTION.durMacro, ease: MOTION.easeFluid }}
                                            >
                                                <QueueRowView
                                                    row={q}
                                                    focused={cursor === `waiting:${q.key}`}
                                                    fresh={freshWaiting.has(q.key)}
                                                    onOpen={target == null ? undefined : () => openQueueTarget(model, target)}
                                                />
                                            </motion.div>
                                        );
                                    })}
                                </AnimatePresence>
                            </MotionConfig>
```

Apply the same wrapper to the initiatives and sessions lists. `layout` goes only on these row containers — never on text nodes inside them.

- [ ] **Step 5: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 6: Verify against a fixture**

With the dev app running:

```bash
node scripts/inject-live-agents.mjs
task verify:ui -- surface-smoke
```

Then in the app, open Jarvis with a populated fixture from the dev fixture bar.
Expected: on open, rows new since the cursor carry the fading leading rule and **nothing moves**; opening the tab fires no entrance cascade; pressing the Brief's refresh path does not replay the marks; a row that disappears animates out and the survivors slide up.

- [ ] **Step 7: Verify reduced motion**

Emulate `prefers-reduced-motion: reduce` and reopen Jarvis.
Expected: the leading rule is present but static; rows do not translate or scale.

- [ ] **Step 8: Commit**

```bash
git add frontend/app/view/jarvis/briefsurface.tsx
git commit -m "feat(jarvis): show what changed since you last looked

Rows new since the visit cursor carry a non-layout mark on open, and
rows arriving live animate in. Opening the tab still never cascades."
```

---

### Task 10: The waiting chip

**Files:**
- Modify: `frontend/app/view/jarvis/briefsurface.tsx:1188-1205` (the `data-jarvis-brief-band="waiting"` chip)

**Interfaces:**
- Consumes: `RollingCount` from `@/app/view/agents/rollingcount`.
- Produces: nothing.

- [ ] **Step 1: Add the transition and the rolling count**

The chip currently hard-swaps both its colors and its text. Add a color transition to the chip and the dot, and route the number through `RollingCount`. Import:

```tsx
import { RollingCount } from "@/app/view/agents/rollingcount";
```

Add `transition-colors duration-[140ms]` to the chip's `cn(...)` and to the dot's, and replace the label expression:

```tsx
                        {queue.length === 0 ? (
                            "all clear"
                        ) : (
                            <span className="flex items-center gap-1">
                                <RollingCount value={queue.length} /> waiting
                            </span>
                        )}
```

- [ ] **Step 2: Move the dot onto the shared pulse**

Replace the dot's generic Tailwind `animate-pulse` with the cockpit's own status pulse so the Brief and the cockpit signal "asking" identically:

```tsx
                                queue.length === 0
                                    ? "bg-success"
                                    : "animate-[pulseDot_1.8s_ease-in-out_infinite] bg-asking motion-reduce:animate-none"
```

- [ ] **Step 3: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 4: Verify**

In the dev app, switch between a fixture with an empty queue and one with items.
Expected: the chip's border/background/text cross-fade between green and amber rather than cutting; the number slides when it changes; the amber dot pulses on the same cadence as a cockpit asking dot.

- [ ] **Step 5: Commit**

```bash
git add frontend/app/view/jarvis/briefsurface.tsx
git commit -m "feat(jarvis): make the waiting chip's state change legible

all clear <-> N waiting cut between two colours and two numbers with
no transition; the dot now pulses on the shared cadence."
```

---

### Task 11: Expands and bands

**Files:**
- Modify: `frontend/app/view/jarvis/briefsurface.tsx` — `MoreControl`'s region bodies (`:1305`, `:1315`, `:1330`), the initiative card's expanded detail (via `InitiativeRow:336`), and the stale/error bands (`:1228`, `:1245`)

**Interfaces:**
- Consumes: `paneReveal` from `motiontokens`.
- Produces: nothing.

- [ ] **Step 1: Reveal the overflow rows**

Each region renders its capped rows then a `MoreControl`. The rows past the cap currently appear and vanish instantly when `expanded` flips. Wrap the overflow portion of each region's list so it expands rather than snaps. Since `capRegion` already returns only the shown rows, the reveal belongs to the rows the expansion adds — wrap them with `paneReveal`:

```tsx
import { paneReveal } from "@/app/element/motiontokens";
```

For each region, the rows beyond the cap render inside:

```tsx
                                <AnimatePresence initial={false}>
                                    {isOpen ? (
                                        <motion.div
                                            key="overflow"
                                            variants={paneReveal}
                                            initial="initial"
                                            animate="animate"
                                            exit="exit"
                                            className="flex flex-col gap-2.5 overflow-hidden"
                                        >
                                            {/* the rows the expansion added */}
                                        </motion.div>
                                    ) : null}
                                </AnimatePresence>
```

`overflow-hidden` is required — `paneReveal` animates `height`, and without it the content spills during the tween. Keep each region's own `gap-*` value (`gap-[9px]` waiting, `gap-2.5` initiatives, `gap-1` sessions, `gap-[5px]` behind) rather than unifying them.

- [ ] **Step 2: Reveal the initiative chunk detail**

`InitiativeRow` passes `expanded` into `EffortCard`. Wrap the detail `EffortCard` renders when expanded in the same `paneReveal` + `overflow-hidden` pattern, inside `effortcard.tsx` at its existing expanded branch. Read it first:

Run: `grep -n "expanded" frontend/app/view/jarvis/effortcard.tsx`

Wrap only the block that appears when `expanded` is true. Do not restructure the card.

- [ ] **Step 3: Reveal the stale and error bands**

Both bands push content down, so height belongs in their animation. Replace the `staleSnapshot ? (<div …>) : null` at `:1228` and the `loadFailed ? (<div …>) : null` at `:1245` with `AnimatePresence` + `motion.div` on `paneReveal`, keeping each band's existing classes and adding `overflow-hidden`:

```tsx
            <AnimatePresence initial={false}>
                {staleSnapshot ? (
                    <motion.div
                        key="stale"
                        variants={paneReveal}
                        initial="initial"
                        animate="animate"
                        exit="exit"
                        data-jarvis-brief-band="stale"
                        className="flex flex-none items-center gap-2 overflow-hidden border-b border-edge-faint px-[22px] py-1 font-mono text-[10px] text-error"
                    >
                        {/* contents unchanged */}
                    </motion.div>
                ) : null}
            </AnimatePresence>
```

- [ ] **Step 4: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 5: Verify**

In the dev app, click each region's `+N more` / `Show less`, expand an initiative card, and select the fixture that shows the stale band.
Expected: each expands and collapses smoothly with no content spilling outside its box mid-tween; the bands push content down as they open rather than appearing instantly.

- [ ] **Step 6: Commit**

```bash
git add frontend/app/view/jarvis/briefsurface.tsx frontend/app/view/jarvis/effortcard.tsx
git commit -m "feat(jarvis): expand the brief's disclosures instead of snapping

Region overflow, initiative detail and the stale/error bands all cut
in and out; they now reveal on the shared pane signature."
```

---

### Task 12: First paint and the composer thread

**Files:**
- Modify: `frontend/app/view/jarvis/briefsurface.tsx:1258-1270` (the `firstLoad` skeleton block) and the composer's turn list inside `BriefComposer:630`

**Interfaces:**
- Consumes: `cardVariants`, `modalBackdrop` (for its opacity-only signature), `MOTION` from `motiontokens`.
- Produces: nothing.

- [ ] **Step 1: Cross-fade the skeleton into content**

The `firstLoad` skeleton and the loaded regions swap instantly. Put both under one `AnimatePresence` with `mode="wait"` so the skeleton fades out before the content fades in, keyed so they are distinct children:

```tsx
                <AnimatePresence mode="wait" initial={false}>
                    {firstLoad ? (
                        <motion.div
                            key="skeleton"
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                            transition={{ duration: MOTION.durMicro, ease: MOTION.easeFluid }}
                            data-jarvis-brief-state="loading"
                            className="flex flex-col gap-[26px]"
                        >
                            {/* contents unchanged */}
                        </motion.div>
                    ) : null}
                </AnimatePresence>
```

Leave the `animate-pulse` skeleton blocks themselves alone — they already pulse and already carry `motion-reduce:animate-none`.

- [ ] **Step 2: Fade in the composer's turns**

In `BriefComposer`, the submitted turn, its answer, and the "Drew on" band appear instantly. Give each an opacity-only entrance with `initial={false}` at the presence boundary, so a restored thread does not replay every turn on mount:

```tsx
                <AnimatePresence initial={false}>
                    {exchanges.map((exchange) => (
                        <motion.div
                            key={exchange.key}
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            transition={{ duration: MOTION.durMicro, ease: MOTION.easeFluid }}
                        >
                            <TurnView exchange={exchange} model={model} />
                        </motion.div>
                    ))}
                </AnimatePresence>
```

Opacity only, no `layout` — these wrap prose, and animating layout on streaming text is the perf trap the cockpit spec calls out. Match the actual local variable name for the exchange list; read it first with `grep -n "exchange" frontend/app/view/jarvis/briefsurface.tsx`.

- [ ] **Step 3: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 4: Verify**

Clear dev data so the Brief loads cold (`task dev:cleardata`), open Jarvis and watch the first paint. Then ask Jarvis something in the composer.
Expected: the skeleton fades out and the regions fade in rather than cutting; a submitted turn and its answer fade in; collapsing and reopening the thread does not replay every turn.

- [ ] **Step 5: Commit**

```bash
git add frontend/app/view/jarvis/briefsurface.tsx
git commit -m "feat(jarvis): cross-fade first paint and the composer thread

The loading skeleton cut straight to content, and turns appeared with
no entry. Opacity only, so no layout animates on prose."
```

---

# Phase 3 — the avatar popup

Only the popup's interior. The hologram's own motion (`petmotion.ts`'s clocks, `petview.tsx:357`'s drag/dock springs) is deliberately untouched — spec §1 is a boundary, not a deferral.

### Task 13: Queue rows and act resolution

**Files:**
- Modify: `frontend/app/view/jarvis/petpeek.tsx` — the queue list (`:469`), `ActOutcome` (`:117`)

**Interfaces:**
- Consumes: `cardVariants`, `MOTION` from `motiontokens`. `PeekRow.key` is already stable (`petpeekmodel.ts:39`), so no key work is needed.
- Produces: nothing.

- [ ] **Step 1: Animate the queue list**

Wrap the queue rows so a row leaving as its act resolves animates out and the survivors close up:

```tsx
import { AnimatePresence, motion } from "motion/react";
import { cardVariants, MOTION } from "@/app/element/motiontokens";
```

```tsx
                                <AnimatePresence initial={false}>
                                    {rows.map((row) => (
                                        <motion.div
                                            key={row.key}
                                            layout
                                            variants={cardVariants}
                                            initial="initial"
                                            animate="animate"
                                            exit="exit"
                                            transition={{ duration: MOTION.durMacro, ease: MOTION.easeFluid }}
                                        >
                                            <QueueRow model={model} row={row} now={now} onLeave={leavePeek} />
                                        </motion.div>
                                    ))}
                                </AnimatePresence>
```

`initial={false}` on the presence boundary is what stops the whole list cascading each time the popup opens — the popup mounts fresh every time, so without it every row would animate in on every open.

- [ ] **Step 2: Fade in the outcome line**

`ActOutcome` returns `null` until an act resolves, then appears instantly. Give it an opacity entrance:

```tsx
    return (
        <motion.p
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: MOTION.durMicro, ease: MOTION.easeFluid }}
            className={cn(
                "font-mono text-[10.5px] leading-[1.45]",
                done.status === "error" ? "text-error" : "text-muted",
                className
            )}
        >
            {done.text}
        </motion.p>
    );
```

Leave `ActButton`'s in-place running caret exactly as it is — its comment explains it deliberately keeps the button's box the same size so nothing below shifts, and that is still right.

- [ ] **Step 3: Do not fight a closing popup**

`actLeavesPeek()` (`:70`) means some acts close the popup as they run. A row animating out of a tree that is unmounting would double-animate. Confirm by inspection that the row exit lives *inside* the `PopoverReveal` subtree — it does, so the popup's own exit wins and no guard is needed. Add no code for this; verify it in step 5.

- [ ] **Step 4: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 5: Verify**

In the dev app, open the avatar popup with queued items. Run an act that resolves in place (a `do` verb), and one that leaves the popup.
Expected: the in-place act shows its caret, then its outcome line fades in; a resolved row animates out and the rows below close up; an act that closes the popup produces one clean popup exit, not a row animation fighting it; opening the popup shows its rows immediately with no cascade.

- [ ] **Step 6: Commit**

```bash
git add frontend/app/view/jarvis/petpeek.tsx
git commit -m "feat(jarvis): make the avatar popup's queue resolve visibly

Rows vanished and outcome lines appeared instantly, so a resolved act
gave no feedback that anything had happened."
```

---

### Task 14: The drawer and the conditions

**Files:**
- Modify: `frontend/app/view/jarvis/petpeek.tsx` — the "Since you looked" drawer (`:494`), the conditions block (`:405`)

**Interfaces:**
- Consumes: `paneReveal`, `cardVariants` from `motiontokens`.
- Produces: nothing.

- [ ] **Step 1: Reveal the drawer**

`petpeek.tsx:494` is `{drawerOpen ? (<div className="max-h-[170px] overflow-y-auto …">…</div>) : null}` — a textbook snap. Replace with:

```tsx
                                    <AnimatePresence initial={false}>
                                        {drawerOpen ? (
                                            <motion.div
                                                key="updates"
                                                variants={paneReveal}
                                                initial="initial"
                                                animate="animate"
                                                exit="exit"
                                                className="overflow-hidden border-t border-border"
                                            >
                                                <div className="max-h-[170px] overflow-y-auto">
                                                    {/* UpdateRow list unchanged */}
                                                </div>
                                            </motion.div>
                                        ) : null}
                                    </AnimatePresence>
```

The scroll container moves to an inner div: `paneReveal` animates the outer height and needs `overflow-hidden`, which would otherwise fight `overflow-y-auto` on the same element and clip the scrollbar mid-tween.

- [ ] **Step 2: Animate the conditions**

The conditions block (`:405`) appears and disappears as standing levels come and go. Wrap each condition row so one clearing does not make the rest jump:

```tsx
                                        <AnimatePresence initial={false}>
                                            {conditions.map((condition, index) => (
                                                <motion.div
                                                    key={condition.expr.kind}
                                                    layout
                                                    variants={cardVariants}
                                                    initial="initial"
                                                    animate="animate"
                                                    exit="exit"
                                                    transition={{ duration: MOTION.durMacro, ease: MOTION.easeFluid }}
                                                >
                                                    {/* the existing condition row, unchanged */}
                                                </motion.div>
                                            ))}
                                        </AnimatePresence>
```

`condition.expr.kind` is already the existing `key`, so identity is unchanged.

- [ ] **Step 3: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 4: Verify**

Open the avatar popup and toggle "Since you looked" several times; pick a fixture where a condition clears.
Expected: the drawer expands and collapses smoothly, its scrollbar is not clipped mid-tween and it still scrolls when open; a clearing condition animates out and the rest close up.

- [ ] **Step 5: Commit**

```bash
git add frontend/app/view/jarvis/petpeek.tsx
git commit -m "feat(jarvis): reveal the popup's drawer and conditions

The since-you-looked drawer snapped open and conditions blinked out;
both now move on the shared pane and card signatures."
```

---

### Task 15: The unread marker

**Files:**
- Modify: `frontend/app/view/jarvis/petview.tsx` (the unread marker element only)

**Interfaces:**
- Consumes: the `pulseDot` keyframe (existing, `tailwindsetup.css:308`).
- Produces: nothing.

- [ ] **Step 1: Find the marker**

Run: `grep -n "petUnreadAtom\|unread" frontend/app/view/jarvis/petview.tsx`
The creature keeps an unread marker until you look (documented in `petbubble.tsx`'s header).

- [ ] **Step 2: Put it on the shared pulse**

Give the marker element the shared status pulse so an unread avatar signals on the same cadence as every other "needs you" dot in the cockpit:

```tsx
                        className={cn(
                            /* existing classes */,
                            "animate-[pulseDot_1.8s_ease-in-out_infinite] motion-reduce:animate-none"
                        )}
```

Change nothing else in this file. The drag/dock springs and the hologram's clocks are out of scope.

- [ ] **Step 3: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 4: Verify**

Trigger an utterance so the marker appears without opening the popup.
Expected: the marker pulses on the same cadence as a cockpit asking dot, and stops once you open the popup. Under reduced motion it is static but still visible.

- [ ] **Step 5: Commit**

```bash
git add frontend/app/view/jarvis/petview.tsx
git commit -m "feat(jarvis): pulse the avatar's unread marker

An unread marker that does not pulse reads as decoration next to the
cockpit's other needs-you dots."
```

---

### Task 16: The scenario and the final pass

**Files:**
- Modify: `scripts/cdp/scenarios.mjs` (add `jarvis-motion`)

**Interfaces:**
- Consumes: the harness helpers in `scripts/cdp/attach.mjs` and the shared jarvis drivers at `scenarios.mjs:358`.
- Produces: a repeatable `task verify:ui -- jarvis-motion` check.

- [ ] **Step 1: Read the harness conventions**

Run: `sed -n '100,175p' scripts/cdp/scenarios.mjs` and `sed -n '358,400p' scripts/cdp/scenarios.mjs`
Follow the existing arrange → goto → shot → assert → teardown shape and reuse the shared jarvis drivers rather than writing new navigation.

- [ ] **Step 2: Add the scenario**

Add a `jarvis-motion` scenario asserting the structural facts the moments depend on — not the animations themselves, which are not assertable. Assert that: the sheet mounts inside a `variant="sheet"` backdrop scoped to the Brief (`[data-jarvis-brief-sheet]` present and the app bar still hit-testable), at least one row carries `fresh-mark` for a fixture whose cursor is older than its rows, no row carries `fresh-mark` for a fixture whose rows all predate the cursor, and the popup's drawer toggles its updates list. Register it in the scenario list so `task verify:ui -- jarvis-motion` resolves.

- [ ] **Step 3: Run it**

Run: `task verify:ui -- jarvis-motion`
Expected: PASS table, exit 0, a contact sheet at `cdp-shots/index.html`.

- [ ] **Step 4: Run every check one final time**

```bash
npx vitest run
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit
task verify:ui -- surface-smoke jarvis-motion
```
Expected: all clean. Report actual output; if anything fails or was skipped, say so rather than claiming green.

- [ ] **Step 5: Self-review the whole diff**

Run: `git diff main...HEAD`
Check: no raw hex in any `className` or `style`; no commented-out code; no debug statements; no `layout` on a text node; every new CSS animation paired with a reduced-motion guard; no file touched that no task named.

- [ ] **Step 6: Log the deferred follow-up**

Add one entry to `docs/open-issues.md` recording that `briefpeekview.tsx`'s `open={recordId != null && pendingStatus == null}` yield-while-stacked workaround is now unnecessary (Task 2 fixed the underlying Escape bug) and can be unwound as its own change. Do not unwind it here.

- [ ] **Step 7: Commit**

```bash
git add scripts/cdp/scenarios.mjs docs/open-issues.md
git commit -m "test(jarvis): add the jarvis-motion CDP scenario

Locks the structural facts the motion pass depends on: sheet scoping,
fresh-mark presence against the visit cursor, drawer toggle."
```

---

## Plan Self-Review

**Spec coverage.** All sixteen moments map to tasks: 1 → Tasks 7-9; 2 → Task 9; 3 → Task 10; 4-6 → Task 11; 7-8 → Task 12; 9 → Tasks 3-4; 10 → Task 5; 11 → Tasks 1-2; 12-13 → Task 13; 14-15 → Task 14; 16 → Task 15. Spec §4's `variant` and `modalstack` are Tasks 1-3; §5's two new vocabulary items are Tasks 3 and 8; §8's 13-consumer regression pass is Task 6; §6's reduced-motion and no-cascade guards are verified in Tasks 6, 9 and 13. Spec §1's boundary is honored by scope: no task modifies `petmotion.ts` or `petview.tsx:357`.

**Three deliberate deviations**, all recorded in Planning Notes above with their reasons: freshness is a `Set` from a new pure helper rather than a field added by `projectBriefing`; `ShippedRow.fresh` is not folded in; spec §10's peek-key question is closed as already-satisfied rather than becoming a task. Spec §10's `FRESH_MARK_CAP` question is carried into Task 7 as a constant with its rationale, to be settled in Task 9's fixture pass.

**Type consistency.** `freshKeys(rows, cursor, cap?)` and `FreshCandidate {key, ts}` are used with those exact names in Tasks 7 and 9. `registerModal`/`isTopModal` in Tasks 1-2. `sheetPanel` in Task 3, consumed by `ModalShell` in the same task. `ModalVariant` is exported where Task 3 defines the maps. Row keys match their sources: `q.key`, `e.oref`, `r.key`, `row.key`, `condition.expr.kind`.

**Known soft spots**, flagged rather than hidden: Tasks 11, 12, 15 and 16 instruct a `grep`/`sed` read before editing because the exact local variable names and element boundaries in `effortcard.tsx`, `BriefComposer`, `petview.tsx`'s marker and the CDP scenario list were not fully read while writing this plan. Every other task quotes the real current code it replaces.
