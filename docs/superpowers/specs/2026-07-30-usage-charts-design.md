# Usage charts — one meter primitive, visx for the one real chart

**Date:** 2026-07-30 · **Surface:** Usage tab (+ app bar, 5 meter callsites) · **Scope:** 3 deps out, 4 in, one new element module, one chart rewrite

## 1. Why

The ask was "can we use a proper chart library with animation?" Four things were named as lacking:
primitive interaction, cheap-feeling animation, a Daily chart that cannot hold 30+ days, and the
maintenance cost of hand-rolling.

Taking an inventory first changed the shape of the answer. The cockpit has **one chart and nine
percentage meters**:

| What | Where | Kind |
|---|---|---|
| `DailyChart` | `usagesurface.tsx:290` | **chart** — stacked columns, day axis, needs scales |
| `SplitBar` | `usagesurface.tsx:215` | 100% stacked meter |
| `StackedBar` | `tokenusagesection.tsx:43` | 100% stacked meter — duplicate of `SplitBar` |
| `ModelGroup` bars | `usagesurface.tsx:408` | ranked magnitude meter |
| `MiniDonut` | `usagesurface.tsx:125` | arc meter |
| app-bar donut | `app-bar.tsx:42` | arc meter — duplicate of `MiniDonut` |
| context bar | `agentdetailsrail.tsx:151` | progress meter |
| + 4 more | `agentrow.tsx:103`, `cockpitrail.tsx:52`, `filessurface.tsx:435-436`, `runworkercard.tsx:135` | progress meters |

No chart library dedupes the nine — they have no axes and no scales, they are one number as a width.
So a single library cannot be the whole answer, and "make it standard" resolves into two standards.

Three findings that set the constraints:

1. **`recharts@^2.15.4` and `@observablehq/plot@^0.6.17` are already declared and completely unused**
   (zero imports; recharts arrived upstream in `6e2ff6c5` as a donut POC). `htl` is dead too. So the
   question was never "can we add a chart library" — it is "which one, and delete the dead ones."
2. **Themes are runtime `--color-*` writes onto `document.documentElement`** (`themes.ts:6`) across 6
   switchable presets. SVG/DOM charts take `fill="var(--color-chart-1)"` and re-theme for free; canvas
   charts need `getComputedStyle` resolution plus a re-init per preset switch. This eliminates ECharts,
   Chart.js and uPlot on architecture, not taste.
3. **The animation complaint is not a library problem.** What exists is `motion` `scaleY` with a
   `ri * 0.025` stagger, GPU-composited, on token-sourced duration/ease, respecting `useReducedMotion`
   (`usagesurface.tsx:354-360`). Recharts' `react-smooth` re-runs from zero on data change, which the
   60s silent refresh (`usagesurface.tsx:478`) would trigger every minute — a regression. "Cheap" here
   means no hover feedback, no crosshair, no re-ticking axis. Those are authored, and `motion` is
   better at them than any built-in.

### Two duplicate pairs that have drifted

Consolidation fixes real bugs, not just line count:

- `SplitBar` vs `StackedBar` differ in height (30 vs 11), radius (7 vs 5), track (`bg-background` vs
  `bg-surface-hover`), zero-segment handling (renders all vs filters), and **only `SplitBar` animates**.
- `app-bar.tsx:16-17` states the donut uses "the SAME rings the Usage tab uses" — but its track is
  `--color-edge-mid` against `MiniDonut`'s `--color-edge-strong`, and it has no `--usage-arc`, so
  **it does not animate at all**.
- `CLASS_COLOR` is duplicated verbatim (`usagesurface.tsx:34`, `tokenusagesection.tsx:14`).

## 2. Decision

Two standards, because the inventory has two shapes of work:

- **Meters** → one in-repo primitive module, zero new dependencies. This is where the maintenance win is.
- **Charts** → **visx 4.0.0**, adopted by `DailyChart`, so the one real chart gets library scales, ticks,
  tooltip and brush, and the next real chart has an established home.

visx over the alternatives because it is the only option that leaves **rendering** (so CSS-var theming
works) and **animation** (so `motion` stays the single system) under our control:

| Library | Render | Why not |
|---|---|---|
| Recharts 3.10 | SVG | `@reduxjs/toolkit` + `react-redux` in a jotai app; `immer@^11` against our `immer@^10.1.1` |
| Recharts 2.15 | SVG | full lodash; re-grows from zero on data change, which our 60s refresh triggers |
| Nivo | SVG | strongest batteries-included option, but adds react-spring as a *second* animation system |
| Victory | SVG | maintenance slowed; `victory-vendor` |
| ApexCharts | SVG | own theming layer that fights `--color-*` |
| Tremor / shadcn charts | SVG | recharts underneath; and shadcn is not installed here — `frontend/app/shadcn/` holds only `lib/utils.ts` |
| ECharts, Chart.js, uPlot | **canvas** | cannot inherit runtime `--color-*` (finding 2) |
| Observable Plot | DOM, imperative | already a dead dep; returns a node, re-renders wholesale |

Bundle size is explicitly **not** a criterion — this is a Tauri desktop app with local assets and no
per-visit download. The objections above are architectural.

## 3. Dependencies

**Remove:** `recharts`, `@observablehq/plot`, `htl` — zero imports each, verified.

**Add:** `@visx/scale`, `@visx/axis`, `@visx/tooltip`, `@visx/brush` at 4.0.0 (React 19 peers declared).
Transitive: `@visx/group`, `@visx/shape`, `@visx/drag`, `@visx/event`, `classnames`. No redux, no immer.

**Keep untouched:** `react-force-graph-2d`, `d3-force-3d`, `mermaid` — used, and network-graph/diagram
viz is a different category from charts. `memgraph.tsx` and `jarvisgraph.tsx` are modified in the working
tree; this work touches neither file.

Verify `@visx/scale`'s d3-scale does not duplicate d3 modules already pulled by `d3-force-3d`.

## 4. Chart palette

> **Superseded during implementation (2026-07-30).** A new validated `--color-chart-*` palette was
> built and then **reverted at the user's direction**: charts must use the existing design-system
> tokens, not invented ones. Shipped instead:
>
> - Token classes keep their original tokens — `--color-cacheread`, `--color-accent`,
>   `--color-warning`, `--color-success` — now named once as `CLASS_FILL` in `usagestats.ts`
>   instead of being duplicated inline in two files.
> - Daily series keep `--color-accent` (claude) / `--color-success` (codex).
> - By-model uses four stops off the **existing** accent scale (`accent-200/400/600/800`). This is the
>   one substantive change kept, because the old set put `--color-accent` beside `--color-accent-300`
>   — adjacent stops on one ramp, indistinguishable — so ranks 1 and 4 read as the same color.
> - No `--color-chart-*` tokens exist, and there is no palette regression test.
>
> The analysis below is retained as the record of why the old colors were questioned, but its
> conclusions were **not** adopted.

Every current chart color fails the dark-mode band (`L 0.48–0.67`, `C ≥ 0.10`). Measured with
`validate_palette.js`, dark, surface `#13171d`, `--pairs all`:

- `CLASS_COLOR` — FAIL lightness band (all four at L 0.698–0.797), FAIL chroma floor
  (`--color-cacheread` `#5b6675` at C 0.027 reads gray).
- `MODEL_COLORS` — same two failures, plus **FAIL normal-vision floor: `--color-accent` `#7c95ff` vs
  `--color-accent-300` `#8da3ff` at ΔE 4.4**. Under 15 is a hard fail — models #1 and #4 in the by-model
  breakdown are indistinguishable even with full color vision.
- `CLASS_COLOR` also borrows `--color-warning` and `--color-success` as *series* colors. Status colors
  are reserved; they stay for the ok/warn/hot quota rings only, which is correct status usage.

Three replacement palettes, each validated to a clean pass:

| Job | Token | Values | Result |
|---|---|---|---|
| Categorical ×4 (token classes) | `--color-chart-1..4` | `#5176cd #48a260 #a6560a #974391` | 5/5 PASS, worst CVD ΔE 9.5 |
| Provider series (claude/codex) | `--color-chart-claude`, `--color-chart-codex` | `#d17050 #3786c3` | 5/5 PASS, ΔE 25.0 normal / 17.2 protan |
| Ordinal ×4 (by-model rank) | `--color-chart-seq-1..4` | `#7ca7ff #658be4 #5171bb #3f5893` | 4/4 ordinal PASS |

### Why the provider series gets its own tokens

The Daily chart's two series are **providers**, which the app already has an identity vocabulary for —
`--color-rt-claude` / `--color-rt-codex`, used on roster, header and details badges (`runtimemeta.ts`).
Reusing `--color-chart-1..2` there would make blue mean "cache read" in one card and "claude" in the card
beside it, and would throw away brand recognition the rest of the cockpit already establishes.

The raw brand colors cannot be used as fills, though: `--color-rt-claude` `#d97757` is L 0.672 (0.002 over
the band) and `--color-rt-codex` `#ececec` is achromatic (C 0), which fails the chroma floor outright.
They are text/glyph tints, and that remains their job. So the chart fills are *derived*: claude keeps its
brand hue (38.8) at L 0.65, and codex — whose brand is deliberately achromatic — takes a cool slate at
hue 245, preserving its muted character while clearing the C ≥ 0.10 floor.

Accepted trade-off: hues recur across figures (claude's warm orange near `--color-chart-3`'s amber, codex's
slate near `--color-chart-1`'s blue). Each figure is a separate card carrying its own legend, so identity
resolves within the figure; this is deliberate, not an oversight.

These land in `tailwindsetup.css` `@theme` and are **deliberately excluded from the `themes.ts` preset
override map** (which covers only chrome tokens, `themes.ts:167`). Series identity must not shift when
chrome theme changes, and exclusion keeps one validated palette valid across all 6 presets instead of
requiring 6 revalidations.

`CLASS_COLOR` collapses to a single export in `usagestats.ts` beside `CLASS_ORDER`/`CLASS_LABEL`. Colors
are plain strings, so that module's no-React purity holds.

## 5. `frontend/app/element/meter.tsx`

Three components, zero new deps, all animating on the existing `MOTION` tokens and all honoring
`useReducedMotion`:

- **`Meter`** — single progress bar. `pct`, `tone?`, `height?`, `radius?`, `track?`
- **`StackedMeter`** — n segments; 2px surface gap between fills per the mark spec. `segs[{key,value,color}]`,
  `height`, `radius`, `track`. Zero-value segments are omitted entirely and contribute no gap — this
  settles the drift between `SplitBar` (renders all) and `StackedBar` (filters), in the filtering
  direction, since a 2px gap around a 0%-wide fill would otherwise read as a visible seam
- **`ArcMeter`** — conic-gradient ring on the registered `@property --usage-arc`, with a center-label slot.
  `pct`, `size`, `thickness`, `color`, `track`, `children`

`@property` registration is global but custom-property *values* inherit per element, so the inline
`--usage-arc` on each instance scopes correctly. Multiple simultaneous `ArcMeter`s (4 on the Usage tab,
1–2 in the app bar) need no extra work.

Migration, in two tiers:

- **Consolidating (fixes drift):** `SplitBar` + `StackedBar` → `StackedMeter` on one contract;
  `MiniDonut` + `app-bar.tsx:42` → `ArcMeter`, which gives the app-bar donut the animated sweep it
  currently lacks and the same track as the Usage tab.
- **Mechanical:** `agentdetailsrail.tsx:151`, `agentrow.tsx:103`, `cockpitrail.tsx:52`,
  `filessurface.tsx:435-436`, `runworkercard.tsx:135` → `Meter`.

## 6. `DailyChart` on visx

- **Scales:** `scaleBand` for days, `scaleLinear().nice()` for value — replaces the three hardcoded
  `dmax` / `dmax/2` / `0` labels with real ticks.
- **Axes:** `AxisLeft` recessive, reusing the existing `fmt`/`usd` as `tickFormat`; `AxisBottom` thinning
  day labels when dense.
- **Bars:** `motion.rect`, keeping the `scaleY` + `ri * 0.025` stagger. SVG needs
  `transformBox: "fill-box"` for `transformOrigin: "bottom"` to behave as it does on a DOM element.
- **Marks:** 2px gap between stacked segments (preserved via rect math), 4px rounded top on the top
  segment only, anchored to the baseline.
- **Tooltip:** `@visx/tooltip` replaces the native `title` attribute (`usagesurface.tsx:362`) — per-day
  claude + codex + total, values in text tokens with a color swatch carrying identity, hit target
  spanning the full column.
- **Brush:** `@visx/brush` range selector under the All-time chart. This removes the silent truncation:
  `MAX_DAILY_DAYS = 30` and the `dailyTruncated` flag come out of `usagestats.ts`. The day range stays
  bounded by `enumerateDays`' existing 3650 guard. The header label follows: the current three-way
  `"last 7 days" / "last 30 days" / "all time"` (`usagesurface.tsx:311`, where the middle case *was* the
  truncation showing through) becomes `"last 7 days"` or the brushed range's own start–end dates, so the
  label always states what is actually plotted.
- **The 60s refresh:** the entrance grow stays gated behind the existing `useDidBecomeTrue` pattern, so a
  silent refresh tweens values in place rather than re-growing from the baseline.
- **Reduced motion:** no stagger, no grow, values snap; brush stays functional.

## 7. By-model breakdown

Switches from 5 cycled categorical hues to the validated 4-step ordinal ramp. This fixes both the
`MODEL_COLORS[i % MODEL_COLORS.length]` cycling (`usagesurface.tsx:414`) and the fact that color followed
**rank** — models sort desc by tokens, so one overtaking another repainted both bars. An ordinal ramp
indexed by rank is *intended* to follow rank, so the behavior becomes correct by construction. A 5th+
model folds into "Other" rather than wrapping to slot 1.

Bar length already encodes magnitude and each row is direct-labeled with model name and percentage, so
identity is never carried by color alone.

## 8. Testing

- `usagestats.test.ts` extended for the un-capped all-time series (the `MAX_DAILY_DAYS` removal).
- Any non-trivial tick/domain math extracted as a pure helper with its own unit tests.
- A palette regression test asserting the chart tokens equal the validated hex set, so a later edit
  cannot silently break CVD compliance.
- No jsdom render tests, per the standing 2026-07-21 decision. Render verification is a `task verify:ui`
  scenario in `scripts/cdp/scenarios.mjs`.
- Typecheck with `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (bare `npx tsc`
  stack-overflows on this repo).
- Hand-format touched lines; do not run `prettier --write` across these files, which reorders imports and
  turns a small edit into a several-hundred-line diff.

## 9. Out of scope

- The Jarvis/memory force graphs (`memgraph.tsx`, `jarvisgraph.tsx`) — different viz category, and both
  are modified in the working tree.
- Light mode. Permanently off the table; the palette is validated against the dark surface only.
- Codex quota in the live donuts — still not wired through the live roster, unchanged here.
