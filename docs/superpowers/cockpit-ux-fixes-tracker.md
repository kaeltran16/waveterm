# Cockpit UX fixes — batch tracker

Tracking an 18-item UX/correctness batch across the cockpit, agent tab, usage tab,
memory graph, and activity tab. Started 2026-07-08.

## Scope assumption

- **"Cockpit"** = the card-grid surface (`frontend/app/view/agents/cockpitsurface.tsx`).
- **"Agent tab"** = the Sessions surface / session list (`sessionssurface.tsx` + `session-models/`).

If "Agent tab" turns out to mean the cockpit card grid, the pin/duplicate/tag items retarget.

## Decisions

- Menu consolidation → retire the dormant `FlyoutMenu`/`MenuButton` click-dropdown primitive
  (all right-click menus already use `ContextMenuModel`). **See open question in Batch 1.**
- Resume-on-reopen → gate on the existing claude `--continue` launch-flag toggle (no new setting).
- Head-text fallback → dispatched skill/command name **+** first line of the user prompt.

## Verification method

- **TDD** items: failing vitest / `go test` first, then minimal code. Suites already exist
  (`agentsviewmodel.test.ts`, `activitystore.test.ts`, `usagestore.test.ts`,
  `sessionviewmodel.test.ts`, `launch.test.ts`, `wshcmd-agenthook_test.go`, `memgraphlayout.test.ts`).
- **CDP** items: no jsdom/render harness exists (per project CLAUDE.md); verify rendered UI over
  CDP against the live dev app (`scripts/cdp-shot.mjs`, port 9222).

Status legend: `[ ]` todo · `[~]` in progress · `[x]` done · `[!]` blocked/needs input

---

## Batch 1 — Cross-cutting

- [~] **1. Cursor pointer everywhere** — base rule added to `tailwindsetup.css` (`@layer base`,
  `button:not(:disabled)` + `[role=button]`). Code in place; CDP-verify (`getComputedStyle().cursor`)
  deferred to the first Batch-2 CDP pass.
- [x] **2. Retire `FlyoutMenu`/`MenuButton`** — **SKIPPED by decision.** Right-click menus are already
  fully consolidated on `ContextMenuModel`; `FlyoutMenu` is an unrelated block-header click-dropdown
  (registered `HeaderElem` variant, no current producer). Left untouched.

## Batch 2 — Cockpit (`cockpitsurface.tsx` / `agentrow.tsx` / `agentsviewmodel.ts`)

- [x] **3. Consolidate dual suggestions** — removed the `replySuggestions` chip row from `agentrow.tsx`;
  `AnswerBar` is now the sole suggestion affordance. CDP-verify pending.
- [x] **4. 1 agent fills width** — `computeGridLayout` spans a lone column card full width
  (`colW = columnCards.length === 1 ? containerW : ...`). TDD: new test RED (493→1000) then GREEN,
  full suite 121/121.
- [x] **5. Span control** — grip now `opacity-40 group-hover:opacity-100` (always faintly visible) with
  an inline diagonal resize-grip SVG replacing the corner bracket (`agentrow.tsx`). CDP-verify pending.
- [x] **6. "Dismiss to Idle" → "Move to background"** — button + context-menu relabeled "Move to background"
  (fixed wrong `(M)`→`(B)` shortcut hint, dropped "Mute"); `⤓` → inline down-chevron-into-tray SVG.
  NOTE: idle-case still routes via `onDismiss` (Idle list), not the Backgrounded lane — flag at CDP whether
  behavior should also unify. CDP-verify pending.

## Batch 3 — Agent tab / Sessions

- [x] **7. Provider tag prominence** — Sessions-surface runtime badge upgraded from muted uppercase text
  to a `runtimeMeta` pill (colored glyph + text + soft bg + border) (`sessionssurface.tsx`). CDP-verify pending.
- [x] **8. Right-click menu on Agent tab (Close / Duplicate)** — added `onContextMenu` to AgentTree
  `ParentRow` (Duplicate → `duplicateSession`, Copy name, Close agent → `confirmCloseAgent`). CDP-verify pending.
- [x] **9. Pin function** — **DROPPED by user** (not going to use it). Pin removed from item 8's menu too.
- [x] **10. Resume respects `--continue`** — extracted pure `shouldPersistClaudeResume(provider, flags)`,
  gated `persistClaudeResume` on it (reads `naFlagsAtom`). TDD: 4 tests RED→GREEN. Now opt-in by default.
- [x] **11. Head-text fallback** — when `readLastTitle` is empty, fall back to `titleFromPrompt(lastUserPrompt(...))`
  (last human user turn, first line, rune-truncated to 72) in `wshcmd-agenthook.go`. TDD: Go tests RED→GREEN,
  full `wsh/cmd` suite green. NEEDS `task build:backend --force` to take effect in the app.

## Batch 4 — Usage tab (`usagesurface.tsx` / `usagestore.ts`)

- [x] **12. Fix laggy "All time" loading** — loader is now latest-wins (`loadSeq`, stale responses ignored),
  and the surface resets `usageLoadedAtom` on window change so the skeleton shows during the scan
  (60s refresh doesn't reset). TDD: latest-wins test RED→GREEN. CDP-verify the skeleton visual.
- [x] **13. Chart animations** — `DailyChart` columns grow up (scaleY, staggered) and `ModelGroup` bars
  grow from the left (scaleX, staggered) on mount, reduced-motion respected (`usagesurface.tsx`). CDP-verify.
- [x] **14. Single-model fill width** — extracted pure `modelGridClass(providerCount)` (full width when ≤1,
  `lg:grid-cols-2` otherwise), applied to the model grid. TDD: 2 tests RED→GREEN.
- [x] **15. Top-right indicator** — repointed `CockpitAppBar` to `mergeRateLimitWindows(providerPlanUsage(...))`
  (same data as the tab, persists when idle); colors aligned to success/warn/error; added a pure
  `topProviderUsage` selector that labels the shown provider with its `runtimeMeta` glyph when both exist.
  TDD: 2 selector tests RED→GREEN. CDP-verify.

## Batch 5 — Memory graph + Activity

- [x] **16. Memory graph clank** — memoize node/link objects on a structural `graphSignature` (sorted ids +
  edges) so hover/resize/now-tick/no-op-keystroke re-renders no longer rebuild the arrays and restart the
  sim; ResizeObserver only updates on real size change; faster settle (alphaDecay 0.045, cooldown 3000).
  TDD: graphSignature RED→GREEN (6/6). CDP-verify feel.
- [x] **17. Activity project filter** — added `activityProjectFilterAtom` + pure `applyProjectFilter` /
  `activityProjects`; project chip row (shown when >1 project) composed into
  `groupByProject(applyProjectFilter(applyFilter(...)))`; context-menu "Filter to project {p}".
  TDD: 4 tests RED→GREEN.
