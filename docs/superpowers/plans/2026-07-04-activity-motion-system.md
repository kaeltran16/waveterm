# Activity surface motion — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Activity surface (`frontend/app/view/agents/activitysurface.tsx`) two functional motions — a one-shot load reveal and a two-level (group + row) filter reflow — reusing the shared motion vocabulary, with zero data-layer changes.

**Architecture:** Promote the existing pure `reflowProps` helper from `sessionsmotion.ts` into the shared `motiontokens.ts` (second consumer = extraction threshold; same move already done for `computeEntrances`), then wire the Activity surface declaratively: `<MotionConfig reducedMotion="user">` at the root, a Sessions-style `mountedEmpty` container fade for the load reveal, and nested `<AnimatePresence mode="popLayout">` + `layout` on group and row wrappers, gated by a `reflowAnimated` flag so the first populate is silent and only chip refilters animate.

**Tech Stack:** React 19, Framer Motion (`motion/react` v12), jotai, Tailwind 4, vitest. Design spec: `docs/superpowers/specs/2026-07-04-activity-motion-design.md`.

## Global Constraints

- **Motion is functional-first.** Only the load reveal and filter reflow ship; nothing decorative (no attention glow on the historical "N need you" badge, no live-dot pulse, no polling). Verbatim from spec.
- **No new tokens/durations/eases/keyframes.** Reuse `MOTION`, `cardVariants`, and the relocated `reflowProps` only.
- **Animate opacity/scale/`layout` only** — never x/y (guardrail); `layout` only on container/wrapper nodes, never text nodes.
- **No entrance cascade.** `reflowAnimated` starts `false` → first populate is silent (container fade covers it). `AnimatePresence initial={false}` is the second belt.
- **Reduced motion** via `<MotionConfig reducedMotion="user">` at the surface root.
- **No store / data / token-value changes.** `activitystore.ts`, `activityevents.ts`, and token *values* stay untouched; `motiontokens.ts` only gains the relocated `reflowProps`.
- **Typecheck command** (the repo's `npx tsc` stack-overflows — use this exact form): `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`. Baseline is clean (exit 0); any error it reports is yours.
- **Test command:** `npx vitest run frontend/app/element/motiontokens.test.ts frontend/app/view/agents/sessionsmotion.test.ts`.
- **Git:** Per project rules, commits require explicit user approval and are batched into one commit at the end unless told otherwise. The per-task `git commit` steps below mark intended commit boundaries — get approval before running them, or squash at the end.

## File structure

| File | Responsibility | Change |
|---|---|---|
| `frontend/app/element/motiontokens.ts` | Single source of motion tokens/presets/pure helpers | Add relocated `reflowProps` + `ReflowProps` |
| `frontend/app/view/agents/sessionsmotion.ts` | Sessions' motion import surface | Reduce to a thin re-export from `motiontokens.ts` |
| `frontend/app/view/agents/activitysurface.tsx` | Activity feed UI | Add MotionConfig, load reveal, two-level reflow |
| `frontend/app/element/motiontokens.test.ts` | Unit coverage for tokens/helpers | Add `reflowProps` coverage (both branches) |

---

## Task 1: Promote `reflowProps` to the shared token module

Relocate the pure `reflowProps` helper into `motiontokens.ts`, co-locate its unit coverage there, and turn `sessionsmotion.ts` into a thin re-export so Sessions' import path is unchanged and its existing test now exercises the re-export.

**Files:**
- Modify: `frontend/app/element/motiontokens.ts` (add `reflowProps` + `ReflowProps`)
- Modify: `frontend/app/view/agents/sessionsmotion.ts` (reduce to re-export)
- Test: `frontend/app/element/motiontokens.test.ts` (add coverage)

**Interfaces:**
- Consumes: `MOTION` (already exported from `motiontokens.ts`).
- Produces:
  ```ts
  export interface ReflowProps {
      initial: string | false;
      exit: string | undefined;
      transition: Transition; // from "motion/react"
  }
  export function reflowProps(animated: boolean): ReflowProps;
  ```
  `reflowProps(true)` → `{ initial: "initial", exit: "exit", transition: { duration: MOTION.durMacro, ease: MOTION.easeFluid } }`. `reflowProps(false)` → `{ initial: false, exit: undefined, transition: { duration: 0 } }`.

- [ ] **Step 1: Write the failing test**

Add this block to the end of `frontend/app/element/motiontokens.test.ts`, and add `reflowProps` to the existing import on line 5 (so it reads `... shouldFadeEntry, reflowProps } from "./motiontokens";`):

```ts
describe("reflowProps", () => {
    it("animates chip-driven reflow with the fluid macro transition", () => {
        const rp = reflowProps(true);
        expect(rp.initial).toBe("initial");
        expect(rp.exit).toBe("exit");
        expect(rp.transition).toEqual({ duration: MOTION.durMacro, ease: MOTION.easeFluid });
    });

    it("makes non-chip changes instant (no enter, no exit, zero-duration layout)", () => {
        const rp = reflowProps(false);
        expect(rp.initial).toBe(false);
        expect(rp.exit).toBeUndefined();
        expect(rp.transition).toEqual({ duration: 0 });
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run frontend/app/element/motiontokens.test.ts`
Expected: FAIL — `reflowProps` is not exported from `./motiontokens` (import resolves to `undefined`, calling it throws / assertions fail).

- [ ] **Step 3: Add `reflowProps` to `motiontokens.ts`**

At the top of `frontend/app/element/motiontokens.ts`, widen the type import (currently `import type { Variants } from "motion/react";`) to also bring in `Transition`:

```ts
import type { Transition, Variants } from "motion/react";
```

Then append to the end of `frontend/app/element/motiontokens.ts`:

```ts
// Chip-driven reflow props (shared by Sessions and Activity). `animated` = a user filter changed the
// list (chips) → play enter/exit + the fluid macro reflow. `false` = a silent, zero-duration layout snap
// (Sessions' search path; Activity's first populate). Maps the decision to the Framer props a reflowing
// list item spreads. See docs/superpowers/specs/2026-07-04-activity-motion-design.md.
export interface ReflowProps {
    initial: string | false;
    exit: string | undefined;
    transition: Transition;
}

export function reflowProps(animated: boolean): ReflowProps {
    if (animated) {
        return {
            initial: "initial",
            exit: "exit",
            transition: { duration: MOTION.durMacro, ease: MOTION.easeFluid },
        };
    }
    return { initial: false, exit: undefined, transition: { duration: 0 } };
}
```

- [ ] **Step 4: Reduce `sessionsmotion.ts` to a re-export**

Replace the entire contents of `frontend/app/view/agents/sessionsmotion.ts` with:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Sessions' filter reflow reuses the shared reflowProps primitive. Kept as a thin re-export so
// sessionssurface.tsx's import path is unchanged. See motiontokens.ts for the implementation and
// docs/superpowers/specs/2026-07-03-sessions-motion-design.md for the original rationale.
export { reflowProps, type ReflowProps } from "@/app/element/motiontokens";
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run frontend/app/element/motiontokens.test.ts frontend/app/view/agents/sessionsmotion.test.ts`
Expected: PASS — both files green (`sessionsmotion.test.ts` now exercises the re-export; `motiontokens.test.ts` covers the implementation directly). This mirrors `computeEntrances`, covered in both `motiontokens.test.ts` and `channelsmotion.test.ts`.

- [ ] **Step 6: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0 (clean baseline). `sessionssurface.tsx` still imports `reflowProps` from `./sessionsmotion` and resolves through the re-export.

- [ ] **Step 7: Commit** (get approval per Global Constraints)

```bash
git add frontend/app/element/motiontokens.ts frontend/app/element/motiontokens.test.ts frontend/app/view/agents/sessionsmotion.ts
git commit -m "refactor(motion): promote reflowProps to shared token module"
```

---

## Task 2: Wire Activity surface motion

Add the MotionConfig root, the load reveal, and the two-level filter reflow to `activitysurface.tsx`. This is declarative Framer wiring over the existing markup — no logic changes, no store touch. There is no jsdom render harness for the cockpit (per `CLAUDE.md`), so this task is verified by typecheck plus visual inspection on the live dev app; it carries no unit test.

**Files:**
- Modify: `frontend/app/view/agents/activitysurface.tsx`

**Interfaces:**
- Consumes: `cardVariants`, `MOTION`, `reflowProps` from `@/app/element/motiontokens` (Task 1); `AnimatePresence`, `MotionConfig`, `motion` from `motion/react`.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Update imports**

In `frontend/app/view/agents/activitysurface.tsx`, replace the current React/util/jotai import lines:

```ts
import { globalStore } from "@/app/store/jotaiStore";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect } from "react";
```

with (adds the motion tokens, Framer primitives, and `useState`):

```ts
import { MOTION, cardVariants, reflowProps } from "@/app/element/motiontokens";
import { globalStore } from "@/app/store/jotaiStore";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { useEffect, useState } from "react";
```

- [ ] **Step 2: Add the motion state flags**

In the `ActivitySurface` component body, immediately after the existing hooks block (after `const now = useAtomValue(model.nowAtom);` and before the `useEffect`), add:

```ts
    // Load reveal fires only on the first-ever visit: activityEventsAtom is module-level and persists
    // across surface remounts, so it is empty only before the first load ever completes.
    const [mountedEmpty] = useState(() => events.length === 0);
    // Chips animate the two-level reflow; the first populate stays silent (the container fade covers it).
    const [reflowAnimated, setReflowAnimated] = useState(false);
```

- [ ] **Step 3: Compute reflow props in the render body**

After `const groups = groupByProject(applyFilter(events, filter));`, add:

```ts
    const rp = reflowProps(reflowAnimated);
```

- [ ] **Step 4: Make chip clicks turn reflow on**

In the chips `.map`, change the button's `onClick` from:

```tsx
                                onClick={() => globalStore.set(model.activityFilterAtom, c.key)}
```

to:

```tsx
                                onClick={() => {
                                    globalStore.set(model.activityFilterAtom, c.key);
                                    setReflowAnimated(true);
                                }}
```

- [ ] **Step 5: Wrap the root in `MotionConfig` and animate the feed**

Replace the entire `return ( ... );` of `ActivitySurface` — from `<div className="absolute inset-0 overflow-y-auto">` down to its matching close — with the following. The header and chip markup are unchanged (shown in full so this is copy-pasteable); the group/row containers become `motion.div`s inside nested `AnimatePresence`, and the populated feed is wrapped in a `mountedEmpty`-gated fade container (mounted only in the non-empty branch, so the fade plays over real content, matching Sessions):

```tsx
    return (
        <MotionConfig reducedMotion="user">
            <div className="absolute inset-0 overflow-y-auto">
                <div className="mx-auto max-w-[820px] px-[30px] pb-[70px] pt-[30px]">
                    <div className="mb-5">
                        <h1 className="text-[25px] font-bold tracking-[-0.02em] text-primary">Activity</h1>
                        <p className="text-[13.5px] text-secondary">Every agent event, grouped by project.</p>
                    </div>
                    <div className="mb-7 flex flex-wrap gap-2">
                        {CHIPS.map((c) => {
                            const active = filter === c.key;
                            const dot = c.key !== "all" ? TYPE_META[c.key].color : undefined;
                            return (
                                <button
                                    key={c.key}
                                    type="button"
                                    onClick={() => {
                                        globalStore.set(model.activityFilterAtom, c.key);
                                        setReflowAnimated(true);
                                    }}
                                    className={cn(
                                        "cursor-pointer rounded-[8px] border px-[13px] py-[6px] text-[12px] font-medium",
                                        active
                                            ? "border-accent bg-accentbg text-accent-soft"
                                            : "border-border bg-surface text-ink-mid hover:border-edge-strong"
                                    )}
                                >
                                    {dot ? (
                                        <span className="mr-1.5" style={{ color: dot }}>
                                            ●
                                        </span>
                                    ) : null}
                                    {c.label}
                                </button>
                            );
                        })}
                    </div>
                    {groups.length === 0 ? (
                        <div className="mt-10 text-center text-[13px] text-muted">No recent activity.</div>
                    ) : (
                        <motion.div
                            initial={mountedEmpty ? { opacity: 0 } : false}
                            animate={{ opacity: 1 }}
                            transition={{ duration: MOTION.durMacro, ease: MOTION.easeFluid }}
                        >
                            <AnimatePresence mode="popLayout" initial={false}>
                                {groups.map((g) => (
                                    <motion.div
                                        key={g.project}
                                        layout
                                        variants={cardVariants}
                                        initial={rp.initial}
                                        animate="animate"
                                        exit={rp.exit}
                                        transition={rp.transition}
                                        className="mb-[30px]"
                                    >
                                        <div className="mb-1.5 flex items-center gap-2.5">
                                            <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.1em] text-accent-soft">
                                                {g.project}
                                            </span>
                                            <div className="h-px flex-1 bg-border" />
                                            {g.attn > 0 ? (
                                                <span className="rounded-[5px] bg-accentbg px-1.5 font-mono text-[9.5px] font-semibold text-asking">
                                                    {g.attn} need you
                                                </span>
                                            ) : null}
                                            <span className="font-mono text-[10.5px] font-semibold text-muted">{g.count}</span>
                                        </div>
                                        <AnimatePresence mode="popLayout" initial={false}>
                                            {g.events.map((e) => (
                                                <motion.div
                                                    key={e.id}
                                                    layout
                                                    variants={cardVariants}
                                                    initial={rp.initial}
                                                    animate="animate"
                                                    exit={rp.exit}
                                                    transition={rp.transition}
                                                    className="flex gap-4 border-b border-edge-faint px-1 py-3.5 hover:bg-surface"
                                                >
                                                    <span className="w-[42px] shrink-0 pt-0.5 text-right font-mono text-[11.5px] text-muted">
                                                        {now - e.ts < 60_000 ? "now" : formatAge(now - e.ts)}
                                                    </span>
                                                    <span
                                                        className="mt-1 h-[9px] w-[9px] shrink-0 rounded-full"
                                                        style={{ backgroundColor: TYPE_META[e.type].color }}
                                                    />
                                                    <div className="min-w-0 flex-1">
                                                        <div className="text-[13.5px] leading-[1.5] text-secondary">
                                                            <span className="font-mono text-[13px] font-semibold text-primary">{e.agentName}</span> {e.text}
                                                        </div>
                                                        <div className="mt-[5px] flex items-center gap-2">
                                                            <span
                                                                className="font-mono text-[10px] font-medium uppercase tracking-[0.06em]"
                                                                style={{ color: TYPE_META[e.type].color }}
                                                            >
                                                                {TYPE_META[e.type].label}
                                                            </span>
                                                            <span className="font-mono text-[10.5px] text-muted">{ago(now, e.ts)}</span>
                                                        </div>
                                                    </div>
                                                    {e.live ? (
                                                        <button
                                                            type="button"
                                                            onClick={() => jump(model, e)}
                                                            className="shrink-0 cursor-pointer self-center rounded-[7px] border border-border px-[11px] py-[5px] text-[11.5px] font-medium text-ink-mid hover:border-accent hover:text-accent-soft"
                                                        >
                                                            Jump →
                                                        </button>
                                                    ) : null}
                                                </motion.div>
                                            ))}
                                        </AnimatePresence>
                                    </motion.div>
                                ))}
                            </AnimatePresence>
                        </motion.div>
                    )}
                </div>
            </div>
        </MotionConfig>
    );
```

- [ ] **Step 6: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0. Common miss if it errors: `motion.div` needs `import { motion }` (Step 1); `rp.initial`/`rp.exit` types (`string | false` / `string | undefined`) are already what Framer's `initial`/`exit` props accept.

- [ ] **Step 7: Visual verification on the live dev app (manual, no automated harness)**

If `task dev` is not already running, start it, then let the WebView2 rebuild pick up the change (HMR). Drive CDP per `CLAUDE.md`:

1. Seed live sessions so `discoverSessions` has data: `node scripts/inject-live-agents.mjs <scenario>` (see that script's header for scenarios).
2. Switch to the Activity surface (rail, or `[` / `]`). On the **first** visit the feed fades in as one block — confirm there is no per-row/per-group stagger cascade.
3. Screenshot: `node scripts/cdp-shot.mjs activity-loaded.png`.
4. Click a type chip (e.g. `Errored`) — non-matching project groups exit and remaining rows/groups reflow up; screenshot mid/after: `node scripts/cdp-shot.mjs activity-filtered.png`.
5. Click `All events` back — groups/rows animate back in.
6. Switch away and back to Activity — the populated feed appears with **no** re-fade (revisit path).
7. Confirm the historical "N need you" badge does **not** glow/pulse (functional-first exclusion).

Expected: load reveal is a single container fade; chip filtering visibly reflows at both levels; revisits are silent. If any step regresses, fix before committing. (Note: filtering to a type with zero matches then back re-fades the feed — this matches the shipped Sessions behavior and is acceptable per spec.)

- [ ] **Step 8: Commit** (get approval per Global Constraints)

```bash
git add frontend/app/view/agents/activitysurface.tsx
git commit -m "feat(activity): load reveal + two-level filter reflow motion"
```

---

## Task 3: Flip the tracker row

Mark Activity shipped in the revamp tracker with the commit SHA, matching how Channels/Files/Sessions rows were closed out.

**Files:**
- Modify: `docs/superpowers/animation-revamp-tracker.md`

**Interfaces:** none.

- [ ] **Step 1: Update the Activity row**

In `docs/superpowers/animation-revamp-tracker.md`, replace the Activity table row:

```markdown
| Activity | ☐ Not started | Cross-project feed. Candidates: line entrance (m1/m5), no-cascade guard. |
```

with (fill `<SHA>` with Task 2's commit hash — `git rev-parse --short HEAD` after that commit):

```markdown
| Activity | ✅ Shipped (2026-07-04) | Snapshot feed: one-shot load reveal (container fade) + two-level filter reflow (m2 popLayout on project groups AND rows) via `reflowProps` promoted to `motiontokens.ts`. `<MotionConfig reducedMotion="user">` at root. No live-arrival entrance / attention glow (functional-first, no live feed). SHA `<SHA>`. |
```

- [ ] **Step 2: Add the plan/spec to the References list**

In the `## References` section of `docs/superpowers/animation-revamp-tracker.md`, append:

```markdown
- Activity motion design spec: `docs/superpowers/specs/2026-07-04-activity-motion-design.md`
- Activity motion implementation plan: `docs/superpowers/plans/2026-07-04-activity-motion-system.md`
```

- [ ] **Step 3: Update the "Last updated" line if needed**

Ensure the top-of-file `Last updated:` line reads `2026-07-04`.

- [ ] **Step 4: Commit** (get approval per Global Constraints)

```bash
git add docs/superpowers/animation-revamp-tracker.md docs/superpowers/specs/2026-07-04-activity-motion-design.md docs/superpowers/plans/2026-07-04-activity-motion-system.md
git commit -m "docs(activity): flip tracker row, add motion spec + plan"
```

---

## Self-review notes

- **Spec coverage:** load reveal → Task 2 Step 5 (`mountedEmpty` fade container); two-level filter reflow → Task 2 Step 5 (nested `AnimatePresence` + `layout` on groups and rows) + Step 4 (`reflowAnimated` on chip click); `reflowProps` promotion → Task 1; MotionConfig / reduced motion → Task 2 Step 5; exclusions (no glow/pulse/polling) → preserved by not adding them (Task 2 keeps the badge markup untouched); unit test → Task 1 Steps 1–5; tracker update → Task 3. No spec section is unimplemented.
- **No store/data change:** `activitystore.ts` / `activityevents.ts` never appear in any task's file list.
- **Type consistency:** `reflowProps` / `ReflowProps` signatures are identical across Task 1's definition and Task 2's usage; `mountedEmpty`, `reflowAnimated`, `rp` names are consistent within Task 2.
