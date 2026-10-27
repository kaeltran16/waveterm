# Monitor tasks: fix round 1

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Verify:** `node scripts/verify.mjs ./pkg/resmon`
**Check:** `task check:ts`
**Final:** `node scripts/cdp/final-verify.mjs monitor-tasks shell-tasks`
**Prototype:** C:\Users\kael02\AppData\Local\arc-wt\0bb9fc91\.superpowers\design\monitor-tasks\project\Main.dc.html

**Goal:** Pass Final's `monitor-tasks` step 1 and fold the two copies of the peek and row clock formatter into one shared helper.

**Architecture:** Step 1 failed because of the scenario, not the product. The rows show the right title. While the pointer rests on an element, `TitleTooltipHost` (`frontend/app/element/titletooltip.tsx`) moves that element's `title` into `data-arc-title`, so the hovered `bmtevents` row read `title` as null. The scenario has to read either attribute, as other scenarios already do (`scripts/cdp/scenarios.mjs`, the `data-arc-title` reads near the `DRIFT_HOST("AgentRow")` step). Separately, `clockTime` exists twice: in `agenttree.tsx` it uses `hour12: false`, which Chromium can render as `24:xx` at midnight, and in `shelltaskpeek.tsx` it uses `hourCycle: "h23"`. One exported helper in `shelltasks.ts` replaces both.

**Tech Stack:** React 19, vitest, CDP scenarios.

## Global Constraints

- Only the files listed under each task change. No change to `titletooltip.tsx`: parking a title on hover is how it works.
- Every copy and DOM attribute from the original plan (`2026-10-27-monitor-tasks.md`) stays as it is.
- Format `scripts/*.mjs` by hand with 4-space indents. Never run prettier on it.

## Review Focus

- A row under the pointer: its title is still checked, through `data-arc-title`, rather than skipped.
- Midnight: an event at local 00:00:05 reads `00:00:05`, never `24:00:05`, in both the row title and the peek.

---

### Task 1: Scenario reads a parked title

**Depends on:** none

**Files:** `scripts/cdp/scenarios.mjs`

Modify `monitorTasksScenario`, starting with step 1's `titles` probe.

- [ ] **Step 1:** In step 1's probe, read each row's title as `taskRow(id)?.getAttribute("title") ?? taskRow(id)?.getAttribute("data-arc-title") ?? null`. Leave the assertion against `./bmtshell.sh` and the `MONITOR_LIVE` commands unchanged. Add a one-line lower-case comment saying why: the title tooltip host parks a hovered element's title in `data-arc-title`.
- [ ] **Step 2:** Check any other title read in `monitorTasksScenario` that runs while the pointer can rest on the element, for example step 3's Stop X `title` after the hover. Give each one the same fallback.
- [ ] **Step 3:** Run `node --check scripts/cdp/scenarios.mjs`. Expected: exit 0. Final runs the scenario itself.
- [ ] **Step 4:** Commit `test(cdp): monitor-tasks reads a parked row title`.

### Task 2: One shared clockTime

**Depends on:** none

**Files:** `frontend/app/view/agents/shelltasks.ts`, `frontend/app/view/agents/agenttree.tsx`, `frontend/app/view/agents/shelltaskpeek.tsx`, `frontend/app/view/agents/shelltasks.test.ts`

**Interfaces:**
- Produces: `export function clockTime(ms: number): string` in `shelltasks.ts`. It returns local `HH:MM:SS` through `toLocaleTimeString` with 2-digit hour, minute and second and `hourCycle: "h23"`, the body `shelltaskpeek.tsx` has now.

- [ ] **Step 1: Failing test.** In `shelltasks.test.ts`, add `describe("clockTime")`:
  - `clockTime(new Date(2026, 9, 27, 0, 0, 5).getTime())` returns `"00:00:05"`
  - `clockTime(new Date(2026, 9, 27, 23, 59, 59).getTime())` returns `"23:59:59"`
  - `clockTime(new Date(2026, 9, 27, 9, 4, 42).getTime())` returns `"09:04:42"`
- [ ] **Step 2:** Run `npx vitest run frontend/app/view/agents/shelltasks.test.ts`. Expected: FAIL, because `clockTime` is not exported.
- [ ] **Step 3:** Move the helper to `shelltasks.ts` as specified under Interfaces. Delete both local copies and import it in `agenttree.tsx` and `shelltaskpeek.tsx`. Leave `petcondition.ts`'s own `clockTime` alone: it is another feature.
- [ ] **Step 4:** Run `npx vitest run frontend/app/view/agents/` (expected: PASS), then `task check:ts` (expected: exit 0).
- [ ] **Step 5:** Commit `refactor(agent): one clockTime for monitor rows and peek`.
