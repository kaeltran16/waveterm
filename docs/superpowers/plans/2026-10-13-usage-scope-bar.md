# Usage Scope Bar Implementation Plan

**Verify:** `node scripts/verify.mjs ./pkg/wconfig`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
**Final:** `node scripts/cdp/final-verify.mjs usage-charts usage-work usage-states`
**Prototype:** C:\Users\kael02\IdeaProjects\waveterm\.superpowers\design\usage-redesign\project\Main.dc.html

**Goal:** Redesign the Usage surface as drawn in the prototype canvas. `Main.dc.html` is the spec. `Provider`, `Work`, `WorkItem` and `States` are the other states the built page must reach. `Page`, `AppBar` and `NavRail` are parts, and Page's `view` prop selects each state. The canvas numbers are sample data from the live app, not targets.

**Architecture:** The 392px rail becomes a horizontal scope bar under the header. The detail spans the full width, laid out top to bottom:

- a one-line scope header;
- Live limits and the four Historical stat cards in one 2:4 row;
- the By work ranked list;
- a full-width Daily chart stacked by model, with a side legend grouped by harness;
- a full-width "Where it goes" table.

Per-model daily data is folded in `aggregateBuckets` (`usagestats.ts`). The legend grouping, model shades and chart rows live in a new pure module, `usagedaily.ts`. The split table's rows come from a pure `splitTable` in `usageattribution.ts`. Components stay thin.

**Tech Stack:** React 19, Tailwind 4 `@theme` tokens, jotai, visx (Daily chart), vitest, CDP scenario harness (`scripts/cdp/`).

## Global Constraints

- Colors come only from existing `@theme` tokens in `frontend/tailwindsetup.css`. No raw hex or rgba, and no new tokens. Opacity variants of an existing token (`color-mix(in srgb, var(--color-x) N%, transparent)` or Tailwind `/N`) are allowed.
- Every number the page shows today stays visible somewhere on the page.
- **Header (concurrent run 1409ee43):** that run replaces `SurfaceHeader` with a shared `SurfaceToolbar` and `ToolbarFact` in `surfacescaffold.tsx`. It has not landed on this run's base. Until it lands, Usage keeps today's `SurfaceHeader` call: the subtitle is dropped, the badge is still "N reporting", and the actions are the lens `Segmented` (By provider | By work) followed by the range `Segmented` (7 days | All time).
  - When the land conflicts with 1409ee43, resolve in favour of its component: `<SurfaceToolbar title="Usage" actions={<>lens, range</>}>` with "N reporting" as a `<ToolbarFact>` child.
  - Do not keep a second toolbar component, or `SurfaceHeader`, for Usage.
  - Do not touch `surfacescaffold.tsx`. The header's height and title size are not judged in this run.
- Both switches use the existing `Segmented` (`frontend/app/element/segmented.tsx`) with `role="group"`. The lens has `ariaLabel="Lens"` and the range has `ariaLabel="Range"`. `data-usage-lens` is removed.
- Out of scope: the By work summary reads "… 400 sessions no run started". That is a separately tracked run-linking bug; do not change it.
- **DOM contract.** Tasks 3 and 4 render these attributes and Task 5's scenarios read them. Keep the names exactly:
  - scope bar `[data-usage-scopes]`, which is also `role="group" aria-label="Scope"` as in the canvas
    - cards `button[data-usage-harness="all"|<harness>]` (By provider; the All usage card carries `data-usage-harness="all"` in both lenses)
    - `button[data-usage-project=<key>]` (By work), each card with `aria-pressed`
    - `[data-usage-other]` for the other-folders text
  - `[data-usage-detail=<scope id>]` on the scrolling detail
  - one-line header `[data-usage-head]`, with the scope name in its `h2`
    - `[data-usage-back]` and `[data-usage-open-run]` (unchanged)
  - limits
    - `[data-usage-limit="fivehour"|"week"]` (unchanged)
    - `[data-usage-noquota]` on the no-quota paragraph
  - stats
    - `[data-usage-stats]` on the four-card grid
    - `[data-usage-skeleton]` on every loading skeleton block
    - `[data-usage-empty]` on the empty-window message
  - list: `[data-usage-list]`, `[data-usage-item]`, `[data-usage-more]`, `[data-usage-reported]` (unchanged)
  - Daily
    - `[data-usage-daily]` on the card
    - `[data-usage-legend]` on the side legend
    - `[data-usage-legend-group=<harness>]` on a group heading
    - `[data-usage-model=<model key>]` on a legend row
    - `[data-usage-daily-only]` on the one-model header readout
  - Where it goes
    - `[data-usage-split]` on the card
    - `[data-usage-split-part=<part key>]` on a row
    - `[data-usage-split-total]` on the Total row
- Decided, do not reopen:
  - **Model colors:** a model's color is its harness's Daily chart color. Claude is `var(--color-accent)`, Codex `var(--color-success)`, OpenCode `var(--color-rt-opencode)`, Pi `var(--color-rt-pi)`, and any other harness `var(--color-muted)`.
    - Within a harness, models are ranked by window tokens and stepped by opacity, evenly from 100% (rank 0, the bare color) down to 25% (the last rank).
    - A harness with one model uses the bare color.
    - One ramp applies to every harness; the canvas's accent-scale steps for Claude are not copied.
  - **Model identity** is harness + provider + model. A legend row shows the model id, with `provider/model` as its `title`.
    - Groups follow the scope bar's harness order (harnesses it does not list go after, alphabetically).
    - Models within a group go by window tokens descending, so the Tokens/Spend toggle never reorders rows.
    - Bars stack bottom-up in legend order.
    - Legend rows are not clickable.
  - **Chart height:** the plot is at least 240px tall and grows to match the side legend's height.
  - **Where it goes:**
    - `WorkSplit.note` is replaced by `WorkSplit.head`, the label-column heading ("class", "project", "kind", "role").
    - Rows are sorted by spend, descending.
    - A bar's width is its share of the total. A non-zero share never draws narrower than 0.3%.
  - **Scope bar:**
    - Cards are 220px to 340px wide (`flex-1 min-w-[220px] max-w-[340px]`). The bar stays pinned under the header and scrolls sideways (`overflow-x-auto`) when the cards do not fit; it never squashes them.
    - The Reporting / No reading group headings go. The reporting-first order from `railRows(buildUsageRail(...))` stays.
  - The detail line drops the old glyph and pill (Aggregate, Project, Session, Run, state), as the canvas does. The state pill lives on the scope card.
  - Below the `xl` breakpoint, the 2:4 limits/stats row stacks: limits on top, then the stats at 2 columns.

## Review Focus

1. **The same model id under two harnesses** (Pi's `openai-codex/gpt-5.5` and Codex's `openai/gpt-5.5`): two legend rows under two group headings and two stack segments, never one merged row. Pinned in Task 1.
2. **Spend metric when nothing is priced** (only an unpriced model in scope): legend and table percentages read 0, never NaN, and bars draw nothing. Pinned in Tasks 1 and 2.
3. **More models than the eye separates** (six models in one harness): the shades stay strictly decreasing and none drops below 25%. Pinned in Task 1.
4. **A failed request's zero-token bucket**: it never yields a legend row (the rule `providers` had). Pinned in Task 1.
5. **A scope that leaves the window** (the window switches while a project or a drilled session is open): the page falls back to All usage, or to the item's scope, without pointing at a missing card. The existing fallback effects stay. Pinned by usage-work step 8 in Task 5.

---

### Task 1: Per-model daily fold and the legend model

**Depends on:** none
**Model:** claude-sonnet-5-5
**Files:** `frontend/app/view/agents/usagestats.ts`, `frontend/app/view/agents/usagestats.test.ts`, `frontend/app/view/agents/usagedaily.ts`, `frontend/app/view/agents/usagedaily.test.ts`, `frontend/app/view/agents/usagerail.test.ts`, `frontend/app/view/agents/dailychart.test.ts`

The data the by-model Daily chart and its legend need, as pure functions.

**Change `usagestats.ts`:**

1. `DailyUsage` gains `byModel: Record<string, DailyHarnessUsage>`, keyed by `modelKey(...)`. It is `{}` on a zero-filled idle day.
2. `UsageStats` gains `models: ModelSeries[]`. It is window-scoped, ordered by tokens descending then key ascending, and excludes a model whose window tokens are 0 (the same rule `providers` applies to failed requests).
3. Both are folded in the existing single pass of `aggregateBuckets`, under the same harness filter.
4. Leave `providers`, `ProviderUsage`, `ModelUsage`, `foldModels` and `modelGridClass` in place. Task 4 deletes them once the surface stops reading them.

**Add `byModel: {}` to existing literals:** every `DailyUsage` literal in `usagerail.test.ts` and `dailychart.test.ts` gets `byModel: {}`, so the typecheck stays clean. Change nothing else in those files.

**Interfaces (other tasks rely on these exact names):**

```ts
// usagestats.ts
export interface ModelSeries { key: string; harness: string; provider: string; model: string; tokens: number; spendUsd: number }
export function modelKey(harness: string, provider: string, model: string): string; // opaque, unique per triple, stable

// usagedaily.ts (new, pure: no React or Wave runtime imports)
export type UsageMetric = "tokens" | "spend";
export function harnessChartColor(harness: string): string; // the var(--color-…) strings in Global Constraints
export function harnessChartLabel(harness: string): string; // Claude, Codex, OpenCode, Pi; else the raw id
export function modelShade(color: string, rank: number, count: number): string; // rank 0 → color; else color-mix(in srgb, <color> <pct>%, transparent)
export interface LegendModel { key: string; harness: string; model: string; title: string; fill: string; tokens: number; spendUsd: number; value: number; pct: number }
export interface LegendGroup { harness: string; label: string; value: number; pct: number; showHead: boolean; models: LegendModel[] }
export function modelLegend(models: ModelSeries[], harnessOrder: string[], metric: UsageMetric): LegendGroup[];
export function legendSeries(groups: LegendGroup[]): LegendModel[]; // flat, legend order = bottom-up stack order
export interface ModelRow { day: string; values: Record<string, number>; total: number } // day is "MM-DD"
export function modelRows(daily: DailyUsage[], keys: string[], metric: UsageMetric): ModelRow[];
```

**Semantics:**

- `value` is the metric's amount (tokens, or spendUsd).
- `pct` is that value's share of the sum over every model in the legend, in 0–100. When the sum is 0, `pct` is 0.
- A group's `value` and `pct` are its models' sums.
- `showHead` is `groups.length > 1`.
- `title` is `${provider}/${model}`.
- `modelRows` defaults an absent key to 0, and its `total` sums the given keys only.

**Acceptance (vitest, `npx vitest run frontend/app/view/agents/usagestats.test.ts frontend/app/view/agents/usagedaily.test.ts`):**

- `aggregateBuckets` folds `byModel` per day per model. Two buckets of one model on one day sum, idle days have `{}`, and a harness filter narrows both `byModel` and `models`.
- `models` excludes a model whose only bucket has zero tokens.
- Pi `openai-codex/gpt-5.5` and Codex `openai/gpt-5.5` give two distinct keys. `modelLegend` puts them under two groups, both with model label `gpt-5.5`.
- Group order follows `harnessOrder`, and an unlisted harness goes last. Model order inside a group is by tokens and is identical for `"tokens"` and `"spend"`.
- With the spend metric over unpriced models only, every `value` and `pct` is 0 (not NaN).
- `modelShade`:
  - one model → the bare color;
  - six models → strictly decreasing opacities from 100% to 25%, all at least 25%;
  - the result for rank > 0 contains the harness's `var(--color-…)`.
- `showHead` is false with one group and true with two.
- `modelRows` returns `MM-DD` days, selects the metric, zero-fills absent keys and totals the given keys.

### Task 2: Where it goes as a sorted table

**Depends on:** none
**Model:** claude-sonnet-5-5
**Files:** `frontend/app/view/agents/usageattribution.ts`, `frontend/app/view/agents/usageattribution.test.ts`, `frontend/app/view/agents/usagesplittable.tsx`

**Change `usageattribution.ts`:**

1. `WorkSplit` gains `head: string`: `"class"` from `classSplit`, `"role"` from the run's role split, `"kind"` for a project, `"project"` for All usage.
2. Keep `note` for now; Task 4 deletes it with its last reader.
3. Add the pure `splitTable` below. It sorts rows by `spendUsd` descending, then `tokens` descending, then `key`. A pct is the row's share of the column total (0 when that total is 0). A bar pct is `Math.max(pct, 0.3)` when the value is non-zero, else 0.

```ts
export interface SplitRow { key: string; label: string; fill: string; tokens: number; spendUsd: number; tokenPct: number; spendPct: number; tokenBarPct: number; spendBarPct: number }
export interface SplitTableData { head: string; rows: SplitRow[]; tokens: number; spendUsd: number }
export function splitTable(split: WorkSplit): SplitTableData;
```

**Create `usagesplittable.tsx`:** it exports `SplitTable({ table }: { table: SplitTableData })` and renders only the grid; the card around it and its "Where it goes" heading are Task 4's. Lay it out as in `Page.dc.html` lines 172-186:

- Columns: `200px minmax(0,1fr) 130px minmax(0,1fr) 120px`, gap 16px.
- A header row: `{head}`, `tokens`, blank, `spend ≈ API-equiv`, blank.
- Per row:
  - a 9px swatch in the part's `fill` class, then the label;
  - a 7px tokens bar on a `bg-background` track;
  - `{fmt(tokens)} · {pctStr(tokenPct)}`;
  - a spend bar;
  - `{usd(spendUsd)} · {pctStr(spendPct)}`.
- A bold Total row: `fmt(tokens)` and `≈ usd(spendUsd)`.
- Rows carry `data-usage-split-part={key}` and the Total row carries `data-usage-split-total`.
- Use the existing `fmt`, `usd`, `pctStr` and `Meter` (`@/app/element/meter`) if it takes a pct and fill class; otherwise use a plain div bar.

**Acceptance (vitest, `npx vitest run frontend/app/view/agents/usageattribution.test.ts`):**

- Each split producer sets the right `head`.
- `splitTable` orders rows by spend, even where the token order differs (cache read has the most tokens but sorts below cache write when cache write costs more).
- Totals equal the column sums.
- A zero spend total gives 0 pcts and 0 bar widths, with no NaN.
- A tiny non-zero share gets a 0.3 bar.
- Check passes.
- The rendered table is shown by Task 5's scenario steps:
  - the usage-charts split-order step;
  - usage-work step 1b;
  - the split shots `usage-main-split`, `usage-work-split` and `usage-work-project-session-split`.
- This task's markup carries `data-usage-split-part` and `data-usage-split-total` for those steps.

### Task 3: Daily chart stacked by model

**Depends on:** Task 1
**Model:** claude-opus-5-5
**Files:** `frontend/app/view/agents/dailychart.tsx`, `frontend/app/view/agents/dailychart.test.ts`, `frontend/app/view/agents/usagesurface.tsx`

**Rewrite `DailyChart`** to stack each day by model. The new props:

```ts
DailyChart({ daily, window, metric, onMetric, legend }: { daily: DailyUsage[]; window: "7d" | "all"; metric: UsageMetric; onMetric: (m: UsageMetric) => void; legend: LegendGroup[] })
```

- Series come from `legendSeries(legend)`, rows from `modelRows(daily, keys, metric)` and fills from each `LegendModel.fill`.
- Delete `HARNESS_META`, `harnessMeta` and `toRows`; they now live in `usagedaily.ts`. Delete `dailychart.test.ts` once its `toRows` tests have no subject: `modelRows` is tested in Task 1. Before deleting, grep for `toRows` and `dailychart.test`.

**Layout, per `Page.dc.html` lines 129-168:**

- **The card is full width.** Its header is "Daily" at 14px semibold, then the range text: "last 7 days · by model", "all time · by model", or the brushed `MM-DD – MM-DD`. Then a spacer, then the Tokens | Spend `Segmented`.
- **The side legend** (`data-usage-legend`) is a 330px column to the right of the chart.
  - Each group gets a heading row (`data-usage-legend-group={harness}`) with the uppercase label, then its value and pct, shown only when `showHead`.
  - Each model row (`data-usage-model={key}`) has an 8px swatch, the model id with `title`, and the value and pct.
  - Values follow the metric: `fmt` for tokens, `usd` for spend.
- **One harness:** no group heading.
- **One model:** no side legend. The card header shows the swatch, the model id, and its value and pct (`data-usage-daily-only`) before the switch.
- **No models:** keep today's "No activity in range."
- **The plot** is at least 240px tall and grows to the legend's height. Measure the chart host's height the way it already measures width (`useResizeObserver`).
- **Kept from today:** top-only rounded caps on the top non-zero segment, the motion cascade cap, the zero-day stub, the all-time brush (over more than 14 days) and the visx axes.
- **The hover tooltip** lists that day's non-zero models in stack order (swatch, model id, value), then the total.

**Call site:** in `usagesurface.tsx`, change only the `DailyChart` call. Pass `legend={modelLegend(stats.models, rows.map((r) => r.harness), usageMetric)}`, memoized, and delete `chartHarnesses`. Everything else in that file is Task 4's.

**Acceptance:**

- `npx vitest run frontend/app/view/agents/usagedaily.test.ts` passes, and Check passes.
- The scenario steps that show this card are Task 5's:
  - usage-charts steps 1, 6, 15 and 16;
  - step 4, which asserts the tooltip lists model ids and a total;
  - the shots `usage-main-daily`, `usage-provider-claude-daily` and `usage-noquota`.
- This task leaves the chart's existing visx class names and the brush in place, so those steps can find them.
- The tooltip markup lets step 4 read each listed model id and the total line. Give the tooltip's model rows `data-usage-tip-model={key}` and the total row `data-usage-tip-total`.

### Task 4: Scope bar and full-width detail

**Depends on:** Task 2, Task 3
**Model:** claude-opus-5-5
**Files:** `frontend/app/view/agents/usagesurface.tsx`, `frontend/app/view/agents/usagestats.ts`, `frontend/app/view/agents/usagestats.test.ts`, `frontend/app/view/agents/usageattribution.ts`, `frontend/app/view/agents/usageattribution.test.ts`

Rebuild the surface's layout per `Page.dc.html` (read it and the boards in its folder first). Keep every atom, effect, the keyboard list nav (`useSurfaceListNav`, same `navigableIds`), `openItem`, `selectWork`, `pickLens` and `pickWindow` as they are.

1. **Header.** Apply the Global Constraints header: no subtitle, the badge unchanged, and actions = lens `Segmented` (`ariaLabel="Lens"`) then range `Segmented` (`ariaLabel="Range"`). `SurfaceError` stays directly under the header.
2. **Scope bar** `[data-usage-scopes]` (`role="group" aria-label="Scope"`): one pinned row under the header (padding 12px 20px, gap 10px, `border-b border-edge-faint`), with the card sizing from Global Constraints.
   - **Card anatomy:**
     - Row 1: an 8px dot, the name (13px semibold, truncated) and a pill.
     - Row 2, mono 10.5px: `{fmt(tok)} tok · ≈ {usd(spend)}`, then a spacer, then the right-hand fact.
   - **Selection:** the pressed card uses `border-accent bg-surface-hover`; an idle card uses `border-border bg-surface hover:border-edge-strong`, the existing `ROW_ON`/`ROW_OFF`.
   - **By provider:**
     - The All usage card: dot `bg-accent`, pill "All" in accent-soft, `allStats` window tokens and spend, right-hand "every transcript".
     - One card per rail row: dot `providerDot`, name `providerLabel`, the state pill exactly as `stateMeta` gives it, the row's tokens and spend, and right-hand "5h x% · wk y%" or "history only".
   - **By work:**
     - The All usage card.
     - The project cards (`attr.projects`, which already carries the 1%/max-8 rule): dot `bg-ink-faint`, share pill, `title={key}`, right-hand `plural(count, "run or session", "runs and sessions")`.
     - Then `otherFoldersText` as plain text `[data-usage-other]`, after the cards.
   - Delete `UsageRail`, `ProviderRows`, `ProjectRows` and the `RailRow` group headings.
3. **Detail** `[data-usage-detail]`: scrolls, full width, padding 18px 28px 48px, gap 20px.
   - "Back to <scope>" stays above the header line for a drilled run or session.
   - The header line `[data-usage-head]` is an `h2` holding the scope name (14px semibold `text-primary`). It is followed by the same facts `providerHead` and `workHead` give today, in mono 11px `text-muted` with values in `text-secondary`, wrapping (gap 4px 14px).
   - A run's "Open run" button sits at the right end of the line.
   - Drop the glyph and pill. Reduce `DetailHead` to what is still rendered.
4. **Limits and stats row**, one flex row with gap 12px.
   - **By provider:** the Live limits section (`flex-[2]`) is the "Live limits" rule with its meta over the two `LimitCard`s (2 columns), or the no-quota paragraph `[data-usage-noquota]`. Its text is unchanged, including "for <Provider>".
   - **The Historical section** (`flex-[4]`) is the "Historical" rule with "durable · <window>", over the four stat cards `[data-usage-stats]` in 4 columns.
   - **Stat order:**
     - 7 days: API-equivalent, Reported cost, Tokens · 7 days, Tokens · today.
     - All time: API-equivalent, Reported cost, Tokens · all time, Daily avg.
     - Keep today's labels, values and sub-lines (`harnessSub`, shares of all usage and spend, pricing coverage, reported sources).
   - **By work:** there is no Live limits section, so Historical takes the row.
   - Below `xl`, the row stacks as in Global Constraints.
5. **List.** The By work list card (`WorkListCard`, unchanged content) goes under that row.
6. **Daily.** `DailyChart` goes full width under the row (or the list), as Task 3 left it.
7. **Where it goes.** A full-width card `[data-usage-split]` holds the "Where it goes" rule (meta `<scope label> · by spend`) over `SplitTable({ table: splitTable(split) })`.
   - Delete `SplitCard` (its note paragraph, two stacked bars and five-column key), and `StackedMeter`'s import if it becomes unused.
   - Delete `WorkSplit.note` and every note string in `usageattribution.ts` with their test expectations.
8. **Delete the model-group code.**
   - Delete `ModelGroup`, `MODEL_SEQ` and `MAX_MODEL_ROWS`.
   - In `usagestats.ts`, delete `providers`, `ProviderUsage`, `ModelUsage`, `foldModels`, `modelGridClass` and their tests.
   - Readers of `stats.providers` switch to `stats.models`: `hasHistory` and the `models` fact count.
   - Grep every name before deleting it.
9. **States**, matching `States.dc.html`:
   - **Loading** (`!usageLoaded`):
     - The scope bar and Live limits render as usual.
     - The Historical slot shows four skeleton stat cards (`SkeletonLine`), and a 330px-tall chart skeleton card follows: seven bars on the left, a 330px column of legend lines on the right.
     - Both blocks carry `[data-usage-skeleton]`.
     - There is no list and no split.
   - **Empty window:** the Historical slot shows the existing message in `[data-usage-empty]`; there is no list, Daily or split.
   - **Refresh error:** the `SurfaceError` banner shows, and the rest of the page keeps the last loaded usage.
   - **No quota:** the no-quota paragraph sits in the limits slot beside the stats.

**Acceptance:**

- `npx vitest run frontend/app/view/agents/usageattribution.test.ts frontend/app/view/agents/usagestats.test.ts frontend/app/view/agents/usagerail.test.ts` passes, and Check passes.
- The rendered states are shown by Task 5's scenario steps:
  - usage-charts `usage-main`, `usage-main-daily`, `usage-main-split`, `usage-provider-claude` and `usage-provider-claude-daily`;
  - usage-work `usage-work-all`, `usage-work-list`, `usage-work-split`, `usage-work-project-session` and `usage-work-project-session-split`;
  - usage-states `usage-loading`, `usage-noquota`, `usage-empty` and `usage-error`.
- This task renders every DOM-contract attribute in Global Constraints that those steps read.

### Task 5: CDP scenarios for every board, and the fixture seam

**Depends on:** Task 4
**Model:** claude-opus-5-5
**Files:** `frontend/app/view/agents/usagestore.ts`, `frontend/app/view/agents/usagestore.test.ts`, `scripts/cdp/scenarios.mjs`

**1. The DEV fixture seam** (`devUsageFixture` and `loadUsage` in `usagestore.ts`, still DEV-only) accepts two optional fields in the `wave:dev-usage-buckets` object:

- `delayMs: number`: `loadUsage` waits that long before using the fixture, so the skeleton is visible.
- `fail: true`: `loadUsage` takes its existing failure path. The last-good buckets are kept and `usageErrorAtom` is set.
- `devUsageFixture` checks `fail` **before** the `Array.isArray(value.buckets)` check. A `{ fail: true }` object with no buckets fails the load instead of falling through to the live RPC. The usage-states error step seeds exactly `{ fail: true }`.

vitest in `usagestore.test.ts`:

- `{ fail: true }` with no `buckets` field sets `usageErrorAtom`, keeps the earlier buckets, and never calls `RpcApi.GetUsageStatsCommand`. Spy on it to prove that.
- `delayMs` leaves `usageLoadedAtom` false until the delay passes (fake timers).

**2. usage-charts and usage-work.** Rewrite them for the new DOM, using the DOM contract only and scoping queries to its containers.

- **Lens:** read and press it through the buttons inside `[aria-label="Lens"]`, by text. Replace `data-usage-lens`. Read the range through `[aria-label="Range"]`.
- **Chart bars:** the fills are no longer only `var(--color-…)`. Select bars as `path[fill]` inside the Daily card's chart svg.
- **Below the fold:** `h.shot` captures only the 1600x950 viewport, and `[data-usage-detail]` scrolls. After each top-of-page shot named below, scroll to the parts below the fold and take a named shot of each. Use `scrollIntoView({ block: "start" })`, then wait about 300ms.
  - `[data-usage-daily]` → `<shot>-daily`
  - `[data-usage-split]` → `<shot>-split`
  - on By work, `[data-usage-list]` → `usage-work-list`

  Afterwards, scroll the detail back to the top.
- **usage-charts step 4:** hover a bar, then assert that the tooltip lists at least one `[data-usage-tip-model]` whose text includes a seeded model id (`claude-opus-4-8` on the All usage page), and has a `[data-usage-tip-total]` row.
- **usage-charts:**
  - Step 7 reads `[data-usage-scopes] [data-usage-harness]`.
  - Steps 8 and 16 read the legend, not the deleted model cards:
    - OpenCode selected → the legend's models are `gpt-5.5` and `unpriced-test-model`, with no claude model;
    - Pi selected → one model, shown in `[data-usage-daily-only]`, with no Codex or OpenCode rows.
  - Step 15 asserts `[data-usage-legend-group="opencode"]` and `[data-usage-legend-group="pi"]` on All usage.
  - Step 17 uses the Lens group.
  - Add a step: the "Where it goes" rows are sorted by spend, read from `[data-usage-split-part]` text, and the Total row exists.
  - Shots:
    - `usage-main`, `usage-main-daily` and `usage-main-split` (All usage, By provider, 7 days, loaded);
    - `usage-provider-claude` and `usage-provider-claude-daily` (the Claude card pressed, Live limits bars, the one-harness legend).
- **usage-work:**
  - Step 1b's split order assertion becomes "rows sorted by spend, and the set equals {arc, siem, other}".
  - Add a step that opens the arc project card, then the session `session:claude:fx-arc-1` from its Runs and sessions list, and asserts:
    - Back reads "Back to arc";
    - the arc card is still pressed;
    - the header `h2` is "Trace the usage scan";
    - there is no `[data-usage-list]`.
  - Shots:
    - `usage-work-all`, `usage-work-list` and `usage-work-split` (All usage, By work);
    - `usage-work-project-session` and `usage-work-project-session-split`.
- Keep every other existing assertion's intent.

**3. New scenario `usage-states`**, registered in `SCENARIOS`. It saves and restores `wave:dev-usage-buckets` and `wave:ratelimits` the way usage-charts does, and pins the viewport to `OBS_WIDE`.

| Step | Arrange | Assert | Shot |
|---|---|---|---|
| Loading | the usage-charts fixture plus `delayMs: 6000` and a Claude rate-limit snapshot; reload | while loading: `[data-usage-skeleton]` present, two `[data-usage-limit]` cards present, no `[data-usage-split]` | `usage-loading` |
| No quota | after load, press the Pi card | `[data-usage-noquota]` text starts "No quota reading for Pi"; `[data-usage-stats]` is present | `usage-noquota` |
| Empty window | fixture `{ buckets: [], sessions: [] }`; reload | `[data-usage-empty]` present; no `[data-usage-daily]` | `usage-empty` |
| Refresh error | load the usage-charts fixture, then set the fixture to exactly `{ fail: true }` (no buckets; the seam checks `fail` first); go to Cockpit and back to Usage | the banner text includes "Couldn’t refresh"; `[data-usage-stats]` still present | `usage-error` |

**Acceptance:**

- `npx vitest run frontend/app/view/agents/usagestore.test.ts` passes.
- `node scripts/cdp/verify.mjs usage-charts usage-work usage-states` passes against a dev app (Final runs it).
- Every shot above is recorded with `h.shot`.
