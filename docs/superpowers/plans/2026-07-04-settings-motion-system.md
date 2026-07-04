# Settings Motion + Shared Popover Reveal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the Settings surface into the app-wide motion system and add a shared popover-reveal primitive, adopted across every live cockpit popover.

**Architecture:** One new motion token (`popoverReveal`) plus a tiny wrapper component (`<PopoverReveal>`) that owns AnimatePresence + reduced-motion + the transform-origin, wrapping only the panel (callers keep positioning + backdrop). Live cockpit popovers are retrofitted to it. Settings additionally gets a one-shot load reveal, a runtime→flag-list fade-on-swap, and a Save settle — all reusing existing tokens.

**Tech Stack:** React 19, Framer Motion (`motion/react` v12), Tailwind 4, jotai, vitest.

## Global Constraints

- **Motion source of truth:** all durations/eases come from `MOTION` in `frontend/app/element/motiontokens.ts`. Do NOT inline durations/eases/keyframes. Reuse `MOTION.durMacro` (0.36), `MOTION.durMicro` (0.14), `MOTION.easeFluid` (`[0.22, 1, 0.36, 1]`), and the existing CSS `settle` keyframe.
- **Opacity + scale only** for `popoverReveal` (never x/y — consistent with `cardVariants`).
- **Reduced motion always honored:** Framer via `MotionConfig reducedMotion="user"`; one-shot opacity reveals gated with `useReducedMotion()`; CSS keyframes with `motion-reduce:animate-none`.
- **`PopoverReveal` abstracts motion only** — never positioning. Callers keep their `absolute …`/z-index classes and any `fixed inset-0` backdrop click-catcher.
- **Out of scope (do NOT touch):** `frontend/app/element/popover.tsx`, `flyoutmenu.tsx`, `menubutton.tsx`, `emojipalette.tsx` (dead upstream — imported nowhere in the cockpit); legacy block views `term.tsx`, `waveconfig.tsx`, `preview-streaming.tsx`.
- **Framer import style:** `import { AnimatePresence, MotionConfig, motion } from "motion/react";`.
- **Git policy (overrides the skill's per-task commits):** do NOT commit per task. All changes batch into ONE commit at the very end (Task 9), which requires explicit user approval before running. Every task ends at verification (typecheck / vitest / CDP), not a commit.
- **Typecheck command (tsc stack-overflows on this repo — use node directly):** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`. Baseline is clean (exit 0); any error it reports is yours.
- **Visual verification (no jsdom render harness for the cockpit):** with the dev app running (`task dev`), capture with `node scripts/cdp-shot.mjs <out.png>`; inject data if needed via `node scripts/inject-live-agents.mjs <scenario>`.

---

### Task 1: `popoverReveal` motion token + test guard

**Files:**
- Modify: `frontend/app/element/motiontokens.ts` (add export after `composerReveal`, ~line 49)
- Test: `frontend/app/element/motiontokens.test.ts` (add import + a `describe` block)

**Interfaces:**
- Produces: `export const popoverReveal: Variants` — `initial {opacity:0, scale:0.96}`, `animate {opacity:1, scale:1, transition:{duration: MOTION.durMicro, ease: MOTION.easeFluid}}`, `exit {opacity:0, scale:0.96, transition:{duration: MOTION.durMicro, ease: MOTION.easeFluid}}`.

- [ ] **Step 1: Write the failing test**

Add to `frontend/app/element/motiontokens.test.ts` — extend the existing import on line 5 to include `popoverReveal`, then add this block after the `motiontokens` describe (after line 40):

```ts
describe("popoverReveal", () => {
    it("reveals opacity+scale only (never x/y), snappy in and out", () => {
        expect(popoverReveal.initial).not.toHaveProperty("x");
        expect(popoverReveal.initial).not.toHaveProperty("y");
        expect((popoverReveal.initial as { opacity: number }).opacity).toBe(0);
        expect((popoverReveal.initial as { scale: number }).scale).toBeCloseTo(0.96);
        expect((popoverReveal.animate as any).opacity).toBe(1);
        expect((popoverReveal.animate as any).scale).toBe(1);
        expect((popoverReveal.animate as any).transition.duration).toBeCloseTo(MOTION.durMicro);
        expect((popoverReveal.exit as any).transition.duration).toBeCloseTo(MOTION.durMicro);
        expect((popoverReveal.animate as any).transition.ease).toEqual(MOTION.easeFluid);
    });
});
```

The line-5 import becomes:

```ts
import { MOTION, cardVariants, computeEntrances, easeFluidCss, initialEntranceState, modalBackdrop, modalPanel, popoverReveal, shouldFadeEntry, reflowProps } from "./motiontokens";
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run frontend/app/element/motiontokens.test.ts`
Expected: FAIL — `popoverReveal` is `undefined` (import resolves to undefined), assertions throw.

- [ ] **Step 3: Add the token**

In `frontend/app/element/motiontokens.ts`, after the `composerReveal` block (after line 49), add:

```ts
// Popover / dropdown reveal. Opacity + scale only (never x/y — consistent with cardVariants); the
// panel scales from its anchor corner via a per-site transform-origin. Snappy in and out — a dropdown
// dismiss should not linger.
export const popoverReveal: Variants = {
    initial: { opacity: 0, scale: 0.96 },
    animate: { opacity: 1, scale: 1, transition: { duration: MOTION.durMicro, ease: MOTION.easeFluid } },
    exit: { opacity: 0, scale: 0.96, transition: { duration: MOTION.durMicro, ease: MOTION.easeFluid } },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run frontend/app/element/motiontokens.test.ts`
Expected: PASS (all describes green).

- [ ] **Step 5: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

---

### Task 2: `<PopoverReveal>` wrapper component

**Files:**
- Create: `frontend/app/element/popoverreveal.tsx`

**Interfaces:**
- Consumes: `popoverReveal` from `./motiontokens` (Task 1).
- Produces: `export function PopoverReveal(props: { open: boolean; origin: string; className?: string; children: ReactNode }): JSX.Element` — renders the animated panel only; caller supplies positioning via `className` and any backdrop separately.

- [ ] **Step 1: Create the component**

Create `frontend/app/element/popoverreveal.tsx`:

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Shared reveal for cockpit dropdown/popover panels. Wraps ONLY the panel: owns AnimatePresence, the
// reduced-motion config, the popoverReveal variant, and the transform-origin so the panel scales from
// its anchor corner. Positioning (absolute / z-index) and any backdrop click-catcher stay with the
// caller — they legitimately differ per site. Rendering must be UNCONDITIONAL (drive `open`) so the
// exit animation can play; a `{open ? <PopoverReveal/> : null}` caller defeats AnimatePresence.

import { AnimatePresence, MotionConfig, motion } from "motion/react";
import type { ReactNode } from "react";
import { popoverReveal } from "./motiontokens";

interface PopoverRevealProps {
    open: boolean;
    origin: string; // CSS transform-origin, e.g. "top right" / "bottom left"
    className?: string; // caller's positioning + styling classes for the panel
    children: ReactNode;
}

export function PopoverReveal({ open, origin, className, children }: PopoverRevealProps) {
    return (
        <MotionConfig reducedMotion="user">
            <AnimatePresence>
                {open && (
                    <motion.div
                        variants={popoverReveal}
                        initial="initial"
                        animate="animate"
                        exit="exit"
                        style={{ transformOrigin: origin }}
                        className={className}
                    >
                        {children}
                    </motion.div>
                )}
            </AnimatePresence>
        </MotionConfig>
    );
}
```

- [ ] **Step 2: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0. (No unit test — the cockpit has no jsdom render harness; the component is exercised by Task 3's CDP verification.)

---

### Task 3: Adopt `PopoverReveal` in the Settings term-theme dropdown (first adopter)

**Files:**
- Modify: `frontend/app/view/agents/settingssurface.tsx` (add import; `TermThemeDropdown`, lines 515-558)

**Interfaces:**
- Consumes: `PopoverReveal` (Task 2).

- [ ] **Step 1: Add the import**

At the top of `frontend/app/view/agents/settingssurface.tsx`, add with the other `@/app/element` / local imports:

```tsx
import { PopoverReveal } from "@/app/element/popoverreveal";
```

- [ ] **Step 2: Replace the dropdown open block**

In `TermThemeDropdown`, replace the entire `{open ? ( ... ) : null}` block (lines 515-558) with — backdrop stays a plain conditional, panel moves into `PopoverReveal`:

```tsx
            {open ? (
                <button
                    type="button"
                    aria-hidden
                    tabIndex={-1}
                    onClick={() => setOpen(false)}
                    className="fixed inset-0 z-10 cursor-default"
                />
            ) : null}
            <PopoverReveal
                open={open}
                origin="top right"
                className="absolute right-0 top-[calc(100%+6px)] z-20 min-w-[220px] rounded-[11px] border border-border bg-surface p-[5px] shadow-[0_12px_34px_rgba(0,0,0,0.5)]"
            >
                {options.map((o) => {
                    const sel = o.value === value;
                    return (
                        <button
                            key={o.value}
                            type="button"
                            onClick={() => {
                                onChange(o.value);
                                setOpen(false);
                            }}
                            className={cn(
                                "flex w-full cursor-pointer items-center gap-2.5 rounded-[8px] px-[9px] py-2 text-left transition-colors hover:bg-surface-hover",
                                sel ? "bg-surface-raised" : "bg-transparent"
                            )}
                        >
                            <span className="flex flex-none gap-0.5">
                                {o.swatch.map((c, i) => (
                                    <span key={i} className="h-[11px] w-[11px] rounded-[3px]" style={{ background: c }} />
                                ))}
                            </span>
                            <span className="flex-1 whitespace-nowrap text-[12.5px] font-semibold text-primary">
                                {o.label}
                            </span>
                            {sel ? (
                                <span className="flex-none text-accent">
                                    <CheckIcon />
                                </span>
                            ) : null}
                        </button>
                    );
                })}
            </PopoverReveal>
```

- [ ] **Step 3: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 4: Visual verification**

With the dev app running, open Settings → Terminal → Color scheme dropdown. Capture open + closing:
Run: `node scripts/cdp-shot.mjs settings-dropdown.png`
Expected: dropdown scales/fades in from the top-right corner (~140ms), closes with a fade-out. With OS "reduce motion" on, it fades without scaling.

---

### Task 4: Settings surface moments — load reveal, runtime crossfade, Save settle

**Files:**
- Modify: `frontend/app/view/agents/settingssurface.tsx` (`SettingsSurface` root; `NewAgentDefaultsSection`; `MemorySection`; imports)

**Interfaces:**
- Consumes: `MOTION`, `composerReveal` unused here; uses `MOTION` + Framer `motion`, `MotionConfig`, `useReducedMotion`.

- [ ] **Step 1: Add imports**

Add to `frontend/app/view/agents/settingssurface.tsx`:

```tsx
import { MOTION } from "@/app/element/motiontokens";
import { MotionConfig, motion, useReducedMotion } from "motion/react";
```

- [ ] **Step 2: Load reveal + MotionConfig on the surface root**

Replace `SettingsSurface` (lines 33-55) with:

```tsx
export function SettingsSurface(_props: { model: AgentsViewModel }) {
    const reduce = useReducedMotion();
    return (
        <MotionConfig reducedMotion="user">
            <div className="flex h-full flex-col overflow-y-auto bg-background px-10 py-9">
                <motion.div
                    className="mx-auto w-full max-w-[720px]"
                    initial={reduce ? false : { opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ duration: MOTION.durMacro, ease: MOTION.easeFluid }}
                >
                    <h1 className="text-[26px] font-extrabold tracking-[-0.025em] text-primary">Settings</h1>
                    <p className="mb-9 mt-1.5 text-[13.5px] text-muted">
                        Cockpit preferences, appearance, and New Agent defaults.
                    </p>
                    <AppearanceSection />
                    <SectionGap />
                    <FontsSection />
                    <SectionGap />
                    <GeneralSection />
                    <SectionGap />
                    <NewAgentDefaultsSection />
                    <SectionGap />
                    <TerminalSection />
                    <SectionGap />
                    <MemorySection />
                </motion.div>
            </div>
        </MotionConfig>
    );
}
```

Note: single container fade — no per-section stagger (honors the no-cascade north star).

- [ ] **Step 3: Runtime → flag-list fade-on-swap**

In `NewAgentDefaultsSection`, replace the flag-list card (lines 433-474, the `<div className="rounded-[14px] border border-border bg-surface px-4 py-1.5">…</div>`) with a keyed `motion.div` so switching runtime remounts and fades the new list in (height snaps once — flag lists are similar length; the surface-root `MotionConfig` neutralizes it under reduced motion):

```tsx
            <motion.div
                key={runtime}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: MOTION.durMicro, ease: MOTION.easeFluid }}
                className="rounded-[14px] border border-border bg-surface px-4 py-1.5"
            >
                {catalog.map((f, i) => {
                    const on = !!runtimeFlags[f.id];
                    return (
                        <button
                            key={f.id}
                            type="button"
                            onClick={() => setFlag(f.id, !on)}
                            className={cn(
                                "flex w-full cursor-pointer items-center gap-3 py-3 text-left",
                                i > 0 && "border-t border-edge-faint"
                            )}
                        >
                            <span
                                className={cn(
                                    "flex h-[17px] w-[17px] flex-none items-center justify-center rounded-[5px] border-[1.5px] text-background",
                                    on ? "border-accent bg-accent" : "border-edge-strong"
                                )}
                            >
                                {on ? <CheckIcon /> : null}
                            </span>
                            <span
                                className={cn(
                                    "flex-none font-mono text-[12.5px] font-semibold",
                                    on ? "text-accent" : "text-primary"
                                )}
                            >
                                {f.flag}
                            </span>
                            <span className="flex-1" />
                            <span
                                className={cn(
                                    "text-right text-[12px] font-medium",
                                    on ? "text-accent-soft" : "text-muted"
                                )}
                            >
                                {f.desc}
                            </span>
                        </button>
                    );
                })}
            </motion.div>
```

- [ ] **Step 4: Memory Save settle**

In `MemorySection`, add a one-shot `settle` (moment 4) to the Save button when it flips to saved. Change the button's `className` (lines 681-686) to append the settle class keyed on `showSaved` (mirrors the `justFinished` idiom in `agentrow.tsx:295`):

```tsx
                    className={cn(
                        "shrink-0 rounded-[9px] border px-[18px] text-[13px] font-semibold transition-colors",
                        showSaved
                            ? "border-success/40 bg-success/[0.14] text-success-soft animate-[settle_0.5s_ease-out] motion-reduce:animate-none"
                            : "border-edge-mid bg-surface-raised text-secondary hover:border-edge-strong"
                    )}
```

- [ ] **Step 5: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 6: Visual verification**

With the dev app running: navigate to Settings (observe the one-shot fade-in of the panel), switch runtime tabs in New Agent Defaults (new flag list fades in), and press Save in Memory after editing the vault path (button settles once).
Run: `node scripts/cdp-shot.mjs settings-moments.png`
Expected: load fade on entry; flag list fades on runtime switch; Save button plays a single settle. Under OS reduce-motion, entry is instant and no settle.

---

### Task 5: Retrofit the project switcher dropdown

**Files:**
- Modify: `frontend/app/view/agents/projectswitcher.tsx` (import; open block, lines 61-200)

**Interfaces:**
- Consumes: `PopoverReveal` (Task 2).

- [ ] **Step 1: Add the import**

```tsx
import { PopoverReveal } from "@/app/element/popoverreveal";
```

- [ ] **Step 2: Convert the open block**

Replace the opening of the `{open ? ( <> <backdrop/> <panel …> ` (lines 61-64) so the backdrop stays conditional and the panel becomes a `PopoverReveal`. Concretely, replace lines 61-64:

```tsx
            {open ? (
                <>
                    <div className="fixed inset-0 z-50" onClick={close} />
                    <div className="absolute left-0 top-[calc(100%+7px)] z-[60] w-[268px] overflow-hidden rounded-[12px] border border-edge-strong bg-surface-raised shadow-popover">
```

with:

```tsx
            {open ? <div className="fixed inset-0 z-50" onClick={close} /> : null}
            <PopoverReveal
                open={open}
                origin="top left"
                className="absolute left-0 top-[calc(100%+7px)] z-[60] w-[268px] overflow-hidden rounded-[12px] border border-edge-strong bg-surface-raised shadow-popover"
            >
```

- [ ] **Step 3: Close the new element**

The panel `</div>` plus the fragment close `</>` and the ternary `) : null}` at lines 198-200 become a single `</PopoverReveal>`. Replace lines 198-200:

```tsx
                    </div>
                </>
            ) : null}
```

with:

```tsx
            </PopoverReveal>
```

(The panel's inner content — "Switch project" header, the list, and the "New project" footer button — is unchanged and now sits inside `PopoverReveal`.)

- [ ] **Step 4: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 5: Visual verification**

With the dev app running, open the project switcher (app-bar `/ name ▾` and the header button). Capture:
Run: `node scripts/cdp-shot.mjs projectswitcher.png`
Expected: menu scales/fades from the top-left, closes with a fade-out; selecting or clicking the backdrop dismisses it.

---

### Task 6: Retrofit the Files source picker dropdown

**Files:**
- Modify: `frontend/app/view/agents/filessurface.tsx` (import; `SourcePicker` open block, lines 77-126)

**Interfaces:**
- Consumes: `PopoverReveal` (Task 2).

- [ ] **Step 1: Add the import**

```tsx
import { PopoverReveal } from "@/app/element/popoverreveal";
```

- [ ] **Step 2: Convert the open block**

Replace lines 77-80:

```tsx
            {open && hasAny ? (
                <>
                    <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
                    <div className="absolute left-0 right-0 top-full z-20 mt-1 max-h-[280px] overflow-y-auto rounded-[8px] border border-border bg-modalbg py-1 shadow-popover">
```

with:

```tsx
            {open && hasAny ? <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} /> : null}
            <PopoverReveal
                open={open && hasAny}
                origin="top"
                className="absolute left-0 right-0 top-full z-20 mt-1 max-h-[280px] overflow-y-auto rounded-[8px] border border-border bg-modalbg py-1 shadow-popover"
            >
```

- [ ] **Step 3: Close the new element**

Replace lines 124-126:

```tsx
                    </div>
                </>
            ) : null}
```

with:

```tsx
            </PopoverReveal>
```

(The Agents/Projects grouped list content is unchanged, now inside `PopoverReveal`.)

- [ ] **Step 4: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 5: Visual verification**

With the dev app running and at least one agent/project present, open the Files surface source picker. Capture:
Run: `node scripts/cdp-shot.mjs filessource.png`
Expected: list fades/scales from the top edge; closes with a fade-out.

---

### Task 7: Retrofit the New Agent modal — branch picker (popover) + flag menu (inline)

**Files:**
- Modify: `frontend/app/view/agents/newagentmodal.tsx` (imports; flag menu block, lines 385-442; branch picker block, lines 495-526)

**Interfaces:**
- Consumes: `PopoverReveal` (Task 2), `composerReveal` from `motiontokens` (existing).

**Note:** the flag menu (`flagMenuOpen`) is an **inline, in-flow** expanding block (`mt-2`, not absolute), so it uses `composerReveal` (height+opacity, moment 6) — NOT `popoverReveal`. The branch picker (`branchListOpen`) is a true floating popover (`absolute bottom-full`), so it uses `PopoverReveal` with a bottom origin. Both sit inside `ModalShell`, whose `MotionConfig reducedMotion="user"` already covers them.

- [ ] **Step 1: Add imports**

```tsx
import { PopoverReveal } from "@/app/element/popoverreveal";
import { composerReveal } from "@/app/element/motiontokens";
import { AnimatePresence, motion } from "motion/react";
```

- [ ] **Step 2: Animate the flag menu (inline reveal)**

Replace the flag menu block (lines 385-442), `{flagMenuOpen ? ( <div className="mt-2 …"> … </div> ) : null}`, with an `AnimatePresence` + `composerReveal` wrapper (keep `overflow-hidden` so the height animation clips cleanly):

```tsx
                            <AnimatePresence>
                                {flagMenuOpen && (
                                    <motion.div
                                        variants={composerReveal}
                                        initial="initial"
                                        animate="animate"
                                        exit="exit"
                                        className="mt-2 overflow-hidden rounded-[10px] border border-edge-mid bg-surface"
                                    >
                                        <div className="flex items-center gap-2 border-b border-edge-faint px-[11px] py-2">
                                            <span className="font-mono text-[12px] font-semibold text-success">/</span>
                                            <input
                                                value={flagQuery}
                                                onChange={(e) => setFlagQuery(e.target.value)}
                                                placeholder="Search flags…"
                                                className="flex-1 bg-transparent font-mono text-[12px] text-secondary outline-none"
                                            />
                                            <span className="whitespace-nowrap font-mono text-[10px] text-muted">
                                                {flagCatalog.length} for {RUNTIMES.find((r) => r.id === runtime)?.name}
                                            </span>
                                        </div>
                                        <div className="max-h-[158px] overflow-y-auto p-[5px]">
                                            {menuFlags.length === 0 ? (
                                                <div className="p-[14px] text-center text-[11.5px] text-muted">
                                                    No matching flags
                                                </div>
                                            ) : (
                                                menuFlags.map((f) => {
                                                    const on = !!runtimeFlags[f.id];
                                                    return (
                                                        <button
                                                            key={f.id}
                                                            type="button"
                                                            onClick={() => setFlag(f.id, !on)}
                                                            className={cn(
                                                                "flex w-full cursor-pointer items-center gap-[10px] rounded-[7px] px-[9px] py-[7px] text-left hover:bg-surface-hover",
                                                                on ? "bg-accentbg" : ""
                                                            )}
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
                                                            <span className="flex-1 truncate text-right text-[11px] text-muted">
                                                                {f.desc}
                                                            </span>
                                                        </button>
                                                    );
                                                })
                                            )}
                                        </div>
                                    </motion.div>
                                )}
                            </AnimatePresence>
```

- [ ] **Step 3: Animate the branch picker (floating popover)**

Replace the branch picker block (lines 495-526), `{branchListOpen && branches.length > 0 ? ( <div className="absolute bottom-full …"> … </div> ) : null}`, with a `PopoverReveal` (bottom origin, since it opens upward):

```tsx
                                    <PopoverReveal
                                        open={branchListOpen && branches.length > 0}
                                        origin="bottom left"
                                        className="absolute bottom-full left-0 right-0 z-10 mb-1 max-h-[168px] overflow-y-auto rounded-[8px] border border-edge-mid bg-modalbg py-1 shadow-popover"
                                    >
                                        {branches.map((b) => (
                                            <button
                                                key={b.name}
                                                type="button"
                                                onClick={() => {
                                                    setBranch(b.name);
                                                    setBranchEdited(true);
                                                    setBranchListOpen(false);
                                                }}
                                                className={cn(
                                                    "flex w-full cursor-pointer items-center gap-2 px-3 py-[7px] text-left hover:bg-surface-hover",
                                                    b.name === effectiveBranch ? "text-primary" : "text-secondary"
                                                )}
                                            >
                                                <span
                                                    className={cn(
                                                        "h-[6px] w-[6px] shrink-0 rounded-full",
                                                        b.name === effectiveBranch ? "bg-accent" : "bg-muted"
                                                    )}
                                                />
                                                <span className="flex-1 truncate font-mono text-[12px]">
                                                    {b.name}
                                                </span>
                                                {b.age ? (
                                                    <span className="shrink-0 text-[10.5px] text-muted">{b.age}</span>
                                                ) : null}
                                            </button>
                                        ))}
                                    </PopoverReveal>
```

- [ ] **Step 4: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 5: Visual verification**

With the dev app running, open New Agent (⌘/Ctrl New agent). Toggle "Add flag" (inline menu expands/collapses in height) and, with a git project + worktree enabled, focus the branch field (picker reveals upward from the bottom edge). Capture:
Run: `node scripts/cdp-shot.mjs newagent-menus.png`
Expected: flag menu expands/collapses smoothly; branch picker scales/fades from its bottom-left corner.

---

### Task 8: Retrofit the Agent-row task popover

**Files:**
- Modify: `frontend/app/view/agents/agentrow.tsx` (import; `TaskPopover`, lines 48-108; caller, lines 376-385)

**Interfaces:**
- Consumes: `PopoverReveal` (Task 2).

**Note:** `TaskPopover` currently owns its own `absolute` positioning + `onClick` stopPropagation. Split it: positioning moves to `PopoverReveal` (so the exit animation can play — `PopoverReveal` must render unconditionally with an `open` prop), `TaskPopover` keeps a plain wrapper `div` with `onClick` stopPropagation for its content.

- [ ] **Step 1: Add the import**

```tsx
import { PopoverReveal } from "@/app/element/popoverreveal";
```

- [ ] **Step 2: Strip positioning from `TaskPopover`**

Replace the `TaskPopover` outer element (lines 61-65):

```tsx
    return (
        <div
            onClick={(e) => e.stopPropagation()}
            className="absolute right-2.5 top-[46px] z-30 max-h-[calc(100%-116px)] w-[min(282px,calc(100%-20px))] overflow-y-auto rounded-[11px] border border-edge-strong bg-surface-raised p-3 shadow-[0_18px_44px_rgba(0,0,0,0.55)]"
        >
```

with a plain content wrapper (positioning now lives on the caller's `PopoverReveal`):

```tsx
    return (
        <div onClick={(e) => e.stopPropagation()}>
```

(The inner content — header row, progress bar, task list — and the closing `</div>` at line 106 are unchanged.)

- [ ] **Step 3: Wrap the caller in `PopoverReveal`**

Replace the caller block (lines 376-385):

```tsx
            {/* task popover (placeholder) */}
            {tasksOpen && tasks && prog ? (
                <TaskPopover
                    tasks={tasks}
                    done={prog.done}
                    total={prog.total}
                    pct={prog.pct}
                    onClose={() => setTasksOpen(false)}
                />
            ) : null}
```

with (rendered unconditionally so the exit animation plays; children guard against null tasks/prog):

```tsx
            {/* task popover */}
            <PopoverReveal
                open={tasksOpen && !!tasks && !!prog}
                origin="top right"
                className="absolute right-2.5 top-[46px] z-30 max-h-[calc(100%-116px)] w-[min(282px,calc(100%-20px))] overflow-y-auto rounded-[11px] border border-edge-strong bg-surface-raised p-3 shadow-[0_18px_44px_rgba(0,0,0,0.55)]"
            >
                {tasks && prog ? (
                    <TaskPopover
                        tasks={tasks}
                        done={prog.done}
                        total={prog.total}
                        pct={prog.pct}
                        onClose={() => setTasksOpen(false)}
                    />
                ) : null}
            </PopoverReveal>
```

- [ ] **Step 4: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 5: Visual verification**

With the dev app running and an agent that has a task list, click the `done/total` task chip on its card. Capture:
Run: `node scripts/cdp-shot.mjs taskpopover.png`
Expected: popover scales/fades from the top-right; closes (✕ or reopening) with a fade-out. Verify clicking inside it does not trigger the card's own click handler (stopPropagation preserved).

---

### Task 9: Tracker update + single approval-gated commit

**Files:**
- Modify: `docs/superpowers/animation-revamp-tracker.md`

- [ ] **Step 1: Add the Settings surface row**

In the surface rollout table, add after the Usage row:

```markdown
| Settings | ✅ Shipped (2026-07-04) | One-shot load reveal (container fade, `useReducedMotion` gated, no cascade), runtime→flag-list fade-on-swap (m5 idiom), Memory Save settle (m4). New shared popover primitive `popoverReveal` + `<PopoverReveal>` adopted across all live cockpit popovers (Settings term-theme, project switcher, Files source picker, New Agent branch picker; New Agent flag menu uses `composerReveal` as an inline reveal; Agent-row task popover). `<MotionConfig reducedMotion="user">` at root. SHA `<fill after commit>`. |
```

- [ ] **Step 2: Note the primitive in the shared-foundation table**

In the "Shared foundation" table, update the `motiontokens.ts` row to mention `popoverReveal`, and add a row:

```markdown
| `frontend/app/element/popoverreveal.tsx` | Shared dropdown/popover reveal (`AnimatePresence` + `popoverReveal` variant + per-site transform-origin). Wraps the panel only; callers own positioning + backdrop. Adopted across all live cockpit popovers. |
```

- [ ] **Step 3: Add spec + plan references**

In the References list, add:

```markdown
- Settings motion design spec: `docs/superpowers/specs/2026-07-04-settings-motion-design.md`
- Settings motion implementation plan: `docs/superpowers/plans/2026-07-04-settings-motion-system.md`
```

- [ ] **Step 4: Full verification before commit**

Run: `npx vitest run frontend/app/element/motiontokens.test.ts`
Expected: PASS.
Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 5: Present the commit for approval (per repo git policy — do NOT commit without explicit approval)**

Show the user the file list (M/A) with a one-line change summary each and the proposed message, then ask: "Awaiting approval. Proceed? (yes/no)". Proposed message:

```
feat(motion): settings surface motion + shared popover reveal primitive
```

On approval, run:

```bash
git add frontend/app/element/motiontokens.ts frontend/app/element/motiontokens.test.ts frontend/app/element/popoverreveal.tsx frontend/app/view/agents/settingssurface.tsx frontend/app/view/agents/projectswitcher.tsx frontend/app/view/agents/filessurface.tsx frontend/app/view/agents/newagentmodal.tsx frontend/app/view/agents/agentrow.tsx docs/superpowers/animation-revamp-tracker.md docs/superpowers/specs/2026-07-04-settings-motion-design.md docs/superpowers/plans/2026-07-04-settings-motion-system.md
git commit -m "feat(motion): settings surface motion + shared popover reveal primitive"
```

Then fill the real SHA into the tracker's Settings row (amend or a follow-up doc commit, matching the tracker convention seen in prior motion commits).

---

## Self-Review

**Spec coverage:**
- `popoverReveal` token → Task 1. ✅
- `<PopoverReveal>` wrapper → Task 2. ✅
- Retrofit live popovers: Settings term-theme (Task 3), project switcher (Task 5), Files source picker (Task 6), New Agent branch picker (Task 7), Agent-row task popover (Task 8). ✅ Flag menu corrected from "popover" to inline `composerReveal` (Task 7) — documented deviation from the spec table, which described it as a popover before the code was read.
- Settings load reveal + MotionConfig, runtime crossfade, Save settle → Task 4. ✅
- Theme preset recolor stays instant → not animated (no task needed). ✅
- Token test guard → Task 1. ✅
- Tracker update (Settings row + foundation note + references) → Task 9. ✅
- Excluded dead upstream + legacy block views → Global Constraints. ✅

**Placeholder scan:** No TBD/TODO. Every code step shows full code. The only deferred value is the commit SHA in the tracker (Task 9 Step 6), which is intrinsically post-commit.

**Type consistency:** `PopoverReveal({ open, origin, className, children })` used identically in Tasks 3, 5, 6, 7, 8. `popoverReveal` variant name consistent across Tasks 1, 2, and the test. `composerReveal` (existing) used for the inline flag menu in Task 7. `MOTION.durMicro`/`durMacro`/`easeFluid` consistent throughout.
