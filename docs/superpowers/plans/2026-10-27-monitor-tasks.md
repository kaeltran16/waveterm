# Monitor tasks in the Agent tree Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Verify:** `node scripts/verify.mjs ./pkg/resmon`
**Check:** `task check:ts`
**Final:** `node scripts/cdp/final-verify.mjs monitor-tasks shell-tasks`
**Prototype:** C:\Users\kael02\AppData\Local\arc-wt\0bb9fc91\.superpowers\design\monitor-tasks\project\Main.dc.html

**Goal:** Claude Code's Monitor tool tasks (watched shell commands) show in the Agent tree beside background shell tasks, open into an Events / Output peek, count toward standing by, and can be stopped from the row.

**Architecture:** The pure transcript projection `extractShellTasks` (`frontend/app/view/agents/shelltasks.ts`) learns a second kind of task, `"monitor"`, with its events, timeout and derived output path. Everything downstream (the store atom, standing by, polling, the kill RPC) already works on that one list. The tree row, the peek and the cockpit card branch on `kind`. No Go change: the resmon kill already matches a Monitor's shell (checked on a live monitor, whose `bash.exe` is a child of `claude.exe` running `eval '<command>' < /dev/null`, the shape `isTaskProcess` matches).

The order is interface first. Task 1 lands the `ShellTask` type and the pure label helpers. Tasks 2 (projection), 3 (tree), 4 (peek) and 5 (scenario) then run beside each other. Task 5 writes against the DOM contract below, and Final runs it on the merged result.

**Tech Stack:** React 19, jotai, Tailwind 4, lucide-react, vitest, CDP scenarios (`scripts/cdp/scenarios.mjs`).

**Design:** the canvas on the Prototype line, three boards in its folder: `Main.dc.html` (tree rows and the peek on its Events tab), `PeekOutput.dc.html` (Output tab), `PeekEmpty.dc.html` (no events yet). Approved decisions beyond the canvas are under Global Constraints. The cockpit card (`agentrow.tsx`) has no board. It only takes the new labels and marks (Task 1), and the decision for it is the lead's, stated below.

## Global Constraints

- One list. Shell tasks and monitors share the existing task list under an agent, in start order. There is no separate group.
- Row marks: shell-task rows draw lucide `Terminal` and monitor rows lucide `Radio`, both `text-accent`, size 12, in the 14px `Slot`. Agent rows keep their status dots. Peek headers and the cockpit card's task hover list use the same marks.
- Chip label: `"1 shell task"` / `"N shell tasks"` or `"1 monitor"` / `"N monitors"` when one kind is present, `"N tasks"` when both are. Chip aria-label: `Show <noun>` / `Hide <noun>`, where noun is `shell tasks`, `monitors` or `tasks`. The chip still starts open. A folded chip has `aria-expanded="false"` and a right chevron.
- Events summary, shared by the row's line 2 and the peek's Events footer: `"N events · <formatAgo(now - lastEventTs)>"` (`"1 event"` for one). With no events, the row reads `"no events yet · <formatAgeShort(now - startedTs)>"` and the footer reads `"watching since HH:MM:SS"`. The row prefixes `"persistent · "` when persistent. Under a minute, `formatAgo` reads `just now`. The board's `12s ago` and its footer's `last` are dropped deliberately for the codebase's age format.
- Monitor row right label: `"<ceil(min)>m left"`, or `"<1m left"` under a minute. Hidden when persistent or when start/timeout is unknown.
- Every task row (both kinds) has `title` = its full command when it has one.
- A monitor ends on a `<task-notification>` with a `<status>` for its id, on a successful TaskStop result for its id, or silently at `startedTs + timeoutMs` unless persistent. An expired monitor writes no record: in a scan of 121 real monitors, 23 had no end record.
- Events: one per `queue-operation` enqueue whose `<task-notification>` for a live monitor id has an `<event>` body and no `<status>`, timed by the record's `timestamp`. Every event is written twice: the enqueue, then a user record or a `queued_command` attachment. Both copies carry trailing text after `</event>`, so a user-record copy matches its enqueue on (task id, event body) and counts only when no enqueue matched it. Attachments are never read.
- Output tab path: `$TEMP/claude/<transcript's parent dir name>/<transcript file name minus .jsonl>/tasks/<id>.output`. wavesrv already resolves a leading `$TEMP` (`tempVarPath`, `pkg/wshrpc/wshserver/transcript.go`).
- Monitors count toward standing by. `isStandingBy` is unchanged, because the list now holds them.
- Stop copy, for monitors only: button aria-label `Stop <description>`, title `Stop monitor`, context-menu item `Stop monitor`, toast title `Stop monitor`. Notes: `"<d>" had already ended.`, `Could not stop "<d>": <err>.`, `Not stopped: "<d>" is not a process of this agent's tab.` Shell-task copy stays exactly as it is (`Kill task`, `Kill shell task`, `Not killed: ...`): the `shell-tasks` scenario asserts it.
- A monitor with no `command` (a `ws:` WebSocket monitor) lists, but has no stop control.
- Cockpit card (lead's call, no board): the standing-by band reads `<shellTasksLabel(tasks)> running · <age>` (e.g. `3 tasks running · 12m`). The `[data-shell-tasks-chip]` reads `shellTasksLabel(tasks)`. In the `[data-shell-tasks-list]` hover list, each row has the kind's mark, the description and `running` (shell) or `watching` (monitor).
- Colors only from `@theme` utilities. No text under 10.5px.

### DOM contract (Tasks 3 and 4 produce it, Task 5 asserts it)

- Task row: `[data-shell-task="<id>"]` (exists), plus `data-task-kind="shell"|"monitor"`. The mark is an svg with `aria-label` `Shell task` / `Monitor`. Line 2 is in `[data-task-sub]`, the right label in `[data-monitor-left]`, and the stop/kill X stays `[data-shell-task-kill]`.
- Chip: a `button` in the agent row with the aria-labels above and `aria-expanded`.
- Peek: `[data-shell-task-peek="<id>"]` (exists), with a header mark carrying `data-peek-mark="shell"|"monitor"`, the state in `[data-shell-task-state]` (`running` / `watching`), and the monitor command line in `[data-monitor-command]`. The tablist is `role="tablist"` `aria-label="Monitor view"`, with tabs `role="tab"` `data-peek-tab="events"|"output"` and `aria-selected`. Events are `[data-monitor-event]`, each holding `[data-monitor-event-time]`. The footer is `[data-peek-footer]`, its expiry span `[data-monitor-expires]` with `title` `expires HH:MM:SS`.

## Review Focus

- An event delivered while the agent is busy comes as an enqueue plus a `queued_command` attachment, with no user record. It must count once: Task 2 test "an event delivered mid-turn counts once".
- A `toolUseResult` with `taskId` but no `timeoutMs` (another tool) must not be read as a monitor: Task 2 test "a taskId result without timeoutMs is not a monitor".
- An expired monitor must leave the list at the next 5s poll while the agent sits idle, so standing by ends: Task 2 test "a monitor past its timeout drops", plus the store passing `Date.now()` on every refresh.
- The same `<event>` body twice (a repeated log line) is two events: Task 2 test "two identical events both count".
- A Windows transcript path with backslashes must still derive the output path: Task 2 test `monitorOutputPath` over both separators.

---

### Task 1: ShellTask kinds and the label helpers
**Depends on:** none
**Files:** `frontend/app/view/agents/shelltasks.ts`, `frontend/app/view/agents/shelltasks.test.ts`, `frontend/app/view/agents/shelltasksstore.ts`, `frontend/app/view/agents/agenttree.tsx`, `frontend/app/view/agents/agentrow.tsx`, `frontend/app/view/agents/shelltasksstore.test.ts`, `frontend/app/cockpit/actions/agent.test.ts`, `frontend/app/view/agents/cockpitsurfacemodel.test.ts`

**Interfaces (produces; Tasks 2, 3 and 4 use these exact names):**

```ts
export interface MonitorEvent { ts?: number; lines: string[] }
export interface ShellTask {
    id: string;
    kind: "shell" | "monitor";
    description: string;
    command?: string;
    startedTs?: number;
    outputPath?: string;
    // monitor only
    timeoutMs?: number;
    persistent?: boolean;
    events?: MonitorEvent[];
}
export function shellTasksLabel(tasks: ShellTask[]): string; // replaces shellTasksLabel(n: number)
export function shellTasksNoun(tasks: ShellTask[]): "shell tasks" | "monitors" | "tasks";
export function monitorEventsSummary(t: ShellTask, now: number): string | null; // null with no events
export function monitorSubline(t: ShellTask, now: number): string;
export function monitorTimeLeft(t: ShellTask, now: number): string | null;
export function monitorExpiresAt(t: ShellTask): number | null; // startedTs + timeoutMs, null when persistent/unknown
export function shellKillNote(r: ResMonKillRtnData, task: Pick<ShellTask, "kind" | "description">): string | null;
```

Import `formatAgo` / `formatAgeShort` from `./agentsviewmodel`. `extractShellTasks` keeps its signature here and returns `kind: "shell"` on every task. Task 2 adds monitors.

- [ ] **Step 1: Write the failing tests** in `shelltasks.test.ts`, building monitor `ShellTask` literals by hand:
  - `shellTasksLabel` / `shellTasksNoun` → `1 shell task`, `3 shell tasks`, `1 monitor`, `2 monitors`, and `3 tasks` for mixed. The nouns are `shell tasks` / `monitors` / `tasks`.
  - `monitorEventsSummary` → `null` with no events, `1 event · 3m ago`, `4 events · just now`.
  - `monitorSubline` → `no events yet · <1m`, `4 events · just now`, `persistent · 9 events · 3m ago`.
  - `monitorTimeLeft` → `18m left` at 17.5 min remaining, `<1m left` at 30 s, `null` when persistent.
  - `monitorExpiresAt` → `startedTs + timeoutMs`, and `null` when persistent.
  - `shellKillNote` for a monitor → the Stop copy from Global Constraints. The existing shell cases pass `{kind:"shell", description}` and keep their copy.
  - The existing `extractShellTasks` expectations gain `kind:"shell"`.
- [ ] **Step 2:** `npx vitest run frontend/app/view/agents/shelltasks.test.ts` → the new tests FAIL.
- [ ] **Step 3:** Implement the type and helpers in `shelltasks.ts`.
- [ ] **Step 4: Update the callers so Check stays green.**
  - `killShellTask` passes the task to `shellKillNote` and titles the toast `Stop monitor` for a monitor, `Kill shell task` otherwise.
  - `agenttree.tsx` `tasksChip` uses `shellTasksLabel(tasks)` and `Show/Hide ${shellTasksNoun(tasks)}`.
  - `agentrow.tsx`: `StandingByMeta` takes `tasks: ShellTask[]` instead of `running: number`, and `ShellTasksBadge` uses `shellTasksLabel(tasks)`. Its hover-list rows draw the kind's mark and read `running` / `watching`.
  - The `ShellTask` literals in `shelltasksstore.test.ts` (line 31), `agent.test.ts` and `cockpitsurfacemodel.test.ts` gain `kind: "shell"`.
- [ ] **Step 5:** `npx vitest run frontend/app/view/agents/shelltasks.test.ts frontend/app/view/agents/shelltasksstore.test.ts frontend/app/cockpit/actions/agent.test.ts frontend/app/view/agents/cockpitsurfacemodel.test.ts` → PASS. `task check:ts` → exit 0.

Acceptance: the tests above pass and `task check:ts` exits 0. The card's look is shown by `monitor-tasks` step 8 (Task 5), and its shell-only copy by the `shell-tasks` scenario, both run in Final.

- [ ] **Step 6:** Commit `feat(agent): ShellTask kinds and monitor label helpers`.

### Task 2: Project monitors from the transcript
**Depends on:** Task 1
**Files:** `frontend/app/view/agents/shelltasks.ts`, `frontend/app/view/agents/shelltasks.test.ts`, `frontend/app/view/agents/shelltasksstore.ts`

**Interfaces (produces):**

```ts
export function extractShellTasks(lines: string[], opts?: { now?: number; transcriptPath?: string }): ShellTask[];
export function monitorOutputPath(transcriptPath: string, taskId: string): string | undefined;
```

`opts.now` defaults to `Date.now()`. A monitor's `outputPath` is `monitorOutputPath(opts.transcriptPath, id)`, or undefined without a transcript path.

- [ ] **Step 1: Write the failing tests** in `shelltasks.test.ts`, with fixture helpers (`monitorUse`, `monitorStart`, `monitorEvent`, `monitorEnd`) beside `bashUse` / `bashStart`. Their shapes, trimmed from a real transcript:
  - start: `{type:"user", timestamp, message:{role:"user", content:[{tool_use_id, type:"tool_result", content:"Monitor started (task <id>, expires in 30m unless the source ends first; ...)"}]}, toolUseResult:{taskId:"<id>", timeoutMs:1800000, persistent:false}}`, after an assistant `tool_use` named `Monitor` with `input:{description, timeout_ms, command}`.
  - event (enqueue, and the user-record copy with the same text in `message.content`): `"<task-notification>\n<task-id><id></task-id>\n<summary>Monitor event: \"<desc>\"</summary>\n<event><line1>\n<line2></event>\nIf this event is something the user would act on now, send a PushNotification. Routine or benign output doesn't need one.\n</task-notification>"`.
  - end: `notification(id, toolUseId, "completed", 'Monitor "<desc>" stream ended')`, using the existing helper.

  Tests (name → assertion):
  - "a Monitor start lists a monitor" → `{id, kind:"monitor", description, command, startedTs, timeoutMs:1800000, persistent:false, events:[], outputPath:"$TEMP/claude/<dir>/<session>/tasks/<id>.output"}`.
  - "each event counts once" → an enqueue followed by its user-record copy gives 1 event, whose `lines` are the two lines and whose `ts` is the enqueue's timestamp.
  - "an event delivered mid-turn counts once" → an enqueue, then a `queue-operation` `remove`, then an `attachment` record of type `queued_command` holding the same text gives 1 event.
  - "a user-record event with no enqueue counts" → 1 event.
  - "two identical events both count" → 2 enqueues with equal bodies, then their 2 user copies, give 2 events.
  - "a stream-ended notification drops a monitor" and "a TaskStop result drops a monitor" → `[]`.
  - "a monitor past its timeout drops; a persistent one stays" → `now = startedTs + timeoutMs` drops it, `now - 1` keeps it, and a `persistent:true` one stays at any `now`.
  - "a taskId result without timeoutMs is not a monitor" → `[]`.
  - "an event for an id with no start is ignored".
  - "shell tasks and monitors list in start order".
  - "a ws monitor lists with no command" → input `{description, timeout_ms, ws:{url}}` gives no `command` key.
  - `monitorOutputPath` → `C:\Users\u\.claude\projects\C--x\abc.jsonl` and `/c/Users/u/.claude/projects/C--x/abc.jsonl` both give `$TEMP/claude/C--x/abc/tasks/<id>.output`.
- [ ] **Step 2:** `npx vitest run frontend/app/view/agents/shelltasks.test.ts` → the new tests FAIL.
- [ ] **Step 3: Implement it in `shelltasks.ts`.** A monitor start is a user record whose `toolUseResult.taskId` is a non-empty string and whose `timeoutMs` is a number. Keep a per-id list of pending enqueued event bodies: a user-record event pops a matching body if there is one, and counts as a new event otherwise. The expiry check runs once, after the loop. Update the header comment to name monitors. `refreshShellTasks` passes `{ now: Date.now(), transcriptPath }`.
- [ ] **Step 4:** `npx vitest run frontend/app/view/agents/shelltasks.test.ts frontend/app/view/agents/shelltasksstore.test.ts` → PASS. `task check:ts` → exit 0.

Acceptance: the tests above pass. Live, the projection feeds `monitor-tasks` steps 1–8 (Task 5), run in Final.

- [ ] **Step 5:** Commit `feat(agent): project Claude Code monitors from the transcript`.

### Task 3: Monitor rows in the Agent tree
**Depends on:** Task 1
**Files:** `frontend/app/view/agents/agenttree.tsx`

Draw the rows as `Main.dc.html` does, in `ShellTaskRows`, with the DOM contract's attributes and Task 1's helpers:
- The leading mark is `Terminal` or `Radio` (`aria-label` `Shell task` / `Monitor`) in place of the dot. The row `title` is the command.
- Line 2 for a monitor is `monitorSubline(t, now)`. Shell rows keep `running · <age>`.
- The right label is `monitorTimeLeft` in `font-mono text-[10.5px] text-muted`, with `title` `expires HH:MM:SS` from `monitorExpiresAt`. It sits before the X.
- A monitor row always toggles the peek, since its Events tab needs no output file.
- The X and the context menu use the monitor copy. The menu reads `Show output` / `Hide output`, then `Stop monitor`. A monitor with no `command` gets no X and no stop item.

Acceptance: `task check:ts` exits 0 and `npx eslint frontend/app/view/agents/agenttree.tsx` is clean. The rows are shown by `monitor-tasks` steps 1–3 (Task 5), run in Final, and the `shell-tasks` scenario's tree steps still pass there.

- [ ] **Step 1:** Implement the above.
- [ ] **Step 2:** `task check:ts` → exit 0. `npx eslint frontend/app/view/agents/agenttree.tsx` → clean.
- [ ] **Step 3:** Commit `feat(agent): monitor rows in the Agent tree`.

### Task 4: Events / Output peek for a monitor
**Depends on:** Task 1 (uses `ShellTask.kind`, `events`, `monitorEventsSummary`, `monitorExpiresAt`)
**Files:** `frontend/app/view/agents/shelltaskpeek.tsx`

Draw the peek as `Main.dc.html` (Events), `PeekOutput.dc.html` and `PeekEmpty.dc.html` do, with the DOM contract's attributes. A shell task's peek keeps its current body and footer, with `Terminal` (`data-peek-mark="shell"`) replacing its header dot. For a monitor:
- Header: `Radio` (`data-peek-mark="monitor"`), then the description, then the state `watching`.
- Below the header, `$ <command>` in `font-mono text-[10.5px] text-muted`, one truncated line, with a `title` holding the full command. Omit it with no command.
- Tablist `aria-label="Monitor view"`: `Events <n>` and `Output`. The selected tab is `bg-accentbg text-accent-soft`. Events is the default, and the tab state is local.
- The Events body has one `[data-monitor-event]` per event: an `HH:MM:SS` time (`text-muted text-[10.5px]`, 62px column) and the event's lines. Events after the first are divided by `border-edge-faint`. With no events it reads `No events yet.` The body follows the tail with the existing `useStickToBottom`.
- The Output body is the existing `useTaskOutput(task.outputPath)` tail. An empty file reads `No output yet.`
- Footer on Events: left `monitorEventsSummary`, or `watching since HH:MM:SS`; right `[data-monitor-expires]` `expires in <m>m` (`title` `expires HH:MM:SS`), or `persistent`. Footer on Output: the existing file name and `last 64 KB · live`.

Acceptance: `task check:ts` exits 0 and `npx eslint frontend/app/view/agents/shelltaskpeek.tsx` is clean. The peek states are shown by `monitor-tasks` steps 4–7 (Task 5), run in Final, and the `shell-tasks` scenario's peek steps still pass there.

- [ ] **Step 1:** Implement the above.
- [ ] **Step 2:** `task check:ts` → exit 0. `npx eslint frontend/app/view/agents/shelltaskpeek.tsx` → clean.
- [ ] **Step 3:** Commit `feat(agent): Events and Output peek for a monitor`.

### Task 5: CDP scenario `monitor-tasks`
**Depends on:** none
**Files:** `scripts/cdp/scenarios.mjs`

Add `monitorTasksScenario` (name `monitor-tasks`) beside `shellTasksScenario` and register it in the scenario list. It is written against the DOM contract and the Global Constraints copy, not against running code: Tasks 2–4 land beside it, and Final runs it on the merged result. Model its arrange, fixture agents and teardown on `shellTasksScenario`, reusing `shellTaskStart` and `SHELL_LIB`'s helpers except `tasksChip`. Its own chip query matches the agent row's button by `aria-label` `Show|Hide (shell tasks|monitors|tasks)`. Add `monitorTaskStart` / `monitorEvent` / `monitorEnd` writers in the record shapes from Task 2 Step 1, with timestamps relative to `Date.now()`. Each monitor's output file is written at `join(tmpdir(), "claude", basename(dirname(transcript)), basename(transcript, ".jsonl"), "tasks", "<id>.output")`.

Fixtures:
- Agent `fx-monitor-tasks`, idle past the grace window. Its transcript holds:
  - shell task `bmtshell` ("serve the preview")
  - monitor `bmtevents` ("final-verify PASS/FAIL lines"): started 12 min ago, timeout 30 min, 4 events (enqueue plus user copy each), and an output file whose first line is `grep: warning: stray \ before -`, followed by the event lines
  - monitor `bmtquiet` ("errors in waveapp.log"): started 2 min ago, no events, empty output file
  - monitor `bmtexpired`: started 40 min ago, timeout 30 min, no end record
  - monitor `bmtended`: ended by a stream-ended notification
  - monitor `bmtstopped`: ended by a TaskStop result
- Agent `fx-monitor-persistent`, idle: one persistent monitor `bmtpersist` with 2 events.

Steps (each shoots `cdp-shots/monitor-tasks-<n>.png`):
1. Tree rows (Main board). `fx-monitor-tasks`'s chip reads `3 tasks` with `aria-expanded="true"`. Its rows list `bmtshell, bmtevents, bmtquiet` in that order: the expired, ended and stopped monitors are absent. The kinds are `shell, monitor, monitor`, and the mark aria-labels are `Shell task, Monitor, Monitor`. Each row's `title` is its command. `bmtevents`'s sub starts `4 events ·`, and `bmtquiet`'s starts `no events yet ·`. `[data-monitor-left]` matches `/^(\d+m|<1m) left$/` on both monitors. Both agents' tree dots are accent (standing by).
2. Persistent and folded chip (Main board). `fx-monitor-persistent`'s chip reads `1 monitor`. Its row's sub starts `persistent · 2 events`, and it has no `[data-monitor-left]`. Clicking the chip folds it: `aria-expanded="false"`, aria-label `Show monitors`, and its rows are gone. Clicking again unfolds it.
3. Stop (Main board, hover state). Hovering `bmtquiet` shows the X with aria-label `Stop errors in waveapp.log`. Right-click offers `Show output, Stop monitor`. Stopping it with no live job gives a toast titled `Stop monitor` containing `Not stopped`, and the row stays.
4. Events peek (Main board). Clicking `bmtevents` opens `[data-shell-task-peek="bmtevents"]`, with `data-peek-mark="monitor"` and the state `watching`. `[data-monitor-command]` starts `$ `. The tablist has `aria-label` `Monitor view`, and `[data-peek-tab="events"]` is `aria-selected="true"`, labelled `Events 4`. There are 4 `[data-monitor-event]`, each time matching `/^\d\d:\d\d:\d\d$/`. The footer starts `4 events ·`, and `[data-monitor-expires]` reads `expires in …m` with `title` matching `/^expires \d\d:\d\d:\d\d$/`.
5. Output peek (PeekOutput board). Clicking `[data-peek-tab="output"]` selects it. The body includes `grep: warning: stray` and the event lines, and the footer includes `bmtevents.output` and `last 64 KB`.
6. Empty peek (PeekEmpty board). Opening `bmtquiet` shows `Events 0` and `No events yet.`, with a footer starting `watching since`. Its Output tab reads `No output yet.`
7. Shell peek. Opening `bmtshell` shows `data-peek-mark="shell"`, the state `running`, no tablist, and no `[data-monitor-command]`.
8. Cockpit card. On the Cockpit surface, `fx-monitor-tasks`'s card band includes `3 tasks running`, and its `[data-shell-tasks-chip]` reads `3 tasks`. Hovering it opens `[data-shell-tasks-list]`, which includes the `bmtshell`, `bmtevents` and `bmtquiet` descriptions, reads `watching` twice and `running` once, and holds none of the expired, ended or stopped descriptions. `fx-monitor-persistent`'s chip reads `1 monitor`.

Teardown removes the fixture agents, transcripts and output files, as `shellTasksScenario`'s does.

Acceptance: `node --check scripts/cdp/scenarios.mjs` passes, and `node -e "import('./scripts/cdp/scenarios.mjs').then(m => process.exit(m.SCENARIOS.some(s => s.name === 'monitor-tasks') ? 0 : 1))"` exits 0. The steps themselves run in Final (`node scripts/cdp/final-verify.mjs monitor-tasks shell-tasks`).

- [ ] **Step 1:** Write the scenario.
- [ ] **Step 2:** Run both acceptance commands → exit 0.
- [ ] **Step 3:** Commit `test(cdp): monitor-tasks scenario`.
