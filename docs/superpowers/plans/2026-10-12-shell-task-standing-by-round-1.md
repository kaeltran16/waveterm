# Shell Task Standing-By: fix round 1

**Goal:** Close two defects the run left inside its goal ("an agent whose turn ended while a background shell task still runs no longer reads as finished"): the Agent surface header dot does not read standing by, and an agent that ends its turn within the store's debounce of starting a background task still reads as finished at the Stop.

**Spec:** the run's plan, `docs/superpowers/plans/2026-10-12-shell-task-standing-by.md`, and its Prototype boards.

### Task 1: The Agent surface header dot reads standing by

**Depends on:** none

**Files:** `frontend/app/view/agents/agentheader.tsx`, `scripts/cdp/scenarios.mjs`

- `agentheader.tsx:175` draws `StatusDot` without `standing`, so while the agent stands by the header dot is grey (idle), though the tree row and the card dot are accent and still. The header already derives `standingBy` (line 128). Pass `standing={standingBy}` and keep it unpulsed, the same as the tree row (`agenttree.tsx`) and the card (`agentrow.tsx`).
- `scripts/cdp/scenarios.mjs`, the `shell-tasks` scenario: while the main agent stands by on the Agent surface, assert the header dot (`[data-agent-header]`) is accent and has no `pulse-dot` class. After the finish (step 6b), assert it is no longer accent. Inside `[data-agent-header]` there is one dot; scope the query to it.
- Acceptance for Final: the `shell-tasks` scenario's new header-dot assertions, and its screenshot of the Agent surface while standing by.

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`.

### Task 2: No finish at a Stop that comes before the task load

**Depends on:** Task 1

**Files:** `frontend/app/view/agents/subagenttracking.ts`, `frontend/app/view/agents/shelltasksstore.ts`, `frontend/app/view/agents/shelltasksstore.test.ts`, `frontend/app/view/agents/cockpitevents.ts`, `frontend/app/view/agents/cockpitevents.test.ts`, `frontend/app/view/agents/cockpiteventsrail.tsx`, `frontend/app/view/agents/agentrow.tsx`, `frontend/app/view/agents/agentheader.tsx`

The defect, from reading the code:
- Shell tasks reload through `scheduleShellTasks`, which waits 4s (`DEBOUNCE_MS`) after the last transcript activity.
- Suppose an agent starts a `run_in_background` Bash and ends its turn within those 4s, which is common ("started the dev server, standing by").
  - At the Stop, `shellTasksByIdAtom` does not yet hold the task.
  - `useRailTracking` sees working -> idle, not standing by, and pushes a "finished" event stamped at the Stop.
  - The card's settle (`agentrow.tsx` via `isFinishTransition`) and the header's `useSettle` fire as well.
- When the load lands, the agent turns standing by, which records nothing. When the task ends, a second "finished" event fires.
- So the agent reads finished at the Stop, which is exactly what the run set out to stop.

The fix:
- **Load on the idle transition.** When a tracked agent turns idle, its shell tasks are read at once, not debounced.
- **Hold the finish until that read lands.** Until a shell-task read that started at or after the agent turned idle has completed, the finish signals are held for that agent:
  - the rail's "finished" event;
  - the card's settle;
  - the header's settle.
- **Once the read lands, decide.** If it shows a running task, the agent is standing by and nothing fires. If not, the held finish fires once, stamped as today (`idleSince ?? now`).
- **A failed read releases the hold.** The store keeps its last list on failure, so the decision falls back to that list. The hold must never last past the read completing, in success or failure.
- **The band is unchanged.** The card's band and the dot still come from `isStandingBy`. Do not show "Standing by" for an agent that has no running task.
- **Your choice of mechanism.** One example is a per-agent "read pending since idle" set in the store, which `useRailTracking`, the card and the header consult. Keep the pure decision in `cockpitevents.ts` (or the store), unit-tested, with the components only wiring it.

Tests:
- Working -> idle while a read is pending: no finished event.
- The read then lands with a running task: no event. The task later ends: exactly one finished event.
- Working -> idle while a read is pending, and the read lands with no running task: exactly one finished event.
- A failed read releases the hold: the event follows the last known list.
- Idle with no tasks and no pending read: today's single event, unchanged.

Run: `npx vitest run frontend/app/view/agents` and `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`.
