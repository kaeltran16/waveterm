# Shell Task Standing-By Implementation Plan

**Verify:** `node scripts/verify.mjs ./pkg/agentobserve`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
**Final:** `node scripts/cdp/final-verify.mjs shell-tasks`
**Prototype:** C:/Users/kael02/IdeaProjects/waveterm/.superpowers/design/bg-task-state/project/Main.dc.html

**Goal:** A claude agent whose turn ended while a background shell task still runs no longer reads as finished. The Agent tab tree and the cockpit card show its running shell tasks, the parent reads "standing by" the way an orchestrator lead does, and a task's output opens in a peek.

**Architecture:** Frontend only, no Go and no generated-file change. The hook still publishes `idle` on Stop, so orchestrator wake and message delivery are untouched. The cockpit derives the shell tasks from the agent's live transcript, the way `subagentsstore.ts` derives subagents, and draws "standing by" from `idle` plus a running task.

**Tech Stack:** TypeScript, React 19, jotai, vitest, the CDP scenario harness.

**Spec:** none. The design is the canvas named under Prototype (four boards: `Main`, `TreeCollapsed`, `TreeExpanded`, `Interactive`) plus this plan. Read each board's `.dc.html` before a task that draws it.

## Why

- `planEmission` (`cmd/wsh/cmd/wshcmd-agenthook.go:59`) maps every Stop to `idle`. An agent that launched a `run_in_background` Bash ends its turn, so it reads idle and "Finished" (the card band in `agentrow.tsx`) while the task runs. When the task completes Claude Code starts a turn with no UserPromptSubmit, so the state stays idle until the next tool call.
- The same `idle` is read as "safe to message" by orchestrator wake (`pkg/orchestrate/wake.go:302`) and message delivery (`wshserver_agentmsg.go:130`), and a long-lived task such as a dev server never ends. So the published state must not change; the cockpit derives a display state instead, as it does for a lead standing by (`leadStandingBy`, `leadMark`, `leadActivity` in `leadcardmodel.ts`: accent and still, "standing by").
- Transcript shapes, measured on real transcripts under `~/.claude/projects/C--Users-kael02-IdeaProjects-waveterm/`: a start is a user record whose `toolUseResult.backgroundTaskId` is set, and whose `message.content[0].tool_use_id` names the assistant `tool_use` (name `Bash`, `input.run_in_background` true, `input.description` optional, `input.command`); its `tool_result` text says `Output is being written to: <path>`. A finish is a `queue-operation` record with `operation` `enqueue` whose `content` is a `<task-notification>` holding `<task-id>`, `<tool-use-id>`, `<output-file>`, `<status>` and `<summary>` (for example `completed (exit code 0)`); `transcriptprojection.ts` already parses the user-role form of that block (`parseTaskNotification`).
- The output file is often only `[exited with code 0]`: agents redirect their real output to files. That is why the peek shows "No output yet." for an empty file and does not try to be more.
- `GetAgentTranscriptCommand` (`wshserver_agents.go:29`) already tails any file by path in lines, so the peek needs no new RPC.

## Global Constraints

- Frontend only. Do not touch Go, `cmd/wsh/cmd/wshcmd-agenthook.go`, or any generated file. The published agent state stays `idle`.
- Colors come from `@theme` tokens (`frontend/tailwindsetup.css`); no raw hex or rgba in components, no new tokens. Read `DESIGN.md` before styling. The boards use hex only because a canvas is scaffolding: map each to its token (`accent`, `muted`, `error`, `surface-code`, `edge-mid`, `edge-strong`, `surface-raised`, `shadow-popover-lg`).
- Testable logic is a pure `.ts` with a `.test.ts` beside it, consumed by a thin `.tsx`. No jsdom render tests.
- Only running and failed shell tasks are shown or counted. A task that completed cleanly drops off, as a finished subagent does. A task the user stopped (killed) drops off too.
- Standing by means the agent's state is `idle` and at least one of its shell tasks is running. It is derived, never published, and never stored on the agent. Every consumer computes it the same way, at the place it already holds the agent: `isStandingBy(agent.state, useAtomValue(shellTasksByIdAtom)[agent.id] ?? [])` in a component, `globalStore.get(shellTasksByIdAtom)` outside one. There is no standing-by atom: the agents list is an `AgentsViewModel` instance field (`devRosterAtom` in DEV, `liveAgentsAtom` in prod), so a module-level atom over it cannot exist, and every caller already has the agent.
- Two counts, never mixed. A chip (`shellTasksLabel(n)`, tree and card) counts the visible tasks, running and failed: the `Interactive` board's "3 shell tasks" is 2 running + 1 failed. The `Standing by` band's meta counts running tasks only (`2 shell tasks running`).
- The pulse (`pulse-dot`) stays reserved for `working`. A standing-by dot is accent and still.
- A transcript tail window is a cap: `SHELL_TAIL_LINES = 2000` records. A task started before the window is not listed. Accepted; say so in the constant's comment.
- `scripts/cdp/scenarios.mjs` is edited by one task only (Task 7).
- Lowercase "why" comments only. `npx prettier --check` and `npx eslint` only on the files you touch; never `--write` the tree.

## Out of scope

- Background Agent or Workflow tasks (they also send `<task-notification>`): only a Bash start record counts.
- Any change to the Stop hook, `agent:status`, the roster sort (`groupAgents`), or orchestrator wake.
- Stopping a shell task from the cockpit. A task row with no output file path is not clickable.
- Whether a task survived the agent's own restart: a task that never finishes because the session died stays listed as running until it leaves the window.

## Review Focus

- `idle` with no running task is exactly today's behavior everywhere (Task 3 tests, all defaulting the new arguments to false).
- A task that finishes while the agent is still idle ends standing by and fires one "finished" rail event then, not at Stop (Task 3 test).
- Both finish record shapes (the `queue-operation` enqueue and the user-role string) settle a task, and a notification for an id with no Bash start is ignored (Task 1 tests).
- The peek reads only through `GetAgentTranscriptCommand`, trims to the last 4096 characters (Task 1 `peekText` test), and a missing file resolves to no lines, not an error (Task 2 `shelltasksstore.test.ts`), which the peek draws as "No output yet." (Task 7 missing-file step).
- The tree's nested rows and the card's chip list agree on what is listed (running and failed only).

---

### Task 1: Read shell tasks from a transcript

**Depends on:** none

**Files:** `frontend/app/view/agents/shelltasks.ts`, `frontend/app/view/agents/shelltasks.test.ts`

New pure module, no React and no Wave runtime imports (match the header comment of `agentrowmodel.ts`).

- `export interface ShellTask { id: string; description: string; state: "running" | "failed"; startedTs?: number; outputPath?: string; exitCode?: number }`
- `export function extractShellTasks(lines: string[]): ShellTask[]`: project the transcript JSONL lines. A task starts at a user record with `toolUseResult.backgroundTaskId`; look up its `tool_use` for `description` (fall back to `command` cut to 60 characters, the cap `detailForTool` uses in Go) and take `timestamp` as `startedTs` and the `Output is being written to:` path as `outputPath`. A `<task-notification>` for that id settles it, from either record shape (a `queue-operation` enqueue `content`, or a user-role string), the later one winning. Survey the real transcripts first (a short node script over `~/.claude/projects/*/*.jsonl`) for the distinct `<status>` values, and map them: a clean completion removes the task, a failure keeps it as `failed` with `exitCode` from the summary's `(exit code N)`, and a stopped or killed task removes it. Unparseable lines are skipped. Order by start.
- `export function visibleShellTasks(all: ShellTask[]): ShellTask[]`: running and failed only (what `extractShellTasks` returns already; keep it so callers state intent).
- `export function isStandingBy(state: string, tasks: ShellTask[]): boolean`: `state === "idle"` and any task running.
- `export function shellTasksLabel(n: number): string`: `1 shell task`, `3 shell tasks`.
- `export const SHELL_TAIL_LINES = 2000`.
- `export function peekText(lines: string[], maxChars = 4096): string[]`: the output lines trimmed so the joined text is at most the last `maxChars` characters, dropping a cut leading line fragment.

Tests, with fixtures lifted from the real transcripts (trimmed): a running task; a task finished by each record shape; a failed task with its exit code; a killed task; a notification for an id with no Bash start; a start with no `description`; two tasks, one done; `isStandingBy` for idle, working and asking with and without a running task; `peekText` cutting mid-line.

Run: `npx vitest run frontend/app/view/agents/shelltasks.test.ts`.

### Task 2: A store for each agent's shell tasks and their output

**Depends on:** Task 1

**Files:** `frontend/app/view/agents/shelltasksstore.ts`, `frontend/app/view/agents/shelltasksstore.test.ts`, `frontend/app/view/agents/subagenttracking.ts`

- `shelltasksstore.ts` mirrors `subagentsstore.ts`: `export const shellTasksByIdAtom` (agent id to its visible tasks, a module-level `PrimitiveAtom<Record<string, ShellTask[]>>` like `subagentsByIdAtom`), `refreshShellTasks(id, transcriptPath)` reading `GetAgentTranscriptCommand` with `maxlines: SHELL_TAIL_LINES` through `extractShellTasks`, a debounced `scheduleShellTasks` on parent-transcript activity, `dropShellTasks`, the same sequence guard so a slower older load is discarded, and an empty result removing the key.
- No standing-by atom (see Global Constraints): consumers call `isStandingBy` with `shellTasksByIdAtom`'s entry for the agent.
- `readShellTaskOutput(path: string): Promise<string[]>`: `GetAgentTranscriptCommand` with a small `maxlines` (80) then `peekText`. A missing or unreadable file resolves to an empty array, never rejects.
- `shelltasksstore.test.ts`: mock `@/app/store/wshclientapi` the way `frontend/app/cockpit/resmonstore.test.ts` does. `readShellTaskOutput` resolves to `[]` when `GetAgentTranscriptCommand` rejects, and to the `peekText`-trimmed lines when it returns some.
- `subagenttracking.ts`: call the shell-task refresh, schedule and drop beside the subagent ones, inside the same effects, so the tree, the cockpit grid and the Runs surface all populate it (no second effect).
- A task whose agent is not idle must still be listed (the chip shows while an agent works); only `isStandingBy` cares about idle.

Run: `npx vitest run frontend/app/view/agents/shelltasksstore.test.ts`; `task check:ts`.

### Task 3: Pure models know about standing by

**Depends on:** Task 1

**Files:** `frontend/app/view/agents/agentrailmodel.ts`, `frontend/app/view/agents/agentrailmodel.test.ts`, `frontend/app/view/agents/cockpitevents.ts`, `frontend/app/view/agents/cockpitevents.test.ts`, `frontend/app/view/agents/agentrowmodel.ts`, `frontend/app/view/agents/agentrowmodel.test.ts`, `frontend/app/view/agents/statusdot.tsx`

- `railAction(state, age, live, standingBy = false)`: returns `null` while standing by (nothing to resume or stop). Unchanged for every other input.
- `agentTransitions(prev, agents, now, standingBy: ReadonlySet<string> = new Set())`: `AgentSnap` gains `standingBy: boolean`. The "finished" event fires when an agent is idle and not standing by now, and was working or asking or standing by before; it does not fire at the Stop that begins standing by. The early `continue` on an unchanged snap compares state and standing by together, so idle standing by to idle not standing by is a change. A first sighting still records nothing.
- `isFinishTransition(prev: AgentState, next: AgentState, prevStandingBy = false, nextStandingBy = false)`: true when `next` is idle and not standing by, and before it was working, or idle and standing by (its last task ended while idle). Working to idle while standing by is false. With both flags false it is today's working-to-idle rule.
- `StatusDot` gains an optional `standing?: boolean`: color `accent`, never pulsing, regardless of `state`. Default off, so no current caller changes.

Tests: `railAction` null while standing by and unchanged otherwise; the events for working to idle with a task (none), the same agent when its task ends while its state stays idle (one finished event), and idle with no tasks (today's single event); `isFinishTransition` for working to idle (true), working to idle standing by (false), idle standing by to idle not standing by (true), and idle to idle with no standing by on either side (false).

Run: `npx vitest run frontend/app/view/agents/agentrailmodel.test.ts frontend/app/view/agents/cockpitevents.test.ts frontend/app/view/agents/agentrowmodel.test.ts`.

### Task 4: The Agent tab tree shows shell tasks and their output

**Depends on:** Task 2, Task 3

**Files:** `frontend/app/view/agents/agenttree.tsx`, `frontend/app/view/agents/shelltaskpeek.tsx`

Boards: `TreeCollapsed.dc.html`, `TreeExpanded.dc.html`, `Interactive.dc.html`. Copy sizes, spacing and classes from `ParentRow` and the subagent rows in `agenttree.tsx`.

- `ParentRow`: next to `subsChip`, a `FoldChip` labelled `shellTasksLabel(n)` (n = visible tasks, running and failed) that folds the parent's nested task rows, default open when a task is running and closed otherwise (follow how `subagentExpanded` defaults). Its dot is `StatusDot` with `standing` when the agent is standing by. The settle animation (`useSettle`) runs only when idle and not standing by.
- Nested rows under the agent, one per visible task, with the same tree guide as a subagent row: a dot (accent for running, `error` for failed), the task description in the mono 11.5 style, and a second line `running · <age>` (age from `startedTs`, `formatAgeShort`) or `failed · exit N`. A row with an `outputPath` is clickable and takes the selected tint while its peek is open; one without is not.
- `shelltaskpeek.tsx`: the popover the `Interactive` board draws, anchored beside the tree: header (dot, description, status, close button with an `aria-label`), a scrollable body on `surface-code` showing `readShellTaskOutput` lines, `No output yet.` when empty, and a footer with `…\tasks\<id>.output` and `last 4 KB · live` for a running task or `last 4 KB` for a failed one. It re-reads every 2 seconds only while the task is running and the peek is open. Clicking the row again, the close button, or anywhere outside closes it.
- Folding the chip closes an open peek.
- Each nested row carries `data-shell-task={id}` and the peek's root `data-shell-task-peek`, so Task 7 can scope its queries.
- Acceptance for Final: Task 7's steps 2 (`TreeCollapsed`), 3 (`TreeExpanded`), 4 (`Interactive`) and 5 (missing output file) perform the clicks and read the peek text.

Run: `task check:ts`; `npx prettier --check` on the two files.

### Task 5: The cockpit card says standing by

**Depends on:** Task 2, Task 3

**Files:** `frontend/app/view/agents/agentrow.tsx`, `frontend/app/view/agents/statusline.tsx`

Board: `Main.dc.html`.

- Standing by is `isStandingBy(agent.state, useAtomValue(shellTasksByIdAtom)[agent.id] ?? [])`, computed once in the card.
- The card's `idle` band reads `Standing by` (a clock icon, the label in `ink-mid`, meta `<r> shell task(s) running · <age>`, r = running tasks only) instead of `Finished` while the agent is standing by; `Review changes` and `Open` stay. With no running task the band is today's `Finished`, unchanged.
- The header gains a shell-task chip beside the subagent chip (`CHIP` classes), `shellTasksLabel(n)` with n = visible tasks (running and failed), with a hover peek listing each task (running or failed, like `FanoutBadge`). Read-only: the output peek lives in the tree. The chip carries `data-shell-tasks-chip` and its hover list `data-shell-tasks-list`, for Task 7.
- The header dot is accent and still while standing by: `QuietDot` in `statusline.tsx` passes `standing` to `StatusDot` and does not pulse.
- The finish settle in `agentrow.tsx` keeps the previous standing by in a ref beside `prevStateRef`, calls `isFinishTransition(prevState, agent.state, prevStandingBy, standingBy)`, and its effect deps are `[agent.state, standingBy]`, so a task ending while the agent stays idle re-runs it.
- Acceptance for Final: Task 7's step 1 (`Main`: band, still accent dot, chip hovered with its task list) and step 6 (band back to `Finished` once the last running task ends).

Run: `task check:ts`; `npx prettier --check` on the two files.

### Task 6: Rail, palette and header follow the same rule

**Depends on:** Task 2, Task 3

**Files:** `frontend/app/view/agents/cockpiteventsrail.tsx`, `frontend/app/view/agents/agentdetailsrail.tsx`, `frontend/app/cockpit/actions/agent.ts`, `frontend/app/view/agents/agentheader.tsx`

- `cockpiteventsrail.tsx`: `useRailTracking` reads `useAtomValue(shellTasksByIdAtom)`, builds the set of plain agent ids for which `isStandingBy` holds, passes it to `agentTransitions`, and adds standing by to its effect key (`${a.id}:${a.state}:${standingBy}`), so a task ending while the agent stays idle re-runs the effect and emits the one "finished" event.
- `agentdetailsrail.tsx`: pass whether the agent is standing by to `railAction`, so no Resume nudge shows.
- `cockpit/actions/agent.ts`: the nudge action's `applies` (`agent:nudge`) passes the same, read with `globalStore.get(shellTasksByIdAtom)`.
- `agentheader.tsx`: `useSettle(!ended && idle && !standingBy)`.
- Acceptance for Final: Task 7's step 6 (exactly one "finished" rail event for the agent, and none while it was standing by).
- Check each caller with `rg "railAction\(|agentTransitions\(|isFinishTransition\("` so none is left on the old signature.

Run: `task check:ts`.

### Task 7: A scenario that shows it

**Depends on:** Task 4, Task 5, Task 6

**Files:** `scripts/cdp/scenarios.mjs`

Add a `shell-tasks` scenario that injects one plain, non-run agent through the fixture roster, the way `agent-rail-file-link` (`scenarios.mjs` ~10560) writes `TREE_RAIL_FIXTURE` with a `transcriptPath` and reloads. Do not copy the `tree-rail` scenario (~8237): it arranges a fixture-run lead with `arrangeFixtureRun`, and a lead renders as `LeadCard`, takes `leadMark` in the tree and is skipped by `useRailTracking`, so none of this feature shows on it. Reuse only its idea of writing a temp transcript.

The fixture agent has `state: "idle"` (with `idleSince`) from the start, so it is standing by as soon as its tasks load. Its temp transcript holds four Bash shell tasks in the measured record shapes (see Why): one running whose output file is empty, one running whose output file has a few lines, one running whose output path names a file that does not exist, and one failed (a finish record with a failed status and an output file ending `[exited with code 1]`). So the chip reads `4 shell tasks` and the band `3 shell tasks running`. Turn the events rail on (`RAIL_VISIBLE_KEY`) before the reload.

Steps, each with a screenshot and an assertion, scoped to a `data-*` container (document-wide queries hit the app bar):
1. `Main`: the cockpit card shows the `Standing by` band with `3 shell tasks running`, its header dot is accent and not pulsing (no `pulse-dot` class), and hovering `[data-shell-tasks-chip]` shows `[data-shell-tasks-list]` naming all four task descriptions. No "finished" rail event for the agent yet.
2. `TreeCollapsed`: the Agent tab tree row with the chip folded, no `[data-shell-task]` rows.
3. `TreeExpanded`: the chip open, four `[data-shell-task]` rows, three `running` and one `failed · exit 1`.
4. `Interactive`: the running task with lines clicked, `[data-shell-task-peek]` shows its lines; then the empty task's `No output yet.`; then the failed task's `[exited with code 1]`.
5. Missing output: the task whose output file does not exist opens a peek reading `No output yet.`, with no error text.
6. Finish: append `queue-operation` enqueue finish records (`completed (exit code 0)`) for the three running tasks to the transcript. On the cockpit the card band goes back to `Finished`, the header dot is no longer accent-still, the chip reads `1 shell task` (the failed one stays), and the events rail holds exactly one "finished" event for the agent.

Teardown deletes the temp transcript and output files, restores the fixture file and the rail setting the way `agent-rail-file-link` does, and reloads onto the live roster. Pin the viewport at 1600x950. Run `task verify:ui -- shell-tasks` and read the screenshots.
