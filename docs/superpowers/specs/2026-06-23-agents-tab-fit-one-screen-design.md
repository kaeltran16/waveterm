# Agents Tab — Auto-Fit to One Screen

Date: 2026-06-23
Status: Approved design (pending spec review)
Scope: `frontend/app/view/agents/*` (frontend only; no backend/RPC/projection changes)

## Problem

The Agents tab is a single vertically-scrolling column. Each working/asking row renders a `NarrationTimeline` capped at 240px (`RowNarrationMaxPx`) and individually drag-resizable up to 80% of the viewport. Total height therefore grows as `sum(per-row narration)` — unbounded. With the common 4–5 agents (and sometimes just 1–2), two chatty agents already push the rest off-screen, forcing a scroll. There is no way to scale density to the live count, and no way to demote a long-running agent you've stopped watching.

This is the "load-adaptive working clamp" the 2026-06-22 list-redesign spec parked in its §9 future work.

## Goals

- Auto-fit to the **live agent count**: generous narration at 1–2 agents, tight at 4–5, so the common range fits one screen without scrolling.
- Reflow live when the block/window is resized.
- Keep the action surface (open questions) always fully readable, even with several asks at once.
- Let the user demote a still-running "don't-care" agent out of the active set, reclaiming its space.
- Give explicit, legible density control on top of the implicit auto-fit.
- Scrolling becomes a last resort, not the normal state.

## Non-goals

- Auto-detecting "executing a plan" / autonomous runs — there is no such signal in `AgentVM` today; demotion is manual (a later phase could add an auto signal).
- Persisting density settings across app restarts (session-only for v1).
- Any backend, RPC, projection, or status-feed change. The live transcript stream, answer encoding, `previousInfo`, and status feed are unchanged.
- Changes to the focus view, idle section internals, plan strip, or empty state beyond what the layout requires.

## Core principle

Decouple **how much space exists** (the block's measured height) from **how it is allotted** (priority by state, then a bounded per-row budget). Asks are the priority tier and are never clamped; working rows share the leftover under a min/max budget; agents the user doesn't care about are removed from the active set entirely. Three density levers sit on this engine, from implicit to explicit:

1. **Auto-fit** (always on) — measure available height, divide among working rows.
2. **Max-panels cap** — explicitly cap how many working rows expand.
3. **Region divider** — manually bias the asks ↔ working split under contention.

---

## 1. Layout regions (top → bottom)

1. **Header** — `Agents` title, `N needs you · jump →` (amber, when asks > 0), `N working`, plus a **max-panels segmented control** (`Auto · 1 · 2 · 3 · 4`) on the right.
2. **Plan strip** — unchanged (per-provider 5h/weekly gauges).
3. **Asks region** — *spotlight*. The focused ask renders full (question prose + answer options, never clamped); every other asking agent collapses to a one-line amber "needs you" header. `n` cycles the focus through asks; the focused ask is the cursor when the cursor is on an ask, otherwise the first ask. The region takes its natural height, bounded above by the divider (see §4).
4. **Region divider** — a draggable horizontal handle between the asks region and the working region (see §4).
5. **Working region** — auto-fit (see §3). Up to the cap of working rows expand with a narration budget; the rest render as one-line headers, in place, still clickable and still running. The **cursor row is always expanded**.
6. **Backgrounded lane** — a collapsed, expandable lane (a light `IdleSection` variant) listing still-running agents the user muted with `b`. Reversible.
7. **Idle lane** — the existing `IdleSection`, unchanged.
8. **Hints footer** — existing hints plus `b background`.

## 2. State (in `AgentsView`)

- `backgroundedIds: Set<string>` — agents manually pushed to the Backgrounded lane (mirrors the existing `dismissed` pattern; keyed by agent id).
- `maxPanels: "auto" | number` — the segmented control value. Default `"auto"`.
- `dividerRatio?: number` — the asks/working split as a fraction of available height. `undefined` = auto (no manual override). Session-only.

Existing state (cursor, anchored `order`, `dismissed`, answer selections, focus) is retained.

## 3. Auto-fit algorithm (the engine)

Measure the working region's available height with `useDimensionsWithExistingRef` (debounced; reuses the repo's ResizeObserver hook). Then, with `headerH` ≈ the fixed per-row header height and the budget clamped to `[MIN_NARRATION, MAX_NARRATION]`:

- **Expanded set.** Working rows are ordered by the existing `sortAgents` (longest-running first).
  - `maxPanels === "auto"`: expand as many as fit at the floor — `expandedCount = clamp(floor((avail − workingCount·headerH) / MIN_NARRATION), 1, workingCount)`.
  - `maxPanels === N`: `expandedCount = min(N, workingCount)`.
  - The cursor row is forced into the expanded set (swap it in for the lowest-priority expanded row if it would otherwise be excluded).
- **Per-row budget.** `narration = clamp((avail − workingCount·headerH) / expandedCount, MIN_NARRATION, MAX_NARRATION)`. Collapsed (non-expanded) working rows render header-only (`headerH`).
- **Last resort.** If the expanded rows can't all reach `MIN_NARRATION` (more capped panels than fit), the working region scrolls. Auto mode avoids this by construction (it reduces `expandedCount`); it can only happen when the user pins the cap higher than fits.

Proposed constants (named, tunable in the plan): `MIN_NARRATION ≈ 72px`, `MAX_NARRATION = 240px` (the current per-row cap), `headerH ≈ 24px`. The budget is passed to `AgentRow` as a prop; the row no longer owns its height.

## 4. Region divider (lever 3)

A *contention arbiter*, not a row resizer. When the asks region and working region both fit, the divider is inert and hidden. Under contention it caps the asks region's height; the working region takes the remainder and auto-fits within it.

- Position stored as `dividerRatio` (fraction of available height), so it scales when the block is resized.
- **Double-click** resets to auto (`dividerRatio = undefined`).
- Session-only; not persisted to layout meta in v1.
- The asks region scrolls internally if its content exceeds the divider-imposed cap.

## 5. Max-panels cap (lever 2)

A segmented control in the header: `Auto · 1 · 2 · 3 · 4`. `Auto` defers to the auto-fit expanded-set rule; a number hard-caps `expandedCount`. **Mouse-only** — no keyboard binding, because `1–9` already select answer options on the cursor's ask. Session-only.

## 6. Demotion — manual background (the active-set filter)

A `b` key and a per-row "background" button (placed alongside the existing terminal/dismiss controls) move a working agent into `backgroundedIds`. Backgrounded agents leave the working region and appear as a collapsed, expandable Backgrounded lane; they keep running. Un-backgrounding (expand the lane, click the agent, or `b` again on a re-surfaced row) returns them to the working set.

**Asking overrides backgrounded:** if a backgrounded agent transitions to `asking`, it re-surfaces into the asks region (the user must act on it) and is dropped from `backgroundedIds`.

## 7. Keyboard

Additions to the existing keymap:

| Key | Action |
|-----|--------|
| `b` | Background / un-background the cursor agent (no-op on an asking agent) |

Unchanged: `↑↓/jk` move, `n` next ask, `1–9` select answer, `←→/hl` switch question, `↵` open/confirm, `r` reply, `t` terminal, `esc` back, `?` help. The help overlay and hint bar gain the `b` entry.

## 8. Components affected (frontend only)

- **`agents.tsx`** — restructure into the regions above; add the fit computation (measure + distribute), the max-panels control, the divider, the `b` handler, spotlight-ask routing, and the `backgroundedIds` / `maxPanels` / `dividerRatio` state.
- **`agentrow.tsx`** — accept `collapsed` (header-only render) and `narrationBudget` props; **remove** the per-row resize grip and `RowNarrationMaxPx` / `RowNarrationMinPx` / `RowNarrationMaxFrac` / `narrationMax` state; add the background button.
- **`backgroundedsection.tsx`** *(new)* — collapsed lane for running muted agents; a light variant of `IdleSection` (no composer needed, click re-surfaces).
- **`agentsviewmodel.ts`** — new pure helpers (with tests): expanded-set selection (cap + cursor + sort), narration-budget distribution (clamp + scroll flag), backgrounded partition, asking-overrides-backgrounded. No change to the `AgentVM` shape.
- **`answerbar.tsx`, `focusview.tsx`, `idlesection.tsx`, `statusdot.tsx`, `narrationtimeline.tsx`, projections, `liveagents.ts`, `livetranscript.ts`** — unchanged (the spotlight ask reuses `AnswerBar`; collapsed rows reuse the row header).

## 9. What's removed

- The per-row narration drag-resize grip and its constants/state in `agentrow.tsx`. Density now comes from auto-fit + cap + divider; deep reading is the focus view (`↵`).

## 10. Edge cases

- **All idle / empty:** unchanged empty state.
- **Recently-idle grace:** a just-finished agent keeps a full (expandable) row during the grace window, then collapses into the Idle lane — subject to the cap like any working row.
- **Cursor on a collapsed/backgrounded row:** the cursor row is always expanded; backgrounding the cursor agent moves the cursor to the next active row.
- **Block too short for even one expanded row at MIN:** the single expanded (cursor) row still renders; the working region scrolls.

## 11. Testing

- **Pure (`agentsviewmodel`):** expanded-set selection across `auto`/`N` with cursor inclusion and sort order; budget distribution (short message not padded, clamp at MIN and MAX, scroll flag when over-capped); backgrounded partition; asking-overrides-backgrounded; existing ordering/grouping tests still pass.
- **Interaction:** max-panels control changes the expanded count; `b` toggles backgrounded and re-surfaces on ask; divider clamps asks region and double-click resets; resize reflows budgets; keymap stays inert when a composer/input is focused or the view lacks focus.

## 12. Future enhancements (noted, not built)

- Auto-detect plan/autonomous agents for auto-backgrounding (needs a new backend signal).
- Persist `maxPanels` / `dividerRatio` per block in layout meta.
- Attention ordering (float stalled/erroring agents); first-class stalled/error signals.
