# Usage Surface Motion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add functional-first motion to the Usage surface so magnitude bars tween on recompute, the live donut rings sweep as quota climbs, and the Historical section reveals once when data first loads.

**Architecture:** Reuse the shipped motion vocabulary — Files' inline CSS `width`/`height` transition idiom for bars, `cardVariants` (m1) for entrances, and a single new registered CSS custom property (`@property --usage-arc`) so the conic-gradient donut is transitionable. Reduced motion is gated with `useReducedMotion()` for inline transitions and `<MotionConfig reducedMotion="user">` for Framer parts.

**Tech Stack:** React 19, Framer Motion (`motion/react` v12), Tailwind 4, jotai, TypeScript.

## Global Constraints

- Import all motion values from `frontend/app/element/motiontokens.ts` — never inline a duration/ease/keyframe. Bars use `MOTION.durMacro` + `easeFluidCss`.
- Feel = Fluid / calm: macro ~360ms (`MOTION.durMacro`) on `easeFluid` `cubic-bezier(0.22, 1, 0.36, 1)`.
- Reduced motion is not optional. Inline CSS transitions gate on `useReducedMotion()`; Framer parts sit under `<MotionConfig reducedMotion="user">`.
- No entrance cascade. Only the single Historical container reveals; no per-card stagger. No StatCard number count-up.
- CSS keyframes/properties must be token-colored where they carry color — the `@property` here is angle-only, no color.
- The repo has **no `@testing-library/react`**: React hooks have no unit harness. Hooks get a `describe.skip` doc mirroring `motionhooks.test.ts`; behavior is verified via CDP visual check (`scripts/cdp-shot.mjs`).
- Typecheck command (tsc stack-overflows on this repo): `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`. Baseline is clean (exit 0).
- Custom CSS properties in inline style use the repo convention: `style={{ "--foo": val } as CSSProperties}`.
- Never hand-edit generated files. None are touched here.

## File Structure

- `frontend/app/element/motionhooks.ts` — add `useDidBecomeTrue(flag)` edge latch beside `useSettle`.
- `frontend/app/element/motionhooks.test.ts` — add a `describe.skip` doc for the new hook.
- `frontend/tailwindsetup.css` — register `@property --usage-arc` in the motion block.
- `frontend/app/view/agents/usagesurface.tsx` — bar transitions, donut sweep, live-card entrance, Historical load reveal, root `MotionConfig`, imports, and a local `barTransition` helper.

No `usagemotion.ts` module — there is no list-cascade keying problem on this surface.

---

### Task 1: `useDidBecomeTrue` edge-latch hook

**Files:**
- Modify: `frontend/app/element/motionhooks.ts`
- Test: `frontend/app/element/motionhooks.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `useDidBecomeTrue(flag: boolean): boolean` — returns `true` from the render where `flag` is first observed to go false→true within this mount; `false` while mounted already-true. Computed synchronously during render (not via effect) so the reveal wrapper, which mounts on the same render the flag flips, sees `true` immediately.

- [ ] **Step 1: Add the hook**

Append to `frontend/app/element/motionhooks.ts` (the file already imports `useRef`):

```ts
// One-shot edge latch (moment 1 load reveal): returns true from the render where `flag` is first
// observed to go false→true within this mount, false while mounted already-true. Computed during
// render (not in an effect) so a wrapper that mounts on the same render the flag flips sees true
// immediately. Because usage data is cached in jotai, a tab re-entry mounts already-true and the
// reveal is correctly suppressed. See docs/superpowers/specs/2026-07-04-usage-motion-design.md.
export function useDidBecomeTrue(flag: boolean): boolean {
    const prev = useRef(flag);
    const became = useRef(false);
    if (flag && !prev.current) became.current = true;
    prev.current = flag;
    return became.current;
}
```

- [ ] **Step 2: Add the skip-doc test**

Append to `frontend/app/element/motionhooks.test.ts` inside a new `describe.skip` block (mirrors the existing `useSettle` skip, since there is no React hook renderer):

```ts
// useDidBecomeTrue is a React hook; no @testing-library/react in this repo, so no unit harness.
// Behavior (fires once on false→true, suppressed when mounted already-true) is covered by the
// Task 4 CDP visual check (Historical load reveal). See usage-motion-design.md.
describe.skip("useDidBecomeTrue (no @testing-library/react — covered by CDP visual check)", () => {
    test("fires once on false→true, suppressed when mounted already-true", () => {
        void useDidBecomeTrue;
    });
});
```

Add `useDidBecomeTrue` to the import on line 5:

```ts
import { useDidBecomeTrue, useSettle } from "./motionhooks";
```

- [ ] **Step 3: Run the test file and typecheck**

Run: `npx vitest run frontend/app/element/motionhooks.test.ts`
Expected: PASS (both `describe.skip` blocks reported skipped, 0 failures).

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0 (clean baseline).

- [ ] **Step 4: Commit**

```bash
git add frontend/app/element/motionhooks.ts frontend/app/element/motionhooks.test.ts
git commit -m "feat(motion): add useDidBecomeTrue edge latch for load reveals"
```

---

### Task 2: Register `@property --usage-arc`

**Files:**
- Modify: `frontend/tailwindsetup.css` (insert after the `settle` keyframe, currently ending at line 249)

**Interfaces:**
- Consumes: nothing.
- Produces: a registered custom property `--usage-arc` (`<percentage>`, non-inherited, initial `0%`) that makes a `conic-gradient` stop transitionable.

- [ ] **Step 1: Add the registration**

Insert after the closing `}` of `@keyframes settle` (line 249) and before the `/* Agents-view narration markdown ... */` block:

```css
/* Usage donut arc (moment 7): registered so the conic-gradient sweep is transitionable —
   gradient stops are not animatable unless routed through a typed custom property. WebView2 is
   Chromium, so @property is supported. Angle only; ring color switches at ok/warn/hot thresholds
   instantly. See docs/superpowers/specs/2026-07-04-usage-motion-design.md. */
@property --usage-arc {
    syntax: "<percentage>";
    inherits: false;
    initial-value: 0%;
}
```

- [ ] **Step 2: Verify the app still builds the stylesheet**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0 (CSS is not typechecked, but confirms no accidental TS breakage; the CSS is validated visually in Task 3).

- [ ] **Step 3: Commit**

```bash
git add frontend/tailwindsetup.css
git commit -m "feat(motion): register --usage-arc property for donut sweep"
```

---

### Task 3: Bar value transitions + reduced-motion gate

**Files:**
- Modify: `frontend/app/view/agents/usagesurface.tsx`

**Interfaces:**
- Consumes: `MOTION`, `easeFluidCss` from `motiontokens`; `useReducedMotion` from `motion/react`.
- Produces: a module-local `barTransition(reduce, prop)` helper reused by Task 4 is **not** shared — Task 4 builds its own transition string. This task's only surface change is the inline `transition` on the three bar families.

- [ ] **Step 1: Add imports**

At the top of `frontend/app/view/agents/usagesurface.tsx`, add these imports (the file currently imports from `jotai`, `@/util/util`, and `react`):

```ts
import { MOTION, easeFluidCss } from "@/app/element/motiontokens";
import { useReducedMotion } from "motion/react";
```

- [ ] **Step 2: Add the `barTransition` helper**

Add near the other top-level helpers (after `ageStr`, before `Segmented`):

```ts
// Files-precedent value transition (moment 7): tween a bar's width/height on recompute. Returns
// undefined under reduced motion so the value snaps. Token-sourced duration + ease.
function barTransition(reduce: boolean, prop: "width" | "height"): string | undefined {
    return reduce ? undefined : `${prop} ${MOTION.durMacro}s ${easeFluidCss}`;
}
```

- [ ] **Step 3: Transition the split bars**

Replace the `SplitBar` component body so each fill div carries the transition:

```tsx
function SplitBar({ items, totalOf }: { items: ClassUsage[]; totalOf: (c: ClassUsage) => number }) {
    const reduce = useReducedMotion();
    const total = items.reduce((s, c) => s + totalOf(c), 0) || 1;
    return (
        <div className="mb-[18px] flex h-[30px] overflow-hidden rounded-[7px] bg-background">
            {items.map((c) => (
                <div
                    key={c.cls}
                    style={{
                        width: `${(totalOf(c) / total) * 100}%`,
                        background: CLASS_COLOR[c.cls],
                        transition: barTransition(reduce, "width"),
                    }}
                />
            ))}
        </div>
    );
}
```

- [ ] **Step 4: Transition the per-model bars**

In `ModelGroup`, add `const reduce = useReducedMotion();` as the first line of the function body, then replace the inner fill div (currently `<div className="h-full rounded-[4px]" style={{ width: ..., background: ... }} />`) with:

```tsx
<div
    className="h-full rounded-[4px]"
    style={{
        width: `${m.pct}%`,
        background: MODEL_COLORS[i % MODEL_COLORS.length],
        transition: barTransition(reduce, "width"),
    }}
/>
```

- [ ] **Step 5: Transition the daily-chart bars**

In `DailyChart`, add `const reduce = useReducedMotion();` as the first line of the function body. Then in the per-row bar stack, add the height transition to both fill divs:

```tsx
{r.b > 0 ? (
    <div
        className="w-[64%] max-w-[30px] rounded-t-[3px] bg-success"
        style={{ height: bH, transition: barTransition(reduce, "height") }}
    />
) : null}
<div
    className={cn("w-[64%] max-w-[30px] bg-accent", r.b > 0 ? "" : "rounded-t-[3px]")}
    style={{ height: aH, transition: barTransition(reduce, "height") }}
/>
```

- [ ] **Step 6: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 7: Visual check on the live dev app**

With `task dev` running (or already running), and after a dev rebuild picks up the change:
Run: `node scripts/inject-live-agents.mjs <scenario>` (populate usage), then open the Usage surface and toggle `7 days ↔ All time` and `Tokens ↔ Spend`.
Capture: `node scripts/cdp-shot.mjs usage-bars.png`
Expected: split bars, per-model bars, and daily-chart bars visibly tween to their new magnitudes on toggle (not a hard cut). Toggle OS reduced-motion on and confirm they snap.

- [ ] **Step 8: Commit**

```bash
git add frontend/app/view/agents/usagesurface.tsx
git commit -m "feat(usage): tween magnitude bars on recompute (m7)"
```

---

### Task 4: Donut ring sweep

**Files:**
- Modify: `frontend/app/view/agents/usagesurface.tsx`

**Interfaces:**
- Consumes: `@property --usage-arc` (Task 2); `MOTION`, `easeFluidCss` (imported in Task 3); `useReducedMotion` (imported in Task 3); `CSSProperties` from `react`.
- Produces: nothing downstream.

- [ ] **Step 1: Import `CSSProperties`**

Add `CSSProperties` to the existing `react` import in `usagesurface.tsx`:

```ts
import { type CSSProperties, useEffect, useState } from "react";
```

- [ ] **Step 2: Route the donut arc through the custom property**

Replace the `MiniDonut` component so the arc is driven by `--usage-arc` and transitions:

```tsx
function MiniDonut({ title, pct, reset, now }: { title: string; pct?: number; reset?: number; now: number }) {
    const reduce = useReducedMotion();
    const has = pct != null;
    const arc = has ? Math.min(100, pct) : 0;
    const color = has ? RING[usageLevel(pct)] : "var(--color-edge-strong)";
    const ringStyle = {
        background: `conic-gradient(${color} 0 var(--usage-arc), var(--color-edge-strong) 0)`,
        "--usage-arc": `${arc}%`,
        transition: reduce ? undefined : `--usage-arc ${MOTION.durMacro}s ${easeFluidCss}`,
    } as CSSProperties;
    return (
        <div className="flex items-center gap-[7px]">
            <div className="flex h-[40px] w-[40px] flex-none items-center justify-center rounded-full" style={ringStyle}>
                <div className="flex h-[29px] w-[29px] items-center justify-center rounded-full bg-background">
                    <span className="font-mono text-[10px] font-bold text-primary">{has ? Math.round(pct) + "%" : "—"}</span>
                </div>
            </div>
            <div>
                <div className="font-mono text-[10px] font-semibold text-secondary">{title}</div>
                <div className="whitespace-nowrap font-mono text-[9px] text-muted">
                    {reset ? "resets " + formatReset(reset, now) : has ? "live" : "no data"}
                </div>
            </div>
        </div>
    );
}
```

Note: when `has` is false, `arc` is `0` and both gradient colors are `edge-strong`, reproducing the original empty ring exactly. The center `{Math.round(pct)}%` label still updates instantly — only the ring arc sweeps.

- [ ] **Step 3: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 4: Visual check on the live dev app**

Run: `node scripts/inject-live-agents.mjs <scenario>` with a running Claude agent that reports quota, open the Usage surface, and let the 5-hour/weekly readings update (or re-inject with a higher percentage).
Capture: `node scripts/cdp-shot.mjs usage-donut.png`
Expected: the donut rings sweep smoothly to the new percentage rather than jumping. Under OS reduced-motion they snap. Empty (no-data) donuts render identically to before.

- [ ] **Step 5: Commit**

```bash
git add frontend/app/view/agents/usagesurface.tsx
git commit -m "feat(usage): sweep live donut rings via --usage-arc (m7)"
```

---

### Task 5: Live-card entrance + Historical load reveal + root MotionConfig

**Files:**
- Modify: `frontend/app/view/agents/usagesurface.tsx`

**Interfaces:**
- Consumes: `cardVariants` from `motiontokens`; `motion`, `MotionConfig` from `motion/react`; `useDidBecomeTrue` from `motionhooks` (Task 1).
- Produces: nothing downstream.

- [ ] **Step 1: Add imports**

Extend the `motiontokens` import (added in Task 3) and the `motion/react` import, and add the hook import:

```ts
import { MOTION, cardVariants, easeFluidCss } from "@/app/element/motiontokens";
import { MotionConfig, motion, useReducedMotion } from "motion/react";
import { useDidBecomeTrue } from "@/app/element/motionhooks";
```

- [ ] **Step 2: Animate the live-limit card entrance**

Change `LiveLimitCard`'s outer element from a `<div>` to a `motion.div` playing `cardVariants` once on mount (the card mounts when the first quota reading for a provider arrives):

```tsx
function LiveLimitCard({ d, now }: { d: ProviderDonuts; now: number }) {
    const stale = d.stale != null;
    const dot = stale ? "var(--color-warning)" : "var(--color-success)";
    const label = stale ? "as of " + ageStr(now - d.stale!.capturedAt) + " ago" : "Live";
    const border = stale
        ? "color-mix(in srgb, var(--color-warning) 22%, transparent)"
        : "color-mix(in srgb, var(--color-success) 22%, transparent)";
    return (
        <motion.div
            variants={cardVariants}
            initial="initial"
            animate="animate"
            className="flex items-center gap-[11px] rounded-[11px] border bg-surface-raised px-[14px] py-[12px]"
            style={{ borderColor: border }}
        >
            {/* body unchanged */}
        </motion.div>
    );
}
```

Keep the entire inner body of the card (the `<div className="w-[94px] ...">` block and the `<div className="flex flex-1 justify-end ...">` donut row) exactly as-is; only the outer wrapper element changes from `div` to `motion.div` with the three variant props.

- [ ] **Step 3: Latch the Historical reveal in the parent**

In `UsageSurface`, after `const hasHistory = ...` is computed (currently around the `hasHistory` const), add:

```tsx
const revealHistory = useDidBecomeTrue(hasHistory);
```

- [ ] **Step 4: Wrap the Historical branch in a one-shot reveal and wrap the whole surface in MotionConfig**

Change the outermost returned element from `<div className="absolute inset-0 overflow-y-auto">` to a `MotionConfig` wrapping it:

```tsx
return (
    <MotionConfig reducedMotion="user">
        <div className="absolute inset-0 overflow-y-auto">
            {/* ...all existing content unchanged... */}
        </div>
    </MotionConfig>
);
```

Then replace the Historical fragment (the `hasHistory ? ... : (<> ... </>)` true-branch, currently `<> ...StatCards, SplitCard, DailyChart, providers... </>`) with a `motion.div` that reveals once:

```tsx
{!hasHistory ? (
    <div className="mt-10 text-center text-[13px] text-muted">No usage yet — start an agent.</div>
) : (
    <motion.div
        variants={cardVariants}
        initial={revealHistory ? "initial" : false}
        animate="animate"
    >
        {/* the existing StatCards grid, SplitCard, DailyChart, and providers grid — unchanged */}
    </motion.div>
)}
```

`initial={false}` when `revealHistory` is false means no animation on a tab re-entry where usage data is already cached (the parent mounts already-true, so the latch never fires). `initial="initial"` fires the reveal exactly once, on first data arrival.

- [ ] **Step 5: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 6: Full unit test run**

Run: `npx vitest run frontend/app/view/agents`
Expected: PASS (no usage-surface tests regress; existing usage `.test.ts` files for the stores/pricing are unaffected).

- [ ] **Step 7: Visual check on the live dev app**

- First-load reveal: clear dev data (`task dev:cleardata`) or start with an empty usage atom, open the Usage surface, then run `node scripts/inject-live-agents.mjs <scenario>` so history arrives while the surface is open. Expected: the Historical block fades+scales in once (m1).
- No-replay: switch to another surface and back to Usage. Expected: Historical does **not** re-animate (data cached → born already-true).
- Live card: with a fresh Claude agent reporting quota, expected the Live-limit card enters with the same fade+scale.
- Reduced motion: toggle OS reduced-motion and confirm the reveal and card entrance are suppressed.
Capture: `node scripts/cdp-shot.mjs usage-reveal.png`

- [ ] **Step 8: Commit**

```bash
git add frontend/app/view/agents/usagesurface.tsx
git commit -m "feat(usage): live-card entrance + one-shot Historical load reveal (m1)"
```

---

### Task 6: Update the animation revamp tracker

**Files:**
- Modify: `docs/superpowers/animation-revamp-tracker.md`

**Interfaces:**
- Consumes: the final commit SHA of Task 5 (the last usage-surface commit).
- Produces: nothing downstream.

- [ ] **Step 1: Flip the Usage row to shipped**

In the surface rollout table, change the Usage row from:

```
| Usage | ☐ Not started | Bars/donuts. Candidates: value/bar transitions (m7 micro); avoid decorative-only motion. |
```

to (fill `<SHA>` with the Task 5 commit SHA):

```
| Usage | ✅ Shipped (2026-07-04) | Bars tween on recompute (m7, Files idiom): split/model/daily. Live donut rings sweep via `@property --usage-arc` (m7). Live-limit card entrance + one-shot Historical load reveal (m1, `useDidBecomeTrue`). Reduced motion: `MotionConfig` + `useReducedMotion` gate on inline transitions. No count-up, no cascade, no new motion module. SHA `<SHA>`. |
```

- [ ] **Step 2: Add references**

Under `## References`, append:

```
- Usage motion design spec: `docs/superpowers/specs/2026-07-04-usage-motion-design.md`
- Usage motion implementation plan: `docs/superpowers/plans/2026-07-04-usage-motion-system.md`
```

Also bump the `Last updated:` line near the top to today's date.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/animation-revamp-tracker.md docs/superpowers/specs/2026-07-04-usage-motion-design.md docs/superpowers/plans/2026-07-04-usage-motion-system.md
git commit -m "docs(motion): ship usage-surface motion; update tracker"
```

---

## Self-Review

**Spec coverage:**
- Bars (split/model/daily) width/height tween → Task 3. ✓
- Donut `@property --usage-arc` sweep → Task 2 (register) + Task 4 (use). ✓
- Live-limit card entrance (m1) → Task 5 Step 2. ✓
- Historical one-shot load reveal, edge-latched in parent, no tab-switch replay → Task 1 (hook) + Task 5 Steps 3–4. ✓
- Reduced motion: `MotionConfig` + `useReducedMotion` gate → Task 3 (gate) + Task 5 (MotionConfig). ✓
- Rejected decorations (count-up, cascade) → not implemented, called out in Global Constraints. ✓
- No `usagemotion.ts` module → honored (File Structure). ✓
- Tracker flip + references → Task 6. ✓

**Placeholder scan:** No TBD/TODO/"add error handling"/"similar to Task N". The only literal placeholder is `<SHA>` in Task 6, which is intentional (filled at execution from the Task 5 commit) and `<scenario>` for the inject script, which is the script's own argument.

**Type consistency:** `useDidBecomeTrue(flag: boolean): boolean` defined in Task 1, consumed in Task 5 Step 3. `barTransition(reduce, prop)` defined in Task 3 Step 2, used in Steps 3–5. `CSSProperties` imported in Task 4 Step 1, used Step 2. `MOTION`/`easeFluidCss`/`cardVariants` from `motiontokens`; `motion`/`MotionConfig`/`useReducedMotion` from `motion/react` — import lines consolidated across Tasks 3–5 (each task shows the full current import line to avoid drift).

**Note on TDD:** The repo has no React-hook test harness, so Tasks 3–5 verify via typecheck + CDP visual check rather than a red/green unit cycle — this matches the shipped Files/Channels motion plans. The only pure logic (the `useDidBecomeTrue` edge rule) is documented in a skip test per repo convention.
