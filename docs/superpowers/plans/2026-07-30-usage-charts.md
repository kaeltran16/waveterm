# Usage Charts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the cockpit one meter primitive for its nine percentage bars/rings and put its one real chart (`DailyChart`) on visx, with a colorblind-validated chart palette.

**Architecture:** Two standards, because the inventory has two shapes. Meters (a single number as a bar or ring) become three zero-dependency components in `frontend/app/element/meter.tsx`, backed by a pure geometry module. The one chart with an axis moves to visx 4.0.0 for scales/ticks/tooltip/brush, while keeping `motion` as the only animation system. Three dead chart deps are deleted.

**Tech Stack:** React 19, Tailwind 4 (`@theme` tokens auto-generate `bg-*` utilities), jotai, `motion` v12, visx 4.0.0, vitest.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-07-30-usage-charts-design.md`. Read it before starting.
- **Typecheck command is non-standard:** bare `npx tsc` stack-overflows on this repo. Always use `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`. Baseline is clean (exit 0); any error it reports is yours.
- **No hardcoded colors.** Never a raw hex or `rgba()` in a component. Add `--color-*` in `frontend/tailwindsetup.css` `@theme` and use the generated utility (`bg-chart-1`) or `var(--color-chart-1)`.
- **No new SCSS.** Tailwind utilities only.
- **Do not run `prettier --write` on any file you did not create.** It reorders imports and rewraps the whole file, turning a 4-line edit into a 600+ line diff. Hand-format your own lines to match surrounding style (4-space indent).
- **Never hand-edit generated files.** Not applicable here, but do not touch `frontend/app/store/wshclientapi.ts`.
- **Do not touch `frontend/app/view/agents/memgraph.tsx` or `frontend/app/view/jarvis/jarvisgraph.tsx`.** Both are modified in the working tree by another session. They are force-graph viz, out of scope.
- **No jsdom render/snapshot tests for surfaces.** Standing decision (2026-07-21). Pure logic gets vitest; "does it render" is verified over CDP via `task verify:ui`.
- **Commits are gated.** This repo's rule is: never commit without explicit approval, and batch into one commit at the end. Each task below ends with a **Checkpoint** (verify + report), not a commit. Task 12 is the single approval-gated commit, which also folds in the spec and this plan — spec/plan docs never land as a separate docs-only commit.
- **Light mode is out of scope, permanently.** The palette is validated against the dark surface `#13171d` only.
- Exact validated palette values, copied verbatim — changing any of them requires re-running the validator:
  - Categorical ×4: `#5176cd` `#48a260` `#a6560a` `#974391`
  - Provider series: claude `#d17050`, codex `#3786c3`
  - Ordinal ×4: `#7ca7ff` `#658be4` `#5171bb` `#3f5893`

---

## File Structure

**Create:**
- `frontend/app/element/metergeometry.ts` — pure segment/percentage math. No React.
- `frontend/app/element/metergeometry.test.ts` — unit tests for the above.
- `frontend/app/element/meter.tsx` — `Meter`, `StackedMeter`, `ArcMeter`.
- `frontend/app/view/agents/chartpalette.test.ts` — palette regression guard.
- `frontend/app/view/agents/dailychart.tsx` — the visx chart, extracted out of `usagesurface.tsx`.

**Modify:**
- `package.json` — 3 deps out, 4 in.
- `frontend/tailwindsetup.css` — add 10 chart tokens to `@theme`.
- `frontend/app/view/agents/usagestats.ts` — own `CLASS_FILL`; drop the 30-day cap; add `foldModels`.
- `frontend/app/view/agents/usagestats.test.ts` — cover the above.
- `frontend/app/view/agents/usagesurface.tsx` — delete `SplitBar`/`MiniDonut`/`DailyChart`/`MODEL_COLORS`/`CLASS_COLOR`; consume the new primitives.
- `frontend/app/view/agents/tokenusagesection.tsx` — delete its duplicate `StackedBar` + `CLASS_COLOR`.
- `frontend/app/cockpit/app-bar.tsx` — donut → `ArcMeter`.
- `frontend/app/view/agents/agentdetailsrail.tsx`, `agentrow.tsx`, `cockpitrail.tsx`, `runworkercard.tsx`, `filessurface.tsx` — bars → `Meter`/`StackedMeter`.
- `scripts/cdp/scenarios.mjs` — add a `usage-charts` scenario.

`dailychart.tsx` is split out because `usagesurface.tsx` is already 645 lines and the chart is the single largest component in it; the chart and its tooltip/brush change together and belong together.

---

### Task 1: Dependencies

**Files:**
- Modify: `package.json`

**Interfaces:**
- Consumes: nothing.
- Produces: `@visx/scale`, `@visx/axis`, `@visx/tooltip`, `@visx/brush` importable at 4.0.0.

- [ ] **Step 1: Confirm the three removals are truly unused**

Run:
```bash
grep -rn "from \"recharts\"\|from \"@observablehq/plot\"\|from \"htl\"" --include=*.ts --include=*.tsx frontend/
```
Expected: **no output.** If anything prints, STOP and report — the spec's premise is wrong.

- [ ] **Step 2: Remove the dead chart deps**

```bash
npm uninstall recharts @observablehq/plot htl
```

- [ ] **Step 3: Add visx**

```bash
npm install @visx/scale@4.0.0 @visx/axis@4.0.0 @visx/tooltip@4.0.0 @visx/brush@4.0.0
```

- [ ] **Step 4: Verify no redux/immer contamination and no duplicate d3**

Run:
```bash
npm ls @reduxjs/toolkit react-redux 2>&1 | head -5
npm ls immer 2>&1 | head -10
npm ls d3-scale d3-array 2>&1 | head -20
```
Expected: no `@reduxjs/toolkit` / `react-redux` in the tree; exactly one `immer` major (`10.x`); `d3-scale`/`d3-array` present once each under `@visx/*` (`d3-force-3d` bundles its own d3 internals and must not produce a second `d3-scale` major). If a second `immer` major or a duplicate `d3-scale` major appears, STOP and report.

- [ ] **Step 5: Typecheck still clean**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0, no output.

- [ ] **Step 6: Checkpoint**

Report: which deps were removed/added, and the `npm ls` output for immer and d3-scale.

---

### Task 2: Chart palette tokens + regression guard

**Files:**
- Modify: `frontend/tailwindsetup.css` (insert after `--color-cacheread`, currently line 68)
- Create: `frontend/app/view/agents/chartpalette.test.ts`

**Interfaces:**
- Produces: CSS custom properties `--color-chart-1..4`, `--color-chart-claude`, `--color-chart-codex`, `--color-chart-seq-1..4`, and the Tailwind utilities Tailwind 4 generates from them (`bg-chart-1`, `bg-chart-seq-2`, …). Later tasks use the utility form for fills and the `var()` form for `conic-gradient` and SVG `fill`.

- [ ] **Step 1: Write the failing test**

Create `frontend/app/view/agents/chartpalette.test.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// These values were validated for colorblind separation, lightness band and chroma floor against the
// dark chart surface (#13171d). The guard exists so a later "just nudge the blue" edit cannot silently
// break CVD compliance: if you change a value here, re-run the validator and update both together.
const EXPECTED: Record<string, string> = {
    "--color-chart-1": "#5176cd",
    "--color-chart-2": "#48a260",
    "--color-chart-3": "#a6560a",
    "--color-chart-4": "#974391",
    "--color-chart-claude": "#d17050",
    "--color-chart-codex": "#3786c3",
    "--color-chart-seq-1": "#7ca7ff",
    "--color-chart-seq-2": "#658be4",
    "--color-chart-seq-3": "#5171bb",
    "--color-chart-seq-4": "#3f5893",
};

describe("chart palette", () => {
    const css = readFileSync(join(process.cwd(), "frontend/tailwindsetup.css"), "utf8");

    it.each(Object.entries(EXPECTED))("%s is the validated value", (token, hex) => {
        const m = css.match(new RegExp(`${token}:\\s*(#[0-9a-fA-F]{6})`));
        expect(m?.[1]?.toLowerCase()).toBe(hex);
    });

    // Series identity must not shift when the chrome preset changes, and excluding chart tokens from
    // the override map is what keeps ONE validated palette valid across all 6 presets.
    it("chart tokens are absent from the runtime theme override map", () => {
        const themes = readFileSync(join(process.cwd(), "frontend/app/view/agents/themes.ts"), "utf8");
        expect(themes).not.toMatch(/--color-chart-/);
    });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run frontend/app/view/agents/chartpalette.test.ts`
Expected: FAIL — 10 assertions fail because the tokens don't exist yet (`m` is null). The theme-override test should already PASS.

- [ ] **Step 3: Add the tokens**

In `frontend/tailwindsetup.css`, immediately after the `--color-cacheread` line, insert:

```css
    /* Chart series colors, validated against the dark chart surface (#13171d) for CVD separation,
       lightness band (L .48-.67) and chroma floor (C >= .10). Deliberately NOT in themes.ts's
       buildThemeVars override map: series identity must not shift with the chrome preset, and keeping
       these fixed means one validated palette stays valid across all 6 presets instead of needing six
       revalidations. Changing a value here requires re-running the validator and updating
       chartpalette.test.ts. */
    --color-chart-1: #5176cd;
    --color-chart-2: #48a260;
    --color-chart-3: #a6560a;
    --color-chart-4: #974391;
    /* provider series: claude keeps its brand hue (38.8) dropped into band; codex's brand is
       achromatic (fails the chroma floor as a fill) so it takes a cool slate that reads as muted */
    --color-chart-claude: #d17050;
    --color-chart-codex: #3786c3;
    /* ordinal ramp for ranked magnitude (by-model): one hue, monotone lightness */
    --color-chart-seq-1: #7ca7ff;
    --color-chart-seq-2: #658be4;
    --color-chart-seq-3: #5171bb;
    --color-chart-seq-4: #3f5893;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run frontend/app/view/agents/chartpalette.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Checkpoint**

Report the passing test count.

---

### Task 3: `metergeometry.ts` — pure meter math

**Files:**
- Create: `frontend/app/element/metergeometry.ts`
- Create: `frontend/app/element/metergeometry.test.ts`

**Interfaces:**
- Produces:
  - `interface MeterSeg { key: string; value: number; fill: string }`
  - `interface MeterSlice { key: string; fill: string; pct: number }`
  - `meterSegments(segs: MeterSeg[], total?: number): MeterSlice[]`
  - `meterPct(value: number): number`

- [ ] **Step 1: Write the failing test**

Create `frontend/app/element/metergeometry.test.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { meterPct, meterSegments } from "./metergeometry";

describe("meterSegments", () => {
    it("sizes each segment as a share of the explicit total", () => {
        const out = meterSegments([
            { key: "a", value: 25, fill: "bg-chart-1" },
            { key: "b", value: 75, fill: "bg-chart-2" },
        ], 100);
        expect(out).toEqual([
            { key: "a", fill: "bg-chart-1", pct: 25 },
            { key: "b", fill: "bg-chart-2", pct: 75 },
        ]);
    });

    // A 2px gap sits between fills; a gap around a zero-width fill reads as a visible seam, so
    // zero-value segments are dropped rather than rendered at 0%.
    it("drops zero and negative segments entirely", () => {
        const out = meterSegments([
            { key: "a", value: 10, fill: "bg-chart-1" },
            { key: "b", value: 0, fill: "bg-chart-2" },
            { key: "c", value: -5, fill: "bg-chart-3" },
        ], 10);
        expect(out.map((s) => s.key)).toEqual(["a"]);
    });

    it("falls back to the segment sum when no total is given", () => {
        const out = meterSegments([
            { key: "a", value: 1, fill: "bg-chart-1" },
            { key: "b", value: 3, fill: "bg-chart-2" },
        ]);
        expect(out.map((s) => s.pct)).toEqual([25, 75]);
    });

    it("returns nothing when there is no positive magnitude", () => {
        expect(meterSegments([{ key: "a", value: 0, fill: "bg-chart-1" }], 0)).toEqual([]);
        expect(meterSegments([], 100)).toEqual([]);
    });

    it("lets segments under-fill the track when they do not sum to the total", () => {
        const out = meterSegments([{ key: "a", value: 20, fill: "bg-chart-1" }], 100);
        expect(out[0].pct).toBe(20);
    });
});

describe("meterPct", () => {
    it("clamps into 0..100", () => {
        expect(meterPct(50)).toBe(50);
        expect(meterPct(140)).toBe(100);
        expect(meterPct(-3)).toBe(0);
    });

    it("collapses non-finite input to 0 so a bad computation cannot overflow the track", () => {
        expect(meterPct(NaN)).toBe(0);
        expect(meterPct(Infinity)).toBe(100);
    });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run frontend/app/element/metergeometry.test.ts`
Expected: FAIL — cannot resolve `./metergeometry`.

- [ ] **Step 3: Write the implementation**

Create `frontend/app/element/metergeometry.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pure geometry for the meter primitives (element/meter.tsx). Kept React-free so the segment and
// clamping rules are unit-testable on their own — the components are then thin enough to verify by eye.

export interface MeterSeg {
    key: string;
    value: number;
    fill: string; // tailwind utility class, e.g. "bg-chart-1"
}

export interface MeterSlice {
    key: string;
    fill: string;
    pct: number;
}

// Non-positive segments are dropped, not rendered at 0% width: StackedMeter puts a 2px gap between
// fills and a gap around a zero-width fill reads as a seam. Segments may under-fill the track (a
// partial-progress stack), so pct is not normalised to sum to 100.
export function meterSegments(segs: MeterSeg[], total?: number): MeterSlice[] {
    const live = segs.filter((s) => s.value > 0);
    const denom = total != null && total > 0 ? total : live.reduce((sum, s) => sum + s.value, 0);
    if (denom <= 0) return [];
    return live.map((s) => ({ key: s.key, fill: s.fill, pct: (s.value / denom) * 100 }));
}

export function meterPct(value: number): number {
    if (Number.isNaN(value)) return 0;
    return Math.min(100, Math.max(0, value));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run frontend/app/element/metergeometry.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Checkpoint**

---

### Task 4: `meter.tsx` — the three primitives

**Files:**
- Create: `frontend/app/element/meter.tsx`

**Interfaces:**
- Consumes: `meterSegments`, `meterPct`, `MeterSeg` from Task 3; `MOTION`, `easeFluidCss` from `@/app/element/motiontokens`.
- Produces, used by Tasks 5, 6, 10:
  - `Meter({ pct, fill, height?, radius?, track?, className? })`
  - `StackedMeter({ segs, total?, height?, radius?, track?, className? })`
  - `ArcMeter({ pct, size, thickness, color, track?, center?, className?, children? })` — `pct` may be `undefined` for a "no data" ring.

No render test — standing decision. Correctness is established by the pure math in Task 3 plus the CDP scenario in Task 11.

- [ ] **Step 1: Write the component module**

Create `frontend/app/element/meter.tsx`:

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The cockpit's meter primitives: one number, as a bar or a ring. These are deliberately NOT charts —
// no scales, no axes, no library (the one real chart is DailyChart, on visx). Consolidates the nine
// bars/rings that were hand-rolled across the cockpit; see
// docs/superpowers/specs/2026-07-30-usage-charts-design.md.
//
// Fills are tailwind utility classes ("bg-chart-1", "bg-success") because Tailwind 4 generates a
// bg-* utility for every @theme --color-* token, so callers never name a raw color. ArcMeter is the
// exception: conic-gradient needs a color VALUE, so it takes a var(--color-*) reference.

import { MOTION, easeFluidCss } from "@/app/element/motiontokens";
import { meterPct, meterSegments, type MeterSeg } from "@/app/element/metergeometry";
import { cn } from "@/util/util";
import { useReducedMotion } from "motion/react";
import type { CSSProperties, ReactNode } from "react";

// undefined under reduced motion so the value snaps instead of tweening
function widthTween(reduce: boolean | null): string | undefined {
    return reduce ? undefined : `width ${MOTION.durMacro}s ${easeFluidCss}`;
}

export function Meter({
    pct,
    fill,
    height = 7,
    radius = 4,
    track = "bg-surface-hover",
    className,
}: {
    pct: number;
    fill: string;
    height?: number;
    radius?: number;
    track?: string;
    className?: string;
}) {
    const reduce = useReducedMotion();
    return (
        <div className={cn("overflow-hidden", track, className)} style={{ height, borderRadius: radius }}>
            <div
                className={cn("h-full", fill)}
                style={{ width: `${meterPct(pct)}%`, borderRadius: radius, transition: widthTween(reduce) }}
            />
        </div>
    );
}

export function StackedMeter({
    segs,
    total,
    height = 11,
    radius = 5,
    track = "bg-surface-hover",
    className,
}: {
    segs: MeterSeg[];
    total?: number;
    height?: number;
    radius?: number;
    track?: string;
    className?: string;
}) {
    const reduce = useReducedMotion();
    const slices = meterSegments(segs, total);
    return (
        <div
            className={cn("flex gap-[2px] overflow-hidden", track, className)}
            style={{ height, borderRadius: radius }}
        >
            {slices.map((s) => (
                <div
                    key={s.key}
                    className={cn("h-full", s.fill)}
                    style={{ width: `${s.pct}%`, transition: widthTween(reduce) }}
                />
            ))}
        </div>
    );
}

// Ring gauge. The sweep animates via the @property-registered --usage-arc (tailwindsetup.css) — a bare
// custom property would not transition. Registration is global but VALUES inherit per element, so any
// number of ArcMeters can animate independently without extra scoping.
export function ArcMeter({
    pct,
    size,
    thickness,
    color,
    track = "var(--color-edge-strong)",
    center = "bg-background",
    className,
    children,
}: {
    pct?: number;
    size: number;
    thickness: number;
    color: string; // a var(--color-*) reference
    track?: string;
    center?: string;
    className?: string;
    children?: ReactNode;
}) {
    const reduce = useReducedMotion();
    const has = pct != null;
    const hole = size - thickness * 2;
    const style = {
        width: size,
        height: size,
        background: `conic-gradient(${has ? color : "var(--color-edge-strong)"} 0 var(--usage-arc), ${track} 0)`,
        "--usage-arc": `${has ? meterPct(pct) : 0}%`,
        transition: reduce ? undefined : `--usage-arc ${MOTION.durMacro}s ${easeFluidCss}`,
    } as CSSProperties;
    return (
        <div className={cn("flex flex-none items-center justify-center rounded-full", className)} style={style}>
            <div
                className={cn("flex flex-none items-center justify-center rounded-full", center)}
                style={{ width: hole, height: hole }}
            >
                {children}
            </div>
        </div>
    );
}
```

- [ ] **Step 2: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 3: Checkpoint**

---

### Task 5: Unify `CLASS_FILL` and the two drifted pairs

This is the task that fixes real bugs, not just line count: the app-bar donut currently has no `--usage-arc` so it does not animate at all despite `app-bar.tsx:16-17` claiming it matches the Usage tab, and `SplitBar`/`StackedBar` disagree on track color and zero handling.

**Files:**
- Modify: `frontend/app/view/agents/usagestats.ts` (add `CLASS_FILL` beside `CLASS_ORDER`/`CLASS_LABEL`)
- Modify: `frontend/app/view/agents/usagesurface.tsx` (delete `CLASS_COLOR` at :34, `SplitBar` at :215, `MiniDonut` at :125)
- Modify: `frontend/app/view/agents/tokenusagesection.tsx` (delete `CLASS_COLOR` at :14, `StackedBar` at :43)
- Modify: `frontend/app/cockpit/app-bar.tsx` (donut at :42 and its markup at :99-104)

**Interfaces:**
- Consumes: `Meter`/`StackedMeter`/`ArcMeter` from Task 4.
- Produces: `CLASS_FILL: Record<TokenClass, string>` exported from `usagestats.ts`, consumed by `usagesurface.tsx` and `tokenusagesection.tsx`.

- [ ] **Step 1: Add `CLASS_FILL` to the pure module**

In `frontend/app/view/agents/usagestats.ts`, directly below the existing `CLASS_LABEL`, add:

```ts
// Tailwind fill utility per token class. Single source of truth — this was previously duplicated
// verbatim in usagesurface.tsx and tokenusagesection.tsx. Slots come from the validated categorical
// palette: cacheWrite/input keep their old amber/green associations, output stays blue. cacheRead
// necessarily changes from the old grey (--color-cacheread): a categorical palette requires chroma
// >= .10, so a grey cannot carry series identity — it takes the darkest validated slot instead.
export const CLASS_FILL: Record<TokenClass, string> = {
    cacheRead: "bg-chart-4",
    output: "bg-chart-1",
    cacheWrite: "bg-chart-3",
    input: "bg-chart-2",
};
```

- [ ] **Step 2: Replace `SplitBar` in `usagesurface.tsx`**

Delete the `CLASS_COLOR` const (:34-39) and the whole `SplitBar` function (:215-232). Add `CLASS_FILL` to the existing `./usagestats` import. In `SplitCard`, replace both `<SplitBar .../>` usages:

```tsx
            <StackedMeter
                className="mb-[18px]"
                height={30}
                radius={7}
                track="bg-background"
                segs={split.map((c) => ({ key: c.cls, value: c.tokens, fill: CLASS_FILL[c.cls] }))}
            />
```

and for the spend bar, the same with `value: c.spendUsd`.

In the 4-up legend grid (:264-285) the swatch changes from an inline `background` to the utility:

```tsx
                            <span className={cn("h-[10px] w-[10px] flex-none rounded-[3px]", CLASS_FILL[c.cls])} />
```

- [ ] **Step 3: Replace `StackedBar` in `tokenusagesection.tsx`**

Delete its `CLASS_COLOR` (:14-19) and `StackedBar` (:43-54). Import `StackedMeter` and `CLASS_FILL`. Replace each `<StackedBar segs={...} total={...} />` with:

```tsx
            <StackedMeter
                height={11}
                radius={5}
                segs={classes.map((c) => ({ key: c.cls, value: c.tokens, fill: CLASS_FILL[c.cls] }))}
                total={totalTokens}
            />
```

and the spend bar with `value: c.spendUsd` / `total={totalSpendUsd}`. Update its swatch at :133 to `className={cn("h-[9px] w-[9px] flex-none rounded-[3px]", CLASS_FILL[c.cls])}`. Update the file's header comment, which says class colors "mirror usagesurface.tsx's CLASS_COLOR" — they now come from `usagestats.ts`.

- [ ] **Step 4: Replace the ring inside `MiniDonut`**

`MiniDonut` keeps its label/reset/projection layout; only the ring becomes `ArcMeter`. Size 40, hole 29, so `thickness={5.5}`:

```tsx
            <ArcMeter pct={pct} size={40} thickness={5.5} color={RING[usageLevel(pct ?? 0)]}>
                <span className="font-mono text-[10px] font-bold text-primary">
                    {pct != null ? Math.round(pct) + "%" : "—"}
                </span>
            </ArcMeter>
```

Delete the now-unused `ringStyle` block and the `CSSProperties` import if nothing else in the file uses it.

- [ ] **Step 5: Replace the app-bar donut**

In `frontend/app/cockpit/app-bar.tsx`, drop the `donut:` conic-gradient string from the `gauges` map (:42) and keep `pct`/`provider`/`rt`. Replace the ring markup (:99-104) — size 18, hole 11, so `thickness={3.5}`, and `center="bg-surface"` to preserve the current inner color:

```tsx
                                    <ArcMeter
                                        pct={g.pct}
                                        size={18}
                                        thickness={3.5}
                                        color={DONUT_COLOR[usageLevel(g.pct)]}
                                        center="bg-surface"
                                    />
```

This is the bug fix: the donut now animates its sweep and uses the same `--color-edge-strong` track as the Usage tab, which the comment at :16-17 always claimed.

- [ ] **Step 6: Verify no orphaned references**

Run:
```bash
grep -rn "CLASS_COLOR\|SplitBar\|StackedBar\|ringStyle\|g.donut" --include=*.tsx --include=*.ts frontend/
```
Expected: **no output.**

- [ ] **Step 7: Typecheck and run the full suite**

Run:
```bash
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit
npx vitest run
```
Expected: tsc exit 0; vitest all pass.

- [ ] **Step 8: Checkpoint**

Report: the grep was empty, tsc clean, vitest pass count.

---

### Task 6: Migrate the five mechanical meter callsites

Note a correction to the spec: `filessurface.tsx` is a **two-segment stacked** bar (accepted + rejected), not a plain progress bar, so it takes `StackedMeter`.

**Files:**
- Modify: `frontend/app/view/agents/agentdetailsrail.tsx:148-152`
- Modify: `frontend/app/view/agents/agentrow.tsx:102-104`
- Modify: `frontend/app/view/agents/cockpitrail.tsx:49-54`
- Modify: `frontend/app/view/agents/runworkercard.tsx:134-136`
- Modify: `frontend/app/view/agents/filessurface.tsx:434-437`

**Interfaces:**
- Consumes: `Meter`, `StackedMeter` from Task 4. Existing `GAUGE_FILL`, `PLAN_BAR`, `usageLevel` stay as they are — they already produce Tailwind fill classes, which is exactly what `Meter`'s `fill` prop wants.

- [ ] **Step 1: `agentdetailsrail.tsx`**

Replace the track+span pair with:

```tsx
                              <Meter
                                  pct={ctxPct}
                                  fill={GAUGE_FILL[usageLevel(ctxPct)]}
                                  height={7}
                                  radius={4}
                              />
```

(`bg-surface-hover` is `Meter`'s default track, matching the original.)

- [ ] **Step 2: `agentrow.tsx`**

```tsx
            <Meter pct={pct} fill="bg-success" height={5} radius={3} track="bg-edge-faint" className="mb-3" />
```

- [ ] **Step 3: `cockpitrail.tsx`**

```tsx
            <Meter pct={pct} fill={PLAN_BAR[lvl]} height={7} radius={4} track="bg-surface-raised" />
```

- [ ] **Step 4: `runworkercard.tsx`**

```tsx
                            <Meter pct={prog.pct} fill="bg-success" height={5} radius={3} track="bg-edge-faint" />
```

- [ ] **Step 5: `filessurface.tsx` — two segments, so `StackedMeter`**

```tsx
                            <StackedMeter
                                height={6}
                                radius={4}
                                total={rprog.total}
                                segs={[
                                    { key: "accepted", value: rprog.accepted, fill: "bg-success" },
                                    { key: "rejected", value: rprog.rejected, fill: "bg-error" },
                                ]}
                            />
```

This drops the two inline `transition: width ...` strings — `StackedMeter` owns that tween now. Remove the `MOTION`/`easeFluidCss` imports from this file **only if** nothing else in it uses them; check first with `grep -n "MOTION\|easeFluidCss" frontend/app/view/agents/filessurface.tsx`.

- [ ] **Step 6: Typecheck and full suite**

Run:
```bash
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit
npx vitest run
```
Expected: tsc exit 0; vitest all pass.

- [ ] **Step 7: Checkpoint**

---

### Task 7: Uncap the daily series

**Files:**
- Modify: `frontend/app/view/agents/usagestats.ts` (`MAX_DAILY_DAYS` :81, `dailyTruncated` :71 + :231-243)
- Modify: `frontend/app/view/agents/usagestats.test.ts`
- Modify: `frontend/app/view/agents/usagesurface.tsx` (stops passing `truncated`)

**Interfaces:**
- Produces: `UsageStats` without the `dailyTruncated` field; `daily` now spans the whole loaded window, bounded only by `enumerateDays`' existing 3650-iteration guard.

- [ ] **Step 1: Write the failing test**

Add to `frontend/app/view/agents/usagestats.test.ts`:

```ts
    // The 30-day cap used to truncate the all-time series silently; the brush replaces it, so the
    // aggregation must now return every day in range.
    it("returns every day in range without a 30-day cap", () => {
        const day = (n: number) => {
            const d = new Date(2026, 0, 1);
            d.setDate(d.getDate() + n);
            const m = String(d.getMonth() + 1).padStart(2, "0");
            return `${d.getFullYear()}-${m}-${String(d.getDate()).padStart(2, "0")}`;
        };
        const buckets = [0, 44].map((n) => ({
            day: day(n),
            provider: "claude",
            model: "claude-opus-4",
            input: 10,
            output: 5,
            cacheread: 0,
            cachecreate: 0,
        })) as UsageBucket[];
        const stats = aggregateBuckets(buckets, new Date(2026, 1, 14).getTime());
        expect(stats.daily.length).toBe(45);
        expect(stats.daily[0].day).toBe(day(0));
        expect(stats.daily[44].day).toBe(day(44));
        expect("dailyTruncated" in stats).toBe(false);
    });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run frontend/app/view/agents/usagestats.test.ts`
Expected: FAIL — `daily.length` is 30, and `dailyTruncated` is present.

- [ ] **Step 3: Remove the cap**

In `usagestats.ts`: delete `const MAX_DAILY_DAYS = 30;` (:81) and the `dailyTruncated` field from the `UsageStats` interface (:71). Replace the capping block:

```ts
    let daily: DailyUsage[] = [];
    if (minDay != null) {
        const endKey = maxDay != null && maxDay > today ? maxDay : today;
        daily = enumerateDays(minDay, endKey).map((day) => {
            const e = byDay.get(day) ?? { ct: 0, xt: 0, cs: 0, xs: 0 };
            return { day, claudeTokens: e.ct, codexTokens: e.xt, claudeSpendUsd: e.cs, codexSpendUsd: e.xs };
        });
    }
```

Remove `dailyTruncated` from the returned object. Update the `daily` field's doc comment — it no longer says "capped to last 30 in range".

- [ ] **Step 4: Fix any other `dailyTruncated` reader**

Run: `grep -rn "dailyTruncated\|MAX_DAILY_DAYS" --include=*.ts --include=*.tsx frontend/`
Expected after fixing: **no output.** In `usagesurface.tsx` this means dropping `truncated={stats.dailyTruncated}` from the `DailyChart` call; the `truncated` prop and its `label` branch are replaced wholesale in Task 8, so for now delete the prop and let the label read `window === "7d" ? "last 7 days" : "all time"`.

- [ ] **Step 5: Run the tests and typecheck**

Run:
```bash
npx vitest run frontend/app/view/agents/usagestats.test.ts
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit
```
Expected: PASS; tsc exit 0.

- [ ] **Step 6: Checkpoint**

---

### Task 8: `DailyChart` on visx — scales, axes, tooltip

**Files:**
- Create: `frontend/app/view/agents/dailychart.tsx`
- Modify: `frontend/app/view/agents/usagesurface.tsx` (delete `DailyChart` :290-387 and `DAILY_CHART_H` :47; import the new one)

**Interfaces:**
- Consumes: `DailyUsage` from `./usagestats`; `fmt`/`usd` — **export these two from `usagesurface.tsx`** so the chart reuses the exact same formatters rather than a third copy (`tokenusagesection.tsx` already has its own).
- Produces: `DailyChart({ daily, window, metric, onMetric })`, default-exported as a named export, consumed by `usagesurface.tsx`. `Segmented` must also be exported from `usagesurface.tsx` for the metric toggle.

- [ ] **Step 1: Export the shared bits from `usagesurface.tsx`**

Change `function fmt`, `function usd` and `function Segmented` to `export function`. Leave `pctStr` alone.

- [ ] **Step 2: Write the chart**

Create `frontend/app/view/agents/dailychart.tsx`:

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The Usage tab's one real chart: stacked daily columns (claude + codex) over a band day-axis. On visx
// for scales/ticks/tooltip, but the bars are motion.rect so the cockpit keeps ONE animation system —
// visx supplies no animation of its own, which is why it was chosen over recharts (whose built-in
// tween re-grows from the baseline on every data change, and usagesurface refreshes silently every 60s).
//
// Split out of usagesurface.tsx: it is the largest component there and its tooltip/brush change with it.

import useResizeObserver from "@react-hook/resize-observer";
import { MOTION, easeFluidCss } from "@/app/element/motiontokens";
import { AxisBottom, AxisLeft } from "@visx/axis";
import { scaleBand, scaleLinear } from "@visx/scale";
import { useTooltip, useTooltipInPortal } from "@visx/tooltip";
import { motion, useReducedMotion } from "motion/react";
import { useLayoutEffect, useRef, useState } from "react";
import type { DailyUsage } from "./usagestats";
import { Segmented, fmt, usd } from "./usagesurface";

const CHART_H = 156;
const MARGIN = { top: 6, right: 4, bottom: 22, left: 46 };
const BAR_MAX = 30;
const SERIES = [
    { key: "claude" as const, label: "claude", color: "var(--color-chart-claude)" },
    { key: "codex" as const, label: "codex", color: "var(--color-chart-codex)" },
];

interface Row {
    day: string; // "MM-DD"
    claude: number;
    codex: number;
    total: number;
}

export function toRows(daily: DailyUsage[], metric: "tokens" | "spend"): Row[] {
    return daily.map((d) => {
        const claude = metric === "tokens" ? d.claudeTokens : d.claudeSpendUsd;
        const codex = metric === "tokens" ? d.codexTokens : d.codexSpendUsd;
        return { day: d.day.slice(5), claude, codex, total: claude + codex };
    });
}

export function DailyChart({
    daily,
    window: win,
    metric,
    onMetric,
}: {
    daily: DailyUsage[];
    window: "7d" | "all";
    metric: "tokens" | "spend";
    onMetric: (m: "tokens" | "spend") => void;
}) {
    const reduce = useReducedMotion();
    const hostRef = useRef<HTMLDivElement>(null);
    const [width, setWidth] = useState(0);
    useLayoutEffect(() => {
        if (hostRef.current) setWidth(hostRef.current.clientWidth);
    }, []);
    useResizeObserver(hostRef, (e) => setWidth(e.contentRect.width));

    const { tooltipData, tooltipLeft, tooltipTop, tooltipOpen, showTooltip, hideTooltip } = useTooltip<Row>();
    const { containerRef, TooltipInPortal } = useTooltipInPortal({ scroll: true, detectBounds: true });

    const rows = toRows(daily, metric);
    const innerW = Math.max(0, width - MARGIN.left - MARGIN.right);
    const axisFmt = (v: number) => (metric === "tokens" ? fmt(v) : usd(v));

    const x = scaleBand<string>({ domain: rows.map((r) => r.day), range: [0, innerW], padding: 0.28 });
    const y = scaleLinear<number>({
        domain: [0, Math.max(1, ...rows.map((r) => r.total))],
        range: [CHART_H, 0],
        nice: true,
    });
    const bandW = Math.min(BAR_MAX, x.bandwidth());
    // thin day labels so they never collide: keep every nth so at most ~12 render
    const tickEvery = Math.max(1, Math.ceil(rows.length / 12));
    const tickDays = rows.filter((_, i) => i % tickEvery === 0).map((r) => r.day);

    return (
        <div className="mb-4 rounded-[14px] border border-border bg-surface-raised px-[22px] pb-5 pt-[18px]">
            <div className="mb-5 flex flex-wrap items-center gap-3">
                <h3 className="text-[15px] font-bold tracking-[-0.01em] text-primary">Daily</h3>
                <span className="font-mono text-[11px] text-muted">{win === "7d" ? "last 7 days" : "all time"}</span>
                <div className="flex-1" />
                <div className="flex items-center gap-[14px]">
                    {SERIES.map((s) => (
                        <span key={s.key} className="flex items-center gap-[5px] font-mono text-[10.5px] text-secondary">
                            <span className="h-[9px] w-[9px] rounded-[2px]" style={{ background: s.color }} />
                            {s.label}
                        </span>
                    ))}
                </div>
                <Segmented
                    value={metric}
                    onChange={onMetric}
                    options={[
                        { key: "tokens" as const, label: "Tokens" },
                        { key: "spend" as const, label: "Spend" },
                    ]}
                />
            </div>

            {rows.length === 0 ? (
                <div className="py-8 text-center font-mono text-[12px] text-muted">No activity in range.</div>
            ) : (
                <div ref={hostRef} className="relative w-full">
                    <svg ref={containerRef} width={width} height={CHART_H + MARGIN.top + MARGIN.bottom}>
                        <g transform={`translate(${MARGIN.left},${MARGIN.top})`}>
                            <AxisLeft
                                scale={y}
                                numTicks={3}
                                tickFormat={(v) => axisFmt(Number(v))}
                                stroke="var(--color-border)"
                                tickStroke="var(--color-border)"
                                tickLabelProps={() => ({
                                    fill: "var(--color-muted)",
                                    fontSize: 9.5,
                                    fontFamily: "var(--font-mono)",
                                    textAnchor: "end",
                                    dx: -4,
                                    dy: 3,
                                })}
                            />
                            <AxisBottom
                                top={CHART_H}
                                scale={x}
                                tickValues={tickDays}
                                stroke="var(--color-border)"
                                tickStroke="var(--color-border)"
                                tickLabelProps={() => ({
                                    fill: "var(--color-muted)",
                                    fontSize: 9.5,
                                    fontFamily: "var(--font-mono)",
                                    textAnchor: "middle",
                                    dy: 2,
                                })}
                            />
                            {rows.map((r, ri) => {
                                const cx = (x(r.day) ?? 0) + (x.bandwidth() - bandW) / 2;
                                const codexH = r.codex > 0 ? CHART_H - y(r.codex) : 0;
                                const claudeH = r.claude > 0 ? CHART_H - y(r.claude) : 0;
                                // 2px surface gap between the two stacked fills, per the mark spec
                                const gap = codexH > 0 && claudeH > 0 ? 2 : 0;
                                const claudeY = CHART_H - claudeH;
                                const codexY = claudeY - gap - codexH;
                                const grow = reduce
                                    ? {}
                                    : {
                                          initial: { scaleY: 0 },
                                          animate: { scaleY: 1 },
                                          transition: {
                                              delay: ri * 0.025,
                                              duration: MOTION.durMacro,
                                              ease: MOTION.easeFluid,
                                          },
                                      };
                                // SVG needs transformBox:fill-box for transformOrigin:bottom to mean what
                                // it means on a DOM element
                                const originStyle = {
                                    transformBox: "fill-box" as const,
                                    transformOrigin: "bottom",
                                    transition: reduce ? undefined : `height ${MOTION.durMacro}s ${easeFluidCss}`,
                                };
                                const onEnter = () =>
                                    showTooltip({
                                        tooltipData: r,
                                        tooltipLeft: MARGIN.left + cx + bandW / 2,
                                        tooltipTop: MARGIN.top + Math.max(0, claudeY - 12),
                                    });
                                return (
                                    <g key={r.day} onMouseEnter={onEnter} onMouseLeave={hideTooltip}>
                                        {/* hit target spans the whole column, wider than the mark */}
                                        <rect
                                            x={x(r.day) ?? 0}
                                            y={0}
                                            width={x.bandwidth()}
                                            height={CHART_H}
                                            fill="transparent"
                                        />
                                        {tooltipOpen && tooltipData?.day === r.day ? (
                                            <rect
                                                x={x(r.day) ?? 0}
                                                y={0}
                                                width={x.bandwidth()}
                                                height={CHART_H}
                                                fill="var(--color-surface-hover)"
                                                rx={3}
                                            />
                                        ) : null}
                                        {r.total === 0 ? (
                                            <rect
                                                x={cx}
                                                y={CHART_H - 2}
                                                width={bandW}
                                                height={2}
                                                rx={1}
                                                fill="var(--color-edge-strong)"
                                            />
                                        ) : null}
                                        {codexH > 0 ? (
                                            <motion.rect
                                                {...grow}
                                                x={cx}
                                                y={codexY}
                                                width={bandW}
                                                height={codexH}
                                                rx={4}
                                                fill="var(--color-chart-codex)"
                                                style={originStyle}
                                            />
                                        ) : null}
                                        {claudeH > 0 ? (
                                            <motion.rect
                                                {...grow}
                                                x={cx}
                                                y={claudeY}
                                                width={bandW}
                                                height={claudeH}
                                                rx={codexH > 0 ? 0 : 4}
                                                fill="var(--color-chart-claude)"
                                                style={originStyle}
                                            />
                                        ) : null}
                                    </g>
                                );
                            })}
                        </g>
                    </svg>

                    {tooltipOpen && tooltipData ? (
                        <TooltipInPortal
                            left={tooltipLeft}
                            top={tooltipTop}
                            className="!rounded-[7px] !border !border-border !bg-surface-raised !px-[10px] !py-[7px] !shadow-lg"
                        >
                            <div className="mb-[5px] font-mono text-[10.5px] font-semibold text-primary">
                                {tooltipData.day}
                            </div>
                            {SERIES.map((s) => (
                                <div key={s.key} className="flex items-center gap-[6px] font-mono text-[10.5px]">
                                    <span className="h-[8px] w-[8px] flex-none rounded-[2px]" style={{ background: s.color }} />
                                    <span className="text-muted">{s.label}</span>
                                    <span className="ml-auto pl-3 text-secondary">{axisFmt(tooltipData[s.key])}</span>
                                </div>
                            ))}
                            <div className="mt-[5px] flex items-center gap-[6px] border-t border-border pt-[5px] font-mono text-[10.5px]">
                                <span className="text-muted">total</span>
                                <span className="ml-auto pl-3 font-semibold text-primary">{axisFmt(tooltipData.total)}</span>
                            </div>
                        </TooltipInPortal>
                    ) : null}
                </div>
            )}
        </div>
    );
}
```

Values wear text tokens and a swatch carries identity — never a series color on text.

- [ ] **Step 3: Wire it into `usagesurface.tsx`**

Delete the old `DailyChart` (:290-387) and `DAILY_CHART_H` (:47). Add `import { DailyChart } from "./dailychart";` and update the call site to drop `truncated`:

```tsx
                            <DailyChart daily={stats.daily} window={usageWindow} metric={usageMetric} onMetric={setUsageMetric} />
```

Remove `barTransition` if `SplitBar`'s removal in Task 5 left it unused — check with `grep -n "barTransition" frontend/app/view/agents/usagesurface.tsx`.

- [ ] **Step 4: Add a unit test for the pure row mapping**

Create `frontend/app/view/agents/dailychart.test.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { toRows } from "./dailychart";
import type { DailyUsage } from "./usagestats";

const d: DailyUsage = {
    day: "2026-07-15",
    claudeTokens: 100,
    codexTokens: 40,
    claudeSpendUsd: 1.5,
    codexSpendUsd: 0.5,
};

describe("toRows", () => {
    it("selects the token metric and totals the two providers", () => {
        expect(toRows([d], "tokens")).toEqual([{ day: "07-15", claude: 100, codex: 40, total: 140 }]);
    });

    it("selects the spend metric", () => {
        expect(toRows([d], "spend")).toEqual([{ day: "07-15", claude: 1.5, codex: 0.5, total: 2 }]);
    });

    it("shortens the day key to MM-DD for the axis", () => {
        expect(toRows([d], "tokens")[0].day).toBe("07-15");
    });
});
```

- [ ] **Step 5: Run tests and typecheck**

Run:
```bash
npx vitest run frontend/app/view/agents/dailychart.test.ts
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit
npx vitest run
```
Expected: all PASS; tsc exit 0.

If `tsc` complains about `--font-mono` not existing, check the token name with `grep -n "font-mono" frontend/tailwindsetup.css` and use whatever the repo defines; if there is no such token, use `"var(--font-family-mono)"` or drop `fontFamily` and add `className="font-mono"` on the axis group instead.

- [ ] **Step 6: Checkpoint**

---

### Task 9: Brush for the All-time range

**Files:**
- Modify: `frontend/app/view/agents/dailychart.tsx`

**Interfaces:**
- Consumes: `DailyChart` from Task 8.
- Produces: no new exports. Internally adds a `[startIdx, endIdx]` range state; the main chart renders `rows.slice(startIdx, endIdx + 1)`.

The brush runs on a **linear scale over day index**, not the band scale — `@visx/brush` is unreliable over `scaleBand`, and index is what the slice needs anyway.

- [ ] **Step 1: Add the range state and slice the main chart**

At the top of `DailyChart`, after `rows` is computed:

```tsx
    const [range, setRange] = useState<[number, number] | null>(null);
    // All-time can span years; 7d never needs a brush. Reset the range when the window or the row
    // count changes so a stale slice can't outlive its data.
    const showBrush = win === "all" && rows.length > 14;
    useLayoutEffect(() => {
        setRange(null);
    }, [win, rows.length]);
    const [lo, hi] = range ?? [0, rows.length - 1];
    const view = showBrush ? rows.slice(lo, hi + 1) : rows;
```

Then replace every later use of `rows` **inside the plot** (the `x` domain, the `y` domain, `tickEvery`/`tickDays`, and the `rows.map` that draws columns) with `view`. Leave `rows.length === 0` as the empty check and leave the brush's own scale on `rows`.

- [ ] **Step 2: Make the header label state what is actually plotted**

Replace the label span:

```tsx
                <span className="font-mono text-[11px] text-muted">
                    {win === "7d"
                        ? "last 7 days"
                        : view.length === rows.length
                          ? "all time"
                          : `${view[0]?.day ?? ""} – ${view[view.length - 1]?.day ?? ""}`}
                </span>
```

This is what removes the old silent truncation: the label can no longer claim "last 30 days" while quietly hiding older data.

- [ ] **Step 3: Render the brush strip**

Add the import:

```tsx
import { Brush } from "@visx/brush";
```

and below the main `</svg>`, inside the same relative wrapper:

```tsx
                    {showBrush ? (
                        <svg width={width} height={BRUSH_H + 18} className="mt-1">
                            <g transform={`translate(${MARGIN.left},4)`}>
                                {rows.map((r, ri) => {
                                    const h = Math.round((r.total / Math.max(1, ...rows.map((q) => q.total))) * BRUSH_H);
                                    return (
                                        <rect
                                            key={r.day}
                                            x={(bx(ri) ?? 0) + 0.5}
                                            y={BRUSH_H - h}
                                            width={Math.max(1, bx.bandwidth() - 1)}
                                            height={h}
                                            fill="var(--color-edge-strong)"
                                        />
                                    );
                                })}
                                <Brush
                                    xScale={bxLinear}
                                    yScale={byLinear}
                                    width={Math.max(1, innerW)}
                                    height={BRUSH_H}
                                    handleSize={8}
                                    resizeTriggerAreas={["left", "right"]}
                                    brushDirection="horizontal"
                                    onChange={(domain) => {
                                        if (!domain) {
                                            setRange(null);
                                            return;
                                        }
                                        const a = Math.max(0, Math.round(domain.x0));
                                        const b = Math.min(rows.length - 1, Math.round(domain.x1));
                                        setRange(b > a ? [a, b] : null);
                                    }}
                                    onClick={() => setRange(null)}
                                    selectedBoxStyle={{
                                        fill: "var(--color-accent)",
                                        fillOpacity: 0.14,
                                        stroke: "var(--color-accent)",
                                        strokeWidth: 1,
                                    }}
                                />
                            </g>
                        </svg>
                    ) : null}
```

Add these next to the existing scales:

```tsx
    const BRUSH_H = 28;
    const bx = scaleBand<number>({ domain: rows.map((_, i) => i), range: [0, innerW], padding: 0.2 });
    const bxLinear = scaleLinear<number>({ domain: [0, Math.max(1, rows.length - 1)], range: [0, innerW] });
    const byLinear = scaleLinear<number>({ domain: [0, 1], range: [BRUSH_H, 0] });
```

Hoist `const BRUSH_H = 28;` to module scope beside `CHART_H` rather than declaring it in the body.

- [ ] **Step 4: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0. `@visx/brush`'s `onChange` domain type is `Bounds | null`; if tsc objects to `domain.x0`, import `type { Bounds } from "@visx/brush/lib/types"` and annotate the parameter.

- [ ] **Step 5: Full suite**

Run: `npx vitest run`
Expected: all PASS.

- [ ] **Step 6: Checkpoint**

Report whether the brush typechecked without the `Bounds` annotation.

---

### Task 10: By-model ordinal ramp with "Other" folding

**Files:**
- Modify: `frontend/app/view/agents/usagestats.ts` (add `foldModels`)
- Modify: `frontend/app/view/agents/usagestats.test.ts`
- Modify: `frontend/app/view/agents/usagesurface.tsx` (`MODEL_COLORS` :40-46, `ModelGroup` :389-426)

**Interfaces:**
- Produces: `foldModels(models: ModelUsage[], max: number): ModelUsage[]` in `usagestats.ts`, consumed by `ModelGroup`.

- [ ] **Step 1: Write the failing test**

Add to `frontend/app/view/agents/usagestats.test.ts`:

```ts
describe("foldModels", () => {
    const m = (model: string, tokens: number, pct: number): ModelUsage => ({ model, tokens, pct, spendUsd: 0 });

    it("passes through when at or under the cap", () => {
        const out = foldModels([m("a", 3, 60), m("b", 2, 40)], 4);
        expect(out.map((x) => x.model)).toEqual(["a", "b"]);
    });

    // The ordinal ramp has a fixed number of steps; a 5th hue is never generated.
    it("folds the tail into a single Other row", () => {
        const out = foldModels([m("a", 5, 50), m("b", 2, 20), m("c", 1, 10), m("d", 1, 10), m("e", 1, 10)], 4);
        expect(out.map((x) => x.model)).toEqual(["a", "b", "c", "Other"]);
        expect(out[3].tokens).toBe(2);
        expect(out[3].pct).toBe(20);
    });

    it("returns an empty list unchanged", () => {
        expect(foldModels([], 4)).toEqual([]);
    });
});
```

Add `foldModels` and `ModelUsage` to that file's existing import from `./usagestats`.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run frontend/app/view/agents/usagestats.test.ts`
Expected: FAIL — `foldModels` is not exported.

- [ ] **Step 3: Implement `foldModels`**

Append to `usagestats.ts`:

```ts
// Keep the top (max-1) models and sum the rest into one "Other" row. The by-model bars use a fixed
// ordinal ramp, so a 5th model must never mint a new hue — it folds.
export function foldModels(models: ModelUsage[], max: number): ModelUsage[] {
    if (models.length <= max) return models;
    const head = models.slice(0, max - 1);
    const tail = models.slice(max - 1);
    return [
        ...head,
        {
            model: "Other",
            tokens: tail.reduce((s, x) => s + x.tokens, 0),
            spendUsd: tail.reduce((s, x) => s + x.spendUsd, 0),
            pct: tail.reduce((s, x) => s + x.pct, 0),
        },
    ];
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run frontend/app/view/agents/usagestats.test.ts`
Expected: PASS.

- [ ] **Step 5: Switch `ModelGroup` to the ordinal ramp**

In `usagesurface.tsx`, replace `MODEL_COLORS` (:40-46) with:

```tsx
// Ranked magnitude within one provider is an ORDINAL job, not categorical: one hue, monotone
// lightness, indexed by rank. The previous 5-hue set was cycled with `i % len` AND keyed on rank, so
// one model overtaking another repainted both bars. An ordinal ramp is meant to follow rank, so that
// is now correct by construction.
const MODEL_SEQ = ["bg-chart-seq-1", "bg-chart-seq-2", "bg-chart-seq-3", "bg-chart-seq-4"];
const MAX_MODEL_ROWS = MODEL_SEQ.length;
```

In `ModelGroup`, fold first and drop the modulo, and replace the hand-rolled bar with `Meter`:

```tsx
            {foldModels(p.models, MAX_MODEL_ROWS).map((m, i) => (
                <div key={m.model} className="mb-[13px]">
                    <div className="mb-[6px] flex items-baseline justify-between">
                        <span className="font-mono text-[12px] text-secondary" title={m.model}>{prettyModel(m.model)}</span>
                        <span className="font-mono text-[11px] text-muted">
                            {fmt(m.tokens)} · <span className="font-semibold text-secondary">{pctStr(m.pct)}</span>
                        </span>
                    </div>
                    <Meter pct={m.pct} fill={MODEL_SEQ[i]} height={7} radius={4} track="bg-edge-strong" />
                </div>
            ))}
```

Add `foldModels` to the `./usagestats` import and `Meter` to the `@/app/element/meter` import. Remove the now-unused `useReducedMotion` from `ModelGroup` and the `motion` import if nothing else in the file uses them — check with `grep -n "motion\|useReducedMotion" frontend/app/view/agents/usagesurface.tsx`.

- [ ] **Step 6: Verify no orphans, run everything**

Run:
```bash
grep -rn "MODEL_COLORS\|barTransition\|DAILY_CHART_H" --include=*.tsx --include=*.ts frontend/
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit
npx vitest run
```
Expected: grep empty; tsc exit 0; vitest all PASS.

- [ ] **Step 7: Checkpoint**

---

### Task 11: Verify in the running app over CDP

**Files:**
- Modify: `scripts/cdp/scenarios.mjs`

**Interfaces:**
- Consumes: the finished Usage surface. `SURFACE_LABEL.usage` is already `"Usage"` (`scripts/cdp/attach.mjs:20`), so navigation works with no harness change.

- [ ] **Step 1: Start the dev app**

Run in a background shell: `tail -f /dev/null | task dev`

The `tail -f` prefix is required — a headless `task dev` dies on stdin EOF. Wait for the window, then confirm CDP is up:

```bash
curl -s http://127.0.0.1:9222/json/version | head -3
```
Expected: JSON with a `webSocketDebuggerUrl`. If this is empty, the dev app is not running or another session's edit crashed it — check the dev log for "going away" before retrying.

- [ ] **Step 2: Add the scenario**

In `scripts/cdp/scenarios.mjs`, add and register:

```js
// --- usage charts: the meter primitives + the visx DailyChart actually render -------------------
const usageCharts = {
    name: "usage-charts",
    surface: "usage",
    async arrange() {
        return {};
    },
    async assert(h) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });

        // the visx chart renders an <svg> with axis ticks and at least one bar rect
        const chart = await h.ev(`(() => {
            const svgs = [...document.querySelectorAll("svg")];
            const withTicks = svgs.filter((s) => s.querySelectorAll(".visx-axis-left .visx-axis-tick").length > 0);
            const s = withTicks[0];
            if (!s) return { found: false };
            return {
                found: true,
                leftTicks: s.querySelectorAll(".visx-axis-left .visx-axis-tick").length,
                bottomTicks: s.querySelectorAll(".visx-axis-bottom .visx-axis-tick").length,
                bars: s.querySelectorAll("rect[fill^='var(--color-chart-']").length,
            };
        })()`);
        rec(
            "1. DailyChart renders a visx svg with axes and bars",
            chart.found && chart.leftTicks >= 2 && chart.bars >= 1,
            JSON.stringify(chart)
        );

        // the chart palette resolved (tokens exist and are not empty strings)
        const palette = await h.ev(`(() => {
            const cs = getComputedStyle(document.documentElement);
            const names = ["--color-chart-1","--color-chart-4","--color-chart-claude","--color-chart-codex","--color-chart-seq-1"];
            return Object.fromEntries(names.map((n) => [n, cs.getPropertyValue(n).trim()]));
        })()`);
        rec(
            "2. chart tokens resolve",
            Object.values(palette).every((v) => /^#[0-9a-f]{6}$/i.test(v)),
            JSON.stringify(palette)
        );

        // ArcMeter sweep: --usage-arc is set per element, so several rings coexist
        const arcs = await h.ev(`(() => {
            const els = [...document.querySelectorAll("*")].filter((e) => e.style && e.style.getPropertyValue("--usage-arc"));
            return { count: els.length, values: els.slice(0, 6).map((e) => e.style.getPropertyValue("--usage-arc")) };
        })()`);
        rec("3. ArcMeter rings scope --usage-arc per element", arcs.count >= 1, JSON.stringify(arcs));

        // hovering a column opens the visx tooltip (replacing the old native title attribute)
        const tip = await h.ev(`(() => {
            const svg = [...document.querySelectorAll("svg")].find((s) => s.querySelector(".visx-axis-left"));
            const g = svg && svg.querySelector("g > g");
            if (!g) return { hovered: false };
            g.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
            return { hovered: true };
        })()`);
        await h.ev("new Promise((r) => setTimeout(r, 250))");
        const tipText = await h.ev(
            `(() => { const t = document.querySelector("[class*='visx-tooltip']"); return t ? t.textContent : ""; })()`
        );
        rec("4. hover opens a styled tooltip", tip.hovered && tipText.length > 0, JSON.stringify({ tipText }));

        // no native title tooltips left on the chart
        const titles = await h.ev(
            `document.querySelectorAll("svg [title], svg title").length`
        );
        rec("5. no native title tooltips on the chart", titles === 0, String(titles));

        return steps;
    },
    async teardown() {},
};
```

Register it in the module's exported scenario list next to the existing entries (match how `runsLifecycle` is exported).

- [ ] **Step 3: Run the scenario**

Run: `task verify:ui -- usage-charts`
Expected: a PASS table with all 5 steps green, a screenshot in `cdp-shots/`, exit 0.

If step 4 fails because `mouseenter` on a `<g>` does not reach React's synthetic handler, switch it to dispatching `pointerover`/`mouseover` with `bubbles: true` on a child `rect`, which React does delegate.

- [ ] **Step 4: Look at the screenshot**

Open `cdp-shots/index.html`. Confirm by eye, since the validator checks color and not layout:
- y-axis tick labels do not collide with the bars
- day labels along the bottom do not overlap each other
- the two stacked fills show a visible 2px gap
- the tooltip is inside the window, not clipped
- the All-time brush strip appears and the header label changes when a range is dragged
- nothing overflows the card horizontally

Report anything off rather than adjusting silently.

- [ ] **Step 5: Screenshot the app bar**

Run: `node scripts/cdp-shot.mjs cdp-shots/app-bar-donut.png`

Confirm the app-bar donut still reads correctly at 18px and that its ring is now the same track color as the Usage tab's.

- [ ] **Step 6: Stop the dev app**

Explicitly stop the background task — the `tail -f /dev/null` half does not exit on its own when `task dev` ends.

- [ ] **Step 7: Checkpoint**

Report the PASS table and what the screenshots showed.

---

### Task 12: Final verification and the single commit

**Files:** none new.

- [ ] **Step 1: Full verification, all three gates**

Run:
```bash
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit
npx vitest run
npx eslint frontend/app/element/meter.tsx frontend/app/element/metergeometry.ts frontend/app/view/agents/dailychart.tsx
```
Expected: tsc exit 0 with no output; vitest all PASS; eslint clean on the new files.

Report the actual output of each. Do not claim success for a command you did not run.

- [ ] **Step 2: Confirm the dead deps are gone and nothing regressed**

Run:
```bash
node -e "const p=require('./package.json');for(const d of ['recharts','@observablehq/plot','htl'])if(p.dependencies[d])throw new Error('still present: '+d);console.log('3 dead chart deps removed')"
grep -rn "CLASS_COLOR\|SplitBar\|StackedBar\|MODEL_COLORS\|dailyTruncated\|MAX_DAILY_DAYS\|DAILY_CHART_H\|barTransition" --include=*.ts --include=*.tsx frontend/
```
Expected: the node check prints its message; the grep is **empty**.

- [ ] **Step 3: Self-review the diff**

Run: `git diff` and `git status --short`

Check: no commented-out code, no debug statements, no stray console.log, no reformatted-but-unchanged lines from an accidental `prettier --write`. Confirm `frontend/app/view/agents/memgraph.tsx` and `frontend/app/view/jarvis/jarvisgraph.tsx` still show as modified by the *other* session and are **not** in anything you are about to stage.

- [ ] **Step 4: Ask for commit approval**

STOP. Report what changed and ask the user to approve the commit. Do not commit without explicit approval — this is a hard repo rule.

- [ ] **Step 5: Commit once approved**

Stage only the files this plan touched — never `git add -A`, because another session's edits are live in this tree:

```bash
git add package.json package-lock.json \
  frontend/tailwindsetup.css \
  frontend/app/element/meter.tsx frontend/app/element/metergeometry.ts frontend/app/element/metergeometry.test.ts \
  frontend/app/view/agents/chartpalette.test.ts \
  frontend/app/view/agents/dailychart.tsx frontend/app/view/agents/dailychart.test.ts \
  frontend/app/view/agents/usagestats.ts frontend/app/view/agents/usagestats.test.ts \
  frontend/app/view/agents/usagesurface.tsx frontend/app/view/agents/tokenusagesection.tsx \
  frontend/app/view/agents/agentdetailsrail.tsx frontend/app/view/agents/agentrow.tsx \
  frontend/app/view/agents/cockpitrail.tsx frontend/app/view/agents/runworkercard.tsx \
  frontend/app/view/agents/filessurface.tsx \
  frontend/app/cockpit/app-bar.tsx \
  scripts/cdp/scenarios.mjs \
  docs/superpowers/specs/2026-07-30-usage-charts-design.md \
  docs/superpowers/plans/2026-07-30-usage-charts.md
```

The spec and plan are staged **with** the feature, not as a separate docs-only commit.

```bash
git commit -m "feat(usage): one meter primitive, visx for the one real chart" \
  -m "The cockpit had one chart with an axis and nine percentage meters, so a chart library could only ever be half the answer. Meters become element/meter.tsx (Meter, StackedMeter, ArcMeter) over a pure geometry module; DailyChart moves to visx for scales, nice ticks, a real tooltip and a brush, with motion still the only animation system." \
  -m "Consolidating fixes drift rather than just line count: the app-bar donut had no --usage-arc so it never animated despite claiming to match the Usage tab, and SplitBar/StackedBar disagreed on track color and zero handling. The by-model bars keyed color on rank and cycled a 5-hue set with i % len, so one model overtaking another repainted both; they now use an ordinal ramp, which is meant to follow rank." \
  -m "Chart colors were measurably broken: --color-accent vs --color-accent-300 sat at deltaE 4.4, indistinguishable to full color vision, and status colors were doing double duty as series colors. The replacement palette is validated for CVD separation, lightness band and chroma floor, and is held by chartpalette.test.ts. Dropped recharts, @observablehq/plot and htl, all unused."
```

Do **not** add a Co-Authored-By trailer.

- [ ] **Step 6: Checkpoint**

Report the commit hash and confirm the other session's two files remain unstaged.

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| 3. Dependencies (3 out, 4 in, d3 dup check) | 1 |
| 4. Chart palette + exclusion from `buildThemeVars` | 2 |
| 4. `CLASS_COLOR` collapses into `usagestats.ts` | 5 |
| 5. `meter.tsx` three components + `@property` scoping note | 3, 4 |
| 5. Consolidating migration (drifted pairs) | 5 |
| 5. Mechanical migration (5 callsites) | 6 |
| 6. Scales, axes, marks, tooltip | 8 |
| 6. Brush + header label + `MAX_DAILY_DAYS` removal | 7, 9 |
| 6. 60s-refresh entrance gating | 8 (kept via existing `useDidBecomeTrue` in `usagesurface.tsx`) |
| 7. By-model ordinal ramp + "Other" | 10 |
| 8. Testing (usagestats, palette guard, no jsdom, CDP, tsc, prettier) | 2, 3, 7, 8, 10, 11, 12 |

**Corrections made against the spec while planning:**
- `filessurface.tsx` is a two-segment stacked bar, so it takes `StackedMeter`, not `Meter`. The spec listed it under the mechanical `Meter` group.
- Meter fills are Tailwind utility classes rather than inline color values, because Tailwind 4 generates `bg-*` from every `@theme --color-*` token and four of the five mechanical callsites already pass classes (`GAUGE_FILL`, `PLAN_BAR`, `bg-success`). `ArcMeter` stays on `var()` because `conic-gradient` needs a value.
- `cacheRead` cannot stay grey. A categorical palette requires C ≥ 0.10, so it takes the darkest validated slot (`bg-chart-4`) — called out in Task 5's comment since it is a visible design change.
- Per-task commits from the skill template are replaced by per-task Checkpoints plus one approval-gated commit in Task 12, per this repo's git rule.

**Type consistency:** `MeterSeg`/`MeterSlice`/`meterSegments`/`meterPct` are defined in Task 3 and used with the same names and shapes in Tasks 4, 5, 6, 10. `CLASS_FILL` is defined in Task 5 and consumed in Task 5 only. `foldModels`/`ModelUsage` defined Task 10, used Task 10. `toRows`/`DailyChart` defined Task 8, extended Task 9. `fmt`/`usd`/`Segmented` are exported in Task 8 Step 1 before Task 8 Step 2 imports them.

**Known softness, flagged rather than hidden:** Tasks 8 and 9 are the only steps whose code I could not execute while planning — the visx axis class names used by the Task 11 assertions (`.visx-axis-left`, `.visx-axis-tick`) and the `Bounds` typing of `Brush.onChange` are from the library's documented API, not verified against this tree. Both steps carry an explicit fallback for that reason.
