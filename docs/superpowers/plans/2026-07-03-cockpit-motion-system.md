# Cockpit Motion System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a coherent, functional-first motion layer to the Cockpit tab — eight state-change moments built on one shared token module, in the Fluid feel chosen during brainstorming.

**Architecture:** Framer Motion (`motion/react`, v12 — already used for `Reorder`) is the default tool; CSS is used only for ambient loops (breathing glow, `pulseDot`) and existing micro-transitions. A single `frontend/app/element/motiontokens.ts` holds durations, easing, and variant presets. Reduced-motion is honored globally via `<MotionConfig reducedMotion="user">` plus `motion-reduce:` CSS variants. Entrance cascade on tab-open is prevented with `<AnimatePresence initial={false}>`.

**Tech Stack:** React 19, `motion` v12, Tailwind v4 (`@theme` tokens), vitest. Design spec: `docs/superpowers/specs/2026-07-03-cockpit-motion-system-design.md`.

**Git policy (overrides the writing-plans default):** Do **not** commit per task. Each task ends with a verification checkpoint only. The final task produces one batched commit, and only after the user explicitly approves the diff + message.

**Typecheck command (repo gotcha — `npx tsc` stack-overflows):**
`node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` — baseline is clean (exit 0); any error is yours.

**Visual verification (CDP):** the dev app renders in WebView2 which speaks CDP on `:9222` (dev-only flag in `src-tauri/src/main.rs`). Run the dev app as `tail -f /dev/null | task dev` (headless `task dev` dies on stdin EOF). Inject fixtures with `node scripts/inject-live-agents.mjs <scenario>`; screenshot with `node scripts/cdp-shot.mjs out.png`. To re-render after a data change use a CDP `location.reload()` (safe on Tauri) — do **not** use CDP `Page.reload` (breaks Tauri boot). CSS/TS edits under `frontend/` hot-reload via Vite; no reload needed for those.

---

## File structure

| File | Responsibility |
|---|---|
| `frontend/app/element/motiontokens.ts` | **New.** Single source of truth: durations, easing, `cardVariants`, `reorderLift`, `composerReveal`, and the `shouldFadeEntry` narration helper. |
| `frontend/app/element/motiontokens.test.ts` | **New.** Unit tests for token values + `shouldFadeEntry`. |
| `frontend/tailwindsetup.css` | Add `@keyframes breatheGlow` (asking) + `@keyframes settle` (finished), token-colored. `pulseDot` unchanged. |
| `frontend/app/view/agents/statusdot.tsx` | Add `transition-colors` for state color changes; `motion-reduce` guard on the pulse. |
| `frontend/app/view/agents/cockpitsurface.tsx` | Wrap the returned tree in `<MotionConfig reducedMotion="user">`; wrap the card `.map` in `<AnimatePresence mode="popLayout" initial={false}>`. |
| `frontend/app/view/agents/agentrow.tsx` | `Reorder.Item` gets enter/exit variants + `whileDrag` lift (moments 1/2/8); breathing-glow class when asking (moment 3); finished-settle one-shot on working→idle (moment 4); animated composer reveal (moment 6); unify the feed activity `pulseDot` duration (moment 7). |
| `frontend/app/view/agents/narrationtimeline.tsx` | New message/user rows fade in via `<AnimatePresence initial={false}>` + `shouldFadeEntry` (moment 5). |

---

## Task 1: Motion tokens module + tests

**Files:**
- Create: `frontend/app/element/motiontokens.ts`
- Test: `frontend/app/element/motiontokens.test.ts`

- [ ] **Step 1: Write the failing test**

Create `frontend/app/element/motiontokens.test.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { MOTION, cardVariants, shouldFadeEntry } from "./motiontokens";

describe("motiontokens", () => {
    it("uses the Fluid feel: macro ~360ms on the chosen ease curve", () => {
        expect(MOTION.durMacro).toBeCloseTo(0.36);
        expect(MOTION.durExit).toBeLessThan(MOTION.durMacro); // exits leave quicker
        expect(MOTION.easeFluid).toEqual([0.22, 1, 0.36, 1]);
    });

    it("card entrance animates opacity/scale only (never x/y — Reorder owns the transform)", () => {
        expect(cardVariants.initial).not.toHaveProperty("y");
        expect(cardVariants.initial).not.toHaveProperty("x");
        expect(cardVariants.initial.opacity).toBe(0);
        expect(cardVariants.animate.opacity).toBe(1);
    });

    it("only narrates message/user entries — tool bursts do not fade (burst guard)", () => {
        expect(shouldFadeEntry("message")).toBe(true);
        expect(shouldFadeEntry("user")).toBe(true);
        expect(shouldFadeEntry("action")).toBe(false);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run frontend/app/element/motiontokens.test.ts`
Expected: FAIL — `Cannot find module './motiontokens'`.

- [ ] **Step 3: Write minimal implementation**

Create `frontend/app/element/motiontokens.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Single source of truth for cockpit motion. Feel = "Fluid" (calm): macro moments
// ~360ms on a gentle ease-out; micro-interactions stay fast. See
// docs/superpowers/specs/2026-07-03-cockpit-motion-system-design.md.
import type { Variants } from "motion/react";

export const MOTION = {
    durMacro: 0.36, // entrances, reflow
    durMicro: 0.14, // feedback, composer reveal
    durExit: 0.28, // exits leave a touch quicker than they arrive
    easeFluid: [0.22, 1, 0.36, 1] as [number, number, number, number],
} as const;

// Card entrance/exit. IMPORTANT: opacity + scale only — never x/y. Reorder.Item
// owns the x/y transform for drag + reorder; animating y here fights it.
export const cardVariants: Variants = {
    initial: { opacity: 0, scale: 0.97 },
    animate: { opacity: 1, scale: 1, transition: { duration: MOTION.durMacro, ease: MOTION.easeFluid } },
    exit: { opacity: 0, scale: 0.96, transition: { duration: MOTION.durExit, ease: MOTION.easeFluid } },
};

// Lift on grab (moment 8). Drop-settle is the Reorder.Item dragTransition already in place.
// Black shadow alpha (not a brand color) — matches the existing shadow-[...rgba(0,0,0,...)] usage.
export const reorderLift = { scale: 1.02, boxShadow: "0 12px 30px rgba(0,0,0,0.45)" };

// Composer reveal (moment 6): expand height + fade in.
export const composerReveal: Variants = {
    initial: { opacity: 0, height: 0 },
    animate: { opacity: 1, height: "auto", transition: { duration: MOTION.durMicro, ease: MOTION.easeFluid } },
    exit: { opacity: 0, height: 0, transition: { duration: MOTION.durMicro, ease: MOTION.easeFluid } },
};

// Narration burst guard (moment 5): only prose/user turns fade in. Tool-action bursts
// never animate, so a fast stream of tool lines cannot strobe.
const NARRATED_KINDS = new Set(["message", "user"]);
export function shouldFadeEntry(kind: string): boolean {
    return NARRATED_KINDS.has(kind);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run frontend/app/element/motiontokens.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Checkpoint (no commit)**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0. Stage nothing yet.

---

## Task 2: CSS keyframes for the breathing glow + finished settle

**Files:**
- Modify: `frontend/tailwindsetup.css` (after the `@keyframes pulseDot` block, ~line 223)

- [ ] **Step 1: Add the keyframes**

In `frontend/tailwindsetup.css`, immediately after the closing brace of `@keyframes pulseDot` (currently ends ~line 223), insert:

```css
/* Asking attention (moment 3): a slow, persistent amber breathing glow. drop-shadow
   (not box-shadow) so it never clashes with the card's cursor-ring box-shadow, and
   is not clipped by the card's overflow-hidden. Amber comes from the status token. */
@keyframes breatheGlow {
    0%,
    100% {
        filter: drop-shadow(0 0 2px color-mix(in oklab, var(--color-warning) 30%, transparent));
    }
    50% {
        filter: drop-shadow(0 0 10px color-mix(in oklab, var(--color-warning) 55%, transparent));
    }
}

/* Finished settle (moment 4): a single soft scale acknowledgement on working -> idle. */
@keyframes settle {
    0% {
        transform: scale(1);
    }
    45% {
        transform: scale(1.012);
    }
    100% {
        transform: scale(1);
    }
}
```

- [ ] **Step 2: Verify the dev server hot-reloads clean**

If `task dev` is running, confirm the Vite HMR overlay shows no CSS parse error. Otherwise run the typecheck (CSS is not type-checked, so this is a smoke check only):
Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 3: Checkpoint (no commit)** — no test; verified visually in Task 10.

---

## Task 3: Status-dot color transition + pulse unification (moment 7)

**Files:**
- Modify: `frontend/app/view/agents/statusdot.tsx:26-35`
- Modify: `frontend/app/view/agents/agentrow.tsx:341` (feed activity dot)

- [ ] **Step 1: Add a color transition + reduced-motion guard to the dot**

In `frontend/app/view/agents/statusdot.tsx`, update the `className` list in the returned `<span>` (currently lines 28-33) to add `transition-colors duration-200` and guard the pulse with `motion-reduce:animate-none`:

```tsx
        <span
            className={cn(
                "h-2 w-2 shrink-0 rounded-full transition-colors duration-200",
                hollow ? "border border-muted bg-transparent" : "",
                pulse && !hollow ? "animate-[pulseDot_1.6s_infinite] motion-reduce:animate-none" : "",
                className
            )}
            style={hollow ? undefined : { backgroundColor: COLOR[state] }}
        />
```

- [ ] **Step 2: Unify the feed activity dot to the same pulse duration + guard**

In `frontend/app/view/agents/agentrow.tsx` the working activity dot (currently line 341) uses `1.4s`. Change it to `1.6s` and add the reduced-motion guard so all status pulses share one definition:

```tsx
                            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-success animate-[pulseDot_1.6s_infinite] motion-reduce:animate-none" />
```

- [ ] **Step 3: Verify typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 4: Checkpoint (no commit).**

---

## Task 4: Cockpit scaffold — MotionConfig + AnimatePresence (moments 1/2 infra, reduced-motion, no-cascade)

**Files:**
- Modify: `frontend/app/view/agents/cockpitsurface.tsx:7` (import), `:613` (MotionConfig wrap), `:746-787` (AnimatePresence wrap)

- [ ] **Step 1: Extend the motion import**

In `frontend/app/view/agents/cockpitsurface.tsx` line 7, change:

```tsx
import { Reorder } from "motion/react";
```
to:
```tsx
import { AnimatePresence, MotionConfig, Reorder } from "motion/react";
```

- [ ] **Step 2: Wrap the returned tree in MotionConfig**

The component returns (line 612-613) `<div ref={containerRef} tabIndex={0} onKeyDown={onKeyDown} className="relative flex h-full w-full text-secondary outline-none">`. Wrap the entire returned element in `<MotionConfig reducedMotion="user">…</MotionConfig>`:

```tsx
    return (
        <MotionConfig reducedMotion="user">
            <div
                ref={containerRef}
                tabIndex={0}
                onKeyDown={onKeyDown}
                className="relative flex h-full w-full text-secondary outline-none"
            >
                {/* …existing body unchanged… */}
            </div>
        </MotionConfig>
    );
```

(Move the existing closing `</div>` inside, and add the `</MotionConfig>` after it. Do not change any inner markup in this step.)

- [ ] **Step 3: Wrap the card map in AnimatePresence**

Inside `<Reorder.Group …>` (line 734), wrap the `{shownAgents.map((a) => ( <AgentRow … /> ))}` block (lines 746-787) with `<AnimatePresence mode="popLayout" initial={false}>`:

```tsx
                            <AnimatePresence mode="popLayout" initial={false}>
                                {shownAgents.map((a) => (
                                    <AgentRow
                                        key={a.id}
                                        agent={a}
                                        /* …all existing props unchanged… */
                                    />
                                ))}
                            </AnimatePresence>
```

`initial={false}` means agents already present when the tab mounts (or when a chip filter changes) do **not** animate in — only agents that arrive afterward. `mode="popLayout"` pops an exiting card out of flow so survivors reflow immediately.

- [ ] **Step 4: Verify typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0. (No visual change yet — AgentRow has no exit/animate variants until Task 5. Exit animations only take effect once Task 5 lands.)

- [ ] **Step 5: Checkpoint (no commit).**

---

## Task 5: Card entrance, exit, and reorder lift (moments 1, 2, 8)

**Files:**
- Modify: `frontend/app/view/agents/agentrow.tsx:9-24` (import), `:207-216` (Reorder.Item props)

- [ ] **Step 1: Import the tokens**

In `frontend/app/view/agents/agentrow.tsx`, add to the import block (after the existing `motion/react` import on line 6) a new import:

```tsx
import { cardVariants, reorderLift } from "@/app/element/motiontokens";
```

- [ ] **Step 2: Add variants + lift to the Reorder.Item**

The `Reorder.Item` opening tag is lines 207-216. Add `variants`, `initial`, `animate`, `exit`, and `whileDrag`. Keep every existing prop (`as`, `value`, `dragListener`, `dragControls`, `dragMomentum`, `dragTransition`, `layout="position"`, `ref`, `style`, `data-agent-id`, handlers, `className`):

```tsx
        <Reorder.Item
            as="div"
            value={agent.id}
            dragListener={false}
            dragControls={controls}
            dragMomentum={false}
            dragTransition={{ bounceStiffness: 600, bounceDamping: 30 }}
            layout="position"
            variants={cardVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            whileDrag={reorderLift}
            ref={cardRef}
            style={{ gridColumn: spanFull ? "1 / -1" : undefined, minHeight: 0 }}
            data-agent-id={agent.id}
            onClick={onCursor}
            onDoubleClick={onOpen}
            className={cn(/* …unchanged… */)}
        >
```

Note: `cardVariants` animates opacity + scale only, so it composes with `layout="position"` (which owns x/y) and the drag transform. `whileDrag` adds the grab lift; the drop-settle is the existing `dragTransition`.

- [ ] **Step 3: Verify typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 4: Run the existing agents suite to catch regressions**

Run: `npx vitest run frontend/app/view/agents/`
Expected: PASS (existing green suite unchanged).

- [ ] **Step 5: Checkpoint (no commit).** Visual (entrance on new agent, exit + reflow on finish, lift on drag) verified in Task 10.

---

## Task 6: Working → asking breathing glow (moment 3)

**Files:**
- Modify: `frontend/app/view/agents/agentrow.tsx:220-227` (card className)

- [ ] **Step 1: Add the glow class when asking**

In the `Reorder.Item` `className={cn(…)}` (lines 220-227), add a conditional breathing-glow animation on the `asking` branch. Update the block to:

```tsx
            className={cn(
                // cards stretch to fill their grid row (align-items: stretch) — the fit-to-viewport goal
                "group relative flex cursor-pointer flex-col overflow-hidden rounded-[13px] border",
                asking
                    ? "border-warning/40 bg-lane-asking animate-[breatheGlow_2.4s_ease-in-out_infinite] motion-reduce:animate-none"
                    : "border-edge-mid bg-lane",
                isCursor &&
                    (asking ? "shadow-[0_0_0_1.5px_var(--color-warning)]" : "shadow-[0_0_0_1.5px_var(--color-accent)]"),
                pulse && "ring-2 ring-warning ring-inset"
            )}
```

The glow uses `drop-shadow` (from the Task 2 keyframe), so it coexists with the `isCursor` `box-shadow` ring and the `pulse` inset ring. It is persistent (loops until the card leaves the asking state). `motion-reduce:animate-none` drops it under reduced-motion.

- [ ] **Step 2: Verify typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 3: Checkpoint (no commit).** Visual verified in Task 10.

---

## Task 7: Finished settle (moment 4)

There is no `done` state — "finished" is the `working → idle` transition. Play the `settle` keyframe once when a card transitions to `idle` while still shown.

**Files:**
- Modify: `frontend/app/view/agents/agentrow.tsx` (component body: add a prev-state ref + a settle flag; apply a one-shot class)

- [ ] **Step 1: Track the working→idle transition**

Near the other hooks at the top of the `AgentRow` component body (after the existing `useState`/`useRef` declarations, before the `return`), add:

```tsx
    // one-shot "settle" when this agent finishes (working -> idle); cleared after it plays
    const prevStateRef = useRef(agent.state);
    const [justFinished, setJustFinished] = useState(false);
    useEffect(() => {
        if (prevStateRef.current === "working" && agent.state === "idle") {
            setJustFinished(true);
            const t = setTimeout(() => setJustFinished(false), 520); // matches @keyframes settle .5s
            prevStateRef.current = agent.state;
            return () => clearTimeout(t);
        }
        prevStateRef.current = agent.state;
    }, [agent.state]);
```

- [ ] **Step 2: Apply the settle class**

Add `justFinished` to the card `className={cn(…)}` block (the same block edited in Task 6), as a new line inside `cn(...)`:

```tsx
                justFinished && "animate-[settle_0.5s_ease-out] motion-reduce:animate-none",
```

(Insert it after the `pulse && "ring-2 ring-warning ring-inset"` line.)

- [ ] **Step 3: Verify typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 4: Checkpoint (no commit).** Visual verified in Task 10. (Open question from the spec — whether to add a distinct success accent color — is intentionally left as reuse-existing here; revisit only if the CDP pass shows it reads ambiguously.)

---

## Task 8: Narration line fade (moment 5)

**Files:**
- Modify: `frontend/app/view/agents/narrationtimeline.tsx:4-7` (imports), `:75-141` (wrap message/user rows)

- [ ] **Step 1: Import motion + the burst-guard helper**

In `frontend/app/view/agents/narrationtimeline.tsx`, update the import block (lines 4-7):

```tsx
import { cn } from "@/util/util";
import { motion, AnimatePresence } from "motion/react";
import { Fragment, useState } from "react";
import { shouldFadeEntry } from "@/app/element/motiontokens";
```

- [ ] **Step 2: Wrap the list in AnimatePresence and make message/user rows fade**

Wrap the `{items.map(…)}` body (returned at line 76, `<div className={cn("leading-relaxed", className)}>`) so its children live inside `<AnimatePresence initial={false}>`, and convert the **message** row (lines 79-93) and **user** row (lines 95-105) outer `<div>` into `motion.div` with a fade. `initial={false}` means existing history does not cascade when a card mounts; only newly-streamed turns fade in. Tool lines and group summaries stay plain (burst guard via `shouldFadeEntry`).

Message row:
```tsx
                if (item.kind === "message") {
                    return (
                        <motion.div
                            key={item.index}
                            className="mt-2 flex gap-2.5"
                            initial={shouldFadeEntry("message") ? { opacity: 0 } : false}
                            animate={{ opacity: 1 }}
                            transition={{ duration: 0.15 }}
                        >
                            <span className="mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded-[6px] border border-accent/30 bg-accent/[0.13]">
                                <span className="h-[7px] w-[7px] rounded-full bg-accent-soft" />
                            </span>
                            <div
                                className={cn(
                                    "min-w-0 flex-1 text-[13px] leading-[1.55]",
                                    item.index === lastMessageIdx ? "text-primary" : "text-secondary"
                                )}
                            >
                                <MarkdownMessage text={item.text} />
                            </div>
                        </motion.div>
                    );
                }
```

User row:
```tsx
                if (item.kind === "user") {
                    return (
                        <motion.div
                            key={item.index}
                            className="mt-2 flex justify-end pl-[30px]"
                            initial={shouldFadeEntry("user") ? { opacity: 0 } : false}
                            animate={{ opacity: 1 }}
                            transition={{ duration: 0.15 }}
                        >
                            <div className="max-w-[90%] rounded-[11px_11px_4px_11px] border border-accent/25 bg-accent/10 px-2.5 py-1.5">
                                <div className="mb-0.5 font-mono text-[8px] font-bold uppercase tracking-[0.08em] text-accent-soft">
                                    You
                                </div>
                                <p className="text-[12.5px] leading-[1.5] text-primary">{item.text}</p>
                            </div>
                        </motion.div>
                    );
                }
```

Wrap the whole map:
```tsx
        <div className={cn("leading-relaxed", className)}>
            <AnimatePresence initial={false}>
                {items.map((item, idx) => {
                    /* …the message / user / action / group branches, unchanged except the two motion.div rows above… */
                })}
            </AnimatePresence>
        </div>
```

Reduced-motion is handled globally by the `MotionConfig` from Task 4 (Framer drops the transform/opacity offset for `reducedMotion="user"`).

- [ ] **Step 3: Verify typecheck + tests**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.
Run: `npx vitest run frontend/app/view/agents/`
Expected: PASS.

- [ ] **Step 4: Checkpoint (no commit).** Fast-stream no-strobe verified in Task 10.

---

## Task 9: Composer reveal (moment 6)

**Files:**
- Modify: `frontend/app/view/agents/agentrow.tsx:9` (import), `:397-410` (open-composer branch)

- [ ] **Step 1: Extend the tokens import**

Update the Task 5 import in `agentrow.tsx` to also bring in `composerReveal` and `motion`:

```tsx
import { motion } from "motion/react";
import { cardVariants, composerReveal, reorderLift } from "@/app/element/motiontokens";
```

(Add `motion` to the existing `motion/react` import line rather than duplicating it: `import { Reorder, useDragControls, motion } from "motion/react";`. Do **not** create a second import from `motion/react`.)

- [ ] **Step 2: Animate the open composer**

The composer's open branch (lines 397-410) is a `<div className="flex flex-col gap-1.5 px-3 py-2" …>`. Convert it to a `motion.div` using `composerReveal`, with `overflow-hidden` so the height animation clips cleanly:

```tsx
                    {showComposer ? (
                        <motion.div
                            variants={composerReveal}
                            initial="initial"
                            animate="animate"
                            className="flex flex-col gap-1.5 overflow-hidden px-3 py-2"
                            onClick={(e) => e.stopPropagation()}
                            onDoubleClick={(e) => e.stopPropagation()}
                        >
                            <AgentComposer
                                ref={composerRef}
                                blockId={agent.blockId}
                                placeholder={`message ${agent.name}…`}
                                onEscape={onComposerEscape}
                                className="border-t-0 px-0 py-0"
                            />
                        </motion.div>
                    ) : (
                        /* …existing slim "+ message… R" row unchanged… */
                    )}
```

(Reveal-on-open only; closing snaps back to the slim row, which is acceptable for this moment. No `AnimatePresence` needed here.)

- [ ] **Step 3: Verify typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 4: Checkpoint (no commit).** Visual verified in Task 10.

---

## Task 10: Full verification pass (typecheck, tests, CDP)

**Files:** none (verification only).

- [ ] **Step 1: Typecheck + unit tests**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.
Run: `npx vitest run`
Expected: PASS (full suite; includes the new `motiontokens.test.ts`).

- [ ] **Step 2: Start the dev app for CDP**

Run (background): `tail -f /dev/null | task dev`
Wait for the `WAVESRV-ESTART` boot to complete and the window to appear. Confirm CDP is reachable: `node scripts/cdp-shot.mjs baseline.png` writes a PNG.

- [ ] **Step 3: Verify each moment with fixtures**

Inject a populated cockpit and screenshot; use `location.reload()` over CDP (not `Page.reload`) after each data change. Verify:
- **Entrance (1):** inject a scenario, then add an agent → new card fades/scales in (not a hard cut).
- **Exit + reflow (2):** transition an agent to finished/removed → its card leaves and survivors reflow into the gap.
- **Asking glow (3):** a card in `asking` shows the persistent amber breathing glow; it stops when answered.
- **Finished settle (4):** a `working → idle` card plays a single soft settle.
- **Narration (5):** a fast-streaming transcript does **not** strobe (tool bursts don't fade; only prose turns do).
- **Composer reveal (6):** pressing `R` / clicking the slim row expands the composer smoothly.
- **pulseDot (7):** the header dot and the feed activity dot pulse at the same cadence.
- **Reorder lift/drop (8):** grabbing the `∷∷` handle lifts the card; releasing settles it.

Reference: `node scripts/inject-live-agents.mjs <scenario>` (see the script header for scenario names).

- [ ] **Step 4: Verify the two edge cases**

- **No entrance cascade:** open the Cockpit tab with several live agents already present → cards appear immediately, no staggered fade-in.
- **Reduced motion:** emulate `prefers-reduced-motion: reduce` over CDP (`Emulation.setEmulatedMedia` with `{name:"prefers-reduced-motion", value:"reduce"}`), reload, and confirm transforms/glow are dropped (opacity-only or none) and pulses are static.
- **Divider drag still direct:** drag a row divider → resize tracks the pointer 1:1 (this behavior predates this work via `layout="position"`; confirm it did not regress). If it now lags, that is a separate follow-up, not part of this plan.

- [ ] **Step 5: Capture before/after screenshots** for the review and stop the dev app.

---

## Task 11: Review diff + single batched commit (await approval)

**Files:** all changed files from Tasks 1-9.

- [ ] **Step 1: Self-review the diff**

Run: `git status` and `git --no-pager diff`
Confirm: no debug logging, no commented-out code, no stray console statements, and every change traces to a moment in the spec.

- [ ] **Step 2: Present for approval (do NOT commit yet)**

Show the user the file list with M/A status and a one-line summary each, plus the proposed message:

```
feat(cockpit): motion system — 8 state-change moments (Framer + tokens)
```

Body should explain WHY (functional-first motion for the fleet monitor; Fluid feel; one token source) and note the spec + plan fold into this commit (no separate docs commit).

Then ask: **"Awaiting approval. Proceed? (yes/no)"**

- [ ] **Step 3: On approval, stage and commit**

```bash
git add frontend/app/element/motiontokens.ts frontend/app/element/motiontokens.test.ts \
        frontend/tailwindsetup.css frontend/app/view/agents/statusdot.tsx \
        frontend/app/view/agents/agentrow.tsx frontend/app/view/agents/cockpitsurface.tsx \
        frontend/app/view/agents/narrationtimeline.tsx \
        docs/superpowers/specs/2026-07-03-cockpit-motion-system-design.md \
        docs/superpowers/plans/2026-07-03-cockpit-motion-system.md
git commit -m "feat(cockpit): motion system — 8 state-change moments (Framer + tokens)"
```

Do not push unless explicitly asked.

---

## Self-review (against the spec)

**Spec coverage:**
- Moment 1 entrance → Task 5. Moment 2 exit + reflow → Task 4 (AnimatePresence) + Task 5 (exit variant) + existing `layout="position"`. Moment 3 asking glow → Task 2 (keyframe) + Task 6. Moment 4 finished settle → Task 2 (keyframe) + Task 7. Moment 5 narration fade → Task 1 (helper) + Task 8. Moment 6 composer reveal → Task 1 (variant) + Task 9. Moment 7 pulse + micro → Task 3. Moment 8 reorder lift/drop → Task 5 (`whileDrag` + existing `dragTransition`). ✅ all eight covered.
- Tokens single-source (`motiontokens.ts`) → Task 1. `@theme`/token colors, no raw hex → Task 2 uses `var(--color-warning)` via `color-mix`. ✅
- Edge cases: reduced-motion (`MotionConfig` Task 4 + `motion-reduce:` Tasks 3/6/7) ✅; no cascade (`initial={false}` Task 4) ✅; `layout` only on card container (unchanged; text nodes use opacity-only in Task 8) ✅; divider-drag-direct verified Task 10 ✅.
- Testing: unit (Task 1), typecheck (every task), CDP (Task 10). ✅

**Placeholder scan:** No TBD/TODO; every code step shows full code. The spec's "finished settle color" open question is resolved to reuse-existing in Task 7 with a documented revisit trigger. ✅

**Type consistency:** `MOTION`, `cardVariants`, `reorderLift`, `composerReveal`, `shouldFadeEntry` defined in Task 1 and imported by the same names in Tasks 5/8/9. `justFinished`/`prevStateRef` defined and used within Task 7. ✅
