# Usage Scope Bar: fix round 1

**Goal:** fix two defects the final stage's shots expose inside the Usage redesign. On the Spend metric, the Daily chart draws cent-scale days as near-flat slivers. The DEV fixture ignores the Range switch, so "7 days" shows all seeded days. The round also fixes one shot taken before its bars finished drawing.

Context: the tree already holds the merged result, including main's `SurfaceToolbar` with Usage's Lens and Range Segmented controls in its actions. Do not touch the header. Colors come only from `@theme` tokens. Do not fix the By work "no run started" run-linking bug, and do not move the floating Jarvis avatar.

### Task 1: Spend axis scales to cent-sized days

**Depends on:** none

**Files:** `frontend/app/view/agents/dailychart.tsx`, `frontend/app/view/agents/usagedaily.ts`, `frontend/app/view/agents/usagedaily.test.ts`, `scripts/cdp/scenarios.mjs`

In `scenarios.mjs`, edit only the usage-charts Spend step.

**Problem:** the y scale in `dailychart.tsx` is `domain: [0, Math.max(1, ...view.map((r) => r.total))]`. The floor of 1 means 1 token on Tokens but $1.00 on Spend. With the usage-charts fixture (about $0.05 a day, $0.24 over the window), every Spend bar draws as a sliver under a $1.00 axis (see `cdp-shots/usage-main-daily-spend.png`).

**Change:**
- Move the domain top into a pure, exported function in `usagedaily.ts` that takes the metric and the day totals, for example `yDomainMax(metric, totals)`. Use it in the chart's `y` scale.
- Tokens keeps its floor of 1. Spend's floor is one cent (0.01), so a window with all-zero spend still gets a valid domain.
- In both metrics, the tallest day fills the plot (subject to `nice: true`).
- The brush overview's `brushMax` has the same `Math.max(1, …)` floor. Give it the same treatment, so the all-time brush on Spend is not flat either.

**Tests:**
- vitest: Spend totals [0.03, 0.05] give a domain top of 0.05, not 1.
- vitest: all-zero Spend gives 0.01.
- vitest: Tokens [0, 0] gives 1.
- vitest: Tokens [500, 78000] gives 78000.
- Scenario: in the usage-charts step that presses Spend (the one that shoots `usage-main-daily-spend`), also assert that the tallest stacked bar is at least half the plot height. Read the bar rects and the plot height from the DOM, adding a `data-*` hook on the plot if none is readable. Keep the step's existing order and `$` checks.

**Acceptance:** vitest passes. `usage-main-daily-spend.png` shows Spend bars at readable heights under a cent-scale axis, and the new assertion passes.

### Task 2: DEV fixture honours the window; the no-quota shot waits for its bars

**Depends on:** Task 1

**Files:** `frontend/app/view/agents/usagestore.ts`, `frontend/app/view/agents/usagestore.test.ts`, `scripts/cdp/scenarios.mjs`

In `scenarios.mjs`, edit only usage-states step 2 and one usage-charts Range assertion.

**Problem 1:** `loadUsage(windowDays)` returns the DEV fixture's buckets unfiltered. The live RPC (`usagestats.ScanUsage`) keeps only what falls on or after `windowStart`: local midnight of today minus `windowDays - 1` days, and `0` means all time. So with the fixture, "7 days" shows all 16 seeded days and the same token total as All time.

**Change 1:**
- In the fixture path of `loadUsage`, keep only buckets whose day is on or after that same local-midnight cutoff when `windowDays > 0`.
- Keep sessions whose buckets survive, matching how the RPC pairs them. If the fixture's session shape makes that unclear, keep sessions unfiltered and say so in the report.
- Keep the `fail` and `delayMs` behaviour and its ordering (`fail` is checked before buckets) unchanged.

**Tests:**
- vitest, with fake timers pinned to a fixed date: a fixture with buckets on day 0, day −6 and day −7. `loadUsage(7)` keeps day 0 and day −6 and drops day −7. `loadUsage(0)` keeps all three.
- Scenario: one usage-charts assertion that 7 days and All time differ. On 7 days, the Daily chart has at most 7 day columns. On All time, its token total is larger than on 7 days. Put it in an existing Range step, or in a new one if none switches Range.
- Existing usage-charts assertions that relied on the unfiltered 16 days (for example the all-time brush, which needs more than 14 days) must still pass on All time. Adjust a step's Range rather than its intent if one now runs on 7 days by default.

**Problem 2:** usage-states step 2 shoots `usage-noquota.png` right after clicking the Pi card, while the motion cascade is still growing Pi's bars from `scaleY` 0. The shot shows an empty chart.

**Change 2:** before that shot, wait until the Daily chart's bars have finished their entrance. For example, poll until every bar's computed transform is the identity, or wait for whatever settled signal the chart exposes, with a bounded timeout. Then shoot. Apply the same wait to any other usage shot taken right after a scope click, if one has the same race.

**Acceptance:** vitest passes. `usage-noquota.png` shows Pi's bars. The new Range assertion passes. Every existing usage-charts, usage-work and usage-states step still passes.
