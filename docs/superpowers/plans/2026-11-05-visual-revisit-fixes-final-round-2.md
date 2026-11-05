# Visual revisit fixes: Final round 2 fix plan

**Spec:** `docs/superpowers/specs/2026-11-05-visual-revisit-fixes-design.md`
**Verify:** `node scripts/verify.mjs ./pkg/util/keyedmutex`
**Check:** `task check:ts`
**Final:** `node scripts/cdp/final-verify.mjs diff-states diff-compare code-diff-states code-peek resmon-footer usage-charts agent-header cockpit-card-layout cockpit-roster-counts sessions-list-states sessions-detail-states code-markdown code-toolbar cockpit-launch-stays`

**Goal:** Make Final pass: `sessions-list-states` threw before its first step, and the solo Sessions header has the same actions overflow t-9 fixed on the run-member header.

**Architecture:** Two independent tasks with disjoint files. Round 2's Final passed 175/175 steps but `sessions-list-states` threw `TypeError: Failed to resolve module specifier 'undefined'` (it passed in round 1). The scenario finds app modules with `performance.getEntriesByType("resource").find(...)`. The browser's resource timing buffer holds 250 entries by default, so a lazily loaded module (`sessionsarchivestore.ts`) is missing from the list once earlier scenarios in the same app have filled it. Final's scenario order decides whether that happens.

## Global Constraints

- Existing `@theme` tokens only; no new token.
- A step measures the state (rects, computed style, DOM order) and records pass/fail; a shot alone is not a step. A viewport override set in a step is restored in a `finally`.
- Never attach to or kill the dev app on :9222; live checks run only through Final.

## Review Focus

1. `sessions-list-states` run after the Monaco-heavy scenarios (`diff-states`, `code-peek`, `usage-charts`): every module import must resolve whatever the resource timing buffer holds.
2. A blocked solo session (a Resume reason plus the disabled Resume) at 1000x700: the actions row stays inside the header.

---

### Task 1: sessions-list-states: resolve app modules when the resource timing list is full
**Depends on:** none
**Files:** `scripts/cdp/scenarios-sessions-list-states.mjs`

- [ ] Replace every bare `names.find((n) => n.endsWith("/app/..."))` import in the file (in `WITH_MODEL`, `stubSearch`, `restoreSearch`, and step 1's `sessionsarchivestore.ts` read; grep `getEntriesByType` for the full list) with the repo's existing fallback, as `LOOK_LIB`'s `mod` in `scenarios-shared.mjs:949` and `LIB` in `agent-page-fixtures.mjs:14` do: take the module's own entry if listed, else derive its URL from the `jotaiStore.ts` entry (`base.replace("app/store/jotaiStore.ts", path)`), and throw `"no app module url for " + path` when neither exists. Define the helper once in the page-side string the file already shares (`WITH_MODEL` or a sibling constant), not once per call site.
- [ ] No step is added or changed; the proof is that Final runs the scenario's steps instead of throwing.

### Task 2: Sessions solo header: actions stay inside at 1000x700
**Depends on:** none
**Files:** `frontend/app/view/agents/sessionsdetail.tsx`, `scripts/cdp/scenarios-sessions-detail-states.mjs`

Spec F11. t-9 found that the solo header's actions div (`sessionsdetail.tsx`, the `flex flex-none items-center gap-3.5 self-center @max-[600px]:basis-full @max-[600px]:pl-14` div under `[data-sessions-solo-header]`) lacks the `min-w-0` it added to the run-member header's actions, so a blocked solo session at 1000x700 can push its actions out of the header.

- [ ] Give that actions div `min-w-0`, matching the run-member header's fix in commit 847ed4771. Read that commit first: if it changed anything besides `min-w-0` that the solo header also needs, apply the same.
- [ ] **New step 16:** at 1000x700 (restored in a `finally`), open the blocked solo session `fx.blocked` (as step 2 does) and measure `[data-sessions-solo-header]` the way step 15 measures the member header: read the container width against the 600px threshold and branch (below 600 the actions sit under the title, at or above it they sit inline with no overlap), the title is at least 200px wide and fits or truncates with an ellipsis, and every action button's rect, the disabled Resume included, lies inside the header. Put the layout case and the header width in the detail.
